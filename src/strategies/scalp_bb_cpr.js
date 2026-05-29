/**
 * SCALP V6: Bollinger Bands + PSAR + RSI (PSAR-flip exit design)
 *
 * ENTRY:
 *   CE: candle closes above BB upper + PSAR below close + RSI > SCALP_RSI_CE_THRESHOLD (default 70)
 *   PE: candle closes below BB lower + PSAR above close + RSI < SCALP_RSI_PE_THRESHOLD (default 40)
 *   Two RSI keys only — no overbought/oversold caps.
 *   Skip far-PSAR entries: SCALP_MAX_ENTRY_SL_PTS (default 50) — don't open when PSAR is >N pts from close.
 *   Initial SL = PSAR value at entry (no clamp). Used for risk sizing + display; not an intra-tick stop.
 *
 * EXIT (profit lock + BB re-entry + PSAR flip):
 *   1. Profit lock (spot POINTS) — once peak favourable spot move ≥ SCALP_PROFIT_LOCK_TRIGGER_PTS,
 *      exit when it gives back below SCALP_PROFIT_LOCK_PCT% of peak. Ratchets with peak; points-based
 *      so it is independent of option pricing. This is the ONLY intra-tick exit.
 *   2. BB re-entry (candle close) — if price closes back inside the band the breakout failed → exit
 *      (SCALP_BB_REENTRY_EXIT, default on). Cuts loss bleed before the slower PSAR flip.
 *   3. PSAR flip → exit on candle close (trend exit; handles runners beyond the lock).
 *   4. EOD / daily loss / max trades / SL-pause cooldown (handled by routes)
 */

const { BollingerBands, RSI, PSAR } = require("technicalindicators");

const NAME        = "SCALP_BB_PSAR_RSI_V5";
const DESCRIPTION = "BB break + PSAR + RSI";

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }

// ── Trading window ───────────────────────────────────────────────────────────
function _parseMins(envKey, fallback) {
  var v = process.env[envKey] || fallback;
  var parts = v.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}
function _fmtTime(mins) {
  var h = Math.floor(mins / 60), m = mins % 60;
  var suffix = h >= 12 ? "PM" : "AM";
  var h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return h12 + ":" + (m < 10 ? "0" : "") + m + " " + suffix;
}

function isInTradingWindow(unixSec) {
  var d = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  var startMin = _parseMins("SCALP_ENTRY_START", "09:21");
  var endMin   = _parseMins("SCALP_ENTRY_END",   "14:30");
  if (totalMin < startMin) return { ok: false, reason: "Before " + _fmtTime(startMin) };
  if (totalMin >= endMin)  return { ok: false, reason: "After " + _fmtTime(endMin) };
  return { ok: true, reason: null };
}

// ── Indicator cache — avoid redundant recalculation on every tick ────────────
// Cache key = last closed candle time + current candle OHLC (changes on each tick)
// If the closed candles haven't changed AND current bar is same, reuse cached indicators.
let _indicatorCache = { key: null, bb: null, bbMiddles: null, rsi: null, rsiPrev: null, sar: null };

function _makeIndicatorKey(candles) {
  if (candles.length < 2) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  // Key on: prev candle time (closed candles change) + current bar OHLC
  return `${prev.time}:${candles.length}:${last.open}:${last.high}:${last.low}:${last.close}`;
}

// ── Main signal function ─────────────────────────────────────────────────────
function getSignal(candles, opts) {
  opts = opts || {};
  var silent = opts.silent === true;

  var BB_PERIOD   = parseInt(cfg("SCALP_BB_PERIOD", "20"), 10);
  var BB_STDDEV   = parseFloat(cfg("SCALP_BB_STDDEV", "1"));
  var RSI_PERIOD  = parseInt(cfg("SCALP_RSI_PERIOD", "14"), 10);
  var RSI_CE      = parseFloat(cfg("SCALP_RSI_CE_THRESHOLD", "70"));
  var RSI_PE      = parseFloat(cfg("SCALP_RSI_PE_THRESHOLD", "40"));
  var RSI_TURNING = cfg("SCALP_RSI_TURNING", "false") === "true"; // require RSI momentum confirms direction
  var PSAR_STEP   = parseFloat(cfg("SCALP_PSAR_STEP", "0.02"));
  var PSAR_MAX    = parseFloat(cfg("SCALP_PSAR_MAX", "0.2"));
  var MAX_ENTRY_SL_PTS = parseFloat(cfg("SCALP_MAX_ENTRY_SL_PTS", "50")); // skip entries where PSAR sits farther than this from close (0 = off)

  var base = {
    signal: "NONE", reason: "", stopLoss: null, target: null,
    rsi: null, sar: null, bbUpper: null, bbMiddle: null, bbLower: null,
  };

  // Warm-up
  var minCandles = Math.max(BB_PERIOD + 5, RSI_PERIOD + 5, 30);
  if (candles.length < minCandles) {
    base.reason = "Warming up (" + candles.length + "/" + minCandles + ")";
    return base;
  }

  var sc = candles[candles.length - 1];
  if (!opts.skipTimeCheck) {
    var windowCheck = isInTradingWindow(sc.time);
    if (!windowCheck.ok) {
      base.reason = windowCheck.reason;
      return base;
    }
  }

  // ── Indicators (with cache to avoid redundant recalculation) ──────────────
  var cacheKey = _makeIndicatorKey(candles);
  var bb, bbMiddles, rsi, rsiPrev, sar;

  if (cacheKey && _indicatorCache.key === cacheKey && _indicatorCache.bb) {
    bb        = _indicatorCache.bb;
    bbMiddles = _indicatorCache.bbMiddles;
    rsi       = _indicatorCache.rsi;
    rsiPrev   = _indicatorCache.rsiPrev;
    sar       = _indicatorCache.sar;
  } else {
    var closes = candles.map(function(c) { return c.close; });
    var highs  = candles.map(function(c) { return c.high; });
    var lows   = candles.map(function(c) { return c.low; });

    // Bollinger Bands
    var bbArr = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes });
    if (bbArr.length < 1) { base.reason = "BB warming up"; return base; }
    bb        = bbArr[bbArr.length - 1];
    bbMiddles = bbArr.map(function(x) { return x.middle; });

    // RSI (capture prior value too — used by RSI-turning guard)
    var rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
    if (rsiArr.length < 1) { base.reason = "RSI warming up"; return base; }
    rsi     = rsiArr[rsiArr.length - 1];
    rsiPrev = rsiArr.length >= 2 ? rsiArr[rsiArr.length - 2] : rsi;

    // Parabolic SAR
    var sarArr = PSAR.calculate({ step: PSAR_STEP, max: PSAR_MAX, high: highs, low: lows });
    if (sarArr.length < 1) { base.reason = "SAR warming up"; return base; }
    sar = sarArr[sarArr.length - 1];

    // Cache for next tick with same window
    _indicatorCache = { key: cacheKey, bb: bb, bbMiddles: bbMiddles, rsi: rsi, rsiPrev: rsiPrev, sar: sar };
  }

  base.bbUpper  = parseFloat(bb.upper.toFixed(2));
  base.bbMiddle = parseFloat(bb.middle.toFixed(2));
  base.bbLower  = parseFloat(bb.lower.toFixed(2));
  base.bbWidth  = parseFloat((bb.upper - bb.lower).toFixed(2));
  base.rsi = parseFloat(rsi.toFixed(1));
  base.sar = parseFloat(sar.toFixed(2));

  var _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

  // ── ENTRY CONDITIONS (V6: BB break + PSAR side + RSI) ─────────────────────
  // CE: close above BB upper  + PSAR below close + RSI > RSI_CE
  // PE: close below BB lower   + PSAR above close + RSI < RSI_PE
  // Initial SL = PSAR value at entry (no clamp). SAR is always on the correct side
  // here (entry requires sarBelow for CE / sarAbove for PE), so it is a valid stop.

  // PSAR side relative to the candle close (the directional confirmation)
  var sarBelow = sar < sc.close;   // bullish — PSAR under price
  var sarAbove = sar > sc.close;   // bearish — PSAR over price

  // ── Near-miss filter audit (additive-only logging; does NOT affect signal) ──
  var _ceAuditChecks = [
    { name: "BB upper break", ok: sc.close >= bb.upper, detail: "close=" + sc.close + " vs BB_U=" + bb.upper.toFixed(1) },
    { name: "PSAR below",     ok: sarBelow,             detail: "SAR=" + sar.toFixed(1) + " vs close=" + sc.close },
    { name: "RSI bullish",    ok: rsi > RSI_CE,         detail: "RSI=" + rsi.toFixed(1) + " vs >" + RSI_CE },
  ];
  var _peAuditChecks = [
    { name: "BB lower break", ok: sc.close <= bb.lower, detail: "close=" + sc.close + " vs BB_L=" + bb.lower.toFixed(1) },
    { name: "PSAR above",     ok: sarAbove,             detail: "SAR=" + sar.toFixed(1) + " vs close=" + sc.close },
    { name: "RSI bearish",    ok: rsi < RSI_PE,         detail: "RSI=" + rsi.toFixed(1) + " vs <" + RSI_PE },
  ];
  function _auditSide(checks) {
    var passed = [], failed = [];
    for (var i = 0; i < checks.length; i++) {
      if (checks[i].ok) passed.push(checks[i].name);
      else              failed.push({ name: checks[i].name, detail: checks[i].detail });
    }
    return { passed: passed.length, total: checks.length, passedNames: passed, failed: failed };
  }
  base.filterAudit = { ce: _auditSide(_ceAuditChecks), pe: _auditSide(_peAuditChecks) };

  // CE (Long): close >= BB upper + PSAR below close + RSI > RSI_CE
  if (sc.close >= bb.upper && sarBelow && rsi > RSI_CE) {
    if (RSI_TURNING && rsi < rsiPrev) {
      base.reason = "CE blocked: RSI turning down (" + rsiPrev.toFixed(1) + " → " + rsi.toFixed(1) + ") — momentum fading";
      return base;
    }
    // Skip far-PSAR entries: a freshly-flipped SAR can sit 100s of pts away → huge risk.
    if (MAX_ENTRY_SL_PTS > 0 && (sc.close - sar) > MAX_ENTRY_SL_PTS) {
      base.reason = "CE blocked: PSAR too far (" + (sc.close - sar).toFixed(0) + "pts > " + MAX_ENTRY_SL_PTS + ")";
      return base;
    }
    // Initial SL = PSAR value at entry (no clamp). SAR is below close here.
    var sl = parseFloat(sar.toFixed(2));
    var slPts = parseFloat((sc.close - sar).toFixed(2));
    if (!silent) console.log("[SCALP " + _ist + "] CE: close(" + sc.close + ") >= BB upper(" + bb.upper.toFixed(2) + ") + SAR(" + sar.toFixed(1) + ")<close + RSI=" + rsi.toFixed(1) + " | SL(PSAR)=" + sl + " [" + slPts.toFixed(1) + "pts]");
    return Object.assign({}, base, {
      signal: "BUY_CE", signalStrength: "SCALP",
      stopLoss: sl,
      slSource: "PSAR",
      target: null,
      slPts: slPts,
      reason: "CE: BB upper(" + bb.upper.toFixed(0) + ") + SAR<close + RSI=" + rsi.toFixed(0) + " | SL(PSAR)=" + sl + " [" + slPts.toFixed(1) + "pts]",
    });
  }

  // PE (Short): close <= BB lower + PSAR above close + RSI < RSI_PE
  if (sc.close <= bb.lower && sarAbove && rsi < RSI_PE) {
    if (RSI_TURNING && rsi > rsiPrev) {
      base.reason = "PE blocked: RSI turning up (" + rsiPrev.toFixed(1) + " → " + rsi.toFixed(1) + ") — momentum fading";
      return base;
    }
    // Skip far-PSAR entries: a freshly-flipped SAR can sit 100s of pts away → huge risk.
    if (MAX_ENTRY_SL_PTS > 0 && (sar - sc.close) > MAX_ENTRY_SL_PTS) {
      base.reason = "PE blocked: PSAR too far (" + (sar - sc.close).toFixed(0) + "pts > " + MAX_ENTRY_SL_PTS + ")";
      return base;
    }
    // Initial SL = PSAR value at entry (no clamp). SAR is above close here.
    var sl = parseFloat(sar.toFixed(2));
    var slPts = parseFloat((sar - sc.close).toFixed(2));
    if (!silent) console.log("[SCALP " + _ist + "] PE: close(" + sc.close + ") <= BB lower(" + bb.lower.toFixed(2) + ") + SAR(" + sar.toFixed(1) + ")>close + RSI=" + rsi.toFixed(1) + " | SL(PSAR)=" + sl + " [" + slPts.toFixed(1) + "pts]");
    return Object.assign({}, base, {
      signal: "BUY_PE", signalStrength: "SCALP",
      stopLoss: sl,
      slSource: "PSAR",
      target: null,
      slPts: slPts,
      reason: "PE: BB lower(" + bb.lower.toFixed(0) + ") + SAR>close + RSI=" + rsi.toFixed(0) + " | SL(PSAR)=" + sl + " [" + slPts.toFixed(1) + "pts]",
    });
  }

  // No signal — build descriptive reason showing which leg failed
  var cePrice = sc.close >= bb.upper;
  var pePrice = sc.close <= bb.lower;

  var parts = [];
  if (cePrice) {
    var ceMiss = [];
    if (!sarBelow)    ceMiss.push("SAR not below close");
    if (!(rsi > RSI_CE)) ceMiss.push("RSI=" + rsi.toFixed(0) + "<=" + RSI_CE);
    if (ceMiss.length) parts.push("CE broke BB but " + ceMiss.join(" & "));
  }
  if (pePrice) {
    var peMiss = [];
    if (!sarAbove)    peMiss.push("SAR not above close");
    if (!(rsi < RSI_PE)) peMiss.push("RSI=" + rsi.toFixed(0) + ">=" + RSI_PE);
    if (peMiss.length) parts.push("PE broke BB but " + peMiss.join(" & "));
  }

  base.reason = parts.length > 0 ? "No setup (" + parts.join("; ") + ")" : "No setup";
  return base;
}

// ── Profit lock (the only intra-tick exit) ───────────────────────────────────
// Spot-POINTS ratcheting profit lock — banks favourable spot travel and lets
// winners run. Tracks the favourable spot move since entry (PE = entry−price,
// CE = price−entry). Once the PEAK favourable move reaches
// SCALP_PROFIT_LOCK_TRIGGER_PTS, exit as soon as it gives back below
// SCALP_PROFIT_LOCK_PCT% of that peak. Floor ratchets up with the peak
// (peak 100pts → lock 50pts at 50%). Points-based, so it is independent of
// option pricing (works even on spot-proxy replay sessions). TRIGGER = 0 disables.
//   favPts     — current favourable spot points
//   peakFavPts — best favourable spot points seen this trade
// Returns { hit, floor }.
function profitLock(favPts, peakFavPts) {
  var trigger = parseFloat(cfg("SCALP_PROFIT_LOCK_TRIGGER_PTS", "25"));
  var pct     = parseFloat(cfg("SCALP_PROFIT_LOCK_PCT", "50"));
  if (trigger <= 0 || peakFavPts == null || peakFavPts < trigger) return { hit: false, floor: null };
  var floor = parseFloat(((pct / 100) * peakFavPts).toFixed(2));
  return { hit: favPts <= floor, floor: floor };
}

// ── PSAR flip detection (SAR crosses price → exit) ──────────────────────────
// The primary exit: on candle close, if SAR has crossed to the wrong side of price
// the trend has flipped — exit the position.
function isPSARFlip(candles, side) {
  var PSAR_STEP = parseFloat(cfg("SCALP_PSAR_STEP", "0.02"));
  var PSAR_MAX  = parseFloat(cfg("SCALP_PSAR_MAX", "0.2"));

  var highs = candles.map(function(c) { return c.high; });
  var lows  = candles.map(function(c) { return c.low; });

  var sarArr = PSAR.calculate({ step: PSAR_STEP, max: PSAR_MAX, high: highs, low: lows });
  if (sarArr.length < 2) return false;

  var currentSar = sarArr[sarArr.length - 1];
  var prevSar    = sarArr[sarArr.length - 2];
  var currentClose = candles[candles.length - 1].close;

  if (side === "CE") {
    return prevSar < candles[candles.length - 2].close && currentSar > currentClose;
  } else {
    return prevSar > candles[candles.length - 2].close && currentSar < currentClose;
  }
}

// ── BB re-entry exit (failed-breakout) ──────────────────────────────────────
// On candle close, if price has closed back INSIDE the band the breakout that
// triggered the entry has failed → exit (faster than waiting for the PSAR flip).
//   CE entered on close ≥ BB.upper → exit when close < BB.upper.
//   PE entered on close ≤ BB.lower → exit when close > BB.lower.
// Gated by SCALP_BB_REENTRY_EXIT (default on). Uses the same BB inputs as entry.
function bbReentryExit(candles, side) {
  if (cfg("SCALP_BB_REENTRY_EXIT", "true") !== "true") return false;
  var BB_PERIOD = parseInt(cfg("SCALP_BB_PERIOD", "20"), 10);
  var BB_STDDEV = parseFloat(cfg("SCALP_BB_STDDEV", "1"));
  var closes = candles.map(function(c) { return c.close; });
  var bbArr = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes });
  if (bbArr.length < 1) return false;
  var bb = bbArr[bbArr.length - 1];
  var close = candles[candles.length - 1].close;
  if (side === "CE") return close < bb.upper;   // closed back below the upper band
  return close > bb.lower;                        // PE: closed back above the lower band
}

function reset() { _indicatorCache = { key: null, bb: null, bbMiddles: null, rsi: null, sar: null }; }

module.exports = { NAME, DESCRIPTION, getSignal, profitLock, isPSARFlip, bbReentryExit, reset };

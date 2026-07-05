/**
 * SCALP V6: Bollinger Bands + PSAR + RSI (PSAR-flip exit design)
 *
 * ENTRY:
 *   CE: candle closes above BB upper + PSAR below close + RSI > SCALP_RSI_CE_THRESHOLD (default 70)
 *   PE: candle closes below BB lower + PSAR above close + RSI < SCALP_RSI_PE_THRESHOLD (default 40)
 *   Two RSI keys only — no overbought/oversold caps.
 *   Skip far-PSAR entries: SCALP_MAX_ENTRY_SL_PTS (default 50) — don't open when PSAR is >N pts from close.
 *   ADX trend filter (optional, SCALP_ADX_ENABLED): block ALL entries when ADX(14) < SCALP_ADX_MIN
 *     — the strategy wins in trends and bleeds in chop, so this sits out ranging sessions.
 *   Initial SL = PSAR value at entry (no clamp). Used for risk sizing + display; not an intra-tick stop.
 *
 * EXIT (profit lock + hard stop + BB re-entry + PSAR flip):
 *   1. Profit lock (spot POINTS) — once peak favourable spot move ≥ SCALP_PROFIT_LOCK_TRIGGER_PTS,
 *      exit when it gives back below SCALP_PROFIT_LOCK_PCT% of peak. Ratchets with peak; points-based
 *      so it is independent of option pricing. The per-tick upside exit.
 *   2. Hard stop (spot POINTS) — catastrophic loss cap; exit once the trade moves
 *      SCALP_STOP_LOSS_PTS against entry. Set WIDE (default 30) so it only clips the deep
 *      adverse excursions on failed fades, not the normal small scalps. The per-tick downside cap.
 *   3. BB re-entry (candle close) — if price closes back inside the band the breakout failed → exit
 *      (SCALP_BB_REENTRY_EXIT, default on). Cuts loss bleed before the slower PSAR flip.
 *   4. PSAR flip → exit on candle close (trend exit; handles runners beyond the lock).
 *   5. EOD / daily loss / max trades / SL-pause cooldown (handled by routes)
 */

const { BollingerBands, RSI, PSAR, ADX } = require("technicalindicators");
const { computeSuperTrend } = require("../utils/supertrend");

const NAME        = "SCALP_BB_PSAR_RSI_V6.1";
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
let _indicatorCache = { key: null, bb: null, bbMiddles: null, rsi: null, rsiPrev: null, sar: null, adx: null, st: null };

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
  var MAX_ENTRY_SL_PTS = parseFloat(cfg("SCALP_MAX_ENTRY_SL_PTS", "50")); // skip entries where the trend line sits farther than this from close (0 = off)
  var ADX_ENABLED = cfg("SCALP_ADX_ENABLED", "false") === "true"; // trend filter toggle
  var ADX_MIN     = parseFloat(cfg("SCALP_ADX_MIN", "20"));        // block entries when ADX(14) < this (ranging/chop)
  // Trend-confirmation source: PSAR (default) or SuperTrend(10,3). Mutually
  // exclusive — when on, SuperTrend takes over the directional confirmation,
  // the entry SL line AND the trend-flip exit (see isTrendFlip).
  var USE_SUPERTREND = cfg("SCALP_USE_SUPERTREND", "false") === "true";
  var ST_PERIOD = parseInt(cfg("SCALP_SUPERTREND_PERIOD", "10"), 10) || 10;
  var ST_MULT   = parseFloat(cfg("SCALP_SUPERTREND_MULT", "3")) || 3;

  var base = {
    signal: "NONE", reason: "", stopLoss: null, target: null,
    rsi: null, sar: null, adx: null, supertrend: null, stTrend: null,
    trendSource: USE_SUPERTREND ? "SUPERTREND" : "PSAR",
    bbUpper: null, bbMiddle: null, bbLower: null,
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
  var bb, bbMiddles, rsi, rsiPrev, sar, adx, st;

  if (cacheKey && _indicatorCache.key === cacheKey && _indicatorCache.bb) {
    bb        = _indicatorCache.bb;
    bbMiddles = _indicatorCache.bbMiddles;
    rsi       = _indicatorCache.rsi;
    rsiPrev   = _indicatorCache.rsiPrev;
    sar       = _indicatorCache.sar;
    adx       = _indicatorCache.adx;
    st        = _indicatorCache.st;
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

    // ADX (trend strength) — computed every candle now so it can be charted and
    // logged at entry/exit, not just when the ADX chop-gate filter is on.
    var adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    adx = adxArr.length > 0 ? adxArr[adxArr.length - 1].adx : null;

    // SuperTrend(10,3) — only when it is the active trend source (avoids the cost otherwise)
    st = null;
    if (USE_SUPERTREND) {
      var stArr = computeSuperTrend(candles, ST_PERIOD, ST_MULT);
      st = stArr.length > 0 ? stArr[stArr.length - 1] : null;
    }

    // Cache for next tick with same window
    _indicatorCache = { key: cacheKey, bb: bb, bbMiddles: bbMiddles, rsi: rsi, rsiPrev: rsiPrev, sar: sar, adx: adx, st: st };
  }

  base.bbUpper  = parseFloat(bb.upper.toFixed(2));
  base.bbMiddle = parseFloat(bb.middle.toFixed(2));
  base.bbLower  = parseFloat(bb.lower.toFixed(2));
  base.bbWidth  = parseFloat((bb.upper - bb.lower).toFixed(2));
  base.rsi = parseFloat(rsi.toFixed(1));
  base.sar = parseFloat(sar.toFixed(2));
  base.adx = adx != null ? parseFloat(adx.toFixed(1)) : null;
  base.supertrend = (st && st.value != null) ? parseFloat(st.value.toFixed(2)) : null;
  base.stTrend    = (st && st.trend != null) ? (st.trend === 1 ? "BULLISH" : "BEARISH") : null;
  base.stTrendInt = (st && st.trend != null) ? st.trend : null;

  // When SuperTrend is the active source it must be warmed up before we can decide.
  if (USE_SUPERTREND && (!st || st.trend == null)) {
    base.reason = "SuperTrend warming up";
    return base;
  }

  var _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

  // ── ADX trend filter (chop gate) ──────────────────────────────────────────
  // Block ALL entries when the market is ranging — ADX(14) below SCALP_ADX_MIN.
  // The strategy wins in trends and bleeds in chop; this sits out the choppy
  // sessions. Off by default (SCALP_ADX_ENABLED=false); when on, the floor is
  // SCALP_ADX_MIN. If ADX has no value yet (warm-up), pass through.
  if (ADX_ENABLED && Number.isFinite(adx) && adx < ADX_MIN) {
    base.reason = "No setup (market ranging — ADX=" + adx.toFixed(1) + " < " + ADX_MIN + ")";
    return base;
  }

  // ── ENTRY CONDITIONS (V6: BB break + PSAR side + RSI) ─────────────────────
  // CE: close above BB upper  + PSAR below close + RSI > RSI_CE
  // PE: close below BB lower   + PSAR above close + RSI < RSI_PE
  // Initial SL = PSAR value at entry (no clamp). SAR is always on the correct side
  // here (entry requires sarBelow for CE / sarAbove for PE), so it is a valid stop.

  // ── Active trend source (PSAR or SuperTrend) ──────────────────────────────
  // trendVal = the line that confirms direction AND seeds the entry SL.
  //   PSAR: bullish when SAR sits below close. SuperTrend: bullish when trend===1.
  var _srcLabel = USE_SUPERTREND ? "SUPERTREND" : "PSAR";
  var trendVal  = USE_SUPERTREND ? st.value : sar;
  var sarBelow  = USE_SUPERTREND ? (st.trend === 1)  : (sar < sc.close);   // bullish — line under price
  var sarAbove  = USE_SUPERTREND ? (st.trend === -1) : (sar > sc.close);   // bearish — line over price

  // ── Near-miss filter audit (additive-only logging; does NOT affect signal) ──
  var _ceAuditChecks = [
    { name: "BB upper break",      ok: sc.close >= bb.upper, detail: "close=" + sc.close + " vs BB_U=" + bb.upper.toFixed(1) },
    { name: _srcLabel + " below",  ok: sarBelow,             detail: _srcLabel + "=" + trendVal.toFixed(1) + " vs close=" + sc.close },
    { name: "RSI bullish",         ok: rsi > RSI_CE,         detail: "RSI=" + rsi.toFixed(1) + " vs >" + RSI_CE },
  ];
  var _peAuditChecks = [
    { name: "BB lower break",      ok: sc.close <= bb.lower, detail: "close=" + sc.close + " vs BB_L=" + bb.lower.toFixed(1) },
    { name: _srcLabel + " above",  ok: sarAbove,             detail: _srcLabel + "=" + trendVal.toFixed(1) + " vs close=" + sc.close },
    { name: "RSI bearish",         ok: rsi < RSI_PE,         detail: "RSI=" + rsi.toFixed(1) + " vs <" + RSI_PE },
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
    // Skip far entries: a freshly-flipped trend line can sit 100s of pts away → huge risk.
    if (MAX_ENTRY_SL_PTS > 0 && (sc.close - trendVal) > MAX_ENTRY_SL_PTS) {
      base.reason = "CE blocked: " + _srcLabel + " too far (" + (sc.close - trendVal).toFixed(0) + "pts > " + MAX_ENTRY_SL_PTS + ")";
      return base;
    }
    // Initial SL = active trend line at entry (no clamp). Line is below close here.
    var sl = parseFloat(trendVal.toFixed(2));
    var slPts = parseFloat((sc.close - trendVal).toFixed(2));
    if (!silent) console.log("[SCALP " + _ist + "] CE: close(" + sc.close + ") >= BB upper(" + bb.upper.toFixed(2) + ") + " + _srcLabel + "(" + trendVal.toFixed(1) + ")<close + RSI=" + rsi.toFixed(1) + " | SL(" + _srcLabel + ")=" + sl + " [" + slPts.toFixed(1) + "pts]");
    return Object.assign({}, base, {
      signal: "BUY_CE", signalStrength: "SCALP",
      stopLoss: sl,
      slSource: _srcLabel,
      target: null,
      slPts: slPts,
      reason: "CE: BB upper(" + bb.upper.toFixed(0) + ") + " + _srcLabel + "<close + RSI=" + rsi.toFixed(0) + " | SL(" + _srcLabel + ")=" + sl + " [" + slPts.toFixed(1) + "pts]",
    });
  }

  // PE (Short): close <= BB lower + PSAR above close + RSI < RSI_PE
  if (sc.close <= bb.lower && sarAbove && rsi < RSI_PE) {
    if (RSI_TURNING && rsi > rsiPrev) {
      base.reason = "PE blocked: RSI turning up (" + rsiPrev.toFixed(1) + " → " + rsi.toFixed(1) + ") — momentum fading";
      return base;
    }
    // Skip far entries: a freshly-flipped trend line can sit 100s of pts away → huge risk.
    if (MAX_ENTRY_SL_PTS > 0 && (trendVal - sc.close) > MAX_ENTRY_SL_PTS) {
      base.reason = "PE blocked: " + _srcLabel + " too far (" + (trendVal - sc.close).toFixed(0) + "pts > " + MAX_ENTRY_SL_PTS + ")";
      return base;
    }
    // Initial SL = active trend line at entry (no clamp). Line is above close here.
    var sl = parseFloat(trendVal.toFixed(2));
    var slPts = parseFloat((trendVal - sc.close).toFixed(2));
    if (!silent) console.log("[SCALP " + _ist + "] PE: close(" + sc.close + ") <= BB lower(" + bb.lower.toFixed(2) + ") + " + _srcLabel + "(" + trendVal.toFixed(1) + ")>close + RSI=" + rsi.toFixed(1) + " | SL(" + _srcLabel + ")=" + sl + " [" + slPts.toFixed(1) + "pts]");
    return Object.assign({}, base, {
      signal: "BUY_PE", signalStrength: "SCALP",
      stopLoss: sl,
      slSource: _srcLabel,
      target: null,
      slPts: slPts,
      reason: "PE: BB lower(" + bb.lower.toFixed(0) + ") + " + _srcLabel + ">close + RSI=" + rsi.toFixed(0) + " | SL(" + _srcLabel + ")=" + sl + " [" + slPts.toFixed(1) + "pts]",
    });
  }

  // No signal — build descriptive reason showing which leg failed
  var cePrice = sc.close >= bb.upper;
  var pePrice = sc.close <= bb.lower;

  var parts = [];
  if (cePrice) {
    var ceMiss = [];
    if (!sarBelow)    ceMiss.push(_srcLabel + " not below close");
    if (!(rsi > RSI_CE)) ceMiss.push("RSI=" + rsi.toFixed(0) + "<=" + RSI_CE);
    if (ceMiss.length) parts.push("CE broke BB but " + ceMiss.join(" & "));
  }
  if (pePrice) {
    var peMiss = [];
    if (!sarAbove)    peMiss.push(_srcLabel + " not above close");
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

// ── Hard stop (catastrophic loss cap, per-tick, spot POINTS) ─────────────────
// Companion to the profit lock — caps the downside only. Exit once the trade has
// moved SCALP_STOP_LOSS_PTS against entry (favPts ≤ −stop). Set WIDE (default 30)
// so it never touches the normal small scalps — it only clips the deep adverse
// excursions on failed BB-break fades that would otherwise bleed to −100+ pts
// before the candle-close BB re-entry / PSAR flip fires. 0 disables.
//   favPts — current favourable spot points (CE = price−entry, PE = entry−price)
// Returns { hit, stop }.
function hardStop(favPts) {
  var stop = parseFloat(cfg("SCALP_STOP_LOSS_PTS", "30"));
  if (stop <= 0 || favPts == null) return { hit: false, stop: null };
  return { hit: favPts <= -stop, stop: stop };
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

// ── SuperTrend flip detection (trend line crosses price → exit) ──────────────
// The SuperTrend analogue of the PSAR flip: on candle close, exit when the
// trend state has reversed against the position (CE wants bullish, PE bearish).
function isSuperTrendFlip(candles, side) {
  var ST_PERIOD = parseInt(cfg("SCALP_SUPERTREND_PERIOD", "10"), 10) || 10;
  var ST_MULT   = parseFloat(cfg("SCALP_SUPERTREND_MULT", "3")) || 3;
  var arr = computeSuperTrend(candles, ST_PERIOD, ST_MULT);
  if (arr.length < 2) return false;
  var curr = arr[arr.length - 1];
  var prev = arr[arr.length - 2];
  if (!curr || !prev || curr.trend == null || prev.trend == null) return false;
  if (side === "CE") return prev.trend === 1  && curr.trend === -1;  // bull → bear flip
  return                     prev.trend === -1 && curr.trend === 1;   // bear → bull flip
}

// ── Unified trend-flip exit (dispatches to the active trend source) ──────────
// Routes call this instead of isPSARFlip so the exit follows whichever source
// (PSAR or SuperTrend) drove the entry. SCALP_USE_SUPERTREND selects it.
function isTrendFlip(candles, side) {
  if (cfg("SCALP_USE_SUPERTREND", "false") === "true") return isSuperTrendFlip(candles, side);
  return isPSARFlip(candles, side);
}

// ── BB re-entry exit (failed-breakout) ──────────────────────────────────────
// On candle close, if price has closed back INSIDE the band the breakout that
// triggered the entry has failed → exit (faster than waiting for the PSAR flip).
//   CE entered on close ≥ BB.upper → exit when close < BB.upper.
//   PE entered on close ≤ BB.lower → exit when close > BB.lower.
// Gated by SCALP_BB_REENTRY_EXIT (default on). Uses the same BB inputs as entry.
function bbReentryExit(candles, side) {
  if (cfg("SCALP_BB_REENTRY_EXIT", "true") !== "true") return false;
  var bb = bbLevels(candles);
  if (!bb) return false;
  var close = candles[candles.length - 1].close;
  if (side === "CE") return close < bb.upper;   // closed back below the upper band
  return close > bb.lower;                        // PE: closed back above the lower band
}

// Latest BB upper/lower from the supplied (completed) candles, same inputs the
// entry/exit use. Exposed so the routes can run the BB re-entry stop intra-candle
// (per-tick spot vs band) instead of only on candle close. null if insufficient data.
function bbLevels(candles) {
  var BB_PERIOD = parseInt(cfg("SCALP_BB_PERIOD", "20"), 10);
  var BB_STDDEV = parseFloat(cfg("SCALP_BB_STDDEV", "1"));
  var closes = candles.map(function(c) { return c.close; });
  var bbArr = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes });
  if (bbArr.length < 1) return null;
  return bbArr[bbArr.length - 1];
}

function reset() { _indicatorCache = { key: null, bb: null, bbMiddles: null, rsi: null, sar: null, adx: null, st: null }; }

module.exports = { NAME, DESCRIPTION, getSignal, profitLock, hardStop, isPSARFlip, isSuperTrendFlip, isTrendFlip, bbReentryExit, bbLevels, reset };

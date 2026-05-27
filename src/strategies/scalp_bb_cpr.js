/**
 * SCALP V5: Bollinger Bands + PSAR + RSI (clean BB-break design)
 *
 * ENTRY:
 *   CE: candle closes above BB upper + PSAR below close + RSI > SCALP_RSI_CE_THRESHOLD (default 62)
 *   PE: candle closes below BB lower + PSAR above close + RSI < SCALP_RSI_PE_THRESHOLD (default 42)
 *   Guards: RSI overbought/oversold cap (SCALP_RSI_CE_MAX / SCALP_RSI_PE_MIN), optional RSI-turning.
 *   SL = Previous candle low (CE) / high (PE), capped at SCALP_MAX_SL_PTS, floored at SCALP_MIN_SL_PTS
 *
 * EXIT:
 *   1. Initial SL hit (Prev Candle)
 *   2. Break-even snap (peak ≥ trigger × risk)
 *   3. Trailing SL: PSAR only — tightens only
 *   4. PSAR flip → immediate exit
 *   5. EOD / daily loss / max trades / SL-pause cooldown (handled by routes)
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
  var RSI_CE      = parseFloat(cfg("SCALP_RSI_CE_THRESHOLD", "62"));
  var RSI_PE      = parseFloat(cfg("SCALP_RSI_PE_THRESHOLD", "42"));
  var RSI_CE_MAX  = parseFloat(cfg("SCALP_RSI_CE_MAX", "78"));   // overbought guard — block CE above
  var RSI_PE_MIN  = parseFloat(cfg("SCALP_RSI_PE_MIN", "22"));   // oversold guard  — block PE below
  var RSI_TURNING = cfg("SCALP_RSI_TURNING", "false") === "true"; // require RSI momentum confirms direction
  var PSAR_STEP   = parseFloat(cfg("SCALP_PSAR_STEP", "0.02"));
  var PSAR_MAX    = parseFloat(cfg("SCALP_PSAR_MAX", "0.2"));

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

  // ── ENTRY CONDITIONS (V5: BB break + PSAR side + RSI) ─────────────────────
  // CE: close above BB upper  + PSAR below close + RSI > RSI_CE (capped at RSI_CE_MAX)
  // PE: close below BB lower   + PSAR above close + RSI < RSI_PE (floored at RSI_PE_MIN)

  var MAX_SL_PTS  = parseFloat(cfg("SCALP_MAX_SL_PTS", "12"));
  var MIN_SL_PTS  = parseFloat(cfg("SCALP_MIN_SL_PTS", "8"));
  var prevCandle  = candles[candles.length - 2];

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
    if (rsi > RSI_CE_MAX) {
      base.reason = "CE blocked: RSI=" + rsi.toFixed(1) + " > " + RSI_CE_MAX + " (overbought / exhausted move)";
      return base;
    }
    if (RSI_TURNING && rsi < rsiPrev) {
      base.reason = "CE blocked: RSI turning down (" + rsiPrev.toFixed(1) + " → " + rsi.toFixed(1) + ") — momentum fading";
      return base;
    }
    var rawSL = prevCandle.low;
    var slPts = Math.max(Math.min(sc.close - rawSL, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close - slPts).toFixed(2));
    if (!silent) console.log("[SCALP " + _ist + "] CE: close(" + sc.close + ") >= BB upper(" + bb.upper.toFixed(2) + ") + SAR(" + sar.toFixed(1) + ")<close + RSI=" + rsi.toFixed(1) + " | SL(PrevLow)=" + sl + " [prev.low=" + prevCandle.low + " capped=" + slPts.toFixed(1) + "]");
    return Object.assign({}, base, {
      signal: "BUY_CE", signalStrength: "SCALP",
      stopLoss: sl,
      slSource: "Prev Candle",
      target: null,
      slPts: slPts,
      reason: "CE: BB upper(" + bb.upper.toFixed(0) + ") + SAR<close + RSI=" + rsi.toFixed(0) + " | SL(PrevLow)=" + sl + " [" + slPts.toFixed(1) + "pts]",
    });
  }

  // PE (Short): close <= BB lower + PSAR above close + RSI < RSI_PE
  if (sc.close <= bb.lower && sarAbove && rsi < RSI_PE) {
    if (rsi < RSI_PE_MIN) {
      base.reason = "PE blocked: RSI=" + rsi.toFixed(1) + " < " + RSI_PE_MIN + " (oversold / exhausted move)";
      return base;
    }
    if (RSI_TURNING && rsi > rsiPrev) {
      base.reason = "PE blocked: RSI turning up (" + rsiPrev.toFixed(1) + " → " + rsi.toFixed(1) + ") — momentum fading";
      return base;
    }
    var rawSL = prevCandle.high;
    var slPts = Math.max(Math.min(rawSL - sc.close, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close + slPts).toFixed(2));
    if (!silent) console.log("[SCALP " + _ist + "] PE: close(" + sc.close + ") <= BB lower(" + bb.lower.toFixed(2) + ") + SAR(" + sar.toFixed(1) + ")>close + RSI=" + rsi.toFixed(1) + " | SL(PrevHigh)=" + sl + " [prev.high=" + prevCandle.high + " capped=" + slPts.toFixed(1) + "]");
    return Object.assign({}, base, {
      signal: "BUY_PE", signalStrength: "SCALP",
      stopLoss: sl,
      slSource: "Prev Candle",
      target: null,
      slPts: slPts,
      reason: "PE: BB lower(" + bb.lower.toFixed(0) + ") + SAR>close + RSI=" + rsi.toFixed(0) + " | SL(PrevHigh)=" + sl + " [" + slPts.toFixed(1) + "pts]",
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

// ── Trailing SL update: break-even snap → PSAR — tighten only, never widen ──
// opts: { peakPnl, initialRiskRupees, entryPrice, slippagePts }
//   - peakPnl + initialRiskRupees: enable break-even snap when peak ≥ trigger × risk
//   - entryPrice + slippagePts: target spot price for the break-even SL
function updateTrailingSL(candles, currentSL, side, opts) {
  opts = opts || {};
  var PSAR_STEP = parseFloat(cfg("SCALP_PSAR_STEP", "0.02"));
  var PSAR_MAX  = parseFloat(cfg("SCALP_PSAR_MAX", "0.2"));

  // ── Break-even snap (preempts PSAR — runs first because it's the bigger win) ─
  // Once peak P&L reaches BE_TRIGGER_R × initial risk, snap SL to entry +/- offset.
  // Set SCALP_BREAKEVEN_TRIGGER_R = 0 to disable.
  var beTriggerR = parseFloat(cfg("SCALP_BREAKEVEN_TRIGGER_R", "0.7"));
  var beOffsetPts = parseFloat(cfg("SCALP_BREAKEVEN_OFFSET_PTS", "1"));
  if (beTriggerR > 0
      && opts.peakPnl != null
      && opts.initialRiskRupees > 0
      && opts.entryPrice != null
      && opts.peakPnl >= beTriggerR * opts.initialRiskRupees) {
    var beSL = side === "CE"
      ? opts.entryPrice + beOffsetPts
      : opts.entryPrice - beOffsetPts;
    beSL = parseFloat(beSL.toFixed(2));
    if (side === "CE" && beSL > currentSL) {
      return { sl: beSL, source: "BreakEven" };
    }
    if (side === "PE" && beSL < currentSL) {
      return { sl: beSL, source: "BreakEven" };
    }
  }

  var highs = candles.map(function(c) { return c.high; });
  var lows  = candles.map(function(c) { return c.low; });

  var sarArr = PSAR.calculate({ step: PSAR_STEP, max: PSAR_MAX, high: highs, low: lows });
  var newSar = sarArr.length > 0 ? sarArr[sarArr.length - 1] : null;
  var close = candles[candles.length - 1].close;

  if (newSar === null) return { sl: currentSL, source: null };

  if (side === "CE") {
    // CE: SL is below price — tighter = higher value; only tighten (move up)
    if (newSar < close && newSar > currentSL) {
      return { sl: parseFloat(newSar.toFixed(2)), source: "PSAR" };
    }
  } else {
    // PE: SL is above price — tighter = lower value; only tighten (move down)
    if (newSar > close && newSar < currentSL) {
      return { sl: parseFloat(newSar.toFixed(2)), source: "PSAR" };
    }
  }

  return { sl: currentSL, source: null };
}

// ── PSAR flip detection (SAR crosses price → exit) ──────────────────────────
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

function reset() { _indicatorCache = { key: null, bb: null, bbMiddles: null, rsi: null, sar: null }; }

module.exports = { NAME, DESCRIPTION, getSignal, updateTrailingSL, isPSARFlip, reset };

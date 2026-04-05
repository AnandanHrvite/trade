/**
 * SCALP V4: Bollinger Bands + RSI + PSAR
 *
 * ENTRY:
 *   CE: close >= BB upper + RSI > 55
 *   PE: close <= BB lower + RSI < 45
 *   SL = tighter of (previous candle low/high, PSAR)
 *       with hard cap of SCALP_MAX_SL_PTS (default 50 pts)
 *
 * EXIT:
 *   1. Initial SL hit (tighter of prevCandle / PSAR)
 *   2. Trailing profit: ₹300, ₹500, ₹700, ₹900...
 *   3. Trailing SL: tighter of (prevCandle low/high, PSAR) — tightens only
 *   4. PSAR flip → immediate exit
 *   5. EOD / daily loss / max trades (handled by routes)
 */

const { BollingerBands, RSI, PSAR } = require("technicalindicators");

const NAME        = "SCALP_BB_RSI_V4";
const DESCRIPTION = "BB + RSI + PSAR trail";

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }

// ── CPR helpers (kept for backtest compatibility — not used in entry logic) ──
function calcCPR(prevHigh, prevLow, prevClose) {
  const pivot = (prevHigh + prevLow + prevClose) / 3;
  const bc    = (prevHigh + prevLow) / 2;
  const tc    = (2 * pivot) - bc;
  return {
    pivot:    parseFloat(pivot.toFixed(2)),
    tc:       parseFloat(Math.max(tc, bc).toFixed(2)),
    bc:       parseFloat(Math.min(tc, bc).toFixed(2)),
    rawTC: tc, rawBC: bc,
    width:    parseFloat(Math.abs(tc - bc).toFixed(2)),
    prevRange: parseFloat((prevHigh - prevLow).toFixed(2)),
  };
}
function isNarrowCPR(cpr) {
  const narrowPct = parseFloat(cfg("SCALP_CPR_NARROW_PCT", "33"));
  if (cpr.prevRange === 0) return false;
  return (cpr.width / cpr.prevRange) * 100 < narrowPct;
}

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
let _indicatorCache = { key: null, bb: null, rsi: null, sar: null };

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
  var RSI_CE      = parseFloat(cfg("SCALP_RSI_CE_THRESHOLD", "55"));
  var RSI_PE      = parseFloat(cfg("SCALP_RSI_PE_THRESHOLD", "45"));
  var PSAR_STEP   = parseFloat(cfg("SCALP_PSAR_STEP", "0.02"));
  var PSAR_MAX    = parseFloat(cfg("SCALP_PSAR_MAX", "0.2"));

  var base = {
    signal: "NONE", reason: "", stopLoss: null, target: null,
    rsi: null, sar: null, bbUpper: null, bbMiddle: null, bbLower: null,
    cpr: null, cprNarrow: false, cprInsideValue: false,
  };

  // Warm-up
  var minCandles = Math.max(BB_PERIOD + 5, RSI_PERIOD + 5, 30);
  if (candles.length < minCandles) {
    base.reason = "Warming up (" + candles.length + "/" + minCandles + ")";
    return base;
  }

  var sc = candles[candles.length - 1];
  var windowCheck = isInTradingWindow(sc.time);
  if (!windowCheck.ok) {
    base.reason = windowCheck.reason;
    return base;
  }

  // ── Indicators (with cache to avoid redundant recalculation) ──────────────
  var cacheKey = _makeIndicatorKey(candles);
  var bb, rsi, sar;

  if (cacheKey && _indicatorCache.key === cacheKey && _indicatorCache.bb) {
    bb  = _indicatorCache.bb;
    rsi = _indicatorCache.rsi;
    sar = _indicatorCache.sar;
  } else {
    var closes = candles.map(function(c) { return c.close; });
    var highs  = candles.map(function(c) { return c.high; });
    var lows   = candles.map(function(c) { return c.low; });

    // Bollinger Bands
    var bbArr = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes });
    if (bbArr.length < 1) { base.reason = "BB warming up"; return base; }
    bb = bbArr[bbArr.length - 1];

    // RSI
    var rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
    if (rsiArr.length < 1) { base.reason = "RSI warming up"; return base; }
    rsi = rsiArr[rsiArr.length - 1];

    // Parabolic SAR
    var sarArr = PSAR.calculate({ step: PSAR_STEP, max: PSAR_MAX, high: highs, low: lows });
    if (sarArr.length < 1) { base.reason = "SAR warming up"; return base; }
    sar = sarArr[sarArr.length - 1];

    // Cache for next tick with same window
    _indicatorCache = { key: cacheKey, bb: bb, rsi: rsi, sar: sar };
  }

  base.bbUpper  = parseFloat(bb.upper.toFixed(2));
  base.bbMiddle = parseFloat(bb.middle.toFixed(2));
  base.bbLower  = parseFloat(bb.lower.toFixed(2));
  base.rsi = parseFloat(rsi.toFixed(1));
  base.sar = parseFloat(sar.toFixed(2));

  var _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

  // ── ACTIVITY FILTER (optional — disabled by default) ─────────────────────
  // NIFTY index has no real volume — uses candle range (high-low) as activity proxy.
  // Skips entries when current candle range is below threshold of recent average.
  // Enable via Settings: SCALP_ACTIVITY_FILTER=true
  if (cfg("SCALP_ACTIVITY_FILTER", "false") === "true" && candles.length >= 20) {
    var activityRatio = parseFloat(cfg("SCALP_ACTIVITY_FILTER_RATIO", "0.5"));
    var recentRanges = candles.slice(-20).map(function(c) { return c.high - c.low; });
    var avgRange = recentRanges.reduce(function(s, r) { return s + r; }, 0) / recentRanges.length;
    var curRange = sc.high - sc.low;
    if (avgRange > 0 && curRange < avgRange * activityRatio) {
      base.reason = "Low activity (range " + curRange.toFixed(1) + " < " + (avgRange * activityRatio).toFixed(1) + " threshold)";
      return base;
    }
  }

  // ── ENTRY CONDITIONS ─────────────────────────────────────────────────────

  var MAX_SL_PTS = parseFloat(cfg("SCALP_MAX_SL_PTS", "50"));
  var prevCandle = candles[candles.length - 2];

  // Reuse PSAR already computed above (sar variable) for SL comparison
  var _curSar = sar;

  // CE (Long): price at/above BB upper + RSI > 55
  if (sc.close >= bb.upper && rsi > RSI_CE) {
    // SL = max(prevCandle.low, PSAR) — pick tighter (higher) value, hard-capped at MAX_SL_PTS
    var prevLow = prevCandle ? prevCandle.low : sc.close - MAX_SL_PTS;
    var candidates = [prevLow];
    if (_curSar !== null && _curSar < sc.close) candidates.push(_curSar);
    var sl = parseFloat(Math.max(Math.max.apply(null, candidates), sc.close - MAX_SL_PTS).toFixed(2));
    var slPts = parseFloat((sc.close - sl).toFixed(2));
    var slSrc = (_curSar !== null && _curSar < sc.close && _curSar >= prevLow) ? "PSAR" : "prevLow";
    if (!silent) console.log("[SCALP " + _ist + "] CE: close(" + sc.close + ") >= BB upper(" + bb.upper.toFixed(2) + ") + RSI=" + rsi.toFixed(1) + " | SL(" + slSrc + ")=" + sl + " [prevLow=" + prevLow + " PSAR=" + (_curSar !== null ? _curSar.toFixed(2) : "n/a") + "]");
    return Object.assign({}, base, {
      signal: "BUY_CE", signalStrength: "SCALP",
      stopLoss: sl,
      slSource: slSrc === "PSAR" ? "PSAR" : "Prev candle",
      target: null,
      slPts: slPts,
      reason: "CE: BB upper(" + bb.upper.toFixed(0) + ") + RSI=" + rsi.toFixed(0) + " | SL(" + slSrc + ")=" + sl,
    });
  }

  // PE (Short): price at/below BB lower + RSI < 45
  if (sc.close <= bb.lower && rsi < RSI_PE) {
    // SL = min(prevCandle.high, PSAR) — pick tighter (lower) value, hard-capped at MAX_SL_PTS
    var prevHigh = prevCandle ? prevCandle.high : sc.close + MAX_SL_PTS;
    var candidates = [prevHigh];
    if (_curSar !== null && _curSar > sc.close) candidates.push(_curSar);
    var sl = parseFloat(Math.min(Math.min.apply(null, candidates), sc.close + MAX_SL_PTS).toFixed(2));
    var slPts = parseFloat((sl - sc.close).toFixed(2));
    var slSrc = (_curSar !== null && _curSar > sc.close && _curSar <= prevHigh) ? "PSAR" : "prevHigh";
    if (!silent) console.log("[SCALP " + _ist + "] PE: close(" + sc.close + ") <= BB lower(" + bb.lower.toFixed(2) + ") + RSI=" + rsi.toFixed(1) + " | SL(" + slSrc + ")=" + sl + " [prevHigh=" + prevHigh + " PSAR=" + (_curSar !== null ? _curSar.toFixed(2) : "n/a") + "]");
    return Object.assign({}, base, {
      signal: "BUY_PE", signalStrength: "SCALP",
      stopLoss: sl,
      slSource: slSrc === "PSAR" ? "PSAR" : "Prev candle",
      target: null,
      slPts: slPts,
      reason: "PE: BB lower(" + bb.lower.toFixed(0) + ") + RSI=" + rsi.toFixed(0) + " | SL(" + slSrc + ")=" + sl,
    });
  }

  // No signal — build descriptive reason showing which side was close / blocked
  var cePrice = sc.close >= bb.upper;
  var ceRsi   = rsi > RSI_CE;
  var pePrice = sc.close <= bb.lower;
  var peRsi   = rsi < RSI_PE;

  var parts = [];
  if (cePrice && !ceRsi) {
    parts.push("CE price OK but RSI=" + rsi.toFixed(0) + "<=" + RSI_CE);
  } else if (!cePrice && ceRsi) {
    parts.push("CE RSI OK but price below BB upper");
  }
  if (pePrice && !peRsi) {
    parts.push("PE price OK but RSI=" + rsi.toFixed(0) + ">=" + RSI_PE);
  } else if (!pePrice && peRsi) {
    parts.push("PE RSI OK but price above BB lower");
  }

  base.reason = parts.length > 0 ? "No setup (" + parts.join("; ") + ")" : "No setup";
  return base;
}

// ── Trailing SL update: min(prevCandle, PSAR) — pick tighter, tighten only ──
function updateTrailingSL(candles, currentSL, side, opts) {
  opts = opts || {};
  var PSAR_STEP = parseFloat(cfg("SCALP_PSAR_STEP", "0.02"));
  var PSAR_MAX  = parseFloat(cfg("SCALP_PSAR_MAX", "0.2"));

  var highs = candles.map(function(c) { return c.high; });
  var lows  = candles.map(function(c) { return c.low; });

  var sarArr = PSAR.calculate({ step: PSAR_STEP, max: PSAR_MAX, high: highs, low: lows });
  var newSar = sarArr.length > 0 ? sarArr[sarArr.length - 1] : null;
  var prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;
  var close = candles[candles.length - 1].close;

  if (side === "CE") {
    // CE: SL is below price — tighter = higher value
    var candidates = [];
    if (newSar !== null && newSar < close) candidates.push({ val: newSar, src: "PSAR" });
    if (prevCandle) candidates.push({ val: prevCandle.low, src: "Prev candle" });
    if (candidates.length === 0) return { sl: currentSL, source: null };
    // Pick the tighter (higher) of prevCandle.low and PSAR
    var best = candidates.reduce(function(a, b) { return b.val > a.val ? b : a; });
    // Only tighten (move up), never widen
    if (best.val > currentSL && best.val < close) {
      return { sl: parseFloat(best.val.toFixed(2)), source: best.src };
    }
  } else {
    // PE: SL is above price — tighter = lower value
    var candidates = [];
    if (newSar !== null && newSar > close) candidates.push({ val: newSar, src: "PSAR" });
    if (prevCandle) candidates.push({ val: prevCandle.high, src: "Prev candle" });
    if (candidates.length === 0) return { sl: currentSL, source: null };
    // Pick the tighter (lower) of prevCandle.high and PSAR
    var best = candidates.reduce(function(a, b) { return b.val < a.val ? b : a; });
    // Only tighten (move down), never widen
    if (best.val < currentSL && best.val > close) {
      return { sl: parseFloat(best.val.toFixed(2)), source: best.src };
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

function reset() { _indicatorCache = { key: null, bb: null, rsi: null, sar: null }; }

module.exports = { NAME, DESCRIPTION, getSignal, updateTrailingSL, isPSARFlip, calcCPR, isNarrowCPR, reset };

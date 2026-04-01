/**
 * SCALP V4: Bollinger Bands + RSI + PSAR
 *
 * ENTRY:
 *   CE: close >= BB upper + RSI > 55
 *   PE: close <= BB lower + RSI < 45
 *   SL = previous candle low (CE) / previous candle high (PE)
 *       with hard cap of SCALP_MAX_SL_PTS (default 50 pts)
 *
 * EXIT:
 *   1. Initial SL hit (prev candle low/high based)
 *   2. Trailing profit: ₹300, ₹500, ₹700, ₹900...
 *   3. PSAR trailing SL (tightens only — takes over when tighter than initial)
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
function isInTradingWindow(unixSec) {
  var d = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  if (totalMin < 561)  return { ok: false, reason: "Before 9:21 AM" };
  if (totalMin >= 840) return { ok: false, reason: "After 2:00 PM" };
  return { ok: true, reason: null };
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

  // ── Indicators ───────────────────────────────────────────────────────────
  var closes = candles.map(function(c) { return c.close; });
  var highs  = candles.map(function(c) { return c.high; });
  var lows   = candles.map(function(c) { return c.low; });

  // Bollinger Bands
  var bbArr = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes });
  if (bbArr.length < 1) { base.reason = "BB warming up"; return base; }
  var bb = bbArr[bbArr.length - 1];
  base.bbUpper  = parseFloat(bb.upper.toFixed(2));
  base.bbMiddle = parseFloat(bb.middle.toFixed(2));
  base.bbLower  = parseFloat(bb.lower.toFixed(2));

  // RSI
  var rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
  if (rsiArr.length < 1) { base.reason = "RSI warming up"; return base; }
  var rsi = rsiArr[rsiArr.length - 1];
  base.rsi = parseFloat(rsi.toFixed(1));

  // Parabolic SAR
  var sarArr = PSAR.calculate({ step: PSAR_STEP, max: PSAR_MAX, high: highs, low: lows });
  if (sarArr.length < 1) { base.reason = "SAR warming up"; return base; }
  var sar = sarArr[sarArr.length - 1];
  base.sar = parseFloat(sar.toFixed(2));

  var _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

  // ── ENTRY CONDITIONS ─────────────────────────────────────────────────────

  var MAX_SL_PTS = parseFloat(cfg("SCALP_MAX_SL_PTS", "50"));
  var prevCandle = candles[candles.length - 2];

  // CE (Long): price at/above BB upper + RSI > 55
  if (sc.close >= bb.upper && rsi > RSI_CE) {
    // SL = previous candle low, hard-capped at MAX_SL_PTS from entry
    var prevLow = prevCandle ? prevCandle.low : sc.close - MAX_SL_PTS;
    var sl = parseFloat(Math.max(prevLow, sc.close - MAX_SL_PTS).toFixed(2));
    var slPts = parseFloat((sc.close - sl).toFixed(2));
    if (!silent) console.log("[SCALP " + _ist + "] CE: close(" + sc.close + ") >= BB upper(" + bb.upper.toFixed(2) + ") + RSI=" + rsi.toFixed(1) + " | SL(prevLow)=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_CE", signalStrength: "SCALP",
      stopLoss: sl,
      target: null,
      slPts: slPts,
      reason: "CE: BB upper(" + bb.upper.toFixed(0) + ") + RSI=" + rsi.toFixed(0) + " | SL(prevLow)=" + sl,
    });
  }

  // PE (Short): price at/below BB lower + RSI < 45
  if (sc.close <= bb.lower && rsi < RSI_PE) {
    // SL = previous candle high, hard-capped at MAX_SL_PTS from entry
    var prevHigh = prevCandle ? prevCandle.high : sc.close + MAX_SL_PTS;
    var sl = parseFloat(Math.min(prevHigh, sc.close + MAX_SL_PTS).toFixed(2));
    var slPts = parseFloat((sl - sc.close).toFixed(2));
    if (!silent) console.log("[SCALP " + _ist + "] PE: close(" + sc.close + ") <= BB lower(" + bb.lower.toFixed(2) + ") + RSI=" + rsi.toFixed(1) + " | SL(prevHigh)=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_PE", signalStrength: "SCALP",
      stopLoss: sl,
      target: null,
      slPts: slPts,
      reason: "PE: BB lower(" + bb.lower.toFixed(0) + ") + RSI=" + rsi.toFixed(0) + " | SL(prevHigh)=" + sl,
    });
  }

  // No signal
  base.reason = "No setup";
  return base;
}

// ── PSAR Trailing SL update (called on each candle close while in position) ─
function updateTrailingSL(candles, currentSL, side, opts) {
  opts = opts || {};
  var PSAR_STEP = parseFloat(cfg("SCALP_PSAR_STEP", "0.02"));
  var PSAR_MAX  = parseFloat(cfg("SCALP_PSAR_MAX", "0.2"));

  var highs = candles.map(function(c) { return c.high; });
  var lows  = candles.map(function(c) { return c.low; });

  var sarArr = PSAR.calculate({ step: PSAR_STEP, max: PSAR_MAX, high: highs, low: lows });
  if (sarArr.length < 1) return currentSL;

  var newSar = sarArr[sarArr.length - 1];

  if (side === "CE") {
    if (newSar > currentSL && newSar < candles[candles.length - 1].close) {
      return parseFloat(newSar.toFixed(2));
    }
  } else {
    if (newSar < currentSL && newSar > candles[candles.length - 1].close) {
      return parseFloat(newSar.toFixed(2));
    }
  }

  return currentSL;
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

function reset() { /* no pending state in this strategy */ }

module.exports = { NAME, DESCRIPTION, getSignal, updateTrailingSL, isPSARFlip, calcCPR, isNarrowCPR, reset };

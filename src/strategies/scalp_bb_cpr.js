/**
 * SCALP V3: Bollinger Bands + CPR + RSI + PSAR Trailing SL
 *
 * ENTRY:
 *   1. CPR is Narrow (trending day) — |TC - BC| < X% of prev day range
 *   2. NOT Inside Value CPR (today's CPR inside yesterday's CPR → skip)
 *   3. CE: close between BB middle & upper + price above upper CPR + RSI > 70
 *   4. PE: close between BB lower & middle + price below lower CPR + RSI < 30
 *   5. SL = PSAR value
 *
 * EXIT:
 *   1. PSAR trailing SL (updates each candle, only tightens)
 *   2. PSAR flip → immediate exit
 *   3. EOD / daily loss / max trades (handled by routes)
 */

const { BollingerBands, RSI, PSAR, EMA } = require("technicalindicators");

const NAME        = "SCALP_BB_CPR_V3";
const DESCRIPTION = "BB(SD1) + CPR + RSI + PSAR trail";

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }

// ── CPR Calculation ──────────────────────────────────────────────────────────
// Uses previous day's High, Low, Close
function calcCPR(prevHigh, prevLow, prevClose) {
  const pivot = (prevHigh + prevLow + prevClose) / 3;
  const bc    = (prevHigh + prevLow) / 2;
  const tc    = (2 * pivot) - bc;
  return {
    pivot:    parseFloat(pivot.toFixed(2)),
    tc:       parseFloat(Math.max(tc, bc).toFixed(2)),  // upper CPR
    bc:       parseFloat(Math.min(tc, bc).toFixed(2)),  // lower CPR
    rawTC:    tc,
    rawBC:    bc,
    width:    parseFloat(Math.abs(tc - bc).toFixed(2)),
    prevRange: parseFloat((prevHigh - prevLow).toFixed(2)),
  };
}

function isNarrowCPR(cpr) {
  const narrowPct = parseFloat(cfg("SCALP_CPR_NARROW_PCT", "33"));
  if (cpr.prevRange === 0) return false;
  const widthPct = (cpr.width / cpr.prevRange) * 100;
  return widthPct < narrowPct;
}

function isInsideValueCPR(todayCPR, yesterdayCPR) {
  if (!yesterdayCPR) return false;
  return todayCPR.tc <= yesterdayCPR.tc && todayCPR.bc >= yesterdayCPR.bc;
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
// opts.prevDayOHLC = { high, low, close }          — required for CPR
// opts.prevPrevDayOHLC = { high, low, close }      — optional for Inside Value check
// opts.silent = true                                — suppress console logs
function getSignal(candles, opts) {
  opts = opts || {};
  var silent = opts.silent === true;

  var BB_PERIOD   = parseInt(cfg("SCALP_BB_PERIOD", "20"), 10);
  var BB_STDDEV   = parseFloat(cfg("SCALP_BB_STDDEV", "1"));
  var RSI_PERIOD  = parseInt(cfg("SCALP_RSI_PERIOD", "14"), 10);
  var RSI_CE      = parseFloat(cfg("SCALP_RSI_CE_THRESHOLD", "60"));
  var RSI_PE      = parseFloat(cfg("SCALP_RSI_PE_THRESHOLD", "40"));
  var PSAR_STEP   = parseFloat(cfg("SCALP_PSAR_STEP", "0.02"));
  var PSAR_MAX    = parseFloat(cfg("SCALP_PSAR_MAX", "0.2"));

  var base = {
    signal: "NONE", reason: "", stopLoss: null, target: null,
    rsi: null, sar: null, bbUpper: null, bbMiddle: null, bbLower: null,
    cpr: null, cprNarrow: false, cprInsideValue: false,
  };

  // Need enough candles for BB(20) + RSI(14) warm-up
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

  // ── CPR check ────────────────────────────────────────────────────────────
  if (!opts.prevDayOHLC) {
    base.reason = "No prev day data for CPR";
    return base;
  }

  var cpr = calcCPR(opts.prevDayOHLC.high, opts.prevDayOHLC.low, opts.prevDayOHLC.close);
  base.cpr = cpr;

  // Narrow CPR filter — only trade on narrow CPR days
  var narrow = isNarrowCPR(cpr);
  base.cprNarrow = narrow;
  if (!narrow) {
    base.reason = "Wide CPR (" + cpr.width.toFixed(2) + " pts, " + ((cpr.width / cpr.prevRange) * 100).toFixed(2) + "%) — skip";
    return base;
  }

  // Inside Value CPR — skip (market stays in range)
  if (opts.prevPrevDayOHLC) {
    var yesterdayCPR = calcCPR(opts.prevPrevDayOHLC.high, opts.prevPrevDayOHLC.low, opts.prevPrevDayOHLC.close);
    var insideVal = isInsideValueCPR(cpr, yesterdayCPR);
    base.cprInsideValue = insideVal;
    if (insideVal) {
      base.reason = "Inside Value CPR — skip";
      return base;
    }
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

  // EMA trend filter
  var EMA_PERIOD = parseInt(cfg("SCALP_EMA_PERIOD", "20"), 10);
  var emaArr = EMA.calculate({ period: EMA_PERIOD, values: closes });
  var ema = emaArr.length > 0 ? emaArr[emaArr.length - 1] : null;

  var _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

  // ── Candle body & momentum helpers ──
  var isBullishCandle = sc.close > sc.open;
  var isBearishCandle = sc.close < sc.open;
  var prevCandle = candles[candles.length - 2];
  var prevBullish = prevCandle && prevCandle.close > prevCandle.open;
  var prevBearish = prevCandle && prevCandle.close < prevCandle.open;

  // Min distance from CPR (avoid entries barely above/below CPR)
  var CPR_MIN_DIST = parseFloat(cfg("SCALP_CPR_MIN_DIST", "5"));

  // ── ENTRY CONDITIONS ─────────────────────────────────────────────────────

  // CE (Long): BB zone + above CPR + RSI + SAR + EMA + bullish momentum (2 candles)
  var bbLongZone  = sc.close > bb.middle && sc.close < bb.upper;
  var aboveCPR    = sc.close > cpr.tc + CPR_MIN_DIST;
  var sarBelow    = sar < sc.close;
  var rsiCE       = rsi > RSI_CE;
  var emaBullish  = ema ? sc.close > ema : true;
  var bullishMom  = isBullishCandle && (prevBullish || (prevCandle && sc.close > prevCandle.high));

  if (bbLongZone && aboveCPR && sarBelow && rsiCE && emaBullish && bullishMom) {
    var sl = parseFloat(sar.toFixed(2));
    var slPts = parseFloat((sc.close - sl).toFixed(2));
    if (!silent) console.log("[SCALP " + _ist + "] CE: BB zone + above CPR(" + cpr.tc + ") + RSI=" + rsi.toFixed(1) + " + SAR=" + sl + " + EMA" + EMA_PERIOD);
    return Object.assign({}, base, {
      signal: "BUY_CE", signalStrength: "SCALP",
      stopLoss: sl,
      target: null,
      slPts: slPts,
      reason: "CE: BB(" + bb.middle.toFixed(0) + "-" + bb.upper.toFixed(0) + ") + CPR(" + cpr.tc + ") + RSI=" + rsi.toFixed(0) + " + SAR=" + sl,
    });
  }

  // PE (Short): BB zone + below CPR + RSI + SAR + EMA + bearish momentum (2 candles)
  var bbShortZone = sc.close < bb.middle && sc.close > bb.lower;
  var belowCPR    = sc.close < cpr.bc - CPR_MIN_DIST;
  var sarAbove    = sar > sc.close;
  var rsiPE       = rsi < RSI_PE;
  var emaBearish  = ema ? sc.close < ema : true;
  var bearishMom  = isBearishCandle && (prevBearish || (prevCandle && sc.close < prevCandle.low));

  if (bbShortZone && belowCPR && sarAbove && rsiPE && emaBearish && bearishMom) {
    var sl = parseFloat(sar.toFixed(2));
    var slPts = parseFloat((sl - sc.close).toFixed(2));
    if (!silent) console.log("[SCALP " + _ist + "] PE: BB zone + below CPR(" + cpr.bc + ") + RSI=" + rsi.toFixed(1) + " + SAR=" + sl + " + EMA" + EMA_PERIOD);
    return Object.assign({}, base, {
      signal: "BUY_PE", signalStrength: "SCALP",
      stopLoss: sl,
      target: null,
      slPts: slPts,
      reason: "PE: BB(" + bb.lower.toFixed(0) + "-" + bb.middle.toFixed(0) + ") + CPR(" + cpr.bc + ") + RSI=" + rsi.toFixed(0) + " + SAR=" + sl,
    });
  }

  // No signal
  base.reason = "No setup";
  return base;
}

// ── PSAR Trailing SL update (called on each candle close while in position) ─
// Returns new SL value. Only tightens, never widens.
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
    // CE: SAR should be below price. Only tighten (move SL up).
    if (newSar > currentSL && newSar < candles[candles.length - 1].close) {
      return parseFloat(newSar.toFixed(2));
    }
  } else {
    // PE: SAR should be above price. Only tighten (move SL down).
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
    // CE: SAR was below, now flipped above → exit
    return prevSar < candles[candles.length - 2].close && currentSar > currentClose;
  } else {
    // PE: SAR was above, now flipped below → exit
    return prevSar > candles[candles.length - 2].close && currentSar < currentClose;
  }
}

function reset() { /* no pending state in this strategy */ }

module.exports = { NAME, DESCRIPTION, getSignal, updateTrailingSL, isPSARFlip, calcCPR, isNarrowCPR, reset };

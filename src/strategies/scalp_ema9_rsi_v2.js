/**
 * SCALP V2: EMA9 CROSS + SAR + RSI (3-min candles)
 *
 * Same core logic as Strategy 1 (85%+ win rate) adapted for 3-min:
 * - Strong candle crosses EMA9 (OHLC4)
 * - SAR confirms trend direction (SAR below=bullish, above=bearish)
 * - RSI confirms momentum
 * - Small SL (SAR-based, capped at 15pt for scalp)
 * - Small profits via trail + breakeven
 *
 * Window: 9:21 AM – 2:00 PM | Candle: 3-min
 */

const { EMA, RSI, PSAR, ATR } = require("technicalindicators");

const NAME        = "SCALP_EMA9_RSI_V2";
const DESCRIPTION = "3-min | EMA9 cross + SAR confirm + RSI + breakeven + trail";

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }

function isInTradingWindow(unixSec) {
  var d = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  if (totalMin < 561)  return { ok: false, reason: "Before 9:21 AM" };
  if (totalMin >= 840) return { ok: false, reason: "After 2:00 PM — no new scalp entries" };
  return { ok: true, reason: null };
}

function getSignal(candles, opts) {
  var silent = (opts && opts.silent === true);

  var SCALP_RSI_CE_MIN  = parseFloat(cfg("SCALP_RSI_CE_MIN", "52"));
  var SCALP_RSI_PE_MAX  = parseFloat(cfg("SCALP_RSI_PE_MAX", "48"));
  var SCALP_MIN_BODY    = parseFloat(cfg("SCALP_MIN_BODY", "5"));
  var SCALP_MIN_SLOPE   = parseFloat(cfg("SCALP_MIN_SLOPE", "1.5"));
  var SCALP_MIN_SAR_GAP = parseFloat(cfg("SCALP_MIN_SAR_GAP", "3"));
  var SCALP_MAX_SAR_GAP = parseFloat(cfg("SCALP_MAX_SAR_GAP", "15"));

  // ATR for target calculation
  var ATR_TGT_MULT      = parseFloat(cfg("SCALP_ATR_TGT_MULT", "2.0"));

  if (candles.length < 30) {
    return { signal: "NONE", reason: "Warming up (" + candles.length + "/30)", stopLoss: null, target: null, prevCandleHigh: null, prevCandleLow: null };
  }

  var signalCandle = candles[candles.length - 1];
  var windowCheck = isInTradingWindow(signalCandle.time);
  if (!windowCheck.ok) {
    return { signal: "NONE", reason: windowCheck.reason, stopLoss: null, target: null, prevCandleHigh: signalCandle.high, prevCandleLow: signalCandle.low };
  }

  // ── Indicators ──────────────────────────────────────────────────────────────
  var ohlc4  = candles.map(function(c) { return (c.open + c.high + c.low + c.close) / 4; });
  var closes = candles.map(function(c) { return c.close; });
  var highs  = candles.map(function(c) { return c.high; });
  var lows   = candles.map(function(c) { return c.low; });

  // EMA9 on OHLC4
  var ema9arr = EMA.calculate({ period: 9, values: ohlc4 });
  var ema9 = ema9arr[ema9arr.length - 1], ema9_1 = ema9arr[ema9arr.length - 2];
  var ema9Slope = parseFloat((ema9 - ema9_1).toFixed(2));

  // EMA20 trend filter
  var ema20arr = EMA.calculate({ period: 20, values: closes });
  var ema20 = ema20arr[ema20arr.length - 1];

  // RSI
  var rsiArr = RSI.calculate({ period: 14, values: closes });
  var rsi = rsiArr[rsiArr.length - 1];

  // SAR — trend direction + natural SL
  var sarArr = PSAR.calculate({ step: 0.02, max: 0.2, high: highs, low: lows });
  var sar = sarArr.length > 0 ? sarArr[sarArr.length - 1] : null;
  var sarBelow = sar !== null && sar < signalCandle.close;  // bullish
  var sarAbove = sar !== null && sar > signalCandle.close;  // bearish

  // ATR for target
  var atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  var atr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : 10;

  // ── EMA9 cross detection ────────────────────────────────────────────────────
  var crossedAbove = signalCandle.low <= ema9 && signalCandle.close > ema9;
  var crossedBelow = signalCandle.high >= ema9 && signalCandle.close < ema9;

  var trendBullish = signalCandle.close > ema20;
  var trendBearish = signalCandle.close < ema20;
  var candleBody = Math.abs(signalCandle.close - signalCandle.open);
  var isBullishBody = signalCandle.close > signalCandle.open && candleBody >= SCALP_MIN_BODY;
  var isBearishBody = signalCandle.close < signalCandle.open && candleBody >= SCALP_MIN_BODY;

  // ── SAR-based SL ────────────────────────────────────────────────────────────
  var sarGapCE = sar !== null ? parseFloat((signalCandle.close - sar).toFixed(2)) : 999;
  var sarGapPE = sar !== null ? parseFloat((sar - signalCandle.close).toFixed(2)) : 999;

  // Log
  var _ist = new Date(signalCandle.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  if (!silent) console.log("[SCALP_V2 " + _ist + "] EMA9=" + ema9.toFixed(1) + "(slope=" + ema9Slope + ") EMA20=" + ema20.toFixed(1) + " SAR=" + (sar||0).toFixed(1) + (sarBelow?"↑":"↓") + " | RSI=" + rsi.toFixed(1) + " | ATR=" + atr.toFixed(1) + " | body=" + candleBody.toFixed(1) + " | C=" + signalCandle.close);

  var base = { ema9: parseFloat(ema9.toFixed(2)), ema9Prev: parseFloat(ema9_1.toFixed(2)), ema9Slope: ema9Slope, ema20: parseFloat(ema20.toFixed(2)), trendBullish: trendBullish, trendBearish: trendBearish, rsi: parseFloat(rsi.toFixed(1)), atr: parseFloat(atr.toFixed(2)), sar: sar !== null ? parseFloat(sar.toFixed(2)) : null, sarBelow: sarBelow, sarAbove: sarAbove, prevCandleHigh: signalCandle.high, prevCandleLow: signalCandle.low, stopLoss: null, target: null, slPts: 0, tgtPts: 0 };

  // ── BUY CE ──────────────────────────────────────────────────────────────────
  if (crossedAbove && isBullishBody && ema9Slope >= SCALP_MIN_SLOPE) {
    // SAR must be BELOW price (bullish trend)
    if (!sarBelow) {
      if (!silent) console.log("  ❌ SCALP CE: SAR=" + (sar||0).toFixed(1) + " above price (bearish)");
      return Object.assign({}, base, { signal: "NONE", reason: "CE: SAR above price — against trend" });
    }
    // EMA20 trend
    if (!trendBullish) {
      if (!silent) console.log("  ❌ SCALP CE: below EMA20");
      return Object.assign({}, base, { signal: "NONE", reason: "CE: below EMA20" });
    }
    // SAR gap check (SL = distance to SAR, must be 5-15pt for scalp)
    if (sarGapCE < SCALP_MIN_SAR_GAP ) {
      if (!silent) console.log("  ❌ SCALP CE: SAR gap " + sarGapCE + "pt < " + SCALP_MIN_SAR_GAP + " (too close)");
      return Object.assign({}, base, { signal: "NONE", reason: "CE: SAR too close" });
    }
    // RSI
    if (rsi <= SCALP_RSI_CE_MIN) {
      if (!silent) console.log("  ❌ SCALP CE: RSI=" + rsi.toFixed(1) + " <= " + SCALP_RSI_CE_MIN);
      return Object.assign({}, base, { signal: "NONE", reason: "CE: RSI=" + rsi.toFixed(1) + " too low" });
    }

    var rawSarGap = sarGapCE;
    var cappedGap = Math.min(rawSarGap, SCALP_MAX_SAR_GAP);
    var ceSL = parseFloat((signalCandle.close - cappedGap).toFixed(2));  // SL capped
    var slPts = cappedGap;
    var tgtPts = Math.max(Math.round(atr * ATR_TGT_MULT), Math.round(slPts * 1.5));
    var ceTgt = parseFloat((signalCandle.close + tgtPts).toFixed(2));
    if (!silent) console.log("  🟢 SCALP BUY_CE — SL=" + ceSL + "(" + slPts + "pt) TGT=" + ceTgt + "(" + tgtPts + "pt)");
    return Object.assign({}, base, { signal: "BUY_CE", signalStrength: "SCALP", stopLoss: ceSL, target: ceTgt, slPts: slPts, tgtPts: tgtPts, reason: "EMA9 cross + SAR below + RSI=" + rsi.toFixed(1) + " | SL=" + slPts + "pt TGT=" + tgtPts + "pt" });
  }

  // ── BUY PE ──────────────────────────────────────────────────────────────────
  if (crossedBelow && isBearishBody && ema9Slope <= -SCALP_MIN_SLOPE) {
    if (!sarAbove) {
      if (!silent) console.log("  ❌ SCALP PE: SAR=" + (sar||0).toFixed(1) + " below price (bullish)");
      return Object.assign({}, base, { signal: "NONE", reason: "PE: SAR below price — against trend" });
    }
    if (!trendBearish) {
      if (!silent) console.log("  ❌ SCALP PE: above EMA20");
      return Object.assign({}, base, { signal: "NONE", reason: "PE: above EMA20" });
    }
    if (sarGapPE < SCALP_MIN_SAR_GAP ) {
      if (!silent) console.log("  ❌ SCALP PE: SAR gap " + sarGapPE + "pt < " + SCALP_MIN_SAR_GAP + " (too close)");
      return Object.assign({}, base, { signal: "NONE", reason: "PE: SAR too close" });
    }
    if (rsi >= SCALP_RSI_PE_MAX) {
      if (!silent) console.log("  ❌ SCALP PE: RSI=" + rsi.toFixed(1) + " >= " + SCALP_RSI_PE_MAX);
      return Object.assign({}, base, { signal: "NONE", reason: "PE: RSI=" + rsi.toFixed(1) + " too high" });
    }

    var rawSarGap = sarGapPE;
    var cappedGap = Math.min(rawSarGap, SCALP_MAX_SAR_GAP);
    var peSL = parseFloat((signalCandle.close + cappedGap).toFixed(2));  // SL capped
    var slPts = cappedGap;
    var tgtPts = Math.max(Math.round(atr * ATR_TGT_MULT), Math.round(slPts * 1.5));
    var peTgt = parseFloat((signalCandle.close - tgtPts).toFixed(2));
    if (!silent) console.log("  🔴 SCALP BUY_PE — SL=" + peSL + "(" + slPts + "pt) TGT=" + peTgt + "(" + tgtPts + "pt)");
    return Object.assign({}, base, { signal: "BUY_PE", signalStrength: "SCALP", stopLoss: peSL, target: peTgt, slPts: slPts, tgtPts: tgtPts, reason: "EMA9 cross + SAR above + RSI=" + rsi.toFixed(1) + " | SL=" + slPts + "pt TGT=" + tgtPts + "pt" });
  }

  var nr = !crossedAbove && !crossedBelow ? "No EMA9 cross" : crossedAbove ? "CE cross but gates failed" : "PE cross but gates failed";
  return Object.assign({}, base, { signal: "NONE", reason: nr + " | RSI=" + rsi.toFixed(1) + " | SAR=" + (sar||0).toFixed(1) });
}

function reset() {}
module.exports = { NAME, DESCRIPTION, getSignal, reset };
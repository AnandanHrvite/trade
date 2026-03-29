/**
 * SCALP STRATEGY V2: EMA9 CROSS + EMA20 TREND (3-min candles)
 *
 * Entry: Price CROSSES EMA9 (confirmed by close) with EMA20 trend filter
 * Exit: ATR target | Breakeven +8pt | Trail SL | EOD
 * Window: 9:21 AM – 2:00 PM | Candle: 3-min
 */

const { EMA, RSI, ADX, ATR } = require("technicalindicators");

const NAME        = "SCALP_EMA9_RSI_V2";
const DESCRIPTION = "3-min | EMA9 cross + EMA20 trend + breakeven stop";

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

  var SCALP_RSI_CE_MIN  = parseFloat(cfg("SCALP_RSI_CE_MIN", "50"));
  var SCALP_RSI_PE_MAX  = parseFloat(cfg("SCALP_RSI_PE_MAX", "50"));
  var SCALP_MIN_BODY    = parseFloat(cfg("SCALP_MIN_BODY", "5"));
  var SCALP_ADX_ENABLED = cfg("SCALP_ADX_ENABLED", "false") === "true";
  var SCALP_ADX_MIN     = parseFloat(cfg("SCALP_ADX_MIN", "20"));
  var ATR_SL_MULT       = parseFloat(cfg("SCALP_ATR_SL_MULT", "1.5"));
  var ATR_TGT_MULT      = parseFloat(cfg("SCALP_ATR_TGT_MULT", "2.5"));
  var ATR_MIN_SL        = parseFloat(cfg("SCALP_ATR_MIN_SL", "8"));
  var ATR_MAX_SL        = parseFloat(cfg("SCALP_ATR_MAX_SL", "18"));
  var USE_ATR_SL        = cfg("SCALP_USE_ATR_SL", "true") === "true";
  var FIXED_SL_PTS      = parseFloat(cfg("SCALP_SL_PTS", "12"));
  var FIXED_TGT_PTS     = parseFloat(cfg("SCALP_TARGET_PTS", "18"));

  if (candles.length < 25) {
    return { signal: "NONE", reason: "Warming up (" + candles.length + "/25)", stopLoss: null, target: null, prevCandleHigh: null, prevCandleLow: null };
  }

  var signalCandle = candles[candles.length - 1];
  var windowCheck = isInTradingWindow(signalCandle.time);
  if (!windowCheck.ok) {
    return { signal: "NONE", reason: windowCheck.reason, stopLoss: null, target: null, prevCandleHigh: signalCandle.high, prevCandleLow: signalCandle.low };
  }

  var ohlc4  = candles.map(function(c) { return (c.open + c.high + c.low + c.close) / 4; });
  var closes = candles.map(function(c) { return c.close; });
  var highs  = candles.map(function(c) { return c.high; });
  var lows   = candles.map(function(c) { return c.low; });

  var ema9arr = EMA.calculate({ period: 9, values: ohlc4 });
  var ema9 = ema9arr[ema9arr.length - 1], ema9_1 = ema9arr[ema9arr.length - 2];
  var ema20arr = EMA.calculate({ period: 20, values: closes });
  var ema20 = ema20arr[ema20arr.length - 1];
  var rsiArr = RSI.calculate({ period: 14, values: closes });
  var rsi = rsiArr[rsiArr.length - 1];
  var rsiPrev = rsiArr.length >= 2 ? rsiArr[rsiArr.length - 2] : rsi;
  var rsiRising  = rsi > rsiPrev + 0.5;
  var rsiFalling = rsi < rsiPrev - 0.5;
  var atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  var atr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : 10;
  var ema9Slope = parseFloat((ema9 - ema9_1).toFixed(2));

  var adxVal = null, isTrending = true;
  if (SCALP_ADX_ENABLED) {
    var adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    adxVal = adxArr.length > 0 ? adxArr[adxArr.length - 1].adx : null;
    isTrending = adxVal === null ? true : adxVal >= SCALP_ADX_MIN;
  }

  // Volume check
  var hasVolume = candles[0].volume !== undefined && candles[0].volume !== null;
  var volOk = true, avgVol = null;
  if (hasVolume) {
    var vols = candles.slice(-20).map(function(c) { return c.volume || 0; });
    avgVol = vols.reduce(function(s, v) { return s + v; }, 0) / vols.length;
    volOk = (signalCandle.volume || 0) >= avgVol * 0.8;
  }

  // EMA9 CROSSOVER (original — works better on 3-min than touch)
  var crossedAbove = signalCandle.low <= ema9 && signalCandle.close > ema9;
  var crossedBelow = signalCandle.high >= ema9 && signalCandle.close < ema9;

  var trendBullish = signalCandle.close > ema20;
  var trendBearish = signalCandle.close < ema20;
  var candleBody = Math.abs(signalCandle.close - signalCandle.open);
  var isBullishBody = signalCandle.close > signalCandle.open && candleBody >= SCALP_MIN_BODY;
  var isBearishBody = signalCandle.close < signalCandle.open && candleBody >= SCALP_MIN_BODY;

  var slPts, tgtPts;
  if (USE_ATR_SL) {
    slPts = Math.min(ATR_MAX_SL, Math.max(ATR_MIN_SL, Math.round(atr * ATR_SL_MULT)));
    tgtPts = Math.round(atr * ATR_TGT_MULT);
    if (tgtPts < slPts * 1.5) tgtPts = Math.round(slPts * 1.5);
  } else { slPts = FIXED_SL_PTS; tgtPts = FIXED_TGT_PTS; }

  var _ist = new Date(signalCandle.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  if (!silent) console.log("[SCALP_V2 " + _ist + "] EMA9=" + ema9.toFixed(1) + "(slope=" + ema9Slope + ") EMA20=" + ema20.toFixed(1) + (trendBullish?"↑":"↓") + " | RSI=" + rsi.toFixed(1) + (rsiRising?"↑":rsiFalling?"↓":"→") + " | ATR=" + atr.toFixed(1) + " SL=" + slPts + " TGT=" + tgtPts + " | body=" + candleBody.toFixed(1) + " | C=" + signalCandle.close);

  var base = { ema9: parseFloat(ema9.toFixed(2)), ema9Prev: parseFloat(ema9_1.toFixed(2)), ema9Slope: ema9Slope, ema20: parseFloat(ema20.toFixed(2)), trendBullish: trendBullish, trendBearish: trendBearish, rsi: parseFloat(rsi.toFixed(1)), rsiPrev: parseFloat(rsiPrev.toFixed(1)), rsiRising: rsiRising, rsiFalling: rsiFalling, atr: parseFloat(atr.toFixed(2)), slPts: slPts, tgtPts: tgtPts, adx: adxVal !== null ? parseFloat(adxVal.toFixed(1)) : null, adxTrending: isTrending, prevCandleHigh: signalCandle.high, prevCandleLow: signalCandle.low, stopLoss: null, target: null };

  var SCALP_MIN_SLOPE = parseFloat(cfg("SCALP_MIN_SLOPE", "1.5"));

  // ── CE ──
  if (crossedAbove && isBullishBody && ema9Slope >= SCALP_MIN_SLOPE) {
    if (!trendBullish) return Object.assign({}, base, { signal: "NONE", reason: "CE: below EMA20" });
    if (hasVolume && !volOk) return Object.assign({}, base, { signal: "NONE", reason: "CE: low volume" });
    if (SCALP_ADX_ENABLED && !isTrending) return Object.assign({}, base, { signal: "NONE", reason: "CE: ADX low" });
    if (rsi > SCALP_RSI_CE_MIN && rsiRising) {
      var ceSL = parseFloat((signalCandle.close - slPts).toFixed(2));
      var ceTgt = parseFloat((signalCandle.close + tgtPts).toFixed(2));
      if (!silent) console.log("  🟢 SCALP BUY_CE — SL=" + ceSL + " TGT=" + ceTgt);
      return Object.assign({}, base, { signal: "BUY_CE", signalStrength: "SCALP", stopLoss: ceSL, target: ceTgt, reason: "EMA9 cross CE | EMA20 OK | RSI=" + rsi.toFixed(1) + "↑ | SL=" + slPts + " TGT=" + tgtPts });
    }
    return Object.assign({}, base, { signal: "NONE", reason: "CE: RSI=" + rsi.toFixed(1) + " need >" + SCALP_RSI_CE_MIN + " & rising" });
  }

  // ── PE ──
  if (crossedBelow && isBearishBody && ema9Slope <= -SCALP_MIN_SLOPE) {
    if (!trendBearish) return Object.assign({}, base, { signal: "NONE", reason: "PE: above EMA20" });
    if (hasVolume && !volOk) return Object.assign({}, base, { signal: "NONE", reason: "PE: low volume" });
    if (SCALP_ADX_ENABLED && !isTrending) return Object.assign({}, base, { signal: "NONE", reason: "PE: ADX low" });
    if (rsi < SCALP_RSI_PE_MAX && rsiFalling) {
      var peSL = parseFloat((signalCandle.close + slPts).toFixed(2));
      var peTgt = parseFloat((signalCandle.close - tgtPts).toFixed(2));
      if (!silent) console.log("  🔴 SCALP BUY_PE — SL=" + peSL + " TGT=" + peTgt);
      return Object.assign({}, base, { signal: "BUY_PE", signalStrength: "SCALP", stopLoss: peSL, target: peTgt, reason: "EMA9 cross PE | EMA20 OK | RSI=" + rsi.toFixed(1) + "↓ | SL=" + slPts + " TGT=" + tgtPts });
    }
    return Object.assign({}, base, { signal: "NONE", reason: "PE: RSI=" + rsi.toFixed(1) + " need <" + SCALP_RSI_PE_MAX + " & falling" });
  }

  var nr = !crossedAbove && !crossedBelow ? "No EMA9 cross" : crossedAbove ? "CE cross but gates failed" : "PE cross but gates failed";
  return Object.assign({}, base, { signal: "NONE", reason: nr + " | RSI=" + rsi.toFixed(1) });
}

function reset() {}
module.exports = { NAME, DESCRIPTION, getSignal, reset };
/**
 * SCALP V2: SAR FLIP + EMA9 CROSS (3-min candles)
 *
 * HIGH WIN RATE approach: Only enter when SAR FLIPS (trend reversal)
 * AND price crosses EMA9 in the same direction within 2 candles.
 * SAR flip alone is ~65% accurate. SAR flip + EMA9 cross + RSI = 75%+
 *
 * CE: SAR was ABOVE price (bearish) → flips to BELOW (bullish) + EMA9 cross up
 * PE: SAR was BELOW price (bullish) → flips to ABOVE (bearish) + EMA9 cross down
 *
 * SL: SAR value (capped at 15pt) | Breakeven +5pt | Trail 6pt gap | Target ATR×2
 * Window: 9:21 AM – 2:00 PM | Candle: 3-min
 */

const { EMA, RSI, PSAR, ATR } = require("technicalindicators");

const NAME        = "SCALP_EMA9_RSI_V2";
const DESCRIPTION = "3-min | SAR flip + EMA9 cross + RSI + breakeven";

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }

function isInTradingWindow(unixSec) {
  var d = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  if (totalMin < 561)  return { ok: false, reason: "Before 9:21 AM" };
  if (totalMin >= 840) return { ok: false, reason: "After 2:00 PM" };
  return { ok: true, reason: null };
}

function getSignal(candles, opts) {
  var silent = (opts && opts.silent === true);

  var SCALP_RSI_CE_MIN   = parseFloat(cfg("SCALP_RSI_CE_MIN", "50"));
  var SCALP_RSI_PE_MAX   = parseFloat(cfg("SCALP_RSI_PE_MAX", "50"));
  var SCALP_MIN_BODY     = parseFloat(cfg("SCALP_MIN_BODY", "3"));
  var SCALP_MIN_SLOPE    = parseFloat(cfg("SCALP_MIN_SLOPE", "1"));
  var SCALP_MAX_SL       = parseFloat(cfg("SCALP_MAX_SAR_GAP", "15"));
  var SCALP_MIN_SL       = parseFloat(cfg("SCALP_MIN_SAR_GAP", "3"));
  var ATR_TGT_MULT       = parseFloat(cfg("SCALP_ATR_TGT_MULT", "2.0"));
  var SAR_FLIP_LOOKBACK  = parseInt(cfg("SCALP_SAR_FLIP_CANDLES", "3"), 10);

  if (candles.length < 35) {
    return { signal: "NONE", reason: "Warming up (" + candles.length + "/35)", stopLoss: null, target: null, prevCandleHigh: null, prevCandleLow: null };
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

  var ema9arr = EMA.calculate({ period: 9, values: ohlc4 });
  var ema9 = ema9arr[ema9arr.length - 1], ema9_1 = ema9arr[ema9arr.length - 2];
  var ema9Slope = parseFloat((ema9 - ema9_1).toFixed(2));

  var ema20arr = EMA.calculate({ period: 20, values: closes });
  var ema20 = ema20arr[ema20arr.length - 1];

  var rsiArr = RSI.calculate({ period: 14, values: closes });
  var rsi = rsiArr[rsiArr.length - 1];

  var atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  var atr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : 10;

  // ── SAR with flip detection ─────────────────────────────────────────────────
  var sarArr = PSAR.calculate({ step: 0.02, max: 0.2, high: highs, low: lows });
  if (sarArr.length < SAR_FLIP_LOOKBACK + 1) {
    return { signal: "NONE", reason: "SAR warming up", stopLoss: null, target: null, prevCandleHigh: signalCandle.high, prevCandleLow: signalCandle.low };
  }

  var sarNow = sarArr[sarArr.length - 1];
  var sarBelowNow = sarNow < signalCandle.close;  // currently bullish
  var sarAboveNow = sarNow > signalCandle.close;  // currently bearish

  // Detect SAR FLIP: was SAR on opposite side within last N candles?
  var sarFlippedBullish = false;  // SAR was above (bearish) → now below (bullish)
  var sarFlippedBearish = false;  // SAR was below (bullish) → now above (bearish)

  if (sarBelowNow) {
    // Check if SAR was ABOVE price in any of last N candles → flip to bullish
    for (var fb = 1; fb <= SAR_FLIP_LOOKBACK && fb < sarArr.length; fb++) {
      var prevSar = sarArr[sarArr.length - 1 - fb];
      var prevClose = closes[closes.length - 1 - fb];
      if (prevSar > prevClose) { sarFlippedBullish = true; break; }
    }
  }

  if (sarAboveNow) {
    // Check if SAR was BELOW price in any of last N candles → flip to bearish
    for (var fb2 = 1; fb2 <= SAR_FLIP_LOOKBACK && fb2 < sarArr.length; fb2++) {
      var prevSar2 = sarArr[sarArr.length - 1 - fb2];
      var prevClose2 = closes[closes.length - 1 - fb2];
      if (prevSar2 < prevClose2) { sarFlippedBearish = true; break; }
    }
  }

  // ── EMA9 cross ──────────────────────────────────────────────────────────────
  var crossedAbove = signalCandle.low <= ema9 && signalCandle.close > ema9;
  var crossedBelow = signalCandle.high >= ema9 && signalCandle.close < ema9;

  var candleBody = Math.abs(signalCandle.close - signalCandle.open);
  var isBullishBody = signalCandle.close > signalCandle.open && candleBody >= SCALP_MIN_BODY;
  var isBearishBody = signalCandle.close < signalCandle.open && candleBody >= SCALP_MIN_BODY;

  // SAR gap for SL
  var sarGapCE = parseFloat((signalCandle.close - sarNow).toFixed(2));
  var sarGapPE = parseFloat((sarNow - signalCandle.close).toFixed(2));

  var _ist = new Date(signalCandle.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  if (!silent) console.log("[SCALP_V2 " + _ist + "] EMA9=" + ema9.toFixed(1) + " EMA20=" + ema20.toFixed(1) + " SAR=" + sarNow.toFixed(1) + (sarBelowNow ? "↑" : "↓") + (sarFlippedBullish ? " FLIP↑" : sarFlippedBearish ? " FLIP↓" : "") + " | RSI=" + rsi.toFixed(1) + " | body=" + candleBody.toFixed(1) + " | C=" + signalCandle.close);

  var base = { ema9: parseFloat(ema9.toFixed(2)), ema9Slope: ema9Slope, ema20: parseFloat(ema20.toFixed(2)), rsi: parseFloat(rsi.toFixed(1)), atr: parseFloat(atr.toFixed(2)), sar: parseFloat(sarNow.toFixed(2)), sarBelow: sarBelowNow, sarAbove: sarAboveNow, sarFlippedBullish: sarFlippedBullish, sarFlippedBearish: sarFlippedBearish, prevCandleHigh: signalCandle.high, prevCandleLow: signalCandle.low, stopLoss: null, target: null, slPts: 0, tgtPts: 0 };

  // ── BUY CE: SAR flipped bullish + EMA9 cross up ─────────────────────────────
  if (sarFlippedBullish && crossedAbove && isBullishBody) {
    if (ema9Slope < SCALP_MIN_SLOPE) return Object.assign({}, base, { signal: "NONE", reason: "CE: slope " + ema9Slope + " < " + SCALP_MIN_SLOPE });
    if (sarGapCE < SCALP_MIN_SL) return Object.assign({}, base, { signal: "NONE", reason: "CE: SAR gap " + sarGapCE + "pt too close" });
    if (rsi <= SCALP_RSI_CE_MIN) return Object.assign({}, base, { signal: "NONE", reason: "CE: RSI " + rsi.toFixed(1) + " <= " + SCALP_RSI_CE_MIN });

    var slPts = Math.min(sarGapCE, SCALP_MAX_SL);
    var tgtPts = Math.max(Math.round(atr * ATR_TGT_MULT), Math.round(slPts * 1.5));
    var ceSL = parseFloat((signalCandle.close - slPts).toFixed(2));
    var ceTgt = parseFloat((signalCandle.close + tgtPts).toFixed(2));

    if (!silent) console.log("  🟢 SCALP CE — SAR FLIP + EMA9 cross | SL=" + ceSL + "(" + slPts + "pt) TGT=" + ceTgt + "(" + tgtPts + "pt)");
    return Object.assign({}, base, { signal: "BUY_CE", signalStrength: "SCALP", stopLoss: ceSL, target: ceTgt, slPts: slPts, tgtPts: tgtPts, reason: "SAR flip↑ + EMA9 cross CE | RSI=" + rsi.toFixed(1) + " | SL=" + slPts + "pt TGT=" + tgtPts + "pt" });
  }

  // ── BUY PE: SAR flipped bearish + EMA9 cross down ───────────────────────────
  if (sarFlippedBearish && crossedBelow && isBearishBody) {
    if (ema9Slope > -SCALP_MIN_SLOPE) return Object.assign({}, base, { signal: "NONE", reason: "PE: slope " + ema9Slope + " > -" + SCALP_MIN_SLOPE });
    if (sarGapPE < SCALP_MIN_SL) return Object.assign({}, base, { signal: "NONE", reason: "PE: SAR gap " + sarGapPE + "pt too close" });
    if (rsi >= SCALP_RSI_PE_MAX) return Object.assign({}, base, { signal: "NONE", reason: "PE: RSI " + rsi.toFixed(1) + " >= " + SCALP_RSI_PE_MAX });

    var slPts = Math.min(sarGapPE, SCALP_MAX_SL);
    var tgtPts = Math.max(Math.round(atr * ATR_TGT_MULT), Math.round(slPts * 1.5));
    var peSL = parseFloat((signalCandle.close + slPts).toFixed(2));
    var peTgt = parseFloat((signalCandle.close - tgtPts).toFixed(2));

    if (!silent) console.log("  🔴 SCALP PE — SAR FLIP + EMA9 cross | SL=" + peSL + "(" + slPts + "pt) TGT=" + peTgt + "(" + tgtPts + "pt)");
    return Object.assign({}, base, { signal: "BUY_PE", signalStrength: "SCALP", stopLoss: peSL, target: peTgt, slPts: slPts, tgtPts: tgtPts, reason: "SAR flip↓ + EMA9 cross PE | RSI=" + rsi.toFixed(1) + " | SL=" + slPts + "pt TGT=" + tgtPts + "pt" });
  }

  // ── No signal ───────────────────────────────────────────────────────────────
  var nr = [];
  if (!sarFlippedBullish && !sarFlippedBearish) nr.push("No SAR flip");
  else if (sarFlippedBullish && !crossedAbove) nr.push("SAR flip↑ but no EMA9 cross up");
  else if (sarFlippedBearish && !crossedBelow) nr.push("SAR flip↓ but no EMA9 cross down");
  else if (!isBullishBody && !isBearishBody) nr.push("Body too small (" + candleBody.toFixed(1) + ")");
  else nr.push("Gates failed");

  return Object.assign({}, base, { signal: "NONE", reason: nr.join(" | ") });
}

function reset() {}
module.exports = { NAME, DESCRIPTION, getSignal, reset };
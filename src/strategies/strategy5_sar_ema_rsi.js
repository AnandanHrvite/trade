/**
 * STRATEGY 5: Parabolic SAR Flip + EMA 9 (OHLC4) Slope + RSI 52/48
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Replicates this TradingView setup:
 *   - EMA 9  with OHLC4 source: (O+H+L+C)/4
 *   - Parabolic SAR  0.02 / 0.02 / 0.2
 *   - RSI 14 (on close price)
 *
 * ENTRY — all 3 must align on the same candle:
 *   BUY CE: SAR flips ABOVE->BELOW price + EMA9 rising + RSI > 52
 *   BUY PE: SAR flips BELOW->ABOVE price + EMA9 falling + RSI < 48
 *
 * EXIT — whichever fires first:
 *   1. Intra-candle breach: PE → current candle HIGH > prev candle HIGH (exit at tick)
 *                           CE → current candle LOW  < prev candle LOW  (exit at tick)
 *   2. SAR stoploss (candle close): CE closes below SAR / PE closes above SAR
 *   3. EOD 3:20 PM square-off
 *
 * Time: 9:30 AM – 3:00 PM IST | Timeframe: 5-min
 */

const { EMA, RSI } = require("technicalindicators");

const NAME        = "SAR_EMA9_RSI";
const DESCRIPTION = "SAR flip trigger | EMA9(OHLC4) + RSI 52/48 | Intra-candle breach exit + SAR SL | 9:30-3PM";

// Parabolic SAR (step=0.02, max=0.2)
function calcSAR(candles, step, max) {
  step = step || 0.02;
  max  = max  || 0.2;
  if (candles.length < 3) return [];

  var result = [];
  var trend  = 1;
  var sar    = candles[0].low;
  var ep     = candles[0].high;
  var af     = step;

  for (var i = 1; i < candles.length; i++) {
    var prev   = candles[i - 1];
    var curr   = candles[i];
    var newSar = sar + af * (ep - sar);

    if (trend === 1) {
      newSar = Math.min(newSar, prev.low, i >= 2 ? candles[i-2].low : prev.low);
      if (curr.low < newSar) {
        trend = -1; newSar = ep; ep = curr.low; af = step;
      } else {
        if (curr.high > ep) { ep = curr.high; af = Math.min(af + step, max); }
      }
    } else {
      newSar = Math.max(newSar, prev.high, i >= 2 ? candles[i-2].high : prev.high);
      if (curr.high > newSar) {
        trend = 1; newSar = ep; ep = curr.high; af = step;
      } else {
        if (curr.low < ep) { ep = curr.low; af = Math.min(af + step, max); }
      }
    }
    sar = newSar;
    result.push({ sar: parseFloat(sar.toFixed(2)), trend: trend });
  }
  return result;
}

function isInTradingWindow(unixSec) {
  var d        = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  return totalMin >= 570 && totalMin < 900;
}

function getSignal(candles) {
  if (candles.length < 30) {
    return { signal: "NONE", reason: "Warming up (" + candles.length + "/30 candles)", stopLoss: null, prevCandleHigh: null, prevCandleLow: null };
  }

  var lastCandle = candles[candles.length - 1];
  var prevCandle = candles[candles.length - 2];

  if (!isInTradingWindow(lastCandle.time)) {
    return { signal: "NONE", reason: "Outside 9:30 AM - 3:00 PM window", stopLoss: null, prevCandleHigh: prevCandle.high, prevCandleLow: prevCandle.low };
  }

  // EMA 9 on OHLC4
  var ohlc4  = candles.map(function(c) { return (c.open + c.high + c.low + c.close) / 4; });
  var closes = candles.map(function(c) { return c.close; });

  var ema9arr   = EMA.calculate({ period: 9, values: ohlc4 });
  var currEma9  = ema9arr[ema9arr.length - 1];
  var prevEma9  = ema9arr[ema9arr.length - 2];
  var ema9Up    = currEma9 > prevEma9;
  var ema9Down  = currEma9 < prevEma9;

  var rsiArr = RSI.calculate({ period: 14, values: closes });
  var rsi    = rsiArr[rsiArr.length - 1];

  var sarArr  = calcSAR(candles);
  var currSAR = sarArr[sarArr.length - 1];
  var prevSAR = sarArr[sarArr.length - 2];

  if (!currSAR || !prevSAR) {
    return { signal: "NONE", reason: "SAR not ready", stopLoss: null, prevCandleHigh: prevCandle.high, prevCandleLow: prevCandle.low };
  }

  var sarFlippedBull = prevSAR.trend === -1 && currSAR.trend === 1;
  var sarFlippedBear = prevSAR.trend === 1  && currSAR.trend === -1;

  var base = {
    ema9:           currEma9,
    rsi:            rsi,
    sar:            currSAR.sar,
    sarTrend:       currSAR.trend === 1 ? "BULLISH" : "BEARISH",
    prevCandleHigh: prevCandle.high,
    prevCandleLow:  prevCandle.low,
    stopLoss:       currSAR.sar,
  };

  if (sarFlippedBull && ema9Up && rsi > 52) {
    return Object.assign({}, base, {
      signal: "BUY_CE",
      reason: "SAR->BULL [TRIGGER] | EMA9 rising " + prevEma9.toFixed(1) + "->" + currEma9.toFixed(1) + " | RSI " + rsi.toFixed(1) + " > 52 | SL: " + currSAR.sar,
    });
  }

  if (sarFlippedBear && ema9Down && rsi < 48) {
    return Object.assign({}, base, {
      signal: "BUY_PE",
      reason: "SAR->BEAR [TRIGGER] | EMA9 falling " + prevEma9.toFixed(1) + "->" + currEma9.toFixed(1) + " | RSI " + rsi.toFixed(1) + " < 48 | SL: " + currSAR.sar,
    });
  }

  var missing = [];
  if (!sarFlippedBull && !sarFlippedBear) {
    missing.push("No SAR flip (" + (currSAR.trend === 1 ? "BULL" : "BEAR") + ")");
  } else if (sarFlippedBull) {
    if (!ema9Up)   missing.push("EMA9 not rising");
    if (rsi <= 52) missing.push("RSI " + rsi.toFixed(1) + " <= 52");
  } else {
    if (!ema9Down) missing.push("EMA9 not falling");
    if (rsi >= 48) missing.push("RSI " + rsi.toFixed(1) + " >= 48");
  }

  return Object.assign({}, base, {
    signal: "NONE",
    reason: "EMA9:" + currEma9.toFixed(1) + " RSI:" + rsi.toFixed(1) + " SAR:" + currSAR.sar + "(" + (currSAR.trend === 1 ? "UP" : "DN") + ") | " + (missing.join(" | ") || "Watching"),
  });
}

module.exports = { NAME: NAME, DESCRIPTION: DESCRIPTION, getSignal: getSignal };

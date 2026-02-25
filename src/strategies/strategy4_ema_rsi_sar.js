/**
 * STRATEGY 4: EMA 9/20 + RSI + Parabolic SAR with Candle-Based Stoploss
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ENTRY CONDITIONS:
 *
 *   BUY CE:
 *     TRIGGER : EMA 9 crosses ABOVE EMA 20 on this candle
 *     CONFIRM : RSI > 51  (just needs to be in bullish zone, not cross)
 *     CONFIRM : Parabolic SAR is below price  (zone check only)
 *
 *   BUY PE:
 *     TRIGGER : EMA 9 crosses BELOW EMA 20 on this candle
 *     CONFIRM : RSI < 49  (just needs to be in bearish zone, not cross)
 *     CONFIRM : Parabolic SAR is above price  (zone check only)
 *
 * TIME FILTER:
 *   Only trade between 9:30 AM – 3:00 PM IST
 *
 * STOPLOSS (candle-close based):
 *   CE trade → SL = low of candle 2 bars prior to entry
 *   PE trade → SL = high of candle 2 bars prior to entry
 *   Exit when candle CLOSES below/above SL (not on intra-candle touch)
 *
 * ADDITIONAL EXIT:
 *   Opposite EMA crossover signal also exits current position
 *
 * TIMEFRAME: 5-min candles
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { EMA, RSI } = require("technicalindicators");

const NAME        = "EMA_RSI_SAR";
const DESCRIPTION = "EMA 9/20 crossover triggers | RSI>51/<49 + SAR confirm zone | SL=2-candle prior close | 9:30–3PM";

// ── Parabolic SAR (manual implementation — not in technicalindicators cleanly) ──
/**
 * Calculate Parabolic SAR
 * @param {Array} candles  - full candle array { high, low, close }
 * @param {number} step    - acceleration factor step (default 0.02)
 * @param {number} max     - max acceleration factor (default 0.2)
 * @returns {Array}        - array of { sar, trend } — trend: 1=bullish, -1=bearish
 */
function calcSAR(candles, step = 0.02, max = 0.2) {
  if (candles.length < 3) return [];

  const result = [];
  let trend  = 1;               // 1 = bullish, -1 = bearish
  let sar    = candles[0].low;  // initial SAR
  let ep     = candles[0].high; // extreme point
  let af     = step;            // acceleration factor

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];

    // Calculate new SAR
    let newSar = sar + af * (ep - sar);

    if (trend === 1) {
      // Bullish — SAR must be below prev 2 candle lows
      newSar = Math.min(newSar, prev.low, i >= 2 ? candles[i - 2].low : prev.low);

      if (curr.low < newSar) {
        // Trend reversal to bearish
        trend  = -1;
        newSar = ep;       // SAR flips to prior extreme high
        ep     = curr.low;
        af     = step;
      } else {
        // Continue bullish
        if (curr.high > ep) {
          ep = curr.high;
          af = Math.min(af + step, max);
        }
      }
    } else {
      // Bearish — SAR must be above prev 2 candle highs
      newSar = Math.max(newSar, prev.high, i >= 2 ? candles[i - 2].high : prev.high);

      if (curr.high > newSar) {
        // Trend reversal to bullish
        trend  = 1;
        newSar = ep;       // SAR flips to prior extreme low
        ep     = curr.high;
        af     = step;
      } else {
        // Continue bearish
        if (curr.low < ep) {
          ep = curr.low;
          af = Math.min(af + step, max);
        }
      }
    }

    sar = newSar;
    result.push({ sar: parseFloat(sar.toFixed(2)), trend });
  }

  return result;
}

// ── Time filter — IST check from unix timestamp ───────────────────────────────
/**
 * Returns true if candle time is within 9:30 AM – 3:00 PM IST
 * @param {number} unixSec - candle timestamp in seconds
 */
function isInTradingWindow(unixSec) {
  const ist = new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const d   = new Date(ist);
  const totalMin = d.getHours() * 60 + d.getMinutes();
  return totalMin >= 570 && totalMin < 900; // 9:30 AM = 570, 3:00 PM = 900
}

// ── Main signal function ──────────────────────────────────────────────────────
/**
 * @param {Array} candles - Array of { time, open, high, low, close, volume }
 * @returns {{
 *   signal: "BUY_CE"|"BUY_PE"|"NONE",
 *   reason: string,
 *   stopLoss: number|null,   ← SL price to pass back to engine
 *   ema9: number,
 *   ema20: number,
 *   rsi: number,
 *   sar: number,
 *   sarTrend: string
 * }}
 */
function getSignal(candles) {
  // Need at least 30 candles: 20 for EMA20 + buffer for SAR warmup
  if (candles.length < 30) {
    return { signal: "NONE", reason: `Warming up (${candles.length}/30 candles)`, stopLoss: null };
  }

  const lastCandle = candles[candles.length - 1];

  // ── Time filter ─────────────────────────────────────────────────────────
  if (!isInTradingWindow(lastCandle.time)) {
    return {
      signal:   "NONE",
      reason:   "Outside trading window (9:30 AM – 3:00 PM only)",
      stopLoss: null,
    };
  }

  const closes = candles.map(c => c.close);

  // ── EMA 9 & 20 ──────────────────────────────────────────────────────────
  const ema9arr  = EMA.calculate({ period: 9,  values: closes });
  const ema20arr = EMA.calculate({ period: 20, values: closes });

  const currEma9  = ema9arr[ema9arr.length - 1];
  const prevEma9  = ema9arr[ema9arr.length - 2];
  const currEma20 = ema20arr[ema20arr.length - 1];
  const prevEma20 = ema20arr[ema20arr.length - 2];

  const crossedAbove = prevEma9 <= prevEma20 && currEma9 > currEma20;
  const crossedBelow = prevEma9 >= prevEma20 && currEma9 < currEma20;

  // ── RSI 14 ──────────────────────────────────────────────────────────────
  const rsiArr = RSI.calculate({ period: 14, values: closes });
  const rsi    = rsiArr[rsiArr.length - 1];

  // ── Parabolic SAR ────────────────────────────────────────────────────────
  const sarArr  = calcSAR(candles);
  const currSAR = sarArr[sarArr.length - 1];

  if (!currSAR) {
    return { signal: "NONE", reason: "SAR not ready", stopLoss: null };
  }

  const sarBullish = currSAR.trend === 1 && currSAR.sar < lastCandle.low;
  const sarBearish = currSAR.trend === -1 && currSAR.sar > lastCandle.high;

  // ── Stoploss price — low/high of candle 2 bars prior ────────────────────
  const slCandle = candles[candles.length - 3]; // 2 candles before current

  // ── BUY CE ───────────────────────────────────────────────────────────────
  // TRIGGER : EMA 9 crosses ABOVE EMA 20 on this candle
  // CONFIRM : RSI is in bullish zone (> 51)  — doesn't need to cross, just be there
  //           SAR is in bullish position (below price) — zone check only
  if (crossedAbove && rsi > 51 && sarBullish) {
    const stopLoss = parseFloat(slCandle.low.toFixed(2));
    return {
      signal:   "BUY_CE",
      reason:   `EMA9 crossed above EMA20 [TRIGGER] | RSI ${rsi.toFixed(1)} > 51 ✓ | SAR ${currSAR.sar} < price ✓ | SL: ${stopLoss}`,
      stopLoss,
      ema9:     currEma9,
      ema20:    currEma20,
      rsi,
      sar:      currSAR.sar,
      sarTrend: "BULLISH",
    };
  }

  // ── BUY PE ───────────────────────────────────────────────────────────────
  // TRIGGER : EMA 9 crosses BELOW EMA 20 on this candle
  // CONFIRM : RSI is in bearish zone (< 49)  — zone check only
  //           SAR is in bearish position (above price) — zone check only
  if (crossedBelow && rsi < 49 && sarBearish) {
    const stopLoss = parseFloat(slCandle.high.toFixed(2));
    return {
      signal:   "BUY_PE",
      reason:   `EMA9 crossed below EMA20 [TRIGGER] | RSI ${rsi.toFixed(1)} < 49 ✓ | SAR ${currSAR.sar} > price ✓ | SL: ${stopLoss}`,
      stopLoss,
      ema9:     currEma9,
      ema20:    currEma20,
      rsi,
      sar:      currSAR.sar,
      sarTrend: "BEARISH",
    };
  }

  // ── No signal — show exactly what's blocking ──────────────────────────────
  const missing = [];
  if (!crossedAbove && !crossedBelow) {
    missing.push("no EMA crossover");
  } else if (crossedAbove) {
    if (rsi <= 51)    missing.push(`RSI ${rsi.toFixed(1)} not > 51`);
    if (!sarBullish)  missing.push(`SAR ${currSAR.sar} not below price`);
  } else if (crossedBelow) {
    if (rsi >= 49)    missing.push(`RSI ${rsi.toFixed(1)} not < 49`);
    if (!sarBearish)  missing.push(`SAR ${currSAR.sar} not above price`);
  }

  return {
    signal:   "NONE",
    reason:   missing.length ? `Waiting: ${missing.join(", ")}` : `EMA9:${currEma9.toFixed(1)} EMA20:${currEma20.toFixed(1)} RSI:${rsi.toFixed(1)} SAR:${currSAR.sar}(${currSAR.trend === 1 ? "↑" : "↓"})`,
    stopLoss: null,
    ema9:     currEma9,
    ema20:    currEma20,
    rsi,
    sar:      currSAR.sar,
    sarTrend: currSAR.trend === 1 ? "BULLISH" : "BEARISH",
  };
}

module.exports = { NAME, DESCRIPTION, getSignal };

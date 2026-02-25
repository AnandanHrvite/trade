/**
 * STRATEGY 1: EMA Crossover
 * ─────────────────────────────────────────────────────────
 * Signal Logic:
 *   BUY  CE (or go long Futures) when 9 EMA crosses ABOVE 21 EMA
 *   BUY  PE (or go short Futures) when 9 EMA crosses BELOW 21 EMA
 *
 * Timeframe: 5-min candles (good for intraday NIFTY)
 * Exit: Opposite crossover OR end of day (3:20 PM square-off)
 * ─────────────────────────────────────────────────────────
 */

const { EMA } = require("technicalindicators");

const NAME = "EMA_CROSSOVER";
const DESCRIPTION = "9 EMA vs 21 EMA crossover on 5-min NIFTY candles";

/**
 * @param {Array} candles - Array of { time, open, high, low, close, volume }
 * @returns {{ signal: "BUY_CE"|"BUY_PE"|"NONE", reason: string }}
 */
function getSignal(candles) {
  if (candles.length < 25) {
    return { signal: "NONE", reason: "Not enough candles (need 25+)" };
  }

  const closes = candles.map((c) => c.close);

  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });

  const len = Math.min(ema9.length, ema21.length);
  const curr9 = ema9[len - 1];
  const prev9 = ema9[len - 2];
  const curr21 = ema21[len - 1];
  const prev21 = ema21[len - 2];

  const crossedAbove = prev9 <= prev21 && curr9 > curr21;
  const crossedBelow = prev9 >= prev21 && curr9 < curr21;

  if (crossedAbove) {
    return {
      signal: "BUY_CE",
      reason: `9 EMA (${curr9.toFixed(2)}) crossed above 21 EMA (${curr21.toFixed(2)})`,
      ema9: curr9,
      ema21: curr21,
    };
  }

  if (crossedBelow) {
    return {
      signal: "BUY_PE",
      reason: `9 EMA (${curr9.toFixed(2)}) crossed below 21 EMA (${curr21.toFixed(2)})`,
      ema9: curr9,
      ema21: curr21,
    };
  }

  return {
    signal: "NONE",
    reason: "No crossover",
    ema9: curr9,
    ema21: curr21,
  };
}

module.exports = { NAME, DESCRIPTION, getSignal };

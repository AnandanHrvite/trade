/**
 * STRATEGY 2: RSI + VWAP Reversal
 * ─────────────────────────────────────────────────────────
 * Signal Logic:
 *   BUY CE  when RSI < 35 AND price bounces above VWAP  → oversold + bullish
 *   BUY PE  when RSI > 65 AND price drops below VWAP    → overbought + bearish
 *
 * Timeframe: 5-min candles
 * Exit: RSI crosses 50 OR end of day square-off
 * ─────────────────────────────────────────────────────────
 */

const { RSI } = require("technicalindicators");

const NAME = "RSI_VWAP_REVERSAL";
const DESCRIPTION = "RSI extremes (35/65) confirmed by VWAP crossover";

/**
 * Calculate VWAP from candles
 */
function calcVWAP(candles) {
  let cumTPV = 0;
  let cumVol = 0;
  return candles.map((c) => {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    return cumVol === 0 ? tp : cumTPV / cumVol;
  });
}

/**
 * @param {Array} candles - Array of { time, open, high, low, close, volume }
 * @returns {{ signal: "BUY_CE"|"BUY_PE"|"NONE", reason: string }}
 */
function getSignal(candles) {
  if (candles.length < 16) {
    return { signal: "NONE", reason: "Not enough candles (need 16+)" };
  }

  const closes = candles.map((c) => c.close);
  const rsiValues = RSI.calculate({ period: 14, values: closes });
  const vwapValues = calcVWAP(candles);

  const rsi = rsiValues[rsiValues.length - 1];
  const prevRsi = rsiValues[rsiValues.length - 2];
  const currentClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const vwap = vwapValues[vwapValues.length - 1];

  // BUY CE: RSI was oversold and price just crossed above VWAP
  if (prevRsi < 35 && rsi >= 35 && currentClose > vwap && prevClose <= vwap) {
    return {
      signal: "BUY_CE",
      reason: `RSI recovered (${rsi.toFixed(1)}) + price crossed above VWAP (${vwap.toFixed(2)})`,
      rsi,
      vwap,
    };
  }

  // BUY PE: RSI was overbought and price just crossed below VWAP
  if (prevRsi > 65 && rsi <= 65 && currentClose < vwap && prevClose >= vwap) {
    return {
      signal: "BUY_PE",
      reason: `RSI cooled (${rsi.toFixed(1)}) + price dropped below VWAP (${vwap.toFixed(2)})`,
      rsi,
      vwap,
    };
  }

  return {
    signal: "NONE",
    reason: `No signal — RSI: ${rsi.toFixed(1)}, VWAP: ${vwap.toFixed(2)}, Close: ${currentClose}`,
    rsi,
    vwap,
  };
}

module.exports = { NAME, DESCRIPTION, getSignal };

/**
 * STRATEGY 3: Supertrend Momentum
 * ─────────────────────────────────────────────────────────
 * Signal Logic:
 *   BUY CE  when Supertrend flips to BULLISH (price crosses above upper band)
 *   BUY PE  when Supertrend flips to BEARISH (price crosses below lower band)
 *
 * Settings: ATR Period = 10, Multiplier = 3 (standard for intraday)
 * Timeframe: 5-min candles
 * Exit: Supertrend flips direction OR end of day square-off
 * ─────────────────────────────────────────────────────────
 */

const NAME = "SUPERTREND_MOMENTUM";
const DESCRIPTION = "Supertrend (10,3) direction flip on 5-min NIFTY candles";

/**
 * Manual Supertrend calculation
 * Returns array of { supertrend, direction } — direction 1=bullish, -1=bearish
 */
function calcSupertrend(candles, atrPeriod = 10, multiplier = 3) {
  if (candles.length < atrPeriod + 2) return [];

  // Step 1: Calculate ATR
  const trValues = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });

  const atr = [];
  let sum = 0;
  for (let i = 0; i < atrPeriod; i++) sum += trValues[i];
  atr[atrPeriod - 1] = sum / atrPeriod;
  for (let i = atrPeriod; i < trValues.length; i++) {
    atr[i] = (atr[i - 1] * (atrPeriod - 1) + trValues[i]) / atrPeriod;
  }

  // Step 2: Supertrend
  const result = [];
  let prevUpper = 0;
  let prevLower = 0;
  let prevDirection = 1;

  for (let i = atrPeriod; i < candles.length; i++) {
    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];

    const upper = basicUpper < prevUpper || candles[i - 1].close > prevUpper ? basicUpper : prevUpper;
    const lower = basicLower > prevLower || candles[i - 1].close < prevLower ? basicLower : prevLower;

    let direction;
    if (prevDirection === -1 && c.close > prevUpper) {
      direction = 1; // flip to bullish
    } else if (prevDirection === 1 && c.close < prevLower) {
      direction = -1; // flip to bearish
    } else {
      direction = prevDirection;
    }

    const supertrend = direction === 1 ? lower : upper;
    result.push({ supertrend, direction, upper, lower });

    prevUpper = upper;
    prevLower = lower;
    prevDirection = direction;
  }

  return result;
}

/**
 * @param {Array} candles - Array of { time, open, high, low, close, volume }
 * @returns {{ signal: "BUY_CE"|"BUY_PE"|"NONE", reason: string }}
 */
function getSignal(candles) {
  if (candles.length < 14) {
    return { signal: "NONE", reason: "Not enough candles (need 14+)" };
  }

  const st = calcSupertrend(candles);
  if (st.length < 2) {
    return { signal: "NONE", reason: "Supertrend not ready" };
  }

  const curr = st[st.length - 1];
  const prev = st[st.length - 2];

  // Flip to bullish
  if (prev.direction === -1 && curr.direction === 1) {
    return {
      signal: "BUY_CE",
      reason: `Supertrend flipped BULLISH — Supertrend line: ${curr.supertrend.toFixed(2)}`,
      supertrend: curr.supertrend,
      direction: "BULLISH",
    };
  }

  // Flip to bearish
  if (prev.direction === 1 && curr.direction === -1) {
    return {
      signal: "BUY_PE",
      reason: `Supertrend flipped BEARISH — Supertrend line: ${curr.supertrend.toFixed(2)}`,
      supertrend: curr.supertrend,
      direction: "BEARISH",
    };
  }

  return {
    signal: "NONE",
    reason: `No flip — direction: ${curr.direction === 1 ? "BULLISH" : "BEARISH"}, Supertrend: ${curr.supertrend.toFixed(2)}`,
    supertrend: curr.supertrend,
    direction: curr.direction === 1 ? "BULLISH" : "BEARISH",
  };
}

module.exports = { NAME, DESCRIPTION, getSignal };

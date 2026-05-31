/**
 * Support / Resistance entry filter — shared by SCALP & SWING (and reusable by PA).
 *
 * Mirrors the swing-point + zone logic Price Action already uses
 * (src/strategies/price_action.js findSwingPoints / isNearResistance / isNearSupport):
 *   - A swing HIGH = a candle whose high tops BOTH neighbours → a resistance level.
 *   - A swing LOW  = a candle whose low undercuts BOTH neighbours → a support level.
 *   - "near" = entry price within `zonePts` of such a level.
 *
 * Gate intent: don't open a LONG (CE) into overhead resistance, and don't open a
 * SHORT (PE) into support just below — those are exactly where breakouts/fades most
 * often reverse. Only the last completed candle before the signal can be a swing
 * (a swing needs a candle on each side), so the entry candle itself is never a level.
 *
 * Pure helper — no env reads. The caller decides whether the filter is enabled and
 * passes lookback + zonePts. Default OFF in every strategy.
 */

// Scan the last `lookback` candles for confirmed 3-bar swing highs/lows.
function findSwingPoints(candles, lookback) {
  var swingHighs = [];
  var swingLows  = [];
  var start = Math.max(1, candles.length - lookback);
  for (var i = start; i < candles.length - 1; i++) {
    var prev = candles[i - 1];
    var curr = candles[i];
    var next = candles[i + 1];
    if (curr.high > prev.high && curr.high > next.high) swingHighs.push(curr.high);
    if (curr.low  < prev.low  && curr.low  < next.low ) swingLows.push(curr.low);
  }
  return { swingHighs: swingHighs, swingLows: swingLows };
}

// Nearest level within zonePts of price (most-recent first), or null.
function _nearLevel(price, levels, zonePts) {
  for (var i = levels.length - 1; i >= 0; i--) {
    if (Math.abs(price - levels[i]) <= zonePts) return levels[i];
  }
  return null;
}

/**
 * @param {Array}  candles  closed-candle array ({high,low,...})
 * @param {string} side     "CE" (long) or "PE" (short)
 * @param {number} price    entry price (signal-candle close)
 * @param {number} lookback how many recent candles to scan for swings
 * @param {number} zonePts  block when price is within this many points of the level
 * @returns {{blocked:boolean, level:number|null, kind:string|null}}  kind = "resistance"|"support"|null
 */
function blockedBySR(candles, side, price, lookback, zonePts) {
  if (!candles || candles.length < 3 || !(zonePts > 0)) return { blocked: false, level: null, kind: null };
  var sw = findSwingPoints(candles, lookback);
  if (side === "CE") {
    var r = _nearLevel(price, sw.swingHighs, zonePts);
    if (r != null) return { blocked: true, level: r, kind: "resistance" };
  } else if (side === "PE") {
    var s = _nearLevel(price, sw.swingLows, zonePts);
    if (s != null) return { blocked: true, level: s, kind: "support" };
  }
  return { blocked: false, level: null, kind: null };
}

module.exports = { findSwingPoints: findSwingPoints, blockedBySR: blockedBySR };

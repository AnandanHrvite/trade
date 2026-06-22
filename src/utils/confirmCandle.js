/**
 * Two-candle "cross & close" entry confirmation — shared by SWING + SCALP.
 *
 * Added 2026-06-23. Default ON for both strategies (per-strategy toggle below).
 *
 * The rule (what the user asked for):
 *   1. SIGNAL candle  — a FULLY CLOSED candle that met ALL the strategy's normal
 *      entry rules (EMA/RSI/SuperTrend for Swing, BB/SuperTrend|PSAR/RSI for Scalp).
 *      Its CLOSE becomes the trigger level. We do NOT enter on this candle.
 *   2. CONFIRMATION   — during the IMMEDIATELY-NEXT candle, price must CROSS the
 *      signal candle's close (CE: strictly above, PE: strictly below). The trade
 *      enters intra-bar at the crossing price (not at candle close).
 *   3. If the next candle never crosses, the armed signal expires. If that next
 *      candle is itself a fresh signal candle, it re-arms (rolling) for the candle
 *      after it.
 *
 * The arm/expire state machine lives in each engine (paper/live keep a tick-loop
 * arm on their state object; the backtests carry it across the candle loop). This
 * module only owns the bits that MUST stay identical across all six surfaces:
 * the toggle name, the cross direction, the strict-vs-inclusive comparison, and
 * the candle-granularity fill used by the backtests.
 */

// Per-strategy toggle (default ON). prefix = "SWING" | "SCALP". Read live so a
// Settings change applies to a running session without a restart.
function enabled(prefix) {
  return (process.env[prefix + "_CONFIRM_CANDLE_ENABLED"] || "true").toLowerCase() === "true";
}

// Live (per-tick) cross test: has price `p` crossed the trigger in the signal
// direction? Strict — the level must be exceeded, not merely touched.
function crossed(side, price, triggerLevel) {
  var ce = side === "CE" || side === "BUY_CE";
  return ce ? price > triggerLevel : price < triggerLevel;
}

// Is `barTimeSec` the candle IMMEDIATELY after the signal candle? Confirmation is
// valid for exactly one candle. Time-based (not index) so an EOD→next-day gap can
// never confirm — the next trading candle's unix time is not armedBarTime+res.
function isNextBar(barTimeSec, armedBarTimeSec, resMinutes) {
  return barTimeSec === armedBarTimeSec + resMinutes * 60;
}

// Backtest candle-granularity proxy for the intra-bar cross. Returns the spot the
// fill would happen at, or null if the bar's range never crossed the trigger.
//   CE: crossed if high > trigger; fill at open if the bar gapped through, else trigger.
//   PE: crossed if low  < trigger; fill at open if the bar gapped through, else trigger.
function barCrossFill(side, candle, triggerLevel) {
  var ce = side === "CE" || side === "BUY_CE";
  if (ce) {
    if (candle.high > triggerLevel) return candle.open > triggerLevel ? candle.open : triggerLevel;
  } else {
    if (candle.low < triggerLevel) return candle.open < triggerLevel ? candle.open : triggerLevel;
  }
  return null;
}

module.exports = { enabled, crossed, isNextBar, barCrossFill };

/**
 * Two-candle "cross & close" entry confirmation — shared by EMA_RSI_ST + BB_RSI.
 *
 * Added 2026-06-23. Default ON for both strategies (per-strategy toggle below).
 *
 * The rule (what the user asked for):
 *   1. SIGNAL candle  — a FULLY CLOSED candle that met ALL the strategy's normal
 *      entry rules (EMA/RSI/SuperTrend for EMA_RSI_ST, BB/SuperTrend|PSAR/RSI for BB_RSI).
 *      Its CLOSE becomes the trigger level. We do NOT enter on this candle.
 *   2. CONFIRMATION   — during the IMMEDIATELY-NEXT candle, price must CROSS the
 *      signal candle's close (CE: strictly above, PE: strictly below). The trade
 *      enters intra-bar at the crossing price (not at candle close).
 *      BB_RSI only: with BB_RSI_CONFIRM_OUTSIDE_BAND on (default), confirmation is
 *      instead evaluated at that candle's CLOSE — it must close beyond the signal
 *      close AND outside the band, and entry fires at the close (see outsideBandEnabled).
 *   3. If the next candle never confirms, the armed signal expires. If that next
 *      candle is itself a fresh signal candle, it re-arms (rolling) for the candle
 *      after it.
 *
 * The arm/expire state machine lives in each engine (paper/live keep a tick-loop
 * arm on their state object; the backtests carry it across the candle loop). This
 * module only owns the bits that MUST stay identical across all six surfaces:
 * the toggle name, the cross direction, the strict-vs-inclusive comparison, and
 * the candle-granularity fill used by the backtests.
 */

// Per-strategy toggle (default ON). prefix = "EMA_RSI_ST" | "BB_RSI". Read live so a
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

// ── "Confirmation must close outside the band" guard (BB_RSI only) ──────────
// Toggle: when ON, the confirmation is evaluated at the NEXT candle's CLOSE — that
// candle must CLOSE beyond the signal candle's close (the cross) AND close outside
// the band — instead of entering intra-bar on the first poke past the trigger. An
// intra-bar poke can close back inside the band (a failed breakout), leaving the
// entry candle visibly inside the band; requiring a close beyond the band makes
// every entry candle genuinely outside it. Default ON. Per-strategy prefix (only
// BB_RSI has Bollinger Bands; EMA_RSI_ST never calls this).
function outsideBandEnabled(prefix) {
  return (process.env[prefix + "_CONFIRM_OUTSIDE_BAND"] || "true").toLowerCase() === "true";
}

// Is `price` (the confirmation candle's close) beyond the band in the signal
// direction? Each engine passes the band at the confirmation candle's close so the
// comparison stays identical across surfaces. Returns false if the band edge is missing.
function beyondBand(side, price, bbUpper, bbLower) {
  var ce = side === "CE" || side === "BUY_CE";
  if (ce) return bbUpper != null && price > bbUpper;
  return bbLower != null && price < bbLower;
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

module.exports = { enabled, crossed, isNextBar, barCrossFill, outsideBandEnabled, beyondBand };

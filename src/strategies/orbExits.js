/**
 * ORB — SHARED EXIT ENGINE
 * ═════════════════════════════════════════════════════════════════════════════
 * The single owner of ORB's in-position rules. Paper and Live call THIS module;
 * neither may keep a private copy of an exit rule.
 *
 * 2026-11-07 (owner order): the global profit lock (tradeGuards.checkProfitLock)
 * is the ONLY automatic exit. Every stop (spot hard SL, rupee cap, premium
 * disaster stop, breakeven), every trail (EMA, candle, SuperTrend), the
 * opposite-candle exit and the per-strategy EOD square-off were deleted outright.
 * What still closes a position besides the lock: the manual exit, /stop and the
 * global TRADE_STOP_TIME session teardown — all owned by the routes.
 *
 * DECISIONS ARE RETURNED, NOT EXECUTED. Paper simulates a fill, Live places a
 * broker order. Those are execution concerns; this module only decides.
 */

const { trackPath } = require("../utils/tradePath");

/**
 * Open-trade P&L in ₹, for whichever instrument the position holds.
 *
 * Options are BOUGHT, so the premium move IS the P&L for both CE and PE.
 * A futures position prices on the INDEX and carries a direction: CE = LONG,
 * PE = SHORT. Without the sign a winning short reports as a loss.
 */
function _openPnl(pos, spotPrice, optionLtp) {
  if (pos && pos.isFutures) {
    return (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1) * pos.qty;
  }
  return (optionLtp - pos.optionEntryLtp) * pos.qty;
}

/**
 * Peak-premium + MFE/MAE bookkeeping. The peak feeds the profit lock; the
 * excursions feed the trade record and the Telegram summary.
 *
 * @param {object} pos        the open position (mutated)
 * @param {number} spotPrice
 * @param {number} optionLtp
 * @param {number} nowMs      clock for secsToMFE/secsToMAE (injected so replay,
 *                            which compresses time, stays honest)
 */
function trackExcursion(pos, spotPrice, optionLtp, nowMs) {
  if (!pos) return;
  if (optionLtp > pos.peakPremium) pos.peakPremium = optionLtp;   // spot high in futures mode

  const favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const curPnl = _openPnl(pos, spotPrice, optionLtp);
  if (favPts > (pos.mfeSpotPts || 0)) {
    pos.mfeSpotPts = parseFloat(favPts.toFixed(2));
    pos.secsToMFE  = parseFloat(((nowMs - pos.entryTimeMs) / 1000).toFixed(1));
  }
  if (curPnl > (pos.mfePnl || 0)) pos.mfePnl = parseFloat(curPnl.toFixed(2));
  if (favPts < (pos.maeSpotPts || 0)) {
    pos.maeSpotPts = parseFloat(favPts.toFixed(2));
    pos.secsToMAE  = parseFloat(((nowMs - pos.entryTimeMs) / 1000).toFixed(1));
  }
  if (curPnl < (pos.maePnl || 0)) pos.maePnl = parseFloat(curPnl.toFixed(2));
  trackPath(pos, favPts, nowMs);
}

/**
 * Tick-level exit: the global profit lock, and nothing else.
 *
 * @returns {{exit:boolean, reason:string|null}}
 */
function evaluateTickExits(pos, { optionLtp }) {
  if (!pos) return { exit: false, reason: null };
  // Global profit lock (shared across every strategy — see tradeGuards). Options
  // only: it is defined on option premium, and in futures mode optionLtp mirrors
  // the SPOT, so leaving it on would test an 8% move in NIFTY itself.
  if (!pos.isFutures) {
    const plMsg = require("../utils/tradeGuards").checkProfitLock(pos.optionEntryLtp, optionLtp, pos.peakPremium);
    if (plMsg) return { exit: true, reason: plMsg };
  }
  return { exit: false, reason: null };
}

/**
 * Has the option premium gone stale? Warn-only across this repo — every other
 * strategy logs it and leaves the exit rules untouched. Gating exits on
 * staleness would be a behaviour change, so it deliberately is not one.
 */
function isLtpStale(updatedAtMs, nowMs) {
  if (!updatedAtMs) return false;
  // NEVER during replay. The replay harness pins global Date.now() to the recorded
  // session clock, which advances far faster than the real 3-second option-poll
  // cadence — so the gap between two polls looks like many "minutes" and the
  // warning would fire on every replay run. Lazy because tickReplay requires the
  // routes, which require this module.
  try { if (require("../services/tickReplay").isReplayInProgress()) return false; } catch (_) {}
  const staleMs = parseInt(process.env.LTP_STALE_THRESHOLD_SEC || "15", 10) * 1000;
  return (nowMs - updatedAtMs) > staleMs;
}

module.exports = {
  trackExcursion,
  evaluateTickExits,
  isLtpStale,
};

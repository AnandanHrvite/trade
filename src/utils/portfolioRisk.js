/**
 * portfolioRisk.js — cross-strategy (portfolio-level) daily loss cap
 * ─────────────────────────────────────────────────────────────────────────────
 * Each strategy already caps its OWN daily loss, but nothing summed them, so all
 * strategies hitting their individual caps the same day could lose far more in
 * aggregate. This adds one portfolio-wide breaker.
 *
 * Design:
 *   • Source of truth = the per-day JSONL audit logs (tradeLogger.readDailyTrades),
 *     the same canonical files the per-strategy restart-recovery already trusts.
 *   • Sums TODAY's (IST) realized P&L across all paper strategy modes. Paper is
 *     the canonical decision layer and harness-live mirrors it, so this is the
 *     right proxy for "how much has the book lost today".
 *   • The gate ONLY ever BLOCKS new entries — it can never place or alter an
 *     order — so it is strictly fail-safe.
 *   • Disabled by default: PORTFOLIO_MAX_DAILY_LOSS unset or <= 0 → never blocks.
 *     Set it (e.g. 12000) to arm the breaker.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const tradeLogger = require("./tradeLogger");

// Paper modes = the canonical decision layer. Summing these gives the book's
// realized P&L for the day regardless of which surface (paper/harness-live) ran.
const PAPER_MODES = ["ema_rsi_st", "bb_rsi", "pa", "orb", "ema9vwap", "trend_pb"];

// Pull a realized P&L number out of a logged record. Trade exits carry `pnl`;
// harness EXIT events carry `paperPnl`. Snapshot / checkpoint lines carry
// neither and are skipped.
function _recordPnl(t) {
  if (!t) return null;
  if (Number.isFinite(Number(t.pnl)))      return Number(t.pnl);
  if (Number.isFinite(Number(t.paperPnl))) return Number(t.paperPnl);
  return null;
}

/**
 * Sum today's (IST) realized P&L across all paper strategy modes.
 * Pure read of on-disk logs — safe to call on any entry check.
 * @returns {{ total: number, byMode: Object<string, number> }}
 */
function getTodayRealized() {
  const dateStr = tradeLogger.istDateString();
  const byMode = {};
  let total = 0;
  for (const mode of PAPER_MODES) {
    let sum = 0;
    try {
      for (const t of tradeLogger.readDailyTrades(mode, dateStr)) {
        const p = _recordPnl(t);
        if (p !== null) sum += p;
      }
    } catch (_) { /* missing/unreadable log for this mode → treat as 0 */ }
    sum = parseFloat(sum.toFixed(2));
    byMode[mode] = sum;
    total += sum;
  }
  return { total: parseFloat(total.toFixed(2)), byMode };
}

function _cap() {
  const c = parseFloat(process.env.PORTFOLIO_MAX_DAILY_LOSS || "0");
  return Number.isFinite(c) ? c : 0;
}

/**
 * Portfolio-level gate. Returns { blocked, total, cap, disabled, reason }.
 * blocked=true means new entries across ALL strategies should be skipped for the
 * rest of the day. Never throws; on any error it fails OPEN (does not block) so
 * a logging glitch can't halt the whole book.
 */
function checkPortfolioCap() {
  try {
    const cap = _cap();
    if (!(cap > 0)) return { blocked: false, disabled: true, total: 0, cap: 0, reason: "portfolio cap disabled" };
    const { total } = getTodayRealized();
    const blocked = total <= -cap;
    return {
      blocked,
      disabled: false,
      total,
      cap,
      reason: blocked
        ? `portfolio loss ₹${total} <= -₹${cap} — all strategies paused for the day`
        : `portfolio P&L ₹${total} within -₹${cap}`,
    };
  } catch (err) {
    return { blocked: false, disabled: false, total: 0, cap: _cap(), reason: `portfolio check error (fail-open): ${err.message}` };
  }
}

module.exports = { getTodayRealized, checkPortfolioCap, PAPER_MODES };

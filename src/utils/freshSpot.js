/**
 * Spot price to make a decision on — the last socket tick when it is fresh,
 * otherwise a direct Fyers quote.
 *
 * A strategy's `lastTickPrice` is only as current as the shared feed. On
 * 2026-10-08 the feed delivered nothing after 07:41, and PREV_ORB_SCALP checked
 * its 09:45 entry against 22603.05 — the previous close, seeded at start —
 * "already through the stop 22498.85" with the market really at ~22470, and
 * aborted a valid trade. SIMPLE930 picked its 09:25 ATM from the same number.
 *
 * Deliberately NOT instrument.getLiveSpot(): that caches for 60s and falls
 * back to a fixed *_SPOT_FALLBACK from .env — as stale as the tick it replaces.
 *
 * Replay-safe: tickReplay shims Date.now to the replay clock, so pumped ticks
 * are always fresh here and no quote is requested. If the quote fails, the
 * tick price is returned exactly as before (source "stale-tick"), so a failed
 * fetch never blocks a decision that used to happen.
 */

const fyers = require("../config/fyers");
const { underlyingOf } = require("../config/instrument");

const DEFAULT_MAX_AGE_MS = 10_000;

/**
 * @param {object} o
 * @param {number|null} o.tickPrice   last socket tick price
 * @param {number|null} o.tickAt      ms timestamp of that tick (Date.now() clock)
 * @param {string}     [o.underlying] "NIFTY" (default) | "BANKNIFTY"
 * @param {number}     [o.maxAgeMs]   tick older than this → fetch a quote
 * @returns {Promise<{spot: number|null, source: "tick"|"quote"|"stale-tick"|"none", ageMs: number|null}>}
 */
async function freshSpot({ tickPrice, tickAt, underlying, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const hasTick = typeof tickPrice === "number" && tickPrice > 0;
  const ageMs = (hasTick && typeof tickAt === "number") ? Date.now() - tickAt : null;
  if (hasTick && ageMs !== null && ageMs <= maxAgeMs) return { spot: tickPrice, source: "tick", ageMs };

  try {
    const u = underlyingOf(underlying);
    const r = await fyers.getQuotes([u.spot]);
    const v = r && r.s === "ok" && Array.isArray(r.d) && r.d[0] && r.d[0].v;
    const ltp = v ? (v.lp || v.ltp) : null;
    if (typeof ltp === "number" && ltp > 0) return { spot: ltp, source: "quote", ageMs };
  } catch (_) { /* fall through to the tick */ }

  return hasTick ? { spot: tickPrice, source: "stale-tick", ageMs } : { spot: null, source: "none", ageMs };
}

module.exports = { freshSpot, DEFAULT_MAX_AGE_MS };

/**
 * optionFeed.js — socket-first option LTP, with the REST poll as the fallback
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Every strategy used to ask Fyers "what is my option worth?" over REST on its
 * own timer — BB_RSI/PA every 500ms, EMA_RSI_ST/EMA9_VWAP every 1s,
 * the rest every 3s. With five strategies holding positions at once
 * that is ~340 requests/minute against a ~200/minute data-API budget, and the
 * price a stop-loss reads can be up to 3 seconds old.
 *
 * Fyers already streams those contracts on the websocket the spot index is
 * using. This module multiplexes them onto that one connection: a strategy
 * leases the symbol it currently holds, ticks push straight into its state, and
 * the REST call is skipped for as long as the streamed price stays fresh.
 *
 * ── Leases, not refcounts ────────────────────────────────────────────────────
 * A refcount needs a perfectly balanced release on every exit path — including
 * crashes, EOD square-offs and mid-trade restarts — and one missed release
 * leaks a subscription for the rest of the day. Instead each owner renews a
 * short-lived lease from inside the poll loop it already runs. Stop renewing
 * (position closed, session stopped, process reloaded) and the lease lapses on
 * its own. Nothing can leak.
 *
 * ── Fail-safe by construction ────────────────────────────────────────────────
 * Nothing here is on the critical path. If the socket cannot attribute symbols,
 * a subscription is refused, or a contract simply does not tick, `getFresh()`
 * returns null and the caller runs the exact REST poll it ran before. The worst
 * case is the behaviour we have today, never a stale price presented as live.
 */

const socketManager = require('./socketManager');
const tickRecorder  = require('./tickRecorder');

// Lazily resolved to avoid a require-cycle at module load (tickReplay pulls in
// the broker + route layer, which pulls in this file).
let _replayMod = null;
function _replayInProgress() {
  try {
    if (!_replayMod) _replayMod = require('../services/tickReplay');
    return _replayMod.isReplayInProgress();
  } catch (_) { return false; }
}

/** Master kill-switch. Set false to fall back to pure REST polling instantly. */
function isEnabled() {
  // A replay run stubs fyers.getQuotes with the RECORDED option timeline and
  // pumps ticks through a fake socket. Streaming would both bypass that timeline
  // and — worse — place real subscriptions on the live connection from inside a
  // simulation. Replay must stay on the REST path it was built around.
  if (_replayInProgress()) return false;
  return String(process.env.OPTION_SOCKET_FEED_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function envInt(key, dflt, min, max) {
  const v = parseInt(process.env[key] || '', 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}

/**
 * How long a streamed price stays usable before the caller falls back to REST.
 * Must exceed the natural quiet gap between ticks on a liquid ATM contract but
 * stay well under the stop-loss reaction time we are trying to protect.
 */
function freshMs() { return envInt('OPTION_SOCKET_FRESH_MS', 4000, 500, 60_000); }

/**
 * Lease lifetime. Must comfortably exceed the SLOWEST caller's renewal period
 * (3s today) so an ordinary slow poll never drops a live subscription, while
 * staying short enough that an abandoned symbol is released the same minute.
 */
function leaseTtlMs() { return envInt('OPTION_SOCKET_LEASE_MS', 15_000, 5_000, 120_000); }

/**
 * Minimum gap between recorded samples per symbol. The websocket can tick many
 * times a second; recording all of it would bloat the replay files for no gain,
 * since /replay resolves option prices with a ±2s window anyway. 1s is at least
 * as dense as the REST polling it replaces for every strategy bar BB_RSI/PA.
 */
function recordThrottleMs() { return envInt('OPTION_SOCKET_RECORD_MS', 1000, 100, 10_000); }

const SWEEP_MS = 5_000;

/** ownerId → { symbol, onLtp, renewedAt } */
const leases = new Map();
/** symbol → { ltp, at, recordedAt, src } */
const prices = new Map();

let sweepTimer     = null;
let handlerBound   = false;
const stats = { ticks: 0, restSkipped: 0, restFallback: 0, subscribeRefused: 0 };

// ── Socket side ──────────────────────────────────────────────────────────────

/**
 * One handler for every leased contract. socketManager guarantees `symbol` is
 * one we explicitly subscribed, so no attribution work is needed here.
 */
function onExtraTick(symbol, tick) {
  const ltp = tick && tick.ltp;
  if (typeof ltp !== 'number' || !(ltp > 0)) return;

  const now  = Date.now();
  const prev = prices.get(symbol);
  const rec  = prev || { ltp: null, at: 0, recordedAt: 0, src: null };
  rec.ltp = ltp;
  rec.at  = now;
  if (!prev) prices.set(symbol, rec);
  stats.ticks++;

  // Replay depends on this stream — /replay serves option prices from the
  // recorded `options` file, so the socket path MUST keep feeding it or every
  // replayed trade would exit on a spot-proxy price instead of a real premium.
  if (now - rec.recordedAt >= recordThrottleMs()) {
    rec.recordedAt = now;
    try { tickRecorder.recordOptionLtp(symbol, ltp, rec.src || 'socket'); } catch (_) {}
  }

  // Push to every owner holding this symbol, so a strategy's optionLtp updates
  // the moment the price moves rather than on its next poll tick.
  for (const lease of leases.values()) {
    if (lease.symbol !== symbol || !lease.onLtp) continue;
    try { lease.onLtp(ltp, now); }
    catch (e) { console.error(`🚨 [OPTION-FEED] ${symbol} listener error: ${e.message}`); }
  }
}

function ensureBound() {
  // Assigned every time rather than once: socketManager.stop() clears the
  // handler, and a later session must not come back with a dead feed.
  socketManager.setExtraTickHandler(onExtraTick);
  handlerBound = true;
  if (!sweepTimer) {
    sweepTimer = setInterval(sweep, SWEEP_MS);
    if (sweepTimer.unref) sweepTimer.unref();
  }
}

/** Drop lapsed leases and unsubscribe symbols nobody is holding any more. */
function sweep() {
  const now = Date.now();
  const ttl = leaseTtlMs();
  for (const [ownerId, lease] of leases) {
    if (now - lease.renewedAt > ttl) leases.delete(ownerId);
  }
  const held = new Set();
  for (const lease of leases.values()) held.add(lease.symbol);
  for (const symbol of socketManager.getExtraSymbols()) {
    if (held.has(symbol)) continue;
    socketManager.unsubscribeExtra(symbol);
    prices.delete(symbol);
  }
  if (!leases.size) {
    // Nobody is holding anything, so no reader can exist. Drop the price cache
    // outright — the loop above only evicts symbols still listed as subscribed,
    // which misses entries orphaned by a socketManager.stop() (it clears its own
    // symbol set), and those would otherwise survive to the end of the day.
    prices.clear();
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Renew (or open) this owner's lease on `symbol` and keep it streaming.
 *
 * Call it from the poll loop the caller already runs — every invocation renews,
 * so the lease lives exactly as long as the caller keeps asking. Switching
 * symbols is handled implicitly: the old one loses its last holder and the
 * sweeper unsubscribes it.
 *
 * @param {string}   ownerId  stable per-engine id, e.g. "orb-paper"
 * @param {string}   symbol   full Fyers option symbol
 * @param {Function} onLtp    (ltp, at) => void — called on every streamed tick
 * @returns {boolean} true when the symbol is (or just became) socket-backed
 */
function track(ownerId, symbol, onLtp) {
  if (!isEnabled() || !ownerId || !symbol) return false;
  if (!socketManager.canSubscribeExtras()) { stats.subscribeRefused++; return false; }

  ensureBound();

  // Switching strike deliberately does NOT drop the old symbol's cached price
  // here: another strategy may still be holding that same contract, and evicting
  // it would push that strategy back onto a REST poll for no reason. The sweeper
  // owns eviction, and it only evicts once nobody holds the symbol at all.
  leases.set(ownerId, { symbol, onLtp: typeof onLtp === 'function' ? onLtp : null, renewedAt: Date.now() });

  if (!socketManager.subscribeExtra(symbol)) {
    // Already-subscribed returns true, so reaching here means the wire refused
    // it. Keep the lease (a reconnect may recover) but report "not backed" so
    // the caller stays on REST for now.
    stats.subscribeRefused++;
    return socketManager.getExtraSymbols().includes(symbol);
  }
  // Seed the price slot now so recorded samples are tagged with the strategy
  // that asked for the contract rather than a generic "socket".
  const rec = prices.get(symbol);
  if (rec) { if (!rec.src) rec.src = ownerId; }
  else prices.set(symbol, { ltp: null, at: 0, recordedAt: 0, src: ownerId });
  return true;
}

/**
 * Streamed price for `symbol` if it is recent enough to trust, else null.
 * A null answer means "do your REST call" — it is never an error.
 *
 * Returns `{ ltp, at }` rather than a bare number so callers stamp their
 * freshness clock with when the price ACTUALLY arrived. Stamping it with
 * "now" would let a several-second-old premium pass a staleness guard that
 * exists precisely to catch it.
 */
function getFresh(symbol, maxAgeMs) {
  if (!isEnabled() || !symbol) return null;
  const rec = prices.get(symbol);
  if (!rec || !(rec.ltp > 0)) { stats.restFallback++; return null; }
  // `maxAgeMs || freshMs()` would be wrong: a caller passing 0 ("must be brand
  // new") is falsy and would silently be granted the 4s default tolerance —
  // exactly the stale-price-presented-as-live failure this module exists to avoid.
  const limit = maxAgeMs == null ? freshMs() : maxAgeMs;
  const age = Date.now() - rec.at;
  if (age > limit) { stats.restFallback++; return null; }
  stats.restSkipped++;
  return { ltp: rec.ltp, at: rec.at };
}

/**
 * Release a lease immediately instead of waiting for it to lapse. Optional —
 * correctness never depends on it — but it frees the subscription on a clean
 * session stop rather than up to a lease-lifetime later.
 */
function release(ownerId) {
  const lease = leases.get(ownerId);
  if (!lease) return;
  leases.delete(ownerId);
  sweep();
}

/** Diagnostics for the Real-Time monitor / health surface. */
function getStats() {
  return {
    enabled:  isEnabled(),
    attached: handlerBound && socketManager.canSubscribeExtras(),
    leases:   leases.size,
    symbols:  socketManager.getExtraSymbols(),
    ...stats,
  };
}

/** Test seam — drops all state without touching the live socket. */
function _reset() {
  leases.clear();
  prices.clear();
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  handlerBound = false;
  stats.ticks = stats.restSkipped = stats.restFallback = stats.subscribeRefused = 0;
}

module.exports = { track, getFresh, release, isEnabled, getStats, _reset, _onExtraTick: onExtraTick };

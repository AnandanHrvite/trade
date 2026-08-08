/**
 * capitalPool.js — shared paper-trading capital pool (one per broker)
 * ─────────────────────────────────────────────────────────────────────────────
 * Until now `ZERODHA_INV_AMOUNT` / `FYERS_INV_AMOUNT` were display-only: every
 * paper page rendered `capital = INV_AMOUNT + its own totalPnl`, but no strategy
 * ever checked whether the money was actually there before entering. Five Fyers
 * strategies could each open a lot at the same moment against a pool that could
 * only fund two, and the numbers on screen would never notice.
 *
 * This module makes the pool behave like a real trading account:
 *
 *   available(broker) = INV_AMOUNT(broker)
 *                     + realized P&L of every paper strategy on that broker
 *                     - capital currently blocked by their OPEN positions
 *
 *   • On entry  → `block()` reserves qty × entry premium.
 *   • On exit   → `release()` frees the reservation and books the net P&L.
 *
 * When the pool cannot fund an entry the trade is NOT stopped — a running paper
 * session must keep collecting data, and a paper strategy silently going quiet
 * for the rest of the day is worse than an overdrawn play-money balance. Instead
 * `check()` reports the shortfall, `noteShortfall()` records it, and the
 * Real-Time dashboard raises an alert banner. The pool simply goes negative,
 * which is the honest picture: this is how far past your money the book went.
 *
 * Design notes
 * ────────────
 * • Realized P&L is DERIVED, never duplicated. It is read from the same
 *   `~/trading-data/{mode}_paper_trades.json` files the History pages and the
 *   Real-Time wallet ribbon already render, so a history reset or a deleted
 *   session self-heals the pool with no extra wiring. Reads are memoised.
 * • A session's P&L only lands in that file when the session is saved (/stop or
 *   EOD). To keep the pool honest intraday, `release()` also accumulates the
 *   running session P&L in memory; that accumulator is dropped as soon as the
 *   file value moves (i.e. the session was saved), which is what prevents the
 *   same rupees being counted twice.
 * • Blocked capital is in-memory only. Open paper positions are in-memory too,
 *   so a restart clears both together. A lost block can only ever make the pool
 *   look richer, never poorer — it can never manufacture a phantom rejection.
 * • Purely observational. It can never place, size, alter OR stop an order, and
 *   every failure path fails OPEN.
 * • Models the OPTION PREMIUM outlay (`qty × premium`), which is what these
 *   strategies actually spend. Under `INSTRUMENT=NIFTY_FUTURES` there is no
 *   premium and no option poll, so the reservation stays at the assumed-premium
 *   estimate and is nominal — the P&L side of the pool is still exact. Nothing
 *   else in the app models futures margin either; don't read the blocked figure
 *   as exposure in that mode.
 * • Disabled during replay/simulation: a replay would otherwise be judged
 *   against TODAY's pool rather than the pool that existed when the session was
 *   recorded, which would make replays non-reproducible.
 *
 * Toggle: PAPER_CAPITAL_GATE_ENABLED (default true).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR = path.join(require("os").homedir(), "trading-data");

// Paper strategies and the broker pool each one draws from. Keys match the mode
// keys used by tradeLogger / skipLogger / portfolioRisk.
const STRATEGIES = {
  ema_rsi_st: { broker: "zerodha", label: "EMA_RSI_ST", file: "ema_rsi_st_paper_trades.json" },
  ema9vwap:   { broker: "zerodha", label: "EMA9+VWAP",  file: "ema9vwap_paper_trades.json"   },
  bb_rsi:     { broker: "fyers",   label: "BB_RSI",     file: "bb_rsi_paper_trades.json"     },
  pa:         { broker: "fyers",   label: "PA",         file: "pa_paper_trades.json"         },
  orb:        { broker: "fyers",   label: "ORB",        file: "orb_paper_trades.json"        },
  trend_pb:   { broker: "fyers",   label: "TREND_PB",   file: "trend_pb_paper_trades.json"   },
  gaps:       { broker: "fyers",   label: "GAPS",       file: "gaps_paper_trades.json"       },
};

const BROKER_ENV = { zerodha: "ZERODHA_INV_AMOUNT", fyers: "FYERS_INV_AMOUNT" };

// key -> { blocked, meta, sessionPnl, filePnlEpoch }
const _live = new Map();

function _liveOf(key) {
  let s = _live.get(key);
  if (!s) {
    s = { blocked: 0, meta: null, sessionPnl: 0, filePnlEpoch: _filePnl(key) };
    _live.set(key, s);
  }
  return s;
}

// ── Config ───────────────────────────────────────────────────────────────────

function isEnabled() {
  return (process.env.PAPER_CAPITAL_GATE_ENABLED || "true").toLowerCase() !== "false";
}

/**
 * Premium assumed when a strategy must decide BEFORE its option quote is known.
 * EMA_RSI_ST / EMA9+VWAP / BB_RSI / PA enter on a synchronous tick/candle
 * callback and only stamp the real premium on the first option poll ~1s later —
 * they block this estimate up front and true it up via `updateBlock()`.
 */
function estimatedPremium() {
  const v = parseFloat(process.env.PAPER_CAPITAL_EST_PREMIUM || "200");
  return Number.isFinite(v) && v > 0 ? v : 200;
}

function baseCapital(broker) {
  const v = parseFloat(process.env[BROKER_ENV[broker]] || "100000");
  return Number.isFinite(v) && v > 0 ? v : 100000;
}

function brokerOf(key) {
  return STRATEGIES[key] ? STRATEGIES[key].broker : null;
}

// ── Realized P&L (derived from the canonical paper-trade files) ──────────────

// Memoised because the entry gates can fire on every spot tick while flat; a
// few seconds of staleness is irrelevant for an all-time P&L figure.
const _MEMO_TTL_MS = 5000;
const _pnlMemo = new Map(); // key -> { ts, val }

function _filePnl(key) {
  const def = STRATEGIES[key];
  if (!def) return 0;
  const now = Date.now();
  const m = _pnlMemo.get(key);
  if (m && (now - m.ts) < _MEMO_TTL_MS) return m.val;
  let val = 0;
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, def.file), "utf8");
    const n = Number(JSON.parse(raw).totalPnl);
    if (Number.isFinite(n)) val = n;
  } catch (_) { /* missing/corrupt file → treat as no realized P&L */ }
  _pnlMemo.set(key, { ts: now, val });
  return val;
}

/**
 * All-time realized P&L for one strategy = what its saved sessions hold on disk,
 * plus the P&L of the session currently running (not yet written to that file).
 */
function realizedFor(key) {
  const filePnl = _filePnl(key);
  const s = _live.get(key);
  if (!s) return filePnl;
  // File moved → the running session was saved (or history was edited); its P&L
  // is now inside filePnl, so the in-memory accumulator must be dropped.
  if (s.filePnlEpoch !== filePnl) {
    s.sessionPnl = 0;
    s.filePnlEpoch = filePnl;
  }
  return parseFloat((filePnl + s.sessionPnl).toFixed(2));
}

function blockedFor(key) {
  const s = _live.get(key);
  return s ? s.blocked : 0;
}

// ── Pool ─────────────────────────────────────────────────────────────────────

/**
 * @returns {{broker:string, base:number, realized:number, blocked:number,
 *            available:number, positions:Array}}
 */
function getPool(broker) {
  const base = baseCapital(broker);
  let realized = 0, blocked = 0;
  const positions = [];
  for (const [key, def] of Object.entries(STRATEGIES)) {
    if (def.broker !== broker) continue;
    realized += realizedFor(key);
    const b = blockedFor(key);
    if (b > 0) {
      blocked += b;
      const s = _live.get(key);
      // Fixed fields last — meta is caller-supplied and must not clobber them.
      positions.push({ ...(s && s.meta ? s.meta : {}), key, label: def.label, blocked: b });
    }
  }
  realized = parseFloat(realized.toFixed(2));
  blocked  = parseFloat(blocked.toFixed(2));
  return {
    broker, base, realized, blocked,
    available: parseFloat((base + realized - blocked).toFixed(2)),
    positions,
  };
}

function snapshot() {
  return { zerodha: getPool("zerodha"), fyers: getPool("fyers") };
}

// ── Gate ─────────────────────────────────────────────────────────────────────

function _inReplay() {
  try { return require("../services/tickReplay").isReplayInProgress(); } catch (_) { return false; }
}

/**
 * Can `strategyKey` afford a `cost` rupee position right now?
 * ADVISORY ONLY — callers must not stop the trade on `ok:false`; they log it,
 * call `noteShortfall()` so the dashboard can alert, and carry on.
 * Never throws — any internal error fails OPEN so a disk hiccup can never halt
 * the book.
 *
 * @param {string} strategyKey  one of STRATEGIES
 * @param {number} cost         rupees needed (qty × entry premium)
 * @param {{sim?:boolean}} [opts] sim=true (replay / scenario tester) → no gate
 * @returns {{ok:boolean, disabled:boolean, cost:number, available:number, broker:string|null, reason:string}}
 */
function check(strategyKey, cost, opts = {}) {
  const off = (reason) => ({ ok: true, disabled: true, cost: 0, available: 0, broker: brokerOf(strategyKey), reason });
  try {
    if (opts.sim || _inReplay()) return off("capital gate skipped (simulation)");
    if (!isEnabled())            return off("capital gate disabled");
    const broker = brokerOf(strategyKey);
    if (!broker)                 return off(`capital gate: unknown strategy "${strategyKey}"`);
    const need = Number(cost);
    if (!Number.isFinite(need) || need <= 0) return off("capital gate: cost unknown");

    const pool = getPool(broker);
    const ok = need <= pool.available;
    return {
      ok, disabled: false, broker,
      cost: parseFloat(need.toFixed(2)),
      available: pool.available,
      reason: ok
        ? `capital ok — ₹${need.toFixed(0)} of ₹${pool.available.toFixed(0)} free in the ${broker.toUpperCase()} pool`
        : `insufficient ${broker.toUpperCase()} capital — needs ₹${need.toFixed(0)}, only ₹${pool.available.toFixed(0)} free `
          + `(₹${pool.base.toFixed(0)} invested, P&L ₹${pool.realized.toFixed(0)}, ₹${pool.blocked.toFixed(0)} in open positions)`,
    };
  } catch (err) {
    return off(`capital gate error (fail-open): ${err.message}`);
  }
}

// ── Shortfall alerts (surfaced by the Real-Time dashboard) ───────────────────
// Bounded ring: an overdrawn pool can fire once per entry all day, and this is a
// UI feed, not an audit trail — the skip log already keeps the full record.
const _MAX_ALERTS = 20;
let _alerts = [];

/**
 * Record that `strategyKey` entered a trade its broker pool could not fund.
 * Purely a notification — nothing in the trading path reads this back.
 */
function noteShortfall(strategyKey, cap, ctx = {}) {
  try {
    const def = STRATEGIES[strategyKey];
    if (!def || !cap) return;
    _alerts.push({
      ts: Date.now(),
      key: strategyKey,
      label: def.label,
      broker: def.broker,
      cost: cap.cost,
      available: cap.available,
      short: parseFloat((cap.cost - cap.available).toFixed(2)),
      side: ctx.side || null,
      symbol: ctx.symbol || null,
      reason: cap.reason,
    });
    if (_alerts.length > _MAX_ALERTS) _alerts = _alerts.slice(-_MAX_ALERTS);
  } catch (_) {}
}

// Midnight IST for `nowMs`, in epoch ms.
function _istDayStartMs(nowMs) {
  const IST_OFFSET = 19800000; // +05:30
  const t = (Number.isFinite(nowMs) ? nowMs : Date.now()) + IST_OFFSET;
  return Math.floor(t / 86400000) * 86400000 - IST_OFFSET;
}

/**
 * Newest-first shortfall alerts. Scoped to the current IST trading day unless
 * `sinceMs` says otherwise: the process runs for weeks under PM2, and a banner
 * still reporting a shortfall from three days ago is noise, not an alert.
 */
function getAlerts(sinceMs) {
  const cutoff = Number.isFinite(sinceMs) ? sinceMs : _istDayStartMs();
  return _alerts.filter(a => a.ts >= cutoff).reverse();
}

/** Reserve `cost` against the strategy's broker pool. Overwrites any stale block. */
function block(strategyKey, cost, meta = {}, opts = {}) {
  try {
    if (opts.sim || _inReplay() || !isEnabled() || !brokerOf(strategyKey)) return;
    const need = Number(cost);
    if (!Number.isFinite(need) || need <= 0) return;
    const s = _liveOf(strategyKey);
    s.blocked = parseFloat(need.toFixed(2));
    s.meta = meta || null;
    const pool = getPool(brokerOf(strategyKey));
    console.log(`💰 [CAPITAL] ${STRATEGIES[strategyKey].label} blocked ₹${need.toFixed(0)} — `
      + `${pool.broker.toUpperCase()} pool: ₹${pool.available.toFixed(0)} free of ₹${(pool.base + pool.realized).toFixed(0)}`);
  } catch (_) { /* never break an entry over accounting */ }
}

/**
 * Replace a provisional block with the real cost, once the true entry premium
 * is known. No-op when nothing is blocked (the trade was never gated).
 */
function updateBlock(strategyKey, cost, opts = {}) {
  try {
    if (opts.sim || _inReplay()) return;
    const s = _live.get(strategyKey);
    if (!s || s.blocked <= 0) return;
    const need = Number(cost);
    if (!Number.isFinite(need) || need <= 0) return;
    s.blocked = parseFloat(need.toFixed(2));
  } catch (_) {}
}

/**
 * Free the reservation and book the trade's net P&L into the running session
 * total. Safe to call when nothing is blocked.
 */
function release(strategyKey, netPnl, opts = {}) {
  try {
    if (!brokerOf(strategyKey)) return;
    // Free the reservation FIRST and unconditionally. Returning money is always
    // safe, and doing it before the sim/replay guard means a block can never be
    // stranded by the mode flag differing between entry and exit.
    const existing = _live.get(strategyKey);
    const wasBlocked = existing ? existing.blocked : 0;
    if (existing) { existing.blocked = 0; existing.meta = null; }

    if (opts.sim || _inReplay()) return;
    const s = _liveOf(strategyKey);
    const p = Number(netPnl);
    if (Number.isFinite(p)) {
      // Re-sync the epoch first so a session saved between entry and exit does
      // not make this trade's P&L land on top of a file value that already has it.
      realizedFor(strategyKey);
      s.sessionPnl = parseFloat((s.sessionPnl + p).toFixed(2));
    }
    if (wasBlocked > 0) {
      const pool = getPool(brokerOf(strategyKey));
      const shown = Number.isFinite(p) ? p : 0;   // never print ₹NaN
      console.log(`💰 [CAPITAL] ${STRATEGIES[strategyKey].label} released ₹${wasBlocked.toFixed(0)} `
        + `${shown >= 0 ? "+" : "−"}₹${Math.abs(shown).toFixed(0)} — `
        + `${pool.broker.toUpperCase()} pool: ₹${pool.available.toFixed(0)} free of ₹${(pool.base + pool.realized).toFixed(0)}`);
    }
  } catch (_) {}
}

/** Drop every reservation for a strategy (used when a session is force-stopped). */
function clear(strategyKey) {
  const s = _live.get(strategyKey);
  if (s) { s.blocked = 0; s.meta = null; }
}

// Exactly what the callers use — the per-broker/per-strategy accessors
// (getPool / brokerOf / baseCapital / realizedFor / blockedFor) stay internal;
// snapshot() already hands out everything a reader needs.
module.exports = {
  isEnabled,          // settings/UI: is the pool being tracked at all
  estimatedPremium,   // engines that decide before their option quote arrives
  check,              // advisory affordability report (never stops a trade)
  noteShortfall,      // record an entry the pool could not fund
  getAlerts,          // dashboard banner feed
  snapshot,           // both brokers, for /realtime/capital
  block,              // reserve on entry
  updateBlock,        // correct the reservation once the real premium lands
  release,            // free on exit and book the P&L
  clear,              // free without a P&L (session stopped without square-off)
};

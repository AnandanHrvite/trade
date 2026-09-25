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
 * When the pool cannot fund an entry the entry is REFUSED, exactly as a broker
 * would reject an order the account cannot pay for. `gate()` is the one call
 * every paper route makes before opening a position: it runs `check()`, records
 * the shortfall for the Real-Time alert banner and logs an error line; the route
 * then skip-logs the signal and returns without a position. The pool can still
 * read negative — realized losses shrink it — but it can no longer be pushed
 * further negative by new entries.
 *
 * Design notes
 * ────────────
 * • Realized P&L is DERIVED, never duplicated. It is read from the same
 *   `~/trading-data/{mode}_paper_trades.json` files the History pages already
 *   render, so a history reset or a deleted session self-heals the pool with no
 *   extra wiring. Reads are memoised. (The Real-Time wallet ribbon reads this
 *   module instead, so it can never disagree with the pool.)
 * • A session's P&L only lands in that file when the session is saved (/stop or
 *   EOD). To keep the pool honest intraday, `release()` also accumulates the
 *   running session P&L in memory; that accumulator is dropped as soon as the
 *   file value moves (i.e. the session was saved), which is what prevents the
 *   same rupees being counted twice.
 * • Blocked capital is in-memory only. Open paper positions are in-memory too,
 *   so a restart clears both together. A lost block can only ever make the pool
 *   look richer, never poorer — it can never manufacture a phantom rejection.
 * • It can refuse an entry but never place, size or alter one. Every INTERNAL
 *   failure path (disk hiccup, unknown strategy, unknown cost) fails OPEN — an
 *   accounting error must not halt the book; only a genuine shortfall does.
 * • Models the OPTION PREMIUM outlay (`qty × premium`), which is what these
 *   strategies actually spend. Under `INSTRUMENT=NIFTY_FUTURES` the routes that
 *   know their fill price reserve SPAN+exposure MARGIN instead, via
 *   instrumentMode.capitalRequired() (NIFTY_FUTURES_MARGIN_PCT, default 11%) —
 *   reserving the notional there would read ~₹15.6L against a lot that really
 *   blocks ~₹1.7L and would log a false "overdrawn" on every entry. Routes that
 *   size off capitalPool.estimatedPremium() instead stay nominal in that mode.
 *   The P&L side of the pool is exact either way.
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
  rsi_pivot_st: { broker: "zerodha", label: "RSI_PIVOT_ST", file: "rsi_pivot_st_paper_trades.json" },
  // Same engine as rsi_pivot_st, NIFTY BANK underlying — Zerodha orders, so it
  // draws from the same ZERODHA_INV_AMOUNT pool as the NIFTY sibling.
  bn_pivot_rsi_st: { broker: "zerodha", label: "BN_PIVOT_RSI_ST (NIFTY BANK)", file: "bn_pivot_rsi_st_paper_trades.json" },
  // EMA_RSI_ST_V2 — the EMA_RSI_ST clone. Zerodha orders like its V1 sibling, so
  // it draws from the same ZERODHA_INV_AMOUNT pool.
  ema_rsi_st_v2: { broker: "zerodha", label: "EMA_RSI_ST_V2", file: "ema_rsi_st_v2_paper_trades.json" },
  // Same engine on NIFTY BANK — Zerodha orders, so it draws from the same
  // ZERODHA_INV_AMOUNT pool as its NIFTY sibling.
  bn_ema_rsi_st_v2: { broker: "zerodha", label: "BN_EMA_RSI_ST_V2 (NIFTY BANK)", file: "bn_ema_rsi_st_v2_paper_trades.json" },
  simple930: { broker: "zerodha", label: "SIMPLE_9:30", file: "simple930_paper_trades.json" },
  ha_scalp:  { broker: "zerodha", label: "HA_SCALP",    file: "ha_scalp_paper_trades.json"  },
  early_bird: { broker: "fyers",  label: "EARLYBIRD",   file: "early_bird_paper_trades.json" },
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
 * Pure report — no logging, no side effects. Routes go through `gate()`.
 * Never throws — any internal error fails OPEN so a disk hiccup can never halt
 * the book.
 *
 * @param {string} strategyKey  one of STRATEGIES
 * @param {number} cost         rupees needed (qty × entry premium)
 * @param {{sim?:boolean, qty?:number}} [opts] sim=true (replay / scenario
 *        tester) → no gate; qty is only used to word the reason
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
    const forQty = Number.isFinite(Number(opts.qty)) && Number(opts.qty) > 0 ? ` for ${Number(opts.qty)} qty` : "";
    return {
      ok, disabled: false, broker,
      cost: parseFloat(need.toFixed(2)),
      available: pool.available,
      reason: ok
        ? `capital ok — ₹${need.toFixed(0)}${forQty} of ₹${pool.available.toFixed(0)} free in the ${broker.toUpperCase()} pool`
        : `insufficient ${broker.toUpperCase()} capital — needs ₹${need.toFixed(0)}${forQty}, only ₹${pool.available.toFixed(0)} free `
          + `(₹${pool.base.toFixed(0)} invested, P&L ₹${pool.realized.toFixed(0)}, ₹${pool.blocked.toFixed(0)} in open positions)`,
    };
  } catch (err) {
    return off(`capital gate error (fail-open): ${err.message}`);
  }
}

// ── Entry gate ───────────────────────────────────────────────────────────────

// A strategy whose signal keeps re-arming (a sustained trigger, an intra-candle
// retry) would otherwise print the same refusal every few seconds for the rest
// of the day. Repeats inside this window are still REFUSED — only the error
// line, the skip-log row and the dashboard alert are suppressed (`muted:true`).
const GATE_REPEAT_MUTE_MS = 60 * 1000;
const _lastRefusal = new Map(); // strategyKey -> ms of the last logged refusal

/**
 * The hard capital gate every paper route runs before opening a position.
 * Returns `check()`'s report; on `ok:false` the entry MUST NOT be taken. The
 * gate itself logs the error line and records the dashboard alert, so a route
 * only has to skip-log the signal with its own tag and return. `muted` tells the
 * route the same strategy was refused within the last minute, so it can keep
 * its own log quiet too.
 *
 * @param {string} strategyKey  one of STRATEGIES
 * @param {number} cost         rupees needed (qty × entry premium, or margin)
 * @param {{side?:string, symbol?:string, qty?:number}} [ctx]  wording + alert
 * @param {{sim?:boolean}} [opts]  sim=true (replay / scenario tester) → no gate
 * @returns {{ok:boolean, muted:boolean, disabled:boolean, cost:number, available:number, broker:string|null, reason:string}}
 */
function gate(strategyKey, cost, ctx = {}, opts = {}) {
  const cap = check(strategyKey, cost, { sim: opts.sim, qty: ctx.qty });
  if (cap.ok) return { ...cap, muted: false };
  let muted = false;
  try {
    const now = Date.now();
    const last = _lastRefusal.get(strategyKey) || 0;
    muted = (now - last) < GATE_REPEAT_MUTE_MS;
    if (!muted) {
      _lastRefusal.set(strategyKey, now);
      noteShortfall(strategyKey, cap, ctx);
      const def = STRATEGIES[strategyKey];
      const what = [ctx.side, ctx.symbol].filter(Boolean).join(" ");
      console.error(`❌ [CAPITAL] ${def ? def.label : strategyKey} entry REFUSED${what ? ` (${what})` : ""} — ${cap.reason}`);
    }
  } catch (_) { /* logging must never change the verdict */ }
  return { ...cap, muted };
}

// ── Shortfall alerts (surfaced by the Real-Time dashboard) ───────────────────
// Bounded ring: an overdrawn pool can fire once per entry all day, and this is a
// UI feed, not an audit trail — the skip log already keeps the full record.
const _MAX_ALERTS = 20;
let _alerts = [];

/**
 * Record that `strategyKey` was refused an entry its broker pool could not
 * fund. Purely a notification — nothing in the trading path reads this back.
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
  check,              // pure affordability report (no side effects)
  gate,               // the hard entry gate — ok:false means DO NOT enter
  noteShortfall,      // record an entry the pool refused
  getAlerts,          // dashboard banner feed
  snapshot,           // both brokers, for /realtime/capital
  block,              // reserve on entry
  updateBlock,        // correct the reservation once the real premium lands
  release,            // free on exit and book the P&L
  clear,              // free without a P&L (session stopped without square-off)
};

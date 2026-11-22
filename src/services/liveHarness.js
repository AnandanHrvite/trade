/**
 * liveHarness.js — mirrors a PAPER engine's decisions as broker orders
 * ─────────────────────────────────────────────────────────────────────────────
 * LIVE = PAPER by construction. The paper route decides every entry and exit
 * and calls notify.notifyEntry / notifyExit as it always has; this module
 * registers hooks on those calls (utils/notify.js setOrderHooks) and turns them
 * into orders. No strategy rule, fill rule or exit rule lives here.
 *
 *   PAPER (canonical, untouched) ── notifyEntry({ mode:"HA-SCALP-PAPER", symbol, qty, … })
 *                                        │
 *                               entry hook (this file)
 *                                        │
 *                 Live page    → fyersBroker.placeMarketOrder  (REAL money)
 *                 Harness page → simBroker.placeMarketOrder    (no order leaves the box)
 *
 * The Harness runs the SAME code path as Live — dedupe, unconfirmed-fill block,
 * fill confirmation, reconcile-before-exit, record keeping — with only the
 * broker swapped for an in-process simulator. A clean Harness day is evidence
 * the Live path behaves; it never sends anything to Fyers.
 *
 * Real orders need BOTH switches (re-read before every NEW entry, so switching
 * either off in Settings stops new real entries at once; exits still go out —
 * an open position must always be closable):
 *   LIVE_TRADING_ENABLED=true        global master switch (default false)
 *   {PREFIX}_REAL_ORDERS_ENABLED=true       this strategy (default false)
 *
 * Safety invariants (each one is a past or obvious way to lose money):
 *   • A SELL only ever follows a proven BUY fill — `_realPositions` is the
 *     authority; a rejected entry never turns paper's later exit into a naked short.
 *   • "Accepted" is not "filled": every order is confirmed against the order book.
 *   • A timed-out / unknown-outcome entry BLOCKS further real entries for that
 *     mode until the operator verifies at the broker and clears it.
 *   • Before a SELL the broker book is read; an empty/unreadable book is
 *     "can't verify" (null), never "flat" (Fyers returns [] on token expiry).
 *   • Real positions persist to disk (atomic) so a restart can still square off.
 *   • Every event is appended to ~/trading-data/live/orders_YYYY-MM-DD.jsonl.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const fs          = require("fs");
const path        = require("path");
const os          = require("os");
const notify      = require("../utils/notify");
const fyersBroker = require("./fyersBroker");

const DATA_DIR  = path.join(os.homedir(), "trading-data");
const LIVE_DIR  = path.join(DATA_DIR, "live");
const POS_FILE  = path.join(DATA_DIR, ".live_real_positions.json");
const RING_MAX  = 300;

const _harnesses        = new Map();   // mode → cfg
const _realPositions    = new Map();   // `${mode}|${symbol}` → record
const _pendingEntries   = new Map();   // key → promise
const _exiting          = new Map();   // key → promise
const _unconfirmed      = new Set();   // modes blocked after an unknown-outcome order
const _events           = [];          // ring buffer for the pages

function _key(mode, symbol) { return `${mode}|${symbol}`; }
function _keysForMode(map, mode) { return [...map.keys()].filter((k) => k.startsWith(`${mode}|`)); }
function _tg(text) { try { notify.sendIfMaster(text); } catch (_) {} }
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _istDate(ms = Date.now()) {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// ── Switches (read live — Settings mutates process.env in-process) ───────────
function _on(key) { return String(process.env[key] || "false").trim().toLowerCase() === "true"; }
function globalLiveEnabled() { return _on("LIVE_TRADING_ENABLED"); }
function strategyLiveEnabled(prefix) { return _on(`${prefix}_REAL_ORDERS_ENABLED`); }
/** True only when BOTH switches allow real orders for this strategy prefix. */
function realOrdersAllowed(prefix) { return globalLiveEnabled() && strategyLiveEnabled(prefix); }

function _brokerTimeoutMs() {
  const v = parseInt(process.env.LIVE_BROKER_TIMEOUT_MS || "8000", 10);
  return Number.isFinite(v) ? Math.min(30000, Math.max(1500, v)) : 8000;
}
function _withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ── Audit trail: append-only per-day JSONL + an in-memory ring ───────────────
function _loadTodayEvents() {
  try {
    const f = path.join(LIVE_DIR, `orders_${_istDate()}.jsonl`);
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-RING_MAX);
    for (const l of lines) { try { _events.push(JSON.parse(l)); } catch (_) {} }
  } catch (_) { /* no file yet today */ }
}
_loadTodayEvents();

function _logEvent(evt) {
  const row = { t: Date.now(), ...evt };
  _events.push(row);
  if (_events.length > RING_MAX) _events.splice(0, _events.length - RING_MAX);
  try {
    if (!fs.existsSync(LIVE_DIR)) fs.mkdirSync(LIVE_DIR, { recursive: true });
    fs.appendFile(path.join(LIVE_DIR, `orders_${_istDate(row.t)}.jsonl`), JSON.stringify(row) + "\n",
      (e) => { if (e) console.error(`[LIVE] audit append failed: ${e.message}`); });
  } catch (e) { console.error(`[LIVE] audit append failed: ${e.message}`); }
}

// ── Real-position persistence (atomic tmp → rename) ──────────────────────────
// Only LIVE (real-broker) records are written; simulator records never touch disk.
function _readPosFile() {
  try { const o = JSON.parse(fs.readFileSync(POS_FILE, "utf8")); return o && typeof o === "object" ? o : {}; }
  catch (_) { return {}; }
}
// Modes whose real records have been loaded into / written from memory own their
// rows on disk; any other mode's rows are carried over untouched.
const _ownedModes = new Set();
function _persist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const r of _realPositions.values()) if (!r.sim) _ownedModes.add(r.mode);
    const out = {};
    for (const [k, v] of Object.entries(_readPosFile())) if (!_ownedModes.has(v && v.mode)) out[k] = v;
    for (const [k, r] of _realPositions) {
      if (r.sim) continue;
      out[k] = { mode: r.mode, symbol: r.symbol, qty: r.qty, orderId: r.orderId || null, ts: r.ts,
        direction: r.direction, isFutures: !!r.isFutures, confirmed: r.confirmed !== false,
        avgPrice: r.avgPrice || null, savedDate: _istDate(r.ts) };
    }
    const tmp = POS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, POS_FILE);
  } catch (e) { console.error(`[LIVE] failed to persist real positions: ${e.message}`); }
}
/** Real positions recorded on disk (any mode) — for the boot alert and the pages. */
function persistedRealPositions(mode) {
  return Object.values(_readPosFile()).filter((v) => v && v.symbol && v.qty > 0 && (!mode || v.mode === mode));
}

function _setReal(cfg, rec) {
  if (cfg.dryRun) rec.sim = true;
  _realPositions.set(_key(cfg.mode, rec.symbol), rec);
  if (!cfg.dryRun) _persist();
}
function _restore(mode, rows) {
  for (const r of rows) _realPositions.set(_key(mode, r.symbol), { ...r, _restored: true });
  _ownedModes.add(mode);
}
function _clearReal(cfg, rec) {
  const k = _key(cfg.mode, rec.symbol);
  if (_realPositions.get(k) === rec) { _realPositions.delete(k); if (!cfg.dryRun) _persist(); }
}

// ── Simulated broker (Harness) ───────────────────────────────────────────────
// Same surface as fyersBroker for the calls this file makes. Fills instantly at
// the price paper reported, so the Harness record shows the price paper used.
function _makeSimBroker() {
  const orders = [];
  const net = new Map();   // symbol → signed qty
  let seq = 0;
  return {
    isSim: true,
    isAuthenticated: () => true,
    async placeMarketOrder(symbol, side, qty, tag, opts = {}) {
      if (!Number.isInteger(qty) || qty <= 0) return { success: false, orderId: null, raw: { error: `Invalid qty: ${qty}` } };
      const id = `SIM-${Date.now()}-${++seq}`;
      orders.push({ id, symbol, qty, side, status: 2, filledQty: qty, tradedPrice: opts.refPrice || 0 });
      net.set(symbol, (net.get(symbol) || 0) + side * qty);
      return { success: true, orderId: id, raw: { s: "ok", id, simulated: true } };
    },
    async getOrders() { return orders.slice(); },
    async getPositions() {
      return { netPositions: [...net.entries()].map(([symbol, q]) => ({ symbol, netQty: q })) };
    },
  };
}

// ── Order helpers ────────────────────────────────────────────────────────────
// Options are always BOUGHT (LONG). Futures: CE = LONG, PE = SHORT.
function _isFutures(cfg, p) { return typeof p.isFutures === "boolean" ? p.isFutures : cfg.isFutures(); }
function _direction(cfg, p) { return String(p.side).toUpperCase() === "PE" && _isFutures(cfg, p) ? "SHORT" : "LONG"; }
const _entryAction = (d) => (d === "SHORT" ? "SELL" : "BUY");
const _exitAction  = (d) => (d === "SHORT" ? "BUY" : "SELL");

function _place(cfg, { symbol, qty, action, isFutures, isExit, refPrice }) {
  return cfg.broker.placeMarketOrder(symbol, action === "BUY" ? 1 : -1, qty,
    `${cfg.tag}${isExit ? "-X" : ""}`, { isFutures, isExit: !!isExit, refPrice });
}

// Fyers order status: 2 traded · 1 cancelled · 5 rejected · 7 expired · 4/6 pending.
function _orderStatus(row) {
  const st = Number(row.status);
  const filled = Number(row.filledQty) || 0;
  const avg = Number(row.tradedPrice) || null;
  if (st === 2) return { state: "FILLED", filledQty: filled || Number(row.qty) || 0, avgPrice: avg };
  if (st === 1 || st === 5 || st === 7) {
    return filled > 0 ? { state: "FILLED", filledQty: filled, avgPrice: avg, partial: true }
                      : { state: "REJECTED", reason: row.message || `status ${st}` };
  }
  return { state: "PENDING" };
}
async function _confirmFill(cfg, orderId) {
  if (!orderId) return { state: "UNKNOWN" };
  const deadline = Date.now() + _brokerTimeoutMs();
  while (Date.now() < deadline) {
    try {
      const rows = await _withTimeout(cfg.broker.getOrders(), Math.max(500, deadline - Date.now()), "getOrders");
      const row = (Array.isArray(rows) ? rows : []).find((o) => String(o.id) === String(orderId));
      if (row) { const s = _orderStatus(row); if (s.state !== "PENDING") return s; }
    } catch (_) { /* keep polling until the deadline */ }
    if (Date.now() + 400 >= deadline) break;
    await _sleep(400);
  }
  return { state: "UNKNOWN" };
}

// Held qty at the broker: null = can't verify, 0 = flat, N = holding N.
// An empty book is AMBIGUOUS (token expiry / swallowed error) → null.
async function _heldQty(cfg, symbol) {
  try {
    if (!cfg.broker.isAuthenticated()) return null;
    const pos = await _withTimeout(cfg.broker.getPositions(), Math.min(_brokerTimeoutMs(), 4000), "getPositions");
    const list = (pos && pos.netPositions) || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    const row = list.find((r) => r.symbol === symbol);
    if (!row) console.warn(`[LIVE][${cfg.mode}] reconcile: ${symbol} not in broker book (${list.length} other row(s)) — treating as flat.`);
    return row ? Math.abs(Number(row.netQty) || 0) : 0;
  } catch (e) {
    console.warn(`[LIVE][${cfg.mode}] position read failed: ${e.message}`);
    return null;
  }
}

function _label(cfg) { return cfg.dryRun ? "HARNESS" : "LIVE"; }
function _alert(cfg, text) { if (!cfg.dryRun) _tg(text); }   // the Harness never pages the phone

// ── Entry hook ───────────────────────────────────────────────────────────────
function _makeEntryHook(cfg) {
  return function entryHook(p) {
    if (!p || p.mode !== cfg.modeTag) return;
    const symbol = p.symbol ? String(p.symbol).trim() : "";
    const qty = Number(p.qty);
    const isFut = _isFutures(cfg, p);
    const direction = _direction(cfg, p);
    const action = _entryAction(direction);
    const L = _label(cfg);

    if (!cfg.dryRun && !realOrdersAllowed(cfg.envPrefix)) {
      _logEvent({ mode: cfg.mode, event: "ENTRY_SKIPPED_SWITCH_OFF", symbol, qty, side: p.side });
      console.warn(`⏸️ [${L}][${cfg.mode}] ${action} ${qty}× ${symbol} NOT placed — LIVE_TRADING_ENABLED / ${cfg.envPrefix}_REAL_ORDERS_ENABLED is off. Exits still go out.`);
      _alert(cfg, `⏸️ ${cfg.mode} — paper entered ${symbol} but NO real order was placed: a live switch is OFF.`);
      return;
    }
    if (!symbol || !Number.isInteger(qty) || qty <= 0) {
      _logEvent({ mode: cfg.mode, event: "ENTRY_SKIPPED_BAD_PAYLOAD", symbol, qty, side: p.side });
      console.error(`🚨 [${L}][${cfg.mode}] entry skipped — bad symbol/qty from paper (symbol=${symbol || "—"}, qty=${p.qty}).`);
      _alert(cfg, `🚨 ${cfg.mode} — paper entered but symbol/qty was invalid (${symbol || "—"} × ${p.qty}). NO real order placed.`);
      return;
    }
    if (_unconfirmed.has(cfg.mode)) {
      _logEvent({ mode: cfg.mode, event: "ENTRY_BLOCKED_UNCONFIRMED", symbol, qty });
      console.error(`🛑 [${L}][${cfg.mode}] ${action} blocked — an earlier order's fill is UNCONFIRMED. Verify at the broker, then press "Clear block".`);
      _alert(cfg, `🛑 ${cfg.mode} — ${action} ${qty}× ${symbol} BLOCKED: an earlier order is still UNCONFIRMED. Check Fyers, then press "Clear block" on the Live page.`);
      return;
    }
    const k = _key(cfg.mode, symbol);
    if (_pendingEntries.has(k) || (_realPositions.has(k) && !_exiting.has(k))) {
      _logEvent({ mode: cfg.mode, event: "ENTRY_SKIPPED_DUPLICATE", symbol, qty });
      console.warn(`⏭️ [${L}][${cfg.mode}] ${action} skipped — already in flight / still held for ${symbol}.`);
      _alert(cfg, `⏭️ ${cfg.mode} — ${action} ${symbol} skipped: an entry is in flight or the position is still held.`);
      return;
    }

    const run = (async () => {
      const startedAt = Date.now();
      try {
        const inflightExit = _exiting.get(k);
        if (inflightExit) { try { await inflightExit; } catch (_) {} }
        if (_realPositions.has(k)) {
          _logEvent({ mode: cfg.mode, event: "ENTRY_SKIPPED_STILL_HELD", symbol });
          _alert(cfg, `🚨 ${cfg.mode} — ${action} ${symbol} skipped: the previous position on it is still held. Square off manually.`);
          return;
        }
        let result, err = null;
        try {
          result = await _withTimeout(_place(cfg, { symbol, qty, action, isFutures: isFut, refPrice: p.optionEntryLtp }), _brokerTimeoutMs(), action);
        } catch (e) { err = e; }
        const base = { mode: cfg.mode, symbol, qty, direction, isFutures: isFut, ts: Date.now() };

        if (err || (result && result.uncertain)) {
          const why = err ? err.message : JSON.stringify(result.raw).slice(0, 200);
          _unconfirmed.add(cfg.mode);
          _setReal(cfg, { ...base, orderId: (result && result.orderId) || null, confirmed: false });
          _logEvent({ mode: cfg.mode, event: "ENTRY_UNKNOWN", symbol, qty, action, error: why });
          console.error(`🚨 [${L}][${cfg.mode}] ${action} outcome UNKNOWN: ${why}`);
          _alert(cfg, `🚨 ${cfg.mode} LIVE ${action} — OUTCOME UNKNOWN\n${symbol}: ${why}\nNew entries are BLOCKED until you check Fyers and press "Clear block".`);
          return;
        }
        if (!(result && result.success)) {
          _logEvent({ mode: cfg.mode, event: "ENTRY_REJECTED", symbol, qty, action, raw: result && result.raw });
          console.error(`🚨 [${L}][${cfg.mode}] ${action} REJECTED — ${symbol} | ${JSON.stringify(result && result.raw).slice(0, 200)}`);
          _alert(cfg, `🚨 ${cfg.mode} LIVE ${action} REJECTED — you are NOT in this trade.\n${symbol}\n${JSON.stringify(result && result.raw).slice(0, 200)}`);
          return;
        }
        const fill = await _confirmFill(cfg, result.orderId);
        if (fill.state === "REJECTED") {
          _logEvent({ mode: cfg.mode, event: "ENTRY_REJECTED_AFTER_ACCEPT", symbol, qty, orderId: result.orderId, reason: fill.reason });
          console.error(`🚨 [${L}][${cfg.mode}] ${action} ${result.orderId} accepted then REJECTED: ${fill.reason}`);
          _alert(cfg, `🚨 ${cfg.mode} LIVE ${action} rejected after acceptance — you are NOT in this trade.\n${symbol}: ${fill.reason}`);
          return;
        }
        if (fill.state !== "FILLED") {
          _unconfirmed.add(cfg.mode);
          _setReal(cfg, { ...base, orderId: result.orderId, confirmed: false });
          _logEvent({ mode: cfg.mode, event: "ENTRY_FILL_UNCONFIRMED", symbol, qty, orderId: result.orderId });
          console.error(`🚨 [${L}][${cfg.mode}] ${action} ${result.orderId} accepted but no fill seen in ${_brokerTimeoutMs()}ms.`);
          _alert(cfg, `⚠️ ${cfg.mode} LIVE ${action} — FILL UNCONFIRMED\n${symbol} order ${result.orderId}. New entries BLOCKED until you check Fyers and press "Clear block".`);
          return;
        }
        const filledQty = fill.filledQty > 0 ? fill.filledQty : qty;
        const rec = { ...base, qty: filledQty, orderId: result.orderId, confirmed: true, avgPrice: fill.avgPrice || null,
          paperEntryPrice: p.optionEntryLtp ?? null };
        _setReal(cfg, rec);
        _logEvent({ mode: cfg.mode, event: "ENTRY_FILLED", symbol, qty: filledQty, action, direction, orderId: result.orderId,
          avgPrice: rec.avgPrice, paperPrice: rec.paperEntryPrice, latencyMs: Date.now() - startedAt, partial: !!fill.partial });
        console.log(`✅ [${L}][${cfg.mode}] ${action} ${filledQty}× ${symbol} filled @ ${rec.avgPrice ?? "?"} (paper ${rec.paperEntryPrice ?? "?"}) orderId=${result.orderId} in ${Date.now() - startedAt}ms${fill.partial ? " (PARTIAL)" : ""}`);
        if (fill.partial) _alert(cfg, `⚠️ ${cfg.mode} — ${action} ${symbol} PARTIALLY filled: ${filledQty}/${qty}. Tracking ${filledQty}.`);
      } catch (e) {
        _unconfirmed.add(cfg.mode);
        _logEvent({ mode: cfg.mode, event: "ENTRY_UNKNOWN", symbol, error: e.message });
        console.error(`🚨 [${L}][${cfg.mode}] entry exception: ${e.message}`);
        _alert(cfg, `🚨 ${cfg.mode} LIVE ENTRY ERROR — OUTCOME UNKNOWN\n${symbol}: ${e.message}\nNew entries BLOCKED until you check Fyers and press "Clear block".`);
      } finally {
        if (_pendingEntries.get(k) === run) _pendingEntries.delete(k);
      }
    })();
    _pendingEntries.set(k, run);   // set synchronously: a fast exit awaits it
  };
}

// ── Exit ─────────────────────────────────────────────────────────────────────
function _makeExitHook(cfg) {
  return async function exitHook(p) {
    if (!p || p.mode !== cfg.modeTag) return;
    let symbol = p.symbol ? String(p.symbol).trim() : "";
    if (!symbol) {
      const keys = [...new Set([..._keysForMode(_realPositions, cfg.mode), ..._keysForMode(_pendingEntries, cfg.mode)])];
      if (keys.length === 1) symbol = keys[0].slice(cfg.mode.length + 1);
    }
    if (!symbol) {
      _logEvent({ mode: cfg.mode, event: "EXIT_SKIPPED_NO_SYMBOL" });
      _alert(cfg, `🚨 ${cfg.mode} — paper exited but named no symbol. Check open positions on Fyers manually.`);
      return;
    }
    await _exitSymbol(cfg, symbol, { reason: p.exitReason, paperPrice: p.optionExitLtp ?? null, paperPnl: p.pnl ?? null });
  };
}

async function _exitSymbol(cfg, symbol, info = {}) {
  const k = _key(cfg.mode, symbol);
  const pending = _pendingEntries.get(k);
  if (pending) { try { await pending; } catch (_) {} }
  const real = _realPositions.get(k);
  if (!real) {
    _logEvent({ mode: cfg.mode, event: "EXIT_SKIPPED_NO_POSITION", symbol, reason: info.reason });
    console.warn(`⏭️ [${_label(cfg)}][${cfg.mode}] paper exit on ${symbol} but no real position held — nothing sent.`);
    return;
  }
  if (_exiting.has(k)) {
    _logEvent({ mode: cfg.mode, event: "EXIT_SKIPPED_IN_FLIGHT", symbol });
    return _exiting.get(k);
  }
  const run = _doExit(cfg, real, info);
  _exiting.set(k, run);
  try { await run; } finally { if (_exiting.get(k) === run) _exiting.delete(k); }
}

async function _doExit(cfg, real, info) {
  const L = _label(cfg);
  const action = _exitAction(real.direction);
  const sym = real.symbol;
  const startedAt = Date.now();
  const held = await _heldQty(cfg, sym);

  if (held === 0) {
    _clearReal(cfg, real);
    _logEvent({ mode: cfg.mode, event: "EXIT_ALREADY_FLAT", symbol: sym });
    console.warn(`⏭️ [${L}][${cfg.mode}] broker shows FLAT on ${sym} — no ${action} sent.`);
    _alert(cfg, `⏭️ ${cfg.mode} — Fyers already shows FLAT on ${sym}; no ${action} sent.`);
    return;
  }
  if (held === null && (real._restored || real.confirmed === false)) {
    _logEvent({ mode: cfg.mode, event: "EXIT_UNVERIFIED", symbol: sym });
    console.error(`🚨 [${L}][${cfg.mode}] cannot read the broker book to verify ${sym} — NOT auto-closing.`);
    _alert(cfg, `🚨 ${cfg.mode} — could not read Fyers positions to verify ${sym}; NOT auto-closing. Check and square off manually.`);
    return;
  }
  const exitQty = held && held > 0 ? Math.min(real.qty, held) : real.qty;

  let result, err = null;
  try {
    result = await _withTimeout(_place(cfg, { symbol: sym, qty: exitQty, action, isFutures: !!real.isFutures, isExit: true, refPrice: info.paperPrice }),
      _brokerTimeoutMs(), action);
  } catch (e) { err = e; }

  if (err || (result && result.uncertain)) {
    const why = err ? err.message : JSON.stringify(result.raw).slice(0, 200);
    _logEvent({ mode: cfg.mode, event: "EXIT_UNKNOWN", symbol: sym, action, error: why });
    console.error(`🚨 [${L}][${cfg.mode}] ${action} (exit) outcome UNKNOWN: ${why}`);
    _alert(cfg, `🚨 ${cfg.mode} LIVE EXIT — OUTCOME UNKNOWN\n${sym}: ${why}\nVerify on Fyers and square off manually NOW if still open.`);
    return;
  }
  if (!(result && result.success)) {
    _logEvent({ mode: cfg.mode, event: "EXIT_REJECTED", symbol: sym, action, raw: result && result.raw });
    console.error(`🚨 [${L}][${cfg.mode}] ${action} (exit) REJECTED on ${sym} — MANUAL square-off needed.`);
    _alert(cfg, `🚨 ${cfg.mode} LIVE EXIT REJECTED — square off ${sym} manually NOW.\n${JSON.stringify(result && result.raw).slice(0, 200)}`);
    return;
  }
  const fill = await _confirmFill(cfg, result.orderId);
  if (fill.state === "REJECTED") {
    _logEvent({ mode: cfg.mode, event: "EXIT_REJECTED_AFTER_ACCEPT", symbol: sym, orderId: result.orderId, reason: fill.reason });
    console.error(`🚨 [${L}][${cfg.mode}] exit ${result.orderId} rejected after acceptance: ${fill.reason} — position STILL OPEN.`);
    _alert(cfg, `🚨 ${cfg.mode} LIVE EXIT rejected after acceptance — ${sym} is STILL OPEN. Square off manually NOW.\n${fill.reason}`);
    return;
  }
  if (fill.state !== "FILLED") {
    _logEvent({ mode: cfg.mode, event: "EXIT_FILL_UNCONFIRMED", symbol: sym, orderId: result.orderId });
    console.error(`🚨 [${L}][${cfg.mode}] exit ${result.orderId} accepted, no fill seen — record kept; press "Square off now" to re-check.`);
    _alert(cfg, `⚠️ ${cfg.mode} LIVE EXIT — fill not confirmed for ${sym} (order ${result.orderId}). Check Fyers; press "Square off now" to re-check.`);
    return;
  }
  const heldBefore = held && held > 0 ? held : real.qty;
  const remaining = heldBefore - (fill.filledQty || exitQty);
  const sign = real.direction === "SHORT" ? -1 : 1;
  const realPnl = (real.avgPrice && fill.avgPrice)
    ? +(((fill.avgPrice - real.avgPrice) * sign) * (fill.filledQty || exitQty)).toFixed(2) : null;
  if (remaining > 0) {
    real.qty = remaining;
    if (!cfg.dryRun) _persist();
    _alert(cfg, `⚠️ ${cfg.mode} — exit on ${sym} PARTIALLY filled; ${remaining} still open. Press "Square off now" or close manually.`);
  } else {
    _clearReal(cfg, real);
  }
  _logEvent({ mode: cfg.mode, event: "EXIT_FILLED", symbol: sym, action, qty: fill.filledQty || exitQty, orderId: result.orderId,
    avgPrice: fill.avgPrice || null, entryAvgPrice: real.avgPrice || null, paperPrice: info.paperPrice ?? null,
    paperPnl: info.paperPnl ?? null, realGrossPnl: realPnl, reason: info.reason || null, latencyMs: Date.now() - startedAt });
  console.log(`✅ [${L}][${cfg.mode}] ${action} (exit) ${sym} filled @ ${fill.avgPrice ?? "?"} (paper ${info.paperPrice ?? "?"}) — gross ₹${realPnl ?? "?"} | ${info.reason || ""}`);
}

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * install({ mode, modeTag, envPrefix, dryRun, isFutures })
 *   mode      "HA_SCALP-LIVE" | "HA_SCALP-HARNESS"  (unique per page)
 *   modeTag   the paper route's notify `mode` field, e.g. "HA-SCALP-PAPER"
 *   envPrefix the strategy's env prefix (for {PREFIX}_REAL_ORDERS_ENABLED)
 *   dryRun    true → simulated broker (Harness); false → Fyers (Live)
 *   isFutures () => boolean, read per order when the payload doesn't say
 *   onSessionEnd optional callback when paper's session ends
 */
function install({ mode, modeTag, envPrefix, dryRun, isFutures, onSessionEnd } = {}) {
  if (!mode || !modeTag || !envPrefix || typeof dryRun !== "boolean") throw new Error("install requires { mode, modeTag, envPrefix, dryRun }");
  if (_harnesses.has(mode)) throw new Error(`${mode} is already running.`);
  for (const c of _harnesses.values()) {
    if (c.modeTag === modeTag) throw new Error(`${c.mode} is already attached to this paper engine — stop it first.`);
  }
  const cfg = {
    mode, modeTag, envPrefix, dryRun,
    tag: String(mode).replace(/[^A-Za-z0-9]/g, "").slice(0, 16),
    broker: dryRun ? _makeSimBroker() : fyersBroker,
    isFutures: typeof isFutures === "function" ? isFutures : () => !!isFutures,
    startedAt: Date.now(),
  };
  _harnesses.set(mode, cfg);
  notify.setOrderHooks(mode, {
    entry: _makeEntryHook(cfg),
    exit: _makeExitHook(cfg),
    sessionEnd: (p) => {
      if (!p || p.mode !== modeTag) return;
      uninstall(mode, "paper session ended");
      if (typeof onSessionEnd === "function") { try { onSessionEnd(); } catch (_) {} }
    },
  });
  // Restart recovery (Live only): a real position recorded before a crash is
  // restored so it can be squared off. It is marked _restored, so it is only
  // ever closed after the broker book confirms it is held.
  if (!dryRun && _keysForMode(_realPositions, mode).length === 0) {
    const rows = persistedRealPositions(mode);
    _restore(mode, rows);
    for (const r of rows) {
      if (r.confirmed === false) _unconfirmed.add(mode);
      _logEvent({ mode, event: "POSITION_RESTORED", symbol: r.symbol, qty: r.qty, orderId: r.orderId });
      console.warn(`♻️ [LIVE][${mode}] restored real position ${r.direction} ${r.qty}× ${r.symbol} from disk — use "Square off now" (paper won't exit it).`);
    }
  }
  _logEvent({ mode, event: "STARTED", dryRun });
  console.log(`🔧 [${dryRun ? "HARNESS" : "LIVE"}][${mode}] attached to ${modeTag} — ${dryRun ? "simulated broker, no real orders" : "🔴 REAL Fyers orders"}`);
  return { dryRun };
}

function uninstall(mode, reason = "stopped") {
  if (!_harnesses.has(mode)) return false;
  notify.clearOrderHooks(mode);
  const cfg = _harnesses.get(mode);
  _harnesses.delete(mode);
  // Simulator records die with the session; real ones stay (and on disk) until closed.
  if (cfg.dryRun) for (const k of _keysForMode(_realPositions, mode)) _realPositions.delete(k);
  _logEvent({ mode, event: "STOPPED", reason });
  console.log(`🔧 [${cfg.dryRun ? "HARNESS" : "LIVE"}][${mode}] detached (${reason})`);
  return true;
}

/** Close every real position this mode holds (reconciled). Works installed or not. */
async function squareOff(mode, reason = "Manual square-off") {
  const cfg = _harnesses.get(mode) || { mode, modeTag: null, dryRun: false, broker: fyersBroker, tag: String(mode).replace(/[^A-Za-z0-9]/g, "").slice(0, 16) };
  // An entry still in flight becomes a record only when it settles — wait for it.
  const inflight = _keysForMode(_pendingEntries, mode).map((k) => _pendingEntries.get(k));
  if (inflight.length) await Promise.allSettled(inflight);
  if (!_harnesses.has(mode) && _keysForMode(_realPositions, mode).length === 0) _restore(mode, persistedRealPositions(mode));
  const syms = _keysForMode(_realPositions, mode).map((k) => k.slice(mode.length + 1));
  for (const s of syms) await _exitSymbol(cfg, s, { reason });
  return _keysForMode(_realPositions, mode).length;   // positions still open after the attempt
}

/** Wait (bounded) for every in-flight entry and exit — used by graceful shutdown. */
async function drain(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  // Looped: an exit that was awaiting its entry registers only after that entry settles.
  for (;;) {
    await _sleep(0);
    const all = [..._pendingEntries.values(), ..._exiting.values()];
    if (!all.length) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    try { await _withTimeout(Promise.allSettled(all), left, "drain"); } catch (_) { return false; }
  }
}

function status(mode) {
  const cfg = _harnesses.get(mode);
  return {
    installed: !!cfg,
    dryRun: cfg ? cfg.dryRun : null,
    startedAt: cfg ? cfg.startedAt : null,
    blocked: _unconfirmed.has(mode),
    positions: _keysForMode(_realPositions, mode).map((k) => {
      const r = _realPositions.get(k);
      return { symbol: r.symbol, qty: r.qty, direction: r.direction, avgPrice: r.avgPrice || null, confirmed: r.confirmed !== false, restored: !!r._restored };
    }),
    persisted: cfg && cfg.dryRun ? [] : persistedRealPositions(mode),
  };
}
function isInstalled(mode) { return mode ? _harnesses.has(mode) : _harnesses.size > 0; }
function hasRealInstalled() { return [..._harnesses.values()].some((c) => !c.dryRun); }
function recentEvents(mode, limit = 60) { return _events.filter((e) => !mode || e.mode === mode).slice(-limit); }
function clearBlock(mode) {
  const had = _unconfirmed.delete(mode);
  if (had) _logEvent({ mode, event: "BLOCK_CLEARED" });
  return had;
}

module.exports = {
  install, uninstall, squareOff, drain, status, isInstalled, hasRealInstalled,
  recentEvents, clearBlock, persistedRealPositions,
  globalLiveEnabled, strategyLiveEnabled, realOrdersAllowed,
};

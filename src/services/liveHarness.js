/**
 * liveHarness.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Makes LIVE trading equal to PAPER trading — by construction, not by careful
 * code-mirroring. The harness installs at runtime and patches the seams paper
 * already calls (notifyEntry / notifyExit), routing those events to a real
 * broker call instead of (or in addition to) the simulated path.
 *
 * Mental model:
 *
 *      PAPER MODULE (canonical strategy code, untouched)
 *         ↓ decides: enter PA CE @ 24500, SL 24485
 *         ↓ calls simulateBuy(...) which sets state.position then notifyEntry({...})
 *         ↓                        ↓
 *    [legacy notify]           [HARNESS-PATCHED notifyEntry]
 *      Telegram alert      →   1. forward to original notify (Telegram still works)
 *                               2. fire real broker.placeMarketOrder(symbol, BUY, qty)
 *                               3. log live trade record (with real orderId)
 *
 * Why this works:
 *   - notify.notifyEntry / notifyExit live in src/utils/notify.js — an external
 *     module that paper REQUIREs. Module exports are mutable, so we can swap
 *     them at runtime without touching paper's source. Paper's onTick body is
 *     untouched. simulateBuy/simulateSell bodies are untouched.
 *   - Paper still simulates fills internally (state.position.entryPrice etc.).
 *     That's fine for paper's analysis; live's actual fill price is logged
 *     separately by the harness via the real orderId.
 *
 * Operational modes:
 *   DRY-RUN (default — set LIVE_HARNESS_DRY_RUN=false to disable)
 *     Logs the broker call that WOULD have happened. No real order placed.
 *     Use for at least one full session to verify decisions match paper.
 *
 *   LIVE (LIVE_HARNESS_DRY_RUN=false)
 *     Places real market entry/exit orders via fyersBroker (PA, BB_RSI, ORB)
 *     or zerodhaBroker (EMA_RSI_ST). Paper's stopLoss is a SPOT level, not an
 *     option-premium trigger, so it is NOT forwarded verbatim as an SL-M; the
 *     primary stop is the in-process per-tick stop. OPTIONALLY (default OFF,
 *     HARNESS_EXCHANGE_SL_ENABLED=true) a percent-of-premium SL-M is left resting
 *     at the exchange as a DISASTER backstop for when the process is dead — it is
 *     cancelled before any normal square-off. Validate on dry-run before enabling.
 *
 * Concurrency:
 *   Multiple harnesses (one per mode) can be installed at once — each registers
 *   its own notify hooks keyed by mode and filters payloads by its modeTag, so
 *   they run in parallel without colliding. Re-installing the SAME mode throws.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs           = require("fs");
const path         = require("path");
const notify       = require("../utils/notify");
const tradeLogger  = require("../utils/tradeLogger");
const fyersBroker  = require("./fyersBroker");
let   zerodhaBroker = null;
try { zerodhaBroker = require("./zerodhaBroker"); } catch (_) { /* optional */ }

// Registry of concurrently-installed harnesses, keyed by mode ("EMA_RSI_ST-LIVE", …).
// Each filters notify payloads by its own modeTag, so multiple can coexist —
// this is what lets every harness run in parallel. modeTags MUST be unique per
// paper engine: two harnesses on the same tag would both fire on one paper's
// signal (tests/liveParity.regression.js pins this).
const _harnesses = new Map();    // mode → config

// ── Position bookkeeping keys ────────────────────────────────────────────────
// Every map below is keyed by `${mode}|${symbol}`, NOT by mode alone: an engine
// that holds several positions at once (EarlyBird stocks + option, a same-candle
// CE→PE flip) used to overwrite one record with the next, and the first leg's
// exit then closed the wrong symbol (or nothing at all).
function _key(mode, symbol) { return `${mode}|${symbol}`; }
function _keysForMode(map, mode) {
  const out = [];
  for (const k of map.keys()) if (k.startsWith(`${mode}|`)) out.push(k);
  return out;
}

// Authoritative record of a REAL broker position per mode+symbol. Set only
// after an entry is confirmed filled (or recorded `confirmed:false` when the
// outcome is unknown); cleared on real exit. The exit hook must NOT send a
// closing order unless this says we hold the position — otherwise a rejected
// entry (paper still holds a virtual position) would turn into a naked position
// the other way when paper later "exits".
// Record: { mode, symbol, qty, orderId, slOrderId, ts, direction: "LONG"|"SHORT",
//           isFutures, confirmed, _restored? }
const _realPositions = new Map();

// In-flight exchange-SL placement promises (by key). _maybePlaceExchangeSL runs
// async and fire-and-forget after a fill; if a paper exit arrives before it
// resolves, _cancelExchangeSL must AWAIT this so it can cancel the SL-M that is
// about to exist — otherwise a resting SL-M is orphaned on a squared-off position.
const _slPending = new Map();

// In-flight entry promises (by key). Registered SYNCHRONOUSLY when an entry fires
// so a fast paper exit (within the order round-trip + fill confirmation) can
// await it before deciding whether we hold a position. Also dedupes double-entries.
const _pendingEntries = new Map();
// In-flight exits (by key) → promise. Dedupes concurrent exits WITHOUT deleting
// the authoritative record up-front, and lets a same-symbol re-entry wait for the
// previous exit to finish instead of racing it.
const _exiting = new Map();

// Modes whose last entry had an UNKNOWN outcome (timeout / lost response / fill
// not confirmable). New entries are blocked until the user verifies/clears, so a
// filled-but-unconfirmed order + a paper re-entry can't create two real positions.
// Cleared by clearUnconfirmedEntry() or process restart.
const _unconfirmedEntries = new Set();

// Event log persisted to disk so the "Recent harness events" panel survives a
// server restart / deploy (the ring buffer used to be wiped on every reboot).
const DATA_DIR        = path.join(require("os").homedir(), "trading-data");
const HARNESS_LOG_FILE = path.join(DATA_DIR, ".harness_events.json");
const HARNESS_POS_FILE = path.join(DATA_DIR, ".harness_real_positions.json");
const _harnessLog     = [];      // ring buffer of harness events for /live-harness/status

function _tg(text) { try { notify.sendIfMaster(text); } catch (_) {} }

// ── Real-position persistence ────────────────────────────────────────────────
// _realPositions lives in memory; a crash / redeploy while a live position is
// open would empty it and the next paper exit would SKIP the square-off. Persist
// on every set/delete (atomic tmp+rename) and restore per-mode on install.
//
// Modes whose records have been loaded into memory (or written from memory) own
// their rows in the file; rows for any OTHER mode are carried over untouched —
// otherwise the first harness to persist would wipe a not-yet-reinstalled
// harness's restored position from disk.
const _ownedModes = new Set();

function _readPosFile() {
  try {
    const obj = JSON.parse(fs.readFileSync(HARNESS_POS_FILE, "utf8"));
    return (obj && typeof obj === "object") ? obj : {};
  } catch (_) { return {}; }
}
// Accepts both the legacy format ({ [mode]: rec }) and the current one
// ({ ["mode|symbol"]: rec-with-mode }).
function _rowMode(k, v) { return (v && v.mode) || (k.includes("|") ? k.slice(0, k.indexOf("|")) : k); }

function _persistRealPositions() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const rec of _realPositions.values()) _ownedModes.add(rec.mode);
    const obj = {};
    for (const [k, v] of Object.entries(_readPosFile())) {
      if (!_ownedModes.has(_rowMode(k, v))) obj[k] = v;     // another harness's row — keep
    }
    for (const [k, rec] of _realPositions) {
      obj[k] = {
        mode: rec.mode, symbol: rec.symbol, qty: rec.qty, orderId: rec.orderId || null,
        slOrderId: rec.slOrderId || null, ts: rec.ts,
        direction: rec.direction || "LONG", isFutures: !!rec.isFutures,
        confirmed: rec.confirmed !== false,
      };
    }
    const tmp = HARNESS_POS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, HARNESS_POS_FILE);
  } catch (e) { console.error(`[harness] failed to persist real positions: ${e.message}`); }
}
function _loadRealPositionsForMode(mode) {
  const out = [];
  for (const [k, v] of Object.entries(_readPosFile())) {
    if (_rowMode(k, v) !== mode) continue;
    if (!v || !v.symbol || !(v.qty > 0)) continue;
    // Legacy rows predate direction/confirmed: every one of them was a BUY that
    // the broker accepted.
    out.push({ ...v, mode, direction: v.direction || "LONG", confirmed: v.confirmed !== false });
  }
  return out;
}

function _loadHarnessLog() {
  try {
    const raw = fs.readFileSync(HARNESS_LOG_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) _harnessLog.push(...arr.slice(-500));
  } catch (_) { /* no prior log */ }
}
let _flushTimer = null;
function _persistHarnessLog() {
  // debounce writes — events can burst during entry/exit
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(HARNESS_LOG_FILE, JSON.stringify(_harnessLog.slice(-500)));
    } catch (e) { console.error(`[harness] failed to persist event log: ${e.message}`); }
  }, 1000);
}
_loadHarnessLog();

function _logEvent(evt) {
  _harnessLog.push({ t: Date.now(), ...evt });
  if (_harnessLog.length > 500) _harnessLog.splice(0, _harnessLog.length - 500);
  _persistHarnessLog();
}

// ── Order direction ──────────────────────────────────────────────────────────
// Normalise the futures flag the way src/config/instrument.js normalises
// INSTRUMENT (trim + uppercase): " nifty_futures" must not silently mean options.
function _normFutures(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).trim().toUpperCase();
  return s === "TRUE" || s === "1" || s === "NIFTY_FUTURES";
}
// Per-order futures flag: the payload wins when it says anything (EarlyBird can
// hold a cash-equity leg and an index leg at once), else the harness config.
function _isFuturesOrder(cfg, p) {
  if (p && p.isSpot === true) return false;
  if (p && typeof p.isFutures === "boolean") return p.isFutures;
  // A cash-equity leg is never futures (MARGIN product) even on a harness whose
  // config claims futures for its index leg.
  if (_isEquitySymbol(_orderSymbol(p))) return false;
  return cfg.isFutures;
}
// Direction of the REAL position paper's entry asks for.
//   options      → always LONG (a CE or a PE is BOUGHT)
//   futures CE   → LONG  (BUY to open, SELL to close)
//   futures PE   → SHORT (SELL to open, BUY to close)
//   cash equity  → side "SHORT" is a short sale (SELL to open, BUY to close)
function _directionFor(cfg, p) {
  const side = String((p && p.side) || "").toUpperCase();
  if (side === "SHORT") return "SHORT";
  if (side === "PE" && _isFuturesOrder(cfg, p)) return "SHORT";
  return "LONG";
}
function _entryAction(direction) { return direction === "SHORT" ? "SELL" : "BUY"; }
function _exitAction(direction)  { return direction === "SHORT" ? "BUY"  : "SELL"; }

// The symbol the BROKER is sent. Paper payloads carry a display symbol; an engine
// whose display symbol is not broker-format (EarlyBird stocks: "RELIANCE") also
// sends `brokerSymbol` ("NSE:RELIANCE-EQ"). A bare symbol with no exchange prefix
// (EarlyBird's stock payloads today) is mapped to Fyers cash format
// "NSE:<SYM>-EQ" — sent as-is, Fyers rejects it, and the entry/exit keys must
// agree, so both hooks go through this one mapping.
function _orderSymbol(p) {
  const raw = p && (p.brokerSymbol || p.symbol);
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.includes(":")) return s;
  return `NSE:${s.toUpperCase().replace(/-EQ$/, "")}-EQ`;
}
function _isEquitySymbol(sym) { return !!sym && /-EQ$/i.test(String(sym)); }

// ── Broker dispatch ─────────────────────────────────────────────────────────
async function _placeOrder({ broker, symbol, qty, sideAction, isFutures, tag, isExit }) {
  // sideAction: "BUY" | "SELL". isExit lets a closing order through an OPEN
  // circuit breaker — a breaker must never trap us in a live position.
  // Both brokers: placeMarketOrder(fyersSymbol, side 1|-1, qty, orderTag, opts).
  // (Passing opts in the orderTag slot once made every Fyers order throw.)
  const sideCode = sideAction === "BUY" ? 1 : -1;
  if (broker === "fyers") {
    return fyersBroker.placeMarketOrder(symbol, sideCode, qty, tag, { isFutures, isExit: !!isExit });
  }
  if (broker === "zerodha") {
    if (!zerodhaBroker) throw new Error("zerodhaBroker module not loaded");
    return zerodhaBroker.placeMarketOrder(symbol, sideCode, qty, tag, { isFutures, isExit: !!isExit });
  }
  throw new Error(`Unknown broker: ${broker}`);
}

// ── Optional exchange-resident disaster stop (default OFF) ───────────────────
// A percent-of-price SL-M left resting at the exchange, so a hard crash while
// in a live position still has SOME protection. This is a DISASTER backstop, NOT
// the precise spot stop (paper's stop is a spot level, not an option trigger):
//   LONG  trigger = priceAtPlacement × (1 − HARNESS_SL_PCT)   (SELL SL-M)
//   SHORT trigger = priceAtPlacement × (1 + HARNESS_SL_PCT)   (BUY  SL-M)
// EXPERIMENTAL — places REAL resting orders. Validate on a dry-run session before
// enabling with HARNESS_EXCHANGE_SL_ENABLED=true. Everything here fails SAFE: any
// missing data / bad trigger / broker error skips the SL (never places a bad one)
// and the in-process per-tick stop remains.
function _brokerFor(cfg) { return cfg.broker === "zerodha" ? (zerodhaBroker || fyersBroker) : fyersBroker; }

async function _fetchOptionPremium(symbol) {
  try {
    const fyersData = require("../config/fyers");   // Fyers is the data feed for ALL strategies
    const q = await fyersData.getQuotes([symbol]);
    const lp = q && q.s === "ok" && q.d && q.d[0] && q.d[0].v && q.d[0].v.lp;
    return Number(lp) > 0 ? Number(lp) : null;
  } catch (_) { return null; }
}

async function _maybePlaceExchangeSL(cfg, realRec) {
  if (!realRec) return;
  if (String(process.env.HARNESS_EXCHANGE_SL_ENABLED || "false").toLowerCase() !== "true") return;
  // Never stack a second stop on the same lot: if an id is still recorded (a
  // cancel that did not confirm), both could fire → the lot is closed twice.
  if (realRec.slOrderId) {
    console.warn(`[HARNESS][${cfg.mode}] exchange-SL NOT placed — ${realRec.slOrderId} may still be resting on ${realRec.symbol}.`);
    return;
  }
  try {
    const short = realRec.direction === "SHORT";
    const pct  = Math.min(0.95, Math.max(0.05, parseFloat(process.env.HARNESS_SL_PCT || "0.5")));
    const prem = await _fetchOptionPremium(realRec.symbol);
    if (!(prem > 0)) { console.warn(`[HARNESS][${cfg.mode}] exchange-SL skipped — no price for ${realRec.symbol}`); return; }
    const trigger = parseFloat((prem * (short ? 1 + pct : 1 - pct)).toFixed(1));
    if (!(trigger > 0) || (short ? trigger <= prem : trigger >= prem)) { console.warn(`[HARNESS][${cfg.mode}] exchange-SL skipped — bad trigger ${trigger} vs price ${prem}`); return; }
    // Closing side of the position: SELL protects a LONG, BUY protects a SHORT.
    const res = await _brokerFor(cfg).placeSLMOrder(realRec.symbol, short ? 1 : -1, realRec.qty, trigger, { isFutures: !!realRec.isFutures });
    if (res && res.success) {
      realRec.slOrderId = res.orderId;
      _persistRealPositions();   // so the resting SL-M survives a restart too
      _logEvent({ mode: cfg.mode, event: "EXCHANGE_SL_PLACED", symbol: realRec.symbol, trigger, slOrderId: res.orderId, direction: realRec.direction || "LONG" });
      console.log(`🛡️ [HARNESS LIVE][${cfg.mode}] Exchange SL-M ${short ? "BUY" : "SELL"} @ ₹${trigger} (${Math.round(pct * 100)}% ${short ? "above" : "below"} ₹${prem}) orderId=${res.orderId}`);
    } else {
      console.warn(`[HARNESS][${cfg.mode}] exchange-SL placement failed: ${JSON.stringify(res && res.raw).slice(0, 150)}`);
    }
  } catch (e) { console.warn(`[HARNESS][${cfg.mode}] exchange-SL error (skipped): ${e.message}`); }
}

// Bound every broker network call so a hung socket can't wedge an entry or exit
// forever. A timed-out WRITE is surfaced as UNKNOWN (NOT retried) — the order may
// already be live, so the user is told to verify rather than risk a double-fill.
function _brokerTimeoutMs() {
  return Math.max(1500, parseInt(process.env.HARNESS_BROKER_TIMEOUT_MS || "8000", 10) || 8000);
}
function _withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fill confirmation ────────────────────────────────────────────────────────
// "Accepted" is not "filled": a broker returns an order id the moment it takes
// the order, and an RMS / freeze-qty / circuit reject arrives AFTER that. Poll
// the order book (bounded by HARNESS_BROKER_TIMEOUT_MS) for a terminal status.
//   → { state: "FILLED", filledQty, avgPrice } | { state: "REJECTED", reason } | { state: "UNKNOWN" }
function _orderStatus(cfg, row) {
  if (cfg.broker === "zerodha") {
    const st = String(row.status || "").toUpperCase();
    const filled = Number(row.filled_quantity) || 0;
    if (st === "COMPLETE") return { state: "FILLED", filledQty: filled || Number(row.quantity) || 0, avgPrice: Number(row.average_price) || null };
    if (st === "REJECTED" || st === "CANCELLED") {
      return filled > 0
        ? { state: "FILLED", filledQty: filled, avgPrice: Number(row.average_price) || null, partial: true }
        : { state: "REJECTED", reason: row.status_message || st };
    }
    return { state: "PENDING" };
  }
  // Fyers order status: 2 = traded/filled, 1 = cancelled, 5 = rejected,
  // 7 = expired, 4 = transit, 6 = pending.
  const st = Number(row.status);
  const filled = Number(row.filledQty) || 0;
  if (st === 2) return { state: "FILLED", filledQty: filled || Number(row.qty) || 0, avgPrice: Number(row.tradedPrice) || null };
  if (st === 1 || st === 5 || st === 7) {
    return filled > 0
      ? { state: "FILLED", filledQty: filled, avgPrice: Number(row.tradedPrice) || null, partial: true }
      : { state: "REJECTED", reason: row.message || `status ${st}` };
  }
  return { state: "PENDING" };
}
async function _confirmFill(cfg, orderId) {
  const broker = _brokerFor(cfg);
  if (!orderId || typeof broker.getOrders !== "function") return { state: "UNKNOWN" };
  const deadline = Date.now() + _brokerTimeoutMs();
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(500, deadline - Date.now());
      const list = await _withTimeout(broker.getOrders(), remaining, "getOrders");
      const rows = Array.isArray(list) ? list : [];
      const row = rows.find((o) => String(cfg.broker === "zerodha" ? o.order_id : o.id) === String(orderId));
      if (row) {
        const s = _orderStatus(cfg, row);
        if (s.state !== "PENDING") return s;
      }
    } catch (_) { /* read failed / timed out — keep polling until the deadline */ }
    if (Date.now() + 400 >= deadline) break;
    await _sleep(400);
  }
  return { state: "UNKNOWN" };
}

// Reconcile a tracked position against the ACTUAL broker book before closing.
// Returns the HELD quantity: null (couldn't verify — DON'T treat as flat), 0
// (definitively flat), or N>0 (holding N). Guards against a post-accept RMS
// reject, MIS/intraday auto-square ~15:20, an exchange SL-M that already fired,
// or a manual close — any of which would make our closing order a naked position.
//
// CRITICAL: both brokers return an EMPTY-but-valid book on auth-loss (token
// expires daily) and on a swallowed API error — indistinguishable from a truly
// flat account. So an empty book / unauthenticated broker returns `null` (can't
// verify), NOT 0 — otherwise a routine token expiry would delete the record and
// skip a real exit. `0` (flat) is only returned when a NON-empty book is read
// and our symbol isn't in it (or shows zero qty).
async function _heldQty(cfg, symbol) {
  try {
    const broker = _brokerFor(cfg);
    if (typeof broker.getPositions !== "function") return null;
    if (typeof broker.isAuthenticated === "function" && !broker.isAuthenticated()) return null;
    const pos  = await _withTimeout(broker.getPositions(), Math.min(_brokerTimeoutMs(), 3000), "getPositions");
    const list = cfg.broker === "zerodha" ? ((pos && pos.net) || []) : ((pos && pos.netPositions) || []);
    if (!Array.isArray(list) || list.length === 0) return null; // empty is ambiguous → can't verify
    let row, qty;
    if (cfg.broker === "zerodha") {
      const ts = String(symbol).replace(/^(NSE:|BSE:)/, "").replace(/-EQ$/, "").trim();
      row = list.find((p) => p.tradingsymbol === ts);
      qty = row ? Math.abs(Number(row.quantity) || 0) : 0;
    } else {
      row = list.find((p) => p.symbol === symbol);
      qty = row ? Math.abs(Number(row.netQty) || 0) : 0;
    }
    if (!row) {
      // Book read OK but our symbol absent — genuinely flat for us. Log so a
      // symbol-format mismatch (which would look identical) is diagnosable.
      console.warn(`[HARNESS][${cfg.mode}] reconcile: ${symbol} not in broker book (${list.length} other position(s)) — treating as flat.`);
    }
    return qty;
  } catch (e) {
    console.warn(`[HARNESS][${cfg.mode}] getPositions reconcile failed: ${e.message}`);
    return null;
  }
}

// Best-effort cancel of a resting exchange SL-M. Always resolves (never rejects)
// so the caller can chain the square-off after it. Cancelling BEFORE the market
// close prevents a double-close (SL fires + our order → naked opposite position).
//
// Races the placement: if the SL-M is still being placed when an exit fires,
// await that placement FIRST (so realRec.slOrderId is populated), then cancel.
async function _cancelExchangeSL(cfg, realRec) {
  if (!realRec) return;
  const k = _key(cfg.mode, realRec.symbol);
  const pending = _slPending.get(k);
  if (pending) { try { await pending; } catch (_) { /* placement failed → nothing to cancel */ } _slPending.delete(k); }
  if (!realRec.slOrderId) return;
  const slId = realRec.slOrderId;
  let res = null, errMsg = null;
  try {
    // An exit-side call: it must get through an open breaker like the exit itself.
    res = await _withTimeout(_brokerFor(cfg).cancelOrder(slId, { isExit: true }), _brokerTimeoutMs(), "cancelOrder");
  } catch (e) { errMsg = e.message; }
  // The result is CHECKED: both brokers report a failed cancel as
  // { success:false } rather than throwing, and treating that as success used to
  // drop the id of an SL-M that was still resting.
  if (!errMsg && res && res.success !== false) {
    _logEvent({ mode: cfg.mode, event: "EXCHANGE_SL_CANCELLED", slOrderId: slId });
    // Cleared only on success: keeping the id on failure is what lets a later
    // exit try again and stops a re-arm from stacking a second stop on the lot.
    realRec.slOrderId = null;
    _persistRealPositions();
    return;
  }
  const why = errMsg || JSON.stringify(res && res.raw).slice(0, 150);
  _logEvent({ mode: cfg.mode, event: "EXCHANGE_SL_CANCEL_FAILED", slOrderId: slId, error: why });
  console.warn(`[HARNESS][${cfg.mode}] exchange-SL cancel FAILED (${slId}): ${why}`);
  _tg(`⚠️ ${cfg.mode} — could not cancel resting exchange SL-M ${slId} on ${realRec.symbol} (${why}).\nIf it is still open at the broker, CANCEL IT MANUALLY — once the position is closed it would open a naked position if it triggers.`);
}

// Put the exchange stop back after a failed exit — those paths deliberately keep
// the position record, so it must not be left unprotected.
//
// If slOrderId is STILL set, the cancel above did not confirm: the old SL-M may
// still be resting on this exact lot, and adding a second one means both can
// fire → the lot is closed twice → naked position. Leave it alone and say so.
async function _rearmExchangeSL(cfg, realRec) {
  if (!realRec) return;
  if (realRec.slOrderId) {
    console.warn(`[HARNESS][${cfg.mode}] exchange-SL NOT re-armed — ${realRec.slOrderId} may still be resting (cancel unconfirmed). Verify on the broker dashboard.`);
    return;
  }
  const k = _key(cfg.mode, realRec.symbol);
  const placement = _maybePlaceExchangeSL(cfg, realRec);
  _slPending.set(k, placement);
  try { await placement; } finally { if (_slPending.get(k) === placement) _slPending.delete(k); }
}

function _setReal(cfg, rec) {
  _realPositions.set(_key(cfg.mode, rec.symbol), rec);
  _persistRealPositions();
}
function _clearReal(cfg, rec) {
  const k = _key(cfg.mode, rec.symbol);
  // Identity-guarded so a concurrent re-entry's record isn't clobbered.
  if (_realPositions.get(k) === rec) { _realPositions.delete(k); _persistRealPositions(); }
}

// Global dry-run switch, re-read before every NEW entry: flipping
// LIVE_HARNESS_DRY_RUN back on in Settings must stop new real orders from an
// already-installed live harness without a restart. Exits are NOT gated — a
// position that is open must still be closable.
function _globalDryRunNow() {
  try { return require("../utils/liveDryRun").isDryRun(); }
  catch (_) { return (process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() !== "false"; }
}

// ── Order hooks (registered into notify; Telegram is emitted by notify itself) ─
//
// Lifetime: these closures capture `cfg` and never consult the registry, so an
// uninstallHarness() that lands while an entry/exit is in flight (paper /stop
// squares off, THEN releases its harness) does NOT abort it — the order, its
// fill confirmation and the record update all run to completion.
function _makeEntryHook(cfg) {
  return function entryHook(p) {
    // Only act on the mode this harness is for (exact match on the paper's tag).
    if (p.mode !== cfg.modeTag) return;

    const symbol    = _orderSymbol(p);
    const isFut     = _isFuturesOrder(cfg, p);
    const direction = _directionFor(cfg, p);
    const action    = _entryAction(direction);

    if (cfg.dryRun) {
      _logEvent({ mode: cfg.mode, event: "DRY_RUN_ENTRY", side: p.side, action, symbol, qty: p.qty, sl: p.stopLoss });
      console.log(`🧪 [HARNESS DRY-RUN][${cfg.mode}] Would ${action} ${p.qty}× ${symbol} (${direction}) | SL=${p.stopLoss} | reason=${p.reason}`);
      return;
    }
    if (_globalDryRunNow()) {
      _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_SKIPPED_GLOBAL_DRY_RUN", side: p.side, action, symbol, qty: p.qty });
      console.warn(`🧪 [HARNESS][${cfg.mode}] ${action} ${p.qty}× ${symbol} NOT placed — LIVE_HARNESS_DRY_RUN is now ON (exits still go out).`);
      _tg(`🧪 ${cfg.mode} — entry ${action} ${p.qty}× ${symbol} NOT placed: global dry-run (LIVE_HARNESS_DRY_RUN) was switched ON after this harness started. Exits of existing positions still go out.`);
      return;
    }
    if (!symbol) {
      _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_SKIPPED_NO_SYMBOL", side: p.side });
      _tg(`🚨 ${cfg.mode} — paper entered but the payload carried no symbol; NO real order placed.`);
      return;
    }

    // Block re-entry after an UNKNOWN-outcome entry until verified — otherwise a
    // filled-but-unconfirmed order + this entry = two real positions.
    if (_unconfirmedEntries.has(cfg.mode)) {
      _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_BLOCKED_UNCONFIRMED", symbol });
      console.error(`🛑 [HARNESS LIVE][${cfg.mode}] ${action} blocked — a prior order's fill is UNCONFIRMED. Verify at the broker, then clear before re-entering.`);
      _tg(`🛑 ${cfg.mode} — ${action} ${p.qty}× ${symbol} BLOCKED: an earlier order's fill is still UNCONFIRMED. Verify at the broker and clear the block (or restart) to resume real entries.`);
      return;
    }

    const k = _key(cfg.mode, symbol);
    // Dedupe: an entry already in flight, or the same symbol already held. A
    // DIFFERENT symbol (CE→PE flip, a second EarlyBird stock) is its own key.
    if (_pendingEntries.has(k) || (_realPositions.has(k) && !_exiting.has(k))) {
      _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_SKIPPED_DUP", symbol });
      console.warn(`⏭️ [HARNESS LIVE][${cfg.mode}] ${action} skipped — entry already in flight / same position held for ${symbol}.`);
      _tg(`⏭️ ${cfg.mode} — ${action} ${p.qty}× ${symbol} skipped: an entry for this symbol is already in flight or the position is still held. Paper and broker may now differ.`);
      return;
    }

    // Register SYNCHRONOUSLY so a fast exit can await it.
    const entryPromise = (async () => {
      try {
        // Same-symbol re-entry while the previous exit is still in flight: wait
        // for it, so the new record is never created under a closing order.
        const inflightExit = _exiting.get(k);
        if (inflightExit) { try { await inflightExit; } catch (_) {} }
        if (_realPositions.has(k)) {
          _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_SKIPPED_STILL_HELD", symbol });
          _tg(`🚨 ${cfg.mode} — ${action} ${symbol} skipped: the previous position on this symbol is still held (its exit did not complete). Square off manually.`);
          return;
        }

        let result, transportErr = null;
        try {
          result = await _withTimeout(_placeOrder({
            broker: cfg.broker, symbol, qty: p.qty,
            sideAction: action, isFutures: isFut, tag: `${cfg.mode}-HARN`,
          }), _brokerTimeoutMs(), action);
        } catch (err) { transportErr = err; }

        const base = { mode: cfg.mode, symbol, qty: p.qty, direction, isFutures: isFut, ts: Date.now(), slOrderId: null };

        if (transportErr || (result && result.uncertain)) {
          // Timeout / lost response: the order MAY be live. Record it UNCONFIRMED
          // (so paper's exit reconciles against the book instead of skipping and
          // orphaning a fill), block re-entry, and tell the user.
          const why = transportErr ? transportErr.message : JSON.stringify(result.raw).slice(0, 200);
          _unconfirmedEntries.add(cfg.mode);
          _setReal(cfg, { ...base, orderId: (result && result.orderId) || null, confirmed: false });
          _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_EXCEPTION", symbol, action, error: why });
          console.error(`🚨 [HARNESS LIVE][${cfg.mode}] ${action} outcome UNKNOWN: ${why}`);
          _tg(`🚨 ${cfg.mode} LIVE ${action} ERROR — UNCONFIRMED FILL\n${symbol}: ${why}\nThe order may or may not have filled. Re-entry is BLOCKED for ${cfg.mode} until you verify at the broker and clear it. Paper's exit will close it only if the broker book shows it.`);
          return;
        }
        if (!(result && result.success)) {
          _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_FAIL", symbol, action, raw: result && result.raw });
          console.error(`🚨 [HARNESS LIVE][${cfg.mode}] ${action} FAILED — broker rejected. Symbol=${symbol} | ${JSON.stringify(result && result.raw).slice(0, 200)}`);
          _tg(`🚨 ${cfg.mode} LIVE ${action} REJECTED\nPaper opened a position but the broker order failed — you are NOT in this trade.\nSymbol: ${symbol}\n${JSON.stringify(result && result.raw).slice(0, 200)}`);
          return;
        }

        // Accepted — now prove it FILLED before treating it as a position.
        const fill = await _confirmFill(cfg, result.orderId);
        if (fill.state === "REJECTED") {
          _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_REJECTED_AFTER_ACCEPT", symbol, orderId: result.orderId, reason: fill.reason });
          console.error(`🚨 [HARNESS LIVE][${cfg.mode}] ${action} ${result.orderId} accepted then REJECTED/CANCELLED: ${fill.reason}`);
          _tg(`🚨 ${cfg.mode} LIVE ${action} REJECTED after acceptance\n${symbol} order ${result.orderId}: ${fill.reason}\nYou are NOT in this trade.`);
          return;
        }
        if (fill.state !== "FILLED") {
          _unconfirmedEntries.add(cfg.mode);
          _setReal(cfg, { ...base, orderId: result.orderId, confirmed: false });
          _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_FILL_UNCONFIRMED", symbol, orderId: result.orderId });
          console.error(`🚨 [HARNESS LIVE][${cfg.mode}] ${action} ${result.orderId} accepted but fill NOT confirmed within ${_brokerTimeoutMs()}ms.`);
          _tg(`⚠️ ${cfg.mode} LIVE ${action} — FILL UNCONFIRMED\n${symbol} order ${result.orderId} was accepted but no fill was seen within ${_brokerTimeoutMs()}ms. Re-entry BLOCKED until you verify at the broker and clear it.`);
          return;
        }

        const qty = fill.filledQty > 0 ? fill.filledQty : p.qty;
        const rec = { ...base, qty, orderId: result.orderId, confirmed: true, avgPrice: fill.avgPrice || null };
        _setReal(cfg, rec);
        _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_OK", orderId: result.orderId, symbol, qty, action, direction, avgPrice: fill.avgPrice || null });
        console.log(`✅ [HARNESS LIVE][${cfg.mode}] ${action} filled — orderId=${result.orderId} qty=${qty}${fill.partial ? " (PARTIAL)" : ""}`);
        if (fill.partial) _tg(`⚠️ ${cfg.mode} — ${action} ${symbol} PARTIALLY filled: ${qty}/${p.qty}. Tracking ${qty}.`);
        // Optional exchange-resident disaster stop (default OFF; fire-and-forget, fails safe).
        const placement = _maybePlaceExchangeSL(cfg, rec);
        _slPending.set(k, placement);
        placement.then(() => { if (_slPending.get(k) === placement) _slPending.delete(k); }, () => {});
        try {
          if (cfg.liveLogKey) tradeLogger.appendTradeLog(cfg.liveLogKey, {
            _viaHarness: true, event: "ENTRY", orderId: result.orderId, symbol,
            qty, side: p.side, direction, spotAtEntry: p.spotAtEntry, stopLoss: p.stopLoss,
            reason: p.reason, ts: Date.now(),
          });
        } catch (_) {}
      } catch (err) {
        // Anything unexpected around the order call: unknown outcome.
        _unconfirmedEntries.add(cfg.mode);
        _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_EXCEPTION", symbol, error: err.message });
        console.error(`🚨 [HARNESS LIVE][${cfg.mode}] entry exception: ${err.message}`);
        _tg(`🚨 ${cfg.mode} LIVE ENTRY ERROR — UNCONFIRMED FILL\n${symbol}: ${err.message}\nRe-entry is BLOCKED for ${cfg.mode} until you verify at the broker and clear it.`);
      } finally {
        if (_pendingEntries.get(k) === entryPromise) _pendingEntries.delete(k);
      }
    })();
    _pendingEntries.set(k, entryPromise);
  };
}

function _makeExitHook(cfg) {
  return async function exitHook(p) {
    if (p.mode !== cfg.modeTag) return;

    let symbol = _orderSymbol(p);

    if (cfg.dryRun) {
      _logEvent({ mode: cfg.mode, event: "DRY_RUN_EXIT", side: p.side, symbol, pnl: p.pnl });
      console.log(`🧪 [HARNESS DRY-RUN][${cfg.mode}] Would close ${symbol} (square-off) | paper-pnl=${p.pnl}`);
      return;
    }

    // A payload with no symbol can only mean "the one position this mode holds".
    if (!symbol) {
      const uniq = [...new Set([..._keysForMode(_realPositions, cfg.mode), ..._keysForMode(_pendingEntries, cfg.mode)])];
      if (uniq.length === 1) symbol = uniq[0].slice(cfg.mode.length + 1);
    }
    if (!symbol) {
      _logEvent({ mode: cfg.mode, event: "REAL_EXIT_SKIPPED_NO_SYMBOL", side: p.side });
      _tg(`🚨 ${cfg.mode} — paper exited but the payload named no symbol and the harness cannot tell which position to close. Check open positions manually.`);
      return;
    }
    const k = _key(cfg.mode, symbol);

    // Await any in-flight entry for THIS symbol first — a fast exit can arrive
    // while the entry is still filling / confirming; without this we'd skip as
    // "no position" and orphan the real position that fills a moment later.
    const pendingEntry = _pendingEntries.get(k);
    if (pendingEntry) { try { await pendingEntry; } catch (_) {} }

    // Only close a position we hold (or might hold — confirmed:false records are
    // reconciled against the broker book first).
    const real = _realPositions.get(k);
    if (!real) {
      _logEvent({ mode: cfg.mode, event: "REAL_EXIT_SKIPPED_NO_POSITION", symbol });
      console.warn(`⏭️ [HARNESS LIVE][${cfg.mode}] Paper exit but no real position on ${symbol} — skipping (not opening a naked position).`);
      _tg(`⏭️ ${cfg.mode} — paper exited ${symbol} but the harness holds no real position on it (entry rejected / blocked / never placed). Nothing sent.`);
      return;
    }

    // Dedupe concurrent exits without dropping the record.
    if (_exiting.has(k)) {
      _logEvent({ mode: cfg.mode, event: "REAL_EXIT_SKIPPED_INFLIGHT", symbol });
      _tg(`⏭️ ${cfg.mode} — duplicate exit for ${symbol} ignored; a closing order is already in flight.`);
      return;
    }

    const run = _doExit(cfg, p, real);
    _exiting.set(k, run);
    try { await run; }
    finally { if (_exiting.get(k) === run) _exiting.delete(k); }
  };
}

async function _doExit(cfg, p, real) {
  const action = _exitAction(real.direction);
  const sym    = real.symbol;
  // Reconcile against the broker before closing — the position may already be
  // closed (post-accept reject, MIS auto-square, SL-M fired, manual close).
  // _heldQty: null = couldn't verify, 0 = confirmed flat, N>0 = held qty.
  const heldQty = await _heldQty(cfg, sym);

  if (heldQty === 0) {
    // Broker confirms flat — cancel any orphaned resting SL-M (it would fire on a
    // flat account → naked position), then clear our record.
    await _cancelExchangeSL(cfg, real);
    _clearReal(cfg, real);
    _logEvent({ mode: cfg.mode, event: "REAL_EXIT_ALREADY_FLAT", symbol: sym });
    console.warn(`⏭️ [HARNESS LIVE][${cfg.mode}] Broker shows FLAT for ${sym} — skipping ${action} (already closed).`);
    _tg(`⏭️ ${cfg.mode} — broker already shows FLAT on ${sym}; no ${action} sent.${real.confirmed === false ? " (The unconfirmed entry evidently never filled.)" : ""}`);
    return;
  }
  if (heldQty === null && (real._restored || real.confirmed === false)) {
    // Restored-from-disk or never-confirmed record we cannot verify → do NOT
    // close blind (could open a naked position). Alert; keep the record + SL.
    const what = real._restored ? "RESTORED" : "UNCONFIRMED";
    _logEvent({ mode: cfg.mode, event: `REAL_EXIT_UNVERIFIED_${what}`, symbol: sym });
    console.error(`🚨 [HARNESS LIVE][${cfg.mode}] Could not verify ${what} position ${sym} against broker — NOT auto-closing.`);
    _tg(`🚨 ${cfg.mode} — could not read the broker book to verify ${what.toLowerCase()} live position ${sym}; NOT auto-closing (avoids a possible naked position). Check & square off manually.`);
    return;
  }
  // heldQty > 0, or (null on a confirmed in-session record we trust): close.

  // Close qty: never exceed what the broker ACTUALLY holds (partial fill), and
  // never a null/zero qty. When held qty is unknown, fall back to what we opened.
  let exitQty = real.qty || p.qty || cfg.defaultQty;
  if (heldQty && heldQty > 0) exitQty = Math.min(exitQty || heldQty, heldQty);
  if (!exitQty || exitQty <= 0) {
    _logEvent({ mode: cfg.mode, event: "REAL_EXIT_ABORT_BAD_QTY", symbol: sym });
    console.error(`🚨 [HARNESS LIVE][${cfg.mode}] Exit aborted — could not resolve a valid qty for ${sym}. MANUAL square-off required.`);
    _tg(`🚨 ${cfg.mode} LIVE EXIT ABORTED — bad qty for ${sym}. Square off manually NOW.`);
    return;
  }

  // Cancel any resting exchange SL-M FIRST so it can't fire on the same lot.
  await _cancelExchangeSL(cfg, real);

  let result, transportErr = null;
  try {
    result = await _withTimeout(_placeOrder({
      broker: cfg.broker, symbol: sym, qty: exitQty,
      sideAction: action, isFutures: !!real.isFutures, tag: `${cfg.mode}-HARN-EXIT`, isExit: true,
    }), _brokerTimeoutMs(), action);
  } catch (err) { transportErr = err; }

  if (transportErr || (result && result.uncertain)) {
    // Keep the record so a restart/retry can catch the still-open position.
    const why = transportErr ? transportErr.message : JSON.stringify(result.raw).slice(0, 200);
    _logEvent({ mode: cfg.mode, event: "REAL_EXIT_EXCEPTION", symbol: sym, action, error: why });
    console.error(`🚨 [HARNESS LIVE][${cfg.mode}] ${action} (exit) outcome UNKNOWN: ${why}`);
    _tg(`🚨 ${cfg.mode} LIVE ${action} (exit) ERROR — MANUAL ACTION REQUIRED\n${sym}: ${why}\nPaper closed but the broker exit errored/timed out — verify/square off manually NOW.`);
    // We may still hold it — put the exchange stop back too.
    await _rearmExchangeSL(cfg, real);
    return;
  }

  if (result && result.success) {
    // Clear ONLY after a successful close, and only if a concurrent re-entry
    // hasn't already replaced this record.
    _clearReal(cfg, real);
    _logEvent({ mode: cfg.mode, event: "REAL_EXIT_OK", orderId: result.orderId, symbol: sym, action, paperPnl: p.pnl });
    console.log(`✅ [HARNESS LIVE][${cfg.mode}] ${action} (exit) placed — orderId=${result.orderId} | paper-pnl=${p.pnl}`);
    try {
      if (cfg.liveLogKey) tradeLogger.appendTradeLog(cfg.liveLogKey, {
        _viaHarness: true, event: "EXIT", orderId: result.orderId, symbol: sym,
        side: p.side, direction: real.direction, spotAtEntry: p.spotAtEntry, spotAtExit: p.spotAtExit,
        paperPnl: p.pnl, sessionPnl: p.sessionPnl, ts: Date.now(),
      });
    } catch (_) {}
  } else {
    // Keep the record — broker rejected, we still hold it.
    _logEvent({ mode: cfg.mode, event: "REAL_EXIT_FAIL", symbol: sym, action, raw: result && result.raw });
    console.error(`🚨 [HARNESS LIVE][${cfg.mode}] ${action} (exit) FAILED — broker rejected. Symbol=${sym} — MANUAL ACTION REQUIRED.`);
    _tg(`🚨 ${cfg.mode} LIVE ${action} (exit) REJECTED — MANUAL ACTION REQUIRED\nPaper closed but the broker still holds the position — square off ${sym} manually NOW.\n${JSON.stringify(result && result.raw).slice(0, 200)}`);
    await _rearmExchangeSL(cfg, real);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Install the live harness for a given mode.
 *
 *   mode       — "PA-LIVE" | "BB_RSI-LIVE" | "EMA_RSI_ST-LIVE" (string used in logs)
 *   modeTag    — the mode field paper sets in notify payloads, e.g. "PA-PAPER"
 *                (because paper code hardcodes the suffix; harness filters on this)
 *   broker     — "fyers" | "zerodha"
 *   dryRun     — when true (DEFAULT), log-only, no real orders placed
 *   isFutures  — pass through to broker call
 *   defaultQty — fallback qty if exit notification doesn't carry it
 *   liveLogKey — tradeLogger mode key for live trade log; null disables live logging
 *
 * Returns nothing; uninstall via uninstallHarness().
 */
function installHarness({ mode, modeTag, broker, dryRun, isFutures, defaultQty, liveLogKey } = {}) {
  if (!mode || !modeTag || !broker) {
    throw new Error("installHarness requires { mode, modeTag, broker }");
  }
  if (_harnesses.has(mode)) {
    throw new Error(`Live harness already installed for ${mode}. Uninstall first.`);
  }
  // Default to dry-run unless explicitly set false
  const dr = (dryRun !== undefined)
    ? dryRun
    : ((process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() !== "false");

  const cfg = {
    mode,
    modeTag,
    broker,
    dryRun:     dr,
    isFutures:  _normFutures(isFutures),
    defaultQty: defaultQty || null,
    liveLogKey: liveLogKey || null,
  };

  _harnesses.set(mode, cfg);
  notify.setOrderHooks(mode, {
    entry: _makeEntryHook(cfg),
    exit:  _makeExitHook(cfg),
  });

  // Restart recovery: if a real position was open when the process died, restore
  // it so the next paper exit squares it off (rather than skipping as "no
  // position" and orphaning a live broker long). Only for LIVE harnesses — a
  // dry-run never held a real position.
  if (!dr && _keysForMode(_realPositions, mode).length === 0) {
    for (const restored of _loadRealPositionsForMode(mode)) {
      restored._restored = true;   // require broker confirmation before closing it
      _realPositions.set(_key(mode, restored.symbol), restored);
      // An entry whose fill was never confirmed before the restart still blocks
      // new entries until the user verifies it at the broker.
      if (restored.confirmed === false) _unconfirmedEntries.add(mode);
      _logEvent({ mode, event: "REAL_POSITION_RESTORED", symbol: restored.symbol, qty: restored.qty, orderId: restored.orderId, slOrderId: restored.slOrderId || null, direction: restored.direction });
      console.log(`♻️ [HARNESS][${mode}] Restored live position from disk — ${restored.direction} ${restored.qty}× ${restored.symbol} (orderId=${restored.orderId})${restored.slOrderId ? `, resting SL-M ${restored.slOrderId}` : ""}. Paper exit will square it off.`);
    }
    _ownedModes.add(mode);
  }

  _logEvent({ mode, event: "HARNESS_INSTALLED", broker, dryRun: dr });
  console.log(`🔧 [HARNESS][${mode}] Installed — broker=${broker} mode=${dr ? "DRY-RUN (no real orders)" : "🔴 LIVE (real orders)"}`);
  return { dryRun: dr };
}

function uninstallHarness(mode) {
  // No mode → uninstall all (used by shutdown paths).
  const modes = mode ? [mode] : [..._harnesses.keys()];
  for (const m of modes) {
    if (!_harnesses.has(m)) continue;
    notify.clearOrderHooks(m);
    _logEvent({ mode: m, event: "HARNESS_UNINSTALLED" });
    console.log(`🔧 [HARNESS][${m}] Uninstalled`);
    _harnesses.delete(m);
  }
}

function isInstalled(mode) {
  return mode ? _harnesses.has(mode) : _harnesses.size > 0;
}
// True if ANY installed harness is placing REAL orders (not dry-run). Used by
// the shutdown path: harness-live sessions run under a *_PAPER mode string, so
// the mode list alone would misclassify them as paper and skip the squareoff.
function hasLiveHarness() {
  for (const cfg of _harnesses.values()) if (!cfg.dryRun) return true;
  return false;
}
function getConfig(mode) {
  if (mode) return _harnesses.has(mode) ? { ..._harnesses.get(mode) } : null;
  // No mode → first installed config (legacy single-harness callers).
  const first = _harnesses.values().next().value;
  return first ? { ...first } : null;
}
function getRecentEvents(limit = 50, mode) {
  const src = mode ? _harnessLog.filter(e => e.mode === mode) : _harnessLog;
  return src.slice(-limit);
}

// Clear the "unconfirmed entry" block for a mode after the user has verified at
// the broker whether the timed-out order actually filled. Returns true if a
// block was cleared. Exposed so a UI/route can re-enable entries without a full
// process restart.
function clearUnconfirmedEntry(mode) {
  return _unconfirmedEntries.delete(mode);
}

function hasUnconfirmedEntry(mode) {
  return mode ? _unconfirmedEntries.has(mode) : _unconfirmedEntries.size > 0;
}

module.exports = {
  installHarness,
  uninstallHarness,
  isInstalled,
  hasLiveHarness,
  getConfig,
  getRecentEvents,
  clearUnconfirmedEntry,
  hasUnconfirmedEntry,
};

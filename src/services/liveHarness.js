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
// this is what lets every harness run in parallel.
const _harnesses = new Map();    // mode → config

// In-memory tracking of harness-placed orders for reconciliation + status
const _liveOrders = new Map();   // sessionId → [{symbol, side, qty, orderId, ts, status, ...}]

// Authoritative record of a CONFIRMED real broker position per mode. Set only
// when a real BUY actually fills; cleared on real exit. The exit hook must NOT
// send a SELL unless this says we truly hold the position — otherwise a
// rejected/failed entry (paper still holds a virtual long) would turn into a
// naked SHORT when paper later "exits". Keyed by mode → { symbol, qty, orderId }.
const _realPositions = new Map();

// Event log persisted to disk so the "Recent harness events" panel survives a
// server restart / deploy (the ring buffer used to be wiped on every reboot).
const DATA_DIR        = path.join(require("os").homedir(), "trading-data");
const HARNESS_LOG_FILE = path.join(DATA_DIR, ".harness_events.json");
const _harnessLog     = [];      // ring buffer of harness events for /live-harness/status

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

// ── Broker dispatch ─────────────────────────────────────────────────────────
async function _placeOrder({ broker, symbol, qty, sideAction, isFutures, tag }) {
  // sideAction: "BUY" (entry) or "SELL" (exit/squareoff)
  if (broker === "fyers") {
    const sideCode = sideAction === "BUY" ? 1 : -1;
    // Signature is placeMarketOrder(symbol, side, qty, orderTag, { isFutures }).
    // Passing the options object in the orderTag slot makes orderTag.substring()
    // throw, so every Fyers harness order (PA/BB_RSI/ORB live) silently failed.
    return fyersBroker.placeMarketOrder(symbol, sideCode, qty, tag, { isFutures });
  }
  if (broker === "zerodha") {
    if (!zerodhaBroker) throw new Error("zerodhaBroker module not loaded");
    // Zerodha signature differs from Fyers: (fyersSymbol, side, qty, orderTag, { isFutures })
    // where side is 1 (BUY) / -1 (SELL). Returns the same { success, orderId, raw } shape.
    const sideCode = sideAction === "BUY" ? 1 : -1;
    return zerodhaBroker.placeMarketOrder(symbol, sideCode, qty, tag, { isFutures });
  }
  throw new Error(`Unknown broker: ${broker}`);
}

// ── Optional exchange-resident disaster stop (default OFF) ───────────────────
// A percent-of-premium SL-M left resting at the exchange, so a hard crash while
// in a live position still has SOME protection. This is a DISASTER backstop, NOT
// the precise spot stop (paper's stop is a spot level, not an option trigger):
//   trigger = entryPremium × (1 − HARNESS_SL_PCT)
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
  try {
    const pct  = Math.min(0.95, Math.max(0.05, parseFloat(process.env.HARNESS_SL_PCT || "0.5")));
    const prem = await _fetchOptionPremium(realRec.symbol);
    if (!(prem > 0)) { console.warn(`[HARNESS][${cfg.mode}] exchange-SL skipped — no option premium for ${realRec.symbol}`); return; }
    const trigger = parseFloat((prem * (1 - pct)).toFixed(1));
    if (!(trigger > 0) || trigger >= prem) { console.warn(`[HARNESS][${cfg.mode}] exchange-SL skipped — bad trigger ${trigger} vs prem ${prem}`); return; }
    const res = await _brokerFor(cfg).placeSLMOrder(realRec.symbol, -1, realRec.qty, trigger, { isFutures: cfg.isFutures });
    if (res && res.success) {
      realRec.slOrderId = res.orderId;
      _logEvent({ mode: cfg.mode, event: "EXCHANGE_SL_PLACED", symbol: realRec.symbol, trigger, slOrderId: res.orderId });
      console.log(`🛡️ [HARNESS LIVE][${cfg.mode}] Exchange SL-M @ ₹${trigger} (${Math.round(pct * 100)}% below ₹${prem}) orderId=${res.orderId}`);
    } else {
      console.warn(`[HARNESS][${cfg.mode}] exchange-SL placement failed: ${JSON.stringify(res && res.raw).slice(0, 150)}`);
    }
  } catch (e) { console.warn(`[HARNESS][${cfg.mode}] exchange-SL error (skipped): ${e.message}`); }
}

// Best-effort cancel of a resting exchange SL-M. Always resolves (never rejects)
// so the caller can safely chain the square-off SELL after it. Cancelling BEFORE
// the market SELL prevents a double-sell (SL fires + our SELL → naked short).
function _cancelExchangeSL(cfg, realRec) {
  if (!realRec || !realRec.slOrderId) return Promise.resolve();
  return Promise.resolve()
    .then(() => _brokerFor(cfg).cancelOrder(realRec.slOrderId))
    .then(() => { _logEvent({ mode: cfg.mode, event: "EXCHANGE_SL_CANCELLED", slOrderId: realRec.slOrderId }); })
    .catch((e) => { console.warn(`[HARNESS][${cfg.mode}] exchange-SL cancel failed (${realRec.slOrderId}): ${e.message}`); });
}

// ── Order hooks (registered into notify; Telegram is emitted by notify itself) ─
function _makeEntryHook(cfg) {
  return function entryHook(p) {
    // Only act on the mode this harness is for. (Paper modes other than the
    // active one shouldn't trigger orders. mode field is e.g. "PA-PAPER".)
    const expectedModeTag = cfg.modeTag;   // e.g. "PA-PAPER"
    if (p.mode !== expectedModeTag) return;

    if (cfg.dryRun) {
      _logEvent({ mode: cfg.mode, event: "DRY_RUN_ENTRY", side: p.side, symbol: p.symbol, qty: p.qty, sl: p.stopLoss });
      console.log(`🧪 [HARNESS DRY-RUN][${cfg.mode}] Would BUY ${p.qty}× ${p.symbol} | SL=${p.stopLoss} | reason=${p.reason}`);
      return;
    }

    // Real order — fire-and-forget; paper has already committed state.position.
    // We log success/failure to telemetry; if order fails the user must
    // intervene (paper thinks it's in a position; broker has none).
    _placeOrder({
      broker:      cfg.broker,
      symbol:      p.symbol,
      qty:         p.qty,
      sideAction:  "BUY",
      isFutures:   cfg.isFutures,
      tag:         `${cfg.mode}-HARN`,
    })
      .then(result => {
        if (result && result.success) {
          // Record the confirmed real position so the exit hook knows we truly
          // hold it. Without this, a later paper exit would fire a naked SELL.
          _realPositions.set(cfg.mode, { symbol: p.symbol, qty: p.qty, orderId: result.orderId, ts: Date.now() });
          _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_OK", orderId: result.orderId, symbol: p.symbol, qty: p.qty });
          console.log(`✅ [HARNESS LIVE][${cfg.mode}] BUY filled — orderId=${result.orderId}`);
          // Optional exchange-resident disaster stop (default OFF; fire-and-forget, fails safe).
          _maybePlaceExchangeSL(cfg, _realPositions.get(cfg.mode));
          // Log to live trade log (separate from paper log)
          try {
            tradeLogger.appendTradeLog(cfg.liveLogKey, {
              _viaHarness: true,
              event: "ENTRY",
              orderId:     result.orderId,
              symbol:      p.symbol,
              qty:         p.qty,
              side:        p.side,
              spotAtEntry: p.spotAtEntry,
              stopLoss:    p.stopLoss,
              reason:      p.reason,
              ts:          Date.now(),
            });
          } catch (_) {}
        } else {
          _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_FAIL", symbol: p.symbol, raw: result && result.raw });
          console.error(`🚨 [HARNESS LIVE][${cfg.mode}] BUY FAILED — paper opened virtual position but broker rejected. Symbol=${p.symbol} | ${JSON.stringify(result && result.raw).slice(0, 200)}`);
          try { notify.sendIfMaster(`🚨 ${cfg.mode} LIVE BUY REJECTED\nPaper opened a position but the broker order failed — you are NOT in this trade.\nSymbol: ${p.symbol}\n${JSON.stringify(result && result.raw).slice(0, 200)}`); } catch (_) {}
        }
      })
      .catch(err => {
        _logEvent({ mode: cfg.mode, event: "REAL_ENTRY_EXCEPTION", symbol: p.symbol, error: err.message });
        console.error(`🚨 [HARNESS LIVE][${cfg.mode}] BUY exception: ${err.message}`);
        try { notify.sendIfMaster(`🚨 ${cfg.mode} LIVE BUY ERROR\n${p.symbol}: ${err.message}\nPaper opened a position but the broker order errored — verify manually.`); } catch (_) {}
      });
  };
}

function _makeExitHook(cfg) {
  return function exitHook(p) {
    const expectedModeTag = cfg.modeTag;
    if (p.mode !== expectedModeTag) return;

    if (cfg.dryRun) {
      _logEvent({ mode: cfg.mode, event: "DRY_RUN_EXIT", side: p.side, symbol: p.symbol, pnl: p.pnl });
      console.log(`🧪 [HARNESS DRY-RUN][${cfg.mode}] Would SELL ${p.symbol} (square-off) | paper-pnl=${p.pnl}`);
      return;
    }

    // Only square off a position we PROVABLY hold. If the entry never filled
    // (rejected/errored), paper still carries a virtual long — selling here
    // would open a naked SHORT. Skip and stay flat.
    const real = _realPositions.get(cfg.mode);
    if (!real) {
      _logEvent({ mode: cfg.mode, event: "REAL_EXIT_SKIPPED_NO_POSITION", symbol: p.symbol });
      console.warn(`⏭️ [HARNESS LIVE][${cfg.mode}] Paper exit but no confirmed real position — skipping SELL (not short-selling ${p.symbol}).`);
      return;
    }
    // Use the qty we actually bought as authoritative; never send a null qty.
    const exitQty = real.qty || p.qty || cfg.defaultQty;
    if (!exitQty || exitQty <= 0) {
      _logEvent({ mode: cfg.mode, event: "REAL_EXIT_ABORT_BAD_QTY", symbol: p.symbol });
      console.error(`🚨 [HARNESS LIVE][${cfg.mode}] Exit aborted — could not resolve a valid qty for ${p.symbol}. MANUAL square-off required.`);
      try { notify.sendIfMaster(`🚨 ${cfg.mode} LIVE EXIT ABORTED — bad qty for ${p.symbol}. Square off manually NOW.`); } catch (_) {}
      return;
    }
    // Clear the record up-front so a duplicate exit notify can't double-sell.
    _realPositions.delete(cfg.mode);

    const _doSell = () => _placeOrder({
      broker:      cfg.broker,
      symbol:      real.symbol || p.symbol,
      qty:         exitQty,
      sideAction:  "SELL",
      isFutures:   cfg.isFutures,
      tag:         `${cfg.mode}-HARN-EXIT`,
    })
      .then(result => {
        if (result && result.success) {
          _logEvent({ mode: cfg.mode, event: "REAL_EXIT_OK", orderId: result.orderId, symbol: p.symbol, paperPnl: p.pnl });
          console.log(`✅ [HARNESS LIVE][${cfg.mode}] SELL filled — orderId=${result.orderId} | paper-pnl=${p.pnl}`);
          try {
            tradeLogger.appendTradeLog(cfg.liveLogKey, {
              _viaHarness: true,
              event: "EXIT",
              orderId:     result.orderId,
              symbol:      p.symbol,
              side:        p.side,
              spotAtEntry: p.spotAtEntry,
              spotAtExit:  p.spotAtExit,
              paperPnl:    p.pnl,
              sessionPnl:  p.sessionPnl,
              ts:          Date.now(),
            });
          } catch (_) {}
        } else {
          _logEvent({ mode: cfg.mode, event: "REAL_EXIT_FAIL", symbol: p.symbol, raw: result && result.raw });
          console.error(`🚨 [HARNESS LIVE][${cfg.mode}] SELL FAILED — paper closed virtual position but broker rejected. Symbol=${p.symbol} — MANUAL ACTION REQUIRED.`);
          try { notify.sendIfMaster(`🚨 ${cfg.mode} LIVE SELL REJECTED — MANUAL ACTION REQUIRED\nPaper closed but the broker still holds the position — square off ${p.symbol} manually NOW.\n${JSON.stringify(result && result.raw).slice(0, 200)}`); } catch (_) {}
        }
      })
      .catch(err => {
        _logEvent({ mode: cfg.mode, event: "REAL_EXIT_EXCEPTION", symbol: p.symbol, error: err.message });
        console.error(`🚨 [HARNESS LIVE][${cfg.mode}] SELL exception: ${err.message}`);
        try { notify.sendIfMaster(`🚨 ${cfg.mode} LIVE SELL ERROR — MANUAL ACTION REQUIRED\n${p.symbol}: ${err.message}\nPaper closed but the broker exit errored — verify/square off manually NOW.`); } catch (_) {}
      });

    // Cancel any resting exchange SL-M FIRST, then square off — so the SL can't
    // fire on the same position we're selling (which would open a naked short).
    _cancelExchangeSL(cfg, real).then(_doSell);
  };
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
 *   liveLogKey — tradeLogger mode key for live trade log (e.g. "pa-live")
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
    isFutures:  !!isFutures,
    defaultQty: defaultQty || null,
    liveLogKey: liveLogKey || null,
  };

  _harnesses.set(mode, cfg);
  notify.setOrderHooks(mode, {
    entry: _makeEntryHook(cfg),
    exit:  _makeExitHook(cfg),
  });

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

module.exports = {
  installHarness,
  uninstallHarness,
  isInstalled,
  hasLiveHarness,
  getConfig,
  getRecentEvents,
};

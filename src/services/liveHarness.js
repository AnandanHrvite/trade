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
 *     Places real orders via fyersBroker (PA, SCALP) or zerodhaBroker (SWING).
 *     Hard SL on exchange via placeSLMOrder when enabled.
 *
 * Concurrency:
 *   Only one harness can be installed at a time (process-wide lock). Calling
 *   installHarness while another is active throws.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const notify       = require("../utils/notify");
const tradeLogger  = require("../utils/tradeLogger");
const fyersBroker  = require("./fyersBroker");
let   zerodhaBroker = null;
try { zerodhaBroker = require("./zerodhaBroker"); } catch (_) { /* optional */ }

let _installed = false;
let _orig      = null;
let _config    = null;

// In-memory tracking of harness-placed orders for reconciliation + status
const _liveOrders = new Map();   // sessionId → [{symbol, side, qty, orderId, ts, status, ...}]
const _harnessLog = [];          // ring buffer of harness events for /live-harness/status
function _logEvent(evt) {
  _harnessLog.push({ t: Date.now(), ...evt });
  if (_harnessLog.length > 500) _harnessLog.splice(0, _harnessLog.length - 500);
}

// ── Broker dispatch ─────────────────────────────────────────────────────────
async function _placeOrder({ broker, symbol, qty, sideAction, isFutures, tag }) {
  // sideAction: "BUY" (entry) or "SELL" (exit/squareoff)
  if (broker === "fyers") {
    const sideCode = sideAction === "BUY" ? 1 : -1;
    return fyersBroker.placeMarketOrder(symbol, sideCode, qty, { isFutures, orderTag: tag });
  }
  if (broker === "zerodha") {
    if (!zerodhaBroker) throw new Error("zerodhaBroker module not loaded");
    // Zerodha API signature differs — adapter expected to be added here when
    // swing harness is enabled. For now, throw to surface the gap.
    throw new Error("zerodhaBroker dispatch not yet wired in liveHarness — required before swing harness can flip from DRY-RUN to LIVE");
  }
  throw new Error(`Unknown broker: ${broker}`);
}

// ── Patched notify handlers ─────────────────────────────────────────────────
function _makePatchedNotifyEntry(orig, cfg) {
  return function patchedNotifyEntry(p) {
    // Always forward to original — Telegram alerts stay intact.
    try { orig(p); } catch (_) {}

    // Only act on the mode this harness is for. (Paper modes other than the
    // active one shouldn't trigger orders. mode field is e.g. "PA-PAPER".)
    const expectedModeTag = cfg.modeTag;   // e.g. "PA-PAPER"
    if (p.mode !== expectedModeTag) return;

    if (cfg.dryRun) {
      _logEvent({ event: "DRY_RUN_ENTRY", side: p.side, symbol: p.symbol, qty: p.qty, sl: p.stopLoss });
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
          _logEvent({ event: "REAL_ENTRY_OK", orderId: result.orderId, symbol: p.symbol, qty: p.qty });
          console.log(`✅ [HARNESS LIVE][${cfg.mode}] BUY filled — orderId=${result.orderId}`);
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
          _logEvent({ event: "REAL_ENTRY_FAIL", symbol: p.symbol, raw: result && result.raw });
          console.error(`🚨 [HARNESS LIVE][${cfg.mode}] BUY FAILED — paper opened virtual position but broker rejected. Symbol=${p.symbol} | ${JSON.stringify(result && result.raw).slice(0, 200)}`);
        }
      })
      .catch(err => {
        _logEvent({ event: "REAL_ENTRY_EXCEPTION", symbol: p.symbol, error: err.message });
        console.error(`🚨 [HARNESS LIVE][${cfg.mode}] BUY exception: ${err.message}`);
      });
  };
}

function _makePatchedNotifyExit(orig, cfg) {
  return function patchedNotifyExit(p) {
    try { orig(p); } catch (_) {}

    const expectedModeTag = cfg.modeTag;
    if (p.mode !== expectedModeTag) return;

    if (cfg.dryRun) {
      _logEvent({ event: "DRY_RUN_EXIT", side: p.side, symbol: p.symbol, pnl: p.pnl });
      console.log(`🧪 [HARNESS DRY-RUN][${cfg.mode}] Would SELL ${p.symbol} (square-off) | paper-pnl=${p.pnl}`);
      return;
    }

    _placeOrder({
      broker:      cfg.broker,
      symbol:      p.symbol,
      qty:         p.qty || cfg.defaultQty,
      sideAction:  "SELL",
      isFutures:   cfg.isFutures,
      tag:         `${cfg.mode}-HARN-EXIT`,
    })
      .then(result => {
        if (result && result.success) {
          _logEvent({ event: "REAL_EXIT_OK", orderId: result.orderId, symbol: p.symbol, paperPnl: p.pnl });
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
          _logEvent({ event: "REAL_EXIT_FAIL", symbol: p.symbol, raw: result && result.raw });
          console.error(`🚨 [HARNESS LIVE][${cfg.mode}] SELL FAILED — paper closed virtual position but broker rejected. Symbol=${p.symbol} — MANUAL ACTION REQUIRED.`);
        }
      })
      .catch(err => {
        _logEvent({ event: "REAL_EXIT_EXCEPTION", symbol: p.symbol, error: err.message });
        console.error(`🚨 [HARNESS LIVE][${cfg.mode}] SELL exception: ${err.message}`);
      });
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Install the live harness for a given mode.
 *
 *   mode       — "PA-LIVE" | "SCALP-LIVE" | "SWING-LIVE" (string used in logs)
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
  if (_installed) {
    throw new Error(`Live harness already installed for ${_config.mode}. Uninstall first.`);
  }
  if (!mode || !modeTag || !broker) {
    throw new Error("installHarness requires { mode, modeTag, broker }");
  }
  // Default to dry-run unless explicitly set false
  const dr = (dryRun !== undefined)
    ? dryRun
    : ((process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() !== "false");

  _config = {
    mode,
    modeTag,
    broker,
    dryRun:     dr,
    isFutures:  !!isFutures,
    defaultQty: defaultQty || null,
    liveLogKey: liveLogKey || null,
  };

  _orig = {
    notifyEntry: notify.notifyEntry,
    notifyExit:  notify.notifyExit,
  };

  notify.notifyEntry = _makePatchedNotifyEntry(_orig.notifyEntry, _config);
  notify.notifyExit  = _makePatchedNotifyExit(_orig.notifyExit,  _config);

  _installed = true;
  _logEvent({ event: "HARNESS_INSTALLED", mode, broker, dryRun: dr });
  console.log(`🔧 [HARNESS][${mode}] Installed — broker=${broker} mode=${dr ? "DRY-RUN (no real orders)" : "🔴 LIVE (real orders)"}`);
  return { dryRun: dr };
}

function uninstallHarness() {
  if (!_installed) return;
  notify.notifyEntry = _orig.notifyEntry;
  notify.notifyExit  = _orig.notifyExit;
  _logEvent({ event: "HARNESS_UNINSTALLED", mode: _config.mode });
  console.log(`🔧 [HARNESS][${_config.mode}] Uninstalled`);
  _installed = false;
  _orig      = null;
  _config    = null;
}

function isInstalled() { return _installed; }
function getConfig()   { return _config ? { ..._config } : null; }
function getRecentEvents(limit = 50) { return _harnessLog.slice(-limit); }

module.exports = {
  installHarness,
  uninstallHarness,
  isInstalled,
  getConfig,
  getRecentEvents,
};

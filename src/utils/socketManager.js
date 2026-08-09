/**
 * socketManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE permanent WebSocket. The spot index (NSE:NIFTY50-INDEX) is the primary
 * subscription; option contracts can be added and removed on the fly as
 * strategies enter and exit trades (see utils/optionFeed.js, which owns the
 * leasing/refcount policy — this file only owns the wire).
 *
 * ── Symbol attribution (why the probe exists) ────────────────────────────────
 * Every tick from the SDK lands in ONE `message` handler. Before options rode
 * this socket, every tick was by definition a spot tick, so the fan-out could
 * hand them all to the strategies. That is no longer true: an option tick fed
 * into a strategy's candle builder would corrupt the NIFTY candles outright.
 *
 * The SDK's tick field carrying the symbol is not contractually documented, so
 * we do not guess it. Instead we LEARN it: while only the spot is subscribed,
 * every tick is spot, so the first resolvable symbol string we see IS the spot
 * symbol's on-the-wire representation. Option subscriptions are refused until
 * that probe succeeds. Routing is then exact-match in both directions and
 * anything unattributable is dropped rather than guessed.
 *
 * Failure mode is therefore always "no option ticks, REST polling continues"
 * — never "option prices leak into spot candles".
 *
 * FIX: Fyers SDK enforces a hard singleton — calling `new fyersDataSocket()`
 * more than once throws "Only one instance of DataSocket is allowed."
 * The old workaround of using `new` on every reconnect broke in the current
 * SDK version. The correct approach:
 *   - Create the SDK instance ONCE per process lifetime (first connect)
 *   - On every reconnect: reuse the same instance, just call connect() again
 *   - Only null the instance reference when the process/session fully ends
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { fyersDataSocket } = require('fyers-api-v3');
const { notifyAuthError } = require('./notify');
const { clearFyersToken } = require('../config/fyers');
const tickRecorder         = require('./tickRecorder');
// Lazy-loaded to avoid a require-cycle (marketContext → instrument → fyers) at
// this module's load time, which is very early in app boot.
let _marketContextMod = null;
function _marketContext() {
  return _marketContextMod || (_marketContextMod = require('../services/marketContext'));
}

const HEARTBEAT_MS         = 20_000;
const MAX_BACKOFF          = 15_000;
const BASE_BACKOFF         = 2_000;
// After this many consecutive auth-rejection errors (Fyers code -15), give up retrying.
// The token is invalid — reconnecting won't help. We stop the loop, fire a Telegram
// alert, and surface a "broken" health state so the dashboard banner can light up.
const AUTH_FAIL_LIMIT      = 3;

/**
 * Resolve the instrument symbol carried by a raw SDK tick.
 * The field name is not contractually documented, so every plausible key is
 * tried. Returns a trimmed non-empty string, or null when the tick carries no
 * usable identifier (which the caller MUST treat as "cannot attribute").
 */
function tickSymbol(t) {
  if (!t || typeof t !== 'object') return null;
  const raw = t.symbol || t.sym || t.n || t.ex_sym || t.exSymbol || null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s.length ? s : null;
}

class SocketManager {
  constructor() {
    this._symbol         = null;
    this._onSpotTick     = null;
    this._onLog          = null;
    this._skt            = null;   // SDK instance — created once, reused on reconnects
    this._stopped        = true;
    this._retryCount     = 0;
    this._retryTimer     = null;
    this._watchdog       = null;
    this._lastTickAt     = null;
    this._connectedAt    = null;
    this._lastDownAt     = null;   // when the socket last went into a non-connected state
    this._authFailCount  = 0;      // consecutive auth-rejection errors (resets on tick)
    this._authFailed     = false;  // sticky — set when AUTH_FAIL_LIMIT reached
    this._lastErrorCode  = null;
    this._lastErrorMsg   = null;
    // ── Multi-callback fan-out for parallel modes (main + bb_rsi) ──────────
    // Map of callbackId → { onTick, onLog }
    // When secondary modes (bb_rsi) register, ticks are dispatched to ALL callbacks.
    this._callbacks  = new Map();
    // ── Extra (non-spot) subscriptions — option contracts ──────────────────
    // Set of exact Fyers symbols currently subscribed alongside the spot index.
    // Re-asserted on every reconnect. optionFeed owns when entries appear/vanish.
    this._extraSymbols     = new Set();
    this._onExtraTick      = null;   // (symbol, tick) => void — set by optionFeed
    // On-the-wire representation of the spot symbol, LEARNED from live ticks
    // while only the spot was subscribed. null until the probe succeeds; extras
    // are refused while it is null. See the header note on symbol attribution.
    this._spotTickSymbol   = null;
    this._attributionLogged = false;
    this._unattributedCount = 0;
    this._unattributedLoggedAt = 0;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  start(spotSymbol, onSpotTick, onLog) {
    // If socket is already running for the same symbol, just update callbacks —
    // do NOT tear down the connection, as other modes may be piggybacking on it.
    if (!this._stopped && this._symbol === spotSymbol) {
      this._onSpotTick = onSpotTick;
      this._onLog      = onLog;
      if (onLog) onLog(`📡 [SOCKET] Reusing existing connection for ${spotSymbol}`);
      return;
    }
    this._symbol        = spotSymbol;
    this._onSpotTick    = onSpotTick;
    this._onLog         = onLog;
    this._stopped       = false;
    this._retryCount    = 0;
    this._authFailCount = 0;
    this._authFailed    = false;
    this._lastErrorCode = null;
    this._lastErrorMsg  = null;
    this._lastDownAt    = Date.now();
    this._connect();
    this._startWatchdog();
  }

  /**
   * Register an additional tick callback (for parallel modes like bb_rsi).
   * Returns a callbackId to use for unregistering.
   * Socket must already be started by the primary mode.
   */
  addCallback(callbackId, onTick, onLog) {
    // Log only on a genuine first insert. Idempotent re-registration (e.g. the
    // option-chain recorder re-asserts its callback every poll to survive a
    // stop()-triggered _callbacks.clear()) must stay silent, or it floods /logs.
    const isNew = !this._callbacks.has(callbackId);
    this._callbacks.set(callbackId, { onTick, onLog });
    if (isNew) this._log(`📡 [SOCKET] Callback registered: ${callbackId} (total: ${this._callbacks.size})`);
  }

  /**
   * Remove a previously registered callback.
   */
  removeCallback(callbackId) {
    this._callbacks.delete(callbackId);
    this._log(`📡 [SOCKET] Callback removed: ${callbackId} (remaining: ${this._callbacks.size})`);
  }

  /**
   * Check if socket is currently running (for secondary modes to know if they
   * can piggyback without starting their own socket).
   */
  isRunning() {
    return !this._stopped;
  }

  // ── Extra (option) subscriptions ────────────────────────────────────────────

  /**
   * Install the handler that receives ticks for extra (non-spot) symbols.
   * Single handler by design — optionFeed is the only owner and does its own
   * per-symbol fan-out. Called with (symbol, rawTick).
   */
  setExtraTickHandler(fn) {
    this._onExtraTick = typeof fn === 'function' ? fn : null;
  }

  /**
   * True once ticks have been observed to carry a resolvable symbol, which is
   * the precondition for safely multiplexing options onto this connection.
   * Callers MUST check this before relying on extra subscriptions.
   */
  canSubscribeExtras() {
    return !this._stopped && this._spotTickSymbol !== null;
  }

  /**
   * Subscribe an additional instrument (an option contract) on the existing
   * connection. Idempotent. Returns false when attribution is unproven or the
   * socket is down — the caller must then keep using its REST fallback.
   */
  subscribeExtra(symbol) {
    if (!symbol || typeof symbol !== 'string') return false;
    if (!this.canSubscribeExtras()) return false;
    if (symbol === this._spotTickSymbol || symbol === this._symbol) return false;
    if (this._extraSymbols.has(symbol)) return true;
    this._extraSymbols.add(symbol);
    // A subscribe that fails on the wire must not leave the symbol marked as
    // subscribed — the reconnect path would keep re-asserting a bad symbol and
    // routing would silently drop ticks that never arrive.
    if (!this._sendSubscribe([symbol])) { this._extraSymbols.delete(symbol); return false; }
    this._log(`📡 [SOCKET] +option ${symbol} (extras: ${this._extraSymbols.size})`);
    return true;
  }

  /** Drop an extra subscription. Idempotent; safe when the socket is down. */
  unsubscribeExtra(symbol) {
    if (!symbol || !this._extraSymbols.has(symbol)) return;
    this._extraSymbols.delete(symbol);
    this._sendUnsubscribe([symbol]);
    this._log(`📡 [SOCKET] −option ${symbol} (extras: ${this._extraSymbols.size})`);
  }

  /** Currently subscribed extra symbols (diagnostics / health surface). */
  getExtraSymbols() {
    return Array.from(this._extraSymbols);
  }

  _sendSubscribe(symbols) {
    if (!this._skt || this._stopped) return false;
    try { this._skt.subscribe(symbols); return true; }
    catch (e) { this._log(`⚠️  [SOCKET] subscribe(${symbols.join(',')}) failed: ${e.message}`); return false; }
  }

  _sendUnsubscribe(symbols) {
    if (!this._skt || this._stopped) return false;
    try { this._skt.unsubscribe(symbols); return true; }
    catch (e) { this._log(`⚠️  [SOCKET] unsubscribe(${symbols.join(',')}) failed: ${e.message}`); return false; }
  }

  /** True once we've given up on a permanent auth failure (Fyers code -15). */
  isAuthFailed() {
    return this._authFailed;
  }

  /**
   * Health snapshot for the dashboard banner / /auth/socket-health endpoint.
   * `broken: true` means the user needs to act:
   *   - authFailed → re-login (token cleared)
   *   - down for >60s during market hours while a session is running
   */
  getHealth() {
    const running   = !this._stopped;
    const downForMs = this._lastDownAt ? Date.now() - this._lastDownAt : 0;
    const inMarket  = this._isMarketHours();
    const longDown  = running && inMarket && this._lastDownAt && downForMs > 60_000;
    let reason = null;
    if (this._authFailed) reason = "auth-failed";
    else if (longDown)    reason = "down";
    return {
      running,
      authFailed:    this._authFailed,
      broken:        !!reason,
      reason,
      lastErrorCode: this._lastErrorCode,
      lastErrorMsg:  this._lastErrorMsg,
      lastTickAt:    this._lastTickAt,
      downForMs:     this._lastDownAt ? downForMs : 0,
      inMarketHours: inMarket,
      optionSymbols:      this._extraSymbols.size,
      symbolAttribution:  this._spotTickSymbol,
      unattributedTicks:  this._unattributedCount,
    };
  }

  stop() {
    this._stopped    = true;
    this._onSpotTick = null;  // clear callback FIRST — prevents residual ticks reaching onTick()
    this._callbacks.clear();  // clear all secondary callbacks too
    // Drop option subscriptions before the connection goes away, so a restart
    // does not re-assert symbols nobody is holding a position in any more.
    if (this._extraSymbols.size) this._sendUnsubscribe(Array.from(this._extraSymbols));
    this._extraSymbols.clear();
    this._onExtraTick = null;
    this._spotTickSymbol = null;  // re-probe on the next session
    this._clearRetry();
    this._clearWatchdog();
    this._detachListeners();
    this._closeConnection();
    // Null the instance ONLY here so the next session can create a fresh one.
    this._skt = null;
    this._log('🔴 [SOCKET] Stopped');
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _log(msg) {
    if (this._onLog) this._onLog(msg);
    else console.log(msg);
  }

  /**
   * Decide what a single tick is and deliver it. Split out of the `message`
   * handler so the attribution rules — the part that can corrupt candles if it
   * is wrong — are directly testable without a live socket.
   */
  _routeTick(t) {
    if (!t || !t.ltp) return;
    const sym = tickSymbol(t);

    // Attribution probe: while no extras are subscribed every tick is spot, so
    // the first resolvable symbol we see IS the spot symbol on the wire.
    if (this._spotTickSymbol === null && this._extraSymbols.size === 0 && sym) {
      this._spotTickSymbol = sym;
      if (!this._attributionLogged) {
        this._attributionLogged = true;
        this._log(`📡 [SOCKET] Tick symbol attribution OK ("${sym}") — options may share this connection`);
      }
    }

    // Option tick → dedicated handler, never the strategy fan-out.
    if (sym && this._extraSymbols.has(sym)) {
      if (this._onExtraTick) {
        try { this._onExtraTick(sym, t); } catch (e) { this._log(`🚨 [SOCKET] Option fan-out error (${sym}): ${e.message}`); }
      }
      return;
    }

    // While options share the connection, a tick we cannot positively attribute
    // to the spot instrument must be DROPPED. Feeding an unidentified tick to
    // the strategies risks writing an option premium into the NIFTY candle
    // series, which is unrecoverable corruption — a dropped tick is not.
    if (this._extraSymbols.size > 0 && sym !== this._spotTickSymbol) {
      this._noteUnattributed(sym);
      return;
    }

    // Record raw tick for after-hours replay (no-op when TICK_RECORDER_ENABLED=false).
    // Done before fan-out so even if a strategy throws, the tick is still captured.
    try { tickRecorder.recordSpotTick(t); } catch (_) {}
    // Primary callback
    if (this._onSpotTick) {
      try { this._onSpotTick(t); } catch (e) { this._log(`🚨 [SOCKET] onSpotTick error: ${e.message}`); }
    }
    // Fan-out to all secondary callbacks (bb_rsi, etc.)
    for (const [id, cb] of this._callbacks) {
      try { if (cb.onTick) cb.onTick(t); } catch (e) { this._log(`🚨 [SOCKET] Fan-out error (${id}): ${e.message}`); }
    }
  }

  /**
   * Throttled notice for ticks that match neither the spot nor any subscribed
   * option. Expected to stay at zero; a rising count means the SDK labels
   * option ticks differently from the symbol we subscribed with, in which case
   * options simply keep using their REST fallback.
   */
  _noteUnattributed(sym) {
    this._unattributedCount++;
    const now = Date.now();
    if (now - this._unattributedLoggedAt < 60_000) return;
    this._unattributedLoggedAt = now;
    this._log(`⚠️  [SOCKET] ${this._unattributedCount} tick(s) dropped — unattributable symbol (last: ${sym || 'none'})`);
  }

  _detachListeners() {
    if (this._skt) {
      try { this._skt.removeAllListeners(); } catch (_) {}
    }
  }

  _closeConnection() {
    if (this._skt) {
      try { this._skt.close(); } catch (_) {}
      // NOTE: Do NOT set this._skt = null here.
      // The Fyers SDK is a hard singleton. We keep the reference so _connect()
      // can call skt.connect() on the existing instance instead of re-instantiating.
    }
    // Clear connectedAt so the 'close' handler's uptime check uses the most recent
    // successful connect window, not a stale one from earlier in the session. Without
    // this reset, the SDK firing 'close' before 'connect' on reconnect would read an
    // ancient _connectedAt (e.g. session start at 09:15), compute uptime > 10s on every
    // close, and wrongly reset retryCount to 0 — making backoff useless and burning
    // through reconnect attempts continuously.
    this._connectedAt = null;
  }

  _connect() {
    if (this._stopped) return;

    // Remove stale listeners before re-attaching (prevents duplicate handlers on reconnect)
    this._detachListeners();
    this._closeConnection();

    const token = `${process.env.APP_ID}:${process.env.ACCESS_TOKEN}`;
    this._log(`📡 [SOCKET] Connecting... symbol: ${this._symbol}`);

    // Acquire SDK instance:
    // - First connect this session → create via `new`
    // - All reconnects → reuse the same instance (re-creating throws)
    if (!this._skt) {
      try {
        this._skt = new fyersDataSocket(token, './logs', true);
      } catch (err) {
        // SDK singleton already exists from a prior session in this process.
        this._log(`⚠️  [SOCKET] SDK singleton exists — using getInstance()`);
        try {
          this._skt = fyersDataSocket.getInstance();
        } catch (e2) {
          this._log(`❌ [SOCKET] Cannot acquire SDK instance: ${e2.message}`);
          this._scheduleReconnect();
          return;
        }
      }
    }

    const skt = this._skt;

    skt.on('connect', () => {
      if (this._stopped) { this._detachListeners(); this._closeConnection(); return; }
      this._connectedAt = Date.now();
      this._lastTickAt  = Date.now();
      this._lastDownAt  = null;
      this._log(`✅ [SOCKET] Connected — subscribing: ${this._symbol}`);
      skt.subscribe([this._symbol]);
      skt.mode(skt.FullMode);
      // Re-assert option subscriptions the previous connection carried — a
      // reconnect resets the server-side subscription set, and a strategy
      // holding a position would otherwise silently lose its price feed.
      if (this._extraSymbols.size) {
        const extras = Array.from(this._extraSymbols);
        if (this._sendSubscribe(extras)) {
          this._log(`📡 [SOCKET] Re-subscribed ${extras.length} option symbol(s) after reconnect`);
        }
      }
    });

    skt.on('message', (msg) => {
      if (this._stopped) return;
      this._lastTickAt = Date.now();
      // Real ticks arriving means auth is fine — clear any partial auth-fail count.
      if (this._authFailCount > 0) this._authFailCount = 0;
      const ticks = Array.isArray(msg) ? msg : [msg];
      // Capture the day's immutable Market Context Snapshot once (strategy-independent),
      // per message rather than per tick. Fire-and-forget with an async .catch so a
      // rejection can't escape to the global unhandledRejection handler; cheap
      // boolean guard, resolves at most once/day.
      try { _marketContext().maybeCapture().catch(() => {}); } catch (_) {}
      ticks.forEach(t => this._routeTick(t));
    });

    skt.on('error', (err) => {
      this._log(`❌ [SOCKET] Error: ${JSON.stringify(err)}`);
      // Track last error for /socket-health surface.
      try {
        this._lastErrorCode = err && err.code != null ? err.code : null;
        this._lastErrorMsg  = err && err.message ? String(err.message) : null;
      } catch (_) {}
      // Code -15 from Fyers WS is "Please provide valid token" — auth is dead, retrying
      // can't recover it. After AUTH_FAIL_LIMIT consecutive -15s, bail out: stop retries,
      // clear the bad token from disk + env so a stale token can't be picked up after a
      // restart, fire a Telegram alert, and surface broken-state on the health endpoint.
      if (err && err.code === -15) {
        this._authFailCount += 1;
        if (this._authFailCount >= AUTH_FAIL_LIMIT && !this._authFailed) {
          this._authFailed = true;
          this._clearRetry();
          this._log(`🛑 [SOCKET] Auth rejected ${this._authFailCount}× (code -15) — giving up. Token cleared. Re-login at /auth/login.`);
          try { clearFyersToken(); } catch (e) { this._log(`⚠️  [SOCKET] Token clear failed: ${e.message}`); }
          try { notifyAuthError({ broker: "Fyers", code: err.code, message: err.message || "Invalid token" }); } catch (_) {}
          return;
        }
      }
      if (!this._stopped) this._scheduleReconnect();
    });

    skt.on('close', () => {
      this._log('🔴 [SOCKET] Disconnected unexpectedly');
      this._lastDownAt = Date.now();
      // Only reset retryCount if connection was stable for at least 10 seconds.
      // This prevents infinite 2s loops when the server immediately rejects.
      const uptime = this._connectedAt ? Date.now() - this._connectedAt : 0;
      if (uptime > 10_000) {
        this._retryCount = 0;
      }
      // NOTE: Do NOT set this._skt = null here — we need it for the reconnect.
      // Don't reconnect if auth has been declared dead — _scheduleReconnect would
      // no-op anyway, but skipping the call keeps the log clean.
      if (!this._stopped && !this._authFailed) this._scheduleReconnect();
    });

    skt.connect();
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    if (this._authFailed) return;  // hard-stop on permanent auth failure
    this._clearRetry();
    const delay = Math.min(BASE_BACKOFF * Math.pow(2, this._retryCount), MAX_BACKOFF);
    this._retryCount++;
    this._log(`🔁 [SOCKET] Retry in ${(delay / 1000).toFixed(1)}s (attempt ${this._retryCount})`);
    this._retryTimer = setTimeout(() => { if (!this._stopped) this._connect(); }, delay);
  }

  _clearRetry() {
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
  }

  _startWatchdog() {
    this._clearWatchdog();
    this._watchdog = setInterval(() => {
      try {
        if (this._stopped) { this._clearWatchdog(); return; }
        if (this._authFailed) return;  // don't try to reconnect on dead auth
        if (!this._isMarketHours()) return;
        const silence = this._lastTickAt ? Date.now() - this._lastTickAt : Infinity;
        if (silence > HEARTBEAT_MS) {
          this._log(`⚠️  [SOCKET] Watchdog: no tick for ${Math.round(silence / 1000)}s — reconnecting`);
          this._lastTickAt = Date.now();
          this._clearRetry();
          this._connect();
        }
      } catch (err) {
        this._log(`🚨 [SOCKET] Watchdog error: ${err.message}`);
      }
    }, 5_000);
  }

  _clearWatchdog() {
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
  }

  _isMarketHours() {
    // Fast IST: UTC+5:30 = +19800 seconds (avoids expensive toLocaleString/ICU)
    const istSec = Math.floor(Date.now() / 1000) + 19800;
    const total  = Math.floor(istSec / 60) % 1440;
    return total >= 555 && total < 920;
  }
}

module.exports = new SocketManager();
// Exported for unit tests — the attribution rules live and die by this resolver.
module.exports.tickSymbol = tickSymbol;
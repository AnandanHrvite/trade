/**
 * socketManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE permanent WebSocket → NSE:NIFTY50-INDEX only.
 * Option LTP → Fyers REST API polled every 3 seconds. No socket changes.
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

const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF  = 15_000;
const BASE_BACKOFF = 2_000;

class SocketManager {
  constructor() {
    this._symbol     = null;
    this._onSpotTick = null;
    this._onLog      = null;
    this._skt        = null;   // SDK instance — created once, reused on reconnects
    this._stopped    = true;
    this._retryCount = 0;
    this._retryTimer = null;
    this._watchdog   = null;
    this._lastTickAt = null;
    // ── Multi-callback fan-out for parallel modes (main + scalp) ──────────
    // Map of callbackId → { onTick, onLog }
    // When secondary modes (scalp) register, ticks are dispatched to ALL callbacks.
    this._callbacks  = new Map();
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
    this._symbol     = spotSymbol;
    this._onSpotTick = onSpotTick;
    this._onLog      = onLog;
    this._stopped    = false;
    this._retryCount = 0;
    this._connect();
    this._startWatchdog();
  }

  /**
   * Register an additional tick callback (for parallel modes like scalp).
   * Returns a callbackId to use for unregistering.
   * Socket must already be started by the primary mode.
   */
  addCallback(callbackId, onTick, onLog) {
    this._callbacks.set(callbackId, { onTick, onLog });
    this._log(`📡 [SOCKET] Callback registered: ${callbackId} (total: ${this._callbacks.size})`);
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

  stop() {
    this._stopped    = true;
    this._onSpotTick = null;  // clear callback FIRST — prevents residual ticks reaching onTick()
    this._callbacks.clear();  // clear all secondary callbacks too
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
      this._lastTickAt = Date.now();
      this._log(`✅ [SOCKET] Connected — subscribing: ${this._symbol}`);
      skt.subscribe([this._symbol]);
      skt.mode(skt.FullMode);
    });

    skt.on('message', (msg) => {
      if (this._stopped) return;
      this._lastTickAt = Date.now();
      const ticks = Array.isArray(msg) ? msg : [msg];
      ticks.forEach(t => {
        if (!t || !t.ltp) return;
        // Primary callback
        if (this._onSpotTick) {
          try { this._onSpotTick(t); } catch (e) { this._log(`🚨 [SOCKET] onSpotTick error: ${e.message}`); }
        }
        // Fan-out to all secondary callbacks (scalp, etc.)
        for (const [id, cb] of this._callbacks) {
          try { if (cb.onTick) cb.onTick(t); } catch (e) { this._log(`🚨 [SOCKET] Fan-out error (${id}): ${e.message}`); }
        }
      });
    });

    skt.on('error', (err) => {
      this._log(`❌ [SOCKET] Error: ${JSON.stringify(err)}`);
      if (!this._stopped) this._scheduleReconnect();
    });

    skt.on('close', () => {
      this._log('🔴 [SOCKET] Disconnected unexpectedly');
      // Only reset retryCount if connection was stable for at least 10 seconds.
      // This prevents infinite 2s loops when the server immediately rejects.
      const uptime = this._connectedAt ? Date.now() - this._connectedAt : 0;
      if (uptime > 10_000) {
        this._retryCount = 0;
      }
      // NOTE: Do NOT set this._skt = null here — we need it for the reconnect.
      if (!this._stopped) this._scheduleReconnect();
    });

    skt.connect();
  }

  _scheduleReconnect() {
    if (this._stopped) return;
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
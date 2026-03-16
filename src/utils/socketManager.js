/**
 * socketManager.js — FINAL ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE permanent WebSocket → NSE:NIFTY50-INDEX only. NEVER reconnected.
 * Option LTP → Fyers REST API polled every 3 seconds. No socket changes.
 *
 * Why this is better:
 *   - Fyers SDK singleton can only reliably handle ONE stable connection
 *   - Adding/removing symbols forces a reconnect = ticks drop = bugs
 *   - REST getQuotes() is perfectly fast enough for option premium display
 *   - SL logic runs on spot ticks = uninterrupted forever
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { fyersDataSocket } = require('fyers-api-v3');

const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF  = 30_000;
const BASE_BACKOFF = 2_000;

class SocketManager {
  constructor() {
    this._symbol     = null;
    this._onSpotTick = null;
    this._onLog      = null;
    this._skt        = null;
    this._stopped    = true;
    this._retryCount = 0;
    this._retryTimer = null;
    this._watchdog   = null;
    this._lastTickAt = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Start permanent NIFTY spot socket. Call once per session. */
  start(spotSymbol, onSpotTick, onLog) {
    this._symbol     = spotSymbol;
    this._onSpotTick = onSpotTick;
    this._onLog      = onLog;
    this._stopped    = false;
    this._retryCount = 0;
    this._connect();
    this._startWatchdog();
  }

  /** Stop everything — call on session stop. */
  stop() {
    this._stopped = true;
    this._onSpotTick = null;  // ← clear callback FIRST — prevents any residual/SDK-internal
                               //   ticks from reaching onTick() even if Fyers SDK reconnects
    this._clearRetry();
    this._clearWatchdog();
    this._closeSocket();
    this._log('🔴 [SOCKET] Stopped');
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _log(msg) {
    if (this._onLog) this._onLog(msg);
    else console.log(msg);
  }

  _closeSocket() {
    if (this._skt) {
      try { this._skt.removeAllListeners(); } catch (_) {}
      try { this._skt.close(); }             catch (_) {}
      this._skt = null;
    }
  }

  _connect() {
    if (this._stopped) return;
    this._closeSocket();

    const token = `${process.env.APP_ID}:${process.env.ACCESS_TOKEN}`;
    this._log(`📡 [SOCKET] Connecting... symbol: ${this._symbol}`);

    const skt = fyersDataSocket.getInstance(token, './logs', true);

    skt.on('connect', () => {
      if (this._stopped) { this._closeSocket(); return; }
      this._retryCount = 0;
      this._lastTickAt = Date.now();
      this._log(`✅ [SOCKET] Connected — subscribing: ${this._symbol}`);
      skt.subscribe([this._symbol]);
      skt.mode(skt.FullMode);
    });

    skt.on('message', (msg) => {
      if (this._stopped) return;                    // ← guard: drop ticks after stop() is called
      this._lastTickAt = Date.now();
      const ticks = Array.isArray(msg) ? msg : [msg];
      ticks.forEach(t => { if (t && t.ltp && this._onSpotTick) this._onSpotTick(t); });
    });

    skt.on('error', (err) => {
      this._log(`❌ [SOCKET] Error: ${JSON.stringify(err)}`);
    });

    skt.on('close', () => {
      this._log('🔴 [SOCKET] Disconnected unexpectedly');
      this._skt = null;
      if (!this._stopped) this._scheduleReconnect();
    });

    skt.connect();
    this._skt = skt;
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
      if (this._stopped) { this._clearWatchdog(); return; }
      if (!this._isMarketHours()) return;
      const silence = this._lastTickAt ? Date.now() - this._lastTickAt : Infinity;
      if (silence > HEARTBEAT_MS) {
        this._log(`⚠️  [SOCKET] Watchdog: no tick for ${Math.round(silence / 1000)}s — reconnecting`);
        this._lastTickAt = Date.now();
        this._clearRetry();
        this._connect();
      }
    }, 5_000);
  }

  _clearWatchdog() {
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
  }

  _isMarketHours() {
    const ist   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const total = ist.getHours() * 60 + ist.getMinutes();
    return total >= 555 && total < 920;
  }
}

module.exports = new SocketManager();
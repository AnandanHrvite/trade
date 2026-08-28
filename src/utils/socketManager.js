/**
 * socketManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE permanent WebSocket. The spot index (NSE:NIFTY50-INDEX) is the primary
 * subscription; option contracts can be added and removed on the fly as
 * strategies enter and exit trades (see utils/optionFeed.js, which owns the
 * leasing policy — this file only owns the wire).
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
const sharedSocketState    = require('./sharedSocketState');
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
// Consecutive unattributable ticks (no spot delivery in between) before option
// multiplexing is abandoned. Ticks arrive several per second, so this is ~10s of
// a feed the strategies are getting nothing from — unambiguous, and far above
// any plausible one-off oddity.
const UNATTRIBUTED_BAIL    = 50;
// ── Connection flapping ──────────────────────────────────────────────────────
// A socket that connects and is dropped again seconds later is NOT healthy, but
// every individual cycle looks fine: `close` resets nothing, `connect` clears
// _lastDownAt, so the "down for >60s" broken-state never trips and the retry
// loop spins silently forever (observed: 330 cycles in one session, no alert).
// A connection that never survives this long is counted as a flap.
const FLAP_UPTIME_MS       = 10_000;
// Consecutive flaps before the feed is declared unhealthy: surfaced on
// /auth/socket-health (dashboard banner) and pushed once to Telegram.
// Retries deliberately CONTINUE — the session must never stop on its own.
const FLAP_ALERT_AFTER     = 5;
// Re-alert cadence while a flap storm is still going, so a feed that stays
// broken for hours keeps reminding rather than alerting once and going quiet.
const FLAP_REALERT_MS      = 15 * 60_000;
// How long a just-unsubscribed option symbol stays known-not-spot. Removing a
// symbol from _extraSymbols is instant, but the wire keeps delivering whatever
// it had already queued — and a tick matching neither the extras set nor the
// spot symbol would otherwise be treated as spot. Generous because the cost of
// holding a tombstone is one map entry and the cost of missing one is a
// corrupted candle series.
const TOMBSTONE_MS         = 60_000;

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
    // Bumped on every _connect() and retired by stop(). Handlers capture the
    // value current when they were attached and ignore events carrying an older
    // one, so a listener that outlived its attempt cannot act on stale events.
    // (The teardown-close loop is handled separately, inside _connect() — the
    // generation cannot catch that one, because the echo lands on handlers that
    // were attached after the close was requested and so match the current value.)
    this._connGen        = 0;
    this._watchdog       = null;
    this._lastTickAt     = null;   // ANY tick — spot or option (health display)
    // Last tick actually delivered to the strategies. The watchdog reconnects on
    // spot silence, and before options shared this socket the two were the same
    // number. They are not any more: option ticks alone would keep _lastTickAt
    // fresh while the spot subscription was dead, hiding a total trading halt
    // behind a healthy-looking clock. The watchdog reads THIS one.
    this._lastSpotTickAt = null;
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
    // Consecutive unattributable ticks with no spot delivery in between. Reset
    // by every successful spot tick; crossing the limit disables option sharing
    // for the rest of the session (see _bailOutOfExtras).
    this._unattributedStreak = 0;
    this._extrasDisabled     = false;
    // Whether any option has shared this connection yet. The strict spot match
    // costs nothing once options are in play, but before the day's first trade
    // there is nothing to disambiguate — so it stays off and the tick path is
    // byte-for-byte what it was before this feature existed.
    this._extrasEverUsed     = false;
    // symbol → expiry ms. Symbols we have unsubscribed but whose queued ticks
    // may still arrive; they must never be mistaken for the spot instrument.
    this._tombstones         = new Map();
    // ── Flap tracking (see FLAP_* constants) ──────────────────────────────
    this._flapCount     = 0;      // consecutive sub-FLAP_UPTIME_MS connections
    this._flapping      = false;  // sticky while the storm lasts; cleared by a stable connect
    this._flapSince     = null;   // when the current storm started
    this._flapAlertedAt = 0;      // last Telegram push, for FLAP_REALERT_MS cadence
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
    // Reaching here means a DIFFERENT spot instrument (the same-symbol case
    // returned above). Everything the attribution probe learned describes the
    // old one, so it must be re-learned — and the probe only runs with no extras
    // subscribed, so those go too. Skipping this would leave the strict spot
    // match rejecting every tick of the new instrument until the bail-out fired
    // 50 ticks later. All call sites currently pass the same NIFTY index symbol,
    // so this is a latent path, not a live one.
    if (this._symbol && this._symbol !== spotSymbol) {
      if (this._extraSymbols.size) {
        this._tombstone(Array.from(this._extraSymbols));
        this._sendUnsubscribe(Array.from(this._extraSymbols));
        this._extraSymbols.clear();
      }
      this._spotTickSymbol     = null;
      this._attributionLogged  = false;
      this._extrasEverUsed     = false;
      this._unattributedStreak = 0;
      this._lastSpotTickAt     = null;
      // _extrasDisabled is deliberately NOT cleared. A bail-out means this wire
      // was labelling ticks in a way we could not follow, which is a property of
      // the feed rather than of the instrument — so switching instruments is no
      // reason to trust it again. Only stop(), a genuinely new session, does.
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
    // A new session must not inherit the previous one's flap storm, or the
    // banner would stay red until the counter happened to be cleared.
    this._flapCount     = 0;
    this._flapping      = false;
    this._flapSince     = null;
    this._flapAlertedAt = 0;
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
    return !this._stopped && !this._extrasDisabled && this._spotTickSymbol !== null;
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
    // Re-entering a strike we just left: the tombstone has done its job and
    // must go, or every tick for the new subscription would be discarded.
    this._tombstones.delete(symbol);
    this._extraSymbols.add(symbol);
    this._extrasEverUsed = true;
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
    this._tombstone([symbol]);
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
    if (this._authFailed)     reason = "auth-failed";
    else if (longDown)        reason = "down";
    // Flapping is its own broken-state: the socket keeps *connecting*, so the
    // "down for >60s" test above never fires, yet no tick ever reaches a
    // strategy. Without this the dashboard showed green through 330 drops.
    // Gated on `running`: a released feed has not gone unstable, and the banner's
    // "strategies are getting NO live ticks" is meaningless with none attached.
    else if (running && this._flapping) reason = "flapping";
    return {
      running,
      authFailed:    this._authFailed,
      broken:        !!reason,
      reason,
      lastErrorCode: this._lastErrorCode,
      lastErrorMsg:  this._lastErrorMsg,
      lastTickAt:    this._lastTickAt,
      lastSpotTickAt: this._lastSpotTickAt,
      downForMs:     this._lastDownAt ? downForMs : 0,
      inMarketHours: inMarket,
      optionSymbols:      this._extraSymbols.size,
      symbolAttribution:  this._spotTickSymbol,
      unattributedTicks:  this._unattributedCount,
      flapping:           this._flapping,
      flapCount:          this._flapCount,
      flapSince:          this._flapSince,
    };
  }

  stop() {
    this._stopped    = true;
    this._onSpotTick = null;  // clear callback FIRST — prevents residual ticks reaching onTick()
    this._callbacks.clear();  // clear all secondary callbacks too
    // Drop option subscriptions before the connection goes away, so a restart
    // does not re-assert symbols nobody is holding a position in any more.
    if (this._extraSymbols.size) {
      // Tombstones deliberately OUTLIVE the session: the next session's
      // attribution probe runs with an empty extras set, so a straggling option
      // tick arriving during teardown could otherwise be learned as the spot
      // symbol — poisoning routing for the whole of the next session.
      this._tombstone(Array.from(this._extraSymbols));
      this._sendUnsubscribe(Array.from(this._extraSymbols));
    }
    this._extraSymbols.clear();
    this._onExtraTick = null;
    this._spotTickSymbol = null;  // re-probe on the next session
    this._lastSpotTickAt = null;  // watchdog clock starts fresh with the session
    this._extrasDisabled = false; // a new session gets a fresh chance
    this._extrasEverUsed = false;
    this._unattributedStreak = 0;
    // Silently — a released feed has not "recovered". start() resets these for
    // the next session, but nothing did on the way out, so a storm that ended
    // with the close stayed latched in getHealth() and kept the dashboard banner
    // red all evening, its "over ~N min" counting up until the next open.
    this._clearFlap(true);
    this._clearRetry();
    this._clearWatchdog();
    this._detachListeners();
    this._closeConnection();
    // Retire the generation too. _detachListeners() swallows a throw, so a
    // handler can outlive teardown; without this it would still match _connGen
    // and could schedule a reconnect (or clear the token on a stale -15) for a
    // session that is over.
    this._connGen += 1;
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

    // A contract we have just unsubscribed, still draining off the wire. This
    // check must come FIRST: it is no longer in _extraSymbols, so without it the
    // tick would fall through and be delivered as spot. Expected, so no warning.
    if (sym && this._isTombstoned(sym)) return;

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

    // Once we know what the spot instrument looks like on the wire, delivery is
    // a POSITIVE match against it — not "anything that wasn't an option".
    // Gating on `_extraSymbols.size > 0` instead would leave a hole every time a
    // contract is dropped: its queued ticks arrive with the set already empty
    // and get delivered as spot, writing an option premium into the candle
    // series. Unrecoverable corruption; a dropped tick is not.
    //
    // Skipped before the first option ever shares the connection, and again
    // once we have given up on sharing it — in both states there is nothing to
    // disambiguate, so the check could only cost us genuine spot ticks. Those
    // sessions behave exactly as they did before this feature.
    if (this._extrasEverUsed && !this._extrasDisabled
        && this._spotTickSymbol !== null && sym !== this._spotTickSymbol) {
      this._noteUnattributed(sym);
      return;
    }

    // A spot tick got through, so attribution is still working — and this is
    // the clock the watchdog reconnects on.
    this._unattributedStreak = 0;
    this._lastSpotTickAt = Date.now();

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
    this._unattributedStreak++;
    // Dropping ticks is the safe response to ONE odd tick. A long run of them
    // with no spot delivery in between means something else: the wire is
    // labelling the spot instrument differently from what we learned, so the
    // strategies have stopped receiving ticks entirely. That is a silent
    // trading halt, and the watchdog cannot see it because ticks ARE arriving
    // (_lastTickAt keeps updating). Give up on sharing the connection and go
    // back to the known-good arrangement: spot only, options over REST.
    if (this._unattributedStreak >= UNATTRIBUTED_BAIL) { this._bailOutOfExtras(); return; }
    const now = Date.now();
    if (now - this._unattributedLoggedAt < 60_000) return;
    this._unattributedLoggedAt = now;
    this._log(`⚠️  [SOCKET] ${this._unattributedCount} tick(s) dropped — unattributable symbol (last: ${sym || 'none'})`);
  }

  /**
   * Abandon option multiplexing for the rest of the session. Sticky on purpose:
   * re-probing would re-subscribe and fall straight back into the same state,
   * so this stays off until stop() starts a genuinely new session.
   */
  _bailOutOfExtras() {
    const dropped = Array.from(this._extraSymbols);
    this._extrasDisabled     = true;
    this._unattributedStreak = 0;
    this._extraSymbols.clear();
    // Tombstoned, not just unsubscribed: queued option ticks will keep arriving
    // for a moment, and with the strict spot check now disabled they would be
    // delivered as spot. `_spotTickSymbol` is deliberately KEPT — re-learning it
    // from whatever arrives next could latch onto one of those very ticks.
    if (dropped.length) { this._tombstone(dropped); this._sendUnsubscribe(dropped); }
    this._log(`🛑 [SOCKET] ${UNATTRIBUTED_BAIL} consecutive unattributable ticks — option streaming DISABLED for this session, unsubscribed ${dropped.length} contract(s). Strategies revert to REST option polling; spot feed restored.`);
  }

  /** Mark symbols as known-not-spot for TOMBSTONE_MS. */
  _tombstone(symbols) {
    const now = Date.now();
    // Bulk-prune while we are here. _isTombstoned only prunes what it is asked
    // about, so a symbol never seen again would sit in the map for the life of
    // the process. This runs a handful of times a day — free.
    for (const [sym, until] of this._tombstones) {
      if (now >= until) this._tombstones.delete(sym);
    }
    const until = now + TOMBSTONE_MS;
    for (const s of symbols) this._tombstones.set(s, until);
  }

  /** True while `sym` is a recently-dropped contract. Prunes as it goes. */
  _isTombstoned(sym) {
    const until = this._tombstones.get(sym);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this._tombstones.delete(sym);
    return false;
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

    // A pending retry timer is now redundant: we are connecting right here. Left
    // armed, it fires mid-attempt and starts a second reconnect loop racing this
    // one — which is exactly how the watchdog calling _connect() during a pending
    // retry produced a permanent connect/drop cycle.
    this._clearRetry();

    // Every attempt gets its own generation, so a handler that outlives its
    // attempt (removeAllListeners() swallows a throw) cannot act on stale events.
    const gen = ++this._connGen;

    // Generation alone is NOT enough for `close`. _closeConnection() below makes
    // the SDK emit a close asynchronously, by which point the new handlers are
    // already attached and carry the CURRENT generation — so that teardown close
    // reads as "the new connection just died" and schedules a reconnect, which
    // tears down and closes again. That is the loop that ran 567 times on
    // 2026-08-28. So the first pre-connect close of each attempt is treated as
    // that echo and swallowed; anything after it is a real disconnect.
    let opened = false;
    let teardownEchoSeen = false;

    // Remove stale listeners before re-attaching (prevents duplicate handlers on reconnect)
    this._detachListeners();
    this._closeConnection();

    const token = `${process.env.APP_ID}:${process.env.ACCESS_TOKEN}`;
    this._log(`📡 [SOCKET] Connecting... symbol: ${this._symbol}`);

    // NOTE: there is deliberately no "rebuild the SDK on a flap storm" step here.
    // The Fyers SDK is a hard singleton (see the header): `new` throws once an
    // instance exists, so the fallback path hands back the SAME object. Nulling
    // the reference would therefore close a working socket and get the identical
    // instance in return — strictly worse than leaving it alone.

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

    // Every SDK call in here is third-party code reached from an EventEmitter
    // callback: a throw would be an uncaughtException, and app.js answers that by
    // exiting the process. Losing the subscription is recoverable — the watchdog
    // reconnects on spot silence. Killing the process mid-session is not.
    skt.on('connect', () => {
      try {
        if (gen !== this._connGen) return;  // superseded attempt
        if (this._stopped) { this._detachListeners(); this._closeConnection(); return; }
        opened = true;   // a close from here on is a real disconnect
        this._connectedAt = Date.now();
        this._lastTickAt  = Date.now();
        this._lastSpotTickAt = Date.now();
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
      } catch (e) {
        this._log(`🚨 [SOCKET] connect handler failed: ${e.message} — watchdog will retry`);
      }
    });

    skt.on('message', (msg) => {
      if (gen !== this._connGen) return;  // superseded attempt
      if (this._stopped) return;
      this._lastTickAt = Date.now();
      // Ticks flowing on a connection that has outlived the flap window is the
      // strongest possible "the feed is fine again" signal.
      if (this._flapping && this._connectedAt && Date.now() - this._connectedAt > FLAP_UPTIME_MS) {
        this._clearFlap();
      }
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
      if (gen !== this._connGen) return;  // superseded attempt
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
      if (gen !== this._connGen) return;  // superseded attempt — not this connection dying
      // The close provoked by our own teardown, landing on handlers attached
      // after it was requested. Swallow it ONCE — it is an echo of the close we
      // asked for, not this attempt dying. Ignoring every pre-connect close
      // instead would strand a genuinely refused handshake with no reconnect
      // scheduled (the watchdog is market-hours only, so pre-market would sit
      // dead), which is why this is a one-shot and not a blanket `if (!opened)`.
      if (!opened && !teardownEchoSeen) { teardownEchoSeen = true; return; }
      this._log('🔴 [SOCKET] Disconnected unexpectedly');
      this._lastDownAt = Date.now();
      // Only reset retryCount if connection was stable for at least 10 seconds.
      // This prevents infinite 2s loops when the server immediately rejects.
      const uptime = this._connectedAt ? Date.now() - this._connectedAt : 0;
      if (uptime > FLAP_UPTIME_MS) {
        this._retryCount = 0;
        // A connection that lasted counts as recovery: end any flap storm.
        this._clearFlap();
      } else {
        // Connected, then dropped within seconds — a flap, not a recovery.
        this._noteFlap(uptime);
      }
      // NOTE: Do NOT set this._skt = null here — we need it for the reconnect.
      // Don't reconnect if auth has been declared dead — _scheduleReconnect would
      // no-op anyway, but skipping the call keeps the log clean.
      if (!this._stopped && !this._authFailed) this._scheduleReconnect();
    });

    // Treat a failed connect() exactly like the failed getInstance() above: back
    // off and retry, rather than letting it escape to whichever caller ran us
    // (start() from a route, the watchdog, or the retry timer).
    try {
      skt.connect();
    } catch (e) {
      this._log(`❌ [SOCKET] connect() threw: ${e.message}`);
      this._scheduleReconnect();
    }
  }

  /**
   * A connection came up and died inside FLAP_UPTIME_MS. Retries continue
   * regardless — this only decides when to make the failure VISIBLE, which the
   * old code never did: every cycle looked like a normal reconnect, so a feed
   * that never carried a single tick still reported healthy.
   */
  _noteFlap(uptimeMs) {
    this._flapCount += 1;
    if (!this._flapSince) this._flapSince = Date.now();
    if (this._flapCount < FLAP_ALERT_AFTER) return;

    const first = !this._flapping;
    this._flapping = true;

    const due = first || (Date.now() - this._flapAlertedAt) > FLAP_REALERT_MS;
    if (!due) return;
    this._flapAlertedAt = Date.now();

    const mins = Math.round((Date.now() - this._flapSince) / 60000);
    const detail = this._lastErrorMsg ? ` Last error: ${this._lastErrorMsg}` : "";
    this._log(`🚨 [SOCKET] Feed unstable — ${this._flapCount} drops within ${(uptimeMs / 1000).toFixed(1)}s of connecting. Strategies are receiving NO ticks. Still retrying.${detail}`);
    // Telegram is best-effort: a notification failure must never take the
    // trading session down with it.
    try {
      require('./notify').sendIfMaster(
        `🚨 Fyers feed unstable\n\n` +
        `Socket connected and dropped ${this._flapCount}× in a row` +
        (mins ? ` over ~${mins} min` : '') + `.\n` +
        `Strategies are getting NO live ticks.\n` +
        (this._lastErrorMsg ? `Last error: ${this._lastErrorMsg}\n` : '') +
        `\nThe bot keeps retrying — no session was stopped.\n` +
        `If this persists, re-login at /auth/login.`
      );
    } catch (e) {
      this._log(`⚠️  [SOCKET] Flap alert notify failed: ${e.message}`);
    }
  }

  /**
   * A connection proved stable — end the storm and re-arm the alert. `silent`
   * suppresses the announcement for stop(), which clears the same state without
   * anything having actually recovered.
   */
  _clearFlap(silent) {
    if (this._flapping && !silent) {
      this._log('✅ [SOCKET] Feed recovered — ticks flowing again.');
      try {
        require('./notify').sendIfMaster('✅ Fyers feed recovered — live ticks are flowing again.');
      } catch (_) {}
    }
    this._flapCount     = 0;
    this._flapping      = false;
    this._flapSince     = null;
    this._flapAlertedAt = 0;
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    if (this._authFailed) return;  // hard-stop on permanent auth failure
    // Market closed and no strategy attached: there is nothing to reconnect FOR,
    // and Fyers drops the idle socket seconds after accepting it — so the loop
    // manufactures flaps all evening instead of recovering anything. This is the
    // same gate spotFeedSupervisor uses to decide it may release the feed, so a
    // live square-off running past the close (or a manual after-hours session)
    // still retries exactly as before. The supervisor stops a feed left sitting
    // here within seconds; if it is disabled, the watchdog reconnects at 09:15.
    if (!this._isMarketHours() && !sharedSocketState.isAnyActive()) {
      this._clearRetry();
      this._log('💤 [SOCKET] Market closed and no strategy attached — not reconnecting.');
      return;
    }
    this._clearRetry();
    const delay = Math.min(BASE_BACKOFF * Math.pow(2, this._retryCount), MAX_BACKOFF);
    this._retryCount++;
    this._log(`🔁 [SOCKET] Retry in ${(delay / 1000).toFixed(1)}s (attempt ${this._retryCount})`);
    // A throw from _connect() here is an uncaughtException (timer callback, no
    // caller to catch it) and app.js exits the process on those. The watchdog
    // already reconnects on spot silence, so swallowing and logging keeps the
    // session alive; crashing over one failed retry does not.
    this._retryTimer = setTimeout(() => {
      try { if (!this._stopped) this._connect(); }
      catch (e) { this._log(`🚨 [SOCKET] Reconnect attempt threw: ${e.message} — watchdog will retry`); }
    }, delay);
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
        // A reconnect is already scheduled — the backoff owns recovery from here.
        // Barging in with our own _connect() is what let two reconnect loops run
        // against one socket and kept the feed down for a whole session.
        if (this._retryTimer) return;
        // SPOT silence, not "any traffic" silence: option ticks alone must never
        // convince this that the feed the strategies actually run on is alive.
        const silence = this._lastSpotTickAt ? Date.now() - this._lastSpotTickAt : Infinity;
        if (silence > HEARTBEAT_MS) {
          this._log(`⚠️  [SOCKET] Watchdog: no spot tick for ${Math.round(silence / 1000)}s — reconnecting`);
          this._lastTickAt     = Date.now();
          this._lastSpotTickAt = Date.now();
          // No _clearRetry() needed: we only get here with no timer pending,
          // and _connect() clears one anyway.
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
    // 09:15–15:30, matching spotFeedSupervisor's OPEN_MIN/CLOSE_MIN. The close
    // was 15:20, which left the last ten minutes of every session unwatchdogged:
    // a feed dying at 15:21 was neither reconnected nor reported, and those are
    // exactly the ticks the closing candle is built from.
    return total >= 555 && total < 930;
  }
}

module.exports = new SocketManager();
// Exported for unit tests — the attribution rules live and die by this resolver.
module.exports.tickSymbol = tickSymbol;
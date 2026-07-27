/**
 * spotFeedSupervisor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Keeps the shared NIFTY spot feed alive for the WHOLE trading session so the
 * day's ticks are recorded as a MARKET archive — not as a by-product of whichever
 * strategies happened to be running.
 *
 * The hole this closes
 * ────────────────────
 * socketManager.start() was only ever called from a strategy's paper/live /start
 * handler, and the last strategy to stop tears the socket down again. So:
 *   - a day where NO strategy was started recorded NOTHING, and
 *   - stopping the last strategy at 14:00 ended that day's recording at 14:00.
 * Both make the recording strategy-dependent, which breaks the contract that a
 * day recorded today must be replayable by ANY strategy — including one created
 * months later. This supervisor makes the feed a property of the trading day.
 *
 * What it does NOT do
 * ───────────────────
 *   - It never opens its own WebSocket. It asks the socketManager singleton to
 *     start, exactly like a strategy would, so the fan-out invariant holds.
 *   - It registers no tick callback: tickRecorder.recordSpotTick() already runs
 *     inside socketManager's message handler, ahead of any strategy fan-out.
 *   - It never touches strategy state, and never stops a socket a strategy is
 *     still using (`sharedSocketState.isAnyActive()` is the gate).
 *
 * Lifecycle (IST):
 *   09:15 → 15:30   ensure the feed is up (re-starting it within seconds if a
 *                   strategy's /stop tore it down mid-session)
 *   outside window  release the connection, but only when no strategy is active
 *                   (a live square-off can legitimately run past 15:30)
 *
 * Safety gates — the supervisor stays out of the way when:
 *   - SPOT_FEED_ALWAYS_ON=false          (own kill switch)
 *   - a replay is in progress            (replay monkey-patches socketManager)
 *   - no Fyers ACCESS_TOKEN is present   (don't provoke an auth-fail alert)
 *   - socketManager.isAuthFailed()       (token already declared dead)
 *   - weekend / NSE holiday              (nseHolidays, cached per IST date)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const socketManager     = require("./socketManager");
const sharedSocketState = require("./sharedSocketState");
const nseHolidays       = require("./nseHolidays");

const SPOT_SYMBOL = "NSE:NIFTY50-INDEX";

// 10s: short enough that a strategy /stop mid-session costs at most a few
// seconds of ticks, cheap enough to be invisible (a few boolean checks plus a
// per-day-cached holiday lookup).
const CHECK_MS = 10_000;

// IST minutes-from-midnight. Open matches socketManager._isMarketHours (09:15);
// close is 15:30 so the closing candle is fully captured.
const OPEN_MIN  = 555;   // 09:15
const CLOSE_MIN = 930;   // 15:30

let _timer      = null;
let _running    = false;
let _skipReason = null;   // last logged skip reason — logged once, not every tick
let _tradingDay = { day: null, allowed: null };   // per-IST-date holiday cache

function _enabled() {
  return (process.env.SPOT_FEED_ALWAYS_ON || "true").toLowerCase() !== "false";
}

function _istMinutes() {
  // Fast IST: UTC+5:30 = +19800 seconds (matches socketManager/tickRecorder)
  const istSec = Math.floor(Date.now() / 1000) + 19800;
  return Math.floor(istSec / 60) % 1440;
}

function _istDay() {
  const istSec = Math.floor(Date.now() / 1000) + 19800;
  return Math.floor(istSec / 86400);
}

function _inSession() {
  const m = _istMinutes();
  return m >= OPEN_MIN && m < CLOSE_MIN;
}

/** Weekend / NSE-holiday check, cached per IST date (the answer can't change). */
async function _isTradingDay() {
  const day = _istDay();
  if (_tradingDay.day === day && _tradingDay.allowed !== null) return _tradingDay.allowed;
  let allowed = true;
  try {
    // isTradingAllowed() also checks its own 07:00–16:00 window — a superset of
    // ours, so it never rejects a moment we'd otherwise act on.
    const r = await nseHolidays.isTradingAllowed();
    allowed = !!(r && r.allowed);
  } catch (_) {
    // Holiday list unreachable → assume trading. Recording an extra quiet day is
    // harmless; skipping a real one loses market data permanently.
    allowed = true;
  }
  _tradingDay = { day, allowed };
  return allowed;
}

/** Log a skip reason once per distinct reason so /logs isn't flooded every 10s. */
function _skipOnce(reason) {
  if (_skipReason === reason) return;
  _skipReason = reason;
  console.log(`📡 [feed] recorder feed idle — ${reason}`);
}

async function _check() {
  if (!_enabled()) return;

  // A replay patches socketManager.start/addCallback to feed recorded ticks into
  // a strategy. Starting the real feed inside that window would register a
  // phantom callback into the harness and pollute the run.
  // (Lazy require avoids a load-time dependency cycle; the result is cached.)
  try { if (require("../services/tickReplay").isReplayInProgress()) return; } catch (_) {}

  if (!_inSession()) {
    // Session over. Release the connection so it isn't held open overnight —
    // but never while a strategy is still using it (live square-off, a manual
    // after-hours paper session, etc.).
    if (socketManager.isRunning() && !sharedSocketState.isAnyActive()) {
      socketManager.stop();
      _skipReason = null;   // allow the next session's messages through
      console.log("📡 [feed] market closed — shared spot feed released");
    }
    return;
  }

  if (socketManager.isRunning()) { _skipReason = null; return; }

  if (socketManager.isAuthFailed()) { _skipOnce("Fyers auth failed — re-login at /auth/login"); return; }
  if (!process.env.ACCESS_TOKEN)    { _skipOnce("no Fyers token — log in to start recording"); return; }
  if (!(await _isTradingDay()))     { _skipOnce("not a trading day"); return; }

  // Re-check after the await: a strategy may have started the socket, or a
  // replay may have begun, while the holiday lookup was in flight.
  if (socketManager.isRunning()) return;
  try { if (require("../services/tickReplay").isReplayInProgress()) return; } catch (_) {}

  // No tick callback and no log sink: recordSpotTick() already runs inside
  // socketManager's message handler, and _log falls back to console.log (which
  // logger.js pipes to /logs).
  socketManager.start(SPOT_SYMBOL, null, null);
  _skipReason = null;
  console.log(`📡 [feed] market open — shared spot feed started for recording (${SPOT_SYMBOL})`);
}

// Self-scheduling loop (setTimeout, not setInterval) so a slow holiday lookup
// can never overlap the next check.
function _schedule() {
  if (!_running) return;
  _timer = setTimeout(async () => {
    try { await _check(); } catch (err) {
      console.warn(`[spotFeedSupervisor] check failed: ${err.message}`);
    }
    _schedule();
  }, CHECK_MS);
  if (_timer && typeof _timer.unref === "function") _timer.unref();
}

/**
 * Start the supervisor loop. Idempotent. The loop always runs cheaply; every
 * real action is gated inside _check(), so the Settings toggle applies live
 * without a restart.
 */
function start() {
  if (_running) return;
  _running = true;
  if (_enabled()) {
    console.log("[spotFeedSupervisor] armed — shared spot feed kept alive 09:15–15:30 IST for day-based recording");
  } else {
    console.log("[spotFeedSupervisor] loop armed but disabled (SPOT_FEED_ALWAYS_ON=false) — recording only while a strategy runs");
  }
  // Run one check immediately so a mid-session restart resumes recording now
  // rather than after the first interval.
  _check().catch(() => {});
  _schedule();
}

function stop() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

function getStats() {
  return {
    running:      _running,
    enabled:      _enabled(),
    inSession:    _inSession(),
    feedRunning:  socketManager.isRunning(),
    strategyActive: (() => { try { return sharedSocketState.isAnyActive(); } catch (_) { return null; } })(),
    lastSkip:     _skipReason,
  };
}

module.exports = { start, stop, getStats };

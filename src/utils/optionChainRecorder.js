/**
 * optionChainRecorder.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Day-wide, STRATEGY-INDEPENDENT recorder for the option chain, futures OI and
 * VIX — so a Replay in SNAPSHOT mode is reproducible for ANY strategy (present
 * or future), not just the strike a live strategy happened to trade that day.
 *
 * Why this exists
 * ───────────────
 * The per-strategy recorder (tickRecorder via each engine's fetchOptionLtp /
 * spread-guard / VIX / OI polls) only captures:
 *   - the single option symbol a RUNNING strategy was polling (its position /
 *     entry candidate), and
 *   - VIX/OI only while that strategy had a VIX/OI filter enabled.
 *
 * So if a Replay decision diverges even one candle → it wants a DIFFERENT strike
 * → no recorded LTP for it → it fell back to a spot proxy → replay P&L drifted
 * from live even with identical snapshot settings. A brand-new strategy had NO
 * option data at all for old days.
 *
 * This module fixes that at the source: every few seconds during market hours it
 * proactively polls the ATM±N CE/PE chain + INDIA VIX + current-month NIFTY
 * futures OI and writes them to the SAME per-day streams the replay already
 * reads (options.jsonl / vix.jsonl / oi.jsonl via tickRecorder). No replay-reader
 * change is needed — this is purely additive density + coverage.
 *
 * Design invariants
 * ─────────────────
 *   - PURE OBSERVER. Never places an order, never mutates strategy state. It only
 *     calls fyers.getQuotes (read) and tickRecorder.record* (append).
 *   - Never opens a second socket. It rides the existing socketManager fan-out
 *     (addCallback) purely to learn the latest spot for the ATM calc.
 *   - Self-throttling: one in-flight poll at a time (_busy), configurable cadence,
 *     Fyers per-call symbol cap respected, failure logging throttled so a dead
 *     token can't flood /logs.
 *   - Reuses tickRecorder's writers, so the master TICK_RECORDER_ENABLED switch
 *     and retention/prune all apply unchanged.
 *
 * Env
 * ───
 *   OPTION_CHAIN_RECORDER_ENABLED     default "true"  — own on/off (read live)
 *   OPTION_CHAIN_RECORD_INTERVAL_SEC  default 5   (clamped 2–60)
 *   OPTION_CHAIN_RECORD_STRIKES       default 5   (clamped 1–15) → ATM±N per side
 * Also gated by the master TICK_RECORDER_ENABLED (writers no-op when off).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fyers         = require("../config/fyers");
const instrument    = require("../config/instrument");
const tickRecorder  = require("./tickRecorder");
const socketManager = require("./socketManager");

const CALLBACK_ID   = "option-chain-recorder";
const VIX_SYMBOL    = "NSE:INDIAVIX-INDEX";
const STRIKE_STEP   = 50;
// Fyers getQuotes accepts up to 50 symbols per call — batch to stay under it.
const MAX_SYMBOLS_PER_CALL = 50;

let _timer      = null;
let _running    = false;   // scheduler loop is live (started once at boot)
let _busy       = false;   // a poll is in flight — skip overlaps
let _lastSpot   = null;    // latest spot LTP from the socket fan-out
let _expiry     = { day: null, code: null };  // per-IST-day cached expiry code
let _failStreak = 0;

// ── Config (read LIVE from env so the Settings toggle applies without restart) ─
function _ownEnabled() {
  return (process.env.OPTION_CHAIN_RECORDER_ENABLED || "true").toLowerCase() !== "false";
}
function _masterEnabled() {
  // Reflects tickRecorder's actual (load-frozen) ENABLED — its writers no-op when
  // off, so polling would be wasted work. getStats().enabled exposes that flag.
  try { return tickRecorder.getStats().enabled !== false; } catch (_) { return true; }
}
function _enabled() { return _ownEnabled() && _masterEnabled(); }

function _intervalMs() {
  let s = parseInt(process.env.OPTION_CHAIN_RECORD_INTERVAL_SEC || "5", 10);
  if (!Number.isFinite(s) || s < 2) s = 2;
  if (s > 60) s = 60;
  return s * 1000;
}
function _strikeSpan() {
  let n = parseInt(process.env.OPTION_CHAIN_RECORD_STRIKES || "5", 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 15) n = 15;
  return n;
}

// ── Market hours: 09:15–15:20 IST, matches socketManager._isMarketHours ───────
function _isMarketHours() {
  const istSec = Math.floor(Date.now() / 1000) + 19800;   // UTC+5:30
  const total  = Math.floor(istSec / 60) % 1440;
  return total >= 555 && total < 920;
}

function _istDay() {
  try { return tickRecorder._internals.istDateString(Date.now()); } catch (_) { return null; }
}

/**
 * Resolve the active expiry code ONCE per IST day and cache it. We pin the SAME
 * expiry the replay pins (Market Context Snapshot's weekly/monthly code), so the
 * strikes we record line up exactly with what replay resolves. getMarketContext
 * is async + logs once/day — cheap at this cadence.
 */
async function _resolveExpiryCode() {
  const day = _istDay();
  if (day && _expiry.day === day && _expiry.code) return _expiry.code;
  let code = null;
  try {
    const ctx  = await instrument.getMarketContext();
    const type = (process.env.OPTION_EXPIRY_TYPE || "weekly").trim().toLowerCase();
    code = type === "monthly" ? ctx.monthlyExpiryCode : ctx.weeklyExpiryCode;
  } catch (_) { /* fall through */ }
  if (!code) { try { code = instrument.getNearestThursdayExpiry(); } catch (_) {} }
  if (code && day) _expiry = { day, code };
  return code;
}

// Cheap spot observer — no allocation, no fs. Just the latest LTP for ATM calc.
function _onSpotTick(t) {
  if (t && typeof t.ltp === "number" && t.ltp > 0) _lastSpot = t.ltp;
}

async function _poll() {
  if (!_enabled() || !_isMarketHours() || _lastSpot == null) return;
  if (_busy) return;
  // A replay run monkey-patches the shared fyers.getQuotes singleton to serve
  // recorded data at the replay clock. If we polled during that window we'd write
  // replay-clock prices into TODAY's real recording. Pause until it finishes.
  // (Lazy require avoids a load-time dep cycle; result is module-cached.)
  try { if (require("../services/tickReplay").isReplayInProgress()) return; } catch (_) {}
  _busy = true;
  try {
    const expiryCode = await _resolveExpiryCode();
    if (!expiryCode) return;

    const atm = instrument.calcATMStrike(_lastSpot);   // pure ATM (no side offset)
    const n   = _strikeSpan();
    const symbols = [];
    for (let k = -n; k <= n; k++) {
      const strike = atm + k * STRIKE_STEP;
      if (strike <= 0) continue;
      symbols.push(`NSE:NIFTY${expiryCode}${strike}CE`);
      symbols.push(`NSE:NIFTY${expiryCode}${strike}PE`);
    }
    symbols.push(VIX_SYMBOL);
    let futSym = null;
    try { futSym = `NSE:NIFTY${instrument.getFuturesExpiry()}FUT`; symbols.push(futSym); } catch (_) {}

    for (let i = 0; i < symbols.length; i += MAX_SYMBOLS_PER_CALL) {
      const batch = symbols.slice(i, i + MAX_SYMBOLS_PER_CALL);
      const resp  = await fyers.getQuotes(batch);
      if (!resp || resp.s !== "ok" || !Array.isArray(resp.d)) continue;
      for (const row of resp.d) {
        const sym = row.n || row.symbol;
        const v   = row.v || row;
        if (!sym || !v) continue;
        if (sym === VIX_SYMBOL) {
          const lp = Number(v.lp || v.ltp || 0);
          if (lp > 0) tickRecorder.recordVix(lp);
        } else if (futSym && sym === futSym) {
          const oi = Number(v.oi ?? v.open_interest ?? v.openInterest ?? 0);
          if (oi > 0) tickRecorder.recordOi(sym, oi);
        } else {
          const lp  = Number(v.lp || v.ltp || v.last_price || 0);
          const bid = Number(v.bid || v.bid_price || 0);
          const ask = Number(v.ask || v.ask_price || 0);
          if (lp > 0) tickRecorder.recordOptionQuote(sym, lp, bid, ask, "chain");
        }
      }
    }
    _failStreak = 0;
  } catch (err) {
    _failStreak += 1;
    // Throttle: log the first failure, then at most once/minute-ish (assuming ~5s
    // cadence, every 12th ≈ 60s) so an expired token can't flood /logs.
    if (_failStreak === 1 || _failStreak % 12 === 0) {
      console.warn(`[optionChainRecorder] poll failed (${_failStreak}×): ${err.message}`);
    }
  } finally {
    _busy = false;
  }
}

// Self-scheduling loop (setTimeout, not setInterval) so a slow poll can never
// overlap the next, and the cadence re-reads env each cycle.
function _schedule() {
  if (!_running) return;
  _timer = setTimeout(async () => {
    try { await _poll(); } catch (_) {}
    _schedule();
  }, _intervalMs());
  if (_timer && typeof _timer.unref === "function") _timer.unref();
}

/**
 * Start the recorder loop. Idempotent. The loop always runs cheaply; all real
 * work is gated in _poll() by _enabled()+market-hours, so the Settings toggle
 * applies live without a restart.
 */
function start() {
  if (_running) return;
  _running = true;
  try { socketManager.addCallback(CALLBACK_ID, _onSpotTick, null); } catch (_) {}
  if (_enabled()) {
    console.log(`[optionChainRecorder] armed — ATM±${_strikeSpan()} chain + VIX + fut OI every ${_intervalMs() / 1000}s (market hours only)`);
  } else {
    console.log("[optionChainRecorder] loop armed but disabled (OPTION_CHAIN_RECORDER_ENABLED=false or tick recorder off) — will no-op until re-enabled");
  }
  _schedule();
}

function stop() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  try { socketManager.removeCallback(CALLBACK_ID); } catch (_) {}
}

function getStats() {
  return {
    running:     _running,
    enabled:     _enabled(),
    ownEnabled:  _ownEnabled(),
    lastSpot:    _lastSpot,
    expiryCode:  _expiry.code,
    intervalSec: _intervalMs() / 1000,
    strikeSpan:  _strikeSpan(),
    failStreak:  _failStreak,
  };
}

module.exports = { start, stop, getStats };

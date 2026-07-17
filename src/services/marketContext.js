/**
 * marketContext.js — Universal, strategy-independent Market Context capture.
 * ─────────────────────────────────────────────────────────────────────────────
 * The market happens ONCE per day, so its context is captured once — independent
 * of which strategies (if any) are running. Triggered from the shared spot-tick
 * fan-out (socketManager), the FIRST live tick of an IST day resolves and freezes
 * an immutable Market Context Snapshot to data/ticks/YYYY-MM-DD/market.jsonl:
 * weekly/monthly expiry, strike interval, lot size, instrument meta, versions.
 *
 * Why here (not per strategy):
 *   - A day recorded today must be replayable six months later by a strategy that
 *     doesn't exist yet — using the SAME ticks and the SAME historical expiry.
 *   - Replay reads this snapshot as the source of truth for market facts, so an
 *     old day resolves its own option contract instead of today's expiry (the
 *     root cause of paper-vs-replay mismatch).
 *
 * Cheap + safe on the hot path:
 *   - `maybeCapture()` is a couple of in-memory boolean checks on every call;
 *     the expensive resolve (live Option-Chain REST) runs at most once per day,
 *     fire-and-forget, guarded by an in-flight flag and an on-disk existence check.
 *   - No-ops entirely when TICK_RECORDER_ENABLED=false.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require("fs");
const path = require("path");
const tickRecorder = require("../utils/tickRecorder");

const ENABLED = (process.env.TICK_RECORDER_ENABLED || "true").toLowerCase() !== "false";
const { ROOT_DIR, istDateString } = tickRecorder._internals;

let _capturedDay = null;   // IST day already captured this process (in-memory fast path)
let _inFlight    = false;  // a resolve is currently running — don't start a second

function _marketFile(day) {
  return path.join(ROOT_DIR, day, "market.jsonl");
}

/**
 * Capture the Market Context Snapshot for today if not already present.
 * Idempotent and non-blocking — safe to call on every spot tick.
 */
async function maybeCapture() {
  if (!ENABLED) return;
  const day = istDateString(Date.now());
  if (_capturedDay === day || _inFlight) return;

  // On-disk guard: survives process restarts within the same day (e.g. PM2 reload).
  try {
    if (fs.existsSync(_marketFile(day))) { _capturedDay = day; return; }
  } catch (_) { /* fall through to resolve */ }

  _inFlight = true;
  try {
    // Lazy-require to avoid any require-cycle at socketManager init time.
    const instrument = require("../config/instrument");
    const ctx = await instrument.getMarketContext();
    ctx.date = day;
    const wrote = tickRecorder.recordMarketContext(ctx);
    _capturedDay = day;   // mark captured even if another process won the write
    if (wrote) {
      console.log(`📋 [marketContext] captured ${day}: weekly=${ctx.weeklyExpiry} monthly=${ctx.monthlyExpiry} lot=${ctx.lotSize} strikeStep=${ctx.strikeInterval}`);
    }
  } catch (e) {
    console.warn(`[marketContext] capture failed for ${day}: ${e.message}`);
    // leave _capturedDay unset so a later tick retries (token may have been unready)
  } finally {
    _inFlight = false;
  }
}

module.exports = { maybeCapture };

/**
 * marketContext.js — Universal, strategy-independent Market Context capture.
 * ─────────────────────────────────────────────────────────────────────────────
 * The market happens ONCE per day, so its context is captured once — independent
 * of which strategies (if any) are running. Triggered from the shared spot-tick
 * fan-out (socketManager), the FIRST live tick of an IST day resolves and freezes
 * an immutable Market Context Snapshot to data/ticks/YYYY-MM-DD/market.jsonl:
 * weekly/monthly expiry, strike interval, lot size, instrument meta, versions.
 *
 * MULTI-INDEX: the top-level fields stay exactly as they were — NIFTY 50 facts,
 * so every recording made before NIFTY BANK existed and every reader written
 * against them keeps working unchanged. Each index the app knows about is ALSO
 * written under `underlyings.{KEY}`, which is where a BANKNIFTY strategy's
 * replay reads its own strike interval, lot size and (monthly-only) expiry. One
 * record per day either way: replay takes the LAST line of market.jsonl, so a
 * second record would shadow the first rather than extend it.
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
    // NIFTY 50 stays the top-level snapshot — the shape every existing reader
    // (and every recording already on disk) expects.
    const ctx = await instrument.getMarketContext("NIFTY");
    ctx.date = day;

    // Every index, keyed by underlying, for strategies that trade another one.
    // Resolved one at a time rather than in parallel: each hits the same Fyers
    // option-chain endpoint, and this runs once a day — there is nothing to win
    // by racing them, and a rate-limit here would cost the whole snapshot.
    ctx.underlyings = {};
    for (const u of instrument.listUnderlyings()) {
      try {
        const one = u.key === "NIFTY" ? ctx : await instrument.getMarketContext(u.key);
        ctx.underlyings[u.key] = {
          index:             one.index,
          underlying:        one.underlying,
          strikeInterval:    one.strikeInterval,
          lotSize:           one.lotSize,
          weeklyExpiriesExist: one.weeklyExpiriesExist,
          weeklyExpiry:      one.weeklyExpiry,
          weeklyExpiryCode:  one.weeklyExpiryCode,
          monthlyExpiry:     one.monthlyExpiry,
          monthlyExpiryCode: one.monthlyExpiryCode,
          futuresExpiry:     one.futuresExpiry,
        };
      } catch (e) {
        // One index failing must not cost the whole day's snapshot — the others
        // are still worth freezing, and the gap is recorded rather than hidden.
        ctx.underlyings[u.key] = { underlying: u.key, error: String((e && e.message) || e) };
        console.warn(`[marketContext] ${u.key} context failed for ${day}: ${(e && e.message) || e}`);
      }
    }

    const wrote = tickRecorder.recordMarketContext(ctx);
    _capturedDay = day;   // mark captured even if another process won the write
    if (wrote) {
      const perIndex = Object.values(ctx.underlyings)
        .map((u) => u.error
          ? `${u.underlying}=FAILED(${u.error})`
          : `${u.underlying}: ${u.weeklyExpiriesExist ? `weekly=${u.weeklyExpiry}` : "monthly-only"} monthly=${u.monthlyExpiry} lot=${u.lotSize} strikeStep=${u.strikeInterval}`)
        .join(" | ");
      console.log(`📋 [marketContext] captured ${day} — ${perIndex}`);
    }
  } catch (e) {
    console.warn(`[marketContext] capture failed for ${day}: ${e.message}`);
    // leave _capturedDay unset so a later tick retries (token may have been unready)
  } finally {
    _inFlight = false;
  }
}

module.exports = { maybeCapture };

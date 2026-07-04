/**
 * tickRecorder.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures the exact data stream the live/paper engine sees during market
 * hours, so the same ticks can be replayed after-hours through the same
 * onTick() handlers — making BACKTEST = PAPER = LIVE by construction.
 *
 * Streams recorded:
 *   spot    — every NIFTY50-INDEX spot tick (from socketManager fan-out)
 *   options — every option LTP REST poll (per-strategy) + entry-time bid/ask
 *   vix     — every VIX REST fetch (live cache fills only, not cache hits)
 *   oi      — every NIFTY-futures OI sample (only while an OI filter is on)
 *   sessions — start/stop events with full settings + warm-up snapshot
 *
 * Files (per-day rotation, IST date):
 *   data/ticks/YYYY-MM-DD/spot.jsonl
 *   data/ticks/YYYY-MM-DD/options.jsonl
 *   data/ticks/YYYY-MM-DD/vix.jsonl
 *   data/ticks/YYYY-MM-DD/oi.jsonl
 *   data/ticks/YYYY-MM-DD/sessions.jsonl
 *
 * Performance:
 *   - All writes are buffered in memory and flushed every FLUSH_INTERVAL_MS
 *   - Hot path (recordSpotTick) does only one Array.push — no fs, no JSON
 *     stringify, no allocation beyond the wrapper object
 *   - Flush-on-exit handlers (SIGINT/SIGTERM/beforeExit) drain buffers
 *   - Append-only — never truncates or rewrites
 *
 * Disable:
 *   Set TICK_RECORDER_ENABLED=false in env to no-op all entry points. Default ON.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require("fs");
const path = require("path");

const ROOT_DIR          = path.resolve(__dirname, "..", "..", "data", "ticks");
const FLUSH_INTERVAL_MS = 1000;
// Defensive cap — if the flush timer stalls (event-loop hang), we don't want
// any single buffer to grow without bound and exhaust 1 GB of RAM on t3.micro.
// At peak NIFTY tick rate (~10/s) this gives ~50 minutes of head-room before
// we start dropping; in practice the timer keeps buffers <50.
const MAX_BUFFER_RECORDS = 30000;

const ENABLED         = (process.env.TICK_RECORDER_ENABLED || "true").toLowerCase() !== "false";
const RETAIN_DAYS     = parseInt(process.env.TICK_RECORDER_RETAIN_DAYS || "30", 10);

// ── Per-stream in-memory buffers ─────────────────────────────────────────────
// Each entry is the raw JS object — JSON.stringify happens at flush time so the
// hot tick callback is allocation-cheap.
const buffers = {
  spot:     [],
  options:  [],
  vix:      [],
  oi:       [],
  sessions: [],
};

let _flushTimer = null;
let _exitHandlersInstalled = false;
let _initialized = false;

// ── IST date helper (matches socketManager._isMarketHours) ───────────────────
function istDateString(unixMs) {
  // Fast IST: UTC+5:30 = +19800 seconds
  const istSec = Math.floor((unixMs || Date.now()) / 1000) + 19800;
  const d = new Date(istSec * 1000);
  // d is now UTC representation of IST wall clock — extract YYYY-MM-DD
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function dayDir(unixMs) {
  return path.join(ROOT_DIR, istDateString(unixMs));
}

function ensureDayDir(unixMs) {
  const dir = dayDir(unixMs);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  return dir;
}

// ── Lazy init: schedule flush + install exit handlers on first record call ──
function _init() {
  if (_initialized) return;
  _initialized = true;
  if (!_flushTimer) {
    _flushTimer = setInterval(() => { try { flushAll(); } catch (_) {} }, FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for the flush timer.
    if (typeof _flushTimer.unref === "function") _flushTimer.unref();
  }
  if (!_exitHandlersInstalled) {
    _exitHandlersInstalled = true;
    const drain = () => { try { flushAllSync(); } catch (_) {} };
    process.on("beforeExit", drain);
    // Flush-only on signals — do NOT call process.exit() here. app.js's
    // gracefulShutdown also listens for SIGINT/SIGTERM and needs its square-off
    // window (it schedules the real process.exit after exits settle). Exiting
    // synchronously here would pre-empt that timer and abandon an in-flight
    // live square-off, leaving an orphaned broker position on every PM2 reload.
    process.on("SIGINT",     () => { drain(); });
    process.on("SIGTERM",    () => { drain(); });
    process.on("uncaughtException", (err) => {
      try { drain(); } catch (_) {}
      // re-throw so the process still crashes on real bugs
      throw err;
    });
  }
}

// ── Flush ────────────────────────────────────────────────────────────────────
// Group buffered records by IST date so a session crossing midnight (rare)
// still lands in the correct day file.
function _drainBufferTo(stream, buf) {
  if (buf.length === 0) return;
  const byDay = new Map();
  for (let i = 0; i < buf.length; i++) {
    const rec = buf[i];
    const day = istDateString(rec.t);
    let arr = byDay.get(day);
    if (!arr) { arr = []; byDay.set(day, arr); }
    arr.push(rec);
  }
  for (const [day, recs] of byDay) {
    const dir  = dayDir(recs[0].t);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { if (e.code !== "EEXIST") continue; }
    const file = path.join(dir, `${stream}.jsonl`);
    const text = recs.map(r => JSON.stringify(r)).join("\n") + "\n";
    fs.appendFile(file, text, (err) => {
      if (err) console.warn(`[tickRecorder] append failed (${stream}): ${err.message}`);
    });
  }
  buf.length = 0;
}

function _drainBufferToSync(stream, buf) {
  if (buf.length === 0) return;
  const byDay = new Map();
  for (const rec of buf) {
    const day = istDateString(rec.t);
    let arr = byDay.get(day);
    if (!arr) { arr = []; byDay.set(day, arr); }
    arr.push(rec);
  }
  for (const [day, recs] of byDay) {
    const dir  = dayDir(recs[0].t);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { if (e.code !== "EEXIST") continue; }
    const file = path.join(dir, `${stream}.jsonl`);
    const text = recs.map(r => JSON.stringify(r)).join("\n") + "\n";
    try { fs.appendFileSync(file, text); }
    catch (err) { console.warn(`[tickRecorder] sync append failed (${stream}): ${err.message}`); }
  }
  buf.length = 0;
}

function flushAll() {
  _drainBufferTo("spot",     buffers.spot);
  _drainBufferTo("options",  buffers.options);
  _drainBufferTo("vix",      buffers.vix);
  _drainBufferTo("oi",       buffers.oi);
  _drainBufferTo("sessions", buffers.sessions);
}

function flushAllSync() {
  _drainBufferToSync("spot",     buffers.spot);
  _drainBufferToSync("options",  buffers.options);
  _drainBufferToSync("vix",      buffers.vix);
  _drainBufferToSync("oi",       buffers.oi);
  _drainBufferToSync("sessions", buffers.sessions);
}

// ── Public recording API ─────────────────────────────────────────────────────

/**
 * Record one spot tick from the Fyers websocket fan-out.
 * `tick` is the raw object the SDK delivers — captured verbatim so replay
 * gives the strategy the exact same shape it saw live.
 * Adds `t` (unix ms wall clock at receipt) for replay ordering.
 */
function recordSpotTick(tick) {
  if (!ENABLED || !tick) return;
  if (!_initialized) _init();
  // Defensive: drop ticks if buffer hasn't been drained (timer stall guard).
  // Should never trigger in normal operation — buffer is flushed every 1s.
  if (buffers.spot.length >= MAX_BUFFER_RECORDS) return;
  // Store the whole raw tick + a wall-clock receipt timestamp.
  // Fyers ticks include their own `tt` (exchange timestamp) — we keep both.
  buffers.spot.push({ t: Date.now(), ...tick });
}

/**
 * Record one option LTP REST poll result.
 *   symbol — full Fyers option symbol e.g. "NSE:NIFTY2451524500CE"
 *   ltp    — number from the REST quote
 *   src    — string mode tag for debugging ("pa-paper", "scalp-live", etc.)
 */
function recordOptionLtp(symbol, ltp, src) {
  if (!ENABLED || ltp == null || !symbol) return;
  if (!_initialized) _init();
  if (buffers.options.length >= MAX_BUFFER_RECORDS) return;
  buffers.options.push({ t: Date.now(), s: symbol, l: ltp, src: src || null });
}

/**
 * Record an option quote that carries bid/ask (from the entry-time spread-guard
 * poll). Same `options` stream as recordOptionLtp, plus `b`/`a` fields so replay
 * can reproduce the bid-ask spread gate. Missing bid/ask are omitted (replay
 * then fails the spread guard open, matching pre-capture behaviour).
 */
function recordOptionQuote(symbol, ltp, bid, ask, src) {
  if (!ENABLED || ltp == null || !symbol) return;
  if (!_initialized) _init();
  if (buffers.options.length >= MAX_BUFFER_RECORDS) return;
  const rec = { t: Date.now(), s: symbol, l: ltp, src: src || null };
  if (bid != null && bid > 0) rec.b = bid;
  if (ask != null && ask > 0) rec.a = ask;
  buffers.options.push(rec);
}

/**
 * Record one successful VIX REST fetch (cache fills only — cache hits should
 * NOT be recorded, otherwise replay would inflate the rate).
 */
function recordVix(value) {
  if (!ENABLED || typeof value !== "number" || !(value > 0)) return;
  if (!_initialized) _init();
  if (buffers.vix.length >= MAX_BUFFER_RECORDS) return;  // timer-stall guard (matches spot/options)
  buffers.vix.push({ t: Date.now(), v: value });
}

/**
 * Record one NIFTY-futures OI sample (cache fills only, like VIX). Captured so
 * the replay can reproduce the OI buildup gate exactly instead of failing it open.
 *   symbol — futures symbol e.g. "NSE:NIFTY25JUNFUT"
 *   oi     — open-interest number from the REST quote
 */
function recordOi(symbol, oi) {
  if (!ENABLED || oi == null || !(oi > 0) || !symbol) return;
  if (!_initialized) _init();
  if (buffers.oi.length >= MAX_BUFFER_RECORDS) return;
  buffers.oi.push({ t: Date.now(), s: symbol, oi });
}

/**
 * Record a session-start event with everything needed to seed a replay:
 *   - mode: "pa-paper" | "pa-live" | "scalp-paper" | etc.
 *   - sessionId: caller-provided unique id (used to pair start ↔ stop events)
 *   - settings: env snapshot of all strategy-relevant keys
 *   - warmup: array of historical candles loaded to seed indicators
 *   - vix: VIX value at session start (or null)
 *   - meta: any extra fields (expiry override, instrument, etc.)
 */
function recordSessionStart({ mode, sessionId, settings, warmup, vix, meta }) {
  if (!ENABLED || !mode) return;
  if (!_initialized) _init();
  buffers.sessions.push({
    t: Date.now(),
    e: "start",
    mode,
    sid: sessionId || null,
    settings: settings || null,
    warmup:   warmup   || null,
    vix:      vix      != null ? vix : null,
    meta:     meta     || null,
  });
  // Sessions are infrequent and important — sync flush so a quick
  // start→stop sequence can't race two async appends and lose one.
  try { _drainBufferToSync("sessions", buffers.sessions); } catch (_) {}
}

/**
 * Record a session-stop event paired by sessionId.
 *   - reason: "user_stop" | "eod" | "crash" | etc.
 */
function recordSessionStop({ mode, sessionId, reason }) {
  if (!ENABLED || !mode) return;
  if (!_initialized) _init();
  buffers.sessions.push({
    t: Date.now(),
    e: "stop",
    mode,
    sid: sessionId || null,
    reason: reason || null,
  });
  try { _drainBufferToSync("sessions", buffers.sessions); } catch (_) {}
}

// ── Settings snapshot helper ─────────────────────────────────────────────────
// Whitelist of env-key prefixes/exact-names that influence strategy behaviour.
// Anything matching is captured at session-start so the replay can be run with
// the EXACT config the live session ran with, regardless of subsequent edits.
// Tokens / secrets are excluded by construction.
const _SETTINGS_KEY_MATCHERS = [
  /^PA_/, /^SCALP_/, /^SWING_/, /^ORB_/, /^VIX_/, /^BACKTEST_/, /^TRADE_/,
  /^MAX_/, /^MIN_/, /^EMA_/, /^SAR_/, /^RSI_/, /^ADX_/,
  /^INSTRUMENT/, /^OPTION_/, /^BREAKEVEN/, /^FAIL_MODE/,
  /^MODE_/, /^EXPIRY/, /^STRIKE/, /^QTY/, /^LOT/, /^SIGNAL/,
  // Added so snapshot-mode replay pins these too (they influence paper decisions
  // but weren't captured, so replays silently used TODAY's env for them):
  //   EMA9VWAP_* — the whole EMA9+VWAP strategy (NOT matched by /^EMA_/, key is "EMA9…")
  //   OI_*       — the OI-filter master switch (per-mode {PA,SWING,…}_OI_ENABLED were caught)
  //   OPT_*      — swing's OPT_STOP_PCT (/^OPTION_/ does not match "OPT_")
  //   TIME_STOP_*— shared tradeGuards time-stop
  //   NIFTY*     — NIFTY_LOT_SIZE (/^LOT/ does not match "NIFTY_LOT_SIZE")
  //   LTP_STALE* — stale-LTP fallback window
  /^EMA9VWAP_/, /^OI_/, /^OPT_/, /^TIME_STOP_/, /^NIFTY/, /^LTP_STALE/,
];

function snapshotSettings() {
  const out = {};
  for (const k of Object.keys(process.env)) {
    if (_SETTINGS_KEY_MATCHERS.some(re => re.test(k))) {
      out[k] = process.env[k];
    }
  }
  return out;
}

// ── Disk cleanup (call from app startup or cron) ─────────────────────────────
/**
 * Delete tick recordings older than retainDays. Defaults to TICK_RECORDER_RETAIN_DAYS
 * (env, default 30 days). Returns { kept, deleted } counts.
 *
 * Tick storage is small (~5–10 MB/day across all streams), so 30 days = ~300 MB.
 * Increase if you want longer replay history; decrease for tight EBS quotas.
 */
function pruneOldRecordings(retainDays) {
  const days = Number.isFinite(retainDays) ? retainDays : RETAIN_DAYS;
  if (!fs.existsSync(ROOT_DIR)) return { kept: 0, deleted: 0 };

  const cutoffMs = Date.now() - days * 86400_000;
  const cutoffDate = istDateString(cutoffMs);
  let kept = 0, deleted = 0;

  for (const entry of fs.readdirSync(ROOT_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
    if (entry < cutoffDate) {
      try {
        fs.rmSync(path.join(ROOT_DIR, entry), { recursive: true, force: true });
        deleted += 1;
      } catch (err) {
        console.warn(`[tickRecorder] prune failed for ${entry}: ${err.message}`);
      }
    } else {
      kept += 1;
    }
  }
  return { kept, deleted, retainDays: days, cutoffDate };
}

/**
 * Delete tick recordings whose IST date-folder falls within [from, to] (inclusive).
 * Both bounds are optional "YYYY-MM-DD" strings — omit `from` for "everything up to
 * `to`", omit `to` for "everything from `from` on", omit both to wipe all recordings.
 * Returns { deleted, kept } day-folder counts. Used by /settings/reset-data.
 */
function deleteRecordingsInRange({ from, to } = {}) {
  if (!fs.existsSync(ROOT_DIR)) return { deleted: 0, kept: 0 };
  let deleted = 0, kept = 0;
  for (const entry of fs.readdirSync(ROOT_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
    const inRange = (!from || entry >= from) && (!to || entry <= to);
    if (!inRange) { kept += 1; continue; }
    try {
      fs.rmSync(path.join(ROOT_DIR, entry), { recursive: true, force: true });
      deleted += 1;
    } catch (err) {
      console.warn(`[tickRecorder] range-delete failed for ${entry}: ${err.message}`);
    }
  }
  return { deleted, kept };
}

// ── Status (for dashboard / debugging) ───────────────────────────────────────
function getStats() {
  return {
    enabled: ENABLED,
    rootDir: ROOT_DIR,
    today: istDateString(Date.now()),
    bufferDepth: {
      spot:     buffers.spot.length,
      options:  buffers.options.length,
      vix:      buffers.vix.length,
      oi:       buffers.oi.length,
      sessions: buffers.sessions.length,
    },
  };
}

module.exports = {
  recordSpotTick,
  recordOptionLtp,
  recordOptionQuote,
  recordVix,
  recordOi,
  recordSessionStart,
  recordSessionStop,
  snapshotSettings,
  flushAll,
  flushAllSync,
  pruneOldRecordings,
  deleteRecordingsInRange,
  getStats,
  // exposed for tests/replay
  _internals: { ROOT_DIR, istDateString, dayDir, ensureDayDir, MAX_BUFFER_RECORDS, RETAIN_DAYS },
};

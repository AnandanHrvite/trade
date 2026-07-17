/**
 * tickReplay.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic tick-replay engine. Replays a previously recorded paper-trade
 * session by feeding the recorded spot/option/VIX stream into the SAME paper
 * `onTick()` handlers that ran live — making BACKTEST = PAPER = LIVE.
 *
 * Design:
 *   - Paper code is NEVER modified. Replay achieves alignment by monkey-patching
 *     the dependencies paper consumes (socketManager, fyers REST, notifiers,
 *     tradeLogger) so that:
 *       socketManager.start/addCallback → captures the tick callback (no real WS)
 *       fyers.getQuotes(symbol)         → returns recorded option/VIX by replay clock
 *       notify(*) / sendTelegram         → no-op (don't spam during replay)
 *       tradeLogger.appendTradeLog      → diverts to replay-specific JSONL file
 *
 *   - The replay engine then:
 *       1. Loads session-start snapshot, applies settings overrides to env
 *       2. Calls the paper route's /start handler (which now builds state and
 *          registers the captured tick callback)
 *       3. Pumps recorded spot ticks through the captured callback in order,
 *          advancing the replay clock so option-LTP/VIX stubs serve correct values
 *       4. Calls the paper route's /stop handler to flush + summarise
 *       5. Restores all monkey-patches so the process can resume normal use
 *
 * IMPORTANT — concurrency:
 *   Only one replay can run in the same process at a time (since it patches
 *   global modules). The engine takes a process-wide lock and refuses overlap.
 *
 * Usage:
 *   const replay = require("./tickReplay");
 *   const result = await replay.replaySession({
 *     date:      "2026-05-15",
 *     mode:      "pa-paper",     // pa-paper | bb_rsi-paper | ema_rsi_st-paper | orb-paper
 *     sessionId: undefined,      // optional — defaults to first start of the day
 *     speed:     0,              // 0 = as-fast-as-possible, >0 = ms delay between ticks
 *   });
 *   // result = { sessionTrades, sessionPnl, ticksReplayed, durationMs, sessionId, mode }
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs       = require("fs");
const path     = require("path");
const readline = require("readline");
const crypto   = require("crypto");

const { ROOT_DIR } = require("../utils/tickRecorder")._internals;

// ── Process-wide lock so two replays can't trample each other's monkey-patches ─
let _replayInProgress = false;
// Set by requestCancel() (POST /replay/cancel). The spot-tick streaming loop
// in replaySession checks it each tick and stops early, then runs /stop to
// square off cleanly so no state is left stuck.
let _cancelRequested = false;

/** Signal the in-flight replay to stop early (mid-session). No-op if idle. */
function requestCancel() {
  _cancelRequested = true;
  return { ok: true, replayInProgress: _replayInProgress };
}

// ── Deterministic result cache ───────────────────────────────────────────────
// A replay is fully deterministic: same recorded ticks + same settings basis +
// same replay code → byte-identical trades/PnL. Re-running an identical replay
// therefore needn't re-stream 55k+ ticks (~80s). We cache the full result on
// disk keyed by a fingerprint of every input that can change the outcome, and
// short-circuit on a hit. Snapshot mode keys on the recorded session-start
// settings; sim mode keys on a snapshot of current env, so re-running the SAME
// settings hits while changing any setting misses (the refinement workflow's
// intent). Speed is excluded — it changes pacing, not the result.
//
// BUMP this whenever replay/strategy semantics change in a way that would alter
// a past session's result, so stale cached results are invalidated rather than
// silently served.
// v2: EMA_RSI_ST SAR chart dots now computed via calcSAR (was technicalindicators
//     PSAR) — old cached chartData would still show the library-PSAR dots.
// v3: (reverted) pre-market candle filter — backed out; behavior restored.
// v4: invalidate v3 (pre-market-filter) cached results after the revert.
// v5: EMA_RSI_ST Parabolic SAR fully stripped (2026-06-12) — SuperTrend is the only
//     trend source, EMA21 the only SL. Trade results for recorded sessions are
//     unchanged (they already ran SuperTrend + ema SL + 2-EMA), but cached
//     chartData still carries the old SAR-dot overlay — invalidate it.
// v6: EMA_RSI_ST chartData now carries an EMA9 overlay line (the triple-stack input);
//     results unchanged, but invalidate so re-runs regenerate the chart with EMA9.
// v7: confirmation-candle entry (EMA_RSI_ST/BB_RSI). Snapshot replays of pre-feature
//     recordings now force the toggle OFF (the key is absent from their snapshot)
//     so they reproduce their original entries — invalidate any results cached
//     between the feature deploy and this fix, which may have run confirmation ON.
// v8: expiry now resolved from the recorded Market Context Snapshot (market.jsonl)
//     for BOTH snapshot and current-settings runs — old cache entries used the
//     blank-auto-detect pin and must be invalidated.
const REPLAY_CACHE_VERSION = 8;

function _replayCacheDir() {
  return path.join(ROOT_DIR, "_replay_cache");
}

// Cheap immutability fingerprint for a recorded file: size + mtime. Recorded
// tick files for a past date never change, so this is a sufficient (and fast)
// invalidation signal — no need to hash multi-MB streams.
function _fileFingerprint(p) {
  try { const st = fs.statSync(p); return `${st.size}:${Math.round(st.mtimeMs)}`; }
  catch (_) { return "missing"; }
}

// ── Expiry pinning (simulator mode) ──────────────────────────────────────────
// These keys resolve WHICH option contract (strike-expiry / weekly-vs-monthly)
// instrument.js builds. The recorded options.jsonl only carries ticks for the
// expiry the session actually traded that day — so a sim run MUST use the
// recorded day's expiry, not today's. Honoring the CURRENT OPTION_EXPIRY_*
// against old ticks misses every quote → paper's spot-proxy fallback poisons the
// entry/exit LTP → nonsense P&L. So in simulator mode we pin ONLY these keys to
// the recorded snapshot; every other setting still honors current process.env.
// A key absent from the snapshot (expiry was auto-detected, not overridden, on
// the recorded day) is forced blank → instrument.js auto-computes the expiry
// from the replay clock (Date.now is patched to the replay tick time), which
// reproduces what the live recording did. Either way the current env value is
// never allowed to leak in.
const _EXPIRY_PIN_KEYS = [
  "OPTION_EXPIRY_OVERRIDE",          "OPTION_EXPIRY_TYPE",
  "EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE",    "EMA_RSI_ST_OPTION_EXPIRY_TYPE",
  "BB_RSI_OPTION_EXPIRY_OVERRIDE",    "BB_RSI_OPTION_EXPIRY_TYPE",
  "PA_OPTION_EXPIRY_OVERRIDE",       "PA_OPTION_EXPIRY_TYPE",
  "ORB_OPTION_EXPIRY_OVERRIDE",      "ORB_OPTION_EXPIRY_TYPE",
  "EMA9VWAP_OPTION_EXPIRY_OVERRIDE", "EMA9VWAP_OPTION_EXPIRY_TYPE",
  "TREND_PB_OPTION_EXPIRY_OVERRIDE", "TREND_PB_OPTION_EXPIRY_TYPE",
];
function _pinnedExpirySettings(snapshot) {
  const snap = snapshot || {};
  const out = {};
  for (const k of _EXPIRY_PIN_KEYS) {
    out[k] = (k in snap) ? snap[k] : "";  // recorded value, or blank → auto-compute from replay clock
  }
  return out;
}

// Map a replay mode to its per-strategy env-key prefix (e.g. "PA_OPTION_EXPIRY_*").
const _MODE_TO_ENV_PREFIX = {
  "pa-paper":       "PA",
  "bb_rsi-paper":   "BB_RSI",
  "ema_rsi_st-paper": "EMA_RSI_ST",
  "orb-paper":      "ORB",
  "ema9vwap-paper": "EMA9VWAP",
  "trend-pb-paper": "TREND_PB",
};

// ── Market-context expiry resolution (the mismatch fix) ──────────────────────
// Historical option EXPIRY must come from the recording, never from "today" and
// never from current settings. This resolves the expiry env-overlay a replay run
// applies — IDENTICALLY for snapshot and current-settings mode, because expiry is
// a MARKET fact, not strategy config:
//
//   • Both the expiry TYPE (weekly|monthly) and any explicit override are read
//     from the RECORDED session snapshot — the config that day actually traded.
//     Current process.env is deliberately ignored here so a standing override in
//     today's Settings (e.g. a next-week EMA_RSI_ST date) can't leak into an
//     old-day replay. Current settings only override NON-expiry strategy config.
//   • If the recorded day used an explicit override (e.g. EMA_RSI_ST deliberately
//     traded next-week to dodge 0DTE), that recorded date IS the historical truth
//     → honored as-is. Only the auto-detect path (blank recorded override) is
//     redirected to the Market Context Snapshot date — exactly the path that used
//     to leak today's expiry via new Date()/live REST.
//
// When no market.jsonl exists (recordings made before this feature), falls back
// to the legacy snapshot pin so old days still replay without crashing.
// (useCurrentSettings is accepted for signature symmetry but intentionally does
//  NOT affect expiry — that's the whole point.)
function _resolveReplayExpiryEnv({ marketContext, snapshot, mode }) {
  const prefix = _MODE_TO_ENV_PREFIX[mode] || null;
  const snap = snapshot || {};
  const cfg  = snap;   // expiry is ALWAYS historical — read from the recording, never current env

  const perModeOverride = prefix ? String(cfg[`${prefix}_OPTION_EXPIRY_OVERRIDE`] || "").trim() : "";
  const commonOverride  = String(cfg.OPTION_EXPIRY_OVERRIDE || "").trim();
  const effOverride     = perModeOverride || commonOverride;

  const perModeType = prefix ? String(cfg[`${prefix}_OPTION_EXPIRY_TYPE`] || "").trim().toLowerCase() : "";
  const commonType  = String(cfg.OPTION_EXPIRY_TYPE || "").trim().toLowerCase();
  const type        = (perModeType || commonType) === "monthly" ? "monthly" : "weekly";

  const _mirror = (date) => {
    const env = { OPTION_EXPIRY_OVERRIDE: date, OPTION_EXPIRY_TYPE: type };
    if (prefix) {
      env[`${prefix}_OPTION_EXPIRY_OVERRIDE`] = date;
      env[`${prefix}_OPTION_EXPIRY_TYPE`]     = type;
    }
    return env;
  };

  // Explicit override → honor it (historical truth / deliberate choice).
  if (effOverride && effOverride.length >= 8) {
    return { env: _mirror(effOverride), source: "explicit-override", date: effOverride, type };
  }

  // Auto-detect → redirect to the recorded market fact (the fix).
  if (marketContext) {
    const date = type === "monthly" ? marketContext.monthlyExpiry : marketContext.weeklyExpiry;
    if (date) return { env: _mirror(date), source: "market-context", date, type };
  }

  // No market context (legacy recording) → prior behaviour (blank pin = auto-compute).
  return { env: _pinnedExpirySettings(snap), source: "legacy-pin", date: null, type };
}

function _buildReplayCacheKey({ mode, date, sessionStart, useCurrentSettings, expiryEnv }) {
  const dir = path.join(ROOT_DIR, date);
  // Sim mode: the result depends on the CURRENT value of the settings the
  // strategy reads — so key on those keys' current process.env values, using
  // the snapshot's key set (the managed-settings keys captured at record time).
  // NOT the whole process.env: PM2/deploy injects per-restart vars (pm_id,
  // NODE_APP_INSTANCE, uptime, instance id, …) that change every restart and
  // would bust the cache on each deploy even with identical strategy settings.
  // Snapshot mode keys on the recorded session-start env (immutable on disk).
  let settingsBasis;
  if (useCurrentSettings) {
    settingsBasis = {};
    for (const k of Object.keys(sessionStart.settings || {})) settingsBasis[k] = process.env[k];
  } else {
    settingsBasis = Object.assign({}, sessionStart.settings || {});
  }
  // Overlay the resolved historical expiry (from the Market Context Snapshot) so
  // the cache key reflects the contract the run will actually trade — and two
  // different current-expiry values that both pin to the same recorded date share
  // one cache entry instead of splitting it.
  Object.assign(settingsBasis, expiryEnv || {});
  const basis = {
    v: REPLAY_CACHE_VERSION,
    mode,
    date,
    sid: sessionStart.sid,
    src: useCurrentSettings ? "sim" : "snapshot",
    files: {
      sessions: _fileFingerprint(path.join(dir, "sessions.jsonl")),
      spot:     _fileFingerprint(path.join(dir, "spot.jsonl")),
      options:  _fileFingerprint(path.join(dir, "options.jsonl")),
      vix:      _fileFingerprint(path.join(dir, "vix.jsonl")),
    },
    settings: settingsBasis,
  };
  return crypto.createHash("sha1").update(JSON.stringify(basis)).digest("hex");
}

function _readReplayCache(key) {
  try {
    const f = path.join(_replayCacheDir(), `${key}.json`);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch (_) { return null; }
}

// Drop replay-cache entries older than the retention window. Replay runs are
// user-triggered and infrequent, so a once-per-process prune on the first write
// (no standing timer) is enough to stop _replay_cache growing without bound.
const REPLAY_CACHE_RETAIN_DAYS = parseInt(process.env.REPLAY_CACHE_RETAIN_DAYS || "30", 10);
let _replayCachePruned = false;
function _pruneReplayCache() {
  try {
    const dir = _replayCacheDir();
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - REPLAY_CACHE_RETAIN_DAYS * 86400_000;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const fp = path.join(dir, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch (_) {}
    }
  } catch (_) { /* best-effort cleanup */ }
}

function _writeReplayCache(key, result) {
  try {
    const dir = _replayCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!_replayCachePruned) { _replayCachePruned = true; _pruneReplayCache(); }
    const f = path.join(dir, `${key}.json`);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(result));
    fs.renameSync(tmp, f);
  } catch (e) {
    console.log(`⚠️ [replay] cache write failed: ${e.message}`);
  }
}

// ── Loaders ─────────────────────────────────────────────────────────────────

// Sync read (used for small files: sessions.jsonl ≤ ~6 events/day)
function _readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  if (!text) return [];
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch (_) { /* skip bad lines */ }
  }
  return out;
}

// Stream-read JSONL line-by-line, applying optional filter, with optional
// per-line callback. Keeps memory bounded — never materialises the full file.
//   onRec(rec)        — invoked for each parsed record passing the filter
//   filterFn(rec)     — return true to keep, false to skip
// Returns Promise<count of kept records>.
async function _streamJsonl(filePath, { onRec, filterFn } = {}) {
  if (!fs.existsSync(filePath)) return 0;
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let kept = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch (_) { continue; }
    if (filterFn && !filterFn(rec)) continue;
    if (onRec) onRec(rec);
    kept += 1;
  }
  return kept;
}

/**
 * Load metadata streams for a recorded day and pick the matching session.
 *
 *   date      — "YYYY-MM-DD" (IST)
 *   mode      — e.g. "pa-paper"
 *   sessionId — optional; if omitted, picks the first start event for that mode
 *
 * Returns: { sessionStart, sessionStop, optionTicks, vixTicks, spotPath }
 *   - sessions.jsonl is small (handful of events), read sync.
 *   - options/vix are loaded into memory (need timeline for binary lookup
 *     by the getQuotes stub) — typical sizes ~14k options × ~70 B = ~1 MB,
 *     vix ~360 × ~30 B = ~12 KB. Cheap.
 *   - spot.jsonl is NOT loaded — `spotPath` is returned for the caller to
 *     stream-iterate (~25k records/day = the only large stream).
 */
async function loadSessionData({ date, mode, sessionId }) {
  if (!date) throw new Error("loadSessionData: date is required");
  if (!mode) throw new Error("loadSessionData: mode is required");

  const dir = path.join(ROOT_DIR, date);
  if (!fs.existsSync(dir)) {
    throw new Error(`No recording found for ${date} at ${dir}`);
  }

  // Immutable Market Context Snapshot (expiry/lot/strike-interval/meta) — the
  // replay's source of truth for historical market facts. Absent for recordings
  // made before this feature shipped; callers fall back to the legacy expiry pin.
  let marketContext = null;
  const _mcPath = path.join(dir, "market.jsonl");
  if (fs.existsSync(_mcPath)) {
    const _mc = _readJsonl(_mcPath);
    if (_mc.length) marketContext = _mc[_mc.length - 1];   // one record/day; last wins if re-appended
  }

  const sessions = _readJsonl(path.join(dir, "sessions.jsonl"));
  const startEvts = sessions.filter(s => s.e === "start" && s.mode === mode);
  if (startEvts.length === 0) {
    throw new Error(`No '${mode}' session-start event found in ${date}`);
  }

  let sessionStart;
  if (sessionId) {
    sessionStart = startEvts.find(s => s.sid === sessionId);
    if (!sessionStart) throw new Error(`sessionId ${sessionId} not found for ${mode} on ${date}`);
  } else {
    sessionStart = startEvts[0];
  }

  let sessionStop = sessions.find(s =>
    s.e === "stop" && s.mode === mode && s.sid === sessionStart.sid && s.t >= sessionStart.t
  );

  const startT = sessionStart.t;
  const stopT  = sessionStop ? sessionStop.t : Infinity;
  const inWindow = (rec) => rec.t >= startT && rec.t <= stopT;
  const byT      = (a, b) => a.t - b.t;

  // Stream options + vix (small but stream them anyway to avoid full-file
  // intermediate string allocation).
  const optionTicks = [];
  const vixTicks    = [];
  const oiTicks     = [];
  await _streamJsonl(path.join(dir, "options.jsonl"), { filterFn: inWindow, onRec: r => optionTicks.push(r) });
  await _streamJsonl(path.join(dir, "vix.jsonl"),     { filterFn: inWindow, onRec: r => vixTicks.push(r) });
  // oi.jsonl only exists for sessions recorded after OI capture shipped — guard it.
  const _oiPath = path.join(dir, "oi.jsonl");
  if (fs.existsSync(_oiPath)) {
    await _streamJsonl(_oiPath, { filterFn: inWindow, onRec: r => oiTicks.push(r) });
  }
  optionTicks.sort(byT);
  vixTicks.sort(byT);
  oiTicks.sort(byT);

  // If session-stop missing, peek the last spot-tick timestamp as bound.
  // This requires a single streaming pass — cheap and avoids loading.
  if (!sessionStop) {
    let lastT = startT;
    await _streamJsonl(path.join(dir, "spot.jsonl"), {
      filterFn: r => r.t >= startT,
      onRec:    r => { if (r.t > lastT) lastT = r.t; },
    });
    sessionStop = { t: lastT, e: "stop", mode, sid: sessionStart.sid, reason: "synth_eod" };
  }

  return {
    sessionStart,
    sessionStop,
    optionTicks,
    vixTicks,
    oiTicks,
    marketContext,
    spotPath: path.join(dir, "spot.jsonl"),
  };
}

// ── Per-symbol option LTP timeline (for fyers.getQuotes stub) ───────────────
function _buildOptionTimeline(optionTicks) {
  const bySymbol = new Map();
  for (const rec of optionTicks) {
    let arr = bySymbol.get(rec.s);
    if (!arr) { arr = []; bySymbol.set(rec.s, arr); }
    arr.push({ t: rec.t, l: rec.l, b: rec.b, a: rec.a });
  }
  // Each symbol's array is already in ascending order (input was sorted by t).
  return bySymbol;
}

function _lookupAtOrBefore(arr, t) {
  // Binary search: largest index where arr[i].t <= t. Returns null if none.
  if (!arr || arr.length === 0) return null;
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].t <= t) { ans = mid; lo = mid + 1; }
    else                  hi = mid - 1;
  }
  return ans >= 0 ? arr[ans] : null;
}

// Nearest tick to t within ±windowMs. Paper's option polls have 200-500ms
// network latency, so the recorded LTP for the "first poll after entry"
// lands AFTER the entry moment — strict at-or-before would miss it and
// return the previous trade's last polled LTP instead. Falls back to
// at-or-before when no tick is within the window.
function _lookupNearest(arr, t, windowMs) {
  if (!arr || arr.length === 0) return null;
  // First candidate: largest index with arr[i].t <= t
  let lo = 0, hi = arr.length - 1, idxBefore = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].t <= t) { idxBefore = mid; lo = mid + 1; }
    else                  hi = mid - 1;
  }
  const before = idxBefore >= 0 ? arr[idxBefore] : null;
  const after  = idxBefore + 1 < arr.length ? arr[idxBefore + 1] : null;
  const dBefore = before ? Math.abs(t - before.t) : Infinity;
  const dAfter  = after  ? Math.abs(after.t - t)  : Infinity;
  const best = dAfter < dBefore ? after : before;
  if (!best) return null;
  // Within window → return nearest (may be after t)
  if (Math.min(dBefore, dAfter) <= windowMs) return best;
  // Past the window: if the nearest recorded tick is AFTER t, forward-fill it.
  // Covers a strike's first subscription (no prior tick) AND re-subscription
  // later in the session — the same strike is only subscribed while a position
  // is open, so its timeline has multi-minute gaps between trades. A stale tick
  // from an earlier subscription survives far back in the array as `before`;
  // without this, a new entry inherits the PREVIOUS trade's last LTP instead of
  // its own first tick (e.g. trade 2's entry = trade 1's exit price). On a
  // first-ever subscription the entry would instead land in a data hole →
  // paper's 10s spot-proxy fallback poisons optionEntryLtp with the spot price.
  if (after && dAfter < dBefore) return after;
  // Otherwise (after is null, or before is genuinely nearer) → at-or-before.
  return before;
}

// ── Settings override (env snapshot) ────────────────────────────────────────
function _applySettingsOverride(settings) {
  if (!settings) return () => {};
  const original = {};
  for (const k of Object.keys(settings)) {
    original[k] = process.env[k];   // may be undefined
    process.env[k] = settings[k];
  }
  return function restore() {
    for (const k of Object.keys(original)) {
      if (original[k] === undefined) delete process.env[k];
      else                            process.env[k] = original[k];
    }
  };
}

// ── Canonical paper-trade lookup ─────────────────────────────────────────────
// The replay's "baseline" used to be a second replay run with snapshot env.
// That's wasteful and conflates "did the engine reproduce the recording" with
// "did the recording match what live actually did." The user wants baseline =
// the actual recorded live session from ~/trading-data/{strategy}_paper_trades.json,
// loaded once at the start of each replay run. Matches by closest sessionStart
// timestamp within a 60-second window — accounts for the ~ms-level skew between
// state.sessionStart (ISO toISOString()) and state._sessionId (Date.now()).
const _MODE_TO_CANONICAL_FILE = {
  "pa-paper":       "pa_paper_trades.json",
  "bb_rsi-paper":    "bb_rsi_paper_trades.json",
  "ema_rsi_st-paper":    "ema_rsi_st_paper_trades.json",
  "orb-paper":      "orb_paper_trades.json",
  "ema9vwap-paper": "ema9vwap_paper_trades.json",
  "trend-pb-paper": "trend_pb_paper_trades.json",
};
function _lookupCanonicalSession(mode, sessionStartTs) {
  const fname = _MODE_TO_CANONICAL_FILE[mode];
  if (!fname) return null;
  const filePath = path.join(require("os").homedir(), "trading-data", fname);
  if (!fs.existsSync(filePath)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch (_) { return null; }
  if (!data || !Array.isArray(data.sessions)) return null;
  // session.date is written two ways across modes: EMA_RSI_ST stores a date-only
  // string ("YYYY-MM-DD" via toISOString().split); pa/bb_rsi/orb store
  // a full ISO timestamp (date: state.sessionStart = new Date().toISOString()).
  // Normalise both to a UTC calendar day and match on that — Date.parse handles
  // either form. (The old 60s-window compare matched the ISO form but never the
  // date-only form; a strict string-equality match would do the reverse.)
  const _dayOf = (d) => {
    const t = Date.parse(d);
    return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
  };
  const wantDate = new Date(sessionStartTs).toISOString().slice(0, 10);
  const sameDay = data.sessions.filter(s => s && _dayOf(s.date) === wantDate);
  if (sameDay.length === 0) return null;
  // Among same-day sessions (rare — usually one/day), pick the closest start.
  // A full-ISO `date` is itself the start instant; EMA_RSI_ST's date-only `date`
  // relies on its IST-formatted `startTime` ("DD/MM/YYYY, HH:MM:SS").
  const parseIst = (s) => {
    const m = typeof s === "string"
      && s.match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return NaN;
    return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) - 19800000;
  };
  const startMs = (s) => {
    if (typeof s.date === "string" && s.date.includes("T")) {
      const d = Date.parse(s.date);
      if (!Number.isNaN(d)) return d;
    }
    return parseIst(s.startTime);
  };
  let best = sameDay[0], bestDelta = Infinity;
  for (const sess of sameDay) {
    const ms = startMs(sess);
    const delta = Number.isNaN(ms) ? Infinity : Math.abs(ms - sessionStartTs);
    if (delta < bestDelta) { bestDelta = delta; best = sess; }
  }
  // Session PnL is stored as `sessionPnl` (legacy fallback: `pnl`).
  const pnl = typeof best.sessionPnl === "number" ? best.sessionPnl
            : typeof best.pnl === "number"        ? best.pnl
            : 0;
  // Normalise the matched live trades into the same compact shape the replay
  // run emits (see tradeUtils.mapTradesReversed), kept chronological so the
  // diagnostic can line baseline trade N up against YourCfg trade N.
  const trades = (Array.isArray(best.trades) ? best.trades : []).map(t => ({
    side:   t.side || "",
    strike: t.optionStrike || "",
    expiry: t.optionExpiry || "",
    entry:  t.entryTime || "",
    exit:   t.exitTime || "",
    eSpot:  t.spotAtEntry || t.entryPrice || 0,
    eOpt:   t.optionEntryLtp || null,
    eSl:    t.stopLoss || t.initialStopLoss || null,
    xSpot:  t.spotAtExit || t.exitPrice || 0,
    xOpt:   t.optionExitLtp || null,
    pnl:    typeof t.pnl === "number" ? t.pnl : null,
    reason: t.exitReason || "",
    symbol: t.symbol || "",
  }));
  return {
    pnl,
    tradeCount:  trades.length || (typeof best.totalTrades === "number" ? best.totalTrades : 0),
    trades,
    matchedAt:   best.date,
    matchSkewMs: Number.isFinite(bestDelta) ? bestDelta : null,
  };
}

// ── Monkey-patch harness ────────────────────────────────────────────────────
/**
 * Build the harness: install() patches deps, uninstall() restores them.
 * The harness exposes `pumpTick(tick)` for the engine to fan ticks through
 * the captured callbacks.
 */
function _createHarness({ optionTimeline, vixTimeline, oiTimeline, warmupCandles, recordedDateStr = null, outputSubdir = "_replay_trades", outputSuffix = "replay" }) {
  const socketManager     = require("../utils/socketManager");
  const fyers             = require("../config/fyers");
  const notify            = require("../utils/notify");
  const tradeLogger       = require("../utils/tradeLogger");
  const backtestEngine    = require("./backtestEngine");
  const candleCache       = require("../utils/candleCache");
  const fyersAuthCheck    = require("../utils/fyersAuthCheck");
  const nseHolidays       = require("../utils/nseHolidays");
  const tickRecorder      = require("../utils/tickRecorder");
  const sharedSocketState = require("../utils/sharedSocketState");
  const skipLogger        = require("../utils/skipLogger");

  const orig = {
    sm_start:        socketManager.start,
    sm_addCallback:  socketManager.addCallback,
    sm_removeCallback: socketManager.removeCallback,
    sm_isRunning:    socketManager.isRunning,
    sm_stop:         socketManager.stop,
    fyers_getQuotes: fyers.getQuotes,
    fyers_getHistory: fyers.getHistory,
    bt_fetchCandles: backtestEngine.fetchCandles,
    cc_fetchCandlesCached: candleCache.fetchCandlesCached,
    tl_appendTradeLog: tradeLogger.appendTradeLog,
    notifyEntry:     notify.notifyEntry,
    notifyExit:      notify.notifyExit,
    notifyStarted:   notify.notifyStarted,
    notifySignal:    notify.notifySignal,
    notifyDayReport: notify.notifyDayReport,
    sendTelegram:    notify.sendTelegram,
    notifyAuthError: notify.notifyAuthError,
    verifyFyersToken: fyersAuthCheck.verifyFyersToken,
    isTradingAllowed: nseHolidays.isTradingAllowed,
    isExpiryDay:      nseHolidays.isExpiryDay,
    isExpiryDate:     nseHolidays.isExpiryDate,
    DateNow:          Date.now,
    // tickRecorder originals — replay must NOT write back into the canonical
    // recording streams (it would create phantom session rows and duplicate
    // option-LTP entries in the recording the user is replaying from).
    tr_recordSpotTick:     tickRecorder.recordSpotTick,
    tr_recordOptionLtp:    tickRecorder.recordOptionLtp,
    tr_recordOptionQuote:  tickRecorder.recordOptionQuote,
    tr_recordVix:          tickRecorder.recordVix,
    tr_recordOi:           tickRecorder.recordOi,
    tr_recordSessionStart: tickRecorder.recordSessionStart,
    tr_recordSessionStop:  tickRecorder.recordSessionStop,
    // skipLogger original — replay must NOT write strategy/VIX/spread skip
    // rows into the canonical ~/trading-data/skips/ files. The skip gates are
    // re-evaluated on every replayed tick, so without this stub each replay
    // appends phantom skips (under the recorded session's date, since Date.now
    // is overridden) to the real Skip Logs the user sees in /trade-logs.
    sl_appendSkipLog:      skipLogger.appendSkipLog,
    // sharedSocketState originals — paper /start handlers call setActive()
    // (and only some /stop paths call clear()). If the replay's /stop bails
    // out early — e.g. EMA_RSI_ST /stop returns 400 when ptState.running became
    // false mid-replay — the real sharedSocketState gets stuck "active" and
    // the preflight banner falsely blocks the next replay. Stub the mutators
    // so replays can't touch real state at all; reads still pass through.
    ss_setActive:         sharedSocketState.setActive,
    ss_clear:             sharedSocketState.clear,
    ss_setBbRsiActive:    sharedSocketState.setBbRsiActive,
    ss_clearBbRsi:        sharedSocketState.clearBbRsi,
    ss_setPAActive:       sharedSocketState.setPAActive,
    ss_clearPA:           sharedSocketState.clearPA,
    ss_setOrbActive:      sharedSocketState.setOrbActive,
    ss_clearOrb:          sharedSocketState.clearOrb,
    // fs originals — paper /stop calls saveSession() → savePaperData() which
    // writes the canonical {strategy}_paper_trades.json via fs.writeFileSync
    // + fs.renameSync directly (NOT via tradeLogger.appendTradeLog, which we
    // already stub). Without intercepting these, every replay /stop appends
    // a phantom session to the real paper history file.
    fs_writeFileSync: fs.writeFileSync,
    fs_renameSync:    fs.renameSync,
    // setTimeout/clearTimeout originals — paper code uses setTimeout-driven
    // polling (option LTP every ~500ms-1s) to update ptState.optionLtp during
    // a trade. In replay, the pump processes thousands of ticks in seconds
    // of real wall-clock time, so the 1-sec polling barely fires — leaving
    // ptState.optionLtp frozen at the entry-time value. Force only short
    // delays to fire ASAP. Long delays (auto-stop = 395 min) MUST pass
    // through, otherwise the auto-stop fires on the first event-loop yield
    // and sets state.running = false before any candle close evaluates.
    setTimeout_:   global.setTimeout,
    clearTimeout_: global.clearTimeout,
  };

  // Threshold above which setTimeout delays pass through unchanged. 30 sec
  // is well above polling cadences (≤2s) and well below auto-stop / cooldown
  // ranges (minutes). Pending long-delay handles are tracked so uninstall
  // can clear them — otherwise after the route-module cache is dropped, the
  // timer would still fire in real time and reference a dead state object.
  const SHORT_DELAY_CAP_MS = 30 * 1000;
  const _pendingLongTimers = new Set();

  // Captured callbacks (paper modules call socketManager.addCallback / .start)
  const callbacks = []; // [{ id, onTick, onLog }]

  // Replay clock — advanced as ticks are pumped. Used by getQuotes stub.
  let replayNow = 0;
  function setNow(t) { replayNow = t; }

  function install() {
    // socketManager: capture callbacks, do not open a real WS
    socketManager.start = function (symbol, onTick, onLog) {
      if (typeof onTick === "function") callbacks.push({ id: "__primary__", onTick, onLog });
    };
    socketManager.addCallback = function (id, onTick, onLog) {
      callbacks.push({ id, onTick, onLog });
    };
    socketManager.removeCallback = function (id) {
      const idx = callbacks.findIndex(c => c.id === id);
      if (idx >= 0) callbacks.splice(idx, 1);
    };
    socketManager.isRunning = () => callbacks.length > 0;
    socketManager.stop = () => { callbacks.length = 0; };

    // fyers.getQuotes: serve recorded option LTP / VIX based on replayNow
    fyers.getQuotes = async function (symbols) {
      const sym = Array.isArray(symbols) ? symbols[0] : symbols;
      if (!sym) return { s: "no_data", d: [] };

      // VIX path
      if (sym === "NSE:INDIAVIX-INDEX") {
        const v = _lookupAtOrBefore(vixTimeline, replayNow);
        if (!v) return { s: "no_data", d: [] };
        return { s: "ok", d: [{ v: { lp: v.l != null ? v.l : v.v } }] };
      }

      // OI path: NIFTY-futures OI for the oiFilter gate. Match any *FUT symbol
      // (the futures contract symbol can differ between record/replay time) and
      // serve the recorded OI at-or-before the replay clock. Empty timeline
      // (pre-OI-capture sessions) → no_data → oiFilter fails open, unchanged.
      if (sym.endsWith("FUT")) {
        const o = _lookupAtOrBefore(oiTimeline, replayNow);
        if (!o) return { s: "no_data", d: [] };
        return { s: "ok", d: [{ v: { oi: o.oi } }] };
      }

      // Option path: ±2s window to absorb paper's option-poll network latency
      // (200-500ms typical; first poll after entry lands strictly AFTER replayNow).
      // bid/ask are present only on spread-guard quotes (LTP-only polls and
      // pre-capture recordings omit them → spread guard fails open, unchanged).
      const arr = optionTimeline.get(sym);
      const v = _lookupNearest(arr, replayNow, 2000);
      if (!v) return { s: "no_data", d: [] };
      return { s: "ok", d: [{ v: { lp: v.l, bid: v.b, ask: v.a } }] };
    };

    // fyers.getHistory + backtestEngine.fetchCandles + candleCache.fetchCandlesCached:
    // intercept warmup-candle preload to return the recorded snapshot. Paper's
    // /start calls fetchCandlesCached(spotSym, res, fromStr, toStr, fetchCandles)
    // — we short-circuit it to return the recorded warmup so replay is fully
    // deterministic (no live REST hit, no dependence on broker uptime).
    fyers.getHistory = async function (_params) {
      // Wrap warmup candles into Fyers history response shape:
      //   { s:"ok", candles: [[ts, open, high, low, close, vol], ...] }
      const rows = (warmupCandles || []).map(c =>
        [c.time, c.open, c.high, c.low, c.close, c.volume || 0]
      );
      return { s: "ok", candles: rows };
    };
    backtestEngine.fetchCandles = async function (_sym, _res, _from, _to) {
      return (warmupCandles || []).slice();
    };
    candleCache.fetchCandlesCached = async function (_sym, _res, _from, _to, _rawFetcher) {
      return (warmupCandles || []).slice();
    };

    // tradeLogger: divert to replay-specific files so we don't pollute the
    // canonical paper log and can compare side-by-side. `outputSubdir` lets
    // current-settings simulator runs land in a separate folder from
    // deterministic snapshot replays.
    tradeLogger.appendTradeLog = function (mode, trade) {
      try {
        const dir  = path.join(ROOT_DIR, outputSubdir);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${mode}_${outputSuffix}.jsonl`);
        fs.appendFileSync(file, JSON.stringify({ ...trade, _replay: true, _replayKind: outputSuffix }) + "\n");
      } catch (_) {}
    };

    // tickRecorder: silence ALL recording calls during replay. Paper code
    // routinely calls recordSessionStart/recordOptionLtp/etc. — without these
    // stubs, every replay run permanently appends to the canonical recording
    // streams (phantom session rows in the Replay list, duplicate option LTPs).
    tickRecorder.recordSpotTick     = () => {};
    tickRecorder.recordOptionLtp    = () => {};
    tickRecorder.recordOptionQuote  = () => {};
    tickRecorder.recordVix          = () => {};
    tickRecorder.recordOi           = () => {};
    tickRecorder.recordSessionStart = () => {};
    tickRecorder.recordSessionStop  = () => {};

    // skipLogger: silence skip logging during replay so re-evaluated gates
    // don't append phantom rows to the canonical ~/trading-data/skips/ files.
    skipLogger.appendSkipLog = () => {};

    // sharedSocketState: stub the mutators so /start's setActive() and
    // /stop's clear() don't touch real session state. Reads (isActive,
    // getMode, etc.) are left intact — they return whatever real-process
    // state actually holds.
    sharedSocketState.setActive         = () => {};
    sharedSocketState.clear             = () => {};
    sharedSocketState.setBbRsiActive    = () => {};
    sharedSocketState.clearBbRsi        = () => {};
    sharedSocketState.setPAActive       = () => {};
    sharedSocketState.clearPA           = () => {};
    sharedSocketState.setOrbActive      = () => {};
    sharedSocketState.clearOrb          = () => {};

    // fs: intercept writes to canonical paper_trades.json (and its .tmp
    // sibling used for atomic temp+rename). Anything else passes through
    // — replay's own JSONL output and the harness internals are untouched.
    fs.writeFileSync = function (file, data, opts) {
      const p = typeof file === "string" ? file : String(file);
      if (/ema_rsi_st_paper_trades\.json(\.tmp)?$/.test(p)) return; // silently drop
      return orig.fs_writeFileSync(file, data, opts);
    };
    fs.renameSync = function (from, to) {
      const t = typeof to === "string" ? to : String(to);
      if (/ema_rsi_st_paper_trades\.json$/.test(t)) return; // silently drop
      return orig.fs_renameSync(from, to);
    };

    // setTimeout override — collapse SHORT delays (≤30s) to 0ms so that
    // setTimeout-chained polling (option LTP every 500ms-1s in live) fires
    // on every event-loop yield instead of every real-time second. With the
    // pump issuing setImmediate every 200 ticks, this makes the option
    // poll fire ~once per 200-tick batch — closely matching live's 1-sec
    // cadence over a recorded session.
    //
    // LONG delays (>30s) pass through unchanged. Critically, this preserves
    // auto-stop timers (395 min) — if we collapsed those too, auto-stop
    // would fire on the first event-loop yield and set state.running=false
    // before any candle close could evaluate, producing 0 trades for every
    // replay. Pending long timers are tracked in _pendingLongTimers so
    // uninstall can clear them; otherwise after the route module is dropped
    // from require.cache, the timer would still fire in real time and call
    // stopSession on a stale state object from the freed closure.
    global.setTimeout = function (cb, _delay, ...args) {
      const d = typeof _delay === "number" ? _delay : 0;
      if (d > SHORT_DELAY_CAP_MS) {
        let handle;
        const wrapped = (...wargs) => { _pendingLongTimers.delete(handle); try { cb(...wargs); } catch (_) {} };
        handle = orig.setTimeout_(wrapped, d, ...args);
        _pendingLongTimers.add(handle);
        return handle;
      }
      return orig.setTimeout_(cb, 0, ...args);
    };
    global.clearTimeout = function (handle) {
      _pendingLongTimers.delete(handle);
      return orig.clearTimeout_(handle);
    };

    // notifications: silence everything during replay
    notify.notifyEntry     = () => {};
    notify.notifyExit      = () => {};
    notify.notifyStarted   = () => {};
    notify.notifySignal    = () => {};
    notify.notifyDayReport = () => {};
    notify.sendTelegram    = async () => ({ ok: true, replay: true });
    notify.notifyAuthError = () => {};

    // Bypass start-time gates so replay works after market hours / on holidays
    // / without a valid Fyers token. These are admin gates on /start, not
    // strategy logic — replaying a recorded session is always "allowed".
    fyersAuthCheck.verifyFyersToken = async () => ({ ok: true, replay: true });
    nseHolidays.isTradingAllowed    = async () => ({ allowed: true, reason: "replay" });
    // Date-aware: derive expiry status from the recorded session's actual
    // date so ORB expiry-only sessions reproduce their entries.
    // Falls back to false when the date is unknown (matches legacy behaviour).
    nseHolidays.isExpiryDay         = async () => {
      if (!recordedDateStr) return false;
      try { return await orig.isExpiryDate(recordedDateStr); }
      catch (_) { return false; }
    };

    // VIX cache reset is fine; let it pass through.
  }

  // Wall-clock override. Used during /start and /stop so isStartAllowed() /
  // exit-time gates see the recorded session boundary as "now", AND advanced
  // per-tick from pumpTick() so isMarketHours() inside strategies sees the
  // recorded market-hours timestamp on every tick.
  //
  // Perf: pumpTick calls setWallClock once per tick (~55k+ calls/session).
  // Reassigning Date.now's slot on every call (the prior implementation) made
  // V8 deopt the global Date.now repeatedly. We now install a stable closure
  // function ONCE per setWallClock-active window and only mutate `_wallOverride`
  // on the hot path, so V8 keeps Date.now optimized.
  let _wallOverride  = null;
  const _dateNowOverride = function () { return _wallOverride; };
  function setWallClock(t) {
    _wallOverride = t;
    if (Date.now !== _dateNowOverride) Date.now = _dateNowOverride;
  }
  function clearWallClock() {
    _wallOverride = null;
    Date.now = orig.DateNow;
  }

  function uninstall() {
    socketManager.start             = orig.sm_start;
    socketManager.addCallback       = orig.sm_addCallback;
    socketManager.removeCallback    = orig.sm_removeCallback;
    socketManager.isRunning         = orig.sm_isRunning;
    socketManager.stop              = orig.sm_stop;
    fyers.getQuotes                 = orig.fyers_getQuotes;
    fyers.getHistory                = orig.fyers_getHistory;
    backtestEngine.fetchCandles     = orig.bt_fetchCandles;
    candleCache.fetchCandlesCached  = orig.cc_fetchCandlesCached;
    tradeLogger.appendTradeLog      = orig.tl_appendTradeLog;
    notify.notifyEntry              = orig.notifyEntry;
    notify.notifyExit               = orig.notifyExit;
    notify.notifyStarted            = orig.notifyStarted;
    notify.notifySignal             = orig.notifySignal;
    notify.notifyDayReport          = orig.notifyDayReport;
    notify.sendTelegram             = orig.sendTelegram;
    notify.notifyAuthError          = orig.notifyAuthError;
    fyersAuthCheck.verifyFyersToken = orig.verifyFyersToken;
    nseHolidays.isTradingAllowed    = orig.isTradingAllowed;
    nseHolidays.isExpiryDay         = orig.isExpiryDay;
    Date.now                        = orig.DateNow;
    tickRecorder.recordSpotTick     = orig.tr_recordSpotTick;
    tickRecorder.recordOptionLtp    = orig.tr_recordOptionLtp;
    tickRecorder.recordOptionQuote  = orig.tr_recordOptionQuote;
    tickRecorder.recordVix          = orig.tr_recordVix;
    tickRecorder.recordOi           = orig.tr_recordOi;
    tickRecorder.recordSessionStart = orig.tr_recordSessionStart;
    tickRecorder.recordSessionStop  = orig.tr_recordSessionStop;
    skipLogger.appendSkipLog        = orig.sl_appendSkipLog;
    sharedSocketState.setActive         = orig.ss_setActive;
    sharedSocketState.clear             = orig.ss_clear;
    sharedSocketState.setBbRsiActive    = orig.ss_setBbRsiActive;
    sharedSocketState.clearBbRsi        = orig.ss_clearBbRsi;
    sharedSocketState.setPAActive       = orig.ss_setPAActive;
    sharedSocketState.clearPA           = orig.ss_clearPA;
    sharedSocketState.setOrbActive      = orig.ss_setOrbActive;
    sharedSocketState.clearOrb          = orig.ss_clearOrb;
    fs.writeFileSync = orig.fs_writeFileSync;
    fs.renameSync    = orig.fs_renameSync;
    // Clear any pass-through long-delay timers BEFORE restoring originals so
    // we use our tracked handles with the still-overridden clearTimeout.
    for (const h of _pendingLongTimers) {
      try { orig.clearTimeout_(h); } catch (_) {}
    }
    _pendingLongTimers.clear();
    global.setTimeout   = orig.setTimeout_;
    global.clearTimeout = orig.clearTimeout_;
    callbacks.length = 0;
  }

  function pumpTick(tick) {
    setNow(tick.t);
    // CRITICAL: also advance the wall clock to the tick's timestamp.
    // Strategy entry gates (`isMarketHours()` in emaRsiStPaper/paPaper/bbRsiPaper)
    // call `Date.now()` directly and reject every entry as "outside market
    // hours" when replay runs after-hours. Overriding Date.now() per tick
    // makes those gates see the recorded market-hours timestamp, so entries
    // fire exactly as they did live. Without this, replays produced 0 trades
    // for every strategy after-hours — breaking the BACKTEST = PAPER = LIVE
    // guarantee silently.
    setWallClock(tick.t);
    for (const cb of callbacks) {
      try { cb.onTick(tick); } catch (e) {
        // Eat errors — replay should continue. Log once per error message.
        const k = `__replay_err_${e.message}`;
        if (!pumpTick[k]) {
          console.warn(`[tickReplay] callback error: ${e.message}`);
          pumpTick[k] = true;
        }
      }
    }
  }

  return { install, uninstall, pumpTick, setNow, setWallClock, clearWallClock, getCallbacks: () => callbacks };
}

// ── Mode → route module mapping ─────────────────────────────────────────────
const MODE_TO_MODULE = {
  "pa-paper":       "../routes/paPaper",
  "bb_rsi-paper":    "../routes/bbRsiPaper",
  "ema_rsi_st-paper":    "../routes/emaRsiStPaper",
  "orb-paper":      "../routes/orbPaper",
  "ema9vwap-paper": "../routes/ema9vwapPaper",
  "trend-pb-paper": "../routes/trendPbPaper",
  // Live modes are NOT supported for replay (they place real orders). If a
  // live session was recorded, replay it as the matching paper mode.
};

// Helper: invoke a route's /start and /stop handlers programmatically.
// Express requires (req, res) — we pass mock objects.
function _invokeRoute(routeModule, method, urlPath, query = {}) {
  // routeModule is the express Router. We dive into its stack.
  return new Promise((resolve, reject) => {
    let resolved = false;
    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      resolve(payload);
    };
    const req = {
      method: method.toUpperCase(),
      url: urlPath,
      path: urlPath,
      query,
      headers: { host: "localhost" },
      get: () => undefined,
      app: { get: () => undefined, set: () => {} },
    };
    const res = {
      statusCode: 200,
      _headers: {},
      _body: null,
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this._headers[k] = v; return this; },
      setHeader(k, v) { this._headers[k] = v; return this; },
      json(b)  { this._body = b; finish({ status: this.statusCode, body: b }); return this; },
      send(b)  { this._body = b; finish({ status: this.statusCode, body: b }); return this; },
      redirect(url) { finish({ status: 302, redirect: url }); },
      end(b)   { finish({ status: this.statusCode, body: b }); return this; },
    };
    // Walk the router stack to find the matching route
    const stack = routeModule.stack || [];
    let idx = 0;
    function next(err) {
      if (err) return reject(err);
      if (idx >= stack.length) return finish({ status: 404, body: "no matching route" });
      const layer = stack[idx++];
      try {
        if (layer.route && layer.route.path === urlPath) {
          const methodHandler = layer.route.stack.find(s => s.method === method.toLowerCase());
          if (methodHandler) {
            const ret = methodHandler.handle(req, res, next);
            if (ret && typeof ret.catch === "function") ret.catch(next);
            return;
          }
        }
        next();
      } catch (e) { next(e); }
    }
    next();
  });
}

/**
 * Replay one recorded session end-to-end.
 *
 *   date                — "YYYY-MM-DD"
 *   mode                — pa-paper | bb_rsi-paper | ema_rsi_st-paper | orb-paper
 *   sessionId           — optional
 *   speed               — 0 = as fast as possible, >0 = ms delay between ticks
 *   useCurrentSettings  — false (default): apply the recorded session-start
 *                         settings snapshot → deterministic, identical result.
 *                         true: skip the snapshot override and run with whatever
 *                         is currently in process.env (the user's Settings page
 *                         values) → "simulator" mode for testing config changes
 *                         after market hours. Output is written to a separate
 *                         folder so sim runs are not mixed with snapshot runs.
 *                         NOTE: the option expiry is auto-pinned to the recorded
 *                         session (the recorded ticks only cover that day's
 *                         contract), so only the OTHER current settings apply.
 *                         Instrument/lot in current env should still match the
 *                         recorded session, or results will be nonsense.
 *
 * Returns:
 *   { ok, sessionId, mode, ticksReplayed, durationMs, sessionTrades, sessionPnl, error? }
 */
async function replaySession({ date, mode, sessionId, speed = 0, useCurrentSettings = false, noCache = false } = {}) {
  // Guard: replay shares the process with live/paper engines via monkey-patches.
  // Refuse if anything is active so a real trade isn't accidentally silenced.
  const pre = replayPreflight();
  if (!pre.ok) throw new Error(pre.reason);
  _replayInProgress = true;
  _cancelRequested = false;

  const startWall = Date.now();
  let restoreEnv  = () => {};
  let harness     = null;
  let routeMod    = null;

  try {
    if (!MODE_TO_MODULE[mode]) {
      throw new Error(`Unsupported replay mode: ${mode}. Supported: ${Object.keys(MODE_TO_MODULE).join(", ")}`);
    }

    // 1. Load recorded data (metadata + small streams). Spot ticks are NOT
    //    loaded — they're stream-iterated below to keep memory bounded.
    //    Crash-recovered sessions (no stop event) trigger a full spot.jsonl
    //    scan here to find the end bound — log so this isn't a silent gap that
    //    makes the Replay activity pane look frozen.
    console.log(`📼 [replay] ${mode} ${sessionId || date}: loading recorded session…`);
    const data = await loadSessionData({ date, mode, sessionId });

    // 1a. Resolve the historical option expiry ONCE — from the recorded Market
    //     Context Snapshot when available (both toggles), else the legacy pin.
    //     Used for the cache key AND the env applied below, so they never drift.
    // Expiry is historical for BOTH toggles — resolved from the recording, not
    // useCurrentSettings (current settings never change the option expiry).
    const expiryResolution = _resolveReplayExpiryEnv({
      marketContext: data.marketContext,
      snapshot: data.sessionStart.settings,
      mode,
    });
    if (!data.marketContext) {
      console.warn(`⚠️ [replay] ${mode} ${date}: no Market Context Snapshot (market.jsonl) — expiry falls back to legacy pin; old-day option contract may mismatch. Re-record to fix.`);
    } else {
      console.log(`📼 [replay] expiry pinned from market context: ${expiryResolution.date || "(auto)"} (${expiryResolution.type}, ${expiryResolution.source})`);
    }

    // 1b. Result cache: an identical re-run is deterministic, so short-circuit
    //     the ~80s tick stream if this exact (mode, date, session, settings,
    //     recorded-ticks) combination was computed before. Checked here — after
    //     loadSessionData resolves the session + settings, before any env
    //     override or harness install — so an early return needs no cleanup.
    const cacheKey = _buildReplayCacheKey({
      mode, date, sessionStart: data.sessionStart, useCurrentSettings,
      expiryEnv: expiryResolution.env,
    });
    if (!noCache) {
      const hit = _readReplayCache(cacheKey);
      if (hit && hit.ok) {
        console.log(`⚡ [replay] ${mode} ${data.sessionStart.sid}: cache hit — skipping tick stream`);
        return { ...hit, cached: true, durationMs: Date.now() - startWall };
      }
    }

    const optionTimeline = _buildOptionTimeline(data.optionTicks);
    const vixTimeline    = data.vixTicks.map(v => ({ t: v.t, l: v.v })); // unify field name
    const oiTimeline     = (data.oiTicks || []).map(o => ({ t: o.t, oi: o.oi }));

    // Reproducibility guard (snapshot mode only): warn — don't fail — when a
    // live-data gate was active for the recorded session but its data was never
    // captured. Such a session can't replay deterministically for that gate
    // (true for everything recorded before OI/bid-ask capture shipped), so a
    // divergent delta is a recording hole, not a strategy result. Surfaces in /logs.
    if (!useCurrentSettings) {
      const _snap = data.sessionStart.settings || {};
      const _warn = [];
      if (_snap.OI_FILTER_ENABLED === "true" && oiTimeline.length === 0) {
        _warn.push("OI filter was ON but no OI recorded — OI gate fails open in replay");
      }
      if (data.optionTicks.length > 0 && !data.optionTicks.some(o => o.b != null || o.a != null)) {
        _warn.push("no recorded option bid/ask — spread guard fails open in replay");
      }
      if (_warn.length) {
        console.warn(`⚠️ [replay] ${data.sessionStart.mode} ${data.sessionStart.sid}: snapshot not fully reproducible — ${_warn.join("; ")}`);
      }
    }

    // 2. Apply settings override from session-start snapshot.
    //    Skipped in simulator mode so the run uses current process.env
    //    (the user's Settings page values) — that's the whole point of
    //    useCurrentSettings: "what would TODAY's settings have done against
    //    these ticks?".
    if (!useCurrentSettings) {
      // Confirmation-candle reproducibility: sessions recorded BEFORE the
      // confirmation feature existed have no *_CONFIRM_CANDLE_ENABLED key in
      // their snapshot. The toggle defaults ON, so without this those old
      // recordings would replay WITH confirmation and diverge from the entries
      // they actually took. Force the toggle OFF for any confirmation key the
      // snapshot doesn't pin, so pre-feature recordings reproduce exactly.
      const _snapSettings = Object.assign({}, data.sessionStart.settings || {});
      for (const _k of ["EMA_RSI_ST_CONFIRM_CANDLE_ENABLED", "BB_RSI_CONFIRM_CANDLE_ENABLED"]) {
        if (!(_k in _snapSettings)) _snapSettings[_k] = "false";
      }
      // Overlay the resolved historical expiry LAST so it wins over the snapshot's
      // own (possibly blank/auto-detected) expiry keys.
      Object.assign(_snapSettings, expiryResolution.env);
      restoreEnv = _applySettingsOverride(_snapSettings);
      console.log(`📼 [replay] confirmation candle (snapshot): EMA_RSI_ST=${process.env.EMA_RSI_ST_CONFIRM_CANDLE_ENABLED} BB_RSI=${process.env.BB_RSI_CONFIRM_CANDLE_ENABLED}`);
    } else {
      // Simulator mode honors current settings for everything EXCEPT the option
      // expiry — that's pinned to the recorded day's Market Context Snapshot so an
      // old day resolves its own contract instead of today's (see
      // _resolveReplayExpiryEnv). Current settings can never change the expiry date.
      restoreEnv = _applySettingsOverride(expiryResolution.env);
      console.log(`📼 [replay] confirmation candle (current settings): EMA_RSI_ST=${process.env.EMA_RSI_ST_CONFIRM_CANDLE_ENABLED||'true'} BB_RSI=${process.env.BB_RSI_CONFIRM_CANDLE_ENABLED||'true'}`);
    }

    // 3. Install harness (monkey-patch deps) with recorded warmup so paper's
    //    own preloadHistory returns the snapshot ticks instead of hitting the
    //    real Fyers REST. Output dir differs by mode so simulator runs don't
    //    get mixed with deterministic snapshot runs.
    const warmupCandles = data.sessionStart.warmup || [];
    harness = _createHarness({
      optionTimeline, vixTimeline, oiTimeline, warmupCandles,
      recordedDateStr: date,
      outputSubdir: useCurrentSettings ? "_replay_trades_sim" : "_replay_trades",
      outputSuffix: useCurrentSettings ? "sim" : "replay",
    });
    harness.install();

    // 4. Load the route module AFTER patches are installed so module-level
    //    state is fresh (Node caches require results — we clear cache for the
    //    route module so its `let state = {...}` reinitialises).
    const routePath = require.resolve(MODE_TO_MODULE[mode]);
    delete require.cache[routePath];
    routeMod = require(MODE_TO_MODULE[mode]);

    // 5. Set replay clock to session start, then call /start handler.
    //    Paper's /start runs unchanged: it'll preload candles (intercepted →
    //    recorded warmup), kick off VIX (intercepted → recorded VIX), and
    //    register the tick callback (intercepted → captured by harness).
    //    Wall-clock is overridden during /start so isStartAllowed() sees the
    //    recorded session-start IST time as "now", which always passes.
    harness.setNow(data.sessionStart.t);
    harness.setWallClock(data.sessionStart.t);
    let startResp;
    try {
      // force=1 bypasses the EMA_RSI_ST 0DTE expiry-day refusal — that's a LIVE-trading
      // safety gate (don't open a same-day-expiry EMA_RSI_ST). A historical replay must not
      // be aborted by it (e.g. replaying an expiry-day session, or with an expiry
      // override equal to the replay date). Other modes ignore the flag.
      startResp = await _invokeRoute(routeMod, "GET", "/start", { force: "1" });
    } finally {
      harness.clearWallClock();
    }
    if (startResp.status >= 400 && startResp.status !== 302) {
      throw new Error(`Route /start returned ${startResp.status}: ${JSON.stringify(startResp.body).slice(0, 200)}`);
    }

    // 6. Stream spot ticks line-by-line and pump through the captured
    //    callback in recorded order. Each tick advances the replay clock so
    //    the LTP/VIX getQuotes stub serves the value that was current then.
    //
    //    EC2 t3.micro guards:
    //      - line-by-line streaming → never materialises the full file
    //      - yield to event loop every YIELD_EVERY ticks → keeps HTTP responsive
    //      - GC every GC_EVERY ticks (if --expose-gc) → bounds heap growth
    //
    //    YIELD_EVERY=1 is critical for correct exit P&L: paper's option-LTP
    //    polling is a setTimeout chain. With short-delay collapse to 0ms,
    //    each poll fires once per outer yield. With YIELD_EVERY=200, a
    //    short trade (12-15 spot ticks over 60s) may see ZERO polls fire
    //    between entry and exit — state.optionLtp stays frozen at the
    //    entry value, simulateSell reads that stale value, and exit P&L
    //    collapses to -charges. Yielding per-tick keeps polling fresh so
    //    exit P&L matches live. Cost: ~50μs per yield × ~55k ticks = a
    //    few extra seconds of wall time per session — acceptable.
    //
    //    Yield mechanism uses setTimeout(0) rather than setImmediate:
    //    setImmediate resolves in the check phase which runs AFTER the
    //    timers phase, so a pending setTimeout(0) from paper's polling
    //    chain may sit in the timer queue for several iterations before
    //    firing. setTimeout(0) yield resolves in the timers phase
    //    alongside paper's pending poll timer, guaranteeing it fires
    //    before the next tick is pumped. Without this, state.optionLtp
    //    can freeze for 20+ seconds mid-trade in a long position.
    const YIELD_EVERY = 1;
    const GC_EVERY    = 2000;
    // Heartbeat: an EMA_RSI_ST day is tens of thousands of ticks and, while flat,
    // the paper engine logs nothing for minutes — making the Replay activity
    // pane look stopped. Emit a progress line every HEARTBEAT_EVERY ticks so
    // the run always shows it's alive (additive logging — no effect on result).
    const HEARTBEAT_EVERY = 5000;
    const _istHHMM = (t) => new Date(t).toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    console.log(`📼 [replay] ${mode} ${data.sessionStart.sid}: streaming spot ticks (${data.optionTicks.length} option ticks loaded)…`);
    // setTimeout(r, 0) goes through the harness override and falls through
    // unchanged to orig.setTimeout_(r, 0) (0 is not > SHORT_DELAY_CAP_MS),
    // so this resolves in the timers phase alongside paper's queued polls.
    const _yield      = () => new Promise(r => setTimeout(r, 0));
    let ticksReplayed = 0;
    const startT = data.sessionStart.t;
    const stopT  = data.sessionStop.t;

    let cancelled = false;
    const spotStream = fs.createReadStream(data.spotPath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: spotStream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        // Mid-session cancel: stop pumping ticks and fall through to /stop,
        // which squares off any open position so the run finalises cleanly.
        if (_cancelRequested) { cancelled = true; break; }
        const trimmed = line.trim();
        if (!trimmed) continue;
        let tick;
        try { tick = JSON.parse(trimmed); } catch (_) { continue; }
        if (tick.t < startT || tick.t > stopT) continue;

        harness.pumpTick(tick);
        ticksReplayed++;

        if (ticksReplayed % HEARTBEAT_EVERY === 0) {
          console.log(`📼 [replay] ${mode}: pumped ${ticksReplayed} ticks · sim clock ${_istHHMM(tick.t)} IST`);
        }

        if (speed > 0) await new Promise(r => setTimeout(r, speed));
        else if (ticksReplayed % YIELD_EVERY === 0) await _yield();
        if (global.gc && ticksReplayed % GC_EVERY === 0) global.gc();
      }
    } finally {
      rl.close();
      spotStream.destroy();
    }

    // 7. Call /stop — squares off any open position via paper's own
    //    simulateSell, finalises the session. Wall clock is pinned to the
    //    recorded session-stop time so any time-based logic inside /stop
    //    (exit timestamps, end-of-day flags) records the right moment.
    harness.setNow(data.sessionStop.t);
    harness.setWallClock(data.sessionStop.t);
    let stopResp;
    try {
      stopResp = await _invokeRoute(routeMod, "GET", "/stop");
    } finally {
      harness.clearWallClock();
    }

    // 8. Read final results from the route's status endpoint. Each paper
    //    mode exposes /status/data returning { trades, sessionPnl, ... }.
    //    Calling this is a normal GET against a paper-defined endpoint —
    //    no internals exposed.
    const statusResp = await _invokeRoute(routeMod, "GET", "/status/data");
    let sessionTrades = [];
    let sessionPnl    = 0;
    let tradeCount    = 0;
    if (statusResp && statusResp.body) {
      // /status/data trade field differs by mode:
      //   pa/bb_rsi/ema_rsi_st → trades
      //   orb            → sessionTrades
      sessionTrades = statusResp.body.trades || statusResp.body.sessionTrades || [];
      sessionPnl    = statusResp.body.sessionPnl != null ? statusResp.body.sessionPnl : 0;
      tradeCount    = statusResp.body.tradeCount != null ? statusResp.body.tradeCount : sessionTrades.length;
    }
    // Fallback for /stop response shape (emaRsiStPaper returns session in body)
    if ((!sessionTrades || sessionTrades.length === 0) && stopResp && stopResp.body && stopResp.body.session) {
      const sess = stopResp.body.session;
      sessionTrades = sess.trades || sess.sessionTrades || sessionTrades;
      sessionPnl    = sess.totalPnl != null ? sess.totalPnl : (sess.pnl != null ? sess.pnl : sessionPnl);
      tradeCount    = sessionTrades.length;
    }

    // Attach the recorded option-tick window between entry and exit for each
    // trade. Surfaces every recorded LTP that flowed during the trade so we
    // can verify replay's exit-LTP picks against the raw recording (e.g.,
    // spot the spike that drove an unrealistic exit P&L).
    //
    // Trade-record timing fields differ across paper modes:
    //   bb_rsi/PA: entryTimeMs + exitTimeMs (real wall-clock ms — best)
    //   ema_rsi_st:    entry/exit (formatted IST strings) + entryBarTime/exitBarTime
    //             (bar-bucket start in sec) + durationMs (may be null on intra-bar exits)
    //
    // We need the ACTUAL exit ms, not the bar-bucket start — a trade that
    // entered at 10:56:33 and exited at 11:01:25 has exitBarTime = 11:00:00,
    // 1m25s before the real exit. Parsing the IST string covers that.
    const _parseIstStr = (s) => {
      // "DD/MM/YYYY, HH:MM:SS" → epoch ms (interpreted as IST = UTC+5:30)
      if (typeof s !== "string") return null;
      const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/);
      if (!m) return null;
      const [, dd, mm, yyyy, HH, MM, SS] = m;
      return Date.UTC(+yyyy, +mm - 1, +dd, +HH, +MM, +SS) - 5.5 * 3600 * 1000;
    };
    for (const t of sessionTrades) {
      if (!t.symbol) continue;
      const arr = optionTimeline.get(t.symbol);
      if (!arr || arr.length === 0) { t._replayOptionWindow = []; continue; }
      const eMs = t.entryTimeMs
        || _parseIstStr(t.entry)
        || (t.entryBarTime ? t.entryBarTime * 1000 : null);
      const xMs = t.exitTimeMs
        || _parseIstStr(t.exit)
        || (eMs && t.durationMs ? eMs + t.durationMs : null)
        || (t.exitBarTime ? t.exitBarTime * 1000 : null);
      if (!eMs || !xMs) { t._replayOptionWindow = []; continue; }
      // Include 2-sec pre-entry and 2-sec post-exit for context
      const lo = eMs - 2000, hi = xMs + 2000;
      t._replayOptionWindow = arr
        .filter(r => r.t >= lo && r.t <= hi)
        .map(r => ({ t: r.t, ms: r.t - eMs, l: r.l }));
    }

    // 8b. Harvest the route's chart-data (candles + entry/exit markers +
    //     per-mode overlays) so the Replay UI can draw the same candlestick
    //     chart the paper screen does. The route's in-memory state (candles,
    //     sessionTrades, position) survives /stop, so this is the replay's
    //     own bars — no disk/broker re-fetch. Each paper mode exposes the
    //     same /status/chart-data contract: { candles, markers, ...overlays }.
    let chartData = null;
    try {
      const chartResp = await _invokeRoute(routeMod, "GET", "/status/chart-data");
      if (chartResp && chartResp.status < 400 && chartResp.body && Array.isArray(chartResp.body.candles)) {
        chartData = chartResp.body;
      }
    } catch (_) { /* chart is best-effort; never fail a replay over it */ }

    const canonical = _lookupCanonicalSession(mode, data.sessionStart.t);
    const result = {
      ok: true,
      cancelled,  // true if stopped early via requestCancel() mid-session
      mode,
      date,       // recorded session date (IST, YYYY-MM-DD) — lets the cache-file browser label hash-named caches
      sessionId: data.sessionStart.sid,
      ticksReplayed,
      durationMs: Date.now() - startWall,
      tradeCount,
      sessionTrades,
      sessionPnl,
      chartData,  // { candles, markers, ...mode overlays } or null if unavailable
      canonical,  // { pnl, tradeCount, matchedAt, matchSkewMs } or null if no match
    };
    // Cache only complete (non-cancelled) results so a future identical re-run
    // short-circuits. Cancelled runs are partial — never cache.
    if (!cancelled) _writeReplayCache(cacheKey, result);
    return result;
  } catch (err) {
    return {
      ok: false,
      mode,
      sessionId: sessionId || null,
      error: err.message,
      durationMs: Date.now() - startWall,
    };
  } finally {
    try { harness && harness.uninstall(); } catch (_) {}
    try { restoreEnv(); } catch (_) {}
    // Defensive: if a paper /start ran before the harness fully installed
    // its sharedSocketState stubs (or any later cleanup failed), real state
    // could still be left "active". Force-clear so the preflight banner
    // never gets stuck. Cheap, idempotent — only clears in-memory flags.
    try { forceClearSharedState(); } catch (_) {}
    // Drop the route module from the cache so the live-trading process can
    // re-require it cleanly without our patched state.
    if (routeMod) {
      try { delete require.cache[require.resolve(MODE_TO_MODULE[mode])]; } catch (_) {}
    }
    _replayInProgress = false;
  }
}

/**
 * List recorded sessions for a given date (or all available dates if none given).
 */
// PA/BB_RSI/EMA_RSI_ST paper have always recorded option LTPs at the poll site.
// ORB paper only started doing so after the option-LTP recording
// fix landed — their session-start meta now includes `recordsOptionLtps:true`.
// Sessions for these modes that lack the flag in meta cannot reproduce
// trades on replay, so the UI marks them as incomplete and disables Replay.
const LEGACY_ALWAYS_RECORDED_MODES = new Set(["pa-paper", "bb_rsi-paper", "ema_rsi_st-paper", "ema9vwap-paper", "trend-pb-paper"]);

function _sessionIsReplayable(startEvt) {
  if (!startEvt || !startEvt.mode) return false;
  if (LEGACY_ALWAYS_RECORDED_MODES.has(startEvt.mode)) return true;
  return !!(startEvt.meta && startEvt.meta.recordsOptionLtps);
}

function listRecordings(date) {
  const out = { dates: [], sessions: [] };
  if (!fs.existsSync(ROOT_DIR)) return out;

  const dates = date ? [date] : fs.readdirSync(ROOT_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  out.dates = dates;

  for (const d of dates) {
    const sFile = path.join(ROOT_DIR, d, "sessions.jsonl");
    if (!fs.existsSync(sFile)) continue;
    const events = _readJsonl(sFile);
    const starts = events.filter(e => e.e === "start");
    for (const s of starts) {
      const stop = events.find(e => e.e === "stop" && e.sid === s.sid);
      out.sessions.push({
        date:      d,
        mode:      s.mode,
        sessionId: s.sid,
        startTs:   s.t,
        stopTs:    stop ? stop.t : null,
        durationMs: stop ? (stop.t - s.t) : null,
        warmupCandles: s.warmup ? s.warmup.length : 0,
        replayable: _sessionIsReplayable(s),
      });
    }
  }
  return out;
}

/**
 * Pre-flight check the UI calls before letting the user click Replay.
 *
 * Replay monkey-patches shared modules (tradeLogger, notify, broker funcs)
 * for the duration of the run. If a live or paper session is active in this
 * same Node process at that moment, the patches would briefly affect IT too
 * — a real trade fired during the replay window could be silenced or written
 * to the replay folder. The mitigation is simple: don't allow replays while
 * any strategy is active. After-hours, this is a non-issue.
 *
 * Returns { ok: true } if safe, or { ok: false, reason, activeModes } if not.
 */
function replayPreflight() {
  const sharedSocketState = require("../utils/sharedSocketState");
  const activeModes = [];
  if (sharedSocketState.isActive())          activeModes.push(sharedSocketState.getMode() || "ema_rsi_st");
  if (sharedSocketState.isBbRsiActive())     activeModes.push(sharedSocketState.getBbRsiMode() || "bb_rsi");
  if (sharedSocketState.isPAActive())        activeModes.push(sharedSocketState.getPAMode() || "pa");
  if (sharedSocketState.isOrbActive())       activeModes.push(sharedSocketState.getOrbMode() || "orb");
  if (activeModes.length > 0) {
    return {
      ok: false,
      reason: `Cannot replay while these are running: ${activeModes.join(", ")}. Stop them first.`,
      activeModes,
    };
  }
  if (_replayInProgress) {
    return { ok: false, reason: "Another replay is already running in this process.", activeModes: ["__replay__"] };
  }
  return { ok: true };
}

/**
 * Recovery path: forcibly clear sharedSocketState for every strategy.
 *
 * The replay harness now stubs sharedSocketState mutators so replays can no
 * longer leak state. But before that fix, a replay could leave the real
 * state stuck "active" — making the preflight banner permanently block all
 * future replays even though no strategy is actually running. This export
 * (exposed at POST /replay/force-clear) unsticks that scenario.
 *
 * Safe to call any time: it only clears in-memory mutex flags, never touches
 * trade logs or position files.
 *
 * Also resets `_replayInProgress` — the flag behind the "Another replay is
 * already running in this process" preflight block. When a replay run is killed
 * mid-flight (e.g. a deploy/PM2 reload before the finally{} resets it), that
 * flag stays stuck true with no run actually executing, permanently blocking
 * new replays. This is the only in-process way to unstick it short of a restart.
 */
function forceClearSharedState() {
  const sharedSocketState = require("../utils/sharedSocketState");
  const before = {
    ema_rsi_st:    sharedSocketState.getMode(),
    bb_rsi:    sharedSocketState.getBbRsiMode(),
    pa:       sharedSocketState.getPAMode(),
    orb:      sharedSocketState.getOrbMode(),
    replayInProgress: _replayInProgress,
  };
  sharedSocketState.clear();
  sharedSocketState.clearBbRsi();
  sharedSocketState.clearPA();
  sharedSocketState.clearOrb();
  _replayInProgress = false;
  return { ok: true, cleared: before };
}

/**
 * Remove a session's start+stop markers from sessions.jsonl for the given day.
 * The raw spot/options/vix tick files are LEFT INTACT (they're shared with
 * other sessions on the same day) — only the session-discovery markers go
 * away, so the session disappears from listRecordings().
 *
 * Returns { ok, removed } where `removed` is the count of marker lines
 * filtered out (typically 2 = one start + one stop; may be 1 if the session
 * was crash-recovered without a stop event).
 */
function deleteSessionMarker({ date, sessionId }) {
  if (!date || !sessionId) {
    return { ok: false, error: "date and sessionId are required" };
  }
  const dir  = path.join(ROOT_DIR, date);
  const file = path.join(dir, "sessions.jsonl");
  if (!fs.existsSync(file)) {
    return { ok: false, error: `No sessions.jsonl for ${date}` };
  }
  const events = _readJsonl(file);
  const kept   = events.filter(e => e.sid !== sessionId);
  const removed = events.length - kept.length;
  if (removed === 0) {
    return { ok: false, error: `Session ${sessionId} not found in ${date}` };
  }
  // Atomic rewrite via tmp + rename
  const tmp = file + ".tmp";
  const text = kept.map(e => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : "");
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return { ok: true, removed };
}

module.exports = {
  loadSessionData,
  listRecordings,
  replaySession,
  replayPreflight,
  requestCancel,
  forceClearSharedState,
  deleteSessionMarker,
  // exposed for tests
  _internals: { _buildOptionTimeline, _lookupAtOrBefore, _createHarness, _invokeRoute, MODE_TO_MODULE },
};

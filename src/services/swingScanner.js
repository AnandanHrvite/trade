/**
 * swingScanner.js — the Swing Scanner engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs one active strategy's signal core across a stock universe on ONE
 * timeframe, and returns a ranked list of candidates. Read-only: it fetches
 * candles, evaluates, and scores. Order placement lives in the route.
 *
 * SHAPE OF A SCAN
 * ───────────────
 *   1. FETCH (concurrent, I/O-bound) — one history call per symbol, plus one
 *      daily call when the strategy needs previous-day pivots. Disk-cached.
 *   2. EVALUATE (sequential, CPU-bound, synchronous) — every symbol through the
 *      strategy's own getSignal via swingStrategyAdapters. Sequential on
 *      purpose: the adapters rescale point-based thresholds by mutating
 *      process.env around each synchronous call, which is only safe because
 *      nothing else runs in between. See that file's header.
 *   3. SCORE + RANK.
 *
 * Long-running, so it is a JOB: start it, poll it. A full F&O scan is ~230
 * history calls and takes a minute or two; a request/response would time out in
 * the proxy and leave the user with a blank page and no way to tell whether it
 * was still working.
 *
 * TIMEFRAMES
 * ──────────
 * 5m / 15m / 30m / 1h come straight from Fyers at that resolution. The other
 * two are AGGREGATED here rather than requested:
 *
 *   4h  ← built from 1h bars, grouped in fours FROM EACH DAY'S SESSION OPEN.
 *         NSE trades 09:15–15:30 = 6h15m, which is not a whole number of 4h
 *         bars, so "4h" is a convention, not a fact. Anchoring at the session
 *         open gives 09:15–13:15 and a short 13:15–15:30 tail — the same bars a
 *         chart draws. Asking Fyers for "240" would hand back whatever anchor it
 *         happens to use, and it would not be visibly wrong, just quietly
 *         different from the chart the user is comparing against.
 *   1w  ← built from daily bars, grouped Monday→Friday. A week with a holiday
 *         is still one bar; a week still in progress is DROPPED, because a
 *         half-formed weekly bar makes indicators flip and un-flip mid-week.
 *
 * WHY THE FETCH IS LOCAL AND NOT backtestEngine.fetchCandles
 * ─────────────────────────────────────────────────────────
 * Same chunking, same session filter, same dedupe — but silent. That function
 * logs a line per chunk and a line per symbol, and console.log in this repo is
 * piped to the /logs SSE stream. A 230-symbol scan would push ~700 lines into
 * the live log every time someone pressed Search, burying everything a running
 * strategy is saying. This one logs once per scan, plus failures.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const fyers        = require("../config/fyers");
const { fyersErrText } = require("../utils/fyersErr");
const universe     = require("../utils/stockUniverse");
const adapters     = require("./swingStrategyAdapters");

const CACHE_DIR = path.join(os.homedir(), "trading-data", "swing_scanner_cache");

// ─────────────────────────────────────────────────────────────────────────────
// Timeframes
// ─────────────────────────────────────────────────────────────────────────────

const TIMEFRAMES = {
  "5":   { key: "5",   label: "5 min",  minutes: 5,   fyersRes: "5",  aggregate: null, lookbackDays: 20  },
  "15":  { key: "15",  label: "15 min", minutes: 15,  fyersRes: "15", aggregate: null, lookbackDays: 45  },
  "30":  { key: "30",  label: "30 min", minutes: 30,  fyersRes: "30", aggregate: null, lookbackDays: 60  },
  "60":  { key: "60",  label: "1 hour", minutes: 60,  fyersRes: "60", aggregate: null, lookbackDays: 90  },
  "240": { key: "240", label: "4 hour", minutes: 240, fyersRes: "60", aggregate: "4H", lookbackDays: 150 },
  "W":   { key: "W",   label: "1 week", minutes: null, fyersRes: "D", aggregate: "W",  lookbackDays: 730 },
};
const TIMEFRAME_ORDER = ["5", "15", "30", "60", "240", "W"];

/** Hand each getSignal at most this many bars — beyond it, indicators do not move. */
const MAX_BARS = 400;

const MKT_OPEN_MIN  = 9 * 60 + 15;
const MKT_CLOSE_MIN = 15 * 60 + 30;

function getTimeframe(key) { return TIMEFRAMES[String(key)] || null; }
function listTimeframes()  { return TIMEFRAME_ORDER.map(k => TIMEFRAMES[k]); }

// ─────────────────────────────────────────────────────────────────────────────
// IST helpers — plain arithmetic on the +5:30 offset, no ICU, no TZ env reliance
// ─────────────────────────────────────────────────────────────────────────────

const IST_OFFSET_SEC = 19800;

/** Minutes past IST midnight for a unix-second timestamp. */
function istMinutes(unixSec) {
  return Math.floor((unixSec + IST_OFFSET_SEC) / 60) % 1440;
}
/** Whole IST days since epoch — a stable per-day key. */
function istDayKey(unixSec) {
  return Math.floor((unixSec + IST_OFFSET_SEC) / 86400);
}
/** "YYYY-MM-DD" in IST. */
function istDateStr(unixSec) {
  const d = new Date((unixSec + IST_OFFSET_SEC) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
/** IST weekday, 0=Sunday … 6=Saturday. Epoch day 0 was a Thursday. */
function istWeekday(unixSec) {
  return (istDayKey(unixSec) + 4) % 7;
}
function todayIST() {
  return istDateStr(Math.floor(Date.now() / 1000));
}
function daysAgoIST(n) {
  return istDateStr(Math.floor(Date.now() / 1000) - n * 86400);
}

/** True during NSE equity hours on a weekday (holidays handled by the caller). */
function withinMarketHours(nowSec = Math.floor(Date.now() / 1000)) {
  const wd = istWeekday(nowSec);
  if (wd === 0 || wd === 6) return false;
  const m = istMinutes(nowSec);
  return m >= MKT_OPEN_MIN && m < MKT_CLOSE_MIN;
}

// ─────────────────────────────────────────────────────────────────────────────
// History fetch
// ─────────────────────────────────────────────────────────────────────────────

// Swappable so the regression suite can drive the whole engine off fixtures
// without a Fyers token. Production never calls the setter.
let _historyFn = (params) => fyers.getHistory(params);
let _historyStubbed = false;
function _setHistoryFn(fn) { _historyFn = fn; _historyStubbed = true; }
function _resetHistoryFn()  { _historyFn = (params) => fyers.getHistory(params); _historyStubbed = false; }

/** Fyers caps a single history request by resolution. Mirrors backtestEngine. */
function maxDaysForResolution(resolution) {
  if (["D", "W", "M"].includes(String(resolution))) return 366;
  if (["1", "2", "3"].includes(String(resolution))) return 30;
  return 100;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Fyers meters the history API per app on TWO windows — about 10 requests a
// second and about 200 a minute — and a scan is one request per symbol, two when
// the strategy also needs daily bars. The per-minute ceiling is the one a wide
// universe hits: 228 F&O symbols went out in 0.7s with four workers pulling flat
// out, Fyers answered most of them with "request limit reached", and every
// rejected symbol was dropped for the run — 183 of 228 missing from the result,
// each one indistinguishable in the skip list from a genuinely delisted stock.
//
// Both windows are enforced here, in front of every history call, so the pacing
// holds however many workers SWING_SCANNER_CONCURRENCY starts. Deliberately
// bursty rather than a flat drip: a 50-symbol scan still clears in a few seconds
// on the per-second bucket, and only a universe big enough to threaten the
// minute cap ever waits.
function rateLimits() {
  // Read literally, not through a process.env[key] helper: docs/ENV.md is
  // generated by scanning for spelled-out env reads, and a computed lookup is
  // invisible to it — the key would ship undocumented and untested.
  const rps = parseInt(process.env.SWING_SCANNER_RPS || "8",   10);
  const rpm = parseInt(process.env.SWING_SCANNER_RPM || "180", 10);
  return {
    rps: Number.isFinite(rps) && rps >= 1 ? Math.min(rps, 50)   : 8,
    rpm: Number.isFinite(rpm) && rpm >= 1 ? Math.min(rpm, 2000) : 180,
  };
}

const _reqLog = [];               // ms stamps of issued history calls, oldest first
let   _gate   = Promise.resolve();

/**
 * Resolve once one more history request fits inside both windows, having booked
 * the slot for it. Serialised through `_gate`, because workers that each read the
 * log independently all conclude there is room and all go at once — the exact
 * burst this exists to prevent.
 */
function acquireSlot() {
  if (_historyStubbed) return Promise.resolve();   // fixtures need no protecting
  const booked = _gate.then(async () => {
    const { rps, rpm } = rateLimits();
    for (;;) {
      const now = Date.now();
      while (_reqLog.length && now - _reqLog[0] >= 60_000) _reqLog.shift();
      // The log is ascending, so the Nth-newest call is at length - N. Once that
      // one has aged out of a window, fewer than N remain inside it.
      let wait = 0;
      if (_reqLog.length >= rps) wait = Math.max(wait, _reqLog[_reqLog.length - rps] + 1000   - now);
      if (_reqLog.length >= rpm) wait = Math.max(wait, _reqLog[_reqLog.length - rpm] + 60_000 - now);
      if (wait <= 0) { _reqLog.push(now); return; }
      await sleep(wait);
    }
  });
  // Advance the gate even if a booking throws — otherwise one failure parks every
  // worker queued behind it forever.
  _gate = booked.catch(() => {});
  return booked;
}

/** Forget the issued-request history. Regression suite only. */
function _resetRateLimiter() { _reqLog.length = 0; _gate = Promise.resolve(); }

/**
 * Worth asking again. A history read is idempotent, so a retry can only cost
 * time. Rate limits are the common case; the transport failures beside them are
 * what a burst of a few hundred requests also produces.
 */
const RETRYABLE = /(request limit|rate ?limit|too many requests|\b429\b|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up)/i;
function retryDelays() { return _historyStubbed ? [0, 0, 0] : [1200, 3000, 7000]; }

/** Classify one raw history response into candles, empty, or a thrown error. */
function parseHistory(res) {
  // ORDER MATTERS. An error response carries no `candles` key, so an
  // emptiness check placed first would swallow it and report the symbol as
  // "no data" — which reads as "delisted". The failure that actually happens
  // is an expired Fyers token, and it fails EVERY symbol at once: 230 rows all
  // claiming to be delisted, and nothing pointing at the login. Classify the
  // error first so the message names the real cause.
  if (res && res.s === "error") throw new Error(fyersErrText(res));
  if (!res || res.s === "no_data") return [];
  if (!res.candles || !res.candles.length) return [];
  if (res.s !== "ok") throw new Error(fyersErrText(res));
  return res.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
}

async function fetchChunk(fyersSym, resolution, from, to) {
  const params = {
    symbol: fyersSym, resolution: String(resolution), date_format: "1",
    range_from: from, range_to: to, cont_flag: "1",
  };
  const delays = retryDelays();
  for (let attempt = 0; ; attempt++) {
    await acquireSlot();
    try {
      return parseHistory(await _historyFn(params));
    } catch (err) {
      // On an HTTP failure the SDK REJECTS with Fyers' raw body — a plain object,
      // not an Error — so `err.message` is undefined and String(err) collapses to
      // "[object Object]". That is literally what the page showed the day a wide
      // scan was rate-limited: "183 of 228 symbols failed the same way —
      // [object Object]". Convert here, at the one place that knows the shape.
      const e = err instanceof Error ? err : new Error(fyersErrText(err));
      if (attempt >= delays.length || !RETRYABLE.test(e.message)) throw e;
      await sleep(delays[attempt]);
    }
  }
}

/**
 * Contiguous chunked fetch, deduped and sorted. Intraday output is filtered to
 * the regular session (09:15 ≤ IST < 15:30) — the pre-open auction bar is a wild
 * wide-range print that corrupts every path-dependent indicator downstream.
 * Daily bars are stamped 00:00 IST and are never filtered.
 */
async function fetchSeries(fyersSym, resolution, fromDate, toDate) {
  const maxDays = maxDaysForResolution(resolution);
  const seen = new Set();
  const out  = [];
  const end  = new Date(Math.min(new Date(toDate).getTime(), new Date(todayIST()).getTime()));
  let cursor = new Date(fromDate);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    const candles = await fetchChunk(
      fyersSym, resolution,
      cursor.toISOString().split("T")[0], chunkEnd.toISOString().split("T")[0],
    );
    for (const c of candles) {
      if (!seen.has(c.time)) { seen.add(c.time); out.push(c); }
    }
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  out.sort((a, b) => a.time - b.time);
  const intraday = /^\d+$/.test(String(resolution));
  if (!intraday) return out;
  return out.filter(c => { const m = istMinutes(c.time); return m >= MKT_OPEN_MIN && m < MKT_CLOSE_MIN; });
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────────────

function mergeBars(bars) {
  const first = bars[0];
  let high = first.high, low = first.low, vol = 0;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low  < low)  low  = b.low;
    vol += (b.volume || 0);
  }
  return { time: first.time, open: first.open, high, low, close: bars[bars.length - 1].close, volume: vol };
}

/**
 * 1h → 4h, grouped in fours from each day's FIRST bar. The day's leftover tail
 * (NSE gives 7 hourly bars, so bars 5–7) becomes its own short bar, which is
 * what a chart shows. Groups never span a day boundary.
 */
function aggregateTo4H(hourly) {
  const out = [];
  let day = null, bucket = [];
  const flush = () => { if (bucket.length) { out.push(mergeBars(bucket)); bucket = []; } };
  for (const c of hourly) {
    const k = istDayKey(c.time);
    if (k !== day) { flush(); day = k; }
    bucket.push(c);
    if (bucket.length === 4) flush();
  }
  flush();
  return out;
}

/**
 * Daily → weekly, Monday-anchored. The CURRENT (still forming) week is dropped:
 * a partial weekly bar moves every indicator built on it, so a scan run on
 * Wednesday would disagree with the same scan run on Friday for reasons that
 * have nothing to do with the setup.
 */
function aggregateToWeekly(daily, nowSec = Math.floor(Date.now() / 1000)) {
  const out = [];
  let weekId = null, bucket = [];
  // Monday-anchored week id: epoch day 0 = Thursday, so shift by 3 to land Monday at 0.
  const weekOf = (t) => Math.floor((istDayKey(t) + 3) / 7);
  const flush = () => { if (bucket.length) { out.push({ weekId, bar: mergeBars(bucket) }); bucket = []; } };
  for (const c of daily) {
    const w = weekOf(c.time);
    if (w !== weekId) { flush(); weekId = w; }
    bucket.push(c);
  }
  flush();
  const currentWeek = weekOf(nowSec);
  return out.filter(x => x.weekId < currentWeek).map(x => x.bar);
}

// ─────────────────────────────────────────────────────────────────────────────
// Disk cache
// ─────────────────────────────────────────────────────────────────────────────

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}
function cacheFile(fyersSym, resolution) {
  return path.join(CACHE_DIR, `${fyersSym.replace(/[:/\\]/g, "_")}_${resolution}.json`);
}

/**
 * How long a cached series stays usable. One bar length while the market is
 * open (a new bar is the only thing that can change an answer); six hours when
 * it is shut, because nothing will change until it reopens.
 */
function cacheTtlMs(resolution) {
  if (!withinMarketHours()) return 6 * 3600_000;
  const mins = parseInt(resolution, 10);
  if (Number.isFinite(mins)) return Math.max(mins, 5) * 60_000;
  return 60 * 60_000;   // daily/weekly source
}

function readCache(fyersSym, resolution, fromDate) {
  try {
    const p = cacheFile(fyersSym, resolution);
    if (!fs.existsSync(p)) return null;
    const d = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!d || !Array.isArray(d.candles) || !d.candles.length) return null;
    if (Date.now() - (d.fetchedAt || 0) > cacheTtlMs(resolution)) return null;
    // A cache built for a shorter lookback cannot serve a longer one.
    if (!d.from || d.from > fromDate) return null;
    return d.candles;
  } catch (_) { return null; }
}

function writeCache(fyersSym, resolution, fromDate, candles) {
  try {
    ensureCacheDir();
    const p   = cacheFile(fyersSym, resolution);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), from: fromDate, candles }));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn(`[swingScanner] cache write failed for ${fyersSym}: ${e.message}`);
  }
}

/** Delete cache files older than `days`. Called at scan start; never throws. */
function pruneCache(days = 7) {
  try {
    if (!fs.existsSync(CACHE_DIR)) return 0;
    const cutoff = Date.now() - days * 86400_000;
    let n = 0;
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const p = path.join(CACHE_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); n++; } } catch (_) {}
    }
    return n;
  } catch (_) { return 0; }
}

/** Cached series fetch. Returns bars at the SOURCE resolution (pre-aggregation). */
async function getSeries(fyersSym, resolution, lookbackDays) {
  const from = daysAgoIST(lookbackDays);
  const to   = todayIST();
  const hit  = readCache(fyersSym, resolution, from);
  if (hit) return hit;
  const bars = await fetchSeries(fyersSym, resolution, from, to);
  if (bars.length) writeCache(fyersSym, resolution, from, bars);
  return bars;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

function sma(values, period) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/**
 * A 0–100 rank, published as its four parts so a row's position is explainable
 * rather than a black box. It ranks candidates that ALREADY passed the
 * strategy — it is not a second opinion on whether the setup is valid.
 *
 *   Liquidity  0–30  can this size actually be traded, and exited
 *   Risk       0–25  is the strategy's own stop a sane distance away
 *   Trend      0–25  is price extended the right way vs its 20-bar mean
 *   Volume     0–20  is today's participation above its own recent norm
 */
function scoreRow(candles, side, entry, stop) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume || 0);
  const last    = candles[candles.length - 1];

  // ── Liquidity: median bar turnover, annualised to a per-day figure is not
  //    needed — the comparison is relative, so raw ₹ turnover per bar is enough.
  const recentVols = volumes.slice(-20);
  const avgVol = recentVols.length ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0;
  const turnover = avgVol * entry;                       // ₹ per bar
  // ₹1 lakh/bar scores 0, ₹10 crore/bar scores 30, log-spaced between.
  const liq = turnover <= 0 ? 0
    : Math.max(0, Math.min(30, 30 * (Math.log10(turnover) - 5) / (Math.log10(1e8) - 5)));

  // ── Risk: stop distance as a % of entry. Best between 1% and 6%; a stop
  //    tighter than 0.5% is inside the noise, wider than 12% is not a swing
  //    trade. No stop at all scores 0 and the row is flagged in the UI.
  let risk = 0, stopPct = null;
  if (Number.isFinite(stop) && stop > 0 && entry > 0) {
    stopPct = Math.abs(entry - stop) / entry * 100;
    if (stopPct >= 1 && stopPct <= 6) risk = 25;
    else if (stopPct < 1)  risk = Math.max(0, 25 * (stopPct / 1));
    else                   risk = Math.max(0, 25 * (1 - (stopPct - 6) / 6));
  }

  // ── Trend: how far price sits the RIGHT way from its 20-bar mean. 3% or more
  //    in the trade's favour is full marks; the wrong side scores zero.
  const mean = sma(closes, 20);
  let trend = 0, meanDistPct = null;
  if (mean && mean > 0) {
    const raw = (last.close - mean) / mean * 100;
    meanDistPct = raw;
    const favour = side === "SHORT" ? -raw : raw;
    trend = Math.max(0, Math.min(25, 25 * (favour / 3)));
  }

  // ── Volume: last bar vs its own 20-bar average. 2× or better is full marks.
  let volScore = 0, volRatio = null;
  if (avgVol > 0) {
    volRatio = (last.volume || 0) / avgVol;
    volScore = Math.max(0, Math.min(20, 20 * (volRatio / 2)));
  }

  return {
    score: Math.round(liq + risk + trend + volScore),
    parts: { liquidity: Math.round(liq), risk: Math.round(risk), trend: Math.round(trend), volume: Math.round(volScore) },
    stopPct:     stopPct     == null ? null : Math.round(stopPct * 100) / 100,
    meanDistPct: meanDistPct == null ? null : Math.round(meanDistPct * 100) / 100,
    volRatio:    volRatio    == null ? null : Math.round(volRatio * 100) / 100,
    avgTurnover: Math.round(turnover),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency
// ─────────────────────────────────────────────────────────────────────────────

function concurrency() {
  const v = parseInt(process.env.SWING_SCANNER_CONCURRENCY || "4", 10);
  return Number.isFinite(v) && v >= 1 && v <= 16 ? v : 4;
}

/**
 * Run `worker` over `items` with a fixed number of workers pulling from a shared
 * cursor. A worker that throws records the failure and moves on — one delisted
 * symbol must not end a 230-symbol scan.
 */
async function mapLimit(items, limit, worker, onProgress, shouldStop) {
  const results = new Array(items.length);
  let cursor = 0, done = 0;
  async function run() {
    while (true) {
      if (shouldStop && shouldStop()) return;
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = { ok: true,  value: await worker(items[i], i) }; }
      // fyersErrText, not String(err): a rejection that escapes here can still be
      // a raw broker body, and String() on one of those reads "[object Object]".
      catch (err) { results[i] = { ok: false, error: fyersErrText(err) }; }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────────

const _jobs = new Map();          // id → job
let   _seq  = 0;
let   _activeJobId = null;        // at most one scan at a time
const MAX_JOBS = 6;

function _newJobId() { return `scan_${Date.now().toString(36)}_${++_seq}`; }

function _trimJobs() {
  while (_jobs.size > MAX_JOBS) {
    const oldest = _jobs.keys().next().value;
    _jobs.delete(oldest);
  }
}

function getJob(id) { return _jobs.get(id) || null; }
function activeJob() { return _activeJobId ? _jobs.get(_activeJobId) : null; }

function cancelJob(id) {
  const job = _jobs.get(id);
  if (!job || job.status !== "running") return false;
  job.cancelRequested = true;
  return true;
}

/**
 * Public view of a job — everything the page needs, nothing it does not.
 */
function jobView(job) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, error: job.error,
    strategy: job.strategy, strategyLabel: job.strategyLabel,
    timeframe: job.timeframe, timeframeLabel: job.timeframeLabel,
    universe: job.universe, universeLabel: job.universeLabel,
    progress: job.progress,
    startedAt: job.startedAt, finishedAt: job.finishedAt,
    rows: job.rows, skipped: job.skipped, stats: job.stats,
    scaling: job.scaling, systemic: job.systemic || null,
  };
}

/**
 * Start a scan. Returns { job } for a fresh run, or { job, reused:true } when an
 * identical scan is already running — pressing Search twice must not double the
 * load on the broker's history API.
 */
function startScan({ strategy, timeframe, universe: universeKey }) {
  const adapter = adapters.getAdapter(strategy);
  if (!adapter) throw new Error(`Unknown strategy "${strategy}"`);
  if (!adapters.activeAdapters().some(a => a.key === adapter.key)) {
    throw new Error(`${adapter.label} is switched off in Settings`);
  }
  const tf = getTimeframe(timeframe);
  if (!tf) throw new Error(`Unknown timeframe "${timeframe}"`);
  if (!adapters.supportsTimeframe(adapter, tf.key)) {
    throw new Error(`${adapter.label} does not support the ${tf.label} timeframe — ${adapter.timeframeNote || "unsupported"}`);
  }
  const symbols = universe.getUniverse(universeKey);
  if (!symbols.length) throw new Error(`Universe "${universeKey}" is empty or unknown`);

  const running = activeJob();
  if (running && running.status === "running") {
    const same = running.strategy === adapter.key && running.timeframe === tf.key && running.universe === String(universeKey).toUpperCase();
    if (same) return { job: running, reused: true };
    throw new Error(`A scan is already running (${running.strategyLabel} · ${running.timeframeLabel}) — wait for it or cancel it`);
  }

  const uniMeta = universe.listUniverses().universes.find(u => u.key === String(universeKey).toUpperCase());
  const job = {
    id: _newJobId(), status: "running", error: null,
    strategy: adapter.key, strategyLabel: adapter.label,
    timeframe: tf.key,     timeframeLabel: tf.label,
    universe: String(universeKey).toUpperCase(),
    universeLabel: uniMeta ? uniMeta.label : String(universeKey).toUpperCase(),
    progress: { phase: "fetching", done: 0, total: symbols.length },
    startedAt: Date.now(), finishedAt: null,
    rows: [], skipped: [], stats: null, scaling: null, systemic: null,
    cancelRequested: false,
  };
  _jobs.set(job.id, job);
  _activeJobId = job.id;
  _trimJobs();

  runScan(job, adapter, tf, symbols).catch(err => {
    job.status = "error";
    job.error  = err && err.message ? err.message : String(err);
    job.finishedAt = Date.now();
    console.error(`[swingScanner] scan ${job.id} failed: ${job.error}`);
  }).finally(() => {
    if (_activeJobId === job.id) _activeJobId = null;
  });

  return { job, reused: false };
}

/** The scan itself. Mutates `job` in place — the route polls the same object. */
async function runScan(job, adapter, tf, symbols) {
  const t0 = Date.now();
  pruneCache(parseInt(process.env.SWING_SCANNER_CACHE_DAYS || "7", 10) || 7);
  console.log(`[swingScanner] ${job.strategyLabel} · ${job.timeframeLabel} · ${job.universeLabel} (${symbols.length} symbols) — scanning`);

  const stop = () => job.cancelRequested;

  // ── 1. FETCH ──────────────────────────────────────────────────────────────
  const fetched = await mapLimit(symbols, concurrency(), async (sym) => {
    const fySym = universe.fyersSymbol(sym);
    const src   = await getSeries(fySym, tf.fyersRes, tf.lookbackDays);
    let bars = src;
    if (tf.aggregate === "4H") bars = aggregateTo4H(src);
    if (tf.aggregate === "W")  bars = aggregateToWeekly(src);
    if (bars.length > MAX_BARS) bars = bars.slice(-MAX_BARS);

    let dailyCandles = null;
    if (adapter.needsDaily) {
      // Previous-day pivots. 40 calendar days is ~27 sessions — plenty to find
      // the last completed one across a long weekend or a holiday cluster.
      dailyCandles = await getSeries(fySym, "D", 40);
    }
    return { sym, bars, dailyCandles, sourceBars: src.length };
  }, (done, total) => { job.progress = { phase: "fetching", done, total }; }, stop);

  if (job.cancelRequested) {
    job.status = "cancelled"; job.finishedAt = Date.now();
    console.log(`[swingScanner] scan ${job.id} cancelled`);
    return;
  }

  // ── 2. EVALUATE — sequential and synchronous. See the file header. ────────
  job.progress = { phase: "evaluating", done: 0, total: symbols.length };
  const minBars = adapter.minBars();
  const rows = [], skipped = [];
  let scalingSample = null;

  for (let i = 0; i < fetched.length; i++) {
    const r = fetched[i];
    if (!r) { skipped.push({ symbol: symbols[i], reason: "not scanned (cancelled)" }); continue; }
    if (!r.ok) { skipped.push({ symbol: symbols[i], reason: `history failed — ${r.error}` }); continue; }

    const { sym, bars, dailyCandles, sourceBars } = r.value;
    if (!bars.length) {
      skipped.push({ symbol: sym, reason: sourceBars ? "no bars after aggregation" : "no data from Fyers (delisted or wrong symbol?)" });
      continue;
    }
    if (bars.length < minBars) {
      skipped.push({ symbol: sym, reason: `only ${bars.length} bars, needs ${minBars}` });
      continue;
    }
    if (adapter.needsDaily && (!dailyCandles || dailyCandles.length < 2)) {
      skipped.push({ symbol: sym, reason: "no daily bars — cannot build previous-day pivots" });
      continue;
    }

    let out;
    try {
      out = adapters.evaluateSymbol(adapter, bars, {
        tfMinutes: tf.minutes, dailyCandles: dailyCandles || [], replayBars: adapter.replayBars,
      });
    } catch (err) {
      skipped.push({ symbol: sym, reason: `signal error — ${err.message}` });
      continue;
    }
    if (!scalingSample && out.scaled && Object.keys(out.scaled).length) scalingSample = { symbol: sym, scaled: out.scaled };

    const last = bars[bars.length - 1];
    const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
    const entry = last.close;
    const sc = scoreRow(bars, out.side || "LONG", entry, out.stop);

    rows.push({
      symbol: sym,
      side:   out.side,                       // "LONG" | "SHORT" | null
      reason: out.reason,
      ltp:    Math.round(entry * 100) / 100,
      changePct: prev && prev.close ? Math.round((entry - prev.close) / prev.close * 10000) / 100 : null,
      barTime:   last.time,
      barTimeIST: `${istDateStr(last.time)}${tf.minutes ? ` ${String(Math.floor(istMinutes(last.time) / 60)).padStart(2, "0")}:${String(istMinutes(last.time) % 60).padStart(2, "0")}` : ""}`,
      stop:   out.stop == null ? null : Math.round(out.stop * 100) / 100,
      target: out.target == null ? null : Math.round(out.target * 100) / 100,
      stopPct:     sc.stopPct,
      rr:          (out.target != null && out.stop != null && Math.abs(entry - out.stop) > 0)
                     ? Math.round(Math.abs(out.target - entry) / Math.abs(entry - out.stop) * 100) / 100
                     : null,
      volume:      last.volume || 0,
      volRatio:    sc.volRatio,
      avgTurnover: sc.avgTurnover,
      meanDistPct: sc.meanDistPct,
      score:       sc.score,
      scoreParts:  sc.parts,
      indicators:  out.indicators || {},
      bars:        bars.length,
    });

    job.progress = { phase: "evaluating", done: i + 1, total: symbols.length };
  }

  // Rank: signals first, then by score. A row with no signal is context, not a
  // candidate, so it can never outrank one that fired however good its score.
  rows.sort((a, b) => {
    const as = a.side ? 1 : 0, bs = b.side ? 1 : 0;
    if (as !== bs) return bs - as;
    return b.score - a.score;
  });

  // When a large majority of symbols failed the SAME way, the problem is not the
  // symbols — it is the connection behind them (expired token, broker outage,
  // no network). Say that once, instead of leaving the user to infer it from
  // 200 identical rows in the skip list.
  const failures = skipped.filter(s => /^history failed/.test(s.reason));
  let systemic = null;
  if (symbols.length >= 4 && failures.length >= Math.ceil(symbols.length * 0.6)) {
    const counts = new Map();
    for (const f of failures) {
      const k = f.reason.replace(/^history failed — /, "").slice(0, 120);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const [reason, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    // "Check the Fyers login" is the right advice for an expired token and the
    // wrong advice for a throttle — nothing about logging in again fixes a rate
    // limit. Classify here, where the error text is, rather than making the page
    // guess from a string it only prints.
    const hint = RETRYABLE.test(reason)
      ? "The broker throttled the scan even after retries. Lower the per-second / per-minute history caps in Settings, or scan a smaller universe."
      : /authenticat|token|login|expired|unauthor/i.test(reason)
        ? "That is a login problem, not a stock problem. Re-authenticate Fyers on the Token Sync page."
        : "That is a connection problem, not a stock problem. Check the Fyers login.";
    systemic = { reason, count: n, total: symbols.length, hint };
    console.error(`[swingScanner] ${n}/${symbols.length} symbols failed identically — ${reason}`);
  }

  job.rows    = rows;
  job.skipped = skipped;
  job.systemic = systemic;
  job.stats   = {
    scanned:  symbols.length,
    evaluated: rows.length,
    long:     rows.filter(r => r.side === "LONG").length,
    short:    rows.filter(r => r.side === "SHORT").length,
    noSignal: rows.filter(r => !r.side).length,
    skipped:  skipped.length,
    elapsedMs: Date.now() - t0,
  };
  job.scaling = {
    enabled: adapters.scalingOn(),
    niftyRef: adapters.niftyRef(),
    keys: adapter.scaleKeys.map(s => s.key),
    sample: scalingSample,
  };
  job.status = "done";
  job.finishedAt = Date.now();
  console.log(`[swingScanner] ${job.strategyLabel} · ${job.timeframeLabel} · ${job.universeLabel} — ${job.stats.long} long, ${job.stats.short} short, ${job.stats.skipped} skipped in ${(job.stats.elapsedMs / 1000).toFixed(1)}s`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Equity delivery charges — for the "what will this actually cost" line in the
// order popup. Zerodha delivery brokerage is zero; the statutory levies are not.
// Rates are the published NSE/CDSL ones and are overridable, because they move.
// ─────────────────────────────────────────────────────────────────────────────

function equityBuyCharges(qty, price) {
  const turnover = qty * price;
  if (!(turnover > 0)) return { turnover: 0, total: 0, breakup: {} };
  const pct = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };

  const brokerage = pct("SWING_SCANNER_BROKERAGE_PCT", 0)      / 100 * turnover;  // CNC = free at Zerodha
  const stt       = pct("SWING_SCANNER_STT_PCT",        0.1)   / 100 * turnover;
  const txn       = pct("SWING_SCANNER_TXN_PCT",        0.00297) / 100 * turnover;
  const sebi      = pct("SWING_SCANNER_SEBI_PCT",       0.0001) / 100 * turnover;
  const stamp     = pct("SWING_SCANNER_STAMP_PCT",      0.015)  / 100 * turnover;
  const gst       = 0.18 * (brokerage + txn + sebi);

  const r2 = v => Math.round(v * 100) / 100;
  const total = brokerage + stt + txn + sebi + stamp + gst;
  return {
    turnover: r2(turnover),
    total:    r2(total),
    breakup:  { brokerage: r2(brokerage), stt: r2(stt), exchange: r2(txn), sebi: r2(sebi), stamp: r2(stamp), gst: r2(gst) },
  };
}

/**
 * Which Zerodha variety this order should go out as, right now.
 *
 *   regular  the market is open — it fills immediately
 *   amo      the market is shut — Kite queues it and releases it into the
 *            pre-open of the NEXT trading day
 *
 * The one hole worth naming: Kite refuses AMO orders during a short band around
 * the close (roughly 15:30–15:45 IST) while it settles the day's book. That is
 * the broker's rule, not ours, so the order still goes out — but the caller gets
 * a warning to show first, rather than a bare rejection afterwards.
 */
function orderPlan(nowSec = Math.floor(Date.now() / 1000)) {
  const wd  = istWeekday(nowSec);
  const min = istMinutes(nowSec);
  const hhmm = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const weekend = wd === 0 || wd === 6;

  if (!weekend && min >= MKT_OPEN_MIN && min < MKT_CLOSE_MIN) {
    return { variety: "regular", isAmo: false, reason: `Market is open (${hhmm} IST) — this fills now at market price.`, warning: null };
  }
  const dayWord = weekend ? "It is the weekend" : `Market is closed (${hhmm} IST)`;
  const warning = (!weekend && min >= MKT_CLOSE_MIN && min < 15 * 60 + 45)
    ? "Zerodha rejects AMO orders for a few minutes right after the close (~15:30–15:45 IST). If this is rejected, try again after 15:45."
    : null;
  return {
    variety: "amo", isAmo: true,
    reason: `${dayWord} — this goes in as an AMO (after-market order) and is released into the next trading day's open.`,
    warning,
  };
}

module.exports = {
  TIMEFRAMES, TIMEFRAME_ORDER, getTimeframe, listTimeframes,
  startScan, getJob, activeJob, cancelJob, jobView,
  equityBuyCharges, orderPlan, withinMarketHours,
  // exported for the regression suite
  aggregateTo4H, aggregateToWeekly, scoreRow, fetchSeries, getSeries,
  mapLimit, pruneCache, istDateStr, istMinutes, istWeekday, istDayKey,
  _setHistoryFn, _resetHistoryFn, _acquireSlot: acquireSlot, _resetRateLimiter,
  CACHE_DIR, MAX_BARS,
};

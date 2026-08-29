/**
 * EARLYBIRD BACKTEST — /early-bird-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest of the EarlyBird strategy over a stock universe. Every
 * rule — the signal-candle shape test, the NIFTY direction filter, the 2% gap
 * rule, the entry/stop/target levels, the big-candle body stop, the trigger test
 * and the exit ordering — comes from src/strategies/early_bird.js. There is NOT
 * ONE threshold comparison or indicator calculation in this file: it fetches
 * candles, groups them by day, walks bars, and calls the engine.
 *
 * ── WHAT IS BEING SIMULATED ─────────────────────────────────────────────────
 * CASH EQUITY intraday on F&O stocks. There is no strike, no expiry, no option
 * premium and no ITM step anywhere on this page. NIFTY is fetched, but NIFTY is
 * never traded — its 09:15 candle only decides whether the day is a LONG day or
 * a SHORT day. A SHORT here is a real intraday short sale in the cash segment.
 * Flat EARLYBIRD_QTY (default 100) shares per stock, up to
 * EARLYBIRD_MAX_CONCURRENT (default 5) names open at once.
 *
 * ── ONE SIMULATED DAY ───────────────────────────────────────────────────────
 *   1. NIFTY's 09:15 15-minute candle + every universe symbol's 09:15 candle
 *      and its PREVIOUS DAY'S DAILY CLOSE (the gap rule needs it).
 *   2. earlyBird.buildDayPlan(...) → tradeable / not, plus the whole funnel.
 *      A day the plan refuses is recorded with plan.reason and nothing else
 *      happens — no second-guessing, no partial trading of a rejected day.
 *   3. The plan's candidates are ALREADY sorted tightest-risk-first by the
 *      engine; the first maxConcurrent of them are taken as pending orders.
 *   4. Every 15-minute bar from EARLYBIRD_ENTRY_START onward is walked per
 *      candidate: isEntryTriggeredOnBar() to fill, checkExitOnBar() to exit.
 *   5. computePnl(side, entry, exit, qty), then slippage, then charges.
 *
 * ── FILL SEMANTICS (identical to Paper/Live by construction) ────────────────
 * The entry is a PENDING STOP ORDER at a frozen level. A bar whose high reaches
 * a LONG entry (or whose low reaches a SHORT entry) fills AT THE LEVEL — never
 * at the bar's high/low, which would hand the backtest a price the market never
 * offered. Entries are gated on the bar's CLOSE time (bar start + resolution),
 * the same convention checkExitOnBar uses for its forced-exit test, so no entry
 * is taken on a bar that closes after EARLYBIRD_ENTRY_END.
 *
 * ── THE ENTRY-THEN-STOP BAR (where naive backtests lie) ─────────────────────
 * A single 15-minute bar can both trigger the entry and take out the stop. That
 * loss is REAL and it is booked: the fill happens, and the very same bar is then
 * passed to checkExitOnBar, which applies the engine's conservative ordering
 * (gap-through fills at the open, stop tested before target). The trade is never
 * skipped to avoid the loss, and the target is never assumed to have come first.
 *
 * ── SETUPS THAT NEVER TRIGGERED ─────────────────────────────────────────────
 * A confirmed, taken setup whose pending order was never touched all session is
 * NOT a trade and NOT a loss — but it IS the statistic that decides whether this
 * strategy is worth running. It is counted per day and in the headline stats,
 * and it is never folded into the trade list to make the win rate look better.
 *
 * ── COSTS ───────────────────────────────────────────────────────────────────
 * SLIPPAGE: EARLYBIRD_BT_SLIPPAGE_PTS, default 0.05, applied BOTH ways (worse
 * entry, worse exit). This is RUPEES ON A STOCK PRICE, not NIFTY points — 5
 * paise per side on a liquid F&O cash name is one tick, which is the honest
 * floor for a marketable stop order. It is deliberately a floor, not a claim:
 * raise it to test whether the edge survives a wider touch.
 *
 * CHARGES — READ THIS, IT IS A KNOWN GAP. src/utils/charges.js has exactly TWO
 * paths, options and futures (`isFutures`), and NO cash-equity-intraday path.
 * Equity intraday differs on both the pieces that matter: STT is 0.025% on the
 * sell side (vs 0.15% of options premium) and the NSE equity transaction charge
 * is ~0.00297% of turnover (vs 0.03553% of options premium turnover). Rather
 * than silently billing option rates against ₹-lakh equity turnover — which
 * would overstate costs by an order of magnitude and make any result meaningless
 * — this file computes equity-intraday charges LOCALLY, from EARLYBIRD_CHG_*
 * env keys, and says so in the results notes. That is the one piece of arithmetic
 * in here that is not strategy logic; it is a cost model, not a trading rule.
 * If charges.js ever grows an `isEquityIntraday` path, delete _equityCharges()
 * and call it instead.
 *
 * ── PERFORMANCE ─────────────────────────────────────────────────────────────
 * A wide range over ~220 F&O names is a lot of history calls. So:
 *   • each symbol's intraday series is fetched ONCE for the WHOLE range, never
 *     per day, and the same for its daily series (the prevClose source);
 *   • everything is disk-cached under ~/trading-data/early_bird_bt_cache/,
 *     keyed by symbol+resolution+range, mirroring swingScanner's approach;
 *   • fetches are bounded by EARLYBIRD_BT_CONCURRENCY (default 4, the same
 *     limit swingScanner uses) and paced under Fyers' per-second/per-minute
 *     history caps by EARLYBIRD_BT_RPS / EARLYBIRD_BT_RPM;
 *   • it runs as a background JOB with progress polling — the repo's existing
 *     pattern (backtestJobManager), because a 220-symbol fetch would time out a
 *     request/response page long before it finished.
 * The default range is 1 MONTH. A multi-year run over the full F&O universe is
 * supported but slow on a cold cache, and the form says so.
 *
 * ── NO BROKER TOKEN NEEDED ──────────────────────────────────────────────────
 * History only. But an EXPIRED Fyers token returns no_data — ZERO candles — not
 * an auth error, so "0 candles" is reported as "Fyers token likely expired"
 * rather than as a valid empty backtest.
 *
 * ── DELIBERATELY ABSENT ─────────────────────────────────────────────────────
 * No VIX gate, no OI, no ADX, no RSI, no volume filter, no moving average, no
 * trailing stop, no breakeven, no partials, no re-entry. The user did not ask
 * for any of them and the engine implements none of them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const express = require("express");
const router  = express.Router();

const earlyBird = require("../strategies/early_bird");
const fyers     = require("../config/fyers");
const universe  = require("../utils/stockUniverse");
const { fyersErrText } = require("../utils/fyersErr");
const { faviconLink, buildSidebar, sidebarCSS, modalCSS, modalJS,
        clearCacheButtonHTML, clearCacheJS } = require("../utils/sharedNav");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");

const ACCENT     = "#22d3ee";
const ENDPOINT   = "/early-bird-backtest";
const RESULT_KEY = "EARLY_BIRD_BACKTEST";
const LOG        = "[EARLYBIRD-BT]";
const NIFTY_SYMBOL = "NSE:NIFTY50-INDEX";

const CACHE_DIR = path.join(os.homedir(), "trading-data", "early_bird_bt_cache");

const IST_OFFSET_SEC = 19800;
const MKT_OPEN_MIN   = 9 * 60 + 15;
const MKT_CLOSE_MIN  = 15 * 60 + 30;

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers. Numeric guards are always the full
// `typeof x === "number" && Number.isFinite(x)` — a bare truthiness test would
// let 0 and NaN through into a price comparison.
// ─────────────────────────────────────────────────────────────────────────────
function _num(x) { return typeof x === "number" && Number.isFinite(x); }
function _r2(x)  { return Math.round(x * 100) / 100; }

function escHtml(x) {
  return String(x == null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function istMinutes(unixSec) { return Math.floor((unixSec + IST_OFFSET_SEC) / 60) % 1440; }
function istDayKey(unixSec)  { return Math.floor((unixSec + IST_OFFSET_SEC) / 86400); }

function istDateStr(unixSec) {
  const d = new Date((unixSec + IST_OFFSET_SEC) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function istDMY(unixSec) {
  const d = new Date((unixSec + IST_OFFSET_SEC) * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function istHHMMSS(unixSec) {
  const d = new Date((unixSec + IST_OFFSET_SEC) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
function stampStr(unixSec) { return `${istDMY(unixSec)}, ${istHHMMSS(unixSec)}`; }

function todayIST() { return istDateStr(Math.floor(Date.now() / 1000)); }

/** "YYYY-MM-DD" shifted by `days` calendar days (negative = backwards). */
function shiftDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// Backtest-only knobs. Read live from process.env on every call — the Settings
// page writes process.env at runtime, and a cached copy would run the backtest
// with numbers the UI is no longer showing.
// ─────────────────────────────────────────────────────────────────────────────

/** Rupees of slippage applied EACH way. Stock price, not NIFTY points. */
function slippagePts() {
  const v = parseFloat(process.env.EARLYBIRD_BT_SLIPPAGE_PTS);
  return Number.isFinite(v) && v >= 0 ? v : 0.05;
}

/** Concurrent history fetches. Same ceiling swingScanner uses. */
function concurrency() {
  const v = parseInt(process.env.EARLYBIRD_BT_CONCURRENCY, 10);
  return Number.isFinite(v) && v >= 1 && v <= 16 ? v : 4;
}

/** Fyers meters history per app on two windows; both are honoured below. */
function rateLimits() {
  // Spelled out, not looked up via a computed key: docs/ENV.md is generated by
  // scanning for literal process.env reads and a computed lookup ships invisible.
  const rps = parseInt(process.env.EARLYBIRD_BT_RPS || "8",   10);
  const rpm = parseInt(process.env.EARLYBIRD_BT_RPM || "180", 10);
  return {
    rps: Number.isFinite(rps) && rps >= 1 ? Math.min(rps, 50)   : 8,
    rpm: Number.isFinite(rpm) && rpm >= 1 ? Math.min(rpm, 2000) : 180,
  };
}

/**
 * Memory ceiling for one run, in symbol-days (symbols × trading days).
 *
 * 60000 symbol-days is ~186 MB of candles — about ONE YEAR of the full ~220-name
 * FNO universe, or ~5 years of NIFTY50. The process gets a 900 MB heap and
 * shares it with any live/paper session, so this deliberately spends only about
 * a fifth of the budget on raw candles: peak RSS is higher than the candle
 * arrays alone (trade records, per-day rows, and GC headroom on top), and the
 * point of the ceiling is that a backtest must never be the thing that restarts
 * the bot.
 */
function maxSymbolDays() {
  const v = parseInt(process.env.EARLYBIRD_BT_MAX_SYMBOL_DAYS, 10);
  return Number.isFinite(v) && v >= 100 ? v : 60000;
}

/** Days a cache file survives. */
function cacheRetainDays() {
  const v = parseInt(process.env.EARLYBIRD_BT_CACHE_DAYS, 10);
  return Number.isFinite(v) && v >= 1 ? v : 30;
}

// ─────────────────────────────────────────────────────────────────────────────
// Charges — EQUITY INTRADAY. See the header: charges.js has no equity path, so
// this is computed here from its own env keys rather than billing option rates.
// This is a cost model, not a trading rule.
// ─────────────────────────────────────────────────────────────────────────────
function _chgEnv(raw, def) {
  const v = parseFloat(raw);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

/**
 * @param {number} entry  fill price (already slipped)
 * @param {number} exit   exit price (already slipped)
 * @param {number} qty    shares
 * @returns {{ stt:number, exchangeTxn:number, sebi:number, gst:number, stampDuty:number, brokerage:number, total:number }}
 */
function _equityCharges(entry, exit, qty) {
  const sttPct     = _chgEnv(process.env.EARLYBIRD_CHG_STT_PCT,          0.025);   // % of sell-side turnover
  const exchPct    = _chgEnv(process.env.EARLYBIRD_CHG_EXCHANGE_PCT,     0.00297); // % of total turnover (NSE equity)
  const sebiPerCr  = _chgEnv(process.env.EARLYBIRD_CHG_SEBI_PER_CRORE,  10);       // ₹ per crore of turnover
  const gstPct     = _chgEnv(process.env.EARLYBIRD_CHG_GST_PCT,         18);       // % on brokerage + exch + sebi
  const stampPct   = _chgEnv(process.env.EARLYBIRD_CHG_STAMP_PCT,        0.003);   // % of buy-side turnover
  const brokPct    = _chgEnv(process.env.EARLYBIRD_CHG_BROKERAGE_PCT,    0.03);    // % of turnover per leg…
  const brokCap    = _chgEnv(process.env.EARLYBIRD_CHG_BROKERAGE_CAP,   20);       // …capped at ₹ per leg

  if (!_num(entry) || !_num(exit) || !_num(qty)) {
    return { stt: 0, exchangeTxn: 0, sebi: 0, gst: 0, stampDuty: 0, brokerage: 0, total: 0 };
  }

  // Which leg is the SELL depends on direction: a SHORT sells first and buys
  // back. STT and stamp duty are one-sided taxes, so the sides must not be
  // assumed — turnover per leg is what is actually used.
  const buyTurnover  = entry * qty;
  const sellTurnover = exit  * qty;
  const totalTurnover = buyTurnover + sellTurnover;

  const stt         = _r2((sttPct   / 100) * sellTurnover);
  const exchangeTxn = _r2((exchPct  / 100) * totalTurnover);
  const sebi        = _r2((sebiPerCr / 10000000) * totalTurnover);
  const brokerage   = _r2(
    Math.min(brokCap, (brokPct / 100) * buyTurnover) +
    Math.min(brokCap, (brokPct / 100) * sellTurnover)
  );
  const gst         = _r2((gstPct / 100) * (brokerage + exchangeTxn + sebi));
  const stampDuty   = _r2((stampPct / 100) * buyTurnover);
  const total       = _r2(stt + exchangeTxn + sebi + gst + stampDuty + brokerage);

  return { stt, exchangeTxn, sebi, gst, stampDuty, brokerage, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// History fetch — local, rate-limited, chunked, disk-cached.
//
// Local rather than backtestEngine.fetchCandles for the same reason swingScanner
// keeps its own: that one logs a line per chunk per symbol, and console.log here
// is piped to the /logs SSE stream. A 220-symbol × 2-resolution fetch would push
// well over a thousand lines into the live log and bury every running strategy.
// This one logs once per phase, plus failures.
// ─────────────────────────────────────────────────────────────────────────────

// Swappable so an offline test can drive the whole backtest off fixtures with no
// Fyers token. Production never calls the setter.
let _historyFn = (params) => fyers.getHistory(params);
let _historyStubbed = false;
function _setHistoryFn(fn) { _historyFn = fn; _historyStubbed = true; }
function _resetHistoryFn()  { _historyFn = (params) => fyers.getHistory(params); _historyStubbed = false; }

/** Fyers caps one history request by resolution. Mirrors swingScanner. */
function maxDaysForResolution(resolution) {
  if (["D", "W", "M"].includes(String(resolution))) return 366;
  if (["1", "2", "3"].includes(String(resolution))) return 30;
  return 100;
}

const _reqLog = [];
let   _gate   = Promise.resolve();

/**
 * Resolve once one more history call fits inside BOTH the per-second and the
 * per-minute window, having booked its slot. Serialised through `_gate`: workers
 * that each read the log independently all conclude there is room and all fire
 * at once, which is the exact burst this exists to prevent. A rate-limited
 * symbol is indistinguishable from a delisted one in the results, so pacing is
 * correctness here, not politeness.
 */
function acquireSlot() {
  if (_historyStubbed) return Promise.resolve();
  const booked = _gate.then(async () => {
    const { rps, rpm } = rateLimits();
    for (;;) {
      const now = Date.now();
      while (_reqLog.length && now - _reqLog[0] >= 60000) _reqLog.shift();
      let wait = 0;
      if (_reqLog.length >= rps) wait = Math.max(wait, _reqLog[_reqLog.length - rps] + 1000  - now);
      if (_reqLog.length >= rpm) wait = Math.max(wait, _reqLog[_reqLog.length - rpm] + 60000 - now);
      if (wait <= 0) { _reqLog.push(now); return; }
      await sleep(wait);
    }
  });
  // Advance the gate even on failure — otherwise one throw parks every worker
  // queued behind it forever.
  _gate = booked.catch(() => {});
  return booked;
}

function _resetRateLimiter() { _reqLog.length = 0; _gate = Promise.resolve(); }

const RETRYABLE = /(request limit|rate ?limit|too many requests|\b429\b|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up)/i;
function retryDelays() { return _historyStubbed ? [0, 0, 0] : [1200, 3000, 7000]; }

/**
 * One raw history response → candles, empty, or a throw.
 * ORDER MATTERS: an error response carries no `candles` key, so an emptiness
 * check placed first swallows it and reports the symbol as "no data", which
 * reads as "delisted". The failure that actually happens is an expired Fyers
 * token, and it fails EVERY symbol at once.
 */
function parseHistory(res) {
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
      // On an HTTP failure the SDK rejects with Fyers' raw BODY — a plain
      // object, not an Error — so err.message is undefined and String(err)
      // collapses to "[object Object]". Convert here, where the shape is known.
      const e = err instanceof Error ? err : new Error(fyersErrText(err));
      if (attempt >= delays.length || !RETRYABLE.test(e.message)) throw e;
      await sleep(delays[attempt]);
    }
  }
}

/**
 * Contiguous chunked fetch for ONE symbol over the WHOLE range, deduped and
 * sorted ascending. Intraday output is filtered to the regular session
 * (09:15 ≤ IST < 15:30): the pre-open auction bar is a wild wide-range print and
 * it would be mistaken for the 09:15 signal candle. Daily bars are stamped
 * 00:00 IST and are never filtered.
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

// ── Disk cache ───────────────────────────────────────────────────────────────
// Keyed by symbol + resolution. A cached file serves a request only when it
// COVERS it (cached.from ≤ wanted.from and cached.to ≥ wanted.to), so widening
// the range refetches while narrowing it is free. Unlike the scanner's cache
// there is no market-hours TTL: this page requests a CLOSED historical range, and
// closed history does not change. The only exception is a range whose `to` is
// today — that day is still forming, so those files carry a short TTL.

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheFile(fyersSym, resolution) {
  return path.join(CACHE_DIR, `${String(fyersSym).replace(/[:/\\]/g, "_")}_${resolution}.json`);
}

function readCache(fyersSym, resolution, fromDate, toDate) {
  try {
    const p = cacheFile(fyersSym, resolution);
    if (!fs.existsSync(p)) return null;
    const d = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!d || !Array.isArray(d.candles)) return null;
    if (!d.from || !d.to) return null;
    // Must COVER the wanted window, not merely overlap it.
    if (d.from > fromDate || d.to < toDate) return null;
    // A file whose range reaches today captured a session still in progress.
    if (d.to >= todayIST() && Date.now() - (d.fetchedAt || 0) > 15 * 60000) return null;
    return d.candles;
  } catch (_) { return null; }
}

function writeCache(fyersSym, resolution, fromDate, toDate, candles) {
  try {
    ensureCacheDir();
    const p   = cacheFile(fyersSym, resolution);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), from: fromDate, to: toDate, candles }));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn(`${LOG} cache write failed for ${fyersSym} ${resolution}: ${e.message}`);
  }
}

/** Delete cache files not touched in `days`. Called at job start; never throws. */
function pruneCache(days) {
  try {
    if (!fs.existsSync(CACHE_DIR)) return 0;
    const cutoff = Date.now() - days * 86400000;
    let n = 0;
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const p = path.join(CACHE_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); n++; } } catch (_) {}
    }
    return n;
  } catch (_) { return 0; }
}

/** Cached whole-range series fetch. ONE call per symbol per resolution per run. */
async function getSeries(fyersSym, resolution, fromDate, toDate) {
  const hit = readCache(fyersSym, resolution, fromDate, toDate);
  if (hit) return { candles: hit, cached: true };
  const bars = await fetchSeries(fyersSym, resolution, fromDate, toDate);
  if (bars.length) writeCache(fyersSym, resolution, fromDate, toDate, bars);
  return { candles: bars, cached: false };
}

/**
 * Run `worker` over `items` with a fixed pool pulling from a shared cursor. A
 * worker that throws records the failure and moves on — one delisted symbol
 * must not end a 220-symbol run.
 */
async function mapLimit(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let cursor = 0, done = 0;
  async function run() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = { ok: true, value: await worker(items[i], i) }; }
      catch (err) { results[i] = { ok: false, error: fyersErrText(err) }; }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Series → per-day index
//
// Every symbol's whole-range intraday series is grouped ONCE into
// Map<istDayKey, bar[]>, so the day loop is a lookup rather than a scan. Same
// for the daily series: Map<istDayKey, close>, plus the ordered day list needed
// to find "the previous trading day's close" without assuming yesterday traded.
// ─────────────────────────────────────────────────────────────────────────────

function groupIntradayByDay(candles) {
  const byDay = new Map();
  if (!Array.isArray(candles)) return byDay;
  for (const c of candles) {
    if (!c || !_num(c.time)) continue;
    const k = istDayKey(c.time);
    let arr = byDay.get(k);
    if (!arr) { arr = []; byDay.set(k, arr); }
    arr.push(c);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => a.time - b.time);
  return byDay;
}

/**
 * Daily closes as an ascending [dayKey, close] list plus a lookup for
 * "the close of the last daily bar STRICTLY BEFORE this day". Binary search, so
 * a multi-year run does not become quadratic in the number of days.
 */
function buildPrevCloseIndex(dailyCandles) {
  const days = [];
  if (Array.isArray(dailyCandles)) {
    for (const c of dailyCandles) {
      if (!c || !_num(c.time) || !_num(c.close)) continue;
      days.push({ day: istDayKey(c.time), close: c.close });
    }
  }
  days.sort((a, b) => a.day - b.day);
  return {
    /** Close of the newest daily bar strictly before `dayKey`, or null. */
    prevCloseFor(dayKey) {
      let lo = 0, hi = days.length - 1, best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (days[mid].day < dayKey) { best = days[mid].close; lo = mid + 1; }
        else hi = mid - 1;
      }
      return _num(best) ? best : null;
    },
    count: days.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BACKTEST
//
// Pure function of already-fetched data: no I/O, no clock, no env beyond the
// engine's own getConfig() and the backtest-only slippage/charges knobs. That is
// what makes it unit-testable without a Fyers token.
//
// @param {Object} data
//   data.niftyByDay  Map<dayKey, bar[]>            NIFTY intraday, grouped
//   data.stocks      Array<{ symbol, byDay, prevIdx }>
//   data.dayKeys     number[] ascending — the days to simulate
// ─────────────────────────────────────────────────────────────────────────────
function runEarlyBirdBacktest(data, onProgress) {
  const cfg  = earlyBird.getConfig();
  const SLIP = slippagePts();

  // ── THIS BACKTEST COVERS THE STOCK LEG ONLY ─────────────────────────────
  // EARLYBIRD_TRADE_MODE can also trade a NIFTY OPTION leg, but simulating a
  // bought option needs historical PREMIUM candles per strike, which Fyers
  // delists at expiry — the same limitation SIMPLE930's backtest documents.
  // Rather than invent premiums from a delta/theta model (which would be
  // simulating the strategy rather than testing it), the option leg is simply
  // not backtested. Say so out loud: in "option" mode every day reports
  // NO TRADE, and a silent wall of no-trade days would otherwise read as
  // "the strategy never fires".
  if (!earlyBird.tradesStock(cfg)) {
    console.warn(`${LOG} EARLYBIRD_TRADE_MODE="${cfg.tradeMode}" trades no stock leg — ` +
      `this backtest simulates the STOCK leg only, so it will report NO TRADE for every day. ` +
      `Set the mode to "stock" or "both" to backtest, and paper-trade the option leg instead.`);
  } else if (earlyBird.tradesOption(cfg)) {
    console.log(`${LOG} EARLYBIRD_TRADE_MODE="both" — the NIFTY option leg is NOT included ` +
      `in these results (no historical option premiums); stock-leg figures only.`);
  }

  const trades   = [];
  const dayRows  = [];
  const noTrade  = [];
  const perSymbol = new Map();   // symbol → { symbol, trades, wins, pnl, triggered, untriggered }

  const funnel = {
    daysSeen: 0, tradeableDays: 0, noSignalDays: 0,
    scanned: 0, confirmed: 0, taken: 0, triggered: 0, untriggered: 0,
  };
  const exitTypes = { SL: 0, TARGET: 0, EOD: 0 };
  const sides     = { LONG: 0, SHORT: 0 };
  const niftyVerdicts = {};

  const dayKeys  = Array.isArray(data && data.dayKeys) ? data.dayKeys : [];
  const stockDefs = Array.isArray(data && data.stocks) ? data.stocks : [];
  const niftyByDay = (data && data.niftyByDay) || new Map();

  for (let di = 0; di < dayKeys.length; di++) {
    const dayKey = dayKeys[di];
    funnel.daysSeen++;

    const niftyBars = niftyByDay.get(dayKey) || [];
    if (!niftyBars.length) {
      // No NIFTY bars at all = not a trading day in this dataset (holiday), or
      // a hole in the index history. Either way the plan cannot be built, and
      // inventing a direction from the stocks alone is not this strategy.
      const row = {
        dayKey, date: "—", niftyCandle: null, verdict: "NO NIFTY DATA",
        reason: "no NIFTY candles for this day — holiday, or a hole in the index history",
        scanned: 0, confirmed: 0, taken: 0, triggered: 0, untriggered: 0, pnl: 0, trades: 0,
      };
      dayRows.push(row);
      noTrade.push({ date: row.date, reason: row.reason });
      funnel.noSignalDays++;
      console.log(`${LOG} day ${dayKey}: skipped — ${row.reason}`);
      continue;
    }

    const dayStr = istDateStr(niftyBars[0].time);
    const dayDMY = istDMY(niftyBars[0].time);

    // ── Assemble the engine's inputs for this day. Each stock contributes its
    //    own 09:15 bar (via its grouped series) and its previous DAILY close.
    const stocksInput = [];
    for (const sd of stockDefs) {
      const bars = sd.byDay.get(dayKey);
      if (!bars || !bars.length) continue;   // no data for this symbol today
      stocksInput.push({
        symbol: sd.symbol,
        candles: bars,
        prevClose: sd.prevIdx.prevCloseFor(dayKey),
      });
    }

    // ── THE ONE DECISION CALL. Every rule lives behind this. ──────────────────
    const plan = earlyBird.buildDayPlan(niftyBars, stocksInput, { cfg, istDay: dayKey });

    const nc = plan.nifty && plan.nifty.candle ? plan.nifty.candle : null;
    const verdict = plan.nifty && plan.nifty.signal
      ? `${plan.nifty.direction} → ${plan.nifty.side}`
      : "NO SIGNAL";
    niftyVerdicts[verdict] = (niftyVerdicts[verdict] || 0) + 1;

    funnel.scanned   += plan.scanned;
    funnel.confirmed += plan.confirmingCount;

    const row = {
      dayKey, date: dayDMY, dateISO: dayStr,
      niftyCandle: nc, verdict,
      niftyDetail: plan.nifty && plan.nifty.detail ? plan.nifty.detail.reason : "",
      reason: plan.reason || "",
      scanned: plan.scanned, confirmed: plan.confirmingCount,
      taken: 0, triggered: 0, untriggered: 0,
      pnl: 0, trades: 0,
      candidates: [], rejectedTop: (plan.rejected || []).slice(0, 5),
    };

    if (!plan.tradeable) {
      dayRows.push(row);
      noTrade.push({ date: dayDMY, reason: plan.reason || plan.skipReason || "plan not tradeable" });
      funnel.noSignalDays++;
      console.log(`${LOG} ${dayStr}: NO TRADE — ${plan.reason || plan.skipReason}` +
        (nc ? ` | NIFTY 09:15 O ${nc.open} H ${nc.high} L ${nc.low} C ${nc.close}` : ""));
      if (onProgress) onProgress(di + 1, dayKeys.length);
      continue;
    }

    funnel.tradeableDays++;
    console.log(`${LOG} ${dayStr}: ${plan.reason}`);
    if (nc) {
      console.log(`${LOG} ${dayStr}:   NIFTY 09:15 → O ${nc.open} H ${nc.high} L ${nc.low} C ${nc.close} | ` +
        `${plan.nifty.detail ? plan.nifty.detail.reason : ""}`);
    }

    // ── The engine already sorted candidates tightest-risk-first. Take the cap.
    const taken = plan.candidates.slice(0, cfg.maxConcurrent);
    row.taken = taken.length;
    funnel.taken += taken.length;

    if (plan.candidates.length > taken.length) {
      console.log(`${LOG} ${dayStr}:   ${plan.candidates.length} confirmed, capped at ` +
        `${cfg.maxConcurrent} — dropped: ${plan.candidates.slice(taken.length).map(c => c.symbol).join(", ")}`);
    }

    // ── Per-candidate state. `setup` is the engine's own object, untouched.
    const pending = taken.map(setup => ({
      setup,
      bars: (stockDefs.find(s => s.symbol === setup.symbol) || { byDay: new Map() }).byDay.get(dayKey) || [],
      pos: null,
      done: false,
      triggered: false,
    }));

    for (const p of pending) {
      const s = p.setup;
      row.candidates.push({
        symbol: s.symbol, side: s.side, entry: s.entry, stop: s.stop, target: s.target,
        riskPts: s.riskPts, rewardPts: s.rewardPts, slBasis: s.slBasis, bigCandle: s.bigCandle,
        gapPct: s.gapPct, prevClose: s.prevClose, triggered: false,
      });
      console.log(`${LOG} ${dayStr}:   SETUP ${s.reason}`);
    }

    // ── Walk the day's bars for each candidate independently. Positions are
    //    independent (no shared capital model in this strategy), so a per-symbol
    //    walk is exactly equivalent to an interleaved one and far cheaper.
    let dayPnl = 0, dayTrades = 0;

    for (let pi = 0; pi < pending.length; pi++) {
      const p = pending[pi];
      const setup = p.setup;
      const stat = perSymbol.get(setup.symbol) ||
        { symbol: setup.symbol, trades: 0, wins: 0, pnl: 0, triggered: 0, untriggered: 0 };
      perSymbol.set(setup.symbol, stat);

      for (const bar of p.bars) {
        if (p.done) break;
        if (!_num(bar.time)) continue;

        // Bars are gated on their CLOSE time — bar start + resolution — the same
        // convention checkExitOnBar uses for the forced exit.
        const barCloseMins = istMinutes(bar.time) + cfg.resolutionMins;

        // The signal candle itself can never trigger its own breakout: entries
        // only open from EARLYBIRD_ENTRY_START, which is the bar AFTER 09:15.
        if (barCloseMins <= cfg.entryStartMin) continue;

        // ── ENTRY. Pending stop order at a frozen level. ────────────────────
        if (!p.pos) {
          if (barCloseMins > cfg.entryEndMin) {
            // Window closed with the order untouched. Nothing more can happen.
            p.done = true;
            break;
          }
          if (earlyBird.isEntryTriggeredOnBar(setup, bar)) {
            // FILL AT THE LEVEL, never at the bar's high/low. Slippage makes it
            // WORSE: a LONG pays up, a SHORT sells down.
            const fill = setup.side === "LONG" ? setup.entry + SLIP : setup.entry - SLIP;
            p.pos = {
              symbol: setup.symbol,
              side: setup.side,
              // stop/target are the ENGINE's frozen levels and are handed back to
              // it unchanged — slippage must not move the levels, only the fills.
              stop: setup.stop,
              target: setup.target,
              entryLevel: setup.entry,
              entryFill: _r2(fill),
              entryTime: bar.time,
            };
            p.triggered = true;
            row.triggered++;
            funnel.triggered++;
            stat.triggered++;
            if (row.candidates[pi]) row.candidates[pi].triggered = true;
            console.log(`${LOG} ${dayStr} ${istHHMMSS(bar.time)} ENTER ${setup.side} ${setup.symbol} @ ` +
              `${_r2(fill)} (level ${setup.entry} + ${SLIP} slip) | SL ${setup.stop} (${setup.slBasis}) | ` +
              `TGT ${setup.target} | risk ${setup.riskPts} | qty ${setup.qty}`);
            // FALLS THROUGH to the exit test on THIS SAME BAR. A bar that both
            // triggered the entry and took out the stop books the LOSS — see the
            // header. Skipping it here is exactly how a backtest flatters itself.
          }
        }

        // ── EXIT. The engine owns the ordering (gap-through at the open, stop
        //    before target, forced exit on close time). Nothing is second-guessed.
        if (p.pos) {
          const ex = earlyBird.checkExitOnBar(p.pos, bar, { cfg });
          if (ex && ex.exit && _num(ex.price)) {
            // Slippage makes the exit WORSE too: a LONG sells lower, a SHORT
            // buys back higher.
            const exitFill = p.pos.side === "LONG" ? ex.price - SLIP : ex.price + SLIP;
            const gross = earlyBird.computePnl(p.pos.side, p.pos.entryFill, exitFill, setup.qty);
            const chg   = _equityCharges(p.pos.entryFill, exitFill, setup.qty);
            const net   = _r2(gross - chg.total);

            const heldBars = Math.max(1, Math.round((bar.time - p.pos.entryTime) / 60 / cfg.resolutionMins) + 1);

            trades.push({
              symbol: setup.symbol,
              side: p.pos.side,
              entry: stampStr(p.pos.entryTime),
              exit:  stampStr(bar.time),
              entryTs: p.pos.entryTime,
              exitTs:  bar.time,
              ePrice: p.pos.entryFill,
              xPrice: _r2(exitFill),
              entryLevel: p.pos.entryLevel,
              sl: setup.stop,
              target: setup.target,
              riskPts: setup.riskPts,
              rewardPts: setup.rewardPts,
              slBasis: setup.slBasis,
              bigCandle: setup.bigCandle,
              gapPct: setup.gapPct,
              prevClose: setup.prevClose,
              qty: setup.qty,
              exitType: ex.exitType,
              reason: ex.reason,
              entryReason: setup.reason,
              grossPnl: gross,
              charges: chg.total,
              pnl: net,
              held: heldBars,
              strength: "STRONG",
            });

            exitTypes[ex.exitType] = (exitTypes[ex.exitType] || 0) + 1;
            sides[p.pos.side] = (sides[p.pos.side] || 0) + 1;
            dayPnl += net;
            dayTrades++;
            stat.trades++;
            stat.pnl = _r2(stat.pnl + net);
            if (net > 0) stat.wins++;

            console.log(`${LOG} ${dayStr} ${istHHMMSS(bar.time)} EXIT  ${p.pos.side} ${setup.symbol} @ ` +
              `${_r2(exitFill)} → ${ex.exitType} | ${ex.reason} | gross ₹${gross} − charges ₹${chg.total} = ₹${net} ` +
              `(${heldBars} bar(s))`);

            p.pos = null;
            p.done = true;   // no re-entry — one attempt per stock per day
            break;
          }
        }
      }

      // A position still open when the day's bars ran out. checkExitOnBar only
      // returns EOD on a bar that actually printed at/after the forced-exit time,
      // so a short session would otherwise carry the trade overnight — which this
      // strategy never does.
      if (p.pos) {
        const last = p.bars[p.bars.length - 1];
        if (last && _num(last.close)) {
          const exitFill = p.pos.side === "LONG" ? last.close - SLIP : last.close + SLIP;
          const gross = earlyBird.computePnl(p.pos.side, p.pos.entryFill, exitFill, setup.qty);
          const chg   = _equityCharges(p.pos.entryFill, exitFill, setup.qty);
          const net   = _r2(gross - chg.total);
          const heldBars = Math.max(1, Math.round((last.time - p.pos.entryTime) / 60 / cfg.resolutionMins) + 1);

          trades.push({
            symbol: setup.symbol,
            side: p.pos.side,
            entry: stampStr(p.pos.entryTime),
            exit:  stampStr(last.time),
            entryTs: p.pos.entryTime,
            exitTs:  last.time,
            ePrice: p.pos.entryFill,
            xPrice: _r2(exitFill),
            entryLevel: p.pos.entryLevel,
            sl: setup.stop,
            target: setup.target,
            riskPts: setup.riskPts,
            rewardPts: setup.rewardPts,
            slBasis: setup.slBasis,
            bigCandle: setup.bigCandle,
            gapPct: setup.gapPct,
            prevClose: setup.prevClose,
            qty: setup.qty,
            exitType: "EOD",
            reason: "EOD — last candle of the session, no forced-exit bar printed",
            entryReason: setup.reason,
            grossPnl: gross,
            charges: chg.total,
            pnl: net,
            held: heldBars,
            strength: "STRONG",
          });

          exitTypes.EOD = (exitTypes.EOD || 0) + 1;
          sides[p.pos.side] = (sides[p.pos.side] || 0) + 1;
          dayPnl += net;
          dayTrades++;
          stat.trades++;
          stat.pnl = _r2(stat.pnl + net);
          if (net > 0) stat.wins++;

          console.log(`${LOG} ${dayStr} ${istHHMMSS(last.time)} EXIT  ${p.pos.side} ${setup.symbol} @ ` +
            `${_r2(exitFill)} → EOD (last candle) | gross ₹${gross} − charges ₹${chg.total} = ₹${net}`);
        }
        p.pos = null;
        p.done = true;
      }

      // NEVER TRIGGERED. This is the headline statistic for this strategy and it
      // is counted, not hidden — a pending order the market never touched.
      if (!p.triggered) {
        row.untriggered++;
        funnel.untriggered++;
        stat.untriggered++;
        console.log(`${LOG} ${dayStr}:   NOT TRIGGERED ${setup.side} ${setup.symbol} — ` +
          `entry ${setup.entry} was never touched between ` +
          `${earlyBird._fmtMins(cfg.entryStartMin)} and ${earlyBird._fmtMins(cfg.entryEndMin)}`);
      }
    }

    row.pnl = _r2(dayPnl);
    row.trades = dayTrades;
    dayRows.push(row);

    console.log(`${LOG} ${dayStr}: DAY DONE — ${row.taken} taken, ${row.triggered} triggered, ` +
      `${row.untriggered} never triggered, ${dayTrades} closed trade(s), day P&L ₹${row.pnl}`);

    if (onProgress) onProgress(di + 1, dayKeys.length);
  }

  // Trades are collected per-symbol, so the flat list is out of time order. The
  // equity curve and the max-drawdown behind it are path-dependent, so the sort
  // is not cosmetic — an unsorted list produces a drawdown that never happened.
  trades.sort((a, b) => (a.entryTs - b.entryTs) || String(a.symbol).localeCompare(String(b.symbol)));

  return {
    trades, dayRows, noTrade, funnel, exitTypes, sides, niftyVerdicts,
    perSymbol: [...perSymbol.values()].sort((a, b) => b.pnl - a.pnl),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats. Independent of backtestUI's shared renderer because this page reports
// per-symbol and per-exit-type breakdowns the shared one has no slot for.
// ─────────────────────────────────────────────────────────────────────────────
function computeStats(trades) {
  const wins   = trades.filter(t => _num(t.pnl) && t.pnl > 0);
  const losses = trades.filter(t => _num(t.pnl) && t.pnl < 0);
  const total  = trades.reduce((a, t) => a + (_num(t.pnl) ? t.pnl : 0), 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss   = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));

  let eq = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    eq += (_num(t.pnl) ? t.pnl : 0);
    if (eq > peak) peak = eq;
    if (eq - peak < maxDD) maxDD = eq - peak;
  }

  const avgWin  = wins.length   ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const pf = grossLoss > 0 ? _r2(grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? _r2((wins.length / trades.length) * 100) : 0,
    totalPnl: _r2(total),
    grossProfit: _r2(grossProfit),
    grossLoss: _r2(grossLoss),
    totalCharges: _r2(trades.reduce((a, t) => a + (_num(t.charges) ? t.charges : 0), 0)),
    avgWin: _r2(avgWin),
    avgLoss: _r2(avgLoss),
    profitFactor: pf,
    expectancy: trades.length ? _r2(total / trades.length) : 0,
    maxDrawdown: _r2(maxDD),
    maxProfit: wins.length ? _r2(Math.max(...wins.map(t => t.pnl))) : 0,
    maxLoss: losses.length ? _r2(Math.min(...losses.map(t => t.pnl))) : 0,
  };
}

/** Win rate / net for an arbitrary subset — used by every breakdown table. */
function subsetStats(list) {
  const w = list.filter(t => _num(t.pnl) && t.pnl > 0).length;
  const pnl = list.reduce((a, t) => a + (_num(t.pnl) ? t.pnl : 0), 0);
  return { n: list.length, wins: w, winRate: list.length ? _r2((w / list.length) * 100) : 0, pnl: _r2(pnl) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Data assembly — the fetch phase of one job.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far back the DAILY fetch reaches beyond `from`. The gap rule needs the
 * close of the trading day BEFORE the first simulated day, and that day may be
 * behind a long weekend or a holiday cluster. 10 calendar days is comfortably
 * more than the longest NSE closure.
 */
function _dailyLookbackDays() {
  const v = parseInt(process.env.EARLYBIRD_BT_DAILY_LOOKBACK_DAYS, 10);
  return Number.isFinite(v) && v >= 1 ? v : 10;
}

async function assembleData(from, to, symbols, cfg, report) {
  const res = String(cfg.resolutionMins);
  const dailyFrom = shiftDateStr(from, -_dailyLookbackDays());

  // ── NIFTY first, on its own. If the index has no candles nothing else can be
  //    decided, and failing here gives a far clearer message than 220 symbols
  //    all reporting "no data".
  report(`Fetching NIFTY ${res}-min candles (${from} → ${to})…`, 6);
  const niftyRes = await getSeries(NIFTY_SYMBOL, res, from, to);
  const niftyCandles = niftyRes.candles;
  console.log(`${LOG} NIFTY: ${niftyCandles.length.toLocaleString()} ${res}-min candles` +
    `${niftyRes.cached ? " (disk cache)" : ""}`);

  if (!niftyCandles.length) {
    const err = new Error(
      `0 candles — Fyers token likely expired. ${NIFTY_SYMBOL} returned no historical candles for ` +
      `${from} → ${to}. In this repo an expired Fyers session returns no_data (zero candles), NOT an ` +
      `auth error, so an empty result here is a login problem far more often than a data problem. ` +
      `Log in to Fyers again, then retry.`
    );
    err.zeroCandles = true;
    throw err;
  }

  // ── Then every stock: ONE intraday call + ONE daily call each, for the WHOLE
  //    range, bounded by the concurrency limit and paced by the rate limiter.
  const limit = concurrency();
  const stocks = [];
  const noData = [];
  const failed = [];
  let cachedCount = 0;

  console.log(`${LOG} fetching ${symbols.length} symbol(s) × 2 series (${res}-min + daily) ` +
    `with ${limit} worker(s), ${rateLimits().rps} req/s / ${rateLimits().rpm} req/min`);

  const results = await mapLimit(symbols, limit, async (sym) => {
    const fySym = universe.fyersSymbol(sym);
    const intra = await getSeries(fySym, res, from, to);
    const daily = await getSeries(fySym, "D", dailyFrom, to);
    return { sym, intra, daily };
  }, (done, total) => {
    // 10% → 70% of the progress bar is the fetch; the walk is the rest.
    report(`Fetching history: ${done}/${total} symbols…`, 10 + Math.round((done / total) * 60));
  });

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const sym = symbols[i];
    if (!r || !r.ok) {
      failed.push({ symbol: sym, reason: (r && r.error) || "unknown fetch failure" });
      continue;
    }
    const { intra, daily } = r.value;
    if (intra.cached && daily.cached) cachedCount++;
    if (!intra.candles.length) { noData.push(sym); continue; }
    stocks.push({
      symbol: sym,
      byDay: groupIntradayByDay(intra.candles),
      prevIdx: buildPrevCloseIndex(daily.candles),
    });
  }

  console.log(`${LOG} fetch done — ${stocks.length} symbol(s) with data, ${noData.length} with none, ` +
    `${failed.length} failed, ${cachedCount} served entirely from disk cache`);
  if (noData.length) {
    console.log(`${LOG} no data (delisted, renamed, or not yet listed): ${noData.slice(0, 25).join(", ")}` +
      `${noData.length > 25 ? ` … +${noData.length - 25} more` : ""}`);
  }
  if (failed.length) {
    console.warn(`${LOG} ${failed.length} symbol(s) failed: ` +
      failed.slice(0, 5).map(f => `${f.symbol} (${String(f.reason).slice(0, 80)})`).join(" | "));
  }

  // ── The days to simulate: NIFTY's own trading days inside [from, to]. Using
  //    the index rather than the union of stock days keeps a single symbol's
  //    stray bar from inventing a session.
  const niftyByDay = groupIntradayByDay(niftyCandles);
  const dayKeys = [...niftyByDay.keys()]
    .filter(k => {
      const bars = niftyByDay.get(k);
      if (!bars || !bars.length) return false;
      const d = istDateStr(bars[0].time);
      return d >= from && d <= to;
    })
    .sort((a, b) => a - b);

  return { niftyByDay, stocks, dayKeys, noData, failed, cachedCount, niftyCandles: niftyCandles.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_CSS = `
:root{--bg:#060810;--panel:#0b1020;--border:#131a30;--text:#a0b8d8;--head:#e2e8f0;--muted:#6d85a8;--accent:${ACCENT};--green:#10b981;--red:#ef4444;}
:root[data-theme="light"]{--bg:#f4f6f9;--panel:#ffffff;--border:#e2e6ee;--text:#334155;--head:#0f172a;--muted:#64748b;}
*{box-sizing:border-box;}
/* sidebarCSS() owns the shell geometry (.app-shell flex, .sidebar fixed 200px,
   .main-content margin-left:200px and its 768px collapse). Everything below
   only paints — no margin-left, no display, no flex on .main-content — so the
   shared sidebar rules stay in force instead of being silently overridden. */
body{margin:0;font-family:'IBM Plex Mono',ui-monospace,monospace;background:var(--bg);color:var(--text);font-size:0.78rem;}
.main-content{padding:18px 22px calc(60px + env(safe-area-inset-bottom));}
h1{color:var(--head);font-size:1.05rem;margin:0 0 4px;}
h2{color:var(--head);font-size:0.82rem;margin:22px 0 8px;letter-spacing:0.04em;text-transform:uppercase;}
.sub{color:var(--muted);font-size:0.7rem;margin:0 0 16px;}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:14px;}
.notes{background:rgba(34,211,238,0.06);border:1px solid rgba(34,211,238,0.25);border-radius:8px;padding:10px 14px;font-size:0.7rem;line-height:1.65;color:var(--text);margin-bottom:14px;}
.notes b{color:var(--head);}
.warn{background:rgba(245,158,11,0.08);border-color:rgba(245,158,11,0.35);}
form{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;}
label{display:block;font-size:0.65rem;color:var(--muted);margin-bottom:4px;letter-spacing:0.05em;text-transform:uppercase;}
input,select{background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px 10px;font-family:inherit;font-size:0.76rem;min-height:44px;}
button{background:var(--accent);border:0;color:#04121a;font-weight:700;border-radius:6px;padding:10px 20px;font-family:inherit;font-size:0.78rem;cursor:pointer;min-height:44px;}
/* Cancel — only visible while a job is in flight. */
.cancel-btn{background:#3a1a1a;color:#f87171;border:1px solid #7f1d1d;}
/* Date presets. min-height 44px is the tap-target floor, NOT decoration: these
   are the densest controls on the page and the ones most often hit on a phone. */
.preset-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:0 0 8px;}
.preset-row-label{font-size:0.58rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;min-width:52px;}
.preset-btn{font-size:0.65rem;padding:3px 12px;min-height:44px;border-radius:6px;background:rgba(59,130,246,0.08);color:#60a5fa;border:1px solid rgba(59,130,246,0.25);cursor:pointer;font-family:inherit;font-weight:600;transition:background 0.15s;}
.preset-btn:hover:not([disabled]){background:rgba(59,130,246,0.2);}
.preset-btn[disabled]{opacity:0.3;cursor:not-allowed;}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;}
.sc{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px 12px;}
.sc-label{font-size:0.6rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;}
.sc-val{font-size:1.05rem;font-weight:700;color:var(--head);margin-top:3px;word-break:break-word;}
.sc-sub{font-size:0.6rem;color:var(--muted);margin-top:2px;}
.tbl-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:8px;}
table{border-collapse:collapse;width:100%;font-size:0.68rem;}
th{background:rgba(255,255,255,0.03);color:var(--muted);text-align:left;padding:7px 9px;font-weight:600;white-space:nowrap;position:sticky;top:0;}
td{padding:6px 9px;border-top:1px solid var(--border);white-space:nowrap;}
tr:hover td{background:rgba(255,255,255,0.02);}
.g{color:var(--green);}.r{color:var(--red);}.m{color:var(--muted);}
details{margin-bottom:12px;}
summary{cursor:pointer;color:var(--head);font-size:0.75rem;padding:9px 12px;background:var(--panel);border:1px solid var(--border);border-radius:8px;min-height:44px;display:flex;align-items:center;gap:8px;}
summary::-webkit-details-marker{color:var(--accent);}
details[open] summary{border-radius:8px 8px 0 0;}
.det-body{border:1px solid var(--border);border-top:0;border-radius:0 0 8px 8px;padding:10px;}
.pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:0.6rem;font-weight:700;}
.pill-long{background:rgba(16,185,129,0.15);color:var(--green);}
.pill-short{background:rgba(239,68,68,0.15);color:var(--red);}
.pill-sl{background:rgba(239,68,68,0.15);color:var(--red);}
.pill-target{background:rgba(16,185,129,0.15);color:var(--green);}
.pill-eod{background:rgba(148,163,184,0.15);color:var(--muted);}
.pill-none{background:rgba(148,163,184,0.12);color:var(--muted);}
/* CSV downloads. Real buttons rather than inline text links: at 440px a bare
   <a> inside a <p> is a ~14px-tall tap target, well under the 44px floor. */
.dl-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;}
.dl-link{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:6px;background:var(--panel);border:1px solid var(--border);color:var(--accent);text-decoration:none;font-size:0.72rem;font-weight:600;}
.dl-link:hover{border-color:var(--accent);}
/* ── MOBILE ────────────────────────────────────────────────────────────────
   Target is the user's iPhone 17 Pro Max, ~440px portrait. Two rules matter:
   the PAGE never scrolls sideways, and every wide table scrolls inside its own
   .tbl-scroll box. margin-left is deliberately NOT set here — sidebarCSS()'s
   own 768px block already zeroes it and adds overflow-x:clip; repeating it here
   only creates a second source of truth for the same geometry. */
@media(max-width:768px){
  /* The hamburger buildSidebar() renders is fixed at the top-left of the
     viewport, so the first line of content has to clear it or it prints under
     the bars. 46px is the button's own box. */
  .main-content{padding:14px 12px calc(60px + env(safe-area-inset-bottom));}
  h1{padding-left:46px;min-height:44px;display:flex;align-items:center;}
}
@media(max-width:640px){
  body{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);}
  .main-content{padding-left:10px;padding-right:10px;}
  .stat-grid{grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;}
  .sc-val{font-size:0.92rem;}
  /* min-width forces the table WIDER than the phone — that is the point. It
     overflows inside .tbl-scroll, which scrolls, instead of stretching the page. */
  .tbl-scroll table{min-width:640px;}
  form{flex-direction:column;align-items:stretch;}
  form>div{width:100%;}
  form input,form select,form button{width:100%;}
  .preset-row{gap:5px;}
  .preset-row-label{width:100%;min-width:0;margin-bottom:-2px;}
  .preset-btn{flex:1 1 auto;min-width:64px;padding:3px 8px;}
  .notes{font-size:0.66rem;}
  .det-body{padding:8px 6px;}
  /* Long free-text cells must wrap rather than push the table wider still. */
  td[style*="white-space:normal"]{min-width:180px;}
  .dl-row{flex-direction:column;}
  .dl-link{width:100%;justify-content:center;}
}`;

function _lightAttr() {
  try { return require("../utils/theme").resolveTheme() === "light" ? ' data-theme="light"' : ""; }
  catch (_) { return ""; }
}

function pageShell(title, body, activePage) {
  let sidebar = "";
  try { sidebar = buildSidebar(activePage || "earlyBirdBacktest"); } catch (_) { sidebar = ""; }
  return `<!DOCTYPE html><html${_lightAttr()}><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
${faviconLink()}<title>${escHtml(title)}</title>
<style>${sidebarCSS()}${modalCSS()}${PAGE_CSS}</style></head>
<body><div class="app-shell">${sidebar}<div class="main-content">${body}</div></div>
<script>${modalJS()}</script></body></html>`;
}

function fmtMoney(v) {
  if (!_num(v)) return "—";
  const s = `₹${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  return v < 0 ? `-${s}` : s;
}
function pnlCell(v) {
  if (!_num(v)) return `<td class="m">—</td>`;
  return `<td class="${v >= 0 ? "g" : "r"}" style="font-weight:700;">${fmtMoney(v)}</td>`;
}
function sidePill(side) {
  return `<span class="pill ${side === "SHORT" ? "pill-short" : "pill-long"}">${escHtml(side)}</span>`;
}
function exitPill(x) {
  const cls = x === "SL" ? "pill-sl" : x === "TARGET" ? "pill-target" : "pill-eod";
  return `<span class="pill ${cls}">${escHtml(x)}</span>`;
}
function num(v, dp) {
  return _num(v) ? v.toFixed(dp == null ? 2 : dp) : "—";
}

/**
 * The STOCK-LEG-ONLY banner, in the page rather than only in the console.
 *
 * runEarlyBirdBacktest() already console.warn()s this, but a user who set
 * EARLYBIRD_TRADE_MODE=option and never opens /logs sees only a wall of
 * "NO TRADE" days and reasonably concludes the strategy never fires. Same text,
 * same two cases, rendered where the result is actually read.
 *
 * Returns "" in plain "stock" mode — there is nothing missing to warn about.
 */
function tradeModeNoticeHTML() {
  const cfg = earlyBird.getConfig();
  if (!earlyBird.tradesStock(cfg)) {
    return `<div class="notes warn">
<b>EARLYBIRD_TRADE_MODE = "${escHtml(cfg.tradeMode)}" — this backtest will report NO TRADE for every day.</b>
This page simulates the <b>STOCK leg only</b>, and the current mode trades no stock leg. Simulating the
NIFTY option leg needs historical <b>premium</b> candles per strike, which Fyers delists at expiry, and
inventing them from a delta/theta model would be simulating the strategy rather than testing it — so the
option leg is deliberately not backtested. Set the mode to <b>stock</b> or <b>both</b> to get results here,
and paper-trade the option leg instead.
</div>`;
  }
  if (earlyBird.tradesOption(cfg)) {
    return `<div class="notes warn">
<b>EARLYBIRD_TRADE_MODE = "both" — the NIFTY option leg is NOT included in these figures.</b>
There are no historical option premiums to simulate it against, so everything below is
<b>stock-leg only</b>. The live/paper option leg's P&amp;L is additional to what this page reports.
</div>`;
  }
  return "";
}

// ── Date-range presets ───────────────────────────────────────────────────────
// setPreset() is COPIED VERBATIM from src/routes/allBacktest.js so the two pages
// cannot drift on what "last week" or "Mar" means. The only edits are the three
// element ids at the bottom (this page's form has no crumb bar to update).
const PRESET_ROWS_HTML = `
<div class="preset-row">
  <span class="preset-row-label">Recent</span>
  <button type="button" class="preset-btn" onclick="setPreset('thisWeek')">This week</button>
  <button type="button" class="preset-btn" onclick="setPreset('lastWeek')">Last week</button>
  <button type="button" class="preset-btn" onclick="setPreset('thisMonth')">This month</button>
  <button type="button" class="preset-btn" onclick="setPreset('lastMonth')">Last month</button>
  <button type="button" class="preset-btn" onclick="setPreset('last3')">Last 3 months</button>
  <button type="button" class="preset-btn" onclick="setPreset('last6')">Last 6 months</button>
  <button type="button" class="preset-btn" onclick="setPreset('thisYear')">This year</button>
  <button type="button" class="preset-btn" onclick="setPreset('lastYear')">Last year</button>
</div>
<div class="preset-row">
  <span class="preset-row-label">Multi-yr</span>
  <button type="button" class="preset-btn" onclick="setPreset('last2y')">Last 2 yr</button>
  <button type="button" class="preset-btn" onclick="setPreset('last3y')">Last 3 yr</button>
  <button type="button" class="preset-btn" onclick="setPreset('last4y')">Last 4 yr</button>
  <button type="button" class="preset-btn" onclick="setPreset('last5y')">Last 5 yr</button>
  <button type="button" class="preset-btn" onclick="setPreset('last6y')">Last 6 yr</button>
  <button type="button" class="preset-btn" onclick="setPreset('last7y')">Last 7 yr</button>
  <button type="button" class="preset-btn" onclick="setPreset('last8y')">Last 8 yr</button>
</div>`;

/** Per-year and per-month rows. Built per request — the year list moves. */
function presetYearMonthRowsHTML() {
  const cy = new Date().getFullYear();
  const years = Array.from({ length: 8 }, (_, i) => cy - i)
    .map(yr => `<button type="button" class="preset-btn" onclick="setPreset('y${yr}')">${yr}</button>`)
    .join("");
  const keys   = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const curMonth = new Date().getMonth();
  // A future month of the current year has no data — disabled, not hidden, so
  // the row keeps a stable 12-button shape.
  const months = keys.map((k, i) => i <= curMonth
    ? `<button type="button" class="preset-btn" onclick="setPreset('${k}')">${labels[i]}</button>`
    : `<button type="button" class="preset-btn" disabled>${labels[i]}</button>`).join("");
  return `
<div class="preset-row"><span class="preset-row-label">Year</span>${years}</div>
<div class="preset-row"><span class="preset-row-label">${cy}</span>${months}</div>`;
}

/**
 * VERBATIM from allBacktest.js setPreset(), except the final three lines: this
 * form's inputs are #eb-from / #eb-to and there is no #crumbRange to update.
 * Do not "tidy" it — matching allBacktest exactly is the point.
 */
const PRESET_JS = `
function setPreset(p){
  var d=new Date(),y=d.getFullYear(),m=d.getMonth(),day=d.getDay();
  function fmt(dt){var yy=dt.getFullYear(),mm=String(dt.getMonth()+1).padStart(2,'0'),dd=String(dt.getDate()).padStart(2,'0');return yy+'-'+mm+'-'+dd;}
  var today=fmt(d);
  var monday=new Date(d); monday.setDate(d.getDate()-(day===0?6:day-1));
  var lastWeekMon=new Date(monday); lastWeekMon.setDate(lastWeekMon.getDate()-7);
  var lastWeekFri=new Date(lastWeekMon); lastWeekFri.setDate(lastWeekFri.getDate()+4);
  var fromVal, toVal;
  var monthMap={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  if(monthMap.hasOwnProperty(p)){
    var mi=monthMap[p];
    fromVal=fmt(new Date(y,mi,1));
    toVal=(mi<m)?fmt(new Date(y,mi+1,0)):(mi===m?today:fmt(new Date(y,mi+1,0)));
  } else if(/^y\\d{4}$/.test(p)){
    var yr=parseInt(p.slice(1));
    fromVal=yr+'-01-01';
    toVal=(yr===y)?today:(yr+'-12-31');
  } else {
    var presets={
      thisWeek: [fmt(monday), today],
      lastWeek: [fmt(lastWeekMon), fmt(lastWeekFri)],
      thisMonth: [fmt(new Date(y,m,1)), today],
      lastMonth: [fmt(new Date(y,m-1,1)), fmt(new Date(y,m,0))],
      last3: [fmt(new Date(y,m-2,1)), today],
      last6: [fmt(new Date(y,m-5,1)), today],
      thisYear: [fmt(new Date(y,0,1)), today],
      lastYear: [fmt(new Date(y-1,0,1)), fmt(new Date(y-1,11,31))],
      last2y: [fmt(new Date(y-2,0,1)), today],
      last3y: [fmt(new Date(y-3,0,1)), today],
      last4y: [fmt(new Date(y-4,0,1)), today],
      last5y: [fmt(new Date(y-5,0,1)), today],
      last6y: [fmt(new Date(y-6,0,1)), today],
      last7y: [fmt(new Date(y-7,0,1)), today],
      last8y: [fmt(new Date(y-8,0,1)), today]
    };
    if(!presets[p]) return;
    fromVal=presets[p][0]; toVal=presets[p][1];
  }
  document.getElementById('eb-from').value=fromVal;
  document.getElementById('eb-to').value=toVal;
  var rl=document.getElementById('eb-range-label');
  if(rl) rl.textContent=fromVal+' \\u2192 '+toVal;
}`;

/**
 * Submit/Cancel wiring. The run itself is a background JOB — the GET navigates
 * to a progress page owned by backtestJobManager — so "Cancel" here can only
 * mean "I have not navigated yet, put the form back". It is shown ONLY between
 * submit and navigation, which is exactly the window in which it can act; once
 * the browser has left the page the progress page owns the run. It is therefore
 * NOT wired to any job-abort endpoint, and it does not pretend to be.
 */
const FORM_JS = `
(function(){
  var form=document.getElementById('eb-form');
  var run=document.getElementById('eb-run');
  var cancel=document.getElementById('eb-cancel');
  if(!form||!run||!cancel) return;
  form.addEventListener('submit',function(){
    run.disabled=true;
    run.textContent='Running\\u2026';
    cancel.style.display='';
  });
  cancel.addEventListener('click',function(){
    // The navigation is already in flight; stopping it is the browser's job.
    try{ window.stop(); }catch(e){}
    run.disabled=false;
    run.textContent='Run Backtest';
    cancel.style.display='none';
  });
})();`;

// ── The form ────────────────────────────────────────────────────────────────
function renderForm(from, to, universeKey) {
  const cfg = earlyBird.getConfig();
  let unis = [];
  try { unis = universe.listUniverses().universes || []; } catch (_) { unis = []; }
  if (!unis.length) unis = [{ key: "FNO", label: "F&O universe", count: 0 }];

  const opts = unis.map(u =>
    `<option value="${escHtml(u.key)}"${u.key === universeKey ? " selected" : ""}>${escHtml(u.label)} (${u.count})</option>`
  ).join("");

  const body = `
<h1>EarlyBird Backtest</h1>
<p class="sub">First-15-minute signal candle · NIFTY-confirmed · traded in <b>CASH EQUITY</b> on F&amp;O stocks</p>

${tradeModeNoticeHTML()}
<div class="notes">
<b>What this simulates:</b> NIFTY's ${earlyBird._fmtMins(cfg.sessionStartMin)} ${cfg.resolutionMins}-minute candle decides the day's direction
(<b>NIFTY is never traded</b>). Every universe stock's own ${earlyBird._fmtMins(cfg.sessionStartMin)} candle is tested for the same shape in the
same direction, gapped names beyond ${cfg.maxGapPct}% of the previous daily close are dropped, and the
${cfg.maxConcurrent} tightest-stop confirmations become pending stop orders. Entry ${cfg.entryBufferPts} away from the candle
edge, stop the other edge (or the <b>body edge</b> when the wick risk exceeds ${cfg.maxSlPts}), target 1:${cfg.targetRR}.
No new entries after <b>${earlyBird._fmtMins(cfg.entryEndMin)}</b>; everything still open squares off at <b>${earlyBird._fmtMins(cfg.forcedExitMin)}</b>.
Flat <b>${cfg.qty} shares</b> per stock. No options, no strike, no expiry anywhere on this page.
</div>

<div class="notes warn">
<b>Speed:</b> a run fetches <b>two history series per symbol</b> (${cfg.resolutionMins}-min + daily) for the whole range, once.
On a cold cache the full F&amp;O universe (~220 names) is ~440 Fyers calls, paced under the API's rate
limits — expect <b>several minutes</b>. Every series is cached on disk under
<code>~/trading-data/early_bird_bt_cache/</code>, so a repeat run of the same or a narrower range is near-instant.
<b>The default range is one month</b> for that reason; widen it deliberately.
</div>

<div class="panel">
<form method="GET" action="${ENDPOINT}" id="eb-form">
  <div><label for="eb-from">From</label><input id="eb-from" type="date" name="from" value="${escHtml(from)}" required/></div>
  <div><label for="eb-to">To</label><input id="eb-to" type="date" name="to" value="${escHtml(to)}" required/></div>
  <div><label for="eb-uni">Universe</label><select id="eb-uni" name="universe">${opts}</select></div>
  <div><button type="submit" id="eb-run">Run Backtest</button></div>
  <div><button type="button" id="eb-cancel" class="cancel-btn" style="display:none;">✕ Cancel</button></div>
  <div>${clearCacheButtonHTML()}</div>
</form>

<p class="sub" style="margin:14px 0 6px;">Selected range: <b id="eb-range-label">${escHtml(from)} → ${escHtml(to)}</b></p>
${PRESET_ROWS_HTML}
${presetYearMonthRowsHTML()}
</div>

<script>${PRESET_JS}
${FORM_JS}
${clearCacheJS()}</script>`;
  return pageShell("EarlyBird — Backtest", body, "earlyBirdBacktest");
}

// ── Per-day funnel table ────────────────────────────────────────────────────
function renderDayTable(dayRows) {
  if (!dayRows.length) return `<p class="m">No days simulated.</p>`;
  const rows = dayRows.map(d => {
    const nc = d.niftyCandle;
    const candle = nc
      ? `O ${num(nc.open)} H ${num(nc.high)} L ${num(nc.low)} C ${num(nc.close)}`
      : "—";
    const vpill = d.verdict === "NO SIGNAL" || d.verdict === "NO NIFTY DATA"
      ? `<span class="pill pill-none">${escHtml(d.verdict)}</span>`
      : `<span class="pill ${d.verdict.indexOf("LONG") >= 0 ? "pill-long" : "pill-short"}">${escHtml(d.verdict)}</span>`;
    return `<tr>
<td>${escHtml(d.date)}</td>
<td class="m" style="font-size:0.64rem;">${escHtml(candle)}</td>
<td>${vpill}</td>
<td>${d.scanned}</td>
<td>${d.confirmed}</td>
<td>${d.taken}</td>
<td class="${d.triggered ? "g" : "m"}">${d.triggered}</td>
<td class="${d.untriggered ? "r" : "m"}">${d.untriggered}</td>
<td>${d.trades}</td>
${pnlCell(d.pnl)}
<td class="m" style="font-size:0.62rem;max-width:340px;white-space:normal;">${escHtml(d.reason || "")}</td>
</tr>`;
  }).join("");

  return `<div class="tbl-scroll"><table>
<thead><tr>
<th>Date</th><th>NIFTY ${escHtml(earlyBird._fmtMins(earlyBird.getConfig().sessionStartMin))} candle</th><th>Verdict</th>
<th>Scanned</th><th>Confirmed</th><th>Taken</th><th>Triggered</th><th>Never triggered</th>
<th>Trades</th><th>Day P&amp;L</th><th>Reason</th>
</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ── Trade list ───────────────────────────────────────────────────────────────
function renderTradeTable(trades) {
  if (!trades.length) {
    return `<p class="m">No trades. If days were tradeable but nothing filled, look at the
    <b>never triggered</b> column — that is this strategy's characteristic outcome.</p>`;
  }
  const rows = trades.map(t => `<tr>
<td><b>${escHtml(t.symbol)}</b></td>
<td>${sidePill(t.side)}</td>
<td class="m" style="font-size:0.64rem;">${escHtml(t.entry)}</td>
<td class="m" style="font-size:0.64rem;">${escHtml(t.exit)}</td>
<td>${num(t.entryLevel)}</td>
<td>${num(t.ePrice)}</td>
<td class="r">${num(t.sl)}</td>
<td class="g">${num(t.target)}</td>
<td>${num(t.xPrice)}</td>
<td>${exitPill(t.exitType)}</td>
<td class="m">${num(t.riskPts)}</td>
<td class="m" style="font-size:0.62rem;">${escHtml(t.slBasis || "")}</td>
<td class="m">${num(t.gapPct)}%</td>
<td class="m">${t.qty}</td>
<td class="m">${fmtMoney(t.grossPnl)}</td>
<td class="m">${fmtMoney(t.charges)}</td>
${pnlCell(t.pnl)}
<td class="m">${t.held}</td>
<td class="m" style="font-size:0.62rem;max-width:300px;white-space:normal;">${escHtml(t.reason || "")}</td>
</tr>`).join("");

  return `<div class="tbl-scroll"><table>
<thead><tr>
<th>Symbol</th><th>Side</th><th>Entry time</th><th>Exit time</th>
<th>Level</th><th>Fill</th><th>SL</th><th>Target</th><th>Exit</th><th>Type</th>
<th>Risk</th><th>SL basis</th><th>Gap</th><th>Qty</th>
<th>Gross</th><th>Charges</th><th>Net</th><th>Bars</th><th>Exit reason</th>
</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderBreakdown(title, rowsHtml, headers) {
  return `<h2>${escHtml(title)}</h2><div class="tbl-scroll"><table>
<thead><tr>${headers.map(h => `<th>${escHtml(h)}</th>`).join("")}</tr></thead>
<tbody>${rowsHtml}</tbody></table></div>`;
}

function renderResults(from, to, universeKey, stats, result, meta) {
  const cfg = earlyBird.getConfig();
  const f = result.funnel;
  const inf = (x) => x === Infinity ? "∞" : x;

  // ── Breakdown by exit type
  const exitRows = ["SL", "TARGET", "EOD"].map(x => {
    const s = subsetStats(result.trades.filter(t => t.exitType === x));
    return `<tr><td>${exitPill(x)}</td><td>${s.n}</td><td>${s.wins}</td><td>${s.winRate}%</td>${pnlCell(s.pnl)}</tr>`;
  }).join("");

  // ── Breakdown by side
  const sideRows = ["LONG", "SHORT"].map(x => {
    const s = subsetStats(result.trades.filter(t => t.side === x));
    return `<tr><td>${sidePill(x)}</td><td>${s.n}</td><td>${s.wins}</td><td>${s.winRate}%</td>${pnlCell(s.pnl)}</tr>`;
  }).join("");

  // ── Breakdown per symbol
  const symRows = result.perSymbol.map(s => `<tr>
<td><b>${escHtml(s.symbol)}</b></td><td>${s.trades}</td><td>${s.wins}</td>
<td>${s.trades ? _r2((s.wins / s.trades) * 100) : 0}%</td>
${pnlCell(s.pnl)}<td class="m">${s.triggered}</td><td class="${s.untriggered ? "r" : "m"}">${s.untriggered}</td>
</tr>`).join("") || `<tr><td colspan="7" class="m">No symbol produced a setup.</td></tr>`;

  const verdictMix = Object.entries(result.niftyVerdicts)
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") || "—";

  const trigRate = f.taken ? _r2((f.triggered / f.taken) * 100) : 0;

  const body = `
<h1>EarlyBird Backtest — ${escHtml(from)} → ${escHtml(to)}</h1>
<p class="sub">${escHtml(universeKey)} universe · ${f.daysSeen} session(s) · cash equity, ${cfg.qty} shares/stock ·
<a href="${ENDPOINT}" style="color:var(--accent);">← new run</a></p>

${tradeModeNoticeHTML()}
<div class="notes">
<b>Direction:</b> NIFTY's ${earlyBird._fmtMins(cfg.sessionStartMin)} ${cfg.resolutionMins}-min candle only — NIFTY itself is never traded.
<b>Shape test:</b> body ≥ ${cfg.minBodyPct}% of range, opposing wick ≤ ${cfg.maxOpposingWickPct}%, applied identically to the index and to every stock.
<b>Gap rule:</b> stocks opening more than ${cfg.maxGapPct}% from the previous daily close are dropped; an unknown previous close is also a refusal.
<b>Levels:</b> entry ${cfg.entryBufferPts} beyond the candle edge, stop the opposite edge (or the <b>body edge</b> once wick risk exceeds ${cfg.maxSlPts}), target 1:${cfg.targetRR}. All frozen at ${earlyBird._fmtMins(cfg.sessionStartMin + cfg.resolutionMins)} — no trail, no breakeven, no partials, no re-entry.
<b>Fills:</b> a triggering bar fills <b>at the level</b>, never at its high/low. A bar that both triggered and stopped books the <b>loss</b> — the entry is not skipped.
<b>Windows:</b> entries ${earlyBird._fmtMins(cfg.entryStartMin)}–${earlyBird._fmtMins(cfg.entryEndMin)}, forced exit ${earlyBird._fmtMins(cfg.forcedExitMin)}.
<b>Costs:</b> ₹${slippagePts()} slippage <b>each way</b> (rupees on a stock price — one tick on a liquid name; raise <code>EARLYBIRD_BT_SLIPPAGE_PTS</code> to test a wider touch), plus equity-intraday charges.
</div>

<div class="notes warn">
<b>Charges caveat, stated plainly:</b> <code>src/utils/charges.js</code> has only an options and a futures path —
there is <b>no cash-equity-intraday path in that helper</b>. Billing option rates (STT 0.15% of premium,
exchange 0.03553% of premium turnover) against ₹-lakh equity turnover would overstate costs by an order of
magnitude, so this page computes equity-intraday charges itself: STT ${escHtml(process.env.EARLYBIRD_CHG_STT_PCT || "0.025")}% sell-side,
NSE txn ${escHtml(process.env.EARLYBIRD_CHG_EXCHANGE_PCT || "0.00297")}% of turnover, brokerage
${escHtml(process.env.EARLYBIRD_CHG_BROKERAGE_PCT || "0.03")}% capped at ₹${escHtml(process.env.EARLYBIRD_CHG_BROKERAGE_CAP || "20")}/leg,
GST ${escHtml(process.env.EARLYBIRD_CHG_GST_PCT || "18")}%, stamp ${escHtml(process.env.EARLYBIRD_CHG_STAMP_PCT || "0.003")}% buy-side, SEBI
₹${escHtml(process.env.EARLYBIRD_CHG_SEBI_PER_CRORE || "10")}/crore. Total billed across this run:
<b>${fmtMoney(stats.totalCharges)}</b>. <b>This strategy has never traded live or on paper — nothing here is validated.</b>
</div>

<h2>Headline</h2>
<div class="stat-grid">
  <div class="sc"><div class="sc-label">Net P&amp;L</div><div class="sc-val" style="color:${stats.totalPnl >= 0 ? "var(--green)" : "var(--red)"};">${fmtMoney(stats.totalPnl)}</div><div class="sc-sub">after slippage + charges</div></div>
  <div class="sc"><div class="sc-label">Trades</div><div class="sc-val">${stats.totalTrades}</div><div class="sc-sub">${stats.wins}W / ${stats.losses}L</div></div>
  <div class="sc"><div class="sc-label">Win Rate</div><div class="sc-val">${stats.winRate}%</div><div class="sc-sub">of closed trades</div></div>
  <div class="sc"><div class="sc-label">Profit Factor</div><div class="sc-val">${inf(stats.profitFactor)}</div><div class="sc-sub">gross win ÷ gross loss</div></div>
  <div class="sc"><div class="sc-label">Avg Win</div><div class="sc-val g">${fmtMoney(stats.avgWin)}</div><div class="sc-sub">${stats.wins} winners</div></div>
  <div class="sc"><div class="sc-label">Avg Loss</div><div class="sc-val r">${fmtMoney(stats.avgLoss)}</div><div class="sc-sub">${stats.losses} losers</div></div>
  <div class="sc"><div class="sc-label">Max Drawdown</div><div class="sc-val r">${fmtMoney(stats.maxDrawdown)}</div><div class="sc-sub">peak-to-trough equity</div></div>
  <div class="sc"><div class="sc-label">Expectancy</div><div class="sc-val">${fmtMoney(stats.expectancy)}</div><div class="sc-sub">per trade</div></div>
</div>

<h2>Funnel — where the days and the setups went</h2>
<div class="stat-grid">
  <div class="sc"><div class="sc-label">Sessions</div><div class="sc-val">${f.daysSeen}</div><div class="sc-sub">${f.tradeableDays} tradeable · ${f.noSignalDays} no-signal</div></div>
  <div class="sc"><div class="sc-label">Stocks scanned</div><div class="sc-val">${f.scanned.toLocaleString()}</div><div class="sc-sub">symbol-days examined</div></div>
  <div class="sc"><div class="sc-label">Confirmed</div><div class="sc-val">${f.confirmed.toLocaleString()}</div><div class="sc-sub">matched NIFTY's shape + direction</div></div>
  <div class="sc"><div class="sc-label">Taken</div><div class="sc-val">${f.taken}</div><div class="sc-sub">capped at ${cfg.maxConcurrent}/day, tightest risk first</div></div>
  <div class="sc"><div class="sc-label">Triggered</div><div class="sc-val g">${f.triggered}</div><div class="sc-sub">${trigRate}% of taken setups filled</div></div>
  <div class="sc"><div class="sc-label">NEVER triggered</div><div class="sc-val r">${f.untriggered}</div><div class="sc-sub">pending order untouched all session</div></div>
  <div class="sc"><div class="sc-label">NIFTY verdicts</div><div class="sc-val" style="font-size:0.72rem;">${escHtml(verdictMix)}</div><div class="sc-sub">index candle outcome mix</div></div>
  <div class="sc"><div class="sc-label">Data</div><div class="sc-val" style="font-size:0.72rem;">${meta.symbolsWithData}/${meta.symbolsRequested}</div><div class="sc-sub">symbols with history · ${meta.noData} none · ${meta.failed} failed</div></div>
</div>

${renderBreakdown("Breakdown by exit type", exitRows, ["Exit", "Trades", "Wins", "Win rate", "Net P&L"])}
${renderBreakdown("Breakdown by side", sideRows, ["Side", "Trades", "Wins", "Win rate", "Net P&L"])}

<details><summary>▸ Per-symbol breakdown (${result.perSymbol.length} symbol(s) with a setup)</summary>
<div class="det-body"><div class="tbl-scroll"><table>
<thead><tr><th>Symbol</th><th>Trades</th><th>Wins</th><th>Win rate</th><th>Net P&amp;L</th><th>Triggered</th><th>Never triggered</th></tr></thead>
<tbody>${symRows}</tbody></table></div></div></details>

<details open><summary>▸ Per-day funnel (${result.dayRows.length} session(s)) — NIFTY candle, verdict, scanned/confirmed/taken/triggered, day P&amp;L</summary>
<div class="det-body">${renderDayTable(result.dayRows)}</div></details>

<details open><summary>▸ All trades (${result.trades.length}) — entry / SL / target / exit / reason / SL basis</summary>
<div class="det-body">${renderTradeTable(result.trades)}</div></details>

<details><summary>▸ No-trade days (${result.noTrade.length}) — why nothing was taken</summary>
<div class="det-body"><div class="tbl-scroll"><table>
<thead><tr><th>Date</th><th>Reason</th></tr></thead><tbody>
${result.noTrade.map(d => `<tr><td>${escHtml(d.date)}</td><td class="m" style="white-space:normal;">${escHtml(d.reason)}</td></tr>`).join("") || `<tr><td colspan="2" class="m">Every session was tradeable.</td></tr>`}
</tbody></table></div></div></details>

<div class="dl-row">
<a class="dl-link" href="${ENDPOINT}/csv?jobId=${escHtml(meta.jobId || "")}">⤓ Download trades CSV</a>
<a class="dl-link" href="${ENDPOINT}/days.csv?jobId=${escHtml(meta.jobId || "")}">⤓ Download per-day funnel CSV</a>
</div>`;

  return pageShell(`EarlyBird Backtest — ${from} → ${to}`, body, "earlyBirdBacktest");
}

function renderErrorPage(msg, from, to) {
  const body = `
<h1 style="color:var(--red);">EarlyBird Backtest Failed</h1>
<div class="panel"><p style="white-space:pre-wrap;word-break:break-word;">${escHtml(msg)}</p>
<p class="m"><b>${escHtml(from || "")}</b> → <b>${escHtml(to || "")}</b></p></div>
<p><a href="${ENDPOINT}" style="color:var(--accent);">← Back</a></p>`;
  return pageShell("EarlyBird — Backtest Error", body, "earlyBirdBacktest");
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────
function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  return [headers.join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
  const job = backtestJobs.getJob(req.query.jobId);
  if (!job) return res.json({ status: "not_found" });
  res.json({ status: job.status, progress: job.progress, elapsed: Date.now() - job.startedAt, error: job.error });
});

router.get("/idle", (req, res) => {
  if (req.accepts(["json", "html"]) === "json" || req.query.json === "1") {
    return res.json({ idle: backtestJobs.isIdle() });
  }
  return res.redirect(ENDPOINT);
});

router.get("/result", (req, res) => {
  const job = req.query.jobId ? backtestJobs.getJob(req.query.jobId) : null;
  if (!job) return res.status(404).json({ error: "not_found" });
  if (job.status !== "done") return res.json({ status: job.status, error: job.error || null });
  const { stats, from, to, meta, result } = job.result;
  return res.json({
    status: "done", from, to, stats, meta,
    funnel: result.funnel, exitTypes: result.exitTypes, sides: result.sides,
    perSymbol: result.perSymbol, days: result.dayRows, trades: result.trades,
  });
});

router.get("/csv", (req, res) => {
  const job = req.query.jobId ? backtestJobs.getJob(req.query.jobId) : null;
  if (!job || job.status !== "done") return res.status(404).send("No finished run for that jobId.");
  const t = job.result.result.trades;
  const csv = toCsv(
    ["symbol", "side", "entryTime", "exitTime", "entryLevel", "entryFill", "sl", "target", "exitPrice",
     "exitType", "exitReason", "slBasis", "bigCandle", "riskPts", "rewardPts", "gapPct", "prevClose",
     "qty", "grossPnl", "charges", "netPnl", "barsHeld", "entryReason"],
    t.map(x => [x.symbol, x.side, x.entry, x.exit, x.entryLevel, x.ePrice, x.sl, x.target, x.xPrice,
      x.exitType, x.reason, x.slBasis, x.bigCandle, x.riskPts, x.rewardPts, x.gapPct, x.prevClose,
      x.qty, x.grossPnl, x.charges, x.pnl, x.held, x.entryReason])
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="earlybird_trades_${job.result.from}_${job.result.to}.csv"`);
  res.send(csv);
});

router.get("/days.csv", (req, res) => {
  const job = req.query.jobId ? backtestJobs.getJob(req.query.jobId) : null;
  if (!job || job.status !== "done") return res.status(404).send("No finished run for that jobId.");
  const d = job.result.result.dayRows;
  const csv = toCsv(
    ["date", "niftyOpen", "niftyHigh", "niftyLow", "niftyClose", "verdict",
     "scanned", "confirmed", "taken", "triggered", "neverTriggered", "trades", "dayPnl", "reason"],
    d.map(x => [x.date,
      x.niftyCandle ? x.niftyCandle.open : "", x.niftyCandle ? x.niftyCandle.high : "",
      x.niftyCandle ? x.niftyCandle.low : "", x.niftyCandle ? x.niftyCandle.close : "",
      x.verdict, x.scanned, x.confirmed, x.taken, x.triggered, x.untriggered, x.trades, x.pnl, x.reason])
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="earlybird_days_${job.result.from}_${job.result.to}.csv"`);
  res.send(csv);
});

router.get("/", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to   = typeof req.query.to   === "string" ? req.query.to.trim()   : "";
  const universeKey = (typeof req.query.universe === "string" && req.query.universe.trim())
    ? req.query.universe.trim().toUpperCase()
    : earlyBird.getConfig().universe;

  const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  // No range → the FORM, with a ONE-MONTH default. A wide range over ~220 names
  // is minutes of fetching on a cold cache, so the default must be something
  // that completes; the form says so out loud.
  if (!validDate(from) || !validDate(to)) {
    const today = todayIST();
    return res.send(renderForm(shiftDateStr(today, -30), today, universeKey));
  }
  if (from > to) {
    return res.status(400).send(renderErrorPage("'From' is after 'To'.", from, to));
  }

  // ── MEMORY CEILING — this refusal protects the LIVE TRADING PROCESS ────────
  // assembleData holds every symbol's candles in memory at once (one Map per
  // symbol, keyed by day), because the day loop needs random access across all
  // of them. That is fine for a month and fatal for a decade:
  //
  //     symbols × trading-days × ~25 bars/day × ~130 bytes
  //     220 names ×   1 month  ≈   14 MB      ← the default, comfortable
  //     220 names ×   1 year   ≈  170 MB
  //     220 names ×   3 years  ≈  510 MB      ← already half the budget
  //     220 names × 8.5 years  ≈ 1450 MB      ← impossible here
  //
  // ecosystem.config.js runs this process on a t3.micro with
  // --max-old-space-size=900 and max_memory_restart 940M. Blowing that does not
  // just fail the backtest: PM2 restarts the WHOLE BOT, killing any live or
  // paper session running at the time. So an over-large request is REFUSED up
  // front with the arithmetic shown, rather than being started and OOM-killed
  // half way through. EARLYBIRD_BT_MAX_SYMBOL_DAYS raises the ceiling for
  // anyone running on a bigger box.
  const _estDays = Math.max(1, Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1);
  const _estTradingDays = Math.max(1, Math.round(_estDays * (250 / 365)));
  const _symbolsForEstimate = universe.getUniverse(universeKey).length || 1;
  const _symbolDays = _symbolsForEstimate * _estTradingDays;
  const _maxSymbolDays = maxSymbolDays();
  if (_symbolDays > _maxSymbolDays) {
    const _estMb = Math.round((_symbolDays * 25 * 130) / 1048576);
    const _maxDaysForUniverse = Math.max(1, Math.floor(_maxSymbolDays / _symbolsForEstimate));
    return res.status(400).send(renderErrorPage(
      `That range is too large to hold in memory. ${_symbolsForEstimate} symbols × ~${_estTradingDays} trading days ` +
      `≈ ${_estMb} MB of candles, and this process is capped at 900 MB heap (t3.micro) — exceeding it would make ` +
      `PM2 restart the whole bot and kill any running paper or live session. ` +
      `With the "${universeKey}" universe (${_symbolsForEstimate} symbols) the safe limit is about ` +
      `${_maxDaysForUniverse} trading days (~${Math.max(1, Math.round(_maxDaysForUniverse / 21))} months). ` +
      `Either shorten the range, pick a smaller universe (NIFTY50 is ~4× lighter than FNO), or raise ` +
      `EARLYBIRD_BT_MAX_SYMBOL_DAYS if you are running on a larger machine.`,
      from, to));
  }

  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : "";

  if (!jobId) {
    const active = backtestJobs.getActiveJob();
    if (active) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "EarlyBird Backtest"));

    const symbols = universe.getUniverse(universeKey);
    if (!symbols.length) {
      return res.status(400).send(renderErrorPage(
        `Universe "${universeKey}" is empty or unknown. Known presets: ` +
        `${(universe.listUniverses().universes || []).map(u => u.key).join(", ")}.`, from, to));
    }

    const { id } = backtestJobs.createJob("early_bird");

    (async () => {
      try {
        const cfg = earlyBird.getConfig();
        const pruned = pruneCache(cacheRetainDays());
        console.log(`${LOG} job ${id}: ${from} → ${to} | universe ${universeKey} (${symbols.length} symbols) | ` +
          `${cfg.resolutionMins}-min | qty ${cfg.qty} | max ${cfg.maxConcurrent} concurrent | ` +
          `slippage ₹${slippagePts()}/side` + (pruned ? ` | pruned ${pruned} stale cache file(s)` : ""));
        console.log(`${LOG} job ${id}: rules — body ≥ ${cfg.minBodyPct}%, opposing wick ≤ ${cfg.maxOpposingWickPct}%, ` +
          `gap ≤ ${cfg.maxGapPct}%, buffer ${cfg.entryBufferPts}, RR 1:${cfg.targetRR}, max SL ${cfg.maxSlPts}, ` +
          `entries ${earlyBird._fmtMins(cfg.entryStartMin)}–${earlyBird._fmtMins(cfg.entryEndMin)}, ` +
          `forced exit ${earlyBird._fmtMins(cfg.forcedExitMin)}`);

        const report = (phase, pct) => backtestJobs.updateProgress(id, { phase, pct });

        let data;
        try {
          data = await assembleData(from, to, symbols, cfg, report);
        } catch (err) {
          const msg = err && err.zeroCandles ? err.message : fyersErrText(err);
          console.warn(`${LOG} job ${id}: fetch refused — ${String(msg).slice(0, 300)}`);
          backtestJobs.failJob(id, String(msg).slice(0, 900));
          return;
        }

        if (!data.dayKeys.length) {
          backtestJobs.failJob(id,
            `No NIFTY trading sessions inside ${from} → ${to}. ${data.niftyCandles} NIFTY candle(s) were ` +
            `returned but none fell in the requested range — check the dates, or widen the range.`);
          return;
        }
        if (!data.stocks.length) {
          backtestJobs.failJob(id,
            `0 candles — Fyers token likely expired. Not one of the ${symbols.length} ${universeKey} symbols ` +
            `returned intraday history for ${from} → ${to}. An expired Fyers session returns no_data (zero ` +
            `candles), NOT an auth error, so a universe-wide blank is a login problem far more often than a ` +
            `data problem. ${data.failed.length} symbol(s) failed outright` +
            `${data.failed.length ? `: ${data.failed.slice(0, 3).map(f => `${f.symbol} — ${String(f.reason).slice(0, 90)}`).join(" | ")}` : ""}. ` +
            `Log in to Fyers again, then retry.`);
          return;
        }

        report(`Simulating ${data.dayKeys.length} session(s) over ${data.stocks.length} symbol(s)…`, 72);
        const result = runEarlyBirdBacktest(data, (done, total) => {
          report(`Simulating day ${done}/${total}…`, 72 + Math.round((done / total) * 25));
        });

        const stats = computeStats(result.trades);

        console.log(`${LOG} job ${id}: FUNNEL — ${result.funnel.daysSeen} session(s) | ` +
          `${result.funnel.tradeableDays} tradeable / ${result.funnel.noSignalDays} no-signal | ` +
          `${result.funnel.scanned} symbol-days scanned → ${result.funnel.confirmed} confirmed → ` +
          `${result.funnel.taken} taken → ${result.funnel.triggered} triggered, ` +
          `${result.funnel.untriggered} NEVER triggered`);
        console.log(`${LOG} job ${id}: exits — SL ${result.exitTypes.SL || 0} / ` +
          `TARGET ${result.exitTypes.TARGET || 0} / EOD ${result.exitTypes.EOD || 0} | ` +
          `sides — LONG ${result.sides.LONG || 0} / SHORT ${result.sides.SHORT || 0}`);
        console.log(`${LOG} job ${id}: RESULT — ${stats.totalTrades} trade(s), ${stats.winRate}% WR, ` +
          `net ₹${stats.totalPnl} (gross ₹${_r2(stats.totalPnl + stats.totalCharges)} − charges ` +
          `₹${stats.totalCharges}), PF ${stats.profitFactor === Infinity ? "∞" : stats.profitFactor}, ` +
          `max DD ₹${stats.maxDrawdown}`);

        try {
          saveResult(RESULT_KEY, {
            summary: stats,
            params: { from, to, universe: universeKey, resolution: String(cfg.resolutionMins), qty: cfg.qty },
          });
        } catch (e) { console.warn(`${LOG} saveResult failed: ${e.message}`); }

        backtestJobs.completeJob(id, {
          from, to, universeKey, stats, result,
          meta: {
            jobId: id,
            symbolsRequested: symbols.length,
            symbolsWithData: data.stocks.length,
            noData: data.noData.length,
            failed: data.failed.length,
            cachedCount: data.cachedCount,
            niftyCandles: data.niftyCandles,
            slippage: slippagePts(),
          },
        });
        console.log(`${LOG} job ${id} complete.`);
      } catch (err) {
        console.error(`${LOG} job ${id} error:`, err);
        backtestJobs.failJob(id, (err && err.message) || String(err));
      }
    })();

    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "EarlyBird Backtest"));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "EarlyBird Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));

  const r = job.result;
  return res.send(renderResults(r.from, r.to, r.universeKey, r.stats, r.result, r.meta));
});

module.exports = router;

// ── Exposed for offline unit testing (no Fyers token, no HTTP). ──────────────
module.exports.runEarlyBirdBacktest = runEarlyBirdBacktest;
module.exports.computeStats = computeStats;
module.exports.groupIntradayByDay = groupIntradayByDay;
module.exports.buildPrevCloseIndex = buildPrevCloseIndex;
module.exports.assembleData = assembleData;
module.exports.shiftDateStr = shiftDateStr;
module.exports._equityCharges = _equityCharges;
module.exports._setHistoryFn = _setHistoryFn;
module.exports._resetHistoryFn = _resetHistoryFn;
module.exports._resetRateLimiter = _resetRateLimiter;
module.exports.CACHE_DIR = CACHE_DIR;

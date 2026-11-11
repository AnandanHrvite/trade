/**
 * marketData.js — ONE broker call, shared by every strategy that wants the data.
 * ─────────────────────────────────────────────────────────────────────────────
 * Every paper route used to ask Fyers for the same things on its own: token
 * check, holiday/trading-day check, live spot, option-symbol validation, warm-up
 * history, option LTP. A dashboard "Start All" therefore fired ~18 copies of
 * each call. This module sits between the routes and the broker and makes
 * concurrent and back-to-back callers share one upstream call.
 *
 * Same arguments, same returned shape, same error/empty semantics as the direct
 * call it replaces — each function delegates to the original implementation,
 * looked up at CALL time (so a stub installed on the original module — tests,
 * tickReplay — is honoured). Sharing never changes WHAT the data is, only how
 * many times it is fetched:
 *
 *   · in-flight de-duplication  — a caller that arrives while an identical call
 *     is already on the wire waits for that call instead of issuing its own.
 *     It receives what a direct call issued a few hundred ms earlier would have.
 *   · short TTL                 — only where the answer provably cannot have
 *     changed inside the window (see each function). Live price data is never
 *     served from a TTL.
 *   · deep copies               — every caller gets its own copy, so no strategy
 *     can mutate another's candles or quote rows.
 *   · failures are never cached — a rejected call is shared only by the callers
 *     already waiting on it; the next caller tries again, exactly as before.
 *
 * Replay: while tickReplay has its stubs installed (isReplayInProgress), every
 * function is a pure pass-through — no sharing, no cache read or write — so a
 * replay is byte-for-byte what it was before this module existed.
 *
 * Settings (Server & Broker → Shared Market Data):
 *   MARKET_DATA_SHARED          "true"  master switch; "false" = every call direct
 *   MARKET_DATA_TTL_SEC         30      reuse window for answers that cannot change
 *   MARKET_DATA_QUOTE_BATCH_MS  20      how long the quote hub collects requests
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// Fyers v3 /data/quotes accepts at most 50 symbols per request.
const QUOTE_MAX_SYMBOLS = 50;

// Pre-market cut-off for reusing a history response that reaches today: before
// 09:00 IST no session bar for today exists (NSE pre-open starts at 09:00), so a
// response taken earlier the same morning is still exactly what Fyers would send.
const PREMARKET_CUTOFF_MIN = 9 * 60;

const IST_MS = 19800000;

// ── Config (read per call — Settings saves mutate process.env live) ─────────

function _num(raw, def, min, max) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function sharingEnabled() {
  return String(process.env.MARKET_DATA_SHARED || "true").toLowerCase() !== "false";
}

function ttlMs() {
  return _num(process.env.MARKET_DATA_TTL_SEC || "30", 30, 0, 600) * 1000;
}

function quoteBatchMs() {
  return _num(process.env.MARKET_DATA_QUOTE_BATCH_MS || "20", 20, 0, 250);
}

// A replay can only be in progress once tickReplay has been loaded, so look it up
// in the module cache rather than require() it — loading that module here would
// pull the whole replay stack into processes (and tests) that never replay.
let _tickReplayPath = null;
function _replayActive() {
  try {
    if (!_tickReplayPath) _tickReplayPath = require.resolve("./tickReplay");
    const m = require.cache[_tickReplayPath];
    return !!(m && m.exports && typeof m.exports.isReplayInProgress === "function" && m.exports.isReplayInProgress());
  } catch (_) { return false; }
}

/** True when calls may be shared. False ⇒ every function is a direct pass-through. */
function _active() {
  return sharingEnabled() && !_replayActive();
}

// ── Deep copy (Node 16 on EC2 has no structuredClone) ───────────────────────

function deepCopy(v) {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = deepCopy(v[i]);
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;   // Error, Map, class instance — hand back as is
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepCopy(v[k]);
  return out;
}

// ── Generic share primitive ─────────────────────────────────────────────────

const _inflight = new Map();   // key → Promise (raw value, never handed out directly)
const _cache    = new Map();   // key → { at, value }
const _stats    = { upstream: 0, joined: 0, cacheHits: 0 };

/**
 * Run `fn` once for every concurrent caller with the same `key`.
 *
 * @param {string}   key
 * @param {Function} fn                 zero-arg, returns a value or a promise
 * @param {object}   [o]
 * @param {number}   [o.ttlMs=0]        reuse a SUCCESSFUL result for this long
 * @param {Function} [o.cacheIf]        (value) → bool: is this result cacheable
 * @param {Function} [o.reusable]       (entry, now) → bool: may this cached entry serve now
 * @returns {Promise<*>} a deep copy of the shared result (rejects with the shared error)
 */
function share(key, fn, o = {}) {
  if (!_active()) return fn();
  const ttl = o.ttlMs || 0;
  const now = Date.now();
  if (ttl > 0) {
    const hit = _cache.get(key);
    if (hit && now - hit.at < ttl && (!o.reusable || o.reusable(hit, now))) {
      _stats.cacheHits++;
      return Promise.resolve(deepCopy(hit.value));
    }
    if (hit && now - hit.at >= ttl) _cache.delete(key);
    if (_cache.size > 200) {
      // Keys carry dates/minutes, so old ones are never asked for again — sweep them.
      for (const [k, e] of _cache) if (now - e.at >= 600000) _cache.delete(k);
    }
  }
  let p = _inflight.get(key);
  if (p) {
    _stats.joined++;
  } else {
    _stats.upstream++;
    const startedAt = now;
    p = (async () => {
      try {
        const v = await fn();
        if (ttl > 0 && (!o.cacheIf || o.cacheIf(v))) _cache.set(key, { at: startedAt, value: deepCopy(v) });
        return v;
      } finally {
        if (_inflight.get(key) === p) _inflight.delete(key);
      }
    })();
    _inflight.set(key, p);
  }
  return p.then(deepCopy);
}

// ── IST helpers ─────────────────────────────────────────────────────────────

function _istParts(ms) {
  const d = new Date(ms + IST_MS);
  return { date: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), iso: d.toISOString() };
}

// ── Reference checks ────────────────────────────────────────────────────────

/**
 * fyersAuthCheck.verifyFyersToken, shared. That module already caches an OK for
 * 10 s and never caches a failure; this only adds in-flight sharing, keyed by the
 * token so a re-login mid-flight never joins the check of the old token.
 */
function verifyFyersToken() {
  const impl = () => require("../utils/fyersAuthCheck").verifyFyersToken();
  return share(`verifyFyersToken:${process.env.ACCESS_TOKEN || ""}`, impl);
}

/**
 * nseHolidays.isTradingAllowed, shared. Its answer depends only on the IST
 * minute (weekday, holiday list, 07:00–16:00 window, the minute in the reason
 * text), so the key carries the IST minute and a TTL can never hand back an
 * answer from a different minute.
 */
function isTradingAllowed() {
  const impl = () => require("../utils/nseHolidays").isTradingAllowed();
  const ist = _istParts(Date.now());
  return share(`isTradingAllowed:${ist.date}:${ist.mins}`, impl, { ttlMs: ttlMs() });
}

/** nseHolidays.isExpiryDay, shared. A per-IST-day answer, keyed by the IST day. */
function isExpiryDay() {
  const impl = () => require("../utils/nseHolidays").isExpiryDay();
  return share(`isExpiryDay:${_istParts(Date.now()).date}`, impl, { ttlMs: ttlMs() });
}

/**
 * instrument.getLiveSpot, shared in flight per underlying. instrument keeps its
 * own 60 s per-underlying cache; what it lacked was in-flight sharing — a cold
 * Start All sent one quote request per strategy before the first one landed.
 */
function getLiveSpot(underlying) {
  const instrument = require("../config/instrument");
  let key;
  try { key = instrument.underlyingOf(underlying).key; } catch (_) { return instrument.getLiveSpot(underlying); }
  return share(`spot:${key}`, () => instrument.getLiveSpot(underlying));
}

/**
 * instrument.validateAndGetOptionSymbol — same signature, same result. The
 * broker calls inside it (the option-chain expiry lookup and the getQuotes
 * contract check) are what get shared, from instrument.js, via
 * sharedOptionChainExpiry() and getQuotes(…, { maxAgeMs }). Sharing at that level
 * lets strategies that pick different strikes still share the chain call, and
 * strategies on the same strike share the contract check.
 */
function validateAndGetOptionSymbol(spot, side, mode, opts) {
  const instrument = require("../config/instrument");
  return opts === undefined
    ? instrument.validateAndGetOptionSymbol(spot, side, mode)
    : instrument.validateAndGetOptionSymbol(spot, side, mode, opts);
}

/**
 * Shared wrapper for instrument's option-chain "nearest expiry" lookup. Only a
 * real Date is cached (a null means the lookup failed — the next caller must try
 * again, as it always did). The nearest listed expiry only changes overnight, and
 * the caller re-checks staleness against the clock itself, so TTL reuse is safe.
 */
function sharedOptionChainExpiry(underlyingKey, fn) {
  return share(`optionChainExpiry:${underlyingKey}`, fn, {
    ttlMs: ttlMs(),
    cacheIf: (v) => v instanceof Date && !isNaN(v.getTime()),
  });
}

// ── Warm-up / session history ───────────────────────────────────────────────

function _resMs(resolution) {
  const r = String(resolution || "").toUpperCase();
  if (r === "D" || r === "1D") return 86400000;
  const n = parseInt(r, 10);
  return Number.isFinite(n) && n > 0 ? n * 60000 : null;
}

function _dateOnly(x) {
  if (x instanceof Date) return isNaN(x.getTime()) ? null : _istParts(x.getTime()).date;
  const s = String(x == null ? "" : x);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{9,11}$/.test(s)) return _istParts(Number(s) * 1000).date;
  return null;
}

/**
 * May a cached history response stand in for a fresh fetch right now?
 *
 * Only when no bar it contains (or could contain) can have changed:
 *   · the requested range ends BEFORE today (IST) — closed history, immutable; or
 *   · it was fetched before 09:00 IST today, it is still before 09:00 IST today,
 *     and it holds no bar dated today — nothing for today exists yet.
 * Any range that reaches into a live session is never reused from the TTL — the
 * forming bar would be stale and a bar that closed meanwhile would be missing,
 * which is exactly the gappy series the routes bypass candleCache to avoid.
 * Concurrent callers still share the in-flight fetch.
 */
function _historyReusable(entry, now, to) {
  const ist = _istParts(now);
  const fetched = _istParts(entry.at);
  if (fetched.date !== ist.date) return false;
  const toDate = _dateOnly(to);
  if (toDate && toDate < ist.date) return true;
  if (fetched.mins >= PREMARKET_CUTOFF_MIN || ist.mins >= PREMARKET_CUTOFF_MIN) return false;
  const bars = Array.isArray(entry.value) ? entry.value : [];
  const startOfTodaySec = Math.floor((Date.parse(`${ist.date}T00:00:00Z`) - IST_MS) / 1000);
  return !bars.some((c) => c && Number(c.time) >= startOfTodaySec);
}

/**
 * backtestEngine.fetchCandles, shared — same arguments, same array, same
 * throw. One fetch per (symbol, resolution, from, to); every caller gets its own
 * deep copy. A call with the optional 5th `opts` argument is passed straight
 * through (it can carry a progress callback that must be per-caller).
 */
function fetchCandles(symbol, resolution, from, to, opts) {
  const impl = () => (opts === undefined
    ? require("./backtestEngine").fetchCandles(symbol, resolution, from, to)
    : require("./backtestEngine").fetchCandles(symbol, resolution, from, to, opts));
  if (opts !== undefined || _resMs(resolution) == null) return impl();
  const key = `history:${symbol}|${String(resolution)}|${String(from)}|${String(to)}`;
  const fetchedAt = Date.now();
  return share(key, impl, {
    ttlMs: ttlMs(),
    // Keep only a series that could ever be served again (a live-session series
    // never is — holding it would only cost memory).
    cacheIf: (v) => Array.isArray(v) && v.length > 0 && _historyReusable({ at: fetchedAt, value: v }, fetchedAt, to),
    reusable: (entry, now) => _historyReusable(entry, now, to),
  });
}

// ── Quote hub ───────────────────────────────────────────────────────────────
//
// fyers.getQuotes, batched. Requests arriving within MARKET_DATA_QUOTE_BATCH_MS
// are merged into one upstream call per ≤50 distinct symbols; a symbol already on
// the wire is joined instead of re-requested. Each caller gets a response built
// for exactly the symbols it asked for, in its order.
//
// Exactness rules — a caller never sees anything a direct call could not return:
//   · if the upstream batch WAS exactly the caller's symbol list, the caller gets
//     that raw response (or its thrown error) — it is the direct response;
//   · otherwise a clean batch is re-cut per caller: top-level fields + the rows
//     for its symbols;
//   · anything irregular for a merged request (top-level error, throw, a symbol
//     missing from the reply) falls back to a DIRECT getQuotes for that caller's
//     own list, so error shapes are always the broker's own.
//   · `maxAgeMs` (contract validation only) may reuse a clean row seen within the
//     window — existence of a contract does not change inside seconds. Price
//     callers never pass it, so a price is never served from a cache.

const _qInflight = new Map();   // symbol → Promise<part>
const _qRecent   = new Map();   // symbol → { at, top, row }  (clean rows only)
let   _qPending  = null;        // { syms: [], waiters: Map<sym, resolve> }
const _qStats    = { upstream: 0, requests: 0, joined: 0, recentHits: 0, fallbacks: 0 };

function _topOf(resp) {
  const top = {};
  for (const k of Object.keys(resp || {})) if (k !== "d") top[k] = resp[k];
  return top;
}

function _cleanRow(row) {
  if (!row || typeof row !== "object") return false;
  if (row.s === "error") return false;
  const v = row.v || {};
  return !v.errmsg;
}

function _rememberRow(sym, top, row, at) {
  if (!_cleanRow(row)) return;
  _qRecent.set(sym, { at, top: deepCopy(top), row: deepCopy(row) });
  if (_qRecent.size > 500) {
    const cutoff = Date.now() - 5 * 60000;
    for (const [s, r] of _qRecent) if (r.at < cutoff) _qRecent.delete(s);
  }
}

async function _flushQuotes() {
  const batch = _qPending;
  _qPending = null;
  if (!batch) return;
  try {
    await _flushBatch(batch);
  } finally {
    // Never leave a waiter hanging: anything not answered above (an unexpected
    // throw) gets a failure part, which makes its caller fall back to a direct call.
    for (const resolve of batch.waiters.values()) resolve({ ok: false });
  }
}

async function _flushBatch(batch) {
  const fyers = require("../config/fyers");
  const chunks = [];
  for (let i = 0; i < batch.syms.length; i += QUOTE_MAX_SYMBOLS) chunks.push(batch.syms.slice(i, i + QUOTE_MAX_SYMBOLS));
  await Promise.all(chunks.map(async (chunk) => {
    const at = Date.now();
    let resp, err, threw = false;
    _qStats.upstream++;
    try { resp = await fyers.getQuotes(chunk); } catch (e) { err = e; threw = true; }
    const ok = !threw && resp && resp.s === "ok" && Array.isArray(resp.d);
    const byName = new Map();
    if (ok) {
      for (const row of resp.d) if (row && typeof row.n === "string" && !byName.has(row.n)) byName.set(row.n, row);
      // A one-symbol reply whose single row carries no name is still that symbol's row.
      if (chunk.length === 1 && resp.d.length === 1 && !byName.size) byName.set(chunk[0], resp.d[0]);
    }
    const top = ok ? _topOf(resp) : null;
    for (const sym of chunk) {
      const row = ok ? byName.get(sym) : undefined;
      const part = { chunk, resp, err, threw, ok: !!(ok && row), top, row };
      if (part.ok) _rememberRow(sym, top, row, at);
      const resolve = batch.waiters.get(sym);
      if (resolve) resolve(part);
    }
  }));
}

function _enqueueQuote(sym) {
  if (!_qPending) {
    _qPending = { syms: [], waiters: new Map() };
    // Deliberately NOT unref'd — every waiter in the batch depends on this timer.
    setTimeout(() => { _flushQuotes().catch(() => {}); }, quoteBatchMs());
  }
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  _qPending.syms.push(sym);
  _qPending.waiters.set(sym, resolve);
  _qInflight.set(sym, p);
  p.then(() => { if (_qInflight.get(sym) === p) _qInflight.delete(sym); });
  return p;
}

// Fyers -50 = an invalid/unknown symbol in the request: one bad symbol can sink a
// merged batch, so that error alone is retried per caller.
function _isSymbolError(resp) {
  return !!resp && (resp.code === -50 || /invalid symbol/i.test(String(resp.message || "")));
}

function _sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * fyers.getQuotes(symbols) — shared and batched. Same argument, same response
 * shape, same throw.
 * @param {string[]} symbols
 * @param {{maxAgeMs?: number}} [opts]  contract-validation only — see above
 */
function getQuotes(symbols, opts = {}) {
  const list = Array.isArray(symbols) ? symbols : null;
  // Not async on purpose: the pass-through returns the broker's own promise, so a
  // replay (or MARKET_DATA_SHARED=false) awaits exactly what it awaited before.
  if (!_active() || !list || !list.length
      || list.some((s) => typeof s !== "string" || !s)
      || new Set(list).size !== list.length) {
    return require("../config/fyers").getQuotes(symbols);
  }
  return _hubRequest(list, opts || {});
}

async function _hubRequest(list, opts) {
  const fyers = require("../config/fyers");
  _qStats.requests++;
  const maxAgeMs = opts && opts.maxAgeMs > 0 ? opts.maxAgeMs : 0;
  const now = Date.now();
  const parts = await Promise.all(list.map((sym) => {
    if (maxAgeMs) {
      const r = _qRecent.get(sym);
      if (r && now - r.at < maxAgeMs) { _qStats.recentHits++; return { ok: true, top: r.top, row: r.row, recent: true }; }
    }
    const inflight = _qInflight.get(sym);
    if (inflight) { _qStats.joined++; return inflight; }
    return _enqueueQuote(sym);
  }));

  // The upstream call was exactly this request → its raw outcome IS the direct one.
  const first = parts[0];
  if (!first.recent && first.chunk && _sameList(first.chunk, list) && parts.every((p) => p.chunk === first.chunk)) {
    if (first.threw) throw first.err;
    return deepCopy(first.resp);
  }
  if (parts.every((p) => p.ok)) {
    return { ...deepCopy(first.top), d: parts.map((p) => deepCopy(p.row)) };
  }
  // A merged call that failed as a WHOLE (pacer "no free slot", timeout, auth,
  // rate limit) failed for this caller too: hand back that same outcome rather
  // than queuing a second direct call behind the already-full pacer, which would
  // double the wait at exactly the busiest moment. Only a symbol-level failure
  // (a missing row, or the broker rejecting a symbol in the batch) falls back.
  const whole = parts.find((p) => !p.ok && !p.recent && (p.threw || (p.resp && p.resp.s !== "ok" && !_isSymbolError(p.resp))));
  if (whole) {
    if (whole.threw) throw whole.err;
    return deepCopy(whole.resp);
  }
  _qStats.fallbacks++;
  return fyers.getQuotes(list);
}

// ── Introspection / tests ───────────────────────────────────────────────────

function stats() {
  return { ..._stats, quotes: { ..._qStats }, cached: _cache.size, inflight: _inflight.size };
}

/** Drop every cached answer (tickReplay calls this around a run; tests between cases). */
function resetCache() {
  _inflight.clear();
  _cache.clear();
  _qRecent.clear();
  _qInflight.clear();
  for (const k of Object.keys(_stats)) _stats[k] = 0;
  for (const k of Object.keys(_qStats)) _qStats[k] = 0;
}

module.exports = {
  // reference checks
  verifyFyersToken,
  isTradingAllowed,
  isExpiryDay,
  getLiveSpot,
  validateAndGetOptionSymbol,
  sharedOptionChainExpiry,
  // history
  fetchCandles,
  // quotes
  getQuotes,
  // primitives + config
  share,
  deepCopy,
  ttlMs,
  quoteBatchMs,
  sharingEnabled,
  stats,
  resetCache,
  QUOTE_MAX_SYMBOLS,
};

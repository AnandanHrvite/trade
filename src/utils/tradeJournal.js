/**
 * tradeJournal.js — one full story per trade: why it entered, how far it ran
 * and when, every stop / trail move, the minute-by-minute path, why it exited,
 * what the exit gave back, and the slippage. Same shape for every strategy on
 * every market.
 *
 * PURE OBSERVER. Everything it writes lives under `pos.journal` and nothing
 * may read `pos.journal` back into a decision. Every hook swallows its own
 * errors and returns undefined, so a journal bug can never move a trade.
 * The golden harness (scripts/strategyBaseline.js) ignores the `journal` key
 * and nothing else, so adding these hooks cannot hide a decision change.
 *
 * ── HOOK RECIPE (what a paper route adds — five call sites, nothing else) ──
 *
 *   const tradeJournal = require("../utils/tradeJournal");
 *   Pass nowMs: simNow() (the route's own clock) everywhere, so replay is exact.
 *
 *   1. ENTRY FILL — right after the position object is created and its fill
 *      price is known (same place entryTimeMs / spotAtEntry are set):
 *        tradeJournal.onEntry(pos, {
 *          reason: entryReason, signal, indicators: { rsi, ema20, ... },
 *          spot, optionLtp, bid, ask, vix, expiry,     // expiry: "YYYY-MM-DD" | Date | ms
 *          market, strategy,                             // or mode: "<logger mode>"
 *          isFutures, qty, sl: initialStop, target, expectedPrice,
 *          candles, optionCandles,                       // COMPLETED candles only (no forming bar)
 *          nowMs: simNow() });
 *      candles / optionCandles = the route's candle arrays as they are (the
 *      last 10 are kept; {time,open,high,low,close,volume} objects or Fyers
 *      [t,o,h,l,c,v] rows; extra numeric keys on a candle, e.g. ema20 / rsi,
 *      are kept as that candle's indicator values). expectedPrice = the price
 *      the signal wanted. onEntry records the initial stop (kind "initial").
 *
 *   2. PER-TICK PRICE UPDATE — the place that already updates mfe/mae /
 *      trackPath, with the SAME favPts (spot pts for most engines, premium pts
 *      for premium-quoted ones; futures = futures pts):
 *        tradeJournal.onTick(pos, { favPts, pnlRs, spot, ltp, nowMs: simNow() });
 *      It runs tradePath on its own copy (a route that also calls
 *      trackPath(pos, ...) keeps its fields unchanged), and builds 1-minute
 *      spot + option OHLC rows from these ticks with the P&L, stop and target
 *      at each minute's close — so a route with no 1-minute candles of its own
 *      still gets the minute path.
 *
 *   3. EACH COMPLETED 1-MINUTE SPOT CANDLE (optional, when the route builds
 *      them) — at the candle-close handler, while a position is open:
 *        tradeJournal.onCandle(pos, { candle, optionCandle, indicators,
 *          pnlRs, favPts, sl, target, nowMs: simNow() });
 *      Once a route calls onCandle, its candles become the minute rows (with
 *      volume + indicators) and the tick-built rows stop. optionCandle is
 *      optional: without it the option OHLC comes from the onTick ltp seen
 *      since the previous candle. pnlRs / favPts / sl / target default to the
 *      last tick / current stop / current target.
 *
 *   4. EVERY PLACE THE STOP / TRAIL / TARGET CHANGES — immediately after the
 *      new level is assigned (trail step, breakeven move, profit-lock tier,
 *      manual edit). Call it with the old and new level; equal levels are ignored:
 *        tradeJournal.onStopChange(pos, { from: oldSl, to: pos.stopLoss,
 *          kind: "trail" | "breakeven" | "lock" | "manual" | "initial" | "target",
 *          reason: "trail 70% of peak", spot, ltp, nowMs: simNow() });
 *      kind "target" moves the target (kept on the same timeline, never counted
 *      as the stop).
 *
 *   5. EXIT FILL — when the exit price is known, BEFORE the trade object is built:
 *        tradeJournal.onExit(pos, { reason: exitReason, kind: "sl" | "trail" |
 *          "target" | "signal" | "eod" | "manual", indicators, spot, optionLtp,
 *          bid, ask, expectedPrice, fillPrice, favPts, pnlRs, candlesHeld,
 *          candles, optionCandles, nowMs: simNow() });
 *      expectedPrice = the level the exit aimed at (stop / target / signal
 *      LTP); fillPrice is optional (default optionLtp, else spot); favPts /
 *      pnlRs = the exit tick's values (default: the last onTick); candles as
 *      in onEntry (default: the journal's own last 10 minute rows).
 *      Then spread the journal into the closed-trade object (session book AND
 *      the JSONL line both get it from this one object):
 *        const trade = { ...existingFields, ...tradeJournal.fields(pos) };
 *      fields(pos) returns {} when the position has no journal, so a route
 *      that is not hooked yet produces exactly the trade it did before.
 *
 *   Crash recovery: positionPersist saves pos with its journal; a restored pos
 *   carries on recording. A pos restored WITHOUT a journal stays without one
 *   (the other hooks are no-ops until onEntry ran).
 *
 * ── RECORD SHAPE (tradeJournal.record(pos), also what fields() returns) ──────
 *   { v, id, market, strategy, side, isFutures, instDir, qty, target,
 *     entry:  { ms, ist, date, reason, signal, indicators, spot, optionLtp,
 *               bid, ask, spread, spreadPct, vix, expiry, dte, sl, target,
 *               expectedPrice, fill, slippagePts, candles, optionCandles },
 *     ticks,
 *     peak:    { pts, rs, ms, ist, minFromEntry }   // highest favPts
 *     peakRs:  { rs, pts, ms, ist, minFromEntry }   // highest pnlRs
 *     worst:   { pts, rs, ms, ist, minFromEntry }   // lowest favPts (drawdown)
 *     worstRs: { rs, pts, ms, ist, minFromEntry }
 *     last:    { pts, rs, spot, ltp, ms }
 *     path:    { firstMoveDir, secsToFirstMove, pathPts }   // from tradePath.js
 *     stops:   [ { n, kind, from, to, reason, ms, ist, minFromEntry, spot, ltp,
 *                  favPts, peakPts } ]          // ordered, ≤ MAX_STOPS kept
 *     stopChanges, stopsDropped,
 *     bars:    [ { t, ms, s:[o,h,l,c], o:[o,h,l,c]|null, v, pnl, pts, sl, tg,
 *                  ind, partial } ]             // minute rows, ≤ MAX_BARS kept
 *     barSource: "ticks" | "route" | null, barsDropped,
 *     exit:   { ms, ist, reason, kind, indicators, spot, optionLtp, bid, ask,
 *               spread, spreadPct, fill, expectedPrice, slippagePts,
 *               slippageRs, favPts, pnlRs, holdMin, candlesHeld, finalStop,
 *               givebackPts, givebackRs, givebackPctOfPeak, candles,
 *               optionCandles, candlesFrom } }
 *   A candle in entry/exit `candles`: { t: "HH:MM", ms, o, h, l, c, v, ind? }.
 *
 *   Units: pts are whatever favPts the route passes (positive = in the trade's
 *   favour). Slippage is in the FILL instrument's price (option premium, or
 *   futures / spot when there is no option), positive = worse than expected,
 *   for a long instrument (bought CE/PE, long futures) and a short one alike.
 *   instDir = +1 for a bought option or long futures, -1 for short futures
 *   (futures side "PE"/"SELL"/"SHORT") or an option marked `sold: true`.
 *
 * Bounded: ≤ MAX_STOPS stop entries (the initial stop is always kept, the
 * oldest moves after it are dropped and counted); ≤ MAX_BARS minute rows (the
 * first BARS_HEAD are kept, then the most recent — barsDropped counts the
 * middle rows dropped); ≤ CANDLES_KEEP candles per entry/exit snapshot;
 * indicator snapshots ≤ MAX_KEYS keys, strings ≤ MAX_STR chars, tradePath ≤ 30
 * samples. onTick is O(1). Node 16 compatible, no dependencies beyond
 * tradePath / logTags.
 */

"use strict";

const { trackPath, pathFields } = require("./tradePath");

const VERSION      = 1;
const MAX_STOPS    = 40;
const MAX_BARS     = 400;
const BARS_HEAD    = 60;
const CANDLES_KEEP = 10;
const MAX_KEYS     = 40;
const MAX_STR      = 200;
const MAX_ARR      = 5;
const CANDLE_IND_KEYS = 8;
const STOP_KINDS = new Set(["initial", "trail", "breakeven", "lock", "manual", "target"]);

// ── small helpers ────────────────────────────────────────────────────────────
function _num(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const _r = (n, d) => { if (n == null) return null; const f = Math.pow(10, d); return Math.round(n * f) / f; };
const r1 = (n) => _r(n, 1);
const r2 = (n) => _r(n, 2);
const _now = (ms) => { const n = _num(ms); return n != null ? n : Date.now(); };

function _str(v, max) {
  if (v == null) return null;
  const s = String(v);
  const m = max || MAX_STR;
  return s.length > m ? s.slice(0, m - 1) + "…" : s;
}

function _istParts(ms) {
  const d = new Date(ms + 19800000);
  const p = (n) => (n < 10 ? "0" : "") + n;
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    hm:   `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    hms:  `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}
const istHms = (ms) => _istParts(ms).hms;

function _scalar(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? v : _r(v, 4)) : null;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return _str(v, 80);
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  return undefined;   // not a scalar
}

/** Bounded copy of an indicator / signal object: scalars, one nested level, short arrays. */
function snapshot(obj, depth) {
  if (obj == null) return null;
  const sc = _scalar(obj);
  if (sc !== undefined) return sc;
  if (typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    const out = [];
    const start = Math.max(0, obj.length - MAX_ARR);
    for (let i = start; i < obj.length; i++) { const s = _scalar(obj[i]); out.push(s === undefined ? null : s); }
    return out;
  }
  const out = {};
  let n = 0;
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    if (n >= MAX_KEYS) { out._truncated = true; break; }
    const v = obj[k];
    if (typeof v === "function") continue;
    const s = _scalar(v);
    if (s !== undefined) out[k] = s;
    else if (Array.isArray(v)) out[k] = snapshot(v, (depth || 0) + 1);
    else if (v && typeof v === "object" && !(depth > 0)) out[k] = snapshot(v, 1);
    else continue;
    n++;
  }
  return out;
}

// ── candles ──────────────────────────────────────────────────────────────────
const _TIME_KEYS = ["time", "t", "timestamp", "ts", "start", "date", "bucket"];
const _OHLCV = { open: "o", o: "o", high: "h", h: "h", low: "l", l: "l", close: "c", c: "c", volume: "v", vol: "v", v: "v" };

/** Candle time → ms. Numbers under 1e12 are epoch SECONDS (Fyers). */
function _timeMs(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const n = _num(v);
  if (n != null) return n > 0 && n < 1e12 ? n * 1000 : n;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** One candle → { t, ms, o, h, l, c, v, ind? }, or null when it has no close. */
function candleOf(c) {
  if (!c || typeof c !== "object") return null;
  let ms = null, o, h, l, cl, v, ind = null;
  if (Array.isArray(c)) {
    ms = _timeMs(c[0]); o = _num(c[1]); h = _num(c[2]); l = _num(c[3]); cl = _num(c[4]); v = _num(c[5]);
  } else {
    const got = {};
    let nInd = 0;
    for (const k in c) {
      if (!Object.prototype.hasOwnProperty.call(c, k)) continue;
      if (_OHLCV[k]) { if (got[_OHLCV[k]] == null) got[_OHLCV[k]] = _num(c[k]); continue; }
      if (_TIME_KEYS.indexOf(k) !== -1) { if (ms == null) ms = _timeMs(c[k]); continue; }
      const s = _scalar(c[k]);
      if ((typeof s === "number" || typeof s === "boolean") && nInd < CANDLE_IND_KEYS) {
        if (!ind) ind = {};
        ind[k] = s; nInd++;
      }
    }
    o = got.o; h = got.h; l = got.l; cl = got.c; v = got.v;
  }
  if (cl == null) return null;
  const out = { t: ms != null ? _istParts(ms).hm : null, ms, o: r2(o), h: r2(h), l: r2(l), c: r2(cl), v: v != null ? v : null };
  if (ind) out.ind = ind;
  return out;
}

/** The last CANDLES_KEEP candles of an array, or null when none were passed. */
function lastCandles(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const out = [];
  for (let i = Math.max(0, arr.length - CANDLES_KEEP); i < arr.length; i++) {
    const c = candleOf(arr[i]);
    if (c) out.push(c);
  }
  return out.length ? out : null;
}

const _ohlcAdd = (x, px) => {
  if (!x) return [px, px, px, px];
  if (px > x[1]) x[1] = px;
  if (px < x[2]) x[2] = px;
  x[3] = px;
  return x;
};
const _ohlcR = (x) => (x ? [r2(x[0]), r2(x[1]), r2(x[2]), r2(x[3])] : null);

function _pushBar(j, row) {
  if (j.bars.length >= MAX_BARS) {
    // Keep the first BARS_HEAD rows (how the trade started) and the latest.
    j.bars.splice(BARS_HEAD, 1);
    j.barsDropped++;
  }
  j.bars.push(row);
}

function _curStop(j) {
  for (let i = j.stops.length - 1; i >= 0; i--) if (j.stops[i].kind !== "target") return j.stops[i].to;
  return null;
}

function _rowFromAcc(j, a, partial) {
  const last = j.last || {};
  const row = {
    t: _istParts(a.m * 60000).hm, ms: a.m * 60000,
    s: _ohlcR(a.s), o: _ohlcR(a.p), v: null,
    pnl: last.rs != null ? last.rs : null, pts: last.pts != null ? last.pts : null,
    sl: _curStop(j), tg: j.target != null ? j.target : null,
  };
  if (partial) row.partial = true;
  return row;
}

/** Fold one tick into the current minute (tick-built rows) or the open route candle. */
function _accTick(j, spot, ltp, ms) {
  const m = Math.floor(ms / 60000);
  let a = j._acc;
  if (a && j.barSource !== "route" && a.m !== m) {
    if (a.s || a.p) _pushBar(j, _rowFromAcc(j, a, false));
    a = null;
  }
  if (!a) {
    a = j._acc = { m, s: null, p: null };
    if (!j.barSource) j.barSource = "ticks";
  }
  if (spot != null) a.s = _ohlcAdd(a.s, spot);
  if (ltp != null) a.p = _ohlcAdd(a.p, ltp);
}

// ── expiry / spread / direction ──────────────────────────────────────────────
/** Expiry → { expiry: "YYYY-MM-DD" | raw string | null, ms: 15:30 IST that day | null }. */
function _parseExpiry(e) {
  if (e == null || e === "") return { expiry: null, ms: null };
  let ms = null;
  if (e instanceof Date) ms = e.getTime();
  else if (typeof e === "number") ms = e;
  else {
    const s = String(e).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T15:30:00+05:30`);
    else if ((m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s))) {
      const p = (x) => (x.length < 2 ? "0" : "") + x;
      ms = Date.parse(`${m[3]}-${p(m[2])}-${p(m[1])}T15:30:00+05:30`);
    } else {
      const t = Date.parse(s);
      if (Number.isFinite(t)) ms = Date.parse(`${_istParts(t).date}T15:30:00+05:30`);
    }
    if (!Number.isFinite(ms)) return { expiry: _str(s, 40), ms: null };
  }
  if (!Number.isFinite(ms)) return { expiry: null, ms: null };
  return { expiry: _istParts(ms).date, ms };
}

/** Whole IST calendar days from the entry day to the expiry day (0 = expiry day). */
function _dte(entryMs, expiryMs) {
  if (!Number.isFinite(entryMs) || !Number.isFinite(expiryMs)) return null;
  const a = Date.parse(`${_istParts(entryMs).date}T00:00:00Z`);
  const b = Date.parse(`${_istParts(expiryMs).date}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function _spread(bid, ask) {
  const b = _num(bid), a = _num(ask);
  if (b == null || a == null || b <= 0 || a <= 0 || a < b) return { bid: b, ask: a, spread: null, spreadPct: null };
  return { bid: b, ask: a, spread: r2(a - b), spreadPct: r2((a - b) / ((a + b) / 2) * 100) };
}

/** +1 = we hold the instrument long (bought option, long futures), -1 = short. */
function _instDir(side, isFutures, sold) {
  if (sold === true) return -1;
  const s = String(side || "").toUpperCase();
  if (s === "SELL" || s === "SHORT") return -1;
  if (isFutures && s === "PE") return -1;
  return 1;
}

const _minFrom = (j, ms) => (j.entry && Number.isFinite(j.entry.ms) ? r1((ms - j.entry.ms) / 60000) : null);

function _point(j, pts, rs, ms) {
  return { pts: r2(pts), rs: r2(rs), ms, ist: istHms(ms), minFromEntry: _minFrom(j, ms) };
}

// A hook error is logged, at most once a minute per hook (onTick runs per tick,
// so an unthrottled warning would flood /logs), then swallowed.
const WARN_EVERY_MS = 60 * 1000;
const _lastWarn = {};
function _safe(fn) {
  const name = fn.name || "hook";
  return function () {
    try { fn.apply(null, arguments); } catch (err) {
      const now = Date.now();
      if (_lastWarn[name] != null && now - _lastWarn[name] < WARN_EVERY_MS) return;
      _lastWarn[name] = now;
      try { console.warn(`[tradeJournal] ${name} ignored an error: ${err && err.message}`); } catch (_) {}
    }
  };
}

function _journalOf(pos) {
  const j = pos && typeof pos === "object" ? pos.journal : null;
  return j && typeof j === "object" && j.v === VERSION ? j : null;
}

// ── hooks ────────────────────────────────────────────────────────────────────
function onEntry(pos, o) {
  if (!pos || typeof pos !== "object") return;
  o = o || {};
  const ms = _now(o.nowMs);
  let market = o.market ? String(o.market).toUpperCase() : null;
  let strategy = o.strategy ? String(o.strategy) : null;
  if ((!market || !strategy) && o.mode) {
    try {
      const t = require("./logTags").tagsFor(o.mode, pos);
      market = market || t.market;
      strategy = strategy || t.strategy;
    } catch (_) {}
  }
  market = market || "NIFTY";
  const side = o.side != null ? String(o.side).toUpperCase() : (pos.side != null ? String(pos.side).toUpperCase() : null);
  const isFutures = o.isFutures === true || pos.isFutures === true;
  const instDir = _instDir(side, isFutures, o.sold);
  const ist = _istParts(ms);
  const exp = _parseExpiry(o.expiry);
  const sp = _spread(o.bid, o.ask);
  const optionLtp = _num(o.optionLtp);
  const spot = _num(o.spot);
  const fill = _num(o.fillPrice) != null ? _num(o.fillPrice) : (optionLtp != null ? optionLtp : spot);
  const expected = _num(o.expectedPrice);
  const qty = _num(o.qty) != null ? _num(o.qty) : _num(pos.qty);
  const target = _num(o.target);
  const j = {
    v: VERSION,
    id: `${market}-${strategy || "?"}-${side || "?"}-${ms}`,
    market, strategy: strategy || null, side, isFutures, instDir, qty, target,
    entry: {
      ms, ist: ist.hms, date: ist.date,
      reason: _str(o.reason),
      signal: snapshot(o.signal),
      indicators: snapshot(o.indicators),
      spot, optionLtp,
      bid: sp.bid, ask: sp.ask, spread: sp.spread, spreadPct: sp.spreadPct,
      vix: _num(o.vix) != null ? r2(_num(o.vix)) : null,
      expiry: exp.expiry, dte: _dte(ms, exp.ms),
      sl: _num(o.sl), target,
      expectedPrice: expected, fill,
      // Bought: paying above the wanted price is the adverse direction.
      slippagePts: expected != null && fill != null ? r2((fill - expected) * instDir) : null,
      candles: lastCandles(o.candles),
      optionCandles: lastCandles(o.optionCandles),
    },
    ticks: 0,
    peak: null, peakRs: null, worst: null, worstRs: null, last: null,
    path: { entryTimeMs: ms },
    stops: [], stopChanges: 0, stopsDropped: 0,
    bars: [], barSource: null, barsDropped: 0, _acc: null,
    exit: null,
  };
  const fm = _num(pos.firstMovePts);
  if (fm != null) j.path.firstMovePts = fm;
  pos.journal = j;
  if (j.entry.sl != null) _stop(j, { from: null, to: j.entry.sl, kind: "initial", reason: "initial stop", spot, ltp: optionLtp, nowMs: ms });
}

function _tick(j, favPts, pnlRs, spot, ltp, ms) {
  j.ticks++;
  // Close the previous minute BEFORE `last` moves on: its close is the last tick of that minute.
  _accTick(j, spot, ltp, ms);
  if (favPts != null) {
    if (!j.peak || favPts > j.peak.pts) j.peak = _point(j, favPts, pnlRs, ms);
    if (!j.worst || favPts < j.worst.pts) j.worst = _point(j, favPts, pnlRs, ms);
    trackPath(j.path, favPts, ms);
  }
  if (pnlRs != null) {
    if (!j.peakRs || pnlRs > j.peakRs.rs) j.peakRs = { rs: r2(pnlRs), pts: r2(favPts), ms, ist: istHms(ms), minFromEntry: _minFrom(j, ms) };
    if (!j.worstRs || pnlRs < j.worstRs.rs) j.worstRs = { rs: r2(pnlRs), pts: r2(favPts), ms, ist: istHms(ms), minFromEntry: _minFrom(j, ms) };
  }
  if (!j.last) j.last = { pts: null, rs: null, spot: null, ltp: null, ms };
  if (favPts != null) j.last.pts = r2(favPts);
  if (pnlRs != null) j.last.rs = r2(pnlRs);
  if (spot != null) j.last.spot = spot;
  if (ltp != null) j.last.ltp = ltp;
  j.last.ms = ms;
}

function onTick(pos, o) {
  const j = _journalOf(pos);
  if (!j || j.exit || !o) return;
  const favPts = _num(o.favPts), pnlRs = _num(o.pnlRs);
  const spot = _num(o.spot), ltp = _num(o.ltp);
  if (favPts == null && pnlRs == null && spot == null && ltp == null) return;
  _tick(j, favPts, pnlRs, spot, ltp, _now(o.nowMs));
}

function onCandle(pos, o) {
  const j = _journalOf(pos);
  if (!j || j.exit || !o) return;
  const c = candleOf(o.candle);
  if (!c) return;
  const ms = c.ms != null ? c.ms : _now(o.nowMs);
  const a = j._acc;
  const oc = o.optionCandle ? candleOf(o.optionCandle) : null;
  const last = j.last || {};
  const sl = _num(o.sl), tg = _num(o.target), pnl = _num(o.pnlRs), pts = _num(o.favPts);
  const row = {
    t: _istParts(ms).hm, ms,
    s: [c.o, c.h, c.l, c.c], o: oc ? [oc.o, oc.h, oc.l, oc.c] : (a && a.p ? _ohlcR(a.p) : null),
    v: c.v,
    pnl: pnl != null ? r2(pnl) : (last.rs != null ? last.rs : null),
    pts: pts != null ? r2(pts) : (last.pts != null ? last.pts : null),
    sl: sl != null ? sl : _curStop(j),
    tg: tg != null ? tg : (j.target != null ? j.target : null),
  };
  const ind = o.indicators != null ? snapshot(o.indicators) : (c.ind || null);
  if (ind) row.ind = ind;
  // From the first route candle on, the route's candles are the minute rows.
  j.barSource = "route";
  j._acc = null;
  _pushBar(j, row);
}

function _stop(j, o) {
  const ms = _now(o.nowMs);
  const kind = STOP_KINDS.has(o.kind) ? o.kind : "manual";
  const isTarget = kind === "target";
  const to = _num(o.to);
  let prev = null;
  for (let i = j.stops.length - 1; i >= 0; i--) {
    if ((j.stops[i].kind === "target") === isTarget) { prev = j.stops[i].to; break; }
  }
  if (isTarget && prev == null) prev = j.target;
  const from = _num(o.from) != null ? _num(o.from) : prev;
  if (to == null && from == null) return;
  if (to != null && from != null && to === from) return;    // no move
  if (to != null && prev != null && to === prev && kind !== "initial") return;
  if (isTarget) j.target = to;
  j.stopChanges++;
  const e = {
    n: j.stopChanges, kind, from, to,
    reason: _str(o.reason),
    ms, ist: istHms(ms), minFromEntry: _minFrom(j, ms),
    spot: _num(o.spot), ltp: _num(o.ltp),
    favPts: j.last && j.last.pts != null ? j.last.pts : null,
    peakPts: j.peak ? j.peak.pts : null,
  };
  if (j.stops.length >= MAX_STOPS) {
    // Keep the initial stop (index 0) and the most recent moves.
    j.stops.splice(1, 1);
    j.stopsDropped++;
  }
  j.stops.push(e);
}

function onStopChange(pos, o) {
  const j = _journalOf(pos);
  if (!j || j.exit || !o) return;
  _stop(j, o);
}

function _barsAsCandles(j, key) {
  if (!j.bars.length) return null;
  const out = [];
  for (let i = Math.max(0, j.bars.length - CANDLES_KEEP); i < j.bars.length; i++) {
    const b = j.bars[i], x = b[key];
    if (x) out.push({ t: b.t, ms: b.ms, o: x[0], h: x[1], l: x[2], c: x[3], v: key === "s" ? b.v : null });
  }
  return out.length ? out : null;
}

function onExit(pos, o) {
  const j = _journalOf(pos);
  if (!j) return;
  o = o || {};
  const ms = _now(o.nowMs);
  const favIn = _num(o.favPts), rsIn = _num(o.pnlRs);
  if (!j.exit && (favIn != null || rsIn != null)) _tick(j, favIn, rsIn, _num(o.spot), _num(o.optionLtp), ms);
  // The minute the exit happened in, as a partial row (tick-built rows only).
  if (!j.exit && j.barSource === "ticks" && j._acc && (j._acc.s || j._acc.p)) _pushBar(j, _rowFromAcc(j, j._acc, true));
  j._acc = null;
  const last = j.last || {};
  const favPts = favIn != null ? favIn : (last.pts != null ? last.pts : null);
  const pnlRs  = rsIn  != null ? rsIn  : (last.rs  != null ? last.rs  : null);
  const sp = _spread(o.bid, o.ask);
  const optionLtp = _num(o.optionLtp);
  const spot = _num(o.spot);
  const fill = _num(o.fillPrice) != null ? _num(o.fillPrice) : (optionLtp != null ? optionLtp : spot);
  const expected = _num(o.expectedPrice);
  // Closing a long sells it (a fill BELOW expected is adverse); closing a short buys it back.
  const slipPts = expected != null && fill != null ? r2((expected - fill) * j.instDir) : null;
  const peakPts = j.peak ? j.peak.pts : null;
  const peakRs  = j.peakRs ? j.peakRs.rs : null;
  const gbPts = peakPts != null && favPts != null && peakPts > 0 ? r2(peakPts - favPts) : null;
  const gbRs  = peakRs  != null && pnlRs  != null && peakRs  > 0 ? r2(peakRs - pnlRs) : null;
  const candles = _num(o.candlesHeld);
  const ownCandles = lastCandles(o.candles);
  const ownOpt = lastCandles(o.optionCandles);
  j.exit = {
    ms, ist: istHms(ms),
    reason: _str(o.reason), kind: o.kind != null ? _str(o.kind, 24) : null,
    indicators: snapshot(o.indicators),
    spot, optionLtp,
    bid: sp.bid, ask: sp.ask, spread: sp.spread, spreadPct: sp.spreadPct,
    fill, expectedPrice: expected,
    slippagePts: slipPts,
    slippageRs: slipPts != null && j.qty != null ? r2(slipPts * j.qty) : null,
    favPts: r2(favPts), pnlRs: r2(pnlRs),
    holdMin: _minFrom(j, ms),
    candlesHeld: candles != null ? Math.round(candles) : null,
    finalStop: _curStop(j),
    givebackPts: gbPts,
    givebackRs: gbRs,
    givebackPctOfPeak: gbPts != null ? r1(gbPts / peakPts * 100) : null,
    candles: ownCandles || _barsAsCandles(j, "s"),
    optionCandles: ownOpt || _barsAsCandles(j, "o"),
    candlesFrom: ownCandles ? "route" : (j.bars.length ? "journal" : null),
  };
}

// ── read-out ─────────────────────────────────────────────────────────────────
/** The persisted record: the journal minus its working state. A new object. */
function normalize(j) {
  if (!j || typeof j !== "object" || j.v !== VERSION) return null;
  const out = {};
  for (const k in j) {
    if (!Object.prototype.hasOwnProperty.call(j, k) || k === "path" || k === "_acc") continue;
    out[k] = j[k];
  }
  out.stops = Array.isArray(j.stops) ? j.stops.slice() : [];
  out.bars = Array.isArray(j.bars) ? j.bars.slice() : [];
  out.path = j.path && typeof j.path === "object" && "entryTimeMs" in j.path ? pathFields(j.path) : (j.path || pathFields({}));
  return out;
}

function record(pos) { return normalize(_journalOf(pos)); }

/** `{ journal }` to spread into the closed trade, or `{}` when the route is not hooked. */
function fields(pos) {
  const r = record(pos);
  return r ? { journal: r } : {};
}

module.exports = {
  onEntry: _safe(onEntry),
  onTick: _safe(onTick),
  onCandle: _safe(onCandle),
  onStopChange: _safe(onStopChange),
  onExit: _safe(onExit),
  record, fields, normalize, snapshot, candleOf, lastCandles,
  VERSION, MAX_STOPS, MAX_BARS, BARS_HEAD, CANDLES_KEEP, MAX_KEYS, MAX_STR,
};

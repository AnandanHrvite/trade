/**
 * 3M GAP FIX SCALP PAPER — /gap-fix-3m-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL surface. Every decision / fill / exit semantic for 3M_GAP_FIX_SCALP
 * lives here; the backtest and the live harness must match THIS, never the
 * reverse (see feedback_paper_logic_untouchable).
 *
 * The day in one paragraph: the engine watches 3-minute NIFTY **FUTURES**
 * candles for a gap — a price void between two consecutive bars. When it finds
 * one it remembers exactly where it is, then looks at the ONE next candle. If
 * that candle breaks the day's high (gap up) or low (gap down) on good volume,
 * the move is real and nothing is traded. If it turns back instead, the gap is
 * faded: buy a PE on a gap up, a CE on a gap down, hold until the gap fills, and
 * stop out if the day's extreme is taken out.
 *
 * TWO INSTRUMENTS, TWO JOBS:
 *   • NIFTY FUTURES (NSE:NIFTY{expiry}FUT) — every decision. Gaps, day high/low,
 *     volume, entry, target and stop are ALL futures levels. Closed 3-min bars
 *     come from the Fyers HISTORY endpoint (the same one the backtest and replay
 *     read, which is what makes the four modes agree); the live futures price
 *     for exits comes from a GAP3M_FUT_POLL_MS quote poll.
 *   • NIFTY 50 INDEX — the option STRIKE only (strikes are struck on the index,
 *     not on the future), plus the second chart on this page. The shared spot
 *     WebSocket also supplies this session's heartbeat and tick count.
 *
 * Exits, in the order they are tested on every futures quote:
 *   1. stop    — the FROZEN day extreme (± GAP3M_SL_BUFFER_PTS). Never moves.
 *   2. target  — the gap fill level. Never moves.
 *   3. EOD square-off at GAP3M_FORCED_EXIT
 * There is deliberately NO trail, NO breakeven jump, NO time stop, NO premium
 * stop and NO partial booking. The user's rule is two levels and an EOD.
 *
 * Day-level breakers: GAP3M_MAX_DAILY_TRADES, GAP3M_MAX_DAILY_LOSS,
 * GAP3M_DAILY_PROFIT_LOCK and GAP3M_MAX_DAILY_LOSSES stop-outs.
 *
 * Signal engine: src/strategies/gap_fix_3m.js (shared by paper, backtest, live
 * harness and replay — no rule is re-implemented in this file).
 *
 * Uses LIVE data but SIMULATES orders locally.
 * Endpoints: /start /stop /exit /status /status/data /status/chart-data
 *            /history /reset /session/:i /download/... /view/...
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const gapStrategy        = require("../strategies/gap_fix_3m");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { renderHistoryPage, dailyFilesPaginate } = require("../utils/paperHistoryUI");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiCapitalStrip, bbRsiStatGrid, bbRsiCurrentBar, bbRsiActivityLog, inr } = require("../utils/bbRsiStyleUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const tradeLogger = require("../utils/tradeLogger");
const aiExport    = require("../utils/aiExport");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { getISTMinutes, getBucketStart } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");
const capitalPool = require("../utils/capitalPool");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "gapFix3mPaper";
const MODE_KEY           = "gap_fix_3m";     // tradeLogger / skipLogger key

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "gap_fix_3m_paper_trades.json");

/** The current NIFTY futures contract — resolved live so a monthly roll is free. */
function futSymbol() {
  return `NSE:NIFTY${instrumentConfig.getFuturesExpiry()}FUT`;
}

// ── Config readers (Settings mutates process.env live — never cache) ──────────
function _resMin() { return gapStrategy.getConfig().resolutionMins; }
function _parseMins(envKey, fallback) {
  return gapStrategy._parseHHMM(process.env[envKey], gapStrategy._parseHHMM(fallback, 0));
}
function _envStr(key, fallback) { return String(process.env[key] || fallback); }
function _maxDailyTrades()  { return Math.max(1, parseInt(process.env.GAP3M_MAX_DAILY_TRADES || "3", 10) || 3); }
function _maxDailyLosses()  { return Math.max(0, parseInt(process.env.GAP3M_MAX_DAILY_LOSSES || "2", 10)); }
function _maxDailyLoss()    { return parseFloat(process.env.GAP3M_MAX_DAILY_LOSS    || "3000"); }
function _dailyProfitLock() { return parseFloat(process.env.GAP3M_DAILY_PROFIT_LOCK || "0"); }
function _maxWeeklyLoss()   { return parseFloat(process.env.GAP3M_MAX_WEEKLY_LOSS   || "0"); }
function _futPollMs() {
  const v = parseInt(process.env.GAP3M_FUT_POLL_MS || "2000", 10);
  return Number.isFinite(v) && v >= 500 && v <= 30000 ? v : 2000;
}
/**
 * How long after a bar closes before the Fyers history endpoint is asked for it.
 * Fetching the instant the clock ticks over often returns the bar still one
 * short, which would silently delay every decision by a whole bar.
 */
function _historyLagMs() {
  const v = parseInt(process.env.GAP3M_HISTORY_LAG_MS || "5000", 10);
  return Number.isFinite(v) && v >= 0 && v <= 60000 ? v : 5000;
}

/**
 * Position size. GAP3M_LOT_MULTIPLIER (when > 0) overrides the global
 * LOT_MULTIPLIER for this strategy only, clamped by the same MAX_LOT_MULTIPLIER
 * ceiling. Divides by the multiplier getLotQty ACTUALLY applied (it clamps
 * internally), not the raw env value. Default 0 = use the common setting, which
 * is what "use common settings for size" asks for.
 */
function gapLotQty() {
  const base = instrumentConfig.getLotQty();
  const raw  = parseInt(process.env.GAP3M_LOT_MULTIPLIER || "0", 10);
  if (!Number.isFinite(raw) || raw <= 0) return base;

  let maxMult = parseInt(process.env.MAX_LOT_MULTIPLIER || "10", 10);
  if (!Number.isFinite(maxMult) || maxMult < 1) maxMult = 10;

  let globalMult = parseInt(process.env.LOT_MULTIPLIER || "1", 10);
  if (!Number.isFinite(globalMult) || globalMult <= 0) globalMult = 1;
  if (globalMult > maxMult) globalMult = maxMult;

  return Math.round((base / globalMult) * Math.min(raw, maxMult));
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let _dataCache = null;
function loadData() {
  if (_dataCache) return _dataCache;
  ensureDir();
  if (!fs.existsSync(PT_FILE)) {
    const init = { capital: parseFloat(process.env.FYERS_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(init, null, 2));
    _dataCache = init;
    return init;
  }
  try { _dataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error("[gap3m-paper] gap_fix_3m_paper_trades.json corrupt — resetting:", e.message);
    _dataCache = { capital: parseFloat(process.env.FYERS_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(_dataCache, null, 2));
  }
  return _dataCache;
}
function saveData(d) {
  ensureDir();
  _dataCache = d;
  fs.writeFileSync(PT_FILE, JSON.stringify(d, null, 2));
}

// ── State ────────────────────────────────────────────────────────────────────
let state = _freshState();
function _freshState() {
  return {
    running:        false,
    sessionStart:   null,
    sessionTrades:  [],
    sessionPnl:     0,
    tradesTaken:    0,
    stopOuts:       0,
    consecutiveLosses: 0,
    // FUTURES bars — the decision series. Closed bars only.
    candles:        [],
    lastClosedBarTime: null,
    formingFut:     null,   // display-only: the futures bar being built from quotes
    // INDEX bars — display + strike spot only. Built from the shared tick feed.
    indexCandles:   [],
    indexBar:       null,
    indexBarStart:  null,
    tickCount:      0,
    lastTickTime:   null,
    lastTickPrice:  null,   // NIFTY 50 INDEX
    lastFutPrice:   null,   // NIFTY FUTURES — what every exit is measured against
    lastFutAt:      null,
    futSymbol:      null,
    position:       null,
    optionLtp:      null,
    optionLtpUpdatedAt: null,
    log:            [],
    _sessionId:     null,
    // 3M_GAP_FIX_SCALP specific
    lastSignal:     null,
    lastGap:        null,   // the most recent gap the engine reported, for the UI
    dayHigh:        null,
    dayLow:         null,
    dayClosed:      false,
    dayClosedReason: null,
    _histInFlight:  false,
    _histBucket:    null,   // bucket whose history fetch has already been done
    _histFailures:  0,
    _histNextTryMs: null,   // backoff floor after a failed history fetch
    _entryInFlight: false,
    _lastEntryAttemptMs: null,
    _pendingEntry:  null,   // a signalled entry whose FILL failed — retried per poll
  };
}

function log(msg) {
  const stamp = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  const line = `[${stamp}] ${msg}`;
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
  console.log(line);
}

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

// ── Crash/restart recovery: rehydrate today's in-memory session from JSONL ─────
function rehydrateSessionFromJsonl() {
  try {
    const data = loadData();
    const keyOf = (t) => String(t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`);
    const today = tradeLogger.istDateString(Date.now());
    const all = tradeLogger.readDailyTrades(MODE_KEY, today)
      .filter(t => t && !t.type && (t.side || t.entryTime || t.entryBarTime || t.symbol));
    const seen = new Set();
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) seen.add(keyOf(t));
    let trades = all.filter(t => !seen.has(keyOf(t)));
    let source = "today's live session";
    let stale  = false;
    if (!trades.length) {
      const saved = (data.sessions || []).filter(s => Array.isArray(s.trades) && s.trades.length);
      if (saved.length) {
        const last = saved.reduce((a, b) => (String(b.date) > String(a.date) ? b : a));
        trades = last.trades;
        source = `last session (${last.date || "?"})`;
        stale  = all.length === 0;
      }
    }
    if (!trades.length) return;
    state._staleSession = stale;
    state.sessionTrades = trades;
    state.tradesTaken   = trades.length;
    state.stopOuts = trades.filter(t => /Stop hit|Day (high|low) taken out/i.test(String(t.exitReason || ""))).length;
    state.sessionPnl = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    if (!state.sessionStart) state.sessionStart = trades[0].entryTime || trades[0].loggedAt || null;
    console.log(`♻️ [GAP3M-PAPER] Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl}, ${state.stopOuts} stop-out(s))`);
  } catch (err) {
    console.warn(`[GAP3M-PAPER] session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => state, "[GAP3M-PAPER]");

/**
 * Realised P&L for the current ISO week (Mon → today) from the per-day JSONL
 * logs. While RUNNING, today's contribution comes from the in-memory session
 * (the day file lags by an event-loop tick); when idle we must read the FILE,
 * because state.sessionPnl may still hold a rehydrated previous session.
 */
function weeklyPnl() {
  try {
    const nowIst = new Date(Date.now() + 19800000);
    const dow = nowIst.getUTCDay();
    const backToMon = dow === 0 ? 6 : dow - 1;
    const todayStr = tradeLogger.istDateString(Date.now());
    let total = 0;
    for (let i = backToMon; i >= 0; i--) {
      const d = new Date(nowIst.getTime() - i * 86400000);
      const ds = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      if (ds === todayStr && state.running) { total += state.sessionPnl; continue; }
      const trades = tradeLogger.readDailyTrades(MODE_KEY, ds) || [];
      for (const t of trades) if (t && !t.type && typeof t.pnl === "number") total += t.pnl;
    }
    return parseFloat(total.toFixed(2));
  } catch (_) {
    return state.running ? state.sessionPnl : 0;
  }
}

// ── Futures quote poll — the live price every exit is measured against ────────
// This runs for the WHOLE session, not only while a position is open: it also
// supplies the forming futures bar for the chart and the clock that triggers the
// history refresh. The option LTP rides in the SAME request when a position is
// open, so holding a trade costs no extra API call.
let _pollTimer = null;
let _pollStopped = true;

/**
 * Split one getQuotes response into { futLtp, optLtp }.
 *
 * Attribution is STRICTLY by symbol — never "whatever is left over". Some Fyers
 * response shapes omit the symbol on a row, and an else-branch would then write
 * the OPTION premium into the futures price: ~240 compared against a futures
 * gap-fill target of ~24252 satisfies targetHit() immediately and books a fake
 * "gap filled" exit on the first poll after entry. An unidentifiable row is
 * dropped instead, except when a single-symbol request came back with a single
 * row, where there is nothing to confuse it with.
 *
 * Exported for the offline test harness — this is the function that decides
 * which number every exit is measured against.
 */
function attributeQuotes(resp, symbols, futSym, optSym) {
  const out = { futLtp: null, optLtp: null };
  if (!resp || resp.s !== "ok" || !Array.isArray(resp.d)) return out;
  for (const row of resp.d) {
    const v = (row && row.v) || {};
    const ltp = v.lp || v.ltp;   // same idiom as every other quote reader in the repo
    if (typeof ltp !== "number" || !Number.isFinite(ltp) || !(ltp > 0)) continue;
    let sym = row && (row.n || row.symbol);
    if (!sym && resp.d.length === 1 && Array.isArray(symbols) && symbols.length === 1) sym = symbols[0];
    if (!sym) continue;
    if (optSym && sym === optSym) out.optLtp = ltp;
    else if (sym === futSym) out.futLtp = ltp;
  }
  return out;
}

function startPolling() {
  stopPolling();
  _pollStopped = false;
  const poll = async () => {
    if (_pollStopped) return;
    try {
      const futSym = state.futSymbol || futSymbol();
      const optSym = state.position ? state.position.symbol : null;
      const symbols = optSym ? [futSym, optSym] : [futSym];
      const r = await fyers.getQuotes(symbols);
      const q = attributeQuotes(r, symbols, futSym, optSym);
      if (q.optLtp != null) {
        state.optionLtp = q.optLtp;
        state.optionLtpUpdatedAt = Date.now();
        try { tickRecorder.recordOptionLtp(optSym, q.optLtp, "gap-fix-3m-paper"); } catch (_) {}
      }
      if (q.futLtp != null) {
        state.lastFutPrice = q.futLtp;
        state.lastFutAt = Date.now();
        _updateFormingFut(q.futLtp);
        // Recorded into the tick recorder's per-symbol quote stream. There is no
        // futures tick stream, and this is inert for replay — the timeline is
        // keyed by symbol, so a futures row can never be served for an option
        // lookup. It is kept because it is the only recorded trace of the price
        // this strategy's exits were actually measured against.
        try { tickRecorder.recordOptionLtp(futSym, q.futLtp, "gap-fix-3m-paper-fut"); } catch (_) {}
      }
    } catch (_) {}

    // Exits first (a filled target must not wait on a history round-trip), then
    // the bar-close work.
    try { if (state.position) _checkExits(state.lastFutPrice); } catch (e) { console.error(`🚨 [GAP3M-PAPER] exit-check error: ${e.message}`); }
    try { _enforceEod(); } catch (e) { console.error(`🚨 [GAP3M-PAPER] eod error: ${e.message}`); }
    _maybeRefreshFutHistory().catch(e => console.error(`🚨 [GAP3M-PAPER] history refresh error: ${e.message}`));
    if (!state.position && state._pendingEntry) {
      _retryPendingEntry().catch(e => console.error(`🚨 [GAP3M-PAPER] entry-retry error: ${e.message}`));
    }

    if (!_pollStopped) _pollTimer = setTimeout(poll, _futPollMs());
  };
  _pollTimer = setTimeout(poll, 250);
}

function stopPolling() {
  _pollStopped = true;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

/** Display-only forming futures bar, built from the quote poll. */
function _updateFormingFut(price) {
  const bucketSec = Math.floor(getBucketStart(Date.now(), _resMin()) / 1000);
  if (!state.formingFut || state.formingFut.time !== bucketSec) {
    state.formingFut = { time: bucketSec, open: price, high: price, low: price, close: price, volume: 0 };
    return;
  }
  state.formingFut.high  = Math.max(state.formingFut.high, price);
  state.formingFut.low   = Math.min(state.formingFut.low, price);
  state.formingFut.close = price;
}

// ── Futures history — the ONLY source of the closed bars decisions read ───────
/**
 * Fetch today's closed futures bars once per bar, a short lag after the bar
 * closes. Everything the engine reads comes from here, which is precisely why
 * Paper, Backtest and Replay agree: they all read the same endpoint.
 */
async function _maybeRefreshFutHistory() {
  if (!state.running || state._histInFlight) return;
  const resMin = _resMin();
  const bucketMs = getBucketStart(Date.now(), resMin);
  if (state._histBucket === bucketMs) return;
  if (Date.now() - bucketMs < _historyLagMs()) return;
  if (state._histNextTryMs && Date.now() < state._histNextTryMs) return;

  state._histInFlight = true;
  try {
    const bars = await _fetchFuturesToday();
    if (Array.isArray(bars) && bars.length) {
      state._histBucket = bucketMs;
      state._histFailures = 0;
      state._histNextTryMs = null;
      _mergeFuturesBars(bars);
    } else {
      // An EXPIRED Fyers token returns no data rather than an auth error, so
      // "empty" and "broken" look identical here — both are treated as a failure.
      _noteHistoryFailure(null);
    }
  } catch (e) {
    // A throw must count as a failure too. Without this branch a rejecting
    // fetch left _histFailures at 0, so the operator never saw the warning.
    _noteHistoryFailure(e && e.message);
  } finally {
    state._histInFlight = false;
  }
}

/**
 * Record a failed history fetch and back off. The poll runs every
 * GAP3M_FUT_POLL_MS (2s by default) and the bucket guard only advances on
 * SUCCESS, so without a backoff a dead token would turn one bar into ~90
 * history calls. Backoff grows 5s per failure to a 60s ceiling, and never
 * exceeds one bar — so at the 3-min default there is still at least one attempt
 * per bar, which is the soonest a retry could return anything new anyway.
 */
function _noteHistoryFailure(why) {
  state._histFailures++;
  const backoffMs = Math.min(_resMin() * 60_000, 5000 * Math.min(state._histFailures, 12));
  state._histNextTryMs = Date.now() + backoffMs;
  if (state._histFailures === 3 || state._histFailures % 20 === 0) {
    log(`⚠️ [GAP3M-PAPER] Futures history unavailable ${state._histFailures}× ${why ? `(${why}) ` : ""}— an expired Fyers token returns NO DATA rather than an auth error. Re-login if this persists. Retrying in ${Math.round(backoffMs / 1000)}s.`);
  }
}

/** Today's futures bars at the strategy resolution. Uncached — today is live. */
async function _fetchFuturesToday() {
  const { fetchCandles } = require("../services/backtestEngine");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return fetchCandles(state.futSymbol || futSymbol(), String(_resMin()), today, today);
}

/**
 * Merge freshly fetched bars into state.candles and fire onCandleClose for each
 * genuinely NEW closed bar. Fyers history includes today's STILL-FORMING bar, so
 * any bar whose close time has not passed is dropped — feeding a partial bar to
 * the engine would let it decide off half a candle and then change its mind.
 */
function _mergeFuturesBars(bars) {
  const resMin = _resMin();
  const nowBucketSec = Math.floor(getBucketStart(Date.now(), resMin) / 1000);
  const closed = bars
    .filter(b => b && typeof b.time === "number" && b.time < nowBucketSec)
    .sort((a, b) => a.time - b.time);
  if (!closed.length) return;

  const byTime = new Map();
  for (const c of state.candles) byTime.set(c.time, c);
  const fresh = [];
  for (const c of closed) {
    const known = byTime.get(c.time);
    byTime.set(c.time, c);
    if (!known) fresh.push(c);
  }
  state.candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time).slice(-400);

  // Day extremes for the UI — the engine freezes its own copy per setup.
  const ext = gapStrategy.computeDayExtremes(state.candles, {});
  state.dayHigh = ext.high;
  state.dayLow  = ext.low;

  if (!fresh.length) return;
  const newest = fresh[fresh.length - 1];
  state.lastClosedBarTime = newest.time;
  // Fire ONCE, for the newest bar only. evaluateEntry always reads the LAST
  // element of state.candles, so replaying older bars would re-evaluate the same
  // series N times — normally harmless, but if history only starts answering
  // mid-session (a token restored at 13:00) `fresh` is the whole day and this
  // would be ~100 identical evaluations in one tick of the poll loop.
  try { onCandleClose(newest); }
  catch (e) { console.error(`🚨 [GAP3M-PAPER] onCandleClose error: ${e.message}`); }
}

// ── Trade simulation ─────────────────────────────────────────────────────────
async function simulateBuy(side, sig) {
  // The STRIKE is chosen off the NIFTY 50 INDEX — strikes are struck on the
  // index, not on the future, and the two differ by the basis (tens of points
  // near expiry). Using the futures price here would systematically pick the
  // wrong strike.
  const indexSpot = state.lastTickPrice;
  const futPrice  = state.lastFutPrice;
  if (!side) return;
  if (typeof indexSpot !== "number" || !(indexSpot > 0)) {
    log(`⚠️ [GAP3M-PAPER] No NIFTY index price yet — cannot choose a strike, entry deferred`);
    return;
  }
  if (typeof futPrice !== "number" || !(futPrice > 0)) {
    log(`⚠️ [GAP3M-PAPER] No futures quote yet — entry deferred`);
    return;
  }

  let optInfo;
  try {
    optInfo = await instrumentConfig.validateAndGetOptionSymbol(indexSpot, side, "GAP3M");
  } catch (e) {
    log(`❌ [GAP3M-PAPER] Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ [GAP3M-PAPER] No valid expiry — skip ${side} entry`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "expiry", reason: "no valid option expiry", side, spot: indexSpot });
    return;
  }

  let optionEntryLtp = null;
  try {
    const r = await fyers.getQuotes([optInfo.symbol]);
    if (r && r.s === "ok" && r.d && r.d.length) {
      const v = r.d[0].v || {};
      const ltp = v.lp || v.ltp;
      if (typeof ltp === "number" && ltp > 0) {
        optionEntryLtp = ltp;
        try { tickRecorder.recordOptionLtp(optInfo.symbol, ltp, "gap-fix-3m-paper"); } catch (_) {}
      }
    }
  } catch (e) {
    log(`⚠️ [GAP3M-PAPER] Option LTP fetch failed: ${e.message} — entry blocked`);
    return;
  }
  if (!optionEntryLtp) {
    log(`❌ [GAP3M-PAPER] Option LTP not available — entry skipped`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "option_ltp", reason: "no option LTP", symbol: optInfo.symbol, side, spot: indexSpot });
    return;
  }

  // The target and the stop are LEVELS the engine read off closed futures bars —
  // the gap's fill price and the day's extreme. Unlike a distance-based bracket
  // they are NOT re-anchored to the fill: re-anchoring would move the gap-fill
  // level away from the actual gap, which is the one thing this strategy is
  // about. The fill slipping simply changes the R:R, and that is reported.
  const slSpot     = sig.slSpot;
  const targetSpot = sig.targetSpot;
  if (!Number.isFinite(slSpot) || !Number.isFinite(targetSpot)) {
    log(`🚫 [GAP3M-PAPER] Entry ABORTED — stop (${slSpot}) or target (${targetSpot}) unusable. Refusing to enter without both.`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "levels_uncomputable", reason: `stop ${slSpot} / target ${targetSpot} unusable`, side, spot: futPrice });
    return;
  }
  // The fill may have already run past a level while the quote round-tripped.
  if (gapStrategy.stopHit(side, futPrice, slSpot)) {
    log(`🚫 [GAP3M-PAPER] Entry ABORTED — futures ${futPrice} is already through the stop ${slSpot}`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "fill_past_stop", reason: `futures ${futPrice} already beyond stop ${slSpot}`, side, spot: futPrice });
    return;
  }
  if (gapStrategy.targetHit(side, futPrice, targetSpot)) {
    log(`🚫 [GAP3M-PAPER] Entry ABORTED — the gap already filled (futures ${futPrice} reached ${targetSpot}) before the fill`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "gap_already_filled", reason: `futures ${futPrice} already at fill level ${targetSpot}`, side, spot: futPrice });
    return;
  }

  const qty = gapLotQty();
  const slPts     = parseFloat(Math.abs(slSpot - futPrice).toFixed(2));
  const targetPts = parseFloat(Math.abs(targetSpot - futPrice).toFixed(2));
  const rr        = slPts > 0 ? parseFloat((targetPts / slPts).toFixed(2)) : null;

  // Capital check — advisory only: an overdrawn pool raises a dashboard alert,
  // it never stops a paper trade. Sits AFTER the last abort path.
  const _cap = capitalPool.check(MODE_KEY, qty * optionEntryLtp);
  if (!_cap.ok) {
    log(`⚠️ [GAP3M-PAPER] ${_cap.reason} — entry taken anyway, pool now overdrawn`);
    capitalPool.noteShortfall(MODE_KEY, _cap, { side, symbol: optInfo.symbol });
  }

  const pos = {
    side,
    symbol:         optInfo.symbol,
    optionStrike:   optInfo.strike,
    optionExpiry:   optInfo.expiry,
    qty,
    // "spot" for this engine means the FUTURES price — that is the instrument
    // every level is measured on. The index is recorded alongside it.
    entrySpot:      futPrice,
    entryPrice:     futPrice,
    indexAtEntry:   indexSpot,
    futuresSymbol:  state.futSymbol,
    optionEntryLtp,
    entryTime:      istNow(),
    entryTimeMs:    Date.now(),
    entryUnixSec:   Math.floor(Date.now() / 1000),
    entryBarTime:   Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    slSpot,
    initialSlSpot:  slSpot,
    targetSpot,
    slPts,
    targetPts,
    riskPts:        slPts,
    rr,
    // Signal context (kept on the trade record for analytics / reports)
    signalSpot:     sig.entrySpot,
    signalSlPts:    sig.slPts,
    signalTargetPts: sig.targetPts,
    signalRr:       sig.rr,
    gapDir:         sig.gapDir,
    gapSize:        sig.gapSize,
    gapTop:         sig.gapTop,
    gapBottom:      sig.gapBottom,
    gapFillLevel:   sig.gapFillLevel,
    dayHighAtEntry: sig.dayHigh,
    dayLowAtEntry:  sig.dayLow,
    confirmCrossed: sig.crossed,
    confirmVolume:  sig.volume,
    confirmVolumeAvg: sig.volumeAvg,
    peakPremium:    optionEntryLtp,
    signalStrength: sig.signalStrength,
    mfeSpotPts:     0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
    entryReason:    sig.reason,
  };

  state.position = pos;
  capitalPool.block(MODE_KEY, qty * optionEntryLtp, { side, symbol: optInfo.symbol, qty, premium: optionEntryLtp });
  try { require("../utils/positionPersist").saveGapFix3mPosition(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  state.optionLtp = optionEntryLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;

  log(`🟢 [GAP3M-PAPER] BUY_${side} ${optInfo.symbol} qty=${qty} @ futures=${futPrice} (index ${indexSpot}) optLtp=₹${optionEntryLtp}`);
  log(`   ├─ Gap: ${pos.gapSize}pt ${pos.gapDir} · void ${pos.gapBottom}–${pos.gapTop} · fill level ${pos.gapFillLevel}`);
  log(`   ├─ Day range at the gap: ${pos.dayLowAtEntry} – ${pos.dayHighAtEntry}${pos.confirmCrossed ? " · the confirm bar poked the extreme on WEAK volume and came back" : ""}`);
  log(`   └─ TGT ${targetSpot} (${targetPts}pt) · SL ${slSpot} (${slPts}pt) · R:R ${rr} · EOD ${_envStr("GAP3M_FORCED_EXIT", "15:15")}`);

  notifyEntry({
    mode: "GAP-FIX-3M-PAPER",
    side, symbol: optInfo.symbol,
    spotAtEntry: futPrice, optionEntryLtp,
    qty, stopLoss: slSpot, target: targetSpot,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "gap-fix-3m-paper",
      sessionId: state._sessionId,
      ts: Date.now(),
      side, symbol: optInfo.symbol, qty,
      spotEntry: futPrice, optionEntry: optionEntryLtp,
      stopLoss: slSpot, target: targetSpot,
      reason: pos.entryReason,
    });
  } catch (_) {}
}

function simulateSell(reason, opts) {
  if (!state.position) return;
  const o = opts || {};
  const pos = state.position;
  const exitOptLtp = state.optionLtp || pos.optionEntryLtp;
  const exitSpot   = state.lastFutPrice || pos.entrySpot;
  const qty        = pos.qty;
  const charges    = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitOptLtp, qty });
  const pnl        = parseFloat(((exitOptLtp - pos.optionEntryLtp) * qty - charges).toFixed(2));

  state.sessionPnl = parseFloat((state.sessionPnl + pnl).toFixed(2));
  if (pnl < 0) state.consecutiveLosses++; else if (pnl > 0) state.consecutiveLosses = 0;
  // Only a REAL stop-out burns one of the day's allowed losses. isStopOut is set
  // by the caller, never inferred from the sign of the P&L, so a stop that
  // happens to net positive still counts.
  if (o.isStopOut) state.stopOuts++;

  const trade = {
    side:           pos.side,
    symbol:         pos.symbol,
    qty,
    entryPrice:     pos.entrySpot,
    exitPrice:      exitSpot,
    spotAtEntry:    pos.entrySpot,
    spotAtExit:     exitSpot,
    indexAtEntry:   pos.indexAtEntry,
    futuresSymbol:  pos.futuresSymbol,
    optionEntryLtp: pos.optionEntryLtp,
    optionExitLtp:  exitOptLtp,
    bestOptionLtp:  pos.peakPremium || null,
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    entryBarTime:   pos.entryBarTime,
    exitBarTime:    Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    pnl,
    pnlMode:        `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp} (levels measured on NIFTY FUTURES)`,
    exitReason:     reason,
    entryReason:    pos.entryReason,
    stopLoss:       pos.slSpot,
    initialStopLoss: pos.initialSlSpot,
    target:         pos.targetSpot,
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    optionType:     pos.side,
    optionEntrySymbol: pos.symbol,
    signalStrength: pos.signalStrength,
    riskPts:        pos.riskPts,
    targetPts:      pos.targetPts,
    rr:             pos.rr,
    // 3M_GAP_FIX_SCALP signal context
    gapDir:         pos.gapDir,
    gapSize:        pos.gapSize,
    gapTop:         pos.gapTop,
    gapBottom:      pos.gapBottom,
    gapFillLevel:   pos.gapFillLevel,
    dayHighAtEntry: pos.dayHighAtEntry,
    dayLowAtEntry:  pos.dayLowAtEntry,
    confirmCrossed: pos.confirmCrossed,
    confirmVolume:  pos.confirmVolume,
    confirmVolumeAvg: pos.confirmVolumeAvg,
    mfeSpotPts:     pos.mfeSpotPts || 0,
    mfePnl:         pos.mfePnl || 0,
    maeSpotPts:     pos.maeSpotPts || 0,
    maePnl:         pos.maePnl || 0,
    secsToMFE:      pos.secsToMFE || 0,
    secsToMAE:      pos.secsToMAE || 0,
    durationMs:     Date.now() - pos.entryTimeMs,
    charges,
    isFutures:      false,
    instrument:     "NIFTY_OPTIONS",
  };
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog(MODE_KEY, trade);

  log(`🔴 [GAP3M-PAPER] EXIT ${pos.side} ${pos.symbol} @ optLtp=₹${exitOptLtp} futures=${exitSpot} | PnL=₹${pnl} (${reason})`);

  notifyExit({
    mode: "GAP-FIX-3M-PAPER",
    side: pos.side, symbol: pos.symbol,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    optionEntryLtp: pos.optionEntryLtp, optionExitLtp: exitOptLtp,
    pnl, sessionPnl: state.sessionPnl,
    exitReason: reason, entryReason: pos.entryReason,
    entryTime: pos.entryTime, exitTime: trade.exitTime, qty,
    peakPremium: trade.bestOptionLtp, peakPnl: trade.mfePnl,
    maxDrawdown: trade.maePnl, heldMs: trade.durationMs,
  });

  try {
    tickRecorder.recordExit({
      mode: "gap-fix-3m-paper", sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitOptLtp, pnl, reason,
    });
  } catch (_) {}

  state.position = null;
  capitalPool.release(MODE_KEY, pnl);
  try { require("../utils/positionPersist").clearGapFix3mPosition(); } catch (_) {}
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;

  _applyDayBreakers();
}

/** Day-level breakers, evaluated after every exit. Each one CLOSES the day. */
function _applyDayBreakers() {
  if (state.dayClosed) return;
  const maxLoss = _maxDailyLoss();
  const lock    = _dailyProfitLock();
  const maxOuts = _maxDailyLosses();

  if (maxLoss > 0 && state.sessionPnl <= -maxLoss) {
    _closeDay(`Daily loss cap hit (₹${state.sessionPnl} ≤ -₹${maxLoss})`);
    return;
  }
  if (lock > 0 && state.sessionPnl >= lock) {
    _closeDay(`Daily profit lock hit (₹${state.sessionPnl} ≥ ₹${lock}) — banking the day`);
    return;
  }
  if (maxOuts > 0 && state.stopOuts >= maxOuts) {
    _closeDay(`${state.stopOuts} stop-out(s) ≥ ${maxOuts} — day over`);
    return;
  }
  if (state.tradesTaken >= _maxDailyTrades()) {
    _closeDay(`Daily trade budget spent (${state.tradesTaken}/${_maxDailyTrades()})`);
  }
}

function _closeDay(reason) {
  state.dayClosed = true;
  state.dayClosedReason = reason;
  log(`⏸️ [GAP3M-PAPER] ${reason} — no more entries today`);
  skipLogger.appendSkipLog(MODE_KEY, { gate: "day_closed", reason, sessionPnl: state.sessionPnl, spot: state.lastFutPrice });
}

// ── Exits ────────────────────────────────────────────────────────────────────
// Two levels and an EOD. Priority: stop → target. The stop is tested FIRST so a
// move that reached both between two quotes books the loss, which is the only
// honest reading when the path between samples is unknown.
// Every level is guarded with Number.isFinite before it is compared: `price <= null`
// is `price <= 0`, which would square the trade off on its very first quote.
function _checkExits(futPrice) {
  if (!state.position) return;
  if (typeof futPrice !== "number" || !Number.isFinite(futPrice) || futPrice <= 0) return;
  const pos = state.position;
  const optLtp = state.optionLtp || pos.optionEntryLtp;

  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;
  const favPts = (futPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const curPnl = (optLtp - pos.optionEntryLtp) * pos.qty;
  if (favPts > (pos.mfeSpotPts || 0)) { pos.mfeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl > (pos.mfePnl     || 0)) pos.mfePnl = parseFloat(curPnl.toFixed(2));
  if (favPts < (pos.maeSpotPts || 0)) { pos.maeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl < (pos.maePnl     || 0)) pos.maePnl = parseFloat(curPnl.toFixed(2));

  // 1. Stop — the frozen day extreme was taken out. The fade was wrong.
  if (gapStrategy.stopHit(pos.side, futPrice, pos.slSpot)) {
    simulateSell(
      `Day ${pos.side === "PE" ? "high" : "low"} taken out — stop ${pos.slSpot} hit (futures ${futPrice}, ${pos.riskPts}pt against)`,
      { isStopOut: true }
    );
    return;
  }

  // 2. Target — the gap filled. That is the entire trade.
  if (gapStrategy.targetHit(pos.side, futPrice, pos.targetSpot)) {
    simulateSell(`Gap filled — ${pos.gapSize}pt ${pos.gapDir} gap closed at ${pos.targetSpot} (futures ${futPrice}, +${favPts.toFixed(1)}pt)`);
  }
}

function _enforceEod() {
  if (!state.position) return;
  if (getISTMinutes() >= _parseMins("GAP3M_FORCED_EXIT", "15:15")) {
    simulateSell(`EOD square-off (${_envStr("GAP3M_FORCED_EXIT", "15:15")} IST) — gap never filled`);
  }
}

// ── Entry evaluation (on futures candle close — CLOSED bars only) ────────────
const ENTRY_RETRY_MS = 5000;

async function evaluateEntry() {
  // Every guard here is synchronous and runs before the first await, so
  // concurrent polls can never open two positions.
  if (state.position || state._entryInFlight || state.dayClosed) return;
  if (state._lastEntryAttemptMs && Date.now() - state._lastEntryAttemptMs < ENTRY_RETRY_MS) return;
  if (state.tradesTaken >= _maxDailyTrades()) { _applyDayBreakers(); return; }

  // ── Risk gates ──────────────────────────────────────────────────────────
  const maxWeek = _maxWeeklyLoss();
  if (maxWeek > 0) {
    const wk = weeklyPnl();
    if (wk <= -maxWeek) { _closeDay(`Weekly loss cap hit (week P&L ₹${wk} ≤ -₹${maxWeek})`); return; }
  }
  {
    const pf = require("../utils/portfolioRisk").checkPortfolioCap();
    if (pf.blocked) { _closeDay(pf.reason); return; }
  }

  // ── The signal ──────────────────────────────────────────────────────────
  const sig = gapStrategy.getSignal(state.candles, { alreadyTraded: false, silent: true });
  state.lastSignal = sig;
  if (sig.gap) state.lastGap = { ...sig.gap, seenAt: istNow() };

  if (sig.signal === "NONE" || !sig.side) {
    // Only log the interesting near-misses — a "no gap" line every 3 minutes
    // would bury the day file 125 entries deep.
    if (!sig.warmup && sig.gap) {
      skipLogger.appendSkipLog(MODE_KEY, {
        gate: sig.crossed ? "breakout_real" : "no_return",
        reason: sig.skipReason || sig.reason,
        spot: state.lastFutPrice,
        gapDir: sig.gapDir, gapSize: sig.gapSize, gapTop: sig.gapTop, gapBottom: sig.gapBottom,
        dayHigh: sig.dayHigh, dayLow: sig.dayLow,
        crossed: sig.crossed, returned: sig.returned,
        volume: sig.volume, volumeAvg: sig.volumeAvg, strongVolume: sig.strongVolume,
        rr: sig.rr, slPts: sig.slPts, targetPts: sig.targetPts,
      });
    }
    return;
  }

  log(`🎯 [GAP3M-PAPER] SETUP: ${sig.reason}`);
  state._entryInFlight = true;
  state._lastEntryAttemptMs = Date.now();
  try {
    await simulateBuy(sig.side, sig);
  } finally {
    state._entryInFlight = false;
    if (state.position) {
      state._pendingEntry = null;
    } else {
      // A failed FILL is an infrastructure problem, not a decision. Hold the
      // signal so the next polls can retry it — see _retryPendingEntry. The
      // retry throttle lives on THIS object, not on state._lastEntryAttemptMs:
      // sharing that field would let a retry firing seconds before a bar close
      // throttle out the new bar's own evaluation.
      state._pendingEntry = { side: sig.side, sig, lastAttemptMs: Date.now() };
      log(`⚠️ [GAP3M-PAPER] Entry attempt failed — retrying every ${ENTRY_RETRY_MS / 1000}s until this bar is superseded`);
    }
  }
}

/**
 * Retry a signalled entry whose FILL failed (option LTP unavailable, expiry
 * unresolved, quotes blip). The DECISION is already made and reads only CLOSED
 * bars, so re-running it mid-bar cannot change it — this re-attempts only the
 * broker side, throttled so a persistent failure never hammers the API.
 *
 * The pending signal is dropped at the next candle close (onCandleClose), so a
 * stale setup can never fill minutes later off a gap the market has moved past.
 */
async function _retryPendingEntry() {
  const p = state._pendingEntry;
  if (!p) return;
  if (state.position || state._entryInFlight) return;
  if (state.dayClosed || state.tradesTaken >= _maxDailyTrades()) { state._pendingEntry = null; return; }
  if (getISTMinutes() >= _parseMins("GAP3M_FORCED_EXIT", "15:15")) { state._pendingEntry = null; return; }
  if (Date.now() - p.lastAttemptMs < ENTRY_RETRY_MS) return;

  state._entryInFlight = true;
  p.lastAttemptMs = Date.now();
  try {
    await simulateBuy(p.side, p.sig);
  } finally {
    state._entryInFlight = false;
    if (state.position) state._pendingEntry = null;
  }
}

// ── Futures candle close handler ─────────────────────────────────────────────
function onCandleClose(bar) {
  // A new bar supersedes any setup still waiting on a failed fill — the market
  // has moved on, and this bar's own evaluation is the current truth.
  state._pendingEntry = null;
  if (state.position) return;                    // exits are per-quote, not per-bar
  if (!bar || typeof bar.time !== "number") return;
  const cfg = gapStrategy.getConfig();
  const closeMins = gapStrategy._utcSecToIstMins(bar.time) + cfg.resolutionMins;
  if (closeMins > cfg.entryEndMin) return;
  evaluateEntry().catch(e => console.error(`🚨 [GAP3M-PAPER] entry-eval error: ${e.message}`));
}

// ── onTick — the NIFTY 50 INDEX feed. Heartbeat, strike spot, index chart. ───
// It drives NO decision: every rule reads closed futures bars instead.
function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (!price || price <= 0) return;

  const resMin = _resMin();
  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  const bucketMs = getBucketStart(Date.now(), resMin);
  if (!state.indexBar || state.indexBarStart !== bucketMs) {
    if (state.indexBar) {
      const lastC = state.indexCandles.length ? state.indexCandles[state.indexCandles.length - 1] : null;
      if (lastC && lastC.time === state.indexBar.time) state.indexCandles[state.indexCandles.length - 1] = { ...state.indexBar };
      else state.indexCandles.push({ ...state.indexBar });
      if (state.indexCandles.length > 300) state.indexCandles.shift();
    }
    const bucketSec = Math.floor(bucketMs / 1000);
    const lastPre = state.indexCandles.length ? state.indexCandles[state.indexCandles.length - 1] : null;
    if (lastPre && lastPre.time === bucketSec) {
      state.indexBar = state.indexCandles.pop();
      state.indexBar.high  = Math.max(state.indexBar.high, price);
      state.indexBar.low   = Math.min(state.indexBar.low, price);
      state.indexBar.close = price;
    } else {
      state.indexBar = { time: bucketSec, open: price, high: price, low: price, close: price };
    }
    state.indexBarStart = bucketMs;
  } else {
    state.indexBar.high  = Math.max(state.indexBar.high, price);
    state.indexBar.low   = Math.min(state.indexBar.low, price);
    state.indexBar.close = price;
  }

  // EOD is enforced on the index tick too, so a stalled futures quote can never
  // hold a position past the square-off time.
  _enforceEod();
}

// ── Preload futures history ──────────────────────────────────────────────────
// Only TODAY matters: every level this strategy reads (the gap, the day high and
// the day low) is a fact about the current session, and there is no indicator to
// seed. A restart at 13:00 therefore recovers the full day in one call.
async function preloadHistory() {
  try {
    const bars = await _fetchFuturesToday();
    if (Array.isArray(bars) && bars.length) {
      const resMin = _resMin();
      const nowBucketSec = Math.floor(getBucketStart(Date.now(), resMin) / 1000);
      state.candles = bars
        .filter(b => b && typeof b.time === "number" && b.time < nowBucketSec)
        .sort((a, b) => a.time - b.time)
        .slice(-400);
      state._histBucket = getBucketStart(Date.now(), resMin);
      state.lastClosedBarTime = state.candles.length ? state.candles[state.candles.length - 1].time : null;
      const ext = gapStrategy.computeDayExtremes(state.candles, {});
      state.dayHigh = ext.high;
      state.dayLow  = ext.low;
      const withVol = state.candles.filter(c => typeof c.volume === "number" && c.volume > 0).length;
      log(`📊 [GAP3M-PAPER] Preloaded ${state.candles.length} closed ${resMin}-min ${state.futSymbol} candles (${withVol} carry volume) — day range so far ${state.dayLow} – ${state.dayHigh}`);
      if (!withVol) {
        log(`⚠️ [GAP3M-PAPER] None of the futures candles carry volume. The break test cannot be proved, so every break of the day extreme will be treated as REAL and skipped.`);
      }
    } else {
      log(`📊 [GAP3M-PAPER] No futures history for ${state.futSymbol} yet — an expired Fyers token returns no data rather than an auth error.`);
    }
  } catch (e) {
    log(`⚠️ [GAP3M-PAPER] Futures preload failed: ${e.message}`);
  }
}

// ── Auto-stop at TRADE_STOP_TIME ─────────────────────────────────────────────
let _autoStopTimer = null;
function scheduleAutoStop() {
  if (_autoStopTimer) clearTimeout(_autoStopTimer);
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  const stopMin = h * 60 + (isNaN(m) ? 0 : m);
  const minsLeft = stopMin - getISTMinutes();
  if (minsLeft <= 0) return;
  _autoStopTimer = setTimeout(() => { log(`⏰ [GAP3M-PAPER] Auto-stop @ ${raw} IST`); stopSession(); }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ────────────────────────────────────────────────────────
router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/gap-fix-3m-paper/status");

  if (String(process.env.GAP3M_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("3M Gap Fix Scalp Disabled", "Enable 3M Gap Fix Scalp Mode in Settings first", "/settings", "Go to Settings"));
  }
  if (String(process.env.GAP3M_PAPER_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("3M Gap Fix Scalp Paper Disabled", "Enable 3M Gap Fix Scalp Paper Trading in Settings first", "/settings", "Go to Settings"));
  }

  const check = sharedSocketState.canStart("GAP_FIX_3M_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/gap-fix-3m-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/gap-fix-3m-paper/status", "← Back"));

  if (getISTMinutes() >= _parseMins("GAP3M_FORCED_EXIT", "15:15")) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${_envStr("GAP3M_FORCED_EXIT", "15:15")} IST — 3M Gap Fix Scalp does not trade after this`, "/gap-fix-3m-paper/status", "← Back"));
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `gap-fix-3m-paper:${Date.now()}`;
  state.futSymbol = futSymbol();

  sharedSocketState.setGapFix3mActive("GAP_FIX_3M_PAPER");

  const cfg = gapStrategy.getConfig();
  log(`🟢 [GAP3M-PAPER] Session started — ${gapStrategy.NAME}`);
  log(`⚙️ [GAP3M-PAPER] Decision chart ${state.futSymbol} @ ${cfg.resolutionMins}m · gap ≥${cfg.minGapPts}pt · confirm within ${cfg.confirmBars} bar(s) · return "${cfg.returnMode}" · break = day extreme + volume ≥${cfg.volMult}× avg(${cfg.volAvgBars})`);
  log(`⚙️ [GAP3M-PAPER] Target = gap fill · SL = day extreme${cfg.slBufferPts ? ` ±${cfg.slBufferPts}pt` : ""} · entries ${_envStr("GAP3M_ENTRY_START", "09:30")}–${_envStr("GAP3M_ENTRY_END", "15:00")} · max ${_maxDailyTrades()}/day · loss cap ₹${_maxDailyLoss()} · EOD ${_envStr("GAP3M_FORCED_EXIT", "15:15")} · qty ${gapLotQty()}`);
  if (cfg.maxSlPts || cfg.minRR || cfg.maxExtremeDist) {
    log(`⚙️ [GAP3M-PAPER] Optional guards ON — ${[cfg.maxSlPts ? `max SL ${cfg.maxSlPts}pt` : null, cfg.minRR ? `min R:R ${cfg.minRR}` : null, cfg.maxExtremeDist ? `gap within ${cfg.maxExtremeDist}pt of the extreme` : null].filter(Boolean).join(" · ")}`);
  }

  await preloadHistory();
  startPolling();

  try {
    tickRecorder.recordSessionStart({
      mode: "gap-fix-3m-paper",
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: state.candles.map(c => ({ ...c })),
      meta: {
        instrument: instrumentConfig.INSTRUMENT,
        resolutionMin: cfg.resolutionMins,
        spotSymbol: NIFTY_INDEX_SYMBOL,
        decisionSymbol: state.futSymbol,
        sessionStartISO: state.sessionStart,
        recordsOptionLtps: true,
      },
    });
  } catch (_) {}

  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [GAP3M-PAPER] Piggybacking on existing WebSocket (NIFTY 50 index — strike + heartbeat only)");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [GAP3M-PAPER] Started WebSocket (NIFTY 50 index — strike + heartbeat only)");
  }

  scheduleAutoStop();

  notifyStarted({
    mode: "GAP-FIX-3M-PAPER",
    text: [
      `📄 3M GAP FIX SCALP PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${gapStrategy.NAME}`,
      `Chart     : ${state.futSymbol} @ ${cfg.resolutionMins}-min (decisions) + NIFTY 50 index (strike)`,
      `Setup     : gap ≥${cfg.minGapPts}pt, next candle must RETURN — a break of the day high/low on ≥${cfg.volMult}× volume is skipped`,
      `Target    : the gap fill level · Stop: the day's high/low`,
      `Max trades: ${_maxDailyTrades()}/day · loss cap ₹${_maxDailyLoss()}`,
      `Square-off: ${_envStr("GAP3M_FORCED_EXIT", "15:15")} IST`,
    ].filter(Boolean).join("\n"),
  });

  res.redirect("/gap-fix-3m-paper/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped");
  state.running = false;
  stopPolling();

  try { tickRecorder.recordSessionStop({ mode: "gap-fix-3m-paper", sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  sharedSocketState.clearGapFix3m();   // clear OWN mode first (else the socket never stops → leak)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: gapStrategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
      saveData(data);
      log(`💾 [GAP3M-PAPER] Session saved — ${state.sessionTrades.length} trades, PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ [GAP3M-PAPER] Save failed: ${e.message}`);
    }
  }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  log(`📋 [GAP3M-PAPER] Day summary — ${state.sessionTrades.length} trade(s), ${wins}W/${state.sessionTrades.length - wins}L, net ₹${state.sessionPnl}, week ₹${weeklyPnl()}`);
  log("🔴 [GAP3M-PAPER] Session stopped");

  notifyDayReport({
    mode: "GAP-FIX-3M-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/gap-fix-3m-paper/status"); });
router.get("/exit", (req, res) => { if (state.position) simulateSell("Manual exit"); res.redirect("/gap-fix-3m-paper/status"); });

// ── /status/chart-data — futures candles + gap band + day H/L + bracket ───────
router.get("/status/chart-data", (req, res) => {
  try {
    const cfg = gapStrategy.getConfig();
    const candles = state.candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.formingFut && (!candles.length || state.formingFut.time > candles[candles.length - 1].time)) {
      candles.push({ time: state.formingFut.time, open: state.formingFut.open, high: state.formingFut.high, low: state.formingFut.low, close: state.formingFut.close });
    }
    const volumes = state.candles
      .filter(c => typeof c.volume === "number" && c.volume > 0)
      .map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? "#134e4a" : "#4c1d24" }));

    const indexCandles = state.indexCandles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.indexBar) indexCandles.push({ time: state.indexBar.time, open: state.indexBar.open, high: state.indexBar.high, low: state.indexBar.low, close: state.indexBar.close });

    const markers = [];
    for (const t of state.sessionTrades) {
      if (t.entryBarTime) markers.push({ time: t.entryBarTime, position: t.side === "CE" ? "belowBar" : "aboveBar", color: t.side === "CE" ? "#10b981" : "#ef4444", shape: t.side === "CE" ? "arrowUp" : "arrowDown", text: `${t.side} ${t.entryPrice}` });
      if (t.exitBarTime)  markers.push({ time: t.exitBarTime,  position: t.side === "CE" ? "aboveBar" : "belowBar", color: (t.pnl || 0) >= 0 ? "#10b981" : "#ef4444", shape: "circle", text: `${(t.pnl || 0) >= 0 ? "+" : ""}${Math.round(t.pnl || 0)}` });
    }

    const pos = state.position;
    const g = state.lastGap;
    res.json({
      candles, volumes, indexCandles, markers,
      dayHigh: state.dayHigh, dayLow: state.dayLow,
      gapTop: g ? g.top : null, gapBottom: g ? g.bottom : null, gapDir: g ? g.dir : null,
      entryPrice: pos ? pos.entrySpot : null,
      stopLoss:   pos ? pos.slSpot : null,
      target:     pos ? pos.targetSpot : null,
      futSymbol:  state.futSymbol,
      resMin:     cfg.resolutionMins,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const futAge = state.lastFutAt ? Math.round((Date.now() - state.lastFutAt) / 1000) : null;
  const data = loadData();
  const cfg = gapStrategy.getConfig();

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * (pos.qty || gapLotQty())).toFixed(2));
  }

  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) }); }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const bestTrade = state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null;
  const worstTrade = state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null;

  const s = state.lastSignal;
  res.json({
    running: state.running, sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-100),
    tickCount: state.tickCount, lastTickPrice: state.lastTickPrice,
    candles: state.candles.length, currentBar: state.formingFut, sessionStart: state.sessionStart,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge,
    wins, losses, winRate, bestTrade, worstTrade, cumPnl, livePnl,
    weeklyPnl: weeklyPnl(),
    // 3M_GAP_FIX_SCALP context
    futSymbol: state.futSymbol, lastFutPrice: state.lastFutPrice, futAgeSec: futAge,
    futCandles: state.candles.length,
    dayHigh: state.dayHigh, dayLow: state.dayLow,
    lastGap: state.lastGap,
    lastCrossed:  s ? s.crossed : null,
    lastReturned: s ? s.returned : null,
    lastVolume:   s ? s.volume : null,
    lastVolumeAvg: s ? s.volumeAvg : null,
    lastStrongVolume: s ? s.strongVolume : null,
    dayClosed: state.dayClosed, dayClosedReason: state.dayClosedReason,
    stopOuts: state.stopOuts, maxDailyLosses: _maxDailyLosses(),
    maxDailyTrades: _maxDailyTrades(),
    dailyProfitLock: _dailyProfitLock(), maxDailyLoss: _maxDailyLoss(),
    lastSkipReason: s && s.signal === "NONE" ? (s.skipReason || s.reason) : null,
    cfg: {
      resMin: cfg.resolutionMins, minGapPts: cfg.minGapPts, confirmBars: cfg.confirmBars,
      returnMode: cfg.returnMode, volAvgBars: cfg.volAvgBars, volMult: cfg.volMult,
      slBufferPts: cfg.slBufferPts, maxSlPts: cfg.maxSlPts, minRR: cfg.minRR,
      maxExtremeDist: cfg.maxExtremeDist,
      entryStart: _envStr("GAP3M_ENTRY_START", "09:30"), entryEnd: _envStr("GAP3M_ENTRY_END", "15:00"),
      forcedExit: _envStr("GAP3M_FORCED_EXIT", "15:15"),
    },
    position: pos ? {
      side: pos.side, symbol: pos.symbol, entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      slSpot: pos.slSpot, targetSpot: pos.targetSpot, riskPts: pos.riskPts, targetPts: pos.targetPts, rr: pos.rr,
      gapDir: pos.gapDir, gapSize: pos.gapSize, gapTop: pos.gapTop, gapBottom: pos.gapBottom,
      optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry,
      peakPremium: pos.peakPremium, entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      qty: pos.qty, currentOptLtp: state.optionLtp,
      heldSec: Math.round((Date.now() - pos.entryTimeMs) / 1000),
    } : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getGapFix3mMode() === "GAP_FIX_3M_LIVE";
  const data = loadData();
  const pos  = state.position;
  const cfg  = gapStrategy.getConfig();

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>3M Gap Fix Scalp — Paper</title>${faviconLink()}
<style>${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.gap-card{background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;margin-bottom:18px;}
.gap-row{display:flex;gap:20px;flex-wrap:wrap;font-size:0.78rem;color:#e2e8f0;margin-top:8px;}
.gap-row .k{color:var(--muted-1,#8ba1c2);margin-right:5px;}
.brk{font-size:0.72rem;color:#f59e0b;margin-top:8px;}
.chart-box{background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;}
</style>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
</head><body>
${buildSidebar('gapFix3mPaper', liveActive)}
<div class="main-content">
${bbRsiTopBar({
  title: "🩹 3M Gap Fix Scalp — Paper",
  metaLine: `NIFTY FUTURES ${cfg.resolutionMins}m · gap ≥${cfg.minGapPts}pt faded to its fill level · SL = the day's high/low · a volume break of the extreme is skipped`,
  running: state.running,
  primaryAction: { href: "/gap-fix-3m-paper/start", label: "▶ Start", color: "#0369a1" },
  stopAction:    { href: "/gap-fix-3m-paper/stop",  label: "■ Stop" },
  historyHref: "/gap-fix-3m-paper/history",
})}

${bbRsiCapitalStrip({ starting: startCap, current: startCap + (data.totalPnl || 0), allTime: data.totalPnl || 0 })}

<div class="gap-card">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Today — the gap watch</div>
    <div style="font-size:0.8rem;color:#94a3b8;" id="fut-sym">${state.futSymbol || futSymbol()}</div>
  </div>
  <div class="gap-row" id="gap-row"><div>Waiting for the first closed futures candles…</div></div>
  <div id="gap-skip" style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-top:8px;"></div>
  ${state.dayClosed ? `<div class="brk">⏸️ ${state.dayClosedReason}</div>` : ""}
</div>

${bbRsiStatGrid([
  { label: "Session P&L", value: inr(state.sessionPnl), color: state.sessionPnl >= 0 ? "#10b981" : "#ef4444" },
  { label: "Trades", value: `${state.tradesTaken}/${_maxDailyTrades()}` },
  { label: "W / L", value: `${wins} / ${losses}` },
  { label: "Day High", value: state.dayHigh != null ? String(state.dayHigh) : "—" },
  { label: "Day Low", value: state.dayLow != null ? String(state.dayLow) : "—" },
  { label: "Futures", value: state.lastFutPrice != null ? String(state.lastFutPrice) : "—" },
])}

${bbRsiCurrentBar({ bar: state.formingFut, resMin: cfg.resolutionMins })}

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">NIFTY FUTURES ${cfg.resolutionMins}m — the decision chart (gap band, day high/low, bracket)</div>
  <div class="chart-box" style="height:420px;">
    <div id="chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;">
      <span style="color:#f59e0b;">── Day high / low (stop)</span> &nbsp;<span style="color:#0ea5e9;">── Gap band</span> &nbsp;<span style="color:#10b981;">── Gap fill (target)</span>
    </div>
  </div>
</div>

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">NIFTY 50 INDEX ${cfg.resolutionMins}m — strike reference only (no rule reads it)</div>
  <div class="chart-box" style="height:240px;"><div id="idxchart" style="width:100%;height:100%;"></div></div>
</div>

<div id="pos-card" style="margin-bottom:18px;">${_positionCardHtml(pos, state.optionLtp)}</div>

${bbRsiActivityLog({ logsJSON: JSON.stringify(state.log.slice(-200)) })}
</div>
<script>
${modalJS()}
async function gapRefresh() {
  try {
    const r = await fetch('/gap-fix-3m-paper/status/data', { cache: 'no-store' });
    const d = await r.json();
    var row = document.getElementById('gap-row');
    if (row) {
      var g = d.lastGap;
      var cells = [];
      cells.push('<div><span class="k">Day range</span>' + (d.dayLow != null ? d.dayLow + ' – ' + d.dayHigh : '—') + '</div>');
      cells.push('<div><span class="k">Last gap</span>' + (g ? g.size + 'pt ' + g.dir + ' (' + g.bottom + '–' + g.top + ')' : 'none yet') + '</div>');
      cells.push('<div><span class="k">Confirm bar</span>' + (d.lastCrossed == null ? '—' : (d.lastCrossed ? 'broke the extreme' : 'stayed inside')) + '</div>');
      cells.push('<div><span class="k">Returning</span>' + (d.lastReturned == null ? '—' : (d.lastReturned ? 'yes' : 'no')) + '</div>');
      cells.push('<div><span class="k">Volume</span>' + (d.lastVolume != null ? d.lastVolume.toLocaleString() + ' vs avg ' + (d.lastVolumeAvg != null ? Math.round(d.lastVolumeAvg).toLocaleString() : '—') : 'unknown') + '</div>');
      cells.push('<div><span class="k">Futures bars</span>' + (d.futCandles || 0) + '</div>');
      row.innerHTML = cells.join('');
    }
    var sk = document.getElementById('gap-skip');
    if (sk) sk.textContent = d.lastSkipReason || '';
    var fs = document.getElementById('fut-sym');
    if (fs && d.futSymbol) fs.textContent = d.futSymbol + (d.lastFutPrice != null ? '  ·  ' + d.lastFutPrice : '');
  } catch (e) {}
}
gapRefresh();
setInterval(gapRefresh, 4000);
</script>
<script>
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var container = document.getElementById('chart');
  var idxc = document.getElementById('idxchart');
  if (!container) return;
  function mk(el, h) {
    return LightweightCharts.createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout:{ background:{type:'solid',color:'#0a0f1c'}, textColor:'#8ba1c2', fontSize:11, fontFamily:"'IBM Plex Mono', monospace" },
      grid:{ vertLines:{color:'#111827'}, horzLines:{color:'#111827'} },
      crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale:{ borderColor:'#1a2236' },
      timeScale:{ borderColor:'#1a2236', timeVisible:true, secondsVisible:false,
        tickMarkFormatter:function(t){ var d=new Date(t*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); } },
    });
  }
  var chart = mk(container);
  var cs = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var vs = chart.addHistogramSeries({ priceFormat:{type:'volume'}, priceScaleId:'vol', color:'#1e3a5f' });
  try { chart.priceScale('vol').applyOptions({ scaleMargins:{ top:0.85, bottom:0 } }); } catch(_) {}
  var ichart = idxc ? mk(idxc) : null;
  var ics = ichart ? ichart.addCandlestickSeries({ upColor:'#334155', downColor:'#475569', borderUpColor:'#475569', borderDownColor:'#475569', wickUpColor:'#475569', wickDownColor:'#475569' }) : null;
  var lines = [], _zoomed = false;
  function addLine(price, color, title, style) {
    if (price == null || !isFinite(price)) return;
    lines.push(cs.createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title }));
  }
  async function fetchChart(){
    try {
      var r = await fetch('/gap-fix-3m-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        vs.setData(d.volumes || []);
        if (!_zoomed) { try {
          var lastT=d.candles[d.candles.length-1].time, firstT=d.candles[0].time;
          chart.timeScale().setVisibleRange({ from:firstT, to:lastT }); _zoomed=true;
        } catch(_){} }
      }
      if (ics && d.indexCandles && d.indexCandles.length) ics.setData(d.indexCandles);
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      lines.forEach(function(l){ try { cs.removePriceLine(l); } catch(_){} });
      lines = [];
      addLine(d.dayHigh, '#f59e0b', 'Day high', LightweightCharts.LineStyle.Dashed);
      addLine(d.dayLow,  '#f59e0b', 'Day low',  LightweightCharts.LineStyle.Dashed);
      addLine(d.gapTop,    '#0ea5e9', 'Gap top',    LightweightCharts.LineStyle.Dotted);
      addLine(d.gapBottom, '#0ea5e9', 'Gap bottom', LightweightCharts.LineStyle.Dotted);
      addLine(d.entryPrice, '#94a3b8', 'Entry',  LightweightCharts.LineStyle.Dotted);
      addLine(d.stopLoss,   '#ef4444', 'Stop',   LightweightCharts.LineStyle.Solid);
      addLine(d.target,     '#10b981', 'Gap fill', LightweightCharts.LineStyle.Solid);
    } catch(e) {}
  }
  fetchChart();
  setInterval(fetchChart, 4000);
  window.addEventListener('resize', function(){
    chart.applyOptions({ width: container.clientWidth });
    if (ichart && idxc) ichart.applyOptions({ width: idxc.clientWidth });
  });
})();
</script>
</body></html>`;
  res.send(html);
});

function _positionCardHtml(pos, optLtp) {
  if (!pos) {
    return `<div style="background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;color:var(--muted-1,#8ba1c2);font-size:0.78rem;">No open position.</div>`;
  }
  const live = optLtp != null ? ((optLtp - pos.optionEntryLtp) * pos.qty).toFixed(0) : "—";
  return `<div style="background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:8px;">Open position</div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:0.8rem;color:#e2e8f0;">
    <div><span style="color:var(--muted-1,#8ba1c2);">Side</span> ${pos.side}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Symbol</span> ${pos.symbol}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Entry (fut)</span> ${pos.entrySpot}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Gap fill</span> ${pos.targetSpot} (${pos.targetPts}pt)</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Stop</span> ${pos.slSpot} (${pos.riskPts}pt)</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">R:R</span> ${pos.rr}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Live P&L</span> ₹${live}</div>
  </div>
</div>`;
}

// ── History + daily-file viewers + restore + reset ────────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = sharedSocketState.getGapFix3mMode() === "GAP_FIX_3M_LIVE";
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  res.send(renderHistoryPage({
    routePrefix: "/gap-fix-3m-paper",
    sidebarKey: "gapFix3mHistory",
    pageTitle: "🩹 3M Gap Fix Scalp Paper Trade History",
    pageDocTitle: "3M Gap Fix Scalp Paper — History",
    modalLabel: "3M Gap Fix Scalp Paper",
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap,
    emptyLabel: "Start 3M Gap Fix Scalp paper trading to record your first session.",
  }));
});

const _GAP3M_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/download/daily-files", (req, res) => {
  const skips  = skipLogger.listDates(MODE_KEY);
  const trades = tradeLogger.listDailyDates(MODE_KEY);
  const byDate = new Map();
  for (const s of skips)  byDate.set(s.date, { date: s.date, skipsSize: s.size, tradesSize: 0 });
  for (const t of trades) { const row = byDate.get(t.date) || { date: t.date, skipsSize: 0, tradesSize: 0 }; row.tradesSize = t.size; byDate.set(t.date, row); }
  const rows = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  res.json(dailyFilesPaginate(rows, req.query));
});

router.get("/download/skips-all", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="gap_fix_3m_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates(MODE_KEY).map(d => d.date).sort();
  let body = "";
  for (const d of dates) { try { const p = skipLogger.filePathFor(MODE_KEY, d); if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8"); } catch (_) {} }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_GAP3M_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `gap_fix_3m_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_GAP3M_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `gap_fix_3m_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_GAP3M_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_GAP3M_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop 3M Gap Fix Scalp paper trading first before deleting a session." });
  const data = loadData();
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= (data.sessions || []).length) return res.status(400).json({ success: false, error: "Invalid session index." });
  data.sessions.splice(idx, 1);
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, message: "Session deleted successfully." });
});

router.post("/restore-session/:date", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop 3M Gap Fix Scalp paper trading before restoring." });
  const date = String(req.params.date || "").trim();
  if (!_GAP3M_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades(MODE_KEY, date);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; if (key) seen.add(String(key)); }
  const missing = allTrades.filter(t => { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; return key && !seen.has(String(key)); });
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
  data.sessions.push({ date, strategy: (missing[0] && missing[0].strategy) || gapStrategy.NAME, pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop 3M Gap Fix Scalp paper trading before resetting." });
  const fresh = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  return res.json({ success: true, message: `3M Gap Fix Scalp paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
});

router.post("/delete-session/:idx", (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const data = loadData();
    if (!Number.isFinite(idx) || idx < 0 || idx >= (data.sessions || []).length) return res.status(400).json({ success: false, error: "Invalid session index" });
    const removed = data.sessions.splice(idx, 1)[0];
    data.totalPnl = parseFloat((data.totalPnl - (removed.pnl || 0)).toFixed(2));
    saveData(data);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get("/download/trades.jsonl", (req, res) => {
  try {
    const data = loadData();
    const records = [];
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) records.push(Object.assign({ date: s.date, mode: MODE_KEY, strategy: s.strategy }, t));
    const today = new Date().toISOString().slice(0, 10);
    const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
    if (ai) {
      const md = aiExport.buildMarkdown(records, { title: "3M Gap Fix Scalp paper trades (full log)", source: "gap-fix-3m-paper" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="gap_fix_3m_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="gap_fix_3m_paper_trades_${today}.jsonl"`);
    res.send(records.map(r => JSON.stringify(r)).join("\n"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function _errorPage(title, message, backHref, backLabel) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>${title}</title>
<style>body{font-family:Inter,sans-serif;background:#040c18;color:#e0eaf8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{color:#94a3b8;margin-bottom:18px;}
a{color:#3b82f6;text-decoration:none;border:0.5px solid #0e1e36;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>${title}</h2><p>${message}</p><a href="${backHref}">${backLabel}</a></body></html>`;
}

module.exports = router;
module.exports.stopSession = stopSession;
// Exposed for offline unit-testing — this decides which number every exit
// is measured against, so it is tested rather than trusted.
module.exports.attributeQuotes = attributeQuotes;

/**
 * PREV ORB SCALP PAPER — /prev-orb-scalp-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL surface. Every decision / fill / exit semantic for PREV_ORB_SCALP
 * lives here; the backtest and the live harness must match THIS, never the
 * reverse (see feedback_paper_logic_untouchable).
 *
 * The day in one paragraph: yesterday's NIFTY high and low are marked. If the
 * 09:15 15-minute candle CLOSES below yesterday's low it is a PE day (above
 * yesterday's high → CE day); otherwise nothing trades. On a PE day the FIRST
 * 3-minute candle that closes below the 09:15 candle's low is bought (ITM PE)
 * at its close. Stop = that 3-min candle's high; target = its size projected
 * down from the entry. At the target the stop jumps to the target and then
 * trails each closed 3-min candle's high. CE is the mirror. One trade a day.
 *
 * Exits, in the order they are tested:
 *   per tick   : global premium profit lock (tradeGuards) → stop → target
 *   per candle : trail to the closed candle's high (PE) / low (CE), only once
 *                the target has been reached
 *   clock      : forced square-off at PREV_ORB_SCALP_FORCED_EXIT (15:15)
 *
 * Signal engine: src/strategies/prev_orb_scalp.js (shared by paper, backtest,
 * live harness and replay — no rule is re-implemented in this file).
 *
 * PERFORMANCE (runs on a t3.micro next to every other engine): the decision
 * series is one 3-min history fetch per bar, levels are recomputed once per
 * bar-set change (not per tick or per poll), the per-tick path is a handful of
 * number compares, and the chart feed only ships yesterday + today.
 *
 * Uses LIVE data but SIMULATES orders locally.
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const strat              = require("../strategies/prev_orb_scalp");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const tradeGuards        = require("../utils/tradeGuards");
const vixFilter          = require("../services/vixFilter");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { renderHistoryPage, dailyFilesPaginate } = require("../utils/paperHistoryUI");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiCapitalStrip, bbRsiStatGrid, bbRsiCurrentBar, bbRsiActivityLog, inr } = require("../utils/bbRsiStyleUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const tradeLogger = require("../utils/tradeLogger");
const aiExport    = require("../utils/aiExport");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const instrumentMode = require("../utils/instrumentMode");
const { istDayFromAny, istIsoFromAny, getISTMinutes, getBucketStart } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");
const { freshSpot, DEFAULT_MAX_AGE_MS: SPOT_MAX_AGE_MS } = require("../utils/freshSpot");
const capitalPool = require("../utils/capitalPool");
const optionChart = require("../utils/optionChart");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "prevOrbScalpPaper";
const MODE_KEY           = "prev_orb_scalp";     // tradeLogger / skipLogger / capitalPool key
const TAG                = "[PREV-ORB-SCALP-PAPER]";
const MAX_CANDLES        = 900;                  // ~7 sessions of 3-min bars — only yesterday + today are read

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "prev_orb_scalp_paper_trades.json");

// ── Config readers (Settings mutates process.env live — never cache) ──────────
function _resMin() { return strat.getConfig().resolutionMins; }
function _forcedExitStr() { return strat._fmtMins(strat.getConfig().forcedExitMin); }
// One trade a day by rule: only the FIRST break candle can ever enter.
function _maxDailyTrades() { return 1; }
function _maxWeeklyLoss()  { const v = parseFloat(process.env.PREV_ORB_SCALP_MAX_WEEKLY_LOSS || "0"); return Number.isFinite(v) && v > 0 ? v : 0; }
function _pollMs() {
  const v = parseInt(process.env.PREV_ORB_SCALP_POLL_MS || "2000", 10);
  return Number.isFinite(v) && v >= 500 && v <= 30000 ? v : 2000;
}
/**
 * Calendar days of history to preload. Only the PREVIOUS SESSION is needed, but
 * a long weekend plus a holiday can put it four calendar days back, so the
 * default 7 always reaches it.
 */
function _warmupDays() {
  const v = parseInt(process.env.PREV_ORB_SCALP_WARMUP_DAYS || "7", 10);
  return Number.isFinite(v) && v >= 2 && v <= 30 ? v : 7;
}
/** Delay after a bar closes before asking the history endpoint for it. */
function _historyLagMs() {
  const v = parseInt(process.env.PREV_ORB_SCALP_HISTORY_LAG_MS || "5000", 10);
  return Number.isFinite(v) && v >= 0 && v <= 60000 ? v : 5000;
}

/**
 * Position size. PREV_ORB_SCALP_LOT_MULTIPLIER (when > 0) overrides the global
 * LOT_MULTIPLIER for this strategy only, clamped by MAX_LOT_MULTIPLIER. Divides
 * by the multiplier getLotQty ACTUALLY applied (it clamps), not the raw env.
 */
function lotQty() {
  const base = instrumentConfig.getLotQty();
  const raw  = parseInt(process.env.PREV_ORB_SCALP_LOT_MULTIPLIER || "0", 10);
  if (!Number.isFinite(raw) || raw <= 0) return base;
  let maxMult = parseInt(process.env.MAX_LOT_MULTIPLIER || "10", 10);
  if (!Number.isFinite(maxMult) || maxMult < 1) maxMult = 10;
  let globalMult = parseInt(process.env.LOT_MULTIPLIER || "1", 10);
  if (!Number.isFinite(globalMult) || globalMult <= 0) globalMult = 1;
  if (globalMult > maxMult) globalMult = maxMult;
  return Math.round((base / globalMult) * Math.min(raw, maxMult));
}

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

let _dataCache = null;
function _initData() { return { capital: parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] }; }
function loadData() {
  if (_dataCache) return _dataCache;
  ensureDir();
  if (!fs.existsSync(PT_FILE)) {
    _dataCache = _initData();
    fs.writeFileSync(PT_FILE, JSON.stringify(_dataCache, null, 2));
    return _dataCache;
  }
  try { _dataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error(`${TAG} prev_orb_scalp_paper_trades.json corrupt — resetting: ${e.message}`);
    _dataCache = _initData();
    fs.writeFileSync(PT_FILE, JSON.stringify(_dataCache, null, 2));
  }
  if (!Array.isArray(_dataCache.sessions)) _dataCache.sessions = [];
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
    // True while sessionPnl holds closed trades NOT yet in the paper-trades file's
    // totalPnl — the capital pool adds sessionPnl only then (see trackSession below).
    _unsaved:       false,
    tradesTaken:    0,
    candles:        [],     // CLOSED 3-min spot bars — the only decision series
    lastClosedBarTime: null,
    formingBar:     null,   // display-only
    tickCount:      0,
    lastTickTime:   null,
    lastTickPrice:  null,
    position:       null,
    optionLtp:      null,
    optionLtpUpdatedAt: null,
    log:            [],
    _sessionId:     null,
    lastSignal:     null,
    levels:         null,   // strat.dayLevels() for the newest bar — recomputed once per bar-set change
    setupSide:      null,
    optionChart:    null,
    dayClosed:      false,
    dayClosedReason: null,
    _histInFlight:  false,
    _histBucket:    null,
    _histFailures:  0,
    _histNextTryMs: null,
    _entryInFlight: false,
    _lastEntryAttemptMs: null,
    _pendingEntry:  null,
    _incompleteLogged: false,
  };
}

function log(msg) {
  const stamp = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23" });
  const line = `[${stamp}] ${msg}`;
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
  console.log(line);
}

function istNow() { return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23" }); }
function _persist() {
  try { require("../utils/positionPersist").savePrevOrbScalpPosition(state.position, { sessionPnl: state.sessionPnl }); } catch (_) {}
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
        const last = saved.reduce((a, b) => (istDayFromAny(b.date) > istDayFromAny(a.date) ? b : a));
        trades = last.trades;
        source = `last session (${last.date || "?"})`;
        stale  = all.length === 0;
      }
    }
    if (!trades.length) return;
    state._staleSession = stale;
    state._unsaved      = false;   // rehydrated trades are not counted: they may have been deleted from History, and the pool must not resurrect them
    state.sessionTrades = trades;
    state.tradesTaken   = trades.length;
    state.sessionPnl = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    if (!state.sessionStart) state.sessionStart = istIsoFromAny(trades[0].entryTime || trades[0].loggedAt);
    console.log(`♻️ ${TAG} Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl})`);
  } catch (err) {
    console.warn(`${TAG} session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => state, TAG);

// Capital pool realized P&L = file totalPnl + this session's unsaved closed trades.
// A replay re-requires this module — it must not replace the live instance's getter.
let _replayLoad = false;
try { _replayLoad = require("../services/tickReplay").isReplayInProgress(); } catch (_) {}
if (!_replayLoad) capitalPool.trackSession(MODE_KEY, () => (state._unsaved ? state.sessionPnl : 0));

/**
 * Realised P&L for the current ISO week (Mon → today) from the per-day JSONL
 * logs. Today's in-memory session substitutes for today's file ONLY while
 * running — an idle page may hold a rehydrated older session.
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

// ── Option premium poll ───────────────────────────────────────────────────────
// Spot arrives on the shared tick feed; only the held option's premium is
// polled, and only while a position is open — a flat session costs no quote
// calls at all.
let _pollTimer = null;
let _pollStopped = true;

/**
 * Pull the OPTION premium out of a getQuotes response, attributed STRICTLY by
 * symbol (an unidentifiable row is dropped, except a single-row answer to a
 * single-symbol request). Exported for the offline test harness.
 */
function attributeQuotes(resp, symbols, optSym) {
  const out = { optLtp: null };
  if (!resp || resp.s !== "ok" || !Array.isArray(resp.d)) return out;
  for (const row of resp.d) {
    const v = (row && row.v) || {};
    const ltp = v.lp || v.ltp;
    if (typeof ltp !== "number" || !Number.isFinite(ltp) || !(ltp > 0)) continue;
    let sym = row && (row.n || row.symbol);
    if (!sym && resp.d.length === 1 && Array.isArray(symbols) && symbols.length === 1) sym = symbols[0];
    if (!sym) continue;
    if (optSym && sym === optSym) out.optLtp = ltp;
  }
  return out;
}

function startPolling() {
  stopPolling();
  _pollStopped = false;
  const poll = async () => {
    if (_pollStopped) return;
    try {
      if (state.position && state.position.isFutures) {
        // Futures trade AT the index level — mirror spot into the premium slot.
        if (state.lastTickPrice > 0) {
          state.optionLtp = state.lastTickPrice;
          state.optionChart = optionChart.pushLtp(state.optionChart, state.position.symbol, state.lastTickPrice);
          state.optionLtpUpdatedAt = Date.now();
        }
      }
      const optSym = (state.position && !state.position.isFutures) ? state.position.symbol : null;
      if (optSym) {
        const symbols = [optSym];
        const r = await fyers.getQuotes(symbols);
        const q = attributeQuotes(r, symbols, optSym);
        // The position may have closed while the quote was in flight.
        if (q.optLtp != null && state.position && state.position.symbol === optSym) {
          state.optionLtp = q.optLtp;
          state.optionChart = optionChart.pushLtp(state.optionChart, optSym, q.optLtp);
          state.optionLtpUpdatedAt = Date.now();
          try { tickRecorder.recordOptionLtp(optSym, q.optLtp, "prev-orb-scalp-paper"); } catch (_) {}
        }
      }
    } catch (_) {}

    // Exits first (a stop must not wait on a history round-trip), then bar work.
    try { if (state.position) _checkExits(state.lastTickPrice); } catch (e) { console.error(`🚨 ${TAG} exit-check error: ${e.message}`); }
    try { _enforceEod(); } catch (e) { console.error(`🚨 ${TAG} eod error: ${e.message}`); }
    _maybeRefreshHistory().catch(e => console.error(`🚨 ${TAG} history refresh error: ${e.message}`));
    if (!state.position && state._pendingEntry) {
      _retryPendingEntry().catch(e => console.error(`🚨 ${TAG} entry-retry error: ${e.message}`));
    }
    if (!_pollStopped) _pollTimer = setTimeout(poll, _pollMs());
  };
  _pollTimer = setTimeout(poll, 250);
}

function stopPolling() {
  _pollStopped = true;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

/** Display-only forming bar. */
function _updateFormingBar(price) {
  const bucketSec = Math.floor(getBucketStart(Date.now(), _resMin()) / 1000);
  if (!state.formingBar || state.formingBar.time !== bucketSec) {
    state.formingBar = { time: bucketSec, open: price, high: price, low: price, close: price, volume: 0 };
    return;
  }
  if (price > state.formingBar.high) state.formingBar.high = price;
  if (price < state.formingBar.low)  state.formingBar.low = price;
  state.formingBar.close = price;
}

// ── Spot history — the ONLY source of the closed bars decisions read ───────
async function _maybeRefreshHistory() {
  if (!state.running || state._histInFlight) return;
  const resMin = _resMin();
  const bucketMs = getBucketStart(Date.now(), resMin);
  if (state._histBucket === bucketMs) return;
  if (Date.now() - bucketMs < _historyLagMs()) return;
  if (state._histNextTryMs && Date.now() < state._histNextTryMs) return;

  state._histInFlight = true;
  try {
    const bars = await _fetchSpotToday();
    if (Array.isArray(bars) && bars.length) {
      state._histBucket = bucketMs;
      state._histFailures = 0;
      state._histNextTryMs = null;
      _mergeBars(bars);
    } else if (getISTMinutes() < strat.getConfig().sessionStartMin) {
      // Before the bell an empty answer is correct, not a failure.
      state._histNextTryMs = Date.now() + 30_000;
    } else {
      _noteHistoryFailure(null);
    }
  } catch (e) {
    _noteHistoryFailure(e && e.message);
  } finally {
    state._histInFlight = false;
  }
}

/** Back off after a failed history fetch — 5s per failure, capped at one bar / 60s. */
function _noteHistoryFailure(why) {
  state._histFailures++;
  const backoffMs = Math.min(_resMin() * 60_000, 60_000, 5000 * Math.min(state._histFailures, 12));
  state._histNextTryMs = Date.now() + backoffMs;
  if (state._histFailures === 3 || state._histFailures % 20 === 0) {
    log(`⚠️ ${TAG} Spot history unavailable ${state._histFailures}× ${why ? `(${why}) ` : ""}— retrying in ${Math.round(backoffMs / 1000)}s. An expired Fyers token returns 0 candles.`);
  }
}

function _todayIst() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); }

/** Today's spot bars at the strategy resolution. Uncached — today is live. */
async function _fetchSpotToday() {
  const { fetchCandles } = require("../services/backtestEngine");
  const today = _todayIst();
  return fetchCandles(NIFTY_INDEX_SYMBOL, String(_resMin()), today, today);
}

/** Enough history to hold the previous session, ending today. */
async function _fetchWarmupBars() {
  const { fetchCandles } = require("../services/backtestEngine");
  const from = new Date(Date.now() - _warmupDays() * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return fetchCandles(NIFTY_INDEX_SYMBOL, String(_resMin()), from, _todayIst());
}

/** Recompute yesterday's range + today's analysis candle — once per bar-set change. */
function _recomputeLevels() {
  try {
    const cfg = strat.getConfig();
    // Anchored to the real calendar day: before today's first bar, the newest
    // bar is yesterday's, and must not be read as today's 09:15 candle.
    state.levels = strat.dayLevels(state.candles, { cfg, day: strat._istDayOf(Math.floor(Date.now() / 1000)) });
    state.setupSide = strat.setupSide(state.levels);
  } catch (e) {
    console.error(`🚨 ${TAG} level recompute error: ${e.message}`);
  }
}

/**
 * Merge freshly fetched bars and act on each genuinely NEW closed bar, oldest
 * first. Fyers history includes the still-forming bar, so any bar whose bucket
 * has not closed is dropped.
 */
function _mergeBars(bars) {
  const nowBucketSec = Math.floor(getBucketStart(Date.now(), _resMin()) / 1000);
  const closed = bars
    .filter(b => b && typeof b.time === "number" && b.time < nowBucketSec)
    .sort((a, b) => a.time - b.time);
  if (!closed.length) return;

  const byTime = new Map();
  for (const c of state.candles) byTime.set(c.time, c);
  const fresh = [];
  for (const c of closed) {
    if (!byTime.has(c.time)) fresh.push(c);
    byTime.set(c.time, c);
  }
  state.candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time).slice(-MAX_CANDLES);
  _recomputeLevels();
  if (!fresh.length) return;

  const newest = fresh[fresh.length - 1];
  state.lastClosedBarTime = newest.time;
  for (const c of fresh) {
    try { onCandleClose(c, c.time !== newest.time); }
    catch (e) { console.error(`🚨 ${TAG} onCandleClose error: ${e.message}`); }
  }
}

// ── Trade simulation ─────────────────────────────────────────────────────────
async function simulateBuy(side, sig) {
  if (!side) return;
  const _sid = state._sessionId;
  // A silent feed leaves lastTickPrice at the last tick it ever saw (on
  // 2026-10-08, the previous close) — decide on a direct quote instead.
  const _spot = await freshSpot({ tickPrice: state.lastTickPrice, tickAt: state.lastTickTime });
  if (_spot.source === "quote") log(`📡 ${TAG} Live feed stale (${_spot.ageMs == null ? "no tick yet" : Math.round(_spot.ageMs / 1000) + "s old"}) — using quoted spot ${_spot.spot}`);
  if (state._sessionId !== _sid) return;
  const spotPrice = _spot.spot;
  if (typeof spotPrice !== "number" || !(spotPrice > 0)) {
    log(`⚠️ ${TAG} No NIFTY spot price yet — entry deferred`);
    return;
  }
  const _isFut = instrumentMode.isFutures();

  let optInfo;
  try {
    optInfo = _isFut
      ? await instrumentMode.resolveEntryInstrument(spotPrice, side, "PREV_ORB_SCALP")
      : await instrumentConfig.validateAndGetOptionSymbol(spotPrice, side, "PREV_ORB_SCALP");
  } catch (e) {
    log(`❌ ${TAG} Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ ${TAG} No valid ${_isFut ? "futures contract" : "expiry"} — skip ${side} entry`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "expiry", reason: _isFut ? "no valid futures contract" : "no valid option expiry", side, spot: spotPrice });
    return;
  }

  let optionEntryLtp = null;
  if (_isFut) {
    optionEntryLtp = spotPrice;
  } else {
    try {
      const r = await fyers.getQuotes([optInfo.symbol]);
      const q = attributeQuotes(r, [optInfo.symbol], optInfo.symbol);
      if (q.optLtp != null) {
        optionEntryLtp = q.optLtp;
        try { tickRecorder.recordOptionLtp(optInfo.symbol, q.optLtp, "prev-orb-scalp-paper"); } catch (_) {}
      }
    } catch (e) {
      log(`⚠️ ${TAG} Option LTP fetch failed: ${e.message} — entry blocked`);
      return;
    }
    if (!optionEntryLtp) {
      log(`❌ ${TAG} Option LTP not available — entry skipped`);
      skipLogger.appendSkipLog(MODE_KEY, { gate: "option_ltp", reason: "no option LTP", symbol: optInfo.symbol, side, spot: spotPrice });
      return;
    }
  }

  // Re-read spot AFTER the awaits — the quote round-trip took real time.
  // A tick that arrived during the awaits is the freshest price; a stale one
  // must not override the quote we just decided on.
  const _tickFresh = typeof state.lastTickPrice === "number" && state.lastTickPrice > 0
    && typeof state.lastTickTime === "number" && Date.now() - state.lastTickTime <= SPOT_MAX_AGE_MS;
  const fillSpot = (_tickFresh || _spot.source !== "quote") && state.lastTickPrice > 0 ? state.lastTickPrice : spotPrice;
  const slSpot = sig.slSpot;
  const targetSpot = sig.targetSpot;
  if (!Number.isFinite(slSpot) || !Number.isFinite(targetSpot)) {
    log(`🚫 ${TAG} Entry ABORTED — levels unusable (SL ${slSpot}, target ${targetSpot})`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "levels_uncomputable", reason: `SL ${slSpot} / target ${targetSpot}`, side, spot: fillSpot });
    return;
  }
  if (strat.stopHit(side, fillSpot, slSpot)) {
    log(`🚫 ${TAG} Entry ABORTED — spot ${fillSpot} is already through the stop ${slSpot}`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "fill_past_stop", reason: `spot ${fillSpot} already beyond stop ${slSpot}`, side, spot: fillSpot });
    return;
  }
  // Every abort path above can still be retried; a position is about to exist,
  // so re-check that nothing else opened one while we awaited.
  if (state.position || !state.running || state._sessionId !== _sid) return;

  const qty = lotQty();
  const slPts = parseFloat(Math.abs(slSpot - fillSpot).toFixed(2));

  const _cap = capitalPool.gate(MODE_KEY, instrumentMode.capitalRequired(qty, optionEntryLtp), { side, symbol: optInfo.symbol, qty });
  if (!_cap.ok) {
    if (!_cap.muted) {
      log(`❌ ${TAG} Entry REFUSED — ${_cap.reason}`);
      skipLogger.appendSkipLog(MODE_KEY, { gate: "capital", reason: _cap.reason, spot: fillSpot, side, symbol: optInfo.symbol, qty, cost: _cap.cost, available: _cap.available });
    }
    return;
  }

  const pos = {
    isFutures:      _isFut,
    side,
    symbol:         optInfo.symbol,
    optionStrike:   optInfo.strike,
    optionExpiry:   optInfo.expiry,
    qty,
    entrySpot:      fillSpot,
    entryPrice:     fillSpot,
    indexAtEntry:   fillSpot,
    spotSymbol:     NIFTY_INDEX_SYMBOL,
    optionEntryLtp,
    entryTime:      istNow(),
    entryTimeMs:    Date.now(),
    vixAtEntry:     vixFilter.getCachedVix(),   // observer-only
    entryUnixSec:   Math.floor(Date.now() / 1000),
    entryBarTime:   Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    slSpot,
    initialSlSpot:  slSpot,
    slPts,
    riskPts:        slPts,
    targetSpot,
    targetReached:  false,
    candleSize:     sig.candleSize,
    signalSpot:     sig.entrySpot,
    signalBarTime:  sig.signalBarTime,
    breakLevel:     sig.breakLevel,
    prevHigh:       sig.prevHigh,
    prevLow:        sig.prevLow,
    prevDate:       sig.prevDate,
    orHigh:         sig.orHigh,
    orLow:          sig.orLow,
    orClose:        sig.orClose,
    signalRawHigh:  sig.rawHigh,
    signalRawLow:   sig.rawLow,
    peakPremium:    optionEntryLtp,
    signalStrength: sig.signalStrength,
    mfeSpotPts: 0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
    entryReason:    sig.reason,
  };

  state.position = pos;
  state.tradesTaken++;
  capitalPool.block(MODE_KEY, instrumentMode.capitalRequired(qty, optionEntryLtp), { side, symbol: optInfo.symbol, qty, premium: optionEntryLtp });
  _persist();
  state.optionLtp = optionEntryLtp;
  if (!_isFut && optionEntryLtp > 0) state.optionChart = optionChart.pushLtp(state.optionChart, optInfo.symbol, optionEntryLtp);
  state.optionLtpUpdatedAt = Date.now();

  const cfg = sig.cfg || strat.getConfig();
  log(`🟢 ${TAG} ${_isFut ? (side === "CE" ? "LONG" : "SHORT") + " FUT" : "BUY_" + side} ${optInfo.symbol} qty=${qty} @ spot=${fillSpot}${_isFut ? "" : ` optLtp=₹${optionEntryLtp}`}`);
  log(`   ├─ Setup  : ${strat._fmtMins(cfg.sessionStartMin)} candle closed ${pos.orClose} ${side === "PE" ? `below yesterday's LOW ${pos.prevLow}` : `above yesterday's HIGH ${pos.prevHigh}`}`);
  log(`   ├─ Break  : first ${cfg.resolutionMins}-min close ${side === "PE" ? "below" : "above"} ${pos.breakLevel} → ${sig.entrySpot}`);
  log(`   ├─ Stop   : ${slSpot} (break candle ${side === "PE" ? "high" : "low"}, ${slPts}pt)`);
  log(`   └─ Target : ${targetSpot} (candle size ${pos.candleSize}pt)${cfg.trailAfterTarget ? " — then SL → target and trail each candle" : " — exit there"} · EOD ${_forcedExitStr()}`);

  notifyEntry({
    mode: "PREV-ORB-SCALP-PAPER",
    side, symbol: optInfo.symbol,
    spotAtEntry: fillSpot, optionEntryLtp,
    qty, stopLoss: slSpot, target: targetSpot,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "prev-orb-scalp-paper", sessionId: state._sessionId, ts: Date.now(),
      side, symbol: optInfo.symbol, qty,
      spotEntry: fillSpot, optionEntry: optionEntryLtp,
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
  const exitSpot = (typeof o.exitSpot === "number" && Number.isFinite(o.exitSpot))
    ? parseFloat(o.exitSpot.toFixed(2))
    : (state.lastTickPrice || pos.entrySpot);
  const qty = pos.qty;
  const _pnlRes = instrumentMode.computePnl({
    side: pos.side, entrySpot: pos.entrySpot, exitSpot,
    entryPremium: pos.optionEntryLtp, exitPremium: exitOptLtp,
    qty, broker: "zerodha",
  });
  const charges = _pnlRes.charges;
  const pnl     = _pnlRes.pnl;

  // Clear the position FIRST so a re-entrant tick can never double-sell it.
  state.position = null;
  // ...which means a throw anywhere below (trade log, persistence) would leave the
  // position cleared with NO notifyExit — and the live harness, which only sees
  // notifyExit, would never close the REAL position. The finally guarantees it.
  let _exitNotified = false;
  try {
  state.sessionPnl = parseFloat((state.sessionPnl + pnl).toFixed(2));
  // Release the block now, before the logging/notify calls below can throw.
  capitalPool.release(MODE_KEY, pnl);

  const trade = {
    side:           pos.side,
    symbol:         pos.symbol,
    qty,
    entryPrice:     pos.entrySpot,
    exitPrice:      exitSpot,
    spotAtEntry:    pos.entrySpot,
    spotAtExit:     exitSpot,
    indexAtEntry:   pos.indexAtEntry,
    spotSymbol:     pos.spotSymbol,
    optionEntryLtp: pos.isFutures ? null : pos.optionEntryLtp,
    optionExitLtp:  pos.isFutures ? null : exitOptLtp,
    bestOptionLtp:  pos.isFutures ? null : (pos.peakPremium || null),
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    entryBarTime:   pos.entryBarTime,
    exitBarTime:    typeof o.exitBarTime === "number" ? o.exitBarTime : Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    pnl,
    pnlMode:        `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp} (levels measured on NIFTY 50 spot)`,
    exitReason:     reason,
    entryReason:    pos.entryReason,
    stopLoss:       pos.slSpot,
    initialStopLoss: pos.initialSlSpot,
    target:         pos.targetSpot,
    targetReached:  !!pos.targetReached,
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    optionType:     pos.side,
    optionEntrySymbol: pos.symbol,
    signalStrength: pos.signalStrength,
    riskPts:        pos.riskPts,
    candleSize:     pos.candleSize,
    breakLevel:     pos.breakLevel,
    prevHigh:       pos.prevHigh,
    prevLow:        pos.prevLow,
    prevDate:       pos.prevDate,
    orHigh:         pos.orHigh,
    orLow:          pos.orLow,
    orClose:        pos.orClose,
    signalRawHigh:  pos.signalRawHigh,
    signalRawLow:   pos.signalRawLow,
    signalBarTime:  pos.signalBarTime,
    mfeSpotPts:     pos.mfeSpotPts || 0,
    mfePnl:         pos.mfePnl || 0,
    maeSpotPts:     pos.maeSpotPts || 0,
    maePnl:         pos.maePnl || 0,
    secsToMFE:      pos.secsToMFE || 0,
    secsToMAE:      pos.secsToMAE || 0,
    vixAtEntry:     pos.vixAtEntry ?? null,
    vixAtExit:      vixFilter.getCachedVix(),
    durationMs:     Date.now() - pos.entryTimeMs,
    charges,
    isSpot:         false,
    isFutures:      !!pos.isFutures,
    instrument:     pos.isFutures ? "NIFTY_FUTURES" : "NIFTY_OPTIONS",
  };
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog(MODE_KEY, trade);

  log(`🔴 ${TAG} EXIT ${pos.side} ${pos.symbol} @ optLtp=₹${exitOptLtp} spot=${exitSpot} | PnL=₹${pnl} (${reason})`);

  _exitNotified = true;
  notifyExit({
    mode: "PREV-ORB-SCALP-PAPER",
    side: pos.side, symbol: pos.symbol,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    optionEntryLtp: pos.optionEntryLtp, optionExitLtp: exitOptLtp,
    pnl, sessionPnl: state.sessionPnl,
    exitReason: reason, entryReason: pos.entryReason,
    entryTime: pos.entryTime, exitTime: trade.exitTime, qty,
    peakPremium: trade.bestOptionLtp, peakPnl: trade.mfePnl,
    maxDrawdown: trade.maePnl, heldMs: trade.durationMs,
  });
  } finally {
    if (!_exitNotified) {
      try {
        notifyExit({
          mode: "PREV-ORB-SCALP-PAPER",
          side: pos.side, symbol: pos.symbol,
          spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
          optionEntryLtp: pos.optionEntryLtp, optionExitLtp: exitOptLtp,
          pnl, sessionPnl: state.sessionPnl,
          exitReason: reason + " (exit bookkeeping failed)", entryReason: pos.entryReason,
          entryTime: pos.entryTime, qty,
        });
      } catch (e) { console.error(`${TAG} fallback notifyExit failed: ${e.message}`); }
    }
  }

  try {
    tickRecorder.recordExit({
      mode: "prev-orb-scalp-paper", sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitOptLtp, pnl, reason,
    });
  } catch (_) {}

  try { require("../utils/positionPersist").clearPrevOrbScalpPosition(); } catch (_) {}
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;

  if (state.tradesTaken >= _maxDailyTrades()) _closeDay(`Daily trade budget spent (${state.tradesTaken}/${_maxDailyTrades()})`);
}

function _closeDay(reason, opts) {
  if (state.dayClosed) return;
  state.dayClosed = true;
  state.dayClosedReason = reason;
  log(`⏸️ ${TAG} ${reason} — no more entries today`);
  if (!(opts && opts.skipLogged)) {
    skipLogger.appendSkipLog(MODE_KEY, { gate: "day_closed", reason, sessionPnl: state.sessionPnl, spot: state.lastTickPrice });
  }
}

// ── Exits ────────────────────────────────────────────────────────────────────
// Per tick: the global premium profit lock, the stop, and the target. The trail
// is a candle-close event (_trailOnBar). Every level is finite-checked inside
// the engine's stopHit/targetHit before it is compared.
function _checkExits(spotPrice) {
  const pos = state.position;
  if (!pos) return;
  if (typeof spotPrice !== "number" || !Number.isFinite(spotPrice) || spotPrice <= 0) return;
  const optLtp = state.optionLtp || pos.optionEntryLtp;

  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;
  const favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const curPnl = (optLtp - pos.optionEntryLtp) * pos.qty;
  if (favPts > pos.mfeSpotPts) { pos.mfeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl > pos.mfePnl) pos.mfePnl = parseFloat(curPnl.toFixed(2));
  if (favPts < pos.maeSpotPts) { pos.maeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl < pos.maePnl) pos.maePnl = parseFloat(curPnl.toFixed(2));

  // Global profit lock — option premium only (in futures optLtp mirrors spot).
  if (!pos.isFutures && pos.optionEntryLtp && state.optionLtp) {
    const plMsg = tradeGuards.checkProfitLock(pos.optionEntryLtp, state.optionLtp, pos.peakPremium);
    if (plMsg) {
      log(`🔒 ${TAG} ${plMsg}`);
      simulateSell(plMsg);
      return;
    }
  }

  if (strat.stopHit(pos.side, spotPrice, pos.slSpot)) {
    const what = pos.targetReached
      ? (pos.slSpot === pos.targetSpot ? "the locked target level" : "the trailed stop")
      : `the break candle's ${pos.side === "CE" ? "low" : "high"}`;
    simulateSell(`Stop hit — spot ${spotPrice} took out ${what} ${pos.slSpot}`);
    return;
  }

  if (!pos.targetReached && strat.targetHit(pos.side, spotPrice, pos.targetSpot)) {
    const act = strat.onTarget(pos);
    if (!act || act.action === "EXIT") {
      simulateSell(`Target hit — spot ${spotPrice} reached ${pos.targetSpot} (candle size ${pos.candleSize}pt)`);
      return;
    }
    pos.targetReached = true;
    pos.slSpot = act.stop;
    pos.slPts = parseFloat(Math.abs(act.stop - pos.entrySpot).toFixed(2));
    log(`🎯 ${TAG} Target ${pos.targetSpot} reached (spot ${spotPrice}) — SL moved to ${pos.slSpot}; now trailing each ${_resMin()}-min candle's ${pos.side === "CE" ? "low" : "high"}`);
    _persist();
  }
}

/** Candle-close trail, only after the target was reached. */
function _trailOnBar(bar) {
  const pos = state.position;
  if (!pos || !pos.targetReached) return;
  if (pos.signalBarTime != null && bar.time <= pos.signalBarTime) return;
  const tr = strat.trailStop(pos, bar);
  if (!tr) return;
  pos.slSpot = tr.stop;
  pos.slPts = parseFloat(Math.abs(tr.stop - pos.entrySpot).toFixed(2));
  log(`🔒 ${TAG} Trail — SL → ${pos.slSpot} (${strat._fmtMins(strat._utcSecToIstMins(bar.time))} candle ${pos.side === "CE" ? "low" : "high"})`);
  _persist();
  // A candle that closed already through its own trailed level stops on the
  // next tick — test now so a quiet tape cannot leave it hanging.
  if (typeof state.lastTickPrice === "number") _checkExits(state.lastTickPrice);
}

function _enforceEod() {
  if (!state.position) return;
  if (getISTMinutes() >= strat.getConfig().forcedExitMin) {
    simulateSell(`EOD square-off (${_forcedExitStr()} IST)`);
  }
}

// ── Entry evaluation (on candle close — CLOSED bars only) ────────────────────
const ENTRY_RETRY_MS = 5000;
// A break candle that closed within this many seconds is still "now" — the
// normal path fetches history HISTORY_LAG_MS (5s) after the close anyway.
const FRESH_BREAK_SEC = 60;

function _skipGate(sig) {
  const r = String(sig.skipReason || sig.reason || "");
  if (/inside yesterday's range/.test(r)) return "no_setup_inside_range";
  if (/incomplete/.test(r))               return "data_incomplete";
  if (/already used/.test(r))             return "setup_spent";
  if (/cut-off/.test(r))                  return "outside_window";
  if (/zero/.test(r))                     return "degenerate_candle";
  if (/budget/.test(r))                   return "day_budget_spent";
  if (/waiting for/.test(r))              return "waiting_for_break";
  return "no_setup";
}

async function evaluateEntry(opts) {
  const o = opts || {};
  // Synchronous guards before the first await — concurrent polls can never
  // open two positions.
  if (state.position || state._entryInFlight || state.dayClosed) return;
  if (state.tradesTaken >= _maxDailyTrades()) { _closeDay(`Daily trade budget spent (${state.tradesTaken}/${_maxDailyTrades()})`); return; }

  const maxWeek = _maxWeeklyLoss();
  if (maxWeek > 0) {
    const wk = weeklyPnl();
    if (wk <= -maxWeek) { _closeDay(`Weekly loss cap hit (week P&L ₹${wk} ≤ -₹${maxWeek})`); return; }
  }
  {
    const pf = require("../utils/portfolioRisk").checkPortfolioCap();
    if (pf.blocked) { _closeDay(pf.reason); return; }
  }

  const series = o.series || state.candles;
  const sig = strat.getSignal(series, { silent: true, alreadyTraded: false });
  state.lastSignal = sig;

  if (sig.signal === "NONE" || !sig.side) {
    // The day's answer is FINAL once the first break is used/missed, or the
    // COMPLETE 09:15 candle closed inside yesterday's range — log it once and
    // close the day. An incomplete 09:15 candle is NOT final (a later history
    // fetch can still fill it), so it is only noted once and left open.
    const final = sig.spent || (sig.dayDead && sig.orClose != null);
    if (!sig.warmup && final) {
      skipLogger.appendSkipLog(MODE_KEY, {
        gate: _skipGate(sig), reason: sig.skipReason || sig.reason, spot: state.lastTickPrice,
        prevHigh: sig.prevHigh, prevLow: sig.prevLow, orHigh: sig.orHigh, orLow: sig.orLow, orClose: sig.orClose,
        setupSide: sig.setupSide, barTime: sig.signalBarTime,
      });
      log(`ℹ️ ${TAG} ${sig.skipReason || sig.reason}`);
      _closeDay(sig.skipReason || sig.reason, { skipLogged: true });
    } else if (sig.dayDead && !state._incompleteLogged) {
      state._incompleteLogged = true;
      log(`⚠️ ${TAG} ${sig.skipReason || sig.reason} — will re-check on the next candle`);
    }
    return;
  }

  // A break candle that only arrived in a late batch is NOT filled at a price
  // printed minutes after its close — and, being the day's only valid break,
  // the setup is then spent.
  if (o.late) {
    const why = `Break candle ${strat._fmtMins(strat._utcSecToIstMins(sig.signalBarTime))} arrived late (batched history) — not filled at a stale price; setup spent`;
    log(`⚠️ ${TAG} ${why}`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "late_bar", reason: why, side: sig.side, spot: state.lastTickPrice, barTime: sig.signalBarTime });
    _closeDay(why);
    return;
  }

  log(`🎯 ${TAG} SETUP: ${sig.reason}`);
  state._entryInFlight = true;
  state._lastEntryAttemptMs = Date.now();
  try {
    await simulateBuy(sig.side, sig);
  } finally {
    state._entryInFlight = false;
    if (state.position) {
      state._pendingEntry = null;
    } else if (!state.dayClosed) {
      // A failed FILL is infrastructure, not a decision — retry until the next bar.
      state._pendingEntry = { side: sig.side, sig, lastAttemptMs: Date.now() };
      log(`⚠️ ${TAG} Entry attempt failed — retrying every ${ENTRY_RETRY_MS / 1000}s until the next candle closes`);
    }
  }
}

async function _retryPendingEntry() {
  const p = state._pendingEntry;
  if (!p) return;
  if (state.position || state._entryInFlight) return;
  if (state.dayClosed || state.tradesTaken >= _maxDailyTrades()) { state._pendingEntry = null; return; }
  if (getISTMinutes() >= strat.getConfig().forcedExitMin) { state._pendingEntry = null; return; }
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

/**
 * One CLOSED bar. `late` = this bar arrived in a batch behind a newer one.
 * An open position trails first; a flat engine evaluates the entry on the
 * series ending AT this bar, so a batch is judged one bar at a time exactly as
 * the backtest judges it.
 */
function onCandleClose(bar, late) {
  if (!bar || typeof bar.time !== "number") return;
  if (!late) state._pendingEntry = null;

  if (state.position) {
    try { _trailOnBar(bar); } catch (e) { console.error(`🚨 ${TAG} trail error: ${e.message}`); }
    return;
  }
  if (state.dayClosed) return;
  const idx = state.candles.findIndex(c => c.time === bar.time);
  if (idx < 0) return;
  const series = late ? state.candles.slice(0, idx + 1) : state.candles;
  evaluateEntry({ series, late: !!late }).catch(e => console.error(`🚨 ${TAG} entry-eval error: ${e.message}`));
}

// ── onTick — NIFTY 50 spot. Drives no entry; owns the per-tick exits. ────────
function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (typeof price !== "number" || !(price > 0)) return;
  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;
  _updateFormingBar(price);
  if (state.position) {
    try { _checkExits(price); } catch (e) { console.error(`🚨 ${TAG} tick exit-check error: ${e.message}`); }
    _enforceEod();
  }
}

// ── Preload ─────────────────────────────────────────────────────────────────
async function preloadHistory() {
  try {
    const bars = await _fetchWarmupBars();
    if (Array.isArray(bars) && bars.length) {
      const resMin = _resMin();
      const nowBucketSec = Math.floor(getBucketStart(Date.now(), resMin) / 1000);
      state.candles = bars
        .filter(b => b && typeof b.time === "number" && b.time < nowBucketSec)
        .sort((a, b) => a.time - b.time)
        .slice(-MAX_CANDLES);
      state._histBucket = getBucketStart(Date.now(), resMin);
      state.lastClosedBarTime = state.candles.length ? state.candles[state.candles.length - 1].time : null;
      _recomputeLevels();
      const lv = state.levels || {};
      log(`📊 ${TAG} Preloaded ${state.candles.length} closed ${resMin}-min candles`);
      if (lv.prevDay) log(`📏 ${TAG} Yesterday (${lv.prevDay.date}) HIGH ${lv.prevDay.high} · LOW ${lv.prevDay.low}${lv.prevDay.complete ? "" : " — INCOMPLETE session, no trade until it is"}`);
      else log(`⏳ ${TAG} No previous session in the preload — raise PREV_ORB_SCALP_WARMUP_DAYS if this persists`);
      if (lv.or && lv.or.complete) log(`📏 ${TAG} 09:15 candle O ${lv.or.open} H ${lv.or.high} L ${lv.or.low} C ${lv.or.close} → ${state.setupSide ? state.setupSide + " day" : "inside yesterday's range, no trade today"}`);

      // Already past the analysis candle at start: judge the newest bar once so
      // the status card says what the day is (a missed first break is reported
      // as spent — never filled late).
      const lastBar = state.candles[state.candles.length - 1];
      if (lastBar && strat._istDayOf(lastBar.time) === strat._istDayOf(Math.floor(Date.now() / 1000))) {
        const sig = strat.getSignal(state.candles, { silent: true });
        state.lastSignal = sig;
        if (sig.signal !== "NONE") {
          // The newest closed bar IS the break. If it closed moments ago this is
          // the same fill the live poll would have made; any older and the
          // price has moved on, so it is not chased.
          const closedAgoSec = Date.now() / 1000 - (sig.signalBarTime + resMin * 60);
          if (closedAgoSec <= FRESH_BREAK_SEC) {
            log(`🎯 ${TAG} Break candle closed ${Math.round(closedAgoSec)}s ago — entering now`);
            evaluateEntry().catch(e => console.error(`🚨 ${TAG} entry-eval error: ${e.message}`));
          } else {
            const why = `Started after the break candle ${strat._fmtMins(strat._utcSecToIstMins(sig.signalBarTime))} closed — not filled late; setup spent`;
            log(`⚠️ ${TAG} ${why}`);
            _closeDay(why);
          }
        } else {
          // Same path as a live candle close: logs and closes a day whose
          // answer is already final (setup spent / inside yesterday's range).
          evaluateEntry().catch(e => console.error(`🚨 ${TAG} entry-eval error: ${e.message}`));
        }
      }
    } else {
      log(`📊 ${TAG} No spot history — Fyers returned an empty series. An expired token returns 0 candles.`);
    }
  } catch (e) {
    log(`⚠️ ${TAG} Spot preload failed: ${e.message}`);
  }
}

// ── Auto-stop at TRADE_STOP_TIME ─────────────────────────────────────────────
let _autoStopTimer = null;
// A session started after its stop time (e.g. a 16:00 start) used to get no
// timer at all and held its socket slot all night. Hard-stop it this long after
// start instead. Never in replay — replay runs at any wall-clock hour.
const LATE_START_GRACE_MIN = 30;
function _lateStartStopMins() {
  try { if (require("../services/tickReplay").isReplayInProgress()) return 0; } catch (_) {}
  const t = (getISTMinutes() + LATE_START_GRACE_MIN) % 1440;
  const hhmm = String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
  log(`⏰ ${TAG} Session started after its stop time — will stop at ${hhmm} IST`);
  return LATE_START_GRACE_MIN;
}

// ── Live-harness lifecycle safety ────────────────────────────────────────────
// The PREV_ORB_SCALP-LIVE harness fires REAL orders on this engine's notify tag. It used to be
// removed only by its own /stop, so it survived auto-stop / EOD / paper-stop /
// SIGTERM and stayed armed: the next paper start then placed real orders. Every
// session-ending path now releases it AFTER the virtual square-off (so the
// harness still sees the closing notifyExit — an exit already in flight runs to
// completion after uninstall), and /start drops a stale one unless the harness
// itself is the caller (?_viaHarness=1). Same contract as ema9vwapPaper.js.
const LIVE_HARNESS_MODE = "PREV_ORB_SCALP-LIVE";
function _releaseLiveHarness(reason) {
  try {
    const lh = require("../services/liveHarness");
    if (!lh.isInstalled(LIVE_HARNESS_MODE)) return false;   // idempotent no-op
    lh.uninstallHarness(LIVE_HARNESS_MODE);
    console.log(`🔒 [${LIVE_HARNESS_MODE}] Live harness released (${reason}) — no further real orders can be placed from this engine.`);
    return true;
  } catch (err) {
    console.error(`[${LIVE_HARNESS_MODE}] harness release FAILED (${reason}): ${err.message}`);
    return false;
  }
}

function scheduleAutoStop() {
  if (_autoStopTimer) clearTimeout(_autoStopTimer);
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const stopMin = strat._parseHHMM(raw, 15 * 60 + 30);
  let minsLeft = stopMin - getISTMinutes();
  if (minsLeft <= 0) { minsLeft = _lateStartStopMins(); if (!minsLeft) return; }
  _autoStopTimer = setTimeout(() => { log(`⏰ ${TAG} Auto-stop @ ${raw} IST`); stopSession(); }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ────────────────────────────────────────────────────────
router.get("/start", async (req, res) => {
  // Live-harness safety net — FIRST statement, before any early return. Only the
  // *LiveHarness twin (which passes _viaHarness=1) may start paper with it attached.
  if (!req.query || req.query._viaHarness !== "1") {
    if (_releaseLiveHarness("paper /start — harness was still installed")) {
      console.log(`🛑 [${LIVE_HARNESS_MODE}] A live harness was still attached and has been REMOVED before starting. This session is paper-only.`);
    }
  }

  if (state.running) return res.redirect("/prev-orb-scalp-paper/status");

  if (String(process.env.PREV_ORB_SCALP_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("Prev ORB Scalp Disabled", "Enable Prev ORB Scalp Mode in Settings first", "/settings", "Go to Settings"));
  }
  if (String(process.env.PREV_ORB_SCALP_PAPER_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("Prev ORB Scalp Paper Disabled", "Enable Prev ORB Scalp Paper Trading in Settings first", "/settings", "Go to Settings"));
  }
  const check = sharedSocketState.canStart("PREV_ORB_SCALP_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/prev-orb-scalp-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/prev-orb-scalp-paper/status", "← Back"));

  if (getISTMinutes() >= strat.getConfig().forcedExitMin) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${_forcedExitStr()} IST — Prev ORB Scalp does not trade after this`, "/prev-orb-scalp-paper/status", "← Back"));
  }
  // Re-check after the awaits: a second click may have started it meanwhile.
  if (state.running) return res.redirect("/prev-orb-scalp-paper/status");

  state = _freshState();
  state.running = true;
  state._unsaved = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `prev-orb-scalp-paper:${Date.now()}`;
  sharedSocketState.setPrevOrbScalpActive("PREV_ORB_SCALP_PAPER");

  const cfg = strat.getConfig();
  log(`🟢 ${TAG} Session started — ${strat.NAME}`);
  log(`⚙️ ${TAG} Setup : ${strat._fmtMins(cfg.sessionStartMin)} ${cfg.orMins}-min candle closes below yesterday's LOW → PE day / above yesterday's HIGH → CE day`);
  log(`⚙️ ${TAG} Entry : first ${cfg.resolutionMins}-min close beyond that candle's low/high, entered at the close · ITM ${process.env.PREV_ORB_SCALP_ITM_STEPS || "1"} strike(s)`);
  log(`⚙️ ${TAG} Exits : SL = break candle's other end · target = its size · ${cfg.trailAfterTarget ? "at target SL → target, then trail each candle" : "exit at target"} · profit lock (global) · EOD ${_forcedExitStr()}`);
  log(`⚙️ ${TAG} Limits: entries until ${strat._fmtMins(cfg.entryEndMin)} · max ${_maxDailyTrades()} trade(s)/day · qty ${lotQty()}`);

  await preloadHistory();
  startPolling();

  try {
    tickRecorder.recordSessionStart({
      mode: "prev-orb-scalp-paper",
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: state.candles.map(c => ({ ...c })),
      meta: {
        instrument: instrumentConfig.INSTRUMENT,
        resolutionMin: cfg.resolutionMins,
        spotSymbol: NIFTY_INDEX_SYMBOL,
        decisionSymbol: NIFTY_INDEX_SYMBOL,
        sessionStartISO: state.sessionStart,
        recordsOptionLtps: true,
      },
    });
  } catch (_) {}

  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log(`📡 ${TAG} Piggybacking on the existing NIFTY 50 WebSocket`);
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log(`📡 ${TAG} Started the NIFTY 50 WebSocket`);
  }

  scheduleAutoStop();

  notifyStarted({
    mode: "PREV-ORB-SCALP-PAPER",
    text: [
      `📄 PREV ORB SCALP PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Setup     : 09:15 15m candle closes beyond yesterday's high/low`,
      `Entry     : first ${cfg.resolutionMins}m close beyond that candle (ITM)`,
      `Stop/Tgt  : break candle's other end / its size${cfg.trailAfterTarget ? ", then trail" : ""}`,
      `Max trades: ${_maxDailyTrades()}/day · entries till ${strat._fmtMins(cfg.entryEndMin)}`,
      `Square-off: ${_forcedExitStr()} IST`,
    ].join("\n"),
  });

  res.redirect("/prev-orb-scalp-paper/status");
});

function stopSession() {
  if (!state.running) { _releaseLiveHarness("stopSession — engine not running"); return; }
  if (state.position) simulateSell("Session stopped");
  // Released AFTER the virtual square-off above, so the harness still closes the real position.
  _releaseLiveHarness("session end");
  state.running = false;
  stopPolling();

  try { tickRecorder.recordSessionStop({ mode: "prev-orb-scalp-paper", sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  sharedSocketState.clearPrevOrbScalp();   // clear OWN mode first (else the socket never stops)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: strat.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      data.capital  = parseFloat((parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
      saveData(data);
      state._unsaved = false;   // now inside totalPnl — the pool must not add it twice
      capitalPool.sessionSaved(MODE_KEY);
      log(`💾 ${TAG} Session saved — ${state.sessionTrades.length} trade(s), PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ ${TAG} Save failed: ${e.message}`);
    }
  }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  log(`📋 ${TAG} Day summary — ${state.sessionTrades.length} trade(s), ${wins}W/${state.sessionTrades.length - wins}L, net ₹${state.sessionPnl}, week ₹${weeklyPnl()}`);
  log(`🔴 ${TAG} Session stopped`);

  notifyDayReport({
    mode: "PREV-ORB-SCALP-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/prev-orb-scalp-paper/status"); });
router.get("/exit", (req, res) => { if (state.position) simulateSell("Manual exit"); res.redirect("/prev-orb-scalp-paper/status"); });

// ── /status/chart-data — yesterday + today only (small payload) ──────────────
router.get("/status/chart-data", (req, res) => {
  try {
    const cfg = strat.getConfig();
    const lv = state.levels || {};
    const fromDay = lv.prevDay ? lv.prevDay.day : (lv.day != null ? lv.day : null);
    const candles = [];
    for (const c of state.candles) {
      if (fromDay != null && strat._istDayOf(c.time) < fromDay) continue;
      candles.push({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
    }
    const markers = [];
    for (const t of state.sessionTrades) {
      if (t.signalBarTime) markers.push({ time: t.signalBarTime, position: t.side === "CE" ? "belowBar" : "aboveBar", color: t.side === "CE" ? "#10b981" : "#ef4444", shape: t.side === "CE" ? "arrowUp" : "arrowDown", text: `${t.side} ${t.entryPrice}` });
      if (t.exitBarTime)   markers.push({ time: t.exitBarTime, position: t.side === "CE" ? "aboveBar" : "belowBar", color: (t.pnl || 0) >= 0 ? "#10b981" : "#ef4444", shape: "circle", text: `${(t.pnl || 0) >= 0 ? "+" : ""}${Math.round(t.pnl || 0)}` });
    }
    const pos = state.position;
    res.json({
      candles, markers,
      optionChart: optionChart.buildPayload({ store: state.optionChart, position: state.position, trades: state.sessionTrades }),
      prevHigh:   lv.prevDay ? lv.prevDay.high : null,
      prevLow:    lv.prevDay ? lv.prevDay.low : null,
      prevDate:   lv.prevDay ? lv.prevDay.date : null,
      orHigh:     lv.or && lv.or.complete ? lv.or.high : null,
      orLow:      lv.or && lv.or.complete ? lv.or.low : null,
      setupSide:  state.setupSide,
      entryPrice: pos ? pos.entrySpot : null,
      stopLoss:   pos ? pos.slSpot : null,
      target:     pos ? pos.targetSpot : null,
      spotSymbol: NIFTY_INDEX_SYMBOL,
      resMin:     cfg.resolutionMins,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const tickAge = state.lastTickTime ? Math.round((Date.now() - state.lastTickTime) / 1000) : null;
  const data = loadData();
  const cfg = strat.getConfig();
  const lv = state.levels || {};

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = instrumentMode.unrealisedPnl({
      side: pos.side, entrySpot: pos.entrySpot, currentSpot: state.lastTickPrice,
      entryPremium: pos.optionEntryLtp, currentPremium: state.optionLtp, qty: pos.qty || lotQty(),
    });
  }
  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) }); }
  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const n = state.sessionTrades.length;
  const s = state.lastSignal;

  res.json({
    running: state.running, sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-100),
    tickCount: state.tickCount, lastTickPrice: state.lastTickPrice,
    candles: state.candles.length, currentBar: state.formingBar, sessionStart: state.sessionStart,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge,
    wins, losses, winRate: n ? ((wins / n) * 100).toFixed(1) : null,
    bestTrade: n ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null,
    worstTrade: n ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null,
    cumPnl, livePnl, weeklyPnl: weeklyPnl(),
    spotSymbol: NIFTY_INDEX_SYMBOL, tickAgeSec: tickAge,
    prevHigh: lv.prevDay ? lv.prevDay.high : null,
    prevLow:  lv.prevDay ? lv.prevDay.low : null,
    prevDate: lv.prevDay ? lv.prevDay.date : null,
    orOpen:  lv.or && lv.or.complete ? lv.or.open : null,
    orHigh:  lv.or && lv.or.complete ? lv.or.high : null,
    orLow:   lv.or && lv.or.complete ? lv.or.low : null,
    orClose: lv.or && lv.or.complete ? lv.or.close : null,
    setupSide: state.setupSide,
    dayClosed: state.dayClosed, dayClosedReason: state.dayClosedReason,
    maxDailyTrades: _maxDailyTrades(),
    lastSkipReason: s && s.signal === "NONE" ? (s.skipReason || s.reason) : null,
    cfg: {
      resMin: cfg.resolutionMins, orMins: cfg.orMins,
      entryStart: strat._fmtMins(cfg.entryStartMin), entryEnd: strat._fmtMins(cfg.entryEndMin),
      forcedExit: strat._fmtMins(cfg.forcedExitMin), trailAfterTarget: cfg.trailAfterTarget,
    },
    position: pos ? {
      side: pos.side, isFutures: !!pos.isFutures, symbol: pos.symbol, entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      slSpot: pos.slSpot, targetSpot: pos.targetSpot, targetReached: pos.targetReached, riskPts: pos.riskPts, candleSize: pos.candleSize,
      optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry,
      peakPremium: pos.peakPremium, entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      qty: pos.qty, currentOptLtp: state.optionLtp,
      heldSec: Math.round((Date.now() - pos.entryTimeMs) / 1000),
    } : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getPrevOrbScalpMode() === "PREV_ORB_SCALP_LIVE";
  const data = loadData();
  const pos  = state.position;
  const cfg  = strat.getConfig();
  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const startCap = parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000");
  const lv = state.levels || {};

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Prev ORB Scalp — Paper</title>${faviconLink()}
<style>${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.po-card{background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;margin-bottom:18px;}
.po-row{display:flex;gap:20px;flex-wrap:wrap;font-size:0.78rem;color:#e2e8f0;margin-top:8px;}
.po-row .k{color:var(--muted-1,#8ba1c2);margin-right:5px;}
.po-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.7rem;font-weight:600;letter-spacing:0.03em;}
.po-ce{background:rgba(16,185,129,0.15);color:#10b981;}
.po-pe{background:rgba(239,68,68,0.15);color:#ef4444;}
.po-none{background:rgba(148,163,184,0.15);color:#94a3b8;}
.brk{font-size:0.72rem;color:#f59e0b;margin-top:8px;}
.chart-box{background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;}
.rule-list{margin:8px 0 0;padding-left:18px;color:var(--muted-1,#8ba1c2);font-size:0.73rem;line-height:1.7;}
.rule-list b{color:#cbd5e1;font-weight:600;}
.legend{position:absolute;top:10px;left:12px;font-size:0.68rem;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;display:flex;gap:10px;flex-wrap:wrap;max-width:calc(100% - 90px);}
@media (max-width: 640px) {
  .po-row{gap:10px 14px;font-size:0.74rem;}
  .po-card{padding:12px;border-radius:9px;}
  .chart-box{border-radius:9px;}
  .rule-list{font-size:0.71rem;padding-left:16px;}
  .legend{font-size:0.62rem;gap:6px;}
}
</style>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
</head><body>
${buildSidebar('prevOrbScalpPaper', liveActive)}
<div class="main-content">
${bbRsiTopBar({
  title: "📐 Prev ORB Scalp — Paper",
  metaLine: `NIFTY 50 · 09:15 ${cfg.orMins}m candle vs yesterday's high/low · first ${cfg.resolutionMins}m close beyond it enters · SL = break candle · target = its size${cfg.trailAfterTarget ? " then trail" : ""}`,
  running: state.running,
  primaryAction: { href: "/prev-orb-scalp-paper/start", label: "▶ Start", color: "#0369a1" },
  stopAction:    { href: "/prev-orb-scalp-paper/stop",  label: "■ Stop" },
  historyHref: "/prev-orb-scalp-paper/history",
})}

${bbRsiCapitalStrip({ starting: startCap, current: startCap + (data.totalPnl || 0), allTime: data.totalPnl || 0 })}

<div class="po-card">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Today — what the engine sees</div>
    <div style="font-size:0.8rem;color:#94a3b8;" id="spot-sym">NIFTY 50</div>
  </div>
  <div class="po-row" id="po-row"><div>Waiting for candles…</div></div>
  <div id="po-skip" style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-top:8px;"></div>
  ${state.dayClosed ? `<div class="brk">⏸️ ${state.dayClosedReason}</div>` : ""}
  <ul class="rule-list">
    <li><b>Setup:</b> the ${strat._fmtMins(cfg.sessionStartMin)} ${cfg.orMins}-min candle closes below yesterday's LOW → PE day; above yesterday's HIGH → CE day. Otherwise no trade.</li>
    <li><b>Entry:</b> the first ${cfg.resolutionMins}-min candle that closes beyond the ${strat._fmtMins(cfg.sessionStartMin)} candle's low (PE) / high (CE), at its close. ITM strike. Until ${strat._fmtMins(cfg.entryEndMin)}, 1 trade a day.</li>
    <li><b>Stop</b> = that candle's high (PE) / low (CE). <b>Target</b> = that candle's size from the entry.</li>
    <li><b>After target:</b> ${cfg.trailAfterTarget ? `stop moves to the target, then follows each closed ${cfg.resolutionMins}-min candle's high (PE) / low (CE).` : "exit at the target."} Global profit lock applies. Square-off ${_forcedExitStr()}.</li>
  </ul>
</div>

${bbRsiStatGrid([
  { label: "Session P&L", value: inr(state.sessionPnl), color: state.sessionPnl >= 0 ? "#10b981" : "#ef4444" },
  { label: "Trades", value: `${state.tradesTaken}/${_maxDailyTrades()}` },
  { label: "W / L", value: `${wins} / ${losses}` },
  { label: "Yday High", value: lv.prevDay ? String(lv.prevDay.high) : "—" },
  { label: "Yday Low", value: lv.prevDay ? String(lv.prevDay.low) : "—" },
  { label: "Day", value: state.setupSide ? state.setupSide + " day" : "—" },
])}

${bbRsiCurrentBar({ bar: state.formingBar, resMin: cfg.resolutionMins })}

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">NIFTY 50 — ${cfg.resolutionMins}m candles, yesterday + today</div>
  <div class="chart-box" style="height:420px;">
    <div id="chart" style="width:100%;height:100%;"></div>
    <div class="legend">
      <span style="color:#3b82f6;">── Yday H/L</span><span style="color:#f59e0b;">┄ 09:15 H/L</span><span style="color:#ef4444;">── Stop</span><span style="color:#10b981;">── Target</span>
    </div>
  </div>
</div>

${optionChart.optionChartHtml('po-opt-chart')}

<div id="pos-card" style="margin-bottom:18px;">${_positionCardHtml(pos, state.optionLtp)}</div>

${bbRsiActivityLog({ logsJSON: JSON.stringify(state.log.slice(-200)) })}
</div>
<script>
${modalJS()}
async function poRefresh() {
  try {
    const r = await fetch('/prev-orb-scalp-paper/status/data', { cache: 'no-store' });
    const d = await r.json();
    var row = document.getElementById('po-row');
    if (row) {
      var cells = [];
      var cls = d.setupSide === 'CE' ? 'po-ce' : d.setupSide === 'PE' ? 'po-pe' : 'po-none';
      cells.push('<div><span class="k">Day</span><span class="po-pill ' + cls + '">' + (d.setupSide ? d.setupSide + ' day' : (d.orClose != null ? 'no trade' : 'waiting')) + '</span></div>');
      cells.push('<div><span class="k">Yday' + (d.prevDate ? ' (' + d.prevDate + ')' : '') + '</span>H ' + (d.prevHigh != null ? d.prevHigh : '—') + ' · L ' + (d.prevLow != null ? d.prevLow : '—') + '</div>');
      cells.push('<div><span class="k">09:15 candle</span>' + (d.orClose != null ? ('H ' + d.orHigh + ' · L ' + d.orLow + ' · C ' + d.orClose) : 'not closed yet') + '</div>');
      if (d.position) cells.push('<div><span class="k">SL / Target</span>' + d.position.slSpot + ' / ' + d.position.targetSpot + (d.position.targetReached ? ' (target hit — trailing)' : '') + '</div>');
      row.innerHTML = cells.join('');
    }
    var sk = document.getElementById('po-skip');
    if (sk) sk.textContent = d.lastSkipReason || '';
    var fs = document.getElementById('spot-sym');
    if (fs) fs.textContent = 'NIFTY 50' + (d.lastTickPrice != null ? '  ·  ' + d.lastTickPrice : '');
  } catch (e) {}
}
poRefresh();
setInterval(poRefresh, 4000);
</script>
<script>
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var container = document.getElementById('chart');
  if (!container) return;
  var chart = LightweightCharts.createChart(container, {
    width: container.clientWidth, height: container.clientHeight,
    layout:{ background:{type:'solid',color:'#0a0f1c'}, textColor:'#8ba1c2', fontSize:11, fontFamily:"'IBM Plex Mono', monospace" },
    grid:{ vertLines:{color:'#111827'}, horzLines:{color:'#111827'} },
    crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale:{ borderColor:'#1a2236' },
    timeScale:{ borderColor:'#1a2236', timeVisible:true, secondsVisible:false,
      tickMarkFormatter:function(t){ var d=new Date((t+19800)*1000); return ('0'+d.getUTCHours()).slice(-2)+':'+('0'+d.getUTCMinutes()).slice(-2); } },
    localization:{ timeFormatter:function(t){ var d=new Date((t+19800)*1000); return ('0'+d.getUTCDate()).slice(-2)+'/'+('0'+(d.getUTCMonth()+1)).slice(-2)+' '+('0'+d.getUTCHours()).slice(-2)+':'+('0'+d.getUTCMinutes()).slice(-2); } },
  });
  var cs = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var lines = [], _zoomed = false, _lastN = -1, _lastT = null;
  function addLine(price, color, title, style) {
    if (price == null || !isFinite(price)) return;
    lines.push(cs.createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title }));
  }
  async function fetchChart(){
    try {
      var r = await fetch('/prev-orb-scalp-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      var c = d.candles || [];
      if (c.length) {
        var lt = c[c.length-1].time;
        if (c.length !== _lastN || lt !== _lastT) { cs.setData(c); _lastN = c.length; _lastT = lt; }
        if (!_zoomed) { try { chart.timeScale().setVisibleRange({ from: c[Math.max(0, c.length-160)].time, to: lt }); _zoomed = true; } catch(_){} }
      }
      cs.setMarkers((d.markers || []).slice().sort(function(a,b){return a.time-b.time;}));
      lines.forEach(function(l){ try { cs.removePriceLine(l); } catch(_){} });
      lines = [];
      addLine(d.prevHigh, '#3b82f6', 'Yday H', LightweightCharts.LineStyle.Solid);
      addLine(d.prevLow,  '#3b82f6', 'Yday L', LightweightCharts.LineStyle.Solid);
      addLine(d.orHigh,   '#f59e0b', '09:15 H', LightweightCharts.LineStyle.Dashed);
      addLine(d.orLow,    '#f59e0b', '09:15 L', LightweightCharts.LineStyle.Dashed);
      addLine(d.entryPrice, '#94a3b8', 'Entry', LightweightCharts.LineStyle.Dotted);
      addLine(d.stopLoss,   '#ef4444', 'Stop',  LightweightCharts.LineStyle.Solid);
      addLine(d.target,     '#10b981', 'Target', LightweightCharts.LineStyle.Solid);
    } catch(e) {}
  }
  fetchChart();
  setInterval(fetchChart, 5000);
  window.addEventListener('resize', function(){ chart.applyOptions({ width: container.clientWidth }); });
})();
</script>
${optionChart.optionChartScript({ dataUrl: '/prev-orb-scalp-paper/status/chart-data', id: 'po-opt-chart' })}
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
    <div><span style="color:var(--muted-1,#8ba1c2);">Entry (spot)</span> ${pos.entrySpot}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Stop</span> ${pos.slSpot}${pos.targetReached ? " (trailing)" : ""}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Target</span> ${pos.targetSpot}${pos.targetReached ? " ✓" : ""}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Candle size</span> ${pos.candleSize}pt</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Live P&L</span> ₹${live}</div>
  </div>
</div>`;
}

// ── History + daily-file viewers + restore + reset ────────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = sharedSocketState.getPrevOrbScalpMode() === "PREV_ORB_SCALP_LIVE";
  res.send(renderHistoryPage({
    routePrefix: "/prev-orb-scalp-paper",
    sidebarKey: "prevOrbScalpHistory",
    pageTitle: "📐 Prev ORB Scalp Paper Trade History",
    pageDocTitle: "Prev ORB Scalp Paper — History",
    modalLabel: "Prev ORB Scalp Paper",
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap: parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000"),
    emptyLabel: "Start Prev ORB Scalp paper trading to record your first session.",
  }));
});

const _DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  res.setHeader("Content-Disposition", `attachment; filename="prev_orb_scalp_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates(MODE_KEY).map(d => d.date).sort();
  let body = "";
  for (const d of dates) { try { const p = skipLogger.filePathFor(MODE_KEY, d); if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8"); } catch (_) {} }
  res.send(body);
});

function _dayFile(kind, date) {
  return kind === "skips" ? skipLogger.filePathFor(MODE_KEY, date) : tradeLogger.dailyFilePathFor(MODE_KEY, date);
}
for (const kind of ["skips", "trades"]) {
  router.get(`/download/${kind}/:date`, (req, res) => {
    const date = req.params.date;
    if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
    const p = _dayFile(kind, date);
    if (!fs.existsSync(p)) return res.status(404).send("not found");
    res.download(p, `prev_orb_scalp_paper_${kind}_${date}.txt`);
  });
  router.get(`/view/${kind}/:date`, (req, res) => {
    const date = req.params.date;
    if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
    const p = _dayFile(kind, date);
    if (!fs.existsSync(p)) return res.status(404).send("not found");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "inline");
    res.sendFile(p);
  });
}

router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop Prev ORB Scalp paper trading first before deleting a session." });
  const data = loadData();
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= (data.sessions || []).length) return res.status(400).json({ success: false, error: "Invalid session index." });
  data.sessions.splice(idx, 1);
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, message: "Session deleted successfully." });
});

router.post("/restore-session/:date", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop Prev ORB Scalp paper trading before restoring." });
  const date = String(req.params.date || "").trim();
  if (!_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades(MODE_KEY, date).filter(t => t && !t.type);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const keyOf = (t) => String(t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`);
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) seen.add(keyOf(t));
  const missing = allTrades.filter(t => !seen.has(keyOf(t)));
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
  data.sessions.push({ date, strategy: strat.NAME, pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => istDayFromAny(a.date).localeCompare(istDayFromAny(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  // Today's restored trades are the ones a restart rehydrated as unsaved — now in totalPnl.
  if (date === tradeLogger.istDateString(Date.now())) state._unsaved = false;
  capitalPool.sessionSaved(MODE_KEY);   // drop the pool's file-P&L memo now
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop Prev ORB Scalp paper trading before resetting." });
  const fresh = parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000");
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  require("../utils/paperReset").clearTodayFiles(MODE_KEY); // else restart rehydrates today's session
  state._unsaved = false;   // the rehydrated unsaved trades were just wiped with the history
  capitalPool.sessionSaved(MODE_KEY);
  return res.json({ success: true, message: `Prev ORB Scalp paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
});

router.get("/download/trades.jsonl", (req, res) => {
  try {
    const data = loadData();
    const records = [];
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) records.push(Object.assign({ date: s.date, mode: MODE_KEY, strategy: s.strategy }, t));
    const today = new Date().toISOString().slice(0, 10);
    const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
    if (ai) {
      const md = aiExport.buildMarkdown(records, { title: "Prev ORB Scalp paper trades (full log)", source: "prev-orb-scalp-paper" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="prev_orb_scalp_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="prev_orb_scalp_paper_trades_${today}.jsonl"`);
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
a{color:#3b82f6;text-decoration:none;border:0.5px solid #0e1e36;padding:8px 14px;border-radius:6px;display:inline-block;min-height:44px;line-height:28px;}</style>
</head><body><h2>${title}</h2><p>${message}</p><a href="${backHref}">${backLabel}</a></body></html>`;
}

module.exports = router;
module.exports.stopSession = stopSession;
// Exposed for offline unit-testing.
module.exports.attributeQuotes = attributeQuotes;
module.exports._test = {
  getState: () => state,
  setState: (s) => { state = s; },
  freshState: _freshState,
  checkExits: _checkExits,
  onCandleClose,
  mergeBars: _mergeBars,
};

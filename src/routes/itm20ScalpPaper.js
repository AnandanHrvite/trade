/**
 * ITM20 SCALP PAPER — /itm20-scalp-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL surface. Every decision / fill / exit semantic for ITM20_SCALP
 * lives here; the backtest must match THIS, never the reverse.
 *
 * The day in one paragraph: the 09:15–09:30 opening range is marked. A 5-min
 * close beyond it (with VWAP and EMA9 agreeing) arms a setup; a retest of the
 * range edge within 3 candles plus a confirmation close fires the signal, and
 * the 1-strike-ITM option is bought on the first quote after that close.
 * Exits on OPTION PREMIUM: +20 target, −10 stop, 15:15 square-off. Max 2
 * trades a day, stop after a win, after 2 losses, or at −20 points.
 *
 * All rules live in src/strategies/itm20_scalp.js — nothing is re-implemented
 * here. This file only fetches bars, fills, polls the premium and books trades.
 *
 * Options only: in futures instrument mode the strategy refuses to enter (its
 * whole rule is a premium target and stop).
 *
 * PERFORMANCE (t3.micro): one 5-min history fetch per bar, signal + series
 * recomputed once per bar-set change, the per-tick path is a few compares, and
 * the chart feed ships yesterday + today only.
 *
 * Uses LIVE data but SIMULATES orders locally.
 */

const express = require("express");
const { trackPath, pathFields } = require("../utils/tradePath");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const strat              = require("../strategies/itm20_scalp");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const optionFeed         = require("../utils/optionFeed");
const tradeGuards        = require("../utils/tradeGuards");
const vixFilter          = require("../services/vixFilter");
const { verifyFyersToken } = require("../services/marketData");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { renderHistoryPage, dailyFilesPaginate } = require("../utils/paperHistoryUI");
const { isTradingAllowed, isExpiryDay } = require("../services/marketData");
const tradeLogger = require("../utils/tradeLogger");
const aiExport    = require("../utils/aiExport");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const instrumentMode = require("../utils/instrumentMode");
const { getCharges } = require("../utils/charges");
const { istDayFromAny, istIsoFromAny, getISTMinutes, getBucketStart } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");
const { freshSpot, DEFAULT_MAX_AGE_MS: SPOT_MAX_AGE_MS } = require("../utils/freshSpot");
const capitalPool = require("../utils/capitalPool");
const optionChart = require("../utils/optionChart");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "itm20ScalpPaper";
const MODE_KEY           = "itm20_scalp";        // tradeLogger / skipLogger / capitalPool key
const TAG                = "[ITM20-SCALP-PAPER]";
const NOTIFY_MODE        = "ITM20-SCALP-PAPER";
const REC_MODE           = "itm20-scalp-paper";
const OPTION_FEED_OWNER  = "itm20-scalp-paper";
const MAX_CANDLES        = 700;                  // ~9 sessions of 5-min bars — only yesterday + today are read

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "itm20_scalp_paper_trades.json");

// ── Config readers (Settings mutates process.env live — never cache) ──────────
const RES_MIN = strat.RESOLUTION_MIN;
function _pollMs() {
  const v = parseInt(process.env.ITM20_SCALP_POLL_MS || "2000", 10);
  return Number.isFinite(v) && v >= 500 && v <= 30000 ? v : 2000;
}
/** Calendar days of history to preload — enough to always reach the previous session. */
function _warmupDays() {
  const v = parseInt(process.env.ITM20_SCALP_WARMUP_DAYS || "7", 10);
  return Number.isFinite(v) && v >= 2 && v <= 30 ? v : 7;
}
function _historyLagMs() {
  const v = parseInt(process.env.ITM20_SCALP_HISTORY_LAG_MS || "5000", 10);
  return Number.isFinite(v) && v >= 0 && v <= 60000 ? v : 5000;
}
function lotQty() { return instrumentConfig.getLotQty(); }
function _strikeStep() { return instrumentConfig.underlyingOf().strikeStep; }

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
    console.error(`${TAG} itm20_scalp_paper_trades.json corrupt — resetting: ${e.message}`);
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
    priorTodayTrades: [],   // today's trades from an EARLIER session (restart / stop+start) — limits only
    sessionPnl:     0,
    _unsaved:       false,
    tradesTaken:    0,
    candles:        [],     // CLOSED 5-min spot bars — the only decision series
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
    lastSignal:     null,   // engine view of the newest bar — dashboard only
    series:         null,   // { times, ema, vwap } yesterday + today, for the chart
    lastExitSec:    null,   // previous trade's exit (unix s) — the engine resumes after it
    expiryDay:      null,   // true / false once checked at start
    dayClosed:      false,
    dayClosedReason: null,
    _histInFlight:  false,
    _histBucket:    null,
    _histFailures:  0,
    _histNextTryMs: null,
    _entryInFlight: false,
    _pendingEntry:  null,
    _lastSkipNote:  null,
    _incompleteLogged: false,
    _reentryBlockUntil: 0,
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
  try { require("../utils/positionPersist").saveItm20ScalpPosition(state.position, { sessionPnl: state.sessionPnl }); } catch (_) {}
}

/**
 * Today's closed trades — this session's plus any from an earlier session
 * today (so a restart or stop/start can never reset the daily limits). A
 * rehydrated older session never counts.
 */
function _todayTrades() {
  const today = tradeLogger.istDateString(Date.now());
  return (state.priorTodayTrades || []).concat(state.sessionTrades.filter(t => t && t.tradeDate === today));
}
/** Today's trades already in the day's JSONL before this session started. */
function _loadPriorTodayTrades() {
  try {
    const today = tradeLogger.istDateString(Date.now());
    return (tradeLogger.readDailyTrades(MODE_KEY, today) || [])
      .filter(t => t && !t.type && typeof t.points === "number" && t.tradeDate === today);
  } catch (_) { return []; }
}
function _riskGate() { return strat.dayRiskGate(_todayTrades(), strat.getConfig()); }

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
    state._unsaved      = false;
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

let _replayLoad = false;
try { _replayLoad = require("../services/tickReplay").isReplayInProgress(); } catch (_) {}
if (!_replayLoad) capitalPool.trackSession(MODE_KEY, () => (state._unsaved ? state.sessionPnl : 0));

/** Realised P&L for the current week (Mon → today) from the per-day JSONL logs. */
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

// ── Option premium poll (only while a position is open) ──────────────────────
let _pollTimer = null;
let _pollStopped = true;

/** Option premium from a getQuotes response, attributed STRICTLY by symbol. */
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
      const optSym = state.position ? state.position.symbol : null;
      if (optSym) {
        optionFeed.track(OPTION_FEED_OWNER, optSym, null);
        const streamed = optionFeed.getFresh(optSym);
        let ltp = streamed ? streamed.ltp : null;
        if (!streamed) {
          const symbols = [optSym];
          const r = await require("../services/marketData").getQuotes(symbols);
          ltp = attributeQuotes(r, symbols, optSym).optLtp;
        }
        if (ltp != null && state.position && state.position.symbol === optSym) {
          state.optionLtp = ltp;
          state.optionChart = optionChart.pushLtp(state.optionChart, optSym, ltp);
          state.optionLtpUpdatedAt = streamed ? streamed.at : Date.now();
          if (!streamed) { try { tickRecorder.recordOptionLtp(optSym, ltp, REC_MODE); } catch (_) {} }
        }
      }
    } catch (_) {}

    try { if (state.position) _checkExits(state.lastTickPrice); } catch (e) { console.error(`🚨 ${TAG} exit-check error: ${e.message}`); }
    try { _checkSquareOff(); } catch (e) { console.error(`🚨 ${TAG} square-off error: ${e.message}`); }
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
  try { optionFeed.release(OPTION_FEED_OWNER); } catch (_) {}
}

function _updateFormingBar(price) {
  const bucketSec = Math.floor(getBucketStart(Date.now(), RES_MIN) / 1000);
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
  const bucketMs = getBucketStart(Date.now(), RES_MIN);
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

function _noteHistoryFailure(why) {
  state._histFailures++;
  const backoffMs = Math.min(RES_MIN * 60_000, 60_000, 5000 * Math.min(state._histFailures, 12));
  state._histNextTryMs = Date.now() + backoffMs;
  if (state._histFailures === 3 || state._histFailures % 20 === 0) {
    log(`⚠️ ${TAG} Spot history unavailable ${state._histFailures}× ${why ? `(${why}) ` : ""}— retrying in ${Math.round(backoffMs / 1000)}s. An expired Fyers token returns 0 candles.`);
  }
}

function _todayIst() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); }

async function _fetchSpotToday() {
  const { fetchCandles } = require("../services/marketData");
  const today = _todayIst();
  return fetchCandles(NIFTY_INDEX_SYMBOL, String(RES_MIN), today, today);
}
async function _fetchWarmupBars() {
  const { fetchCandles } = require("../services/marketData");
  const from = new Date(Date.now() - _warmupDays() * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return fetchCandles(NIFTY_INDEX_SYMBOL, String(RES_MIN), from, _todayIst());
}

/** Engine view + chart series for the newest bar — once per bar-set change. */
function _recomputeView() {
  try {
    const cfg = strat.getConfig();
    state.lastSignal = strat.getSignal(state.candles, { cfg, silent: true, resumeAfterSec: state.lastExitSec });
    const S = strat.computeSeries(state.candles, cfg);
    state.series = {
      times: S.bars.map(b => b.time),
      ema:   S.ema.map(v => (v == null ? null : Math.round(v * 100) / 100)),
      vwap:  S.vwap.map(v => (v == null ? null : Math.round(v * 100) / 100)),
    };
  } catch (e) {
    console.error(`🚨 ${TAG} view recompute error: ${e.message}`);
  }
}

function _mergeBars(bars) {
  const nowBucketSec = Math.floor(getBucketStart(Date.now(), RES_MIN) / 1000);
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
  _recomputeView();
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
  const _spot = await freshSpot({ tickPrice: state.lastTickPrice, tickAt: state.lastTickTime });
  if (_spot.source === "quote") log(`📡 ${TAG} Live feed stale (${_spot.ageMs == null ? "no tick yet" : Math.round(_spot.ageMs / 1000) + "s old"}) — using quoted spot ${_spot.spot}`);
  if (state._sessionId !== _sid) return;
  const spotPrice = _spot.spot;
  if (typeof spotPrice !== "number" || !(spotPrice > 0)) {
    log(`⚠️ ${TAG} No NIFTY spot price yet — entry deferred`);
    return;
  }

  // Exactly one listed strike ITM from the spot at the fill moment.
  const strike = strat.itmStrike(spotPrice, side, _strikeStep());
  if (strike == null) { log(`❌ ${TAG} Could not compute the ITM strike from spot ${spotPrice}`); return; }

  let optInfo;
  try {
    optInfo = await instrumentConfig.validateAndGetOptionSymbol(spotPrice, side, "ITM20_SCALP", { strikeOverride: strike });
  } catch (e) {
    log(`❌ ${TAG} Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ ${TAG} No valid weekly expiry for the ${strike} ${side} — skip entry`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "expiry", reason: "no valid option expiry", side, spot: spotPrice, strike });
    return;
  }

  let optionEntryLtp = null;
  try {
    const r = await require("../services/marketData").getQuotes([optInfo.symbol]);
    const q = attributeQuotes(r, [optInfo.symbol], optInfo.symbol);
    if (q.optLtp != null) {
      optionEntryLtp = q.optLtp;
      try { tickRecorder.recordOptionLtp(optInfo.symbol, q.optLtp, REC_MODE); } catch (_) {}
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

  const _tickFresh = typeof state.lastTickPrice === "number" && state.lastTickPrice > 0
    && typeof state.lastTickTime === "number" && Date.now() - state.lastTickTime <= SPOT_MAX_AGE_MS;
  const fillSpot = (_tickFresh || _spot.source !== "quote") && state.lastTickPrice > 0 ? state.lastTickPrice : spotPrice;
  if (state.position || !state.running || state._sessionId !== _sid) return;
  // A limit may have been reached by a trade that closed while we awaited.
  if (!_riskGate().allowed) return;

  const qty = lotQty();
  const _cap = capitalPool.gate(MODE_KEY, instrumentMode.capitalRequired(qty, optionEntryLtp), { side, symbol: optInfo.symbol, qty });
  if (!_cap.ok) {
    if (!_cap.muted) {
      log(`❌ ${TAG} Entry REFUSED — ${_cap.reason}`);
      skipLogger.appendSkipLog(MODE_KEY, { gate: "capital", reason: _cap.reason, spot: fillSpot, side, symbol: optInfo.symbol, qty, cost: _cap.cost, available: _cap.available });
    }
    return;
  }

  const cfg = sig.cfg || strat.getConfig();
  const gate = _riskGate();
  const tgt = strat.targetLevel(optionEntryLtp, cfg);
  const stp = strat.stopLevel(optionEntryLtp, gate.dayPts, cfg);

  const pos = {
    side,
    symbol:         optInfo.symbol,
    optionStrike:   optInfo.strike,
    optionExpiry:   optInfo.expiry,
    optionExpiryDate: optInfo.expiryDate || null,
    qty,
    entrySpot:      fillSpot,
    entryPrice:     fillSpot,
    indexAtEntry:   fillSpot,
    spotSymbol:     NIFTY_INDEX_SYMBOL,
    optionEntryLtp,
    targetPrem:     tgt,
    stopPrem:       stp.level,
    stopKind:       stp.kind,
    entryTime:      istNow(),
    entryTimeMs:    Date.now(),
    vixAtEntry:     vixFilter.getCachedVix(),   // observer-only
    entryUnixSec:   Math.floor(Date.now() / 1000),
    entryBarTime:   Math.floor(getBucketStart(Date.now(), RES_MIN) / 1000),
    signalSpot:     sig.entrySpot,
    signalBarTime:  sig.signalBarTime,
    breakoutTime:   sig.breakoutTime,
    retestTime:     sig.retestTime,
    orHigh:         sig.orHigh,
    orLow:          sig.orLow,
    vwapAtSignal:   sig.vwap,
    emaAtSignal:    sig.ema,
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
  state.optionChart = optionChart.pushLtp(state.optionChart, optInfo.symbol, optionEntryLtp);
  state.optionLtpUpdatedAt = Date.now();

  log(`🟢 ${TAG} BUY_${side} ${optInfo.symbol} qty=${qty} @ spot=${fillSpot} optLtp=₹${optionEntryLtp}`);
  log(`   ├─ Setup  : ${sig.reason}`);
  log(`   └─ Exits  : target ₹${tgt} (+${cfg.targetPts}) · stop ₹${stp.level} (${stp.kind === "DAILY_LOSS" ? "daily loss cap" : "−" + cfg.slPts}) · square-off ${strat._fmtMins(cfg.squareOffMin)}`);

  notifyEntry({
    mode: NOTIFY_MODE,
    side, symbol: optInfo.symbol,
    spotAtEntry: fillSpot, optionEntryLtp,
    qty, stopLoss: stp.level, target: tgt,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: REC_MODE, sessionId: state._sessionId, ts: Date.now(),
      side, symbol: optInfo.symbol, qty,
      spotEntry: fillSpot, optionEntry: optionEntryLtp,
      stopLoss: stp.level, target: tgt,
      reason: pos.entryReason,
    });
  } catch (_) {}
}

function simulateSell(reason, code) {
  if (!state.position) return;
  const pos = state.position;
  const exitOptLtp = state.optionLtp || pos.optionEntryLtp;
  const exitSpot = state.lastTickPrice || pos.entrySpot;
  const qty = pos.qty;
  const gross   = parseFloat(((exitOptLtp - pos.optionEntryLtp) * qty).toFixed(2));
  const charges = getCharges({ broker: "zerodha", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitOptLtp, qty });
  const pnl     = parseFloat((gross - charges).toFixed(2));
  const points  = parseFloat((exitOptLtp - pos.optionEntryLtp).toFixed(2));

  // Clear the position FIRST so a re-entrant tick can never double-sell it.
  state.position = null;
  state.lastExitSec = Math.floor(Date.now() / 1000);
  state._reentryBlockUntil = tradeGuards.reentryCooldownUntil(Date.now(), RES_MIN);
  let _exitNotified = false;
  let trade = null;
  try {
    state.sessionPnl = parseFloat((state.sessionPnl + pnl).toFixed(2));
    capitalPool.release(MODE_KEY, pnl);

    trade = {
      tradeDate:      tradeLogger.istDateString(Date.now()),
      side:           pos.side,
      symbol:         pos.symbol,
      qty,
      entryPrice:     pos.entrySpot,
      exitPrice:      exitSpot,
      spotAtEntry:    pos.entrySpot,
      spotAtExit:     exitSpot,
      indexAtEntry:   pos.indexAtEntry,
      spotSymbol:     pos.spotSymbol,
      optionEntryLtp: pos.optionEntryLtp,
      optionExitLtp:  exitOptLtp,
      bestOptionLtp:  pos.peakPremium || null,
      points,
      grossPnl:       gross,
      entryTime:      pos.entryTime,
      exitTime:       istNow(),
      entryBarTime:   pos.entryBarTime,
      exitBarTime:    Math.floor(getBucketStart(Date.now(), RES_MIN) / 1000),
      exitUnixSec:    state.lastExitSec,
      pnl,
      pnlMode:        `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp} (${points >= 0 ? "+" : ""}${points} pts)`,
      exitReason:     reason,
      exitCode:       code || "OTHER",
      entryReason:    pos.entryReason,
      stopLoss:       pos.stopPrem,
      target:         pos.targetPrem,
      stopKind:       pos.stopKind,
      optionStrike:   pos.optionStrike,
      optionExpiry:   pos.optionExpiry,
      optionExpiryDate: pos.optionExpiryDate,
      optionType:     pos.side,
      optionEntrySymbol: pos.symbol,
      signalStrength: pos.signalStrength,
      orHigh:         pos.orHigh,
      orLow:          pos.orLow,
      vwapAtSignal:   pos.vwapAtSignal,
      emaAtSignal:    pos.emaAtSignal,
      breakoutTime:   pos.breakoutTime,
      retestTime:     pos.retestTime,
      signalBarTime:  pos.signalBarTime,
      mfeSpotPts:     pos.mfeSpotPts || 0,
      mfePnl:         pos.mfePnl || 0,
      maeSpotPts:     pos.maeSpotPts || 0,
      maePnl:         pos.maePnl || 0,
      secsToMFE:      pos.secsToMFE || 0,
      secsToMAE:      pos.secsToMAE || 0,
      ...pathFields(pos),
      vixAtEntry:     pos.vixAtEntry ?? null,
      vixAtExit:      vixFilter.getCachedVix(),
      durationMs:     Date.now() - pos.entryTimeMs,
      charges,
      isSpot:         false,
      isFutures:      false,
      instrument:     "NIFTY_OPTIONS",
    };
    state.sessionTrades.push(trade);
    tradeLogger.appendTradeLog(MODE_KEY, trade);

    log(`🔴 ${TAG} EXIT ${pos.side} ${pos.symbol} @ optLtp=₹${exitOptLtp} (${points >= 0 ? "+" : ""}${points} pts) spot=${exitSpot} | PnL=₹${pnl} (${reason})`);

    _exitNotified = true;
    notifyExit({
      mode: NOTIFY_MODE,
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
          mode: NOTIFY_MODE,
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
      mode: REC_MODE, sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitOptLtp, pnl, reason,
    });
  } catch (_) {}

  try { require("../utils/positionPersist").clearItm20ScalpPosition(); } catch (_) {}
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;
  _recomputeView();

  const g = _riskGate();
  if (!g.allowed) _closeDay(g.reason);
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
// Per tick / poll: premium target, premium stop (incl. the daily-loss cap), and
// the common Settings guards (profit lock / premium SL, both default off).
function _checkExits(spotPrice) {
  const pos = state.position;
  if (!pos) return;
  if (typeof spotPrice === "number" && Number.isFinite(spotPrice) && spotPrice > 0) {
    const optNow = state.optionLtp || pos.optionEntryLtp;
    const favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
    const curPnl = (optNow - pos.optionEntryLtp) * pos.qty;
    if (favPts > pos.mfeSpotPts) { pos.mfeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
    if (curPnl > pos.mfePnl) pos.mfePnl = parseFloat(curPnl.toFixed(2));
    if (favPts < pos.maeSpotPts) { pos.maeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
    trackPath(pos, favPts, Date.now());
    if (curPnl < pos.maePnl) pos.maePnl = parseFloat(curPnl.toFixed(2));
  }

  const ltp = state.optionLtp;
  if (typeof ltp !== "number" || !Number.isFinite(ltp) || !(ltp > 0)) return;
  if (ltp > pos.peakPremium) pos.peakPremium = ltp;

  if (typeof pos.stopPrem === "number" && Number.isFinite(pos.stopPrem) && ltp <= pos.stopPrem) {
    const msg = pos.stopKind === "DAILY_LOSS"
      ? `Daily loss cap stop — premium ₹${ltp} ≤ ₹${pos.stopPrem}`
      : `Stop-loss −${(pos.optionEntryLtp - pos.stopPrem).toFixed(0)} — premium ₹${ltp} ≤ ₹${pos.stopPrem}`;
    log(`🛑 ${TAG} ${msg}`);
    simulateSell(msg, pos.stopKind === "DAILY_LOSS" ? "DAILY_LOSS" : "SL");
    return;
  }
  if (typeof pos.targetPrem === "number" && Number.isFinite(pos.targetPrem) && ltp >= pos.targetPrem) {
    const msg = `Target +${(pos.targetPrem - pos.optionEntryLtp).toFixed(0)} — premium ₹${ltp} ≥ ₹${pos.targetPrem}`;
    log(`🎯 ${TAG} ${msg}`);
    simulateSell(msg, "TARGET");
    return;
  }
  const plMsg = tradeGuards.checkProfitLock(pos.optionEntryLtp, ltp, pos.peakPremium);
  if (plMsg) {
    log(`🔒 ${TAG} ${plMsg}`);
    simulateSell(plMsg, "PROFIT_LOCK");
  }
}

/** 15:15 square-off — the strategy's own time, independent of TRADE_STOP_TIME. */
function _checkSquareOff() {
  if (!state.running) return;
  const cfg = strat.getConfig();
  if (getISTMinutes() < cfg.squareOffMin) return;
  if (state.position) simulateSell(`Square-off ${strat._fmtMins(cfg.squareOffMin)}`, "SQUARE_OFF");
  if (!state.dayClosed) _closeDay(`Past the ${strat._fmtMins(cfg.squareOffMin)} square-off`);
}

// ── Entry evaluation (on candle close — CLOSED bars only) ────────────────────
const ENTRY_RETRY_MS = 5000;
const FRESH_SIGNAL_SEC = 60;

/** Day-level refusals that need no signal. Returns a reason or null. */
function _dayBlock() {
  const cfg = strat.getConfig();
  const g = _riskGate();
  if (!g.allowed) return g.reason;
  if (state.expiryDay === true && !cfg.tradeExpiryDay) return "Weekly expiry day — skipped (enable Trade On Expiry Day in Settings to allow)";
  if (instrumentMode.isFutures()) return "Instrument mode is FUTURES — ITM20 Scalp trades options only";
  return null;
}

async function evaluateEntry(opts) {
  const o = opts || {};
  if (state.position || state._entryInFlight || state.dayClosed) return;
  if (instrumentMode.isFutures()) {
    const why = "INSTRUMENT=NIFTY_FUTURES — ITM20 Scalp trades an option PREMIUM target/stop, which has no futures equivalent. Switch INSTRUMENT back to NIFTY_OPTIONS to run it.";
    log(`⛔ ${TAG} ${why}`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "instrument", reason: why });
    _closeDay(why, { skipLogged: true });
    return;
  }
  const blocked = _dayBlock();
  if (blocked) { _closeDay(blocked); return; }
  {
    const pf = require("../utils/portfolioRisk").checkPortfolioCap();
    if (pf.blocked) { _closeDay(pf.reason); return; }
  }

  const series = o.series || state.candles;
  const sig = strat.getSignal(series, { silent: true, resumeAfterSec: state.lastExitSec });

  if (sig.signal === "NONE" || !sig.side) {
    if (sig.phase === "closed") {
      skipLogger.appendSkipLog(MODE_KEY, { gate: "outside_window", reason: sig.skipReason, spot: state.lastTickPrice, barTime: sig.signalBarTime });
      _closeDay(sig.skipReason, { skipLogged: true });
      return;
    }
    if (sig.dayDead && !state._incompleteLogged) {
      state._incompleteLogged = true;
      log(`⚠️ ${TAG} ${sig.skipReason} — will re-check on the next candle`);
      return;
    }
    const note = sig.skipReason || "";
    if (note && note !== state._lastSkipNote) {
      state._lastSkipNote = note;
      if (/died|expired|waiting for a retest|re-armed/.test(note)) log(`ℹ️ ${TAG} ${note}`);
      if (/died|expired/.test(note)) {
        skipLogger.appendSkipLog(MODE_KEY, {
          gate: /died/.test(note) ? "back_inside" : "no_retest_confirm", reason: note,
          spot: state.lastTickPrice, orHigh: sig.orHigh, orLow: sig.orLow, barTime: sig.signalBarTime,
        });
      }
    }
    return;
  }

  // A signal candle that only arrived in a late batch is not filled at a stale
  // price — the engine has already counted the setup as used.
  if (o.late) {
    const why = `Signal candle ${strat._fmtMins(strat._utcSecToIstMins(sig.signalBarTime))} arrived late (batched history) — not filled at a stale price`;
    log(`⚠️ ${TAG} ${why}`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "late_bar", reason: why, side: sig.side, spot: state.lastTickPrice, barTime: sig.signalBarTime });
    return;
  }

  if (state._reentryBlockUntil > Date.now()) {
    if (state._reentryBlockLogged !== state._reentryBlockUntil) {
      state._reentryBlockLogged = state._reentryBlockUntil;
      log(`⏸️ ${TAG} Wait-after-exit cooldown — no new entry until ~${new Date(state._reentryBlockUntil).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} (${sig.side} rejected)`);
      skipLogger.appendSkipLog(MODE_KEY, { gate: "cooldown", reason: "wait-after-exit cooldown", side: sig.side, barTime: sig.signalBarTime });
    }
    return;
  }

  log(`🎯 ${TAG} SIGNAL: ${sig.reason}`);
  state._entryInFlight = true;
  try {
    await simulateBuy(sig.side, sig);
  } finally {
    state._entryInFlight = false;
    if (state.position) {
      state._pendingEntry = null;
    } else if (!state.dayClosed && _dayBlock() == null) {
      state._pendingEntry = { side: sig.side, sig, lastAttemptMs: Date.now() };
      log(`⚠️ ${TAG} Entry attempt failed — retrying every ${ENTRY_RETRY_MS / 1000}s until the next candle closes`);
    }
  }
}

async function _retryPendingEntry() {
  const p = state._pendingEntry;
  if (!p) return;
  if (state.position || state._entryInFlight) return;
  if (state.dayClosed || _dayBlock() != null) { state._pendingEntry = null; return; }
  if (state._reentryBlockUntil > Date.now()) { state._pendingEntry = null; return; }
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

/** One CLOSED bar. `late` = this bar arrived in a batch behind a newer one. */
function onCandleClose(bar, late) {
  if (!bar || typeof bar.time !== "number") return;
  if (!late) state._pendingEntry = null;
  if (state.position) return;
  if (state.dayClosed) return;
  const idx = state.candles.findIndex(c => c.time === bar.time);
  if (idx < 0) return;
  const series = late ? state.candles.slice(0, idx + 1) : state.candles;
  evaluateEntry({ series, late: !!late }).catch(e => console.error(`🚨 ${TAG} entry-eval error: ${e.message}`));
}

// ── onTick — NIFTY 50 spot. Drives no entry; owns the per-tick exit check. ──
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
  }
}

// ── Preload ─────────────────────────────────────────────────────────────────
async function preloadHistory() {
  try {
    const bars = await _fetchWarmupBars();
    if (Array.isArray(bars) && bars.length) {
      const nowBucketSec = Math.floor(getBucketStart(Date.now(), RES_MIN) / 1000);
      state.candles = bars
        .filter(b => b && typeof b.time === "number" && b.time < nowBucketSec)
        .sort((a, b) => a.time - b.time)
        .slice(-MAX_CANDLES);
      state._histBucket = getBucketStart(Date.now(), RES_MIN);
      state.lastClosedBarTime = state.candles.length ? state.candles[state.candles.length - 1].time : null;
      _recomputeView();
      const s = state.lastSignal || {};
      log(`📊 ${TAG} Preloaded ${state.candles.length} closed ${RES_MIN}-min candles`);
      if (s.warmup) log(`⏳ ${TAG} ${s.skipReason} — raise ITM20_SCALP_WARMUP_DAYS if this persists`);
      if (s.orHigh != null) log(`📏 ${TAG} Opening range H ${s.orHigh} · L ${s.orLow} · VWAP ${s.vwap} · EMA9 ${s.ema}`);

      const lastBar = state.candles[state.candles.length - 1];
      if (lastBar && strat._istDayOf(lastBar.time) === strat._istDayOf(Math.floor(Date.now() / 1000))) {
        if (s.signal && s.signal !== "NONE") {
          const closedAgoSec = Date.now() / 1000 - (s.signalBarTime + RES_MIN * 60);
          if (closedAgoSec <= FRESH_SIGNAL_SEC) {
            log(`🎯 ${TAG} Signal candle closed ${Math.round(closedAgoSec)}s ago — entering now`);
            evaluateEntry().catch(e => console.error(`🚨 ${TAG} entry-eval error: ${e.message}`));
          } else {
            log(`⚠️ ${TAG} Started after the ${strat._fmtMins(strat._utcSecToIstMins(s.signalBarTime))} signal candle closed — not filled late; that setup is used`);
          }
        } else {
          if (s.missedSignalTime) log(`ℹ️ ${TAG} A signal fired at ${strat._fmtMins(strat._utcSecToIstMins(s.missedSignalTime))} before this session started — not chased`);
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
const LATE_START_GRACE_MIN = 30;
function _lateStartStopMins() {
  try { if (require("../services/tickReplay").isReplayInProgress()) return 0; } catch (_) {}
  const t = (getISTMinutes() + LATE_START_GRACE_MIN) % 1440;
  const hhmm = String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
  log(`⏰ ${TAG} Session started after its stop time — will stop at ${hhmm} IST`);
  return LATE_START_GRACE_MIN;
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
  if (state.running) return res.redirect("/itm20-scalp-paper/status");

  if (String(process.env.ITM20_SCALP_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("ITM20 Scalp Disabled", "Enable ITM20 Scalp Mode in Settings first", "/settings", "Go to Settings"));
  }
  if (String(process.env.ITM20_SCALP_PAPER_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("ITM20 Scalp Paper Disabled", "Enable ITM20 Scalp Paper Trading in Settings first", "/settings", "Go to Settings"));
  }
  const check = sharedSocketState.canStart("ITM20_SCALP_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/itm20-scalp-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/itm20-scalp-paper/status", "← Back"));

  if (getISTMinutes() >= strat.getConfig().squareOffMin) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${strat._fmtMins(strat.getConfig().squareOffMin)} IST — ITM20 Scalp has squared off for the day`, "/itm20-scalp-paper/status", "← Back"));
  }
  let expiry = null;
  try { expiry = await isExpiryDay(); } catch (_) { expiry = null; }
  if (state.running) return res.redirect("/itm20-scalp-paper/status");

  state = _freshState();
  state.running = true;
  state._unsaved = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `itm20-scalp-paper:${Date.now()}`;
  state.expiryDay = expiry;
  state.priorTodayTrades = _loadPriorTodayTrades();
  for (const t of state.priorTodayTrades) {
    if (typeof t.exitUnixSec === "number" && (state.lastExitSec == null || t.exitUnixSec > state.lastExitSec)) state.lastExitSec = t.exitUnixSec;
  }
  sharedSocketState.setItm20ScalpActive("ITM20_SCALP_PAPER");

  const cfg = strat.getConfig();
  log(`🟢 ${TAG} Session started — ${strat.NAME}`);
  log(`⚙️ ${TAG} Range : ${strat._fmtMins(cfg.sessionStartMin)}–${strat._fmtMins(cfg.orEndMin)} high/low · breakout close + VWAP + EMA${cfg.emaPeriod} · retest within ${cfg.retestCandles} candles (±${cfg.retestTolPts}pt) · confirm close`);
  log(`⚙️ ${TAG} Exits : +${cfg.targetPts} / −${cfg.slPts} premium points · square-off ${strat._fmtMins(cfg.squareOffMin)} · 1 strike ITM`);
  log(`⚙️ ${TAG} Limits: entries ${strat._fmtMins(cfg.entryStartMin)}–${strat._fmtMins(cfg.entryEndMin)} · max ${cfg.maxTrades} trades · stop after a win / 2 losses / −${cfg.dailyLossPts} pts · qty ${lotQty()}`);
  if (expiry === true) log(`📅 ${TAG} Today is a weekly expiry day — ${cfg.tradeExpiryDay ? "trading allowed by Settings" : "no entries (monitor only)"}`);
  if (expiry == null) log(`⚠️ ${TAG} Could not check whether today is expiry day — trading as a normal day`);
  if (state.priorTodayTrades.length) {
    const g = _riskGate();
    log(`♻️ ${TAG} ${state.priorTodayTrades.length} trade(s) already taken today (${g.dayPts >= 0 ? "+" : ""}${g.dayPts} pts) — they count toward today's limits`);
    if (!g.allowed) _closeDay(g.reason);
  }

  await preloadHistory();
  startPolling();

  try {
    tickRecorder.recordSessionStart({
      mode: REC_MODE,
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: state.candles.map(c => ({ ...c })),
      meta: {
        instrument: instrumentConfig.INSTRUMENT,
        resolutionMin: RES_MIN,
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
    mode: NOTIFY_MODE,
    text: [
      `📄 ITM20 SCALP PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Setup     : 09:15–09:30 range break + VWAP + EMA9, retest, confirm`,
      `Exit      : +${cfg.targetPts} / −${cfg.slPts} premium pts · square-off ${strat._fmtMins(cfg.squareOffMin)}`,
      `Max trades: ${cfg.maxTrades}/day · entries ${strat._fmtMins(cfg.entryStartMin)}–${strat._fmtMins(cfg.entryEndMin)}`,
    ].join("\n"),
  });

  res.redirect("/itm20-scalp-paper/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped", "SESSION_STOP");
  state.running = false;
  stopPolling();

  try { tickRecorder.recordSessionStop({ mode: REC_MODE, sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  sharedSocketState.clearItm20Scalp();
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: strat.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      data.capital  = parseFloat((parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
      saveData(data);
      state._unsaved = false;
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
    mode: NOTIFY_MODE,
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/itm20-scalp-paper/status"); });
router.get("/exit", (req, res) => { if (state.position) simulateSell("Manual exit", "MANUAL"); res.redirect("/itm20-scalp-paper/status"); });

// ── /status/chart-data — yesterday + today only (small payload) ──────────────
router.get("/status/chart-data", (req, res) => {
  try {
    const s = state.lastSignal || {};
    const S = state.series || { times: [], ema: [], vwap: [] };
    const byTime = new Map(state.candles.map(c => [c.time, c]));
    const candles = [], ema = [], vwap = [];
    let prevDay = null;
    for (let i = 0; i < S.times.length; i++) {
      const t = S.times[i];
      const c = byTime.get(t);
      if (!c) continue;
      candles.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
      if (S.ema[i] != null) ema.push({ time: t, value: S.ema[i] });
      const d = strat._istDayOf(t);
      // Whitespace at a new day so the daily-reset VWAP is not joined overnight.
      if (prevDay != null && d !== prevDay) vwap.push({ time: t });
      else if (S.vwap[i] != null) vwap.push({ time: t, value: S.vwap[i] });
      prevDay = d;
    }
    const markers = [];
    for (const t of _todayTrades()) {
      if (t.signalBarTime) markers.push({ time: t.signalBarTime, position: t.side === "CE" ? "belowBar" : "aboveBar", color: t.side === "CE" ? "#10b981" : "#ef4444", shape: t.side === "CE" ? "arrowUp" : "arrowDown", text: `${t.side} ₹${t.optionEntryLtp}` });
      if (t.exitBarTime)   markers.push({ time: t.exitBarTime, position: t.side === "CE" ? "aboveBar" : "belowBar", color: (t.points || 0) >= 0 ? "#10b981" : "#ef4444", shape: "circle", text: `${(t.points || 0) >= 0 ? "+" : ""}${t.points} pts` });
    }
    if (s.breakoutTime) markers.push({ time: s.breakoutTime, position: s.breakoutSide === "PE" ? "belowBar" : "aboveBar", color: "#f59e0b", shape: "square", text: "BO" });
    if (s.retestTime)   markers.push({ time: s.retestTime, position: s.breakoutSide === "PE" ? "aboveBar" : "belowBar", color: "#38bdf8", shape: "square", text: "RT" });
    const pos = state.position;
    res.json({
      candles, ema, vwap, markers,
      optionChart: optionChart.buildPayload({ store: state.optionChart, position: state.position, trades: state.sessionTrades }),
      orHigh: s.orHigh != null ? s.orHigh : null,
      orLow:  s.orLow != null ? s.orLow : null,
      entryPrice: pos ? pos.entrySpot : null,
      spotSymbol: NIFTY_INDEX_SYMBOL,
      resMin: RES_MIN,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function _signalLight(pos, s) {
  if (pos) return { text: `BUY ${pos.side}`, color: pos.side === "CE" ? "GREEN" : "RED" };
  if (s && s.signal === "BUY_CE") return { text: "BUY CE", color: "GREEN" };
  if (s && s.signal === "BUY_PE") return { text: "BUY PE", color: "RED" };
  return { text: "NO TRADE", color: "GREY" };
}

function _breakoutStatus(s) {
  if (!s || s.orHigh == null) return "Range forming";
  if (s.phase === "up")   return `CE breakout at ${strat._fmtMins(strat._utcSecToIstMins(s.breakoutTime))} (close ${s.breakoutClose})`;
  if (s.phase === "down") return `PE breakout at ${strat._fmtMins(strat._utcSecToIstMins(s.breakoutTime))} (close ${s.breakoutClose})`;
  if (s.phase === "need_inside") return "Waiting for a close back inside the range";
  if (s.phase === "closed") return "Entry window closed";
  return "No breakout";
}
function _retestStatus(s) {
  if (!s || (s.phase !== "up" && s.phase !== "down")) return "—";
  if (s.retestTime) return `Retested at ${strat._fmtMins(strat._utcSecToIstMins(s.retestTime))} — waiting for a confirmation close`;
  return `Waiting for a retest (${s.candlesLeft} candle${s.candlesLeft === 1 ? "" : "s"} left)`;
}

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const tickAge = state.lastTickTime ? Math.round((Date.now() - state.lastTickTime) / 1000) : null;
  const data = loadData();
  const cfg = strat.getConfig();
  const s = state.lastSignal || {};
  const gate = _riskGate();

  let livePnl = null, livePts = null;
  if (pos && state.optionLtp != null) {
    livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * pos.qty).toFixed(2));
    livePts = parseFloat((state.optionLtp - pos.optionEntryLtp).toFixed(2));
  }
  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) }); }
  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const n = state.sessionTrades.length;
  const spot = state.lastTickPrice;
  const step = _strikeStep();
  const light = _signalLight(pos, s);

  res.json({
    running: state.running, sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-100),
    tickCount: state.tickCount, lastTickPrice: spot,
    candles: state.candles.length, currentBar: state.formingBar, sessionStart: state.sessionStart,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge,
    wins, losses, winRate: n ? ((wins / n) * 100).toFixed(1) : null,
    bestTrade: n ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null,
    worstTrade: n ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null,
    cumPnl, livePnl, livePts, weeklyPnl: weeklyPnl(),
    spotSymbol: NIFTY_INDEX_SYMBOL, tickAgeSec: tickAge,
    orHigh: s.orHigh != null ? s.orHigh : null,
    orLow:  s.orLow != null ? s.orLow : null,
    vwap: s.vwap != null ? s.vwap : null,
    ema: s.ema != null ? s.ema : null,
    emaPrev: s.emaPrev != null ? s.emaPrev : null,
    trend: s.trend || null,
    phase: s.phase || null,
    breakoutStatus: _breakoutStatus(s),
    retestStatus: _retestStatus(s),
    signal: light.text, signalColor: light.color,
    itmStrikeCE: pos ? null : strat.itmStrike(spot, "CE", step),
    itmStrikePE: pos ? null : strat.itmStrike(spot, "PE", step),
    dayPts: gate.dayPts,
    riskStatus: state.dayClosed ? (state.dayClosedReason || "Closed") : gate.status === "ONE_LOSS" ? "One loss — one more setup allowed" : "OK",
    riskAllowed: !state.dayClosed && gate.allowed,
    todayTrades: gate.trades,
    expiryDay: state.expiryDay,
    dayClosed: state.dayClosed, dayClosedReason: state.dayClosedReason,
    maxDailyTrades: cfg.maxTrades,
    lastSkipReason: s && s.signal === "NONE" ? (s.skipReason || s.reason) : null,
    cfg: {
      resMin: RES_MIN, emaPeriod: cfg.emaPeriod, targetPts: cfg.targetPts, slPts: cfg.slPts,
      entryStart: strat._fmtMins(cfg.entryStartMin), entryEnd: strat._fmtMins(cfg.entryEndMin),
      squareOff: strat._fmtMins(cfg.squareOffMin), dailyLossPts: cfg.dailyLossPts,
    },
    position: pos ? {
      side: pos.side, isFutures: false, symbol: pos.symbol, entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      targetPrem: pos.targetPrem, stopPrem: pos.stopPrem, stopKind: pos.stopKind,
      optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry,
      peakPremium: pos.peakPremium, entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      qty: pos.qty, currentOptLtp: state.optionLtp,
      heldSec: Math.round((Date.now() - pos.entryTimeMs) / 1000),
    } : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

router.get("/status", (req, res) => {
  const data = loadData();
  const pos  = state.position;
  const cfg  = strat.getConfig();
  const s    = state.lastSignal || {};
  const gate = _riskGate();
  const startCap = parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000");
  const capital  = startCap + (data.totalPnl || 0);
  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const light  = _signalLight(pos, s);
  const LIGHT_CLR = { GREEN: "#10b981", RED: "#ef4444", GREY: "#94a3b8" };
  const inrS = (n) => typeof n === "number" ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
  const pnlColor = (n) => (n || 0) >= 0 ? "#10b981" : "#ef4444";
  const logsJSON = JSON.stringify([...state.log].reverse())
    .replace(/<\/script>/gi, "<\\/script>").replace(/`/g, "\\u0060").replace(/\$/g, "\\u0024");
  const tradesJSON = JSON.stringify(state.sessionTrades.slice(-200))
    .replace(/<\/script>/gi, "<\\/script>").replace(/`/g, "\\u0060").replace(/\$/g, "\\u0024");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
  ${faviconLink()}
  <title>ITM20 Scalp — Paper Trade</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script src="/vendor/lightweight-charts.standalone.production.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#060e06;color:#c0d8b0;overflow-x:hidden;}
${sidebarCSS()}
${modalCSS()}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
    .page{padding:22px 20px 60px;}
    .capital-strip{display:flex;background:#090f09;border:0.5px solid #162416;border-radius:9px;overflow:hidden;margin-bottom:14px;}
    .cap-cell{flex:1;padding:11px 16px;border-right:0.5px solid #162416;}
    .cap-cell:last-child{border-right:none;}
    .cap-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.5px;color:#7f9b5c;margin-bottom:4px;}
    .cap-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#a0c880;}
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-bottom:16px;}
    .sc{background:#090f09;border:0.5px solid #162416;border-radius:8px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.2px;color:#7f9b5c;margin-bottom:5px;}
    .sc-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#c0d8b0;}
    .sc-sub{font-size:0.6rem;color:#7f9b5c;margin-top:3px;}
    .section-title{font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#7f9b5c;margin-bottom:8px;display:flex;align-items:center;gap:8px;}
    .section-title::after{content:'';flex:1;height:0.5px;background:#162416;}
    .sig-light{display:inline-flex;align-items:center;gap:8px;padding:8px 18px;border-radius:999px;font-weight:800;font-size:1rem;letter-spacing:0.05em;font-family:'IBM Plex Mono',monospace;}
    .rule-list{margin:10px 0 0;padding-left:18px;color:#7f9b5c;font-size:0.72rem;line-height:1.7;}
    .rule-list b{color:#c0d8b0;font-weight:600;}
    .tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:0.5px solid #162416;border-radius:10px;}
    table.pt{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.74rem;}
    table.pt th{background:#090f09;color:#7f9b5c;font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;padding:8px 10px;text-align:left;white-space:nowrap;}
    table.pt td{padding:8px 10px;border-top:0.5px solid #162416;white-space:nowrap;}
    .flt{background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;min-height:32px;}
    #logBox div{font-family:'IBM Plex Mono',monospace;font-size:0.7rem;line-height:1.6;color:#a0b8a0;border-bottom:0.5px solid #0f1a0f;padding:2px 0;word-break:break-word;}
    @media(max-width:640px){
      .page{padding:14px 12px 40px;}
      .stat-grid{grid-template-columns:1fr 1fr;gap:7px;}
      .capital-strip{flex-wrap:wrap;}
      .cap-cell{min-width:50%;}
      .flt,button,a.btn{min-height:44px;}
      body{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);}
    }
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('itm20ScalpPaper', false, state.running, {
  showExitBtn:  !!pos,
  showStopBtn:  state.running,
  showStartBtn: !state.running,
  exitBtnJs:    'izExit(this)',
  stopBtnJs:    'izStop(this)',
  startBtnJs:   'izStart(this)',
  exitLabel:    '🚪 Exit Trade',
  stopLabel:    '■ Stop Paper',
  startLabel:   '▶ Start Paper',
})}
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">🎯 ITM20 Scalp — Paper Trade</div>
      <div class="top-bar-meta">${strat.NAME} · NIFTY 50 · 5-min candles · 1 strike ITM · +${cfg.targetPts} / −${cfg.slPts} premium pts · ${state.running ? "Auto-refreshes every 3s" : "Stopped"}</div>
    </div>
    <div class="top-bar-right">
      ${state.running
        ? '<span class="top-bar-badge paper-active"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>RUNNING</span>'
        : '<span class="top-bar-badge">● IDLE</span>'}
      ${state.expiryDay === true ? `<span class="top-bar-badge" style="color:#f59e0b;border-color:rgba(245,158,11,0.3);">📅 EXPIRY DAY${cfg.tradeExpiryDay ? "" : " · NO ENTRIES"}</span>` : ""}
      <a href="/itm20-scalp-paper/history" style="background:rgba(59,130,246,0.08);border:0.5px solid rgba(59,130,246,0.3);color:#60a5fa;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;text-decoration:none;">📊 History</a>
      <button onclick="izReset(this)" style="background:#07111f;border:0.5px solid #0e1e36;color:var(--muted-1,#8ba1c2);padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;">↺ Reset</button>
    </div>
  </div>

<div class="page">
  <div class="capital-strip">
    <div class="cap-cell"><div class="cap-label">Starting Capital</div><div class="cap-val">₹${startCap.toLocaleString("en-IN")}</div></div>
    <div class="cap-cell"><div class="cap-label">Current Capital</div><div class="cap-val" style="color:${capital >= startCap ? "#7ab850" : "#f87171"};">₹${capital.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div></div>
    <div class="cap-cell"><div class="cap-label">All-Time PnL</div><div class="cap-val" style="color:${(data.totalPnl || 0) >= 0 ? "#7ab850" : "#f87171"};">${(data.totalPnl || 0) >= 0 ? "+" : ""}₹${(data.totalPnl || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div></div>
    <div class="cap-cell" style="font-size:0.62rem;color:#7f9b5c;line-height:1.5;display:flex;align-items:center;">Capital updates when sessions complete</div>
  </div>

  <!-- Signal light + what the engine sees -->
  <div style="background:#090f09;border:0.5px solid #162416;border-radius:12px;padding:16px 18px;margin-bottom:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <span id="iz-light" class="sig-light" style="color:${LIGHT_CLR[light.color]};background:${LIGHT_CLR[light.color]}22;border:1px solid ${LIGHT_CLR[light.color]}66;">● ${light.text}</span>
      <span id="iz-trend" style="font-size:0.78rem;color:#c0d8b0;font-family:'IBM Plex Mono',monospace;">Trend: ${s.trend || "—"}</span>
    </div>
    <div class="stat-grid" style="margin:14px 0 0;">
      <div class="sc"><div class="sc-label">NIFTY Spot</div><div class="sc-val" id="iz-spot">${state.lastTickPrice ? inrS(state.lastTickPrice) : "—"}</div></div>
      <div class="sc" style="border-top:1.5px solid #8a2020;"><div class="sc-label">Range High</div><div class="sc-val" id="iz-orh" style="color:#ef4444;">${s.orHigh != null ? inrS(s.orHigh) : "—"}</div><div class="sc-sub">${strat._fmtMins(cfg.sessionStartMin)}–${strat._fmtMins(cfg.orEndMin)}</div></div>
      <div class="sc" style="border-top:1.5px solid #5a9030;"><div class="sc-label">Range Low</div><div class="sc-val" id="iz-orl" style="color:#10b981;">${s.orLow != null ? inrS(s.orLow) : "—"}</div><div class="sc-sub">${strat._fmtMins(cfg.sessionStartMin)}–${strat._fmtMins(cfg.orEndMin)}</div></div>
      <div class="sc" style="border-top:1.5px solid #6a5090;"><div class="sc-label">VWAP</div><div class="sc-val" id="iz-vwap" style="color:#a78bfa;">${s.vwap != null ? inrS(s.vwap) : "—"}</div></div>
      <div class="sc" style="border-top:1.5px solid #2a6080;"><div class="sc-label">EMA${cfg.emaPeriod}</div><div class="sc-val" id="iz-ema" style="color:#38bdf8;">${s.ema != null ? inrS(s.ema) : "—"}</div><div class="sc-sub" id="iz-ema-dir">${s.ema != null && s.emaPrev != null ? (s.ema > s.emaPrev ? "▲ rising" : s.ema < s.emaPrev ? "▼ falling" : "= flat") : ""}</div></div>
      <div class="sc" style="border-top:1.5px solid #a07010;"><div class="sc-label">Breakout</div><div class="sc-val" id="iz-bo" style="font-size:0.78rem;">${_breakoutStatus(s)}</div></div>
      <div class="sc" style="border-top:1.5px solid #a07010;"><div class="sc-label">Retest</div><div class="sc-val" id="iz-rt" style="font-size:0.78rem;">${_retestStatus(s)}</div></div>
      <div class="sc"><div class="sc-label">Selected ITM Strike</div><div class="sc-val" id="iz-strike" style="font-size:0.9rem;">${pos ? `${pos.optionStrike} ${pos.side}` : "—"}</div></div>
    </div>
    <div id="iz-skip" style="font-size:0.72rem;color:#7f9b5c;margin-top:10px;">${s.signal === "NONE" ? (s.skipReason || "") : ""}</div>
    ${state.dayClosed ? `<div style="font-size:0.74rem;color:#f59e0b;margin-top:8px;">⏸️ ${state.dayClosedReason}</div>` : ""}
    <ul class="rule-list">
      <li><b>CE:</b> 5-min close above the range high, close &gt; VWAP, EMA${cfg.emaPeriod} &gt; VWAP and rising → retest within ${cfg.retestCandles} candles (low within ${cfg.retestTolPts}pt), no close back inside → green candle closing above the previous high. <b>PE</b> is the mirror.</li>
      <li><b>Exits:</b> premium +${cfg.targetPts} / −${cfg.slPts}, whole position · square-off ${strat._fmtMins(cfg.squareOffMin)}. <b>Day:</b> entries till ${strat._fmtMins(cfg.entryEndMin)}, max ${cfg.maxTrades} trades, stop after a win / 2 losses / −${cfg.dailyLossPts} pts.</li>
    </ul>
  </div>

  <div class="stat-grid">
    <div class="sc" style="border-top:2px solid ${pnlColor(state.sessionPnl)};"><div class="sc-label">Session PnL</div><div class="sc-val" id="iz-session-pnl" style="color:${pnlColor(state.sessionPnl)};">${inrS(state.sessionPnl)}</div></div>
    <div class="sc" style="border-top:1.5px solid #6a5090;"><div class="sc-label">Trades Today</div><div class="sc-val" id="iz-trades">${gate.trades} / ${cfg.maxTrades}</div><div class="sc-sub" id="iz-wl">${wins}W · ${losses}L</div></div>
    <div class="sc" style="border-top:1.5px solid #a07010;"><div class="sc-label">Day Points</div><div class="sc-val" id="iz-daypts" style="color:${pnlColor(gate.dayPts)};">${gate.dayPts >= 0 ? "+" : ""}${gate.dayPts}</div><div class="sc-sub">cap −${cfg.dailyLossPts}</div></div>
    <div class="sc" style="border-top:1.5px solid #8a2020;"><div class="sc-label">Daily Risk</div><div class="sc-val" id="iz-risk" style="font-size:0.78rem;">${state.dayClosed ? (state.dayClosedReason || "Closed") : gate.status === "ONE_LOSS" ? "One loss — one more setup allowed" : "OK"}</div></div>
    <div class="sc" style="border-top:1.5px solid #a07010;"><div class="sc-label">Candles Loaded</div><div class="sc-val" id="iz-candles">${state.candles.length}</div></div>
    <div class="sc" style="border-top:1.5px solid #2a6080;"><div class="sc-label">WebSocket Ticks</div><div class="sc-val" id="iz-ticks">${state.tickCount.toLocaleString()}</div></div>
    <div class="sc" style="border-top:1.5px solid #2a4020;"><div class="sc-label">Week PnL</div><div class="sc-val" style="color:${pnlColor(weeklyPnl())};">${inrS(weeklyPnl())}</div></div>
  </div>

  <div id="iz-position" style="margin-bottom:20px;">${_positionCardHtml(pos, state.optionLtp)}</div>

  <div style="margin-bottom:24px;">
    <div class="section-title">Current 5-Min Bar (forming)</div>
    <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);">
      ${["open", "high", "low", "close"].map(k => `<div class="sc"><div class="sc-label">${k.toUpperCase()}</div><div class="sc-val" id="iz-bar-${k}" style="font-size:1rem;">${state.formingBar ? inrS(state.formingBar[k]) : "—"}</div></div>`).join("")}
    </div>
  </div>

  ${process.env.CHART_ENABLED !== "false" ? `
  <div style="margin-bottom:24px;">
    <div class="section-title">NIFTY 5-Min Chart — yesterday + today</div>
    <div style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:420px;">
      <div id="nifty-chart" style="width:100%;height:100%;"></div>
      <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;display:flex;gap:10px;flex-wrap:wrap;max-width:calc(100% - 90px);">
        <span style="color:#f59e0b;">┄ Range H/L</span><span style="color:#a78bfa;">── VWAP</span><span style="color:#38bdf8;">── EMA${cfg.emaPeriod}</span><span style="color:#f59e0b;">■ BO</span><span style="color:#38bdf8;">■ RT</span>
      </div>
    </div>
  </div>` : ""}

  ${optionChart.optionChartHtml('iz-opt-chart')}

  <div style="margin-bottom:24px;">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
      <div class="section-title" style="margin-bottom:0;flex:1;">Session Trades</div>
      <select id="ptSide" class="flt" onchange="ptRender()"><option value="">All sides</option><option>CE</option><option>PE</option></select>
      <select id="ptResult" class="flt" onchange="ptRender()"><option value="">All results</option><option value="win">Wins</option><option value="loss">Losses</option></select>
    </div>
    <div class="tbl-wrap">
      <table class="pt">
        <thead><tr><th>#</th><th>Side</th><th>Strike</th><th>Entry</th><th>Exit</th><th>Entry ₹</th><th>Exit ₹</th><th>Points</th><th>Net P&amp;L</th><th>Exit reason</th></tr></thead>
        <tbody id="ptBody"></tbody>
      </table>
    </div>
  </div>

  <div style="margin-bottom:24px;">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
      <div class="section-title" style="margin-bottom:0;flex:1;">Activity Log</div>
      <input id="logSearch" class="flt" placeholder="Search log…" oninput="logRender()"/>
    </div>
    <div id="logBox" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:12px 16px;max-height:360px;overflow-y:auto;"></div>
  </div>
</div>
</div>
</div>
<script id="log-data" type="application/json">${logsJSON}</script>
<script id="trade-data" type="application/json">${tradesJSON}</script>
<script>
${modalJS()}
var LIGHT_CLR = { GREEN: '#10b981', RED: '#ef4444', GREY: '#94a3b8' };
var _logs = JSON.parse(document.getElementById('log-data').textContent || '[]');
var _trades = JSON.parse(document.getElementById('trade-data').textContent || '[]');
var _hadPos = ${pos ? "true" : "false"}, _running = ${state.running ? "true" : "false"};
function _esc(x){ return String(x == null ? '' : x).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function _inr(n){ return typeof n === 'number' ? '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
function _set(id, txt, color){ var el = document.getElementById(id); if (!el) return; el.textContent = txt; if (color) el.style.color = color; }
function izStart(btn){ if (btn) { btn.textContent = '⏳ Starting...'; btn.disabled = true; } location.href = '/itm20-scalp-paper/start'; }
function izStop(btn){ if (!confirm('Stop ITM20 Scalp paper trading? An open position is closed at the current premium.')) return; if (btn) btn.disabled = true; location.href = '/itm20-scalp-paper/stop'; }
function izExit(btn){ if (!confirm('Exit the open ITM20 Scalp trade now?')) return; if (btn) btn.disabled = true; location.href = '/itm20-scalp-paper/exit'; }
async function izReset(btn){
  if (!confirm('Reset ITM20 Scalp paper history and capital?')) return;
  try { var r = await fetch('/itm20-scalp-paper/reset'); var d = await r.json(); alert(d.success ? d.message : ('❌ ' + d.error)); if (d.success) location.reload(); } catch (e) { alert('Reset failed'); }
}
function ptRender(){
  var side = document.getElementById('ptSide').value, res = document.getElementById('ptResult').value;
  var rows = _trades.map(function(t, i){ return { t: t, i: i + 1 }; }).filter(function(x){
    if (side && x.t.side !== side) return false;
    if (res === 'win' && !(x.t.pnl > 0)) return false;
    if (res === 'loss' && !(x.t.pnl < 0)) return false;
    return true;
  }).reverse();
  var body = document.getElementById('ptBody');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#7f9b5c;padding:16px;">No trades yet</td></tr>'; return; }
  body.innerHTML = rows.map(function(x){
    var t = x.t, c = (t.pnl || 0) >= 0 ? '#10b981' : '#ef4444';
    return '<tr><td>' + x.i + '</td><td style="color:' + (t.side === 'CE' ? '#10b981' : '#ef4444') + ';font-weight:700;">' + _esc(t.side) + '</td><td>' + _esc(t.optionStrike) + '</td><td>' + _esc(t.entryTime) + '</td><td>' + _esc(t.exitTime) + '</td><td>' + _inr(t.optionEntryLtp) + '</td><td>' + _inr(t.optionExitLtp) + '</td><td style="color:' + c + ';">' + ((t.points || 0) >= 0 ? '+' : '') + _esc(t.points) + '</td><td style="color:' + c + ';font-weight:700;">' + _inr(t.pnl) + '</td><td style="white-space:normal;min-width:180px;">' + _esc(t.exitReason) + '</td></tr>';
  }).join('');
}
function logRender(){
  var q = (document.getElementById('logSearch').value || '').toLowerCase();
  var list = _logs.filter(function(l){ return !q || l.toLowerCase().indexOf(q) >= 0; }).slice(0, 300);
  document.getElementById('logBox').innerHTML = list.length ? list.map(function(l){ return '<div>' + _esc(l) + '</div>'; }).join('') : '<div style="color:#7f9b5c;">No log lines yet</div>';
}
async function izRefresh(){
  try {
    var r = await fetch('/itm20-scalp-paper/status/data', { cache: 'no-store' });
    var d = await r.json();
    if (!!d.position !== _hadPos || d.running !== _running) { location.reload(); return; }
    var light = document.getElementById('iz-light');
    if (light) { var c = LIGHT_CLR[d.signalColor] || '#94a3b8'; light.textContent = '● ' + d.signal; light.style.color = c; light.style.background = c + '22'; light.style.borderColor = c + '66'; }
    _set('iz-trend', 'Trend: ' + (d.trend || '—'));
    _set('iz-spot', d.lastTickPrice != null ? _inr(d.lastTickPrice) : '—');
    _set('iz-orh', d.orHigh != null ? _inr(d.orHigh) : '—');
    _set('iz-orl', d.orLow != null ? _inr(d.orLow) : '—');
    _set('iz-vwap', d.vwap != null ? _inr(d.vwap) : '—');
    _set('iz-ema', d.ema != null ? _inr(d.ema) : '—');
    _set('iz-ema-dir', d.ema != null && d.emaPrev != null ? (d.ema > d.emaPrev ? '▲ rising' : d.ema < d.emaPrev ? '▼ falling' : '= flat') : '');
    _set('iz-bo', d.breakoutStatus); _set('iz-rt', d.retestStatus);
    _set('iz-strike', d.position ? (d.position.optionStrike + ' ' + d.position.side) : ((d.itmStrikeCE != null ? d.itmStrikeCE + ' CE' : '—') + ' · ' + (d.itmStrikePE != null ? d.itmStrikePE + ' PE' : '—')));
    _set('iz-skip', d.lastSkipReason || '');
    _set('iz-session-pnl', _inr(d.sessionPnl), (d.sessionPnl || 0) >= 0 ? '#10b981' : '#ef4444');
    _set('iz-trades', d.todayTrades + ' / ' + d.maxDailyTrades); _set('iz-wl', d.wins + 'W · ' + d.losses + 'L');
    _set('iz-daypts', (d.dayPts >= 0 ? '+' : '') + d.dayPts, d.dayPts >= 0 ? '#10b981' : '#ef4444');
    _set('iz-risk', d.riskStatus + (d.expiryDay ? ' · expiry day' : ''));
    _set('iz-candles', String(d.candles)); _set('iz-ticks', (d.tickCount || 0).toLocaleString());
    if (d.currentBar) ['open','high','low','close'].forEach(function(k){ _set('iz-bar-' + k, _inr(d.currentBar[k])); });
    var p = d.position;
    if (p && p.currentOptLtp != null) {
      var mv = p.currentOptLtp - p.optionEntryLtp, col = mv >= 0 ? '#10b981' : '#ef4444';
      _set('iz-opt-cur', _inr(p.currentOptLtp), col);
      _set('iz-opt-move', (mv >= 0 ? '▲ +' : '▼ ') + Math.abs(mv).toFixed(2) + ' pts', col);
      _set('iz-opt-pnl', (d.livePnl >= 0 ? '+' : '') + _inr(d.livePnl), col);
      _set('iz-to-target', (p.targetPrem - p.currentOptLtp).toFixed(2) + ' pts to go');
      _set('iz-to-stop', (p.currentOptLtp - p.stopPrem).toFixed(2) + ' pts away');
    }
    if (Array.isArray(d.log)) { _logs = d.log.slice().reverse(); logRender(); }
  } catch (e) {}
}
ptRender(); logRender();
setInterval(izRefresh, 3000);
</script>
<script>
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var container = document.getElementById('nifty-chart');
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
  var vw = chart.addLineSeries({ color:'#a78bfa', lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  var em = chart.addLineSeries({ color:'#38bdf8', lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  var lines = [], _zoomed = false, _lastN = -1, _lastT = null;
  function addLine(price, color, title, style) {
    if (price == null || !isFinite(price)) return;
    lines.push(cs.createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title }));
  }
  async function fetchChart(){
    try {
      var r = await fetch('/itm20-scalp-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      var c = d.candles || [];
      if (c.length) {
        var lt = c[c.length-1].time;
        if (c.length !== _lastN || lt !== _lastT) { cs.setData(c); vw.setData(d.vwap || []); em.setData(d.ema || []); _lastN = c.length; _lastT = lt; }
        if (!_zoomed) { try { chart.timeScale().setVisibleRange({ from: c[Math.max(0, c.length-110)].time, to: lt }); _zoomed = true; } catch(_){} }
      }
      cs.setMarkers((d.markers || []).slice().sort(function(a,b){return a.time-b.time;}));
      lines.forEach(function(l){ try { cs.removePriceLine(l); } catch(_){} });
      lines = [];
      addLine(d.orHigh, '#f59e0b', 'Range H', LightweightCharts.LineStyle.Dashed);
      addLine(d.orLow,  '#f59e0b', 'Range L', LightweightCharts.LineStyle.Dashed);
      addLine(d.entryPrice, '#94a3b8', 'Entry', LightweightCharts.LineStyle.Dotted);
    } catch(e) {}
  }
  fetchChart();
  setInterval(fetchChart, 5000);
  window.addEventListener('resize', function(){ chart.applyOptions({ width: container.clientWidth }); });
})();
</script>
${optionChart.optionChartScript({ dataUrl: '/itm20-scalp-paper/status/chart-data', id: 'iz-opt-chart' })}
</body></html>`;
  res.send(html);
});

/** Open-position card — same layout as the EMA_RSI_ST paper page. */
function _positionCardHtml(pos, optLtp) {
  if (!pos) {
    const s = state.lastSignal || {};
    return `<div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:1.5rem;margin-bottom:8px;">📭</div>
      <div style="font-size:0.9rem;font-weight:600;color:#8ba1c2;">FLAT — ${state.dayClosed ? "done for the day" : (s.phase === "up" || s.phase === "down") ? `${s.breakoutSide} setup armed — waiting for retest + confirmation` : "waiting for a breakout"}</div>
    </div>`;
  }
  const inrS = (n) => typeof n === "number" ? `₹${n.toFixed(2)}` : "—";
  const cur = typeof optLtp === "number" ? optLtp : null;
  const mv = cur != null ? cur - pos.optionEntryLtp : null;
  const col = mv == null ? "#c8d8f0" : mv >= 0 ? "#10b981" : "#ef4444";
  const livePnl = cur != null ? (cur - pos.optionEntryLtp) * pos.qty : null;
  const sideClr = pos.side === "CE" ? "#10b981" : "#ef4444";
  const box = (label, id, val, sub, color, border) => `
    <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid ${border || "#1e3a5f"};border-radius:10px;">
      <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">${label}</div>
      <div id="${id}" style="font-size:1.6rem;font-weight:800;color:${color};font-family:monospace;line-height:1;">${val}</div>
      ${sub ? `<div ${sub.id ? `id="${sub.id}"` : ""} style="font-size:0.68rem;color:var(--muted-1,#8ba1c2);margin-top:6px;">${sub.text}</div>` : ""}
    </div>`;
  return `<div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 1.5s infinite;"></span>
        <span style="font-size:0.8rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;">Open Position</span>
        <span style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);">Since ${pos.entryTime}</span>
      </div>
      <button onclick="izExit(this)" style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;min-height:44px;border-radius:8px;cursor:pointer;font-family:inherit;">🚪 Exit Trade Now</button>
    </div>
    <div style="background:#071a12;border:1px solid #134e35;border-radius:10px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:2.2rem;font-weight:900;color:${sideClr};">${pos.side}</span>
        <div><div style="font-size:0.72rem;color:${sideClr};">${pos.side === "CE" ? "CALL · Bullish" : "PUT · Bearish"}</div>
        <span style="font-size:0.65rem;font-weight:700;background:#10b98122;color:#10b981;border:1px solid #10b98144;padding:2px 7px;border-radius:4px;">1 ITM</span></div>
      </div>
      <div><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Strike</div><div style="font-size:1.6rem;font-weight:800;color:#fff;font-family:monospace;">${pos.optionStrike != null ? Number(pos.optionStrike).toLocaleString("en-IN") : "—"}</div></div>
      <div><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Expiry</div><div style="font-size:1.1rem;font-weight:700;color:#f59e0b;">${pos.optionExpiryDate || pos.optionExpiry || "—"}</div></div>
      <div><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Qty</div><div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty}</div></div>
      <div style="flex:1;min-width:180px;"><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Full Symbol</div><div style="font-size:0.82rem;font-weight:600;color:#c8d8f0;font-family:monospace;word-break:break-all;">${pos.symbol}</div></div>
    </div>
    <div style="background:#0a0f24;border:2px solid #3b82f6;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
      <div style="font-size:0.68rem;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">📊 Option Premium (${pos.side} price)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;">
        ${box("Entry Price", "iz-opt-entry", inrS(pos.optionEntryLtp), { text: `spot ${pos.entrySpot}` }, "#60a5fa")}
        ${box("Current LTP", "iz-opt-cur", cur != null ? inrS(cur) : "⏳", { id: "iz-opt-move", text: mv != null ? `${mv >= 0 ? "▲ +" : "▼ "}${Math.abs(mv).toFixed(2)} pts` : "polling…" }, col, col)}
        ${box("Target", "iz-opt-target", inrS(pos.targetPrem), { id: "iz-to-target", text: cur != null ? `${(pos.targetPrem - cur).toFixed(2)} pts to go` : "" }, "#10b981", "#065f46")}
        ${box("Stop-loss", "iz-opt-stop", inrS(pos.stopPrem), { id: "iz-to-stop", text: cur != null ? `${(cur - pos.stopPrem).toFixed(2)} pts away${pos.stopKind === "DAILY_LOSS" ? " · day cap" : ""}` : (pos.stopKind === "DAILY_LOSS" ? "day cap" : "") }, "#ef4444", "#7f1d1d")}
        ${box("Running P&L", "iz-opt-pnl", livePnl != null ? `${livePnl >= 0 ? "+" : ""}₹${livePnl.toFixed(2)}` : "—", { text: `${pos.qty} qty · before charges` }, col)}
      </div>
    </div>
    ${pos.entryReason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;">📝 ${pos.entryReason}</div>` : ""}
  </div>`;
}

// ── History + daily-file viewers + restore + reset ────────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  res.send(renderHistoryPage({
    routePrefix: "/itm20-scalp-paper",
    sidebarKey: "itm20ScalpHistory",
    pageTitle: "🎯 ITM20 Scalp Paper Trade History",
    pageDocTitle: "ITM20 Scalp Paper — History",
    modalLabel: "ITM20 Scalp Paper",
    liveActive: false,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap: parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000"),
    emptyLabel: "Start ITM20 Scalp paper trading to record your first session.",
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
  res.setHeader("Content-Disposition", `attachment; filename="itm20_scalp_paper_skips_all_${today}.txt"`);
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
    res.download(p, `itm20_scalp_paper_${kind}_${date}.txt`);
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
  if (state.running) return res.status(400).json({ success: false, error: "Stop ITM20 Scalp paper trading first before deleting a session." });
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
  if (state.running) return res.status(400).json({ success: false, error: "Stop ITM20 Scalp paper trading before restoring." });
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
  if (date === tradeLogger.istDateString(Date.now())) state._unsaved = false;
  capitalPool.sessionSaved(MODE_KEY);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop ITM20 Scalp paper trading before resetting." });
  const fresh = parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000");
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  require("../utils/paperReset").clearTodayFiles(MODE_KEY);
  state._unsaved = false;
  capitalPool.sessionSaved(MODE_KEY);
  return res.json({ success: true, message: `ITM20 Scalp paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
});

router.get("/download/trades.jsonl", (req, res) => {
  try {
    const data = loadData();
    const records = [];
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) records.push(Object.assign({ date: s.date, mode: MODE_KEY, strategy: s.strategy }, t));
    const today = new Date().toISOString().slice(0, 10);
    const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
    if (ai) {
      const md = aiExport.buildMarkdown(records, { title: "ITM20 Scalp paper trades (full log)", source: "itm20-scalp-paper" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="itm20_scalp_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="itm20_scalp_paper_trades_${today}.jsonl"`);
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
module.exports.attributeQuotes = attributeQuotes;
module.exports._test = {
  getState: () => state,
  setState: (s) => { state = s; },
  freshState: _freshState,
  checkExits: _checkExits,
  checkSquareOff: _checkSquareOff,
  onCandleClose,
  mergeBars: _mergeBars,
  evaluateEntry,
  simulateSell,
};

/**
 * RSI_PIVOT_ST PAPER — /rsi-pivot-st-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL surface. Every decision / fill / exit semantic for RSI_PIVOT_ST
 * lives here; the backtest and the live harness must match THIS, never the
 * reverse (see feedback_paper_logic_untouchable).
 *
 * The day in one paragraph: before the open, yesterday's daily high/low/close
 * fix today's Standard Pivot levels — R1 above, S1 below. They never move. The
 * engine then watches closed 5-minute NIFTY candles. When one CROSSES AND
 * CLOSES above R1 while RSI(14) is above 70, it buys a CE. When one crosses and
 * closes below S1 while RSI is below 40, it buys a PE. The strike is 1% of spot
 * away from the money (ATM/ITM/OTM chosen in Settings).
 *
 * The two sides are stopped DIFFERENTLY, by rule:
 *   • CE — TWO stops, both live, first to trigger wins:
 *       SuperTrend(10,2) on the 5-min spot chart, trailed (it only ratchets up)
 *       AND a premium floor at 25% below the trade's high-water premium.
 *   • PE — ONE stop: the 25% premium floor only. No SuperTrend.
 *     This asymmetry is the user's stated rule. Do not "balance" it.
 *
 * ONE INSTRUMENT: NIFTY 50 INDEX. Closed 5-min bars come from the Fyers HISTORY
 * endpoint (the same one the backtest and replay read, which is what makes the
 * modes agree). Daily bars for the pivots come from the same endpoint, fetched
 * once at session start and frozen. The option LTP is polled for the premium
 * stop and for P&L.
 *
 * Exits, in the order they are tested on every poll:
 *   1. premium stop — 25% below the high-water premium (BOTH sides)
 *   2. SuperTrend   — CE only, trailed, re-read on each closed bar
 *   3. EOD square-off at RSI_PIVOT_ST_EXIT_TIME
 * There is deliberately NO profit target, NO breakeven jump, NO time stop and NO
 * partial booking. The trade runs until a stop trails into it or the day ends.
 *
 * Day-level breakers: RSI_PIVOT_ST_MAX_TRADES and RSI_PIVOT_ST_MAX_DAILY_LOSS.
 *
 * Signal engine: src/strategies/rsi_pivot_st.js (shared by paper, backtest, live
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

const rsiPivotStrategy   = require("../strategies/rsi_pivot_st");
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
const instrumentMode = require("../utils/instrumentMode");
const { getISTMinutes, getBucketStart } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");
const capitalPool = require("../utils/capitalPool");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "rsiPivotStPaper";
const MODE_KEY           = "rsi_pivot_st";     // tradeLogger / skipLogger key

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "rsi_pivot_st_paper_trades.json");

// ── Config readers (Settings mutates process.env live — never cache) ──────────
function _cfg() { return rsiPivotStrategy.getConfig(); }
/**
 * One-line description of the stops a given side actually carries, honouring
 * both the CE SuperTrend toggle and the premium-stop side toggle. Used by the
 * boot banner, /status and the harness so no screen can claim a stop the trade
 * does not have.
 */
function _sideStopText(side, cfg) {
  cfg = cfg || _cfg();
  const bits = [];
  if (rsiPivotStrategy.stApplies(side, cfg)) bits.push(`SuperTrend(${cfg.stPeriod},${cfg.stMultiplier})`);
  if (rsiPivotStrategy.premiumStopApplies(side, cfg)) bits.push(`${cfg.premiumStopPct}% premium floor`);
  return bits.length ? bits.join(" + ") : "NONE — EOD square-off only";
}
function _resMin() { return _cfg().resolutionMins; }
function _parseMins(envKey, fallback) {
  return rsiPivotStrategy._parseHHMM(process.env[envKey], rsiPivotStrategy._parseHHMM(fallback, 0));
}
function _envStr(key, fallback) { return String(process.env[key] || fallback); }
function _maxDailyTrades()  { return _cfg().maxDailyTrades; }
function _maxDailyLoss()    { return _cfg().maxDailyLoss; }
function _maxWeeklyLoss()   { return parseFloat(process.env.RSI_PIVOT_ST_MAX_WEEKLY_LOSS || "0"); }
function _pollMs() {
  const v = parseInt(process.env.RSI_PIVOT_ST_POLL_MS || "2000", 10);
  return Number.isFinite(v) && v >= 500 && v <= 30000 ? v : 2000;
}
/**
 * How long after a bar closes before the Fyers history endpoint is asked for it.
 * Fetching the instant the clock ticks over often returns the bar still one
 * short, which would silently delay every decision by a whole bar.
 */
function _historyLagMs() {
  const v = parseInt(process.env.RSI_PIVOT_ST_HISTORY_LAG_MS || "5000", 10);
  return Number.isFinite(v) && v >= 0 && v <= 60000 ? v : 5000;
}

/**
 * Position size. RSI_PIVOT_ST_LOT_MULTIPLIER (when > 0) overrides the global
 * LOT_MULTIPLIER for this strategy only, clamped by the same MAX_LOT_MULTIPLIER
 * ceiling. Divides by the multiplier getLotQty ACTUALLY applied (it clamps
 * internally), not the raw env value. Default 0 = use the common setting.
 */
function rsiPivotLotQty() {
  const base = instrumentConfig.getLotQty();
  const raw  = parseInt(process.env.RSI_PIVOT_ST_LOT_MULTIPLIER || "0", 10);
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
    const init = { capital: parseFloat(process.env.ZERODHA_INV_AMOUNT || process.env.FYERS_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(init, null, 2));
    _dataCache = init;
    return init;
  }
  try { _dataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error("[rsi-pivot-st-paper] rsi_pivot_st_paper_trades.json corrupt — resetting:", e.message);
    _dataCache = { capital: parseFloat(process.env.ZERODHA_INV_AMOUNT || process.env.FYERS_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
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
    // SPOT bars — the decision series. Closed bars only.
    candles:        [],
    lastClosedBarTime: null,
    formingBar:     null,   // display-only: built from the tick feed
    formingBarStart: null,
    tickCount:      0,
    lastTickTime:   null,
    lastTickPrice:  null,
    position:       null,
    optionLtp:      null,
    optionLtpUpdatedAt: null,
    log:            [],
    _sessionId:     null,
    // RSI_PIVOT_ST specific
    pivots:         null,   // FROZEN at session start — yesterday's R1/S1/PP
    lastSignal:     null,
    lastRsi:        null,
    lastSuperTrend: null,
    dayClosed:      false,
    dayClosedReason: null,
    _histInFlight:  false,
    _histBucket:    null,
    _histFailures:  0,
    _histNextTryMs: null,
    _entryInFlight: false,
    _lastEntryAttemptMs: null,
    _pendingEntry:  null,
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
    state.stopOuts = trades.filter(t => /stop|SuperTrend|premium floor/i.test(String(t.exitReason || ""))).length;
    state.sessionPnl = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    if (!state.sessionStart) state.sessionStart = trades[0].entryTime || trades[0].loggedAt || null;
    console.log(`♻️ [RSI_PIVOT_ST-PAPER] Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl}, ${state.stopOuts} stop-out(s))`);
  } catch (err) {
    console.warn(`[RSI_PIVOT_ST-PAPER] session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => state, "[RSI_PIVOT_ST-PAPER]");

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

// ── Option quote poll — the premium every exit is measured against ────────────
let _pollTimer = null;
let _pollStopped = true;

function startPolling() {
  stopPolling();
  _pollStopped = false;
  const poll = async () => {
    if (_pollStopped) return;
    try {
      // Futures need no premium poll — the traded price IS the index level, so
      // mirror the spot in and every downstream reader stays correct unchanged.
      if (state.position && state.position.isFutures) {
        if (state.lastTickPrice > 0) {
          state.optionLtp = state.lastTickPrice;
          state.optionLtpUpdatedAt = Date.now();
        }
      }
      const optSym = (state.position && !state.position.isFutures) ? state.position.symbol : null;
      if (optSym) {
        const r = await fyers.getQuotes([optSym]);
        if (r && r.s === "ok" && Array.isArray(r.d) && r.d.length) {
          const v = r.d[0].v || {};
          const ltp = v.lp || v.ltp;
          if (typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0) {
            state.optionLtp = ltp;
            state.optionLtpUpdatedAt = Date.now();
            try { tickRecorder.recordOptionLtp(optSym, ltp, "rsi-pivot-st-paper"); } catch (_) {}
          }
        }
      }
    } catch (_) {}

    // Exits first (a hit premium stop must not wait on a history round-trip),
    // then the bar-close work.
    try { if (state.position) _checkExits(); } catch (e) { console.error(`🚨 [RSI_PIVOT_ST-PAPER] exit-check error: ${e.message}`); }
    try { _enforceEod(); } catch (e) { console.error(`🚨 [RSI_PIVOT_ST-PAPER] eod error: ${e.message}`); }
    _maybeRefreshHistory().catch(e => console.error(`🚨 [RSI_PIVOT_ST-PAPER] history refresh error: ${e.message}`));
    if (!state.position && state._pendingEntry) {
      _retryPendingEntry().catch(e => console.error(`🚨 [RSI_PIVOT_ST-PAPER] entry-retry error: ${e.message}`));
    }

    if (!_pollStopped) _pollTimer = setTimeout(poll, _pollMs());
  };
  _pollTimer = setTimeout(poll, 250);
}

function stopPolling() {
  _pollStopped = true;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

// ── Spot history — the ONLY source of the closed bars decisions read ──────────
/**
 * Fetch today's closed spot bars once per bar, a short lag after the bar closes.
 * Everything the engine reads comes from here, which is precisely why Paper,
 * Backtest and Replay agree: they all read the same endpoint.
 */
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
    } else {
      // A genuinely empty window. Real failures — an expired token included —
      // arrive as a throw and are handled in the catch below, so reaching here
      // means Fyers answered "ok"/"no_data" with nothing in it.
      _noteHistoryFailure(null);
    }
  } catch (e) {
    _noteHistoryFailure(e && e.message);
  } finally {
    state._histInFlight = false;
  }
}

/**
 * Record a failed history fetch and back off. The poll runs every
 * RSI_PIVOT_ST_POLL_MS (2s by default) and the bucket guard only advances on
 * SUCCESS, so without a backoff a dead token would turn one bar into ~150
 * history calls. Backoff grows 5s per failure to a 60s ceiling, and never
 * exceeds one bar — so there is still at least one attempt per bar.
 */
function _noteHistoryFailure(why) {
  state._histFailures++;
  const backoffMs = Math.min(_resMin() * 60_000, 5000 * Math.min(state._histFailures, 12));
  state._histNextTryMs = Date.now() + backoffMs;
  if (state._histFailures === 3 || state._histFailures % 20 === 0) {
    log(`⚠️ [RSI_PIVOT_ST-PAPER] Spot history unavailable ${state._histFailures}× ${why ? `(${why}) ` : ""}Retrying in ${Math.round(backoffMs / 1000)}s.`);
  }
}

/** Today's spot bars at the strategy resolution. Uncached — today is live. */
async function _fetchSpotToday() {
  const { fetchCandles } = require("../services/backtestEngine");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return fetchCandles(NIFTY_INDEX_SYMBOL, String(_resMin()), today, today);
}

/**
 * Yesterday's DAILY bar, for the pivots. Asks for a two-week window so a long
 * weekend or a holiday run still returns a usable prior session; computePivots
 * then picks the newest bar strictly before today.
 */
async function _fetchPivots() {
  const { fetchCandles } = require("../services/backtestEngine");
  const now = new Date(Date.now() + 19800000);
  const to = new Date(now.getTime());
  const from = new Date(now.getTime() - 20 * 86400000);
  const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const daily = await fetchCandles(NIFTY_INDEX_SYMBOL, "D", fmt(from), fmt(to));
  if (!Array.isArray(daily) || !daily.length) return null;
  const todayKey = rsiPivotStrategy._istDayOf(Math.floor(Date.now() / 1000));
  return rsiPivotStrategy.computePivots(daily, { forDayKey: todayKey });
}

/**
 * Merge freshly fetched bars into state.candles and fire onCandleClose for each
 * genuinely NEW closed bar. Fyers history includes today's STILL-FORMING bar, so
 * any bar whose close time has not passed is dropped — feeding a partial bar to
 * the engine would let it decide off half a candle and then change its mind.
 */
function _mergeBars(bars) {
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

  _refreshIndicatorReadouts();

  if (!fresh.length) return;
  const newest = fresh[fresh.length - 1];
  state.lastClosedBarTime = newest.time;
  // A closed bar is also when the CE trail is re-read — SuperTrend is a
  // candle-close indicator, so trailing it per-tick would be inventing values.
  try { _trailSuperTrend(); }
  catch (e) { console.error(`🚨 [RSI_PIVOT_ST-PAPER] trail error: ${e.message}`); }
  // Fire ONCE, for the newest bar only. evaluateEntry always reads the LAST
  // element of state.candles, so replaying older bars would re-evaluate the same
  // series N times.
  try { onCandleClose(newest); }
  catch (e) { console.error(`🚨 [RSI_PIVOT_ST-PAPER] onCandleClose error: ${e.message}`); }
}

/** RSI + SuperTrend readouts for the UI. The engine computes its own for decisions. */
function _refreshIndicatorReadouts() {
  try {
    const cfg = _cfg();
    const rsi = rsiPivotStrategy.computeRsi(state.candles, cfg.rsiPeriod);
    state.lastRsi = rsi.values.length ? parseFloat(rsi.values[rsi.values.length - 1].toFixed(2)) : null;
    const st = rsiPivotStrategy.computeSuperTrendSeries(state.candles, cfg);
    state.lastSuperTrend = st.length ? st[st.length - 1] : null;
  } catch (_) {}
}

// ── Trade simulation ─────────────────────────────────────────────────────────
async function simulateBuy(side, sig) {
  const spot = state.lastTickPrice || sig.entrySpot;
  if (!side) return;
  if (typeof spot !== "number" || !(spot > 0)) {
    log(`⚠️ [RSI_PIVOT_ST-PAPER] No NIFTY price yet — cannot choose a strike, entry deferred`);
    return;
  }

  // The STRIKE comes from the engine's own rule (1% of spot, mode from
  // Settings) — NOT from instrument.js's ITM-steps branch, because this
  // strategy sizes its strike as a PERCENTAGE of spot rather than in steps.
  // The engine computed it off the signal close; recompute here against the
  // live spot so a strike is not chosen off a price minutes old.
  const strikeInfo = rsiPivotStrategy.strikeForSide(spot, side, _cfg());
  if (!strikeInfo) {
    log(`❌ [RSI_PIVOT_ST-PAPER] Strike not computable from spot ${spot} — entry skipped`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "strike_uncomputable", reason: `spot ${spot} unusable`, side, spot });
    return;
  }

  const _isFut = instrumentMode.isFutures();

  let optInfo;
  try {
    // strikeOverride keeps instrument.js's expiry/symbol builder while using
    // the strike this strategy chose. Futures have no strike to override.
    optInfo = _isFut
      ? await instrumentMode.resolveEntryInstrument(spot, side, "RSI_PIVOT_ST")
      : await instrumentConfig.validateAndGetOptionSymbol(spot, side, "RSI_PIVOT_ST", { strikeOverride: strikeInfo.strike });
  } catch (e) {
    log(`❌ [RSI_PIVOT_ST-PAPER] Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ [RSI_PIVOT_ST-PAPER] No valid ${_isFut ? "futures contract" : "expiry"} — skip ${side} entry`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "expiry", reason: _isFut ? "no valid futures contract" : "no valid option expiry", side, spot });
    return;
  }

  let optionEntryLtp = null;
  if (_isFut) {
    // Futures trade AT the index level — there is no premium to quote.
    optionEntryLtp = spot;
  } else {
    try {
      const r = await fyers.getQuotes([optInfo.symbol]);
      if (r && r.s === "ok" && r.d && r.d.length) {
        const v = r.d[0].v || {};
        const ltp = v.lp || v.ltp;
        if (typeof ltp === "number" && ltp > 0) {
          optionEntryLtp = ltp;
          try { tickRecorder.recordOptionLtp(optInfo.symbol, ltp, "rsi-pivot-st-paper"); } catch (_) {}
        }
      }
    } catch (e) {
      log(`⚠️ [RSI_PIVOT_ST-PAPER] Option LTP fetch failed: ${e.message} — entry blocked`);
      return;
    }
    if (!optionEntryLtp) {
      log(`❌ [RSI_PIVOT_ST-PAPER] Option LTP not available — entry skipped`);
      skipLogger.appendSkipLog(MODE_KEY, { gate: "option_ltp", reason: "no option LTP", symbol: optInfo.symbol, side, spot });
      return;
    }
  }

  const cfg = _cfg();
  // The PREMIUM floor is anchored to the ACTUAL fill, not to the signal — 25%
  // of a premium the trade never paid is not the rule. Which sides carry it is
  // the RSI_PIVOT_ST_PREMIUM_SL_SIDES toggle; a side left out gets a null floor
  // and is NOT aborted, because "no premium stop" is a valid configuration.
  // A futures position has no premium, so the premium floor is simply absent —
  // it must NOT abort the entry (that would silently disable the strategy).
  const premiumApplies = !_isFut && rsiPivotStrategy.premiumStopApplies(side, cfg);
  const premiumFloor = _isFut ? null : rsiPivotStrategy.premiumStop(optionEntryLtp, null, cfg, side);
  if (premiumApplies && !Number.isFinite(premiumFloor)) {
    log(`🚫 [RSI_PIVOT_ST-PAPER] Entry ABORTED — premium floor not computable from entry LTP ${optionEntryLtp}`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "levels_uncomputable", reason: `premium floor unusable from ltp ${optionEntryLtp}`, side, spot });
    return;
  }

  // The SPOT stop is CE-only. It came from the engine off closed bars; it is a
  // LEVEL and is not re-anchored to the fill.
  let slSpot = null;
  if (rsiPivotStrategy.stApplies(side, cfg)) {
    slSpot = sig.slSpot;
    if (!Number.isFinite(slSpot)) {
      log(`🚫 [RSI_PIVOT_ST-PAPER] Entry ABORTED — ${side} needs a SuperTrend stop and it is unusable (${slSpot})`);
      skipLogger.appendSkipLog(MODE_KEY, { gate: "levels_uncomputable", reason: `${side} SuperTrend stop ${slSpot} unusable`, side, spot });
      return;
    }
    if (rsiPivotStrategy.stopHit(side, spot, slSpot)) {
      log(`🚫 [RSI_PIVOT_ST-PAPER] Entry ABORTED — spot ${spot} is already through the SuperTrend stop ${slSpot}`);
      skipLogger.appendSkipLog(MODE_KEY, { gate: "fill_past_stop", reason: `spot ${spot} already beyond stop ${slSpot}`, side, spot });
      return;
    }
  }

  const qty = rsiPivotLotQty();
  const slPts = Number.isFinite(slSpot) ? parseFloat(Math.abs(slSpot - spot).toFixed(2)) : null;

  // Capital check — advisory only: an overdrawn pool raises a dashboard alert,
  // it never stops a paper trade. Sits AFTER the last abort path.
  const _cap = capitalPool.check(MODE_KEY, instrumentMode.capitalRequired(qty, optionEntryLtp));
  if (!_cap.ok) {
    log(`⚠️ [RSI_PIVOT_ST-PAPER] ${_cap.reason} — entry taken anyway, pool now overdrawn`);
    capitalPool.noteShortfall(MODE_KEY, _cap, { side, symbol: optInfo.symbol });
  }

  const pos = {
    isFutures:      _isFut,
    side,
    symbol:         optInfo.symbol,
    optionStrike:   optInfo.strike,
    optionExpiry:   optInfo.expiry,
    qty,
    entrySpot:      spot,
    entryPrice:     spot,
    optionEntryLtp,
    entryTime:      istNow(),
    entryTimeMs:    Date.now(),
    entryUnixSec:   Math.floor(Date.now() / 1000),
    entryBarTime:   Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    // Dual stops
    slSpot,                       // CE only — SuperTrend, trailed. null for PE.
    initialSlSpot:  slSpot,
    premiumFloor,                 // 25% below high-water premium; null when this side is excluded
    initialPremiumFloor: premiumFloor,
    premiumStopPct: cfg.premiumStopPct,
    premiumStopSides: cfg.premiumStopSides,
    premiumStopApplies: premiumApplies,
    slPts,
    riskPts:        slPts,
    // Signal context (kept on the trade record for analytics / reports)
    signalSpot:     sig.entrySpot,
    signalRsi:      sig.rsi,
    pivotPp:        sig.pp,
    pivotR1:        sig.r1,
    pivotS1:        sig.s1,
    pivotFrom:      sig.pivots ? sig.pivots.from : null,
    crossedLevel:   sig.crossedLevel,
    strikeMode:     strikeInfo.mode,
    strikeSteps:    strikeInfo.steps,
    strikeDistancePts: strikeInfo.distancePts,
    peakPremium:    optionEntryLtp,
    signalStrength: sig.signalStrength,
    mfeSpotPts:     0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
    entryReason:    sig.reason,
  };

  state.position = pos;
  capitalPool.block(MODE_KEY, instrumentMode.capitalRequired(qty, optionEntryLtp), { side, symbol: optInfo.symbol, qty, premium: optionEntryLtp });
  try { require("../utils/positionPersist").saveRsiPivotStPosition(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  state.optionLtp = optionEntryLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;

  log(`🟢 [RSI_PIVOT_ST-PAPER] BUY_${side} ${optInfo.symbol} qty=${qty} @ spot=${spot} optLtp=₹${optionEntryLtp}`);
  log(`   ├─ Trigger: RSI ${sig.rsi} · crossed ${side === "CE" ? "R1" : "S1"} ${sig.crossedLevel} (pivots from ${pos.pivotFrom})`);
  log(`   ├─ Strike: ${optInfo.strike} (${strikeInfo.mode}${strikeInfo.steps ? `, ${strikeInfo.distancePts}pt from spot` : ""})`);
  const _slBits = [];
  if (Number.isFinite(slSpot)) _slBits.push(`SuperTrend ${slSpot} (${slPts}pt)`);
  if (Number.isFinite(premiumFloor)) _slBits.push(`premium floor ₹${premiumFloor} (${cfg.premiumStopPct}% of ₹${optionEntryLtp})`);
  log(`   └─ SL: ${_slBits.length ? _slBits.join(" + ") : "NONE"} · EOD ${_envStr("RSI_PIVOT_ST_EXIT_TIME", "15:15")}`);
  if (rsiPivotStrategy.isStoplessSide(side, cfg)) {
    log(`⚠️ [RSI_PIVOT_ST-PAPER] THIS ${side} TRADE HAS NO STOP. The premium stop is OFF for ${side} ` +
        `(RSI_PIVOT_ST_PREMIUM_SL_SIDES=${cfg.premiumStopSides})${side === "PE" ? " and PE never carries a SuperTrend" : ""} — ` +
        `the ONLY exit is the ${_envStr("RSI_PIVOT_ST_EXIT_TIME", "15:15")} square-off. The full premium is at risk.`);
  }

  notifyEntry({
    mode: "RSI_PIVOT_ST-PAPER",
    side, symbol: optInfo.symbol,
    spotAtEntry: spot, optionEntryLtp,
    qty, stopLoss: slSpot, target: null,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "rsi-pivot-st-paper",
      sessionId: state._sessionId,
      ts: Date.now(),
      side, symbol: optInfo.symbol, qty,
      spotEntry: spot, optionEntry: optionEntryLtp,
      stopLoss: slSpot, target: null,
      reason: pos.entryReason,
    });
  } catch (_) {}
}

function simulateSell(reason, opts) {
  if (!state.position) return;
  const o = opts || {};
  const pos = state.position;
  const exitOptLtp = state.optionLtp || pos.optionEntryLtp;
  const exitSpot   = state.lastTickPrice || pos.entrySpot;
  const qty        = pos.qty;
  const _pnlRes    = instrumentMode.computePnl({
    side: pos.side, entrySpot: pos.entrySpot, exitSpot,
    entryPremium: pos.optionEntryLtp, exitPremium: exitOptLtp,
    qty, broker: "zerodha",
  });
  const charges    = _pnlRes.charges;
  const pnl        = _pnlRes.pnl;

  state.sessionPnl = parseFloat((state.sessionPnl + pnl).toFixed(2));
  if (pnl < 0) state.consecutiveLosses++; else if (pnl > 0) state.consecutiveLosses = 0;
  // Only a REAL stop-out burns one of the day's allowed losses. isStopOut is set
  // by the caller, never inferred from the sign of the P&L.
  if (o.isStopOut) state.stopOuts++;

  const trade = {
    side:           pos.side,
    symbol:         pos.symbol,
    qty,
    entryPrice:     pos.entrySpot,
    exitPrice:      exitSpot,
    spotAtEntry:    pos.entrySpot,
    spotAtExit:     exitSpot,
    optionEntryLtp: pos.isFutures ? null : pos.optionEntryLtp,
    optionExitLtp:  pos.isFutures ? null : exitOptLtp,
    bestOptionLtp:  pos.isFutures ? null : (pos.peakPremium || null),
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    entryBarTime:   pos.entryBarTime,
    exitBarTime:    Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    pnl,
    pnlMode:        `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp}`,
    exitReason:     reason,
    entryReason:    pos.entryReason,
    stopLoss:       pos.slSpot,
    initialStopLoss: pos.initialSlSpot,
    premiumFloor:   pos.premiumFloor,
    initialPremiumFloor: pos.initialPremiumFloor,
    target:         null,
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    optionType:     pos.side,
    optionEntrySymbol: pos.symbol,
    signalStrength: pos.signalStrength,
    riskPts:        pos.riskPts,
    // RSI_PIVOT_ST signal context
    signalRsi:      pos.signalRsi,
    pivotPp:        pos.pivotPp,
    pivotR1:        pos.pivotR1,
    pivotS1:        pos.pivotS1,
    pivotFrom:      pos.pivotFrom,
    crossedLevel:   pos.crossedLevel,
    strikeMode:     pos.strikeMode,
    strikeSteps:    pos.strikeSteps,
    strikeDistancePts: pos.strikeDistancePts,
    mfeSpotPts:     pos.mfeSpotPts || 0,
    mfePnl:         pos.mfePnl || 0,
    maeSpotPts:     pos.maeSpotPts || 0,
    maePnl:         pos.maePnl || 0,
    secsToMFE:      pos.secsToMFE || 0,
    secsToMAE:      pos.secsToMAE || 0,
    durationMs:     Date.now() - pos.entryTimeMs,
    charges,
    isFutures:      !!pos.isFutures,
    instrument:     pos.isFutures ? "NIFTY_FUTURES" : "NIFTY_OPTIONS",
  };
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog(MODE_KEY, trade);

  log(`🔴 [RSI_PIVOT_ST-PAPER] EXIT ${pos.side} ${pos.symbol} @ ${pos.isFutures ? "" : `optLtp=₹${exitOptLtp} `}spot=${exitSpot} | PnL=₹${pnl} (${reason})`);

  notifyExit({
    mode: "RSI_PIVOT_ST-PAPER",
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
      mode: "rsi-pivot-st-paper", sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitOptLtp, pnl, reason,
    });
  } catch (_) {}

  state.position = null;
  capitalPool.release(MODE_KEY, pnl);
  try { require("../utils/positionPersist").clearRsiPivotStPosition(); } catch (_) {}
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;

  _applyDayBreakers();
}

/** Day-level breakers, evaluated after every exit. Each one CLOSES the day. */
function _applyDayBreakers() {
  if (state.dayClosed) return;
  const maxLoss = _maxDailyLoss();

  if (maxLoss > 0 && state.sessionPnl <= -maxLoss) {
    _closeDay(`Daily loss cap hit (₹${state.sessionPnl} ≤ -₹${maxLoss})`);
    return;
  }
  if (state.tradesTaken >= _maxDailyTrades()) {
    _closeDay(`Daily trade budget spent (${state.tradesTaken}/${_maxDailyTrades()})`);
  }
}

function _closeDay(reason) {
  state.dayClosed = true;
  state.dayClosedReason = reason;
  log(`⏸️ [RSI_PIVOT_ST-PAPER] ${reason} — no more entries today`);
  skipLogger.appendSkipLog(MODE_KEY, { gate: "day_closed", reason, sessionPnl: state.sessionPnl, spot: state.lastTickPrice });
}

// ── The CE trail — SuperTrend, re-read on each CLOSED bar ────────────────────
/**
 * Ratchet the CE stop up to the current SuperTrend line. Runs on candle close
 * only: SuperTrend is a candle-close indicator, and trailing it per tick would
 * be quoting a value that does not exist yet.
 *
 * A trend FLIP (the line crossing above price) is itself the exit — the CE's
 * whole premise is gone at that point, so the trade is closed rather than left
 * to a stop that can no longer be reached from below.
 */
function _trailSuperTrend() {
  const pos = state.position;
  if (!pos) return;
  const cfg = _cfg();
  if (!rsiPivotStrategy.stApplies(pos.side, cfg)) return;

  const isCE = pos.side === "CE";
  const series = rsiPivotStrategy.computeSuperTrendSeries(state.candles, cfg);
  const st = rsiPivotStrategy.superTrendStop(pos.side, series, pos.slSpot, cfg);
  if (!st) return;

  if (st.flipped) {
    simulateSell(`SuperTrend flipped ${isCE ? "bearish" : "bullish"} — the ${pos.side}'s trend premise is gone (spot ${state.lastTickPrice})`, { isStopOut: true });
    return;
  }
  // The stop only ever TIGHTENS: up for a CE, down for a PE.
  const tighter = Number.isFinite(st.stop) &&
    (!Number.isFinite(pos.slSpot) || (isCE ? st.stop > pos.slSpot : st.stop < pos.slSpot));
  if (tighter) {
    const prev = pos.slSpot;
    pos.slSpot = st.stop;
    log(`🔒 [RSI_PIVOT_ST-PAPER] ${pos.side} SuperTrend trail ${prev} → ${st.stop}`);
    try { require("../utils/positionPersist").saveRsiPivotStPosition(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  }
}

// ── Exits ────────────────────────────────────────────────────────────────────
/**
 * Tested on every poll. Priority: premium floor → SuperTrend (CE only) → EOD.
 *
 * The premium floor is tested FIRST because it is the only stop BOTH sides
 * carry, and because a premium that has collapsed is a fact about the position
 * itself rather than an inference from spot.
 *
 * Every level is guarded with Number.isFinite before it is compared:
 * `ltp <= null` is `ltp <= 0`, which would square the trade off on its first poll.
 */
function _checkExits() {
  if (!state.position) return;
  const pos = state.position;
  if (pos.isFutures && state.lastTickPrice > 0) {
    state.optionLtp = state.lastTickPrice;
    state.optionLtpUpdatedAt = Date.now();
  }
  const optLtp = state.optionLtp;
  const spot   = state.lastTickPrice;
  if (typeof optLtp !== "number" || !Number.isFinite(optLtp) || optLtp <= 0) return;

  // High-water premium drives the trailing floor.
  if (optLtp > pos.peakPremium) {
    pos.peakPremium = optLtp;
    const trailed = rsiPivotStrategy.premiumStop(pos.optionEntryLtp, pos.peakPremium, _cfg(), pos.side);
    if (Number.isFinite(trailed) && trailed > pos.premiumFloor) {
      const prev = pos.premiumFloor;
      pos.premiumFloor = trailed;
      log(`🔒 [RSI_PIVOT_ST-PAPER] Premium floor trail ₹${prev} → ₹${trailed} (high ₹${pos.peakPremium})`);
      try { require("../utils/positionPersist").saveRsiPivotStPosition(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
    }
  }

  // MFE/MAE bookkeeping.
  if (typeof spot === "number" && Number.isFinite(spot)) {
    const favPts = (spot - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
    if (favPts > (pos.mfeSpotPts || 0)) { pos.mfeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
    if (favPts < (pos.maeSpotPts || 0)) { pos.maeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  }
  const curPnl = instrumentMode.unrealisedPnl({
    side: pos.side, entrySpot: pos.entrySpot, currentSpot: spot,
    entryPremium: pos.optionEntryLtp, currentPremium: optLtp, qty: pos.qty,
  });
  if (curPnl > (pos.mfePnl || 0)) pos.mfePnl = parseFloat(curPnl.toFixed(2));
  if (curPnl < (pos.maePnl || 0)) pos.maePnl = parseFloat(curPnl.toFixed(2));

  // 1. Premium floor — BOTH sides.
  if (rsiPivotStrategy.premiumStopHit(optLtp, pos.premiumFloor)) {
    const trailing = pos.premiumFloor > pos.initialPremiumFloor;
    simulateSell(
      `Premium ${trailing ? "trailing " : ""}stop hit — ₹${optLtp} at or below the ${pos.premiumStopPct}% floor ₹${pos.premiumFloor}` +
      (trailing ? ` (peak ₹${pos.peakPremium})` : ""),
      { isStopOut: true }
    );
    return;
  }

  // 2. SuperTrend — whichever sides ST_SIDES covers. The level is trailed on
  //    candle close; here it is only TESTED, against the live spot.
  if (Number.isFinite(pos.slSpot) && typeof spot === "number" && Number.isFinite(spot)) {
    if (rsiPivotStrategy.stopHit(pos.side, spot, pos.slSpot)) {
      // "Trailing" = the stop has TIGHTENED from where it started: up for a CE,
      // down for a PE.
      const trailing = pos.side === "CE" ? pos.slSpot > pos.initialSlSpot : pos.slSpot < pos.initialSlSpot;
      simulateSell(
        `SuperTrend ${trailing ? "trailing " : ""}stop hit — spot ${spot} at or ${pos.side === "CE" ? "below" : "above"} ${pos.slSpot}` +
        (trailing ? ` (initial ${pos.initialSlSpot})` : ""),
        { isStopOut: true }
      );
    }
  }
}

function _enforceEod() {
  if (!state.position) return;
  if (getISTMinutes() >= _parseMins("RSI_PIVOT_ST_EXIT_TIME", "15:15")) {
    simulateSell(`EOD square-off (${_envStr("RSI_PIVOT_ST_EXIT_TIME", "15:15")} IST)`);
  }
}

// ── Entry evaluation (on candle close — CLOSED bars only) ────────────────────
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
  const sig = rsiPivotStrategy.getSignal(state.candles, {
    pivots: state.pivots,
    alreadyTraded: false,
    silent: true,
  });
  state.lastSignal = sig;

  if (sig.signal === "NONE" || !sig.side) {
    // Only log the interesting near-misses — a "no setup" line every 5 minutes
    // would bury the day file 75 entries deep. A near-miss is one where the
    // price actually crossed a pivot, or RSI actually reached its threshold.
    const nearMiss = !sig.warmup && sig.rsi != null &&
      (/cross/i.test(String(sig.skipReason)) || /RSI/.test(String(sig.skipReason)));
    if (nearMiss) {
      skipLogger.appendSkipLog(MODE_KEY, {
        gate: /RSI/.test(String(sig.skipReason)) ? "rsi" : "no_cross",
        reason: sig.skipReason || sig.reason,
        spot: state.lastTickPrice,
        rsi: sig.rsi, pp: sig.pp, r1: sig.r1, s1: sig.s1,
        prevClose: sig.prevClose,
        superTrend: sig.superTrend, superTrendTrend: sig.superTrendTrend,
      });
    }
    return;
  }

  log(`🎯 [RSI_PIVOT_ST-PAPER] SETUP: ${sig.reason}`);
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
      // signal so the next polls can retry it. The retry throttle lives on THIS
      // object, not on state._lastEntryAttemptMs: sharing that field would let a
      // retry firing seconds before a bar close throttle out the new bar's own
      // evaluation.
      state._pendingEntry = { side: sig.side, sig, lastAttemptMs: Date.now() };
      log(`⚠️ [RSI_PIVOT_ST-PAPER] Entry attempt failed — retrying every ${ENTRY_RETRY_MS / 1000}s until this bar is superseded`);
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
 * stale setup can never fill minutes later off a cross the market has moved past.
 */
async function _retryPendingEntry() {
  const p = state._pendingEntry;
  if (!p) return;
  if (state.position || state._entryInFlight) return;
  if (state.dayClosed || state.tradesTaken >= _maxDailyTrades()) { state._pendingEntry = null; return; }
  if (getISTMinutes() >= _parseMins("RSI_PIVOT_ST_EXIT_TIME", "15:15")) { state._pendingEntry = null; return; }
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

// ── Candle close handler ─────────────────────────────────────────────────────
function onCandleClose(bar) {
  // A new bar supersedes any setup still waiting on a failed fill — the market
  // has moved on, and this bar's own evaluation is the current truth.
  state._pendingEntry = null;
  if (state.position) return;                    // the trail already ran in _mergeBars
  if (!bar || typeof bar.time !== "number") return;
  const cfg = _cfg();
  const closeMins = rsiPivotStrategy._utcSecToIstMins(bar.time) + cfg.resolutionMins;
  if (closeMins > cfg.entryEndMin) return;
  evaluateEntry().catch(e => console.error(`🚨 [RSI_PIVOT_ST-PAPER] entry-eval error: ${e.message}`));
}

// ── onTick — the NIFTY 50 INDEX feed. Heartbeat, live spot, forming bar. ─────
// It drives NO entry decision: every rule reads closed bars instead. It DOES
// feed the spot stop test, which is what makes a SuperTrend stop react between
// bars rather than only on the close.
function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (!price || price <= 0) return;

  const resMin = _resMin();
  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  const bucketMs = getBucketStart(Date.now(), resMin);
  const bucketSec = Math.floor(bucketMs / 1000);
  if (!state.formingBar || state.formingBarStart !== bucketMs) {
    state.formingBar = { time: bucketSec, open: price, high: price, low: price, close: price };
    state.formingBarStart = bucketMs;
  } else {
      state.formingBar.high  = Math.max(state.formingBar.high, price);
      state.formingBar.low   = Math.min(state.formingBar.low, price);
      state.formingBar.close = price;
  }

  // Spot-based exits are tested per tick so a SuperTrend stop does not wait for
  // the option poll. EOD is enforced here too, so a stalled option quote can
  // never hold a position past the square-off time.
  try { if (state.position) _checkExits(); } catch (_) {}
  _enforceEod();
}

// ── Preload history + freeze the day's pivots ────────────────────────────────
async function preloadHistory() {
  // The pivots are the first thing fetched: without them there are no levels and
  // the strategy cannot trade at all, so a failure here must be loud.
  try {
    state.pivots = await _fetchPivots();
    if (state.pivots) {
      log(`📐 [RSI_PIVOT_ST-PAPER] Pivots FROZEN for today from ${state.pivots.from}: R1 ${state.pivots.r1} · PP ${state.pivots.pp} · S1 ${state.pivots.s1} (prev range ${state.pivots.range}pt)`);
    } else {
      log(`❌ [RSI_PIVOT_ST-PAPER] No previous daily candle — R1/S1 cannot be computed, so NO trade can be taken today.`);
    }
  } catch (e) {
    log(`❌ [RSI_PIVOT_ST-PAPER] Pivot fetch failed: ${e.message} — no levels, no trades today`);
  }

  try {
    const bars = await _fetchSpotToday();
    if (Array.isArray(bars) && bars.length) {
      const resMin = _resMin();
      const nowBucketSec = Math.floor(getBucketStart(Date.now(), resMin) / 1000);
      state.candles = bars
        .filter(b => b && typeof b.time === "number" && b.time < nowBucketSec)
        .sort((a, b) => a.time - b.time)
        .slice(-400);
      state._histBucket = getBucketStart(Date.now(), resMin);
      state.lastClosedBarTime = state.candles.length ? state.candles[state.candles.length - 1].time : null;
      _refreshIndicatorReadouts();
      log(`📊 [RSI_PIVOT_ST-PAPER] Preloaded ${state.candles.length} closed ${resMin}-min NIFTY candles — RSI ${state.lastRsi != null ? state.lastRsi : "n/a"}`);
    } else {
      log(`📊 [RSI_PIVOT_ST-PAPER] No spot history yet — Fyers returned an empty series for today.`);
    }
  } catch (e) {
    log(`⚠️ [RSI_PIVOT_ST-PAPER] Spot preload failed: ${e.message}`);
  }
}

let _autoStopTimer = null;
function scheduleAutoStop() {
  if (_autoStopTimer) clearTimeout(_autoStopTimer);
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  const stopMin = h * 60 + (isNaN(m) ? 0 : m);
  const minsLeft = stopMin - getISTMinutes();
  if (minsLeft <= 0) return;
  _autoStopTimer = setTimeout(() => { log(`⏰ [RSI_PIVOT_ST-PAPER] Auto-stop @ ${raw} IST`); stopSession(); }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ────────────────────────────────────────────────────────
router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/rsi-pivot-st-paper/status");

  if (String(process.env.RSI_PIVOT_ST_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("RSI Pivot ST Disabled", "Enable RSI Pivot ST Mode in Settings first", "/settings", "Go to Settings"));
  }
  if (String(process.env.RSI_PIVOT_ST_PAPER_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("RSI Pivot ST Paper Disabled", "Enable RSI Pivot ST Paper Trading in Settings first", "/settings", "Go to Settings"));
  }

  const check = sharedSocketState.canStart("RSI_PIVOT_ST_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/rsi-pivot-st-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/rsi-pivot-st-paper/status", "← Back"));

  if (getISTMinutes() >= _parseMins("RSI_PIVOT_ST_EXIT_TIME", "15:15")) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${_envStr("RSI_PIVOT_ST_EXIT_TIME", "15:15")} IST — RSI Pivot ST does not trade after this`, "/rsi-pivot-st-paper/status", "← Back"));
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `rsi-pivot-st-paper:${Date.now()}`;

  sharedSocketState.setRsiPivotStActive("RSI_PIVOT_ST_PAPER");

  const cfg = _cfg();
  log(`🟢 [RSI_PIVOT_ST-PAPER] Session started — ${rsiPivotStrategy.NAME}`);
  log(`⚙️ [RSI_PIVOT_ST-PAPER] NIFTY @ ${cfg.resolutionMins}m · CE: RSI>${cfg.rsiCeMin} + cross/close above R1 · PE: RSI<${cfg.rsiPeMax} + cross/close below S1${cfg.pivotBufferPts ? ` (±${cfg.pivotBufferPts}pt buffer)` : ""}`);
  log(`⚙️ [RSI_PIVOT_ST-PAPER] Strike ${cfg.strikeMode} @ ${cfg.strikePct}% of spot · CE SL ${_sideStopText("CE", cfg)} · PE SL ${_sideStopText("PE", cfg)}`);
  for (const _s of ["CE", "PE"]) {
    if (rsiPivotStrategy.isStoplessSide(_s, cfg)) {
      log(`⚠️ [RSI_PIVOT_ST-PAPER] ${_s} TRADES WILL HAVE NO STOP (RSI_PIVOT_ST_PREMIUM_SL_SIDES=${cfg.premiumStopSides})` +
          `${_s === "PE" ? " and PE never carries a SuperTrend" : ""} — such a trade can only exit at the EOD square-off.`);
    }
  }
  log(`⚙️ [RSI_PIVOT_ST-PAPER] Entries ${_envStr("RSI_PIVOT_ST_ENTRY_START", "09:30")}–${_envStr("RSI_PIVOT_ST_ENTRY_END", "15:00")} · max ${_maxDailyTrades()}/day · loss cap ₹${_maxDailyLoss()} · EOD ${_envStr("RSI_PIVOT_ST_EXIT_TIME", "15:15")} · qty ${rsiPivotLotQty()}`);

  await preloadHistory();
  startPolling();

  try {
    tickRecorder.recordSessionStart({
      mode: "rsi-pivot-st-paper",
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: state.candles.map(c => ({ ...c })),
      meta: {
        instrument: instrumentConfig.INSTRUMENT,
        resolutionMin: cfg.resolutionMins,
        spotSymbol: NIFTY_INDEX_SYMBOL,
        sessionStartISO: state.sessionStart,
        recordsOptionLtps: true,
        pivots: state.pivots || null,
      },
    });
  } catch (_) {}

  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [RSI_PIVOT_ST-PAPER] Piggybacking on existing WebSocket (NIFTY 50 index)");
  } else {
      socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
      socketManager.addCallback(CALLBACK_ID, onTick, log);
      log("📡 [RSI_PIVOT_ST-PAPER] Started WebSocket (NIFTY 50 index)");
  }

  scheduleAutoStop();

  notifyStarted({
    mode: "RSI_PIVOT_ST-PAPER",
    text: [
      `📄 RSI PIVOT ST PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${rsiPivotStrategy.NAME}`,
      `Chart     : NIFTY 50 index @ ${cfg.resolutionMins}-min`,
      state.pivots
        ? `Levels    : R1 ${state.pivots.r1} · PP ${state.pivots.pp} · S1 ${state.pivots.s1} (from ${state.pivots.from})`
        : `Levels    : ⚠️ NOT AVAILABLE — no previous daily candle, no trades possible today`,
      `Setup     : CE = RSI>${cfg.rsiCeMin} + close above R1 · PE = RSI<${cfg.rsiPeMax} + close below S1`,
      `Strike    : ${cfg.strikeMode} @ ${cfg.strikePct}% of spot`,
      `Stops     : CE ${_sideStopText("CE", cfg)} · PE ${_sideStopText("PE", cfg)}`,
      `Max trades: ${_maxDailyTrades()}/day · loss cap ₹${_maxDailyLoss()}`,
      `Square-off: ${_envStr("RSI_PIVOT_ST_EXIT_TIME", "15:15")} IST`,
    ].filter(Boolean).join("\n"),
  });

  res.redirect("/rsi-pivot-st-paper/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped");
  state.running = false;
  stopPolling();

  try { tickRecorder.recordSessionStop({ mode: "rsi-pivot-st-paper", sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  sharedSocketState.clearRsiPivotSt();   // clear OWN mode first (else the socket never stops → leak)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: rsiPivotStrategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      data.capital  = parseFloat((parseFloat(process.env.ZERODHA_INV_AMOUNT || process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
      saveData(data);
      log(`💾 [RSI_PIVOT_ST-PAPER] Session saved — ${state.sessionTrades.length} trades, PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ [RSI_PIVOT_ST-PAPER] Save failed: ${e.message}`);
    }
  }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  log(`📋 [RSI_PIVOT_ST-PAPER] Day summary — ${state.sessionTrades.length} trade(s), ${wins}W/${state.sessionTrades.length - wins}L, net ₹${state.sessionPnl}, week ₹${weeklyPnl()}`);
  log("🔴 [RSI_PIVOT_ST-PAPER] Session stopped");

  notifyDayReport({
    mode: "RSI_PIVOT_ST-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/rsi-pivot-st-paper/status"); });
router.get("/exit", (req, res) => { if (state.position) simulateSell("Manual exit"); res.redirect("/rsi-pivot-st-paper/status"); });

// ── /status/chart-data — spot candles + pivot levels + stops ─────────────────
router.get("/status/chart-data", (req, res) => {
  try {
    const cfg = _cfg();
    const candles = state.candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    let formingShown = false;
    if (state.formingBar && (!candles.length || state.formingBar.time > candles[candles.length - 1].time)) {
      candles.push({ time: state.formingBar.time, open: state.formingBar.open, high: state.formingBar.high, low: state.formingBar.low, close: state.formingBar.close });
      formingShown = true;
    }

    // SuperTrend line, aligned 1:1 with the closed candles so the chart plots the
    // exact values the CE stop uses.
    const stSeries = rsiPivotStrategy.computeSuperTrendSeries(state.candles, cfg);
    const superTrend = [];
    for (let i = 0; i < state.candles.length; i++) {
      const v = stSeries[i];
      if (v && typeof v.value === "number") superTrend.push({ time: state.candles[i].time, value: v.value });
    }

    // The RSI pane spans the WHOLE session, with the warm-up bars emitted as
    // whitespace points ({time} and no value). Two panes whose series cover
    // different time ranges fight each other when their x-axes are synced —
    // whichever is shorter drags the other in — and the candles lose their
    // first bars. Whitespace keeps the coverage identical and simply starts the
    // line where RSI becomes computable.
    const rsiOut = rsiPivotStrategy.computeRsi(state.candles, cfg.rsiPeriod);
    const rsiLine = [];
    let rsiPoints = 0;
    for (let j = 0; j < state.candles.length; j++) {
      const c = state.candles[j];
      const v = rsiOut.values[j - rsiOut.offset];
      if (typeof v === "number" && Number.isFinite(v)) {
        rsiLine.push({ time: c.time, value: parseFloat(v.toFixed(2)) });
        rsiPoints++;
      } else {
        rsiLine.push({ time: c.time });
      }
    }
    // The candle series carries the still-forming bar; RSI does not compute on a
    // partial bar, but the pane must still span it or the synced x-axes differ
    // by one bar and each keeps nudging the other.
    if (formingShown) rsiLine.push({ time: state.formingBar.time });

    const markers = [];
    for (const t of state.sessionTrades) {
      const _entryTxt = t.entryPrice != null ? t.entryPrice : (t.spotAtEntry != null ? t.spotAtEntry : "");
      if (t.entryBarTime) markers.push({ time: t.entryBarTime, position: t.side === "CE" ? "belowBar" : "aboveBar", color: t.side === "CE" ? "#10b981" : "#ef4444", shape: t.side === "CE" ? "arrowUp" : "arrowDown", text: `${t.side} ${_entryTxt}`.trim() });
      if (t.exitBarTime)  markers.push({ time: t.exitBarTime,  position: t.side === "CE" ? "aboveBar" : "belowBar", color: (t.pnl || 0) >= 0 ? "#10b981" : "#ef4444", shape: "circle", text: `${(t.pnl || 0) >= 0 ? "+" : ""}${Math.round(t.pnl || 0)}` });
    }

    const pos = state.position;
    const p = state.pivots;
    res.json({
      candles, markers, superTrend, rsi: rsiLine,
      // Whitespace points count toward rsi.length, so the warm-up overlay needs
      // the count of REAL values to know whether the line has anything to draw.
      rsiPoints,
      pp: p ? p.pp : null,
      r1: p ? p.r1 : null,
      s1: p ? p.s1 : null,
      r2: p ? p.r2 : null,
      s2: p ? p.s2 : null,
      pivotFrom: p ? p.from : null,
      entryPrice: pos ? pos.entrySpot : null,
      stopLoss:   pos ? pos.slSpot : null,
      target:     null,
      rsiCeMin:   cfg.rsiCeMin,
      rsiPeMax:   cfg.rsiPeMax,
      resMin:     cfg.resolutionMins,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const data = loadData();
  const cfg = _cfg();

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = instrumentMode.unrealisedPnl({
      side: pos.side, entrySpot: pos.entrySpot, currentSpot: state.lastTickPrice,
      entryPremium: pos.optionEntryLtp, currentPremium: state.optionLtp, qty: (pos.qty || rsiPivotLotQty()),
    });
  }

  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) }); }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const bestTrade = state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null;
  const worstTrade = state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null;

  const s = state.lastSignal;
  const p = state.pivots;
  res.json({
    running: state.running, sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-100),
    tickCount: state.tickCount, lastTickPrice: state.lastTickPrice,
    candles: state.candles.length, currentBar: state.formingBar, sessionStart: state.sessionStart,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge,
    wins, losses, winRate, bestTrade, worstTrade, cumPnl, livePnl,
    weeklyPnl: weeklyPnl(),
    // RSI_PIVOT_ST context
    pivots: p,
    pp: p ? p.pp : null, r1: p ? p.r1 : null, s1: p ? p.s1 : null,
    pivotFrom: p ? p.from : null,
    rsi: state.lastRsi,
    superTrend: state.lastSuperTrend ? state.lastSuperTrend.value : null,
    superTrendTrend: state.lastSuperTrend ? state.lastSuperTrend.trend : null,
    dayClosed: state.dayClosed, dayClosedReason: state.dayClosedReason,
    stopOuts: state.stopOuts,
    maxDailyTrades: _maxDailyTrades(), maxDailyLoss: _maxDailyLoss(),
    lastSkipReason: s && s.signal === "NONE" ? (s.skipReason || s.reason) : null,
    // Live "why nothing was taken", recomputed rather than read from the last
    // candle-close verdict — see _entryDiagnosis.
    entryCheck: _entryDiagnosis(),
    cfg: {
      resMin: cfg.resolutionMins,
      rsiPeriod: cfg.rsiPeriod, rsiCeMin: cfg.rsiCeMin, rsiPeMax: cfg.rsiPeMax,
      pivotBufferPts: cfg.pivotBufferPts,
      strikeMode: cfg.strikeMode, strikePct: cfg.strikePct,
      stPeriod: cfg.stPeriod, stMultiplier: cfg.stMultiplier, stCeEnabled: cfg.stCeEnabled,
      stSides: cfg.stSides,
      premiumStopPct: cfg.premiumStopPct,
      premiumStopSides: cfg.premiumStopSides,
      entryStart: _envStr("RSI_PIVOT_ST_ENTRY_START", "09:30"),
      entryEnd: _envStr("RSI_PIVOT_ST_ENTRY_END", "15:00"),
      forcedExit: _envStr("RSI_PIVOT_ST_EXIT_TIME", "15:15"),
    },
    position: pos ? {
      side: pos.side, symbol: pos.symbol, entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      slSpot: pos.slSpot, premiumFloor: pos.premiumFloor, initialPremiumFloor: pos.initialPremiumFloor,
      premiumStopPct: pos.premiumStopPct,
      premiumStopSides: pos.premiumStopSides,
      premiumStopApplies: pos.premiumStopApplies,
      riskPts: pos.riskPts,
      signalRsi: pos.signalRsi, crossedLevel: pos.crossedLevel,
      strikeMode: pos.strikeMode, strikeDistancePts: pos.strikeDistancePts,
      optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry,
      peakPremium: pos.peakPremium, entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      qty: pos.qty, currentOptLtp: state.optionLtp,
      heldSec: Math.round((Date.now() - pos.entryTimeMs) / 1000),
    } : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

/**
 * The entry rule re-run purely for DISPLAY — never for a decision.
 *
 * evaluateEntry() only runs on a closed bar, and it stores its verdict in
 * state.lastSignal. A screen that renders that field shows a verdict up to five
 * minutes stale, and shows nothing at all before the first bar closes. Since
 * getSignal() is pure over closed bars, recomputing it here is free and lets
 * every screen answer "why has nothing been taken" at the moment it is asked.
 */
function _entryDiagnosis() {
  const cfg     = _cfg();
  const minBars = rsiPivotStrategy.minBarsFor(cfg);
  const bars    = state.candles.length;
  const out = {
    minBars, bars,
    warmup:   bars < minBars,
    barsLeft: Math.max(0, minBars - bars),
    readyAt:  null,
    signal:   "NONE",
    side:     null,
    rsi:      state.lastRsi,
    reason:   null,
  };

  // A warm-up counted in bars is not something a user can wait for; the clock
  // time of the bar that finally makes the engine eligible is.
  if (out.warmup && bars) {
    const last = state.candles[bars - 1];
    out.readyAt = rsiPivotStrategy._fmtMins(
      rsiPivotStrategy._utcSecToIstMins(last.time) + cfg.resolutionMins * (out.barsLeft + 1)
    );
  }

  try {
    const sig = rsiPivotStrategy.getSignal(state.candles, { cfg, pivots: state.pivots, silent: true });
    out.signal = sig.signal;
    out.side   = sig.side || null;
    out.reason = sig.signal === "NONE" ? (sig.skipReason || sig.reason) : (sig.reason || `${sig.side} setup`);
    if (sig.rsi != null) out.rsi = sig.rsi;
  } catch (e) {
    out.reason = `Entry check could not run: ${e.message}`;
  }
  return out;
}

/**
 * Escape engine text before it is interpolated into the page. Skip reasons carry
 * "<" and ">" from the threshold comparisons, and a "<" that lands next to a
 * letter is parsed as a tag opener that swallows the rest of the layout.
 */
function _escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Colour + heading for the entry-check panel, so page and AJAX agree. */
function _diagStyle(diag, running) {
  if (!running)      return { color: "#8ba1c2", bg: "#0d1320", border: "#1a2236", head: "Session stopped" };
  if (diag.warmup)   return { color: "#f59e0b", bg: "#1c1400", border: "#78350f", head: "Warming up" };
  if (diag.signal !== "NONE") return { color: "#10b981", bg: "#071a12", border: "#134e35", head: `${diag.side} setup` };
  return { color: "#8ba1c2", bg: "#0d1320", border: "#1a2236", head: "No setup" };
}

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getRsiPivotStMode() === "RSI_PIVOT_ST_LIVE";
  const data   = loadData();
  const pos    = state.position;
  const cfg    = _cfg();
  const p      = state.pivots;
  const resMin = cfg.resolutionMins;

  const wins    = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses  = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const best    = state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null;
  const worst   = state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null;

  const startCap  = parseFloat(process.env.ZERODHA_INV_AMOUNT || process.env.FYERS_INV_AMOUNT || "100000");
  const maxTrades = _maxDailyTrades();
  const maxLoss   = _maxDailyLoss();
  const dailyLossHit = maxLoss > 0 && state.sessionPnl <= -maxLoss;

  const diag  = _entryDiagnosis();
  const dStyle = _diagStyle(diag, state.running);

  const pnlColor = (n) => (n || 0) >= 0 ? "#10b981" : "#ef4444";
  const money = (n) => (n >= 0 ? "+" : "") + "₹" + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = instrumentMode.unrealisedPnl({
      side: pos.side, entrySpot: pos.entrySpot, currentSpot: state.lastTickPrice,
      entryPremium: pos.optionEntryLtp, currentPremium: state.optionLtp, qty: (pos.qty || rsiPivotLotQty()),
    });
  }

  const stText = state.lastSuperTrend && state.lastSuperTrend.value != null
    ? `${state.lastSuperTrend.value} ${state.lastSuperTrend.trend === 1 ? "▲" : "▼"}` : "—";
  const stColor = state.lastSuperTrend && state.lastSuperTrend.trend === 1 ? "#10b981"
    : state.lastSuperTrend && state.lastSuperTrend.trend === -1 ? "#ef4444" : "#c8d8f0";

  const statCards = [
    { label: "Session PnL", accent: pnlColor(state.sessionPnl),
      value: `<span id="ajax-session-pnl" style="color:${pnlColor(state.sessionPnl)};">${money(state.sessionPnl || 0)}</span>` },
    { label: "Trades Today", accent: "#6a5090",
      value: `<span id="ajax-trade-count">${state.tradesTaken || 0}</span> <span style="font-size:0.75rem;color:var(--muted-1,#8ba1c2);">/ ${maxTrades}</span>`,
      sub: `<span id="ajax-wl">${wins}W · ${losses}L</span>` },
    { label: "Live PnL", accent: "#3b82f6",
      value: `<span id="ajax-live-pnl" style="color:${livePnl == null ? "#c8d8f0" : pnlColor(livePnl)};">${livePnl == null ? "—" : money(livePnl)}</span>`,
      sub: `<span id="ajax-live-pnl-sub">${pos ? "unrealised" : "no open position"}</span>` },
    { label: `RSI(${cfg.rsiPeriod})`, accent: "#38bdf8",
      value: `<span id="ajax-rsi">${state.lastRsi != null ? state.lastRsi : "—"}</span>`,
      sub: `<span style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);">CE needs &gt;${cfg.rsiCeMin} · PE needs &lt;${cfg.rsiPeMax}</span>` },
    { label: `SuperTrend(${cfg.stPeriod},${cfg.stMultiplier})`, accent: "#a78bfa",
      value: `<span id="ajax-st" style="color:${stColor};">${stText}</span>`,
      sub: `<span style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);">stops ${cfg.stSides === "NONE" ? "no side" : cfg.stSides}</span>` },
    { label: "Warm-up", accent: diag.warmup ? "#f59e0b" : "#10b981",
      value: `<span id="ajax-warmup" style="color:${diag.warmup ? "#f59e0b" : "#10b981"};">${diag.bars} / ${diag.minBars}</span>`,
      sub: `<span id="ajax-warmup-sub" style="font-size:0.6rem;color:${diag.warmup ? "#f59e0b" : "#10b981"};">${diag.warmup ? (diag.readyAt ? `eligible from ${diag.readyAt}` : "waiting for bars") : "closed bars — ready"}</span>` },
    { label: "Win Rate", accent: "#a07010",
      value: `<span id="ajax-wr">${winRate != null ? winRate + "%" : "—"}</span>`,
      sub: `<span id="ajax-wr-sub" style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);">best ${best == null ? "—" : best.toFixed(0)} / worst ${worst == null ? "—" : worst.toFixed(0)}</span>` },
    { label: "Daily Loss Limit", accent: dailyLossHit ? "#ef4444" : "#10b981",
      value: `<span id="ajax-daily-loss-val" style="color:${dailyLossHit ? "#ef4444" : "#10b981"};">${dailyLossHit ? "HIT" : "OK"} <span style="font-size:0.65rem;color:var(--muted-1,#8ba1c2);">/ -₹${maxLoss.toLocaleString("en-IN")}</span></span>`,
      sub: `<span id="ajax-daily-loss-sub" style="color:${dailyLossHit ? "#ef4444" : "#10b981"};">${dailyLossHit ? "KILLED — no entries" : "Active"}</span>` },
    { label: "WebSocket Ticks", accent: "#2a6080",
      value: `<span id="ajax-tick-count">${(state.tickCount || 0).toLocaleString()}</span>`,
      sub: `Last: <span id="ajax-last-tick">${state.lastTickPrice ? "₹" + state.lastTickPrice.toLocaleString("en-IN") : "—"}</span>` },
    { label: "Session Start", accent: "#2a4020",
      value: `<span style="font-size:0.85rem;color:#c8d8f0;">${state.sessionStart || "—"}</span>` },
  ];

  const posHtml = pos ? (() => {
    const liveOpt    = state.optionLtp;
    const optMove    = liveOpt != null ? (liveOpt - pos.optionEntryLtp) : null;
    const optMovePct = (liveOpt != null && pos.optionEntryLtp) ? (optMove / pos.optionEntryLtp) * 100 : null;
    const spotMove   = state.lastTickPrice != null ? (state.lastTickPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1) : null;
    const stopless   = rsiPivotStrategy.isStoplessSide(pos.side, cfg);
    return `
    <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;"></span>
          <span style="font-size:0.8rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;">Open Position</span>
          <span style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);">Since ${pos.entryTime || "—"}</span>
        </div>
        <button onclick="rpsHandleExit(this)" style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;">Exit Trade Now</button>
      </div>
      ${stopless ? `<div style="background:#2a0a0a;border:1px solid #ef4444;color:#fca5a5;border-radius:10px;padding:12px 16px;margin-bottom:14px;font-size:0.78rem;line-height:1.5;">
        <b>THIS ${pos.side} TRADE HAS NO STOP.</b> The premium floor is off for ${pos.side}${pos.side === "PE" ? " and PE never carries a SuperTrend" : ""} — the only exit is the ${_envStr("RSI_PIVOT_ST_EXIT_TIME", "15:15")} square-off. The full premium is at risk.
      </div>` : ""}
      <div style="background:#071a12;border:1px solid #134e35;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:2.2rem;font-weight:900;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side}</span>
            <div>
              <div style="font-size:0.72rem;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.isFutures ? (pos.side === "CE" ? "LONG · closed above R1" : "SHORT · closed below S1") : (pos.side === "CE" ? "CALL · closed above R1" : "PUT · closed below S1")}</div>
              <span style="font-size:0.65rem;font-weight:700;color:#94a3b8;">RSI ${pos.signalRsi ?? "—"} · crossed ${pos.side === "CE" ? "R1" : "S1"} ${pos.crossedLevel ?? "—"}</span>
            </div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Strike</div><div style="font-size:1.6rem;font-weight:800;color:#fff;font-family:monospace;">${pos.optionStrike ? pos.optionStrike.toLocaleString("en-IN") : "—"}</div><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);">${pos.strikeMode || ""}${pos.strikeDistancePts ? ` · ${pos.strikeDistancePts}pt` : ""}</div></div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Expiry</div><div style="font-size:1.1rem;font-weight:700;color:#f59e0b;">${pos.optionExpiry || "—"}</div></div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Qty</div><div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty}</div></div>
          <div style="width:1px;height:44px;background:#134e35;flex-shrink:0;"></div>
          <div style="flex:1;min-width:200px;"><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Full Symbol</div><div style="font-size:0.82rem;font-weight:600;color:#c8d8f0;font-family:monospace;word-break:break-all;">${pos.symbol}</div></div>
        </div>
      </div>
      <div style="background:#0a0f24;border:2px solid #3b82f6;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
        <div style="font-size:0.68rem;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">${pos.isFutures ? `Futures Price (${pos.side === "CE" ? "LONG" : "SHORT"})` : `Option Premium (${pos.side})`}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">
          <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid #1e3a5f;border-radius:10px;">
            <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Entry Price</div>
            <div id="ajax-opt-entry-ltp" style="font-size:2rem;font-weight:800;color:#60a5fa;font-family:monospace;line-height:1;">₹${pos.optionEntryLtp ? pos.optionEntryLtp.toFixed(2) : "—"}</div>
          </div>
          <div style="text-align:center;font-size:1.8rem;color:${optMove != null ? (optMove >= 0 ? "#10b981" : "#ef4444") : "#8ba1c2"};">→</div>
          <div style="text-align:center;padding:12px;background:${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#071a0f" : "#1a0707") : "#0d1320"};border:2px solid ${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};border-radius:10px;">
            <div style="font-size:0.63rem;color:${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#10b981" : "#ef4444") : "#8ba1c2"};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Current LTP</div>
            <div id="ajax-opt-current-ltp" style="font-size:2rem;font-weight:800;color:${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">${liveOpt != null ? "₹" + liveOpt.toFixed(2) : "⏳"}</div>
            <div id="ajax-opt-move" style="font-size:0.72rem;font-weight:700;margin-top:6px;color:${optMove != null ? (optMove >= 0 ? "#10b981" : "#ef4444") : "#f59e0b"};">${optMove != null ? (optMove >= 0 ? "▲ +" : "▼ ") + "₹" + Math.abs(optMove).toFixed(2) : "⏳ Polling..."}</div>
            <div id="ajax-opt-pct" style="font-size:1.1rem;font-weight:800;margin-top:4px;color:${optMovePct != null ? (optMovePct >= 0 ? "#10b981" : "#ef4444") : "#8ba1c2"};font-family:monospace;">${optMovePct != null ? (optMovePct >= 0 ? "+" : "") + optMovePct.toFixed(2) + "%" : "—"}</div>
          </div>
          <div style="text-align:center;padding:12px;background:${livePnl != null ? (livePnl >= 0 ? "#071a0f" : "#1a0707") : "#0d1320"};border:1px solid ${livePnl != null ? (livePnl >= 0 ? "#065f46" : "#7f1d1d") : "#1a2236"};border-radius:10px;">
            <div style="font-size:0.63rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Unrealised P&amp;L</div>
            <div id="ajax-opt-pnl" style="font-size:1.8rem;font-weight:800;color:${livePnl != null ? (livePnl >= 0 ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">${livePnl != null ? money(livePnl) : "—"}</div>
            <div style="font-size:0.65rem;color:var(--muted-1,#8ba1c2);margin-top:4px;">${pos.qty} qty</div>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;">
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY @ Entry</div><div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">₹${pos.entrySpot ? pos.entrySpot.toFixed(2) : "—"}</div></div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY LTP</div><div id="ajax-nifty-ltp" style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${state.lastTickPrice ? "₹" + state.lastTickPrice.toFixed(2) : "—"}</div><div id="ajax-nifty-move" style="font-size:0.63rem;color:${spotMove != null && spotMove >= 0 ? "#10b981" : "#ef4444"};margin-top:2px;">${spotMove != null ? (spotMove >= 0 ? "▲" : "▼") + " " + Math.abs(spotMove).toFixed(1) + " pts" : "—"}</div></div>
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">SuperTrend Stop</div><div id="ajax-sl-spot" style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.slSpot != null ? "₹" + pos.slSpot.toFixed(2) : "not on " + pos.side}</div><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);">${pos.riskPts != null ? pos.riskPts.toFixed(1) + "pt risk" : ""}</div></div>
        <div style="background:#10131c;border:1px solid #1e2940;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${pos.isFutures ? "Premium Floor" : `Premium Floor (${pos.premiumStopPct}%)`}</div><div id="ajax-prem-floor" style="font-size:1.05rem;font-weight:700;color:${Number.isFinite(pos.premiumFloor) ? "#c8d8f0" : "#8ba1c2"};">${Number.isFinite(pos.premiumFloor) ? "₹" + pos.premiumFloor.toFixed(2) : (pos.isFutures ? "n/a (futures)" : "OFF on " + pos.side)}</div></div>
        <div style="background:#0a1f12;border:1px solid #0d4030;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${pos.isFutures ? "Peak Price" : "Peak Premium"}</div><div id="ajax-peak-prem" style="font-size:1.05rem;font-weight:700;color:#10b981;">${pos.peakPremium ? "₹" + pos.peakPremium.toFixed(2) : "—"}</div></div>
        <div style="background:#0a1f12;border:1px solid #0d4030;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Pivots From</div><div style="font-size:0.95rem;font-weight:700;color:#c8d8f0;">${pos.pivotFrom || "—"}</div></div>
      </div>
      ${pos.entryReason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;margin-top:12px;">Entry: ${_escHtml(pos.entryReason)}</div>` : ""}
    </div>`;
  })() : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:0.9rem;font-weight:600;color:var(--muted-1,#8ba1c2);">FLAT — ${state.dayClosed ? _escHtml(state.dayClosedReason) : state.running ? "waiting for a pivot cross" : "session stopped"}</div>
    </div>`;

  const allLogs   = [...state.log].reverse();
  const logsJSON  = JSON.stringify(allLogs).replace(/<\/script>/gi, "<\\/script>").replace(/`/g, "\\u0060").replace(/\$/g, "\\u0024");
  const tradesJSON = JSON.stringify(state.sessionTrades).replace(/<\/script>/gi, "<\\/script>").replace(/`/g, "\\u0060").replace(/\$/g, "\\u0024");

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${faviconLink()}
<title>RSI Pivot ST Paper — ${rsiPivotStrategy.NAME}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
<style>
${sidebarCSS()}
${modalCSS()}
${bbRsiStyleCSS()}
.pv-levels{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:18px}
.pv-chip{background:#0d1320;border:1px solid #1a2236;border-radius:10px;padding:11px 14px}
.pv-chip .pv-k{font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px}
.pv-chip b{display:block;font-size:1.15rem;margin-top:4px;font-family:'IBM Plex Mono',monospace}
.pv-r1{border-color:#7f1d1d}.pv-r1 b{color:#f87171}
.pv-pp{border-color:#334155}.pv-pp b{color:#94a3b8}
.pv-s1{border-color:#14532d}.pv-s1 b{color:#4ade80}
.pv-warn{background:#3f1d1d;border:1px solid #7f1d1d;color:#fca5a5;padding:12px 14px;border-radius:10px;margin-bottom:18px;font-size:0.8rem;line-height:1.5}
</style></head>
<body>
<div class="app-shell">
${buildSidebar("rsiPivotStPaper", liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `secretGo('/rsi-pivot-st-paper/start', this)`, startLabel: "▶ Start RSI Pivot ST",
  showStopBtn:  state.running,  stopBtnJs:  `secretGo('/rsi-pivot-st-paper/stop', this)`,  stopLabel:  "■ Stop RSI Pivot ST",
  showExitBtn:  state.running && !!pos, exitBtnJs: `rpsHandleExit(this)`, exitLabel: "🚪 Exit Trade",
})}
<div class="main-content">

${bbRsiTopBar({
  title: "RSI Pivot ST — Paper",
  metaLine: `${rsiPivotStrategy.NAME} · ${resMin}-min · CE ${_sideStopText("CE", cfg)} · PE ${_sideStopText("PE", cfg)} · Entry ${_envStr("RSI_PIVOT_ST_ENTRY_START", "09:30")}–${_envStr("RSI_PIVOT_ST_ENTRY_END", "15:00")} · Square-off ${_envStr("RSI_PIVOT_ST_EXIT_TIME", "15:15")} IST · ${state.running ? "Auto-refreshes every 2s" : "Stopped"}`,
  running: state.running,
  primaryAction: { label: "Start RSI Pivot ST Paper", href: "/rsi-pivot-st-paper/start" },
  stopAction:    { label: "Stop Session",             href: "/rsi-pivot-st-paper/stop"  },
  historyHref: "/rsi-pivot-st-paper/history",
})}

${bbRsiCapitalStrip({ starting: startCap, current: data.capital, allTime: data.totalPnl, startingThreshold: startCap })}

<div class="section-title">Today's Pivots — frozen before the open</div>
${p ? `<div class="pv-levels">
  <div class="pv-chip pv-r1"><div class="pv-k">R1 · CE trigger</div><b>${p.r1}</b></div>
  <div class="pv-chip pv-pp"><div class="pv-k">PP</div><b>${p.pp}</b></div>
  <div class="pv-chip pv-s1"><div class="pv-k">S1 · PE trigger</div><b>${p.s1}</b></div>
  <div class="pv-chip"><div class="pv-k">From</div><b style="font-size:0.9rem;">${p.from}</b></div>
  <div class="pv-chip"><div class="pv-k">Prev range</div><b style="font-size:0.9rem;">${p.range}pt</b></div>
</div>` : `<div class="pv-warn">⚠️ Pivot levels not available — no previous daily candle was returned, so R1/S1 cannot be computed and no trade can be taken today. Check the activity log for the reason.</div>`}

<div class="section-title">Entry Check</div>
<div id="ajax-decision" style="background:${dStyle.bg};border:1px solid ${dStyle.border};border-radius:12px;padding:14px 18px;margin-bottom:18px;">
  <div id="ajax-decision-head" style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:${dStyle.color};margin-bottom:6px;">${dStyle.head}</div>
  <div id="ajax-decision-body" style="font-size:0.83rem;color:#c8d8f0;line-height:1.55;">${_escHtml(diag.reason) || "—"}</div>
</div>

${bbRsiStatGrid(statCards)}

${bbRsiCurrentBar({ bar: state.formingBar, resMin })}

<div id="ajax-position-section" style="margin-bottom:18px;">
${posHtml}
</div>

${process.env.CHART_ENABLED !== "false" ? `
<div style="margin-bottom:18px;">
  <div class="section-title">NIFTY ${resMin}-Min Chart — R1 / PP / S1 + SuperTrend</div>
  <div style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
    <div id="nifty-chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;">
      <span style="color:#f87171;">── R1</span> &nbsp;<span style="color:#64748b;">── PP</span> &nbsp;<span style="color:#4ade80;">── S1</span> &nbsp;<span style="color:#a78bfa;">── SuperTrend</span> &nbsp;<span style="color:#38bdf8;">── Entry</span> &nbsp;<span style="color:#fbbf24;">── SL</span>
    </div>
  </div>
</div>

<div style="margin-bottom:18px;">
  <div class="section-title">RSI(${cfg.rsiPeriod}) — CE needs &gt; ${cfg.rsiCeMin}, PE needs &lt; ${cfg.rsiPeMax}</div>
  <div style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:150px;">
    <div id="rsi-chart" style="width:100%;height:100%;"></div>
    <div id="rsi-warmup" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 20px;font-size:0.78rem;color:#f59e0b;background:rgba(10,15,28,0.92);z-index:3;">
      RSI(${cfg.rsiPeriod}) needs ${cfg.rsiPeriod + 1} closed ${resMin}-min bars — ${diag.bars} so far${diag.readyAt ? `, first value at ${diag.readyAt} IST` : ""}
    </div>
  </div>
</div>` : ""}

<div style="margin-bottom:18px;">
  <div class="section-title">Session Trades <span id="rps-trades-hint" style="color:var(--muted-1,#8ba1c2);font-weight:400;letter-spacing:0.5px;text-transform:none;margin-left:8px;">${state.sessionTrades.length} trades</span><a href="/rsi-pivot-st-paper/download/trades.jsonl" title="Download the full paper-trade log" style="float:right;font-weight:400;font-size:0.72rem;letter-spacing:0.5px;text-transform:none;color:#4a9cf5;text-decoration:none;">⬇ trades.jsonl</a></div>
  <div id="rps-trades-box" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;"></div>
</div>

${bbRsiActivityLog({ logsJSON })}

</div><!-- /main-content -->
</div><!-- /app-shell -->

<script>${modalJS()}</script>
<script>
async function rpsHandleExit(btn) {
  var ok = await showConfirm({ icon:'🚪', title:'Exit position', message:'Exit the open RSI Pivot ST position now?', confirmText:'Exit', confirmClass:'modal-btn-danger' });
  if (!ok) return;
  var orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Exiting...';
  secretFetch('/rsi-pivot-st-paper/exit').then(function(r){
    if (!r) { btn.disabled = false; btn.textContent = orig; return; }
    location.reload();
  }).catch(function(){ location.reload(); });
}
</script>

<script>
(function(){
  if (typeof LightweightCharts === 'undefined') return;
  var container = document.getElementById('nifty-chart');
  var rsiBox    = document.getElementById('rsi-chart');
  if (!container || !rsiBox) return;
  var baseOpts = {
    layout:{ background:{type:'solid',color:'#0a0f1c'}, textColor:'#8ba1c2', fontSize:11, fontFamily:"'IBM Plex Mono', monospace" },
    grid:{ vertLines:{color:'#111827'}, horzLines:{color:'#111827'} },
    // Both panes must reserve the SAME price-scale width or their shared x-axis
    // is offset by however much '78.00' is narrower than '24,280.00'.
    rightPriceScale:{ borderColor:'#1a2236', minimumWidth:74 },
    timeScale:{ borderColor:'#1a2236', timeVisible:true, secondsVisible:false,
      tickMarkFormatter:function(t){ var d=new Date((t+19800)*1000); return ('0'+d.getUTCHours()).slice(-2)+':'+('0'+d.getUTCMinutes()).slice(-2); } },
  };
  var chart = LightweightCharts.createChart(container, Object.assign({ width: container.clientWidth, height: container.clientHeight }, baseOpts));
  var cs = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var stS = chart.addLineSeries({ color:'#a78bfa', lineWidth:2, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });

  var rsiChart = LightweightCharts.createChart(rsiBox, Object.assign({ width: rsiBox.clientWidth, height: rsiBox.clientHeight }, baseOpts));
  var rsiS = rsiChart.addLineSeries({ color:'#38bdf8', lineWidth:2, priceLineVisible:false });
  var rsiGuides = [];

  // The two panes share one x-axis: scrolling one without the other turns the
  // RSI reading under a candle into a lie. Sync by TIME, not by logical index —
  // the RSI series starts rsiPeriod bars after the candles, so index 0 means a
  // different bar on each chart and an index sync slides them apart.
  // Sync stays OFF until RSI has at least one real value: a series that is all
  // whitespace has no range of its own, so syncing into it and letting it answer
  // back collapses the candle pane to a couple of bars.
  var syncing = false, rsiReady = false;
  function syncTo(target){
    return function(r){
      if (!r || syncing || !rsiReady) return;
      syncing = true;
      try { target.timeScale().setVisibleRange({ from: r.from, to: r.to }); } catch (_) {}
      syncing = false;
    };
  }
  chart.timeScale().subscribeVisibleTimeRangeChange(syncTo(rsiChart));
  rsiChart.timeScale().subscribeVisibleTimeRangeChange(syncTo(chart));

  var lines = [], guidesDone = false, fitted = false;
  async function fetchChart(){
    try {
      var r = await fetch('/rsi-pivot-st-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.error) return;
      cs.setData(d.candles || []);
      stS.setData(d.superTrend || []);
      rsiS.setData(d.rsi || []);
      if (d.markers) cs.setMarkers(d.markers.slice().sort(function(a,b){ return a.time-b.time; }));

      if (!fitted && d.candles && d.candles.length) { fitted = true; chart.timeScale().fitContent(); }

      // The first poll that carries real RSI values is when the panes can be
      // aligned; fitContent does not notify the subscriber, so push once here.
      if (!rsiReady && d.rsiPoints) {
        rsiReady = true;
        try {
          var vr = chart.timeScale().getVisibleRange();
          if (vr) rsiChart.timeScale().setVisibleRange(vr);
        } catch (_) {}
      }

      var warm = document.getElementById('rsi-warmup');
      if (warm) warm.style.display = d.rsiPoints ? 'none' : 'flex';

      if (!guidesDone && d.rsiPoints) {
        guidesDone = true;
        rsiGuides.push(rsiS.createPriceLine({ price:d.rsiCeMin, color:'#f87171', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'CE' }));
        rsiGuides.push(rsiS.createPriceLine({ price:d.rsiPeMax, color:'#4ade80', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'PE' }));
      }

      for (var i=0;i<lines.length;i++){ try{ cs.removePriceLine(lines[i]); }catch(_){} }
      lines = [];
      var mk = function(price, color, title){
        if (typeof price === 'number' && isFinite(price)) {
          lines.push(cs.createPriceLine({ price:price, color:color, lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:title }));
        }
      };
      mk(d.r1, '#f87171', 'R1');
      mk(d.pp, '#64748b', 'PP');
      mk(d.s1, '#4ade80', 'S1');
      mk(d.entryPrice, '#38bdf8', 'Entry');
      mk(d.stopLoss, '#fbbf24', 'SL');
    } catch (e) {}
  }
  fetchChart();
  if (${state.running}) setInterval(fetchChart, 5000);
  window.addEventListener('resize', function(){
    chart.applyOptions({ width: container.clientWidth });
    rsiChart.applyOptions({ width: rsiBox.clientWidth });
  });
  // The sidebar collapse resizes .main-content without firing a window resize,
  // so the canvas would keep its first-paint width until the next reload.
  if (window.ResizeObserver) {
    var shell = document.querySelector('.main-content');
    if (shell) new ResizeObserver(function(){
      chart.applyOptions({ width: container.clientWidth });
      rsiChart.applyOptions({ width: rsiBox.clientWidth });
    }).observe(shell);
  }
})();
</script>

<script>
(function(){
  var INR = function(n){ return typeof n==='number' ? '₹'+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; };
  var SIGNED = function(n){ return (n>=0?'+':'-') + '₹' + Math.abs(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  var PNL_COLOR = function(n){ return (n||0)>=0 ? '#10b981' : '#ef4444'; };
  var _hadPosition = ${pos ? "true" : "false"};
  var _tradeCount  = ${state.sessionTrades.length};
  var _logCount    = ${state.log.length};
  var _running     = ${state.running};
  var _startCap    = ${startCap};
  var _interval    = null;

  function setText(id, val){ var el=document.getElementById(id); if(el && el.textContent !== String(val)) el.textContent = String(val); }

  function renderTrades(trades){
    var box  = document.getElementById('rps-trades-box');
    var hint = document.getElementById('rps-trades-hint');
    if (hint) hint.textContent = trades.length + ' trade' + (trades.length===1?'':'s');
    if (!box) return;
    if (!trades.length) {
      box.style.cssText = 'background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:24px;text-align:center;color:var(--muted-1,#8ba1c2);font-size:0.82rem;';
      box.innerHTML = 'No trades yet';
      return;
    }
    box.style.cssText = 'background:#0d1320;border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;';
    var rows = trades.slice().reverse().map(function(t){
      var pc = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
      var sc = t.side === 'CE' ? '#10b981' : '#ef4444';
      return '<tr style="border-top:1px solid #1a2236;">' +
        '<td style="padding:8px 12px;font-size:0.7rem;color:#94a3b8;">' + (t.entryTime||'') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.7rem;color:#94a3b8;">' + (t.exitTime||'') + '</td>' +
        '<td style="padding:8px 12px;color:' + sc + ';font-weight:800;">' + (t.side||'—') + '</td>' +
        '<td style="padding:8px 12px;">' + (t.optionStrike||'—') + '</td>' +
        '<td style="padding:8px 12px;">' + (t.signalRsi!=null?t.signalRsi:'—') + '</td>' +
        '<td style="padding:8px 12px;">' + (t.crossedLevel!=null?t.crossedLevel:'—') + '</td>' +
        '<td style="padding:8px 12px;font-weight:700;">' + (t.spotAtEntry!=null?t.spotAtEntry:'—') + '</td>' +
        '<td style="padding:8px 12px;font-weight:700;">' + (t.spotAtExit!=null?t.spotAtExit:'—') + '</td>' +
        '<td style="padding:8px 12px;color:#60a5fa;">' + (t.optionEntryLtp!=null?'₹'+t.optionEntryLtp:'—') + '</td>' +
        '<td style="padding:8px 12px;color:#60a5fa;">' + (t.optionExitLtp!=null?'₹'+t.optionExitLtp:'—') + '</td>' +
        '<td style="padding:8px 12px;font-weight:800;color:' + pc + ';">' + (t.pnl!=null?SIGNED(t.pnl):'—') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.65rem;color:var(--muted-1,#8ba1c2);">' + (t.exitReason||'') + '</td>' +
      '</tr>';
    }).join('');
    box.innerHTML = '<table style="width:100%;border-collapse:collapse;font-family:monospace;font-size:0.78rem;">' +
      '<thead><tr style="background:#0a0f1c;">' +
        ['Entry Time','Exit Time','Side','Strike','RSI','Crossed','E.Spot','X.Spot','E.Opt','X.Opt','PnL','Exit Reason'].map(function(h){
          return '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);white-space:nowrap;">'+h+'</th>';
        }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function fetchAndUpdate(){
    try {
      var r = await fetch('/rsi-pivot-st-paper/status/data', { cache:'no-store' });
      if (!r.ok) return;
      var d = await r.json();

      var pnlEl = document.getElementById('ajax-session-pnl');
      if (pnlEl) { pnlEl.textContent = SIGNED(d.sessionPnl||0); pnlEl.style.color = PNL_COLOR(d.sessionPnl); var card = pnlEl.closest('.sc'); if (card) card.style.borderTopColor = PNL_COLOR(d.sessionPnl); }
      setText('ajax-trade-count', d.tradesTaken || 0);
      setText('ajax-wl', (d.wins||0) + 'W · ' + (d.losses||0) + 'L');
      var liveEl = document.getElementById('ajax-live-pnl');
      if (liveEl) { if (d.livePnl != null) { liveEl.textContent = SIGNED(d.livePnl); liveEl.style.color = PNL_COLOR(d.livePnl); } else { liveEl.textContent = '—'; liveEl.style.color = '#c8d8f0'; } }
      setText('ajax-live-pnl-sub', d.position ? 'unrealised' : 'no open position');
      setText('ajax-rsi', d.rsi != null ? d.rsi : '—');
      var stEl = document.getElementById('ajax-st');
      if (stEl) { stEl.textContent = d.superTrend != null ? (d.superTrend + ' ' + (d.superTrendTrend === 1 ? '▲' : '▼')) : '—'; stEl.style.color = d.superTrendTrend === 1 ? '#10b981' : d.superTrendTrend === -1 ? '#ef4444' : '#c8d8f0'; }
      setText('ajax-wr', d.winRate != null ? d.winRate + '%' : '—');
      setText('ajax-wr-sub', 'best ' + (d.bestTrade==null?'—':Math.round(d.bestTrade)) + ' / worst ' + (d.worstTrade==null?'—':Math.round(d.worstTrade)));

      if (d.entryCheck) {
        var w = d.entryCheck;
        var wEl = document.getElementById('ajax-warmup');
        if (wEl) { wEl.textContent = w.bars + ' / ' + w.minBars; wEl.style.color = w.warmup ? '#f59e0b' : '#10b981'; }
        var wSub = document.getElementById('ajax-warmup-sub');
        if (wSub) { wSub.textContent = w.warmup ? (w.readyAt ? 'eligible from ' + w.readyAt : 'waiting for bars') : 'closed bars — ready'; wSub.style.color = w.warmup ? '#f59e0b' : '#10b981'; }
        var head = document.getElementById('ajax-decision-head');
        var body = document.getElementById('ajax-decision-body');
        var wrap = document.getElementById('ajax-decision');
        if (head && body && wrap) {
          var st = !d.running ? {c:'#8ba1c2',bg:'#0d1320',bd:'#1a2236',h:'Session stopped'}
                 : w.warmup ? {c:'#f59e0b',bg:'#1c1400',bd:'#78350f',h:'Warming up'}
                 : w.signal !== 'NONE' ? {c:'#10b981',bg:'#071a12',bd:'#134e35',h:(w.side||'') + ' setup'}
                 : {c:'#8ba1c2',bg:'#0d1320',bd:'#1a2236',h:'No setup'};
          head.textContent = st.h; head.style.color = st.c;
          body.textContent = w.reason || '—';
          wrap.style.background = st.bg; wrap.style.borderColor = st.bd;
        }
      }

      var dlossHit = d.maxDailyLoss > 0 && (d.sessionPnl || 0) <= -d.maxDailyLoss;
      var dlEl = document.getElementById('ajax-daily-loss-val'); if (dlEl) { dlEl.style.color = dlossHit ? '#ef4444' : '#10b981'; }
      var dlSub = document.getElementById('ajax-daily-loss-sub'); if (dlSub) { dlSub.textContent = dlossHit ? 'KILLED — no entries' : 'Active'; dlSub.style.color = dlossHit ? '#ef4444' : '#10b981'; }
      setText('ajax-tick-count', (d.tickCount || 0).toLocaleString());
      setText('ajax-last-tick', d.lastTickPrice ? INR(d.lastTickPrice) : '—');

      var capEl = document.getElementById('ajax-current-capital'); if (capEl) { capEl.textContent = INR(d.capital); capEl.style.color = d.capital >= _startCap ? '#10b981' : '#ef4444'; }
      var atpEl = document.getElementById('ajax-alltime-pnl'); if (atpEl) { atpEl.textContent = SIGNED(d.totalPnl||0); atpEl.style.color = PNL_COLOR(d.totalPnl); }

      if (d.currentBar) { ['open','high','low','close'].forEach(function(k){ var el = document.getElementById('ajax-bar-' + k); if (el) el.textContent = INR(d.currentBar[k]); }); }

      // Opening or closing a position rewrites a whole server-rendered block —
      // cheaper and less error-prone to reload than to rebuild it in the client.
      var hasPos = !!d.position;
      if (hasPos !== _hadPosition) { _hadPosition = hasPos; window.location.reload(); return; }
      if (d.position) {
        var p = d.position, cur = p.currentOptLtp;
        var move = cur != null ? (cur - p.optionEntryLtp) : null;
        var movePct = (cur != null && p.optionEntryLtp) ? (move / p.optionEntryLtp * 100) : null;
        var curEl = document.getElementById('ajax-opt-current-ltp'); if (curEl && cur != null) { curEl.textContent = '₹' + cur.toFixed(2); curEl.style.color = cur >= p.optionEntryLtp ? '#10b981' : '#ef4444'; }
        var movEl = document.getElementById('ajax-opt-move'); if (movEl && move != null) { movEl.textContent = (move >= 0 ? '▲ +' : '▼ ') + '₹' + Math.abs(move).toFixed(2); movEl.style.color = move >= 0 ? '#10b981' : '#ef4444'; }
        var pctEl = document.getElementById('ajax-opt-pct'); if (pctEl && movePct != null) { pctEl.textContent = (movePct >= 0 ? '+' : '') + movePct.toFixed(2) + '%'; pctEl.style.color = movePct >= 0 ? '#10b981' : '#ef4444'; }
        var oPnl = document.getElementById('ajax-opt-pnl'); if (oPnl && d.livePnl != null) { oPnl.textContent = SIGNED(d.livePnl); oPnl.style.color = PNL_COLOR(d.livePnl); }
        var ltpEl = document.getElementById('ajax-nifty-ltp'); if (ltpEl && d.lastTickPrice != null) ltpEl.textContent = INR(d.lastTickPrice);
        var movSub = document.getElementById('ajax-nifty-move');
        if (movSub && d.lastTickPrice != null && p.entrySpot) { var sm = (d.lastTickPrice - p.entrySpot) * (p.side === 'CE' ? 1 : -1); movSub.textContent = (sm >= 0 ? '▲' : '▼') + ' ' + Math.abs(sm).toFixed(1) + ' pts'; movSub.style.color = sm >= 0 ? '#10b981' : '#ef4444'; }
        var slEl = document.getElementById('ajax-sl-spot'); if (slEl && p.slSpot != null) slEl.textContent = '₹' + p.slSpot.toFixed(2);
        var pfEl = document.getElementById('ajax-prem-floor'); if (pfEl && p.premiumFloor != null) pfEl.textContent = '₹' + p.premiumFloor.toFixed(2);
        var pkEl = document.getElementById('ajax-peak-prem'); if (pkEl && p.peakPremium != null) pkEl.textContent = '₹' + p.peakPremium.toFixed(2);
      }

      if ((d.sessionTrades || []).length !== _tradeCount) { _tradeCount = (d.sessionTrades || []).length; renderTrades(d.sessionTrades || []); }
      if ((d.log || []).length !== _logCount) { _logCount = (d.log || []).length; LOG_ALL.length = 0; (d.log || []).slice().reverse().forEach(function(l){ LOG_ALL.push(l); }); if (typeof logFilter === 'function') logFilter(); }
      if (_running && !d.running) { _running = false; if (_interval) { clearInterval(_interval); _interval = null; } setTimeout(function(){ window.location.reload(); }, 1500); }
    } catch (e) { console.warn('[rsi-pivot-st-paper] refresh:', e.message); }
  }

  renderTrades(${tradesJSON});
  if (${state.running}) { _interval = setInterval(fetchAndUpdate, 2000); fetchAndUpdate(); }
  document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'visible' && ${state.running}) { fetchAndUpdate(); if (!_interval) _interval = setInterval(fetchAndUpdate, 2000); } });
  window.addEventListener('focus', function(){ if (${state.running}) fetchAndUpdate(); });
})();
</script>
</body></html>`);
});

// ── History + exports ────────────────────────────────────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  // renderHistoryPage's contract is routePrefix/sidebarKey/sessions/startCap —
  // passing any other key names renders a titleless page with zero sessions.
  res.send(renderHistoryPage({
    routePrefix: "/rsi-pivot-st-paper",
    sidebarKey: "rsiPivotStHistory",
    pageTitle: "🎯 RSI Pivot ST Paper Trade History",
    pageDocTitle: "RSI Pivot ST Paper — History",
    modalLabel: "RSI Pivot ST Paper",
    liveActive: sharedSocketState.getRsiPivotStMode() === "RSI_PIVOT_ST_LIVE",
    sessions: data.sessions || [],
    capital: data.capital,
    totalPnl: data.totalPnl,
    startCap: parseFloat(process.env.ZERODHA_INV_AMOUNT || process.env.FYERS_INV_AMOUNT || "100000"),
    emptyLabel: "Start RSI Pivot ST paper trading to record your first session.",
  }));
});

// The History page pages this itself: it expects { rows, total, page, ... } where
// each row is { date, skipsSize, tradesSize }. dailyFilesPaginate takes the ROWS
// and the query — handing it the mode key returns an empty list every time.
router.get("/download/daily-files", (req, res) => {
  try {
    const skips  = skipLogger.listDates(MODE_KEY);
    const trades = tradeLogger.listDailyDates(MODE_KEY);
    const byDate = new Map();
    for (const s of skips) byDate.set(s.date, { date: s.date, skipsSize: s.size, tradesSize: 0 });
    for (const t of trades) {
      const row = byDate.get(t.date) || { date: t.date, skipsSize: 0, tradesSize: 0 };
      row.tradesSize = t.size;
      byDate.set(t.date, row);
    }
    const rows = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
    res.json(dailyFilesPaginate(rows, req.query));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/download/skips-all", (req, res) => {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="rsi_pivot_st_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates(MODE_KEY).map(d => d.date).sort();
  let body = "";
  for (const d of dates) {
    try {
      const f = skipLogger.filePathFor(MODE_KEY, d);
      if (fs.existsSync(f)) body += fs.readFileSync(f, "utf8");
    } catch (_) {}
  }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  try {
    const rows = skipLogger.readDailySkips(MODE_KEY, req.params.date);
    if (!rows || !rows.length) return res.status(404).json({ error: "No skips for that date" });
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="rsi_pivot_st_skips_${req.params.date}.jsonl"`);
    res.send(rows.map(o => JSON.stringify(o)).join("\n"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/download/trades/:date", (req, res) => {
  try {
    const rows = tradeLogger.readDailyTrades(MODE_KEY, req.params.date);
    if (!rows || !rows.length) return res.status(404).json({ error: "No trades for that date" });
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="rsi_pivot_st_trades_${req.params.date}.jsonl"`);
    res.send(rows.map(o => JSON.stringify(o)).join("\n"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const _RPS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Served as raw JSONL, not as a JSON array: the History page reads these with
// response.text() and pastes the lines straight into the copy buffer.
router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_RPS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const f = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(f)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(f);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_RPS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const f = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(f)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(f);
});

router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop the session first." });
  try {
    const data = loadData();
    const idx = parseInt(req.params.index, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= (data.sessions || []).length) {
      return res.status(400).json({ success: false, error: "Bad session index" });
    }
    const removed = data.sessions.splice(idx, 1)[0];
    data.totalPnl = parseFloat((data.sessions.reduce((s, x) => s + (x.pnl || 0), 0)).toFixed(2));
    data.capital  = parseFloat((parseFloat(process.env.ZERODHA_INV_AMOUNT || process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
    saveData(data);
    res.json({ success: true, removed: removed ? (removed.trades || []).length : 0 });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post("/restore-session/:date", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop the session first." });
  try {
    const date = req.params.date;
    const rows = tradeLogger.readDailyTrades(MODE_KEY, date).filter(t => t && !t.type);
    if (!rows.length) return res.status(404).json({ success: false, error: "No trades in that day file" });
    const data = loadData();
    const keyOf = (t) => String(t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`);
    const seen = new Set();
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) seen.add(keyOf(t));
    const missing = rows.filter(t => !seen.has(keyOf(t)));
    if (!missing.length) return res.json({ success: true, restored: 0, message: "Already present" });
    const pnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
    data.sessions.push({ date, strategy: rsiPivotStrategy.NAME, pnl, trades: missing, restored: true });
    data.totalPnl = parseFloat((data.sessions.reduce((s, x) => s + (x.pnl || 0), 0)).toFixed(2));
    data.capital  = parseFloat((parseFloat(process.env.ZERODHA_INV_AMOUNT || process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
    saveData(data);
    res.json({ success: true, restored: missing.length, pnl });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).send(_errorPage("Cannot Reset", "Stop the session first.", "/rsi-pivot-st-paper/status", "← Back"));
  const init = { capital: parseFloat(process.env.ZERODHA_INV_AMOUNT || process.env.FYERS_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
  saveData(init);
  state = _freshState();
  res.redirect("/rsi-pivot-st-paper/history");
});

router.get("/download/trades.jsonl", (req, res) => {
  try {
    const data = loadData();
    const rows = [];
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) rows.push(t);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="rsi_pivot_st_paper_trades.jsonl"`);
    res.send(rows.map(o => JSON.stringify(aiExport.shapeTrade ? aiExport.shapeTrade(o) : o)).join("\n"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function _errorPage(title, message, backHref, backLabel) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>${faviconLink()}<style>${sidebarCSS()}${bbRsiStyleCSS()}
.err{max-width:560px;margin:60px auto;background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:28px;text-align:center}
.err h1{margin:0 0 12px;font-size:20px;color:#f87171}.err p{color:#94a3b8;line-height:1.6}
.err a{display:inline-block;margin-top:18px;background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none}
</style></head><body><div class="err"><h1>${title}</h1><p>${message}</p>
<a href="${backHref}">${backLabel}</a></div></body></html>`;
}

// Exported for the live harness (it drives this router programmatically) and for
// app.js's graceful shutdown, which looks up `stopSession` by that exact name on
// the router object and awaits it.
router._getState = () => state;
router.stopSession = stopSession;

module.exports = router;

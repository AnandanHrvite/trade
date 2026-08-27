/**
 * HA SCALP PAPER — /ha-scalp-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL surface. Every decision / fill / exit semantic for HA_SCALP lives
 * here; the backtest and the live harness must match THIS, never the reverse
 * (see feedback_paper_logic_untouchable).
 *
 * The day in one paragraph: the engine builds HEIKIN ASHI candles from closed
 * 15-minute NIFTY SPOT bars and watches two things — which side of the 50 MA
 * the raw close sits on, and whether the newest HA candle is a "no wick"
 * strength candle in that same direction. Above the MA it will only ever buy a
 * CE, and only on a BULLISH HA candle with no bottom wick. Below the MA it will
 * only ever buy a PE, and only on a BEARISH HA candle with no top wick. The
 * stop is that signal candle's own RAW high or low. The trade is then held
 * until the stop, a doji, a weak candle, or the square-off.
 *
 * ONE INSTRUMENT: NIFTY 50 INDEX. Every decision, level and exit is a spot
 * level read from closed 15-minute bars off the Fyers HISTORY endpoint — the
 * same endpoint the backtest and replay read, which is what makes the four
 * modes agree. The shared spot WebSocket supplies the live price used to test
 * the already-frozen stop, plus this session's heartbeat and tick count.
 *
 * HEIKIN ASHI vs RAW — the distinction that matters:
 *   • DECISIONS (colour, wick, doji, weak) read the HEIKIN ASHI candle.
 *   • PRICES (entry reference, stop level) read the RAW candle.
 * An HA price is an average of four numbers; nothing ever traded there. Mixing
 * the two invents fills that could not have happened.
 *
 * Exits, in the order they are tested:
 *   1. stop  — the signal candle's frozen RAW high/low. Tested on every tick.
 *   2. doji  — an HA candle whose body is tiny. Tested on each 15-min close.
 *   3. weak  — an HA candle that turned the opposite colour, or whose body
 *              shrank below the weak threshold. Tested on each 15-min close.
 *   4. EOD square-off at HA_SCALP_FORCED_EXIT
 * There is deliberately NO target, NO trail, NO breakeven jump, NO time stop,
 * NO premium stop and NO partial booking. The user asked for a stop and two
 * candle-based exits, and that is exactly what runs.
 *
 * Day-level breakers: HA_SCALP_MAX_DAILY_TRADES, HA_SCALP_MAX_DAILY_LOSS,
 * HA_SCALP_DAILY_PROFIT_LOCK and HA_SCALP_MAX_DAILY_LOSSES stop-outs.
 *
 * Signal engine: src/strategies/ha_scalp.js (shared by paper, backtest, live
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

const haStrategy        = require("../strategies/ha_scalp");
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
const CALLBACK_ID        = "haScalpPaper";
const MODE_KEY           = "ha_scalp";     // tradeLogger / skipLogger key

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "ha_scalp_paper_trades.json");

// There is no contract to roll: the NIFTY 50 INDEX symbol is a constant, and it
// is both the strike reference and the instrument every level is measured on.

// ── Config readers (Settings mutates process.env live — never cache) ──────────
function _resMin() { return haStrategy.getConfig().resolutionMins; }
function _parseMins(envKey, fallback) {
  return haStrategy._parseHHMM(process.env[envKey], haStrategy._parseHHMM(fallback, 0));
}
function _envStr(key, fallback) { return String(process.env[key] || fallback); }
function _maxDailyTrades()  { return Math.max(1, parseInt(process.env.HA_SCALP_MAX_DAILY_TRADES || "3", 10) || 3); }
function _maxDailyLosses()  { return Math.max(0, parseInt(process.env.HA_SCALP_MAX_DAILY_LOSSES || "2", 10)); }
function _maxDailyLoss()    { return parseFloat(process.env.HA_SCALP_MAX_DAILY_LOSS    || "3000"); }
function _dailyProfitLock() { return parseFloat(process.env.HA_SCALP_DAILY_PROFIT_LOCK || "0"); }
function _maxWeeklyLoss()   { return parseFloat(process.env.HA_SCALP_MAX_WEEKLY_LOSS   || "0"); }
function _pollMs() {
  const v = parseInt(process.env.HA_SCALP_POLL_MS || "2000", 10);
  return Number.isFinite(v) && v >= 500 && v <= 30000 ? v : 2000;
}
/**
 * How long after a bar closes before the Fyers history endpoint is asked for it.
 * Fetching the instant the clock ticks over often returns the bar still one
 * short, which would silently delay every decision by a whole bar.
 */
/**
 * How many CALENDAR days of history to preload. Must cover enough TRADING
 * sessions for the 50 MA plus the HA warm-up: at 25 bars a session, 51 bars is
 * ~3 sessions, and 15 calendar days survives a long holiday stretch.
 */
function _warmupDays() {
  const v = parseInt(process.env.HA_SCALP_WARMUP_DAYS || "15", 10);
  return Number.isFinite(v) && v >= 3 && v <= 120 ? v : 15;
}

function _historyLagMs() {
  const v = parseInt(process.env.HA_SCALP_HISTORY_LAG_MS || "5000", 10);
  return Number.isFinite(v) && v >= 0 && v <= 60000 ? v : 5000;
}

/**
 * Position size. HA_SCALP_LOT_MULTIPLIER (when > 0) overrides the global
 * LOT_MULTIPLIER for this strategy only, clamped by the same MAX_LOT_MULTIPLIER
 * ceiling. Divides by the multiplier getLotQty ACTUALLY applied (it clamps
 * internally), not the raw env value. Default 0 = use the common setting, which
 * is what "use common settings for size" asks for.
 */
function haLotQty() {
  const base = instrumentConfig.getLotQty();
  const raw  = parseInt(process.env.HA_SCALP_LOT_MULTIPLIER || "0", 10);
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
    console.error("[ha-scalp-paper] ha_scalp_paper_trades.json corrupt — resetting:", e.message);
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
    // SPOT bars — the decision series. Closed bars only.
    candles:        [],
    lastClosedBarTime: null,
    formingBar:     null,   // display-only: the bar being built from live ticks
    tickCount:      0,
    lastTickTime:   null,
    lastTickPrice:  null,   // NIFTY 50 INDEX spot — what the stop is measured against
    position:       null,
    optionLtp:      null,
    optionLtpUpdatedAt: null,
    log:            [],
    _sessionId:     null,
    // HA_SCALP specific
    lastSignal:     null,
    ha:             [],     // Heikin Ashi series, index-aligned to state.candles
    ma:             [],     // trend MA series, index-aligned to state.candles
    lastHa:         null,   // newest closed HA candle, for the UI
    lastMa:         null,
    lastTrend:      null,
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
    console.log(`♻️ [HA-SCALP-PAPER] Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl}, ${state.stopOuts} stop-out(s))`);
  } catch (err) {
    console.warn(`[HA-SCALP-PAPER] session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => state, "[HA-SCALP-PAPER]");

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

// ── Spot quote poll — the live price every exit is measured against ────────
// This runs for the WHOLE session, not only while a position is open: it also
// supplies the forming spot bar for the chart and the clock that triggers the
// history refresh. The option LTP rides in the SAME request when a position is
// open, so holding a trade costs no extra API call.
let _pollTimer = null;
let _pollStopped = true;

/**
 * Pull the OPTION premium out of a getQuotes response.
 *
 * Attribution is STRICTLY by symbol — never "whatever is left over". Some Fyers
 * response shapes omit the symbol on a row, and an else-branch would then write
 * some other instrument's price into the option premium, which is the number
 * every P&L is computed from. An unidentifiable row is dropped instead, except
 * when a single-symbol request came back with a single row, where there is
 * nothing to confuse it with.
 *
 * Exported for the offline test harness — this decides the premium every trade
 * is marked against, so it is tested rather than trusted.
 */
function attributeQuotes(resp, symbols, optSym) {
  const out = { optLtp: null };
  if (!resp || resp.s !== "ok" || !Array.isArray(resp.d)) return out;
  for (const row of resp.d) {
    const v = (row && row.v) || {};
    const ltp = v.lp || v.ltp;   // same idiom as every other quote reader in the repo
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
    // The OPTION premium is the only thing polled. NIFTY spot — the instrument
    // every level is measured on — arrives on the shared tick feed, so there is
    // nothing to fetch for it and no second symbol to confuse the attribution.
    try {
      const optSym = state.position ? state.position.symbol : null;
      if (optSym) {
        const symbols = [optSym];
        const r = await fyers.getQuotes(symbols);
        const q = attributeQuotes(r, symbols, optSym);
        if (q.optLtp != null) {
          state.optionLtp = q.optLtp;
          state.optionLtpUpdatedAt = Date.now();
          try { tickRecorder.recordOptionLtp(optSym, q.optLtp, "ha-scalp-paper"); } catch (_) {}
        }
      }
    } catch (_) {}

    // Exits first (a stop must not wait on a history round-trip), then
    // the bar-close work.
    try { if (state.position) _checkExits(state.lastTickPrice); } catch (e) { console.error(`🚨 [HA-SCALP-PAPER] exit-check error: ${e.message}`); }
    try { _enforceEod(); } catch (e) { console.error(`🚨 [HA-SCALP-PAPER] eod error: ${e.message}`); }
    _maybeRefreshHistory().catch(e => console.error(`🚨 [HA-SCALP-PAPER] history refresh error: ${e.message}`));
    if (!state.position && state._pendingEntry) {
      _retryPendingEntry().catch(e => console.error(`🚨 [HA-SCALP-PAPER] entry-retry error: ${e.message}`));
    }

    if (!_pollStopped) _pollTimer = setTimeout(poll, _pollMs());
  };
  _pollTimer = setTimeout(poll, 250);
}

function stopPolling() {
  _pollStopped = true;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

/** Display-only forming spot bar, built from the quote poll. */
function _updateFormingBar(price) {
  const bucketSec = Math.floor(getBucketStart(Date.now(), _resMin()) / 1000);
  if (!state.formingBar || state.formingBar.time !== bucketSec) {
    state.formingBar = { time: bucketSec, open: price, high: price, low: price, close: price, volume: 0 };
    return;
  }
  state.formingBar.high  = Math.max(state.formingBar.high, price);
  state.formingBar.low   = Math.min(state.formingBar.low, price);
  state.formingBar.close = price;
}

// ── Spot history — the ONLY source of the closed bars decisions read ───────
/**
 * Fetch today's closed spot bars once per bar, a short lag after the bar
 * closes. Everything the engine reads comes from here, which is precisely why
 * Paper, Backtest and Replay agree: they all read the same endpoint.
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
    // A throw must count as a failure too. Without this branch a rejecting
    // fetch left _histFailures at 0, so the operator never saw the warning.
    _noteHistoryFailure(e && e.message);
  } finally {
    state._histInFlight = false;
  }
}

/**
 * Record a failed history fetch and back off. The poll runs every
 * HA_SCALP_POLL_MS (2s by default) and the bucket guard only advances on
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
    log(`⚠️ [HA-SCALP-PAPER] Spot history unavailable ${state._histFailures}× ${why ? `(${why}) ` : ""}Retrying in ${Math.round(backoffMs / 1000)}s.`);
  }
}

/** Today's spot bars at the strategy resolution. Uncached — today is live. */
async function _fetchSpotToday() {
  const { fetchCandles } = require("../services/backtestEngine");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return fetchCandles(NIFTY_INDEX_SYMBOL, String(_resMin()), today, today);
}

/**
 * Enough history to establish the 50 MA and the Heikin Ashi chain, ending
 * today. Reaches back HA_SCALP_WARMUP_DAYS calendar days — the default 15 gives
 * roughly 10 trading sessions, ~250 fifteen-minute bars, comfortably more than
 * the ~51 the engine needs even after holidays.
 */
async function _fetchWarmupBars() {
  const { fetchCandles } = require("../services/backtestEngine");
  const days = _warmupDays();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const from = new Date(Date.now() - days * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return fetchCandles(NIFTY_INDEX_SYMBOL, String(_resMin()), from, today);
}

/**
 * Rebuild the Heikin Ashi and MA series from state.candles.
 *
 * Done ONCE per bar-set change, then handed to both the engine and the chart —
 * so the candle the decision read is provably the candle the page draws. The HA
 * chain is recursive, so it is rebuilt whole rather than appended to: a merge
 * that corrected an earlier bar would otherwise leave every later HA candle
 * computed from the superseded value.
 */
function _recomputeSeries() {
  try {
    const cfg = haStrategy.getConfig();
    state.ha = haStrategy.toHeikinAshi(state.candles, { cfg });
    state.ma = haStrategy.computeMA(state.candles, { cfg });
    const lastHa = state.ha.length ? state.ha[state.ha.length - 1] : null;
    const lastMa = state.ma.length ? state.ma[state.ma.length - 1] : null;
    const lastRaw = state.candles.length ? state.candles[state.candles.length - 1] : null;
    state.lastHa = lastHa;
    state.lastMa = lastMa;
    state.lastTrend = (lastRaw && typeof lastMa === "number")
      ? (lastRaw.close > lastMa ? "UP" : lastRaw.close < lastMa ? "DOWN" : "FLAT")
      : null;
  } catch (e) {
    console.error(`🚨 [HA-SCALP-PAPER] series recompute error: ${e.message}`);
  }
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
  _recomputeSeries();

  if (!fresh.length) return;
  const newest = fresh[fresh.length - 1];
  state.lastClosedBarTime = newest.time;
  // Fire ONCE, for the newest bar only. evaluateEntry always reads the LAST
  // element of state.candles, so replaying older bars would re-evaluate the same
  // series N times — normally harmless, but if history only starts answering
  // mid-session (a token restored at 13:00) `fresh` is the whole day and this
  // would be ~100 identical evaluations in one tick of the poll loop.
  try { onCandleClose(newest); }
  catch (e) { console.error(`🚨 [HA-SCALP-PAPER] onCandleClose error: ${e.message}`); }
}

// ── Trade simulation ─────────────────────────────────────────────────────────
async function simulateBuy(side, sig) {
  // One instrument: the NIFTY 50 INDEX. It picks the strike AND it is the
  // price every level of this strategy is measured on.
  const spotPrice = state.lastTickPrice;
  if (!side) return;
  if (typeof spotPrice !== "number" || !(spotPrice > 0)) {
    log(`⚠️ [HA-SCALP-PAPER] No NIFTY spot price yet — entry deferred`);
    return;
  }
  const indexSpot = spotPrice;

  let optInfo;
  try {
    optInfo = await instrumentConfig.validateAndGetOptionSymbol(indexSpot, side, "HA_SCALP");
  } catch (e) {
    log(`❌ [HA-SCALP-PAPER] Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ [HA-SCALP-PAPER] No valid expiry — skip ${side} entry`);
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
        try { tickRecorder.recordOptionLtp(optInfo.symbol, ltp, "ha-scalp-paper"); } catch (_) {}
      }
    }
  } catch (e) {
    log(`⚠️ [HA-SCALP-PAPER] Option LTP fetch failed: ${e.message} — entry blocked`);
    return;
  }
  if (!optionEntryLtp) {
    log(`❌ [HA-SCALP-PAPER] Option LTP not available — entry skipped`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "option_ltp", reason: "no option LTP", symbol: optInfo.symbol, side, spot: indexSpot });
    return;
  }

  // The stop is a LEVEL the engine read off the signal candle's RAW low/high.
  // It is NOT re-anchored to the fill: the rule says "SL is the previous
  // candle's high/low", and re-anchoring would move it off that candle. A fill
  // that slips simply changes the risk in points, and that is what gets logged.
  //
  // There is no target. The trade is closed by the stop, a doji, a weak candle
  // or the square-off — never by a price objective.
  const slSpot = sig.slSpot;
  if (!Number.isFinite(slSpot)) {
    log(`🚫 [HA-SCALP-PAPER] Entry ABORTED — stop level (${slSpot}) unusable. Refusing to enter without one.`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "levels_uncomputable", reason: `stop ${slSpot} unusable`, side, spot: spotPrice });
    return;
  }
  // The fill may have already run past the stop while the quote round-tripped.
  if (haStrategy.stopHit(side, spotPrice, slSpot)) {
    log(`🚫 [HA-SCALP-PAPER] Entry ABORTED — spot ${spotPrice} is already through the stop ${slSpot}`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "fill_past_stop", reason: `spot ${spotPrice} already beyond stop ${slSpot}`, side, spot: spotPrice });
    return;
  }

  const qty = haLotQty();
  const slPts = parseFloat(Math.abs(slSpot - spotPrice).toFixed(2));

  // Capital check — advisory only: an overdrawn pool raises a dashboard alert,
  // it never stops a paper trade. Sits AFTER the last abort path.
  const _cap = capitalPool.check(MODE_KEY, qty * optionEntryLtp);
  if (!_cap.ok) {
    log(`⚠️ [HA-SCALP-PAPER] ${_cap.reason} — entry taken anyway, pool now overdrawn`);
    capitalPool.noteShortfall(MODE_KEY, _cap, { side, symbol: optInfo.symbol });
  }

  const pos = {
    side,
    symbol:         optInfo.symbol,
    optionStrike:   optInfo.strike,
    optionExpiry:   optInfo.expiry,
    qty,
    // "spot" for this engine means the SPOT price — that is the instrument
    // every level is measured on. The index is recorded alongside it.
    entrySpot:      spotPrice,
    entryPrice:     spotPrice,
    indexAtEntry:   indexSpot,
    spotSymbol:  NIFTY_INDEX_SYMBOL,
    optionEntryLtp,
    entryTime:      istNow(),
    entryTimeMs:    Date.now(),
    entryUnixSec:   Math.floor(Date.now() / 1000),
    entryBarTime:   Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    slSpot,
    initialSlSpot:  slSpot,
    slPts,
    riskPts:        slPts,
    // Signal context (kept on the trade record for analytics / reports)
    signalSpot:     sig.entrySpot,
    signalSlPts:    sig.slPts,
    signalBarTime:  sig.signalBarTime,
    trend:          sig.trend,
    ma:             sig.ma,
    maType:         sig.maType,
    haOpen:         sig.haOpen,
    haHigh:         sig.haHigh,
    haLow:          sig.haLow,
    haClose:        sig.haClose,
    bodyPct:        sig.bodyPct,
    upperWickPct:   sig.upperWickPct,
    lowerWickPct:   sig.lowerWickPct,
    signalRawHigh:  sig.rawHigh,
    signalRawLow:   sig.rawLow,
    peakPremium:    optionEntryLtp,
    signalStrength: sig.signalStrength,
    mfeSpotPts:     0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
    entryReason:    sig.reason,
  };

  state.position = pos;
  capitalPool.block(MODE_KEY, qty * optionEntryLtp, { side, symbol: optInfo.symbol, qty, premium: optionEntryLtp });
  try { require("../utils/positionPersist").saveHaScalpPosition(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  state.optionLtp = optionEntryLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;

  log(`🟢 [HA-SCALP-PAPER] BUY_${side} ${optInfo.symbol} qty=${qty} @ spot=${spotPrice} (index ${indexSpot}) optLtp=₹${optionEntryLtp}`);
  log(`   ├─ Trend  : ${pos.trend} — raw close ${sig.rawClose} is ${side === "CE" ? "ABOVE" : "BELOW"} the ${sig.cfg.maPeriod} ${String(pos.maType).toUpperCase()} at ${pos.ma}`);
  log(`   ├─ Candle : ${side === "CE" ? "BULLISH" : "BEARISH"} Heikin Ashi, NO ${side === "CE" ? "BOTTOM" : "TOP"} WICK (${side === "CE" ? pos.lowerWickPct : pos.upperWickPct}% of range) · body ${pos.bodyPct}% · HA ${pos.haOpen} → ${pos.haClose}`);
  log(`   ├─ Stop   : ${slSpot} = the signal candle's RAW ${side === "CE" ? "LOW" : "HIGH"} (${slPts}pt away). It never moves.`);
  log(`   └─ Exits  : stop · doji candle · weak candle · EOD ${_envStr("HA_SCALP_FORCED_EXIT", "15:15")} — there is no target`);

  notifyEntry({
    mode: "HA-SCALP-PAPER",
    side, symbol: optInfo.symbol,
    spotAtEntry: spotPrice, optionEntryLtp,
    qty, stopLoss: slSpot, target: null,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "ha-scalp-paper",
      sessionId: state._sessionId,
      ts: Date.now(),
      side, symbol: optInfo.symbol, qty,
      spotEntry: spotPrice, optionEntry: optionEntryLtp,
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
  const charges    = getCharges({ broker: "fyers", isSpot: false, entryPremium: pos.optionEntryLtp, exitPremium: exitOptLtp, qty });
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
    spotSymbol:  pos.spotSymbol,
    optionEntryLtp: pos.optionEntryLtp,
    optionExitLtp:  exitOptLtp,
    bestOptionLtp:  pos.peakPremium || null,
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    entryBarTime:   pos.entryBarTime,
    exitBarTime:    Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    pnl,
    pnlMode:        `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp} (levels measured on NIFTY 50 spot)`,
    exitReason:     reason,
    entryReason:    pos.entryReason,
    stopLoss:       pos.slSpot,
    initialStopLoss: pos.initialSlSpot,
    target:         null,
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    optionType:     pos.side,
    optionEntrySymbol: pos.symbol,
    signalStrength: pos.signalStrength,
    riskPts:        pos.riskPts,
    // HA_SCALP signal context
    trend:          pos.trend,
    ma:             pos.ma,
    maType:         pos.maType,
    haOpen:         pos.haOpen,
    haHigh:         pos.haHigh,
    haLow:          pos.haLow,
    haClose:        pos.haClose,
    bodyPct:        pos.bodyPct,
    upperWickPct:   pos.upperWickPct,
    lowerWickPct:   pos.lowerWickPct,
    signalRawHigh:  pos.signalRawHigh,
    signalRawLow:   pos.signalRawLow,
    signalBarTime:  pos.signalBarTime,
    mfeSpotPts:     pos.mfeSpotPts || 0,
    mfePnl:         pos.mfePnl || 0,
    maeSpotPts:     pos.maeSpotPts || 0,
    maePnl:         pos.maePnl || 0,
    secsToMFE:      pos.secsToMFE || 0,
    secsToMAE:      pos.secsToMAE || 0,
    durationMs:     Date.now() - pos.entryTimeMs,
    charges,
    isSpot:      false,
    instrument:     "NIFTY_OPTIONS",
  };
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog(MODE_KEY, trade);

  log(`🔴 [HA-SCALP-PAPER] EXIT ${pos.side} ${pos.symbol} @ optLtp=₹${exitOptLtp} spot=${exitSpot} | PnL=₹${pnl} (${reason})`);

  notifyExit({
    mode: "HA-SCALP-PAPER",
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
      mode: "ha-scalp-paper", sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitOptLtp, pnl, reason,
    });
  } catch (_) {}

  state.position = null;
  capitalPool.release(MODE_KEY, pnl);
  try { require("../utils/positionPersist").clearHaScalpPosition(); } catch (_) {}
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
  log(`⏸️ [HA-SCALP-PAPER] ${reason} — no more entries today`);
  skipLogger.appendSkipLog(MODE_KEY, { gate: "day_closed", reason, sessionPnl: state.sessionPnl, spot: state.lastTickPrice });
}

// ── Exits ────────────────────────────────────────────────────────────────────
// The STOP is the only per-tick exit — it is a frozen spot level, so it can be
// tested on every tick. The doji and weak-candle exits are candle-close events
// and live in onCandleClose instead; testing them per tick would read a candle
// that has not finished forming and would exit on a shape that never existed.
// The level is guarded with Number.isFinite before it is compared: `price <= null`
// is `price <= 0`, which would square the trade off on its very first quote.
function _checkExits(spotPrice) {
  if (!state.position) return;
  if (typeof spotPrice !== "number" || !Number.isFinite(spotPrice) || spotPrice <= 0) return;
  const pos = state.position;
  const optLtp = state.optionLtp || pos.optionEntryLtp;

  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;
  const favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const curPnl = (optLtp - pos.optionEntryLtp) * pos.qty;
  if (favPts > (pos.mfeSpotPts || 0)) { pos.mfeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl > (pos.mfePnl     || 0)) pos.mfePnl = parseFloat(curPnl.toFixed(2));
  if (favPts < (pos.maeSpotPts || 0)) { pos.maeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl < (pos.maePnl     || 0)) pos.maePnl = parseFloat(curPnl.toFixed(2));

  // The only per-tick exit: the signal candle's own raw high/low was taken out.
  if (haStrategy.stopHit(pos.side, spotPrice, pos.slSpot)) {
    simulateSell(
      `Stop hit — spot ${spotPrice} took out the signal candle's ${pos.side === "CE" ? "low" : "high"} ${pos.slSpot} (${pos.riskPts}pt against)`,
      { isStopOut: true }
    );
  }
}

/**
 * The two CANDLE-CLOSE exits, evaluated once per closed 15-minute bar while a
 * position is open. Both come straight from the user's rules:
 *   • a DOJI warns of a reversal — get out.
 *   • a WEAK or opposite-coloured candle says the trend is fading — get out.
 * The engine owns both tests (haStrategy.exitSignal) so paper, backtest, live
 * and replay cannot drift apart.
 */
function _checkCandleExits() {
  const pos = state.position;
  if (!pos) return;
  const ha = state.ha.length ? state.ha[state.ha.length - 1] : null;
  if (!ha) return;
  // Never let the signal candle itself close the trade: the entry happens on
  // the bar AFTER it, so the position must survive at least one new bar.
  if (pos.signalBarTime != null && ha.time <= pos.signalBarTime) return;

  const ex = haStrategy.exitSignal(pos.side, ha, {});
  if (!ex) return;
  simulateSell(`${ex.label} — ${ex.detail}`);
}

function _enforceEod() {
  if (!state.position) return;
  if (getISTMinutes() >= _parseMins("HA_SCALP_FORCED_EXIT", "15:15")) {
    simulateSell(`EOD square-off (${_envStr("HA_SCALP_FORCED_EXIT", "15:15")} IST) — neither the stop nor a reversal candle closed it`);
  }
}

// ── Entry evaluation (on spot candle close — CLOSED bars only) ────────────
const ENTRY_RETRY_MS = 5000;

/**
 * A short machine-readable tag for WHY a setup was passed over, so the skip log
 * can be grouped and counted. The prose reason from the engine is logged too —
 * this is the column you filter on, not the sentence you read.
 */
function _skipGate(sig) {
  const r = String(sig.skipReason || sig.reason || "");
  if (/DOJI/.test(r))                 return "doji_no_entry";
  if (/against the trend/.test(r))    return "wrong_colour_for_trend";
  if (/wick of/.test(r))              return "has_wick";
  if (/body is only/.test(r))         return "body_too_small";
  if (/cap/.test(r))                  return "stop_too_wide";
  if (/exactly on the/.test(r))       return "price_on_ma";
  if (/stopped on its first tick/.test(r)) return "stop_already_through";
  if (/entry window|no new entries/.test(r)) return "outside_window";
  if (/budget/.test(r))               return "day_budget_spent";
  return "no_setup";
}

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
  // The HA and MA series are already computed for this bar set (see _mergeBars)
  // and are handed to the engine so the chart and the decision cannot disagree.
  const sig = haStrategy.getSignal(state.candles, {
    alreadyTraded: false, silent: true, ha: state.ha, ma: state.ma,
  });
  state.lastSignal = sig;

  if (sig.signal === "NONE" || !sig.side) {
    // Log every near-miss that had a real trend and a real candle to judge —
    // the whole point of this strategy's log is being able to see WHY a
    // good-looking candle was passed over. Warm-up and plain window rejections
    // are skipped: at 25 bars a day they would bury the file.
    if (!sig.warmup && sig.trend) {
      skipLogger.appendSkipLog(MODE_KEY, {
        gate: _skipGate(sig),
        reason: sig.skipReason || sig.reason,
        spot: state.lastTickPrice,
        trend: sig.trend, ma: sig.ma, maType: sig.maType,
        haOpen: sig.haOpen, haHigh: sig.haHigh, haLow: sig.haLow, haClose: sig.haClose,
        bodyPct: sig.bodyPct, upperWickPct: sig.upperWickPct, lowerWickPct: sig.lowerWickPct,
        rawClose: sig.rawClose, rawHigh: sig.rawHigh, rawLow: sig.rawLow,
        slPts: sig.slPts,
        barTime: sig.signalBarTime,
      });
    }
    return;
  }

  log(`🎯 [HA-SCALP-PAPER] SETUP: ${sig.reason}`);
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
      log(`⚠️ [HA-SCALP-PAPER] Entry attempt failed — retrying every ${ENTRY_RETRY_MS / 1000}s until this bar is superseded`);
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
 * stale setup can never fill minutes later off a candle the market has moved past.
 */
async function _retryPendingEntry() {
  const p = state._pendingEntry;
  if (!p) return;
  if (state.position || state._entryInFlight) return;
  if (state.dayClosed || state.tradesTaken >= _maxDailyTrades()) { state._pendingEntry = null; return; }
  if (getISTMinutes() >= _parseMins("HA_SCALP_FORCED_EXIT", "15:15")) { state._pendingEntry = null; return; }
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

// ── Spot candle close handler ─────────────────────────────────────────────
function onCandleClose(bar) {
  // A new bar supersedes any setup still waiting on a failed fill — the market
  // has moved on, and this bar's own evaluation is the current truth.
  state._pendingEntry = null;
  if (!bar || typeof bar.time !== "number") return;

  // A position OPEN at this bar's close is judged by the doji / weak-candle
  // rules first. If they close it, the same bar is then free to open a new
  // trade — which is exactly the user's "get ready for the new entry or exit
  // from the trade if already entered".
  if (state.position) {
    try { _checkCandleExits(); }
    catch (e) { console.error(`🚨 [HA-SCALP-PAPER] candle-exit error: ${e.message}`); }
    if (state.position) return;
  }

  const cfg = haStrategy.getConfig();
  const closeMins = haStrategy._utcSecToIstMins(bar.time) + cfg.resolutionMins;
  if (closeMins > cfg.entryEndMin) return;
  evaluateEntry().catch(e => console.error(`🚨 [HA-SCALP-PAPER] entry-eval error: ${e.message}`));
}

// ── onTick — the NIFTY 50 INDEX feed. ────────────────────────────────────────
// It drives NO ENTRY decision: every entry rule reads CLOSED 15-minute bars, so
// the tick can never pull an entry forward. What it does own is the STOP: the
// stop is a frozen spot level, this feed is the fastest source of spot, and
// waiting for the option poll would leave the stop unchecked for whole seconds.
function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (!price || price <= 0) return;

  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  // The forming bar is DISPLAY ONLY. No rule reads it: every decision waits for
  // the bar to close and to come back from the history endpoint, which is what
  // keeps Paper, Backtest and Replay in agreement.
  _updateFormingBar(price);

  // The stop is tested on every tick — it is a spot level, and this is spot.
  // _checkExits is idempotent and returns immediately when flat.
  try { if (state.position) _checkExits(price); }
  catch (e) { console.error(`🚨 [HA-SCALP-PAPER] tick exit-check error: ${e.message}`); }

  // EOD is enforced on the tick too, so a stalled option quote can never hold a
  // position past the square-off time.
  _enforceEod();
}

// ── Preload spot history ──────────────────────────────────────────────────
// Unlike a session-only strategy, HA_SCALP needs HISTORY: the 50 MA needs 50
// closed 15-minute bars and the Heikin Ashi chain needs its own warm-up on top.
// At 25 bars per session that is several days, so the preload reaches back
// HA_SCALP_WARMUP_DAYS calendar days rather than asking only for today.
async function preloadHistory() {
  try {
    const bars = await _fetchWarmupBars();
    if (Array.isArray(bars) && bars.length) {
      const resMin = _resMin();
      const nowBucketSec = Math.floor(getBucketStart(Date.now(), resMin) / 1000);
      state.candles = bars
        .filter(b => b && typeof b.time === "number" && b.time < nowBucketSec)
        .sort((a, b) => a.time - b.time)
        .slice(-400);
      state._histBucket = getBucketStart(Date.now(), resMin);
      state.lastClosedBarTime = state.candles.length ? state.candles[state.candles.length - 1].time : null;
      _recomputeSeries();

      const cfg = haStrategy.getConfig();
      const need = Math.max(cfg.maPeriod, cfg.haWarmupBars) + 1;
      log(`📊 [HA-SCALP-PAPER] Preloaded ${state.candles.length} closed ${resMin}-min ${NIFTY_INDEX_SYMBOL} candles (need ${need} before the first decision)`);
      if (state.candles.length < need) {
        log(`⏳ [HA-SCALP-PAPER] Still warming up — ${state.candles.length}/${need} candles. No entry can be taken until the ${cfg.maPeriod} ${cfg.maType.toUpperCase()} and the Heikin Ashi chain are both established.`);
      } else {
        log(`📈 [HA-SCALP-PAPER] Trend now ${state.lastTrend} — raw close ${state.candles[state.candles.length - 1].close} vs ${cfg.maPeriod} ${cfg.maType.toUpperCase()} ${state.lastMa}. ${state.lastTrend === "UP" ? "CE entries only." : state.lastTrend === "DOWN" ? "PE entries only." : "No side until price leaves the MA."}`);
      }
    } else {
      log(`📊 [HA-SCALP-PAPER] No spot history for ${NIFTY_INDEX_SYMBOL} — Fyers returned an empty series. If this persists the token is usually expired: every historical fetch then returns 0 candles.`);
    }
  } catch (e) {
    log(`⚠️ [HA-SCALP-PAPER] Spot preload failed: ${e.message}`);
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
  _autoStopTimer = setTimeout(() => { log(`⏰ [HA-SCALP-PAPER] Auto-stop @ ${raw} IST`); stopSession(); }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ────────────────────────────────────────────────────────
router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/ha-scalp-paper/status");

  if (String(process.env.HA_SCALP_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("HA Scalp Disabled", "Enable HA Scalp Mode in Settings first", "/settings", "Go to Settings"));
  }
  if (String(process.env.HA_SCALP_PAPER_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("HA Scalp Paper Disabled", "Enable HA Scalp Paper Trading in Settings first", "/settings", "Go to Settings"));
  }

  const check = sharedSocketState.canStart("HA_SCALP_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/ha-scalp-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/ha-scalp-paper/status", "← Back"));

  if (getISTMinutes() >= _parseMins("HA_SCALP_FORCED_EXIT", "15:15")) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${_envStr("HA_SCALP_FORCED_EXIT", "15:15")} IST — HA Scalp does not trade after this`, "/ha-scalp-paper/status", "← Back"));
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `ha-scalp-paper:${Date.now()}`;

  sharedSocketState.setHaScalpActive("HA_SCALP_PAPER");

  const cfg = haStrategy.getConfig();
  log(`🟢 [HA-SCALP-PAPER] Session started — ${haStrategy.NAME}`);
  log(`⚙️ [HA-SCALP-PAPER] Chart    : ${NIFTY_INDEX_SYMBOL} · HEIKIN ASHI ${cfg.resolutionMins}-min${cfg.haContinuous ? " (chain continuous across days, matching TradingView)" : " (chain reseeds each day)"}`);
  log(`⚙️ [HA-SCALP-PAPER] Trend    : ${cfg.maPeriod} ${cfg.maType.toUpperCase()} of RAW closes — above it CE only, below it PE only. Never against it.`);
  log(`⚙️ [HA-SCALP-PAPER] Entry    : ${cfg.maxWickPct === 0 ? "wick-free" : `≤${cfg.maxWickPct}%-wick`} HA candle in the trend's direction (bullish + no bottom wick = CE, bearish + no top wick = PE), body ≥${cfg.minBodyPts}pt`);
  log(`⚙️ [HA-SCALP-PAPER] Stop     : the signal candle's RAW ${"low (CE) / high (PE)"}${cfg.slBufferPts ? ` ±${cfg.slBufferPts}pt` : ""}${cfg.maxSlPts ? ` · rejected if wider than ${cfg.maxSlPts}pt` : ""} — frozen, never trailed`);
  log(`⚙️ [HA-SCALP-PAPER] Exits    : doji (body ≤${cfg.dojiBodyPct}% of range) ${cfg.exitOnDoji ? "ON" : "OFF"} · weak/opposite candle (body <${cfg.weakBodyPct}%) ${cfg.exitOnWeak ? "ON" : "OFF"} · NO target, NO trail`);
  log(`⚙️ [HA-SCALP-PAPER] Session  : entries ${_envStr("HA_SCALP_ENTRY_START", "09:30")}–${_envStr("HA_SCALP_ENTRY_END", "15:00")} · max ${_maxDailyTrades()} trade(s)/day · loss cap ₹${_maxDailyLoss()} · EOD ${_envStr("HA_SCALP_FORCED_EXIT", "15:15")} · qty ${haLotQty()}`);

  await preloadHistory();
  startPolling();

  try {
    tickRecorder.recordSessionStart({
      mode: "ha-scalp-paper",
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
    log("📡 [HA-SCALP-PAPER] Piggybacking on existing WebSocket (NIFTY 50 index — strike + heartbeat only)");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [HA-SCALP-PAPER] Started WebSocket (NIFTY 50 index — strike + heartbeat only)");
  }

  scheduleAutoStop();

  notifyStarted({
    mode: "HA-SCALP-PAPER",
    text: [
      `📄 HA SCALP PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${haStrategy.NAME}`,
      `Chart     : NIFTY 50 · Heikin Ashi ${cfg.resolutionMins}-min`,
      `Trend     : ${cfg.maPeriod} ${cfg.maType.toUpperCase()} — CE only above it, PE only below it`,
      `Setup     : ${cfg.maxWickPct === 0 ? "wick-free" : `≤${cfg.maxWickPct}%-wick`} HA strength candle in that direction, body ≥${cfg.minBodyPts}pt`,
      `Stop      : the signal candle's own raw high/low · no target`,
      `Exits     : doji · weak candle · EOD`,
      `Max trades: ${_maxDailyTrades()}/day · loss cap ₹${_maxDailyLoss()}`,
      `Square-off: ${_envStr("HA_SCALP_FORCED_EXIT", "15:15")} IST`,
    ].filter(Boolean).join("\n"),
  });

  res.redirect("/ha-scalp-paper/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped");
  state.running = false;
  stopPolling();

  try { tickRecorder.recordSessionStop({ mode: "ha-scalp-paper", sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  sharedSocketState.clearHaScalp();   // clear OWN mode first (else the socket never stops → leak)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: haStrategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
      saveData(data);
      log(`💾 [HA-SCALP-PAPER] Session saved — ${state.sessionTrades.length} trades, PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ [HA-SCALP-PAPER] Save failed: ${e.message}`);
    }
  }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  log(`📋 [HA-SCALP-PAPER] Day summary — ${state.sessionTrades.length} trade(s), ${wins}W/${state.sessionTrades.length - wins}L, net ₹${state.sessionPnl}, week ₹${weeklyPnl()}`);
  log("🔴 [HA-SCALP-PAPER] Session stopped");

  notifyDayReport({
    mode: "HA-SCALP-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/ha-scalp-paper/status"); });
router.get("/exit", (req, res) => { if (state.position) simulateSell("Manual exit"); res.redirect("/ha-scalp-paper/status"); });

// ── /status/chart-data — Heikin Ashi candles + MA + raw candles + stop ──────
router.get("/status/chart-data", (req, res) => {
  try {
    const cfg = haStrategy.getConfig();
    // The chart draws the HEIKIN ASHI candles, because those are the candles
    // every rule reads. The raw series is sent alongside so the page can show
    // where the stop actually sits — an HA low is not a traded price.
    const haCandles = [];
    const rawCandles = [];
    const maLine = [];
    for (let i = 0; i < state.candles.length; i++) {
      const raw = state.candles[i];
      const h = state.ha[i];
      const m = state.ma[i];
      if (raw) rawCandles.push({ time: raw.time, open: raw.open, high: raw.high, low: raw.low, close: raw.close });
      if (h)   haCandles.push({ time: h.time, open: h.open, high: h.high, low: h.low, close: h.close });
      if (typeof m === "number") maLine.push({ time: raw.time, value: m });
    }

    const markers = [];
    for (const t of state.sessionTrades) {
      if (t.entryBarTime) markers.push({ time: t.entryBarTime, position: t.side === "CE" ? "belowBar" : "aboveBar", color: t.side === "CE" ? "#10b981" : "#ef4444", shape: t.side === "CE" ? "arrowUp" : "arrowDown", text: `${t.side} ${t.entryPrice}` });
      if (t.exitBarTime)  markers.push({ time: t.exitBarTime,  position: t.side === "CE" ? "aboveBar" : "belowBar", color: (t.pnl || 0) >= 0 ? "#10b981" : "#ef4444", shape: "circle", text: `${(t.pnl || 0) >= 0 ? "+" : ""}${Math.round(t.pnl || 0)}` });
    }

    const pos = state.position;
    res.json({
      candles: haCandles, rawCandles, maLine, markers,
      entryPrice: pos ? pos.entrySpot : null,
      stopLoss:   pos ? pos.slSpot : null,
      target:     null,
      ma:         state.lastMa,
      maPeriod:   cfg.maPeriod,
      maType:     cfg.maType,
      trend:      state.lastTrend,
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
  const cfg = haStrategy.getConfig();

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * (pos.qty || haLotQty())).toFixed(2));
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
    candles: state.candles.length, currentBar: state.formingBar, sessionStart: state.sessionStart,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge,
    wins, losses, winRate, bestTrade, worstTrade, cumPnl, livePnl,
    weeklyPnl: weeklyPnl(),
    // HA_SCALP context
    spotSymbol: NIFTY_INDEX_SYMBOL, tickAgeSec: tickAge,
    spotCandles: state.candles.length,
    warmupNeeded: Math.max(cfg.maPeriod, cfg.haWarmupBars) + 1,
    ma: state.lastMa, maPeriod: cfg.maPeriod, maType: cfg.maType,
    trend: state.lastTrend,
    allowedSide: state.lastTrend === "UP" ? "CE" : state.lastTrend === "DOWN" ? "PE" : null,
    lastHa: state.lastHa ? {
      time: state.lastHa.time, open: state.lastHa.open, high: state.lastHa.high,
      low: state.lastHa.low, close: state.lastHa.close,
      bullish: state.lastHa.bullish, bearish: state.lastHa.bearish,
      body: state.lastHa.body, range: state.lastHa.range,
      upperWick: state.lastHa.upperWick, lowerWick: state.lastHa.lowerWick,
    } : null,
    lastBodyPct:      s ? s.bodyPct : null,
    lastUpperWickPct: s ? s.upperWickPct : null,
    lastLowerWickPct: s ? s.lowerWickPct : null,
    dayClosed: state.dayClosed, dayClosedReason: state.dayClosedReason,
    stopOuts: state.stopOuts, maxDailyLosses: _maxDailyLosses(),
    maxDailyTrades: _maxDailyTrades(),
    dailyProfitLock: _dailyProfitLock(), maxDailyLoss: _maxDailyLoss(),
    lastSkipReason: s && s.signal === "NONE" ? (s.skipReason || s.reason) : null,
    cfg: {
      resMin: cfg.resolutionMins, maPeriod: cfg.maPeriod, maType: cfg.maType,
      maxWickPct: cfg.maxWickPct, minBodyPts: cfg.minBodyPts,
      dojiBodyPct: cfg.dojiBodyPct, weakBodyPct: cfg.weakBodyPct,
      exitOnDoji: cfg.exitOnDoji, exitOnWeak: cfg.exitOnWeak,
      slBufferPts: cfg.slBufferPts, maxSlPts: cfg.maxSlPts,
      haContinuous: cfg.haContinuous, haWarmupBars: cfg.haWarmupBars,
      entryStart: _envStr("HA_SCALP_ENTRY_START", "09:30"), entryEnd: _envStr("HA_SCALP_ENTRY_END", "15:00"),
      forcedExit: _envStr("HA_SCALP_FORCED_EXIT", "15:15"),
    },
    position: pos ? {
      side: pos.side, symbol: pos.symbol, entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      slSpot: pos.slSpot, riskPts: pos.riskPts,
      trend: pos.trend, ma: pos.ma, bodyPct: pos.bodyPct,
      upperWickPct: pos.upperWickPct, lowerWickPct: pos.lowerWickPct,
      optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry,
      peakPremium: pos.peakPremium, entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      qty: pos.qty, currentOptLtp: state.optionLtp,
      heldSec: Math.round((Date.now() - pos.entryTimeMs) / 1000),
    } : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getHaScalpMode() === "HA_SCALP_LIVE";
  const data = loadData();
  const pos  = state.position;
  const cfg  = haStrategy.getConfig();

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  const maLabel = `${cfg.maPeriod} ${cfg.maType.toUpperCase()}`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>HA Scalp — Paper</title>${faviconLink()}
<style>${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.ha-card{background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;margin-bottom:18px;}
.ha-row{display:flex;gap:20px;flex-wrap:wrap;font-size:0.78rem;color:#e2e8f0;margin-top:8px;}
.ha-row .k{color:var(--muted-1,#8ba1c2);margin-right:5px;}
.ha-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.7rem;font-weight:600;letter-spacing:0.03em;}
.ha-up{background:rgba(16,185,129,0.15);color:#10b981;}
.ha-down{background:rgba(239,68,68,0.15);color:#ef4444;}
.ha-flat{background:rgba(148,163,184,0.15);color:#94a3b8;}
.brk{font-size:0.72rem;color:#f59e0b;margin-top:8px;}
.chart-box{background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;}
.rule-list{margin:8px 0 0;padding-left:18px;color:var(--muted-1,#8ba1c2);font-size:0.73rem;line-height:1.7;}
.rule-list b{color:#cbd5e1;font-weight:600;}
/* Mobile — iPhone 17 Pro Max portrait is ~440px. No horizontal scroll anywhere. */
@media (max-width: 640px) {
  .ha-row{gap:10px 14px;font-size:0.74rem;}
  .ha-card{padding:12px;border-radius:9px;}
  .chart-box{border-radius:9px;}
  .rule-list{font-size:0.71rem;padding-left:16px;}
}
</style>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
</head><body>
${buildSidebar('haScalpPaper', liveActive)}
<div class="main-content">
${bbRsiTopBar({
  title: "🕯 HA Scalp — Paper",
  metaLine: `NIFTY 50 · Heikin Ashi ${cfg.resolutionMins}m · ${maLabel} decides the side · no-wick strength candle enters · SL = that candle's raw high/low · doji or weak candle exits`,
  running: state.running,
  primaryAction: { href: "/ha-scalp-paper/start", label: "▶ Start", color: "#0369a1" },
  stopAction:    { href: "/ha-scalp-paper/stop",  label: "■ Stop" },
  historyHref: "/ha-scalp-paper/history",
})}

${bbRsiCapitalStrip({ starting: startCap, current: startCap + (data.totalPnl || 0), allTime: data.totalPnl || 0 })}

<div class="ha-card">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Right now — what the engine sees</div>
    <div style="font-size:0.8rem;color:#94a3b8;" id="spot-sym">NIFTY 50</div>
  </div>
  <div class="ha-row" id="ha-row"><div>Waiting for the first closed 15-minute candles…</div></div>
  <div id="ha-skip" style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-top:8px;"></div>
  ${state.dayClosed ? `<div class="brk">⏸️ ${state.dayClosedReason}</div>` : ""}
  <ul class="rule-list">
    <li><b>Above the ${maLabel} → CE only.</b> Below it → PE only. Never against it.</li>
    <li><b>Enter</b> on a ${cfg.maxWickPct === 0 ? "wick-free" : `≤${cfg.maxWickPct}%-wick`} Heikin Ashi candle in that direction — bullish with no bottom wick for a CE, bearish with no top wick for a PE. Body must be ≥ ${cfg.minBodyPts}pt.</li>
    <li><b>Stop</b> = that candle's own raw ${"low (CE) / high (PE)"}${cfg.slBufferPts ? ` ± ${cfg.slBufferPts}pt` : ""}. It never moves.</li>
    <li><b>Exit</b> on a doji (body ≤ ${cfg.dojiBodyPct}% of range), a weak or opposite-colour candle (body &lt; ${cfg.weakBodyPct}%), or the ${_envStr("HA_SCALP_FORCED_EXIT", "15:15")} square-off. There is no target.</li>
  </ul>
</div>

${bbRsiStatGrid([
  { label: "Session P&L", value: inr(state.sessionPnl), color: state.sessionPnl >= 0 ? "#10b981" : "#ef4444" },
  { label: "Trades", value: `${state.tradesTaken}/${_maxDailyTrades()}` },
  { label: "W / L", value: `${wins} / ${losses}` },
  { label: "Trend", value: state.lastTrend || "—" },
  { label: maLabel, value: state.lastMa != null ? String(state.lastMa) : "—" },
  { label: "Spot", value: state.lastTickPrice != null ? String(state.lastTickPrice) : "—" },
])}

${bbRsiCurrentBar({ bar: state.formingBar, resMin: cfg.resolutionMins })}

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">NIFTY 50 — HEIKIN ASHI ${cfg.resolutionMins}m (the decision chart) + ${maLabel}</div>
  <div class="chart-box" style="height:420px;">
    <div id="chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;">
      <span style="color:#3b82f6;">── ${maLabel} (the side gate)</span> &nbsp;<span style="color:#ef4444;">── Stop</span>
    </div>
  </div>
</div>

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">NIFTY 50 — RAW ${cfg.resolutionMins}m candles (where the stop actually sits — a Heikin Ashi price never traded)</div>
  <div class="chart-box" style="height:240px;"><div id="rawchart" style="width:100%;height:100%;"></div></div>
</div>

<div id="pos-card" style="margin-bottom:18px;">${_positionCardHtml(pos, state.optionLtp)}</div>

${bbRsiActivityLog({ logsJSON: JSON.stringify(state.log.slice(-200)) })}
</div>
<script>
${modalJS()}
async function haRefresh() {
  try {
    const r = await fetch('/ha-scalp-paper/status/data', { cache: 'no-store' });
    const d = await r.json();
    var row = document.getElementById('ha-row');
    if (row) {
      var cells = [];
      var tcls = d.trend === 'UP' ? 'ha-up' : d.trend === 'DOWN' ? 'ha-down' : 'ha-flat';
      cells.push('<div><span class="k">Trend</span><span class="ha-pill ' + tcls + '">' + (d.trend || '—') + '</span></div>');
      cells.push('<div><span class="k">Allowed side</span>' + (d.allowedSide || 'none') + '</div>');
      cells.push('<div><span class="k">' + (d.maPeriod || '') + ' ' + String(d.maType || '').toUpperCase() + '</span>' + (d.ma != null ? d.ma : '—') + '</div>');
      var h = d.lastHa;
      if (h) {
        cells.push('<div><span class="k">Last HA candle</span>' + (h.bullish ? 'bullish' : h.bearish ? 'bearish' : 'flat') + ' · body ' + (d.lastBodyPct != null ? d.lastBodyPct + '%' : '—') + '</div>');
        cells.push('<div><span class="k">Wicks</span>top ' + (d.lastUpperWickPct != null ? d.lastUpperWickPct + '%' : '—') + ' · bottom ' + (d.lastLowerWickPct != null ? d.lastLowerWickPct + '%' : '—') + '</div>');
      }
      cells.push('<div><span class="k">Candles</span>' + (d.spotCandles || 0) + (d.warmupNeeded && d.spotCandles < d.warmupNeeded ? ' / ' + d.warmupNeeded + ' (warming up)' : '') + '</div>');
      row.innerHTML = cells.join('');
    }
    var sk = document.getElementById('ha-skip');
    if (sk) sk.textContent = d.lastSkipReason || '';
    var fs = document.getElementById('spot-sym');
    if (fs) fs.textContent = 'NIFTY 50' + (d.lastTickPrice != null ? '  ·  ' + d.lastTickPrice : '');
  } catch (e) {}
}
haRefresh();
setInterval(haRefresh, 4000);
</script>
<script>
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var container = document.getElementById('chart');
  var rawc = document.getElementById('rawchart');
  if (!container) return;
  function mk(el) {
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
  var mas = chart.addLineSeries({ color:'#3b82f6', lineWidth:2, priceLineVisible:false, lastValueVisible:true });
  var rchart = rawc ? mk(rawc) : null;
  var rcs = rchart ? rchart.addCandlestickSeries({ upColor:'#334155', downColor:'#475569', borderUpColor:'#475569', borderDownColor:'#475569', wickUpColor:'#475569', wickDownColor:'#475569' }) : null;
  var lines = [], _zoomed = false;
  function addLine(price, color, title, style) {
    if (price == null || !isFinite(price)) return;
    lines.push(cs.createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title }));
  }
  async function fetchChart(){
    try {
      var r = await fetch('/ha-scalp-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        if (d.maLine && d.maLine.length) mas.setData(d.maLine);
        if (!_zoomed) { try {
          var lastT=d.candles[d.candles.length-1].time;
          var firstT=d.candles[Math.max(0, d.candles.length-80)].time;
          chart.timeScale().setVisibleRange({ from:firstT, to:lastT }); _zoomed=true;
        } catch(_){} }
      }
      if (rcs && d.rawCandles && d.rawCandles.length) rcs.setData(d.rawCandles);
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      lines.forEach(function(l){ try { cs.removePriceLine(l); } catch(_){} });
      lines = [];
      addLine(d.entryPrice, '#94a3b8', 'Entry', LightweightCharts.LineStyle.Dotted);
      addLine(d.stopLoss,   '#ef4444', 'Stop',  LightweightCharts.LineStyle.Solid);
    } catch(e) {}
  }
  fetchChart();
  setInterval(fetchChart, 4000);
  window.addEventListener('resize', function(){
    chart.applyOptions({ width: container.clientWidth });
    if (rchart && rawc) rchart.applyOptions({ width: rawc.clientWidth });
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
  const wickLabel = pos.side === "CE" ? "bottom" : "top";
  const wickPct = pos.side === "CE" ? pos.lowerWickPct : pos.upperWickPct;
  return `<div style="background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:8px;">Open position</div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:0.8rem;color:#e2e8f0;">
    <div><span style="color:var(--muted-1,#8ba1c2);">Side</span> ${pos.side}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Symbol</span> ${pos.symbol}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Entry (spot)</span> ${pos.entrySpot}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Stop</span> ${pos.slSpot} (${pos.riskPts}pt)</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Trend</span> ${pos.trend || "—"} vs MA ${pos.ma != null ? pos.ma : "—"}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Signal candle</span> body ${pos.bodyPct != null ? pos.bodyPct + "%" : "—"}, ${wickLabel} wick ${wickPct != null ? wickPct + "%" : "—"}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Live P&L</span> ₹${live}</div>
  </div>
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);margin-top:8px;">Exits: stop · doji · weak candle · EOD. No target.</div>
</div>`;
}

// ── History + daily-file viewers + restore + reset ────────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = sharedSocketState.getHaScalpMode() === "HA_SCALP_LIVE";
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  res.send(renderHistoryPage({
    routePrefix: "/ha-scalp-paper",
    sidebarKey: "haScalpHistory",
    pageTitle: "🩹 HA Scalp Paper Trade History",
    pageDocTitle: "HA Scalp Paper — History",
    modalLabel: "HA Scalp Paper",
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap,
    emptyLabel: "Start HA Scalp paper trading to record your first session.",
  }));
});

const _HA_SCALP_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  res.setHeader("Content-Disposition", `attachment; filename="ha_scalp_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates(MODE_KEY).map(d => d.date).sort();
  let body = "";
  for (const d of dates) { try { const p = skipLogger.filePathFor(MODE_KEY, d); if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8"); } catch (_) {} }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_HA_SCALP_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `ha_scalp_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_HA_SCALP_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `ha_scalp_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_HA_SCALP_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_HA_SCALP_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop HA Scalp paper trading first before deleting a session." });
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
  if (state.running) return res.status(400).json({ success: false, error: "Stop HA Scalp paper trading before restoring." });
  const date = String(req.params.date || "").trim();
  if (!_HA_SCALP_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades(MODE_KEY, date);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; if (key) seen.add(String(key)); }
  const missing = allTrades.filter(t => { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; return key && !seen.has(String(key)); });
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
  data.sessions.push({ date, strategy: (missing[0] && missing[0].strategy) || haStrategy.NAME, pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop HA Scalp paper trading before resetting." });
  const fresh = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  return res.json({ success: true, message: `HA Scalp paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
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
      const md = aiExport.buildMarkdown(records, { title: "HA Scalp paper trades (full log)", source: "ha-scalp-paper" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="ha_scalp_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="ha_scalp_paper_trades_${today}.jsonl"`);
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

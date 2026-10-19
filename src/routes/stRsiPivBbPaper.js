/**
 * PAPER TRADE — /st_rsi_piv_bb-paper   (ST_RSI_PIV_BB)
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses LIVE market data (Fyers WebSocket) but SIMULATES orders locally.
 * NO real orders are placed. Everything is tracked in memory + saved to disk.
 * The page layout and plumbing were derived from the emaRsiStV2Paper.js route
 * (same UI as /ema_rsi_st-paper); every RULE lives in
 * src/strategies/st_rsi_piv_bb.js — this route computes NO indicators and makes
 * NO threshold comparisons of its own.
 *
 *   ENTRY  : on a CLOSED trade-timeframe candle engine.getSignal() returns
 *            BUY_CE / BUY_PE (SuperTrend + RSI + pivot R1/S1 + Bollinger, all
 *            four). The fill is the first tick after that candle closes (the
 *            current option LTP). NO confirmation candle, NO intra-candle entry.
 *   EXIT   : on every CLOSED trade-timeframe candle while in a position —
 *            engine.exitCheck() with the stop in force BEFORE that bar; if it
 *            does not exit, engine.trailStop() tightens the stop. The stop is
 *            NOT checked tick-by-tick. Plus the forced square-off at
 *            ST_RSI_PIV_BB_EOD_EXIT_TIME (ticks) and the repo-global profit lock.
 *   GUARDS : entry window (engine), max trades/day, daily loss cap — nothing
 *            else of this strategy's own (no VIX, OI, cooldowns, streak breaker).
 *            The repo-global guards every strategy runs still apply: portfolio
 *            daily cap, bid-ask spread, capital pool, expiry-only toggle.
 *   TF     : ST_RSI_PIV_BB_ENTRY_TF 3 | 5 | BOTH. BOTH builds a 5-min series from
 *            the same spot ticks; on a tick that closes both a 5-min and a 3-min
 *            candle the 5-min candle is appended FIRST.
 *   PIVOTS : previous day's daily bar (NIFTY index, "D"), fetched at /start and
 *            refreshed when the IST day changes. No pivots → the engine refuses.
 *
 * Flow:
 *   /st_rsi_piv_bb-paper/start   → connects to live socket, starts simulating trades
 *   /st_rsi_piv_bb-paper/stop    → stops socket, saves final session summary
 *   /st_rsi_piv_bb-paper/status  → live view: position, PnL, capital, checklist, log
 *   /st_rsi_piv_bb-paper/history → all past paper trade sessions
 *   /st_rsi_piv_bb-paper/reset   → wipe paper trade history & reset capital
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
// The engine is the SINGLE source of truth for entry rules, indicator series,
// the exit test and the SuperTrend trail.
const engine = require("../strategies/st_rsi_piv_bb");
const ACTIVE = "ST_RSI_PIV_BB";
const instrumentConfig = require("../config/instrument");
const { getSymbol, getLotQty, validateAndGetOptionSymbol } = instrumentConfig;
const sharedSocketState = require("../utils/sharedSocketState");
const socketManager = require("../utils/socketManager"); // ← robust socket wrapper
const tickRecorder  = require("../utils/tickRecorder");
const optionFeed    = require("../utils/optionFeed");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { istDayFromAny, istIsoFromAny } = require("../utils/tradeUtils");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");
const { dailyFilesPaginate, renderHistoryPage } = require("../utils/paperHistoryUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const tradeLogger = require("../utils/tradeLogger");
const chartBackfill = require("../utils/chartBackfill");
const aiExport    = require("../utils/aiExport");
const { getCharges } = require("../utils/charges");
const tradeGuards = require("../utils/tradeGuards");
const skipLogger = require("../utils/skipLogger");
const capitalPool = require("../utils/capitalPool");
const optionChart  = require("../utils/optionChart");
// NOTE: no `technicalindicators` import here on purpose. Every indicator value
// this route displays comes from engine.computeSeries(), so the chart plots the
// exact numbers getSignal() read.

// ── Module-level config ─────────────────────────────────────────────────────
// The candle resolution is fixed for a session at /start (the candle buffers are
// built at it). Thresholds and risk caps are read LIVE through engine.getConfig()
// at every decision — never cached.
let TRADE_RES;            // trade timeframe in minutes (3 for ENTRY_TF 3/BOTH, 5 for 5)
let CONFIRM_RES;          // BOTH only: the second chart (5) — null otherwise
let _SESSION_ENTRY_TF;    // ENTRY_TF the running session was built for
let _STOP_MINS;           // TRADE_STOP_TIME — session auto-stop (default 15:30)
let _START_MINS;          // TRADE_START_TIME — pre-market banner only (default 09:15)
// isMarketHours() memo — invalidated by _refreshConfig(), so declared before it.
let _mktHoursCache    = null;
let _mktHoursCacheMin = -1;   // IST minute the cached verdict was computed for
function _refreshConfig() {
  const c = engine.getConfig();
  TRADE_RES         = c.TRADE_RES;
  CONFIRM_RES       = c.CONFIRM_RES;
  _SESSION_ENTRY_TF = c.ENTRY_TF;
  _STOP_MINS        = parseMins("TRADE_STOP_TIME", "15:30");
  _START_MINS       = parseMins("TRADE_START_TIME", "09:15");
  _mktHoursCacheMin = -1;               // invalidate the cached market-hours verdict
}
_refreshConfig();

// Rolling candle buffers — the app runs on a t3.micro. 400 bars is > 3 sessions
// of 3-min bars and far above the engine's 25-bar warm-up; indicators are
// computed once per candle close, never per tick.
const MAX_BARS = 400;
const PIVOT_RETRY_MS = 60 * 1000;   // pivots missing / stale → re-fetch at most once a minute
const ENTRY_RETRY_MS = 5000;        // a failed FILL (symbol / option LTP) retries at most every 5s

/** Settings changed ENTRY_TF since this session was built → describe it, else null. */
function _tfNote(cfg) {
  const c = cfg || engine.getConfig();
  if (c.ENTRY_TF === _SESSION_ENTRY_TF) return null;
  return ptState.running
    ? `Settings changed ENTRY_TF ${_SESSION_ENTRY_TF} → ${c.ENTRY_TF} mid-session. This session keeps its ${TRADE_RES}-min candles and refuses new entries — Stop + Start to apply.`
    : `Settings now say ENTRY_TF ${c.ENTRY_TF} — applies on the next Start (page shows the last session's ${TRADE_RES}-min view).`;
}

// ── Persistence ──────────────────────────────────────────────────────────────
// Data stored at ~/trading-data/ — OUTSIDE the project directory.
// This path survives git pull, npm install, and full redeploys.
const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "st_rsi_piv_bb_paper_trades.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory cache — avoids disk I/O on every 2-second AJAX poll.
// Updated only in savePaperData() when sessions actually change.
let _paperDataCache = null;

function loadPaperData() {
  if (_paperDataCache) return _paperDataCache;
  ensureDir();
  if (!fs.existsSync(PT_FILE)) {
    const initial = {
      capital: parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000"),
      totalPnl: 0,
      sessions: [],
    };
    fs.writeFileSync(PT_FILE, JSON.stringify(initial, null, 2));
    _paperDataCache = initial;
    return initial;
  }
  try {
    _paperDataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8"));
  } catch (e) {
    console.error("[ST_RSI_PIV_BB-PAPER] st_rsi_piv_bb_paper_trades.json corrupt — resetting:", e.message);
    _paperDataCache = { capital: parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(_paperDataCache, null, 2));
  }
  return _paperDataCache;
}

function savePaperData(data) {
  ensureDir();
  // Atomic write: temp file + rename prevents corrupt JSON if process dies mid-write
  const tmp = PT_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, PT_FILE);
  _paperDataCache = data;
}

// ── State (in-memory for current session) ───────────────────────────────────

let ptState = {
  running:       false,
  position:      null,
  // Trade-timeframe series (TRADE_RES): CLOSED candles + the forming bar.
  candles:       [],
  currentBar:    null,
  barStartTime:  null,
  // BOTH only: the 5-min confirmation series, built from the SAME spot ticks.
  candles5:      [],
  currentBar5:   null,
  barStartTime5: null,
  log:           [],
  sessionTrades: [],
  sessionStart:  null,
  sessionPnl:    0,
  tickCount:     0,
  lastTickTime:  null,
  lastTickPrice: null,
  prevCandleHigh: null,
  prevCandleLow:  null,
  // Option LTP tracking
  optionLtp:     null,
  optionSymbol:  null,
  optionChart:   null,
  // Previous day's floor pivots — engine.computePivots(daily, { forDayKey }).
  pivots:            null,
  _pivotsError:      null,
  _pivotsLastTryMs:  0,
  // Last getSignal() result on a closed trade-TF candle (the 4/4 checklist card).
  lastSignal:    null,
  // A signalled entry whose FILL failed (symbol / option LTP) — retried on ticks,
  // throttled, until the next trade-TF candle close supersedes it.
  _pendingEntry: null,
  // Display only — there is NO consecutive-loss breaker in this strategy.
  _consecutiveLosses: 0,
  // Daily loss kill switch — latched true when today's loss >= MAX_DAILY_LOSS (₹).
  // Blocks ALL new entries for the rest of the day. Resets only on session restart.
  _dailyLossHit: false,
  _priorRealizedToday: 0,   // today's realized P&L from EARLIER sessions (restart recovery)
  _priorTradesToday:   0,   // today's trade count from EARLIER sessions (restart recovery)
  // Pre-fetched option symbols (populated after each candle close, used at entry)
  _cachedCE: null,
  _cachedPE: null,
  _blockLoggedCandle: null, // throttle for "entry blocked" logs (once per candle)
  _entryPending:      false, // prevents double-entry while an async fill is in flight
  _expiryDayBlocked:  false, // blocks entries on non-expiry days
  // Win/loss counters: maintained in simulateSell so /status/data doesn't filter on every poll
  _sessionWins:   0,
  _sessionLosses: 0,
  // True when sessionTrades were restored from a PREVIOUS day's saved session by the
  // restart fallback below — they are not today's trades. Exposed as `staleSession` so
  // the shared monitors don't count a week-old session as today's P&L. Cleared by
  // /start, which rebuilds the session from scratch.
  _staleSession:  false,
  // True once sessionPnl is inside st_rsi_piv_bb_paper_trades.json totalPnl (saved by
  // saveSession, restored from History, or rehydrated from a saved session) — the
  // capital pool must then stop adding it on top. Cleared by /start.
  _pnlSaved:      false,
};

// ── Crash/restart recovery: rehydrate the in-memory session from today's JSONL ──
// A push/PM2 restart wipes ptState.sessionTrades — it's only flushed to the persisted
// sessions[] on Stop. The per-trade JSONL (appendTradeLog) survives, so on boot we
// re-load today's trades that aren't already in a saved (stopped) session. This
// restores the Session Trades table + chart markers that otherwise vanish after a
// restart. In-memory only — it does NOT re-save into sessions[] (Stop still does that).
function rehydrateSessionFromJsonl() {
  try {
    const data = loadPaperData();
    const keyOf = (t) => String(t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`);

    // 1. Today's running-session trades not yet saved to sessions[] (the in-memory
    //    session a restart would wipe). Day files interleave settings_snapshot/meta
    //    lines with trades — keep only real trade records.
    const today = tradeLogger.istDateString(Date.now());
    const all = tradeLogger.readDailyTrades("st_rsi_piv_bb", today)
      .filter(t => t && !t.type && (t.side || t.entryTime || t.entryBarTime || t.symbol));
    const seen = new Set();
    for (const s of (data.sessions || [])) {
      for (const t of (s.trades || [])) seen.add(keyOf(t));
    }
    let trades = all.filter(t => !seen.has(keyOf(t)));
    let source = "today's live session";
    let stale  = false;

    // 2. Nothing live today → show the most recent saved session so the screen
    //    isn't blank after a restart. Read-only; Start Paper resets it. Flagged
    //    stale so the shared monitors don't report it as today's P&L.
    if (!trades.length) {
      const saved = (data.sessions || []).filter(s => Array.isArray(s.trades) && s.trades.length);
      if (saved.length) {
        const last = saved.reduce((a, b) => (istDayFromAny(b.date) > istDayFromAny(a.date) ? b : a));
        trades = last.trades;
        source = `last session (${last.date || "?"})`;
        // Stale only when today's day-file has no trades at all — then what we just
        // restored really is a previous day. If today HAS trades and step 1 filtered
        // them all out, they are already in a saved session, so the session restored
        // here is today's own stopped session and its P&L is genuinely today's.
        stale  = all.length === 0;
      }
    }
    if (!trades.length) return;

    ptState._pnlSaved     = true;   // rehydrated trades are not counted: they may have been deleted from History, and the pool must not resurrect them
    ptState._staleSession = stale;
    ptState.sessionTrades = trades;
    ptState.sessionPnl = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    ptState._sessionWins   = trades.filter(t => Number(t.pnl) > 0).length;
    ptState._sessionLosses = trades.filter(t => Number(t.pnl) < 0).length;
    if (!ptState.sessionStart) ptState.sessionStart = istIsoFromAny(trades[0].entryTime || trades[0].loggedAt);
    console.log(`♻️ [ST_RSI_PIV_BB-PAPER] Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${ptState.sessionPnl})`);
  } catch (err) {
    console.warn(`[ST_RSI_PIV_BB-PAPER] session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();
// Capital pool: realized P&L = file totalPnl + this session's closed trades not yet
// saved there (rehydrated above after a restart).
capitalPool.trackSession("st_rsi_piv_bb", () =>
  ptState._pnlSaved ? 0 : (Number(ptState.sessionPnl) || 0));
// A previous day's session may only stay on screen while the market is shut.
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => ptState, "[ST_RSI_PIV_BB-PAPER]");

// ── Helpers ──────────────────────────────────────────────────────────────────

// Fast IST timestamp — avoids expensive toLocaleString/ICU on every log call
function istNow() {
  const ist = new Date(Date.now() + 19800000);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes(), s = ist.getUTCSeconds();
  const dd = ist.getUTCDate(), mm = ist.getUTCMonth() + 1, yyyy = ist.getUTCFullYear();
  return `${dd < 10 ? "0" : ""}${dd}/${mm < 10 ? "0" : ""}${mm}/${yyyy}, ${h < 10 ? "0" : ""}${h}:${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
}

// Display: trim seconds + comma from istNow() output to "DD/MM/YYYY HH:MM".
// Accepts ISO strings too (converts to IST).
function fmtT(s) {
  if (!s) return "—";
  const v = String(s);
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    if (isNaN(d)) return v;
    const ist = new Date(d.getTime() + 19800000);
    const dd = String(ist.getUTCDate()).padStart(2, "0");
    const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${ist.getUTCFullYear()} ${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
  }
  return v.replace(", ", " ").slice(0, 16);
}

function log(msg) {
  const entry = `[${istNow()}] ${msg}`;
  console.log(entry);
  ptState.log.push(entry);
  if (ptState.log.length > 2500) ptState.log.splice(0, ptState.log.length - 2000);
}

// Return last N items in reverse order — avoids spread+reverse on full array
function reverseSlice(arr, n) {
  const len = arr.length;
  const count = Math.min(n, len);
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = arr[len - 1 - i];
  return out;
}

function getTradeResolution() { return TRADE_RES; }

/** Floor a unix-ms time to its `resMin`-minute bucket. IST is UTC+5:30 and both
 *  3 and 5 divide 330, so these buckets sit on the IST 09:15 grid. Pure integer math. */
function _bucketMs(unixMs, resMin) {
  const resMs = resMin * 60_000;
  return Math.floor(unixMs / resMs) * resMs;
}
/** IST minutes-of-day of a unix-ms time. */
function _istMinOfMs(unixMs) {
  return Math.floor((Math.floor(unixMs / 1000) + 19800) / 60) % 1440;
}
/** "HH:MM" IST of a unix-SECONDS time. */
function _hhmm(unixSec) {
  const m = Math.floor((unixSec + 19800) / 60) % 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}
function _fmtMins(mins) {
  return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
}
/** Push a closed candle onto a buffer, keeping only the newest MAX_BARS. */
function _pushCapped(arr, candle) {
  arr.push(candle);
  if (arr.length > MAX_BARS) arr.splice(0, arr.length - MAX_BARS);
}

// ── Time helpers (all times configurable via .env) ───────────────────────────
// TRADE_START_TIME : pre-market banner only (default "09:15")
// TRADE_STOP_TIME  : session auto-stop (default "15:30")
// Entries are governed by the ENGINE's own window (ST_RSI_PIV_BB_ENTRY_START /
// _ENTRY_END) and the square-off by ST_RSI_PIV_BB_EOD_EXIT_TIME.
function parseMins(envKey, defaultVal) {
  const raw = process.env[envKey] || defaultVal;
  const [h, m] = raw.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
}

// ── Fast IST minutes helper ───────────────────────────────────────────────────
// IST = UTC + 5:30 (19800 seconds). Simple integer arithmetic, zero allocations.
function getISTMinutes() {
  const utcSec = Math.floor(Date.now() / 1000);
  const istSec = utcSec + 19800; // UTC+5:30
  const istMin = Math.floor(istSec / 60);
  return (istMin % 1440); // minutes since midnight IST (0–1439)
}

// NSE regular session open (09:15 IST) — the floor for building candles, fixed
// regardless of TRADE_START_TIME. Pre-open auction (09:00–09:08) prints a wild
// wide-range bar and pre-market ticks are stale/flat; both corrupt path-dependent
// indicators (SuperTrend) and make trend flips diverge from Kite/TradingView.
const _MKT_OPEN_MINS = 9 * 60 + 15;

// Display / debug only — entries are gated by the engine's window, not this.
function isMarketHours() {
  const total = getISTMinutes();
  if (total === _mktHoursCacheMin) return _mktHoursCache;
  _mktHoursCache    = total >= _START_MINS && total < _STOP_MINS;
  _mktHoursCacheMin = total;
  return _mktHoursCache;
}

// START gate: allow any time before TRADE_STOP_TIME
function isStartAllowed() {
  return getISTMinutes() < _STOP_MINS;
}

// ── Auto-stop timer handle (cleared on manual stop) ─────────────────────────────
let _autoStopTimer = null;
// Bumped by /start. Every async entry path captures it before its first await and
// rechecks it (plus running) right before simulateBuy, so an entry whose lookup
// straddled a /stop or stop+restart never opens on a dead session.
let _entrySessionGen = 0;
// Unique per route. EMA_RSI_ST (V1) owns socketManager's PRIMARY NIFTY handler;
// this route must fan out through addCallback, because start() on a running
// NIFTY socket REPLACES that handler and would starve V1 of every tick.
const SOCKET_CALLBACK_ID = "st_rsi_piv_bb-paper";

// A session started after its stop time (e.g. a 16:00 start) used to get no
// timer at all and held its socket slot all night. Hard-stop it this long after
// start instead. Never in replay — replay runs at any wall-clock hour.
const LATE_START_GRACE_MIN = 30;
function _lateStartStopMins() {
  try { if (require("../services/tickReplay").isReplayInProgress()) return 0; } catch (_) {}
  const t = (getISTMinutes() + LATE_START_GRACE_MIN) % 1440;
  const hhmm = String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
  log(`⏰ [PAPER] Session started after its stop time — will stop at ${hhmm} IST`);
  return LATE_START_GRACE_MIN;
}

// ── Live-harness lifecycle safety ────────────────────────────────────────────
// The ST_RSI_PIV_BB-LIVE harness fires REAL orders on this engine's notify tag.
// Every session-ending path releases it AFTER the virtual square-off (so the
// harness still sees the closing notifyExit — an exit already in flight runs to
// completion after uninstall), and /start drops a stale one unless the harness
// itself is the caller (?_viaHarness=1). Same contract as ema9vwapPaper.js.
const LIVE_HARNESS_MODE = "ST_RSI_PIV_BB-LIVE";
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

// Schedule auto-stop at TRADE_STOP_TIME (default 15:30 IST).
function scheduleAutoStop(stopFn) {
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  const stopMins = _STOP_MINS;
  const stopH    = Math.floor(stopMins / 60);
  const stopM    = stopMins % 60;
  const stopLabel = String(stopH).padStart(2,"0") + ":" + String(stopM).padStart(2,"0") + " IST";

  const now    = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const stopAt = new Date(now);
  stopAt.setHours(stopH, stopM, 0, 0);
  let msUntilStop = stopAt - now;
  const late = msUntilStop <= 0;
  if (late) { msUntilStop = _lateStartStopMins() * 60 * 1000; if (!msUntilStop) return; }
  _autoStopTimer = setTimeout(() => {
    if (!ptState.running) return;
    stopFn("⏰ [PAPER] Auto-stop: " + stopLabel + " reached — closing session.");
  }, msUntilStop);
  const minUntil = Math.round(msUntilStop / 60000);
  if (!late) log("⏰ [PAPER] Auto-stop scheduled in " + minUntil + " min (at " + stopLabel + ")");
}

function getCapitalFromEnv() {
  // ST_RSI_PIV_BB trades through Zerodha — its paper capital is the shared Zerodha investment pool.
  return parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000");
}

// ── Option LTP via REST polling ──────────────────────────────────────────────
// ONE permanent socket → NIFTY spot only. Never reconnected.
// Option LTP fetched via Fyers REST getQuotes() every 3 seconds while in trade.
// This avoids ALL Fyers singleton reconnect issues permanently.

const fyers = require('../config/fyers');
const { notifyEntry, notifyExit, notifyStarted, sendTelegram, canSend } = require('../utils/notify');
const NIFTY_INDEX_SYMBOL = 'NSE:NIFTY50-INDEX';

// ── Pre-fetch option symbols in background after each candle close ──────────
async function prefetchOptionSymbols(spot) {
  if (instrumentConfig.INSTRUMENT === 'NIFTY_FUTURES') return;
  try {
    const [ce, pe] = await Promise.all([
      validateAndGetOptionSymbol(spot, 'CE', ACTIVE),
      validateAndGetOptionSymbol(spot, 'PE', ACTIVE),
    ]);
    
    // Only cache valid symbols (reject invalid ones to force live lookup at entry)
    if (ce.invalid) {
      log(`⚠️ [PAPER] CE symbol invalid (${ce.symbol}) — all expiry fallbacks exhausted, will retry live at entry`);
      ptState._cachedCE = null;
    } else {
      ptState._cachedCE = { ...ce, spot };
    }
    
    if (pe.invalid) {
      log(`⚠️ [PAPER] PE symbol invalid (${pe.symbol}) — all expiry fallbacks exhausted, will retry live at entry`);
      ptState._cachedPE = null;
    } else {
      ptState._cachedPE = { ...pe, spot };
    }
    
    if (!ce.invalid && !pe.invalid) {
      log(`🔮 [PAPER] Pre-fetched options @ spot ₹${spot} → CE: ${ce.symbol} | PE: ${pe.symbol}`);
    }
  } catch (err) {
    log(`⚠️ [PAPER] Pre-fetch failed: ${err.message} — will fall back to live lookup at entry`);
    ptState._cachedCE = null;
    ptState._cachedPE = null;
  }
}

// Return cached symbol if spot hasn't moved > 25 pts, otherwise null
function getCachedSymbol(side, currentSpot) {
  const cached = side === 'CE' ? ptState._cachedCE : ptState._cachedPE;
  if (!cached || cached.invalid) return null;
  if (Math.abs(cached.spot - currentSpot) > 25) return null;
  return cached;
}

let _optionPollTimer = null;
let _optionPollBusy  = false; // guard: prevents overlapping getQuotes calls if network is slow
let _entryLtpProxyTimer = null; // 10s entry-premium fallback timer — owned by one position
let _rateLimitSkipCycles = 0; // skip N poll cycles after a rate-limit hit
const OPTION_FEED_OWNER = "st_rsi_piv_bb-paper";
// Rebound per position in startOptionPolling so the closure captures the symbol
// actually held; null while flat.
let _onStreamedOptionLtp = null;
// Poll generation: bumped by every stopOptionPolling(). Each poll chain captures
// the value it started under; a reply or loop from an older generation (exit +
// re-entry on the SAME strike while it was in flight) is dropped, since the
// symbol check alone cannot tell the two positions apart.
let _optionPollGen = 0;

async function fetchOptionLtp(symbol) {
  try {
    // Fyers v3 getQuotes accepts a comma-separated symbol string directly
    const response = await fyers.getQuotes([symbol]);

    if (response.s === 'ok' && response.d && response.d.length > 0) {
      const v = response.d[0].v || response.d[0];
      // Try every known Fyers LTP field name
      const ltp = v.lp || v.ltp || v.last_price || v.last_traded_price
               || v.ask_price || v.bid_price || v.close_price || v.prev_close_price;
      if (ltp && ltp > 0) {
        if (fetchOptionLtp._rlActive) {
          log(`✅ [PAPER] Rate limit cleared — polling resumed`);
          fetchOptionLtp._rlActive = false;
          _rateLimitSkipCycles = 0;
        }
        const _ltp = parseFloat(ltp);
        try { tickRecorder.recordOptionLtp(symbol, _ltp, "st_rsi_piv_bb-paper"); } catch (_) {}
        return _ltp;
      }
      log(`[DEBUG] All LTP fields null/zero for ${symbol} | v=${JSON.stringify(v).slice(0, 200)}`);
    } else {
      if (!fetchOptionLtp._errLogged) {
        log(`[DEBUG] getQuotes non-ok: s=${response.s} msg=${response.message||response.msg||"?"}`);
        fetchOptionLtp._errLogged = true;
        setTimeout(() => { delete fetchOptionLtp._errLogged; }, 30000);
      }
    }
  } catch (err) {
    const msg = err.message || "";
    if (/limit|throttle|429/i.test(msg)) {
      if (!fetchOptionLtp._rlActive) {
        log(`⚠️ [PAPER] Rate limit hit — skipping 2 poll cycles`);
        fetchOptionLtp._rlActive = true;
      }
      _rateLimitSkipCycles = 2;
    } else {
      log(`[DEBUG] fetchOptionLtp exception: ${msg}`);
    }
  }
  return null;
}

// ── Publishing a premium — shared by the REST poll and the websocket push ────
// Both sources must apply the SAME ownership check, recovery log and capital
// re-block, so the write lives in exactly one place.
//   `at` is when the price was OBSERVED. It must never be stamped with "now"
//   for a streamed tick, because the staleness alert in _optionPollTick
//   compares against this very field to decide the premium can still be trusted.
function _publishOptionLtp(symbol, ltp, at) {
  // ── Ownership check BEFORE publishing (must stay ahead of the write) ──────
  // A reply that lands after the position closed — or after the engine moved
  // to a different strike — belongs to a contract we no longer hold. Writing
  // it to ptState.optionLtp used to leave the OLD contract's premium sitting
  // in state (nothing clears it between trades), so the NEXT entry adopted it
  // as its entry premium. Publish only while we still own `symbol`.
  if (!ptState.position || ptState.optionSymbol !== symbol) return;
  if (!(ltp > 0)) return;
  ptState.optionLtp = ltp;
  ptState.optionLtpUpdatedAt = at || Date.now();
  // Premium bars for the option chart (display only — never read by the engine).
  ptState.optionChart = optionChart.pushLtp(ptState.optionChart, symbol, ltp, at);
  if (ptState._ltpStaleLogged) {
    log(`✅ [PAPER] Option LTP recovered — ₹${ltp}`);
    ptState._ltpStaleLogged = false;
  }
  ptState.position.optionCurrentLtp = ltp;
  if (!ptState.position.optionEntryLtp) {
    ptState.position.optionEntryLtp = ltp;
    ptState.position.optionEntryLtpTime = istNow();
    // Real premium known — replace the estimate blocked at entry.
    capitalPool.updateBlock("st_rsi_piv_bb", (ptState.position.qty || 0) * ltp);
    log(`📌 [PAPER] Option entry LTP: ₹${ltp} (SPOT @ ₹${ptState.position.spotAtEntry} | SL: ₹${ptState.position.stopLoss})`);
  }
}

// ── Option LTP poll tick — shared logic used by immediate fetch + recurring loop ──
async function _optionPollTick(symbol, gen) {
  if (gen !== _optionPollGen) return; // stale chain — a newer one owns polling
  if (_optionPollBusy) return; // skip if previous call still in flight
  if (_rateLimitSkipCycles > 0) { _rateLimitSkipCycles--; return; }
  _optionPollBusy = true;
  try {
    if (!ptState.position || !ptState.optionSymbol) { stopOptionPolling(); return; }
    // Socket-first. The contract is streamed on the shared websocket, so this
    // REST call fires only when the stream is quiet or unavailable — and the
    // track() below is what renews the lease keeping it subscribed.
    optionFeed.track(OPTION_FEED_OWNER, symbol, _onStreamedOptionLtp);
    const streamed = optionFeed.getFresh(symbol);
    const ltp   = streamed ? streamed.ltp : await fetchOptionLtp(symbol);
    const ltpAt = streamed ? streamed.at  : Date.now();
    if (gen !== _optionPollGen) return; // position changed while in flight
    if (!ltp) {
      // ── Staleness alert ───────────────────────────────────────────────────
      // A failed poll leaves ptState.optionLtp at its LAST value. Warn, so a stale
      // premium behind the exit P&L / profit lock is visible. Warn only.
      const _staleMs = parseInt(process.env.LTP_STALE_THRESHOLD_SEC || "15", 10) * 1000;
      if (ptState.optionLtpUpdatedAt && (Date.now() - ptState.optionLtpUpdatedAt) > _staleMs
          && !ptState._ltpStaleLogged) {
        log(`⚠️ [PAPER] Option LTP STALE — no update for ${Math.round((Date.now() - ptState.optionLtpUpdatedAt) / 1000)}s. P&L + profit lock are using a stale premium.`);
        ptState._ltpStaleLogged = true;
      }
      return;
    }
    _publishOptionLtp(symbol, ltp, ltpAt);

    // No option-premium stop exists in this strategy — the SuperTrend stop is
    // checked on candle close only (onCandleClose).
  } finally {
    if (gen === _optionPollGen) _optionPollBusy = false; // a stale tick must not clear a newer chain's flag
  }
}

function startOptionPolling(symbol) {
  stopOptionPolling(); // clear any previous
  _optionPollBusy = false;
  const gen = _optionPollGen;

  // Stream the held contract on the shared Fyers websocket. Ticks publish
  // straight through _publishOptionLtp, so the premium the exit rules read is
  // current rather than up to a poll interval old. Subscribing here (not on the
  // first poll) gets the stream warming while the immediate REST fetch runs.
  _onStreamedOptionLtp = (ltp, at) => { if (gen === _optionPollGen) _publishOptionLtp(symbol, ltp, at); };
  optionFeed.track(OPTION_FEED_OWNER, symbol, _onStreamedOptionLtp);

  // ── Recursive setTimeout loop (replaces setInterval) ──────────────────────
  // setInterval fires regardless of whether the previous async call has resolved.
  // If getQuotes() takes >1s (slow network), calls accumulate and pile up.
  // setTimeout-chaining guarantees exactly 1s gap BETWEEN calls, not 1s PERIOD.
  function scheduleNext() {
    if (!_optionPollTimer || gen !== _optionPollGen) return; // polling was stopped / restarted
    _optionPollTimer = setTimeout(async () => {
      // A rejection here must never kill the chain silently (the premium would
      // freeze at its last value and the exit would book a stale premium).
      try { await _optionPollTick(symbol, gen); }
      catch (err) { log(`⚠️ [PAPER] Option poll error: ${err.message} — polling continues`); }
      scheduleNext(); // reschedule only after this call finishes
    }, 1000);
  }

  // Kick off with an immediate tick, then start the loop. The .catch keeps the
  // chain alive if the very first poll throws — otherwise polling would never
  // start and the 10s fallback below would stamp spot as the entry premium.
  _optionPollTick(symbol, gen)
    .catch(err => log(`⚠️ [PAPER] Initial option poll error: ${err.message}`))
    .then(scheduleNext);

  // Mark polling as active (non-null timer signals "running" to stopOptionPolling)
  _optionPollTimer = true; // placeholder until first setTimeout fires

  // ── 10s timeout: flag that no option premium arrived. DIAGNOSTIC ONLY. ──────
  // Spot is NEVER written into optionEntryLtp (a spot "premium" would book a
  // phantom loss). With it null, simulateSell falls back to its spot-proxy P&L.
  // OWNERSHIP: this timer belongs to the position that started THIS polling run;
  // it is tracked, cleared by stopOptionPolling(), and re-checks the held contract.
  _entryLtpProxyTimer = setTimeout(() => {
    _entryLtpProxyTimer = null;
    if (ptState.position && ptState.optionSymbol === symbol
        && !ptState.position.optionEntryLtp) {
      ptState.position.optionEntryLtpMissing = true;
      log(`⚠️ [PAPER] No option premium after 10s for ${symbol} — entry premium left UNSET (P&L falls back to spot proxy until a real premium arrives). Spot is NOT used as a premium.`);
    }
  }, 10000);
}

function stopOptionPolling() {
  if (_optionPollTimer && _optionPollTimer !== true) {
    clearTimeout(_optionPollTimer);
  }
  _optionPollTimer = null;
  _optionPollBusy  = false;
  _optionPollGen++;
  _onStreamedOptionLtp = null;
  // Release the websocket lease now rather than letting it lapse, so the
  // contract is unsubscribed the moment the position is gone.
  try { optionFeed.release(OPTION_FEED_OWNER); } catch (_) {}
  // Cancel the entry-premium fallback so it can never fire against a later position.
  if (_entryLtpProxyTimer) { clearTimeout(_entryLtpProxyTimer); _entryLtpProxyTimer = null; }
}

// ── Simulated order (NO real API call) ──────────────────────────────────────

function parseOptionDetails(symbol) {
  // Fyers weekly option symbol formats:
  //
  // Format A (numeric/special month code): NSE:NIFTY{YY}{M}{DD}{Strike}{CE|PE}
  //   M = 1-9 for Jan-Sep, O=Oct, N=Nov, D=Dec
  //   e.g. NSE:NIFTY2631024550CE → YY=26, M=3(Mar), DD=10, strike=24550
  //
  // Format B (3-letter month, older): NSE:NIFTY{YY}{MON}{DD}{Strike}{CE|PE}
  //   e.g. NSE:NIFTY26MAR1024550CE → YY=26, MON=MAR, DD=10, strike=24550

  const MONTH_NAMES = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  // Map Fyers numeric month codes → 0-based month index
  const MONTH_CODE_MAP = { "1":0,"2":1,"3":2,"4":3,"5":4,"6":5,"7":6,"8":7,"9":8,"O":9,"N":10,"D":11 };

  try {
    // Format A: YY + single-char month code + 2-digit day
    // Month code is one of: 1-9, O, N, D  (never a letter that starts a 3-letter month)
    const mA = symbol.match(/NSE:NIFTY(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$/);
    if (mA) {
      const yy     = mA[1];
      const mCode  = mA[2];
      const dd     = mA[3];
      const strike = parseInt(mA[4], 10);
      const type   = mA[5];
      const monthIdx = MONTH_CODE_MAP[mCode];
      const mon    = MONTH_NAMES[monthIdx];
      return {
        expiry:     `${dd} ${mon} 20${yy}`,   // "10 MAR 2026"
        expiryRaw:  `${yy}${mCode}${dd}`,
        strike,
        optionType: type,
      };
    }

    // Format C: YY + 3-letter month (MONTHLY — no day)
    // Must check FIRST — Format B would incorrectly eat 2 digits from strike
    // e.g. NSE:NIFTY26MAR22600PE → expiry=26MAR, strike=22600
    const mC = symbol.match(/NSE:NIFTY(\d{2})([A-Z]{3})(\d+)(CE|PE)$/);
    if (mC) {
      const strike = parseInt(mC[3], 10);
      if (strike >= 10000) {
        // Valid NIFTY strike (10000+) = monthly format confirmed
        return {
          expiry:     `${mC[2]} 20${mC[1]}`,
          expiryRaw:  `${mC[1]}${mC[2]}`,
          strike,
          optionType: mC[4],
        };
      }
    }

    // Format B: YY + 3-letter month + 2-digit day (weekly with month name)
    // e.g. NSE:NIFTY26MAR3022600PE → expiry=26MAR30, strike=22600
    const mB = symbol.match(/NSE:NIFTY(\d{2}[A-Z]{3}\d{2})(\d+)(CE|PE)$/);
    if (mB) {
      const expiryRaw = mB[1];
      const yy  = expiryRaw.slice(0, 2);
      const mon = expiryRaw.slice(2, 5);
      const dd  = expiryRaw.slice(5, 7);
      return {
        expiry:     `${dd} ${mon} 20${yy}`,
        expiryRaw,
        strike:     parseInt(mB[2], 10),
        optionType: mB[3],
      };
    }
  } catch (_) {}
  return null;
}

// ── Pivots — the previous day's daily bar ────────────────────────────────────
// Fetched at /start and whenever the IST day of a closed candle no longer matches
// the pivots' forDayKey. computePivots() picks the newest daily bar strictly BEFORE
// the day being traded, so a forming daily bar can never move R1/S1 intraday.
let _pivotsInFlight = false;
async function _fetchPivots(forDayKey) {
  const { fetchCandles } = require("../services/backtestEngine");
  const nowIst = new Date(Date.now() + 19800000);
  const from = new Date(nowIst.getTime() - 10 * 86400000);   // ~10 days back covers a long weekend / holiday run
  const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const daily = await fetchCandles(NIFTY_INDEX_SYMBOL, "D", fmt(from), fmt(nowIst));
  if (!Array.isArray(daily) || !daily.length) return null;
  return engine.computePivots(daily, { forDayKey });
}

async function _refreshPivots(forDayKey) {
  if (_pivotsInFlight) return;
  _pivotsInFlight = true;
  ptState._pivotsLastTryMs = Date.now();
  try {
    const pv = await _fetchPivots(forDayKey);
    if (pv && pv.forDayKey === forDayKey) {
      ptState.pivots = pv;
      ptState._pivotsError = null;
      log(`📐 [PAPER] Pivots (prev day ${pv.from}): PP ${pv.pp} | R1 ${pv.r1} | S1 ${pv.s1} | R2 ${pv.r2} | S2 ${pv.s2}`);
    } else {
      ptState._pivotsError = "No R1/S1 — daily candles unavailable";
      log(`⚠️ [PAPER] No R1/S1 — daily candles unavailable. The engine refuses entries until they load (retry every ${PIVOT_RETRY_MS / 1000}s).`);
    }
  } catch (err) {
    ptState._pivotsError = `No R1/S1 — daily candles unavailable (${err.message})`;
    log(`⚠️ [PAPER] Pivot fetch failed: ${err.message} — the engine refuses entries until R1/S1 load (retry every ${PIVOT_RETRY_MS / 1000}s).`);
  } finally {
    _pivotsInFlight = false;
  }
}

/** Background, throttled: make sure ptState.pivots belong to `forDayKey`. */
function _ensurePivots(forDayKey) {
  if (ptState.pivots && ptState.pivots.forDayKey === forDayKey) return;
  if (ptState.pivots && ptState.pivots.forDayKey !== forDayKey) {
    ptState.pivots = null;   // never show (or pass) another day's levels
    ptState._pivotsError = "Pivots belong to another day — refreshing";
  }
  if (Date.now() - (ptState._pivotsLastTryMs || 0) < PIVOT_RETRY_MS) return;
  _refreshPivots(forDayKey).catch(() => {});
}

// ── 5-min checklist (BOTH) — display only, cached per closed 5-min candle ────
// getSignal() reads the 5-min chart only when the 3-min chart is already 4/4, so
// the card would otherwise be blank most of the time. engine.checkBar() over
// engine.computeSeries() is the same evaluation the engine runs.
let _confirmChkCache = { key: null, value: null };
function _confirmChecklist() {
  if (!CONFIRM_RES) return null;
  const cc = ptState.candles5;
  if (!cc.length) return null;
  const last = cc[cc.length - 1];
  const pv = ptState.pivots;
  const key = `${cc.length}|${last.time}|${pv ? pv.r1 + "/" + pv.s1 : "-"}`;
  if (_confirmChkCache.key === key) return _confirmChkCache.value;
  let value = null;
  try {
    const cfg = engine.getConfig();
    const chk = engine.checkBar(last, cc.length - 1, engine.computeSeries(cc, cfg), pv, cfg);
    value = { time: last.time, closeTime: last.time + CONFIRM_RES * 60, close: last.close, ready: chk.ready, CE: chk.CE, PE: chk.PE,
              rsi: chk.rsi, supertrend: chk.supertrend, bbUpper: chk.bbUpper, bbLower: chk.bbLower };
  } catch (_) { value = null; }
  _confirmChkCache = { key, value };
  return value;
}

// ── Simulated order (NO real API call) ──────────────────────────────────────

/**
 * Open a virtual position. `stopLoss` is the engine's SuperTrend value on the
 * signal candle (or, for a manual entry, the latest closed candle) — it seeds the
 * trail, which engine.trailStop() tightens at every later candle close.
 * `meta.entryLtp` — the option premium at the fill (first tick after the close).
 */
function simulateBuy(symbol, side, qty, price, reason, stopLoss, spotAtEntry, meta = {}) {
  // Guard: never overwrite an existing position.
  if (ptState.position) {
    log(`⚠️ [PAPER] simulateBuy called while position already open — ignoring duplicate entry (${side} @ ₹${price})`);
    return;
  }
  // Never open a position without a stop. The engine refuses a signal whose
  // SuperTrend is not beyond the close; this only catches a broken caller.
  if (!Number.isFinite(stopLoss)) {
    log(`🚫 [PAPER] Entry aborted — no SuperTrend stop for ${side} (got ${stopLoss})`);
    skipLogger.appendSkipLog("st_rsi_piv_bb", {
      gate: "strategy",
      reason: "no SuperTrend stop available",
      spot: price,
      side,
      signal: side === "CE" ? "BUY_CE" : "BUY_PE",
      path: "stop",
    });
    return;
  }
  const optDetails = parseOptionDetails(symbol);
  const _entrySpot = spotAtEntry || price;
  const _entryLtp  = Number.isFinite(meta.entryLtp) && meta.entryLtp > 0 ? meta.entryLtp : null;
  const _isFutures = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";

  // ── Capital gate — HARD: the pool must fund qty × premium or the entry is
  //    refused (error line + skip log + dashboard alert, see capitalPool.gate).
  //    The premium at the fill is known for an automatic entry; otherwise the
  //    assumed premium is used and the block is trued up by the first poll.
  const _estCost = qty * (_entryLtp != null ? _entryLtp : capitalPool.estimatedPremium());
  const _cap = capitalPool.gate("st_rsi_piv_bb", _estCost, { side, symbol, qty });
  if (!_cap.ok) {
    if (!_cap.muted) {
      log(`❌ [PAPER] Entry REFUSED — ${_cap.reason}`);
      skipLogger.appendSkipLog("st_rsi_piv_bb", { gate: "capital", reason: _cap.reason, spot: price, side, symbol, qty, cost: _cap.cost, available: _cap.available });
    }
    return;
  }

  // Data-collection metadata — frozen at entry so the trade record is self-describing for offline analysis.
  const _entryIstMin     = Math.floor((Math.floor(Date.now() / 1000) + 19800) / 60) % 1440;
  const sig = meta.signal || {};

  ptState.position = {
    side,
    symbol,
    qty,
    entryPrice:        price,          // NIFTY spot at the fill (first tick after the signal candle closed)
    spotAtEntry:       _entrySpot,
    entryTime:         istNow(),
    entryUnixSec:      Math.floor(Date.now() / 1000),
    reason,
    stopLoss:          stopLoss,       // the trail — tightened by engine.trailStop() at each close
    initialStopLoss:   stopLoss,
    entryBarTime:      meta.entryBarTime != null ? meta.entryBarTime : (ptState.currentBar ? ptState.currentBar.time : null),
    signalBarTime:     meta.signalBarTime != null ? meta.signalBarTime : null,
    bestPrice:         null,
    bestOptionLtp:     _entryLtp,      // peak (highest) option premium reached during trade — observer-only
    candlesHeld:       0,
    // Max favorable / adverse excursion in spot pts — tracked per-tick for post-trade analysis.
    mfeSpotPts:        0,
    maeSpotPts:        0,
    entryTimeMs:       Date.now(),
    secsToMFE:         0,
    secsToMAE:         0,
    isFutures:         _isFutures,
    // Option metadata
    optionExpiry:      optDetails?.expiry     || null,
    optionStrike:      optDetails?.strike     || null,
    optionType:        optDetails?.optionType || side,
    // Option premium — the fill premium when known; otherwise this contract's own
    // first poll fills it (see _publishOptionLtp). Never inherited from a previous strike.
    optionEntryLtp:    _entryLtp,
    optionEntryLtpTime: _entryLtp != null ? istNow() : null,
    optionCurrentLtp:  _entryLtp,
    entryHourIST:      Math.floor(_entryIstMin / 60),
    entryMinuteIST:    _entryIstMin % 60,
    isManual:          !!meta.manual,
    // Entry-candle snapshot — straight from getSignal() / engine.computeSeries().
    signalStrength:    sig.signalStrength || null,
    rsiAtEntry:        sig.rsi        != null ? sig.rsi        : null,
    bbUpperAtEntry:    sig.bbUpper    != null ? sig.bbUpper    : null,
    bbMiddleAtEntry:   sig.bbMiddle   != null ? sig.bbMiddle   : null,
    bbLowerAtEntry:    sig.bbLower    != null ? sig.bbLower    : null,
    supertrendAtEntry: sig.supertrend != null ? sig.supertrend : null,
    stTrendAtEntry:    sig.stTrend    || null,
    pp:                sig.pp  != null ? sig.pp  : null,
    r1:                sig.r1  != null ? sig.r1  : null,
    s1:                sig.s1  != null ? sig.s1  : null,
    r2:                sig.r2  != null ? sig.r2  : null,
    s2:                sig.s2  != null ? sig.s2  : null,
    pivotsFrom:        sig.pivotsFrom || null,
    entryTf:           _SESSION_ENTRY_TF,
    tradeRes:          TRADE_RES,
    checks:            sig.checks        || null,
    confirmChecks:     sig.confirmChecks || null,
  };

  // Crash-recovery snapshot: written on entry, refreshed on every trail move,
  // cleared on exit. app.js reconciles it against the broker book on boot.
  try { require("../utils/positionPersist").saveStRsiPivBbPosition(ptState.position, { sessionPnl: ptState.sessionPnl }); } catch (_) {}

  // Set option symbol and start polling (no socket changes). Futures: no premium to track.
  ptState.optionSymbol = symbol;
  capitalPool.block("st_rsi_piv_bb", _estCost, { side, symbol, qty, premium: _entryLtp });
  // This contract's premium comes from this contract's own fill / poll only.
  ptState.optionLtp          = _entryLtp;
  ptState.optionLtpUpdatedAt = _entryLtp != null ? Date.now() : null;
  if (!_isFutures) {
    log(`📊 [PAPER] Starting option LTP polling: ${symbol}`);
    startOptionPolling(symbol);
  } else {
    log(`📊 [PAPER] Futures mode — skipping option LTP polling`);
  }

  log(`📝 [PAPER] BUY ${qty} × ${symbol} @ SPOT ₹${price} | SL (SuperTrend, candle-close): ₹${stopLoss} | Opt: ${_entryLtp != null ? "₹" + _entryLtp : "capturing…"} | Reason: ${reason}`);
  // ── Telegram notification ─────────────────────────────────────────────────
  notifyEntry({
    mode:           'ST_RSI_PIV_BB-PAPER',   // unique — the live harness filters on this exact tag
    side,
    symbol,
    strike:         ptState.position.optionStrike,
    expiry:         ptState.position.optionExpiry,
    spotAtEntry:    price,
    optionEntryLtp: _entryLtp,
    stopLoss:       stopLoss,
    qty,
    reason,
  });
}

/**
 * Close the virtual position. `exitBarTime` — the bar the exit FILLED in (for the
 * chart marker); defaults to the forming bar.
 */
function simulateSell(exitPrice, reason, spotAtExit, exitBarTime, exitMeta = {}) {
  if (!ptState.position) return;

  const { side, symbol, qty, entryPrice, entryTime, spotAtEntry,
          optionEntryLtp, optionCurrentLtp, entryHourIST, entryMinuteIST } = ptState.position;
  const pos = ptState.position;

  const INSTR = instrumentConfig.INSTRUMENT; // top-level constant
  const isFutures = INSTR === "NIFTY_FUTURES";

  // ── PnL Calculation ─────────────────────────────────────────────────────────
  let rawPnl;
  let pnlMode;
  const exitOptionLtp = ptState.optionLtp || optionCurrentLtp;

  if (isFutures) {
    // Futures: PnL = price difference × qty. CE=LONG (+1), PE=SHORT (-1)
    rawPnl  = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
    pnlMode = `futures: entry ₹${entryPrice} → exit ₹${exitPrice} (${side === "CE" ? "LONG" : "SHORT"})`;
  } else if (optionEntryLtp && exitOptionLtp && optionEntryLtp > 0 && exitOptionLtp > 0) {
    // Options: use actual option premium movement (entry LTP → exit LTP)
    rawPnl  = (exitOptionLtp - optionEntryLtp) * qty;
    pnlMode = `option premium: entry ₹${optionEntryLtp} → exit ₹${exitOptionLtp}`;
  } else {
    // Options fallback: spot movement proxy
    rawPnl  = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
    pnlMode = `spot proxy (option LTP unavailable)`;
  }

  // Charges: STT + exchange + GST + stamp duty + brokerage (configurable via Settings)
  const charges = getCharges({ isFutures, exitPremium: exitOptionLtp, entryPremium: optionEntryLtp, qty });
  const netPnl  = parseFloat((rawPnl - charges).toFixed(2));

  const _exitBarTime = exitBarTime != null ? exitBarTime : (ptState.currentBar ? ptState.currentBar.time : null);
  const _entryBarMs  = pos.entryBarTime ? pos.entryBarTime * 1000 : null;
  const _exitBarMs   = _exitBarTime ? _exitBarTime * 1000 : null;
  const _durationMs  = (_entryBarMs && _exitBarMs) ? (_exitBarMs - _entryBarMs) : null;
  const _pnlPoints   = parseFloat(((exitPrice - entryPrice) * (side === "CE" ? 1 : -1)).toFixed(2));

  const trade = {
    side,
    symbol,
    qty,
    strike:           pos.optionStrike || null,
    entryPrice,
    exitPrice,
    spotAtEntry:      spotAtEntry || entryPrice,
    spotAtExit:       spotAtExit  || exitPrice,
    optionEntryLtp:   isFutures ? null : (optionEntryLtp  || null),
    optionExitLtp:    isFutures ? null : (exitOptionLtp   || null),
    entryTime,
    exitTime:         istNow(),
    pnl:              netPnl,
    pnlMode,
    exitReason:       reason,
    entryReason:      pos.reason,
    stopLoss:         pos.stopLoss,          // final SL at exit (trailed)
    initialStopLoss:  pos.initialStopLoss != null ? pos.initialStopLoss : null,
    optionExpiry:     pos.optionExpiry || null,
    optionStrike:     pos.optionStrike || null,
    optionType:       pos.optionType   || side,
    // Bar timestamps for chart markers (the bar each side FILLED in)
    entryBarTime:     pos.entryBarTime || null,
    signalBarTime:    pos.signalBarTime || null,
    exitBarTime:      _exitBarTime,
    entryHourIST:     entryHourIST   != null ? entryHourIST   : null,
    entryMinuteIST:   entryMinuteIST != null ? entryMinuteIST : null,
    // Entry-candle snapshot (engine values)
    signalStrength:   pos.signalStrength || null,
    rsi:              pos.rsiAtEntry,
    bbUpper:          pos.bbUpperAtEntry,
    bbMiddle:         pos.bbMiddleAtEntry,
    bbLower:          pos.bbLowerAtEntry,
    supertrend:       pos.supertrendAtEntry,
    stTrend:          pos.stTrendAtEntry,
    pp:               pos.pp,
    r1:               pos.r1,
    s1:               pos.s1,
    r2:               pos.r2,
    s2:               pos.s2,
    pivotsFrom:       pos.pivotsFrom,
    entryTf:          pos.entryTf,
    tradeRes:         pos.tradeRes,
    checks:           pos.checks,
    confirmChecks:    pos.confirmChecks,
    supertrendAtExit: exitMeta.supertrend != null ? exitMeta.supertrend : null,
    stTrendAtExit:    exitMeta.stTrend != null ? exitMeta.stTrend : null,
    // Full-detail capture for JSONL
    bestPrice:        pos.bestPrice     || null,   // peak favorable spot during trade
    bestOptionLtp:    pos.bestOptionLtp || null,   // peak option premium during trade
    candlesHeld:      pos.candlesHeld   || 0,
    mfeSpotPts:       pos.mfeSpotPts    || 0,
    maeSpotPts:       pos.maeSpotPts    || 0,
    secsToMFE:        pos.secsToMFE     || 0,
    secsToMAE:        pos.secsToMAE     || 0,
    durationMs:       _durationMs,
    pnlPoints:        _pnlPoints,
    charges:          charges,
    isFutures:        isFutures,
    isManual:         !!pos.isManual,
    instrument:       INSTR,
  };

  ptState.sessionTrades.push(trade);
  tradeLogger.appendTradeLog("st_rsi_piv_bb", trade); // crash-safe per-trade JSONL
  ptState.sessionPnl = parseFloat((ptState.sessionPnl + netPnl).toFixed(2));
  // Maintain O(1) counters so status endpoints don't need Array.filter on every poll
  if (netPnl > 0) { ptState._sessionWins++;   }
  else             { ptState._sessionLosses++; }
  // Display-only streak — this strategy has NO consecutive-loss breaker.
  ptState._consecutiveLosses = netPnl < 0 ? (ptState._consecutiveLosses || 0) + 1 : 0;

  // ── Daily loss kill switch ────────────────────────────────────────────────────
  // Today's loss (this session + earlier sessions today, see the restart recovery
  // in /start) at or beyond ST_RSI_PIV_BB_MAX_DAILY_LOSS latches _dailyLossHit and
  // blocks ALL new entries for the rest of the day. 0 = no cap.
  const _maxLoss = engine.getConfig().MAX_DAILY_LOSS;
  const _dayPnl  = ptState.sessionPnl + (ptState._priorRealizedToday || 0);
  if (!ptState._dailyLossHit && _maxLoss > 0 && _dayPnl <= -Math.abs(_maxLoss)) {
    ptState._dailyLossHit = true;
    log(`🛑 [PAPER] DAILY LOSS LIMIT HIT — today's P&L ₹${_dayPnl.toFixed(2)} ≤ -₹${_maxLoss}. NO MORE ENTRIES TODAY.`);
  }

  stopOptionPolling();
  ptState.optionSymbol = null;
  ptState.optionLtp    = null;
  log(`📊 [PAPER] ${isFutures ? "Futures" : "Option"} LTP polling stopped`);

  const emoji = netPnl >= 0 ? "✅" : "❌";
  log(`${emoji} [PAPER] SELL ${qty} × ${symbol} @ SPOT ₹${exitPrice} | ${isFutures ? "" : `Option LTP: ₹${exitOptionLtp || "?"} | `}PnL: ₹${netPnl} | ${pnlMode} | ${reason}`);
  log(`💼 [PAPER] Session PnL so far: ₹${ptState.sessionPnl}`);

  // ── Telegram notification ─────────────────────────────────────────────────
  notifyExit({
    mode:           'ST_RSI_PIV_BB-PAPER',   // unique — the live harness filters on this exact tag
    side,
    symbol,
    strike:         trade.optionStrike,
    expiry:         trade.optionExpiry,
    spotAtEntry:    trade.spotAtEntry,
    spotAtExit:     spotAtExit || exitPrice,
    optionEntryLtp: trade.optionEntryLtp,
    optionExitLtp:  trade.optionExitLtp,
    pnl:            netPnl,
    sessionPnl:     ptState.sessionPnl,
    exitReason:     reason,
    entryReason:    trade.entryReason,
    entryTime:      trade.entryTime,
    exitTime:       trade.exitTime,
    qty,
    peakPremium:    trade.bestOptionLtp,
    heldMs:         trade.durationMs,
    candlesHeld:    trade.candlesHeld,
  });

  ptState.position = null;
  try { require("../utils/positionPersist").clearStRsiPivBbPosition(); } catch (_) {}
  capitalPool.release("st_rsi_piv_bb", netPnl);
}

// ── Entry guards — ALL synchronous, evaluated before the first await ────────
// The only session guards this strategy has are the entry window (inside the
// engine), max trades/day and the daily loss cap. The repo-global portfolio cap
// and the expiry-only toggle also apply, as on every strategy.
function _entryBlockReason(cfg) {
  if (!ptState.running) return "session not running";
  if (ptState.position) return "position already open";
  if (ptState._entryPending) return "an entry is already in flight";
  if (ptState._expiryDayBlocked) return "expiry-only mode — today is not an expiry day";
  const tf = _tfNote(cfg);
  if (tf) return tf;
  if (ptState._dailyLossHit) return `daily loss limit hit (₹${cfg.MAX_DAILY_LOSS}) — no more entries today`;
  // The cap is read live: lowering it in Settings mid-session blocks at once.
  const _dayPnl = (ptState.sessionPnl || 0) + (ptState._priorRealizedToday || 0);
  if (cfg.MAX_DAILY_LOSS > 0 && _dayPnl <= -cfg.MAX_DAILY_LOSS) {
    ptState._dailyLossHit = true;   // latch, so the status card shows it too
    return `daily loss limit hit (₹${_dayPnl.toFixed(0)} ≤ -₹${cfg.MAX_DAILY_LOSS}) — no more entries today`;
  }
  const _taken = ptState.sessionTrades.length + (ptState._priorTradesToday || 0);
  if (_taken >= cfg.MAX_DAILY_TRADES) return `daily max trades (${cfg.MAX_DAILY_TRADES}) reached`;
  const pf = require("../utils/portfolioRisk").checkPortfolioCap();
  if (pf.blocked) return pf.reason;
  if (engine.isEodExit(Math.floor(Date.now() / 1000), cfg)) return `past the ${_fmtMins(cfg.EOD_EXIT)} square-off`;
  return null;
}

/** The option premium at the fill: the streamed tick if fresh, else a quote. */
async function _fillPremium(symbol, quote) {
  const streamed = optionFeed.getFresh(symbol);
  if (streamed && streamed.ltp > 0) return streamed.ltp;
  if (quote && quote.ltp > 0) return quote.ltp;
  return await fetchOptionLtp(symbol);
}

/**
 * Resolve the contract, run the spread guard, read the fill premium and open the
 * position. Returns { opened, retry } — `retry` marks an INFRASTRUCTURE failure
 * (no symbol / no premium) the caller may re-attempt; a deliberate refusal
 * (spread, capital, session changed) is never retried.
 */
async function _fillEntry(sig, signalCandle, fillSpot, side, sid, attempt) {
  const INSTR = instrumentConfig.INSTRUMENT; // top-level constant
  let res;
  if (INSTR === "NIFTY_FUTURES") {
    const sym = await getSymbol(side);
    res = { symbol: sym, expiry: null, strike: null, invalid: !sym };
  } else {
    const cached = getCachedSymbol(side, fillSpot);
    if (cached) {
      log(`⚡ [PAPER] Using pre-fetched symbol: ${cached.symbol} (spot delta: ${Math.abs(cached.spot - fillSpot).toFixed(0)} pts)`);
      res = cached;
    } else {
      log(`🔍 [PAPER] Cache miss — live symbol lookup`);
      res = await validateAndGetOptionSymbol(fillSpot, side, ACTIVE);   // ATM (not an ITM-steps mode)
    }
  }
  // /stop (or stop + restart) may have run during the await above.
  if (ptState.position || !ptState.running || _entrySessionGen !== sid) return { opened: false, retry: false };
  if (!res || res.invalid || !res.symbol) {
    log(`❌ [PAPER] Cannot enter ${side} — ${res && res.symbol ? `symbol ${res.symbol} invalid on Fyers` : "no option symbol resolved"}.`);
    return { opened: false, retry: true };
  }
  const { symbol, expiry, strike } = res;
  if (INSTR === "NIFTY_FUTURES") {
    log(`🎯 [PAPER] ENTRY ${side === "CE" ? "LONG" : "SHORT"} FUTURES @ ₹${fillSpot} | ${sig.reason}`);
    log(`📌 Futures symbol: ${symbol}`);
  } else {
    const strikeType = Math.abs(strike - Math.round(fillSpot / 50) * 50) === 0 ? "ATM" : "ITM";
    log(`🎯 [PAPER] ENTRY ${side} @ ₹${fillSpot} | ${sig.reason}`);
    log(`📌 ${strikeType} Option: ${symbol} (Spot: ${fillSpot} → Strike: ${strike} | Expiry: ${expiry})`);
  }

  let entryLtp = null;
  if (INSTR !== "NIFTY_FUTURES") {
    // ── Bid-ask spread guard (repo-global, options only) ──
    const _q = await tradeGuards.fetchOptionQuote(fyers, symbol);
    const _sp = tradeGuards.checkSpread(_q && _q.bid, _q && _q.ask);
    if (!_sp.ok) {
      log(`⏭️ [PAPER] SKIP entry — spread too wide (${_sp.reason})`);
      skipLogger.appendSkipLog("st_rsi_piv_bb", {
        gate: "spread",
        reason: _sp.reason || null,
        spot: fillSpot,
        side,
        symbol,
        bid: _q && _q.bid,
        ask: _q && _q.ask,
        path: "candle-close",
      });
      return { opened: false, retry: false };
    }
    // The fill premium = the current option LTP.
    entryLtp = await _fillPremium(symbol, _q);
    if (ptState.position || !ptState.running || _entrySessionGen !== sid) return { opened: false, retry: false };
    if (!(entryLtp > 0)) {
      log(`⚠️ [PAPER] No option LTP for ${symbol} — ${side} entry not filled.`);
      return { opened: false, retry: true };
    }
  }

  // A candle closed while this fill was awaiting: its own decision supersedes
  // this older signal (the newer close may even be a SuperTrend flip).
  const _lastClosed = ptState.candles[ptState.candles.length - 1];
  if (!_lastClosed || _lastClosed.time !== signalCandle.time) {
    log(`⏭️ [PAPER] ${side} fill abandoned — a newer candle closed while it was filling; that candle decides.`);
    return { opened: false, retry: false };
  }

  const _tag = attempt > 0 ? ` | filled on retry #${attempt}` : "";
  simulateBuy(symbol, side, getLotQty(), fillSpot, sig.reason + _tag, sig.stopLoss, fillSpot, {
    entryLtp,
    signal:        sig,
    signalBarTime: signalCandle.time,
    // The fill bar: the one that opens when the signal candle closes.
    entryBarTime:  signalCandle.time + TRADE_RES * 60,
  });
  return { opened: !!ptState.position && ptState.position.symbol === symbol, retry: false };
}

/**
 * Act on a BUY_CE / BUY_PE from a CLOSED trade-TF candle. Every guard runs
 * synchronously and _entryPending is set before the first await, so concurrent
 * ticks can never open two positions. The decision is "locked" only once a
 * position exists: a failed FILL leaves a pending entry that the tick loop
 * retries (throttled) until the next candle close supersedes it.
 */
function _attemptEntry(sig, signalCandle, fillSpot, pending) {
  const cfg  = engine.getConfig();
  const side = sig.signal === "BUY_CE" ? "CE" : "PE";
  const why  = _entryBlockReason(cfg);
  if (why) {
    if (ptState._blockLoggedCandle !== signalCandle.time) {
      ptState._blockLoggedCandle = signalCandle.time;
      log(`🚫 [PAPER] ${side} 4/4 on the ${_hhmm(signalCandle.time + TRADE_RES * 60)} close — entry blocked: ${why}`);
      skipLogger.appendSkipLog("st_rsi_piv_bb", {
        gate: "session", reason: why, spot: fillSpot, side, signal: sig.signal,
        path: pending ? "retry" : "candle-close",
      });
    }
    if (pending) ptState._pendingEntry = null;
    else if (ptState._entryPending && !ptState.position && ptState.running) {
      // An older fill is still in flight. It abandons itself once it sees this
      // newer close, so park THIS signal for the tick loop to retry — otherwise
      // the newer 4/4 is lost along with the stale one.
      ptState._pendingEntry = { sig, candle: signalCandle, attempts: 0, lastAttemptMs: 0 };
    }
    return;
  }
  ptState._entryPending = true;   // synchronous — before the first await
  const sid = _entrySessionGen;
  const attempt = pending ? pending.attempts : 0;
  // Safety: an unforeseen hang must never wedge entries for the rest of the day.
  const _safety = setTimeout(() => { if (ptState._entryPending) ptState._entryPending = false; }, 20000);
  _fillEntry(sig, signalCandle, fillSpot, side, sid, attempt)
    .catch((err) => {
      // A thrown lookup / quote is an infrastructure failure — retryable.
      log(`❌ [PAPER] Entry error: ${err.message}`);
      return { opened: false, retry: true };
    })
    .then((r) => {
      // Only ever touch the pending slot this attempt owns.
      if (ptState._pendingEntry && ptState._pendingEntry !== pending) return;
      if (r && r.opened) { ptState._pendingEntry = null; return; }
      // Hold the setup for a throttled retry only while THIS candle is still the
      // latest close — a newer close is the current truth and must not be overtaken.
      const lastClosed = ptState.candles.length ? ptState.candles[ptState.candles.length - 1].time : null;
      if (r && r.retry && ptState.running && _entrySessionGen === sid && !ptState.position && lastClosed === signalCandle.time) {
        const p = pending || { sig, candle: signalCandle, attempts: 0 };
        p.lastAttemptMs = Date.now();
        ptState._pendingEntry = p;
        if (!pending) log(`⚠️ [PAPER] ${side} fill failed — retrying every ${ENTRY_RETRY_MS / 1000}s until the next ${TRADE_RES}-min close`);
      } else {
        ptState._pendingEntry = null;
      }
    })
    .finally(() => { ptState._entryPending = false; clearTimeout(_safety); });
}

/** Tick-driven, throttled re-attempt of a signalled entry whose FILL failed. */
function _retryPendingEntry(ltp) {
  const p = ptState._pendingEntry;
  if (!p || ptState.position || ptState._entryPending) return;
  if (Date.now() - (p.lastAttemptMs || 0) < ENTRY_RETRY_MS) return;
  p.attempts = (p.attempts || 0) + 1;
  p.lastAttemptMs = Date.now();
  log(`🔁 [PAPER] Retrying ${p.sig.signal} fill (attempt ${p.attempts}) @ spot ₹${ltp}`);
  _attemptEntry(p.sig, p.candle, ltp, p);
}

// ── On each completed trade-timeframe candle ─────────────────────────────────
// Synchronous: the exit test, the trail and the entry decision all run on the
// tick that closed the candle. `fillSpot` is that tick's price (the first tick
// after the close) — the fill for both an exit and an entry.
function onCandleClose(candle, fillSpot) {
  // A new close supersedes any setup still waiting on a failed fill.
  ptState._pendingEntry = null;
  _pushCapped(ptState.candles, candle);
  ptState.prevCandleHigh = candle.high;
  ptState.prevCandleLow  = candle.low;

  const cfg     = engine.getConfig();
  const fill    = Number.isFinite(fillSpot) && fillSpot > 0 ? fillSpot : candle.close;
  const closeAt = _hhmm(candle.time + TRADE_RES * 60);
  const tag     = `${TRADE_RES}m`;
  _ensurePivots(engine._istDayOf(candle.time));

  // ── Pre-fetch option symbols in background so entry is instant ──
  if (!ptState.position) prefetchOptionSymbols(candle.close).catch(() => {});

  // ── The signal — closed candles only; BOTH also reads the closed 5-min bars ──
  const sig = engine.getSignal(ptState.candles, {
    pivots:         ptState.pivots,
    confirmCandles: CONFIRM_RES ? ptState.candles5 : undefined,
    silent:         !!ptState.position,
  });
  ptState.lastSignal = {
    time:          candle.time,
    closeTime:     candle.time + TRADE_RES * 60,
    close:         candle.close,
    signal:        sig.signal,
    reason:        sig.reason || null,
    warmup:        !!sig.warmup,
    checks:        sig.checks || null,
    confirmChecks: sig.confirmChecks || null,
    confirmTime:   sig.confirmTime || null,
  };

  log(`📊 [PAPER] ──── ${tag} candle close ${closeAt} ──────────────────────────────`);
  log(`   OHLC: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close}`);
  log(`   ST=${sig.supertrend != null ? sig.supertrend : "?"}(${sig.stTrend || "?"}) | RSI=${sig.rsi != null ? sig.rsi : "?"} | BB ${sig.bbLower != null ? sig.bbLower : "?"} / ${sig.bbUpper != null ? sig.bbUpper : "?"} | R1 ${sig.r1 != null ? sig.r1 : "?"} S1 ${sig.s1 != null ? sig.s1 : "?"}`);
  log(`   Signal: ${sig.signal} | ${sig.reason}`);

  // ── EXIT — candle close only: exitCheck with the stop in force BEFORE this bar ──
  let exitedThisBar = false;
  if (ptState.position) {
    const pos = ptState.position;
    pos.candlesHeld = (pos.candlesHeld || 0) + 1;
    const series = engine.computeSeries(ptState.candles, cfg);
    const stBar  = series.supertrend[ptState.candles.length - 1] || null;
    const stopBefore = pos.stopLoss;
    const ex = engine.exitCheck(pos.side, candle, stBar, stopBefore);
    const _gap = Number.isFinite(stopBefore)
      ? parseFloat((pos.side === "CE" ? candle.close - stopBefore : stopBefore - candle.close).toFixed(1))
      : null;
    log(`   Open ${pos.side} @ ₹${pos.spotAtEntry} | SL=₹${stopBefore} (gap=${_gap != null ? _gap : "—"}pt) | option entry=${pos.optionEntryLtp ? "₹" + pos.optionEntryLtp : "—"} now=${ptState.optionLtp ? "₹" + ptState.optionLtp : "—"}`);
    if (ex.exit) {
      log(`🛑 [PAPER] EXIT ${pos.side} on the ${closeAt} close — ${ex.reason} (stop in force ₹${stopBefore}) | fill spot ₹${fill}`);
      simulateSell(fill, ex.reason, fill, candle.time + TRADE_RES * 60, {
        supertrend: stBar && Number.isFinite(stBar.value) ? stBar.value : null,
        stTrend:    stBar ? stBar.trend : null,
      });
      exitedThisBar = true;
    } else {
      // ── Trail — engine.trailStop() is tighten-only (a CE stop may only rise).
      const _trail = engine.trailStop(ptState.candles, pos.side, pos.stopLoss, cfg);
      if (_trail && _trail.changed && Number.isFinite(_trail.stop)) {
        const _o = pos.stopLoss;
        pos.stopLoss = _trail.stop;
        log(`📐 [PAPER] SL trail ${pos.side}: ₹${_o} → ₹${pos.stopLoss} (${_trail.tag || "SuperTrend"})`);
        try { require("../utils/positionPersist").saveStRsiPivBbPosition(pos, { sessionPnl: ptState.sessionPnl }); } catch (_) {}
      }
    }
  }

  // ── Session end at TRADE_STOP_TIME (the timer also does this) ──
  const _nowMin = getISTMinutes();
  if (_nowMin >= _STOP_MINS) {
    const _stopLabel = _fmtMins(_STOP_MINS);
    if (ptState.position) {
      log("⏰ [PAPER] Session end " + _stopLabel + " — auto square off");
      simulateSell(fill, "Session end square-off " + _stopLabel, fill);
    }
    if (ptState.running) {
      log(`\n📅 [PAPER] ──── SESSION COMPLETE ────────────────────────────────────`);
      log(`   Trades: ${(ptState.sessionTrades||[]).length} | ${ptState._sessionWins}W / ${ptState._sessionLosses}L | PnL=₹${ptState.sessionPnl||0}`);
      log(`════════════════════════════════════════════════════════════════════\n`);
      log("⏰ [PAPER] Market closed (" + _stopLabel + " IST) — auto-stopping paper trade engine.");
      ptState.running = false;
      _releaseLiveHarness("EOD auto-stop");   // after the square-off above
      saveSession();
      // Clear THIS slot first, then stop the shared socket only if no other
      // strategy is still subscribed.
      socketManager.removeCallback(SOCKET_CALLBACK_ID);
      sharedSocketState.clearStRsiPivBbMode();
      if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) {
        socketManager.stop();
      } else if (sharedSocketState.isAnyActive()) {
        log("📡 [PAPER] Socket kept alive — another strategy is still active");
      }
      stopOptionPolling();
    }
    return;
  }

  if (sig.signal !== "BUY_CE" && sig.signal !== "BUY_PE") {
    if (!ptState.position && !exitedThisBar) {
      skipLogger.appendSkipLog("st_rsi_piv_bb", {
        gate: "strategy",
        reason: sig.reason || null,
        spot: candle.close,
        rsi: sig.rsi ?? null,
        bbUpper: sig.bbUpper ?? null,
        bbLower: sig.bbLower ?? null,
        supertrend: sig.supertrend ?? null,
        stTrend: sig.stTrend ?? null,
        r1: sig.r1 ?? null,
        s1: sig.s1 ?? null,
        ceCount: sig.checks && sig.checks.CE ? sig.checks.CE.count : null,
        peCount: sig.checks && sig.checks.PE ? sig.checks.PE.count : null,
        tf: tag,
      });
    }
    return;
  }

  // A 4/4 on the very candle that closed a trade is not taken: re-entry is
  // allowed from the NEXT closed candle onward (until the trade cap).
  if (exitedThisBar) {
    log(`⏭️ [PAPER] ${sig.signal} 4/4 on the exit candle — not re-entered on the same close`);
    skipLogger.appendSkipLog("st_rsi_piv_bb", { gate: "strategy", reason: "4/4 on the exit candle — re-entry waits for a later candle", spot: fill, signal: sig.signal, tf: tag });
    return;
  }
  if (ptState.position) return;

  log(`📋 [PAPER] ${sig.signal} — entering on the ${closeAt} close, fill @ spot ₹${fill}`);
  _attemptEntry(sig, candle, fill, null);
}

// ── Tick → candle builder (NIFTY SPOT ONLY) ──────────────────────────────────
// This handler receives ONLY NSE:NIFTY50-INDEX ticks. It builds the trade-TF
// candles (and, in BOTH, the 5-min candles), applies the EOD square-off and the
// global profit lock, and retries a failed fill. It makes NO entry decision and
// runs NO stop check — both happen on candle close.
function onTick(tick) {
  if (!tick || !tick.ltp) return;
  if (!ptState.running) return;  // ← guard: ignore ticks after stop (Fyers SDK may still fire)

  ptState.tickCount++;
  const now = Date.now();
  const ltp = tick.ltp;
  ptState.lastTickTime  = now; // raw ms — formatted only on status poll
  ptState.lastTickPrice = ltp;

  // ── 1. BOTH: the 5-min confirmation series FIRST ──────────────────────────
  // On a tick that closes both a 5-min and a 3-min candle (09:45:00 …) the 5-min
  // candle must already be appended when the 3-min close is evaluated below — the
  // engine refuses when the 5-min candle covering that moment is missing.
  if (CONFIRM_RES) {
    const b5 = _bucketMs(now, CONFIRM_RES);
    if (_istMinOfMs(b5) >= _MKT_OPEN_MINS) {
      if (!ptState.currentBar5 || ptState.barStartTime5 !== b5) {
        if (ptState.currentBar5) _pushCapped(ptState.candles5, ptState.currentBar5);
        ptState.currentBar5 = { time: Math.floor(b5 / 1000), open: ltp, high: ltp, low: ltp, close: ltp, volume: tick.vol_traded_today || 0 };
        ptState.barStartTime5 = b5;
      } else {
        const b = ptState.currentBar5;
        b.high = Math.max(b.high, ltp);
        b.low  = Math.min(b.low, ltp);
        b.close = ltp;
        b.volume = tick.vol_traded_today || b.volume;
      }
    }
  }

  // ── 2. The trade-timeframe series ──────────────────────────────────────────
  // Skip pre-market / pre-open candles (build only from 09:15 NSE open). Gated on
  // the BUCKET's IST time so it is correct in live AND replay.
  const bucket = _bucketMs(now, TRADE_RES);
  if (_istMinOfMs(bucket) < _MKT_OPEN_MINS) return;

  if (!ptState.currentBar || ptState.barStartTime !== bucket) {
    if (ptState.currentBar) {
      try { onCandleClose(ptState.currentBar, ltp); }
      catch (err) { console.error(`[ST_RSI_PIV_BB-PAPER] onCandleClose error: ${err.stack || err.message}`); }
      if (!ptState.running) return;   // the close ended the session (TRADE_STOP_TIME)
    }
    ptState.currentBar = {
      time:   Math.floor(bucket / 1000),
      open:   ltp,
      high:   ltp,
      low:    ltp,
      close:  ltp,
      volume: tick.vol_traded_today || 0,
    };
    ptState.barStartTime = bucket;
  } else {
    const bar  = ptState.currentBar;
    bar.high   = Math.max(bar.high, ltp);
    bar.low    = Math.min(bar.low,  ltp);
    bar.close  = ltp;
    bar.volume = tick.vol_traded_today || bar.volume;
  }

  if (ptState.position) {
    const pos = ptState.position;
    // ── MFE/MAE + best price (spot pts in trade direction) — observer-only ──
    const _favPts = (ltp - pos.spotAtEntry) * (pos.side === "CE" ? 1 : -1);
    if (_favPts > (pos.mfeSpotPts || 0)) { pos.mfeSpotPts = parseFloat(_favPts.toFixed(2)); pos.secsToMFE = parseFloat(((now - pos.entryTimeMs) / 1000).toFixed(1)); }
    if (_favPts < (pos.maeSpotPts || 0)) { pos.maeSpotPts = parseFloat(_favPts.toFixed(2)); pos.secsToMAE = parseFloat(((now - pos.entryTimeMs) / 1000).toFixed(1)); }
    if (pos.side === "CE") { if (!pos.bestPrice || ltp > pos.bestPrice) pos.bestPrice = ltp; }
    else                   { if (!pos.bestPrice || ltp < pos.bestPrice) pos.bestPrice = ltp; }
    if (ptState.optionLtp && ptState.optionLtp > (pos.bestOptionLtp || 0)) pos.bestOptionLtp = parseFloat(ptState.optionLtp.toFixed(2));

    // ── Forced square-off at ST_RSI_PIV_BB_EOD_EXIT_TIME (tick-driven) ──
    const cfg = engine.getConfig();
    if (engine.isEodExit(Math.floor(now / 1000), cfg)) {
      const _lbl = _fmtMins(cfg.EOD_EXIT);
      log(`⏰ [PAPER] ${_lbl} square-off — closing open ${pos.side} @ spot ₹${ltp}`);
      simulateSell(ltp, `EOD square-off ${_lbl}`, ltp);
      return;
    }

    // ── Global profit lock (shared across every strategy — see tradeGuards) ──
    // Options only — the lock is defined on option premium, and a futures leg has
    // none. This strategy has NO tick-level stop of its own; this is the repo-wide
    // guard every strategy runs.
    if (!pos.isFutures && pos.optionEntryLtp && ptState.optionLtp) {
      const _plMsg = tradeGuards.checkProfitLock(
        pos.optionEntryLtp, ptState.optionLtp, pos.bestOptionLtp,
      );
      if (_plMsg) {
        log(`🔒 [PAPER] ${_plMsg}`);
        simulateSell(ltp, _plMsg, ltp);
        return;
      }
    }
    return;
  }

  // ── Flat: retry a signalled entry whose fill failed (throttled) ──
  if (ptState._pendingEntry) _retryPendingEntry(ltp);
}

// -- Save completed session to disk ───────────────────────────────────────────

function saveSession() {
  const data = loadPaperData();

  const session = {
    // IST, not UTC — the daily-loss restart recovery matches on this field.
    date:        new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    strategy:    ACTIVE,
    instrument:  instrumentConfig.INSTRUMENT,
    entryTf:     _SESSION_ENTRY_TF,
    tradeRes:    TRADE_RES,
    startTime:   ptState.sessionStart,
    endTime:     istNow(),
    trades:      ptState.sessionTrades,
    totalTrades: ptState.sessionTrades.length,
    wins:        ptState._sessionWins,
    losses:      ptState._sessionLosses,
    winRate:     ptState.sessionTrades.length
                   ? `${((ptState._sessionWins / ptState.sessionTrades.length) * 100).toFixed(1)}%`
                   : "N/A",
    sessionPnl:  ptState.sessionPnl,
  };

  data.sessions.push(session);
  data.totalPnl = parseFloat((data.totalPnl + ptState.sessionPnl).toFixed(2));
  data.capital  = parseFloat((data.capital  + ptState.sessionPnl).toFixed(2));

  savePaperData(data);
  ptState._pnlSaved = true;   // same step the file's totalPnl gained it
  capitalPool.sessionSaved("st_rsi_piv_bb");
  log(`💾 Session saved. Running capital: ₹${data.capital} | Total PnL: ₹${data.totalPnl}`);

  // ── Daily Report + Telegram EOD ──────────────────────────────────────────────
  generatePaperDailyReport(ptState.sessionTrades, ptState.sessionPnl);

  return session;
}

/** Bucket an exit reason for the day report. Order matters: specific first. */
function _exitGroup(reason) {
  const r = String(reason || "");
  if (/SuperTrend flipped/i.test(r))            return "ST Flip";
  if (/SuperTrend stop/i.test(r))               return "ST Stop (close)";
  if (/Profit lock/i.test(r))                   return "Profit Lock";
  if (/EOD square-off/i.test(r))                return "EOD Square-off";
  if (/Manual/i.test(r))                        return "Manual Exit";
  if (/Session end|Auto-stop|Shutdown|stop/i.test(r)) return "Session Stop";
  return "Other";
}

function generatePaperDailyReport(trades, sessionPnl) {
  try {
    if (!trades || trades.length === 0) {
      if (canSend("TG_ST_RSI_PIV_BB_DAYREPORT")) {
        sendTelegram([
          `📄 ST_RSI_PIV_BB PAPER — DAY REPORT`,
          `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" })}`,
          ``,
          `No trades taken today.`,
          `Session PnL: ₹0`,
        ].join("\n"));
      }
      return;
    }

    const wins    = trades.filter(t => t.pnl > 0);
    const losses  = trades.filter(t => t.pnl < 0);
    const winRate = ((wins.length / trades.length) * 100).toFixed(1);
    const avgWin  = wins.length   ? (wins.reduce((s, t) => s + t.pnl, 0)   / wins.length).toFixed(0)   : 0;
    const avgLoss = losses.length ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(0) : 0;
    const best    = trades.reduce((b, t) => t.pnl > b.pnl ? t : b, trades[0]);
    const worst   = trades.reduce((w, t) => t.pnl < w.pnl ? t : w, trades[0]);

    const exitGroups = {};
    trades.forEach(t => {
      const label = _exitGroup(t.exitReason);
      if (!exitGroups[label]) exitGroups[label] = { count: 0, pnl: 0, wins: 0 };
      exitGroups[label].count++;
      exitGroups[label].pnl += t.pnl;
      if (t.pnl > 0) exitGroups[label].wins++;
    });

    const pnlEmoji = sessionPnl >= 0 ? "🟢" : "🔴";
    const dateStr  = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });

    // Console log
    log(`\n${"═".repeat(54)}`);
    log(`📊 PAPER DAILY JOURNAL — ${dateStr}`);
    log(`${"─".repeat(54)}`);
    log(`   Trades    : ${trades.length} (${wins.length}W / ${losses.length}L)`);
    log(`   Win Rate  : ${winRate}%`);
    log(`   Session PnL: ${pnlEmoji} ₹${sessionPnl}`);
    log(`   Avg Win   : ₹${avgWin} | Avg Loss: ₹${avgLoss}`);
    log(`   Best : ₹${best.pnl} | Worst: ₹${worst.pnl}`);
    log(`${"─".repeat(54)}`);
    Object.entries(exitGroups)
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([label, g]) => {
        log(`   ${label.padEnd(18)}: ${g.count}x WR=${((g.wins/g.count)*100).toFixed(0)}% PnL=₹${g.pnl.toFixed(0)}`);
      });
    log(`${"═".repeat(54)}\n`);

    // Telegram
    const exitBreakdown = Object.entries(exitGroups)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([label, g]) => `  ${label}: ${g.count}x WR${((g.wins/g.count)*100).toFixed(0)}% ₹${g.pnl.toFixed(0)}`)
      .join("\n");

    if (canSend("TG_ST_RSI_PIV_BB_DAYREPORT")) {
      sendTelegram([
        `📄 ST_RSI_PIV_BB PAPER — DAY REPORT`,
        `📅 ${dateStr}`,
        ``,
        `Trades   : ${trades.length}  (${wins.length}W / ${losses.length}L)`,
        `Win Rate : ${winRate}%`,
        `Session  : ${pnlEmoji} ₹${sessionPnl}`,
        `Avg Win  : ₹${avgWin}  |  Avg Loss: ₹${avgLoss}`,
        ``,
        `Exit Breakdown:`,
        exitBreakdown,
        ``,
        `Best : ₹${best.pnl} — ${best.side} ${best.exitReason}`,
        `Worst: ₹${worst.pnl} — ${worst.side} ${worst.exitReason}`,
      ].join("\n"));
    }

  } catch (err) {
    log(`⚠️ [PAPER] Daily report error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Preload the last `days` TRADING days (plus today) of CLOSED candles at
 * `resMin`. The fetch reaches back days×2+7 calendar days so a weekend next to a
 * holiday still yields `days` real sessions, then trims to them. Fyers history
 * includes today's still-forming bar: it is returned separately (to seed the live
 * bar) and never fed to the engine. Direct fetch — no candle cache — so a stale
 * partial day can never leave holes in the path-dependent SuperTrend.
 */
async function _preloadSeries(resMin, days, todayStr) {
  const { fetchCandles } = require("../services/backtestEngine");
  const fromDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  fromDate.setDate(fromDate.getDate() - (days * 2 + 7));
  const fromStr = fromDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const raw = await fetchCandles(NIFTY_INDEX_SYMBOL, String(resMin), fromStr, todayStr);
  const nowSec = Math.floor(Date.now() / 1000);
  const closed = [];
  let forming = null;
  for (const c of (Array.isArray(raw) ? raw : [])) {
    if (!c || typeof c.time !== "number") continue;
    if (c.time + resMin * 60 <= nowSec) closed.push(c);
    else if (c.time <= nowSec) forming = c;
  }
  closed.sort((a, b) => a.time - b.time);
  // Keep today plus the newest `days` earlier sessions that actually traded.
  const todayKey = engine._istDayOf(nowSec);
  const prior = [...new Set(closed.map(c => engine._istDayOf(c.time)).filter(k => k < todayKey))].slice(-days);
  const keep = new Set(prior.concat([todayKey]));
  const kept = closed.filter(c => keep.has(engine._istDayOf(c.time)));
  return { closed: kept.slice(-MAX_BARS), forming, fromStr: kept.length ? tradeLogger.istDateString(kept[0].time * 1000) : fromStr };
}

/**
 * GET /st_rsi_piv_bb-paper/start
 * Connects to live Fyers socket and starts simulating trades
 */
router.get("/start", async (req, res) => {
  // Already running: refuse BEFORE touching the harness — an attached harness
  // belongs to that running session, and detaching it would let the open
  // position's exit skip the broker.
  if (ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading already running." });
  }

  // Live-harness safety net — before every other early return. Only the
  // *LiveHarness twin (which passes _viaHarness=1) may start paper with it attached.
  if (!req.query || req.query._viaHarness !== "1") {
    if (_releaseLiveHarness("paper /start — harness was still installed")) {
      console.log(`🛑 [${LIVE_HARNESS_MODE}] A live harness was still attached and has been REMOVED before starting. This session is paper-only.`);
    }
  }

  // Re-read env into module-level config so Settings UI changes and replay
  // env overrides take effect for this session (fixes the candle resolution).
  _refreshConfig();

  // Verify the Fyers token actually works before we wire up the socket.
  const auth = await verifyFyersToken();
  if (!auth.ok) {
    return res.status(401).json({ success: false, error: auth.message, code: auth.code });
  }
  if (ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading already running." });
  }

  // Master + per-mode toggles, both default OFF (the strategy ships dark until it
  // has been paper-validated).
  if (String(process.env.ST_RSI_PIV_BB_MODE_ENABLED || "false").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "ST_RSI_PIV_BB is disabled. Enable ST_RSI_PIV_BB Mode in Settings first." });
  }
  if (String(process.env.ST_RSI_PIV_BB_PAPER_ENABLED || "false").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "ST_RSI_PIV_BB paper trading is disabled. Enable ST_RSI_PIV_BB Paper Trading in Settings first." });
  }

  // Own mutex slot: ST_RSI_PIV_BB Paper ⊥ ST_RSI_PIV_BB Live, parallel with every other strategy.
  {
    const _gate = sharedSocketState.canStart("ST_RSI_PIV_BB_PAPER");
    if (!_gate.allowed) {
      return res.status(400).json({ success: false, error: `Cannot start ST_RSI_PIV_BB paper trading — ${_gate.reason}` });
    }
  }

  // ── Trading session validation (holidays + time check) ────────────────────
  const tradingCheck = await isTradingAllowed();
  if (!tradingCheck.allowed) {
    return res.status(400).json({ success: false, error: `❌ ${tradingCheck.reason}` });
  }

  // ── Start gate: allow any time before TRADE_STOP_TIME ─────────────────────
  if (!isStartAllowed()) {
    return res.status(400).json({
      success: false,
      error: "Trading session closed for today — past " + _fmtMins(_STOP_MINS) + " IST. Restart tomorrow.",
    });
  }
  if (ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading already running." });
  }

  const subscribeSymbol = NIFTY_INDEX_SYMBOL;
  const data        = loadPaperData();
  // IST date — toISOString() gives UTC which is 5:30 behind IST and returns wrong date before 5:30 AM UTC
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // "YYYY-MM-DD" in IST
  const cfg = engine.getConfig();

  // Reset session state
  _entrySessionGen++;
  // Safety net: drop any reservation a previous session of THIS strategy leaked.
  capitalPool.clear("st_rsi_piv_bb");
  ptState.running       = true;
  ptState.candles       = [];
  ptState.currentBar    = null;
  ptState.barStartTime  = null;
  ptState.candles5      = [];
  ptState.currentBar5   = null;
  ptState.barStartTime5 = null;
  ptState.position      = null;
  ptState.sessionTrades = [];
  ptState._staleSession = false;
  ptState.sessionPnl    = 0;
  ptState._pnlSaved     = false;
  ptState.sessionStart  = istNow();
  ptState.log           = [];
  ptState.tickCount     = 0;
  ptState._entryPending = false;
  ptState._pendingEntry = null;
  ptState.lastSignal    = null;
  ptState.pivots        = null;
  ptState._pivotsError  = null;
  ptState._pivotsLastTryMs = 0;
  ptState.lastTickTime  = null;
  ptState.lastTickPrice  = null;
  ptState.prevCandleHigh = null;
  ptState.prevCandleLow  = null;
  ptState.optionLtp      = null;
  ptState.optionLtpUpdatedAt = null;   // staleness tracking
  ptState._ltpStaleLogged    = false;
  ptState.optionSymbol   = null;
  ptState.optionChart    = null;
  ptState._consecutiveLosses   = 0;
  ptState._dailyLossHit        = false; // reset daily kill switch on new session
  ptState._priorRealizedToday  = 0;     // re-seeded from disk just below
  ptState._priorTradesToday    = 0;
  _confirmChkCache = { key: null, value: null };
  _chartSeriesCache = { key: null, value: null };
  // ── Daily-loss / trade-cap RESTART RECOVERY ───────────────────────────────
  // A stop→start (or crash + PM2 restart) mid-day must not hand the day a fresh
  // loss budget or a fresh trade allowance. Earlier sessions' realized P&L and
  // trade count are kept in SEPARATE fields (saveSession persists sessionPnl
  // verbatim, so seeding it would double-count on the next restart).
  try {
    // NOT during replay. Replay patches Date.now() to the recorded session's
    // clock and loadPaperData() is the REAL session store — reading it would
    // react to the replayed day's actual result and destroy determinism.
    let _inReplay = false;
    try { _inReplay = require("../services/tickReplay").isReplayInProgress(); } catch (_) {}
    if (_inReplay) throw { __skip: true };

    let _realized = 0, _taken = 0;
    const _keyOf = (t) => String(t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`);
    const _savedKeys = new Set();
    for (const s of (data.sessions || [])) {
      for (const t of (s.trades || [])) _savedKeys.add(_keyOf(t));
      if (String(s.date || "").slice(0, 10) === todayStr) {
        _realized += Number(s.sessionPnl) || 0;
        _taken    += Array.isArray(s.trades) ? s.trades.length : (Number(s.totalTrades) || 0);
      }
    }
    // A crash (kill -9, OOM) never runs saveSession(): its trades exist ONLY in
    // today's day file. Count them too, or the restart gets a fresh allowance.
    for (const t of tradeLogger.readDailyTrades("st_rsi_piv_bb", todayStr)) {
      if (!t || t.type || !(t.side || t.entryTime || t.entryBarTime || t.symbol)) continue;
      if (_savedKeys.has(_keyOf(t))) continue;
      _realized += Number(t.pnl) || 0;
      _taken++;
    }
    ptState._priorTradesToday = _taken;
    if (_realized !== 0 || _taken > 0) {
      ptState._priorRealizedToday = parseFloat(_realized.toFixed(2));
      if (cfg.MAX_DAILY_LOSS > 0 && ptState._priorRealizedToday <= -Math.abs(cfg.MAX_DAILY_LOSS)) {
        ptState._dailyLossHit = true;
        log(`♻️ [PAPER] Restart recovery — today's realized ₹${ptState._priorRealizedToday} ≤ -₹${cfg.MAX_DAILY_LOSS}: daily kill-switch RE-ARMED (no new entries)`);
      } else {
        log(`♻️ [PAPER] Restart recovery — today's earlier sessions: ${_taken} trade(s), realized ₹${ptState._priorRealizedToday} (caps count session + earlier)`);
      }
    }
  } catch (e) {
    if (e && e.__skip) log(`♻️ [PAPER] Replay run — daily-loss restart recovery skipped (must not read the real session store)`);
    else log(`⚠️ [PAPER] daily-loss restart recovery failed: ${e.message}`);
  }
  ptState._cachedCE            = null; // clear pre-fetch cache on session start
  ptState._cachedPE            = null;
  ptState._blockLoggedCandle   = null;
  ptState._sessionWins         = 0;
  ptState._sessionLosses       = 0;
  ptState._expiryDayBlocked    = false;
  _tradesMapCache = []; _tradesMapCount = 0; // clear cached trades for poll
  stopOptionPolling();

  // Expiry day check
  if ((process.env.TRADE_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
    const { isExpiryDay } = require("../utils/nseHolidays");
    const isExpiry = await isExpiryDay();
    if (!isExpiry) ptState._expiryDayBlocked = true;
    log(`📅 [PAPER] Expiry-only mode: ${isExpiry ? "✅ Today is expiry — trading allowed" : "❌ Not expiry day — entries blocked"}`);
  }

  const _eodLabel = _fmtMins(cfg.EOD_EXIT);
  const _tfLabel  = cfg.CONFIRM_RES ? `${cfg.TRADE_RES}-min + ${cfg.CONFIRM_RES}-min confirm (ENTRY_TF=BOTH)` : `${cfg.TRADE_RES}-min (ENTRY_TF=${cfg.ENTRY_TF})`;

  log(`\n════════════════════════════════════════════════════════════════════`);
  log(`🟡 [PAPER] Paper trading started`);
  log(`   Strategy   : ${ACTIVE} — ${engine.DESCRIPTION}`);
  log(`   Timeframe  : ${_tfLabel}`);
  log(`   Instrument : ${instrumentConfig.INSTRUMENT}`);
  log(`   Capital    : ₹${data.capital.toLocaleString("en-IN")}`);
  // Every number here comes from the engine's own config, so the banner can
  // never drift from the rules that actually run.
  log(`   Entry      : CE = ST(${cfg.ST_PERIOD},${cfg.ST_MULT}) green + RSI(${cfg.RSI_PERIOD})>${cfg.RSI_CE_MIN} + C>R1 + C>BB(${cfg.BB_PERIOD},${cfg.BB_STDDEV}) up | PE = ST red + RSI<${cfg.RSI_PE_MAX} + C<S1 + C<BB low — all four, closed candle, no confirmation candle`);
  log(`   Window     : ${_fmtMins(cfg.ENTRY_START)} → ${_fmtMins(cfg.ENTRY_END)} IST (signal candle close) | square-off ${_eodLabel} | session end ${_fmtMins(_STOP_MINS)}`);
  log(`   Exit       : candle close only — SuperTrend flip, or close beyond the trailed SuperTrend stop (no tick-level stop)`);
  log(`   Risk guards: MaxDailyLoss=₹${cfg.MAX_DAILY_LOSS}${cfg.MAX_DAILY_LOSS > 0 ? "" : " (off)"} | MaxTrades=${cfg.MAX_DAILY_TRADES}`);
  log(`════════════════════════════════════════════════════════════════════\n`);

  // Telegram: session started + checklist
  const _ptChecks = { fyers: { ok: false, msg: "" }, symbol: { ok: false, msg: "" } };
  try {
    const { getLiveSpot } = require("../config/instrument");
    const [spotResult] = await Promise.allSettled([
      getLiveSpot().then(s => { if (!s || s <= 0) throw new Error("spot=0"); return s; }),
    ]);
    if (spotResult.status === "fulfilled") {
      const spot = spotResult.value;
      const atm  = Math.round(spot / 50) * 50;
      _ptChecks.fyers = { ok: true, msg: `NIFTY ₹${spot} | ATM ${atm}` };
      try {
        const [ce, pe] = await Promise.all([
          validateAndGetOptionSymbol(spot, "CE", ACTIVE),
          validateAndGetOptionSymbol(spot, "PE", ACTIVE),
        ]);
        if (!ce.invalid && ce.symbol) {
          _ptChecks.symbol = { ok: true, msg: `${ce.symbol.split(":")[1]} / ${pe.symbol.split(":")[1]}` };
        } else {
          _ptChecks.symbol = { ok: false, msg: "CE invalid — next expiry may not be live" };
        }
      } catch (e) { _ptChecks.symbol = { ok: false, msg: e.message }; }
    } else {
      _ptChecks.fyers = { ok: false, msg: spotResult.reason?.message || "could not fetch spot" };
    }
  } catch (_) {}

  // ── Pivots — the previous day's H/L/C. Awaited so the first close can trade. ──
  await _refreshPivots(engine._istDayOf(Math.floor(Date.now() / 1000)));

  const _ptAllOk = _ptChecks.fyers.ok && _ptChecks.symbol.ok && !!ptState.pivots;
  notifyStarted({
    mode: "ST_RSI_PIV_BB-PAPER",
    text: [
      `${_ptAllOk ? "✅" : "⚠️"} ST_RSI_PIV_BB PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${ACTIVE}`,
      `Timeframe : ${_tfLabel}`,
      `Instrument: ${instrumentConfig.INSTRUMENT}`,
      `Capital   : ₹${data.capital.toLocaleString("en-IN")}`,
      `Window    : ${_fmtMins(cfg.ENTRY_START)} → ${_fmtMins(cfg.ENTRY_END)} IST (entries) · square-off ${_eodLabel}`,
      `Max Loss  : ₹${cfg.MAX_DAILY_LOSS} | Max Trades: ${cfg.MAX_DAILY_TRADES}`,
      ``,
      `Pre-Market Checklist:`,
      `${_ptChecks.fyers.ok  ? "✅" : "❌"} Fyers   : ${_ptChecks.fyers.msg}`,
      `${_ptChecks.symbol.ok ? "✅" : "⚠️"} Symbols : ${_ptChecks.symbol.msg || "not checked"}`,
      `${ptState.pivots ? "✅" : "❌"} Pivots  : ${ptState.pivots ? `R1 ${ptState.pivots.r1} / S1 ${ptState.pivots.s1} (from ${ptState.pivots.from})` : "No R1/S1 — daily candles unavailable"}`,
    ].join("\n"),
  });

  // ── PRE-LOAD history on every timeframe the engine reads ──────────────────
  // The engine refuses below engine.warmupBars() bars on EACH chart (25 at the
  // defaults: 75 min of 3-min, 125 min of 5-min) — so whole DAYS are preloaded
  // (ST_RSI_PIV_BB_WARMUP_DAYS) and a 09:15 start trades immediately.
  const _needBars = engine.warmupBars(cfg);
  const _days     = engine.warmupDays();
  try {
    log(`📥 Pre-loading ${_days} day(s) of history so the strategy warms up instantly...`);
    const main = await _preloadSeries(TRADE_RES, _days, todayStr);
    ptState.candles = main.closed;
    log(`✅ Pre-loaded ${ptState.candles.length} × ${TRADE_RES}-min candles (from ${main.fromStr} to ${todayStr}; engine needs ${_needBars})`);
    if (ptState.candles.length < _needBars) {
      log(`⚠️  Only ${ptState.candles.length}/${_needBars} ${TRADE_RES}-min candles — the engine will report warm-up and refuse entries. Raise ST_RSI_PIV_BB_WARMUP_DAYS.`);
    }
    if (main.forming && _istMinOfMs(main.forming.time * 1000) >= _MKT_OPEN_MINS && !ptState.currentBar) {
      ptState.currentBar   = { time: main.forming.time, open: main.forming.open, high: main.forming.high, low: main.forming.low, close: main.forming.close, volume: main.forming.volume || 0 };
      ptState.barStartTime = main.forming.time * 1000;
    }
    if (CONFIRM_RES) {
      const conf = await _preloadSeries(CONFIRM_RES, _days, todayStr);
      ptState.candles5 = conf.closed;
      log(`✅ Pre-loaded ${ptState.candles5.length} × ${CONFIRM_RES}-min confirmation candles (engine needs ${_needBars})`);
      if (ptState.candles5.length < _needBars) {
        log(`⚠️  Only ${ptState.candles5.length}/${_needBars} ${CONFIRM_RES}-min candles — BOTH mode refuses entries until the 5-min chart warms up.`);
      }
      if (conf.forming && _istMinOfMs(conf.forming.time * 1000) >= _MKT_OPEN_MINS && !ptState.currentBar5) {
        ptState.currentBar5   = { time: conf.forming.time, open: conf.forming.open, high: conf.forming.high, low: conf.forming.low, close: conf.forming.close, volume: conf.forming.volume || 0 };
        ptState.barStartTime5 = conf.forming.time * 1000;
      }
    }

    const lastCandle = ptState.candles[ptState.candles.length - 1];
    if (lastCandle) {
      // Display only — the checklist card shows the last closed candle at once.
      const pre = engine.getSignal(ptState.candles, {
        pivots: ptState.pivots, confirmCandles: CONFIRM_RES ? ptState.candles5 : undefined, silent: true,
      });
      ptState.lastSignal = {
        time: lastCandle.time, closeTime: lastCandle.time + TRADE_RES * 60, close: lastCandle.close,
        signal: pre.signal, reason: pre.reason || null, warmup: !!pre.warmup,
        checks: pre.checks || null, confirmChecks: pre.confirmChecks || null, confirmTime: pre.confirmTime || null,
        preload: true,
      };
      log(`📊 Signal on pre-loaded data (display only — never traded): ${pre.signal} | ${pre.reason}`);
      ptState.prevCandleHigh = lastCandle.high;
      ptState.prevCandleLow  = lastCandle.low;
    }
  } catch (err) {
    log(`⚠️  Could not pre-load candles: ${err.message} — will build from live ticks (the engine needs ${_needBars} per chart)`);
  }

  // Tick-recorder session-start snapshot
  ptState._sessionId = `st_rsi_piv_bb-paper:${Date.now()}`;
  try {
    tickRecorder.recordSessionStart({
      mode: "st_rsi_piv_bb-paper",
      sessionId: ptState._sessionId,
      settings: tickRecorder.snapshotSettings(),
      warmup:   ptState.candles.map(c => ({ ...c })),
      meta: {
        instrument:          instrumentConfig.INSTRUMENT,
        resolutionMin:       TRADE_RES,
        confirmResolutionMin: CONFIRM_RES,
        entryTf:             _SESSION_ENTRY_TF,
        pivots:              ptState.pivots,
        spotSymbol:          subscribeSymbol,
        sessionStartISO:     ptState.sessionStart,
        activeStrategy:      ACTIVE,
      },
    });
  } catch (_) {}

  // ── Pre-market warmup mode ─────────────────────────────────────────────────
  const nowMins = getISTMinutes();
  if (nowMins < _START_MINS) {
    log("⏳ [PAPER] Pre-market mode — " + (_START_MINS - nowMins) + " min until " + _fmtMins(_START_MINS) + ". History loaded, strategy warmed up.");
    log("   Fyers ticks arrive from 9:15 IST. Entries begin at " + _fmtMins(cfg.ENTRY_START) + " (engine window).");
  }

  // ── Schedule auto-stop at TRADE_STOP_TIME ────────────────────────────────
  const _stopLabelAtStart = _fmtMins(_STOP_MINS);
  scheduleAutoStop((msg) => {
    log(msg);
    if (ptState.position && ptState.lastTickPrice) {
      simulateSell(ptState.lastTickPrice, "Auto-stop " + _stopLabelAtStart, ptState.lastTickPrice);
    }
    ptState.running = false;
    _releaseLiveHarness("scheduled auto-stop");   // after the square-off above
    // Square-off above needs lastTickPrice; never let a reservation outlive the session.
    capitalPool.clear("st_rsi_piv_bb");
    stopOptionPolling();
    try {
      tickRecorder.recordSessionStop({
        mode: "st_rsi_piv_bb-paper",
        sessionId: ptState._sessionId || null,
        reason: "auto_stop_eod",
      });
    } catch (_) {}
    // Clear THIS slot first, then stop the shared socket only if nothing else is subscribed.
    socketManager.removeCallback(SOCKET_CALLBACK_ID);
    sharedSocketState.clearStRsiPivBbMode();
    if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) {
      socketManager.stop();
    } else if (sharedSocketState.isAnyActive()) {
      log("📡 [PAPER] Socket kept alive — another strategy is still active");
    }
    saveSession();
  });

  log(`📡 Subscribing to ${subscribeSymbol} for live tick data...`);

  // Secondary consumer: never pass onTick to start(), and never call start() on a
  // running socket — even start(sym, () => {}) overwrites V1's primary handler.
  if (!socketManager.isRunning()) socketManager.start(subscribeSymbol, () => {}, log);
  socketManager.addCallback(SOCKET_CALLBACK_ID, onTick, log, subscribeSymbol);
  sharedSocketState.setStRsiPivBbMode("ST_RSI_PIV_BB_PAPER");

  return res.json({
    success:     true,
    message:     "Paper trading started! No real orders will be placed.",
    strategy:    { key: ACTIVE, name: engine.NAME },
    entryTf:     _SESSION_ENTRY_TF,
    tradeRes:    TRADE_RES,
    confirmRes:  CONFIRM_RES,
    pivots:      ptState.pivots,
    instrument:  instrumentConfig.INSTRUMENT,
    lotQty:      getLotQty(),
    capital:     data.capital,
    monitorAt:   "GET /st_rsi_piv_bb-paper/status",
  });
});

/**
 * GET /st_rsi_piv_bb-paper/stop
 * Stops the session, squares off virtual position, saves summary to disk
 */
router.get("/stop", async (req, res) => {
  if (!ptState.running) {
    _releaseLiveHarness("paper /stop — engine not running");   // a stale harness must still be removable
    return res.status(400).json({ success: false, error: "Paper trading is not running." });
  }

  // Virtual square-off
  if (ptState.position && (ptState.lastTickPrice || ptState.currentBar)) {
    const _px = ptState.lastTickPrice || ptState.currentBar.close;
    simulateSell(_px, "Manual stop", _px);
  }
  // Released AFTER the virtual square-off, so the harness still closes the real position.
  _releaseLiveHarness("paper /stop");

  stopOptionPolling();
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  // Clear THIS mode first, then stop the shared socket ONLY if no other strategy is still subscribed.
  socketManager.removeCallback(SOCKET_CALLBACK_ID);
  sharedSocketState.clearStRsiPivBbMode();
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) {
    socketManager.stop();
  }
  ptState.running = false;
  ptState._pendingEntry = null;
  // Never let a reservation outlive the session.
  capitalPool.clear("st_rsi_piv_bb");

  try {
    tickRecorder.recordSessionStop({
      mode: "st_rsi_piv_bb-paper",
      sessionId: ptState._sessionId || null,
      reason: "user_stop",
    });
  } catch (_) {}

  log("⏹ [PAPER] Paper trading stopped");

  const session = saveSession();

  return res.json({
    success:  true,
    message:  "Paper trading stopped. Session saved.",
    session,
    viewHistory: "GET /st_rsi_piv_bb-paper/history",
  });
});

/**
 * GET /st_rsi_piv_bb-paper/exit
 * Manually exit the current open position without stopping the session.
 * Re-entry follows the strategy as usual: the next closed 4/4 candle may enter.
 */
router.get("/exit", (req, res) => {
  if (!ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading is not running." });
  }
  if (!ptState.position) {
    return res.status(400).json({ success: false, error: "No open position to exit." });
  }
  if (!ptState.currentBar && !ptState.lastTickPrice) {
    return res.status(400).json({ success: false, error: "No market data yet — cannot exit." });
  }

  const exitSpot   = ptState.lastTickPrice || (ptState.currentBar ? ptState.currentBar.close : 0);
  const exitOption = ptState.optionLtp || null;
  log(`🖐️ [PAPER] MANUAL EXIT triggered by user | NIFTY spot: ₹${exitSpot} | Option LTP: ${exitOption ? "₹" + exitOption : "N/A"}`);

  simulateSell(exitSpot, "Manual exit by user", exitSpot);

  return res.json({ success: true, message: "Position exited manually.", exitSpot });
});

/**
 * POST /st_rsi_piv_bb-paper/manualEntry
 * Manually enter a CE or PE trade at the current spot price.
 * SL = the SuperTrend value on the latest CLOSED trade-TF candle (engine.computeSeries).
 * Refused when that level is on the wrong side of spot. The candle-close exit and
 * the SuperTrend trail then apply exactly as for an automatic entry.
 */
router.post("/manualEntry", async (req, res) => {
  if (!ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading is not running." });
  }
  if (ptState.position) {
    return res.status(400).json({ success: false, error: "Already in a position. Exit first." });
  }
  if (ptState._entryPending) {
    return res.status(409).json({ success: false, error: "An automatic entry is in flight — try again in a moment." });
  }
  const { side } = req.body || {};
  if (side !== "CE" && side !== "PE") {
    return res.status(400).json({ success: false, error: "Side must be CE or PE." });
  }
  const spot = ptState.lastTickPrice || (ptState.currentBar ? ptState.currentBar.close : null);
  if (!spot) {
    return res.status(400).json({ success: false, error: "No market data yet." });
  }

  // Stop = the CURRENT SuperTrend value, from the engine's own series.
  const cfg = engine.getConfig();
  const candles = ptState.candles || [];
  if (candles.length < engine.warmupBars(cfg)) {
    return res.status(409).json({ success: false, error: `Warming up — ${candles.length}/${engine.warmupBars(cfg)} closed ${TRADE_RES}-min candles; no SuperTrend stop yet.` });
  }
  const series = engine.computeSeries(candles, cfg);
  const st = series.supertrend[candles.length - 1];
  if (!st || !Number.isFinite(st.value)) {
    return res.status(409).json({ success: false, error: "No SuperTrend value on the last closed candle — cannot set a stop." });
  }
  const stop = parseFloat(st.value.toFixed(2));
  if ((side === "CE" && !(stop < spot)) || (side === "PE" && !(stop > spot))) {
    const why = side === "CE"
      ? `SuperTrend ₹${stop} is not below spot ₹${spot} — no protective CE stop. Manual CE refused.`
      : `SuperTrend ₹${stop} is not above spot ₹${spot} — no protective PE stop. Manual PE refused.`;
    log(`❌ [PAPER] Manual entry refused — ${why}`);
    return res.status(409).json({ success: false, error: why });
  }

  const _sidManual = _entrySessionGen;
  ptState._entryPending = true;   // synchronous — an automatic entry cannot race this one
  try {
    let symbol;
    let entryLtp = null;
    if (instrumentConfig.INSTRUMENT === "NIFTY_FUTURES") {
      symbol = await getSymbol(side);
      if (!symbol) return res.status(409).json({ success: false, error: "no futures contract resolved" });
    } else {
      const optResult = await validateAndGetOptionSymbol(spot, side, ACTIVE);
      if (!optResult || optResult.invalid || !optResult.symbol) {
        const why = optResult && optResult.staleExpiry
          ? `${optResult.overrideKey}="${optResult.staleExpiry}" has expired — update it in Settings`
          : "no valid option symbol could be resolved on Fyers";
        log(`❌ [PAPER] Manual entry refused — ${why}`);
        return res.status(409).json({ success: false, error: why });
      }
      symbol = optResult.symbol;
      try { entryLtp = await _fillPremium(symbol, null); } catch (_) { entryLtp = null; }
    }
    if (!ptState.running || _entrySessionGen !== _sidManual) {
      return res.status(409).json({ success: false, error: "Session stopped during symbol lookup — entry cancelled" });
    }
    if (ptState.position) {
      return res.status(400).json({ success: false, error: "Already in a position. Exit first." });
    }
    const qty = getLotQty();   // clamped (MAX_LOT_MULTIPLIER) — don't recompute raw and bypass the cap

    log(`🖐️ [PAPER] MANUAL ENTRY ${side} by user @ spot ₹${spot} | SL (SuperTrend): ₹${stop} | Symbol: ${symbol}`);
    simulateBuy(symbol, side, qty, spot, `Manual ${side} entry by user | SL=ST ${stop}`, stop, spot, {
      entryLtp,
      manual:       true,
      entryBarTime: ptState.currentBar ? ptState.currentBar.time : null,
      signal: {
        supertrend: stop,
        stTrend:    st.trend === 1 ? "BULLISH" : st.trend === -1 ? "BEARISH" : null,
        rsi:        series.rsi[candles.length - 1] != null ? parseFloat(series.rsi[candles.length - 1].toFixed(2)) : null,
        bbUpper:    series.bbUpper[candles.length - 1],
        bbMiddle:   series.bbMiddle[candles.length - 1],
        bbLower:    series.bbLower[candles.length - 1],
        pp: ptState.pivots ? ptState.pivots.pp : null,
        r1: ptState.pivots ? ptState.pivots.r1 : null,
        s1: ptState.pivots ? ptState.pivots.s1 : null,
        r2: ptState.pivots ? ptState.pivots.r2 : null,
        s2: ptState.pivots ? ptState.pivots.s2 : null,
        pivotsFrom: ptState.pivots ? ptState.pivots.from : null,
      },
    });
    if (!ptState.position || !/^Manual/.test(String(ptState.position.reason || ""))) {
      // simulateBuy refused (capital gate) — it has already logged why.
      return res.status(409).json({ success: false, error: "Entry refused — see the paper log for the reason" });
    }

    return res.json({ success: true, spot: spot, side: side, sl: stop, symbol: symbol });
  } catch (e) {
    log(`❌ [PAPER] Manual entry failed: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    ptState._entryPending = false;
  }
});

/**
 * GET /st_rsi_piv_bb-paper/status
 * Live view — current position, session PnL, capital, recent log
 */
// ── Session trade rows builder ───────────────────────────────────────────────
function buildSessionTradeRows(trades, inr) {
  if (!trades || trades.length === 0) return "";
  return [...trades].reverse().map(t => {
    const sc  = t.side === "CE" ? "#10b981" : "#ef4444";
    const pc  = t.pnl >= 0 ? "#10b981" : "#ef4444";
    const why = (t.exitReason || "—").substring(0, 55);

    // Side badge
    const sideBadge = "<span style=\"font-weight:800;color:" + sc + "\">" + (t.side || "—") + "</span>";

    // Strike + Expiry
    const strikeStr = t.optionStrike
      ? "<div style=\"font-size:1rem;font-weight:800;color:#fff;\">" + t.optionStrike + "</div>"
      : "<div style=\"color:var(--muted-1,#8ba1c2);\">—</div>";
    const expiryStr = t.optionExpiry
      ? "<div style=\"font-size:0.68rem;color:#f59e0b;margin-top:2px;\">" + t.optionExpiry + "</div>"
      : "";

    // Entry prices: NIFTY spot + Option premium
    const entryNifty  = t.spotAtEntry  || t.entryPrice;
    const entryOption = t.optionEntryLtp;
    const entryCell   =
      "<div style=\"font-size:0.75rem;color:var(--muted-1,#8ba1c2);\">NIFTY</div>" +
      "<div style=\"font-weight:700;color:#c8d8f0;\">" + inr(entryNifty) + "</div>" +
      "<div style=\"font-size:0.68rem;color:var(--muted-1,#8ba1c2);margin-top:4px;\">Option</div>" +
      "<div style=\"font-weight:700;color:#60a5fa;\">" + (entryOption ? inr(entryOption) : "—") + "</div>" +
      (t.stopLoss ? "<div style=\"font-size:0.65rem;color:#f59e0b;margin-top:3px;\">SL " + inr(t.stopLoss) + "</div>" : "");

    // Exit prices: NIFTY spot + Option premium + movement pts
    const exitNifty  = t.spotAtExit;
    const exitOption = t.optionExitLtp;
    const optPtsDiff = (entryOption && exitOption)
      ? parseFloat((exitOption - entryOption).toFixed(2))
      : null;
    const ptColor    = optPtsDiff === null ? "#8ba1c2" : optPtsDiff >= 0 ? "#10b981" : "#ef4444";
    const exitCell   =
      "<div style=\"font-size:0.75rem;color:var(--muted-1,#8ba1c2);\">NIFTY</div>" +
      "<div style=\"font-weight:700;color:#c8d8f0;\">" + inr(exitNifty) + "</div>" +
      "<div style=\"font-size:0.68rem;color:var(--muted-1,#8ba1c2);margin-top:4px;\">Option</div>" +
      "<div style=\"font-weight:700;color:#60a5fa;\">" + (exitOption ? inr(exitOption) : "—") + "</div>" +
      (optPtsDiff !== null ? "<div style=\"font-size:0.65rem;color:" + ptColor + ";margin-top:2px;\">" +
        (optPtsDiff >= 0 ? "▲ +" : "▼ ") + optPtsDiff.toFixed(2) + " pts</div>" : "");

    // PnL: final ₹ + brokerage note
    const pnlCell =
      "<div style=\"font-size:1rem;font-weight:800;color:" + pc + "\">" +
        (t.pnl >= 0 ? "+" : "") + inr(t.pnl) + "</div>" +
      "<div style=\"font-size:0.65rem;color:var(--muted-1,#8ba1c2);margin-top:2px;\">after charges</div>";

    return "<tr style='border-top:1px solid #1a2236;vertical-align:top;'>" +
      "<td style='padding:10px 12px;'>" + sideBadge + "</td>" +
      "<td style='padding:10px 12px;'>" + strikeStr + expiryStr + "</td>" +
      "<td style='padding:10px 12px;font-size:0.75rem;color:#c8d8f0;'>" + (t.entryTime || "—") + "</td>" +
      "<td style='padding:10px 12px;font-size:0.75rem;color:#c8d8f0;'>" + (t.exitTime  || "—") + "</td>" +
      "<td style='padding:10px 12px;'>" + entryCell + "</td>" +
      "<td style='padding:10px 12px;'>" + exitCell  + "</td>" +
      "<td style='padding:10px 12px;'>" + pnlCell   + "</td>" +
      "<td style='padding:10px 12px;font-size:0.72rem;color:var(--muted-1,#8ba1c2);'>" + why + "</td>" +
      "</tr>";
  }).join("");
}

// ── Cached trades mapping for /status/data poll (avoids .map() on every 2s poll) ──
let _tradesMapCache = [];
let _tradesMapCount = 0;
function _getCachedTradesForPoll() {
  if (ptState.sessionTrades.length === _tradesMapCount) return _tradesMapCache;
  _tradesMapCount = ptState.sessionTrades.length;
  _tradesMapCache = ptState.sessionTrades.map(t => ({
    side: t.side || "", strike: t.optionStrike || "", expiry: t.optionExpiry || "",
    entry: t.entryTime || "", exit: t.exitTime || "",
    eSpot: t.spotAtEntry || t.entryPrice || 0, eOpt: t.optionEntryLtp || null,
    eSl: t.stopLoss || null, xSpot: t.spotAtExit || t.exitPrice || 0,
    xOpt: t.optionExitLtp || null, pnl: typeof t.pnl === "number" ? t.pnl : null,
    reason: t.exitReason || "",
    // Fields used by tickReplay to attach per-trade option-tick windows.
    // Cheap (already on the trade record), no extra computation on poll.
    symbol: t.symbol || null,
    entryBarTime: t.entryBarTime || null,
    exitBarTime:  t.exitBarTime  || null,
    durationMs:   t.durationMs   || null,
  }));
  return _tradesMapCache;
}

// ── Chart indicator series — engine.computeSeries() over the CLOSED candles ──
// Exactly the input getSignal() reads, so the chart plots the numbers the signal
// used. Cached per closed candle (the chart polls every 4s per open browser).
let _chartSeriesCache = { key: null, value: null };
function _chartSeries(closed, cfg) {
  const n = closed.length;
  if (!n) return null;
  const key = `${n}|${closed[0].time}|${closed[n - 1].time}|${closed[n - 1].close}|${cfg.ST_PERIOD}/${cfg.ST_MULT}/${cfg.RSI_PERIOD}/${cfg.BB_PERIOD}/${cfg.BB_STDDEV}`;
  if (_chartSeriesCache.key === key) return _chartSeriesCache.value;
  const s = engine.computeSeries(closed, cfg);
  const supertrend = [], rsi = [], bbUpper = [], bbMiddle = [], bbLower = [];
  const _r = (v) => parseFloat(v.toFixed(2));
  for (let i = 0; i < n; i++) {
    const t = closed[i].time;
    const st = s.supertrend[i];
    if (st && Number.isFinite(st.value)) supertrend.push({ time: t, value: st.value, trend: st.trend });
    if (Number.isFinite(s.rsi[i]))      rsi.push({ time: t, value: _r(s.rsi[i]) });
    if (Number.isFinite(s.bbUpper[i]))  bbUpper.push({ time: t, value: _r(s.bbUpper[i]) });
    if (Number.isFinite(s.bbMiddle[i])) bbMiddle.push({ time: t, value: _r(s.bbMiddle[i]) });
    if (Number.isFinite(s.bbLower[i]))  bbLower.push({ time: t, value: _r(s.bbLower[i]) });
  }
  const value = { supertrend, rsi, bbUpper, bbMiddle, bbLower };
  _chartSeriesCache = { key, value };
  return value;
}

/**
 * GET /st_rsi_piv_bb-paper/status/chart-data
 * Returns candle history + indicator overlays + trade markers for the
 * lightweight-charts widget. Called every 4 s by the chart polling loop.
 */
router.get("/status/chart-data", async (req, res) => {
  try {
    // After a restart we restore the Session Trades but not the live candle series.
    // When stopped with restored trades and no live candles, backfill the spot
    // candles for the trades' day so the chart draws them with their markers.
    let srcCandles = ptState.candles;
    if (!ptState.running && srcCandles.length === 0 && (ptState.sessionTrades || []).length > 0) {
      srcCandles = await chartBackfill.candlesForRestoredTrades(NIFTY_INDEX_SYMBOL, TRADE_RES, ptState.sessionTrades);
    }
    const closed = srcCandles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    const cfg = engine.getConfig();
    const ind = _chartSeries(closed, cfg) || { supertrend: [], rsi: [], bbUpper: [], bbMiddle: [], bbLower: [] };

    // Closed candles + the currently forming bar (display only — never in the indicators).
    const candles = closed.slice();
    if (ptState.running && ptState.currentBar) {
      candles.push({
        time:  ptState.currentBar.time,
        open:  ptState.currentBar.open,
        high:  ptState.currentBar.high,
        low:   ptState.currentBar.low,
        close: ptState.currentBar.close,
      });
    }

    // Trade markers: entry + exit points from today's session
    const markers = [];
    for (const t of ptState.sessionTrades) {
      if (t.entryPrice && t.entryBarTime) {
        markers.push({
          time:     t.entryBarTime,
          position: 'belowBar',
          color:    '#3b82f6',
          shape:    'arrowUp',
          text:     `${t.side} @ ${Number(t.entryPrice).toFixed(0)}`,
        });
      }
      if (t.exitPrice && t.exitBarTime) {
        const isWin = t.pnl > 0;
        markers.push({
          time:     t.exitBarTime,
          position: 'aboveBar',
          color:    isWin ? '#10b981' : '#ef4444',
          shape:    'arrowDown',
          text:     `Exit ${isWin ? '+' : ''}${t.pnl ? t.pnl.toFixed(0) : ''}`,
        });
      }
    }

    const pv = ptState.pivots;
    return res.json({
      candles, markers,
      stopLoss:   ptState.position && Number.isFinite(ptState.position.stopLoss) ? ptState.position.stopLoss : null,
      entryPrice: ptState.position && ptState.position.entryPrice ? ptState.position.entryPrice : null,
      optionChart: optionChart.buildPayload({ store: ptState.optionChart, position: ptState.position, trades: ptState.sessionTrades }),
      supertrend: ind.supertrend, trendSource: "SUPERTREND",
      rsi:        ind.rsi,
      bbUpper:    ind.bbUpper, bbMiddle: ind.bbMiddle, bbLower: ind.bbLower,
      pivots:     pv ? { pp: pv.pp, r1: pv.r1, s1: pv.s1, r2: pv.r2, s2: pv.s2, from: pv.from } : null,
      rsiCeMin:   cfg.RSI_CE_MIN, rsiPeMax: cfg.RSI_PE_MAX,
      tradeRes:   TRADE_RES,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** The 4/4 checklist payload for the status card. */
function _checklistPayload() {
  const ls = ptState.lastSignal;
  const pv = ptState.pivots;
  const pick = (k) => (k ? { st: !!k.st, rsi: !!k.rsi, piv: !!k.piv, bb: !!k.bb, count: k.count || 0 } : null);
  const trade = ls ? {
    time:      ls.time,
    closeTime: ls.closeTime,
    close:     ls.close,
    signal:    ls.signal,
    reason:    ls.reason,
    preload:   !!ls.preload,
    ready:     !!(ls.checks && ls.checks.ready),
    CE:        ls.checks ? pick(ls.checks.CE) : null,
    PE:        ls.checks ? pick(ls.checks.PE) : null,
  } : null;
  let confirm = null;
  if (CONFIRM_RES) {
    const c = _confirmChecklist();
    if (c) confirm = { time: c.time, closeTime: c.closeTime, close: c.close, ready: !!c.ready, CE: pick(c.CE), PE: pick(c.PE) };
  }
  return {
    tradeRes:   TRADE_RES,
    confirmRes: CONFIRM_RES,
    entryTf:    _SESSION_ENTRY_TF,
    trade,
    confirm,
    pivots:     pv ? { pp: pv.pp, r1: pv.r1, s1: pv.s1, r2: pv.r2, s2: pv.s2, from: pv.from } : null,
    pivotsError: pv ? null : (ptState._pivotsError || (ptState.running ? "No R1/S1 — daily candles unavailable" : null)),
    tfNote:     _tfNote(),
    pending:    ptState._pendingEntry ? { signal: ptState._pendingEntry.sig.signal, attempts: ptState._pendingEntry.attempts || 0 } : null,
  };
}

/**
 * GET /st_rsi_piv_bb-paper/status/data
 * JSON-only endpoint for AJAX polling — returns all dynamic state without HTML.
 * Called every 2 s by the client-side setInterval when trading is active.
 */
router.get("/status/data", (req, res) => {
  try {
    const data     = loadPaperData();
    const cfg      = engine.getConfig();

    // Unrealised PnL (minus charges)
    const _isFutPt = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
    let unrealisedPnl = 0;
    let pnlSource     = "spot proxy";
    if (ptState.position && ptState.currentBar) {
      const { side, entryPrice, qty, optionEntryLtp, optionCurrentLtp } = ptState.position;
      const currentOptionLtp = ptState.optionLtp || optionCurrentLtp;
      if (optionEntryLtp && currentOptionLtp && optionEntryLtp > 0) {
        const _c = getCharges({ isFutures: _isFutPt, exitPremium: currentOptionLtp, entryPremium: optionEntryLtp, qty });
        unrealisedPnl = parseFloat(((currentOptionLtp - optionEntryLtp) * qty - _c).toFixed(2));
        pnlSource     = "option premium";
      } else if (ptState.currentBar) {
        const _c = getCharges({ isFutures: _isFutPt, exitPremium: ptState.currentBar.close, entryPremium: entryPrice, qty });
        unrealisedPnl = parseFloat(((ptState.currentBar.close - entryPrice) * (side === "CE" ? 1 : -1) * qty - _c).toFixed(2));
      }
    }

    const pos           = ptState.position;
    const optEntryLtp   = pos ? (pos.optionEntryLtp || null)                       : null;
    const optCurrentLtp = pos ? (ptState.optionLtp || pos.optionCurrentLtp || null) : null;
    const _chgPtD = (optEntryLtp && optCurrentLtp) ? getCharges({ isFutures: _isFutPt, exitPremium: optCurrentLtp, entryPremium: optEntryLtp, qty: pos ? pos.qty : 0 }) : 0;
    const optPremiumPnl = (optEntryLtp && optCurrentLtp)
      ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0) - _chgPtD).toFixed(2)) : null;
    const optPremiumMove = (optEntryLtp && optCurrentLtp)
      ? parseFloat((optCurrentLtp - optEntryLtp).toFixed(2)) : null;
    const optPremiumPct  = (optEntryLtp && optCurrentLtp && optEntryLtp > 0)
      ? parseFloat(((optCurrentLtp - optEntryLtp) / optEntryLtp * 100).toFixed(2)) : null;
    const liveClose    = ptState.currentBar?.close || null;
    const pointsMoved  = pos && liveClose
      ? parseFloat(((liveClose - pos.entryPrice) * (pos.side === "CE" ? 1 : -1)).toFixed(2)) : 0;

    return res.json({
      running:           ptState.running,
      sessionPnl:        ptState.sessionPnl,
      unrealisedPnl,
      pnlSource,
      tickCount:         ptState.tickCount,
      lastTickPrice:     ptState.lastTickPrice,
      candleCount:       ptState.candles.length,
      candleCount5:      CONFIRM_RES ? ptState.candles5.length : null,
      warmupNeed:        engine.warmupBars(cfg),
      prevCandleHigh:    ptState.prevCandleHigh,
      prevCandleLow:     ptState.prevCandleLow,
      consecutiveLosses: ptState._consecutiveLosses || 0,   // display only — no breaker
      dailyLossHit:      ptState._dailyLossHit || false,
      maxDailyLoss:      cfg.MAX_DAILY_LOSS,
      maxDailyTrades:    cfg.MAX_DAILY_TRADES,
      priorTradesToday:  ptState._priorTradesToday || 0,
      sessionStart:      ptState.sessionStart,
      staleSession:      ptState._staleSession || false,
      tradeCount:        ptState.sessionTrades.length,
      wins:              ptState._sessionWins,
      losses:            ptState._sessionLosses,
      capital:           data.capital,
      totalPnl:          data.totalPnl,
      entryTf:           _SESSION_ENTRY_TF,
      tradeRes:          TRADE_RES,
      confirmRes:        CONFIRM_RES,
      // Position block (null when flat)
      position: pos ? {
        side:              pos.side,
        symbol:            pos.symbol,
        qty:               pos.qty,
        entryPrice:        pos.entryPrice,
        entryTime:         pos.entryTime,
        stopLoss:          pos.stopLoss,
        initialStopLoss:   pos.initialStopLoss,
        optionStrike:      pos.optionStrike,
        optionExpiry:      pos.optionExpiry,
        optionType:        pos.optionType,
        optionEntryLtp:    optEntryLtp,
        optionCurrentLtp:  optCurrentLtp,
        optionEntryLtpTime: pos.optionEntryLtpTime || null,
        optPremiumPnl,
        optPremiumMove,
        optPremiumPct,
        liveClose,
        pointsMoved,
        bestPrice:         pos.bestPrice || null,
        candlesHeld:       pos.candlesHeld || 0,
        reason:            pos.reason || null,
      } : null,
      // Current forming bar
      currentBar: ptState.currentBar ? {
        open:  ptState.currentBar.open,
        high:  ptState.currentBar.high,
        low:   ptState.currentBar.low,
        close: ptState.currentBar.close,
      } : null,
      // The 4/4 checklist card (last closed trade-TF candle + BOTH's 5-min candle + pivots)
      checklist: _checklistPayload(),
      // Trades (mapped for client-side display — cached to avoid rebuild when trade count hasn't changed)
      trades: _getCachedTradesForPoll(),
      // Activity log — last 100 entries newest-first
      logTotal: ptState.log.length,
      logs: reverseSlice(ptState.log, 100),
    });
  } catch (err) {
    console.error("[ST_RSI_PIV_BB-PAPER /status/data] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});
router.get("/status", (req, res) => {
  try {
  const data     = loadPaperData();

  // Unrealised PnL if position is open — use OPTION LTP if available, else spot proxy (minus charges)
  const _isFutPtPg = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  let unrealisedPnl = 0;
  let pnlSource = "spot proxy";
  if (ptState.position && ptState.currentBar) {
    const { side, entryPrice, qty, optionEntryLtp, optionCurrentLtp } = ptState.position;
    const currentOptionLtp = ptState.optionLtp || optionCurrentLtp;
    if (optionEntryLtp && currentOptionLtp && optionEntryLtp > 0) {
      const _c = getCharges({ isFutures: _isFutPtPg, exitPremium: currentOptionLtp, entryPremium: optionEntryLtp, qty });
      unrealisedPnl = parseFloat(((currentOptionLtp - optionEntryLtp) * qty - _c).toFixed(2));
      pnlSource = `option premium`;
    } else {
      const ltp = ptState.currentBar.close;
      const _c = getCharges({ isFutures: _isFutPtPg, exitPremium: ltp, entryPremium: entryPrice, qty });
      unrealisedPnl = parseFloat(((ltp - entryPrice) * (side === "CE" ? 1 : -1) * qty - _c).toFixed(2));
      pnlSource = "spot proxy";
    }
  }

  // Live config — the caps / warm-up the tiles show are the ones the engine applies.
  const _cfgPg     = engine.getConfig();
  const _warmNeed  = engine.warmupBars(_cfgPg);
  const _warmReady = ptState.candles.length >= _warmNeed && (!CONFIRM_RES || ptState.candles5.length >= _warmNeed);

  const inr = (n) => typeof n === "number"
    ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
  const pnlColor = (n) => n >= 0 ? "#10b981" : "#ef4444";

  const pos = ptState.position;
  const liveClose = ptState.currentBar?.close || null;
  const pointsMoved = pos && liveClose
    ? parseFloat(((liveClose - pos.entryPrice) * (pos.side === "CE" ? 1 : -1)).toFixed(2))
    : 0;
  const trailActive = pos && pos.bestPrice !== undefined && pos.bestPrice !== null;
  const trailProfit = pos && pos.bestPrice
    ? parseFloat(((pos.side === "CE"
        ? pos.bestPrice - pos.entryPrice
        : pos.entryPrice - pos.bestPrice)).toFixed(2))
    : 0;
  // Trailing-stop label — one trail source, tightened (and tested) on candle close only.
  const _stCfg    = _cfgPg;
  const _trailLbl = `SuperTrend(${_stCfg.ST_PERIOD},${_stCfg.ST_MULT}) · close-only`;

  // ATM/ITM badge
  const atmStrike = pos ? Math.round(pos.entryPrice / 50) * 50 : null;
  const strikeLabel = pos && pos.optionStrike
    ? (pos.optionStrike === atmStrike ? "ATM" : pos.optionStrike < atmStrike ? (pos.side === "CE" ? "ITM" : "OTM") : (pos.side === "PE" ? "ITM" : "OTM"))
    : "—";
  const strikeBadgeColor = strikeLabel === "ATM" ? "#3b82f6" : strikeLabel === "ITM" ? "#10b981" : "#ef4444";

  // Option premium P&L calculation for display
  const optEntryLtp   = pos ? (pos.optionEntryLtp || null) : null;
  const optCurrentLtp = pos ? (ptState.optionLtp || pos.optionCurrentLtp || null) : null;
  const _chgPtPg2 = (optEntryLtp && optCurrentLtp) ? getCharges({ isFutures: _isFutPtPg, exitPremium: optCurrentLtp, entryPremium: optEntryLtp, qty: pos ? pos.qty : 0 }) : 0;
  const optPremiumPnl = (optEntryLtp && optCurrentLtp)
    ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0) - _chgPtPg2).toFixed(2))
    : null;
  const optPremiumMove = (optEntryLtp && optCurrentLtp)
    ? parseFloat((optCurrentLtp - optEntryLtp).toFixed(2))
    : null;
  const optPremiumPct  = (optEntryLtp && optCurrentLtp && optEntryLtp > 0)
    ? parseFloat(((optCurrentLtp - optEntryLtp) / optEntryLtp * 100).toFixed(2))
    : null;

  const posHtml = pos ? `
    <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">

      <!-- Header: status + entry time + MANUAL EXIT BUTTON -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 1.5s infinite;"></span>
          <span style="font-size:0.8rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;">Open Position</span>
          <span style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);">Since ${fmtT(pos.entryTime)}</span>
        </div>
        <button onclick="ptHandleExit(this)"
           style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;transition:background 0.15s;"
           onmouseover="this.style.background='#991b1b'" onmouseout="this.style.background='#7f1d1d'">
          🚪 Exit Trade Now
        </button>
      </div>

      <!-- Option Identity Banner: Symbol | Strike | Expiry | Qty -->
      <div style="background:#071a12;border:1px solid #134e35;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:2.2rem;font-weight:900;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side}</span>
            <div>
              <div style="font-size:0.72rem;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side === "CE" ? "CALL · Bullish" : "PUT · Bearish"}</div>
              <span style="font-size:0.65rem;font-weight:700;background:${strikeBadgeColor}22;color:${strikeBadgeColor};border:1px solid ${strikeBadgeColor}44;padding:2px 7px;border-radius:4px;">${strikeLabel}</span>
            </div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Strike</div>
            <div style="font-size:1.6rem;font-weight:800;color:#fff;font-family:monospace;">${pos.optionStrike ? pos.optionStrike.toLocaleString("en-IN") : "—"}</div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Expiry</div>
            <div style="font-size:1.1rem;font-weight:700;color:#f59e0b;">${pos.optionExpiry || "—"}</div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Qty / Lots</div>
            <div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty} <span style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);">(${(pos.qty / 65).toFixed(0)} lot)</span></div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;flex-shrink:0;"></div>
          <div style="flex:1;min-width:200px;">
            <div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Full Symbol</div>
            <div style="font-size:0.82rem;font-weight:600;color:#c8d8f0;font-family:monospace;word-break:break-all;">${pos.symbol}</div>
          </div>
        </div>
      </div>

      <!-- ★ OPTION PREMIUM SECTION — most important block ★ -->
      <div style="background:#0a0f24;border:2px solid #3b82f6;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
        <div style="font-size:0.68rem;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">${instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" ? `📊 Futures Price (${pos.side === "CE" ? "LONG" : "SHORT"})` : `📊 Option Premium (${pos.optionType} Price)`}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">

          <!-- Entry Premium -->
          <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid #1e3a5f;border-radius:10px;">
            <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Entry Price</div>
            <div id="ajax-opt-entry-ltp" style="font-size:2rem;font-weight:800;color:#60a5fa;font-family:monospace;line-height:1;">
              ${optEntryLtp ? "₹" + optEntryLtp.toFixed(2) : "<span style='font-size:1rem;color:#f59e0b;'>Fetching...</span>"}
            </div>
            <div style="font-size:0.68rem;color:var(--muted-1,#8ba1c2);margin-top:4px;">
              ${optEntryLtp
                ? `captured at ${fmtT(pos.optionEntryLtpTime || pos.entryTime)}`
                : `⏳ first REST poll in ~3s<br><span style='color:#c8d8f0;'>NIFTY entry: ${inr(pos.entryPrice)}</span>`}
            </div>
          </div>

          <!-- Arrow -->
          <div style="text-align:center;font-size:1.8rem;color:${optPremiumMove !== null ? (optPremiumMove >= 0 ? "#10b981" : "#ef4444") : "#8ba1c2"};">
            ${optPremiumMove !== null ? (optPremiumMove >= 0 ? "→" : "→") : "→"}
          </div>

          <!-- Current Premium -->
          <div style="text-align:center;padding:12px;background:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#071a0f" : "#1a0707") : "#0d1320"};border:2px solid ${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};border-radius:10px;">
            <div style="font-size:0.63rem;color:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#8ba1c2"};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Current LTP</div>
            <div id="ajax-opt-current-ltp" style="font-size:2rem;font-weight:800;color:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">
              ${optCurrentLtp ? "₹" + optCurrentLtp.toFixed(2) : "⏳"}
            </div>
            <div id="ajax-opt-move" style="font-size:0.72rem;font-weight:700;margin-top:6px;color:${optPremiumMove !== null ? (optPremiumMove >= 0 ? "#10b981" : "#ef4444") : "#f59e0b"};">
              ${optPremiumMove !== null ? (optPremiumMove >= 0 ? "▲ +" : "▼ ") + "₹" + Math.abs(optPremiumMove).toFixed(2) + " pts" : optCurrentLtp ? "⏳ Awaiting entry price..." : "⏳ Polling REST feed..."}
            </div>
            <div id="ajax-opt-pct" style="font-size:1.1rem;font-weight:800;margin-top:4px;color:${optPremiumPct !== null ? (optPremiumPct >= 0 ? "#10b981" : "#ef4444") : "#8ba1c2"};font-family:monospace;">
              ${optPremiumPct !== null ? (optPremiumPct >= 0 ? "+" : "") + optPremiumPct.toFixed(2) + "%" : "—"}
            </div>
          </div>

          <!-- Option P&L -->
          <div style="text-align:center;padding:12px;background:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#071a0f" : "#1a0707") : "#0d1320"};border:1px solid ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#065f46" : "#7f1d1d") : "#1a2236"};border-radius:10px;">
            <div style="font-size:0.63rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Unrealised P&L</div>
            <div id="ajax-opt-pnl" style="font-size:1.8rem;font-weight:800;color:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">
              ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "+" : "") + "₹" + optPremiumPnl.toLocaleString("en-IN", {minimumFractionDigits:2, maximumFractionDigits:2}) : "—"}
            </div>
            <div style="font-size:0.65rem;color:var(--muted-1,#8ba1c2);margin-top:4px;">${pos.qty} qty · after charges</div>
          </div>

        </div>
      </div>

      <!-- Secondary grid: NIFTY spot + SuperTrend SL + Trail -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px;">
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY Spot @ Entry</div>
          <div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(pos.entryPrice)}</div>
          <div style="font-size:0.63rem;color:var(--muted-1,#8ba1c2);margin-top:2px;">fill · first tick after close</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY LTP</div>
          <div id="ajax-nifty-ltp" style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(liveClose)}</div>
          <div id="ajax-nifty-move" style="font-size:0.63rem;color:${pointsMoved >= 0 ? "#10b981" : "#ef4444"};margin-top:2px;">${pointsMoved >= 0 ? "▲" : "▼"} ${Math.abs(pointsMoved).toFixed(1)} pts</div>
        </div>
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop Loss (SuperTrend)</div>
          <div id="ajax-stop-loss" style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.stopLoss ? inr(pos.stopLoss) : "—"}</div>
          <div style="font-size:0.63rem;color:var(--muted-1,#8ba1c2);margin-top:2px;">Risk: ${pos.stopLoss ? inr(Math.abs(pos.entryPrice - pos.stopLoss) * pos.qty) : "—"}</div>
        </div>
        <div id="ajax-trail-card" data-trail="${_trailLbl}" style="background:#071a12;border:1px solid ${trailProfit > 0 ? "#8b5cf6" : "#134e35"};border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Trailing Stop</div>
          <div id="ajax-trail-status" style="font-size:0.88rem;font-weight:700;color:${trailProfit > 0 ? "#8b5cf6" : "#f59e0b"};">${_trailLbl}</div>
          <div id="ajax-trail-best" style="font-size:0.63rem;color:var(--muted-1,#8ba1c2);margin-top:2px;">Best: ${pos.bestPrice ? inr(pos.bestPrice) : "—"} (${trailProfit >= 0 ? "+" : ""}${trailProfit.toFixed(1)} pts)</div>
          <div id="ajax-trail-activate" style="font-size:0.63rem;color:var(--muted-1,#8ba1c2);margin-top:2px;">Trail source: ${_trailLbl}</div>
        </div>
      </div>

      ${pos.reason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;">📝 ${pos.reason}</div>` : ""}
    </div>` : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:1.5rem;margin-bottom:8px;">📭</div>
      <div id="ajax-flat-banner" style="font-size:0.9rem;font-weight:600;color:#8ba1c2;margin-bottom:14px;">FLAT — Waiting for 4/4 on a closed ${TRADE_RES}-min candle${CONFIRM_RES ? ` (+ ${CONFIRM_RES}-min 4/4)` : ''}</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
        <button onclick="manualEntry('CE')" style="padding:8px 24px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▲ Manual CE</button>
        <button onclick="manualEntry('PE')" style="padding:8px 24px;background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▼ Manual PE</button>
      </div>
    </div>`;

  // Build all log entries as JSON for client-side filtering
  const allLogs = [...ptState.log].reverse(); // newest first
  const logsJSON = JSON.stringify(allLogs)
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/`/g, "\\u0060")  // backtick breaks template literals in HTML
    .replace(/\$/g, "\\u0024"); // $ breaks ${} in HTML template literals

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <!-- AJAX polling replaces meta-refresh — see startAjaxRefresh() below -->
  <link rel="icon" type="image/png" href="data:image/png;base64,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"/>
  <title>ௐ Palani Andawar Thunai ॐ — Paper Trade</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script src="/vendor/lightweight-charts.standalone.production.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#060e06;color:#c0d8b0;overflow-x:hidden;}
${sidebarCSS()}
${modalCSS()}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
    @keyframes ltpulse{0%,100%{opacity:1}50%{opacity:.25}}


    /* ── PAGE BODY ── */
    .page{padding:22px 20px 60px;}

    /* ── CAPITAL STRIP ── */
    .capital-strip{display:flex;background:#090f09;border:0.5px solid #162416;border-radius:9px;overflow:hidden;margin-bottom:14px;}
    .cap-cell{flex:1;padding:11px 16px;border-right:0.5px solid #162416;}
    .cap-cell:last-child{border-right:none;}
    .cap-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.5px;color:#7f9b5c;margin-bottom:4px;}
    .cap-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#a0c880;}
    .cap-val.white{color:#c0d8b0;}
    .cap-val.green{color:#7ab850;}

    /* ── STAT CARDS ── */
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-bottom:16px;}
    .sc{background:#090f09;border:0.5px solid #162416;border-radius:8px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;right:0;height:1.5px;background:var(--at,#1a3010);}
    .sc-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.2px;color:#7f9b5c;margin-bottom:5px;}
    .sc-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#c0d8b0;}
    .sc-sub{font-size:0.6rem;color:#7f9b5c;margin-top:3px;}

    /* ── SECTION TITLE ── */
    .section-title{font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#7f9b5c;margin-bottom:8px;display:flex;align-items:center;gap:8px;}
    .section-title::after{content:'';flex:1;height:0.5px;background:#162416;}

    /* ── COPY / TOGGLE BUTTONS ── */
    .copy-btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;transition:all 0.15s;white-space:nowrap;}
    .copy-btn:hover{background:#0a1e3d;border-color:#3b82f6;}
    .copy-btn.copied{background:#064e3b;border-color:#10b981;color:#34d399;}

    /* ── POSITION BLOCK ── */
    /* inherits existing inline styles */

    /* ── MOBILE ── */
    @media(max-width:640px){
      .top-nav{padding:8px 12px;flex-wrap:wrap;gap:8px;}
      .tn-pill-nav{display:none;}
      .page{padding:14px 12px 40px;}
      .stat-grid{grid-template-columns:1fr 1fr;gap:7px;}
      .capital-strip{flex-wrap:wrap;}
      .cap-cell{min-width:50%;}
    }
    /* ── 4/4 CHECKLIST CARD ── */
    .chk-card{background:#090f09;border:0.5px solid #162416;border-radius:10px;padding:12px 14px;margin:14px 0 4px;}
    .chk-grid{display:grid;grid-template-columns:minmax(56px,1.3fr) repeat(5,minmax(0,1fr));gap:4px;align-items:center;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .chk-h{font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:#7f9b5c;text-align:center;}
    .chk-lbl{font-weight:700;white-space:nowrap;}
    .chk-c{text-align:center;padding:6px 0;border-radius:5px;background:#060b06;}
    .chk-ok{color:#10b981;} .chk-no{color:#ef4444;opacity:.8;} .chk-na{color:#4a6080;}
    .chk-n{font-weight:800;}
    .chk-sub{font-size:0.62rem;color:#7f9b5c;margin:8px 0 2px;line-height:1.45;word-break:break-word;}
    .chk-piv{display:flex;flex-wrap:wrap;gap:4px 14px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;margin-top:8px;}
    .chk-reason{font-size:0.62rem;color:#8ba1c2;margin-top:6px;line-height:1.45;word-break:break-word;}
    .chk-warn{color:#f87171;font-weight:700;font-size:0.72rem;margin-top:8px;}
    .chk-note{color:#f59e0b;font-size:0.66rem;margin-top:8px;line-height:1.45;word-break:break-word;}
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('stRsiPivBbPaper', sharedSocketState.getStRsiPivBbMode()==='ST_RSI_PIV_BB_LIVE', ptState.running, {
  showExitBtn:  !!ptState.position,
  showStopBtn:  ptState.running,
  showStartBtn: !ptState.running,
  exitBtnJs:    'ptHandleExit(this)',
  stopBtnJs:    'handleStop(this)',
  startBtnJs:   'handleStart(this)',
  exitLabel:    '🚪 Exit Trade',
  stopLabel:    '■ Stop Paper',
  startLabel:   '▶ Start Paper',
})}
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">📋 Paper Trade</div>
      <div class="top-bar-meta">Strategy: ${ACTIVE} — ${engine.NAME} · ${TRADE_RES}-min candles${CONFIRM_RES ? ` + ${CONFIRM_RES}-min confirm` : ''} · ${ptState.running ? 'Auto-refreshes every 2s' : 'Stopped'}</div>
    </div>
    <div class="top-bar-right">
      ${ptState.running
        ? '<span class="top-bar-badge paper-active"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>RUNNING</span>'
        : '<span class="top-bar-badge">● IDLE</span>'}
      <a href="/st_rsi_piv_bb-paper/history" style="background:rgba(59,130,246,0.08);border:0.5px solid rgba(59,130,246,0.3);color:#60a5fa;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;text-decoration:none;font-family:inherit;">📊 History</a>
      <button onclick="ptHandleReset(this)" style="background:#07111f;border:0.5px solid #0e1e36;color:var(--muted-1,#8ba1c2);padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;">↺ Reset</button>
    </div>
  </div>

<div class="page">
  <!-- Capital strip -->
  <div class="capital-strip" style="margin-bottom:14px;">
    <div class="cap-cell">
      <div class="cap-label">Starting Capital</div>
      <div class="cap-val white">₹${getCapitalFromEnv().toLocaleString("en-IN")}</div>
    </div>
    <div class="cap-cell">
      <div class="cap-label">Current Capital</div>
      <div class="cap-val green" id="ajax-current-capital" style="color:${data.capital >= getCapitalFromEnv() ? '#7ab850' : '#f87171'};">₹${data.capital.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
    </div>
    <div class="cap-cell">
      <div class="cap-label">All-Time PnL</div>
      <div class="cap-val" id="ajax-alltime-pnl" style="color:${data.totalPnl >= 0 ? '#7ab850' : '#f87171'};">${data.totalPnl >= 0 ? '+' : ''}₹${data.totalPnl.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
    </div>
    <div class="cap-cell" style="font-size:0.62rem;color:#7f9b5c;max-width:180px;line-height:1.5;display:flex;align-items:center;">Capital updates when sessions complete. Reset wipes history.</div>
  </div>

  <div class="stat-grid" style="margin-bottom:20px;">
    <div class="sc" style="border-top:2px solid ${pnlColor(ptState.sessionPnl)};" id="ajax-sc-pnl">
      <div class="sc-label">Session PnL</div>
      <div class="sc-val" id="ajax-session-pnl" style="color:${pnlColor(ptState.sessionPnl)};">${inr(ptState.sessionPnl)}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #6a5090;">
      <div class="sc-label">${ptState._staleSession ? "Trades (Last Session)" : "Trades Today"}</div>
      <div class="sc-val"><span id="ajax-trade-count">${ptState.sessionTrades.length}</span> <span style="font-size:0.75rem;color:var(--muted-1,#8ba1c2);">/ ${_cfgPg.MAX_DAILY_TRADES}</span>${ptState._priorTradesToday ? ` <span style="font-size:0.62rem;color:var(--muted-1,#8ba1c2);">+${ptState._priorTradesToday} earlier</span>` : ''}</div>
      <div id="ajax-wl" style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);margin-top:4px;">${ptState._sessionWins}W &middot; ${ptState._sessionLosses}L</div>
    </div>
    <div class="sc" style="border-top:2px solid #4a6080;" id="ajax-sc-cl">
      <div class="sc-label">Loss Streak</div>
      <div class="sc-val" id="ajax-consec-losses" style="color:#fff">${ptState._consecutiveLosses || 0}</div>
      <div id="ajax-cl-status" style="font-size:0.7rem;margin-top:4px;color:#8ba1c2">info only — no breaker</div>
    </div>
    <div class="sc" style="border-top:2px solid ${ptState._dailyLossHit ? '#ef4444' : '#10b981'};" id="ajax-sc-dloss">
      <div class="sc-label">Daily Loss Limit</div>
      <div class="sc-val" id="ajax-daily-loss-val" style="color:${ptState._dailyLossHit ? '#ef4444' : '#fff'}">${_cfgPg.MAX_DAILY_LOSS > 0 ? inr(-Math.abs(_cfgPg.MAX_DAILY_LOSS)) : 'off'}</div>
      <div id="ajax-daily-loss-status" style="font-size:0.7rem;margin-top:4px;color:${ptState._dailyLossHit ? '#ef4444' : '#10b981'}">${ptState._dailyLossHit ? '🛑 KILLED — no entries' : '✅ Active'}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #a07010;">
      <div class="sc-label">Candles Loaded${CONFIRM_RES ? ` (${TRADE_RES}m · ${CONFIRM_RES}m)` : ''}</div>
      <div class="sc-val" id="ajax-candle-count" style="color:${_warmReady ? '#10b981' : '#f59e0b'}">${ptState.candles.length}${CONFIRM_RES ? ' · ' + ptState.candles5.length : ''}</div>
      <div id="ajax-candle-status" style="font-size:0.7rem;color:${_warmReady ? '#10b981' : '#f59e0b'};margin-top:4px;">${_warmReady ? '✅ Strategy ready' : `⚠️ Warming up (need ${_warmNeed})`}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #2a6080;">
      <div class="sc-label">WebSocket Ticks</div>
      <div class="sc-val" id="ajax-tick-count">${ptState.tickCount.toLocaleString()}</div>
      <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);margin-top:4px;">Last: <span id="ajax-last-tick">${ptState.lastTickPrice ? inr(ptState.lastTickPrice) : "—"}</span></div>
    </div>
    <div class="sc" style="border-top:1.5px solid #2a4020;">
      <div class="sc-label">Session Start</div>
      <div class="sc-val" style="font-size:0.85rem;color:#c8d8f0;">${fmtT(ptState.sessionStart)}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #8a2020;">
      <div class="sc-label">Prev Candle High</div>
      <div class="sc-val" id="ajax-prev-high" style="font-size:1rem;color:#ef4444;">${ptState.prevCandleHigh ? inr(ptState.prevCandleHigh) : "—"}</div>
      <div style="font-size:0.68rem;color:var(--muted-1,#8ba1c2);margin-top:4px;">Last closed candle high</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #5a9030;">
      <div class="sc-label">Prev Candle Low</div>
      <div class="sc-val" id="ajax-prev-low" style="font-size:1rem;color:#10b981;">${ptState.prevCandleLow ? inr(ptState.prevCandleLow) : "—"}</div>
      <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);margin-top:4px;">Last closed candle low</div>
    </div>
  </div>
  <div id="ajax-position-section">
    ${posHtml}
  </div>
  <!-- 4/4 checklist — the engine's own evaluation of the last closed candle(s) -->
  <div class="chk-card" id="ajax-checklist-card">
    <div class="section-title" style="margin-bottom:10px;">4/4 CHECKLIST</div>
    <div id="ajax-checklist"></div>
  </div>
  <script id="checklist-data" type="application/json">${JSON.stringify(_checklistPayload()).replace(/</g, "\\u003c")}</script>
  <script>
  function chkEsc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function chkHHMM(sec){ if (sec == null) return '\u2014'; var m = Math.floor((sec + 19800) / 60) % 1440; return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
  function renderChecklist(c){
    var el = document.getElementById('ajax-checklist');
    if (!el || !c) return;
    function mark(k, v, ready){
      if (!ready || !k) return '<div class="chk-c chk-na">\u2013</div>';
      return v ? '<div class="chk-c chk-ok">\u2713</div>' : '<div class="chk-c chk-no">\u2717</div>';
    }
    function row(label, color, k, ready){
      var n = (ready && k) ? k.count : null;
      return '<div class="chk-lbl" style="color:' + color + ';">' + label + '</div>'
        + mark(k, k && k.st, ready) + mark(k, k && k.rsi, ready) + mark(k, k && k.piv, ready) + mark(k, k && k.bb, ready)
        + '<div class="chk-c chk-n" style="color:' + (n === 4 ? '#10b981' : n == null ? '#4a6080' : '#c0d8b0') + ';">' + (n == null ? '\u2013' : n + '/4') + '</div>';
    }
    var t = c.trade, tr = c.tradeRes + 'm';
    var h = '<div class="chk-grid"><div class="chk-h"></div><div class="chk-h">ST</div><div class="chk-h">RSI</div><div class="chk-h">Piv</div><div class="chk-h">BB</div><div class="chk-h">n/4</div>';
    h += row('CE ' + tr, '#10b981', t && t.CE, t && t.ready) + row('PE ' + tr, '#ef4444', t && t.PE, t && t.ready);
    if (c.confirmRes) {
      var f = c.confirm, cr = c.confirmRes + 'm';
      h += row('CE ' + cr, '#10b981', f && f.CE, f && f.ready) + row('PE ' + cr, '#ef4444', f && f.PE, f && f.ready);
    }
    h += '</div>';
    h += '<div class="chk-sub">' + (t
        ? 'Last closed ' + c.tradeRes + '-min candle ' + chkHHMM(t.time) + '\u2013' + chkHHMM(t.closeTime) + ' \u00b7 C ' + t.close + (t.preload ? ' (pre-loaded, display only)' : '')
        : 'No closed ' + c.tradeRes + '-min candle yet')
      + (c.confirmRes ? '<br>Latest closed ' + c.confirmRes + '-min candle ' + (c.confirm ? chkHHMM(c.confirm.time) + '\u2013' + chkHHMM(c.confirm.closeTime) + ' \u00b7 C ' + c.confirm.close : 'none yet') : '')
      + '</div>';
    if (c.pivots) {
      var p = c.pivots;
      h += '<div class="chk-piv"><span style="color:#f87171;">R1 ' + p.r1 + '</span><span style="color:#c0d8b0;">PP ' + p.pp + '</span><span style="color:#34d399;">S1 ' + p.s1 + '</span>'
        + '<span style="color:#7f9b5c;">R2 ' + p.r2 + ' \u00b7 S2 ' + p.s2 + '</span><span style="color:#7f9b5c;">from ' + chkEsc(p.from || '?') + '</span></div>';
    } else {
      h += '<div class="chk-warn">' + chkEsc(c.pivotsError || 'No R1/S1 \u2014 daily candles unavailable') + '</div>';
    }
    if (t && t.reason) h += '<div class="chk-reason">' + chkEsc(t.reason) + '</div>';
    if (c.pending) h += '<div class="chk-note">Fill retry pending: ' + chkEsc(c.pending.signal) + ' (attempt ' + c.pending.attempts + ')</div>';
    if (c.tfNote) h += '<div class="chk-note">\u26a0\ufe0f ' + chkEsc(c.tfNote) + '</div>';
    el.innerHTML = h;
  }
  try { renderChecklist(JSON.parse(document.getElementById('checklist-data').textContent)); } catch (_) {}
  </script>
  </div>

  ${ptState.currentBar ? `
  <div style="margin-bottom:24px;">
    <div class="section-title">CURRENT ${TRADE_RES}-MIN BAR (FORMING)</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
      ${["open","high","low","close"].map(k => `
      <div class="sc">
        <div class="sc-label">${k.toUpperCase()}</div>
        <div class="sc-val" id="ajax-bar-${k}" style="font-size:1rem;">${inr(ptState.currentBar[k])}</div>
      </div>`).join("")}
    </div>
  </div>` : `
  <div style="margin-bottom:24px;" id="ajax-bar-container">
    <div class="section-title">CURRENT ${TRADE_RES}-MIN BAR (FORMING)</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
      ${["open","high","low","close"].map(k => `
      <div class="sc">
        <div class="sc-label">${k.toUpperCase()}</div>
        <div class="sc-val" id="ajax-bar-${k}" style="font-size:1rem;">\u2014</div>
      </div>`).join("")}
    </div>
  </div>`}

  ${process.env.CHART_ENABLED !== "false" ? `<!-- NIFTY Chart -->
  <div style="margin-bottom:24px;">
    <div class="section-title">NIFTY ${TRADE_RES}-MIN CHART</div>
    <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
      <div id="nifty-chart" style="width:100%;height:100%;"></div>
      <div id="chart-legend" style="position:absolute;top:10px;left:12px;right:12px;font-size:0.68rem;line-height:1.6;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;">
        <span style="color:#3b82f6;">▲ Entry</span> &nbsp;
        <span style="color:#10b981;">▼ Win</span> &nbsp;
        <span style="color:#ef4444;">▼ Loss</span> &nbsp;
        <span style="color:#a78bfa;">── BB</span> &nbsp;
        <span style="color:#f87171;">── R1</span> <span style="color:#34d399;">S1</span> &nbsp;
        <span style="color:#22c55e;">──</span><span style="color:#ef4444;">──</span> ST &nbsp;
        <span style="color:#22d3ee;">── RSI</span> &nbsp;
        <span style="color:#f59e0b;">── SL</span>
      </div>
    </div>
    ${optionChart.optionChartHtml('srpb-opt-chart')}
  </div>` : ""}

  ${ptState.sessionTrades.length > 0 ? `
  <div style="margin-bottom:24px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
      <div class="section-title" style="margin-bottom:0;">Session Trades</div>
      <select id="ptSide" onchange="ptFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All Sides</option><option value="CE">CE</option><option value="PE">PE</option>
      </select>
      <select id="ptResult" onchange="ptFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All</option><option value="win">Wins</option><option value="loss">Losses</option>
      </select>
      <select id="ptPerPage" onchange="ptFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="5">5/page</option><option value="10" selected>10/page</option><option value="25">25/page</option><option value="999999">All</option>
      </select>
      <span id="ptCount" style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);"></span>
      <button class="copy-btn" onclick="copyTradeLog(this)" style="margin-left:auto;">📋 Copy Trade Log</button>
      <a class="copy-btn" href="/st_rsi_piv_bb-paper/download/trades.jsonl?format=ai" title="Download the full paper-trade log as an AI-friendly Markdown report (summary + field legend + table)" style="margin-left:8px;text-decoration:none;">🤖 AI export</a>
    </div>
    <div style="border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#0a0f1c;">
          <th onclick="ptSort('side')"   style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);cursor:pointer;">Side ▲▼</th>
          <th onclick="ptSort('entry')"  style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);cursor:pointer;">Date ▼</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);">Entry</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);">Entry Time</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);">Exit</th>
          <th onclick="ptSort('exit')"   style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);cursor:pointer;">Exit Time ▲▼</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);">SL</th>
          <th onclick="ptSort('pnl')"    style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);cursor:pointer;">PnL ₹ ▲▼</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);">Entry Reason</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);">Exit Reason</th>
          <th style="padding:9px 12px;text-align:center;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);">Action</th>
        <tbody id="ptBody" style="font-family:monospace;font-size:0.78rem;"></tbody>
      </table>
    </div>
    <div id="ptPag" style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;"></div>
    <!-- Trade Detail Modal -->
    <div id="ptModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
      <div style="background:#0d1320;border:1px solid #1d3b6e;border-radius:16px;padding:24px 28px;max-width:720px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.9);position:relative;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
          <div>
            <span id="ptm-badge" style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:4px 10px;border-radius:6px;"></span>
            <span style="font-size:0.65rem;color:var(--muted-1,#8ba1c2);margin-left:10px;">📋 Paper Trade — Full Details</span>
          </div>
          <button onclick="document.getElementById('ptModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:var(--muted-1,#8ba1c2);font-size:1rem;cursor:pointer;padding:4px 10px;border-radius:6px;font-family:inherit;" onmouseover="this.style.color='#ef4444';this.style.borderColor='#ef4444'" onmouseout="this.style.color='#8ba1c2';this.style.borderColor='#1a2236'">✕ Close</button>
        </div>
        <div id="ptm-grid"></div>
        <div id="ptm-reason" style="display:none;"></div>
      </div>
    </div>
  <script>
  const PT_ALL = ${JSON.stringify([...(ptState.sessionTrades || [])].reverse().map(t => ({
    side:         t.side           || "",
    symbol:       t.symbol         || "",
    strike:       t.optionStrike   || "",
    expiry:       t.optionExpiry   || "",
    optionType:   t.optionType     || t.side || "",
    qty:          t.qty            || 0,
    entry:        t.entryTime      || "",
    exit:         t.exitTime       || "",
    eSpot:        t.spotAtEntry    || t.entryPrice || 0,
    eOpt:         t.optionEntryLtp || null,
    eSl:          t.stopLoss       || null,
    xSpot:        t.spotAtExit     || t.exitPrice  || 0,
    xOpt:         t.optionExitLtp  || null,
    peakOpt:      t.bestOptionLtp  || null,
    pnl:          typeof t.pnl === "number" ? t.pnl : null,
    pnlMode:      t.pnlMode        || "",
    entryReason:  t.entryReason    || "",
    reason:       t.exitReason     || "",
  }))).replace(/<\/script>/gi,"<\\/script>").replace(/`/g,"\\u0060").replace(/\$/g,"\\u0024")};
  function ptFmtDate(dt){ if(!dt) return '\u2014'; var p=dt.split(', '); var d=(p[0]||'').split('/'); if(d.length===3) return d[0].padStart(2,'0')+' '+d[1].padStart(2,'0')+' '+d[2]; return p[0]||'\u2014'; }
  function ptFmtTime(dt){ if(!dt) return '\u2014'; var p=dt.split(', '); return p[1]||'\u2014'; }
  let ptFiltered = [...PT_ALL], ptSortCol = 'entry', ptSortDir = -1, ptPage = 1, ptPP = 10;
  function ptFilter() {
    const side = document.getElementById('ptSide').value;
    const res  = document.getElementById('ptResult').value;
    ptPP   = parseInt(document.getElementById('ptPerPage').value);
    ptPage = 1;
    ptFiltered = PT_ALL.filter(t => {
      if (side && t.side !== side) return false;
      if (res === 'win'  && (t.pnl == null || t.pnl < 0))  return false;
      if (res === 'loss' && (t.pnl == null || t.pnl >= 0)) return false;
      return true;
    });
    ptApplySort();
  }
  function ptSort(col) {
    ptSortDir = ptSortCol === col ? ptSortDir * -1 : -1;
    ptSortCol = col;
    ptApplySort();
  }
  function ptApplySort() {
    ptFiltered.sort((a,b) => {
      let av = a[ptSortCol], bv = b[ptSortCol];
      if (av == null) av = ptSortDir === -1 ? -Infinity : Infinity;
      if (bv == null) bv = ptSortDir === -1 ? -Infinity : Infinity;
      return typeof av === 'string' ? av.localeCompare(bv) * ptSortDir : (av - bv) * ptSortDir;
    });
    ptRender();
  }
  const ptFmt = n => n != null ? '\u20b9' + Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
  function ptRender() {
    const start = (ptPage-1)*ptPP, slice = ptFiltered.slice(start, start+ptPP);
    document.getElementById('ptCount').textContent = ptFiltered.length + '/' + PT_ALL.length + ' trades';
    // Store slice globally for eye button access
    window._ptSlice = slice;
    document.getElementById('ptBody').innerHTML = slice.length === 0
      ? '<tr><td colspan="11" style="text-align:center;padding:20px;color:var(--muted-1,#8ba1c2);">No trades match filters.</td></tr>'
      : slice.map((t, i) => {
          const sc  = t.side === 'CE' ? '#10b981' : '#ef4444';
          const pc  = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
          const short = t.reason.length > 35 ? t.reason.slice(0,35)+'\u2026' : t.reason;
          const optDiff = (t.eOpt != null && t.xOpt != null) ? parseFloat((t.xOpt - t.eOpt).toFixed(2)) : null;
          const dc  = optDiff == null ? '#4a6080' : optDiff >= 0 ? '#10b981' : '#ef4444';
          return \`<tr style="border-top:1px solid #1a2236;vertical-align:top;">
            <td style="padding:8px 12px;color:\${sc};font-weight:800;">\${t.side||'—'}</td>
            <td style="padding:8px 12px;font-size:0.75rem;">\${ptFmtDate(t.entry)}</td>
            <td style="padding:8px 12px;font-weight:700;">\${ptFmt(t.eSpot)}</td>
            <td style="padding:8px 12px;font-size:0.75rem;">\${ptFmtTime(t.entry)}</td>
            <td style="padding:8px 12px;font-weight:700;">\${ptFmt(t.xSpot)}</td>
            <td style="padding:8px 12px;font-size:0.75rem;">\${ptFmtTime(t.exit)}</td>
            <td style="padding:8px 12px;color:#f59e0b;">\${t.eSl?ptFmt(t.eSl):'—'}</td>
            <td style="padding:8px 12px;">
              <div style="font-size:1rem;font-weight:800;color:\${pc};">\${t.pnl!=null?(t.pnl>=0?'+':'')+ptFmt(t.pnl):'—'}</div>
            </td>
            <td style="padding:8px 12px;font-size:0.7rem;color:var(--muted-1,#8ba1c2);" title="\${t.entryReason||''}">\${t.entryReason?(t.entryReason.length>25?t.entryReason.slice(0,25)+'\u2026':t.entryReason):'—'}</td>
            <td style="padding:8px 12px;font-size:0.7rem;color:var(--muted-1,#8ba1c2);" title="\${t.reason}">\${short||'—'}</td>
            <td style="padding:6px 8px;text-align:center;"><button data-idx="\${i}" class="pt-eye-btn" style="background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;" title="View full details">👁</button></td>
          </tr>\`;
        }).join('');
    // Eye button click handlers
    Array.from(document.querySelectorAll('.pt-eye-btn')).forEach(function(btn){
      btn.addEventListener('click',function(){ showPTModal(window._ptSlice[parseInt(this.getAttribute('data-idx'))]); });
      btn.addEventListener('mouseover',function(){ this.style.borderColor='#3b82f6';this.style.background='#0a1e3d'; });
      btn.addEventListener('mouseout', function(){ this.style.borderColor='#1a2236';this.style.background='none'; });
    });
    const total = Math.ceil(ptFiltered.length / ptPP);
    if (total <= 1) { document.getElementById('ptPag').innerHTML=''; return; }
    document.getElementById('ptPag').innerHTML =
      \`<button onclick="ptGo(\${ptPage-1})" \${ptPage===1?'disabled':''} style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">\u2190 Prev</button>\` +
      Array.from({length:total},(_,i)=>i+1).filter(p=>Math.abs(p-ptPage)<=2).map(p=>
        \`<button onclick="ptGo(\${p})" style="background:\${p===ptPage?'#0a1e3d':'#0d1320'};border:1px solid \${p===ptPage?'#1d3b6e':'#1a2236'};color:\${p===ptPage?'#3b82f6':'#c8d8f0'};padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">\${p}</button>\`).join('') +
      \`<button onclick="ptGo(\${ptPage+1})" \${ptPage===total?'disabled':''} style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">Next \u2192</button>\`;
  }
  function ptGo(p) { ptPage = Math.max(1, Math.min(Math.ceil(ptFiltered.length/ptPP),p)); ptRender(); }
  ptFilter();

  // ── Trade Detail Modal ──────────────────────────────────────────────────
  function showPTModal(t){
    const pc  = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
    const sc  = t.side === 'CE' ? '#10b981' : '#ef4444';
    const fmt = n => n != null && n !== 0 ? '₹' + Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
    const optDiff = (t.eOpt != null && t.xOpt != null) ? parseFloat((t.xOpt - t.eOpt).toFixed(2)) : null;
    const dc  = optDiff == null ? '#c8d8f0' : optDiff >= 0 ? '#10b981' : '#ef4444';
    const pnlPts = (t.eSpot && t.xSpot && t.side) ? parseFloat(((t.side==='PE' ? t.eSpot - t.xSpot : t.xSpot - t.eSpot)).toFixed(2)) : null;

    const badge = document.getElementById('ptm-badge');
    badge.textContent = (t.side || '—') + (t.strike ? ' · ' + t.strike : '') + (t.optionType ? ' ' + t.optionType : '');
    badge.style.background = t.side === 'CE' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
    badge.style.color = sc;
    badge.style.border = '1px solid ' + (t.side === 'CE' ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)');

    function cell(label, val, color, sub) {
      return '<div style="background:#060910;border:1px solid #1a2236;border-radius:8px;padding:11px 13px;">'
        + '<div style="font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-2,#6d85a8);margin-bottom:5px;">' + label + '</div>'
        + '<div style="font-size:0.9rem;font-weight:700;color:' + (color||'#e0eaf8') + ';font-family:monospace;line-height:1.3;">' + (val||'—') + '</div>'
        + (sub ? '<div style="font-size:0.62rem;color:var(--muted-1,#8ba1c2);margin-top:3px;">' + sub + '</div>' : '')
        + '</div>';
    }

    // ── Section: Option Contract ─────────────────────────────────────────
    const contractHtml = '<div style="background:#06100e;border:1px solid #0d3020;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
      + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#34d399;margin-bottom:8px;font-weight:700;">📋 Option Contract</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
      + cell('Symbol', t.symbol || '—', '#a0f0c0')
      + cell('Strike', t.strike || '—', '#fff')
      + cell('Expiry', t.expiry || '—', '#f59e0b')
      + cell('Option Type', t.optionType || t.side || '—', sc)
      + cell('Qty / Lots', t.qty ? t.qty + ' qty' : '—', '#c8d8f0')
      + cell('PnL Mode', t.pnlMode || 'spot-diff', '#8b8bf0')
      + '</div></div>';

    // ── Section: Entry ────────────────────────────────────────────────────
    const entryHtml = '<div style="background:#060c18;border:1px solid #0d2040;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
      + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#60a5fa;margin-bottom:8px;font-weight:700;">🟢 Entry</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
      + cell('Entry Time', t.entry || '—', '#c8d8f0')
      + cell('NIFTY Spot @ Entry', fmt(t.eSpot), '#fff', 'Index price at entry')
      + cell('Option LTP @ Entry', fmt(t.eOpt), '#60a5fa', 'Option premium paid')
      + cell('Initial Stop Loss', fmt(t.eSl), '#f59e0b', 'NIFTY spot SL level')
      + cell('SL Distance', (t.eSl && t.eSpot) ? Math.abs(t.eSpot - t.eSl).toFixed(2) + ' pts' : '—', '#f59e0b', 'pts from entry to SL')
      + cell('Entry Signal', t.entryReason || '—', '#a0b8d0')
      + '</div></div>';

    // ── Section: Exit ────────────────────────────────────────────────────
    const exitHtml = '<div style="background:#0c0608;border:1px solid #3a0d12;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
      + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#f87171;margin-bottom:8px;font-weight:700;">🔴 Exit</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
      + cell('Exit Time', t.exit || '—', '#c8d8f0')
      + cell('NIFTY Spot @ Exit', fmt(t.xSpot), '#fff', 'Index price at exit')
      + cell('Option LTP @ Exit', fmt(t.xOpt), '#60a5fa', 'Option premium at exit')
      + cell('NIFTY Move (pts)', pnlPts != null ? (pnlPts >= 0 ? '+' : '') + pnlPts + ' pts' : '—', pnlPts != null ? (pnlPts >= 0 ? '#10b981' : '#ef4444') : '#c8d8f0', t.side === 'PE' ? 'Entry−Exit (PE profits on fall)' : 'Exit−Entry (CE profits on rise)')
      + cell('Option Δ (pts)', optDiff != null ? (optDiff >= 0 ? '▲ +' : '▼ ') + optDiff + ' pts' : '—', dc, 'Exit prem − Entry prem')
      + (function(){
          if (t.peakOpt == null) return cell('Peak Premium', '—', '#c8d8f0', 'Highest premium in trade');
          const peakGain  = (t.eOpt != null) ? parseFloat((t.peakOpt - t.eOpt).toFixed(2)) : null;
          const giveback  = (t.xOpt != null) ? parseFloat((t.peakOpt - t.xOpt).toFixed(2)) : null;
          const sub = (peakGain != null ? '+' + peakGain + ' pts peak' : 'peak') + (giveback != null ? ' · gave back ' + giveback : '');
          return cell('Peak Premium', fmt(t.peakOpt), '#a78bfa', sub);
        })()
      + cell('Net PnL', t.pnl != null ? (t.pnl >= 0 ? '+' : '') + fmt(t.pnl) : '—', pc, 'After STT + charges')
      + '</div></div>';

    // ── Section: Exit Reason ─────────────────────────────────────────────
    const reasonHtml = '<div style="background:#060910;border:1px solid #1a2236;border-radius:10px;padding:12px 14px;">'
      + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted-2,#6d85a8);margin-bottom:6px;font-weight:700;">📌 Exit Reason</div>'
      + '<div style="font-size:0.82rem;color:#a0b8d0;line-height:1.6;font-family:monospace;">' + (t.reason || '—') + '</div>'
      + '</div>';

    document.getElementById('ptm-grid').innerHTML = contractHtml + entryHtml + exitHtml + reasonHtml;
    document.getElementById('ptm-reason').style.display = 'none'; // reason now in grid
    const m = document.getElementById('ptModal');
    m.style.display = 'flex';
  }
  document.getElementById('ptModal').addEventListener('click',function(e){if(e.target===this)this.style.display='none';});

  // ── Copy Trade Log ──────────────────────────────────────────────────
  function copyTradeLog(btn){
    var lines=['Side\\tDate\\tEntry\\tEntry Time\\tExit\\tExit Time\\tSL\\tPnL\\tEntry Reason\\tExit Reason'];
    PT_ALL.forEach(function(t){
      lines.push((t.side||'')+'\\t'+ptFmtDate(t.entry)+'\\t'+(t.eSpot||'')+'\\t'+ptFmtTime(t.entry)+'\\t'+(t.xSpot||'')+'\\t'+ptFmtTime(t.exit)+'\\t'+(t.eSl||'')+'\\t'+(t.pnl!=null?t.pnl.toFixed(2):'')+'\\t'+(t.entryReason||'')+'\\t'+(t.reason||''));
    });
    doCopy(lines.join('\\n'),btn,'Trade Log');
  }
  function doCopy(text,btn,label){
    var orig='📋 Copy '+label;
    function onOk(){ btn.classList.add('copied');btn.textContent='✅ Copied!'; setTimeout(function(){ btn.classList.remove('copied');btn.textContent=orig; },2000); }
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(onOk).catch(function(){
        var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
        document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);onOk();
      });
    } else {
      var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);onOk();
    }
  }
  </script>` : ""}

  <div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
      <div class="section-title" style="margin-bottom:0;">Activity Log</div>
      <input id="logSearch" placeholder="Search log…" oninput="logFilter()"
        style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 9px;border-radius:6px;font-size:0.73rem;font-family:inherit;width:180px;"/>
      <select id="logType" onchange="logFilter()"
        style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All entries</option>
        <option value="✅">✅ Wins</option>
        <option value="❌">❌ Errors</option>
        <option value="🚨">🚨 Alerts</option>
      </select>
      <select id="logPP" onchange="logFilter()"
        style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="50">50/page</option>
        <option value="100">100/page</option>
        <option value="9999">All</option>
      </select>
      <span id="logCount" style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);"></span>
      <button class="copy-btn" onclick="copyActivityLog(this)" style="margin-left:auto;">📋 Copy Log</button>
    </div>
    <div id="logBox" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:12px 16px;max-height:360px;overflow-y:auto;"></div>
    <div id="logPag" style="display:flex;gap:5px;margin-top:8px;flex-wrap:wrap;"></div>
  </div>
</div>

<script id="log-data" type="application/json">${logsJSON}</script>
<script>
var LOG_ALL = JSON.parse(document.getElementById('log-data').textContent);
var logFiltered = LOG_ALL.slice(), logPg = 1, logPP = 50;

function logFilter(){
  var s = document.getElementById('logSearch').value.toLowerCase();
  var t = document.getElementById('logType').value;
  logPP = parseInt(document.getElementById('logPP').value);
  logPg = 1;
  logFiltered = LOG_ALL.filter(function(l){
    if(t && l.indexOf(t)<0) return false;
    if(s && l.toLowerCase().indexOf(s)<0) return false;
    return true;
  });
  logRender();
}
function logRender(){
  var start=(logPg-1)*logPP, slice=logFiltered.slice(start,start+logPP);
  document.getElementById('logCount').textContent = logFiltered.length+' of '+LOG_ALL.length;
  var box=document.getElementById('logBox');
  if(slice.length===0){ box.innerHTML='<div style="color:var(--muted-1,#8ba1c2);font-size:0.78rem;">No entries match.</div>'; document.getElementById('logPag').innerHTML=''; return; }
  box.innerHTML = slice.map(function(l){
    var c = l.indexOf('❌')>=0?'#ef4444':l.indexOf('✅')>=0?'#10b981':l.indexOf('🚨')>=0?'#f59e0b':'#4a6080';
    return '<div style="padding:5px 0;border-bottom:1px solid #1a2236;font-size:0.72rem;font-family:monospace;color:'+c+';line-height:1.4;">'+l+'</div>';
  }).join('');
  var total=Math.ceil(logFiltered.length/logPP);
  var pag=document.getElementById('logPag');
  if(total<=1){ pag.innerHTML=''; return; }
  var h='<button onclick="logGo('+(logPg-1)+')" '+(logPg===1?'disabled':'')+' style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">\u2190 Prev</button>';
  for(var p=Math.max(1,logPg-2);p<=Math.min(total,logPg+2);p++)
    h+='<button onclick="logGo('+p+')" style="background:'+(p===logPg?'#0a1e3d':'#0d1320')+';border:1px solid '+(p===logPg?'#3b82f6':'#1a2236')+';color:'+(p===logPg?'#3b82f6':'#c8d8f0')+';padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">'+p+'</button>';
  h+='<button onclick="logGo('+(logPg+1)+')" '+(logPg===total?'disabled':'')+' style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">Next \u2192</button>';
  pag.innerHTML=h;
}
function logGo(p){ logPg=Math.max(1,Math.min(Math.ceil(logFiltered.length/logPP),p)); logRender(); }
function copyActivityLog(btn){
  var txt=LOG_ALL.join('\\n');
  var orig=btn.textContent;
  function done(){ btn.classList.add('copied'); btn.textContent='\\u2705 Copied!'; setTimeout(function(){ btn.classList.remove('copied'); btn.textContent=orig; },2000); }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(done).catch(function(){
      var ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);done();
    });
  } else {
    var ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);done();
  }
}
logFilter();
</script>
<script>
${modalJS()}
</script>
<script src="/st_rsi_piv_bb-paper/client.js"></script>
<script>
// ── NIFTY Chart (Lightweight Charts by TradingView) ─────────────────────────
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  const container = document.getElementById('nifty-chart');
  if (!container) return;

  const chart = LightweightCharts.createChart(container, {
    width:  container.clientWidth,
    height: container.clientHeight,
    layout: { background: { type: 'solid', color: '#0a0f1c' }, textColor: '#8ba1c2', fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" },
    grid:   { vertLines: { color: '#111827' }, horzLines: { color: '#111827' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1a2236', scaleMargins: { top: 0.1, bottom: 0.05 } },
    timeScale: { borderColor: '#1a2236', timeVisible: true, secondsVisible: false,
      tickMarkFormatter: function(time) {
        var d = new Date(time * 1000);
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      }
    },
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor:   '#10b981', downColor:   '#ef4444',
    borderUpColor: '#10b981', borderDownColor: '#ef4444',
    wickUpColor:   '#10b981', wickDownColor:   '#ef4444',
  });

  // Bollinger Bands (upper / middle / lower), SuperTrend and RSI — every point from
  // engine.computeSeries() on the CLOSED candles, i.e. exactly what the signal read.
  const bbUpSeries  = chart.addLineSeries({ color:'#a78bfa', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false, title:'BB up' });
  const bbMidSeries = chart.addLineSeries({ color:'#64748b', lineWidth:1, lineStyle: LightweightCharts.LineStyle.Dotted, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false, title:'BB mid' });
  const bbLoSeries  = chart.addLineSeries({ color:'#a78bfa', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false, title:'BB low' });
  // SuperTrend line (solid) — per-point colour: GREEN when bullish (line below price), RED when bearish.
  const stSeries   = chart.addLineSeries({ color:'#22c55e', lineWidth:2, priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false, title:'ST' });
  // Colour each SuperTrend point by its trend (1=up→green, -1=down→red). Falls back to green if trend missing.
  const _stColor = function(p){ return { time:p.time, value:p.value, color: (p.trend === -1 ? '#ef4444' : '#22c55e') }; };
  const rsiSeries  = chart.addLineSeries({ color:'#22d3ee', lineWidth:1, priceScaleId:'rsi', priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false, title:'RSI' });
  // Pin RSI to the bottom ~20% of the pane so it doesn't distort the price axis.
  chart.priceScale('rsi').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  let _rsiLevelsDrawn = false;
  function drawRsiLevels(ceMin, peMax) {
    if (_rsiLevelsDrawn) return;
    _rsiLevelsDrawn = true;
    const mk = (price, color, title) => rsiSeries.createPriceLine({ price, color, lineWidth:1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title });
    mk(ceMin != null ? ceMin : 70, '#10b981', 'CE');  // RSI_CE_MIN — CE needs RSI above
    mk(peMax != null ? peMax : 30, '#ef4444', 'PE');  // RSI_PE_MAX — PE needs RSI below
  }

  // SL line
  let slLine = null;
  // Entry price line
  let entryLine = null;
  // Pivot price lines — R1/S1 prominent, PP/R2/S2 light
  let pivLines = [];

  let _lastCandleCount = 0;

  // Robust zoom preservation: ignore programmatic range changes during fetch and
  // pin to the user's most recent manual zoom/pan range on every poll.
  chart.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: false, lockVisibleTimeRangeOnResize: true });
  let _userRange = null, _internalUpdate = false, _internalTimer = null;
  chart.timeScale().subscribeVisibleLogicalRangeChange(function(r) {
    if (_internalUpdate) return;
    if (r) _userRange = r;
  });

  async function fetchChart() {
    try {
      const res = await fetch('/st_rsi_piv_bb-paper/status/chart-data', { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();

      if (!d.candles || d.candles.length === 0) return;

      // Trim every series to the latest IST trading day so zooming out still
      // shows only today — warmup history stays server-side for indicator calc.
      (function(){
        var _lt=d.candles[d.candles.length-1].time, _dk=Math.floor((_lt+19800)/86400), _cut=_lt;
        for (var _i=d.candles.length-1;_i>=0;_i--){ if(Math.floor((d.candles[_i].time+19800)/86400)===_dk) _cut=d.candles[_i].time; else break; }
        var _k=function(a){ return Array.isArray(a)?a.filter(function(x){return x.time>=_cut;}):a; };
        d.candles=_k(d.candles);
        ['bbUpper','bbMiddle','bbLower','supertrend','rsi','markers'].forEach(function(kk){ if(d[kk]) d[kk]=_k(d[kk]); });
      })();

      _internalUpdate = true;

      // Full reload if candle count changed significantly (new session), else just update last candle
      if (Math.abs(d.candles.length - _lastCandleCount) > 1 || _lastCandleCount === 0) {
        candleSeries.setData(d.candles.map(function(c) {
          return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
        }));
      } else if (d.candles.length > 0) {
        var last = d.candles[d.candles.length - 1];
        candleSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
      }
      _lastCandleCount = d.candles.length;

      // Indicator overlays
      if (d.bbUpper  && d.bbUpper.length)  bbUpSeries.setData(d.bbUpper);  else bbUpSeries.setData([]);
      if (d.bbMiddle && d.bbMiddle.length) bbMidSeries.setData(d.bbMiddle); else bbMidSeries.setData([]);
      if (d.bbLower  && d.bbLower.length)  bbLoSeries.setData(d.bbLower);  else bbLoSeries.setData([]);
      if (d.supertrend && d.supertrend.length) stSeries.setData(d.supertrend.map(_stColor)); else stSeries.setData([]);
      if (d.rsi   && d.rsi.length) { rsiSeries.setData(d.rsi); drawRsiLevels(d.rsiCeMin, d.rsiPeMax); } else rsiSeries.setData([]);

      // Markers (entries & exits)
      if (d.markers && d.markers.length > 0) {
        var sorted = d.markers.slice().sort(function(a, b) { return a.time - b.time; });
        candleSeries.setMarkers(sorted.map(function(m) {
          return { time: m.time, position: m.position, color: m.color, shape: m.shape, text: m.text };
        }));
      } else {
        candleSeries.setMarkers([]);
      }

      // SL line
      if (slLine) { candleSeries.removePriceLine(slLine); slLine = null; }
      if (d.stopLoss) {
        slLine = candleSeries.createPriceLine({
          price: d.stopLoss, color: '#f59e0b', lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true, title: 'SL',
        });
      }

      // Entry price line
      if (entryLine) { candleSeries.removePriceLine(entryLine); entryLine = null; }
      if (d.entryPrice) {
        entryLine = candleSeries.createPriceLine({
          price: d.entryPrice, color: '#3b82f6', lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dotted,
          axisLabelVisible: true, title: 'Entry',
        });
      }

      // Pivots — the day's horizontal levels (R1/S1 prominent, PP/R2/S2 light)
      pivLines.forEach(function(l){ try { candleSeries.removePriceLine(l); } catch(_) {} });
      pivLines = [];
      if (d.pivots) {
        var _pv = d.pivots;
        var _mkP = function(price, color, title, width, style) {
          if (price == null) return;
          pivLines.push(candleSeries.createPriceLine({ price: price, color: color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title: title }));
        };
        _mkP(_pv.r1, '#f87171', 'R1', 2, LightweightCharts.LineStyle.Solid);
        _mkP(_pv.s1, '#34d399', 'S1', 2, LightweightCharts.LineStyle.Solid);
        _mkP(_pv.pp, 'rgba(148,163,184,0.55)', 'PP', 1, LightweightCharts.LineStyle.Dashed);
        _mkP(_pv.r2, 'rgba(248,113,113,0.35)', 'R2', 1, LightweightCharts.LineStyle.Dotted);
        _mkP(_pv.s2, 'rgba(52,211,153,0.35)', 'S2', 1, LightweightCharts.LineStyle.Dotted);
      }

      // Restore user's manual zoom/pan, then release the internal-update flag
      if (_userRange) { try { chart.timeScale().setVisibleLogicalRange(_userRange); } catch(_) {} }
      else {
        // First load (no manual zoom yet): show just the latest IST trading day.
        // The candle array carries multi-day warmup history for indicators;
        // fitting all of it renders spurious extra candles with repeated 09:15
        // day-boundary labels. _internalUpdate is true here so this programmatic
        // range change is ignored by the zoom watcher (stays null → keeps today).
        try {
          var lastT = d.candles[d.candles.length - 1].time;
          var dayK = Math.floor((lastT + 19800) / 86400);
          var firstT = lastT;
          for (var i = d.candles.length - 1; i >= 0; i--) {
            if (Math.floor((d.candles[i].time + 19800) / 86400) === dayK) firstT = d.candles[i].time;
            else break;
          }
          chart.timeScale().setVisibleRange({ from: firstT, to: lastT });
        } catch(_) {}
      }
      if (_internalTimer) clearTimeout(_internalTimer);
      _internalTimer = setTimeout(function() { _internalUpdate = false; }, 60);

    } catch (e) {
      console.warn('[Chart] fetch error:', e.message);
    }
  }

  // Initial load + poll every 4s
  fetchChart();
  if (${ptState.running}) {
    setInterval(fetchChart, 4000);
  }

  // Resize handler
  window.addEventListener('resize', function() {
    chart.applyOptions({ width: container.clientWidth });
  });
})();
</script>
${optionChart.optionChartScript({ dataUrl: '/st_rsi_piv_bb-paper/status/chart-data', id: 'srpb-opt-chart' })}
<script>
// ── AJAX live refresh — replaces meta http-equiv="refresh" ──────────────────
// Polls /st_rsi_piv_bb-paper/status/data every 2 s when trading is active.
// Updates only the dynamic parts of the DOM without a full-page reload,
// preserving scroll position, filter state, and sort state.

(function() {
  const INR = n => typeof n === 'number'
    ? '\u20b9' + n.toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2})
    : '\u2014';
  const PNL_COLOR = n => n >= 0 ? '#10b981' : '#ef4444';

  let _interval = null;
  let _lastTradeCount = ${ptState.sessionTrades.length};
  let _lastRunning    = ${ptState.running};
  let _lastLogCount   = ${ptState.log.length};
  let _lastHasPosition = ${ptState.position ? "true" : "false"};  // track position open/close

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el && el.textContent !== String(val)) el.textContent = val;
  }
  function setHTML(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = val;
  }
  function setStyle(el, prop, val) {
    if (el && el.style[prop] !== val) el.style[prop] = val;
  }

  async function fetchAndUpdate() {
    try {
      const res = await fetch('/st_rsi_piv_bb-paper/status/data', { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();

      // ── Stat cards ────────────────────────────────────────────────────────
      const pnlEl = document.getElementById('ajax-session-pnl');
      if (pnlEl) {
        pnlEl.textContent = INR(d.sessionPnl);
        pnlEl.style.color = PNL_COLOR(d.sessionPnl);
        const card = pnlEl.closest('.sc');
        if (card) card.style.borderTopColor = PNL_COLOR(d.sessionPnl);
      }
      const tcEl = document.getElementById('ajax-trade-count');
      if (tcEl) tcEl.textContent = d.tradeCount;
      const wlEl = document.getElementById('ajax-wl');
      if (wlEl) wlEl.textContent = d.wins + 'W \u00b7 ' + d.losses + 'L';

      // Loss streak — display only (this strategy has no consecutive-loss breaker).
      const clEl = document.getElementById('ajax-consec-losses');
      if (clEl) clEl.textContent = String(d.consecutiveLosses || 0);

      // Daily loss kill switch card
      const dlCard = document.getElementById('ajax-sc-dloss');
      const dlStatus = document.getElementById('ajax-daily-loss-status');
      if (dlCard) dlCard.style.borderTopColor = d.dailyLossHit ? '#ef4444' : '#10b981';
      if (dlStatus) {
        dlStatus.textContent = d.dailyLossHit ? '\uD83D\uDED1 KILLED \u2014 no entries' : '\u2705 Active';
        dlStatus.style.color = d.dailyLossHit ? '#ef4444' : '#10b981';
      }

      const candleEl = document.getElementById('ajax-candle-count');
      if (candleEl) {
        const need  = d.warmupNeed || 25;
        const ready = d.candleCount >= need && (d.candleCount5 == null || d.candleCount5 >= need);
        candleEl.textContent = d.candleCount + (d.candleCount5 != null ? ' \u00b7 ' + d.candleCount5 : '');
        candleEl.style.color = ready ? '#10b981' : '#f59e0b';
        const sub = document.getElementById('ajax-candle-status');
        if (sub) {
          sub.textContent = ready ? '\u2705 Strategy ready' : '\u26a0\ufe0f Warming up (need ' + need + ')';
          sub.style.color = ready ? '#10b981' : '#f59e0b';
        }
      }

      const tickEl = document.getElementById('ajax-tick-count');
      if (tickEl) tickEl.textContent = (d.tickCount || 0).toLocaleString();
      const ltpEl = document.getElementById('ajax-last-tick');
      if (ltpEl) ltpEl.textContent = d.lastTickPrice ? INR(d.lastTickPrice) : '\u2014';

      const phEl = document.getElementById('ajax-prev-high');
      if (phEl) phEl.textContent = d.prevCandleHigh ? INR(d.prevCandleHigh) : '\u2014';
      const plEl = document.getElementById('ajax-prev-low');
      if (plEl) plEl.textContent = d.prevCandleLow ? INR(d.prevCandleLow) : '\u2014';

      // ── Capital row ───────────────────────────────────────────────────────
      const capEl = document.getElementById('ajax-current-capital');
      if (capEl) {
        capEl.textContent = '\u20b9' + d.capital.toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2});
        capEl.style.color = d.capital >= ${getCapitalFromEnv()} ? '#10b981' : '#ef4444';
      }
      const atpEl = document.getElementById('ajax-alltime-pnl');
      if (atpEl) {
        atpEl.textContent = (d.totalPnl >= 0 ? '+' : '') + '\u20b9' + d.totalPnl.toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2});
        atpEl.style.color = PNL_COLOR(d.totalPnl);
      }

      // 4/4 checklist card — re-rendered from the server's last closed-candle evaluation
      if (d.checklist && typeof renderChecklist === 'function') renderChecklist(d.checklist);

      // ── Position section ─────────────────────────────────────────────────
      // If position state changed (flat→open or open→flat), reload page to render
      // the full position block HTML correctly. AJAX only patches existing elements.
      const nowHasPosition = !!d.position;
      if (nowHasPosition !== _lastHasPosition) {
        _lastHasPosition = nowHasPosition;
        // Full reload to re-render position HTML (entry opened or closed)
        window.location.reload();
        return;
      }
      if (d.position) {
        const p = d.position;
        // Option premium block
        const entEl = document.getElementById('ajax-opt-entry-ltp');
        if (entEl) {
          entEl.textContent = p.optionEntryLtp ? '\u20b9' + p.optionEntryLtp.toFixed(2) : 'Fetching...';
          entEl.style.color = p.optionEntryLtp ? '#60a5fa' : '#f59e0b';
        }
        const curEl = document.getElementById('ajax-opt-current-ltp');
        if (curEl) {
          curEl.textContent = p.optionCurrentLtp ? '\u20b9' + p.optionCurrentLtp.toFixed(2) : '\u23f3';
          if (p.optionEntryLtp && p.optionCurrentLtp) {
            curEl.style.color = p.optionCurrentLtp >= p.optionEntryLtp ? '#10b981' : '#ef4444';
          }
        }
        const movEl = document.getElementById('ajax-opt-move');
        if (movEl && p.optPremiumMove !== null) {
          movEl.textContent = (p.optPremiumMove >= 0 ? '\u25b2 +' : '\u25bc ') + '\u20b9' + Math.abs(p.optPremiumMove).toFixed(2) + ' pts';
          movEl.style.color = p.optPremiumMove >= 0 ? '#10b981' : '#ef4444';
        }
        // % change on option premium
        const pctEl = document.getElementById('ajax-opt-pct');
        if (pctEl) {
          if (p.optPremiumPct !== null && p.optPremiumPct !== undefined) {
            pctEl.textContent = (p.optPremiumPct >= 0 ? '+' : '') + p.optPremiumPct.toFixed(2) + '%';
            pctEl.style.color = p.optPremiumPct >= 0 ? '#10b981' : '#ef4444';
          } else {
            pctEl.textContent = '\u2014';
          }
        }
        // No Option-SL card \u2014 the SuperTrend stop (tested on candle close) is the only stop.
        const optPnlEl = document.getElementById('ajax-opt-pnl');
        if (optPnlEl && p.optPremiumPnl !== null) {
          optPnlEl.textContent = (p.optPremiumPnl >= 0 ? '+' : '') + INR(p.optPremiumPnl);
          optPnlEl.style.color = PNL_COLOR(p.optPremiumPnl);
          const card = optPnlEl.closest('[id^="ajax-opt-pnl-card"]') || optPnlEl.parentElement;
          if (card) {
            card.style.background = p.optPremiumPnl >= 0 ? '#071a0f' : '#1a0707';
          }
        }
        // NIFTY LTP — use lastTickPrice (every tick) for live feel; fall back to currentBar.close
        const ltpLiveEl = document.getElementById('ajax-nifty-ltp');
        const ltpNow = d.lastTickPrice || p.liveClose;
        if (ltpLiveEl && ltpNow !== null) {
          ltpLiveEl.textContent = INR(ltpNow);
          const sub = document.getElementById('ajax-nifty-move');
          if (sub && p.entryPrice) {
            const moved = parseFloat(((ltpNow - p.entryPrice) * (p.side === 'CE' ? 1 : -1)).toFixed(1));
            sub.textContent = (moved >= 0 ? '\u25b2' : '\u25bc') + ' ' + Math.abs(moved).toFixed(1) + ' pts';
            sub.style.color = moved >= 0 ? '#10b981' : '#ef4444';
          }
        }
        // SL
        const slEl = document.getElementById('ajax-stop-loss');
        if (slEl) slEl.textContent = p.stopLoss ? INR(p.stopLoss) : '\u2014';
        // Trail status card
        const trailCard  = document.getElementById('ajax-trail-card');
        const trailStat  = document.getElementById('ajax-trail-status');
        const trailBest  = document.getElementById('ajax-trail-best');
        const trailAct   = document.getElementById('ajax-trail-activate');
        if (trailCard && trailStat && trailBest) {
          const tActive     = p.bestPrice !== null && p.bestPrice !== undefined;
          const tProfit     = tActive ? parseFloat(Math.abs(p.bestPrice - p.entryPrice).toFixed(2)) : 0;
          const tProfDir    = tActive ? (p.side === 'CE' ? p.bestPrice - p.entryPrice : p.entryPrice - p.bestPrice) : 0;
          const trailLbl    = trailCard.dataset.trail || 'SuperTrend';
          const inProfit    = tProfDir > 0;
          trailCard.style.borderColor = inProfit ? '#8b5cf6' : '#134e35';
          trailStat.textContent  = trailLbl;
          trailStat.style.color  = inProfit ? '#8b5cf6' : '#f59e0b';
          const pts = tProfDir >= 0 ? '+' + tProfit.toFixed(1) : tProfit.toFixed(1);
          trailBest.textContent  = tActive ? 'Best: \u20b9' + p.bestPrice.toLocaleString('en-IN') + ' (' + pts + ' pts)' : 'Best: \u2014 (+0.0 pts)';
          if (trailAct) trailAct.textContent = 'Trail source: ' + trailLbl;
        }
      }

      // ── Current bar ───────────────────────────────────────────────────────
      if (d.currentBar) {
        ['open','high','low','close'].forEach(k => {
          const el = document.getElementById('ajax-bar-' + k);
          if (el) el.textContent = INR(d.currentBar[k]);
        });
      }

      // ── Trades table — only re-render if trade count changed ─────────────
      if (d.trades && d.tradeCount !== _lastTradeCount) {
        _lastTradeCount = d.tradeCount;
        // Inject updated data and re-filter maintaining current filter state
        if (typeof PT_ALL !== 'undefined') {
          PT_ALL.length = 0;
          d.trades.forEach(function(t){ PT_ALL.push(t); });
        } else {
          window.PT_ALL = d.trades.slice();
        }
        ptFiltered = [...PT_ALL];
        ptFilter();
      }

      // ── Activity log — only re-render if log grew ──────────────────────
      if (d.logs && d.logTotal !== _lastLogCount) {
        _lastLogCount = d.logTotal;
        if (typeof LOG_ALL !== 'undefined') {
          LOG_ALL.length = 0;
          d.logs.forEach(function(l){ LOG_ALL.push(l); });
          logFilter();
        }
      }

      // ── Detect stop — reload page once to show idle state cleanly ────────
      if (_lastRunning && !d.running) {
        _lastRunning = false;
        clearInterval(_interval);
        _interval = null;
        // Brief delay then reload so user sees "STOPPED" state with fresh page
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (e) {
      console.warn('[AJAX refresh] fetch error:', e.message);
    }
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  if (${ptState.running}) {
    _interval = setInterval(fetchAndUpdate, 2000);
    // Show live indicator in subtitle
    const sub = document.querySelector('[data-refresh-note]');
    if (sub) sub.textContent = '\u21bb Auto-refreshing every 2s (AJAX)';
  }
})();
</script>
</div></div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
  } catch (err) {
    console.error("[paperTrade/status] Error:", err.message, err.stack);
    return res.status(500).send(`<pre style="color:red;padding:32px;font-family:monospace;">Paper Trade Status Error: ${err.message}\n\n${err.stack}</pre>`);
  }
});

/**
 * GET /st_rsi_piv_bb-paper/history
 * All past paper trade sessions with summary stats
 */
router.get("/history", (req, res) => {
  const data = loadPaperData();
  const liveActive = sharedSocketState.getStRsiPivBbMode() === "ST_RSI_PIV_BB_LIVE";
  res.setHeader("Content-Type", "text/html");
  res.send(renderHistoryPage({
    routePrefix: "/st_rsi_piv_bb-paper",
    sidebarKey: "stRsiPivBbHistory",
    pageTitle: "📉 ST_RSI_PIV_BB Paper Trade History",
    pageDocTitle: "ST_RSI_PIV_BB Paper — History",
    modalLabel: "ST_RSI_PIV_BB Paper",
    liveActive,
    sessions: data.sessions || [],
    capital: data.capital,
    totalPnl: data.totalPnl,
    startCap: getCapitalFromEnv(),
    emptyLabel: "Start ST_RSI_PIV_BB paper trading to record your first session.",
    // ST_RSI_PIV_BB trades through Zerodha — contract notes use the Kite (default) rates,
    // not the Fyers schedule the route-prefix lookup would pick.
    contractRow: (t) => require("../utils/contractNote").contractRow(t, undefined),
  }));
});

/**
 * GET /st_rsi_piv_bb-paper/download/trades.jsonl
 * Stream the crash-safe per-trade JSONL log as a file download.
 */
router.get("/download/trades.jsonl", (req, res) => {
  const logPath = tradeLogger.filePathFor("st_rsi_piv_bb");
  const today   = new Date().toISOString().slice(0, 10);
  const dlName  = `st_rsi_piv_bb_paper_trades_log_${today}.txt`;
  const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
  if (ai) {
    let text = ""; try { text = fs.readFileSync(logPath, "utf8"); } catch (_) {}
    const md = aiExport.jsonlToMarkdown(text, { title: "ST_RSI_PIV_BB paper trades (full log)", source: "st_rsi_piv_bb-paper" });
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="st_rsi_piv_bb_paper_trades_AI_${today}.md"`);
    return res.send(md);
  }
  if (!fs.existsSync(logPath)) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${dlName}"`);
    return res.send("");
  }
  res.download(logPath, dlName);
});

// ── Daily JSONL downloads (skips + trades) ───────────────────────────────────
const _DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/download/daily-files", (req, res) => {
  const skips  = skipLogger.listDates("st_rsi_piv_bb");
  const trades = tradeLogger.listDailyDates("st_rsi_piv_bb");
  const byDate = new Map();
  for (const s of skips)  byDate.set(s.date, { date: s.date, skipsSize: s.size, tradesSize: 0 });
  for (const t of trades) {
    const row = byDate.get(t.date) || { date: t.date, skipsSize: 0, tradesSize: 0 };
    row.tradesSize = t.size;
    byDate.set(t.date, row);
  }
  const rows = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  res.json(dailyFilesPaginate(rows, req.query));
});

router.get("/download/skips-all", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const dlName = `st_rsi_piv_bb_paper_skips_all_${today}.txt`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${dlName}"`);
  const dates = skipLogger.listDates("st_rsi_piv_bb").map(d => d.date).sort();
  let body = "";
  for (const d of dates) {
    try {
      const p = skipLogger.filePathFor("st_rsi_piv_bb", d);
      if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8");
    } catch (_) {}
  }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor("st_rsi_piv_bb", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `st_rsi_piv_bb_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor("st_rsi_piv_bb", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `st_rsi_piv_bb_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor("st_rsi_piv_bb", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor("st_rsi_piv_bb", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

/**
 * GET /st_rsi_piv_bb-paper/reset
 * Wipe all paper trade history and reset capital to .env default
 */
router.get("/reset", (req, res) => {
  if (ptState.running) {
    return res.status(400).json({
      success: false,
      error: "Stop paper trading first before resetting.",
    });
  }

  const freshCapital = getCapitalFromEnv();
  savePaperData({ capital: freshCapital, totalPnl: 0, sessions: [] });
  require("../utils/paperReset").clearTodayFiles("st_rsi_piv_bb"); // else restart rehydrates today's session

  log(`🔄 Paper trade data reset. Capital restored to ₹${freshCapital.toLocaleString("en-IN")}`);

  return res.json({
    success: true,
    message: `Paper trade history cleared. Capital reset to ₹${freshCapital.toLocaleString("en-IN")}`,
  });
});

/**
 * DELETE /st_rsi_piv_bb-paper/session/:index
 * Delete a single session by its 0-based index in the sessions array
 */
router.delete("/session/:index", (req, res) => {
  if (ptState.running) {
    return res.status(400).json({
      success: false,
      error: "Stop paper trading first before deleting a session.",
    });
  }

  const data = loadPaperData();
  const idx = parseInt(req.params.index, 10);

  if (isNaN(idx) || idx < 0 || idx >= data.sessions.length) {
    return res.status(400).json({ success: false, error: "Invalid session index." });
  }

  const removed = data.sessions.splice(idx, 1)[0];
  const removedPnl = (removed && (removed.sessionPnl != null ? removed.sessionPnl : removed.pnl)) || 0;
  data.totalPnl = data.sessions.reduce(
    (sum, s) => sum + (s.sessionPnl != null ? s.sessionPnl : (s.pnl || 0)),
    0
  );
  data.capital = getCapitalFromEnv() + data.totalPnl;
  savePaperData(data);

  log(`🗑️ Deleted paper session ${idx + 1} (${removed?.date || "unknown date"}, PnL: ${removedPnl})`);

  return res.json({
    success: true,
    message: "Session deleted successfully.",
  });
});

// ── Restore deleted/missing sessions from daily JSONL ────────────────────────
// JSONL is append-only — Delete Session never touches it. This endpoint reads
// the daily trade JSONL for an IST date, finds trades not already in any
// existing session (deduped by entryBarTime), and rebuilds a session.
router.post("/restore-session/:date", (req, res) => {
  if (ptState.running) {
    return res.status(400).json({ success: false, error: "Stop paper trading before restoring." });
  }
  const date = String(req.params.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  }
  // Day files interleave settings_snapshot / meta lines with trades — real trades only.
  const allTrades = tradeLogger.readDailyTrades("st_rsi_piv_bb", date).filter(t => t && !t.type);
  if (!allTrades.length) {
    return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  }
  const data = loadPaperData();
  const seen = new Set();
  for (const s of (data.sessions || [])) {
    for (const t of (s.trades || [])) {
      const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`;
      if (key) seen.add(String(key));
    }
  }
  const missing = allTrades.filter(t => {
    const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`;
    return key && !seen.has(String(key));
  });
  if (!missing.length) {
    return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  }
  const sessionPnl = parseFloat(missing.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
  const wins   = missing.filter(t => (Number(t.pnl) || 0) > 0).length;
  const losses = missing.filter(t => (Number(t.pnl) || 0) <= 0).length;
  const session = {
    date,
    strategy:    missing[0]?.strategy || ACTIVE,
    instrument:  missing[0]?.instrument || "NIFTY_OPTIONS",
    startTime:   missing[0]?.entryTime || date,
    endTime:     missing[missing.length - 1]?.exitTime || date,
    trades:      missing,
    totalTrades: missing.length,
    wins,
    losses,
    winRate:     missing.length ? `${((wins / missing.length) * 100).toFixed(1)}%` : "N/A",
    sessionPnl,
    restoredFromJsonl: true,
  };
  data.sessions.push(session);
  data.sessions.sort((a, b) => istDayFromAny(a.date).localeCompare(istDayFromAny(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce(
    (sum, s) => sum + (s.sessionPnl != null ? s.sessionPnl : (s.pnl || 0)),
    0
  ).toFixed(2));
  data.capital = parseFloat((getCapitalFromEnv() + data.totalPnl).toFixed(2));
  savePaperData(data);
  // Restoring today pulls the rehydrated (unsaved) session's trades into the file.
  if (date === tradeLogger.istDateString(Date.now())) ptState._pnlSaved = true;
  capitalPool.sessionSaved("st_rsi_piv_bb");
  log(`♻️ Restored paper session for ${date}: ${missing.length} trade(s), PnL ₹${sessionPnl}`);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

/**
 * GET /st_rsi_piv_bb-paper/debug
 * Returns current state info to help diagnose why Start/Reset isn't working
 */
router.get("/debug", (req, res) => {
  const ls = ptState.lastSignal;
  res.json({
    running:              ptState.running,
    hasAccessToken:       !!process.env.ACCESS_TOKEN,
    hasAppId:             !!process.env.APP_ID,
    liveTradeActive:      sharedSocketState.isStRsiPivBbActive(),
    activeStrategy:       ACTIVE,
    entryTf:              _SESSION_ENTRY_TF,
    tradeResolution:      TRADE_RES,
    confirmResolution:    CONFIRM_RES,
    candlesLoaded:        ptState.candles.length,
    confirmCandlesLoaded: ptState.candles5.length,
    warmupNeed:           engine.warmupBars(),
    pivots:               ptState.pivots,
    pivotsError:          ptState._pivotsError,
    lastSignal:           ls ? { time: ls.time, signal: ls.signal, reason: ls.reason } : null,
    pendingEntry:         ptState._pendingEntry ? { signal: ptState._pendingEntry.sig.signal, attempts: ptState._pendingEntry.attempts || 0 } : null,
    tfNote:               _tfNote(),
    position:             ptState.position ? { side: ptState.position.side, entryPrice: ptState.position.entryPrice, stopLoss: ptState.position.stopLoss } : null,
    capital:              loadPaperData().capital,
    sessionPnl:           ptState.sessionPnl,
    isMarketHours:        isMarketHours(),
  });
});



/**
 * GET /st_rsi_piv_bb-paper/client.js
 * Serves the paper trade UI JavaScript as a static file.
 * Keeping it separate prevents ANY data injection from breaking the buttons.
 */
router.get("/client.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-cache");
  res.send(`async function handleStart(btn) {
  if (btn) { btn.textContent = '⏳ Starting...'; btn.disabled = true; }
  try {
    const res = await secretFetch('/st_rsi_piv_bb-paper/start');
    if (!res) { if (btn) { btn.textContent = '▶ Start'; btn.disabled = false; } return; }
    let data;
    try { data = await res.json(); } catch(_) { data = { success: false, error: 'Server error (non-JSON response)' }; }
    if (!data.success) {
      showToast('❌ ' + (data.error || 'Failed to start'), '#ef4444');
      if (btn) { btn.textContent = '▶ Start'; btn.disabled = false; }
      return;
    }
    showToast('✅ Paper trading started!', '#10b981');
    setTimeout(() => location.reload(), 1200);
  } catch(e) {
    showToast('❌ ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '▶ Start'; btn.disabled = false; }
  }
}
async function handleStop(btn) {
  if (btn) { btn.textContent = '⏳ Stopping...'; btn.disabled = true; }
  try {
    const res = await secretFetch('/st_rsi_piv_bb-paper/stop');
    if (!res) { if (btn) { btn.textContent = '⏹ Stop'; btn.disabled = false; } return; }
    showToast('⏹ Paper trading stopped.', '#ef4444');
    setTimeout(() => location.reload(), 1000);
  } catch(e) {
    showToast('❌ ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '⏹ Stop'; btn.disabled = false; }
  }
}
async function ptHandleReset(btn) {
  var ok = await showDoubleConfirm({
    icon: '⚠️', title: 'Reset Paper Trade',
    message: 'Reset ALL paper trade history?\\nThis will wipe all sessions and restore starting capital.\\nCannot be undone.',
    confirmText: 'Reset All', confirmClass: 'modal-btn-danger',
    subject: 'ALL paper sessions & capital',
    secondConfirmText: 'Yes, reset all'
  });
  if (!ok) return;
  if (btn) { btn.textContent = '⏳...'; btn.disabled = true; }
  try {
    const res = await secretFetch('/st_rsi_piv_bb-paper/reset');
    if (!res) { if (btn) { btn.textContent = '🔄 Reset'; btn.disabled = false; } return; }
    let data;
    try { data = await res.json(); } catch(_) { data = { success: false, error: 'Server error (status ' + res.status + ')' }; }
    if (!data.success) {
      showToast('❌ ' + (data.error || 'Reset failed'), '#ef4444');
      if (btn) { btn.textContent = '🔄 Reset'; btn.disabled = false; }
      return;
    }
    showToast('✅ ' + data.message, '#10b981');
    setTimeout(() => location.reload(), 1500);
  } catch(e) {
    showToast('❌ ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '🔄 Reset'; btn.disabled = false; }
  }
}
function ptExportCSV() {
  var PT = typeof PT_ALL !== 'undefined' ? PT_ALL : [];
  if (!PT.length) { showToast('⚠️ No trades to export', '#f59e0b'); return; }
  var header = ['Side','Symbol','Entry Time','Exit Time','Entry NIFTY','Entry Option','Exit NIFTY','Exit Option','PnL','Exit Reason'];
  var rows = PT.map(function(t){
    return [
      t.side||'', t.symbol||'',
      t.entry||'', t.exit||'',
      t.eSpot||'', t.eOpt||'',
      t.xSpot||'', t.xOpt||'',
      t.pnl!=null?t.pnl:'', t.reason||''
    ];
  });
  var csv = [header].concat(rows).map(function(r){
    return r.map(function(v){ return '"'+String(v||'').replace(/"/g,'""')+'"'; }).join(',');
  }).join('\\n');
  var d = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,\\uFEFF' + encodeURIComponent(csv);
  a.download = 'st_rsi_piv_bb_paper_trades_' + d + '.csv';
  a.click();
  showToast('✅ CSV downloaded — ' + PT.length + ' trades', '#10b981');
}
async function ptHandleExit(btn) {
  if (btn) { btn.textContent = '⏳ Exiting...'; btn.disabled = true; }
  try {
    const res = await secretFetch('/st_rsi_piv_bb-paper/exit');
    if (!res) { if (btn) { btn.textContent = '🚪 Exit Trade'; btn.disabled = false; } return; }
    const data = await res.json();
    if (!data.success) {
      showToast('❌ ' + (data.error || 'Exit failed'), '#ef4444');
      if (btn) { btn.textContent = '🚪 Exit Trade'; btn.disabled = false; }
      return;
    }
    showToast('🚪 Trade exited!', '#f59e0b');
    setTimeout(() => location.reload(), 1000);
  } catch(e) {
    showToast('❌ ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '🚪 Exit Trade'; btn.disabled = false; }
  }
}
function showToast(msg, color) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#0d1320;border:1px solid '+color+';color:'+color+';padding:12px 24px;border-radius:10px;font-size:0.85rem;font-weight:700;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,0.6);letter-spacing:0.5px;';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), color === '#ef4444' ? 7000 : 4000);
}
async function manualEntry(side) {
  var ok = await showConfirm({
    icon: '✋',
    title: 'Manual entry',
    message: 'Manual ' + side + ' entry at current spot?',
    confirmText: 'Enter ' + side
  });
  if (!ok) return;
  try {
    const res = await secretFetch('/st_rsi_piv_bb-paper/manualEntry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side: side })
    });
    if (!res) return;
    const data = await res.json();
    if (data.success) {
      showToast('✅ Manual ' + side + ' entered @ ₹' + data.spot, '#10b981');
      setTimeout(() => location.reload(), 1000);
    } else {
      showToast('❌ ' + (data.error || 'Entry failed'), '#ef4444');
    }
  } catch(e) {
    showToast('❌ ' + e.message, '#ef4444');
  }
}
`);
});

/**
 * stopSession() — square off + stop the session, callable by app.js
 * gracefulShutdown on SIGTERM / auto-deploy, so a harness-live Zerodha position
 * is squared off on a deploy/restart. Idempotent: no-op if not running.
 */
function stopSession(reason = "Shutdown square-off") {
  if (!ptState.running) { _releaseLiveHarness("stopSession — engine not running"); return; }
  try {
    if (ptState.position && (ptState.lastTickPrice || ptState.currentBar)) {
      const _px = ptState.lastTickPrice || ptState.currentBar.close;
      simulateSell(_px, reason, _px);
    }
  } catch (e) { try { log(`⚠️ [PAPER] stopSession squareoff error: ${e.message}`); } catch (_) {} }
  // Released AFTER the virtual square-off above (shutdown / SIGTERM path).
  _releaseLiveHarness("stopSession/shutdown");
  // The square-off above can throw, so a position may survive it. Free its
  // capital reservation either way — a leaked block would keep shrinking the
  // broker pool for the rest of the process.
  capitalPool.clear("st_rsi_piv_bb");
  try { stopOptionPolling(); } catch (_) {}
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  sharedSocketState.clearStRsiPivBbMode();
  socketManager.removeCallback(SOCKET_CALLBACK_ID);
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) {
    socketManager.stop();
  }
  ptState.running = false;
  ptState._pendingEntry = null;
  try { saveSession(); } catch (_) {}
}
router.stopSession = stopSession;

module.exports = router;

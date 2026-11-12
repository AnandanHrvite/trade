/**
 * PAPER TRADE — /gap_runaway-paper   (GAP_runAway__Kirubakaran · NIFTY 50 · Zerodha)
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses LIVE market data (Fyers WebSocket) but SIMULATES orders locally.
 * NO real orders are placed. Everything is tracked in memory + saved to disk.
 * Layout and plumbing come from pivotEmaStPaper.js (same UI/UX as
 * /ema_rsi_st-paper); every RULE lives in src/strategies/gap_runaway.js —
 * this route computes NO indicators and makes NO threshold comparisons of its
 * own. Every engine call passes the env prefix "GAP_RUNAWAY".
 * Reference video: GAP_RUNAWAY_REFERENCE_URL (https://www.youtube.com/watch?v=uLTaXTyDxiI).
 *
 *   SETUP  : the NIFTY DAILY series (DAILY_LOOKBACK_DAYS of history), fetched at
 *            /start and on an IST-day change. engine.dailySetup() reads
 *            YESTERDAY's closed bar: RSI(10) on EMA21 below 10 = oversold, above
 *            90 = overbought, and yesterday's close (the gap-fill level).
 *   OPEN   : today's official open = the open of today's 09:15 1-min bar from
 *            Fyers history (time-verified to be today). If history cannot give it
 *            within ~20s, the first live tick at/after 09:15 is used (logged).
 *   ENTRY  : once, inside GAP_RUNAWAY_ENTRY_START..END (09:15–09:30), on the
 *            first tick once the open is known — engine.getSignal():
 *              oversold  + gap UP   → BUY the ATM CE
 *              overbought + gap DOWN → BUY the ATM PE
 *            Refused if spot has already filled the gap (engine.entryStillValid).
 *            A failed FILL (no symbol / premium) retries every 5s inside the window.
 *            ONE trade per day — no re-entry after any exit.
 *   EXIT   : the common profit lock (tradeGuards.checkProfitLock) on the option
 *            premium, per tick — the ONLY automatic exit. Otherwise a manual
 *            exit, or the session auto-stop at TRADE_STOP_TIME. Nothing overnight.
 *   SIZE   : GAP_RUNAWAY_LOTS × the NIFTY lot (default 1 lot). ATM strike exactly
 *            (strikeOverride — the global strike offsets do not apply).
 *
 * DELIBERATELY NOT HERE (the user's rule: "any common settings don't apply" —
 * except the profit lock, which applies to every strategy since 2026-11-07):
 * no wait-after-exit, no bid-ask spread check, no common 10:00–14:00 window, no LOT_MULTIPLIER, no portfolio cap, no
 * expiry-day-only toggle, no NIFTY futures mode, no VIX / OI / volume / trend
 * filter. No backtest page, no replay support. The only shared items used are
 * the common profit lock, the common option expiry (to pick the contract), the
 * brokerage/charges model (real-world costs, not a rule) and the ZERODHA capital
 * pool (the user's call: one money pool for every strategy).
 *
 * MARKETS. This file is a create(pair) builder (see utils/pairRuntime.js and
 * routes/emaRsiStV2Paper.js, the pilot). The default export is the NIFTY
 * instance: /gap_runaway-paper, the same files, keys, Zerodha book, logs and
 * decisions. forMarket(key) builds the same engine for every other market
 * pairs.js offers it on (SENSEX, BANKNIFTY, NIFTY futures, stock options —
 * never MCX: it needs the 09:15 index open), each with its own route
 * /<modeKey>-paper, trades file, logs, day-decision file, crash snapshot,
 * socket slot and Fyers capital book. The daily setup and today's open come
 * from THAT market's index (BSE:SENSEX-INDEX, NSE:NIFTYBANK-INDEX …); the ATM
 * is rounded on its own strike grid, on its own expiry (SENSEX weekly,
 * BANKNIFTY monthly), and GAP_RUNAWAY_LOTS (or <PAIR>_LOTS) × its own lot sizes
 * the trade. The NIFTY_FUT pair trades the month future off the NIFTY gap: a
 * LONG on a CE signal, a SHORT on a PE signal, P&L on the index level, exit =
 * the common stop mapped to index points (tradeGuards.checkFuturesStop).
 * Pair-only behaviour sits behind `!rt.home`: its own ON switch
 * (<PAIR>_MODE_ENABLED, default off), <PAIR>_EXPIRY_DAY_ONLY on that market's
 * expiry, the spread limit and the fill at the ask / bid of a fresh quote
 * (<PAIR>_PAPER_FILL_AT_QUOTE), that exchange's charges.
 *
 * Flow:
 *   /gap_runaway-paper/start   → connects to live socket, starts simulating trades
 *   /gap_runaway-paper/stop    → stops socket, saves final session summary
 *   /gap_runaway-paper/status  → live view: position, PnL, capital, setup, log
 *   /gap_runaway-paper/history → all past paper trade sessions
 *   /gap_runaway-paper/reset   → wipe paper trade history & reset capital
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const { trackPath, pathFields } = require("../utils/tradePath");
const fs = require("fs");
const path = require("path");
// The engine is the SINGLE source of truth for the daily setup, the entry
// decision and the entry window.
const engine = require("../strategies/gap_runaway");
const tradeGuards = require("../utils/tradeGuards");
const instrumentConfig = require("../config/instrument");
const { validateAndGetOptionSymbol } = instrumentConfig;
const sharedSocketState = require("../utils/sharedSocketState");
const socketManager = require("../utils/socketManager"); // ← robust socket wrapper
const tickRecorder  = require("../utils/tickRecorder");
const optionFeed    = require("../utils/optionFeed");
const { verifyFyersToken } = require("../services/marketData");
const { istDayFromAny, istIsoFromAny } = require("../utils/tradeUtils");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");
const { dailyFilesPaginate, renderHistoryPage } = require("../utils/paperHistoryUI");
const { isTradingAllowed } = require("../services/marketData");
const tradeLogger = require("../utils/tradeLogger");
const chartBackfill = require("../utils/chartBackfill");
const aiExport    = require("../utils/aiExport");
const { getCharges } = require("../utils/charges");
const skipLogger = require("../utils/skipLogger");
const capitalPool = require("../utils/capitalPool");
const optionChart  = require("../utils/optionChart");
const pairs        = require("../config/pairs");
const pairRuntime  = require("../utils/pairRuntime");
const tradeJournal = require("../utils/tradeJournal");
const fyers = require('../config/fyers');
const { notifyEntry, notifyExit, notifyStarted, sendTelegram, canSend } = require('../utils/notify');
const NIFTY_INDEX_SYMBOL = 'NSE:NIFTY50-INDEX';
// NOTE: no `technicalindicators` import here on purpose. Every indicator value
// this route displays comes from the engine, so the chart and the setup card
// show the exact numbers the decision read.

// ── Persistence root ─────────────────────────────────────────────────────────
// Data stored at ~/trading-data/ — OUTSIDE the project directory.
// This path survives git pull, npm install, and full redeploys.
const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");

// ═══════════════════════════════════════════════════════════════════════════════
// BUILDER — one paper engine per (strategy, market) pair.
// create(pair) returns an Express router holding ALL of that pair's state; the
// module's default export is the NIFTY instance. See the MARKETS note above.
// ═══════════════════════════════════════════════════════════════════════════════
function create(pair) {
const rt     = pairRuntime.forPair(pair);
const router = express.Router();
const ACTIVE = rt.home ? "GAP_RUNAWAY" : rt.tag;   // "BN_GAP_RUNAWAY" on BANKNIFTY
const MODE   = rt.modeKey;                 // logger / skip / capital key — gap_runaway on NIFTY
const ROUTE  = rt.paperPath;               // "/gap_runaway-paper" on NIFTY
const OWNER  = rt.ownerId;                 // socket callback + option-feed owner + recorder tag
const TAG    = `[${rt.tag}-PAPER]`;        // "[GAP_RUNAWAY-PAPER]" on NIFTY
const NOTIFY_MODE = rt.notifyMode;         // "GAP_RUNAWAY-PAPER" on NIFTY
const TITLE  = rt.home ? engine.LABEL : `${rt.market().label} · ${engine.LABEL}`;
const SPOT_LABEL = rt.spotLabel;           // "NIFTY" on NIFTY
// The index the setup, the open and the candles come from: NIFTY 50 as always,
// else the market's own (the NIFTY_FUT pair reads the NIFTY 50 index too).
const SPOT = () => (rt.home ? NIFTY_INDEX_SYMBOL : rt.spotSymbol());
// The NIFTY_FUT pair trades the month future; every other instance an option.
const IS_FUT = rt.isFutures === true;   // never on NIFTY (an options market)
// trade.instrument: NIFTY options as always (the global INSTRUMENT does not apply).
const TRADED_AS = () => (rt.home ? "NIFTY_OPTIONS" : rt.instrumentName());
// Paper capital pool of this pair's broker (NIFTY: Zerodha; other markets: Fyers).
const CAP_ENV = rt.home ? "ZERODHA_INV_AMOUNT" : (pair.broker === "fyers" ? "FYERS_INV_AMOUNT" : "ZERODHA_INV_AMOUNT");
const BROKER  = rt.home ? "zerodha" : pair.broker;
const BROKER_LABEL = BROKER === "zerodha" ? "Zerodha" : "Fyers";
// Banner wording of what this instance trades.
const TRADES_DESC = rt.home ? "NIFTY ATM options" : (IS_FUT ? `${SPOT_LABEL} month future (LONG on CE / SHORT on PE)` : `${SPOT_LABEL} ATM options`);
rt.registerCapital();

// ── Module-level config ─────────────────────────────────────────────────────
// Thresholds and windows are read LIVE through engine.getConfig() at every
// decision — never cached.
const PREFIX = rt.envPrefix;   // engine env prefix — GAP_RUNAWAY on NIFTY, BN_GAP_RUNAWAY …
// Chart candle timeframe in minutes. Display only — no rule reads a candle.
const TRADE_RES = 5;
let _STOP_MINS;           // TRADE_STOP_TIME — session auto-stop (default 15:30)
let _START_MINS;          // TRADE_START_TIME — pre-market banner only (default 09:15)
// isMarketHours() memo — invalidated by _refreshConfig(), so declared before it.
let _mktHoursCache    = null;
let _mktHoursCacheMin = -1;   // IST minute the cached verdict was computed for
function _refreshConfig() {
  _STOP_MINS        = parseMins("TRADE_STOP_TIME", "15:30");
  _START_MINS       = parseMins("TRADE_START_TIME", "09:15");
  _mktHoursCacheMin = -1;               // invalidate the cached market-hours verdict
}
_refreshConfig();

/** Live engine config for a decision. Read fresh every call (Settings saves mutate process.env). */
function _cfg() {
  return engine.getConfig(PREFIX);
}

/** Lots per trade — this strategy's own key, never the common LOT_MULTIPLIER.
 *  Another market: <PAIR>_LOTS, else GAP_RUNAWAY_LOTS (pairs.envGet). */
function _lots() {
  const v = rt.home
    ? parseInt(process.env.GAP_RUNAWAY_LOTS || "1", 10)
    : parseInt(pairs.envGet(`${PREFIX}_LOTS`) || "1", 10);
  return Number.isFinite(v) && v >= 1 && v <= 10 ? v : 1;
}
/** One lot of this market's contract (NIFTY futures: the NIFTY lot). */
function _lotSize() { return rt.home ? instrumentConfig.underlyingOf("NIFTY").lotSize : rt.U().lotSize; }
function _qty() { return _lots() * _lotSize(); }

// Rolling candle buffer (chart only) — the app runs on a t3.micro. 400 bars is
// > 5 sessions of 5-min bars.
const MAX_BARS = 400;
const SETUP_RETRY_MS = 60 * 1000;   // daily setup missing → re-fetch at most once a minute
const OPEN_RETRY_MS  = 5000;        // today's open not known → re-ask history every 5s
const OPEN_TICK_FALLBACK_MS = 20 * 1000; // history silent this long after 09:15 → first tick is the open
const OPEN_TICK_MAX_DELAY_S = 5;          // …but only a tick from the first 5 s of 09:15 counts as the open
const OPEN_FETCH_TIMEOUT_MS = 10 * 1000;  // the 1-min history call is abandoned after this
const ENTRY_RETRY_MS = 5000;        // a failed FILL (symbol / option LTP) retries at most every 5s
const WARMUP_DAYS    = 2;           // sessions of chart candles preloaded at /start

// ── Persistence ──────────────────────────────────────────────────────────────
const PT_FILE  = path.join(DATA_DIR, rt.tradesFile);

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
      capital: getCapitalFromEnv(),
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
    console.error(`${TAG} ${rt.tradesFile} corrupt — resetting:`, e.message);
    _paperDataCache = { capital: getCapitalFromEnv(), totalPnl: 0, sessions: [] };
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
  // The chart candle series (TRADE_RES-min): CLOSED candles + the forming bar.
  candles:       [],
  currentBar:    null,
  barStartTime:  null,
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
  // Yesterday's daily state — engine.dailySetup(daily, today).
  setup:             null,
  _setupError:       null,
  _setupLastTryMs:   0,
  // Today's official open (engine input) and where it came from.
  todayOpen:         null,
  todayOpenSrc:      null,
  _openLastTryMs:    0,
  _firstTickOpen:    null,    // first live tick at/after 09:15 — fallback only
  _firstTickAtMs:    null,
  // The day's decision (engine.getSignal) for the setup card.
  lastSignal:    null,
  // One decision per day: set once the day is resolved (position opened, NONE,
  // gap already filled, window closed). Never set by a failed FILL.
  _dayDone:       false,
  _dayDoneReason: null,
  _lastEntryAttemptMs: 0,
  _entryAttempts: 0,
  // Display only — there is NO consecutive-loss breaker in this strategy.
  _consecutiveLosses: 0,
  _priorTradesToday:   0,   // today's trade count from EARLIER sessions (restart recovery)
  _entryPending:      false, // prevents double-entry while an async fill is in flight
  // Win/loss counters: maintained in simulateSell so /status/data doesn't filter on every poll
  _sessionWins:   0,
  _sessionLosses: 0,
  // True when sessionTrades were restored from a PREVIOUS day's saved session by the
  // restart fallback below — they are not today's trades. Exposed as `staleSession` so
  // the shared monitors don't count a week-old session as today's P&L. Cleared by
  // /start, which rebuilds the session from scratch.
  _staleSession:  false,
};

// ── Crash/restart recovery: rehydrate the in-memory session from today's JSONL ──
// A push/PM2 restart wipes ptState.sessionTrades — it's only flushed to the persisted
// sessions[] on Stop. The per-trade JSONL (appendTradeLog) survives, so on boot we
// re-load today's trades that aren't already in a saved (stopped) session.
function rehydrateSessionFromJsonl() {
  try {
    const data = loadPaperData();
    const keyOf = (t) => String(t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`);
    const today = tradeLogger.istDateString(Date.now());
    const all = tradeLogger.readDailyTrades(MODE, today)
      .filter(t => t && !t.type && (t.side || t.entryTime || t.entryBarTime || t.symbol));
    const seen = new Set();
    for (const s of (data.sessions || [])) {
      for (const t of (s.trades || [])) seen.add(keyOf(t));
    }
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

    ptState._staleSession = stale;
    ptState.sessionTrades = trades;
    ptState.sessionPnl = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    ptState._sessionWins   = trades.filter(t => Number(t.pnl) > 0).length;
    ptState._sessionLosses = trades.filter(t => Number(t.pnl) < 0).length;
    if (!ptState.sessionStart) ptState.sessionStart = istIsoFromAny(trades[0].entryTime || trades[0].loggedAt);
    console.log(`♻️ ${TAG} Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${ptState.sessionPnl})`);
  } catch (err) {
    console.warn(`${TAG} session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();
// A previous day's session may only stay on screen while the market is shut.
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => ptState, TAG);

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

/** Floor a unix-ms time to its `resMin`-minute bucket. IST is UTC+5:30 and 3, 5
 *  and 15 all divide 330 minutes' worth of offsets onto the IST 09:15 grid. */
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
function _todayKey() { return engine._istDayOf(Math.floor(Date.now() / 1000)); }
function _todayStr() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); }

// ── Time helpers (all times configurable via .env) ───────────────────────────
// TRADE_START_TIME : pre-market banner only (default "09:15")
// TRADE_STOP_TIME  : session auto-stop (default "15:30")
// Entries are governed by the ENGINE's own window (GAP_RUNAWAY_ENTRY_START /
// _ENTRY_END).
function parseMins(envKey, defaultVal) {
  const raw = process.env[envKey] || defaultVal;
  const [h, m] = raw.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
}

// ── Fast IST minutes helper ───────────────────────────────────────────────────
function getISTMinutes() {
  const utcSec = Math.floor(Date.now() / 1000);
  const istSec = utcSec + 19800; // UTC+5:30
  const istMin = Math.floor(istSec / 60);
  return (istMin % 1440); // minutes since midnight IST (0–1439)
}

// NSE / BSE regular session open (09:15 IST) — the floor for building candles.
const _MKT_OPEN_MINS = rt.home ? 9 * 60 + 15 : rt.sessionOpenMin();

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
// this route must fan out through addCallback.
const SOCKET_CALLBACK_ID = OWNER;

// A session started after its stop time gets a hard stop this long after start.
const LATE_START_GRACE_MIN = 30;
function _lateStartStopMins() {
  try { if (require("../services/tickReplay").isReplayInProgress()) return 0; } catch (_) {}
  const t = (getISTMinutes() + LATE_START_GRACE_MIN) % 1440;
  const hhmm = String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
  log(`⏰ [PAPER] Session started after its stop time — will stop at ${hhmm} IST`);
  return LATE_START_GRACE_MIN;
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
  // Zerodha orders, so it draws from the shared Zerodha pool (another market: Fyers).
  const v = parseFloat(process.env[CAP_ENV] || "100000");
  return Number.isFinite(v) && v > 0 ? v : 100000;
}

// ── Option LTP via socket-first feed, REST fallback ─────────────────────────

let _optionPollTimer = null;
let _optionPollBusy  = false; // guard: prevents overlapping getQuotes calls if network is slow
let _entryLtpProxyTimer = null; // 10s entry-premium fallback timer — owned by one position
let _rateLimitSkipCycles = 0; // skip N poll cycles after a rate-limit hit
const OPTION_FEED_OWNER = OWNER;
let _onStreamedOptionLtp = null;
let _optionPollGen = 0;

async function fetchOptionLtp(symbol) {
  try {
    const response = await require("../services/marketData").getQuotes([symbol]);
    if (response.s === 'ok' && response.d && response.d.length > 0) {
      const v = response.d[0].v || response.d[0];
      const ltp = v.lp || v.ltp || v.last_price || v.last_traded_price
               || v.ask_price || v.bid_price || v.close_price || v.prev_close_price;
      if (ltp && ltp > 0) {
        if (fetchOptionLtp._rlActive) {
          log(`✅ [PAPER] Rate limit cleared — polling resumed`);
          fetchOptionLtp._rlActive = false;
          _rateLimitSkipCycles = 0;
        }
        const _ltp = parseFloat(ltp);
        try { tickRecorder.recordOptionLtp(symbol, _ltp, OWNER); } catch (_) {}
        // Other markets fill at the quote (pairRuntime.fillAtQuote): keep the
        // latest bid/ask of the held contract. NIFTY never reads it.
        if (!rt.home) {
          const _b = Number(v.bid || v.bid_price || 0), _a = Number(v.ask || v.ask_price || 0);
          if (_b > 0 && _a > 0 && ptState.optionSymbol === symbol) ptState.optionQuote = { symbol, bid: _b, ask: _a, ltp: _ltp, at: Date.now() };
        }
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
function _publishOptionLtp(symbol, ltp, at) {
  // Publish only while we still own `symbol` (a late reply for a closed contract
  // must never become the next trade's entry premium).
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
    _jEntryPremium(ptState.position, ltp);
    log(`📌 [PAPER] Option entry LTP: ₹${ltp} (SPOT @ ₹${ptState.position.spotAtEntry})`);
  }
}

async function _optionPollTick(symbol, gen) {
  if (gen !== _optionPollGen) return;
  if (_optionPollBusy) return;
  if (_rateLimitSkipCycles > 0) { _rateLimitSkipCycles--; return; }
  _optionPollBusy = true;
  try {
    if (!ptState.position || !ptState.optionSymbol) { stopOptionPolling(); return; }
    optionFeed.track(OPTION_FEED_OWNER, symbol, _onStreamedOptionLtp);
    const streamed = optionFeed.getFresh(symbol);
    let ltp, ltpAt;
    if (rt.home) {
      ltp   = streamed ? streamed.ltp : await fetchOptionLtp(symbol);
      ltpAt = streamed ? streamed.at  : Date.now();
    } else {
      // A fill-at-quote pair also needs a fresh bid/ask for its exit, which the
      // stream does not carry — so it keeps one REST quote at most ~5 s old.
      const _q = ptState.optionQuote;
      const _needQuote = rt.fillAtQuote() && !(_q && _q.symbol === symbol && Date.now() - _q.at <= 5000);
      if (streamed && !_needQuote) { ltp = streamed.ltp; ltpAt = streamed.at; }
      else {
        ltp = await fetchOptionLtp(symbol);
        ltpAt = Date.now();
        if (!ltp && streamed) { ltp = streamed.ltp; ltpAt = streamed.at; }
      }
    }
    if (gen !== _optionPollGen) return;
    if (!ltp) {
      const _staleMs = parseInt(process.env.LTP_STALE_THRESHOLD_SEC || "15", 10) * 1000;
      if (ptState.optionLtpUpdatedAt && (Date.now() - ptState.optionLtpUpdatedAt) > _staleMs
          && !ptState._ltpStaleLogged) {
        log(`⚠️ [PAPER] Option LTP STALE — no update for ${Math.round((Date.now() - ptState.optionLtpUpdatedAt) / 1000)}s. P&L is using a stale premium.`);
        ptState._ltpStaleLogged = true;
      }
      return;
    }
    _publishOptionLtp(symbol, ltp, ltpAt);
    // No option-premium stop exists in this strategy — the stop is the SPOT gap
    // level (per tick, onTick) and the trail is the spot EMA (candle close).
  } finally {
    if (gen === _optionPollGen) _optionPollBusy = false;
  }
}

function startOptionPolling(symbol) {
  stopOptionPolling();
  _optionPollBusy = false;
  const gen = _optionPollGen;
  _onStreamedOptionLtp = (ltp, at) => { if (gen === _optionPollGen) _publishOptionLtp(symbol, ltp, at); };
  optionFeed.track(OPTION_FEED_OWNER, symbol, _onStreamedOptionLtp);

  function scheduleNext() {
    if (!_optionPollTimer || gen !== _optionPollGen) return;
    _optionPollTimer = setTimeout(async () => {
      try { await _optionPollTick(symbol, gen); }
      catch (err) { log(`⚠️ [PAPER] Option poll error: ${err.message} — polling continues`); }
      scheduleNext();
    }, 1000);
  }
  _optionPollTick(symbol, gen)
    .catch(err => log(`⚠️ [PAPER] Initial option poll error: ${err.message}`))
    .then(scheduleNext);
  _optionPollTimer = true; // placeholder until first setTimeout fires

  // 10s: flag that no option premium arrived. DIAGNOSTIC ONLY — spot is never
  // written into optionEntryLtp.
  _entryLtpProxyTimer = setTimeout(() => {
    _entryLtpProxyTimer = null;
    if (ptState.position && ptState.optionSymbol === symbol
        && !ptState.position.optionEntryLtp) {
      ptState.position.optionEntryLtpMissing = true;
      log(`⚠️ [PAPER] No option premium after 10s for ${symbol} — entry premium left UNSET (P&L falls back to spot proxy until a real premium arrives).`);
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
  try { optionFeed.release(OPTION_FEED_OWNER); } catch (_) {}
  if (_entryLtpProxyTimer) { clearTimeout(_entryLtpProxyTimer); _entryLtpProxyTimer = null; }
}

// ── Simulated order (NO real API call) ──────────────────────────────────────

function parseOptionDetails(symbol) {
  // Another market: its own exchange / stem / weekly-or-monthly forms.
  if (!rt.home) return rt.parseOptionSymbol(symbol);
  // Fyers weekly option symbol formats:
  //   A: NSE:NIFTY{YY}{M}{DD}{Strike}{CE|PE}  (M = 1-9, O, N, D)
  //   C: NSE:NIFTY{YY}{MON}{Strike}{CE|PE}    (monthly)
  //   B: NSE:NIFTY{YY}{MON}{DD}{Strike}{CE|PE}
  const MONTH_NAMES = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const MONTH_CODE_MAP = { "1":0,"2":1,"3":2,"4":3,"5":4,"6":5,"7":6,"8":7,"9":8,"O":9,"N":10,"D":11 };
  try {
    const mA = symbol.match(/NSE:NIFTY(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$/);
    if (mA) {
      const monthIdx = MONTH_CODE_MAP[mA[2]];
      return {
        expiry:     `${mA[3]} ${MONTH_NAMES[monthIdx]} 20${mA[1]}`,
        expiryRaw:  `${mA[1]}${mA[2]}${mA[3]}`,
        strike:     parseInt(mA[4], 10),
        optionType: mA[5],
      };
    }
    const mC = symbol.match(/NSE:NIFTY(\d{2})([A-Z]{3})(\d+)(CE|PE)$/);
    if (mC) {
      const strike = parseInt(mC[3], 10);
      if (strike >= 10000) {
        return { expiry: `${mC[2]} 20${mC[1]}`, expiryRaw: `${mC[1]}${mC[2]}`, strike, optionType: mC[4] };
      }
    }
    const mB = symbol.match(/NSE:NIFTY(\d{2}[A-Z]{3}\d{2})(\d+)(CE|PE)$/);
    if (mB) {
      const expiryRaw = mB[1];
      return {
        expiry:     `${expiryRaw.slice(5, 7)} ${expiryRaw.slice(2, 5)} 20${expiryRaw.slice(0, 2)}`,
        expiryRaw,
        strike:     parseInt(mB[2], 10),
        optionType: mB[3],
      };
    }
  } catch (_) {}
  return null;
}

// ── Daily setup — yesterday's RSI zone + close ───────────────────────────────
// Fetched at /start and whenever the IST day no longer matches setup.forDayKey.
// engine.dailySetup() reads the newest daily bar strictly BEFORE the session day,
// so today's forming daily bar can never move the decision.
let _setupInFlight = false;
async function _fetchDaily() {
  const { fetchCandles } = require("../services/marketData");
  const nowIst = new Date(Date.now() + 19800000);
  const from = new Date(nowIst.getTime() - engine.DAILY_LOOKBACK_DAYS * 86400000);
  const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return await fetchCandles(SPOT(), "D", fmt(from), fmt(nowIst));
}

async function _refreshSetup(forDayKey) {
  if (_setupInFlight) return;
  _setupInFlight = true;
  ptState._setupLastTryMs = Date.now();
  try {
    const daily = await _fetchDaily();
    const st = engine.dailySetup(Array.isArray(daily) ? daily : [], forDayKey, _cfg());
    if (st.ready) {
      ptState.setup = st;
      ptState._setupError = null;
      log(`📐 [PAPER] Daily setup (prev day ${st.prevDate}): close ${st.prevClose} | EMA${st.emaLength} ${st.prevEma} | RSI${st.rsiLength}(EMA) ${st.prevRsi} → ${st.zone} | ${st.reason}`);
    } else {
      ptState.setup = null;
      ptState._setupError = st.reason || "Daily setup not ready";
      log(`⚠️ [PAPER] Daily setup NOT ready — ${ptState._setupError}. No entry until it loads (retry every ${SETUP_RETRY_MS / 1000}s).`);
    }
  } catch (err) {
    ptState._setupError = `Daily candles unavailable (${err.message})`;
    log(`⚠️ [PAPER] Daily fetch failed: ${err.message} — no entry until the setup loads (retry every ${SETUP_RETRY_MS / 1000}s).`);
  } finally {
    _setupInFlight = false;
  }
}

/** Background, throttled: make sure ptState.setup belongs to `forDayKey`. */
function _ensureSetup(forDayKey) {
  if (ptState.setup && ptState.setup.forDayKey === forDayKey) return;
  if (ptState.setup && ptState.setup.forDayKey !== forDayKey) {
    ptState.setup = null;   // never show (or pass) another day's setup
    ptState._setupError = "Setup belongs to another day — refreshing";
  }
  if (Date.now() - (ptState._setupLastTryMs || 0) < SETUP_RETRY_MS) return;
  _refreshSetup(forDayKey).catch(() => {});
}

// ── Today's official open ────────────────────────────────────────────────────
// The open of TODAY's 09:15 1-min bar from Fyers history — time-verified, so a
// pre-market call can never hand back yesterday's open. Only asked for at/after
// 09:15. Fallback (logged): the first live tick at/after 09:15.
let _openInFlight = false;
async function _refreshTodayOpen() {
  if (_openInFlight || ptState.todayOpen != null) return;
  _openInFlight = true;
  ptState._openLastTryMs = Date.now();
  try {
    const { fetchCandles } = require("../services/marketData");
    const today = _todayStr();
    // Bounded: a history call that never resolves must not also disable the tick fallback below.
    const bars = await Promise.race([
      fetchCandles(SPOT(), "1", today, today),
      new Promise((_, rej) => setTimeout(() => rej(new Error("history timed out")), OPEN_FETCH_TIMEOUT_MS)),
    ]);
    const tk = _todayKey();
    const first = (Array.isArray(bars) ? bars : [])
      .filter(c => c && engine._num(c.time) && engine._istDayOf(c.time) === tk && engine._istMins(c.time) === _MKT_OPEN_MINS)[0];
    if (first && engine._num(first.open) && first.open > 0 && ptState.todayOpen == null) {
      ptState.todayOpen = first.open;
      ptState.todayOpenSrc = "09:15 1-min bar (Fyers history)";
      log(`🔔 [PAPER] Today's open: ₹${first.open} (${ptState.todayOpenSrc})`);
    }
  } catch (err) {
    if (!ptState._openErrLogged) {
      ptState._openErrLogged = true;
      log(`⚠️ [PAPER] Today's open not available from history yet (${err.message}) — retrying every ${OPEN_RETRY_MS / 1000}s`);
    }
  } finally {
    _openInFlight = false;
  }
  // History stayed silent → use the first live tick (logged) — but only a tick
  // from the first seconds of 09:15: a session started later never saw the open,
  // and its first tick is just a price, not today's open.
  const _openSec = (_todayKey() * 86400 - 19800) + _MKT_OPEN_MINS * 60;
  if (ptState.todayOpen == null && ptState._firstTickOpen != null
      && Math.floor(ptState._firstTickAtMs / 1000) - _openSec <= OPEN_TICK_MAX_DELAY_S
      && Date.now() - ptState._firstTickAtMs >= OPEN_TICK_FALLBACK_MS) {
    ptState.todayOpen = ptState._firstTickOpen;
    ptState.todayOpenSrc = "first live tick at/after 09:15 (history unavailable)";
    log(`⚠️ [PAPER] Today's open from the first live tick: ₹${ptState.todayOpen} — Fyers history did not return today's 09:15 bar within ${OPEN_TICK_FALLBACK_MS / 1000}s`);
  }
}

function _ensureTodayOpen() {
  if (ptState.todayOpen != null) return;
  if (getISTMinutes() < _MKT_OPEN_MINS) return;
  if (Date.now() - (ptState._openLastTryMs || 0) < OPEN_RETRY_MS) return;
  _refreshTodayOpen().catch(() => {});
}

// ── Simulated order (NO real API call) ──────────────────────────────────────

/**
 * Open a virtual position. `meta.entryLtp` — the option premium at the fill.
 * The only automatic exit is the common profit lock on that premium.
 */
function simulateBuy(symbol, side, qty, price, reason, spotAtEntry, meta = {}) {
  if (ptState.position) {
    log(`⚠️ [PAPER] simulateBuy called while position already open — ignoring duplicate entry (${side} @ ₹${price})`);
    return;
  }
  // Other markets: with <PAIR>_PAPER_FILL_AT_QUOTE on (the default there) an
  // option is BOUGHT AT THE ASK of the fresh quote the entry fetched, instead
  // of at its LTP. NIFTY's fill is exactly the LTP it always was.
  let _askFill = null;
  let _metaLtp = meta.entryLtp;
  if (!rt.home && !IS_FUT && meta.entryQuote && Number.isFinite(_metaLtp) && _metaLtp > 0) {
    const f = rt.entryFill(_metaLtp, meta.entryQuote, Date.now());
    if (f.source === "ask" && f.price > 0) { _askFill = f.price; _metaLtp = f.price; }
  }
  // Capital gate — HARD: the Zerodha pool must fund qty × premium or the entry
  // is refused. The day stays open, so the next throttled attempt re-checks.
  // The NIFTY_FUT pair: the future's margin (qty × index × marginPct).
  const _capPremium = !IS_FUT && Number.isFinite(_metaLtp) && _metaLtp > 0 ? _metaLtp : 0;
  const _capCost = IS_FUT
    ? parseFloat(((qty || 0) * (price || 0) * (instrumentConfig.underlyingOf(rt.underlyingKey).marginPct / 100)).toFixed(2))
    : qty * _capPremium;
  const _cap = capitalPool.gate(MODE, _capCost, { side, symbol, qty });
  if (!_cap.ok) {
    if (!_cap.muted) {
      log(`❌ [PAPER] Entry REFUSED — ${_cap.reason}`);
      skipLogger.appendSkipLog(MODE, { gate: "capital", reason: _cap.reason, side, symbol, qty, premium: _capPremium, cost: _cap.cost, available: _cap.available });
    }
    return;
  }
  const optDetails = IS_FUT ? null : parseOptionDetails(symbol);
  const _entrySpot = spotAtEntry || price;
  const _entryLtp  = _capPremium > 0 ? _capPremium : null;
  const _entryIstMin = Math.floor((Math.floor(Date.now() / 1000) + 19800) / 60) % 1440;
  const sig = meta.signal || {};

  ptState.position = {
    side,
    symbol,
    qty,
    entryPrice:        price,          // NIFTY spot at the fill
    spotAtEntry:       _entrySpot,
    entryTime:         istNow(),
    entryUnixSec:      Math.floor(Date.now() / 1000),
    reason,
    entryBarTime:      meta.entryBarTime != null ? meta.entryBarTime : (ptState.currentBar ? ptState.currentBar.time : null),
    signalBarTime:     null,
    bestPrice:         null,
    bestOptionLtp:     _entryLtp,
    candlesHeld:       0,
    mfeSpotPts:        0,
    maeSpotPts:        0,
    entryTimeMs:       Date.now(),
    secsToMFE:         0,
    secsToMAE:         0,
    isFutures:         IS_FUT,
    optionExpiry:      optDetails?.expiry     || null,
    optionStrike:      optDetails?.strike     || null,
    optionType:        optDetails?.optionType || side,
    optionEntryLtp:    _entryLtp,
    optionEntryLtpTime: _entryLtp != null ? istNow() : null,
    optionCurrentLtp:  _entryLtp,
    entryHourIST:      Math.floor(_entryIstMin / 60),
    entryMinuteIST:    _entryIstMin % 60,
    isManual:          !!meta.manual,
    // Day snapshot — straight from engine.dailySetup() / getSignal().
    prevDate:          sig.prevDate  != null ? sig.prevDate  : null,
    prevClose:         sig.prevClose != null ? sig.prevClose : null,
    prevRsi:           sig.prevRsi   != null ? sig.prevRsi   : null,
    prevEma:           sig.prevEma   != null ? sig.prevEma   : null,
    rsiZone:           sig.zone || null,
    todayOpen:         sig.todayOpen != null ? sig.todayOpen : null,
    todayOpenSrc:      ptState.todayOpenSrc || null,
    gapPts:            sig.gapPts != null ? sig.gapPts : null,
    gapPct:            sig.gapPct != null ? sig.gapPct : null,
    tradeRes:          TRADE_RES,
  };
  // Other markets: the position names its market and instrument and how the
  // option was filled. NIFTY's position is exactly as above.
  if (!rt.home) {
    ptState.optionQuote = null;
    Object.assign(ptState.position, { market: rt.marketKey, instrument: rt.instrumentName(), spotSymbol: SPOT() });
    if (!IS_FUT) {
      ptState.position.optionEntryFill = _askFill ? "ask" : "ltp";
      if (meta.entryQuote) ptState.position.entryQuote = { bid: meta.entryQuote.bid, ask: meta.entryQuote.ask, ltp: meta.entryQuote.ltp };
    }
  }
  capitalPool.block(MODE, _capCost, { side, symbol, qty, premium: _capPremium });

  // Trade journal (observer only). The fill is the option premium (NIFTY: its
  // LTP; a fill-at-quote pair: the ask against the quote's LTP) or, for the
  // future, the index level it was priced at.
  _jLastStop = null;
  {
    const _jp  = ptState.position;
    const _eqJ = meta.entryQuote || null;
    tradeJournal.onEntry(_jp, {
      reason, signal: side === "CE" ? "BUY_CE" : "BUY_PE",
      indicators: {
        prevClose: _jp.prevClose, prevRsi: _jp.prevRsi, prevEma: _jp.prevEma, zone: _jp.rsiZone,
        todayOpen: _jp.todayOpen, gapPts: _jp.gapPts, gapPct: _jp.gapPct,
      },
      spot: _entrySpot, optionLtp: IS_FUT ? null : _entryLtp,
      bid: _eqJ ? _eqJ.bid : null, ask: _eqJ ? _eqJ.ask : null,
      expiry: _jp.optionExpiry,
      market: rt.marketKey, mode: MODE, isFutures: IS_FUT, qty,
      expectedPrice: IS_FUT ? price : (_eqJ && _eqJ.ltp > 0 ? _eqJ.ltp : _entryLtp),
      candles: ptState.candles, nowMs: Date.now(),
    });
    _journalStopLevel(_jp, _entrySpot, IS_FUT ? null : _entryLtp);
  }

  // Crash-recovery snapshot: written on entry, cleared on exit. app.js reconciles
  // it against the broker book on boot.
  try { rt.persist.save(ptState.position, { sessionPnl: ptState.sessionPnl }); } catch (_) {}

  ptState.optionSymbol = symbol;
  ptState.optionLtp          = _entryLtp;
  ptState.optionLtpUpdatedAt = _entryLtp != null ? Date.now() : null;
  if (!IS_FUT) {
    log(`📊 [PAPER] Starting option LTP polling: ${symbol}`);
    startOptionPolling(symbol);
  } else {
    log(`📊 [PAPER] Futures — no option premium to poll; P&L and the stop run on the ${SPOT_LABEL} index level`);
  }

  if (IS_FUT) log(`📝 [PAPER] ${side === "CE" ? "LONG" : "SHORT"} ${qty} × ${symbol} @ ₹${price} | exit: common stop in index points | Reason: ${reason}`);
  else log(`📝 [PAPER] BUY ${qty} × ${symbol} @ SPOT ₹${price} | exit: profit lock on premium | Opt: ${_entryLtp != null ? "₹" + _entryLtp : "capturing…"} | Reason: ${reason}`);
  if (_askFill) log(`📌 [PAPER] Entry filled at the ASK ₹${_askFill} (LTP ₹${meta.entryLtp}, bid ₹${meta.entryQuote.bid}) — ${rt.fillAtQuoteKey}`);
  notifyEntry({
    mode:           NOTIFY_MODE,
    side,
    symbol,
    strike:         ptState.position.optionStrike,
    expiry:         ptState.position.optionExpiry,
    spotAtEntry:    price,
    optionEntryLtp: _entryLtp,
    qty,
    reason,
    ...(rt.home ? {} : { isFutures: IS_FUT, instrument: rt.instrumentName() }),
  });
}

/**
 * Close the virtual position. `exitBarTime` — the bar the exit FILLED in (for the
 * chart marker); defaults to the forming bar.
 */
function simulateSell(exitPrice, reason, spotAtExit, exitBarTime) {
  if (!ptState.position) return;

  const { side, symbol, qty, entryPrice, entryTime, spotAtEntry,
          optionEntryLtp, optionCurrentLtp, entryHourIST, entryMinuteIST } = ptState.position;
  const pos = ptState.position;

  // The position's OWN instrument, frozen at entry (the NIFTY_FUT pair's future).
  const isFutures = pos.isFutures === true;
  let rawPnl;
  let pnlMode;
  let exitOptionLtp = isFutures ? null : (ptState.optionLtp || optionCurrentLtp);
  const _ltpAtExit = exitOptionLtp;
  // Other markets: SOLD AT THE BID of a fresh quote of the held contract when
  // <PAIR>_PAPER_FILL_AT_QUOTE is on (pairRuntime.exitFill); NIFTY unchanged.
  let _exitFill = null, _exitQ = null;
  if (!rt.home && !isFutures) {
    _exitQ = ptState.optionQuote && ptState.optionQuote.symbol === symbol ? ptState.optionQuote : null;
    const f = rt.exitFill(exitOptionLtp, _exitQ, Date.now());
    _exitFill = f.source;
    if (f.source === "bid") exitOptionLtp = f.price;
  }
  if (isFutures) {
    // Futures: price difference × qty on the index level. CE = LONG, PE = SHORT.
    rawPnl  = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
    pnlMode = `futures: entry ₹${entryPrice} → exit ₹${exitPrice} (${side === "CE" ? "LONG" : "SHORT"})`;
  } else if (optionEntryLtp && exitOptionLtp && optionEntryLtp > 0 && exitOptionLtp > 0) {
    rawPnl  = (exitOptionLtp - optionEntryLtp) * qty;
    pnlMode = `option premium: entry ₹${optionEntryLtp} → exit ₹${exitOptionLtp}`;
  } else {
    rawPnl  = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
    pnlMode = `spot proxy (option LTP unavailable)`;
  }

  // Another market: its exchange's charges (BSE for SENSEX) on its broker's
  // schedule; a future is charged on the index level it traded at.
  const charges = rt.home
    ? getCharges({ isFutures: false, exitPremium: exitOptionLtp, entryPremium: optionEntryLtp, qty })
    : (isFutures
      ? getCharges({ isFutures, broker: BROKER, exchange: rt.market().exchange, exitPremium: exitPrice, entryPremium: entryPrice, qty })
      : getCharges({ isFutures: false, broker: BROKER, exchange: rt.market().exchange, exitPremium: exitOptionLtp, entryPremium: optionEntryLtp, qty }));
  const netPnl  = parseFloat((rawPnl - charges).toFixed(2));

  // Trade journal exit (observer only) — before the trade object is built. A
  // profit lock / stop exit aimed at the level _journalStopLevel last recorded;
  // any other exit at the quote's LTP (bid fill) or the price it filled at.
  {
    const _jKind = _journalExitKind(reason);
    const _jSpot = spotAtExit || exitPrice;
    const _xq    = _exitFill === "bid" ? _exitQ : null;
    const _jFill = isFutures ? exitPrice : (exitOptionLtp || null);
    tradeJournal.onExit(pos, {
      reason, kind: _jKind,
      spot: _jSpot, optionLtp: isFutures ? null : (exitOptionLtp || null),
      bid: _xq ? _xq.bid : null, ask: _xq ? _xq.ask : null,
      expectedPrice: (_jKind === "sl" || _jKind === "trail") && _jLastStop != null ? _jLastStop : (_xq ? _xq.ltp : (isFutures ? exitPrice : (_ltpAtExit || null))),
      fillPrice: _jFill,
      favPts: (_jSpot - (spotAtEntry || entryPrice)) * (side === "CE" ? 1 : -1),
      pnlRs: rawPnl, candlesHeld: pos.candlesHeld || 0,
      candles: ptState.candles, nowMs: Date.now(),
    });
    _jLastStop = null;
  }

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
    optionEntryLtp:   optionEntryLtp  || null,
    optionExitLtp:    exitOptionLtp   || null,
    entryTime,
    exitTime:         istNow(),
    pnl:              netPnl,
    pnlMode,
    exitReason:       reason,
    entryReason:      pos.reason,
    optionExpiry:     pos.optionExpiry || null,
    optionStrike:     pos.optionStrike || null,
    optionType:       pos.optionType   || side,
    entryBarTime:     pos.entryBarTime || null,
    signalBarTime:    null,
    exitBarTime:      _exitBarTime,
    entryHourIST:     entryHourIST   != null ? entryHourIST   : null,
    entryMinuteIST:   entryMinuteIST != null ? entryMinuteIST : null,
    // The day's setup (engine values) — self-describing for offline analysis.
    prevDate:         pos.prevDate,
    prevClose:        pos.prevClose,
    prevRsi:          pos.prevRsi,
    prevEma:          pos.prevEma,
    rsiZone:          pos.rsiZone,
    todayOpen:        pos.todayOpen,
    todayOpenSrc:     pos.todayOpenSrc,
    gapPts:           pos.gapPts,
    gapPct:           pos.gapPct,
    tradeRes:         pos.tradeRes,
    bestPrice:        pos.bestPrice     || null,
    bestOptionLtp:    pos.bestOptionLtp || null,
    candlesHeld:      pos.candlesHeld   || 0,
    mfeSpotPts:       pos.mfeSpotPts    || 0,
    maeSpotPts:       pos.maeSpotPts    || 0,
    secsToMFE:        pos.secsToMFE     || 0,
    secsToMAE:        pos.secsToMAE     || 0,
    ...pathFields(pos),
    durationMs:       _durationMs,
    pnlPoints:        _pnlPoints,
    charges:          charges,
    isFutures:        isFutures,
    isManual:         !!pos.isManual,
    instrument:       rt.home ? "NIFTY_OPTIONS" : (pos.instrument || rt.instrumentName()),
    ...tradeJournal.fields(pos),
  };
  // Other markets: the record names its market, strategy, spot and broker
  // (consolidation, post-exit tracking and the MCP read them) and how each leg
  // was filled.
  if (!rt.home) {
    Object.assign(trade, {
      market:          rt.marketKey,
      strategyId:      rt.strategy.key,
      spotSymbol:      pos.spotSymbol || SPOT(),
      broker:          BROKER,
      optionEntryFill: isFutures ? null : (pos.optionEntryFill || "ltp"),
      optionExitFill:  isFutures ? null : _exitFill,
      entryQuote:      pos.entryQuote || null,
      exitQuote:       (_exitFill === "bid" && _exitQ) ? { bid: _exitQ.bid, ask: _exitQ.ask, ltp: _exitQ.ltp } : null,
    });
  }

  ptState.sessionTrades.push(trade);
  tradeLogger.appendTradeLog(MODE, trade); // crash-safe per-trade JSONL
  ptState.sessionPnl = parseFloat((ptState.sessionPnl + netPnl).toFixed(2));
  if (netPnl > 0) { ptState._sessionWins++;   }
  else             { ptState._sessionLosses++; }
  ptState._consecutiveLosses = netPnl < 0 ? (ptState._consecutiveLosses || 0) + 1 : 0;

  stopOptionPolling();
  ptState.optionSymbol = null;
  ptState.optionLtp    = null;
  log(`📊 [PAPER] ${isFutures ? "Futures" : "Option"} LTP polling stopped`);

  const emoji = netPnl >= 0 ? "✅" : "❌";
  log(`${emoji} [PAPER] SELL ${qty} × ${symbol} @ SPOT ₹${exitPrice} | ${isFutures ? "" : `Option LTP: ₹${exitOptionLtp || "?"} | `}PnL: ₹${netPnl} | ${pnlMode} | ${reason}`);
  if (_exitFill === "bid") log(`📌 [PAPER] Exit filled at the BID ₹${exitOptionLtp} (LTP ₹${_ltpAtExit}) — ${rt.fillAtQuoteKey}`);
  log(`💼 [PAPER] Session PnL so far: ₹${ptState.sessionPnl} — one trade per day, no re-entry today.`);

  notifyExit({
    mode:           NOTIFY_MODE,
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
    ...(rt.home ? {} : { isFutures, instrument: trade.instrument }),
  });

  ptState.position = null;
  if (!rt.home) ptState.optionQuote = null;
  capitalPool.release(MODE, netPnl);
  _markDayDone("traded — one trade per day");
  try { rt.persist.clear(); } catch (_) {}
}

// ── The day's single decision ────────────────────────────────────────────────

function _markDayDone(reason) {
  if (ptState._dayDone) return;
  ptState._dayDone = true;
  ptState._dayDoneReason = reason;
  _saveDayDecision();
}

// The day's decision is written to disk, so a stop → start (or a crash) inside
// the entry window can never re-decide a day the engine already settled —
// e.g. "gap already filled" at 09:17 must not become a trade at 09:24.
const DAY_FILE = path.join(DATA_DIR, `.${MODE}_day.json`);   // ".gap_runaway_day.json" on NIFTY
function _saveDayDecision() {
  try {
    let _inReplay = false;
    try { _inReplay = require("../services/tickReplay").isReplayInProgress(); } catch (_) {}
    if (_inReplay) return;
    ensureDir();
    const tmp = DAY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ date: _todayStr(), reason: ptState._dayDoneReason, savedAt: Date.now() }));
    fs.renameSync(tmp, DAY_FILE);
  } catch (e) { log(`⚠️ [PAPER] Could not save today's decision: ${e.message}`); }
}
function _loadDayDecision() {
  try {
    if (!fs.existsSync(DAY_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(DAY_FILE, "utf-8"));
    return d && d.date === _todayStr() && d.reason ? d.reason : null;
  } catch (_) { return null; }
}

/** Record the engine's decision for the setup card (display + skip log). */
function _recordSignal(sig) {
  ptState.lastSignal = {
    at:        Date.now(),
    signal:    sig.signal,
    side:      sig.side || null,
    reason:    sig.reason || null,
    skipReason: sig.skipReason || null,
    todayOpen: sig.todayOpen,
    gapPts:    sig.gapPts,
    gapPct:    sig.gapPct,
    gapDir:    sig.gapDir,
  };
}

/** Synchronous entry guards — evaluated before the first await. */
function _entryBlockReason(cfg, nowSec) {
  if (!ptState.running) return "session not running";
  if (ptState.position) return "position already open";
  if (ptState._entryPending) return "an entry is already in flight";
  if (ptState._dayDone) return ptState._dayDoneReason || "today already decided";
  const _taken = ptState.sessionTrades.length + (ptState._priorTradesToday || 0);
  if (_taken >= 1) return "one trade per day — already traded today";
  return null;
}

/** The option premium at the fill: the streamed tick if fresh, else a quote. */
async function _fillPremium(symbol, quote) {
  const streamed = optionFeed.getFresh(symbol);
  if (streamed && streamed.ltp > 0) return streamed.ltp;
  if (quote && quote.ltp > 0) return quote.ltp;   // another market's fresh entry quote
  return await fetchOptionLtp(symbol);
}

/** Exact ATM strike on the NIFTY grid — the common strike offsets do not apply.
 *  Another market: its own grid (100 on SENSEX / BANKNIFTY, 2.5 on SAIL …). */
function _atmStrike(spot) {
  if (!rt.home) return rt.atmOf(spot);
  const step = instrumentConfig.underlyingOf("NIFTY").strikeStep;
  return Math.round(spot / step) * step;
}

/** The ATM contract: NIFTY's lookup exactly as before; another market its own
 *  index, grid and expiry; the NIFTY_FUT pair the month future. */
async function _resolveEntry(spot, side) {
  if (rt.home) return validateAndGetOptionSymbol(spot, side, ACTIVE, { strikeOverride: _atmStrike(spot) });
  if (IS_FUT) return rt.resolveEntrySymbol(spot, side);
  return validateAndGetOptionSymbol(spot, side, ACTIVE, { strikeOverride: _atmStrike(spot), underlying: rt.underlyingKey });
}

/**
 * Resolve the ATM contract, read the fill premium and open the position.
 * Returns { opened, retry } — `retry` marks an INFRASTRUCTURE failure (no symbol
 * / no premium) the caller may re-attempt inside the window.
 */
async function _fillEntry(sig, fillSpot, sid, tok) {
  const side = sig.side;
  // Re-checked after every await: the session, the one-trade day, and that this
  // attempt is still the live one (the 20 s safety timer retires a hung attempt).
  const _stale = () => ptState.position || !ptState.running || _entrySessionGen !== sid || ptState._fillTok !== tok
    || ptState._dayDone || (ptState.sessionTrades.length + (ptState._priorTradesToday || 0)) >= 1;
  const res = await _resolveEntry(fillSpot, side);
  if (_stale()) return { opened: false, retry: false };
  if (!res || res.invalid || !res.symbol) {
    log(`❌ [PAPER] Cannot enter ${side} — ${res && res.symbol ? `symbol ${res.symbol} invalid on Fyers` : (IS_FUT ? "no futures contract resolved" : "no option symbol resolved")}.`);
    return { opened: false, retry: true };
  }
  const { symbol, expiry, strike } = res;
  if (IS_FUT) {
    log(`🎯 [PAPER] ENTRY ${side === "CE" ? "LONG" : "SHORT"} FUTURES @ ₹${fillSpot} | ${sig.reason}`);
    log(`📌 Futures symbol: ${symbol}`);
  } else {
    log(`🎯 [PAPER] ENTRY ${side} @ ₹${fillSpot} | ${sig.reason}`);
    log(`📌 ATM Option: ${symbol} (Spot: ${fillSpot} → Strike: ${strike} | Expiry: ${expiry})`);
  }

  let entryLtp = null;
  let entryQuote = null;   // the quote another market fills its entry at (pairRuntime.entryFill)
  if (!IS_FUT) {
    // Another market: its bid-ask spread limit (<PAIR>_MAX_SPREAD_PTS) on a
    // fresh quote, which also prices the fill. NIFTY has no spread check.
    let _q = null;
    if (!rt.home) {
      _q = await tradeGuards.fetchOptionQuote(fyers, symbol);
      if (_stale()) return { opened: false, retry: false };
      const _sp = tradeGuards.checkSpread(_q && _q.bid, _q && _q.ask, rt.maxSpreadPts());
      if (!_sp.ok) {
        // Retried every ENTRY_RETRY_MS inside the window — logged once a minute.
        if (!ptState._spreadSkipLoggedMs || Date.now() - ptState._spreadSkipLoggedMs > 60000) {
          ptState._spreadSkipLoggedMs = Date.now();
          log(`⏭️ [PAPER] SKIP ${side} entry — spread too wide (${_sp.reason}, limit ${rt.maxSpreadPts()}pt) — retrying inside the window`);
          skipLogger.appendSkipLog(MODE, { gate: "spread", reason: _sp.reason || null, spot: fillSpot, side, symbol, bid: _q && _q.bid, ask: _q && _q.ask, limit: rt.maxSpreadPts() });
        }
        return { opened: false, retry: true };
      }
    }
    entryLtp = await _fillPremium(symbol, _q);   // NIFTY: _q is null — the stream, else a quote, as before
    if (_stale()) return { opened: false, retry: false };
    if (!(entryLtp > 0)) {
      log(`⚠️ [PAPER] No option LTP for ${symbol} — ${side} entry not filled.`);
      return { opened: false, retry: true };
    }
    if (!rt.home && _q) entryQuote = { ltp: _q.ltp, bid: _q.bid, ask: _q.ask, at: Date.now() };
  }
  // The gap may have filled while the contract / premium were being fetched.
  const nowSpot = ptState.lastTickPrice || fillSpot;
  if (!engine.entryStillValid(side, nowSpot, sig.prevClose)) {
    log(`⏭️ [PAPER] ${side} not entered — spot ₹${nowSpot} filled the gap (prev close ₹${sig.prevClose}) while the fill was in flight.`);
    _markDayDone("gap filled before the fill");
    skipLogger.appendSkipLog(MODE, { gate: "strategy", reason: "gap filled before the fill", spot: nowSpot, side, signal: sig.signal, prevClose: sig.prevClose });
    return { opened: false, retry: false };
  }
  simulateBuy(symbol, side, _qty(), nowSpot, sig.reason, nowSpot, {
    entryLtp,
    ...(rt.home ? {} : { entryQuote }),
    signal:       sig,
    entryBarTime: ptState.currentBar ? ptState.currentBar.time : null,
  });
  return { opened: !!ptState.position && ptState.position.symbol === symbol, retry: false };
}

/**
 * Tick-driven: make the day's one decision inside the entry window. Every guard
 * runs synchronously and _entryPending is set before the first await, so
 * concurrent ticks can never open two positions. The day is "done" only once a
 * position exists or the engine says NONE for a reason that cannot change; a
 * failed FILL retries (throttled) until ENTRY_END.
 */
function _tryDayEntry(ltp, nowMs) {
  const cfg = _cfg();
  const nowSec = Math.floor(nowMs / 1000);
  if (_entryBlockReason(cfg, nowSec)) return;
  // Another market: <PAIR>_EXPIRY_DAY_ONLY on a day that is not ITS expiry
  // (SENSEX weekly, BANKNIFTY monthly …). NIFTY has no such toggle.
  if (!rt.home && rt.expiryDayOnly() && !rt.isExpiryDay(nowMs)) {
    const why = `${pair.expiryDayOnlyKey} is on and today is not a ${rt.market().label} expiry day`;
    log(`⏭️ [PAPER] No trade today — ${why}`);
    skipLogger.appendSkipLog(MODE, { gate: "expiry_day_only", reason: why, spot: ltp });
    _markDayDone(why);
    return;
  }
  const mins = engine._istMins(nowSec);
  if (mins < cfg.ENTRY_START) return;
  if (!engine.isInEntryWindow(nowSec, cfg)) {
    const why = `entry window ${_fmtMins(cfg.ENTRY_START)}–${_fmtMins(cfg.ENTRY_END)} closed without a fill`;
    log(`⏭️ [PAPER] No trade today — ${why}${ptState.lastSignal ? ` (last decision: ${ptState.lastSignal.reason})` : ""}`);
    skipLogger.appendSkipLog(MODE, { gate: "window", reason: why, spot: ltp });
    _markDayDone(why);
    return;
  }
  // Inputs: yesterday's setup and today's official open.
  _ensureSetup(_todayKey());
  _ensureTodayOpen();
  if (!ptState.setup || ptState.todayOpen == null) return;
  if (Date.now() - (ptState._lastEntryAttemptMs || 0) < ENTRY_RETRY_MS) return;
  ptState._lastEntryAttemptMs = Date.now();

  const sig = engine.getSignal({ setup: ptState.setup, todayOpen: ptState.todayOpen, cfg, prefix: PREFIX });
  _recordSignal(sig);
  if (sig.signal !== "BUY_CE" && sig.signal !== "BUY_PE") {
    if (sig.skipReason === "warmup" || sig.skipReason === "no_open") return;   // inputs can still arrive
    log(`📋 [PAPER] Today's decision: NONE — ${sig.reason}`);
    skipLogger.appendSkipLog(MODE, {
      gate: "strategy", reason: sig.reason || null, skip: sig.skipReason || null, spot: ltp,
      prevClose: sig.prevClose, prevRsi: sig.prevRsi, zone: sig.zone, todayOpen: sig.todayOpen, gapPts: sig.gapPts,
    });
    _markDayDone(`no setup today — ${sig.reason}`);
    return;
  }
  if (!engine.entryStillValid(sig.side, ltp, sig.prevClose)) {
    log(`⏭️ [PAPER] ${sig.signal} but spot ₹${ltp} has already filled the gap (prev close ₹${sig.prevClose}) — no trade today.`);
    skipLogger.appendSkipLog(MODE, { gate: "strategy", reason: "gap already filled at the fill", spot: ltp, side: sig.side, signal: sig.signal, prevClose: sig.prevClose });
    _markDayDone("gap already filled before entry");
    return;
  }

  ptState._entryPending = true;   // synchronous — before the first await
  ptState._entryAttempts = (ptState._entryAttempts || 0) + 1;
  const sid = _entrySessionGen;
  const attempt = ptState._entryAttempts;
  if (attempt === 1) log(`📋 [PAPER] ${sig.signal} — ${sig.reason} · filling @ spot ₹${ltp}`);
  else log(`🔁 [PAPER] Retrying ${sig.signal} fill (attempt ${attempt}) @ spot ₹${ltp}`);
  const tok = ptState._fillTok = (ptState._fillTok || 0) + 1;
  // A hung attempt is retired (its token bumped) before entries are unblocked,
  // so it can never open a position once a newer attempt is running.
  const _safety = setTimeout(() => { if (ptState._fillTok === tok) ptState._fillTok++; if (ptState._entryPending) ptState._entryPending = false; }, 20000);
  _fillEntry(sig, ltp, sid, tok)
    .catch((err) => {
      log(`❌ [PAPER] Entry error: ${err.message}`);
      return { opened: false, retry: true };
    })
    .then((r) => {
      if (r && r.opened) return;
      if (r && r.retry && attempt === 1) log(`⚠️ [PAPER] ${sig.side} fill failed — retrying every ${ENTRY_RETRY_MS / 1000}s until ${_fmtMins(_cfg().ENTRY_END)}`);
    })
    .finally(() => { ptState._entryPending = false; clearTimeout(_safety); });
}

// ── On each completed chart candle ───────────────────────────────────────────
// No exit rule reads a candle — this only feeds the chart and the log.
// `fillSpot` is the tick that closed the candle (the first tick after the close).
function onCandleClose(candle, fillSpot) {
  _pushCapped(ptState.candles, candle);
  ptState.prevCandleHigh = candle.high;
  ptState.prevCandleLow  = candle.low;

  const fill    = Number.isFinite(fillSpot) && fillSpot > 0 ? fillSpot : candle.close;
  const closeAt = _hhmm(candle.time + TRADE_RES * 60);

  log(`📊 [PAPER] ──── ${TRADE_RES}m candle close ${closeAt} ── O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close}`);

  if (ptState.position) {
    const pos = ptState.position;
    pos.candlesHeld = (pos.candlesHeld || 0) + 1;
    log(`   Open ${pos.side} @ ₹${pos.spotAtEntry} | option entry=${pos.optionEntryLtp ? "₹" + pos.optionEntryLtp : "—"} now=${ptState.optionLtp ? "₹" + ptState.optionLtp : "—"} peak=${pos.bestOptionLtp ? "₹" + pos.bestOptionLtp : "—"}`);
  }

  // ── Session end at TRADE_STOP_TIME (the timer also does this) ──
  if (getISTMinutes() >= _STOP_MINS) {
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
      saveSession();
      socketManager.removeCallback(SOCKET_CALLBACK_ID);
      rt.socketSlot.clear();
      if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) {
        socketManager.stop();
      } else if (sharedSocketState.isAnyActive()) {
        log("📡 [PAPER] Socket kept alive — another strategy is still active");
      }
      stopOptionPolling();
    }
  }
}

// ── Tick handler (NIFTY SPOT ONLY) ───────────────────────────────────────────
// Builds the chart candles, runs the per-tick profit lock on the option premium,
// and — while flat inside the entry window — makes the day's one decision.
function onTick(tick) {
  if (!tick || !tick.ltp) return;
  if (!ptState.running) return;  // ← guard: ignore ticks after stop

  ptState.tickCount++;
  const now = Date.now();
  const ltp = tick.ltp;
  ptState.lastTickTime  = now;
  ptState.lastTickPrice = ltp;

  // Skip pre-market / pre-open candles (build only from 09:15 NSE open).
  const bucket = _bucketMs(now, TRADE_RES);
  if (_istMinOfMs(bucket) < _MKT_OPEN_MINS) return;

  // An IST-day change (a session left running overnight) resets the day's decision.
  const tk = _todayKey();
  if (ptState._dayKey !== tk) {
    ptState._dayKey = tk;
    ptState._dayDone = false; ptState._dayDoneReason = null;
    ptState.todayOpen = null; ptState.todayOpenSrc = null; ptState._openErrLogged = false;
    ptState._firstTickOpen = null; ptState._firstTickAtMs = null;
    ptState._entryAttempts = 0; ptState._lastEntryAttemptMs = 0;
  }
  if (ptState._firstTickOpen == null) { ptState._firstTickOpen = ltp; ptState._firstTickAtMs = now; }
  if (!ptState.setup) _ensureSetup(tk);

  if (!ptState.currentBar || ptState.barStartTime !== bucket) {
    if (ptState.currentBar) {
      try { onCandleClose(ptState.currentBar, ltp); }
      catch (err) { console.error(`${TAG} onCandleClose error: ${err.stack || err.message}`); }
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
    trackPath(pos, _favPts, now);
    if (pos.side === "CE") { if (!pos.bestPrice || ltp > pos.bestPrice) pos.bestPrice = ltp; }
    else                   { if (!pos.bestPrice || ltp < pos.bestPrice) pos.bestPrice = ltp; }
    if (ptState.optionLtp && ptState.optionLtp > (pos.bestOptionLtp || 0)) pos.bestOptionLtp = parseFloat(ptState.optionLtp.toFixed(2));
    // Trade journal (observer only): the same spot favPts, the premium / futures
    // P&L, and the exit level whenever it moves.
    {
      const _optNow = pos.isFutures ? null : ptState.optionLtp;
      const _pnlRs  = pos.isFutures ? _favPts * (pos.qty || 0)
        : (pos.optionEntryLtp && _optNow ? (_optNow - pos.optionEntryLtp) * (pos.qty || 0) : null);
      tradeJournal.onTick(pos, { favPts: _favPts, pnlRs: _pnlRs, spot: ltp, ltp: _optNow, nowMs: now });
      _journalStopLevel(pos, ltp, _optNow);
    }

    // ── Global profit lock (shared across every strategy — see tradeGuards) ──
    // The ONLY automatic exit. Option premium only, never spot.
    if (!pos.isFutures && pos.optionEntryLtp && ptState.optionLtp) {
      const _plMsg = tradeGuards.checkProfitLock(pos.optionEntryLtp, ptState.optionLtp, pos.bestOptionLtp);
      if (_plMsg) {
        log(`🔒 [PAPER] ${_plMsg}`);
        simulateSell(ltp, _plMsg, ltp);
        return;
      }
    }
    // The NIFTY_FUT pair: the same common stop mapped to index points (entry =
    // the index level the future was priced at).
    if (pos.isFutures && ltp > 0) {
      const _dir = pos.side === "CE" ? 1 : -1;
      const _bestFav = pos.bestPrice ? (pos.bestPrice - pos.entryPrice) * _dir : 0;
      const _fsMsg = tradeGuards.checkFuturesStop(pos.side, pos.entryPrice, ltp, _bestFav);
      if (_fsMsg) {
        log(`🔒 [PAPER] ${_fsMsg}`);
        simulateSell(ltp, _fsMsg, ltp);
        return;
      }
    }
    return;
  }

  // ── Flat: the day's one decision (inside the entry window only) ──
  if (!ptState._dayDone) _tryDayEntry(ltp, now);
}

// ── Trade journal helpers (observer only — nothing here feeds a decision) ───
// GAP_RUNAWAY has no stop variable of its own: its only automatic exit is the
// profit lock / premium stop on the option premium (the NIFTY_FUT pair: the
// futures stop on the index). The journal's "stop" is the level that exit
// fills at, recomputed with the same inputs the per-tick check uses, and
// recorded whenever it moves.
let _jLastStop = null;   // last level handed to onStopChange for the open position
function _journalStopLevel(pos, spot, optLtp) {
  try {
    let lvl = null, kind, why, dir = 1;   // dir: the way a tighter stop moves
    if (pos.isFutures) {
      dir = pos.side === "PE" ? -1 : 1;   // a short's stop trails DOWN
      const _bestFav = pos.bestPrice ? (pos.bestPrice - pos.entryPrice) * dir : 0;
      lvl  = tradeGuards.futuresStopLevel(pos.side, pos.entryPrice, _bestFav);
      kind = _jLastStop == null ? "initial" : "trail";
      why  = `futures stop (best ${parseFloat(_bestFav.toFixed(2))}pt)`;
    } else if (pos.optionEntryLtp) {
      const e = pos.optionEntryLtp, b = pos.bestOptionLtp;
      lvl = tradeGuards.exitLevelLtp(e, b);
      const stop = tradeGuards.premiumStopLtp(e, b);
      if (lvl != null && lvl !== stop) { kind = "lock"; why = `profit lock floor (peak ₹${b}, entry ₹${e})`; }
      else { kind = _jLastStop == null ? "initial" : "trail"; why = `premium stop (peak ₹${b || e}, entry ₹${e})`; }
    }
    if (lvl == null || lvl === _jLastStop) return;
    // Only a settings change can loosen it (every level here only ratchets tighter).
    if (_jLastStop != null && (lvl - _jLastStop) * dir < 0) kind = "manual";
    tradeJournal.onStopChange(pos, { from: _jLastStop, to: lvl, kind, reason: why, spot, ltp: optLtp, nowMs: Date.now() });
    _jLastStop = lvl;
  } catch (_) {}
}
// An option whose premium was not known at the fill (a manual entry with no
// LTP yet) gets it at the contract's first poll — complete the journal's entry.
function _jEntryPremium(pos, ltp) {
  try {
    const e = pos && pos.journal && pos.journal.entry;
    if (!e || e.optionLtp != null || !(ltp > 0)) return;
    e.optionLtp = ltp;
    e.fill = ltp;
    if (e.expectedPrice != null) e.slippagePts = Math.round((ltp - e.expectedPrice) * 100) / 100;
  } catch (_) {}
}
function _journalExitKind(reason) {
  const r = String(reason || "");
  if (/^Profit lock/i.test(r) || /^Stop-loss trail/i.test(r)) return "trail";
  if (/^Stop-loss|futures .* hit the stop/i.test(r)) return "sl";
  if (/^Manual/i.test(r))    return "manual";
  return "eod";   // session end, auto-stop, shutdown
}

// -- Save completed session to disk ───────────────────────────────────────────

function saveSession() {
  const data = loadPaperData();

  const session = {
    // IST, not UTC — the trade-cap restart recovery matches on this field.
    date:        new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    strategy:    ACTIVE,
    instrument:  TRADED_AS(),
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
    setup:       ptState.setup ? { prevDate: ptState.setup.prevDate, prevClose: ptState.setup.prevClose, prevRsi: ptState.setup.prevRsi, zone: ptState.setup.zone } : null,
    todayOpen:   ptState.todayOpen,
    decision:    ptState.lastSignal ? ptState.lastSignal.reason : (ptState._dayDoneReason || null),
  };

  data.sessions.push(session);
  data.totalPnl = parseFloat((data.totalPnl + ptState.sessionPnl).toFixed(2));
  data.capital  = parseFloat((data.capital  + ptState.sessionPnl).toFixed(2));

  savePaperData(data);
  capitalPool.sessionSaved(MODE);
  log(`💾 Session saved. Running capital: ₹${data.capital} | Total PnL: ₹${data.totalPnl}`);

  generatePaperDailyReport(ptState.sessionTrades, ptState.sessionPnl);

  return session;
}

/** Bucket an exit reason for the day report. Order matters: specific first. */
function _exitGroup(reason) {
  const r = String(reason || "");
  if (/Profit lock/i.test(r))                   return "Profit Lock";
  if (/Manual/i.test(r))                        return "Manual Exit";
  if (IS_FUT && /futures .* hit the stop/i.test(r)) return "Futures Stop";
  if (/Session end|Auto-stop|Shutdown|stop/i.test(r)) return "Session Stop";
  return "Other";
}

function generatePaperDailyReport(trades, sessionPnl) {
  try {
    const dateStr  = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
    if (!trades || trades.length === 0) {
      if (canSend("TG_GAP_RUNAWAY_DAYREPORT")) {
        sendTelegram([
          `📄 ${TITLE} PAPER — DAY REPORT`,
          `📅 ${dateStr}`,
          ``,
          `No trade today.`,
          ptState.lastSignal && ptState.lastSignal.reason ? `Decision: ${ptState.lastSignal.reason}` : (ptState._dayDoneReason ? `Decision: ${ptState._dayDoneReason}` : ``),
          `Session PnL: ₹0`,
        ].join("\n"));
      }
      return;
    }
    const t = trades[trades.length - 1];
    const pnlEmoji = sessionPnl >= 0 ? "🟢" : "🔴";
    log(`\n${"═".repeat(54)}`);
    log(`📊 PAPER DAILY JOURNAL — ${dateStr}`);
    log(`   Trades    : ${trades.length} | Session PnL: ${pnlEmoji} ₹${sessionPnl}`);
    log(`   ${t.side} ${t.symbol} | gap ${t.gapPts} | RSI ${t.prevRsi} | exit: ${_exitGroup(t.exitReason)} — ${t.exitReason}`);
    log(`${"═".repeat(54)}\n`);
    if (canSend("TG_GAP_RUNAWAY_DAYREPORT")) {
      sendTelegram([
        `📄 ${TITLE} PAPER — DAY REPORT`,
        `📅 ${dateStr}`,
        ``,
        `Trades   : ${trades.length}`,
        `Session  : ${pnlEmoji} ₹${sessionPnl}`,
        ``,
        ...trades.map(x => `${x.side} ${x.optionStrike || ""} · gap ${x.gapPts} · RSI ${x.prevRsi} · ${_exitGroup(x.exitReason)} · ₹${x.pnl}`),
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
 * `resMin`, so EMA21 is defined on the very first live close. Fyers history
 * includes today's still-forming bar: it is returned separately (to seed the
 * live bar) and never fed to the engine.
 */
async function _preloadSeries(resMin, days, todayStr) {
  const { fetchCandles } = require("../services/marketData");
  const fromDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  fromDate.setDate(fromDate.getDate() - (days * 2 + 7));
  const fromStr = fromDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const raw = await fetchCandles(SPOT(), String(resMin), fromStr, todayStr);
  const nowSec = Math.floor(Date.now() / 1000);
  const closed = [];
  let forming = null;
  for (const c of (Array.isArray(raw) ? raw : [])) {
    if (!c || typeof c.time !== "number") continue;
    if (c.time + resMin * 60 <= nowSec) closed.push(c);
    else if (c.time <= nowSec) forming = c;
  }
  closed.sort((a, b) => a.time - b.time);
  const todayKey = engine._istDayOf(nowSec);
  const prior = [...new Set(closed.map(c => engine._istDayOf(c.time)).filter(k => k < todayKey))].slice(-days);
  const keep = new Set(prior.concat([todayKey]));
  const kept = closed.filter(c => keep.has(engine._istDayOf(c.time)));
  return { closed: kept.slice(-MAX_BARS), forming, fromStr: kept.length ? tradeLogger.istDateString(kept[0].time * 1000) : fromStr };
}

/**
 * GET /gap_runaway-paper/start
 * Connects to live Fyers socket and starts simulating trades
 */
router.get("/start", async (req, res) => {
  if (ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading already running." });
  }
  // Every non-home pair ships OFF: its own switch, before any broker call.
  if (!rt.home && !rt.enabled()) {
    return res.status(403).json({ success: false, error: `${TITLE} is switched off. Turn on ${pair.enabledKey} in Settings → ${rt.market().label} first.` });
  }
  _refreshConfig();

  const auth = await verifyFyersToken();
  if (!auth.ok) {
    return res.status(401).json({ success: false, error: auth.message, code: auth.code });
  }
  if (ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading already running." });
  }

  // Master toggle — default ON (the user wants Start All to start this strategy).
  if (rt.home && String(process.env.GAP_RUNAWAY_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: `${engine.LABEL} is disabled. Enable it in Settings first.` });
  }

  // Own mutex slot: GAP_RUNAWAY Paper ⊥ GAP_RUNAWAY Live, parallel with every other strategy
  // (another market: its own <PAIR>_PAPER slot).
  {
    const _gate = rt.home ? sharedSocketState.canStart("GAP_RUNAWAY_PAPER") : rt.socketSlot.canStart();
    if (!_gate.allowed) {
      return res.status(400).json({ success: false, error: `Cannot start ${TITLE} paper trading — ${_gate.reason}` });
    }
  }

  // This market's exchange calendar (NSE / BSE holidays).
  const tradingCheck = rt.home ? await isTradingAllowed() : await rt.isTradingAllowed();
  if (!tradingCheck.allowed) {
    return res.status(400).json({ success: false, error: `❌ ${tradingCheck.reason}` });
  }
  if (!isStartAllowed()) {
    return res.status(400).json({
      success: false,
      error: "Trading session closed for today — past " + _fmtMins(_STOP_MINS) + " IST. Restart tomorrow.",
    });
  }
  if (ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading already running." });
  }

  const subscribeSymbol = SPOT();
  if (!subscribeSymbol) return res.status(400).json({ success: false, error: `${TITLE}: no spot symbol for ${rt.market().label}` });
  const data        = loadPaperData();
  const todayStr = _todayStr();
  const cfg = _cfg();

  // Reset session state
  _entrySessionGen++;
  ptState.running       = true;
  ptState.candles       = [];
  ptState.currentBar    = null;
  ptState.barStartTime  = null;
  ptState.position      = null;
  ptState.sessionTrades = [];
  ptState._staleSession = false;
  ptState.sessionPnl    = 0;
  ptState.sessionStart  = istNow();
  ptState.log           = [];
  ptState.tickCount     = 0;
  ptState._entryPending = false;
  ptState.lastSignal    = null;
  ptState.setup         = null;
  ptState._setupError   = null;
  ptState._setupLastTryMs = 0;
  ptState.todayOpen     = null;
  ptState.todayOpenSrc  = null;
  ptState._openLastTryMs = 0;
  ptState._openErrLogged = false;
  ptState._firstTickOpen = null;
  ptState._firstTickAtMs = null;
  ptState._dayKey       = _todayKey();
  ptState._dayDone      = false;
  ptState._dayDoneReason = null;
  ptState._lastEntryAttemptMs = 0;
  ptState._entryAttempts = 0;
  ptState.lastTickTime  = null;
  ptState.lastTickPrice  = null;
  ptState.prevCandleHigh = null;
  ptState.prevCandleLow  = null;
  ptState.optionLtp      = null;
  ptState.optionLtpUpdatedAt = null;
  ptState._ltpStaleLogged    = false;
  ptState.optionSymbol   = null;
  ptState.optionChart    = null;
  ptState._consecutiveLosses   = 0;
  ptState._priorTradesToday    = 0;     // re-seeded from disk just below
  _chartSeriesCache = { key: null, value: null };
  if (!rt.home) { ptState.optionQuote = null; ptState._spreadSkipLoggedMs = 0; }
  // ── One-trade-per-day RESTART RECOVERY ────────────────────────────────────
  // A stop→start (or crash + PM2 restart) mid-day must not hand the day a fresh
  // trade: count today's earlier trades from the saved sessions AND the day file.
  try {
    let _inReplay = false;
    try { _inReplay = require("../services/tickReplay").isReplayInProgress(); } catch (_) {}
    if (_inReplay) throw { __skip: true };
    let _taken = 0;
    const _keyOf = (t) => String(t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`);
    const _savedKeys = new Set();
    for (const s of (data.sessions || [])) {
      for (const t of (s.trades || [])) _savedKeys.add(_keyOf(t));
      if (String(s.date || "").slice(0, 10) === todayStr) {
        _taken += Array.isArray(s.trades) ? s.trades.length : (Number(s.totalTrades) || 0);
      }
    }
    for (const t of tradeLogger.readDailyTrades(MODE, todayStr)) {
      if (!t || t.type || !(t.side || t.entryTime || t.entryBarTime || t.symbol)) continue;
      if (_savedKeys.has(_keyOf(t))) continue;
      _taken++;
    }
    ptState._priorTradesToday = _taken;
    if (_taken > 0) {
      _markDayDone("already traded today (earlier session) — one trade per day");
      log(`♻️ [PAPER] Restart recovery — ${_taken} trade(s) already taken today: no new entry today.`);
    }
    // A crash while IN a trade logs nothing (trades are written at exit), but it
    // leaves today's crash-recovery snapshot behind: that day is traded too.
    const _pp = require("../utils/positionPersist");
    const _snap = rt.home ? _pp.loadGapRunawayPosition() : _pp.loadPairPosition(MODE);
    if (_snap && _snap.position) {
      _markDayDone("a position from an earlier session today was never closed (crash) — one trade per day");
      log(`🚨 [PAPER] Restart recovery — today's snapshot holds an open ${_snap.position.side} ${_snap.position.symbol} that this session cannot see. No new entry today; check the ${rt.home ? "Zerodha" : "Fyers"} book if Live was armed.`);
    }
    // A decision already settled today (no setup, gap filled, window missed…) stands.
    const _saved = _loadDayDecision();
    if (_saved && !ptState._dayDone) {
      ptState._dayDone = true;
      ptState._dayDoneReason = `${_saved} (decided earlier today)`;
      log(`♻️ [PAPER] Restart recovery — today was already decided: ${_saved}`);
    }
  } catch (e) {
    if (!(e && e.__skip)) log(`⚠️ [PAPER] trade-cap restart recovery failed: ${e.message}`);
  }
  _tradesMapCache = []; _tradesMapCount = 0; // clear cached trades for poll
  stopOptionPolling();

  // A start after the entry window can never trade today — say so at once.
  const _nowMins = getISTMinutes();
  if (!ptState._dayDone && _nowMins > cfg.ENTRY_END) {
    _markDayDone(`started after the ${_fmtMins(cfg.ENTRY_END)} entry cut-off — no trade today`);
  }

  log(`\n════════════════════════════════════════════════════════════════════`);
  log(`🟡 [PAPER] Paper trading started`);
  log(`   Strategy   : ${TITLE} — ${engine.DESCRIPTION}`);
  log(`   Reference  : ${engine.referenceUrl(PREFIX)}`);
  log(`   Instrument : ${TRADES_DESC} · ${_lots()} lot (${_qty()} qty) · ${BROKER_LABEL}`);
  log(`   Capital    : ₹${data.capital.toLocaleString("en-IN")}`);
  // Every number here comes from the engine's own config, so the banner can
  // never drift from the rules that actually run.
  log(`   Setup      : daily RSI(${cfg.RSI_LENGTH}) on EMA(${cfg.EMA_LENGTH}) of YESTERDAY's close — < ${cfg.RSI_LOWER} oversold, > ${cfg.RSI_UPPER} overbought`);
  log(`   Entry      : oversold + gap UP → CE · overbought + gap DOWN → PE · gap = today's open − yesterday's close (min ${cfg.MIN_GAP_PTS} pts) · ${_fmtMins(cfg.ENTRY_START)}–${_fmtMins(cfg.ENTRY_END)} · 1 trade/day`);
  log(IS_FUT ? `   Exit       : common stop mapped to index points (the only automatic exit) · session end ${_fmtMins(_STOP_MINS)}` : `   Exit       : common profit lock on the option premium (the only automatic exit) · session end ${_fmtMins(_STOP_MINS)}`);
  log(rt.home ? `   Common     : profit lock + Zerodha capital pool only — no cooldown / spread / lot multiplier / trade window` : `   Common     : profit lock + Fyers capital pool · spread limit ${rt.maxSpreadPts()}pt · ${pair.expiryDayOnlyKey}=${rt.expiryDayOnly()} — no cooldown / lot multiplier / trade window`);
  if (ptState._dayDone) log(`   Today      : ${ptState._dayDoneReason}`);
  log(`════════════════════════════════════════════════════════════════════\n`);

  // ── Daily setup — awaited so the 09:15 decision has it ──
  await _refreshSetup(_todayKey());

  notifyStarted({
    mode: NOTIFY_MODE,
    text: [
      `${ptState.setup ? "✅" : "⚠️"} ${TITLE} PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Instrument: ${TRADES_DESC} · ${_lots()} lot`,
      `Capital   : ₹${data.capital.toLocaleString("en-IN")}`,
      `Window    : ${_fmtMins(cfg.ENTRY_START)} → ${_fmtMins(cfg.ENTRY_END)} IST · exit: profit lock only`,
      ``,
      `${ptState.setup ? "✅" : "❌"} Setup : ${ptState.setup ? `prev ${ptState.setup.prevDate} close ${ptState.setup.prevClose} · RSI ${ptState.setup.prevRsi} → ${ptState.setup.zone}` : (ptState._setupError || "daily candles unavailable")}`,
      ptState._dayDone ? `ℹ️ ${ptState._dayDoneReason}` : ``,
    ].join("\n"),
  });

  // ── PRE-LOAD chart history ──
  try {
    log(`📥 Pre-loading ${WARMUP_DAYS} day(s) of ${TRADE_RES}-min history for the chart...`);
    const main = await _preloadSeries(TRADE_RES, WARMUP_DAYS, todayStr);
    ptState.candles = main.closed;
    log(`✅ Pre-loaded ${ptState.candles.length} × ${TRADE_RES}-min candles (from ${main.fromStr} to ${todayStr})`);
    if (main.forming && _istMinOfMs(main.forming.time * 1000) >= _MKT_OPEN_MINS && !ptState.currentBar) {
      ptState.currentBar   = { time: main.forming.time, open: main.forming.open, high: main.forming.high, low: main.forming.low, close: main.forming.close, volume: main.forming.volume || 0 };
      ptState.barStartTime = main.forming.time * 1000;
    }
    const lastCandle = ptState.candles[ptState.candles.length - 1];
    if (lastCandle) {
      ptState.prevCandleHigh = lastCandle.high;
      ptState.prevCandleLow  = lastCandle.low;
    }
  } catch (err) {
    log(`⚠️  Could not pre-load candles: ${err.message} — will build from live ticks`);
  }

  // A mid-session start inside the window: today's open is already known.
  if (_nowMins >= _MKT_OPEN_MINS && !ptState._dayDone) _refreshTodayOpen().catch(() => {});

  // Tick-recorder session-start snapshot
  ptState._sessionId = `${OWNER}:${Date.now()}`;
  try {
    tickRecorder.recordSessionStart({
      mode: OWNER,
      sessionId: ptState._sessionId,
      settings: tickRecorder.snapshotSettings(),
      warmup:   ptState.candles.map(c => ({ ...c })),
      meta: {
        instrument:          TRADED_AS(),
        resolutionMin:       TRADE_RES,
        setup:               ptState.setup,
        spotSymbol:          subscribeSymbol,
        sessionStartISO:     ptState.sessionStart,
        activeStrategy:      ACTIVE,
      },
    });
  } catch (_) {}

  if (_nowMins < _START_MINS) {
    log("⏳ [PAPER] Pre-market mode — " + (_START_MINS - _nowMins) + " min until " + _fmtMins(_START_MINS) + ". Daily setup loaded.");
    log("   The day's one decision is made from " + _fmtMins(cfg.ENTRY_START) + " once today's open is known.");
  }

  const _stopLabelAtStart = _fmtMins(_STOP_MINS);
  scheduleAutoStop((msg) => {
    log(msg);
    if (ptState.position && ptState.lastTickPrice) {
      simulateSell(ptState.lastTickPrice, "Auto-stop " + _stopLabelAtStart, ptState.lastTickPrice);
    }
    ptState.running = false;
    stopOptionPolling();
    try {
      tickRecorder.recordSessionStop({ mode: OWNER, sessionId: ptState._sessionId || null, reason: "auto_stop_eod" });
    } catch (_) {}
    socketManager.removeCallback(SOCKET_CALLBACK_ID);
    rt.socketSlot.clear();
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
  rt.socketSlot.set();

  return res.json({
    success:     true,
    message:     "Paper trading started! No real orders will be placed.",
    strategy:    { key: ACTIVE, name: engine.LABEL },
    tradeRes:    TRADE_RES,
    setup:       ptState.setup,
    dayDone:     ptState._dayDone ? ptState._dayDoneReason : null,
    lotQty:      _qty(),
    capital:     data.capital,
    monitorAt:   `GET ${ROUTE}/status`,
  });
});

/**
 * GET /gap_runaway-paper/stop
 * Stops the session, squares off virtual position, saves summary to disk
 */
router.get("/stop", async (req, res) => {
  if (!ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading is not running." });
  }
  if (ptState.position && (ptState.lastTickPrice || ptState.currentBar)) {
    const _px = ptState.lastTickPrice || ptState.currentBar.close;
    simulateSell(_px, "Manual stop", _px);
  }

  stopOptionPolling();
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  socketManager.removeCallback(SOCKET_CALLBACK_ID);
  rt.socketSlot.clear();
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) {
    socketManager.stop();
  }
  ptState.running = false;

  try {
    tickRecorder.recordSessionStop({ mode: OWNER, sessionId: ptState._sessionId || null, reason: "user_stop" });
  } catch (_) {}

  log("⏹ [PAPER] Paper trading stopped");
  const session = saveSession();
  return res.json({
    success:  true,
    message:  "Paper trading stopped. Session saved.",
    session,
    viewHistory: `GET ${ROUTE}/history`,
  });
});

/**
 * GET /gap_runaway-paper/exit
 * Manually exit the current open position without stopping the session.
 * One trade per day: no automatic re-entry follows.
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
  log(`🖐️ [PAPER] MANUAL EXIT triggered by user | ${SPOT_LABEL} spot: ₹${exitSpot} | Option LTP: ${exitOption ? "₹" + exitOption : "N/A"}`);
  simulateSell(exitSpot, "Manual exit by user", exitSpot);
  return res.json({ success: true, message: "Position exited manually.", exitSpot });
});

/**
 * POST /gap_runaway-paper/manualEntry
 * Manually enter a CE or PE at the current spot. Exits on the common profit lock
 * like any other trade. Counts as the day's one trade.
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
  if ((ptState.sessionTrades.length + (ptState._priorTradesToday || 0)) >= 1 || /one trade per day/.test(String(ptState._dayDoneReason || ""))) {
    return res.status(409).json({ success: false, error: "One trade per day — today's trade has already been taken." });
  }
  const st = ptState.setup;

  const _sidManual = _entrySessionGen;
  ptState._entryPending = true;   // synchronous — an automatic entry cannot race this one
  try {
    const optResult = await _resolveEntry(spot, side);
    if (!optResult || optResult.invalid || !optResult.symbol) {
      const why = optResult && optResult.staleExpiry
        ? `${optResult.overrideKey}="${optResult.staleExpiry}" has expired — update it in Settings`
        : (IS_FUT ? "no futures contract could be resolved" : "no valid option symbol could be resolved on Fyers");
      log(`❌ [PAPER] Manual entry refused — ${why}`);
      return res.status(409).json({ success: false, error: why });
    }
    const symbol = optResult.symbol;
    let entryLtp = null;
    let entryQuote = null;   // another market: the fresh quote its option fills at
    if (rt.home) {
      try { entryLtp = await _fillPremium(symbol); } catch (_) { entryLtp = null; }
    } else if (!IS_FUT) {
      try {
        const _q = await tradeGuards.fetchOptionQuote(fyers, symbol);
        if (_q) entryQuote = { ltp: _q.ltp, bid: _q.bid, ask: _q.ask, at: Date.now() };
        entryLtp = await _fillPremium(symbol, _q);
      } catch (_) { entryLtp = null; }
    }
    if (!ptState.running || _entrySessionGen !== _sidManual) {
      return res.status(409).json({ success: false, error: "Session stopped during symbol lookup — entry cancelled" });
    }
    if (ptState.position) {
      return res.status(400).json({ success: false, error: "Already in a position. Exit first." });
    }
    log(`🖐️ [PAPER] MANUAL ENTRY ${side} by user @ spot ₹${spot} | Symbol: ${symbol}`);
    simulateBuy(symbol, side, _qty(), spot, `Manual ${side} entry by user`, spot, {
      entryLtp,
      ...(rt.home ? {} : { entryQuote }),
      manual:       true,
      entryBarTime: ptState.currentBar ? ptState.currentBar.time : null,
      signal: st && st.ready ? {
        prevDate: st.prevDate, prevClose: st.prevClose, prevRsi: st.prevRsi, prevEma: st.prevEma, zone: st.zone,
        todayOpen: ptState.todayOpen,
        gapPts: ptState.todayOpen != null ? parseFloat((ptState.todayOpen - st.prevClose).toFixed(2)) : null,
      } : { todayOpen: ptState.todayOpen },
    });
    if (!ptState.position) {
      return res.status(409).json({ success: false, error: "Entry refused — see the paper log for the reason" });
    }
    _markDayDone("manual entry taken — one trade per day");
    return res.json({ success: true, spot: spot, side: side, symbol: symbol });
  } catch (e) {
    log(`❌ [PAPER] Manual entry failed: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    ptState._entryPending = false;
  }
});

/**
 * GET /gap_runaway-paper/status
 * Live view — current position, session PnL, capital, recent log
 */
// ── Session trade rows builder ───────────────────────────────────────────────
function buildSessionTradeRows(trades, inr) {
  if (!trades || trades.length === 0) return "";
  return [...trades].reverse().map(t => {
    const sc  = t.side === "CE" ? "#10b981" : "#ef4444";
    const pc  = t.pnl >= 0 ? "#10b981" : "#ef4444";
    const why = (t.exitReason || "—").substring(0, 55);
    const sideBadge = "<span style=\"font-weight:800;color:" + sc + "\">" + (t.side || "—") + "</span>";
    const strikeStr = t.optionStrike
      ? "<div style=\"font-size:1rem;font-weight:800;color:#fff;\">" + t.optionStrike + "</div>"
      : "<div style=\"color:var(--muted-1,#8ba1c2);\">—</div>";
    const expiryStr = t.optionExpiry
      ? "<div style=\"font-size:0.68rem;color:#f59e0b;margin-top:2px;\">" + t.optionExpiry + "</div>"
      : "";
    const entryNifty  = t.spotAtEntry  || t.entryPrice;
    const entryOption = t.optionEntryLtp;
    const entryCell   =
      "<div style=\"font-size:0.75rem;color:var(--muted-1,#8ba1c2);\">" + SPOT_LABEL + "</div>" +
      "<div style=\"font-weight:700;color:#c8d8f0;\">" + inr(entryNifty) + "</div>" +
      "<div style=\"font-size:0.68rem;color:var(--muted-1,#8ba1c2);margin-top:4px;\">Option</div>" +
      "<div style=\"font-weight:700;color:#60a5fa;\">" + (entryOption ? inr(entryOption) : "—") + "</div>";
    const exitNifty  = t.spotAtExit;
    const exitOption = t.optionExitLtp;
    const optPtsDiff = (entryOption && exitOption)
      ? parseFloat((exitOption - entryOption).toFixed(2))
      : null;
    const ptColor    = optPtsDiff === null ? "#8ba1c2" : optPtsDiff >= 0 ? "#10b981" : "#ef4444";
    const exitCell   =
      "<div style=\"font-size:0.75rem;color:var(--muted-1,#8ba1c2);\">" + SPOT_LABEL + "</div>" +
      "<div style=\"font-weight:700;color:#c8d8f0;\">" + inr(exitNifty) + "</div>" +
      "<div style=\"font-size:0.68rem;color:var(--muted-1,#8ba1c2);margin-top:4px;\">Option</div>" +
      "<div style=\"font-weight:700;color:#60a5fa;\">" + (exitOption ? inr(exitOption) : "—") + "</div>" +
      (optPtsDiff !== null ? "<div style=\"font-size:0.65rem;color:" + ptColor + ";margin-top:2px;\">" +
        (optPtsDiff >= 0 ? "▲ +" : "▼ ") + optPtsDiff.toFixed(2) + " pts</div>" : "");
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
// Reset at /start (never read) — per instance, not an implicit global.
let _chartSeriesCache = null;
function _getCachedTradesForPoll() {
  if (ptState.sessionTrades.length === _tradesMapCount) return _tradesMapCache;
  _tradesMapCount = ptState.sessionTrades.length;
  _tradesMapCache = ptState.sessionTrades.map(t => ({
    side: t.side || "", strike: t.optionStrike || "", expiry: t.optionExpiry || "",
    entry: t.entryTime || "", exit: t.exitTime || "",
    eSpot: t.spotAtEntry || t.entryPrice || 0, eOpt: t.optionEntryLtp || null,
    xSpot: t.spotAtExit || t.exitPrice || 0,
    xOpt: t.optionExitLtp || null, pnl: typeof t.pnl === "number" ? t.pnl : null,
    reason: t.exitReason || "",
    symbol: t.symbol || null,
    entryBarTime: t.entryBarTime || null,
    exitBarTime:  t.exitBarTime  || null,
    durationMs:   t.durationMs   || null,
  }));
  return _tradesMapCache;
}

/**
 * GET /gap_runaway-paper/status/chart-data
 * Candle history + yesterday's close + trade markers for the lightweight-charts
 * widget. Called every 4 s by the chart polling loop.
 */
router.get("/status/chart-data", async (req, res) => {
  try {
    let srcCandles = ptState.candles;
    if (!ptState.running && srcCandles.length === 0 && (ptState.sessionTrades || []).length > 0) {
      srcCandles = await chartBackfill.candlesForRestoredTrades(SPOT(), TRADE_RES, ptState.sessionTrades);
    }
    const candles = srcCandles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (ptState.running && ptState.currentBar) {
      candles.push({
        time:  ptState.currentBar.time,
        open:  ptState.currentBar.open,
        high:  ptState.currentBar.high,
        low:   ptState.currentBar.low,
        close: ptState.currentBar.close,
      });
    }
    const markers = [];
    for (const t of ptState.sessionTrades) {
      if (t.entryPrice && t.entryBarTime) {
        markers.push({ time: t.entryBarTime, position: 'belowBar', color: '#3b82f6', shape: 'arrowUp', text: `${t.side} @ ${Number(t.entryPrice).toFixed(0)}` });
      }
      if (t.exitPrice && t.exitBarTime) {
        const isWin = t.pnl > 0;
        markers.push({ time: t.exitBarTime, position: 'aboveBar', color: isWin ? '#10b981' : '#ef4444', shape: 'arrowDown', text: `Exit ${isWin ? '+' : ''}${t.pnl ? t.pnl.toFixed(0) : ''}` });
      }
    }
    const st = ptState.setup;
    return res.json({
      candles, markers,
      entryPrice: ptState.position && ptState.position.entryPrice ? ptState.position.entryPrice : null,
      optionChart: optionChart.buildPayload({ store: ptState.optionChart, position: ptState.position, trades: ptState.sessionTrades }),
      prevClose:  st ? st.prevClose : null,
      todayOpen:  ptState.todayOpen,
      tradeRes:   TRADE_RES,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** The daily-setup card payload — straight from engine.dailySetup() / getSignal(). */
function _setupPayload() {
  const cfg = _cfg();
  const st = ptState.setup;
  const ls = ptState.lastSignal;
  return {
    emaLen:     cfg.EMA_LENGTH,
    rsiLen:     cfg.RSI_LENGTH,
    rsiUpper:   cfg.RSI_UPPER,
    rsiLower:   cfg.RSI_LOWER,
    minGap:     cfg.MIN_GAP_PTS,
    window:     `${_fmtMins(cfg.ENTRY_START)}–${_fmtMins(cfg.ENTRY_END)}`,
    setup:      st ? { prevDate: st.prevDate, prevClose: st.prevClose, prevRsi: st.prevRsi, prevEma: st.prevEma, zone: st.zone, reason: st.reason } : null,
    setupError: st ? null : (ptState._setupError || (ptState.running ? "Daily setup loading…" : null)),
    todayOpen:  ptState.todayOpen,
    todayOpenSrc: ptState.todayOpenSrc,
    gapPts:     (st && ptState.todayOpen != null) ? parseFloat((ptState.todayOpen - st.prevClose).toFixed(2)) : null,
    decision:   ls ? { signal: ls.signal, reason: ls.reason } : null,
    dayDone:    ptState._dayDone ? (ptState._dayDoneReason || "decided") : null,
    reference:  engine.referenceUrl(PREFIX),
  };
}

/**
 * GET /gap_runaway-paper/status/data
 * JSON-only endpoint for AJAX polling — returns all dynamic state without HTML.
 */
router.get("/status/data", (req, res) => {
  try {
    const data     = loadPaperData();
    let unrealisedPnl = 0;
    let pnlSource     = "spot proxy";
    if (ptState.position && ptState.currentBar) {
      const { side, entryPrice, qty, optionEntryLtp, optionCurrentLtp } = ptState.position;
      const currentOptionLtp = ptState.optionLtp || optionCurrentLtp;
      if (optionEntryLtp && currentOptionLtp && optionEntryLtp > 0) {
        const _c = getCharges({ isFutures: false, exitPremium: currentOptionLtp, entryPremium: optionEntryLtp, qty });
        unrealisedPnl = parseFloat(((currentOptionLtp - optionEntryLtp) * qty - _c).toFixed(2));
        pnlSource     = "option premium";
      } else if (ptState.currentBar) {
        const _c = getCharges({ isFutures: IS_FUT, exitPremium: ptState.currentBar.close, entryPremium: entryPrice, qty });
        if (IS_FUT) pnlSource = "futures";
        unrealisedPnl = parseFloat(((ptState.currentBar.close - entryPrice) * (side === "CE" ? 1 : -1) * qty - _c).toFixed(2));
      }
    }
    const pos           = ptState.position;
    const optEntryLtp   = pos ? (pos.optionEntryLtp || null)                       : null;
    const optCurrentLtp = pos ? (ptState.optionLtp || pos.optionCurrentLtp || null) : null;
    const _chgPtD = (optEntryLtp && optCurrentLtp) ? getCharges({ isFutures: false, exitPremium: optCurrentLtp, entryPremium: optEntryLtp, qty: pos ? pos.qty : 0 }) : 0;
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
      prevCandleHigh:    ptState.prevCandleHigh,
      prevCandleLow:     ptState.prevCandleLow,
      consecutiveLosses: ptState._consecutiveLosses || 0,   // display only — no breaker
      maxDailyTrades:    1,
      priorTradesToday:  ptState._priorTradesToday || 0,
      sessionStart:      ptState.sessionStart,
      staleSession:      ptState._staleSession || false,
      tradeCount:        ptState.sessionTrades.length,
      wins:              ptState._sessionWins,
      losses:            ptState._sessionLosses,
      capital:           data.capital,
      totalPnl:          data.totalPnl,
      tradeRes:          TRADE_RES,
      position: pos ? {
        side:              pos.side,
        symbol:            pos.symbol,
        qty:               pos.qty,
        entryPrice:        pos.entryPrice,
        entryTime:         pos.entryTime,
        bestOptionLtp:     pos.bestOptionLtp || null,
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
      currentBar: ptState.currentBar ? {
        open:  ptState.currentBar.open,
        high:  ptState.currentBar.high,
        low:   ptState.currentBar.low,
        close: ptState.currentBar.close,
      } : null,
      // The daily-setup card (yesterday's RSI zone + today's gap + the decision)
      checklist: _setupPayload(),
      trades: _getCachedTradesForPoll(),
      logTotal: ptState.log.length,
      logs: reverseSlice(ptState.log, 100),
    });
  } catch (err) {
    console.error(`[${rt.tag}-PAPER /status/data] Error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});
router.get("/status", (req, res) => {
  try {
  const data     = loadPaperData();

  // Unrealised PnL if position is open — use OPTION LTP if available, else spot proxy (minus charges)
  const _isFutPtPg = rt.isFutures === true;   // NIFTY options only — the common INSTRUMENT toggle does not apply (the NIFTY_FUT pair: futures)
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

  // Live config — the window the tiles show is the one the engine applies.
  const _cfgPg     = _cfg();

  const inr = (n) => typeof n === "number"
    ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
  const pnlColor = (n) => n >= 0 ? "#10b981" : "#ef4444";

  const pos = ptState.position;
  const liveClose = ptState.currentBar?.close || null;
  const pointsMoved = pos && liveClose
    ? parseFloat(((liveClose - pos.entryPrice) * (pos.side === "CE" ? 1 : -1)).toFixed(2))
    : 0;

  // ATM/ITM badge
  const atmStrike = pos ? (rt.home ? Math.round(pos.entryPrice / 50) * 50 : _atmStrike(pos.entryPrice)) : null;
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
            <div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty} <span style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);">(${(pos.qty / (_lotSize() || pos.qty)).toFixed(0)} lot)</span></div>
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
        <div style="font-size:0.68rem;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">${pos.isFutures === true ? `📊 Futures Price (${pos.side === "CE" ? "LONG" : "SHORT"})` : `📊 Option Premium (${pos.optionType} Price)`}</div>
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
                : `⏳ first REST poll in ~3s<br><span style='color:#c8d8f0;'>${SPOT_LABEL} entry: ${inr(pos.entryPrice)}</span>`}
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

      <!-- Secondary grid: NIFTY spot + profit lock -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px;">
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${SPOT_LABEL} Spot @ Entry</div>
          <div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(pos.entryPrice)}</div>
          <div style="font-size:0.63rem;color:var(--muted-1,#8ba1c2);margin-top:2px;">fill · first tick after the open</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${SPOT_LABEL} LTP</div>
          <div id="ajax-nifty-ltp" style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(liveClose)}</div>
          <div id="ajax-nifty-move" style="font-size:0.63rem;color:${pointsMoved >= 0 ? "#10b981" : "#ef4444"};margin-top:2px;">${pointsMoved >= 0 ? "▲" : "▼"} ${Math.abs(pointsMoved).toFixed(1)} pts</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Profit Lock (only exit)</div>
          <div id="ajax-pl-peak" style="font-size:1.05rem;font-weight:700;color:#8b5cf6;">${pos.bestOptionLtp ? inr(pos.bestOptionLtp) : "—"}</div>
          <div style="font-size:0.63rem;color:var(--muted-1,#8ba1c2);margin-top:2px;">peak option premium · common rule</div>
        </div>
      </div>

      ${pos.reason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;">📝 ${pos.reason}</div>` : ""}
    </div>` : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:1.5rem;margin-bottom:8px;">📭</div>
      <div id="ajax-flat-banner" style="font-size:0.9rem;font-weight:600;color:#8ba1c2;margin-bottom:14px;">FLAT — ${ptState._dayDone ? "No trade today: " + (ptState._dayDoneReason || "decided") : "Waiting for the 09:15 open — oversold RSI + gap UP → CE · overbought RSI + gap DOWN → PE"}</div>
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
    /* ── DAILY SETUP CARD ── */
    .chk-card{background:#090f09;border:0.5px solid #162416;border-radius:10px;padding:12px 14px;margin:14px 0 4px;}
    .chk-grid{display:grid;grid-template-columns:minmax(56px,1.3fr) repeat(4,minmax(0,1fr));gap:4px;align-items:center;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
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
${buildSidebar(rt.sidebarKey, false, ptState.running, {
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
      <div class="top-bar-meta">Strategy: ${TITLE} · ${rt.home ? "NIFTY ATM" : (IS_FUT ? `${SPOT_LABEL} FUT` : `${SPOT_LABEL} ATM`)} · ${BROKER_LABEL} · ${TRADE_RES}-min exit candles · ${ptState.running ? 'Auto-refreshes every 2s' : 'Stopped'}</div>
    </div>
    <div class="top-bar-right">
      ${ptState.running
        ? '<span class="top-bar-badge paper-active"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>RUNNING</span>'
        : '<span class="top-bar-badge">● IDLE</span>'}
      <a href="${ROUTE}/history" style="background:rgba(59,130,246,0.08);border:0.5px solid rgba(59,130,246,0.3);color:#60a5fa;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;text-decoration:none;font-family:inherit;">📊 History</a>
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
      <div class="sc-val"><span id="ajax-trade-count">${ptState.sessionTrades.length}</span> <span style="font-size:0.75rem;color:var(--muted-1,#8ba1c2);">/ 1</span>${ptState._priorTradesToday ? ` <span style="font-size:0.62rem;color:var(--muted-1,#8ba1c2);">+${ptState._priorTradesToday} earlier</span>` : ''}</div>
      <div id="ajax-wl" style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);margin-top:4px;">${ptState._sessionWins}W &middot; ${ptState._sessionLosses}L</div>
    </div>
    <div class="sc" style="border-top:2px solid #4a6080;" id="ajax-sc-cl">
      <div class="sc-label">Loss Streak</div>
      <div class="sc-val" id="ajax-consec-losses" style="color:#fff">${ptState._consecutiveLosses || 0}</div>
      <div id="ajax-cl-status" style="font-size:0.7rem;margin-top:4px;color:#8ba1c2">info only — no breaker</div>
    </div>
    <div class="sc" style="border-top:2px solid ${ptState._dayDone ? '#f59e0b' : '#10b981'};" id="ajax-sc-dloss">
      <div class="sc-label">Today's Decision</div>
      <div class="sc-val" id="ajax-daily-loss-val" style="font-size:0.95rem;color:${ptState._dayDone ? '#f59e0b' : '#fff'}">${ptState._dayDone ? 'Decided' : 'Waiting'}</div>
      <div id="ajax-daily-loss-status" style="font-size:0.7rem;margin-top:4px;color:var(--muted-1,#8ba1c2)">${ptState._dayDone ? (ptState._dayDoneReason || '').slice(0, 60) : 'one trade per day · ' + _fmtMins(_cfgPg.ENTRY_START) + '–' + _fmtMins(_cfgPg.ENTRY_END)}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #a07010;">
      <div class="sc-label">Candles Loaded (${TRADE_RES}m)</div>
      <div class="sc-val" id="ajax-candle-count" style="color:#fff">${ptState.candles.length}</div>
      <div id="ajax-candle-status" style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);margin-top:4px;">chart only</div>
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
  <!-- Daily setup — the engine's own evaluation (engine.dailySetup + getSignal) -->
  <div class="chk-card" id="ajax-checklist-card">
    <div class="section-title" style="margin-bottom:10px;">DAILY SETUP — RSI ON EMA + GAP</div>
    <div id="ajax-checklist"></div>
  </div>
  <script id="checklist-data" type="application/json">${JSON.stringify(_setupPayload()).replace(/</g, "\\u003c")}</script>
  <script>
  function chkEsc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function renderChecklist(c){
    var el = document.getElementById('ajax-checklist');
    if (!el || !c) return;
    var st = c.setup;
    var ZONES = { OVERSOLD: ['Oversold — a gap UP buys CE', '#10b981'], OVERBOUGHT: ['Overbought — a gap DOWN buys PE', '#ef4444'], NEUTRAL: ['Neutral — no setup today', '#8ba1c2'] };
    var h = '';
    if (st) {
      var z = ZONES[st.zone] || [st.zone || '\u2014', '#8ba1c2'];
      h += '<div class="chk-piv">'
        + '<span style="color:#c0d8b0;">Prev day ' + chkEsc(st.prevDate) + '</span>'
        + '<span style="color:#a78bfa;">Close ' + chkEsc(st.prevClose) + '</span>'
        + '<span style="color:#38bdf8;">EMA' + chkEsc(c.emaLen) + ' ' + chkEsc(st.prevEma) + '</span>'
        + '<span style="color:' + z[1] + ';font-weight:700;">RSI' + chkEsc(c.rsiLen) + '(EMA) ' + chkEsc(st.prevRsi) + ' \u2014 ' + chkEsc(z[0]) + '</span>'
        + '<span style="color:#7f9b5c;">bands ' + chkEsc(c.rsiLower) + ' / ' + chkEsc(c.rsiUpper) + '</span>'
        + '</div>';
    } else {
      h += '<div class="chk-warn">' + chkEsc(c.setupError || 'Daily setup not loaded \u2014 start the session') + '</div>';
    }
    var g = c.gapPts;
    h += '<div class="chk-piv">'
      + '<span style="color:#c0d8b0;">Today\u2019s open ' + (c.todayOpen != null ? chkEsc(c.todayOpen) : '\u2014 (known after 09:15)') + '</span>'
      + (g != null ? '<span style="color:' + (g > 0 ? '#10b981' : g < 0 ? '#ef4444' : '#8ba1c2') + ';font-weight:700;">Gap ' + (g > 0 ? 'UP +' : g < 0 ? 'DOWN ' : '') + chkEsc(g) + ' pts</span>' : '')
      + '<span style="color:#7f9b5c;">window ' + chkEsc(c.window) + (c.minGap > 0 ? ' \u00b7 min gap ' + chkEsc(c.minGap) : '') + '</span>'
      + '</div>';
    if (c.todayOpenSrc) h += '<div class="chk-sub">Open source: ' + chkEsc(c.todayOpenSrc) + '</div>';
    if (c.decision && c.decision.reason) h += '<div class="chk-reason">' + chkEsc(c.decision.signal) + ' \u2014 ' + chkEsc(c.decision.reason) + '</div>';
    if (c.dayDone) h += '<div class="chk-note">Today: ' + chkEsc(c.dayDone) + '</div>';
    if (c.reference) h += '<div class="chk-sub">Reference: <a href="' + chkEsc(c.reference) + '" target="_blank" rel="noopener" style="color:#60a5fa;pointer-events:auto;">' + chkEsc(c.reference) + '</a></div>';
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
    <div class="section-title">${SPOT_LABEL} ${TRADE_RES}-MIN CHART</div>
    <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
      <div id="nifty-chart" style="width:100%;height:100%;"></div>
      <div id="chart-legend" style="position:absolute;top:10px;left:12px;right:12px;font-size:0.68rem;line-height:1.6;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;">
        <span style="color:#3b82f6;">▲ Entry</span> &nbsp;
        <span style="color:#10b981;">▼ Win</span> &nbsp;
        <span style="color:#ef4444;">▼ Loss</span> &nbsp;
        <span style="color:#a78bfa;">── Prev close</span>
      </div>
    </div>
    ${optionChart.optionChartHtml('gr-opt-chart')}
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
      <a class="copy-btn" href="${ROUTE}/download/trades.jsonl?format=ai" title="Download the full paper-trade log as an AI-friendly Markdown report (summary + field legend + table)" style="margin-left:8px;text-decoration:none;">🤖 AI export</a>
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
      ? '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--muted-1,#8ba1c2);">No trades match filters.</td></tr>'
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
      + cell('${SPOT_LABEL} Spot @ Entry', fmt(t.eSpot), '#fff', 'Index price at entry')
      + cell('Option LTP @ Entry', fmt(t.eOpt), '#60a5fa', 'Option premium paid')
      + cell('Entry Signal', t.entryReason || '—', '#a0b8d0')
      + '</div></div>';

    // ── Section: Exit ────────────────────────────────────────────────────
    const exitHtml = '<div style="background:#0c0608;border:1px solid #3a0d12;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
      + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#f87171;margin-bottom:8px;font-weight:700;">🔴 Exit</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
      + cell('Exit Time', t.exit || '—', '#c8d8f0')
      + cell('${SPOT_LABEL} Spot @ Exit', fmt(t.xSpot), '#fff', 'Index price at exit')
      + cell('Option LTP @ Exit', fmt(t.xOpt), '#60a5fa', 'Option premium at exit')
      + cell('${SPOT_LABEL} Move (pts)', pnlPts != null ? (pnlPts >= 0 ? '+' : '') + pnlPts + ' pts' : '—', pnlPts != null ? (pnlPts >= 0 ? '#10b981' : '#ef4444') : '#c8d8f0', t.side === 'PE' ? 'Entry−Exit (PE profits on fall)' : 'Exit−Entry (CE profits on rise)')
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
    var lines=['Side\\tDate\\tEntry\\tEntry Time\\tExit\\tExit Time\\tPnL\\tEntry Reason\\tExit Reason'];
    PT_ALL.forEach(function(t){
      lines.push((t.side||'')+'\\t'+ptFmtDate(t.entry)+'\\t'+(t.eSpot||'')+'\\t'+ptFmtTime(t.entry)+'\\t'+(t.xSpot||'')+'\\t'+ptFmtTime(t.exit)+'\\t'+(t.pnl!=null?t.pnl.toFixed(2):'')+'\\t'+(t.entryReason||'')+'\\t'+(t.reason||''));
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
<script src="${ROUTE}/client.js"></script>
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

  // Entry price line
  let entryLine = null;
  // Yesterday's close — the gap-fill level
  let prevCloseLine = null;

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
      const res = await fetch('${ROUTE}/status/chart-data', { cache: 'no-store' });
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
        ['markers'].forEach(function(kk){ if(d[kk]) d[kk]=_k(d[kk]); });
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

      // Markers (entries & exits)
      if (d.markers && d.markers.length > 0) {
        var sorted = d.markers.slice().sort(function(a, b) { return a.time - b.time; });
        candleSeries.setMarkers(sorted.map(function(m) {
          return { time: m.time, position: m.position, color: m.color, shape: m.shape, text: m.text };
        }));
      } else {
        candleSeries.setMarkers([]);
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

      // Yesterday's close — the gap-fill level.
      if (prevCloseLine) { try { candleSeries.removePriceLine(prevCloseLine); } catch(_) {} prevCloseLine = null; }
      if (d.prevClose != null) {
        prevCloseLine = candleSeries.createPriceLine({ price: d.prevClose, color: '#a78bfa', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: true, title: 'Prev close' });
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
${optionChart.optionChartScript({ dataUrl: ROUTE + '/status/chart-data', id: 'gr-opt-chart' })}
<script>
// ── AJAX live refresh — replaces meta http-equiv="refresh" ──────────────────
// Polls /gap_runaway-paper/status/data every 2 s when trading is active.
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
      const res = await fetch('${ROUTE}/status/data', { cache: 'no-store' });
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

      // Today's-decision card (one trade per day)
      const dlCard = document.getElementById('ajax-sc-dloss');
      const dlVal = document.getElementById('ajax-daily-loss-val');
      const dlStatus = document.getElementById('ajax-daily-loss-status');
      const dDone = d.checklist && d.checklist.dayDone;
      if (dlCard) dlCard.style.borderTopColor = dDone ? '#f59e0b' : '#10b981';
      if (dlVal) { dlVal.textContent = dDone ? 'Decided' : 'Waiting'; dlVal.style.color = dDone ? '#f59e0b' : '#fff'; }
      if (dlStatus) dlStatus.textContent = dDone ? String(dDone).slice(0, 60) : ('one trade per day \u00b7 ' + ((d.checklist && d.checklist.window) || ''));

      const candleEl = document.getElementById('ajax-candle-count');
      if (candleEl) candleEl.textContent = String(d.candleCount);

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

      // Daily-setup card — re-rendered from the server's engine state
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
        // Profit lock card — the peak option premium the lock trails from
        const plEl = document.getElementById('ajax-pl-peak');
        if (plEl) plEl.textContent = p.bestOptionLtp ? INR(p.bestOptionLtp) : '\u2014';
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
 * GET /gap_runaway-paper/history
 * All past paper trade sessions with summary stats
 */
router.get("/history", (req, res) => {
  const data = loadPaperData();
  res.setHeader("Content-Type", "text/html");
  res.send(renderHistoryPage({
    routePrefix: ROUTE,
    sidebarKey: rt.historySidebarKey,
    pageTitle: rt.home ? "📉 GAP_runAway__Kirubakaran Paper Trade History" : `📉 ${TITLE} Paper Trade History`,
    pageDocTitle: rt.home ? "GAP_runAway__Kirubakaran Paper — History" : `${TITLE} Paper — History`,
    modalLabel: rt.home ? "GAP_runAway__Kirubakaran Paper" : `${TITLE} Paper`,
    sessions: data.sessions || [],
    capital: data.capital,
    totalPnl: data.totalPnl,
    startCap: getCapitalFromEnv(),
    emptyLabel: rt.home ? "Start GAP_runAway__Kirubakaran paper trading to record your first session." : `Start ${TITLE} paper trading to record your first session.`,
    // GAP_RUNAWAY trades through Zerodha — contract notes use the Kite (default) rates,
    // not the Fyers schedule the route-prefix lookup would pick.
    contractRow: (t) => require("../utils/contractNote").contractRow(t, rt.home ? undefined : BROKER),
  }));
});

/**
 * GET /gap_runaway-paper/download/trades.jsonl
 * Stream the crash-safe per-trade JSONL log as a file download.
 */
router.get("/download/trades.jsonl", (req, res) => {
  const logPath = tradeLogger.filePathFor(MODE);
  const today   = new Date().toISOString().slice(0, 10);
  const dlName  = `${MODE}_paper_trades_log_${today}.txt`;
  const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
  if (ai) {
    let text = ""; try { text = fs.readFileSync(logPath, "utf8"); } catch (_) {}
    const md = aiExport.jsonlToMarkdown(text, { title: `${ACTIVE} paper trades (full log)`, source: OWNER });
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${MODE}_paper_trades_AI_${today}.md"`);
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
  const skips  = skipLogger.listDates(MODE);
  const trades = tradeLogger.listDailyDates(MODE);
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
  const dlName = `${MODE}_paper_skips_all_${today}.txt`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${dlName}"`);
  const dates = skipLogger.listDates(MODE).map(d => d.date).sort();
  let body = "";
  for (const d of dates) {
    try {
      const p = skipLogger.filePathFor(MODE, d);
      if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8");
    } catch (_) {}
  }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `${MODE}_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `${MODE}_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

/**
 * GET /gap_runaway-paper/reset
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
  require("../utils/paperReset").clearTodayFiles(MODE); // else restart rehydrates today's session
  capitalPool.sessionSaved(MODE);

  log(`🔄 Paper trade data reset. Capital restored to ₹${freshCapital.toLocaleString("en-IN")}`);

  return res.json({
    success: true,
    message: `Paper trade history cleared. Capital reset to ₹${freshCapital.toLocaleString("en-IN")}`,
  });
});

/**
 * DELETE /gap_runaway-paper/session/:index
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
  const allTrades = tradeLogger.readDailyTrades(MODE, date).filter(t => t && !t.type);
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
    instrument:  missing[0]?.instrument || TRADED_AS(),
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
  log(`♻️ Restored paper session for ${date}: ${missing.length} trade(s), PnL ₹${sessionPnl}`);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

/**
 * GET /gap_runaway-paper/debug
 * Returns current state info to help diagnose why Start/Reset isn't working
 */
router.get("/debug", (req, res) => {
  const ls = ptState.lastSignal;
  res.json({
    running:              ptState.running,
    hasAccessToken:       !!process.env.ACCESS_TOKEN,
    hasAppId:             !!process.env.APP_ID,
    liveTradeActive:      rt.socketSlot.isActive(),
    activeStrategy:       ACTIVE,
    tradeResolution:      TRADE_RES,
    candlesLoaded:        ptState.candles.length,
    setup:                ptState.setup,
    setupError:           ptState._setupError,
    todayOpen:            ptState.todayOpen,
    todayOpenSrc:         ptState.todayOpenSrc,
    dayDone:              ptState._dayDone ? ptState._dayDoneReason : null,
    lastSignal:           ls ? { signal: ls.signal, reason: ls.reason } : null,
    entryAttempts:        ptState._entryAttempts || 0,
    position:             ptState.position ? { side: ptState.position.side, entryPrice: ptState.position.entryPrice, optionEntryLtp: ptState.position.optionEntryLtp, bestOptionLtp: ptState.position.bestOptionLtp } : null,
    capital:              loadPaperData().capital,
    sessionPnl:           ptState.sessionPnl,
    isMarketHours:        isMarketHours(),
  });
});



/**
 * GET /gap_runaway-paper/client.js
 * Serves the paper trade UI JavaScript as a static file.
 * Keeping it separate prevents ANY data injection from breaking the buttons.
 */
router.get("/client.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-cache");
  res.send(`async function handleStart(btn) {
  if (btn) { btn.textContent = '⏳ Starting...'; btn.disabled = true; }
  try {
    const res = await secretFetch('${ROUTE}/start');
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
    const res = await secretFetch('${ROUTE}/stop');
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
    const res = await secretFetch('${ROUTE}/reset');
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
  var header = ['Side','Symbol','Entry Time','Exit Time','Entry ${SPOT_LABEL}','Entry Option','Exit ${SPOT_LABEL}','Exit Option','PnL','Exit Reason'];
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
  a.download = '${MODE}_paper_trades_' + d + '.csv';
  a.click();
  showToast('✅ CSV downloaded — ' + PT.length + ' trades', '#10b981');
}
async function ptHandleExit(btn) {
  if (btn) { btn.textContent = '⏳ Exiting...'; btn.disabled = true; }
  try {
    const res = await secretFetch('${ROUTE}/exit');
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
    const res = await secretFetch('${ROUTE}/manualEntry', {
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
 * gracefulShutdown on SIGTERM / auto-deploy, so an open paper position
 * is squared off on a deploy/restart. Idempotent: no-op if not running.
 */
function stopSession(reason = "Shutdown square-off") {
  if (!ptState.running) return;
  try {
    if (ptState.position && (ptState.lastTickPrice || ptState.currentBar)) {
      const _px = ptState.lastTickPrice || ptState.currentBar.close;
      simulateSell(_px, reason, _px);
    }
  } catch (e) { try { log(`⚠️ [PAPER] stopSession squareoff error: ${e.message}`); } catch (_) {} }
  try { stopOptionPolling(); } catch (_) {}
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  rt.socketSlot.clear();
  socketManager.removeCallback(SOCKET_CALLBACK_ID);
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) {
    socketManager.stop();
  }
  ptState.running = false;
  try { saveSession(); } catch (_) {}
}
router.stopSession = stopSession;
router.pairRuntime = rt;
return router;
}   // ── end create(pair) ──

// One instance per pair, built on first use — the NIFTY one at load.
const _instances = new Map();
function forPairInstance(p) {
  if (!p) return null;
  if (!_instances.has(p.id)) _instances.set(p.id, create(p));
  return _instances.get(p.id);
}
/** The router of this strategy on `marketKey` ("BANKNIFTY", "SENSEX", …), or null when not offered. */
function forMarket(marketKey) { return forPairInstance(pairs.get("gapRunaway", marketKey)); }

const home = forMarket("NIFTY");
home.create    = create;
home.forMarket = forMarket;
home.forPair   = forPairInstance;
module.exports = home;

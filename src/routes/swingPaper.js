/**
 * PAPER TRADE — /swing-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses LIVE market data (Fyers WebSocket) but SIMULATES orders locally.
 * NO real orders are placed. Everything is tracked in memory + saved to disk.
 *
 * Flow:
 *   /swing-paper/start  → connects to live socket, starts simulating trades
 *   /swing-paper/stop   → stops socket, saves final session summary
 *   /swing-paper/status → live view: position, PnL, capital, log
 *   /swing-paper/history → all past paper trade sessions
 *   /swing-paper/reset  → wipe paper trade history & reset capital
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { getActiveStrategy, ACTIVE } = require("../strategies");
const instrumentConfig = require("../config/instrument");
const { getSymbol, getLotQty, validateAndGetOptionSymbol } = instrumentConfig;
const sharedSocketState = require("../utils/sharedSocketState");
const socketManager = require("../utils/socketManager"); // ← robust socket wrapper
const tickRecorder  = require("../utils/tickRecorder");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, toastJS, logViewerHTML, faviconLink, modalCSS, modalJS, tableEnhancerCSS, tableEnhancerJS } = require("../utils/sharedNav");
const { dailyFilesPaginate, renderHistoryPage } = require("../utils/paperHistoryUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter = require("../services/vixFilter");
const tradeLogger = require("../utils/tradeLogger");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const { getCharges } = require("../utils/charges");
const tradeGuards = require("../utils/tradeGuards");
const { logNearMiss } = require("../utils/nearMissLog");
const skipLogger = require("../utils/skipLogger");
const tickSimulator = require("../services/tickSimulator");
const { EMA, PSAR } = require("technicalindicators");

// ── Module-level config (re-read at /start so Settings UI / replay env overrides take effect) ──
// Declared with `let` so _refreshConfig() can update them. Without this, the
// replay engine's _applySettingsOverride() and the Settings UI's mid-session
// process.env mutations would never reach the running strategy code.
let TRADE_RES;            // candle resolution in minutes
let _MAX_DAILY_TRADES;
let _MAX_DAILY_LOSS;
let _OPT_STOP_PCT;
let _SWING_STRONG_ONLY;
let _STOP_MINS;
let _SWING_SL_PAUSE_CANDLES;   // same-side cooldown (candles) after an SL hit
let _SWING_EOD_EXIT_MINS;      // square off any open SWING position at/after this IST time (before day close)
function _refreshConfig() {
  TRADE_RES                              = parseInt(process.env.TRADE_RESOLUTION || "5", 10);
  _MAX_DAILY_TRADES                      = parseInt(process.env.MAX_DAILY_TRADES || "20", 10);
  _MAX_DAILY_LOSS                        = parseFloat(process.env.MAX_DAILY_LOSS || "5000");
  _OPT_STOP_PCT                          = parseFloat(process.env.OPT_STOP_PCT || "0.15");
  _SWING_STRONG_ONLY                     = (process.env.SWING_STRONG_ONLY || "false").toLowerCase() === "true";
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  _STOP_MINS = h * 60 + (isNaN(m) ? 0 : m);
  _SWING_SL_PAUSE_CANDLES = parseInt(process.env.SWING_SL_PAUSE_CANDLES || "3", 10);
  // Exit-before-close: square off open position at this IST time (default 15:15),
  // ahead of the TRADE_STOP_TIME auto-stop. Blank/invalid → fall back to _STOP_MINS.
  const _eodRaw = process.env.SWING_EOD_EXIT_TIME || "15:15";
  const [eh, em] = _eodRaw.split(":").map(Number);
  _SWING_EOD_EXIT_MINS = (isNaN(eh)) ? _STOP_MINS : (eh * 60 + (isNaN(em) ? 0 : em));
}
_refreshConfig();
let _cachedClosedCandleSL = null; // SAR SL from last FULLY CLOSED candle — updated in onCandleClose, used in every tick

// ── Same-side SL cooldown ───────────────────────────────────────────────────
// After an SL hit (price SL or option stop), block new entries on THAT side for
// SWING_SL_PAUSE_CANDLES candles. Mirrors SCALP's per-side pause.
function _setSlPause(side) {
  if (!_SWING_SL_PAUSE_CANDLES || _SWING_SL_PAUSE_CANDLES <= 0) return;
  ptState._slPauseUntilBySide = ptState._slPauseUntilBySide || { CE: 0, PE: 0 };
  ptState._slPauseUntilBySide[side] = simNow() + _SWING_SL_PAUSE_CANDLES * getTradeResolution() * 60 * 1000;
  log(`⏸️ [PAPER] ${side} SL cooldown — no new ${side} entries for ${_SWING_SL_PAUSE_CANDLES} candles`);
}

// _STOP_MINS declared and populated by _refreshConfig() above

// ── isMarketHours() cache (60-second TTL) ────────────────────────────────────
// Called on every NIFTY tick (100-200/min). Creates a Date object each call.
// Cache for 60 seconds — market hours don't change tick-to-tick.
let _mktHoursCache   = null;
let _mktHoursCacheTs = 0;

// ── Persistence ──────────────────────────────────────────────────────────────
// Data stored at ~/trading-data/ — OUTSIDE the project directory.
// This path survives git pull, npm install, and full redeploys.
// Old path was ./data/ inside project — wiped on every deploy.
const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "paper_trades.json");

// One-time silent migration: copy old ./data/paper_trades.json to new path on first boot.
const _OLD_PT_FILE = path.join(__dirname, "../../data/paper_trades.json");
(function migrateOnce() {
  try {
    if (!fs.existsSync(PT_FILE) && fs.existsSync(_OLD_PT_FILE)) {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(_OLD_PT_FILE, PT_FILE);
      console.log("[paperTrade] Migrated paper_trades.json to ~/trading-data/ (deploy-safe)");
    }
  } catch (e) {
    console.warn("[paperTrade] Migration check failed:", e.message);
  }
})();

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
    console.error("[paperTrade] paper_trades.json corrupt — resetting:", e.message);
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
  prevCandleMid:  null,
  // Option LTP tracking
  optionLtp:     null,
  optionSymbol:  null,
  // SL-hit guard: block re-entry on the same candle where SL was hit
  _slHitCandleTime: null,
  // 50%-rule exit pause: after a 50%-rule exit, block re-entry for 2 candles (30 min on 15-min)
  // Logic: 50% rule fired = price immediately reversed after entry = market is choppy
  // Don't fight the same choppy conditions — wait 2 candles for market to settle.
  _fiftyPctPauseUntil: null,  // epoch ms — set on 50%-rule exit, checked before every entry
  // Consecutive loss circuit breaker
  _consecutiveLosses: 0,
  _pauseUntilTime: null,    // epoch ms — block new entries until this time
  // Daily loss kill switch — latched true when session loss >= MAX_DAILY_LOSS (₹)
  // Blocks ALL new entries for the rest of the day. Resets only on session restart.
  _dailyLossHit: false,
  // NOTE: socket is now managed by socketManager — no ptState.socket needed
  // Pre-fetched option symbols (populated after each candle close, used at entry)
  _cachedCE: null,
  _cachedPE: null,
  // Intra-candle entry throttle for 15-min: only re-run getSignal when bar high/low
  // actually changes — avoids running the full indicator stack on every single tick.
  _lastCheckedBarHigh: null,
  _lastCheckedBarLow:  null,
  _missedLoggedCandle: null,  // throttle for signal-missed log (once per candle)
  _maxTradesLoggedCandle: null, // throttle for max-trades log (once per candle)
  _vixBlockLoggedCandle:  null, // throttle for VIX block log (once per candle)
  _entryPending:      false, // prevents double-entry on rapid ticks
  _expiryDayBlocked:  false, // blocks entries on non-expiry days
  _simMode:           false, // simulation mode (fake ticks, no broker)
  _simScenario:       null,  // active scenario name
  // Win/loss counters: maintained in simulateSell so /status/data doesn't filter on every poll
  _sessionWins:   0,
  _sessionLosses: 0,
};

// ── Simulation clock ────────────────────────────────────────────────────────
let _simClockMs = 0;
function simNow() { return ptState._simMode ? _simClockMs : Date.now(); }

// ── Helpers ──────────────────────────────────────────────────────────────────

// Fast IST timestamp — avoids expensive toLocaleString/ICU on every log call
function istNow() {
  const ist = new Date(simNow() + 19800000);
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

function getTradeResolution() { return TRADE_RES; } // kept for legacy callers; prefer TRADE_RES directly

function getMinBucket(unixMs) {
  // Pure integer math — avoids Date object allocation on every tick (150+/min).
  // Floor to nearest TRADE_RES-minute boundary in IST.
  const resMs = TRADE_RES * 60_000;
  return Math.floor(unixMs / resMs) * resMs;
}

// Keep legacy alias used in onTick
function get5MinBucket(unixMs) { return getMinBucket(unixMs); }

// ── Time helpers (all times configurable via .env) ───────────────────────────
// TRADE_START_TIME : when entry is first allowed  (default "09:15")
// TRADE_STOP_TIME  : auto-stop + last-entry cutoff (default "15:30")
// No lower bound on start — start the bot at 8:00, 7:00, or any time before market
// to pre-load history. Trade execution is gated separately by isMarketHours().
//
// .env example:
//   TRADE_START_TIME=09:15
//   TRADE_STOP_TIME=15:30

function parseMins(envKey, defaultVal) {
  const raw = process.env[envKey] || defaultVal;
  const [h, m] = raw.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
}

// ── Fast IST minutes helper ───────────────────────────────────────────────────
// toLocaleString("en-US", {timeZone:"Asia/Kolkata"}) is expensive — it invokes
// V8's ICU timezone library. At 150 ticks/min this adds up significantly on t2.micro.
// Fix: IST = UTC + 5:30 (19800 seconds). Simple integer arithmetic, zero allocations.
function getISTMinutes() {
  const utcSec = Math.floor(Date.now() / 1000);
  const istSec = utcSec + 19800; // UTC+5:30
  const istMin = Math.floor(istSec / 60);
  return (istMin % 1440); // minutes since midnight IST (0–1439)
}

// Cached start/stop mins — read from env ONCE at module load, never again
const _START_MINS = parseMins("TRADE_START_TIME", "09:15");
// _STOP_MINS already defined above (for EOD candle close)
// Stop gate is STOP_MINS - 10 to avoid orphaned positions near close
const _ENTRY_STOP_MINS = _STOP_MINS - 10;

// Trade EXECUTION gate: cached 60s TTL, uses fast integer IST calc
function isMarketHours() {
  if (ptState._simMode) return true; // always "in hours" during simulation
  const now = Date.now();
  if (now - _mktHoursCacheTs < 60_000) return _mktHoursCache;
  const total = getISTMinutes();
  _mktHoursCache   = total >= _START_MINS && total < _ENTRY_STOP_MINS;
  _mktHoursCacheTs = now;
  return _mktHoursCache;
}

// START gate: allow any time before TRADE_STOP_TIME
function isStartAllowed() {
  return getISTMinutes() < _STOP_MINS;
}

// ── Auto-stop timer handle (cleared on manual stop) ─────────────────────────────
let _autoStopTimer = null;

// Schedule auto-stop at TRADE_STOP_TIME (default 15:30 IST).
// Set TRADE_STOP_TIME=HH:MM in .env to override.
function scheduleAutoStop(stopFn) {
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  const stopMins = _STOP_MINS; // cached at module load — no env read
  const stopH    = Math.floor(stopMins / 60);
  const stopM    = stopMins % 60;
  const stopLabel = String(stopH).padStart(2,"0") + ":" + String(stopM).padStart(2,"0") + " IST";

  const now    = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const stopAt = new Date(now);
  stopAt.setHours(stopH, stopM, 0, 0);
  const msUntilStop = stopAt - now;
  if (msUntilStop <= 0) return; // already past stop time today
  _autoStopTimer = setTimeout(() => {
    if (!ptState.running) return;
    stopFn("⏰ [PAPER] Auto-stop: " + stopLabel + " reached — closing session.");
  }, msUntilStop);
  const minUntil = Math.round(msUntilStop / 60000);
  log("⏰ [PAPER] Auto-stop scheduled in " + minUntil + " min (at " + stopLabel + ")");
}

function getCapitalFromEnv() {
  // Swing trades through Zerodha — its paper capital is the shared Zerodha investment pool.
  return parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000");
}

// ── 0DTE expiry-day detector ─────────────────────────────────────────────────
// Swing on 0DTE = bad idea (theta+gamma crush 15-min hold times). Used by
// /start to block the user with a warning unless ?force=1 is passed.
function _getEffectiveSwingExpiry() {
  const swing  = (process.env.SWING_OPTION_EXPIRY_OVERRIDE || "").trim();
  const common = (process.env.OPTION_EXPIRY_OVERRIDE || "").trim();
  return swing || common || null;
}
function _getISTDateStr() {
  const ist = new Date(Date.now() + 19800000);
  return ist.toISOString().slice(0, 10);
}
function isSwingExpiringToday() {
  const expiry = _getEffectiveSwingExpiry();
  return expiry && expiry === _getISTDateStr();
}

// ── Option LTP via REST polling ──────────────────────────────────────────────
// ONE permanent socket → NIFTY spot only. Never reconnected.
// Option LTP fetched via Fyers REST getQuotes() every 3 seconds while in trade.
// This avoids ALL Fyers singleton reconnect issues permanently.

const fyers = require('../config/fyers');
const { notifyEntry, notifyExit, notifyStarted, notifySignal, notifyDayReport, sendTelegram, canSend, isConfigured } = require('../utils/notify');
const NIFTY_INDEX_SYMBOL = 'NSE:NIFTY50-INDEX';

// ── Pre-fetch option symbols in background after each candle close ──────────
async function prefetchOptionSymbols(spot) {
  if (instrumentConfig.INSTRUMENT === 'NIFTY_FUTURES') return;
  try {
    const [ce, pe] = await Promise.all([
      validateAndGetOptionSymbol(spot, 'CE', 'swing'),
      validateAndGetOptionSymbol(spot, 'PE', 'swing'),
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
let _rateLimitSkipCycles = 0; // skip N poll cycles after a rate-limit hit

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
        try { tickRecorder.recordOptionLtp(symbol, _ltp, "swing-paper"); } catch (_) {}
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

// ── Option LTP poll tick — shared logic used by immediate fetch + recurring loop ──
async function _optionPollTick(symbol) {
  if (_optionPollBusy) return; // skip if previous call still in flight
  if (_rateLimitSkipCycles > 0) { _rateLimitSkipCycles--; return; }
  _optionPollBusy = true;
  try {
    if (!ptState.position || !ptState.optionSymbol) { stopOptionPolling(); return; }
    const ltp = await fetchOptionLtp(symbol);
    if (!ltp) return;
    ptState.optionLtp = ltp;
    if (!ptState.position) return; // position may have closed while we awaited
    ptState.position.optionCurrentLtp = ltp;
    if (!ptState.position.optionEntryLtp) {
      ptState.position.optionEntryLtp = ltp;
      ptState.position.optionEntryLtpTime = istNow();
      log(`📌 [PAPER] Option entry LTP: ₹${ltp} (SPOT @ ₹${ptState.position.spotAtEntry} | SL: ₹${ptState.position.stopLoss})`);
    }

    // ── Option LTP stop — 50% mid DISABLED — breakeven stop handles protection ──
    // Previously: if option premium dropped below 50% mid threshold, force exit.
    // Now: breakeven at +25pt moves SL to entry, trail handles everything else.
  } finally {
    _optionPollBusy = false;
  }
}

function startOptionPolling(symbol) {
  stopOptionPolling(); // clear any previous
  _optionPollBusy = false;

  // ── Recursive setTimeout loop (replaces setInterval) ──────────────────────
  // setInterval fires regardless of whether the previous async call has resolved.
  // If getQuotes() takes >1s (slow network), calls accumulate and pile up.
  // setTimeout-chaining guarantees exactly 1s gap BETWEEN calls, not 1s PERIOD.
  function scheduleNext() {
    if (!_optionPollTimer) return; // polling was stopped
    _optionPollTimer = setTimeout(async () => {
      await _optionPollTick(symbol);
      scheduleNext(); // reschedule only after this call finishes
    }, 1000);
  }

  // Kick off with an immediate tick, then start the loop
  _optionPollTick(symbol).then(scheduleNext);

  // Mark polling as active (non-null timer signals "running" to stopOptionPolling)
  _optionPollTimer = true; // placeholder until first setTimeout fires

  // ── 10s timeout: if option LTP still null, use spot as proxy entry LTP ──
  setTimeout(() => {
    if (ptState.position && !ptState.position.optionEntryLtp && ptState.lastTickPrice) {
      const proxy = ptState.lastTickPrice;
      ptState.position.optionEntryLtp = proxy;
      ptState.position.optionEntryLtpTime = istNow();
      log(`⚠️ [PAPER] Option LTP timeout — using spot ₹${proxy} as proxy entry LTP`);
    }
  }, 10000);
}

function stopOptionPolling() {
  if (_optionPollTimer && _optionPollTimer !== true) {
    clearTimeout(_optionPollTimer);
  }
  _optionPollTimer = null;
  _optionPollBusy  = false;
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

function simulateBuy(symbol, side, qty, price, reason, stopLoss, spotAtEntry, isIntraCandle = false, entryMeta = {}) {
  // Guard: never overwrite an existing position (catches async race between candle-close
  // fallback and intra-tick entry both resolving at the same time)
  if (ptState.position) {
    log(`⚠️ [PAPER] simulateBuy called while position already open — ignoring duplicate entry (${side} @ ₹${price})`);
    return;
  }
  // Same-side SL cooldown: reject re-entry on a side that recently hit SL/option-stop.
  if (ptState._slPauseUntilBySide && ptState._slPauseUntilBySide[side] > simNow()) {
    log(`⏸️ [PAPER] ${side} SL cooldown active — entry rejected (${side} @ ₹${price})`);
    ptState._entryPending = false;
    return;
  }
  const optDetails = parseOptionDetails(symbol);

  // Capture the prev-candle reference at entry time — tick exit rule uses this FIXED value forever.
  // Relaxed from 50% mid to 35%/65% — gives ~40% more room before exit fires.
  // CE: 35% from low (exit level lower → more room above). PE: 65% from low (exit level higher → more room below).
  // IMPORTANT: this value must NEVER be updated after entry — it is the fixed reference.
  const _lastCandle = ptState.candles.length >= 1 ? ptState.candles[ptState.candles.length - 1] : null;
  const entryPrevMid = _lastCandle
    ? parseFloat((_lastCandle.low + (_lastCandle.high - _lastCandle.low) * (side === "CE" ? 0.35 : 0.65)).toFixed(2))
    : null;

  // 50% entry gate REMOVED — replaced by breakeven stop at +25pt
  const _entrySpot = spotAtEntry || price;

  // ── INITIAL SL (SWING redefined) ──────────────────────────────────────────
  // The stop passed in IS the previous-candle low (CE) / high (PE) from getSignal.
  // Used as-is; the execution layer trails it candle-by-candle from here.
  const _origSAR_SL = stopLoss;
  let _capLog = null;

  // Data-collection metadata — frozen at entry so the trade record is self-describing for offline analysis.
  const _entryIstMin     = Math.floor((Math.floor(simNow() / 1000) + 19800) / 60) % 1440;
  const _entryHourIST    = Math.floor(_entryIstMin / 60);
  const _entryMinuteIST  = _entryIstMin % 60;
  const _vixAtEntry      = getCachedVix();
  const _signalStrength  = entryMeta.signalStrength || null;

  ptState.position = {
    side,
    symbol,
    qty,
    entryPrice:        price,          // NIFTY spot at candle close
    spotAtEntry:       _entrySpot,
    entryTime:         istNow(),
    reason,
    stopLoss:          stopLoss || null,
    initialStopLoss:   stopLoss || null,
    sarStopLoss:       _origSAR_SL || null,   // initial SL (prev-candle) at entry, for analysis
    entryPrevMid:      entryPrevMid,   // mid of candle BEFORE entry (retained for trade-record continuity)
    entryBarTime:      ptState.currentBar ? ptState.currentBar.time : (ptState.candles.length ? ptState.candles[ptState.candles.length - 1].time : null),
    bestPrice:         null,
    candlesHeld:       0,
    // Max favorable / adverse excursion in spot pts — tracked per-tick for post-window analysis.
    mfeSpotPts:        0,
    maeSpotPts:        0,
    // Entry wall-clock (simNow) + seconds to the favourable peak / adverse trough.
    entryTimeMs:       simNow(),
    secsToMFE:         0,
    secsToMAE:         0,
    // Option metadata
    optionExpiry:      optDetails?.expiry     || null,
    optionStrike:      optDetails?.strike     || null,
    optionType:        optDetails?.optionType || side,
    // Option premium tracking
    optionEntryLtp:    ptState.optionLtp || null,  // premium at entry (if already subscribed)
    optionCurrentLtp:  ptState.optionLtp || null,  // updated on each option tick
    // Data-collection fields — surfaced on the trade record in simulateSell()
    signalStrength:    _signalStrength,
    vixAtEntry:        _vixAtEntry,
    entryHourIST:      _entryHourIST,
    entryMinuteIST:    _entryMinuteIST,
    // Entry-context diagnostics — already computed by getSignal(), captured for analysis.
    rsiAtEntry:        entryMeta.rsiAtEntry  != null ? entryMeta.rsiAtEntry  : null,
    ema9AtEntry:       entryMeta.ema9AtEntry != null ? entryMeta.ema9AtEntry : null,
    ema9Slope:         entryMeta.ema9Slope   != null ? entryMeta.ema9Slope   : null,
    sarAtEntry:        entryMeta.sarAtEntry  != null ? entryMeta.sarAtEntry  : null,
    sarTrend:          entryMeta.sarTrend    || null,
    adxAtEntry:        entryMeta.adxAtEntry  != null ? entryMeta.adxAtEntry  : null,
    adxTrending:       entryMeta.adxTrending != null ? entryMeta.adxTrending : null,
  };

  // Set option symbol and start REST polling (no socket changes)
  // Skip option polling for futures and simulation mode — no option premium to track
  ptState.optionSymbol = symbol;
  if (ptState._simMode) {
    log(`📊 [PAPER] Simulation mode — skipping option LTP polling`);
  } else if (instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES") {
    log(`📊 [PAPER] Starting option LTP polling (REST/3s): ${symbol}`);
    startOptionPolling(symbol);
  } else {
    log(`📊 [PAPER] Futures mode — skipping option LTP polling`);
  }

  const slText = stopLoss ? ` | SL: ₹${stopLoss}` : "";
  log(`📝 [PAPER] BUY ${qty} × ${symbol} @ SPOT ₹${price}${slText} | Opt: capturing… | Reason: ${reason}`);
  if (_capLog) log(_capLog);
  if (entryPrevMid !== null) {
    // log(`📐 [PAPER] 50% rule ref fixed: prev candle mid = ₹${entryPrevMid} (exit if ${side}=PE: spot > ₹${entryPrevMid} | CE: spot < ₹${entryPrevMid})`);
  }

  // ── Telegram notification (skip in simulation mode) ───────────────────────
  if (!ptState._simMode) {
    notifyEntry({
      mode:           'PAPER',
      side,
      symbol,
      strike:         ptState.position.optionStrike,
      expiry:         ptState.position.optionExpiry,
      spotAtEntry:    price,
      optionEntryLtp: ptState.optionLtp || null,
      stopLoss:       stopLoss || null,
      qty,
      reason,
    });
  }
}

function simulateSell(exitPrice, reason, spotAtExit) {
  if (!ptState.position) return;

  const { side, symbol, qty, entryPrice, entryTime, spotAtEntry,
          optionEntryLtp, optionCurrentLtp,
          signalStrength, vixAtEntry, entryHourIST, entryMinuteIST } = ptState.position;

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
  } else if (ptState._simMode) {
    // Sim mode: no real option LTP — use delta approximation like backtest
    const DELTA = parseFloat(process.env.BACKTEST_DELTA || "0.55");
    const spotMove = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1);
    rawPnl  = spotMove * DELTA * qty;
    pnlMode = `sim delta(${DELTA})`;
  } else {
    // Options fallback: spot movement proxy
    rawPnl  = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
    pnlMode = `spot proxy (option LTP unavailable)`;
  }

  // Charges: STT + exchange + GST + stamp duty + brokerage (configurable via Settings)
  const charges = getCharges({ isFutures, exitPremium: exitOptionLtp, entryPremium: optionEntryLtp, qty });
  const netPnl  = parseFloat((rawPnl - charges).toFixed(2));

  // Derived metadata for the trade record — computed here so the JSONL log captures the full picture.
  const _entryBarMs    = ptState.position.entryBarTime ? ptState.position.entryBarTime * 1000 : null;
  const _exitBarMs     = ptState.currentBar ? ptState.currentBar.time * 1000 : null;
  const _durationMs    = (_entryBarMs && _exitBarMs) ? (_exitBarMs - _entryBarMs) : null;
  const _pnlPoints     = parseFloat(((exitPrice - entryPrice) * (side === "CE" ? 1 : -1)).toFixed(2));
  const _isManualEntry = typeof ptState.position.reason === "string" && /Manual/i.test(ptState.position.reason);

  const trade = {
    side,
    symbol,
    qty,
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
    entryReason:      ptState.position.reason,
    stopLoss:         ptState.position.stopLoss,        // final SL at exit (may be trailed)
    optionExpiry:     ptState.position.optionExpiry || null,
    optionStrike:     ptState.position.optionStrike || null,
    optionType:       ptState.position.optionType   || side,
    // Bar timestamps for chart markers
    entryBarTime:     ptState.position.entryBarTime || (ptState.currentBar ? ptState.currentBar.time : null),
    exitBarTime:      ptState.currentBar ? ptState.currentBar.time : null,
    // Data-collection fields (captured at entry — see simulateBuy)
    signalStrength:   signalStrength   || null,
    vixAtEntry:       vixAtEntry       != null ? vixAtEntry       : null,
    entryHourIST:     entryHourIST     != null ? entryHourIST     : null,
    entryMinuteIST:   entryMinuteIST   != null ? entryMinuteIST   : null,
    // Full-detail capture for JSONL (also surfaced in-memory for future analytics)
    initialStopLoss:  ptState.position.initialStopLoss  || null,
    sarStopLoss:      ptState.position.sarStopLoss      || null,   // raw SAR-based SL before hybrid cap (for analysis)
    trailActivatePts: ptState.position.trailActivatePts || null,
    entryPrevMid:     ptState.position.entryPrevMid     || null,   // 50%-rule reference
    bestPrice:        ptState.position.bestPrice        || null,   // peak favorable price during trade
    candlesHeld:      ptState.position.candlesHeld      || 0,
    // Entry-context diagnostics + excursion + exit VIX for post-window analysis.
    rsiAtEntry:       ptState.position.rsiAtEntry   != null ? ptState.position.rsiAtEntry   : null,
    ema9AtEntry:      ptState.position.ema9AtEntry  != null ? ptState.position.ema9AtEntry  : null,
    ema9Slope:        ptState.position.ema9Slope    != null ? ptState.position.ema9Slope    : null,
    sarAtEntry:       ptState.position.sarAtEntry   != null ? ptState.position.sarAtEntry   : null,
    sarTrend:         ptState.position.sarTrend     || null,
    adxAtEntry:       ptState.position.adxAtEntry   != null ? ptState.position.adxAtEntry   : null,
    adxTrending:      ptState.position.adxTrending  != null ? ptState.position.adxTrending  : null,
    mfeSpotPts:       ptState.position.mfeSpotPts   || 0,
    maeSpotPts:       ptState.position.maeSpotPts   || 0,
    secsToMFE:        ptState.position.secsToMFE    || 0,
    secsToMAE:        ptState.position.secsToMAE    || 0,
    vixAtExit:        getCachedVix(),
    durationMs:       _durationMs,
    pnlPoints:        _pnlPoints,
    charges:          charges,
    isFutures:        isFutures,
    isManual:         _isManualEntry,
    instrument:       INSTR,
  };

  ptState.sessionTrades.push(trade);
  tradeLogger.appendTradeLog("swing", trade); // crash-safe per-trade JSONL
  ptState.sessionPnl = parseFloat((ptState.sessionPnl + netPnl).toFixed(2));
  // Maintain O(1) counters so status endpoints don't need Array.filter on every poll
  if (netPnl > 0) { ptState._sessionWins++;   }
  else             { ptState._sessionLosses++; }

  // ── Daily loss kill switch ────────────────────────────────────────────────────
  // If session loss exceeds MAX_DAILY_LOSS (set in .env, default ₹5000),
  // latch _dailyLossHit = true and block ALL new entries for the rest of the day.
  // This is a hard stop — consecutive-loss pause does NOT clear it. Only session restart resets it.
  const MAX_DAILY_LOSS = _MAX_DAILY_LOSS;
  if (!ptState._dailyLossHit && ptState.sessionPnl <= -Math.abs(MAX_DAILY_LOSS)) {
    ptState._dailyLossHit = true;
    log(`🛑 [PAPER] DAILY LOSS LIMIT HIT — session loss ₹${Math.abs(ptState.sessionPnl)} >= ₹${MAX_DAILY_LOSS}. NO MORE ENTRIES TODAY.`);
  }
  // After 3 back-to-back losses:
  //   15-min: latch dailyLossHit = NO MORE ENTRIES TODAY. 3 losses on 15-min = bad market day, sit out.
  //   5-min:  pause for 4 candles (20 min) then allow re-entry — shorter TF recovers faster.
  if (netPnl < 0) {
    ptState._consecutiveLosses = (ptState._consecutiveLosses || 0) + 1;
    log(`📉 [PAPER] Consecutive losses: ${ptState._consecutiveLosses}`);
    if (ptState._consecutiveLosses >= 3) {
      if (TRADE_RES >= 15) {
        // 15-min: 3 losses = done for the day
        ptState._dailyLossHit = true;
        log(`🛑 [PAPER] 3 consecutive losses on 15-min — NO MORE ENTRIES TODAY (daily kill latched)`);
        // Keep _consecutiveLosses at 3 so UI correctly shows 3/3 with KILLED state
      } else {
        // 5-min: pause 4 candles (~20 min) then resume
        const pauseMs = 4 * getTradeResolution() * 60 * 1000;
        ptState._pauseUntilTime = simNow() + pauseMs;
        const resumeTime = new Date(ptState._pauseUntilTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        log(`⚠️ [PAPER] 3 consecutive losses — entries PAUSED for ${getTradeResolution() * 4} min (resume ~${resumeTime})`);
        ptState._consecutiveLosses = 0; // reset only for 5-min (will re-enter later)
      }
    }
  } else {
    if (ptState._consecutiveLosses > 0) {
      log(`✅ [PAPER] Consecutive loss streak reset (was ${ptState._consecutiveLosses})`);
    }
    ptState._consecutiveLosses = 0;
    ptState._pauseUntilTime = null; // profitable trade clears any remaining pause
  }

  // ── 50%-rule exit pause ────────────────────────────────────────────────────
  // A 50%-rule exit means price reversed immediately after entry = choppy market.
  // Pause for 2 candles (30 min on 15-min, 10 min on 5-min) before next entry.
  // This prevents the bot from re-entering the same choppy conditions repeatedly.
  // Only 50%-rule exits trigger this — SL hits and opposite-signal exits do NOT.
  if (false) { // 50% pause DISABLED
    const pauseCandles  = 2;
    const pauseMs       = pauseCandles * getTradeResolution() * 60 * 1000;
    ptState._fiftyPctPauseUntil = Date.now() + pauseMs;
    const resumeTime = new Date(ptState._fiftyPctPauseUntil).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    log(`⏸ [PAPER] 50%-rule exit — market choppy. Entry paused for ${pauseCandles} candles (~${pauseCandles * getTradeResolution()} min, resume ~${resumeTime})`);
  }

  stopOptionPolling();
  ptState.optionSymbol = null;
  ptState.optionLtp    = null;
  log(`📊 [PAPER] ${isFutures ? "Futures" : "Option"} LTP polling stopped`);

  const emoji = netPnl >= 0 ? "✅" : "❌";
  log(`${emoji} [PAPER] SELL ${qty} × ${symbol} @ SPOT ₹${exitPrice} | ${isFutures ? "" : `Option LTP: ₹${exitOptionLtp || "?"} | `}PnL: ₹${netPnl} | ${pnlMode}`);
  log(`💼 [PAPER] Session PnL so far: ₹${ptState.sessionPnl}`);

  // ── Telegram notification (skip in simulation mode) ───────────────────────
  if (!ptState._simMode) {
    notifyExit({
      mode:           'PAPER',
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
      entryTime:      trade.entryTime,
      exitTime:       trade.exitTime,
      qty,
    });
  }

  ptState.position = null;

  // Notify active strategy (optional callbacks for strategy-level state tracking)
  const activeStrat = getActiveStrategy();
  if (typeof activeStrat.onTradeClosed === "function") activeStrat.onTradeClosed();
  const isStopLoss = reason && (reason.toLowerCase().includes("sl hit") || reason.toLowerCase().includes("stop"));
  if (isStopLoss && typeof activeStrat.onStopLossHit === "function") activeStrat.onStopLossHit(side);
}

// ── On each completed candle ──────────────────────────────────────────

async function onCandleClose(candle) {
  ptState.candles.push(candle);
  ptState.prevCandleHigh = candle.high;
  ptState.prevCandleLow  = candle.low;
  ptState.prevCandleMid  = parseFloat(((candle.high + candle.low) / 2).toFixed(2));
  if (ptState.candles.length > 200) ptState.candles.shift();

  const strategy = getActiveStrategy();
  const { signal, reason, stopLoss, signalStrength, ...indicators } = strategy.getSignal(ptState.candles);

  // Cache stable SAR SL for every intra-candle tick — avoids recomputing strategy on every tick
  _cachedClosedCandleSL = stopLoss ?? null;

  // ── Pre-fetch option symbols in background so entry is instant on next tick ──
  // Skip in simulation mode (no broker API)
  if (!ptState.position && !ptState._simMode) prefetchOptionSymbols(candle.close).catch(() => {});

  // ── VIX filter: fetch latest VIX in background (updates cache for intra-tick checks) ──
  // Skip in simulation mode
  if (!ptState._simMode) fetchLiveVix().catch(() => {});
  const _vixDisplay = (vixFilter.VIX_ENABLED && !ptState._simMode) ? getCachedVix() : null;

  log(`📊 [PAPER] ──── Candle close ──────────────────────────────────────`);
  log(`   OHLC: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} | body=${Math.abs(candle.close - candle.open).toFixed(1)}pt`);
  log(`   EMA9=${indicators.ema9!==undefined?indicators.ema9:"?"} slope=${indicators.ema9Slope!==undefined?indicators.ema9Slope:"?"}pt | RSI=${indicators.rsi!==undefined?indicators.rsi:"?"} | SAR=${indicators.sar!==undefined?indicators.sar:"?"}(${indicators.sarTrend||"?"}) | ADX=${indicators.adx!==undefined?indicators.adx:"?"}${indicators.adxTrending?"✓":"✗"}`);
  log(`   Signal: ${signal} [${signalStrength||"n/a"}] | VIX: ${!vixFilter.VIX_ENABLED ? "off" : _vixDisplay != null ? _vixDisplay.toFixed(1) : "n/a"} | ${reason}`);
  if (signal === "NONE" && !ptState.position) {
    logNearMiss(indicators.filterAudit, "PAPER", log);
    skipLogger.appendSkipLog("swing", {
      gate: "strategy",
      reason: reason || null,
      spot: candle.close,
      ema9: indicators.ema9 ?? null,
      ema9Slope: indicators.ema9Slope ?? null,
      rsi: indicators.rsi ?? null,
      sar: indicators.sar ?? null,
      sarTrend: indicators.sarTrend ?? null,
      adx: indicators.adx ?? null,
      audit: indicators.filterAudit || null,
    });
  }

  // Telegram: candle close signal update (only when flat — no position open; skip in sim mode)
  if (!ptState._simMode && !ptState.position && signal !== null) {
    const _candleIST = new Date(candle.time * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
    notifySignal({
      mode: "PAPER",
      signal,
      reason: reason ? reason.slice(0, 200) : "—",
      strength: signalStrength,
      spot: candle.close,
      time: _candleIST,
    });
  }
  if (ptState.position) {
    // Increment candles-held + time-stop check (flat trade = theta bleed)
    ptState.position.candlesHeld = (ptState.position.candlesHeld || 0) + 1;
    {
      const _pos = ptState.position;
      const _entryOpt = _pos.optionEntryLtp;
      const _curOpt   = ptState.optionLtp || _pos.optionCurrentLtp;
      let _pnlPts = null;
      if (_entryOpt && _curOpt) {
        _pnlPts = _curOpt - _entryOpt;
      } else if (_pos.spotAtEntry) {
        _pnlPts = (candle.close - _pos.spotAtEntry) * (_pos.side === "CE" ? 1 : -1);
      }
      const _tsReason = tradeGuards.checkTimeStop(_pos.candlesHeld, _pnlPts);
      if (_tsReason) {
        log(`⏳ [PAPER] ${_tsReason}`);
        simulateSell(candle.close, _tsReason, candle.close);
        return;
      }
    }

    const _p    = ptState.position;
    const _est  = _p.side === "CE" ? (candle.close - _p.spotAtEntry).toFixed(1) : (_p.spotAtEntry - candle.close).toFixed(1);
    const _slGap = _p.side === "CE"
      ? parseFloat((candle.close - _p.stopLoss).toFixed(1))
      : parseFloat((_p.stopLoss - candle.close).toFixed(1));
    const _optEntry = _p.optionEntryLtp ? `₹${_p.optionEntryLtp}` : "—";
    const _optNow   = ptState.optionLtp  ? `₹${ptState.optionLtp}`  : "—";
    const _optPnl   = (_p.optionEntryLtp && ptState.optionLtp)
      ? ` (Δ₹${(ptState.optionLtp - _p.optionEntryLtp).toFixed(2)} × ${_p.qty || getLotQty()})`
      : "";
    log(`   Open ${_p.side} @ ₹${_p.spotAtEntry} | SL=₹${_p.stopLoss} (gap=${_slGap}pt) | best=₹${_p.bestPrice||"—"} | est.PnL≈${_est}pt | 50%mid=₹${_p.entryPrevMid}`);
    log(`   Option: entry=${_optEntry} now=${_optNow}${_optPnl}`);
  }

  // ── entryPrevMid is FIXED at entry time — never update it here ──────────────
  // It is set once in simulateBuy() = mid of the last fully closed candle at entry.
  // The 50% rule reference must not roll forward as new candles close.

  // ── Prev-candle trailing stop (SWING redefined) ──────────────────────────
  // Tighten the SL to THIS just-closed candle's low (CE) / high (PE). It becomes
  // the stop enforced intra-candle during the NEXT bar (via onTick). Tighten-only.
  // Then apply breakeven (SL → entry once +BREAKEVEN_PTS in favour).
  if (ptState.position) {
    const pos      = ptState.position;
    const trailRef = pos.side === "CE" ? candle.low : candle.high;
    if (pos.side === "CE") {
      if (pos.stopLoss == null || trailRef > pos.stopLoss) {
        const _o = pos.stopLoss; pos.stopLoss = parseFloat(trailRef.toFixed(2));
        log(`📐 [PAPER] Prev-candle trail CE: ₹${_o} → ₹${pos.stopLoss} (just-closed low)`);
      }
    } else {
      if (pos.stopLoss == null || trailRef < pos.stopLoss) {
        const _o = pos.stopLoss; pos.stopLoss = parseFloat(trailRef.toFixed(2));
        log(`📐 [PAPER] Prev-candle trail PE: ₹${_o} → ₹${pos.stopLoss} (just-closed high)`);
      }
    }
    const _bePts  = parseFloat(process.env.BREAKEVEN_PTS || "25");
    const _beMove = pos.side === "CE" ? (candle.close - pos.spotAtEntry) : (pos.spotAtEntry - candle.close);
    if (_beMove >= _bePts) {
      if (pos.side === "CE" && pos.stopLoss < pos.spotAtEntry) { pos.stopLoss = parseFloat(pos.spotAtEntry.toFixed(2)); log(`✅ [PAPER] Breakeven CE → SL=entry ₹${pos.spotAtEntry}`); }
      if (pos.side === "PE" && pos.stopLoss > pos.spotAtEntry) { pos.stopLoss = parseFloat(pos.spotAtEntry.toFixed(2)); log(`✅ [PAPER] Breakeven PE → SL=entry ₹${pos.spotAtEntry}`); }
    }
  }
  // SL-hit is enforced intra-candle in onTick against the prev-candle stop set above —
  // no separate candle-close SL check needed.

  // ── Exit Rule 3: Opposite signal ────────────────────────────────────────
  if (ptState.position) {
    const opposite = ptState.position.side === "CE" ? "BUY_PE" : "BUY_CE";
    if (signal === opposite) {
      simulateSell(candle.close, "Opposite signal exit", candle.close);
      // fall through — position is now null, may enter below
    }
  }

  // ── Exit Rule 4: EOD square-off + auto-stop at TRADE_STOP_TIME ─────────────
  // Use fast integer IST calc (no Date/ICU allocation) + module-level cached _STOP_MINS.
  // Skip EOD exit in simulation mode
  const _eodMinNow  = ptState._simMode ? 0 : getISTMinutes();
  const _stopLabel  = String(Math.floor(_STOP_MINS/60)).padStart(2,"0") + ":" + String(_STOP_MINS%60).padStart(2,"0");

  // ── Exit-before-close: square off any open position at SWING_EOD_EXIT_TIME ──
  // Fires ahead of the TRADE_STOP_TIME auto-stop; the engine keeps running until _STOP_MINS.
  if (ptState.position && !ptState._simMode && _eodMinNow >= _SWING_EOD_EXIT_MINS && _eodMinNow < _STOP_MINS) {
    const _eLbl = String(Math.floor(_SWING_EOD_EXIT_MINS/60)).padStart(2,"0") + ":" + String(_SWING_EOD_EXIT_MINS%60).padStart(2,"0");
    log(`⏰ [PAPER] Exit-before-close ${_eLbl} — squaring off open ${ptState.position.side}`);
    simulateSell(candle.close, `Exit before day close ${_eLbl}`, candle.close);
    return;
  }

  if (_eodMinNow >= _STOP_MINS) {
    if (ptState.position) {
      log("⏰ [PAPER] EOD " + _stopLabel + " — auto square off");
      simulateSell(candle.close, "EOD square-off " + _stopLabel, candle.close);
    }
    // Auto-stop the engine — no more trading after TRADE_STOP_TIME
    if (ptState.running) {
      const _w = ptState._sessionWins;
      const _l = ptState._sessionLosses;
      log(`\n📅 [PAPER] ──── SESSION COMPLETE ────────────────────────────────────`);
      log(`   Trades: ${(ptState.sessionTrades||[]).length} | ${_w}W / ${_l}L | PnL=₹${ptState.sessionPnl||0}`);
      log(`   Result: ${(ptState.sessionPnl||0)>0?"✅ PROFIT":(ptState.sessionPnl||0)<0?"❌ LOSS":"➖ BREAKEVEN"}`);
      log(`════════════════════════════════════════════════════════════════════\n`);
      log("⏰ [PAPER] Market closed (" + _stopLabel + " IST) — auto-stopping paper trade engine.");
      ptState.running = false;
      saveSession();
      // Only stop socket if no scalp mode is piggybacking
      if (!sharedSocketState.isScalpActive()) {
        socketManager.stop();
      }
      sharedSocketState.clear();
      stopOptionPolling();
    }
    return;
  }

  // ── Entry: candle-close entry (primary path for TRADE_RESOLUTION >= 5) ─────
  // For 15-min resolution: fires here AND intra-tick (both guarded by same circuit breakers).
  // For 5-min resolution: fires only if intra-tick entry didn't already fire.
  // isMarketHours() guard: prevents entries on 5-min candles closing between TRADE_STOP_TIME-10
  // and TRADE_STOP_TIME (e.g. a 3:20 PM candle-close with TRADE_STOP_TIME=15:30).
  if (!ptState.position && !ptState._entryPending && !ptState._expiryDayBlocked && isMarketHours() && (signal === "BUY_CE" || signal === "BUY_PE")) {
    // ── Strength gate: candle-close entry fires for MARGINAL signals ──────────
    // STRONG signals are handled intra-candle (better entry price).
    // If a STRONG signal somehow wasn't caught intra-candle (e.g. first tick of candle
    // was already at close), allow it here too — don't miss the trade entirely.
    // MARGINAL signals always wait for candle close — confirmed, not premature.
    const candleCloseStrength = signalStrength || "MARGINAL";
    if (candleCloseStrength === "STRONG") {
      log(`⚡ [PAPER] STRONG signal at candle close (intra-tick missed it) — entering @ ₹${candle.close} | ${reason}`);
    } else {
      log(`📋 [PAPER] MARGINAL signal — candle-close entry @ ₹${candle.close} | ${reason}`);
    }
    // ── Strong-only gate: block MARGINAL when SWING_STRONG_ONLY=true ─────────
    if (_SWING_STRONG_ONLY && candleCloseStrength !== "STRONG") {
      log(`🚫 [PAPER] STRONG_ONLY mode — MARGINAL entry blocked | Signal: ${signal}`);
      skipLogger.appendSkipLog("swing", {
        gate: "strong_only",
        reason: "MARGINAL blocked by SWING_STRONG_ONLY",
        spot: candle.close,
        signalStrength: candleCloseStrength,
        signal,
        path: "candle-close",
      });
      return;
    }
    // ── VIX filter: block entry in high-volatility regimes ──────────────────
    const _vixCheck = await checkLiveVix(candleCloseStrength);
    if (!_vixCheck.allowed) {
      log(`🌡️ [PAPER] VIX BLOCK — ${_vixCheck.reason} | Signal: ${signal}`);
      skipLogger.appendSkipLog("swing", {
        gate: "vix",
        reason: _vixCheck.reason || null,
        spot: candle.close,
        signalStrength: candleCloseStrength,
        signal,
        path: "candle-close",
      });
      return;
    }
    // ── Circuit breaker checks — must mirror intra-tick path exactly ──────────
    if (ptState._dailyLossHit) {
      log(`🛑 [PAPER] Daily loss limit active — candle-close entry blocked (${signal})`);
      return;
    }
    if (ptState._pauseUntilTime && simNow() < ptState._pauseUntilTime) {
      const resumeTime = new Date(ptState._pauseUntilTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      log(`⏸ [PAPER] Consecutive loss pause active — candle-close entry blocked until ~${resumeTime}`);
      return;
    }
    if (false) { // 50% pause DISABLED — replaced by breakeven
      const resumeTime = new Date(ptState._fiftyPctPauseUntil).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      log(`⏸ [PAPER] 50%-rule pause active — candle-close entry blocked until ~${resumeTime}`);
      return;
    }
    if (ptState.sessionTrades.length >= _MAX_DAILY_TRADES) {
      log(`🚫 [PAPER] Daily max trades reached — candle-close entry blocked (${signal})`);
      return;
    }
    const side = signal === "BUY_CE" ? "CE" : "PE";
    const INSTR = instrumentConfig.INSTRUMENT; // top-level constant

    // Set _entryPending BEFORE the async call so that ticks arriving while symbol lookup
    // is in-flight do not fire a second entry.
    ptState._entryPending = true;
    const _ptEntryTimer = setTimeout(() => { if (ptState._entryPending) ptState._entryPending = false; }, 4000);

    let symbolPromise;
    if (INSTR === "NIFTY_FUTURES") {
      symbolPromise = getSymbol(side).then(sym => ({ symbol: sym, expiry: null, strike: null, invalid: false }));
    } else {
      const cachedCs = getCachedSymbol(side, candle.close);
      if (cachedCs) {
        log(`⚡ [PAPER] Using pre-fetched symbol (candle-close): ${cachedCs.symbol}`);
        symbolPromise = Promise.resolve(cachedCs);
      } else {
        log(`🔍 [PAPER] Cache miss — live symbol lookup`);
        symbolPromise = validateAndGetOptionSymbol(candle.close, side, 'swing');
      }
    }

    symbolPromise.then(async ({ symbol, expiry, strike, invalid }) => {
      if (ptState.position) { ptState._entryPending = false; clearTimeout(_ptEntryTimer); return; } // already entered by tick
      if (INSTR === "NIFTY_FUTURES") {
        log(`🎯 [PAPER] ENTRY ${side === "CE" ? "LONG" : "SHORT"} FUTURES @ ₹${candle.close} | ${reason}`);
        log(`📌 Futures symbol: ${symbol}`);
      } else {
        const strikeType = Math.abs(strike - Math.round(candle.close / 50) * 50) === 0 ? "ATM" : "ITM";
        log(`🎯 [PAPER] ENTRY ${side} @ ₹${candle.close} | ${reason}`);
        log(`📌 ${strikeType} Option: ${symbol} (Spot: ${candle.close} → Strike: ${strike} | Expiry: ${expiry})`);
      }
      if (invalid) {
        log(`❌ [PAPER] Cannot enter — symbol ${symbol} invalid on Fyers (next week not live yet). Skipping trade.`);
        ptState._entryPending = false;
        clearTimeout(_ptEntryTimer);
        return;
      }

      // ── Bid-ask spread guard (options only, live mode only) ──
      if (!ptState._simMode && INSTR !== "NIFTY_FUTURES") {
        const _q = await tradeGuards.fetchOptionQuote(fyers, symbol);
        const _sp = tradeGuards.checkSpread(_q && _q.bid, _q && _q.ask);
        if (!_sp.ok) {
          log(`⏭️ [PAPER] SKIP entry — spread too wide (${_sp.reason})`);
          skipLogger.appendSkipLog("swing", {
            gate: "spread",
            reason: _sp.reason || null,
            spot: candle.close,
            side,
            symbol,
            bid: _q && _q.bid,
            ask: _q && _q.ask,
            path: "candle-close",
          });
          ptState._entryPending = false;
          clearTimeout(_ptEntryTimer);
          return;
        }
      }

      simulateBuy(symbol, side, getLotQty(), candle.close, reason, stopLoss, candle.close, false, {
        signalStrength: candleCloseStrength,
        rsiAtEntry:  indicators.rsi        != null ? indicators.rsi   : null,
        ema9AtEntry: indicators.ema9       != null ? indicators.ema9  : null,
        ema9Slope:   indicators.ema9Slope  != null ? indicators.ema9Slope : null,
        sarAtEntry:  indicators.sar        != null ? indicators.sar   : null,
        sarTrend:    indicators.sarTrend   || null,
        adxAtEntry:  indicators.adx        != null ? indicators.adx   : null,
        adxTrending: indicators.adxTrending != null ? indicators.adxTrending : null,
      });
      ptState._entryPending = false;
      clearTimeout(_ptEntryTimer);
    }).catch(err => {
      log(`❌ [PAPER] Symbol validation error: ${err.message}. Skipping trade.`);
      ptState._entryPending = false;
      clearTimeout(_ptEntryTimer);
    });
  }
}

// ── Tick → candle builder (NIFTY SPOT ONLY) ──────────────────────────────────────────
// This handler receives ONLY NSE:NIFTY50-INDEX ticks from the dedicated SPOT socket.
// Option ticks are handled separately in simulateBuy's startOption() callback.
// No option-detection needed here — zero risk of option ticks corrupting candle data.

function onTick(tick) {
  if (!tick || !tick.ltp) return;
  if (!ptState.running) return;  // ← guard: ignore ticks after stop (Fyers SDK may still fire)

  // ── Everything below: NIFTY index tick ───────────────────────────────────
  ptState.tickCount++;
  ptState.lastTickTime  = simNow(); // raw ms — formatted only on status poll (istNow() is expensive on every tick)
  ptState.lastTickPrice = tick.ltp;

  // In sim mode, advance simulated clock (~9s per tick, 20 ticks per candle)
  if (ptState._simMode) _simClockMs += 9000;

  const now    = simNow();
  const bucket = get5MinBucket(now);

  if (!ptState.currentBar || ptState.barStartTime !== bucket) {
    if (ptState.currentBar) {
      onCandleClose(ptState.currentBar).catch(console.error);
    }
    // New candle — clear the SL-hit block and intra-candle entry throttle
    ptState._slHitCandleTime    = null;
    ptState._lastCheckedBarHigh = null;
    ptState._lastCheckedBarLow  = null;
    ptState._missedLoggedCandle = null;
    ptState.currentBar = {
      time:   Math.floor(bucket / 1000),
      open:   tick.ltp,
      high:   tick.ltp,
      low:    tick.ltp,
      close:  tick.ltp,
      volume: tick.vol_traded_today || 0,
    };
    ptState.barStartTime = bucket;
  } else {
    const bar  = ptState.currentBar;
    bar.high   = Math.max(bar.high, tick.ltp);
    bar.low    = Math.min(bar.low,  tick.ltp);
    bar.close  = tick.ltp;
    bar.volume = tick.vol_traded_today || bar.volume;
  }

  const ltp = tick.ltp;
  const bar = ptState.currentBar;
  const strategy = getActiveStrategy(); // must be declared here for intra-tick entry + exits below

  // ── Intra-candle entry: fires on both 5-min AND 15-min resolution ──────────
  // For 15-min: we MUST check intra-candle because a 15-min window is too wide to wait
  // for candle close — entries are missed as price moves through EMA mid-candle.
  //
  // THROTTLE (15-min only): getSignal runs the full indicator stack (EMA, RSI, SAR).
  // To avoid burning CPU on every tick, we only re-run it when the live bar's high OR low
  // actually changes — i.e. when a new extreme tick arrives that could newly touch EMA9.
  // For 5-min this throttle is skipped (ticks are less frequent, no need).
  //
  // SAFETY: we only allow intra-tick entry if _cachedClosedCandleSL is not null,
  // meaning at least one candle has fully closed and SAR is properly initialised.
  // This prevents entries on the very first partial bar of the session.
  const barHighChanged = bar && bar.high !== ptState._lastCheckedBarHigh;
  const barLowChanged  = bar && bar.low  !== ptState._lastCheckedBarLow;
  const shouldCheckSignal = TRADE_RES === 5 || barHighChanged || barLowChanged;

  if (!ptState.position && bar && ptState.candles.length >= 30
      && !ptState._entryPending && shouldCheckSignal
      && (TRADE_RES === 5 || _cachedClosedCandleSL !== null)) {

    // Update throttle — record the high/low we're about to evaluate against
    if (TRADE_RES !== 5) {
      ptState._lastCheckedBarHigh = bar.high;
      ptState._lastCheckedBarLow  = bar.low;
    }
    // Security: never enter outside market hours (e.g. if tick arrives at open/close boundary)
    if (!isMarketHours()) {
      // Log only once per candle to avoid per-tick spam (matches the other guards below)
      const blockBarTime = ptState.currentBar ? ptState.currentBar.time : null;
      if (ptState._mktBlockLoggedCandle !== blockBarTime) {
        log(`🚫 [PAPER] Security block — outside market hours. No entry allowed.`);
        ptState._mktBlockLoggedCandle = blockBarTime;
      }
    } else {
    // Block re-entry on the same candle where an SL/50% exit just occurred
    const currentBarTime = ptState.currentBar ? ptState.currentBar.time : null;
    if (ptState._slHitCandleTime !== null && ptState._slHitCandleTime === currentBarTime) {
      // silently skip — no log spam on every tick
    } else if (ptState._dailyLossHit) {
      // Daily loss kill switch latched — no more entries today (silent to avoid log spam)
    } else if (ptState._pauseUntilTime && simNow() < ptState._pauseUntilTime) {
      // Consecutive loss pause active — silently skip to avoid log spam
    } else if (false) { // 50% pause DISABLED — replaced by breakeven
      // 50%-rule pause active — silently skip to avoid log spam
    } else if (ptState.sessionTrades.length >= _MAX_DAILY_TRADES) {
      // Daily max trades cap reached — protect brokerage and capital
      // Log only once per candle to avoid spam
      if (!ptState._maxTradesLoggedCandle || ptState._maxTradesLoggedCandle !== currentBarTime) {
        log(`🚫 [PAPER] Daily max trades (${_MAX_DAILY_TRADES}) reached — no more entries today`);
        ptState._maxTradesLoggedCandle = currentBarTime;
      }
    } else {
    // ── Single getSignal call using push/pop (no array copy, no second computation) ──
    // Push the live bar temporarily so strategy sees it, then immediately pop.
    // This avoids the expensive [...candles, bar] spread AND the duplicate getSignal call.
    // SAR stopLoss: use strategy's LIVE value (includes SAR flips), fallback to cached closed-candle SL.
    ptState.candles.push(bar);
    const { signal, reason, signalStrength, stopLoss: strategySL, ...indicators } = strategy.getSignal(ptState.candles, { silent: true });
    ptState.candles.pop();
    const stopLoss = strategySL || _cachedClosedCandleSL;
    // ── Strength gate: intra-candle entry ONLY for STRONG signals ─────────────
    // STRONG  = steep EMA slope + committed RSI → enter now at the EMA touch
    // MARGINAL = borderline slope/RSI → wait for candle close to confirm
    // This prevents entering on fake EMA touches mid-candle in ranging markets.
    const isStrongSignal = signalStrength === "STRONG";

    // ── Signal Missed Log ────────────────────────────────────────────────────
    // If strategy fires a valid signal but it's MARGINAL (15-min waits for candle close),
    // log it once per candle so you can see what was seen intra-candle vs what entered.
    if ((signal === "BUY_CE" || signal === "BUY_PE") && TRADE_RES >= 15 && !isStrongSignal) {
      if (!ptState._missedLoggedCandle || ptState._missedLoggedCandle !== currentBarTime) {
        ptState._missedLoggedCandle = currentBarTime;
        log(`⚠️ [PAPER] Signal SEEN intra-candle — ${signal} [MARGINAL] @ ₹${ltp} — waiting for candle close | ${reason}`);
      }
    }

    // ── Strong-only gate (intra-candle): mirrors candle-close gate (~line 1175) ──
    // On 5-min the intra-candle path is primary, so without this STRONG_ONLY leaks
    // every MARGINAL signal (the candle-close gate is rarely reached). Log once/candle.
    const _strongOnlyBlocks = _SWING_STRONG_ONLY && !isStrongSignal;
    if ((signal === "BUY_CE" || signal === "BUY_PE") && _strongOnlyBlocks && (TRADE_RES === 5 || isStrongSignal)) {
      if (!ptState._strongOnlyLoggedCandle || ptState._strongOnlyLoggedCandle !== currentBarTime) {
        ptState._strongOnlyLoggedCandle = currentBarTime;
        log(`🚫 [PAPER] STRONG_ONLY mode — MARGINAL intra-candle entry blocked | Signal: ${signal}`);
        skipLogger.appendSkipLog("swing", {
          gate: "strong_only",
          reason: "MARGINAL blocked by SWING_STRONG_ONLY",
          spot: ltp,
          signalStrength: signalStrength || "MARGINAL",
          signal,
          path: "intra-candle",
        });
      }
    }
    if ((signal === "BUY_CE" || signal === "BUY_PE") && !_strongOnlyBlocks && (TRADE_RES === 5 || isStrongSignal)) {
      // ── VIX filter: use cached VIX (updated at candle close) to avoid async in tick handler ──
      // Skip VIX filter in simulation mode
      const _vixIntraVal = ptState._simMode ? null : getCachedVix();
      const _vixIntraBlocked = !ptState._simMode && vixFilter.VIX_ENABLED && _vixIntraVal != null && (
        _vixIntraVal > vixFilter.VIX_MAX_ENTRY ||
        (_vixIntraVal > vixFilter.VIX_STRONG_ONLY && signalStrength !== "STRONG")
      );
      if (_vixIntraBlocked) {
        if (!ptState._vixBlockLoggedCandle || ptState._vixBlockLoggedCandle !== currentBarTime) {
          ptState._vixBlockLoggedCandle = currentBarTime;
          log(`🌡️ [PAPER] VIX BLOCK (intra) — VIX ${_vixIntraVal.toFixed(1)} too high | Signal: ${signal} [${signalStrength}]`);
          skipLogger.appendSkipLog("swing", {
            gate: "vix",
            reason: `VIX ${_vixIntraVal.toFixed(1)} too high`,
            spot: ltp,
            vix: _vixIntraVal,
            signalStrength,
            signal,
            path: "intra-candle",
          });
        }
      } else {
      const side = signal === "BUY_CE" ? "CE" : "PE";
      ptState._entryPending = true; // prevent double-fire while async symbol lookup runs
      // Safety: auto-reset after 4s in case of any unhandled error path
      const _ptIntraTimer = setTimeout(() => { if (ptState._entryPending) { ptState._entryPending = false; } }, 4000);
      log(`⚡ [PAPER] Intra-candle ${TRADE_RES >= 15 ? "STRONG " : ""}entry @ ₹${ltp} | VIX: ${_vixIntraVal != null ? _vixIntraVal.toFixed(1) : "n/a"} | [${TRADE_RES}m bar] ${reason}`);
      const INSTR = instrumentConfig.INSTRUMENT; // top-level constant — no inline require needed

      let symbolPromise;
      if (ptState._simMode) {
        // In simulation mode, use a dummy option symbol (no broker API needed)
        const strike = Math.round(ltp / 50) * 50;
        symbolPromise = Promise.resolve({ symbol: `NSE:NIFTY-SIM-${strike}${side}`, expiry: "SIM", strike, invalid: false });
      } else if (INSTR === "NIFTY_FUTURES") {
        symbolPromise = getSymbol(side).then(sym => ({ symbol: sym, expiry: null, strike: null, invalid: false }));
      } else {
        const cached = getCachedSymbol(side, ltp);
        if (cached) {
          log(`⚡ [PAPER] Using pre-fetched symbol: ${cached.symbol} (spot delta: ${Math.abs(cached.spot - ltp).toFixed(0)} pts)`);
          symbolPromise = Promise.resolve(cached);
        } else {
          log(`🔍 [PAPER] Cache miss — live symbol lookup (spot moved or first trade of session)`);
          symbolPromise = validateAndGetOptionSymbol(ltp, side, 'swing');
        }
      }

      symbolPromise.then(async ({ symbol, expiry, strike, invalid }) => {
        if (ptState.position) { ptState._entryPending = false; clearTimeout(_ptIntraTimer); return; } // already entered
        if (INSTR === "NIFTY_FUTURES") {
          log(`🎯 [PAPER] ENTRY ${side === "CE" ? "LONG" : "SHORT"} FUTURES @ ₹${ltp} | ${reason}`);
          log(`📌 Futures symbol: ${symbol}`);
        } else {
          const strikeType = Math.abs(strike - Math.round(ltp / 50) * 50) === 0 ? "ATM" : "ITM";
          log(`🎯 [PAPER] ENTRY ${side} @ ₹${ltp} | ${reason}`);
          log(`📌 ${strikeType} Option: ${symbol} (Spot: ${ltp} → Strike: ${strike} | Expiry: ${expiry})`);
        }
        if (invalid) {
          log(`❌ [PAPER] Cannot enter — symbol ${symbol} invalid on Fyers. Skipping.`);
          ptState._entryPending = false;
          clearTimeout(_ptIntraTimer);
          return;
        }

        // ── Bid-ask spread guard (options only, live mode only) ──
        if (!ptState._simMode && INSTR !== "NIFTY_FUTURES") {
          const _q = await tradeGuards.fetchOptionQuote(fyers, symbol);
          const _sp = tradeGuards.checkSpread(_q && _q.bid, _q && _q.ask);
          if (!_sp.ok) {
            log(`⏭️ [PAPER] SKIP intra-candle entry — spread too wide (${_sp.reason})`);
            skipLogger.appendSkipLog("swing", {
              gate: "spread",
              reason: _sp.reason || null,
              spot: ltp,
              side,
              symbol,
              bid: _q && _q.bid,
              ask: _q && _q.ask,
              path: "intra-candle",
            });
            ptState._entryPending = false;
            clearTimeout(_ptIntraTimer);
            return;
          }
        }

        simulateBuy(symbol, side, getLotQty(), ltp, reason, stopLoss, ltp, true, {
          signalStrength,
          rsiAtEntry:  indicators.rsi        != null ? indicators.rsi   : null,
          ema9AtEntry: indicators.ema9       != null ? indicators.ema9  : null,
          ema9Slope:   indicators.ema9Slope  != null ? indicators.ema9Slope : null,
          sarAtEntry:  indicators.sar        != null ? indicators.sar   : null,
          sarTrend:    indicators.sarTrend   || null,
          adxAtEntry:  indicators.adx        != null ? indicators.adx   : null,
          adxTrending: indicators.adxTrending != null ? indicators.adxTrending : null,
        }); // isIntraCandle=true
        ptState._entryPending = false;
        clearTimeout(_ptIntraTimer);
      }).catch(err => {
        log(`❌ [PAPER] Symbol lookup error: ${err.message}`);
        ptState._entryPending = false;
        clearTimeout(_ptIntraTimer);
      });
      } // end VIX else
    }
    } // end SL-hit candle guard
    } // end market hours check
  }

  // ── EXIT: Trailing SAR stoploss on every tick ─────────────────────────────
  // NOTE: Intra-tick 50% rule was REMOVED (was firing on single-tick noise at prevMid).
  // On 15-min candles Nifty routinely wicks through prevMid and recovers within the candle.
  // A single ltp > prevMid tick was triggering exit on trades the backtest would HOLD.
  // Fix: 50% rule only fires at candle CLOSE (see onCandleClose) — identical to backtest.
  // The trail SL below handles all real-time intra-candle profit protection.
  // SL is updated each candle close as SAR dot moves in our favour.
  // ADDITIONALLY: intra-candle points trail — from the very FIRST favourable tick,
  // trail SL 10 pts behind the best price seen (no minimum trigger distance).
  // This tightens the stop immediately as price moves in our direction.
  // ── MFE/MAE tracking (spot pts in trade direction) — per tick, for analysis ──
  if (ptState.position) {
    const _exPos  = ptState.position;
    const _favPts = (ltp - _exPos.spotAtEntry) * (_exPos.side === "CE" ? 1 : -1);
    if (_favPts > (_exPos.mfeSpotPts || 0)) { _exPos.mfeSpotPts = parseFloat(_favPts.toFixed(2)); _exPos.secsToMFE = parseFloat(((simNow() - _exPos.entryTimeMs) / 1000).toFixed(1)); }
    if (_favPts < (_exPos.maeSpotPts || 0)) { _exPos.maeSpotPts = parseFloat(_favPts.toFixed(2)); _exPos.secsToMAE = parseFloat(((simNow() - _exPos.entryTimeMs) / 1000).toFixed(1)); }
  }

  // ── BREAKEVEN STOP (replaces 50% rule) ─────────────────────────────────
  // Once trade moves +25pt in favor, SL moves to entry price = zero risk.
  if (ptState.position && ptState.position.stopLoss !== null) {
    const _bePos = ptState.position;
    const _bePts = parseFloat(process.env.BREAKEVEN_PTS || "25");
    if (_bePos.side === "CE") {
      const _beMove = (_bePos.bestPrice || ltp) - _bePos.spotAtEntry;
      if (_beMove >= _bePts && _bePos.stopLoss < _bePos.spotAtEntry) {
        log(`✅ [PAPER] BREAKEVEN CE: +${_beMove.toFixed(0)}pt >= ${_bePts}pt → SL moved to entry ₹${_bePos.spotAtEntry}`);
        _bePos.stopLoss = _bePos.spotAtEntry;
      }
    } else {
      const _beMove = _bePos.spotAtEntry - (_bePos.bestPrice || ltp);
      if (_beMove >= _bePts && _bePos.stopLoss > _bePos.spotAtEntry) {
        log(`✅ [PAPER] BREAKEVEN PE: +${_beMove.toFixed(0)}pt >= ${_bePts}pt → SL moved to entry ₹${_bePos.spotAtEntry}`);
        _bePos.stopLoss = _bePos.spotAtEntry;
      }
    }
  }

  // ── Option-premium stop: exit if option LTP drops OPT_STOP_PCT below entry premium ──
  if (ptState.position && ptState.position.optionEntryLtp && ptState.optionLtp && _OPT_STOP_PCT > 0) {
    const _pos     = ptState.position;
    const _stopLtp = parseFloat((_pos.optionEntryLtp * (1 - _OPT_STOP_PCT)).toFixed(2));
    if (ptState.optionLtp <= _stopLtp) {
      log(`🛑 [PAPER] OPTION STOP ${(_OPT_STOP_PCT*100).toFixed(0)}% — opt ₹${ptState.optionLtp} <= ₹${_stopLtp} (entry ₹${_pos.optionEntryLtp})`);
      _setSlPause(_pos.side);
      ptState._slHitCandleTime = ptState.currentBar ? ptState.currentBar.time : null;
      simulateSell(ltp, `Option stop ${(_OPT_STOP_PCT*100).toFixed(0)}% @ opt ₹${ptState.optionLtp}`, ltp);
      return;
    }
  }

  // ── Prev-candle trailing SL hit ───────────────────────────────────────────
  // pos.stopLoss is the previous candle's low (CE) / high (PE), set at the last
  // candle close (or breakeven=entry). Enforced here tick-by-tick.
  // PE: exit when ltp >= stopLoss | CE: exit when ltp <= stopLoss
  if (ptState.position && ptState.position.stopLoss !== null) {
    const pos = ptState.position;
    // Track favourable extreme (used by the breakeven check above)
    if (pos.side === "CE") { if (!pos.bestPrice || ltp > pos.bestPrice) pos.bestPrice = ltp; }
    else                   { if (!pos.bestPrice || ltp < pos.bestPrice) pos.bestPrice = ltp; }

    const updatedSL = pos.stopLoss;
    const _slType = (sl) => Math.abs(sl - pos.spotAtEntry) < 1 ? "Breakeven" : (pos.initialStopLoss && Math.abs(sl - pos.initialStopLoss) > 1 ? "Trail" : "Initial");
    if (pos.side === "PE" && ltp >= updatedSL) {
      const optStr = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
      log(`🛑 [PAPER] ${_slType(updatedSL)} SL HIT PE — ltp ₹${ltp} >= SL ₹${updatedSL} | best=₹${pos.bestPrice||"—"}${optStr}`);
      ptState._slHitCandleTime = ptState.currentBar ? ptState.currentBar.time : null;
      _setSlPause("PE");
      simulateSell(updatedSL, `${_slType(updatedSL)} SL hit @ ₹${updatedSL}`, ltp);
      return;
    }
    if (pos.side === "CE" && ltp <= updatedSL) {
      const optStr = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
      log(`🛑 [PAPER] ${_slType(updatedSL)} SL HIT CE — ltp ₹${ltp} <= SL ₹${updatedSL} | best=₹${pos.bestPrice||"—"}${optStr}`);
      ptState._slHitCandleTime = ptState.currentBar ? ptState.currentBar.time : null;
      _setSlPause("CE");
      simulateSell(updatedSL, `${_slType(updatedSL)} SL hit @ ₹${updatedSL}`, ltp);
      return;
    }
  }
}

// -- Save completed session to disk ───────────────────────────────────────────

function saveSession() {
  const data = loadPaperData();

  const wins   = { length: ptState._sessionWins };
  const losses = { length: ptState._sessionLosses };

  const session = {
    date:        new Date().toISOString().split("T")[0],
    strategy:    ACTIVE,
    instrument:  instrumentConfig.INSTRUMENT,
    startTime:   ptState.sessionStart,
    endTime:     istNow(),
    trades:      ptState.sessionTrades,
    totalTrades: ptState.sessionTrades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     ptState.sessionTrades.length
                   ? `${((wins.length / ptState.sessionTrades.length) * 100).toFixed(1)}%`
                   : "N/A",
    sessionPnl:  ptState.sessionPnl,
  };

  data.sessions.push(session);
  data.totalPnl = parseFloat((data.totalPnl + ptState.sessionPnl).toFixed(2));
  data.capital  = parseFloat((data.capital  + ptState.sessionPnl).toFixed(2));

  savePaperData(data);
  log(`💾 Session saved. Running capital: ₹${data.capital} | Total PnL: ₹${data.totalPnl}`);

  // ── Daily Report + Telegram EOD ──────────────────────────────────────────────
  generatePaperDailyReport(ptState.sessionTrades, ptState.sessionPnl);

  return session;
}

function generatePaperDailyReport(trades, sessionPnl) {
  try {
    if (!trades || trades.length === 0) {
      if (canSend("TG_SWING_DAYREPORT")) {
        sendTelegram([
          `📄 SWING PAPER — DAY REPORT`,
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
      const label = t.exitReason.includes("50% rule")  ? "50% Rule"
                  : t.exitReason.includes("SL hit")    ? "SL Hit"
                  : t.exitReason.includes("trail") || t.exitReason.includes("Trail") ? "Trail SL"
                  : t.exitReason.includes("Opposite")  ? "Opposite Signal"
                  : t.exitReason.includes("EOD") || t.exitReason.includes("stop") ? "EOD/Stop"
                  : t.exitReason.includes("Manual")    ? "Manual Exit"
                  : "Other";
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

    if (canSend("TG_SWING_DAYREPORT")) {
      sendTelegram([
        `📄 SWING PAPER — DAY REPORT`,
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
 * GET /swing-paper/start
 * Connects to live Fyers socket and starts simulating trades
 */
router.get("/start", async (req, res) => {
  // Re-read env into module-level config so Settings UI changes and replay
  // env overrides (snapshot or simulator mode) take effect for this session.
  _refreshConfig();

  // Verify the Fyers token actually works before we wire up the socket. Catches
  // the mobile-login-never-completed case where ACCESS_TOKEN is set in env but
  // the token is partial/invalid — would otherwise surface as -15 minutes later.
  const auth = await verifyFyersToken();
  if (!auth.ok) {
    return res.status(401).json({ success: false, error: auth.message, code: auth.code });
  }

  if (ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading already running." });
  }

  if (sharedSocketState.isActive()) {
    return res.status(400).json({
      success: false,
      error: `Cannot start paper trading — Live Trading is currently active. Stop it first at /swing-live/stop`,
    });
  }

  // ── 0DTE expiry-day warning ────────────────────────────────────────────────
  // Block start if today is the configured swing expiry — swing strategy bleeds
  // on 0DTE due to theta+gamma. User can override with ?force=1 if intentional.
  if (isSwingExpiringToday() && req.query.force !== "1") {
    const _exp = _getEffectiveSwingExpiry();
    return res.status(409).json({
      success: false,
      code: "EXPIRY_DAY_0DTE",
      expiry: _exp,
      message: `Configured swing expiry (${_exp}) is today — that's 0DTE. Swing strategy is not designed for same-day expiry (theta+gamma will crush option premium). Update SWING_OPTION_EXPIRY_OVERRIDE to next week's expiry in Settings, or click "Start Anyway" to proceed.`,
    });
  }

  // ── NEW: Trading session validation (holidays + time check) ────────────────
  const tradingCheck = await isTradingAllowed();
  if (!tradingCheck.allowed) {
    return res.status(400).json({
      success: false,
      error: `❌ ${tradingCheck.reason}`,
    });
  }

  // ── Start gate: allow any time before TRADE_STOP_TIME ─────────────────────
  // No lower bound — start at 8:00, 7:30, any time to pre-fetch history.
  // Trade execution is gated by isMarketHours() inside onTick.
  if (!isStartAllowed()) {
    const stopMins = _STOP_MINS; // cached at module load
    const stopLabel = String(Math.floor(stopMins/60)).padStart(2,"0") + ":" + String(stopMins%60).padStart(2,"0");
    return res.status(400).json({
      success: false,
      error: "Trading session closed for today — past " + stopLabel + " IST. Restart tomorrow.",
    });
  }

  const strategy    = getActiveStrategy();
  // Reset strategy module-level state if it has a reset hook
  if (typeof strategy.reset === "function") strategy.reset();
  const accessToken = `${process.env.APP_ID}:${process.env.ACCESS_TOKEN}`;
  const subscribeSymbol = "NSE:NIFTY50-INDEX";
  const data        = loadPaperData();
  // IST date — toISOString() gives UTC which is 5:30 behind IST and returns wrong date before 5:30 AM UTC
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // "YYYY-MM-DD" in IST

  // Reset session state
  ptState.running       = true;
  ptState.candles       = [];
  ptState.currentBar    = null;
  ptState.barStartTime  = null;
  ptState.position      = null;
  ptState.sessionTrades = [];
  ptState.sessionPnl    = 0;
  ptState.sessionStart  = istNow();
  ptState.log           = [];
  ptState.tickCount     = 0;
  ptState._entryPending = false;
  ptState.lastTickTime  = null;
  ptState.lastTickPrice  = null;
  ptState.prevCandleHigh = null;
  ptState.prevCandleLow  = null;
  ptState.prevCandleMid  = null;
  ptState.optionLtp      = null;
  ptState.optionSymbol   = null;
  ptState._consecutiveLosses   = 0;
  ptState._pauseUntilTime      = null;
  ptState._fiftyPctPauseUntil  = null;  // clear 50%-rule pause from previous session
  ptState._dailyLossHit        = false; // reset daily kill switch on new session
  ptState._cachedCE            = null; // clear pre-fetch cache on session start
  ptState._cachedPE            = null;
  ptState._maxTradesLoggedCandle = null;
  ptState._slHitCandleTime     = null;
  ptState._slPauseUntilBySide  = { CE: 0, PE: 0 }; // reset same-side SL cooldown
  ptState._lastCheckedBarHigh  = null;
  ptState._lastCheckedBarLow   = null;
  ptState._missedLoggedCandle  = null;
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

  log(`\n════════════════════════════════════════════════════════════════════`);
  log(`🟡 [PAPER] Paper trading started`);
  log(`   Resolution : ${getTradeResolution()}-min candles (TRADE_RESOLUTION in .env)`);
  log(`   Strategy   : ${ACTIVE} — ${strategy.NAME}`);
  log(`   Instrument : ${instrumentConfig.INSTRUMENT}`);
  log(`   Capital    : ₹${data.capital.toLocaleString("en-IN")}`);
  log(`   Entry       : CE = RSI ${process.env.RSI_CE_MIN||52}-${process.env.RSI_CE_MAX||80} + price≥EMA21 + SAR below | PE = RSI ${process.env.RSI_PE_MIN||20}-${process.env.RSI_PE_MAX||48} + price≤EMA21 + SAR above (intra-candle)`);
  log(`   Stop/exit   : prev-candle trailing SL | breakeven +${process.env.BREAKEVEN_PTS||25}pt | option stop ${(parseFloat(process.env.OPT_STOP_PCT||"0.15")*100).toFixed(0)}% | opposite signal | exit-before-close ${process.env.SWING_EOD_EXIT_TIME||"15:15"} | EOD ${process.env.TRADE_STOP_TIME||"15:30"}`);
  log(`   Risk guards : MaxDailyLoss=₹${process.env.MAX_DAILY_LOSS||5000} | MaxTrades=${process.env.MAX_DAILY_TRADES||6} | same-side SL cooldown ${process.env.SWING_SL_PAUSE_CANDLES||3} candles | VIX ${(process.env.VIX_FILTER_ENABLED==="true")?("≤"+(process.env.VIX_MAX_ENTRY||20)):"off"}`);
  log(`════════════════════════════════════════════════════════════════════\n`);

  // Telegram: session started + checklist (same as live trade)
  const _ptChecks = { fyers: { ok: false, msg: "" }, symbol: { ok: false, msg: "" } };
  try {
    const { getLiveSpot, validateAndGetOptionSymbol } = require("../config/instrument");
    const [spotResult] = await Promise.allSettled([
      getLiveSpot().then(s => { if (!s || s <= 0) throw new Error("spot=0"); return s; }),
    ]);
    if (spotResult.status === "fulfilled") {
      const spot = spotResult.value;
      const atm  = Math.round(spot / 50) * 50;
      _ptChecks.fyers = { ok: true, msg: `NIFTY ₹${spot} | ATM ${atm}` };
      try {
        const [ce, pe] = await Promise.all([
          validateAndGetOptionSymbol(spot, "CE", 'swing'),
          validateAndGetOptionSymbol(spot, "PE", 'swing'),
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

  const _ptAllOk = _ptChecks.fyers.ok && _ptChecks.symbol.ok;
  notifyStarted({
    mode: "PAPER",
    text: [
      `${_ptAllOk ? "✅" : "⚠️"} SWING PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${ACTIVE}`,
      `Instrument: ${instrumentConfig.INSTRUMENT}`,
      `Capital   : ₹${data.capital.toLocaleString("en-IN")}`,
      `Window    : ${process.env.TRADE_START_TIME || "09:15"} → ${process.env.TRADE_STOP_TIME || "15:30"} IST`,
      `Max Loss  : ₹${_MAX_DAILY_LOSS} | Max Trades: ${_MAX_DAILY_TRADES}`,
      ``,
      `Pre-Market Checklist:`,
      `${_ptChecks.fyers.ok  ? "✅" : "❌"} Fyers   : ${_ptChecks.fyers.msg}`,
      `${_ptChecks.symbol.ok ? "✅" : "⚠️"} Symbols : ${_ptChecks.symbol.msg || "not checked"}`,
    ].join("\n"),
  });

  // ── PRE-LOAD today's historical candles so strategy fires immediately ────────
  // Without this, EMA (needs 25 candles) / RSI (needs 16) won't fire for hours
  try {
    log(`📥 Pre-loading historical candles so strategy warms up instantly...`);
    const { fetchCandles } = require("../services/backtestEngine");
    const { fetchCandlesCached } = require("../utils/candleCache");

    // Go back 21 calendar days (~15 trading days ≈ 390 candles) to match backtest depth.
    // SAR (Parabolic SAR) is path-dependent — with too few seed candles, SAR dots/trend
    // diverge from backtest, causing paper trade to miss or take different signals.
    // 7 days was insufficient (only ~66 candles); 21 days ensures SAR convergence.
    const fromDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    fromDate.setDate(fromDate.getDate() - 21);
    const fromStr = fromDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

    // fetchCandlesCached: reads cache first, only calls Fyers API for missing/today's candles
    const todayCandles = await fetchCandlesCached(subscribeSymbol, String(getTradeResolution()), fromStr, todayStr, fetchCandles);

    if (todayCandles.length > 0) {
      // Load all but the last candle (last one is still forming — live ticks will complete it)
      ptState.candles = todayCandles.slice(0, -1);
      log(`✅ Pre-loaded ${ptState.candles.length} candles (from ${fromStr} to ${todayStr})`);

      // Check current signal state on pre-loaded data — also seeds _cachedClosedCandleSL
      // so intra-tick entries on the very first live bar have a valid SAR stop-loss.
      const { signal, reason, stopLoss: preloadSL } = strategy.getSignal(ptState.candles);
      _cachedClosedCandleSL = preloadSL ?? null;
      log(`📊 Current signal on pre-loaded data: ${signal} | ${reason}`);

      // Seed display values from last closed candle
      const lastCandle = ptState.candles[ptState.candles.length - 1];
      if (lastCandle) {
        ptState.prevCandleHigh = lastCandle.high;
        ptState.prevCandleLow  = lastCandle.low;
        ptState.prevCandleMid  = parseFloat(((lastCandle.high + lastCandle.low) / 2).toFixed(2));
        log(`📌 Seeded prev candle: high=${lastCandle.high} low=${lastCandle.low} mid=${ptState.prevCandleMid}`);
      }
    } else {
      log(`⚠️  No historical candles found — will build from live ticks (slow start, needs 20 candles)`);
    }
  } catch (err) {
    log(`⚠️  Could not pre-load candles: ${err.message} — will build from live ticks`);
  }

  // Tick-recorder session-start snapshot
  ptState._sessionId = `swing-paper:${Date.now()}`;
  try {
    tickRecorder.recordSessionStart({
      mode: "swing-paper",
      sessionId: ptState._sessionId,
      settings: tickRecorder.snapshotSettings(),
      warmup:   ptState.candles.map(c => ({ ...c })),
      vix:      getCachedVix(),
      meta: {
        instrument:       instrumentConfig.INSTRUMENT,
        resolutionMin:    getTradeResolution(),
        spotSymbol:       subscribeSymbol,
        sessionStartISO:  ptState.sessionStart,
        activeStrategy:   ACTIVE,
      },
    });
  } catch (_) {}

  // ── Pre-market warmup mode ─────────────────────────────────────────────────
  // Started before TRADE_START_TIME (default 09:15)? History is pre-loaded.
  // Fyers ticks only arrive from 9:15 IST — bot waits silently until market opens.
  const nowMins = getISTMinutes();
  const _tradeStartMins  = _START_MINS; // cached at module load
  const _tradeStartLabel = String(Math.floor(_tradeStartMins/60)).padStart(2,"0") + ":" + String(_tradeStartMins%60).padStart(2,"0");
  if (nowMins < _tradeStartMins) {
    const waitMin = _tradeStartMins - nowMins;
    log("⏳ [PAPER] Pre-market mode — " + waitMin + " min until " + _tradeStartLabel + ". History loaded, strategy warmed up.");
    log("   Fyers ticks arrive from 9:15 IST. Trades will begin at " + _tradeStartLabel + ".");
  }

  // ── Schedule auto-stop at TRADE_STOP_TIME ────────────────────────────────
  const _stopMinsAtStart = _STOP_MINS; // cached at module load
  const _stopLabelAtStart = String(Math.floor(_stopMinsAtStart/60)).padStart(2,"0") + ":" + String(_stopMinsAtStart%60).padStart(2,"0");
  scheduleAutoStop((msg) => {
    log(msg);
    if (ptState.position && ptState.lastTickPrice) {
      simulateSell(ptState.lastTickPrice, "Auto-stop " + _stopLabelAtStart, ptState.lastTickPrice);
    }
    ptState.running = false;
    stopOptionPolling();
    try {
      tickRecorder.recordSessionStop({
        mode: "swing-paper",
        sessionId: ptState._sessionId || null,
        reason: "auto_stop_eod",
      });
    } catch (_) {}
    if (!sharedSocketState.isScalpActive()) {
      socketManager.stop();
    }
    sharedSocketState.clear();
    saveSession();
  });

  log(`📡 Subscribing to ${subscribeSymbol} for live tick data...`);

  // Start the socket manager — single socket, spot-only to begin
  socketManager.start(subscribeSymbol, onTick, log);
  sharedSocketState.setActive("SWING_PAPER");

  return res.json({
    success:     true,
    message:     "Paper trading started! No real orders will be placed.",
    strategy:    { key: ACTIVE, name: strategy.NAME },
    instrument:  instrumentConfig.INSTRUMENT,
    lotQty:      getLotQty(),
    capital:     data.capital,
    monitorAt:   "GET /swing-paper/status",
  });
});

/**
 * GET /swing-paper/stop
 * Stops the session, squares off virtual position, saves summary to disk
 */
router.get("/stop", async (req, res) => {
  if (!ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading is not running." });
  }

  // Virtual square-off
  if (ptState.position && ptState.currentBar) {
    simulateSell(ptState.currentBar.close, "Manual stop", ptState.currentBar.close);
  }

  stopOptionPolling();
  // Stop tick simulator if in sim mode, otherwise stop socket
  if (ptState._simMode) {
    tickSimulator.stop();
    ptState._simMode = false;
    ptState._simScenario = null;
  } else if (!sharedSocketState.isScalpActive()) {
    socketManager.stop();
  }
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  sharedSocketState.clear();
  ptState.running = false;  // ← FIX: was missing — UI stayed "LIVE" after manual stop

  try {
    tickRecorder.recordSessionStop({
      mode: "swing-paper",
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
    viewHistory: "GET /swing-paper/history",
  });
});

/**
 * GET /swing-paper/exit
 * Manually exit the current open position without stopping the session.
 * Paper trading continues — just closes the current trade at current market price.
 */
router.get("/exit", (req, res) => {
  if (!ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading is not running." });
  }
  if (!ptState.position) {
    return res.status(400).json({ success: false, error: "No open position to exit." });
  }
  // Allow exit even without currentBar — use lastTickPrice as fallback
  if (!ptState.currentBar && !ptState.lastTickPrice) {
    return res.status(400).json({ success: false, error: "No market data yet — cannot exit." });
  }

  const exitSpot   = ptState.currentBar ? ptState.currentBar.close : (ptState.lastTickPrice || 0);
  const exitOption = ptState.optionLtp || null;
  log(`🖐️ [PAPER] MANUAL EXIT triggered by user | NIFTY spot: ₹${exitSpot} | Option LTP: ${exitOption ? "₹" + exitOption : "N/A"}`);

  // ── Block re-entry for 1 full candle after manual exit ──────────────────────
  ptState._slHitCandleTime = ptState.currentBar ? ptState.currentBar.time : null;
  const _manualPauseMs = TRADE_RES * 60 * 1000;
  ptState._fiftyPctPauseUntil = Date.now() + _manualPauseMs;
  const _resumeTime = new Date(ptState._fiftyPctPauseUntil).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  log(`⏸ [PAPER] Manual exit — re-entry paused for 1 candle (~${TRADE_RES} min, resume ~${_resumeTime})`);

  simulateSell(exitSpot, "Manual exit by user", exitSpot);

  // Return JSON so the fetch() handler in the browser works correctly
  return res.json({ success: true, message: "Position exited manually.", exitSpot });
});

/**
 * POST /swing-paper/manualEntry
 * Manually enter a CE or PE trade at current spot price.
 * SL = current SAR value (capped at MAX_SAR_DISTANCE). Trail/breakeven apply normally.
 */
router.post("/manualEntry", async (req, res) => {
  if (!ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading is not running." });
  }
  if (ptState.position) {
    return res.status(400).json({ success: false, error: "Already in a position. Exit first." });
  }
  const { side } = req.body || {};
  if (side !== "CE" && side !== "PE") {
    return res.status(400).json({ success: false, error: "Side must be CE or PE." });
  }
  const spot = ptState.lastTickPrice || (ptState.currentBar ? ptState.currentBar.close : null);
  if (!spot) {
    return res.status(400).json({ success: false, error: "No market data yet." });
  }

  // Get strategy signal to extract SAR value for SL
  const candles = ptState.candles || [];
  let sarSL = null;
  if (candles.length > 0) {
    const { getActiveStrategy } = require("../strategies");
    const result = getActiveStrategy().getSignal(candles, { silent: true });
    if (result && result.stopLoss) {
      sarSL = result.stopLoss;
    }
  }

  // Fallback SL if SAR not available
  const MAX_SL = parseFloat(process.env.MAX_SAR_DISTANCE || "80");
  if (!sarSL) {
    sarSL = side === "CE" ? spot - MAX_SL : spot + MAX_SL;
  }

  // Validate SL is on correct side (CE: SL must be below entry, PE: SL must be above entry)
  if ((side === "CE" && sarSL >= spot) || (side === "PE" && sarSL <= spot)) {
    // SAR is on wrong side — manual entry against trend, use fixed SL
    sarSL = side === "CE" ? spot - MAX_SL : spot + MAX_SL;
    log(`⚠️ [PAPER] Manual ${side}: SAR on wrong side — using ${MAX_SL}pt fixed SL @ ₹${sarSL}`);
  }

  // Cap SL at MAX_SAR_DISTANCE from entry
  const sarGap = Math.abs(spot - sarSL);
  if (sarGap > MAX_SL) {
    sarSL = side === "CE" ? spot - MAX_SL : spot + MAX_SL;
  }

  // Get option symbol
  try {
    const { validateAndGetOptionSymbol } = require("../config/instrument");
    const optResult = await validateAndGetOptionSymbol(spot, side, 'swing');
    const symbol = optResult.symbol;
    const qty = parseInt(process.env.NIFTY_LOT_SIZE || "65") * parseInt(process.env.LOT_MULTIPLIER || "1");

    log(`🖐️ [PAPER] MANUAL ENTRY ${side} by user @ spot ₹${spot} | SL: ₹${sarSL} | Symbol: ${symbol}`);
    simulateBuy(symbol, side, qty, spot, `Manual ${side} entry by user | SL=₹${sarSL}`, sarSL, spot, true);

    return res.json({ success: true, spot: spot, side: side, sl: sarSL, symbol: symbol });
  } catch (e) {
    log(`❌ [PAPER] Manual entry failed: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /swing-paper/status
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
      : "<div style=\"color:#4a6080;\">—</div>";
    const expiryStr = t.optionExpiry
      ? "<div style=\"font-size:0.68rem;color:#f59e0b;margin-top:2px;\">" + t.optionExpiry + "</div>"
      : "";

    // Entry prices: NIFTY spot + Option premium
    const entryNifty  = t.spotAtEntry  || t.entryPrice;
    const entryOption = t.optionEntryLtp;
    const entryCell   =
      "<div style=\"font-size:0.75rem;color:#4a6080;\">NIFTY</div>" +
      "<div style=\"font-weight:700;color:#c8d8f0;\">" + inr(entryNifty) + "</div>" +
      "<div style=\"font-size:0.68rem;color:#4a6080;margin-top:4px;\">Option</div>" +
      "<div style=\"font-weight:700;color:#60a5fa;\">" + (entryOption ? inr(entryOption) : "—") + "</div>" +
      (t.stopLoss ? "<div style=\"font-size:0.65rem;color:#f59e0b;margin-top:3px;\">SL " + inr(t.stopLoss) + "</div>" : "");

    // Exit prices: NIFTY spot + Option premium + movement pts
    const exitNifty  = t.spotAtExit;
    const exitOption = t.optionExitLtp;
    const optPtsDiff = (entryOption && exitOption)
      ? parseFloat((exitOption - entryOption).toFixed(2))
      : null;
    const ptColor    = optPtsDiff === null ? "#4a6080" : optPtsDiff >= 0 ? "#10b981" : "#ef4444";
    const exitCell   =
      "<div style=\"font-size:0.75rem;color:#4a6080;\">NIFTY</div>" +
      "<div style=\"font-weight:700;color:#c8d8f0;\">" + inr(exitNifty) + "</div>" +
      "<div style=\"font-size:0.68rem;color:#4a6080;margin-top:4px;\">Option</div>" +
      "<div style=\"font-weight:700;color:#60a5fa;\">" + (exitOption ? inr(exitOption) : "—") + "</div>" +
      (optPtsDiff !== null ? "<div style=\"font-size:0.65rem;color:" + ptColor + ";margin-top:2px;\">" +
        (optPtsDiff >= 0 ? "▲ +" : "▼ ") + optPtsDiff.toFixed(2) + " pts</div>" : "");

    // PnL: final ₹ + brokerage note
    const pnlCell =
      "<div style=\"font-size:1rem;font-weight:800;color:" + pc + "\">" +
        (t.pnl >= 0 ? "+" : "") + inr(t.pnl) + "</div>" +
      "<div style=\"font-size:0.65rem;color:#4a6080;margin-top:2px;\">after charges</div>";

    return "<tr style='border-top:1px solid #1a2236;vertical-align:top;'>" +
      "<td style='padding:10px 12px;'>" + sideBadge + "</td>" +
      "<td style='padding:10px 12px;'>" + strikeStr + expiryStr + "</td>" +
      "<td style='padding:10px 12px;font-size:0.75rem;color:#c8d8f0;'>" + (t.entryTime || "—") + "</td>" +
      "<td style='padding:10px 12px;font-size:0.75rem;color:#c8d8f0;'>" + (t.exitTime  || "—") + "</td>" +
      "<td style='padding:10px 12px;'>" + entryCell + "</td>" +
      "<td style='padding:10px 12px;'>" + exitCell  + "</td>" +
      "<td style='padding:10px 12px;'>" + pnlCell   + "</td>" +
      "<td style='padding:10px 12px;font-size:0.72rem;color:#4a6080;'>" + why + "</td>" +
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

/**
 * GET /swing-paper/status/chart-data
 * Returns candle history + trade markers for the lightweight-charts widget.
 * Called every 4 s by the chart polling loop on the status page.
 */
router.get("/status/chart-data", (req, res) => {
  try {
    // Closed candles + the currently forming bar
    const candles = ptState.candles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low:  c.low,
      close: c.close,
    }));
    // Only include the partial currentBar during market hours — pre-market quotes
    // produce a wide-spread junk spike on the chart.
    if (ptState.currentBar && (ptState._simMode || isMarketHours())) {
      candles.push({
        time:  ptState.currentBar.time,
        open:  ptState.currentBar.open,
        high:  ptState.currentBar.high,
        low:   ptState.currentBar.low,
        close: ptState.currentBar.close,
      });
    }

    // EMA9 overlay — same period as the strategy
    const EMA9_PERIOD = 9;
    let ema9Series = [];
    if (candles.length >= EMA9_PERIOD) {
      try {
        // Strategy uses OHLC4 — keep parity so the line matches signal-time values
        const ohlc4 = candles.map(c => (c.open + c.high + c.low + c.close) / 4);
        const arr = EMA.calculate({ period: EMA9_PERIOD, values: ohlc4 });
        const off = candles.length - arr.length;
        for (let i = 0; i < arr.length; i++) {
          ema9Series.push({ time: candles[i + off].time, value: parseFloat(arr[i].toFixed(2)) });
        }
      } catch (_) { /* ignore */ }
    }

    // PSAR overlay — same params as the strategy (step=0.02, max=0.2)
    let sarPoints = [];
    if (candles.length >= 3) {
      try {
        const sarArr = PSAR.calculate({ step: 0.02, max: 0.2, high: candles.map(c => c.high), low: candles.map(c => c.low) });
        const off = candles.length - sarArr.length;
        for (let i = 0; i < sarArr.length; i++) {
          sarPoints.push({ time: candles[i + off].time, value: parseFloat(sarArr[i].toFixed(2)) });
        }
      } catch (_) { /* ignore */ }
    }

    // Trade markers: entry + exit points from today's session
    const markers = [];
    for (const t of ptState.sessionTrades) {
      // Entry marker
      if (t.entryPrice && t.entryBarTime) {
        markers.push({
          time:     t.entryBarTime,
          position: 'belowBar',
          color:    '#3b82f6',
          shape:    'arrowUp',
          text:     `${t.side} @ ${t.entryPrice.toFixed(0)}`,
        });
      }
      // Exit marker
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

    // Stop-loss line — current SL if position is open
    let stopLoss = null;
    if (ptState.position && ptState.position.stopLoss) {
      stopLoss = ptState.position.stopLoss;
    }

    // Entry price line — if position is open
    let entryPrice = null;
    if (ptState.position && ptState.position.entryPrice) {
      entryPrice = ptState.position.entryPrice;
    }

    return res.json({ candles, markers, stopLoss, entryPrice, ema9: ema9Series, sar: sarPoints });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /swing-paper/status/data
 * JSON-only endpoint for AJAX polling — returns all dynamic state without HTML.
 * Called every 2 s by the client-side setInterval when trading is active.
 */
router.get("/status/data", (req, res) => {
  try {
    const data     = loadPaperData();

    // Unrealised PnL (mirrors /status logic, minus charges)
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
    // optStopPrice: same 50%-mid logic as the live stop — optionSL = entryLtp - |entrySpot - prevMid|
    const _optSp     = pos ? pos.spotAtEntry  : null;
    const _optPm     = pos ? pos.entryPrevMid : null;
    const optStopPrice = (optEntryLtp && _optSp && _optPm)
      ? parseFloat((optEntryLtp - Math.max(Math.abs(_optSp - _optPm), 20)).toFixed(2))
      : optEntryLtp ? parseFloat((optEntryLtp * (1 - _OPT_STOP_PCT)).toFixed(2)) : null;
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
      consecutiveLosses: ptState._consecutiveLosses || 0,
      pauseUntilTime:    ptState._pauseUntilTime || null,
      dailyLossHit:      ptState._dailyLossHit || false,
      simMode:           ptState._simMode || false,
      simScenario:       ptState._simScenario || null,
      sessionStart:      ptState.sessionStart,
      tradeCount:        ptState.sessionTrades.length,
      wins:              ptState._sessionWins,
      losses:            ptState._sessionLosses,
      capital:           data.capital,
      totalPnl:          data.totalPnl,
      // Position block (null when flat)
      position: pos ? {
        side:              pos.side,
        symbol:            pos.symbol,
        qty:               pos.qty,
        entryPrice:        pos.entryPrice,
        entryTime:         pos.entryTime,
        stopLoss:          pos.stopLoss,
        optionStrike:      pos.optionStrike,
        optionExpiry:      pos.optionExpiry,
        optionType:        pos.optionType,
        optionEntryLtp:    optEntryLtp,
        optionCurrentLtp:  optCurrentLtp,
        optionEntryLtpTime: pos.optionEntryLtpTime || null,
        optPremiumPnl,
        optPremiumMove,
        optPremiumPct,
        optStopPrice,
        optStopPct:        (_optSp && _optPm) ? Math.abs(_optSp - _optPm).toFixed(1) + 'pt (50% mid)' : '20% fallback',
        liveClose,
        pointsMoved,
        bestPrice:         pos.bestPrice || null,
        reason:            pos.reason || null,
      } : null,
      // Current forming bar
      currentBar: ptState.currentBar ? {
        open:  ptState.currentBar.open,
        high:  ptState.currentBar.high,
        low:   ptState.currentBar.low,
        close: ptState.currentBar.close,
      } : null,
      // Trades (mapped for client-side display — cached to avoid rebuild when trade count hasn't changed)
      trades: _getCachedTradesForPoll(),
      // Activity log — last 100 entries newest-first (avoids copying/reversing full 2000-entry buffer on every 2s poll)
      logTotal: ptState.log.length,
      logs: reverseSlice(ptState.log, 100),
    });
  } catch (err) {
    console.error("[paperTrade/status/data] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/status", (req, res) => {
  try {
  const strategy = getActiveStrategy();
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

  // VIX details for top-bar display
  const _vix          = getCachedVix();
  const _vixEnabled   = vixFilter.VIX_ENABLED;
  const _vixMaxEntry  = vixFilter.VIX_MAX_ENTRY;
  const _vixStrongOnly = vixFilter.VIX_STRONG_ONLY;

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
  // optStopPrice for HTML: same 50%-mid logic
  const _h_sp   = pos ? pos.spotAtEntry  : null;
  const _h_pm   = pos ? pos.entryPrevMid : null;
  const optStopPrice = (optEntryLtp && _h_sp && _h_pm)
    ? parseFloat((optEntryLtp - Math.max(Math.abs(_h_sp - _h_pm), 20)).toFixed(2))
    : optEntryLtp ? parseFloat((optEntryLtp * (1 - _OPT_STOP_PCT)).toFixed(2)) : null;
  const optStopPct   = (_h_sp && _h_pm)
    ? Math.abs(_h_sp - _h_pm).toFixed(1) + 'pt (50% mid)'
    : Math.round(_OPT_STOP_PCT * 100) + '% fallback';

  const posHtml = pos ? `
    <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">

      <!-- Header: status + entry time + MANUAL EXIT BUTTON -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 1.5s infinite;"></span>
          <span style="font-size:0.8rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;">Open Position</span>
          <span style="font-size:0.72rem;color:#4a6080;">Since ${fmtT(pos.entryTime)}</span>
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
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Strike</div>
            <div style="font-size:1.6rem;font-weight:800;color:#fff;font-family:monospace;">${pos.optionStrike ? pos.optionStrike.toLocaleString("en-IN") : "—"}</div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Expiry</div>
            <div style="font-size:1.1rem;font-weight:700;color:#f59e0b;">${pos.optionExpiry || "—"}</div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Qty / Lots</div>
            <div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty} <span style="font-size:0.72rem;color:#4a6080;">(${(pos.qty / 65).toFixed(0)} lot)</span></div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;flex-shrink:0;"></div>
          <div style="flex:1;min-width:200px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Full Symbol</div>
            <div style="font-size:0.82rem;font-weight:600;color:#c8d8f0;font-family:monospace;word-break:break-all;">${pos.symbol}</div>
          </div>
        </div>
      </div>

      <!-- ★ OPTION PREMIUM SECTION — most important block ★ -->
      <div style="background:#0a0f24;border:2px solid #3b82f6;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
        <div style="font-size:0.68rem;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">📊 Option Premium (${pos.optionType} Price)</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">

          <!-- Entry Premium -->
          <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid #1e3a5f;border-radius:10px;">
            <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Entry Price</div>
            <div id="ajax-opt-entry-ltp" style="font-size:2rem;font-weight:800;color:#60a5fa;font-family:monospace;line-height:1;">
              ${optEntryLtp ? "₹" + optEntryLtp.toFixed(2) : "<span style='font-size:1rem;color:#f59e0b;'>Fetching...</span>"}
            </div>
            <div style="font-size:0.68rem;color:#4a6080;margin-top:4px;">
              ${optEntryLtp
                ? `captured at ${fmtT(pos.optionEntryLtpTime || pos.entryTime)}`
                : `⏳ first REST poll in ~3s<br><span style='color:#c8d8f0;'>NIFTY entry: ${inr(pos.entryPrice)}</span>`}
            </div>
          </div>

          <!-- Arrow -->
          <div style="text-align:center;font-size:1.8rem;color:${optPremiumMove !== null ? (optPremiumMove >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};">
            ${optPremiumMove !== null ? (optPremiumMove >= 0 ? "→" : "→") : "→"}
          </div>

          <!-- Current Premium -->
          <div style="text-align:center;padding:12px;background:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#071a0f" : "#1a0707") : "#0d1320"};border:2px solid ${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};border-radius:10px;">
            <div style="font-size:0.63rem;color:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Current LTP</div>
            <div id="ajax-opt-current-ltp" style="font-size:2rem;font-weight:800;color:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">
              ${optCurrentLtp ? "₹" + optCurrentLtp.toFixed(2) : "⏳"}
            </div>
            <div id="ajax-opt-move" style="font-size:0.72rem;font-weight:700;margin-top:6px;color:${optPremiumMove !== null ? (optPremiumMove >= 0 ? "#10b981" : "#ef4444") : "#f59e0b"};">
              ${optPremiumMove !== null ? (optPremiumMove >= 0 ? "▲ +" : "▼ ") + "₹" + Math.abs(optPremiumMove).toFixed(2) + " pts" : optCurrentLtp ? "⏳ Awaiting entry price..." : "⏳ Polling REST feed..."}
            </div>
            <div id="ajax-opt-pct" style="font-size:1.1rem;font-weight:800;margin-top:4px;color:${optPremiumPct !== null ? (optPremiumPct >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};font-family:monospace;">
              ${optPremiumPct !== null ? (optPremiumPct >= 0 ? "+" : "") + optPremiumPct.toFixed(2) + "%" : "—"}
            </div>
          </div>

          <!-- Option P&L -->
          <div style="text-align:center;padding:12px;background:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#071a0f" : "#1a0707") : "#0d1320"};border:1px solid ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#065f46" : "#7f1d1d") : "#1a2236"};border-radius:10px;">
            <div style="font-size:0.63rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Unrealised P&L</div>
            <div id="ajax-opt-pnl" style="font-size:1.8rem;font-weight:800;color:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">
              ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "+" : "") + "₹" + optPremiumPnl.toLocaleString("en-IN", {minimumFractionDigits:2, maximumFractionDigits:2}) : "—"}
            </div>
            <div style="font-size:0.65rem;color:#4a6080;margin-top:4px;">${pos.qty} qty · after charges</div>
          </div>

        </div>
      </div>

      <!-- Secondary grid: NIFTY spot + SAR SL + Trail -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px;">
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY Spot @ Entry</div>
          <div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(pos.entryPrice)}</div>
          <div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">candle close</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY LTP</div>
          <div id="ajax-nifty-ltp" style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(liveClose)}</div>
          <div id="ajax-nifty-move" style="font-size:0.63rem;color:${pointsMoved >= 0 ? "#10b981" : "#ef4444"};margin-top:2px;">${pointsMoved >= 0 ? "▲" : "▼"} ${Math.abs(pointsMoved).toFixed(1)} pts</div>
        </div>
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop Loss (prev-candle)</div>
          <div id="ajax-stop-loss" style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.stopLoss ? inr(pos.stopLoss) : "—"}</div>
          <div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">Risk: ${pos.stopLoss ? inr(Math.abs(pos.entryPrice - pos.stopLoss) * pos.qty) : "—"}</div>
        </div>
        <div style="background:#1c0d00;border:1px solid #92400e;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Option SL (${optStopPct})</div>
          <div id="ajax-opt-sl" style="font-size:1.05rem;font-weight:700;color:#f97316;">${optStopPrice ? "₹" + optStopPrice.toFixed(2) : "—"}</div>
          <div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">${optEntryLtp ? "entry 20b9" + optEntryLtp.toFixed(2) + " 2212 " + optStopPct : "awaiting entry LTP"}</div>
        </div>
        <div id="ajax-trail-card" data-be="${parseFloat(process.env.BREAKEVEN_PTS || "25")}" style="background:#071a12;border:1px solid ${trailProfit >= parseFloat(process.env.BREAKEVEN_PTS || "25") ? "#8b5cf6" : "#134e35"};border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Trailing Stop</div>
          <div id="ajax-trail-status" style="font-size:0.88rem;font-weight:700;color:${trailProfit >= parseFloat(process.env.BREAKEVEN_PTS || "25") ? "#8b5cf6" : "#f59e0b"};">${trailProfit >= parseFloat(process.env.BREAKEVEN_PTS || "25") ? "🔒 Breakeven+" : "Prev-candle " + (pos.side === "CE" ? "low" : "high")}</div>
          <div id="ajax-trail-best" style="font-size:0.63rem;color:#4a6080;margin-top:2px;">Best: ${pos.bestPrice ? inr(pos.bestPrice) : "—"} (${trailProfit >= 0 ? "+" : ""}${trailProfit.toFixed(1)} pts)</div>
          <div id="ajax-trail-activate" style="font-size:0.63rem;color:#4a6080;margin-top:2px;">Trails prev-candle ${pos.side === "CE" ? "low" : "high"} | Breakeven at +${parseFloat(process.env.BREAKEVEN_PTS || "25")}pt</div>
        </div>
      </div>

      ${pos.reason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;">📝 ${pos.reason}</div>` : ""}
    </div>` : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:1.5rem;margin-bottom:8px;">📭</div>
      <div style="font-size:0.9rem;font-weight:600;color:#4a6080;margin-bottom:14px;">FLAT — Waiting for entry signal</div>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button onclick="manualEntry('CE')" style="padding:8px 24px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▲ Manual CE</button>
        <button onclick="manualEntry('PE')" style="padding:8px 24px;background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▼ Manual PE</button>
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
  <script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
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
    .cap-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.5px;color:#2a3a20;margin-bottom:4px;}
    .cap-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#a0c880;}
    .cap-val.white{color:#c0d8b0;}
    .cap-val.green{color:#7ab850;}

    /* ── STAT CARDS ── */
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-bottom:16px;}
    .sc{background:#090f09;border:0.5px solid #162416;border-radius:8px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;right:0;height:1.5px;background:var(--at,#1a3010);}
    .sc-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.2px;color:#2a3a20;margin-bottom:5px;}
    .sc-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#c0d8b0;}
    .sc-sub{font-size:0.6rem;color:#2a3a20;margin-top:3px;}

    /* ── SECTION TITLE ── */
    .section-title{font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#2a3a20;margin-bottom:8px;display:flex;align-items:center;gap:8px;}
    .section-title::after{content:'';flex:1;height:0.5px;background:#162416;}

    /* ── COPY / TOGGLE BUTTONS ── */
    .copy-btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;transition:all 0.15s;white-space:nowrap;}
    .copy-btn:hover{background:#0a1e3d;border-color:#3b82f6;}
    .copy-btn.copied{background:#064e3b;border-color:#10b981;color:#10b981;}

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
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('swingPaper', sharedSocketState.getMode()==='SWING_LIVE', ptState.running, {
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
      <div class="top-bar-meta">Strategy: ${ACTIVE} — ${strategy.NAME} · ${getTradeResolution()}-min candles · ${ptState.running ? 'Auto-refreshes every 2s' : 'Stopped'}</div>
    </div>
    <div class="top-bar-right">
      ${ptState.running
        ? '<span class="top-bar-badge paper-active"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>RUNNING</span>'
        : '<span class="top-bar-badge">● IDLE</span>'}
      ${_vixEnabled ? `<span class="top-bar-badge" style="border-color:${_vix == null ? 'rgba(100,116,139,0.3)' : _vix > _vixMaxEntry ? 'rgba(239,68,68,0.3)' : _vix > _vixStrongOnly ? 'rgba(234,179,8,0.3)' : 'rgba(16,185,129,0.3)'};background:${_vix == null ? 'rgba(100,116,139,0.08)' : _vix > _vixMaxEntry ? 'rgba(239,68,68,0.1)' : _vix > _vixStrongOnly ? 'rgba(234,179,8,0.1)' : 'rgba(16,185,129,0.1)'};color:${_vix == null ? '#94a3b8' : _vix > _vixMaxEntry ? '#ef4444' : _vix > _vixStrongOnly ? '#eab308' : '#10b981'};">🌡️ VIX ${_vix != null ? _vix.toFixed(1) : 'n/a'}${_vix != null ? (_vix > _vixMaxEntry ? ' · BLOCKED' : _vix > _vixStrongOnly ? ' · STRONG ONLY' : ' · NORMAL') : ''}</span>` : ''}
      <a href="/swing-paper/history" style="background:rgba(59,130,246,0.08);border:0.5px solid rgba(59,130,246,0.3);color:#60a5fa;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;text-decoration:none;font-family:inherit;">📊 History</a>
      <button onclick="ptHandleReset(this)" style="background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;">↺ Reset</button>
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
    <div class="cap-cell" style="font-size:0.62rem;color:#1a2a18;max-width:180px;line-height:1.5;display:flex;align-items:center;">Capital updates when sessions complete. Reset wipes history.</div>
  </div>

  <div class="stat-grid" style="margin-bottom:20px;">
    <div class="sc" style="border-top:2px solid ${pnlColor(ptState.sessionPnl)};" id="ajax-sc-pnl">
      <div class="sc-label">Session PnL</div>
      <div class="sc-val" id="ajax-session-pnl" style="color:${pnlColor(ptState.sessionPnl)};">${inr(ptState.sessionPnl)}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #6a5090;">
      <div class="sc-label">Trades Today</div>
      <div class="sc-val"><span id="ajax-trade-count">${ptState.sessionTrades.length}</span> <span style="font-size:0.75rem;color:#4a6080;">/ ${process.env.MAX_DAILY_TRADES || 20}</span></div>
      <div id="ajax-wl" style="font-size:0.7rem;color:#4a6080;margin-top:4px;">${ptState._sessionWins}W &middot; ${ptState._sessionLosses}L</div>
    </div>
    <div class="sc" style="border-top:2px solid ${(ptState._consecutiveLosses||0) >= 2 ? '#ef4444' : '#4a6080'};" id="ajax-sc-cl">
      <div class="sc-label">Loss Streak</div>
      <div class="sc-val" id="ajax-consec-losses" style="color:${(ptState._consecutiveLosses||0) >= 2 ? '#ef4444' : '#fff'}">${ptState._consecutiveLosses || 0} / 3</div>
      <div id="ajax-cl-status" style="font-size:0.7rem;margin-top:4px;color:${ptState._pauseUntilTime && Date.now() < ptState._pauseUntilTime ? '#f59e0b' : '#4a6080'}">${ptState._pauseUntilTime && Date.now() < ptState._pauseUntilTime ? '⏸ PAUSED' : (ptState._consecutiveLosses||0) >= 2 ? '⚠️ 1 more = pause' : '✅ OK'}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${ptState._dailyLossHit ? '#ef4444' : '#10b981'};" id="ajax-sc-dloss">
      <div class="sc-label">Daily Loss Limit</div>
      <div class="sc-val" id="ajax-daily-loss-val" style="color:${ptState._dailyLossHit ? '#ef4444' : '#fff'}">${inr(-(process.env.MAX_DAILY_LOSS || 5000))}</div>
      <div id="ajax-daily-loss-status" style="font-size:0.7rem;margin-top:4px;color:${ptState._dailyLossHit ? '#ef4444' : '#10b981'}">${ptState._dailyLossHit ? '🛑 KILLED — no entries' : '✅ Active'}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #a07010;">
      <div class="sc-label">Candles Loaded</div>
      <div class="sc-val" id="ajax-candle-count" style="color:${ptState.candles.length >= 30 ? '#10b981' : '#f59e0b'}">${ptState.candles.length}</div>
      <div id="ajax-candle-status" style="font-size:0.7rem;color:${ptState.candles.length >= 30 ? "#10b981" : "#f59e0b"};margin-top:4px;">${ptState.candles.length >= 30 ? `✅ Strategy ready` : "⚠️ Warming up..."}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #2a6080;">
      <div class="sc-label">WebSocket Ticks</div>
      <div class="sc-val" id="ajax-tick-count">${ptState.tickCount.toLocaleString()}</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">Last: <span id="ajax-last-tick">${ptState.lastTickPrice ? inr(ptState.lastTickPrice) : "—"}</span></div>
    </div>
    <div class="sc" style="border-top:1.5px solid #2a4020;">
      <div class="sc-label">Session Start</div>
      <div class="sc-val" style="font-size:0.85rem;color:#c8d8f0;">${fmtT(ptState.sessionStart)}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #8a2020;">
      <div class="sc-label">Prev Candle High</div>
      <div class="sc-val" id="ajax-prev-high" style="font-size:1rem;color:#ef4444;">${ptState.prevCandleHigh ? inr(ptState.prevCandleHigh) : "—"}</div>
      <div style="font-size:0.68rem;color:#4a6080;margin-top:4px;">Last closed candle high</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #5a9030;">
      <div class="sc-label">Prev Candle Low</div>
      <div class="sc-val" id="ajax-prev-low" style="font-size:1rem;color:#10b981;">${ptState.prevCandleLow ? inr(ptState.prevCandleLow) : "—"}</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">Last closed candle low</div>
    </div>
  </div>
  <div id="ajax-position-section">
    ${posHtml}
  </div>
  </div>

  ${ptState.currentBar ? `
  <div style="margin-bottom:24px;">
    <div class="section-title">Current ${getTradeResolution()}-Min Bar (forming)</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
      ${["open","high","low","close"].map(k => `
      <div class="sc">
        <div class="sc-label">${k.toUpperCase()}</div>
        <div class="sc-val" id="ajax-bar-${k}" style="font-size:1rem;">${inr(ptState.currentBar[k])}</div>
      </div>`).join("")}
    </div>
  </div>` : `
  <div style="margin-bottom:24px;" id="ajax-bar-container">
    <div class="section-title">Current ${getTradeResolution()}-Min Bar (forming)</div>
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
    <div class="section-title">NIFTY ${getTradeResolution()}-Min Chart</div>
    <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
      <div id="nifty-chart" style="width:100%;height:100%;"></div>
      <div id="chart-legend" style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
        <span style="color:#3b82f6;">▲ Entry</span> &nbsp;
        <span style="color:#10b981;">▼ Win</span> &nbsp;
        <span style="color:#ef4444;">▼ Loss</span> &nbsp;
        <span style="color:#fbbf24;">── EMA9</span> &nbsp;
        <span style="color:#a78bfa;">· SAR</span> &nbsp;
        <span style="color:#f59e0b;">── SL</span> &nbsp;
        <span style="color:#3b82f6;">-- Entry Price</span>
      </div>
    </div>
  </div>` : ""}

  ${ptState.sessionTrades.length > 0 ? `
  <div style="margin-bottom:24px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
      <div class="section-title" style="margin-bottom:0;">Today's Trades</div>
      <select id="ptSide" onchange="ptFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All Sides</option><option value="CE">CE</option><option value="PE">PE</option>
      </select>
      <select id="ptResult" onchange="ptFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All</option><option value="win">Wins</option><option value="loss">Losses</option>
      </select>
      <select id="ptPerPage" onchange="ptFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="5">5/page</option><option value="10" selected>10/page</option><option value="25">25/page</option><option value="999999">All</option>
      </select>
      <span id="ptCount" style="font-size:0.72rem;color:#4a6080;"></span>
      <button class="copy-btn" onclick="copyTradeLog(this)" style="margin-left:auto;">📋 Copy Trade Log</button>
    </div>
    <div style="border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#0a0f1c;">
          <th onclick="ptSort('side')"   style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Side ▲▼</th>
          <th onclick="ptSort('entry')"  style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Date ▼</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry Time</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit</th>
          <th onclick="ptSort('exit')"   style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Exit Time ▲▼</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">SL</th>
          <th onclick="ptSort('pnl')"    style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">PnL ₹ ▲▼</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry Reason</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit Reason</th>
          <th style="padding:9px 12px;text-align:center;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Action</th>
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
            <span style="font-size:0.65rem;color:#4a6080;margin-left:10px;">📋 Paper Trade — Full Details</span>
          </div>
          <button onclick="document.getElementById('ptModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:#4a6080;font-size:1rem;cursor:pointer;padding:4px 10px;border-radius:6px;font-family:inherit;" onmouseover="this.style.color='#ef4444';this.style.borderColor='#ef4444'" onmouseout="this.style.color='#4a6080';this.style.borderColor='#1a2236'">✕ Close</button>
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
      ? '<tr><td colspan="11" style="text-align:center;padding:20px;color:#4a6080;">No trades match filters.</td></tr>'
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
            <td style="padding:8px 12px;font-size:0.7rem;color:#4a6080;" title="\${t.entryReason||''}">\${t.entryReason?(t.entryReason.length>25?t.entryReason.slice(0,25)+'\u2026':t.entryReason):'—'}</td>
            <td style="padding:8px 12px;font-size:0.7rem;color:#4a6080;" title="\${t.reason}">\${short||'—'}</td>
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
        + '<div style="font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:5px;">' + label + '</div>'
        + '<div style="font-size:0.9rem;font-weight:700;color:' + (color||'#e0eaf8') + ';font-family:monospace;line-height:1.3;">' + (val||'—') + '</div>'
        + (sub ? '<div style="font-size:0.62rem;color:#4a6080;margin-top:3px;">' + sub + '</div>' : '')
        + '</div>';
    }

    // ── Section: Option Contract ─────────────────────────────────────────
    const contractHtml = '<div style="background:#06100e;border:1px solid #0d3020;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
      + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a6040;margin-bottom:8px;font-weight:700;">📋 Option Contract</div>'
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
      + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a4080;margin-bottom:8px;font-weight:700;">🟢 Entry</div>'
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
      + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#801a20;margin-bottom:8px;font-weight:700;">🔴 Exit</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
      + cell('Exit Time', t.exit || '—', '#c8d8f0')
      + cell('NIFTY Spot @ Exit', fmt(t.xSpot), '#fff', 'Index price at exit')
      + cell('Option LTP @ Exit', fmt(t.xOpt), '#60a5fa', 'Option premium at exit')
      + cell('NIFTY Move (pts)', pnlPts != null ? (pnlPts >= 0 ? '+' : '') + pnlPts + ' pts' : '—', pnlPts != null ? (pnlPts >= 0 ? '#10b981' : '#ef4444') : '#c8d8f0', t.side === 'PE' ? 'Entry−Exit (PE profits on fall)' : 'Exit−Entry (CE profits on rise)')
      + cell('Option Δ (pts)', optDiff != null ? (optDiff >= 0 ? '▲ +' : '▼ ') + optDiff + ' pts' : '—', dc, 'Exit prem − Entry prem')
      + cell('Net PnL', t.pnl != null ? (t.pnl >= 0 ? '+' : '') + fmt(t.pnl) : '—', pc, 'After STT + charges')
      + '</div></div>';

    // ── Section: Exit Reason ─────────────────────────────────────────────
    const reasonHtml = '<div style="background:#060910;border:1px solid #1a2236;border-radius:10px;padding:12px 14px;">'
      + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#3a5070;margin-bottom:6px;font-weight:700;">📌 Exit Reason</div>'
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
      <span id="logCount" style="font-size:0.7rem;color:#4a6080;"></span>
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
  if(slice.length===0){ box.innerHTML='<div style="color:#4a6080;font-size:0.78rem;">No entries match.</div>'; document.getElementById('logPag').innerHTML=''; return; }
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
<script src="/swing-paper/client.js"></script>
<script>
// ── NIFTY Chart (Lightweight Charts by TradingView) ─────────────────────────
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  const container = document.getElementById('nifty-chart');
  if (!container) return;

  const chart = LightweightCharts.createChart(container, {
    width:  container.clientWidth,
    height: container.clientHeight,
    layout: { background: { type: 'solid', color: '#0a0f1c' }, textColor: '#4a6080', fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" },
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

  // EMA9 (strategy's primary trend line) + PSAR dots
  const ema9Series = chart.addLineSeries({ color:'#fbbf24', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  const sarSeries  = chart.addLineSeries({ color:'#a78bfa', lineWidth:1, lineStyle: LightweightCharts.LineStyle.Dotted, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });

  // SL line
  let slLine = null;
  // Entry price line
  let entryLine = null;

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
      const res = await fetch('/swing-paper/status/chart-data', { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();

      if (!d.candles || d.candles.length === 0) return;

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
      if (d.ema9 && d.ema9.length) ema9Series.setData(d.ema9); else ema9Series.setData([]);
      if (d.sar  && d.sar.length)  sarSeries.setData(d.sar);   else sarSeries.setData([]);

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

      // Restore user's manual zoom/pan, then release the internal-update flag
      if (_userRange) { try { chart.timeScale().setVisibleLogicalRange(_userRange); } catch(_) {} }
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
<script>
// ── AJAX live refresh — replaces meta http-equiv="refresh" ──────────────────
// Polls /swing-paper/status/data every 2 s when trading is active.
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
      const res = await fetch('/swing-paper/status/data', { cache: 'no-store' });
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

      const clEl = document.getElementById('ajax-consec-losses');
      if (clEl) {
        clEl.textContent = (d.consecutiveLosses || 0) + ' / 3';
        clEl.style.color = d.consecutiveLosses >= 2 ? '#ef4444' : '#fff';
        const card = clEl.closest('.sc');
        if (card) card.style.borderTopColor = d.consecutiveLosses >= 2 ? '#ef4444' : '#4a6080';
      }
      const clStatus = document.getElementById('ajax-cl-status');
      if (clStatus) {
        const paused = d.pauseUntilTime && Date.now() < d.pauseUntilTime;
        clStatus.textContent = paused ? '\u23f8 PAUSED' : d.consecutiveLosses >= 2 ? '\u26a0\ufe0f 1 more = pause' : '\u2705 OK';
        clStatus.style.color = paused ? '#f59e0b' : '#4a6080';
      }

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
        candleEl.textContent = d.candleCount;
        candleEl.style.color = d.candleCount >= 30 ? '#10b981' : '#f59e0b';
        const sub = document.getElementById('ajax-candle-status');
        if (sub) {
          sub.textContent = d.candleCount >= 30 ? '\u2705 Strategy ready' : '\u26a0\ufe0f Warming up...';
          sub.style.color = d.candleCount >= 30 ? '#10b981' : '#f59e0b';
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
        // Option SL price
        const optSlEl = document.getElementById('ajax-opt-sl');
        if (optSlEl) {
          optSlEl.textContent = p.optStopPrice ? '\u20b9' + p.optStopPrice.toFixed(2) : '\u2014';
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
          const bePts       = parseFloat(trailCard.dataset.be || '25');
          const beOn        = tProfDir >= bePts;
          const sideRef     = p.side === 'CE' ? 'low' : 'high';
          trailCard.style.borderColor = beOn ? '#8b5cf6' : '#134e35';
          trailStat.textContent  = beOn ? '\uD83D\uDD12 Breakeven+' : 'Prev-candle ' + sideRef;
          trailStat.style.color  = beOn ? '#8b5cf6' : '#f59e0b';
          const pts = tProfDir >= 0 ? '+' + tProfit.toFixed(1) : tProfit.toFixed(1);
          trailBest.textContent  = tActive ? 'Best: \u20b9' + p.bestPrice.toLocaleString('en-IN') + ' (' + pts + ' pts)' : 'Best: \u2014 (+0.0 pts)';
          if (trailAct) trailAct.textContent = 'Trails prev-candle ' + sideRef + ' | Breakeven at +' + bePts + 'pt';
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
 * GET /swing-paper/history
 * All past paper trade sessions with summary stats
 */
router.get("/history", (req, res) => {
  const data = loadPaperData();
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  res.setHeader("Content-Type", "text/html");
  res.send(renderHistoryPage({
    routePrefix: "/swing-paper",
    sidebarKey: "swingHistory",
    pageTitle: "📊 Swing Paper Trade History",
    pageDocTitle: "Swing Paper — History",
    modalLabel: "Swing Paper",
    liveActive,
    sessions: data.sessions || [],
    capital: data.capital,
    totalPnl: data.totalPnl,
    startCap: getCapitalFromEnv(),
    emptyLabel: "Start swing paper trading to record your first session.",
  }));
});

/**
 * GET /swing-paper/download/trades.jsonl
 * Stream the crash-safe per-trade JSONL log as a file download.
 */
router.get("/download/trades.jsonl", (req, res) => {
  const logPath = tradeLogger.filePathFor("swing");
  const today   = new Date().toISOString().slice(0, 10);
  const dlName  = `swing_paper_trades_log_${today}.txt`;
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
  const skips  = skipLogger.listDates("swing");
  const trades = tradeLogger.listDailyDates("swing");
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
  const dlName = `swing_paper_skips_all_${today}.txt`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${dlName}"`);
  const dates = skipLogger.listDates("swing").map(d => d.date).sort();
  let body = "";
  for (const d of dates) {
    try {
      const p = skipLogger.filePathFor("swing", d);
      if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8");
    } catch (_) {}
  }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor("swing", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `swing_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor("swing", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `swing_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor("swing", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor("swing", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

/**
 * GET /swing-paper/reset
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

  log(`🔄 Paper trade data reset. Capital restored to ₹${freshCapital.toLocaleString("en-IN")}`);

  return res.json({
    success: true,
    message: `Paper trade history cleared. Capital reset to ₹${freshCapital.toLocaleString("en-IN")}`,
  });
});

/**
 * DELETE /swing-paper/session/:index
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

  log(`🗑️ Deleted swing paper session ${idx + 1} (${removed?.date || "unknown date"}, PnL: ${removedPnl})`);

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
  const allTrades = tradeLogger.readDailyTrades("swing", date);
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
    strategy:    missing[0]?.strategy || "STRATEGY_1",
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
  data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce(
    (sum, s) => sum + (s.sessionPnl != null ? s.sessionPnl : (s.pnl || 0)),
    0
  ).toFixed(2));
  data.capital = parseFloat((getCapitalFromEnv() + data.totalPnl).toFixed(2));
  savePaperData(data);
  log(`♻️ Restored swing paper session for ${date}: ${missing.length} trade(s), PnL ₹${sessionPnl}`);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

/**
 * GET /swing-paper/debug
 * Returns current state info to help diagnose why Start/Reset isn't working
 */
router.get("/debug", (req, res) => {
  const { getActiveStrategy, ACTIVE } = require("../strategies");
  res.json({
    running:          ptState.running,
    hasAccessToken:   !!process.env.ACCESS_TOKEN,
    hasAppId:         !!process.env.APP_ID,
    liveTradeActive:  sharedSocketState.isActive(),
    activeStrategy:   ACTIVE,
    tradeResolution:  getTradeResolution(),
    candlesLoaded:    ptState.candles.length,
    position:         ptState.position ? { side: ptState.position.side, entryPrice: ptState.position.entryPrice } : null,
    capital:          loadPaperData().capital,
    sessionPnl:       ptState.sessionPnl,
    isMarketHours:    isMarketHours(),
  });
});



/**
 * GET /swing-paper/client.js
 * Serves the paper trade UI JavaScript as a static file.
 * Keeping it separate prevents ANY data injection from breaking the buttons.
 */
router.get("/client.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-cache");
  res.send(`async function handleStart(btn, force) {
  if (btn) { btn.textContent = '⏳ Starting...'; btn.disabled = true; }
  try {
    const url = force ? '/swing-paper/start?force=1' : '/swing-paper/start';
    const res = await secretFetch(url);
    if (!res) { if (btn) { btn.textContent = '▶ Start'; btn.disabled = false; } return; }
    let data;
    try { data = await res.json(); } catch(_) { data = { success: false, error: 'Server error (non-JSON response)' }; }
    if (!data.success) {
      // 0DTE expiry-day warning — show confirm modal, retry with force=1 if accepted
      if (data.code === 'EXPIRY_DAY_0DTE') {
        const ok = await showConfirm({
          icon: '⚠️',
          title: '0DTE Expiry Day — Not Recommended',
          message: data.message + '\\n\\nDo you want to start anyway? (Strongly recommend: cancel and update Swing Option Expiry in Settings instead.)',
          confirmText: 'Start Anyway',
          confirmClass: 'modal-btn-danger'
        });
        if (!ok) {
          if (btn) { btn.textContent = '▶ Start'; btn.disabled = false; }
          return;
        }
        return handleStart(btn, true);  // retry with force=1
      }
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
    const res = await secretFetch('/swing-paper/stop');
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
    subject: 'ALL swing paper sessions & capital',
    secondConfirmText: 'Yes, reset all'
  });
  if (!ok) return;
  if (btn) { btn.textContent = '⏳...'; btn.disabled = true; }
  try {
    const res = await secretFetch('/swing-paper/reset');
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
      t.entryTime||'', t.exitTime||'',
      t.entryPrice||'', t.optionEntryLtp||'',
      t.spotAtExit||'', t.optionExitLtp||'',
      t.pnl!=null?t.pnl:'', t.reason||''
    ];
  });
  var csv = [header].concat(rows).map(function(r){
    return r.map(function(v){ return '"'+String(v||'').replace(/"/g,'""')+'"'; }).join(',');
  }).join('\\n');
  var d = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,\\uFEFF' + encodeURIComponent(csv);
  a.download = 'paper_trades_' + d + '.csv';
  a.click();
  showToast('✅ CSV downloaded — ' + PT.length + ' trades', '#10b981');
}
async function ptHandleExit(btn) {
  if (btn) { btn.textContent = '⏳ Exiting...'; btn.disabled = true; }
  try {
    const res = await secretFetch('/swing-paper/exit');
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
    const res = await secretFetch('/swing-paper/manualEntry', {
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



// CSV export route removed — server-side CSV no longer available.
// All console output is accessible via the /logs page.


// ── Simulation mode routes ─────────────────────────────────────────────────

router.get("/simulate", (req, res) => {
  if (ptState.running) return res.redirect("/swing-paper/status");

  const scenarios = tickSimulator.getScenarios();
  const cards = Object.entries(scenarios).map(([key, s]) => `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;cursor:pointer;transition:border-color 0.2s,background 0.2s;"
         onmouseover="this.style.borderColor='#f59e0b';this.style.background='#111b2e'"
         onmouseout="this.style.borderColor='#1a2236';this.style.background='#0d1320'"
         onclick="startSim('${key}')">
      <div style="font-size:1rem;font-weight:700;color:#e2e8f0;margin-bottom:6px;">${s.label}</div>
      <div style="font-size:0.78rem;color:#6b7fa0;line-height:1.5;">${s.desc}</div>
    </div>
  `).join("");

  const strategy = getActiveStrategy();

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Simulate — Paper Trade</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
${sidebarCSS()}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'IBM Plex Sans',sans-serif;background:#060810;color:#a0b8d8;min-height:100vh;}
.main-content{margin-left:220px;padding:32px 40px;}
@media(max-width:900px){.main-content{margin-left:0;padding:20px;}}
.sim-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin-top:20px;}
.config-row{display:flex;gap:16px;align-items:center;margin-top:24px;flex-wrap:wrap;}
.config-label{font-size:0.78rem;color:#6b7fa0;}
.config-input{background:#0d1320;border:1px solid #1a2236;border-radius:8px;padding:8px 14px;color:#e2e8f0;font-family:'IBM Plex Mono',monospace;font-size:0.85rem;width:120px;}
.sim-btn{background:#92400e;color:#fff;border:none;border-radius:8px;padding:12px 28px;font-size:0.9rem;font-weight:700;cursor:pointer;font-family:inherit;transition:background 0.15s;margin-top:16px;}
.sim-btn:hover{background:#b45309;}
.sim-btn:disabled{opacity:0.5;cursor:not-allowed;}
.selected{border-color:#f59e0b !important;background:#111b2e !important;box-shadow:0 0 0 2px #f59e0b44;}
</style>
</head><body>
<div class="app-shell">
${buildSidebar('swingPaper', false)}
<div class="main-content">
  <h1 style="font-size:1.4rem;font-weight:800;color:#e2e8f0;margin-bottom:4px;">Simulate — Paper Trade</h1>
  <p style="font-size:0.82rem;color:#6b7fa0;margin-bottom:4px;">Run <strong>${strategy.NAME}</strong> against fake ticks — no broker login needed. Works after market hours.</p>
  <p style="font-size:0.75rem;color:#4a6080;">Resolution: <strong>${TRADE_RES}-min</strong> candles | Instrument: ${instrumentConfig.INSTRUMENT}</p>

  <!-- ── Tab switcher ─────────────────────────────────────────────── -->
  <div style="display:flex;gap:0;margin-top:24px;border-bottom:2px solid #1a2236;">
    <button id="tabScenario" onclick="switchTab('scenario')" style="padding:10px 24px;font-size:0.82rem;font-weight:700;background:transparent;border:none;border-bottom:2px solid #f59e0b;color:#f59e0b;cursor:pointer;font-family:inherit;margin-bottom:-2px;">Synthetic Scenarios</button>
    <button id="tabHistory" onclick="switchTab('history')" style="padding:10px 24px;font-size:0.82rem;font-weight:700;background:transparent;border:none;border-bottom:2px solid transparent;color:#6b7fa0;cursor:pointer;font-family:inherit;margin-bottom:-2px;">Replay Historical Date</button>
  </div>

  <!-- ── Scenario tab ─────────────────────────────────────────────── -->
  <div id="panelScenario">
    <div style="font-size:0.75rem;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:1.5px;margin-top:20px;">Choose a Scenario</div>
    <div class="sim-grid" id="scenarioGrid">${cards}</div>
    <div class="config-row">
      <div>
        <div class="config-label">Base Price (NIFTY)</div>
        <input type="number" id="basePrice" value="24500" class="config-input"/>
      </div>
      <div>
        <div class="config-label">Speed (x faster)</div>
        <input type="number" id="speed" value="10" min="1" max="100" class="config-input"/>
      </div>
      <div>
        <div class="config-label">Session Candles</div>
        <input type="number" id="candleCount" value="75" min="20" max="200" class="config-input"/>
      </div>
    </div>
    <button class="sim-btn" id="startBtn" disabled onclick="submitSim()">Select a scenario above</button>
  </div>

  <!-- ── History tab ──────────────────────────────────────────────── -->
  <div id="panelHistory" style="display:none;">
    <div style="font-size:0.75rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1.5px;margin-top:20px;">Replay a Past Trading Day</div>
    <p style="font-size:0.78rem;color:#6b7fa0;margin-top:8px;">Pick a date to replay that day's real ${TRADE_RES}-min candles as ticks through your <strong>${strategy.NAME}</strong> strategy.</p>
    <div class="config-row">
      <div>
        <div class="config-label">Trading Date</div>
        <input type="date" id="replayDate" class="config-input" style="width:180px;" />
      </div>
      <div>
        <div class="config-label">Speed (x faster)</div>
        <input type="number" id="replaySpeed" value="10" min="1" max="100" class="config-input"/>
      </div>
    </div>
    <button class="sim-btn" id="replayBtn" style="background:#065f46;" onclick="submitReplay()">Replay Selected Date</button>
  </div>

  <div id="status" style="margin-top:12px;font-size:0.82rem;color:#6b7fa0;"></div>
</div></div>

<script>
// Set default date to yesterday
(function(){
  const d = new Date(); d.setDate(d.getDate()-1);
  document.getElementById('replayDate').value = d.toISOString().split('T')[0];
})();

function switchTab(tab) {
  const isScenario = tab === 'scenario';
  document.getElementById('panelScenario').style.display = isScenario ? '' : 'none';
  document.getElementById('panelHistory').style.display  = isScenario ? 'none' : '';
  document.getElementById('tabScenario').style.borderBottomColor = isScenario ? '#f59e0b' : 'transparent';
  document.getElementById('tabScenario').style.color = isScenario ? '#f59e0b' : '#6b7fa0';
  document.getElementById('tabHistory').style.borderBottomColor  = isScenario ? 'transparent' : '#10b981';
  document.getElementById('tabHistory').style.color  = isScenario ? '#6b7fa0' : '#10b981';
}

let selectedScenario = null;
function startSim(key) {
  selectedScenario = key;
  document.querySelectorAll('.sim-grid > div').forEach(el => el.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  document.getElementById('startBtn').disabled = false;
  document.getElementById('startBtn').textContent = 'Start Simulation';
}
function submitSim() {
  const btn = document.getElementById('startBtn');
  btn.disabled = true; btn.textContent = 'Starting...';
  _post('/swing-paper/simulate/start', {
    mode: 'scenario', scenario: selectedScenario,
    basePrice: parseFloat(document.getElementById('basePrice').value) || 24500,
    speed: parseInt(document.getElementById('speed').value) || 10,
    candleCount: parseInt(document.getElementById('candleCount').value) || 75,
  }, btn, 'Start Simulation');
}
function submitReplay() {
  const btn = document.getElementById('replayBtn');
  const date = document.getElementById('replayDate').value;
  if (!date) { document.getElementById('status').textContent = 'Pick a date first'; return; }
  btn.disabled = true; btn.textContent = 'Fetching candles...';
  _post('/swing-paper/simulate/start', {
    mode: 'historical', date: date,
    speed: parseInt(document.getElementById('replaySpeed').value) || 10,
  }, btn, 'Replay Selected Date');
}
function _post(url, body, btn, resetLabel) {
  fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })
    .then(r=>r.json()).then(d=>{
      if(d.success){ window.location.href='/swing-paper/status'; }
      else { document.getElementById('status').textContent='Error: '+(d.error||'Unknown'); btn.disabled=false; btn.textContent=resetLabel; }
    }).catch(e=>{ document.getElementById('status').textContent='Error: '+e.message; btn.disabled=false; btn.textContent=resetLabel; });
}
</script>
</body></html>`);
});

router.post("/simulate/start", async (req, res) => {
  if (ptState.running) return res.json({ success: false, error: "Session already running. Stop it first." });

  const { mode = "scenario", scenario, basePrice = 24500, speed = 10, candleCount = 75, date } = req.body || {};

  const strategy = getActiveStrategy();
  if (typeof strategy.reset === "function") strategy.reset();

  // Common state reset
  function resetSimState(label, simDate) {
    ptState.running       = true;
    ptState.candles       = [];
    ptState.currentBar    = null;
    ptState.barStartTime  = null;
    ptState.position      = null;
    ptState.sessionTrades = [];
    ptState.sessionPnl    = 0;
    ptState.sessionStart  = istNow();
    ptState.log           = [];
    ptState.tickCount     = 0;
    ptState._entryPending = false;
    ptState.lastTickTime  = null;
    ptState.lastTickPrice = null;
    ptState.prevCandleHigh = null;
    ptState.prevCandleLow  = null;
    ptState.prevCandleMid  = null;
    ptState.optionLtp      = null;
    ptState.optionSymbol   = null;
    ptState._consecutiveLosses   = 0;
    ptState._pauseUntilTime      = null;
    ptState._fiftyPctPauseUntil  = null;
    ptState._dailyLossHit        = false;
    ptState._cachedCE            = null;
    ptState._cachedPE            = null;
    ptState._maxTradesLoggedCandle = null;
    ptState._slHitCandleTime     = null;
    ptState._slPauseUntilBySide  = { CE: 0, PE: 0 }; // reset same-side SL cooldown
    ptState._lastCheckedBarHigh  = null;
    ptState._lastCheckedBarLow   = null;
    ptState._missedLoggedCandle  = null;
    ptState._sessionWins         = 0;
    ptState._sessionLosses       = 0;
    ptState._expiryDayBlocked    = false;
    ptState._simMode             = true;
    ptState._simScenario         = label;
    _cachedClosedCandleSL        = null;
    // 09:15 IST = 03:45 UTC on the same IST date
    const simStart = simDate
      ? new Date(simDate + "T09:15:00+05:30")
      : new Date();
    if (!simDate) simStart.setUTCHours(3, 45, 0, 0);
    _simClockMs = simStart.getTime();
  }

  function seedWarmup(result) {
    if (result.warmupCandles.length > 0) {
      ptState.candles = result.warmupCandles;
      const { stopLoss: preloadSL } = strategy.getSignal(ptState.candles, { silent: true });
      _cachedClosedCandleSL = preloadSL ?? null;
      const lastC = ptState.candles[ptState.candles.length - 1];
      if (lastC) {
        ptState.prevCandleHigh = lastC.high;
        ptState.prevCandleLow  = lastC.low;
        ptState.prevCandleMid  = parseFloat(((lastC.high + lastC.low) / 2).toFixed(2));
      }
      log(`📦 [SIM] Pre-loaded ${result.warmupCandles.length} warmup candles | SAR SL: ${_cachedClosedCandleSL || "n/a"}`);
    }
  }

  function makeCandleDone(total) {
    return (candle, idx) => {
      if ((idx + 1) % 10 === 0) {
        log(`🎮 [SIM] Progress: ${idx + 1}/${total} candles | Trades: ${ptState.sessionTrades.length} | PnL: ₹${ptState.sessionPnl.toFixed(2)}`);
      }
    };
  }
  function onSimDone() {
    log(`🏁 [SIM] Simulation complete — ${ptState.sessionTrades.length} trades, PnL: ₹${ptState.sessionPnl.toFixed(2)}`);
    if (ptState.position) {
      simulateSell(ptState.lastTickPrice || ptState.position.entryPrice, "Simulation ended", ptState.lastTickPrice);
    }
    ptState._simMode = false;
  }

  // ── Historical date replay ──────────────────────────────────────────────
  if (mode === "historical") {
    if (!date) return res.json({ success: false, error: "Date is required for historical replay" });

    resetSimState(`replay:${date}`, date);

    log(`\n════════════════════════════════════════════════════════════════════`);
    log(`🎮 [SIM] Historical replay: ${date}`);
    log(`   Strategy   : ${ACTIVE} — ${strategy.NAME}`);
    log(`   Resolution : ${TRADE_RES}-min candles | Speed: ${speed}x`);
    log(`════════════════════════════════════════════════════════════════════\n`);

    try {
      const { fetchCandlesCached, clearCache } = require("../utils/candleCache");
      const { fetchCandles } = require("../services/backtestEngine");

      const targetDate = new Date(date + "T00:00:00+05:30");
      const fromDate = new Date(targetDate);
      fromDate.setDate(fromDate.getDate() - 21); // 21 days back for warmup (matches live pre-load depth)
      const fromStr = fromDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

      // Clear cache to avoid stale partial data from a previous live session
      clearCache("NSE:NIFTY50-INDEX", String(TRADE_RES));

      log(`📥 [SIM] Fetching ${TRADE_RES}-min candles from ${fromStr} to ${date}...`);
      const allCandles = await fetchCandlesCached(
        "NSE:NIFTY50-INDEX", String(TRADE_RES), fromStr, date, fetchCandles
      );

      if (!allCandles || allCandles.length < 35) {
        ptState.running = false; ptState._simMode = false;
        return res.json({ success: false, error: `Not enough candles for ${date} — got ${allCandles ? allCandles.length : 0}. Is it a trading day?` });
      }

      // Fetch 1-min candles for high-fidelity tick replay
      let tickCandles1m = [];
      try {
        clearCache("NSE:NIFTY50-INDEX", "1");
        const allTick = await fetchCandlesCached(
          "NSE:NIFTY50-INDEX", "1", date, date, fetchCandles
        );
        if (allTick && allTick.length > 0) {
          tickCandles1m = allTick.filter(c => {
            const cDate = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
            return cDate === date;
          });
          log(`📊 [SIM] Fetched ${tickCandles1m.length} × 1-min candles for high-fidelity tick replay`);
        }
      } catch (e) {
        log(`⚠️ [SIM] 1-min candle fetch failed (${e.message}) — using ${TRADE_RES}-min interpolation`);
      }

      // Split by date
      const warmupCandles = [];
      const sessionCandles = [];
      for (const c of allCandles) {
        const cDate = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        if (cDate < date) warmupCandles.push(c);
        else if (cDate === date) sessionCandles.push(c);
      }

      if (sessionCandles.length === 0) {
        ptState.running = false; ptState._simMode = false;
        return res.json({ success: false, error: `No candles found for ${date} — holiday or weekend?` });
      }

      const warmup = warmupCandles.slice(-300);
      log(`📦 [SIM] Date: ${date} | ${warmup.length} warmup + ${sessionCandles.length} session candles (${TRADE_RES}-min) | Speed: ${speed}x`);

      const result = tickSimulator.startFromCandles({
        candles: [...warmup, ...sessionCandles],
        warmupCount: warmup.length,
        resolution: TRADE_RES,
        speed,
        onTick,
        onCandleDone: makeCandleDone(sessionCandles.length),
        onDone: onSimDone,
        tickCandles: tickCandles1m.length > 0 ? tickCandles1m : undefined,
        tickResolution: tickCandles1m.length > 0 ? 1 : undefined,
      });

      seedWarmup(result);
      log(`🎮 [SIM] Replaying ${result.totalSessionCandles} candles as ticks...`);
      return res.json({ success: true, scenario: `Replay ${date}`, candles: result.totalSessionCandles });
    } catch (err) {
      ptState.running = false; ptState._simMode = false;
      log(`❌ [SIM] Historical replay failed: ${err.message}`);
      return res.json({ success: false, error: err.message });
    }
  }

  // ── Synthetic scenario ──────────────────────────────────────────────────
  if (!tickSimulator.SCENARIOS[scenario]) {
    return res.json({ success: false, error: `Unknown scenario: ${scenario}` });
  }

  resetSimState(scenario);

  const scenarioLabel = tickSimulator.SCENARIOS[scenario].label;
  log(`\n════════════════════════════════════════════════════════════════════`);
  log(`🎮 [SIM] Simulation started: ${scenarioLabel}`);
  log(`   Strategy   : ${ACTIVE} — ${strategy.NAME}`);
  log(`   Resolution : ${TRADE_RES}-min candles`);
  log(`   Base Price : ₹${basePrice} | Speed: ${speed}x | Candles: ${candleCount}`);
  log(`════════════════════════════════════════════════════════════════════\n`);

  try {
    const result = tickSimulator.start({
      scenario, basePrice, speed, candleCount,
      warmupCandles: 30, resolution: TRADE_RES,
      onTick,
      onCandleDone: makeCandleDone(candleCount),
      onDone: onSimDone,
    });

    seedWarmup(result);
    log(`🎮 [SIM] Emitting ${result.totalSessionCandles} candles as ticks...`);
    res.json({ success: true, scenario: scenarioLabel, candles: result.totalSessionCandles });
  } catch (err) {
    ptState.running = false; ptState._simMode = false;
    log(`❌ [SIM] Start failed: ${err.message}`);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
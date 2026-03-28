/**
 * PAPER TRADE — /paperTrade
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses LIVE market data (Fyers WebSocket) but SIMULATES orders locally.
 * NO real orders are placed. Everything is tracked in memory + saved to disk.
 *
 * Flow:
 *   /paperTrade/start  → connects to live socket, starts simulating trades
 *   /paperTrade/stop   → stops socket, saves final session summary
 *   /paperTrade/status → live view: position, PnL, capital, log
 *   /paperTrade/history → all past paper trade sessions
 *   /paperTrade/reset  → wipe paper trade history & reset capital
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
const { buildSidebar, sidebarCSS, toastJS, logViewerHTML, faviconLink } = require("../utils/sharedNav");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;

// ── Module-level caches (avoid repeated env reads / allocations in hot paths) ─
const TRADE_RES = parseInt(process.env.TRADE_RESOLUTION || "15", 10); // candle resolution in minutes
let _cachedClosedCandleSL = null; // SAR SL from last FULLY CLOSED candle — updated in onCandleClose, used in every tick

// ── Trail tier config — cached at module load (never changes at runtime) ─────
// getDynamicTrailGap() was calling parseFloat(process.env.TRAIL_TIER*) on every tick.
// Pre-reading these once eliminates 750+ env reads/min when in position.
const _TRAIL_T1_UPTO = parseFloat(process.env.TRAIL_TIER1_UPTO || "40");
const _TRAIL_T2_UPTO = parseFloat(process.env.TRAIL_TIER2_UPTO || "70");
const _TRAIL_T1_GAP  = parseFloat(process.env.TRAIL_TIER1_GAP  || "60");
const _TRAIL_T2_GAP  = parseFloat(process.env.TRAIL_TIER2_GAP  || "40");
const _TRAIL_T3_GAP  = parseFloat(process.env.TRAIL_TIER3_GAP  || "30");
const _TRAIL_ACTIVATE_PTS = parseFloat(process.env.TRAIL_ACTIVATE_PTS || "15");
const _MAX_DAILY_TRADES   = parseInt(process.env.MAX_DAILY_TRADES || "20", 10);
const _MAX_DAILY_LOSS     = parseFloat(process.env.MAX_DAILY_LOSS || "5000");

// ── EOD stop time — cached at module load ─────────────────────────────────────
// parseMins("TRADE_STOP_TIME","15:30") was called on every candle close.
const _STOP_MINS = (function() {
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
})();

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
      capital: parseFloat(process.env.PAPER_TRADE_CAPITAL || "100000"),
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
    _paperDataCache = { capital: parseFloat(process.env.PAPER_TRADE_CAPITAL || "100000"), totalPnl: 0, sessions: [] };
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
  // Win/loss counters: maintained in simulateSell so /status/data doesn't filter on every poll
  _sessionWins:   0,
  _sessionLosses: 0,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function log(msg) {
  const entry = `[${istNow()}] ${msg}`;
  console.log(entry);
  ptState.log.push(entry);
  if (ptState.log.length > 2000) ptState.log.shift(); // match logStore MAX_LOGS
}

function getTradeResolution() { return TRADE_RES; } // kept for legacy callers; prefer TRADE_RES directly

function getMinBucket(unixMs) {
  const d = new Date(unixMs);
  d.setMinutes(Math.floor(d.getMinutes() / TRADE_RES) * TRADE_RES, 0, 0);
  return d.getTime();
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
  return parseFloat(process.env.PAPER_TRADE_CAPITAL || "100000");
}

// ── Option LTP via REST polling ──────────────────────────────────────────────
// ONE permanent socket → NIFTY spot only. Never reconnected.
// Option LTP fetched via Fyers REST getQuotes() every 3 seconds while in trade.
// This avoids ALL Fyers singleton reconnect issues permanently.

const fyers = require('../config/fyers');
const { notifyEntry, notifyExit, sendTelegram, isConfigured } = require('../utils/notify');
const NIFTY_INDEX_SYMBOL = 'NSE:NIFTY50-INDEX';

// ── Pre-fetch option symbols in background after each candle close ──────────
async function prefetchOptionSymbols(spot) {
  if (instrumentConfig.INSTRUMENT === 'NIFTY_FUTURES') return;
  try {
    const [ce, pe] = await Promise.all([
      validateAndGetOptionSymbol(spot, 'CE'),
      validateAndGetOptionSymbol(spot, 'PE'),
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

async function fetchOptionLtp(symbol) {
  try {
    // Fyers v3 getQuotes accepts a comma-separated symbol string directly
    const response = await fyers.getQuotes([symbol]);

    if (response.s === 'ok' && response.d && response.d.length > 0) {
      const v = response.d[0].v || response.d[0];
      // Try every known Fyers LTP field name
      const ltp = v.lp || v.ltp || v.last_price || v.last_traded_price
               || v.ask_price || v.bid_price || v.close_price || v.prev_close_price;
      if (ltp && ltp > 0) return parseFloat(ltp);
      log(`[DEBUG] All LTP fields null/zero for ${symbol} | v=${JSON.stringify(v).slice(0, 200)}`);
    } else {
      if (!fetchOptionLtp._errLogged) {
        log(`[DEBUG] getQuotes non-ok: s=${response.s} msg=${response.message||response.msg||"?"}`);
        fetchOptionLtp._errLogged = true;
        setTimeout(() => { delete fetchOptionLtp._errLogged; }, 30000);
      }
    }
  } catch (err) {
    log(`[DEBUG] fetchOptionLtp exception: ${err.message}`);
  }
  return null;
}

// ── Option LTP poll tick — shared logic used by immediate fetch + recurring loop ──
async function _optionPollTick(symbol) {
  if (_optionPollBusy) return; // skip if previous call still in flight
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
      log(`📌 [PAPER] Option entry LTP: ₹${ltp} (SPOT @ ₹${ptState.position.spotAtEntry} | SL: ₹${ptState.position.stopLoss} | TrailActivate: +${ptState.position.trailActivatePts}pt)`);
    }

    // ── Option LTP stop — tied to prev-candle 50% mid ───────────────────
    const entryLtp  = ptState.position.optionEntryLtp;
    const entrySpot = ptState.position.spotAtEntry;
    const prevMid   = ptState.position.entryPrevMid;
    let optStopPrice = null;
    if (entryLtp && entrySpot && prevMid) {
      const spotGap = Math.max(Math.abs(entrySpot - prevMid), 20);
      optStopPrice  = parseFloat((entryLtp - spotGap).toFixed(2));
    } else if (entryLtp) {
      const optStopPct = parseFloat(process.env.OPT_STOP_PCT || "0.15");
      optStopPrice = parseFloat((entryLtp * (1 - optStopPct)).toFixed(2));
    }
    if (entryLtp && optStopPrice !== null && ltp < optStopPrice) {
      const dropPct = (((entryLtp - ltp) / entryLtp) * 100).toFixed(1);
      const dropAmt = (entryLtp - ltp).toFixed(2);
      const pnlEst  = ((ltp - entryLtp) * (ptState.position.qty || getLotQty())).toFixed(0);
      log(`🔻 [PAPER] Option LTP stop hit [50% mid] — entry ₹${entryLtp} → now ₹${ltp} (−${dropPct}%, −₹${dropAmt}/lot, est. PnL ₹${pnlEst})`);
      ptState._slHitCandleTime = ptState.currentBar ? ptState.currentBar.time : null;
      simulateSell(
        ptState.currentBar ? ptState.currentBar.close : ptState.lastTickPrice,
        `Option LTP stop [50% mid] — premium dropped ₹${dropAmt} (₹${entryLtp} → ₹${ltp})`,
        ptState.lastTickPrice
      );
    }
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

    // Format B: YY + 3-letter month + 2-digit day (legacy)
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

function simulateBuy(symbol, side, qty, price, reason, stopLoss, spotAtEntry, isIntraCandle = false) {
  // Guard: never overwrite an existing position (catches async race between candle-close
  // fallback and intra-tick entry both resolving at the same time)
  if (ptState.position) {
    log(`⚠️ [PAPER] simulateBuy called while position already open — ignoring duplicate entry (${side} @ ₹${price})`);
    return;
  }
  const optDetails = parseOptionDetails(symbol);

  // Capture the prev-candle mid at entry time — tick 50% rule uses this FIXED value forever.
  // At intra-candle entry time, ptState.candles already has the just-closed candle at [length-1].
  // That is the correct "previous candle" relative to the live bar we entered on.
  // IMPORTANT: this value must NEVER be updated after entry — it is the fixed reference.
  const entryPrevMid = ptState.candles.length >= 1
    ? parseFloat(((ptState.candles[ptState.candles.length - 1].high + ptState.candles[ptState.candles.length - 1].low) / 2).toFixed(2))
    : null;

  // ── 50% rule ENTRY GATE ───────────────────────────────────────────────────
  // If the entry spot is already on the wrong side of the prev candle mid,
  // the 50% exit rule would fire on the very first tick — meaning there is
  // literally no room to hold this trade. BLOCK the entry entirely.
  //
  // PE trade: we need room to fall → entry spot must be BELOW prev mid.
  //           If entry > mid, any tick will immediately trigger the 50% exit.
  // CE trade: we need room to rise → entry spot must be ABOVE prev mid.
  //           If entry < mid, any tick will immediately trigger the 50% exit.
  //
  // Exception: if entryPrevMid is null (no candle history), allow through.
  const _entrySpot = spotAtEntry || price;
  if (entryPrevMid !== null) {
    const violates = (side === "PE" && _entrySpot > entryPrevMid) ||
                     (side === "CE" && _entrySpot < entryPrevMid);
    if (violates) {
      log(`🚫 [PAPER] Entry BLOCKED — 50% gate: spot ₹${_entrySpot} ${side === "PE" ? ">" : "<"} prev mid ₹${entryPrevMid}. No directional room. Skipping trade.`);
      // Block further intra-candle retries for this candle — every new low/high tick
      // would otherwise re-fire this check since _entryPending resets to false after return.
      ptState._slHitCandleTime = ptState.currentBar ? ptState.currentBar.time : null;
      return; // ← abort entry, position never opened
    }
  }

  // Dynamic trail activation: 25% of initial SAR gap, floored at 15pts, capped at 40pts.
  // Without cap: wide SAR gaps (eg 546pt) give unreasonable activation thresholds.
  const _initialSARgapPaper = stopLoss ? Math.abs((spotAtEntry || price) - stopLoss) : 0;
  const _dynTrailActivatePaper = Math.min(40, Math.max(_TRAIL_ACTIVATE_PTS, Math.round(_initialSARgapPaper * 0.25)));

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
    trailActivatePts:  _dynTrailActivatePaper,
    entryPrevMid:      entryPrevMid,   // mid of candle BEFORE entry — for 50% rule
    entryBarTime:      isIntraCandle ? (ptState.currentBar ? ptState.currentBar.time : null) : null,
    bestPrice:         null,
    // Option metadata
    optionExpiry:      optDetails?.expiry     || null,
    optionStrike:      optDetails?.strike     || null,
    optionType:        optDetails?.optionType || side,
    // Option premium tracking
    optionEntryLtp:    ptState.optionLtp || null,  // premium at entry (if already subscribed)
    optionCurrentLtp:  ptState.optionLtp || null,  // updated on each option tick
  };

  // Set option symbol and start REST polling (no socket changes)
  // Skip option polling for futures — no option premium to track
  ptState.optionSymbol = symbol;
  if (instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES") {
    log(`📊 [PAPER] Starting option LTP polling (REST/3s): ${symbol}`);
    startOptionPolling(symbol);
  } else {
    log(`📊 [PAPER] Futures mode — skipping option LTP polling`);
  }

  const slText = stopLoss ? ` | SL: ₹${stopLoss}` : "";
  log(`📝 [PAPER] BUY ${qty} × ${symbol} @ SPOT ₹${price}${slText} | TrailActivate: +${_dynTrailActivatePaper}pt | Opt: capturing… | Reason: ${reason}`);
  if (entryPrevMid !== null) {
    log(`📐 [PAPER] 50% rule ref fixed: prev candle mid = ₹${entryPrevMid} (exit if ${side}=PE: spot > ₹${entryPrevMid} | CE: spot < ₹${entryPrevMid})`);
  }

  // ── Telegram notification ─────────────────────────────────────────────────
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

function simulateSell(exitPrice, reason, spotAtExit) {
  if (!ptState.position) return;

  const { side, symbol, qty, entryPrice, entryTime, spotAtEntry,
          optionEntryLtp, optionCurrentLtp } = ptState.position;

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

  // Brokerage: options ~₹80 flat | futures ~₹40 (lower STT)
  const brokerage = isFutures ? 40 : 80;
  const netPnl    = parseFloat((rawPnl - brokerage).toFixed(2));

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
    stopLoss:         ptState.position.stopLoss,
    optionExpiry:     ptState.position.optionExpiry || null,
    optionStrike:     ptState.position.optionStrike || null,
    optionType:       ptState.position.optionType   || side,
  };

  ptState.sessionTrades.push(trade);
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
        ptState._pauseUntilTime = Date.now() + pauseMs;
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
  if (reason && reason.toLowerCase().includes('50% rule')) {
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

  // ── Telegram notification ─────────────────────────────────────────────────
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
  if (!ptState.position) prefetchOptionSymbols(candle.close).catch(() => {});

  // ── VIX filter: fetch latest VIX in background (updates cache for intra-tick checks) ──
  fetchLiveVix().catch(() => {});
  const _vixDisplay = getCachedVix();

  log(`📊 [PAPER] ──── Candle close ──────────────────────────────────────`);
  log(`   OHLC: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} | body=${Math.abs(candle.close - candle.open).toFixed(1)}pt`);
  log(`   EMA9=${indicators.ema9!==undefined?indicators.ema9:"?"} slope=${indicators.ema9Slope!==undefined?indicators.ema9Slope:"?"}pt | RSI=${indicators.rsi!==undefined?indicators.rsi:"?"} | SAR=${indicators.sar!==undefined?indicators.sar:"?"}(${indicators.sarTrend||"?"}) | ADX=${indicators.adx!==undefined?indicators.adx:"?"}${indicators.adxTrending?"✓":"✗"}`);
  log(`   Signal: ${signal} [${signalStrength||"n/a"}] | VIX: ${_vixDisplay != null ? _vixDisplay.toFixed(1) : "n/a"} | ${reason}`);

  // Telegram: candle close signal update (only when flat — no position open)
  if (!ptState.position && signal !== null) {
    const _candleIST = new Date(candle.time * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
    const _signalEmoji = signal === "BUY_CE" ? "📈" : signal === "BUY_PE" ? "📉" : "⏸";
    const _shortReason = reason ? reason.slice(0, 120) : "—";
    sendTelegram([
      `${_signalEmoji} [PAPER] ${_candleIST} — ${signal}`,
      `Spot: ₹${candle.close}`,
      `${_shortReason}`,
    ].join("\n"));
  }
  if (ptState.position) {
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

  // ── Trailing SAR stop-loss update (candle close) ─────────────────────────
  // Only tighten the SL — never move it against us.
  // CE: new SAR must be HIGHER than current SL (dots move up as trend continues)
  // PE: new SAR must be LOWER than current SL (dots move down as trend continues)
  if (ptState.position && stopLoss !== null && stopLoss !== undefined) {
    const pos   = ptState.position;
    const oldSL = pos.stopLoss;
    const tighten = pos.side === "CE"
      ? (oldSL === null || stopLoss > oldSL)   // CE: higher SAR = tighter SL
      : (oldSL === null || stopLoss < oldSL);  // PE: lower SAR = tighter SL
    if (tighten) {
      pos.stopLoss = stopLoss;
      const _optSARp = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
      const _sarLabel = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" ? (pos.side==="CE"?"↑LONG":"↓SHORT") : (pos.side==="CE"?"↑CE":"↓PE");
      log(`🔄 [PAPER] SAR tightened: ₹${oldSL} → ₹${stopLoss} (${_sarLabel})${_optSARp}`);
    } else {
      log(`   SAR NOT tightened: new=₹${stopLoss} current=₹${oldSL} | ${pos.side} needs ${pos.side==="CE"?"higher":"lower"}`);
    }
  }

  // ── Exit Rule 1: 50% candle rule (same as backtest) ─────────────────────
  // Backtest checks this on candle[i+1] after entry at candle[i].
  // So skip this check on the entry candle itself — only apply from next candle onwards.
  if (ptState.position) {
    // isEntryCandle: only possible for INTRA-TICK entries (entryBarTime is set).
    // Candle-close entries always have entryBarTime=null so isEntryCandle=false — they
    // get 50% checked from the very first candle after entry.
    const isEntryCandle = ptState.position.entryBarTime !== null &&
                          candle.time === ptState.position.entryBarTime;
    if (isEntryCandle) {
      log(`   50% skip: entry candle (intra-tick entry on this bar) — checking from next candle`);
    }
    if (!isEntryCandle) {
      // Always use the FIXED entryPrevMid — the mid of the candle that closed just before
      // our entry. This never changes regardless of how many candles have since closed.
      const prevMid = ptState.position.entryPrevMid;
      log(`   50% check: side=${ptState.position.side} 50%mid=₹${prevMid||"none"} L=₹${candle.low} H=₹${candle.high}`);
      if (prevMid !== null) {
        if (ptState.position.side === "CE" && candle.low < prevMid) {
          const _opt50ce = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
          log(`🛑 [PAPER] 50% rule CE — candle low ₹${candle.low} < entry prev mid ₹${prevMid}${_opt50ce}`);
          simulateSell(prevMid, `50% rule — low ₹${candle.low} < prev mid ₹${prevMid}`, prevMid);
          return;
        }
        if (ptState.position.side === "PE" && candle.high > prevMid) {
          const _opt50pe = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
          log(`🛑 [PAPER] 50% rule PE — candle high ₹${candle.high} > entry prev mid ₹${prevMid}${_opt50pe}`);
          simulateSell(prevMid, `50% rule — high ₹${candle.high} > prev mid ₹${prevMid}`, prevMid);
          return;
        }
      }
    }
  }

  // ── Exit Rule 2: SAR / trail SL breach at candle close ───────────────────
  if (ptState.position && ptState.position.stopLoss !== null) {
    const sl = ptState.position.stopLoss;
    if (ptState.position.side === "CE" && candle.close < sl) {
      const _optSlCe = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
      log(`🚨 [PAPER] SL hit on candle close — spot ₹${candle.close} < SL ₹${sl}${_optSlCe}`);
      simulateSell(sl, `SL hit — close ₹${candle.close} below SL ₹${sl}`, candle.close);
      return;
    }
    if (ptState.position.side === "PE" && candle.close > sl) {
      const _optSlPe = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
      log(`🚨 [PAPER] SL hit on candle close — spot ₹${candle.close} > SL ₹${sl}${_optSlPe}`);
      simulateSell(sl, `SL hit — close ₹${candle.close} above SL ₹${sl}`, candle.close);
      return;
    }
  }

  // ── Exit Rule 3: Opposite signal ────────────────────────────────────────
  if (ptState.position) {
    const opposite = ptState.position.side === "CE" ? "BUY_PE" : "BUY_CE";
    if (signal === opposite) {
      simulateSell(candle.close, "Opposite signal exit", candle.close);
      // fall through — position is now null, may enter below
    }
  }

  // ── Exit Rule 4: EOD square-off + auto-stop at TRADE_STOP_TIME ─────────────
  // Use module-level cached _STOP_MINS (parsed once at startup) — no env read per candle.
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const _stopLabel  = String(Math.floor(_STOP_MINS/60)).padStart(2,"0") + ":" + String(_STOP_MINS%60).padStart(2,"0");
  if (ist.getHours() * 60 + ist.getMinutes() >= _STOP_MINS) {
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
      socketManager.stop();       // already imported at top — ../utils/socketManager
      sharedSocketState.clear();  // already imported at top — ../utils/sharedSocketState
      stopOptionPolling();
    }
    return;
  }

  // ── Entry: candle-close entry (primary path for TRADE_RESOLUTION >= 5) ─────
  // For 15-min resolution: fires here AND intra-tick (both guarded by same circuit breakers).
  // For 5-min resolution: fires only if intra-tick entry didn't already fire.
  // isMarketHours() guard: prevents entries on 5-min candles closing between TRADE_STOP_TIME-10
  // and TRADE_STOP_TIME (e.g. a 3:20 PM candle-close with TRADE_STOP_TIME=15:30).
  if (!ptState.position && !ptState._entryPending && isMarketHours() && (signal === "BUY_CE" || signal === "BUY_PE")) {
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
    // ── VIX filter: block entry in high-volatility regimes ──────────────────
    const _vixCheck = await checkLiveVix(candleCloseStrength);
    if (!_vixCheck.allowed) {
      log(`🌡️ [PAPER] VIX BLOCK — ${_vixCheck.reason} | Signal: ${signal}`);
      return;
    }
    // ── Circuit breaker checks — must mirror intra-tick path exactly ──────────
    if (ptState._dailyLossHit) {
      log(`🛑 [PAPER] Daily loss limit active — candle-close entry blocked (${signal})`);
      return;
    }
    if (ptState._pauseUntilTime && Date.now() < ptState._pauseUntilTime) {
      const resumeTime = new Date(ptState._pauseUntilTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      log(`⏸ [PAPER] Consecutive loss pause active — candle-close entry blocked until ~${resumeTime}`);
      return;
    }
    if (ptState._fiftyPctPauseUntil && Date.now() < ptState._fiftyPctPauseUntil) {
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
        symbolPromise = validateAndGetOptionSymbol(candle.close, side);
      }
    }

    symbolPromise.then(({ symbol, expiry, strike, invalid }) => {
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
      simulateBuy(symbol, side, getLotQty(), candle.close, reason, stopLoss, candle.close);
      ptState._entryPending = false;
      clearTimeout(_ptEntryTimer);
    }).catch(err => {
      log(`❌ [PAPER] Symbol validation error: ${err.message}. Skipping trade.`);
      ptState._entryPending = false;
      clearTimeout(_ptEntryTimer);
    });
  }
}

// ── Dynamic trail gap — tightens as profit grows ─────────────────────────────
// Fixed 60pt gap throughout means giving back 65% of any move on reversal.
// Instead: wide early (noise protection) → tight late (profit lock).
//
// Tier thresholds (configurable via .env):
//   TRAIL_TIER1_UPTO  = 40   pts  → gap = TRAIL_TIER1_GAP  (default 60pt)
//   TRAIL_TIER2_UPTO  = 70   pts  → gap = TRAIL_TIER2_GAP  (default 40pt)
//   above TIER2_UPTO         → gap = TRAIL_TIER3_GAP  (default 30pt)
//
// Example with today's 92pt PE trade:
//   0–40pt  move: SL stays 60pt behind best  (early noise buffer)
//   40–70pt move: SL tightens to 40pt behind (confirmed profit zone)
//   70pt+   move: SL tightens to 30pt behind (lock in big move)
//   → At peak 92pt: SL = peak + 30 → exits ~62pt profit vs 32pt with fixed 60pt
//
// Why these numbers:
//   60pt early: Nifty 15-min bars regularly wick 40-50pt — need room to breathe
//   40pt mid:   After 40pt move we have confirmed momentum, 40pt still safe
//   30pt late:  After 70pt move, tighten hard — don't give back more than ~30pt
//
function getDynamicTrailGap(moveInFavour) {
  // Uses module-level cached constants (parsed once at startup) instead of
  // reading process.env on every tick — eliminates 750+ env reads/min.
  if (moveInFavour < _TRAIL_T1_UPTO) return _TRAIL_T1_GAP;
  if (moveInFavour < _TRAIL_T2_UPTO) return _TRAIL_T2_GAP;
  return _TRAIL_T3_GAP;
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
  ptState.lastTickTime  = istNow();
  ptState.lastTickPrice = tick.ltp;

  const now    = Date.now();
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
      log(`🚫 [PAPER] Security block — outside market hours. No entry allowed.`);
    } else {
    // Block re-entry on the same candle where an SL/50% exit just occurred
    const currentBarTime = ptState.currentBar ? ptState.currentBar.time : null;
    if (ptState._slHitCandleTime !== null && ptState._slHitCandleTime === currentBarTime) {
      // silently skip — no log spam on every tick
    } else if (ptState._dailyLossHit) {
      // Daily loss kill switch latched — no more entries today (silent to avoid log spam)
    } else if (ptState._pauseUntilTime && Date.now() < ptState._pauseUntilTime) {
      // Consecutive loss pause active — silently skip to avoid log spam
    } else if (ptState._fiftyPctPauseUntil && Date.now() < ptState._fiftyPctPauseUntil) {
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
    // SAR stopLoss comes from _cachedClosedCandleSL — stable value set at candle close, never recomputed per-tick.
    ptState.candles.push(bar);
    const { signal, reason, signalStrength } = strategy.getSignal(ptState.candles, { silent: true });
    ptState.candles.pop();
    const stopLoss = _cachedClosedCandleSL;
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

    if ((signal === "BUY_CE" || signal === "BUY_PE") && isStrongSignal) {
      // ── VIX filter: use cached VIX (updated at candle close) to avoid async in tick handler ──
      const _vixIntraVal = getCachedVix();
      const _vixIntraBlocked = vixFilter.VIX_ENABLED && _vixIntraVal != null && (
        _vixIntraVal > vixFilter.VIX_MAX_ENTRY ||
        (_vixIntraVal > vixFilter.VIX_STRONG_ONLY && signalStrength !== "STRONG")
      );
      if (_vixIntraBlocked) {
        if (!ptState._vixBlockLoggedCandle || ptState._vixBlockLoggedCandle !== currentBarTime) {
          ptState._vixBlockLoggedCandle = currentBarTime;
          log(`🌡️ [PAPER] VIX BLOCK (intra) — VIX ${_vixIntraVal.toFixed(1)} too high | Signal: ${signal} [${signalStrength}]`);
        }
      } else {
      const side = signal === "BUY_CE" ? "CE" : "PE";
      ptState._entryPending = true; // prevent double-fire while async symbol lookup runs
      // Safety: auto-reset after 4s in case of any unhandled error path
      const _ptIntraTimer = setTimeout(() => { if (ptState._entryPending) { ptState._entryPending = false; } }, 4000);
      log(`⚡ [PAPER] Intra-candle STRONG entry @ ₹${ltp} | VIX: ${_vixIntraVal != null ? _vixIntraVal.toFixed(1) : "n/a"} | [${TRADE_RES}m bar] ${reason}`);
      const INSTR = instrumentConfig.INSTRUMENT; // top-level constant — no inline require needed

      let symbolPromise;
      if (INSTR === "NIFTY_FUTURES") {
        symbolPromise = getSymbol(side).then(sym => ({ symbol: sym, expiry: null, strike: null, invalid: false }));
      } else {
        const cached = getCachedSymbol(side, ltp);
        if (cached) {
          log(`⚡ [PAPER] Using pre-fetched symbol: ${cached.symbol} (spot delta: ${Math.abs(cached.spot - ltp).toFixed(0)} pts)`);
          symbolPromise = Promise.resolve(cached);
        } else {
          log(`🔍 [PAPER] Cache miss — live symbol lookup (spot moved or first trade of session)`);
          symbolPromise = validateAndGetOptionSymbol(ltp, side);
        }
      }

      symbolPromise.then(({ symbol, expiry, strike, invalid }) => {
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
        simulateBuy(symbol, side, getLotQty(), ltp, reason, stopLoss, ltp, true); // isIntraCandle=true
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
  // PE: exit when ltp >= stopLoss | CE: exit when ltp <= stopLoss
  if (ptState.position && ptState.position.stopLoss !== null) {
    const pos = ptState.position;

    // ── Intra-candle trailing: dynamic tiered gap (tightens as profit grows) ──
    // Trail activates after trailActivatePts (dynamic per-trade: 25% of SAR gap, min 15pt).
    // Gap is NOT fixed — it shrinks in tiers as moveInFavour increases.
    // 50% rule floor/ceiling still applies — trail never crosses entryPrevMid against us.
    const TRAIL_ACTIVATE = pos.trailActivatePts || _TRAIL_ACTIVATE_PTS;

    if (pos.side === "CE") {
      // For CE: profit when price goes UP. Track highest ltp seen.
      const prevBestCE = pos.bestPrice;
      if (!pos.bestPrice || ltp > pos.bestPrice) pos.bestPrice = ltp;
      const moveInFavour = pos.bestPrice - pos.spotAtEntry;
      if (moveInFavour >= TRAIL_ACTIVATE) {
        const dynamicGap = getDynamicTrailGap(moveInFavour);
        const trailSL    = parseFloat((pos.bestPrice - dynamicGap).toFixed(2));
        // 50% floor: trail SL cannot sit below entryPrevMid until trail naturally rises above it.
        const fiftyPctFloor    = pos.entryPrevMid;
        const clipped          = fiftyPctFloor !== null && trailSL < fiftyPctFloor;
        const effectiveTrailSL = clipped ? fiftyPctFloor : trailSL;
        if (effectiveTrailSL > pos.stopLoss) {
          const cushion = parseFloat((ltp - effectiveTrailSL).toFixed(1));
          const optStr  = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
          const clipStr = clipped ? ` [50%floor=₹${fiftyPctFloor}]` : "";
          const _trailCELabel = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" ? "LONG" : "CE";
          log(`📈 [PAPER] Trail ${_trailCELabel} [T${moveInFavour<_TRAIL_T1_UPTO?1:moveInFavour<_TRAIL_T2_UPTO?2:3} gap=${dynamicGap}pt]: best=₹${pos.bestPrice} (+${moveInFavour.toFixed(0)}pt) → SL ₹${pos.stopLoss} → ₹${effectiveTrailSL} | cushion=${cushion}pt${optStr}${clipStr}`);
          pos.stopLoss = effectiveTrailSL;
        }
      } else if (pos.bestPrice !== prevBestCE) {
        // Throttle "waiting" log to once per candle to avoid flooding the log buffer.
        const _curBarTime = ptState.currentBar ? ptState.currentBar.time : 0;
        if (!pos._trailWaitLoggedAt || pos._trailWaitLoggedAt !== _curBarTime) {
          pos._trailWaitLoggedAt = _curBarTime;
          const needed       = parseFloat((TRAIL_ACTIVATE - moveInFavour).toFixed(1));
          const _optWtCEp    = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
          log(`⏳ [PAPER] Trail CE waiting: best=₹${pos.bestPrice} (+${moveInFavour.toFixed(0)}pt) | need +${needed}pt more to activate (threshold=${TRAIL_ACTIVATE}pt)${_optWtCEp}`);
        }
      }
    } else {
      // For PE: profit when price goes DOWN. Track lowest ltp seen.
      const prevBestPE = pos.bestPrice;
      if (!pos.bestPrice || ltp < pos.bestPrice) pos.bestPrice = ltp;
      const moveInFavour = pos.spotAtEntry - pos.bestPrice;
      if (moveInFavour >= TRAIL_ACTIVATE) {
        const dynamicGap = getDynamicTrailGap(moveInFavour);
        const trailSL    = parseFloat((pos.bestPrice + dynamicGap).toFixed(2));
        // 50% ceiling: trail SL cannot sit above entryPrevMid until trail naturally falls below it.
        const fiftyPctCeiling  = pos.entryPrevMid;
        const clipped          = fiftyPctCeiling !== null && trailSL > fiftyPctCeiling;
        const effectiveTrailSL = clipped ? fiftyPctCeiling : trailSL;
        if (effectiveTrailSL < pos.stopLoss) {
          const cushion = parseFloat((effectiveTrailSL - ltp).toFixed(1));
          const optStr  = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
          const clipStr = clipped ? ` [50%ceil=₹${fiftyPctCeiling}]` : "";
          const _trailPELabel = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" ? "SHORT" : "PE";
          log(`📉 [PAPER] Trail ${_trailPELabel} [T${moveInFavour<_TRAIL_T1_UPTO?1:moveInFavour<_TRAIL_T2_UPTO?2:3} gap=${dynamicGap}pt]: best=₹${pos.bestPrice} (+${moveInFavour.toFixed(0)}pt) → SL ₹${pos.stopLoss} → ₹${effectiveTrailSL} | cushion=${cushion}pt${optStr}${clipStr}`);
          pos.stopLoss = effectiveTrailSL;
        }
      } else if (pos.bestPrice !== prevBestPE) {
        // Throttle "waiting" log to once per candle (same fix as CE above).
        const _curBarTime = ptState.currentBar ? ptState.currentBar.time : 0;
        if (!pos._trailWaitLoggedAt || pos._trailWaitLoggedAt !== _curBarTime) {
          pos._trailWaitLoggedAt = _curBarTime;
          const needed       = parseFloat((TRAIL_ACTIVATE - moveInFavour).toFixed(1));
          const _optWtPEp    = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
          log(`⏳ [PAPER] Trail PE waiting: best=₹${pos.bestPrice} (+${moveInFavour.toFixed(0)}pt) | need +${needed}pt more to activate (threshold=${TRAIL_ACTIVATE}pt)${_optWtPEp}`);
        }
      }
    }

    // ── Check if current SL is hit ────────────────────────────────────────────
    const updatedSL = pos.stopLoss;
    if (pos.side === "PE" && ltp >= updatedSL) {
      const gaveBack  = parseFloat((ltp - pos.bestPrice).toFixed(1));
      const peakGain  = parseFloat((pos.spotAtEntry - pos.bestPrice).toFixed(1));
      const optStr    = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
      log(`🛑 [PAPER] SL HIT PE — ltp ₹${ltp} >= SL ₹${updatedSL} | peak=₹${pos.bestPrice} (+${peakGain}pt) gave back ${gaveBack}pt${optStr}`);
      // Only block re-entry if initial SL was hit before trail activated (pure loss).
      const wasTrailingPE = pos.bestPrice && (pos.spotAtEntry - pos.bestPrice) >= TRAIL_ACTIVATE;
      if (!wasTrailingPE) ptState._slHitCandleTime = ptState.currentBar ? ptState.currentBar.time : null;
      simulateSell(updatedSL, `SL hit @ ₹${updatedSL}`, ltp);
      return;
    }
    if (pos.side === "CE" && ltp <= updatedSL) {
      const gaveBack = parseFloat((pos.bestPrice - ltp).toFixed(1));
      const peakGain = parseFloat((pos.bestPrice - pos.spotAtEntry).toFixed(1));
      const optStr   = ptState.optionLtp ? ` | opt=₹${ptState.optionLtp}` : "";
      log(`🛑 [PAPER] SL HIT CE — ltp ₹${ltp} <= SL ₹${updatedSL} | peak=₹${pos.bestPrice} (+${peakGain}pt) gave back ${gaveBack}pt${optStr}`);
      // Only block re-entry if initial SL was hit before trail activated (pure loss).
      const wasTrailingCE = pos.bestPrice && (pos.bestPrice - pos.spotAtEntry) >= TRAIL_ACTIVATE;
      if (!wasTrailingCE) ptState._slHitCandleTime = ptState.currentBar ? ptState.currentBar.time : null;
      simulateSell(updatedSL, `SL hit @ ₹${updatedSL}`, ltp);
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
      sendTelegram([
        `📄 PAPER TRADE — DAILY REPORT`,
        `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" })}`,
        ``,
        `No trades taken today.`,
        `Session PnL: ₹0`,
      ].join("\n"));
      return;
    }

    const wins    = trades.filter(t => t.pnl > 0);
    const losses  = trades.filter(t => t.pnl <= 0);
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

    sendTelegram([
      `📄 PAPER TRADE — DAILY REPORT`,
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

  } catch (err) {
    log(`⚠️ [PAPER] Daily report error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /paperTrade/start
 * Connects to live Fyers socket and starts simulating trades
 */
router.get("/start", async (req, res) => {
  if (!process.env.ACCESS_TOKEN) {
    return res.status(401).json({
      success: false,
      error: "Fyers not logged in. Click 'Re-login' on the Dashboard to authenticate Fyers first.",
    });
  }

  if (ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading already running." });
  }

  if (sharedSocketState.isActive()) {
    return res.status(400).json({
      success: false,
      error: `Cannot start paper trading — Live Trading is currently active. Stop it first at /trade/stop`,
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
  ptState._dailyLossHit        = false; // reset daily kill switch on new session
  ptState._cachedCE            = null; // clear pre-fetch cache on session start
  ptState._cachedPE            = null;
  ptState._maxTradesLoggedCandle = null;
  ptState._slHitCandleTime     = null;
  ptState._lastCheckedBarHigh  = null;
  ptState._lastCheckedBarLow   = null;
  ptState._missedLoggedCandle  = null;
  ptState._sessionWins         = 0;
  ptState._sessionLosses       = 0;
  stopOptionPolling();

  log(`\n════════════════════════════════════════════════════════════════════`);
  log(`🟡 [PAPER] Paper trading started`);
  log(`   Resolution : ${getTradeResolution()}-min candles (TRADE_RESOLUTION in .env)`);
  log(`   Strategy   : ${ACTIVE} — ${strategy.NAME}`);
  log(`   Instrument : ${instrumentConfig.INSTRUMENT}`);
  log(`   Capital    : ₹${data.capital.toLocaleString("en-IN")}`);
  log(`   Filters     : EMA slope>=6pt | RSI CE>55 PE<45 | ADX>=25 | SAR gap>=55pt | body>=10pt`);
  log(`   Trail       : DYNAMIC TIERED — T1 0-${process.env.TRAIL_TIER1_UPTO||40}pt=gap${process.env.TRAIL_TIER1_GAP||60}pt | T2 ${process.env.TRAIL_TIER1_UPTO||40}-${process.env.TRAIL_TIER2_UPTO||70}pt=gap${process.env.TRAIL_TIER2_GAP||40}pt | T3 ${process.env.TRAIL_TIER2_UPTO||70}pt+=gap${process.env.TRAIL_TIER3_GAP||30}pt | activates after +${process.env.TRAIL_ACTIVATE_PTS||15}pt | prevMid-clip | 50%-rule=candle-close-only`);
  log(`   Risk guards : MaxDailyLoss=₹${process.env.MAX_DAILY_LOSS||5000} | 3 losses → daily kill | OPT_STOP=50%-candle-mid (option SL = entryLTP − spotGapToPrevMid)`);
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
          validateAndGetOptionSymbol(spot, "CE"),
          validateAndGetOptionSymbol(spot, "PE"),
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
  sendTelegram([
    `${_ptAllOk ? "✅" : "⚠️"} PAPER TRADE STARTED`,
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
  ].join("\n"));

  // ── PRE-LOAD today's historical candles so strategy fires immediately ────────
  // Without this, EMA (needs 25 candles) / RSI (needs 16) won't fire for hours
  try {
    log(`📥 Pre-loading historical candles so strategy warms up instantly...`);
    const { fetchCandles } = require("../services/backtestEngine");
    const { fetchCandlesCached } = require("../utils/candleCache");

    // Go back 5 calendar days to cover weekends/holidays and guarantee 30+ candles
    const fromDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    fromDate.setDate(fromDate.getDate() - 5);
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
    socketManager.stop();
    sharedSocketState.clear();
    saveSession();
  });

  log(`📡 Subscribing to ${subscribeSymbol} for live tick data...`);

  // Start the socket manager — single socket, spot-only to begin
  socketManager.start(subscribeSymbol, onTick, log);
  sharedSocketState.setActive("PAPER_TRADE");

  return res.json({
    success:     true,
    message:     "Paper trading started! No real orders will be placed.",
    strategy:    { key: ACTIVE, name: strategy.NAME },
    instrument:  instrumentConfig.INSTRUMENT,
    lotQty:      getLotQty(),
    capital:     data.capital,
    monitorAt:   "GET /paperTrade/status",
  });
});

/**
 * GET /paperTrade/stop
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
  socketManager.stop();
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  sharedSocketState.clear();
  ptState.running = false;  // ← FIX: was missing — UI stayed "LIVE" after manual stop
  log("⏹ [PAPER] Paper trading stopped");

  const session = saveSession();

  return res.json({
    success:  true,
    message:  "Paper trading stopped. Session saved.",
    session,
    viewHistory: "GET /paperTrade/history",
  });
});

/**
 * GET /paperTrade/exit
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
 * GET /paperTrade/status
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
      "<div style=\"font-size:0.65rem;color:#4a6080;margin-top:2px;\">after ₹80 brok</div>";

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

/**
 * GET /paperTrade/status/data
 * JSON-only endpoint for AJAX polling — returns all dynamic state without HTML.
 * Called every 2 s by the client-side setInterval when trading is active.
 */
router.get("/status/data", (req, res) => {
  try {
    const strategy = getActiveStrategy();
    const data     = loadPaperData();

    // Unrealised PnL (mirrors /status logic)
    let unrealisedPnl = 0;
    let pnlSource     = "spot proxy";
    if (ptState.position && ptState.currentBar) {
      const { side, entryPrice, qty, optionEntryLtp, optionCurrentLtp } = ptState.position;
      const currentOptionLtp = ptState.optionLtp || optionCurrentLtp;
      if (optionEntryLtp && currentOptionLtp && optionEntryLtp > 0) {
        unrealisedPnl = parseFloat(((currentOptionLtp - optionEntryLtp) * qty).toFixed(2));
        pnlSource     = "option premium";
      } else if (ptState.currentBar) {
        unrealisedPnl = parseFloat(((ptState.currentBar.close - entryPrice) * (side === "CE" ? 1 : -1) * qty).toFixed(2));
      }
    }

    const pos           = ptState.position;
    const optEntryLtp   = pos ? (pos.optionEntryLtp || null)                       : null;
    const optCurrentLtp = pos ? (ptState.optionLtp || pos.optionCurrentLtp || null) : null;
    const optPremiumPnl = (optEntryLtp && optCurrentLtp)
      ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0)).toFixed(2)) : null;
    const optPremiumMove = (optEntryLtp && optCurrentLtp)
      ? parseFloat((optCurrentLtp - optEntryLtp).toFixed(2)) : null;
    const optPremiumPct  = (optEntryLtp && optCurrentLtp && optEntryLtp > 0)
      ? parseFloat(((optCurrentLtp - optEntryLtp) / optEntryLtp * 100).toFixed(2)) : null;
    // optStopPrice: same 50%-mid logic as the live stop — optionSL = entryLtp - |entrySpot - prevMid|
    const _optSp     = pos ? pos.spotAtEntry  : null;
    const _optPm     = pos ? pos.entryPrevMid : null;
    const _optStopPct1 = parseFloat(process.env.OPT_STOP_PCT || "0.15");
    const optStopPrice = (optEntryLtp && _optSp && _optPm)
      ? parseFloat((optEntryLtp - Math.max(Math.abs(_optSp - _optPm), 20)).toFixed(2))
      : optEntryLtp ? parseFloat((optEntryLtp * (1 - _optStopPct1)).toFixed(2)) : null;
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
      // Trades (full list for client-side filter/sort)
      trades: ptState.sessionTrades.map(t => ({
        side:    t.side           || "",
        strike:  t.optionStrike   || "",
        expiry:  t.optionExpiry   || "",
        entry:   t.entryTime      || "",
        exit:    t.exitTime       || "",
        eSpot:   t.spotAtEntry    || t.entryPrice || 0,
        eOpt:    t.optionEntryLtp || null,
        eSl:     t.stopLoss       || null,
        xSpot:   t.spotAtExit     || t.exitPrice  || 0,
        xOpt:    t.optionExitLtp  || null,
        pnl:     typeof t.pnl === "number" ? t.pnl : null,
        reason:  t.exitReason     || "",
      })),
      // Activity log — all entries newest-first (up to 2000 — matches ptState.log buffer)
      logTotal: ptState.log.length,   // full count — used by AJAX to detect new entries
      logs: [...ptState.log].reverse(),
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

  // Unrealised PnL if position is open — use OPTION LTP if available, else spot proxy
  let unrealisedPnl = 0;
  let pnlSource = "spot proxy";
  if (ptState.position && ptState.currentBar) {
    const { side, entryPrice, qty, optionEntryLtp, optionCurrentLtp } = ptState.position;
    const currentOptionLtp = ptState.optionLtp || optionCurrentLtp;
    if (optionEntryLtp && currentOptionLtp && optionEntryLtp > 0) {
      // Real option premium PnL
      unrealisedPnl = parseFloat(((currentOptionLtp - optionEntryLtp) * qty).toFixed(2));
      pnlSource = `option premium`;
    } else {
      // Fallback: spot movement
      const ltp = ptState.currentBar.close;
      unrealisedPnl = parseFloat(((ltp - entryPrice) * (side === "CE" ? 1 : -1) * qty).toFixed(2));
      pnlSource = "spot proxy";
    }
  }

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
  const optPremiumPnl = (optEntryLtp && optCurrentLtp)
    ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0)).toFixed(2))
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
  const _hOptStopPct = parseFloat(process.env.OPT_STOP_PCT || "0.15");
  const optStopPrice = (optEntryLtp && _h_sp && _h_pm)
    ? parseFloat((optEntryLtp - Math.max(Math.abs(_h_sp - _h_pm), 20)).toFixed(2))
    : optEntryLtp ? parseFloat((optEntryLtp * (1 - _hOptStopPct)).toFixed(2)) : null;
  const optStopPct   = (_h_sp && _h_pm)
    ? Math.abs(_h_sp - _h_pm).toFixed(1) + 'pt (50% mid)'
    : Math.round(_hOptStopPct * 100) + '% fallback';

  const posHtml = pos ? `
    <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">

      <!-- Header: status + entry time + MANUAL EXIT BUTTON -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 1.5s infinite;"></span>
          <span style="font-size:0.8rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;">Open Position</span>
          <span style="font-size:0.72rem;color:#4a6080;">Since ${pos.entryTime}</span>
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
                ? `captured at ${pos.optionEntryLtpTime || pos.entryTime}`
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
            <div style="font-size:0.65rem;color:#4a6080;margin-top:4px;">${pos.qty} qty · -₹80 brok</div>
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
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop Loss (SAR)</div>
          <div id="ajax-stop-loss" style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.stopLoss ? inr(pos.stopLoss) : "—"}</div>
          <div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">Risk: ${pos.stopLoss ? inr(Math.abs(pos.entryPrice - pos.stopLoss) * pos.qty) : "—"}</div>
        </div>
        <div style="background:#1c0d00;border:1px solid #92400e;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Option SL (${optStopPct})</div>
          <div id="ajax-opt-sl" style="font-size:1.05rem;font-weight:700;color:#f97316;">${optStopPrice ? "₹" + optStopPrice.toFixed(2) : "—"}</div>
          <div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">${optEntryLtp ? "entry 20b9" + optEntryLtp.toFixed(2) + " 2212 " + optStopPct : "awaiting entry LTP"}</div>
        </div>
        <div id="ajax-trail-card" style="background:#071a12;border:1px solid ${trailActive && trailProfit >= (pos.trailActivatePts || 15) ? "#8b5cf6" : "#134e35"};border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Trail Status</div>
          <div id="ajax-trail-status" style="font-size:0.88rem;font-weight:700;color:${trailActive && trailProfit >= (pos.trailActivatePts || 15) ? "#8b5cf6" : "#f59e0b"};">${trailActive && trailProfit >= (pos.trailActivatePts || 15) ? "🔒 ACTIVE" : "⏳ Waiting"}</div>
          <div id="ajax-trail-best" style="font-size:0.63rem;color:#4a6080;margin-top:2px;">Best: ${pos.bestPrice ? inr(pos.bestPrice) : "—"} (${trailProfit >= 0 ? "+" : ""}${trailProfit.toFixed(1)} pts)</div>
          <div id="ajax-trail-activate" style="font-size:0.63rem;color:#4a6080;margin-top:2px;">Activates at +${pos.trailActivatePts || 15}pt | Gap: ${_TRAIL_T1_GAP}→${_TRAIL_T2_GAP}→${_TRAIL_T3_GAP}pt</div>
        </div>
      </div>

      ${pos.reason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;">📝 ${pos.reason}</div>` : ""}
    </div>` : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:1.5rem;margin-bottom:8px;">📭</div>
      <div style="font-size:0.9rem;font-weight:600;color:#4a6080;">FLAT — Waiting for entry signal</div>
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
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#060e06;color:#c0d8b0;overflow-x:hidden;}
${sidebarCSS()}
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
${buildSidebar('paper', sharedSocketState.getMode()==='LIVE_TRADE', ptState.running, {
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
      <div class="sc-val" style="font-size:0.85rem;color:#c8d8f0;">${ptState.sessionStart || "—"}</div>
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
    </div>
    <div style="border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#0a0f1c;">
          <th onclick="ptSort('side')"   style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Side ▲▼</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Strike / Expiry</th>
          <th onclick="ptSort('entry')"  style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Entry Time ▼</th>
          <th onclick="ptSort('exit')"   style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Exit Time ▲▼</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry (NIFTY / Option)</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit (NIFTY / Option)</th>
          <th onclick="ptSort('pnl')"    style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Net P&amp;L ₹ ▲▼</th>
          <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit Reason</th>
          <th style="padding:9px 12px;text-align:center;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">View</th>
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
      ? '<tr><td colspan="9" style="text-align:center;padding:20px;color:#4a6080;">No trades match filters.</td></tr>'
      : slice.map((t, i) => {
          const sc  = t.side === 'CE' ? '#10b981' : '#ef4444';
          const pc  = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
          const short = t.reason.length > 35 ? t.reason.slice(0,35)+'\u2026' : t.reason;
          const optDiff = (t.eOpt != null && t.xOpt != null) ? parseFloat((t.xOpt - t.eOpt).toFixed(2)) : null;
          const dc  = optDiff == null ? '#4a6080' : optDiff >= 0 ? '#10b981' : '#ef4444';
          return \`<tr style="border-top:1px solid #1a2236;vertical-align:top;">
            <td style="padding:8px 12px;color:\${sc};font-weight:800;">\${t.side||'—'}</td>
            <td style="padding:8px 12px;">
              <div style="font-size:0.95rem;font-weight:800;color:#fff;">\${t.strike||'—'}</div>
              <div style="font-size:0.68rem;color:#f59e0b;margin-top:2px;">\${t.expiry||'—'}</div>
            </td>
            <td style="padding:8px 12px;font-size:0.75rem;">\${t.entry||'—'}</td>
            <td style="padding:8px 12px;font-size:0.75rem;">\${t.exit||'—'}</td>
            <td style="padding:8px 12px;">
              <div style="font-size:0.65rem;color:#4a6080;">NIFTY SPOT</div>
              <div style="font-weight:700;">\${ptFmt(t.eSpot)}</div>
              <div style="font-size:0.65rem;color:#4a6080;margin-top:3px;">OPTION PREM</div>
              <div style="color:#60a5fa;font-weight:700;">\${t.eOpt!=null?ptFmt(t.eOpt):'—'}</div>
              \${t.eSl?'<div style="font-size:0.63rem;color:#f59e0b;margin-top:2px;">Init SL '+ptFmt(t.eSl)+'</div>':''}
            </td>
            <td style="padding:8px 12px;">
              <div style="font-size:0.65rem;color:#4a6080;">NIFTY SPOT</div>
              <div style="font-weight:700;">\${ptFmt(t.xSpot)}</div>
              <div style="font-size:0.65rem;color:#4a6080;margin-top:3px;">OPTION PREM</div>
              <div style="color:#60a5fa;font-weight:700;">\${t.xOpt!=null?ptFmt(t.xOpt):'—'}</div>
              \${optDiff!=null?'<div style="font-size:0.63rem;color:'+dc+';margin-top:2px;">'+(optDiff>=0?'▲ +':'▼ ')+optDiff+' pts</div>':''}
            </td>
            <td style="padding:8px 12px;">
              <div style="font-size:1rem;font-weight:800;color:\${pc};">\${t.pnl!=null?(t.pnl>=0?'+':'')+ptFmt(t.pnl):'—'}</div>
              <div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">after \u20b980 brok</div>
            </td>
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
      + cell('Net PnL', t.pnl != null ? (t.pnl >= 0 ? '+' : '') + fmt(t.pnl) : '—', pc, 'After ₹80 brokerage')
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
logFilter();
</script>
<script src="/paperTrade/client.js"></script>
<script>
// ── AJAX live refresh — replaces meta http-equiv="refresh" ──────────────────
// Polls /paperTrade/status/data every 2 s when trading is active.
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
      const res = await fetch('/paperTrade/status/data', { cache: 'no-store' });
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
          const tProfDir    = p.side === 'CE' ? p.bestPrice - p.entryPrice : p.entryPrice - p.bestPrice;
          const tThreshold  = p.trailActivatePts || 15;
          const tOn         = tActive && tProfDir >= tThreshold;
          trailCard.style.borderColor = tOn ? '#8b5cf6' : '#134e35';
          trailStat.textContent  = tOn ? '\uD83D\uDD12 ACTIVE' : '\u23F3 Waiting';
          trailStat.style.color  = tOn ? '#8b5cf6' : '#f59e0b';
          const pts = tProfDir >= 0 ? '+' + tProfit.toFixed(1) : tProfit.toFixed(1);
          trailBest.textContent  = tActive ? 'Best: \u20b9' + p.bestPrice.toLocaleString('en-IN') + ' (' + pts + ' pts)' : 'Best: \u2014 (+0.0 pts)';
          if (trailAct) trailAct.textContent = 'Activates at +' + tThreshold + 'pt | needs ' + Math.max(0, tThreshold - tProfDir).toFixed(1) + 'pt more';
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
 * GET /paperTrade/history
 * All past paper trade sessions with summary stats
 */
router.get("/history", (req, res) => {
  const data = loadPaperData();

  // Attach session date to each trade for CSV export
  const allTrades = data.sessions.flatMap(s =>
    (s.trades || []).map(t => ({ ...t, date: s.date }))
  );
  const totalWins   = allTrades.filter(t => t.pnl > 0).length;
  const totalLosses = allTrades.filter(t => t.pnl <= 0).length;
  const inr = (n) => typeof n === "number"
    ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
  const pnlColor = (n) => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";

  const sessionCards = data.sessions.length === 0
    ? `<div style="text-align:center;padding:60px 24px;background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;">
        <div style="font-size:3rem;margin-bottom:16px;">📭</div>
        <div style="font-size:1rem;font-weight:600;color:#e0eaf8;margin-bottom:8px;">No sessions yet</div>
        <div style="font-size:0.82rem;color:#4a6080;">Start paper trading to record your first session.</div>
       </div>`
    : data.sessions.slice().reverse().map((s, idx) => {
        const sIdx = data.sessions.length - idx;
        const trades = s.trades || [];
        const sessionWins = trades.filter(t => t.pnl > 0).length;
        const sessionLosses = trades.filter(t => t.pnl <= 0).length;
        const avgWin  = sessionWins   ? (trades.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0)/sessionWins).toFixed(0)   : null;
        const avgLoss = sessionLosses ? (trades.filter(t=>t.pnl<=0).reduce((a,t)=>a+t.pnl,0)/sessionLosses).toFixed(0) : null;

        const tradeRows = trades.map(t => {
          const badgeCls = t.side === "CE" ? "badge-ce" : "badge-pe";
          const entrySpot   = inr(t.spotAtEntry || t.entryPrice);
          const entryOpt    = t.optionEntryLtp  ? inr(t.optionEntryLtp)  : "—";
          const exitSpot    = inr(t.spotAtExit  || t.exitPrice);
          const exitOpt     = t.optionExitLtp   ? inr(t.optionExitLtp)   : "—";
          const strikeStr   = t.optionStrike ? `<div style="font-weight:700;color:#e0eaf8;">${t.optionStrike}</div><div style="font-size:0.6rem;color:#f59e0b;">${t.optionExpiry||""}</div>` : "—";
          const pnlStr      = `<span style="font-weight:800;color:${pnlColor(t.pnl)};">${t.pnl>=0?"+":""}${inr(t.pnl)}</span>`;
          const reason      = (t.exitReason||"—").substring(0,50);
          return `<tr>
            <td><span class="badge ${badgeCls}">${t.side}</span></td>
            <td>${strikeStr}</td>
            <td style="color:#c8d8f0;">${t.entryTime||"—"}</td>
            <td style="color:#c8d8f0;">${t.exitTime||"—"}</td>
            <td><div style="color:#c8d8f0;">${entrySpot}</div><div style="font-size:0.65rem;color:#60a5fa;">${entryOpt}</div></td>
            <td><div style="color:#c8d8f0;">${exitSpot}</div><div style="font-size:0.65rem;color:#60a5fa;">${exitOpt}</div></td>
            <td>${pnlStr}</td>
            <td style="font-size:0.7rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${reason}</td>
          </tr>`;
        }).join("");

        return `
        <div class="session-card">
          <div class="session-head">
            <div>
              <div class="session-meta">Session ${sIdx} &middot; ${s.date} &middot; ${s.strategy||"—"} &middot; ${s.instrument||"NIFTY"}</div>
              <div class="session-name">${s.startTime||""} → ${s.endTime||""}</div>
              <div style="margin-top:6px;display:flex;gap:10px;font-size:0.7rem;color:#4a6080;">
                <span>${trades.length} trade${trades.length!==1?"s":""}</span>
                <span style="color:#10b981;">${sessionWins}W</span>
                <span style="color:#ef4444;">${sessionLosses}L</span>
                <span>WR ${s.winRate||"—"}</span>
                ${avgWin   ? `<span style="color:#10b981;">Avg W: ₹${avgWin}</span>`   : ""}
                ${avgLoss  ? `<span style="color:#ef4444;">Avg L: ₹${avgLoss}</span>`  : ""}
              </div>
            </div>
            <div>
              <div class="session-pnl" style="color:${pnlColor(s.sessionPnl)};">${s.sessionPnl>=0?"+":""}${inr(s.sessionPnl)}</div>
              <div class="session-wl">${sessionWins}W / ${sessionLosses}L</div>
            </div>
          </div>
          ${trades.length > 0 ? `
          <div style="overflow-x:auto;">
            <div class="tbl-wrap"><table class="tbl">
              <thead><tr>
                <th>Side</th><th>Strike</th><th>Entry Time</th><th>Exit Time</th>
                <th>Entry NIFTY / Opt</th><th>Exit NIFTY / Opt</th><th>PnL</th><th>Reason</th>
              </tr></thead>
              <tbody>${tradeRows}</tbody>
            </table>
          </div>` : `<div style="padding:14px 20px;color:#4a6080;font-size:0.82rem;">No trades in this session.</div>`}
        </div>`;
      }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>ௐ Palani Andawar Thunai ॐ — History</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    .session-card{background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;overflow:hidden;margin-bottom:18px;}
    .session-head{padding:16px 20px;display:flex;align-items:center;justify-content:space-between;background:#040c18;border-bottom:0.5px solid #0e1e36;gap:12px;flex-wrap:wrap;}
    .session-meta{font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;margin-bottom:4px;}
    .session-name{font-size:0.95rem;font-weight:700;color:#e0eaf8;}
    .session-pnl{font-size:1.5rem;font-weight:800;font-family:'IBM Plex Mono',monospace;text-align:right;}
    .session-wl{font-size:0.7rem;color:#4a6080;text-align:right;margin-top:2px;}
    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.75rem;}
    .tbl th{padding:8px 14px;text-align:left;font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;}
    .tbl td{padding:8px 14px;border-top:0.5px solid #0e1e36;color:#4a6080;vertical-align:middle;}
    .tbl tr:hover td{background:rgba(59,130,246,0.03);}
    .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.65rem;font-weight:700;}
    .badge-ce{background:rgba(16,185,129,0.12);color:#10b981;border:0.5px solid rgba(16,185,129,0.25);}
    .badge-pe{background:rgba(239,68,68,0.12);color:#ef4444;border:0.5px solid rgba(239,68,68,0.25);}
    .export-btn{background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 12px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.12s;}
    .export-btn:hover{border-color:#3b82f6;color:#60a5fa;}
    @media(max-width:768px){
      .sidebar{transform:translateX(-100%);}
      .main-content{margin-left:0;}
      .tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
      .tbl{min-width:700px;}
      .tbl td,.tbl th{padding:6px 8px;font-size:0.68rem;}
      .top-bar{padding:7px 10px 7px 48px;}
      .top-bar-meta{display:none;}
      .stat-grid{grid-template-columns:1fr 1fr;}
      .top-bar-right{gap:4px;}
      .export-btn{padding:4px 8px;font-size:0.62rem;}
    }
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('history', sharedSocketState.getMode()==='LIVE_TRADE', false, {})}
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">📊 Paper Trade History</div>
      <div class="top-bar-meta">${data.sessions.length} sessions · ${allTrades.length} total trades · Stored at ~/trading-data/ (deploy-safe)</div>
    </div>
    <div class="top-bar-right">
      <button onclick="exportAllCSV()" class="export-btn">⬇ Export CSV</button>
      <a href="/paperTrade/status" style="background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;text-decoration:none;cursor:pointer;">← Status</a>
    </div>
  </div>

  <div class="page">

    <!-- Summary stat cards -->
    <div class="stat-grid" style="margin-bottom:22px;">
      <div class="sc" style="--accent:#1e3080;">
        <div class="sc-label">Starting Capital</div>
        <div class="sc-val">${inr(getCapitalFromEnv())}</div>
      </div>
      <div class="sc" style="--accent:${(data.capital - getCapitalFromEnv()) >= 0 ? '#065f46' : '#7f1d1d'};">
        <div class="sc-label">Current Capital</div>
        <div class="sc-val" style="color:${pnlColor(data.capital - getCapitalFromEnv())};">${inr(data.capital)}</div>
        <div class="sc-sub">${(data.capital - getCapitalFromEnv()) >= 0 ? '▲' : '▼'} ${inr(Math.abs(data.capital - getCapitalFromEnv()))} vs start</div>
      </div>
      <div class="sc" style="--accent:${data.totalPnl >= 0 ? '#065f46' : '#7f1d1d'};">
        <div class="sc-label">All-Time PnL</div>
        <div class="sc-val" style="color:${pnlColor(data.totalPnl)};">${data.totalPnl >= 0 ? '+' : ''}${inr(data.totalPnl)}</div>
      </div>
      <div class="sc" style="--accent:#1e3080;">
        <div class="sc-label">Overall Win Rate</div>
        <div class="sc-val">${allTrades.length ? ((totalWins / allTrades.length) * 100).toFixed(1) + '%' : '—'}</div>
        <div class="sc-sub">${totalWins}W · ${totalLosses}L · ${allTrades.length} trades</div>
      </div>
      <div class="sc" style="--accent:#1e3080;">
        <div class="sc-label">Sessions</div>
        <div class="sc-val">${data.sessions.length}</div>
        <div class="sc-sub">across all time</div>
      </div>
      <div class="sc" style="--accent:#1e3080;">
        <div class="sc-label">Data Location</div>
        <div class="sc-val" style="font-size:0.7rem;color:#4a6080;word-break:break-all;">~/trading-data/</div>
        <div class="sc-sub">survives redeploys</div>
      </div>
    </div>

    <!-- Session cards -->
    <div class="section-title">Sessions — newest first</div>
    ${sessionCards}

  </div>
</div>
</div>

<script>
// Flatten all trades for CSV export
var ALL_TRADES_JSON = ${JSON.stringify(allTrades)};

function exportAllCSV() {
  if (!ALL_TRADES_JSON.length) { alert('No trades to export'); return; }
  var header = ['Session Date','Side','Symbol','Strike','Expiry','Entry Time','Exit Time','Entry NIFTY','Entry Option','Exit NIFTY','Exit Option','SL','PnL','Exit Reason'];
  var rows = ALL_TRADES_JSON.map(function(t) {
    return [
      t.date||'', t.side||'', t.symbol||'', t.optionStrike||'', t.optionExpiry||'',
      t.entryTime||'', t.exitTime||'',
      t.spotAtEntry||t.entryPrice||'', t.optionEntryLtp||'',
      t.spotAtExit||t.exitPrice||'', t.optionExitLtp||'',
      t.stopLoss||'', t.pnl!=null?t.pnl:'', t.exitReason||''
    ];
  });
  var csv = [header].concat(rows).map(function(r) {
    return r.map(function(v){ return '"' + String(v||'').replace(/"/g,'""')+'"'; }).join(',');
  }).join('\n');
  var d = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(csv);
  a.download = 'paper_history_' + d + '.csv';
  a.click();
}
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
});

/**
 * GET /paperTrade/reset
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
 * GET /paperTrade/debug
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
 * GET /paperTrade/client.js
 * Serves the paper trade UI JavaScript as a static file.
 * Keeping it separate prevents ANY data injection from breaking the buttons.
 */
router.get("/client.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-cache");
  res.send('async function handleStart(btn) {\n  if (btn) { btn.textContent = \'⏳ Starting...\'; btn.disabled = true; }\n  try {\n    const res = await fetch(\'/paperTrade/start\');\n    let data;\n    try { data = await res.json(); } catch(_) { data = { success: false, error: \'Server error (non-JSON response)\' }; }\n    if (!data.success) {\n      const errMsg = data.error || \'Failed to start\';\n      showToast(\'❌ \' + errMsg, \'#ef4444\');\n      if (btn) { btn.textContent = \'▶ Start\'; btn.disabled = false; }\n      return;\n    }\n    showToast(\'✅ Paper trading started!\', \'#10b981\');\n    setTimeout(() => location.reload(), 1200);\n  } catch(e) {\n    showToast(\'❌ \' + e.message, \'#ef4444\');\n    if (btn) { btn.textContent = \'▶ Start\'; btn.disabled = false; }\n  }\n}\nasync function handleStop(btn) {\n  if (btn) { btn.textContent = \'⏳ Stopping...\'; btn.disabled = true; }\n  try {\n    await fetch(\'/paperTrade/stop\');\n    showToast(\'⏹ Paper trading stopped.\', \'#ef4444\');\n    setTimeout(() => location.reload(), 1000);\n  } catch(e) {\n    showToast(\'❌ \' + e.message, \'#ef4444\');\n    if (btn) { btn.textContent = \'⏹ Stop\'; btn.disabled = false; }\n  }\n}\nasync function ptHandleReset(btn) {\n  if (!confirm(\'⚠️ Reset ALL paper trade history?\\nThis will wipe all sessions and restore starting capital.\\nCannot be undone.\')) return;\n  if (btn) { btn.textContent = \'⏳...\'; btn.disabled = true; }\n  try {\n    const res = await fetch(\'/paperTrade/reset\');\n    let data;\n    try { data = await res.json(); } catch(_) { data = { success: false, error: \'Server error (status \' + res.status + \')\' }; }\n    if (!data.success) {\n      const errMsg = data.error || \'Reset failed\';\n      showToast(\'❌ \' + errMsg, \'#ef4444\');\n      if (btn) { btn.textContent = \'🔄 Reset\'; btn.disabled = false; }\n      return;\n    }\n    showToast(\'✅ \' + data.message, \'#10b981\');\n    setTimeout(() => location.reload(), 1500);\n  } catch(e) {\n    showToast(\'❌ \' + e.message, \'#ef4444\');\n    if (btn) { btn.textContent = \'🔄 Reset\'; btn.disabled = false; }\n  }\n}\nfunction ptExportCSV() {\n  var PT = typeof PT_ALL !== \'undefined\' ? PT_ALL : [];\n  if (!PT.length) { showToast(\'⚠️ No trades to export\', \'#f59e0b\'); return; }\n  var header = [\'Side\',\'Symbol\',\'Entry Time\',\'Exit Time\',\'Entry NIFTY\',\'Entry Option\',\'Exit NIFTY\',\'Exit Option\',\'PnL\',\'Exit Reason\'];\n  var rows = PT.map(function(t){\n    return [\n      t.side||\'\', t.symbol||\'\',\n      t.entryTime||\'\', t.exitTime||\'\',\n      t.entryPrice||\'\', t.optionEntryLtp||\'\',\n      t.spotAtExit||\'\', t.optionExitLtp||\'\',\n      t.pnl!=null?t.pnl:\'\', t.reason||\'\'\n    ];\n  });\n  var csv = [header].concat(rows).map(function(r){\n    return r.map(function(v){ return \'"\'+String(v||\'\').replace(/"/g,\'""\')+\'"\'; }).join(\',\');\n  }).join(\'\\n\');\n  var d = new Date().toLocaleDateString(\'en-CA\',{timeZone:\'Asia/Kolkata\'});\n  var a = document.createElement(\'a\');\n  a.href = \'data:text/csv;charset=utf-8,\\uFEFF\' + encodeURIComponent(csv);\n  a.download = \'paper_trades_\' + d + \'.csv\';\n  a.click();\n  showToast(\'✅ CSV downloaded — \' + PT.length + \' trades\', \'#10b981\');\n}\nasync function ptHandleExit(btn) {\n  if (btn) { btn.textContent = \'⏳ Exiting...\'; btn.disabled = true; }\n  try {\n    const res = await fetch(\'/paperTrade/exit\');\n    const data = await res.json();\n    if (!data.success) {\n      showToast(\'❌ \' + (data.error || \'Exit failed\'), \'#ef4444\');\n      if (btn) { btn.textContent = \'🚪 Exit Trade\'; btn.disabled = false; }\n      return;\n    }\n    showToast(\'🚪 Trade exited!\', \'#f59e0b\');\n    setTimeout(() => location.reload(), 1000);\n  } catch(e) {\n    showToast(\'❌ \' + e.message, \'#ef4444\');\n    if (btn) { btn.textContent = \'🚪 Exit Trade\'; btn.disabled = false; }\n  }\n}\nfunction showToast(msg, color) {\n  const t = document.createElement(\'div\');\n  t.textContent = msg;\n  t.style.cssText = \'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#0d1320;border:1px solid \'+color+\';color:\'+color+\';padding:12px 24px;border-radius:10px;font-size:0.85rem;font-weight:700;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,0.6);letter-spacing:0.5px;\';\n  document.body.appendChild(t);\n  setTimeout(() => t.remove(), color === \'#ef4444\' ? 7000 : 4000); // errors stay longer\n}\n');
});



// CSV export route removed — server-side CSV no longer available.
// All console output is accessible via the /logs page.


module.exports = router;
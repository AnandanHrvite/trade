/**
 * trade.js — Live Trading Routes
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * DATA LAYER  → Fyers (WebSocket ticks, REST quotes, candle pre-load)
 * ORDER LAYER → Zerodha Kite Connect (place/square-off live orders)
 *
 * Backtest & Paper Trade are UNAFFECTED — they never call this file.
 *
 * Routes:
 *   GET /swing-live/start   — Start live trading
 *   GET /swing-live/stop    — Stop & square off
 *   GET /swing-live/status  — Live status page
 *   GET /swing-live/exit    — Manual exit current position only (session continues)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");

const socketManager     = require("../utils/socketManager");
const fyers             = require("../config/fyers");
const tradeGuards       = require("../utils/tradeGuards");
const zerodha           = require("../services/zerodhaBroker");
const { getActiveStrategy, ACTIVE } = require("../strategies");
const instrumentConfig = require("../config/instrument");
const { getSymbol, getLotQty, getProductType, calcATMStrike, getNearestThursdayExpiry, validateAndGetOptionSymbol, getLiveSpot } = instrumentConfig;
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const { getCharges } = require("../utils/charges");
const { saveTradePosition, clearTradePosition } = require("../utils/positionPersist");

// ── Module-level caches (avoid repeated env reads / allocations in hot paths) ─
const TRADE_RES = parseInt(process.env.TRADE_RESOLUTION || "15", 10); // candle resolution in minutes
let _cachedClosedCandleSL = null; // SAR SL from last FULLY CLOSED candle — updated in onCandleClose, used in every tick

// ── Trail tier config — cached at module load (never changes at runtime) ─────
// getDynamicTrailGap() was calling parseFloat(process.env.TRAIL_TIER*) on every tick.
// Pre-reading these once eliminates 750+ env reads/min when in position.
const _TRAIL_T1_UPTO = parseFloat(process.env.TRAIL_TIER1_UPTO || "30");
const _TRAIL_T2_UPTO = parseFloat(process.env.TRAIL_TIER2_UPTO || "55");
const _TRAIL_T1_GAP  = parseFloat(process.env.TRAIL_TIER1_GAP  || "40");
const _TRAIL_T2_GAP  = parseFloat(process.env.TRAIL_TIER2_GAP  || "25");
const _TRAIL_T3_GAP  = parseFloat(process.env.TRAIL_TIER3_GAP  || "15");
const _TRAIL_ACTIVATE_PTS = parseFloat(process.env.TRAIL_ACTIVATE_PTS || "12");
const _MAX_DAILY_TRADES   = parseInt(process.env.MAX_DAILY_TRADES || "20", 10);
const _MAX_DAILY_LOSS     = parseFloat(process.env.MAX_DAILY_LOSS || "5000");
const _OPT_STOP_PCT       = parseFloat(process.env.OPT_STOP_PCT || "0.15");

// ── EOD stop time — cached at module load ─────────────────────────────────────
// parseMins("TRADE_STOP_TIME","15:30") was called on every candle close.
const _STOP_MINS = (function() {
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
})();

// ── isMarketHours() cache (60-second TTL) ────────────────────────────────────
let _mktHoursCache   = null;
let _mktHoursCacheTs = 0;
let _mktHoursParamsTs = 0;

// Cached start/stop mins — read from .env once at module load
const _START_MINS      = (function(){ const [h,m]=(process.env.TRADE_START_TIME||"09:15").split(":").map(Number); return h*60+(isNaN(m)?0:m); })();
const _ENTRY_STOP_MINS = _STOP_MINS - 10;

// Fast IST minutes (no Date/ICU allocation) — UTC+5:30 = +19800s
function getISTMinutes() {
  const istSec = Math.floor(Date.now()/1000) + 19800;
  return Math.floor(istSec/60) % 1440;
}
const sharedSocketState = require("../utils/sharedSocketState");
const { notifyEntry, notifyExit, notifyStarted, notifySignal, notifyDayReport, sendTelegram, canSend, isConfigured } = require("../utils/notify");
const { fetchCandles } = require("../services/backtestEngine");
const { fetchCandlesCached } = require("../utils/candleCache");
// ── Live session persistence ──────────────────────────────────────────────────
// Stored at ~/trading-data/ — outside project dir, survives git pull / redeploys.
const _HOME_LT = require("os").homedir();
const LT_DIR   = path.join(_HOME_LT, "trading-data");
const LT_FILE  = path.join(LT_DIR, "live_trades.json");

// One-time migration from old ./data/live_trades.json
const _OLD_LT_FILE = path.join(__dirname, "../../data/live_trades.json");
(function migrateLiveOnce() {
  try {
    if (!fs.existsSync(LT_FILE) && fs.existsSync(_OLD_LT_FILE)) {
      if (!fs.existsSync(LT_DIR)) fs.mkdirSync(LT_DIR, { recursive: true });
      fs.copyFileSync(_OLD_LT_FILE, LT_FILE);
      console.log("[trade] Migrated live_trades.json → ~/trading-data/");
    }
  } catch (e) { console.warn("[trade] Live migration check:", e.message); }
})();

function ensureLiveDir() {
  if (!fs.existsSync(LT_DIR)) fs.mkdirSync(LT_DIR, { recursive: true });
}

function loadLiveData() {
  ensureLiveDir();
  if (!fs.existsSync(LT_FILE)) {
    const initial = { sessions: [] };
    fs.writeFileSync(LT_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try { return JSON.parse(fs.readFileSync(LT_FILE, "utf-8")); }
  catch (_) { return { sessions: [] }; }
}

function saveLiveSession() {
  if (!tradeState.sessionTrades || tradeState.sessionTrades.length === 0) return;
  try {
    const data = loadLiveData();
    data.sessions.push({
      date:       tradeState.sessionStart || new Date().toISOString(),
      strategy:   ACTIVE,
      instrument: instrumentConfig.INSTRUMENT,
      pnl:        tradeState.sessionPnl,
      trades:     tradeState.sessionTrades,
    });
    ensureLiveDir();
    fs.writeFileSync(LT_FILE, JSON.stringify(data, null, 2));
    log(`💾 [LIVE] Session saved — ${tradeState.sessionTrades.length} trades, PnL: ₹${tradeState.sessionPnl}`);

    // ── Feature 3: Daily Trade Journal / Report ──────────────────────────────
    generateDailyReport(tradeState.sessionTrades, tradeState.sessionPnl);
  } catch (err) {
    log(`⚠️ [LIVE] Could not save session: ${err.message}`);
  }
}

function generateDailyReport(trades, sessionPnl) {
  try {
    if (!trades || trades.length === 0) return;

    const wins    = trades.filter(t => t.pnl > 0);
    const losses  = trades.filter(t => t.pnl < 0);
    const winRate = ((wins.length / trades.length) * 100).toFixed(1);
    const avgWin  = wins.length   ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(0)   : 0;
    const avgLoss = losses.length ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(0) : 0;
    const bestTrade  = trades.reduce((b, t) => t.pnl > b.pnl ? t : b, trades[0]);
    const worstTrade = trades.reduce((w, t) => t.pnl < w.pnl ? t : w, trades[0]);

    // Exit reason breakdown
    const exitGroups = {};
    trades.forEach(t => {
      const label = t.exitReason.includes("50% rule")       ? "50% Rule"
                  : t.exitReason.includes("SL hit")         ? "SL Hit"
                  : t.exitReason.includes("trail") || t.exitReason.includes("Trail") ? "Trail SL"
                  : t.exitReason.includes("Opposite")       ? "Opposite Signal"
                  : t.exitReason.includes("EOD")            ? "EOD Square-off"
                  : t.exitReason.includes("Manual")         ? "Manual Exit"
                  : "Other";
      if (!exitGroups[label]) exitGroups[label] = { count: 0, pnl: 0, wins: 0 };
      exitGroups[label].count++;
      exitGroups[label].pnl += t.pnl;
      if (t.pnl > 0) exitGroups[label].wins++;
    });

    const dateStr = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
    const pnlEmoji = sessionPnl >= 0 ? "🟢" : "🔴";

    // Console report
    log(`\n${"═".repeat(54)}`);
    log(`📊 DAILY TRADE JOURNAL — ${dateStr}`);
    log(`${"─".repeat(54)}`);
    log(`   Trades    : ${trades.length} (${wins.length}W / ${losses.length}L)`);
    log(`   Win Rate  : ${winRate}%`);
    log(`   Session PnL: ${pnlEmoji} ₹${sessionPnl}`);
    log(`   Avg Win   : ₹${avgWin} | Avg Loss: ₹${avgLoss}`);
    log(`   Best Trade: ₹${bestTrade.pnl} (${bestTrade.side} ${bestTrade.exitReason})`);
    log(`   Worst Trade: ₹${worstTrade.pnl} (${worstTrade.side} ${worstTrade.exitReason})`);
    log(`${"─".repeat(54)}`);
    log(`   Exit Breakdown:`);
    Object.entries(exitGroups)
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([label, g]) => {
        const wr = ((g.wins / g.count) * 100).toFixed(0);
        log(`     ${label.padEnd(18)}: ${g.count}x | WR=${wr}% | PnL=₹${g.pnl.toFixed(0)}`);
      });
    log(`${"─".repeat(54)}`);
    log(`   Trade Log:`);
    trades.forEach((t, i) => {
      const pnlSign = t.pnl >= 0 ? "+" : "";
      const optInfo = t.optionEntryLtp ? ` | Opt ₹${t.optionEntryLtp}→₹${t.optionExitLtp || "?"}` : "";
      log(`     ${String(i+1).padStart(2)}. ${t.side} @ ₹${t.entryPrice}→₹${t.exitPrice} | ${pnlSign}₹${t.pnl}${optInfo} | ${t.exitReason}`);
    });
    log(`${"═".repeat(54)}\n`);

    // Telegram report
    if (canSend("TG_SWING_DAYREPORT")) {
      const exitBreakdown = Object.entries(exitGroups)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([label, g]) => `  ${label}: ${g.count}x (WR${((g.wins/g.count)*100).toFixed(0)}% PnL ₹${g.pnl.toFixed(0)})`)
        .join("\n");

      const telegramLines = [
        `⚡ SWING LIVE — DAY REPORT`,
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
        `Best : ₹${bestTrade.pnl} — ${bestTrade.side} ${bestTrade.exitReason}`,
        `Worst: ₹${worstTrade.pnl} — ${worstTrade.side} ${worstTrade.exitReason}`,
      ];
      sendTelegram(telegramLines.join("\n"));
    }

    // Save report to disk
    try {
      const reportDir  = path.join(LT_DIR, "reports");
      if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
      const reportDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const reportPath = path.join(reportDir, `live_report_${reportDate}.json`);
      const report = {
        date: reportDate, strategy: ACTIVE, instrument: instrumentConfig.INSTRUMENT,
        totalTrades: trades.length, wins: wins.length, losses: losses.length,
        winRate: `${winRate}%`, sessionPnl, avgWin: parseFloat(avgWin), avgLoss: parseFloat(avgLoss),
        bestPnl: bestTrade.pnl, worstPnl: worstTrade.pnl,
        exitBreakdown: exitGroups, trades,
      };
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      log(`📁 [LIVE] Daily report saved: ${reportPath}`);
    } catch (saveErr) {
      log(`⚠️ [LIVE] Could not save report file: ${saveErr.message}`);
    }
  } catch (err) {
    log(`⚠️ [LIVE] Daily report error: ${err.message}`);
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let tradeState = {
  running:        false,
  position:       null,
  candles:        [],
  log:            [],
  currentBar:     null,
  barStartTime:   null,
  optionLtp:      null,
  optionLtpUpdatedAt: null,   // timestamp of last successful LTP fetch (staleness detection)
  optionSymbol:   null,
  tickCount:      0,
  lastTickPrice:  null,
  sessionStart:   null,
  prevCandleHigh: null,
  prevCandleLow:  null,
  prevCandleMid:  null,  // ← mirrors paperTrade
  sessionTrades:  [],    // ← track live trades for P&L log
  sessionPnl:     0,     // ← running session P&L
  _entryPending:  false, // ← prevents double-entry on rapid ticks
  _slHitCandleTime: null, // ← blocks re-entry on same candle where SL was hit
  // Consecutive loss circuit breaker (mirrors paperTrade v36)
  _consecutiveLosses:    0,
  _pauseUntilTime:       null,   // epoch ms — block new entries until this time
  // Daily loss kill switch — latched true when session loss >= MAX_DAILY_LOSS (₹)
  // Blocks ALL new entries for the rest of the day. Resets only on session restart.
  _dailyLossHit:         false,
  _maxTradesLoggedCandle: null,  // last candle time where max-trades log was emitted (avoid spam)
  // ── Pre-fetched option symbols (populated after each candle close, used at entry) ──
  _cachedCE: null,  // { symbol, expiry, strike, spot, invalid } pre-fetched CE symbol
  _cachedPE: null,  // { symbol, expiry, strike, spot, invalid } pre-fetched PE symbol
  // ── 50%-rule exit pause: after a 50%-rule exit, block re-entry for 2 candles ──
  // Mirrors paperTrade — prevents re-entering same choppy conditions immediately
  _fiftyPctPauseUntil: null,
  // ── Intra-candle entry throttle for 15-min: only re-run getSignal when bar
  // high/low actually changes — avoids running full indicator stack every tick ──
  _lastCheckedBarHigh: null,
  _lastCheckedBarLow:  null,
  _missedLoggedCandle: null,  // throttle for signal-missed log (once per candle)
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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
  tradeState.log.push(entry);
  if (tradeState.log.length > 2500) tradeState.log.splice(0, tradeState.log.length - 2000);
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

// Pure integer math — avoids Date object allocation on every tick
function get5MinBucketStart(unixMs) {
  const resMs = TRADE_RES * 60_000;
  return Math.floor(unixMs / resMs) * resMs;
}

function parseMins(envKey, defaultVal) {
  const raw = process.env[envKey] || defaultVal;
  const [h, m] = raw.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
}

// Trade EXECUTION gate: TRADE_START_TIME (default 09:15) to TRADE_STOP_TIME-10min (default 15:20)
// Cached with 60-second TTL — called on every tick, Date object is expensive at 200 ticks/min.
function isMarketHours() {
  const now = Date.now();
  if (now - _mktHoursCacheTs < 60_000) return _mktHoursCache;
  const total = getISTMinutes(); // fast: integer arithmetic only, no Date/ICU
  _mktHoursCache   = total >= _START_MINS && total < _ENTRY_STOP_MINS;
  _mktHoursCacheTs = now;
  return _mktHoursCache;
}

function isStartAllowed() {
  return getISTMinutes() < _STOP_MINS;
}

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";

// ─────────────────────────────────────────────────────────────────────────────
// Option LTP — REST polling every 3s (same fix as paperTrade)
// ─────────────────────────────────────────────────────────────────────────────

let _rateLimitSkipCycles = 0; // skip N poll cycles after a rate-limit hit

async function fetchOptionLtp(symbol) {
  try {
    // Fyers v3: pass symbol string directly (not wrapped in object)
    const response = await fyers.getQuotes([symbol]);

    if (response.s === "ok" && response.d && response.d.length > 0) {
      const v = response.d[0].v || response.d[0];
      const ltp = v.lp || v.ltp || v.last_price || v.last_traded_price
               || v.ask_price || v.bid_price || v.close_price || v.prev_close_price;
      if (ltp && ltp > 0) {
        if (_rateLimitSkipCycles > 0 || fetchOptionLtp._rlActive) {
          log(`✅ [LIVE] Rate limit cleared — polling resumed`);
          _rateLimitSkipCycles = 0;
          fetchOptionLtp._rlActive = false;
        }
        return parseFloat(ltp);
      }
      log(`[DEBUG] All LTP fields null/zero for ${symbol} | v=${JSON.stringify(v).slice(0, 200)}`);
    } else {
      if (!fetchOptionLtp._errLogged) {
        log(`[DEBUG] getQuotes non-ok: s=${response.s} msg=${response.message || response.msg || "?"}`);
        fetchOptionLtp._errLogged = true;
        setTimeout(() => { delete fetchOptionLtp._errLogged; }, 30000);
      }
    }
  } catch (err) {
    const msg = err.message || "";
    if (/limit|throttle|429/i.test(msg)) {
      if (!fetchOptionLtp._rlActive) {
        log(`⚠️ [LIVE] Rate limit hit — skipping 2 poll cycles`);
        fetchOptionLtp._rlActive = true;
      }
      _rateLimitSkipCycles = 2;
    } else {
      log(`[DEBUG] fetchOptionLtp exception: ${msg}`);
    }
  }
  return null;
}

// ── Pre-fetch option symbols in background after each candle close ──────────
// Runs async immediately after candle close so that when a BUY signal fires
// on the next tick, the symbol is already resolved — no REST delay at entry.
async function prefetchOptionSymbols(spot) {
  if (instrumentConfig.INSTRUMENT === 'NIFTY_FUTURES') return; // not needed for futures
  try {
    const [ce, pe] = await Promise.all([
      validateAndGetOptionSymbol(spot, 'CE'),
      validateAndGetOptionSymbol(spot, 'PE'),
    ]);
    
    // Only cache valid symbols (reject invalid ones to force live lookup at entry)
    if (ce.invalid) {
      log(`⚠️ [LIVE] CE symbol invalid (${ce.symbol}) — skipping cache, will use live lookup`);
      tradeState._cachedCE = null;
    } else {
      tradeState._cachedCE = { ...ce, spot };
    }
    
    if (pe.invalid) {
      log(`⚠️ [LIVE] PE symbol invalid (${pe.symbol}) — skipping cache, will use live lookup`);
      tradeState._cachedPE = null;
    } else {
      tradeState._cachedPE = { ...pe, spot };
    }
    
    if (!ce.invalid && !pe.invalid) {
      log(`🔮 [LIVE] Pre-fetched options @ spot ₹${spot} → CE: ${ce.symbol} | PE: ${pe.symbol}`);
    }
  } catch (err) {
    log(`⚠️ [LIVE] Pre-fetch failed: ${err.message} — will fall back to live lookup at entry`);
    tradeState._cachedCE = null;
    tradeState._cachedPE = null;
  }
}

// Return cached symbol if spot hasn't moved > 25 pts, otherwise null (trigger fresh lookup)
function getCachedSymbol(side, currentSpot) {
  const cached = side === 'CE' ? tradeState._cachedCE : tradeState._cachedPE;
  if (!cached || cached.invalid) return null;
  if (Math.abs(cached.spot - currentSpot) > 25) return null; // spot moved — stale ATM
  return cached;
}

let _optionPollTimer = null;

function startOptionPolling(symbol) {
  stopOptionPolling();
  // First fetch immediately on entry
  fetchOptionLtp(symbol).then(ltp => {
    if (!ltp) return;
    tradeState.optionLtp = ltp;
    tradeState.optionLtpUpdatedAt = Date.now();
    if (tradeState.position) {
      tradeState.position.optionCurrentLtp = ltp;
      if (!tradeState.position.optionEntryLtp) {
        tradeState.position.optionEntryLtp     = ltp;
        tradeState.position.optionEntryLtpTime = istNow();
        log(`📌 [LIVE] Option entry LTP: ₹${ltp} (SPOT @ ₹${tradeState.position.spotAtEntry} | SL: ₹${tradeState.position.stopLoss} | TrailActivate: +${tradeState.position.trailActivatePts}pt)`);
        placeHardSL();  // Place exchange-level SL-M once we have option premium
      }
    }
  }).catch(err => log(`❌ [LIVE] Initial option LTP fetch error: ${err.message}`));

  // ── 10s timeout: if option LTP still null, use last tick price as proxy ───────
  setTimeout(() => {
    if (tradeState.position && !tradeState.position.optionEntryLtp && tradeState.lastTickPrice) {
      const proxy = tradeState.lastTickPrice;
      tradeState.position.optionEntryLtp     = proxy;
      tradeState.position.optionEntryLtpTime = istNow();
      log(`⚠️ [LIVE] Option LTP timeout — using spot ₹${proxy} as proxy entry LTP`);
    }
  }, 10000);
  // Then every 1 second
  _optionPollTimer = setInterval(async () => {
    try {
      if (!tradeState.position || !tradeState.optionSymbol) { stopOptionPolling(); return; }
      if (_rateLimitSkipCycles > 0) { _rateLimitSkipCycles--; return; }
      const ltp = await fetchOptionLtp(symbol);
      if (!ltp) {
        // ── LTP staleness alert — warn if no successful fetch for 15+ seconds ──
        const _staleThreshold = parseInt(process.env.LTP_STALE_THRESHOLD_SEC || "15", 10) * 1000;
        if (tradeState.optionLtpUpdatedAt && (Date.now() - tradeState.optionLtpUpdatedAt) > _staleThreshold) {
          if (!tradeState._ltpStaleLogged) {
            log(`⚠️ [LIVE] Option LTP STALE — no update for ${Math.round((Date.now() - tradeState.optionLtpUpdatedAt) / 1000)}s. P&L display may be inaccurate.`);
            tradeState._ltpStaleLogged = true;
          }
        }
        return;
      }
      tradeState.optionLtp = ltp;
      tradeState.optionLtpUpdatedAt = Date.now();
      if (tradeState._ltpStaleLogged) {
        log(`✅ [LIVE] Option LTP recovered — ₹${ltp}`);
        tradeState._ltpStaleLogged = false;
      }
      if (tradeState.position) {
        tradeState.position.optionCurrentLtp = ltp;
        if (!tradeState.position.optionEntryLtp) {
          tradeState.position.optionEntryLtp     = ltp;
          tradeState.position.optionEntryLtpTime = istNow();
          log(`📌 [LIVE] Option entry LTP: ₹${ltp} (SPOT @ ₹${tradeState.position.spotAtEntry} | SL: ₹${tradeState.position.stopLoss} | TrailActivate: +${tradeState.position.trailActivatePts}pt)`);
          placeHardSL();  // Place exchange-level SL-M once we have option premium
        }
      }
    } catch (err) {
      console.error(`🚨 [LIVE] Option poll error: ${err.message}`);
    }
  }, 1000); // 1000ms — tight option LTP SL monitoring (primary spot SL fires every tick)
}

function stopOptionPolling() {
  if (_optionPollTimer) { clearInterval(_optionPollTimer); _optionPollTimer = null; }
}

// ── EOD Backup Timer — force exit at 3:25 PM IST if tick-based exit missed ──
let _eodBackupTimer = null;

function scheduleEODBackupExit() {
  clearEODBackupTimer();
  const _EOD_EXIT_MINS = _STOP_MINS - 5; // 3:25 PM (5 mins before stop)
  const nowMins = getISTMinutes();
  if (nowMins >= _EOD_EXIT_MINS) return; // already past
  const msUntil = (_EOD_EXIT_MINS - nowMins) * 60 * 1000;
  _eodBackupTimer = setTimeout(() => {
    if (!tradeState.running || !tradeState.position) return;
    const exitPrice = tradeState.lastTickPrice || (tradeState.currentBar ? tradeState.currentBar.close : 0);
    log(`🚨 [LIVE] EOD BACKUP TIMER — force exit at 3:25 PM IST (tick-based exit may have missed)`);
    squareOff(exitPrice, "EOD backup timer (3:25 PM)").catch(e => log(`❌ [LIVE] EOD backup exit error: ${e.message}`));
  }, msUntil);
  log(`⏰ [LIVE] EOD backup timer set — force exit in ${Math.round(msUntil / 60000)} min (3:25 PM IST)`);
}

function clearEODBackupTimer() {
  if (_eodBackupTimer) { clearTimeout(_eodBackupTimer); _eodBackupTimer = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Order placement — ZERODHA (with duplicate order guard)
// ─────────────────────────────────────────────────────────────────────────────

let _orderInFlight    = false; // prevent duplicate ENTRY orders on rapid ticks
let _squareOffInFlight = false; // prevent concurrent EXIT calls (multiple SL ticks in-flight)

async function placeMarketOrder(fyersSymbol, side, qty) {
  if (_orderInFlight) {
    log(`⚠️  Order already in flight — skipping duplicate ${side === 1 ? "BUY" : "SELL"} ${fyersSymbol}`);
    return { success: false, reason: "duplicate_guard" };
  }
  _orderInFlight = true;
  const sideLabel = side === 1 ? "BUY" : "SELL";
  log(`📤 [LIVE] Placing ${sideLabel} ${qty} × ${fyersSymbol} via Zerodha...`);
  try {
    const result = await zerodha.placeMarketOrder(
      fyersSymbol, side, qty, `${ACTIVE}_LIVE`.substring(0, 20),
      { isFutures: instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" }
    );
    if (result.success) {
      log(`✅ [LIVE] Zerodha order filled — ${sideLabel} ${qty} × ${fyersSymbol} | OrderID: ${result.orderId}`);
      verifyOrderFill(result.orderId, `${sideLabel} ${qty} × ${fyersSymbol}`);
    } else {
      log(`❌ [LIVE] Zerodha order FAILED — ${sideLabel} ${qty} × ${fyersSymbol} | ${JSON.stringify(result.raw)}`);
    }
    return result;
  } catch (err) {
    log(`❌ [LIVE] Zerodha order exception — ${err.message}`);
    throw err;
  } finally {
    // Release guard after 5s to allow legitimate next orders
    setTimeout(() => { _orderInFlight = false; }, 5000);
  }
}

/**
 * Verify order fill status after placement (async, non-blocking).
 * Polls Zerodha order book after a delay to confirm the order was filled.
 * Logs warning + Telegram alert if order was rejected or still pending.
 */
function verifyOrderFill(orderId, label) {
  if (!orderId) return;
  setTimeout(async () => {
    try {
      const orders = await zerodha.getOrders();
      if (!Array.isArray(orders) || orders.length === 0) return;
      const order = orders.find(o => o.order_id === orderId);
      if (!order) {
        log(`⚠️ [LIVE] Order ${orderId} not found in order book (${label})`);
        return;
      }
      const status = (order.status || "").toUpperCase();
      if (status === "COMPLETE") {
        log(`✅ [LIVE] Order VERIFIED filled — ${orderId} (${label}) | qty=${order.filled_quantity}`);
      } else if (status === "REJECTED") {
        log(`🚨 [LIVE] Order REJECTED — ${orderId} (${label}) | reason: ${order.status_message || "unknown"}`);
        sendTelegram(`🚨 Order REJECTED: ${label} | ${order.status_message || "unknown"}`).catch(() => {});
      } else {
        log(`⚠️ [LIVE] Order status: ${status} — ${orderId} (${label}) | filled=${order.filled_quantity}/${order.quantity}`);
      }
    } catch (err) {
      log(`⚠️ [LIVE] Order verification failed: ${err.message}`);
    }
  }, 3000); // check 3s after placement
}

// ─────────────────────────────────────────────────────────────────────────────
// Hard SL — exchange-level SL-M orders (ZERODHA only)
// ─────────────────────────────────────────────────────────────────────────────
// When HARD_SL_ENABLED=true, the bot places a SL-M (Stop Loss Market) order
// at Zerodha immediately after entry. This order sits at the exchange and fires
// even if the bot crashes, the EC2 instance dies, or the socket disconnects.
//
// On every trail tighten, the SL-M trigger is modified via API.
// On any bot-initiated exit (opposite signal, EOD, manual), the SL-M is
// cancelled first, then a normal market exit is placed.
//
// The trigger price is estimated on the option premium:
//   triggerPremium = currentPremium - (spotMove * DELTA)
// This is approximate but provides >90% protection even if delta drifts.
// ─────────────────────────────────────────────────────────────────────────────

let _hardSLOrderId = null;  // Zerodha order ID of the active SL-M order

function isHardSLEnabled() {
  return process.env.HARD_SL_ENABLED === "true" && instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES";
}

/**
 * Place a Hard SL-M order after entry. Called once option LTP is captured.
 * Uses option premium as trigger: if spot hits SL, option premium drops roughly by delta * spotGap.
 */
async function placeHardSL() {
  if (!isHardSLEnabled() || !tradeState.position) return;
  const pos = tradeState.position;
  const optionLtp = tradeState.optionLtp || pos.optionEntryLtp;
  if (!optionLtp || !pos.stopLoss) return;

  const delta    = parseFloat(process.env.HARD_SL_DELTA || "0.5");
  const spotGap  = Math.abs(pos.spotAtEntry - pos.stopLoss);
  const premDrop = spotGap * delta;
  // SL-M trigger: option premium that corresponds to spot hitting the SL
  const triggerPrice = Math.max(0.5, parseFloat((optionLtp - premDrop).toFixed(1)));

  const isFut = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  // For options: always SELL (-1) to exit the bought CE/PE
  const slSide = -1;
  const qty = pos.qty || getLotQty();

  log(`🛡️ [HARD SL] Placing SL-M SELL ${qty} × ${pos.symbol} @ trigger ₹${triggerPrice} (opt LTP=₹${optionLtp}, spotSL=₹${pos.stopLoss}, Δ=${delta})`);

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await zerodha.placeSLMOrder(pos.symbol, slSide, qty, triggerPrice, { isFutures: isFut });
      if (result.success) {
        _hardSLOrderId = result.orderId;
        log(`✅ [HARD SL] SL-M placed — OrderID: ${result.orderId} | trigger=₹${triggerPrice}`);
        return;
      } else {
        log(`⚠️ [HARD SL] SL-M placement failed (attempt ${attempt}/${MAX_RETRIES}): ${JSON.stringify(result.raw)}`);
      }
    } catch (err) {
      log(`❌ [HARD SL] Exception (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
    }
    if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 1000));
  }
  _hardSLOrderId = null;
  log(`🚨 [HARD SL] All ${MAX_RETRIES} attempts failed — position has NO exchange-level SL protection!`);
  sendTelegram(`🚨 HARD SL FAILED after ${MAX_RETRIES} retries — position UNPROTECTED!`).catch(() => {});
}

/**
 * Modify the Hard SL trigger price (called when trailing tightens the SL).
 */
async function updateHardSL(newSpotSL) {
  if (!isHardSLEnabled() || !_hardSLOrderId || !tradeState.position) return;
  const optionLtp = tradeState.optionLtp;
  if (!optionLtp) return;

  const pos   = tradeState.position;
  const delta = parseFloat(process.env.HARD_SL_DELTA || "0.5");
  const spotGap = Math.abs(tradeState.lastTickPrice - newSpotSL);
  const newTrigger = Math.max(0.5, parseFloat((optionLtp - spotGap * delta).toFixed(1)));

  try {
    const result = await zerodha.modifySLMOrder(_hardSLOrderId, newTrigger);
    if (result.success) {
      log(`🔄 [HARD SL] Modified trigger → ₹${newTrigger} (spotSL=₹${newSpotSL})`);
    } else {
      log(`⚠️ [HARD SL] Modify failed: ${JSON.stringify(result.raw)}`);
    }
  } catch (err) {
    log(`❌ [HARD SL] Modify exception: ${err.message}`);
  }
}

/**
 * Cancel the Hard SL-M order (called before bot-initiated market exit).
 */
async function cancelHardSL() {
  if (!_hardSLOrderId) return;
  const orderId = _hardSLOrderId;
  _hardSLOrderId = null;
  try {
    const result = await zerodha.cancelOrder(orderId);
    if (result.success) {
      log(`🗑️ [HARD SL] Cancelled SL-M order ${orderId}`);
    } else {
      log(`⚠️ [HARD SL] Cancel failed for ${orderId}: ${JSON.stringify(result.raw)}`);
    }
  } catch (err) {
    log(`❌ [HARD SL] Cancel exception: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Option metadata parser (same as paperTrade)
// ─────────────────────────────────────────────────────────────────────────────

function parseOptionDetails(symbol) {
  // Fyers supports two weekly option symbol formats:
  //
  // Format A (letter month code): NSE:NIFTY{YY}{M}{DD}{Strike}{CE|PE}
  //   M = 1-9 for Jan-Sep, O=Oct, N=Nov, D=Dec (Fyers numeric codes)
  //   e.g. NSE:NIFTY2631024550CE → YY=26, M=3(Mar), DD=10, strike=24550
  //
  // Format B (3-letter month, older): NSE:NIFTY{YY}{MON}{DD}{Strike}{CE|PE}
  //   e.g. NSE:NIFTY26MAR0624600CE → YY=26, MON=MAR, DD=06, strike=24600

  const MONTH_NAMES    = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  // Fyers numeric month codes: 1-9 for Jan-Sep, O=Oct, N=Nov, D=Dec
  const MONTH_CODE_MAP = { "1":0,"2":1,"3":2,"4":3,"5":4,"6":5,"7":6,"8":7,"9":8,"O":9,"N":10,"D":11 };

  try {
    // Format A: YY + single-char numeric month code + 2-digit day
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
        expiry:     `${dd} ${mon} 20${yy}`,
        expiryRaw:  `${yy}${mCode}${dd}`,
        strike,
        optionType: type,
      };
    }

    // Format C: YY + 3-letter month (MONTHLY — no day)
    // Must check FIRST — Format B would incorrectly eat 2 digits from strike
    const mC = symbol.match(/NSE:NIFTY(\d{2})([A-Z]{3})(\d+)(CE|PE)$/);
    if (mC) {
      const strike = parseInt(mC[3], 10);
      if (strike >= 10000) {
        return {
          expiry:     `${mC[2]} 20${mC[1]}`,
          expiryRaw:  `${mC[1]}${mC[2]}`,
          strike,
          optionType: mC[4],
        };
      }
    }

    // Format B: YY + 3-letter month + 2-digit day (weekly with month name)
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

// ─────────────────────────────────────────────────────────────────────────────
// Square off (LIVE — places real Zerodha order to close position)
// Options: always SELL to close. Futures: SELL to close LONG, BUY to close SHORT.
// ─────────────────────────────────────────────────────────────────────────────

async function squareOff(exitPrice, reason) {
  // Guard 1: prevent concurrent squareOff calls (multiple ticks firing SL simultaneously)
  if (_squareOffInFlight) {
    log(`⚠️ [LIVE] squareOff already in progress — ignoring duplicate call (${reason})`);
    return;
  }
  if (!tradeState.position) return;
  _squareOffInFlight = true;
  const closedSide = tradeState.position.side;

  const { symbol, qty, side, entryPrice, optionEntryLtp, entryTime,
          stopLoss, optionExpiry, optionStrike, optionType, spotAtEntry,
          optionCurrentLtp: posOptLtp } = tradeState.position;
  const INSTR = instrumentConfig.INSTRUMENT; // top-level constant
  const isFutures = INSTR === "NIFTY_FUTURES";

  // Exit order direction:
  // Options: always SELL(-1) — we sell back the CE or PE contract we bought
  // Futures LONG (CE): SELL(-1) to close long
  // Futures SHORT (PE): BUY(1) to close short
  const exitOrderSide = (isFutures && side === "PE") ? 1 : -1;
  const exitLabel = exitOrderSide === 1 ? "BUY (close short)" : "SELL (close long)";
  log(`🔄 [LIVE] Square off triggered: ${reason}`);

  // Cancel Hard SL-M order before placing market exit (prevents double-exit)
  await cancelHardSL();

  log(`📤 [LIVE] ${exitLabel} ${qty} × ${symbol} via Zerodha`);

  const result = await placeMarketOrder(symbol, exitOrderSide, qty);

  // Guard 2: if exit order FAILED or was a duplicate, keep position tracked
  if (!result.success) {
    if (result.reason === "duplicate_guard") {
      log(`⚠️ [LIVE] Exit order blocked (duplicate_guard) — position remains open`);
    } else {
      log(`🚨 [LIVE] EXIT ORDER FAILED — position kept open for retry | ${JSON.stringify(result.raw)}`);
      log(`🚨 [LIVE] CHECK ZERODHA DASHBOARD — manual square-off may be required!`);
    }
    _squareOffInFlight = false;
    return;
  }

  const exitOptionLtp = tradeState.optionLtp || posOptLtp || null;

  let pnl, pnlMode;

  if (isFutures) {
    // Futures: PnL = price difference × qty. CE=LONG (+1), PE=SHORT (-1)
    pnl     = parseFloat(((exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty).toFixed(2));
    pnlMode = `futures: entry ₹${entryPrice} → exit ₹${exitPrice} (${side === "CE" ? "LONG" : "SHORT"})`;
  } else if (optionEntryLtp && exitOptionLtp && optionEntryLtp > 0 && exitOptionLtp > 0) {
    pnl     = parseFloat(((exitOptionLtp - optionEntryLtp) * qty).toFixed(2));
    pnlMode = `option premium ₹${optionEntryLtp} → ₹${exitOptionLtp}`;
  } else {
    pnl     = parseFloat(((exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty).toFixed(2));
    pnlMode = "spot proxy (option LTP unavailable)";
  }

  const charges = getCharges({ isFutures, exitPremium: exitOptionLtp, entryPremium: optionEntryLtp, qty });
  const netPnl    = parseFloat((pnl - charges).toFixed(2));
  const emoji     = netPnl >= 0 ? "✅" : "❌";
  log(`${emoji} [LIVE] Exit: ${reason} | Option LTP: ₹${exitOptionLtp || "?"} | Gross PnL: ₹${pnl} | Net: ₹${netPnl} (after ₹${charges.toFixed(0)} charges)`);

  // ── Record trade in session log (mirrors paperTrade) ─────────────────────
  tradeState.sessionTrades.push({
    side,
    symbol,
    qty,
    entryPrice,
    exitPrice,
    spotAtEntry:    spotAtEntry || entryPrice,
    spotAtExit:     exitPrice,
    optionEntryLtp: optionEntryLtp || null,
    optionExitLtp:  exitOptionLtp  || null,
    entryTime,
    exitTime:       istNow(),
    pnl:            netPnl,
    pnlMode,
    exitReason:     reason,
    entryReason:    tradeState.position ? (tradeState.position.reason || "") : "",
    stopLoss:       stopLoss || null,
    optionExpiry:   optionExpiry   || null,
    optionStrike:   optionStrike   || null,
    optionType:     optionType     || side,
    orderId:        result.orderId || null,
    // Bar timestamps for chart markers
    entryBarTime:   tradeState.position ? (tradeState.position.entryBarTime || null) : null,
    exitBarTime:    tradeState.currentBar ? tradeState.currentBar.time : null,
  });
  tradeState.sessionPnl = parseFloat((tradeState.sessionPnl + netPnl).toFixed(2));
  if (netPnl > 0) tradeState._wins = (tradeState._wins || 0) + 1;
  else if (netPnl < 0) tradeState._losses = (tradeState._losses || 0) + 1;
  log(`💼 [LIVE] Session PnL so far: ₹${tradeState.sessionPnl}`);

  // ── Daily loss kill switch ────────────────────────────────────────────────────
  const MAX_DAILY_LOSS = _MAX_DAILY_LOSS;
  if (!tradeState._dailyLossHit && tradeState.sessionPnl <= -Math.abs(MAX_DAILY_LOSS)) {
    tradeState._dailyLossHit = true;
    log(`🛑 [LIVE] DAILY LOSS LIMIT HIT — session loss ₹${Math.abs(tradeState.sessionPnl)} >= ₹${MAX_DAILY_LOSS}. NO MORE ENTRIES TODAY.`);
  }
  // ── Consecutive loss circuit breaker (mirrors paperTrade v36) ────────────────
  if (netPnl < 0) {
    tradeState._consecutiveLosses = (tradeState._consecutiveLosses || 0) + 1;
    log(`📉 [LIVE] Consecutive losses: ${tradeState._consecutiveLosses}`);
    if (tradeState._consecutiveLosses >= 3) {
      if (TRADE_RES >= 15) {
        // 15-min: 3 losses = bad market day — latch daily kill, sit out
        tradeState._dailyLossHit = true;
        tradeState._consecutiveLosses = 0;
        log(`🛑 [LIVE] 3 consecutive losses on 15-min — NO MORE ENTRIES TODAY (daily kill latched)`);
      } else {
        const pauseMs = 4 * TRADE_RES * 60 * 1000; // 4 candles — mirrors paperTrade exactly
        tradeState._pauseUntilTime = Date.now() + pauseMs;
        const resumeTime = new Date(tradeState._pauseUntilTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        log(`⚠️ [LIVE] 3 consecutive losses — entries PAUSED for ${TRADE_RES * 4} min (resume ~${resumeTime})`);
        tradeState._consecutiveLosses = 0;
      }
    }
  } else {
    if (tradeState._consecutiveLosses > 0) {
      log(`✅ [LIVE] Consecutive loss streak reset (was ${tradeState._consecutiveLosses})`);
    }
    tradeState._consecutiveLosses = 0;
    tradeState._pauseUntilTime = null;
  }

  // ── Telegram notification ─────────────────────────────────────────────────
  notifyExit({
    mode:           "LIVE",
    side,
    symbol,
    strike:         optionStrike || null,
    expiry:         optionExpiry || null,
    spotAtEntry:    spotAtEntry  || entryPrice,
    spotAtExit:     exitPrice,
    optionEntryLtp: optionEntryLtp || null,
    optionExitLtp:  exitOptionLtp  || null,
    pnl:            netPnl,
    sessionPnl:     tradeState.sessionPnl,
    exitReason:     reason,
    entryTime,
    exitTime:       istNow(),
    qty,
  });

  stopOptionPolling();
  tradeState.optionLtp    = null;
  tradeState.optionLtpUpdatedAt = null;
  tradeState._ltpStaleLogged = false;
  tradeState.optionSymbol = null;
  tradeState.position     = null;
  clearTradePosition();  // remove persisted state — position is closed
  _hardSLOrderId = null; // clear Hard SL tracking (already cancelled before exit)
  _squareOffInFlight      = false; // release only AFTER position is cleared

  // ── 50%-rule exit pause (mirrors paperTrade) ──────────────────────────────
  // If exit was caused by 50% rule, pause re-entry for 2 candles to avoid
  // re-entering same choppy conditions immediately.
  if (false) { // 50% pause DISABLED
    const pauseCandles = 2;
    const pauseMs      = pauseCandles * TRADE_RES * 60 * 1000;
    tradeState._fiftyPctPauseUntil = Date.now() + pauseMs;
    const resumeTime = new Date(tradeState._fiftyPctPauseUntil).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    log(`⏸ [LIVE] 50%-rule exit — choppy market. Entry paused for ${pauseCandles} candles (~${pauseCandles * TRADE_RES} min, resume ~${resumeTime})`);
  }

  // Notify active strategy (optional callbacks for strategy-level state tracking)
  const activeStrat = getActiveStrategy();
  if (typeof activeStrat.onTradeClosed === "function") activeStrat.onTradeClosed();
  const isStopLoss = reason && (reason.toLowerCase().includes("sl hit") || reason.toLowerCase().includes("stop"));
  if (isStopLoss && closedSide && typeof activeStrat.onStopLossHit === "function") {
    activeStrat.onStopLossHit(closedSide);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Candle close logic
// ─────────────────────────────────────────────────────────────────────────────

async function onCandleClose(candle) {
  tradeState.candles.push(candle);
  tradeState.prevCandleHigh = candle.high;
  tradeState.prevCandleLow  = candle.low;
  tradeState.prevCandleMid  = parseFloat(((candle.high + candle.low) / 2).toFixed(2));
  if (tradeState.candles.length > 200) tradeState.candles.shift();

  const strategy = getActiveStrategy();
  const { signal, reason, stopLoss, signalStrength: _ccStrength } = strategy.getSignal(tradeState.candles);

  // Cache stable SAR SL for every intra-candle tick — avoids recomputing strategy on every tick
  _cachedClosedCandleSL = stopLoss ?? null;

  // ── Pre-fetch option symbols in background so entry is instant on next tick ──
  // Fire-and-forget: runs async while candle close logic continues synchronously.
  // Cached result used at entry if spot hasn't moved > 25 pts.
  if (!tradeState.position) prefetchOptionSymbols(candle.close).catch(() => {});

  // ── VIX filter: fetch latest VIX in background (updates cache for intra-tick checks) ──
  fetchLiveVix().catch(() => {});
  const _vixDisplay = vixFilter.VIX_ENABLED ? getCachedVix() : null;
  log(`📊 [LIVE] Candle @ ${candle.close} | Signal: ${signal} | VIX: ${!vixFilter.VIX_ENABLED ? "off" : _vixDisplay != null ? _vixDisplay.toFixed(1) : "n/a"} | ${reason}`);

  // Telegram: candle close signal update (only when flat — no position open)
  // Tells you exactly why a trade was/wasn't taken every 15 min candle
  if (!tradeState.position && signal !== null) {
    const _candleIST = new Date(candle.time * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
    notifySignal({
      mode: "LIVE",
      signal,
      reason: reason ? reason.slice(0, 200) : "—",
      spot: candle.close,
      time: _candleIST,
    });
  }

  // ── entryPrevMid is FIXED at entry time — never update it here ──────────────
  // Set once at position creation = mid of the last fully closed candle at entry.
  // The 50% rule reference must not roll forward as new candles close.

  // ── Increment candles-held + time-stop check (flat trade = theta bleed) ───
  if (tradeState.position) {
    tradeState.position.candlesHeld = (tradeState.position.candlesHeld || 0) + 1;
    const _pos = tradeState.position;
    const _entryOpt = _pos.optionEntryLtp;
    const _curOpt   = tradeState.optionLtp || _pos.optionCurrentLtp;
    let _pnlPts = null;
    if (_entryOpt && _curOpt) {
      _pnlPts = _curOpt - _entryOpt;
    } else if (_pos.spotAtEntry) {
      _pnlPts = (candle.close - _pos.spotAtEntry) * (_pos.side === "CE" ? 1 : -1);
    }
    const _tsReason = tradeGuards.checkTimeStop(_pos.candlesHeld, _pnlPts);
    if (_tsReason) {
      log(`⏳ [LIVE] ${_tsReason}`);
      await squareOff(candle.close, _tsReason);
      return;
    }
  }

  // ── Trailing SAR SL update (only tighten, never widen) ─────────────────────
  if (tradeState.position && stopLoss != null) {
    const pos     = tradeState.position;
    const oldSL   = pos.stopLoss;
    const tighten = pos.side === "CE"
      ? (oldSL === null || stopLoss > oldSL)
      : (oldSL === null || stopLoss < oldSL);
    if (tighten && oldSL !== stopLoss) {
      pos.stopLoss = stopLoss;
      const _optSAR = tradeState.optionLtp ? ` | opt=₹${tradeState.optionLtp}` : "";
      log(`🔄 [LIVE] SAR trail: ₹${oldSL} → ₹${stopLoss} (${pos.side === "CE" ? "↑" : "↓"} tightened)${_optSAR}`);
    }
  }

  // 50% candle-close exit REMOVED — replaced by breakeven stop at +25pt

  // ── Exit Rule 2: candle-close SL breach ────────────────────────────────────
  if (tradeState.position && tradeState.position.stopLoss != null) {
    const sl = tradeState.position.stopLoss;
    if (tradeState.position.side === "CE" && candle.close < sl) {
      const _optSlCe = tradeState.optionLtp ? ` | opt=₹${tradeState.optionLtp}` : "";
      log(`🚨 [LIVE] SL hit on candle close — spot ₹${candle.close} < SL ₹${sl}${_optSlCe}`);
      await squareOff(candle.close, `SL hit @ ₹${sl}`);
      return;
    }
    if (tradeState.position.side === "PE" && candle.close > sl) {
      const _optSlPe = tradeState.optionLtp ? ` | opt=₹${tradeState.optionLtp}` : "";
      log(`🚨 [LIVE] SL hit on candle close — spot ₹${candle.close} > SL ₹${sl}${_optSlPe}`);
      await squareOff(candle.close, `SL hit @ ₹${sl}`);
      return;
    }
  }

  // ── Exit Rule 3: opposite signal ────────────────────────────────────────────
  if (tradeState.position) {
    const oppSignal = tradeState.position.side === "CE" ? "BUY_PE" : "BUY_CE";
    if (signal === oppSignal) {
      await squareOff(candle.close, "Opposite signal exit");
      // fall through — position now null, may enter below
    }
  }

  // ── Exit Rule 4: EOD square-off + auto-stop at TRADE_STOP_TIME ─────────────
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const _eodStopMins  = _STOP_MINS /* cached */;
  const _eodStopLabel = String(Math.floor(_eodStopMins/60)).padStart(2,"0") + ":" + String(_eodStopMins%60).padStart(2,"0");
  if (ist.getHours() * 60 + ist.getMinutes() >= _eodStopMins) {
    if (tradeState.position) {
      log("⏰ [LIVE] EOD " + _eodStopLabel + " — auto square off");
      await squareOff(candle.close, "EOD square-off " + _eodStopLabel);
    }
    // Auto-stop — no more trading after TRADE_STOP_TIME
    if (tradeState.running) {
      log("⏰ [LIVE] Market closed (" + _eodStopLabel + " IST) — auto-stopping live trade engine.");
      tradeState.running = false;
      saveLiveSession();
      sharedSocketState.clear();
      stopOptionPolling();
      // Only stop socket if no scalp mode is piggybacking
      if (!sharedSocketState.isScalpActive()) {
        socketManager.stop();
      } else {
        log("📡 [LIVE] Socket kept alive — scalp mode still active");
      }
    }
    return;
  }

  // ── Entry: candle-close fallback (if intra-candle tick entry didn't fire) ───
  // isMarketHours() guard prevents entries on 5-min candles closing between TRADE_STOP_TIME-10
  // and TRADE_STOP_TIME (e.g. a 3:20 PM candle-close with TRADE_STOP_TIME=15:30).
  if (!tradeState.position && !tradeState._entryPending && !tradeState._expiryDayBlocked && isMarketHours() && (signal === "BUY_CE" || signal === "BUY_PE")) {
    // Daily loss kill switch — hard block, no bypass
    if (tradeState._dailyLossHit) {
      log(`🛑 [LIVE] Daily loss limit active — entry blocked (${signal})`);
      return;
    }
    // ── VIX filter: block entry in high-volatility regimes ──────────────────
    const _vixCheck = await checkLiveVix(_ccStrength || "MARGINAL");
    if (!_vixCheck.allowed) {
      log(`🌡️ [LIVE] VIX BLOCK — ${_vixCheck.reason} | Signal: ${signal}`);
      return;
    }
    const side = signal === "BUY_CE" ? "CE" : "PE";
    const INSTR = instrumentConfig.INSTRUMENT; // top-level constant

    // ── 50% entry gate REMOVED — breakeven stop handles protection ──────────
    // Previously blocked entry when spot was on wrong side of prev candle mid.
    // Now: breakeven at +25pt handles this — let the entry through.

    tradeState._entryPending = true;
    const _ltEntryTimer = setTimeout(() => { if (tradeState._entryPending) tradeState._entryPending = false; }, 4000);

    try {
      let symbol, expiry, strike, invalid;

      if (INSTR === "NIFTY_FUTURES") {
        // Futures: symbol doesn't depend on CE/PE — one contract, two directions
        symbol  = await getSymbol(side);
        expiry  = null;
        strike  = null;
        invalid = false;
        log(`🎯 [LIVE] ENTRY ${side === "CE" ? "LONG" : "SHORT"} FUTURES @ ₹${candle.close} | ${reason}`);
        log(`📌 Futures symbol: ${symbol}`);
      } else {
        // Options: use pre-fetched symbol if available, else live lookup
        const cachedCs = getCachedSymbol(side, candle.close);
        if (cachedCs) {
          ({ symbol, expiry, strike, invalid } = cachedCs);
          log(`⚡ [LIVE] Using pre-fetched symbol (candle-close): ${symbol}`);
        } else {
          ({ symbol, expiry, strike, invalid } = await validateAndGetOptionSymbol(candle.close, side));
        }
        const atmStrike   = Math.round(candle.close / 50) * 50;
        const strikeLabel = strike === atmStrike ? "ATM" : "ITM";
        log(`🎯 [LIVE] ENTRY ${side} @ ₹${candle.close} | ${reason}`);
        log(`📌 ${strikeLabel} Option: ${symbol} (Spot: ${candle.close} → Strike: ${strike} | Expiry: ${expiry})`);
      }

      if (tradeState.position) { tradeState._entryPending = false; return; }

      if (invalid) {
        log(`❌ [LIVE] Cannot enter — symbol ${symbol} invalid on Fyers (next week not live yet). Skipping.`);
        tradeState._entryPending = false;
        return;
      }

      // Place real order via Zerodha FIRST
      // Options: always BUY (we buy the CE or PE contract)
      // Futures: CE=LONG=BUY(1), PE=SHORT=SELL(-1)
      const orderSide = (INSTR === "NIFTY_FUTURES" && side === "PE") ? -1 : 1;

      // ── Bid-ask spread guard before REAL money order (options only) ──
      if (INSTR !== "NIFTY_FUTURES") {
        const _q = await tradeGuards.fetchOptionQuote(fyers, symbol);
        const _sp = tradeGuards.checkSpread(_q && _q.bid, _q && _q.ask);
        if (!_sp.ok) {
          log(`⏭️ [LIVE] SKIP entry — spread too wide (${_sp.reason})`);
          tradeState._entryPending = false;
          clearTimeout(_ltEntryTimer);
          return;
        }
      }

      const result = await placeMarketOrder(symbol, orderSide, getLotQty());

      if (!result.success) {
        if (result.reason !== "duplicate_guard") {
          log(`❌ [LIVE] Entry order failed — not tracking position to avoid phantom trade`);
        } else {
          log(`⚠️ [LIVE] Entry blocked — order in flight (duplicate_guard). No position created.`);
        }
        tradeState._entryPending = false;
        clearTimeout(_ltEntryTimer);
        return;
      }

      // Guard: a tick may have already entered while Zerodha order was in-flight
      if (tradeState.position) {
        log(`⚠️ [LIVE] Position already set while candle-close order was in-flight — ignoring duplicate`);
        tradeState._entryPending = false;
        clearTimeout(_ltEntryTimer);
        return;
      }

      const optDetails = parseOptionDetails(symbol);
      // Relaxed from 50% mid to 35%/65% — matches backtest and paper trade.
      // CE: 35% from low. PE: 65% from low. Gives ~40% more room.
      const _ccLastCandle = tradeState.candles.length >= 1 ? tradeState.candles[tradeState.candles.length - 1] : null;
      const entryPrevMid = _ccLastCandle
        ? parseFloat((_ccLastCandle.low + (_ccLastCandle.high - _ccLastCandle.low) * (side === "CE" ? 0.35 : 0.65)).toFixed(2))
        : null;

      // Dynamic trail activation: 25% of initial SAR gap, floored at TRAIL_ACTIVATE_PTS, capped at 40pts.
      // Without cap: a 546pt SAR gap gives 137pt activation — trail never fires in practice.
      // Cap at 40pt ensures trail always activates within a reasonable profit move.
      const _initialSARgap = stopLoss ? Math.abs(candle.close - stopLoss) : 0;
      const _dynTrailActivate = Math.min(40, Math.max(_TRAIL_ACTIVATE_PTS, Math.round(_initialSARgap * 0.25)));

      tradeState.position = {
        side,
        symbol,
        qty:               getLotQty(),
        entryPrice:        candle.close,
        spotAtEntry:       candle.close,
        entryTime:         istNow(),
        reason,
        stopLoss:          stopLoss || null,
        initialStopLoss:   stopLoss || null,
        trailActivatePts:  _dynTrailActivate,
        bestPrice:         null,
        candlesHeld:       0,
        orderId:           result.orderId || null,
        entryBarTime:      tradeState.currentBar ? tradeState.currentBar.time : null,
        entryPrevMid,
        // Option metadata (null for futures)
        optionExpiry:      optDetails?.expiry     || expiry || null,
        optionStrike:      optDetails?.strike     || strike || null,
        optionType:        optDetails?.optionType || side,
        // Option premium tracking
        optionEntryLtp:    null,
        optionCurrentLtp:  null,
        optionEntryLtpTime: null,
      };

      tradeState.optionSymbol = symbol;
      tradeState._entryPending = false; // release guard only after position is fully set
      clearTimeout(_ltEntryTimer);
      if (INSTR !== "NIFTY_FUTURES") {
        log(`📊 [LIVE] Starting LTP polling (REST/3s): ${symbol}`);
        startOptionPolling(symbol);
      } else {
        log(`📊 [LIVE] Futures mode — skipping option LTP polling`);
      }
      const entryLabel = INSTR === "NIFTY_FUTURES"
        ? `${side === "CE" ? "LONG" : "SHORT"} ${getLotQty()} × ${symbol}`
        : `BUY ${getLotQty()} × ${symbol}`;
      log(`📝 [LIVE] ${entryLabel} @ SPOT ₹${candle.close} | SL: ₹${stopLoss} | TrailActivate: +${_dynTrailActivate}pt | Opt: capturing… | OrderID: ${result.orderId || "?"}`);
      // ── Telegram notification ───────────────────────────────────────────────
      notifyEntry({
        mode:           "LIVE",
        side,
        symbol,
        strike:         tradeState.position.optionStrike,
        expiry:         tradeState.position.optionExpiry,
        spotAtEntry:    candle.close,
        optionEntryLtp: null,  // captured async by polling
        stopLoss:       stopLoss || null,
        qty:            getLotQty(),
        reason,
      });
      // Persist position to disk for crash recovery
      saveTradePosition(tradeState.position, { sessionPnl: tradeState.sessionPnl || 0 });
    } catch (err) {
      log(`❌ [LIVE] Entry error: ${err.message}`);
      tradeState._entryPending = false;
      clearTimeout(_ltEntryTimer);
    }
  }
}

// ── Dynamic trail gap — mirrors paperTrade exactly ───────────────────────────
// Uses module-level cached constants (parsed once at startup) instead of
// reading process.env on every tick — eliminates 750+ env reads/min.
function getDynamicTrailGap(moveInFavour) {
  if (moveInFavour < _TRAIL_T1_UPTO) return _TRAIL_T1_GAP;
  if (moveInFavour < _TRAIL_T2_UPTO) return _TRAIL_T2_GAP;
  return _TRAIL_T3_GAP;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick handler — NIFTY spot ticks ONLY
// ─────────────────────────────────────────────────────────────────────────────

function onSpotTick(tick) {
  if (!tick || !tick.ltp) return;
  try {

  tradeState.tickCount++;
  tradeState.lastTickPrice = tick.ltp;

  const now         = Date.now();
  const bucketStart = get5MinBucketStart(now);

  if (!tradeState.currentBar || tradeState.barStartTime !== bucketStart) {
    if (tradeState.currentBar) onCandleClose(tradeState.currentBar).catch(console.error);
    // New candle — clear the SL-hit block and intra-candle entry throttle
    tradeState._slHitCandleTime    = null;
    tradeState._lastCheckedBarHigh = null;
    tradeState._lastCheckedBarLow  = null;
    tradeState._missedLoggedCandle = null;
    tradeState.currentBar   = {
      time:   Math.floor(bucketStart / 1000),
      open:   tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp,
      volume: tick.vol_traded_today || 0,
    };
    tradeState.barStartTime = bucketStart;
  } else {
    const bar  = tradeState.currentBar;
    bar.high   = Math.max(bar.high, tick.ltp);
    bar.low    = Math.min(bar.low,  tick.ltp);
    bar.close  = tick.ltp;
    bar.volume = tick.vol_traded_today || bar.volume;
  }

  const ltp = tick.ltp;
  const bar = tradeState.currentBar;

  // ── ENTRY: Intra-candle STRONG signal entry (5-min and 15-min) ──────────────
  // 5-min:  fires on every tick (all signals)
  // 15-min: fires only when bar high/low changes AND signal is STRONG
  //         (mirrors paperTrade — prevents premature entries on partial candle data)
  // SAFETY: 15-min requires _cachedClosedCandleSL (at least 1 closed candle)
  const barHighChanged = bar && bar.high !== tradeState._lastCheckedBarHigh;
  const barLowChanged  = bar && bar.low  !== tradeState._lastCheckedBarLow;
  const shouldCheckSignal = TRADE_RES === 5 || barHighChanged || barLowChanged;

  if (!tradeState.position && bar && tradeState.candles.length >= 30
      && !tradeState._entryPending && shouldCheckSignal
      && (TRADE_RES === 5 || _cachedClosedCandleSL !== null)) {

    // Update throttle — record the high/low we're about to evaluate against
    if (TRADE_RES !== 5) {
      tradeState._lastCheckedBarHigh = bar.high;
      tradeState._lastCheckedBarLow  = bar.low;
    }

    // Block re-entry on the same candle where an SL/50% exit just occurred
    const _currentBarTime = tradeState.currentBar ? tradeState.currentBar.time : null;
    if (tradeState._slHitCandleTime !== null && tradeState._slHitCandleTime === _currentBarTime) {
      // silently skip — no re-entry allowed this candle (SL hit guard)
    } else if (tradeState._dailyLossHit) {
      // Daily loss kill switch latched — no more entries today (silent to avoid log spam)
    } else if (tradeState._pauseUntilTime && Date.now() < tradeState._pauseUntilTime) {
      // Consecutive loss pause active — silently skip to avoid log spam
    } else if (false) { // 50% pause DISABLED
      // 50%-rule pause active — silently skip to avoid log spam
    } else if (tradeState.sessionTrades.length >= _MAX_DAILY_TRADES) {
      // Daily max trades cap reached
      if (!tradeState._maxTradesLoggedCandle || tradeState._maxTradesLoggedCandle !== _currentBarTime) {
        log(`🚫 [LIVE] Daily max trades (${_MAX_DAILY_TRADES}) reached — no more entries today`);
        tradeState._maxTradesLoggedCandle = _currentBarTime;
      }
    } else if (!isMarketHours()) {
      // Outside market hours — security block
    } else {
    const strategy = getActiveStrategy();
    tradeState.candles.push(bar);
    const { signal, reason, signalStrength, stopLoss: strategySL } = strategy.getSignal(tradeState.candles, { silent: true });
    tradeState.candles.pop();
    const stopLoss = strategySL || _cachedClosedCandleSL;

    // 15-min: STRONG signals only (steep slope + committed RSI) → enter intra-candle at EMA touch
    // 5-min:  all signals enter intra-candle
    const isStrongSignal = signalStrength === "STRONG";

    // ── Signal Missed Log ────────────────────────────────────────────────────
    // If strategy fires a valid signal but it can't enter (wrong strength for 15-min,
    // or signal is NONE), log it once per candle so you can see what was skipped.
    if ((signal === "BUY_CE" || signal === "BUY_PE") && TRADE_RES >= 15 && !isStrongSignal) {
      if (!tradeState._missedLoggedCandle || tradeState._missedLoggedCandle !== _currentBarTime) {
        tradeState._missedLoggedCandle = _currentBarTime;
        log(`⚠️ [LIVE] Signal MISSED — ${signal} [MARGINAL] @ ₹${ltp} — waiting for candle close | ${reason}`);
      }
    }

    if ((signal === "BUY_CE" || signal === "BUY_PE") && (TRADE_RES === 5 || isStrongSignal)) {
      // ── VIX filter: use cached VIX (updated at candle close) to avoid async in tick handler ──
      const _vixIntraVal = getCachedVix();
      const _vixIntraBlocked = vixFilter.VIX_ENABLED && _vixIntraVal != null && (
        _vixIntraVal > vixFilter.VIX_MAX_ENTRY ||
        (_vixIntraVal > vixFilter.VIX_STRONG_ONLY && signalStrength !== "STRONG")
      );
      if (_vixIntraBlocked) {
        if (!tradeState._vixBlockLoggedCandle || tradeState._vixBlockLoggedCandle !== _currentBarTime) {
          tradeState._vixBlockLoggedCandle = _currentBarTime;
          log(`🌡️ [LIVE] VIX BLOCK (intra) — VIX ${_vixIntraVal.toFixed(1)} too high | Signal: ${signal} [${signalStrength}]`);
        }
      } else {
      const side = signal === "BUY_CE" ? "CE" : "PE";

      // ── 50% entry gate REMOVED — breakeven stop handles protection ──────────
      tradeState._entryPending = true;
      const _ltIntraTimer = setTimeout(() => { if (tradeState._entryPending) tradeState._entryPending = false; }, 4000);
      log(`⚡ [LIVE] Intra-candle ${TRADE_RES >= 15 ? "STRONG" : ""} entry @ ₹${ltp} | VIX: ${_vixIntraVal != null ? _vixIntraVal.toFixed(1) : "n/a"} | [${TRADE_RES}m bar] ${reason}`);

      const INSTR = instrumentConfig.INSTRUMENT;

      let symbolPromise;
      if (INSTR === "NIFTY_FUTURES") {
        symbolPromise = getSymbol(side).then(sym => ({ symbol: sym, expiry: null, strike: null, invalid: false }));
      } else {
        const cached = getCachedSymbol(side, ltp);
        if (cached) {
          log(`⚡ [LIVE] Using pre-fetched symbol: ${cached.symbol} (spot delta: ${Math.abs(cached.spot - ltp).toFixed(0)} pts)`);
          symbolPromise = Promise.resolve(cached);
        } else {
          log(`🔍 [LIVE] Cache miss — live symbol lookup (spot moved or first trade of session)`);
          symbolPromise = validateAndGetOptionSymbol(ltp, side);
        }
      }

      symbolPromise.then(async ({ symbol, expiry, strike, invalid }) => {
        if (tradeState.position) { tradeState._entryPending = false; return; }

        if (INSTR === "NIFTY_FUTURES") {
          log(`🎯 [LIVE] ENTRY ${side === "CE" ? "LONG" : "SHORT"} FUTURES @ ₹${ltp} | ${reason}`);
          log(`📌 Futures symbol: ${symbol}`);
        } else {
          const atmStrike   = Math.round(ltp / 50) * 50;
          const strikeLabel = strike && Math.abs(strike - atmStrike) === 0 ? "ATM" : "ITM";
          log(`🎯 [LIVE] ENTRY ${side} @ ₹${ltp} | ${reason}`);
          log(`📌 ${strikeLabel} Option: ${symbol} (Spot: ${ltp} → Strike: ${strike} | Expiry: ${expiry})`);
        }

        if (invalid) {
          log(`❌ [LIVE] Cannot enter — symbol ${symbol} invalid on Fyers. Skipping.`);
          tradeState._entryPending = false;
          clearTimeout(_ltIntraTimer);
          return;
        }

        if (!isMarketHours()) {
          log(`🚫 [LIVE] Security block — market hours ended. Aborting intra-tick entry.`);
          tradeState._entryPending = false;
          clearTimeout(_ltIntraTimer);
          return;
        }

        const orderSide = (INSTR === "NIFTY_FUTURES" && side === "PE") ? -1 : 1;

        // ── Bid-ask spread guard before REAL money order (options only) ──
        if (INSTR !== "NIFTY_FUTURES") {
          const _q = await tradeGuards.fetchOptionQuote(fyers, symbol);
          const _sp = tradeGuards.checkSpread(_q && _q.bid, _q && _q.ask);
          if (!_sp.ok) {
            log(`⏭️ [LIVE] SKIP intra-tick entry — spread too wide (${_sp.reason})`);
            tradeState._entryPending = false;
            clearTimeout(_ltIntraTimer);
            return;
          }
        }

        const result = await placeMarketOrder(symbol, orderSide, getLotQty());

        if (!result.success) {
          if (result.reason !== "duplicate_guard") {
            log(`❌ [LIVE] Intra-tick entry order failed — skipping.`);
          } else {
            log(`⚠️ [LIVE] Intra-tick entry blocked — order in flight (duplicate_guard). No position created.`);
          }
          tradeState._entryPending = false;
          clearTimeout(_ltIntraTimer);
          return;
        }

        if (tradeState.position) {
          log(`⚠️ [LIVE] Position already set while intra-tick order was in-flight — ignoring duplicate`);
          tradeState._entryPending = false;
          clearTimeout(_ltIntraTimer);
          return;
        }

        const optDetails   = parseOptionDetails(symbol);
        // Relaxed from 50% mid to 35%/65% — matches backtest and paper trade.
        const _intraLastCandle = tradeState.candles.length >= 1 ? tradeState.candles[tradeState.candles.length - 1] : null;
        const entryPrevMid = _intraLastCandle
          ? parseFloat((_intraLastCandle.low + (_intraLastCandle.high - _intraLastCandle.low) * (side === "CE" ? 0.35 : 0.65)).toFixed(2))
          : null;

        // Dynamic trail activation: 25% of initial SAR gap, floored at TRAIL_ACTIVATE_PTS, capped at 40pts.
        const _initialSARgapIntra = stopLoss ? Math.abs(ltp - stopLoss) : 0;
        const _dynTrailActivateIntra = Math.min(40, Math.max(_TRAIL_ACTIVATE_PTS, Math.round(_initialSARgapIntra * 0.25)));

        tradeState.position = {
          side,
          symbol,
          qty:               getLotQty(),
          entryPrice:        ltp,
          spotAtEntry:       ltp,
          entryTime:         istNow(),
          reason,
          stopLoss:          stopLoss || null,
          initialStopLoss:   stopLoss || null,
          trailActivatePts:  _dynTrailActivateIntra,
          bestPrice:         null,
          candlesHeld:       0,
          orderId:           result.orderId || null,
          entryBarTime:      tradeState.currentBar ? tradeState.currentBar.time : null,
          entryPrevMid,
          optionExpiry:      optDetails?.expiry     || expiry || null,
          optionStrike:      optDetails?.strike     || strike || null,
          optionType:        optDetails?.optionType || side,
          optionEntryLtp:    null,
          optionCurrentLtp:  null,
          optionEntryLtpTime: null,
        };

        tradeState.optionSymbol = symbol;
        tradeState._entryPending = false;
        clearTimeout(_ltIntraTimer);
        if (INSTR !== "NIFTY_FUTURES") {
          log(`📊 [LIVE] Starting LTP polling (REST/3s): ${symbol}`);
          startOptionPolling(symbol);
        } else {
          log(`📊 [LIVE] Futures mode — skipping option LTP polling`);
        }
        const entryLabel2 = INSTR === "NIFTY_FUTURES"
          ? `${side === "CE" ? "LONG" : "SHORT"} ${getLotQty()} × ${symbol}`
          : `BUY ${getLotQty()} × ${symbol}`;
        log(`📝 [LIVE] ${entryLabel2} @ SPOT ₹${ltp} | SL: ₹${stopLoss} | TrailActivate: +${_dynTrailActivateIntra}pt | Opt: capturing… | OrderID: ${result.orderId || "?"}`);
        notifyEntry({
          mode:           "LIVE",
          side,
          symbol,
          strike:         tradeState.position.optionStrike,
          expiry:         tradeState.position.optionExpiry,
          spotAtEntry:    ltp,
          optionEntryLtp: null,
          stopLoss:       stopLoss || null,
          qty:            getLotQty(),
          reason,
        });
        // Persist position to disk for crash recovery
        saveTradePosition(tradeState.position, { sessionPnl: tradeState.sessionPnl || 0 });
      }).catch(err => {
        log(`❌ [LIVE] Intra-tick symbol lookup error: ${err.message}`);
        tradeState._entryPending = false;
        clearTimeout(_ltIntraTimer);
      });
      } // end VIX else
    }
    } // end entry guards
  }

  // Intra-tick 50% rule REMOVED — replaced by breakeven stop at +25pt.
  // The breakeven stop (added above) provides better protection without killing valid trades.

  // ── EXIT: Trailing SAR stoploss on every tick ─────────────────────────────
  // Dynamic tiered trail: gap tightens as profit grows (mirrors paperTrade).
  // ── BREAKEVEN STOP (replaces 50% rule) ─────────────────────────────────
  if (tradeState.position && tradeState.position.stopLoss !== null) {
    const _bePos = tradeState.position;
    const _bePts = parseFloat(process.env.BREAKEVEN_PTS || "25");
    if (_bePos.side === "CE") {
      const _beMove = (_bePos.bestPrice || ltp) - _bePos.spotAtEntry;
      if (_beMove >= _bePts && _bePos.stopLoss < _bePos.spotAtEntry) {
        log(`✅ [LIVE] BREAKEVEN CE: +${_beMove.toFixed(0)}pt >= ${_bePts}pt → SL moved to entry ₹${_bePos.spotAtEntry}`);
        _bePos.stopLoss = _bePos.spotAtEntry;
        saveTradePosition(_bePos, { sessionPnl: tradeState.sessionPnl || 0 });
        updateHardSL(_bePos.spotAtEntry);
      }
    } else {
      const _beMove = _bePos.spotAtEntry - (_bePos.bestPrice || ltp);
      if (_beMove >= _bePts && _bePos.stopLoss > _bePos.spotAtEntry) {
        log(`✅ [LIVE] BREAKEVEN PE: +${_beMove.toFixed(0)}pt >= ${_bePts}pt → SL moved to entry ₹${_bePos.spotAtEntry}`);
        _bePos.stopLoss = _bePos.spotAtEntry;
        saveTradePosition(_bePos, { sessionPnl: tradeState.sessionPnl || 0 });
        updateHardSL(_bePos.spotAtEntry);
      }
    }
  }

  // PE: exit when ltp >= stopLoss | CE: exit when ltp <= stopLoss
  if (tradeState.position && tradeState.position.stopLoss !== null) {
    const pos = tradeState.position;

    const TRAIL_ACTIVATE = pos.trailActivatePts || _TRAIL_ACTIVATE_PTS;

    if (pos.side === "CE") {
      const prevBestCE = pos.bestPrice;
      if (!pos.bestPrice || ltp > pos.bestPrice) pos.bestPrice = ltp;
      const moveInFavour = pos.bestPrice - pos.spotAtEntry;
      if (moveInFavour >= TRAIL_ACTIVATE) {
        const dynamicGap       = getDynamicTrailGap(moveInFavour);
        const trailSL          = parseFloat((pos.bestPrice - dynamicGap).toFixed(2));
        // 50% floor REMOVED — breakeven handles protection
        const effectiveTrailSL = trailSL;
        if (effectiveTrailSL > pos.stopLoss) {
          const _optTrCE = tradeState.optionLtp ? ` | opt=₹${tradeState.optionLtp}` : "";
          log(`📈 [LIVE] Trail CE [T${moveInFavour<_TRAIL_T1_UPTO?1:moveInFavour<_TRAIL_T2_UPTO?2:3} gap=${dynamicGap}pt]: best=₹${pos.bestPrice} (+${moveInFavour.toFixed(0)}pt) → SL ₹${pos.stopLoss} → ₹${effectiveTrailSL}${_optTrCE}`);
          pos.stopLoss = effectiveTrailSL;
          saveTradePosition(pos, { sessionPnl: tradeState.sessionPnl || 0 });
          updateHardSL(effectiveTrailSL);
        }
      } else if (pos.bestPrice !== prevBestCE) {
        const _curBarTime = tradeState.currentBar ? tradeState.currentBar.time : 0;
        if (!pos._trailWaitLoggedAt || pos._trailWaitLoggedAt !== _curBarTime) {
          pos._trailWaitLoggedAt = _curBarTime;
          const needed    = parseFloat((TRAIL_ACTIVATE - moveInFavour).toFixed(1));
          const _optWtCE  = tradeState.optionLtp ? ` | opt=₹${tradeState.optionLtp}` : "";
          log(`⏳ [LIVE] Trail CE waiting: best=₹${pos.bestPrice} (+${moveInFavour.toFixed(0)}pt) | need +${needed}pt more to activate (threshold=${TRAIL_ACTIVATE}pt)${_optWtCE}`);
        }
      }
      if (ltp <= pos.stopLoss) {
        const gaveBack = parseFloat((pos.bestPrice - ltp).toFixed(1));
        const peakGain = parseFloat((pos.bestPrice - pos.spotAtEntry).toFixed(1));
        const _optSlT  = tradeState.optionLtp ? ` | opt=₹${tradeState.optionLtp}` : "";
        log(`🛑 [LIVE] SL HIT CE — spot ₹${ltp} <= SL ₹${pos.stopLoss} | peak=₹${pos.bestPrice} (+${peakGain}pt) gave back ${gaveBack}pt${_optSlT}`);
        // Only block re-entry if initial SL was hit before trail activated (pure loss).
        // A trailing SL exit = profit captured → allow fresh signal on same candle.
        const wasTrailing = pos.bestPrice && (pos.bestPrice - pos.spotAtEntry) >= TRAIL_ACTIVATE;
        if (!wasTrailing) tradeState._slHitCandleTime = tradeState.currentBar ? tradeState.currentBar.time : null;
        squareOff(pos.stopLoss, `SL hit @ ₹${pos.stopLoss}`).catch(console.error);
        return;
      }
    } else {
      const prevBestPE = pos.bestPrice;
      if (!pos.bestPrice || ltp < pos.bestPrice) pos.bestPrice = ltp;
      const moveInFavour = pos.spotAtEntry - pos.bestPrice;
      if (moveInFavour >= TRAIL_ACTIVATE) {
        const dynamicGap       = getDynamicTrailGap(moveInFavour);
        const trailSL          = parseFloat((pos.bestPrice + dynamicGap).toFixed(2));
        // 50% ceiling REMOVED — breakeven handles protection
        const effectiveTrailSL = trailSL;
        if (effectiveTrailSL < pos.stopLoss) {
          const _optTrPE = tradeState.optionLtp ? ` | opt=₹${tradeState.optionLtp}` : "";
          log(`📉 [LIVE] Trail PE [T${moveInFavour<_TRAIL_T1_UPTO?1:moveInFavour<_TRAIL_T2_UPTO?2:3} gap=${dynamicGap}pt]: best=₹${pos.bestPrice} (+${moveInFavour.toFixed(0)}pt) → SL ₹${pos.stopLoss} → ₹${effectiveTrailSL}${_optTrPE}`);
          pos.stopLoss = effectiveTrailSL;
          saveTradePosition(pos, { sessionPnl: tradeState.sessionPnl || 0 });
          updateHardSL(effectiveTrailSL);
        }
      } else if (pos.bestPrice !== prevBestPE) {
        const _curBarTime = tradeState.currentBar ? tradeState.currentBar.time : 0;
        if (!pos._trailWaitLoggedAt || pos._trailWaitLoggedAt !== _curBarTime) {
          pos._trailWaitLoggedAt = _curBarTime;
          const needed    = parseFloat((TRAIL_ACTIVATE - moveInFavour).toFixed(1));
          const _optWtPE  = tradeState.optionLtp ? ` | opt=₹${tradeState.optionLtp}` : "";
          log(`⏳ [LIVE] Trail PE waiting: best=₹${pos.bestPrice} (+${moveInFavour.toFixed(0)}pt) | need +${needed}pt more to activate (threshold=${TRAIL_ACTIVATE}pt)${_optWtPE}`);
        }
      }
      if (ltp >= pos.stopLoss) {
        const gaveBack = parseFloat((ltp - pos.bestPrice).toFixed(1));
        const peakGain = parseFloat((pos.spotAtEntry - pos.bestPrice).toFixed(1));
        const _optSlTP = tradeState.optionLtp ? ` | opt=₹${tradeState.optionLtp}` : "";
        log(`🛑 [LIVE] SL HIT PE — spot ₹${ltp} >= SL ₹${pos.stopLoss} | peak=₹${pos.bestPrice} (+${peakGain}pt) gave back ${gaveBack}pt${_optSlTP}`);
        // Only block re-entry if initial SL was hit before trail activated (pure loss).
        const wasTrailing = pos.bestPrice && (pos.spotAtEntry - pos.bestPrice) >= TRAIL_ACTIVATE;
        if (!wasTrailing) tradeState._slHitCandleTime = tradeState.currentBar ? tradeState.currentBar.time : null;
        squareOff(pos.stopLoss, `SL hit @ ₹${pos.stopLoss}`).catch(console.error);
        return;
      }
    }
  }

  } catch (err) {
    // Catch-all: prevent a single bad tick/NaN from crashing the entire Node process
    console.error(`🚨 [LIVE] onSpotTick crash caught: ${err.message}`, err.stack);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

router.get("/start", async (req, res) => {
  if (!process.env.ACCESS_TOKEN)          return res.status(401).json({ success: false, error: "Fyers not authenticated. Visit /auth/login first." });
  if (!zerodha.isAuthenticated())         return res.status(401).json({ success: false, error: "Zerodha not authenticated. Visit /auth/zerodha/login first." });
  if (process.env.SWING_LIVE_ENABLED !== "true") return res.status(403).json({ success: false, error: "Live trading disabled. Set SWING_LIVE_ENABLED=true in .env." });
  if (tradeState.running)                 return res.status(400).json({ success: false, error: "Trading already running." });
  if (sharedSocketState.isActive())       return res.status(400).json({ success: false, error: "Paper Trading is active. Stop it first at /swing-paper/stop" });
  
  // ── NEW: Trading session validation (holidays + time check) ────────────────
  const tradingCheck = await isTradingAllowed();
  if (!tradingCheck.allowed) {
    return res.status(400).json({
      success: false,
      error: `❌ ${tradingCheck.reason}`,
    });
  }
  
  // Allow starting before 9:15 for history pre-fetch — executions still gated by isMarketHours()
  if (!isStartAllowed()) {
    const stopMins = _STOP_MINS /* cached */;
    const stopLabel = String(Math.floor(stopMins/60)).padStart(2,"0") + ":" + String(stopMins%60).padStart(2,"0");
    return res.status(400).json({ success: false, error: "Trading session already closed for today (" + stopLabel + " IST). Restart tomorrow." });
  }

  const strategy = getActiveStrategy();
  // Reset strategy module-level state if it has a reset hook
  if (typeof strategy.reset === "function") strategy.reset();
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  // Go back 21 calendar days (~15 trading days) to match backtest candle depth.
  // SAR is path-dependent — 7 days gave only ~66 candles, causing SAR/indicator
  // divergence vs backtest (150+ candles). 21 days ensures convergence.
  const fromDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  fromDate.setDate(fromDate.getDate() - 21);
  const fromStr  = fromDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  // Reset state
  tradeState.running        = true;
  tradeState.candles        = [];
  tradeState.log            = [];
  tradeState.position       = null;
  tradeState.currentBar     = null;
  tradeState.barStartTime   = null;
  tradeState.optionLtp      = null;
  tradeState.optionLtpUpdatedAt = null;
  tradeState._ltpStaleLogged = false;
  tradeState.optionSymbol   = null;
  tradeState.tickCount      = 0;
  tradeState.lastTickPrice  = null;
  tradeState.sessionStart   = istNow();
  tradeState.prevCandleHigh = null;
  tradeState.prevCandleLow  = null;
  tradeState.prevCandleMid  = null;
  tradeState.sessionTrades  = [];
  tradeState.sessionPnl     = 0;
  tradeState._wins          = 0;
  tradeState._losses        = 0;
  tradeState._entryPending  = false;
  tradeState._consecutiveLosses    = 0;
  tradeState._pauseUntilTime       = null;
  tradeState._dailyLossHit         = false; // reset daily kill switch on new session
  tradeState._cachedCE             = null; // clear pre-fetch cache on session start
  tradeState._cachedPE             = null;
  tradeState._fiftyPctPauseUntil   = null;
  tradeState._lastCheckedBarHigh   = null;
  tradeState._lastCheckedBarLow    = null;
  tradeState._maxTradesLoggedCandle = null;
  tradeState._missedLoggedCandle   = null;
  _cachedClosedCandleSL     = null; // reset cached SL on fresh session start
  _orderInFlight            = false;
  _squareOffInFlight        = false;
  tradeState._slHitCandleTime = null;
  tradeState._expiryDayBlocked = false;
  stopOptionPolling();
  scheduleEODBackupExit();

  // Expiry day check
  if ((process.env.TRADE_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
    const { isExpiryDay } = require("../utils/nseHolidays");
    const isExpiry = await isExpiryDay();
    if (!isExpiry) tradeState._expiryDayBlocked = true;
    log(`📅 [LIVE] Expiry-only mode: ${isExpiry ? "✅ Today is expiry — trading allowed" : "❌ Not expiry day — entries blocked"}`);
  }

  log(`🟢 [LIVE] Live trading started`);
  log(`   Strategy   : ${ACTIVE} — ${strategy.NAME}`);
  log(`   Instrument : ${instrumentConfig.INSTRUMENT}`);
  log(`   Lot Qty    : ${getLotQty()}`);

  // ── Feature 2: Pre-Market Checklist ─────────────────────────────────────────
  // Collect all check results first, then send ONE combined Telegram alert.
  log(`\n📋 [LIVE] Running pre-market checklist...`);

  const _checks = {
    fyers:   { ok: false, msg: "" },
    symbol:  { ok: false, msg: "" },
    zerodha: { ok: false, msg: "" },
    spot:    null,
  };

  try {
    // Check 1: Fyers spot
    const [spotResult] = await Promise.allSettled([
      getLiveSpot().then(s => { if (!s || s <= 0) throw new Error("spot=0"); return s; }),
    ]);

    if (spotResult.status === "fulfilled") {
      const spot = spotResult.value;
      const atm  = Math.round(spot / 50) * 50;
      _checks.spot = spot;
      _checks.fyers = { ok: true, msg: `NIFTY ₹${spot} | ATM ${atm}` };
      log(`   ✅ Fyers data feed OK — NIFTY spot: ₹${spot} | ATM: ${atm}`);

      // Check 2: Option symbols
      try {
        const [ce, pe] = await Promise.all([
          validateAndGetOptionSymbol(spot, "CE"),
          validateAndGetOptionSymbol(spot, "PE"),
        ]);
        if (!ce.invalid && ce.symbol) {
          _checks.symbol = { ok: true, msg: `${ce.symbol.split(":")[1]} / ${pe.symbol.split(":")[1]}` };
          log(`   ✅ Option symbol OK — CE: ${ce.symbol} | PE: ${pe.symbol}`);
        } else {
          _checks.symbol = { ok: false, msg: `CE invalid — next expiry may not be live` };
          log(`   ⚠️  Option symbol: CE invalid=${ce.invalid}`);
        }
      } catch (symErr) {
        _checks.symbol = { ok: false, msg: symErr.message };
        log(`   ⚠️  Option symbol check failed: ${symErr.message}`);
      }
    } else {
      _checks.fyers = { ok: false, msg: spotResult.reason?.message || "could not fetch spot" };
      log(`   ❌ Fyers data feed FAIL — ${_checks.fyers.msg}`);
      log(`   ⚠️  Re-login at /auth/login`);
    }

    // Check 3: Zerodha
    if (zerodha.isAuthenticated()) {
      _checks.zerodha = { ok: true, msg: "token active" };
      log(`   ✅ Zerodha token active`);
    } else {
      _checks.zerodha = { ok: false, msg: "token missing — re-login at /auth/zerodha/login" };
      log(`   ❌ Zerodha token MISSING — re-login at /auth/zerodha/login`);
    }

    // Check 4: Risk config summary (always logs)
    log(`   📊 Risk config — MaxLoss: ₹${_MAX_DAILY_LOSS} | MaxTrades: ${_MAX_DAILY_TRADES} | Trail T1=${_TRAIL_T1_GAP}→T2=${_TRAIL_T2_GAP}→T3=${_TRAIL_T3_GAP}pt | ActivateFloor: +${_TRAIL_ACTIVATE_PTS}pt`);
    log(`   📅 Session window: ${process.env.TRADE_START_TIME || "09:15"} → ${process.env.TRADE_STOP_TIME || "15:30"} IST`);

    const _allOk = _checks.fyers.ok && _checks.symbol.ok && _checks.zerodha.ok;
    log(`${_allOk ? "✅" : "⚠️ "} [LIVE] Pre-market checklist ${_allOk ? "complete — all systems ready" : "done with warnings — check above"}\n`);

  } catch (checkErr) {
    log(`⚠️ [LIVE] Pre-market checklist error: ${checkErr.message} — continuing anyway`);
  }

  // ── Telegram: Session Started + Checklist results (one combined message) ─────
  const _allOk = _checks.fyers.ok && _checks.symbol.ok && _checks.zerodha.ok;
  notifyStarted({
    mode: "LIVE",
    text: [
      `${_allOk ? "✅" : "⚠️"} SWING LIVE — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${ACTIVE}`,
      `Instrument: ${instrumentConfig.INSTRUMENT}`,
      `Lot Qty   : ${getLotQty()}`,
      `Window    : ${process.env.TRADE_START_TIME || "09:15"} → ${process.env.TRADE_STOP_TIME || "15:30"} IST`,
      `Max Loss  : ₹${_MAX_DAILY_LOSS} | Max Trades: ${_MAX_DAILY_TRADES}`,
      ``,
      `Pre-Market Checklist:`,
      `${_checks.fyers.ok   ? "✅" : "❌"} Fyers   : ${_checks.fyers.msg}`,
      `${_checks.symbol.ok  ? "✅" : "⚠️"} Symbols : ${_checks.symbol.msg || "not checked"}`,
      `${_checks.zerodha.ok ? "✅" : "❌"} Zerodha : ${_checks.zerodha.msg}`,
    ].join("\n"),
  });

  // Pre-load candles (same as paperTrade)
  try {
    log(`📥 Pre-loading candles (${fromStr} → ${todayStr}) — using cache if available...`);
    const candles = await fetchCandlesCached(NIFTY_INDEX_SYMBOL, String(getTradeResolution()), fromStr, todayStr, fetchCandles);
    if (candles.length > 0) {
      tradeState.candles = candles.slice(0, -1);
      log(`✅ Pre-loaded ${tradeState.candles.length} candles`);
      const { signal, reason, stopLoss: preloadSL } = strategy.getSignal(tradeState.candles);
      _cachedClosedCandleSL = preloadSL ?? null; // seed so first-tick entry has valid SL
      log(`📊 Signal on pre-loaded data: ${signal} | ${reason}`);
      const last = tradeState.candles[tradeState.candles.length - 1];
      if (last) {
        tradeState.prevCandleHigh = last.high;
        tradeState.prevCandleLow  = last.low;
        tradeState.prevCandleMid  = parseFloat(((last.high + last.low) / 2).toFixed(2));
      }
      // ── Gap detection — compare today's open vs yesterday's close ──────────
      const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const todayCandles = tradeState.candles.filter(c => {
        const d = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        return d === todayIST;
      });
      const yesterdayCandles = tradeState.candles.filter(c => {
        const d = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        return d < todayIST;
      });
      if (todayCandles.length > 0 && yesterdayCandles.length > 0) {
        const todayOpen = todayCandles[0].open;
        const yesterdayClose = yesterdayCandles[yesterdayCandles.length - 1].close;
        const gapPts = parseFloat((todayOpen - yesterdayClose).toFixed(1));
        const GAP_THRESHOLD = parseFloat(process.env.GAP_THRESHOLD_PTS || "50");
        if (Math.abs(gapPts) >= GAP_THRESHOLD) {
          const dir = gapPts > 0 ? "UP" : "DOWN";
          log(`🔔 [LIVE] GAP ${dir} detected: ${Math.abs(gapPts).toFixed(0)} pts (open ₹${todayOpen} vs prev close ₹${yesterdayClose})`);
          sendTelegram(`🔔 GAP ${dir}: ${Math.abs(gapPts).toFixed(0)} pts — be cautious with early entries`).catch(() => {});
        } else {
          log(`✅ [LIVE] No significant gap — open ₹${todayOpen} vs prev close ₹${yesterdayClose} (${gapPts > 0 ? "+" : ""}${gapPts} pts)`);
        }
      }
    } else {
      log("⚠️  No candles found — will build from live ticks");
    }
  } catch (err) {
    log(`⚠️  Could not pre-load candles: ${err.message}`);
  }

  // ── Position reconciliation — check broker for orphaned positions ───────────
  try {
    const brokerPositions = await zerodha.getPositions();
    const dayPositions = (brokerPositions.day || []).filter(p => p.quantity !== 0);
    if (dayPositions.length > 0) {
      const symbols = dayPositions.map(p => `${p.tradingsymbol}(qty=${p.quantity})`).join(", ");
      log(`⚠️ [LIVE] Broker has open day positions: ${symbols}`);
      log(`   If these are from a previous crash, consider manual square-off on Zerodha dashboard.`);
      sendTelegram(`⚠️ Orphaned positions detected on Zerodha: ${symbols}`).catch(() => {});
    } else {
      log(`✅ [LIVE] No orphaned positions on broker — clean start`);
    }
  } catch (err) {
    log(`⚠️ [LIVE] Position reconciliation failed: ${err.message}`);
  }

  log(`📡 Subscribing to ${NIFTY_INDEX_SYMBOL} for live tick data...`);
  socketManager.start(NIFTY_INDEX_SYMBOL, onSpotTick, log);
  sharedSocketState.setActive("SWING_LIVE");

  res.json({
    success:     true,
    message:     `Live trading started — ${ACTIVE}`,
    dataSource:  "Fyers (WebSocket + REST)",
    orderBroker: "Zerodha Kite Connect",
    instrument:  instrumentConfig.INSTRUMENT,
    strategy:    { name: strategy.NAME },
    lotQty:      getLotQty(),
    monitorAt:   "GET /swing-live/status",
  });
});

router.get("/stop", async (req, res) => {
  if (!tradeState.running) return res.status(400).json({ success: false, error: "Trading is not running." });

  if (tradeState.position && tradeState.currentBar) {
    log("🛑 [LIVE] Manual stop — squaring off open position via Zerodha");
    await squareOff(tradeState.currentBar.close, "Manual stop");
  }

  const _hadTradesForReport = tradeState.sessionTrades && tradeState.sessionTrades.length > 0;
  const _sessionTradesSnap  = tradeState.sessionTrades ? tradeState.sessionTrades.slice() : [];
  const _sessionPnlSnap     = tradeState.sessionPnl;
  const _sessionStartSnap   = tradeState.sessionStart;

  saveLiveSession();
  // Zero-trade case: rich report is skipped (saveLiveSession returns early).
  // Emit a basic day report so TG_SWING_DAYREPORT subscribers still get closure.
  if (!_hadTradesForReport) {
    notifyDayReport({
      mode: "LIVE",
      sessionTrades: _sessionTradesSnap,
      sessionPnl:    _sessionPnlSnap,
      sessionStart:  _sessionStartSnap,
    });
  }
  stopOptionPolling();
  // Only stop socket if no scalp mode is piggybacking
  if (!sharedSocketState.isScalpActive()) {
    socketManager.stop();
  } else {
    log("📡 [LIVE] Socket kept alive — scalp mode still active");
  }
  tradeState.optionLtp    = null;
  tradeState.optionLtpUpdatedAt = null;
  tradeState._ltpStaleLogged = false;
  tradeState.optionSymbol = null;
  tradeState.running      = false;
  clearEODBackupTimer();
  sharedSocketState.clear();
  log("⏹ [LIVE] Live trading stopped");

  res.json({ success: true, message: "Live trading stopped. Position squared off via Zerodha." });
});

// Manual exit — close position only, session keeps running
router.get("/exit", async (req, res) => {
  if (!tradeState.running)   return res.status(400).json({ success: false, error: "Live trading is not running." });
  if (!tradeState.position)  return res.status(400).json({ success: false, error: "No open position to exit." });
  if (!tradeState.currentBar) return res.status(400).json({ success: false, error: "No market data yet." });

  const exitSpot   = tradeState.currentBar.close;
  const exitOption = tradeState.optionLtp || null;
  log(`🖐️ [LIVE] MANUAL EXIT | NIFTY spot: ₹${exitSpot} | Option LTP: ${exitOption ? "₹" + exitOption : "N/A"}`);

  // ── Block re-entry for 1 full candle after manual exit ──────────────────────
  // Without this, if a signal fires at the same candle close, the bot immediately
  // re-enters — which is not what the user wants when manually exiting.
  // Use _slHitCandleTime to block same-candle re-entry AND _fiftyPctPauseUntil
  // to block the next candle too (1 full candle pause = TRADE_RES minutes).
  tradeState._slHitCandleTime = tradeState.currentBar ? tradeState.currentBar.time : null;
  const _manualPauseMs = TRADE_RES * 60 * 1000; // 1 candle pause
  tradeState._fiftyPctPauseUntil = Date.now() + _manualPauseMs;
  const _resumeTime = new Date(tradeState._fiftyPctPauseUntil).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  log(`⏸ [LIVE] Manual exit — re-entry paused for 1 candle (~${TRADE_RES} min, resume ~${_resumeTime})`);

  await squareOff(exitSpot, "Manual exit by user");

  return res.redirect("/swing-live/status");
});

/**
 * POST /swing-live/manualEntry
 * Manually enter a CE or PE trade at current spot. Places REAL order via Zerodha.
 * SL = current SAR (capped). Trail/breakeven apply normally after entry.
 */
router.post("/manualEntry", async (req, res) => {
  if (!tradeState.running) return res.status(400).json({ success: false, error: "Live trading is not running." });
  if (tradeState.position) return res.status(400).json({ success: false, error: "Already in a position." });
  const liveEnabled = process.env.SWING_LIVE_ENABLED === "true";
  if (!liveEnabled) return res.status(400).json({ success: false, error: "SWING_LIVE_ENABLED is false." });

  const { side } = req.body || {};
  if (side !== "CE" && side !== "PE") return res.status(400).json({ success: false, error: "Side must be CE or PE." });

  const spot = tradeState.lastTickPrice || (tradeState.currentBar ? tradeState.currentBar.close : null);
  if (!spot) return res.status(400).json({ success: false, error: "No market data yet." });

  // Get SAR for SL from strategy
  const candles = tradeState.candles || [];
  let stopLoss = null;
  if (candles.length > 0) {
    const { getActiveStrategy } = require("../strategies");
    const result = getActiveStrategy().getSignal(candles, { silent: true });
    if (result && result.stopLoss) stopLoss = result.stopLoss;
  }
  const MAX_SL = parseFloat(process.env.MAX_SAR_DISTANCE || "80");
  if (!stopLoss) stopLoss = side === "CE" ? spot - MAX_SL : spot + MAX_SL;

  // Validate SL is on correct side (CE: below entry, PE: above entry)
  if ((side === "CE" && stopLoss >= spot) || (side === "PE" && stopLoss <= spot)) {
    stopLoss = side === "CE" ? spot - MAX_SL : spot + MAX_SL;
    log(`⚠️ [LIVE] Manual ${side}: SAR on wrong side — using ${MAX_SL}pt fixed SL @ ₹${stopLoss}`);
  }

  const gap = Math.abs(spot - stopLoss);
  if (gap > MAX_SL) stopLoss = side === "CE" ? spot - MAX_SL : spot + MAX_SL;

  try {
    const { validateAndGetOptionSymbol, getLotQty } = require("../config/instrument");
    const optResult = await validateAndGetOptionSymbol(spot, side);
    const symbol = optResult.symbol;
    const qty = getLotQty();
    const orderSide = side === "CE" ? 1 : -1; // Zerodha: 1=BUY, -1=SELL for options we always BUY

    log(`🖐️ [LIVE] MANUAL ENTRY ${side} by user @ spot ₹${spot} | SL: ₹${stopLoss} | Symbol: ${symbol}`);

    const result = await placeMarketOrder(symbol, 1, qty); // always BUY options
    if (!result || result.error) {
      log(`❌ [LIVE] Manual entry order FAILED: ${result ? result.error : "no result"}`);
      return res.status(500).json({ success: false, error: result ? result.error : "Order failed" });
    }

    const optDetails = parseOptionDetails(symbol);
    tradeState.position = {
      side, symbol, qty,
      entryPrice: spot, spotAtEntry: spot,
      entryTime: istNow(),
      reason: `Manual ${side} entry by user`,
      stopLoss, initialStopLoss: stopLoss,
      trailActivatePts: _TRAIL_ACTIVATE_PTS,
      bestPrice: null,
      candlesHeld: 0,
      orderId: result.orderId || null,
      entryBarTime: tradeState.currentBar ? tradeState.currentBar.time : null,
      entryPrevMid: null,
      optionExpiry: optDetails?.expiry || null,
      optionStrike: optDetails?.strike || null,
      optionType: optDetails?.optionType || side,
      optionEntryLtp: null, optionCurrentLtp: null, optionEntryLtpTime: null,
    };
    tradeState.optionSymbol = symbol;
    tradeState._entryPending = false;
    if (instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES") {
      startOptionPolling(symbol);
    }

    log(`📝 [LIVE] MANUAL BUY ${qty} × ${symbol} @ SPOT ₹${spot} | SL: ₹${stopLoss} | OrderID: ${result.orderId || "?"}`);
    saveTradePosition(tradeState.position, { sessionPnl: tradeState.sessionPnl || 0 });
    return res.json({ success: true, spot, side, sl: stopLoss, symbol, orderId: result.orderId });
  } catch (e) {
    log(`❌ [LIVE] Manual entry failed: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /swing-live/status/chart-data
 * Returns candle history + trade markers for the lightweight-charts widget.
 */
router.get("/status/chart-data", (req, res) => {
  try {
    const candles = tradeState.candles.map(c => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    if (tradeState.currentBar) {
      candles.push({
        time: tradeState.currentBar.time, open: tradeState.currentBar.open,
        high: tradeState.currentBar.high, low: tradeState.currentBar.low, close: tradeState.currentBar.close,
      });
    }
    const markers = [];
    for (const t of tradeState.sessionTrades) {
      if (t.entryPrice && t.entryBarTime) {
        markers.push({ time: t.entryBarTime, position: 'belowBar', color: '#3b82f6', shape: 'arrowUp',
          text: `${t.side} @ ${t.entryPrice.toFixed(0)}` });
      }
      if (t.exitPrice && t.exitBarTime) {
        const isWin = t.pnl > 0;
        markers.push({ time: t.exitBarTime, position: 'aboveBar', color: isWin ? '#10b981' : '#ef4444', shape: 'arrowDown',
          text: `Exit ${isWin ? '+' : ''}${t.pnl ? t.pnl.toFixed(0) : ''}` });
      }
    }
    let stopLoss = null;
    if (tradeState.position && tradeState.position.stopLoss) stopLoss = tradeState.position.stopLoss;
    let entryPrice = null;
    if (tradeState.position && tradeState.position.entryPrice) entryPrice = tradeState.position.entryPrice;
    return res.json({ candles, markers, stopLoss, entryPrice });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /swing-live/status/data
 * JSON-only AJAX endpoint — returns all dynamic live trade state.
 * Called every 2 s by client-side setInterval when trading is active.
 */
router.get("/status/data", (req, res) => {
  try {
    const fyersOk   = !!process.env.ACCESS_TOKEN;
    const zerodhaOk = zerodha.isAuthenticated();

    let unrealisedPnl = 0;
    const INSTR = instrumentConfig.INSTRUMENT;
    const isFutures = INSTR === "NIFTY_FUTURES";
    if (tradeState.position && tradeState.currentBar) {
      const ltp = tradeState.currentBar.close;
      const pos = tradeState.position;
      if (isFutures) {
        const _c = getCharges({ isFutures: true, exitPremium: ltp, entryPremium: pos.entryPrice, qty: pos.qty });
        unrealisedPnl = parseFloat(((ltp - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * pos.qty - _c).toFixed(2));
      } else {
        const cur = tradeState.optionLtp || pos.optionCurrentLtp;
        if (pos.optionEntryLtp && cur && pos.optionEntryLtp > 0) {
          const _c = getCharges({ isFutures: false, exitPremium: cur, entryPremium: pos.optionEntryLtp, qty: pos.qty });
          unrealisedPnl = parseFloat(((cur - pos.optionEntryLtp) * pos.qty - _c).toFixed(2));
        } else {
          const _c = getCharges({ isFutures: false, exitPremium: ltp, entryPremium: pos.entryPrice, qty: pos.qty });
          unrealisedPnl = parseFloat(((ltp - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * pos.qty - _c).toFixed(2));
        }
      }
    }

    const pos           = tradeState.position;
    const optEntryLtp   = pos ? (pos.optionEntryLtp   || null) : null;
    const optCurrentLtp = pos ? (tradeState.optionLtp || pos.optionCurrentLtp || null) : null;
    const optPremiumPnl = (optEntryLtp && optCurrentLtp)
      ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0)).toFixed(2)) : null;
    const optPremiumMove = (optEntryLtp && optCurrentLtp)
      ? parseFloat((optCurrentLtp - optEntryLtp).toFixed(2)) : null;
    const optPremiumPct  = (optEntryLtp && optCurrentLtp && optEntryLtp > 0)
      ? parseFloat(((optCurrentLtp - optEntryLtp) / optEntryLtp * 100).toFixed(2)) : null;
    const OPT_STOP_PCT_VAL = _OPT_STOP_PCT;
    const optStopPrice   = optEntryLtp
      ? parseFloat((optEntryLtp * (1 - OPT_STOP_PCT_VAL)).toFixed(2)) : null;
    const liveClose    = tradeState.currentBar?.close || null;
    const pointsMoved  = pos && liveClose
      ? parseFloat(((liveClose - pos.entryPrice) * (pos.side === "CE" ? 1 : -1)).toFixed(2)) : 0;

    return res.json({
      running:           tradeState.running,
      sessionPnl:        tradeState.sessionPnl,
      unrealisedPnl,
      isFutures,
      tickCount:         tradeState.tickCount,
      lastTickPrice:     tradeState.lastTickPrice,
      candleCount:       tradeState.candles.length,
      prevCandleHigh:    tradeState.prevCandleHigh,
      prevCandleLow:     tradeState.prevCandleLow,
      consecutiveLosses: tradeState._consecutiveLosses || 0,
      pauseUntilTime:    tradeState._pauseUntilTime || null,
      dailyLossHit:      tradeState._dailyLossHit || false,
      sessionStart:      tradeState.sessionStart,
      tradeCount:        tradeState.sessionTrades.length,
      wins:              tradeState._wins || 0,
      losses:            tradeState._losses || 0,
      fyersOk,
      zerodhaOk,
      // Position block
      position: pos ? {
        side:              pos.side,
        symbol:            pos.symbol,
        qty:               pos.qty,
        entryPrice:        pos.entryPrice,
        entryTime:         pos.entryTime,
        stopLoss:          pos.stopLoss,
        initialStopLoss:   pos.initialStopLoss || null,
        trailActivatePts:  pos.trailActivatePts || null,
        optionStrike:      pos.optionStrike,
        optionExpiry:      pos.optionExpiry,
        optionType:        pos.optionType,
        optionEntryLtp:    optEntryLtp,
        optionCurrentLtp:  optCurrentLtp,
        optionEntryLtpTime: pos.optionEntryLtpTime || null,
        optionLtpStaleSec: tradeState.optionLtpUpdatedAt ? Math.round((Date.now() - tradeState.optionLtpUpdatedAt) / 1000) : null,
        optPremiumPnl,
        optPremiumMove,
        optPremiumPct,
        optStopPrice,
        optStopPct:        Math.round(OPT_STOP_PCT_VAL * 100),
        liveClose,
        pointsMoved,
        bestPrice:         pos.bestPrice || null,
        reason:            pos.reason || null,
        orderId:           pos.orderId || null,
      } : null,
      currentBar: tradeState.currentBar ? {
        open:  tradeState.currentBar.open,
        high:  tradeState.currentBar.high,
        low:   tradeState.currentBar.low,
        close: tradeState.currentBar.close,
      } : null,
      trades: tradeState.sessionTrades.map(t => ({
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
      logTotal: tradeState.log.length,
      logs: reverseSlice(tradeState.log, 200),
    });
  } catch (err) {
    console.error("[trade/status/data] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/status", (req, res) => {
  try {
  const strategy    = getActiveStrategy();
  const liveEnabled = process.env.SWING_LIVE_ENABLED === "true";
  const fyersOk     = !!process.env.ACCESS_TOKEN;
  const zerodhaOk   = zerodha.isAuthenticated();

  // VIX details for top-bar display
  const _vix          = getCachedVix();
  const _vixEnabled   = vixFilter.VIX_ENABLED;
  const _vixMaxEntry  = vixFilter.VIX_MAX_ENTRY;
  const _vixStrongOnly = vixFilter.VIX_STRONG_ONLY;

  const inr      = (n) => typeof n === "number" ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
  const pnlColor = (n) => n >= 0 ? "#10b981" : "#ef4444";

  const pos = tradeState.position;

  const INSTR = instrumentConfig.INSTRUMENT; // top-level constant
  const isFutures = INSTR === "NIFTY_FUTURES";

  // Unrealised PnL (minus charges)
  let unrealisedPnl = 0;
  if (pos && tradeState.currentBar) {
    const ltp = tradeState.currentBar.close;
    if (isFutures) {
      const _cp = getCharges({ isFutures: true, exitPremium: ltp, entryPremium: pos.entryPrice, qty: pos.qty });
      unrealisedPnl = parseFloat(((ltp - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * pos.qty - _cp).toFixed(2));
    } else {
      const cur = tradeState.optionLtp || pos.optionCurrentLtp;
      if (pos.optionEntryLtp && cur && pos.optionEntryLtp > 0) {
        const _cp = getCharges({ isFutures: false, exitPremium: cur, entryPremium: pos.optionEntryLtp, qty: pos.qty });
        unrealisedPnl = parseFloat(((cur - pos.optionEntryLtp) * pos.qty - _cp).toFixed(2));
      } else {
        const _cp = getCharges({ isFutures: false, exitPremium: ltp, entryPremium: pos.entryPrice, qty: pos.qty });
        unrealisedPnl = parseFloat(((ltp - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * pos.qty - _cp).toFixed(2));
      }
    }
  }

  const optEntryLtp   = pos ? (pos.optionEntryLtp   || null) : null;
  const optCurrentLtp = pos ? (tradeState.optionLtp || pos.optionCurrentLtp || null) : null;
  const _chgOptTrd = (optEntryLtp && optCurrentLtp) ? getCharges({ isFutures, exitPremium: optCurrentLtp, entryPremium: optEntryLtp, qty: pos ? pos.qty : 0 }) : 0;
  const optPremiumPnl = (optEntryLtp && optCurrentLtp)
    ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0) - _chgOptTrd).toFixed(2))
    : null;
  const optPremiumMove = (optEntryLtp && optCurrentLtp)
    ? parseFloat((optCurrentLtp - optEntryLtp).toFixed(2))
    : null;
  const optPremiumPct  = (optEntryLtp && optCurrentLtp && optEntryLtp > 0)
    ? parseFloat(((optCurrentLtp - optEntryLtp) / optEntryLtp * 100).toFixed(2))
    : null;
  const OPT_STOP_PCT_VAL2 = _OPT_STOP_PCT;
  const optStopPrice   = optEntryLtp
    ? parseFloat((optEntryLtp * (1 - OPT_STOP_PCT_VAL2)).toFixed(2)) : null;
  const optStopPct     = Math.round(OPT_STOP_PCT_VAL2 * 100);

  const liveClose  = tradeState.currentBar?.close || null;
  const pointsMoved = pos && liveClose
    ? parseFloat(((liveClose - pos.entryPrice) * (pos.side === "CE" ? 1 : -1)).toFixed(2))
    : 0;
  const trailActive = pos && pos.bestPrice !== null && pos.bestPrice !== undefined;
  const trailProfit = pos && pos.bestPrice
    ? parseFloat((pos.side === "CE" ? pos.bestPrice - pos.entryPrice : pos.entryPrice - pos.bestPrice).toFixed(2))
    : 0;

  // ATM/ITM badge
  const atmStrike   = pos ? Math.round(pos.entryPrice / 50) * 50 : null;
  const strikeLabel = pos && pos.optionStrike
    ? (pos.optionStrike === atmStrike ? "ATM" : pos.optionStrike < atmStrike ? (pos.side === "CE" ? "ITM" : "OTM") : (pos.side === "PE" ? "ITM" : "OTM"))
    : "—";
  const strikeBadgeColor = strikeLabel === "ATM" ? "#3b82f6" : strikeLabel === "ITM" ? "#10b981" : "#ef4444";

  const posHtml = pos ? `
    <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#ef4444;display:inline-block;animation:pulse 1.5s infinite;"></span>
          <span style="font-size:0.8rem;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:1px;">⚡ LIVE Position</span>
          <span style="font-size:0.72rem;color:#4a6080;">Since ${fmtT(pos.entryTime)}</span>
        </div>
        <button onclick="ltHandleExit(this)"
           style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;transition:background 0.15s;"
           onmouseover="this.style.background='#991b1b'" onmouseout="this.style.background='#7f1d1d'">
          🚪 Exit Trade Now (Zerodha)
        </button>
      </div>

      <!-- Position Identity -->
      <div style="background:#071a12;border:1px solid #134e35;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:2.2rem;font-weight:900;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${isFutures ? (pos.side === "CE" ? "LONG" : "SHORT") : pos.side}</span>
            <div>
              <div style="font-size:0.72rem;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${isFutures ? (pos.side === "CE" ? "FUTURES · Bullish" : "FUTURES · Bearish") : (pos.side === "CE" ? "CALL · Bullish" : "PUT · Bearish")}</div>
              ${!isFutures ? `<span style="font-size:0.65rem;font-weight:700;background:${strikeBadgeColor}22;color:${strikeBadgeColor};border:1px solid ${strikeBadgeColor}44;padding:2px 7px;border-radius:4px;">${strikeLabel}</span>` : ""}
            </div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          ${isFutures ? `
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Direction</div>
            <div style="font-size:1.4rem;font-weight:800;color:#fff;">${pos.side === "CE" ? "📈 BUY" : "📉 SELL"}</div>
          </div>` : `
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Strike</div>
            <div style="font-size:1.6rem;font-weight:800;color:#fff;font-family:monospace;">${pos.optionStrike ? pos.optionStrike.toLocaleString("en-IN") : "—"}</div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Expiry</div>
            <div style="font-size:1.1rem;font-weight:700;color:#f59e0b;">${pos.optionExpiry || "—"}</div>
          </div>`}
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Qty / Lots</div>
            <div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty} <span style="font-size:0.72rem;color:#4a6080;">(${Math.round(pos.qty / 65)} lot)</span></div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;flex-shrink:0;"></div>
          <div style="flex:1;min-width:200px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Full Symbol</div>
            <div style="font-size:0.82rem;font-weight:600;color:#c8d8f0;font-family:monospace;word-break:break-all;">${pos.symbol}</div>
          </div>
          ${pos.orderId ? `
          <div style="width:1px;height:44px;background:#134e35;flex-shrink:0;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Zerodha Order ID</div>
            <div style="font-size:0.82rem;font-weight:600;color:#a78bfa;font-family:monospace;">${pos.orderId}</div>
          </div>` : ""}
        </div>
      </div>

      <!-- Option Premium Section -->
      <div style="background:#0a0f24;border:2px solid #ef4444;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
        <div style="font-size:0.68rem;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">⚡ ${isFutures ? "LIVE Futures PnL (Spot Price)" : `LIVE Option Premium (${pos.optionType} Price)`}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">

          <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid #1e3a5f;border-radius:10px;">
            <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Entry Price</div>
            <div id="ajax-lt-opt-entry-ltp" style="font-size:2rem;font-weight:800;color:#60a5fa;font-family:monospace;line-height:1;">
              ${optEntryLtp ? "₹" + optEntryLtp.toFixed(2) : "<span style='font-size:1rem;color:#f59e0b;'>Fetching...</span>"}
            </div>
            <div style="font-size:0.68rem;color:#4a6080;margin-top:4px;">
              ${optEntryLtp
                ? `captured at ${fmtT(pos.optionEntryLtpTime || pos.entryTime)}`
                : `⏳ first REST poll in ~3s<br><span style='color:#c8d8f0;'>NIFTY entry: ${inr(pos.entryPrice)}</span>`}
            </div>
          </div>

          <div style="text-align:center;font-size:1.8rem;color:${optPremiumMove !== null ? (optPremiumMove >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};">→</div>

          <div style="text-align:center;padding:12px;background:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#071a0f" : "#1a0707") : "#0d1320"};border:2px solid ${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};border-radius:10px;">
            <div style="font-size:0.63rem;color:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Current LTP</div>
            <div id="ajax-lt-opt-current-ltp" style="font-size:2rem;font-weight:800;color:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">
              ${optCurrentLtp ? "₹" + optCurrentLtp.toFixed(2) : "⏳"}
            </div>
            <div id="ajax-lt-opt-move" style="font-size:0.72rem;font-weight:700;margin-top:6px;color:${optPremiumMove !== null ? (optPremiumMove >= 0 ? "#10b981" : "#ef4444") : "#f59e0b"};">
              ${optPremiumMove !== null ? (optPremiumMove >= 0 ? "▲ +" : "▼ ") + "₹" + Math.abs(optPremiumMove).toFixed(2) + " pts" : optCurrentLtp ? "⏳ Awaiting entry price..." : "⏳ Polling REST feed..."}
            </div>
            <div id="ajax-lt-opt-pct" style="font-size:1.1rem;font-weight:800;margin-top:4px;color:${optPremiumPct !== null ? (optPremiumPct >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};font-family:monospace;">
              ${optPremiumPct !== null ? (optPremiumPct >= 0 ? "+" : "") + optPremiumPct.toFixed(2) + "%" : "—"}
            </div>
          </div>

          <div style="text-align:center;padding:12px;background:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#071a0f" : "#1a0707") : "#0d1320"};border:1px solid ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#065f46" : "#7f1d1d") : "#1a2236"};border-radius:10px;">
            <div style="font-size:0.63rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Unrealised P&L</div>
            <div id="ajax-lt-opt-pnl" style="font-size:1.8rem;font-weight:800;color:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">
              ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "+" : "") + "₹" + optPremiumPnl.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2}) : "—"}
            </div>
            <div style="font-size:0.65rem;color:#4a6080;margin-top:4px;">${pos.qty} qty · after charges</div>
          </div>

        </div>
      </div>

      <!-- Secondary grid -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px;">
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY Spot @ Entry</div>
          <div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(pos.entryPrice)}</div>
          <div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">candle close</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY LTP</div>
          <div id="ajax-lt-nifty-ltp" style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(liveClose)}</div>
          <div id="ajax-lt-nifty-move" style="font-size:0.63rem;color:${pointsMoved >= 0 ? "#10b981" : "#ef4444"};margin-top:2px;">${pointsMoved >= 0 ? "▲" : "▼"} ${Math.abs(pointsMoved).toFixed(1)} pts</div>
        </div>
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop Loss (SAR)</div>
          <div id="ajax-lt-stop-loss" style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.stopLoss ? inr(pos.stopLoss) : "—"}</div>
          <div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">Risk: ${pos.stopLoss ? inr(Math.abs(pos.entryPrice - pos.stopLoss) * pos.qty) : "—"}</div>
        </div>
        <div style="background:#1c0d00;border:1px solid #92400e;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Option SL (${optStopPct}% stop)</div>
          <div id="ajax-lt-opt-sl" style="font-size:1.05rem;font-weight:700;color:#f97316;">${optStopPrice ? "₹" + optStopPrice.toFixed(2) : "—"}</div>
          <div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">${optEntryLtp ? "entry ₹" + optEntryLtp.toFixed(2) + " × " + (100 - optStopPct) + "%" : "awaiting entry LTP"}</div>
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
      <div style="font-size:0.9rem;font-weight:600;color:#4a6080;margin-bottom:14px;">FLAT — Waiting for entry signal</div>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button onclick="manualEntry('CE')" style="padding:8px 24px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▲ Manual CE</button>
        <button onclick="manualEntry('PE')" style="padding:8px 24px;background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▼ Manual PE</button>
      </div>
    </div>`;

  // Build all log entries as JSON for client-side filtering (mirrors paperTrade)
  const allLogs = [...tradeState.log].reverse(); // newest first
  const logsJSON = JSON.stringify(allLogs)
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/`/g, "\\u0060")
    .replace(/\$/g, "\\u0024");

  // Zerodha token warning
  const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const tokenPastExpiry = nowIST.getHours() >= 6 && nowIST.getHours() < 9;
  const tokenNearExpiry = nowIST.getHours() === 5 && nowIST.getMinutes() >= 45;
  const expiryBanner = zerodhaOk && tokenPastExpiry && !tradeState.running
    ? `<div style="background:#2d1000;border:1px solid #c05621;border-radius:10px;padding:12px 18px;margin-bottom:20px;font-size:0.85rem;color:#f6ad55;">⚠️ <strong>Zerodha token expired at 6 AM.</strong> Re-login at <a href="/auth/zerodha/login" style="color:#63b3ed;">/auth/zerodha/login</a>.</div>`
    : zerodhaOk && tokenNearExpiry && !tradeState.running
    ? `<div style="background:#2d1800;border:1px solid #744210;border-radius:10px;padding:12px 18px;margin-bottom:20px;font-size:0.85rem;color:#fbd38d;">⏰ <strong>Zerodha token expires at 6 AM.</strong> Re-login before market hours.</div>`
    : "";

  const fyersBadge   = fyersOk   ? `<span style="background:#0a2a0a;border:1px solid #065f46;color:#10b981;padding:3px 10px;border-radius:6px;font-size:0.75rem;font-weight:600;">Fyers ✅ Data</span>` : `<span style="background:#2d1515;border:1px solid #9b2c2c;color:#fc8181;padding:3px 10px;border-radius:6px;font-size:0.75rem;font-weight:600;">Fyers ❌ Data</span>`;
  const zerodhaBadge = zerodhaOk ? `<span style="background:#0a1a2a;border:1px solid #1a4a7a;color:#63b3ed;padding:3px 10px;border-radius:6px;font-size:0.75rem;font-weight:600;">Zerodha ✅ Orders</span>` : `<span style="background:#2d1515;border:1px solid #9b2c2c;color:#fc8181;padding:3px 10px;border-radius:6px;font-size:0.75rem;font-weight:600;">Zerodha ❌ Orders</span>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <!-- AJAX polling replaces meta-refresh — see startAjaxRefresh() below -->
  <link rel="icon" type="image/png" href="data:image/png;base64,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"/>
  <title>ௐ Palani Andawar Thunai ॐ — Live Trade</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet"/>
  <script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'IBM Plex Mono',monospace;background:#040c18;color:#c8d8f0;overflow-x:hidden;}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
    @keyframes ltpulse{0%,100%{opacity:1}50%{opacity:.25}}

    ${sidebarCSS()}

    /* ── EXPIRY BANNER ── */
    .expiry-banner{background:#2d1000;border:1px solid #c05621;border-radius:9px;padding:10px 16px;margin-bottom:16px;font-size:0.78rem;color:#f6ad55;}
    ${modalCSS()}
  </style>
</head>
<body>
<div class="app-shell">
<!-- ── SIDEBAR ── -->
${buildSidebar('swingLive', tradeState.running, tradeState.running, {
  showExitBtn: !!pos,
  exitBtnJs: 'ltHandleExit(this)',
  showStopBtn: tradeState.running,
  stopBtnJs: 'ltHandleStop(this)',
  showStartBtn: !tradeState.running,
  startBtnJs: 'ltHandleStart(this)',
})}

<!-- ── MAIN CONTENT ── -->
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">Live Trade</div>
      <div class="top-bar-meta">Strategy: ${ACTIVE} — ${strategy.NAME} · ${getTradeResolution()}-min candles · ${tradeState.running ? 'Auto-refreshes every 2s' : 'Not refreshing — trading stopped'}</div>
    </div>
    <div class="top-bar-right">
      ${tradeState.running ? `<span class="top-bar-badge live-active"><span style="width:5px;height:5px;border-radius:50%;background:#ef4444;display:inline-block;"></span>ACTIVE</span>` : `<span class="top-bar-badge">● STOPPED</span>`}
      ${_vixEnabled ? `<span class="top-bar-badge" style="border-color:${_vix == null ? 'rgba(100,116,139,0.3)' : _vix > _vixMaxEntry ? 'rgba(239,68,68,0.3)' : _vix > _vixStrongOnly ? 'rgba(234,179,8,0.3)' : 'rgba(16,185,129,0.3)'};background:${_vix == null ? 'rgba(100,116,139,0.08)' : _vix > _vixMaxEntry ? 'rgba(239,68,68,0.1)' : _vix > _vixStrongOnly ? 'rgba(234,179,8,0.1)' : 'rgba(16,185,129,0.1)'};color:${_vix == null ? '#94a3b8' : _vix > _vixMaxEntry ? '#ef4444' : _vix > _vixStrongOnly ? '#eab308' : '#10b981'};">🌡️ VIX ${_vix != null ? _vix.toFixed(1) : 'n/a'}${_vix != null ? (_vix > _vixMaxEntry ? ' · BLOCKED' : _vix > _vixStrongOnly ? ' · STRONG ONLY' : ' · NORMAL') : ''}</span>` : ''}
      <button onclick="ltHandleReset(this)" style="background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;">↺ Reset</button>
    </div>
  </div>
  <div class="broker-badges">
    <span class="broker-badge ${fyersOk ? 'ok' : 'err'}">${fyersOk ? '● Fyers · Data' : '✕ Fyers · Data'}</span>
    <span class="broker-badge ${zerodhaOk ? 'ok' : 'err'}">${zerodhaOk ? '● Zerodha · Orders' : '✕ Zerodha · Orders'}</span>
  </div>
  <div class="page">
    <div class="page-header">
      <div class="page-status-row">
        <span class="page-status-dot ${tradeState.running ? 'running' : ''}"></span>
        <span class="page-status-text ${tradeState.running ? 'running' : ''}">${tradeState.running ? 'LIVE TRADING ACTIVE' : 'STOPPED'}</span>
      </div>
      <div class="page-title">Live Trade</div>
    </div>

    ${expiryBanner}

  <div class="stat-grid">
    <div class="sc" style="border-top:2px solid ${tradeState.running ? "#ef4444" : "#4a6080"};">
      <div class="sc-label">Status</div>
      <div class="sc-val" style="font-size:1rem;color:${tradeState.running ? "#ef4444" : "#4a6080"};">${tradeState.running ? "⚡ RUNNING" : "● STOPPED"}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #3b82f6;">
      <div class="sc-label">WebSocket Ticks</div>
      <div class="sc-val" id="ajax-lt-tick-count">${tradeState.tickCount.toLocaleString()}</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">Last: <span id="ajax-lt-last-tick">${tradeState.lastTickPrice ? inr(tradeState.lastTickPrice) : "—"}</span></div>
    </div>
    <div class="sc" style="border-top:1.5px solid #8b5cf6;">
      <div class="sc-label">Candles Loaded</div>
      <div class="sc-val" id="ajax-lt-candle-count">${tradeState.candles.length}</div>
      <div id="ajax-lt-candle-status" style="font-size:0.7rem;color:${tradeState.candles.length >= 30 ? "#10b981" : "#f59e0b"};margin-top:4px;">${tradeState.candles.length >= 30 ? `✅ Strategy ready` : "⚠️ Warming up..."}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #2a4060;">
      <div class="sc-label">Session Start</div>
      <div class="sc-val" style="font-size:0.85rem;color:#c8d8f0;">${tradeState.sessionStart || "—"}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #ef4444;">
      <div class="sc-label">Prev Candle High</div>
      <div class="sc-val" id="ajax-lt-prev-high" style="font-size:1rem;color:#ef4444;">${tradeState.prevCandleHigh ? inr(tradeState.prevCandleHigh) : "—"}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #10b981;">
      <div class="sc-label">Prev Candle Low</div>
      <div class="sc-val" id="ajax-lt-prev-low" style="font-size:1rem;color:#10b981;">${tradeState.prevCandleLow ? inr(tradeState.prevCandleLow) : "—"}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #8b5cf6;">
      <div class="sc-label">Trades Today</div>
      <div class="sc-val"><span id="ajax-lt-trade-count">${tradeState.sessionTrades.length}</span> <span style="font-size:0.75rem;color:#4a6080;">/ ${process.env.MAX_DAILY_TRADES || 20}</span></div>
      <div id="ajax-lt-wl" style="font-size:0.7rem;color:#4a6080;margin-top:4px;">${tradeState.sessionTrades.filter(t=>t.pnl>0).length}W &middot; ${tradeState.sessionTrades.filter(t=>t.pnl<=0).length}L</div>
    </div>
    <div class="sc" style="border-top:2px solid ${(tradeState._consecutiveLosses||0) >= 2 ? '#ef4444' : '#4a6080'};">
      <div class="sc-label">Loss Streak</div>
      <div class="sc-val" id="ajax-lt-consec-losses" style="color:${(tradeState._consecutiveLosses||0) >= 2 ? '#ef4444' : '#fff'}">${tradeState._consecutiveLosses || 0} / 3</div>
      <div id="ajax-lt-cl-status" style="font-size:0.7rem;margin-top:4px;color:${tradeState._pauseUntilTime && Date.now() < tradeState._pauseUntilTime ? '#f59e0b' : '#4a6080'}">${tradeState._pauseUntilTime && Date.now() < tradeState._pauseUntilTime ? '⏸ PAUSED' : (tradeState._consecutiveLosses||0) >= 2 ? '⚠️ 1 more = pause' : '✅ OK'}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${tradeState._dailyLossHit ? '#ef4444' : '#10b981'};" id="ajax-lt-sc-dloss">
      <div class="sc-label">Daily Loss Limit</div>
      <div class="sc-val" style="color:${tradeState._dailyLossHit ? '#ef4444' : '#fff'}">${inr(-(process.env.MAX_DAILY_LOSS || 5000))}</div>
      <div id="ajax-lt-daily-loss-status" style="font-size:0.7rem;margin-top:4px;color:${tradeState._dailyLossHit ? '#ef4444' : '#10b981'}">${tradeState._dailyLossHit ? '🛑 KILLED — no entries' : '✅ Active'}</div>
    </div>
  </div>

  <div style="margin-bottom:24px;">
    <div class="section-title">Current Position</div>
    <div id="ajax-position-section">
      ${posHtml}
    </div>
  </div>

  ${tradeState.currentBar ? `
  <div style="margin-bottom:24px;">
    <div class="section-title">Current ${getTradeResolution()}-Min Bar (forming)</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
      ${["open","high","low","close"].map(k => `<div class="sc"><div class="sc-label">${k.toUpperCase()}</div><div class="sc-val" id="ajax-lt-bar-${k}" style="font-size:1rem;">${inr(tradeState.currentBar[k])}</div></div>`).join("")}
    </div>
  </div>` : `
  <div style="margin-bottom:24px;">
    <div class="section-title">Current ${getTradeResolution()}-Min Bar (forming)</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
      ${["open","high","low","close"].map(k => `<div class="sc"><div class="sc-label">${k.toUpperCase()}</div><div class="sc-val" id="ajax-lt-bar-${k}" style="font-size:1rem;">\u2014</div></div>`).join("")}
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
        <span style="color:#f59e0b;">── SL</span> &nbsp;
        <span style="color:#3b82f6;">-- Entry Price</span>
      </div>
    </div>
  </div>` : ""}

  <div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
      <div class="section-title" style="margin-bottom:0;">Session Trades Today</div>
      <select id="ltSide" onchange="ltFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All Sides</option><option value="CE">CE</option><option value="PE">PE</option>
      </select>
      <select id="ltResult" onchange="ltFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All</option><option value="win">Wins</option><option value="loss">Losses</option>
      </select>
      <select id="ltPerPage" onchange="ltFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="5">5/page</option><option value="10" selected>10/page</option><option value="25">25/page</option><option value="999999">All</option>
      </select>
      <span id="ltCount" style="font-size:0.72rem;color:#4a6080;"></span>
    </div>
    ${tradeState.sessionTrades.length === 0
      ? `<div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:16px 24px;color:#4a6080;font-size:0.82rem;">No completed trades this session.</div>`
      : `<div style="border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;margin-bottom:10px;">
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#0a0f1c;">
              <th onclick="ltSort('side')"  style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Side ▲▼</th>
              <th onclick="ltSort('entry')" style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Date ▲▼</th>
              <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry</th>
              <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry Time</th>
              <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit</th>
              <th onclick="ltSort('exit')"  style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Exit Time ▲▼</th>
              <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">SL</th>
              <th onclick="ltSort('pnl')"   style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">PnL ₹ ▲▼</th>
              <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry Reason</th>
              <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit Reason</th>
              <th style="padding:9px 12px;text-align:center;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Action</th>
            </tr></thead>
            <tbody id="ltBody" style="font-family:monospace;font-size:0.78rem;"></tbody>
          </table>
        </div>
        <div id="ltPag" style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;"></div>
        <!-- Trade Detail Modal -->
        <div id="ltModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
          <div style="background:#0d1320;border:1px solid #3a1a1a;border-radius:16px;padding:24px 28px;max-width:720px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.9);position:relative;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
              <div>
                <span id="ltm-badge" style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:4px 10px;border-radius:6px;"></span>
                <span style="font-size:0.65rem;color:#4a6080;margin-left:10px;">🔴 Live Trade — Full Details</span>
              </div>
              <button onclick="document.getElementById('ltModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:#4a6080;font-size:1rem;cursor:pointer;padding:4px 10px;border-radius:6px;font-family:inherit;" onmouseover="this.style.color='#ef4444';this.style.borderColor='#ef4444'" onmouseout="this.style.color='#4a6080';this.style.borderColor='#1a2236'">✕ Close</button>
            </div>
            <div id="ltm-grid"></div>
            <div id="ltm-reason" style="display:none;"></div>
          </div>
        </div>`}
    <div style="background:#0a0f1c;border:1px solid #1a2236;border-radius:8px;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
      <span style="font-size:0.75rem;color:#c8d8f0;font-weight:700;">Session P&L</span>
      <span style="font-size:1.1rem;font-weight:800;color:${tradeState.sessionPnl >= 0 ? "#10b981" : "#ef4444"};">${tradeState.sessionPnl >= 0 ? "+" : ""}₹${tradeState.sessionPnl.toFixed(2)}</span>
    </div>
    <script>
    const LT_ALL = ${JSON.stringify([...tradeState.sessionTrades].reverse().map(t => ({
      side:        t.side            || "",
      symbol:      t.symbol          || "",
      strike:      t.optionStrike    || "",
      expiry:      t.optionExpiry    || "",
      optionType:  t.optionType      || t.side || "",
      qty:         t.qty             || 0,
      entry:       t.entryTime       || "",
      exit:        t.exitTime        || "",
      eSpot:       t.spotAtEntry     || t.entryPrice || 0,
      eOpt:        t.optionEntryLtp  || null,
      eSl:         t.stopLoss        || null,
      xSpot:       t.spotAtExit      || t.exitPrice  || 0,
      xOpt:        t.optionExitLtp   || null,
      pnl:         typeof t.pnl === "number" ? t.pnl : null,
      pnlMode:     t.pnlMode         || "",
      order:       t.orderId         || "",
      reason:      t.exitReason      || "",
      entryReason: t.entryReason     || "",
    })))};
    function ltFmtDate(dt){ if(!dt) return '\u2014'; var p=dt.split(', '); var d=(p[0]||'').split('/'); if(d.length>=2) return d[0].padStart(2,'0')+'/'+d[1].padStart(2,'0')+(d[2]?'/'+d[2]:''); return p[0]||'\u2014'; }
    function ltFmtTime(dt){ if(!dt) return '\u2014'; var p=dt.split(', '); return p[1]||'\u2014'; }
    let ltFiltered=[...LT_ALL],ltSortCol='entry',ltSortDir=-1,ltPage=1,ltPP=10;
    function ltFilter(){
      const side=document.getElementById('ltSide').value;
      const res=document.getElementById('ltResult').value;
      ltPP=parseInt(document.getElementById('ltPerPage').value);
      ltPage=1;
      ltFiltered=LT_ALL.filter(t=>{
        if(side && t.side!==side) return false;
        if(res==='win'  && (t.pnl==null||t.pnl<0))  return false;
        if(res==='loss' && (t.pnl==null||t.pnl>=0)) return false;
        return true;
      });
      ltApplySort();
    }
    function ltSort(col){ltSortDir=ltSortCol===col?ltSortDir*-1:-1;ltSortCol=col;ltApplySort();}
    function ltApplySort(){
      ltFiltered.sort((a,b)=>{
        let av=a[ltSortCol],bv=b[ltSortCol];
        if(av==null)av=ltSortDir===-1?-Infinity:Infinity;
        if(bv==null)bv=ltSortDir===-1?-Infinity:Infinity;
        return typeof av==='string'?av.localeCompare(bv)*ltSortDir:(av-bv)*ltSortDir;
      });
      ltRender();
    }
    const ltFmt=n=>n!=null?'\u20b9'+Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
    function ltRender(){
      const el=document.getElementById('ltBody');
      const cnt=document.getElementById('ltCount');
      if(!el){return;}
      cnt.textContent=ltFiltered.length+'/'+LT_ALL.length+' trades';
      const start=(ltPage-1)*ltPP,slice=ltFiltered.slice(start,start+ltPP);
      // Store slice globally for eye button access
      window._ltSlice = slice;
      el.innerHTML=slice.length===0
        ?'<tr><td colspan="11" style="text-align:center;padding:20px;color:#4a6080;">No trades match filters.</td></tr>'
        :slice.map((t,i)=>{
          const sc=t.side==='CE'?'#10b981':'#ef4444';
          const pc=t.pnl==null?'#c8d8f0':t.pnl>=0?'#10b981':'#ef4444';
          const short=t.reason.length>35?t.reason.slice(0,35)+'\u2026':t.reason;
          return \`<tr style="border-top:1px solid #1a2236;vertical-align:top;">
            <td style="padding:8px 12px;color:\${sc};font-weight:800;">\${t.side||'\u2014'}</td>
            <td style="padding:8px 12px;font-size:0.75rem;">\${ltFmtDate(t.entry)}</td>
            <td style="padding:8px 12px;font-weight:700;">\${ltFmt(t.eSpot)}</td>
            <td style="padding:8px 12px;font-size:0.75rem;">\${ltFmtTime(t.entry)}</td>
            <td style="padding:8px 12px;font-weight:700;">\${ltFmt(t.xSpot)}</td>
            <td style="padding:8px 12px;font-size:0.75rem;">\${ltFmtTime(t.exit)}</td>
            <td style="padding:8px 12px;color:#f59e0b;">\${t.eSl?ltFmt(t.eSl):'\u2014'}</td>
            <td style="padding:8px 12px;"><div style="font-size:1rem;font-weight:800;color:\${pc};">\${t.pnl!=null?(t.pnl>=0?'+':'')+ltFmt(t.pnl):'\u2014'}</div></td>
            <td style="padding:8px 12px;font-size:0.7rem;color:#4a6080;" title="\${t.entryReason||''}">\${t.entryReason?(t.entryReason.length>25?t.entryReason.slice(0,25)+'\u2026':t.entryReason):'\u2014'}</td>
            <td style="padding:8px 12px;font-size:0.7rem;color:#4a6080;" title="\${t.reason}">\${short||'\u2014'}</td>
            <td style="padding:6px 8px;text-align:center;"><button data-idx="\${i}" class="lt-eye-btn" style="background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;" title="View full details">\uD83D\uDC41</button></td>
          </tr>\`;
        }).join('');
      // Eye button click handlers
      Array.from(el.querySelectorAll('.lt-eye-btn')).forEach(function(btn){
        btn.addEventListener('click',function(){ showLTModal(window._ltSlice[parseInt(this.getAttribute('data-idx'))]); });
        btn.addEventListener('mouseover',function(){ this.style.borderColor='#3b82f6';this.style.background='#0a1e3d'; });
        btn.addEventListener('mouseout', function(){ this.style.borderColor='#1a2236';this.style.background='none'; });
      });
      const pagEl=document.getElementById('ltPag');
      if(!pagEl) return;
      const total=Math.ceil(ltFiltered.length/ltPP);
      if(total<=1){pagEl.innerHTML='';return;}
      pagEl.innerHTML=
        \`<button onclick="ltGo(\${ltPage-1})" \${ltPage===1?'disabled':''} style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">\u2190 Prev</button>\`+
        Array.from({length:total},(_,i)=>i+1).filter(p=>Math.abs(p-ltPage)<=2).map(p=>
          \`<button onclick="ltGo(\${p})" style="background:\${p===ltPage?'#0a1e3d':'#0d1320'};border:1px solid \${p===ltPage?'#1d3b6e':'#1a2236'};color:\${p===ltPage?'#3b82f6':'#c8d8f0'};padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">\${p}</button>\`).join('')+
        \`<button onclick="ltGo(\${ltPage+1})" \${ltPage===total?'disabled':''} style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">Next \u2192</button>\`;
    }
    function ltGo(p){ltPage=Math.max(1,Math.min(Math.ceil(ltFiltered.length/ltPP),p));ltRender();}
    if(LT_ALL.length>0) ltFilter();

    // ── Trade Detail Modal ────────────────────────────────────────────────
    function showLTModal(t){
      const pc  = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
      const sc  = t.side === 'CE' ? '#10b981' : '#ef4444';
      const fmt = n => n != null && n !== 0 ? '₹' + Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
      const optDiff = (t.eOpt != null && t.xOpt != null) ? parseFloat((t.xOpt - t.eOpt).toFixed(2)) : null;
      const dc  = optDiff == null ? '#c8d8f0' : optDiff >= 0 ? '#10b981' : '#ef4444';
      const pnlPts = (t.eSpot && t.xSpot && t.side) ? parseFloat(((t.side==='PE' ? t.eSpot - t.xSpot : t.xSpot - t.eSpot)).toFixed(2)) : null;

      const badge = document.getElementById('ltm-badge');
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

      const contractHtml = '<div style="background:#06100e;border:1px solid #0d3020;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
        + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a6040;margin-bottom:8px;font-weight:700;">📋 Option Contract</div>'
        + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
        + cell('Symbol', t.symbol || '—', '#a0f0c0')
        + cell('Strike', t.strike || '—', '#fff')
        + cell('Expiry', t.expiry || '—', '#f59e0b')
        + cell('Option Type', t.optionType || t.side || '—', sc)
        + cell('Qty / Lots', t.qty ? t.qty + ' qty' : '—', '#c8d8f0')
        + cell('Order ID', t.order || '—', '#a78bfa')
        + '</div></div>';

      const entryHtml = '<div style="background:#060c18;border:1px solid #0d2040;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
        + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a4080;margin-bottom:8px;font-weight:700;">🟢 Entry</div>'
        + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
        + cell('Entry Time', t.entry || '—', '#c8d8f0')
        + cell('NIFTY Spot @ Entry', fmt(t.eSpot), '#fff', 'Index price at entry')
        + cell('Option LTP @ Entry', fmt(t.eOpt), '#60a5fa', 'Option premium paid')
        + cell('Initial Stop Loss', fmt(t.eSl), '#f59e0b', 'NIFTY spot SL level')
        + cell('SL Distance', (t.eSl && t.eSpot) ? Math.abs(t.eSpot - t.eSl).toFixed(2) + ' pts' : '—', '#f59e0b', 'pts from entry to SL')
        + cell('Entry Signal', t.entryReason || '—', '#a0b8d0', 'Strategy signal that triggered entry')
        + cell('PnL Mode', t.pnlMode || 'spot-diff', '#8b8bf0')
        + '</div></div>';

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

      const reasonHtml = '<div style="background:#060910;border:1px solid #1a2236;border-radius:10px;padding:12px 14px;">'
        + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#3a5070;margin-bottom:6px;font-weight:700;">📌 Exit Reason</div>'
        + '<div style="font-size:0.82rem;color:#a0b8d0;line-height:1.6;font-family:monospace;">' + (t.reason || '—') + '</div>'
        + '</div>';

      document.getElementById('ltm-grid').innerHTML = contractHtml + entryHtml + exitHtml + reasonHtml;
      document.getElementById('ltm-reason').style.display = 'none';
      const m = document.getElementById('ltModal');
      m.style.display = 'flex';
    }
    document.getElementById('ltModal').addEventListener('click',function(e){if(e.target===this)this.style.display='none';});
    </script>
  </div>

  <!-- ── Activity Log (mirrors paperTrade) ───────────────────────────────── -->
  <div style="margin-top:8px;">
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
        <option value="🛑">🛑 SL Hits</option>
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

  <p style="font-size:0.72rem;color:#4a6080;margin-top:16px;">🔄 Auto-refreshes every 2 seconds while trading is active</p>
</div>

<script id="lt-log-data" type="application/json">${logsJSON}</script>
<script>
var LOG_ALL = JSON.parse(document.getElementById('lt-log-data').textContent);
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
    var c = l.indexOf('❌')>=0?'#ef4444':l.indexOf('✅')>=0?'#10b981':l.indexOf('🚨')>=0||l.indexOf('🛑')>=0?'#f59e0b':l.indexOf('🎯')>=0||l.indexOf('⚡')>=0?'#3b82f6':'#4a6080';
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
<script>
${modalJS()}
function ltShowToast(msg, color) {
  var t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#0d1320;border:1px solid '+color+';color:'+color+';padding:12px 24px;border-radius:10px;font-size:0.85rem;font-weight:700;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,0.6);letter-spacing:0.5px;';
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 3500);
}
async function ltHandleExit(btn) {
  if (btn) { btn.textContent = '⏳ Exiting...'; btn.disabled = true; }
  try {
    var res = await secretFetch('/swing-live/exit');
    if (!res) { if (btn) { btn.textContent = '🚪 Exit Trade'; btn.disabled = false; } return; }
    var data = await res.json();
    if (!data.success) {
      ltShowToast('❌ ' + (data.error || 'Exit failed'), '#ef4444');
      if (btn) { btn.textContent = '🚪 Exit Trade'; btn.disabled = false; }
      return;
    }
    ltShowToast('🚪 Position exited via Zerodha!', '#f59e0b');
    setTimeout(function(){ location.reload(); }, 1200);
  } catch(e) {
    ltShowToast('❌ ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '🚪 Exit Trade'; btn.disabled = false; }
  }
}
async function ltHandleStart(btn) {
  if (btn) { btn.textContent = '⏳ Starting...'; btn.disabled = true; }
  try {
    var res = await secretFetch('/swing-live/start');
    if (!res) { if (btn) { btn.textContent = '▶ Start'; btn.disabled = false; } return; }
    var data = await res.json();
    if (!data.success) {
      ltShowToast('❌ ' + (data.error || 'Failed to start'), '#ef4444');
      if (btn) { btn.textContent = '▶ Start'; btn.disabled = false; }
      return;
    }
    ltShowToast('🔴 Live trading started!', '#10b981');
    setTimeout(function(){ location.reload(); }, 1200);
  } catch(e) {
    ltShowToast('❌ ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '▶ Start'; btn.disabled = false; }
  }
}
async function ltHandleStop(btn) {
  if (btn) { btn.textContent = '⏳ Stopping...'; btn.disabled = true; }
  try {
    var res = await secretFetch('/swing-live/stop');
    if (!res) { if (btn) { btn.textContent = '■ Stop'; btn.disabled = false; } return; }
    var data = await res.json();
    ltShowToast('⏹ Live trading stopped.', '#ef4444');
    setTimeout(function(){ location.reload(); }, 1200);
  } catch(e) {
    ltShowToast('❌ ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '■ Stop'; btn.disabled = false; }
  }
}
async function ltHandleReset(btn) {
  var ok = await showConfirm({
    icon: '⚠️', title: 'Reset Swing Live History',
    message: 'Wipe ALL swing LIVE trade history?\\nClears recorded sessions on this server. Does NOT touch real broker orders.\\nCannot be undone.',
    confirmText: 'Reset History', confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  if (btn) { btn.textContent = '⏳...'; btn.disabled = true; }
  try {
    var res = await secretFetch('/swing-live/reset', { method: 'POST' });
    if (!res) { if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; } return; }
    var data;
    try { data = await res.json(); } catch(_) { data = { success: false, error: 'Server error (status ' + res.status + ')' }; }
    if (!data.success) {
      ltShowToast('❌ ' + (data.error || 'Reset failed'), '#ef4444');
      if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; }
      return;
    }
    ltShowToast('✅ ' + data.message, '#10b981');
    setTimeout(function(){ location.reload(); }, 1200);
  } catch(e) {
    ltShowToast('❌ ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; }
  }
}
async function manualEntry(side) {
  if (!confirm('⚠️ LIVE TRADE: Manual ' + side + ' entry with REAL money. Confirm?')) return;
  try {
    var res = await secretFetch('/swing-live/manualEntry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side: side })
    });
    if (!res) return;
    var data = await res.json();
    if (data.success) {
      ltShowToast('✅ LIVE Manual ' + side + ' @ ₹' + data.spot + ' | OrderID: ' + (data.orderId || '?'), '#10b981');
      setTimeout(function(){ location.reload(); }, 1500);
    } else {
      ltShowToast('❌ ' + (data.error || 'Entry failed'), '#ef4444');
    }
  } catch(e) {
    ltShowToast('❌ ' + e.message, '#ef4444');
  }
}
</script>
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
    upColor: '#10b981', downColor: '#ef4444',
    borderUpColor: '#10b981', borderDownColor: '#ef4444',
    wickUpColor: '#10b981', wickDownColor: '#ef4444',
  });

  let slLine = null;
  let entryLine = null;
  let _lastCandleCount = 0;

  async function fetchChart() {
    try {
      const res = await fetch('/swing-live/status/chart-data', { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();
      if (!d.candles || d.candles.length === 0) return;

      if (Math.abs(d.candles.length - _lastCandleCount) > 1 || _lastCandleCount === 0) {
        candleSeries.setData(d.candles.map(function(c) {
          return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
        }));
      } else if (d.candles.length > 0) {
        var last = d.candles[d.candles.length - 1];
        candleSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
      }
      _lastCandleCount = d.candles.length;

      if (d.markers && d.markers.length > 0) {
        var sorted = d.markers.slice().sort(function(a, b) { return a.time - b.time; });
        candleSeries.setMarkers(sorted.map(function(m) {
          return { time: m.time, position: m.position, color: m.color, shape: m.shape, text: m.text };
        }));
      } else {
        candleSeries.setMarkers([]);
      }

      if (slLine) { candleSeries.removePriceLine(slLine); slLine = null; }
      if (d.stopLoss) {
        slLine = candleSeries.createPriceLine({
          price: d.stopLoss, color: '#f59e0b', lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true, title: 'SL',
        });
      }

      if (entryLine) { candleSeries.removePriceLine(entryLine); entryLine = null; }
      if (d.entryPrice) {
        entryLine = candleSeries.createPriceLine({
          price: d.entryPrice, color: '#3b82f6', lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dotted,
          axisLabelVisible: true, title: 'Entry',
        });
      }
    } catch (e) {
      console.warn('[Chart] fetch error:', e.message);
    }
  }

  fetchChart();
  if (${tradeState.running}) {
    setInterval(fetchChart, 4000);
  }

  window.addEventListener('resize', function() {
    chart.applyOptions({ width: container.clientWidth });
  });
})();
</script>
<script>
// ── AJAX live refresh — replaces meta http-equiv="refresh" ──────────────────
(function() {
  const INR = n => typeof n === 'number'
    ? '\u20b9' + n.toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2})
    : '\u2014';
  const PNL_COLOR = n => n >= 0 ? '#10b981' : '#ef4444';

  let _interval   = null;
  let _lastTradeCount  = ${tradeState.sessionTrades.length};
  let _lastRunning     = ${tradeState.running};
  let _lastLogCount    = ${tradeState.log.length};
  let _lastHasPosition = ${tradeState.position ? "true" : "false"};  // track position open/close

  async function fetchAndUpdate() {
    try {
      const res = await fetch('/swing-live/status/data', { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();

      // ── Stat cards ────────────────────────────────────────────────────────
      const pnlEl = document.getElementById('ajax-lt-session-pnl');
      if (pnlEl) {
        pnlEl.textContent = INR(d.sessionPnl);
        pnlEl.style.color = PNL_COLOR(d.sessionPnl);
        const card = pnlEl.closest('.sc');
        if (card) card.style.borderTopColor = PNL_COLOR(d.sessionPnl);
      }
      const tcEl = document.getElementById('ajax-lt-trade-count');
      if (tcEl) tcEl.textContent = d.tradeCount;
      const wlEl = document.getElementById('ajax-lt-wl');
      if (wlEl) wlEl.textContent = d.wins + 'W \u00b7 ' + d.losses + 'L';

      const clEl = document.getElementById('ajax-lt-consec-losses');
      if (clEl) {
        clEl.textContent = (d.consecutiveLosses || 0) + ' / 3';
        clEl.style.color = d.consecutiveLosses >= 2 ? '#ef4444' : '#fff';
        const card = clEl.closest('.sc');
        if (card) card.style.borderTopColor = d.consecutiveLosses >= 2 ? '#ef4444' : '#4a6080';
      }
      const clStatus = document.getElementById('ajax-lt-cl-status');
      if (clStatus) {
        const paused = d.pauseUntilTime && Date.now() < d.pauseUntilTime;
        clStatus.textContent = paused ? '\u23f8 PAUSED' : d.consecutiveLosses >= 2 ? '\u26a0\ufe0f 1 more = pause' : '\u2705 OK';
        clStatus.style.color = paused ? '#f59e0b' : '#4a6080';
      }

      // Daily loss kill switch card
      const ltDlCard = document.getElementById('ajax-lt-sc-dloss');
      const ltDlStatus = document.getElementById('ajax-lt-daily-loss-status');
      if (ltDlCard) ltDlCard.style.borderTopColor = d.dailyLossHit ? '#ef4444' : '#10b981';
      if (ltDlStatus) {
        ltDlStatus.textContent = d.dailyLossHit ? '\uD83D\uDED1 KILLED \u2014 no entries' : '\u2705 Active';
        ltDlStatus.style.color = d.dailyLossHit ? '#ef4444' : '#10b981';
      }

      const candleEl = document.getElementById('ajax-lt-candle-count');
      if (candleEl) {
        candleEl.textContent = d.candleCount;
        const sub = document.getElementById('ajax-lt-candle-status');
        if (sub) {
          sub.textContent = d.candleCount >= 30 ? '\u2705 Strategy ready' : '\u26a0\ufe0f Warming up...';
          sub.style.color = d.candleCount >= 30 ? '#10b981' : '#f59e0b';
        }
      }

      const tickEl = document.getElementById('ajax-lt-tick-count');
      if (tickEl) tickEl.textContent = (d.tickCount || 0).toLocaleString();
      const ltpEl = document.getElementById('ajax-lt-last-tick');
      if (ltpEl) ltpEl.textContent = d.lastTickPrice ? INR(d.lastTickPrice) : '\u2014';

      const phEl = document.getElementById('ajax-lt-prev-high');
      if (phEl) phEl.textContent = d.prevCandleHigh ? INR(d.prevCandleHigh) : '\u2014';
      const plEl = document.getElementById('ajax-lt-prev-low');
      if (plEl) plEl.textContent = d.prevCandleLow ? INR(d.prevCandleLow) : '\u2014';

      // ── Position section ─────────────────────────────────────────────────
      // If position state changed (flat→open or open→flat), reload page to render
      // the full position block HTML correctly. AJAX only patches existing elements.
      const nowHasPosition = !!d.position;
      if (nowHasPosition !== _lastHasPosition) {
        _lastHasPosition = nowHasPosition;
        window.location.reload();
        return;
      }
      if (d.position) {
        const p = d.position;
        const entEl = document.getElementById('ajax-lt-opt-entry-ltp');
        if (entEl) {
          entEl.textContent = p.optionEntryLtp ? '\u20b9' + p.optionEntryLtp.toFixed(2) : 'Fetching...';
          entEl.style.color = p.optionEntryLtp ? '#60a5fa' : '#f59e0b';
        }
        const curEl = document.getElementById('ajax-lt-opt-current-ltp');
        if (curEl) {
          curEl.textContent = p.optionCurrentLtp ? '\u20b9' + p.optionCurrentLtp.toFixed(2) : '\u23f3';
          if (p.optionEntryLtp && p.optionCurrentLtp) {
            curEl.style.color = p.optionCurrentLtp >= p.optionEntryLtp ? '#10b981' : '#ef4444';
          }
        }
        const movEl = document.getElementById('ajax-lt-opt-move');
        if (movEl && p.optPremiumMove !== null) {
          movEl.textContent = (p.optPremiumMove >= 0 ? '\u25b2 +' : '\u25bc ') + '\u20b9' + Math.abs(p.optPremiumMove).toFixed(2) + ' pts';
          movEl.style.color = p.optPremiumMove >= 0 ? '#10b981' : '#ef4444';
        }
        // % change on option premium
        const pctEl = document.getElementById('ajax-lt-opt-pct');
        if (pctEl) {
          if (p.optPremiumPct !== null && p.optPremiumPct !== undefined) {
            pctEl.textContent = (p.optPremiumPct >= 0 ? '+' : '') + p.optPremiumPct.toFixed(2) + '%';
            pctEl.style.color = p.optPremiumPct >= 0 ? '#10b981' : '#ef4444';
          } else {
            pctEl.textContent = '\u2014';
          }
        }
        // Option SL price
        const optSlEl = document.getElementById('ajax-lt-opt-sl');
        if (optSlEl) {
          optSlEl.textContent = p.optStopPrice ? '\u20b9' + p.optStopPrice.toFixed(2) : '\u2014';
        }
        const optPnlEl = document.getElementById('ajax-lt-opt-pnl');
        if (optPnlEl && p.optPremiumPnl !== null) {
          optPnlEl.textContent = (p.optPremiumPnl >= 0 ? '+' : '') + INR(p.optPremiumPnl);
          optPnlEl.style.color = PNL_COLOR(p.optPremiumPnl);
        }
        // NIFTY LTP — use lastTickPrice (live every tick) over currentBar.close
        const ltpLiveEl = document.getElementById('ajax-lt-nifty-ltp');
        const ltpNow = d.lastTickPrice || p.liveClose;
        if (ltpLiveEl && ltpNow !== null) {
          ltpLiveEl.textContent = INR(ltpNow);
          const sub = document.getElementById('ajax-lt-nifty-move');
          if (sub && p.entryPrice) {
            const moved = parseFloat(((ltpNow - p.entryPrice) * (p.side === 'CE' ? 1 : -1)).toFixed(1));
            sub.textContent = (moved >= 0 ? '\u25b2' : '\u25bc') + ' ' + Math.abs(moved).toFixed(1) + ' pts';
            sub.style.color = moved >= 0 ? '#10b981' : '#ef4444';
          }
        }
        const slEl = document.getElementById('ajax-lt-stop-loss');
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
          const el = document.getElementById('ajax-lt-bar-' + k);
          if (el) el.textContent = INR(d.currentBar[k]);
        });
      }

      // ── Trades table ──────────────────────────────────────────────────────
      if (d.trades && d.tradeCount !== _lastTradeCount) {
        _lastTradeCount = d.tradeCount;
        if (typeof LT_ALL !== 'undefined') {
          LT_ALL.length = 0;
          d.trades.forEach(function(t){ LT_ALL.push(t); });
        } else {
          window.LT_ALL = d.trades.slice();
        }
        ltFiltered = [...LT_ALL];
        ltFilter();
      }

      // ── Activity log ──────────────────────────────────────────────────────
      if (d.logs && d.logTotal !== _lastLogCount) {
        _lastLogCount = d.logTotal;
        if (typeof LOG_ALL !== 'undefined') {
          LOG_ALL.length = 0;
          d.logs.forEach(function(l){ LOG_ALL.push(l); });
          logFilter();
        }
      }

      // ── Detect stop ───────────────────────────────────────────────────────
      if (_lastRunning && !d.running) {
        _lastRunning = false;
        clearInterval(_interval);
        _interval = null;
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (e) {
      console.warn('[AJAX refresh] fetch error:', e.message);
    }
  }

  if (${tradeState.running}) {
    _interval = setInterval(fetchAndUpdate, 2000);
  }
})();
</script>
</div></div></body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
  } catch (err) {
    console.error("[trade/status] Error:", err.message, err.stack);
    return res.status(500).send(`<pre style="color:red;padding:32px;font-family:monospace;">Live Trade Status Error: ${err.message}\n\n${err.stack}</pre>`);
  }
});

/**
 * POST /swing-live/reset
 * Wipe all swing LIVE trade history (clears live_trades.json sessions).
 * Refuses when a live session is running. Does NOT touch real broker orders.
 */
router.post("/reset", (req, res) => {
  if (tradeState.running) {
    return res.status(400).json({
      success: false,
      error: "Stop swing live trading first before resetting history.",
    });
  }
  try {
    ensureLiveDir();
    fs.writeFileSync(LT_FILE, JSON.stringify({ sessions: [] }, null, 2));
    log("🔄 [LIVE] Swing live trade history cleared.");
    return res.json({ success: true, message: "Swing live trade history cleared." });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
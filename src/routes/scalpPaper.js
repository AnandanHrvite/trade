/**
 * SCALP PAPER TRADE — /scalp-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses LIVE market data (Fyers WebSocket) but SIMULATES orders locally.
 * Runs on 3-min candles with the scalp BB+RSI+PSAR strategy.
 * Can run IN PARALLEL with /trade (live) or /paperTrade (paper).
 *
 * Routes:
 *   GET /scalp-paper/start   → Start scalp paper trading
 *   GET /scalp-paper/stop    → Stop session
 *   GET /scalp-paper/status  → Live status page
 *   GET /scalp-paper/exit    → Manual exit current position
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const scalpStrategy = require("../strategies/scalp_bb_cpr");
const instrumentConfig = require("../config/instrument");
const { getSymbol, getLotQty, validateAndGetOptionSymbol } = instrumentConfig;
const sharedSocketState = require("../utils/sharedSocketState");
const socketManager = require("../utils/socketManager");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const fyers = require("../config/fyers");
const { notifyEntry, notifyExit, sendTelegram, isConfigured } = require("../utils/notify");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID = "SCALP_PAPER";

// ── Module-level config (read once at module load) ────────────────────────────
const SCALP_RES            = parseInt(process.env.SCALP_RESOLUTION || "3", 10);
const _SCALP_MAX_TRADES    = parseInt(process.env.SCALP_MAX_DAILY_TRADES || "30", 10);
const _SCALP_MAX_LOSS      = parseFloat(process.env.SCALP_MAX_DAILY_LOSS || "2000");
const _SCALP_PAUSE_CANDLES = parseInt(process.env.SCALP_SL_PAUSE_CANDLES || "2", 10);
const _SCALP_TRAIL_START   = parseFloat(process.env.SCALP_TRAIL_START || "300");
const _SCALP_TRAIL_STEP    = parseFloat(process.env.SCALP_TRAIL_STEP || "200");

// ── Previous day OHLC for CPR (fetched on session start) ────────────────────
let _prevDayOHLC     = null;  // { high, low, close }
let _prevPrevDayOHLC = null;  // for Inside Value CPR check

const _STOP_MINS = (() => {
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
})();
const _ENTRY_STOP_MINS = _STOP_MINS - 10;

function getISTMinutes() {
  const istSec = Math.floor(Date.now() / 1000) + 19800;
  return Math.floor(istSec / 60) % 1440;
}

// ── Persistence ──────────────────────────────────────────────────────────────
const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const SP_FILE  = path.join(DATA_DIR, "scalp_paper_trades.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadScalpData() {
  ensureDir();
  if (!fs.existsSync(SP_FILE)) {
    const initial = { capital: 100000, totalPnl: 0, sessions: [] };
    fs.writeFileSync(SP_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try { return JSON.parse(fs.readFileSync(SP_FILE, "utf-8")); }
  catch (_) { return { capital: 100000, totalPnl: 0, sessions: [] }; }
}

function saveScalpData(data) {
  ensureDir();
  const tmp = SP_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, SP_FILE);
}

// ── State ────────────────────────────────────────────────────────────────────
let state = {
  running:        false,
  position:       null,
  candles:        [],
  currentBar:     null,
  barStartTime:   null,
  log:            [],
  sessionTrades:  [],
  sessionStart:   null,
  sessionPnl:     0,
  tickCount:      0,
  lastTickTime:   null,
  lastTickPrice:  null,
  optionLtp:      null,
  optionSymbol:   null,
  _slPauseUntil:  null,
  _dailyLossHit:  false,
};

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function log(msg) {
  const entry = `[${istNow()}] ${msg}`;
  console.log(entry);
  state.log.push(entry);
  if (state.log.length > 2000) state.log.shift();
}

function getBucketStart(unixMs) {
  const d = new Date(unixMs);
  d.setMinutes(Math.floor(d.getMinutes() / SCALP_RES) * SCALP_RES, 0, 0);
  return d.getTime();
}

function isMarketHours() {
  const total = getISTMinutes();
  return total >= 555 && total < _ENTRY_STOP_MINS; // 9:15 to stop-10min
}

function isStartAllowed() {
  return getISTMinutes() < _STOP_MINS;
}

// ── Option LTP polling ──────────────────────────────────────────────────────
let _optionPollTimer = null;

async function fetchOptionLtp(symbol) {
  try {
    const response = await fyers.getQuotes([symbol]);
    if (response.s === "ok" && response.d && response.d.length > 0) {
      const v = response.d[0].v || response.d[0];
      const ltp = v.lp || v.ltp || v.last_price || v.last_traded_price || v.close_price;
      if (ltp && ltp > 0) return parseFloat(ltp);
    }
  } catch (_) {}
  return null;
}

function startOptionPolling(symbol) {
  stopOptionPolling();
  function scheduleNext() {
    if (!_optionPollTimer) return;
    _optionPollTimer = setTimeout(async () => {
      if (!state.position || !state.optionSymbol) { stopOptionPolling(); return; }
      const ltp = await fetchOptionLtp(symbol);
      if (ltp && state.position) {
        state.optionLtp = ltp;
        state.position.optionCurrentLtp = ltp;
        if (!state.position.optionEntryLtp) {
          state.position.optionEntryLtp = ltp;
          log(`📌 [SCALP-PAPER] Option entry LTP: ₹${ltp}`);
        }
      }
      scheduleNext();
    }, 3000); // 3s for scalp paper (less aggressive than live)
  }
  fetchOptionLtp(symbol).then(ltp => {
    if (ltp && state.position) {
      state.optionLtp = ltp;
      state.position.optionCurrentLtp = ltp;
      if (!state.position.optionEntryLtp) state.position.optionEntryLtp = ltp;
    }
    scheduleNext();
  });
  _optionPollTimer = true;
}

function stopOptionPolling() {
  if (_optionPollTimer && _optionPollTimer !== true) clearTimeout(_optionPollTimer);
  _optionPollTimer = null;
}

// ── Parse option details from symbol ────────────────────────────────────────
const MONTH_NAMES = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MONTH_CODE_MAP = { "1":0,"2":1,"3":2,"4":3,"5":4,"6":5,"7":6,"8":7,"9":8,"O":9,"N":10,"D":11 };

function parseOptionDetails(symbol) {
  try {
    const mA = symbol.match(/NSE:NIFTY(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$/);
    if (mA) {
      const monthIdx = MONTH_CODE_MAP[mA[2]];
      return { expiry: `${mA[3]} ${MONTH_NAMES[monthIdx]} 20${mA[1]}`, strike: parseInt(mA[4], 10), optionType: mA[5] };
    }
    const mC = symbol.match(/NSE:NIFTY(\d{2})([A-Z]{3})(\d+)(CE|PE)$/);
    if (mC && parseInt(mC[3], 10) >= 10000) {
      return { expiry: `${mC[2]} 20${mC[1]}`, strike: parseInt(mC[3], 10), optionType: mC[4] };
    }
    const mB = symbol.match(/NSE:NIFTY(\d{2}[A-Z]{3}\d{2})(\d+)(CE|PE)$/);
    if (mB) {
      const raw = mB[1]; return { expiry: `${raw.slice(5,7)} ${raw.slice(2,5)} 20${raw.slice(0,2)}`, strike: parseInt(mB[2], 10), optionType: mB[3] };
    }
  } catch (_) {}
  return null;
}

// ── Simulated Buy/Sell ──────────────────────────────────────────────────────

function simulateBuy(symbol, side, qty, price, reason, stopLoss, target, spotAtEntry) {
  if (state.position) return;

  const optDetails = parseOptionDetails(symbol);
  state.position = {
    side,
    symbol,
    qty,
    entryPrice:       price,
    spotAtEntry:      spotAtEntry || price,
    entryTime:        istNow(),
    reason,
    stopLoss,
    initialStopLoss:  stopLoss,
    target,
    bestPrice:        null,
    candlesHeld:      0,
    peakPnl:          0,

    entryBarTime:     state.currentBar ? state.currentBar.time : null,
    optionEntryLtp:   null,
    optionCurrentLtp: null,
    optionStrike:     optDetails?.strike     || null,
    optionExpiry:     optDetails?.expiry     || null,
    optionType:       optDetails?.optionType || side,
  };

  state.optionSymbol = symbol;
  if (instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES") {
    startOptionPolling(symbol);
  }

  log(`📝 [SCALP-PAPER] BUY ${qty} × ${symbol} @ ₹${price} | SL: ₹${stopLoss} | PSAR trail | ${reason}`);

  notifyEntry({
    mode: "SCALP-PAPER",
    side, symbol, spotAtEntry: price,
    optionEntryLtp: null,
    stopLoss, qty, reason,
  });
}

function simulateSell(exitPrice, reason, spotAtExit) {
  if (!state.position) return;

  const { side, symbol, qty, entryPrice, entryTime, spotAtEntry,
          optionEntryLtp, optionCurrentLtp } = state.position;
  const isFutures = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const exitOptionLtp = state.optionLtp || optionCurrentLtp;

  let rawPnl, pnlMode;
  if (isFutures) {
    rawPnl  = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
    pnlMode = "futures";
  } else if (optionEntryLtp && exitOptionLtp) {
    rawPnl  = (exitOptionLtp - optionEntryLtp) * qty;
    pnlMode = `option: ₹${optionEntryLtp} → ₹${exitOptionLtp}`;
  } else {
    rawPnl  = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
    pnlMode = "spot proxy";
  }

  const brokerage = isFutures ? 40 : 80;
  const netPnl    = parseFloat((rawPnl - brokerage).toFixed(2));
  const emoji     = netPnl >= 0 ? "✅" : "❌";

  log(`${emoji} [SCALP-PAPER] Exit: ${reason} | PnL: ₹${netPnl}`);

  state.sessionTrades.push({
    side, symbol, qty, entryPrice, exitPrice,
    spotAtEntry: spotAtEntry || entryPrice,
    spotAtExit: spotAtExit || exitPrice,
    optionEntryLtp: optionEntryLtp || null,
    optionExitLtp: exitOptionLtp || null,
    optionStrike: state.position.optionStrike || null,
    optionExpiry: state.position.optionExpiry || null,
    optionType: state.position.optionType || side,
    stopLoss: state.position.initialStopLoss || null,
    entryReason: state.position.reason || "",
    entryTime, exitTime: istNow(),
    pnl: netPnl, pnlMode, exitReason: reason,
  });

  state.sessionPnl = parseFloat((state.sessionPnl + netPnl).toFixed(2));

  stopOptionPolling();
  state.optionSymbol = null;
  state.optionLtp    = null;

  // SL pause
  if (reason.includes("SL")) {
    state._slPauseUntil = Date.now() + (_SCALP_PAUSE_CANDLES * SCALP_RES * 60 * 1000);
    log(`⏸️ [SCALP-PAPER] SL pause — no entries for ${_SCALP_PAUSE_CANDLES} candles`);
  }

  // Daily loss kill
  if (state.sessionPnl <= -_SCALP_MAX_LOSS) {
    state._dailyLossHit = true;
    log(`🚨 [SCALP-PAPER] Daily loss limit hit (₹${state.sessionPnl} <= -₹${_SCALP_MAX_LOSS}) — no more entries today`);
  }

  state.position = null;

  notifyExit({
    mode: "SCALP-PAPER",
    side, symbol,
    spotAtEntry: spotAtEntry || entryPrice,
    spotAtExit: spotAtExit || exitPrice,
    optionEntryLtp: optionEntryLtp || null,
    optionExitLtp: exitOptionLtp || null,
    pnl: netPnl,
    sessionPnl: state.sessionPnl,
    exitReason: reason,
    entryTime,
    exitTime: istNow(),
    qty,
  });
}

// ── onTick — processes each WebSocket tick ───────────────────────────────────

function onTick(tick) {
  if (!state.running) return;
  const price = tick.ltp;
  if (!price || price <= 0) return;

  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  // ── Build 3-min candle ─────────────────────────────────────────────────────
  const tickMs    = Date.now();
  const bucketMs  = getBucketStart(tickMs);

  if (!state.currentBar || state.barStartTime !== bucketMs) {
    // Close previous bar
    if (state.currentBar) {
      state.candles.push({ ...state.currentBar });
      if (state.candles.length > 200) state.candles.shift();
      onCandleClose(state.currentBar);
    }
    // Start new bar
    state.currentBar  = { time: Math.floor(bucketMs / 1000), open: price, high: price, low: price, close: price };
    state.barStartTime = bucketMs;
  } else {
    state.currentBar.high  = Math.max(state.currentBar.high, price);
    state.currentBar.low   = Math.min(state.currentBar.low, price);
    state.currentBar.close = price;
  }

  // ── Tick-level exit checks (while in position) ─────────────────────────────
  if (state.position) {
    const pos = state.position;
    const isFut = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
    const _brok = isFut ? 40 : 80;

    // Running PNL helper (₹)
    const _tickPnl = (spotPrice) => {
      if (!isFut && pos.optionEntryLtp && state.optionLtp) {
        return (state.optionLtp - pos.optionEntryLtp) * (pos.qty || getLotQty()) - _brok;
      }
      return (spotPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * (pos.qty || getLotQty()) - _brok;
    };

    const curPnl = _tickPnl(price);

    // Track peak PNL
    if (!pos.peakPnl || curPnl > pos.peakPnl) pos.peakPnl = curPnl;

    // 1. PSAR SL hit (trailing — tightens each candle)
    if (pos.side === "CE" && price <= pos.stopLoss) {
      const _isTrail = Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
      simulateSell(pos.stopLoss, _isTrail ? "PSAR Trail SL hit" : "PSAR SL hit", price);
      return;
    }
    if (pos.side === "PE" && price >= pos.stopLoss) {
      const _isTrail = Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
      simulateSell(pos.stopLoss, _isTrail ? "PSAR Trail SL hit" : "PSAR SL hit", price);
      return;
    }

    // 2. TRAILING PROFIT — lock one step below peak level: peak 1200→lock 1100
    if (_SCALP_TRAIL_START > 0 && pos.peakPnl >= _SCALP_TRAIL_START) {
      const levelsAbove = Math.floor((pos.peakPnl - _SCALP_TRAIL_START) / _SCALP_TRAIL_STEP);
      const trailFloor = _SCALP_TRAIL_START + (levelsAbove - 1) * _SCALP_TRAIL_STEP;
      if (curPnl <= trailFloor) {
        simulateSell(price, `Trail lock ₹${trailFloor} (peak ₹${Math.round(pos.peakPnl)})`, price);
        return;
      }
    }

    // EOD check
    const nowMin = getISTMinutes();
    if (nowMin >= _STOP_MINS - 10) {
      simulateSell(price, "EOD square-off", price);
      return;
    }
  }
}

// ── onCandleClose — evaluate signal on 3-min bar close ──────────────────────

function onCandleClose(bar) {
  if (!state.running) return;

  // Count candles held + PSAR-based exit checks
  if (state.position) {
    state.position.candlesHeld = (state.position.candlesHeld || 0) + 1;

    // Use only completed candles (matches backtest logic)
    const window = [...state.candles];

    // PSAR flip → exit on reversal signal
    if (window.length >= 15 && scalpStrategy.isPSARFlip(window, state.position.side)) {
      simulateSell(bar.close, "PSAR flip", bar.close);
      return;
    }

    // Update PSAR trailing SL (tighten only)
    if (window.length >= 15) {
      const newSL = scalpStrategy.updateTrailingSL(window, state.position.stopLoss, state.position.side);
      if (newSL !== state.position.stopLoss) {
        log(`📐 [SCALP-PAPER] PSAR trail SL: ₹${state.position.stopLoss} → ₹${newSL}`);
        state.position.stopLoss = newSL;
      }
    }

    return; // In position — don't look for new entry
  }

  // ── Entry evaluation ──────────────────────────────────────────────────────
  if (!isMarketHours()) { log(`⏭️ [SCALP-PAPER] SKIP: outside market hours`); return; }
  if (state._dailyLossHit) { log(`⏭️ [SCALP-PAPER] SKIP: daily loss limit hit`); return; }
  if (state.sessionTrades.length >= _SCALP_MAX_TRADES) { log(`⏭️ [SCALP-PAPER] SKIP: max trades (${_SCALP_MAX_TRADES}) reached`); return; }
  if (state._slPauseUntil && Date.now() < state._slPauseUntil) {
    const secsLeft = Math.ceil((state._slPauseUntil - Date.now()) / 1000);
    log(`⏭️ [SCALP-PAPER] SKIP: SL cooldown (${secsLeft}s left)`);
    return;
  }
  if (state._expiryDayBlocked) { log(`⏭️ [SCALP-PAPER] SKIP: expiry-only mode, not expiry day`); return; }

  // VIX check
  if (process.env.SCALP_VIX_ENABLED === "true") {
    const vix = getCachedVix();
    if (vix) {
      const vixMax = parseFloat(process.env.VIX_MAX_ENTRY || "20");
      if (vix.value > vixMax) {
        log(`⏭️ [SCALP-PAPER] SKIP: VIX ${vix.value.toFixed(1)} > max ${vixMax}`);
        return;
      }
    }
  }

  const window = [...state.candles];
  if (window.length < 30) { log(`⏭️ [SCALP-PAPER] SKIP: warming up (${window.length}/30 candles)`); return; }

  const result = scalpStrategy.getSignal(window, {
    silent: true,
    prevDayOHLC: _prevDayOHLC,
    prevPrevDayOHLC: _prevPrevDayOHLC,
  });
  if (result.signal === "NONE") {
    const lastBar = window[window.length - 1];
    log(`⏭️ [SCALP-PAPER] SKIP: ${result.reason} | Close=${lastBar.close} BB=[${result.bbLower||'?'},${result.bbUpper||'?'}] RSI=${result.rsi||'?'} SAR=${result.sar||'?'}`);
    return;
  }

  const side = result.signal === "BUY_CE" ? "CE" : "PE";
  const spot = bar.close;

  // Resolve option symbol
  resolveAndEnter(side, spot, result);
}

async function resolveAndEnter(side, spot, result) {
  try {
    const optionInfo = await validateAndGetOptionSymbol(spot, side);
    if (optionInfo.invalid) {
      log(`⚠️ [SCALP-PAPER] Option symbol invalid for ${side} — skipping entry`);
      return;
    }
    const qty = getLotQty();
    simulateBuy(optionInfo.symbol, side, qty, spot, result.reason, result.stopLoss, result.target, spot);
  } catch (err) {
    log(`⚠️ [SCALP-PAPER] Symbol resolution failed: ${err.message}`);
  }
}

// ── Pre-load history ────────────────────────────────────────────────────────

async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { fetchCandles } = require("../services/backtestEngine");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    // Fetch from 3 days ago to ensure 30+ candles even before market open
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached(
      NIFTY_INDEX_SYMBOL, String(SCALP_RES), threeDaysAgo, today,
      fetchCandles
    );
    if (candles && candles.length > 0) {
      state.candles = candles.slice(-99);
      log(`📦 [SCALP-PAPER] Pre-loaded ${state.candles.length} × ${SCALP_RES}-min candles (strategy ready!)`);
    } else {
      log(`⚠️ [SCALP-PAPER] No historical candles found — will build from live ticks`);
    }
  } catch (err) {
    log(`⚠️ [SCALP-PAPER] Pre-load failed: ${err.message} — will build from ticks`);
  }

  // Fetch previous day(s) OHLC for CPR calculation
  try {
    const { fetchCandles } = require("../services/backtestEngine");
    // Fetch last 5 days of daily candles to get prev & prev-prev day
    const todayDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const fiveDaysAgo = new Date(Date.now() - 7 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const dailyCandles = await fetchCandles(NIFTY_INDEX_SYMBOL, "D", fiveDaysAgo, todayDate);
    if (dailyCandles && dailyCandles.length >= 2) {
      // Last complete day (not today)
      const sorted = dailyCandles.sort((a, b) => a.time - b.time);
      // Filter out today's candle
      const pastDays = sorted.filter(c => {
        const d = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        return d < todayDate;
      });
      if (pastDays.length >= 1) {
        const prev = pastDays[pastDays.length - 1];
        _prevDayOHLC = { high: prev.high, low: prev.low, close: prev.close };
        log(`📊 [SCALP-PAPER] Prev day OHLC: H=${prev.high} L=${prev.low} C=${prev.close}`);
      }
      if (pastDays.length >= 2) {
        const pp = pastDays[pastDays.length - 2];
        _prevPrevDayOHLC = { high: pp.high, low: pp.low, close: pp.close };
      }

      // Log CPR info
      if (_prevDayOHLC) {
        const cpr = scalpStrategy.calcCPR(_prevDayOHLC.high, _prevDayOHLC.low, _prevDayOHLC.close);
        const narrow = scalpStrategy.isNarrowCPR(cpr);
        log(`📊 [SCALP-PAPER] CPR: TC=${cpr.tc} BC=${cpr.bc} Width=${cpr.width} ${narrow ? "✅ NARROW (trending)" : "❌ WIDE (skip entries)"}`);
      }
    } else {
      log(`⚠️ [SCALP-PAPER] Not enough daily candles for prev day data`);
    }
  } catch (err) {
    log(`⚠️ [SCALP-PAPER] CPR data fetch failed: ${err.message}`);
  }
}

// ── Auto-stop timer ─────────────────────────────────────────────────────────
let _autoStopTimer = null;

function scheduleAutoStop(stopFn) {
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  const stopH = Math.floor(_STOP_MINS / 60);
  const stopM = _STOP_MINS % 60;
  const now   = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const stopAt = new Date(now);
  stopAt.setHours(stopH, stopM, 0, 0);
  const ms = stopAt - now;
  if (ms <= 0) return;
  _autoStopTimer = setTimeout(() => {
    if (!state.running) return;
    stopFn("⏰ [SCALP-PAPER] Auto-stop: " + stopH + ":" + String(stopM).padStart(2, "0") + " reached");
  }, ms);
  log(`⏰ [SCALP-PAPER] Auto-stop in ${Math.round(ms / 60000)} min`);
}

// ── Styled error page ─────────────────────────────────────────────────────────
function errorPage(title, message, linkHref, linkText) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
${sidebarCSS()}
*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'IBM Plex Sans',sans-serif;background:#060810;color:#a0b8d8;min-height:100vh;display:flex;flex-direction:column;}
.main-content{flex:1;padding:40px 32px;margin-left:220px;display:flex;align-items:center;justify-content:center;}
@media(max-width:900px){.main-content{margin-left:0;}}
.err-box{background:#0d1320;border:1px solid #7f1d1d;border-radius:14px;padding:40px 48px;max-width:480px;text-align:center;}
.err-icon{font-size:2.5rem;margin-bottom:16px;}
.err-title{color:#ef4444;margin-bottom:12px;font-size:1.1rem;font-weight:700;}
.err-msg{font-size:0.85rem;color:#8899aa;margin-bottom:24px;line-height:1.6;}
.err-link{background:#1e40af;color:#fff;padding:9px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.85rem;display:inline-block;}
.err-link:hover{background:#2563eb;}
</style></head><body>
<div class="app-shell">
${buildSidebar('scalpPaper', false)}
<div class="main-content">
<div class="err-box">
<div class="err-icon">🚫</div>
<h2 class="err-title">${title}</h2>
<p class="err-msg">${message}</p>
${linkHref ? `<a href="${linkHref}" class="err-link">${linkText || 'Go Back'}</a>` : ''}
</div></div></div></body></html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/scalp-paper/status");

  const check = sharedSocketState.canStart("SCALP_PAPER");
  if (!check.allowed) {
    return res.status(409).send(errorPage("Cannot Start", check.reason, "/scalp-paper/status", "\u2190 Back"));
  }

  if (!process.env.ACCESS_TOKEN) {
    return res.status(401).send(errorPage("Not Authenticated", "Fyers not logged in. Login first.", "/auth", "Login with Fyers"));
  }

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) {
    return res.status(400).send(errorPage("Trading Not Allowed", holiday.reason, "/scalp-paper/status", "\u2190 Back"));
  }

  if (!isStartAllowed()) {
    return res.status(400).send(errorPage("Session Closed", "Past stop time \u2014 cannot start today.", "/scalp-paper/status", "\u2190 Back"));
  }

  // Expiry day check
  let _expiryBlocked = false;
  if ((process.env.SCALP_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
    const { isExpiryDay } = require("../utils/nseHolidays");
    const isExpiry = await isExpiryDay();
    if (!isExpiry) _expiryBlocked = true;
    log(`📅 [SCALP-PAPER] Expiry-only mode: ${isExpiry ? "✅ Today is expiry — trading allowed" : "❌ Not expiry day — entries blocked"}`);
  }

  // Reset state
  state = {
    running: true, position: null, candles: [], currentBar: null, barStartTime: null,
    log: [], sessionTrades: [], sessionStart: new Date().toISOString(),
    sessionPnl: 0, tickCount: 0, lastTickTime: null, lastTickPrice: null,
    optionLtp: null, optionSymbol: null, _slPauseUntil: null, _dailyLossHit: false,
    _expiryDayBlocked: _expiryBlocked,
  };

  sharedSocketState.setScalpActive("SCALP_PAPER");

  // Pre-load history
  await preloadHistory();

  // Start VIX polling
  if (process.env.SCALP_VIX_ENABLED === "true") {
    resetVixCache();
    fetchLiveVix().catch(() => {});
  }

  // Socket: piggyback if already running, else start our own
  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [SCALP-PAPER] Piggybacking on existing WebSocket");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log); // dummy primary callback
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [SCALP-PAPER] Started WebSocket (own instance)");
  }

  // Auto-stop
  scheduleAutoStop((msg) => {
    log(msg);
    stopSession();
  });

  log(`🟢 [SCALP-PAPER] Session started — ${SCALP_RES}-min candles`);
  res.redirect("/scalp-paper/status");
});

function stopSession() {
  if (!state.running) return;

  // Exit any open position
  if (state.position) {
    simulateSell(state.lastTickPrice || state.position.entryPrice, "Session stopped", state.lastTickPrice);
  }

  state.running = false;
  stopOptionPolling();
  socketManager.removeCallback(CALLBACK_ID);

  // If we were the only socket user and no primary mode is active, stop socket
  if (!sharedSocketState.isActive() && socketManager.isRunning()) {
    // Don't stop — primary mode might still need it
    // Only stop if no primary mode AND no other scalp mode
    if (!sharedSocketState.isScalpActive() || sharedSocketState.getScalpMode() === "SCALP_PAPER") {
      // Check if primary mode needs it
      if (!sharedSocketState.isActive()) {
        socketManager.stop();
      }
    }
  }

  sharedSocketState.clearScalp();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  // Save session
  if (state.sessionTrades.length > 0) {
    try {
      const data = loadScalpData();
      data.sessions.push({
        date:     state.sessionStart,
        strategy: scalpStrategy.NAME,
        pnl:      state.sessionPnl,
        trades:   state.sessionTrades,
      });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      saveScalpData(data);
      log(`💾 [SCALP-PAPER] Session saved — ${state.sessionTrades.length} trades, PnL: ₹${state.sessionPnl}`);
    } catch (err) {
      log(`⚠️ [SCALP-PAPER] Save failed: ${err.message}`);
    }
  }

  log("🔴 [SCALP-PAPER] Session stopped");
}

router.get("/stop", (req, res) => {
  stopSession();
  res.redirect("/scalp-paper/status");
});

router.get("/exit", (req, res) => {
  if (state.position) {
    simulateSell(state.lastTickPrice || state.position.entryPrice, "Manual exit", state.lastTickPrice);
  }
  res.redirect("/scalp-paper/status");
});

// ── Manual entry ────────────────────────────────────────────────────────────
router.post("/manualEntry", async (req, res) => {
  if (!state.running) return res.status(400).json({ success: false, error: "Scalp paper is not running." });
  if (state.position) return res.status(400).json({ success: false, error: "Already in a position. Exit first." });
  const { side } = req.body || {};
  if (side !== "CE" && side !== "PE") return res.status(400).json({ success: false, error: "Side must be CE or PE." });
  const spot = state.lastTickPrice || (state.currentBar ? state.currentBar.close : null);
  if (!spot) return res.status(400).json({ success: false, error: "No market data yet." });

  // Get PSAR for SL
  const candles = state.candles || [];
  let sarSL = null;
  if (candles.length >= 15) {
    const result = scalpStrategy.getSignal(candles, { silent: true });
    if (result && result.stopLoss) sarSL = result.stopLoss;
  }
  // Fallback SL if PSAR not available
  if (!sarSL) sarSL = side === "CE" ? spot - 25 : spot + 25;
  // Validate SL direction
  if ((side === "CE" && sarSL >= spot) || (side === "PE" && sarSL <= spot)) {
    sarSL = side === "CE" ? spot - 25 : spot + 25;
  }

  try {
    const optResult = await validateAndGetOptionSymbol(spot, side);
    const symbol = optResult.symbol;
    const qty = getLotQty();
    log(`🖐️ [SCALP-PAPER] MANUAL ENTRY ${side} @ spot ₹${spot} | SL: ₹${sarSL}`);
    simulateBuy(symbol, side, qty, spot, `Manual ${side} entry`, sarSL, null, spot);
    return res.json({ success: true, spot, side, sl: sarSL, symbol });
  } catch (e) {
    log(`❌ [SCALP-PAPER] Manual entry failed: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── Status data (AJAX poll) ─────────────────────────────────────────────────

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const data = loadScalpData();

  // Unrealised PnL — option premium if available, else spot proxy
  let unrealised = 0;
  if (pos && state.lastTickPrice) {
    const optEntry = pos.optionEntryLtp;
    const optCurr  = state.optionLtp || pos.optionCurrentLtp;
    if (optEntry && optCurr && optEntry > 0) {
      unrealised = parseFloat(((optCurr - optEntry) * (pos.qty || getLotQty())).toFixed(2));
    } else {
      unrealised = parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * (pos.qty || getLotQty())).toFixed(2));
    }
  }

  const optEntryLtp   = pos ? (pos.optionEntryLtp || null) : null;
  const optCurrentLtp = pos ? (state.optionLtp || pos.optionCurrentLtp || null) : null;
  const optPremiumPnl = (optEntryLtp && optCurrentLtp)
    ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0)).toFixed(2)) : null;
  const optPremiumMove = (optEntryLtp && optCurrentLtp)
    ? parseFloat((optCurrentLtp - optEntryLtp).toFixed(2)) : null;
  const optPremiumPct  = (optEntryLtp && optCurrentLtp && optEntryLtp > 0)
    ? parseFloat(((optCurrentLtp - optEntryLtp) / optEntryLtp * 100).toFixed(2)) : null;
  const liveClose    = state.lastTickPrice || null;
  const pointsMoved  = pos && liveClose
    ? parseFloat(((liveClose - pos.entryPrice) * (pos.side === "CE" ? 1 : -1)).toFixed(2)) : 0;

  res.json({
    running:       state.running,
    tickCount:     state.tickCount,
    lastTickPrice: state.lastTickPrice,
    lastTickTime:  state.lastTickTime ? new Date(state.lastTickTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : null,
    candleCount:   state.candles.length,
    sessionStart:  state.sessionStart,
    capital:       data.capital,
    totalPnl:      data.totalPnl,
    currentBar:    state.currentBar ? {
      open:  state.currentBar.open,
      high:  state.currentBar.high,
      low:   state.currentBar.low,
      close: state.currentBar.close,
    } : null,
    position: pos ? {
      side:              pos.side,
      symbol:            pos.symbol,
      qty:               pos.qty,
      entryPrice:        pos.entryPrice,
      entryTime:         pos.entryTime,
      stopLoss:          pos.stopLoss,
      target:            pos.target,
      bestPrice:         pos.bestPrice,
      candlesHeld:       pos.candlesHeld,
      optionStrike:      pos.optionStrike,
      optionExpiry:      pos.optionExpiry,
      optionType:        pos.optionType,
      optionEntryLtp:    optEntryLtp,
      optionCurrentLtp:  optCurrentLtp,
      optPremiumPnl,
      optPremiumMove,
      optPremiumPct,
      liveClose,
      pointsMoved,
    } : null,
    sessionPnl:    state.sessionPnl,
    unrealised,
    tradeCount:    state.sessionTrades.length,
    wins:          state.sessionTrades.filter(t => t.pnl > 0).length,
    losses:        state.sessionTrades.filter(t => t.pnl < 0).length,
    dailyLossHit:  state._dailyLossHit,
    slPauseUntil:  state._slPauseUntil || null,
    logTotal:      state.log.length,
    logs:          state.log.length <= 100
      ? [...state.log].reverse()
      : state.log.slice(-100).reverse(),
    trades: [...(state.sessionTrades || [])].reverse().map(t => ({
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
    })),
    optionLtp:     state.optionLtp,
  });
});

// ── Status page ─────────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
  const liveActive  = sharedSocketState.getMode() === "LIVE_TRADE";
  const pos         = state.position;
  const data        = loadScalpData();

  // VIX details for top-bar display
  const _vix          = getCachedVix();
  const _vixEnabled   = vixFilter.VIX_ENABLED;
  const _vixMaxEntry  = vixFilter.VIX_MAX_ENTRY;
  const _vixStrongOnly = vixFilter.VIX_STRONG_ONLY;

  // Unrealised PnL
  let unrealisedPnl = 0;
  if (pos && state.lastTickPrice) {
    const optEntry = pos.optionEntryLtp;
    const optCurr  = state.optionLtp || pos.optionCurrentLtp;
    if (optEntry && optCurr && optEntry > 0) {
      unrealisedPnl = parseFloat(((optCurr - optEntry) * (pos.qty || getLotQty())).toFixed(2));
    } else {
      unrealisedPnl = parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * (pos.qty || getLotQty())).toFixed(2));
    }
  }

  const inr = (n) => typeof n === "number"
    ? `\u20b9${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "\u2014";
  const pnlColor = (n) => n >= 0 ? "#10b981" : "#ef4444";

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;

  const liveClose = state.lastTickPrice || null;
  const pointsMoved = pos && liveClose
    ? parseFloat(((liveClose - pos.entryPrice) * (pos.side === "CE" ? 1 : -1)).toFixed(2))
    : 0;

  // ATM/ITM badge
  const atmStrike = pos ? Math.round(pos.entryPrice / 50) * 50 : null;
  const strikeLabel = pos && pos.optionStrike
    ? (pos.optionStrike === atmStrike ? "ATM" : pos.optionStrike < atmStrike ? (pos.side === "CE" ? "ITM" : "OTM") : (pos.side === "PE" ? "ITM" : "OTM"))
    : "\u2014";
  const strikeBadgeColor = strikeLabel === "ATM" ? "#3b82f6" : strikeLabel === "ITM" ? "#10b981" : "#ef4444";

  // Option premium calcs
  const optEntryLtp   = pos ? (pos.optionEntryLtp || null) : null;
  const optCurrentLtp = pos ? (state.optionLtp || pos.optionCurrentLtp || null) : null;
  const optPremiumPnl = (optEntryLtp && optCurrentLtp)
    ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0)).toFixed(2)) : null;
  const optPremiumMove = (optEntryLtp && optCurrentLtp)
    ? parseFloat((optCurrentLtp - optEntryLtp).toFixed(2)) : null;
  const optPremiumPct  = (optEntryLtp && optCurrentLtp && optEntryLtp > 0)
    ? parseFloat(((optCurrentLtp - optEntryLtp) / optEntryLtp * 100).toFixed(2)) : null;

  // Position HTML — matching paperTrade layout
  const posHtml = pos ? `
    <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">

      <!-- Header: status + entry time + EXIT BUTTON -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 1.5s infinite;"></span>
          <span style="font-size:0.8rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;">Open Position</span>
          <span style="font-size:0.72rem;color:#4a6080;">Since ${pos.entryTime}</span>
        </div>
        <button onclick="spHandleExit(this)"
           style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;transition:background 0.15s;"
           onmouseover="this.style.background='#991b1b'" onmouseout="this.style.background='#7f1d1d'">
          Exit Trade Now
        </button>
      </div>

      <!-- Option Identity Banner -->
      <div style="background:#071a12;border:1px solid #134e35;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:2.2rem;font-weight:900;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side}</span>
            <div>
              <div style="font-size:0.72rem;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side === "CE" ? "CALL \u00b7 Bullish" : "PUT \u00b7 Bearish"}</div>
              <span style="font-size:0.65rem;font-weight:700;background:${strikeBadgeColor}22;color:${strikeBadgeColor};border:1px solid ${strikeBadgeColor}44;padding:2px 7px;border-radius:4px;">${strikeLabel}</span>
            </div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Strike</div>
            <div style="font-size:1.6rem;font-weight:800;color:#fff;font-family:monospace;">${pos.optionStrike ? pos.optionStrike.toLocaleString("en-IN") : "\u2014"}</div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Expiry</div>
            <div style="font-size:1.1rem;font-weight:700;color:#f59e0b;">${pos.optionExpiry || "\u2014"}</div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Qty / Lots</div>
            <div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty} <span style="font-size:0.72rem;color:#4a6080;">(${(pos.qty / getLotQty()).toFixed(0)} lot)</span></div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;flex-shrink:0;"></div>
          <div style="flex:1;min-width:200px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Full Symbol</div>
            <div style="font-size:0.82rem;font-weight:600;color:#c8d8f0;font-family:monospace;word-break:break-all;">${pos.symbol}</div>
          </div>
        </div>
      </div>

      <!-- Option Premium Section -->
      <div style="background:#0a0f24;border:2px solid #3b82f6;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
        <div style="font-size:0.68rem;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Option Premium (${pos.optionType || pos.side} Price)</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">
          <!-- Entry Premium -->
          <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid #1e3a5f;border-radius:10px;">
            <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Entry Price</div>
            <div id="ajax-opt-entry-ltp" style="font-size:2rem;font-weight:800;color:#60a5fa;font-family:monospace;line-height:1;">
              ${optEntryLtp ? "\u20b9" + optEntryLtp.toFixed(2) : '<span style="font-size:1rem;color:#f59e0b;">Fetching...</span>'}
            </div>
            <div style="font-size:0.68rem;color:#4a6080;margin-top:4px;">${optEntryLtp ? "captured at entry" : "first REST poll in ~3s"}</div>
          </div>
          <!-- Arrow -->
          <div style="text-align:center;font-size:1.8rem;color:${optPremiumMove !== null ? (optPremiumMove >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};">\u2192</div>
          <!-- Current Premium -->
          <div style="text-align:center;padding:12px;background:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#071a0f" : "#1a0707") : "#0d1320"};border:2px solid ${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};border-radius:10px;">
            <div style="font-size:0.63rem;color:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Current LTP</div>
            <div id="ajax-opt-current-ltp" style="font-size:2rem;font-weight:800;color:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">
              ${optCurrentLtp ? "\u20b9" + optCurrentLtp.toFixed(2) : "\u23f3"}
            </div>
            <div id="ajax-opt-move" style="font-size:0.72rem;font-weight:700;margin-top:6px;color:${optPremiumMove !== null ? (optPremiumMove >= 0 ? "#10b981" : "#ef4444") : "#f59e0b"};">
              ${optPremiumMove !== null ? (optPremiumMove >= 0 ? "\u25b2 +" : "\u25bc ") + "\u20b9" + Math.abs(optPremiumMove).toFixed(2) + " pts" : "\u23f3 Polling REST feed..."}
            </div>
            <div id="ajax-opt-pct" style="font-size:1.1rem;font-weight:800;margin-top:4px;color:${optPremiumPct !== null ? (optPremiumPct >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};font-family:monospace;">
              ${optPremiumPct !== null ? (optPremiumPct >= 0 ? "+" : "") + optPremiumPct.toFixed(2) + "%" : "\u2014"}
            </div>
          </div>
          <!-- Option P&L -->
          <div style="text-align:center;padding:12px;background:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#071a0f" : "#1a0707") : "#0d1320"};border:1px solid ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#065f46" : "#7f1d1d") : "#1a2236"};border-radius:10px;">
            <div style="font-size:0.63rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Unrealised P&L</div>
            <div id="ajax-opt-pnl" style="font-size:1.8rem;font-weight:800;color:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">
              ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "+" : "") + "\u20b9" + optPremiumPnl.toLocaleString("en-IN", {minimumFractionDigits:2, maximumFractionDigits:2}) : "\u2014"}
            </div>
            <div style="font-size:0.65rem;color:#4a6080;margin-top:4px;">${pos.qty} qty \u00b7 -\u20b980 brok</div>
          </div>
        </div>
      </div>

      <!-- Secondary grid: NIFTY spot + SL + Target + Trail -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px;">
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY Spot @ Entry</div>
          <div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(pos.entryPrice)}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY LTP</div>
          <div id="ajax-nifty-ltp" style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(liveClose)}</div>
          <div id="ajax-nifty-move" style="font-size:0.63rem;color:${pointsMoved >= 0 ? "#10b981" : "#ef4444"};margin-top:2px;">${pointsMoved >= 0 ? "\u25b2" : "\u25bc"} ${Math.abs(pointsMoved).toFixed(1)} pts</div>
        </div>
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop Loss (PSAR)</div>
          <div id="ajax-stop-loss" style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.stopLoss ? inr(pos.stopLoss) : "\u2014"}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Target</div>
          <div style="font-size:1.05rem;font-weight:700;color:#10b981;">${pos.target ? inr(pos.target) : "\u2014"}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Best Price</div>
          <div id="ajax-pos-best" style="font-size:1.05rem;font-weight:700;color:#8b5cf6;">${pos.bestPrice ? inr(pos.bestPrice) : "\u2014"}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Candles Held</div>
          <div id="ajax-pos-candles" style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${pos.candlesHeld || 0} <span style="font-size:0.65rem;color:#4a6080;">candles</span></div>
        </div>
      </div>
      ${pos.reason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;">Entry: ${pos.reason}</div>` : ""}
    </div>` : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:0.9rem;font-weight:600;color:#4a6080;margin-bottom:14px;">FLAT \u2014 Waiting for entry signal</div>
      ${state.running ? `<div style="display:flex;gap:10px;justify-content:center;">
        <button onclick="spManualEntry('CE')" style="padding:8px 24px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">\u25b2 Manual CE</button>
        <button onclick="spManualEntry('PE')" style="padding:8px 24px;background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">\u25bc Manual PE</button>
      </div>` : ''}
    </div>`;

  // Trades data for client-side table
  const tradesJSON = JSON.stringify([...(state.sessionTrades || [])].reverse().map(t => ({
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
    eSl:          t.stopLoss       || t.initialStopLoss || null,
    xSpot:        t.spotAtExit     || t.exitPrice  || 0,
    xOpt:         t.optionExitLtp  || null,
    pnl:          typeof t.pnl === "number" ? t.pnl : null,
    pnlMode:      t.pnlMode        || "",
    entryReason:  t.entryReason    || t.reason || "",
    reason:       t.exitReason     || "",
  }))).replace(/<\/script>/gi, "<\\/script>").replace(/`/g, "\\u0060").replace(/\$/g, "\\u0024");

  // Logs JSON for initial render
  const allLogs = [...state.log].reverse();
  const logsJSON = JSON.stringify(allLogs)
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/`/g, "\\u0060")
    .replace(/\$/g, "\\u0024");

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Scalp Paper \u2014 ${scalpStrategy.NAME}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u26a1</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
${sidebarCSS()}
${modalCSS()}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#060810;color:#c0d0e8;min-height:100vh;display:flex;flex-direction:column;}
.main-content{flex:1;padding:28px 32px;margin-left:220px;}
@media(max-width:900px){.main-content{margin-left:0;padding:16px;}}

/* Top bar */
.top-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px;}
.top-bar-title{font-size:1.15rem;font-weight:700;color:#e0eaf8;}
.top-bar-meta{font-size:0.68rem;color:#4a6080;margin-top:3px;}
.top-bar-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.top-bar-badge{font-size:0.65rem;font-weight:700;padding:4px 10px;border-radius:6px;text-transform:uppercase;letter-spacing:0.8px;display:inline-flex;align-items:center;gap:5px;border:1px solid #1a2236;color:#4a6080;}
.badge-running{background:#064e3b;color:#10b981;border:1px solid #10b981;}
.badge-stopped{background:#1c1017;color:#ef4444;border:1px solid #ef4444;}

/* Capital strip */
.capital-strip{display:flex;background:#0d1320;border:1px solid #1a2236;border-radius:9px;overflow:hidden;margin-bottom:14px;}
.cap-cell{flex:1;padding:11px 16px;border-right:1px solid #1a2236;}
.cap-cell:last-child{border-right:none;}
.cap-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.5px;color:#4a6080;margin-bottom:4px;}
.cap-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#c8d8f0;}

/* Stat cards */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-bottom:16px;}
.sc{background:#0d1320;border:1px solid #1a2236;border-radius:8px;padding:12px 14px;position:relative;overflow:hidden;}
.sc-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.2px;color:#4a6080;margin-bottom:5px;}
.sc-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#c8d8f0;}
.sc-sub{font-size:0.6rem;color:#4a6080;margin-top:3px;}

/* Section title */
.section-title{font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#4a6080;margin-bottom:8px;display:flex;align-items:center;gap:8px;}
.section-title::after{content:'';flex:1;height:0.5px;background:#1a2236;}

/* Pulse animation */
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.4;}}

/* Mobile */
@media(max-width:640px){
  .main-content{margin-left:0;padding:14px 12px 40px;}
  .stat-grid{grid-template-columns:1fr 1fr;gap:7px;}
  .capital-strip{flex-wrap:wrap;}
  .cap-cell{min-width:50%;}
}
</style>
</head>
<body>
<div class="app-shell">
${buildSidebar('scalpPaper', liveActive, state.running)}
<div class="main-content">

<!-- Top bar -->
<div class="top-bar">
  <div>
    <div class="top-bar-title">Scalp Paper Trade</div>
    <div class="top-bar-meta">Strategy: ${scalpStrategy.NAME} \u00b7 ${SCALP_RES}-min candles \u00b7 SL: PSAR / Trail \u20b9${_SCALP_TRAIL_START}/\u20b9${_SCALP_TRAIL_STEP} \u00b7 ${state.running ? 'Auto-refreshes every 2s' : 'Stopped'}</div>
  </div>
  <div class="top-bar-right">
    ${state.running
      ? `<span class="top-bar-badge badge-running"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>RUNNING</span>`
      : `<span class="top-bar-badge badge-stopped">IDLE</span>`}
    ${_vixEnabled ? `<span class="top-bar-badge" style="border-color:${_vix == null ? 'rgba(100,116,139,0.3)' : _vix > _vixMaxEntry ? 'rgba(239,68,68,0.3)' : _vix > _vixStrongOnly ? 'rgba(234,179,8,0.3)' : 'rgba(16,185,129,0.3)'};background:${_vix == null ? 'rgba(100,116,139,0.08)' : _vix > _vixMaxEntry ? 'rgba(239,68,68,0.1)' : _vix > _vixStrongOnly ? 'rgba(234,179,8,0.1)' : 'rgba(16,185,129,0.1)'};color:${_vix == null ? '#94a3b8' : _vix > _vixMaxEntry ? '#ef4444' : _vix > _vixStrongOnly ? '#eab308' : '#10b981'};">VIX ${_vix != null ? _vix.toFixed(1) : 'n/a'}${_vix != null ? (_vix > _vixMaxEntry ? ' \u00b7 BLOCKED' : _vix > _vixStrongOnly ? ' \u00b7 STRONG ONLY' : ' \u00b7 NORMAL') : ''}</span>` : ''}
    ${state.running
      ? `<button onclick="location='/scalp-paper/stop'" style="background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;padding:5px 14px;border-radius:6px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;">Stop Session</button>`
      : `<button onclick="location='/scalp-paper/start'" style="background:#1e40af;border:1px solid #3b82f6;color:#fff;padding:5px 14px;border-radius:6px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;">Start Scalp Paper</button>`}
  </div>
</div>

<!-- Capital strip -->
<div class="capital-strip">
  <div class="cap-cell">
    <div class="cap-label">Starting Capital</div>
    <div class="cap-val">\u20b9${getScalpCapitalFromEnv().toLocaleString("en-IN")}</div>
  </div>
  <div class="cap-cell">
    <div class="cap-label">Current Capital</div>
    <div class="cap-val" id="ajax-current-capital" style="color:${data.capital >= getScalpCapitalFromEnv() ? '#10b981' : '#ef4444'};">\u20b9${data.capital.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
  </div>
  <div class="cap-cell">
    <div class="cap-label">All-Time PnL</div>
    <div class="cap-val" id="ajax-alltime-pnl" style="color:${data.totalPnl >= 0 ? '#10b981' : '#ef4444'};">${data.totalPnl >= 0 ? '+' : ''}\u20b9${data.totalPnl.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
  </div>
  <div class="cap-cell" style="font-size:0.62rem;color:#4a6080;max-width:180px;line-height:1.5;display:flex;align-items:center;">Capital updates when sessions complete. Reset wipes history.</div>
</div>

<!-- Stat cards -->
<div class="stat-grid">
  <div class="sc" style="border-top:2px solid ${pnlColor(state.sessionPnl)};">
    <div class="sc-label">Session PnL</div>
    <div class="sc-val" id="ajax-session-pnl" style="color:${pnlColor(state.sessionPnl)};">${inr(state.sessionPnl)}</div>
  </div>
  <div class="sc" style="border-top:1.5px solid #6a5090;">
    <div class="sc-label">Trades Today</div>
    <div class="sc-val"><span id="ajax-trade-count">${state.sessionTrades.length}</span> <span style="font-size:0.75rem;color:#4a6080;">/ ${_SCALP_MAX_TRADES}</span></div>
    <div id="ajax-wl" style="font-size:0.7rem;color:#4a6080;margin-top:4px;">${wins}W \u00b7 ${losses}L</div>
  </div>
  <div class="sc" style="border-top:2px solid ${state._slPauseUntil && Date.now() < state._slPauseUntil ? '#ef4444' : '#4a6080'};">
    <div class="sc-label">SL Pause</div>
    <div class="sc-val" id="ajax-sl-pause" style="color:${state._slPauseUntil && Date.now() < state._slPauseUntil ? '#ef4444' : '#10b981'}">${state._slPauseUntil && Date.now() < state._slPauseUntil ? 'PAUSED' : 'OK'}</div>
    <div id="ajax-sl-pause-sub" style="font-size:0.7rem;margin-top:4px;color:#4a6080;">${_SCALP_PAUSE_CANDLES} candle cooldown after SL</div>
  </div>
  <div class="sc" style="border-top:2px solid ${state._dailyLossHit ? '#ef4444' : '#10b981'};">
    <div class="sc-label">Daily Loss Limit</div>
    <div class="sc-val" id="ajax-daily-loss-val" style="color:${state._dailyLossHit ? '#ef4444' : '#10b981'};">${state._dailyLossHit ? 'HIT' : 'OK'} <span style="font-size:0.65rem;color:#4a6080;">/ -\u20b9${_SCALP_MAX_LOSS.toLocaleString("en-IN")}</span></div>
    <div id="ajax-daily-loss-status" style="font-size:0.7rem;margin-top:4px;color:${state._dailyLossHit ? '#ef4444' : '#10b981'}">${state._dailyLossHit ? 'KILLED \u2014 no entries' : 'Active'}</div>
  </div>
  <div class="sc" style="border-top:1.5px solid #a07010;">
    <div class="sc-label">Candles Loaded</div>
    <div class="sc-val" id="ajax-candle-count" style="color:${state.candles.length >= 30 ? '#10b981' : '#f59e0b'}">${state.candles.length}</div>
    <div id="ajax-candle-status" style="font-size:0.7rem;color:${state.candles.length >= 30 ? "#10b981" : "#f59e0b"};margin-top:4px;">${state.candles.length >= 30 ? 'Strategy ready' : 'Warming up...'}</div>
  </div>
  <div class="sc" style="border-top:1.5px solid #2a6080;">
    <div class="sc-label">WebSocket Ticks</div>
    <div class="sc-val" id="ajax-tick-count">${state.tickCount.toLocaleString()}</div>
    <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">Last: <span id="ajax-last-tick">${state.lastTickPrice ? inr(state.lastTickPrice) : "\u2014"}</span></div>
  </div>
  <div class="sc" style="border-top:1.5px solid #2a4020;">
    <div class="sc-label">Session Start</div>
    <div class="sc-val" style="font-size:0.85rem;color:#c8d8f0;">${state.sessionStart || "\u2014"}</div>
  </div>
</div>

<!-- Current bar -->
<div style="margin-bottom:18px;">
  <div class="section-title">Current ${SCALP_RES}-Min Bar (forming)</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
    ${["open","high","low","close"].map(k => `
    <div class="sc">
      <div class="sc-label">${k.toUpperCase()}</div>
      <div class="sc-val" id="ajax-bar-${k}" style="font-size:1rem;">${state.currentBar ? inr(state.currentBar[k]) : "\u2014"}</div>
    </div>`).join("")}
  </div>
</div>

<!-- Position card -->
<div id="ajax-position-section" style="margin-bottom:18px;">
${posHtml}
</div>

<!-- Session trades table -->
${state.sessionTrades.length > 0 ? `
<div style="margin-bottom:18px;">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
    <div class="section-title" style="margin-bottom:0;">Session Trades</div>
    <select id="spSide" onchange="spFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
      <option value="">All Sides</option><option value="CE">CE</option><option value="PE">PE</option>
    </select>
    <select id="spResult" onchange="spFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
      <option value="">All</option><option value="win">Wins</option><option value="loss">Losses</option>
    </select>
    <select id="spPerPage" onchange="spFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
      <option value="5">5/page</option><option value="10" selected>10/page</option><option value="25">25/page</option><option value="999999">All</option>
    </select>
    <span id="spCount" style="font-size:0.72rem;color:#4a6080;"></span>
  </div>
  <div style="border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#0a0f1c;">
        <th onclick="spSort('side')" style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Side</th>
        <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Strike / Expiry</th>
        <th onclick="spSort('entry')" style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Entry Time</th>
        <th onclick="spSort('exit')" style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Exit Time</th>
        <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry (NIFTY / Option)</th>
        <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit (NIFTY / Option)</th>
        <th onclick="spSort('pnl')" style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Net P&amp;L</th>
        <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit Reason</th>
        <th style="padding:9px 12px;text-align:center;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">View</th>
      </tr></thead>
      <tbody id="spBody" style="font-family:monospace;font-size:0.78rem;"></tbody>
    </table>
  </div>
  <div id="spPag" style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;"></div>
  <!-- Trade Detail Modal -->
  <div id="spModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
    <div style="background:#0d1320;border:1px solid #1d3b6e;border-radius:16px;padding:24px 28px;max-width:720px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.9);position:relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
        <div>
          <span id="spm-badge" style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:4px 10px;border-radius:6px;"></span>
          <span style="font-size:0.65rem;color:#4a6080;margin-left:10px;">Scalp Paper \u2014 Full Details</span>
        </div>
        <button onclick="document.getElementById('spModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:#4a6080;font-size:1rem;cursor:pointer;padding:4px 10px;border-radius:6px;font-family:inherit;" onmouseover="this.style.color='#ef4444';this.style.borderColor='#ef4444'" onmouseout="this.style.color='#4a6080';this.style.borderColor='#1a2236'">Close</button>
      </div>
      <div id="spm-grid"></div>
    </div>
  </div>
</div>` : `
<div style="margin-bottom:18px;">
  <div class="section-title">Session Trades</div>
  <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:24px;text-align:center;color:#4a6080;font-size:0.82rem;">No trades yet</div>
</div>`}

<!-- Activity Log -->
<div style="margin-bottom:18px;">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
    <div class="section-title" style="margin-bottom:0;">Activity Log</div>
    <input id="logSearch" placeholder="Search log\u2026" oninput="logFilter()"
      style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 9px;border-radius:6px;font-size:0.73rem;font-family:inherit;width:180px;"/>
    <select id="logType" onchange="logFilter()"
      style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
      <option value="">All entries</option>
      <option value="BUY">Entries</option>
      <option value="Exit:">Exits</option>
      <option value="\u2705">Wins</option>
      <option value="\u274c">Losses</option>
      <option value="\ud83d\udea8">Alerts</option>
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

</div><!-- /main-content -->
</div><!-- /app-shell -->

<script id="log-data" type="application/json">${logsJSON}</script>
<script>
${modalJS()}

// ── Log viewer with search, filter, pagination ──────────────────────────
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
    var isBuy = l.indexOf('BUY')>=0;
    var isExit = l.indexOf('Exit:')>=0;
    var c = l.indexOf('\\u274c')>=0||l.indexOf('\u274c')>=0?'#ef4444':l.indexOf('\\u2705')>=0||l.indexOf('\u2705')>=0?'#10b981':l.indexOf('\\ud83d\\udea8')>=0||l.indexOf('\ud83d\udea8')>=0?'#f59e0b':isBuy?'#60a5fa':isExit?'#f472b6':'#4a6080';
    var bg = isBuy?'rgba(96,165,250,0.06)':isExit?'rgba(244,114,182,0.06)':'transparent';
    var lbl = isBuy?'<span style="background:#1e3a5f;color:#60a5fa;font-size:0.58rem;font-weight:700;padding:1px 5px;border-radius:3px;margin-right:6px;">ENTRY</span>':isExit?'<span style="background:#4a1942;color:#f472b6;font-size:0.58rem;font-weight:700;padding:1px 5px;border-radius:3px;margin-right:6px;">EXIT</span>':'';
    return '<div style="padding:5px 6px;border-bottom:1px solid #1a2236;font-size:0.72rem;font-family:monospace;color:'+c+';line-height:1.4;background:'+bg+';">'+lbl+l+'</div>';
  }).join('');
  var total=Math.ceil(logFiltered.length/logPP);
  var pag=document.getElementById('logPag');
  if(total<=1){ pag.innerHTML=''; return; }
  var h='<button onclick="logGo('+(logPg-1)+')" '+(logPg===1?'disabled':'')+' style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">Prev</button>';
  for(var p=Math.max(1,logPg-2);p<=Math.min(total,logPg+2);p++)
    h+='<button onclick="logGo('+p+')" style="background:'+(p===logPg?'#0a1e3d':'#0d1320')+';border:1px solid '+(p===logPg?'#3b82f6':'#1a2236')+';color:'+(p===logPg?'#3b82f6':'#c8d8f0')+';padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">'+p+'</button>';
  h+='<button onclick="logGo('+(logPg+1)+')" '+(logPg===total?'disabled':'')+' style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">Next</button>';
  pag.innerHTML=h;
}
function logGo(p){ logPg=Math.max(1,Math.min(Math.ceil(logFiltered.length/logPP),p)); logRender(); }
logFilter();

// ── Manual exit handler ──────────────────────────────────────────────────
function spHandleExit(btn) {
  if (!confirm('Exit current position now?')) return;
  btn.disabled = true;
  btn.textContent = 'Exiting...';
  fetch('/scalp-paper/exit').then(function(){ location.reload(); }).catch(function(){ location.reload(); });
}

async function spManualEntry(side) {
  if (!confirm('Manual ' + side + ' entry at current spot?')) return;
  try {
    var res = await fetch('/scalp-paper/manualEntry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side: side })
    });
    var data = await res.json();
    if (data.success) {
      location.reload();
    } else {
      alert('Entry failed: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
    location.reload();
  }
}

// ── Trades table with filtering, sorting, pagination, detail modal ──────
var SP_ALL = ${tradesJSON};
var spFiltered = [...SP_ALL], spSortCol = 'entry', spSortDir = -1, spPage = 1, spPP = 10;

function spFilter() {
  var sideEl = document.getElementById('spSide');
  var resEl  = document.getElementById('spResult');
  var ppEl   = document.getElementById('spPerPage');
  if (!sideEl) return;
  var side = sideEl.value;
  var res  = resEl.value;
  spPP   = parseInt(ppEl.value);
  spPage = 1;
  spFiltered = SP_ALL.filter(function(t) {
    if (side && t.side !== side) return false;
    if (res === 'win'  && (t.pnl == null || t.pnl < 0))  return false;
    if (res === 'loss' && (t.pnl == null || t.pnl >= 0)) return false;
    return true;
  });
  spApplySort();
}
function spSort(col) {
  spSortDir = spSortCol === col ? spSortDir * -1 : -1;
  spSortCol = col;
  spApplySort();
}
function spApplySort() {
  spFiltered.sort(function(a,b) {
    var av = a[spSortCol], bv = b[spSortCol];
    if (av == null) av = spSortDir === -1 ? -Infinity : Infinity;
    if (bv == null) bv = spSortDir === -1 ? -Infinity : Infinity;
    return typeof av === 'string' ? av.localeCompare(bv) * spSortDir : (av - bv) * spSortDir;
  });
  spRender();
}
var spFmt = function(n) { return n != null ? '\\u20b9' + Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '\\u2014'; };

function spRender() {
  var start = (spPage-1)*spPP, slice = spFiltered.slice(start, start+spPP);
  var countEl = document.getElementById('spCount');
  if (countEl) countEl.textContent = spFiltered.length + '/' + SP_ALL.length + ' trades';
  window._spSlice = slice;
  var body = document.getElementById('spBody');
  if (!body) return;
  if (slice.length === 0) {
    body.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#4a6080;">No trades match filters.</td></tr>';
  } else {
    body.innerHTML = slice.map(function(t, i) {
      var sc  = t.side === 'CE' ? '#10b981' : '#ef4444';
      var pc  = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
      var short = t.reason.length > 35 ? t.reason.slice(0,35)+'\\u2026' : t.reason;
      var optDiff = (t.eOpt != null && t.xOpt != null) ? parseFloat((t.xOpt - t.eOpt).toFixed(2)) : null;
      var dc  = optDiff == null ? '#4a6080' : optDiff >= 0 ? '#10b981' : '#ef4444';
      return '<tr style="border-top:1px solid #1a2236;vertical-align:top;">' +
        '<td style="padding:8px 12px;color:' + sc + ';font-weight:800;">' + (t.side||'\\u2014') + '</td>' +
        '<td style="padding:8px 12px;"><div style="font-size:0.95rem;font-weight:800;color:#fff;">' + (t.strike||'\\u2014') + '</div><div style="font-size:0.68rem;color:#f59e0b;margin-top:2px;">' + (t.expiry||'\\u2014') + '</div></td>' +
        '<td style="padding:8px 12px;font-size:0.75rem;">' + (t.entry||'\\u2014') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.75rem;">' + (t.exit||'\\u2014') + '</td>' +
        '<td style="padding:8px 12px;"><div style="font-size:0.65rem;color:#4a6080;">NIFTY SPOT</div><div style="font-weight:700;">' + spFmt(t.eSpot) + '</div><div style="font-size:0.65rem;color:#4a6080;margin-top:3px;">OPTION PREM</div><div style="color:#60a5fa;font-weight:700;">' + (t.eOpt!=null?spFmt(t.eOpt):'\\u2014') + '</div>' + (t.eSl?'<div style="font-size:0.63rem;color:#f59e0b;margin-top:2px;">Init SL '+spFmt(t.eSl)+'</div>':'') + '</td>' +
        '<td style="padding:8px 12px;"><div style="font-size:0.65rem;color:#4a6080;">NIFTY SPOT</div><div style="font-weight:700;">' + spFmt(t.xSpot) + '</div><div style="font-size:0.65rem;color:#4a6080;margin-top:3px;">OPTION PREM</div><div style="color:#60a5fa;font-weight:700;">' + (t.xOpt!=null?spFmt(t.xOpt):'\\u2014') + '</div>' + (optDiff!=null?'<div style="font-size:0.63rem;color:'+dc+';margin-top:2px;">'+(optDiff>=0?'\\u25b2 +':'\\u25bc ')+optDiff+' pts</div>':'') + '</td>' +
        '<td style="padding:8px 12px;"><div style="font-size:1rem;font-weight:800;color:' + pc + ';">' + (t.pnl!=null?(t.pnl>=0?'+':'')+spFmt(t.pnl):'\\u2014') + '</div><div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">after \\u20b980 brok</div></td>' +
        '<td style="padding:8px 12px;font-size:0.7rem;color:#4a6080;" title="' + t.reason + '">' + (short||'\\u2014') + '</td>' +
        '<td style="padding:6px 8px;text-align:center;"><button data-idx="' + i + '" class="sp-eye-btn" style="background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;" title="View full details">View</button></td>' +
        '</tr>';
    }).join('');
    Array.from(document.querySelectorAll('.sp-eye-btn')).forEach(function(btn){
      btn.addEventListener('click',function(){ showSPModal(window._spSlice[parseInt(this.getAttribute('data-idx'))]); });
      btn.addEventListener('mouseover',function(){ this.style.borderColor='#3b82f6';this.style.background='#0a1e3d'; });
      btn.addEventListener('mouseout', function(){ this.style.borderColor='#1a2236';this.style.background='none'; });
    });
  }
  var total = Math.ceil(spFiltered.length / spPP);
  var pagEl = document.getElementById('spPag');
  if (!pagEl) return;
  if (total <= 1) { pagEl.innerHTML=''; return; }
  pagEl.innerHTML =
    '<button onclick="spGo(' + (spPage-1) + ')" ' + (spPage===1?'disabled':'') + ' style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">Prev</button>' +
    Array.from({length:total},function(_,i){return i+1;}).filter(function(p){return Math.abs(p-spPage)<=2;}).map(function(p){
      return '<button onclick="spGo(' + p + ')" style="background:' + (p===spPage?'#0a1e3d':'#0d1320') + ';border:1px solid ' + (p===spPage?'#1d3b6e':'#1a2236') + ';color:' + (p===spPage?'#3b82f6':'#c8d8f0') + ';padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">' + p + '</button>';
    }).join('') +
    '<button onclick="spGo(' + (spPage+1) + ')" ' + (spPage===total?'disabled':'') + ' style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">Next</button>';
}
function spGo(p) { spPage = Math.max(1, Math.min(Math.ceil(spFiltered.length/spPP),p)); spRender(); }
spFilter();

// ── Trade Detail Modal ──────────────────────────────────────────────────
function showSPModal(t){
  var pc  = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
  var sc  = t.side === 'CE' ? '#10b981' : '#ef4444';
  var fmt = function(n) { return n != null && n !== 0 ? '\\u20b9' + Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '\\u2014'; };
  var optDiff = (t.eOpt != null && t.xOpt != null) ? parseFloat((t.xOpt - t.eOpt).toFixed(2)) : null;
  var dc  = optDiff == null ? '#c8d8f0' : optDiff >= 0 ? '#10b981' : '#ef4444';
  var pnlPts = (t.eSpot && t.xSpot && t.side) ? parseFloat(((t.side==='PE' ? t.eSpot - t.xSpot : t.xSpot - t.eSpot)).toFixed(2)) : null;

  var badge = document.getElementById('spm-badge');
  badge.textContent = (t.side || '\\u2014') + (t.strike ? ' \\u00b7 ' + t.strike : '') + (t.optionType ? ' ' + t.optionType : '');
  badge.style.background = t.side === 'CE' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
  badge.style.color = sc;
  badge.style.border = '1px solid ' + (t.side === 'CE' ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)');

  function cell(label, val, color, sub) {
    return '<div style="background:#060910;border:1px solid #1a2236;border-radius:8px;padding:11px 13px;">'
      + '<div style="font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:5px;">' + label + '</div>'
      + '<div style="font-size:0.9rem;font-weight:700;color:' + (color||'#e0eaf8') + ';font-family:monospace;line-height:1.3;">' + (val||'\\u2014') + '</div>'
      + (sub ? '<div style="font-size:0.62rem;color:#4a6080;margin-top:3px;">' + sub + '</div>' : '')
      + '</div>';
  }

  var contractHtml = '<div style="background:#06100e;border:1px solid #0d3020;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a6040;margin-bottom:8px;font-weight:700;">Option Contract</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
    + cell('Symbol', t.symbol || '\\u2014', '#a0f0c0')
    + cell('Strike', t.strike || '\\u2014', '#fff')
    + cell('Expiry', t.expiry || '\\u2014', '#f59e0b')
    + cell('Option Type', t.optionType || t.side || '\\u2014', sc)
    + cell('Qty / Lots', t.qty ? t.qty + ' qty' : '\\u2014', '#c8d8f0')
    + cell('PnL Mode', t.pnlMode || 'spot-diff', '#8b8bf0')
    + '</div></div>';

  var entryHtml = '<div style="background:#060c18;border:1px solid #0d2040;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a4080;margin-bottom:8px;font-weight:700;">Entry</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
    + cell('Entry Time', t.entry || '\\u2014', '#c8d8f0')
    + cell('NIFTY Spot @ Entry', fmt(t.eSpot), '#fff', 'Index price at entry')
    + cell('Option LTP @ Entry', fmt(t.eOpt), '#60a5fa', 'Option premium paid')
    + cell('Initial Stop Loss', fmt(t.eSl), '#f59e0b', 'NIFTY spot SL level')
    + cell('SL Distance', (t.eSl && t.eSpot) ? Math.abs(t.eSpot - t.eSl).toFixed(2) + ' pts' : '\\u2014', '#f59e0b', 'pts from entry to SL')
    + cell('Entry Signal', t.entryReason || '\\u2014', '#a0b8d0')
    + '</div></div>';

  var exitHtml = '<div style="background:#0c0608;border:1px solid #3a0d12;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#801a20;margin-bottom:8px;font-weight:700;">Exit</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
    + cell('Exit Time', t.exit || '\\u2014', '#c8d8f0')
    + cell('NIFTY Spot @ Exit', fmt(t.xSpot), '#fff', 'Index price at exit')
    + cell('Option LTP @ Exit', fmt(t.xOpt), '#60a5fa', 'Option premium at exit')
    + cell('NIFTY Move (pts)', pnlPts != null ? (pnlPts >= 0 ? '+' : '') + pnlPts + ' pts' : '\\u2014', pnlPts != null ? (pnlPts >= 0 ? '#10b981' : '#ef4444') : '#c8d8f0', t.side === 'PE' ? 'Entry-Exit (PE profits on fall)' : 'Exit-Entry (CE profits on rise)')
    + cell('Option Move (pts)', optDiff != null ? (optDiff >= 0 ? '\\u25b2 +' : '\\u25bc ') + optDiff + ' pts' : '\\u2014', dc, 'Exit prem - Entry prem')
    + cell('Net PnL', t.pnl != null ? (t.pnl >= 0 ? '+' : '') + fmt(t.pnl) : '\\u2014', pc, 'After \\u20b980 brokerage')
    + '</div></div>';

  var reasonHtml = '<div style="background:#060910;border:1px solid #1a2236;border-radius:10px;padding:12px 14px;">'
    + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#3a5070;margin-bottom:6px;font-weight:700;">Exit Reason</div>'
    + '<div style="font-size:0.82rem;color:#a0b8d0;line-height:1.6;font-family:monospace;">' + (t.reason || '\\u2014') + '</div>'
    + '</div>';

  document.getElementById('spm-grid').innerHTML = contractHtml + entryHtml + exitHtml + reasonHtml;
  var m = document.getElementById('spModal');
  m.style.display = 'flex';
}
if (document.getElementById('spModal')) {
  document.getElementById('spModal').addEventListener('click',function(e){if(e.target===this)this.style.display='none';});
}
</script>
<script>
// ── AJAX live refresh ────────────────────────────────────────────────────
(function() {
  var INR = function(n) { return typeof n === 'number' ? '\\u20b9' + n.toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2}) : '\\u2014'; };
  var PNL_COLOR = function(n) { return n >= 0 ? '#10b981' : '#ef4444'; };
  var _interval = null;
  var _lastTradeCount = ${state.sessionTrades.length};
  var _lastRunning    = ${state.running};
  var _lastLogCount   = ${state.log.length};
  var _lastHasPosition = ${state.position ? "true" : "false"};

  function setText(id, val) { var el = document.getElementById(id); if (el && el.textContent !== String(val)) el.textContent = val; }
  function setHTML(id, val) { var el = document.getElementById(id); if (el) el.innerHTML = val; }

  async function fetchAndUpdate() {
    try {
      var res = await fetch('/scalp-paper/status/data', { cache: 'no-store' });
      if (!res.ok) return;
      var d = await res.json();

      // Session PnL
      var pnlEl = document.getElementById('ajax-session-pnl');
      if (pnlEl) { pnlEl.textContent = INR(d.sessionPnl); pnlEl.style.color = PNL_COLOR(d.sessionPnl); var card = pnlEl.closest('.sc'); if(card) card.style.borderTopColor = PNL_COLOR(d.sessionPnl); }

      // Trade count + W/L
      var tcEl = document.getElementById('ajax-trade-count');
      if (tcEl) tcEl.textContent = d.tradeCount;
      var wlEl = document.getElementById('ajax-wl');
      if (wlEl) wlEl.textContent = d.wins + 'W \\u00b7 ' + d.losses + 'L';

      // SL Pause
      var slEl = document.getElementById('ajax-sl-pause');
      if (slEl) {
        var paused = d.slPauseUntil && Date.now() < d.slPauseUntil;
        slEl.textContent = paused ? 'PAUSED' : 'OK';
        slEl.style.color = paused ? '#ef4444' : '#10b981';
      }

      // Daily loss
      var dlEl = document.getElementById('ajax-daily-loss-val');
      if (dlEl) dlEl.style.color = d.dailyLossHit ? '#ef4444' : '#10b981';
      var dlStatus = document.getElementById('ajax-daily-loss-status');
      if (dlStatus) {
        dlStatus.textContent = d.dailyLossHit ? 'KILLED \\u2014 no entries' : 'Active';
        dlStatus.style.color = d.dailyLossHit ? '#ef4444' : '#10b981';
      }

      // Candles
      var candleEl = document.getElementById('ajax-candle-count');
      if (candleEl) { candleEl.textContent = d.candleCount; candleEl.style.color = d.candleCount >= 30 ? '#10b981' : '#f59e0b'; }
      var cStatus = document.getElementById('ajax-candle-status');
      if (cStatus) { cStatus.textContent = d.candleCount >= 30 ? 'Strategy ready' : 'Warming up...'; cStatus.style.color = d.candleCount >= 30 ? '#10b981' : '#f59e0b'; }

      // Ticks
      var tickEl = document.getElementById('ajax-tick-count');
      if (tickEl) tickEl.textContent = (d.tickCount || 0).toLocaleString();
      var ltpEl = document.getElementById('ajax-last-tick');
      if (ltpEl) ltpEl.textContent = d.lastTickPrice ? INR(d.lastTickPrice) : '\\u2014';

      // Capital
      var capEl = document.getElementById('ajax-current-capital');
      if (capEl) { capEl.textContent = '\\u20b9' + d.capital.toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2}); capEl.style.color = d.capital >= ${getScalpCapitalFromEnv()} ? '#10b981' : '#ef4444'; }
      var atpEl = document.getElementById('ajax-alltime-pnl');
      if (atpEl) { atpEl.textContent = (d.totalPnl >= 0 ? '+' : '') + '\\u20b9' + d.totalPnl.toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2}); atpEl.style.color = PNL_COLOR(d.totalPnl); }

      // Current bar
      if (d.currentBar) {
        ['open','high','low','close'].forEach(function(k) {
          var el = document.getElementById('ajax-bar-' + k);
          if (el) el.textContent = INR(d.currentBar[k]);
        });
      }

      // Position — reload if state changed (flat<->open)
      var nowHasPosition = !!d.position;
      if (nowHasPosition !== _lastHasPosition) {
        _lastHasPosition = nowHasPosition;
        window.location.reload();
        return;
      }
      if (d.position) {
        var p = d.position;
        // Option premium
        var entEl = document.getElementById('ajax-opt-entry-ltp');
        if (entEl) { entEl.textContent = p.optionEntryLtp ? '\\u20b9' + p.optionEntryLtp.toFixed(2) : 'Fetching...'; entEl.style.color = p.optionEntryLtp ? '#60a5fa' : '#f59e0b'; }
        var curEl = document.getElementById('ajax-opt-current-ltp');
        if (curEl) {
          curEl.textContent = p.optionCurrentLtp ? '\\u20b9' + p.optionCurrentLtp.toFixed(2) : '\\u23f3';
          if (p.optionEntryLtp && p.optionCurrentLtp) curEl.style.color = p.optionCurrentLtp >= p.optionEntryLtp ? '#10b981' : '#ef4444';
        }
        var movEl = document.getElementById('ajax-opt-move');
        if (movEl && p.optPremiumMove !== null) {
          movEl.textContent = (p.optPremiumMove >= 0 ? '\\u25b2 +' : '\\u25bc ') + '\\u20b9' + Math.abs(p.optPremiumMove).toFixed(2) + ' pts';
          movEl.style.color = p.optPremiumMove >= 0 ? '#10b981' : '#ef4444';
        }
        var pctEl = document.getElementById('ajax-opt-pct');
        if (pctEl) {
          if (p.optPremiumPct !== null && p.optPremiumPct !== undefined) {
            pctEl.textContent = (p.optPremiumPct >= 0 ? '+' : '') + p.optPremiumPct.toFixed(2) + '%';
            pctEl.style.color = p.optPremiumPct >= 0 ? '#10b981' : '#ef4444';
          } else { pctEl.textContent = '\\u2014'; }
        }
        var optPnlEl = document.getElementById('ajax-opt-pnl');
        if (optPnlEl && p.optPremiumPnl !== null) {
          optPnlEl.textContent = (p.optPremiumPnl >= 0 ? '+' : '') + INR(p.optPremiumPnl);
          optPnlEl.style.color = PNL_COLOR(p.optPremiumPnl);
        }
        // NIFTY LTP
        var ltpLiveEl = document.getElementById('ajax-nifty-ltp');
        var ltpNow = d.lastTickPrice || p.liveClose;
        if (ltpLiveEl && ltpNow !== null) {
          ltpLiveEl.textContent = INR(ltpNow);
          var sub = document.getElementById('ajax-nifty-move');
          if (sub && p.entryPrice) {
            var moved = parseFloat(((ltpNow - p.entryPrice) * (p.side === 'CE' ? 1 : -1)).toFixed(1));
            sub.textContent = (moved >= 0 ? '\\u25b2' : '\\u25bc') + ' ' + Math.abs(moved).toFixed(1) + ' pts';
            sub.style.color = moved >= 0 ? '#10b981' : '#ef4444';
          }
        }
        // SL
        var slPosEl = document.getElementById('ajax-stop-loss');
        if (slPosEl) slPosEl.textContent = p.stopLoss ? INR(p.stopLoss) : '\\u2014';
        // Best price
        var bestEl = document.getElementById('ajax-pos-best');
        if (bestEl) bestEl.textContent = p.bestPrice ? INR(p.bestPrice) : '\\u2014';
        // Candles held
        var candPosEl = document.getElementById('ajax-pos-candles');
        if (candPosEl) candPosEl.innerHTML = (p.candlesHeld || 0) + ' <span style="font-size:0.65rem;color:#4a6080;">candles</span>';
      }

      // Trades — reload table if count changed
      if (d.trades && d.tradeCount !== _lastTradeCount) {
        _lastTradeCount = d.tradeCount;
        if (typeof SP_ALL !== 'undefined') {
          SP_ALL.length = 0;
          d.trades.forEach(function(t){ SP_ALL.push(t); });
        } else {
          window.SP_ALL = d.trades.slice();
        }
        spFiltered = [...SP_ALL];
        if (typeof spFilter === 'function') spFilter();
        // If no trades section existed (page loaded with 0 trades), reload
        if (!document.getElementById('spBody')) window.location.reload();
      }

      // Activity log
      if (d.logs && d.logTotal !== _lastLogCount) {
        _lastLogCount = d.logTotal;
        if (typeof LOG_ALL !== 'undefined') {
          LOG_ALL.length = 0;
          d.logs.forEach(function(l){ LOG_ALL.push(l); });
          logFilter();
        }
      }

      // Detect stop
      if (_lastRunning && !d.running) {
        _lastRunning = false;
        clearInterval(_interval);
        _interval = null;
        setTimeout(function() { window.location.reload(); }, 1500);
      }
    } catch (e) {
      console.warn('[AJAX refresh] fetch error:', e.message);
    }
  }

  if (${state.running}) {
    _interval = setInterval(fetchAndUpdate, 2000);
  }
})();
</script>
</body>
</html>`);
});

// ── Scalp Paper History ─────────────────────────────────────────────────────

function getScalpCapitalFromEnv() {
  const v = parseFloat(process.env.SCALP_PAPER_CAPITAL);
  return isNaN(v) ? 100000 : v;
}

router.get("/history", (req, res) => {
  const data = loadScalpData();
  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";

  const allTrades = data.sessions.flatMap(s =>
    (s.trades || []).map(t => ({ ...t, date: s.date }))
  );
  const totalWins   = allTrades.filter(t => t.pnl > 0).length;
  const totalLosses = allTrades.filter(t => t.pnl < 0).length;
  const inr = (n) => typeof n === "number"
    ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
  const pnlColor = (n) => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";
  const startCap = getScalpCapitalFromEnv();

  const sessionCards = data.sessions.length === 0
    ? `<div style="text-align:center;padding:60px 24px;background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;">
        <div style="font-size:3rem;margin-bottom:16px;">📭</div>
        <div style="font-size:1rem;font-weight:600;color:#e0eaf8;margin-bottom:8px;">No sessions yet</div>
        <div style="font-size:0.82rem;color:#4a6080;">Start scalp paper trading to record your first session.</div>
       </div>`
    : data.sessions.slice().reverse().map((s, idx) => {
        const sIdx = data.sessions.length - idx;
        const trades = s.trades || [];
        const sessionWins   = trades.filter(t => t.pnl > 0).length;
        const sessionLosses = trades.filter(t => t.pnl < 0).length;
        const winRate = trades.length ? ((sessionWins / trades.length) * 100).toFixed(1) + "%" : "—";

        const tradeRows = trades.map(t => {
          const badgeCls = t.side === "CE" ? "badge-ce" : "badge-pe";
          const entrySpot   = inr(t.spotAtEntry || t.entryPrice);
          const exitSpot    = inr(t.spotAtExit  || t.exitPrice);
          const entryOpt    = t.optionEntryLtp ? inr(t.optionEntryLtp) : "—";
          const exitOpt     = t.optionExitLtp  ? inr(t.optionExitLtp)  : "—";
          const pnlStr      = `<span style="font-weight:800;color:${pnlColor(t.pnl)};">${t.pnl >= 0 ? "+" : ""}${inr(t.pnl)}</span>`;
          const reason      = (t.exitReason || "—").substring(0, 50);
          return `<tr>
            <td><span class="badge ${badgeCls}">${t.side}</span></td>
            <td style="color:#c8d8f0;">${t.entryTime || "—"}</td>
            <td style="color:#c8d8f0;">${t.exitTime || "—"}</td>
            <td style="color:#c8d8f0;">${entrySpot}</td>
            <td style="color:#c8d8f0;">${exitSpot}</td>
            <td><span style="font-size:0.65rem;color:#60a5fa;">${entryOpt}</span></td>
            <td><span style="font-size:0.65rem;color:#60a5fa;">${exitOpt}</span></td>
            <td>${pnlStr}</td>
            <td style="font-size:0.7rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${reason}</td>
          </tr>`;
        }).join("");

        return `
        <div class="session-card">
          <div class="session-head" onclick="this.parentElement.classList.toggle('open')">
            <div>
              <div class="session-meta">Session ${sIdx} &middot; ${s.date} &middot; ${s.strategy || "—"}</div>
              <div style="margin-top:4px;display:flex;gap:10px;font-size:0.7rem;color:#4a6080;">
                <span>${trades.length} trade${trades.length !== 1 ? "s" : ""}</span>
                <span style="color:#10b981;">${sessionWins}W</span>
                <span style="color:#ef4444;">${sessionLosses}L</span>
                <span>WR ${winRate}</span>
              </div>
            </div>
            <div>
              <div class="session-pnl" style="color:${pnlColor(s.pnl)};">${s.pnl >= 0 ? "+" : ""}${inr(s.pnl)}</div>
              <div class="session-wl">${sessionWins}W / ${sessionLosses}L</div>
            </div>
          </div>
          <div class="session-body">
          ${trades.length > 0 ? `
          <div style="overflow-x:auto;">
            <div class="tbl-wrap"><table class="tbl">
              <thead><tr>
                <th>Side</th><th>Entry Time</th><th>Exit Time</th>
                <th>Entry (NIFTY)</th><th>Exit (NIFTY)</th><th>Option Entry</th><th>Option Exit</th><th>PnL</th><th>Reason</th>
              </tr></thead>
              <tbody>${tradeRows}</tbody>
            </table></div>
          </div>` : `<div style="padding:14px 20px;color:#4a6080;font-size:0.82rem;">No trades in this session.</div>`}
          </div>
        </div>`;
      }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
  <title>Scalp Paper — History</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    ${modalCSS()}
    .session-card{background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;overflow:hidden;margin-bottom:18px;}
    .session-head{padding:16px 20px;display:flex;align-items:center;justify-content:space-between;background:#040c18;border-bottom:0.5px solid #0e1e36;gap:12px;flex-wrap:wrap;cursor:pointer;transition:background 0.15s;}
    .session-head:hover{background:#060e1c;}
    .session-meta{font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;margin-bottom:4px;}
    .session-pnl{font-size:1.5rem;font-weight:800;font-family:'IBM Plex Mono',monospace;text-align:right;}
    .session-wl{font-size:0.7rem;color:#4a6080;text-align:right;margin-top:2px;}
    .session-body{display:none;}
    .session-card.open .session-body{display:block;}
    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.75rem;}
    .tbl th{padding:8px 14px;text-align:left;font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;}
    .tbl td{padding:8px 14px;border-top:0.5px solid #0e1e36;color:#4a6080;vertical-align:middle;}
    .tbl tr:hover td{background:rgba(59,130,246,0.03);}
    .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.65rem;font-weight:700;}
    .badge-ce{background:rgba(16,185,129,0.12);color:#10b981;border:0.5px solid rgba(16,185,129,0.25);}
    .badge-pe{background:rgba(239,68,68,0.12);color:#ef4444;border:0.5px solid rgba(239,68,68,0.25);}
    .export-btn{background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 12px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.12s;}
    .export-btn:hover{border-color:#3b82f6;color:#60a5fa;}
    .reset-btn{background:#1a0508;border:0.5px solid #3b0a0a;color:#ef4444;padding:5px 12px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.12s;}
    .reset-btn:hover{background:#2a0810;border-color:#ef4444;}
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
      .export-btn,.reset-btn{padding:4px 8px;font-size:0.62rem;}
    }
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('scalpHistory', liveActive)}
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">⚡ Scalp Paper Trade History</div>
      <div class="top-bar-meta">${data.sessions.length} sessions · ${allTrades.length} total trades</div>
    </div>
    <div class="top-bar-right">
      <button onclick="exportAllCSV()" class="export-btn">⬇ Export CSV</button>
      <button onclick="confirmReset()" class="reset-btn">🗑 Reset</button>
      <a href="/scalp-paper/status" style="background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;text-decoration:none;cursor:pointer;">← Status</a>
    </div>
  </div>

  <div class="page">

    <!-- Summary stat cards -->
    <div class="stat-grid" style="margin-bottom:22px;">
      <div class="sc">
        <div class="sc-label">Starting Capital</div>
        <div class="sc-val">${inr(startCap)}</div>
      </div>
      <div class="sc">
        <div class="sc-label">Current Capital</div>
        <div class="sc-val" style="color:${pnlColor(data.capital - startCap)};">${inr(data.capital)}</div>
        <div class="sc-sub">${(data.capital - startCap) >= 0 ? '▲' : '▼'} ${inr(Math.abs(data.capital - startCap))} vs start</div>
      </div>
      <div class="sc">
        <div class="sc-label">All-Time PnL</div>
        <div class="sc-val" style="color:${pnlColor(data.totalPnl)};">${data.totalPnl >= 0 ? '+' : ''}${inr(data.totalPnl)}</div>
      </div>
      <div class="sc">
        <div class="sc-label">Overall Win Rate</div>
        <div class="sc-val">${allTrades.length ? ((totalWins / allTrades.length) * 100).toFixed(1) + '%' : '—'}</div>
        <div class="sc-sub">${totalWins}W · ${totalLosses}L · ${allTrades.length} trades</div>
      </div>
      <div class="sc">
        <div class="sc-label">Sessions</div>
        <div class="sc-val">${data.sessions.length}</div>
        <div class="sc-sub">across all time</div>
      </div>
    </div>

    <!-- Session cards -->
    <div class="section-title">Sessions — newest first</div>
    ${sessionCards}

  </div>
</div>
</div>

<script>
${modalJS()}
var ALL_TRADES_JSON = ${JSON.stringify(allTrades)};

function exportAllCSV() {
  if (!ALL_TRADES_JSON.length) { showAlert({icon:'⚠️',title:'No Data',message:'No trades to export',btnClass:'modal-btn-primary'}); return; }
  var header = ['Session Date','Side','Symbol','Qty','Entry Time','Exit Time','Entry NIFTY','Exit NIFTY','Option Entry','Option Exit','PnL','PnL Mode','Exit Reason'];
  var rows = ALL_TRADES_JSON.map(function(t) {
    return [
      t.date||'', t.side||'', t.symbol||'', t.qty||'',
      t.entryTime||'', t.exitTime||'',
      t.spotAtEntry||t.entryPrice||'', t.spotAtExit||t.exitPrice||'',
      t.optionEntryLtp||'', t.optionExitLtp||'',
      t.pnl!=null?t.pnl:'', t.pnlMode||'', t.exitReason||''
    ];
  });
  var csv = [header].concat(rows).map(function(r) {
    return r.map(function(v){ return '"' + String(v||'').replace(/"/g,'""')+'"'; }).join(',');
  }).join('\\n');
  var d = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,\\uFEFF' + encodeURIComponent(csv);
  a.download = 'scalp_paper_history_' + d + '.csv';
  a.click();
}

function confirmReset() {
  showAlert({
    icon: '🗑️',
    title: 'Reset All Scalp Paper History?',
    message: 'This will permanently delete all sessions, trades, and reset capital to ₹${startCap.toLocaleString("en-IN")}. This cannot be undone.',
    btnText: 'Yes, Reset Everything',
    btnClass: 'modal-btn-danger',
    onConfirm: function() {
      fetch('/scalp-paper/reset')
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.success) { window.location.reload(); }
          else { showAlert({icon:'⚠️',title:'Error',message:d.error||'Reset failed',btnClass:'modal-btn-primary'}); }
        })
        .catch(function() { showAlert({icon:'⚠️',title:'Error',message:'Network error',btnClass:'modal-btn-primary'}); });
    }
  });
}
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
});

/**
 * GET /scalp-paper/reset
 * Wipe all scalp paper trade history and reset capital
 */
router.get("/reset", (req, res) => {
  if (state.running) {
    return res.status(400).json({
      success: false,
      error: "Stop scalp paper trading first before resetting.",
    });
  }

  const freshCapital = getScalpCapitalFromEnv();
  saveScalpData({ capital: freshCapital, totalPnl: 0, sessions: [] });

  log(`🔄 Scalp paper trade data reset. Capital restored to ₹${freshCapital.toLocaleString("en-IN")}`);

  return res.json({
    success: true,
    message: `Scalp paper trade history cleared. Capital reset to ₹${freshCapital.toLocaleString("en-IN")}`,
  });
});

module.exports = router;

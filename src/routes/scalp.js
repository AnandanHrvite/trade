/**
 * SCALP LIVE TRADE — /scalp
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses LIVE market data (Fyers WebSocket) and places REAL orders via Fyers.
 * Runs on 3-min candles with the scalp EMA9+RSI strategy.
 * Can run IN PARALLEL with /trade (live Zerodha) or /paperTrade.
 *
 * DATA LAYER  → Fyers (WebSocket ticks — shared with main)
 * ORDER LAYER → Fyers (place_order / exit_position)
 *
 * Routes:
 *   GET /scalp/start   → Start scalp live trading
 *   GET /scalp/stop    → Stop & square off
 *   GET /scalp/status  → Live status page
 *   GET /scalp/exit    → Manual exit current position
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const scalpStrategy    = require("../strategies/scalp_bb_cpr");
const fyersBroker      = require("../services/fyersBroker");
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
const CALLBACK_ID = "SCALP_LIVE";

// ── Module-level config ─────────────────────────────────────────────────────
const SCALP_RES            = parseInt(process.env.SCALP_RESOLUTION || "3", 10);
const _SCALP_MAX_TRADES    = parseInt(process.env.SCALP_MAX_DAILY_TRADES || "30", 10);
const _SCALP_MAX_LOSS      = parseFloat(process.env.SCALP_MAX_DAILY_LOSS || "2000");
const _SCALP_PAUSE_CANDLES = parseInt(process.env.SCALP_SL_PAUSE_CANDLES || "2", 10);
const _SCALP_MAX_SL        = parseFloat(process.env.SCALP_MAX_SL || "300");
const _SCALP_TRAIL_START   = parseFloat(process.env.SCALP_TRAIL_START || "300");
const _SCALP_TRAIL_STEP    = parseFloat(process.env.SCALP_TRAIL_STEP || "200");

// ── Previous day OHLC for CPR (fetched on session start) ────────────────────
let _prevDayOHLC     = null;
let _prevPrevDayOHLC = null;

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
const SL_FILE  = path.join(DATA_DIR, "scalp_live_trades.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadScalpData() {
  ensureDir();
  if (!fs.existsSync(SL_FILE)) {
    const initial = { sessions: [] };
    fs.writeFileSync(SL_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try { return JSON.parse(fs.readFileSync(SL_FILE, "utf-8")); }
  catch (_) { return { sessions: [] }; }
}

function saveScalpSession() {
  if (!state.sessionTrades || state.sessionTrades.length === 0) return;
  try {
    const data = loadScalpData();
    data.sessions.push({
      date:     state.sessionStart,
      strategy: scalpStrategy.NAME,
      pnl:      state.sessionPnl,
      trades:   state.sessionTrades,
    });
    ensureDir();
    fs.writeFileSync(SL_FILE, JSON.stringify(data, null, 2));
    log(`💾 [SCALP-LIVE] Session saved — ${state.sessionTrades.length} trades, PnL: ₹${state.sessionPnl}`);
  } catch (err) {
    log(`⚠️ [SCALP-LIVE] Save failed: ${err.message}`);
  }
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
  _entryPending:  false,
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
  return total >= 555 && total < _ENTRY_STOP_MINS;
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
          log(`📌 [SCALP-LIVE] Option entry LTP: ₹${ltp}`);
        }
      }
      scheduleNext();
    }, 1000); // 1s for live scalp — tight monitoring
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

// ── Order placement (Fyers with duplicate guard) ─────────────────────────────
let _orderInFlight     = false;
let _squareOffInFlight = false;

async function placeOrder(fyersSymbol, side, qty) {
  if (_orderInFlight) {
    log(`⚠️ [SCALP-LIVE] Order in flight — skipping duplicate`);
    return { success: false, reason: "duplicate_guard" };
  }
  _orderInFlight = true;
  const sideLabel = side === 1 ? "BUY" : "SELL";
  log(`📤 [SCALP-LIVE] Placing ${sideLabel} ${qty} × ${fyersSymbol} via Fyers...`);
  try {
    const result = await fyersBroker.placeMarketOrder(
      fyersSymbol, side, qty, "SCALP",
      { isFutures: instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" }
    );
    if (result.success) {
      log(`✅ [SCALP-LIVE] Fyers order filled — ${sideLabel} ${qty} × ${fyersSymbol} | OrderID: ${result.orderId}`);
    } else {
      log(`❌ [SCALP-LIVE] Fyers order FAILED — ${JSON.stringify(result.raw)}`);
    }
    return result;
  } catch (err) {
    log(`❌ [SCALP-LIVE] Order exception: ${err.message}`);
    return { success: false, orderId: null, raw: { error: err.message } };
  } finally {
    setTimeout(() => { _orderInFlight = false; }, 5000);
  }
}

// ── Square off ──────────────────────────────────────────────────────────────

async function squareOff(exitPrice, reason) {
  if (_squareOffInFlight) {
    log(`⚠️ [SCALP-LIVE] squareOff already in progress — ignoring`);
    return;
  }
  if (!state.position) return;
  _squareOffInFlight = true;

  const { symbol, qty, side, entryPrice, entryTime, spotAtEntry,
          optionEntryLtp, optionCurrentLtp } = state.position;
  const isFutures = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const exitOrderSide = (isFutures && side === "PE") ? 1 : -1;

  log(`🔄 [SCALP-LIVE] Square off: ${reason}`);
  const result = await placeOrder(symbol, exitOrderSide, qty);

  if (!result.success) {
    if (result.reason !== "duplicate_guard") {
      log(`🚨 [SCALP-LIVE] EXIT ORDER FAILED — check Fyers dashboard!`);
    }
    _squareOffInFlight = false;
    return;
  }

  const exitOptionLtp = state.optionLtp || optionCurrentLtp;
  let pnl, pnlMode;

  if (isFutures) {
    pnl     = parseFloat(((exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty).toFixed(2));
    pnlMode = "futures";
  } else if (optionEntryLtp && exitOptionLtp) {
    pnl     = parseFloat(((exitOptionLtp - optionEntryLtp) * qty).toFixed(2));
    pnlMode = `option: ₹${optionEntryLtp} → ₹${exitOptionLtp}`;
  } else {
    pnl     = parseFloat(((exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty).toFixed(2));
    pnlMode = "spot proxy";
  }

  const brokerage = isFutures ? 40 : 80;
  const netPnl    = parseFloat((pnl - brokerage).toFixed(2));
  const emoji     = netPnl >= 0 ? "✅" : "❌";
  log(`${emoji} [SCALP-LIVE] Exit: ${reason} | PnL: ₹${netPnl}`);

  state.sessionTrades.push({
    side, symbol, qty, entryPrice, exitPrice,
    spotAtEntry: spotAtEntry || entryPrice,
    spotAtExit: exitPrice,
    optionEntryLtp: optionEntryLtp || null,
    optionExitLtp: exitOptionLtp || null,
    entryTime, exitTime: istNow(),
    pnl: netPnl, pnlMode, exitReason: reason,
  });

  state.sessionPnl = parseFloat((state.sessionPnl + netPnl).toFixed(2));

  stopOptionPolling();
  state.optionSymbol = null;
  state.optionLtp    = null;

  if (reason.includes("SL hit")) {
    state._slPauseUntil = Date.now() + (_SCALP_PAUSE_CANDLES * SCALP_RES * 60 * 1000);
    log(`⏸️ [SCALP-LIVE] SL pause — ${_SCALP_PAUSE_CANDLES} candles`);
  }

  if (state.sessionPnl <= -_SCALP_MAX_LOSS) {
    state._dailyLossHit = true;
    log(`🚨 [SCALP-LIVE] Daily loss limit hit — no more entries`);
  }

  state.position = null;
  _squareOffInFlight = false;

  notifyExit({
    mode: "SCALP-LIVE",
    side, symbol, spotAtExit: exitPrice,
    optionExitLtp: exitOptionLtp, pnl: netPnl, reason,
  });
}

// ── onTick ──────────────────────────────────────────────────────────────────

function onTick(tick) {
  if (!state.running) return;
  const price = tick.ltp;
  if (!price || price <= 0) return;

  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  // Build candle
  const tickMs   = Date.now();
  const bucketMs = getBucketStart(tickMs);

  if (!state.currentBar || state.barStartTime !== bucketMs) {
    if (state.currentBar) {
      state.candles.push({ ...state.currentBar });
      if (state.candles.length > 200) state.candles.shift();
      onCandleClose(state.currentBar);
    }
    state.currentBar   = { time: Math.floor(bucketMs / 1000), open: price, high: price, low: price, close: price };
    state.barStartTime = bucketMs;
  } else {
    state.currentBar.high  = Math.max(state.currentBar.high, price);
    state.currentBar.low   = Math.min(state.currentBar.low, price);
    state.currentBar.close = price;
  }

  // Tick-level exit checks
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

    // 1. MAX SL (₹300) — absolute hard stop, checked FIRST
    if (_SCALP_MAX_SL > 0 && curPnl <= -_SCALP_MAX_SL) {
      squareOff(price, `Max SL ₹${_SCALP_MAX_SL}`);
      return;
    }

    // 2. TRAILING PROFIT — levels: 300, 500, 700, 900...
    if (_SCALP_TRAIL_START > 0 && pos.peakPnl >= _SCALP_TRAIL_START) {
      const levelsAbove = Math.floor((pos.peakPnl - _SCALP_TRAIL_START) / _SCALP_TRAIL_STEP);
      const highestLevel = _SCALP_TRAIL_START + (levelsAbove * _SCALP_TRAIL_STEP);
      const trailFloor = Math.max(0, highestLevel - _SCALP_TRAIL_STEP);
      if (curPnl <= trailFloor) {
        squareOff(price, `Trail profit ₹${trailFloor} (peak ₹${Math.round(pos.peakPnl)})`);
        return;
      }
    }

    // 3. PSAR SL hit (tick-level) — capped at max SL
    if (pos.side === "CE" && price <= pos.stopLoss) {
      const slPnl = _tickPnl(pos.stopLoss);
      if (_SCALP_MAX_SL <= 0 || slPnl >= -_SCALP_MAX_SL) {
        const _isTrail = pos.initialStopLoss != null && Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
        squareOff(pos.stopLoss, `${_isTrail ? "PSAR Trail" : "PSAR"} SL hit`);
      } else {
        squareOff(price, `Max SL ₹${_SCALP_MAX_SL}`);
      }
      return;
    }
    if (pos.side === "PE" && price >= pos.stopLoss) {
      const slPnl = _tickPnl(pos.stopLoss);
      if (_SCALP_MAX_SL <= 0 || slPnl >= -_SCALP_MAX_SL) {
        const _isTrail = pos.initialStopLoss != null && Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
        squareOff(pos.stopLoss, `${_isTrail ? "PSAR Trail" : "PSAR"} SL hit`);
      } else {
        squareOff(price, `Max SL ₹${_SCALP_MAX_SL}`);
      }
      return;
    }

    // EOD
    if (getISTMinutes() >= _STOP_MINS - 10) {
      squareOff(price, "EOD square-off");
      return;
    }
  }
}

// ── onCandleClose ───────────────────────────────────────────────────────────

function onCandleClose(bar) {
  if (!state.running) return;

  if (state.position) {
    state.position.candlesHeld = (state.position.candlesHeld || 0) + 1;

    const window = [...state.candles];
    if (state.currentBar) window.push(state.currentBar);

    // PSAR flip → exit on reversal signal
    if (window.length >= 15 && scalpStrategy.isPSARFlip(window, state.position.side)) {
      squareOff(bar.close, "PSAR flip");
      return;
    }

    // Update PSAR trailing SL (tighten only)
    if (window.length >= 15) {
      const newSL = scalpStrategy.updateTrailingSL(window, state.position.stopLoss, state.position.side);
      if (newSL !== state.position.stopLoss) {
        log(`📐 [SCALP-LIVE] PSAR trail SL: ₹${state.position.stopLoss} → ₹${newSL}`);
        state.position.stopLoss = newSL;
      }
    }

    return;
  }

  // Entry
  if (!isMarketHours()) return;
  if (state._dailyLossHit) return;
  if (state._entryPending) return;
  if (state.sessionTrades.length >= _SCALP_MAX_TRADES) return;
  if (state._slPauseUntil && Date.now() < state._slPauseUntil) return;
  if (!_prevDayOHLC) return;

  // VIX
  if (process.env.SCALP_VIX_ENABLED === "true") {
    const vix = getCachedVix();
    if (vix) {
      const vixMax = parseFloat(process.env.VIX_MAX_ENTRY || "20");
      if (vix.value > vixMax) return;
    }
  }

  const window = [...state.candles];
  if (window.length < 30) return;

  const result = scalpStrategy.getSignal(window, {
    silent: false,
    prevDayOHLC: _prevDayOHLC,
    prevPrevDayOHLC: _prevPrevDayOHLC,
  });
  if (result.signal === "NONE") return;

  const side = result.signal === "BUY_CE" ? "CE" : "PE";
  const spot = bar.close;

  resolveAndEnter(side, spot, result);
}

async function resolveAndEnter(side, spot, result) {
  if (state._entryPending || state.position) return;
  state._entryPending = true;

  try {
    // Check SCALP_ENABLED
    if (process.env.SCALP_ENABLED !== "true") {
      log(`⚠️ [SCALP-LIVE] SCALP_ENABLED is not true — skipping entry`);
      return;
    }

    const optionInfo = await validateAndGetOptionSymbol(spot, side);
    if (optionInfo.invalid) {
      log(`⚠️ [SCALP-LIVE] Option symbol invalid — skipping`);
      return;
    }

    const qty    = getLotQty();
    const symbol = optionInfo.symbol;

    // Place BUY order via Fyers
    const orderResult = await placeOrder(symbol, 1, qty);
    if (!orderResult.success) {
      log(`❌ [SCALP-LIVE] Entry order failed — skipping trade`);
      return;
    }

    state.position = {
      side,
      symbol,
      qty,
      entryPrice:       spot,
      spotAtEntry:      spot,
      entryTime:        istNow(),
      reason:           result.reason,
      stopLoss:         result.stopLoss,
      initialStopLoss:  result.stopLoss,
      target:           result.target,
      bestPrice:        null,
      candlesHeld:      0,
      peakPnl:          0,
      optionEntryLtp:   null,
      optionCurrentLtp: null,
    };

    state.optionSymbol = symbol;
    if (instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES") {
      startOptionPolling(symbol);
    }

    log(`📝 [SCALP-LIVE] BUY ${qty} × ${symbol} @ ₹${spot} | SL: ₹${result.stopLoss} | PSAR trail`);

    notifyEntry({
      mode: "SCALP-LIVE",
      side, symbol, spotAtEntry: spot,
      stopLoss: result.stopLoss, qty, reason: result.reason,
    });
  } catch (err) {
    log(`⚠️ [SCALP-LIVE] Entry failed: ${err.message}`);
  } finally {
    setTimeout(() => { state._entryPending = false; }, 5000);
  }
}

// ── Pre-load history ────────────────────────────────────────────────────────

async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached(
      NIFTY_INDEX_SYMBOL, String(SCALP_RES), today, today,
      `scalp_live_${SCALP_RES}m`
    );
    if (candles && candles.length > 0) {
      state.candles = candles.slice(-99);
      log(`📦 [SCALP-LIVE] Pre-loaded ${state.candles.length} × ${SCALP_RES}-min candles`);
    }
  } catch (err) {
    log(`⚠️ [SCALP-LIVE] Pre-load failed: ${err.message}`);
  }

  // Fetch previous day(s) OHLC for CPR calculation
  try {
    const { fetchCandles } = require("../services/backtestEngine");
    const todayDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const fiveDaysAgo = new Date(Date.now() - 7 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const dailyCandles = await fetchCandles(NIFTY_INDEX_SYMBOL, "D", fiveDaysAgo, todayDate);
    if (dailyCandles && dailyCandles.length >= 2) {
      const sorted = dailyCandles.sort((a, b) => a.time - b.time);
      const pastDays = sorted.filter(c => {
        const d = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        return d < todayDate;
      });
      if (pastDays.length >= 1) {
        const prev = pastDays[pastDays.length - 1];
        _prevDayOHLC = { high: prev.high, low: prev.low, close: prev.close };
        log(`📊 [SCALP-LIVE] Prev day OHLC: H=${prev.high} L=${prev.low} C=${prev.close}`);
      }
      if (pastDays.length >= 2) {
        const pp = pastDays[pastDays.length - 2];
        _prevPrevDayOHLC = { high: pp.high, low: pp.low, close: pp.close };
      }

      if (_prevDayOHLC) {
        const cpr = scalpStrategy.calcCPR(_prevDayOHLC.high, _prevDayOHLC.low, _prevDayOHLC.close);
        const narrow = scalpStrategy.isNarrowCPR(cpr);
        log(`📊 [SCALP-LIVE] CPR: TC=${cpr.tc} BC=${cpr.bc} Width=${cpr.width} ${narrow ? "✅ NARROW (trending)" : "❌ WIDE (skip entries)"}`);
      }
    } else {
      log(`⚠️ [SCALP-LIVE] Not enough daily candles for CPR — entries blocked`);
    }
  } catch (err) {
    log(`⚠️ [SCALP-LIVE] CPR data fetch failed: ${err.message}`);
  }
}

// ── Auto-stop ───────────────────────────────────────────────────────────────
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
    stopFn("⏰ [SCALP-LIVE] Auto-stop reached");
  }, ms);
  log(`⏰ [SCALP-LIVE] Auto-stop in ${Math.round(ms / 60000)} min`);
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
${buildSidebar('scalpLive', false)}
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
  if (state.running) return res.redirect("/scalp/status");

  const check = sharedSocketState.canStart("SCALP_LIVE");
  if (!check.allowed) {
    return res.status(409).send(errorPage("Cannot Start", check.reason, "/scalp/status", "\u2190 Back"));
  }

  if (!process.env.ACCESS_TOKEN) {
    return res.status(401).send(errorPage("Not Authenticated", "Fyers not logged in. Login first.", "/auth", "Login with Fyers"));
  }

  if (!fyersBroker.isAuthenticated()) {
    return res.status(401).send(errorPage("Not Authenticated", "Fyers not authenticated for orders. Login first.", "/auth", "Login with Fyers"));
  }

  if (process.env.SCALP_ENABLED !== "true") {
    return res.status(400).send(errorPage("Scalp Disabled", "SCALP_ENABLED is not true. Enable it in Settings first.", "/settings", "Open Settings"));
  }

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) {
    return res.status(400).send(errorPage("Trading Not Allowed", holiday.reason, "/scalp/status", "\u2190 Back"));
  }

  if (!isStartAllowed()) {
    return res.status(400).send(errorPage("Session Closed", "Past stop time \u2014 cannot start today.", "/scalp/status", "\u2190 Back"));
  }

  // Reset state
  state = {
    running: true, position: null, candles: [], currentBar: null, barStartTime: null,
    log: [], sessionTrades: [], sessionStart: new Date().toISOString(),
    sessionPnl: 0, tickCount: 0, lastTickTime: null, lastTickPrice: null,
    optionLtp: null, optionSymbol: null, _slPauseUntil: null,
    _dailyLossHit: false, _entryPending: false,
  };

  sharedSocketState.setScalpActive("SCALP_LIVE");

  await preloadHistory();

  if (process.env.SCALP_VIX_ENABLED === "true") {
    resetVixCache();
    fetchLiveVix().catch(() => {});
  }

  // Socket: piggyback or start own
  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [SCALP-LIVE] Piggybacking on existing WebSocket");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [SCALP-LIVE] Started WebSocket");
  }

  scheduleAutoStop((msg) => {
    log(msg);
    stopSession();
  });

  log(`🟢 [SCALP-LIVE] Session started — ${SCALP_RES}-min candles | Fyers orders`);
  res.redirect("/scalp/status");
});

function stopSession() {
  if (!state.running) return;

  if (state.position) {
    squareOff(state.lastTickPrice || state.position.entryPrice, "Session stopped");
  }

  state.running = false;
  stopOptionPolling();
  socketManager.removeCallback(CALLBACK_ID);

  if (!sharedSocketState.isActive()) {
    // No primary mode — check if we should stop socket
    // Only stop if we're the last user
    const otherScalp = sharedSocketState.getScalpMode();
    if (!otherScalp || otherScalp === "SCALP_LIVE") {
      socketManager.stop();
    }
  }

  sharedSocketState.clearScalp();
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  saveScalpSession();
  log("🔴 [SCALP-LIVE] Session stopped");
}

router.get("/stop", (req, res) => {
  stopSession();
  res.redirect("/scalp/status");
});

router.get("/exit", (req, res) => {
  if (state.position) {
    squareOff(state.lastTickPrice || state.position.entryPrice, "Manual exit");
  }
  res.redirect("/scalp/status");
});

// ── Status data ─────────────────────────────────────────────────────────────

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const unrealised = pos
    ? parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * (pos.qty || getLotQty())).toFixed(2))
    : 0;

  res.json({
    running:       state.running,
    tickCount:     state.tickCount,
    lastTickPrice: state.lastTickPrice,
    lastTickTime:  state.lastTickTime ? new Date(state.lastTickTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : null,
    candleCount:   state.candles.length,
    currentBar:    state.currentBar,
    position:      pos ? {
      side: pos.side, symbol: pos.symbol, entryPrice: pos.entryPrice,
      stopLoss: pos.stopLoss, target: pos.target, bestPrice: pos.bestPrice,
      candlesHeld: pos.candlesHeld,
      optionEntryLtp: pos.optionEntryLtp, optionCurrentLtp: pos.optionCurrentLtp,
    } : null,
    sessionPnl:    state.sessionPnl,
    unrealised,
    totalPnl:      parseFloat((state.sessionPnl + unrealised).toFixed(2)),
    trades:        state.sessionTrades.length,
    wins:          state.sessionTrades.filter(t => t.pnl > 0).length,
    losses:        state.sessionTrades.filter(t => t.pnl <= 0).length,
    log:           state.log.slice(-50),
    dailyLossHit:  state._dailyLossHit,
  });
});

// ── Status page ─────────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";
  const fyersOk    = !!process.env.ACCESS_TOKEN;

  const _vix         = getCachedVix();
  const _vixEnabled  = process.env.SCALP_VIX_ENABLED === "true";
  const _vixMaxEntry = parseFloat(process.env.VIX_MAX_ENTRY || "20");

  const pos = state.position;
  const isFutures = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";

  // Unrealised PnL
  let unrealisedPnl = 0;
  if (pos && state.lastTickPrice) {
    if (isFutures) {
      unrealisedPnl = parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * pos.qty).toFixed(2));
    } else {
      const cur = state.optionLtp || pos.optionCurrentLtp;
      if (pos.optionEntryLtp && cur && pos.optionEntryLtp > 0) {
        unrealisedPnl = parseFloat(((cur - pos.optionEntryLtp) * pos.qty).toFixed(2));
      } else {
        unrealisedPnl = parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * pos.qty).toFixed(2));
      }
    }
  }

  const inr = (n) => typeof n === "number" ? "\u20b9" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "\u2014";

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl <= 0).length;

  const optEntryLtp   = pos ? (pos.optionEntryLtp   || null) : null;
  const optCurrentLtp = pos ? (state.optionLtp || pos.optionCurrentLtp || null) : null;
  const optPremiumPnl = (optEntryLtp && optCurrentLtp)
    ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0)).toFixed(2))
    : null;
  const optPremiumMove = (optEntryLtp && optCurrentLtp)
    ? parseFloat((optCurrentLtp - optEntryLtp).toFixed(2))
    : null;

  const tradesJson = JSON.stringify([...state.sessionTrades].reverse().map(t => ({
    side:       t.side || "",
    symbol:     t.symbol || "",
    entry:      t.entryTime || "",
    exit:       t.exitTime || "",
    entryPrice: t.spotAtEntry || t.entryPrice || 0,
    exitPrice:  t.spotAtExit || t.exitPrice || 0,
    optEntry:   t.optionEntryLtp || null,
    optExit:    t.optionExitLtp || null,
    pnl:        typeof t.pnl === "number" ? t.pnl : null,
    pnlMode:    t.pnlMode || "",
    reason:     t.exitReason || "",
  })));

  const logsJson = JSON.stringify(state.log.slice(-200));

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Scalp Live \u2014 ${scalpStrategy.NAME}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u26a1</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
${sidebarCSS()}
${modalCSS()}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'IBM Plex Sans',sans-serif;background:#060810;color:#c0d0e8;min-height:100vh;display:flex;flex-direction:column;}
.main-content{margin-left:200px;flex:1;display:flex;flex-direction:column;min-height:100vh;}
@media(max-width:900px){.main-content{margin-left:0;}}

/* Top bar */
.top-bar{background:#040c18;border-bottom:1px solid #0e1e36;padding:10px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50;flex-wrap:wrap;gap:8px;}
.top-bar-title{font-size:0.88rem;font-weight:700;color:#e0eaf8;}
.top-bar-meta{font-size:0.65rem;color:#2a4060;margin-top:1px;}
.top-bar-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.top-bar-badge{display:flex;align-items:center;gap:5px;font-size:0.6rem;font-weight:700;padding:3px 9px;border-radius:4px;border:0.5px solid rgba(59,130,246,0.3);background:rgba(59,130,246,0.1);color:#60a5fa;}
.top-bar-badge.live-active{border-color:rgba(239,68,68,0.3);background:rgba(239,68,68,0.1);color:#ef4444;animation:pulse 1.2s infinite;}

/* Broker badges */
.broker-badges{display:flex;gap:6px;padding:8px 24px;background:#040c18;border-bottom:1px solid #0e1e36;}
.broker-badge{font-size:0.65rem;font-weight:600;padding:3px 10px;border-radius:5px;}
.broker-badge.ok{background:#060e20;border:0.5px solid #0e2850;color:#60a5fa;}
.broker-badge.err{background:#160608;border:0.5px solid #3a1020;color:#f87171;}

/* Page container */
.page{padding:24px;padding-bottom:60px;}
.page-header{margin-bottom:20px;}
.page-status-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
.page-status-dot{width:7px;height:7px;border-radius:50%;background:#2a4060;}
.page-status-dot.running{background:#ef4444;animation:pulse 1.5s infinite;}
.page-status-text{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#2a4060;}
.page-status-text.running{color:#ef4444;}

/* Stat grid */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;margin-bottom:20px;}
.sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:9px;padding:14px 16px;position:relative;overflow:hidden;}
.sc-label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:#1e3050;margin-bottom:6px;}
.sc-val{font-size:1.1rem;font-weight:700;color:#e0eaf8;font-family:'IBM Plex Mono',monospace;}

/* Section title */
.section-title{font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:1.8px;color:#1e3050;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
.section-title::after{content:'';flex:1;height:0.5px;background:#0e1e36;}

/* Action buttons */
.action-btn{padding:9px 20px;border-radius:8px;border:none;font-weight:700;font-size:0.8rem;cursor:pointer;font-family:inherit;transition:all 0.15s;display:inline-flex;align-items:center;gap:6px;}
.start-btn{background:#1e40af;color:#fff;border:1px solid #2563eb;}.start-btn:hover{background:#2563eb;}
.stop-btn{background:#7f1d1d;color:#fca5a5;border:1px solid #ef4444;}.stop-btn:hover{background:#991b1b;}
.exit-btn{background:#78350f;color:#fde68a;border:1px solid #f59e0b;}.exit-btn:hover{background:#92400e;}
.real-warn{display:inline-flex;align-items:center;gap:4px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#ef4444;font-size:0.6rem;font-weight:700;padding:3px 9px;border-radius:5px;letter-spacing:0.8px;animation:pulse 2s infinite;}

/* Animations */
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

/* Trade table */
.trade-table{width:100%;border-collapse:collapse;}
.trade-table th{padding:9px 12px;text-align:left;font-size:0.55rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#060c18;cursor:pointer;user-select:none;white-space:nowrap;}
.trade-table td{padding:8px 12px;border-top:1px solid #0e1e36;font-size:0.78rem;font-family:'IBM Plex Mono',monospace;vertical-align:top;}

/* Log viewer */
.log-entry{padding:4px 0;border-bottom:1px solid #0a1424;font-size:0.7rem;font-family:'IBM Plex Mono',monospace;line-height:1.45;}

/* Responsive */
@media(max-width:700px){.stat-grid{grid-template-columns:1fr 1fr;}.page{padding:14px;}}

/* Toast */
.scalp-toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#0d1320;padding:12px 24px;border-radius:10px;font-size:0.85rem;font-weight:700;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,0.6);letter-spacing:0.5px;animation:fadeIn 0.2s ease;}

/* Confirm modal */
.confirm-overlay{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.85);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;}
.confirm-box{background:#0d1320;border:2px solid #7f1d1d;border-radius:16px;padding:28px 32px;max-width:420px;width:100%;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,0.9);}
.confirm-title{font-size:1rem;font-weight:700;color:#ef4444;margin-bottom:10px;}
.confirm-msg{font-size:0.82rem;color:#8899aa;margin-bottom:20px;line-height:1.6;}
.confirm-btns{display:flex;gap:10px;justify-content:center;}
.confirm-btns button{padding:9px 22px;border-radius:8px;font-weight:700;font-size:0.82rem;cursor:pointer;border:none;font-family:inherit;}
</style></head><body>
<div class="app-shell">
${buildSidebar('scalpLive', liveActive, state.running)}
<div class="main-content">

<!-- TOP BAR -->
<div class="top-bar">
  <div>
    <div class="top-bar-title">Scalp Live Trade</div>
    <div class="top-bar-meta">${scalpStrategy.NAME} \u00b7 ${SCALP_RES}-min candles \u00b7 SL ${_SCALP_SL_PTS}pt \u00b7 TGT ${_SCALP_TARGET_PTS}pt \u00b7 Trail ${_SCALP_TRAIL_AFTER}pt+${_SCALP_TRAIL_GAP}gap \u00b7 ${state.running ? "Auto-refreshes 2s" : "Not refreshing"}</div>
  </div>
  <div class="top-bar-right">
    ${state.running
      ? '<span class="top-bar-badge live-active"><span style="width:5px;height:5px;border-radius:50%;background:#ef4444;display:inline-block;"></span> SCALP LIVE</span>'
      : '<span class="top-bar-badge">\u25cf STOPPED</span>'}
    ${_vixEnabled
      ? `<span class="top-bar-badge" style="border-color:${_vix == null ? 'rgba(100,116,139,0.3)' : _vix.value > _vixMaxEntry ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)'};background:${_vix == null ? 'rgba(100,116,139,0.08)' : _vix.value > _vixMaxEntry ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)'};color:${_vix == null ? '#94a3b8' : _vix.value > _vixMaxEntry ? '#ef4444' : '#10b981'};">\uD83C\uDF21\uFE0F VIX ${_vix != null ? _vix.value.toFixed(1) : 'n/a'}${_vix != null ? (_vix.value > _vixMaxEntry ? ' \u00b7 BLOCKED' : ' \u00b7 OK') : ''}</span>`
      : ''}
  </div>
</div>

<!-- BROKER BADGES -->
<div class="broker-badges">
  <span class="broker-badge ${fyersOk ? 'ok' : 'err'}">${fyersOk ? '\u25cf Fyers \u00b7 Data + Orders' : '\u2715 Fyers \u00b7 Not Connected'}</span>
</div>

<!-- PAGE -->
<div class="page">
  <div class="page-header">
    <div class="page-status-row">
      <span class="page-status-dot ${state.running ? 'running' : ''}"></span>
      <span class="page-status-text ${state.running ? 'running' : ''}">${state.running ? 'SCALP LIVE ACTIVE' : 'STOPPED'}</span>
    </div>
  </div>

  <!-- ACTION BUTTONS -->
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
    ${state.running
      ? `<button class="action-btn stop-btn" onclick="scalpConfirm('Stop scalp live trading?','Stopping will square off any open position.','#7f1d1d',function(){location='/scalp/stop'});">\u25a0 Stop Trading</button>
         <button class="action-btn exit-btn" onclick="scalpConfirm('Exit current position?','This will immediately exit via Fyers market order.','#78350f',function(){location='/scalp/exit';});">\uD83D\uDEAA Exit Position</button>`
      : `<button class="action-btn start-btn" onclick="scalpConfirm('\u26a0\ufe0f Start SCALP LIVE Trading?','This will place REAL orders on Fyers with REAL money. Ensure you have sufficient margin.','#1e40af',function(){location='/scalp/start';});">\u25b6 Start Scalp Live</button>
         <span class="real-warn">\u26a0 REAL ORDERS \u2014 Live Money</span>`}
  </div>

  <!-- STAT GRID -->
  <div class="stat-grid">
    <div class="sc" style="border-top:2px solid ${state.sessionPnl >= 0 ? '#10b981' : '#ef4444'};">
      <div class="sc-label">Session PnL</div>
      <div class="sc-val" id="ax-session-pnl" style="color:${state.sessionPnl >= 0 ? '#10b981' : '#ef4444'};">${state.sessionPnl >= 0 ? '+' : ''}${inr(state.sessionPnl)}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${unrealisedPnl >= 0 ? '#3b82f6' : '#ef4444'};">
      <div class="sc-label">Unrealised PnL</div>
      <div class="sc-val" id="ax-unreal-pnl" style="color:${unrealisedPnl >= 0 ? '#3b82f6' : '#ef4444'};">${pos ? ((unrealisedPnl >= 0 ? '+' : '') + inr(unrealisedPnl)) : '\u2014'}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #8b5cf6;">
      <div class="sc-label">Trades (W/L)</div>
      <div class="sc-val"><span id="ax-trade-count">${state.sessionTrades.length}</span> <span style="font-size:0.75rem;color:#4a6080;">/ ${_SCALP_MAX_TRADES}</span></div>
      <div id="ax-wl" style="font-size:0.7rem;color:#4a6080;margin-top:4px;">${wins}W \u00b7 ${losses}L</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #3b82f6;">
      <div class="sc-label">Ticks / Candles</div>
      <div class="sc-val" id="ax-tick-count">${state.tickCount.toLocaleString()}</div>
      <div id="ax-candle-count" style="font-size:0.7rem;color:#4a6080;margin-top:4px;">${state.candles.length} candles ${state.candles.length >= 15 ? '\u2705' : '\u26a0\ufe0f warming'}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${state._dailyLossHit ? '#ef4444' : '#10b981'};">
      <div class="sc-label">Daily Loss Limit</div>
      <div class="sc-val" style="color:${state._dailyLossHit ? '#ef4444' : '#fff'};">${inr(-_SCALP_MAX_LOSS)}</div>
      <div id="ax-daily-loss" style="font-size:0.7rem;margin-top:4px;color:${state._dailyLossHit ? '#ef4444' : '#10b981'};">${state._dailyLossHit ? '\uD83D\uDED1 KILLED' : '\u2705 Active'}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #f59e0b;">
      <div class="sc-label">NIFTY Spot LTP</div>
      <div class="sc-val" id="ax-ltp">${state.lastTickPrice ? inr(state.lastTickPrice) : '\u2014'}</div>
      <div id="ax-last-tick-time" style="font-size:0.68rem;color:#4a6080;margin-top:4px;">${state.lastTickTime ? new Date(state.lastTickTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : ''}</div>
    </div>
  </div>

  <!-- POSITION CARD -->
  <div style="margin-bottom:24px;">
    <div class="section-title">Current Position</div>
    <div id="ax-position-section">
    ${pos ? `
      <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;animation:fadeIn 0.3s ease;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="width:10px;height:10px;border-radius:50%;background:#ef4444;display:inline-block;animation:pulse 1.5s infinite;"></span>
            <span style="font-size:0.8rem;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:1px;">\u26a1 LIVE Position</span>
            <span style="font-size:0.72rem;color:#4a6080;">Since ${pos.entryTime}</span>
          </div>
        </div>
        <!-- Position identity -->
        <div style="background:#071a12;border:1px solid #134e35;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
          <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:2.2rem;font-weight:900;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${isFutures ? (pos.side === "CE" ? "LONG" : "SHORT") : pos.side}</span>
              <div>
                <div style="font-size:0.72rem;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${isFutures ? (pos.side === "CE" ? "FUTURES \u00b7 Bullish" : "FUTURES \u00b7 Bearish") : (pos.side === "CE" ? "CALL \u00b7 Bullish" : "PUT \u00b7 Bearish")}</div>
              </div>
            </div>
            <div style="width:1px;height:44px;background:#134e35;"></div>
            <div>
              <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Qty</div>
              <div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty}</div>
            </div>
            <div style="width:1px;height:44px;background:#134e35;flex-shrink:0;"></div>
            <div style="flex:1;min-width:180px;">
              <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Symbol</div>
              <div style="font-size:0.8rem;font-weight:600;color:#c8d8f0;font-family:monospace;word-break:break-all;">${pos.symbol}</div>
            </div>
          </div>
        </div>
        <!-- Price grid -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px;">
          <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY Entry</div>
            <div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(pos.entryPrice)}</div>
          </div>
          <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Option LTP (Entry)</div>
            <div id="ax-pos-opt-entry" style="font-size:1.05rem;font-weight:700;color:#60a5fa;">${optEntryLtp ? inr(optEntryLtp) : '\u23f3 Fetching...'}</div>
          </div>
          <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop Loss</div>
            <div id="ax-pos-sl" style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.stopLoss ? inr(pos.stopLoss) : '\u2014'}</div>
          </div>
          <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Target</div>
            <div style="font-size:1.05rem;font-weight:700;color:#10b981;">${inr(pos.target)}</div>
          </div>
          <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Best Price</div>
            <div id="ax-pos-best" style="font-size:1.05rem;font-weight:700;color:#8b5cf6;">${pos.bestPrice ? inr(pos.bestPrice) : '\u2014'}</div>
          </div>
          <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Candles Held</div>
            <div id="ax-pos-candles" style="font-size:1.05rem;font-weight:700;color:#fff;">${pos.candlesHeld || 0} <span style="font-size:0.72rem;color:#4a6080;">/ ${_SCALP_TIME_STOP}</span></div>
          </div>
          <div style="background:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? '#071a0f' : '#1a0707') : '#0d1320'};border:2px solid ${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? '#10b981' : '#ef4444') : '#1a2236'};border-radius:8px;padding:12px 14px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Option LTP (Now)</div>
            <div id="ax-pos-opt-now" style="font-size:1.05rem;font-weight:700;color:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? '#10b981' : '#ef4444') : '#fff'};">${optCurrentLtp ? inr(optCurrentLtp) : '\u23f3'}</div>
            <div id="ax-pos-opt-move" style="font-size:0.68rem;font-weight:700;margin-top:3px;color:${optPremiumMove !== null ? (optPremiumMove >= 0 ? '#10b981' : '#ef4444') : '#4a6080'};">
              ${optPremiumMove !== null ? (optPremiumMove >= 0 ? '\u25b2 +' : '\u25bc ') + '\u20b9' + Math.abs(optPremiumMove).toFixed(2) + ' pts' : '\u23f3'}
            </div>
          </div>
          <div style="background:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? '#071a0f' : '#1a0707') : '#0d1320'};border:1px solid ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? '#065f46' : '#7f1d1d') : '#1a2236'};border-radius:8px;padding:12px 14px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Unrealised P&L</div>
            <div id="ax-pos-pnl" style="font-size:1.3rem;font-weight:800;color:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? '#10b981' : '#ef4444') : '#fff'};font-family:monospace;">
              ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? '+' : '') + inr(optPremiumPnl) : '\u2014'}
            </div>
          </div>
        </div>
      </div>
    ` : '<div style="background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:18px 24px;color:#2a4060;font-size:0.82rem;">No open position. Waiting for signal...</div>'}
    </div>
  </div>

  <!-- SESSION TRADES TABLE -->
  <div style="margin-bottom:24px;">
    <div class="section-title" style="margin-bottom:0;">Session Trades</div>
    <div style="margin-top:10px;">
    ${state.sessionTrades.length === 0
      ? '<div style="background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:16px 24px;color:#2a4060;font-size:0.82rem;">No completed trades this session.</div>'
      : `<div style="border:1px solid #0e1e36;border-radius:12px;overflow:hidden;overflow-x:auto;">
          <table class="trade-table">
            <thead><tr>
              <th>Side</th>
              <th>Entry Time</th>
              <th>Exit Time</th>
              <th>Entry Price</th>
              <th>Exit Price</th>
              <th>Net P&amp;L \u20b9</th>
              <th>Exit Reason</th>
            </tr></thead>
            <tbody id="scalp-trades-body"></tbody>
          </table>
        </div>
        <div style="background:#060c18;border:1px solid #0e1e36;border-radius:8px;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;margin-top:10px;">
          <span style="font-size:0.75rem;color:#c8d8f0;font-weight:700;">Session P&L</span>
          <span id="ax-session-pnl-bar" style="font-size:1.1rem;font-weight:800;color:${state.sessionPnl >= 0 ? '#10b981' : '#ef4444'};">${state.sessionPnl >= 0 ? '+' : ''}${inr(state.sessionPnl)}</span>
        </div>`}
    </div>
  </div>

  <!-- LOG VIEWER -->
  <div style="margin-bottom:24px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
      <div class="section-title" style="margin-bottom:0;">Activity Log</div>
      <input id="logSearch" placeholder="Search log\u2026" oninput="logFilter()"
        style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 9px;border-radius:6px;font-size:0.73rem;font-family:inherit;width:180px;"/>
      <span id="logCount" style="font-size:0.7rem;color:#4a6080;"></span>
    </div>
    <div id="logBox" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:12px 16px;max-height:360px;overflow-y:auto;"></div>
  </div>

  <p style="font-size:0.72rem;color:#2a4060;margin-top:8px;">\uD83D\uDD04 Auto-refreshes every 2 seconds while trading is active</p>
</div><!-- .page -->
</div><!-- .main-content -->
</div><!-- .app-shell -->

<!-- Trade data -->
<script id="scalp-trade-data" type="application/json">${tradesJson}</script>
<script id="scalp-log-data" type="application/json">${logsJson}</script>

<script>
${modalJS()}

/* ── Confirm dialog ── */
function scalpConfirm(title, msg, color, onYes) {
  var overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = '<div class="confirm-box">'
    + '<div class="confirm-title">' + title + '</div>'
    + '<div class="confirm-msg">' + msg + '</div>'
    + '<div class="confirm-btns">'
    + '<button id="sc-cancel" style="background:#1a2236;color:#c8d8f0;">Cancel</button>'
    + '<button id="sc-confirm" style="background:' + color + ';color:#fff;">Confirm</button>'
    + '</div></div>';
  document.body.appendChild(overlay);
  overlay.querySelector('#sc-cancel').onclick = function() { overlay.remove(); };
  overlay.querySelector('#sc-confirm').onclick = function() { overlay.remove(); onYes(); };
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
}

/* ── Toast ── */
function scalpToast(msg, color) {
  var t = document.createElement('div');
  t.className = 'scalp-toast';
  t.textContent = msg;
  t.style.border = '1px solid ' + color;
  t.style.color = color;
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 3500);
}

/* ── Format helpers ── */
var INR = function(n) { return typeof n === 'number' ? '\u20b9' + n.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2}) : '\u2014'; };
var PNL_COLOR = function(n) { return n >= 0 ? '#10b981' : '#ef4444'; };

/* ── Trades table ── */
var SCALP_TRADES = JSON.parse(document.getElementById('scalp-trade-data').textContent);
function renderTrades() {
  var el = document.getElementById('scalp-trades-body');
  if (!el || SCALP_TRADES.length === 0) return;
  el.innerHTML = SCALP_TRADES.map(function(t) {
    var sc = t.side === 'CE' ? '#10b981' : '#ef4444';
    var pc = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
    var short = t.reason.length > 40 ? t.reason.slice(0, 40) + '\u2026' : t.reason;
    return '<tr>'
      + '<td style="color:' + sc + ';font-weight:800;">' + (t.side || '\u2014') + '</td>'
      + '<td style="font-size:0.75rem;">' + (t.entry || '\u2014') + '</td>'
      + '<td style="font-size:0.75rem;">' + (t.exit || '\u2014') + '</td>'
      + '<td>' + INR(t.entryPrice) + (t.optEntry ? '<div style="font-size:0.65rem;color:#60a5fa;margin-top:2px;">Opt: ' + INR(t.optEntry) + '</div>' : '') + '</td>'
      + '<td>' + INR(t.exitPrice) + (t.optExit ? '<div style="font-size:0.65rem;color:#60a5fa;margin-top:2px;">Opt: ' + INR(t.optExit) + '</div>' : '') + '</td>'
      + '<td style="font-size:1rem;font-weight:800;color:' + pc + ';">' + (t.pnl != null ? (t.pnl >= 0 ? '+' : '') + INR(t.pnl) : '\u2014') + '</td>'
      + '<td style="font-size:0.7rem;color:#4a6080;" title="' + t.reason + '">' + short + '</td>'
      + '</tr>';
  }).join('');
}
renderTrades();

/* ── Log viewer ── */
var LOG_ALL = JSON.parse(document.getElementById('scalp-log-data').textContent);
var logFiltered = LOG_ALL.slice();
function logFilter() {
  var s = document.getElementById('logSearch').value.toLowerCase();
  logFiltered = LOG_ALL.filter(function(l) {
    return !s || l.toLowerCase().indexOf(s) >= 0;
  });
  logRender();
}
function logRender() {
  var box = document.getElementById('logBox');
  var cnt = document.getElementById('logCount');
  if (cnt) cnt.textContent = logFiltered.length + ' of ' + LOG_ALL.length;
  if (!box) return;
  if (logFiltered.length === 0) {
    box.innerHTML = '<div style="color:#2a4060;font-size:0.78rem;">No entries match.</div>';
    return;
  }
  box.innerHTML = logFiltered.map(function(l) {
    var c = l.indexOf('\u274c') >= 0 ? '#ef4444' : l.indexOf('\u2705') >= 0 ? '#10b981' : l.indexOf('\uD83D\uDEA8') >= 0 ? '#f59e0b' : l.indexOf('\u26a1') >= 0 || l.indexOf('\uD83D\uDCDD') >= 0 ? '#3b82f6' : '#4a6080';
    return '<div class="log-entry" style="color:' + c + ';">' + l + '</div>';
  }).join('');
  box.scrollTop = box.scrollHeight;
}
logRender();

/* ── AJAX Polling ── */
var _lastHasPos = ${pos ? 'true' : 'false'};
var _lastTradeCount = ${state.sessionTrades.length};

function poll() {
  fetch('/scalp/status/data', { cache: 'no-store' }).then(function(r) { return r.json(); }).then(function(d) {

    // Reload on position state change or new trades
    var nowHasPos = !!d.position;
    if (nowHasPos !== _lastHasPos || d.trades !== _lastTradeCount) {
      _lastHasPos = nowHasPos;
      _lastTradeCount = d.trades;
      window.location.reload();
      return;
    }

    // Session PnL
    var spEl = document.getElementById('ax-session-pnl');
    if (spEl) {
      spEl.textContent = (d.totalPnl >= 0 ? '+' : '') + INR(d.totalPnl);
      spEl.style.color = PNL_COLOR(d.totalPnl);
      var card = spEl.closest('.sc');
      if (card) card.style.borderTopColor = PNL_COLOR(d.totalPnl);
    }
    var spBar = document.getElementById('ax-session-pnl-bar');
    if (spBar) {
      spBar.textContent = (d.totalPnl >= 0 ? '+' : '') + INR(d.totalPnl);
      spBar.style.color = PNL_COLOR(d.totalPnl);
    }

    // Unrealised
    var upEl = document.getElementById('ax-unreal-pnl');
    if (upEl) {
      if (d.position) {
        upEl.textContent = (d.unrealised >= 0 ? '+' : '') + INR(d.unrealised);
        upEl.style.color = PNL_COLOR(d.unrealised);
      } else {
        upEl.textContent = '\u2014';
        upEl.style.color = '#4a6080';
      }
    }

    // Trade count
    var tcEl = document.getElementById('ax-trade-count');
    if (tcEl) tcEl.textContent = d.trades;
    var wlEl = document.getElementById('ax-wl');
    if (wlEl) wlEl.textContent = d.wins + 'W \u00b7 ' + d.losses + 'L';

    // Ticks & candles
    var tikEl = document.getElementById('ax-tick-count');
    if (tikEl) tikEl.textContent = (d.tickCount || 0).toLocaleString();
    var cnEl = document.getElementById('ax-candle-count');
    if (cnEl) cnEl.textContent = d.candleCount + ' candles ' + (d.candleCount >= 15 ? '\u2705' : '\u26a0\ufe0f warming');

    // Daily loss
    var dlEl = document.getElementById('ax-daily-loss');
    if (dlEl) {
      dlEl.textContent = d.dailyLossHit ? '\uD83D\uDED1 KILLED' : '\u2705 Active';
      dlEl.style.color = d.dailyLossHit ? '#ef4444' : '#10b981';
    }

    // LTP
    var ltpEl = document.getElementById('ax-ltp');
    if (ltpEl) ltpEl.textContent = d.lastTickPrice ? INR(d.lastTickPrice) : '\u2014';
    var ltEl = document.getElementById('ax-last-tick-time');
    if (ltEl) ltEl.textContent = d.lastTickTime || '';

    // Position details (AJAX update in-place)
    if (d.position) {
      var p = d.position;
      var oeEl = document.getElementById('ax-pos-opt-entry');
      if (oeEl) oeEl.textContent = p.optionEntryLtp ? INR(p.optionEntryLtp) : '\u23f3 Fetching...';

      var slEl = document.getElementById('ax-pos-sl');
      if (slEl) slEl.textContent = p.stopLoss ? INR(p.stopLoss) : '\u2014';

      var bpEl = document.getElementById('ax-pos-best');
      if (bpEl) bpEl.textContent = p.bestPrice ? INR(p.bestPrice) : '\u2014';

      var chEl = document.getElementById('ax-pos-candles');
      if (chEl) chEl.innerHTML = (p.candlesHeld || 0) + ' <span style="font-size:0.72rem;color:#4a6080;">/ ${_SCALP_TIME_STOP}</span>';

      var onEl = document.getElementById('ax-pos-opt-now');
      if (onEl) {
        var cur = p.optionCurrentLtp;
        onEl.textContent = cur ? INR(cur) : '\u23f3';
        if (p.optionEntryLtp && cur) {
          onEl.style.color = cur >= p.optionEntryLtp ? '#10b981' : '#ef4444';
        }
      }
      var omEl = document.getElementById('ax-pos-opt-move');
      if (omEl && p.optionEntryLtp && p.optionCurrentLtp) {
        var mv = parseFloat((p.optionCurrentLtp - p.optionEntryLtp).toFixed(2));
        omEl.textContent = (mv >= 0 ? '\u25b2 +' : '\u25bc ') + '\u20b9' + Math.abs(mv).toFixed(2) + ' pts';
        omEl.style.color = mv >= 0 ? '#10b981' : '#ef4444';
      }
      var ppEl = document.getElementById('ax-pos-pnl');
      if (ppEl) {
        ppEl.textContent = (d.unrealised >= 0 ? '+' : '') + INR(d.unrealised);
        ppEl.style.color = PNL_COLOR(d.unrealised);
      }
    }

    // Update log
    if (d.log && d.log.length > 0) {
      LOG_ALL = d.log;
      logFilter();
    }

  }).catch(function() {});
}
poll();
setInterval(poll, 2000);
</script>
</body></html>`);
});

module.exports = router;

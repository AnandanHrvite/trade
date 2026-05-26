/**
 * PRICE ACTION PAPER TRADE — /pa-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses LIVE market data (Fyers WebSocket) but SIMULATES orders locally.
 * Runs on 5-min candles with the price action strategy.
 * Can run IN PARALLEL with /trade (live) or /swing-paper (paper).
 *
 * Routes:
 *   GET /pa-paper/start   → Start price action paper trading
 *   GET /pa-paper/stop    → Stop session
 *   GET /pa-paper/status  → Live status page
 *   GET /pa-paper/exit    → Manual exit current position
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const paStrategy = require("../strategies/price_action");
const instrumentConfig = require("../config/instrument");
const { getSymbol, getLotQty, validateAndGetOptionSymbol } = instrumentConfig;
const sharedSocketState = require("../utils/sharedSocketState");
const socketManager = require("../utils/socketManager");
const tickRecorder  = require("../utils/tickRecorder");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, modalCSS, modalJS, errorPage, tableEnhancerCSS, tableEnhancerJS } = require("../utils/sharedNav");
const { dailyFilesPaginate, renderHistoryPage } = require("../utils/paperHistoryUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const { reverseSlice, formatISTTimestamp, fmtISTDateTime, getISTMinutes: _getISTMinutesReal, getBucketStart: _getBucketStartRaw, parseOptionDetails, parseTimeToMinutes, parseTrailTiers } = require("../utils/tradeUtils");
const vixFilter = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const tradeLogger = require("../utils/tradeLogger");
const fyers = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifySignal, notifyDayReport, sendTelegram, canSend, isConfigured } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const tradeGuards = require("../utils/tradeGuards");
const { logNearMiss } = require("../utils/nearMissLog");
const skipLogger = require("../utils/skipLogger");
const tickSimulator = require("../services/tickSimulator");


const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID = "PA_PAPER";

// ── Module-level config (re-read at /start so Settings UI / replay env overrides take effect) ──
// Declared with `let` so _refreshConfig() can update them. Without this, the
// replay engine's _applySettingsOverride() and the Settings UI's mid-session
// process.env mutations would never reach the running strategy code.
let PA_RES;
let _PA_MAX_TRADES;
let _PA_MAX_LOSS;
let _PA_PAUSE_CANDLES;
let _PA_TRAIL_START;
let _PA_TRAIL_PCT;
let _PA_TRAIL_TIERS;
let _PA_CANDLE_TRAIL;
let _PA_CANDLE_TRAIL_BARS;
let _STOP_MINS;
let _ENTRY_STOP_MINS;
let _PA_START_MINS;
function _refreshConfig() {
  PA_RES               = parseInt(process.env.PA_RESOLUTION || "5", 10);
  _PA_MAX_TRADES       = parseInt(process.env.PA_MAX_DAILY_TRADES || "30", 10);
  _PA_MAX_LOSS         = parseFloat(process.env.PA_MAX_DAILY_LOSS || "2000");
  _PA_PAUSE_CANDLES    = parseInt(process.env.PA_SL_PAUSE_CANDLES || "2", 10);
  _PA_TRAIL_START      = parseFloat(process.env.PA_TRAIL_START || "350");
  _PA_TRAIL_PCT        = parseFloat(process.env.PA_TRAIL_PCT || "65");
  _PA_TRAIL_TIERS      = parseTrailTiers(process.env.PA_TRAIL_TIERS || "500:55,1000:60,3000:70,5000:80,10000:90");
  _PA_CANDLE_TRAIL     = process.env.PA_CANDLE_TRAIL_ENABLED !== "false";
  _PA_CANDLE_TRAIL_BARS = parseInt(process.env.PA_CANDLE_TRAIL_BARS || "2", 10);
  _STOP_MINS           = parseTimeToMinutes(process.env.TRADE_STOP_TIME, "15:30");
  _ENTRY_STOP_MINS     = parseTimeToMinutes(process.env.PA_ENTRY_END, "14:30");
  _PA_START_MINS       = parseTimeToMinutes(process.env.PA_ENTRY_START, "09:21");
}
_refreshConfig();

// ── Previous day OHLC (fetched on session start) ────────────────────
let _prevDayOHLC     = null;  // { high, low, close }
let _prevPrevDayOHLC = null;  // for prev-prev day reference

function getISTMinutes() {
  if (state._simMode) return _PA_START_MINS + 5; // always "in market hours" during simulation
  return _getISTMinutesReal();
}

// ── Persistence ──────────────────────────────────────────────────────────────
const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const SP_FILE  = path.join(DATA_DIR, "pa_paper_trades.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadPAData() {
  ensureDir();
  if (!fs.existsSync(SP_FILE)) {
    const initial = { capital: 100000, totalPnl: 0, sessions: [] };
    fs.writeFileSync(SP_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try { return JSON.parse(fs.readFileSync(SP_FILE, "utf-8")); }
  catch (_) { return { capital: 100000, totalPnl: 0, sessions: [] }; }
}

function savePAData(data) {
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
  optionLtpUpdatedAt: null,
  optionSymbol:   null,
  _slPauseUntil:  null,
  _dailyLossHit:  false,
  _simMode:       false,
  _simScenario:   null,
};

// ── Simulation mode time override ───────────────────────────────────────────
// In sim mode, simulated clock advances with each tick so market-hour checks pass
let _simClockMs = 0; // simulated Date.now() in ms

function simNow() {
  return state._simMode ? _simClockMs : Date.now();
}

function istNow() { return formatISTTimestamp(simNow()); }

function log(msg) {
  const entry = `[${istNow()}] ${msg}`;
  console.log(entry);
  state.log.push(entry);
  if (state.log.length > 2500) state.log.splice(0, state.log.length - 2000);
}

function getBucketStart(unixMs) { return _getBucketStartRaw(unixMs, PA_RES); }

// _PA_START_MINS is declared and populated by _refreshConfig() above

function isMarketHours() {
  const total = getISTMinutes();
  return total >= _PA_START_MINS && total < _ENTRY_STOP_MINS;
}

function isStartAllowed() {
  return getISTMinutes() < _STOP_MINS;
}

// ── Option LTP polling ──────────────────────────────────────────────────────
let _optionPollTimer = null;
let _rateLimitBackoff = 0; // 0 = normal 500ms; >0 triggers 2s wait & warn-once

async function fetchOptionLtp(symbol) {
  try {
    const response = await fyers.getQuotes([symbol]);
    if (response.s === "ok" && response.d && response.d.length > 0) {
      const v = response.d[0].v || response.d[0];
      const ltp = v.lp || v.ltp || v.last_price || v.last_traded_price || v.close_price;
      if (ltp && ltp > 0) {
        if (_rateLimitBackoff > 0) {
          log(`✅ [PA-PAPER] Rate limit cleared — polling resumed`);
          _rateLimitBackoff = 0;
        }
        const _ltp = parseFloat(ltp);
        try { tickRecorder.recordOptionLtp(symbol, _ltp, "pa-paper"); } catch (_) {}
        return _ltp;
      }
      log(`⚠️ [PA-PAPER] fetchOptionLtp no LTP in response for ${symbol}: ${JSON.stringify(v).slice(0, 200)}`);
    } else {
      log(`⚠️ [PA-PAPER] fetchOptionLtp bad response for ${symbol}: s=${response?.s}, d.length=${response?.d?.length}`);
    }
  } catch (err) {
    const msg = err.message || "";
    if (/limit|throttle|429/i.test(msg)) {
      if (_rateLimitBackoff === 0) {
        log(`⚠️ [PA-PAPER] Rate limit hit — backing off to 2s polls; trail falls back to spot-proxy if stale`);
      }
      _rateLimitBackoff = Math.min(_rateLimitBackoff + 1, 10);
    } else {
      log(`⚠️ [PA-PAPER] fetchOptionLtp error for ${symbol}: ${msg}`);
    }
  }
  return null;
}

function startOptionPolling(symbol) {
  stopOptionPolling();
  function scheduleNext() {
    if (!_optionPollTimer) return;
    const delay = _rateLimitBackoff > 0 ? 2000 : 500;
    _optionPollTimer = setTimeout(async () => {
      if (!state.position || !state.optionSymbol) { stopOptionPolling(); return; }
      const ltp = await fetchOptionLtp(symbol);
      if (ltp && state.position) {
        state.optionLtp = ltp;
        state.optionLtpUpdatedAt = Date.now();
        state.position.optionCurrentLtp = ltp;
        if (!state.position.optionEntryLtp) {
          state.position.optionEntryLtp = ltp;
          log(`📌 [PA-PAPER] Option entry LTP: ₹${ltp}`);
        }
      }
      scheduleNext();
    }, delay);
  }
  fetchOptionLtp(symbol).then(ltp => {
    if (ltp && state.position) {
      state.optionLtp = ltp;
      state.optionLtpUpdatedAt = Date.now();
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

// parseOptionDetails imported from tradeUtils

// ── Simulated Buy/Sell ──────────────────────────────────────────────────────

function simulateBuy(symbol, side, qty, price, reason, stopLoss, target, spotAtEntry, slSource, entryMeta = {}) {
  if (state.position) return;

  const optDetails = parseOptionDetails(symbol);

  // Data-collection metadata — frozen at entry so the trade record is self-describing for offline analysis.
  const _entryIstMin    = Math.floor((Math.floor(simNow() / 1000) + 19800) / 60) % 1440;
  const _entryHourIST   = Math.floor(_entryIstMin / 60);
  const _entryMinuteIST = _entryIstMin % 60;
  const _vixAtEntry     = getCachedVix();
  const _signalStrength = entryMeta.signalStrength || null;

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
    slSource:         slSource || "Swing",
    target,
    bestPrice:        null,
    candlesHeld:      0,
    peakPnl:          0,
    // Max favorable / adverse excursion — tracked per-tick for post-window analysis.
    mfeSpotPts:       0,
    mfePnl:           0,
    maeSpotPts:       0,
    maePnl:           0,
    // Entry wall-clock (simNow) + seconds to the favourable peak / adverse trough.
    entryTimeMs:      simNow(),
    secsToMFE:        0,
    secsToMAE:        0,

    entryBarTime:     state.currentBar ? state.currentBar.time : null,
    optionEntryLtp:   null,
    optionCurrentLtp: null,
    optionStrike:     optDetails?.strike     || null,
    optionExpiry:     optDetails?.expiry     || null,
    optionType:       optDetails?.optionType || side,
    // Data-collection fields — surfaced on the trade record in simulateSell()
    signalStrength:   _signalStrength,
    vixAtEntry:       _vixAtEntry,
    entryHourIST:     _entryHourIST,
    entryMinuteIST:   _entryMinuteIST,
    // Entry-context diagnostics — already computed by getSignal(), captured for analysis.
    rsiAtEntry:       entryMeta.rsiAtEntry     != null ? entryMeta.rsiAtEntry     : null,
    adxAtEntry:       entryMeta.adxAtEntry     != null ? entryMeta.adxAtEntry     : null,
    adxRising:        entryMeta.adxRising      != null ? entryMeta.adxRising      : null,
    isTrending:       entryMeta.isTrending     != null ? entryMeta.isTrending     : null,
    patternAtEntry:   entryMeta.patternAtEntry || null,
    srLevelAtEntry:   entryMeta.srLevelAtEntry != null ? entryMeta.srLevelAtEntry : null,
  };

  state.optionSymbol = symbol;
  if (!state._simMode && instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES") {
    startOptionPolling(symbol);
  }

  log(`📝 [PA-PAPER] BUY ${qty} × ${symbol} @ ₹${price} | SL: ₹${stopLoss} | ${reason}`);

  if (state._simMode) return; // skip Telegram in sim mode

  notifyEntry({
    mode: "PA-PAPER",
    side, symbol, spotAtEntry: price,
    optionEntryLtp: null,
    stopLoss, qty, reason,
  });
}

function simulateSell(exitPrice, reason, spotAtExit) {
  if (!state.position) return;

  const { side, symbol, qty, entryPrice, entryTime, spotAtEntry,
          optionEntryLtp, optionCurrentLtp,
          signalStrength, vixAtEntry, entryHourIST, entryMinuteIST } = state.position;
  const isFutures = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const exitOptionLtp = state.optionLtp || optionCurrentLtp;

  let rawPnl, pnlMode;
  if (isFutures) {
    rawPnl  = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
    pnlMode = "futures";
  } else if (optionEntryLtp && exitOptionLtp) {
    rawPnl  = (exitOptionLtp - optionEntryLtp) * qty;
    pnlMode = `option: ₹${optionEntryLtp} → ₹${exitOptionLtp}`;
  } else if (state._simMode) {
    // Sim mode: no real option LTP — use delta approximation like backtest
    const DELTA = parseFloat(process.env.BACKTEST_DELTA || "0.55");
    const spotMove = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1);
    rawPnl  = spotMove * DELTA * qty;
    pnlMode = `sim delta(${DELTA})`;
  } else {
    rawPnl  = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
    pnlMode = "spot proxy";
  }

  const charges = getCharges({ broker: "fyers", isFutures, exitPremium: exitOptionLtp, entryPremium: optionEntryLtp, qty });
  const netPnl    = parseFloat((rawPnl - charges).toFixed(2));
  const emoji     = netPnl >= 0 ? "✅" : "❌";

  log(`${emoji} [PA-PAPER] Exit: ${reason} | PnL: ₹${netPnl}`);

  // Derived metadata for the trade record — computed here so the JSONL log captures the full picture.
  const _entryMsPA    = state.position.entryBarTime ? state.position.entryBarTime * 1000 : null;
  const _exitMsPA     = simNow();
  const _durationMsPA = _entryMsPA ? (_exitMsPA - _entryMsPA) : null;
  const _pnlPointsPA  = parseFloat(((exitPrice - entryPrice) * (side === "CE" ? 1 : -1)).toFixed(2));
  const _isManualPA   = typeof state.position.reason === "string" && /Manual/i.test(state.position.reason);

  const trade = {
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
    entryBarTime: state.position.entryBarTime || (state.currentBar ? state.currentBar.time : null),
    exitBarTime:  state.currentBar ? state.currentBar.time : null,
    // Data-collection fields (captured at entry — see simulateBuy)
    signalStrength: signalStrength || null,
    vixAtEntry:     vixAtEntry     != null ? vixAtEntry     : null,
    entryHourIST:   entryHourIST   != null ? entryHourIST   : null,
    entryMinuteIST: entryMinuteIST != null ? entryMinuteIST : null,
    // Full-detail capture for JSONL (also surfaced in-memory for future analytics)
    initialStopLoss: state.position.initialStopLoss || null,
    slSource:        state.position.slSource        || null,
    target:          state.position.target          || null,
    bestPrice:       state.position.bestPrice       || null,
    candlesHeld:     state.position.candlesHeld     || 0,
    peakPnl:         state.position.peakPnl         || 0,
    // Entry-context diagnostics + excursion + exit VIX for post-window analysis.
    rsiAtEntry:      state.position.rsiAtEntry      != null ? state.position.rsiAtEntry      : null,
    adxAtEntry:      state.position.adxAtEntry      != null ? state.position.adxAtEntry      : null,
    adxRising:       state.position.adxRising       != null ? state.position.adxRising       : null,
    isTrending:      state.position.isTrending      != null ? state.position.isTrending      : null,
    patternAtEntry:  state.position.patternAtEntry  || null,
    srLevelAtEntry:  state.position.srLevelAtEntry  != null ? state.position.srLevelAtEntry  : null,
    mfeSpotPts:      state.position.mfeSpotPts       || 0,
    mfePnl:          state.position.mfePnl           || 0,
    maeSpotPts:      state.position.maeSpotPts       || 0,
    maePnl:          state.position.maePnl           || 0,
    secsToMFE:       state.position.secsToMFE        || 0,
    secsToMAE:       state.position.secsToMAE        || 0,
    vixAtExit:       getCachedVix(),
    exitTimeMs:      _exitMsPA,
    durationMs:      _durationMsPA,
    pnlPoints:       _pnlPointsPA,
    charges:         charges,
    isFutures:       isFutures,
    isManual:        _isManualPA,
    instrument:      instrumentConfig.INSTRUMENT,
  };
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog("pa", trade); // crash-safe per-trade JSONL

  state.sessionPnl = parseFloat((state.sessionPnl + netPnl).toFixed(2));
  if (netPnl > 0) state._wins = (state._wins || 0) + 1;
  else if (netPnl < 0) state._losses = (state._losses || 0) + 1;

  stopOptionPolling();
  state.optionSymbol = null;
  state.optionLtp    = null;
  state.optionLtpUpdatedAt = null;

  // SL pause — escalate after consecutive SLs
  if (reason.includes("SL")) {
    state._consecSLs = (state._consecSLs || 0) + 1;
    const extraPause = parseInt(process.env.PA_CONSEC_SL_EXTRA_PAUSE || "2", 10);
    const pauseCandles = state._consecSLs >= 2
      ? _PA_PAUSE_CANDLES + extraPause * (state._consecSLs - 1)
      : _PA_PAUSE_CANDLES;
    state._slPauseUntil = simNow() + (pauseCandles * PA_RES * 60 * 1000);
    const escalateNote = state._consecSLs >= 2 ? ` (${state._consecSLs} consecutive SLs → ${pauseCandles} candles)` : "";
    log(`⏸️ [PA-PAPER] SL pause — no entries for ${pauseCandles} candles${escalateNote}`);
  } else if (netPnl > 0) {
    state._consecSLs = 0; // Reset on a winning trade
  }

  // Daily loss kill
  if (state.sessionPnl <= -_PA_MAX_LOSS) {
    state._dailyLossHit = true;
    log(`🚨 [PA-PAPER] Daily loss limit hit (₹${state.sessionPnl} <= -₹${_PA_MAX_LOSS}) — no more entries today`);
  }

  state.position = null;

  if (!state._simMode) {
    notifyExit({
      mode: "PA-PAPER",
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
}

// ── onTick — processes each WebSocket tick ───────────────────────────────────

function onTick(tick) {
  if (!state.running) return;
  const price = tick.ltp;
  if (!price || price <= 0) return;

  state.tickCount++;
  state.lastTickTime  = simNow();
  state.lastTickPrice = price;

  // In sim mode, advance simulated clock per tick (resolution-aware: 20 ticks per candle)
  if (state._simMode) _simClockMs += (PA_RES * 60 * 1000) / 20;

  // ── Build 3-min candle ─────────────────────────────────────────────────────
  const tickMs    = simNow();
  const bucketMs  = getBucketStart(tickMs);

  if (!state.currentBar || state.barStartTime !== bucketMs) {
    // Close previous bar
    if (state.currentBar) {
      // If last candle has same time (preloaded overlap), replace instead of duplicate push
      const lastC = state.candles.length ? state.candles[state.candles.length - 1] : null;
      if (lastC && lastC.time === state.currentBar.time) {
        state.candles[state.candles.length - 1] = { ...state.currentBar };
      } else {
        state.candles.push({ ...state.currentBar });
      }
      if (state.candles.length > 200) state.candles.shift();
      onCandleClose(state.currentBar).catch(e => console.error(`🚨 [PA-PAPER] onCandleClose error: ${e.message}`));
    }
    // Start new bar — if last preloaded candle covers same bucket, merge with it
    const bucketTimeSec = Math.floor(bucketMs / 1000);
    const lastPreloaded = state.candles.length ? state.candles[state.candles.length - 1] : null;
    if (lastPreloaded && lastPreloaded.time === bucketTimeSec) {
      state.currentBar = state.candles.pop();
      state.currentBar.high  = Math.max(state.currentBar.high, price);
      state.currentBar.low   = Math.min(state.currentBar.low, price);
      state.currentBar.close = price;
    } else {
      state.currentBar = { time: bucketTimeSec, open: price, high: price, low: price, close: price };
    }
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
    // Running PNL helper (₹) — must match simulateSell logic for consistent trailing
    const _tickPnl = (spotPrice) => {
      const _q = pos.qty || getLotQty();
      const _staleMs = parseInt(process.env.LTP_STALE_FALLBACK_SEC || "5", 10) * 1000;
      const _optionLtpFresh = !!(state.optionLtp && state.optionLtpUpdatedAt && (Date.now() - state.optionLtpUpdatedAt) < _staleMs);
      if (!isFut && pos.optionEntryLtp && _optionLtpFresh) {
        const _c = getCharges({ broker: "fyers", isFutures: isFut, exitPremium: state.optionLtp, entryPremium: pos.optionEntryLtp, qty: _q });
        return (state.optionLtp - pos.optionEntryLtp) * _q - _c;
      }
      // Sim mode OR stale option LTP: delta-based spot-proxy keeps trail responsive
      if (state._simMode || (!isFut && pos.optionEntryLtp)) {
        const DELTA = parseFloat(process.env.BACKTEST_DELTA || "0.55");
        const spotMove = (spotPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1);
        if (!isFut && pos.optionEntryLtp && !state._simMode) {
          const approxPremium = Math.max(0.05, pos.optionEntryLtp + spotMove * DELTA);
          const _c = getCharges({ broker: "fyers", isFutures: isFut, exitPremium: approxPremium, entryPremium: pos.optionEntryLtp, qty: _q });
          return (approxPremium - pos.optionEntryLtp) * _q - _c;
        }
        const _c = getCharges({ broker: "fyers", isFutures: isFut, exitPremium: spotPrice, entryPremium: pos.entryPrice, qty: _q });
        return spotMove * DELTA * _q - _c;
      }
      const _c = getCharges({ broker: "fyers", isFutures: isFut, exitPremium: spotPrice, entryPremium: pos.entryPrice, qty: _q });
      return (spotPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * _q - _c;
    };

    const curPnl = _tickPnl(price);

    // Track peak PNL
    if (!pos.peakPnl || curPnl > pos.peakPnl) pos.peakPnl = curPnl;

    // Track max favorable / adverse excursion — spot pts in trade direction + rupee PnL.
    // MFE = best the trade ever showed; MAE = worst it dipped. Both for giveback/drawdown analysis.
    const _favPts = (price - pos.entryPrice) * (pos.side === "CE" ? 1 : -1);
    if (_favPts > (pos.mfeSpotPts || 0)) { pos.mfeSpotPts = parseFloat(_favPts.toFixed(2)); pos.secsToMFE = parseFloat(((simNow() - pos.entryTimeMs) / 1000).toFixed(1)); }
    if (curPnl  > (pos.mfePnl     || 0)) pos.mfePnl     = parseFloat(curPnl.toFixed(2));
    if (_favPts < (pos.maeSpotPts || 0)) { pos.maeSpotPts = parseFloat(_favPts.toFixed(2)); pos.secsToMAE = parseFloat(((simNow() - pos.entryTimeMs) / 1000).toFixed(1)); }
    if (curPnl  < (pos.maePnl     || 0)) pos.maePnl     = parseFloat(curPnl.toFixed(2));

    // 1. SL hit (initial or swing-trailed)
    if (pos.side === "CE" && price <= pos.stopLoss) {
      const _isTrail = Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
      const _src = pos.slSource || "Swing";
      simulateSell(pos.stopLoss, _isTrail ? `${_src} Trail SL hit` : `${_src} SL hit`, price);
      return;
    }
    if (pos.side === "PE" && price >= pos.stopLoss) {
      const _isTrail = Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
      const _src = pos.slSource || "Swing";
      simulateSell(pos.stopLoss, _isTrail ? `${_src} Trail SL hit` : `${_src} SL hit`, price);
      return;
    }

    // 2. TRAILING — candle trail + profit-lock floor (parallel, whichever fires first)
    if (_PA_TRAIL_START > 0 && pos.peakPnl >= _PA_TRAIL_START) {
      // a) Candle trail breach (level updated on candle close)
      if (_PA_CANDLE_TRAIL && pos.candleTrailLevel) {
        const candleBreached = (pos.side === "CE" && price <= pos.candleTrailLevel)
                            || (pos.side === "PE" && price >= pos.candleTrailLevel);
        if (candleBreached) {
          simulateSell(price, `Candle Trail (${_PA_CANDLE_TRAIL_BARS}-bar ${pos.side === "CE" ? "low" : "high"} ${pos.candleTrailLevel})`, price);
          return;
        }
      }

      // b) Profit-lock floor (safety net)
      let _pct = _PA_TRAIL_PCT;
      for (const tier of _PA_TRAIL_TIERS) {
        if (pos.peakPnl >= tier.peak) { _pct = tier.pct; break; }
      }
      const trailFloor = parseFloat((pos.peakPnl * _pct / 100).toFixed(2));
      if (curPnl <= trailFloor) {
        simulateSell(price, `Trail ${_pct}% ₹${trailFloor} (peak ₹${Math.round(pos.peakPnl)})`, price);
        return;
      }
    }

    // EOD check — skip in simulation mode
    if (!state._simMode) {
      const nowMin = getISTMinutes();
      if (nowMin >= _STOP_MINS - 10) {
        simulateSell(price, "EOD square-off", price);
        return;
      }
    }
  }
}

// ── onCandleClose — evaluate signal on 3-min bar close ──────────────────────

async function onCandleClose(bar) {
  if (!state.running) return;

  // Count candles held + exit checks
  if (state.position) {
    state.position.candlesHeld = (state.position.candlesHeld || 0) + 1;

    // ── Time-stop: flat trade after N candles = theta bleed risk ──
    {
      const _pos = state.position;
      const _entryOpt = _pos.optionEntryLtp;
      const _curOpt   = state.optionLtp || _pos.optionCurrentLtp;
      let _pnlPts = null;
      if (_entryOpt && _curOpt) {
        _pnlPts = _curOpt - _entryOpt;
      } else if (_pos.spotAtEntry) {
        _pnlPts = (bar.close - _pos.spotAtEntry) * (_pos.side === "CE" ? 1 : -1);
      }
      const _tsReason = tradeGuards.checkTimeStop(_pos.candlesHeld, _pnlPts, {
        maxCandles: parseInt(process.env.PA_TIME_STOP_CANDLES || "3", 10),
        flatPts:    parseFloat(process.env.PA_TIME_STOP_FLAT_PTS || "10"),
      });
      if (_tsReason) {
        log(`⏳ [PA-PAPER] ${_tsReason}`);
        simulateSell(bar.close, _tsReason, bar.close);
        return;
      }
    }

    // Use only completed candles (matches backtest logic)
    const window = [...state.candles];

    // Update trailing SL (swing-based, tighten only)
    if (window.length >= 15) {
      const trailResult = paStrategy.updateTrailingSL(window, state.position.stopLoss, state.position.side);
      if (trailResult.sl !== state.position.stopLoss) {
        log(`📐 [PA-PAPER] Trail SL (${trailResult.source}): ₹${state.position.stopLoss} → ₹${trailResult.sl}`);
        state.position.stopLoss = trailResult.sl;
        if (trailResult.source) state.position.slSource = trailResult.source;
      }
    }

    // Update candle trail level (lowest low / highest high of last N candles, tighten only)
    if (_PA_CANDLE_TRAIL && state.position.peakPnl >= _PA_TRAIL_START && window.length >= _PA_CANDLE_TRAIL_BARS) {
      const bars = window.slice(-_PA_CANDLE_TRAIL_BARS);
      if (state.position.side === "CE") {
        const newLevel = Math.min(...bars.map(b => b.low));
        if (!state.position.candleTrailLevel || newLevel > state.position.candleTrailLevel) {
          log(`📐 [PA-PAPER] Candle Trail: ${state.position.candleTrailLevel || 'none'} → ${newLevel} (${_PA_CANDLE_TRAIL_BARS}-bar low)`);
          state.position.candleTrailLevel = newLevel;
        }
      } else {
        const newLevel = Math.max(...bars.map(b => b.high));
        if (!state.position.candleTrailLevel || newLevel < state.position.candleTrailLevel) {
          log(`📐 [PA-PAPER] Candle Trail: ${state.position.candleTrailLevel || 'none'} → ${newLevel} (${_PA_CANDLE_TRAIL_BARS}-bar high)`);
          state.position.candleTrailLevel = newLevel;
        }
      }
    }

    return; // In position — don't look for new entry
  }

  // ── Entry evaluation ──────────────────────────────────────────────────────
  if (!state._simMode && !isMarketHours()) { log(`⏭️ [PA-PAPER] SKIP: outside market hours`); return; }
  if (state._dailyLossHit) { log(`⏭️ [PA-PAPER] SKIP: daily loss limit hit`); return; }
  if (state.sessionTrades.length >= _PA_MAX_TRADES) { log(`⏭️ [PA-PAPER] SKIP: max trades (${_PA_MAX_TRADES}) reached`); return; }
  if (state._slPauseUntil && simNow() < state._slPauseUntil) {
    const secsLeft = Math.ceil((state._slPauseUntil - simNow()) / 1000);
    log(`⏭️ [PA-PAPER] SKIP: SL cooldown (${secsLeft}s left)`);
    return;
  }
  if (state._expiryDayBlocked) { log(`⏭️ [PA-PAPER] SKIP: expiry-only mode, not expiry day`); return; }

  const window = [...state.candles];
  if (window.length < 30) { log(`⏭️ [PA-PAPER] SKIP: warming up (${window.length}/30 candles)`); return; }

  const result = paStrategy.getSignal(window, {
    silent: true,
    skipTimeCheck: state._simMode,
    // prevDayOHLC not needed

  });
  if (result.signal === "NONE") {
    const lastBar = window[window.length - 1];
    log(`⏭️ [PA-PAPER] SKIP: ${result.reason} | Close=${lastBar.close} Pattern=${result.pattern||'none'} SR=${result.srLevel||'-'} RSI=${result.rsi||'?'}${result.adx !== null && result.adx !== undefined ? ' ADX='+result.adx : ''}`);
    logNearMiss(result.filterAudit, "PA-PAPER", log);
    skipLogger.appendSkipLog("pa", {
      gate: "strategy",
      reason: result.reason || null,
      spot: lastBar.close,
      pattern: result.pattern || null,
      srLevel: result.srLevel || null,
      rsi: result.rsi ?? null,
      adx: result.adx ?? null,
      audit: result.filterAudit || null,
    });
    if (!state._simMode) {
      const _barIST = new Date(lastBar.time * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
      notifySignal({
        mode: "PA-PAPER",
        signal: "SKIP",
        reason: result.reason ? String(result.reason).slice(0, 200) : "—",
        spot: lastBar.close,
        time: _barIST,
      });
    }
    return;
  }

  // VIX — post-strategy check using pattern strength (skip in sim mode)
  if (!state._simMode && process.env.PA_VIX_ENABLED === "true") {
    const _strength = result.signalStrength || "MARGINAL";
    const _vixCheck = await checkLiveVix(_strength, { mode: "pa" });
    if (!_vixCheck.allowed) {
      log(`⏭️ [PA-PAPER] SKIP: ${_vixCheck.reason}`);
      skipLogger.appendSkipLog("pa", {
        gate: "vix",
        reason: _vixCheck.reason || null,
        spot: bar.close,
        signalStrength: _strength,
        side: result.signal === "BUY_CE" ? "CE" : "PE",
      });
      return;
    }
  }

  const side = result.signal === "BUY_CE" ? "CE" : "PE";
  const spot = bar.close;

  // Resolve option symbol
  resolveAndEnter(side, spot, result);
}

async function resolveAndEnter(side, spot, result) {
  try {
    let symbol;
    if (state._simMode) {
      // In simulation mode, use a dummy option symbol (no broker API needed)
      const strike = Math.round(spot / 50) * 50;
      symbol = `NSE:NIFTY-SIM-${strike}${side}`;
    } else {
      const optionInfo = await validateAndGetOptionSymbol(spot, side);
      if (optionInfo.invalid) {
        log(`⚠️ [PA-PAPER] Option symbol invalid for ${side} — skipping entry`);
        return;
      }
      symbol = optionInfo.symbol;
    }
    const qty = getLotQty();
    // Clamp SL distance to [MIN_SL_PTS, MAX_SL_PTS] — matches backtest logic
    const MAX_SL_PTS = parseFloat(process.env.PA_MAX_SL_PTS || "25");
    const MIN_SL_PTS = parseFloat(process.env.PA_MIN_SL_PTS || "8");
    const rawGap = Math.abs(spot - result.stopLoss);
    const slPts = Math.max(Math.min(rawGap, MAX_SL_PTS), MIN_SL_PTS);
    const clampedSL = parseFloat((spot + slPts * (side === "CE" ? -1 : 1)).toFixed(2));

    // ── Bid-ask spread guard (fail-open if broker snapshot lacks depth) ──
    if (!state._simMode) {
      const _q = await tradeGuards.fetchOptionQuote(fyers, symbol);
      const _sp = tradeGuards.checkSpread(_q && _q.bid, _q && _q.ask);
      if (!_sp.ok) {
        log(`⏭️ [PA-PAPER] SKIP entry — spread too wide (${_sp.reason})`);
        skipLogger.appendSkipLog("pa", {
          gate: "spread",
          reason: _sp.reason || null,
          spot,
          side,
          symbol,
          bid: _q && _q.bid,
          ask: _q && _q.ask,
        });
        return;
      }
    }

    simulateBuy(symbol, side, qty, spot, result.reason, clampedSL, result.target, spot, result.slSource, {
      signalStrength: result.signalStrength || null,
      rsiAtEntry:     result.rsi        != null ? result.rsi   : null,
      adxAtEntry:     result.adx        != null ? result.adx   : null,
      adxRising:      result.adxRising  != null ? result.adxRising  : null,
      isTrending:     result.isTrending != null ? result.isTrending : null,
      patternAtEntry: result.pattern    || null,
      srLevelAtEntry: result.srLevel    != null ? result.srLevel : null,
    });
  } catch (err) {
    log(`⚠️ [PA-PAPER] Symbol resolution failed: ${err.message}`);
  }
}

// ── Pre-load history ────────────────────────────────────────────────────────

async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { fetchCandles } = require("../services/backtestEngine");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    // Fetch from 7 days ago to cover weekends + holidays (e.g., Thu trading → Mon start)
    const lookbackDate = new Date(Date.now() - 7 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached(
      NIFTY_INDEX_SYMBOL, String(PA_RES), lookbackDate, today,
      fetchCandles
    );
    if (candles && candles.length > 0) {
      state.candles = candles.slice(-99);
      log(`📦 [PA-PAPER] Pre-loaded ${state.candles.length} × ${PA_RES}-min candles (strategy ready!)`);
    } else {
      log(`⚠️ [PA-PAPER] No historical candles found — will build from live ticks`);
    }
  } catch (err) {
    log(`⚠️ [PA-PAPER] Pre-load failed: ${err.message} — will build from ticks`);
  }

  // Fetch previous day(s) OHLC
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
        log(`📊 [PA-PAPER] Prev day OHLC: H=${prev.high} L=${prev.low} C=${prev.close}`);
      }
      if (pastDays.length >= 2) {
        const pp = pastDays[pastDays.length - 2];
        _prevPrevDayOHLC = { high: pp.high, low: pp.low, close: pp.close };
      }

      // Log prev day info (price action uses S/R from live candles)
      if (_prevDayOHLC) {
        log(`📊 [PA-PAPER] Prev Day: H=${_prevDayOHLC.high} L=${_prevDayOHLC.low} C=${_prevDayOHLC.close}`);
      }
    } else {
      log(`⚠️ [PA-PAPER] Not enough daily candles for prev day data`);
    }
  } catch (err) {
    log(`⚠️ [PA-PAPER] Prev day data fetch failed: ${err.message}`);
  }
}

// ── Auto-stop timer ─────────────────────────────────────────────────────────
let _autoStopTimer = null;

function scheduleAutoStop(stopFn) {
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  const nowMins = getISTMinutes();
  const ms = (_STOP_MINS - nowMins) * 60 * 1000;
  if (ms <= 0) return;
  _autoStopTimer = setTimeout(() => {
    if (!state.running) return;
    stopFn("⏰ [PA-PAPER] Auto-stop reached");
  }, ms);
  log(`⏰ [PA-PAPER] Auto-stop in ${Math.round(ms / 60000)} min`);
}

// errorPage imported from sharedNav (shared across all route files)
function _errorPage(title, message, linkHref, linkText) {
  return errorPage(title, message, linkHref, linkText, 'paPaper');
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/pa-paper/status");

  // Re-read env into module-level config so Settings UI changes and replay
  // env overrides (snapshot or simulator mode) take effect for this session.
  _refreshConfig();

  const check = sharedSocketState.canStart("PA_PAPER");
  if (!check.allowed) {
    return res.status(409).send(_errorPage("Cannot Start", check.reason, "/pa-paper/status", "\u2190 Back"));
  }

  const auth = await verifyFyersToken();
  if (!auth.ok) {
    return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));
  }

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) {
    return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/pa-paper/status", "\u2190 Back"));
  }

  if (!isStartAllowed()) {
    return res.status(400).send(_errorPage("Session Closed", "Past stop time \u2014 cannot start today.", "/pa-paper/status", "\u2190 Back"));
  }

  // Expiry day check
  let _expiryBlocked = false;
  if ((process.env.PA_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
    const { isExpiryDay } = require("../utils/nseHolidays");
    const isExpiry = await isExpiryDay();
    if (!isExpiry) _expiryBlocked = true;
    log(`📅 [PA-PAPER] Expiry-only mode: ${isExpiry ? "✅ Today is expiry — trading allowed" : "❌ Not expiry day — entries blocked"}`);
  }

  // Reset state
  state = {
    running: true, position: null, candles: [], currentBar: null, barStartTime: null,
    log: [], sessionTrades: [], sessionStart: new Date().toISOString(),
    sessionPnl: 0, _wins: 0, _losses: 0, tickCount: 0, lastTickTime: null, lastTickPrice: null,
    optionLtp: null, optionSymbol: null, _slPauseUntil: null, _dailyLossHit: false,
    _expiryDayBlocked: _expiryBlocked,
  };

  sharedSocketState.setPAActive("PA_PAPER");

  // Pre-load history
  await preloadHistory();

  // Start VIX polling
  if (process.env.PA_VIX_ENABLED === "true") {
    resetVixCache();
    fetchLiveVix({ force: true }).catch(() => {});
  }

  // Tick-recorder session-start snapshot
  state._sessionId = `pa-paper:${Date.now()}`;
  try {
    tickRecorder.recordSessionStart({
      mode: "pa-paper",
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings(),
      warmup:   state.candles.map(c => ({ ...c })),
      vix:      getCachedVix(),
      meta: {
        instrument:       instrumentConfig.INSTRUMENT,
        resolutionMin:    PA_RES,
        expiryDayBlocked: _expiryBlocked,
        spotSymbol:       NIFTY_INDEX_SYMBOL,
        sessionStartISO:  state.sessionStart,
      },
    });
  } catch (_) {}

  // Socket: piggyback if already running, else start our own
  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [PA-PAPER] Piggybacking on existing WebSocket");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log); // dummy primary callback
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [PA-PAPER] Started WebSocket (own instance)");
  }

  // Auto-stop
  scheduleAutoStop((msg) => {
    log(msg);
    stopSession();
  });

  if (typeof paStrategy.reset === "function") paStrategy.reset();
  log(`🟢 [PA-PAPER] Session started — ${PA_RES}-min candles`);

  notifyStarted({
    mode: "PA-PAPER",
    text: [
      `📄 PRICE ACTION PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${paStrategy.NAME || "Price Action"}`,
      `Resolution: ${PA_RES}-min candles`,
    ].join("\n"),
  });

  res.redirect("/pa-paper/status");
});

function stopSession() {
  if (!state.running) return;

  // Exit any open position
  if (state.position) {
    simulateSell(state.lastTickPrice || state.position.entryPrice, "Session stopped", state.lastTickPrice);
  }

  state.running = false;
  stopOptionPolling();

  try {
    tickRecorder.recordSessionStop({
      mode: "pa-paper",
      sessionId: state._sessionId || null,
      reason: state._simMode ? "sim_stop" : "user_stop",
    });
  } catch (_) {}

  // Stop tick simulator if in sim mode
  if (state._simMode) {
    tickSimulator.stop();
    state._simMode = false;
    state._simScenario = null;
  }

  socketManager.removeCallback(CALLBACK_ID);

  // If we were the only socket user and no primary mode is active, stop socket
  if (!sharedSocketState.isActive() && socketManager.isRunning()) {
    // Don't stop — primary mode might still need it
    // Only stop if no primary mode AND no other PA mode
    if (!sharedSocketState.isPAActive() || sharedSocketState.getPAMode() === "PA_PAPER") {
      // Check if primary mode needs it
      if (!sharedSocketState.isActive()) {
        socketManager.stop();
      }
    }
  }

  sharedSocketState.clearPA();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  // Save session
  if (state.sessionTrades.length > 0) {
    try {
      const data = loadPAData();
      data.sessions.push({
        date:     state.sessionStart,
        strategy: paStrategy.NAME,
        pnl:      state.sessionPnl,
        trades:   state.sessionTrades,
      });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      savePAData(data);
      log(`💾 [PA-PAPER] Session saved — ${state.sessionTrades.length} trades, PnL: ₹${state.sessionPnl}`);
    } catch (err) {
      log(`⚠️ [PA-PAPER] Save failed: ${err.message}`);
    }
  }

  log("🔴 [PA-PAPER] Session stopped");

  notifyDayReport({
    mode: "PA-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl:    state.sessionPnl,
    sessionStart:  state.sessionStart,
  });
}

router.get("/stop", (req, res) => {
  stopSession();
  res.redirect("/pa-paper/status");
});

router.get("/exit", (req, res) => {
  if (state.position) {
    simulateSell(state.lastTickPrice || state.position.entryPrice, "Manual exit", state.lastTickPrice);
  }
  res.redirect("/pa-paper/status");
});

// ── Manual entry ────────────────────────────────────────────────────────────
router.post("/manualEntry", async (req, res) => {
  if (!state.running) return res.status(400).json({ success: false, error: "Price Action paper is not running." });
  if (state.position) return res.status(400).json({ success: false, error: "Already in a position. Exit first." });
  const { side } = req.body || {};
  if (side !== "CE" && side !== "PE") return res.status(400).json({ success: false, error: "Side must be CE or PE." });
  const spot = state.lastTickPrice || (state.currentBar ? state.currentBar.close : null);
  if (!spot) return res.status(400).json({ success: false, error: "No market data yet." });

  // SL = Previous candle low/high, capped at MAX_SL_PTS, floored at MIN_SL_PTS
  const candles = state.candles || [];
  const MAX_SL_PTS  = parseFloat(process.env.PA_MAX_SL_PTS || "25");
  const MIN_SL_PTS  = parseFloat(process.env.PA_MIN_SL_PTS || "8");
  const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;
  let sl;
  if (prevCandle) {
    const rawSL = side === "CE" ? prevCandle.low : prevCandle.high;
    const slPts = Math.max(Math.min(Math.abs(spot - rawSL), MAX_SL_PTS), MIN_SL_PTS);
    sl = side === "CE" ? parseFloat((spot - slPts).toFixed(2)) : parseFloat((spot + slPts).toFixed(2));
  } else {
    sl = side === "CE" ? spot - MAX_SL_PTS : spot + MAX_SL_PTS;
  }
  const sig = candles.length >= 30 ? paStrategy.getSignal(candles, { silent: true }) : null;

  try {
    const optResult = await validateAndGetOptionSymbol(spot, side);
    const symbol = optResult.symbol;
    const qty = getLotQty();
    log(`🖐️ [PA-PAPER] MANUAL ENTRY ${side} @ spot ₹${spot} | SL: ₹${sl} (PrevCandle${prevCandle ? '=' + (side === 'CE' ? prevCandle.low : prevCandle.high) : ''})`);
    simulateBuy(symbol, side, qty, spot, `Manual ${side} entry`, sl, null, spot);
    return res.json({ success: true, spot, side, sl, symbol });
  } catch (e) {
    log(`❌ [PA-PAPER] Manual entry failed: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── Chart data for Lightweight Charts widget ────────────────────────────────
router.get("/status/chart-data", (req, res) => {
  try {
    const candles = state.candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    // Only include the partial currentBar during market hours — pre-market quotes
    // are sparse/stale and produce a junk spike on the chart.
    if (state.currentBar && (state._simMode || isMarketHours())) {
      candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });
    }

    // Swing highs/lows — the structural pivots PA uses for BOS/S-R
    const SR_LOOKBACK = parseInt(process.env.PA_SR_LOOKBACK || "30", 10);
    const MAX_SWINGS  = 6; // cap for visual clarity
    const swingMarkers = [];
    if (candles.length >= 3) {
      try {
        const sw = paStrategy.findSwingPoints(candles, SR_LOOKBACK);
        const recentHighs = sw.swingHighs.slice(-MAX_SWINGS);
        const recentLows  = sw.swingLows.slice(-MAX_SWINGS);
        for (const h of recentHighs) swingMarkers.push({ time: h.time, position: 'aboveBar', color: '#64748b', shape: 'circle', text: 'SH ' + h.price.toFixed(0) });
        for (const l of recentLows)  swingMarkers.push({ time: l.time, position: 'belowBar', color: '#64748b', shape: 'circle', text: 'SL ' + l.price.toFixed(0) });
      } catch (_) { /* ignore swing calc errors */ }
    }

    // Shorten entryReason for marker text ("CE: BOS above 22450 | RSI=62 | SL=..." → "CE BOS @22450 R62")
    const shortPAReason = (r) => {
      if (!r) return "";
      const side = /^CE/i.test(r) ? "CE" : /^PE/i.test(r) ? "PE" : "";
      let pattern = "";
      if (/BOS/i.test(r))                 pattern = "BOS";
      else if (/Bullish Engulfing/i.test(r)) pattern = "BullEng";
      else if (/Bearish Engulfing/i.test(r)) pattern = "BearEng";
      else if (/Hammer/i.test(r))         pattern = "Pin";
      else if (/Shooting Star/i.test(r))  pattern = "PinBr";
      else if (/Inside Bar/i.test(r))     pattern = "InsideBr";
      else if (/Double Top/i.test(r))     pattern = "DblTop";
      else if (/Double Bottom/i.test(r))  pattern = "DblBot";
      else if (/Ascending Triangle/i.test(r))  pattern = "AscTri";
      else if (/Descending Triangle/i.test(r)) pattern = "DescTri";
      const lvl = /(above|below|at support|at resistance|break)\s+(\d+)/i.exec(r);
      const rsi = /RSI\s*[=:]?\s*(\d+)/i.exec(r);
      return [side, pattern, lvl ? "@" + lvl[2] : "", rsi ? "R" + rsi[1] : ""].filter(Boolean).join(" ");
    };

    const markers = [...swingMarkers];
    for (const t of state.sessionTrades) {
      if (t.entryPrice && t.entryBarTime) {
        const lbl = shortPAReason(t.entryReason || "") || (t.side + " @ " + t.entryPrice.toFixed(0));
        markers.push({ time: t.entryBarTime, position: 'belowBar', color: '#3b82f6', shape: 'arrowUp', text: lbl });
      }
      if (t.exitPrice && t.exitBarTime) { const w = t.pnl > 0; markers.push({ time: t.exitBarTime, position: 'aboveBar', color: w ? '#10b981' : '#ef4444', shape: 'arrowDown', text: 'Exit ' + (w ? '+' : '') + (t.pnl ? t.pnl.toFixed(0) : '') }); }
    }
    const stopLoss = state.position && state.position.stopLoss ? state.position.stopLoss : null;
    const entryPrice = state.position && state.position.entryPrice ? state.position.entryPrice : null;
    return res.json({ candles, markers, stopLoss, entryPrice });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Status data (AJAX poll) ─────────────────────────────────────────────────

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const data = loadPAData();

  // Unrealised PnL — option premium if available, else spot proxy (minus charges)
  const isFut = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  let unrealised = 0;
  if (pos && state.lastTickPrice) {
    const optEntry = pos.optionEntryLtp;
    const optCurr  = state.optionLtp || pos.optionCurrentLtp;
    const _q = pos.qty || getLotQty();
    if (optEntry && optCurr && optEntry > 0) {
      const _c = getCharges({ broker: "fyers", isFutures: isFut, exitPremium: optCurr, entryPremium: optEntry, qty: _q });
      unrealised = parseFloat(((optCurr - optEntry) * _q - _c).toFixed(2));
    } else {
      const _c = getCharges({ broker: "fyers", isFutures: isFut, exitPremium: state.lastTickPrice, entryPremium: pos.entryPrice, qty: _q });
      unrealised = parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * _q - _c).toFixed(2));
    }
  }

  const optEntryLtp   = pos ? (pos.optionEntryLtp || null) : null;
  const optCurrentLtp = pos ? (state.optionLtp || pos.optionCurrentLtp || null) : null;
  const _chgForPrem = (optEntryLtp && optCurrentLtp)
    ? getCharges({ broker: "fyers", isFutures: isFut, exitPremium: optCurrentLtp, entryPremium: optEntryLtp, qty: pos ? pos.qty : 0 }) : 0;
  const optPremiumPnl = (optEntryLtp && optCurrentLtp)
    ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0) - _chgForPrem).toFixed(2)) : null;
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
      peakPnl:           pos.peakPnl || 0,
      initialStopLoss:   pos.initialStopLoss,
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
    wins:          state._wins || 0,
    losses:        state._losses || 0,
    dailyLossHit:  state._dailyLossHit,
    slPauseUntil:  state._slPauseUntil || null,
    simMode:       state._simMode || false,
    simScenario:   state._simScenario || null,
    logTotal:      state.log.length,
    logs:          reverseSlice(state.log, 100),
    trades: [...(state.sessionTrades || [])].reverse().map(t => ({
      side:         t.side           || "",
      symbol:       t.symbol         || "",
      strike:       t.optionStrike   || "",
      expiry:       t.optionExpiry   || "",
      optionType:   t.optionType     || t.side || "",
      qty:          t.qty            || 0,
      entry:        t.entryTime      || "",
      exit:         t.exitTime       || "",
      entryBarTime: t.entryBarTime   || null,
      exitBarTime:  t.exitBarTime    || null,
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
  const liveActive  = sharedSocketState.getMode() === "SWING_LIVE";
  const pos         = state.position;
  const data        = loadPAData();

  // VIX details for top-bar display (PA-specific threshold)
  const _vix          = getCachedVix();
  const _vixEnabled   = process.env.PA_VIX_ENABLED === "true";
  const _vixMaxEntry  = vixFilter.getVixMaxEntry("pa");
  const _vixStrongOnly = Infinity; // PA does not use STRONG_ONLY — disable that branch in the badge

  // Unrealised PnL (minus charges to match exit P&L)
  const isFut2 = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  let unrealisedPnl = 0;
  if (pos && state.lastTickPrice) {
    const optEntry = pos.optionEntryLtp;
    const optCurr  = state.optionLtp || pos.optionCurrentLtp;
    const _q2 = pos.qty || getLotQty();
    if (optEntry && optCurr && optEntry > 0) {
      const _c2 = getCharges({ broker: "fyers", isFutures: isFut2, exitPremium: optCurr, entryPremium: optEntry, qty: _q2 });
      unrealisedPnl = parseFloat(((optCurr - optEntry) * _q2 - _c2).toFixed(2));
    } else {
      const _c2 = getCharges({ broker: "fyers", isFutures: isFut2, exitPremium: state.lastTickPrice, entryPremium: pos.entryPrice, qty: _q2 });
      unrealisedPnl = parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * _q2 - _c2).toFixed(2));
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
  const _chgForPrem2 = (optEntryLtp && optCurrentLtp)
    ? getCharges({ broker: "fyers", isFutures: isFut2, exitPremium: optCurrentLtp, entryPremium: optEntryLtp, qty: pos ? pos.qty : 0 }) : 0;
  const optPremiumPnl = (optEntryLtp && optCurrentLtp)
    ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0) - _chgForPrem2).toFixed(2)) : null;
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
          <span style="font-size:0.72rem;color:#4a6080;">Since ${fmtISTDateTime(pos.entryTime)}</span>
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
            <div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty} <span style="font-size:0.72rem;color:#4a6080;">(${(pos.qty / (instrumentConfig.LOT_SIZE[instrumentConfig.INSTRUMENT] || 65)).toFixed(0)} lot)</span></div>
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
            <div style="font-size:0.65rem;color:#4a6080;margin-top:4px;">${pos.qty} qty \u00b7 after charges</div>
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
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop Loss (Prev Candle)</div>
          <div id="ajax-stop-loss" style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.stopLoss ? inr(pos.stopLoss) : "\u2014"}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Peak P&L</div>
          <div id="ajax-peak-pnl" style="font-size:1.05rem;font-weight:700;color:${(pos.peakPnl || 0) >= 0 ? "#10b981" : "#ef4444"};">${(pos.peakPnl || 0) >= 0 ? "+" : ""}${inr(pos.peakPnl || 0)}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">SL Trailed</div>
          <div id="ajax-sl-trail" style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.stopLoss && pos.initialStopLoss ? (pos.side === "CE" ? "+" : "+") + Math.abs(pos.stopLoss - pos.initialStopLoss).toFixed(2) + " pts" : "0 pts"}</div>
          <div style="font-size:0.58rem;color:#4a6080;margin-top:2px;">from ${pos.initialStopLoss ? inr(pos.initialStopLoss) : "\u2014"}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:8px 10px;">
          <div style="font-size:0.55rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">SL Distance</div>
          <div id="ajax-sl-dist" style="font-size:0.9rem;font-weight:700;color:${(() => { const d = pos.stopLoss && liveClose ? Math.abs(liveClose - pos.stopLoss) : 0; return d < 20 ? "#ef4444" : d < 40 ? "#f59e0b" : "#10b981"; })()};">${pos.stopLoss && liveClose ? Math.abs(liveClose - pos.stopLoss).toFixed(1) : "0"} <span style="font-size:0.6rem;color:#4a6080;">pts</span></div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:8px 10px;">
          <div style="font-size:0.55rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">R:R</div>
          <div id="ajax-rr" style="font-size:0.9rem;font-weight:700;color:${pointsMoved >= 0 ? "#10b981" : "#ef4444"};">${(() => { const risk = pos.initialStopLoss ? Math.abs(pos.entryPrice - pos.initialStopLoss) : 0; return risk > 0 ? (pointsMoved / risk).toFixed(1) + "x" : "\u2014"; })()}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:8px 10px;">
          <div style="font-size:0.55rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Candles Held</div>
          <div id="ajax-pos-candles" style="font-size:0.9rem;font-weight:700;color:#c8d8f0;">${pos.candlesHeld || 0} <span style="font-size:0.6rem;color:#4a6080;">candles</span></div>
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
    entryBarTime: t.entryBarTime   || null,
    exitBarTime:  t.exitBarTime    || null,
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
<title>Price Action Paper \u2014 ${paStrategy.NAME}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u26a1</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
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

/* Copy buttons */
.copy-btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;transition:all 0.15s;white-space:nowrap;}
.copy-btn:hover{background:#0a1e3d;border-color:#3b82f6;}
.copy-btn.copied{background:#064e3b;border-color:#10b981;color:#10b981;}

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
${buildSidebar('paPaper', liveActive, state.running)}
<div class="main-content">

<!-- Top bar -->
<div class="top-bar">
  <div>
    <div class="top-bar-title">Price Action Paper Trade</div>
    <div class="top-bar-meta">Strategy: ${paStrategy.NAME} \u00b7 ${PA_RES}-min candles \u00b7 SL: Prev Candle \u00b7 Trail ${_PA_TRAIL_PCT}%+ tiered from \u20b9${_PA_TRAIL_START} \u00b7 ${state.running ? 'Auto-refreshes every 2s' : 'Stopped'}</div>
  </div>
  <div class="top-bar-right">
    ${state.running
      ? `<span class="top-bar-badge badge-running"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>RUNNING</span>`
      : `<span class="top-bar-badge badge-stopped">IDLE</span>`}
    ${_vixEnabled ? `<span class="top-bar-badge" style="border-color:${_vix == null ? 'rgba(100,116,139,0.3)' : _vix > _vixMaxEntry ? 'rgba(239,68,68,0.3)' : _vix > _vixStrongOnly ? 'rgba(234,179,8,0.3)' : 'rgba(16,185,129,0.3)'};background:${_vix == null ? 'rgba(100,116,139,0.08)' : _vix > _vixMaxEntry ? 'rgba(239,68,68,0.1)' : _vix > _vixStrongOnly ? 'rgba(234,179,8,0.1)' : 'rgba(16,185,129,0.1)'};color:${_vix == null ? '#94a3b8' : _vix > _vixMaxEntry ? '#ef4444' : _vix > _vixStrongOnly ? '#eab308' : '#10b981'};">VIX ${_vix != null ? _vix.toFixed(1) : 'n/a'}${_vix != null ? (_vix > _vixMaxEntry ? ' \u00b7 BLOCKED' : _vix > _vixStrongOnly ? ' \u00b7 STRONG ONLY' : ' \u00b7 NORMAL') : ''}</span>` : ''}
    ${state.running
      ? `<button onclick="location='/pa-paper/stop'" style="background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;padding:5px 14px;border-radius:6px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;">Stop Session</button>`
      : `<button onclick="location='/pa-paper/start'" style="background:#1e40af;border:1px solid #3b82f6;color:#fff;padding:5px 14px;border-radius:6px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;">Start Price Action Paper</button>`}
    <a href="/pa-paper/history" style="background:rgba(59,130,246,0.08);border:0.5px solid rgba(59,130,246,0.3);color:#60a5fa;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;text-decoration:none;font-family:inherit;">📊 History</a>
    <button onclick="ptHandleReset(this)" style="background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;">↺ Reset</button>
  </div>
</div>

<!-- Capital strip -->
<div class="capital-strip">
  <div class="cap-cell">
    <div class="cap-label">Starting Capital</div>
    <div class="cap-val">\u20b9${getPACapitalFromEnv().toLocaleString("en-IN")}</div>
  </div>
  <div class="cap-cell">
    <div class="cap-label">Current Capital</div>
    <div class="cap-val" id="ajax-current-capital" style="color:${data.capital >= getPACapitalFromEnv() ? '#10b981' : '#ef4444'};">\u20b9${data.capital.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
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
    <div class="sc-val"><span id="ajax-trade-count">${state.sessionTrades.length}</span> <span style="font-size:0.75rem;color:#4a6080;">/ ${_PA_MAX_TRADES}</span></div>
    <div id="ajax-wl" style="font-size:0.7rem;color:#4a6080;margin-top:4px;">${wins}W \u00b7 ${losses}L</div>
  </div>
  <div class="sc" style="border-top:2px solid ${state._slPauseUntil && Date.now() < state._slPauseUntil ? '#ef4444' : '#4a6080'};">
    <div class="sc-label">SL Pause</div>
    <div class="sc-val" id="ajax-sl-pause" style="color:${state._slPauseUntil && Date.now() < state._slPauseUntil ? '#ef4444' : '#10b981'}">${state._slPauseUntil && Date.now() < state._slPauseUntil ? 'PAUSED' : 'OK'}</div>
    <div id="ajax-sl-pause-sub" style="font-size:0.7rem;margin-top:4px;color:#4a6080;">${_PA_PAUSE_CANDLES} candle cooldown after SL</div>
  </div>
  <div class="sc" style="border-top:2px solid ${state._dailyLossHit ? '#ef4444' : '#10b981'};">
    <div class="sc-label">Daily Loss Limit</div>
    <div class="sc-val" id="ajax-daily-loss-val" style="color:${state._dailyLossHit ? '#ef4444' : '#10b981'};">${state._dailyLossHit ? 'HIT' : 'OK'} <span style="font-size:0.65rem;color:#4a6080;">/ -\u20b9${_PA_MAX_LOSS.toLocaleString("en-IN")}</span></div>
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
    <div class="sc-val" style="font-size:0.85rem;color:#c8d8f0;">${fmtISTDateTime(state.sessionStart)}</div>
  </div>
</div>

<!-- Current bar -->
<div style="margin-bottom:18px;">
  <div class="section-title">Current ${PA_RES}-Min Bar (forming)</div>
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

${process.env.CHART_ENABLED !== "false" ? `<!-- NIFTY Chart -->
<div style="margin-bottom:18px;">
  <div class="section-title">NIFTY ${PA_RES}-Min Chart</div>
  <div id="sp-sel-banner" style="display:none;align-items:center;gap:10px;background:#0a1e3d;border:1px solid #1d3b6e;border-radius:8px;padding:6px 12px;margin-bottom:8px;font-size:0.72rem;"></div>
  <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
    <div id="nifty-chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
      <span style="color:#3b82f6;">▲ Entry</span> &nbsp;<span style="color:#10b981;">▼ Win</span> &nbsp;<span style="color:#ef4444;">▼ Loss</span> &nbsp;<span style="color:#64748b;">● Swing H/L</span> &nbsp;<span style="color:#f59e0b;">── SL</span> &nbsp;<span style="color:#3b82f6;">-- Entry</span>
    </div>
  </div>
</div>` : ""}

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
    <button class="copy-btn" onclick="copyTradeLog(this)" style="margin-left:auto;">📋 Copy Trade Log</button>
  </div>
  <div style="border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#0a0f1c;">
        <th onclick="spSort('side')" style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Side</th>
        <th onclick="spSort('entry')" style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Date</th>
        <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry</th>
        <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry Time</th>
        <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit</th>
        <th onclick="spSort('exit')" style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">Exit Time</th>
        <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">SL</th>
        <th onclick="spSort('pnl')" style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;cursor:pointer;">PnL</th>
        <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry Reason</th>
        <th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit Reason</th>
        <th style="padding:9px 12px;text-align:center;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Action</th>
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
          <span style="font-size:0.65rem;color:#4a6080;margin-left:10px;">Price Action Paper \u2014 Full Details</span>
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
    <button class="copy-btn" onclick="copyActivityLog(this)" style="margin-left:auto;">📋 Copy Log</button>
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
async function spHandleExit(btn) {
  var ok = await showConfirm({
    icon: '🚪',
    title: 'Exit position',
    message: 'Exit current position now?',
    confirmText: 'Exit',
    confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = 'Exiting...';
  fetch('/pa-paper/exit').then(function(){ location.reload(); }).catch(function(){ location.reload(); });
}

async function spManualEntry(side) {
  var ok = await showConfirm({
    icon: '✋',
    title: 'Manual entry',
    message: 'Manual ' + side + ' entry at current spot?',
    confirmText: 'Enter ' + side
  });
  if (!ok) return;
  try {
    var res = await fetch('/pa-paper/manualEntry', {
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
function spFmtDate(dt){ if(!dt) return '\\u2014'; var p=dt.split(', '); var d=(p[0]||'').split('/'); if(d.length>=2) return d[0].padStart(2,'0')+'/'+d[1].padStart(2,'0')+(d[2]?'/'+d[2]:''); return p[0]||'\\u2014'; }
function spFmtTime(dt){ if(!dt) return '\\u2014'; var p=dt.split(', '); return p[1]||'\\u2014'; }

function spRender() {
  var start = (spPage-1)*spPP, slice = spFiltered.slice(start, start+spPP);
  var countEl = document.getElementById('spCount');
  if (countEl) countEl.textContent = spFiltered.length + '/' + SP_ALL.length + ' trades';
  window._spSlice = slice;
  var body = document.getElementById('spBody');
  if (!body) return;
  if (slice.length === 0) {
    body.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:20px;color:#4a6080;">No trades match filters.</td></tr>';
  } else {
    body.innerHTML = slice.map(function(t, i) {
      var sc  = t.side === 'CE' ? '#10b981' : '#ef4444';
      var pc  = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
      var short = t.reason.length > 35 ? t.reason.slice(0,35)+'\\u2026' : t.reason;
      var isSel = (window._spSelEt != null && t.entryBarTime === window._spSelEt);
      var rowBg = isSel ? 'background:#0a1e3d;' : '';
      var clickable = t.entryBarTime != null;
      return '<tr class="sp-row' + (isSel?' sp-row-sel':'') + '" data-idx="' + i + '" data-et="' + (t.entryBarTime||'') + '" data-xt="' + (t.exitBarTime||'') + '" style="border-top:1px solid #1a2236;vertical-align:top;' + (clickable?'cursor:pointer;':'') + rowBg + '" title="' + (clickable?'Click to focus chart on this trade':'') + '">' +
        '<td style="padding:8px 12px;color:' + sc + ';font-weight:800;">' + (t.side||'\\u2014') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.75rem;">' + spFmtDate(t.entry) + '</td>' +
        '<td style="padding:8px 12px;font-weight:700;">' + spFmt(t.eSpot) + '</td>' +
        '<td style="padding:8px 12px;font-size:0.75rem;">' + spFmtTime(t.entry) + '</td>' +
        '<td style="padding:8px 12px;font-weight:700;">' + spFmt(t.xSpot) + '</td>' +
        '<td style="padding:8px 12px;font-size:0.75rem;">' + spFmtTime(t.exit) + '</td>' +
        '<td style="padding:8px 12px;color:#f59e0b;">' + (t.eSl?spFmt(t.eSl):'\\u2014') + '</td>' +
        '<td style="padding:8px 12px;"><div style="font-size:1rem;font-weight:800;color:' + pc + ';">' + (t.pnl!=null?(t.pnl>=0?'+':'')+spFmt(t.pnl):'\\u2014') + '</div></td>' +
        '<td style="padding:8px 12px;font-size:0.7rem;color:#4a6080;" title="' + (t.entryReason||'') + '">' + (t.entryReason?(t.entryReason.length>25?t.entryReason.slice(0,25)+'\\u2026':t.entryReason):'\\u2014') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.7rem;color:#4a6080;" title="' + t.reason + '">' + (short||'\\u2014') + '</td>' +
        '<td style="padding:6px 8px;text-align:center;white-space:nowrap;">' +
          '<button data-et="' + (t.entryBarTime||'') + '" data-xt="' + (t.exitBarTime||'') + '" class="sp-chart-btn" style="background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;margin-right:4px;" title="Focus chart on this trade">\u{1F4C8}</button>' +
          '<button data-idx="' + i + '" class="sp-eye-btn" style="background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;" title="View full details">View</button>' +
        '</td>' +
        '</tr>';
    }).join('');
    Array.from(document.querySelectorAll('.sp-eye-btn')).forEach(function(btn){
      btn.addEventListener('click',function(ev){ ev.stopPropagation(); showSPModal(window._spSlice[parseInt(this.getAttribute('data-idx'))]); });
      btn.addEventListener('mouseover',function(){ this.style.borderColor='#3b82f6';this.style.background='#0a1e3d'; });
      btn.addEventListener('mouseout', function(){ this.style.borderColor='#1a2236';this.style.background='none'; });
    });
    Array.from(document.querySelectorAll('.sp-chart-btn')).forEach(function(btn){
      btn.addEventListener('click',function(ev){
        ev.stopPropagation();
        var et = parseInt(this.getAttribute('data-et')); var xt = parseInt(this.getAttribute('data-xt'));
        if (!et) return;
        if (typeof spSelectTrade === 'function') spSelectTrade(et, isNaN(xt) ? null : xt);
      });
      btn.addEventListener('mouseover',function(){ this.style.borderColor='#3b82f6';this.style.background='#0a1e3d'; });
      btn.addEventListener('mouseout', function(){ this.style.borderColor='#1a2236';this.style.background='none'; });
    });
    Array.from(document.querySelectorAll('.sp-row')).forEach(function(row){
      row.addEventListener('click', function(){
        var et = parseInt(this.getAttribute('data-et')); var xt = parseInt(this.getAttribute('data-xt'));
        if (!et) return;
        if (typeof spSelectTrade === 'function') spSelectTrade(et, isNaN(xt) ? null : xt);
      });
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
    + cell('Symbol', t.symbol || '\\u2014', '#c8d8f0')
    + cell('Strike', t.strike || '\\u2014', '#e0eaf8')
    + cell('Expiry', t.expiry || '\\u2014', '#f59e0b')
    + cell('Option Type', t.optionType || t.side || '\\u2014', sc)
    + cell('Qty / Lots', t.qty ? t.qty + ' qty' : '\\u2014', '#c8d8f0')
    + cell('PnL Mode', t.pnlMode || 'spot-diff', '#8b8bf0')
    + '</div></div>';

  var entryHtml = '<div style="background:#060c18;border:1px solid #0d2040;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a4080;margin-bottom:8px;font-weight:700;">Entry</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
    + cell('Entry Time', t.entry || '\\u2014', '#c8d8f0')
    + cell('NIFTY Spot @ Entry', fmt(t.eSpot), '#e0eaf8', 'Index price at entry')
    + cell('Option LTP @ Entry', fmt(t.eOpt), '#60a5fa', 'Option premium paid')
    + cell('Initial Stop Loss', fmt(t.eSl), '#f59e0b', 'NIFTY spot SL level')
    + cell('SL Distance', (t.eSl && t.eSpot) ? Math.abs(t.eSpot - t.eSl).toFixed(2) + ' pts' : '\\u2014', '#f59e0b', 'pts from entry to SL')
    + cell('Entry Signal', t.entryReason || '\\u2014', '#c8d8f0')
    + '</div></div>';

  var exitHtml = '<div style="background:#0c0608;border:1px solid #3a0d12;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#801a20;margin-bottom:8px;font-weight:700;">Exit</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
    + cell('Exit Time', t.exit || '\\u2014', '#c8d8f0')
    + cell('NIFTY Spot @ Exit', fmt(t.xSpot), '#e0eaf8', 'Index price at exit')
    + cell('Option LTP @ Exit', fmt(t.xOpt), '#60a5fa', 'Option premium at exit')
    + cell('NIFTY Move (pts)', pnlPts != null ? (pnlPts >= 0 ? '+' : '') + pnlPts + ' pts' : '\\u2014', pnlPts != null ? (pnlPts >= 0 ? '#10b981' : '#ef4444') : '#c8d8f0', t.side === 'PE' ? 'Entry-Exit (PE profits on fall)' : 'Exit-Entry (CE profits on rise)')
    + cell('Option Move (pts)', optDiff != null ? (optDiff >= 0 ? '\\u25b2 +' : '\\u25bc ') + optDiff + ' pts' : '\\u2014', dc, 'Exit prem - Entry prem')
    + cell('Net PnL', t.pnl != null ? (t.pnl >= 0 ? '+' : '') + fmt(t.pnl) : '\\u2014', pc, 'After STT + charges')
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

// ── Copy Trade Log ──────────────────────────────────────────────────
function copyTradeLog(btn){
  var lines=['Side\\tDate\\tEntry\\tEntry Time\\tExit\\tExit Time\\tSL\\tPnL\\tEntry Reason\\tExit Reason'];
  SP_ALL.forEach(function(t){
    lines.push((t.side||'')+'\\t'+spFmtDate(t.entry)+'\\t'+(t.eSpot||'')+'\\t'+spFmtTime(t.entry)+'\\t'+(t.xSpot||'')+'\\t'+spFmtTime(t.exit)+'\\t'+(t.eSl||'')+'\\t'+(t.pnl!=null?t.pnl.toFixed(2):'')+'\\t'+(t.entryReason||'')+'\\t'+(t.reason||''));
  });
  doCopy(lines.join('\\n'),btn,'Trade Log');
}
function copyActivityLog(btn){
  doCopy(LOG_ALL.join('\\n'),btn,'Log');
}
function doCopy(text,btn,label){
  var orig='\\ud83d\\udccb Copy '+label;
  function onOk(){ btn.classList.add('copied');btn.textContent='\\u2705 Copied!'; setTimeout(function(){ btn.classList.remove('copied');btn.textContent=orig; },2000); }
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

async function ptHandleReset(btn) {
  var ok = await showDoubleConfirm({
    icon: '⚠️', title: 'Reset Price Action Paper Trade',
    message: 'Reset ALL Price Action paper trade history?\\nThis wipes all sessions and restores starting capital.\\nCannot be undone.',
    confirmText: 'Reset All', confirmClass: 'modal-btn-danger',
    subject: 'ALL PA paper sessions & capital',
    secondConfirmText: 'Yes, reset all'
  });
  if (!ok) return;
  if (btn) { btn.textContent = '⏳...'; btn.disabled = true; }
  try {
    var res = await secretFetch('/pa-paper/reset');
    if (!res) { if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; } return; }
    var data;
    try { data = await res.json(); } catch(_) { data = { success: false, error: 'Server error (status ' + res.status + ')' }; }
    if (!data.success) {
      if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; }
      await showAlert({ icon: '❌', title: 'Reset Failed', message: data.error || 'Reset failed', btnClass: 'modal-btn-danger' });
      return;
    }
    location.reload();
  } catch(e) {
    if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; }
    await showAlert({ icon: '❌', title: 'Reset Failed', message: e.message, btnClass: 'modal-btn-danger' });
  }
}
</script>
<script>
// ── NIFTY Chart (Lightweight Charts) ─────────────────────────────────────
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var container = document.getElementById('nifty-chart');
  if (!container) return;
  var chart = LightweightCharts.createChart(container, {
    width: container.clientWidth, height: container.clientHeight,
    layout: { background: { type: 'solid', color: '#0a0f1c' }, textColor: '#4a6080', fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" },
    grid: { vertLines: { color: '#111827' }, horzLines: { color: '#111827' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1a2236', scaleMargins: { top: 0.1, bottom: 0.05 } },
    timeScale: { borderColor: '#1a2236', timeVisible: true, secondsVisible: false,
      tickMarkFormatter: function(t) { var d = new Date(t*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
    },
  });
  var cs = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var slLine = null, entryLine = null, selEntryLine = null, selSlLine = null, _lcc = 0;
  chart.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: false, lockVisibleTimeRangeOnResize: true });
  // Robust zoom preservation: track user-driven range and restore after every poll.
  var _userRange = null, _internalUpdate = false, _internalTimer = null;
  chart.timeScale().subscribeVisibleLogicalRangeChange(function(r) {
    if (_internalUpdate) return;
    if (r) _userRange = r;
  });
  async function fetchChart() {
    try {
      var res = await fetch('/pa-paper/status/chart-data', { cache: 'no-store' });
      if (!res.ok) return; var d = await res.json();
      if (!d.candles || !d.candles.length) return;
      _internalUpdate = true;
      if (Math.abs(d.candles.length - _lcc) > 1 || _lcc === 0) {
        cs.setData(d.candles.map(function(c) { return { time:c.time, open:c.open, high:c.high, low:c.low, close:c.close }; }));
      } else { var l = d.candles[d.candles.length-1]; cs.update({ time:l.time, open:l.open, high:l.high, low:l.low, close:l.close }); }
      _lcc = d.candles.length;
      if (_userRange) { try { chart.timeScale().setVisibleLogicalRange(_userRange); } catch(_) {} }
      if (_internalTimer) clearTimeout(_internalTimer);
      _internalTimer = setTimeout(function() { _internalUpdate = false; }, 60);
      var selEt = window._spSelEt || null;
      var allMarkers = (d.markers || []).slice();
      var markers = allMarkers;
      if (selEt) {
        // Show only this trade's entry/exit arrows + swing markers in the window; hide other trades'
        var sel = (window._spSelectedTrade || {});
        var selXt = sel.xt || selEt;
        markers = allMarkers.filter(function(m) {
          if (m.shape === 'circle') return m.time >= selEt - 20*60 && m.time <= selXt + 20*60;
          if (m.shape === 'arrowUp')   return m.time === selEt;
          if (m.shape === 'arrowDown') return m.time === selXt;
          return true;
        });
      }
      if (markers.length) { var s = markers.slice().sort(function(a,b){return a.time-b.time;}); cs.setMarkers(s); } else { cs.setMarkers([]); }
      if (slLine) { cs.removePriceLine(slLine); slLine = null; }
      if (d.stopLoss && !selEt) { slLine = cs.createPriceLine({ price:d.stopLoss, color:'#f59e0b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'SL' }); }
      if (entryLine) { cs.removePriceLine(entryLine); entryLine = null; }
      if (d.entryPrice && !selEt) { entryLine = cs.createPriceLine({ price:d.entryPrice, color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' }); }
      // When a trade is selected, draw its own entry + SL lines
      if (selSlLine) { cs.removePriceLine(selSlLine); selSlLine = null; }
      if (selEntryLine) { cs.removePriceLine(selEntryLine); selEntryLine = null; }
      if (selEt && window._spSelectedTrade) {
        var st = window._spSelectedTrade;
        if (st.eSpot) selEntryLine = cs.createPriceLine({ price: st.eSpot, color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
        if (st.eSl)   selSlLine    = cs.createPriceLine({ price: st.eSl,   color:'#f59e0b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'SL' });
      }
    } catch(e) { console.warn('[Chart]', e.message); }
  }
  window._paFetchChart = fetchChart;
  window._paChart = chart;
  fetchChart();
  if (${state.running}) setInterval(fetchChart, 4000);
  window.addEventListener('resize', function() { chart.applyOptions({ width: container.clientWidth }); });
})();

// ── Click-to-focus a trade on the chart ───────────────────────────────────
function spSelectTrade(et, xt) {
  if (!et) return;
  if (window._spSelEt === et) { spClearSelection(); return; }
  window._spSelEt = et;
  var trade = (window.SP_ALL || []).find(function(t){ return t.entryBarTime === et; });
  window._spSelectedTrade = trade ? { et: et, xt: xt || trade.exitBarTime || et, eSpot: trade.eSpot, eSl: trade.eSl } : { et: et, xt: xt || et };
  if (typeof spRender === 'function') spRender();
  spUpdateBanner();
  if (window._paFetchChart) window._paFetchChart();
  // Zoom chart around the trade window
  if (window._paChart) {
    var pad = 20 * 60; // 20 min padding either side
    try { window._paChart.timeScale().setVisibleRange({ from: et - pad, to: (xt || et) + pad }); } catch(_) {}
  }
}
function spClearSelection() {
  window._spSelEt = null; window._spSelectedTrade = null;
  if (typeof spRender === 'function') spRender();
  spUpdateBanner();
  if (window._paFetchChart) window._paFetchChart();
  if (window._paChart) { try { window._paChart.timeScale().fitContent(); } catch(_) {} }
}
function spUpdateBanner() {
  var el = document.getElementById('sp-sel-banner'); if (!el) return;
  if (window._spSelEt && window._spSelectedTrade) {
    var t = window._spSelectedTrade;
    var d = new Date(t.et * 1000);
    var hh = ('0'+d.getHours()).slice(-2), mm = ('0'+d.getMinutes()).slice(-2);
    el.style.display = 'flex';
    el.innerHTML = '<span style="color:#4a9cf5;">\\u25b6 Focused on trade entered at ' + hh + ':' + mm + '</span>&nbsp;&nbsp;<button onclick="spClearSelection()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:2px 10px;border-radius:5px;font-size:0.68rem;cursor:pointer;font-family:inherit;">Show All Trades</button>';
  } else { el.style.display = 'none'; el.innerHTML = ''; }
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
      var res = await fetch('/pa-paper/status/data', { cache: 'no-store' });
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
      if (capEl) { capEl.textContent = '\\u20b9' + d.capital.toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2}); capEl.style.color = d.capital >= ${getPACapitalFromEnv()} ? '#10b981' : '#ef4444'; }
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
        // Peak P&L
        var peakEl = document.getElementById('ajax-peak-pnl');
        if (peakEl) {
          var peak = p.peakPnl || 0;
          peakEl.textContent = (peak >= 0 ? '+' : '') + INR(peak);
          peakEl.style.color = peak >= 0 ? '#10b981' : '#ef4444';
        }
        // SL Trailed
        var slTrailEl = document.getElementById('ajax-sl-trail');
        if (slTrailEl && p.stopLoss && p.initialStopLoss) {
          slTrailEl.textContent = Math.abs(p.stopLoss - p.initialStopLoss).toFixed(2) + ' pts';
        }
        // SL Distance
        var slDistEl = document.getElementById('ajax-sl-dist');
        if (slDistEl && p.stopLoss && ltpNow) {
          var dist = Math.abs(ltpNow - p.stopLoss);
          slDistEl.innerHTML = dist.toFixed(1) + ' <span style="font-size:0.6rem;color:#4a6080;">pts</span>';
          slDistEl.style.color = dist < 20 ? '#ef4444' : dist < 40 ? '#f59e0b' : '#10b981';
        }
        // R:R
        var rrEl = document.getElementById('ajax-rr');
        if (rrEl && p.initialStopLoss) {
          var risk = Math.abs(p.entryPrice - p.initialStopLoss);
          var moved = (ltpNow - p.entryPrice) * (p.side === 'CE' ? 1 : -1);
          if (risk > 0) {
            var rr = (moved / risk).toFixed(1);
            rrEl.textContent = rr + 'x';
            rrEl.style.color = moved >= 0 ? '#10b981' : '#ef4444';
          }
        }
        // Candles held
        var candPosEl = document.getElementById('ajax-pos-candles');
        if (candPosEl) candPosEl.innerHTML = (p.candlesHeld || 0) + ' <span style="font-size:0.6rem;color:#4a6080;">candles</span>';
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

  // Immediately refresh when tab becomes visible (browser throttles intervals for background tabs)
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible' && ${state.running}) {
      fetchAndUpdate();
      if (!_interval) _interval = setInterval(fetchAndUpdate, 2000);
    }
  });
  window.addEventListener('focus', function() {
    if (${state.running}) fetchAndUpdate();
  });
})();
</script>
</body>
</html>`);
});

// ── Price Action Paper History ─────────────────────────────────────────────────────

function getPACapitalFromEnv() {
  // PA trades through Fyers — its paper capital is the shared Fyers investment pool.
  const v = parseFloat(process.env.FYERS_INV_AMOUNT);
  return isNaN(v) ? 100000 : v;
}

router.get("/history", (req, res) => {
  const data = loadPAData();
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";

  // Canonical pattern name (uses t.pattern if present, else extracts from entryReason)
  const patternOf = (t) => {
    if (t && t.pattern) return t.pattern;
    const r = (t && t.entryReason) || "";
    if (/Inside Bar/i.test(r))            return "Inside Bar Breakout";
    if (/Bullish Engulfing/i.test(r))     return "Bullish Engulfing";
    if (/Bearish Engulfing/i.test(r))     return "Bearish Engulfing";
    if (/Hammer/i.test(r))                return "Hammer";
    if (/Shooting Star/i.test(r))         return "Shooting Star";
    if (/BOS/i.test(r))                   return "Break of Structure";
    if (/Double Top/i.test(r))            return "Double Top";
    if (/Double Bottom/i.test(r))         return "Double Bottom";
    if (/Ascending Triangle/i.test(r))    return "Ascending Triangle";
    if (/Descending Triangle/i.test(r))   return "Descending Triangle";
    return "Unknown";
  };
  // Group bullish+bearish variants under one filter key (mirrors the toggle scheme)
  const patternGroupOf = (t) => {
    const p = patternOf(t);
    if (p === "Bullish Engulfing" || p === "Bearish Engulfing") return "Engulfing";
    if (p === "Hammer" || p === "Shooting Star") return "Pin Bar";
    return p;
  };

  // Augment each trade with its derived pattern + group so the shared builder's
  // filter (field: patternGroup) and the pattern-breakdown table have the data.
  const sessions = (data.sessions || []).map(s => ({
    ...s,
    trades: (s.trades || []).map(t => ({ ...t, pattern: patternOf(t), patternGroup: patternGroupOf(t) })),
  }));

  // Pattern Breakdown — PA-only extra analytics block (always full-data, click-to-filter)
  const PATTERN_BREAKDOWN_HTML = '<div class="ana-row3"><div class="ana-mini" style="grid-column:1 / -1;"><h3>🎯 Pattern Breakdown (combined view — ignores filter)</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Pattern</th><th>Count</th><th>Wins</th><th>Losses</th><th>WR%</th><th>P&L</th><th>Avg</th><th>Best</th><th>Worst</th></tr></thead><tbody id="anaPatternBody"></tbody></table></div></div></div>';

  const PATTERN_BREAKDOWN_JS = `
function renderExtraAnalytics(){
  var patMap = {};
  ALL_TRADES_JSON.forEach(function(t){
    var g = t.patternGroup || 'Unknown';
    if (!patMap[g]) patMap[g] = { cnt:0, wins:0, losses:0, pnl:0, best:-Infinity, worst:Infinity };
    var d = patMap[g]; d.cnt++;
    var p = (typeof t.pnl === 'number') ? t.pnl : 0;
    d.pnl += p;
    if (p > 0) d.wins++; else if (p < 0) d.losses++;
    if (p > d.best) d.best = p;
    if (p < d.worst) d.worst = p;
  });
  var groups = Object.keys(patMap).sort(function(a,b){ return patMap[b].pnl - patMap[a].pnl; });
  var html = '';
  groups.forEach(function(g){
    var d = patMap[g];
    var pc = d.pnl >= 0 ? '#10b981' : '#ef4444';
    var wr = d.cnt>0 ? ((d.wins/d.cnt)*100).toFixed(0) : '0';
    var avg = d.cnt>0 ? Math.round(d.pnl/d.cnt) : 0;
    var bestStr = d.best === -Infinity ? '-' : fmtAna(d.best);
    var worstStr = d.worst === Infinity ? '-' : fmtAna(d.worst);
    html += '<tr data-pat-row="'+g+'" style="cursor:pointer;" title="Click to filter by '+g+'">'
      + '<td style="color:#a78bfa;font-weight:600;">'+g+'</td>'
      + '<td>'+d.cnt+'</td>'
      + '<td style="color:#10b981;">'+d.wins+'</td>'
      + '<td style="color:#ef4444;">'+d.losses+'</td>'
      + '<td style="color:'+(parseFloat(wr)>=55?'#10b981':parseFloat(wr)>=45?'#f59e0b':'#ef4444')+';">'+wr+'%</td>'
      + '<td style="color:'+pc+';font-weight:700;">'+fmtAna(d.pnl)+'</td>'
      + '<td style="color:'+pc+';">'+fmtAna(avg)+'</td>'
      + '<td style="color:#10b981;">'+bestStr+'</td>'
      + '<td style="color:#ef4444;">'+worstStr+'</td>'
      + '</tr>';
  });
  var body = document.getElementById('anaPatternBody');
  if (body){
    body.innerHTML = html || '<tr><td colspan="9" style="text-align:center;color:#3a5070;padding:14px;">No pattern data</td></tr>';
    Array.prototype.forEach.call(body.querySelectorAll('tr[data-pat-row]'), function(tr){
      tr.addEventListener('click', function(){
        var g = tr.getAttribute('data-pat-row');
        var sel = document.getElementById('historyFilter');
        if (sel) sel.value = g;
        applyHistoryFilter(g);
      });
    });
  }
}`;

  res.setHeader("Content-Type", "text/html");
  res.send(renderHistoryPage({
    routePrefix: "/pa-paper",
    sidebarKey: "paHistory",
    pageTitle: "⚡ Price Action Paper Trade History",
    pageDocTitle: "Price Action Paper — History",
    modalLabel: "Price Action Paper",
    liveActive,
    sessions,
    capital: data.capital,
    totalPnl: data.totalPnl,
    startCap: getPACapitalFromEnv(),
    emptyLabel: "Start Price Action paper trading to record your first session.",
    filter: { field: "patternGroup", label: "Pattern" },
    extraAnalyticsHTML: PATTERN_BREAKDOWN_HTML,
    extraAnalyticsJS: PATTERN_BREAKDOWN_JS,
  }));
});

/**
 * DELETE /pa-paper/session/:index
 * Delete a single session by its 0-based index in the sessions array
 */
router.delete("/session/:index", (req, res) => {
  if (state.running) {
    return res.status(400).json({
      success: false,
      error: "Stop price action paper trading first before deleting a session.",
    });
  }

  const data = loadPAData();
  const idx = parseInt(req.params.index, 10);

  if (isNaN(idx) || idx < 0 || idx >= data.sessions.length) {
    return res.status(400).json({ success: false, error: "Invalid session index." });
  }

  const removed = data.sessions.splice(idx, 1)[0];
  // Recalculate totalPnl and capital from remaining sessions
  data.totalPnl = data.sessions.reduce((sum, s) => sum + (s.pnl || 0), 0);
  data.capital = getPACapitalFromEnv() + data.totalPnl;
  savePAData(data);

  log(`🗑️ Deleted PA paper session ${idx + 1} (${removed.date || "unknown date"}, PnL: ${removed.pnl})`);

  return res.json({
    success: true,
    message: `Session deleted successfully.`,
  });
});

// ── Restore deleted/missing sessions from daily JSONL ────────────────────────
router.post("/restore-session/:date", (req, res) => {
  if (state.running) {
    return res.status(400).json({ success: false, error: "Stop PA paper trading before restoring." });
  }
  const date = String(req.params.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  }
  const allTrades = tradeLogger.readDailyTrades("pa", date);
  if (!allTrades.length) {
    return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  }
  const data = loadPAData();
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
  const session = {
    date,
    strategy: missing[0]?.strategy || "PA_PATTERN",
    pnl:      sessionPnl,
    trades:   missing,
    restoredFromJsonl: true,
  };
  data.sessions.push(session);
  data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((sum, s) => sum + (s.pnl || 0), 0).toFixed(2));
  data.capital = parseFloat((getPACapitalFromEnv() + data.totalPnl).toFixed(2));
  savePAData(data);
  log(`♻️ Restored PA paper session for ${date}: ${missing.length} trade(s), PnL ₹${sessionPnl}`);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

/**
 * GET /pa-paper/download/trades.jsonl
 * Stream the crash-safe per-trade JSONL log as a file download.
 */
router.get("/download/trades.jsonl", (req, res) => {
  const logPath = tradeLogger.filePathFor("pa");
  const today   = new Date().toISOString().slice(0, 10);
  const dlName  = `pa_paper_trades_log_${today}.txt`;
  if (!fs.existsSync(logPath)) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${dlName}"`);
    return res.send("");
  }
  res.download(logPath, dlName);
});

// ── Daily JSONL downloads (skips + trades) ───────────────────────────────────
const _DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /pa-paper/download/daily-files
 * Returns the list of available daily files (skips + trades) for the UI.
 */
router.get("/download/daily-files", (req, res) => {
  const skips  = skipLogger.listDates("pa");
  const trades = tradeLogger.listDailyDates("pa");
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
  const dlName = `pa_paper_skips_all_${today}.txt`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${dlName}"`);
  const dates = skipLogger.listDates("pa").map(d => d.date).sort();
  let body = "";
  for (const d of dates) {
    try {
      const p = skipLogger.filePathFor("pa", d);
      if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8");
    } catch (_) {}
  }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor("pa", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `pa_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor("pa", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `pa_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor("pa", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor("pa", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

/**
 * GET /pa-paper/reset
 * Wipe all price action paper trade history and reset capital
 */
router.get("/reset", (req, res) => {
  if (state.running) {
    return res.status(400).json({
      success: false,
      error: "Stop price action paper trading first before resetting.",
    });
  }

  const freshCapital = getPACapitalFromEnv();
  savePAData({ capital: freshCapital, totalPnl: 0, sessions: [] });

  log(`🔄 PA paper trade data reset. Capital restored to ₹${freshCapital.toLocaleString("en-IN")}`);

  return res.json({
    success: true,
    message: `PA paper trade history cleared. Capital reset to ₹${freshCapital.toLocaleString("en-IN")}`,
  });
});

// ── Simulation mode routes ─────────────────────────────────────────────────

router.get("/simulate", (req, res) => {
  if (state.running) return res.redirect("/pa-paper/status");

  const scenarios = tickSimulator.getScenarios();
  const cards = Object.entries(scenarios).map(([key, s]) => `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;cursor:pointer;transition:border-color 0.2s,background 0.2s;"
         onmouseover="this.style.borderColor='#3b82f6';this.style.background='#111b2e'"
         onmouseout="this.style.borderColor='#1a2236';this.style.background='#0d1320'"
         onclick="startSim('${key}')">
      <div style="font-size:1rem;font-weight:700;color:#e2e8f0;margin-bottom:6px;">${s.label}</div>
      <div style="font-size:0.78rem;color:#6b7fa0;line-height:1.5;">${s.desc}</div>
    </div>
  `).join("");

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Simulate — Price Action Paper</title>
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
.sim-btn{background:#1e40af;color:#fff;border:none;border-radius:8px;padding:12px 28px;font-size:0.9rem;font-weight:700;cursor:pointer;font-family:inherit;transition:background 0.15s;margin-top:16px;}
.sim-btn:hover{background:#2563eb;}
.sim-btn:disabled{opacity:0.5;cursor:not-allowed;}
.selected{border-color:#3b82f6 !important;background:#111b2e !important;box-shadow:0 0 0 2px #3b82f644;}
</style>
</head><body>
<div class="app-shell">
${buildSidebar('paPaper', false)}
<div class="main-content">
  <h1 style="font-size:1.4rem;font-weight:800;color:#e2e8f0;margin-bottom:4px;">Simulate — Price Action Paper</h1>
  <p style="font-size:0.82rem;color:#6b7fa0;margin-bottom:8px;">Run your price action strategy against fake ticks — no broker login needed. Works after market hours.</p>
  <p style="font-size:0.75rem;color:#4a6080;">Resolution: <strong>${PA_RES}-min</strong> candles</p>

  <!-- ── Tab switcher ─────────────────────────────────────────────── -->
  <div style="display:flex;gap:0;margin-top:24px;border-bottom:2px solid #1a2236;">
    <button id="tabScenario" onclick="switchTab('scenario')" style="padding:10px 24px;font-size:0.82rem;font-weight:700;background:transparent;border:none;border-bottom:2px solid #3b82f6;color:#3b82f6;cursor:pointer;font-family:inherit;margin-bottom:-2px;">Synthetic Scenarios</button>
    <button id="tabHistory" onclick="switchTab('history')" style="padding:10px 24px;font-size:0.82rem;font-weight:700;background:transparent;border:none;border-bottom:2px solid transparent;color:#6b7fa0;cursor:pointer;font-family:inherit;margin-bottom:-2px;">Replay Historical Date</button>
  </div>

  <!-- ── Scenario tab ─────────────────────────────────────────────── -->
  <div id="panelScenario">
    <div style="font-size:0.75rem;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1.5px;margin-top:20px;">Choose a Scenario</div>
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
    <p style="font-size:0.78rem;color:#6b7fa0;margin-top:8px;">Pick a date to replay that day's real ${PA_RES}-min candles as ticks through your strategy.</p>
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
  document.getElementById('tabScenario').style.borderBottomColor = isScenario ? '#3b82f6' : 'transparent';
  document.getElementById('tabScenario').style.color = isScenario ? '#3b82f6' : '#6b7fa0';
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
  _post('/pa-paper/simulate/start', {
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
  _post('/pa-paper/simulate/start', {
    mode: 'historical', date: date,
    speed: parseInt(document.getElementById('replaySpeed').value) || 10,
  }, btn, 'Replay Selected Date');
}
function _post(url, body, btn, resetLabel) {
  fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })
    .then(r=>r.json()).then(d=>{
      if(d.success){ window.location.href='/pa-paper/status'; }
      else { document.getElementById('status').textContent='Error: '+(d.error||'Unknown'); btn.disabled=false; btn.textContent=resetLabel; }
    }).catch(e=>{ document.getElementById('status').textContent='Error: '+e.message; btn.disabled=false; btn.textContent=resetLabel; });
}
</script>
</body></html>`);
});

router.post("/simulate/start", async (req, res) => {
  if (state.running) return res.json({ success: false, error: "Session already running. Stop it first." });

  const { mode = "scenario", scenario, basePrice = 24500, speed = 10, candleCount = 75, date } = req.body || {};

  // Common state reset — simDate is optional YYYY-MM-DD for historical replay
  function resetSimState(label, simDate) {
    state = {
      running: true, position: null, candles: [], currentBar: null, barStartTime: null,
      log: [], sessionTrades: [], sessionStart: new Date().toISOString(),
      sessionPnl: 0, _wins: 0, _losses: 0, tickCount: 0, lastTickTime: null, lastTickPrice: null,
      optionLtp: null, optionSymbol: null, _slPauseUntil: null, _dailyLossHit: false,
      _expiryDayBlocked: false,
      _simMode: true, _simScenario: label,
    };
    // 09:15 IST = 03:45 UTC on the same IST date
    const simStart = simDate
      ? new Date(simDate + "T09:15:00+05:30")
      : new Date();
    if (!simDate) simStart.setUTCHours(3, 45, 0, 0);
    _simClockMs = simStart.getTime();
  }

  function makeCandleDone(total) {
    return (candle, idx) => {
      if ((idx + 1) % 10 === 0) {
        log(`🎮 [SIM] Progress: ${idx + 1}/${total} candles | Trades: ${state.sessionTrades.length} | PnL: ₹${state.sessionPnl.toFixed(2)}`);
      }
    };
  }
  function onSimDone() {
    log(`🏁 [SIM] Simulation complete — ${state.sessionTrades.length} trades, PnL: ₹${state.sessionPnl.toFixed(2)}`);
    if (state.position) {
      simulateSell(state.lastTickPrice || state.position.entryPrice, "Simulation ended", state.lastTickPrice);
    }
    state._simMode = false;
  }

  // ── Historical date replay ──────────────────────────────────────────────
  if (mode === "historical") {
    if (!date) return res.json({ success: false, error: "Date is required for historical replay" });

    resetSimState(`replay:${date}`, date);
    log(`🎮 [SIM] Fetching ${PA_RES}-min candles for ${date}...`);

    try {
      const { fetchCandlesCached, clearCache } = require("../utils/candleCache");
      const { fetchCandles } = require("../services/backtestEngine");

      // Fetch candles: 10 calendar days before target date for warmup
      const targetDate = new Date(date + "T00:00:00+05:30");
      const fromDate = new Date(targetDate);
      fromDate.setDate(fromDate.getDate() - 10);
      const fromStr = fromDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

      // Clear cache to avoid stale partial data from a previous live session
      clearCache(NIFTY_INDEX_SYMBOL, String(PA_RES));

      const allCandles = await fetchCandlesCached(
        NIFTY_INDEX_SYMBOL, String(PA_RES), fromStr, date, fetchCandles
      );

      if (!allCandles || allCandles.length < 35) {
        state.running = false; state._simMode = false;
        return res.json({ success: false, error: `Not enough candles for ${date} — got ${allCandles ? allCandles.length : 0}. Is it a trading day?` });
      }

      // Fetch 1-min candles for high-fidelity tick replay
      let tickCandles1m = [];
      try {
        clearCache(NIFTY_INDEX_SYMBOL, "1");
        const allTick = await fetchCandlesCached(
          NIFTY_INDEX_SYMBOL, "1", date, date, fetchCandles
        );
        if (allTick && allTick.length > 0) {
          tickCandles1m = allTick.filter(c => {
            const cDate = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
            return cDate === date;
          });
          log(`📊 [SIM] Fetched ${tickCandles1m.length} × 1-min candles for high-fidelity tick replay`);
        }
      } catch (e) {
        log(`⚠️ [SIM] 1-min candle fetch failed (${e.message}) — using ${PA_RES}-min interpolation`);
      }

      // Split by date: before target = warmup, on target = session
      const warmupCandles = [];
      const sessionCandles = [];
      for (const c of allCandles) {
        const cDate = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        if (cDate < date) warmupCandles.push(c);
        else if (cDate === date) sessionCandles.push(c);
      }

      if (sessionCandles.length === 0) {
        state.running = false; state._simMode = false;
        return res.json({ success: false, error: `No candles found for ${date} — holiday or weekend?` });
      }

      const warmup = warmupCandles.slice(-30);

      // Fetch prev day OHLC
      try {
        const dailyCandles = await fetchCandles(NIFTY_INDEX_SYMBOL, "D", fromStr, date);
        const pastDays = dailyCandles.filter(c => {
          const d = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
          return d < date;
        }).sort((a, b) => a.time - b.time);
        if (pastDays.length >= 1) {
          const prev = pastDays[pastDays.length - 1];
          _prevDayOHLC = { high: prev.high, low: prev.low, close: prev.close };
        }
        if (pastDays.length >= 2) {
          const pp = pastDays[pastDays.length - 2];
          _prevPrevDayOHLC = { high: pp.high, low: pp.low, close: pp.close };
        }
      } catch (_) {}

      log(`📦 [SIM] Date: ${date} | ${warmup.length} warmup + ${sessionCandles.length} session candles (${PA_RES}-min) | Speed: ${speed}x`);

      const result = tickSimulator.startFromCandles({
        candles: [...warmup, ...sessionCandles],
        warmupCount: warmup.length,
        resolution: PA_RES,
        speed,
        onTick,
        onCandleDone: makeCandleDone(sessionCandles.length),
        onDone: onSimDone,
        tickCandles: tickCandles1m.length > 0 ? tickCandles1m : undefined,
        tickResolution: tickCandles1m.length > 0 ? 1 : undefined,
      });

      state.candles = result.warmupCandles;
      log(`📦 [SIM] Pre-loaded ${result.warmupCandles.length} warmup candles`);
      log(`🎮 [SIM] Replaying ${result.totalSessionCandles} candles as ticks...`);
      return res.json({ success: true, scenario: `Replay ${date}`, candles: result.totalSessionCandles });
    } catch (err) {
      state.running = false; state._simMode = false;
      log(`❌ [SIM] Historical replay failed: ${err.message}`);
      return res.json({ success: false, error: err.message });
    }
  }

  // ── Synthetic scenario ──────────────────────────────────────────────────
  if (!tickSimulator.SCENARIOS[scenario]) {
    return res.json({ success: false, error: `Unknown scenario: ${scenario}` });
  }

  resetSimState(scenario);
  _prevDayOHLC = { high: basePrice + 80, low: basePrice - 80, close: basePrice + 10 };
  _prevPrevDayOHLC = { high: basePrice + 60, low: basePrice - 100, close: basePrice - 5 };

  const scenarioLabel = tickSimulator.SCENARIOS[scenario].label;
  log(`🎮 [SIM] Starting simulation: ${scenarioLabel} | Base: ${basePrice} | Speed: ${speed}x | Candles: ${candleCount}`);

  try {
    const result = tickSimulator.start({
      scenario, basePrice, speed, candleCount,
      warmupCandles: 30, resolution: PA_RES,
      onTick,
      onCandleDone: makeCandleDone(candleCount),
      onDone: onSimDone,
    });

    if (result.warmupCandles.length > 0) {
      state.candles = result.warmupCandles;
      log(`📦 [SIM] Pre-loaded ${result.warmupCandles.length} warmup candles`);
    }

    log(`🎮 [SIM] Emitting ${result.totalSessionCandles} candles as ticks...`);
    res.json({ success: true, scenario: scenarioLabel, candles: result.totalSessionCandles });
  } catch (err) {
    state.running = false; state._simMode = false;
    log(`❌ [SIM] Start failed: ${err.message}`);
    res.json({ success: false, error: err.message });
  }
});

router.stopSession = stopSession;
module.exports = router;

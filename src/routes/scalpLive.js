/**
 * SCALP LIVE TRADE — /scalp
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses LIVE market data (Fyers WebSocket) and places REAL orders via Fyers.
 * Runs on 3-min candles with the scalp BB+RSI+PSAR strategy.
 * Can run IN PARALLEL with /trade (live Zerodha) or /swing-paper.
 *
 * DATA LAYER  → Fyers (WebSocket ticks — shared with main)
 * ORDER LAYER → Fyers (place_order / exit_position)
 *
 * Routes:
 *   GET /scalp-live/start   → Start scalp live trading
 *   GET /scalp-live/stop    → Stop & square off
 *   GET /scalp-live/status  → Live status page
 *   GET /scalp-live/exit    → Manual exit current position
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
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, modalCSS, modalJS, errorPage } = require("../utils/sharedNav");
const { isTradingAllowed } = require("../utils/nseHolidays");
const { reverseSlice: _reverseSlice, mapTradesReversed: _mapTradesReversed, fastISTTime: _fastISTTime, formatISTTimestamp, fmtISTDateTime, getISTMinutes: _getISTMinutesReal, getBucketStart: _getBucketStartRaw, parseTimeToMinutes, parseTrailTiers, sleep } = require("../utils/tradeUtils");
const vixFilter = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const fyers = require("../config/fyers");
const tradeGuards = require("../utils/tradeGuards");
const { notifyEntry, notifyExit, notifyStarted, notifySignal, notifyDayReport, sendTelegram, canSend, isConfigured } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { saveScalpPosition, clearScalpPosition } = require("../utils/positionPersist");
const { logNearMiss } = require("../utils/nearMissLog");
const skipLogger = require("../utils/skipLogger");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID = "SCALP_LIVE";

// ── Module-level config ─────────────────────────────────────────────────────
const SCALP_RES            = parseInt(process.env.SCALP_RESOLUTION || "5", 10);
const _SCALP_MAX_TRADES    = parseInt(process.env.SCALP_MAX_DAILY_TRADES || "30", 10);
const _SCALP_MAX_LOSS      = parseFloat(process.env.SCALP_MAX_DAILY_LOSS || "2000");
const _SCALP_PAUSE_CANDLES = parseInt(process.env.SCALP_SL_PAUSE_CANDLES || "2", 10);
const _SCALP_TRAIL_START   = parseFloat(process.env.SCALP_TRAIL_START || "600");
const _SCALP_TRAIL_PCT     = parseFloat(process.env.SCALP_TRAIL_PCT || "70");
// Tiered trail: as peak grows, keep more. Format: "peak1:pct1,peak2:pct2,..."
const _SCALP_TRAIL_TIERS = parseTrailTiers(process.env.SCALP_TRAIL_TIERS || "600:70,1200:78,2500:85,5000:90,10000:93");
const _SCALP_TRAIL_GRACE_SECS = parseFloat(process.env.SCALP_TRAIL_GRACE_SECS || "0");
const _OPT_STOP_PCT        = parseFloat(process.env.OPT_STOP_PCT || "0.15");
// Per-side SL pause — when true, an SL on CE only pauses CE entries (PE still allowed)
const _SCALP_PER_SIDE_PAUSE = (process.env.SCALP_PER_SIDE_PAUSE || "true") === "true";
// Pause override — release per-side SL cooldown early if a subsequent candle close
// proves the original direction resumed past the failed entry spot (retest-and-resume).
const _SCALP_PAUSE_OVERRIDE_ENABLED = (process.env.SCALP_PAUSE_OVERRIDE_ENABLED || "false").toLowerCase() === "true";
const _SCALP_PAUSE_OVERRIDE_PTS     = parseFloat(process.env.SCALP_PAUSE_OVERRIDE_PTS || "10");
// Per-mode time-stop overrides (fall back to global TIME_STOP_* defaults if unset)
const _SCALP_TIME_STOP_CANDLES = process.env.SCALP_TIME_STOP_CANDLES != null
  ? parseInt(process.env.SCALP_TIME_STOP_CANDLES, 10) : null;
const _SCALP_TIME_STOP_FLAT_PTS = process.env.SCALP_TIME_STOP_FLAT_PTS != null
  ? parseFloat(process.env.SCALP_TIME_STOP_FLAT_PTS) : null;
// Breakeven snap — needs to run per-tick (not per-bar) because most trades exit
// inside the entry candle before updateTrailingSL would be called.
const _SCALP_BE_TRIGGER_R   = parseFloat(process.env.SCALP_BREAKEVEN_TRIGGER_R || "0");
const _SCALP_BE_OFFSET_PTS  = parseFloat(process.env.SCALP_BREAKEVEN_OFFSET_PTS || "1");

// ── Previous day OHLC for CPR (fetched on session start) ────────────────────
let _prevDayOHLC     = null;
let _prevPrevDayOHLC = null;

const _STOP_MINS       = parseTimeToMinutes(process.env.TRADE_STOP_TIME, "15:30");
const _ENTRY_STOP_MINS = parseTimeToMinutes(process.env.SCALP_ENTRY_END, "14:30");

const getISTMinutes = _getISTMinutesReal;
const fastISTTime   = _fastISTTime;
const reverseSlice  = _reverseSlice;
const mapTradesReversed = _mapTradesReversed;

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
  optionLtpUpdatedAt: null,
  _ltpStaleLogged: false,
  optionSymbol:   null,
  _slPauseUntil:  null,
  _slPauseUntilBySide: { CE: 0, PE: 0 },
  _consecSLsBySide:    { CE: 0, PE: 0 },
  _lastSLSpotBySide:   { CE: 0, PE: 0 },
  _dailyLossHit:  false,
  _entryPending:  false,
};

function istNow() { return formatISTTimestamp(Date.now()); }

function log(msg) {
  const entry = `[${istNow()}] ${msg}`;
  console.log(entry);
  state.log.push(entry);
  if (state.log.length > 2500) state.log.splice(0, state.log.length - 2000);
}

function getBucketStart(unixMs) { return _getBucketStartRaw(unixMs, SCALP_RES); }

const _SCALP_START_MINS = parseTimeToMinutes(process.env.SCALP_ENTRY_START, "09:21");

function isMarketHours() {
  const total = getISTMinutes();
  return total >= _SCALP_START_MINS && total < _ENTRY_STOP_MINS;
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
          log(`✅ [SCALP-LIVE] Rate limit cleared — polling resumed`);
          _rateLimitBackoff = 0;
        }
        return parseFloat(ltp);
      }
    }
  } catch (err) {
    const msg = err.message || "";
    if (/limit|throttle|429/i.test(msg)) {
      if (_rateLimitBackoff === 0) {
        log(`⚠️ [SCALP-LIVE] Rate limit hit — backing off to 2s polls; trail falls back to spot-proxy if stale`);
      }
      _rateLimitBackoff = Math.min(_rateLimitBackoff + 1, 10);
    } else {
      log(`⚠️ [SCALP-LIVE] fetchOptionLtp error for ${symbol}: ${msg}`);
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
        if (state._ltpStaleLogged) {
          log(`✅ [SCALP-LIVE] Option LTP recovered — ₹${ltp}`);
          state._ltpStaleLogged = false;
        }
        state.position.optionCurrentLtp = ltp;
        if (!state.position.optionEntryLtp) {
          state.position.optionEntryLtp = ltp;
          state.position.optionEntryLtpTime = istNow();
          log(`📌 [SCALP-LIVE] Option entry LTP: ₹${ltp}`);
          placeScalpHardSL();
        }
      } else if (!ltp) {
        // ── LTP staleness alert ──
        const _staleThreshold = parseInt(process.env.LTP_STALE_THRESHOLD_SEC || "15", 10) * 1000;
        if (state.optionLtpUpdatedAt && (Date.now() - state.optionLtpUpdatedAt) > _staleThreshold) {
          if (!state._ltpStaleLogged) {
            log(`⚠️ [SCALP-LIVE] Option LTP STALE — no update for ${Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000)}s. P&L display may be inaccurate.`);
            state._ltpStaleLogged = true;
          }
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
      if (!state.position.optionEntryLtp) {
        state.position.optionEntryLtp = ltp;
        state.position.optionEntryLtpTime = istNow();
      }
    }
    scheduleNext();
  });
  _optionPollTimer = true;
}

function stopOptionPolling() {
  if (_optionPollTimer && _optionPollTimer !== true) clearTimeout(_optionPollTimer);
  _optionPollTimer = null;
}

// ── Hard SL — exchange-level SL-M orders (Fyers) ─────────────────────────────
// Same concept as trade.js Hard SL but via Fyers API.
// Controlled by HARD_SL_ENABLED env var.
// ─────────────────────────────────────────────────────────────────────────────

let _scalpHardSLOrderId = null;

function isScalpHardSLEnabled() {
  return process.env.HARD_SL_ENABLED === "true" && instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES";
}

async function placeScalpHardSL() {
  if (!isScalpHardSLEnabled() || !state.position) return;
  const pos = state.position;
  const optionLtp = state.optionLtp || pos.optionEntryLtp;
  if (!optionLtp || !pos.stopLoss) return;

  const delta    = parseFloat(process.env.HARD_SL_DELTA || "0.5");
  const spotGap  = Math.abs(pos.spotAtEntry - pos.stopLoss);
  const premDrop = spotGap * delta;
  const triggerPrice = Math.max(0.5, parseFloat((optionLtp - premDrop).toFixed(1)));
  const qty = pos.qty || getLotQty();

  log(`🛡️ [SCALP HARD SL] Placing SL-M SELL ${qty} × ${pos.symbol} @ trigger ₹${triggerPrice}`);
  try {
    const result = await fyersBroker.placeSLMOrder(pos.symbol, -1, qty, triggerPrice);
    if (result.success) {
      _scalpHardSLOrderId = result.orderId;
      log(`✅ [SCALP HARD SL] SL-M placed — OrderID: ${result.orderId} | trigger=₹${triggerPrice}`);
    } else {
      log(`⚠️ [SCALP HARD SL] SL-M placement failed: ${JSON.stringify(result.raw)}`);
    }
  } catch (err) {
    log(`❌ [SCALP HARD SL] Exception: ${err.message}`);
  }
}

async function updateScalpHardSL(newSpotSL) {
  if (!isScalpHardSLEnabled() || !_scalpHardSLOrderId || !state.position) return;
  const optionLtp = state.optionLtp;
  if (!optionLtp) return;

  const delta = parseFloat(process.env.HARD_SL_DELTA || "0.5");
  const spotGap = Math.abs(state.lastTickPrice - newSpotSL);
  const newTrigger = Math.max(0.5, parseFloat((optionLtp - spotGap * delta).toFixed(1)));

  try {
    const result = await fyersBroker.modifySLMOrder(_scalpHardSLOrderId, newTrigger);
    if (result.success) {
      log(`🔄 [SCALP HARD SL] Modified trigger → ₹${newTrigger}`);
    } else {
      log(`⚠️ [SCALP HARD SL] Modify failed: ${JSON.stringify(result.raw)}`);
    }
  } catch (err) {
    log(`❌ [SCALP HARD SL] Modify exception: ${err.message}`);
  }
}

async function cancelScalpHardSL() {
  if (!_scalpHardSLOrderId) return;
  const orderId = _scalpHardSLOrderId;
  _scalpHardSLOrderId = null;
  try {
    const result = await fyersBroker.cancelOrder(orderId);
    if (result.success) {
      log(`🗑️ [SCALP HARD SL] Cancelled SL-M order ${orderId}`);
    } else {
      log(`⚠️ [SCALP HARD SL] Cancel failed: ${JSON.stringify(result.raw)}`);
    }
  } catch (err) {
    log(`❌ [SCALP HARD SL] Cancel exception: ${err.message}`);
  }
}

/**
 * Verify order fill status after placement (async, non-blocking).
 * Polls Fyers order book after a delay to confirm the order was filled.
 */
function verifyOrderFill(orderId, label) {
  if (!orderId) return;
  setTimeout(async () => {
    try {
      const orders = await fyersBroker.getOrders();
      if (!Array.isArray(orders) || orders.length === 0) return;
      const order = orders.find(o => o.id === orderId || o.orderNumber === orderId);
      if (!order) {
        log(`⚠️ [SCALP] Order ${orderId} not found in order book (${label})`);
        return;
      }
      const status = (order.status || 0);
      // Fyers status: 2=TRADED/FILLED, 5=REJECTED, 1=PENDING, 6=CANCELLED
      if (status === 2) {
        log(`✅ [SCALP] Order VERIFIED filled — ${orderId} (${label})`);
      } else if (status === 5) {
        log(`🚨 [SCALP] Order REJECTED — ${orderId} (${label}) | ${order.message || "unknown"}`);
        sendTelegram(`🚨 Scalp Order REJECTED: ${label} | ${order.message || "unknown"}`).catch(() => {});
      } else {
        log(`⚠️ [SCALP] Order status=${status} — ${orderId} (${label})`);
      }
    } catch (err) {
      log(`⚠️ [SCALP] Order verification failed: ${err.message}`);
    }
  }, 3000);
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
      verifyOrderFill(result.orderId, `${sideLabel} ${qty} × ${fyersSymbol}`);
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
          optionEntryLtp, optionCurrentLtp,
          signalStrength, vixAtEntry, entryHourIST, entryMinuteIST } = state.position;
  const isFutures = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const exitOrderSide = (isFutures && side === "PE") ? 1 : -1;

  log(`🔄 [SCALP-LIVE] Square off: ${reason}`);

  // Cancel Hard SL-M order before placing market exit (prevents double-exit)
  await cancelScalpHardSL();

  // Retry exit order up to 3 times — a stuck open position can lose real money
  const MAX_EXIT_RETRIES = 3;
  let result = null;
  for (let attempt = 1; attempt <= MAX_EXIT_RETRIES; attempt++) {
    result = await placeOrder(symbol, exitOrderSide, qty);
    if (result.success) break;
    if (result.reason === "duplicate_guard") break;  // another exit already in flight
    if (attempt < MAX_EXIT_RETRIES) {
      log(`⚠️ [SCALP-LIVE] Exit attempt ${attempt}/${MAX_EXIT_RETRIES} failed — retrying in 2s...`);
      await sleep(2000);
    }
  }

  if (!result || !result.success) {
    if (result && result.reason !== "duplicate_guard") {
      log(`🚨 [SCALP-LIVE] EXIT ORDER FAILED after ${MAX_EXIT_RETRIES} attempts — MANUAL INTERVENTION REQUIRED!`);
      sendTelegram(`🚨 SCALP EXIT FAILED: ${symbol} ${side} × ${qty} — ${reason}. Check Fyers dashboard IMMEDIATELY!`).catch(() => {});
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

  const charges = getCharges({ broker: "fyers", isFutures, exitPremium: exitOptionLtp, entryPremium: optionEntryLtp, qty });
  const netPnl    = parseFloat((pnl - charges).toFixed(2));
  const emoji     = netPnl >= 0 ? "✅" : "❌";
  log(`${emoji} [SCALP-LIVE] Exit: ${reason} | PnL: ₹${netPnl}`);

  state.sessionTrades.push({
    side, symbol, qty, entryPrice, exitPrice,
    spotAtEntry: spotAtEntry || entryPrice,
    spotAtExit: exitPrice,
    optionEntryLtp: optionEntryLtp || null,
    optionExitLtp: exitOptionLtp || null,
    optionStrike: state.position ? state.position.optionStrike : null,
    optionExpiry: state.position ? state.position.optionExpiry : null,
    optionType: state.position ? state.position.optionType : side,
    orderId: state.position ? state.position.orderId : null,
    stopLoss: state.position ? state.position.initialStopLoss : null,
    entryTime, exitTime: istNow(),
    pnl: netPnl, pnlMode, exitReason: reason,
    entryReason: state.position ? (state.position.reason || "") : "",
    entryBarTime: state.position ? (state.position.entryBarTime || null) : null,
    exitBarTime:  state.currentBar ? state.currentBar.time : null,
    // Data-collection fields (captured at entry)
    signalStrength: signalStrength   || null,
    vixAtEntry:     vixAtEntry       != null ? vixAtEntry       : null,
    entryHourIST:   entryHourIST     != null ? entryHourIST     : null,
    entryMinuteIST: entryMinuteIST   != null ? entryMinuteIST   : null,
    // Entry-context + MFE for post-window analysis.
    bbUpperAtEntry:  state.position ? (state.position.bbUpperAtEntry  != null ? state.position.bbUpperAtEntry  : null) : null,
    bbLowerAtEntry:  state.position ? (state.position.bbLowerAtEntry  != null ? state.position.bbLowerAtEntry  : null) : null,
    bbMiddleAtEntry: state.position ? (state.position.bbMiddleAtEntry != null ? state.position.bbMiddleAtEntry : null) : null,
    rsiAtEntry:      state.position ? (state.position.rsiAtEntry      != null ? state.position.rsiAtEntry      : null) : null,
    ptsFromBB:       state.position ? (state.position.ptsFromBB       != null ? state.position.ptsFromBB       : null) : null,
    trendMomPct:     state.position ? (state.position.trendMomPct     != null ? state.position.trendMomPct     : null) : null,
    trendSlopeDir:   state.position ? (state.position.trendSlopeDir   != null ? state.position.trendSlopeDir   : null) : null,
    mfeSpotPts:      state.position ? (state.position.mfeSpotPts || 0) : 0,
    mfePnl:          state.position ? (state.position.mfePnl     || 0) : 0,
  });

  state.sessionPnl = parseFloat((state.sessionPnl + netPnl).toFixed(2));
  if (netPnl > 0) state._wins = (state._wins || 0) + 1;
  else if (netPnl < 0) state._losses = (state._losses || 0) + 1;

  stopOptionPolling();
  state.optionSymbol = null;
  state.optionLtp    = null;
  state.optionLtpUpdatedAt = null;
  state._ltpStaleLogged = false;
  _scalpHardSLOrderId = null;  // clear Hard SL tracking
  clearScalpPosition();  // remove persisted state — position is closed

  // SL pause — escalate after consecutive SLs (per-side when SCALP_PER_SIDE_PAUSE=true)
  state._consecSLsBySide = state._consecSLsBySide || { CE: 0, PE: 0 };
  state._slPauseUntilBySide = state._slPauseUntilBySide || { CE: 0, PE: 0 };
  state._lastSLSpotBySide   = state._lastSLSpotBySide   || { CE: 0, PE: 0 };
  if (reason.includes("SL")) {
    if (_SCALP_PER_SIDE_PAUSE) {
      state._consecSLsBySide[side] += 1;
    } else {
      state._consecSLsBySide.CE += 1;
      state._consecSLsBySide.PE += 1;
    }
    const _streak = _SCALP_PER_SIDE_PAUSE ? state._consecSLsBySide[side] : Math.max(state._consecSLsBySide.CE, state._consecSLsBySide.PE);
    const extraPause = parseInt(process.env.SCALP_CONSEC_SL_EXTRA_PAUSE || "2", 10);
    const pauseCandles = _streak >= 2
      ? _SCALP_PAUSE_CANDLES + extraPause * (_streak - 1)
      : _SCALP_PAUSE_CANDLES;
    const _until = Date.now() + (pauseCandles * SCALP_RES * 60 * 1000);
    if (_SCALP_PER_SIDE_PAUSE) {
      state._slPauseUntilBySide[side] = _until;
    } else {
      state._slPauseUntilBySide.CE = _until;
      state._slPauseUntilBySide.PE = _until;
    }
    // Remember the spot at which this side just failed — used by pause-override
    // to detect "retest-and-resume" patterns where price returns to original direction.
    state._lastSLSpotBySide[side] = spotAtEntry || entryPrice;
    state._slPauseUntil = Math.max(state._slPauseUntilBySide.CE, state._slPauseUntilBySide.PE);
    state._consecSLs    = Math.max(state._consecSLsBySide.CE, state._consecSLsBySide.PE);
    const sideLabel = _SCALP_PER_SIDE_PAUSE ? `${side} ` : "";
    const escalateNote = _streak >= 2 ? ` (${_streak} consecutive SLs → ${pauseCandles} candles)` : "";
    log(`⏸️ [SCALP-LIVE] ${sideLabel}SL pause — ${pauseCandles} candles${escalateNote}`);
  } else if (netPnl > 0) {
    if (_SCALP_PER_SIDE_PAUSE) {
      state._consecSLsBySide[side] = 0;
    } else {
      state._consecSLsBySide.CE = 0;
      state._consecSLsBySide.PE = 0;
    }
    state._consecSLs = Math.max(state._consecSLsBySide.CE, state._consecSLsBySide.PE);
  }

  if (state.sessionPnl <= -_SCALP_MAX_LOSS) {
    state._dailyLossHit = true;
    log(`🚨 [SCALP-LIVE] Daily loss limit hit — no more entries`);
  }

  state.position = null;
  _squareOffInFlight = false;

  notifyExit({
    mode: "SCALP-LIVE",
    side, symbol,
    spotAtEntry: spotAtEntry || entryPrice,
    spotAtExit: exitPrice,
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

// ── onTick ──────────────────────────────────────────────────────────────────

function onTick(tick) {
  if (!state.running) return;
  const price = tick.ltp;
  if (!price || price <= 0) return;
  try {

  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  // Build candle
  const tickMs   = Date.now();
  const bucketMs = getBucketStart(tickMs);

  if (!state.currentBar || state.barStartTime !== bucketMs) {
    if (state.currentBar) {
      // If last candle has same time (preloaded overlap), replace instead of duplicate push
      const lastC = state.candles.length ? state.candles[state.candles.length - 1] : null;
      if (lastC && lastC.time === state.currentBar.time) {
        state.candles[state.candles.length - 1] = { ...state.currentBar };
      } else {
        state.candles.push({ ...state.currentBar });
      }
      if (state.candles.length > 200) state.candles.shift();
      onCandleClose(state.currentBar).catch(e => console.error(`🚨 [SCALP-LIVE] onCandleClose error: ${e.message}`));
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

  // Tick-level exit checks
  if (state.position) {
    const pos = state.position;
    const isFut = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
    // Running PNL helper (₹)
    const _tickPnl = (spotPrice) => {
      const _q = pos.qty || getLotQty();
      const _staleMs = parseInt(process.env.LTP_STALE_FALLBACK_SEC || "5", 10) * 1000;
      const _optionLtpFresh = !!(state.optionLtp && state.optionLtpUpdatedAt && (Date.now() - state.optionLtpUpdatedAt) < _staleMs);
      if (!isFut && pos.optionEntryLtp && _optionLtpFresh) {
        const _c = getCharges({ broker: "fyers", isFutures: isFut, exitPremium: state.optionLtp, entryPremium: pos.optionEntryLtp, qty: _q });
        return (state.optionLtp - pos.optionEntryLtp) * _q - _c;
      }
      // Spot-proxy fallback: option LTP stale/missing → estimate premium via delta
      // Keeps trail-stop logic responsive when REST polling is rate-limited.
      if (!isFut && pos.optionEntryLtp) {
        const DELTA = parseFloat(process.env.BACKTEST_DELTA || "0.55");
        const spotMove = (spotPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1);
        const approxPremium = Math.max(0.05, pos.optionEntryLtp + spotMove * DELTA);
        const _c = getCharges({ broker: "fyers", isFutures: isFut, exitPremium: approxPremium, entryPremium: pos.optionEntryLtp, qty: _q });
        return (approxPremium - pos.optionEntryLtp) * _q - _c;
      }
      const _c = getCharges({ broker: "fyers", isFutures: isFut, exitPremium: spotPrice, entryPremium: pos.entryPrice, qty: _q });
      return (spotPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * _q - _c;
    };

    const curPnl = _tickPnl(price);

    // Track peak PNL
    if (!pos.peakPnl || curPnl > pos.peakPnl) pos.peakPnl = curPnl;

    // Track max favorable excursion (MFE) in spot pts + rupees — for post-window
    // analysis of how far losing trades went in our favour before reversing.
    const _favPts = (price - pos.entryPrice) * (pos.side === "CE" ? 1 : -1);
    if (_favPts > (pos.mfeSpotPts || 0)) pos.mfeSpotPts = parseFloat(_favPts.toFixed(2));
    if (curPnl  > (pos.mfePnl     || 0)) pos.mfePnl     = parseFloat(curPnl.toFixed(2));

    // 2a-pre. BREAKEVEN SNAP — per-tick. Snap SL to entry ± offset once peak ≥
    //         BE_TRIGGER_R × initial risk. Tighten-only, so it fires at most once.
    //         Per-bar updateTrailingSL also has this check, but most trades exit
    //         inside the entry bar, so we have to evaluate it per-tick too.
    if (_SCALP_BE_TRIGGER_R > 0
        && pos.initialRiskRupees > 0
        && pos.peakPnl >= _SCALP_BE_TRIGGER_R * pos.initialRiskRupees) {
      const _beSL = parseFloat((pos.side === "CE"
        ? pos.entryPrice + _SCALP_BE_OFFSET_PTS
        : pos.entryPrice - _SCALP_BE_OFFSET_PTS).toFixed(2));
      const _beTightens = (pos.side === "CE" && _beSL > pos.stopLoss)
                       || (pos.side === "PE" && _beSL < pos.stopLoss);
      if (_beTightens) {
        log(`📐 [SCALP-LIVE] Trail SL (BreakEven): ₹${pos.stopLoss} → ₹${_beSL}`);
        pos.stopLoss = _beSL;
        pos.slSource = "BreakEven";
      }
    }

    // 2a. TRAIL — track a PnL floor. Exit when curPnl drops below it.
    //     PnL-based (not spot-based) so fast IV/gamma spikes that vanish
    //     without spot following don't fool the trail into exiting at a
    //     "right" spot price where the option has already given back.
    if (_SCALP_TRAIL_START > 0 && pos.peakPnl >= _SCALP_TRAIL_START) {
      const _ageSecs = pos.entryTimeMs ? (Date.now() - pos.entryTimeMs) / 1000 : Infinity;
      const _graceActive = _SCALP_TRAIL_GRACE_SECS > 0 && _ageSecs < _SCALP_TRAIL_GRACE_SECS;
      if (!_graceActive) {
        let _pct = _SCALP_TRAIL_PCT;
        for (const tier of _SCALP_TRAIL_TIERS) {
          if (pos.peakPnl >= tier.peak) { _pct = tier.pct; break; }
        }
        const newFloor = parseFloat((pos.peakPnl * _pct / 100).toFixed(2));
        if (pos.trailFloorPnl == null || newFloor > pos.trailFloorPnl) {
          pos.trailFloorPnl = newFloor;
          pos.trailStopPct  = _pct;
        }
      }
    }

    // 1. SL hit (Prev Candle initial, PSAR trailing, BreakEven snap, PnL trail)
    if (pos.trailFloorPnl != null && curPnl <= pos.trailFloorPnl) {
      squareOff(
        price,
        `Trail ${pos.trailStopPct}% (peak ₹${Math.round(pos.peakPnl)} → PnL ₹${Math.round(curPnl)})`
      ).catch(e => console.error(`🚨 [SCALP] squareOff error: ${e.message}`));
      return;
    }
    if (pos.side === "CE" && price <= pos.stopLoss) {
      const _isTrail = Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
      const _src = pos.slSource || "PSAR";
      squareOff(pos.stopLoss, _isTrail ? `${_src} Trail SL hit` : `${_src} SL hit`).catch(e => console.error(`🚨 [SCALP] squareOff error: ${e.message}`));
      return;
    }
    if (pos.side === "PE" && price >= pos.stopLoss) {
      const _isTrail = Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
      const _src = pos.slSource || "PSAR";
      squareOff(pos.stopLoss, _isTrail ? `${_src} Trail SL hit` : `${_src} SL hit`).catch(e => console.error(`🚨 [SCALP] squareOff error: ${e.message}`));
      return;
    }

    // EOD
    if (getISTMinutes() >= _STOP_MINS - 10) {
      squareOff(price, "EOD square-off").catch(e => console.error(`🚨 [SCALP] squareOff error: ${e.message}`));
      return;
    }
  }

  } catch (err) {
    // Catch-all: prevent a single bad tick/NaN from crashing the entire Node process
    console.error(`🚨 [SCALP-LIVE] onTick crash caught: ${err.message}`, err.stack);
  }
}

// ── onCandleClose ───────────────────────────────────────────────────────────

async function onCandleClose(bar) {
  if (!state.running) return;

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
      const _tsOpts = {};
      if (_SCALP_TIME_STOP_CANDLES != null)  _tsOpts.maxCandles = _SCALP_TIME_STOP_CANDLES;
      if (_SCALP_TIME_STOP_FLAT_PTS != null) _tsOpts.flatPts    = _SCALP_TIME_STOP_FLAT_PTS;
      const _tsReason = tradeGuards.checkTimeStop(_pos.candlesHeld, _pnlPts, _tsOpts);
      if (_tsReason) {
        log(`⏳ [SCALP-LIVE] ${_tsReason}`);
        await squareOff(bar.close, _tsReason);
        return;
      }
    }

    const window = [...state.candles];

    // PSAR flip → exit on reversal signal
    if (window.length >= 15 && scalpStrategy.isPSARFlip(window, state.position.side)) {
      squareOff(bar.close, "PSAR flip").catch(e => console.error(`🚨 [SCALP] squareOff error: ${e.message}`));
      return;
    }

    // Update trailing SL (BreakEven snap → PSAR, tighten only)
    if (window.length >= 15) {
      const trailResult = scalpStrategy.updateTrailingSL(window, state.position.stopLoss, state.position.side, {
        peakPnl:           state.position.peakPnl,
        initialRiskRupees: state.position.initialRiskRupees,
        entryPrice:        state.position.entryPrice,
      });
      if (trailResult.sl !== state.position.stopLoss) {
        log(`📐 [SCALP-LIVE] Trail SL (${trailResult.source}): ₹${state.position.stopLoss} → ₹${trailResult.sl}`);
        state.position.stopLoss = trailResult.sl;
        if (trailResult.source) state.position.slSource = trailResult.source;
        saveScalpPosition(state.position, { sessionPnl: state.sessionPnl || 0 });
        updateScalpHardSL(trailResult.sl);
      }
    }

    return;
  }

  // Entry
  if (!isMarketHours()) { log(`⏭️ [SCALP-LIVE] SKIP: outside market hours`); return; }
  if (state._dailyLossHit) { log(`⏭️ [SCALP-LIVE] SKIP: daily loss limit hit`); return; }
  if (state._entryPending) { log(`⏭️ [SCALP-LIVE] SKIP: entry pending`); return; }
  if (state.sessionTrades.length >= _SCALP_MAX_TRADES) { log(`⏭️ [SCALP-LIVE] SKIP: max trades (${_SCALP_MAX_TRADES}) reached`); return; }
  // Per-side SL cooldown is checked AFTER the strategy returns a side. Fast-path
  // when both sides are paused.
  const _pauseCE = state._slPauseUntilBySide && state._slPauseUntilBySide.CE > Date.now();
  const _pausePE = state._slPauseUntilBySide && state._slPauseUntilBySide.PE > Date.now();
  if (_pauseCE && _pausePE) {
    const secsLeft = Math.ceil((Math.min(state._slPauseUntilBySide.CE, state._slPauseUntilBySide.PE) - Date.now()) / 1000);
    log(`⏭️ [SCALP-LIVE] SKIP: SL cooldown both sides (${secsLeft}s left)`);
    return;
  }
  if (state._expiryDayBlocked) { log(`⏭️ [SCALP-LIVE] SKIP: expiry-only mode, not expiry day`); return; }

  const window = [...state.candles];
  if (window.length < 30) { log(`⏭️ [SCALP-LIVE] SKIP: warming up (${window.length}/30 candles)`); return; }

  const result = scalpStrategy.getSignal(window, {
    silent: false,
    prevDayOHLC: _prevDayOHLC,
    prevPrevDayOHLC: _prevPrevDayOHLC,
  });
  if (result.signal === "NONE") {
    const lastBar = window[window.length - 1];
    log(`⏭️ [SCALP-LIVE] SKIP: ${result.reason} | Close=${lastBar.close} BB=[${result.bbLower||'?'},${result.bbUpper||'?'}] RSI=${result.rsi||'?'} SAR=${result.sar||'?'}`);
    logNearMiss(result.filterAudit, "SCALP-LIVE", log);
    skipLogger.appendSkipLog("scalp", {
      gate: "strategy",
      reason: result.reason || null,
      spot: lastBar.close,
      bbLower: result.bbLower ?? null,
      bbUpper: result.bbUpper ?? null,
      rsi: result.rsi ?? null,
      sar: result.sar ?? null,
      audit: result.filterAudit || null,
    });
    const _barIST = new Date(lastBar.time * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
    notifySignal({
      mode: "SCALP-LIVE",
      signal: "SKIP",
      reason: result.reason ? String(result.reason).slice(0, 200) : "—",
      spot: lastBar.close,
      time: _barIST,
    });
    return;
  }

  // Per-side SL cooldown — block only if THIS side has an active pause
  const _signalSide = result.signal === "BUY_CE" ? "CE" : "PE";
  if (state._slPauseUntilBySide && state._slPauseUntilBySide[_signalSide] > Date.now()) {
    // Pause override: if the prior-loss spot has been reclaimed by >= OVERRIDE_PTS in
    // the original direction, treat the retest as complete and release the pause.
    const _failSpot = state._lastSLSpotBySide && state._lastSLSpotBySide[_signalSide];
    const _resumed = _SCALP_PAUSE_OVERRIDE_ENABLED && _failSpot && (
      _signalSide === "CE"
        ? bar.close >= _failSpot + _SCALP_PAUSE_OVERRIDE_PTS
        : bar.close <= _failSpot - _SCALP_PAUSE_OVERRIDE_PTS
    );
    if (_resumed) {
      log(`▶️ [SCALP-LIVE] Pause override — ${_signalSide} resumed: bar.close ₹${bar.close} vs failSpot ₹${_failSpot} (Δ${(bar.close-_failSpot).toFixed(1)}pt, threshold ${_SCALP_PAUSE_OVERRIDE_PTS}pt)`);
      state._slPauseUntilBySide[_signalSide] = 0;
      state._consecSLsBySide[_signalSide]    = 0;
      state._lastSLSpotBySide[_signalSide]   = 0;
      state._slPauseUntil = Math.max(state._slPauseUntilBySide.CE, state._slPauseUntilBySide.PE);
      state._consecSLs    = Math.max(state._consecSLsBySide.CE, state._consecSLsBySide.PE);
    } else {
      const secsLeft = Math.ceil((state._slPauseUntilBySide[_signalSide] - Date.now()) / 1000);
      log(`⏭️ [SCALP-LIVE] SKIP: ${_signalSide} SL cooldown (${secsLeft}s left)`);
      return;
    }
  }

  // VIX — post-strategy check with derived strength (SCALP_VIX_MAX_ENTRY + SCALP_VIX_STRONG_ONLY)
  if (process.env.SCALP_VIX_ENABLED === "true") {
    const _strength = deriveScalpStrength(result);
    const _vixCheck = await checkLiveVix(_strength, { mode: "scalp" });
    if (!_vixCheck.allowed) {
      log(`⏭️ [SCALP-LIVE] SKIP: ${_vixCheck.reason}`);
      skipLogger.appendSkipLog("scalp", {
        gate: "vix",
        reason: _vixCheck.reason || null,
        spot: bar.close,
        signalStrength: _strength,
        side: _signalSide,
      });
      return;
    }
  }

  const side = _signalSide;
  const spot = bar.close;

  resolveAndEnter(side, spot, result);
}

// Derive signal strength for scalp: STRONG if RSI is clearly beyond its threshold (by +5),
// else MARGINAL. Used to gate on SCALP_VIX_STRONG_ONLY in elevated-VIX regimes.
function deriveScalpStrength(result) {
  const rsi = typeof result.rsi === "number" ? result.rsi : null;
  if (rsi === null) return "MARGINAL";
  if (result.signal === "BUY_CE") {
    const thr = parseFloat(process.env.SCALP_RSI_CE_THRESHOLD || "55");
    return rsi >= thr + 5 ? "STRONG" : "MARGINAL";
  }
  if (result.signal === "BUY_PE") {
    const thr = parseFloat(process.env.SCALP_RSI_PE_THRESHOLD || "45");
    return rsi <= thr - 5 ? "STRONG" : "MARGINAL";
  }
  return "MARGINAL";
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

    // ── Bid-ask spread guard before real order ──
    {
      const _q = await tradeGuards.fetchOptionQuote(fyers, symbol);
      const _sp = tradeGuards.checkSpread(_q && _q.bid, _q && _q.ask);
      if (!_sp.ok) {
        log(`⏭️ [SCALP-LIVE] SKIP entry — spread too wide (${_sp.reason})`);
        skipLogger.appendSkipLog("scalp", {
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

    // Place BUY order via Fyers
    const orderResult = await placeOrder(symbol, 1, qty);
    if (!orderResult.success) {
      log(`❌ [SCALP-LIVE] Entry order failed — skipping trade`);
      return;
    }

    // Clamp SL distance to [MIN_SL_PTS, MAX_SL_PTS] — matches backtest logic
    const MAX_SL_PTS = parseFloat(process.env.SCALP_MAX_SL_PTS || "25");
    const MIN_SL_PTS = parseFloat(process.env.SCALP_MIN_SL_PTS || "8");
    const rawGap = Math.abs(spot - result.stopLoss);
    const slPts = Math.max(Math.min(rawGap, MAX_SL_PTS), MIN_SL_PTS);
    const clampedSL = parseFloat((spot + slPts * (side === "CE" ? -1 : 1)).toFixed(2));

    // Data-collection metadata — frozen at entry so the trade record is self-describing for offline analysis.
    const _entryIstMin    = Math.floor((Math.floor(Date.now() / 1000) + 19800) / 60) % 1440;
    const _entryHourIST   = Math.floor(_entryIstMin / 60);
    const _entryMinuteIST = _entryIstMin % 60;
    const _vixAtEntry     = getCachedVix();
    const _signalStrength = deriveScalpStrength(result);

    // Initial rupee risk (used by break-even snap + trail price-stop math).
    // Approximate: |entry-SL| × DELTA × qty (charges ignored — small bias is OK).
    const _DELTA_INIT = parseFloat(process.env.BACKTEST_DELTA || "0.55");
    const _initialRiskRupees = Math.abs(spot - clampedSL) * _DELTA_INIT * qty;

    // Distance from triggering BB band — positive = "extended beyond band".
    let _ptsFromBB = null;
    if (side === "PE" && result.bbLower != null) {
      _ptsFromBB = parseFloat((result.bbLower - spot).toFixed(2));
    } else if (side === "CE" && result.bbUpper != null) {
      _ptsFromBB = parseFloat((spot - result.bbUpper).toFixed(2));
    }

    state.position = {
      side,
      symbol,
      qty,
      entryPrice:       spot,
      spotAtEntry:      spot,
      entryTime:        istNow(),
      entryTimeMs:      Date.now(),
      reason:           result.reason,
      stopLoss:         clampedSL,
      initialStopLoss:  clampedSL,
      slSource:         result.slSource || "PSAR",
      target:           result.target,
      bestPrice:        null,
      candlesHeld:      0,
      peakPnl:          0,
      initialRiskRupees: _initialRiskRupees,
      trailFloorPnl:    null,
      trailStopPct:     null,
      optionStrike:     optionInfo.strike || null,
      optionExpiry:     optionInfo.expiry || null,
      optionType:       side,
      orderId:          orderResult.orderId || null,

      optionEntryLtp:   null,
      optionCurrentLtp: null,
      optionEntryLtpTime: null,
      entryBarTime:     state.currentBar ? state.currentBar.time : null,
      // Data-collection fields — surfaced on the trade record at exit
      signalStrength:   _signalStrength,
      vixAtEntry:       _vixAtEntry,
      entryHourIST:     _entryHourIST,
      entryMinuteIST:   _entryMinuteIST,
      // Entry-context snapshot for post-window analysis (BB distance, RSI, 15-min trend).
      bbUpperAtEntry:   result.bbUpper  != null ? result.bbUpper  : null,
      bbLowerAtEntry:   result.bbLower  != null ? result.bbLower  : null,
      bbMiddleAtEntry:  result.bbMiddle != null ? result.bbMiddle : null,
      rsiAtEntry:       result.rsi      != null ? result.rsi      : null,
      ptsFromBB:        _ptsFromBB,
      trendMomPct:      result.trendMomPct   != null ? result.trendMomPct   : null,
      trendSlopeDir:    result.trendSlopeDir != null ? result.trendSlopeDir : null,
      // MFE — updated per-tick, captures best favourable excursion before exit.
      mfeSpotPts:       0,
      mfePnl:           0,
    };

    state.optionSymbol = symbol;
    if (instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES") {
      startOptionPolling(symbol);
    }

    log(`📝 [SCALP-LIVE] BUY ${qty} × ${symbol} @ ₹${spot} | SL: ₹${clampedSL} | ${result.reason}`);

    notifyEntry({
      mode: "SCALP-LIVE",
      side, symbol, spotAtEntry: spot,
      optionEntryLtp: null,
      stopLoss: result.stopLoss, qty, reason: result.reason,
    });
    // Persist position to disk for crash recovery
    saveScalpPosition(state.position, { sessionPnl: state.sessionPnl || 0 });
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
    const { fetchCandles } = require("../services/backtestEngine");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    // Fetch from 7 days ago to cover weekends + holidays (e.g., Thu trading → Mon start)
    const lookbackDate = new Date(Date.now() - 7 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached(
      NIFTY_INDEX_SYMBOL, String(SCALP_RES), lookbackDate, today,
      fetchCandles
    );
    if (candles && candles.length > 0) {
      state.candles = candles.slice(-99);
      log(`📦 [SCALP-LIVE] Pre-loaded ${state.candles.length} × ${SCALP_RES}-min candles (strategy ready!)`);

      // ── Gap detection — compare today's open vs yesterday's close ──────────
      const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const todayC = state.candles.filter(c => new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === todayIST);
      const yesterdayC = state.candles.filter(c => new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) < todayIST);
      if (todayC.length > 0 && yesterdayC.length > 0) {
        const gapPts = parseFloat((todayC[0].open - yesterdayC[yesterdayC.length - 1].close).toFixed(1));
        const GAP_THRESHOLD = parseFloat(process.env.GAP_THRESHOLD_PTS || "50");
        if (Math.abs(gapPts) >= GAP_THRESHOLD) {
          const dir = gapPts > 0 ? "UP" : "DOWN";
          log(`🔔 [SCALP] GAP ${dir} detected: ${Math.abs(gapPts).toFixed(0)} pts`);
          sendTelegram(`🔔 [SCALP] GAP ${dir}: ${Math.abs(gapPts).toFixed(0)} pts`).catch(() => {});
        }
      }
    } else {
      log(`⚠️ [SCALP-LIVE] No historical candles found — will build from live ticks`);
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
      log(`⚠️ [SCALP-LIVE] Not enough daily candles for prev day data`);
    }
  } catch (err) {
    log(`⚠️ [SCALP-LIVE] CPR data fetch failed: ${err.message}`);
  }
}

// ── EOD Backup Timer — force exit at 3:25 PM IST if tick-based exit missed ──
let _scalpEodBackupTimer = null;

function scheduleScalpEODBackup() {
  clearScalpEODBackup();
  const _EOD_EXIT_MINS = _STOP_MINS - 5; // 3:25 PM
  const nowMins = getISTMinutes();
  if (nowMins >= _EOD_EXIT_MINS) return;
  const msUntil = (_EOD_EXIT_MINS - nowMins) * 60 * 1000;
  _scalpEodBackupTimer = setTimeout(() => {
    if (!state.running || !state.position) return;
    const exitPrice = state.lastTickPrice || (state.currentBar ? state.currentBar.close : 0);
    log(`🚨 [SCALP] EOD BACKUP TIMER — force exit at 3:25 PM IST`);
    squareOff(exitPrice, "EOD backup timer (3:25 PM)").catch(e => log(`❌ [SCALP] EOD backup exit error: ${e.message}`));
  }, msUntil);
  log(`⏰ [SCALP] EOD backup timer set — force exit in ${Math.round(msUntil / 60000)} min`);
}

function clearScalpEODBackup() {
  if (_scalpEodBackupTimer) { clearTimeout(_scalpEodBackupTimer); _scalpEodBackupTimer = null; }
}

// ── Auto-stop ───────────────────────────────────────────────────────────────
let _autoStopTimer = null;

function scheduleAutoStop(stopFn) {
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  const nowMins = getISTMinutes();
  const ms = (_STOP_MINS - nowMins) * 60 * 1000;
  if (ms <= 0) return;
  _autoStopTimer = setTimeout(() => {
    if (!state.running) return;
    stopFn("⏰ [SCALP-LIVE] Auto-stop reached");
  }, ms);
  log(`⏰ [SCALP-LIVE] Auto-stop in ${Math.round(ms / 60000)} min`);
}

// errorPage imported from sharedNav (shared across all route files)
function _errorPage(title, message, linkHref, linkText) {
  return errorPage(title, message, linkHref, linkText, 'scalpLive');
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/start", async (req, res) => {
  if (state.running) return res.json({ success: true, message: "Already running" });

  const check = sharedSocketState.canStart("SCALP_LIVE");
  if (!check.allowed) {
    return res.status(409).send(_errorPage("Cannot Start", check.reason, "/scalp-live/status", "\u2190 Back"));
  }

  const auth = await verifyFyersToken();
  if (!auth.ok) {
    return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));
  }

  if (!fyersBroker.isAuthenticated()) {
    return res.status(401).send(_errorPage("Not Authenticated", "Fyers not authenticated for orders. Login first.", "/auth/login", "Login with Fyers"));
  }

  if (process.env.SCALP_ENABLED !== "true") {
    return res.status(400).send(_errorPage("Scalp Disabled", "SCALP_ENABLED is not true. Enable it in Settings first.", "/settings", "Open Settings"));
  }

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) {
    return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/scalp-live/status", "\u2190 Back"));
  }

  if (!isStartAllowed()) {
    return res.status(400).send(_errorPage("Session Closed", "Past stop time \u2014 cannot start today.", "/scalp-live/status", "\u2190 Back"));
  }

  // Expiry day check
  let _expiryBlocked = false;
  if ((process.env.SCALP_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
    const { isExpiryDay } = require("../utils/nseHolidays");
    const isExpiry = await isExpiryDay();
    if (!isExpiry) _expiryBlocked = true;
    log(`📅 [SCALP-LIVE] Expiry-only mode: ${isExpiry ? "✅ Today is expiry — trading allowed" : "❌ Not expiry day — entries blocked"}`);
  }

  // Reset state
  state = {
    running: true, position: null, candles: [], currentBar: null, barStartTime: null,
    log: [], sessionTrades: [], sessionStart: new Date().toISOString(),
    sessionPnl: 0, _wins: 0, _losses: 0, tickCount: 0, lastTickTime: null, lastTickPrice: null,
    optionLtp: null, optionLtpUpdatedAt: null, _ltpStaleLogged: false,
    optionSymbol: null, _slPauseUntil: null,
    _slPauseUntilBySide: { CE: 0, PE: 0 }, _consecSLsBySide: { CE: 0, PE: 0 },
    _lastSLSpotBySide: { CE: 0, PE: 0 },
    _dailyLossHit: false, _entryPending: false,
    _expiryDayBlocked: _expiryBlocked,
  };

  sharedSocketState.setScalpActive("SCALP_LIVE");

  await preloadHistory();

  if (process.env.SCALP_VIX_ENABLED === "true") {
    resetVixCache();
    fetchLiveVix({ force: true }).catch(() => {});
  }

  // ── Position reconciliation — check Fyers for orphaned positions ──────────
  try {
    const brokerPositions = await fyersBroker.getPositions();
    const openPos = (brokerPositions.netPositions || []).filter(p => p.netQty !== 0);
    if (openPos.length > 0) {
      const symbols = openPos.map(p => `${p.symbol}(qty=${p.netQty})`).join(", ");
      log(`⚠️ [SCALP] Broker has open positions: ${symbols}`);
      log(`   If these are from a previous crash, consider manual square-off on Fyers dashboard.`);
      sendTelegram(`⚠️ Orphaned positions on Fyers: ${symbols}`).catch(() => {});
    } else {
      log(`✅ [SCALP] No orphaned positions on Fyers — clean start`);
    }
  } catch (err) {
    log(`⚠️ [SCALP] Position reconciliation failed: ${err.message}`);
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

  scheduleScalpEODBackup();
  scheduleAutoStop((msg) => {
    log(msg);
    stopSession();
  });

  log(`🟢 [SCALP-LIVE] Session started — ${SCALP_RES}-min candles | Fyers orders`);

  notifyStarted({
    mode: "SCALP-LIVE",
    text: [
      `⚡ SCALP LIVE — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Resolution: ${SCALP_RES}-min candles | Fyers orders`,
      `Window    : ${process.env.SCALP_ENTRY_START || "09:20"} → ${process.env.SCALP_ENTRY_END || "15:10"} IST`,
      `Max Loss  : ₹${process.env.SCALP_MAX_DAILY_LOSS || "—"} | Max Trades: ${process.env.SCALP_MAX_DAILY_TRADES || "—"}`,
      _expiryBlocked ? `\n⚠️ Expiry-only mode: entries blocked (not expiry day)` : null,
    ].filter(l => l !== null).join("\n"),
  });

  res.json({ success: true, message: "Scalp live trading started" });
});

function stopSession() {
  if (!state.running) return;

  if (state.position) {
    squareOff(state.lastTickPrice || state.position.entryPrice, "Session stopped").catch(e => console.error(`🚨 [SCALP] squareOff error: ${e.message}`));
  }

  state.running = false;
  stopOptionPolling();
  clearScalpEODBackup();
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

  notifyDayReport({
    mode: "SCALP-LIVE",
    sessionTrades: state.sessionTrades,
    sessionPnl:    state.sessionPnl,
    sessionStart:  state.sessionStart,
  });
}

router.get("/stop", (req, res) => {
  stopSession();
  res.json({ success: true, message: "Scalp live trading stopped" });
});

router.get("/exit", (req, res) => {
  if (state.position) {
    squareOff(state.lastTickPrice || state.position.entryPrice, "Manual exit");
  }
  res.json({ success: true, message: "Position exit triggered" });
});

// ── Manual entry ────────────────────────────────────────────────────────────
router.post("/manualEntry", async (req, res) => {
  if (!state.running) return res.status(400).json({ success: false, error: "Scalp live is not running." });
  if (state.position) return res.status(400).json({ success: false, error: "Already in a position. Exit first." });
  const { side } = req.body || {};
  if (side !== "CE" && side !== "PE") return res.status(400).json({ success: false, error: "Side must be CE or PE." });
  const spot = state.lastTickPrice || (state.currentBar ? state.currentBar.close : null);
  if (!spot) return res.status(400).json({ success: false, error: "No market data yet." });

  // SL = Previous candle low/high, capped at MAX_SL_PTS, floored at MIN_SL_PTS
  const candles = state.candles || [];
  const MAX_SL_PTS  = parseFloat(process.env.SCALP_MAX_SL_PTS || "25");
  const MIN_SL_PTS  = parseFloat(process.env.SCALP_MIN_SL_PTS || "8");
  const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;
  let sl;
  if (prevCandle) {
    const rawSL = side === "CE" ? prevCandle.low : prevCandle.high;
    const slPts = Math.max(Math.min(Math.abs(spot - rawSL), MAX_SL_PTS), MIN_SL_PTS);
    sl = side === "CE" ? parseFloat((spot - slPts).toFixed(2)) : parseFloat((spot + slPts).toFixed(2));
  } else {
    sl = side === "CE" ? spot - MAX_SL_PTS : spot + MAX_SL_PTS;
  }
  const sig = candles.length >= 30 ? scalpStrategy.getSignal(candles, { silent: true }) : null;

  log(`🖐️ [SCALP-LIVE] MANUAL ENTRY ${side} @ spot ₹${spot} | SL: ₹${sl} (PrevCandle${prevCandle ? '=' + (side === 'CE' ? prevCandle.low : prevCandle.high) : ''})`);
  await resolveAndEnter(side, spot, { stopLoss: sl, target: null, reason: `Manual ${side} entry` });
  if (!state.position) return res.status(400).json({ success: false, error: "Entry failed — check logs for details." });
  return res.json({ success: true, spot, side, sl });
});

// ── Chart data for Lightweight Charts widget ────────────────────────────────
router.get("/status/chart-data", (req, res) => {
  try {
    const candles = state.candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.currentBar) candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });
    const markers = [];
    for (const t of state.sessionTrades) {
      if (t.entryPrice && t.entryBarTime) markers.push({ time: t.entryBarTime, position: 'belowBar', color: '#3b82f6', shape: 'arrowUp', text: t.side + ' @ ' + t.entryPrice.toFixed(0) });
      if (t.exitPrice && t.exitBarTime) { const w = t.pnl > 0; markers.push({ time: t.exitBarTime, position: 'aboveBar', color: w ? '#10b981' : '#ef4444', shape: 'arrowDown', text: 'Exit ' + (w ? '+' : '') + (t.pnl ? t.pnl.toFixed(0) : '') }); }
    }
    const stopLoss = state.position && state.position.stopLoss ? state.position.stopLoss : null;
    const entryPrice = state.position && state.position.entryPrice ? state.position.entryPrice : null;
    return res.json({ candles, markers, stopLoss, entryPrice });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Status data ─────────────────────────────────────────────────────────────

router.get("/status/data", (req, res) => {
  try {
  const pos = state.position;
  const isFutures = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";

  let unrealised = 0;
  if (pos && state.lastTickPrice) {
    if (isFutures) {
      const _c = getCharges({ broker: "fyers", isFutures: true, exitPremium: state.lastTickPrice, entryPremium: pos.entryPrice, qty: pos.qty });
      unrealised = parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * pos.qty - _c).toFixed(2));
    } else {
      const cur = state.optionLtp || pos.optionCurrentLtp;
      if (pos.optionEntryLtp && cur && pos.optionEntryLtp > 0) {
        const _c = getCharges({ broker: "fyers", isFutures: false, exitPremium: cur, entryPremium: pos.optionEntryLtp, qty: pos.qty });
        unrealised = parseFloat(((cur - pos.optionEntryLtp) * pos.qty - _c).toFixed(2));
      } else {
        const _c = getCharges({ broker: "fyers", isFutures: false, exitPremium: state.lastTickPrice, entryPremium: pos.entryPrice, qty: pos.qty });
        unrealised = parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * pos.qty - _c).toFixed(2));
      }
    }
  }

  const optEntryLtp   = pos ? (pos.optionEntryLtp || null) : null;
  const optCurrentLtp = pos ? (state.optionLtp || pos.optionCurrentLtp || null) : null;
  const _chgOpt = (optEntryLtp && optCurrentLtp) ? getCharges({ broker: "fyers", isFutures, exitPremium: optCurrentLtp, entryPremium: optEntryLtp, qty: pos ? pos.qty : 0 }) : 0;
  const optPremiumPnl = (optEntryLtp && optCurrentLtp) ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0) - _chgOpt).toFixed(2)) : null;
  const optPremiumMove = (optEntryLtp && optCurrentLtp) ? parseFloat((optCurrentLtp - optEntryLtp).toFixed(2)) : null;
  const optPremiumPct = (optEntryLtp && optCurrentLtp && optEntryLtp > 0) ? parseFloat(((optCurrentLtp - optEntryLtp) / optEntryLtp * 100).toFixed(2)) : null;
  const OPT_STOP_PCT_VAL = _OPT_STOP_PCT;
  const optStopPrice = optEntryLtp ? parseFloat((optEntryLtp * (1 - OPT_STOP_PCT_VAL)).toFixed(2)) : null;

  res.json({
    running:       state.running,
    isFutures,
    tickCount:     state.tickCount,
    lastTickPrice: state.lastTickPrice,
    lastTickTime:  state.lastTickTime ? fastISTTime(state.lastTickTime) : null,
    candleCount:   state.candles.length,
    currentBar:    state.currentBar,
    sessionPnl:    state.sessionPnl,
    unrealised,
    totalPnl:      parseFloat((state.sessionPnl + unrealised).toFixed(2)),
    tradeCount:    state.sessionTrades.length,
    wins:          state._wins || 0,
    losses:        state._losses || 0,
    dailyLossHit:  state._dailyLossHit,
    sessionStart:  state.sessionStart,
    position: pos ? {
      side:              pos.side,
      symbol:            pos.symbol,
      qty:               pos.qty,
      entryPrice:        pos.entryPrice,
      entryTime:         pos.entryTime,
      stopLoss:          pos.stopLoss,
      target:            pos.target,
      bestPrice:         pos.bestPrice || null,
      peakPnl:           pos.peakPnl || 0,
      initialStopLoss:   pos.initialStopLoss,
      candlesHeld:       pos.candlesHeld,
      optionStrike:      pos.optionStrike || null,
      optionExpiry:      pos.optionExpiry || null,
      optionType:        pos.optionType || pos.side,
      orderId:           pos.orderId || null,
      optionEntryLtp:    optEntryLtp,
      optionCurrentLtp:  optCurrentLtp,
      optionEntryLtpTime: pos.optionEntryLtpTime || null,
      optionLtpStaleSec: state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null,
      optPremiumPnl,
      optPremiumMove,
      optPremiumPct,
      optStopPrice,
      optStopPct:        Math.round(OPT_STOP_PCT_VAL * 100),
      liveClose:         state.lastTickPrice || null,
      trailActivatePts:  pos.trailActivatePts || null,
      reason:            pos.reason || null,
    } : null,
    trades: mapTradesReversed(state.sessionTrades),
    logTotal: state.log.length,
    logs:    reverseSlice(state.log, 200),
  });
  } catch (err) {
    console.error("[scalp/status/data] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Status page ─────────────────────────────────────────────────────────────


router.get("/status", (req, res) => {
  try {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const fyersOk    = !!process.env.ACCESS_TOKEN;

  const _vix         = getCachedVix();
  const _vixEnabled  = process.env.SCALP_VIX_ENABLED === "true";
  const _vixMaxEntry = vixFilter.getVixMaxEntry("scalp");

  const pos = state.position;
  const isFutures = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";

  // Unrealised PnL (minus charges)
  let unrealisedPnl = 0;
  if (pos && state.lastTickPrice) {
    if (isFutures) {
      const _cp = getCharges({ broker: "fyers", isFutures: true, exitPremium: state.lastTickPrice, entryPremium: pos.entryPrice, qty: pos.qty });
      unrealisedPnl = parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * pos.qty - _cp).toFixed(2));
    } else {
      const cur = state.optionLtp || pos.optionCurrentLtp;
      if (pos.optionEntryLtp && cur && pos.optionEntryLtp > 0) {
        const _cp = getCharges({ broker: "fyers", isFutures: false, exitPremium: cur, entryPremium: pos.optionEntryLtp, qty: pos.qty });
        unrealisedPnl = parseFloat(((cur - pos.optionEntryLtp) * pos.qty - _cp).toFixed(2));
      } else {
        const _cp = getCharges({ broker: "fyers", isFutures: false, exitPremium: state.lastTickPrice, entryPremium: pos.entryPrice, qty: pos.qty });
        unrealisedPnl = parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * pos.qty - _cp).toFixed(2));
      }
    }
  }

  const inr = (n) => typeof n === "number" ? "\u20b9" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "\u2014";
  const pnlColor = (n) => n >= 0 ? "#10b981" : "#ef4444";

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;

  const optEntryLtp   = pos ? (pos.optionEntryLtp   || null) : null;
  const optCurrentLtp = pos ? (state.optionLtp || pos.optionCurrentLtp || null) : null;
  const optPremiumPnl = (optEntryLtp && optCurrentLtp)
    ? parseFloat(((optCurrentLtp - optEntryLtp) * (pos ? pos.qty : 0)).toFixed(2))
    : null;
  const optPremiumMove = (optEntryLtp && optCurrentLtp)
    ? parseFloat((optCurrentLtp - optEntryLtp).toFixed(2))
    : null;
  const optPremiumPct  = (optEntryLtp && optCurrentLtp && optEntryLtp > 0)
    ? parseFloat(((optCurrentLtp - optEntryLtp) / optEntryLtp * 100).toFixed(2))
    : null;
  const OPT_STOP_PCT_VAL = _OPT_STOP_PCT;
  const optStopPrice   = optEntryLtp ? parseFloat((optEntryLtp * (1 - OPT_STOP_PCT_VAL)).toFixed(2)) : null;
  const optStopPct     = Math.round(OPT_STOP_PCT_VAL * 100);

  const liveClose  = state.lastTickPrice || null;
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
    : "\u2014";
  const strikeBadgeColor = strikeLabel === "ATM" ? "#3b82f6" : strikeLabel === "ITM" ? "#10b981" : "#ef4444";

  // Position HTML
  const posHtml = pos ? `
    <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#ef4444;display:inline-block;animation:pulse 1.5s infinite;"></span>
          <span style="font-size:0.8rem;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:1px;">\u26a1 LIVE Position</span>
          <span style="font-size:0.72rem;color:#4a6080;">Since ${fmtISTDateTime(pos.entryTime)}</span>
        </div>
        <button onclick="scHandleExit(this)"
           style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;transition:background 0.15s;"
           onmouseover="this.style.background='#991b1b'" onmouseout="this.style.background='#7f1d1d'">
          \uD83D\uDEAA Exit Position (Fyers)
        </button>
      </div>

      <!-- Position Identity -->
      <div style="background:#071a12;border:1px solid #134e35;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:2.2rem;font-weight:900;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${isFutures ? (pos.side === "CE" ? "LONG" : "SHORT") : pos.side}</span>
            <div>
              <div style="font-size:0.72rem;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${isFutures ? (pos.side === "CE" ? "FUTURES \u00b7 Bullish" : "FUTURES \u00b7 Bearish") : (pos.side === "CE" ? "CALL \u00b7 Bullish" : "PUT \u00b7 Bearish")}</div>
              ${!isFutures ? `<span style="font-size:0.65rem;font-weight:700;background:${strikeBadgeColor}22;color:${strikeBadgeColor};border:1px solid ${strikeBadgeColor}44;padding:2px 7px;border-radius:4px;">${strikeLabel}</span>` : ""}
            </div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          ${isFutures ? `
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Direction</div>
            <div style="font-size:1.4rem;font-weight:800;color:#fff;">${pos.side === "CE" ? "\uD83D\uDCC8 BUY" : "\uD83D\uDCC9 SELL"}</div>
          </div>` : `
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Strike</div>
            <div style="font-size:1.6rem;font-weight:800;color:#fff;font-family:monospace;">${pos.optionStrike ? pos.optionStrike.toLocaleString("en-IN") : "\u2014"}</div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Expiry</div>
            <div style="font-size:1.1rem;font-weight:700;color:#f59e0b;">${pos.optionExpiry || "\u2014"}</div>
          </div>`}
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Qty / Lots</div>
            <div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty} <span style="font-size:0.72rem;color:#4a6080;">(${Math.round(pos.qty / (instrumentConfig.LOT_SIZE[instrumentConfig.INSTRUMENT] || 65))} lot)</span></div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;flex-shrink:0;"></div>
          <div style="flex:1;min-width:200px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Full Symbol</div>
            <div style="font-size:0.82rem;font-weight:600;color:#c8d8f0;font-family:monospace;word-break:break-all;">${pos.symbol}</div>
          </div>
          ${pos.orderId ? `
          <div style="width:1px;height:44px;background:#134e35;flex-shrink:0;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Fyers Order ID</div>
            <div style="font-size:0.82rem;font-weight:600;color:#a78bfa;font-family:monospace;">${pos.orderId}</div>
          </div>` : ""}
        </div>
      </div>

      <!-- Option Premium Section -->
      <div style="background:#0a0f24;border:2px solid #ef4444;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
        <div style="font-size:0.68rem;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">\u26a1 ${isFutures ? "LIVE Futures PnL (Spot Price)" : `LIVE Option Premium (${pos.optionType || pos.side} Price)`}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">

          <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid #1e3a5f;border-radius:10px;">
            <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Entry Price</div>
            <div id="ax-opt-entry-ltp" style="font-size:2rem;font-weight:800;color:#60a5fa;font-family:monospace;line-height:1;">
              ${optEntryLtp ? "\u20b9" + optEntryLtp.toFixed(2) : "<span style='font-size:1rem;color:#f59e0b;'>Fetching...</span>"}
            </div>
            <div style="font-size:0.68rem;color:#4a6080;margin-top:4px;">
              ${optEntryLtp
                ? `captured at ${fmtISTDateTime(pos.optionEntryLtpTime || pos.entryTime)}`
                : `\u23f3 first REST poll in ~3s<br><span style='color:#c8d8f0;'>NIFTY entry: ${inr(pos.entryPrice)}</span>`}
            </div>
          </div>

          <div style="text-align:center;font-size:1.8rem;color:${optPremiumMove !== null ? (optPremiumMove >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};">\u2192</div>

          <div style="text-align:center;padding:12px;background:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#071a0f" : "#1a0707") : "#0d1320"};border:2px solid ${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};border-radius:10px;">
            <div style="font-size:0.63rem;color:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Current LTP</div>
            <div id="ax-opt-current-ltp" style="font-size:2rem;font-weight:800;color:${optCurrentLtp && optEntryLtp ? (optCurrentLtp >= optEntryLtp ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">
              ${optCurrentLtp ? "\u20b9" + optCurrentLtp.toFixed(2) : "\u23f3"}
            </div>
            <div id="ax-opt-move" style="font-size:0.72rem;font-weight:700;margin-top:6px;color:${optPremiumMove !== null ? (optPremiumMove >= 0 ? "#10b981" : "#ef4444") : "#f59e0b"};">
              ${optPremiumMove !== null ? (optPremiumMove >= 0 ? "\u25b2 +" : "\u25bc ") + "\u20b9" + Math.abs(optPremiumMove).toFixed(2) + " pts" : optCurrentLtp ? "\u23f3 Awaiting entry price..." : "\u23f3 Polling REST feed..."}
            </div>
            <div id="ax-opt-pct" style="font-size:1.1rem;font-weight:800;margin-top:4px;color:${optPremiumPct !== null ? (optPremiumPct >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};font-family:monospace;">
              ${optPremiumPct !== null ? (optPremiumPct >= 0 ? "+" : "") + optPremiumPct.toFixed(2) + "%" : "\u2014"}
            </div>
          </div>

          <div style="text-align:center;padding:12px;background:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#071a0f" : "#1a0707") : "#0d1320"};border:1px solid ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#065f46" : "#7f1d1d") : "#1a2236"};border-radius:10px;">
            <div style="font-size:0.63rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Unrealised P&L</div>
            <div id="ax-opt-pnl" style="font-size:1.8rem;font-weight:800;color:${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">
              ${optPremiumPnl !== null ? (optPremiumPnl >= 0 ? "+" : "") + "\u20b9" + optPremiumPnl.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2}) : "\u2014"}
            </div>
            <div style="font-size:0.65rem;color:#4a6080;margin-top:4px;">${pos.qty} qty \u00b7 after charges</div>
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
          <div id="ax-nifty-ltp" style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${inr(liveClose)}</div>
          <div id="ax-nifty-move" style="font-size:0.63rem;color:${pointsMoved >= 0 ? "#10b981" : "#ef4444"};margin-top:2px;">${pointsMoved >= 0 ? "\u25b2" : "\u25bc"} ${Math.abs(pointsMoved).toFixed(1)} pts</div>
        </div>
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop Loss (Prev Candle)</div>
          <div id="ax-stop-loss" style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.stopLoss ? inr(pos.stopLoss) : "\u2014"}</div>
          <div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">Risk: ${pos.stopLoss ? inr(Math.abs(pos.entryPrice - pos.stopLoss) * pos.qty) : "\u2014"}</div>
        </div>
        <div style="background:#1c0d00;border:1px solid #92400e;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Option SL (${optStopPct}% stop)</div>
          <div id="ax-opt-sl" style="font-size:1.05rem;font-weight:700;color:#f97316;">${optStopPrice ? "\u20b9" + optStopPrice.toFixed(2) : "\u2014"}</div>
          <div style="font-size:0.63rem;color:#4a6080;margin-top:2px;">${optEntryLtp ? "entry \u20b9" + optEntryLtp.toFixed(2) + " \u00d7 " + (100 - optStopPct) + "%" : "awaiting entry LTP"}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Peak P&L</div>
          <div id="ax-peak-pnl" style="font-size:1.05rem;font-weight:700;color:${(pos.peakPnl || 0) >= 0 ? "#10b981" : "#ef4444"};">${(pos.peakPnl || 0) >= 0 ? "+" : ""}${inr(pos.peakPnl || 0)}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">SL Trailed</div>
          <div id="ax-sl-trail" style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.stopLoss && pos.initialStopLoss ? Math.abs(pos.stopLoss - pos.initialStopLoss).toFixed(2) + " pts" : "0 pts"}</div>
          <div style="font-size:0.58rem;color:#4a6080;margin-top:2px;">from ${pos.initialStopLoss ? inr(pos.initialStopLoss) : "\u2014"}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:8px 10px;">
          <div style="font-size:0.55rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">SL Distance</div>
          <div id="ax-sl-dist" style="font-size:0.9rem;font-weight:700;color:${(() => { const d = pos.stopLoss && liveClose ? Math.abs(liveClose - pos.stopLoss) : 0; return d < 20 ? "#ef4444" : d < 40 ? "#f59e0b" : "#10b981"; })()};">${pos.stopLoss && liveClose ? Math.abs(liveClose - pos.stopLoss).toFixed(1) : "0"} <span style="font-size:0.6rem;color:#4a6080;">pts</span></div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:8px 10px;">
          <div style="font-size:0.55rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">R:R</div>
          <div id="ax-rr" style="font-size:0.9rem;font-weight:700;color:${pointsMoved >= 0 ? "#10b981" : "#ef4444"};">${(() => { const risk = pos.initialStopLoss ? Math.abs(pos.entryPrice - pos.initialStopLoss) : 0; return risk > 0 ? (pointsMoved / risk).toFixed(1) + "x" : "\u2014"; })()}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:8px 10px;">
          <div style="font-size:0.55rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Candles Held</div>
          <div id="ax-pos-candles" style="font-size:0.9rem;font-weight:700;color:#fff;">${pos.candlesHeld || 0} <span style="font-size:0.6rem;color:#4a6080;">candles</span></div>
        </div>
      </div>

      ${pos.reason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;">\uD83D\uDCDD ${pos.reason}</div>` : ""}
    </div>` : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:1.5rem;margin-bottom:8px;">\uD83D\uDCED</div>
      <div style="font-size:0.9rem;font-weight:600;color:#4a6080;margin-bottom:14px;">FLAT \u2014 Waiting for entry signal</div>
      ${state.running ? `<div style="display:flex;gap:10px;justify-content:center;">
        <button onclick="scManualEntry('CE')" style="padding:8px 24px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">\u25b2 Manual CE</button>
        <button onclick="scManualEntry('PE')" style="padding:8px 24px;background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">\u25bc Manual PE</button>
      </div>` : ''}
    </div>`;

  // Build trades JSON
  const tradesJson = JSON.stringify([...state.sessionTrades].reverse().map(t => ({
    side:       t.side || "",
    symbol:     t.symbol || "",
    strike:     t.optionStrike || "",
    expiry:     t.optionExpiry || "",
    optionType: t.optionType || t.side || "",
    qty:        t.qty || 0,
    entry:      t.entryTime || "",
    exit:       t.exitTime || "",
    eSpot:      t.spotAtEntry || t.entryPrice || 0,
    eOpt:       t.optionEntryLtp || null,
    eSl:        t.stopLoss || t.initialStopLoss || null,
    xSpot:      t.spotAtExit || t.exitPrice || 0,
    xOpt:       t.optionExitLtp || null,
    pnl:        typeof t.pnl === "number" ? t.pnl : null,
    pnlMode:    t.pnlMode || "",
    order:      t.orderId || "",
    reason:     t.exitReason || "",
    entryReason: t.entryReason || "",
  })));

  // Build log JSON
  const allLogs = [...state.log].reverse();
  const logsJSON = JSON.stringify(allLogs)
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/`/g, "\\u0060")
    .replace(/\$/g, "\\u0024");

  const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Scalp Live \u2014 ${scalpStrategy.NAME}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u26a1</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<style>
${sidebarCSS()}
${modalCSS()}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'IBM Plex Mono',monospace;background:#040c18;color:#c8d8f0;overflow-x:hidden;}
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
.trade-table th{padding:9px 12px;text-align:left;font-size:0.55rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#0a0f1c;cursor:pointer;user-select:none;white-space:nowrap;}
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
${buildSidebar('scalpLive', liveActive, state.running, {
  showExitBtn: !!pos,
  exitBtnJs: 'scHandleExit(this)',
  showStopBtn: state.running,
  stopBtnJs: 'scHandleStop(this)',
  showStartBtn: !state.running,
  startBtnJs: 'scHandleStart(this)',
})}
<div class="main-content">

<!-- TOP BAR -->
<div class="top-bar">
  <div>
    <div class="top-bar-title">Scalp Live Trade</div>
    <div class="top-bar-meta">${scalpStrategy.NAME} \u00b7 ${SCALP_RES}-min candles \u00b7 SL: Prev Candle \u00b7 Trail ${_SCALP_TRAIL_PCT}%+ tiered from \u20b9${_SCALP_TRAIL_START} \u00b7 ${state.running ? "Auto-refreshes 2s" : "Not refreshing"}</div>
  </div>
  <div class="top-bar-right">
    ${state.running
      ? '<span class="top-bar-badge live-active"><span style="width:5px;height:5px;border-radius:50%;background:#ef4444;display:inline-block;"></span> SCALP LIVE</span>'
      : '<span class="top-bar-badge">\u25cf STOPPED</span>'}
    ${_vixEnabled
      ? `<span class="top-bar-badge" style="border-color:${_vix == null ? 'rgba(100,116,139,0.3)' : _vix.value > _vixMaxEntry ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)'};background:${_vix == null ? 'rgba(100,116,139,0.08)' : _vix.value > _vixMaxEntry ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)'};color:${_vix == null ? '#94a3b8' : _vix.value > _vixMaxEntry ? '#ef4444' : '#10b981'};">\uD83C\uDF21\uFE0F VIX ${_vix != null ? _vix.value.toFixed(1) : 'n/a'}${_vix != null ? (_vix.value > _vixMaxEntry ? ' \u00b7 BLOCKED' : ' \u00b7 OK') : ''}</span>`
      : ''}
    <button onclick="scHandleReset(this)" style="background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;">↺ Reset</button>
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

  <!-- STAT GRID -->
  <div class="stat-grid">
    <div class="sc" style="border-top:2px solid ${state.running ? "#ef4444" : "#4a6080"};">
      <div class="sc-label">Status</div>
      <div class="sc-val" style="font-size:1rem;color:${state.running ? "#ef4444" : "#4a6080"};">${state.running ? "\u26a1 RUNNING" : "\u25cf STOPPED"}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${state.sessionPnl >= 0 ? '#10b981' : '#ef4444'};">
      <div class="sc-label">Session PnL</div>
      <div class="sc-val" id="ax-session-pnl" style="color:${state.sessionPnl >= 0 ? '#10b981' : '#ef4444'};">${state.sessionPnl >= 0 ? '+' : ''}${inr(state.sessionPnl)}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${unrealisedPnl >= 0 ? '#3b82f6' : '#ef4444'};">
      <div class="sc-label">Unrealised PnL</div>
      <div class="sc-val" id="ax-unreal-pnl" style="color:${unrealisedPnl >= 0 ? '#3b82f6' : '#ef4444'};">${pos ? ((unrealisedPnl >= 0 ? '+' : '') + inr(unrealisedPnl)) : '\u2014'}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #3b82f6;">
      <div class="sc-label">WebSocket Ticks</div>
      <div class="sc-val" id="ax-tick-count">${state.tickCount.toLocaleString()}</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">Last: <span id="ax-last-tick">${state.lastTickPrice ? inr(state.lastTickPrice) : '\u2014'}</span></div>
    </div>
    <div class="sc" style="border-top:1.5px solid #8b5cf6;">
      <div class="sc-label">Candles Loaded</div>
      <div class="sc-val" id="ax-candle-count">${state.candles.length}</div>
      <div id="ax-candle-status" style="font-size:0.7rem;color:${state.candles.length >= 15 ? '#10b981' : '#f59e0b'};margin-top:4px;">${state.candles.length >= 15 ? '\u2705 Strategy ready' : '\u26a0\ufe0f warming'}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #8b5cf6;">
      <div class="sc-label">Trades (W/L)</div>
      <div class="sc-val"><span id="ax-trade-count">${state.sessionTrades.length}</span> <span style="font-size:0.75rem;color:#4a6080;">/ ${_SCALP_MAX_TRADES}</span></div>
      <div id="ax-wl" style="font-size:0.7rem;color:#4a6080;margin-top:4px;">${wins}W \u00b7 ${losses}L</div>
    </div>
    <div class="sc" style="border-top:2px solid ${state._dailyLossHit ? '#ef4444' : '#10b981'};" id="ax-sc-dloss">
      <div class="sc-label">Daily Loss Limit</div>
      <div class="sc-val" style="color:${state._dailyLossHit ? '#ef4444' : '#fff'};">${inr(-_SCALP_MAX_LOSS)}</div>
      <div id="ax-daily-loss" style="font-size:0.7rem;margin-top:4px;color:${state._dailyLossHit ? '#ef4444' : '#10b981'};">${state._dailyLossHit ? '\uD83D\uDED1 KILLED' : '\u2705 Active'}</div>
    </div>
    <div class="sc" style="border-top:1.5px solid #2a4060;">
      <div class="sc-label">Session Start</div>
      <div class="sc-val" style="font-size:0.85rem;color:#c8d8f0;">${fmtISTDateTime(state.sessionStart)}</div>
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
      ${posHtml}
    </div>
  </div>

  <!-- CURRENT BAR -->
  ${state.currentBar ? `
  <div style="margin-bottom:24px;">
    <div class="section-title">Current ${SCALP_RES}-Min Bar (forming)</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
      ${["open","high","low","close"].map(k => `<div class="sc"><div class="sc-label">${k.toUpperCase()}</div><div class="sc-val" id="ax-bar-${k}" style="font-size:1rem;">${inr(state.currentBar[k])}</div></div>`).join("")}
    </div>
  </div>` : `
  <div style="margin-bottom:24px;">
    <div class="section-title">Current ${SCALP_RES}-Min Bar (forming)</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
      ${["open","high","low","close"].map(k => `<div class="sc"><div class="sc-label">${k.toUpperCase()}</div><div class="sc-val" id="ax-bar-${k}" style="font-size:1rem;">\u2014</div></div>`).join("")}
    </div>
  </div>`}

  ${process.env.CHART_ENABLED !== "false" ? `<!-- NIFTY Chart -->
  <div style="margin-bottom:18px;">
    <div class="section-title">NIFTY ${SCALP_RES}-Min Chart</div>
    <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
      <div id="nifty-chart" style="width:100%;height:100%;"></div>
      <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
        <span style="color:#3b82f6;">▲ Entry</span> &nbsp;<span style="color:#10b981;">▼ Win</span> &nbsp;<span style="color:#ef4444;">▼ Loss</span> &nbsp;<span style="color:#f59e0b;">── SL</span> &nbsp;<span style="color:#3b82f6;">-- Entry</span>
      </div>
    </div>
  </div>` : ""}

  <!-- SESSION TRADES TABLE -->
  <div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
      <div class="section-title" style="margin-bottom:0;">Session Trades</div>
      <select id="scSide" onchange="scFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All Sides</option><option value="CE">CE</option><option value="PE">PE</option>
      </select>
      <select id="scResult" onchange="scFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All</option><option value="win">Wins</option><option value="loss">Losses</option>
      </select>
      <select id="scPerPage" onchange="scFilter()" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="5">5/page</option><option value="10" selected>10/page</option><option value="25">25/page</option><option value="999999">All</option>
      </select>
      <span id="scCount" style="font-size:0.72rem;color:#4a6080;"></span>
    </div>
    ${state.sessionTrades.length === 0
      ? `<div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:16px 24px;color:#4a6080;font-size:0.82rem;">No completed trades this session.</div>`
      : `<div style="border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;margin-bottom:10px;">
          <table class="trade-table">
            <thead><tr>
              <th onclick="scSort('side')">Side \u25b2\u25bc</th>
              <th onclick="scSort('entry')">Date \u25b2\u25bc</th>
              <th>Entry</th>
              <th>Entry Time</th>
              <th>Exit</th>
              <th onclick="scSort('exit')">Exit Time \u25b2\u25bc</th>
              <th>SL</th>
              <th onclick="scSort('pnl')">PnL \u20b9 \u25b2\u25bc</th>
              <th>Entry Reason</th>
              <th>Exit Reason</th>
              <th style="text-align:center;">Action</th>
            </tr></thead>
            <tbody id="scBody"></tbody>
          </table>
        </div>
        <div id="scPag" style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;"></div>
        <!-- Trade Detail Modal -->
        <div id="scModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
          <div style="background:#0d1320;border:1px solid #3a1a1a;border-radius:16px;padding:24px 28px;max-width:720px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.9);position:relative;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
              <div>
                <span id="scm-badge" style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:4px 10px;border-radius:6px;"></span>
                <span style="font-size:0.65rem;color:#4a6080;margin-left:10px;">\uD83D\uDD34 Scalp Live \u2014 Full Details</span>
              </div>
              <button onclick="document.getElementById('scModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:#4a6080;font-size:1rem;cursor:pointer;padding:4px 10px;border-radius:6px;font-family:inherit;" onmouseover="this.style.color='#ef4444';this.style.borderColor='#ef4444'" onmouseout="this.style.color='#4a6080';this.style.borderColor='#1a2236'">\u2715 Close</button>
            </div>
            <div id="scm-grid"></div>
          </div>
        </div>`}
    <div style="background:#0a0f1c;border:1px solid #1a2236;border-radius:8px;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
      <span style="font-size:0.75rem;color:#c8d8f0;font-weight:700;">Session P&L</span>
      <span id="ax-session-pnl-bar" style="font-size:1.1rem;font-weight:800;color:${state.sessionPnl >= 0 ? '#10b981' : '#ef4444'};">${state.sessionPnl >= 0 ? '+' : ''}${inr(state.sessionPnl)}</span>
    </div>
  </div>

  <!-- ACTIVITY LOG -->
  <div style="margin-top:8px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
      <div class="section-title" style="margin-bottom:0;">Activity Log</div>
      <input id="logSearch" placeholder="Search log\u2026" oninput="logFilter()"
        style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 9px;border-radius:6px;font-size:0.73rem;font-family:inherit;width:180px;"/>
      <select id="logType" onchange="logFilter()"
        style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All entries</option>
        <option value="\u2705">\u2705 Wins</option>
        <option value="\u274c">\u274c Errors</option>
        <option value="\uD83D\uDEA8">\uD83D\uDEA8 Alerts</option>
        <option value="\uD83D\uDED1">\uD83D\uDED1 SL Hits</option>
      </select>
      <select id="logPP" onchange="logFilter()"
        style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="50">50/page</option>
        <option value="100">100/page</option>
        <option value="9999">All</option>
      </select>
      <span id="logCount" style="font-size:0.7rem;color:#4a6080;"></span>
      <button onclick="copyActivityLog(this)" style="margin-left:auto;background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;white-space:nowrap;">\uD83D\uDCCB Copy Log</button>
    </div>
    <div id="logBox" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:12px 16px;max-height:360px;overflow-y:auto;"></div>
    <div id="logPag" style="display:flex;gap:5px;margin-top:8px;flex-wrap:wrap;"></div>
  </div>

  <p style="font-size:0.72rem;color:#2a4060;margin-top:16px;">\uD83D\uDD04 Auto-refreshes every 2 seconds while trading is active</p>
</div><!-- .page -->
</div><!-- .main-content -->
</div><!-- .app-shell -->

<script id="sc-trade-data" type="application/json">${tradesJson}</script>
<script id="sc-log-data" type="application/json">${logsJSON}</script>

<script>
${modalJS()}

/* ── Toast ── */
function scToast(msg, color) {
  var t = document.createElement('div');
  t.className = 'scalp-toast';
  t.textContent = msg;
  t.style.border = '1px solid ' + color;
  t.style.color = color;
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 3500);
}

/* ── Start / Stop / Exit handlers ── */
async function scHandleExit(btn) {
  if (btn) { btn.textContent = '\u23f3 Exiting...'; btn.disabled = true; }
  try {
    var res = await secretFetch('/scalp-live/exit');
    if (!res) { if (btn) { btn.textContent = '\uD83D\uDEAA Exit Position'; btn.disabled = false; } return; }
    var data = await res.json();
    if (!data.success) {
      scToast('\u274c ' + (data.error || 'Exit failed'), '#ef4444');
      if (btn) { btn.textContent = '\uD83D\uDEAA Exit Position'; btn.disabled = false; }
      return;
    }
    scToast('\uD83D\uDEAA Position exited via Fyers!', '#f59e0b');
    setTimeout(function(){ location.reload(); }, 1200);
  } catch(e) {
    scToast('\u274c ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '\uD83D\uDEAA Exit Position'; btn.disabled = false; }
  }
}
async function scHandleStart(btn) {
  if (btn) { btn.textContent = '\u23f3 Starting...'; btn.disabled = true; }
  try {
    var res = await secretFetch('/scalp-live/start');
    if (!res) { if (btn) { btn.textContent = '\u25b6 Start'; btn.disabled = false; } return; }
    var data = await res.json();
    if (!data.success) {
      scToast('\u274c ' + (data.error || 'Failed to start'), '#ef4444');
      if (btn) { btn.textContent = '\u25b6 Start'; btn.disabled = false; }
      return;
    }
    scToast('\uD83D\uDD34 Scalp live trading started!', '#10b981');
    setTimeout(function(){ location.reload(); }, 1200);
  } catch(e) {
    scToast('\u274c ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '\u25b6 Start'; btn.disabled = false; }
  }
}
async function scHandleStop(btn) {
  if (btn) { btn.textContent = '\u23f3 Stopping...'; btn.disabled = true; }
  try {
    var res = await secretFetch('/scalp-live/stop');
    if (!res) { if (btn) { btn.textContent = '\u25a0 Stop'; btn.disabled = false; } return; }
    var data = await res.json();
    scToast('\u23f9 Scalp live trading stopped.', '#ef4444');
    setTimeout(function(){ location.reload(); }, 1200);
  } catch(e) {
    scToast('\u274c ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '\u25a0 Stop'; btn.disabled = false; }
  }
}
async function scHandleReset(btn) {
  var ok = await showDoubleConfirm({
    icon: '⚠️', title: 'Reset Scalp Live History',
    message: 'Wipe ALL scalp LIVE trade history?\\nClears recorded sessions on this server. Does NOT touch real broker orders.\\nCannot be undone.',
    confirmText: 'Reset History', confirmClass: 'modal-btn-danger',
    subject: 'ALL scalp LIVE trade history',
    secondConfirmText: 'Yes, reset all'
  });
  if (!ok) return;
  if (btn) { btn.textContent = '⏳...'; btn.disabled = true; }
  try {
    var res = await secretFetch('/scalp-live/reset', { method: 'POST' });
    if (!res) { if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; } return; }
    var data;
    try { data = await res.json(); } catch(_) { data = { success: false, error: 'Server error (status ' + res.status + ')' }; }
    if (!data.success) {
      scToast('❌ ' + (data.error || 'Reset failed'), '#ef4444');
      if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; }
      return;
    }
    scToast('✅ ' + data.message, '#10b981');
    setTimeout(function(){ location.reload(); }, 1200);
  } catch(e) {
    scToast('❌ ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; }
  }
}
async function scManualEntry(side) {
  var ok = await showConfirm({
    icon: '\u26a0\ufe0f',
    title: 'Manual LIVE entry',
    message: 'SCALP LIVE: Manual ' + side + ' entry with REAL money. Confirm?',
    confirmText: 'Enter ' + side + ' (LIVE)',
    confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  try {
    var res = await secretFetch('/scalp-live/manualEntry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side: side })
    });
    if (!res) return;
    var data = await res.json();
    if (data.success) {
      scToast('\u2705 Manual ' + side + ' entry @ \u20b9' + data.spot, '#10b981');
      location.reload();
    } else {
      scToast('\u274c ' + (data.error || 'Entry failed'), '#ef4444');
    }
  } catch(e) {
    scToast('\u274c ' + e.message, '#ef4444');
  }
}

/* ── Format helpers ── */
var INR = function(n) { return typeof n === 'number' ? '\u20b9' + n.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2}) : '\u2014'; };
var PNL_COLOR = function(n) { return n >= 0 ? '#10b981' : '#ef4444'; };

/* ── Date/Time helpers ── */
function scFmtDate(dt){ if(!dt) return '\u2014'; var p=dt.split(', '); var d=(p[0]||'').split('/'); if(d.length>=2) return d[0].padStart(2,'0')+'/'+d[1].padStart(2,'0')+(d[2]?'/'+d[2]:''); return p[0]||'\u2014'; }
function scFmtTime(dt){ if(!dt) return '\u2014'; var p=dt.split(', '); return p[1]||'\u2014'; }

/* ── Trades table (matching live trade page) ── */
var SC_ALL = JSON.parse(document.getElementById('sc-trade-data').textContent);
var scFiltered=[...SC_ALL],scSortCol='entry',scSortDir=-1,scPage=1,scPP=10;
function scFilter(){
  var side=document.getElementById('scSide').value;
  var res=document.getElementById('scResult').value;
  scPP=parseInt(document.getElementById('scPerPage').value);
  scPage=1;
  scFiltered=SC_ALL.filter(function(t){
    if(side && t.side!==side) return false;
    if(res==='win'  && (t.pnl==null||t.pnl<0))  return false;
    if(res==='loss' && (t.pnl==null||t.pnl>=0)) return false;
    return true;
  });
  scApplySort();
}
function scSort(col){scSortDir=scSortCol===col?scSortDir*-1:-1;scSortCol=col;scApplySort();}
function scApplySort(){
  scFiltered.sort(function(a,b){
    var av=a[scSortCol],bv=b[scSortCol];
    if(av==null)av=scSortDir===-1?-Infinity:Infinity;
    if(bv==null)bv=scSortDir===-1?-Infinity:Infinity;
    return typeof av==='string'?av.localeCompare(bv)*scSortDir:(av-bv)*scSortDir;
  });
  scRender();
}
function scRender(){
  var el=document.getElementById('scBody');
  var cnt=document.getElementById('scCount');
  if(!el) return;
  if(cnt) cnt.textContent=scFiltered.length+'/'+SC_ALL.length+' trades';
  var start=(scPage-1)*scPP,slice=scFiltered.slice(start,start+scPP);
  window._scSlice=slice;
  el.innerHTML=slice.length===0
    ?'<tr><td colspan="11" style="text-align:center;padding:20px;color:#4a6080;">No trades match filters.</td></tr>'
    :slice.map(function(t,i){
      var sc=t.side==='CE'?'#10b981':'#ef4444';
      var pc=t.pnl==null?'#c8d8f0':t.pnl>=0?'#10b981':'#ef4444';
      var short=t.reason.length>35?t.reason.slice(0,35)+'\u2026':t.reason;
      return '<tr style="border-top:1px solid #1a2236;vertical-align:top;">'
        +'<td style="padding:8px 12px;color:'+sc+';font-weight:800;">'+(t.side||'\u2014')+'</td>'
        +'<td style="padding:8px 12px;font-size:0.75rem;">'+scFmtDate(t.entry)+'</td>'
        +'<td style="padding:8px 12px;font-weight:700;">'+INR(t.eSpot)+'</td>'
        +'<td style="padding:8px 12px;font-size:0.75rem;">'+scFmtTime(t.entry)+'</td>'
        +'<td style="padding:8px 12px;font-weight:700;">'+INR(t.xSpot)+'</td>'
        +'<td style="padding:8px 12px;font-size:0.75rem;">'+scFmtTime(t.exit)+'</td>'
        +'<td style="padding:8px 12px;color:#f59e0b;">'+(t.eSl?INR(t.eSl):'\u2014')+'</td>'
        +'<td style="padding:8px 12px;"><div style="font-size:1rem;font-weight:800;color:'+pc+';">'+(t.pnl!=null?(t.pnl>=0?'+':'')+INR(t.pnl):'\u2014')+'</div></td>'
        +'<td style="padding:8px 12px;font-size:0.7rem;color:#4a6080;" title="'+(t.entryReason||'')+'">'+(t.entryReason?(t.entryReason.length>25?t.entryReason.slice(0,25)+'\u2026':t.entryReason):'\u2014')+'</td>'
        +'<td style="padding:8px 12px;font-size:0.7rem;color:#4a6080;" title="'+t.reason+'">'+(short||'\u2014')+'</td>'
        +'<td style="padding:6px 8px;text-align:center;"><button data-idx="'+i+'" class="sc-eye-btn" style="background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;" title="View full details">\uD83D\uDC41</button></td>'
        +'</tr>';
    }).join('');
  Array.from(el.querySelectorAll('.sc-eye-btn')).forEach(function(btn){
    btn.addEventListener('click',function(){ showSCModal(window._scSlice[parseInt(this.getAttribute('data-idx'))]); });
    btn.addEventListener('mouseover',function(){ this.style.borderColor='#3b82f6';this.style.background='#0a1e3d'; });
    btn.addEventListener('mouseout', function(){ this.style.borderColor='#1a2236';this.style.background='none'; });
  });
  var pagEl=document.getElementById('scPag');
  if(!pagEl) return;
  var total=Math.ceil(scFiltered.length/scPP);
  if(total<=1){pagEl.innerHTML='';return;}
  pagEl.innerHTML=
    '<button onclick="scGo('+(scPage-1)+')" '+(scPage===1?'disabled':'')+' style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">\u2190 Prev</button>'+
    Array.from({length:total},function(_,i){return i+1;}).filter(function(p){return Math.abs(p-scPage)<=2;}).map(function(p){
      return '<button onclick="scGo('+p+')" style="background:'+(p===scPage?'#0a1e3d':'#0d1320')+';border:1px solid '+(p===scPage?'#1d3b6e':'#1a2236')+';color:'+(p===scPage?'#3b82f6':'#c8d8f0')+';padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">'+p+'</button>';}).join('')+
    '<button onclick="scGo('+(scPage+1)+')" '+(scPage===total?'disabled':'')+' style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;">Next \u2192</button>';
}
function scGo(p){scPage=Math.max(1,Math.min(Math.ceil(scFiltered.length/scPP),p));scRender();}
if(SC_ALL.length>0) scFilter();

/* ── Trade Detail Modal ── */
function showSCModal(t){
  var pc=t.pnl==null?'#c8d8f0':t.pnl>=0?'#10b981':'#ef4444';
  var sc=t.side==='CE'?'#10b981':'#ef4444';
  var fmt=function(n){return n!=null&&n!==0?'\u20b9'+Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}):'\u2014';};
  var optDiff=(t.eOpt!=null&&t.xOpt!=null)?parseFloat((t.xOpt-t.eOpt).toFixed(2)):null;
  var dc=optDiff==null?'#c8d8f0':optDiff>=0?'#10b981':'#ef4444';
  var pnlPts=(t.eSpot&&t.xSpot&&t.side)?parseFloat(((t.side==='PE'?t.eSpot-t.xSpot:t.xSpot-t.eSpot)).toFixed(2)):null;

  var badge=document.getElementById('scm-badge');
  badge.textContent=(t.side||'\u2014')+(t.strike?' \u00b7 '+t.strike:'')+(t.optionType?' '+t.optionType:'');
  badge.style.background=t.side==='CE'?'rgba(16,185,129,0.15)':'rgba(239,68,68,0.15)';
  badge.style.color=sc;
  badge.style.border='1px solid '+(t.side==='CE'?'rgba(16,185,129,0.3)':'rgba(239,68,68,0.3)');

  function cell(label,val,color,sub){
    return '<div style="background:#060910;border:1px solid #1a2236;border-radius:8px;padding:11px 13px;">'
      +'<div style="font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:5px;">'+label+'</div>'
      +'<div style="font-size:0.9rem;font-weight:700;color:'+(color||'#e0eaf8')+';font-family:monospace;line-height:1.3;">'+(val||'\u2014')+'</div>'
      +(sub?'<div style="font-size:0.62rem;color:#4a6080;margin-top:3px;">'+sub+'</div>':'')
      +'</div>';
  }

  var contractHtml='<div style="background:#06100e;border:1px solid #0d3020;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a6040;margin-bottom:8px;font-weight:700;">\uD83D\uDCCB Option Contract</div>'
    +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
    +cell('Symbol',t.symbol||'\u2014','#a0f0c0')
    +cell('Strike',t.strike||'\u2014','#fff')
    +cell('Expiry',t.expiry||'\u2014','#f59e0b')
    +cell('Option Type',t.optionType||t.side||'\u2014',sc)
    +cell('Qty / Lots',t.qty?t.qty+' qty':'\u2014','#c8d8f0')
    +cell('Order ID',t.order||'\u2014','#a78bfa')
    +'</div></div>';

  var entryHtml='<div style="background:#060c18;border:1px solid #0d2040;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a4080;margin-bottom:8px;font-weight:700;">\uD83D\uDFE2 Entry</div>'
    +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
    +cell('Entry Time',t.entry||'\u2014','#c8d8f0')
    +cell('NIFTY Spot @ Entry',fmt(t.eSpot),'#fff','Index price at entry')
    +cell('Option LTP @ Entry',fmt(t.eOpt),'#60a5fa','Option premium paid')
    +cell('Initial Stop Loss',fmt(t.eSl),'#f59e0b','NIFTY spot SL level')
    +cell('SL Distance',(t.eSl&&t.eSpot)?Math.abs(t.eSpot-t.eSl).toFixed(2)+' pts':'\u2014','#f59e0b','pts from entry to SL')
    +cell('Entry Signal',t.entryReason||'\u2014','#a0b8d0','Strategy signal that triggered entry')
    +cell('PnL Mode',t.pnlMode||'spot-diff','#8b8bf0')
    +'</div></div>';

  var exitHtml='<div style="background:#0c0608;border:1px solid #3a0d12;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#801a20;margin-bottom:8px;font-weight:700;">\uD83D\uDD34 Exit</div>'
    +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
    +cell('Exit Time',t.exit||'\u2014','#c8d8f0')
    +cell('NIFTY Spot @ Exit',fmt(t.xSpot),'#fff','Index price at exit')
    +cell('Option LTP @ Exit',fmt(t.xOpt),'#60a5fa','Option premium at exit')
    +cell('NIFTY Move (pts)',pnlPts!=null?(pnlPts>=0?'+':'')+pnlPts+' pts':'\u2014',pnlPts!=null?(pnlPts>=0?'#10b981':'#ef4444'):'#c8d8f0',t.side==='PE'?'Entry\u2212Exit (PE profits on fall)':'Exit\u2212Entry (CE profits on rise)')
    +cell('Option \u0394 (pts)',optDiff!=null?(optDiff>=0?'\u25b2 +':'\u25bc ')+optDiff+' pts':'\u2014',dc,'Exit prem \u2212 Entry prem')
    +cell('Net PnL',t.pnl!=null?(t.pnl>=0?'+':'')+fmt(t.pnl):'\u2014',pc,'After STT + charges')
    +'</div></div>';

  var reasonHtml='<div style="background:#060910;border:1px solid #1a2236;border-radius:10px;padding:12px 14px;">'
    +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#3a5070;margin-bottom:6px;font-weight:700;">\uD83D\uDCCC Exit Reason</div>'
    +'<div style="font-size:0.82rem;color:#a0b8d0;line-height:1.6;font-family:monospace;">'+(t.reason||'\u2014')+'</div>'
    +'</div>';

  document.getElementById('scm-grid').innerHTML=contractHtml+entryHtml+exitHtml+reasonHtml;
  var m=document.getElementById('scModal');
  m.style.display='flex';
}
document.getElementById('scModal')&&document.getElementById('scModal').addEventListener('click',function(e){if(e.target===this)this.style.display='none';});

/* ── Log viewer (with pagination) ── */
var LOG_ALL = JSON.parse(document.getElementById('sc-log-data').textContent);
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
    var c = l.indexOf('\u274c')>=0?'#ef4444':l.indexOf('\u2705')>=0?'#10b981':l.indexOf('\uD83D\uDEA8')>=0||l.indexOf('\uD83D\uDED1')>=0?'#f59e0b':l.indexOf('\uD83C\uDFAF')>=0||l.indexOf('\u26a1')>=0?'#3b82f6':'#4a6080';
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
  function done(){ btn.textContent='\\u2705 Copied!'; setTimeout(function(){ btn.textContent=orig; },2000); }
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

/* ── NIFTY Chart (Lightweight Charts) ── */
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
  var slLine = null, entryLine = null, _lcc = 0;
  function fetchChart() {
    fetch('/scalp-live/status/chart-data', { cache: 'no-store' }).then(function(r) { return r.json(); }).then(function(d) {
      if (!d.candles || !d.candles.length) return;
      if (Math.abs(d.candles.length - _lcc) > 1 || _lcc === 0) {
        cs.setData(d.candles.map(function(c) { return { time:c.time, open:c.open, high:c.high, low:c.low, close:c.close }; }));
      } else { var l = d.candles[d.candles.length-1]; cs.update({ time:l.time, open:l.open, high:l.high, low:l.low, close:l.close }); }
      _lcc = d.candles.length;
      if (d.markers && d.markers.length) { var s = d.markers.slice().sort(function(a,b){return a.time-b.time;}); cs.setMarkers(s); } else { cs.setMarkers([]); }
      if (slLine) { cs.removePriceLine(slLine); slLine = null; }
      if (d.stopLoss) { slLine = cs.createPriceLine({ price:d.stopLoss, color:'#f59e0b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'SL' }); }
      if (entryLine) { cs.removePriceLine(entryLine); entryLine = null; }
      if (d.entryPrice) { entryLine = cs.createPriceLine({ price:d.entryPrice, color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' }); }
    }).catch(function(e) { console.warn('[Chart]', e.message); });
  }
  fetchChart();
  if (${state.running}) setInterval(fetchChart, 4000);
  window.addEventListener('resize', function() { chart.applyOptions({ width: container.clientWidth }); });
})();

/* ── AJAX Polling ── */
(function() {
  var _interval   = null;
  var _lastTradeCount  = ${state.sessionTrades.length};
  var _lastRunning     = ${state.running};
  var _lastLogCount    = ${state.log.length};
  var _lastHasPosition = ${pos ? "true" : "false"};

  function fetchAndUpdate() {
    fetch('/scalp-live/status/data', { cache: 'no-store' }).then(function(r) { return r.json(); }).then(function(d) {

      // Position state change => reload
      var nowHasPos = !!d.position;
      if (nowHasPos !== _lastHasPosition) {
        _lastHasPosition = nowHasPos;
        window.location.reload();
        return;
      }

      // Session PnL
      var spEl = document.getElementById('ax-session-pnl');
      if (spEl) {
        spEl.textContent = (d.sessionPnl >= 0 ? '+' : '') + INR(d.sessionPnl);
        spEl.style.color = PNL_COLOR(d.sessionPnl);
        var card = spEl.closest('.sc');
        if (card) card.style.borderTopColor = PNL_COLOR(d.sessionPnl);
      }
      var spBar = document.getElementById('ax-session-pnl-bar');
      if (spBar) {
        spBar.textContent = (d.sessionPnl >= 0 ? '+' : '') + INR(d.sessionPnl);
        spBar.style.color = PNL_COLOR(d.sessionPnl);
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
      if (tcEl) tcEl.textContent = d.tradeCount;
      var wlEl = document.getElementById('ax-wl');
      if (wlEl) wlEl.textContent = d.wins + 'W \u00b7 ' + d.losses + 'L';

      // Ticks & candles
      var tikEl = document.getElementById('ax-tick-count');
      if (tikEl) tikEl.textContent = (d.tickCount || 0).toLocaleString();
      var ltpEl = document.getElementById('ax-last-tick');
      if (ltpEl) ltpEl.textContent = d.lastTickPrice ? INR(d.lastTickPrice) : '\u2014';
      var cnEl = document.getElementById('ax-candle-count');
      if (cnEl) cnEl.textContent = d.candleCount;
      var csEl = document.getElementById('ax-candle-status');
      if (csEl) {
        csEl.textContent = d.candleCount >= 15 ? '\u2705 Strategy ready' : '\u26a0\ufe0f warming';
        csEl.style.color = d.candleCount >= 15 ? '#10b981' : '#f59e0b';
      }

      // Daily loss
      var dlCard = document.getElementById('ax-sc-dloss');
      var dlStatus = document.getElementById('ax-daily-loss');
      if (dlCard) dlCard.style.borderTopColor = d.dailyLossHit ? '#ef4444' : '#10b981';
      if (dlStatus) {
        dlStatus.textContent = d.dailyLossHit ? '\uD83D\uDED1 KILLED' : '\u2705 Active';
        dlStatus.style.color = d.dailyLossHit ? '#ef4444' : '#10b981';
      }

      // LTP
      var ltp2 = document.getElementById('ax-ltp');
      if (ltp2) ltp2.textContent = d.lastTickPrice ? INR(d.lastTickPrice) : '\u2014';

      // Position-specific updates
      if (d.position) {
        var p = d.position;
        var entEl = document.getElementById('ax-opt-entry-ltp');
        if (entEl) {
          entEl.textContent = p.optionEntryLtp ? '\u20b9' + p.optionEntryLtp.toFixed(2) : 'Fetching...';
          entEl.style.color = p.optionEntryLtp ? '#60a5fa' : '#f59e0b';
        }
        var curEl = document.getElementById('ax-opt-current-ltp');
        if (curEl) {
          curEl.textContent = p.optionCurrentLtp ? '\u20b9' + p.optionCurrentLtp.toFixed(2) : '\u23f3';
          if (p.optionEntryLtp && p.optionCurrentLtp) {
            curEl.style.color = p.optionCurrentLtp >= p.optionEntryLtp ? '#10b981' : '#ef4444';
          }
        }
        var movEl = document.getElementById('ax-opt-move');
        if (movEl && p.optPremiumMove !== null) {
          movEl.textContent = (p.optPremiumMove >= 0 ? '\u25b2 +' : '\u25bc ') + '\u20b9' + Math.abs(p.optPremiumMove).toFixed(2) + ' pts';
          movEl.style.color = p.optPremiumMove >= 0 ? '#10b981' : '#ef4444';
        }
        var pctEl = document.getElementById('ax-opt-pct');
        if (pctEl) {
          if (p.optPremiumPct !== null && p.optPremiumPct !== undefined) {
            pctEl.textContent = (p.optPremiumPct >= 0 ? '+' : '') + p.optPremiumPct.toFixed(2) + '%';
            pctEl.style.color = p.optPremiumPct >= 0 ? '#10b981' : '#ef4444';
          }
        }
        var optSlEl = document.getElementById('ax-opt-sl');
        if (optSlEl) optSlEl.textContent = p.optStopPrice ? '\u20b9' + p.optStopPrice.toFixed(2) : '\u2014';
        var optPnlEl = document.getElementById('ax-opt-pnl');
        if (optPnlEl && p.optPremiumPnl !== null) {
          optPnlEl.textContent = (p.optPremiumPnl >= 0 ? '+' : '') + INR(p.optPremiumPnl);
          optPnlEl.style.color = PNL_COLOR(p.optPremiumPnl);
        }
        var ltpLiveEl = document.getElementById('ax-nifty-ltp');
        var ltpNow = d.lastTickPrice || p.liveClose;
        if (ltpLiveEl && ltpNow !== null) {
          ltpLiveEl.textContent = INR(ltpNow);
          var sub = document.getElementById('ax-nifty-move');
          if (sub && p.entryPrice) {
            var moved = parseFloat(((ltpNow - p.entryPrice) * (p.side === 'CE' ? 1 : -1)).toFixed(1));
            sub.textContent = (moved >= 0 ? '\u25b2' : '\u25bc') + ' ' + Math.abs(moved).toFixed(1) + ' pts';
            sub.style.color = moved >= 0 ? '#10b981' : '#ef4444';
          }
        }
        var slEl = document.getElementById('ax-stop-loss');
        if (slEl) slEl.textContent = p.stopLoss ? INR(p.stopLoss) : '\u2014';

        // Peak P&L
        var peakEl = document.getElementById('ax-peak-pnl');
        if (peakEl) {
          var peak = p.peakPnl || 0;
          peakEl.textContent = (peak >= 0 ? '+' : '') + INR(peak);
          peakEl.style.color = peak >= 0 ? '#10b981' : '#ef4444';
        }
        // SL Trailed
        var slTrailEl = document.getElementById('ax-sl-trail');
        if (slTrailEl && p.stopLoss && p.initialStopLoss) {
          slTrailEl.textContent = Math.abs(p.stopLoss - p.initialStopLoss).toFixed(2) + ' pts';
        }

        // SL Distance
        var slDistEl = document.getElementById('ax-sl-dist');
        if (slDistEl && p.stopLoss && ltpNow) {
          var dist = Math.abs(ltpNow - p.stopLoss);
          slDistEl.innerHTML = dist.toFixed(1) + ' <span style="font-size:0.6rem;color:#4a6080;">pts</span>';
          slDistEl.style.color = dist < 20 ? '#ef4444' : dist < 40 ? '#f59e0b' : '#10b981';
        }
        // R:R
        var rrEl = document.getElementById('ax-rr');
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
        var cnHeld = document.getElementById('ax-pos-candles');
        if (cnHeld) cnHeld.innerHTML = (p.candlesHeld || 0) + ' <span style="font-size:0.6rem;color:#4a6080;">candles</span>';
      }

      // Current bar
      if (d.currentBar) {
        ['open','high','low','close'].forEach(function(k) {
          var el = document.getElementById('ax-bar-' + k);
          if (el) el.textContent = INR(d.currentBar[k]);
        });
      }

      // Trades table update
      if (d.trades && d.tradeCount !== _lastTradeCount) {
        _lastTradeCount = d.tradeCount;
        SC_ALL.length = 0;
        d.trades.forEach(function(t){ SC_ALL.push(t); });
        scFiltered = SC_ALL.slice();
        scFilter();
      }

      // Activity log update
      if (d.logs && d.logTotal !== _lastLogCount) {
        _lastLogCount = d.logTotal;
        LOG_ALL.length = 0;
        d.logs.forEach(function(l){ LOG_ALL.push(l); });
        logFilter();
      }

      // Detect stop
      if (_lastRunning && !d.running) {
        _lastRunning = false;
        clearInterval(_interval);
        _interval = null;
        setTimeout(function(){ window.location.reload(); }, 1500);
      }
    }).catch(function(e) {
      console.warn('[AJAX refresh] fetch error:', e.message);
    });
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
</body></html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
  } catch (err) {
    console.error("[scalp/status] Error:", err.message, err.stack);
    return res.status(500).send(`<pre style="color:red;padding:32px;font-family:monospace;">Scalp Live Status Error: ${err.message}\n\n${err.stack}</pre>`);
  }
});

/**
 * POST /scalp-live/reset
 * Wipe all scalp LIVE trade history (clears scalp_live_trades.json sessions).
 * Refuses when a live session is running. Does NOT touch real broker orders.
 */
router.post("/reset", (req, res) => {
  if (state.running) {
    return res.status(400).json({
      success: false,
      error: "Stop scalp live trading first before resetting history.",
    });
  }
  try {
    ensureDir();
    fs.writeFileSync(SL_FILE, JSON.stringify({ sessions: [] }, null, 2));
    log("🔄 [SCALP-LIVE] Scalp live trade history cleared.");
    return res.json({ success: true, message: "Scalp live trade history cleared." });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Export router (Express) + stopSession (for graceful shutdown from app.js)
router.stopSession = stopSession;
module.exports = router;

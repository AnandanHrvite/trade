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
const scalpStrategy    = require("../strategies/scalp_ema9_rsi");
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
const SCALP_RES          = parseInt(process.env.SCALP_RESOLUTION || "3", 10);
const _SCALP_SL_PTS      = parseFloat(process.env.SCALP_SL_PTS || "12");
const _SCALP_TARGET_PTS  = parseFloat(process.env.SCALP_TARGET_PTS || "18");
const _SCALP_TRAIL_GAP   = parseFloat(process.env.SCALP_TRAIL_GAP || "8");
const _SCALP_TRAIL_AFTER = parseFloat(process.env.SCALP_TRAIL_AFTER || "10");
const _SCALP_TIME_STOP   = parseInt(process.env.SCALP_TIME_STOP_CANDLES || "4", 10);
const _SCALP_MAX_TRADES  = parseInt(process.env.SCALP_MAX_DAILY_TRADES || "30", 10);
const _SCALP_MAX_LOSS    = parseFloat(process.env.SCALP_MAX_DAILY_LOSS || "2000");
const _SCALP_PAUSE_CANDLES = parseInt(process.env.SCALP_SL_PAUSE_CANDLES || "2", 10);

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

    if (pos.side === "CE" && price >= pos.target) {
      squareOff(pos.target, `Target hit (${_SCALP_TARGET_PTS}pt)`);
      return;
    }
    if (pos.side === "PE" && price <= pos.target) {
      squareOff(pos.target, `Target hit (${_SCALP_TARGET_PTS}pt)`);
      return;
    }
    if (pos.side === "CE" && price <= pos.stopLoss) {
      squareOff(pos.stopLoss, `SL hit (${_SCALP_SL_PTS}pt)`);
      return;
    }
    if (pos.side === "PE" && price >= pos.stopLoss) {
      squareOff(pos.stopLoss, `SL hit (${_SCALP_SL_PTS}pt)`);
      return;
    }

    // Trail
    if (pos.side === "CE") {
      if (!pos.bestPrice || price > pos.bestPrice) pos.bestPrice = price;
      const move = pos.bestPrice - pos.entryPrice;
      if (move >= _SCALP_TRAIL_AFTER) {
        const trailSL = pos.bestPrice - _SCALP_TRAIL_GAP;
        if (trailSL > pos.stopLoss) pos.stopLoss = trailSL;
        if (price <= pos.stopLoss) {
          squareOff(pos.stopLoss, `Trail SL (gap=${_SCALP_TRAIL_GAP}pt)`);
          return;
        }
      }
    } else {
      if (!pos.bestPrice || price < pos.bestPrice) pos.bestPrice = price;
      const move = pos.entryPrice - pos.bestPrice;
      if (move >= _SCALP_TRAIL_AFTER) {
        const trailSL = pos.bestPrice + _SCALP_TRAIL_GAP;
        if (trailSL < pos.stopLoss) pos.stopLoss = trailSL;
        if (price >= pos.stopLoss) {
          squareOff(pos.stopLoss, `Trail SL (gap=${_SCALP_TRAIL_GAP}pt)`);
          return;
        }
      }
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

    if (state.position.candlesHeld >= _SCALP_TIME_STOP) {
      squareOff(bar.close, `Time stop (${_SCALP_TIME_STOP} candles)`);
      return;
    }

    // RSI reversal
    const window = [...state.candles];
    if (state.currentBar) window.push(state.currentBar);
    if (window.length >= 15) {
      const result = scalpStrategy.getSignal(window, { silent: true });
      if (state.position.side === "CE" && result.rsi < 50) {
        squareOff(bar.close, `RSI reversal (RSI=${result.rsi} < 50)`);
        return;
      }
      if (state.position.side === "PE" && result.rsi > 50) {
        squareOff(bar.close, `RSI reversal (RSI=${result.rsi} > 50)`);
        return;
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

  // VIX
  if (vixFilter.VIX_ENABLED) {
    const vix = getCachedVix();
    if (vix) {
      const vixMax = parseFloat(process.env.VIX_MAX_ENTRY || "20");
      if (vix.value > vixMax) return;
    }
  }

  const window = [...state.candles];
  if (window.length < 15) return;

  const result = scalpStrategy.getSignal(window, { silent: false });
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
      optionEntryLtp:   null,
      optionCurrentLtp: null,
    };

    state.optionSymbol = symbol;
    if (instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES") {
      startOptionPolling(symbol);
    }

    log(`📝 [SCALP-LIVE] BUY ${qty} × ${symbol} @ ₹${spot} | SL: ₹${result.stopLoss} | TGT: ₹${result.target}`);

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

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/scalp/status");

  const check = sharedSocketState.canStart("SCALP_LIVE");
  if (!check.allowed) {
    return res.status(409).send(`<p>${check.reason}</p><a href="/scalp/status">\u2190 Back</a>`);
  }

  if (!process.env.ACCESS_TOKEN) {
    return res.status(401).send(`<p>Fyers not authenticated</p><a href="/auth">Login</a>`);
  }

  if (!fyersBroker.isAuthenticated()) {
    return res.status(401).send(`<p>Fyers not authenticated for orders</p><a href="/auth">Login</a>`);
  }

  if (process.env.SCALP_ENABLED !== "true") {
    return res.status(400).send(`<p>SCALP_ENABLED is not true in settings. Enable it first.</p><a href="/settings">Settings</a>`);
  }

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) {
    return res.status(400).send(`<p>${holiday.reason}</p>`);
  }

  if (!isStartAllowed()) {
    return res.status(400).send(`<p>Past stop time</p>`);
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

  if (vixFilter.VIX_ENABLED) {
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

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Scalp Live — ${scalpStrategy.NAME}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u26a1</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
${sidebarCSS()}
${modalCSS()}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'IBM Plex Sans',sans-serif;background:#060810;color:#c0d0e8;min-height:100vh;display:flex;flex-direction:column;}
.main-content{flex:1;padding:28px 32px;margin-left:220px;}
@media(max-width:900px){.main-content{margin-left:0;padding:16px;}}
h1{font-size:1.2rem;font-weight:700;color:#e0eaf8;margin-bottom:4px;}
.subtitle{font-size:0.7rem;color:#5a7090;margin-bottom:16px;}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px;}
.stat{background:#0d1320;border:1px solid #1a2236;border-radius:10px;padding:12px 14px;}
.stat-label{font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;}
.stat-value{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
.log-box{background:#0a0e18;border:1px solid #1a2236;border-radius:10px;padding:12px;font-family:'IBM Plex Mono',monospace;font-size:0.65rem;color:#6a8aaa;max-height:300px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;}
.pos-box{background:#0d1320;border:1px solid #1a2236;border-radius:10px;padding:14px;margin-bottom:14px;}
.action-btn{padding:8px 18px;border-radius:8px;border:none;font-weight:700;font-size:0.8rem;cursor:pointer;margin-right:8px;}
.start-btn{background:#1e40af;color:#fff;}.start-btn:hover{background:#2563eb;}
.stop-btn{background:#7f1d1d;color:#fff;}.stop-btn:hover{background:#991b1b;}
.exit-btn{background:#78350f;color:#fff;}.exit-btn:hover{background:#92400e;}
.live-badge{display:inline-block;background:#7f1d1d;color:#fca5a5;padding:2px 8px;border-radius:6px;font-size:0.65rem;font-weight:700;margin-left:8px;}
</style></head><body>
<div class="app-shell">
${buildSidebar('scalpLive', liveActive, state.running)}
<div class="main-content">
<h1>\u26a1 Scalp Live Trade <span class="live-badge">REAL ORDERS</span></h1>
<div class="subtitle">${scalpStrategy.NAME} | ${SCALP_RES}-min | Fyers Orders | SL: ${_SCALP_SL_PTS}pt | TGT: ${_SCALP_TARGET_PTS}pt</div>

<div style="margin-bottom:14px;">
${state.running
  ? `<button class="action-btn stop-btn" onclick="if(confirm('Stop scalp live trading?'))location='/scalp/stop'">■ Stop</button>
     <button class="action-btn exit-btn" onclick="if(confirm('Exit current position?'))location='/scalp/exit'">🚪 Exit Trade</button>`
  : `<button class="action-btn start-btn" onclick="if(confirm('Start SCALP LIVE trading with REAL Fyers orders?'))location='/scalp/start'">▶ Start Scalp Live</button>`}
</div>

<div id="stats" class="stats"></div>
<div id="position" class="pos-box" style="display:none;"></div>
<div id="logBox" class="log-box"></div>
</div></div>
<script>
${modalJS()}
function poll(){
  fetch('/scalp/status/data').then(r=>r.json()).then(d=>{
    const pnlColor = d.totalPnl >= 0 ? '#10b981' : '#ef4444';
    document.getElementById('stats').innerHTML =
      '<div class="stat"><div class="stat-label">Status</div><div class="stat-value">'+(d.running?'\u26a1 LIVE':'🔴 STOPPED')+'</div></div>'+
      '<div class="stat"><div class="stat-label">NIFTY Spot</div><div class="stat-value">\u20b9'+(d.lastTickPrice||'-')+'</div></div>'+
      '<div class="stat"><div class="stat-label">Candles</div><div class="stat-value">'+d.candleCount+'</div></div>'+
      '<div class="stat"><div class="stat-label">Trades</div><div class="stat-value">'+d.trades+' ('+d.wins+'W/'+d.losses+'L)</div></div>'+
      '<div class="stat"><div class="stat-label">Session PnL</div><div class="stat-value" style="color:'+pnlColor+'">\u20b9'+d.totalPnl+'</div></div>'+
      '<div class="stat"><div class="stat-label">Ticks</div><div class="stat-value">'+d.tickCount+'</div></div>';
    const posEl = document.getElementById('position');
    if(d.position){
      const sc = d.position.side==='CE'?'#10b981':'#ef4444';
      posEl.style.display='block';
      posEl.innerHTML='<b style="color:'+sc+'">'+d.position.side+'</b> @ \u20b9'+d.position.entryPrice+
        ' | SL: \u20b9'+d.position.stopLoss+' | TGT: \u20b9'+d.position.target+
        ' | Best: \u20b9'+(d.position.bestPrice||'-')+' | Candles: '+d.position.candlesHeld+
        ' | Unrealised: <b style="color:'+(d.unrealised>=0?'#10b981':'#ef4444')+'">\u20b9'+d.unrealised+'</b>';
    } else { posEl.style.display='none'; }
    const logEl = document.getElementById('logBox');
    logEl.textContent = (d.log||[]).join('\\n');
    logEl.scrollTop = logEl.scrollHeight;
  }).catch(()=>{});
}
poll(); setInterval(poll, 2000);
</script>
</body></html>`);
});

module.exports = router;

/**
 * SCALP PAPER TRADE — /scalp-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses LIVE market data (Fyers WebSocket) but SIMULATES orders locally.
 * Runs on 3-min candles with the scalp BB+RSI+PSAR strategy.
 * Can run IN PARALLEL with /trade (live) or /swing-paper (paper).
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
const { BollingerBands } = require("technicalindicators");
const instrumentConfig = require("../config/instrument");
const { getSymbol, getLotQty, validateAndGetOptionSymbol } = instrumentConfig;
const sharedSocketState = require("../utils/sharedSocketState");
const socketManager = require("../utils/socketManager");
const { buildSidebar, sidebarCSS, modalCSS, modalJS, errorPage } = require("../utils/sharedNav");
const { isTradingAllowed } = require("../utils/nseHolidays");
const { reverseSlice, formatISTTimestamp, getISTMinutes: _getISTMinutesReal, getBucketStart: _getBucketStartRaw, parseOptionDetails, parseTimeToMinutes, parseTrailTiers } = require("../utils/tradeUtils");
const vixFilter = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const fyers = require("../config/fyers");
const { notifyEntry, notifyExit, sendTelegram, isConfigured } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const tickSimulator = require("../services/tickSimulator");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID = "SCALP_PAPER";

// ── Module-level config (read once at module load) ────────────────────────────
const SCALP_RES            = parseInt(process.env.SCALP_RESOLUTION || "5", 10);
const _SCALP_MAX_TRADES    = parseInt(process.env.SCALP_MAX_DAILY_TRADES || "30", 10);
const _SCALP_MAX_LOSS      = parseFloat(process.env.SCALP_MAX_DAILY_LOSS || "2000");
const _SCALP_PAUSE_CANDLES = parseInt(process.env.SCALP_SL_PAUSE_CANDLES || "2", 10);
const _SCALP_TRAIL_START   = parseFloat(process.env.SCALP_TRAIL_START || "350");
const _SCALP_TRAIL_PCT     = parseFloat(process.env.SCALP_TRAIL_PCT || "65");
const _SCALP_TRAIL_TIERS = parseTrailTiers(process.env.SCALP_TRAIL_TIERS || "500:55,1000:60,3000:70,5000:80,10000:90");

// ── Previous day OHLC for CPR (fetched on session start) ────────────────────
let _prevDayOHLC     = null;  // { high, low, close }
let _prevPrevDayOHLC = null;  // for Inside Value CPR check

const _STOP_MINS       = parseTimeToMinutes(process.env.TRADE_STOP_TIME, "15:30");
const _ENTRY_STOP_MINS = parseTimeToMinutes(process.env.SCALP_ENTRY_END, "14:30");

function getISTMinutes() {
  if (state._simMode) return _SCALP_START_MINS + 5; // always "in market hours" during simulation
  return _getISTMinutesReal();
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
          log(`✅ [SCALP-PAPER] Rate limit cleared — polling resumed`);
          _rateLimitBackoff = 0;
        }
        return parseFloat(ltp);
      }
      log(`⚠️ [SCALP-PAPER] fetchOptionLtp no LTP in response for ${symbol}: ${JSON.stringify(v).slice(0, 200)}`);
    } else {
      log(`⚠️ [SCALP-PAPER] fetchOptionLtp bad response for ${symbol}: s=${response?.s}, d.length=${response?.d?.length}`);
    }
  } catch (err) {
    const msg = err.message || "";
    if (/limit|throttle|429/i.test(msg)) {
      if (_rateLimitBackoff === 0) {
        log(`⚠️ [SCALP-PAPER] Rate limit hit — backing off to 2s polls; trail falls back to spot-proxy if stale`);
      }
      _rateLimitBackoff = Math.min(_rateLimitBackoff + 1, 10);
    } else {
      log(`⚠️ [SCALP-PAPER] fetchOptionLtp error for ${symbol}: ${msg}`);
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
          log(`📌 [SCALP-PAPER] Option entry LTP: ₹${ltp}`);
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

function simulateBuy(symbol, side, qty, price, reason, stopLoss, target, spotAtEntry, slSource) {
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
    slSource:         slSource || "PSAR",
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
  if (!state._simMode && instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES") {
    startOptionPolling(symbol);
  }

  log(`📝 [SCALP-PAPER] BUY ${qty} × ${symbol} @ ₹${price} | SL: ₹${stopLoss} | ${reason}`);

  if (state._simMode) return; // skip Telegram in sim mode

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
    entryBarTime: state.position.entryBarTime || (state.currentBar ? state.currentBar.time : null),
    exitBarTime:  state.currentBar ? state.currentBar.time : null,
  });

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
    const extraPause = parseInt(process.env.SCALP_CONSEC_SL_EXTRA_PAUSE || "2", 10);
    const pauseCandles = state._consecSLs >= 2
      ? _SCALP_PAUSE_CANDLES + extraPause * (state._consecSLs - 1)
      : _SCALP_PAUSE_CANDLES;
    state._slPauseUntil = simNow() + (pauseCandles * SCALP_RES * 60 * 1000);
    const escalateNote = state._consecSLs >= 2 ? ` (${state._consecSLs} consecutive SLs → ${pauseCandles} candles)` : "";
    log(`⏸️ [SCALP-PAPER] SL pause — no entries for ${pauseCandles} candles${escalateNote}`);
  } else if (netPnl > 0) {
    state._consecSLs = 0; // Reset on a winning trade
  }

  // Daily loss kill
  if (state.sessionPnl <= -_SCALP_MAX_LOSS) {
    state._dailyLossHit = true;
    log(`🚨 [SCALP-PAPER] Daily loss limit hit (₹${state.sessionPnl} <= -₹${_SCALP_MAX_LOSS}) — no more entries today`);
  }

  state.position = null;

  if (!state._simMode) {
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
  if (state._simMode) _simClockMs += (SCALP_RES * 60 * 1000) / 20;

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
      onCandleClose(state.currentBar).catch(e => console.error(`🚨 [SCALP-PAPER] onCandleClose error: ${e.message}`));
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

    // 1. SL hit (Prev Candle initial, PSAR trailing)
    if (pos.side === "CE" && price <= pos.stopLoss) {
      const _isTrail = Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
      const _src = pos.slSource || "PSAR";
      simulateSell(pos.stopLoss, _isTrail ? `${_src} Trail SL hit` : `${_src} SL hit`, price);
      return;
    }
    if (pos.side === "PE" && price >= pos.stopLoss) {
      const _isTrail = Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
      const _src = pos.slSource || "PSAR";
      simulateSell(pos.stopLoss, _isTrail ? `${_src} Trail SL hit` : `${_src} SL hit`, price);
      return;
    }

    // 2. TRAILING PROFIT — tiered % of peak: keep more as profit grows
    if (_SCALP_TRAIL_START > 0 && pos.peakPnl >= _SCALP_TRAIL_START) {
      let _pct = _SCALP_TRAIL_PCT;
      for (const tier of _SCALP_TRAIL_TIERS) {
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

    // Update trailing SL: min(prevCandle, PSAR) — tighten only, track source
    if (window.length >= 15) {
      const trailResult = scalpStrategy.updateTrailingSL(window, state.position.stopLoss, state.position.side);
      if (trailResult.sl !== state.position.stopLoss) {
        log(`📐 [SCALP-PAPER] Trail SL (${trailResult.source}): ₹${state.position.stopLoss} → ₹${trailResult.sl}`);
        state.position.stopLoss = trailResult.sl;
        if (trailResult.source) state.position.slSource = trailResult.source;
      }
    }

    return; // In position — don't look for new entry
  }

  // ── Entry evaluation ──────────────────────────────────────────────────────
  if (!state._simMode && !isMarketHours()) { log(`⏭️ [SCALP-PAPER] SKIP: outside market hours`); return; }
  if (state._dailyLossHit) { log(`⏭️ [SCALP-PAPER] SKIP: daily loss limit hit`); return; }
  if (state.sessionTrades.length >= _SCALP_MAX_TRADES) { log(`⏭️ [SCALP-PAPER] SKIP: max trades (${_SCALP_MAX_TRADES}) reached`); return; }
  if (state._slPauseUntil && simNow() < state._slPauseUntil) {
    const secsLeft = Math.ceil((state._slPauseUntil - simNow()) / 1000);
    log(`⏭️ [SCALP-PAPER] SKIP: SL cooldown (${secsLeft}s left)`);
    return;
  }
  if (state._expiryDayBlocked) { log(`⏭️ [SCALP-PAPER] SKIP: expiry-only mode, not expiry day`); return; }

  // VIX check — refresh on every candle close (cache TTL 60s) — skip in sim mode
  if (!state._simMode && process.env.SCALP_VIX_ENABLED === "true") {
    await fetchLiveVix({ force: false });
    const vix = getCachedVix();
    if (vix) {
      const vixMax = parseFloat(process.env.VIX_MAX_ENTRY || "20");
      if (vix > vixMax) {
        log(`⏭️ [SCALP-PAPER] SKIP: VIX ${vix.toFixed(1)} > max ${vixMax}`);
        return;
      }
    }
  }

  const window = [...state.candles];
  if (window.length < 30) { log(`⏭️ [SCALP-PAPER] SKIP: warming up (${window.length}/30 candles)`); return; }

  const result = scalpStrategy.getSignal(window, {
    silent: true,
    skipTimeCheck: state._simMode,
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
    let symbol;
    if (state._simMode) {
      // In simulation mode, use a dummy option symbol (no broker API needed)
      const strike = Math.round(spot / 50) * 50;
      symbol = `NSE:NIFTY-SIM-${strike}${side}`;
    } else {
      const optionInfo = await validateAndGetOptionSymbol(spot, side);
      if (optionInfo.invalid) {
        log(`⚠️ [SCALP-PAPER] Option symbol invalid for ${side} — skipping entry`);
        return;
      }
      symbol = optionInfo.symbol;
    }
    const qty = getLotQty();
    // Clamp SL distance to [MIN_SL_PTS, MAX_SL_PTS] — matches backtest logic
    const MAX_SL_PTS = parseFloat(process.env.SCALP_MAX_SL_PTS || "25");
    const MIN_SL_PTS = parseFloat(process.env.SCALP_MIN_SL_PTS || "8");
    const rawGap = Math.abs(spot - result.stopLoss);
    const slPts = Math.max(Math.min(rawGap, MAX_SL_PTS), MIN_SL_PTS);
    const clampedSL = parseFloat((spot + slPts * (side === "CE" ? -1 : 1)).toFixed(2));
    simulateBuy(symbol, side, qty, spot, result.reason, clampedSL, result.target, spot, result.slSource);
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
    // Fetch from 7 days ago to cover weekends + holidays (e.g., Thu trading → Mon start)
    const lookbackDate = new Date(Date.now() - 7 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached(
      NIFTY_INDEX_SYMBOL, String(SCALP_RES), lookbackDate, today,
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
  const nowMins = getISTMinutes();
  const ms = (_STOP_MINS - nowMins) * 60 * 1000;
  if (ms <= 0) return;
  _autoStopTimer = setTimeout(() => {
    if (!state.running) return;
    stopFn("⏰ [SCALP-PAPER] Auto-stop reached");
  }, ms);
  log(`⏰ [SCALP-PAPER] Auto-stop in ${Math.round(ms / 60000)} min`);
}

// errorPage imported from sharedNav (shared across all route files)
function _errorPage(title, message, linkHref, linkText) {
  return errorPage(title, message, linkHref, linkText, 'scalpPaper');
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/scalp-paper/status");

  const check = sharedSocketState.canStart("SCALP_PAPER");
  if (!check.allowed) {
    return res.status(409).send(_errorPage("Cannot Start", check.reason, "/scalp-paper/status", "\u2190 Back"));
  }

  if (!process.env.ACCESS_TOKEN) {
    return res.status(401).send(_errorPage("Not Authenticated", "Fyers not logged in. Login first.", "/auth", "Login with Fyers"));
  }

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) {
    return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/scalp-paper/status", "\u2190 Back"));
  }

  if (!isStartAllowed()) {
    return res.status(400).send(_errorPage("Session Closed", "Past stop time \u2014 cannot start today.", "/scalp-paper/status", "\u2190 Back"));
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
    sessionPnl: 0, _wins: 0, _losses: 0, tickCount: 0, lastTickTime: null, lastTickPrice: null,
    optionLtp: null, optionSymbol: null, _slPauseUntil: null, _dailyLossHit: false,
    _expiryDayBlocked: _expiryBlocked,
  };

  sharedSocketState.setScalpActive("SCALP_PAPER");

  // Pre-load history
  await preloadHistory();

  // Start VIX polling
  if (process.env.SCALP_VIX_ENABLED === "true") {
    resetVixCache();
    fetchLiveVix({ force: true }).catch(() => {});
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

  try {
    const optResult = await validateAndGetOptionSymbol(spot, side);
    const symbol = optResult.symbol;
    const qty = getLotQty();
    log(`🖐️ [SCALP-PAPER] MANUAL ENTRY ${side} @ spot ₹${spot} | SL: ₹${sl} (PrevCandle${prevCandle ? '=' + (side === 'CE' ? prevCandle.low : prevCandle.high) : ''})`);
    simulateBuy(symbol, side, qty, spot, `Manual ${side} entry`, sl, null, spot);
    return res.json({ success: true, spot, side, sl, symbol });
  } catch (e) {
    log(`❌ [SCALP-PAPER] Manual entry failed: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── Chart data for Lightweight Charts widget ────────────────────────────────
router.get("/status/chart-data", (req, res) => {
  try {
    const candles = state.candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.currentBar) candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });

    // BB overlay (same params as the strategy) — aligned with candles
    const BB_PERIOD = parseInt(process.env.SCALP_BB_PERIOD || "20", 10);
    const BB_STDDEV = parseFloat(process.env.SCALP_BB_STDDEV || "1");
    let bbUpper = [], bbMiddle = [], bbLower = [];
    if (candles.length >= BB_PERIOD) {
      const closes = candles.map(c => c.close);
      const bbArr = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes });
      const offset = candles.length - bbArr.length;
      for (let i = 0; i < bbArr.length; i++) {
        const t = candles[i + offset].time;
        bbUpper.push({ time: t, value: parseFloat(bbArr[i].upper.toFixed(2)) });
        bbMiddle.push({ time: t, value: parseFloat(bbArr[i].middle.toFixed(2)) });
        bbLower.push({ time: t, value: parseFloat(bbArr[i].lower.toFixed(2)) });
      }
    }

    const shortReason = (r) => {
      if (!r) return "";
      // Extract trigger compactly: "CE: BB↑ RSI 58" style
      const m = /RSI\s*[=:]?\s*(\d+)/i.exec(r);
      const rsiTxt = m ? " RSI " + m[1] : "";
      const side = /^CE/i.test(r) ? "CE BB↑" : /^PE/i.test(r) ? "PE BB↓" : "";
      return side + rsiTxt;
    };

    const markers = [];
    for (const t of state.sessionTrades) {
      if (t.entryPrice && t.entryBarTime) {
        const reasonTxt = shortReason(t.entryReason || "");
        const lbl = reasonTxt || (t.side + " @ " + t.entryPrice.toFixed(0));
        markers.push({ time: t.entryBarTime, position: 'belowBar', color: '#3b82f6', shape: 'arrowUp', text: lbl });
      }
      if (t.exitPrice && t.exitBarTime) { const w = t.pnl > 0; markers.push({ time: t.exitBarTime, position: 'aboveBar', color: w ? '#10b981' : '#ef4444', shape: 'arrowDown', text: 'Exit ' + (w ? '+' : '') + (t.pnl ? t.pnl.toFixed(0) : '') }); }
    }
    const stopLoss = state.position && state.position.stopLoss ? state.position.stopLoss : null;
    const entryPrice = state.position && state.position.entryPrice ? state.position.entryPrice : null;
    return res.json({ candles, markers, stopLoss, entryPrice, bbUpper, bbMiddle, bbLower });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Status data (AJAX poll) ─────────────────────────────────────────────────

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const data = loadScalpData();

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
  const data        = loadScalpData();

  // VIX details for top-bar display
  const _vix          = getCachedVix();
  const _vixEnabled   = process.env.SCALP_VIX_ENABLED === "true";
  const _vixMaxEntry  = vixFilter.VIX_MAX_ENTRY;
  const _vixStrongOnly = vixFilter.VIX_STRONG_ONLY;

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
<title>Scalp Paper \u2014 ${scalpStrategy.NAME}</title>
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
${buildSidebar('scalpPaper', liveActive, state.running)}
<div class="main-content">

<!-- Top bar -->
<div class="top-bar">
  <div>
    <div class="top-bar-title">Scalp Paper Trade</div>
    <div class="top-bar-meta">Strategy: ${scalpStrategy.NAME} \u00b7 ${SCALP_RES}-min candles \u00b7 SL: Prev Candle \u00b7 Trail ${_SCALP_TRAIL_PCT}%+ tiered from \u20b9${_SCALP_TRAIL_START} \u00b7 ${state.running ? 'Auto-refreshes every 2s' : 'Stopped'}</div>
  </div>
  <div class="top-bar-right">
    ${state.running
      ? `<span class="top-bar-badge badge-running"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>RUNNING</span>`
      : `<span class="top-bar-badge badge-stopped">IDLE</span>`}
    ${_vixEnabled ? `<span class="top-bar-badge" style="border-color:${_vix == null ? 'rgba(100,116,139,0.3)' : _vix > _vixMaxEntry ? 'rgba(239,68,68,0.3)' : _vix > _vixStrongOnly ? 'rgba(234,179,8,0.3)' : 'rgba(16,185,129,0.3)'};background:${_vix == null ? 'rgba(100,116,139,0.08)' : _vix > _vixMaxEntry ? 'rgba(239,68,68,0.1)' : _vix > _vixStrongOnly ? 'rgba(234,179,8,0.1)' : 'rgba(16,185,129,0.1)'};color:${_vix == null ? '#94a3b8' : _vix > _vixMaxEntry ? '#ef4444' : _vix > _vixStrongOnly ? '#eab308' : '#10b981'};">VIX ${_vix != null ? _vix.toFixed(1) : 'n/a'}${_vix != null ? (_vix > _vixMaxEntry ? ' \u00b7 BLOCKED' : _vix > _vixStrongOnly ? ' \u00b7 STRONG ONLY' : ' \u00b7 NORMAL') : ''}</span>` : ''}
    ${state.running
      ? `<button onclick="location='/scalp-paper/stop'" style="background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;padding:5px 14px;border-radius:6px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;">Stop Session</button>`
      : `<button onclick="location='/scalp-paper/start'" style="background:#1e40af;border:1px solid #3b82f6;color:#fff;padding:5px 14px;border-radius:6px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;">Start Scalp Paper</button>`}
    <button onclick="spHandleReset(this)" style="background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;">↺ Reset</button>
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

${process.env.CHART_ENABLED !== "false" ? `<!-- NIFTY Chart -->
<div style="margin-bottom:18px;">
  <div class="section-title">NIFTY ${SCALP_RES}-Min Chart</div>
  <div id="sp-sel-banner" style="display:none;align-items:center;gap:10px;background:#0a1e3d;border:1px solid #1d3b6e;border-radius:8px;padding:6px 12px;margin-bottom:8px;font-size:0.72rem;"></div>
  <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
    <div id="nifty-chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
      <span style="color:#3b82f6;">▲ Entry</span> &nbsp;<span style="color:#10b981;">▼ Win</span> &nbsp;<span style="color:#ef4444;">▼ Loss</span> &nbsp;<span style="color:#4a9cf5;">── BB U/L</span> &nbsp;<span style="color:#94a3b8;">-- BB Mid</span> &nbsp;<span style="color:#f59e0b;">── SL</span> &nbsp;<span style="color:#3b82f6;">-- Entry</span>
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

async function spHandleReset(btn) {
  if (!confirm('Reset ALL scalp paper trade history?\\nThis will wipe all sessions and restore starting capital.\\nCannot be undone.')) return;
  if (btn) { btn.textContent = '⏳...'; btn.disabled = true; }
  try {
    var res = await fetch('/scalp-paper/reset');
    var data;
    try { data = await res.json(); } catch(_) { data = { success: false, error: 'Server error (status ' + res.status + ')' }; }
    if (!data.success) {
      alert('Reset failed: ' + (data.error || 'Unknown error'));
      if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; }
      return;
    }
    alert('Reset successful! ' + data.message);
    location.reload();
  } catch(e) {
    alert('Reset error: ' + e.message);
    if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; }
  }
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
      var short = t.reason.length > 25 ? t.reason.slice(0,25)+'\\u2026' : t.reason;
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
        '<td style="padding:6px 8px;text-align:center;"><button data-idx="' + i + '" class="sp-eye-btn" style="background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;" title="View full details">View</button></td>' +
        '</tr>';
    }).join('');
    Array.from(document.querySelectorAll('.sp-eye-btn')).forEach(function(btn){
      btn.addEventListener('click',function(ev){ ev.stopPropagation(); showSPModal(window._spSlice[parseInt(this.getAttribute('data-idx'))]); });
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
  var bbU = chart.addLineSeries({ color:'rgba(74,156,245,0.7)', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var bbM = chart.addLineSeries({ color:'rgba(148,163,184,0.55)', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var bbL = chart.addLineSeries({ color:'rgba(74,156,245,0.7)', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var slLine = null, entryLine = null, selEntryLine = null, selSlLine = null, _lcc = 0;
  async function fetchChart() {
    try {
      var res = await fetch('/scalp-paper/status/chart-data', { cache: 'no-store' });
      if (!res.ok) return; var d = await res.json();
      if (!d.candles || !d.candles.length) return;
      if (Math.abs(d.candles.length - _lcc) > 1 || _lcc === 0) {
        cs.setData(d.candles.map(function(c) { return { time:c.time, open:c.open, high:c.high, low:c.low, close:c.close }; }));
      } else { var l = d.candles[d.candles.length-1]; cs.update({ time:l.time, open:l.open, high:l.high, low:l.low, close:l.close }); }
      _lcc = d.candles.length;
      if (d.bbUpper && d.bbUpper.length) { bbU.setData(d.bbUpper); bbM.setData(d.bbMiddle || []); bbL.setData(d.bbLower || []); }
      else { bbU.setData([]); bbM.setData([]); bbL.setData([]); }
      var selEt = window._spSelEt || null;
      var allMarkers = (d.markers || []).slice();
      var markers = allMarkers;
      if (selEt) {
        var sel = (window._spSelectedTrade || {});
        var selXt = sel.xt || selEt;
        markers = allMarkers.filter(function(m) {
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
      if (selSlLine) { cs.removePriceLine(selSlLine); selSlLine = null; }
      if (selEntryLine) { cs.removePriceLine(selEntryLine); selEntryLine = null; }
      if (selEt && window._spSelectedTrade) {
        var st = window._spSelectedTrade;
        if (st.eSpot) selEntryLine = cs.createPriceLine({ price: st.eSpot, color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
        if (st.eSl)   selSlLine    = cs.createPriceLine({ price: st.eSl,   color:'#f59e0b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'SL' });
      }
    } catch(e) { console.warn('[Chart]', e.message); }
  }
  window._scFetchChart = fetchChart;
  window._scChart = chart;
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
  if (window._scFetchChart) window._scFetchChart();
  if (window._scChart) {
    var pad = 20 * 60;
    try { window._scChart.timeScale().setVisibleRange({ from: et - pad, to: (xt || et) + pad }); } catch(_) {}
  }
}
function spClearSelection() {
  window._spSelEt = null; window._spSelectedTrade = null;
  if (typeof spRender === 'function') spRender();
  spUpdateBanner();
  if (window._scFetchChart) window._scFetchChart();
  if (window._scChart) { try { window._scChart.timeScale().fitContent(); } catch(_) {} }
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

// ── Scalp Paper History ─────────────────────────────────────────────────────

function getScalpCapitalFromEnv() {
  const v = parseFloat(process.env.SCALP_PAPER_CAPITAL);
  return isNaN(v) ? 100000 : v;
}

router.get("/history", (req, res) => {
  const data = loadScalpData();
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";

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
        const actualIdx = data.sessions.length - 1 - idx; // 0-based index in original array
        const trades = s.trades || [];
        const sessionWins   = trades.filter(t => t.pnl > 0).length;
        const sessionLosses = trades.filter(t => t.pnl < 0).length;
        const winRate = trades.length ? ((sessionWins / trades.length) * 100).toFixed(1) + "%" : "—";

        const tradeRows = trades.map(t => {
          const badgeCls = t.side === "CE" ? "badge-ce" : "badge-pe";
          const entrySpot = inr(t.spotAtEntry || t.entryPrice);
          const exitSpot = inr(t.spotAtExit || t.exitPrice);
          const pnlStr = `<span style="font-weight:800;color:${pnlColor(t.pnl)};">${t.pnl >= 0 ? "+" : ""}${inr(t.pnl)}</span>`;
          const entryDate = t.entryTime ? t.entryTime.split(', ')[0] : '\u2014';
          const entryTimeOnly = t.entryTime ? (t.entryTime.split(', ')[1] || '\u2014') : '\u2014';
          const exitTimeOnly = t.exitTime ? (t.exitTime.split(', ')[1] || '\u2014') : '\u2014';
          const entryReasonShort = (t.entryReason||'\u2014').substring(0,25) + ((t.entryReason||'').length>25?'\u2026':'');
          const exitReasonShort = (t.exitReason||'\u2014').substring(0,25) + ((t.exitReason||'').length>25?'\u2026':'');
          return `<tr>
            <td><span class="badge ${badgeCls}">${t.side}</span></td>
            <td style="color:#c8d8f0;font-size:0.75rem;">${entryDate}</td>
            <td style="color:#c8d8f0;">${entrySpot}</td>
            <td style="color:#c8d8f0;font-size:0.75rem;">${entryTimeOnly}</td>
            <td style="color:#c8d8f0;">${exitSpot}</td>
            <td style="color:#c8d8f0;font-size:0.75rem;">${exitTimeOnly}</td>
            <td style="color:#f59e0b;">${t.stopLoss ? inr(parseFloat(t.stopLoss)) : '\u2014'}</td>
            <td>${pnlStr}</td>
            <td style="font-size:0.7rem;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${t.entryReason||''}">${entryReasonShort}</td>
            <td style="font-size:0.7rem;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${t.exitReason||''}">${exitReasonShort}</td>
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
                <th>Side</th><th>Date</th><th>Entry</th><th>Entry Time</th><th>Exit</th><th>Exit Time</th><th>SL</th><th>PnL</th><th>Entry Reason</th><th>Exit Reason</th>
              </tr></thead>
              <tbody>${tradeRows}</tbody>
            </table></div>
          </div>` : `<div style="padding:14px 20px;color:#4a6080;font-size:0.82rem;">No trades in this session.</div>`}
          <div style="display:flex;align-items:center;gap:8px;padding:10px 20px;border-top:0.5px solid #0e1e36;">
            <button class="copy-btn" onclick="event.stopPropagation();copySessionLog(this,${actualIdx})">📋 Copy Trade Log</button>
            <button class="reset-btn" onclick="event.stopPropagation();deleteSession(${actualIdx}, 'Session ${sIdx} (${s.date})')">🗑 Delete Session</button>
          </div>
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
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
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
    .copy-btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;transition:all 0.15s;white-space:nowrap;}
    .copy-btn:hover{background:#0a1e3d;border-color:#3b82f6;}
    .copy-btn.copied{background:#064e3b;border-color:#10b981;color:#10b981;}
    .dw-toggle{background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;transition:all 0.15s;}.dw-toggle:hover{border-color:#3b82f6;background:#0a1e3d;}.dw-toggle.active{background:#0a1e3d;border-color:#3b82f6;}
    .ana-panel{margin-bottom:16px;}
    .ana-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
    @media(max-width:900px){.ana-row{grid-template-columns:1fr;}}
    .ana-card{background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:14px 16px;position:relative;}
    .ana-card h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
    .ana-chart-wrap{position:relative;height:220px;}
    .ana-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;}
    @media(max-width:900px){.ana-row3{grid-template-columns:1fr;}}
    .ana-mini{background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:12px 14px;}
    .ana-mini h3{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:8px;font-family:'IBM Plex Mono',monospace;}
    .ana-tbl{width:100%;border-collapse:collapse;}
    .ana-tbl th{text-align:left;font-size:0.55rem;text-transform:uppercase;letter-spacing:0.8px;color:#1e3050;padding:5px 8px;border-bottom:0.5px solid #0e1428;font-family:'IBM Plex Mono',monospace;}
    .ana-tbl td{padding:5px 8px;font-size:0.72rem;font-family:'IBM Plex Mono',monospace;color:#4a6080;border-bottom:0.5px solid #060a14;}
    .ana-tbl tr:hover{background:#060c1a;}
    .ana-stat{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;}
    .ana-stat-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
    .ana-stat-label{font-size:0.62rem;color:#3a5070;}
    .tbar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#07111f;border:0.5px solid #0e1e36;border-radius:8px;margin-bottom:10px;flex-wrap:wrap;}
    .tbar-label{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.5px;color:#3a5070;font-weight:700;font-family:'IBM Plex Mono',monospace;}
    .tbar-count{font-size:0.68rem;color:#4a6080;}
    @media print {
      .sidebar, .hamburger, .sidebar-overlay, .top-bar, .export-btn, .reset-btn, .copy-btn, .dw-toggle, .ana-panel, #dayWiseWrap, .tbar { display: none !important; }
      .main-content { margin-left: 0 !important; }
      body { background: #fff !important; color: #000 !important; }
      .session-card { background: #fff !important; border: 1px solid #ccc !important; break-inside: avoid; }
      .tbl td, .tbl th { color: #000 !important; border-color: #ddd !important; }
    }
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
      <button id="dwToggle" class="dw-toggle" onclick="toggleDayWise()" title="Day-wise P&L summary">👁 Day P&L</button>
      <button id="anaToggle" class="dw-toggle" onclick="toggleAnalytics()" title="Performance Analytics">📊 Analytics</button>
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

    <!-- Day View (toggleable) -->
    <div id="dayWiseWrap" style="display:none;margin-bottom:16px;">
      <div class="tbar">
        <span class="tbar-label">Day View</span>
        <span class="tbar-count" id="dayCntLabel"></span>
        <button class="copy-btn" onclick="copyDayView(this)" style="margin-left:auto;">📋 Copy Day View</button>
      </div>
      <div style="overflow-x:auto;">
        <table class="tbl">
          <thead><tr>
            <th>Date</th><th>Trades</th><th>Wins</th><th>Losses</th><th>PnL</th><th>Cumulative PnL</th>
          </tr></thead>
          <tbody id="dayBody"></tbody>
        </table>
      </div>
    </div>

    <!-- Analytics Panel -->
    <div id="anaWrap" style="display:none;margin-bottom:16px;" class="ana-panel">
      <div class="ana-row">
        <div class="ana-card"><h3>📈 Equity Curve</h3><div class="ana-chart-wrap"><canvas id="anaEquity"></canvas></div></div>
        <div class="ana-card"><h3>📊 Monthly P&L</h3><div class="ana-chart-wrap"><canvas id="anaMonthly"></canvas></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-card"><h3>📉 Drawdown</h3><div class="ana-chart-wrap"><canvas id="anaDrawdown"></canvas></div></div>
        <div class="ana-card"><h3>⏰ Hourly Performance</h3><div class="ana-chart-wrap"><canvas id="anaHourly"></canvas></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>🔥 Win/Loss Streaks</h3><div id="anaStreaks"></div></div>
        <div class="ana-mini"><h3>📥 Entry Reason Breakdown</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Count</th><th>Wins</th><th>Losses</th><th>WR%</th><th>P&L</th><th>Avg</th></tr></thead><tbody id="anaEntryBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🚪 Exit Reason Breakdown</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Count</th><th>P&L</th><th>Avg</th></tr></thead><tbody id="anaExitBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📅 Day of Week</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Day</th><th>Trades</th><th>WR%</th><th>P&L</th><th>Avg</th></tr></thead><tbody id="anaDowBody"></tbody></table></div></div>
      </div>
      <div style="border-top:0.5px solid #0e1428;margin:16px 0 12px;padding-top:12px;">
        <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:1.5px;color:#ef4444;font-weight:700;margin-bottom:12px;font-family:'IBM Plex Mono',monospace;">🔍 Loss Analysis</div>
      </div>
      <div class="ana-row">
        <div class="ana-card"><h3>📊 Loss Distribution</h3><div class="ana-chart-wrap"><canvas id="anaLossDist"></canvas></div></div>
        <div class="ana-card"><h3>🔀 CE vs PE Performance</h3><div class="ana-chart-wrap"><canvas id="anaSidePerf"></canvas></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>💀 Top 10 Worst Trades</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Side</th><th>P&L</th><th>Exit</th></tr></thead><tbody id="anaWorstBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🔥 Consecutive Loss Streaks</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Start</th><th>Trades</th><th>Total Loss</th><th>Avg Loss</th></tr></thead><tbody id="anaLossStreakBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📊 Risk Metrics</h3><div id="anaRiskMetrics"></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>📅 Worst Trading Days</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Trades</th><th>Day P&L</th><th>Losses</th><th>Worst Trade</th></tr></thead><tbody id="anaWorstDayBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🚪 Loss by Exit Reason</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Loss Count</th><th>Total Loss</th><th>Avg Loss</th><th>% of Losses</th></tr></thead><tbody id="anaLossReasonBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>⏰ Losing Hours</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Hour</th><th>Losses</th><th>Loss P&L</th><th>Avg Loss</th><th>Loss%</th></tr></thead><tbody id="anaLossHourBody"></tbody></table></div></div>
      </div>
    </div>

    <!-- Session cards -->
    <div class="section-title">Sessions — newest first</div>
    ${sessionCards}

  </div>
</div>
</div>

<script>${modalJS()}</script>
<script id="trades-data" type="application/json">${JSON.stringify(allTrades)}</script>
<script id="sessions-data" type="application/json">${JSON.stringify(data.sessions)}</script>
<script>
var ALL_TRADES_JSON = JSON.parse(document.getElementById('trades-data').textContent);
var ALL_SESSIONS_JSON = JSON.parse(document.getElementById('sessions-data').textContent);

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

async function confirmReset() {
  var ok = await showConfirm({
    icon: '🗑️',
    title: 'Reset All Scalp Paper History?',
    message: 'This will permanently delete all sessions, trades, and reset capital to ₹${startCap.toLocaleString("en-IN")}. This cannot be undone.',
    confirmText: 'Yes, Reset Everything',
    confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  try {
    var r = await secretFetch('/scalp-paper/reset');
    if (!r) return;
    var d;
    try { d = await r.json(); } catch(_) { d = { success: false, error: 'Server error' }; }
    if (d.success) { window.location.reload(); }
    else { showAlert({icon:'⚠️',title:'Error',message:d.error||'Reset failed',btnClass:'modal-btn-primary'}); }
  } catch(e) { showAlert({icon:'⚠️',title:'Error',message:'Network error: ' + e.message,btnClass:'modal-btn-primary'}); }
}

async function deleteSession(idx, label) {
  var ok = await showConfirm({
    icon: '🗑️',
    title: 'Delete ' + label + '?',
    message: 'This will permanently delete this session and all its trades. Capital and P&L will be recalculated. This cannot be undone.',
    confirmText: 'Yes, Delete',
    confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  try {
    var r = await secretFetch('/scalp-paper/session/' + idx, { method: 'DELETE' });
    if (!r) return;
    var d;
    try { d = await r.json(); } catch(_) { d = { success: false, error: 'Server error' }; }
    if (d.success) { window.location.reload(); }
    else { showAlert({icon:'⚠️',title:'Error',message:d.error||'Delete failed',btnClass:'modal-btn-primary'}); }
  } catch(e) { showAlert({icon:'⚠️',title:'Error',message:'Network error: ' + e.message,btnClass:'modal-btn-primary'}); }
}

function copySessionLog(btn, idx) {
  var session = ALL_SESSIONS_JSON[idx];
  if (!session || !session.trades || !session.trades.length) {
    showAlert({icon:'⚠️',title:'No Data',message:'No trades in this session to copy',btnClass:'modal-btn-primary'});
    return;
  }
  var lines = ['Side\\tDate\\tEntry\\tEntry Time\\tExit\\tExit Time\\tSL\\tPnL\\tEntry Reason\\tExit Reason'];
  session.trades.forEach(function(t) {
    var eDate = t.entryTime ? t.entryTime.split(', ')[0] : '';
    var eTime = t.entryTime ? (t.entryTime.split(', ')[1]||'') : '';
    var xTime = t.exitTime ? (t.exitTime.split(', ')[1]||'') : '';
    lines.push((t.side||'')+'\\t'+eDate+'\\t'+(t.spotAtEntry||t.entryPrice||'')+'\\t'+eTime+'\\t'+(t.spotAtExit||t.exitPrice||'')+'\\t'+xTime+'\\t'+(t.stopLoss||'')+'\\t'+(t.pnl!=null?t.pnl.toFixed(2):'')+'\\t'+(t.entryReason||'')+'\\t'+(t.exitReason||''));
  });
  doCopy(lines.join('\\n'), btn, 'Trade Log');
}

// ── Copy & Analytics Functions ────────────────────────────────────────────
var INR_FMT = function(n){ return typeof n==='number' ? '\\u20b9'+Math.abs(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '\\u2014'; };
function fmtAna(v){ return '\\u20b9'+Math.round(Math.abs(v)).toLocaleString('en-IN'); }
function fmtAnaShort(v){ return Math.abs(v)>=1000 ? '\\u20b9'+Math.round(v/1000)+'k' : '\\u20b9'+Math.round(v); }

function copyTradeLog(btn){
  var lines=['Side\\tDate\\tEntry\\tEntry Time\\tExit\\tExit Time\\tSL\\tPnL\\tEntry Reason\\tExit Reason'];
  ALL_TRADES_JSON.forEach(function(t){
    var eDate = t.entryTime ? t.entryTime.split(', ')[0] : '';
    var eTime = t.entryTime ? (t.entryTime.split(', ')[1]||'') : '';
    var xTime = t.exitTime ? (t.exitTime.split(', ')[1]||'') : '';
    lines.push((t.side||'')+'\\t'+eDate+'\\t'+(t.spotAtEntry||t.entryPrice||'')+'\\t'+eTime+'\\t'+(t.spotAtExit||t.exitPrice||'')+'\\t'+xTime+'\\t'+(t.stopLoss||'')+'\\t'+(t.pnl!=null?t.pnl.toFixed(2):'')+'\\t'+(t.entryReason||'')+'\\t'+(t.exitReason||''));
  });
  doCopy(lines.join('\\n'),btn,'Trade Log');
}

function copyDayView(btn){
  var days=window._dayData||[];
  var lines=['Date\\tTrades\\tWins\\tLosses\\tPnL\\tCumulative PnL'];
  var cumPnl=0;
  days.forEach(function(dy){
    cumPnl+=dy.pnl;
    lines.push(dy.date+'\\t'+dy.trades+'\\t'+dy.wins+'\\t'+dy.losses+'\\t'+(dy.pnl!=null?dy.pnl.toFixed(2):'\\u2014')+'\\t'+cumPnl.toFixed(2));
  });
  doCopy(lines.join('\\n'),btn,'Day View');
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

// ── Day View ──────────────────────────────────────────────────────────────
var dwVisible = false;
function toggleDayWise(){
  dwVisible = !dwVisible;
  document.getElementById('dayWiseWrap').style.display = dwVisible ? 'block' : 'none';
  document.getElementById('dwToggle').classList.toggle('active', dwVisible);
  if(dwVisible) buildDayView();
}

function buildDayView(){
  var dayMap={};
  ALL_TRADES_JSON.forEach(function(t){
    var d = t.date || 'Unknown';
    if(!dayMap[d]) dayMap[d]={date:d,trades:0,wins:0,losses:0,pnl:0};
    dayMap[d].trades++;
    dayMap[d].pnl += (t.pnl||0);
    if(t.pnl > 0) dayMap[d].wins++; else if(t.pnl < 0) dayMap[d].losses++;
  });
  var days = Object.values(dayMap).sort(function(a,b){ return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  var cumPnl=0, rows='';
  for(var i=0;i<days.length;i++){
    var dy=days[i]; cumPnl+=dy.pnl;
    var pc=dy.pnl>=0?'#10b981':'#ef4444';
    var cc=cumPnl>=0?'#10b981':'#ef4444';
    rows+='<tr><td style="color:#c8d8f0;">'+dy.date+'</td><td>'+dy.trades+'</td>'
      +'<td style="color:#10b981;">'+dy.wins+'</td><td style="color:#ef4444;">'+dy.losses+'</td>'
      +'<td style="color:'+pc+';font-weight:700;">'+fmtAna(dy.pnl)+'</td>'
      +'<td style="color:'+cc+';font-weight:700;">'+fmtAna(cumPnl)+'</td></tr>';
  }
  document.getElementById('dayBody').innerHTML = rows || '<tr><td colspan="6" style="text-align:center;padding:20px;color:#4a6080;">No data.</td></tr>';
  document.getElementById('dayCntLabel').textContent = days.length+' days';
  window._dayData = days;
}

// ── Analytics Panel ───────────────────────────────────────────────────────
var anaVisible = false;
var anaCharts = {};

function spGetHour(t){
  var ts = t.entryTime || '';
  var m = ts.match(/(\\d{1,2}):(\\d{2})/);
  return m ? parseInt(m[1]) : 9;
}
function spGetDow(t){
  var d = t.date ? new Date(t.date) : new Date();
  return isNaN(d) ? 1 : d.getDay();
}
function spGetMonth(t){
  var d = t.date ? new Date(t.date) : null;
  if(!d || isNaN(d)) return '2025-01';
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
}
function spGetDateStr(t){ return t.date || 'Unknown'; }

function toggleAnalytics(){
  anaVisible = !anaVisible;
  document.getElementById('anaWrap').style.display = anaVisible ? 'block' : 'none';
  document.getElementById('anaToggle').classList.toggle('active', anaVisible);
  if(anaVisible) renderAnalytics();
}

function renderAnalytics(){
  var trades = ALL_TRADES_JSON.slice();
  if(!trades.length) return;
  var _gc = '#0e1428';
  var _tc = '#3a5070';

  // Equity Curve
  var cumPnl=[], labels=[], equity=0;
  trades.forEach(function(t,i){ equity+=(t.pnl||0); cumPnl.push(equity); labels.push(i+1); });
  if(anaCharts.equity) anaCharts.equity.destroy();
  anaCharts.equity = new Chart(document.getElementById('anaEquity'),{
    type:'line',data:{labels:labels,datasets:[{label:'Cumulative P&L',data:cumPnl,borderColor:'#3b82f6',borderWidth:1.5,backgroundColor:'rgba(59,130,246,0.08)',fill:true,pointRadius:0,tension:0.3}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return 'P&L: '+fmtAna(ctx.raw);}}}},scales:{x:{display:false},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}}}
  });

  // Monthly P&L
  var monthMap={};
  trades.forEach(function(t){ var key=spGetMonth(t); if(!monthMap[key])monthMap[key]=0; monthMap[key]+=(t.pnl||0); });
  var monthKeys=Object.keys(monthMap).sort();
  var monthLabels=monthKeys.map(function(k){ var p=k.split('-'); var mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return mn[parseInt(p[1])]+" '"+p[0].slice(2); });
  var monthVals=monthKeys.map(function(k){return Math.round(monthMap[k]);});
  var monthColors=monthVals.map(function(v){return v>=0?'#10b981':'#ef4444';});
  if(anaCharts.monthly) anaCharts.monthly.destroy();
  anaCharts.monthly = new Chart(document.getElementById('anaMonthly'),{
    type:'bar',data:{labels:monthLabels,datasets:[{data:monthVals,backgroundColor:monthColors,borderRadius:4,barPercentage:0.7}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return fmtAna(ctx.raw);}}}},scales:{x:{grid:{display:false},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'}}},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}}}
  });

  // Drawdown
  var eq2=0,peak=0,ddArr=[];
  trades.forEach(function(t){ eq2+=(t.pnl||0); if(eq2>peak)peak=eq2; ddArr.push(eq2-peak); });
  if(anaCharts.dd) anaCharts.dd.destroy();
  anaCharts.dd = new Chart(document.getElementById('anaDrawdown'),{
    type:'line',data:{labels:labels,datasets:[{label:'Drawdown',data:ddArr,borderColor:'#ef4444',borderWidth:1.5,backgroundColor:'rgba(239,68,68,0.12)',fill:true,pointRadius:0,tension:0.3}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return 'DD: '+fmtAna(ctx.raw);}}}},scales:{x:{display:false},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}}}
  });

  // Hourly Performance
  var hourMap={};
  trades.forEach(function(t){ var h=spGetHour(t); if(!hourMap[h])hourMap[h]={pnl:0,cnt:0,wins:0}; hourMap[h].pnl+=(t.pnl||0); hourMap[h].cnt++; if(t.pnl>0)hourMap[h].wins++; });
  var hours=Object.keys(hourMap).map(Number).sort(function(a,b){return a-b;});
  var hourLabels=hours.map(function(h){return h+':00';});
  var hourPnl=hours.map(function(h){return Math.round(hourMap[h].pnl);});
  var hourBarColors=hourPnl.map(function(v){return v>=0?'rgba(16,185,129,0.7)':'rgba(239,68,68,0.7)';});
  if(anaCharts.hourly) anaCharts.hourly.destroy();
  anaCharts.hourly = new Chart(document.getElementById('anaHourly'),{
    type:'bar',data:{labels:hourLabels,datasets:[{data:hourPnl,backgroundColor:hourBarColors,borderRadius:4,barPercentage:0.7}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:function(ctx){var h=hours[ctx[0].dataIndex];return h+':00 - '+(h+1)+':00 ('+hourMap[h].cnt+' trades, '+((hourMap[h].wins/hourMap[h].cnt)*100).toFixed(0)+'% WR)';},label:function(ctx){return fmtAna(ctx.raw);}}}},scales:{x:{grid:{display:false},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'}}},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}}}
  });

  // Win/Loss Streaks
  var maxWS=0,maxLS=0,curWS=0,curLS=0,avgWS=[],avgLS=[];
  trades.forEach(function(t){
    if(t.pnl>0){ curWS++; if(curLS>0)avgLS.push(curLS); curLS=0; if(curWS>maxWS)maxWS=curWS; }
    else if(t.pnl<0){ curLS++; if(curWS>0)avgWS.push(curWS); curWS=0; if(curLS>maxLS)maxLS=curLS; }
  });
  if(curWS>0)avgWS.push(curWS); if(curLS>0)avgLS.push(curLS);
  var avgW=avgWS.length>0?(avgWS.reduce(function(a,b){return a+b;},0)/avgWS.length).toFixed(1):'0';
  var avgL=avgLS.length>0?(avgLS.reduce(function(a,b){return a+b;},0)/avgLS.length).toFixed(1):'0';
  var dayPnlMap={};
  trades.forEach(function(t){ var d=spGetDateStr(t); if(!dayPnlMap[d])dayPnlMap[d]=0; dayPnlMap[d]+=(t.pnl||0); });
  var profDays=0,lossDays=0;
  Object.values(dayPnlMap).forEach(function(v){if(v>=0)profDays++;else lossDays++;});
  var totalDays=profDays+lossDays;
  document.getElementById('anaStreaks').innerHTML=
    '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+maxWS+'</span><span class="ana-stat-label">Best win streak</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+maxLS+'</span><span class="ana-stat-label">Worst loss streak</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#60a5fa;">'+avgW+'</span><span class="ana-stat-label">Avg win streak</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#f59e0b;">'+avgL+'</span><span class="ana-stat-label">Avg loss streak</span></div>'
    +'<div style="border-top:0.5px solid #0e1428;margin:8px 0;padding-top:8px;">'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+profDays+'</span><span class="ana-stat-label">Profitable days ('+(totalDays>0?((profDays/totalDays)*100).toFixed(0):'0')+'%)</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+lossDays+'</span><span class="ana-stat-label">Losing days ('+(totalDays>0?((lossDays/totalDays)*100).toFixed(0):'0')+'%)</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#c8d8f0;">'+fmtAna(totalDays>0?Object.values(dayPnlMap).reduce(function(a,b){return a+b;},0)/totalDays:0)+'</span><span class="ana-stat-label">Avg daily P&L</span></div>'
    +'</div>';

  // ── Entry Reason Breakdown ──
  var entryReasonMap={};
  trades.forEach(function(t){
    var r = t.entryReason || 'Unknown';
    if(r.length>50) r=r.substring(0,50)+'…';
    if(!entryReasonMap[r]) entryReasonMap[r]={cnt:0,wins:0,losses:0,pnl:0};
    entryReasonMap[r].cnt++;
    if(t.pnl>0) entryReasonMap[r].wins++;
    else if(t.pnl<0) entryReasonMap[r].losses++;
    entryReasonMap[r].pnl+=(t.pnl||0);
  });
  var entryReasons=Object.keys(entryReasonMap).sort(function(a,b){return entryReasonMap[b].cnt-entryReasonMap[a].cnt;});
  var entryHtml='';
  entryReasons.forEach(function(r){
    var d=entryReasonMap[r];
    var pc=d.pnl>=0?'#10b981':'#ef4444';
    var wr=d.cnt>0?((d.wins/d.cnt)*100).toFixed(0):'0';
    var avgPnl=d.cnt>0?Math.round(d.pnl/d.cnt):0;
    entryHtml+='<tr><td style="color:#c8d8f0;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+r+'">'+r+'</td><td>'+d.cnt+'</td>'
      +'<td style="color:#10b981;">'+d.wins+'</td><td style="color:#ef4444;">'+d.losses+'</td>'
      +'<td>'+wr+'%</td>'
      +'<td style="color:'+pc+';font-weight:700;">'+fmtAna(d.pnl)+'</td>'
      +'<td style="color:'+pc+';">'+fmtAna(avgPnl)+'</td></tr>';
  });
  document.getElementById('anaEntryBody').innerHTML=entryHtml;

  // Exit Reason Breakdown
  var reasonMap={};
  trades.forEach(function(t){ var r=t.exitReason||'Unknown'; if(!reasonMap[r])reasonMap[r]={cnt:0,pnl:0}; reasonMap[r].cnt++; reasonMap[r].pnl+=(t.pnl||0); });
  var reasons=Object.keys(reasonMap).sort(function(a,b){return reasonMap[b].pnl-reasonMap[a].pnl;});
  var exitHtml='';
  reasons.forEach(function(r){ var d=reasonMap[r]; var pc=d.pnl>=0?'#10b981':'#ef4444'; exitHtml+='<tr><td style="color:#c8d8f0;">'+r+'</td><td>'+d.cnt+'</td><td style="color:'+pc+';font-weight:700;">'+fmtAna(d.pnl)+'</td><td style="color:'+pc+';">'+fmtAna(Math.round(d.pnl/d.cnt))+'</td></tr>'; });
  document.getElementById('anaExitBody').innerHTML=exitHtml;

  // Day of Week
  var dowMap={0:{n:'Sun',t:0,w:0,p:0},1:{n:'Mon',t:0,w:0,p:0},2:{n:'Tue',t:0,w:0,p:0},3:{n:'Wed',t:0,w:0,p:0},4:{n:'Thu',t:0,w:0,p:0},5:{n:'Fri',t:0,w:0,p:0},6:{n:'Sat',t:0,w:0,p:0}};
  trades.forEach(function(t){ var dow=spGetDow(t); dowMap[dow].t++; if(t.pnl>0)dowMap[dow].w++; dowMap[dow].p+=(t.pnl||0); });
  var dowHtml='';
  [1,2,3,4,5].forEach(function(d){ var dd=dowMap[d]; if(dd.t===0)return; var wr=((dd.w/dd.t)*100).toFixed(0); var pc=dd.p>=0?'#10b981':'#ef4444'; dowHtml+='<tr><td style="color:#c8d8f0;font-weight:600;">'+dd.n+'</td><td>'+dd.t+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAna(dd.p)+'</td><td style="color:'+pc+';">'+fmtAna(Math.round(dd.p/dd.t))+'</td></tr>'; });
  document.getElementById('anaDowBody').innerHTML=dowHtml;

  // Loss Analysis
  var lossTrades=trades.filter(function(t){return t.pnl<0;});
  var winTrades=trades.filter(function(t){return t.pnl>0;});

  // Loss Distribution
  (function(){
    if(!lossTrades.length) return;
    var lossVals=lossTrades.map(function(t){return Math.abs(t.pnl);}).sort(function(a,b){return a-b;});
    var maxVal=lossVals[lossVals.length-1];
    var bucketCount=Math.min(12,Math.max(5,Math.ceil(Math.sqrt(lossVals.length))));
    var step=Math.ceil(maxVal/bucketCount/100)*100; if(step<1)step=1;
    var buckets=[],bucketLabels=[];
    for(var i=0;i<bucketCount;i++){buckets.push(0);bucketLabels.push(fmtAnaShort(i*step)+'-'+fmtAnaShort((i+1)*step));}
    lossVals.forEach(function(v){var idx=Math.min(Math.floor(v/step),bucketCount-1);buckets[idx]++;});
    if(anaCharts.lossDist) anaCharts.lossDist.destroy();
    anaCharts.lossDist = new Chart(document.getElementById('anaLossDist'),{
      type:'bar',data:{labels:bucketLabels,datasets:[{data:buckets,backgroundColor:'rgba(239,68,68,0.6)',borderRadius:4,barPercentage:0.85}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return ctx.raw+' trades ('+((ctx.raw/lossTrades.length)*100).toFixed(0)+'%)';}}}},scales:{x:{grid:{display:false},ticks:{color:_tc,font:{size:9,family:'IBM Plex Mono'},maxRotation:45}},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},stepSize:1}}}}
    });
  })();

  // CE vs PE Performance
  (function(){
    if(!trades.length) return;
    var sides={CE:{wins:0,losses:0,winPnl:0,lossPnl:0,total:0},PE:{wins:0,losses:0,winPnl:0,lossPnl:0,total:0}};
    trades.forEach(function(t){ var s=t.side||'CE'; if(!sides[s])return; sides[s].total++; if(t.pnl>0){sides[s].wins++;sides[s].winPnl+=t.pnl;} else if(t.pnl<0){sides[s].losses++;sides[s].lossPnl+=t.pnl;} });
    var sLabels=['CE','PE'];
    var sWinPnl=sLabels.map(function(s){return Math.round(sides[s].winPnl);});
    var sLossPnl=sLabels.map(function(s){return Math.round(sides[s].lossPnl);});
    var sNet=sLabels.map(function(s){return Math.round(sides[s].winPnl+sides[s].lossPnl);});
    if(anaCharts.sidePerf) anaCharts.sidePerf.destroy();
    anaCharts.sidePerf = new Chart(document.getElementById('anaSidePerf'),{
      type:'bar',data:{labels:sLabels.map(function(s){return s+' ('+sides[s].total+' trades, '+((sides[s].wins/Math.max(sides[s].total,1))*100).toFixed(0)+'% WR)';}),datasets:[
        {label:'Win P&L',data:sWinPnl,backgroundColor:'rgba(16,185,129,0.65)',borderRadius:4,barPercentage:0.6},
        {label:'Loss P&L',data:sLossPnl,backgroundColor:'rgba(239,68,68,0.65)',borderRadius:4,barPercentage:0.6},
        {label:'Net P&L',data:sNet,backgroundColor:sNet.map(function(v){return v>=0?'rgba(59,130,246,0.65)':'rgba(245,158,11,0.65)';}),borderRadius:4,barPercentage:0.6}
      ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:_tc,font:{size:9,family:'IBM Plex Mono'}}}},scales:{x:{grid:{display:false},ticks:{color:_tc,font:{size:9,family:'IBM Plex Mono'}}},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}}}
    });
  })();

  // Top 10 Worst Trades
  (function(){
    var worst=lossTrades.slice().sort(function(a,b){return a.pnl-b.pnl;}).slice(0,10);
    var html='';
    worst.forEach(function(t){ html+='<tr><td style="color:#c8d8f0;">'+spGetDateStr(t)+'</td><td style="color:'+(t.side==='CE'?'#10b981':'#ef4444')+';font-weight:700;">'+(t.side||'\\u2014')+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAna(t.pnl)+'</td><td style="font-size:0.65rem;">'+(t.exitReason||'\\u2014')+'</td></tr>'; });
    document.getElementById('anaWorstBody').innerHTML=html||'<tr><td colspan="4" style="text-align:center;color:#3a5070;">No losses</td></tr>';
  })();

  // Consecutive Loss Streaks
  (function(){
    var streaks=[],cur=[];
    trades.forEach(function(t,i){ if(t.pnl<0){cur.push({trade:t,idx:i});} else {if(cur.length>=2)streaks.push({items:cur.slice(),startIdx:cur[0].idx});cur=[];} });
    if(cur.length>=2)streaks.push({items:cur.slice(),startIdx:cur[0].idx});
    streaks.sort(function(a,b){ return a.items.reduce(function(s,c){return s+c.trade.pnl;},0)-b.items.reduce(function(s,c){return s+c.trade.pnl;},0); });
    var html='';
    streaks.slice(0,10).forEach(function(streak){
      var totalLoss=streak.items.reduce(function(s,c){return s+c.trade.pnl;},0);
      var avgLoss=totalLoss/streak.items.length;
      html+='<tr><td style="color:#c8d8f0;">'+spGetDateStr(streak.items[0].trade)+'</td><td>'+streak.items.length+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAna(totalLoss)+'</td><td style="color:#ef4444;">'+fmtAna(avgLoss)+'</td></tr>';
    });
    document.getElementById('anaLossStreakBody').innerHTML=html||'<tr><td colspan="4" style="text-align:center;color:#3a5070;">No consecutive loss streaks (2+)</td></tr>';
  })();

  // Risk Metrics
  (function(){
    var maxConsLoss=0,curCons=0;
    trades.forEach(function(t){if(t.pnl<0){curCons++;if(curCons>maxConsLoss)maxConsLoss=curCons;}else{curCons=0;}});
    var sortedPnl=trades.map(function(t){return t.pnl||0;}).sort(function(a,b){return a-b;});
    var p5Idx=Math.floor(sortedPnl.length*0.05);
    var p95Idx=Math.floor(sortedPnl.length*0.95);
    var p5=sortedPnl[p5Idx]||0;
    var p95=sortedPnl[p95Idx]||0;
    var grossProfit=winTrades.reduce(function(s,t){return s+t.pnl;},0);
    var grossLoss=lossTrades.reduce(function(s,t){return s+t.pnl;},0);
    var profitFactor=grossLoss!==0?(grossProfit/Math.abs(grossLoss)).toFixed(2):'\\u221e';
    var avgWinVal=winTrades.length>0?Math.round(grossProfit/winTrades.length):0;
    var avgLossVal=lossTrades.length>0?Math.round(grossLoss/lossTrades.length):0;
    var lossAfterLoss=0,totalAfterLoss=0;
    for(var i=1;i<trades.length;i++){if((trades[i-1].pnl||0)<0){totalAfterLoss++;if((trades[i].pnl||0)<0)lossAfterLoss++;}}
    var lossAfterLossPct=totalAfterLoss>0?((lossAfterLoss/totalAfterLoss)*100).toFixed(0):'\\u2014';
    document.getElementById('anaRiskMetrics').innerHTML=
      '<div class="ana-stat"><span class="ana-stat-val" style="color:'+(parseFloat(profitFactor)>=1.5?'#10b981':parseFloat(profitFactor)>=1?'#f59e0b':'#ef4444')+';">'+profitFactor+'</span><span class="ana-stat-label">Profit Factor</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+fmtAna(avgWinVal)+'</span><span class="ana-stat-label">Avg Win</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+fmtAna(avgLossVal)+'</span><span class="ana-stat-label">Avg Loss</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+maxConsLoss+'</span><span class="ana-stat-label">Max consecutive losses</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:'+(parseFloat(lossAfterLossPct)>=50?'#ef4444':'#10b981')+';">'+lossAfterLossPct+'%</span><span class="ana-stat-label">Loss after loss probability</span></div>'
      +'<div style="border-top:0.5px solid #0e1428;margin:8px 0;padding-top:8px;">'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+fmtAna(Math.abs(p5))+'</span><span class="ana-stat-label">5th percentile (worst case)</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+fmtAna(p95)+'</span><span class="ana-stat-label">95th percentile (best case)</span></div>'
      +'</div>';
  })();

  // Worst Trading Days
  (function(){
    var dayTrades={};
    trades.forEach(function(t){ var d=spGetDateStr(t); if(!dayTrades[d])dayTrades[d]={trades:[],pnl:0,losses:0,worstTrade:0}; dayTrades[d].trades.push(t); dayTrades[d].pnl+=(t.pnl||0); if(t.pnl<0)dayTrades[d].losses++; if(t.pnl<dayTrades[d].worstTrade)dayTrades[d].worstTrade=t.pnl; });
    var days=Object.keys(dayTrades).filter(function(d){return dayTrades[d].pnl<0;});
    days.sort(function(a,b){return dayTrades[a].pnl-dayTrades[b].pnl;});
    var html='';
    days.slice(0,10).forEach(function(d){ var dd=dayTrades[d]; html+='<tr><td style="color:#c8d8f0;">'+d+'</td><td>'+dd.trades.length+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAna(dd.pnl)+'</td><td>'+dd.losses+'</td><td style="color:#ef4444;">'+fmtAna(dd.worstTrade)+'</td></tr>'; });
    document.getElementById('anaWorstDayBody').innerHTML=html||'<tr><td colspan="5" style="text-align:center;color:#3a5070;">No losing days</td></tr>';
  })();

  // Loss by Exit Reason
  (function(){
    var lrMap={};
    lossTrades.forEach(function(t){ var r=t.exitReason||'Unknown'; if(!lrMap[r])lrMap[r]={cnt:0,pnl:0}; lrMap[r].cnt++; lrMap[r].pnl+=t.pnl; });
    var reasons2=Object.keys(lrMap).sort(function(a,b){return lrMap[a].pnl-lrMap[b].pnl;});
    var totalLossCnt=lossTrades.length;
    var html='';
    reasons2.forEach(function(r){ var d=lrMap[r]; var pct=((d.cnt/totalLossCnt)*100).toFixed(0); html+='<tr><td style="color:#c8d8f0;">'+r+'</td><td>'+d.cnt+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAna(d.pnl)+'</td><td style="color:#ef4444;">'+fmtAna(Math.round(d.pnl/d.cnt))+'</td><td style="font-weight:600;">'+pct+'%</td></tr>'; });
    document.getElementById('anaLossReasonBody').innerHTML=html;
  })();

  // Losing Hours
  (function(){
    var lhMap={};
    trades.forEach(function(t){ var h=spGetHour(t); if(!lhMap[h])lhMap[h]={total:0,losses:0,lossPnl:0}; lhMap[h].total++; if(t.pnl<0){lhMap[h].losses++;lhMap[h].lossPnl+=t.pnl;} });
    var hrs=Object.keys(lhMap).map(Number).sort(function(a,b){return a-b;});
    var html='';
    hrs.forEach(function(h){ var d=lhMap[h]; if(d.losses===0)return; var lossPct=((d.losses/d.total)*100).toFixed(0); var dangerColor=parseFloat(lossPct)>=60?'#ef4444':parseFloat(lossPct)>=45?'#f59e0b':'#10b981'; html+='<tr><td style="color:#c8d8f0;font-weight:600;">'+h+':00</td><td>'+d.losses+' / '+d.total+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAna(d.lossPnl)+'</td><td style="color:#ef4444;">'+fmtAna(Math.round(d.lossPnl/d.losses))+'</td><td style="color:'+dangerColor+';font-weight:700;">'+lossPct+'%</td></tr>'; });
    document.getElementById('anaLossHourBody').innerHTML=html;
  })();
}
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
});

/**
 * DELETE /scalp-paper/session/:index
 * Delete a single session by its 0-based index in the sessions array
 */
router.delete("/session/:index", (req, res) => {
  if (state.running) {
    return res.status(400).json({
      success: false,
      error: "Stop scalp paper trading first before deleting a session.",
    });
  }

  const data = loadScalpData();
  const idx = parseInt(req.params.index, 10);

  if (isNaN(idx) || idx < 0 || idx >= data.sessions.length) {
    return res.status(400).json({ success: false, error: "Invalid session index." });
  }

  const removed = data.sessions.splice(idx, 1)[0];
  // Recalculate totalPnl and capital from remaining sessions
  data.totalPnl = data.sessions.reduce((sum, s) => sum + (s.pnl || 0), 0);
  data.capital = getScalpCapitalFromEnv() + data.totalPnl;
  saveScalpData(data);

  log(`🗑️ Deleted scalp paper session ${idx + 1} (${removed.date || "unknown date"}, PnL: ${removed.pnl})`);

  return res.json({
    success: true,
    message: `Session deleted successfully.`,
  });
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

// ── Simulation mode routes ─────────────────────────────────────────────────

router.get("/simulate", (req, res) => {
  if (state.running) return res.redirect("/scalp-paper/status");

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
<title>Simulate — Scalp Paper</title>
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
${buildSidebar('scalpPaper', false)}
<div class="main-content">
  <h1 style="font-size:1.4rem;font-weight:800;color:#e2e8f0;margin-bottom:4px;">Simulate — Scalp Paper</h1>
  <p style="font-size:0.82rem;color:#6b7fa0;margin-bottom:8px;">Run your scalp strategy against fake ticks — no broker login needed. Works after market hours.</p>
  <p style="font-size:0.75rem;color:#4a6080;">Resolution: <strong>${SCALP_RES}-min</strong> candles</p>

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
    <p style="font-size:0.78rem;color:#6b7fa0;margin-top:8px;">Pick a date to replay that day's real ${SCALP_RES}-min candles as ticks through your strategy.</p>
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
  _post('/scalp-paper/simulate/start', {
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
  _post('/scalp-paper/simulate/start', {
    mode: 'historical', date: date,
    speed: parseInt(document.getElementById('replaySpeed').value) || 10,
  }, btn, 'Replay Selected Date');
}
function _post(url, body, btn, resetLabel) {
  fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })
    .then(r=>r.json()).then(d=>{
      if(d.success){ window.location.href='/scalp-paper/status'; }
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
    log(`🎮 [SIM] Fetching ${SCALP_RES}-min candles for ${date}...`);

    try {
      const { fetchCandlesCached, clearCache } = require("../utils/candleCache");
      const { fetchCandles } = require("../services/backtestEngine");

      // Fetch candles: 10 calendar days before target date for warmup
      const targetDate = new Date(date + "T00:00:00+05:30");
      const fromDate = new Date(targetDate);
      fromDate.setDate(fromDate.getDate() - 10);
      const fromStr = fromDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

      // Clear cache to avoid stale partial data from a previous live session
      clearCache(NIFTY_INDEX_SYMBOL, String(SCALP_RES));

      const allCandles = await fetchCandlesCached(
        NIFTY_INDEX_SYMBOL, String(SCALP_RES), fromStr, date, fetchCandles
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
        log(`⚠️ [SIM] 1-min candle fetch failed (${e.message}) — using ${SCALP_RES}-min interpolation`);
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

      // Fetch prev day OHLC for CPR
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

      log(`📦 [SIM] Date: ${date} | ${warmup.length} warmup + ${sessionCandles.length} session candles (${SCALP_RES}-min) | Speed: ${speed}x`);

      const result = tickSimulator.startFromCandles({
        candles: [...warmup, ...sessionCandles],
        warmupCount: warmup.length,
        resolution: SCALP_RES,
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
      warmupCandles: 30, resolution: SCALP_RES,
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

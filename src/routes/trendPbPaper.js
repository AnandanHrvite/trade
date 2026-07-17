/**
 * TREND PULLBACK PAPER TRADE — /trend-pb-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * Trade WITH an established trend, enter on a healthy 5-min pullback that resumes.
 * Single-leg slightly-ITM NIFTY option buying. Intraday MIS only, square-off 15:15.
 *
 * Uses LIVE NIFTY data (Fyers WebSocket) but SIMULATES orders locally — no broker
 * is hit; everything is in-memory + persisted to JSON & JSONL. Paper is canonical:
 * the backtest and live engines must match THIS decision/fill/exit logic.
 *
 * Strategy signal: src/strategies/trend_pb.js
 * Exits (owned here, all on SPOT except the premium backstop):
 *   structural stop (pullback low, clamped) → breakeven → ATR-chandelier trail on
 *   spot (the right-tail engine) → EMA20(5m)-close trend-failure → time-stop → EOD
 *   → premium disaster backstop. No fixed target, no partial booking.
 *
 * Endpoints: /start /stop /exit /status /status/data /status/chart-data /history …
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const { EMA, ATR } = require("technicalindicators");

const trendPbStrategy    = require("../strategies/trend_pb");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { renderHistoryPage, dailyFilesPaginate } = require("../utils/paperHistoryUI");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiCapitalStrip, bbRsiStatGrid, bbRsiCurrentBar, bbRsiActivityLog } = require("../utils/bbRsiStyleUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter   = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const oiFilter    = require("../services/oiFilter");
const tradeLogger = require("../utils/tradeLogger");
const chartBackfill = require("../utils/chartBackfill");
const aiExport    = require("../utils/aiExport");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { fmtISTDateTime, getISTMinutes, getBucketStart } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");
const tradeGuards = require("../utils/tradeGuards");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "trendPbPaper";
const RES_MIN            = 5;   // 5-min candles (entries); 15-min bias derived in the strategy

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "trend_pb_paper_trades.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let _dataCache = null;
function loadData() {
  if (_dataCache) return _dataCache;
  ensureDir();
  if (!fs.existsSync(PT_FILE)) {
    const init = { capital: parseFloat(process.env.FYERS_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(init, null, 2));
    _dataCache = init;
    return init;
  }
  try { _dataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error("[trend-pb-paper] trend_pb_paper_trades.json corrupt — resetting:", e.message);
    _dataCache = { capital: parseFloat(process.env.FYERS_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(_dataCache, null, 2));
  }
  return _dataCache;
}
function saveData(d) {
  ensureDir();
  const tmp = PT_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, PT_FILE);
  _dataCache = d;
}

// ── State ────────────────────────────────────────────────────────────────────

let state = _freshState();
function _freshState() {
  return {
    running:        false,
    sessionStart:   null,
    sessionTrades:  [],
    sessionPnl:     0,
    tradesTaken:    0,
    consecutiveLosses: 0,
    candles:        [],
    currentBar:     null,
    barStartTime:   null,
    tickCount:      0,
    lastTickTime:   null,
    lastTickPrice:  null,
    position:       null,
    optionLtp:      null,
    optionLtpUpdatedAt: null,
    log:            [],
    _sessionId:     null,
  };
}

function log(msg) {
  const stamp = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  const line = `[${stamp}] ${msg}`;
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
  console.log(line);
}

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

// ── Crash/restart recovery: rehydrate today's in-memory session from JSONL ─────
function rehydrateSessionFromJsonl() {
  try {
    const data = loadData();
    const keyOf = (t) => String(t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`);
    const today = tradeLogger.istDateString(Date.now());
    const all = tradeLogger.readDailyTrades("trend_pb", today)
      .filter(t => t && !t.type && (t.side || t.entryTime || t.entryBarTime || t.symbol));
    const seen = new Set();
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) seen.add(keyOf(t));
    let trades = all.filter(t => !seen.has(keyOf(t)));
    let source = "today's live session";
    if (!trades.length) {
      const saved = (data.sessions || []).filter(s => Array.isArray(s.trades) && s.trades.length);
      if (saved.length) {
        const last = saved.reduce((a, b) => (String(b.date) > String(a.date) ? b : a));
        trades = last.trades;
        source = `last session (${last.date || "?"})`;
      }
    }
    if (!trades.length) return;
    state.sessionTrades = trades;
    state.tradesTaken   = trades.length;
    state.sessionPnl = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    if (!state.sessionStart) state.sessionStart = trades[0].entryTime || trades[0].loggedAt || null;
    console.log(`♻️ [TREND_PB-PAPER] Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl})`);
  } catch (err) {
    console.warn(`[TREND_PB-PAPER] session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();

// ── Option LTP polling (recursive setTimeout so the replay harness advances it) ──
const OPTION_POLL_MS = 3000;
let _optionPollTimer = null;
let _optionPollStopped = true;
function startOptionPolling() {
  stopOptionPolling();
  _optionPollStopped = false;
  const poll = async () => {
    if (_optionPollStopped) return;
    if (state.position) {
      try {
        const r = await fyers.getQuotes([state.position.symbol]);
        if (r && r.s === "ok" && r.d && r.d.length) {
          const ltp = r.d[0].v && (r.d[0].v.lp || r.d[0].v.ltp);
          if (typeof ltp === "number" && ltp > 0) {
            state.optionLtp = ltp;
            state.optionLtpUpdatedAt = Date.now();
            try { tickRecorder.recordOptionLtp(state.position.symbol, ltp, "trend-pb-paper"); } catch (_) {}
          }
        }
      } catch (_) {}
    }
    if (!_optionPollStopped) _optionPollTimer = setTimeout(poll, OPTION_POLL_MS);
  };
  _optionPollTimer = setTimeout(poll, OPTION_POLL_MS);
}
function stopOptionPolling() {
  _optionPollStopped = true;
  if (_optionPollTimer) { clearTimeout(_optionPollTimer); _optionPollTimer = null; }
}

// ── indicator helpers on the live 5-min series ────────────────────────────────
function _computeEma(candles, period) {
  if (!candles || candles.length < period) return null;
  const closes = candles.map(c => c && c.close).filter(v => typeof v === "number");
  if (closes.length < period) return null;
  const arr = EMA.calculate({ period, values: closes });
  return arr && arr.length ? arr[arr.length - 1] : null;
}
function _computeAtr(candles, period) {
  if (!candles || candles.length < period + 1) return null;
  const highs = candles.map(c => c.high), lows = candles.map(c => c.low), closes = candles.map(c => c.close);
  const arr = ATR.calculate({ period, high: highs, low: lows, close: closes });
  return arr && arr.length ? arr[arr.length - 1] : null;
}

// ── Trade simulation ──────────────────────────────────────────────────────────
async function simulateBuy(side, sig) {
  const spot = state.lastTickPrice;
  if (!spot || !side) return;

  let optInfo;
  try {
    optInfo = await instrumentConfig.validateAndGetOptionSymbol(spot, side, "TREND_PB");
  } catch (e) {
    log(`❌ [TREND_PB-PAPER] Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ [TREND_PB-PAPER] No valid expiry — skip ${side} entry`);
    return;
  }

  let optionEntryLtp = null, optBid = null, optAsk = null;
  try {
    const r = await fyers.getQuotes([optInfo.symbol]);
    if (r && r.s === "ok" && r.d && r.d.length) {
      const v = r.d[0].v || {};
      const ltp = v.lp || v.ltp;
      if (typeof ltp === "number" && ltp > 0) {
        optionEntryLtp = ltp;
        optBid = Number(v.bid || v.bid_price || 0) || null;
        optAsk = Number(v.ask || v.ask_price || 0) || null;
        try { tickRecorder.recordOptionLtp(optInfo.symbol, ltp, "trend-pb-paper"); } catch (_) {}
      }
    }
  } catch (e) {
    log(`⚠️ [TREND_PB-PAPER] Option LTP fetch failed: ${e.message} — entry blocked`);
    return;
  }
  if (!optionEntryLtp) {
    log(`❌ [TREND_PB-PAPER] Option LTP not available — entry skipped`);
    return;
  }

  // ── Option filter: slightly-ITM (resolved above), premium band, spread ──
  const premMin = parseFloat(process.env.TREND_PB_PREMIUM_MIN || "120");
  const premMax = parseFloat(process.env.TREND_PB_PREMIUM_MAX || "400");
  const premGateOn = (process.env.TREND_PB_PREMIUM_GATE_ENABLED || "true").toLowerCase() === "true";
  if (premGateOn && (optionEntryLtp < premMin || optionEntryLtp > premMax)) {
    log(`⏸️ [TREND_PB-PAPER] Premium gate: ${optInfo.symbol} LTP ₹${optionEntryLtp} outside [${premMin}, ${premMax}] — entry skipped`);
    skipLogger.appendSkipLog("trend_pb", { gate: "premium_range", reason: `LTP ₹${optionEntryLtp} outside [${premMin}, ${premMax}]`, symbol: optInfo.symbol, side, spot, optLtp: optionEntryLtp });
    return;
  }
  const maxSpread = parseFloat(process.env.TREND_PB_MAX_SPREAD_PTS || process.env.MAX_BID_ASK_SPREAD_PTS || "2");
  const _sp = tradeGuards.checkSpread(optBid, optAsk, maxSpread);
  if (!_sp.ok) {
    log(`⏸️ [TREND_PB-PAPER] Spread gate: ${optInfo.symbol} ${_sp.reason} > ${maxSpread}pt — entry skipped`);
    skipLogger.appendSkipLog("trend_pb", { gate: "spread", reason: `${_sp.reason} > ${maxSpread}pt`, symbol: optInfo.symbol, side, spot, spread: _sp.spread });
    return;
  }

  const qty = instrumentConfig.getLotQty();

  // ── Initial hard SL = structural (pullback low CE / high PE), clamped to a
  //    sane band so a wide structure doesn't over-risk and a tight one doesn't
  //    get noise-stopped. risk = clamp(|entry - structuralStop|, min, max).
  const clampMin = parseFloat(process.env.TREND_PB_STOP_CLAMP_MIN || "8");
  const clampMax = parseFloat(process.env.TREND_PB_STOP_CLAMP_MAX || "30");
  let structStop = (sig && typeof sig.slSpot === "number") ? sig.slSpot
                    : (side === "CE" ? spot - clampMin : spot + clampMin);
  let riskPts = Math.abs(spot - structStop);
  riskPts = Math.min(Math.max(riskPts, clampMin), clampMax);
  const _initSl = Math.round((side === "CE" ? spot - riskPts : spot + riskPts) * 100) / 100;

  const pos = {
    side,
    symbol:         optInfo.symbol,
    optionStrike:   optInfo.strike,
    optionExpiry:   optInfo.expiry,
    qty,
    entrySpot:      spot,
    entryPrice:     spot,
    optionEntryLtp,
    entryTime:      istNow(),
    entryTimeMs:    Date.now(),
    entryBarTime:   Math.floor(getBucketStart(Date.now(), RES_MIN) / 1000),
    riskPts,
    targetSpot:     null,                 // no fixed target
    initialSlSpot:  _initSl,
    slSpot:         _initSl,
    bestSpot:       spot,                 // MFE anchor for the ATR-chandelier trail
    breakevenArmed: false,
    trailArmed:     false,
    emaArmed:       false,
    lastEma:        null,
    lastAtr:        null,
    candlesHeld:    0,
    peakPremium:    optionEntryLtp,
    signalStrength: sig && sig.signalStrength,
    vixAtEntry:     getCachedVix(),
    oiAtEntry:      oiFilter.getCachedOi(),
    oiRegime:       oiFilter.getCachedRegime(),
    trendBias:      sig && sig.trendBias,
    vwapAtEntry:    sig && sig.vwap,
    atr5AtEntry:    sig && sig.atr5,
    pullbackLow:    sig && sig.pullbackLow,
    pullbackHigh:   sig && sig.pullbackHigh,
    vwapAligned:    sig && sig.vwapAligned != null ? sig.vwapAligned : null,
    mfeSpotPts:     0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
    entryReason:    sig && sig.reason,
  };

  state.position = pos;
  try { require("../utils/positionPersist").saveTrendPbPosition(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  state.optionLtp = optionEntryLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;
  startOptionPolling();

  log(`🟢 [TREND_PB-PAPER] BUY_${side} ${optInfo.symbol} qty=${qty} @ spot=${spot} optLtp=${optionEntryLtp} | initial SL=${pos.slSpot} (risk ${riskPts.toFixed(1)}pt, structural)`);

  notifyEntry({
    mode: "TREND_PB-PAPER",
    side, symbol: optInfo.symbol,
    spotAtEntry: spot, optionEntryLtp,
    qty, stopLoss: pos.slSpot,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "trend-pb-paper",
      sessionId: state._sessionId,
      ts: Date.now(),
      side, symbol: optInfo.symbol, qty,
      spotEntry: spot, optionEntry: optionEntryLtp,
      stopLoss: pos.slSpot, targetSpot: null,
      reason: pos.entryReason,
    });
  } catch (_) {}
}

function simulateSell(reason) {
  if (!state.position) return;
  const pos = state.position;
  const exitOptLtp = state.optionLtp || pos.optionEntryLtp;
  const exitSpot   = state.lastTickPrice || pos.entrySpot;
  const qty        = pos.qty;
  const charges    = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitOptLtp, qty });
  const pnl        = parseFloat(((exitOptLtp - pos.optionEntryLtp) * qty - charges).toFixed(2));

  state.sessionPnl = parseFloat((state.sessionPnl + pnl).toFixed(2));
  if (pnl < 0) state.consecutiveLosses++; else if (pnl > 0) state.consecutiveLosses = 0;

  const trade = {
    side:           pos.side,
    symbol:         pos.symbol,
    qty,
    entryPrice:     pos.entrySpot,
    exitPrice:      exitSpot,
    spotAtEntry:    pos.entrySpot,
    spotAtExit:     exitSpot,
    optionEntryLtp: pos.optionEntryLtp,
    optionExitLtp:  exitOptLtp,
    bestOptionLtp:  pos.peakPremium || null,
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    entryBarTime:   pos.entryBarTime,
    exitBarTime:    Math.floor(getBucketStart(Date.now(), RES_MIN) / 1000),
    pnl,
    pnlMode:        `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp}`,
    exitReason:     reason,
    entryReason:    pos.entryReason,
    stopLoss:       pos.slSpot,
    initialStopLoss: pos.initialSlSpot,
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    optionType:     pos.side,
    optionEntrySymbol: pos.symbol,
    signalStrength: pos.signalStrength,
    vixAtEntry:     pos.vixAtEntry,
    vixAtExit:      getCachedVix(),
    oiAtEntry:      pos.oiAtEntry != null ? pos.oiAtEntry : null,
    oiRegime:       pos.oiRegime || null,
    trendBias:      pos.trendBias || null,
    riskPts:        pos.riskPts,
    pullbackLow:    pos.pullbackLow,
    pullbackHigh:   pos.pullbackHigh,
    atr5AtEntry:    pos.atr5AtEntry,
    vwapAligned:    pos.vwapAligned != null ? pos.vwapAligned : null,
    mfeSpotPts:     pos.mfeSpotPts || 0,
    mfePnl:         pos.mfePnl || 0,
    maeSpotPts:     pos.maeSpotPts || 0,
    maePnl:         pos.maePnl || 0,
    secsToMFE:      pos.secsToMFE || 0,
    secsToMAE:      pos.secsToMAE || 0,
    durationMs:     Date.now() - pos.entryTimeMs,
    charges,
    isFutures:      false,
    instrument:     "NIFTY_OPTIONS",
  };
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog("trend_pb", trade);

  log(`🔴 [TREND_PB-PAPER] EXIT ${pos.side} ${pos.symbol} @ optLtp=${exitOptLtp} spot=${exitSpot} | PnL=₹${pnl} (${reason})`);

  notifyExit({
    mode: "TREND_PB-PAPER",
    side: pos.side, symbol: pos.symbol,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    optionEntryLtp: pos.optionEntryLtp, optionExitLtp: exitOptLtp,
    pnl, sessionPnl: state.sessionPnl,
    exitReason: reason, entryReason: pos.entryReason,
    entryTime: pos.entryTime, exitTime: trade.exitTime, qty,
    peakPremium: trade.bestOptionLtp, peakPnl: trade.mfePnl,
    maxDrawdown: trade.maePnl, heldMs: trade.durationMs,
  });

  try {
    tickRecorder.recordExit({
      mode: "trend-pb-paper", sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitOptLtp, pnl, reason,
    });
  } catch (_) {}

  state.position = null;
  try { require("../utils/positionPersist").clearTrendPbPosition(); } catch (_) {}
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;
  stopOptionPolling();
}

// ── In-position management ────────────────────────────────────────────────────
// Per 5-min close: breakeven → ATR-chandelier trail (raise the spot stop) →
// EMA20(5m)-close trend-failure → time-stop. Tick-level hard SL / premium
// backstop / loss cap live in _checkExits.
function _managePositionOnClose(bar) {
  const pos = state.position;
  if (!pos || !bar || typeof bar.close !== "number") return;
  const close = bar.close;
  pos.candlesHeld = (pos.candlesHeld || 0) + 1;

  const favPts = (close - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);

  // 1. Breakeven — lift the stop to entry once favourable by BREAKEVEN_R × risk.
  const beR = parseFloat(process.env.TREND_PB_BREAKEVEN_R || "1.0");
  if (!pos.breakevenArmed && beR > 0 && pos.riskPts > 0 && favPts >= beR * pos.riskPts) {
    if (pos.side === "CE" && pos.entrySpot > pos.slSpot) pos.slSpot = Math.round(pos.entrySpot * 100) / 100;
    if (pos.side === "PE" && pos.entrySpot < pos.slSpot) pos.slSpot = Math.round(pos.entrySpot * 100) / 100;
    pos.breakevenArmed = true;
    log(`🔒 [TREND_PB-PAPER] Breakeven armed — SL → entry ${pos.slSpot} (favourable ${favPts.toFixed(1)}pt ≥ ${(beR * pos.riskPts).toFixed(1)}pt)`);
  }

  // 2. ATR-chandelier trail — raise the spot stop to bestSpot − mult × ATR5.
  //    Ratchets one direction only; this is the right-tail engine (let winners run).
  const trailMult = parseFloat(process.env.TREND_PB_TRAIL_ATR_MULT || "2.5");
  const atrPeriod = parseInt(process.env.TREND_PB_ATR_PERIOD || "14", 10);
  const atr5 = _computeAtr(state.candles, atrPeriod);
  if (atr5 != null) {
    pos.lastAtr = Math.round(atr5 * 100) / 100;
    const cand = pos.side === "CE" ? pos.bestSpot - trailMult * atr5 : pos.bestSpot + trailMult * atr5;
    if (pos.side === "CE" && cand > pos.slSpot) { pos.slSpot = Math.round(cand * 100) / 100; pos.trailArmed = true; }
    if (pos.side === "PE" && cand < pos.slSpot) { pos.slSpot = Math.round(cand * 100) / 100; pos.trailArmed = true; }
  }

  // 3. EMA20(5m)-close trend-failure — exit only on a CLOSE back across the EMA,
  //    and only after price first closed on the correct side (emaArmed) so a fresh
  //    entry below a stale EMA isn't stopped on its first candle.
  const emaPeriod = Math.max(2, parseInt(process.env.TREND_PB_TRAIL_EMA || "20", 10));
  const ema = _computeEma(state.candles, emaPeriod);
  if (ema != null) {
    pos.lastEma = Math.round(ema * 100) / 100;
    if (pos.side === "CE") {
      if (close >= ema) pos.emaArmed = true;
      else if (pos.emaArmed) return simulateSell(`Closed below EMA${emaPeriod}(5m) (${close} < ${pos.lastEma}) — trend failed`);
    } else {
      if (close <= ema) pos.emaArmed = true;
      else if (pos.emaArmed) return simulateSell(`Closed above EMA${emaPeriod}(5m) (${close} > ${pos.lastEma}) — trend failed`);
    }
  }

  // 4. Time stop — flat for too long = theta bleed (shared guard).
  const tsCandles = parseInt(process.env.TREND_PB_TIME_STOP_CANDLES || "6", 10);
  const tsFlat    = parseFloat(process.env.TREND_PB_TIME_STOP_FLAT_PTS || "12");
  const tsReason = tradeGuards.checkTimeStop(pos.candlesHeld, favPts, { maxCandles: tsCandles, flatPts: tsFlat });
  if (tsReason) return simulateSell(tsReason);
}

// Tick-level exits: hard SL (structural / breakeven / ATR-trail — all folded into
// slSpot), the premium disaster backstop, and an optional per-trade rupee cap.
function _checkExits(spotPrice) {
  if (!state.position) return;
  const pos = state.position;
  const optLtp = state.optionLtp || pos.optionEntryLtp;

  // Track best spot (MFE anchor for the trail) + peak premium + MFE/MAE.
  if (pos.side === "CE") { if (spotPrice > pos.bestSpot) pos.bestSpot = spotPrice; }
  else                   { if (spotPrice < pos.bestSpot) pos.bestSpot = spotPrice; }
  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;

  const _favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const _curPnl = (optLtp - pos.optionEntryLtp) * pos.qty;
  if (_favPts > (pos.mfeSpotPts || 0)) { pos.mfeSpotPts = parseFloat(_favPts.toFixed(2)); pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (_curPnl > (pos.mfePnl     || 0)) pos.mfePnl     = parseFloat(_curPnl.toFixed(2));
  if (_favPts < (pos.maeSpotPts || 0)) { pos.maeSpotPts = parseFloat(_favPts.toFixed(2)); pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (_curPnl < (pos.maePnl     || 0)) pos.maePnl     = parseFloat(_curPnl.toFixed(2));

  // Optional per-trade rupee cap (default off — the structural + trail stops govern).
  const maxTradeLoss = parseFloat(process.env.TREND_PB_MAX_TRADE_LOSS || "0");
  if (maxTradeLoss > 0 && _curPnl <= -maxTradeLoss) {
    simulateSell(`Max trade loss (₹${Math.round(_curPnl)} ≤ -₹${maxTradeLoss})`);
    return;
  }

  // Premium disaster backstop — catches IV-crush / gap the spot stop can miss.
  const premStopPct = parseFloat(process.env.TREND_PB_PREMIUM_STOP_PCT || "35");
  if (premStopPct > 0 && optLtp <= pos.optionEntryLtp * (1 - premStopPct / 100)) {
    simulateSell(`Premium disaster stop (₹${optLtp} ≤ −${premStopPct}% of entry ₹${pos.optionEntryLtp})`);
    return;
  }

  // Hard SL (structural → breakeven → ATR-trail, all folded into slSpot) — spot-based.
  if (pos.side === "CE" && spotPrice <= pos.slSpot) { simulateSell(`Stop hit (${spotPrice} ≤ ${pos.slSpot}${pos.trailArmed ? " · trail" : pos.breakevenArmed ? " · BE" : ""})`); return; }
  if (pos.side === "PE" && spotPrice >= pos.slSpot) { simulateSell(`Stop hit (${spotPrice} ≥ ${pos.slSpot}${pos.trailArmed ? " · trail" : pos.breakevenArmed ? " · BE" : ""})`); return; }
}

// ── Candle close handler ──────────────────────────────────────────────────────
async function onCandleClose(bar) {
  await oiFilter.recordOiSample(bar && bar.close);

  if (state.position) { _managePositionOnClose(bar); return; }

  const _spot = bar && bar.close;

  const maxTrades = parseInt(process.env.TREND_PB_MAX_DAILY_TRADES || "3", 10);
  if (state.tradesTaken >= maxTrades) return; // budget spent — expected, not a skip

  const maxLoss = parseFloat(process.env.TREND_PB_MAX_DAILY_LOSS || "5000");
  if (state.sessionPnl <= -maxLoss) {
    skipLogger.appendSkipLog("trend_pb", { gate: "daily_loss", reason: `sessionPnl ${state.sessionPnl} <= -${maxLoss}`, spot: _spot });
    return;
  }

  // Portfolio-wide daily loss cap (across ALL strategies; default disabled).
  {
    const _pf = require("../utils/portfolioRisk").checkPortfolioCap();
    if (_pf.blocked) {
      skipLogger.appendSkipLog("trend_pb", { gate: "portfolio_loss", reason: _pf.reason, spot: _spot });
      return;
    }
  }

  const streakSkip = parseInt(process.env.TREND_PB_LOSS_STREAK_SKIP || "3", 10);
  if (streakSkip > 0 && state.consecutiveLosses >= streakSkip) {
    skipLogger.appendSkipLog("trend_pb", { gate: "loss_streak", reason: `${state.consecutiveLosses} consecutive losses ≥ ${streakSkip} — session cool-off`, spot: _spot });
    return;
  }

  const sig = trendPbStrategy.getSignal(state.candles, { alreadyTraded: state.tradesTaken >= maxTrades });
  if (sig.signal === "NONE" || !sig.side) {
    // Only log post-warmup skips (indicators seeded) — avoids "warming up" noise.
    if (sig.atr5 != null && sig.ema20_15 != null) {
      skipLogger.appendSkipLog("trend_pb", { gate: "signal_none", reason: sig.reason || "no signal", spot: _spot, trendBias: sig.trendBias, atr5: sig.atr5 });
    }
    return;
  }

  if ((process.env.TREND_PB_VIX_ENABLED || "false").toLowerCase() === "true") {
    const vixCheck = await checkLiveVix(sig.signalStrength, { mode: "trend_pb" });
    if (!vixCheck.allowed) {
      log(`⏸️ [TREND_PB-PAPER] VIX gate blocked: ${vixCheck.reason}`);
      skipLogger.appendSkipLog("trend_pb", { gate: "vix", reason: vixCheck.reason, spot: _spot, vix: vixCheck.vix, sig: sig.signal, strength: sig.signalStrength });
      return;
    }
  }

  if (oiFilter.getOiEnabled("trend_pb")) {
    const _oi = await oiFilter.checkLiveOi(sig.side, _spot, { mode: "trend_pb" });
    if (!_oi.allowed) {
      log(`⏸️ [TREND_PB-PAPER] OI gate blocked: ${_oi.reason}`);
      skipLogger.appendSkipLog("trend_pb", { gate: "oi", reason: _oi.reason, spot: _spot, side: sig.side, oi: _oi.oi ?? null, deltaOi: _oi.deltaOi ?? null, regime: _oi.regime ?? null });
      return;
    }
    if (_oi.regime) sig.reason = `${sig.reason} | ${_oi.reason}`;
  }

  await simulateBuy(sig.side, sig);
}

// ── onTick ────────────────────────────────────────────────────────────────────
function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (!price || price <= 0) return;

  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  const bucketMs = getBucketStart(Date.now(), RES_MIN);
  if (!state.currentBar || state.barStartTime !== bucketMs) {
    if (state.currentBar) {
      const lastC = state.candles.length ? state.candles[state.candles.length - 1] : null;
      if (lastC && lastC.time === state.currentBar.time) {
        state.candles[state.candles.length - 1] = { ...state.currentBar };
      } else {
        state.candles.push({ ...state.currentBar });
      }
      if (state.candles.length > 300) state.candles.shift();
      onCandleClose(state.currentBar).catch(e => console.error(`🚨 [TREND_PB-PAPER] onCandleClose error: ${e.message}`));
    }
    const bucketSec = Math.floor(bucketMs / 1000);
    const lastPre = state.candles.length ? state.candles[state.candles.length - 1] : null;
    if (lastPre && lastPre.time === bucketSec) {
      state.currentBar = state.candles.pop();
      state.currentBar.high  = Math.max(state.currentBar.high, price);
      state.currentBar.low   = Math.min(state.currentBar.low, price);
      state.currentBar.close = price;
      state.currentBar.volume = (state.currentBar.volume || 0) + 1;
    } else {
      state.currentBar = { time: bucketSec, open: price, high: price, low: price, close: price, volume: 1 };
    }
    state.barStartTime = bucketMs;
  } else {
    state.currentBar.high  = Math.max(state.currentBar.high, price);
    state.currentBar.low   = Math.min(state.currentBar.low, price);
    state.currentBar.close = price;
    state.currentBar.volume = (state.currentBar.volume || 0) + 1;
  }

  if (state.position) _checkExits(price);

  if (state.position) {
    const nowMin = getISTMinutes();
    const stopMin = (function() {
      const raw = process.env.TREND_PB_FORCED_EXIT || "15:15";
      const [h, m] = raw.split(":").map(Number);
      return h * 60 + (isNaN(m) ? 0 : m);
    })();
    if (nowMin >= stopMin) simulateSell(`EOD square-off (${process.env.TREND_PB_FORCED_EXIT || "15:15"} IST)`);
  }
}

// ── Preload spot history (seed EMA/ATR before the open) ───────────────────────
async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { fetchCandles } = require("../services/backtestEngine");
    const _now = new Date();
    const istToday = _now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const istStart = new Date(_now.getTime() - 7 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached(NIFTY_INDEX_SYMBOL, String(RES_MIN), istStart, istToday, fetchCandles);
    if (Array.isArray(candles) && candles.length > 0) {
      state.candles = candles.slice(-200);
      log(`📊 [TREND_PB-PAPER] Preloaded ${state.candles.length} × ${RES_MIN}-min spot candles (${istStart}→${istToday}, EMA/ATR-seeded)`);
    } else {
      log(`📊 [TREND_PB-PAPER] No history available — will build from live ticks`);
    }
  } catch (e) {
    log(`⚠️ [TREND_PB-PAPER] Preload failed: ${e.message}`);
  }
}

// ── Auto-stop at TRADE_STOP_TIME ──────────────────────────────────────────────
let _autoStopTimer = null;
function scheduleAutoStop() {
  if (_autoStopTimer) clearTimeout(_autoStopTimer);
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  const stopMin = h * 60 + (isNaN(m) ? 0 : m);
  const now = getISTMinutes();
  const minsLeft = stopMin - now;
  if (minsLeft <= 0) return;
  _autoStopTimer = setTimeout(() => { log(`⏰ [TREND_PB-PAPER] Auto-stop @ ${raw} IST`); stopSession(); }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ─────────────────────────────────────────────────────────
router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/trend-pb-paper/status");

  if ((process.env.TREND_PB_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("Trend Pullback Disabled", "Enable Trend Pullback Mode in Settings first", "/settings", "Go to Settings"));
  }

  const check = sharedSocketState.canStart("TREND_PB_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/trend-pb-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/trend-pb-paper/status", "← Back"));

  const nowMin = getISTMinutes();
  const stopMin = (function() {
    const raw = process.env.TREND_PB_FORCED_EXIT || "15:15";
    const [h, m] = raw.split(":").map(Number);
    return h * 60 + (isNaN(m) ? 0 : m);
  })();
  if (nowMin >= stopMin) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${process.env.TREND_PB_FORCED_EXIT || "15:15"} IST — Trend Pullback does not enter after this`, "/trend-pb-paper/status", "← Back"));
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `trend-pb-paper:${Date.now()}`;

  sharedSocketState.setTrendPbActive("TREND_PB_PAPER");

  await preloadHistory();

  if ((process.env.TREND_PB_VIX_ENABLED || "false").toLowerCase() === "true") {
    resetVixCache();
    fetchLiveVix({ force: true }).catch(() => {});
  }

  try {
    tickRecorder.recordSessionStart({
      mode: "trend-pb-paper",
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: state.candles.map(c => ({ ...c })),
      vix: getCachedVix(),
      meta: {
        instrument: instrumentConfig.INSTRUMENT,
        resolutionMin: RES_MIN,
        spotSymbol: NIFTY_INDEX_SYMBOL,
        sessionStartISO: state.sessionStart,
        recordsOptionLtps: true,
      },
    });
  } catch (_) {}

  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [TREND_PB-PAPER] Piggybacking on existing WebSocket");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [TREND_PB-PAPER] Started WebSocket");
  }

  scheduleAutoStop();
  log(`🟢 [TREND_PB-PAPER] Session started — ${RES_MIN}-min candles, 15m bias + 5m pullback/resumption`);

  notifyStarted({
    mode: "TREND_PB-PAPER",
    text: [
      `📄 TREND PULLBACK PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${trendPbStrategy.NAME}`,
      `Entry win : ${process.env.TREND_PB_ENTRY_START || "09:45"} → ${process.env.TREND_PB_ENTRY_END || "14:30"} IST`,
      `Max trades: ${process.env.TREND_PB_MAX_DAILY_TRADES || "3"}/day`,
      `Square-off: ${process.env.TREND_PB_FORCED_EXIT || "15:15"} IST`,
    ].filter(Boolean).join("\n"),
  });

  res.redirect("/trend-pb-paper/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped");
  state.running = false;
  stopOptionPolling();

  try { tickRecorder.recordSessionStop({ mode: "trend-pb-paper", sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  sharedSocketState.clearTrendPb();   // clear OWN mode first (else socket never stops → leak)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: trendPbStrategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      saveData(data);
      log(`💾 [TREND_PB-PAPER] Session saved — ${state.sessionTrades.length} trades, PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ [TREND_PB-PAPER] Save failed: ${e.message}`);
    }
  }

  log("🔴 [TREND_PB-PAPER] Session stopped");

  notifyDayReport({
    mode: "TREND_PB-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/trend-pb-paper/status"); });
router.get("/exit", (req, res) => { if (state.position) simulateSell("Manual exit"); res.redirect("/trend-pb-paper/status"); });

// ── Manual CE/PE entry — reuses the simulateBuy path (SL/charges/logging apply) ──
router.post("/manualEntry", async (req, res) => {
  if (!state.running)  return res.status(400).json({ success: false, error: "Trend Pullback paper is not running." });
  if (state.position)  return res.status(400).json({ success: false, error: "Already in a position. Exit first." });
  const { side } = req.body || {};
  if (side !== "CE" && side !== "PE") return res.status(400).json({ success: false, error: "Side must be CE or PE." });

  const spot = state.lastTickPrice || (state.currentBar ? state.currentBar.close : null);
  if (!spot) return res.status(400).json({ success: false, error: "No market data yet." });

  const clampMin = parseFloat(process.env.TREND_PB_STOP_CLAMP_MIN || "8");
  const slSpot = side === "CE" ? spot - clampMin : spot + clampMin;
  const sig = {
    signal: side === "CE" ? "BUY_CE" : "BUY_PE",
    side, entrySpot: spot, slSpot, targetSpot: null,
    signalStrength: "MANUAL",
    reason: `🖐️ MANUAL ${side} entry @ spot ₹${spot}`,
  };
  log(`🖐️ [TREND_PB-PAPER] MANUAL ${side} entry triggered by user @ spot ₹${spot}`);
  try {
    await simulateBuy(side, sig);
    return res.json({ success: true, side, spot, slSpot });
  } catch (e) {
    log(`❌ [TREND_PB-PAPER] Manual entry failed: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── /status/chart-data — candles + VWAP/EMA overlay + trade markers ───────────
router.get("/status/chart-data", async (req, res) => {
  try {
    let srcCandles = state.candles;
    if (!state.running && srcCandles.length === 0 && (state.sessionTrades || []).length > 0) {
      srcCandles = await chartBackfill.candlesForRestoredTrades(NIFTY_INDEX_SYMBOL, RES_MIN, state.sessionTrades);
    }
    const candles = srcCandles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.currentBar) candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });

    // Overlay: session VWAP + EMA20(5m) as flat "last value" reference lines
    let vwapLine = [], ema5Line = [];
    try {
      const vwap = trendPbStrategy.computeVwap(srcCandles);
      const ema5 = _computeEma(srcCandles, parseInt(process.env.TREND_PB_EMA5_PERIOD || "20", 10));
      if (candles.length) {
        const fromTime = candles[0].time, toTime = candles[candles.length - 1].time;
        if (vwap != null) vwapLine = [{ time: fromTime, value: vwap }, { time: toTime, value: vwap }];
        if (ema5 != null) ema5Line = [{ time: fromTime, value: ema5 }, { time: toTime, value: ema5 }];
      }
    } catch (_) {}

    const markers = [];
    for (const t of state.sessionTrades) {
      if (t.spotAtEntry != null) {
        const c = (t.entryBarTime != null && candles.find(c => c.time === t.entryBarTime)) || candles.find(c => Math.abs(c.close - t.spotAtEntry) < 1) || candles[0];
        if (c) markers.push({ time: c.time, position: 'belowBar', color: '#3b82f6', shape: 'arrowUp', text: (t.side || '') + ' @ ' + t.spotAtEntry });
      }
      if (t.spotAtExit != null) {
        const c = (t.exitBarTime != null && candles.find(c => c.time === t.exitBarTime)) || candles.find(c => Math.abs(c.close - t.spotAtExit) < 1) || candles[candles.length - 1];
        if (c) markers.push({ time: c.time, position: 'aboveBar', color: t.pnl >= 0 ? '#10b981' : '#ef4444', shape: 'arrowDown', text: 'Exit ' + (t.pnl >= 0 ? '+' : '') + Math.round(t.pnl || 0) });
      }
    }

    const stopLoss   = state.position && state.position.slSpot    != null ? state.position.slSpot    : null;
    const entryPrice = state.position && state.position.entrySpot != null ? state.position.entrySpot : null;
    return res.json({ candles, markers, stopLoss, entryPrice, target: null, vwapLine, ema5Line });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const data = loadData();

  // Lightweight bias/indicator snapshot for the header cards (getSignal returns
  // diagnostics even on NONE).
  let diag = {};
  try { const s = trendPbStrategy.getSignal(state.candles, { silent: true }); diag = { trendBias: s.trendBias, vwap: s.vwap, atr5: s.atr5, ema5: s.ema5 }; } catch (_) {}

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    const lot = pos.qty || instrumentConfig.getLotQty();
    livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * lot).toFixed(2));
  }

  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) }); }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const bestTrade = state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null;
  const worstTrade = state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null;

  res.json({
    running: state.running, sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-100),
    tickCount: state.tickCount, lastTickPrice: state.lastTickPrice,
    candles: state.candles.length, currentBar: state.currentBar, sessionStart: state.sessionStart,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge, vix: getCachedVix(),
    trendBias: diag.trendBias || null, vwap: diag.vwap != null ? diag.vwap : null, atr5: diag.atr5 != null ? diag.atr5 : null,
    wins, losses, winRate, bestTrade, worstTrade, cumPnl, livePnl,
    position: pos ? {
      side: pos.side, symbol: pos.symbol, entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      slSpot: pos.slSpot, targetSpot: null, initialSlSpot: pos.initialSlSpot,
      breakevenArmed: pos.breakevenArmed, trailArmed: pos.trailArmed, lastEma: pos.lastEma, lastAtr: pos.lastAtr,
      peakPremium: pos.peakPremium, entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      trendBias: pos.trendBias, pullbackLow: pos.pullbackLow, pullbackHigh: pos.pullbackHigh, riskPts: pos.riskPts,
      qty: pos.qty, currentOptLtp: state.optionLtp,
    } : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

function _tpbCapital() {
  const v = parseFloat(process.env.FYERS_INV_AMOUNT);
  return isNaN(v) ? 100000 : v;
}

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  const data = loadData();
  const pos  = state.position;

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const _vix = getCachedVix();
  const _vixEnabled = (process.env.TREND_PB_VIX_ENABLED || "false").toLowerCase() === "true";
  const _vixMaxEntry = vixFilter.getVixMaxEntry("trend_pb");
  const _maxTrades = parseInt(process.env.TREND_PB_MAX_DAILY_TRADES || "3", 10);
  const _maxLoss   = parseFloat(process.env.TREND_PB_MAX_DAILY_LOSS || "5000");
  const _forcedExit = process.env.TREND_PB_FORCED_EXIT || "15:15";
  const _entryStart = process.env.TREND_PB_ENTRY_START || "09:45";
  const _entryEnd   = process.env.TREND_PB_ENTRY_END   || "14:30";
  const dailyLossHit = state.sessionPnl <= -_maxLoss;

  let _diag = {}; try { const s = trendPbStrategy.getSignal(state.candles, { silent: true }); _diag = { trendBias: s.trendBias, vwap: s.vwap, atr5: s.atr5 }; } catch (_) {}
  const _biasColor = _diag.trendBias === "UP" ? "#10b981" : _diag.trendBias === "DOWN" ? "#ef4444" : "#4a6080";

  const pnlColor = (n) => (n || 0) >= 0 ? "#10b981" : "#ef4444";

  let livePnl = null;
  if (pos && state.optionLtp != null) livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * (pos.qty || instrumentConfig.getLotQty())).toFixed(2));

  const statCards = [
    { label: "Session PnL", value: `<span id="ajax-session-pnl" style="color:${pnlColor(state.sessionPnl)};">${typeof state.sessionPnl === "number" ? (state.sessionPnl >= 0 ? "+" : "") + "₹" + state.sessionPnl.toLocaleString("en-IN", {minimumFractionDigits:2, maximumFractionDigits:2}) : "—"}</span>`, accent: pnlColor(state.sessionPnl) },
    { label: "Trades Today", value: `<span id="ajax-trade-count">${state.tradesTaken || 0}</span> <span style="font-size:0.75rem;color:#4a6080;">/ ${_maxTrades}</span>`, sub: `<span id="ajax-wl">${wins}W · ${losses}L</span>`, accent: "#6a5090" },
    { label: "Live PnL", value: `<span id="ajax-live-pnl" style="color:${livePnl == null ? "#c8d8f0" : pnlColor(livePnl)};">${livePnl == null ? "—" : (livePnl >= 0 ? "+" : "") + "₹" + livePnl.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2})}</span>`, sub: `<span id="ajax-live-pnl-sub">${pos ? "unrealised" : "no open position"}</span>`, accent: "#3b82f6" },
    { label: "Win Rate", value: `<span id="ajax-wr">${winRate != null ? winRate + "%" : "—"}</span>`, sub: `<span id="ajax-wr-sub" style="font-size:0.6rem;color:#4a6080;">single best ${(state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t=>t.pnl||0)).toFixed(0) : "—")} / worst ${(state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t=>t.pnl||0)).toFixed(0) : "—")}</span>`, accent: "#a07010" },
    { label: "Trend Bias", value: `<span id="ajax-trend-bias" style="color:${_biasColor};font-weight:800;">${_diag.trendBias || "—"}</span>`, sub: `<span id="ajax-trend-sub" style="font-size:0.6rem;color:#4a6080;">15m structure${_diag.atr5 != null ? ` · ATR5 ${_diag.atr5}` : ""}</span>`, accent: "#7c3aed" },
    { label: "Daily Loss Limit", value: `<span id="ajax-daily-loss-val" style="color:${dailyLossHit ? "#ef4444" : "#10b981"};">${dailyLossHit ? "HIT" : "OK"} <span style="font-size:0.65rem;color:#4a6080;">/ -₹${_maxLoss.toLocaleString("en-IN")}</span></span>`, sub: `<span id="ajax-daily-loss-sub" style="color:${dailyLossHit ? "#ef4444" : "#10b981"};">${dailyLossHit ? "KILLED — no entries" : "Active"}</span>`, accent: dailyLossHit ? "#ef4444" : "#10b981" },
    { label: "VWAP", value: `<span id="ajax-vwap">${_diag.vwap != null ? "₹" + _diag.vwap : "—"}</span>`, sub: `<span style="font-size:0.6rem;color:#4a6080;">session anchored</span>`, accent: "#2a6080" },
    { label: "WebSocket Ticks", value: `<span id="ajax-tick-count">${(state.tickCount || 0).toLocaleString()}</span>`, sub: `Last: <span id="ajax-last-tick">${state.lastTickPrice ? "₹" + state.lastTickPrice.toLocaleString("en-IN") : "—"}</span>`, accent: "#2a6080" },
    { label: "Session Start", value: `<span style="font-size:0.85rem;color:#c8d8f0;">${state.sessionStart ? fmtISTDateTime(state.sessionStart) : "—"}</span>`, accent: "#2a4020" },
  ];

  const posHtml = pos ? (() => {
    const liveOpt = state.optionLtp;
    const optMove = (liveOpt != null) ? (liveOpt - pos.optionEntryLtp) : null;
    const optMovePct = (liveOpt != null && pos.optionEntryLtp) ? (optMove / pos.optionEntryLtp) * 100 : null;
    const spotMove = (state.lastTickPrice != null) ? (state.lastTickPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1) : null;
    return `
    <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 1.5s infinite;"></span>
          <span style="font-size:0.8rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;">Open Position</span>
          <span style="font-size:0.72rem;color:#4a6080;">Since ${pos.entryTime || "—"}</span>
        </div>
        <button onclick="tpbpHandleExit(this)" style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;">Exit Trade Now</button>
      </div>
      <div style="background:#071a12;border:1px solid #134e35;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:2.2rem;font-weight:900;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side}</span>
            <div>
              <div style="font-size:0.72rem;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side === "CE" ? "CALL · uptrend pullback" : "PUT · downtrend pullback"}</div>
              <span style="font-size:0.65rem;font-weight:700;color:#94a3b8;">${pos.signalStrength || "TREND_PB"}${pos.trendBias ? " · " + pos.trendBias : ""}</span>
            </div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Strike</div><div style="font-size:1.6rem;font-weight:800;color:#fff;font-family:monospace;">${pos.optionStrike ? pos.optionStrike.toLocaleString("en-IN") : "—"}</div></div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Expiry</div><div style="font-size:1.1rem;font-weight:700;color:#f59e0b;">${pos.optionExpiry || "—"}</div></div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Qty</div><div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty}</div></div>
          <div style="width:1px;height:44px;background:#134e35;flex-shrink:0;"></div>
          <div style="flex:1;min-width:200px;"><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Full Symbol</div><div style="font-size:0.82rem;font-weight:600;color:#c8d8f0;font-family:monospace;word-break:break-all;">${pos.symbol}</div></div>
        </div>
      </div>
      <div style="background:#0a0f24;border:2px solid #3b82f6;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
        <div style="font-size:0.68rem;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Option Premium (${pos.side})</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">
          <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid #1e3a5f;border-radius:10px;">
            <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Entry Price</div>
            <div id="ajax-opt-entry-ltp" style="font-size:2rem;font-weight:800;color:#60a5fa;font-family:monospace;line-height:1;">₹${pos.optionEntryLtp ? pos.optionEntryLtp.toFixed(2) : "—"}</div>
          </div>
          <div style="text-align:center;font-size:1.8rem;color:${optMove != null ? (optMove >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};">→</div>
          <div style="text-align:center;padding:12px;background:${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#071a0f" : "#1a0707") : "#0d1320"};border:2px solid ${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};border-radius:10px;">
            <div style="font-size:0.63rem;color:${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Current LTP</div>
            <div id="ajax-opt-current-ltp" style="font-size:2rem;font-weight:800;color:${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">${liveOpt != null ? "₹" + liveOpt.toFixed(2) : "⏳"}</div>
            <div id="ajax-opt-move" style="font-size:0.72rem;font-weight:700;margin-top:6px;color:${optMove != null ? (optMove >= 0 ? "#10b981" : "#ef4444") : "#f59e0b"};">${optMove != null ? (optMove >= 0 ? "▲ +" : "▼ ") + "₹" + Math.abs(optMove).toFixed(2) : "⏳ Polling..."}</div>
            <div id="ajax-opt-pct" style="font-size:1.1rem;font-weight:800;margin-top:4px;color:${optMovePct != null ? (optMovePct >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};font-family:monospace;">${optMovePct != null ? (optMovePct >= 0 ? "+" : "") + optMovePct.toFixed(2) + "%" : "—"}</div>
          </div>
          <div style="text-align:center;padding:12px;background:${livePnl != null ? (livePnl >= 0 ? "#071a0f" : "#1a0707") : "#0d1320"};border:1px solid ${livePnl != null ? (livePnl >= 0 ? "#065f46" : "#7f1d1d") : "#1a2236"};border-radius:10px;">
            <div style="font-size:0.63rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Unrealised P&L</div>
            <div id="ajax-opt-pnl" style="font-size:1.8rem;font-weight:800;color:${livePnl != null ? (livePnl >= 0 ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">${livePnl != null ? (livePnl >= 0 ? "+" : "") + "₹" + livePnl.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2}) : "—"}</div>
            <div style="font-size:0.65rem;color:#4a6080;margin-top:4px;">${pos.qty} qty</div>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;">
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY @ Entry</div><div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">₹${pos.entrySpot ? pos.entrySpot.toFixed(2) : "—"}</div></div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY LTP</div><div id="ajax-nifty-ltp" style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${state.lastTickPrice ? "₹" + state.lastTickPrice.toFixed(2) : "—"}</div><div id="ajax-nifty-move" style="font-size:0.63rem;color:${spotMove != null && spotMove >= 0 ? "#10b981" : "#ef4444"};margin-top:2px;">${spotMove != null ? (spotMove >= 0 ? "▲" : "▼") + " " + Math.abs(spotMove).toFixed(1) + " pts" : "—"}</div></div>
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop${pos.trailArmed ? " (trail)" : pos.breakevenArmed ? " (BE)" : ""}${pos.lastEma ? ` · EMA ${pos.lastEma}` : ""}</div><div style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.slSpot ? "₹" + pos.slSpot.toFixed(2) : "—"}</div></div>
        <div style="background:#10131c;border:1px solid #1e2940;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Initial SL <span style="color:#3a4660;">(risk ${pos.riskPts ? pos.riskPts.toFixed(1) : "—"}pt)</span></div><div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${pos.initialSlSpot ? "₹" + pos.initialSlSpot.toFixed(2) : "—"}</div></div>
        <div style="background:#0a1f12;border:1px solid #0d4030;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Pullback ${pos.side === "CE" ? "Low" : "High"}</div><div style="font-size:1.05rem;font-weight:700;color:#10b981;">${(pos.side === "CE" ? pos.pullbackLow : pos.pullbackHigh) != null ? "₹" + (pos.side === "CE" ? pos.pullbackLow : pos.pullbackHigh).toFixed(2) : "—"}</div></div>
        <div style="background:#0a1f12;border:1px solid #0d4030;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Peak Premium</div><div style="font-size:1.05rem;font-weight:700;color:#10b981;">${pos.peakPremium ? "₹" + pos.peakPremium.toFixed(2) : "—"}</div></div>
      </div>
      ${pos.entryReason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;margin-top:12px;">Entry: ${pos.entryReason}</div>` : ""}
    </div>`;
  })() : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:0.9rem;font-weight:600;color:#4a6080;margin-bottom:14px;">FLAT — ${state.running ? "Waiting for a trend pullback" : "Session stopped"}</div>
      ${state.running ? `<div style="display:flex;gap:10px;justify-content:center;">
        <button onclick="tpbpManualEntry('CE')" style="padding:8px 24px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▲ Manual CE</button>
        <button onclick="tpbpManualEntry('PE')" style="padding:8px 24px;background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▼ Manual PE</button>
      </div>` : ""}
    </div>`;

  const allLogs = [...state.log].reverse();
  const logsJSON = JSON.stringify(allLogs).replace(/<\/script>/gi, "<\\/script>").replace(/`/g, "\\u0060").replace(/\$/g, "\\u0024");
  const tradesJSON = JSON.stringify(state.sessionTrades).replace(/<\/script>/gi, "<\\/script>").replace(/`/g, "\\u0060").replace(/\$/g, "\\u0024");

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
${faviconLink()}
<title>Trend Pullback Paper — ${trendPbStrategy.NAME}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
<style>
${sidebarCSS()}
${modalCSS()}
${bbRsiStyleCSS()}
</style></head>
<body>
<div class="app-shell">
${buildSidebar('trendPbPaper', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/trend-pb-paper/start'`, startLabel: '▶ Start Trend PB',
  showStopBtn: state.running,   stopBtnJs:  `location.href='/trend-pb-paper/stop'`,  stopLabel:  '■ Stop Trend PB',
  showExitBtn: state.running && !!state.position, exitBtnJs: `location.href='/trend-pb-paper/exit'`, exitLabel: '🚪 Exit Trade',
})}
<div class="main-content">

${bbRsiTopBar({
  title: "Trend Pullback Paper Trade",
  metaLine: `Strategy: ${trendPbStrategy.NAME} · Entry ${_entryStart}–${_entryEnd} · Square-off ${_forcedExit} IST · ${state.running ? "Auto-refreshes every 2s" : "Stopped"}`,
  running: state.running,
  vix: { enabled: _vixEnabled, value: _vix, maxEntry: _vixMaxEntry, strongOnly: Infinity },
  primaryAction: { label: "Start Trend PB Paper", href: "/trend-pb-paper/start" },
  stopAction:    { label: "Stop Session",         href: "/trend-pb-paper/stop"  },
  historyHref: "/trend-pb-paper/history",
})}

${bbRsiCapitalStrip({ starting: _tpbCapital(), current: data.capital, allTime: data.totalPnl, startingThreshold: _tpbCapital() })}

${bbRsiStatGrid(statCards)}

${bbRsiCurrentBar({ bar: state.currentBar, resMin: RES_MIN })}

<div id="ajax-position-section" style="margin-bottom:18px;">
${posHtml}
</div>

${process.env.CHART_ENABLED !== "false" ? `<!-- NIFTY Chart -->
<div style="margin-bottom:18px;">
  <div class="section-title">NIFTY ${RES_MIN}-Min Chart (VWAP + EMA20 overlay)</div>
  <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
    <div id="nifty-chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
      <span style="color:#3b82f6;">── VWAP</span> &nbsp;<span style="color:#a78bfa;">── EMA20(5m)</span> &nbsp;<span style="color:#3b82f6;">▲ Entry</span> &nbsp;<span style="color:#f59e0b;">── Stop</span>
    </div>
  </div>
</div>` : ""}

<div id="tpbp-trades-section" style="margin-bottom:18px;">
  <div class="section-title">Session Trades <span id="tpbp-trades-hint" style="color:#4a6080;font-weight:400;letter-spacing:0.5px;text-transform:none;margin-left:8px;">${state.sessionTrades.length} trades</span><a href="/trend-pb-paper/download/trades.jsonl?format=ai" title="Download the full paper-trade log as an AI-friendly Markdown report" style="float:right;font-weight:400;font-size:0.72rem;letter-spacing:0.5px;text-transform:none;color:#4a9cf5;text-decoration:none;">🤖 AI export</a></div>
  <div id="tpbp-trades-box" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;${state.sessionTrades.length ? "" : "padding:24px;text-align:center;color:#4a6080;font-size:0.82rem;"}">${state.sessionTrades.length ? "" : "No trades yet"}</div>
</div>

${bbRsiActivityLog({ logsJSON })}

</div><!-- /main-content -->
</div><!-- /app-shell -->

<script>
${modalJS()}
async function tpbpHandleExit(btn) {
  var ok = await showConfirm({ icon:'🚪', title:'Exit position', message:'Exit current Trend Pullback position now?', confirmText:'Exit', confirmClass:'modal-btn-danger' });
  if (!ok) return;
  btn.disabled = true; btn.textContent = 'Exiting...';
  fetch('/trend-pb-paper/exit').then(function(){ location.reload(); }).catch(function(){ location.reload(); });
}
async function tpbpManualEntry(side) {
  var ok = await showConfirm({ icon:'✋', title:'Manual entry', message:'Manual '+side+' entry at current spot? Bypasses the trend/pullback filter.', confirmText:'Enter '+side });
  if (!ok) return;
  try {
    var r = await fetch('/trend-pb-paper/manualEntry', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ side: side }) });
    var j = await r.json();
    if (!j.success) { alert('Entry failed: ' + (j.error || 'Unknown error')); return; }
    location.reload();
  } catch (e) { alert('Error: ' + e.message); location.reload(); }
}
</script>

<script>
(function(){
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var container = document.getElementById('nifty-chart');
  if (!container) return;
  var chart = LightweightCharts.createChart(container, {
    width: container.clientWidth, height: container.clientHeight,
    layout:{ background:{type:'solid',color:'#0a0f1c'}, textColor:'#4a6080', fontSize:11, fontFamily:"'IBM Plex Mono', monospace" },
    grid:{ vertLines:{color:'#111827'}, horzLines:{color:'#111827'} },
    crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale:{ borderColor:'#1a2236' },
    timeScale:{ borderColor:'#1a2236', timeVisible:true, secondsVisible:false,
      tickMarkFormatter:function(t){ var d=new Date(t*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); } },
  });
  var cs = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var vwapS = chart.addLineSeries({ color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var ema5S = chart.addLineSeries({ color:'#a78bfa', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var entryLine = null, slLine = null, _zoomed = false;
  async function fetchChart(){
    try {
      var r = await fetch('/trend-pb-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) { (function(){
        var _lt=d.candles[d.candles.length-1].time, _dk=Math.floor((_lt+19800)/86400), _cut=_lt;
        for (var _i=d.candles.length-1;_i>=0;_i--){ if(Math.floor((d.candles[_i].time+19800)/86400)===_dk) _cut=d.candles[_i].time; else break; }
        var _k=function(a){ return Array.isArray(a)?a.filter(function(x){return x.time>=_cut;}):a; };
        d.candles=_k(d.candles);
        ['vwapLine','ema5Line','markers'].forEach(function(kk){ if(d[kk]) d[kk]=_k(d[kk]); });
      })(); }
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        if (!_zoomed) {
          try {
            var lastT = d.candles[d.candles.length - 1].time, dayK = Math.floor((lastT + 19800) / 86400), firstT = lastT;
            for (var i = d.candles.length - 1; i >= 0; i--) { if (Math.floor((d.candles[i].time + 19800) / 86400) === dayK) firstT = d.candles[i].time; else break; }
            chart.timeScale().setVisibleRange({ from: firstT, to: lastT }); _zoomed = true;
          } catch(_) {}
        }
      }
      vwapS.setData(d.vwapLine || []);
      ema5S.setData(d.ema5Line || []);
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      if (entryLine) { cs.removePriceLine(entryLine); entryLine = null; }
      if (slLine)    { cs.removePriceLine(slLine);    slLine = null; }
      if (d.entryPrice) entryLine = cs.createPriceLine({ price:d.entryPrice, color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
      if (d.stopLoss)   slLine    = cs.createPriceLine({ price:d.stopLoss,   color:'#f59e0b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'Stop' });
    } catch (e) {}
  }
  fetchChart();
  if (${state.running}) setInterval(fetchChart, 4000);
  window.addEventListener('resize', function(){ chart.applyOptions({ width: container.clientWidth }); });
})();
</script>

<script>
(function(){
  var INR = function(n){ return typeof n==='number' ? '₹'+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; };
  var PNL_COLOR = function(n){ return (n||0)>=0 ? '#10b981' : '#ef4444'; };
  var _lastHasPosition = ${pos ? "true" : "false"};
  var _lastTradeCount  = ${state.sessionTrades.length};
  var _lastLogCount    = ${state.log.length};
  var _lastRunning     = ${state.running};
  var _maxLoss         = ${_maxLoss};
  var _interval        = null;

  function setText(id, val){ var el=document.getElementById(id); if(el && el.textContent !== String(val)) el.textContent = val; }

  function renderTrades(trades){
    var box = document.getElementById('tpbp-trades-box');
    var hint = document.getElementById('tpbp-trades-hint');
    if (hint) hint.textContent = trades.length + ' trade' + (trades.length===1?'':'s');
    if (!box) return;
    if (!trades.length) { box.style.cssText = 'background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:24px;text-align:center;color:#4a6080;font-size:0.82rem;'; box.innerHTML = 'No trades yet'; return; }
    box.style.cssText = 'background:#0d1320;border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;';
    var rows = trades.slice().reverse().map(function(t){
      var pc = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
      var sc = t.side === 'CE' ? '#10b981' : '#ef4444';
      return '<tr style="border-top:1px solid #1a2236;">' +
        '<td style="padding:8px 12px;font-size:0.7rem;color:#94a3b8;">' + (t.entryTime||'') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.7rem;color:#94a3b8;">' + (t.exitTime||'') + '</td>' +
        '<td style="padding:8px 12px;color:' + sc + ';font-weight:800;">' + (t.side||'—') + '</td>' +
        '<td style="padding:8px 12px;font-weight:700;">' + (t.spotAtEntry||'—') + '</td>' +
        '<td style="padding:8px 12px;font-weight:700;">' + (t.spotAtExit||'—') + '</td>' +
        '<td style="padding:8px 12px;color:#60a5fa;">' + (t.optionEntryLtp!=null?'₹'+t.optionEntryLtp:'—') + '</td>' +
        '<td style="padding:8px 12px;color:#60a5fa;">' + (t.optionExitLtp!=null?'₹'+t.optionExitLtp:'—') + '</td>' +
        '<td style="padding:8px 12px;font-weight:800;color:' + pc + ';">' + (t.pnl!=null?(t.pnl>=0?'+':'')+'₹'+t.pnl.toFixed(2):'—') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.65rem;color:#4a6080;">' + (t.exitReason||'') + '</td>' +
      '</tr>';
    }).join('');
    box.innerHTML = '<table style="width:100%;border-collapse:collapse;font-family:monospace;font-size:0.78rem;">' +
      '<thead><tr style="background:#0a0f1c;">' +
        ['Entry Time','Exit Time','Side','E.Spot','X.Spot','E.Opt','X.Opt','PnL','Exit Reason'].map(function(h){ return '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">'+h+'</th>'; }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function fetchAndUpdate(){
    try {
      var r = await fetch('/trend-pb-paper/status/data', { cache:'no-store' });
      if (!r.ok) return;
      var d = await r.json();
      var pnlEl = document.getElementById('ajax-session-pnl');
      if (pnlEl) { pnlEl.textContent = (d.sessionPnl>=0?'+':'') + INR(d.sessionPnl); pnlEl.style.color = PNL_COLOR(d.sessionPnl); var card = pnlEl.closest('.sc'); if (card) card.style.borderTopColor = PNL_COLOR(d.sessionPnl); }
      setText('ajax-trade-count', d.tradesTaken || 0);
      setText('ajax-wl', (d.wins||0) + 'W · ' + (d.losses||0) + 'L');
      var livePnlEl = document.getElementById('ajax-live-pnl');
      if (livePnlEl) { if (d.livePnl != null) { livePnlEl.textContent = (d.livePnl>=0?'+':'') + INR(d.livePnl); livePnlEl.style.color = PNL_COLOR(d.livePnl); } else { livePnlEl.textContent = '—'; livePnlEl.style.color = '#c8d8f0'; } }
      setText('ajax-live-pnl-sub', d.position ? 'unrealised' : 'no open position');
      setText('ajax-wr', d.winRate != null ? d.winRate + '%' : '—');
      var bestN = (d.bestTrade != null) ? Math.round(d.bestTrade) : null, worstN = (d.worstTrade != null) ? Math.round(d.worstTrade) : null;
      setText('ajax-wr-sub', 'single best ' + (bestN==null?'—':bestN) + ' / worst ' + (worstN==null?'—':worstN));
      var biasEl = document.getElementById('ajax-trend-bias');
      if (biasEl) { biasEl.textContent = d.trendBias || '—'; biasEl.style.color = d.trendBias === 'UP' ? '#10b981' : d.trendBias === 'DOWN' ? '#ef4444' : '#4a6080'; }
      setText('ajax-trend-sub', '15m structure' + (d.atr5 != null ? ' · ATR5 ' + d.atr5 : ''));
      setText('ajax-vwap', d.vwap != null ? '₹' + d.vwap : '—');
      var dlossHit = (d.sessionPnl || 0) <= -_maxLoss;
      var dlEl = document.getElementById('ajax-daily-loss-val'); if (dlEl) dlEl.style.color = dlossHit ? '#ef4444' : '#10b981';
      var dlSub = document.getElementById('ajax-daily-loss-sub'); if (dlSub) { dlSub.textContent = dlossHit ? 'KILLED — no entries' : 'Active'; dlSub.style.color = dlossHit ? '#ef4444' : '#10b981'; }
      setText('ajax-tick-count', (d.tickCount || 0).toLocaleString());
      setText('ajax-last-tick', d.lastTickPrice ? INR(d.lastTickPrice) : '—');
      var capEl = document.getElementById('ajax-current-capital'); if (capEl) { capEl.textContent = INR(d.capital); capEl.style.color = d.capital >= ${_tpbCapital()} ? '#10b981' : '#ef4444'; }
      var atpEl = document.getElementById('ajax-alltime-pnl'); if (atpEl) { atpEl.textContent = (d.totalPnl >= 0 ? '+' : '') + INR(d.totalPnl); atpEl.style.color = PNL_COLOR(d.totalPnl); }
      if (d.currentBar) { ['open','high','low','close'].forEach(function(k){ var el = document.getElementById('ajax-bar-' + k); if (el) el.textContent = INR(d.currentBar[k]); }); }
      var nowHasPosition = !!d.position;
      if (nowHasPosition !== _lastHasPosition) { _lastHasPosition = nowHasPosition; window.location.reload(); return; }
      if (d.position) {
        var p = d.position, curOpt = p.currentOptLtp;
        var optMove = curOpt != null ? (curOpt - p.optionEntryLtp) : null;
        var optMovePct = (curOpt != null && p.optionEntryLtp) ? (optMove / p.optionEntryLtp * 100) : null;
        var entEl = document.getElementById('ajax-opt-entry-ltp'); if (entEl) entEl.textContent = p.optionEntryLtp ? '₹' + p.optionEntryLtp.toFixed(2) : '—';
        var curEl = document.getElementById('ajax-opt-current-ltp'); if (curEl && curOpt != null) { curEl.textContent = '₹' + curOpt.toFixed(2); curEl.style.color = curOpt >= p.optionEntryLtp ? '#10b981' : '#ef4444'; }
        var movEl = document.getElementById('ajax-opt-move'); if (movEl && optMove != null) { movEl.textContent = (optMove >= 0 ? '▲ +' : '▼ ') + '₹' + Math.abs(optMove).toFixed(2); movEl.style.color = optMove >= 0 ? '#10b981' : '#ef4444'; }
        var pctEl = document.getElementById('ajax-opt-pct'); if (pctEl && optMovePct != null) { pctEl.textContent = (optMovePct >= 0 ? '+' : '') + optMovePct.toFixed(2) + '%'; pctEl.style.color = optMovePct >= 0 ? '#10b981' : '#ef4444'; }
        var optPnlEl = document.getElementById('ajax-opt-pnl'); if (optPnlEl && d.livePnl != null) { optPnlEl.textContent = (d.livePnl >= 0 ? '+' : '') + INR(d.livePnl); optPnlEl.style.color = PNL_COLOR(d.livePnl); }
        var ltpEl = document.getElementById('ajax-nifty-ltp'); if (ltpEl && d.lastTickPrice != null) ltpEl.textContent = INR(d.lastTickPrice);
        var ltpSub = document.getElementById('ajax-nifty-move');
        if (ltpSub && d.lastTickPrice != null && p.entrySpot) { var sm = (d.lastTickPrice - p.entrySpot) * (p.side === 'CE' ? 1 : -1); ltpSub.textContent = (sm >= 0 ? '▲' : '▼') + ' ' + Math.abs(sm).toFixed(1) + ' pts'; ltpSub.style.color = sm >= 0 ? '#10b981' : '#ef4444'; }
      }
      if ((d.sessionTrades || []).length !== _lastTradeCount) { _lastTradeCount = (d.sessionTrades || []).length; renderTrades(d.sessionTrades || []); }
      if ((d.log || []).length !== _lastLogCount) { _lastLogCount = (d.log || []).length; LOG_ALL.length = 0; (d.log || []).slice().reverse().forEach(function(l){ LOG_ALL.push(l); }); if (typeof logFilter === 'function') logFilter(); }
      if (_lastRunning && !d.running) { _lastRunning = false; if (_interval) { clearInterval(_interval); _interval = null; } setTimeout(function(){ window.location.reload(); }, 1500); }
    } catch (e) { console.warn('[trend-pb-paper] refresh:', e.message); }
  }

  renderTrades(${tradesJSON});
  if (${state.running}) { _interval = setInterval(fetchAndUpdate, 2000); fetchAndUpdate(); }
  document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'visible' && ${state.running}) { fetchAndUpdate(); if (!_interval) _interval = setInterval(fetchAndUpdate, 2000); } });
  window.addEventListener('focus', function(){ if (${state.running}) fetchAndUpdate(); });
})();
</script>

</body></html>`);
});

// ── History + daily-file viewers + restore + reset ────────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  res.send(renderHistoryPage({
    routePrefix: "/trend-pb-paper",
    sidebarKey: "trendPbHistory",
    pageTitle: "📈 Trend Pullback Paper Trade History",
    pageDocTitle: "Trend Pullback Paper — History",
    modalLabel: "Trend Pullback Paper",
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap,
    emptyLabel: "Start Trend Pullback paper trading to record your first session.",
  }));
});

const _TPB_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/download/daily-files", (req, res) => {
  const skips  = skipLogger.listDates("trend_pb");
  const trades = tradeLogger.listDailyDates("trend_pb");
  const byDate = new Map();
  for (const s of skips)  byDate.set(s.date, { date: s.date, skipsSize: s.size, tradesSize: 0 });
  for (const t of trades) { const row = byDate.get(t.date) || { date: t.date, skipsSize: 0, tradesSize: 0 }; row.tradesSize = t.size; byDate.set(t.date, row); }
  const rows = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  res.json(dailyFilesPaginate(rows, req.query));
});

router.get("/download/skips-all", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="trend_pb_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates("trend_pb").map(d => d.date).sort();
  let body = "";
  for (const d of dates) { try { const p = skipLogger.filePathFor("trend_pb", d); if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8"); } catch (_) {} }
  res.send(body);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_TPB_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor("trend_pb", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_TPB_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor("trend_pb", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop Trend Pullback paper trading first before deleting a session." });
  const data = loadData();
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= (data.sessions || []).length) return res.status(400).json({ success: false, error: "Invalid session index." });
  data.sessions.splice(idx, 1);
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, message: "Session deleted successfully." });
});

router.post("/restore-session/:date", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop Trend Pullback paper trading before restoring." });
  const date = String(req.params.date || "").trim();
  if (!_TPB_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades("trend_pb", date);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; if (key) seen.add(String(key)); }
  const missing = allTrades.filter(t => { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; return key && !seen.has(String(key)); });
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
  data.sessions.push({ date, strategy: (missing[0] && missing[0].strategy) || "TREND_PULLBACK", pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop Trend Pullback paper trading before resetting." });
  const fresh = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  return res.json({ success: true, message: `Trend Pullback paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
});

router.post("/delete-session/:idx", (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const data = loadData();
    if (!Number.isFinite(idx) || idx < 0 || idx >= (data.sessions || []).length) return res.status(400).json({ success: false, error: "Invalid session index" });
    const removed = data.sessions.splice(idx, 1)[0];
    data.totalPnl = parseFloat((data.totalPnl - (removed.pnl || 0)).toFixed(2));
    saveData(data);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get("/download/trades.jsonl", (req, res) => {
  try {
    const data = loadData();
    const records = [];
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) records.push(Object.assign({ date: s.date, mode: "trend_pb", strategy: s.strategy }, t));
    const today = new Date().toISOString().slice(0, 10);
    const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
    if (ai) {
      const md = aiExport.buildMarkdown(records, { title: "Trend Pullback paper trades (full log)", source: "trend-pb-paper" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="trend_pb_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="trend_pb_paper_trades_${today}.jsonl"`);
    res.send(records.map(r => JSON.stringify(r)).join("\n"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function _errorPage(title, message, backHref, backLabel) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>${faviconLink()}<title>${title}</title>
<style>body{font-family:Inter,sans-serif;background:#040c18;color:#e0eaf8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{color:#94a3b8;margin-bottom:18px;}
a{color:#3b82f6;text-decoration:none;border:0.5px solid #0e1e36;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>${title}</h2><p>${message}</p><a href="${backHref}">${backLabel}</a></body></html>`;
}

module.exports = router;
module.exports.stopSession = stopSession;

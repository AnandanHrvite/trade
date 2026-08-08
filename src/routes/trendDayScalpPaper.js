/**
 * TREND DAY SCALP PAPER — /trend-day-scalp-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL surface. Every decision / fill / exit semantic for TREND_DAY_SCALP
 * lives here; the backtest and the live harness must match THIS, never the
 * reverse (see feedback_paper_logic_untouchable).
 *
 * The day in one paragraph: at TDS_GATE_TIME (10:15) the engine looks at the
 * first hour once and decides whether the day trends at all and in which
 * direction. Most days the answer is "no trade", and that ZERO is the design
 * goal — a naked long option bleeds theta through a ranging session. When the
 * gate passes, the side is LOCKED for the day and the route hunts a pullback
 * into the VWAP/EMA20 zone that is immediately reclaimed. Up to
 * TDS_MAX_DAILY_TRADES entries, each with the same fixed risk.
 *
 * Exits, in the order they are tested on every tick:
 *   1. hard stop      — the pullback extreme, floored to TDS_MIN_SL_PTS
 *   2. fixed target   — entry ± TDS_TARGET_R × the stop distance
 *   3. breakeven jump — at +TDS_BREAKEVEN_R the stop moves ONCE to
 *                       entry ± TDS_BREAKEVEN_BUFFER_PTS, then never again
 *   4. time stop      — flat if +1R was not reached within TDS_TIME_STOP_MINS
 *   5. premium stop   — the option itself lost TDS_PREMIUM_STOP_PCT%
 *   6. EOD square-off at TDS_FORCED_EXIT
 * There is deliberately NO rolling trail and no partial booking.
 *
 * Day-level breakers: TDS_MAX_DAILY_LOSS, TDS_DAILY_PROFIT_LOCK (stop while
 * ahead — giving profit back is what wrecks a steady curve) and
 * TDS_MAX_DAILY_LOSSES consecutive-of-the-day stop-outs. A breakeven or
 * time-stop exit does NOT burn one of those losses — only a real stop-out does.
 *
 * Signal engine: src/strategies/trend_day_scalp.js (shared by paper, backtest,
 * live harness and replay — no rule is re-implemented in this file).
 *
 * Uses LIVE NIFTY data (Fyers WebSocket) but SIMULATES orders locally.
 * Endpoints: /start /stop /exit /status /status/data /status/chart-data
 *            /history /reset /session/:i /download/... /view/...
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const tdsStrategy        = require("../strategies/trend_day_scalp");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { renderHistoryPage, dailyFilesPaginate } = require("../utils/paperHistoryUI");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiCapitalStrip, bbRsiStatGrid, bbRsiCurrentBar, bbRsiActivityLog, inr } = require("../utils/bbRsiStyleUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const tradeLogger = require("../utils/tradeLogger");
const chartBackfill = require("../utils/chartBackfill");
const aiExport    = require("../utils/aiExport");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { getISTMinutes, getBucketStart } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");
const capitalPool = require("../utils/capitalPool");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "trendDayScalpPaper";
const MODE_KEY           = "trend_day_scalp";     // tradeLogger / skipLogger key

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "trend_day_scalp_paper_trades.json");

// ── Config readers (Settings mutates process.env live — never cache) ──────────
function _resMin() {
  const v = parseInt(process.env.TDS_RESOLUTION || "5", 10);
  return [1, 3, 5, 10, 15, 30, 60].includes(v) ? v : 5;
}
function _parseMins(envKey, fallback) {
  return tdsStrategy._parseHHMM(process.env[envKey], tdsStrategy._parseHHMM(fallback, 0));
}
function _envStr(key, fallback) { return String(process.env[key] || fallback); }
function _maxDailyTrades()  { return Math.max(1, parseInt(process.env.TDS_MAX_DAILY_TRADES || "2", 10) || 2); }
function _maxDailyLosses()  { return Math.max(0, parseInt(process.env.TDS_MAX_DAILY_LOSSES || "2", 10)); }
function _maxDailyLoss()    { return parseFloat(process.env.TDS_MAX_DAILY_LOSS   || "1500"); }
function _dailyProfitLock() { return parseFloat(process.env.TDS_DAILY_PROFIT_LOCK || "1500"); }
function _maxWeeklyLoss()   { return parseFloat(process.env.TDS_MAX_WEEKLY_LOSS  || "0"); }

/**
 * Position size. TDS_LOT_MULTIPLIER (when > 0) overrides the global
 * LOT_MULTIPLIER for this strategy only, clamped by the same MAX_LOT_MULTIPLIER
 * ceiling. Divides by the multiplier getLotQty ACTUALLY applied (it clamps
 * internally), not the raw env value.
 */
function tdsLotQty() {
  const base = instrumentConfig.getLotQty();
  const raw  = parseInt(process.env.TDS_LOT_MULTIPLIER || "0", 10);
  if (!Number.isFinite(raw) || raw <= 0) return base;

  let maxMult = parseInt(process.env.MAX_LOT_MULTIPLIER || "10", 10);
  if (!Number.isFinite(maxMult) || maxMult < 1) maxMult = 10;

  let globalMult = parseInt(process.env.LOT_MULTIPLIER || "1", 10);
  if (!Number.isFinite(globalMult) || globalMult <= 0) globalMult = 1;
  if (globalMult > maxMult) globalMult = maxMult;

  return Math.round((base / globalMult) * Math.min(raw, maxMult));
}

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
    console.error("[tds-paper] trend_day_scalp_paper_trades.json corrupt — resetting:", e.message);
    _dataCache = { capital: parseFloat(process.env.FYERS_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(_dataCache, null, 2));
  }
  return _dataCache;
}
function saveData(d) {
  ensureDir();
  _dataCache = d;
  fs.writeFileSync(PT_FILE, JSON.stringify(d, null, 2));
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
    stopOuts:       0,      // only REAL stop-outs count toward TDS_MAX_DAILY_LOSSES
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
    // TREND_DAY_SCALP specific
    dayGate:        null,   // FROZEN evaluateDayGate() result — decided once at 10:15
    gateLoggedAt:   null,
    dayClosed:      false,  // a day-level breaker has ended trading for today
    dayClosedReason: null,
    lastSignal:     null,
    _entryInFlight: false,
    _lastEntryAttemptMs: null,
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
    const all = tradeLogger.readDailyTrades(MODE_KEY, today)
      .filter(t => t && !t.type && (t.side || t.entryTime || t.entryBarTime || t.symbol));
    const seen = new Set();
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) seen.add(keyOf(t));
    let trades = all.filter(t => !seen.has(keyOf(t)));
    let source = "today's live session";
    let stale  = false;
    if (!trades.length) {
      const saved = (data.sessions || []).filter(s => Array.isArray(s.trades) && s.trades.length);
      if (saved.length) {
        const last = saved.reduce((a, b) => (String(b.date) > String(a.date) ? b : a));
        trades = last.trades;
        source = `last session (${last.date || "?"})`;
        stale  = all.length === 0;
      }
    }
    if (!trades.length) return;
    state._staleSession = stale;
    state.sessionTrades = trades;
    state.tradesTaken   = trades.length;
    // Rebuild the stop-out counter so a restart cannot hand back losses the
    // breaker had already spent.
    state.stopOuts = trades.filter(t => /Stop hit/i.test(String(t.exitReason || ""))).length;
    state.sessionPnl = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    if (!state.sessionStart) state.sessionStart = trades[0].entryTime || trades[0].loggedAt || null;
    console.log(`♻️ [TDS-PAPER] Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl}, ${state.stopOuts} stop-out(s))`);
  } catch (err) {
    console.warn(`[TDS-PAPER] session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => state, "[TDS-PAPER]");

/**
 * Realised P&L for the current ISO week (Mon → today) from the per-day JSONL
 * logs. While RUNNING, today's contribution comes from the in-memory session
 * (the day file lags by an event-loop tick); when idle we must read the FILE,
 * because state.sessionPnl may still hold a rehydrated previous session.
 */
function weeklyPnl() {
  try {
    const nowIst = new Date(Date.now() + 19800000);
    const dow = nowIst.getUTCDay();
    const backToMon = dow === 0 ? 6 : dow - 1;
    const todayStr = tradeLogger.istDateString(Date.now());
    let total = 0;
    for (let i = backToMon; i >= 0; i--) {
      const d = new Date(nowIst.getTime() - i * 86400000);
      const ds = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      if (ds === todayStr && state.running) { total += state.sessionPnl; continue; }
      const trades = tradeLogger.readDailyTrades(MODE_KEY, ds) || [];
      for (const t of trades) if (t && !t.type && typeof t.pnl === "number") total += t.pnl;
    }
    return parseFloat(total.toFixed(2));
  } catch (_) {
    return state.running ? state.sessionPnl : 0;
  }
}

// ── Option LTP polling ───────────────────────────────────────────────────────
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
            try { tickRecorder.recordOptionLtp(state.position.symbol, ltp, "trend-day-scalp-paper"); } catch (_) {}
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

// ── Trade simulation ─────────────────────────────────────────────────────────
async function simulateBuy(side, sig) {
  const spot = state.lastTickPrice;
  if (!spot || !side) return;

  let optInfo;
  try {
    optInfo = await instrumentConfig.validateAndGetOptionSymbol(spot, side, "TDS");
  } catch (e) {
    log(`❌ [TDS-PAPER] Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ [TDS-PAPER] No valid expiry — skip ${side} entry`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "expiry", reason: "no valid option expiry", side, spot });
    return;
  }

  let optionEntryLtp = null;
  try {
    const r = await fyers.getQuotes([optInfo.symbol]);
    if (r && r.s === "ok" && r.d && r.d.length) {
      const v = r.d[0].v || {};
      const ltp = v.lp || v.ltp;
      if (typeof ltp === "number" && ltp > 0) {
        optionEntryLtp = ltp;
        try { tickRecorder.recordOptionLtp(optInfo.symbol, ltp, "trend-day-scalp-paper"); } catch (_) {}
      }
    }
  } catch (e) {
    log(`⚠️ [TDS-PAPER] Option LTP fetch failed: ${e.message} — entry blocked`);
    return;
  }
  if (!optionEntryLtp) {
    log(`❌ [TDS-PAPER] Option LTP not available — entry skipped`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "option_ltp", reason: "no option LTP", symbol: optInfo.symbol, side, spot });
    return;
  }

  const qty = tdsLotQty();

  // The engine sized the stop from the SIGNAL bar's close; we fill at the live
  // spot a moment later. Re-anchor the whole bracket to the ACTUAL fill so the
  // risk stays exactly slPts and the 2.5R target stays exactly 2.5R — carrying
  // the engine's levels across would silently change both.
  const slPts = sig.slPts;
  if (typeof slPts !== "number" || !Number.isFinite(slPts) || slPts <= 0) {
    log(`🚫 [TDS-PAPER] Entry ABORTED — stop distance unusable (${slPts}). Refusing to enter without a stop.`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "stop_uncomputable", reason: `stop distance unusable (${slPts})`, side, spot });
    return;
  }
  const cfg = tdsStrategy.getConfig();
  const dir = side === "CE" ? 1 : -1;
  const slSpot     = parseFloat((spot - dir * slPts).toFixed(2));
  const targetSpot = parseFloat((spot + dir * cfg.targetR * slPts).toFixed(2));
  const beArmSpot  = parseFloat((spot + dir * cfg.breakevenR * slPts).toFixed(2));
  const beStopSpot = parseFloat((spot + dir * cfg.breakevenBuffer).toFixed(2));

  // Capital check — advisory only: an overdrawn pool raises a dashboard alert,
  // it never stops a paper trade. Sits AFTER the last abort path.
  const _cap = capitalPool.check(MODE_KEY, qty * optionEntryLtp);
  if (!_cap.ok) {
    log(`⚠️ [TDS-PAPER] ${_cap.reason} — entry taken anyway, pool now overdrawn`);
    capitalPool.noteShortfall(MODE_KEY, _cap, { side, symbol: optInfo.symbol });
  }

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
    entryUnixSec:   Math.floor(Date.now() / 1000),
    entryBarTime:   Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    slPts,
    slSpot,
    initialSlSpot:  slSpot,
    targetSpot,
    beArmSpot,
    beStopSpot,
    beArmed:        false,
    riskPts:        slPts,
    targetR:        cfg.targetR,
    breakevenR:     cfg.breakevenR,
    timeStopMins:   cfg.timeStopMins,
    premiumStopPct: cfg.premiumStopPct,
    // Signal context (kept on the trade record for analytics / reports)
    signalSpot:     sig.entrySpot,
    slRawPts:       sig.slRaw,
    slClamped:      sig.slClamped,
    zone:           sig.zone,
    vwapAtEntry:    sig.vwap,
    emaAtEntry:     sig.ema,
    atrAtEntry:     sig.atr,
    bodyPts:        sig.bodyPts,
    bodyNeeded:     sig.bodyNeeded,
    pullbackLow:    sig.pullbackLow,
    pullbackHigh:   sig.pullbackHigh,
    gateSide:       state.dayGate ? state.dayGate.side : null,
    gateRangePts:   state.dayGate ? state.dayGate.rangePts : null,
    gateRangePct:   state.dayGate ? state.dayGate.rangePct : null,
    gateVwap:       state.dayGate ? state.dayGate.vwap : null,
    gateExtensionPts: state.dayGate ? state.dayGate.extensionPts : null,
    peakPremium:    optionEntryLtp,
    signalStrength: sig.signalStrength,
    mfeSpotPts:     0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
    entryReason:    sig.reason,
  };

  state.position = pos;
  capitalPool.block(MODE_KEY, qty * optionEntryLtp, { side, symbol: optInfo.symbol, qty, premium: optionEntryLtp });
  try { require("../utils/positionPersist").saveTrendDayScalpPosition(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  state.optionLtp = optionEntryLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;
  startOptionPolling();

  log(`🟢 [TDS-PAPER] BUY_${side} ${optInfo.symbol} qty=${qty} @ spot=${spot} optLtp=₹${optionEntryLtp}`);
  log(`   ├─ Day gate: ${pos.gateSide} day · first-hour range ${pos.gateRangePts}pt (${pos.gateRangePct}%) · VWAP ${pos.gateVwap} · extension ${pos.gateExtensionPts}pt`);
  log(`   ├─ Setup: pullback to zone ${pos.zone} (VWAP ${pos.vwapAtEntry} / EMA ${pos.emaAtEntry}) → reclaim, body ${pos.bodyPts}pt ≥ ${pos.bodyNeeded}pt (ATR ${pos.atrAtEntry})`);
  log(`   └─ SL ${slSpot} (${slPts}pt${pos.slClamped ? `, floored from ${pos.slRawPts}pt` : ""}) · TGT ${targetSpot} (${cfg.targetR}R) · BE arms ${beArmSpot} → stop ${beStopSpot} · time-stop ${cfg.timeStopMins}m · premium stop -${cfg.premiumStopPct}% · EOD ${_envStr("TDS_FORCED_EXIT", "15:10")}`);

  notifyEntry({
    mode: "TREND-DAY-SCALP-PAPER",
    side, symbol: optInfo.symbol,
    spotAtEntry: spot, optionEntryLtp,
    qty, stopLoss: slSpot, target: targetSpot,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "trend-day-scalp-paper",
      sessionId: state._sessionId,
      ts: Date.now(),
      side, symbol: optInfo.symbol, qty,
      spotEntry: spot, optionEntry: optionEntryLtp,
      stopLoss: slSpot, target: targetSpot, beArmSpot,
      reason: pos.entryReason,
    });
  } catch (_) {}
}

function simulateSell(reason, opts) {
  if (!state.position) return;
  const o = opts || {};
  const pos = state.position;
  const exitOptLtp = state.optionLtp || pos.optionEntryLtp;
  const exitSpot   = state.lastTickPrice || pos.entrySpot;
  const qty        = pos.qty;
  const charges    = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitOptLtp, qty });
  const pnl        = parseFloat(((exitOptLtp - pos.optionEntryLtp) * qty - charges).toFixed(2));

  state.sessionPnl = parseFloat((state.sessionPnl + pnl).toFixed(2));
  if (pnl < 0) state.consecutiveLosses++; else if (pnl > 0) state.consecutiveLosses = 0;
  // Only a REAL stop-out burns one of the day's allowed losses. A breakeven
  // exit or a time stop is a scratch, not a bad read (locked decision — see the
  // route header). isStopOut is set by the caller, never inferred from the sign
  // of the P&L, so a stop that happens to net positive still counts.
  if (o.isStopOut) state.stopOuts++;

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
    exitBarTime:    Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    pnl,
    pnlMode:        `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp}`,
    exitReason:     reason,
    entryReason:    pos.entryReason,
    stopLoss:       pos.slSpot,
    initialStopLoss: pos.initialSlSpot,
    target:         pos.targetSpot,
    beArmSpot:      pos.beArmSpot,
    beArmed:        !!pos.beArmed,
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    optionType:     pos.side,
    optionEntrySymbol: pos.symbol,
    signalStrength: pos.signalStrength,
    riskPts:        pos.riskPts,
    targetR:        pos.targetR,
    // TREND_DAY_SCALP signal context
    slRawPts:       pos.slRawPts,
    slClamped:      pos.slClamped,
    zone:           pos.zone,
    vwapAtEntry:    pos.vwapAtEntry,
    emaAtEntry:     pos.emaAtEntry,
    atrAtEntry:     pos.atrAtEntry,
    bodyPts:        pos.bodyPts,
    pullbackLow:    pos.pullbackLow,
    pullbackHigh:   pos.pullbackHigh,
    gateSide:       pos.gateSide,
    gateRangePts:   pos.gateRangePts,
    gateRangePct:   pos.gateRangePct,
    gateVwap:       pos.gateVwap,
    gateExtensionPts: pos.gateExtensionPts,
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
  tradeLogger.appendTradeLog(MODE_KEY, trade);

  log(`🔴 [TDS-PAPER] EXIT ${pos.side} ${pos.symbol} @ optLtp=₹${exitOptLtp} spot=${exitSpot} | PnL=₹${pnl} (${reason})`);

  notifyExit({
    mode: "TREND-DAY-SCALP-PAPER",
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
      mode: "trend-day-scalp-paper", sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitOptLtp, pnl, reason,
    });
  } catch (_) {}

  state.position = null;
  capitalPool.release(MODE_KEY, pnl);
  try { require("../utils/positionPersist").clearTrendDayScalpPosition(); } catch (_) {}
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;
  stopOptionPolling();

  _applyDayBreakers();
}

/**
 * Day-level breakers, evaluated after every exit. Each one CLOSES the day —
 * TREND_DAY_SCALP would rather book a small green day than hand it back.
 */
function _applyDayBreakers() {
  if (state.dayClosed) return;
  const maxLoss = _maxDailyLoss();
  const lock    = _dailyProfitLock();
  const maxOuts = _maxDailyLosses();

  if (maxLoss > 0 && state.sessionPnl <= -maxLoss) {
    _closeDay(`Daily loss cap hit (₹${state.sessionPnl} ≤ -₹${maxLoss})`);
    return;
  }
  if (lock > 0 && state.sessionPnl >= lock) {
    _closeDay(`Daily profit lock hit (₹${state.sessionPnl} ≥ ₹${lock}) — banking the day`);
    return;
  }
  if (maxOuts > 0 && state.stopOuts >= maxOuts) {
    _closeDay(`${state.stopOuts} stop-out(s) ≥ ${maxOuts} — day over`);
    return;
  }
  if (state.tradesTaken >= _maxDailyTrades()) {
    _closeDay(`Daily trade budget spent (${state.tradesTaken}/${_maxDailyTrades()})`);
  }
}

function _closeDay(reason) {
  state.dayClosed = true;
  state.dayClosedReason = reason;
  log(`⏸️ [TDS-PAPER] ${reason} — no more entries today`);
  skipLogger.appendSkipLog(MODE_KEY, { gate: "day_closed", reason, sessionPnl: state.sessionPnl, spot: state.lastTickPrice });
}

// ── Exits (per tick) ─────────────────────────────────────────────────────────
// Priority: hard stop → fixed target → breakeven arm → time stop → premium stop.
// Every level is guarded with Number.isFinite before it is compared: `spot <= null`
// is `spot <= 0`, which would square the trade off on its very first tick.
function _checkExits(spotPrice) {
  if (!state.position) return;
  const pos = state.position;
  const optLtp = state.optionLtp || pos.optionEntryLtp;
  const cfg = tdsStrategy.getConfig();

  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;
  const favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const curPnl = (optLtp - pos.optionEntryLtp) * pos.qty;
  if (favPts > (pos.mfeSpotPts || 0)) { pos.mfeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl > (pos.mfePnl     || 0)) pos.mfePnl = parseFloat(curPnl.toFixed(2));
  if (favPts < (pos.maeSpotPts || 0)) { pos.maeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl < (pos.maePnl     || 0)) pos.maePnl = parseFloat(curPnl.toFixed(2));

  // 1. Hard stop (or the breakeven stop once it has jumped).
  if (tdsStrategy.stopHit(pos.side, spotPrice, pos.slSpot)) {
    const atBe = pos.beArmed;
    simulateSell(
      atBe
        ? `Breakeven stop — price came back to ${pos.slSpot} after arming at +${pos.breakevenR}R (spot ${spotPrice})`
        : `Stop hit — ${pos.riskPts}pt against, at ${pos.slSpot} (spot ${spotPrice})`,
      // A breakeven exit is a scratch, not one of the day's allowed losses.
      { isStopOut: !atBe }
    );
    return;
  }

  // 2. Fixed target — the whole point of the design; taken, never trailed past.
  if (tdsStrategy.targetHit(pos.side, spotPrice, pos.targetSpot)) {
    simulateSell(`Target hit — ${pos.targetR}R at ${pos.targetSpot} (spot ${spotPrice}, +${favPts.toFixed(1)}pt)`);
    return;
  }

  // 3. Breakeven jump — ONCE, then the stop never moves again.
  if (!pos.beArmed) {
    const be = tdsStrategy.breakevenJump(pos.side, pos.entrySpot, spotPrice, pos.slPts, cfg);
    if (be.armed && typeof be.stop === "number" && Number.isFinite(be.stop)) {
      pos.beArmed = true;
      pos.slSpot = be.stop;
      log(`🛡️ [TDS-PAPER] Breakeven armed at +${pos.breakevenR}R (spot ${spotPrice}) — stop moved ${pos.initialSlSpot} → ${be.stop}. It will not move again.`);
      try { require("../utils/positionPersist").saveTrendDayScalpPosition(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
    }
  }

  // 4. Time stop — a trade that has not reached +1R is only paying theta.
  if (tdsStrategy.timeStopHit(pos.entryUnixSec, Math.floor(Date.now() / 1000), pos.beArmed, cfg)) {
    simulateSell(`Time stop — ${pos.timeStopMins}m elapsed without reaching +${pos.breakevenR}R`);
    return;
  }

  // 5. Premium stop — catches an IV crush the spot stop cannot see.
  if (tdsStrategy.premiumStopHit(pos.optionEntryLtp, optLtp, cfg)) {
    simulateSell(`Premium stop — option ₹${pos.optionEntryLtp} → ₹${optLtp} (-${pos.premiumStopPct}%)`);
  }
}

// ── The day gate — evaluated ONCE, then frozen ───────────────────────────────
function _maybeDecideDayGate() {
  if (state.dayGate && state.dayGate.decided) return;
  // evaluateDayGate anchors on the IST day of the LAST candle it is given, and
  // preloadHistory loads several days of warm-up. Starting a session before the
  // open therefore hands it a series ending YESTERDAY — it would decide and
  // FREEZE yesterday's verdict, and today's real gate would never run. Only ever
  // decide once the series has actually reached today.
  const last = state.candles.length ? state.candles[state.candles.length - 1] : null;
  if (!last) return;
  const today = tdsStrategy._istDayOf(Math.floor(Date.now() / 1000));
  if (tdsStrategy._istDayOf(last.time) !== today) return;

  // Feed the engine the CLOSED bars only; the forming bar must never move the gate.
  const gate = tdsStrategy.evaluateDayGate(state.candles, { silent: true });
  if (!gate.decided) return;

  state.dayGate = gate;
  state.gateLoggedAt = istNow();
  if (gate.tradeable) {
    log(`🚦 [TDS-PAPER] DAY GATE PASSED — ${gate.reason}`);
    log(`   └─ ${gate.side} only for the rest of the day. Hunting a pullback into the VWAP/EMA zone.`);
  } else {
    log(`🚦 [TDS-PAPER] DAY GATE FAILED — ${gate.reason}`);
    for (const c of gate.checks || []) log(`   ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    log(`   └─ Standing aside for the whole session. A zero beats a loss on a day with no trend.`);
    skipLogger.appendSkipLog(MODE_KEY, {
      gate: "day_gate", reason: gate.reason,
      rangePts: gate.rangePts, rangePct: gate.rangePct, vwap: gate.vwap,
      extensionPts: gate.extensionPts, extensionNeeded: gate.extensionNeeded,
      streakOk: gate.streakOk, spot: gate.spot,
    });
  }
}

// ── Entry evaluation (on candle close — the signal reads CLOSED bars only) ────
const ENTRY_RETRY_MS = 5000;

async function evaluateEntry() {
  // Every guard here is synchronous and runs before the first await, so
  // concurrent ticks can never open two positions.
  if (state.position || state._entryInFlight || state.dayClosed) return;
  if (!state.dayGate || !state.dayGate.decided || !state.dayGate.tradeable) return;
  if (state._lastEntryAttemptMs && Date.now() - state._lastEntryAttemptMs < ENTRY_RETRY_MS) return;
  if (state.tradesTaken >= _maxDailyTrades()) { _applyDayBreakers(); return; }

  // ── Risk gates ──────────────────────────────────────────────────────────
  const maxWeek = _maxWeeklyLoss();
  if (maxWeek > 0) {
    const wk = weeklyPnl();
    if (wk <= -maxWeek) { _closeDay(`Weekly loss cap hit (week P&L ₹${wk} ≤ -₹${maxWeek})`); return; }
  }
  {
    const pf = require("../utils/portfolioRisk").checkPortfolioCap();
    if (pf.blocked) { _closeDay(pf.reason); return; }
  }

  // ── The signal ──────────────────────────────────────────────────────────
  const sig = tdsStrategy.getSignal(state.candles, {
    dayGate: state.dayGate,
    alreadyTraded: false,
  });
  state.lastSignal = sig;

  if (sig.signal === "NONE" || !sig.side) {
    // Only log the interesting near-misses — a "no pullback" bar every 5 minutes
    // would bury the day file.
    if (!sig.warmup && /reclaim|conviction|SKIPPED|wrong colour/.test(sig.reason || "")) {
      skipLogger.appendSkipLog(MODE_KEY, {
        gate: /SKIPPED/.test(sig.reason) ? "sl_too_wide" : "setup_incomplete",
        reason: sig.skipReason || sig.reason,
        spot: state.lastTickPrice,
        zone: sig.zone, vwap: sig.vwap, ema: sig.ema, atr: sig.atr,
        bodyPts: sig.bodyPts, bodyNeeded: sig.bodyNeeded,
        pullbackLow: sig.pullbackLow, pullbackHigh: sig.pullbackHigh,
        slRaw: sig.slRaw,
      });
    }
    return;
  }

  log(`🎯 [TDS-PAPER] SETUP: ${sig.reason}`);
  state._entryInFlight = true;
  state._lastEntryAttemptMs = Date.now();
  try {
    await simulateBuy(sig.side, sig);
  } finally {
    state._entryInFlight = false;
    if (!state.position) {
      log(`⚠️ [TDS-PAPER] Entry attempt failed — will retry on a later setup (throttled ${ENTRY_RETRY_MS / 1000}s)`);
    }
  }
}

// ── Candle close handler ─────────────────────────────────────────────────────
// The gate and the entry both read CLOSED bars only, so both are driven from here.
function onCandleClose(bar) {
  _maybeDecideDayGate();
  if (state.position) return;                    // exits are per-tick, not per-bar
  // Gate on the BAR's close time, exactly as the engine does — not on the wall
  // clock. The two disagree at the boundary: the 13:55 bar closes AT 14:00, so a
  // wall-clock `>= 14:00` check drops the last legal entry bar that the engine
  // (and therefore the backtest) still accepts.
  if (!bar || typeof bar.time !== "number") return;
  const _closeMins = tdsStrategy._utcSecToIstMins(bar.time) + _resMin();
  if (_closeMins > _parseMins("TDS_ENTRY_END", "14:00")) return;
  evaluateEntry().catch(e => console.error(`🚨 [TDS-PAPER] entry-eval error: ${e.message}`));
}

// ── onTick ───────────────────────────────────────────────────────────────────
function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (!price || price <= 0) return;

  const resMin = _resMin();
  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  const bucketMs = getBucketStart(Date.now(), resMin);
  if (!state.currentBar || state.barStartTime !== bucketMs) {
    if (state.currentBar) {
      const lastC = state.candles.length ? state.candles[state.candles.length - 1] : null;
      if (lastC && lastC.time === state.currentBar.time) {
        state.candles[state.candles.length - 1] = { ...state.currentBar };
      } else {
        state.candles.push({ ...state.currentBar });
      }
      // Deep buffer: EMA20/ATR14 are recomputed over this array and an EMA seeded
      // from a short window carries a startup transient. The backtest computes the
      // same EMA over the whole range, so trimming this short would make Paper and
      // Backtest disagree about the zone.
      if (state.candles.length > 300) state.candles.shift();
      try { onCandleClose(state.currentBar); }
      catch (e) { console.error(`🚨 [TDS-PAPER] onCandleClose error: ${e.message}`); }
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
    if (nowMin >= _parseMins("TDS_FORCED_EXIT", "15:10")) {
      simulateSell(`EOD square-off (${_envStr("TDS_FORCED_EXIT", "15:10")} IST)`);
    }
  }
}

// ── Preload intraday history ─────────────────────────────────────────────────
// The zone is EMA20(5m) and the conviction gate is ATR14(5m); both carry a
// seeding transient. The backtest computes them over the whole range, so Paper
// must start warm or the two would disagree about the same bar.
const WARM_BARS = 150;

async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { fetchCandles } = require("../services/backtestEngine");
    const resMin = _resMin();
    const barsPerDay = Math.max(1, Math.round(375 / resMin));
    const lookbackDays = Math.max(5, Math.ceil((WARM_BARS / barsPerDay) * 1.5) + 2);
    const _now = new Date();
    const istToday = _now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const istStart = new Date(_now.getTime() - lookbackDays * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached(NIFTY_INDEX_SYMBOL, String(resMin), istStart, istToday, fetchCandles);
    if (Array.isArray(candles) && candles.length > 0) {
      state.candles = candles.slice(-300);
      log(`📊 [TDS-PAPER] Preloaded ${state.candles.length} × ${resMin}-min spot candles (${istStart}→${istToday}, ${lookbackDays}d lookback)`);
      if (state.candles.length < WARM_BARS) {
        log(`⚠️ [TDS-PAPER] Only ${state.candles.length} bars preloaded (< ${WARM_BARS}) — EMA/ATR start inside their seeding transient, so early values may differ slightly from Backtest.`);
      }
      // A restart after 10:15 must not lose the day's verdict.
      _maybeDecideDayGate();
    } else {
      log(`📊 [TDS-PAPER] No intraday history available — will build from live ticks`);
    }
  } catch (e) {
    log(`⚠️ [TDS-PAPER] Intraday preload failed: ${e.message}`);
  }
}

// ── Auto-stop at TRADE_STOP_TIME ─────────────────────────────────────────────
let _autoStopTimer = null;
function scheduleAutoStop() {
  if (_autoStopTimer) clearTimeout(_autoStopTimer);
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  const stopMin = h * 60 + (isNaN(m) ? 0 : m);
  const minsLeft = stopMin - getISTMinutes();
  if (minsLeft <= 0) return;
  _autoStopTimer = setTimeout(() => { log(`⏰ [TDS-PAPER] Auto-stop @ ${raw} IST`); stopSession(); }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ────────────────────────────────────────────────────────
router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/trend-day-scalp-paper/status");

  if (String(process.env.TDS_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("Trend Day Scalp Disabled", "Enable Trend Day Scalp Mode in Settings first", "/settings", "Go to Settings"));
  }
  if (String(process.env.TDS_PAPER_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("Trend Day Scalp Paper Disabled", "Enable Trend Day Scalp Paper Trading in Settings first", "/settings", "Go to Settings"));
  }

  const check = sharedSocketState.canStart("TREND_DAY_SCALP_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/trend-day-scalp-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/trend-day-scalp-paper/status", "← Back"));

  if (getISTMinutes() >= _parseMins("TDS_FORCED_EXIT", "15:10")) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${_envStr("TDS_FORCED_EXIT", "15:10")} IST — Trend Day Scalp does not trade after this`, "/trend-day-scalp-paper/status", "← Back"));
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `trend-day-scalp-paper:${Date.now()}`;

  sharedSocketState.setTrendDayScalpActive("TREND_DAY_SCALP_PAPER");

  const cfg = tdsStrategy.getConfig();
  log(`🟢 [TDS-PAPER] Session started — ${tdsStrategy.NAME}`);
  log(`⚙️ [TDS-PAPER] Gate ${_envStr("TDS_GATE_TIME", "10:15")} (range ≥${cfg.minRangePct}% · ${cfg.vwapStreakBars} closes one side of VWAP · extension ≥${cfg.extensionMult}×range) · zone VWAP/EMA${cfg.emaPeriod} · body ≥${cfg.bodyAtrMult}×ATR${cfg.atrPeriod} · SL ${cfg.minSlPts}-${cfg.maxSlPts}pt · target ${cfg.targetR}R · BE +${cfg.breakevenR}R→entry±${cfg.breakevenBuffer} · time-stop ${cfg.timeStopMins}m · premium stop -${cfg.premiumStopPct}%`);
  log(`⚙️ [TDS-PAPER] Entries until ${_envStr("TDS_ENTRY_END", "14:00")} · max ${_maxDailyTrades()}/day · ${_maxDailyLosses()} stop-outs ends the day · loss cap ₹${_maxDailyLoss()} · profit lock ₹${_dailyProfitLock()} · EOD ${_envStr("TDS_FORCED_EXIT", "15:10")} · qty ${tdsLotQty()}`);

  await preloadHistory();

  try {
    tickRecorder.recordSessionStart({
      mode: "trend-day-scalp-paper",
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: state.candles.map(c => ({ ...c })),
      meta: {
        instrument: instrumentConfig.INSTRUMENT,
        resolutionMin: _resMin(),
        spotSymbol: NIFTY_INDEX_SYMBOL,
        sessionStartISO: state.sessionStart,
        recordsOptionLtps: true,
      },
    });
  } catch (_) {}

  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [TDS-PAPER] Piggybacking on existing WebSocket");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [TDS-PAPER] Started WebSocket");
  }

  scheduleAutoStop();

  notifyStarted({
    mode: "TREND-DAY-SCALP-PAPER",
    text: [
      `📄 TREND DAY SCALP PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${tdsStrategy.NAME}`,
      `Day gate  : ${_envStr("TDS_GATE_TIME", "10:15")} — range ≥${cfg.minRangePct}%, ${cfg.vwapStreakBars} closes one side of VWAP, extension ≥${cfg.extensionMult}×range`,
      `Entry     : pullback into VWAP/EMA${cfg.emaPeriod} then reclaim, body ≥${cfg.bodyAtrMult}×ATR${cfg.atrPeriod}`,
      `Risk      : SL ${cfg.minSlPts}-${cfg.maxSlPts}pt · target ${cfg.targetR}R · breakeven at +${cfg.breakevenR}R`,
      `Max trades: ${_maxDailyTrades()}/day · profit lock ₹${_dailyProfitLock()} · loss cap ₹${_maxDailyLoss()}`,
      `Square-off: ${_envStr("TDS_FORCED_EXIT", "15:10")} IST`,
    ].filter(Boolean).join("\n"),
  });

  res.redirect("/trend-day-scalp-paper/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped");
  state.running = false;
  stopOptionPolling();

  try { tickRecorder.recordSessionStop({ mode: "trend-day-scalp-paper", sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  sharedSocketState.clearTrendDayScalp();   // clear OWN mode first (else the socket never stops → leak)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: tdsStrategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
      saveData(data);
      log(`💾 [TDS-PAPER] Session saved — ${state.sessionTrades.length} trades, PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ [TDS-PAPER] Save failed: ${e.message}`);
    }
  }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  log(`📋 [TDS-PAPER] Day summary — ${state.sessionTrades.length} trade(s), ${wins}W/${state.sessionTrades.length - wins}L, net ₹${state.sessionPnl}, week ₹${weeklyPnl()}`);
  log("🔴 [TDS-PAPER] Session stopped");

  notifyDayReport({
    mode: "TREND-DAY-SCALP-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/trend-day-scalp-paper/status"); });
router.get("/exit", (req, res) => { if (state.position) simulateSell("Manual exit"); res.redirect("/trend-day-scalp-paper/status"); });

// ── /status/chart-data — candles + VWAP/EMA zone + bracket lines + markers ────
router.get("/status/chart-data", async (req, res) => {
  try {
    const cfg = tdsStrategy.getConfig();
    let srcCandles = state.candles;
    if (!state.running && srcCandles.length === 0 && (state.sessionTrades || []).length > 0) {
      srcCandles = await chartBackfill.candlesForRestoredTrades(NIFTY_INDEX_SYMBOL, _resMin(), state.sessionTrades);
    }
    const candles = srcCandles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.currentBar) candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });

    // Plot exactly what the engine computed — same functions, same inputs.
    const vwapSeries = tdsStrategy.computeVwapSeries(srcCandles, cfg.sessionStartMin)
      .filter(Boolean).map(p => ({ time: p.time, value: p.value }));
    const emaSeries = tdsStrategy.computeEmaSeries(srcCandles, cfg.emaPeriod)
      .filter(Boolean).map(p => ({ time: p.time, value: p.value }));

    const markers = [];
    for (const t of state.sessionTrades) {
      if (t.entryBarTime) markers.push({ time: t.entryBarTime, position: t.side === "CE" ? "belowBar" : "aboveBar", color: t.side === "CE" ? "#10b981" : "#ef4444", shape: t.side === "CE" ? "arrowUp" : "arrowDown", text: `${t.side} ${t.entryPrice}` });
      if (t.exitBarTime)  markers.push({ time: t.exitBarTime,  position: t.side === "CE" ? "aboveBar" : "belowBar", color: (t.pnl || 0) >= 0 ? "#10b981" : "#ef4444", shape: "circle", text: `${(t.pnl || 0) >= 0 ? "+" : ""}${Math.round(t.pnl || 0)}` });
    }

    const pos = state.position;
    res.json({
      candles, vwapSeries, emaSeries, markers,
      entryPrice: pos ? pos.entrySpot : null,
      stopLoss:   pos ? pos.slSpot : null,
      target:     pos ? pos.targetSpot : null,
      beArmSpot:  pos ? (pos.beArmed ? null : pos.beArmSpot) : null,
      beArmed:    pos ? !!pos.beArmed : false,
      emaPeriod:  cfg.emaPeriod,
      gate: state.dayGate ? {
        decided: state.dayGate.decided, tradeable: state.dayGate.tradeable,
        side: state.dayGate.side, vwap: state.dayGate.vwap, gateTime: state.dayGate.gateTime,
      } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const data = loadData();
  const cfg = tdsStrategy.getConfig();

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * (pos.qty || tdsLotQty())).toFixed(2));
  }

  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) }); }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const bestTrade = state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null;
  const worstTrade = state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null;

  const g = state.dayGate;
  res.json({
    running: state.running, sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-100),
    tickCount: state.tickCount, lastTickPrice: state.lastTickPrice,
    candles: state.candles.length, currentBar: state.currentBar, sessionStart: state.sessionStart,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge,
    wins, losses, winRate, bestTrade, worstTrade, cumPnl, livePnl,
    weeklyPnl: weeklyPnl(),
    // TREND_DAY_SCALP context
    gateDecided:   !!(g && g.decided),
    gateTradeable: !!(g && g.tradeable),
    gateSide:      g ? g.side : null,
    gateReason:    g ? g.reason : null,
    gateChecks:    g ? g.checks : null,
    gateRangePts:  g ? g.rangePts : null,
    gateRangePct:  g ? g.rangePct : null,
    gateVwap:      g ? g.vwap : null,
    gateExtensionPts:    g ? g.extensionPts : null,
    gateExtensionNeeded: g ? g.extensionNeeded : null,
    gateTime:      _envStr("TDS_GATE_TIME", "10:15"),
    dayClosed:     state.dayClosed, dayClosedReason: state.dayClosedReason,
    stopOuts:      state.stopOuts, maxDailyLosses: _maxDailyLosses(),
    maxDailyTrades: _maxDailyTrades(),
    dailyProfitLock: _dailyProfitLock(), maxDailyLoss: _maxDailyLoss(),
    lastSkipReason: state.lastSignal && state.lastSignal.signal === "NONE" ? (state.lastSignal.skipReason || state.lastSignal.reason) : null,
    cfg: {
      gateTime: _envStr("TDS_GATE_TIME", "10:15"), minRangePct: cfg.minRangePct,
      vwapStreakBars: cfg.vwapStreakBars, extensionMult: cfg.extensionMult,
      emaPeriod: cfg.emaPeriod, atrPeriod: cfg.atrPeriod, bodyAtrMult: cfg.bodyAtrMult,
      minSlPts: cfg.minSlPts, maxSlPts: cfg.maxSlPts, targetR: cfg.targetR,
      breakevenR: cfg.breakevenR, breakevenBuffer: cfg.breakevenBuffer,
      timeStopMins: cfg.timeStopMins, premiumStopPct: cfg.premiumStopPct,
      entryEnd: _envStr("TDS_ENTRY_END", "14:00"), forcedExit: _envStr("TDS_FORCED_EXIT", "15:10"),
      resMin: _resMin(),
    },
    position: pos ? {
      side: pos.side, symbol: pos.symbol, entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      slSpot: pos.slSpot, initialSlSpot: pos.initialSlSpot, targetSpot: pos.targetSpot,
      beArmSpot: pos.beArmSpot, beArmed: !!pos.beArmed, riskPts: pos.riskPts, targetR: pos.targetR,
      optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry,
      peakPremium: pos.peakPremium, entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      zone: pos.zone, atrAtEntry: pos.atrAtEntry, bodyPts: pos.bodyPts,
      qty: pos.qty, currentOptLtp: state.optionLtp,
      heldSec: Math.round((Date.now() - pos.entryTimeMs) / 1000),
      timeStopMins: pos.timeStopMins,
    } : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getTrendDayScalpMode() === "TREND_DAY_SCALP_LIVE";
  const data = loadData();
  const pos  = state.position;
  const cfg  = tdsStrategy.getConfig();
  const g    = state.dayGate;

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");

  const gateBadge = !g || !g.decided
    ? `<span style="color:#94a3b8;">⏳ Waiting for the ${_envStr("TDS_GATE_TIME", "10:15")} gate</span>`
    : g.tradeable
      ? `<span style="color:#10b981;">✓ ${g.side}-ONLY DAY</span>`
      : `<span style="color:#f59e0b;">✗ NO TRADE TODAY</span>`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Trend Day Scalp — Paper</title>${faviconLink()}
<style>${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.gate-card{background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;margin-bottom:18px;}
.gate-check{display:flex;gap:8px;align-items:flex-start;font-size:0.74rem;margin-top:6px;color:#94a3b8;}
.gate-check .ic{flex:0 0 auto;}
.brk{font-size:0.72rem;color:#f59e0b;margin-top:8px;}
</style>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
</head><body>
${buildSidebar('trendDayScalpPaper', liveActive)}
<div class="main">
${bbRsiTopBar({
  title: "⚡ Trend Day Scalp — Paper",
  metaLine: `Day gate ${_envStr("TDS_GATE_TIME", "10:15")} → pullback into VWAP/EMA${cfg.emaPeriod} → fixed ${cfg.targetR}R · SL ${cfg.minSlPts}-${cfg.maxSlPts}pt · max ${_maxDailyTrades()}/day`,
  running: state.running,
  primaryAction: { href: "/trend-day-scalp-paper/start", label: "▶ Start", color: "#7e22ce" },
  stopAction:    { href: "/trend-day-scalp-paper/stop",  label: "■ Stop" },
  historyHref: "/trend-day-scalp-paper/history",
})}

${bbRsiCapitalStrip({ starting: startCap, current: startCap + (data.totalPnl || 0), allTime: data.totalPnl || 0 })}

<div class="gate-card">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div style="font-size:0.7rem;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Day Gate — decided once at ${_envStr("TDS_GATE_TIME", "10:15")}, then frozen</div>
    <div style="font-size:0.85rem;font-weight:600;" id="gate-badge">${gateBadge}</div>
  </div>
  <div id="gate-detail" style="font-size:0.74rem;color:#94a3b8;margin-top:8px;">${g && g.decided ? g.reason : "Most days end here with no trade — that zero is the design goal."}</div>
  <div id="gate-checks">${(g && g.checks || []).map(c => `<div class="gate-check"><span class="ic">${c.ok ? "✅" : "❌"}</span><span><strong>${c.name}</strong> — ${c.detail}</span></div>`).join("")}</div>
  ${state.dayClosed ? `<div class="brk">⏸️ ${state.dayClosedReason}</div>` : ""}
</div>

${bbRsiStatGrid([
  { label: "Session P&L", value: inr(state.sessionPnl), color: state.sessionPnl >= 0 ? "#10b981" : "#ef4444" },
  { label: "Trades", value: `${state.tradesTaken}/${_maxDailyTrades()}` },
  { label: "W / L", value: `${wins} / ${losses}` },
  { label: "Stop-outs", value: `${state.stopOuts}/${_maxDailyLosses()}` },
  { label: "Week P&L", value: inr(weeklyPnl()) },
  { label: "Spot", value: state.lastTickPrice != null ? String(state.lastTickPrice) : "—" },
])}

${bbRsiCurrentBar({ bar: state.currentBar, resMin: _resMin() })}

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">NIFTY ${_resMin()}m — VWAP / EMA${cfg.emaPeriod} zone + bracket</div>
  <div id="chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:420px;">
    <div id="chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
      <span style="color:#8b5cf6;">── VWAP</span> &nbsp;<span style="color:#3b82f6;">── EMA${cfg.emaPeriod}</span> &nbsp;<span style="color:#f59e0b;">── Stop</span> &nbsp;<span style="color:#10b981;">── Target</span>
    </div>
  </div>
</div>

<div id="pos-card" style="margin-bottom:18px;">${_positionCardHtml(pos, state.optionLtp)}</div>

${bbRsiActivityLog({ logsJSON: JSON.stringify(state.log.slice(-200)) })}
</div>
<script>
${modalJS()}
async function tdsRefresh() {
  try {
    const r = await fetch('/trend-day-scalp-paper/status/data', { cache: 'no-store' });
    const d = await r.json();
    var gb = document.getElementById('gate-badge');
    if (gb) {
      gb.innerHTML = !d.gateDecided
        ? '<span style="color:#94a3b8;">⏳ Waiting for the ' + d.gateTime + ' gate</span>'
        : d.gateTradeable
          ? '<span style="color:#10b981;">✓ ' + d.gateSide + '-ONLY DAY</span>'
          : '<span style="color:#f59e0b;">✗ NO TRADE TODAY</span>';
    }
    var gd = document.getElementById('gate-detail');
    if (gd && d.gateReason) gd.textContent = d.gateReason;
    var gc = document.getElementById('gate-checks');
    if (gc && d.gateChecks) {
      gc.innerHTML = d.gateChecks.map(function(c){
        return '<div class="gate-check"><span class="ic">' + (c.ok ? '✅' : '❌') + '</span><span><strong>' + c.name + '</strong> — ' + c.detail + '</span></div>';
      }).join('');
    }
  } catch (e) {}
}
tdsRefresh();
setInterval(tdsRefresh, 4000);
</script>
<script>
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var container = document.getElementById('chart');
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
  var vw = chart.addLineSeries({ color:'#8b5cf6', lineWidth:2, priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false });
  var em = chart.addLineSeries({ color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false });
  var entryLine=null, slLine=null, tgLine=null, beLine=null, _zoomed=false;
  async function fetchChart(){
    try {
      var r = await fetch('/trend-day-scalp-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) { (function(){
        var _lt=d.candles[d.candles.length-1].time, _dk=Math.floor((_lt+19800)/86400), _cut=_lt;
        for (var _i=d.candles.length-1;_i>=0;_i--){ if(Math.floor((d.candles[_i].time+19800)/86400)===_dk) _cut=d.candles[_i].time; else break; }
        var _k=function(a){ return Array.isArray(a)?a.filter(function(x){return x.time>=_cut;}):a; };
        d.candles=_k(d.candles);
        ['vwapSeries','emaSeries','markers'].forEach(function(kk){ if(d[kk]) d[kk]=_k(d[kk]); });
      })(); }
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        if (!_zoomed) { try {
          var lastT=d.candles[d.candles.length-1].time, dayK=Math.floor((lastT+19800)/86400), firstT=lastT;
          for (var i=d.candles.length-1;i>=0;i--){ if(Math.floor((d.candles[i].time+19800)/86400)===dayK) firstT=d.candles[i].time; else break; }
          chart.timeScale().setVisibleRange({ from:firstT, to:lastT }); _zoomed=true;
        } catch(_){} }
      }
      vw.setData(d.vwapSeries || []);
      em.setData(d.emaSeries || []);
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      [entryLine,slLine,tgLine,beLine].forEach(function(l){ if(l) cs.removePriceLine(l); });
      entryLine=slLine=tgLine=beLine=null;
      if (d.entryPrice) entryLine = cs.createPriceLine({ price:d.entryPrice, color:'#94a3b8', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
      if (d.stopLoss)   slLine    = cs.createPriceLine({ price:d.stopLoss,   color:'#f59e0b', lineWidth:2, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:d.beArmed?'BE stop':'Stop' });
      if (d.target)     tgLine    = cs.createPriceLine({ price:d.target,     color:'#10b981', lineWidth:2, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'Target' });
      if (d.beArmSpot)  beLine    = cs.createPriceLine({ price:d.beArmSpot,  color:'#64748b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'BE arms' });
    } catch(e) {}
  }
  fetchChart();
  setInterval(fetchChart, 4000);
  window.addEventListener('resize', function(){ chart.applyOptions({ width: container.clientWidth }); });
})();
</script>
</body></html>`;
  res.send(html);
});

function _positionCardHtml(pos, optLtp) {
  if (!pos) {
    return `<div style="background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;color:#64748b;font-size:0.78rem;">No open position.</div>`;
  }
  const live = optLtp != null ? ((optLtp - pos.optionEntryLtp) * pos.qty).toFixed(0) : "—";
  return `<div style="background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;">
  <div style="font-size:0.7rem;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:8px;">Open position</div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:0.8rem;color:#e2e8f0;">
    <div><span style="color:#64748b;">Side</span> ${pos.side}</div>
    <div><span style="color:#64748b;">Symbol</span> ${pos.symbol}</div>
    <div><span style="color:#64748b;">Entry</span> ${pos.entrySpot}</div>
    <div><span style="color:#64748b;">Stop</span> ${pos.slSpot}${pos.beArmed ? " (BE)" : ""}</div>
    <div><span style="color:#64748b;">Target</span> ${pos.targetSpot}</div>
    <div><span style="color:#64748b;">Risk</span> ${pos.riskPts}pt</div>
    <div><span style="color:#64748b;">Live P&L</span> ₹${live}</div>
  </div>
</div>`;
}

// ── History + daily-file viewers + restore + reset ────────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = sharedSocketState.getTrendDayScalpMode() === "TREND_DAY_SCALP_LIVE";
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  res.send(renderHistoryPage({
    routePrefix: "/trend-day-scalp-paper",
    sidebarKey: "trendDayScalpHistory",
    pageTitle: "⚡ Trend Day Scalp Paper Trade History",
    pageDocTitle: "Trend Day Scalp Paper — History",
    modalLabel: "Trend Day Scalp Paper",
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap,
    emptyLabel: "Start Trend Day Scalp paper trading to record your first session.",
  }));
});

const _TDS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/download/daily-files", (req, res) => {
  const skips  = skipLogger.listDates(MODE_KEY);
  const trades = tradeLogger.listDailyDates(MODE_KEY);
  const byDate = new Map();
  for (const s of skips)  byDate.set(s.date, { date: s.date, skipsSize: s.size, tradesSize: 0 });
  for (const t of trades) { const row = byDate.get(t.date) || { date: t.date, skipsSize: 0, tradesSize: 0 }; row.tradesSize = t.size; byDate.set(t.date, row); }
  const rows = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  res.json(dailyFilesPaginate(rows, req.query));
});

router.get("/download/skips-all", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="trend_day_scalp_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates(MODE_KEY).map(d => d.date).sort();
  let body = "";
  for (const d of dates) { try { const p = skipLogger.filePathFor(MODE_KEY, d); if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8"); } catch (_) {} }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_TDS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `trend_day_scalp_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_TDS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `trend_day_scalp_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_TDS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_TDS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop Trend Day Scalp paper trading first before deleting a session." });
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
  if (state.running) return res.status(400).json({ success: false, error: "Stop Trend Day Scalp paper trading before restoring." });
  const date = String(req.params.date || "").trim();
  if (!_TDS_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades(MODE_KEY, date);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; if (key) seen.add(String(key)); }
  const missing = allTrades.filter(t => { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; return key && !seen.has(String(key)); });
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
  data.sessions.push({ date, strategy: (missing[0] && missing[0].strategy) || tdsStrategy.NAME, pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop Trend Day Scalp paper trading before resetting." });
  const fresh = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  return res.json({ success: true, message: `Trend Day Scalp paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
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
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) records.push(Object.assign({ date: s.date, mode: MODE_KEY, strategy: s.strategy }, t));
    const today = new Date().toISOString().slice(0, 10);
    const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
    if (ai) {
      const md = aiExport.buildMarkdown(records, { title: "Trend Day Scalp paper trades (full log)", source: "trend-day-scalp-paper" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="trend_day_scalp_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="trend_day_scalp_paper_trades_${today}.jsonl"`);
    res.send(records.map(r => JSON.stringify(r)).join("\n"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function _errorPage(title, message, backHref, backLabel) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>${title}</title>
<style>body{font-family:Inter,sans-serif;background:#040c18;color:#e0eaf8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{color:#94a3b8;margin-bottom:18px;}
a{color:#3b82f6;text-decoration:none;border:0.5px solid #0e1e36;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>${title}</h2><p>${message}</p><a href="${backHref}">${backLabel}</a></body></html>`;
}

module.exports = router;
module.exports.stopSession = stopSession;

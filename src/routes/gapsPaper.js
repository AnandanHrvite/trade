/**
 * GAPS PAPER TRADE — /gaps-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * Extreme-RSI gap fade. One decision per day, taken at the open:
 *   yesterday's daily RSI > 90 + today gaps DOWN  → BUY PE
 *   yesterday's daily RSI < 10 + today gaps UP    → BUY CE
 *   SL     = yesterday's close exactly (the gap-fill level), on SPOT, per tick.
 *   Target = the daily EMA21 of the last closed daily bar, taken as a fixed price
 *            level for the day; fires when an intraday candle CLOSES beyond it.
 *   EOD    = hard square-off at GAPS_FORCED_EXIT.
 * There is no trail, no breakeven, no time stop and no other exit.
 *
 * Uses LIVE NIFTY data (Fyers WebSocket) but SIMULATES orders locally — no broker
 * is hit. Paper is canonical: the backtest and live engines must match THIS
 * decision/fill/exit logic.
 *
 * Signal engine: src/strategies/gaps.js (shared by paper, backtest and replay).
 * Endpoints: /start /stop /exit /status /status/data /status/chart-data
 *            /status/daily-chart-data /history …
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const gapsStrategy       = require("../strategies/gaps");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { renderHistoryPage, dailyFilesPaginate } = require("../utils/paperHistoryUI");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiCapitalStrip, bbRsiStatGrid, bbRsiCurrentBar, bbRsiActivityLog } = require("../utils/bbRsiStyleUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const tradeLogger = require("../utils/tradeLogger");
const chartBackfill = require("../utils/chartBackfill");
const aiExport    = require("../utils/aiExport");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { fmtISTDateTime, getISTMinutes, getBucketStart } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "gapsPaper";

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "gaps_paper_trades.json");

// ── Config readers (Settings mutates process.env live — never cache) ──────────
function _resMin() {
  const v = parseInt(process.env.GAPS_EXIT_TF || "5", 10);
  return [1, 3, 5, 10, 15, 30, 60].includes(v) ? v : 5;
}
function _parseMins(envKey, fallback) {
  const raw = String(process.env[envKey] || fallback).trim();
  const [h, m] = raw.split(":").map(Number);
  return (h || 0) * 60 + (isNaN(m) ? 0 : m);
}
function _envStr(key, fallback) { return String(process.env[key] || fallback); }
function _trailEnabled() { return String(process.env.GAPS_TRAIL_ENABLED || "true").toLowerCase() === "true"; }
function _trailLen()     { return Math.max(2, parseInt(process.env.GAPS_TRAIL_EMA_LENGTH || "21", 10) || 21); }
function _maxDailyTrades() { return Math.max(1, parseInt(process.env.GAPS_MAX_DAILY_TRADES || "1", 10) || 1); }
function _maxDailyLoss()   { return parseFloat(process.env.GAPS_MAX_DAILY_LOSS  || "5000"); }
function _maxWeeklyLoss()  { return parseFloat(process.env.GAPS_MAX_WEEKLY_LOSS || "0"); }
function _lossStreakSkip() { return parseInt(process.env.GAPS_LOSS_STREAK_SKIP || "3", 10); }

/**
 * Position size. GAPS_LOT_MULTIPLIER (when > 0) overrides the global
 * LOT_MULTIPLIER for this strategy only; it is clamped by the same
 * MAX_LOT_MULTIPLIER ceiling so a fat-finger value cannot size 50× live.
 */
function gapsLotQty() {
  const base = instrumentConfig.getLotQty();          // = lotSize × clamped global multiplier
  const raw  = parseInt(process.env.GAPS_LOT_MULTIPLIER || "0", 10);
  if (!Number.isFinite(raw) || raw <= 0) return base;

  let maxMult = parseInt(process.env.MAX_LOT_MULTIPLIER || "10", 10);
  if (!Number.isFinite(maxMult) || maxMult < 1) maxMult = 10;   // garbage env must not disable the clamp

  // Divide `base` back down by the multiplier getLotQty ACTUALLY applied — it
  // clamps to maxMult internally, so dividing by the raw LOT_MULTIPLIER would
  // recover the wrong lot size whenever the global value exceeds the ceiling
  // (LOT_MULTIPLIER=50, MAX=10, lot=65 → base 650; ÷50 = 13, not 65).
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
    console.error("[gaps-paper] gaps_paper_trades.json corrupt — resetting:", e.message);
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
    // GAPS-specific
    dailyCandles:   [],
    daily:          null,     // getPrevDaySnapshot() result
    todayOpen:      null,
    todayOpenSource: null,
    decisionMade:   false,    // the open-decision is taken once per session
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
    const all = tradeLogger.readDailyTrades("gaps", today)
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
    console.log(`♻️ [GAPS-PAPER] Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl})`);
  } catch (err) {
    console.warn(`[GAPS-PAPER] session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();

/**
 * Realised P&L for the current ISO week (Mon → today), read from the per-day
 * JSONL audit logs. Backs GAPS_MAX_WEEKLY_LOSS.
 *
 * While a session is RUNNING, today's contribution comes from the in-memory
 * session instead of today's file: tradeLogger.appendTradeLog writes the day
 * file asynchronously, so the file lags the engine by an event-loop tick.
 * When idle we must read today's FILE — state.sessionPnl may still hold a
 * rehydrated previous session (see rehydrateSessionFromJsonl's fallback), and
 * adding that on top of the file total would double-count that day.
 */
function weeklyPnl() {
  try {
    const nowIst = new Date(Date.now() + 19800000);
    const dow = nowIst.getUTCDay();                 // 0=Sun … 6=Sat
    const backToMon = dow === 0 ? 6 : dow - 1;
    const todayStr = tradeLogger.istDateString(Date.now());
    let total = 0;
    for (let i = backToMon; i >= 0; i--) {
      const d = new Date(nowIst.getTime() - i * 86400000);
      const ds = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      if (ds === todayStr && state.running) { total += state.sessionPnl; continue; }
      const trades = tradeLogger.readDailyTrades("gaps", ds) || [];
      for (const t of trades) if (t && !t.type && typeof t.pnl === "number") total += t.pnl;
    }
    return parseFloat(total.toFixed(2));
  } catch (_) {
    return state.running ? state.sessionPnl : 0;
  }
}

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
            try { tickRecorder.recordOptionLtp(state.position.symbol, ltp, "gaps-paper"); } catch (_) {}
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

// ── Daily history + today's open ─────────────────────────────────────────────

/**
 * Load the NIFTY DAILY series and derive yesterday's close / RSI / EMA21.
 * Fetched once per session — the values are fixed for the whole day by
 * definition (they come from a bar that already closed).
 */
async function loadDailyContext() {
  const cfg = gapsStrategy.getConfig();
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { fetchCandles } = require("../services/backtestEngine");
    const now = new Date();
    const istToday = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    // ~1 calendar year covers the ~35 closed daily bars RSI(14)-on-EMA21 needs
    // even across long holiday stretches.
    const istStart = new Date(now.getTime() - 400 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const daily = await fetchCandlesCached(NIFTY_INDEX_SYMBOL, "D", istStart, istToday, fetchCandles);
    state.dailyCandles = Array.isArray(daily) ? daily.slice() : [];
  } catch (e) {
    state.dailyCandles = [];
    log(`⚠️ [GAPS-PAPER] Daily history fetch failed: ${e.message}`);
  }

  state.daily = gapsStrategy.getPrevDaySnapshot(state.dailyCandles, Math.floor(Date.now() / 1000), cfg);

  if (!state.daily.ok) {
    log(`⚠️ [GAPS-PAPER] Daily context unavailable — ${state.daily.reason}`);
    return false;
  }
  log(`📅 [GAPS-PAPER] Daily context (${state.dailyCandles.length} daily candles, ${state.daily.closedCount} closed)`);
  log(`📊 [GAPS-PAPER] Yesterday ${state.daily.prevDate}: close=${state.daily.prevClose} · EMA${cfg.emaLength}=${state.daily.prevEma} · RSI(${cfg.rsiLength} on ${state.daily.sourceLabel})=${state.daily.prevRsi} · bands ${cfg.rsiLower}/${cfg.rsiUpper}`);
  const ob = state.daily.prevRsi > cfg.rsiUpper, os = state.daily.prevRsi < cfg.rsiLower;
  log(`🔎 [GAPS-PAPER] Setup armed: ${ob ? `OVERBOUGHT — a gap DOWN today triggers BUY PE` : os ? `OVERSOLD — a gap UP today triggers BUY CE` : `none (RSI inside [${cfg.rsiLower}, ${cfg.rsiUpper}]) — today will be a no-trade day unless the band changes`}`);
  return true;
}

/**
 * Today's official 09:15 open. Priority:
 *   1. today's DAILY bar open (Fyers publishes the forming daily bar) — exact;
 *   2. the first intraday candle of today from the preloaded series;
 *   3. the first tick we saw (fallback — logged as such, since a late session
 *      start means this is NOT the real open).
 * Returns true once resolved.
 */
function resolveTodayOpen() {
  if (state.todayOpen != null) return true;
  const todayDay = gapsStrategy._istDayOf(Math.floor(Date.now() / 1000));

  for (const c of state.dailyCandles) {
    if (c && gapsStrategy._istDayOf(c.time) === todayDay && typeof c.open === "number" && c.open > 0) {
      state.todayOpen = Math.round(c.open * 100) / 100;
      state.todayOpenSource = "daily bar open";
      return true;
    }
  }

  const sessionStartMin = _parseMins("GAPS_ENTRY_START", "09:15");
  for (const c of state.candles) {
    if (!c || gapsStrategy._istDayOf(c.time) !== todayDay) continue;
    const mins = Math.floor((c.time + 19800) / 60) % 1440;
    if (mins >= sessionStartMin && typeof c.open === "number" && c.open > 0) {
      state.todayOpen = Math.round(c.open * 100) / 100;
      state.todayOpenSource = `first ${_resMin()}-min candle open`;
      return true;
    }
  }

  if (state.lastTickPrice > 0) {
    state.todayOpen = Math.round(state.lastTickPrice * 100) / 100;
    state.todayOpenSource = "first tick (session started after the open — NOT the official open)";
    return true;
  }
  return false;
}

// ── Trade simulation ─────────────────────────────────────────────────────────
async function simulateBuy(side, sig) {
  const spot = state.lastTickPrice;
  if (!spot || !side) return;

  let optInfo;
  try {
    optInfo = await instrumentConfig.validateAndGetOptionSymbol(spot, side, "GAPS");
  } catch (e) {
    log(`❌ [GAPS-PAPER] Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ [GAPS-PAPER] No valid expiry — skip ${side} entry`);
    skipLogger.appendSkipLog("gaps", { gate: "expiry", reason: "no valid option expiry", side, spot });
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
        try { tickRecorder.recordOptionLtp(optInfo.symbol, ltp, "gaps-paper"); } catch (_) {}
      }
    }
  } catch (e) {
    log(`⚠️ [GAPS-PAPER] Option LTP fetch failed: ${e.message} — entry blocked`);
    return;
  }
  if (!optionEntryLtp) {
    log(`❌ [GAPS-PAPER] Option LTP not available — entry skipped`);
    skipLogger.appendSkipLog("gaps", { gate: "option_ltp", reason: "no option LTP", symbol: optInfo.symbol, side, spot });
    return;
  }

  const qty = gapsLotQty();
  const trailOn = _trailEnabled();

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
    entryBarTime:   Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    slSpot:         sig.slSpot,                       // yesterday's close = gap fill
    initialSlSpot:  sig.slSpot,
    trailEnabled:   trailOn,
    trailLength:    _trailLen(),
    trailSpot:      null,   // set on each candle close once the intraday EMA warms up
    trailBars:      0,      // how many candle closes the trail actually supervised
    riskPts:        parseFloat(Math.abs(spot - sig.slSpot).toFixed(2)),
    // Signal context (kept on the trade record for analytics / reports)
    prevDate:       sig.prevDate,
    prevClose:      sig.prevClose,
    prevRsi:        sig.prevRsi,
    prevEma:        sig.prevEma,
    todayOpen:      sig.todayOpen,
    todayOpenSource: state.todayOpenSource,
    gapPts:         sig.gapPts,
    gapPct:         sig.gapPct,
    gapDir:         sig.gapDir,
    rsiSource:      sig.rsiSource,
    rsiUpper:       sig.rsiUpper,
    rsiLower:       sig.rsiLower,
    peakPremium:    optionEntryLtp,
    signalStrength: sig.signalStrength,
    mfeSpotPts:     0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
    entryReason:    sig.reason,
  };

  state.position = pos;
  try { require("../utils/positionPersist").saveGapsPosition(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  state.optionLtp = optionEntryLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;
  startOptionPolling();

  log(`🟢 [GAPS-PAPER] BUY_${side} ${optInfo.symbol} qty=${qty} @ spot=${spot} optLtp=₹${optionEntryLtp}`);
  log(`   ├─ Gap: prev close ${sig.prevClose} → open ${sig.todayOpen} = ${sig.gapPts > 0 ? "+" : ""}${sig.gapPts}pt (${sig.gapPct > 0 ? "+" : ""}${sig.gapPct}%) ${sig.gapDir}`);
  log(`   ├─ Yesterday RSI ${sig.prevRsi} (${sig.rsiSource}) vs bands ${sig.rsiLower}/${sig.rsiUpper} · daily EMA ${sig.prevEma}`);
  log(`   └─ SL ${pos.slSpot} (gap fill, ${pos.riskPts}pt) · Trail ${trailOn ? `${_resMin()}m EMA${pos.trailLength} (exit on a close back through it)` : "DISABLED"} · EOD ${_envStr("GAPS_FORCED_EXIT", "15:15")}`);

  // The trail needs `trailLength` intraday bars before it produces a value. The
  // preload pulls several days of history so it is normally warm at the open —
  // but say so when it is not, because until then the gap-fill stop is the ONLY
  // exit and a reader should not assume the trail is silently protecting them.
  if (trailOn) {
    const t0 = gapsStrategy.computeTrailEma(state.candles, pos.trailLength);
    if (t0.last == null) {
      log(`⚠️ [GAPS-PAPER] Trail EMA${pos.trailLength} not warm yet (${(state.candles || []).length}/${pos.trailLength} × ${_resMin()}m bars) — gap-fill stop and EOD are the only exits until it is.`);
    } else {
      pos.trailSpot = t0.last;
      log(`   └─ Trail starts at ${t0.last} (${side === "PE" ? "exit on a close ABOVE" : "exit on a close BELOW"} it)`);
    }
  }

  notifyEntry({
    mode: "GAPS-PAPER",
    side, symbol: optInfo.symbol,
    spotAtEntry: spot, optionEntryLtp,
    qty, stopLoss: pos.slSpot, target: null,   // no fixed target — the exit is a trailing EMA
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "gaps-paper",
      sessionId: state._sessionId,
      ts: Date.now(),
      side, symbol: optInfo.symbol, qty,
      spotEntry: spot, optionEntry: optionEntryLtp,
      stopLoss: pos.slSpot, trailSpot: pos.trailSpot, trailLength: pos.trailLength,
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
    exitBarTime:    Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    pnl,
    pnlMode:        `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp}`,
    exitReason:     reason,
    entryReason:    pos.entryReason,
    stopLoss:       pos.slSpot,
    initialStopLoss: pos.initialSlSpot,
    trailSpot:      pos.trailSpot,      // where the trailing EMA sat at exit
    trailLength:    pos.trailLength,
    trailBars:      pos.trailBars || 0, // candle closes the trail actually supervised
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    optionType:     pos.side,
    optionEntrySymbol: pos.symbol,
    signalStrength: pos.signalStrength,
    riskPts:        pos.riskPts,
    // GAPS signal context
    prevDate:       pos.prevDate,
    prevClose:      pos.prevClose,
    prevRsi:        pos.prevRsi,
    prevEma:        pos.prevEma,
    todayOpen:      pos.todayOpen,
    todayOpenSource: pos.todayOpenSource,
    gapPts:         pos.gapPts,
    gapPct:         pos.gapPct,
    gapDir:         pos.gapDir,
    rsiSource:      pos.rsiSource,
    rsiUpper:       pos.rsiUpper,
    rsiLower:       pos.rsiLower,
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
  tradeLogger.appendTradeLog("gaps", trade);

  log(`🔴 [GAPS-PAPER] EXIT ${pos.side} ${pos.symbol} @ optLtp=₹${exitOptLtp} spot=${exitSpot} | PnL=₹${pnl} (${reason})`);

  notifyExit({
    mode: "GAPS-PAPER",
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
      mode: "gaps-paper", sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitOptLtp, pnl, reason,
    });
  } catch (_) {}

  state.position = null;
  try { require("../utils/positionPersist").clearGapsPosition(); } catch (_) {}
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;
  stopOptionPolling();
}

// ── Exits ────────────────────────────────────────────────────────────────────
// Tick level: the gap-fill stop only. Candle-close level: the intraday EMA
// trailing stop. Plus the EOD square-off. Nothing else — no target, no
// breakeven, no time stop.
function _checkExits(spotPrice) {
  if (!state.position) return;
  const pos = state.position;
  const optLtp = state.optionLtp || pos.optionEntryLtp;

  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;
  const favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const curPnl = (optLtp - pos.optionEntryLtp) * pos.qty;
  if (favPts > (pos.mfeSpotPts || 0)) { pos.mfeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl > (pos.mfePnl     || 0)) pos.mfePnl = parseFloat(curPnl.toFixed(2));
  if (favPts < (pos.maeSpotPts || 0)) { pos.maeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl < (pos.maePnl     || 0)) pos.maePnl = parseFloat(curPnl.toFixed(2));

  // Gap-fill stop — price came back to yesterday's close, the gap is filled.
  if (pos.side === "PE" && spotPrice >= pos.slSpot) { simulateSell(`Gap filled — stop hit (${spotPrice} ≥ prev close ${pos.slSpot})`); return; }
  if (pos.side === "CE" && spotPrice <= pos.slSpot) { simulateSell(`Gap filled — stop hit (${spotPrice} ≤ prev close ${pos.slSpot})`); return; }
}

/**
 * Trailing stop: the intraday EMA is recomputed on every candle close, and the
 * trade exits when that candle CLOSES back through it — a PE on a close ABOVE,
 * a CE on a close BELOW. Checked on candle close only, never on a wick.
 *
 * `state.candles` already ends with the bar just closed (onTick pushes it before
 * calling here), so the EMA includes the bar being judged — same as reading the
 * value off a TradingView chart after the candle prints.
 */
function _checkTrailOnClose(bar) {
  const pos = state.position;
  if (!pos || !bar || typeof bar.close !== "number") return;
  if (!pos.trailEnabled) return;

  const t = gapsStrategy.computeTrailEma(state.candles, pos.trailLength);
  if (t.last == null) return;      // still warming up — gap-fill stop only

  pos.trailSpot = t.last;
  pos.trailBars = (pos.trailBars || 0) + 1;

  if (gapsStrategy.trailExitHit(pos.side, bar.close, t.last)) {
    simulateSell(
      `Trail — ${_resMin()}m candle closed ${pos.side === "PE" ? "above" : "below"} EMA${pos.trailLength} ` +
      `(${bar.close} ${pos.side === "PE" ? ">" : "<"} ${t.last})`
    );
  }
}

// ── The one decision of the day ──────────────────────────────────────────────
// Minimum gap between entry ATTEMPTS. Ticks arrive ~1/sec and every attempt can
// hit the option-chain + quotes APIs, so an entry that keeps failing must not
// hammer the broker for the whole entry window.
const ENTRY_RETRY_MS = 5000;

async function evaluateOpenDecision() {
  // Every guard here is synchronous and runs before the first await, so
  // concurrent ticks can never open two positions.
  if (state.position || state._entryInFlight || state.decisionMade) return;
  if (state._lastEntryAttemptMs && Date.now() - state._lastEntryAttemptMs < ENTRY_RETRY_MS) return;

  const nowMin = getISTMinutes();
  const startMin = _parseMins("GAPS_ENTRY_START", "09:15");
  const endMin   = _parseMins("GAPS_ENTRY_END",   "09:30");
  if (nowMin < startMin) return;

  if (nowMin >= endMin) {
    state.decisionMade = true;
    const why = `Past the entry window (${_envStr("GAPS_ENTRY_START", "09:15")}–${_envStr("GAPS_ENTRY_END", "09:30")} IST) — GAPS only acts on the open`;
    log(`⏸️ [GAPS-PAPER] ${why}`);
    skipLogger.appendSkipLog("gaps", { gate: "entry_window", reason: why, spot: state.lastTickPrice });
    return;
  }

  if (!resolveTodayOpen()) return;

  if (state.tradesTaken >= _maxDailyTrades()) {
    state.decisionMade = true;
    return;
  }

  // ── Risk gates ──────────────────────────────────────────────────────────
  const maxLoss = _maxDailyLoss();
  if (maxLoss > 0 && state.sessionPnl <= -maxLoss) {
    state.decisionMade = true;
    const why = `Daily loss cap hit (₹${state.sessionPnl} ≤ -₹${maxLoss})`;
    log(`⏸️ [GAPS-PAPER] ${why}`);
    skipLogger.appendSkipLog("gaps", { gate: "daily_loss", reason: why, spot: state.lastTickPrice });
    return;
  }
  const maxWeek = _maxWeeklyLoss();
  if (maxWeek > 0) {
    const wk = weeklyPnl();
    if (wk <= -maxWeek) {
      state.decisionMade = true;
      const why = `Weekly loss cap hit (week P&L ₹${wk} ≤ -₹${maxWeek})`;
      log(`⏸️ [GAPS-PAPER] ${why}`);
      skipLogger.appendSkipLog("gaps", { gate: "weekly_loss", reason: why, weeklyPnl: wk, spot: state.lastTickPrice });
      return;
    }
  }
  const streak = _lossStreakSkip();
  if (streak > 0 && state.consecutiveLosses >= streak) {
    state.decisionMade = true;
    const why = `Risk breaker — ${state.consecutiveLosses} consecutive losses ≥ ${streak}`;
    log(`⏸️ [GAPS-PAPER] ${why}`);
    skipLogger.appendSkipLog("gaps", { gate: "loss_streak", reason: why, spot: state.lastTickPrice });
    return;
  }
  {
    const pf = require("../utils/portfolioRisk").checkPortfolioCap();
    if (pf.blocked) {
      state.decisionMade = true;
      log(`⏸️ [GAPS-PAPER] ${pf.reason}`);
      skipLogger.appendSkipLog("gaps", { gate: "portfolio_loss", reason: pf.reason, spot: state.lastTickPrice });
      return;
    }
  }

  // ── The signal ──────────────────────────────────────────────────────────
  const sig = gapsStrategy.getSignal(state.dailyCandles, state.todayOpen, {
    snapshot: state.daily,
    sessionDayUnixSec: Math.floor(Date.now() / 1000),
  });
  state.lastSignal = sig;

  log(`🔎 [GAPS-PAPER] Open decision — today's open ${state.todayOpen} (${state.todayOpenSource})`);
  if (sig.prevClose != null) {
    log(`   ├─ Yesterday ${sig.prevDate}: close ${sig.prevClose} · RSI ${sig.prevRsi} (${sig.rsiSource}) · EMA ${sig.prevEma}`);
    log(`   ├─ Gap: ${sig.gapPts > 0 ? "+" : ""}${sig.gapPts}pt (${sig.gapPct > 0 ? "+" : ""}${sig.gapPct}%) ${sig.gapDir}`);
  }

  if (sig.signal === "NONE" || !sig.side) {
    state.decisionMade = true;
    log(`   └─ NO TRADE: ${sig.skipReason || sig.reason}`);
    skipLogger.appendSkipLog("gaps", {
      gate: sig.warmup ? "warmup" : "signal_none",
      reason: sig.skipReason || sig.reason,
      spot: state.lastTickPrice,
      prevClose: sig.prevClose, prevRsi: sig.prevRsi, prevEma: sig.prevEma,
      todayOpen: sig.todayOpen, gapPts: sig.gapPts, gapPct: sig.gapPct, gapDir: sig.gapDir,
    });
    return;
  }

  log(`   └─ ENTER ${sig.side}: ${sig.reason}`);
  state._entryInFlight = true;
  state._lastEntryAttemptMs = Date.now();
  try {
    await simulateBuy(sig.side, sig);
  } finally {
    state._entryInFlight = false;
    // Lock the day's decision ONLY once a position actually exists. A failed
    // entry (option LTP unavailable, expiry unresolved) is an infrastructure
    // problem, not a decision — losing the whole day to a one-second blip at
    // 09:15 would be wrong. Retry on a later tick; GAPS_ENTRY_END already
    // bounds how long that can go on, and ENTRY_RETRY_MS throttles the
    // broker calls in between.
    if (state.position) state.decisionMade = true;
    else log(`⚠️ [GAPS-PAPER] Entry attempt failed — will retry while inside the entry window (until ${_envStr("GAPS_ENTRY_END", "09:30")} IST)`);
  }
}

// ── Candle close handler ─────────────────────────────────────────────────────
function onCandleClose(bar) {
  if (state.position) { _checkTrailOnClose(bar); return; }
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
      if (state.candles.length > 300) state.candles.shift();
      try { onCandleClose(state.currentBar); }
      catch (e) { console.error(`🚨 [GAPS-PAPER] onCandleClose error: ${e.message}`); }
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
    if (nowMin >= _parseMins("GAPS_FORCED_EXIT", "15:15")) {
      simulateSell(`EOD square-off (${_envStr("GAPS_FORCED_EXIT", "15:15")} IST)`);
    }
  }

  if (!state.position && !state.decisionMade) {
    evaluateOpenDecision().catch(e => console.error(`🚨 [GAPS-PAPER] open-decision error: ${e.message}`));
  }
}

// ── Preload intraday history (so the chart is not empty at the open) ─────────
async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { fetchCandles } = require("../services/backtestEngine");
    const _now = new Date();
    const istToday = _now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const istStart = new Date(_now.getTime() - 5 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached(NIFTY_INDEX_SYMBOL, String(_resMin()), istStart, istToday, fetchCandles);
    if (Array.isArray(candles) && candles.length > 0) {
      state.candles = candles.slice(-200);
      log(`📊 [GAPS-PAPER] Preloaded ${state.candles.length} × ${_resMin()}-min spot candles (${istStart}→${istToday})`);
    } else {
      log(`📊 [GAPS-PAPER] No intraday history available — will build from live ticks`);
    }
  } catch (e) {
    log(`⚠️ [GAPS-PAPER] Intraday preload failed: ${e.message}`);
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
  _autoStopTimer = setTimeout(() => { log(`⏰ [GAPS-PAPER] Auto-stop @ ${raw} IST`); stopSession(); }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ────────────────────────────────────────────────────────
router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/gaps-paper/status");

  if (String(process.env.GAPS_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("GAPS Disabled", "Enable GAPS Mode in Settings first", "/settings", "Go to Settings"));
  }
  if (String(process.env.GAPS_PAPER_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("GAPS Paper Disabled", "Enable GAPS Paper Trading in Settings first", "/settings", "Go to Settings"));
  }

  const check = sharedSocketState.canStart("GAPS_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/gaps-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/gaps-paper/status", "← Back"));

  if (getISTMinutes() >= _parseMins("GAPS_FORCED_EXIT", "15:15")) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${_envStr("GAPS_FORCED_EXIT", "15:15")} IST — GAPS does not trade after this`, "/gaps-paper/status", "← Back"));
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `gaps-paper:${Date.now()}`;

  sharedSocketState.setGapsActive("GAPS_PAPER");

  const cfg = gapsStrategy.getConfig();
  log(`🟢 [GAPS-PAPER] Session started — ${gapsStrategy.NAME}`);
  log(`⚙️ [GAPS-PAPER] Settings: EMA${cfg.emaLength} · RSI(${cfg.rsiLength}) source=${cfg.rsiSource} · bands ${cfg.rsiLower}/${cfg.rsiUpper} · entry ${_envStr("GAPS_ENTRY_START", "09:15")}–${_envStr("GAPS_ENTRY_END", "09:30")} · exit TF ${_resMin()}m · trail ${_trailEnabled() ? `ON (${_resMin()}m EMA${_trailLen()} close-through)` : "OFF"} · EOD ${_envStr("GAPS_FORCED_EXIT", "15:15")} · qty ${gapsLotQty()}`);

  await preloadHistory();
  await loadDailyContext();
  resolveTodayOpen();
  if (state.todayOpen != null) log(`📈 [GAPS-PAPER] Today's open ${state.todayOpen} (${state.todayOpenSource})`);

  try {
    tickRecorder.recordSessionStart({
      mode: "gaps-paper",
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: state.candles.map(c => ({ ...c })),
      meta: {
        instrument: instrumentConfig.INSTRUMENT,
        resolutionMin: _resMin(),
        spotSymbol: NIFTY_INDEX_SYMBOL,
        sessionStartISO: state.sessionStart,
        recordsOptionLtps: true,
        // GAPS reads a DAILY series that the tick recorder cannot capture — pin the
        // derived numbers so a replay of this session reproduces the same decision.
        gapsDaily: state.daily && state.daily.ok ? {
          prevDate: state.daily.prevDate, prevClose: state.daily.prevClose,
          prevRsi: state.daily.prevRsi, prevEma: state.daily.prevEma,
          rsiSource: cfg.rsiSource, rsiLength: cfg.rsiLength, emaLength: cfg.emaLength,
          rsiUpper: cfg.rsiUpper, rsiLower: cfg.rsiLower,
        } : null,
        gapsTodayOpen: state.todayOpen,
        gapsTodayOpenSource: state.todayOpenSource,
      },
    });
  } catch (_) {}

  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [GAPS-PAPER] Piggybacking on existing WebSocket");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [GAPS-PAPER] Started WebSocket");
  }

  scheduleAutoStop();

  notifyStarted({
    mode: "GAPS-PAPER",
    text: [
      `📄 GAPS PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${gapsStrategy.NAME}`,
      `Indicators: EMA${cfg.emaLength} · RSI(${cfg.rsiLength}) on ${cfg.rsiSource} · bands ${cfg.rsiLower}/${cfg.rsiUpper}`,
      state.daily && state.daily.ok
        ? `Yesterday : ${state.daily.prevDate} close ${state.daily.prevClose} · RSI ${state.daily.prevRsi} · EMA ${state.daily.prevEma}`
        : `Yesterday : unavailable (${state.daily ? state.daily.reason : "no daily data"})`,
      `Entry win : ${_envStr("GAPS_ENTRY_START", "09:15")} → ${_envStr("GAPS_ENTRY_END", "09:30")} IST`,
      `Max trades: ${_maxDailyTrades()}/day`,
      `Square-off: ${_envStr("GAPS_FORCED_EXIT", "15:15")} IST`,
    ].filter(Boolean).join("\n"),
  });

  res.redirect("/gaps-paper/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped");
  state.running = false;
  stopOptionPolling();

  try { tickRecorder.recordSessionStop({ mode: "gaps-paper", sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  sharedSocketState.clearGaps();   // clear OWN mode first (else the socket never stops → leak)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: gapsStrategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
      saveData(data);
      log(`💾 [GAPS-PAPER] Session saved — ${state.sessionTrades.length} trades, PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ [GAPS-PAPER] Save failed: ${e.message}`);
    }
  }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  log(`📋 [GAPS-PAPER] Day summary — ${state.sessionTrades.length} trade(s), ${wins}W/${state.sessionTrades.length - wins}L, net ₹${state.sessionPnl}, week ₹${weeklyPnl()}`);
  log("🔴 [GAPS-PAPER] Session stopped");

  notifyDayReport({
    mode: "GAPS-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/gaps-paper/status"); });
router.get("/exit", (req, res) => { if (state.position) simulateSell("Manual exit"); res.redirect("/gaps-paper/status"); });

// ── /status/chart-data — intraday candles + SL/target overlay + markers ───────
router.get("/status/chart-data", async (req, res) => {
  try {
    let srcCandles = state.candles;
    if (!state.running && srcCandles.length === 0 && (state.sessionTrades || []).length > 0) {
      srcCandles = await chartBackfill.candlesForRestoredTrades(NIFTY_INDEX_SYMBOL, _resMin(), state.sessionTrades);
    }
    const candles = srcCandles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.currentBar) candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });

    // Yesterday's close (= the stop / gap-fill) is a flat reference line, and so
    // is the daily EMA that feeds the RSI — neither moves during the session.
    let prevCloseLine = [], emaLine = [];
    if (candles.length && state.daily && state.daily.ok) {
      const fromTime = candles[0].time, toTime = candles[candles.length - 1].time;
      prevCloseLine = [{ time: fromTime, value: state.daily.prevClose }, { time: toTime, value: state.daily.prevClose }];
      emaLine       = [{ time: fromTime, value: state.daily.prevEma   }, { time: toTime, value: state.daily.prevEma   }];
    }

    // The trailing stop, from the same engine call the exit uses — so the line on
    // the chart is literally the level that would close the trade.
    const trailLen  = _trailLen();
    const trailSeries = _trailEnabled()
      ? gapsStrategy.computeTrailEma(candles, trailLen).series
      : [];

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

    const pos = state.position;
    return res.json({
      candles, markers,
      stopLoss:   pos ? pos.slSpot     : (state.daily && state.daily.ok ? state.daily.prevClose : null),
      entryPrice: pos ? pos.entrySpot  : null,
      target:     null,   // no fixed target — see trailSeries
      prevCloseLine, emaLine,
      trailSeries, trailLength: trailLen, trailEnabled: _trailEnabled(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * /status/daily-chart-data — the DAILY chart the strategy actually reads:
 * daily candles + EMA(GAPS_EMA_LENGTH) + RSI(GAPS_RSI_LENGTH on GAPS_RSI_SOURCE)
 * with the configured upper/lower bands. Values come from the same engine the
 * signal uses, so the chart can never disagree with the decision.
 */
router.get("/status/daily-chart-data", async (req, res) => {
  try {
    const cfg = gapsStrategy.getConfig();
    let daily = state.dailyCandles;
    if (!daily || !daily.length) {
      try {
        const { fetchCandlesCached } = require("../utils/candleCache");
        const { fetchCandles } = require("../services/backtestEngine");
        const now = new Date();
        const istToday = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const istStart = new Date(now.getTime() - 400 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        daily = await fetchCandlesCached(NIFTY_INDEX_SYMBOL, "D", istStart, istToday, fetchCandles);
        state.dailyCandles = Array.isArray(daily) ? daily.slice() : [];
        daily = state.dailyCandles;
      } catch (_) { daily = []; }
    }
    const d = gapsStrategy.computeDaily(daily, cfg);
    const KEEP = Math.max(60, parseInt(process.env.GAPS_DAILY_CHART_BARS || "180", 10) || 180);
    const candles = daily.slice(-KEEP).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    const cut = candles.length ? candles[0].time : 0;
    return res.json({
      candles,
      emaSeries: d.emaSeries.filter(p => p.time >= cut),
      rsiSeries: d.rsiSeries.filter(p => p.time >= cut),
      emaLength: cfg.emaLength,
      rsiLength: cfg.rsiLength,
      rsiSource: cfg.rsiSource,
      sourceLabel: d.sourceLabel,
      upper: cfg.rsiUpper,
      lower: cfg.rsiLower,
      prev: state.daily && state.daily.ok ? {
        date: state.daily.prevDate, close: state.daily.prevClose,
        rsi: state.daily.prevRsi, ema: state.daily.prevEma,
      } : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const data = loadData();
  const cfg = gapsStrategy.getConfig();

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * (pos.qty || gapsLotQty())).toFixed(2));
  }

  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) }); }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const bestTrade = state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null;
  const worstTrade = state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null;

  const daily = state.daily && state.daily.ok ? state.daily : null;
  const gapPts = (daily && state.todayOpen != null) ? parseFloat((state.todayOpen - daily.prevClose).toFixed(2)) : null;

  res.json({
    running: state.running, sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-100),
    tickCount: state.tickCount, lastTickPrice: state.lastTickPrice,
    candles: state.candles.length, currentBar: state.currentBar, sessionStart: state.sessionStart,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge,
    wins, losses, winRate, bestTrade, worstTrade, cumPnl, livePnl,
    weeklyPnl: weeklyPnl(),
    // GAPS context
    prevDate:  daily ? daily.prevDate  : null,
    prevClose: daily ? daily.prevClose : null,
    prevRsi:   daily ? daily.prevRsi   : null,
    prevEma:   daily ? daily.prevEma   : null,
    dailyReason: state.daily && !state.daily.ok ? state.daily.reason : null,
    todayOpen: state.todayOpen, todayOpenSource: state.todayOpenSource,
    gapPts, gapPct: (gapPts != null && daily && daily.prevClose) ? parseFloat(((gapPts / daily.prevClose) * 100).toFixed(2)) : null,
    gapDir: gapPts == null ? null : gapPts > 0 ? "UP" : gapPts < 0 ? "DOWN" : "FLAT",
    decisionMade: state.decisionMade,
    lastSkipReason: state.lastSignal && state.lastSignal.signal === "NONE" ? (state.lastSignal.skipReason || state.lastSignal.reason) : null,
    cfg: { emaLength: cfg.emaLength, rsiLength: cfg.rsiLength, rsiSource: cfg.rsiSource, upper: cfg.rsiUpper, lower: cfg.rsiLower, exitTf: _resMin(), trailEnabled: _trailEnabled(), trailLength: _trailLen() },
    position: pos ? {
      side: pos.side, symbol: pos.symbol, entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      slSpot: pos.slSpot, trailSpot: pos.trailSpot, trailLength: pos.trailLength, initialSlSpot: pos.initialSlSpot,
      optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry,
      peakPremium: pos.peakPremium, entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      riskPts: pos.riskPts, gapPts: pos.gapPts, gapDir: pos.gapDir, prevRsi: pos.prevRsi,
      qty: pos.qty, currentOptLtp: state.optionLtp,
    } : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

function _gapsCapital() {
  const v = parseFloat(process.env.FYERS_INV_AMOUNT);
  return isNaN(v) ? 100000 : v;
}

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  const data = loadData();
  const pos  = state.position;
  const cfg  = gapsStrategy.getConfig();

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const _maxTrades  = _maxDailyTrades();
  const _maxLoss    = _maxDailyLoss();
  const _maxWeek    = _maxWeeklyLoss();
  const _forcedExit = _envStr("GAPS_FORCED_EXIT", "15:15");
  const _entryStart = _envStr("GAPS_ENTRY_START", "09:15");
  const _entryEnd   = _envStr("GAPS_ENTRY_END",   "09:30");
  const dailyLossHit = _maxLoss > 0 && state.sessionPnl <= -_maxLoss;

  const daily = state.daily && state.daily.ok ? state.daily : null;
  const gapPts = (daily && state.todayOpen != null) ? parseFloat((state.todayOpen - daily.prevClose).toFixed(2)) : null;
  const gapDir = gapPts == null ? null : gapPts > 0 ? "UP" : gapPts < 0 ? "DOWN" : "FLAT";
  const rsiState = !daily ? null : daily.prevRsi > cfg.rsiUpper ? "OVERBOUGHT" : daily.prevRsi < cfg.rsiLower ? "OVERSOLD" : "NEUTRAL";
  const rsiColor = rsiState === "OVERBOUGHT" ? "#ef4444" : rsiState === "OVERSOLD" ? "#10b981" : "#4a6080";
  const gapColor = gapDir === "UP" ? "#10b981" : gapDir === "DOWN" ? "#ef4444" : "#4a6080";

  const pnlColor = (n) => (n || 0) >= 0 ? "#10b981" : "#ef4444";

  let livePnl = null;
  if (pos && state.optionLtp != null) livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * (pos.qty || gapsLotQty())).toFixed(2));

  const statCards = [
    { label: "Session PnL", value: `<span id="ajax-session-pnl" style="color:${pnlColor(state.sessionPnl)};">${typeof state.sessionPnl === "number" ? (state.sessionPnl >= 0 ? "+" : "") + "₹" + state.sessionPnl.toLocaleString("en-IN", {minimumFractionDigits:2, maximumFractionDigits:2}) : "—"}</span>`, accent: pnlColor(state.sessionPnl) },
    { label: "Trades Today", value: `<span id="ajax-trade-count">${state.tradesTaken || 0}</span> <span style="font-size:0.75rem;color:#4a6080;">/ ${_maxTrades}</span>`, sub: `<span id="ajax-wl">${wins}W · ${losses}L</span>`, accent: "#6a5090" },
    { label: "Live PnL", value: `<span id="ajax-live-pnl" style="color:${livePnl == null ? "#c8d8f0" : pnlColor(livePnl)};">${livePnl == null ? "—" : (livePnl >= 0 ? "+" : "") + "₹" + livePnl.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2})}</span>`, sub: `<span id="ajax-live-pnl-sub">${pos ? "unrealised" : "no open position"}</span>`, accent: "#3b82f6" },
    { label: `Yesterday RSI (${cfg.rsiSource})`, value: `<span id="ajax-prev-rsi" style="color:${rsiColor};font-weight:800;">${daily ? daily.prevRsi : "—"}</span>`, sub: `<span id="ajax-rsi-state" style="font-size:0.6rem;color:#4a6080;">${rsiState || "no daily data"} · bands ${cfg.rsiLower}/${cfg.rsiUpper}</span>`, accent: rsiColor },
    { label: "Gap @ Open", value: `<span id="ajax-gap" style="color:${gapColor};font-weight:800;">${gapPts == null ? "—" : (gapPts > 0 ? "+" : "") + gapPts + "pt"}</span>`, sub: `<span id="ajax-gap-sub" style="font-size:0.6rem;color:#4a6080;">${daily ? `prev close ${daily.prevClose} → open ${state.todayOpen != null ? state.todayOpen : "—"}` : "waiting for daily data"}</span>`, accent: gapColor },
    { label: `Daily EMA${cfg.emaLength} (RSI source)`, value: `<span id="ajax-prev-ema">${daily ? "₹" + daily.prevEma : "—"}</span>`, sub: `<span style="font-size:0.6rem;color:#4a6080;">${_trailEnabled() ? `exit trails the ${_resMin()}m EMA${_trailLen()}` : "trail DISABLED"}</span>`, accent: "#7c3aed" },
    { label: "Win Rate", value: `<span id="ajax-wr">${winRate != null ? winRate + "%" : "—"}</span>`, sub: `<span id="ajax-wr-sub" style="font-size:0.6rem;color:#4a6080;">best ${(state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t=>t.pnl||0)).toFixed(0) : "—")} / worst ${(state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t=>t.pnl||0)).toFixed(0) : "—")}</span>`, accent: "#a07010" },
    { label: "Risk Breakers", value: `<span id="ajax-daily-loss-val" style="color:${dailyLossHit ? "#ef4444" : "#10b981"};">${dailyLossHit ? "HIT" : "OK"}</span>`, sub: `<span id="ajax-daily-loss-sub" style="font-size:0.6rem;color:#4a6080;">day -₹${_maxLoss.toLocaleString("en-IN")}${_maxWeek > 0 ? ` · week -₹${_maxWeek.toLocaleString("en-IN")} (now ₹${weeklyPnl()})` : ""}</span>`, accent: dailyLossHit ? "#ef4444" : "#10b981" },
    { label: "WebSocket Ticks", value: `<span id="ajax-tick-count">${(state.tickCount || 0).toLocaleString()}</span>`, sub: `Last: <span id="ajax-last-tick">${state.lastTickPrice ? "₹" + state.lastTickPrice.toLocaleString("en-IN") : "—"}</span>`, accent: "#2a6080" },
    { label: "Session Start", value: `<span style="font-size:0.85rem;color:#c8d8f0;">${state.sessionStart ? fmtISTDateTime(state.sessionStart) : "—"}</span>`, accent: "#2a4020" },
  ];

  const setupBanner = (() => {
    if (!daily) {
      return `<div style="background:#1c1400;border:1px solid #78350f;border-radius:10px;padding:12px 16px;margin-bottom:16px;color:#fbbf24;font-size:0.8rem;">⚠️ Daily context unavailable — ${state.daily ? state.daily.reason : "session not started"}. GAPS cannot decide without yesterday's closed daily candle.</div>`;
    }
    const armed = rsiState === "OVERBOUGHT" ? "A gap DOWN today → BUY PE" : rsiState === "OVERSOLD" ? "A gap UP today → BUY CE" : "No setup — yesterday's RSI is inside the band, today is a no-trade day";
    const bg = rsiState === "NEUTRAL" ? "#0d1320" : "#0a1f0a";
    const bd = rsiState === "NEUTRAL" ? "#1a2236" : "#065f46";
    return `<div style="background:${bg};border:1px solid ${bd};border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:0.8rem;color:#c8d8f0;">
      <b style="color:${rsiColor};">${rsiState}</b> — yesterday (${daily.prevDate}) closed ${daily.prevClose} with RSI(${cfg.rsiLength} on ${daily.sourceLabel}) <b>${daily.prevRsi}</b> and EMA${cfg.emaLength} ${daily.prevEma}. ${armed}.
      ${state.todayOpen != null ? ` Today opened <b>${state.todayOpen}</b> (${state.todayOpenSource}) — gap <b style="color:${gapColor};">${gapPts > 0 ? "+" : ""}${gapPts}pt ${gapDir}</b>.` : " Waiting for today's open."}
      ${state.decisionMade && !pos && !state.sessionTrades.length ? `<div style="margin-top:6px;color:#94a3b8;">Decision taken: no trade — ${state.lastSignal ? (state.lastSignal.skipReason || state.lastSignal.reason) : "see log"}</div>` : ""}
    </div>`;
  })();

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
        <button onclick="gapsHandleExit(this)" style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;">Exit Trade Now</button>
      </div>
      <div style="background:#071a12;border:1px solid #134e35;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:2.2rem;font-weight:900;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side}</span>
            <div>
              <div style="font-size:0.72rem;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side === "CE" ? "CALL · oversold + gap up" : "PUT · overbought + gap down"}</div>
              <span style="font-size:0.65rem;font-weight:700;color:#94a3b8;">gap ${pos.gapPts > 0 ? "+" : ""}${pos.gapPts}pt ${pos.gapDir} · prev RSI ${pos.prevRsi}</span>
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
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop — gap fill</div><div style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.slSpot ? "₹" + pos.slSpot.toFixed(2) : "—"}</div><div style="font-size:0.6rem;color:#4a6080;margin-top:2px;">risk ${pos.riskPts}pt</div></div>
        <div style="background:#0a1f12;border:1px solid #0d4030;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Trail — ${_resMin()}m EMA${pos.trailLength || _trailLen()}</div><div style="font-size:1.05rem;font-weight:700;color:#10b981;">${!pos.trailEnabled ? "OFF" : pos.trailSpot != null ? "₹" + pos.trailSpot.toFixed(2) : "warming up"}</div><div style="font-size:0.6rem;color:#4a6080;margin-top:2px;">${!pos.trailEnabled ? "GAPS_TRAIL_ENABLED=false" : `exit on a close ${pos.side === "PE" ? "above" : "below"} it`}</div></div>
        <div style="background:#10131c;border:1px solid #1e2940;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Gap</div><div style="font-size:1.05rem;font-weight:700;color:${pos.gapDir === "UP" ? "#10b981" : "#ef4444"};">${pos.gapPts > 0 ? "+" : ""}${pos.gapPts}pt</div><div style="font-size:0.6rem;color:#4a6080;margin-top:2px;">${pos.gapDir}</div></div>
        <div style="background:#0a1f12;border:1px solid #0d4030;border-radius:8px;padding:12px 14px;"><div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Peak Premium</div><div style="font-size:1.05rem;font-weight:700;color:#10b981;">${pos.peakPremium ? "₹" + pos.peakPremium.toFixed(2) : "—"}</div></div>
      </div>
      ${pos.entryReason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;margin-top:12px;">Entry: ${pos.entryReason}</div>` : ""}
    </div>`;
  })() : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:0.9rem;font-weight:600;color:#4a6080;">FLAT — ${state.running ? (state.decisionMade ? "today's open decision is done" : "waiting for today's open") : "Session stopped"}</div>
    </div>`;

  const allLogs = [...state.log].reverse();
  const logsJSON = JSON.stringify(allLogs).replace(/<\/script>/gi, "<\\/script>").replace(/`/g, "\\u0060").replace(/\$/g, "\\u0024");
  const tradesJSON = JSON.stringify(state.sessionTrades).replace(/<\/script>/gi, "<\\/script>").replace(/`/g, "\\u0060").replace(/\$/g, "\\u0024");

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
${faviconLink()}
<title>GAPS Paper — ${gapsStrategy.NAME}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
<style>
${sidebarCSS()}
${modalCSS()}
${bbRsiStyleCSS()}
</style></head>
<body>
<div class="app-shell">
${buildSidebar('gapsPaper', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `secretGo('/gaps-paper/start', this)`, startLabel: '▶ Start GAPS',
  showStopBtn: state.running,   stopBtnJs:  `secretGo('/gaps-paper/stop', this)`,  stopLabel:  '■ Stop GAPS',
  showExitBtn: state.running && !!state.position, exitBtnJs: `secretGo('/gaps-paper/exit', this)`, exitLabel: '🚪 Exit Trade',
})}
<div class="main-content">

${bbRsiTopBar({
  title: "GAPS Paper Trade",
  metaLine: `Strategy: ${gapsStrategy.NAME} · EMA${cfg.emaLength} + RSI(${cfg.rsiLength} on ${cfg.rsiSource}) ${cfg.rsiLower}/${cfg.rsiUpper} · Entry ${_entryStart}–${_entryEnd} · Square-off ${_forcedExit} IST · ${state.running ? "Auto-refreshes every 2s" : "Stopped"}`,
  running: state.running,
  vix: { enabled: false, value: null, maxEntry: null, strongOnly: Infinity },
  primaryAction: { label: "Start GAPS Paper", href: "/gaps-paper/start" },
  stopAction:    { label: "Stop Session",     href: "/gaps-paper/stop"  },
  historyHref: "/gaps-paper/history",
})}

${bbRsiCapitalStrip({ starting: _gapsCapital(), current: data.capital, allTime: data.totalPnl, startingThreshold: _gapsCapital() })}

${setupBanner}

${bbRsiStatGrid(statCards)}

${bbRsiCurrentBar({ bar: state.currentBar, resMin: _resMin() })}

<div id="ajax-position-section" style="margin-bottom:18px;">
${posHtml}
</div>

${process.env.CHART_ENABLED !== "false" ? `<!-- Daily chart: the series the strategy actually reads -->
<div style="margin-bottom:18px;">
  <div class="section-title">NIFTY Daily — EMA${cfg.emaLength} + RSI(${cfg.rsiLength} on ${cfg.rsiSource}) with ${cfg.rsiUpper}/${cfg.rsiLower} bands</div>
  <div style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;">
    <div id="gaps-daily-chart" style="width:100%;height:300px;"></div>
    <div id="gaps-rsi-chart" style="width:100%;height:170px;border-top:1px solid #1a2236;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
      <span style="color:#3b82f6;">── EMA${cfg.emaLength} (daily)</span>
    </div>
    <div id="gaps-rsi-legend" style="padding:6px 12px;font-size:0.66rem;color:#4a6080;border-top:1px solid #1a2236;">
      <span style="color:#eab308;">── RSI(${cfg.rsiLength}) on ${cfg.rsiSource}</span> &nbsp; <span style="color:#ef4444;">┈ upper ${cfg.rsiUpper}</span> &nbsp; <span style="color:#10b981;">┈ lower ${cfg.rsiLower}</span>
    </div>
  </div>
</div>

<!-- Intraday chart: where the stop and target actually get hit -->
<div style="margin-bottom:18px;">
  <div class="section-title">NIFTY ${_resMin()}-Min Intraday (gap-fill stop + EMA${_trailLen()} trail)</div>
  <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:380px;">
    <div id="nifty-chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
      <span style="color:#f59e0b;">── Prev close / stop</span> &nbsp;<span style="color:#3b82f6;">── Daily EMA${cfg.emaLength} (RSI source)</span> &nbsp;<span style="color:#10b981;">── ${_resMin()}m EMA${_trailLen()} trail</span>
    </div>
  </div>
</div>` : ""}

<div id="gaps-trades-section" style="margin-bottom:18px;">
  <div class="section-title">Session Trades <span id="gaps-trades-hint" style="color:#4a6080;font-weight:400;letter-spacing:0.5px;text-transform:none;margin-left:8px;">${state.sessionTrades.length} trades</span><a href="/gaps-paper/download/trades.jsonl?format=ai" title="Download the full paper-trade log as an AI-friendly Markdown report" style="float:right;font-weight:400;font-size:0.72rem;letter-spacing:0.5px;text-transform:none;color:#4a9cf5;text-decoration:none;">🤖 AI export</a></div>
  <div id="gaps-trades-box" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;${state.sessionTrades.length ? "" : "padding:24px;text-align:center;color:#4a6080;font-size:0.82rem;"}">${state.sessionTrades.length ? "" : "No trades yet"}</div>
</div>

${bbRsiActivityLog({ logsJSON })}

</div><!-- /main-content -->
</div><!-- /app-shell -->

<script>
${modalJS()}
async function gapsHandleExit(btn) {
  var ok = await showConfirm({ icon:'🚪', title:'Exit position', message:'Exit current GAPS position now?', confirmText:'Exit', confirmClass:'modal-btn-danger' });
  if (!ok) return;
  var origLabel = btn.textContent;
  btn.disabled = true; btn.textContent = 'Exiting...';
  secretFetch('/gaps-paper/exit').then(function(r){
    if (!r) { btn.disabled = false; btn.textContent = origLabel; return; }
    location.reload();
  }).catch(function(){ location.reload(); });
}
</script>

<script>
// ── Daily chart (EMA + RSI with bands) — plots exactly what the engine computed ──
(function(){
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var priceEl = document.getElementById('gaps-daily-chart');
  var rsiEl   = document.getElementById('gaps-rsi-chart');
  if (!priceEl || !rsiEl) return;
  var common = {
    layout:{ background:{type:'solid',color:'#0a0f1c'}, textColor:'#4a6080', fontSize:11, fontFamily:"'IBM Plex Mono', monospace" },
    grid:{ vertLines:{color:'#111827'}, horzLines:{color:'#111827'} },
    crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale:{ borderColor:'#1a2236' },
    timeScale:{ borderColor:'#1a2236', timeVisible:false, secondsVisible:false },
  };
  var pChart = LightweightCharts.createChart(priceEl, Object.assign({ width: priceEl.clientWidth, height: priceEl.clientHeight }, common));
  var rChart = LightweightCharts.createChart(rsiEl,   Object.assign({ width: rsiEl.clientWidth,   height: rsiEl.clientHeight   }, common));
  var cs   = pChart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var emaS = pChart.addLineSeries({ color:'#3b82f6', lineWidth:2, priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false });
  var rsiS = rChart.addLineSeries({ color:'#eab308', lineWidth:2, priceLineVisible:false, lastValueVisible:true });
  var upS  = rChart.addLineSeries({ color:'#ef4444', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false });
  var loS  = rChart.addLineSeries({ color:'#10b981', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false });
  // Keep the two panes' time axes locked together. The re-entry guard matters:
  // each setVisibleLogicalRange fires the OTHER pane's handler, which would set
  // this one back — an unguarded pair ping-pongs on every pan/zoom.
  var _syncing = false;
  function _link(from, to) {
    from.timeScale().subscribeVisibleLogicalRangeChange(function(r){
      if (!r || _syncing) return;
      _syncing = true;
      try { to.timeScale().setVisibleLogicalRange(r); } finally { _syncing = false; }
    });
  }
  _link(pChart, rChart);
  _link(rChart, pChart);
  async function load(){
    try {
      var r = await fetch('/gaps-paper/status/daily-chart-data', { cache:'no-store' });
      var d = await r.json();
      if (!d || !d.candles) return;
      cs.setData(d.candles);
      emaS.setData(d.emaSeries || []);
      rsiS.setData(d.rsiSeries || []);
      var band = (d.rsiSeries || []).map(function(p){ return p.time; });
      if (band.length) {
        upS.setData(band.map(function(t){ return { time:t, value:d.upper }; }));
        loS.setData(band.map(function(t){ return { time:t, value:d.lower }; }));
      }
    } catch (e) {}
  }
  load();
  window.addEventListener('resize', function(){
    pChart.applyOptions({ width: priceEl.clientWidth });
    rChart.applyOptions({ width: rsiEl.clientWidth });
  });
})();
</script>

<script>
// ── Intraday chart (stop + target levels) ──
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
  var pcS = chart.addLineSeries({ color:'#f59e0b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var emS = chart.addLineSeries({ color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  // The trailing stop is a MOVING line, so it is a series, not a price line.
  var trS = chart.addLineSeries({ color:'#10b981', lineWidth:2, priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false });
  var entryLine = null, slLine = null, _zoomed = false;
  async function fetchChart(){
    try {
      var r = await fetch('/gaps-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) { (function(){
        var _lt=d.candles[d.candles.length-1].time, _dk=Math.floor((_lt+19800)/86400), _cut=_lt;
        for (var _i=d.candles.length-1;_i>=0;_i--){ if(Math.floor((d.candles[_i].time+19800)/86400)===_dk) _cut=d.candles[_i].time; else break; }
        var _k=function(a){ return Array.isArray(a)?a.filter(function(x){return x.time>=_cut;}):a; };
        d.candles=_k(d.candles);
        ['prevCloseLine','emaLine','trailSeries','markers'].forEach(function(kk){ if(d[kk]) d[kk]=_k(d[kk]); });
      })(); }
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        if (!_zoomed) { try {
          var lastT = d.candles[d.candles.length - 1].time, dayK = Math.floor((lastT + 19800) / 86400), firstT = lastT;
          for (var i = d.candles.length - 1; i >= 0; i--) { if (Math.floor((d.candles[i].time + 19800) / 86400) === dayK) firstT = d.candles[i].time; else break; }
          chart.timeScale().setVisibleRange({ from: firstT, to: lastT }); _zoomed = true;
        } catch(_) {} }
      }
      pcS.setData(d.prevCloseLine || []);
      emS.setData(d.emaLine || []);
      trS.setData(d.trailSeries || []);
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      if (entryLine) { cs.removePriceLine(entryLine); entryLine = null; }
      if (slLine)    { cs.removePriceLine(slLine);    slLine = null; }
      if (d.entryPrice) entryLine = cs.createPriceLine({ price:d.entryPrice, color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
      if (d.stopLoss)   slLine    = cs.createPriceLine({ price:d.stopLoss,   color:'#f59e0b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'Gap fill / SL' });
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
    var box = document.getElementById('gaps-trades-box');
    var hint = document.getElementById('gaps-trades-hint');
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
        '<td style="padding:8px 12px;font-weight:700;">' + (t.gapPts!=null?(t.gapPts>0?'+':'')+t.gapPts:'—') + '</td>' +
        '<td style="padding:8px 12px;">' + (t.prevRsi!=null?t.prevRsi:'—') + '</td>' +
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
        ['Entry Time','Exit Time','Side','Gap','PrevRSI','E.Spot','X.Spot','E.Opt','X.Opt','PnL','Exit Reason'].map(function(h){ return '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">'+h+'</th>'; }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function fetchAndUpdate(){
    try {
      var r = await fetch('/gaps-paper/status/data', { cache:'no-store' });
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
      setText('ajax-wr-sub', 'best ' + (bestN==null?'—':bestN) + ' / worst ' + (worstN==null?'—':worstN));
      var rsiEl2 = document.getElementById('ajax-prev-rsi');
      if (rsiEl2) { rsiEl2.textContent = d.prevRsi != null ? d.prevRsi : '—';
        rsiEl2.style.color = (d.prevRsi != null && d.cfg) ? (d.prevRsi > d.cfg.upper ? '#ef4444' : d.prevRsi < d.cfg.lower ? '#10b981' : '#4a6080') : '#4a6080'; }
      var gapEl = document.getElementById('ajax-gap');
      if (gapEl) { gapEl.textContent = d.gapPts == null ? '—' : (d.gapPts>0?'+':'') + d.gapPts + 'pt';
        gapEl.style.color = d.gapDir === 'UP' ? '#10b981' : d.gapDir === 'DOWN' ? '#ef4444' : '#4a6080'; }
      setText('ajax-gap-sub', d.prevClose != null ? ('prev close ' + d.prevClose + ' → open ' + (d.todayOpen != null ? d.todayOpen : '—')) : 'waiting for daily data');
      setText('ajax-prev-ema', d.prevEma != null ? '₹' + d.prevEma : '—');
      var dlossHit = _maxLoss > 0 && (d.sessionPnl || 0) <= -_maxLoss;
      var dlEl = document.getElementById('ajax-daily-loss-val'); if (dlEl) { dlEl.textContent = dlossHit ? 'HIT' : 'OK'; dlEl.style.color = dlossHit ? '#ef4444' : '#10b981'; }
      setText('ajax-tick-count', (d.tickCount || 0).toLocaleString());
      setText('ajax-last-tick', d.lastTickPrice ? INR(d.lastTickPrice) : '—');
      var capEl = document.getElementById('ajax-current-capital'); if (capEl) { capEl.textContent = INR(d.capital); capEl.style.color = d.capital >= ${_gapsCapital()} ? '#10b981' : '#ef4444'; }
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
    } catch (e) { console.warn('[gaps-paper] refresh:', e.message); }
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
    routePrefix: "/gaps-paper",
    sidebarKey: "gapsHistory",
    pageTitle: "🕳 GAPS Paper Trade History",
    pageDocTitle: "GAPS Paper — History",
    modalLabel: "GAPS Paper",
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap,
    emptyLabel: "Start GAPS paper trading to record your first session.",
  }));
});

const _GAPS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/download/daily-files", (req, res) => {
  const skips  = skipLogger.listDates("gaps");
  const trades = tradeLogger.listDailyDates("gaps");
  const byDate = new Map();
  for (const s of skips)  byDate.set(s.date, { date: s.date, skipsSize: s.size, tradesSize: 0 });
  for (const t of trades) { const row = byDate.get(t.date) || { date: t.date, skipsSize: 0, tradesSize: 0 }; row.tradesSize = t.size; byDate.set(t.date, row); }
  const rows = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  res.json(dailyFilesPaginate(rows, req.query));
});

router.get("/download/skips-all", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="gaps_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates("gaps").map(d => d.date).sort();
  let body = "";
  for (const d of dates) { try { const p = skipLogger.filePathFor("gaps", d); if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8"); } catch (_) {} }
  res.send(body);
});

// {prefix}/download/trades/:date + /download/skips/:date — GAPS writes both day
// files (skipLogger/tradeLogger mode "gaps"); these are what the Real-Time
// monitor's Copy Day Log reads. Same shape as bb_rsi / PA / EMA_RSI_ST /
// EMA9+VWAP / ORB — without them the GAPS card would sit on "— No Day Log —"
// while the files existed on disk.
router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_GAPS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor("gaps", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `gaps_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_GAPS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor("gaps", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `gaps_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_GAPS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor("gaps", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_GAPS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor("gaps", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop GAPS paper trading first before deleting a session." });
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
  if (state.running) return res.status(400).json({ success: false, error: "Stop GAPS paper trading before restoring." });
  const date = String(req.params.date || "").trim();
  if (!_GAPS_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades("gaps", date);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; if (key) seen.add(String(key)); }
  const missing = allTrades.filter(t => { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; return key && !seen.has(String(key)); });
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
  data.sessions.push({ date, strategy: (missing[0] && missing[0].strategy) || "GAPS", pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop GAPS paper trading before resetting." });
  const fresh = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  return res.json({ success: true, message: `GAPS paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
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
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) records.push(Object.assign({ date: s.date, mode: "gaps", strategy: s.strategy }, t));
    const today = new Date().toISOString().slice(0, 10);
    const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
    if (ai) {
      const md = aiExport.buildMarkdown(records, { title: "GAPS paper trades (full log)", source: "gaps-paper" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="gaps_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="gaps_paper_trades_${today}.jsonl"`);
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

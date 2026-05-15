/**
 * STRADDLE PAPER TRADE — /straddle-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * Long Straddle: buy 1 ATM CE + 1 ATM PE at the same strike & expiry.
 * Direction-agnostic — profits on big moves either way.
 *
 * Paper trade uses LIVE NIFTY + option data (Fyers WebSocket + REST quotes),
 * SIMULATES the orders locally (no broker hit). Both legs are tracked as a
 * single PAIRED position. Combined-premium target/SL triggers a coordinated
 * exit of BOTH legs at the same moment.
 *
 * Strategy: see src/strategies/straddle_volatility.js
 *
 * Endpoints:
 *   /straddle-paper/start    → connect socket, watch for trigger
 *   /straddle-paper/stop     → close pair (if any), save session
 *   /straddle-paper/status   → live view (pair, P&L, log)
 *   /straddle-paper/history  → past sessions
 *   /straddle-paper/status/data → JSON for AJAX poll
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const straddleStrategy   = require("../strategies/straddle_volatility");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, toastJS, tableEnhancerCSS } = require("../utils/sharedNav");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter   = require("../services/vixFilter");
const { fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const tradeLogger = require("../utils/tradeLogger");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { getISTMinutes, getBucketStart } = require("../utils/tradeUtils");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "straddlePaper";
const RES_MIN            = 5;   // 5-min candles for BB squeeze detection

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "straddle_paper_trades.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let _dataCache = null;
function loadData() {
  if (_dataCache) return _dataCache;
  ensureDir();
  if (!fs.existsSync(PT_FILE)) {
    const init = { capital: parseFloat(process.env.STRADDLE_PAPER_CAPITAL || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(init, null, 2));
    _dataCache = init;
    return init;
  }
  try { _dataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error("[straddle-paper] straddle_paper_trades.json corrupt — resetting:", e.message);
    _dataCache = { capital: parseFloat(process.env.STRADDLE_PAPER_CAPITAL || "100000"), totalPnl: 0, sessions: [] };
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
    sessionTrades:  [],   // PAIR-flat records (one entry per leg with pairId)
    sessionPnl:     0,
    pairsTaken:     0,
    candles:        [],
    currentBar:     null,
    barStartTime:   null,
    tickCount:      0,
    lastTickTime:   null,
    lastTickPrice:  null,
    position:       null, // { pairId, strike, expiry, ce:{...}, pe:{...}, ... }
    ceLtp:          null,
    peLtp:          null,
    optionLtpUpdatedAt: null,
    log:            [],
    _sessionId:     null,
    _expiryDayBlocked: false,
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

// ── Option LTP polling (BOTH legs) ──────────────────────────────────────────

let _optionPollTimer = null;
function startOptionPolling() {
  stopOptionPolling();
  _optionPollTimer = setInterval(async () => {
    if (!state.position) return;
    const symbols = [state.position.ce.symbol, state.position.pe.symbol];
    try {
      const r = await fyers.getQuotes(symbols);
      if (r && r.s === "ok" && Array.isArray(r.d)) {
        for (const d of r.d) {
          const sym = d.n || (d.v && d.v.symbol);
          const ltp = d.v && (d.v.lp || d.v.ltp);
          if (typeof ltp !== "number" || ltp <= 0) continue;
          if (sym === state.position.ce.symbol) state.ceLtp = ltp;
          if (sym === state.position.pe.symbol) state.peLtp = ltp;
        }
        state.optionLtpUpdatedAt = Date.now();
      }
    } catch (_) {}
  }, 3000);
}
function stopOptionPolling() {
  if (_optionPollTimer) { clearInterval(_optionPollTimer); _optionPollTimer = null; }
}

// ── Trade simulation ────────────────────────────────────────────────────────

async function simulateEntry(sigSnapshot) {
  const spot = state.lastTickPrice;
  if (!spot) return;

  // Resolve ATM CE + PE at the SAME expiry & strike
  let ceInfo, peInfo;
  try {
    ceInfo = await instrumentConfig.validateAndGetOptionSymbol(spot, "CE", "STRADDLE");
    peInfo = await instrumentConfig.validateAndGetOptionSymbol(spot, "PE", "STRADDLE");
  } catch (e) {
    log(`❌ [STRADDLE-PAPER] Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!ceInfo || ceInfo.invalid || !peInfo || peInfo.invalid) {
    log(`❌ [STRADDLE-PAPER] No valid expiry for one or both legs — skip entry`);
    return;
  }
  if (ceInfo.strike !== peInfo.strike) {
    log(`⚠️ [STRADDLE-PAPER] Strike mismatch CE=${ceInfo.strike} PE=${peInfo.strike} — adjusting PE to CE strike`);
    // Force PE onto CE's strike — preserves the "same strike" invariant
    peInfo.symbol = peInfo.symbol.replace(/(\d+)PE$/, `${ceInfo.strike}PE`);
    peInfo.strike = ceInfo.strike;
  }

  // Fetch entry premiums for both legs
  let cePrem = null, pePrem = null;
  try {
    const r = await fyers.getQuotes([ceInfo.symbol, peInfo.symbol]);
    if (r && r.s === "ok" && Array.isArray(r.d)) {
      for (const d of r.d) {
        const sym = d.n || (d.v && d.v.symbol);
        const ltp = d.v && (d.v.lp || d.v.ltp);
        if (typeof ltp !== "number" || ltp <= 0) continue;
        if (sym === ceInfo.symbol) cePrem = ltp;
        if (sym === peInfo.symbol) pePrem = ltp;
      }
    }
  } catch (e) {
    log(`⚠️ [STRADDLE-PAPER] Premium fetch failed: ${e.message}`);
  }
  if (!cePrem || !pePrem) {
    log(`❌ [STRADDLE-PAPER] Could not get premiums for both legs (CE=${cePrem}, PE=${pePrem}) — entry skipped`);
    return;
  }

  const qty = instrumentConfig.getLotQty();
  const netDebit = parseFloat((cePrem + pePrem).toFixed(2));
  const targetPct = parseFloat(process.env.STRADDLE_TARGET_PCT || "0.4");
  const stopPct   = parseFloat(process.env.STRADDLE_STOP_PCT   || "0.25");
  const targetNet = parseFloat((netDebit * (1 + targetPct)).toFixed(2));
  const stopNet   = parseFloat((netDebit * (1 - stopPct)).toFixed(2));

  const pairId = `S-${Date.now()}`;
  const pos = {
    pairId,
    strike:        ceInfo.strike,
    expiry:        ceInfo.expiry,
    qty,
    entrySpot:     spot,
    entryTime:     istNow(),
    entryTimeMs:   Date.now(),
    netDebit,
    targetNet,
    stopNet,
    peakCombined:  netDebit,
    ce: {
      symbol:     ceInfo.symbol,
      entryLtp:   cePrem,
    },
    pe: {
      symbol:     peInfo.symbol,
      entryLtp:   pePrem,
    },
    trigger:        sigSnapshot.trigger,
    signalStrength: sigSnapshot.signalStrength,
    bbWidth:        sigSnapshot.bbWidth,
    bbWidthAvg:     sigSnapshot.bbWidthAvg,
    vixAtEntry:     getCachedVix(),
    entryReason:    sigSnapshot.reason,
  };

  state.position = pos;
  state.ceLtp = cePrem;
  state.peLtp = pePrem;
  state.optionLtpUpdatedAt = Date.now();
  state.pairsTaken++;
  startOptionPolling();

  // Auto-clear one-shot forced-entry flag after use
  if ((process.env.STRADDLE_FORCE_ENTRY_NEXT || "false").toLowerCase() === "true") {
    process.env.STRADDLE_FORCE_ENTRY_NEXT = "false";
    log(`🔧 [STRADDLE-PAPER] Cleared STRADDLE_FORCE_ENTRY_NEXT after use`);
  }

  log(`🟢 [STRADDLE-PAPER] ENTER pair=${pairId} strike=${ceInfo.strike} | CE@₹${cePrem} + PE@₹${pePrem} = netDebit ₹${netDebit} | tgt ₹${targetNet} sl ₹${stopNet} | trigger=${sigSnapshot.trigger}`);

  notifyEntry({
    mode: "STRADDLE-PAPER",
    side: "CE+PE",
    symbol: `${ceInfo.symbol} + ${peInfo.symbol}`,
    spotAtEntry: spot,
    optionEntryLtp: netDebit,
    qty,
    stopLoss: stopNet,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "straddle-paper", sessionId: state._sessionId, ts: Date.now(),
      side: "STRADDLE", symbol: `${ceInfo.symbol}|${peInfo.symbol}`, qty,
      spotEntry: spot, optionEntry: netDebit,
      stopLoss: stopNet, targetSpot: null, reason: pos.entryReason,
    });
  } catch (_) {}
}

function simulateExit(reason) {
  if (!state.position) return;
  const pos = state.position;
  const exitCe = state.ceLtp || pos.ce.entryLtp;
  const exitPe = state.peLtp || pos.pe.entryLtp;
  const exitSpot = state.lastTickPrice || pos.entrySpot;
  const qty = pos.qty;
  const exitTime = istNow();

  // Charges per leg (fyers, options buy then sell)
  const chargesCE = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.ce.entryLtp, exitPremium: exitCe, qty });
  const chargesPE = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.pe.entryLtp, exitPremium: exitPe, qty });

  const cePnl = parseFloat(((exitCe - pos.ce.entryLtp) * qty - chargesCE).toFixed(2));
  const pePnl = parseFloat(((exitPe - pos.pe.entryLtp) * qty - chargesPE).toFixed(2));
  const pairPnl = parseFloat((cePnl + pePnl).toFixed(2));

  state.sessionPnl = parseFloat((state.sessionPnl + pairPnl).toFixed(2));

  // Two records, one per leg, linked by pairId — keeps consolidation analytics consistent.
  const baseFields = {
    pairId:        pos.pairId,
    qty,
    spotAtEntry:   pos.entrySpot,
    spotAtExit:    exitSpot,
    entryTime:     pos.entryTime,
    exitTime,
    optionStrike:  pos.strike,
    optionExpiry:  pos.expiry,
    entryReason:   pos.entryReason,
    exitReason:    reason,
    signalStrength: pos.signalStrength,
    vixAtEntry:    pos.vixAtEntry,
    trigger:       pos.trigger,
    bbWidth:       pos.bbWidth,
    bbWidthAvg:    pos.bbWidthAvg,
    netDebit:      pos.netDebit,
    netTarget:     pos.targetNet,
    netStop:       pos.stopNet,
    pairPnl,
    durationMs:    Date.now() - pos.entryTimeMs,
    instrument:    "NIFTY_OPTIONS",
    isFutures:     false,
  };
  const ceRow = Object.assign({}, baseFields, {
    leg:           "CE",
    side:          "CE",
    symbol:        pos.ce.symbol,
    entryPrice:    pos.entrySpot,
    exitPrice:     exitSpot,
    optionEntryLtp: pos.ce.entryLtp,
    optionExitLtp:  exitCe,
    optionType:    "CE",
    pnl:           cePnl,
    pnlMode:       `CE leg: ₹${pos.ce.entryLtp} → ₹${exitCe}`,
    charges:       chargesCE,
  });
  const peRow = Object.assign({}, baseFields, {
    leg:           "PE",
    side:          "PE",
    symbol:        pos.pe.symbol,
    entryPrice:    pos.entrySpot,
    exitPrice:     exitSpot,
    optionEntryLtp: pos.pe.entryLtp,
    optionExitLtp:  exitPe,
    optionType:    "PE",
    pnl:           pePnl,
    pnlMode:       `PE leg: ₹${pos.pe.entryLtp} → ₹${exitPe}`,
    charges:       chargesPE,
  });

  state.sessionTrades.push(ceRow, peRow);
  tradeLogger.appendTradeLog("straddle", ceRow);
  tradeLogger.appendTradeLog("straddle", peRow);

  log(`🔴 [STRADDLE-PAPER] EXIT pair=${pos.pairId} | CE ₹${pos.ce.entryLtp}→₹${exitCe} (₹${cePnl}) | PE ₹${pos.pe.entryLtp}→₹${exitPe} (₹${pePnl}) | pair PnL=₹${pairPnl} (${reason})`);

  notifyExit({
    mode: "STRADDLE-PAPER",
    side: "CE+PE", symbol: `${pos.ce.symbol} + ${pos.pe.symbol}`,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    optionEntryLtp: pos.netDebit, optionExitLtp: parseFloat((exitCe + exitPe).toFixed(2)),
    pnl: pairPnl, sessionPnl: state.sessionPnl,
    exitReason: reason, entryTime: pos.entryTime, exitTime, qty,
  });

  try {
    tickRecorder.recordExit({
      mode: "straddle-paper", sessionId: state._sessionId, ts: Date.now(),
      side: "STRADDLE", symbol: `${pos.ce.symbol}|${pos.pe.symbol}`, qty,
      spotExit: exitSpot, optionExit: parseFloat((exitCe + exitPe).toFixed(2)),
      pnl: pairPnl, reason,
    });
  } catch (_) {}

  state.position = null;
  state.ceLtp = null; state.peLtp = null;
  state.optionLtpUpdatedAt = null;
  stopOptionPolling();
}

// ── In-position management (tick-level) ─────────────────────────────────────

function _checkExits() {
  if (!state.position) return;
  const pos = state.position;
  if (state.ceLtp == null || state.peLtp == null) return;
  const combined = parseFloat((state.ceLtp + state.peLtp).toFixed(2));
  if (combined > pos.peakCombined) pos.peakCombined = combined;

  // Combined-premium target
  if (combined >= pos.targetNet) {
    simulateExit(`Combined target hit (₹${combined} >= ₹${pos.targetNet}, +${(parseFloat(process.env.STRADDLE_TARGET_PCT||"0.4")*100).toFixed(0)}%)`);
    return;
  }
  // Combined-premium SL
  if (combined <= pos.stopNet) {
    simulateExit(`Combined SL hit (₹${combined} <= ₹${pos.stopNet}, −${(parseFloat(process.env.STRADDLE_STOP_PCT||"0.25")*100).toFixed(0)}%)`);
    return;
  }
  // Time stop: max hold days
  const maxHoldDays = parseFloat(process.env.STRADDLE_MAX_HOLD_DAYS || "3");
  const heldMs = Date.now() - pos.entryTimeMs;
  if (heldMs > maxHoldDays * 24 * 3600 * 1000) {
    simulateExit(`Time stop (held > ${maxHoldDays} days)`);
    return;
  }
}

// ── Candle close handler ────────────────────────────────────────────────────

async function onCandleClose(_bar) {
  if (state.position) return;
  if (state._expiryDayBlocked) return;

  // Daily loss kill
  const maxLoss = parseFloat(process.env.STRADDLE_MAX_DAILY_LOSS || "3000");
  if (state.sessionPnl <= -maxLoss) return;

  // Max pairs per day (default 1)
  const maxPairs = parseInt(process.env.STRADDLE_MAX_DAILY_PAIRS || "1", 10);
  if (state.pairsTaken >= maxPairs) return;

  // Get current VIX (cached or fetch)
  let vix = getCachedVix();
  if (vix == null && (process.env.STRADDLE_VIX_ENABLED || "false").toLowerCase() === "true") {
    try { vix = await fetchLiveVix({ force: true }); } catch (_) {}
  }

  const sig = straddleStrategy.getSignal(state.candles, { alreadyOpen: !!state.position, vix });
  if (sig.signal !== "ENTER_STRADDLE") return;

  await simulateEntry(sig);
}

// ── onTick ──────────────────────────────────────────────────────────────────

function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (!price || price <= 0) return;

  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  // 5-min candle bucketing
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
      onCandleClose(state.currentBar).catch(e => console.error(`🚨 [STRADDLE-PAPER] onCandleClose error: ${e.message}`));
    }
    const bucketSec = Math.floor(bucketMs / 1000);
    const lastPre = state.candles.length ? state.candles[state.candles.length - 1] : null;
    if (lastPre && lastPre.time === bucketSec) {
      state.currentBar = state.candles.pop();
      state.currentBar.high  = Math.max(state.currentBar.high, price);
      state.currentBar.low   = Math.min(state.currentBar.low, price);
      state.currentBar.close = price;
    } else {
      state.currentBar = { time: bucketSec, open: price, high: price, low: price, close: price };
    }
    state.barStartTime = bucketMs;
  } else {
    state.currentBar.high  = Math.max(state.currentBar.high, price);
    state.currentBar.low   = Math.min(state.currentBar.low, price);
    state.currentBar.close = price;
  }

  // Exit check on tick (uses last cached option premiums)
  if (state.position) _checkExits();

  // EOD square-off
  if (state.position) {
    const nowMin = getISTMinutes();
    const stopMin = (function() {
      const raw = process.env.STRADDLE_FORCED_EXIT || "15:15";
      const [h, m] = raw.split(":").map(Number);
      return h * 60 + (isNaN(m) ? 0 : m);
    })();
    if (nowMin >= stopMin) {
      simulateExit(`EOD square-off (${process.env.STRADDLE_FORCED_EXIT || "15:15"} IST)`);
    }
  }
}

// ── Preload spot history ────────────────────────────────────────────────────

async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { fetchCandles } = require("../services/backtestEngine");
    const istToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    // We need ~25+ candles for BB squeeze detection — pull last 3 trading days
    const from = Math.floor(new Date(istToday + "T03:45:00.000Z").getTime() / 1000) - 3 * 86400;
    const to   = Math.floor(Date.now() / 1000);
    const candles = await fetchCandlesCached(NIFTY_INDEX_SYMBOL, RES_MIN, from, to, fetchCandles);
    if (Array.isArray(candles) && candles.length > 0) {
      state.candles = candles.slice(-200);
      log(`📊 [STRADDLE-PAPER] Preloaded ${state.candles.length} × ${RES_MIN}-min spot candles`);
    } else {
      log(`📊 [STRADDLE-PAPER] No history available — will build from live ticks`);
    }
  } catch (e) {
    log(`⚠️ [STRADDLE-PAPER] Preload failed: ${e.message}`);
  }
}

// ── Auto-stop ───────────────────────────────────────────────────────────────

let _autoStopTimer = null;
function scheduleAutoStop() {
  if (_autoStopTimer) clearTimeout(_autoStopTimer);
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  const stopMin = h * 60 + (isNaN(m) ? 0 : m);
  const now = getISTMinutes();
  const minsLeft = stopMin - now;
  if (minsLeft <= 0) return;
  _autoStopTimer = setTimeout(() => {
    log(`⏰ [STRADDLE-PAPER] Auto-stop @ ${raw} IST`);
    stopSession();
  }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ───────────────────────────────────────────────────────

router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/straddle-paper/status");

  if ((process.env.STRADDLE_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("Straddle Mode Disabled", "Enable Straddle Mode in Settings first", "/settings", "Go to Settings"));
  }

  const check = sharedSocketState.canStart("STRADDLE_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/straddle-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/straddle-paper/status", "← Back"));

  let _expiryBlocked = false;
  if ((process.env.STRADDLE_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
    const { isExpiryDay } = require("../utils/nseHolidays");
    const isExpiry = await isExpiryDay();
    if (!isExpiry) _expiryBlocked = true;
    log(`📅 [STRADDLE-PAPER] Expiry-only mode: ${isExpiry ? "✅ Today is expiry — allowed" : "❌ Not expiry day — entries blocked"}`);
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `straddle-paper:${Date.now()}`;
  state._expiryDayBlocked = _expiryBlocked;

  sharedSocketState.setStraddleActive("STRADDLE_PAPER");

  await preloadHistory();

  if ((process.env.STRADDLE_VIX_ENABLED || "false").toLowerCase() === "true") {
    resetVixCache();
    fetchLiveVix({ force: true }).catch(() => {});
  }

  try {
    tickRecorder.recordSessionStart({
      mode: "straddle-paper",
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: state.candles.map(c => ({ ...c })),
      vix: getCachedVix(),
      meta: {
        instrument: instrumentConfig.INSTRUMENT,
        resolutionMin: RES_MIN,
        expiryDayBlocked: _expiryBlocked,
        spotSymbol: NIFTY_INDEX_SYMBOL,
        sessionStartISO: state.sessionStart,
      },
    });
  } catch (_) {}

  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [STRADDLE-PAPER] Piggybacking on existing WebSocket");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [STRADDLE-PAPER] Started WebSocket");
  }

  scheduleAutoStop();
  log(`🟢 [STRADDLE-PAPER] Session started — ${RES_MIN}-min candles, paired ATM CE+PE`);

  notifyStarted({
    mode: "STRADDLE-PAPER",
    text: [
      `📄 STRADDLE PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy : ${straddleStrategy.NAME}`,
      `Entry    : BB-squeeze / low-VIX / forced-event triggers`,
      `Window   : ${process.env.STRADDLE_ENTRY_START || "09:30"} → ${process.env.STRADDLE_ENTRY_END || "11:00"} IST`,
      `Target   : +${((parseFloat(process.env.STRADDLE_TARGET_PCT || "0.4"))*100).toFixed(0)}% on net debit | SL: −${((parseFloat(process.env.STRADDLE_STOP_PCT || "0.25"))*100).toFixed(0)}%`,
      _expiryBlocked ? `\n⚠️ Expiry-only mode: entries blocked (not expiry day)` : null,
    ].filter(Boolean).join("\n"),
  });

  res.redirect("/straddle-paper/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateExit("Session stopped");
  state.running = false;
  stopOptionPolling();

  try {
    tickRecorder.recordSessionStop({ mode: "straddle-paper", sessionId: state._sessionId || null, reason: "user_stop" });
  } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) {
    socketManager.stop();
  }
  sharedSocketState.clearStraddle();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({
        date: state.sessionStart,
        strategy: straddleStrategy.NAME,
        pnl: state.sessionPnl,
        trades: state.sessionTrades,
      });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      saveData(data);
      log(`💾 [STRADDLE-PAPER] Session saved — ${state.sessionTrades.length} legs in ${state.pairsTaken} pairs, PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ [STRADDLE-PAPER] Save failed: ${e.message}`);
    }
  }

  log("🔴 [STRADDLE-PAPER] Session stopped");

  notifyDayReport({
    mode: "STRADDLE-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => {
  stopSession();
  res.redirect("/straddle-paper/status");
});

router.get("/exit", (req, res) => {
  if (state.position) simulateExit("Manual exit");
  res.redirect("/straddle-paper/status");
});

// ── Status page ─────────────────────────────────────────────────────────────

// ── /status/chart-data — Lightweight Charts feed with BB bands ───────────────
router.get("/status/chart-data", (req, res) => {
  try {
    const candles = state.candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.currentBar) {
      candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });
    }

    // BB overlay — Straddle's primary entry trigger
    const { BollingerBands } = require("technicalindicators");
    const BB_PERIOD = parseInt(process.env.STRADDLE_BB_PERIOD || "20", 10);
    const BB_STDDEV = parseFloat(process.env.STRADDLE_BB_STDDEV || "2");
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

    const markers = [];
    // Build markers by walking the saved session trades (leg-flat, group by pairId)
    const pairs = new Map();
    for (const t of state.sessionTrades) {
      if (!t.pairId) continue;
      if (!pairs.has(t.pairId)) pairs.set(t.pairId, { entrySpot: t.spotAtEntry, exitSpot: t.spotAtExit, pairPnl: t.pairPnl });
    }
    for (const [_pid, p] of pairs) {
      if (p.entrySpot != null) {
        const c = candles.find(c => Math.abs(c.close - p.entrySpot) < 1) || candles[0];
        if (c) markers.push({ time: c.time, position: 'belowBar', color: '#ec4899', shape: 'circle', text: 'STR @ ' + p.entrySpot });
      }
      if (p.exitSpot != null) {
        const c = candles.find(c => Math.abs(c.close - p.exitSpot) < 1) || candles[candles.length - 1];
        if (c) markers.push({ time: c.time, position: 'aboveBar', color: p.pairPnl >= 0 ? '#10b981' : '#ef4444', shape: 'square', text: 'Exit ' + (p.pairPnl >= 0 ? '+' : '') + Math.round(p.pairPnl || 0) });
      }
    }

    const entryPrice = state.position && state.position.entrySpot != null ? state.position.entrySpot : null;

    return res.json({ candles, markers, entryPrice, bbUpper, bbMiddle, bbLower });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const combined = (state.ceLtp != null && state.peLtp != null)
    ? parseFloat((state.ceLtp + state.peLtp).toFixed(2))
    : null;
  const data = loadData();

  // Live P&L (pair-level)
  let livePnl = null;
  if (pos && state.ceLtp != null && state.peLtp != null) {
    const lot = pos.qty || instrumentConfig.getLotQty();
    livePnl = parseFloat((((state.ceLtp - pos.ce.entryLtp) + (state.peLtp - pos.pe.entryLtp)) * lot).toFixed(2));
  }

  // Cumulative P&L from pair-level (group by pairId)
  const pairMap = new Map();
  for (const t of state.sessionTrades) {
    if (!t.pairId) continue;
    if (!pairMap.has(t.pairId)) pairMap.set(t.pairId, { ts: 0, pnl: 0 });
    const p = pairMap.get(t.pairId);
    p.pnl += (t.pnl || 0);
    p.ts = t.exitTime || t.entryTime;
  }
  const pairs = Array.from(pairMap.values());
  let cum = 0;
  const cumPnl = pairs.map(p => { cum += p.pnl; return { t: p.ts, pnl: parseFloat(cum.toFixed(2)) }; });

  const wins = pairs.filter(p => p.pnl > 0).length;
  const losses = pairs.filter(p => p.pnl < 0).length;
  const winRate = pairs.length ? ((wins / pairs.length) * 100).toFixed(1) : null;
  const bestPair = pairs.length ? Math.max(...pairs.map(p => p.pnl)) : null;
  const worstPair = pairs.length ? Math.min(...pairs.map(p => p.pnl)) : null;

  res.json({
    running:        state.running,
    sessionPnl:     state.sessionPnl,
    pairsTaken:     state.pairsTaken,
    sessionTrades:  state.sessionTrades.slice(-50),
    log:            state.log.slice(-100),
    tickCount:      state.tickCount,
    lastTickPrice:  state.lastTickPrice,
    candles:        state.candles.length,
    ceLtp:          state.ceLtp,
    peLtp:          state.peLtp,
    combined,
    livePnl,
    vix:            getCachedVix(),
    wins, losses, winRate, bestPair, worstPair,
    cumPnl,
    position: pos ? {
      pairId: pos.pairId, strike: pos.strike, expiry: pos.expiry,
      entrySpot: pos.entrySpot, entryTime: pos.entryTime,
      netDebit: pos.netDebit, targetNet: pos.targetNet, stopNet: pos.stopNet,
      peakCombined: pos.peakCombined,
      ce: { symbol: pos.ce.symbol, entryLtp: pos.ce.entryLtp, curLtp: state.ceLtp },
      pe: { symbol: pos.pe.symbol, entryLtp: pos.pe.entryLtp, curLtp: state.peLtp },
      qty: pos.qty, trigger: pos.trigger, signalStrength: pos.signalStrength,
    } : null,
    totalPnl: data.totalPnl,
    capital: data.capital,
  });
});

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
${faviconLink()}
<title>Straddle Paper Trade</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;}
${sidebarCSS()}
${modalCSS()}
.main{flex:1;margin-left:200px;padding:16px 22px 40px;min-height:100vh;}
@media(max-width:900px){.main{margin-left:0;padding:14px;}}
.crumb{background:#06090e;border-bottom:0.5px solid #0e1428;padding:6px 22px;display:flex;align-items:center;gap:7px;margin:-16px -22px 14px;position:sticky;top:0;z-index:90;}
.crumb span.chip{font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;text-transform:uppercase;letter-spacing:0.5px;font-family:'IBM Plex Mono',monospace;}
.page-title{font-size:1.05rem;font-weight:700;margin-bottom:2px;}
.page-sub{font-size:0.7rem;color:#4a6080;margin-bottom:14px;}
.grid{display:grid;grid-template-columns:repeat(8,1fr);gap:10px;margin-bottom:14px;}
@media(max-width:1400px){.grid{grid-template-columns:repeat(4,1fr);}}
@media(max-width:700px){.grid{grid-template-columns:repeat(2,1fr);}}
.sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:11px 13px;position:relative;overflow:hidden;}
.sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:#ec4899;}
.sc.blue::before{background:#3b82f6;}.sc.red::before{background:#ef4444;}.sc.yellow::before{background:#f59e0b;}.sc.purple::before{background:#8b5cf6;}
.sc-label{font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:4px;font-family:'IBM Plex Mono',monospace;}
.sc-val{font-size:1.1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
.sc-sub{font-size:0.6rem;color:#4a6080;margin-top:3px;font-family:'IBM Plex Mono',monospace;}
.panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;margin-bottom:14px;}
.panel h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.4px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;display:flex;align-items:center;justify-content:space-between;}
.chart-wrap{position:relative;height:240px;}
.log{background:#040c18;border:0.5px solid #0e1e36;border-radius:6px;padding:8px 10px;font-family:'IBM Plex Mono',monospace;font-size:0.65rem;color:#94a3b8;max-height:280px;overflow-y:auto;white-space:pre-wrap;line-height:1.55;}
.log-search{background:#040c18;border:0.5px solid #0e1e36;color:#e0eaf8;padding:4px 8px;border-radius:5px;font-size:0.7rem;font-family:inherit;width:160px;}
table{width:100%;border-collapse:collapse;font-size:0.66rem;font-family:'IBM Plex Mono',monospace;}
th,td{padding:6px 8px;text-align:left;border-bottom:0.5px solid #0e1e36;}
th{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;background:#040c18;}
.pos{color:#10b981;}.neg{color:#ef4444;}.muted{color:#3a5070;}
.empty{text-align:center;color:#3a5070;padding:18px 0;font-size:0.7rem;}
.pos-row{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;}
.pos-cell{background:#040c18;border:0.5px solid #0e1e36;border-radius:8px;padding:9px 12px;}
.pos-cell-l{font-size:0.5rem;text-transform:uppercase;color:#3a5070;letter-spacing:1.2px;}
.pos-cell-v{font-size:0.92rem;font-weight:700;font-family:'IBM Plex Mono',monospace;margin-top:2px;}
.leg-row{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:10px;}
@media(max-width:900px){.pos-row,.leg-row{grid-template-columns:1fr;}}
</style></head><body>
<div class="app-shell">
${buildSidebar('straddlePaper', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/straddle-paper/start'`, startLabel: '▶ Start Straddle',
  showStopBtn: state.running,   stopBtnJs:  `location.href='/straddle-paper/stop'`,  stopLabel:  '■ Stop Straddle',
  showExitBtn: state.running && !!state.position, exitBtnJs: `location.href='/straddle-paper/exit'`, exitLabel: '🚪 Exit Pair',
})}
<main class="main">
  <div class="crumb">
    <span class="chip" style="background:rgba(236,72,153,0.1);color:#ec4899;border:0.5px solid rgba(236,72,153,0.3);">🎯 STRADDLE PAPER</span>
    <span style="color:#1e2a40;font-size:10px;">›</span>
    <span class="chip" style="background:rgba(245,158,11,0.1);color:#fbbf24;border:0.5px solid rgba(245,158,11,0.2);">${straddleStrategy.NAME}</span>
    <span style="color:#1e2a40;font-size:10px;">›</span>
    <span class="chip" id="crumb-status" style="background:rgba(74,96,128,0.15);color:#94a3b8;border:0.5px solid rgba(74,96,128,0.3);">—</span>
    <span style="margin-left:auto;font-size:0.6rem;color:#1e2a40;font-family:'IBM Plex Mono',monospace;" id="crumb-tick">— ticks · — candles</span>
  </div>
  <div class="page-title">🎯 Straddle Paper Trade <span style="font-size:0.65rem;color:#4a6080;font-weight:400;margin-left:8px;">paired ATM CE+PE long · volatility play · simulated orders</span></div>
  <div class="page-sub">BB-squeeze / low-VIX / event-day triggers. Combined-premium ±${((parseFloat(process.env.STRADDLE_TARGET_PCT || "0.4"))*100).toFixed(0)}%/−${((parseFloat(process.env.STRADDLE_STOP_PCT || "0.25"))*100).toFixed(0)}% exits.</div>

  <div class="grid">
    <div class="sc"><div class="sc-label">Status</div><div class="sc-val" id="status">—</div><div class="sc-sub" id="status-sub">—</div></div>
    <div class="sc blue"><div class="sc-label">Session P&L</div><div class="sc-val" id="pnl">—</div><div class="sc-sub" id="pnl-sub">— closed pairs</div></div>
    <div class="sc"><div class="sc-label">Live PnL</div><div class="sc-val" id="livePnl">—</div><div class="sc-sub" id="livePnl-sub">unrealised</div></div>
    <div class="sc yellow"><div class="sc-label">Win Rate</div><div class="sc-val" id="wr">—</div><div class="sc-sub" id="wr-sub">— W · — L</div></div>
    <div class="sc"><div class="sc-label">Best Pair</div><div class="sc-val pos" id="bestT">—</div><div class="sc-sub">single best</div></div>
    <div class="sc red"><div class="sc-label">Worst Pair</div><div class="sc-val neg" id="worstT">—</div><div class="sc-sub">single worst</div></div>
    <div class="sc purple"><div class="sc-label">Spot · VIX</div><div class="sc-val" id="spotVix">—</div><div class="sc-sub" id="comb">Live combined —</div></div>
    <div class="sc"><div class="sc-label">All-Time</div><div class="sc-val" id="totalPnl">—</div><div class="sc-sub">since first session</div></div>
  </div>

  <div class="panel">
    <h3><span>📌 Open Pair</span><span id="livePnlBadge" style="font-size:0.85rem;color:#94a3b8;"></span></h3>
    <div id="position-box" class="empty">No open pair — waiting for volatility trigger</div>
  </div>

  <!-- Live NIFTY chart with BB squeeze overlay -->
  <div class="panel">
    <h3><span>📊 Live NIFTY 5-min (BB ${process.env.STRADDLE_BB_PERIOD || "20"}/${process.env.STRADDLE_BB_STDDEV || "2"} overlay — squeeze trigger)</span>
      <span style="font-size:0.6rem;color:#4a6080;display:flex;gap:10px;">
        <span><span style="display:inline-block;width:10px;height:1px;background:rgba(74,156,245,0.7);vertical-align:middle;"></span> BB Upper/Lower</span>
        <span><span style="display:inline-block;width:10px;height:1px;background:rgba(148,163,184,0.55);border-top:1px dashed;vertical-align:middle;"></span> BB Mid</span>
        <span><span style="display:inline-block;width:10px;height:1px;background:#3b82f6;border-top:1px dotted #3b82f6;vertical-align:middle;"></span> Entry Spot</span>
      </span>
    </h3>
    <div id="niftyChart" style="position:relative;height:340px;"></div>
  </div>

  <div class="panel">
    <h3><span>📈 Today&apos;s Cumulative P&amp;L (per pair)</span><span id="chartHint" style="font-size:0.6rem;color:#4a6080;">— pairs</span></h3>
    <div class="chart-wrap"><canvas id="pnlChart"></canvas></div>
  </div>

  <div class="panel">
    <h3><span>📜 Session Trades (leg-flat, latest first)</span><span id="tradesHint" style="font-size:0.6rem;color:#4a6080;">— rows</span></h3>
    <div id="trades-box" class="empty">No trades yet</div>
  </div>

  <div class="panel">
    <h3><span>📓 Activity Log</span>
      <span><input class="log-search" id="logSearch" placeholder="Search log…" oninput="filterLog()"/></span>
    </h3>
    <div id="log" class="log">—</div>
  </div>
</main>
<script>
${modalJS()}
var _pnlChart = null;
var _rawLog = [];

// ── Lightweight Charts setup (live NIFTY + BB overlay) ──
var _niftyChart = null, _csSeries = null, _bbU = null, _bbM = null, _bbL = null;
var _entryLine = null;
function ensureNiftyChart(){
  if (_niftyChart) return;
  var container = document.getElementById('niftyChart');
  if (!container || typeof LightweightCharts === 'undefined') return;
  _niftyChart = LightweightCharts.createChart(container, {
    layout: { background: { color: 'transparent' }, textColor: '#94a3b8' },
    grid: { vertLines: { color: '#0e1e36' }, horzLines: { color: '#0e1e36' } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#0e1e36' },
    rightPriceScale: { borderColor: '#0e1e36' },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    width: container.clientWidth, height: 340,
  });
  _csSeries = _niftyChart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  _bbU = _niftyChart.addLineSeries({ color:'rgba(74,156,245,0.7)', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  _bbM = _niftyChart.addLineSeries({ color:'rgba(148,163,184,0.55)', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  _bbL = _niftyChart.addLineSeries({ color:'rgba(74,156,245,0.7)', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  window.addEventListener('resize', function(){ if (_niftyChart) _niftyChart.applyOptions({ width: container.clientWidth }); });
}
async function refreshChart(){
  ensureNiftyChart();
  if (!_csSeries) return;
  try {
    var r = await fetch('/straddle-paper/status/chart-data', { cache: 'no-store' });
    var d = await r.json();
    if (d.candles && d.candles.length) _csSeries.setData(d.candles);
    if (d.bbUpper && d.bbUpper.length) _bbU.setData(d.bbUpper);
    if (d.bbMiddle && d.bbMiddle.length) _bbM.setData(d.bbMiddle);
    if (d.bbLower && d.bbLower.length) _bbL.setData(d.bbLower);
    if (d.markers) _csSeries.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
    if (_entryLine) { _csSeries.removePriceLine(_entryLine); _entryLine = null; }
    if (d.entryPrice) _entryLine = _csSeries.createPriceLine({ price: d.entryPrice, color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
  } catch (e) { /* swallow */ }
}

async function refresh() {
  try {
    const r = await fetch('/straddle-paper/status/data', {cache:'no-store'});
    const d = await r.json();
    var pnlCls = d.sessionPnl > 0 ? 'pos' : d.sessionPnl < 0 ? 'neg' : 'muted';

    document.getElementById('status').innerHTML = d.running ? '<span class="pos">RUNNING</span>' : '<span class="muted">STOPPED</span>';
    document.getElementById('status-sub').textContent = (d.pairsTaken||0) + ' pairs taken';
    document.getElementById('crumb-status').innerHTML = d.running ? '<span style="color:#10b981;">● RUNNING</span>' : '<span style="color:#94a3b8;">○ STOPPED</span>';
    document.getElementById('crumb-tick').textContent = (d.tickCount||0) + ' ticks · ' + (d.candles||0) + ' candles';
    document.getElementById('pnl').innerHTML = '<span class="' + pnlCls + '">₹' + d.sessionPnl.toFixed(2) + '</span>';
    document.getElementById('pnl-sub').textContent = (d.pairsTaken||0) + ' pair' + ((d.pairsTaken||0)===1?'':'s');
    if(d.livePnl != null){
      var lc = d.livePnl > 0 ? 'pos' : d.livePnl < 0 ? 'neg' : 'muted';
      document.getElementById('livePnl').innerHTML = '<span class="' + lc + '">₹' + d.livePnl.toFixed(2) + '</span>';
      document.getElementById('livePnl-sub').textContent = 'unrealised (both legs)';
    } else {
      document.getElementById('livePnl').textContent = '—';
      document.getElementById('livePnl-sub').textContent = 'no open pair';
    }
    document.getElementById('wr').textContent = (d.winRate != null ? d.winRate + '%' : '—');
    document.getElementById('wr-sub').textContent = (d.wins||0) + 'W · ' + (d.losses||0) + 'L';
    document.getElementById('bestT').textContent = d.bestPair != null ? '₹' + d.bestPair.toFixed(0) : '—';
    document.getElementById('worstT').textContent = d.worstPair != null ? '₹' + d.worstPair.toFixed(0) : '—';
    document.getElementById('spotVix').textContent = (d.lastTickPrice ? d.lastTickPrice.toFixed(2) : '—') + ' · VIX ' + (d.vix != null ? d.vix.toFixed(1) : '—');
    document.getElementById('comb').textContent = d.combined != null ? 'Live combined ₹' + d.combined : 'No live combined';
    document.getElementById('totalPnl').innerHTML = '<span class="' + (d.totalPnl>=0?'pos':'neg') + '">₹' + (d.totalPnl||0).toLocaleString('en-IN', {maximumFractionDigits:0}) + '</span>';

    _rawLog = d.log || [];
    filterLog();

    if (d.position) {
      const p = d.position;
      const ceCur = p.ce.curLtp != null ? p.ce.curLtp : p.ce.entryLtp;
      const peCur = p.pe.curLtp != null ? p.pe.curLtp : p.pe.entryLtp;
      const combined = +(ceCur + peCur).toFixed(2);
      const liveCls = combined >= p.netDebit ? 'pos' : 'neg';
      const liveBadge = (d.livePnl != null) ? '<span class="' + (d.livePnl>=0?'pos':'neg') + '">₹' + d.livePnl.toFixed(0) + '</span>' : '—';
      document.getElementById('livePnlBadge').innerHTML = liveBadge + ' live';
      document.getElementById('position-box').className = '';
      document.getElementById('position-box').innerHTML =
        '<div class="pos-row">' +
        '  <div class="pos-cell"><div class="pos-cell-l">Pair</div><div class="pos-cell-v" style="font-size:0.72rem;">' + p.pairId + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Strike · Expiry</div><div class="pos-cell-v">' + p.strike + ' · ' + p.expiry + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Entry Spot · Time</div><div class="pos-cell-v">' + p.entrySpot + '<span style="font-weight:400;color:#94a3b8;font-size:0.7rem;"> · ' + p.entryTime + '</span></div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Trigger</div><div class="pos-cell-v" style="color:#fbbf24;">' + p.trigger + ' [' + (p.signalStrength||'—') + ']</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Qty (per leg)</div><div class="pos-cell-v">' + p.qty + '</div></div>' +
        '</div>' +
        '<div class="pos-row" style="margin-top:10px;">' +
        '  <div class="pos-cell"><div class="pos-cell-l">Net Debit</div><div class="pos-cell-v">₹' + p.netDebit + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Live Combined</div><div class="pos-cell-v ' + liveCls + '">₹' + combined + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Target / Stop</div><div class="pos-cell-v"><span class="pos">₹' + p.targetNet + '</span> / <span class="neg">₹' + p.stopNet + '</span></div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Peak Combined</div><div class="pos-cell-v">₹' + p.peakCombined + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Live P&amp;L</div><div class="pos-cell-v ' + (d.livePnl != null && d.livePnl >= 0 ? 'pos' : d.livePnl != null ? 'neg' : 'muted') + '">' + (d.livePnl != null ? '₹' + d.livePnl.toFixed(2) : '—') + '</div></div>' +
        '</div>' +
        '<div class="leg-row">' +
        '  <div class="pos-cell" style="border-left:3px solid #10b981;"><div class="pos-cell-l">CE Leg</div><div style="font-size:0.7rem;color:#94a3b8;margin-top:4px;">' + p.ce.symbol + '</div><div style="display:flex;justify-content:space-between;margin-top:6px;font-size:0.78rem;font-family:\\'IBM Plex Mono\\',monospace;"><span>₹' + p.ce.entryLtp + ' → ₹' + ceCur + '</span><span class="' + (ceCur >= p.ce.entryLtp ? 'pos' : 'neg') + '">' + (ceCur - p.ce.entryLtp >= 0 ? '+' : '') + (ceCur - p.ce.entryLtp).toFixed(2) + '</span></div></div>' +
        '  <div class="pos-cell" style="border-left:3px solid #ef4444;"><div class="pos-cell-l">PE Leg</div><div style="font-size:0.7rem;color:#94a3b8;margin-top:4px;">' + p.pe.symbol + '</div><div style="display:flex;justify-content:space-between;margin-top:6px;font-size:0.78rem;font-family:\\'IBM Plex Mono\\',monospace;"><span>₹' + p.pe.entryLtp + ' → ₹' + peCur + '</span><span class="' + (peCur >= p.pe.entryLtp ? 'pos' : 'neg') + '">' + (peCur - p.pe.entryLtp >= 0 ? '+' : '') + (peCur - p.pe.entryLtp).toFixed(2) + '</span></div></div>' +
        '</div>';
    } else {
      document.getElementById('position-box').className = 'empty';
      document.getElementById('position-box').textContent = d.running ? 'No open pair — waiting for volatility trigger' : 'No open pair';
      document.getElementById('livePnlBadge').textContent = '';
    }

    const trades = d.sessionTrades || [];
    document.getElementById('tradesHint').textContent = trades.length + ' row' + (trades.length===1?'':'s');
    if (trades.length) {
      const rows = trades.slice().reverse().map(function(t){
        var cls = t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : 'muted');
        var legCls = t.leg === 'CE' ? 'pos' : 'neg';
        return '<tr><td style="font-size:0.62rem;">' + (t.pairId||'') + '</td><td class="' + legCls + '"><b>' + (t.leg||'') + '</b></td><td>' + (t.symbol||'') + '</td><td>' + (t.entryTime||'') + '</td><td>' + (t.exitTime||'') + '</td><td>₹' + (t.optionEntryLtp||'') + '</td><td>₹' + (t.optionExitLtp||'') + '</td><td class="' + cls + '"><b>₹' + (t.pnl != null ? t.pnl.toFixed(2) : '—') + '</b></td><td style="color:#94a3b8;font-size:0.65rem;">' + (t.exitReason||'') + '</td></tr>';
      }).join('');
      document.getElementById('trades-box').className = '';
      document.getElementById('trades-box').innerHTML = '<table><tr><th>Pair</th><th>Leg</th><th>Symbol</th><th>Entry</th><th>Exit</th><th>E.LTP</th><th>X.LTP</th><th>Leg PnL</th><th>Exit Reason</th></tr>' + rows + '</table>';
    } else {
      document.getElementById('trades-box').className = 'empty';
      document.getElementById('trades-box').textContent = 'No trades yet';
    }

    renderChart(d.cumPnl || []);
    document.getElementById('chartHint').textContent = (d.cumPnl ? d.cumPnl.length : 0) + ' pair' + ((d.cumPnl && d.cumPnl.length===1)?'':'s');
    refreshChart();
  } catch (e) {}
}

function filterLog(){
  var q = (document.getElementById('logSearch').value || '').toLowerCase();
  var lines = q ? _rawLog.filter(function(l){ return l.toLowerCase().indexOf(q) >= 0; }) : _rawLog;
  document.getElementById('log').textContent = lines.join('\\n');
}

function renderChart(points){
  var ctx = document.getElementById('pnlChart');
  if(!ctx) return;
  if(_pnlChart){ _pnlChart.destroy(); _pnlChart = null; }
  var labels = points.map(function(_, i){ return i+1; });
  var data = points.map(function(p){ return p.pnl; });
  var endP = data.length ? data[data.length-1] : 0;
  var col = endP >= 0 ? '#ec4899' : '#ef4444';
  _pnlChart = new Chart(ctx, {
    type:'line',
    data:{ labels: labels, datasets:[{ data: data, borderColor: col, borderWidth: 2, backgroundColor: col+'22', fill: true, pointRadius: 3, tension: 0.3 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}, tooltip:{callbacks:{title:function(ctx){return 'Pair #'+ctx[0].label;}, label:function(ctx){return '₹'+Math.round(ctx.raw).toLocaleString('en-IN');}}}}, scales:{ x:{ticks:{color:'#3a5070',font:{size:9}}, grid:{display:false}}, y:{ticks:{color:'#3a5070',font:{size:9},callback:function(v){return '₹'+Math.round(v/1000)+'k';}}, grid:{color:'#0e1e36'}} } }
  });
}

refresh();
setInterval(refresh, 2000);
</script>
</div></body></html>`;
  res.send(html);
});

// ── History page (reuses backtestUI renderer for full parity) ────────────────

router.get("/history", (req, res) => {
  const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
  const data = loadData();

  // Group legs into pairs; one row per pair using pair-level P&L
  const pairMap = new Map();
  for (const sess of (data.sessions || [])) {
    for (const t of (sess.trades || [])) {
      if (!t.pairId) continue;
      if (!pairMap.has(t.pairId)) {
        pairMap.set(t.pairId, {
          pairId: t.pairId, entryTime: t.entryTime, exitTime: t.exitTime,
          strike: t.optionStrike, expiry: t.optionExpiry,
          spotEntry: t.spotAtEntry, spotExit: t.spotAtExit,
          ce: null, pe: null,
          pairPnl: t.pairPnl, exitReason: t.exitReason,
          trigger: t.trigger, strength: t.signalStrength,
          netDebit: t.netDebit, netTarget: t.netTarget, netStop: t.netStop,
          heldMs: t.durationMs,
        });
      }
      const p = pairMap.get(t.pairId);
      if (t.leg === "CE") p.ce = { entryLtp: t.optionEntryLtp, exitLtp: t.optionExitLtp, pnl: t.pnl, symbol: t.symbol };
      if (t.leg === "PE") p.pe = { entryLtp: t.optionEntryLtp, exitLtp: t.optionExitLtp, pnl: t.pnl, symbol: t.symbol };
    }
  }

  const trades = Array.from(pairMap.values()).map(p => {
    const entryTs = parseEntryTimeToTs(p.entryTime);
    const exitTs  = parseEntryTimeToTs(p.exitTime);
    return {
      side: "STRADDLE",
      entry: p.entryTime || "", exit: p.exitTime || "",
      entryTs, exitTs,
      ePrice: p.spotEntry, xPrice: p.spotExit,
      sl: p.netStop,
      pnl: p.pairPnl != null ? p.pairPnl : (p.ce && p.pe ? (p.ce.pnl + p.pe.pnl) : 0),
      reason: p.exitReason, entryReason: `${p.trigger || ""} [${p.strength || ""}]`,
      netDebit: p.netDebit,
      trigger: p.trigger, strength: p.strength,
      cePnl: p.ce ? p.ce.pnl : 0, pePnl: p.pe ? p.pe.pnl : 0,
      strike: p.strike, expiry: p.expiry,
      heldDays: p.heldMs ? (p.heldMs / 86400000).toFixed(2) : "0.00",
    };
  });
  trades.sort((a, b) => (b.entryTs || 0) - (a.entryTs || 0));
  const stats = computeBacktestStats(trades);

  const dates = trades.map(t => (t.entry || "").split(",")[0].trim()).filter(Boolean);
  const fromDate = dates.length ? dates[dates.length - 1] : "—";
  const toDate   = dates.length ? dates[0] : "—";

  res.send(renderBacktestResults({
    mode: "STRADDLE HISTORY",
    accent: "#ec4899",
    strategyName: straddleStrategy.NAME,
    endpoint: "/straddle-paper/history",
    from: fromDate, to: toDate,
    summary: stats,
    trades,
    activePage: "straddleHistory",
    extraTradeColumns: [
      { key: "trigger", label: "Trigger" },
      { key: "netDebit", label: "Debit ₹" },
      { key: "heldDays", label: "Held (d)" },
      { key: "strike", label: "Strike" },
    ],
    extraStats: [
      { label: "BB Squeeze Pairs", value: trades.filter(t => t.trigger === "BB_SQUEEZE").length },
      { label: "Low-VIX Pairs",    value: trades.filter(t => t.trigger === "LOW_VIX_CHEAP").length },
      { label: "Forced Entries",   value: trades.filter(t => t.trigger === "FORCED_EVENT").length },
      { label: "Sessions",         value: data.sessions ? data.sessions.length : 0 },
    ],
    notes: "Pair-level P&L (one row per straddle pair). Filters/sorts active. Each row's reason is the combined-premium exit decision (target/SL/time-stop).",
  }));
});

function parseEntryTimeToTs(timeStr) {
  if (!timeStr) return 0;
  const m = timeStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, y = parseInt(m[3], 10);
    const h = parseInt(m[4], 10), mi = parseInt(m[5], 10), s = m[6] ? parseInt(m[6], 10) : 0;
    return Math.floor(Date.UTC(y, mo, d, h, mi, s) / 1000) - 19800;
  }
  return Math.floor(Date.now() / 1000);
}

function _errorPage(title, message, backHref, backLabel) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>${faviconLink()}<title>${title}</title>
<style>body{font-family:Inter,sans-serif;background:#040c18;color:#e0eaf8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{color:#94a3b8;margin-bottom:18px;}
a{color:#3b82f6;text-decoration:none;border:0.5px solid #0e1e36;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>${title}</h2><p>${message}</p><a href="${backHref}">${backLabel}</a></body></html>`;
}

module.exports = router;
module.exports.stopSession = stopSession;

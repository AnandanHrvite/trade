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

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const combined = (state.ceLtp != null && state.peLtp != null)
    ? parseFloat((state.ceLtp + state.peLtp).toFixed(2))
    : null;
  const data = loadData();
  res.json({
    running:        state.running,
    sessionPnl:     state.sessionPnl,
    pairsTaken:     state.pairsTaken,
    sessionTrades:  state.sessionTrades.slice(-30),
    log:            state.log.slice(-50),
    tickCount:      state.tickCount,
    lastTickPrice:  state.lastTickPrice,
    candles:        state.candles.length,
    ceLtp:          state.ceLtp,
    peLtp:          state.peLtp,
    combined,
    vix:            getCachedVix(),
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
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;}
${sidebarCSS()}
${modalCSS()}
.main{flex:1;margin-left:200px;padding:16px 22px 40px;min-height:100vh;}
@media(max-width:900px){.main{margin-left:0;padding:14px;}}
.page-title{font-size:1.05rem;font-weight:700;margin-bottom:2px;}
.page-sub{font-size:0.7rem;color:#4a6080;margin-bottom:12px;}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:14px;}
@media(max-width:1100px){.grid{grid-template-columns:repeat(3,1fr);}}
@media(max-width:560px){.grid{grid-template-columns:repeat(2,1fr);}}
.sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:11px 13px;position:relative;overflow:hidden;}
.sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:#a855f7;}
.sc-label{font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:4px;font-family:'IBM Plex Mono',monospace;}
.sc-val{font-size:1.1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
.panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;margin-bottom:14px;}
.panel h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.4px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
.log{background:#040c18;border:0.5px solid #0e1e36;border-radius:6px;padding:8px 10px;font-family:'IBM Plex Mono',monospace;font-size:0.65rem;color:#94a3b8;max-height:280px;overflow-y:auto;white-space:pre-wrap;line-height:1.55;}
table{width:100%;border-collapse:collapse;font-size:0.66rem;font-family:'IBM Plex Mono',monospace;}
th,td{padding:6px 8px;text-align:left;border-bottom:0.5px solid #0e1e36;}
th{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;background:#040c18;}
.pos{color:#10b981;}.neg{color:#ef4444;}.muted{color:#3a5070;}
.empty{text-align:center;color:#3a5070;padding:18px 0;font-size:0.7rem;}
</style></head><body>
${buildSidebar('straddlePaper', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/straddle-paper/start'`, startLabel: '▶ Start Straddle',
  showStopBtn: state.running,   stopBtnJs:  `location.href='/straddle-paper/stop'`,  stopLabel:  '■ Stop Straddle',
  showExitBtn: state.running,   exitBtnJs:  `location.href='/straddle-paper/exit'`,  exitLabel:  '🚪 Exit Pair',
})}
<main class="main">
  <div class="page-title">📋 Straddle Paper Trade</div>
  <div class="page-sub">${straddleStrategy.NAME} — paired ATM CE+PE long (volatility play, simulated)</div>
  <div class="grid">
    <div class="sc"><div class="sc-label">Status</div><div class="sc-val" id="status">—</div></div>
    <div class="sc"><div class="sc-label">Session P&L</div><div class="sc-val" id="pnl">—</div></div>
    <div class="sc"><div class="sc-label">Pairs</div><div class="sc-val" id="pairs">—</div></div>
    <div class="sc"><div class="sc-label">Spot</div><div class="sc-val" id="spot">—</div></div>
    <div class="sc"><div class="sc-label">Net Debit (live)</div><div class="sc-val" id="combined">—</div></div>
    <div class="sc"><div class="sc-label">VIX</div><div class="sc-val" id="vix">—</div></div>
  </div>
  <div class="panel"><h3>Open Pair</h3><div id="position-box" class="empty">No open pair</div></div>
  <div class="panel"><h3>Session Trades (leg-flat)</h3><div id="trades-box" class="empty">No trades yet</div></div>
  <div class="panel"><h3>Activity Log</h3><div id="log" class="log">—</div></div>
</main>
<script>
${modalJS()}
${toastJS ? toastJS() : ""}
async function refresh() {
  try {
    const r = await fetch('/straddle-paper/status/data');
    const d = await r.json();
    document.getElementById('status').innerHTML = d.running ? '<span class="pos">RUNNING</span>' : '<span class="muted">STOPPED</span>';
    document.getElementById('pnl').innerHTML    = '<span class="' + (d.sessionPnl > 0 ? 'pos' : d.sessionPnl < 0 ? 'neg' : 'muted') + '">₹' + d.sessionPnl.toFixed(2) + '</span>';
    document.getElementById('pairs').textContent = d.pairsTaken;
    document.getElementById('spot').textContent = d.lastTickPrice ? d.lastTickPrice.toFixed(2) : '—';
    document.getElementById('combined').textContent = d.combined != null ? '₹' + d.combined : '—';
    document.getElementById('vix').textContent = d.vix != null ? d.vix.toFixed(2) : '—';
    document.getElementById('log').textContent = (d.log || []).join('\\n');

    if (d.position) {
      const p = d.position;
      const ceCur = p.ce.curLtp != null ? p.ce.curLtp : p.ce.entryLtp;
      const peCur = p.pe.curLtp != null ? p.pe.curLtp : p.pe.entryLtp;
      const combined = (ceCur + peCur).toFixed(2);
      const liveCls = combined >= p.netDebit ? 'pos' : 'neg';
      document.getElementById('position-box').innerHTML =
        '<table>' +
        '<tr><th>Pair</th><th>Strike</th><th>Expiry</th><th>Entry Spot</th><th>Entry Time</th><th>Net Debit</th><th>Live Combined</th><th>Target</th><th>SL</th><th>Trigger</th></tr>' +
        '<tr><td>' + p.pairId + '</td><td>' + p.strike + '</td><td>' + p.expiry + '</td><td>' + p.entrySpot + '</td><td>' + p.entryTime + '</td><td>₹' + p.netDebit + '</td><td class="' + liveCls + '">₹' + combined + '</td><td>₹' + p.targetNet + '</td><td>₹' + p.stopNet + '</td><td>' + p.trigger + '</td></tr>' +
        '</table>' +
        '<table style="margin-top:6px;">' +
        '<tr><th>Leg</th><th>Symbol</th><th>Entry LTP</th><th>Current LTP</th><th>Δ</th></tr>' +
        '<tr><td><b style="color:#10b981">CE</b></td><td>' + p.ce.symbol + '</td><td>₹' + p.ce.entryLtp + '</td><td>₹' + ceCur + '</td><td class="' + (ceCur >= p.ce.entryLtp ? 'pos' : 'neg') + '">' + (ceCur - p.ce.entryLtp).toFixed(2) + '</td></tr>' +
        '<tr><td><b style="color:#ef4444">PE</b></td><td>' + p.pe.symbol + '</td><td>₹' + p.pe.entryLtp + '</td><td>₹' + peCur + '</td><td class="' + (peCur >= p.pe.entryLtp ? 'pos' : 'neg') + '">' + (peCur - p.pe.entryLtp).toFixed(2) + '</td></tr>' +
        '</table>';
    } else {
      document.getElementById('position-box').className = 'empty';
      document.getElementById('position-box').textContent = 'No open pair';
    }

    const trades = d.sessionTrades || [];
    if (trades.length) {
      const rows = trades.slice().reverse().map(function(t){
        var cls = t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : 'muted');
        return '<tr><td>' + (t.pairId||'') + '</td><td>' + (t.leg||'') + '</td><td>' + (t.symbol||'') + '</td><td>' + (t.entryTime||'') + '</td><td>₹' + (t.optionEntryLtp||'') + '</td><td>₹' + (t.optionExitLtp||'') + '</td><td class="' + cls + '"><b>₹' + (t.pnl != null ? t.pnl.toFixed(2) : '—') + '</b></td><td style="color:#94a3b8">' + (t.exitReason||'') + '</td></tr>';
      }).join('');
      document.getElementById('trades-box').className = '';
      document.getElementById('trades-box').innerHTML = '<table><tr><th>Pair</th><th>Leg</th><th>Symbol</th><th>Entry</th><th>E.LTP</th><th>X.LTP</th><th>Leg PnL</th><th>Exit</th></tr>' + rows + '</table>';
    } else {
      document.getElementById('trades-box').className = 'empty';
      document.getElementById('trades-box').textContent = 'No trades yet';
    }
  } catch (e) { /* swallow */ }
}
refresh(); setInterval(refresh, 2000);
</script>
</body></html>`;
  res.send(html);
});

// ── History page ────────────────────────────────────────────────────────────

router.get("/history", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const data = loadData();
  // Group by pairId for net P&L view; flat list also useful
  const allLegs = [];
  for (const s of (data.sessions || [])) {
    for (const t of (s.trades || [])) {
      allLegs.push({
        date:       (s.date || "").slice(0, 10),
        pairId:     t.pairId, leg: t.leg, side: t.side,
        symbol:     t.symbol, strike: t.optionStrike, expiry: t.optionExpiry,
        entryTime:  t.entryTime, exitTime: t.exitTime,
        optEntry:   t.optionEntryLtp, optExit: t.optionExitLtp,
        pnl:        t.pnl, pairPnl: t.pairPnl,
        exitReason: t.exitReason, trigger: t.trigger,
        strength:   t.signalStrength,
      });
    }
  }
  // Aggregate pair-level rows
  const pairMap = new Map();
  for (const l of allLegs) {
    if (!l.pairId) continue;
    if (!pairMap.has(l.pairId)) pairMap.set(l.pairId, { pairId: l.pairId, date: l.date, strike: l.strike, expiry: l.expiry, entryTime: l.entryTime, exitTime: l.exitTime, ce: null, pe: null, pairPnl: l.pairPnl, trigger: l.trigger, exitReason: l.exitReason, strength: l.strength });
    const p = pairMap.get(l.pairId);
    if (l.leg === "CE") p.ce = l;
    if (l.leg === "PE") p.pe = l;
  }
  const pairs = Array.from(pairMap.values()).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const wins   = pairs.filter(p => (p.pairPnl || 0) > 0).length;
  const losses = pairs.filter(p => (p.pairPnl || 0) < 0).length;
  const wr = pairs.length ? ((wins / pairs.length) * 100).toFixed(1) : "0.0";
  const totalPnl = pairs.reduce((a, p) => a + (p.pairPnl || 0), 0);

  const rows = pairs.map(p => {
    const cls = (p.pairPnl || 0) > 0 ? "pos" : (p.pairPnl || 0) < 0 ? "neg" : "muted";
    return `<tr><td>${p.date}</td><td>${p.entryTime || ""}</td><td>${p.strike || ""}</td><td>${p.expiry || ""}</td><td>${p.ce ? "₹" + p.ce.optEntry + "→₹" + p.ce.optExit + " (" + (p.ce.pnl >= 0 ? "+" : "") + p.ce.pnl + ")" : "—"}</td><td>${p.pe ? "₹" + p.pe.optEntry + "→₹" + p.pe.optExit + " (" + (p.pe.pnl >= 0 ? "+" : "") + p.pe.pnl + ")" : "—"}</td><td>${p.trigger || ""}</td><td>${p.strength || ""}</td><td class="${cls}"><b>₹${(p.pairPnl || 0).toFixed(2)}</b></td><td style="color:#94a3b8">${p.exitReason || ""}</td></tr>`;
  }).join("");

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>${faviconLink()}<title>Straddle History</title>
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:Inter,sans-serif;}
body{background:#040c18;color:#e0eaf8;}
${sidebarCSS()}
.main{flex:1;margin-left:200px;padding:16px 22px;}
@media(max-width:900px){.main{margin-left:0;padding:14px;}}
.title{font-size:1.05rem;font-weight:700;margin-bottom:8px;}
.stats{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;}
.stat{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:10px 14px;}
.stat-l{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;}
.stat-v{font-size:1.05rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
table{width:100%;border-collapse:collapse;font-size:0.65rem;font-family:'IBM Plex Mono',monospace;background:#07111f;border:0.5px solid #0e1e36;border-radius:8px;overflow:hidden;}
th,td{padding:6px 8px;text-align:left;border-bottom:0.5px solid #0e1e36;}
th{background:#040c18;font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;}
.pos{color:#10b981;}.neg{color:#ef4444;}.muted{color:#3a5070;}
</style></head><body>
${buildSidebar('straddleHistory', liveActive, false)}
<main class="main">
  <div class="title">📜 Straddle Paper Trade History (per-pair)</div>
  <div class="stats">
    <div class="stat"><div class="stat-l">Total Pairs</div><div class="stat-v">${pairs.length}</div></div>
    <div class="stat"><div class="stat-l">Win Rate</div><div class="stat-v">${wr}%</div></div>
    <div class="stat"><div class="stat-l">Wins / Losses</div><div class="stat-v">${wins} / ${losses}</div></div>
    <div class="stat"><div class="stat-l">Net P&L</div><div class="stat-v ${totalPnl > 0 ? "pos" : totalPnl < 0 ? "neg" : "muted"}">₹${totalPnl.toFixed(2)}</div></div>
  </div>
  <table>
    <tr><th>Date</th><th>Entry</th><th>Strike</th><th>Expiry</th><th>CE Leg</th><th>PE Leg</th><th>Trigger</th><th>Sig</th><th>Pair PnL</th><th>Exit Reason</th></tr>
    ${rows || `<tr><td colspan="10" style="text-align:center;color:#3a5070;padding:24px;">No pairs yet</td></tr>`}
  </table>
</main>
</body></html>`);
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

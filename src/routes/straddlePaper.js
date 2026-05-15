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
const skipLogger = require("../utils/skipLogger");

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

async function onCandleClose(bar) {
  if (state.position) return;
  const _spot = bar && bar.close;

  if (state._expiryDayBlocked) {
    skipLogger.appendSkipLog("straddle", { gate: "expiry_day_only", reason: "Not an expiry day", spot: _spot });
    return;
  }

  // Daily loss kill
  const maxLoss = parseFloat(process.env.STRADDLE_MAX_DAILY_LOSS || "3000");
  if (state.sessionPnl <= -maxLoss) {
    skipLogger.appendSkipLog("straddle", { gate: "daily_loss", reason: `sessionPnl ${state.sessionPnl} <= -${maxLoss}`, spot: _spot });
    return;
  }

  // Max pairs per day (default 1)
  const maxPairs = parseInt(process.env.STRADDLE_MAX_DAILY_PAIRS || "1", 10);
  if (state.pairsTaken >= maxPairs) return; // expected, not a skip

  // Get current VIX (cached or fetch)
  let vix = getCachedVix();
  if (vix == null && (process.env.STRADDLE_VIX_ENABLED || "false").toLowerCase() === "true") {
    try { vix = await fetchLiveVix({ force: true }); } catch (_) {}
  }

  const sig = straddleStrategy.getSignal(state.candles, { alreadyOpen: !!state.position, vix });
  if (sig.signal !== "ENTER_STRADDLE") {
    // Only log when we have meaningful BB data — pre-warm-up "Warming up" lines are noise
    if (sig.bbWidth != null) {
      skipLogger.appendSkipLog("straddle", { gate: "signal_none", reason: sig.reason, spot: _spot, vix, bbWidth: sig.bbWidth, bbWidthAvg: sig.bbWidthAvg });
    }
    return;
  }

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

// ── Manual straddle entry — bypasses BB-squeeze/VIX triggers and opens a
//    paired ATM CE+PE position right now. Useful for event-day discretionary
//    entries (RBI, results, etc.). Reuses simulateEntry for full parity. ──
router.post("/manualEntry", async (req, res) => {
  if (!state.running) return res.status(400).json({ success: false, error: "Straddle paper is not running." });
  if (state.position) return res.status(400).json({ success: false, error: "Already in a pair. Exit first." });

  const spot = state.lastTickPrice || (state.currentBar ? state.currentBar.close : null);
  if (!spot) return res.status(400).json({ success: false, error: "No market data yet." });

  const sig = {
    signal: "ENTER_STRADDLE",
    trigger: "MANUAL",
    bbWidth: null, bbWidthAvg: null,
    signalStrength: "MANUAL",
    reason: `🖐️ MANUAL straddle entry @ spot ₹${spot}`,
  };
  log(`🖐️ [STRADDLE-PAPER] MANUAL entry triggered by user @ spot ₹${spot}`);
  try {
    await simulateEntry(sig);
    return res.json({ success: true, spot });
  } catch (e) {
    log(`❌ [STRADDLE-PAPER] Manual entry failed: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }
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
    <div id="manual-entry" style="display:none;margin-top:10px;text-align:right;">
      <button onclick="doManualEntry()" style="background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.4);padding:6px 14px;border-radius:5px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">🎯 Manual Straddle Entry (force CE+PE)</button>
    </div>
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
      document.getElementById('manual-entry').style.display = d.running ? 'block' : 'none';
    }
    if (d.position) document.getElementById('manual-entry').style.display = 'none';

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

async function doManualEntry(){
  if (!confirm('Force a MANUAL straddle entry (CE+PE pair)? This bypasses the BB-squeeze / VIX triggers.')) return;
  try {
    const r = await fetch('/straddle-paper/manualEntry', { method:'POST', headers:{'Content-Type':'application/json'}, body: '{}' });
    const j = await r.json();
    if (!j.success) { alert('Manual entry failed: ' + (j.error || 'unknown')); return; }
    refresh();
  } catch (e) { alert('Manual entry error: ' + e.message); }
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

// ── History page — session accordion (pair-level rows) ─────────────────────

router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const startCap = parseFloat(process.env.STRADDLE_PAPER_CAPITAL || "100000");

  const inr = n => typeof n === "number" ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
  const pnlColor = n => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";

  // Group all legs into pairs across all sessions for totals
  const allPairs = [];
  for (const s of data.sessions || []) {
    const pmap = new Map();
    for (const t of (s.trades || [])) {
      if (!t.pairId) continue;
      if (!pmap.has(t.pairId)) pmap.set(t.pairId, { pairId: t.pairId, entryTime: t.entryTime, exitTime: t.exitTime, strike: t.optionStrike, expiry: t.optionExpiry, spotEntry: t.spotAtEntry, spotExit: t.spotAtExit, ce: null, pe: null, pairPnl: t.pairPnl, exitReason: t.exitReason, trigger: t.trigger, strength: t.signalStrength, netDebit: t.netDebit, _sessionDate: s.date });
      const p = pmap.get(t.pairId);
      if (t.leg === "CE") p.ce = { entryLtp: t.optionEntryLtp, exitLtp: t.optionExitLtp, pnl: t.pnl, symbol: t.symbol };
      if (t.leg === "PE") p.pe = { entryLtp: t.optionEntryLtp, exitLtp: t.optionExitLtp, pnl: t.pnl, symbol: t.symbol };
    }
    allPairs.push.apply(allPairs, Array.from(pmap.values()));
  }
  const totalWins   = allPairs.filter(p => (p.pairPnl || 0) > 0).length;
  const totalLosses = allPairs.filter(p => (p.pairPnl || 0) < 0).length;
  const totalPnl    = allPairs.reduce((a, p) => a + (p.pairPnl || 0), 0);

  const sessionCards = data.sessions.length === 0
    ? `<div style="text-align:center;padding:60px 24px;background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;">
        <div style="font-size:3rem;margin-bottom:16px;">📭</div>
        <div style="font-size:1rem;font-weight:600;color:#e0eaf8;margin-bottom:8px;">No sessions yet</div>
        <div style="font-size:0.82rem;color:#4a6080;">Start straddle paper trading to record your first session.</div>
       </div>`
    : data.sessions.slice().reverse().map((s, idx) => {
        const sIdx = data.sessions.length - idx;
        const actualIdx = data.sessions.length - 1 - idx;

        // Pair-up the legs in this session
        const pmap = new Map();
        for (const t of (s.trades || [])) {
          if (!t.pairId) continue;
          if (!pmap.has(t.pairId)) pmap.set(t.pairId, { pairId: t.pairId, entryTime: t.entryTime, exitTime: t.exitTime, strike: t.optionStrike, expiry: t.optionExpiry, spotEntry: t.spotAtEntry, spotExit: t.spotAtExit, ce: null, pe: null, pairPnl: t.pairPnl, exitReason: t.exitReason, trigger: t.trigger, strength: t.signalStrength, netDebit: t.netDebit });
          const p = pmap.get(t.pairId);
          if (t.leg === "CE") p.ce = { entryLtp: t.optionEntryLtp, exitLtp: t.optionExitLtp, pnl: t.pnl, symbol: t.symbol };
          if (t.leg === "PE") p.pe = { entryLtp: t.optionEntryLtp, exitLtp: t.optionExitLtp, pnl: t.pnl, symbol: t.symbol };
        }
        const pairs = Array.from(pmap.values());
        const sessionWins   = pairs.filter(p => (p.pairPnl || 0) > 0).length;
        const sessionLosses = pairs.filter(p => (p.pairPnl || 0) < 0).length;
        const winRate = pairs.length ? ((sessionWins / pairs.length) * 100).toFixed(1) + "%" : "—";

        const pairRows = pairs.map((p, pi) => {
          const cePnl = p.ce ? p.ce.pnl : 0;
          const pePnl = p.pe ? p.pe.pnl : 0;
          const pnlStr = `<span style="font-weight:800;color:${pnlColor(p.pairPnl)};">${(p.pairPnl || 0) >= 0 ? "+" : ""}${inr(p.pairPnl)}</span>`;
          const entryDate = p.entryTime ? p.entryTime.split(",")[0] : "—";
          const entryTimeOnly = p.entryTime ? (p.entryTime.split(", ")[1] || "—") : "—";
          const exitTimeOnly = p.exitTime ? (p.exitTime.split(", ")[1] || "—") : "—";
          const exitReasonShort = (p.exitReason || "—").substring(0, 30) + ((p.exitReason || "").length > 30 ? "…" : "");
          return `<tr>
            <td style="font-size:0.62rem;color:#94a3b8;">${p.pairId}</td>
            <td style="color:#c8d8f0;font-size:0.75rem;">${entryDate}</td>
            <td style="color:#c8d8f0;">${p.strike || "—"}</td>
            <td style="color:#c8d8f0;font-size:0.75rem;">${entryTimeOnly}</td>
            <td style="color:#c8d8f0;font-size:0.75rem;">${exitTimeOnly}</td>
            <td style="color:#10b981;font-size:0.7rem;">${p.ce ? `₹${p.ce.entryLtp}→₹${p.ce.exitLtp} <span style="color:${pnlColor(cePnl)};">(${cePnl>=0?"+":""}${cePnl.toFixed(0)})</span>` : "—"}</td>
            <td style="color:#ef4444;font-size:0.7rem;">${p.pe ? `₹${p.pe.entryLtp}→₹${p.pe.exitLtp} <span style="color:${pnlColor(pePnl)};">(${pePnl>=0?"+":""}${pePnl.toFixed(0)})</span>` : "—"}</td>
            <td style="color:#fbbf24;font-size:0.68rem;">${p.trigger || "—"}</td>
            <td style="color:#94a3b8;">${p.strength || "—"}</td>
            <td style="color:#94a3b8;">${p.netDebit != null ? "₹" + p.netDebit : "—"}</td>
            <td>${pnlStr}</td>
            <td style="font-size:0.7rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${(p.exitReason || "").replace(/"/g, "&quot;")}">${exitReasonShort}</td>
            <td style="text-align:center;padding:4px 8px;"><button onclick="event.stopPropagation();showPairModal(${actualIdx}, '${p.pairId}')" class="copy-btn" style="padding:3px 10px;font-size:0.75rem;">👁 View</button></td>
          </tr>`;
        }).join("");

        return `
        <div class="session-card">
          <div class="session-head" onclick="this.parentElement.classList.toggle('open')">
            <div>
              <div class="session-meta">Session ${sIdx} &middot; ${(s.date || "").slice(0, 10)} &middot; ${s.strategy || "—"}</div>
              <div style="margin-top:4px;display:flex;gap:10px;font-size:0.7rem;color:#4a6080;">
                <span>${pairs.length} pair${pairs.length !== 1 ? "s" : ""}</span>
                <span style="color:#10b981;">${sessionWins}W</span>
                <span style="color:#ef4444;">${sessionLosses}L</span>
                <span>WR ${winRate}</span>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <button class="copy-btn" onclick="event.stopPropagation();copySessionLog(this,${actualIdx})">📋 Copy Trade Log</button>
              <button class="reset-btn" onclick="event.stopPropagation();deleteSession(${actualIdx}, 'Session ${sIdx} (${(s.date || "").slice(0, 10)})')">🗑 Delete</button>
            </div>
            <div>
              <div class="session-pnl" style="color:${pnlColor(s.pnl)};">${s.pnl >= 0 ? "+" : ""}${inr(s.pnl)}</div>
              <div class="session-wl">${sessionWins}W / ${sessionLosses}L · ${pairs.length * 2} legs</div>
            </div>
          </div>
          <div class="session-body">
          ${pairs.length > 0 ? `
          <div style="overflow-x:auto;">
            <table class="tbl">
              <thead><tr><th>Pair ID</th><th>Date</th><th>Strike</th><th>E.Time</th><th>X.Time</th><th>CE Leg</th><th>PE Leg</th><th>Trigger</th><th>Sig</th><th>Debit</th><th>Pair PnL</th><th>Exit Reason</th><th style="text-align:center;">Action</th></tr></thead>
              <tbody>${pairRows}</tbody>
            </table>
          </div>` : `<div style="padding:14px 20px;color:#4a6080;font-size:0.82rem;">No pairs in this session.</div>`}
          </div>
        </div>`;
      }).join("");

  const sessionsJSON = JSON.stringify(data.sessions || []).replace(/<\/script>/gi, "<\\/script>");

  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
${faviconLink()}
<title>Straddle Paper — History</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;}
${sidebarCSS()}
${modalCSS()}
.main-content{flex:1;padding:18px 22px 40px;min-height:100vh;}
@media(max-width:900px){.main-content{margin-left:0;padding:14px;}}
.page-title{font-size:1.08rem;font-weight:700;margin-bottom:4px;}
.page-sub{font-size:0.7rem;color:#4a6080;margin-bottom:14px;}
.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:14px;}
@media(max-width:1100px){.stats{grid-template-columns:repeat(3,1fr);}}
@media(max-width:560px){.stats{grid-template-columns:repeat(2,1fr);}}
.sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;position:relative;overflow:hidden;}
.sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:#ec4899;}
.sc-l{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;}
.sc-v{font-size:1.05rem;font-weight:700;font-family:'IBM Plex Mono',monospace;margin-top:3px;}
.session-card{background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;overflow:hidden;margin-bottom:14px;}
.session-head{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;background:#040c18;border-bottom:0.5px solid #0e1e36;gap:12px;flex-wrap:wrap;cursor:pointer;}
.session-head:hover{background:#060e1c;}
.session-meta{font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;}
.session-pnl{font-size:1.3rem;font-weight:800;font-family:'IBM Plex Mono',monospace;text-align:right;}
.session-wl{font-size:0.66rem;color:#4a6080;text-align:right;margin-top:2px;}
.session-body{display:none;}
.session-card.open .session-body{display:block;}
.tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
.tbl th{padding:8px 10px;text-align:left;font-size:0.55rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#04090f;border-bottom:0.5px solid #0e1e36;}
.tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#4a6080;}
.tbl tr:hover td{background:rgba(236,72,153,0.03);}
.copy-btn{background:#0d1320;border:1px solid #1a2236;color:#ec4899;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;}
.copy-btn:hover{background:#2a0a1c;border-color:#ec4899;}
.copy-btn.copied{background:#064e3b;border-color:#10b981;color:#10b981;}
.reset-btn{background:#1a0508;border:0.5px solid #3b0a0a;color:#ef4444;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;}
.reset-btn:hover{background:#2a0810;border-color:#ef4444;}
.toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}
.tool-btn{background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:6px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;}
.tool-btn:hover{border-color:#ec4899;color:#ec4899;}
.tool-btn.active{background:#2a0a1c;border-color:#ec4899;color:#ec4899;}
.ana-panel{display:none;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
.ana-panel.open{display:block;}
.ana-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
@media(max-width:900px){.ana-row{grid-template-columns:1fr;}}
.ana-card{background:#040c18;border:0.5px solid #0e1e36;border-radius:8px;padding:12px;}
.ana-card h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
.ana-chart-wrap{position:relative;height:220px;}
</style></head><body>
<div class="app-shell">
${buildSidebar('straddleHistory', liveActive, false)}
<main class="main-content">
  <div class="page-title">📜 Straddle Paper Trade History (per-pair)</div>
  <div class="page-sub">All saved sessions · click to expand · per-session copy/delete</div>
  <div class="stats">
    <div class="sc"><div class="sc-l">Total Pairs</div><div class="sc-v">${allPairs.length}</div></div>
    <div class="sc"><div class="sc-l">Total P&L</div><div class="sc-v" style="color:${pnlColor(totalPnl)};">${totalPnl >= 0 ? "+" : ""}${inr(totalPnl)}</div></div>
    <div class="sc"><div class="sc-l">Wins / Losses</div><div class="sc-v">${totalWins} / ${totalLosses}</div></div>
    <div class="sc"><div class="sc-l">Win Rate</div><div class="sc-v">${allPairs.length ? ((totalWins / allPairs.length) * 100).toFixed(1) : "0.0"}%</div></div>
    <div class="sc"><div class="sc-l">Sessions</div><div class="sc-v">${data.sessions.length}</div></div>
    <div class="sc"><div class="sc-l">Capital</div><div class="sc-v">${inr(startCap + totalPnl)}<span style="font-size:0.65rem;color:#4a6080;font-weight:400;"> (from ${inr(startCap)})</span></div></div>
  </div>
  <div class="toolbar">
    <button class="tool-btn" id="anaToggle" onclick="toggleAnalytics()">📊 Analytics</button>
    <button class="tool-btn" onclick="copyAllJsonl(this)">📋 Copy All JSONL</button>
    <a class="tool-btn" href="/straddle-paper/download/trades.jsonl" style="text-decoration:none;">⬇ Download trades.jsonl</a>
    <span style="margin-left:auto;font-size:0.65rem;color:#4a6080;align-self:center;">Each row = 1 pair · All times IST</span>
  </div>
  <div class="ana-panel" id="anaPanel">
    <div class="ana-row">
      <div class="ana-card"><h3>📈 All-time Equity Curve</h3><div class="ana-chart-wrap"><canvas id="anaEquity"></canvas></div></div>
      <div class="ana-card"><h3>📊 Trigger Breakdown</h3><div class="ana-chart-wrap"><canvas id="anaTrig"></canvas></div></div>
    </div>
    <div class="ana-row">
      <div class="ana-card"><h3>📉 Drawdown</h3><div class="ana-chart-wrap"><canvas id="anaDD"></canvas></div></div>
      <div class="ana-card"><h3>📅 Daily P&L</h3><div class="ana-chart-wrap"><canvas id="anaDaily"></canvas></div></div>
    </div>
  </div>
  ${sessionCards}

  <!-- Pair detail modal -->
  <div id="pairModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
    <div style="background:#0d1320;border:1px solid #ec4899;border-radius:14px;padding:20px 24px;max-width:640px;width:100%;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div id="pmTitle" style="font-weight:700;font-size:0.85rem;">Pair Details</div>
        <button onclick="document.getElementById('pairModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:#4a6080;cursor:pointer;padding:4px 10px;border-radius:6px;font-family:inherit;">✕ Close</button>
      </div>
      <div id="pmBody"></div>
    </div>
  </div>
</main>
</div>

<script id="sessions-data" type="application/json">${sessionsJSON}</script>
<script>
${modalJS()}
var SESSIONS = JSON.parse(document.getElementById('sessions-data').textContent);
var anaCharts = {};

function fmtINR(n){ return n!=null ? Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; }

function copySessionLog(btn, idx){
  var sess = SESSIONS[idx];
  if (!sess) return;
  var lines = (sess.trades||[]).map(function(t){ return JSON.stringify(t); });
  navigator.clipboard.writeText(lines.join('\\n')).then(function(){
    btn.classList.add('copied'); btn.textContent='✓ Copied'; setTimeout(function(){ btn.classList.remove('copied'); btn.textContent='📋 Copy Trade Log'; },1500);
  });
}
function copyAllJsonl(btn){
  var lines = SESSIONS.flatMap(function(s){ return (s.trades||[]).map(function(t){ return JSON.stringify(Object.assign({}, t, { date: s.date })); }); });
  navigator.clipboard.writeText(lines.join('\\n')).then(function(){
    btn.classList.add('active'); btn.textContent='✓ Copied ' + lines.length + ' rows'; setTimeout(function(){ btn.classList.remove('active'); btn.textContent='📋 Copy All JSONL'; },1800);
  });
}
async function deleteSession(idx, label){
  if (!confirm('Delete ' + label + '? This cannot be undone.')) return;
  try {
    var r = await fetch('/straddle-paper/delete-session/' + idx, { method:'POST' });
    var j = await r.json();
    if (j.success) location.reload();
    else alert('Delete failed: ' + (j.error||'unknown'));
  } catch (e) { alert('Delete error: ' + e.message); }
}
function showPairModal(sIdx, pairId){
  var sess = SESSIONS[sIdx];
  if (!sess) return;
  var legs = (sess.trades||[]).filter(function(t){ return t.pairId === pairId; });
  if (!legs.length) return;
  var ce = legs.find(function(t){ return t.leg === 'CE'; });
  var pe = legs.find(function(t){ return t.leg === 'PE'; });
  var anyLeg = ce || pe;
  var rows = '';
  function row(k, v){ rows += '<tr><td style="padding:6px 10px;font-size:0.7rem;color:#4a6080;text-transform:uppercase;letter-spacing:0.8px;">' + k + '</td><td style="padding:6px 10px;color:#c8d8f0;font-size:0.78rem;font-weight:600;">' + (v != null ? v : '—') + '</td></tr>'; }
  row('Pair ID', pairId);
  row('Strike · Expiry', anyLeg.optionStrike + ' · ' + anyLeg.optionExpiry);
  row('Entry Time', anyLeg.entryTime);
  row('Exit Time', anyLeg.exitTime);
  row('Entry Spot', anyLeg.spotAtEntry);
  row('Exit Spot', anyLeg.spotAtExit);
  row('Trigger', anyLeg.trigger);
  row('Sig Strength', anyLeg.signalStrength);
  row('Net Debit', '₹' + anyLeg.netDebit);
  row('Net Target', '₹' + anyLeg.netTarget);
  row('Net Stop', '₹' + anyLeg.netStop);
  row('CE Leg', ce ? ('₹' + ce.optionEntryLtp + ' → ₹' + ce.optionExitLtp + ' = <span style="color:' + (ce.pnl>=0?'#10b981':'#ef4444') + ';">' + (ce.pnl>=0?'+':'') + '₹' + ce.pnl.toFixed(2) + '</span>') : '—');
  row('PE Leg', pe ? ('₹' + pe.optionEntryLtp + ' → ₹' + pe.optionExitLtp + ' = <span style="color:' + (pe.pnl>=0?'#10b981':'#ef4444') + ';">' + (pe.pnl>=0?'+':'') + '₹' + pe.pnl.toFixed(2) + '</span>') : '—');
  row('Pair P&L', '<span style="color:' + (anyLeg.pairPnl>=0?'#10b981':'#ef4444') + ';">' + (anyLeg.pairPnl>=0?'+':'') + '₹' + (anyLeg.pairPnl||0).toFixed(2) + '</span>');
  rows += '<tr><td colspan="2" style="padding:10px;background:#040c18;border-top:0.5px solid #0e1e36;color:#94a3b8;font-size:0.75rem;white-space:pre-wrap;">' + (anyLeg.entryReason || '') + '</td></tr>';
  rows += '<tr><td colspan="2" style="padding:10px;background:#040c18;color:#94a3b8;font-size:0.75rem;white-space:pre-wrap;">' + (anyLeg.exitReason || '') + '</td></tr>';
  document.getElementById('pmTitle').textContent = 'Pair ' + pairId;
  document.getElementById('pmBody').innerHTML = '<table style="width:100%;border-collapse:collapse;">' + rows + '</table>';
  document.getElementById('pairModal').style.display = 'flex';
}

function toggleAnalytics(){
  var p = document.getElementById('anaPanel');
  var btn = document.getElementById('anaToggle');
  p.classList.toggle('open');
  btn.classList.toggle('active');
  if (p.classList.contains('open')) renderAna();
}
function renderAna(){
  // Pair-level data across all sessions
  var allPairs = [];
  SESSIONS.forEach(function(s){
    var pmap = {};
    (s.trades||[]).forEach(function(t){
      if (!t.pairId) return;
      if (!pmap[t.pairId]) pmap[t.pairId] = { pairPnl: t.pairPnl || 0, entryTime: t.entryTime, trigger: t.trigger, _date: (s.date||'').slice(0,10) };
    });
    Object.values(pmap).forEach(function(p){ allPairs.push(p); });
  });
  if (!allPairs.length) return;
  Object.values(anaCharts).forEach(function(c){ if(c) c.destroy(); });
  var _gc='#0e1428', _tc='#3a5070';
  // Equity
  var cum=0, labels=[], cumArr=[];
  allPairs.forEach(function(p,i){ cum += (p.pairPnl||0); cumArr.push(cum); labels.push(i+1); });
  anaCharts.eq = new Chart(document.getElementById('anaEquity'), { type:'line', data:{ labels:labels, datasets:[{ data:cumArr, borderColor:'#ec4899', borderWidth:1.5, backgroundColor:'rgba(236,72,153,0.1)', fill:true, pointRadius:0, tension:0.3 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{display:false}, y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}} } } });
  // Trigger breakdown
  var trigMap = {};
  allPairs.forEach(function(p){ var k = p.trigger || 'UNKNOWN'; if (!trigMap[k]) trigMap[k]={cnt:0,pnl:0}; trigMap[k].cnt++; trigMap[k].pnl += (p.pairPnl||0); });
  var tKeys = Object.keys(trigMap);
  anaCharts.trig = new Chart(document.getElementById('anaTrig'), { type:'bar', data:{ labels:tKeys, datasets:[{ data:tKeys.map(function(k){ return Math.round(trigMap[k].pnl); }), backgroundColor:tKeys.map(function(k){ return trigMap[k].pnl>=0?'#10b981':'#ef4444'; }), borderRadius:3 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}, tooltip:{callbacks:{afterLabel:function(ctx){var k=tKeys[ctx.dataIndex];return trigMap[k].cnt+' pairs';}}}}, scales:{ x:{grid:{display:false},ticks:{color:_tc,font:{size:10}}}, y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}} } } });
  // Drawdown
  var eq2=0, peak=0, dd=[];
  allPairs.forEach(function(p){ eq2+=(p.pairPnl||0); if(eq2>peak) peak=eq2; dd.push(eq2-peak); });
  anaCharts.dd = new Chart(document.getElementById('anaDD'), { type:'line', data:{ labels:labels, datasets:[{ data:dd, borderColor:'#ef4444', borderWidth:1.5, backgroundColor:'rgba(239,68,68,0.12)', fill:true, pointRadius:0, tension:0.3 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{display:false}, y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}} } } });
  // Daily
  var daily={};
  allPairs.forEach(function(p){ var d=p._date; if(!daily[d]) daily[d]=0; daily[d]+=(p.pairPnl||0); });
  var dKeys = Object.keys(daily).sort();
  anaCharts.daily = new Chart(document.getElementById('anaDaily'), { type:'bar', data:{ labels:dKeys, datasets:[{ data:dKeys.map(function(k){ return Math.round(daily[k]); }), backgroundColor:dKeys.map(function(k){ return daily[k]>=0?'#10b981':'#ef4444'; }), borderRadius:3, barPercentage:0.8 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false},ticks:{color:_tc,font:{size:9},maxTicksLimit:8}}, y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}} } } });
}

(function(){ var first = document.querySelector('.session-card'); if (first) first.classList.add('open'); })();
</script>
</body></html>`);
});

// Delete a session by index
router.post("/delete-session/:idx", (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const data = loadData();
    if (!Number.isFinite(idx) || idx < 0 || idx >= (data.sessions || []).length) {
      return res.status(400).json({ success: false, error: "Invalid session index" });
    }
    const removed = data.sessions.splice(idx, 1)[0];
    data.totalPnl = parseFloat((data.totalPnl - (removed.pnl || 0)).toFixed(2));
    saveData(data);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Download all trades as JSONL
router.get("/download/trades.jsonl", (req, res) => {
  try {
    const data = loadData();
    const lines = [];
    for (const s of (data.sessions || [])) {
      for (const t of (s.trades || [])) {
        lines.push(JSON.stringify(Object.assign({ date: s.date, strategy: s.strategy }, t)));
      }
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="straddle_paper_trades_${new Date().toISOString().slice(0,10)}.jsonl"`);
    res.send(lines.join("\n"));
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

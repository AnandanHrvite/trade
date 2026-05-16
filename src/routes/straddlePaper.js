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
const { scalpStyleCSS, scalpTopBar, scalpCapitalStrip, scalpStatGrid, scalpCurrentBar, scalpActivityLog } = require("../utils/scalpStyleUI");
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
    currentBar:     state.currentBar,
    sessionStart:   state.sessionStart,
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

function _straddleCapital() {
  const v = parseFloat(process.env.STRADDLE_PAPER_CAPITAL);
  return isNaN(v) ? 100000 : v;
}

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const data = loadData();
  const pos  = state.position;

  const _vix = getCachedVix();
  const _vixEnabled = (process.env.STRADDLE_VIX_ENABLED || "false").toLowerCase() === "true";
  const _vixMaxEntry = vixFilter.getVixMaxEntry("straddle");
  const _maxPairs = parseInt(process.env.STRADDLE_MAX_DAILY_PAIRS || "1", 10);
  const _maxLoss  = parseFloat(process.env.STRADDLE_MAX_DAILY_LOSS || "5000");
  const _bbPeriod = process.env.STRADDLE_BB_PERIOD || "20";
  const _bbStd    = process.env.STRADDLE_BB_STDDEV || "2";
  const _tgtPct   = (parseFloat(process.env.STRADDLE_TARGET_PCT || "0.4") * 100).toFixed(0);
  const _stpPct   = (parseFloat(process.env.STRADDLE_STOP_PCT   || "0.25") * 100).toFixed(0);
  const dailyLossHit = state.sessionPnl <= -_maxLoss;

  const pnlColor = (n) => (n || 0) >= 0 ? "#10b981" : "#ef4444";

  // Live PnL
  let livePnl = null;
  let combined = null;
  if (pos && state.ceLtp != null && state.peLtp != null) {
    combined = parseFloat((state.ceLtp + state.peLtp).toFixed(2));
    const lot = pos.qty || instrumentConfig.getLotQty();
    livePnl = parseFloat((((state.ceLtp - pos.ce.entryLtp) + (state.peLtp - pos.pe.entryLtp)) * lot).toFixed(2));
  }

  // Pair-level stats
  const pairMap = new Map();
  for (const t of state.sessionTrades) {
    if (!t.pairId) continue;
    if (!pairMap.has(t.pairId)) pairMap.set(t.pairId, 0);
    pairMap.set(t.pairId, pairMap.get(t.pairId) + (t.pnl || 0));
  }
  const pairs = Array.from(pairMap.values());
  const wins   = pairs.filter(p => p > 0).length;
  const losses = pairs.filter(p => p < 0).length;
  const winRate = pairs.length ? ((wins / pairs.length) * 100).toFixed(1) : null;
  const bestPair  = pairs.length ? Math.max(...pairs) : null;
  const worstPair = pairs.length ? Math.min(...pairs) : null;

  // Stat cards
  const statCards = [
    {
      label: "Session PnL",
      value: `<span id="ajax-session-pnl" style="color:${pnlColor(state.sessionPnl)};">${typeof state.sessionPnl === "number" ? (state.sessionPnl >= 0 ? "+" : "") + "₹" + state.sessionPnl.toLocaleString("en-IN", {minimumFractionDigits:2, maximumFractionDigits:2}) : "—"}</span>`,
      accent: pnlColor(state.sessionPnl),
    },
    {
      label: "Pairs Today",
      value: `<span id="ajax-pairs-count">${state.pairsTaken || 0}</span> <span style="font-size:0.75rem;color:#4a6080;">/ ${_maxPairs}</span>`,
      sub: `<span id="ajax-wl">${wins}W · ${losses}L</span>`,
      accent: "#ec4899",
    },
    {
      label: "Live PnL",
      value: `<span id="ajax-live-pnl" style="color:${livePnl == null ? "#c8d8f0" : pnlColor(livePnl)};">${livePnl == null ? "—" : (livePnl >= 0 ? "+" : "") + "₹" + livePnl.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2})}</span>`,
      sub: `<span id="ajax-live-pnl-sub">${pos ? "both legs unrealised" : "no open pair"}</span>`,
      accent: "#3b82f6",
    },
    {
      label: "Win Rate",
      value: `<span id="ajax-wr">${winRate != null ? winRate + "%" : "—"}</span>`,
      sub: `<span id="ajax-wr-sub">best ${bestPair == null ? "—" : "₹" + Math.round(bestPair)} / worst ${worstPair == null ? "—" : "₹" + Math.round(worstPair)}</span>`,
      accent: "#a07010",
    },
    {
      label: "Combined Premium",
      value: `<span id="ajax-combined">${combined != null ? "₹" + combined : "—"}</span>`,
      sub: `<span id="ajax-combined-sub">${pos && pos.netDebit ? "Entry net ₹" + pos.netDebit : "no live combined"}</span>`,
      accent: "#7c3aed",
    },
    {
      label: "Daily Loss Limit",
      value: `<span id="ajax-daily-loss-val" style="color:${dailyLossHit ? "#ef4444" : "#10b981"};">${dailyLossHit ? "HIT" : "OK"} <span style="font-size:0.65rem;color:#4a6080;">/ -₹${_maxLoss.toLocaleString("en-IN")}</span></span>`,
      sub: `<span id="ajax-daily-loss-sub" style="color:${dailyLossHit ? "#ef4444" : "#10b981"};">${dailyLossHit ? "KILLED — no entries" : "Active"}</span>`,
      accent: dailyLossHit ? "#ef4444" : "#10b981",
    },
    {
      label: "Candles Loaded",
      value: `<span id="ajax-candle-count" style="color:${state.candles.length >= parseInt(_bbPeriod, 10) ? "#10b981" : "#f59e0b"};">${state.candles.length}</span>`,
      sub: `<span id="ajax-candle-status" style="color:${state.candles.length >= parseInt(_bbPeriod, 10) ? "#10b981" : "#f59e0b"};">${state.candles.length >= parseInt(_bbPeriod, 10) ? "BB ready" : "Warming up..."}</span>`,
      accent: "#a07010",
    },
    {
      label: "WebSocket Ticks",
      value: `<span id="ajax-tick-count">${(state.tickCount || 0).toLocaleString()}</span>`,
      sub: `Last: <span id="ajax-last-tick">${state.lastTickPrice ? "₹" + state.lastTickPrice.toLocaleString("en-IN") : "—"}</span>`,
      accent: "#2a6080",
    },
    {
      label: "Session Start",
      value: `<span style="font-size:0.85rem;color:#c8d8f0;">${state.sessionStart ? fmtISTDateTime(state.sessionStart) : "—"}</span>`,
      accent: "#2a4020",
    },
  ];

  // Position panel — straddle (CE + PE)
  const posHtml = pos ? (() => {
    const ceCur = state.ceLtp != null ? state.ceLtp : pos.ce.entryLtp;
    const peCur = state.peLtp != null ? state.peLtp : pos.pe.entryLtp;
    const comb  = parseFloat((ceCur + peCur).toFixed(2));
    const moveCls = comb >= pos.netDebit ? "#10b981" : "#ef4444";
    const ceMove = ceCur - pos.ce.entryLtp;
    const peMove = peCur - pos.pe.entryLtp;
    return `
    <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#ec4899;display:inline-block;animation:pulse 1.5s infinite;"></span>
          <span style="font-size:0.8rem;font-weight:700;color:#ec4899;text-transform:uppercase;letter-spacing:1px;">Open Pair</span>
          <span style="font-size:0.72rem;color:#4a6080;">Since ${pos.entryTime || "—"}</span>
        </div>
        <button onclick="strpHandleExit(this)"
           style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;">
          Exit Pair Now
        </button>
      </div>

      <!-- Pair identity banner -->
      <div style="background:#1c0a16;border:1px solid #4a1942;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Strike</div>
            <div style="font-size:1.6rem;font-weight:800;color:#fff;font-family:monospace;">${pos.strike}</div>
          </div>
          <div style="width:1px;height:44px;background:#4a1942;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Expiry</div>
            <div style="font-size:1.1rem;font-weight:700;color:#f59e0b;">${pos.expiry || "—"}</div>
          </div>
          <div style="width:1px;height:44px;background:#4a1942;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Qty / Leg</div>
            <div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty}</div>
          </div>
          <div style="width:1px;height:44px;background:#4a1942;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Trigger</div>
            <div style="font-size:0.9rem;font-weight:700;color:#fbbf24;">${pos.trigger || "—"} ${pos.signalStrength ? `<span style="font-size:0.65rem;color:#94a3b8;">[${pos.signalStrength}]</span>` : ""}</div>
          </div>
          <div style="width:1px;height:44px;background:#4a1942;flex-shrink:0;"></div>
          <div style="flex:1;min-width:200px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Pair ID</div>
            <div style="font-size:0.78rem;font-weight:600;color:#c8d8f0;font-family:monospace;">${pos.pairId}</div>
          </div>
        </div>
      </div>

      <!-- Combined premium -->
      <div style="background:#0a0f24;border:2px solid #ec4899;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
        <div style="font-size:0.68rem;font-weight:700;color:#ec4899;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Combined Premium (CE + PE)</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">
          <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid #1e3a5f;border-radius:10px;">
            <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Net Debit</div>
            <div style="font-size:2rem;font-weight:800;color:#60a5fa;font-family:monospace;line-height:1;">₹${pos.netDebit}</div>
            <div style="font-size:0.68rem;color:#4a6080;margin-top:4px;">paid at entry</div>
          </div>
          <div style="text-align:center;font-size:1.8rem;color:${moveCls};">→</div>
          <div style="text-align:center;padding:12px;background:${comb >= pos.netDebit ? "#071a0f" : "#1a0707"};border:2px solid ${moveCls};border-radius:10px;">
            <div style="font-size:0.63rem;color:${moveCls};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Live Combined</div>
            <div id="ajax-live-combined" style="font-size:2rem;font-weight:800;color:${moveCls};font-family:monospace;line-height:1;">₹${comb}</div>
            <div id="ajax-live-pct" style="font-size:0.85rem;font-weight:700;margin-top:6px;color:${moveCls};">${((comb - pos.netDebit) / pos.netDebit * 100).toFixed(2)}%</div>
          </div>
          <div style="text-align:center;padding:12px;background:${livePnl != null ? (livePnl >= 0 ? "#071a0f" : "#1a0707") : "#0d1320"};border:1px solid ${livePnl != null ? (livePnl >= 0 ? "#065f46" : "#7f1d1d") : "#1a2236"};border-radius:10px;">
            <div style="font-size:0.63rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Pair P&L</div>
            <div id="ajax-pair-pnl" style="font-size:1.8rem;font-weight:800;color:${livePnl != null ? (livePnl >= 0 ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">${livePnl != null ? (livePnl >= 0 ? "+" : "") + "₹" + livePnl.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2}) : "—"}</div>
            <div style="font-size:0.65rem;color:#4a6080;margin-top:4px;">${pos.qty} qty per leg</div>
          </div>
        </div>
      </div>

      <!-- Per-leg breakdown -->
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px;">
        <div style="background:#071a12;border:1px solid #134e35;border-left:3px solid #10b981;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#10b981;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">CE Leg</div>
          <div style="font-size:0.7rem;color:#94a3b8;font-family:monospace;margin-bottom:6px;">${pos.ce.symbol}</div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <span style="font-size:0.95rem;font-weight:700;color:#c8d8f0;font-family:monospace;">₹${pos.ce.entryLtp} → <span id="ajax-ce-cur" style="color:${ceCur >= pos.ce.entryLtp ? "#10b981" : "#ef4444"};">₹${ceCur}</span></span>
            <span id="ajax-ce-move" style="font-size:0.85rem;font-weight:700;color:${ceMove >= 0 ? "#10b981" : "#ef4444"};">${ceMove >= 0 ? "+" : ""}${ceMove.toFixed(2)}</span>
          </div>
        </div>
        <div style="background:#1a0707;border:1px solid #7f1d1d;border-left:3px solid #ef4444;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#ef4444;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">PE Leg</div>
          <div style="font-size:0.7rem;color:#94a3b8;font-family:monospace;margin-bottom:6px;">${pos.pe.symbol}</div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <span style="font-size:0.95rem;font-weight:700;color:#c8d8f0;font-family:monospace;">₹${pos.pe.entryLtp} → <span id="ajax-pe-cur" style="color:${peCur >= pos.pe.entryLtp ? "#10b981" : "#ef4444"};">₹${peCur}</span></span>
            <span id="ajax-pe-move" style="font-size:0.85rem;font-weight:700;color:${peMove >= 0 ? "#10b981" : "#ef4444"};">${peMove >= 0 ? "+" : ""}${peMove.toFixed(2)}</span>
          </div>
        </div>
      </div>

      <!-- Levels -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;">
        <div style="background:#0a1f12;border:1px solid #0d4030;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Target (Combined)</div>
          <div style="font-size:1.05rem;font-weight:700;color:#10b981;">₹${pos.targetNet}</div>
          <div style="font-size:0.58rem;color:#4a6080;margin-top:2px;">+${_tgtPct}% net</div>
        </div>
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop (Combined)</div>
          <div style="font-size:1.05rem;font-weight:700;color:#f59e0b;">₹${pos.stopNet}</div>
          <div style="font-size:0.58rem;color:#4a6080;margin-top:2px;">-${_stpPct}% net</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Peak Combined</div>
          <div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">₹${pos.peakCombined || comb}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Entry Spot</div>
          <div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${pos.entrySpot ? "₹" + pos.entrySpot.toFixed(2) : "—"}</div>
        </div>
      </div>
    </div>`;
  })() : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:0.9rem;font-weight:600;color:#4a6080;margin-bottom:14px;">FLAT — ${state.running ? "Waiting for volatility trigger" : "Session stopped"}</div>
      ${state.running ? `<button onclick="strpManualEntry()" style="padding:8px 24px;background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">🎯 Manual Straddle Entry</button>` : ""}
    </div>`;

  // Logs JSON
  const allLogs = [...state.log].reverse();
  const logsJSON = JSON.stringify(allLogs)
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/`/g, "\\u0060")
    .replace(/\$/g, "\\u0024");

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
${faviconLink()}
<title>Straddle Paper — ${straddleStrategy.NAME}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<style>
${sidebarCSS()}
${modalCSS()}
${scalpStyleCSS()}
</style></head>
<body>
<div class="app-shell">
${buildSidebar('straddlePaper', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/straddle-paper/start'`, startLabel: '▶ Start Straddle',
  showStopBtn: state.running,   stopBtnJs:  `location.href='/straddle-paper/stop'`,  stopLabel:  '■ Stop Straddle',
  showExitBtn: state.running && !!state.position, exitBtnJs: `location.href='/straddle-paper/exit'`, exitLabel: '🚪 Exit Pair',
})}
<div class="main-content">

${scalpTopBar({
  title: "Straddle Paper Trade",
  metaLine: `Strategy: ${straddleStrategy.NAME} · ATM CE+PE long · BB ${_bbPeriod}/${_bbStd} squeeze · Target +${_tgtPct}% / Stop -${_stpPct}% net · ${state.running ? "Auto-refreshes every 2s" : "Stopped"}`,
  running: state.running,
  vix: { enabled: _vixEnabled, value: _vix, maxEntry: _vixMaxEntry, strongOnly: Infinity },
  primaryAction: { label: "Start Straddle Paper", href: "/straddle-paper/start", color: "#831843" },
  stopAction:    { label: "Stop Session",          href: "/straddle-paper/stop" },
  historyHref: "/straddle-paper/history",
})}

${scalpCapitalStrip({
  starting: _straddleCapital(),
  current:  data.capital,
  allTime:  data.totalPnl,
  startingThreshold: _straddleCapital(),
})}

${scalpStatGrid(statCards)}

${scalpCurrentBar({ bar: state.currentBar, resMin: 5 })}

<div id="ajax-position-section" style="margin-bottom:18px;">
${posHtml}
</div>

<main style="display:contents;">
</main>

${process.env.CHART_ENABLED !== "false" ? `<!-- NIFTY chart -->
<div style="margin-bottom:18px;">
  <div class="section-title">NIFTY 5-Min Chart (BB ${_bbPeriod}/${_bbStd} squeeze overlay)</div>
  <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
    <div id="nifty-chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
      <span style="color:rgba(74,156,245,0.9);">── BB U/L</span> &nbsp;<span style="color:#94a3b8;">-- BB Mid</span> &nbsp;<span style="color:#3b82f6;">-- Entry Spot</span>
    </div>
  </div>
</div>` : ""}

<!-- Session trades (leg-flat) -->
<div id="strp-trades-section" style="margin-bottom:18px;">
  <div class="section-title">Session Trades <span id="strp-trades-hint" style="color:#4a6080;font-weight:400;letter-spacing:0.5px;text-transform:none;margin-left:8px;">${state.sessionTrades.length} rows</span></div>
  <div id="strp-trades-box" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;${state.sessionTrades.length ? "" : "padding:24px;text-align:center;color:#4a6080;font-size:0.82rem;"}">${state.sessionTrades.length ? "" : "No trades yet"}</div>
</div>

${scalpActivityLog({ logsJSON })}

</div><!-- /main-content -->
</div><!-- /app-shell -->

<script>
${modalJS()}
async function strpHandleExit(btn){
  var ok = await showConfirm({ icon:'🚪', title:'Exit pair', message:'Exit current straddle pair now?', confirmText:'Exit', confirmClass:'modal-btn-danger' });
  if (!ok) return;
  btn.disabled = true; btn.textContent = 'Exiting...';
  fetch('/straddle-paper/exit').then(function(){ location.reload(); }).catch(function(){ location.reload(); });
}
async function strpManualEntry(){
  var ok = await showConfirm({ icon:'🎯', title:'Manual straddle', message:'Force CE+PE pair at current ATM strike? Bypasses BB-squeeze / VIX triggers.', confirmText:'Enter pair' });
  if (!ok) return;
  try {
    var r = await fetch('/straddle-paper/manualEntry', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    var j = await r.json();
    if (!j.success) { alert('Manual entry failed: '+(j.error||'unknown')); return; }
    location.reload();
  } catch (e) { alert('Error: ' + e.message); }
}
</script>

<script>
// ── NIFTY chart with BB squeeze overlay ──
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
      tickMarkFormatter:function(t){ var d=new Date(t*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
    },
  });
  var cs  = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var bbU = chart.addLineSeries({ color:'rgba(74,156,245,0.7)', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var bbM = chart.addLineSeries({ color:'rgba(148,163,184,0.55)', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var bbL = chart.addLineSeries({ color:'rgba(74,156,245,0.7)', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var entryLine = null;
  async function fetchChart(){
    try {
      var r = await fetch('/straddle-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) cs.setData(d.candles);
      bbU.setData(d.bbUpper  || []);
      bbM.setData(d.bbMiddle || []);
      bbL.setData(d.bbLower  || []);
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      if (entryLine) { cs.removePriceLine(entryLine); entryLine = null; }
      if (d.entryPrice) entryLine = cs.createPriceLine({ price:d.entryPrice, color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
    } catch (e) {}
  }
  fetchChart();
  if (${state.running}) setInterval(fetchChart, 4000);
  window.addEventListener('resize', function(){ chart.applyOptions({ width: container.clientWidth }); });
})();
</script>

<script>
// ── AJAX refresh ──
(function(){
  var INR = function(n){ return typeof n==='number' ? '₹'+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; };
  var PNL_COLOR = function(n){ return (n||0)>=0 ? '#10b981' : '#ef4444'; };
  var _lastHasPosition = ${pos ? "true" : "false"};
  var _lastTradeCount  = ${state.sessionTrades.length};
  var _lastLogCount    = ${state.log.length};
  var _lastRunning     = ${state.running};
  var _maxLoss         = ${_maxLoss};

  function setText(id, val){ var el=document.getElementById(id); if(el && el.textContent !== String(val)) el.textContent = val; }

  function renderTrades(trades){
    var box  = document.getElementById('strp-trades-box');
    var hint = document.getElementById('strp-trades-hint');
    if (hint) hint.textContent = trades.length + ' row' + (trades.length===1?'':'s');
    if (!box) return;
    if (!trades.length) { box.style.cssText = 'background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:24px;text-align:center;color:#4a6080;font-size:0.82rem;'; box.innerHTML = 'No trades yet'; return; }
    box.style.cssText = 'background:#0d1320;border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;';
    var rows = trades.slice().reverse().map(function(t){
      var pc = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
      var lc = t.leg === 'CE' ? '#10b981' : '#ef4444';
      return '<tr style="border-top:1px solid #1a2236;">' +
        '<td style="padding:8px 12px;font-size:0.62rem;color:#94a3b8;">' + (t.pairId||'') + '</td>' +
        '<td style="padding:8px 12px;color:' + lc + ';font-weight:800;">' + (t.leg||'—') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.7rem;color:#c8d8f0;">' + (t.symbol||'') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.7rem;color:#94a3b8;">' + (t.entryTime||'') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.7rem;color:#94a3b8;">' + (t.exitTime||'') + '</td>' +
        '<td style="padding:8px 12px;color:#60a5fa;">' + (t.optionEntryLtp!=null?'₹'+t.optionEntryLtp:'—') + '</td>' +
        '<td style="padding:8px 12px;color:#60a5fa;">' + (t.optionExitLtp!=null?'₹'+t.optionExitLtp:'—') + '</td>' +
        '<td style="padding:8px 12px;font-weight:800;color:' + pc + ';">' + (t.pnl!=null?(t.pnl>=0?'+':'')+'₹'+t.pnl.toFixed(2):'—') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.65rem;color:#4a6080;">' + (t.exitReason||'') + '</td>' +
      '</tr>';
    }).join('');
    box.innerHTML = '<table style="width:100%;border-collapse:collapse;font-family:monospace;font-size:0.78rem;">' +
      '<thead><tr style="background:#0a0f1c;">' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Pair</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Leg</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Symbol</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">E.LTP</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">X.LTP</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Leg PnL</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit Reason</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function fetchAndUpdate(){
    try {
      var r = await fetch('/straddle-paper/status/data', { cache:'no-store' });
      if (!r.ok) return;
      var d = await r.json();

      var pnlEl = document.getElementById('ajax-session-pnl');
      if (pnlEl) { pnlEl.textContent = (d.sessionPnl>=0?'+':'') + INR(d.sessionPnl); pnlEl.style.color = PNL_COLOR(d.sessionPnl); var card = pnlEl.closest('.sc'); if (card) card.style.borderTopColor = PNL_COLOR(d.sessionPnl); }
      setText('ajax-pairs-count', d.pairsTaken || 0);
      setText('ajax-wl', (d.wins||0) + 'W · ' + (d.losses||0) + 'L');

      var livePnlEl = document.getElementById('ajax-live-pnl');
      if (livePnlEl) {
        if (d.livePnl != null) { livePnlEl.textContent = (d.livePnl>=0?'+':'') + INR(d.livePnl); livePnlEl.style.color = PNL_COLOR(d.livePnl); }
        else { livePnlEl.textContent = '—'; livePnlEl.style.color = '#c8d8f0'; }
      }
      setText('ajax-live-pnl-sub', d.position ? 'both legs unrealised' : 'no open pair');
      setText('ajax-wr', d.winRate != null ? d.winRate + '%' : '—');
      setText('ajax-wr-sub', 'best ' + (d.bestPair == null ? '—' : '₹'+Math.round(d.bestPair)) + ' / worst ' + (d.worstPair == null ? '—' : '₹'+Math.round(d.worstPair)));

      var combEl = document.getElementById('ajax-combined');
      if (combEl) combEl.textContent = d.combined != null ? '₹' + d.combined : '—';
      setText('ajax-combined-sub', d.position && d.position.netDebit ? 'Entry net ₹' + d.position.netDebit : 'no live combined');

      var dlossHit = (d.sessionPnl || 0) <= -_maxLoss;
      var dlEl = document.getElementById('ajax-daily-loss-val');
      if (dlEl) dlEl.style.color = dlossHit ? '#ef4444' : '#10b981';
      var dlSub = document.getElementById('ajax-daily-loss-sub');
      if (dlSub) { dlSub.textContent = dlossHit ? 'KILLED — no entries' : 'Active'; dlSub.style.color = dlossHit ? '#ef4444' : '#10b981'; }

      var bbThreshold = ${parseInt(_bbPeriod, 10)};
      var cEl = document.getElementById('ajax-candle-count');
      if (cEl) { cEl.textContent = d.candles || 0; cEl.style.color = (d.candles||0) >= bbThreshold ? '#10b981' : '#f59e0b'; }
      var cSub = document.getElementById('ajax-candle-status');
      if (cSub) { cSub.textContent = (d.candles||0) >= bbThreshold ? 'BB ready' : 'Warming up...'; cSub.style.color = (d.candles||0) >= bbThreshold ? '#10b981' : '#f59e0b'; }
      setText('ajax-tick-count', (d.tickCount || 0).toLocaleString());
      setText('ajax-last-tick', d.lastTickPrice ? INR(d.lastTickPrice) : '—');

      var capEl = document.getElementById('ajax-current-capital');
      if (capEl) { capEl.textContent = INR(d.capital); capEl.style.color = d.capital >= ${_straddleCapital()} ? '#10b981' : '#ef4444'; }
      var atpEl = document.getElementById('ajax-alltime-pnl');
      if (atpEl) { atpEl.textContent = (d.totalPnl >= 0 ? '+' : '') + INR(d.totalPnl); atpEl.style.color = PNL_COLOR(d.totalPnl); }

      if (d.currentBar) {
        ['open','high','low','close'].forEach(function(k){
          var el = document.getElementById('ajax-bar-' + k);
          if (el) el.textContent = INR(d.currentBar[k]);
        });
      }

      var nowHasPosition = !!d.position;
      if (nowHasPosition !== _lastHasPosition) { _lastHasPosition = nowHasPosition; window.location.reload(); return; }
      if (d.position) {
        var p = d.position;
        var ceCur = p.ce.curLtp != null ? p.ce.curLtp : p.ce.entryLtp;
        var peCur = p.pe.curLtp != null ? p.pe.curLtp : p.pe.entryLtp;
        var comb  = parseFloat((ceCur + peCur).toFixed(2));
        var combEl2 = document.getElementById('ajax-live-combined');
        if (combEl2) { combEl2.textContent = '₹' + comb; combEl2.style.color = comb >= p.netDebit ? '#10b981' : '#ef4444'; }
        var pctEl = document.getElementById('ajax-live-pct');
        if (pctEl) { var pct = ((comb - p.netDebit) / p.netDebit * 100).toFixed(2); pctEl.textContent = (pct >= 0 ? '+' : '') + pct + '%'; pctEl.style.color = comb >= p.netDebit ? '#10b981' : '#ef4444'; }
        var pairPnlEl = document.getElementById('ajax-pair-pnl');
        if (pairPnlEl && d.livePnl != null) { pairPnlEl.textContent = (d.livePnl >= 0 ? '+' : '') + INR(d.livePnl); pairPnlEl.style.color = PNL_COLOR(d.livePnl); }

        var ceEl = document.getElementById('ajax-ce-cur');
        if (ceEl) { ceEl.textContent = '₹' + ceCur; ceEl.style.color = ceCur >= p.ce.entryLtp ? '#10b981' : '#ef4444'; }
        var ceMoveEl = document.getElementById('ajax-ce-move');
        if (ceMoveEl) { var ceMv = ceCur - p.ce.entryLtp; ceMoveEl.textContent = (ceMv >= 0 ? '+' : '') + ceMv.toFixed(2); ceMoveEl.style.color = ceMv >= 0 ? '#10b981' : '#ef4444'; }
        var peEl = document.getElementById('ajax-pe-cur');
        if (peEl) { peEl.textContent = '₹' + peCur; peEl.style.color = peCur >= p.pe.entryLtp ? '#10b981' : '#ef4444'; }
        var peMoveEl = document.getElementById('ajax-pe-move');
        if (peMoveEl) { var peMv = peCur - p.pe.entryLtp; peMoveEl.textContent = (peMv >= 0 ? '+' : '') + peMv.toFixed(2); peMoveEl.style.color = peMv >= 0 ? '#10b981' : '#ef4444'; }
      }

      if ((d.sessionTrades || []).length !== _lastTradeCount) {
        _lastTradeCount = (d.sessionTrades || []).length;
        renderTrades(d.sessionTrades || []);
      }
      if ((d.log || []).length !== _lastLogCount) {
        _lastLogCount = (d.log || []).length;
        LOG_ALL.length = 0;
        (d.log || []).slice().reverse().forEach(function(l){ LOG_ALL.push(l); });
        if (typeof logFilter === 'function') logFilter();
      }

      if (_lastRunning && !d.running) { _lastRunning = false; setTimeout(function(){ window.location.reload(); }, 1500); }
    } catch (e) { console.warn('[straddle-paper] refresh:', e.message); }
  }

  ${state.running ? "var _it = setInterval(fetchAndUpdate, 2000); fetchAndUpdate();" : ""}
  document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'visible' && ${state.running}) fetchAndUpdate(); });
})();
</script>

</body></html>`);
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

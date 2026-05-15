/**
 * STRADDLE LIVE TRADE — /straddle-live
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-money paired ATM CE+PE execution via Fyers. Decision logic identical
 * to /straddle-paper (BB squeeze / low-VIX / event triggers, combined-premium
 * target/SL, time stop).
 *
 * SAFETY:
 *   • STRADDLE_LIVE_ENABLED=true must be set in Settings.
 *   • LIVE_HARNESS_DRY_RUN=true (default) → broker calls are LOGGED only.
 *   • Paired entry/exit: both legs are placed sequentially. If the CE fills
 *     but the PE call throws (rare — circuit breaker should catch most),
 *     the route logs a `🚨 PARTIAL FILL` warning to the activity log and
 *     emits a Telegram alert so you can manually square off the orphan leg.
 *
 * Endpoints mirror /straddle-paper plus /manualEntry POST.
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
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter   = require("../services/vixFilter");
const { fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const tradeLogger = require("../utils/tradeLogger");
const skipLogger  = require("../utils/skipLogger");
const fyers       = require("../config/fyers");
const fyersBroker = require("../services/fyersBroker");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport, sendTelegram } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { getISTMinutes, getBucketStart } = require("../utils/tradeUtils");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "straddleLive";
const RES_MIN            = 5;

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "straddle_live_trades.json");

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
let _dataCache = null;
function loadData() {
  if (_dataCache) return _dataCache;
  ensureDir();
  if (!fs.existsSync(PT_FILE)) {
    const init = { capital: parseFloat(process.env.STRADDLE_LIVE_CAPITAL || process.env.STRADDLE_PAPER_CAPITAL || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(init, null, 2));
    _dataCache = init; return init;
  }
  try { _dataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error("[straddle-live] file corrupt — resetting:", e.message);
    _dataCache = { capital: parseFloat(process.env.STRADDLE_LIVE_CAPITAL || process.env.STRADDLE_PAPER_CAPITAL || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(_dataCache, null, 2));
  }
  return _dataCache;
}
function saveData(d) { ensureDir(); const tmp = PT_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, PT_FILE); _dataCache = d; }

let state = _freshState();
function _freshState() {
  return {
    running: false, sessionStart: null, sessionTrades: [], sessionPnl: 0, pairsTaken: 0,
    candles: [], currentBar: null, barStartTime: null,
    tickCount: 0, lastTickTime: null, lastTickPrice: null,
    position: null, ceLtp: null, peLtp: null, optionLtpUpdatedAt: null,
    log: [], _sessionId: null, _expiryDayBlocked: false,
  };
}

function log(msg) {
  const stamp = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  const line = `[${stamp}] ${msg}`;
  state.log.push(line); if (state.log.length > 200) state.log.shift();
  console.log(line);
}
function istNow() { return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }); }
function isDryRun() { return (process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() === "true"; }

let _optionPollTimer = null;
function startOptionPolling() {
  stopOptionPolling();
  _optionPollTimer = setInterval(async () => {
    if (!state.position) return;
    try {
      const r = await fyers.getQuotes([state.position.ce.symbol, state.position.pe.symbol]);
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
function stopOptionPolling() { if (_optionPollTimer) { clearInterval(_optionPollTimer); _optionPollTimer = null; } }

async function placeLiveEntry(sigSnapshot) {
  const spot = state.lastTickPrice;
  if (!spot) return;

  let ceInfo, peInfo;
  try {
    ceInfo = await instrumentConfig.validateAndGetOptionSymbol(spot, "CE", "STRADDLE");
    peInfo = await instrumentConfig.validateAndGetOptionSymbol(spot, "PE", "STRADDLE");
  } catch (e) { log(`❌ Symbol resolve failed: ${e.message}`); return; }
  if (!ceInfo || ceInfo.invalid || !peInfo || peInfo.invalid) { log(`❌ No valid expiry for one or both legs`); return; }
  if (ceInfo.strike !== peInfo.strike) {
    peInfo.symbol = peInfo.symbol.replace(/(\d+)PE$/, `${ceInfo.strike}PE`);
    peInfo.strike = ceInfo.strike;
  }

  // Fetch entry premiums for ref
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
  } catch (_) {}
  if (!cePrem || !pePrem) { log(`❌ Premium fetch failed (CE=${cePrem}, PE=${pePrem})`); return; }

  const qty = instrumentConfig.getLotQty();

  // ── BROKER CALLS (paired, sequential) ────────────────────────────────────
  let ceOrderId = null, peOrderId = null;
  if (isDryRun()) {
    log(`🟡 [STRADDLE-LIVE DRY-RUN] WOULD place BUY ${qty} × ${ceInfo.symbol} (CE@₹${cePrem})`);
    log(`🟡 [STRADDLE-LIVE DRY-RUN] WOULD place BUY ${qty} × ${peInfo.symbol} (PE@₹${pePrem})`);
    ceOrderId = `dryrun-ce:${Date.now()}`;
    peOrderId = `dryrun-pe:${Date.now()}`;
  } else {
    try {
      const ceOrd = await fyersBroker.placeMarketOrder(ceInfo.symbol, 1, qty, "STR-LIVE-CE", { isFutures: false });
      if (!ceOrd || !ceOrd.success) { log(`❌ CE BUY failed: ${JSON.stringify(ceOrd)} — pair abandoned`); return; }
      ceOrderId = ceOrd.orderId;
      log(`🟢 CE BUY placed — orderId=${ceOrderId}`);

      const peOrd = await fyersBroker.placeMarketOrder(peInfo.symbol, 1, qty, "STR-LIVE-PE", { isFutures: false });
      if (!peOrd || !peOrd.success) {
        log(`🚨 PARTIAL FILL — CE filled (${ceOrderId}) but PE BUY failed: ${JSON.stringify(peOrd)}. Square off CE manually!`);
        try { sendTelegram(`🚨 STRADDLE-LIVE: PARTIAL FILL — CE (${ceInfo.symbol}) opened, PE failed. Manual cleanup required.`); } catch (_) {}
        return;
      }
      peOrderId = peOrd.orderId;
      log(`🟢 PE BUY placed — orderId=${peOrderId}`);
    } catch (e) {
      log(`❌ Pair entry threw: ${e.message}`);
      try { sendTelegram(`🚨 STRADDLE-LIVE: Entry threw — ${e.message}. Verify no orphan order.`); } catch (_) {}
      return;
    }
  }

  const netDebit = parseFloat((cePrem + pePrem).toFixed(2));
  const targetPct = parseFloat(process.env.STRADDLE_TARGET_PCT || "0.4");
  const stopPct   = parseFloat(process.env.STRADDLE_STOP_PCT   || "0.25");
  const pairId = `SL-${Date.now()}`;
  const pos = {
    pairId, strike: ceInfo.strike, expiry: ceInfo.expiry, qty,
    entrySpot: spot, entryTime: istNow(), entryTimeMs: Date.now(),
    netDebit, targetNet: parseFloat((netDebit * (1 + targetPct)).toFixed(2)), stopNet: parseFloat((netDebit * (1 - stopPct)).toFixed(2)), peakCombined: netDebit,
    ce: { symbol: ceInfo.symbol, entryLtp: cePrem, orderId: ceOrderId },
    pe: { symbol: peInfo.symbol, entryLtp: pePrem, orderId: peOrderId },
    trigger: sigSnapshot.trigger, signalStrength: sigSnapshot.signalStrength,
    bbWidth: sigSnapshot.bbWidth, bbWidthAvg: sigSnapshot.bbWidthAvg, vixAtEntry: getCachedVix(),
    entryReason: sigSnapshot.reason,
  };
  state.position = pos;
  state.ceLtp = cePrem; state.peLtp = pePrem;
  state.optionLtpUpdatedAt = Date.now();
  state.pairsTaken++;
  startOptionPolling();

  if ((process.env.STRADDLE_FORCE_ENTRY_NEXT || "false").toLowerCase() === "true") {
    process.env.STRADDLE_FORCE_ENTRY_NEXT = "false";
  }

  log(`🟢 [STRADDLE-LIVE ${isDryRun()?"DRY-RUN":"REAL"}] ENTER pair=${pairId} strike=${ceInfo.strike} | netDebit ₹${netDebit} | tgt ₹${pos.targetNet} sl ₹${pos.stopNet}`);
  notifyEntry({
    mode: isDryRun() ? "STRADDLE-LIVE (DRY-RUN)" : "STRADDLE-LIVE",
    side: "CE+PE", symbol: `${ceInfo.symbol} + ${peInfo.symbol}`,
    spotAtEntry: spot, optionEntryLtp: netDebit, qty,
    stopLoss: pos.stopNet, entryTime: pos.entryTime, entryReason: pos.entryReason,
  });
}

async function placeLiveExit(reason) {
  if (!state.position) return;
  const pos = state.position;
  const exitCe = state.ceLtp || pos.ce.entryLtp;
  const exitPe = state.peLtp || pos.pe.entryLtp;
  const exitSpot = state.lastTickPrice || pos.entrySpot;
  const qty = pos.qty;
  const exitTime = istNow();

  let ceExitId = null, peExitId = null;
  if (isDryRun()) {
    log(`🟡 [STRADDLE-LIVE DRY-RUN] WOULD SELL ${pos.ce.symbol} (CE ref ₹${exitCe}) — ${reason}`);
    log(`🟡 [STRADDLE-LIVE DRY-RUN] WOULD SELL ${pos.pe.symbol} (PE ref ₹${exitPe}) — ${reason}`);
    ceExitId = `dryrun-x-ce:${Date.now()}`;
    peExitId = `dryrun-x-pe:${Date.now()}`;
  } else {
    try {
      const ceOrd = await fyersBroker.placeMarketOrder(pos.ce.symbol, -1, qty, "STR-LIVE-CE-X", { isFutures: false });
      ceExitId = ceOrd && ceOrd.orderId;
      if (!ceOrd || !ceOrd.success) log(`⚠️ CE SELL failed: ${JSON.stringify(ceOrd)} — continuing PE exit`);
    } catch (e) { log(`⚠️ CE SELL threw: ${e.message}`); }
    try {
      const peOrd = await fyersBroker.placeMarketOrder(pos.pe.symbol, -1, qty, "STR-LIVE-PE-X", { isFutures: false });
      peExitId = peOrd && peOrd.orderId;
      if (!peOrd || !peOrd.success) log(`⚠️ PE SELL failed: ${JSON.stringify(peOrd)} — manual cleanup may be required`);
    } catch (e) { log(`⚠️ PE SELL threw: ${e.message}`); }
  }

  const chargesCE = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.ce.entryLtp, exitPremium: exitCe, qty });
  const chargesPE = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.pe.entryLtp, exitPremium: exitPe, qty });
  const cePnl = parseFloat(((exitCe - pos.ce.entryLtp) * qty - chargesCE).toFixed(2));
  const pePnl = parseFloat(((exitPe - pos.pe.entryLtp) * qty - chargesPE).toFixed(2));
  const pairPnl = parseFloat((cePnl + pePnl).toFixed(2));
  state.sessionPnl = parseFloat((state.sessionPnl + pairPnl).toFixed(2));

  const baseFields = {
    pairId: pos.pairId, qty,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    entryTime: pos.entryTime, exitTime,
    optionStrike: pos.strike, optionExpiry: pos.expiry,
    entryReason: pos.entryReason, exitReason: reason,
    signalStrength: pos.signalStrength, vixAtEntry: pos.vixAtEntry,
    trigger: pos.trigger, netDebit: pos.netDebit, netTarget: pos.targetNet, netStop: pos.stopNet,
    pairPnl, durationMs: Date.now() - pos.entryTimeMs,
    isLive: !isDryRun(), isDryRun: isDryRun(),
    instrument: "NIFTY_OPTIONS",
  };
  const ceRow = Object.assign({}, baseFields, { leg:"CE", side:"CE", symbol: pos.ce.symbol, entryPrice: pos.entrySpot, exitPrice: exitSpot, optionEntryLtp: pos.ce.entryLtp, optionExitLtp: exitCe, optionType:"CE", pnl: cePnl, charges: chargesCE, entryOrderId: pos.ce.orderId, exitOrderId: ceExitId });
  const peRow = Object.assign({}, baseFields, { leg:"PE", side:"PE", symbol: pos.pe.symbol, entryPrice: pos.entrySpot, exitPrice: exitSpot, optionEntryLtp: pos.pe.entryLtp, optionExitLtp: exitPe, optionType:"PE", pnl: pePnl, charges: chargesPE, entryOrderId: pos.pe.orderId, exitOrderId: peExitId });
  state.sessionTrades.push(ceRow, peRow);
  tradeLogger.appendTradeLog("straddle", Object.assign({ _live: true }, ceRow));
  tradeLogger.appendTradeLog("straddle", Object.assign({ _live: true }, peRow));

  log(`🔴 [STRADDLE-LIVE ${isDryRun()?"DRY-RUN":"REAL"}] EXIT pair=${pos.pairId} | pair PnL=₹${pairPnl} (${reason})`);
  notifyExit({
    mode: isDryRun() ? "STRADDLE-LIVE (DRY-RUN)" : "STRADDLE-LIVE",
    side: "CE+PE", symbol: `${pos.ce.symbol} + ${pos.pe.symbol}`,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    optionEntryLtp: pos.netDebit, optionExitLtp: parseFloat((exitCe + exitPe).toFixed(2)),
    pnl: pairPnl, sessionPnl: state.sessionPnl,
    exitReason: reason, entryTime: pos.entryTime, exitTime, qty,
  });

  state.position = null;
  state.ceLtp = null; state.peLtp = null;
  state.optionLtpUpdatedAt = null;
  stopOptionPolling();
}

function _checkExits() {
  if (!state.position || state.ceLtp == null || state.peLtp == null) return;
  const pos = state.position;
  const combined = parseFloat((state.ceLtp + state.peLtp).toFixed(2));
  if (combined > pos.peakCombined) pos.peakCombined = combined;
  if (combined >= pos.targetNet) return placeLiveExit(`Combined target hit (₹${combined} >= ₹${pos.targetNet})`);
  if (combined <= pos.stopNet)   return placeLiveExit(`Combined SL hit (₹${combined} <= ₹${pos.stopNet})`);
  const maxHoldDays = parseFloat(process.env.STRADDLE_MAX_HOLD_DAYS || "3");
  if ((Date.now() - pos.entryTimeMs) > maxHoldDays * 86400 * 1000) return placeLiveExit(`Time stop (held > ${maxHoldDays} days)`);
}

async function onCandleClose(bar) {
  if (state.position) return;
  const _spot = bar && bar.close;
  if (state._expiryDayBlocked) { skipLogger.appendSkipLog("straddle", { gate:"expiry_day_only", reason:"Not expiry day", spot:_spot, _live:true }); return; }
  const maxLoss = parseFloat(process.env.STRADDLE_MAX_DAILY_LOSS || "3000");
  if (state.sessionPnl <= -maxLoss) { skipLogger.appendSkipLog("straddle", { gate:"daily_loss", reason:`sessionPnl ${state.sessionPnl} <= -${maxLoss}`, spot:_spot, _live:true }); return; }
  const maxPairs = parseInt(process.env.STRADDLE_MAX_DAILY_PAIRS || "1", 10);
  if (state.pairsTaken >= maxPairs) return;
  let vix = getCachedVix();
  if (vix == null && (process.env.STRADDLE_VIX_ENABLED || "false").toLowerCase() === "true") { try { vix = await fetchLiveVix({ force: true }); } catch (_) {} }
  const sig = straddleStrategy.getSignal(state.candles, { alreadyOpen: false, vix });
  if (sig.signal !== "ENTER_STRADDLE") {
    if (sig.bbWidth != null) skipLogger.appendSkipLog("straddle", { gate:"signal_none", reason: sig.reason, spot:_spot, vix, bbWidth: sig.bbWidth, bbWidthAvg: sig.bbWidthAvg, _live:true });
    return;
  }
  await placeLiveEntry(sig);
}

function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (!price || price <= 0) return;
  state.tickCount++; state.lastTickTime = Date.now(); state.lastTickPrice = price;
  const bucketMs = getBucketStart(Date.now(), RES_MIN);
  if (!state.currentBar || state.barStartTime !== bucketMs) {
    if (state.currentBar) {
      const last = state.candles.length ? state.candles[state.candles.length - 1] : null;
      if (last && last.time === state.currentBar.time) state.candles[state.candles.length - 1] = { ...state.currentBar };
      else state.candles.push({ ...state.currentBar });
      if (state.candles.length > 300) state.candles.shift();
      onCandleClose(state.currentBar).catch(e => console.error(`🚨 [STRADDLE-LIVE] onCandleClose: ${e.message}`));
    }
    const bucketSec = Math.floor(bucketMs / 1000);
    const lastPre = state.candles.length ? state.candles[state.candles.length - 1] : null;
    if (lastPre && lastPre.time === bucketSec) { state.currentBar = state.candles.pop(); state.currentBar.high = Math.max(state.currentBar.high, price); state.currentBar.low = Math.min(state.currentBar.low, price); state.currentBar.close = price; }
    else state.currentBar = { time: bucketSec, open: price, high: price, low: price, close: price };
    state.barStartTime = bucketMs;
  } else {
    state.currentBar.high = Math.max(state.currentBar.high, price);
    state.currentBar.low  = Math.min(state.currentBar.low, price);
    state.currentBar.close = price;
  }
  if (state.position) _checkExits();
  if (state.position) {
    const stopMin = (function() { const raw = process.env.STRADDLE_FORCED_EXIT || "15:15"; const [h,m] = raw.split(":").map(Number); return h*60 + (isNaN(m)?0:m); })();
    if (getISTMinutes() >= stopMin) placeLiveExit(`EOD square-off (${process.env.STRADDLE_FORCED_EXIT || "15:15"} IST)`);
  }
}

async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { fetchCandles } = require("../services/backtestEngine");
    const istToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const from = Math.floor(new Date(istToday + "T03:45:00.000Z").getTime() / 1000) - 3*86400;
    const to   = Math.floor(Date.now() / 1000);
    const candles = await fetchCandlesCached(NIFTY_INDEX_SYMBOL, RES_MIN, from, to, fetchCandles);
    if (Array.isArray(candles) && candles.length) { state.candles = candles.slice(-200); log(`📊 Preloaded ${state.candles.length} candles`); }
  } catch (e) { log(`⚠️ Preload failed: ${e.message}`); }
}

let _autoStopTimer = null;
function scheduleAutoStop() {
  if (_autoStopTimer) clearTimeout(_autoStopTimer);
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  const stopMin = h * 60 + (isNaN(m) ? 0 : m);
  const minsLeft = stopMin - getISTMinutes();
  if (minsLeft <= 0) return;
  _autoStopTimer = setTimeout(() => { log(`⏰ Auto-stop @ ${raw} IST`); stopSession(); }, minsLeft * 60 * 1000);
}

router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/straddle-live/status");
  if ((process.env.STRADDLE_MODE_ENABLED || "true").toLowerCase() !== "true") return res.status(403).send(_errorPage("Straddle Disabled","Enable Straddle Mode in Settings first","/settings","Go to Settings"));
  if ((process.env.STRADDLE_LIVE_ENABLED || "false").toLowerCase() !== "true") return res.status(403).send(_errorPage("Straddle Live Disabled","Set STRADDLE_LIVE_ENABLED=true in Settings to allow live trading.","/settings","Go to Settings"));
  const check = sharedSocketState.canStart("STRADDLE_LIVE");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/straddle-live/status", "← Back"));
  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login"));
  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/straddle-live/status", "← Back"));

  let _expiryBlocked = false;
  if ((process.env.STRADDLE_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
    const { isExpiryDay } = require("../utils/nseHolidays");
    _expiryBlocked = !(await isExpiryDay());
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `straddle-live:${Date.now()}`;
  state._expiryDayBlocked = _expiryBlocked;
  if (typeof sharedSocketState.setStraddleActive === "function") sharedSocketState.setStraddleActive("STRADDLE_LIVE");

  await preloadHistory();
  if ((process.env.STRADDLE_VIX_ENABLED || "false").toLowerCase() === "true") { resetVixCache(); fetchLiveVix({ force: true }).catch(() => {}); }
  if (socketManager.isRunning()) socketManager.addCallback(CALLBACK_ID, onTick, log);
  else { socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log); socketManager.addCallback(CALLBACK_ID, onTick, log); }
  scheduleAutoStop();
  const dryStr = isDryRun() ? "DRY-RUN" : "🚨 REAL ORDERS";
  log(`🟢 [STRADDLE-LIVE ${dryStr}] Session started`);
  notifyStarted({ mode: `STRADDLE-LIVE ${isDryRun()?"(DRY-RUN)":""}`, text: `📡 STRADDLE LIVE STARTED ${dryStr}` });
  res.redirect("/straddle-live/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) placeLiveExit("Session stopped");
  state.running = false;
  stopOptionPolling();
  socketManager.removeCallback(CALLBACK_ID);
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();
  if (typeof sharedSocketState.clearStraddle === "function") sharedSocketState.clearStraddle();
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  if (state.sessionTrades.length) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: straddleStrategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades, isLive: !isDryRun() });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      saveData(data);
      log(`💾 Session saved — ${state.sessionTrades.length} leg trades`);
    } catch (e) { log(`⚠️ Save failed: ${e.message}`); }
  }
  log("🔴 Session stopped");
  notifyDayReport({ mode: `STRADDLE-LIVE ${isDryRun()?"(DRY-RUN)":""}`, sessionTrades: state.sessionTrades, sessionPnl: state.sessionPnl, sessionStart: state.sessionStart });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/straddle-live/status"); });
router.get("/exit", (req, res) => { if (state.position) placeLiveExit("Manual exit"); res.redirect("/straddle-live/status"); });

router.post("/manualEntry", async (req, res) => {
  if (!state.running) return res.status(400).json({ success: false, error: "Straddle live is not running." });
  if (state.position) return res.status(400).json({ success: false, error: "Already in a pair. Exit first." });
  const spot = state.lastTickPrice || (state.currentBar ? state.currentBar.close : null);
  if (!spot) return res.status(400).json({ success: false, error: "No market data yet." });
  const sig = { signal: "ENTER_STRADDLE", trigger: "MANUAL", bbWidth: null, bbWidthAvg: null, signalStrength: "MANUAL", reason: `🖐️ MANUAL straddle entry @ spot ₹${spot}` };
  log(`🖐️ MANUAL entry triggered by user`);
  try { await placeLiveEntry(sig); return res.json({ success: true, spot }); }
  catch (e) { log(`❌ Manual entry failed: ${e.message}`); return res.status(500).json({ success: false, error: e.message }); }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const combined = (state.ceLtp != null && state.peLtp != null) ? parseFloat((state.ceLtp + state.peLtp).toFixed(2)) : null;
  const data = loadData();
  let livePnl = null;
  if (pos && state.ceLtp != null && state.peLtp != null) {
    const lot = pos.qty || instrumentConfig.getLotQty();
    livePnl = parseFloat((((state.ceLtp - pos.ce.entryLtp) + (state.peLtp - pos.pe.entryLtp)) * lot).toFixed(2));
  }
  const pairMap = new Map();
  for (const t of state.sessionTrades) {
    if (!t.pairId) continue;
    if (!pairMap.has(t.pairId)) pairMap.set(t.pairId, { ts: 0, pnl: 0 });
    const p = pairMap.get(t.pairId);
    p.pnl += (t.pnl || 0); p.ts = t.exitTime || t.entryTime;
  }
  const pairs = Array.from(pairMap.values());
  let cum = 0;
  const cumPnl = pairs.map(p => { cum += p.pnl; return { t: p.ts, pnl: parseFloat(cum.toFixed(2)) }; });
  const wins = pairs.filter(p => p.pnl > 0).length;
  const losses = pairs.filter(p => p.pnl < 0).length;
  const winRate = pairs.length ? ((wins / pairs.length) * 100).toFixed(1) : null;
  res.json({
    running: state.running, dryRun: isDryRun(),
    sessionPnl: state.sessionPnl, pairsTaken: state.pairsTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-100),
    tickCount: state.tickCount, lastTickPrice: state.lastTickPrice, candles: state.candles.length,
    ceLtp: state.ceLtp, peLtp: state.peLtp, combined, livePnl,
    vix: getCachedVix(),
    wins, losses, winRate, cumPnl,
    position: pos ? Object.assign({}, pos, { ce: Object.assign({}, pos.ce, { curLtp: state.ceLtp }), pe: Object.assign({}, pos.pe, { curLtp: state.peLtp }) }) : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

router.get("/status/chart-data", (req, res) => {
  try {
    const candles = state.candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.currentBar) candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });
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
    res.json({ candles, markers: [], entryPrice: state.position && state.position.entrySpot, bbUpper, bbMiddle, bbLower });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const dry = isDryRun();
  res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
${faviconLink()}<title>Straddle Live</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;}
${sidebarCSS()}${modalCSS()}
.main-content{flex:1;padding:16px 22px 40px;min-height:100vh;}
@media(max-width:900px){.main-content{margin-left:0;padding:14px;}}
.banner{background:${dry?"rgba(245,158,11,0.12)":"rgba(239,68,68,0.12)"};border:1px solid ${dry?"rgba(245,158,11,0.4)":"rgba(239,68,68,0.4)"};border-radius:8px;padding:8px 14px;margin-bottom:14px;color:${dry?"#fbbf24":"#ef4444"};font-size:0.72rem;font-weight:700;}
.page-title{font-size:1.05rem;font-weight:700;margin-bottom:2px;}
.page-sub{font-size:0.7rem;color:#4a6080;margin-bottom:14px;}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:14px;}
@media(max-width:1100px){.grid{grid-template-columns:repeat(3,1fr);}}
.sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:11px 13px;position:relative;}
.sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:#ec4899;}
.sc-label{font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:4px;font-family:'IBM Plex Mono',monospace;}
.sc-val{font-size:1.1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
.panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;margin-bottom:14px;}
.panel h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.4px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
.log{background:#040c18;border:0.5px solid #0e1e36;border-radius:6px;padding:8px 10px;font-family:'IBM Plex Mono',monospace;font-size:0.65rem;color:#94a3b8;max-height:280px;overflow-y:auto;white-space:pre-wrap;}
table{width:100%;border-collapse:collapse;font-size:0.66rem;font-family:'IBM Plex Mono',monospace;}
th,td{padding:6px 8px;text-align:left;border-bottom:0.5px solid #0e1e36;}
th{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;background:#040c18;}
.pos{color:#10b981;}.neg{color:#ef4444;}.muted{color:#3a5070;}
.empty{text-align:center;color:#3a5070;padding:18px 0;font-size:0.7rem;}
</style></head><body>
<div class="app-shell">
${buildSidebar('straddleLive', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/straddle-live/start'`, startLabel: '▶ Start Straddle Live',
  showStopBtn: state.running, stopBtnJs: `location.href='/straddle-live/stop'`, stopLabel: '■ Stop',
  showExitBtn: state.running && !!state.position, exitBtnJs: `location.href='/straddle-live/exit'`, exitLabel: '🚪 Exit Pair',
})}
<main class="main-content">
  <div class="banner">${dry?"⚠️ DRY-RUN MODE — Orders LOGGED only. Set LIVE_HARNESS_DRY_RUN=false to fire real orders.":"🚨 LIVE MODE — Real broker orders are being placed at Fyers."}</div>
  <div class="page-title">📡 Straddle Live Trade ${dry?"<span style='color:#fbbf24;'>(DRY-RUN)</span>":""}</div>
  <div class="page-sub">${straddleStrategy.NAME} — paired ATM CE+PE · ${dry?"decisions only":"real Fyers orders"}</div>
  <div class="grid">
    <div class="sc"><div class="sc-label">Status</div><div class="sc-val" id="status">—</div></div>
    <div class="sc"><div class="sc-label">Session P&L</div><div class="sc-val" id="pnl">—</div></div>
    <div class="sc"><div class="sc-label">Live PnL</div><div class="sc-val" id="livePnl">—</div></div>
    <div class="sc"><div class="sc-label">Pairs</div><div class="sc-val" id="pairs">—</div></div>
    <div class="sc"><div class="sc-label">Spot · VIX</div><div class="sc-val" id="spotVix">—</div></div>
    <div class="sc"><div class="sc-label">Mode</div><div class="sc-val">${dry?'<span style="color:#fbbf24;">DRY-RUN</span>':'<span style="color:#ef4444;">LIVE</span>'}</div></div>
  </div>
  <div class="panel"><h3>📌 Open Pair</h3><div id="position-box" class="empty">No open pair</div>
    <div id="manual-entry" style="display:none;margin-top:10px;text-align:right;">
      <button onclick="doManualEntry()" style="background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.4);padding:6px 14px;border-radius:5px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">🎯 Manual Straddle Entry</button>
    </div>
  </div>
  <div class="panel"><h3>📊 Live NIFTY 5-min (BB squeeze overlay)</h3><div id="niftyChart" style="height:340px;"></div></div>
  <div class="panel"><h3>📜 Session Trades (leg-flat)</h3><div id="trades-box" class="empty">No trades yet</div></div>
  <div class="panel"><h3>📓 Activity Log</h3><div id="log" class="log">—</div></div>
</main>
</div>
<script>
${modalJS()}
var _niftyChart = null, _csSeries = null, _bbU = null, _bbM = null, _bbL = null;
function ensureChart(){ if (_niftyChart) return; var c=document.getElementById('niftyChart'); if (!c||typeof LightweightCharts==='undefined') return;
  _niftyChart = LightweightCharts.createChart(c, { layout:{background:{color:'transparent'},textColor:'#94a3b8'}, grid:{vertLines:{color:'#0e1e36'},horzLines:{color:'#0e1e36'}}, timeScale:{timeVisible:true,secondsVisible:false,borderColor:'#0e1e36'}, rightPriceScale:{borderColor:'#0e1e36'}, width:c.clientWidth, height:340 });
  _csSeries = _niftyChart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  _bbU = _niftyChart.addLineSeries({ color:'rgba(74,156,245,0.7)', lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  _bbM = _niftyChart.addLineSeries({ color:'rgba(148,163,184,0.55)', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false });
  _bbL = _niftyChart.addLineSeries({ color:'rgba(74,156,245,0.7)', lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  window.addEventListener('resize', function(){ if(_niftyChart) _niftyChart.applyOptions({ width: c.clientWidth }); });
}
async function refreshChart(){ ensureChart(); if(!_csSeries) return;
  try { var d = await (await fetch('/straddle-live/status/chart-data',{cache:'no-store'})).json(); if(d.candles&&d.candles.length) _csSeries.setData(d.candles); if(d.bbUpper) _bbU.setData(d.bbUpper); if(d.bbMiddle) _bbM.setData(d.bbMiddle); if(d.bbLower) _bbL.setData(d.bbLower); } catch(e){}
}
async function refresh(){
  try {
    var d = await (await fetch('/straddle-live/status/data',{cache:'no-store'})).json();
    var pnlCls = d.sessionPnl > 0 ? 'pos' : d.sessionPnl < 0 ? 'neg' : 'muted';
    document.getElementById('status').innerHTML = d.running ? '<span class="pos">RUNNING</span>' : '<span class="muted">STOPPED</span>';
    document.getElementById('pnl').innerHTML = '<span class="' + pnlCls + '">₹' + d.sessionPnl.toFixed(2) + '</span>';
    if (d.livePnl != null) { var lc = d.livePnl>0?'pos':d.livePnl<0?'neg':'muted'; document.getElementById('livePnl').innerHTML='<span class="'+lc+'">₹'+d.livePnl.toFixed(2)+'</span>'; } else document.getElementById('livePnl').textContent='—';
    document.getElementById('pairs').textContent = d.pairsTaken;
    document.getElementById('spotVix').textContent = (d.lastTickPrice ? d.lastTickPrice.toFixed(2) : '—') + ' · VIX ' + (d.vix != null ? d.vix.toFixed(1) : '—');
    document.getElementById('log').textContent = (d.log || []).join('\\n');
    if (d.position) {
      var p = d.position;
      var ceCur = p.ce.curLtp != null ? p.ce.curLtp : p.ce.entryLtp;
      var peCur = p.pe.curLtp != null ? p.pe.curLtp : p.pe.entryLtp;
      document.getElementById('manual-entry').style.display = 'none';
      document.getElementById('position-box').className = '';
      document.getElementById('position-box').innerHTML = '<table><tr><th>Pair</th><th>Strike</th><th>Net Debit</th><th>Live</th><th>Target/SL</th><th>CE</th><th>PE</th><th>OrderIDs</th></tr>' +
        '<tr><td style="font-size:0.62rem;">' + p.pairId + '</td><td>' + p.strike + '</td><td>₹' + p.netDebit + '</td><td>₹' + (ceCur+peCur).toFixed(2) + '</td><td>₹' + p.targetNet + '/₹' + p.stopNet + '</td><td>₹' + p.ce.entryLtp + '→₹' + ceCur + '</td><td>₹' + p.pe.entryLtp + '→₹' + peCur + '</td><td style="font-size:0.55rem;">CE:' + (p.ce.orderId||'—') + '<br/>PE:' + (p.pe.orderId||'—') + '</td></tr></table>';
    } else {
      document.getElementById('position-box').className = 'empty';
      document.getElementById('position-box').textContent = d.running ? 'No open pair — waiting for trigger' : 'No open pair';
      document.getElementById('manual-entry').style.display = d.running ? 'block' : 'none';
    }
    var trades = d.sessionTrades || [];
    if (trades.length) {
      var rows = trades.slice().reverse().map(function(t){ var cls = t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : 'muted'); return '<tr><td>' + (t.pairId||'') + '</td><td class="' + (t.leg==='CE'?'pos':'neg') + '"><b>' + (t.leg||'') + '</b></td><td>' + (t.symbol||'') + '</td><td>' + (t.entryTime||'') + '</td><td>₹' + (t.optionEntryLtp||'') + '</td><td>₹' + (t.optionExitLtp||'') + '</td><td class="' + cls + '"><b>₹' + (t.pnl != null ? t.pnl.toFixed(2) : '—') + '</b></td><td style="color:#94a3b8;font-size:0.65rem;">' + (t.exitReason||'') + '</td></tr>'; }).join('');
      document.getElementById('trades-box').className = '';
      document.getElementById('trades-box').innerHTML = '<table><tr><th>Pair</th><th>Leg</th><th>Symbol</th><th>Entry</th><th>E.LTP</th><th>X.LTP</th><th>Leg PnL</th><th>Exit Reason</th></tr>' + rows + '</table>';
    } else { document.getElementById('trades-box').className = 'empty'; document.getElementById('trades-box').textContent = 'No trades yet'; }
    refreshChart();
  } catch (e) {}
}
async function doManualEntry(){
  if (!confirm('Force a MANUAL straddle entry${dry?" (DRY-RUN logged)":" (REAL ORDERS)"} ?')) return;
  try { var j = await (await fetch('/straddle-live/manualEntry',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json(); if(!j.success){alert('Failed: '+(j.error||'')); return;} refresh(); } catch(e){ alert(e.message); }
}
refresh(); setInterval(refresh, 2000);
</script>
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

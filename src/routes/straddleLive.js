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
const { scalpStyleCSS, scalpTopBar, scalpCapitalStrip, scalpStatGrid, scalpCurrentBar, scalpActivityLog } = require("../utils/scalpStyleUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter   = require("../services/vixFilter");
const { fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const tradeLogger = require("../utils/tradeLogger");
const skipLogger  = require("../utils/skipLogger");
const fyers       = require("../config/fyers");
const fyersBroker = require("../services/fyersBroker");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport, sendTelegram } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { getISTMinutes, getBucketStart, fmtISTDateTime } = require("../utils/tradeUtils");

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
    currentBar: state.currentBar, sessionStart: state.sessionStart,
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

function _straddleLiveCapital() {
  const v = parseFloat(process.env.STRADDLE_LIVE_CAPITAL || process.env.STRADDLE_PAPER_CAPITAL);
  return isNaN(v) ? 100000 : v;
}

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const dry = isDryRun();
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

  let livePnl = null;
  let combined = null;
  if (pos && state.ceLtp != null && state.peLtp != null) {
    combined = parseFloat((state.ceLtp + state.peLtp).toFixed(2));
    const lot = pos.qty || instrumentConfig.getLotQty();
    livePnl = parseFloat((((state.ceLtp - pos.ce.entryLtp) + (state.peLtp - pos.pe.entryLtp)) * lot).toFixed(2));
  }

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
      accent: dry ? "#fbbf24" : "#ec4899",
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
          ${pos.ce.orderId || pos.pe.orderId ? `<span style="font-size:0.62rem;color:#94a3b8;font-family:monospace;">CE:${pos.ce.orderId || "—"} · PE:${pos.pe.orderId || "—"}</span>` : ""}
        </div>
        <button onclick="strlHandleExit(this)"
           style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;">
          Exit Pair ${dry ? "(DRY)" : "Live"}
        </button>
      </div>

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

      <div style="background:#0a0f24;border:2px solid #ec4899;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
        <div style="font-size:0.68rem;font-weight:700;color:#ec4899;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Combined Premium</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">
          <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid #1e3a5f;border-radius:10px;">
            <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Net Debit</div>
            <div style="font-size:2rem;font-weight:800;color:#60a5fa;font-family:monospace;line-height:1;">₹${pos.netDebit}</div>
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
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px;">
        <div style="background:#071a12;border:1px solid #134e35;border-left:3px solid #10b981;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#10b981;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">CE Leg</div>
          <div style="font-size:0.7rem;color:#94a3b8;font-family:monospace;margin-bottom:6px;">${pos.ce.symbol}</div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <span style="font-size:0.95rem;font-weight:700;color:#c8d8f0;font-family:monospace;">₹${pos.ce.entryLtp} → <span id="ajax-ce-cur" style="color:${ceCur >= pos.ce.entryLtp ? "#10b981" : "#ef4444"};">₹${ceCur}</span></span>
            <span id="ajax-ce-move" style="font-size:0.85rem;font-weight:700;color:${ceMove >= 0 ? "#10b981" : "#ef4444"};">${ceMove >= 0 ? "+" : ""}${ceMove.toFixed(2)}</span>
          </div>
          ${pos.ce.orderId ? `<div style="font-size:0.6rem;color:#94a3b8;font-family:monospace;margin-top:4px;">CE order: ${pos.ce.orderId}</div>` : ""}
        </div>
        <div style="background:#1a0707;border:1px solid #7f1d1d;border-left:3px solid #ef4444;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#ef4444;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">PE Leg</div>
          <div style="font-size:0.7rem;color:#94a3b8;font-family:monospace;margin-bottom:6px;">${pos.pe.symbol}</div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <span style="font-size:0.95rem;font-weight:700;color:#c8d8f0;font-family:monospace;">₹${pos.pe.entryLtp} → <span id="ajax-pe-cur" style="color:${peCur >= pos.pe.entryLtp ? "#10b981" : "#ef4444"};">₹${peCur}</span></span>
            <span id="ajax-pe-move" style="font-size:0.85rem;font-weight:700;color:${peMove >= 0 ? "#10b981" : "#ef4444"};">${peMove >= 0 ? "+" : ""}${peMove.toFixed(2)}</span>
          </div>
          ${pos.pe.orderId ? `<div style="font-size:0.6rem;color:#94a3b8;font-family:monospace;margin-top:4px;">PE order: ${pos.pe.orderId}</div>` : ""}
        </div>
      </div>

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
      ${state.running ? `<button onclick="strlManualEntry()" style="padding:8px 24px;background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">🎯 Manual Straddle Entry</button>` : ""}
    </div>`;

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
<title>Straddle Live — ${straddleStrategy.NAME}${dry ? " (DRY-RUN)" : ""}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<style>
${sidebarCSS()}
${modalCSS()}
${scalpStyleCSS()}
</style></head>
<body>
<div class="app-shell">
${buildSidebar('straddleLive', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/straddle-live/start'`, startLabel: '▶ Start Straddle Live',
  showStopBtn: state.running, stopBtnJs: `location.href='/straddle-live/stop'`, stopLabel: '■ Stop',
  showExitBtn: state.running && !!state.position, exitBtnJs: `location.href='/straddle-live/exit'`, exitLabel: '🚪 Exit Pair',
})}
<div class="main-content">

<div class="banner ${dry ? "banner-dry" : "banner-live"}">${dry ? "⚠️ DRY-RUN MODE — Orders LOGGED only. Set LIVE_HARNESS_DRY_RUN=false in Settings to fire real orders." : "🚨 LIVE MODE — Real broker orders are being placed at Fyers. Confirm intentional."}</div>

${scalpTopBar({
  title: `Straddle Live Trade${dry ? " (DRY-RUN)" : ""}`,
  metaLine: `${straddleStrategy.NAME} · ATM CE+PE long · BB ${_bbPeriod}/${_bbStd} squeeze · Target +${_tgtPct}% / Stop -${_stpPct}% net · ${dry ? "decisions logged only" : "real Fyers orders"}`,
  running: state.running,
  vix: { enabled: _vixEnabled, value: _vix, maxEntry: _vixMaxEntry, strongOnly: Infinity },
  primaryAction: { label: dry ? "Start Straddle (DRY)" : "Start Straddle Live", href: "/straddle-live/start", color: dry ? "#92400e" : "#831843" },
  stopAction:    { label: "Stop Session", href: "/straddle-live/stop" },
  liveBadge: { kind: dry ? "dry" : "live" },
})}

${scalpCapitalStrip({
  starting: _straddleLiveCapital(),
  current:  data.capital,
  allTime:  data.totalPnl,
  startingThreshold: _straddleLiveCapital(),
  note: dry ? "Capital + PnL track DRY-RUN simulated fills." : "Capital updates from real broker fills.",
})}

${scalpStatGrid(statCards)}

${scalpCurrentBar({ bar: state.currentBar, resMin: 5 })}

<div id="ajax-position-section" style="margin-bottom:18px;">
${posHtml}
</div>

${process.env.CHART_ENABLED !== "false" ? `<div style="margin-bottom:18px;">
  <div class="section-title">NIFTY 5-Min Chart (BB ${_bbPeriod}/${_bbStd} squeeze overlay)</div>
  <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
    <div id="nifty-chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
      <span style="color:rgba(74,156,245,0.9);">── BB U/L</span> &nbsp;<span style="color:#94a3b8;">-- BB Mid</span> &nbsp;<span style="color:#3b82f6;">-- Entry Spot</span>
    </div>
  </div>
</div>` : ""}

<div id="strl-trades-section" style="margin-bottom:18px;">
  <div class="section-title">Session Trades <span id="strl-trades-hint" style="color:#4a6080;font-weight:400;letter-spacing:0.5px;text-transform:none;margin-left:8px;">${state.sessionTrades.length} rows</span></div>
  <div id="strl-trades-box" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;${state.sessionTrades.length ? "" : "padding:24px;text-align:center;color:#4a6080;font-size:0.82rem;"}">${state.sessionTrades.length ? "" : "No trades yet"}</div>
</div>

${scalpActivityLog({ logsJSON })}

</div><!-- /main-content -->
</div><!-- /app-shell -->

<script>
${modalJS()}
async function strlHandleExit(btn){
  var ok = await showConfirm({ icon:'🚪', title:'Exit pair', message:'Exit straddle pair now? ${dry ? "(DRY-RUN logged)" : "(REAL broker orders)"}', confirmText:'Exit', confirmClass:'modal-btn-danger' });
  if (!ok) return;
  btn.disabled = true; btn.textContent = 'Exiting...';
  fetch('/straddle-live/exit').then(function(){ location.reload(); }).catch(function(){ location.reload(); });
}
async function strlManualEntry(){
  var ok = await showConfirm({ icon:'🎯', title:'Manual straddle', message:'Force CE+PE pair at current ATM. ${dry ? "DRY-RUN — logged only." : "REAL ORDERS will be placed for both legs."}', confirmText:'Enter pair', confirmClass: ${dry ? "''" : "'modal-btn-danger'"} });
  if (!ok) return;
  try {
    var r = await fetch('/straddle-live/manualEntry', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    var j = await r.json();
    if (!j.success) { alert('Failed: ' + (j.error || 'unknown')); return; }
    location.reload();
  } catch(e) { alert('Error: ' + e.message); }
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
      var r = await fetch('/straddle-live/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) cs.setData(d.candles);
      bbU.setData(d.bbUpper  || []);
      bbM.setData(d.bbMiddle || []);
      bbL.setData(d.bbLower  || []);
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
    var box  = document.getElementById('strl-trades-box');
    var hint = document.getElementById('strl-trades-hint');
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
        '<td style="padding:8px 12px;color:#60a5fa;">' + (t.optionEntryLtp!=null?'₹'+t.optionEntryLtp:'—') + '</td>' +
        '<td style="padding:8px 12px;color:#60a5fa;">' + (t.optionExitLtp!=null?'₹'+t.optionExitLtp:'—') + '</td>' +
        '<td style="padding:8px 12px;font-weight:800;color:' + pc + ';">' + (t.pnl!=null?(t.pnl>=0?'+':'')+'₹'+t.pnl.toFixed(2):'—') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.62rem;color:#94a3b8;font-family:monospace;">' + (t.entryOrderId||t.orderId||'—') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.65rem;color:#4a6080;">' + (t.exitReason||'') + '</td>' +
      '</tr>';
    }).join('');
    box.innerHTML = '<table style="width:100%;border-collapse:collapse;font-family:monospace;font-size:0.78rem;">' +
      '<thead><tr style="background:#0a0f1c;">' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Pair</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Leg</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Symbol</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">E.LTP</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">X.LTP</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Leg PnL</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Order ID</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit Reason</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function fetchAndUpdate(){
    try {
      var r = await fetch('/straddle-live/status/data', { cache:'no-store' });
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
      if (capEl) { capEl.textContent = INR(d.capital); capEl.style.color = d.capital >= ${_straddleLiveCapital()} ? '#10b981' : '#ef4444'; }
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
    } catch (e) { console.warn('[straddle-live] refresh:', e.message); }
  }

  ${state.running ? "var _it = setInterval(fetchAndUpdate, 2000); fetchAndUpdate();" : ""}
  document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'visible' && ${state.running}) fetchAndUpdate(); });
})();
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

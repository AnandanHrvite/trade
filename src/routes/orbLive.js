/**
 * ORB LIVE TRADE — /orb-live
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-money execution of the Opening Range Breakout strategy via Fyers.
 *
 * Decision logic is identical to /orb-paper — same opening-range detection,
 * same SL/target maths, same VIX gate, same OR window, same expiry-day-only
 * filter, same manual-entry override. Only difference: at the moment of
 * buy/sell, this route calls `fyersBroker.placeMarketOrder` instead of just
 * simulating a fill.
 *
 * SAFETY PATTERN:
 *   1. `ORB_LIVE_ENABLED=true`  must be set in Settings → live routes can start.
 *   2. `LIVE_HARNESS_DRY_RUN=true` (default) → broker calls are LOGGED only,
 *      no real orders. Flip to false once you have proof paper-decisions are
 *      good, then live orders fire.
 *   3. `placeMarketOrder` is guarded by the existing circuit-breaker +
 *      cautious-retry layer (src/services/fyersBroker.js).
 *
 * Endpoints:
 *   /orb-live/start     → enable; subscribes socket; places real orders on entry
 *   /orb-live/stop      → exits any open position; saves session
 *   /orb-live/status    → live view (same shape as paper, LIVE badge)
 *   /orb-live/exit      → manual exit
 *   /orb-live/manualEntry  POST { side } → force CE/PE entry
 *   /orb-live/status/data       (json)
 *   /orb-live/status/chart-data (json — candles + OR + markers)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const orbStrategy        = require("../strategies/orb_breakout");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter   = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const tradeLogger = require("../utils/tradeLogger");
const skipLogger  = require("../utils/skipLogger");
const fyers       = require("../config/fyers");
const fyersBroker = require("../services/fyersBroker");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { getISTMinutes, getBucketStart } = require("../utils/tradeUtils");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "orbLive";
const RES_MIN            = 5;

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "orb_live_trades.json");

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
let _dataCache = null;
function loadData() {
  if (_dataCache) return _dataCache;
  ensureDir();
  if (!fs.existsSync(PT_FILE)) {
    const init = { capital: parseFloat(process.env.ORB_LIVE_CAPITAL || process.env.ORB_PAPER_CAPITAL || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(init, null, 2));
    _dataCache = init; return init;
  }
  try { _dataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error("[orb-live] orb_live_trades.json corrupt — resetting:", e.message);
    _dataCache = { capital: parseFloat(process.env.ORB_LIVE_CAPITAL || process.env.ORB_PAPER_CAPITAL || "100000"), totalPnl: 0, sessions: [] };
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

let state = _freshState();
function _freshState() {
  return {
    running: false, sessionStart: null, sessionTrades: [], sessionPnl: 0, tradesTaken: 0,
    candles: [], currentBar: null, barStartTime: null,
    tickCount: 0, lastTickTime: null, lastTickPrice: null,
    position: null, optionLtp: null, optionLtpUpdatedAt: null,
    log: [], _sessionId: null, _expiryDayBlocked: false,
  };
}

function log(msg) {
  const stamp = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  const line = `[${stamp}] ${msg}`;
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
  console.log(line);
}
function istNow() { return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }); }

function isDryRun() {
  return (process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() === "true";
}

let _optionPollTimer = null;
function startOptionPolling() {
  stopOptionPolling();
  _optionPollTimer = setInterval(async () => {
    if (!state.position) return;
    try {
      const r = await fyers.getQuotes([state.position.symbol]);
      if (r && r.s === "ok" && r.d && r.d.length) {
        const ltp = r.d[0].v && (r.d[0].v.lp || r.d[0].v.ltp);
        if (typeof ltp === "number" && ltp > 0) {
          state.optionLtp = ltp;
          state.optionLtpUpdatedAt = Date.now();
        }
      }
    } catch (_) {}
  }, 3000);
}
function stopOptionPolling() { if (_optionPollTimer) { clearInterval(_optionPollTimer); _optionPollTimer = null; } }

// ── Live BUY ────────────────────────────────────────────────────────────────
async function placeLiveBuy(side, sigSnapshot) {
  const spot = state.lastTickPrice;
  if (!spot || !side) return;

  let optInfo;
  try { optInfo = await instrumentConfig.validateAndGetOptionSymbol(spot, side, "ORB"); }
  catch (e) { log(`❌ Symbol resolve failed: ${e.message}`); return; }
  if (!optInfo || optInfo.invalid) { log(`❌ No valid expiry — skip ${side} entry`); return; }

  // Fetch current option LTP for entry premium reference
  let optionEntryLtp = null;
  try {
    const r = await fyers.getQuotes([optInfo.symbol]);
    if (r && r.s === "ok" && r.d && r.d.length) {
      const ltp = r.d[0].v && (r.d[0].v.lp || r.d[0].v.ltp);
      if (typeof ltp === "number" && ltp > 0) optionEntryLtp = ltp;
    }
  } catch (_) {}
  if (!optionEntryLtp) { log(`❌ Option LTP unavailable — entry blocked`); return; }

  const qty = instrumentConfig.getLotQty();

  // ── BROKER CALL ──────────────────────────────────────────────────────────
  let entryOrderId = null;
  if (isDryRun()) {
    log(`🟡 [ORB-LIVE DRY-RUN] WOULD place BUY ${side} ${qty} × ${optInfo.symbol} @ market (ref ₹${optionEntryLtp})`);
    entryOrderId = `dryrun:${Date.now()}`;
  } else {
    try {
      const ord = await fyersBroker.placeMarketOrder(optInfo.symbol, 1, qty, "ORB-LIVE", { isFutures: false });
      if (!ord || !ord.success) {
        log(`❌ [ORB-LIVE] BUY order failed: ${JSON.stringify(ord)}`);
        return;
      }
      entryOrderId = ord.orderId;
      log(`🟢 [ORB-LIVE] BUY order placed — orderId=${entryOrderId}`);
    } catch (e) {
      log(`❌ [ORB-LIVE] BUY order threw: ${e.message}`);
      return;
    }
  }

  const pos = {
    side, symbol: optInfo.symbol, optionStrike: optInfo.strike, optionExpiry: optInfo.expiry,
    qty, entrySpot: spot, entryPrice: spot, optionEntryLtp,
    entryTime: istNow(), entryTimeMs: Date.now(),
    orh: sigSnapshot.orh, orl: sigSnapshot.orl, rangePts: sigSnapshot.rangePts,
    targetSpot: sigSnapshot.targetSpot, initialSlSpot: sigSnapshot.slSpot, slSpot: sigSnapshot.slSpot,
    targetPremium: parseFloat((optionEntryLtp * (1 + parseFloat(process.env.ORB_TARGET_PCT || "0.5"))).toFixed(2)),
    stopPremium:   parseFloat((optionEntryLtp * (1 - parseFloat(process.env.ORB_STOP_PCT   || "0.3"))).toFixed(2)),
    peakPremium: optionEntryLtp, movedToBE: false,
    signalStrength: sigSnapshot.signalStrength, vixAtEntry: getCachedVix(),
    entryReason: sigSnapshot.reason, entryOrderId,
  };
  state.position = pos;
  state.optionLtp = optionEntryLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;
  startOptionPolling();

  notifyEntry({
    mode: isDryRun() ? "ORB-LIVE (DRY-RUN)" : "ORB-LIVE",
    side, symbol: optInfo.symbol,
    spotAtEntry: spot, optionEntryLtp,
    qty, stopLoss: pos.slSpot,
    entryTime: pos.entryTime, entryReason: pos.entryReason,
  });
}

// ── Live SELL / SQUARE-OFF ─────────────────────────────────────────────────
async function placeLiveSell(reason) {
  if (!state.position) return;
  const pos = state.position;
  const exitOptLtp = state.optionLtp || pos.optionEntryLtp;
  const exitSpot   = state.lastTickPrice || pos.entrySpot;
  const qty = pos.qty;

  let exitOrderId = null;
  if (isDryRun()) {
    log(`🟡 [ORB-LIVE DRY-RUN] WOULD place SELL ${qty} × ${pos.symbol} @ market (ref ₹${exitOptLtp}) — reason: ${reason}`);
    exitOrderId = `dryrun:${Date.now()}`;
  } else {
    try {
      const ord = await fyersBroker.placeMarketOrder(pos.symbol, -1, qty, "ORB-LIVE-X", { isFutures: false });
      if (!ord || !ord.success) {
        log(`❌ [ORB-LIVE] SELL order failed: ${JSON.stringify(ord)}`);
      } else {
        exitOrderId = ord.orderId;
        log(`🔴 [ORB-LIVE] SELL order placed — orderId=${exitOrderId}`);
      }
    } catch (e) {
      log(`❌ [ORB-LIVE] SELL order threw: ${e.message}`);
    }
  }

  const charges = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitOptLtp, qty });
  const pnl = parseFloat(((exitOptLtp - pos.optionEntryLtp) * qty - charges).toFixed(2));
  state.sessionPnl = parseFloat((state.sessionPnl + pnl).toFixed(2));

  const trade = {
    side: pos.side, symbol: pos.symbol, qty,
    entryPrice: pos.entrySpot, exitPrice: exitSpot,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    optionEntryLtp: pos.optionEntryLtp, optionExitLtp: exitOptLtp,
    entryTime: pos.entryTime, exitTime: istNow(),
    pnl, pnlMode: `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp}`,
    exitReason: reason, entryReason: pos.entryReason,
    stopLoss: pos.slSpot, initialStopLoss: pos.initialSlSpot,
    optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry, optionType: pos.side,
    signalStrength: pos.signalStrength, vixAtEntry: pos.vixAtEntry,
    rangePts: pos.rangePts, orh: pos.orh, orl: pos.orl, targetSpot: pos.targetSpot,
    durationMs: Date.now() - pos.entryTimeMs, charges,
    entryOrderId: pos.entryOrderId, exitOrderId,
    isLive: !isDryRun(), isDryRun: isDryRun(),
    instrument: "NIFTY_OPTIONS",
  };
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog("orb", Object.assign({ _live: true }, trade));

  notifyExit({
    mode: isDryRun() ? "ORB-LIVE (DRY-RUN)" : "ORB-LIVE",
    side: pos.side, symbol: pos.symbol,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    optionEntryLtp: pos.optionEntryLtp, optionExitLtp: exitOptLtp,
    pnl, sessionPnl: state.sessionPnl,
    exitReason: reason, entryTime: pos.entryTime, exitTime: trade.exitTime, qty,
  });

  state.position = null;
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;
  stopOptionPolling();
}

// ── In-position tick management (mirrors paper logic) ──────────────────────
function _checkExits(spotPrice) {
  if (!state.position) return;
  const pos = state.position;
  const optLtp = state.optionLtp || pos.optionEntryLtp;
  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;

  const moveInFavour = pos.side === "CE" ? (spotPrice - pos.entrySpot) : (pos.entrySpot - spotPrice);
  if (!pos.movedToBE && moveInFavour >= pos.rangePts) {
    pos.movedToBE = true;
    const newSL = pos.side === "CE" ? Math.max(pos.slSpot, pos.entrySpot) : Math.min(pos.slSpot, pos.entrySpot);
    if (newSL !== pos.slSpot) { log(`📐 Move-to-BE: SL ${pos.slSpot} → ${newSL}`); pos.slSpot = newSL; }
  }
  if (optLtp <= pos.stopPremium) return placeLiveSell(`Premium SL hit (₹${optLtp} <= ₹${pos.stopPremium})`);
  if (optLtp >= pos.targetPremium) return placeLiveSell(`Premium target (₹${optLtp} >= ₹${pos.targetPremium})`);
  if (pos.side === "CE" && spotPrice <= pos.slSpot) return placeLiveSell(`Spot SL hit (${spotPrice} <= ORL ${pos.slSpot})`);
  if (pos.side === "PE" && spotPrice >= pos.slSpot) return placeLiveSell(`Spot SL hit (${spotPrice} >= ORH ${pos.slSpot})`);
  if (pos.side === "CE" && spotPrice >= pos.targetSpot) return placeLiveSell(`Spot target hit (${spotPrice} >= ${pos.targetSpot})`);
  if (pos.side === "PE" && spotPrice <= pos.targetSpot) return placeLiveSell(`Spot target hit (${spotPrice} <= ${pos.targetSpot})`);
}

async function onCandleClose(bar) {
  if (state.position) return;
  const _spot = bar && bar.close;
  const maxLoss = parseFloat(process.env.ORB_MAX_DAILY_LOSS || "3000");
  if (state.sessionPnl <= -maxLoss) { skipLogger.appendSkipLog("orb", { gate: "daily_loss", reason: `sessionPnl ${state.sessionPnl} <= -${maxLoss}`, spot: _spot, _live: true }); return; }
  const maxTrades = parseInt(process.env.ORB_MAX_DAILY_TRADES || "1", 10);
  if (state.tradesTaken >= maxTrades) return;
  if (state._expiryDayBlocked) return;

  const sig = orbStrategy.getSignal(state.candles, { alreadyTraded: state.tradesTaken >= maxTrades });
  if (sig.signal === "NONE" || !sig.side) {
    if (sig.orh != null && sig.orl != null) skipLogger.appendSkipLog("orb", { gate: "signal_none", reason: sig.reason, spot: _spot, orh: sig.orh, orl: sig.orl, rangePts: sig.rangePts, _live: true });
    return;
  }

  if ((process.env.ORB_VIX_ENABLED || "false").toLowerCase() === "true") {
    const vixCheck = await checkLiveVix(sig.signalStrength, { mode: "orb" });
    if (!vixCheck.allowed) {
      log(`⏸️ VIX gate: ${vixCheck.reason}`);
      skipLogger.appendSkipLog("orb", { gate: "vix", reason: vixCheck.reason, spot: _spot, vix: vixCheck.vix, _live: true });
      return;
    }
  }
  await placeLiveBuy(sig.side, sig);
}

function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (!price || price <= 0) return;
  state.tickCount++;
  state.lastTickTime = Date.now();
  state.lastTickPrice = price;

  const bucketMs = getBucketStart(Date.now(), RES_MIN);
  if (!state.currentBar || state.barStartTime !== bucketMs) {
    if (state.currentBar) {
      const last = state.candles.length ? state.candles[state.candles.length - 1] : null;
      if (last && last.time === state.currentBar.time) state.candles[state.candles.length - 1] = { ...state.currentBar };
      else state.candles.push({ ...state.currentBar });
      if (state.candles.length > 300) state.candles.shift();
      onCandleClose(state.currentBar).catch(e => console.error(`🚨 [ORB-LIVE] onCandleClose: ${e.message}`));
    }
    const bucketSec = Math.floor(bucketMs / 1000);
    const lastPre = state.candles.length ? state.candles[state.candles.length - 1] : null;
    if (lastPre && lastPre.time === bucketSec) { state.currentBar = state.candles.pop(); state.currentBar.high = Math.max(state.currentBar.high, price); state.currentBar.low = Math.min(state.currentBar.low, price); state.currentBar.close = price; }
    else state.currentBar = { time: bucketSec, open: price, high: price, low: price, close: price };
    state.barStartTime = bucketMs;
  } else {
    state.currentBar.high = Math.max(state.currentBar.high, price);
    state.currentBar.low  = Math.min(state.currentBar.low,  price);
    state.currentBar.close = price;
  }
  if (state.position) _checkExits(price);
  if (state.position) {
    const stopMin = (function() { const raw = process.env.ORB_FORCED_EXIT || "15:15"; const [h, m] = raw.split(":").map(Number); return h * 60 + (isNaN(m) ? 0 : m); })();
    if (getISTMinutes() >= stopMin) placeLiveSell(`EOD square-off (${process.env.ORB_FORCED_EXIT || "15:15"} IST)`);
  }
}

async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { fetchCandles } = require("../services/backtestEngine");
    const istToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const from = Math.floor(new Date(istToday + "T03:45:00.000Z").getTime() / 1000);
    const to   = Math.floor(Date.now() / 1000);
    const candles = await fetchCandlesCached(NIFTY_INDEX_SYMBOL, RES_MIN, from, to, fetchCandles);
    if (Array.isArray(candles) && candles.length) {
      state.candles = candles.slice(-200);
      log(`📊 Preloaded ${state.candles.length} × ${RES_MIN}-min spot candles`);
    }
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

// ── Routes ──────────────────────────────────────────────────────────────────

router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/orb-live/status");
  if ((process.env.ORB_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("ORB Mode Disabled", "Enable ORB Mode in Settings first", "/settings", "Go to Settings"));
  }
  if ((process.env.ORB_LIVE_ENABLED || "false").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("ORB Live Disabled", "Set ORB_LIVE_ENABLED=true in Settings to allow live trading.", "/settings", "Go to Settings"));
  }
  const check = sharedSocketState.canStart("ORB_LIVE");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/orb-live/status", "← Back"));
  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));
  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/orb-live/status", "← Back"));

  let _expiryBlocked = false;
  if ((process.env.ORB_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
    const { isExpiryDay } = require("../utils/nseHolidays");
    const isExpiry = await isExpiryDay();
    _expiryBlocked = !isExpiry;
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `orb-live:${Date.now()}`;
  state._expiryDayBlocked = _expiryBlocked;

  // Register ORB_LIVE in sharedSocketState — extend canStart if not present
  if (typeof sharedSocketState.setOrbActive === "function") sharedSocketState.setOrbActive("ORB_LIVE");

  await preloadHistory();
  if ((process.env.ORB_VIX_ENABLED || "false").toLowerCase() === "true") {
    resetVixCache();
    fetchLiveVix({ force: true }).catch(() => {});
  }
  if (socketManager.isRunning()) socketManager.addCallback(CALLBACK_ID, onTick, log);
  else { socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log); socketManager.addCallback(CALLBACK_ID, onTick, log); }
  scheduleAutoStop();
  const dryStr = isDryRun() ? "DRY-RUN" : "🚨 REAL ORDERS";
  log(`🟢 [ORB-LIVE ${dryStr}] Session started`);
  notifyStarted({
    mode: `ORB-LIVE ${isDryRun() ? "(DRY-RUN)" : ""}`,
    text: `📡 ORB LIVE STARTED ${dryStr}\n📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}\nStrategy: ${orbStrategy.NAME}`,
  });
  res.redirect("/orb-live/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) placeLiveSell("Session stopped");
  state.running = false;
  stopOptionPolling();
  socketManager.removeCallback(CALLBACK_ID);
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();
  if (typeof sharedSocketState.clearOrb === "function") sharedSocketState.clearOrb();
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  if (state.sessionTrades.length) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: orbStrategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades, isLive: !isDryRun() });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      saveData(data);
      log(`💾 Session saved — ${state.sessionTrades.length} trades, PnL ₹${state.sessionPnl}`);
    } catch (e) { log(`⚠️ Save failed: ${e.message}`); }
  }
  log("🔴 Session stopped");
  notifyDayReport({ mode: `ORB-LIVE ${isDryRun() ? "(DRY-RUN)" : ""}`, sessionTrades: state.sessionTrades, sessionPnl: state.sessionPnl, sessionStart: state.sessionStart });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/orb-live/status"); });
router.get("/exit", (req, res) => { if (state.position) placeLiveSell("Manual exit"); res.redirect("/orb-live/status"); });

router.post("/manualEntry", async (req, res) => {
  if (!state.running) return res.status(400).json({ success: false, error: "ORB live is not running." });
  if (state.position) return res.status(400).json({ success: false, error: "Already in a position. Exit first." });
  const { side } = req.body || {};
  if (side !== "CE" && side !== "PE") return res.status(400).json({ success: false, error: "Side must be CE or PE." });
  const spot = state.lastTickPrice || (state.currentBar ? state.currentBar.close : null);
  if (!spot) return res.status(400).json({ success: false, error: "No market data yet." });
  let or = null;
  try { or = orbStrategy.computeOpeningRange(state.candles); } catch (_) {}
  const rangePts = or ? Math.round((or.high - or.low) * 100) / 100 : 50;
  const orh = or ? or.high : spot + 25;
  const orl = or ? or.low : spot - 25;
  const slSpot = side === "CE" ? orl : orh;
  const tgtMult = parseFloat(process.env.ORB_TARGET_RANGE_MULT || "1.5");
  const targetSpot = side === "CE" ? orh + rangePts * tgtMult : orl - rangePts * tgtMult;
  const sig = { signal: side === "CE" ? "BUY_CE" : "BUY_PE", side, orh, orl, rangePts, entrySpot: spot, slSpot, targetSpot, signalStrength: "MANUAL", reason: `🖐️ MANUAL ${side} entry @ spot ₹${spot}` };
  log(`🖐️ MANUAL ${side} entry triggered by user`);
  try { await placeLiveBuy(side, sig); return res.json({ success: true, side, spot, slSpot, targetSpot }); }
  catch (e) { log(`❌ Manual entry failed: ${e.message}`); return res.status(500).json({ success: false, error: e.message }); }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const data = loadData();
  let or = null;
  try { or = orbStrategy.computeOpeningRange(state.candles); } catch (_) {}
  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * (pos.qty || instrumentConfig.getLotQty())).toFixed(2));
  }
  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) }); }
  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  res.json({
    running: state.running, dryRun: isDryRun(),
    sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-100),
    tickCount: state.tickCount, lastTickPrice: state.lastTickPrice, candles: state.candles.length,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge,
    vix: getCachedVix(),
    orh: or && or.high, orl: or && or.low, rangePts: or ? Math.round((or.high - or.low) * 100) / 100 : null,
    wins, losses, winRate, cumPnl, livePnl,
    position: pos ? Object.assign({}, pos, { currentOptLtp: state.optionLtp }) : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

router.get("/status/chart-data", (req, res) => {
  try {
    const candles = state.candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.currentBar) candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });
    let orhLine = [], orlLine = [];
    try {
      const or = orbStrategy.computeOpeningRange(state.candles);
      if (or && candles.length) {
        const ft = candles[0].time, tt = candles[candles.length - 1].time;
        orhLine = [{ time: ft, value: or.high }, { time: tt, value: or.high }];
        orlLine = [{ time: ft, value: or.low },  { time: tt, value: or.low }];
      }
    } catch (_) {}
    const markers = [];
    for (const t of state.sessionTrades) {
      if (t.spotAtEntry != null) { const c = candles.find(c => Math.abs(c.close - t.spotAtEntry) < 1) || candles[0]; if (c) markers.push({ time: c.time, position: 'belowBar', color: '#3b82f6', shape: 'arrowUp', text: t.side + ' @ ' + t.spotAtEntry }); }
      if (t.spotAtExit != null)  { const c = candles.find(c => Math.abs(c.close - t.spotAtExit)  < 1) || candles[candles.length - 1]; if (c) markers.push({ time: c.time, position: 'aboveBar', color: t.pnl >= 0 ? '#10b981' : '#ef4444', shape: 'arrowDown', text: 'Exit ' + (t.pnl >= 0 ? '+' : '') + Math.round(t.pnl || 0) }); }
    }
    res.json({ candles, markers, orhLine, orlLine, stopLoss: state.position && state.position.slSpot, entryPrice: state.position && state.position.entrySpot, target: state.position && state.position.targetSpot });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const dry = isDryRun();
  res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
${faviconLink()}
<title>ORB Live Trade</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;}
${sidebarCSS()}
${modalCSS()}
.main-content{flex:1;padding:16px 22px 40px;min-height:100vh;}
@media(max-width:900px){.main-content{margin-left:0;padding:14px;}}
.crumb{background:#06090e;border-bottom:0.5px solid #0e1428;padding:6px 22px;display:flex;align-items:center;gap:7px;margin:-16px -22px 14px;position:sticky;top:0;z-index:90;}
.chip{font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;text-transform:uppercase;letter-spacing:0.5px;font-family:'IBM Plex Mono',monospace;}
.page-title{font-size:1.05rem;font-weight:700;margin-bottom:2px;}
.page-sub{font-size:0.7rem;color:#4a6080;margin-bottom:14px;}
.banner{background:${dry ? "rgba(245,158,11,0.12)" : "rgba(239,68,68,0.12)"};border:1px solid ${dry ? "rgba(245,158,11,0.4)" : "rgba(239,68,68,0.4)"};border-radius:8px;padding:8px 14px;margin-bottom:14px;color:${dry ? "#fbbf24" : "#ef4444"};font-size:0.72rem;font-weight:700;}
.grid{display:grid;grid-template-columns:repeat(8,1fr);gap:10px;margin-bottom:14px;}
@media(max-width:1400px){.grid{grid-template-columns:repeat(4,1fr);}}
@media(max-width:700px){.grid{grid-template-columns:repeat(2,1fr);}}
.sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:11px 13px;position:relative;overflow:hidden;}
.sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:#ef4444;}
.sc-label{font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:4px;font-family:'IBM Plex Mono',monospace;}
.sc-val{font-size:1.1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
.sc-sub{font-size:0.6rem;color:#4a6080;margin-top:3px;font-family:'IBM Plex Mono',monospace;}
.panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;margin-bottom:14px;}
.panel h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.4px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
.chart-wrap{position:relative;height:240px;}
.log{background:#040c18;border:0.5px solid #0e1e36;border-radius:6px;padding:8px 10px;font-family:'IBM Plex Mono',monospace;font-size:0.65rem;color:#94a3b8;max-height:280px;overflow-y:auto;white-space:pre-wrap;line-height:1.55;}
table{width:100%;border-collapse:collapse;font-size:0.66rem;font-family:'IBM Plex Mono',monospace;}
th,td{padding:6px 8px;text-align:left;border-bottom:0.5px solid #0e1e36;}
th{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;background:#040c18;}
.pos{color:#10b981;}.neg{color:#ef4444;}.muted{color:#3a5070;}
.empty{text-align:center;color:#3a5070;padding:18px 0;font-size:0.7rem;}
</style></head><body>
<div class="app-shell">
${buildSidebar('orbLive', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/orb-live/start'`, startLabel: '▶ Start ORB Live',
  showStopBtn: state.running,   stopBtnJs:  `location.href='/orb-live/stop'`,  stopLabel:  '■ Stop ORB Live',
  showExitBtn: state.running && !!state.position, exitBtnJs: `location.href='/orb-live/exit'`, exitLabel: '🚪 Exit Trade',
})}
<main class="main-content">
  <div class="crumb">
    <span class="chip" style="background:rgba(239,68,68,0.1);color:#ef4444;border:0.5px solid rgba(239,68,68,0.3);">📡 ORB LIVE</span>
    <span style="color:#1e2a40;font-size:10px;">›</span>
    <span class="chip" style="background:rgba(245,158,11,0.1);color:#fbbf24;border:0.5px solid rgba(245,158,11,0.2);">${orbStrategy.NAME}</span>
    <span style="color:#1e2a40;font-size:10px;">›</span>
    <span class="chip" id="crumb-status" style="background:rgba(74,96,128,0.15);color:#94a3b8;border:0.5px solid rgba(74,96,128,0.3);">—</span>
    <span style="margin-left:auto;font-size:0.6rem;color:#1e2a40;font-family:'IBM Plex Mono',monospace;" id="crumb-tick">— ticks</span>
  </div>
  <div class="banner">${dry ? "⚠️ DRY-RUN MODE — Orders are logged but NOT placed at broker. Flip LIVE_HARNESS_DRY_RUN=false in Settings to enable real orders." : "🚨 LIVE MODE — Real broker orders are being placed at Fyers. Confirm intentional."}</div>
  <div class="page-title">📡 ORB Live Trade ${dry ? "<span style='color:#fbbf24;'>(DRY-RUN)</span>" : ""}</div>
  <div class="page-sub">${orbStrategy.NAME} — opening range breakout · ${dry ? "decisions only" : "real Fyers orders"}</div>

  <div class="grid">
    <div class="sc"><div class="sc-label">Status</div><div class="sc-val" id="status">—</div><div class="sc-sub" id="status-sub">—</div></div>
    <div class="sc"><div class="sc-label">Session P&L</div><div class="sc-val" id="pnl">—</div><div class="sc-sub" id="pnl-sub">— trades</div></div>
    <div class="sc"><div class="sc-label">Live PnL</div><div class="sc-val" id="livePnl">—</div><div class="sc-sub">unrealised</div></div>
    <div class="sc"><div class="sc-label">Win Rate</div><div class="sc-val" id="wr">—</div><div class="sc-sub" id="wr-sub">— W · — L</div></div>
    <div class="sc"><div class="sc-label">Spot · VIX</div><div class="sc-val" id="spotVix">—</div><div class="sc-sub" id="orRange">—</div></div>
    <div class="sc"><div class="sc-label">All-Time</div><div class="sc-val" id="totalPnl">—</div><div class="sc-sub">live + dry-run</div></div>
    <div class="sc"><div class="sc-label">Mode</div><div class="sc-val">${dry ? '<span style="color:#fbbf24;">DRY-RUN</span>' : '<span style="color:#ef4444;">LIVE</span>'}</div><div class="sc-sub">${dry ? "no orders" : "real orders"}</div></div>
    <div class="sc"><div class="sc-label">Strategy</div><div class="sc-val" style="font-size:0.8rem;">${orbStrategy.NAME}</div><div class="sc-sub">15-min OR · 5-min confirm</div></div>
  </div>

  <div class="panel"><h3>📌 Open Position</h3><div id="position-box" class="empty">No open position</div>
    <div id="manual-entry" style="display:none;margin-top:10px;text-align:right;">
      <button onclick="doManualEntry('CE')" style="background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.4);padding:6px 14px;border-radius:5px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;margin-right:8px;">🟢 Manual CE Entry</button>
      <button onclick="doManualEntry('PE')" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.4);padding:6px 14px;border-radius:5px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">🔴 Manual PE Entry</button>
    </div>
  </div>
  <div class="panel"><h3>📊 Live NIFTY 5-min</h3><div id="niftyChart" style="height:340px;"></div></div>
  <div class="panel"><h3>📈 Cumulative P&amp;L</h3><div class="chart-wrap"><canvas id="pnlChart"></canvas></div></div>
  <div class="panel"><h3>📜 Session Trades</h3><div id="trades-box" class="empty">No trades yet</div></div>
  <div class="panel"><h3>📓 Activity Log</h3><div id="log" class="log">—</div></div>
</main>
</div>

<script>
${modalJS()}
var _pnlChart = null, _niftyChart = null, _csSeries = null, _orhSeries = null, _orlSeries = null;
function ensureChart(){
  if (_niftyChart) return;
  var container = document.getElementById('niftyChart');
  if (!container || typeof LightweightCharts === 'undefined') return;
  _niftyChart = LightweightCharts.createChart(container, { layout:{ background:{color:'transparent'}, textColor:'#94a3b8' }, grid:{vertLines:{color:'#0e1e36'},horzLines:{color:'#0e1e36'}}, timeScale:{timeVisible:true,secondsVisible:false,borderColor:'#0e1e36'}, rightPriceScale:{borderColor:'#0e1e36'}, width:container.clientWidth, height:340 });
  _csSeries = _niftyChart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  _orhSeries = _niftyChart.addLineSeries({ color:'#10b981', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  _orlSeries = _niftyChart.addLineSeries({ color:'#ef4444', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  window.addEventListener('resize', function(){ if(_niftyChart) _niftyChart.applyOptions({ width: container.clientWidth }); });
}
async function refreshChart(){
  ensureChart(); if (!_csSeries) return;
  try {
    var r = await fetch('/orb-live/status/chart-data', { cache:'no-store' });
    var d = await r.json();
    if (d.candles && d.candles.length) _csSeries.setData(d.candles);
    _orhSeries.setData(d.orhLine || []);
    _orlSeries.setData(d.orlLine || []);
    if (d.markers) _csSeries.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
  } catch (e) {}
}
async function refresh(){
  try {
    var d = await (await fetch('/orb-live/status/data', { cache:'no-store' })).json();
    var pnlCls = d.sessionPnl > 0 ? 'pos' : d.sessionPnl < 0 ? 'neg' : 'muted';
    document.getElementById('status').innerHTML = d.running ? '<span class="pos">RUNNING</span>' : '<span class="muted">STOPPED</span>';
    document.getElementById('status-sub').textContent = d.tradesTaken + ' trades';
    document.getElementById('crumb-status').innerHTML = d.running ? '<span style="color:#10b981;">● RUNNING</span>' : '<span style="color:#94a3b8;">○ STOPPED</span>';
    document.getElementById('crumb-tick').textContent = (d.tickCount||0) + ' ticks · ' + (d.candles||0) + ' candles';
    document.getElementById('pnl').innerHTML = '<span class="' + pnlCls + '">₹' + d.sessionPnl.toFixed(2) + '</span>';
    document.getElementById('pnl-sub').textContent = (d.tradesTaken||0) + ' closed';
    if (d.livePnl != null) { var lc = d.livePnl > 0 ? 'pos' : d.livePnl < 0 ? 'neg' : 'muted'; document.getElementById('livePnl').innerHTML = '<span class="' + lc + '">₹' + d.livePnl.toFixed(2) + '</span>'; } else { document.getElementById('livePnl').textContent = '—'; }
    document.getElementById('wr').textContent = d.winRate != null ? d.winRate + '%' : '—';
    document.getElementById('wr-sub').textContent = (d.wins||0) + 'W · ' + (d.losses||0) + 'L';
    document.getElementById('spotVix').textContent = (d.lastTickPrice ? d.lastTickPrice.toFixed(2) : '—') + ' · VIX ' + (d.vix != null ? d.vix.toFixed(1) : '—');
    document.getElementById('orRange').textContent = (d.orh && d.orl) ? 'OR ' + d.orh + '/' + d.orl + ' (' + d.rangePts + 'pt)' : 'OR pending';
    document.getElementById('totalPnl').innerHTML = '<span class="' + (d.totalPnl>=0?'pos':'neg') + '">₹' + (d.totalPnl||0).toLocaleString('en-IN', {maximumFractionDigits:0}) + '</span>';
    document.getElementById('log').textContent = (d.log || []).join('\\n');

    if (d.position) {
      var p = d.position;
      document.getElementById('manual-entry').style.display = 'none';
      document.getElementById('position-box').className = '';
      document.getElementById('position-box').innerHTML = '<table><tr><th>Side</th><th>Symbol</th><th>E.Spot</th><th>E.Opt</th><th>Cur.Opt</th><th>SL</th><th>Target</th><th>Qty</th><th>OrderID</th></tr>' +
        '<tr><td class="' + (p.side==='CE'?'pos':'neg') + '"><b>' + p.side + '</b></td><td>' + p.symbol + '</td><td>' + p.entrySpot + '</td><td>₹' + p.optionEntryLtp + '</td><td>₹' + (p.currentOptLtp||p.optionEntryLtp) + '</td><td>' + p.slSpot + '</td><td>' + p.targetSpot + '</td><td>' + p.qty + '</td><td style="font-size:0.6rem;">' + (p.entryOrderId||'—') + '</td></tr></table>';
    } else {
      document.getElementById('position-box').className = 'empty';
      document.getElementById('position-box').textContent = d.running ? 'No open position — waiting for ORB break' : 'No open position';
      document.getElementById('manual-entry').style.display = d.running ? 'block' : 'none';
    }

    var trades = d.sessionTrades || [];
    if (trades.length) {
      var rows = trades.slice().reverse().map(function(t){ var cls = t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : 'muted'); return '<tr><td>' + (t.entryTime||'') + '</td><td>' + (t.exitTime||'') + '</td><td class="' + (t.side==='CE'?'pos':'neg') + '"><b>' + (t.side||'') + '</b></td><td>' + (t.spotAtEntry||'') + '</td><td>' + (t.spotAtExit||'') + '</td><td>₹' + (t.optionEntryLtp||'') + '</td><td>₹' + (t.optionExitLtp||'') + '</td><td class="' + cls + '"><b>₹' + (t.pnl != null ? t.pnl.toFixed(2) : '—') + '</b></td><td style="color:#94a3b8;font-size:0.65rem;">' + (t.exitReason||'') + '</td></tr>'; }).join('');
      document.getElementById('trades-box').className = '';
      document.getElementById('trades-box').innerHTML = '<table><tr><th>Entry</th><th>Exit</th><th>Side</th><th>E.Spot</th><th>X.Spot</th><th>E.Opt</th><th>X.Opt</th><th>PnL</th><th>Exit</th></tr>' + rows + '</table>';
    } else { document.getElementById('trades-box').className = 'empty'; document.getElementById('trades-box').textContent = 'No trades yet'; }

    renderPnlChart(d.cumPnl || []);
    refreshChart();
  } catch (e) {}
}
function renderPnlChart(points){
  var ctx = document.getElementById('pnlChart'); if (!ctx) return;
  if (_pnlChart) { _pnlChart.destroy(); _pnlChart = null; }
  var labels = points.map(function(_, i){ return i+1; });
  var data = points.map(function(p){ return p.pnl; });
  var col = (data.length && data[data.length-1] >= 0) ? '#10b981' : '#ef4444';
  _pnlChart = new Chart(ctx, { type:'line', data:{ labels:labels, datasets:[{ data:data, borderColor:col, borderWidth:2, backgroundColor:col+'22', fill:true, pointRadius:3, tension:0.3 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{ticks:{color:'#3a5070',font:{size:9}},grid:{display:false}}, y:{ticks:{color:'#3a5070',font:{size:9},callback:function(v){return '₹'+Math.round(v/1000)+'k';}},grid:{color:'#0e1e36'}} } } });
}
async function doManualEntry(side){
  if (!confirm('Place a MANUAL ' + side + ' entry${dry ? ' (DRY-RUN logged)' : ' (REAL ORDER)'} ?')) return;
  try {
    var r = await fetch('/orb-live/manualEntry', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ side:side }) });
    var j = await r.json();
    if (!j.success) { alert('Manual entry failed: ' + (j.error||'unknown')); return; }
    refresh();
  } catch (e) { alert('Manual entry error: ' + e.message); }
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

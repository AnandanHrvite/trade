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
const { scalpStyleCSS, scalpTopBar, scalpCapitalStrip, scalpStatGrid, scalpCurrentBar, scalpActivityLog } = require("../utils/scalpStyleUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter   = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const tradeLogger = require("../utils/tradeLogger");
const skipLogger  = require("../utils/skipLogger");
const fyers       = require("../config/fyers");
const fyersBroker = require("../services/fyersBroker");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { getISTMinutes, getBucketStart, fmtISTDateTime } = require("../utils/tradeUtils");

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
    currentBar: state.currentBar, sessionStart: state.sessionStart,
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

function _orbLiveCapital() {
  const v = parseFloat(process.env.ORB_LIVE_CAPITAL || process.env.ORB_PAPER_CAPITAL);
  return isNaN(v) ? 100000 : v;
}

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const dry = isDryRun();
  const data = loadData();
  const pos  = state.position;

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  let or = null; try { or = orbStrategy.computeOpeningRange(state.candles); } catch (_) {}
  const _vix = getCachedVix();
  const _vixEnabled = (process.env.ORB_VIX_ENABLED || "false").toLowerCase() === "true";
  const _vixMaxEntry = vixFilter.getVixMaxEntry("orb");
  const _maxTrades = parseInt(process.env.ORB_MAX_DAILY_TRADES || "1", 10);
  const _maxLoss   = parseFloat(process.env.ORB_MAX_DAILY_LOSS || "3000");
  const _forcedExit = process.env.ORB_FORCED_EXIT || "15:15";
  const _orStart = process.env.ORB_RANGE_START || "09:15";
  const _orEnd   = process.env.ORB_RANGE_END   || "09:30";
  const dailyLossHit = state.sessionPnl <= -_maxLoss;

  const pnlColor = (n) => (n || 0) >= 0 ? "#10b981" : "#ef4444";

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * (pos.qty || instrumentConfig.getLotQty())).toFixed(2));
  }

  const statCards = [
    {
      label: "Session PnL",
      value: `<span id="ajax-session-pnl" style="color:${pnlColor(state.sessionPnl)};">${typeof state.sessionPnl === "number" ? (state.sessionPnl >= 0 ? "+" : "") + "₹" + state.sessionPnl.toLocaleString("en-IN", {minimumFractionDigits:2, maximumFractionDigits:2}) : "—"}</span>`,
      accent: pnlColor(state.sessionPnl),
    },
    {
      label: "Trades Today",
      value: `<span id="ajax-trade-count">${state.tradesTaken || 0}</span> <span style="font-size:0.75rem;color:#4a6080;">/ ${_maxTrades}</span>`,
      sub: `<span id="ajax-wl">${wins}W · ${losses}L</span>`,
      accent: dry ? "#fbbf24" : "#ef4444",
    },
    {
      label: "Live PnL",
      value: `<span id="ajax-live-pnl" style="color:${livePnl == null ? "#c8d8f0" : pnlColor(livePnl)};">${livePnl == null ? "—" : (livePnl >= 0 ? "+" : "") + "₹" + livePnl.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2})}</span>`,
      sub: `<span id="ajax-live-pnl-sub">${pos ? "unrealised" : "no open position"}</span>`,
      accent: "#3b82f6",
    },
    {
      label: "Win Rate",
      value: `<span id="ajax-wr">${winRate != null ? winRate + "%" : "—"}</span>`,
      sub: `<span id="ajax-wr-sub">${wins}W · ${losses}L</span>`,
      accent: "#a07010",
    },
    {
      label: "OR Range",
      value: `<span id="ajax-or-range">${or && or.high && or.low ? `${or.low}/${or.high}` : "—"}</span>`,
      sub: `<span id="ajax-or-sub" style="font-size:0.6rem;color:#4a6080;">${or && or.high && or.low ? `${(or.high-or.low).toFixed(1)} pts · ${_orStart}–${_orEnd}` : `${_orStart}–${_orEnd} IST`}</span>`,
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
      value: `<span id="ajax-candle-count" style="color:${state.candles.length >= 3 ? "#10b981" : "#f59e0b"};">${state.candles.length}</span>`,
      sub: `<span id="ajax-candle-status" style="color:${state.candles.length >= 3 ? "#10b981" : "#f59e0b"};">${state.candles.length >= 3 ? "OR ready" : "Warming up..."}</span>`,
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
          ${pos.entryOrderId ? `<span style="font-size:0.62rem;color:#94a3b8;font-family:monospace;">Order: ${pos.entryOrderId}</span>` : ""}
        </div>
        <button onclick="orblHandleExit(this)"
           style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;">
          Exit ${dry ? "(DRY)" : "Live"} Now
        </button>
      </div>

      <div style="background:#071a12;border:1px solid #134e35;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:2.2rem;font-weight:900;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side}</span>
            <div>
              <div style="font-size:0.72rem;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side === "CE" ? "CALL · Bullish" : "PUT · Bearish"}</div>
              <span style="font-size:0.65rem;font-weight:700;color:#94a3b8;">${pos.signalStrength || "ORB"}</span>
            </div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Strike</div>
            <div style="font-size:1.6rem;font-weight:800;color:#fff;font-family:monospace;">${pos.optionStrike || "—"}</div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Qty</div>
            <div style="font-size:1.1rem;font-weight:700;color:#fff;">${pos.qty}</div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;flex-shrink:0;"></div>
          <div style="flex:1;min-width:200px;">
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Full Symbol</div>
            <div style="font-size:0.82rem;font-weight:600;color:#c8d8f0;font-family:monospace;word-break:break-all;">${pos.symbol}</div>
          </div>
        </div>
      </div>

      <div style="background:#0a0f24;border:2px solid #3b82f6;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
        <div style="font-size:0.68rem;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Option Premium</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">
          <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid #1e3a5f;border-radius:10px;">
            <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Entry Price</div>
            <div id="ajax-opt-entry-ltp" style="font-size:2rem;font-weight:800;color:#60a5fa;font-family:monospace;line-height:1;">₹${pos.optionEntryLtp ? pos.optionEntryLtp.toFixed(2) : "—"}</div>
          </div>
          <div style="text-align:center;font-size:1.8rem;color:${optMove != null ? (optMove >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};">→</div>
          <div style="text-align:center;padding:12px;background:${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#071a0f" : "#1a0707") : "#0d1320"};border:2px solid ${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};border-radius:10px;">
            <div style="font-size:0.63rem;color:${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#10b981" : "#ef4444") : "#4a6080"};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Current LTP</div>
            <div id="ajax-opt-current-ltp" style="font-size:2rem;font-weight:800;color:${liveOpt != null ? (liveOpt >= pos.optionEntryLtp ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">${liveOpt != null ? "₹" + liveOpt.toFixed(2) : "⏳"}</div>
            <div id="ajax-opt-move" style="font-size:0.72rem;font-weight:700;margin-top:6px;color:${optMove != null ? (optMove >= 0 ? "#10b981" : "#ef4444") : "#f59e0b"};">${optMove != null ? (optMove >= 0 ? "▲ +" : "▼ ") + "₹" + Math.abs(optMove).toFixed(2) : "⏳"}</div>
            <div id="ajax-opt-pct" style="font-size:1.1rem;font-weight:800;margin-top:4px;color:${optMovePct != null ? (optMovePct >= 0 ? "#10b981" : "#ef4444") : "#4a6080"};font-family:monospace;">${optMovePct != null ? (optMovePct >= 0 ? "+" : "") + optMovePct.toFixed(2) + "%" : "—"}</div>
          </div>
          <div style="text-align:center;padding:12px;background:${livePnl != null ? (livePnl >= 0 ? "#071a0f" : "#1a0707") : "#0d1320"};border:1px solid ${livePnl != null ? (livePnl >= 0 ? "#065f46" : "#7f1d1d") : "#1a2236"};border-radius:10px;">
            <div style="font-size:0.63rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Unrealised P&L</div>
            <div id="ajax-opt-pnl" style="font-size:1.8rem;font-weight:800;color:${livePnl != null ? (livePnl >= 0 ? "#10b981" : "#ef4444") : "#fff"};font-family:monospace;line-height:1;">${livePnl != null ? (livePnl >= 0 ? "+" : "") + "₹" + livePnl.toLocaleString("en-IN", {minimumFractionDigits:2,maximumFractionDigits:2}) : "—"}</div>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;">
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY @ Entry</div>
          <div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">₹${pos.entrySpot ? pos.entrySpot.toFixed(2) : "—"}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">NIFTY LTP</div>
          <div id="ajax-nifty-ltp" style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${state.lastTickPrice ? "₹" + state.lastTickPrice.toFixed(2) : "—"}</div>
          <div id="ajax-nifty-move" style="font-size:0.63rem;color:${spotMove != null && spotMove >= 0 ? "#10b981" : "#ef4444"};margin-top:2px;">${spotMove != null ? (spotMove >= 0 ? "▲" : "▼") + " " + Math.abs(spotMove).toFixed(1) + " pts" : "—"}</div>
        </div>
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Spot SL</div>
          <div style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.slSpot ? "₹" + pos.slSpot.toFixed(2) : "—"}</div>
        </div>
        <div style="background:#0a1f12;border:1px solid #0d4030;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Spot Target</div>
          <div style="font-size:1.05rem;font-weight:700;color:#10b981;">${pos.targetSpot ? "₹" + pos.targetSpot.toFixed(2) : "—"}</div>
        </div>
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Premium Stop</div>
          <div style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.stopPremium ? "₹" + pos.stopPremium.toFixed(2) : "—"}</div>
        </div>
        <div style="background:#0a1f12;border:1px solid #0d4030;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Premium Target</div>
          <div style="font-size:1.05rem;font-weight:700;color:#10b981;">${pos.targetPremium ? "₹" + pos.targetPremium.toFixed(2) : "—"}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">OR Range</div>
          <div style="font-size:0.95rem;font-weight:700;color:#c8d8f0;">${pos.orl || "—"}/${pos.orh || "—"}</div>
          <div style="font-size:0.58rem;color:#4a6080;margin-top:2px;">${pos.rangePts ? pos.rangePts.toFixed(1) + " pts" : ""}</div>
        </div>
      </div>
      ${pos.entryReason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;margin-top:12px;">Entry: ${pos.entryReason}</div>` : ""}
    </div>`;
  })() : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:0.9rem;font-weight:600;color:#4a6080;margin-bottom:14px;">FLAT — ${state.running ? "Waiting for ORB break" : "Session stopped"}</div>
      ${state.running ? `<div style="display:flex;gap:10px;justify-content:center;">
        <button onclick="orblManualEntry('CE')" style="padding:8px 24px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▲ Manual CE</button>
        <button onclick="orblManualEntry('PE')" style="padding:8px 24px;background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▼ Manual PE</button>
      </div>` : ""}
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
<title>ORB Live — ${orbStrategy.NAME}${dry ? " (DRY-RUN)" : ""}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<style>
${sidebarCSS()}
${modalCSS()}
${scalpStyleCSS()}
</style></head>
<body>
<div class="app-shell">
${buildSidebar('orbLive', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/orb-live/start'`, startLabel: '▶ Start ORB Live',
  showStopBtn: state.running,   stopBtnJs:  `location.href='/orb-live/stop'`,  stopLabel:  '■ Stop ORB Live',
  showExitBtn: state.running && !!state.position, exitBtnJs: `location.href='/orb-live/exit'`, exitLabel: '🚪 Exit Trade',
})}
<div class="main-content">

<div class="banner ${dry ? "banner-dry" : "banner-live"}">${dry ? "⚠️ DRY-RUN MODE — Orders are logged but NOT placed at broker. Flip LIVE_HARNESS_DRY_RUN=false in Settings to enable real orders." : "🚨 LIVE MODE — Real broker orders are being placed at Fyers. Confirm intentional."}</div>

${scalpTopBar({
  title: `ORB Live Trade${dry ? " (DRY-RUN)" : ""}`,
  metaLine: `${orbStrategy.NAME} · OR ${_orStart}–${_orEnd} · Square-off ${_forcedExit} IST · ${dry ? "decisions logged only" : "real Fyers orders"}`,
  running: state.running,
  vix: { enabled: _vixEnabled, value: _vix, maxEntry: _vixMaxEntry, strongOnly: Infinity },
  primaryAction: { label: dry ? "Start ORB (DRY)" : "Start ORB Live", href: "/orb-live/start", color: dry ? "#92400e" : "#7f1d1d" },
  stopAction:    { label: "Stop Session", href: "/orb-live/stop" },
  liveBadge: { kind: dry ? "dry" : "live" },
})}

${scalpCapitalStrip({
  starting: _orbLiveCapital(),
  current:  data.capital,
  allTime:  data.totalPnl,
  startingThreshold: _orbLiveCapital(),
  note: dry ? "Capital + PnL track DRY-RUN simulated fills." : "Capital updates from real broker fills.",
})}

${scalpStatGrid(statCards)}

${scalpCurrentBar({ bar: state.currentBar, resMin: RES_MIN })}

<div id="ajax-position-section" style="margin-bottom:18px;">
${posHtml}
</div>

${process.env.CHART_ENABLED !== "false" ? `<div style="margin-bottom:18px;">
  <div class="section-title">NIFTY ${RES_MIN}-Min Chart (Opening Range overlay)</div>
  <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
    <div id="nifty-chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
      <span style="color:#10b981;">── ORH</span> &nbsp;<span style="color:#ef4444;">── ORL</span> &nbsp;<span style="color:#3b82f6;">▲ Entry</span>
    </div>
  </div>
</div>` : ""}

<div id="orbl-trades-section" style="margin-bottom:18px;">
  <div class="section-title">Session Trades <span id="orbl-trades-hint" style="color:#4a6080;font-weight:400;letter-spacing:0.5px;text-transform:none;margin-left:8px;">${state.sessionTrades.length} trades</span></div>
  <div id="orbl-trades-box" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;${state.sessionTrades.length ? "" : "padding:24px;text-align:center;color:#4a6080;font-size:0.82rem;"}">${state.sessionTrades.length ? "" : "No trades yet"}</div>
</div>

${scalpActivityLog({ logsJSON })}

</div><!-- /main-content -->
</div><!-- /app-shell -->

<script>
${modalJS()}
async function orblHandleExit(btn) {
  var ok = await showConfirm({ icon:'🚪', title:'Exit position', message:'Exit ORB position now? ${dry ? "(DRY-RUN logged)" : "(REAL broker order)"}', confirmText:'Exit', confirmClass:'modal-btn-danger' });
  if (!ok) return;
  btn.disabled = true; btn.textContent = 'Exiting...';
  fetch('/orb-live/exit').then(function(){ location.reload(); }).catch(function(){ location.reload(); });
}
async function orblManualEntry(side) {
  var ok = await showConfirm({ icon:'✋', title:'Manual entry', message:'Manual '+side+' entry. ${dry ? "DRY-RUN — logged only." : "REAL ORDER will be placed."}', confirmText:'Enter '+side, confirmClass: ${dry ? "''" : "'modal-btn-danger'"} });
  if (!ok) return;
  try {
    var r = await fetch('/orb-live/manualEntry', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ side: side }) });
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
      tickMarkFormatter:function(t){ var d=new Date(t*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
    },
  });
  var cs = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var orhS = chart.addLineSeries({ color:'#10b981', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var orlS = chart.addLineSeries({ color:'#ef4444', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var entryLine = null, slLine = null, tgtLine = null;
  async function fetchChart(){
    try {
      var r = await fetch('/orb-live/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) cs.setData(d.candles);
      orhS.setData(d.orhLine || []);
      orlS.setData(d.orlLine || []);
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      if (entryLine) { cs.removePriceLine(entryLine); entryLine = null; }
      if (slLine)    { cs.removePriceLine(slLine);    slLine = null; }
      if (tgtLine)   { cs.removePriceLine(tgtLine);   tgtLine = null; }
      if (d.entryPrice) entryLine = cs.createPriceLine({ price:d.entryPrice, color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
      if (d.stopLoss)   slLine    = cs.createPriceLine({ price:d.stopLoss,   color:'#f59e0b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'SL' });
      if (d.target)     tgtLine   = cs.createPriceLine({ price:d.target,    color:'#10b981', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'Target' });
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
    var box = document.getElementById('orbl-trades-box');
    var hint = document.getElementById('orbl-trades-hint');
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
        '<td style="padding:8px 12px;font-size:0.62rem;color:#94a3b8;font-family:monospace;">' + (t.entryOrderId||'—') + '</td>' +
        '<td style="padding:8px 12px;font-size:0.65rem;color:#4a6080;">' + (t.exitReason||'') + '</td>' +
      '</tr>';
    }).join('');
    box.innerHTML = '<table style="width:100%;border-collapse:collapse;font-family:monospace;font-size:0.78rem;">' +
      '<thead><tr style="background:#0a0f1c;">' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Side</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">E.Spot</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">X.Spot</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">E.Opt</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">X.Opt</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">PnL</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Order ID</th>' +
      '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit Reason</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function fetchAndUpdate(){
    try {
      var r = await fetch('/orb-live/status/data', { cache:'no-store' });
      if (!r.ok) return;
      var d = await r.json();

      var pnlEl = document.getElementById('ajax-session-pnl');
      if (pnlEl) { pnlEl.textContent = (d.sessionPnl>=0?'+':'') + INR(d.sessionPnl); pnlEl.style.color = PNL_COLOR(d.sessionPnl); var card = pnlEl.closest('.sc'); if (card) card.style.borderTopColor = PNL_COLOR(d.sessionPnl); }
      setText('ajax-trade-count', d.tradesTaken || 0);
      setText('ajax-wl', (d.wins||0) + 'W · ' + (d.losses||0) + 'L');

      var livePnlEl = document.getElementById('ajax-live-pnl');
      if (livePnlEl) {
        if (d.livePnl != null) { livePnlEl.textContent = (d.livePnl>=0?'+':'') + INR(d.livePnl); livePnlEl.style.color = PNL_COLOR(d.livePnl); }
        else { livePnlEl.textContent = '—'; livePnlEl.style.color = '#c8d8f0'; }
      }
      setText('ajax-live-pnl-sub', d.position ? 'unrealised' : 'no open position');

      setText('ajax-wr', d.winRate != null ? d.winRate + '%' : '—');
      setText('ajax-wr-sub', (d.wins||0) + 'W · ' + (d.losses||0) + 'L');

      var orValEl = document.getElementById('ajax-or-range');
      if (orValEl) orValEl.textContent = (d.orh && d.orl) ? d.orl + '/' + d.orh : '—';
      setText('ajax-or-sub', d.orh && d.orl ? (d.rangePts + ' pts · ${_orStart}–${_orEnd}') : '${_orStart}–${_orEnd} IST');

      var dlossHit = (d.sessionPnl || 0) <= -_maxLoss;
      var dlEl = document.getElementById('ajax-daily-loss-val');
      if (dlEl) dlEl.style.color = dlossHit ? '#ef4444' : '#10b981';
      var dlSub = document.getElementById('ajax-daily-loss-sub');
      if (dlSub) { dlSub.textContent = dlossHit ? 'KILLED — no entries' : 'Active'; dlSub.style.color = dlossHit ? '#ef4444' : '#10b981'; }

      var cEl = document.getElementById('ajax-candle-count');
      if (cEl) { cEl.textContent = d.candles || 0; cEl.style.color = (d.candles||0) >= 3 ? '#10b981' : '#f59e0b'; }
      var cSub = document.getElementById('ajax-candle-status');
      if (cSub) { cSub.textContent = (d.candles||0) >= 3 ? 'OR ready' : 'Warming up...'; cSub.style.color = (d.candles||0) >= 3 ? '#10b981' : '#f59e0b'; }
      setText('ajax-tick-count', (d.tickCount || 0).toLocaleString());
      setText('ajax-last-tick', d.lastTickPrice ? INR(d.lastTickPrice) : '—');

      var capEl = document.getElementById('ajax-current-capital');
      if (capEl) { capEl.textContent = INR(d.capital); capEl.style.color = d.capital >= ${_orbLiveCapital()} ? '#10b981' : '#ef4444'; }
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
        var curOpt = p.currentOptLtp;
        var optMove = curOpt != null ? (curOpt - p.optionEntryLtp) : null;
        var optMovePct = (curOpt != null && p.optionEntryLtp) ? (optMove / p.optionEntryLtp * 100) : null;
        var entEl = document.getElementById('ajax-opt-entry-ltp');
        if (entEl) entEl.textContent = p.optionEntryLtp ? '₹' + p.optionEntryLtp.toFixed(2) : '—';
        var curEl = document.getElementById('ajax-opt-current-ltp');
        if (curEl && curOpt != null) { curEl.textContent = '₹' + curOpt.toFixed(2); curEl.style.color = curOpt >= p.optionEntryLtp ? '#10b981' : '#ef4444'; }
        var movEl = document.getElementById('ajax-opt-move');
        if (movEl && optMove != null) { movEl.textContent = (optMove >= 0 ? '▲ +' : '▼ ') + '₹' + Math.abs(optMove).toFixed(2); movEl.style.color = optMove >= 0 ? '#10b981' : '#ef4444'; }
        var pctEl = document.getElementById('ajax-opt-pct');
        if (pctEl && optMovePct != null) { pctEl.textContent = (optMovePct >= 0 ? '+' : '') + optMovePct.toFixed(2) + '%'; pctEl.style.color = optMovePct >= 0 ? '#10b981' : '#ef4444'; }
        var optPnlEl = document.getElementById('ajax-opt-pnl');
        if (optPnlEl && d.livePnl != null) { optPnlEl.textContent = (d.livePnl >= 0 ? '+' : '') + INR(d.livePnl); optPnlEl.style.color = PNL_COLOR(d.livePnl); }
        var ltpEl = document.getElementById('ajax-nifty-ltp');
        if (ltpEl && d.lastTickPrice != null) ltpEl.textContent = INR(d.lastTickPrice);
        var ltpSub = document.getElementById('ajax-nifty-move');
        if (ltpSub && d.lastTickPrice != null && p.entrySpot) {
          var sm = (d.lastTickPrice - p.entrySpot) * (p.side === 'CE' ? 1 : -1);
          ltpSub.textContent = (sm >= 0 ? '▲' : '▼') + ' ' + Math.abs(sm).toFixed(1) + ' pts';
          ltpSub.style.color = sm >= 0 ? '#10b981' : '#ef4444';
        }
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
    } catch (e) { console.warn('[orb-live] refresh:', e.message); }
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

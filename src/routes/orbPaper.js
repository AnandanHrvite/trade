/**
 * ORB PAPER TRADE — /orb-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * Opening Range Breakout (15-min OR, 5-min confirm) — single-leg ATM option
 * buying. Intraday MIS only, max 1 trade/session, square-off 15:15 IST.
 *
 * Uses LIVE NIFTY data (Fyers WebSocket) but SIMULATES the orders locally.
 * No broker is hit — everything is in-memory + persisted to JSON & JSONL.
 *
 * Strategy: see src/strategies/orb_breakout.js
 *
 * Endpoints:
 *   /orb-paper/start    → connect socket, watch for ORB break
 *   /orb-paper/stop     → close position (if any), save session
 *   /orb-paper/status   → live view (position, P&L, log)
 *   /orb-paper/history  → past sessions
 *   /orb-paper/status/data → JSON for AJAX poll
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
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, toastJS, tableEnhancerCSS, tableEnhancerJS } = require("../utils/sharedNav");
const { scalpStyleCSS, scalpTopBar, scalpCapitalStrip, scalpStatGrid, scalpCurrentBar, scalpActivityLog } = require("../utils/scalpStyleUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter   = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const tradeLogger = require("../utils/tradeLogger");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { fmtISTDateTime, getISTMinutes, getBucketStart, parseOptionDetails } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "orbPaper";
const RES_MIN            = 5;   // 5-min candles (textbook 15-min OR + 5-min confirm)
const OR_BARS            = 3;   // 15-min OR = 3 × 5-min bars

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "orb_paper_trades.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let _dataCache = null;
function loadData() {
  if (_dataCache) return _dataCache;
  ensureDir();
  if (!fs.existsSync(PT_FILE)) {
    const init = { capital: parseFloat(process.env.ORB_PAPER_CAPITAL || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(init, null, 2));
    _dataCache = init;
    return init;
  }
  try { _dataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error("[orb-paper] orb_paper_trades.json corrupt — resetting:", e.message);
    _dataCache = { capital: parseFloat(process.env.ORB_PAPER_CAPITAL || "100000"), totalPnl: 0, sessions: [] };
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

// ── Option LTP polling ──────────────────────────────────────────────────────

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
function stopOptionPolling() {
  if (_optionPollTimer) { clearInterval(_optionPollTimer); _optionPollTimer = null; }
}

// ── Trade simulation ────────────────────────────────────────────────────────

async function simulateBuy(side, sigSnapshot) {
  const spot = state.lastTickPrice;
  if (!spot || !side) return;

  // Resolve ATM option symbol (auto expiry)
  let optInfo;
  try {
    optInfo = await instrumentConfig.validateAndGetOptionSymbol(spot, side, "ORB");
  } catch (e) {
    log(`❌ [ORB-PAPER] Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ [ORB-PAPER] No valid expiry — skip ${side} entry`);
    return;
  }

  // Fetch current option LTP for entry premium
  let optionEntryLtp = null;
  try {
    const r = await fyers.getQuotes([optInfo.symbol]);
    if (r && r.s === "ok" && r.d && r.d.length) {
      const ltp = r.d[0].v && (r.d[0].v.lp || r.d[0].v.ltp);
      if (typeof ltp === "number" && ltp > 0) optionEntryLtp = ltp;
    }
  } catch (e) {
    log(`⚠️ [ORB-PAPER] Option LTP fetch failed: ${e.message} — entry blocked`);
    return;
  }
  if (!optionEntryLtp) {
    log(`❌ [ORB-PAPER] Option LTP not available — entry skipped`);
    return;
  }

  const qty = instrumentConfig.getLotQty();
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
    orh:            sigSnapshot.orh,
    orl:            sigSnapshot.orl,
    rangePts:       sigSnapshot.rangePts,
    targetSpot:     sigSnapshot.targetSpot,
    initialSlSpot:  sigSnapshot.slSpot,
    slSpot:         sigSnapshot.slSpot,
    targetPremium:  parseFloat((optionEntryLtp * (1 + parseFloat(process.env.ORB_TARGET_PCT || "0.5"))).toFixed(2)),
    stopPremium:    parseFloat((optionEntryLtp * (1 - parseFloat(process.env.ORB_STOP_PCT   || "0.3"))).toFixed(2)),
    peakPremium:    optionEntryLtp,
    movedToBE:      false,
    signalStrength: sigSnapshot.signalStrength,
    vixAtEntry:     getCachedVix(),
    entryReason:    sigSnapshot.reason,
  };

  state.position = pos;
  state.optionLtp = optionEntryLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;
  startOptionPolling();

  log(`🟢 [ORB-PAPER] BUY_${side} ${optInfo.symbol} qty=${qty} @ spot=${spot} optLtp=${optionEntryLtp} | tgt=${pos.targetSpot} sl=${pos.slSpot} | tgtPrem=${pos.targetPremium} slPrem=${pos.stopPremium}`);

  notifyEntry({
    mode: "ORB-PAPER",
    side, symbol: optInfo.symbol,
    spotAtEntry: spot, optionEntryLtp,
    qty, stopLoss: pos.slSpot,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "orb-paper",
      sessionId: state._sessionId,
      ts: Date.now(),
      side, symbol: optInfo.symbol, qty,
      spotEntry: spot, optionEntry: optionEntryLtp,
      stopLoss: pos.slSpot, targetSpot: pos.targetSpot,
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
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    pnl,
    pnlMode:        `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp}`,
    exitReason:     reason,
    entryReason:    pos.entryReason,
    stopLoss:       pos.slSpot,
    initialStopLoss: pos.initialSlSpot,
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    optionType:     pos.side,
    optionEntrySymbol: pos.symbol,
    signalStrength: pos.signalStrength,
    vixAtEntry:     pos.vixAtEntry,
    rangePts:       pos.rangePts,
    orh:            pos.orh,
    orl:            pos.orl,
    targetSpot:     pos.targetSpot,
    durationMs:     Date.now() - pos.entryTimeMs,
    charges,
    isFutures:      false,
    instrument:     "NIFTY_OPTIONS",
  };
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog("orb", trade);

  log(`🔴 [ORB-PAPER] EXIT ${pos.side} ${pos.symbol} @ optLtp=${exitOptLtp} spot=${exitSpot} | PnL=₹${pnl} (${reason})`);

  notifyExit({
    mode: "ORB-PAPER",
    side: pos.side, symbol: pos.symbol,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    optionEntryLtp: pos.optionEntryLtp, optionExitLtp: exitOptLtp,
    pnl, sessionPnl: state.sessionPnl,
    exitReason: reason, entryTime: pos.entryTime, exitTime: trade.exitTime, qty,
  });

  try {
    tickRecorder.recordExit({
      mode: "orb-paper", sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitOptLtp, pnl, reason,
    });
  } catch (_) {}

  state.position = null;
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;
  stopOptionPolling();
}

// ── In-position management (tick-level) ─────────────────────────────────────

function _checkExits(spotPrice) {
  if (!state.position) return;
  const pos = state.position;
  const optLtp = state.optionLtp || pos.optionEntryLtp;

  // Track peak option premium for BE-after-1R trail
  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;

  // ── Move-to-BE: once spot moves >= 1× range in favour, lift SL to entry ─
  const moveInFavour = pos.side === "CE" ? (spotPrice - pos.entrySpot) : (pos.entrySpot - spotPrice);
  if (!pos.movedToBE && moveInFavour >= pos.rangePts) {
    pos.movedToBE = true;
    const newSL = pos.side === "CE"
      ? Math.max(pos.slSpot, pos.entrySpot)
      : Math.min(pos.slSpot, pos.entrySpot);
    if (newSL !== pos.slSpot) {
      log(`📐 [ORB-PAPER] Move-to-BE: SL ${pos.slSpot} → ${newSL} (moved 1× range in favour)`);
      pos.slSpot = newSL;
    }
  }

  // ── Premium SL ───────────────────────────────────────────────────────────
  if (optLtp <= pos.stopPremium) {
    simulateSell(`Premium SL hit (₹${optLtp} <= ₹${pos.stopPremium}, −${(parseFloat(process.env.ORB_STOP_PCT||"0.3")*100).toFixed(0)}%)`);
    return;
  }
  // ── Premium target ───────────────────────────────────────────────────────
  if (optLtp >= pos.targetPremium) {
    simulateSell(`Premium target (₹${optLtp} >= ₹${pos.targetPremium}, +${(parseFloat(process.env.ORB_TARGET_PCT||"0.5")*100).toFixed(0)}%)`);
    return;
  }
  // ── Spot SL (opposite side of OR) ────────────────────────────────────────
  if (pos.side === "CE" && spotPrice <= pos.slSpot) {
    simulateSell(`Spot SL hit (${spotPrice} <= ORL ${pos.slSpot})`);
    return;
  }
  if (pos.side === "PE" && spotPrice >= pos.slSpot) {
    simulateSell(`Spot SL hit (${spotPrice} >= ORH ${pos.slSpot})`);
    return;
  }
  // ── Spot target (1.5× range) ────────────────────────────────────────────
  if (pos.side === "CE" && spotPrice >= pos.targetSpot) {
    simulateSell(`Spot target hit (${spotPrice} >= ${pos.targetSpot})`);
    return;
  }
  if (pos.side === "PE" && spotPrice <= pos.targetSpot) {
    simulateSell(`Spot target hit (${spotPrice} <= ${pos.targetSpot})`);
    return;
  }
}

// ── Candle close handler ────────────────────────────────────────────────────

async function onCandleClose(bar) {
  // Already in position? Don't re-evaluate entry — exits run on tick.
  if (state.position) return;

  const _spot = bar && bar.close;

  // Daily-loss kill
  const maxLoss = parseFloat(process.env.ORB_MAX_DAILY_LOSS || "3000");
  if (state.sessionPnl <= -maxLoss) {
    skipLogger.appendSkipLog("orb", { gate: "daily_loss", reason: `sessionPnl ${state.sessionPnl} <= -${maxLoss}`, spot: _spot });
    return;
  }

  // Max trades guard (default 1 — ORB is 1/day)
  const maxTrades = parseInt(process.env.ORB_MAX_DAILY_TRADES || "1", 10);
  if (state.tradesTaken >= maxTrades) return; // expected, not a skip

  // Expiry-day-only filter
  if (state._expiryDayBlocked) {
    skipLogger.appendSkipLog("orb", { gate: "expiry_day_only", reason: "Not an expiry day", spot: _spot });
    return;
  }

  // Evaluate ORB signal
  const sig = orbStrategy.getSignal(state.candles, { alreadyTraded: state.tradesTaken >= maxTrades });
  if (sig.signal === "NONE" || !sig.side) {
    // Only log when the signal actually evaluated (range formed) — pre-range
    // candles produce "waiting for OR" noise.
    if (sig.orh != null && sig.orl != null) {
      skipLogger.appendSkipLog("orb", { gate: "signal_none", reason: sig.reason || "no signal", spot: _spot, orh: sig.orh, orl: sig.orl, rangePts: sig.rangePts });
    }
    return;
  }

  // VIX gate
  if ((process.env.ORB_VIX_ENABLED || "false").toLowerCase() === "true") {
    const vixCheck = await checkLiveVix(sig.signalStrength, { mode: "orb" });
    if (!vixCheck.allowed) {
      log(`⏸️ [ORB-PAPER] VIX gate blocked: ${vixCheck.reason}`);
      skipLogger.appendSkipLog("orb", { gate: "vix", reason: vixCheck.reason, spot: _spot, vix: vixCheck.vix, sig: sig.signal, strength: sig.signalStrength });
      return;
    }
  }

  await simulateBuy(sig.side, sig);
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
      onCandleClose(state.currentBar).catch(e => console.error(`🚨 [ORB-PAPER] onCandleClose error: ${e.message}`));
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

  // In-position exit checks (tick-level)
  if (state.position) {
    _checkExits(price);
  }

  // EOD square-off
  if (state.position) {
    const nowMin = getISTMinutes();
    const stopMin = (function() {
      const raw = process.env.ORB_FORCED_EXIT || "15:15";
      const [h, m] = raw.split(":").map(Number);
      return h * 60 + (isNaN(m) ? 0 : m);
    })();
    if (nowMin >= stopMin) {
      simulateSell(`EOD square-off (${process.env.ORB_FORCED_EXIT || "15:15"} IST)`);
    }
  }
}

// ── Preload spot history (so OR is built from the day's actual candles) ─────

async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { fetchCandles } = require("../services/backtestEngine");
    const istToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const from = Math.floor(new Date(istToday + "T03:45:00.000Z").getTime() / 1000); // 09:15 IST today
    const to   = Math.floor(Date.now() / 1000);
    const candles = await fetchCandlesCached(NIFTY_INDEX_SYMBOL, RES_MIN, from, to, fetchCandles);
    if (Array.isArray(candles) && candles.length > 0) {
      state.candles = candles.slice(-200);
      log(`📊 [ORB-PAPER] Preloaded ${state.candles.length} × ${RES_MIN}-min spot candles`);
    } else {
      log(`📊 [ORB-PAPER] No history available — will build from live ticks`);
    }
  } catch (e) {
    log(`⚠️ [ORB-PAPER] Preload failed: ${e.message}`);
  }
}

// ── Auto-stop at TRADE_STOP_TIME ────────────────────────────────────────────

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
    log(`⏰ [ORB-PAPER] Auto-stop @ ${raw} IST`);
    stopSession();
  }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ───────────────────────────────────────────────────────

router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/orb-paper/status");

  if ((process.env.ORB_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("ORB Mode Disabled", "Enable ORB Mode in Settings first", "/settings", "Go to Settings"));
  }

  const check = sharedSocketState.canStart("ORB_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/orb-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/orb-paper/status", "← Back"));

  // Past 15:15 = entries useless
  const nowMin = getISTMinutes();
  const stopMin = (function() {
    const raw = process.env.ORB_FORCED_EXIT || "15:15";
    const [h, m] = raw.split(":").map(Number);
    return h * 60 + (isNaN(m) ? 0 : m);
  })();
  if (nowMin >= stopMin) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${process.env.ORB_FORCED_EXIT || "15:15"} IST — ORB does not enter after this`, "/orb-paper/status", "← Back"));
  }

  let _expiryBlocked = false;
  if ((process.env.ORB_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
    const { isExpiryDay } = require("../utils/nseHolidays");
    const isExpiry = await isExpiryDay();
    if (!isExpiry) _expiryBlocked = true;
    log(`📅 [ORB-PAPER] Expiry-only mode: ${isExpiry ? "✅ Today is expiry — allowed" : "❌ Not expiry day — entries blocked"}`);
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `orb-paper:${Date.now()}`;
  state._expiryDayBlocked = _expiryBlocked;

  sharedSocketState.setOrbActive("ORB_PAPER");

  await preloadHistory();

  if ((process.env.ORB_VIX_ENABLED || "false").toLowerCase() === "true") {
    resetVixCache();
    fetchLiveVix({ force: true }).catch(() => {});
  }

  try {
    tickRecorder.recordSessionStart({
      mode: "orb-paper",
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
    log("📡 [ORB-PAPER] Piggybacking on existing WebSocket");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [ORB-PAPER] Started WebSocket");
  }

  scheduleAutoStop();
  log(`🟢 [ORB-PAPER] Session started — ${RES_MIN}-min candles, OR=${OR_BARS} bars (${RES_MIN * OR_BARS}-min)`);

  notifyStarted({
    mode: "ORB-PAPER",
    text: [
      `📄 ORB PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${orbStrategy.NAME}`,
      `OR window : ${process.env.ORB_RANGE_START || "09:15"} → ${process.env.ORB_RANGE_END || "09:30"} IST`,
      `Entry     : after OR locks, max ${process.env.ORB_MAX_DAILY_TRADES || "1"} trade/day`,
      `Square-off: ${process.env.ORB_FORCED_EXIT || "15:15"} IST`,
      _expiryBlocked ? `\n⚠️ Expiry-only mode: entries blocked (not expiry day)` : null,
    ].filter(Boolean).join("\n"),
  });

  res.redirect("/orb-paper/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped");
  state.running = false;
  stopOptionPolling();

  try {
    tickRecorder.recordSessionStop({ mode: "orb-paper", sessionId: state._sessionId || null, reason: "user_stop" });
  } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) {
    socketManager.stop();
  }
  sharedSocketState.clearOrb();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({
        date: state.sessionStart,
        strategy: orbStrategy.NAME,
        pnl: state.sessionPnl,
        trades: state.sessionTrades,
      });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      saveData(data);
      log(`💾 [ORB-PAPER] Session saved — ${state.sessionTrades.length} trades, PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ [ORB-PAPER] Save failed: ${e.message}`);
    }
  }

  log("🔴 [ORB-PAPER] Session stopped");

  notifyDayReport({
    mode: "ORB-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => {
  stopSession();
  res.redirect("/orb-paper/status");
});

router.get("/exit", (req, res) => {
  if (state.position) simulateSell("Manual exit");
  res.redirect("/orb-paper/status");
});

// ── Manual CE/PE entry — bypasses ORB break, useful when user reads the
//    market manually and wants to take a trade. Reuses the same simulateBuy
//    path so all the standard SL/target/charges/logging applies. ───────────
router.post("/manualEntry", async (req, res) => {
  if (!state.running)  return res.status(400).json({ success: false, error: "ORB paper is not running." });
  if (state.position)  return res.status(400).json({ success: false, error: "Already in a position. Exit first." });
  const { side } = req.body || {};
  if (side !== "CE" && side !== "PE") return res.status(400).json({ success: false, error: "Side must be CE or PE." });

  const spot = state.lastTickPrice || (state.currentBar ? state.currentBar.close : null);
  if (!spot) return res.status(400).json({ success: false, error: "No market data yet." });

  // Build a synthetic ORB signal snapshot — use current OR if formed, else
  // synthesize a small range around spot so SL/target math still works.
  let or = null;
  try { or = orbStrategy.computeOpeningRange(state.candles); } catch (_) {}
  const rangePts = or ? Math.round((or.high - or.low) * 100) / 100 : 50;
  const orh = or ? or.high : spot + 25;
  const orl = or ? or.low  : spot - 25;
  const slSpot = side === "CE" ? orl : orh;
  const tgtMult = parseFloat(process.env.ORB_TARGET_RANGE_MULT || "1.5");
  const targetSpot = side === "CE" ? orh + rangePts * tgtMult : orl - rangePts * tgtMult;

  const sig = {
    signal: side === "CE" ? "BUY_CE" : "BUY_PE",
    side, orh, orl, rangePts,
    entrySpot: spot, slSpot, targetSpot,
    signalStrength: "MANUAL",
    reason: `🖐️ MANUAL ${side} entry @ spot ₹${spot} (range ${rangePts}pt)`,
  };
  log(`🖐️ [ORB-PAPER] MANUAL ${side} entry triggered by user @ spot ₹${spot}`);
  try {
    await simulateBuy(side, sig);
    return res.json({ success: true, side, spot, slSpot, targetSpot });
  } catch (e) {
    log(`❌ [ORB-PAPER] Manual entry failed: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── Status page ─────────────────────────────────────────────────────────────

// ── /status/chart-data — feeds Lightweight Charts live NIFTY view ────────────
router.get("/status/chart-data", (req, res) => {
  try {
    const candles = state.candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.currentBar) {
      candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });
    }

    // Opening Range box overlay — emit two horizontal lines at ORH and ORL
    let orhLine = [], orlLine = [];
    try {
      const or = orbStrategy.computeOpeningRange(state.candles);
      if (or && candles.length) {
        const fromTime = candles[0].time;
        const toTime = candles[candles.length - 1].time;
        // Lightweight Charts needs sorted ascending values
        orhLine = [
          { time: fromTime, value: or.high },
          { time: toTime,   value: or.high },
        ];
        orlLine = [
          { time: fromTime, value: or.low },
          { time: toTime,   value: or.low },
        ];
      }
    } catch (_) {}

    const markers = [];
    for (const t of state.sessionTrades) {
      // Best-effort marker — entryTime/exitTime are IST strings; we don't have entryBarTime
      // captured on the trade, so we approximate using the closest candle by spot price.
      if (t.spotAtEntry != null) {
        const c = candles.find(c => Math.abs(c.close - t.spotAtEntry) < 1) || candles[0];
        if (c) markers.push({ time: c.time, position: 'belowBar', color: '#3b82f6', shape: 'arrowUp', text: (t.side || '') + ' @ ' + t.spotAtEntry });
      }
      if (t.spotAtExit != null) {
        const c = candles.find(c => Math.abs(c.close - t.spotAtExit) < 1) || candles[candles.length - 1];
        if (c) markers.push({ time: c.time, position: 'aboveBar', color: t.pnl >= 0 ? '#10b981' : '#ef4444', shape: 'arrowDown', text: 'Exit ' + (t.pnl >= 0 ? '+' : '') + Math.round(t.pnl || 0) });
      }
    }

    const stopLoss   = state.position && state.position.slSpot     != null ? state.position.slSpot     : null;
    const entryPrice = state.position && state.position.entrySpot  != null ? state.position.entrySpot  : null;
    const target     = state.position && state.position.targetSpot != null ? state.position.targetSpot : null;

    return res.json({ candles, markers, stopLoss, entryPrice, target, orhLine, orlLine });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const data = loadData();

  let or = null;
  try { or = orbStrategy.computeOpeningRange(state.candles); } catch (_) {}

  // Live position P&L (delta-proxy if option LTP stale)
  let livePnl = null;
  if (pos) {
    const lot = pos.qty || instrumentConfig.getLotQty();
    if (state.optionLtp != null) {
      livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * lot).toFixed(2));
    }
  }

  // Build cumulative P&L array for chart
  const cumPnl = [];
  let cum = 0;
  for (const t of state.sessionTrades) {
    cum += (t.pnl || 0);
    cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) });
  }

  // Stats for today
  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const bestTrade = state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null;
  const worstTrade = state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null;

  res.json({
    running:        state.running,
    sessionPnl:     state.sessionPnl,
    tradesTaken:    state.tradesTaken,
    sessionTrades:  state.sessionTrades.slice(-50),
    log:            state.log.slice(-100),
    tickCount:      state.tickCount,
    lastTickPrice:  state.lastTickPrice,
    candles:        state.candles.length,
    currentBar:     state.currentBar,
    sessionStart:   state.sessionStart,
    optionLtp:      state.optionLtp,
    optionLtpAgeSec: optAge,
    vix:            getCachedVix(),
    orh:            or && or.high,
    orl:            or && or.low,
    rangePts:       or ? Math.round((or.high - or.low) * 100) / 100 : null,
    wins, losses, winRate, bestTrade, worstTrade,
    cumPnl,
    livePnl,
    position: pos ? {
      side: pos.side, symbol: pos.symbol,
      entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      slSpot: pos.slSpot, targetSpot: pos.targetSpot,
      targetPremium: pos.targetPremium, stopPremium: pos.stopPremium,
      entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      orh: pos.orh, orl: pos.orl, rangePts: pos.rangePts,
      qty: pos.qty,
      currentOptLtp: state.optionLtp,
    } : null,
    totalPnl: data.totalPnl,
    capital:  data.capital,
  });
});

function _orbCapital() {
  const v = parseFloat(process.env.ORB_PAPER_CAPITAL);
  return isNaN(v) ? 100000 : v;
}

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const data = loadData();
  const pos  = state.position;

  // Stat values (server-side initial render)
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

  // Live live PnL for badge
  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * (pos.qty || instrumentConfig.getLotQty())).toFixed(2));
  }

  // Build stat cards
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
      accent: "#6a5090",
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
      sub: `<span id="ajax-wr-sub" style="font-size:0.6rem;color:#4a6080;">single best ${(state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t=>t.pnl||0)).toFixed(0) : "—")} / worst ${(state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t=>t.pnl||0)).toFixed(0) : "—")}</span>`,
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

  // Position HTML — scalp-style rich card
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
        <button onclick="orbpHandleExit(this)"
           style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;">
          Exit Trade Now
        </button>
      </div>

      <!-- Option identity banner -->
      <div style="background:#071a12;border:1px solid #134e35;border-radius:10px;padding:14px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:2.2rem;font-weight:900;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side}</span>
            <div>
              <div style="font-size:0.72rem;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side === "CE" ? "CALL · Bullish breakout" : "PUT · Bearish breakout"}</div>
              <span style="font-size:0.65rem;font-weight:700;color:#94a3b8;">${pos.signalStrength || "ORB"}</span>
            </div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Strike</div>
            <div style="font-size:1.6rem;font-weight:800;color:#fff;font-family:monospace;">${pos.optionStrike ? pos.optionStrike.toLocaleString("en-IN") : "—"}</div>
          </div>
          <div style="width:1px;height:44px;background:#134e35;"></div>
          <div>
            <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Expiry</div>
            <div style="font-size:1.1rem;font-weight:700;color:#f59e0b;">${pos.optionExpiry || "—"}</div>
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

      <!-- Premium section -->
      <div style="background:#0a0f24;border:2px solid #3b82f6;border-radius:12px;padding:18px 20px;margin-bottom:14px;">
        <div style="font-size:0.68rem;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Option Premium (${pos.side})</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">
          <div style="text-align:center;padding:12px;background:#071a3e;border:1px solid #1e3a5f;border-radius:10px;">
            <div style="font-size:0.63rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Entry Price</div>
            <div id="ajax-opt-entry-ltp" style="font-size:2rem;font-weight:800;color:#60a5fa;font-family:monospace;line-height:1;">₹${pos.optionEntryLtp ? pos.optionEntryLtp.toFixed(2) : "—"}</div>
            <div style="font-size:0.68rem;color:#4a6080;margin-top:4px;">captured at entry</div>
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

      <!-- Levels grid -->
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
          <div style="font-size:0.95rem;font-weight:700;color:#c8d8f0;">${pos.orl}/${pos.orh}</div>
          <div style="font-size:0.58rem;color:#4a6080;margin-top:2px;">${pos.rangePts ? pos.rangePts.toFixed(1) + " pts" : ""}</div>
        </div>
      </div>
      ${pos.entryReason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;margin-top:12px;">Entry: ${pos.entryReason}</div>` : ""}
    </div>`;
  })() : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:0.9rem;font-weight:600;color:#4a6080;margin-bottom:14px;">FLAT — ${state.running ? "Waiting for ORB break" : "Session stopped"}</div>
      ${state.running ? `<div style="display:flex;gap:10px;justify-content:center;">
        <button onclick="orbpManualEntry('CE')" style="padding:8px 24px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▲ Manual CE</button>
        <button onclick="orbpManualEntry('PE')" style="padding:8px 24px;background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">▼ Manual PE</button>
      </div>` : ""}
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
<title>ORB Paper — ${orbStrategy.NAME}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<style>
${sidebarCSS()}
${modalCSS()}
${scalpStyleCSS()}
</style></head>
<body>
<div class="app-shell">
${buildSidebar('orbPaper', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/orb-paper/start'`, startLabel: '▶ Start ORB',
  showStopBtn: state.running,   stopBtnJs:  `location.href='/orb-paper/stop'`,  stopLabel:  '■ Stop ORB',
  showExitBtn: state.running && !!state.position, exitBtnJs: `location.href='/orb-paper/exit'`, exitLabel: '🚪 Exit Trade',
})}
<div class="main-content">

${scalpTopBar({
  title: "ORB Paper Trade",
  metaLine: `Strategy: ${orbStrategy.NAME} · OR ${_orStart}–${_orEnd} · Square-off ${_forcedExit} IST · ${state.running ? "Auto-refreshes every 2s" : "Stopped"}`,
  running: state.running,
  vix: { enabled: _vixEnabled, value: _vix, maxEntry: _vixMaxEntry, strongOnly: Infinity },
  primaryAction: { label: "Start ORB Paper", href: "/orb-paper/start" },
  stopAction:    { label: "Stop Session",    href: "/orb-paper/stop"  },
  historyHref: "/orb-paper/history",
})}

${scalpCapitalStrip({
  starting: _orbCapital(),
  current:  data.capital,
  allTime:  data.totalPnl,
  startingThreshold: _orbCapital(),
})}

${scalpStatGrid(statCards)}

${scalpCurrentBar({ bar: state.currentBar, resMin: RES_MIN })}

<div id="ajax-position-section" style="margin-bottom:18px;">
${posHtml}
</div>

${process.env.CHART_ENABLED !== "false" ? `<!-- NIFTY Chart -->
<div style="margin-bottom:18px;">
  <div class="section-title">NIFTY ${RES_MIN}-Min Chart (Opening Range overlay)</div>
  <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
    <div id="nifty-chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
      <span style="color:#10b981;">── ORH</span> &nbsp;<span style="color:#ef4444;">── ORL</span> &nbsp;<span style="color:#3b82f6;">▲ Entry</span> &nbsp;<span style="color:#f59e0b;">── SL</span> &nbsp;<span style="color:#10b981;">── Target</span>
    </div>
  </div>
</div>` : ""}

<!-- Session trades -->
<div id="orbp-trades-section" style="margin-bottom:18px;">
  <div class="section-title">Session Trades <span id="orbp-trades-hint" style="color:#4a6080;font-weight:400;letter-spacing:0.5px;text-transform:none;margin-left:8px;">${state.sessionTrades.length} trades</span></div>
  <div id="orbp-trades-box" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;${state.sessionTrades.length ? "" : "padding:24px;text-align:center;color:#4a6080;font-size:0.82rem;"}">${state.sessionTrades.length ? "" : "No trades yet"}</div>
</div>

${scalpActivityLog({ logsJSON })}

</div><!-- /main-content -->
</div><!-- /app-shell -->

<script>
${modalJS()}

// ── Manual exit + reset handlers ────────────────────────────────────────
async function orbpHandleExit(btn) {
  var ok = await showConfirm({ icon:'🚪', title:'Exit position', message:'Exit current ORB position now?', confirmText:'Exit', confirmClass:'modal-btn-danger' });
  if (!ok) return;
  btn.disabled = true; btn.textContent = 'Exiting...';
  fetch('/orb-paper/exit').then(function(){ location.reload(); }).catch(function(){ location.reload(); });
}
async function orbpManualEntry(side) {
  var ok = await showConfirm({ icon:'✋', title:'Manual entry', message:'Manual '+side+' entry at current spot? Bypasses OR-break filter.', confirmText:'Enter '+side });
  if (!ok) return;
  try {
    var r = await fetch('/orb-paper/manualEntry', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ side: side }) });
    var j = await r.json();
    if (!j.success) { alert('Entry failed: ' + (j.error || 'Unknown error')); return; }
    location.reload();
  } catch (e) { alert('Error: ' + e.message); location.reload(); }
}
</script>

<script>
// ── NIFTY Lightweight Chart (with OR overlay + entry/SL/target lines) ────
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
      var r = await fetch('/orb-paper/status/chart-data', { cache:'no-store' });
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
// ── AJAX live refresh — only updates DOM fragments; full reload on state change
(function(){
  var INR = function(n){ return typeof n==='number' ? '₹'+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; };
  var PNL_COLOR = function(n){ return (n||0)>=0 ? '#10b981' : '#ef4444'; };
  var _lastHasPosition = ${pos ? "true" : "false"};
  var _lastTradeCount  = ${state.sessionTrades.length};
  var _lastLogCount    = ${state.log.length};
  var _lastRunning     = ${state.running};
  var _maxLoss         = ${_maxLoss};

  function setText(id, val){ var el=document.getElementById(id); if(el && el.textContent !== String(val)) el.textContent = val; }
  function setHTML(id, val){ var el=document.getElementById(id); if(el) el.innerHTML = val; }

  function renderTrades(trades){
    var box = document.getElementById('orbp-trades-box');
    var hint = document.getElementById('orbp-trades-hint');
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
        '<td style="padding:8px 12px;font-size:0.65rem;color:#4a6080;">' + (t.exitReason||'') + '</td>' +
      '</tr>';
    }).join('');
    box.innerHTML = '<table style="width:100%;border-collapse:collapse;font-family:monospace;font-size:0.78rem;">' +
      '<thead><tr style="background:#0a0f1c;">' +
        '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Entry Time</th>' +
        '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit Time</th>' +
        '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Side</th>' +
        '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">E.Spot</th>' +
        '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">X.Spot</th>' +
        '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">E.Opt</th>' +
        '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">X.Opt</th>' +
        '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">PnL</th>' +
        '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;">Exit Reason</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function fetchAndUpdate(){
    try {
      var r = await fetch('/orb-paper/status/data', { cache:'no-store' });
      if (!r.ok) return;
      var d = await r.json();

      // Session PnL
      var pnlEl = document.getElementById('ajax-session-pnl');
      if (pnlEl) { pnlEl.textContent = (d.sessionPnl>=0?'+':'') + INR(d.sessionPnl); pnlEl.style.color = PNL_COLOR(d.sessionPnl); var card = pnlEl.closest('.sc'); if (card) card.style.borderTopColor = PNL_COLOR(d.sessionPnl); }
      setText('ajax-trade-count', d.tradesTaken || 0);
      setText('ajax-wl', (d.wins||0) + 'W · ' + (d.losses||0) + 'L');

      // Live PnL
      var livePnlEl = document.getElementById('ajax-live-pnl');
      if (livePnlEl) {
        if (d.livePnl != null) { livePnlEl.textContent = (d.livePnl>=0?'+':'') + INR(d.livePnl); livePnlEl.style.color = PNL_COLOR(d.livePnl); }
        else { livePnlEl.textContent = '—'; livePnlEl.style.color = '#c8d8f0'; }
      }
      setText('ajax-live-pnl-sub', d.position ? 'unrealised' : 'no open position');

      // Win Rate
      setText('ajax-wr', d.winRate != null ? d.winRate + '%' : '—');
      var bestN = (d.bestTrade != null) ? Math.round(d.bestTrade) : null;
      var worstN = (d.worstTrade != null) ? Math.round(d.worstTrade) : null;
      setText('ajax-wr-sub', 'single best ' + (bestN==null?'—':bestN) + ' / worst ' + (worstN==null?'—':worstN));

      // OR Range
      var orValEl = document.getElementById('ajax-or-range');
      if (orValEl) { if (d.orh && d.orl) { orValEl.textContent = d.orl + '/' + d.orh; } else { orValEl.textContent = '—'; } }
      setText('ajax-or-sub', d.orh && d.orl ? (d.rangePts + ' pts · ${_orStart}–${_orEnd}') : '${_orStart}–${_orEnd} IST');

      // Daily loss
      var dlossHit = (d.sessionPnl || 0) <= -_maxLoss;
      var dlEl = document.getElementById('ajax-daily-loss-val');
      if (dlEl) dlEl.style.color = dlossHit ? '#ef4444' : '#10b981';
      var dlSub = document.getElementById('ajax-daily-loss-sub');
      if (dlSub) { dlSub.textContent = dlossHit ? 'KILLED — no entries' : 'Active'; dlSub.style.color = dlossHit ? '#ef4444' : '#10b981'; }

      // Candles + ticks
      var cEl = document.getElementById('ajax-candle-count');
      if (cEl) { cEl.textContent = d.candles || 0; cEl.style.color = (d.candles||0) >= 3 ? '#10b981' : '#f59e0b'; }
      var cSub = document.getElementById('ajax-candle-status');
      if (cSub) { cSub.textContent = (d.candles||0) >= 3 ? 'OR ready' : 'Warming up...'; cSub.style.color = (d.candles||0) >= 3 ? '#10b981' : '#f59e0b'; }
      setText('ajax-tick-count', (d.tickCount || 0).toLocaleString());
      setText('ajax-last-tick', d.lastTickPrice ? INR(d.lastTickPrice) : '—');

      // Capital
      var capEl = document.getElementById('ajax-current-capital');
      if (capEl) { capEl.textContent = INR(d.capital); capEl.style.color = d.capital >= ${_orbCapital()} ? '#10b981' : '#ef4444'; }
      var atpEl = document.getElementById('ajax-alltime-pnl');
      if (atpEl) { atpEl.textContent = (d.totalPnl >= 0 ? '+' : '') + INR(d.totalPnl); atpEl.style.color = PNL_COLOR(d.totalPnl); }

      // Current bar
      if (d.currentBar) {
        ['open','high','low','close'].forEach(function(k){
          var el = document.getElementById('ajax-bar-' + k);
          if (el) el.textContent = INR(d.currentBar[k]);
        });
      }

      // Position — full reload on state change
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

      // Trades table — re-render if count changed
      if ((d.sessionTrades || []).length !== _lastTradeCount) {
        _lastTradeCount = (d.sessionTrades || []).length;
        renderTrades(d.sessionTrades || []);
      }

      // Activity log — reload if count changed
      if ((d.log || []).length !== _lastLogCount) {
        _lastLogCount = (d.log || []).length;
        LOG_ALL.length = 0;
        (d.log || []).slice().reverse().forEach(function(l){ LOG_ALL.push(l); });
        if (typeof logFilter === 'function') logFilter();
      }

      // Detect stop
      if (_lastRunning && !d.running) { _lastRunning = false; setTimeout(function(){ window.location.reload(); }, 1500); }
    } catch (e) { console.warn('[orb-paper] refresh:', e.message); }
  }

  ${state.running ? "var _it = setInterval(fetchAndUpdate, 2000); fetchAndUpdate();" : ""}
  document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'visible' && ${state.running}) fetchAndUpdate(); });
})();
</script>

</body></html>`);
});

// ── History page — session accordion with per-session copy/delete + analytics

router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const startCap = parseFloat(process.env.ORB_PAPER_CAPITAL || "100000");

  const inr = n => typeof n === "number" ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
  const pnlColor = n => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";

  const allTrades = data.sessions.flatMap(s => (s.trades || []).map(t => ({ ...t, date: s.date })));
  const totalWins   = allTrades.filter(t => t.pnl > 0).length;
  const totalLosses = allTrades.filter(t => t.pnl < 0).length;
  const totalPnl    = allTrades.reduce((a, t) => a + (t.pnl || 0), 0);

  const sessionCards = data.sessions.length === 0
    ? `<div style="text-align:center;padding:60px 24px;background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;">
        <div style="font-size:3rem;margin-bottom:16px;">📭</div>
        <div style="font-size:1rem;font-weight:600;color:#e0eaf8;margin-bottom:8px;">No sessions yet</div>
        <div style="font-size:0.82rem;color:#4a6080;">Start ORB paper trading to record your first session.</div>
       </div>`
    : data.sessions.slice().reverse().map((s, idx) => {
        const sIdx = data.sessions.length - idx;
        const actualIdx = data.sessions.length - 1 - idx;
        const trades = s.trades || [];
        const sessionWins   = trades.filter(t => t.pnl > 0).length;
        const sessionLosses = trades.filter(t => t.pnl < 0).length;
        const winRate = trades.length ? ((sessionWins / trades.length) * 100).toFixed(1) + "%" : "—";

        const tradeRows = trades.map((t, ti) => {
          const badgeCls = t.side === "CE" ? "badge-ce" : "badge-pe";
          const entrySpot = inr(t.spotAtEntry || t.entryPrice);
          const exitSpot  = inr(t.spotAtExit || t.exitPrice);
          const pnlStr = `<span style="font-weight:800;color:${pnlColor(t.pnl)};">${t.pnl >= 0 ? "+" : ""}${inr(t.pnl)}</span>`;
          const entryDate = t.entryTime ? t.entryTime.split(",")[0] : "—";
          const entryTimeOnly = t.entryTime ? (t.entryTime.split(", ")[1] || "—") : "—";
          const exitTimeOnly = t.exitTime ? (t.exitTime.split(", ")[1] || "—") : "—";
          const entryReasonShort = (t.entryReason || "—").substring(0, 25) + ((t.entryReason || "").length > 25 ? "…" : "");
          const exitReasonShort  = (t.exitReason  || "—").substring(0, 25) + ((t.exitReason  || "").length > 25 ? "…" : "");
          return `<tr>
            <td><span class="badge ${badgeCls}">${t.side}</span></td>
            <td style="color:#c8d8f0;font-size:0.75rem;">${entryDate}</td>
            <td style="color:#c8d8f0;">${entrySpot}</td>
            <td style="color:#c8d8f0;font-size:0.75rem;">${entryTimeOnly}</td>
            <td style="color:#c8d8f0;">${exitSpot}</td>
            <td style="color:#c8d8f0;font-size:0.75rem;">${exitTimeOnly}</td>
            <td style="color:#f59e0b;">${t.stopLoss != null ? inr(parseFloat(t.stopLoss)) : "—"}</td>
            <td style="color:#94a3b8;">${t.rangePts != null ? t.rangePts + "pt" : "—"}</td>
            <td style="color:#94a3b8;">${t.signalStrength || "—"}</td>
            <td>${pnlStr}</td>
            <td style="font-size:0.7rem;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${(t.entryReason || "").replace(/"/g, "&quot;")}">${entryReasonShort}</td>
            <td style="font-size:0.7rem;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${(t.exitReason || "").replace(/"/g, "&quot;")}">${exitReasonShort}</td>
            <td style="text-align:center;padding:4px 8px;"><button onclick="event.stopPropagation();showTradeModal(${actualIdx}, ${ti})" class="copy-btn" style="padding:3px 10px;font-size:0.75rem;">👁 View</button></td>
          </tr>`;
        }).join("");

        return `
        <div class="session-card">
          <div class="session-head" onclick="this.parentElement.classList.toggle('open')">
            <div>
              <div class="session-meta">Session ${sIdx} &middot; ${(s.date || "").slice(0, 10)} &middot; ${s.strategy || "—"}</div>
              <div style="margin-top:4px;display:flex;gap:10px;font-size:0.7rem;color:#4a6080;">
                <span>${trades.length} trade${trades.length !== 1 ? "s" : ""}</span>
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
              <div class="session-wl">${sessionWins}W / ${sessionLosses}L</div>
            </div>
          </div>
          <div class="session-body">
          ${trades.length > 0 ? `
          <div style="overflow-x:auto;">
            <table class="tbl">
              <thead><tr><th>Side</th><th>Date</th><th>E.Spot</th><th>E.Time</th><th>X.Spot</th><th>X.Time</th><th>SL</th><th>Range</th><th>Sig</th><th>PnL</th><th>Entry Reason</th><th>Exit Reason</th><th style="text-align:center;">Action</th></tr></thead>
              <tbody>${tradeRows}</tbody>
            </table>
          </div>` : `<div style="padding:14px 20px;color:#4a6080;font-size:0.82rem;">No trades in this session.</div>`}
          </div>
        </div>`;
      }).join("");

  const sessionsJSON = JSON.stringify(data.sessions || []).replace(/<\/script>/gi, "<\\/script>");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
${faviconLink()}
<title>ORB Paper — History</title>
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
.sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:#10b981;}
.sc-l{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;}
.sc-v{font-size:1.05rem;font-weight:700;font-family:'IBM Plex Mono',monospace;margin-top:3px;}
.session-card{background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;overflow:hidden;margin-bottom:14px;}
.session-head{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;background:#040c18;border-bottom:0.5px solid #0e1e36;gap:12px;flex-wrap:wrap;cursor:pointer;transition:background 0.15s;}
.session-head:hover{background:#060e1c;}
.session-meta{font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;}
.session-pnl{font-size:1.3rem;font-weight:800;font-family:'IBM Plex Mono',monospace;text-align:right;}
.session-wl{font-size:0.66rem;color:#4a6080;text-align:right;margin-top:2px;}
.session-body{display:none;}
.session-card.open .session-body{display:block;}
.tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
.tbl th{padding:8px 10px;text-align:left;font-size:0.55rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#04090f;border-bottom:0.5px solid #0e1e36;}
.tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#4a6080;}
.tbl tr:hover td{background:rgba(16,185,129,0.03);}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.65rem;font-weight:700;}
.badge-ce{background:rgba(16,185,129,0.12);color:#10b981;border:0.5px solid rgba(16,185,129,0.25);}
.badge-pe{background:rgba(239,68,68,0.12);color:#ef4444;border:0.5px solid rgba(239,68,68,0.25);}
.copy-btn{background:#0d1320;border:1px solid #1a2236;color:#10b981;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;}
.copy-btn:hover{background:#072a1c;border-color:#10b981;}
.copy-btn.copied{background:#064e3b;border-color:#10b981;color:#10b981;}
.reset-btn{background:#1a0508;border:0.5px solid #3b0a0a;color:#ef4444;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;}
.reset-btn:hover{background:#2a0810;border-color:#ef4444;}
.toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}
.tool-btn{background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:6px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;}
.tool-btn:hover{border-color:#10b981;color:#10b981;}
.tool-btn.active{background:#072a1c;border-color:#10b981;color:#10b981;}
.ana-panel{display:none;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
.ana-panel.open{display:block;}
.ana-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
@media(max-width:900px){.ana-row{grid-template-columns:1fr;}}
.ana-card{background:#040c18;border:0.5px solid #0e1e36;border-radius:8px;padding:12px;}
.ana-card h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
.ana-chart-wrap{position:relative;height:220px;}
</style></head><body>
<div class="app-shell">
${buildSidebar('orbHistory', liveActive, false)}
<main class="main-content">
  <div class="page-title">📜 ORB Paper Trade History</div>
  <div class="page-sub">All saved sessions · click to expand · per-session copy/delete · analytics panel below</div>
  <div class="stats">
    <div class="sc"><div class="sc-l">Total Trades</div><div class="sc-v">${allTrades.length}</div></div>
    <div class="sc"><div class="sc-l">Total P&L</div><div class="sc-v" style="color:${pnlColor(totalPnl)};">${totalPnl >= 0 ? "+" : ""}${inr(totalPnl)}</div></div>
    <div class="sc"><div class="sc-l">Wins / Losses</div><div class="sc-v">${totalWins} / ${totalLosses}</div></div>
    <div class="sc"><div class="sc-l">Win Rate</div><div class="sc-v">${allTrades.length ? ((totalWins / allTrades.length) * 100).toFixed(1) : "0.0"}%</div></div>
    <div class="sc"><div class="sc-l">Sessions</div><div class="sc-v">${data.sessions.length}</div></div>
    <div class="sc"><div class="sc-l">Capital</div><div class="sc-v">${inr(startCap + totalPnl)}<span style="font-size:0.65rem;color:#4a6080;font-weight:400;"> (from ${inr(startCap)})</span></div></div>
  </div>
  <div class="toolbar">
    <button class="tool-btn" id="anaToggle" onclick="toggleAnalytics()">📊 Analytics</button>
    <button class="tool-btn" onclick="copyAllJsonl(this)">📋 Copy All JSONL</button>
    <a class="tool-btn" href="/orb-paper/download/trades.jsonl" style="text-decoration:none;">⬇ Download trades.jsonl</a>
    <span style="margin-left:auto;font-size:0.65rem;color:#4a6080;align-self:center;">All times IST · click session header to expand</span>
  </div>
  <div class="ana-panel" id="anaPanel">
    <div class="ana-row">
      <div class="ana-card"><h3>📈 All-time Equity Curve</h3><div class="ana-chart-wrap"><canvas id="anaEquity"></canvas></div></div>
      <div class="ana-card"><h3>📊 Daily P&L</h3><div class="ana-chart-wrap"><canvas id="anaDaily"></canvas></div></div>
    </div>
    <div class="ana-row">
      <div class="ana-card"><h3>⏰ Hourly Performance</h3><div class="ana-chart-wrap"><canvas id="anaHourly"></canvas></div></div>
      <div class="ana-card"><h3>📉 Drawdown</h3><div class="ana-chart-wrap"><canvas id="anaDD"></canvas></div></div>
    </div>
  </div>
  ${sessionCards}

  <!-- Trade detail modal -->
  <div id="tradeModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
    <div style="background:#0d1320;border:1px solid #10b981;border-radius:14px;padding:20px 24px;max-width:560px;width:100%;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div id="tmTitle" style="font-weight:700;font-size:0.85rem;">Trade Details</div>
        <button onclick="document.getElementById('tradeModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:#4a6080;cursor:pointer;padding:4px 10px;border-radius:6px;font-family:inherit;">✕ Close</button>
      </div>
      <div id="tmBody"></div>
    </div>
  </div>
</main>
</div>

<script id="sessions-data" type="application/json">${sessionsJSON}</script>
<script>
${modalJS()}
var SESSIONS = JSON.parse(document.getElementById('sessions-data').textContent);
var allTrades = SESSIONS.flatMap(function(s){ return (s.trades||[]).map(function(t){ return Object.assign({}, t, { _date: (s.date||'').slice(0,10) }); }); });
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
    var r = await fetch('/orb-paper/delete-session/' + idx, { method:'POST' });
    var j = await r.json();
    if (j.success) location.reload();
    else alert('Delete failed: ' + (j.error||'unknown'));
  } catch (e) { alert('Delete error: ' + e.message); }
}

function showTradeModal(sIdx, tIdx){
  var t = (SESSIONS[sIdx] && SESSIONS[sIdx].trades && SESSIONS[sIdx].trades[tIdx]);
  if (!t) return;
  var rows = '';
  function row(k, v){ rows += '<tr><td style="padding:6px 10px;font-size:0.7rem;color:#4a6080;text-transform:uppercase;letter-spacing:0.8px;">' + k + '</td><td style="padding:6px 10px;color:#c8d8f0;font-size:0.78rem;font-weight:600;">' + (v != null ? v : '—') + '</td></tr>'; }
  row('Date', t.entryTime ? t.entryTime.split(',')[0] : '—');
  row('Side', t.side);
  row('Symbol', t.symbol);
  row('Strike', t.optionStrike);
  row('Entry Time', t.entryTime);
  row('Exit Time', t.exitTime);
  row('Entry Spot', t.spotAtEntry);
  row('Exit Spot', t.spotAtExit);
  row('Entry Opt LTP', '₹' + t.optionEntryLtp);
  row('Exit Opt LTP', '₹' + t.optionExitLtp);
  row('SL Spot', t.stopLoss);
  row('Target Spot', t.targetSpot);
  row('OR Range', t.orl + ' / ' + t.orh + ' (' + t.rangePts + 'pt)');
  row('Signal Strength', t.signalStrength);
  row('VIX at Entry', t.vixAtEntry);
  row('Held (candles)', t.candlesHeld);
  row('Charges', '₹' + t.charges);
  row('P&L', '<span style="color:' + (t.pnl>=0?'#10b981':'#ef4444') + ';">' + (t.pnl>=0?'+':'') + '₹' + (t.pnl||0).toFixed(2) + '</span>');
  rows += '<tr><td colspan="2" style="padding:10px;background:#040c18;border-top:0.5px solid #0e1e36;color:#94a3b8;font-size:0.75rem;white-space:pre-wrap;">' + (t.entryReason || '') + '</td></tr>';
  rows += '<tr><td colspan="2" style="padding:10px;background:#040c18;color:#94a3b8;font-size:0.75rem;white-space:pre-wrap;">' + (t.exitReason || '') + '</td></tr>';
  document.getElementById('tmTitle').textContent = t.side + ' · ' + (t.entryTime || '');
  document.getElementById('tmBody').innerHTML = '<table style="width:100%;border-collapse:collapse;">' + rows + '</table>';
  document.getElementById('tradeModal').style.display = 'flex';
}

// ── Analytics ───────────────────────────────────────────────────────────
function toggleAnalytics(){
  var p = document.getElementById('anaPanel');
  var btn = document.getElementById('anaToggle');
  p.classList.toggle('open');
  btn.classList.toggle('active');
  if (p.classList.contains('open')) renderAna();
}
function renderAna(){
  if (!allTrades.length) return;
  Object.values(anaCharts).forEach(function(c){ if(c) c.destroy(); });
  var _gc = '#0e1428', _tc = '#3a5070';

  // Equity
  var cum = 0, labels = [], cumArr = [];
  allTrades.forEach(function(t,i){ cum += (t.pnl||0); cumArr.push(cum); labels.push(i+1); });
  anaCharts.eq = new Chart(document.getElementById('anaEquity'), { type:'line', data:{ labels:labels, datasets:[{ data:cumArr, borderColor:'#10b981', borderWidth:1.5, backgroundColor:'rgba(16,185,129,0.1)', fill:true, pointRadius:0, tension:0.3 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{display:false}, y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}} } } });

  // Daily P&L
  var dailyMap = {};
  allTrades.forEach(function(t){ var d=t._date; if(!dailyMap[d]) dailyMap[d]=0; dailyMap[d]+=(t.pnl||0); });
  var dKeys = Object.keys(dailyMap).sort();
  var dVals = dKeys.map(function(k){ return Math.round(dailyMap[k]); });
  var dCols = dVals.map(function(v){ return v>=0?'#10b981':'#ef4444'; });
  anaCharts.daily = new Chart(document.getElementById('anaDaily'), { type:'bar', data:{ labels:dKeys, datasets:[{ data:dVals, backgroundColor:dCols, borderRadius:3, barPercentage:0.8 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false},ticks:{color:_tc,font:{size:9},maxTicksLimit:8}}, y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}} } } });

  // Hourly
  var hourMap = {};
  allTrades.forEach(function(t){ var hM = (t.entryTime||'').match(/(\\d{1,2}):\\d{2}/); if(!hM) return; var h = parseInt(hM[1]); if(!hourMap[h]) hourMap[h]={pnl:0,cnt:0}; hourMap[h].pnl+=(t.pnl||0); hourMap[h].cnt++; });
  var hKeys = Object.keys(hourMap).map(Number).sort(function(a,b){return a-b;});
  anaCharts.hr = new Chart(document.getElementById('anaHourly'), { type:'bar', data:{ labels:hKeys.map(function(h){return h+':00';}), datasets:[{ data:hKeys.map(function(h){return Math.round(hourMap[h].pnl);}), backgroundColor:hKeys.map(function(h){return hourMap[h].pnl>=0?'rgba(16,185,129,0.7)':'rgba(239,68,68,0.7)';}), borderRadius:3, barPercentage:0.7 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false},ticks:{color:_tc,font:{size:10}}}, y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}} } } });

  // Drawdown
  var eq2 = 0, peak = 0, ddArr = [];
  allTrades.forEach(function(t){ eq2+=(t.pnl||0); if(eq2>peak) peak=eq2; ddArr.push(eq2-peak); });
  anaCharts.dd = new Chart(document.getElementById('anaDD'), { type:'line', data:{ labels:labels, datasets:[{ data:ddArr, borderColor:'#ef4444', borderWidth:1.5, backgroundColor:'rgba(239,68,68,0.12)', fill:true, pointRadius:0, tension:0.3 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{display:false}, y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}} } } });
}

// Expand the most recent session by default
(function(){ var first = document.querySelector('.session-card'); if (first) first.classList.add('open'); })();
</script>
</body></html>`);
});

// Delete a session by index (newest = last in array)
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
    res.setHeader("Content-Disposition", `attachment; filename="orb_paper_trades_${new Date().toISOString().slice(0,10)}.jsonl"`);
    res.send(lines.join("\n"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Error helper ────────────────────────────────────────────────────────────

function _errorPage(title, message, backHref, backLabel) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>${faviconLink()}<title>${title}</title>
<style>body{font-family:Inter,sans-serif;background:#040c18;color:#e0eaf8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{color:#94a3b8;margin-bottom:18px;}
a{color:#3b82f6;text-decoration:none;border:0.5px solid #0e1e36;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>${title}</h2><p>${message}</p><a href="${backHref}">${backLabel}</a></body></html>`;
}

module.exports = router;
module.exports.stopSession = stopSession;

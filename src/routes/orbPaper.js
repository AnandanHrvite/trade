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

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
${faviconLink()}
<title>ORB Paper Trade</title>
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
.sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:#10b981;}
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
@media(max-width:900px){.pos-row{grid-template-columns:repeat(2,1fr);}}
</style></head><body>
<div class="app-shell">
${buildSidebar('orbPaper', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/orb-paper/start'`, startLabel: '▶ Start ORB',
  showStopBtn: state.running,   stopBtnJs:  `location.href='/orb-paper/stop'`,  stopLabel:  '■ Stop ORB',
  showExitBtn: state.running && !!state.position, exitBtnJs: `location.href='/orb-paper/exit'`, exitLabel: '🚪 Exit Trade',
})}
<main class="main">
  <div class="crumb">
    <span class="chip" style="background:rgba(16,185,129,0.1);color:#10b981;border:0.5px solid rgba(16,185,129,0.3);">📋 ORB PAPER</span>
    <span style="color:#1e2a40;font-size:10px;">›</span>
    <span class="chip" style="background:rgba(245,158,11,0.1);color:#fbbf24;border:0.5px solid rgba(245,158,11,0.2);">${orbStrategy.NAME}</span>
    <span style="color:#1e2a40;font-size:10px;">›</span>
    <span class="chip" id="crumb-status" style="background:rgba(74,96,128,0.15);color:#94a3b8;border:0.5px solid rgba(74,96,128,0.3);">—</span>
    <span style="margin-left:auto;font-size:0.6rem;color:#1e2a40;font-family:'IBM Plex Mono',monospace;" id="crumb-tick">— ticks · — candles</span>
  </div>
  <div class="page-title">📋 ORB Paper Trade <span style="font-size:0.65rem;color:#4a6080;font-weight:400;margin-left:8px;">opening range breakout · simulated orders · live data</span></div>
  <div class="page-sub">Single-leg ATM option buy on 15-min OR break. Square-off ${process.env.ORB_FORCED_EXIT || "15:15"} IST.</div>

  <!-- Stat grid (8 cards) -->
  <div class="grid">
    <div class="sc"><div class="sc-label">Status</div><div class="sc-val" id="status">—</div><div class="sc-sub" id="status-sub">—</div></div>
    <div class="sc blue"><div class="sc-label">Session P&L</div><div class="sc-val" id="pnl">—</div><div class="sc-sub" id="pnl-sub">— closed trades</div></div>
    <div class="sc"><div class="sc-label">Live PnL</div><div class="sc-val" id="livePnl">—</div><div class="sc-sub" id="livePnl-sub">unrealised</div></div>
    <div class="sc yellow"><div class="sc-label">Win Rate</div><div class="sc-val" id="wr">—</div><div class="sc-sub" id="wr-sub">— W · — L</div></div>
    <div class="sc"><div class="sc-label">Best Trade</div><div class="sc-val pos" id="bestT">—</div><div class="sc-sub">single best</div></div>
    <div class="sc red"><div class="sc-label">Worst Trade</div><div class="sc-val neg" id="worstT">—</div><div class="sc-sub">single worst</div></div>
    <div class="sc purple"><div class="sc-label">Spot · VIX</div><div class="sc-val" id="spotVix">—</div><div class="sc-sub" id="orRange">—</div></div>
    <div class="sc"><div class="sc-label">All-Time</div><div class="sc-val" id="totalPnl">—</div><div class="sc-sub">since first session</div></div>
  </div>

  <!-- Position panel (rich) -->
  <div class="panel">
    <h3><span>📌 Open Position</span><span id="livePnlBadge" style="font-size:0.85rem;color:#94a3b8;"></span></h3>
    <div id="position-box" class="empty">No open position — waiting for ORB break</div>
    <div id="manual-entry" style="display:none;margin-top:10px;text-align:right;">
      <button onclick="doManualEntry('CE')" style="background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.4);padding:6px 14px;border-radius:5px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;margin-right:8px;">🟢 Manual CE Entry</button>
      <button onclick="doManualEntry('PE')" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.4);padding:6px 14px;border-radius:5px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">🔴 Manual PE Entry</button>
    </div>
  </div>

  <!-- Live NIFTY chart with OR overlay + trade markers -->
  <div class="panel">
    <h3><span>📊 Live NIFTY 5-min (Opening Range overlay)</span>
      <span style="font-size:0.6rem;color:#4a6080;display:flex;gap:10px;">
        <span><span style="display:inline-block;width:10px;height:2px;background:#10b981;vertical-align:middle;"></span> ORH</span>
        <span><span style="display:inline-block;width:10px;height:2px;background:#ef4444;vertical-align:middle;"></span> ORL</span>
        <span><span style="display:inline-block;width:10px;height:1px;background:#3b82f6;border-top:1px dotted #3b82f6;vertical-align:middle;"></span> Entry</span>
        <span><span style="display:inline-block;width:10px;height:1px;background:#f59e0b;border-top:1px dashed #f59e0b;vertical-align:middle;"></span> SL</span>
        <span><span style="display:inline-block;width:10px;height:1px;background:#10b981;border-top:1px dashed #10b981;vertical-align:middle;"></span> Target</span>
      </span>
    </h3>
    <div id="niftyChart" style="position:relative;height:340px;"></div>
  </div>

  <!-- Cumulative P&L chart -->
  <div class="panel">
    <h3><span>📈 Today&apos;s Cumulative P&amp;L</span><span id="chartHint" style="font-size:0.6rem;color:#4a6080;">— trades</span></h3>
    <div class="chart-wrap"><canvas id="pnlChart"></canvas></div>
  </div>

  <!-- Session trades -->
  <div class="panel">
    <h3><span>📜 Session Trades (today)</span><span id="tradesHint" style="font-size:0.6rem;color:#4a6080;">— trades</span></h3>
    <div id="trades-box" class="empty">No trades yet</div>
  </div>

  <!-- Activity log -->
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

// ── Lightweight Charts setup (live NIFTY view) ──
var _niftyChart = null, _csSeries = null, _orhSeries = null, _orlSeries = null;
var _entryLine = null, _slLine = null, _targetLine = null;
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
  _orhSeries = _niftyChart.addLineSeries({ color:'#10b981', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  _orlSeries = _niftyChart.addLineSeries({ color:'#ef4444', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  window.addEventListener('resize', function(){ if (_niftyChart) _niftyChart.applyOptions({ width: container.clientWidth }); });
}
async function refreshChart(){
  ensureNiftyChart();
  if (!_csSeries) return;
  try {
    var r = await fetch('/orb-paper/status/chart-data', { cache: 'no-store' });
    var d = await r.json();
    if (d.candles && d.candles.length) _csSeries.setData(d.candles);
    if (d.orhLine && d.orhLine.length) _orhSeries.setData(d.orhLine); else _orhSeries.setData([]);
    if (d.orlLine && d.orlLine.length) _orlSeries.setData(d.orlLine); else _orlSeries.setData([]);
    if (d.markers) _csSeries.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
    // Re-create price lines (entry/SL/target) for open position
    if (_entryLine)  { _csSeries.removePriceLine(_entryLine);  _entryLine = null; }
    if (_slLine)     { _csSeries.removePriceLine(_slLine);     _slLine = null; }
    if (_targetLine) { _csSeries.removePriceLine(_targetLine); _targetLine = null; }
    if (d.entryPrice) _entryLine = _csSeries.createPriceLine({ price: d.entryPrice, color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
    if (d.stopLoss)   _slLine    = _csSeries.createPriceLine({ price: d.stopLoss,   color:'#f59e0b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'SL' });
    if (d.target)     _targetLine = _csSeries.createPriceLine({ price: d.target,    color:'#10b981', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'Target' });
  } catch (e) { /* swallow */ }
}

async function refresh() {
  try {
    const r = await fetch('/orb-paper/status/data', {cache:'no-store'});
    const d = await r.json();
    var pnlCls = d.sessionPnl > 0 ? 'pos' : d.sessionPnl < 0 ? 'neg' : 'muted';

    document.getElementById('status').innerHTML = d.running ? '<span class="pos">RUNNING</span>' : '<span class="muted">STOPPED</span>';
    document.getElementById('status-sub').textContent = d.tradesTaken + ' trades taken';
    document.getElementById('crumb-status').innerHTML = d.running ? '<span style="color:#10b981;">● RUNNING</span>' : '<span style="color:#94a3b8;">○ STOPPED</span>';
    document.getElementById('crumb-tick').textContent = (d.tickCount||0) + ' ticks · ' + (d.candles||0) + ' candles';
    document.getElementById('pnl').innerHTML    = '<span class="' + pnlCls + '">₹' + d.sessionPnl.toFixed(2) + '</span>';
    document.getElementById('pnl-sub').textContent = (d.tradesTaken||0) + ' trade' + ((d.tradesTaken||0)===1?'':'s') + ' closed';
    if(d.livePnl != null){
      var lc = d.livePnl > 0 ? 'pos' : d.livePnl < 0 ? 'neg' : 'muted';
      document.getElementById('livePnl').innerHTML = '<span class="' + lc + '">₹' + d.livePnl.toFixed(2) + '</span>';
      document.getElementById('livePnl-sub').textContent = 'unrealised (live option LTP)';
    } else {
      document.getElementById('livePnl').textContent = '—';
      document.getElementById('livePnl-sub').textContent = 'no open position';
    }
    document.getElementById('wr').textContent = (d.winRate != null ? d.winRate + '%' : '—');
    document.getElementById('wr-sub').textContent = (d.wins||0) + 'W · ' + (d.losses||0) + 'L';
    document.getElementById('bestT').textContent = d.bestTrade != null ? '₹' + d.bestTrade.toFixed(0) : '—';
    document.getElementById('worstT').textContent = d.worstTrade != null ? '₹' + d.worstTrade.toFixed(0) : '—';
    document.getElementById('spotVix').textContent = (d.lastTickPrice ? d.lastTickPrice.toFixed(2) : '—') + ' · VIX ' + (d.vix != null ? d.vix.toFixed(1) : '—');
    document.getElementById('orRange').textContent = (d.orh && d.orl) ? 'OR ' + d.orh + '/' + d.orl + ' (' + d.rangePts + 'pt)' : 'OR not yet formed';
    document.getElementById('totalPnl').innerHTML = '<span class="' + (d.totalPnl>=0?'pos':'neg') + '">₹' + (d.totalPnl||0).toLocaleString('en-IN', {maximumFractionDigits:0}) + '</span>';

    // Log
    _rawLog = d.log || [];
    filterLog();

    // Position
    if (d.position) {
      const p = d.position;
      const pCls = (p.side === 'CE') ? 'pos' : 'neg';
      const liveOpt = p.currentOptLtp != null ? p.currentOptLtp : null;
      const liveBadge = (d.livePnl != null) ? '<span class="' + (d.livePnl>=0?'pos':'neg') + '">₹' + d.livePnl.toFixed(0) + '</span>' : '—';
      document.getElementById('livePnlBadge').innerHTML = liveBadge + ' live';
      document.getElementById('manual-entry').style.display = 'none';
      // Premium move detail
      const optMove = (liveOpt != null) ? (liveOpt - p.optionEntryLtp) : null;
      const optMovePct = (liveOpt != null && p.optionEntryLtp) ? (optMove / p.optionEntryLtp) * 100 : null;
      const spotMove = (d.lastTickPrice != null) ? (d.lastTickPrice - p.entrySpot) * (p.side === 'CE' ? 1 : -1) : null;
      const moveCls = optMove != null && optMove >= 0 ? 'pos' : 'neg';
      document.getElementById('position-box').className = '';
      document.getElementById('position-box').innerHTML =
        '<div class="pos-row" style="margin-bottom:10px;">' +
        '  <div class="pos-cell"><div class="pos-cell-l">Side</div><div class="pos-cell-v ' + pCls + '">' + p.side + ' [' + (p.signalStrength||'—') + ']</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Strike (Symbol)</div><div class="pos-cell-v" style="font-size:0.72rem;">' + p.symbol + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Entry Spot · Time</div><div class="pos-cell-v">' + p.entrySpot + '<span style="font-weight:400;color:#94a3b8;font-size:0.7rem;"> · ' + p.entryTime + '</span></div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Qty</div><div class="pos-cell-v">' + p.qty + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">OR Range</div><div class="pos-cell-v">' + p.orl + '/' + p.orh + ' (' + p.rangePts + 'pt)</div></div>' +
        '</div>' +
        '<div class="pos-row" style="margin-bottom:10px;">' +
        '  <div class="pos-cell"><div class="pos-cell-l">Entry Option LTP</div><div class="pos-cell-v">₹' + p.optionEntryLtp + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Current Option LTP</div><div class="pos-cell-v ' + (liveOpt != null && liveOpt >= p.optionEntryLtp ? 'pos' : 'neg') + '">' + (liveOpt != null ? '₹' + liveOpt : '—') + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Option Move ₹ · %</div><div class="pos-cell-v ' + moveCls + '">' + (optMove != null ? (optMove>=0?'+':'') + '₹' + optMove.toFixed(2) + ' · ' + (optMovePct>=0?'+':'') + optMovePct.toFixed(1) + '%' : '—') + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Spot Move (favour)</div><div class="pos-cell-v ' + (spotMove != null && spotMove >= 0 ? 'pos' : 'neg') + '">' + (spotMove != null ? (spotMove>=0?'+':'') + spotMove.toFixed(1) + 'pt' : '—') + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Live P&amp;L</div><div class="pos-cell-v ' + (d.livePnl != null && d.livePnl >= 0 ? 'pos' : d.livePnl != null ? 'neg' : 'muted') + '">' + (d.livePnl != null ? '₹' + d.livePnl.toFixed(2) : '—') + '</div></div>' +
        '</div>' +
        '<div class="pos-row">' +
        '  <div class="pos-cell"><div class="pos-cell-l">Premium Target / Stop</div><div class="pos-cell-v"><span class="pos">₹' + p.targetPremium + '</span> / <span class="neg">₹' + p.stopPremium + '</span></div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Spot Target / SL</div><div class="pos-cell-v"><span class="pos">' + p.targetSpot + '</span> / <span class="neg">' + p.slSpot + '</span></div></div>' +
        '</div>';
    } else {
      document.getElementById('position-box').className = 'empty';
      document.getElementById('position-box').textContent = d.running ? 'No open position — waiting for ORB break' : 'No open position';
      document.getElementById('livePnlBadge').textContent = '';
      // Only show manual entry buttons when running and flat (and entry window still open)
      document.getElementById('manual-entry').style.display = d.running ? 'block' : 'none';
    }

    // Trades table
    const trades = d.sessionTrades || [];
    document.getElementById('tradesHint').textContent = trades.length + ' trade' + (trades.length===1?'':'s');
    if (trades.length) {
      const rows = trades.slice().reverse().map(function(t){
        var cls = t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : 'muted');
        return '<tr><td>' + (t.entryTime||'') + '</td><td>' + (t.exitTime||'') + '</td><td class="' + (t.side==='CE'?'pos':'neg') + '"><b>' + (t.side||'') + '</b></td><td>' + (t.spotAtEntry||'') + '</td><td>' + (t.spotAtExit||'') + '</td><td>₹' + (t.optionEntryLtp||'') + '</td><td>₹' + (t.optionExitLtp||'') + '</td><td>' + (t.rangePts || '—') + '</td><td>' + (t.signalStrength || '—') + '</td><td class="' + cls + '"><b>₹' + (t.pnl != null ? t.pnl.toFixed(2) : '—') + '</b></td><td style="color:#94a3b8;font-size:0.65rem;">' + (t.exitReason||'') + '</td></tr>';
      }).join('');
      document.getElementById('trades-box').className = '';
      document.getElementById('trades-box').innerHTML = '<table><tr><th>Entry</th><th>Exit</th><th>Side</th><th>E.Spot</th><th>X.Spot</th><th>E.Opt</th><th>X.Opt</th><th>Range</th><th>Sig</th><th>PnL</th><th>Exit Reason</th></tr>' + rows + '</table>';
    } else {
      document.getElementById('trades-box').className = 'empty';
      document.getElementById('trades-box').textContent = 'No trades yet';
    }

    // Chart
    renderChart(d.cumPnl || []);
    document.getElementById('chartHint').textContent = (d.cumPnl ? d.cumPnl.length : 0) + ' closed';
    refreshChart();
  } catch (e) {}
}

function filterLog(){
  var q = (document.getElementById('logSearch').value || '').toLowerCase();
  var lines = q ? _rawLog.filter(function(l){ return l.toLowerCase().indexOf(q) >= 0; }) : _rawLog;
  document.getElementById('log').textContent = lines.join('\\n');
}

async function doManualEntry(side){
  if (!confirm('Place a MANUAL ' + side + ' entry? This bypasses the ORB break filter.')) return;
  try {
    const r = await fetch('/orb-paper/manualEntry', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ side: side }) });
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
  var col = endP >= 0 ? '#10b981' : '#ef4444';
  _pnlChart = new Chart(ctx, {
    type:'line',
    data:{ labels: labels, datasets:[{ data: data, borderColor: col, borderWidth: 2, backgroundColor: col+'22', fill: true, pointRadius: 3, tension: 0.3 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}, tooltip:{callbacks:{title:function(ctx){return 'Trade #'+ctx[0].label;}, label:function(ctx){return '₹'+Math.round(ctx.raw).toLocaleString('en-IN');}}}}, scales:{ x:{ticks:{color:'#3a5070',font:{size:9}}, grid:{display:false}}, y:{ticks:{color:'#3a5070',font:{size:9},callback:function(v){return '₹'+Math.round(v/1000)+'k';}}, grid:{color:'#0e1e36'}} } }
  });
}

refresh();
setInterval(refresh, 2000);
</script>
</div></body></html>`;
  res.send(html);
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

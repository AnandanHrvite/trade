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

async function onCandleClose(_bar) {
  // Already in position? Don't re-evaluate entry — exits run on tick.
  if (state.position) return;

  // Daily-loss kill
  const maxLoss = parseFloat(process.env.ORB_MAX_DAILY_LOSS || "3000");
  if (state.sessionPnl <= -maxLoss) {
    return; // silent — already logged once
  }

  // Max trades guard (default 1 — ORB is 1/day)
  const maxTrades = parseInt(process.env.ORB_MAX_DAILY_TRADES || "1", 10);
  if (state.tradesTaken >= maxTrades) return;

  // Expiry-day-only filter
  if (state._expiryDayBlocked) return;

  // Evaluate ORB signal
  const sig = orbStrategy.getSignal(state.candles, { alreadyTraded: state.tradesTaken >= maxTrades });
  if (sig.signal === "NONE" || !sig.side) return;

  // VIX gate
  if ((process.env.ORB_VIX_ENABLED || "false").toLowerCase() === "true") {
    const vixCheck = await checkLiveVix(sig.signalStrength, { mode: "orb" });
    if (!vixCheck.allowed) {
      log(`⏸️ [ORB-PAPER] VIX gate blocked: ${vixCheck.reason}`);
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
      document.getElementById('position-box').className = '';
      document.getElementById('position-box').innerHTML =
        '<div class="pos-row" style="margin-bottom:10px;">' +
        '  <div class="pos-cell"><div class="pos-cell-l">Side</div><div class="pos-cell-v ' + pCls + '">' + p.side + ' [' + (p.signalStrength||'—') + ']</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Strike (Symbol)</div><div class="pos-cell-v" style="font-size:0.72rem;">' + p.symbol + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Entry Spot · Time</div><div class="pos-cell-v">' + p.entrySpot + '<span style="font-weight:400;color:#94a3b8;font-size:0.7rem;"> · ' + p.entryTime + '</span></div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Qty</div><div class="pos-cell-v">' + p.qty + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">OR Range</div><div class="pos-cell-v">' + p.orl + '/' + p.orh + ' (' + p.rangePts + 'pt)</div></div>' +
        '</div>' +
        '<div class="pos-row">' +
        '  <div class="pos-cell"><div class="pos-cell-l">Entry Option LTP</div><div class="pos-cell-v">₹' + p.optionEntryLtp + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Current Option LTP</div><div class="pos-cell-v ' + (liveOpt != null && liveOpt >= p.optionEntryLtp ? 'pos' : 'neg') + '">' + (liveOpt != null ? '₹' + liveOpt : '—') + '</div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Premium Target / Stop</div><div class="pos-cell-v"><span class="pos">₹' + p.targetPremium + '</span> / <span class="neg">₹' + p.stopPremium + '</span></div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Spot Target / SL</div><div class="pos-cell-v"><span class="pos">' + p.targetSpot + '</span> / <span class="neg">' + p.slSpot + '</span></div></div>' +
        '  <div class="pos-cell"><div class="pos-cell-l">Live P&amp;L</div><div class="pos-cell-v ' + (d.livePnl != null && d.livePnl >= 0 ? 'pos' : d.livePnl != null ? 'neg' : 'muted') + '">' + (d.livePnl != null ? '₹' + d.livePnl.toFixed(2) : '—') + '</div></div>' +
        '</div>';
    } else {
      document.getElementById('position-box').className = 'empty';
      document.getElementById('position-box').textContent = d.running ? 'No open position — waiting for ORB break' : 'No open position';
      document.getElementById('livePnlBadge').textContent = '';
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
</body></html>`;
  res.send(html);
});

// ── History page (reuses backtestUI renderer for full parity) ────────────────

router.get("/history", (req, res) => {
  const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
  const data = loadData();

  // Flatten all sessions into the backtestUI trade shape
  const trades = [];
  for (const sess of (data.sessions || [])) {
    for (const t of (sess.trades || [])) {
      const entryTs = parseEntryTimeToTs(t.entryTime, sess.date);
      const exitTs  = parseEntryTimeToTs(t.exitTime,  sess.date);
      trades.push({
        side: t.side,
        entry: t.entryTime || "",
        exit:  t.exitTime  || "",
        entryTs, exitTs,
        ePrice: t.spotAtEntry,
        xPrice: t.spotAtExit,
        sl: t.stopLoss != null ? t.stopLoss : t.initialStopLoss,
        pnl: t.pnl,
        reason: t.exitReason,
        entryReason: t.entryReason,
        rangePts: t.rangePts,
        strength: t.signalStrength,
        eOpt: t.optionEntryLtp,
        xOpt: t.optionExitLtp,
        symbol: t.symbol,
      });
    }
  }
  trades.sort((a, b) => (b.entryTs || 0) - (a.entryTs || 0));
  const stats = computeBacktestStats(trades);

  // Determine date range from trades
  const dates = trades.map(t => (t.entry || "").split(",")[0].trim()).filter(Boolean);
  const fromDate = dates.length ? dates[dates.length - 1] : "—";
  const toDate   = dates.length ? dates[0] : "—";

  res.send(renderBacktestResults({
    mode: "ORB HISTORY",
    accent: "#10b981",
    strategyName: orbStrategy.NAME,
    endpoint: "/orb-paper/history",
    from: fromDate, to: toDate,
    summary: stats,
    trades,
    activePage: "orbHistory",
    extraTradeColumns: [
      { key: "rangePts", label: "Range (pt)" },
      { key: "strength", label: "Sig" },
      { key: "symbol", label: "Symbol" },
    ],
    extraStats: [
      { label: "Avg OR Range", value: trades.length ? `${Math.round(trades.reduce((a, t) => a + (t.rangePts || 0), 0) / trades.length)}pt` : "—" },
      { label: "STRONG Trades", value: trades.filter(t => t.strength === "STRONG").length },
      { label: "Sessions", value: data.sessions ? data.sessions.length : 0 },
      { label: "Capital", value: `₹${(data.capital || 0).toLocaleString("en-IN")}` },
    ],
    notes: "All paper-trade trades, every session. Filters/sorts/pagination active. Use the date range and presets to scope.",
  }));
});

// Parse "DD/MM/YYYY, HH:MM:SS" → unix sec (treats as IST). Falls back to session date.
function parseEntryTimeToTs(timeStr, fallbackDate) {
  if (!timeStr) {
    if (!fallbackDate) return 0;
    return Math.floor(new Date(fallbackDate).getTime() / 1000);
  }
  const m = timeStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, y = parseInt(m[3], 10);
    const h = parseInt(m[4], 10), mi = parseInt(m[5], 10), s = m[6] ? parseInt(m[6], 10) : 0;
    return Math.floor(Date.UTC(y, mo, d, h, mi, s) / 1000) - 19800;
  }
  return Math.floor(Date.now() / 1000);
}

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

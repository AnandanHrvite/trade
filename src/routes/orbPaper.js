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

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const data = loadData();

  // Compute OR (if formed)
  let or = null;
  try { or = orbStrategy.computeOpeningRange(state.candles); } catch (_) {}

  res.json({
    running:        state.running,
    sessionPnl:     state.sessionPnl,
    tradesTaken:    state.tradesTaken,
    sessionTrades:  state.sessionTrades.slice(-30),
    log:            state.log.slice(-50),
    tickCount:      state.tickCount,
    lastTickPrice:  state.lastTickPrice,
    candles:        state.candles.length,
    optionLtp:      state.optionLtp,
    optionLtpAgeSec: optAge,
    vix:            getCachedVix(),
    orh:            or && or.high,
    orl:            or && or.low,
    rangePts:       or ? Math.round((or.high - or.low) * 100) / 100 : null,
    position: pos ? {
      side: pos.side, symbol: pos.symbol,
      entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      slSpot: pos.slSpot, targetSpot: pos.targetSpot,
      targetPremium: pos.targetPremium, stopPremium: pos.stopPremium,
      entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      orh: pos.orh, orl: pos.orl, rangePts: pos.rangePts,
      qty: pos.qty,
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
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;}
${sidebarCSS()}
${modalCSS()}
${tableEnhancerCSS ? tableEnhancerCSS() : ""}
.main{flex:1;margin-left:200px;padding:16px 22px 40px;min-height:100vh;}
@media(max-width:900px){.main{margin-left:0;padding:14px;}}
.page-title{font-size:1.05rem;font-weight:700;margin-bottom:2px;}
.page-sub{font-size:0.7rem;color:#4a6080;margin-bottom:12px;}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:14px;}
@media(max-width:1100px){.grid{grid-template-columns:repeat(3,1fr);}}
@media(max-width:560px){.grid{grid-template-columns:repeat(2,1fr);}}
.sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:11px 13px;position:relative;overflow:hidden;}
.sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:#3b82f6;}
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
${buildSidebar('orbPaper', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/orb-paper/start'`, startLabel: '▶ Start ORB',
  showStopBtn: state.running,   stopBtnJs:  `location.href='/orb-paper/stop'`,  stopLabel:  '■ Stop ORB',
  showExitBtn: state.running,   exitBtnJs:  `location.href='/orb-paper/exit'`,  exitLabel:  '🚪 Exit Trade',
})}
<main class="main">
  <div class="page-title">📋 ORB Paper Trade</div>
  <div class="page-sub">${orbStrategy.NAME} — opening range breakout (live data, simulated orders)</div>
  <div class="grid">
    <div class="sc"><div class="sc-label">Status</div><div class="sc-val" id="status">—</div></div>
    <div class="sc"><div class="sc-label">Session P&L</div><div class="sc-val" id="pnl">—</div></div>
    <div class="sc"><div class="sc-label">Trades</div><div class="sc-val" id="trades">—</div></div>
    <div class="sc"><div class="sc-label">Spot</div><div class="sc-val" id="spot">—</div></div>
    <div class="sc"><div class="sc-label">OR Range</div><div class="sc-val" id="or">—</div></div>
    <div class="sc"><div class="sc-label">VIX</div><div class="sc-val" id="vix">—</div></div>
  </div>
  <div class="panel"><h3>Position</h3><div id="position-box" class="empty">No open position</div></div>
  <div class="panel"><h3>Session Trades</h3><div id="trades-box" class="empty">No trades yet</div></div>
  <div class="panel"><h3>Activity Log</h3><div id="log" class="log">—</div></div>
</main>
<script>
${modalJS()}
${toastJS ? toastJS() : ""}
async function refresh() {
  try {
    const r = await fetch('/orb-paper/status/data');
    const d = await r.json();
    document.getElementById('status').innerHTML = d.running ? '<span class="pos">RUNNING</span>' : '<span class="muted">STOPPED</span>';
    document.getElementById('pnl').innerHTML    = '<span class="' + (d.sessionPnl > 0 ? 'pos' : d.sessionPnl < 0 ? 'neg' : 'muted') + '">₹' + d.sessionPnl.toFixed(2) + '</span>';
    document.getElementById('trades').textContent = d.tradesTaken;
    document.getElementById('spot').textContent = d.lastTickPrice ? d.lastTickPrice.toFixed(2) : '—';
    document.getElementById('or').textContent = (d.orh && d.orl) ? d.orh + '/' + d.orl + ' (' + d.rangePts + 'pt)' : '—';
    document.getElementById('vix').textContent = d.vix != null ? d.vix.toFixed(2) : '—';
    document.getElementById('log').textContent = (d.log || []).join('\\n');

    if (d.position) {
      const p = d.position;
      const pCls = (p.side === 'CE') ? 'pos' : 'neg';
      document.getElementById('position-box').innerHTML =
        '<table><tr><th>Side</th><th>Symbol</th><th>Strike</th><th>Entry Spot</th><th>Entry Opt LTP</th><th>SL Spot</th><th>Target Spot</th><th>Target Prem</th><th>Stop Prem</th><th>Qty</th></tr>' +
        '<tr><td class="' + pCls + '"><b>' + p.side + '</b></td><td>' + p.symbol + '</td><td>' + (p.orh && p.orl ? p.orh + '/' + p.orl : '—') + '</td><td>' + p.entrySpot + '</td><td>₹' + p.optionEntryLtp + '</td><td>' + p.slSpot + '</td><td>' + p.targetSpot + '</td><td>₹' + p.targetPremium + '</td><td>₹' + p.stopPremium + '</td><td>' + p.qty + '</td></tr></table>';
    } else {
      document.getElementById('position-box').className = 'empty';
      document.getElementById('position-box').textContent = 'No open position';
    }

    const trades = d.sessionTrades || [];
    if (trades.length) {
      const rows = trades.slice().reverse().map(function(t){
        var cls = t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : 'muted');
        return '<tr><td>' + (t.entryTime||'') + '</td><td>' + (t.side||'') + '</td><td>' + (t.symbol||'') + '</td><td>' + (t.spotAtEntry||'') + '</td><td>' + (t.spotAtExit||'') + '</td><td>₹' + (t.optionEntryLtp||'') + '</td><td>₹' + (t.optionExitLtp||'') + '</td><td class="' + cls + '"><b>₹' + (t.pnl != null ? t.pnl.toFixed(2) : '—') + '</b></td><td style="color:#94a3b8">' + (t.exitReason||'') + '</td></tr>';
      }).join('');
      document.getElementById('trades-box').className = '';
      document.getElementById('trades-box').innerHTML = '<table><tr><th>Entry</th><th>Side</th><th>Symbol</th><th>E.Spot</th><th>X.Spot</th><th>E.Opt</th><th>X.Opt</th><th>PnL</th><th>Exit</th></tr>' + rows + '</table>';
    } else {
      document.getElementById('trades-box').className = 'empty';
      document.getElementById('trades-box').textContent = 'No trades yet';
    }
  } catch (e) { /* swallow — keep polling */ }
}
refresh();
setInterval(refresh, 2000);
</script>
</body></html>`;
  res.send(html);
});

// ── History page ────────────────────────────────────────────────────────────

router.get("/history", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const data = loadData();
  const allTrades = [];
  for (const s of (data.sessions || [])) {
    for (const t of (s.trades || [])) {
      allTrades.push({
        date:       (s.date || "").slice(0, 10),
        side:       t.side, symbol: t.symbol,
        strike:     t.optionStrike, expiry: t.optionExpiry,
        entryTime:  t.entryTime, exitTime: t.exitTime,
        spotEntry:  t.spotAtEntry, spotExit: t.spotAtExit,
        optEntry:   t.optionEntryLtp, optExit: t.optionExitLtp,
        pnl:        t.pnl, exitReason: t.exitReason,
        strength:   t.signalStrength, rangePts: t.rangePts,
      });
    }
  }
  allTrades.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const wins = allTrades.filter(t => t.pnl > 0).length;
  const losses = allTrades.filter(t => t.pnl < 0).length;
  const wr = allTrades.length ? ((wins / allTrades.length) * 100).toFixed(1) : "0.0";
  const totalPnl = allTrades.reduce((a, t) => a + (t.pnl || 0), 0);

  const rows = allTrades.map(t => {
    const cls = t.pnl > 0 ? "pos" : t.pnl < 0 ? "neg" : "muted";
    return `<tr><td>${t.date}</td><td>${t.entryTime || ""}</td><td>${t.side || ""}</td><td>${t.symbol || ""}</td><td>${t.strike || ""}</td><td>${t.spotEntry || ""}</td><td>${t.spotExit || ""}</td><td>₹${t.optEntry || ""}</td><td>₹${t.optExit || ""}</td><td>${t.rangePts || ""}</td><td>${t.strength || ""}</td><td class="${cls}"><b>₹${t.pnl != null ? t.pnl.toFixed(2) : "—"}</b></td><td style="color:#94a3b8">${t.exitReason || ""}</td></tr>`;
  }).join("");

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>${faviconLink()}<title>ORB History</title>
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
${buildSidebar('orbHistory', liveActive, false)}
<main class="main">
  <div class="title">📜 ORB Paper Trade History</div>
  <div class="stats">
    <div class="stat"><div class="stat-l">Total Trades</div><div class="stat-v">${allTrades.length}</div></div>
    <div class="stat"><div class="stat-l">Win Rate</div><div class="stat-v">${wr}%</div></div>
    <div class="stat"><div class="stat-l">Wins / Losses</div><div class="stat-v">${wins} / ${losses}</div></div>
    <div class="stat"><div class="stat-l">Net P&L</div><div class="stat-v ${totalPnl > 0 ? "pos" : totalPnl < 0 ? "neg" : "muted"}">₹${totalPnl.toFixed(2)}</div></div>
  </div>
  <table>
    <tr><th>Date</th><th>Entry</th><th>Side</th><th>Symbol</th><th>Strike</th><th>E.Spot</th><th>X.Spot</th><th>E.Opt</th><th>X.Opt</th><th>Range</th><th>Sig</th><th>PnL</th><th>Exit Reason</th></tr>
    ${rows || `<tr><td colspan="13" style="text-align:center;color:#3a5070;padding:24px;">No trades yet</td></tr>`}
  </table>
</main>
</body></html>`);
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

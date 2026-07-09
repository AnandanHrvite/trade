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
const { EMA } = require("technicalindicators");

const orbStrategy        = require("../strategies/orb_breakout");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, toastJS, tableEnhancerCSS, tableEnhancerJS } = require("../utils/sharedNav");
const { renderHistoryPage, dailyFilesPaginate } = require("../utils/paperHistoryUI");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiCapitalStrip, bbRsiStatGrid, bbRsiCurrentBar, bbRsiActivityLog } = require("../utils/bbRsiStyleUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter   = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const oiFilter    = require("../services/oiFilter");
const tradeLogger = require("../utils/tradeLogger");
const chartBackfill = require("../utils/chartBackfill");
const aiExport    = require("../utils/aiExport");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { fmtISTDateTime, getISTMinutes, getBucketStart, parseOptionDetails } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");
const tradeGuards = require("../utils/tradeGuards");

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
    const init = { capital: parseFloat(process.env.FYERS_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(init, null, 2));
    _dataCache = init;
    return init;
  }
  try { _dataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error("[orb-paper] orb_paper_trades.json corrupt — resetting:", e.message);
    _dataCache = { capital: parseFloat(process.env.FYERS_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
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

// ── Crash/restart recovery: rehydrate the in-memory session from today's JSONL ──
// A push/PM2 restart wipes state.sessionTrades — it's only flushed to the persisted
// sessions[] on Stop. The per-trade JSONL (appendTradeLog) survives, so on boot we
// re-load today's trades that aren't already in a saved (stopped) session. This
// restores the Session Trades table + chart markers that otherwise vanish after a
// restart. In-memory only — it does NOT re-save into sessions[] (Stop still does that).
function rehydrateSessionFromJsonl() {
  try {
    const data = loadData();
    const keyOf = (t) => String(t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`);

    // 1. Today's running-session trades not yet saved to sessions[] (the in-memory
    //    session a restart would wipe). Day files interleave settings_snapshot/meta
    //    lines with trades — keep only real trade records.
    const today = tradeLogger.istDateString(Date.now());
    const all = tradeLogger.readDailyTrades("orb", today)
      .filter(t => t && !t.type && (t.side || t.entryTime || t.entryBarTime || t.symbol));
    const seen = new Set();
    for (const s of (data.sessions || [])) {
      for (const t of (s.trades || [])) seen.add(keyOf(t));
    }
    let trades = all.filter(t => !seen.has(keyOf(t)));
    let source = "today's live session";

    // 2. Nothing live today → show the most recent saved session so the screen
    //    isn't blank after a restart. Read-only; Start resets it.
    if (!trades.length) {
      const saved = (data.sessions || []).filter(s => Array.isArray(s.trades) && s.trades.length);
      if (saved.length) {
        const last = saved.reduce((a, b) => (String(b.date) > String(a.date) ? b : a));
        trades = last.trades;
        source = `last session (${last.date || "?"})`;
      }
    }
    if (!trades.length) return;

    state.sessionTrades = trades;
    state.tradesTaken   = trades.length;
    state.sessionPnl = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    if (!state.sessionStart) state.sessionStart = trades[0].entryTime || trades[0].loggedAt || null;
    console.log(`♻️ [ORB-PAPER] Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl})`);
  } catch (err) {
    console.warn(`[ORB-PAPER] session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();

// ── Option LTP polling ──────────────────────────────────────────────────────

// Recursive setTimeout (NOT setInterval) so the replay harness — which collapses
// short setTimeout delays to 0ms to accelerate polling — actually advances
// state.optionLtp with replay-time. setInterval is not patched by the harness, so
// it stayed frozen in replay (exit priced at the entry premium). 3s cadence in live.
const OPTION_POLL_MS = 3000;
let _optionPollTimer = null;
let _optionPollStopped = true;
function startOptionPolling() {
  stopOptionPolling();
  _optionPollStopped = false;
  const poll = async () => {
    if (_optionPollStopped) return;
    if (state.position) {
      try {
        const r = await fyers.getQuotes([state.position.symbol]);
        if (r && r.s === "ok" && r.d && r.d.length) {
          const ltp = r.d[0].v && (r.d[0].v.lp || r.d[0].v.ltp);
          if (typeof ltp === "number" && ltp > 0) {
            state.optionLtp = ltp;
            state.optionLtpUpdatedAt = Date.now();
            try { tickRecorder.recordOptionLtp(state.position.symbol, ltp, "orb-paper"); } catch (_) {}
          }
        }
      } catch (_) {}
    }
    if (!_optionPollStopped) _optionPollTimer = setTimeout(poll, OPTION_POLL_MS);
  };
  _optionPollTimer = setTimeout(poll, OPTION_POLL_MS);
}
function stopOptionPolling() {
  _optionPollStopped = true;
  if (_optionPollTimer) { clearTimeout(_optionPollTimer); _optionPollTimer = null; }
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

  // Fetch current option quote (LTP + bid/ask for the STEP 8 spread gate)
  let optionEntryLtp = null, optBid = null, optAsk = null;
  try {
    const r = await fyers.getQuotes([optInfo.symbol]);
    if (r && r.s === "ok" && r.d && r.d.length) {
      const v = r.d[0].v || {};
      const ltp = v.lp || v.ltp;
      if (typeof ltp === "number" && ltp > 0) {
        optionEntryLtp = ltp;
        optBid = Number(v.bid || v.bid_price || 0) || null;
        optAsk = Number(v.ask || v.ask_price || 0) || null;
        try { tickRecorder.recordOptionLtp(optInfo.symbol, ltp, "orb-paper"); } catch (_) {}
      }
    }
  } catch (e) {
    log(`⚠️ [ORB-PAPER] Option LTP fetch failed: ${e.message} — entry blocked`);
    return;
  }
  if (!optionEntryLtp) {
    log(`❌ [ORB-PAPER] Option LTP not available — entry skipped`);
    return;
  }

  // ── STEP 8 — Option filter: ATM (resolved above), premium band, spread ──
  const premMin = parseFloat(process.env.ORB_PREMIUM_MIN || "100");
  const premMax = parseFloat(process.env.ORB_PREMIUM_MAX || "220");
  const premGateOn = (process.env.ORB_PREMIUM_GATE_ENABLED || "true").toLowerCase() === "true";
  if (premGateOn && (optionEntryLtp < premMin || optionEntryLtp > premMax)) {
    log(`⏸️ [ORB-PAPER] Premium gate: ${optInfo.symbol} LTP ₹${optionEntryLtp} outside [${premMin}, ${premMax}] — entry skipped`);
    skipLogger.appendSkipLog("orb", { gate: "premium_range", reason: `LTP ₹${optionEntryLtp} outside [${premMin}, ${premMax}]`, symbol: optInfo.symbol, side, spot, optLtp: optionEntryLtp });
    return;
  }
  // Bid-ask spread gate — fails OPEN when the snapshot lacks depth (no-quote).
  const maxSpread = parseFloat(process.env.ORB_MAX_SPREAD_PTS || process.env.MAX_BID_ASK_SPREAD_PTS || "2");
  const _sp = tradeGuards.checkSpread(optBid, optAsk, maxSpread);
  if (!_sp.ok) {
    log(`⏸️ [ORB-PAPER] Spread gate: ${optInfo.symbol} ${_sp.reason} > ${maxSpread}pt — entry skipped`);
    skipLogger.appendSkipLog("orb", { gate: "spread", reason: `${_sp.reason} > ${maxSpread}pt`, symbol: optInfo.symbol, side, spot, spread: _sp.spread });
    return;
  }

  const qty = instrumentConfig.getLotQty();
  // ── Initial hard SL = the breakout candle's own low (CE) / high (PE) — the
  //    most recent CLOSED candle. Falls back to the OR boundary, then the
  //    signal's slSpot. This is the disaster stop; the trade is then managed on
  //    each candle close by _managePositionOnClose (breakeven → EMA trend-trail
  //    → strong-opposite-candle) plus the per-trade loss cap in _checkExits.
  const _brk = (state.candles || []).filter(c => c && typeof c.low === "number" && typeof c.high === "number").slice(-1)[0];
  let _initSl = side === "CE"
    ? (_brk ? _brk.low  : (sigSnapshot.orl != null ? sigSnapshot.orl : sigSnapshot.slSpot))
    : (_brk ? _brk.high : (sigSnapshot.orh != null ? sigSnapshot.orh : sigSnapshot.slSpot));
  _initSl = Math.round(_initSl * 100) / 100;
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
    entryBarTime:   Math.floor(getBucketStart(Date.now(), RES_MIN) / 1000),
    orh:            sigSnapshot.orh,
    orl:            sigSnapshot.orl,
    rangePts:       sigSnapshot.rangePts,
    targetSpot:     sigSnapshot.targetSpot,   // informational only — no target exit
    initialSlSpot:  _initSl,
    slSpot:         _initSl,
    breakevenArmed: false,
    emaArmed:       false,
    lastEma:        null,
    peakPremium:    optionEntryLtp,
    signalStrength: sigSnapshot.signalStrength,
    vixAtEntry:     getCachedVix(),
    oiAtEntry:      oiFilter.getCachedOi(),
    oiRegime:       oiFilter.getCachedRegime(),
    vwapAtEntry:    sigSnapshot.vwap,
    volRatio:       sigSnapshot.volRatio,
    wickRatio:      sigSnapshot.wickRatio,
    // Entry-context filter outcomes — already computed by getSignal(), captured for analysis.
    vwapAligned:    sigSnapshot.vwapAligned != null ? sigSnapshot.vwapAligned : null,
    volPass:        sigSnapshot.volPass     != null ? sigSnapshot.volPass     : null,
    wickPass:       sigSnapshot.wickPass    != null ? sigSnapshot.wickPass    : null,
    // Max favorable / adverse excursion — tracked per-tick for post-window analysis.
    mfeSpotPts:     0,
    mfePnl:         0,
    maeSpotPts:     0,
    maePnl:         0,
    // Seconds from entry to the favourable peak / adverse trough.
    secsToMFE:      0,
    secsToMAE:      0,
    entryReason:    sigSnapshot.reason,
  };

  state.position = pos;
  state.optionLtp = optionEntryLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;
  startOptionPolling();

  log(`🟢 [ORB-PAPER] BUY_${side} ${optInfo.symbol} qty=${qty} @ spot=${spot} optLtp=${optionEntryLtp} | initial SL=${pos.slSpot} (breakout candle ${side === "CE" ? "low" : "high"})`);

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
    bestOptionLtp:  pos.peakPremium  || null,   // peak option premium during trade — observer-only
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    entryBarTime:   pos.entryBarTime,
    exitBarTime:    Math.floor(getBucketStart(Date.now(), RES_MIN) / 1000),
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
    vixAtExit:      getCachedVix(),
    oiAtEntry:      pos.oiAtEntry != null ? pos.oiAtEntry : null,
    oiRegime:       pos.oiRegime || null,
    rangePts:       pos.rangePts,
    orh:            pos.orh,
    orl:            pos.orl,
    targetSpot:     pos.targetSpot,
    vwapAligned:    pos.vwapAligned != null ? pos.vwapAligned : null,
    volPass:        pos.volPass     != null ? pos.volPass     : null,
    wickPass:       pos.wickPass    != null ? pos.wickPass    : null,
    mfeSpotPts:     pos.mfeSpotPts  || 0,
    mfePnl:         pos.mfePnl      || 0,
    maeSpotPts:     pos.maeSpotPts  || 0,
    maePnl:         pos.maePnl      || 0,
    secsToMFE:      pos.secsToMFE   || 0,
    secsToMAE:      pos.secsToMAE   || 0,
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
    exitReason: reason, entryReason: pos.entryReason,
    entryTime: pos.entryTime, exitTime: trade.exitTime, qty,
    peakPremium: trade.bestOptionLtp,
    peakPnl: trade.mfePnl,
    maxDrawdown: trade.maePnl,
    heldMs: trade.durationMs,
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

// ── In-position management ──────────────────────────────────────────────────

// EMA of candle closes — null until `period` closes exist. Seeded from the
// multi-day preload (see preloadHistory) so the trend-trail is live even for a
// 09:35 entry (a 20-EMA on 5-min needs ~100 min of bars that today alone can't
// supply). Uses the `technicalindicators` package (repo convention).
function _computeEma(candles, period) {
  if (!candles || candles.length < period) return null;
  const closes = candles.map(c => c && c.close).filter(v => typeof v === "number");
  if (closes.length < period) return null;
  const arr = EMA.calculate({ period, values: closes });
  return arr && arr.length ? arr[arr.length - 1] : null;
}

// Per-candle-close position management (replaces the old 2-candle swing trail):
//   1. Strong opposite reversal candle → exit now.
//   2. Breakeven — once favourable by ORB_BREAKEVEN_PTS, lift the hard SL to entry.
//   3. EMA trend-trail — exit only when a candle CLOSES back across the EMA, so a
//      winner rides the whole move instead of dying on the first pullback.
// The tick-level hard SL + per-trade loss cap live in _checkExits.
function _managePositionOnClose(bar) {
  const pos = state.position;
  if (!pos || !bar || typeof bar.close !== "number") return;
  const close = bar.close;

  // 1. Strong opposite reversal candle (big body closing back inside the box)
  const oppOn    = (process.env.ORB_OPP_CANDLE_EXIT || "true").toLowerCase() === "true";
  const oppMult  = parseFloat(process.env.ORB_OPP_CANDLE_BODY_MULT || "0.3");
  const oppThresh = oppMult * (pos.rangePts || 0);
  const bodyPts  = Math.abs(bar.close - bar.open);
  if (oppOn && oppThresh > 0 && bodyPts >= oppThresh) {
    if (pos.side === "CE" && bar.close < bar.open && bar.close < pos.orh) {
      return simulateSell(`Strong opposite candle (red body ${bodyPts.toFixed(1)}pt ≥ ${oppThresh.toFixed(1)}pt, closed below ORH)`);
    }
    if (pos.side === "PE" && bar.close > bar.open && bar.close > pos.orl) {
      return simulateSell(`Strong opposite candle (green body ${bodyPts.toFixed(1)}pt ≥ ${oppThresh.toFixed(1)}pt, closed above ORL)`);
    }
  }

  // 2. Breakeven — lift the hard SL to entry once far enough in profit (never loosens)
  const bePts  = parseFloat(process.env.ORB_BREAKEVEN_PTS || "20");
  const favPts = (close - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  if (!pos.breakevenArmed && bePts > 0 && favPts >= bePts) {
    if (pos.side === "CE" && pos.entrySpot > pos.slSpot) pos.slSpot = Math.round(pos.entrySpot * 100) / 100;
    if (pos.side === "PE" && pos.entrySpot < pos.slSpot) pos.slSpot = Math.round(pos.entrySpot * 100) / 100;
    pos.breakevenArmed = true;
    log(`🔒 [ORB-PAPER] Breakeven armed — SL → entry ${pos.slSpot} (favourable ${favPts.toFixed(1)}pt ≥ ${bePts}pt)`);
  }

  // 3. EMA trend-trail — exit only on a candle CLOSE back across the EMA, AND
  //    only once price has first closed on the correct side of it (emaArmed).
  //    Without the arm, a fresh entry taken below a stale/gap-day EMA (e.g. a CE
  //    breakout on a gap-down morning, EMA still high from prior days) would be
  //    stopped out on its very first candle. Until armed, the trade is protected
  //    by breakeven + opposite-candle + the per-trade loss cap instead.
  const emaPeriod = Math.max(2, parseInt(process.env.ORB_TRAIL_EMA || "20", 10));
  const ema = _computeEma(state.candles, emaPeriod);
  if (ema != null) {
    pos.lastEma = Math.round(ema * 100) / 100;
    if (pos.side === "CE") {
      if (close >= ema) pos.emaArmed = true;
      else if (pos.emaArmed) return simulateSell(`Closed below EMA${emaPeriod} (${close} < ${pos.lastEma})`);
    } else {
      if (close <= ema) pos.emaArmed = true;
      else if (pos.emaArmed) return simulateSell(`Closed above EMA${emaPeriod} (${close} > ${pos.lastEma})`);
    }
  }
}

// Tick-level exits: the hard SL (breakout candle low/high, lifted to breakeven)
// and the per-trade rupee loss cap. Also tracks peak premium + MFE/MAE.
function _checkExits(spotPrice) {
  if (!state.position) return;
  const pos = state.position;
  const optLtp = state.optionLtp || pos.optionEntryLtp;

  // Track peak option premium (observer-only — feeds the trade record/notify).
  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;

  // Track max favorable / adverse excursion — spot pts in trade direction + rupee PnL.
  const _favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const _curPnl = (optLtp - pos.optionEntryLtp) * pos.qty;
  if (_favPts > (pos.mfeSpotPts || 0)) { pos.mfeSpotPts = parseFloat(_favPts.toFixed(2)); pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (_curPnl > (pos.mfePnl     || 0)) pos.mfePnl     = parseFloat(_curPnl.toFixed(2));
  if (_favPts < (pos.maeSpotPts || 0)) { pos.maeSpotPts = parseFloat(_favPts.toFixed(2)); pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (_curPnl < (pos.maePnl     || 0)) pos.maePnl     = parseFloat(_curPnl.toFixed(2));

  // Per-trade loss cap (unrealised rupees) — the daily-loss gate only fires when
  // flat, so THIS is what actually caps a single open trade.
  const maxTradeLoss = parseFloat(process.env.ORB_MAX_TRADE_LOSS || "1500");
  if (maxTradeLoss > 0 && _curPnl <= -maxTradeLoss) {
    simulateSell(`Max trade loss (₹${Math.round(_curPnl)} ≤ -₹${maxTradeLoss})`);
    return;
  }

  // Hard SL (breakout candle low/high, lifted to breakeven) — spot-based, per tick.
  if (pos.side === "CE" && spotPrice <= pos.slSpot) {
    simulateSell(`Hard SL hit (${spotPrice} ≤ ${pos.slSpot})`);
    return;
  }
  if (pos.side === "PE" && spotPrice >= pos.slSpot) {
    simulateSell(`Hard SL hit (${spotPrice} ≥ ${pos.slSpot})`);
    return;
  }
}

// ── Candle close handler ────────────────────────────────────────────────────

async function onCandleClose(bar) {
  // Sample futures OI each candle close (no-op unless an OI filter is enabled) so
  // the buildup series stays filled even on no-signal candles.
  await oiFilter.recordOiSample(bar && bar.close);

  // Already in position? Manage it on this candle close (breakeven → EMA
  // trend-trail → strong-opposite-candle), then bail — entries aren't
  // re-evaluated and the tick-level hard SL / loss cap run in _checkExits.
  if (state.position) { _managePositionOnClose(bar); return; }

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

  // OI + price buildup gate — block entries fighting a confirmed buildup; tag the
  // entry reason with the regime so every trade records its OI context.
  if (oiFilter.getOiEnabled("orb")) {
    const _oi = await oiFilter.checkLiveOi(sig.side, _spot, { mode: "orb" });
    if (!_oi.allowed) {
      log(`⏸️ [ORB-PAPER] OI gate blocked: ${_oi.reason}`);
      skipLogger.appendSkipLog("orb", { gate: "oi", reason: _oi.reason, spot: _spot, side: sig.side, oi: _oi.oi ?? null, deltaOi: _oi.deltaOi ?? null, regime: _oi.regime ?? null });
      return;
    }
    if (_oi.regime) sig.reason = `${sig.reason} | ${_oi.reason}`;
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
      state.currentBar.volume = (state.currentBar.volume || 0) + 1;
    } else {
      state.currentBar = { time: bucketSec, open: price, high: price, low: price, close: price, volume: 1 };
    }
    state.barStartTime = bucketMs;
  } else {
    state.currentBar.high  = Math.max(state.currentBar.high, price);
    state.currentBar.low   = Math.min(state.currentBar.low, price);
    state.currentBar.close = price;
    state.currentBar.volume = (state.currentBar.volume || 0) + 1;
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
    const _now = new Date();
    const istToday = _now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    // Preload ~7 calendar days so the EMA trend-trail is seeded before the open —
    // a 20-EMA on 5-min needs ~100 min of bars, never available for a 09:35 entry
    // from today alone. The opening range + VWAP are day-scoped in the strategy,
    // so the prior-day candles seed the EMA without polluting today's OR.
    const istStart = new Date(_now.getTime() - 7 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached(NIFTY_INDEX_SYMBOL, String(RES_MIN), istStart, istToday, fetchCandles);
    if (Array.isArray(candles) && candles.length > 0) {
      state.candles = candles.slice(-200);
      log(`📊 [ORB-PAPER] Preloaded ${state.candles.length} × ${RES_MIN}-min spot candles (${istStart}→${istToday}, EMA-seeded)`);
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
  // NOTE: do NOT reset the OI series on start — it is global NIFTY-futures OI shared
  // by all strategies (which run in parallel); a reset here would wipe another
  // running strategy's warmed series. Stale series is auto-discarded by STALE_GAP_MS.

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
        // Replay-fidelity marker: true means this session writes option LTPs
        // to options.jsonl, so tick-replay can reconstruct exit P&L. Pre-fix
        // sessions are missing the flag → list endpoint marks them "incomplete".
        recordsOptionLtps: true,
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
router.get("/status/chart-data", async (req, res) => {
  try {
    // After a restart we restore the Session Trades but not the live candle series.
    // When stopped with restored trades and no live candles, backfill the spot
    // candles for the trades' day so the chart draws them with their markers.
    let srcCandles = state.candles;
    if (!state.running && srcCandles.length === 0 && (state.sessionTrades || []).length > 0) {
      srcCandles = await chartBackfill.candlesForRestoredTrades(NIFTY_INDEX_SYMBOL, RES_MIN, state.sessionTrades);
    }
    const candles = srcCandles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.currentBar) {
      candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });
    }

    // Opening Range box overlay — emit two horizontal lines at ORH and ORL
    let orhLine = [], orlLine = [];
    try {
      const or = orbStrategy.computeOpeningRange(srcCandles);
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
      // Place markers on the candle at the trade's actual time (entryBarTime/exitBarTime
      // are the 5-min bucket epochs captured at fill). Fall back to nearest-by-price only
      // for legacy trades recorded before those fields existed — price-matching alone
      // drifts to wherever spot first revisited that level, not when the trade happened.
      if (t.spotAtEntry != null) {
        const c = (t.entryBarTime != null && candles.find(c => c.time === t.entryBarTime))
          || candles.find(c => Math.abs(c.close - t.spotAtEntry) < 1) || candles[0];
        if (c) markers.push({ time: c.time, position: 'belowBar', color: '#3b82f6', shape: 'arrowUp', text: (t.side || '') + ' @ ' + t.spotAtEntry });
      }
      if (t.spotAtExit != null) {
        const c = (t.exitBarTime != null && candles.find(c => c.time === t.exitBarTime))
          || candles.find(c => Math.abs(c.close - t.spotAtExit) < 1) || candles[candles.length - 1];
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
      initialSlSpot: pos.initialSlSpot, breakevenArmed: pos.breakevenArmed, lastEma: pos.lastEma, peakPremium: pos.peakPremium,
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
  const v = parseFloat(process.env.FYERS_INV_AMOUNT);
  return isNaN(v) ? 100000 : v;
}

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
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

  // Position HTML — bb_rsi-style rich card
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
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Hard SL${pos.breakevenArmed ? " (BE)" : ""}${pos.lastEma ? ` · EMA ${pos.lastEma}` : ""}</div>
          <div style="font-size:1.05rem;font-weight:700;color:#f59e0b;">${pos.slSpot ? "₹" + pos.slSpot.toFixed(2) : "—"}</div>
        </div>
        <div style="background:#0a1f12;border:1px solid #0d4030;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Spot Target <span style="color:#3a4660;">(info)</span></div>
          <div style="font-size:1.05rem;font-weight:700;color:#10b981;">${pos.targetSpot ? "₹" + pos.targetSpot.toFixed(2) : "—"}</div>
        </div>
        <div style="background:#10131c;border:1px solid #1e2940;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Initial SL</div>
          <div style="font-size:1.05rem;font-weight:700;color:#c8d8f0;">${pos.initialSlSpot ? "₹" + pos.initialSlSpot.toFixed(2) : "—"}</div>
        </div>
        <div style="background:#0a1f12;border:1px solid #0d4030;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Peak Premium</div>
          <div style="font-size:1.05rem;font-weight:700;color:#10b981;">${pos.peakPremium ? "₹" + pos.peakPremium.toFixed(2) : "—"}</div>
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

  // Trades JSON — used to render the Session Trades table on initial load (the AJAX
  // poll only re-renders on a count change, and only runs while the session is live;
  // without this a stopped/reloaded session shows the count but an empty table).
  const tradesJSON = JSON.stringify(state.sessionTrades)
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
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
<style>
${sidebarCSS()}
${modalCSS()}
${bbRsiStyleCSS()}
</style></head>
<body>
<div class="app-shell">
${buildSidebar('orbPaper', liveActive, state.running, {
  showStartBtn: !state.running, startBtnJs: `location.href='/orb-paper/start'`, startLabel: '▶ Start ORB',
  showStopBtn: state.running,   stopBtnJs:  `location.href='/orb-paper/stop'`,  stopLabel:  '■ Stop ORB',
  showExitBtn: state.running && !!state.position, exitBtnJs: `location.href='/orb-paper/exit'`, exitLabel: '🚪 Exit Trade',
})}
<div class="main-content">

${bbRsiTopBar({
  title: "ORB Paper Trade",
  metaLine: `Strategy: ${orbStrategy.NAME} · OR ${_orStart}–${_orEnd} · Square-off ${_forcedExit} IST · ${state.running ? "Auto-refreshes every 2s" : "Stopped"}`,
  running: state.running,
  vix: { enabled: _vixEnabled, value: _vix, maxEntry: _vixMaxEntry, strongOnly: Infinity },
  primaryAction: { label: "Start ORB Paper", href: "/orb-paper/start" },
  stopAction:    { label: "Stop Session",    href: "/orb-paper/stop"  },
  historyHref: "/orb-paper/history",
})}

${bbRsiCapitalStrip({
  starting: _orbCapital(),
  current:  data.capital,
  allTime:  data.totalPnl,
  startingThreshold: _orbCapital(),
})}

${bbRsiStatGrid(statCards)}

${bbRsiCurrentBar({ bar: state.currentBar, resMin: RES_MIN })}

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
  <div class="section-title">Session Trades <span id="orbp-trades-hint" style="color:#4a6080;font-weight:400;letter-spacing:0.5px;text-transform:none;margin-left:8px;">${state.sessionTrades.length} trades</span><a href="/orb-paper/download/trades.jsonl?format=ai" title="Download the full paper-trade log as an AI-friendly Markdown report (summary + field legend + table)" style="float:right;font-weight:400;font-size:0.72rem;letter-spacing:0.5px;text-transform:none;color:#4a9cf5;text-decoration:none;">🤖 AI export</a></div>
  <div id="orbp-trades-box" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;${state.sessionTrades.length ? "" : "padding:24px;text-align:center;color:#4a6080;font-size:0.82rem;"}">${state.sessionTrades.length ? "" : "No trades yet"}</div>
</div>

${bbRsiActivityLog({ logsJSON })}

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
  var entryLine = null, slLine = null, tgtLine = null, _zoomed = false;
  async function fetchChart(){
    try {
      var r = await fetch('/orb-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      // Trim every series to the latest IST trading day so zooming out still
      // shows only today — warmup history stays server-side for indicator calc.
      if (d.candles && d.candles.length) { (function(){
        var _lt=d.candles[d.candles.length-1].time, _dk=Math.floor((_lt+19800)/86400), _cut=_lt;
        for (var _i=d.candles.length-1;_i>=0;_i--){ if(Math.floor((d.candles[_i].time+19800)/86400)===_dk) _cut=d.candles[_i].time; else break; }
        var _k=function(a){ return Array.isArray(a)?a.filter(function(x){return x.time>=_cut;}):a; };
        d.candles=_k(d.candles);
        ['ema21','sar','rsi','bbUpper','bbMiddle','bbLower','orhLine','orlLine','vwap','markers'].forEach(function(kk){ if(d[kk]) d[kk]=_k(d[kk]); });
      })(); }
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        if (!_zoomed) {
          // First load: show just the latest IST trading day. The candle buffer
          // holds several days; a default fit renders them as extra candles.
          try {
            var lastT = d.candles[d.candles.length - 1].time;
            var dayK = Math.floor((lastT + 19800) / 86400);
            var firstT = lastT;
            for (var i = d.candles.length - 1; i >= 0; i--) {
              if (Math.floor((d.candles[i].time + 19800) / 86400) === dayK) firstT = d.candles[i].time;
              else break;
            }
            chart.timeScale().setVisibleRange({ from: firstT, to: lastT });
            _zoomed = true;
          } catch(_) {}
        }
      }
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
  var _interval        = null;

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
        (function(){
          if (t.bestOptionLtp == null) return '<td style="padding:8px 12px;color:#4a6080;">—</td>';
          var giveback = (t.optionExitLtp!=null) ? parseFloat((t.bestOptionLtp - t.optionExitLtp).toFixed(2)) : null;
          var sub = giveback != null ? '<span style="font-size:0.6rem;color:#4a6080;"> (gave back ' + giveback + ')</span>' : '';
          return '<td style="padding:8px 12px;color:#a78bfa;font-weight:700;">₹' + t.bestOptionLtp + sub + '</td>';
        })() +
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
        '<th style="padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#a78bfa;">Peak</th>' +
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
      if (_lastRunning && !d.running) {
        _lastRunning = false;
        if (_interval) { clearInterval(_interval); _interval = null; }
        setTimeout(function(){ window.location.reload(); }, 1500);
      }
    } catch (e) { console.warn('[orb-paper] refresh:', e.message); }
  }

  renderTrades(${tradesJSON});  // paint existing trades on load (covers stopped/reloaded sessions)
  if (${state.running}) { _interval = setInterval(fetchAndUpdate, 2000); fetchAndUpdate(); }
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'visible' && ${state.running}) {
      fetchAndUpdate();
      if (!_interval) _interval = setInterval(fetchAndUpdate, 2000);
    }
  });
  window.addEventListener('focus', function(){ if (${state.running}) fetchAndUpdate(); });
})();
</script>

</body></html>`);
});

// ── History page — session accordion with per-session copy/delete + analytics

router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  res.send(renderHistoryPage({
    routePrefix: "/orb-paper",
    sidebarKey: "orbHistory",
    pageTitle: "🎯 ORB Paper Trade History",
    pageDocTitle: "ORB Paper — History",
    modalLabel: "ORB Paper",
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap,
    emptyLabel: "Start ORB paper trading to record your first session.",
  }));
});

// ── Daily JSONL: server-paginated index + viewers + restore + reset ──────────
const _ORB_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/download/daily-files", (req, res) => {
  const skips  = skipLogger.listDates("orb");
  const trades = tradeLogger.listDailyDates("orb");
  const byDate = new Map();
  for (const s of skips)  byDate.set(s.date, { date: s.date, skipsSize: s.size, tradesSize: 0 });
  for (const t of trades) {
    const row = byDate.get(t.date) || { date: t.date, skipsSize: 0, tradesSize: 0 };
    row.tradesSize = t.size;
    byDate.set(t.date, row);
  }
  const rows = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  res.json(dailyFilesPaginate(rows, req.query));
});

router.get("/download/skips-all", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="orb_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates("orb").map(d => d.date).sort();
  let body = "";
  for (const d of dates) {
    try { const p = skipLogger.filePathFor("orb", d); if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8"); } catch (_) {}
  }
  res.send(body);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_ORB_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor("orb", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_ORB_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor("orb", date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

// DELETE a session by 0-based index (matches the shared history page)
router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop ORB paper trading first before deleting a session." });
  const data = loadData();
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= (data.sessions || []).length) return res.status(400).json({ success: false, error: "Invalid session index." });
  data.sessions.splice(idx, 1);
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, message: "Session deleted successfully." });
});

// Rebuild a session from its daily JSONL (recovers deleted/missing trades)
router.post("/restore-session/:date", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop ORB paper trading before restoring." });
  const date = String(req.params.date || "").trim();
  if (!_ORB_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades("orb", date);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) {
    const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`;
    if (key) seen.add(String(key));
  }
  const missing = allTrades.filter(t => {
    const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`;
    return key && !seen.has(String(key));
  });
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
  data.sessions.push({ date, strategy: (missing[0] && missing[0].strategy) || "ORB", pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

// Reset ALL ORB paper history + capital
router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop ORB paper trading before resetting." });
  const fresh = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  return res.json({ success: true, message: `ORB paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
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
    const records = [];
    for (const s of (data.sessions || [])) {
      for (const t of (s.trades || [])) {
        records.push(Object.assign({ date: s.date, mode: "orb", strategy: s.strategy }, t));
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
    if (ai) {
      const md = aiExport.buildMarkdown(records, { title: "ORB paper trades (full log)", source: "orb-paper" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="orb_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="orb_paper_trades_${today}.jsonl"`);
    res.send(records.map(r => JSON.stringify(r)).join("\n"));
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

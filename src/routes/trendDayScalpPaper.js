/**
 * TREND DAY SCALP PAPER — /trend-day-scalp-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL surface. Every decision / fill / exit semantic for TREND_DAY_SCALP
 * lives here; the backtest must match THIS, never the
 * reverse (see feedback_paper_logic_untouchable).
 *
 * The day in one paragraph: at TDS_GATE_TIME (10:15) the engine looks at the
 * first hour once and decides whether the day trends at all and in which
 * direction. Most days the answer is "no trade", and that ZERO is the design
 * goal — a naked long option bleeds theta through a ranging session. When the
 * gate passes, the side is LOCKED for the day and the route hunts a pullback
 * into the VWAP/EMA20 zone that is immediately reclaimed.
 *
 * Exit: the global profit lock (tradeGuards.checkProfitLock, option premium,
 * per tick) is the ONLY automatic exit. Beyond it: manual exit, /stop, and the
 * session teardown at TRADE_STOP_TIME.
 *
 * Day-level breaker: the shared portfolio cap.
 *
 * Signal engine: src/strategies/trend_day_scalp.js (shared by paper, backtest
 * and replay — no rule is re-implemented in this file).
 *
 * Uses LIVE NIFTY data (Fyers WebSocket) but SIMULATES orders locally.
 * Endpoints: /start /stop /exit /status /status/data /status/chart-data
 *            /history /reset /session/:i /download/... /view/...
 *
 * MARKETS. This file is a create(pair) builder (see utils/pairRuntime.js and
 * routes/emaRsiStV2Paper.js, the pilot). The default export is the NIFTY
 * instance: /trend-day-scalp-paper, the same files, keys, logs and decisions.
 * forMarket(key) builds the same engine for every other market pairs.js offers
 * it on (SENSEX, BANKNIFTY, NIFTY futures, MCX, SAIL), each with its own route
 * /<modeKey>-paper, trades file, logs, crash snapshot, socket slot and capital
 * book. Every per-market fact (spot, strike grid, lot, option symbol, expiry,
 * session, futures, fills) comes from pairRuntime; the rules never branch on
 * the market. Pair-only behaviour sits behind `!rt.home`: its own ON switch
 * (<PAIR>_MODE_ENABLED, default off), <PAIR>_EXPIRY_DAY_ONLY on that market's
 * expiry, the spread limit and fill at the ask / bid of a fresh quote
 * (<PAIR>_PAPER_FILL_AT_QUOTE, default on off NIFTY).
 */

const express = require("express");
const { trackPath, pathFields } = require("../utils/tradePath");
const fs      = require("fs");
const path    = require("path");

const tdsStrategy        = require("../strategies/trend_day_scalp");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const optionChart  = require("../utils/optionChart");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const optionFeed         = require("../utils/optionFeed");
const { verifyFyersToken } = require("../services/marketData");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { renderHistoryPage, dailyFilesPaginate } = require("../utils/paperHistoryUI");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiCapitalStrip, bbRsiStatGrid, bbRsiCurrentBar, bbRsiActivityLog, inr } = require("../utils/bbRsiStyleUI");
const { isTradingAllowed } = require("../services/marketData");
const tradeLogger = require("../utils/tradeLogger");
const chartBackfill = require("../utils/chartBackfill");
const aiExport    = require("../utils/aiExport");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const instrumentMode = require("../utils/instrumentMode");
const { istDayFromAny, istIsoFromAny, getISTMinutes, getBucketStart } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");
const capitalPool = require("../utils/capitalPool");
const tradeGuards = require("../utils/tradeGuards");
const pairs        = require("../config/pairs");
const pairRuntime  = require("../utils/pairRuntime");
const tradeJournal = require("../utils/tradeJournal");

// ═══════════════════════════════════════════════════════════════════════════════
// BUILDER: one paper engine per (strategy, market) pair. create(pair) returns an
// Express router holding ALL of that pair's state. See the MARKETS note above.
// ═══════════════════════════════════════════════════════════════════════════════
function create(pair) {
const rt     = pairRuntime.forPair(pair);
const router = express.Router();
const MODE        = rt.modeKey;      // "trend_day_scalp" on NIFTY: tradeLogger / skipLogger / capitalPool key
const PREFIX      = rt.envPrefix;    // "TDS" on NIFTY
const ROUTE       = rt.paperPath;    // "/trend-day-scalp-paper" on NIFTY
const OWNER       = rt.ownerId;      // "trend-day-scalp-paper" on NIFTY: option feed, recorder, session id
const CALLBACK_ID = rt.home ? "trendDayScalpPaper" : OWNER;   // socketManager callback id
const TAG         = rt.home ? "[TDS-PAPER]" : `[${rt.tag}-PAPER]`;
const NOTIFY_MODE = rt.home ? "TREND-DAY-SCALP-PAPER" : rt.notifyMode;
const TITLE       = rt.home ? "Trend Day Scalp" : `${rt.market().label} · Trend Day Scalp`;
const SPOT_LABEL  = rt.spotLabel;    // "NIFTY" on NIFTY
// A non-home pair's own keys read with pair inheritance (its value, else NIFTY's);
// NIFTY reads process.env exactly as it always did.
const _env = (k) => (rt.home ? process.env[k] : pairs.envGet(k));
// Spot symbol the candles are built from: resolved at /start (MCX: the series' future).
let _spotSym = null;
const SPOT = () => _spotSym || rt.spotSymbol();
rt.registerCapital();

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, rt.tradesFile);

// ── Config readers (Settings mutates process.env live — never cache) ──────────
function _resMin() {
  const v = parseInt(_env(`${PREFIX}_RESOLUTION`) || "5", 10);
  return [1, 3, 5, 10, 15, 30, 60].includes(v) ? v : 5;
}
function _parseMins(envKey, fallback) {
  return tdsStrategy._parseHHMM(_env(envKey), tdsStrategy._parseHHMM(fallback, 0));
}
function _envStr(key, fallback) { return String(_env(key) || fallback); }

/**
 * The engine's config. NIFTY: getConfig() exactly as before (and engine calls
 * pass no cfg, so they read it themselves). Another market: its own keys with
 * inheritance; on MCX the day's first hour starts at that market's open unless
 * the pair sets its own <PAIR>_SESSION_START.
 */
function _cfg() {
  if (rt.home) return tdsStrategy.getConfig();
  const c = tdsStrategy.getConfig(PREFIX);
  if (rt.isMcx && !process.env[`${PREFIX}_SESSION_START`]) c.sessionStartMin = rt.sessionOpenMin();
  return c;
}
/** Engine opts: unchanged on NIFTY; another market adds its own cfg. */
const ENG = (o) => (rt.home ? o : Object.assign({ cfg: _cfg() }, o));

/** Position size — the one common Lot Multiplier (Settings → Common Rules), on this market's lot. */
function tdsLotQty() {
  return rt.lotQty();
}

// ── Instrument maths. NIFTY: instrumentMode (options) exactly as before. Another
//    market: its own instrument (NIFTY_FUT trades the month future at the index
//    level) and its exchange's charges (BSE for SENSEX). ──────────────────────
const _isFut = rt.instrumentName() === "NIFTY_FUTURES";
function _dir(side) { return _isFut && side === "PE" ? -1 : 1; }
function _r2(x) { return parseFloat(x.toFixed(2)); }
function _computePnl(o) {
  if (rt.home) return instrumentMode.computePnl(o);
  const qty = o.qty || 0;
  const exchange = rt.market().exchange;
  if (_isFut) {
    const gross = (o.exitSpot - o.entrySpot) * _dir(o.side) * qty;
    const charges = getCharges({ broker: o.broker, isFutures: _isFut, exchange, entryPremium: o.entrySpot, exitPremium: o.exitSpot, qty });
    return { gross: _r2(gross), charges, pnl: _r2(gross - charges), pnlMode: `futures: entry ₹${o.entrySpot} → exit ₹${o.exitSpot} (${_dir(o.side) > 0 ? "LONG" : "SHORT"})`, isFutures: _isFut };
  }
  const gross = (o.exitPremium - o.entryPremium) * qty;
  const charges = getCharges({ broker: o.broker, isFutures: _isFut, exchange, entryPremium: o.entryPremium, exitPremium: o.exitPremium, qty });
  return { gross: _r2(gross), charges, pnl: _r2(gross - charges), pnlMode: `option premium: entry ₹${o.entryPremium} → exit ₹${o.exitPremium}`, isFutures: _isFut };
}
function _unrealisedPnl(o) {
  if (rt.home || !_isFut) return instrumentMode.unrealisedPnl(o);
  return _r2((o.currentSpot - o.entrySpot) * _dir(o.side) * (o.qty || 0));
}
function _capitalRequired(qty, price) {
  if (rt.home || !_isFut) return instrumentMode.capitalRequired(qty, price);
  const pct = instrumentConfig.underlyingOf(rt.underlyingKey).marginPct;
  return _r2((qty || 0) * (price || 0) * (pct / 100));
}
/**
 * Another market's entry contract. Options keep TDS's slightly-ITM strike
 * (<PAIR>_ITM_STEPS, else TDS_ITM_STEPS, default 1 step of THIS market's grid);
 * futures take the month contract; MCX its series' ATM option.
 */
async function _resolvePairEntry(spot, side) {
  if (_isFut || rt.isMcx) return rt.resolveEntrySymbol(spot, side);
  const U = rt.U();
  const base = instrumentConfig.calcATMStrike(spot, side, U.key);
  const steps = parseInt(_env(`${PREFIX}_ITM_STEPS`) || "1", 10);
  const strike = steps > 0 ? _r2(side === "CE" ? base - steps * U.strikeStep : base + steps * U.strikeStep) : base;
  return instrumentConfig.validateAndGetOptionSymbol(spot, side, MODE, { underlying: U.key, strikeOverride: strike });
}
/** The live exit level the profit lock / premium stop holds (journal only). */
function _stopLevel(pos) {
  if (pos.isFutures) return tradeGuards.futuresStopLevel(pos.side, pos.entrySpot, pos.mfeSpotPts || 0);
  return tradeGuards.exitLevelLtp(pos.optionEntryLtp, pos.peakPremium);
}
function _exitKind(reason) {
  const r = String(reason || "");
  if (/^Manual/i.test(r)) return "manual";
  if (/stopped|Auto-stop|Shutdown/i.test(r)) return "eod";
  if (/Profit lock/i.test(r)) return "trail";
  return "sl";
}

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
    console.error(`[tds-paper] ${rt.tradesFile} corrupt — resetting:`, e.message);
    _dataCache = { capital: parseFloat(process.env.FYERS_INV_AMOUNT || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(_dataCache, null, 2));
  }
  return _dataCache;
}
function saveData(d) {
  ensureDir();
  _dataCache = d;
  fs.writeFileSync(PT_FILE, JSON.stringify(d, null, 2));
}

// ── State ────────────────────────────────────────────────────────────────────
let state = _freshState();
function _freshState() {
  return {
    running:        false,
    sessionStart:   null,
    sessionTrades:  [],
    sessionPnl:     0,
    // True while sessionPnl holds closed trades NOT yet in the paper-trades file's
    // totalPnl — the capital pool adds sessionPnl only then (see trackSession below).
    _unsaved:       false,
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
    optionQuote:    null,   // another market: latest bid/ask of the held contract (fill at the bid)
    _expiryDayBlocked: false, // another market: <PAIR>_EXPIRY_DAY_ONLY on a non-expiry day
    log:            [],
    _sessionId:     null,
    _reentryBlockUntil: 0,  // wait-after-any-exit cooldown (epoch ms)
    // TREND_DAY_SCALP specific
    dayGate:        null,   // FROZEN evaluateDayGate() result — decided once at 10:15
    gateLoggedAt:   null,
    dayClosed:      false,  // a day-level breaker has ended trading for today
    dayClosedReason: null,
    lastSignal:     null,
    _entryInFlight: false,
    _lastEntryAttemptMs: null,
    _pendingEntry:  null,   // a signalled entry whose FILL failed — retried per tick
  };
}

function log(msg) {
  const stamp = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23" });
  const line = `[${stamp}] ${msg}`;
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
  console.log(line);
}

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23" });
}

// ── Crash/restart recovery: rehydrate today's in-memory session from JSONL ─────
function rehydrateSessionFromJsonl() {
  try {
    const data = loadData();
    const keyOf = (t) => String(t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`);
    const today = tradeLogger.istDateString(Date.now());
    const all = tradeLogger.readDailyTrades(MODE, today)
      .filter(t => t && !t.type && (t.side || t.entryTime || t.entryBarTime || t.symbol));
    const seen = new Set();
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) seen.add(keyOf(t));
    let trades = all.filter(t => !seen.has(keyOf(t)));
    let source = "today's live session";
    let stale  = false;
    if (!trades.length) {
      const saved = (data.sessions || []).filter(s => Array.isArray(s.trades) && s.trades.length);
      if (saved.length) {
        const last = saved.reduce((a, b) => (istDayFromAny(b.date) > istDayFromAny(a.date) ? b : a));
        trades = last.trades;
        source = `last session (${last.date || "?"})`;
        stale  = all.length === 0;
      }
    }
    if (!trades.length) return;
    state._staleSession = stale;
    state._unsaved      = false;   // rehydrated trades are not counted: they may have been deleted from History, and the pool must not resurrect them
    state.sessionTrades = trades;
    state.tradesTaken   = trades.length;
    state.sessionPnl = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    if (!state.sessionStart) state.sessionStart = istIsoFromAny(trades[0].entryTime || trades[0].loggedAt);
    console.log(`♻️ ${TAG} Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl})`);
  } catch (err) {
    console.warn(`${TAG} session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => state, TAG);

// Capital pool realized P&L = file totalPnl + this session's unsaved closed trades.
// A replay re-requires this module — it must not replace the live instance's getter.
let _replayLoad = false;
try { _replayLoad = require("../services/tickReplay").isReplayInProgress(); } catch (_) {}
if (!_replayLoad) capitalPool.trackSession(MODE, () => (state._unsaved ? state.sessionPnl : 0));

/**
 * Realised P&L for the current ISO week (Mon → today) from the per-day JSONL
 * logs. While RUNNING, today's contribution comes from the in-memory session
 * (the day file lags by an event-loop tick); when idle we must read the FILE,
 * because state.sessionPnl may still hold a rehydrated previous session.
 */
function weeklyPnl() {
  try {
    const nowIst = new Date(Date.now() + 19800000);
    const dow = nowIst.getUTCDay();
    const backToMon = dow === 0 ? 6 : dow - 1;
    const todayStr = tradeLogger.istDateString(Date.now());
    let total = 0;
    for (let i = backToMon; i >= 0; i--) {
      const d = new Date(nowIst.getTime() - i * 86400000);
      const ds = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      if (ds === todayStr && state.running) { total += state.sessionPnl; continue; }
      const trades = tradeLogger.readDailyTrades(MODE, ds) || [];
      for (const t of trades) if (t && !t.type && typeof t.pnl === "number") total += t.pnl;
    }
    return parseFloat(total.toFixed(2));
  } catch (_) {
    return state.running ? state.sessionPnl : 0;
  }
}

// ── Option LTP polling ───────────────────────────────────────────────────────
const OPTION_POLL_MS = 3000;
// Socket-first: the held contract is streamed on the shared Fyers websocket via
// optionFeed, so the REST call below fires only when the stream is quiet or
// unavailable. The loop itself stays — it renews the optionFeed lease, and it is
// the fallback that keeps behaviour identical if the stream is down.
const OPTION_FEED_OWNER = OWNER;
let _optionPollTimer = null;
let _optionPollStopped = true;

/**
 * Single place the option premium enters state, whichever source produced it.
 * `at` is when the price was OBSERVED, not when it was applied — a staleness
 * guard reading optionLtpUpdatedAt must not be told a 3s-old tick is current.
 * Socket ticks are already recorded (throttled) by optionFeed, so only the REST
 * path records here — otherwise replay would see the same price twice.
 */
function _applyOptionLtp(symbol, ltp, at, record) {
  if (!(ltp > 0) || !state.position) return;
  state.optionLtp = ltp;
  // Premium bars for the option chart (display only — never read by the engine).
  state.optionChart = optionChart.pushLtp(state.optionChart, symbol, ltp, at);
  state.optionLtpUpdatedAt = at || Date.now();
  if (record) { try { tickRecorder.recordOptionLtp(symbol, ltp, OWNER); } catch (_) {} }
}

function startOptionPolling() {
  stopOptionPolling();
  _optionPollStopped = false;
  const poll = async () => {
    if (_optionPollStopped) return;
    if (state.position) {
      const symbol = state.position.symbol;
      optionFeed.track(OPTION_FEED_OWNER, symbol, (ltp, at) => {
        if (state.position && state.position.symbol === symbol) _applyOptionLtp(symbol, ltp, at, false);
      });
      const streamed = optionFeed.getFresh(symbol);
      // Another market filling at the quote also needs a fresh bid/ask for its
      // exit, which the stream does not carry: one REST quote at most ~5 s old.
      const _q = state.optionQuote;
      const _needQuote = !rt.home && rt.fillAtQuote() && !(_q && _q.symbol === symbol && Date.now() - _q.at <= 5000);
      if (streamed && !_needQuote) {
        _applyOptionLtp(symbol, streamed.ltp, streamed.at, false);
      } else {
        let _got = false;
        try {
          const r = await require("../services/marketData").getQuotes([symbol]);
          if (r && r.s === "ok" && r.d && r.d.length) {
            const ltp = r.d[0].v && (r.d[0].v.lp || r.d[0].v.ltp);
            if (typeof ltp === "number" && ltp > 0) { _applyOptionLtp(symbol, ltp, Date.now(), true); _got = true; }
            if (!rt.home && _got) {
              const v = r.d[0].v, _b = Number(v.bid || v.bid_price || 0), _a = Number(v.ask || v.ask_price || 0);
              if (_b > 0 && _a > 0 && state.position && state.position.symbol === symbol) state.optionQuote = { symbol, bid: _b, ask: _a, ltp, at: Date.now() };
            }
          }
        } catch (_) {}
        if (!_got && streamed) _applyOptionLtp(symbol, streamed.ltp, streamed.at, false);
      }
    }
    if (!_optionPollStopped) _optionPollTimer = setTimeout(poll, OPTION_POLL_MS);
  };
  _optionPollTimer = setTimeout(poll, OPTION_POLL_MS);
}
function stopOptionPolling() {
  _optionPollStopped = true;
  if (_optionPollTimer) { clearTimeout(_optionPollTimer); _optionPollTimer = null; }
  try { optionFeed.release(OPTION_FEED_OWNER); } catch (_) {}
}

// ── Trade simulation ─────────────────────────────────────────────────────────
async function simulateBuy(side, sig) {
  const spot = state.lastTickPrice;
  if (!spot || !side) return;
  const _sid = state._sessionId;

  let optInfo;
  try {
    optInfo = rt.home
      ? (_isFut
        ? await instrumentMode.resolveEntryInstrument(spot, side, "TDS")
        : await instrumentConfig.validateAndGetOptionSymbol(spot, side, "TDS"))
      : await _resolvePairEntry(spot, side);
  } catch (e) {
    log(`❌ ${TAG} Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ ${TAG} No valid ${_isFut ? "futures contract" : "expiry"} — skip ${side} entry`);
    skipLogger.appendSkipLog(MODE, { gate: "expiry", reason: _isFut ? "no valid futures contract" : "no valid option expiry", side, spot });
    return;
  }

  let optionEntryLtp = null;
  let _entryQuote = null;   // another market: the quote its spread limit and ask fill read
  if (_isFut) {
    // Futures trade AT the index level — there is no premium to quote.
    optionEntryLtp = spot;
  } else {
    try {
      const r = await require("../services/marketData").getQuotes([optInfo.symbol]);
      if (r && r.s === "ok" && r.d && r.d.length) {
        const v = r.d[0].v || {};
        const ltp = v.lp || v.ltp;
        if (typeof ltp === "number" && ltp > 0) {
          optionEntryLtp = ltp;
          try { tickRecorder.recordOptionLtp(optInfo.symbol, ltp, OWNER); } catch (_) {}
          if (!rt.home) _entryQuote = { ltp, bid: Number(v.bid || v.bid_price || 0), ask: Number(v.ask || v.ask_price || 0), at: Date.now() };
        }
      }
    } catch (e) {
      log(`⚠️ ${TAG} Option LTP fetch failed: ${e.message} — entry blocked`);
      return;
    }
    if (!optionEntryLtp) {
      log(`❌ ${TAG} Option LTP not available — entry skipped`);
      skipLogger.appendSkipLog(MODE, { gate: "option_ltp", reason: "no option LTP", symbol: optInfo.symbol, side, spot });
      return;
    }
    // Another market: its bid-ask spread limit (<PAIR>_MAX_SPREAD_PTS) on this
    // quote. A refusal is a failed fill, so the pending setup retries it; the
    // skip is logged once per bar.
    if (!rt.home && _entryQuote) {
      const _sp = tradeGuards.checkSpread(_entryQuote.bid, _entryQuote.ask, rt.maxSpreadPts());
      if (!_sp.ok) {
        if (state._spreadSkipBar !== state.barStartTime) {
          state._spreadSkipBar = state.barStartTime;
          log(`⏭️ ${TAG} SKIP ${side} entry — spread too wide (${_sp.reason}, limit ${rt.maxSpreadPts()}pt)`);
          skipLogger.appendSkipLog(MODE, { gate: "spread", reason: _sp.reason, symbol: optInfo.symbol, side, spot, spread: _sp.spread, limit: rt.maxSpreadPts() });
        }
        return;
      }
    }
  }
  // Another market fills at the ASK of a fresh quote (<PAIR>_PAPER_FILL_AT_QUOTE,
  // default on there); NIFTY fills at the LTP as it always did.
  const _ltpAtEntry = optionEntryLtp;
  let _askFill = null;
  if (!rt.home && !_isFut && _entryQuote) {
    const f = rt.entryFill(optionEntryLtp, _entryQuote, Date.now());
    if (f.source === "ask") { _askFill = f.price; optionEntryLtp = f.price; }
  }

  // /stop (or a stop + restart) may have run while we awaited — opening now
  // would strand an orphan position and its capital block.
  if (state.position || !state.running || state._sessionId !== _sid) return;

  const qty = tdsLotQty();

  // ── Capital gate — HARD: the pool must fund this position or the entry is
  //    refused (error line + skip log + dashboard alert, see capitalPool.gate).
  //    Sits AFTER the last strategy abort path so a refusal is never logged for
  //    a signal that would have been dropped anyway.
  const _cap = capitalPool.gate(MODE, _capitalRequired(qty, optionEntryLtp), { side, symbol: optInfo.symbol, qty });
  if (!_cap.ok) {
    if (!_cap.muted) {
      log(`❌ ${TAG} Entry REFUSED — ${_cap.reason}`);
      skipLogger.appendSkipLog(MODE, { gate: "capital", reason: _cap.reason, spot: spot, side, symbol: optInfo.symbol, qty, cost: _cap.cost, available: _cap.available });
    }
    return;
  }

  const pos = {
    isFutures:      _isFut,
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
    entryUnixSec:   Math.floor(Date.now() / 1000),
    entryBarTime:   Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    // Signal context (kept on the trade record for analytics / reports)
    signalSpot:     sig.entrySpot,
    slRawPts:       sig.slRaw,
    zone:           sig.zone,
    vwapAtEntry:    sig.vwap,
    emaAtEntry:     sig.ema,
    atrAtEntry:     sig.atr,
    bodyPts:        sig.bodyPts,
    bodyNeeded:     sig.bodyNeeded,
    pullbackLow:    sig.pullbackLow,
    pullbackHigh:   sig.pullbackHigh,
    gateSide:       state.dayGate ? state.dayGate.side : null,
    gateRangePts:   state.dayGate ? state.dayGate.rangePts : null,
    gateRangePct:   state.dayGate ? state.dayGate.rangePct : null,
    gateVwap:       state.dayGate ? state.dayGate.vwap : null,
    gateExtensionPts: state.dayGate ? state.dayGate.extensionPts : null,
    peakPremium:    optionEntryLtp,
    signalStrength: sig.signalStrength,
    mfeSpotPts:     0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
    entryReason:    sig.reason,
  };
  // Another market: the position names its market and instrument, and how its
  // entry was filled. NIFTY's position is exactly as above.
  if (!rt.home) {
    Object.assign(pos, {
      market: rt.marketKey, instrument: rt.instrumentName(),
      optionEntryFill: _isFut ? null : (_askFill ? "ask" : "ltp"),
      entryQuote: _entryQuote ? { bid: _entryQuote.bid, ask: _entryQuote.ask, ltp: _entryQuote.ltp } : null,
    });
  }

  state.position = pos;
  // Trade journal (observer only — utils/tradeJournal.js).
  tradeJournal.onEntry(pos, {
    reason: pos.entryReason, signal: `BUY_${side}`,
    indicators: {
      vwap: sig.vwap, ema: sig.ema, atr: sig.atr, zone: sig.zone,
      bodyPts: sig.bodyPts, bodyNeeded: sig.bodyNeeded,
      pullbackLow: sig.pullbackLow, pullbackHigh: sig.pullbackHigh, slRawPts: sig.slRaw,
      gateSide: pos.gateSide, gateRangePct: pos.gateRangePct, gateVwap: pos.gateVwap,
    },
    spot, optionLtp: _isFut ? null : optionEntryLtp,
    bid: _entryQuote ? _entryQuote.bid : null, ask: _entryQuote ? _entryQuote.ask : null,
    expiry: optInfo.expiryDate || optInfo.expiry || null,
    market: rt.marketKey, strategy: rt.strategy.key,
    isFutures: _isFut, qty, sl: _stopLevel(pos), target: null,
    expectedPrice: _isFut ? sig.entrySpot : _ltpAtEntry,
    candles: state.candles,
    nowMs: Date.now(),
  });
  capitalPool.block(MODE, _capitalRequired(qty, optionEntryLtp), { side, symbol: optInfo.symbol, qty, premium: optionEntryLtp });
  try { rt.persist.save(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  state.optionLtp = optionEntryLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;
  // Futures P&L comes from the spot feed — no option contract to poll.
  if (!_isFut) startOptionPolling();

  log(`🟢 ${TAG} BUY_${side} ${optInfo.symbol} qty=${qty} @ spot=${spot} optLtp=₹${optionEntryLtp}`);
  if (_askFill) log(`📌 ${TAG} Entry filled at the ASK ₹${_askFill} (LTP ₹${_ltpAtEntry}, bid ₹${_entryQuote.bid}) — ${rt.fillAtQuoteKey}`);
  log(`   ├─ Day gate: ${pos.gateSide} day · first-hour range ${pos.gateRangePts}pt (${pos.gateRangePct}%) · VWAP ${pos.gateVwap} · extension ${pos.gateExtensionPts}pt`);
  log(`   ├─ Setup: pullback to zone ${pos.zone} (VWAP ${pos.vwapAtEntry} / EMA ${pos.emaAtEntry}) → reclaim, body ${pos.bodyPts}pt ≥ ${pos.bodyNeeded}pt (ATR ${pos.atrAtEntry})`);
  log(`   └─ Pullback depth ${pos.slRawPts}pt · exit = global profit lock`);

  notifyEntry({
    mode: NOTIFY_MODE,
    side, symbol: optInfo.symbol,
    spotAtEntry: spot, optionEntryLtp,
    qty,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
    ...(rt.home ? {} : { isFutures: _isFut, instrument: rt.instrumentName() }),
  });

  try {
    tickRecorder.recordEntry({
      mode: OWNER,
      sessionId: state._sessionId,
      ts: Date.now(),
      side, symbol: optInfo.symbol, qty,
      spotEntry: spot, optionEntry: optionEntryLtp,
      reason: pos.entryReason,
    });
  } catch (_) {}
}

function simulateSell(reason) {
  if (!state.position) return;
  const pos = state.position;
  let exitOptLtp   = state.optionLtp || pos.optionEntryLtp;
  const exitSpot   = state.lastTickPrice || pos.entrySpot;
  const qty        = pos.qty;
  // Another market SELLS AT THE BID of a fresh quote of the held contract when
  // <PAIR>_PAPER_FILL_AT_QUOTE is on (pairRuntime.exitFill); NIFTY unchanged.
  const _ltpAtExit = exitOptLtp;
  let _exitFill = null, _exitQ = null;
  if (!rt.home && !pos.isFutures) {
    _exitQ = state.optionQuote && state.optionQuote.symbol === pos.symbol ? state.optionQuote : null;
    const f = rt.exitFill(exitOptLtp, _exitQ, Date.now());
    _exitFill = f.source;
    if (f.source === "bid") exitOptLtp = f.price;
  }
  const _pnlRes    = _computePnl({
    side: pos.side, entrySpot: pos.entrySpot, exitSpot,
    entryPremium: pos.optionEntryLtp, exitPremium: exitOptLtp,
    qty, broker: "fyers",
  });
  const charges    = _pnlRes.charges;
  const pnl        = _pnlRes.pnl;

  state.sessionPnl = parseFloat((state.sessionPnl + pnl).toFixed(2));

  // Trade journal (observer only): the exit, before the trade object is built.
  {
    const _kind = _exitKind(reason);
    const _lvl = _kind === "trail" || _kind === "sl" ? _stopLevel(pos) : null;
    tradeJournal.onExit(pos, {
      reason, kind: _kind,
      spot: exitSpot, optionLtp: pos.isFutures ? null : exitOptLtp,
      bid: _exitQ ? _exitQ.bid : null, ask: _exitQ ? _exitQ.ask : null,
      expectedPrice: _lvl != null ? _lvl : (pos.isFutures ? exitSpot : _ltpAtExit),
      fillPrice: pos.isFutures ? exitSpot : exitOptLtp,
      favPts: (exitSpot - pos.entrySpot) * (pos.side === "CE" ? 1 : -1),
      pnlRs: _pnlRes.gross,
      nowMs: Date.now(),
    });
  }

  const trade = {
    side:           pos.side,
    symbol:         pos.symbol,
    qty,
    entryPrice:     pos.entrySpot,
    exitPrice:      exitSpot,
    spotAtEntry:    pos.entrySpot,
    spotAtExit:     exitSpot,
    optionEntryLtp: pos.isFutures ? null : pos.optionEntryLtp,
    optionExitLtp:  pos.isFutures ? null : exitOptLtp,
    bestOptionLtp:  pos.isFutures ? null : (pos.peakPremium || null),
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    entryBarTime:   pos.entryBarTime,
    exitBarTime:    Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    pnl,
    pnlMode:        _isFut ? _pnlRes.pnlMode : `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp}`,
    exitReason:     reason,
    entryReason:    pos.entryReason,
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    optionType:     pos.side,
    optionEntrySymbol: pos.symbol,
    signalStrength: pos.signalStrength,
    // TREND_DAY_SCALP signal context
    slRawPts:       pos.slRawPts,
    zone:           pos.zone,
    vwapAtEntry:    pos.vwapAtEntry,
    emaAtEntry:     pos.emaAtEntry,
    atrAtEntry:     pos.atrAtEntry,
    bodyPts:        pos.bodyPts,
    pullbackLow:    pos.pullbackLow,
    pullbackHigh:   pos.pullbackHigh,
    gateSide:       pos.gateSide,
    gateRangePts:   pos.gateRangePts,
    gateRangePct:   pos.gateRangePct,
    gateVwap:       pos.gateVwap,
    gateExtensionPts: pos.gateExtensionPts,
    mfeSpotPts:     pos.mfeSpotPts || 0,
    mfePnl:         pos.mfePnl || 0,
    maeSpotPts:     pos.maeSpotPts || 0,
    maePnl:         pos.maePnl || 0,
    secsToMFE:      pos.secsToMFE || 0,
    secsToMAE:      pos.secsToMAE || 0,
    ...pathFields(pos),
    durationMs:     Date.now() - pos.entryTimeMs,
    charges,
    isFutures:      !!pos.isFutures,
    instrument:     pos.isFutures ? "NIFTY_FUTURES" : "NIFTY_OPTIONS",
    ...tradeJournal.fields(pos),
  };
  // Another market: the record names its market, strategy, spot and instrument
  // (consolidation, post-exit tracking and the MCP read them) and how each leg filled.
  if (!rt.home) {
    Object.assign(trade, {
      market:          rt.marketKey,
      strategyId:      rt.strategy.key,
      spotSymbol:      SPOT(),
      instrument:      rt.instrumentName(),
      optionEntryFill: pos.isFutures ? null : (pos.optionEntryFill || "ltp"),
      optionExitFill:  pos.isFutures ? null : _exitFill,
      entryQuote:      pos.entryQuote || null,
      exitQuote:       _exitFill === "bid" && _exitQ ? { bid: _exitQ.bid, ask: _exitQ.ask, ltp: _exitQ.ltp } : null,
    });
  }
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog(MODE, trade);

  log(`🔴 ${TAG} EXIT ${pos.side} ${pos.symbol} @ optLtp=₹${exitOptLtp} spot=${exitSpot} | PnL=₹${pnl} (${reason})`);

  notifyExit({
    mode: NOTIFY_MODE,
    side: pos.side, symbol: pos.symbol,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    optionEntryLtp: pos.optionEntryLtp, optionExitLtp: exitOptLtp,
    pnl, sessionPnl: state.sessionPnl,
    exitReason: reason, entryReason: pos.entryReason,
    entryTime: pos.entryTime, exitTime: trade.exitTime, qty,
    peakPremium: trade.bestOptionLtp, peakPnl: trade.mfePnl,
    maxDrawdown: trade.maePnl, heldMs: trade.durationMs,
    ...(rt.home ? {} : { isFutures: _isFut, instrument: rt.instrumentName() }),
  });

  try {
    tickRecorder.recordExit({
      mode: OWNER, sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitOptLtp, pnl, reason,
    });
  } catch (_) {}

  state.position = null;
  state.optionQuote = null;
  capitalPool.release(MODE, pnl);
  try { rt.persist.clear(); } catch (_) {}
  // Global wait-after-any-exit cooldown — no entry on either side for N candles.
  state._reentryBlockUntil = tradeGuards.reentryCooldownUntil(Date.now(), _resMin());
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;
  stopOptionPolling();
}

function _closeDay(reason) {
  state.dayClosed = true;
  state.dayClosedReason = reason;
  log(`⏸️ ${TAG} ${reason} — no more entries today`);
  skipLogger.appendSkipLog(MODE, { gate: "day_closed", reason, sessionPnl: state.sessionPnl, spot: state.lastTickPrice });
}

// ── Exits (per tick) ─────────────────────────────────────────────────────────
// The global profit lock is the ONLY automatic exit (manual exit, /stop and the
// TRADE_STOP_TIME session teardown aside).
function _checkExits(spotPrice) {
  if (!state.position) return;
  const pos = state.position;
  // Futures have no option contract to poll — the traded price IS the index
  // level, so mirror the spot in and every downstream reader stays correct.
  if (pos.isFutures && spotPrice > 0) {
    state.optionLtp = spotPrice;
    state.optionLtpUpdatedAt = Date.now();
  }
  const optLtp = state.optionLtp || pos.optionEntryLtp;

  const _peakBefore = pos.peakPremium, _mfeBefore = pos.mfeSpotPts;
  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;
  const favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const curPnl = _unrealisedPnl({
    side: pos.side, entrySpot: pos.entrySpot, currentSpot: spotPrice,
    entryPremium: pos.optionEntryLtp, currentPremium: optLtp, qty: pos.qty,
  });
  if (favPts > (pos.mfeSpotPts || 0)) { pos.mfeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl > (pos.mfePnl     || 0)) pos.mfePnl = parseFloat(curPnl.toFixed(2));
  if (favPts < (pos.maeSpotPts || 0)) { pos.maeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  trackPath(pos, favPts, Date.now());
  if (curPnl < (pos.maePnl     || 0)) pos.maePnl = parseFloat(curPnl.toFixed(2));
  // Trade journal (observer only): this tick, and the exit level whenever the
  // peak moved it (the profit lock / premium stop trails the peak).
  tradeJournal.onTick(pos, { favPts, pnlRs: curPnl, spot: spotPrice, ltp: pos.isFutures ? null : optLtp, nowMs: Date.now() });
  if (pos.peakPremium !== _peakBefore || pos.mfeSpotPts !== _mfeBefore) {
    const _lvl = _stopLevel(pos);
    if (_lvl != null) {
      const _locked = pos.isFutures ? (_lvl - pos.entrySpot) * (pos.side === "PE" ? -1 : 1) > 0 : _lvl > pos.optionEntryLtp;
      tradeJournal.onStopChange(pos, {
        to: _lvl, kind: _locked ? "lock" : "trail",
        reason: _locked ? "profit lock floor trails the peak" : "premium stop trails the peak",
        spot: spotPrice, ltp: pos.isFutures ? null : optLtp, nowMs: Date.now(),
      });
    }
  }

  // Global profit lock (shared across every strategy — see tradeGuards). Options
  // only: the lock is defined on option premium, and in futures mode optLtp
  // mirrors the SPOT, so leaving it on would test an 8% move in NIFTY itself.
  if (!pos.isFutures && pos.optionEntryLtp && state.optionLtp) {
    const _plMsg = tradeGuards.checkProfitLock(pos.optionEntryLtp, state.optionLtp, pos.peakPremium);
    if (_plMsg) {
      log(`🔒 ${TAG} ${_plMsg}`);
      simulateSell(_plMsg);
    }
  }
  // Futures: the same common stop mapped to index points (entry = fill spot).
  if (pos.isFutures && spotPrice > 0) {
    const _fsMsg = tradeGuards.checkFuturesStop(pos.side, pos.entrySpot, spotPrice, pos.mfeSpotPts);
    if (_fsMsg) {
      log(`🔒 ${TAG} ${_fsMsg}`);
      simulateSell(_fsMsg);
    }
  }
}

// ── The day gate — evaluated ONCE, then frozen ───────────────────────────────
function _maybeDecideDayGate() {
  if (state.dayGate && state.dayGate.decided) return;
  // evaluateDayGate anchors on the IST day of the LAST candle it is given, and
  // preloadHistory loads several days of warm-up. Starting a session before the
  // open therefore hands it a series ending YESTERDAY — it would decide and
  // FREEZE yesterday's verdict, and today's real gate would never run. Only ever
  // decide once the series has actually reached today.
  const last = state.candles.length ? state.candles[state.candles.length - 1] : null;
  if (!last) return;
  const today = tdsStrategy._istDayOf(Math.floor(Date.now() / 1000));
  if (tdsStrategy._istDayOf(last.time) !== today) return;

  // Feed the engine the CLOSED bars only; the forming bar must never move the gate.
  const gate = tdsStrategy.evaluateDayGate(state.candles, ENG({ silent: true }));
  if (!gate.decided) return;

  state.dayGate = gate;
  state.gateLoggedAt = istNow();
  if (gate.tradeable) {
    log(`🚦 ${TAG} DAY GATE PASSED — ${gate.reason}`);
    log(`   └─ ${gate.side} only for the rest of the day. Hunting a pullback into the VWAP/EMA zone.`);
  } else {
      log(`🚦 ${TAG} DAY GATE FAILED — ${gate.reason}`);
      for (const c of gate.checks || []) log(`   ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
      log(`   └─ Standing aside for the whole session. A zero beats a loss on a day with no trend.`);
      skipLogger.appendSkipLog(MODE, {
        gate: "day_gate", reason: gate.reason,
        rangePts: gate.rangePts, rangePct: gate.rangePct, vwap: gate.vwap,
        extensionPts: gate.extensionPts, extensionNeeded: gate.extensionNeeded,
        streakOk: gate.streakOk, spot: gate.spot,
      });
  }
}

// ── Entry evaluation (on candle close — the signal reads CLOSED bars only) ────
const ENTRY_RETRY_MS = 5000;

async function evaluateEntry() {
  // Every guard here is synchronous and runs before the first await, so
  // concurrent ticks can never open two positions.
  if (state.position || state._entryInFlight || state.dayClosed) return;
  if (state._expiryDayBlocked) return;   // another market's <PAIR>_EXPIRY_DAY_ONLY (logged at /start)
  if (!state.dayGate || !state.dayGate.decided || !state.dayGate.tradeable) return;
  if (state._lastEntryAttemptMs && Date.now() - state._lastEntryAttemptMs < ENTRY_RETRY_MS) return;

  // ── Risk gates ──────────────────────────────────────────────────────────
  {
    const pf = require("../utils/portfolioRisk").checkPortfolioCap();
    if (pf.blocked) { _closeDay(pf.reason); return; }
  }

  // ── The signal ──────────────────────────────────────────────────────────
  const sig = tdsStrategy.getSignal(state.candles, ENG({
    dayGate: state.dayGate,
  }));
  state.lastSignal = sig;

  if (sig.signal === "NONE" || !sig.side) {
    // Only log the interesting near-misses — a "no pullback" bar every 5 minutes
    // would bury the day file.
    if (!sig.warmup && /reclaim|conviction|SKIPPED|wrong colour/.test(sig.reason || "")) {
      skipLogger.appendSkipLog(MODE, {
        gate: /SKIPPED/.test(sig.reason) ? "sl_too_wide" : "setup_incomplete",
        reason: sig.skipReason || sig.reason,
        spot: state.lastTickPrice,
        zone: sig.zone, vwap: sig.vwap, ema: sig.ema, atr: sig.atr,
        bodyPts: sig.bodyPts, bodyNeeded: sig.bodyNeeded,
        pullbackLow: sig.pullbackLow, pullbackHigh: sig.pullbackHigh,
        slRaw: sig.slRaw,
      });
    }
    return;
  }

  // Global wait-after-any-exit cooldown (EXIT_REENTRY_COOLDOWN_CANDLES). Checked
  // here, not in simulateBuy: a simulateBuy refusal is read as a failed FILL and
  // retried mid-bar. Logged once per cooldown.
  if (state._reentryBlockUntil > Date.now()) {
    if (state._reentryBlockLogged !== state._reentryBlockUntil) {
      state._reentryBlockLogged = state._reentryBlockUntil;
      log(`⏸️ ${TAG} Wait-after-exit cooldown — no new entry until ~${new Date(state._reentryBlockUntil).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} (${sig.side} rejected)`);
    }
    return;
  }

  log(`🎯 ${TAG} SETUP: ${sig.reason}`);
  state._entryInFlight = true;
  state._lastEntryAttemptMs = Date.now();
  try {
    await simulateBuy(sig.side, sig);
  } finally {
    state._entryInFlight = false;
    if (state.position) {
      state._pendingEntry = null;
    } else {
      // A failed FILL is an infrastructure problem, not a decision. Hold the
      // signal so the next ticks can retry it — see _retryPendingEntry. The
      // retry throttle lives on THIS object, not on state._lastEntryAttemptMs:
      // sharing that field would let a retry firing seconds before a bar close
      // throttle out the new bar's own evaluation.
      state._pendingEntry = { side: sig.side, sig, lastAttemptMs: Date.now() };
      log(`⚠️ ${TAG} Entry attempt failed — retrying every ${ENTRY_RETRY_MS / 1000}s until this bar is superseded`);
    }
  }
}

/**
 * Retry a signalled entry whose FILL failed (option LTP unavailable, expiry
 * unresolved, quotes blip). The DECISION is already made and reads only CLOSED
 * bars, so re-running it mid-bar cannot change it — this re-attempts only the
 * broker side, throttled so a persistent failure never hammers the API.
 *
 * The pending signal is dropped at the next candle close (onCandleClose), so a
 * stale setup can never fill minutes later off a bar the market has moved past.
 * Without this, a one-second quote blip cost the whole day's setup: TDS takes
 * ~2 trades on the minority of days that pass the gate at all.
 */
async function _retryPendingEntry() {
  const p = state._pendingEntry;
  if (!p) return;
  if (state.position || state._entryInFlight) return;
  if (state.dayClosed) { state._pendingEntry = null; return; }
  if (Date.now() - p.lastAttemptMs < ENTRY_RETRY_MS) return;

  state._entryInFlight = true;
  p.lastAttemptMs = Date.now();
  try {
    await simulateBuy(p.side, p.sig);
  } finally {
    state._entryInFlight = false;
    if (state.position) state._pendingEntry = null;
  }
}

// ── Candle close handler ─────────────────────────────────────────────────────
// The gate and the entry both read CLOSED bars only, so both are driven from here.
function onCandleClose(bar) {
  _maybeDecideDayGate();
  // A new bar supersedes any setup still waiting on a failed fill — the market
  // has moved on, and this bar's own evaluation is the current truth.
  state._pendingEntry = null;
  // Trade journal: a 1-minute candle size makes these the journal's minute rows
  // (at 5 minutes the journal builds its own from the ticks).
  if (state.position && bar && _resMin() === 1) tradeJournal.onCandle(state.position, { candle: bar, nowMs: Date.now() });
  if (state.position) return;                    // exits are per-tick, not per-bar
  // Gate on the BAR's close time, exactly as the engine does — not on the wall
  // clock. The two disagree at the boundary: the 13:55 bar closes AT 14:00, so a
  // wall-clock `>= 14:00` check drops the last legal entry bar that the engine
  // (and therefore the backtest) still accepts.
  if (!bar || typeof bar.time !== "number") return;
  const _closeMins = tdsStrategy._utcSecToIstMins(bar.time) + _resMin();
  if (_closeMins > _parseMins(`${PREFIX}_ENTRY_END`, "14:00")) return;
  evaluateEntry().catch(e => console.error(`🚨 ${TAG} entry-eval error: ${e.message}`));
}

// ── onTick ───────────────────────────────────────────────────────────────────
function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (!price || price <= 0) return;

  const resMin = _resMin();
  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  const bucketMs = getBucketStart(Date.now(), resMin);
  if (!state.currentBar || state.barStartTime !== bucketMs) {
    if (state.currentBar) {
      const lastC = state.candles.length ? state.candles[state.candles.length - 1] : null;
      if (lastC && lastC.time === state.currentBar.time) {
        state.candles[state.candles.length - 1] = { ...state.currentBar };
      } else {
        state.candles.push({ ...state.currentBar });
      }
      // Deep buffer: EMA20/ATR14 are recomputed over this array and an EMA seeded
      // from a short window carries a startup transient. The backtest computes the
      // same EMA over the whole range, so trimming this short would make Paper and
      // Backtest disagree about the zone.
      if (state.candles.length > 300) state.candles.shift();
      try { onCandleClose(state.currentBar); }
      catch (e) { console.error(`🚨 ${TAG} onCandleClose error: ${e.message}`); }
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

  if (state.position) _checkExits(price);

  if (!state.position && state._pendingEntry) {
    _retryPendingEntry().catch(e => console.error(`🚨 ${TAG} entry-retry error: ${e.message}`));
  }
}

// ── Preload intraday history ─────────────────────────────────────────────────
// The zone is EMA20(5m) and the conviction gate is ATR14(5m); both carry a
// seeding transient. The backtest computes them over the whole range, so Paper
// must start warm or the two would disagree about the same bar.
const WARM_BARS = 150;

async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { fetchCandles } = require("../services/marketData");
    const resMin = _resMin();
    const barsPerDay = Math.max(1, Math.round(375 / resMin));
    const lookbackDays = Math.max(5, Math.ceil((WARM_BARS / barsPerDay) * 1.5) + 2);
    const _now = new Date();
    const istToday = _now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const istStart = new Date(_now.getTime() - lookbackDays * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached(SPOT(), String(resMin), istStart, istToday, fetchCandles);
    if (Array.isArray(candles) && candles.length > 0) {
      state.candles = candles.slice(-300);
      // Fyers history includes TODAY'S STILL-FORMING bar. Leaving it in
      // state.candles is wrong twice over: starting between 10:10 and 10:15 would
      // let the day gate decide — and FREEZE for the whole session — off an
      // incomplete 10:10 bar; and if the first live tick lands in a later bucket
      // the truncated bar is never completed, silently skewing EMA/ATR/VWAP all
      // day and breaking Paper≡Backtest. Hoist it into currentBar instead: ticks
      // keep filling it and onCandleClose fires when it really closes.
      const _bucketMs  = getBucketStart(Date.now(), resMin);
      const _lastLoaded = state.candles[state.candles.length - 1];
      if (_lastLoaded && _lastLoaded.time === Math.floor(_bucketMs / 1000)) {
        state.currentBar   = state.candles.pop();
        state.barStartTime = _bucketMs;
      }
      log(`📊 ${TAG} Preloaded ${state.candles.length} × ${resMin}-min closed spot candles (${istStart}→${istToday}, ${lookbackDays}d lookback)${state.currentBar ? ` + the forming ${resMin}m bar` : ""}`);
      if (state.candles.length < WARM_BARS) {
        log(`⚠️ ${TAG} Only ${state.candles.length} bars preloaded (< ${WARM_BARS}) — EMA/ATR start inside their seeding transient, so early values may differ slightly from Backtest.`);
      }
      // A restart after 10:15 must not lose the day's verdict.
      _maybeDecideDayGate();
    } else {
      log(`📊 ${TAG} No intraday history available — will build from live ticks`);
    }
  } catch (e) {
    log(`⚠️ ${TAG} Intraday preload failed: ${e.message}`);
  }
}

// ── Auto-stop at TRADE_STOP_TIME ─────────────────────────────────────────────
let _autoStopTimer = null;
// A session started after its stop time (e.g. a 16:00 start) used to get no
// timer at all and held its socket slot all night. Hard-stop it this long after
// start instead. Never in replay — replay runs at any wall-clock hour.
const LATE_START_GRACE_MIN = 30;
function _lateStartStopMins() {
  try { if (require("../services/tickReplay").isReplayInProgress()) return 0; } catch (_) {}
  const t = (getISTMinutes() + LATE_START_GRACE_MIN) % 1440;
  const hhmm = String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
  log(`⏰ ${TAG} Session started after its stop time — will stop at ${hhmm} IST`);
  return LATE_START_GRACE_MIN;
}

function scheduleAutoStop() {
  if (_autoStopTimer) clearTimeout(_autoStopTimer);
  // NIFTY: TRADE_STOP_TIME as always. Another market: its session end (MCX
  // 23:30; NSE / BSE TRADE_STOP_TIME).
  const raw = rt.home ? (process.env.TRADE_STOP_TIME || "15:30") : rt.stopTimeLabel();
  const [h, m] = raw.split(":").map(Number);
  const stopMin = h * 60 + (isNaN(m) ? 0 : m);
  let minsLeft = stopMin - getISTMinutes();
  if (minsLeft <= 0) { minsLeft = _lateStartStopMins(); if (!minsLeft) return; }
  _autoStopTimer = setTimeout(() => { log(`⏰ ${TAG} Auto-stop @ ${raw} IST`); stopSession(); }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ────────────────────────────────────────────────────────
router.get("/start", async (req, res) => {
  if (state.running) return res.redirect(`${ROUTE}/status`);

  if (rt.home) {
    if (String(process.env.TDS_MODE_ENABLED || "true").toLowerCase() !== "true") {
      return res.status(403).send(_errorPage("Trend Day Scalp Disabled", "Enable Trend Day Scalp Mode in Settings first", "/settings", "Go to Settings"));
    }
    if (String(process.env.TDS_PAPER_ENABLED || "true").toLowerCase() !== "true") {
      return res.status(403).send(_errorPage("Trend Day Scalp Paper Disabled", "Enable Trend Day Scalp Paper Trading in Settings first", "/settings", "Go to Settings"));
    }
  } else {
    // Every non-home pair ships OFF: its own switch, then the strategy's paper
    // switch (its own value, else NIFTY's — config/pairs.js).
    if (!rt.enabled()) {
      return res.status(403).send(_errorPage(`${TITLE} Disabled`, `Turn on ${pair.enabledKey} in Settings → ${rt.market().label} first`, `/settings#pair-${pair.slug}`, "Go to Settings"));
    }
    if (!rt.paperEnabled()) {
      return res.status(403).send(_errorPage(`${TITLE} Paper Disabled`, `${pairs.pairKey(pair, rt.strategy.paperEnabled.key)} (or TDS_PAPER_ENABLED) is off`, `/settings#pair-${pair.slug}`, "Go to Settings"));
    }
  }

  const check = rt.socketSlot.canStart();
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, `${ROUTE}/status`, "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  // This market's exchange calendar (NSE / BSE holidays; MCX weekends).
  const holiday = rt.home ? await isTradingAllowed() : await rt.isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, `${ROUTE}/status`, "← Back"));

  // The spot the candles are built from (MCX has no index: the series' future,
  // read from the Fyers MCX symbol master).
  let subscribeSymbol = rt.spotSymbol();
  if (rt.isMcx) {
    try { subscribeSymbol = await rt.resolveSpotSymbol(); }
    catch (e) { return res.status(400).send(_errorPage("Cannot Start", `${TITLE}: no ${rt.market().label} future resolved — ${e.message}`, `${ROUTE}/status`, "← Back")); }
  }
  if (!subscribeSymbol) return res.status(400).send(_errorPage("Cannot Start", `${TITLE}: no spot symbol for ${rt.market().label}`, `${ROUTE}/status`, "← Back"));
  _spotSym = subscribeSymbol;

  state = _freshState();
  state.running = true;
  state._unsaved = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `${rt.replayMode}:${Date.now()}`;

  rt.socketSlot.set();

  const cfg = _cfg();
  log(`🟢 ${TAG} Session started — ${tdsStrategy.NAME}`);
  log(`⚙️ ${TAG} Gate ${_envStr(`${PREFIX}_GATE_TIME`, "10:15")} (range ≥${cfg.minRangePct}% · ${cfg.vwapStreakBars} closes one side of VWAP · extension ≥${cfg.extensionMult}×range) · zone VWAP/EMA${cfg.emaPeriod} · body ≥${cfg.bodyAtrMult}×ATR${cfg.atrPeriod} · depth ≤${cfg.maxSlPts}pt · exit = global profit lock`);
  log(`⚙️ ${TAG} Entries until ${_envStr(`${PREFIX}_ENTRY_END`, "14:00")} · qty ${tdsLotQty()}`);
  // Another market's trade days: <PAIR>_EXPIRY_DAY_ONLY against THAT market's
  // expiry calendar. NIFTY has no expiry-day rule.
  if (!rt.home) {
    log(`🌐 ${TAG} ${rt.market().label} · ${subscribeSymbol} · ${rt.instrumentName()} · lot ${tdsLotQty()}`);
    if (rt.expiryDayOnly()) {
      const isExpiry = rt.isExpiryDay();
      if (!isExpiry) state._expiryDayBlocked = true;
      log(`📅 ${TAG} Expiry-only mode (${rt.market().label}): ${isExpiry ? "✅ Today is expiry — trading allowed" : "❌ Not this market's expiry day — entries blocked"}`);
    }
  }

  await preloadHistory();

  try {
    tickRecorder.recordSessionStart({
      mode: OWNER,
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: state.candles.map(c => ({ ...c })),
      meta: {
        instrument: rt.instrumentName(),
        resolutionMin: _resMin(),
        spotSymbol: SPOT(),
        sessionStartISO: state.sessionStart,
        recordsOptionLtps: true,
      },
    });
  } catch (_) {}

  if (rt.home) {
    if (socketManager.isRunning()) {
      socketManager.addCallback(CALLBACK_ID, onTick, log);
      log(`📡 ${TAG} Piggybacking on existing WebSocket`);
    } else {
        socketManager.start(subscribeSymbol, () => {}, log);
        socketManager.addCallback(CALLBACK_ID, onTick, log);
        log(`📡 ${TAG} Started WebSocket`);
    }
  } else {
    // Bound to this market's spot: the shared socket adds it beside NIFTY.
    const _wasRunning = socketManager.isRunning();
    if (!_wasRunning) socketManager.start(subscribeSymbol, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log, subscribeSymbol);
    log(`📡 ${TAG} ${_wasRunning ? "Piggybacking on existing WebSocket" : "Started WebSocket"} — ${subscribeSymbol}`);
  }

  scheduleAutoStop();

  notifyStarted({
    mode: NOTIFY_MODE,
    text: [
      `📄 ${rt.home ? "TREND DAY SCALP" : rt.title} PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${tdsStrategy.NAME}`,
      `Day gate  : ${_envStr(`${PREFIX}_GATE_TIME`, "10:15")} — range ≥${cfg.minRangePct}%, ${cfg.vwapStreakBars} closes one side of VWAP, extension ≥${cfg.extensionMult}×range`,
      `Entry     : pullback into VWAP/EMA${cfg.emaPeriod} then reclaim, body ≥${cfg.bodyAtrMult}×ATR${cfg.atrPeriod}`,
      `Exit      : global profit lock`,
    ].filter(Boolean).join("\n"),
  });

  res.redirect(`${ROUTE}/status`);
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped");
  state.running = false;
  stopOptionPolling();

  try { tickRecorder.recordSessionStop({ mode: OWNER, sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  rt.socketSlot.clear();   // clear OWN mode first (else the socket never stops → leak)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: tdsStrategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
      saveData(data);
      state._unsaved = false;   // now inside totalPnl — the pool must not add it twice
      capitalPool.sessionSaved(MODE);
      log(`💾 ${TAG} Session saved — ${state.sessionTrades.length} trades, PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ ${TAG} Save failed: ${e.message}`);
    }
  }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  log(`📋 ${TAG} Day summary — ${state.sessionTrades.length} trade(s), ${wins}W/${state.sessionTrades.length - wins}L, net ₹${state.sessionPnl}, week ₹${weeklyPnl()}`);
  log(`🔴 ${TAG} Session stopped`);

  notifyDayReport({
    mode: NOTIFY_MODE,
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect(`${ROUTE}/status`); });
router.get("/exit", (req, res) => { if (state.position) simulateSell("Manual exit"); res.redirect(`${ROUTE}/status`); });

// ── /status/chart-data — candles + VWAP/EMA zone + bracket lines + markers ────
router.get("/status/chart-data", async (req, res) => {
  try {
    const cfg = _cfg();
    let srcCandles = state.candles;
    if (!state.running && srcCandles.length === 0 && (state.sessionTrades || []).length > 0) {
      srcCandles = await chartBackfill.candlesForRestoredTrades(SPOT(), _resMin(), state.sessionTrades);
    }
    const candles = srcCandles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.currentBar) candles.push({ time: state.currentBar.time, open: state.currentBar.open, high: state.currentBar.high, low: state.currentBar.low, close: state.currentBar.close });

    // Plot exactly what the engine computed — same functions, same inputs.
    const vwapSeries = tdsStrategy.computeVwapSeries(srcCandles, cfg.sessionStartMin)
      .filter(Boolean).map(p => ({ time: p.time, value: p.value }));
    const emaSeries = tdsStrategy.computeEmaSeries(srcCandles, cfg.emaPeriod)
      .filter(Boolean).map(p => ({ time: p.time, value: p.value }));

    const markers = [];
    for (const t of state.sessionTrades) {
      if (t.entryBarTime) markers.push({ time: t.entryBarTime, position: t.side === "CE" ? "belowBar" : "aboveBar", color: t.side === "CE" ? "#10b981" : "#ef4444", shape: t.side === "CE" ? "arrowUp" : "arrowDown", text: `${t.side} ${t.entryPrice}` });
      if (t.exitBarTime)  markers.push({ time: t.exitBarTime,  position: t.side === "CE" ? "aboveBar" : "belowBar", color: (t.pnl || 0) >= 0 ? "#10b981" : "#ef4444", shape: "circle", text: `${(t.pnl || 0) >= 0 ? "+" : ""}${Math.round(t.pnl || 0)}` });
    }

    const pos = state.position;
    res.json({
      candles, vwapSeries, emaSeries, markers,
      optionChart: optionChart.buildPayload({ store: state.optionChart, position: state.position, trades: state.sessionTrades }),
      entryPrice: pos ? pos.entrySpot : null,
      emaPeriod:  cfg.emaPeriod,
      gate: state.dayGate ? {
        decided: state.dayGate.decided, tradeable: state.dayGate.tradeable,
        side: state.dayGate.side, vwap: state.dayGate.vwap, gateTime: state.dayGate.gateTime,
      } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const data = loadData();
  const cfg = _cfg();

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = _unrealisedPnl({
      side: pos.side, entrySpot: pos.entrySpot, currentSpot: state.lastTickPrice,
      entryPremium: pos.optionEntryLtp, currentPremium: state.optionLtp, qty: pos.qty || tdsLotQty(),
    });
  }

  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) }); }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const bestTrade = state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null;
  const worstTrade = state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null;

  const g = state.dayGate;
  res.json({
    running: state.running, sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-100),
    tickCount: state.tickCount, lastTickPrice: state.lastTickPrice,
    candles: state.candles.length, currentBar: state.currentBar, sessionStart: state.sessionStart,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge,
    wins, losses, winRate, bestTrade, worstTrade, cumPnl, livePnl,
    weeklyPnl: weeklyPnl(),
    // TREND_DAY_SCALP context
    gateDecided:   !!(g && g.decided),
    gateTradeable: !!(g && g.tradeable),
    gateSide:      g ? g.side : null,
    gateReason:    g ? g.reason : null,
    gateChecks:    g ? g.checks : null,
    gateRangePts:  g ? g.rangePts : null,
    gateRangePct:  g ? g.rangePct : null,
    gateVwap:      g ? g.vwap : null,
    gateExtensionPts:    g ? g.extensionPts : null,
    gateExtensionNeeded: g ? g.extensionNeeded : null,
    gateTime:      _envStr(`${PREFIX}_GATE_TIME`, "10:15"),
    dayClosed:     state.dayClosed, dayClosedReason: state.dayClosedReason,
    lastSkipReason: state.lastSignal && state.lastSignal.signal === "NONE" ? (state.lastSignal.skipReason || state.lastSignal.reason) : null,
    cfg: {
      gateTime: _envStr(`${PREFIX}_GATE_TIME`, "10:15"), minRangePct: cfg.minRangePct,
      vwapStreakBars: cfg.vwapStreakBars, extensionMult: cfg.extensionMult,
      emaPeriod: cfg.emaPeriod, atrPeriod: cfg.atrPeriod, bodyAtrMult: cfg.bodyAtrMult,
      maxSlPts: cfg.maxSlPts,
      entryEnd: _envStr(`${PREFIX}_ENTRY_END`, "14:00"),
      resMin: _resMin(),
    },
    position: pos ? {
      side: pos.side, isFutures: !!pos.isFutures, symbol: pos.symbol, entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry,
      peakPremium: pos.peakPremium, entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      zone: pos.zone, atrAtEntry: pos.atrAtEntry, bodyPts: pos.bodyPts,
      qty: pos.qty, currentOptLtp: state.optionLtp,
      heldSec: Math.round((Date.now() - pos.entryTimeMs) / 1000),
    } : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

router.get("/status", (req, res) => {
  const liveActive = false;
  const data = loadData();
  const pos  = state.position;
  const cfg  = _cfg();
  const g    = state.dayGate;

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");

  const gateBadge = !g || !g.decided
    ? `<span style="color:#94a3b8;">⏳ Waiting for the ${_envStr(`${PREFIX}_GATE_TIME`, "10:15")} gate</span>`
    : g.tradeable
      ? `<span style="color:#10b981;">✓ ${g.side}-ONLY DAY</span>`
      : `<span style="color:#f59e0b;">✗ NO TRADE TODAY</span>`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${TITLE} — Paper</title>${faviconLink()}
<style>${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.gate-card{background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;margin-bottom:18px;}
.gate-check{display:flex;gap:8px;align-items:flex-start;font-size:0.74rem;margin-top:6px;color:#94a3b8;}
.gate-check .ic{flex:0 0 auto;}
.brk{font-size:0.72rem;color:#f59e0b;margin-top:8px;}
</style>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
</head><body>
${buildSidebar(rt.sidebarKey, liveActive)}
<div class="main-content">
${bbRsiTopBar({
  title: `⚡ ${TITLE} — Paper`,
  metaLine: `Day gate ${_envStr(`${PREFIX}_GATE_TIME`, "10:15")} → pullback into VWAP/EMA${cfg.emaPeriod} → exit = global profit lock`,
  running: state.running,
  primaryAction: { href: `${ROUTE}/start`, label: "▶ Start", color: "#7e22ce" },
  stopAction:    { href: `${ROUTE}/stop`,  label: "■ Stop" },
  historyHref: `${ROUTE}/history`,
})}

${bbRsiCapitalStrip({ starting: startCap, current: startCap + (data.totalPnl || 0), allTime: data.totalPnl || 0 })}

<div class="gate-card">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Day Gate — decided once at ${_envStr(`${PREFIX}_GATE_TIME`, "10:15")}, then frozen</div>
    <div style="font-size:0.85rem;font-weight:600;" id="gate-badge">${gateBadge}</div>
  </div>
  <div id="gate-detail" style="font-size:0.74rem;color:#94a3b8;margin-top:8px;">${g && g.decided ? g.reason : "Most days end here with no trade — that zero is the design goal."}</div>
  <div id="gate-checks">${(g && g.checks || []).map(c => `<div class="gate-check"><span class="ic">${c.ok ? "✅" : "❌"}</span><span><strong>${c.name}</strong> — ${c.detail}</span></div>`).join("")}</div>
  ${state.dayClosed ? `<div class="brk">⏸️ ${state.dayClosedReason}</div>` : ""}
</div>

${bbRsiStatGrid([
  { label: "Session P&L", value: inr(state.sessionPnl), color: state.sessionPnl >= 0 ? "#10b981" : "#ef4444" },
  { label: "Trades", value: `${state.tradesTaken}` },
  { label: "W / L", value: `${wins} / ${losses}` },
  { label: "Week P&L", value: inr(weeklyPnl()) },
  { label: "Spot", value: state.lastTickPrice != null ? String(state.lastTickPrice) : "—" },
])}

${bbRsiCurrentBar({ bar: state.currentBar, resMin: _resMin() })}

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">${SPOT_LABEL} ${_resMin()}m — VWAP / EMA${cfg.emaPeriod} zone</div>
  <div id="chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:420px;">
    <div id="chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;">
      <span style="color:#8b5cf6;">── VWAP</span> &nbsp;<span style="color:#3b82f6;">── EMA${cfg.emaPeriod}</span>
    </div>
  </div>
  ${optionChart.optionChartHtml('tds-opt-chart')}
</div>

<div id="pos-card" style="margin-bottom:18px;">${_positionCardHtml(pos, state.optionLtp)}</div>

${bbRsiActivityLog({ logsJSON: JSON.stringify(state.log.slice(-200)) })}
</div>
<script>
${modalJS()}
async function tdsRefresh() {
  try {
    const r = await fetch('${ROUTE}/status/data', { cache: 'no-store' });
    const d = await r.json();
    var gb = document.getElementById('gate-badge');
    if (gb) {
      gb.innerHTML = !d.gateDecided
        ? '<span style="color:#94a3b8;">⏳ Waiting for the ' + d.gateTime + ' gate</span>'
        : d.gateTradeable
          ? '<span style="color:#10b981;">✓ ' + d.gateSide + '-ONLY DAY</span>'
          : '<span style="color:#f59e0b;">✗ NO TRADE TODAY</span>';
    }
    var gd = document.getElementById('gate-detail');
    if (gd && d.gateReason) gd.textContent = d.gateReason;
    var gc = document.getElementById('gate-checks');
    if (gc && d.gateChecks) {
      gc.innerHTML = d.gateChecks.map(function(c){
        return '<div class="gate-check"><span class="ic">' + (c.ok ? '✅' : '❌') + '</span><span><strong>' + c.name + '</strong> — ' + c.detail + '</span></div>';
      }).join('');
    }
  } catch (e) {}
}
tdsRefresh();
setInterval(tdsRefresh, 4000);
</script>
<script>
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var container = document.getElementById('chart');
  if (!container) return;
  var chart = LightweightCharts.createChart(container, {
    width: container.clientWidth, height: container.clientHeight,
    layout:{ background:{type:'solid',color:'#0a0f1c'}, textColor:'#8ba1c2', fontSize:11, fontFamily:"'IBM Plex Mono', monospace" },
    grid:{ vertLines:{color:'#111827'}, horzLines:{color:'#111827'} },
    crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale:{ borderColor:'#1a2236' },
    timeScale:{ borderColor:'#1a2236', timeVisible:true, secondsVisible:false,
      tickMarkFormatter:function(t){ var d=new Date(t*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); } },
  });
  var cs = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var vw = chart.addLineSeries({ color:'#8b5cf6', lineWidth:2, priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false });
  var em = chart.addLineSeries({ color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false });
  var entryLine=null, _zoomed=false;
  async function fetchChart(){
    try {
      var r = await fetch('${ROUTE}/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) { (function(){
        var _lt=d.candles[d.candles.length-1].time, _dk=Math.floor((_lt+19800)/86400), _cut=_lt;
        for (var _i=d.candles.length-1;_i>=0;_i--){ if(Math.floor((d.candles[_i].time+19800)/86400)===_dk) _cut=d.candles[_i].time; else break; }
        var _k=function(a){ return Array.isArray(a)?a.filter(function(x){return x.time>=_cut;}):a; };
        d.candles=_k(d.candles);
        ['vwapSeries','emaSeries','markers'].forEach(function(kk){ if(d[kk]) d[kk]=_k(d[kk]); });
      })(); }
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        if (!_zoomed) { try {
          var lastT=d.candles[d.candles.length-1].time, dayK=Math.floor((lastT+19800)/86400), firstT=lastT;
          for (var i=d.candles.length-1;i>=0;i--){ if(Math.floor((d.candles[i].time+19800)/86400)===dayK) firstT=d.candles[i].time; else break; }
          chart.timeScale().setVisibleRange({ from:firstT, to:lastT }); _zoomed=true;
        } catch(_){} }
      }
      vw.setData(d.vwapSeries || []);
      em.setData(d.emaSeries || []);
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      if (entryLine) cs.removePriceLine(entryLine);
      entryLine=null;
      if (d.entryPrice) entryLine = cs.createPriceLine({ price:d.entryPrice, color:'#94a3b8', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
    } catch(e) {}
  }
  fetchChart();
  setInterval(fetchChart, 4000);
  window.addEventListener('resize', function(){ chart.applyOptions({ width: container.clientWidth }); });
})();
</script>
${optionChart.optionChartScript({ dataUrl: ROUTE + '/status/chart-data', id: 'tds-opt-chart' })}
</body></html>`;
  res.send(html);
});

function _positionCardHtml(pos, optLtp) {
  if (!pos) {
    return `<div style="background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;color:var(--muted-1,#8ba1c2);font-size:0.78rem;">No open position.</div>`;
  }
  const live = optLtp != null ? ((optLtp - pos.optionEntryLtp) * pos.qty * _dir(pos.side)).toFixed(0) : "—";
  return `<div style="background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:8px;">Open position</div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:0.8rem;color:#e2e8f0;">
    <div><span style="color:var(--muted-1,#8ba1c2);">Side</span> ${pos.side}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Symbol</span> ${pos.symbol}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Entry</span> ${pos.entrySpot}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Peak premium</span> ${pos.peakPremium}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Live P&L</span> ₹${live}</div>
  </div>
</div>`;
}

// ── History + daily-file viewers + restore + reset ────────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = false;
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  res.send(renderHistoryPage({
    routePrefix: ROUTE,
    sidebarKey: rt.historySidebarKey,
    pageTitle: `⚡ ${TITLE} Paper Trade History`,
    pageDocTitle: `${TITLE} Paper — History`,
    modalLabel: `${TITLE} Paper`,
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap,
    emptyLabel: `Start ${TITLE} paper trading to record your first session.`,
  }));
});

const _TDS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/download/daily-files", (req, res) => {
  const skips  = skipLogger.listDates(MODE);
  const trades = tradeLogger.listDailyDates(MODE);
  const byDate = new Map();
  for (const s of skips)  byDate.set(s.date, { date: s.date, skipsSize: s.size, tradesSize: 0 });
  for (const t of trades) { const row = byDate.get(t.date) || { date: t.date, skipsSize: 0, tradesSize: 0 }; row.tradesSize = t.size; byDate.set(t.date, row); }
  const rows = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  res.json(dailyFilesPaginate(rows, req.query));
});

router.get("/download/skips-all", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${MODE}_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates(MODE).map(d => d.date).sort();
  let body = "";
  for (const d of dates) { try { const p = skipLogger.filePathFor(MODE, d); if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8"); } catch (_) {} }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_TDS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `${MODE}_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_TDS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `${MODE}_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_TDS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_TDS_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: `Stop ${TITLE} paper trading first before deleting a session.` });
  const data = loadData();
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= (data.sessions || []).length) return res.status(400).json({ success: false, error: "Invalid session index." });
  data.sessions.splice(idx, 1);
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, message: "Session deleted successfully." });
});

router.post("/restore-session/:date", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: `Stop ${TITLE} paper trading before restoring.` });
  const date = String(req.params.date || "").trim();
  if (!_TDS_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades(MODE, date);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; if (key) seen.add(String(key)); }
  const missing = allTrades.filter(t => { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; return key && !seen.has(String(key)); });
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
  data.sessions.push({ date, strategy: (missing[0] && missing[0].strategy) || tdsStrategy.NAME, pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => istDayFromAny(a.date).localeCompare(istDayFromAny(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  // Today's restored trades are the ones a restart rehydrated as unsaved — now in totalPnl.
  if (date === tradeLogger.istDateString(Date.now())) state._unsaved = false;
  capitalPool.sessionSaved(MODE);   // drop the pool's file-P&L memo now
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: `Stop ${TITLE} paper trading before resetting.` });
  const fresh = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  require("../utils/paperReset").clearTodayFiles(MODE); // else restart rehydrates today's session
  state._unsaved = false;   // the rehydrated unsaved trades were just wiped with the history
  capitalPool.sessionSaved(MODE);
  return res.json({ success: true, message: `${TITLE} paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
});

router.post("/delete-session/:idx", (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const data = loadData();
    if (!Number.isFinite(idx) || idx < 0 || idx >= (data.sessions || []).length) return res.status(400).json({ success: false, error: "Invalid session index" });
    const removed = data.sessions.splice(idx, 1)[0];
    data.totalPnl = parseFloat((data.totalPnl - (removed.pnl || 0)).toFixed(2));
    saveData(data);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get("/download/trades.jsonl", (req, res) => {
  try {
    const data = loadData();
    const records = [];
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) records.push(Object.assign({ date: s.date, mode: MODE, strategy: s.strategy }, t));
    const today = new Date().toISOString().slice(0, 10);
    const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
    if (ai) {
      const md = aiExport.buildMarkdown(records, { title: `${TITLE} paper trades (full log)`, source: OWNER });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${MODE}_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="${MODE}_paper_trades_${today}.jsonl"`);
    res.send(records.map(r => JSON.stringify(r)).join("\n"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function _errorPage(title, message, backHref, backLabel) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>${title}</title>
<style>body{font-family:Inter,sans-serif;background:#040c18;color:#e0eaf8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{color:#94a3b8;margin-bottom:18px;}
a{color:#3b82f6;text-decoration:none;border:0.5px solid #0e1e36;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>${title}</h2><p>${message}</p><a href="${backHref}">${backLabel}</a></body></html>`;
}

router.stopSession = stopSession;
router.pairRuntime = rt;
return router;
}   // ── end create(pair) ──

// One instance per pair, built on first use — the NIFTY one at load.
const _instances = new Map();
function forPairInstance(p) {
  if (!p) return null;
  if (!_instances.has(p.id)) _instances.set(p.id, create(p));
  return _instances.get(p.id);
}
/** The router of this strategy on `marketKey` ("BANKNIFTY", "SENSEX", …), or null when not offered. */
function forMarket(marketKey) { return forPairInstance(pairs.get("trendDayScalp", marketKey)); }

const home = forMarket("NIFTY");
home.create    = create;
home.forMarket = forMarket;
home.forPair   = forPairInstance;
module.exports = home;

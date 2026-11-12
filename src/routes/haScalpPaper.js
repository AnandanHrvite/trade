/**
 * HA SCALP PAPER — /ha-scalp-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL surface. Every decision / fill / exit semantic for HA_SCALP lives
 * here; the backtest must match THIS, never the reverse
 * (see feedback_paper_logic_untouchable).
 *
 * The day in one paragraph: the engine builds HEIKIN ASHI candles from closed
 * 15-minute NIFTY SPOT bars and watches two things — which side of the 50 MA
 * the raw close sits on, and whether the newest HA candle is a "no wick"
 * strength candle in that same direction. Above the MA it will only ever buy a
 * CE, and only on a BULLISH HA candle with no bottom wick. Below the MA it will
 * only ever buy a PE, and only on a BEARISH HA candle with no top wick. The
 * trade is then held until the global profit lock (or a manual / session exit)
 * closes it.
 *
 * ONE INSTRUMENT: NIFTY 50 INDEX. Every decision, level and exit is a spot
 * level read from closed 15-minute bars off the Fyers HISTORY endpoint — the
 * same endpoint the backtest and replay read, which is what makes the four
 * modes agree. The shared spot WebSocket supplies the live spot price, plus
 * this session's heartbeat and tick count.
 *
 * HEIKIN ASHI vs RAW — the distinction that matters:
 *   • DECISIONS (colour, wick, doji) read the HEIKIN ASHI candle.
 *   • PRICES (the entry reference) read the RAW candle.
 * An HA price is an average of four numbers; nothing ever traded there. Mixing
 * the two invents fills that could not have happened.
 *
 * Exits: the global profit lock (tradeGuards.checkProfitLock) is the ONLY
 * automatic exit, tested on every poll/tick. Otherwise a trade closes on the
 * manual exit, /stop, or the global TRADE_STOP_TIME session auto-stop. There is
 * no stop loss, trail, breakeven, target, candle exit or day-loss breaker.
 *
 * Signal engine: src/strategies/ha_scalp.js (shared by paper, backtest
 * and replay — no rule is re-implemented in this file).
 *
 * Uses LIVE data but SIMULATES orders locally.
 * Endpoints: /start /stop /exit /status /status/data /status/chart-data
 *            /history /reset /session/:i /download/... /view/...
 *
 * MARKETS. This file is a create(pair) builder (see utils/pairRuntime.js and
 * routes/emaRsiStV2Paper.js, the pilot). The default export is the NIFTY
 * instance: /ha-scalp-paper, the same files, keys, logs and decisions.
 * forMarket(key) builds the same engine for every other market pairs.js offers
 * it on (SENSEX, BANKNIFTY, NIFTY futures, MCX, SAIL), each with its own route
 * /<modeKey>-paper, trades file, logs, crash snapshot, socket slot and capital
 * book, its closed bars read from THAT market's spot history. Every per-market
 * fact (spot, strike grid, lot, option symbol, expiry, session, futures, fills)
 * comes from pairRuntime; the rules never branch on the market. Pair-only
 * behaviour sits behind `!rt.home`: its own ON switch (<PAIR>_MODE_ENABLED,
 * default off), <PAIR>_EXPIRY_DAY_ONLY on that market's expiry, the spread
 * limit and fill at the ask / bid of a fresh quote (<PAIR>_PAPER_FILL_AT_QUOTE,
 * default on off NIFTY), that exchange's charges, futures P&L for NIFTY_FUT.
 */

const express = require("express");
const { trackPath, pathFields } = require("../utils/tradePath");
const fs      = require("fs");
const path    = require("path");

const haStrategy        = require("../strategies/ha_scalp");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const tradeGuards        = require("../utils/tradeGuards");
const vixFilter          = require("../services/vixFilter");
const { verifyFyersToken } = require("../services/marketData");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { renderHistoryPage, dailyFilesPaginate } = require("../utils/paperHistoryUI");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiCapitalStrip, bbRsiStatGrid, bbRsiCurrentBar, bbRsiActivityLog, inr } = require("../utils/bbRsiStyleUI");
const { isTradingAllowed } = require("../services/marketData");
const tradeLogger = require("../utils/tradeLogger");
const aiExport    = require("../utils/aiExport");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const instrumentMode = require("../utils/instrumentMode");
const { istDayFromAny, istIsoFromAny, getISTMinutes, getBucketStart } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");
const capitalPool = require("../utils/capitalPool");
const optionChart = require("../utils/optionChart");
const pairs        = require("../config/pairs");
const pairRuntime  = require("../utils/pairRuntime");
const tradeJournal = require("../utils/tradeJournal");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");

// ═══════════════════════════════════════════════════════════════════════════════
// BUILDER: one paper engine per (strategy, market) pair. create(pair) returns an
// Express router holding ALL of that pair's state. See the MARKETS note above.
// ═══════════════════════════════════════════════════════════════════════════════
function create(pair) {
const rt     = pairRuntime.forPair(pair);
const router = express.Router();
const MODE    = rt.modeKey;      // "ha_scalp" on NIFTY: tradeLogger / skipLogger / capitalPool key
const PREFIX      = rt.envPrefix;    // "HA_SCALP" on NIFTY
const ROUTE       = rt.paperPath;    // "/ha-scalp-paper" on NIFTY
const OWNER       = rt.ownerId;      // "ha-scalp-paper" on NIFTY: recorder tag, session id
const CALLBACK_ID = rt.home ? "haScalpPaper" : OWNER;   // socketManager callback id
const TAG         = rt.home ? "[HA-SCALP-PAPER]" : `[${rt.tag}-PAPER]`;
const NOTIFY_MODE = rt.home ? "HA-SCALP-PAPER" : rt.notifyMode;
const TITLE       = rt.home ? "HA Scalp" : `${rt.market().label} · HA Scalp`;
// What the page / logs call the decision chart ("NIFTY 50" on NIFTY, as always).
const SPOT_LABEL  = rt.home ? "NIFTY 50" : rt.market().label;
// A non-home pair's own value of one of HA_SCALP's keys (else NIFTY's —
// pairs.envGet); undefined on NIFTY, so `PV(k) || <the literal NIFTY read> || d`
// is the old read there.
const PV = (k) => (rt.home ? undefined : pairs.envGet(`${PREFIX}_${k}`));
// Spot symbol the bars are fetched for: resolved at /start (MCX: the series' future).
let _spotSym = null;
const SPOT = () => (rt.home ? NIFTY_INDEX_SYMBOL : (_spotSym || rt.spotSymbol()));
// Starting capital: NIFTY's Zerodha book as always; another market draws on the Fyers pool.
const CAP_ENV = (rt.home ? rt.strategy.broker : pair.broker) === "fyers" ? "FYERS_INV_AMOUNT" : "ZERODHA_INV_AMOUNT";
rt.registerCapital();
const PT_FILE  = path.join(DATA_DIR, rt.tradesFile);

// There is no contract to roll: the NIFTY 50 INDEX symbol is a constant, and it
// is both the strike reference and the instrument every level is measured on.

// ── Config readers (Settings mutates process.env live — never cache) ──────────
/**
 * The engine's config. NIFTY: getConfig() exactly as before (and engine calls
 * pass the cfg they always did). Another market: its own keys with inheritance;
 * on MCX the session's bars start at that market's open unless the pair sets
 * its own <PAIR>_SESSION_START.
 */
function _cfg() {
  if (rt.home) return haStrategy.getConfig();
  const c = haStrategy.getConfig(PREFIX);
  if (rt.isMcx && !process.env[`${PREFIX}_SESSION_START`]) c.sessionStartMin = rt.sessionOpenMin();
  return c;
}
/** Engine opts: unchanged on NIFTY; another market adds its own cfg. */
const ENG = (o) => (rt.home ? o : Object.assign({ cfg: _cfg() }, o));
function _resMin() { return _cfg().resolutionMins; }
/** One of HA_SCALP's keys by its suffix ("ENTRY_END"): the pair's own value, else NIFTY's. */
function _envStr(k, fallback) { return String(PV(k) || process.env[`HA_SCALP_${k}`] || fallback); }
function _pollMs() {
  const v = parseInt(PV("POLL_MS") || process.env.HA_SCALP_POLL_MS || "2000", 10);
  return Number.isFinite(v) && v >= 500 && v <= 30000 ? v : 2000;
}
/**
 * How long after a bar closes before the Fyers history endpoint is asked for it.
 * Fetching the instant the clock ticks over often returns the bar still one
 * short, which would silently delay every decision by a whole bar.
 */
/**
 * How many CALENDAR days of history to preload. Must cover enough TRADING
 * sessions for the 50 MA plus the HA warm-up: at 25 bars a session, 51 bars is
 * ~3 sessions, and 15 calendar days survives a long holiday stretch.
 */
function _warmupDays() {
  const v = parseInt(PV("WARMUP_DAYS") || process.env.HA_SCALP_WARMUP_DAYS || "15", 10);
  return Number.isFinite(v) && v >= 3 && v <= 120 ? v : 15;
}

function _historyLagMs() {
  const v = parseInt(PV("HISTORY_LAG_MS") || process.env.HA_SCALP_HISTORY_LAG_MS || "5000", 10);
  return Number.isFinite(v) && v >= 0 && v <= 60000 ? v : 5000;
}

/** Position size — the one common Lot Multiplier (Settings → Common Rules), on this market's lot. */
function haLotQty() {
  return rt.home ? instrumentConfig.getLotQty() : rt.lotQty();
}

// ── Instrument maths. NIFTY: instrumentMode exactly as before (options, or the
//    global futures switch). Another market: its own instrument (NIFTY_FUT
//    trades the month future at the index level) and its exchange's charges
//    (BSE for SENSEX, MCX for commodities). ──────────────────────────────────
function _dir(side) { return side === "PE" ? -1 : 1; }
function _r2(x) { return parseFloat(x.toFixed(2)); }
function _computePnl(o) {
  if (rt.home) return instrumentMode.computePnl(o);
  const qty = o.qty || 0;
  const exchange = rt.market().exchange;
  if (rt.isFutures) {
    const gross = (o.exitSpot - o.entrySpot) * _dir(o.side) * qty;
    const charges = getCharges({ broker: o.broker, isFutures: rt.isFutures, exchange, entryPremium: o.entrySpot, exitPremium: o.exitSpot, qty });
    return { gross: _r2(gross), charges, pnl: _r2(gross - charges), pnlMode: `futures: entry ₹${o.entrySpot} → exit ₹${o.exitSpot} (${_dir(o.side) > 0 ? "LONG" : "SHORT"})`, isFutures: rt.isFutures };
  }
  const gross = (o.exitPremium - o.entryPremium) * qty;
  const charges = getCharges({ broker: o.broker, isFutures: rt.isFutures, exchange, entryPremium: o.entryPremium, exitPremium: o.exitPremium, qty });
  return { gross: _r2(gross), charges, pnl: _r2(gross - charges), pnlMode: `option premium: entry ₹${o.entryPremium} → exit ₹${o.exitPremium}`, isFutures: rt.isFutures };
}
function _unrealisedPnl(o) {
  if (rt.home || !rt.isFutures) return instrumentMode.unrealisedPnl(o);
  return _r2((o.currentSpot - o.entrySpot) * _dir(o.side) * (o.qty || 0));
}
function _capitalRequired(qty, price) {
  if (rt.home || !rt.isFutures) return instrumentMode.capitalRequired(qty, price);
  const pct = instrumentConfig.underlyingOf(rt.underlyingKey).marginPct;
  return _r2((qty || 0) * (price || 0) * (pct / 100));
}
/**
 * Another market's entry contract. Options keep HA_SCALP's slightly-ITM strike
 * on THIS market's grid (<PAIR>_ITM_STEPS, else HA_SCALP_ITM_STEPS, default 1);
 * futures take the month contract; MCX its series' ATM option.
 */
async function _resolvePairEntry(spot, side) {
  if (rt.isFutures || rt.isMcx) return rt.resolveEntrySymbol(spot, side);
  return instrumentConfig.validateAndGetOptionSymbol(spot, side, "HA_SCALP", { underlying: rt.underlyingKey, itmSteps: PV("ITM_STEPS") });
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
    const init = { capital: parseFloat(process.env[CAP_ENV] || "100000"), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(init, null, 2));
    _dataCache = init;
    return init;
  }
  try { _dataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error(`[${OWNER}] ${rt.tradesFile} corrupt — resetting:`, e.message);
    _dataCache = { capital: parseFloat(process.env[CAP_ENV] || "100000"), totalPnl: 0, sessions: [] };
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
    // SPOT bars — the decision series. Closed bars only.
    candles:        [],
    lastClosedBarTime: null,
    formingBar:     null,   // display-only: the bar being built from live ticks
    tickCount:      0,
    lastTickTime:   null,
    lastTickPrice:  null,   // NIFTY 50 INDEX spot
    position:       null,
    optionLtp:      null,
    optionLtpUpdatedAt: null,
    log:            [],
    _sessionId:     null,
    // HA_SCALP specific
    lastSignal:     null,
    optionChart:    null,   // premium OHLC accumulator (display only)
    ha:             [],     // Heikin Ashi series, index-aligned to state.candles
    ma:             [],     // trend MA series, index-aligned to state.candles
    lastHa:         null,   // newest closed HA candle, for the UI
    lastMa:         null,
    lastTrend:      null,
    dayClosed:      false,
    dayClosedReason: null,
    _histInFlight:  false,
    _histBucket:    null,   // bucket whose history fetch has already been done
    _histFailures:  0,
    _histNextTryMs: null,   // backoff floor after a failed history fetch
    _entryInFlight: false,
    _lastEntryAttemptMs: null,
    _pendingEntry:  null,   // a signalled entry whose FILL failed — retried per poll
    _reentryBlockUntil: 0,  // wait-after-any-exit cooldown (epoch ms), see simulateSell
    optionQuote:    null,   // another market: latest bid/ask of the held contract (fill at the bid)
    _expiryDayBlocked: false, // another market: <PAIR>_EXPIRY_DAY_ONLY on a non-expiry day
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

// ── Spot quote poll — the live price every exit is measured against ────────
// This runs for the WHOLE session, not only while a position is open: it also
// supplies the forming spot bar for the chart and the clock that triggers the
// history refresh. The option LTP rides in the SAME request when a position is
// open, so holding a trade costs no extra API call.
let _pollTimer = null;
let _pollStopped = true;

/**
 * Pull the OPTION premium out of a getQuotes response.
 *
 * Attribution is STRICTLY by symbol — never "whatever is left over". Some Fyers
 * response shapes omit the symbol on a row, and an else-branch would then write
 * some other instrument's price into the option premium, which is the number
 * every P&L is computed from. An unidentifiable row is dropped instead, except
 * when a single-symbol request came back with a single row, where there is
 * nothing to confuse it with.
 *
 * Exported for the offline test harness — this decides the premium every trade
 * is marked against, so it is tested rather than trusted.
 */
function attributeQuotes(resp, symbols, optSym) {
  const out = { optLtp: null };
  if (!resp || resp.s !== "ok" || !Array.isArray(resp.d)) return out;
  for (const row of resp.d) {
    const v = (row && row.v) || {};
    const ltp = v.lp || v.ltp;   // same idiom as every other quote reader in the repo
    if (typeof ltp !== "number" || !Number.isFinite(ltp) || !(ltp > 0)) continue;
    let sym = row && (row.n || row.symbol);
    if (!sym && resp.d.length === 1 && Array.isArray(symbols) && symbols.length === 1) sym = symbols[0];
    if (!sym) continue;
    if (optSym && sym === optSym) out.optLtp = ltp;
  }
  return out;
}

/** Another market: the held contract's bid/ask out of the poll's own response. */
function _noteOptionQuote(resp, optSym, ltp) {
  try {
    const rows = (resp && Array.isArray(resp.d)) ? resp.d : [];
    const row = rows.find(x => x && (x.n || x.symbol) === optSym) || (rows.length === 1 ? rows[0] : null);
    const v = (row && row.v) || {};
    state.optionQuote = { symbol: optSym, ltp, bid: Number(v.bid || v.bid_price || 0), ask: Number(v.ask || v.ask_price || 0), at: Date.now() };
  } catch (_) {}
}

function startPolling() {
  stopPolling();
  _pollStopped = false;
  const poll = async () => {
    if (_pollStopped) return;
    // The OPTION premium is the only thing polled. NIFTY spot — the instrument
    // every level is measured on — arrives on the shared tick feed, so there is
    // nothing to fetch for it and no second symbol to confuse the attribution.
    try {
      // Futures need no premium poll — the traded price IS the index level, so
      // mirror the spot in and every downstream reader stays correct unchanged.
      if (state.position && state.position.isFutures) {
        if (state.lastTickPrice > 0) {
          state.optionLtp = state.lastTickPrice;
          // Premium bars for the option chart (display only — no rule reads them).
          state.optionChart = optionChart.pushLtp(state.optionChart, state.position.symbol, state.lastTickPrice);
          state.optionLtpUpdatedAt = Date.now();
        }
      }
      const optSym = (state.position && !state.position.isFutures) ? state.position.symbol : null;
      if (optSym) {
        const symbols = [optSym];
        const r = await require("../services/marketData").getQuotes(symbols);
        const q = attributeQuotes(r, symbols, optSym);
        // Another market sells at the BID of a fresh quote — keep the held
        // contract's bid/ask from this same response. NIFTY reads only the LTP.
        if (!rt.home && q.optLtp != null) _noteOptionQuote(r, optSym, q.optLtp);
        if (q.optLtp != null) {
          state.optionLtp = q.optLtp;
          state.optionChart = optionChart.pushLtp(state.optionChart, optSym, q.optLtp);
          state.optionLtpUpdatedAt = Date.now();
          try { tickRecorder.recordOptionLtp(optSym, q.optLtp, OWNER); } catch (_) {}
        }
      }
    } catch (_) {}

    // Exits first (a profit-lock hit must not wait on a history round-trip),
    // then the bar-close work.
    try { if (state.position) _checkExits(state.lastTickPrice); } catch (e) { console.error(`🚨 ${TAG} exit-check error: ${e.message}`); }
    _maybeRefreshHistory().catch(e => console.error(`🚨 ${TAG} history refresh error: ${e.message}`));
    if (!state.position && state._pendingEntry) {
      _retryPendingEntry().catch(e => console.error(`🚨 ${TAG} entry-retry error: ${e.message}`));
    }

    if (!_pollStopped) _pollTimer = setTimeout(poll, _pollMs());
  };
  _pollTimer = setTimeout(poll, 250);
}

function stopPolling() {
  _pollStopped = true;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

/** Display-only forming spot bar, built from the quote poll. */
function _updateFormingBar(price) {
  const bucketSec = Math.floor(getBucketStart(Date.now(), _resMin()) / 1000);
  if (!state.formingBar || state.formingBar.time !== bucketSec) {
    state.formingBar = { time: bucketSec, open: price, high: price, low: price, close: price, volume: 0 };
    return;
  }
  state.formingBar.high  = Math.max(state.formingBar.high, price);
  state.formingBar.low   = Math.min(state.formingBar.low, price);
  state.formingBar.close = price;
}

// ── Spot history — the ONLY source of the closed bars decisions read ───────
/**
 * Fetch today's closed spot bars once per bar, a short lag after the bar
 * closes. Everything the engine reads comes from here, which is precisely why
 * Paper, Backtest and Replay agree: they all read the same endpoint.
 */
async function _maybeRefreshHistory() {
  if (!state.running || state._histInFlight) return;
  const resMin = _resMin();
  const bucketMs = getBucketStart(Date.now(), resMin);
  if (state._histBucket === bucketMs) return;
  if (Date.now() - bucketMs < _historyLagMs()) return;
  if (state._histNextTryMs && Date.now() < state._histNextTryMs) return;

  state._histInFlight = true;
  try {
    const bars = await _fetchSpotToday();
    if (Array.isArray(bars) && bars.length) {
      state._histBucket = bucketMs;
      state._histFailures = 0;
      state._histNextTryMs = null;
      _mergeBars(bars);
    } else if (getISTMinutes() < _cfg().sessionStartMin) {
      // BEFORE THE BELL there are no bars for today yet, so an empty answer is
      // the correct answer — not a failure. Counting it as one used to spend the
      // whole pre-open hour climbing the backoff ladder, so the first real bars
      // of the day landed on a 60s retry and arrived in a batch. Just wait.
      state._histNextTryMs = Date.now() + 30_000;
    } else {
      // A genuinely empty window during market hours. Real failures — an expired
      // token included — arrive as a throw and are handled in the catch below,
      // so reaching here means Fyers answered "ok"/"no_data" with nothing in it.
      _noteHistoryFailure(null);
    }
  } catch (e) {
    // A throw must count as a failure too. Without this branch a rejecting
    // fetch left _histFailures at 0, so the operator never saw the warning.
    _noteHistoryFailure(e && e.message);
  } finally {
    state._histInFlight = false;
  }
}

/**
 * Record a failed history fetch and back off. The poll runs every
 * HA_SCALP_POLL_MS (2s by default) and the bucket guard only advances on
 * SUCCESS, so without a backoff a dead token would turn one bar into ~90
 * history calls. Backoff grows 5s per failure to a 60s ceiling, and never
 * exceeds one bar — so at the 3-min default there is still at least one attempt
 * per bar, which is the soonest a retry could return anything new anyway.
 */
function _noteHistoryFailure(why) {
  state._histFailures++;
  const backoffMs = Math.min(_resMin() * 60_000, 5000 * Math.min(state._histFailures, 12));
  state._histNextTryMs = Date.now() + backoffMs;
  if (state._histFailures === 3 || state._histFailures % 20 === 0) {
    log(`⚠️ ${TAG} Spot history unavailable ${state._histFailures}× ${why ? `(${why}) ` : ""}Retrying in ${Math.round(backoffMs / 1000)}s.`);
  }
}

/** Today's spot bars at the strategy resolution. Uncached — today is live. */
async function _fetchSpotToday() {
  const { fetchCandles } = require("../services/marketData");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return fetchCandles(SPOT(), String(_resMin()), today, today);
}

/**
 * Enough history to establish the 50 MA and the Heikin Ashi chain, ending
 * today. Reaches back HA_SCALP_WARMUP_DAYS calendar days — the default 15 gives
 * roughly 10 trading sessions, ~250 fifteen-minute bars, comfortably more than
 * the ~51 the engine needs even after holidays.
 */
async function _fetchWarmupBars() {
  const { fetchCandles } = require("../services/marketData");
  const days = _warmupDays();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const from = new Date(Date.now() - days * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return fetchCandles(SPOT(), String(_resMin()), from, today);
}

/**
 * Rebuild the Heikin Ashi and MA series from state.candles.
 *
 * Done ONCE per bar-set change, then handed to both the engine and the chart —
 * so the candle the decision read is provably the candle the page draws. The HA
 * chain is recursive, so it is rebuilt whole rather than appended to: a merge
 * that corrected an earlier bar would otherwise leave every later HA candle
 * computed from the superseded value.
 */
function _recomputeSeries() {
  try {
    const cfg = _cfg();
    state.ha = haStrategy.toHeikinAshi(state.candles, { cfg });
    state.ma = haStrategy.computeMA(state.candles, { cfg });
    const lastHa = state.ha.length ? state.ha[state.ha.length - 1] : null;
    const lastMa = state.ma.length ? state.ma[state.ma.length - 1] : null;
    const lastRaw = state.candles.length ? state.candles[state.candles.length - 1] : null;
    state.lastHa = lastHa;
    state.lastMa = lastMa;
    state.lastTrend = (lastRaw && typeof lastMa === "number")
      ? (lastRaw.close > lastMa ? "UP" : lastRaw.close < lastMa ? "DOWN" : "FLAT")
      : null;
  } catch (e) {
    console.error(`🚨 ${TAG} series recompute error: ${e.message}`);
  }
}

/**
 * Merge freshly fetched bars into state.candles and fire onCandleClose for each
 * genuinely NEW closed bar. Fyers history includes today's STILL-FORMING bar, so
 * any bar whose close time has not passed is dropped — feeding a partial bar to
 * the engine would let it decide off half a candle and then change its mind.
 */
function _mergeBars(bars) {
  const resMin = _resMin();
  const nowBucketSec = Math.floor(getBucketStart(Date.now(), resMin) / 1000);
  const closed = bars
    .filter(b => b && typeof b.time === "number" && b.time < nowBucketSec)
    .sort((a, b) => a.time - b.time);
  if (!closed.length) return;

  const byTime = new Map();
  for (const c of state.candles) byTime.set(c.time, c);
  const fresh = [];
  for (const c of closed) {
    const known = byTime.get(c.time);
    byTime.set(c.time, c);
    if (!known) fresh.push(c);
  }
  state.candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time).slice(-400);
  _recomputeSeries();

  if (!fresh.length) return;
  const newest = fresh[fresh.length - 1];
  state.lastClosedBarTime = newest.time;

  // ENTRY is evaluated for the newest bar only. evaluateEntry always reads the
  // LAST element of state.candles, so replaying older bars would re-evaluate the
  // same series N times — normally harmless, but if history only starts
  // answering mid-session (a token restored at 13:00) `fresh` is the whole day
  // and this would be ~100 identical evaluations in one tick of the poll loop.
  try { onCandleClose(newest); }
  catch (e) { console.error(`🚨 ${TAG} onCandleClose error: ${e.message}`); }
}

// ── Trade simulation ─────────────────────────────────────────────────────────
async function simulateBuy(side, sig) {
  // One instrument: the NIFTY 50 INDEX. It picks the strike AND it is the
  // price every level of this strategy is measured on.
  const spotPrice = state.lastTickPrice;
  if (!side) return;
  // Global wait-after-any-exit cooldown (EXIT_REENTRY_COOLDOWN_CANDLES). Every
  // entry here is automatic (there is no manual entry route). Logged once per cooldown.
  if (state._reentryBlockUntil > Date.now()) {
    if (state._reentryBlockLogged !== state._reentryBlockUntil) {
      state._reentryBlockLogged = state._reentryBlockUntil;
      log(`⏸️ ${TAG} Wait-after-exit cooldown — no new entry until ~${new Date(state._reentryBlockUntil).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} (${side} rejected)`);
    }
    return;
  }
  const _sid = state._sessionId;
  if (typeof spotPrice !== "number" || !(spotPrice > 0)) {
    log(`⚠️ ${TAG} No ${rt.home ? "NIFTY" : SPOT_LABEL} spot price yet — entry deferred`);
    return;
  }
  const indexSpot = spotPrice;

  // NIFTY: the global futures switch, as always. Another market: its own kind.
  const _isFut = rt.home ? instrumentMode.isFutures() : rt.isFutures;

  let optInfo;
  try {
    optInfo = rt.home
      ? (_isFut
        ? await instrumentMode.resolveEntryInstrument(indexSpot, side, "HA_SCALP")
        : await instrumentConfig.validateAndGetOptionSymbol(indexSpot, side, "HA_SCALP"))
      : await _resolvePairEntry(indexSpot, side);
  } catch (e) {
    log(`❌ ${TAG} Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ ${TAG} No valid ${_isFut ? "futures contract" : "expiry"} — skip ${side} entry`);
    skipLogger.appendSkipLog(MODE, { gate: "expiry", reason: _isFut ? "no valid futures contract" : "no valid option expiry", side, spot: indexSpot });
    return;
  }

  let optionEntryLtp = null;
  let _entryQuote = null;   // another market: the quote its spread limit and ask fill read
  if (_isFut) {
    // Futures trade AT the index level — there is no premium to quote.
    optionEntryLtp = indexSpot;
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
      skipLogger.appendSkipLog(MODE, { gate: "option_ltp", reason: "no option LTP", symbol: optInfo.symbol, side, spot: indexSpot });
      return;
    }
    // Another market: its bid-ask spread limit (<PAIR>_MAX_SPREAD_PTS) on this
    // quote. A refusal is a failed fill, so the pending setup retries it until
    // the bar is superseded; the skip is logged once per bar.
    if (!rt.home && _entryQuote) {
      const _sp = tradeGuards.checkSpread(_entryQuote.bid, _entryQuote.ask, rt.maxSpreadPts());
      if (!_sp.ok) {
        const _bar = getBucketStart(Date.now(), _resMin());
        if (state._spreadSkipBar !== _bar) {
          state._spreadSkipBar = _bar;
          log(`⏭️ ${TAG} SKIP ${side} entry — spread too wide (${_sp.reason}, limit ${rt.maxSpreadPts()}pt)`);
          skipLogger.appendSkipLog(MODE, { gate: "spread", reason: _sp.reason, symbol: optInfo.symbol, side, spot: indexSpot, spread: _sp.spread, limit: rt.maxSpreadPts() });
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

  const qty = haLotQty();

  // ── Capital gate — HARD: the pool must fund this position or the entry is
  //    refused (error line + skip log + dashboard alert, see capitalPool.gate).
  //    Sits AFTER the last strategy abort path so a refusal is never logged for
  //    a signal that would have been dropped anyway.
  const _cap = capitalPool.gate(MODE, _capitalRequired(qty, optionEntryLtp), { side, symbol: optInfo.symbol, qty });
  if (!_cap.ok) {
    if (!_cap.muted) {
      log(`❌ ${TAG} Entry REFUSED — ${_cap.reason}`);
      skipLogger.appendSkipLog(MODE, { gate: "capital", reason: _cap.reason, spot: spotPrice, side, symbol: optInfo.symbol, qty, cost: _cap.cost, available: _cap.available });
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
    // "spot" for this engine means the SPOT price — that is the instrument
    // every level is measured on. The index is recorded alongside it.
    entrySpot:      spotPrice,
    entryPrice:     spotPrice,
    indexAtEntry:   indexSpot,
    spotSymbol:  SPOT(),
    optionEntryLtp,
    entryTime:      istNow(),
    entryTimeMs:    Date.now(),
    vixAtEntry:     vixFilter.getCachedVix(),   // observer-only — see VIX_LOG_ENABLED
    entryUnixSec:   Math.floor(Date.now() / 1000),
    entryBarTime:   Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    // Signal context (kept on the trade record for analytics / reports)
    signalSpot:     sig.entrySpot,
    signalBarTime:  sig.signalBarTime,
    trend:          sig.trend,
    ma:             sig.ma,
    maType:         sig.maType,
    haOpen:         sig.haOpen,
    haHigh:         sig.haHigh,
    haLow:          sig.haLow,
    haClose:        sig.haClose,
    bodyPct:        sig.bodyPct,
    upperWickPct:   sig.upperWickPct,
    lowerWickPct:   sig.lowerWickPct,
    signalRawHigh:  sig.rawHigh,
    signalRawLow:   sig.rawLow,
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
      trend: sig.trend, ma: sig.ma, maType: sig.maType,
      haOpen: sig.haOpen, haHigh: sig.haHigh, haLow: sig.haLow, haClose: sig.haClose,
      bodyPct: sig.bodyPct, upperWickPct: sig.upperWickPct, lowerWickPct: sig.lowerWickPct,
    },
    spot: spotPrice, optionLtp: _isFut ? null : optionEntryLtp,
    bid: _entryQuote ? _entryQuote.bid : null, ask: _entryQuote ? _entryQuote.ask : null,
    vix: pos.vixAtEntry,
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
  // Seed the premium series with the fill itself, so the chart opens at the
  // price actually paid rather than at whichever poll lands first.
  if (!_isFut && optionEntryLtp > 0) {
    state.optionChart = optionChart.pushLtp(state.optionChart, optInfo.symbol, optionEntryLtp);
  }
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;

  log(`🟢 ${TAG} ${_isFut ? (side === "CE" ? "LONG" : "SHORT") + " FUT" : "BUY_" + side} ${optInfo.symbol} qty=${qty} @ spot=${spotPrice} (index ${indexSpot})${_isFut ? "" : ` optLtp=₹${optionEntryLtp}`}`);
  if (_askFill) log(`📌 ${TAG} Entry filled at the ASK ₹${_askFill} (LTP ₹${_ltpAtEntry}, bid ₹${_entryQuote.bid}) — ${rt.fillAtQuoteKey}`);
  log(`   ├─ Trend  : ${pos.trend} — raw close ${sig.rawClose} is ${side === "CE" ? "ABOVE" : "BELOW"} the ${sig.cfg.maPeriod} ${String(pos.maType).toUpperCase()} at ${pos.ma}`);
  log(`   ├─ Candle : ${side === "CE" ? "BULLISH" : "BEARISH"} Heikin Ashi, NO ${side === "CE" ? "BOTTOM" : "TOP"} WICK (${side === "CE" ? pos.lowerWickPct : pos.upperWickPct}% of range) · body ${pos.bodyPct}% · HA ${pos.haOpen} → ${pos.haClose}`);
  log(`   └─ Exit   : global profit lock — no stop, trail or target`);

  notifyEntry({
    mode: NOTIFY_MODE,
    side, symbol: optInfo.symbol,
    spotAtEntry: spotPrice, optionEntryLtp,
    qty, stopLoss: null, target: null,
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
      spotEntry: spotPrice, optionEntry: optionEntryLtp,
      stopLoss: null, target: null,
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
    qty, broker: rt.home ? "zerodha" : pair.broker,
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
    indexAtEntry:   pos.indexAtEntry,
    spotSymbol:  pos.spotSymbol,
    optionEntryLtp: pos.isFutures ? null : pos.optionEntryLtp,
    optionExitLtp:  pos.isFutures ? null : exitOptLtp,
    bestOptionLtp:  pos.isFutures ? null : (pos.peakPremium || null),
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    entryBarTime:   pos.entryBarTime,
    exitBarTime:    Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    pnl,
    pnlMode:        rt.home
      ? `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp} (levels measured on NIFTY 50 spot)`
      : (pos.isFutures ? _pnlRes.pnlMode : `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp} (levels measured on ${SPOT_LABEL} spot)`),
    exitReason:     reason,
    entryReason:    pos.entryReason,
    stopLoss:       null,
    target:         null,
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    optionType:     pos.side,
    optionEntrySymbol: pos.symbol,
    signalStrength: pos.signalStrength,
    // HA_SCALP signal context
    trend:          pos.trend,
    ma:             pos.ma,
    maType:         pos.maType,
    haOpen:         pos.haOpen,
    haHigh:         pos.haHigh,
    haLow:          pos.haLow,
    haClose:        pos.haClose,
    bodyPct:        pos.bodyPct,
    upperWickPct:   pos.upperWickPct,
    lowerWickPct:   pos.lowerWickPct,
    signalRawHigh:  pos.signalRawHigh,
    signalRawLow:   pos.signalRawLow,
    signalBarTime:  pos.signalBarTime,
    mfeSpotPts:     pos.mfeSpotPts || 0,
    mfePnl:         pos.mfePnl || 0,
    maeSpotPts:     pos.maeSpotPts || 0,
    maePnl:         pos.maePnl || 0,
    secsToMFE:      pos.secsToMFE || 0,
    secsToMAE:      pos.secsToMAE || 0,
    ...pathFields(pos),
    vixAtEntry:     pos.vixAtEntry ?? null,
    vixAtExit:      vixFilter.getCachedVix(),
    durationMs:     Date.now() - pos.entryTimeMs,
    charges,
    isSpot:      false,
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
      spotSymbol:      pos.spotSymbol,
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
    ...(rt.home ? {} : { isFutures: !!pos.isFutures, instrument: rt.instrumentName() }),
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
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;
  // Global wait-after-any-exit cooldown — no entry on either side for N candles.
  state._reentryBlockUntil = tradeGuards.reentryCooldownUntil(Date.now(), _resMin());
}

function _closeDay(reason) {
  state.dayClosed = true;
  state.dayClosedReason = reason;
  log(`⏸️ ${TAG} ${reason} — no more entries today`);
  skipLogger.appendSkipLog(MODE, { gate: "day_closed", reason, sessionPnl: state.sessionPnl, spot: state.lastTickPrice });
}

// ── Exits ────────────────────────────────────────────────────────────────────
// The global profit lock is the ONLY automatic exit, tested on every poll and
// tick. This also keeps the peak premium and the MFE/MAE bookkeeping current.
function _checkExits(spotPrice) {
  if (!state.position) return;
  if (typeof spotPrice !== "number" || !Number.isFinite(spotPrice) || spotPrice <= 0) return;
  const pos = state.position;
  const optLtp = state.optionLtp || pos.optionEntryLtp;

  const _peakBefore = pos.peakPremium, _mfeBefore = pos.mfeSpotPts;
  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;
  const favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  // NIFTY: premium × qty exactly as always. Another market's future is
  // direction-aware (a PE is a SHORT).
  const curPnl = rt.home ? (optLtp - pos.optionEntryLtp) * pos.qty : _unrealisedPnl({
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
  if (pos.isFutures) {
    const _fsMsg = tradeGuards.checkFuturesStop(pos.side, pos.entrySpot, spotPrice, pos.mfeSpotPts);
    if (_fsMsg) {
      log(`🔒 ${TAG} ${_fsMsg}`);
      simulateSell(_fsMsg);
    }
  }
}

// ── Entry evaluation (on spot candle close — CLOSED bars only) ────────────
const ENTRY_RETRY_MS = 5000;

/**
 * A short machine-readable tag for WHY a setup was passed over, so the skip log
 * can be grouped and counted. The prose reason from the engine is logged too —
 * this is the column you filter on, not the sentence you read.
 */
function _skipGate(sig) {
  const r = String(sig.skipReason || sig.reason || "");
  if (/DOJI/.test(r))                 return "doji_no_entry";
  if (/against the trend/.test(r))    return "wrong_colour_for_trend";
  if (/wick of/.test(r))              return "has_wick";
  if (/body is only/.test(r))         return "body_too_small";
  if (/exactly on the/.test(r))       return "price_on_ma";
  if (/entry window|no new entries/.test(r)) return "outside_window";
  return "no_setup";
}

async function evaluateEntry() {
  // Every guard here is synchronous and runs before the first await, so
  // concurrent polls can never open two positions.
  if (state.position || state._entryInFlight || state.dayClosed) return;
  // Another market: <PAIR>_EXPIRY_DAY_ONLY on a day that is not its expiry.
  if (!rt.home && state._expiryDayBlocked) return;
  if (state._lastEntryAttemptMs && Date.now() - state._lastEntryAttemptMs < ENTRY_RETRY_MS) return;

  // ── Risk gates ──────────────────────────────────────────────────────────
  {
    const pf = require("../utils/portfolioRisk").checkPortfolioCap();
    if (pf.blocked) { _closeDay(pf.reason); return; }
  }

  // ── The signal ──────────────────────────────────────────────────────────
  // The HA and MA series are already computed for this bar set (see _mergeBars)
  // and are handed to the engine so the chart and the decision cannot disagree.
  const sig = haStrategy.getSignal(state.candles, {
    silent: true, ha: state.ha, ma: state.ma,
  });
  state.lastSignal = sig;

  if (sig.signal === "NONE" || !sig.side) {
    // Log every near-miss that had a real trend and a real candle to judge —
    // the whole point of this strategy's log is being able to see WHY a
    // good-looking candle was passed over. Warm-up and plain window rejections
    // are skipped: at 25 bars a day they would bury the file.
    if (!sig.warmup && sig.trend) {
      skipLogger.appendSkipLog(MODE, {
        gate: _skipGate(sig),
        reason: sig.skipReason || sig.reason,
        spot: state.lastTickPrice,
        trend: sig.trend, ma: sig.ma, maType: sig.maType,
        haOpen: sig.haOpen, haHigh: sig.haHigh, haLow: sig.haLow, haClose: sig.haClose,
        bodyPct: sig.bodyPct, upperWickPct: sig.upperWickPct, lowerWickPct: sig.lowerWickPct,
        rawClose: sig.rawClose, rawHigh: sig.rawHigh, rawLow: sig.rawLow,
        barTime: sig.signalBarTime,
      });
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
    // A wait-after-exit rejection is a decision, not a failed fill — never
    // retried, or the setup would fill mid-bar the moment the cooldown lapses.
    if (state.position || state._reentryBlockUntil > Date.now()) {
      state._pendingEntry = null;
    } else {
      // A failed FILL is an infrastructure problem, not a decision. Hold the
      // signal so the next polls can retry it — see _retryPendingEntry. The
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
 * stale setup can never fill minutes later off a candle the market has moved past.
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

// ── Spot candle close handler ─────────────────────────────────────────────
function onCandleClose(bar) {
  // A new bar supersedes any setup still waiting on a failed fill — the market
  // has moved on, and this bar's own evaluation is the current truth.
  state._pendingEntry = null;
  if (!bar || typeof bar.time !== "number") return;

  if (state.position) return;

  const cfg = _cfg();
  const closeMins = haStrategy._utcSecToIstMins(bar.time) + cfg.resolutionMins;
  if (closeMins > cfg.entryEndMin) return;
  evaluateEntry().catch(e => console.error(`🚨 ${TAG} entry-eval error: ${e.message}`));
}

// ── onTick — the NIFTY 50 INDEX feed. ────────────────────────────────────────
// It drives NO ENTRY decision: every entry rule reads CLOSED 15-minute bars, so
// the tick can never pull an entry forward. It also re-tests the profit lock
// and keeps the MFE/MAE bookkeeping current.
function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (!price || price <= 0) return;

  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  // The forming bar is DISPLAY ONLY. No rule reads it: every decision waits for
  // the bar to close and to come back from the history endpoint, which is what
  // keeps Paper, Backtest and Replay in agreement.
  _updateFormingBar(price);

  // _checkExits is idempotent and returns immediately when flat.
  try { if (state.position) _checkExits(price); }
  catch (e) { console.error(`🚨 ${TAG} tick exit-check error: ${e.message}`); }
}

// ── Preload spot history ──────────────────────────────────────────────────
// Unlike a session-only strategy, HA_SCALP needs HISTORY: the 50 MA needs 50
// closed 15-minute bars and the Heikin Ashi chain needs its own warm-up on top.
// At 25 bars per session that is several days, so the preload reaches back
// HA_SCALP_WARMUP_DAYS calendar days rather than asking only for today.
async function preloadHistory() {
  try {
    const bars = await _fetchWarmupBars();
    if (Array.isArray(bars) && bars.length) {
      const resMin = _resMin();
      const nowBucketSec = Math.floor(getBucketStart(Date.now(), resMin) / 1000);
      state.candles = bars
        .filter(b => b && typeof b.time === "number" && b.time < nowBucketSec)
        .sort((a, b) => a.time - b.time)
        .slice(-400);
      state._histBucket = getBucketStart(Date.now(), resMin);
      state.lastClosedBarTime = state.candles.length ? state.candles[state.candles.length - 1].time : null;
      _recomputeSeries();

      const cfg = _cfg();
      const need = Math.max(cfg.maPeriod, cfg.haWarmupBars) + 1;
      log(`📊 ${TAG} Preloaded ${state.candles.length} closed ${resMin}-min ${SPOT()} candles (need ${need} before the first decision)`);
      if (state.candles.length < need) {
        log(`⏳ ${TAG} Still warming up — ${state.candles.length}/${need} candles. No entry can be taken until the ${cfg.maPeriod} ${cfg.maType.toUpperCase()} and the Heikin Ashi chain are both established.`);
      } else {
        log(`📈 ${TAG} Trend now ${state.lastTrend} — raw close ${state.candles[state.candles.length - 1].close} vs ${cfg.maPeriod} ${cfg.maType.toUpperCase()} ${state.lastMa}. ${state.lastTrend === "UP" ? "CE entries only." : state.lastTrend === "DOWN" ? "PE entries only." : "No side until price leaves the MA."}`);
      }
    } else {
      log(`📊 ${TAG} No spot history for ${SPOT()} — Fyers returned an empty series. If this persists the token is usually expired: every historical fetch then returns 0 candles.`);
    }
  } catch (e) {
    log(`⚠️ ${TAG} Spot preload failed: ${e.message}`);
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
    if (String(process.env.HA_SCALP_MODE_ENABLED || "true").toLowerCase() !== "true") {
      return res.status(403).send(_errorPage("HA Scalp Disabled", "Enable HA Scalp Mode in Settings first", "/settings", "Go to Settings"));
    }
    if (String(process.env.HA_SCALP_PAPER_ENABLED || "true").toLowerCase() !== "true") {
      return res.status(403).send(_errorPage("HA Scalp Paper Disabled", "Enable HA Scalp Paper Trading in Settings first", "/settings", "Go to Settings"));
    }
  } else {
    // Every non-home pair ships OFF: its own switch, then the strategy's paper
    // switch (its own value, else NIFTY's — config/pairs.js).
    if (!rt.enabled()) {
      return res.status(403).send(_errorPage(`${TITLE} Disabled`, `Turn on ${pair.enabledKey} in Settings → ${rt.market().label} first`, `/settings#pair-${pair.slug}`, "Go to Settings"));
    }
    if (!rt.paperEnabled()) {
      return res.status(403).send(_errorPage(`${TITLE} Paper Disabled`, `${pairs.pairKey(pair, rt.strategy.paperEnabled.key)} (or HA_SCALP_PAPER_ENABLED) is off`, `/settings#pair-${pair.slug}`, "Go to Settings"));
    }
  }

  const check = rt.socketSlot.canStart();
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, `${ROUTE}/status`, "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  // This market's exchange calendar (NSE / BSE holidays; MCX weekends).
  const holiday = rt.home ? await isTradingAllowed() : await rt.isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, `${ROUTE}/status`, "← Back"));

  if (getISTMinutes() >= _cfg().entryEndMin) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${_envStr("ENTRY_END", "15:00")} IST — ${TITLE} takes no new entries after this`, `${ROUTE}/status`, "← Back"));
  }

  // Another market's spot the bars are fetched for (MCX has no index: the
  // series' future, read from the Fyers MCX symbol master).
  if (!rt.home) {
    let sym = rt.spotSymbol();
    if (rt.isMcx) {
      try { sym = await rt.resolveSpotSymbol(); }
      catch (e) { return res.status(400).send(_errorPage("Cannot Start", `${TITLE}: no ${rt.market().label} future resolved — ${e.message}`, `${ROUTE}/status`, "← Back")); }
    }
    if (!sym) return res.status(400).send(_errorPage("Cannot Start", `${TITLE}: no spot symbol for ${rt.market().label}`, `${ROUTE}/status`, "← Back"));
    _spotSym = sym;
  }

  state = _freshState();
  state.running = true;
  state._unsaved = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `${rt.replayMode}:${Date.now()}`;

  rt.socketSlot.set();

  const cfg = _cfg();
  log(`🟢 ${TAG} Session started — ${haStrategy.NAME}`);
  log(`⚙️ ${TAG} Chart    : ${SPOT()} · HEIKIN ASHI ${cfg.resolutionMins}-min${cfg.haContinuous ? " (chain continuous across days, matching TradingView)" : " (chain reseeds each day)"}`);
  log(`⚙️ ${TAG} Trend    : ${cfg.maPeriod} ${cfg.maType.toUpperCase()} of RAW closes — above it CE only, below it PE only. Never against it.`);
  log(`⚙️ ${TAG} Entry    : ${cfg.maxWickPct === 0 ? "wick-free" : `≤${cfg.maxWickPct}%-wick`} HA candle in the trend's direction (bullish + no bottom wick = CE, bearish + no top wick = PE), body ≥${cfg.minBodyPts}pt`);
  log(`⚙️ ${TAG} Exit     : global profit lock only — no stop, trail, target or candle exit`);
  log(`⚙️ ${TAG} Session  : entries ${_envStr("ENTRY_START", "09:30")}–${_envStr("ENTRY_END", "15:00")} · qty ${haLotQty()}`);
  // Another market's trade days: <PAIR>_EXPIRY_DAY_ONLY against THAT market's
  // expiry calendar. NIFTY has no expiry-day rule here.
  if (!rt.home) {
    log(`🌐 ${TAG} ${rt.market().label} · ${SPOT()} · ${rt.instrumentName()} · lot ${haLotQty()}`);
    if (rt.expiryDayOnly()) {
      const isExpiry = rt.isExpiryDay();
      if (!isExpiry) state._expiryDayBlocked = true;
      log(`📅 ${TAG} Expiry-only mode (${rt.market().label}): ${isExpiry ? "✅ Today is expiry — trading allowed" : "❌ Not this market's expiry day — entries blocked"}`);
    }
  }

  await preloadHistory();
  startPolling();

  try {
    tickRecorder.recordSessionStart({
      mode: OWNER,
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: state.candles.map(c => ({ ...c })),
      meta: {
        instrument: rt.home ? instrumentConfig.INSTRUMENT : rt.instrumentName(),
        resolutionMin: cfg.resolutionMins,
        spotSymbol: SPOT(),
        decisionSymbol: SPOT(),
        sessionStartISO: state.sessionStart,
        recordsOptionLtps: true,
      },
    });
  } catch (_) {}

  if (rt.home) {
    if (socketManager.isRunning()) {
      socketManager.addCallback(CALLBACK_ID, onTick, log);
      log(`📡 ${TAG} Piggybacking on existing WebSocket (NIFTY 50 index — strike + heartbeat only)`);
    } else {
        socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
        socketManager.addCallback(CALLBACK_ID, onTick, log);
        log(`📡 ${TAG} Started WebSocket (NIFTY 50 index — strike + heartbeat only)`);
    }
  } else {
    // Bound to this market's spot: the shared socket adds it beside NIFTY.
    const _wasRunning = socketManager.isRunning();
    if (!_wasRunning) socketManager.start(SPOT(), () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log, SPOT());
    log(`📡 ${TAG} ${_wasRunning ? "Piggybacking on existing WebSocket" : "Started WebSocket"} — ${SPOT()}`);
  }

  scheduleAutoStop();

  notifyStarted({
    mode: NOTIFY_MODE,
    text: [
      `📄 ${rt.home ? "HA SCALP" : rt.title} PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${haStrategy.NAME}`,
      `Chart     : ${SPOT_LABEL} · Heikin Ashi ${cfg.resolutionMins}-min`,
      `Trend     : ${cfg.maPeriod} ${cfg.maType.toUpperCase()} — CE only above it, PE only below it`,
      `Setup     : ${cfg.maxWickPct === 0 ? "wick-free" : `≤${cfg.maxWickPct}%-wick`} HA strength candle in that direction, body ≥${cfg.minBodyPts}pt`,
      `Exit      : global profit lock`,
    ].filter(Boolean).join("\n"),
  });

  res.redirect(`${ROUTE}/status`);
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped");
  state.running = false;
  stopPolling();

  try { tickRecorder.recordSessionStop({ mode: OWNER, sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  rt.socketSlot.clear();   // clear OWN mode first (else the socket never stops → leak)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: haStrategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      data.capital  = parseFloat((parseFloat(process.env[CAP_ENV] || "100000") + data.totalPnl).toFixed(2));
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

// ── /status/chart-data — Heikin Ashi candles + MA + raw candles ─────────────
router.get("/status/chart-data", (req, res) => {
  try {
    const cfg = _cfg();
    // The chart draws the HEIKIN ASHI candles, because those are the candles
    // every rule reads. The raw series is sent alongside so the page can show
    // the traded prices — an HA low is not a traded price.
    const haCandles = [];
    const rawCandles = [];
    const maLine = [];
    for (let i = 0; i < state.candles.length; i++) {
      const raw = state.candles[i];
      const h = state.ha[i];
      const m = state.ma[i];
      if (raw) rawCandles.push({ time: raw.time, open: raw.open, high: raw.high, low: raw.low, close: raw.close });
      if (h)   haCandles.push({ time: h.time, open: h.open, high: h.high, low: h.low, close: h.close });
      if (typeof m === "number") maLine.push({ time: raw.time, value: m });
    }

    const markers = [];
    for (const t of state.sessionTrades) {
      if (t.entryBarTime) markers.push({ time: t.entryBarTime, position: t.side === "CE" ? "belowBar" : "aboveBar", color: t.side === "CE" ? "#10b981" : "#ef4444", shape: t.side === "CE" ? "arrowUp" : "arrowDown", text: `${t.side} ${t.entryPrice}` });
      if (t.exitBarTime)  markers.push({ time: t.exitBarTime,  position: t.side === "CE" ? "aboveBar" : "belowBar", color: (t.pnl || 0) >= 0 ? "#10b981" : "#ef4444", shape: "circle", text: `${(t.pnl || 0) >= 0 ? "+" : ""}${Math.round(t.pnl || 0)}` });
    }

    const pos = state.position;
    res.json({
      candles: haCandles, rawCandles, maLine, markers,
      optionChart: optionChart.buildPayload({ store: state.optionChart, position: state.position, trades: state.sessionTrades }),
      entryPrice: pos ? pos.entrySpot : null,
      ma:         state.lastMa,
      maPeriod:   cfg.maPeriod,
      maType:     cfg.maType,
      trend:      state.lastTrend,
      spotSymbol: SPOT(),
      resMin:     cfg.resolutionMins,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const tickAge = state.lastTickTime ? Math.round((Date.now() - state.lastTickTime) / 1000) : null;
  const data = loadData();
  const cfg = _cfg();

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = _unrealisedPnl({
      side: pos.side, entrySpot: pos.entrySpot, currentSpot: state.lastTickPrice,
      entryPremium: pos.optionEntryLtp, currentPremium: state.optionLtp, qty: pos.qty || haLotQty(),
    });
  }

  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) }); }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const bestTrade = state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null;
  const worstTrade = state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null;

  const s = state.lastSignal;
  res.json({
    running: state.running, sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-100),
    tickCount: state.tickCount, lastTickPrice: state.lastTickPrice,
    candles: state.candles.length, currentBar: state.formingBar, sessionStart: state.sessionStart,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge,
    wins, losses, winRate, bestTrade, worstTrade, cumPnl, livePnl,
    weeklyPnl: weeklyPnl(),
    // HA_SCALP context
    spotSymbol: SPOT(), tickAgeSec: tickAge,
    spotCandles: state.candles.length,
    warmupNeeded: Math.max(cfg.maPeriod, cfg.haWarmupBars) + 1,
    ma: state.lastMa, maPeriod: cfg.maPeriod, maType: cfg.maType,
    trend: state.lastTrend,
    allowedSide: state.lastTrend === "UP" ? "CE" : state.lastTrend === "DOWN" ? "PE" : null,
    lastHa: state.lastHa ? {
      time: state.lastHa.time, open: state.lastHa.open, high: state.lastHa.high,
      low: state.lastHa.low, close: state.lastHa.close,
      bullish: state.lastHa.bullish, bearish: state.lastHa.bearish,
      body: state.lastHa.body, range: state.lastHa.range,
      upperWick: state.lastHa.upperWick, lowerWick: state.lastHa.lowerWick,
    } : null,
    lastBodyPct:      s ? s.bodyPct : null,
    lastUpperWickPct: s ? s.upperWickPct : null,
    lastLowerWickPct: s ? s.lowerWickPct : null,
    dayClosed: state.dayClosed, dayClosedReason: state.dayClosedReason,
    lastSkipReason: s && s.signal === "NONE" ? (s.skipReason || s.reason) : null,
    cfg: {
      resMin: cfg.resolutionMins, maPeriod: cfg.maPeriod, maType: cfg.maType,
      maxWickPct: cfg.maxWickPct, minBodyPts: cfg.minBodyPts,
      dojiBodyPct: cfg.dojiBodyPct,
      haContinuous: cfg.haContinuous, haWarmupBars: cfg.haWarmupBars,
      entryStart: _envStr("ENTRY_START", "09:30"), entryEnd: _envStr("ENTRY_END", "15:00"),
    },
    position: pos ? {
      side: pos.side, isFutures: !!pos.isFutures, symbol: pos.symbol, entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      trend: pos.trend, ma: pos.ma, bodyPct: pos.bodyPct,
      upperWickPct: pos.upperWickPct, lowerWickPct: pos.lowerWickPct,
      optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry,
      peakPremium: pos.peakPremium, entryTime: pos.entryTime, signalStrength: pos.signalStrength,
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

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const startCap = parseFloat(process.env[CAP_ENV] || "100000");
  const maLabel = `${cfg.maPeriod} ${cfg.maType.toUpperCase()}`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>${TITLE} — Paper</title>${faviconLink()}
<style>${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.ha-card{background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;margin-bottom:18px;}
.ha-row{display:flex;gap:20px;flex-wrap:wrap;font-size:0.78rem;color:#e2e8f0;margin-top:8px;}
.ha-row .k{color:var(--muted-1,#8ba1c2);margin-right:5px;}
.ha-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.7rem;font-weight:600;letter-spacing:0.03em;}
.ha-up{background:rgba(16,185,129,0.15);color:#10b981;}
.ha-down{background:rgba(239,68,68,0.15);color:#ef4444;}
.ha-flat{background:rgba(148,163,184,0.15);color:#94a3b8;}
.brk{font-size:0.72rem;color:#f59e0b;margin-top:8px;}
.chart-box{background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;}
.rule-list{margin:8px 0 0;padding-left:18px;color:var(--muted-1,#8ba1c2);font-size:0.73rem;line-height:1.7;}
.rule-list b{color:#cbd5e1;font-weight:600;}
/* Mobile — iPhone 17 Pro Max portrait is ~440px. No horizontal scroll anywhere. */
@media (max-width: 640px) {
  .ha-row{gap:10px 14px;font-size:0.74rem;}
  .ha-card{padding:12px;border-radius:9px;}
  .chart-box{border-radius:9px;}
  .rule-list{font-size:0.71rem;padding-left:16px;}
}
</style>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
</head><body>
${buildSidebar(rt.sidebarKey, liveActive)}
<div class="main-content">
${bbRsiTopBar({
  title: `🕯 ${TITLE} — Paper`,
  metaLine: `${SPOT_LABEL} · Heikin Ashi ${cfg.resolutionMins}m · ${maLabel} decides the side · no-wick strength candle enters · exit = global profit lock`,
  running: state.running,
  primaryAction: { href: `${ROUTE}/start`, label: "▶ Start", color: "#0369a1" },
  stopAction:    { href: `${ROUTE}/stop`,  label: "■ Stop" },
  historyHref: `${ROUTE}/history`,
})}

${bbRsiCapitalStrip({ starting: startCap, current: startCap + (data.totalPnl || 0), allTime: data.totalPnl || 0 })}

<div class="ha-card">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Right now — what the engine sees</div>
    <div style="font-size:0.8rem;color:#94a3b8;" id="spot-sym">${SPOT_LABEL}</div>
  </div>
  <div class="ha-row" id="ha-row"><div>Waiting for the first closed 15-minute candles…</div></div>
  <div id="ha-skip" style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-top:8px;"></div>
  ${state.dayClosed ? `<div class="brk">⏸️ ${state.dayClosedReason}</div>` : ""}
  <ul class="rule-list">
    <li><b>Above the ${maLabel} → CE only.</b> Below it → PE only. Never against it.</li>
    <li><b>Enter</b> on a ${cfg.maxWickPct === 0 ? "wick-free" : `≤${cfg.maxWickPct}%-wick`} Heikin Ashi candle in that direction — bullish with no bottom wick for a CE, bearish with no top wick for a PE. Body must be ≥ ${cfg.minBodyPts}pt.</li>
    <li><b>No entry</b> on a doji (body ≤ ${cfg.dojiBodyPct}% of range).</li>
    <li><b>Exit</b> only through the global profit lock (or a manual exit / session stop). There is no stop, trail, target or candle exit.</li>
  </ul>
</div>

${bbRsiStatGrid([
  { label: "Session P&L", value: inr(state.sessionPnl), color: state.sessionPnl >= 0 ? "#10b981" : "#ef4444" },
  { label: "Trades", value: `${state.tradesTaken}` },
  { label: "W / L", value: `${wins} / ${losses}` },
  { label: "Trend", value: state.lastTrend || "—" },
  { label: maLabel, value: state.lastMa != null ? String(state.lastMa) : "—" },
  { label: "Spot", value: state.lastTickPrice != null ? String(state.lastTickPrice) : "—" },
])}

${bbRsiCurrentBar({ bar: state.formingBar, resMin: cfg.resolutionMins })}

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">${SPOT_LABEL} — HEIKIN ASHI ${cfg.resolutionMins}m (the decision chart) + ${maLabel}</div>
  <div class="chart-box" style="height:420px;">
    <div id="chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;">
      <span style="color:#3b82f6;">── ${maLabel} (the side gate)</span>
    </div>
  </div>
</div>

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">${SPOT_LABEL} — RAW ${cfg.resolutionMins}m candles (the traded prices — a Heikin Ashi price never traded)</div>
  <div class="chart-box" style="height:240px;"><div id="rawchart" style="width:100%;height:100%;"></div></div>
</div>

${optionChart.optionChartHtml('ha-opt-chart')}

<div id="pos-card" style="margin-bottom:18px;">${_positionCardHtml(pos, state.optionLtp)}</div>

${bbRsiActivityLog({ logsJSON: JSON.stringify(state.log.slice(-200)) })}
</div>
<script>
${modalJS()}
async function haRefresh() {
  try {
    const r = await fetch('${ROUTE}/status/data', { cache: 'no-store' });
    const d = await r.json();
    var row = document.getElementById('ha-row');
    if (row) {
      var cells = [];
      var tcls = d.trend === 'UP' ? 'ha-up' : d.trend === 'DOWN' ? 'ha-down' : 'ha-flat';
      cells.push('<div><span class="k">Trend</span><span class="ha-pill ' + tcls + '">' + (d.trend || '—') + '</span></div>');
      cells.push('<div><span class="k">Allowed side</span>' + (d.allowedSide || 'none') + '</div>');
      cells.push('<div><span class="k">' + (d.maPeriod || '') + ' ' + String(d.maType || '').toUpperCase() + '</span>' + (d.ma != null ? d.ma : '—') + '</div>');
      var h = d.lastHa;
      if (h) {
        cells.push('<div><span class="k">Last HA candle</span>' + (h.bullish ? 'bullish' : h.bearish ? 'bearish' : 'flat') + ' · body ' + (d.lastBodyPct != null ? d.lastBodyPct + '%' : '—') + '</div>');
        cells.push('<div><span class="k">Wicks</span>top ' + (d.lastUpperWickPct != null ? d.lastUpperWickPct + '%' : '—') + ' · bottom ' + (d.lastLowerWickPct != null ? d.lastLowerWickPct + '%' : '—') + '</div>');
      }
      cells.push('<div><span class="k">Candles</span>' + (d.spotCandles || 0) + (d.warmupNeeded && d.spotCandles < d.warmupNeeded ? ' / ' + d.warmupNeeded + ' (warming up)' : '') + '</div>');
      row.innerHTML = cells.join('');
    }
    var sk = document.getElementById('ha-skip');
    if (sk) sk.textContent = d.lastSkipReason || '';
    var fs = document.getElementById('spot-sym');
    if (fs) fs.textContent = ${JSON.stringify(SPOT_LABEL)} + (d.lastTickPrice != null ? '  ·  ' + d.lastTickPrice : '');
  } catch (e) {}
}
haRefresh();
setInterval(haRefresh, 4000);
</script>
<script>
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var container = document.getElementById('chart');
  var rawc = document.getElementById('rawchart');
  if (!container) return;
  function mk(el) {
    return LightweightCharts.createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout:{ background:{type:'solid',color:'#0a0f1c'}, textColor:'#8ba1c2', fontSize:11, fontFamily:"'IBM Plex Mono', monospace" },
      grid:{ vertLines:{color:'#111827'}, horzLines:{color:'#111827'} },
      crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale:{ borderColor:'#1a2236' },
      timeScale:{ borderColor:'#1a2236', timeVisible:true, secondsVisible:false,
        tickMarkFormatter:function(t){ var d=new Date(t*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); } },
    });
  }
  var chart = mk(container);
  var cs = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var mas = chart.addLineSeries({ color:'#3b82f6', lineWidth:2, priceLineVisible:false, lastValueVisible:true });
  var rchart = rawc ? mk(rawc) : null;
  var rcs = rchart ? rchart.addCandlestickSeries({ upColor:'#334155', downColor:'#475569', borderUpColor:'#475569', borderDownColor:'#475569', wickUpColor:'#475569', wickDownColor:'#475569' }) : null;
  var lines = [], _zoomed = false;
  function addLine(price, color, title, style) {
    if (price == null || !isFinite(price)) return;
    lines.push(cs.createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title }));
  }
  async function fetchChart(){
    try {
      var r = await fetch('${ROUTE}/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        if (d.maLine && d.maLine.length) mas.setData(d.maLine);
        if (!_zoomed) { try {
          var lastT=d.candles[d.candles.length-1].time;
          var firstT=d.candles[Math.max(0, d.candles.length-80)].time;
          chart.timeScale().setVisibleRange({ from:firstT, to:lastT }); _zoomed=true;
        } catch(_){} }
      }
      if (rcs && d.rawCandles && d.rawCandles.length) rcs.setData(d.rawCandles);
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      lines.forEach(function(l){ try { cs.removePriceLine(l); } catch(_){} });
      lines = [];
      addLine(d.entryPrice, '#94a3b8', 'Entry', LightweightCharts.LineStyle.Dotted);
    } catch(e) {}
  }
  fetchChart();
  setInterval(fetchChart, 4000);
  window.addEventListener('resize', function(){
    chart.applyOptions({ width: container.clientWidth });
    if (rchart && rawc) rchart.applyOptions({ width: rawc.clientWidth });
  });
})();
</script>
${optionChart.optionChartScript({ dataUrl: '${ROUTE}/status/chart-data', id: 'ha-opt-chart' })}
</body></html>`;
  res.send(html);
});

function _positionCardHtml(pos, optLtp) {
  if (!pos) {
    return `<div style="background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;color:var(--muted-1,#8ba1c2);font-size:0.78rem;">No open position.</div>`;
  }
  // Another market's future is direction-aware (a PE is a SHORT); NIFTY as always.
  const live = optLtp == null ? "—" : (rt.home
    ? ((optLtp - pos.optionEntryLtp) * pos.qty).toFixed(0)
    : _unrealisedPnl({ side: pos.side, entrySpot: pos.entrySpot, currentSpot: state.lastTickPrice || pos.entrySpot,
        entryPremium: pos.optionEntryLtp, currentPremium: optLtp, qty: pos.qty }).toFixed(0));
  const wickLabel = pos.side === "CE" ? "bottom" : "top";
  const wickPct = pos.side === "CE" ? pos.lowerWickPct : pos.upperWickPct;
  return `<div style="background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:8px;">Open position</div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:0.8rem;color:#e2e8f0;">
    <div><span style="color:var(--muted-1,#8ba1c2);">Side</span> ${pos.side}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Symbol</span> ${pos.symbol}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Entry (spot)</span> ${pos.entrySpot}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Trend</span> ${pos.trend || "—"} vs MA ${pos.ma != null ? pos.ma : "—"}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Signal candle</span> body ${pos.bodyPct != null ? pos.bodyPct + "%" : "—"}, ${wickLabel} wick ${wickPct != null ? wickPct + "%" : "—"}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Live P&L</span> ₹${live}</div>
  </div>
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);margin-top:8px;">Exit: global profit lock. No stop, trail or target.</div>
</div>`;
}

// ── History + daily-file viewers + restore + reset ────────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = false;
  const startCap = parseFloat(process.env[CAP_ENV] || "100000");
  res.send(renderHistoryPage({
    routePrefix: ROUTE,
    sidebarKey: rt.historySidebarKey,
    pageTitle: `🩹 ${TITLE} Paper Trade History`,
    pageDocTitle: `${TITLE} Paper — History`,
    modalLabel: `${TITLE} Paper`,
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap,
    emptyLabel: `Start ${TITLE} paper trading to record your first session.`,
  }));
});

const _HA_SCALP_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  if (!_HA_SCALP_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `${MODE}_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_HA_SCALP_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `${MODE}_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_HA_SCALP_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_HA_SCALP_DATE_RE.test(date)) return res.status(400).send("bad date");
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
  data.capital  = parseFloat((parseFloat(process.env[CAP_ENV] || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, message: "Session deleted successfully." });
});

router.post("/restore-session/:date", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: `Stop ${TITLE} paper trading before restoring.` });
  const date = String(req.params.date || "").trim();
  if (!_HA_SCALP_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades(MODE, date);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; if (key) seen.add(String(key)); }
  const missing = allTrades.filter(t => { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; return key && !seen.has(String(key)); });
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
  data.sessions.push({ date, strategy: (missing[0] && missing[0].strategy) || haStrategy.NAME, pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => istDayFromAny(a.date).localeCompare(istDayFromAny(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env[CAP_ENV] || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  // Today's restored trades are the ones a restart rehydrated as unsaved — now in totalPnl.
  if (date === tradeLogger.istDateString(Date.now())) state._unsaved = false;
  capitalPool.sessionSaved(MODE);   // drop the pool's file-P&L memo now
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: `Stop ${TITLE} paper trading before resetting.` });
  const fresh = parseFloat(process.env[CAP_ENV] || "100000");
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
// Exposed for offline unit-testing — this decides which number every exit
// is measured against, so it is tested rather than trusted.
router.attributeQuotes = attributeQuotes;
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
function forMarket(marketKey) { return forPairInstance(pairs.get("haScalp", marketKey)); }

const home = forMarket("NIFTY");
home.create    = create;
home.forMarket = forMarket;
home.forPair   = forPairInstance;
module.exports = home;

/**
 * SIMPLE_9:30 PAPER — /simple930-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL surface. Every decision / fill / exit semantic for SIMPLE_9:30
 * lives here; the backtest and the live harness must match THIS, never the
 * reverse (see feedback_paper_logic_untouchable).
 *
 * The day in one paragraph: at 09:25 the ITM ladder is quoted on both sides and
 * the ONE strike per side trading nearest ₹180 becomes the watchlist. From then
 * until 09:35 both premiums are polled; the first to trade above ₹180 is bought
 * at market with a 20-point stop off the ACTUAL FILL, trailing the peak premium
 * by the same 20 points. At 09:45 a trade that never touched ₹220 or ₹160 is
 * closed regardless of P&L. One trade per day. EOD square-off 15:15.
 *
 * ONE INSTRUMENT DRIVES EVERY DECISION: the OPTION PREMIUM, polled through
 * fyers.getQuotes every SIMPLE930_POLL_MS and recorded to the tick archive on
 * every poll, which is what makes Paper ≡ Live-harness ≡ Replay. The NIFTY 50
 * index arrives on the shared spot socket and is used for exactly two things —
 * the ATM strike sampled ONCE at 09:25, and the context chart on this page.
 * No rule reads the index chart.
 *
 * ORDERS GO TO ZERODHA. The live harness wraps this route with broker
 * "zerodha", so the capital pool, the charges model and the crash-recovery
 * reconciliation all sit on the Zerodha side. Market DATA is still Fyers —
 * that is the only broker with a NIFTY option feed in this repo.
 *
 * Signal engine: src/strategies/simple930.js (shared by paper, backtest, live
 * harness and replay — no rule is re-implemented in this file).
 *
 * Uses LIVE data but SIMULATES orders locally.
 * Endpoints: GET  /start /stop /exit /status /status/data /status/chart-data
 *                 /history /reset /download/... /view/...
 *            POST /restore-session/:date
 *            DELETE /session/:index
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const strategy           = require("../strategies/simple930");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { renderHistoryPage, dailyFilesPaginate } = require("../utils/paperHistoryUI");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiCapitalStrip, bbRsiStatGrid, bbRsiActivityLog, inr } = require("../utils/bbRsiStyleUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const tradeLogger = require("../utils/tradeLogger");
const aiExport    = require("../utils/aiExport");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport, sendIfMaster } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { getISTMinutes, getBucketStart } = require("../utils/tradeUtils");
const skipLogger  = require("../utils/skipLogger");
const capitalPool = require("../utils/capitalPool");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "simple930Paper";
const MODE_KEY           = "simple930";        // tradeLogger / skipLogger / capitalPool key
const MODE_TAG           = "SIMPLE930-PAPER";  // notify + tickRecorder mode string
const LOG_TAG            = "[SIMPLE930-PAPER]";
/** Fyers getQuotes accepts up to 50 symbols per call. */
const MAX_SYMBOLS_PER_CALL = 50;
/** Premium chart resolution, in minutes. Display only — no rule reads a bar. */
const PREMIUM_BAR_MIN = 1;

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "simple930_paper_trades.json");

// ── Config readers (Settings mutates process.env live — never cache) ─────────
function _startCapital() {
  return parseFloat(process.env.ZERODHA_INV_AMOUNT || process.env.FYERS_INV_AMOUNT || "100000");
}
function _maxDailyTrades() { return Math.max(1, parseInt(process.env.SIMPLE930_MAX_DAILY_TRADES || "1", 10) || 1); }
function _maxDailyLoss()   { return parseFloat(process.env.SIMPLE930_MAX_DAILY_LOSS   || "0"); }
function _pollMs() {
  const v = parseInt(process.env.SIMPLE930_POLL_MS || "1000", 10);
  return Number.isFinite(v) && v >= 250 && v <= 15000 ? v : 1000;
}
/** How long a polled premium may be stale before an entry is refused. */
function _ltpStaleMs() {
  const v = parseInt(process.env.SIMPLE930_LTP_STALE_MS || "15000", 10);
  return Number.isFinite(v) && v >= 1000 && v <= 120000 ? v : 15000;
}

/**
 * Position size. SIMPLE930_LOT_MULTIPLIER (when > 0) overrides the global
 * LOT_MULTIPLIER for this strategy only, clamped by the same MAX_LOT_MULTIPLIER
 * ceiling. Divides by the multiplier getLotQty ACTUALLY applied (it clamps
 * internally), not the raw env value. Default 0 = use the common setting.
 */
function simpleLotQty() {
  const base = instrumentConfig.getLotQty();
  const raw  = parseInt(process.env.SIMPLE930_LOT_MULTIPLIER || "0", 10);
  if (!Number.isFinite(raw) || raw <= 0) return base;

  let maxMult = parseInt(process.env.MAX_LOT_MULTIPLIER || "10", 10);
  if (!Number.isFinite(maxMult) || maxMult < 1) maxMult = 10;
  let globalMult = parseInt(process.env.LOT_MULTIPLIER || "1", 10);
  if (!Number.isFinite(globalMult) || globalMult <= 0) globalMult = 1;
  if (globalMult > maxMult) globalMult = maxMult;

  return Math.round((base / globalMult) * Math.min(raw, maxMult));
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let _dataCache = null;
function loadData() {
  if (_dataCache) return _dataCache;
  ensureDir();
  if (!fs.existsSync(PT_FILE)) {
    const init = { capital: _startCapital(), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(init, null, 2));
    _dataCache = init;
    return init;
  }
  try { _dataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error("[simple930-paper] simple930_paper_trades.json corrupt — resetting:", e.message);
    _dataCache = { capital: _startCapital(), totalPnl: 0, sessions: [] };
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
/**
 * The day's trade budget, kept OUTSIDE `state` on purpose.
 *
 * `/start` calls _freshState(), which zeroes tradesTaken — so a /stop → /start
 * inside the entry window handed the day a second trade, and the operator's rule
 * is ONE. rehydrateSessionFromJsonl() only runs at module load, so it cannot
 * close that hole either.
 *
 * Module-level, and deliberately NOT read back from the day's JSONL: tickReplay
 * drops this route from require.cache immediately BEFORE it requires it
 * (services/tickReplay.js, "Load the route module AFTER patches are installed"),
 * so every replay run starts with a clean guard. Reading the file instead would
 * make a replay of a day that already traded close the day at once and produce
 * zero trades — killing the paper-vs-replay diff that gates the live switch.
 */
let _dayGuard = { day: null, tradesTaken: 0, dayClosed: false, dayClosedReason: null };

function _todayIst() { return tradeLogger.istDateString(Date.now()); }

/** Fold the running session's day-level counters back into the guard. */
function _syncDayGuard() {
  _dayGuard = {
    day:             _todayIst(),
    tradesTaken:     state.tradesTaken,
    dayClosed:       state.dayClosed,
    dayClosedReason: state.dayClosedReason,
  };
}

let state = _freshState();
function _freshState() {
  return {
    running:        false,
    sessionStart:   null,
    sessionTrades:  [],
    sessionPnl:     0,
    tradesTaken:    0,
    stopOuts:       0,

    // NIFTY 50 INDEX — ATM sampling + the context chart + the session heartbeat.
    tickCount:      0,
    lastTickTime:   null,
    lastTickPrice:  null,
    indexCandles:   [],
    indexBar:       null,

    // The 09:25 plan. Frozen for the whole day once made.
    selection:      null,   // { atTime, atMins, spot, atm, expiryCode, ce, pe, candidates, notes }
    selectionTried: 0,
    _selectionInFlight: false,
    _lastSelectionTryMs: null,

    // The two watched legs, keyed CE/PE. Each: { symbol, strike, ltp, ltpAt,
    // entryLtp (the 09:25 premium), high, low, bars[], forming }
    watch:          { CE: null, PE: null },
    sustain:        { CE: 0, PE: 0 },

    position:       null,
    optionLtp:      null,
    optionLtpUpdatedAt: null,

    // Rich, structured decision trail rendered on the page and downloadable.
    decisions:      [],
    log:            [],
    lastTriggerNote: null,
    _lastWatchLogMs: null,

    dayClosed:      false,
    dayClosedReason: null,
    _entryInFlight: false,
    _lastEntryAttemptMs: null,
    _sessionId:     null,
    _staleSession:  false,
    _staleSkipLoggedMs: null,
    _quoteFailLoggedMs: null,
    _staleQuoteAlertMs: null,
    quoteStale:     false,
  };
}

function log(msg) {
  const stamp = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  const line = `[${stamp}] ${msg}`;
  state.log.push(line);
  if (state.log.length > 400) state.log.shift();
  console.log(line);
}

/**
 * One structured row on the day's decision trail. This is the audit record the
 * operator reads to answer "why did (or didn't) it trade?" — the freeform log
 * above is for humans watching live, this is for reading afterwards. Both are
 * exposed on /status/data and both land in the day's JSONL export.
 */
function decide(kind, headline, detail) {
  const row = {
    ts:     new Date().toISOString(),
    ist:    new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }),
    kind,                       // PLAN | SCAN | WATCH | ENTRY | TRAIL | BAND | EXIT | SKIP | DAY
    headline,
    ...(detail && typeof detail === "object" ? { detail } : {}),
  };
  state.decisions.push(row);
  if (state.decisions.length > 300) state.decisions.shift();
  return row;
}

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

// ── Crash/restart recovery: rehydrate today's in-memory session from JSONL ────
function rehydrateSessionFromJsonl() {
  try {
    const data = loadData();
    const keyOf = (t) => String(t.entryTimeMs || t.entryTime || `${t.symbol}@${t.optionEntryLtp}@${t.entryTime}`);
    const today = tradeLogger.istDateString(Date.now());
    const all = tradeLogger.readDailyTrades(MODE_KEY, today)
      .filter(t => t && !t.type && (t.side || t.entryTime || t.symbol));
    const seen = new Set();
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) seen.add(keyOf(t));
    let trades = all.filter(t => !seen.has(keyOf(t)));
    let source = "today's live session";
    let stale  = false;
    if (!trades.length) {
      const saved = (data.sessions || []).filter(s => Array.isArray(s.trades) && s.trades.length);
      if (saved.length) {
        const last = saved.reduce((a, b) => (String(b.date) > String(a.date) ? b : a));
        trades = last.trades;
        source = `last session (${last.date || "?"})`;
        stale  = all.length === 0;
      }
    }
    if (!trades.length) return;
    state._staleSession = stale;
    state.sessionTrades = trades;
    state.tradesTaken   = trades.length;
    state.stopOuts      = trades.filter(t => /stop/i.test(String(t.exitReason || ""))).length;
    state.sessionPnl    = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    if (!state.sessionStart) state.sessionStart = trades[0].entryTime || trades[0].loggedAt || null;
    console.log(`♻️ ${LOG_TAG} Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl}, ${state.stopOuts} stop-out(s))`);
  } catch (err) {
    console.warn(`${LOG_TAG} session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();
// Seed the day guard from what the rehydrate just found. Without this the guard
// only survived a /stop → /start; a PROCESS restart — which is what every deploy
// does, `pm2 startOrRestart` — reset it to null and handed the day a second
// trade. /start ignores the guard during a replay (see there), so seeding it
// here cannot close a replayed day.
// `_staleSession` means the rehydrate fell back to the LAST saved session because
// today's day file was empty — yesterday's trades must not spend today's budget.
if (state.tradesTaken > 0 && !state._staleSession) _syncDayGuard();
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => state, LOG_TAG);

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
      const trades = tradeLogger.readDailyTrades(MODE_KEY, ds) || [];
      for (const t of trades) if (t && !t.type && typeof t.pnl === "number") total += t.pnl;
    }
    return parseFloat(total.toFixed(2));
  } catch (_) {
    return state.running ? state.sessionPnl : 0;
  }
}

// ── Quote plumbing ───────────────────────────────────────────────────────────
/**
 * Read one getQuotes response into a symbol → { ltp, bid, ask } map.
 *
 * Attribution is STRICTLY by symbol — never "whatever is left over". A row that
 * cannot be identified is DROPPED, because writing a CE premium into the PE
 * leg would trigger the wrong side's entry and measure the stop against the
 * wrong instrument. The one exception is a single-symbol request that came back
 * with a single row: there is nothing to confuse it with.
 *
 * Exported for the offline test harness — this is the function that decides
 * which number every entry and every exit is measured against.
 */
function attributeQuotes(resp, symbols) {
  const out = new Map();
  if (!resp || resp.s !== "ok" || !Array.isArray(resp.d)) return out;
  const wanted = new Set(Array.isArray(symbols) ? symbols : [symbols]);
  for (const row of resp.d) {
    const v = (row && row.v) || {};
    const ltp = v.lp != null ? v.lp : v.ltp;
    if (typeof ltp !== "number" || !Number.isFinite(ltp) || !(ltp > 0)) continue;
    let sym = row && (row.n || row.symbol);
    if (!sym && resp.d.length === 1 && wanted.size === 1) sym = Array.from(wanted)[0];
    if (!sym || !wanted.has(sym)) continue;
    out.set(sym, {
      ltp,
      bid: typeof v.bid === "number" ? v.bid : (typeof v.bid_price === "number" ? v.bid_price : null),
      ask: typeof v.ask === "number" ? v.ask : (typeof v.ask_price === "number" ? v.ask_price : null),
    });
  }
  return out;
}

/** Batched getQuotes across Fyers' 50-symbol ceiling. Returns one merged map. */
async function fetchQuotes(symbols) {
  const merged = new Map();
  for (let i = 0; i < symbols.length; i += MAX_SYMBOLS_PER_CALL) {
    const batch = symbols.slice(i, i + MAX_SYMBOLS_PER_CALL);
    const resp  = await fyers.getQuotes(batch);
    for (const [k, v] of attributeQuotes(resp, batch)) merged.set(k, v);
  }
  return merged;
}

// ── Premium bars (display only) ──────────────────────────────────────────────
function _updatePremiumBar(leg, price) {
  const bucketSec = Math.floor(getBucketStart(Date.now(), PREMIUM_BAR_MIN) / 1000);
  if (!leg.forming || leg.forming.time !== bucketSec) {
    if (leg.forming) {
      leg.bars.push(leg.forming);
      if (leg.bars.length > 500) leg.bars.shift();
    }
    leg.forming = { time: bucketSec, open: price, high: price, low: price, close: price };
    return;
  }
  leg.forming.high  = Math.max(leg.forming.high, price);
  leg.forming.low   = Math.min(leg.forming.low, price);
  leg.forming.close = price;
}

// ── The 09:25 selection ──────────────────────────────────────────────────────
const SELECTION_RETRY_MS = 5000;

/**
 * Quote the ITM ladder once and freeze the day's watchlist.
 *
 * Every guard is synchronous and runs before the first await, so two polls
 * landing together cannot fire two selections and double-quote the chain.
 */
async function runSelection() {
  if (state.selection || state._selectionInFlight) return;
  if (state._lastSelectionTryMs && Date.now() - state._lastSelectionTryMs < SELECTION_RETRY_MS) return;
  const cfg = strategy.getConfig();
  const nowMin = getISTMinutes();
  if (nowMin < cfg.selectionMin) return;

  const spot = state.lastTickPrice;
  if (!strategy._px(spot)) {
    state._lastSelectionTryMs = Date.now();
    log(`⚠️ ${LOG_TAG} No NIFTY index price yet — cannot compute the ATM strike, selection deferred`);
    return;
  }

  state._selectionInFlight = true;
  state._lastSelectionTryMs = Date.now();
  state.selectionTried++;
  try {
    const atm = instrumentConfig.calcATMStrike(spot);

    // Resolve (and validate) the expiry ONCE, off the ATM contract. Every ladder
    // symbol is then built from that code, so a validated expiry costs one call
    // rather than one per rung.
    let ref;
    try {
      ref = await instrumentConfig.validateAndGetOptionSymbol(spot, "CE", "SIMPLE930", { strikeOverride: atm });
    } catch (e) {
      log(`❌ ${LOG_TAG} Expiry resolve failed: ${e.message} — selection will retry`);
      return;
    }
    if (!ref || ref.invalid || !ref.expiry) {
      log(`❌ ${LOG_TAG} No valid option expiry${ref && ref.staleExpiry ? ` (stale override ${ref.staleExpiry})` : ""} — no watchlist today`);
      skipLogger.appendSkipLog(MODE_KEY, { gate: "expiry", reason: "no valid option expiry", spot, atm });
      decide("SKIP", "No valid option expiry — the watchlist could not be built", { spot, atm });
      _closeDay("No valid option expiry — no watchlist could be built");
      return;
    }
    const expiryCode = ref.expiry;

    const ladder  = strategy.buildCandidateStrikes(atm, cfg);
    const symbols = ladder.map(c => strategy.optionSymbol(expiryCode, c.strike, c.side));
    const quotes  = await fetchQuotes(symbols);

    const rungs = ladder.map((c, i) => {
      const sym = symbols[i];
      const q   = quotes.get(sym);
      if (q) {
        // Record EVERY rung we quoted. This is what lets Replay re-derive the
        // same 09:25 pick instead of falling back to whatever the day-wide
        // chain recorder happened to cover.
        try { tickRecorder.recordOptionQuote(sym, q.ltp, q.bid, q.ask, "simple930-scan"); } catch (_) {}
      }
      return { ...c, symbol: sym, ltp: q ? q.ltp : null };
    });

    const quoted = rungs.filter(r => strategy._px(r.ltp)).length;
    if (quoted === 0) {
      // NOT a decision — an absence of data. A thrown quote error already
      // retried; a { s: "no_data" } response (an expired token, a hiccup) used
      // to freeze an empty watchlist for the whole day instead. Leave the
      // selection unmade so the 5s retry runs; the entry window closes it.
      log(`⚠️ ${LOG_TAG} 09:25 ladder came back with no prices at all (${rungs.length} rungs asked) — retrying, window closes ${strategy._fmtMins(cfg.entryEndMin)}`);
      return;
    }

    const picked = strategy.selectWatchlist(rungs, atm, cfg);
    const sel = {
      atTime:     istNow(),
      atMins:     nowMin,
      atMs:       Date.now(),
      spot:       strategy._r2(spot),
      atm,
      expiryCode,
      expiryDate: ref.expiryDate || null,
      ce:         picked.ce,
      pe:         picked.pe,
      candidates: picked.candidates,
      quoted,
      ladderSize: rungs.length,
      notes:      picked.notes,
      late:       nowMin > cfg.selectionMin + 1,
    };
    state.selection = sel;

    for (const side of ["CE", "PE"]) {
      const pick = side === "CE" ? picked.ce : picked.pe;
      if (!pick) { state.watch[side] = null; continue; }
      state.watch[side] = {
        side,
        symbol:   pick.symbol,
        strike:   pick.strike,
        selLtp:   pick.ltp,
        dist:     pick.dist,
        moneyness: pick.moneyness,
        ltp:      pick.ltp,
        ltpAt:    Date.now(),
        high:     pick.ltp,
        low:      pick.ltp,
        bars:     [],
        forming:  null,
      };
      _updatePremiumBar(state.watch[side], pick.ltp);
    }

    // ── The log the operator actually reads ──
    log(`🎯 ${LOG_TAG} 09:25 SELECTION — NIFTY ${sel.spot} → ATM ${atm} · expiry ${expiryCode}${sel.late ? " (late: session started after the selection time)" : ""}`);
    log(`   ├─ Quoted ${sel.quoted}/${sel.ladderSize} ladder rungs (${cfg.scanItmStrikes} ITM${cfg.scanOtmStrikes ? ` + ${cfg.scanOtmStrikes} OTM` : ""} per side), target ₹${cfg.triggerPremium}`);
    for (const side of ["CE", "PE"]) {
      const w = state.watch[side];
      if (w) log(`   ├─ ${side} WATCH ${w.strike} ${w.moneyness} @ ₹${w.selLtp} (₹${w.dist} from ₹${cfg.triggerPremium}) — ${w.symbol}`);
      else {
        const why = (picked.notes.rejected.find(r => r.side === side) || {}).why || "no usable premium";
        log(`   ├─ ${side} NOT WATCHED — ${why}`);
        skipLogger.appendSkipLog(MODE_KEY, { gate: "no_candidate", side, reason: why, spot: sel.spot, atm });
      }
    }
    if (picked.notes.missing.length) {
      log(`   └─ ${picked.notes.missing.length} rung(s) came back without a premium: ${picked.notes.missing.map(m => `${m.strike}${m.side}`).join(", ")}`);
    } else {
      log(`   └─ Watching until ${strategy._fmtMins(cfg.entryEndMin)} — first leg above ₹${cfg.triggerPremium} is bought`);
    }

    decide("SCAN", `Watchlist frozen — CE ${state.watch.CE ? `${state.watch.CE.strike} @ ₹${state.watch.CE.selLtp}` : "none"} · PE ${state.watch.PE ? `${state.watch.PE.strike} @ ₹${state.watch.PE.selLtp}` : "none"}`, {
      spot: sel.spot, atm, expiryCode,
      trigger: cfg.triggerPremium,
      quoted: sel.quoted, ladderSize: sel.ladderSize,
      ladder: picked.candidates.slice(0, 24),
      missing: picked.notes.missing,
      rejected: picked.notes.rejected,
      late: sel.late,
    });

    if (!state.watch.CE && !state.watch.PE) {
      _closeDay("Neither side produced a usable strike at 09:25 — nothing to watch");
    }
  } catch (err) {
    log(`❌ ${LOG_TAG} Selection failed: ${err.message} — will retry`);
    console.error(`${LOG_TAG} selection error:`, err);
  } finally {
    state._selectionInFlight = false;
  }
}

// ── Entry ────────────────────────────────────────────────────────────────────
const ENTRY_RETRY_MS = 5000;

/**
 * Buy the first watchlist leg trading above the trigger.
 *
 * Every guard is synchronous and runs before the first await, so two polls
 * arriving together can never open two positions.
 */
async function evaluateEntry() {
  if (state.position || state._entryInFlight || state.dayClosed) return;
  if (!state.selection) return;
  const cfg = strategy.getConfig();
  const nowMin = getISTMinutes();
  if (!strategy.inEntryWindow(nowMin, cfg)) return;
  if (state.tradesTaken >= _maxDailyTrades()) return;
  // The sustain counters are kept BEFORE the retry backoff returns. They mean
  // "consecutive quotes above the trigger", and a leg that dipped below during
  // the backoff has broken that run — freezing the counter through the pause
  // would let it fire a poll early. Only matters when SUSTAIN_POLLS > 1.
  const _cfgTrig = cfg.triggerPremium;
  for (const side of ["CE", "PE"]) {
    const w = state.watch[side];
    if (!(w && strategy._px(w.ltp) && w.ltp > _cfgTrig)) state.sustain[side] = 0;
  }
  if (state._lastEntryAttemptMs && Date.now() - state._lastEntryAttemptMs < ENTRY_RETRY_MS) return;

  const legs = { ce: state.watch.CE, pe: state.watch.PE };
  const verdict = strategy.evaluateTrigger(legs, cfg, state.sustain);
  state.lastTriggerNote = verdict.reason;

  // Keep the sustain counters honest whether or not the trigger fires: a leg
  // that drops back below the level has to start counting again.
  for (const side of ["CE", "PE"]) {
    const w = state.watch[side];
    state.sustain[side] = (w && strategy._px(w.ltp) && w.ltp > cfg.triggerPremium) ? state.sustain[side] + 1 : 0;
  }

  if (!verdict.fire) {
    // A once-a-minute heartbeat, so the log shows the strategy is watching
    // without one line per poll.
    if (!state._lastWatchLogMs || Date.now() - state._lastWatchLogMs > 60000) {
      state._lastWatchLogMs = Date.now();
      log(`👀 ${LOG_TAG} ${verdict.reason} — window closes ${strategy._fmtMins(cfg.entryEndMin)}`);
    }
    return;
  }

  const leg = state.watch[verdict.leg];
  if (!leg) return;

  // A premium the poll has not refreshed recently is not evidence of anything.
  const age = Date.now() - (leg.ltpAt || 0);
  if (age > _ltpStaleMs()) {
    // Reported once a minute, not once a poll: while the quote feed is down this
    // branch is reached every second, and an unthrottled skip row would bury the
    // day's real skips under hundreds of copies of the same one.
    if (!state._staleSkipLoggedMs || Date.now() - state._staleSkipLoggedMs > 60000) {
      state._staleSkipLoggedMs = Date.now();
      log(`🚫 ${LOG_TAG} ${verdict.leg} premium is ${Math.round(age / 1000)}s stale — entry refused rather than filled on an old quote`);
      skipLogger.appendSkipLog(MODE_KEY, { gate: "stale_ltp", side: verdict.leg, reason: `premium ${Math.round(age / 1000)}s old`, symbol: leg.symbol });
    }
    return;
  }

  state._entryInFlight = true;
  state._lastEntryAttemptMs = Date.now();
  try {
    await simulateBuy(verdict.leg, leg, verdict, cfg);
  } catch (err) {
    log(`❌ ${LOG_TAG} Entry failed: ${err.message}`);
    console.error(`${LOG_TAG} entry error:`, err);
  } finally {
    state._entryInFlight = false;
  }
}

async function simulateBuy(side, leg, verdict, cfg) {
  cfg = cfg || strategy.getConfig();
  // The session this fill belongs to. The re-quote below is the ONLY await in
  // the entry path, and /stop (or the 15:30 auto-stop) can land inside it.
  const sessionId = state._sessionId;

  // Re-quote the leg we are about to buy so the fill is the freshest price
  // available, not the one that happened to trip the trigger a poll ago.
  let fillLtp = leg.ltp;
  try {
    const q = await fetchQuotes([leg.symbol]);
    const fresh = q.get(leg.symbol);
    if (fresh && strategy._px(fresh.ltp)) {
      fillLtp = fresh.ltp;
      leg.ltp = fresh.ltp;
      leg.ltpAt = Date.now();
      try { tickRecorder.recordOptionQuote(leg.symbol, fresh.ltp, fresh.bid, fresh.ask, "simple930-entry"); } catch (_) {}
    }
  } catch (e) {
    log(`⚠️ ${LOG_TAG} Entry re-quote failed (${e.message}) — filling on the triggering quote ₹${fillLtp}`);
  }

  // The session must still be the one that decided to buy. A /stop or an
  // auto-stop that landed during the re-quote has already run its square-off and
  // torn down the poll chain, so committing the position now would leave a real
  // broker order with nothing left to trail it, stop it or square it off.
  if (!state.running || state._sessionId !== sessionId) {
    log(`🚫 ${LOG_TAG} Session ended while the ${side} fill was in flight — entry abandoned, no order placed`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "session_ended", side, reason: "session stopped mid-fill", symbol: leg.symbol });
    return;
  }

  if (!strategy._px(fillLtp)) {
    log(`❌ ${LOG_TAG} No usable premium for ${leg.symbol} — entry skipped`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "option_ltp", reason: "no option LTP at fill", symbol: leg.symbol, side });
    return;
  }
  // The re-quote can land back BELOW the trigger. Buying anyway would be an
  // entry the rule never asked for, so refuse and let the next poll decide.
  if (!(fillLtp > cfg.triggerPremium)) {
    log(`🚫 ${LOG_TAG} ${side} fell back to ₹${fillLtp} (≤ ₹${cfg.triggerPremium}) before the fill — entry abandoned, still watching`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "trigger_lost", side, reason: `re-quote ₹${fillLtp} is no longer above ₹${cfg.triggerPremium}`, symbol: leg.symbol });
    state.sustain[side] = 0;
    return;
  }

  const stop = strategy.computeInitialStop(fillLtp, cfg);
  if (!strategy._num(stop)) {
    log(`🚫 ${LOG_TAG} Entry ABORTED — stop level uncomputable from fill ₹${fillLtp}. Refusing to enter without one.`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "levels_uncomputable", reason: `stop uncomputable from fill ${fillLtp}`, side, symbol: leg.symbol });
    return;
  }

  const qty  = simpleLotQty();
  const band = strategy.bandLevels(cfg);

  // Capital check — advisory only: an overdrawn pool raises a dashboard alert,
  // it never stops a paper trade. Sits AFTER the last abort path.
  const _cap = capitalPool.check(MODE_KEY, qty * fillLtp);
  if (!_cap.ok) {
    log(`⚠️ ${LOG_TAG} ${_cap.reason} — entry taken anyway, pool now overdrawn`);
    capitalPool.noteShortfall(MODE_KEY, _cap, { side, symbol: leg.symbol });
  }

  const pos = {
    side,
    symbol:        leg.symbol,
    optionStrike:  leg.strike,
    optionExpiry:  state.selection ? state.selection.expiryCode : null,
    optionType:    side,
    qty,
    optionEntryLtp: strategy._r2(fillLtp),
    entryPrice:    strategy._r2(fillLtp),      // premium IS the traded price here
    spotAtEntry:   state.lastTickPrice,
    indexAtEntry:  state.lastTickPrice,
    atmAtSelection: state.selection ? state.selection.atm : null,
    selectionLtp:  leg.selLtp,
    trigger:       cfg.triggerPremium,
    stop:          stop,
    stopLoss:      stop,
    initialStop:   stop,
    initialStopLoss: stop,
    slPts:         cfg.slPts,
    trailPts:      cfg.trailPts,
    trailEnabled:  cfg.trailEnabled,
    trailMoves:    0,
    bandUp:        band.up,
    bandDown:      band.down,
    expanded:      false,
    expandedAt:    null,
    peak:          strategy._r2(fillLtp),
    trough:        strategy._r2(fillLtp),
    peakPremium:   strategy._r2(fillLtp),
    entryTime:     istNow(),
    entryTimeMs:   Date.now(),
    entryMin:      getISTMinutes(),   // IST minute-of-day — the 09:45 rule needs it
    entryUnixSec:  Math.floor(Date.now() / 1000),
    entryBarTime:  Math.floor(getBucketStart(Date.now(), PREMIUM_BAR_MIN) / 1000),
    entryReason:   verdict ? verdict.reason : `${side} above ₹${cfg.triggerPremium}`,
    bothAbove:     verdict ? !!verdict.both : false,
    mfePts: 0, mfePnl: 0, maePts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
  };

  state.position = pos;
  capitalPool.block(MODE_KEY, qty * fillLtp, { side, symbol: leg.symbol, qty, premium: fillLtp });
  try { require("../utils/positionPersist").saveSimple930Position(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  state.optionLtp = fillLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;
  _syncDayGuard();

  log(`🟢 ${LOG_TAG} BUY ${side} ${leg.symbol} qty=${qty} @ ₹${pos.optionEntryLtp}`);
  log(`   ├─ Trigger: ${pos.entryReason}`);
  log(`   ├─ SL ₹${stop} (${cfg.slPts}pt off the fill)${cfg.trailEnabled ? ` · trailing ${cfg.trailPts}pt behind the peak` : " · NO trail"}`);
  log(`   └─ ${strategy._fmtMins(cfg.sidewaysMin)} check: must trade ≥₹${band.up} or ≤₹${band.down} or the trade is closed · EOD ${strategy._fmtMins(cfg.forcedExitMin)}`);

  decide("ENTRY", `BUY ${side} ${leg.strike} @ ₹${pos.optionEntryLtp} — SL ₹${stop}`, {
    symbol: leg.symbol, strike: leg.strike, qty,
    fill: pos.optionEntryLtp, trigger: cfg.triggerPremium,
    selectionLtp: leg.selLtp,
    stop, slPts: cfg.slPts, trailPts: cfg.trailPts, trailEnabled: cfg.trailEnabled,
    bandUp: band.up, bandDown: band.down,
    sidewaysAt: strategy._fmtMins(cfg.sidewaysMin), eod: strategy._fmtMins(cfg.forcedExitMin),
    bothLegsAbove: pos.bothAbove,
  });

  notifyEntry({
    mode: MODE_TAG,
    side, symbol: leg.symbol,
    spotAtEntry: state.lastTickPrice, optionEntryLtp: pos.optionEntryLtp,
    qty, stopLoss: stop, target: null,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });
}

// ── Exit ─────────────────────────────────────────────────────────────────────
function simulateSell(reason, opts) {
  if (!state.position) return;
  const o   = opts || {};
  const pos = state.position;
  const exitLtp = strategy._px(state.optionLtp) ? state.optionLtp : pos.optionEntryLtp;
  // Whether the price this exit was booked at was actually current. A stale exit
  // still sends the real order in LIVE — it is the RECORD that would otherwise
  // be fiction, so the trade carries the age it was priced at.
  const exitAgeSec  = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const exitStale   = strategy._num(exitAgeSec) && exitAgeSec * 1000 > _ltpStaleMs();
  const qty     = pos.qty;
  const charges = getCharges({ broker: "zerodha", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitLtp, qty });
  const pnl     = parseFloat(((exitLtp - pos.optionEntryLtp) * qty - charges).toFixed(2));

  state.sessionPnl = parseFloat((state.sessionPnl + pnl).toFixed(2));
  // Only a REAL stop-out burns a stop-out slot — never inferred from the sign
  // of the P&L, so a trailed stop that nets positive still counts as one.
  if (o.isStopOut) state.stopOuts++;

  const trade = {
    side:            pos.side,
    symbol:          pos.symbol,
    qty,
    // For a premium-only strategy "price" IS the premium. Both spellings are
    // written so the shared history/consolidation screens (which read
    // entryPrice/exitPrice) and the option-aware ones agree on one number.
    entryPrice:      pos.optionEntryLtp,
    exitPrice:       strategy._r2(exitLtp),
    optionEntryLtp:  pos.optionEntryLtp,
    optionExitLtp:   strategy._r2(exitLtp),
    bestOptionLtp:   pos.peak,
    worstOptionLtp:  pos.trough,
    spotAtEntry:     pos.spotAtEntry,
    spotAtExit:      state.lastTickPrice,
    indexAtEntry:    pos.indexAtEntry,
    atmAtSelection:  pos.atmAtSelection,
    selectionLtp:    pos.selectionLtp,
    trigger:         pos.trigger,
    entryTime:       pos.entryTime,
    exitTime:        istNow(),
    entryTimeMs:     pos.entryTimeMs,
    entryBarTime:    pos.entryBarTime,
    exitBarTime:     Math.floor(getBucketStart(Date.now(), PREMIUM_BAR_MIN) / 1000),
    pnl,
    pnlMode:         `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${strategy._r2(exitLtp)} (every level is a premium, not a spot)`,
    exitReason:      reason,
    exitKind:        o.kind || null,
    entryReason:     pos.entryReason,
    stopLoss:        pos.stop,
    initialStopLoss: pos.initialStop,
    trailMoves:      pos.trailMoves,
    bandUp:          pos.bandUp,
    bandDown:        pos.bandDown,
    expanded:        pos.expanded,
    expandedAt:      pos.expandedAt,
    optionStrike:    pos.optionStrike,
    optionExpiry:    pos.optionExpiry,
    optionType:      pos.side,
    optionEntrySymbol: pos.symbol,
    riskPts:         pos.slPts,
    mfePts:          pos.mfePts || 0,
    mfePnl:          pos.mfePnl || 0,
    maePts:          pos.maePts || 0,
    maePnl:          pos.maePnl || 0,
    secsToMFE:       pos.secsToMFE || 0,
    secsToMAE:       pos.secsToMAE || 0,
    durationMs:      Date.now() - pos.entryTimeMs,
    charges,
    isFutures:       false,
    instrument:      "NIFTY_OPTIONS",
    broker:          "zerodha",
    exitLtpAgeSec:   exitAgeSec,
    exitPriceStale:  exitStale,
  };
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog(MODE_KEY, trade);

  log(`🔴 ${LOG_TAG} EXIT ${pos.side} ${pos.symbol} @ ₹${trade.optionExitLtp} | PnL=₹${pnl} (${reason})`);
  if (exitStale) log(`   ⚠️ Booked on a ${exitAgeSec}s-OLD premium — this P&L is NOT a real fill. In live the broker filled at the market price, not this one.`);
  log(`   └─ Ranged ₹${pos.trough}–₹${pos.peak} · ${pos.trailMoves} trail move(s) · held ${Math.round(trade.durationMs / 1000)}s · charges ₹${charges}`);

  decide("EXIT", `${o.kind || "EXIT"} ${pos.side} ${pos.optionStrike} @ ₹${trade.optionExitLtp} — ₹${pnl}`, {
    reason, kind: o.kind || null,
    entry: pos.optionEntryLtp, exit: trade.optionExitLtp,
    stop: pos.stop, initialStop: pos.initialStop, trailMoves: pos.trailMoves,
    peak: pos.peak, trough: pos.trough, expanded: pos.expanded,
    pnl, charges, heldSec: Math.round(trade.durationMs / 1000),
  });

  notifyExit({
    mode: MODE_TAG,
    side: pos.side, symbol: pos.symbol,
    spotAtEntry: pos.spotAtEntry, spotAtExit: state.lastTickPrice,
    optionEntryLtp: pos.optionEntryLtp, optionExitLtp: trade.optionExitLtp,
    pnl, sessionPnl: state.sessionPnl,
    exitReason: reason, entryReason: pos.entryReason,
    entryTime: pos.entryTime, exitTime: trade.exitTime, qty,
    peakPremium: pos.peak, peakPnl: trade.mfePnl,
    maxDrawdown: trade.maePnl, heldMs: trade.durationMs,
  });

  state.position = null;
  capitalPool.release(MODE_KEY, pnl);
  try { require("../utils/positionPersist").clearSimple930Position(); } catch (_) {}
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;

  _applyDayBreakers();
}

/** Day-level breakers, evaluated after every exit. Each one CLOSES the day. */
function _applyDayBreakers() {
  if (state.dayClosed) return;
  const maxLoss = _maxDailyLoss();
  if (maxLoss > 0 && state.sessionPnl <= -maxLoss) {
    _closeDay(`Daily loss cap hit (₹${state.sessionPnl} ≤ -₹${maxLoss})`);
    return;
  }
  if (state.tradesTaken >= _maxDailyTrades()) {
    _closeDay(`Daily trade budget spent (${state.tradesTaken}/${_maxDailyTrades()})`);
  }
}

function _closeDay(reason) {
  if (state.dayClosed) return;
  state.dayClosed = true;
  state.dayClosedReason = reason;
  _syncDayGuard();
  log(`⏸️ ${LOG_TAG} ${reason} — no more entries today`);
  decide("DAY", reason, { sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken });
  skipLogger.appendSkipLog(MODE_KEY, { gate: "day_closed", reason, sessionPnl: state.sessionPnl });
}

/**
 * Every exit test, run on each polled premium.
 *
 * Order matters and is deliberate: the running peak/trough are updated FIRST
 * (so the trail and the band see this quote), then the stop is recomputed, then
 * the engine decides. A quote that both makes a new high and falls back to the
 * trail cannot happen — those are two different quotes — but a quote that
 * arrives after 09:45 AND is below the stop can, and exitCheck books the stop.
 */
function _checkExits() {
  const pos = state.position;
  if (!pos) return;
  const ltp = state.optionLtp;
  if (!strategy._px(ltp)) return;
  const cfg = strategy.getConfig();

  // ── Stale-premium watchdog ──
  // Every exit below is measured against the LAST polled premium, so when the
  // quote feed dies with a position open the stop simply never fires: the frozen
  // number never breaches it while the real premium collapses. Entry already
  // refuses a stale quote; an exit cannot refuse — in LIVE the square-off order
  // still has to go out, and it will fill at the real price whatever this engine
  // believes. So the exits keep running and the operator gets told, loudly and
  // repeatedly, that the number driving them is old.
  const ltpAge = state.optionLtpUpdatedAt ? Date.now() - state.optionLtpUpdatedAt : null;
  state.quoteStale = strategy._num(ltpAge) && ltpAge > _ltpStaleMs();
  if (state.quoteStale) {
    if (!state._staleQuoteAlertMs || Date.now() - state._staleQuoteAlertMs > 60000) {
      state._staleQuoteAlertMs = Date.now();
      const secs = Math.round(ltpAge / 1000);
      log(`🚨 ${LOG_TAG} ${pos.symbol} premium is ${secs}s STALE — the stop cannot fire on a frozen price. Check the Fyers feed; square off manually if this persists.`);
      decide("SKIP", `Premium feed stale for ${secs}s — exits are running on an old price`, { symbol: pos.symbol, ageSec: secs, lastPremium: ltp, stop: pos.stop });
      try {
        sendIfMaster(`🚨 SIMPLE_9:30 — premium feed STALE\n${pos.symbol} last priced ₹${ltp}, ${secs}s ago.\nThe ${cfg.slPts}pt stop at ₹${pos.stop} CANNOT fire while the price is frozen.\nCheck the Fyers feed and square off manually if it does not recover.`);
      } catch (_) {}
    }
  } else {
    state._staleQuoteAlertMs = null;
  }

  if (ltp > pos.peak)   pos.peak = strategy._r2(ltp);
  if (ltp < pos.trough) pos.trough = strategy._r2(ltp);
  pos.peakPremium = pos.peak;

  const favPts = strategy._r2(ltp - pos.optionEntryLtp);
  const curPnl = (ltp - pos.optionEntryLtp) * pos.qty;
  if (favPts > (pos.mfePts || 0)) { pos.mfePts = favPts; pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl > (pos.mfePnl || 0)) pos.mfePnl = parseFloat(curPnl.toFixed(2));
  if (favPts < (pos.maePts || 0)) { pos.maePts = favPts; pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl < (pos.maePnl || 0)) pos.maePnl = parseFloat(curPnl.toFixed(2));

  // Band expansion — announced once, because it is what saves the trade from
  // the 09:45 exit and the operator should be able to see the exact moment.
  // `pos` is passed so this reads the SAME box exitCheck reads — the one the
  // trade opened under. Without it a Settings change mid-trade made the page and
  // the decision trail announce "the band broke" while the engine still closed
  // the trade at 09:45.
  if (!pos.expanded && strategy.isExpanded(pos.peak, pos.trough, cfg, pos)) {
    pos.expanded = true;
    pos.expandedAt = istNow();
    const edge = pos.peak >= cfg.bandUp ? `above ₹${cfg.bandUp}` : `below ₹${cfg.bandDown}`;
    log(`📈 ${LOG_TAG} Band broken — premium traded ${edge}; the ${strategy._fmtMins(cfg.sidewaysMin)} sideways exit no longer applies`);
    decide("BAND", `Premium left the ₹${cfg.bandDown}–₹${cfg.bandUp} box (${edge})`, { peak: pos.peak, trough: pos.trough, at: pos.expandedAt });
    try { require("../utils/positionPersist").saveSimple930Position(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  }

  // Trail — ratchet only, never below the initial stop.
  const newStop = strategy.computeTrailStop(pos.peak, pos.initialStop, cfg);
  if (strategy._num(newStop) && newStop > pos.stop) {
    const prev = pos.stop;
    pos.stop = newStop;
    pos.stopLoss = newStop;
    pos.trailMoves++;
    log(`🧗 ${LOG_TAG} Trail — SL ₹${prev} → ₹${newStop} (peak ₹${pos.peak}, ${cfg.trailPts}pt behind)`);
    decide("TRAIL", `SL moved ₹${prev} → ₹${newStop}`, { peak: pos.peak, trailPts: cfg.trailPts, move: pos.trailMoves });
    try { require("../utils/positionPersist").saveSimple930Position(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  }

  const verdict = strategy.exitCheck(pos, ltp, getISTMinutes(), cfg);
  if (verdict && verdict.exit) {
    simulateSell(verdict.reason, { kind: verdict.kind, isStopOut: verdict.kind === "STOP" || verdict.kind === "TRAIL" });
  }
}

/**
 * Close the day once the entry window has passed with nothing taken. Without
 * this the page would sit "running, waiting" until 15:15 with no explanation.
 */
function _closeIfWindowMissed() {
  if (state.dayClosed || state.position || state.tradesTaken > 0) return;
  const cfg = strategy.getConfig();
  if (getISTMinutes() <= cfg.entryEndMin) return;
  const ce = state.watch.CE, pe = state.watch.PE;
  const detail = `CE ${ce ? `${ce.strike} peaked ₹${ce.high}` : "not watched"} · PE ${pe ? `${pe.strike} peaked ₹${pe.high}` : "not watched"}`;
  _closeDay(`No leg cleared ₹${cfg.triggerPremium} by ${strategy._fmtMins(cfg.entryEndMin)} — no trade today (${detail})`);
  skipLogger.appendSkipLog(MODE_KEY, {
    gate: "no_trigger", reason: `neither watchlist leg traded above ₹${cfg.triggerPremium} inside the entry window`,
    cePeak: ce ? ce.high : null, pePeak: pe ? pe.high : null, trigger: cfg.triggerPremium,
  });
}

// ── The poll — the clock every decision runs on ──────────────────────────────
// A setTimeout CHAIN, not setInterval: the replay harness collapses short
// setTimeout delays to 0ms so this loop runs once per pumped tick during a
// replay. setInterval is not intercepted and would fire a handful of times for
// a whole simulated day.
let _pollTimer = null;
let _pollStopped = true;

function startPolling() {
  stopPolling();
  _pollStopped = false;
  const poll = async () => {
    if (_pollStopped) return;
    try {
      if (!state.selection) {
        await runSelection();
      } else {
        const syms = [];
        for (const side of ["CE", "PE"]) if (state.watch[side]) syms.push(state.watch[side].symbol);
        if (syms.length) {
          const q = await fetchQuotes(syms);
          for (const side of ["CE", "PE"]) {
            const w = state.watch[side];
            if (!w) continue;
            const row = q.get(w.symbol);
            if (!row || !strategy._px(row.ltp)) continue;
            w.ltp = row.ltp;
            w.ltpAt = Date.now();
            if (row.ltp > w.high) w.high = strategy._r2(row.ltp);
            if (row.ltp < w.low)  w.low  = strategy._r2(row.ltp);
            _updatePremiumBar(w, row.ltp);
            try { tickRecorder.recordOptionQuote(w.symbol, row.ltp, row.bid, row.ask, "simple930-paper"); } catch (_) {}
            if (state.position && state.position.symbol === w.symbol) {
              state.optionLtp = row.ltp;
              state.optionLtpUpdatedAt = Date.now();
            }
          }
        }
      }
    } catch (e) {
      // A quote failure must not kill the poll chain — the next tick retries.
      if (!state._quoteFailLoggedMs || Date.now() - state._quoteFailLoggedMs > 30000) {
        state._quoteFailLoggedMs = Date.now();
        log(`⚠️ ${LOG_TAG} Quote poll failed: ${e.message}`);
      }
    }

    // Exits first — a stop must never wait behind an entry evaluation.
    try { _checkExits(); } catch (e) { console.error(`🚨 ${LOG_TAG} exit-check error: ${e.message}`); }
    try { if (!state.position) { evaluateEntry().catch(err => console.error(`🚨 ${LOG_TAG} entry error: ${err.message}`)); } } catch (e) { console.error(`🚨 ${LOG_TAG} entry error: ${e.message}`); }
    try { _closeIfWindowMissed(); } catch (e) { console.error(`🚨 ${LOG_TAG} window-close error: ${e.message}`); }

    if (!_pollStopped) _pollTimer = setTimeout(poll, _pollMs());
  };
  _pollTimer = setTimeout(poll, 250);
}

function stopPolling() {
  _pollStopped = true;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

// ── Index ticks — ATM sampling, the context chart and the heartbeat ──────────
function onTick(tick) {
  if (!state.running) return;
  const price = tick && typeof tick.ltp === "number" ? tick.ltp : null;
  if (!strategy._px(price)) return;
  state.tickCount++;
  state.lastTickPrice = price;
  state.lastTickTime  = Date.now();

  const bucketSec = Math.floor(getBucketStart(Date.now(), PREMIUM_BAR_MIN) / 1000);
  if (!state.indexBar || state.indexBar.time !== bucketSec) {
    if (state.indexBar) {
      state.indexCandles.push(state.indexBar);
      if (state.indexCandles.length > 500) state.indexCandles.shift();
    }
    state.indexBar = { time: bucketSec, open: price, high: price, low: price, close: price };
  } else {
    state.indexBar.high  = Math.max(state.indexBar.high, price);
    state.indexBar.low   = Math.min(state.indexBar.low, price);
    state.indexBar.close = price;
  }
}

let _autoStopTimer = null;
function scheduleAutoStop() {
  if (_autoStopTimer) clearTimeout(_autoStopTimer);
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  const stopMin = h * 60 + (isNaN(m) ? 0 : m);
  const minsLeft = stopMin - getISTMinutes();
  if (minsLeft <= 0) return;
  _autoStopTimer = setTimeout(() => { log(`⏰ ${LOG_TAG} Auto-stop @ ${raw} IST`); stopSession(); }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ────────────────────────────────────────────────────────
router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/simple930-paper/status");

  if (String(process.env.SIMPLE930_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("SIMPLE_9:30 Disabled", "Enable SIMPLE_9:30 Mode in Settings first", "/settings", "Go to Settings"));
  }
  if (String(process.env.SIMPLE930_PAPER_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("SIMPLE_9:30 Paper Disabled", "Enable SIMPLE_9:30 Paper Trading in Settings first", "/settings", "Go to Settings"));
  }

  const check = sharedSocketState.canStart("SIMPLE930_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/simple930-paper/status", "← Back"));

  // Fyers is the DATA broker for every strategy in this repo, including the ones
  // that place their orders on Zerodha. Without it there is no option chain to
  // quote at 09:25 and no premium to watch.
  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/simple930-paper/status", "← Back"));

  const cfg = strategy.getConfig();
  if (getISTMinutes() >= cfg.forcedExitMin) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${strategy._fmtMins(cfg.forcedExitMin)} IST — SIMPLE_9:30 does not trade after this`, "/simple930-paper/status", "← Back"));
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `simple930-paper:${Date.now()}`;

  // Carry today's already-spent trade budget across a restart — of the session
  // OR of the whole process. Without this a /stop → /start, or any deploy, buys
  // a second time on a strategy whose whole rule is one trade a day.
  //
  // A replay must ignore it: the guard is seeded at module load from the day
  // file, and replaying a day that already traded would otherwise close the day
  // at once and book zero trades — killing the paper-vs-replay diff that gates
  // the live switch. Lazy require, and a failure means "not replaying".
  let _replaying = false;
  try { _replaying = require("../services/tickReplay").isReplayInProgress(); } catch (_) {}
  if (!_replaying && _dayGuard.day === _todayIst() && (_dayGuard.tradesTaken > 0 || _dayGuard.dayClosed)) {
    state.tradesTaken     = _dayGuard.tradesTaken;
    state.dayClosed       = _dayGuard.dayClosed;
    state.dayClosedReason = _dayGuard.dayClosedReason;
    log(`♻️ ${LOG_TAG} Same-day restart — carrying forward ${state.tradesTaken} trade(s)${state.dayClosed ? ` · day already closed: ${state.dayClosedReason}` : ""}`);
  }

  sharedSocketState.setSimple930Active("SIMPLE930_PAPER");

  log(`🟢 ${LOG_TAG} Session started — ${strategy.NAME}`);
  log(`⚙️ ${LOG_TAG} ${strategy.describePlan(cfg)}`);
  log(`⚙️ ${LOG_TAG} Ladder ${cfg.scanItmStrikes} ITM${cfg.scanOtmStrikes ? ` + ${cfg.scanOtmStrikes} OTM` : ""} per side · qty ${simpleLotQty()} · max ${_maxDailyTrades()} trade(s)/day · orders route to ZERODHA · quotes every ${_pollMs()}ms`);
  if (cfg.maxPremiumDist || cfg.minPremium || cfg.sustainPolls > 1) {
    log(`⚙️ ${LOG_TAG} Optional guards ON — ${[
      cfg.maxPremiumDist ? `reject a side further than ₹${cfg.maxPremiumDist} from ₹${cfg.triggerPremium}` : null,
      cfg.minPremium ? `ignore rungs under ₹${cfg.minPremium}` : null,
      cfg.sustainPolls > 1 ? `require ${cfg.sustainPolls} consecutive quotes above the trigger` : null,
    ].filter(Boolean).join(" · ")}`);
  }
  decide("PLAN", strategy.describePlan(cfg), {
    trigger: cfg.triggerPremium, bandUp: cfg.bandUp, bandDown: cfg.bandDown,
    slPts: cfg.slPts, trailPts: cfg.trailPts, trailEnabled: cfg.trailEnabled,
    selection: strategy._fmtMins(cfg.selectionMin),
    entryWindow: `${strategy._fmtMins(cfg.entryStartMin)}–${strategy._fmtMins(cfg.entryEndMin)}`,
    sideways: strategy._fmtMins(cfg.sidewaysMin), eod: strategy._fmtMins(cfg.forcedExitMin),
    qty: simpleLotQty(), maxDailyTrades: _maxDailyTrades(), broker: "zerodha",
  });

  if (getISTMinutes() > cfg.entryEndMin) {
    log(`⚠️ ${LOG_TAG} Started after ${strategy._fmtMins(cfg.entryEndMin)} — the entry window has already closed, so today is monitor-only`);
    _closeDay(`Session started after the ${strategy._fmtMins(cfg.entryEndMin)} entry window closed`);
  }

  try {
    tickRecorder.recordSessionStart({
      mode: "simple930-paper",
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: [],
      meta: {
        instrument: instrumentConfig.INSTRUMENT,
        resolutionMin: PREMIUM_BAR_MIN,
        spotSymbol: NIFTY_INDEX_SYMBOL,
        decisionSymbol: "option premium (watchlist)",
        sessionStartISO: state.sessionStart,
        recordsOptionLtps: true,
      },
    });
  } catch (_) {}

  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log(`📡 ${LOG_TAG} Piggybacking on existing WebSocket (NIFTY 50 index — ATM strike + heartbeat only)`);
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log(`📡 ${LOG_TAG} Started WebSocket (NIFTY 50 index — ATM strike + heartbeat only)`);
  }

  startPolling();
  scheduleAutoStop();

  notifyStarted({
    mode: MODE_TAG,
    text: [
      `📄 SIMPLE_9:30 PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${strategy.NAME}`,
      `Select    : ${strategy._fmtMins(cfg.selectionMin)} — the strike nearest ₹${cfg.triggerPremium} on each side`,
      `Entry     : first watchlist leg above ₹${cfg.triggerPremium}, ${strategy._fmtMins(cfg.entryStartMin)}–${strategy._fmtMins(cfg.entryEndMin)}`,
      `Risk      : ${cfg.slPts}pt stop off the fill${cfg.trailEnabled ? `, trailing ${cfg.trailPts}pt` : " (no trail)"}`,
      `Sideways  : close at ${strategy._fmtMins(cfg.sidewaysMin)} if still inside ₹${cfg.bandDown}–₹${cfg.bandUp}`,
      `Square-off: ${strategy._fmtMins(cfg.forcedExitMin)} IST · orders → Zerodha`,
    ].join("\n"),
  });

  res.redirect("/simple930-paper/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped", { kind: "MANUAL" });
  state.running = false;
  stopPolling();

  try { tickRecorder.recordSessionStop({ mode: "simple930-paper", sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  sharedSocketState.clearSimple930();   // clear OWN mode first (else the socket never stops → leak)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: strategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      data.capital  = parseFloat((_startCapital() + data.totalPnl).toFixed(2));
      saveData(data);
      log(`💾 ${LOG_TAG} Session saved — ${state.sessionTrades.length} trade(s), PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ ${LOG_TAG} Save failed: ${e.message}`);
    }
  }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  log(`📋 ${LOG_TAG} Day summary — ${state.sessionTrades.length} trade(s), ${wins}W/${state.sessionTrades.length - wins}L, net ₹${state.sessionPnl}, week ₹${weeklyPnl()}`);
  log(`🔴 ${LOG_TAG} Session stopped`);

  notifyDayReport({
    mode: MODE_TAG,
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/simple930-paper/status"); });
router.get("/exit", (req, res) => { if (state.position) simulateSell("Manual exit", { kind: "MANUAL" }); res.redirect("/simple930-paper/status"); });

// ── /status/chart-data — the two premium charts + the index context chart ────
router.get("/status/chart-data", (req, res) => {
  try {
    const cfg = strategy.getConfig();
    const pos = state.position;
    const legOf = (side) => {
      const w = state.watch[side];
      if (!w) return null;
      const bars = w.bars.slice();
      if (w.forming && (!bars.length || w.forming.time > bars[bars.length - 1].time)) bars.push(w.forming);
      const markers = [];
      for (const t of state.sessionTrades) {
        if (t.side !== side) continue;
        if (t.entryBarTime) markers.push({ time: t.entryBarTime, position: "belowBar", color: "#10b981", shape: "arrowUp", text: `BUY ${t.optionEntryLtp}` });
        if (t.exitBarTime)  markers.push({ time: t.exitBarTime,  position: "aboveBar", color: (t.pnl || 0) >= 0 ? "#10b981" : "#ef4444", shape: "circle", text: `${(t.pnl || 0) >= 0 ? "+" : ""}${Math.round(t.pnl || 0)}` });
      }
      return {
        symbol: w.symbol, strike: w.strike, moneyness: w.moneyness,
        selLtp: w.selLtp, ltp: w.ltp, high: w.high, low: w.low,
        bars, markers,
        held: !!(pos && pos.side === side),
        stop: pos && pos.side === side ? pos.stop : null,
        entry: pos && pos.side === side ? pos.optionEntryLtp : null,
      };
    };

    const indexCandles = state.indexCandles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.indexBar) indexCandles.push({ ...state.indexBar });

    // The EOD chart reporter (utils/eodChartReporter.js) reads a flat
    // { candles, markers } off every strategy's chart-data. For this strategy
    // the chart worth mailing out is the PREMIUM of the leg it actually held —
    // the only chart any of its rules read — so surface that leg at the top
    // level too. Falls back to whichever leg exists when the day was flat.
    const ceLeg = legOf("CE");
    const peLeg = legOf("PE");
    const primary = (pos && pos.side === "PE") ? peLeg : (pos ? ceLeg : (ceLeg || peLeg));

    res.json({
      candles: primary ? primary.bars    : [],
      markers: primary ? primary.markers : [],
      primarySide: primary ? primary.symbol : null,
      ce: ceLeg,
      pe: peLeg,
      indexCandles,
      trigger: cfg.triggerPremium,
      bandUp: cfg.bandUp,
      bandDown: cfg.bandDown,
      resMin: PREMIUM_BAR_MIN,
      atm: state.selection ? state.selection.atm : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const data = loadData();
  const cfg  = strategy.getConfig();

  let livePnl = null;
  if (pos && strategy._px(state.optionLtp)) {
    livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * (pos.qty || simpleLotQty())).toFixed(2));
  }

  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: parseFloat(cum.toFixed(2)) }); }

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const bestTrade  = state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null;
  const worstTrade = state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null;

  const legPayload = (side) => {
    const w = state.watch[side];
    if (!w) return null;
    return {
      side, symbol: w.symbol, strike: w.strike, moneyness: w.moneyness,
      selLtp: w.selLtp, dist: w.dist, ltp: w.ltp, high: w.high, low: w.low,
      ltpAgeSec: w.ltpAt ? Math.round((Date.now() - w.ltpAt) / 1000) : null,
      above: strategy._px(w.ltp) ? w.ltp > cfg.triggerPremium : null,
      sustain: state.sustain[side] || 0,
    };
  };

  const sel = state.selection;
  res.json({
    running: state.running, sessionPnl: state.sessionPnl, tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50), log: state.log.slice(-200),
    decisions: state.decisions.slice(-120),
    tickCount: state.tickCount, lastTickPrice: state.lastTickPrice,
    sessionStart: state.sessionStart,
    optionLtp: state.optionLtp, optionLtpAgeSec: optAge, quoteStale: !!state.quoteStale,
    wins, losses, winRate, bestTrade, worstTrade, cumPnl, livePnl,
    weeklyPnl: weeklyPnl(),
    nowIstMins: getISTMinutes(),
    // SIMPLE_9:30 context
    selection: sel ? {
      atTime: sel.atTime, spot: sel.spot, atm: sel.atm,
      expiryCode: sel.expiryCode, expiryDate: sel.expiryDate,
      quoted: sel.quoted, ladderSize: sel.ladderSize,
      late: sel.late,
      candidates: sel.candidates.slice(0, 24),
      missing: sel.notes ? sel.notes.missing : [],
      rejected: sel.notes ? sel.notes.rejected : [],
    } : null,
    selectionPending: !sel && state.running,
    ce: legPayload("CE"),
    pe: legPayload("PE"),
    lastTriggerNote: state.lastTriggerNote,
    inEntryWindow: strategy.inEntryWindow(getISTMinutes(), cfg),
    dayClosed: state.dayClosed, dayClosedReason: state.dayClosedReason,
    stopOuts: state.stopOuts, maxDailyTrades: _maxDailyTrades(), maxDailyLoss: _maxDailyLoss(),
    cfg: {
      trigger: cfg.triggerPremium, bandUp: cfg.bandUp, bandDown: cfg.bandDown,
      slPts: cfg.slPts, trailPts: cfg.trailPts, trailEnabled: cfg.trailEnabled,
      selectionTime: strategy._fmtMins(cfg.selectionMin),
      entryStart: strategy._fmtMins(cfg.entryStartMin),
      entryEnd: strategy._fmtMins(cfg.entryEndMin),
      sideways: strategy._fmtMins(cfg.sidewaysMin),
      forcedExit: strategy._fmtMins(cfg.forcedExitMin),
      scanItm: cfg.scanItmStrikes, scanOtm: cfg.scanOtmStrikes,
      sustainPolls: cfg.sustainPolls, maxPremiumDist: cfg.maxPremiumDist, minPremium: cfg.minPremium,
      pollMs: _pollMs(), qty: simpleLotQty(), broker: "zerodha",
    },
    position: pos ? {
      side: pos.side, symbol: pos.symbol, optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry,
      optionEntryLtp: pos.optionEntryLtp, currentOptLtp: state.optionLtp,
      stop: pos.stop, initialStop: pos.initialStop, trailMoves: pos.trailMoves,
      peak: pos.peak, trough: pos.trough,
      bandUp: pos.bandUp, bandDown: pos.bandDown, expanded: pos.expanded, expandedAt: pos.expandedAt,
      qty: pos.qty, entryTime: pos.entryTime,
      heldSec: Math.round((Date.now() - pos.entryTimeMs) / 1000),
      riskPts: pos.slPts,
    } : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

// ── The page ─────────────────────────────────────────────────────────────────
router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getSimple930Mode() === "SIMPLE930_LIVE";
  const data = loadData();
  const cfg  = strategy.getConfig();

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const startCap = _startCapital();

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SIMPLE_9:30 — Paper</title>${faviconLink()}
<style>${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.s930-card{background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;margin-bottom:18px;}
.s930-hdr{font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.s930-row{display:flex;gap:18px;flex-wrap:wrap;font-size:0.78rem;color:#e2e8f0;}
.s930-row .k{color:var(--muted-1,#8ba1c2);margin-right:5px;}
.legs{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;}
.leg{background:#070d1a;border:1px solid #16203a;border-radius:9px;padding:12px 14px;}
.leg.armed{border-color:#10b981;box-shadow:0 0 0 1px rgba(16,185,129,0.25) inset;}
.leg.held{border-color:#f59e0b;box-shadow:0 0 0 1px rgba(245,158,11,0.3) inset;}
.leg h4{font-size:0.82rem;color:#e2e8f0;margin:0 0 8px;display:flex;justify-content:space-between;align-items:center;gap:6px;}
.leg .px{font-size:1.35rem;font-weight:600;letter-spacing:-0.02em;}
.leg .sub{font-size:0.7rem;color:var(--muted-1,#8ba1c2);margin-top:4px;}
.pill{font-size:0.6rem;padding:2px 7px;border-radius:99px;border:1px solid;text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap;}
.pill.up{background:rgba(16,185,129,0.14);color:#10b981;border-color:rgba(16,185,129,0.35);}
.pill.dn{background:rgba(148,163,184,0.12);color:#94a3b8;border-color:rgba(148,163,184,0.3);}
.pill.hold{background:rgba(245,158,11,0.14);color:#f59e0b;border-color:rgba(245,158,11,0.35);}
.tbl{width:100%;border-collapse:collapse;font-size:0.72rem;}
.tbl th{text-align:left;color:var(--muted-1,#8ba1c2);font-weight:600;padding:6px 8px;border-bottom:1px solid #1a2236;text-transform:uppercase;letter-spacing:0.04em;font-size:0.62rem;white-space:nowrap;}
.tbl td{padding:5px 8px;border-bottom:1px solid #101b30;color:#cbd5e1;white-space:nowrap;}
.tbl tr.pick td{background:rgba(16,185,129,0.08);color:#e2e8f0;font-weight:600;}
.scroll-x{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.dec{font-size:0.73rem;border-left:2px solid #1e293b;padding:6px 0 6px 10px;margin-bottom:2px;color:#cbd5e1;}
.dec .t{color:var(--muted-1,#8ba1c2);margin-right:8px;font-variant-numeric:tabular-nums;}
.dec .kind{font-size:0.58rem;padding:1px 6px;border-radius:4px;margin-right:8px;letter-spacing:0.05em;}
.dec-PLAN .kind{background:#1e293b;color:#94a3b8;}   .dec-PLAN{border-left-color:#334155;}
.dec-SCAN .kind{background:#0c4a6e;color:#7dd3fc;}   .dec-SCAN{border-left-color:#0284c7;}
.dec-ENTRY .kind{background:#064e3b;color:#6ee7b7;}  .dec-ENTRY{border-left-color:#10b981;}
.dec-TRAIL .kind{background:#1e3a8a;color:#93c5fd;}  .dec-TRAIL{border-left-color:#3b82f6;}
.dec-BAND .kind{background:#3b0764;color:#d8b4fe;}   .dec-BAND{border-left-color:#a855f7;}
.dec-EXIT .kind{background:#7f1d1d;color:#fca5a5;}   .dec-EXIT{border-left-color:#ef4444;}
.dec-SKIP .kind{background:#78350f;color:#fcd34d;}   .dec-SKIP{border-left-color:#f59e0b;}
.dec-DAY .kind{background:#334155;color:#cbd5e1;}    .dec-DAY{border-left-color:#64748b;}
.dec pre{margin:4px 0 0;font-size:0.64rem;color:#7d90ad;white-space:pre-wrap;word-break:break-word;}
.chart-box{background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
@media(max-width:900px){ .charts{grid-template-columns:1fr;} }
</style>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
</head><body>
${buildSidebar('simple930Paper', liveActive)}
<div class="main-content">
${bbRsiTopBar({
  title: "🎯 SIMPLE_9:30 — Paper",
  metaLine: `${strategy.describePlan(cfg)} · orders → Zerodha`,
  running: state.running,
  primaryAction: { href: "/simple930-paper/start", label: "▶ Start", color: "#0369a1" },
  stopAction:    { href: "/simple930-paper/stop",  label: "■ Stop" },
  historyHref: "/simple930-paper/history",
})}

${bbRsiCapitalStrip({ starting: startCap, current: startCap + (data.totalPnl || 0), allTime: data.totalPnl || 0 })}

<div class="s930-card">
  <div class="s930-hdr"><span>The day's plan</span><span id="s930-clock" style="color:#94a3b8;text-transform:none;letter-spacing:0;">—</span></div>
  <div class="s930-row">
    <div><span class="k">Select</span>${strategy._fmtMins(cfg.selectionMin)}</div>
    <div><span class="k">Entry window</span>${strategy._fmtMins(cfg.entryStartMin)} – ${strategy._fmtMins(cfg.entryEndMin)}</div>
    <div><span class="k">Trigger</span>₹${cfg.triggerPremium}</div>
    <div><span class="k">Stop</span>${cfg.slPts}pt off the fill</div>
    <div><span class="k">Trail</span>${cfg.trailEnabled ? `${cfg.trailPts}pt` : "OFF"}</div>
    <div><span class="k">Sideways box</span>₹${cfg.bandDown} – ₹${cfg.bandUp} @ ${strategy._fmtMins(cfg.sidewaysMin)}</div>
    <div><span class="k">EOD</span>${strategy._fmtMins(cfg.forcedExitMin)}</div>
    <div><span class="k">Qty</span>${simpleLotQty()}</div>
  </div>
  <div id="s930-day" style="font-size:0.72rem;color:#f59e0b;margin-top:8px;">${state.dayClosed ? `⏸️ ${state.dayClosedReason}` : ""}</div>
</div>

<div class="s930-card">
  <div class="s930-hdr"><span>Watchlist — the two legs picked at ${strategy._fmtMins(cfg.selectionMin)}</span><span id="s930-sel" style="text-transform:none;letter-spacing:0;color:#94a3b8;">—</span></div>
  <div class="legs" id="s930-legs"><div style="color:var(--muted-1,#8ba1c2);font-size:0.78rem;">Waiting for ${strategy._fmtMins(cfg.selectionMin)} — the ladder has not been quoted yet.</div></div>
  <div id="s930-trigger" style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-top:10px;"></div>
</div>

${bbRsiStatGrid([
  { label: "Session P&L", value: inr(state.sessionPnl), color: state.sessionPnl >= 0 ? "#10b981" : "#ef4444" },
  { label: "Trades", value: `${state.tradesTaken}/${_maxDailyTrades()}` },
  { label: "W / L", value: `${wins} / ${losses}` },
  { label: "Trigger", value: `₹${cfg.triggerPremium}` },
  { label: "Sideways box", value: `₹${cfg.bandDown}–₹${cfg.bandUp}` },
  { label: "NIFTY", value: state.lastTickPrice != null ? String(state.lastTickPrice) : "—" },
])}

<div id="pos-card" style="margin-bottom:18px;">${_positionCardHtml(state.position, state.optionLtp)}</div>

<div class="s930-card">
  <div class="s930-hdr"><span>09:25 ladder — every strike quoted, nearest ₹${cfg.triggerPremium} first</span></div>
  <div class="scroll-x"><table class="tbl" id="s930-ladder"><tbody><tr><td style="color:var(--muted-1,#8ba1c2);">Not quoted yet.</td></tr></tbody></table></div>
</div>

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">Option premium charts — the ONLY charts a rule reads (trigger, band, stop)</div>
  <div class="charts">
    <div class="chart-box" style="height:300px;"><div id="chartCE" style="width:100%;height:100%;"></div>
      <div style="position:absolute;top:8px;left:12px;font-size:0.66rem;color:#8ba1c2;pointer-events:none;z-index:2;" id="lblCE">CE —</div></div>
    <div class="chart-box" style="height:300px;"><div id="chartPE" style="width:100%;height:100%;"></div>
      <div style="position:absolute;top:8px;left:12px;font-size:0.66rem;color:#8ba1c2;pointer-events:none;z-index:2;" id="lblPE">PE —</div></div>
  </div>
</div>

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">NIFTY 50 INDEX ${PREMIUM_BAR_MIN}m — context only (the ATM strike came from it at ${strategy._fmtMins(cfg.selectionMin)}; no rule reads it)</div>
  <div class="chart-box" style="height:220px;"><div id="idxchart" style="width:100%;height:100%;"></div></div>
</div>

<div class="s930-card">
  <div class="s930-hdr"><span>Decision trail — every choice the engine made today</span>
    <a href="/simple930-paper/download/decisions.json" style="font-size:0.66rem;color:#38bdf8;text-decoration:none;text-transform:none;letter-spacing:0;">⬇ download JSON</a></div>
  <div id="s930-decisions" style="max-height:340px;overflow-y:auto;"><div style="color:var(--muted-1,#8ba1c2);font-size:0.75rem;">Nothing decided yet.</div></div>
</div>

${bbRsiActivityLog({ logsJSON: JSON.stringify(state.log.slice(-300)) })}
</div>
<script>
${modalJS()}
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function legCard(d, leg, side) {
  if (!leg) return '<div class="leg"><h4>' + side + ' <span class="pill dn">not watched</span></h4>' +
    '<div class="sub">No usable strike on this side — see the decision trail.</div></div>';
  var held = d.position && d.position.side === side;
  var cls  = held ? 'leg held' : (leg.above ? 'leg armed' : 'leg');
  var pill = held ? '<span class="pill hold">holding</span>'
           : (leg.above ? '<span class="pill up">above ₹' + d.cfg.trigger + '</span>' : '<span class="pill dn">below ₹' + d.cfg.trigger + '</span>');
  var col  = leg.above ? '#10b981' : '#e2e8f0';
  return '<div class="' + cls + '">' +
    '<h4><span>' + side + ' ' + leg.strike + ' <span style="color:#64748b;font-weight:400;">' + esc(leg.moneyness || '') + '</span></span>' + pill + '</h4>' +
    '<div class="px" style="color:' + col + ';">₹' + (leg.ltp != null ? leg.ltp.toFixed(2) : '—') + '</div>' +
    '<div class="sub">picked @ ₹' + (leg.selLtp != null ? leg.selLtp.toFixed(2) : '—') +
      ' · ₹' + (leg.dist != null ? leg.dist.toFixed(2) : '—') + ' from ₹' + d.cfg.trigger + '</div>' +
    '<div class="sub">day range ₹' + (leg.low != null ? leg.low.toFixed(2) : '—') + ' – ₹' + (leg.high != null ? leg.high.toFixed(2) : '—') +
      (leg.ltpAgeSec != null ? ' · quote ' + leg.ltpAgeSec + 's old' : '') +
      (d.cfg.sustainPolls > 1 ? ' · held above ' + leg.sustain + '/' + d.cfg.sustainPolls : '') + '</div>' +
    '<div class="sub" style="word-break:break-all;">' + esc(leg.symbol) + '</div>' +
    '</div>';
}
function renderLadder(d) {
  var el = document.getElementById('s930-ladder');
  if (!el) return;
  var sel = d.selection;
  if (!sel || !sel.candidates || !sel.candidates.length) {
    el.innerHTML = '<tbody><tr><td style="color:#8ba1c2;">' + (d.selectionPending ? 'Waiting for ' + d.cfg.selectionTime + ' — the ladder has not been quoted yet.' : 'Not quoted.') + '</td></tr></tbody>';
    return;
  }
  var picks = {};
  if (d.ce) picks[d.ce.symbol] = 1;
  if (d.pe) picks[d.pe.symbol] = 1;
  var head = '<thead><tr><th>Side</th><th>Strike</th><th>Moneyness</th><th>Premium @ ' + d.cfg.selectionTime + '</th><th>Distance from ₹' + d.cfg.trigger + '</th><th>Picked</th></tr></thead>';
  var rows = sel.candidates.map(function(c){
    var isPick = !!picks[c.symbol];
    return '<tr class="' + (isPick ? 'pick' : '') + '"><td>' + c.side + '</td><td>' + c.strike + '</td><td>' + esc(c.moneyness || '') +
      '</td><td>₹' + Number(c.ltp).toFixed(2) + '</td><td>₹' + Number(c.dist).toFixed(2) + '</td><td>' + (isPick ? '✔' : '') + '</td></tr>';
  }).join('');
  var miss = (sel.missing || []).length ? '<tr><td colspan="6" style="color:#f59e0b;">No premium returned for: ' +
    sel.missing.map(function(m){ return m.strike + m.side; }).join(', ') + '</td></tr>' : '';
  var rej = (sel.rejected || []).map(function(r){
    return '<tr><td colspan="6" style="color:#f59e0b;">' + esc(r.side || '') + ' ' + esc(r.strike || '') + ' — ' + esc(r.why) + '</td></tr>';
  }).join('');
  el.innerHTML = head + '<tbody>' + rows + miss + rej + '</tbody>';
}
function renderDecisions(d) {
  var el = document.getElementById('s930-decisions');
  if (!el) return;
  var rows = d.decisions || [];
  if (!rows.length) { el.innerHTML = '<div style="color:#8ba1c2;font-size:0.75rem;">Nothing decided yet.</div>'; return; }
  el.innerHTML = rows.slice().reverse().map(function(r){
    var det = r.detail ? '<pre>' + esc(JSON.stringify(r.detail)) + '</pre>' : '';
    return '<div class="dec dec-' + esc(r.kind) + '"><span class="t">' + esc(r.ist) + '</span>' +
      '<span class="kind">' + esc(r.kind) + '</span>' + esc(r.headline) + det + '</div>';
  }).join('');
}
function renderPos(d) {
  var el = document.getElementById('pos-card');
  if (!el) return;
  var p = d.position;
  if (!p) { el.innerHTML = '<div class="s930-card" style="margin-bottom:0;color:#8ba1c2;font-size:0.78rem;">No open position.</div>'; return; }
  var live = (p.currentOptLtp != null) ? ((p.currentOptLtp - p.optionEntryLtp) * p.qty) : null;
  var staleWarn = d.quoteStale
    ? '<div style="background:#7f1d1d;border:1px solid #ef4444;border-radius:6px;padding:8px 10px;margin-bottom:8px;color:#fecaca;font-size:0.72rem;">' +
      '\u{1F6A8} Premium feed STALE (' + (d.optionLtpAgeSec != null ? d.optionLtpAgeSec + 's old' : 'unknown age') +
      ') \u2014 the stop cannot fire on a frozen price. Check the Fyers feed; square off manually if it does not recover.</div>'
    : '';
  el.innerHTML = '<div class="s930-card" style="margin-bottom:0;border-color:' + (d.quoteStale ? '#ef4444' : '#f59e0b') + ';">' + staleWarn +
    '<div class="s930-hdr"><span>Open position — ' + esc(p.side) + ' ' + p.optionStrike + '</span>' +
      '<span style="text-transform:none;letter-spacing:0;color:' + (live >= 0 ? '#10b981' : '#ef4444') + ';">' +
      (live != null ? '₹' + Math.round(live).toLocaleString('en-IN') : '—') + '</span></div>' +
    '<div class="s930-row">' +
      '<div><span class="k">Entry</span>₹' + p.optionEntryLtp + '</div>' +
      '<div><span class="k">Now</span>₹' + (p.currentOptLtp != null ? Number(p.currentOptLtp).toFixed(2) : '—') + '</div>' +
      '<div><span class="k">Stop</span>₹' + p.stop + (p.trailMoves ? ' (trailed ×' + p.trailMoves + ')' : ' (initial)') + '</div>' +
      '<div><span class="k">Peak / trough</span>₹' + p.peak + ' / ₹' + p.trough + '</div>' +
      '<div><span class="k">Box ₹' + p.bandDown + '–₹' + p.bandUp + '</span>' + (p.expanded ? 'BROKEN — trade runs on the trail' : 'still inside → exits at ' + d.cfg.sideways) + '</div>' +
      '<div><span class="k">Qty</span>' + p.qty + '</div>' +
      '<div><span class="k">Held</span>' + p.heldSec + 's</div>' +
    '</div></div>';
}
async function s930Refresh() {
  try {
    const r = await fetch('/simple930-paper/status/data', { cache: 'no-store' });
    const d = await r.json();
    var legs = document.getElementById('s930-legs');
    if (legs) {
      if (!d.ce && !d.pe) {
        legs.innerHTML = '<div style="color:#8ba1c2;font-size:0.78rem;">' +
          (d.selectionPending ? 'Waiting for ' + d.cfg.selectionTime + ' — the ladder has not been quoted yet.' : 'No watchlist for today.') + '</div>';
      } else {
        legs.innerHTML = legCard(d, d.ce, 'CE') + legCard(d, d.pe, 'PE');
      }
    }
    var selEl = document.getElementById('s930-sel');
    if (selEl) selEl.textContent = d.selection
      ? (d.selection.atTime + ' · NIFTY ' + d.selection.spot + ' → ATM ' + d.selection.atm + ' · ' + d.selection.expiryCode + ' · ' + d.selection.quoted + '/' + d.selection.ladderSize + ' rungs quoted' + (d.selection.late ? ' · LATE' : ''))
      : (d.selectionPending ? 'pending' : '—');
    var tg = document.getElementById('s930-trigger');
    if (tg) tg.textContent = d.position ? '' : (d.lastTriggerNote || '');
    var dayEl = document.getElementById('s930-day');
    if (dayEl) dayEl.textContent = d.dayClosed ? '⏸️ ' + d.dayClosedReason : '';
    var ck = document.getElementById('s930-clock');
    if (ck) ck.textContent = (d.inEntryWindow ? 'ENTRY WINDOW OPEN' : 'entry window closed') + ' · NIFTY ' + (d.lastTickPrice != null ? d.lastTickPrice : '—') + ' · ' + d.tickCount + ' ticks';
    renderLadder(d); renderDecisions(d); renderPos(d);
  } catch (e) {}
}
s930Refresh();
setInterval(s930Refresh, 3000);
</script>
<script>
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  function mk(el) {
    if (!el) return null;
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
  var els = { CE: document.getElementById('chartCE'), PE: document.getElementById('chartPE') };
  var idxEl = document.getElementById('idxchart');
  var charts = {}, series = {}, lines = { CE: [], PE: [] };
  ['CE','PE'].forEach(function(s){
    charts[s] = mk(els[s]);
    if (charts[s]) series[s] = charts[s].addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  });
  var ichart = mk(idxEl);
  var ics = ichart ? ichart.addCandlestickSeries({ upColor:'#334155', downColor:'#475569', borderUpColor:'#475569', borderDownColor:'#475569', wickUpColor:'#475569', wickDownColor:'#475569' }) : null;
  function addLine(side, price, color, title, style) {
    if (price == null || !isFinite(price) || !series[side]) return;
    lines[side].push(series[side].createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title }));
  }
  async function fetchChart(){
    try {
      var r = await fetch('/simple930-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      ['CE','PE'].forEach(function(s){
        var leg = d[s.toLowerCase()];
        var lbl = document.getElementById('lbl' + s);
        if (!series[s]) return;
        if (!leg) { if (lbl) lbl.textContent = s + ' — not watched'; return; }
        if (lbl) lbl.textContent = s + ' ' + leg.strike + '  ₹' + (leg.ltp != null ? Number(leg.ltp).toFixed(2) : '—') + (leg.held ? '  ● HOLDING' : '');
        if (leg.bars && leg.bars.length) series[s].setData(leg.bars);
        if (leg.markers && leg.markers.length) series[s].setMarkers(leg.markers.slice().sort(function(a,b){return a.time-b.time;}));
        lines[s].forEach(function(l){ try { series[s].removePriceLine(l); } catch(_){} });
        lines[s] = [];
        addLine(s, d.trigger,  '#38bdf8', 'Trigger ' + d.trigger, LightweightCharts.LineStyle.Solid);
        addLine(s, d.bandUp,   '#a855f7', 'Box top ' + d.bandUp, LightweightCharts.LineStyle.Dashed);
        addLine(s, d.bandDown, '#a855f7', 'Box floor ' + d.bandDown, LightweightCharts.LineStyle.Dashed);
        addLine(s, leg.entry,  '#94a3b8', 'Entry', LightweightCharts.LineStyle.Dotted);
        addLine(s, leg.stop,   '#ef4444', 'Stop', LightweightCharts.LineStyle.Solid);
      });
      if (ics && d.indexCandles && d.indexCandles.length) ics.setData(d.indexCandles);
    } catch(e) {}
  }
  fetchChart();
  setInterval(fetchChart, 4000);
  window.addEventListener('resize', function(){
    ['CE','PE'].forEach(function(s){ if (charts[s] && els[s]) charts[s].applyOptions({ width: els[s].clientWidth }); });
    if (ichart && idxEl) ichart.applyOptions({ width: idxEl.clientWidth });
  });
})();
</script>
</body></html>`;
  res.send(html);
});

function _positionCardHtml(pos, optLtp) {
  if (!pos) {
    return `<div class="s930-card" style="margin-bottom:0;color:var(--muted-1,#8ba1c2);font-size:0.78rem;">No open position.</div>`;
  }
  const live = strategy._px(optLtp) ? ((optLtp - pos.optionEntryLtp) * pos.qty).toFixed(0) : "—";
  return `<div class="s930-card" style="margin-bottom:0;border-color:#f59e0b;">
  <div class="s930-hdr"><span>Open position — ${pos.side} ${pos.optionStrike}</span><span style="text-transform:none;letter-spacing:0;">₹${live}</span></div>
  <div class="s930-row">
    <div><span class="k">Entry</span>₹${pos.optionEntryLtp}</div>
    <div><span class="k">Stop</span>₹${pos.stop}</div>
    <div><span class="k">Peak / trough</span>₹${pos.peak} / ₹${pos.trough}</div>
    <div><span class="k">Qty</span>${pos.qty}</div>
  </div>
</div>`;
}

// ── History + daily-file viewers + restore + reset ───────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = sharedSocketState.getSimple930Mode() === "SIMPLE930_LIVE";
  res.send(renderHistoryPage({
    routePrefix: "/simple930-paper",
    sidebarKey: "simple930History",
    pageTitle: "🎯 SIMPLE_9:30 Paper Trade History",
    pageDocTitle: "SIMPLE_9:30 Paper — History",
    modalLabel: "SIMPLE_9:30 Paper",
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap: _startCapital(),
    emptyLabel: "Start SIMPLE_9:30 paper trading to record your first session.",
  }));
});

const _DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/download/daily-files", (req, res) => {
  const skips  = skipLogger.listDates(MODE_KEY);
  const trades = tradeLogger.listDailyDates(MODE_KEY);
  const byDate = new Map();
  for (const s of skips)  byDate.set(s.date, { date: s.date, skipsSize: s.size, tradesSize: 0 });
  for (const t of trades) { const row = byDate.get(t.date) || { date: t.date, skipsSize: 0, tradesSize: 0 }; row.tradesSize = t.size; byDate.set(t.date, row); }
  const rows = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  res.json(dailyFilesPaginate(rows, req.query));
});

/** The live decision trail, for offline reading. Session-scoped, not historical. */
router.get("/download/decisions.json", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="simple930_decisions_${today}.json"`);
  res.send(JSON.stringify({
    strategy: strategy.NAME,
    sessionStart: state.sessionStart,
    config: strategy.getConfig(),
    selection: state.selection,
    decisions: state.decisions,
    log: state.log,
    trades: state.sessionTrades,
  }, null, 2));
});

router.get("/download/skips-all", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="simple930_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates(MODE_KEY).map(d => d.date).sort();
  let body = "";
  for (const d of dates) { try { const p = skipLogger.filePathFor(MODE_KEY, d); if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8"); } catch (_) {} }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `simple930_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `simple930_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop SIMPLE_9:30 paper trading first before deleting a session." });
  const data = loadData();
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= (data.sessions || []).length) return res.status(400).json({ success: false, error: "Invalid session index." });
  data.sessions.splice(idx, 1);
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((_startCapital() + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, message: "Session deleted successfully." });
});

router.post("/restore-session/:date", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop SIMPLE_9:30 paper trading before restoring." });
  const date = String(req.params.date || "").trim();
  if (!_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades(MODE_KEY, date).filter(t => t && !t.type);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const keyOf = (t) => String(t.entryTimeMs || t.entryTime || `${t.symbol}@${t.optionEntryLtp}@${t.entryTime}`);
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) seen.add(keyOf(t));
  const missing = allTrades.filter(t => !seen.has(keyOf(t)));
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
  data.sessions.push({ date, strategy: (missing[0] && missing[0].strategy) || strategy.NAME, pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((_startCapital() + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop SIMPLE_9:30 paper trading before resetting." });
  const fresh = _startCapital();
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  return res.json({ success: true, message: `SIMPLE_9:30 paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
});

router.get("/download/trades.jsonl", (req, res) => {
  try {
    const data = loadData();
    const records = [];
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) records.push(Object.assign({ date: s.date, mode: MODE_KEY, strategy: s.strategy }, t));
    const today = new Date().toISOString().slice(0, 10);
    const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
    if (ai) {
      const md = aiExport.buildMarkdown(records, { title: "SIMPLE_9:30 paper trades (full log)", source: "simple930-paper" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="simple930_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="simple930_paper_trades_${today}.jsonl"`);
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
a{color:#3b82f6;text-decoration:none;border:0.5px solid #0e1e36;padding:8px 14px;border-radius:6px;}
@media(max-width:768px){body{padding:24px 14px;}a{min-height:44px;display:inline-flex;align-items:center;justify-content:center;}}</style>
</head><body><h2>${title}</h2><p>${message}</p><a href="${backHref}">${backLabel}</a></body></html>`;
}

module.exports = router;
module.exports.stopSession = stopSession;
// Exposed for offline unit-testing — this decides which number every entry and
// every exit is measured against, so it is tested rather than trusted.
module.exports.attributeQuotes = attributeQuotes;

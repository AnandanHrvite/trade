/**
 * EARLYBIRD PAPER — /early-bird-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL surface for EARLYBIRD. Every decision / fill / exit semantic lives
 * in src/strategies/early_bird.js and is CALLED from here — this file
 * re-implements no rule, computes no indicator and compares no threshold of its
 * own (see feedback_paper_logic_untouchable). Read that engine's header first;
 * it is the strategy.
 *
 * ── WHAT THIS ROUTE IS, IN ONE PARAGRAPH ────────────────────────────────────
 * At 09:30 (once, and only once, per day) it fetches the day's first 15-minute
 * candle for NIFTY and for every symbol in the EARLYBIRD_UNIVERSE preset, plus
 * each symbol's PREVIOUS DAILY CLOSE (the 2% gap rule needs it). It hands the
 * lot to earlyBird.buildDayPlan(), which decides whether the day is a LONG day
 * or a SHORT day and which stocks confirmed. Each confirming stock becomes a
 * PENDING SETUP with frozen entry / stop / target levels. From then on the
 * route only executes: a pending setup fills the first time its stock trades
 * through the entry LEVEL, and an open position exits on its stop, its target
 * or the 13:00 square-off.
 *
 * ── WHAT GETS TRADED — EARLYBIRD_TRADE_MODE ─────────────────────────────────
 * The default, and everything described above, is the STOCK leg:
 *
 *   "stock"  (DEFAULT) — NIFTY signal + stock confirmation, traded in CASH
 *              EQUITY. Qty is a flat share count (EARLYBIRD_QTY, default 100).
 *              A SHORT is a real intraday short sale in the cash segment and
 *              profits when the price FALLS. NIFTY is never traded — the index
 *              only decides the day's direction. In this mode NOT ONE line of
 *              the option code below executes.
 *
 *   "option" — ONE NIFTY CE/PE bought off NIFTY's OWN opening candle, with
 *              **no stock confirmation of any kind**. No stock is scanned,
 *              checked or traded, and the ~220-symbol history fetch is skipped
 *              entirely (that speed is the whole point of the mode).
 *
 *   "both"   — the two legs run AT ONCE and INDEPENDENTLY. The option leg fires
 *              even when zero stocks confirm, because it never needed them.
 *
 * ── THE OPTION LEG, IN ONE PARAGRAPH ────────────────────────────────────────
 * earlyBird.buildNiftyOptionSetup() reads entry / stop / target off NIFTY's
 * 09:15 candle exactly as a stock's are read off its own. EVERY ONE OF THOSE IS
 * A NIFTY SPOT LEVEL — the trigger, the stop and the 1:2 target are all tested
 * against SPOT, never against the premium, which is what keeps the option leg
 * comparable to the stock leg and reproducible in Replay. Spot arrives on the
 * shared NIFTY tick feed (onTick). The premium is fetched only twice — once to
 * price the entry, once to price the exit — and P&L is
 * (exitPremium − entryPremium) × qty for the BOUGHT option, so a bought PE
 * PROFITS when spot falls. earlyBird.computePnl() is NOT used for it: that one
 * is cash-equity and direction-signed, and would report a PE win as a loss.
 * One option trade per day, no re-entry, tracked in `state.optionPosition` —
 * deliberately NOT in `state.positions`, so it never consumes a slot of the
 * EARLYBIRD_MAX_CONCURRENT cap, which sizes STOCK exposure.
 *
 * ── MULTIPLE POSITIONS AT ONCE ──────────────────────────────────────────────
 * Unlike every other paper route here, this one holds up to
 * EARLYBIRD_MAX_CONCURRENT (default 5) positions simultaneously. State is
 * therefore `state.positions` — a Map keyed by the plain NSE symbol — and
 * `state.pending`, a Map of setups still waiting for their trigger. There is no
 * `state.position` singular anywhere, deliberately: renaming it would have left
 * every `if (state.position)` guard silently meaning "if ANY position is open",
 * which is the wrong question for almost all of them.
 *
 * ── PRICE FEED — WHY A QUOTE POLL AND NOT THE SOCKET ────────────────────────
 * The repo invariant is one Fyers socket, ever. socketManager DOES expose
 * subscribeExtra(), but it is built for a handful of NIFTY OPTION contracts:
 * it refuses until it has learnt which symbol the spot ticks carry, and it
 * DISABLES extras for the whole session after a short run of unattributable
 * ticks. Pushing 5–20 equity symbols (let alone the ~220-name universe) through
 * that would risk tripping the bail-out and taking the shared spot feed's
 * option multiplexing down for every other strategy in the process.
 *
 * So EARLYBIRD polls REST quotes for the SHORTLIST only — the plan's candidates
 * plus anything currently open, at most a couple of dozen symbols, chunked
 * EARLYBIRD_QUOTE_CHUNK at a time — every EARLYBIRD_POLL_MS (default 2000ms).
 * After 09:30 those are the only symbols whose price can matter. The shared
 * socket is still joined, but ONLY for the NIFTY heartbeat and tick count; no
 * EarlyBird decision reads it.
 *
 * A failed quote fetch is loud and retried, never silent: the per-symbol
 * price carries an age, a stale price stops being used for exits after
 * EARLYBIRD_QUOTE_STALE_SEC, and the failure streak is logged and surfaced on
 * the status page. A position is never frozen with no price and no warning.
 *
 * ── VERBOSE BY REQUEST ──────────────────────────────────────────────────────
 * The user asked to see "all the small small things" on screen and in the logs.
 * The whole 09:30 funnel is logged line by line — NIFTY's candle and verdict,
 * every accepted candidate with its levels, every rejection with its reason,
 * plus a grouped count per reason so ~220 lines stay readable — and the same
 * data is served to an on-screen scan table. Every trigger, fill and exit is
 * logged with the running open-position count.
 *
 * Endpoints: /start /stop /exit /status /status/data /status/chart-data
 *            /history /reset /restore-session/:date /session/:index
 *            /download/... /view/...
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const earlyBird          = require("../strategies/early_bird");
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
const { getUniverse, fyersSymbol, plainSymbol } = require("../utils/stockUniverse");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getISTMinutes } = require("../utils/tradeUtils");
const skipLogger  = require("../utils/skipLogger");
const capitalPool = require("../utils/capitalPool");
// OPTION LEG ONLY (EARLYBIRD_TRADE_MODE=option|both). The default "stock" mode
// never reaches a single line that uses either of these — see the OPTION LEG
// block below. They are required at the top rather than lazily so a missing
// module fails at boot, not at 09:30 on the one day the mode is switched on.
const instrumentConfig = require("../config/instrument");
const { getCharges }   = require("../utils/charges");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "earlyBirdPaper";
const MODE_KEY           = "early_bird";     // tradeLogger / skipLogger / capitalPool key
const LOG_TAG            = "[EARLYBIRD-PAPER]";
const STRATEGY_NAME      = "EARLYBIRD";

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "early_bird_paper_trades.json");

// ── Config readers (Settings mutates process.env live — never cache) ─────────

// These take the RAW env VALUE, not a key name, so every call site spells its
// key out literally as `process.env.EARLYBIRD_X`. That is deliberate:
// docs/ENV.md is generated by scanning src/ for literal `process.env.KEY`
// reads, so a computed `process.env[key]` lookup makes the key INVISIBLE to the
// generator and it ships undocumented and unchecked. Same reason
// services/swingScanner.js spells its rate-limit keys out.
function _intEnv(raw, def, min, max) {
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v)) return def;
  if (min != null && v < min) return def;
  if (max != null && v > max) return def;
  return v;
}
function _floatEnv(raw, def) {
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : def;
}

function _pollMs()          { return _intEnv(process.env.EARLYBIRD_POLL_MS, 2000, 500, 30000); }
function _historyLagMs()    { return _intEnv(process.env.EARLYBIRD_HISTORY_LAG_MS, 5000, 0, 120000); }
/** Calendar days of daily history to reach back for the previous close. */
function _warmupDays()      { return _intEnv(process.env.EARLYBIRD_WARMUP_DAYS, 10, 3, 120); }
function _maxDailyTrades()  { return _intEnv(process.env.EARLYBIRD_MAX_DAILY_TRADES, 5, 1, 100); }
function _maxDailyLoss()    { return _floatEnv(process.env.EARLYBIRD_MAX_DAILY_LOSS, 5000); }
function _maxDailyLosses()  { return _intEnv(process.env.EARLYBIRD_MAX_DAILY_LOSSES, 3, 0, 100); }
function _dailyProfitLock() { return _floatEnv(process.env.EARLYBIRD_DAILY_PROFIT_LOCK, 0); }
function _maxWeeklyLoss()   { return _floatEnv(process.env.EARLYBIRD_MAX_WEEKLY_LOSS, 0); }
/** Symbols per getQuotes call. Fyers accepts a comma list; keep it modest. */
function _quoteChunk()      { return _intEnv(process.env.EARLYBIRD_QUOTE_CHUNK, 20, 1, 50); }
/** A quote older than this stops being used to test an exit. */
function _quoteStaleSec()   { return _intEnv(process.env.EARLYBIRD_QUOTE_STALE_SEC, 30, 5, 600); }
/** Concurrent history fetches during the 09:30 scan. */
function _scanConcurrency() { return _intEnv(process.env.EARLYBIRD_SCAN_CONCURRENCY, 4, 1, 12); }

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
    console.error(`${LOG_TAG} early_bird_paper_trades.json corrupt — resetting: ${e.message}`);
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
// MULTI-POSITION. `positions` and `pending` are Maps keyed by the plain NSE
// symbol ("RELIANCE"), which is also the natural per-symbol lock: one attempt
// per stock per day, enforced by `attempted`.
let state = _freshState();
function _freshState() {
  return {
    running:        false,
    sessionStart:   null,
    sessionTrades:  [],
    sessionPnl:     0,
    tradesTaken:    0,
    stopOuts:       0,

    // Multi-position bookkeeping
    positions:      new Map(),   // symbol -> open position
    pending:        new Map(),   // symbol -> setup awaiting its entry trigger
    attempted:      new Set(),   // symbols already entered today — no re-entry
    dropped:        [],          // setups that never triggered by the entry cut-off

    // The day's plan — built ONCE, at 09:30
    plan:           null,
    planBuiltAt:    null,
    planInFlight:   false,
    planAttempts:   0,
    planNextTryMs:  null,

    // ── OPTION LEG (EARLYBIRD_TRADE_MODE=option|both) ────────────────────────
    // Deliberately NOT inside `positions` / `pending`: those are the STOCK Maps,
    // and EARLYBIRD_MAX_CONCURRENT caps STOCK exposure. An option riding in that
    // Map would silently consume one of the five stock slots and would also be
    // priced by the equity quote poll, which is not where its premium comes from.
    optionSetup:     null,   // the frozen NIFTY-spot levels from the engine
    optionPending:   null,   // the same setup while it is still awaiting its trigger
    optionPosition:  null,   // the one open option position, or null
    optionAttempted: false,  // one option trade per day — no re-entry, ever
    optionDropped:   null,   // setup that never triggered by the entry cut-off
    optionLtp:       null,   // last premium seen (entry, then exit)
    optionEntryLock: false,  // in-flight guard: the entry has an unavoidable await
    optionLtpFailAt: null,   // last premium-fetch failure (ms) — throttles the retry
    optionLtpFails:  0,

    // Live prices for the shortlist: symbol -> { price, ts }
    prices:         new Map(),
    quoteFailures:  0,
    lastQuoteOkMs:  null,
    lastQuoteError: null,

    // NIFTY spot heartbeat (display + liveness only — no rule reads it)
    tickCount:      0,
    lastTickTime:   null,
    lastTickPrice:  null,

    log:            [],
    _sessionId:     null,
    dayClosed:      false,
    dayClosedReason: null,
    _staleSession:  false,
    _entryLocks:    new Set(),   // symbols with an entry in flight
  };
}

function log(msg) {
  const stamp = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  const line = `[${stamp}] ${msg}`;
  state.log.push(line);
  if (state.log.length > 1200) state.log.shift();   // the 09:30 funnel is ~220 lines
  console.log(line);
}

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

/**
 * Snapshot open positions + pending setups for crash recovery.
 *
 * The OPTION leg rides in `sessionMeta`, not in the two arrays: those are
 * normalised by positionPersist as arrays of CASH-EQUITY levels (`_ebLevels`
 * keeps `symbol`/`qty`/`entryPrice` and drops strike, expiry and premium), so an
 * option pushed in there would come back stripped of everything that makes it an
 * option. sessionMeta is stored verbatim, and an older file simply has no
 * `option*` keys — the loader's `if (!Array.isArray(...)) = []` normalisation is
 * untouched and old snapshots still load.
 */
function _persist() {
  try {
    const meta = { sessionPnl: state.sessionPnl, sessionId: state._sessionId };
    if (state.optionPosition)  meta.optionPosition  = state.optionPosition;
    if (state.optionPending)   meta.optionPending   = state.optionPending;
    if (state.optionAttempted) meta.optionAttempted = true;
    require("../utils/positionPersist").saveEarlyBirdPositions(
      Array.from(state.positions.values()),
      meta,
      Array.from(state.pending.values()),
    );
  } catch (_) {}
}

// ── Crash/restart recovery: rehydrate today's in-memory session from JSONL ────
function rehydrateSessionFromJsonl() {
  try {
    const data = loadData();
    const keyOf = (t) => String(t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`);
    const today = tradeLogger.istDateString(Date.now());
    const all = tradeLogger.readDailyTrades(MODE_KEY, today)
      .filter(t => t && !t.type && (t.side || t.entryTime || t.entryBarTime || t.symbol));
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
    state.stopOuts = trades.filter(t => String(t.exitType || "") === "SL").length;
    state.sessionPnl = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    if (!state.sessionStart) state.sessionStart = trades[0].entryTime || trades[0].loggedAt || null;
    // The two legs have separate "already traded" locks. A recovered OPTION
    // trade must set optionAttempted, or a restart would allow the day's second
    // option trade — the one rule that says there is never a re-entry. It is
    // matched on the `leg` field the option trade record carries, not on the
    // symbol, so a stock happening to be named like a contract cannot confuse it.
    let optRecovered = 0;
    for (const t of trades) {
      if (!t) continue;
      if (t.leg === "option") { state.optionAttempted = true; optRecovered++; continue; }
      if (t.symbol) state.attempted.add(String(t.symbol));
    }
    console.log(`♻️ ${LOG_TAG} Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl}, ${state.stopOuts} stop-out(s))${optRecovered ? `, including ${optRecovered} OPTION trade(s) — no option re-entry today` : ""}`);
  } catch (err) {
    console.warn(`${LOG_TAG} session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => state, LOG_TAG);

/**
 * Realised P&L for the current ISO week (Mon → today) from the per-day JSONL
 * logs. While RUNNING, today's contribution comes from the in-memory session;
 * when idle we must read the FILE, because state.sessionPnl may still hold a
 * rehydrated previous session.
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

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY FETCH — modelled on services/swingScanner.js
//
// Same shape as the scanner's fetch: bounded concurrency, one call per symbol
// per resolution, tolerant of a symbol answering with nothing. It goes through
// backtestEngine.fetchCandles (which chunks by Fyers' per-resolution day cap and
// filters intraday bars to the regular session) rather than re-implementing the
// chunking here. Concurrency is capped (EARLYBIRD_SCAN_CONCURRENCY, default 4)
// AND every call is paced through the two-window rate limiter below.
//
// WHY BOTH. swingScanner needed exactly this after a burst dropped 183 of 228
// symbols in one scan — Fyers answers a rate-limited request the same way it
// answers a delisted one (no data), so an over-fast scan does not error: it
// silently reports "no candle" for most of the universe and the day then looks
// legitimately signal-free. A concurrency cap alone does not prevent that,
// because each worker issues TWO calls (intraday + daily) via Promise.all, so a
// cap of 4 is really 8 in flight. That module's limiter is private to it, so
// this is the same algorithm re-stated here.
// ─────────────────────────────────────────────────────────────────────────────

async function _mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = [];
  const n = Math.max(1, Math.min(limit, items.length || 1));
  for (let i = 0; i < n; i++) {
    runners.push((async () => {
      for (;;) {
        const idx = next++;
        if (idx >= items.length) return;
        try { out[idx] = { ok: true, value: await worker(items[idx], idx) }; }
        catch (err) { out[idx] = { ok: false, error: err && err.message ? err.message : String(err) }; }
      }
    })());
  }
  await Promise.all(runners);
  return out;
}

function _todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function _daysAgoIST(n) {
  return new Date(Date.now() - n * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Today's intraday bars at the strategy resolution for one Fyers symbol. */
// ── Fyers history rate limiter (same algorithm as services/swingScanner.js) ──
// Two rolling windows, per-second and per-minute. Serialised through a promise
// gate because workers that each read the log independently all conclude there
// is room and all go at once — the exact burst this exists to prevent.
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _rateLimits() {
  // Spelled out, not read via a computed key: docs/ENV.md is generated by
  // scanning for literal process.env reads, and a computed lookup ships invisible.
  const rps = parseInt(process.env.EARLYBIRD_SCAN_RPS || "8",   10);
  const rpm = parseInt(process.env.EARLYBIRD_SCAN_RPM || "180", 10);
  return {
    rps: Number.isFinite(rps) && rps >= 1 ? Math.min(rps, 50)   : 8,
    rpm: Number.isFinite(rpm) && rpm >= 1 ? Math.min(rpm, 2000) : 180,
  };
}

const _reqLog = [];               // ms stamps of issued history calls, oldest first
let   _rateGate = Promise.resolve();

function _acquireSlot() {
  const booked = _rateGate.then(async () => {
    const { rps, rpm } = _rateLimits();
    for (;;) {
      const now = Date.now();
      while (_reqLog.length && now - _reqLog[0] >= 60000) _reqLog.shift();
      // The log is ascending, so the Nth-newest call sits at length - N. Once
      // that one has aged out of a window, fewer than N remain inside it.
      let wait = 0;
      if (_reqLog.length >= rps) wait = Math.max(wait, _reqLog[_reqLog.length - rps] + 1000  - now);
      if (_reqLog.length >= rpm) wait = Math.max(wait, _reqLog[_reqLog.length - rpm] + 60000 - now);
      if (wait <= 0) { _reqLog.push(now); return; }
      await _sleep(wait);
    }
  });
  // Advance the gate even if a booking throws — otherwise one failure parks
  // every worker queued behind it forever.
  _rateGate = booked.catch(() => {});
  return booked;
}

/** Forget the issued-request history. Tests only. */
function _resetRateLimiter() { _reqLog.length = 0; _rateGate = Promise.resolve(); }

async function _fetchIntradayToday(fySym, resMin) {
  const { fetchCandles } = require("../services/backtestEngine");
  const today = _todayIST();
  await _acquireSlot();
  return fetchCandles(fySym, String(resMin), today, today);
}

/** Daily bars back EARLYBIRD_WARMUP_DAYS calendar days, for the previous close. */
async function _fetchDaily(fySym) {
  const { fetchCandles } = require("../services/backtestEngine");
  await _acquireSlot();
  return fetchCandles(fySym, "D", _daysAgoIST(_warmupDays()), _todayIST());
}

/**
 * The PREVIOUS session's close from a daily series.
 *
 * Fyers stamps a daily bar at 00:00 IST, and today's bar is present and still
 * forming during the session — so "the last bar" is today's, not yesterday's.
 * The bar for TODAY is dropped by IST calendar day and the newest remaining
 * close is returned. Returns null rather than guessing: the engine treats an
 * unknown previous close as a refusal, which is the correct behaviour for a
 * gap rule.
 */
function _prevCloseFrom(dailyCandles) {
  if (!Array.isArray(dailyCandles) || !dailyCandles.length) return null;
  const todayDay = earlyBird._istDayOf(Math.floor(Date.now() / 1000));
  for (let i = dailyCandles.length - 1; i >= 0; i--) {
    const c = dailyCandles[i];
    if (!c || typeof c.time !== "number" || typeof c.close !== "number") continue;
    if (!Number.isFinite(c.close) || c.close <= 0) continue;
    if (earlyBird._istDayOf(c.time) >= todayDay) continue;
    return c.close;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE 09:30 SCAN — once per day, then never again
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Milliseconds elapsed since a given IST minute-of-day, today. Negative before
 * it. Plain arithmetic on the fixed +05:30 offset — India has no DST, so this
 * is exact, and unlike getISTMinutes() it keeps sub-minute precision.
 */
function _msSinceIstMinute(minuteOfDay) {
  const nowMs = Date.now();
  const istMs = nowMs + 19800000;
  const msIntoIstDay = istMs % 86400000;
  return msIntoIstDay - minuteOfDay * 60000;
}

/**
 * Should the day plan be built right now? Everything here is a clock/state
 * question — no rule of the strategy is decided in this function.
 */
function _planDue() {
  if (!state.running || state.plan || state.planInFlight) return false;
  const cfg = earlyBird.getConfig();
  const signalCloseMin = cfg.sessionStartMin + cfg.resolutionMins;   // 09:30
  // The signal bar has to have closed AND Fyers has to have had a moment to
  // publish it. Asking the instant the clock rolls over routinely returns the
  // series one bar short, which would build the plan off the wrong candle.
  //
  // Measured in real MILLISECONDS, not from getISTMinutes(). That helper has
  // minute resolution, so a lag computed from it can only ever be 0 or ≥60000 —
  // the default 5000ms lag would silently become a full 60-second wait, and any
  // lag under a minute would be unexpressible.
  if (_msSinceIstMinute(signalCloseMin) < _historyLagMs()) return false;
  if (state.planNextTryMs && Date.now() < state.planNextTryMs) return false;
  return true;
}

async function _buildDayPlan() {
  if (state.planInFlight) return;
  state.planInFlight = true;
  state.planAttempts++;
  const t0 = Date.now();
  try {
    const cfg = earlyBird.getConfig();
    const universeKey = cfg.universe;
    const symbols = getUniverse(universeKey);

    log(`🔎 ${LOG_TAG} ── 09:30 SCAN #${state.planAttempts} ─────────────────────────────`);
    log(`🔎 ${LOG_TAG} Universe "${universeKey}" — ${symbols.length} symbol(s). Fetching the ${cfg.resolutionMins}-min opening candle + previous daily close for each, ${_scanConcurrency()} at a time.`);

    if (!symbols.length) {
      _noteScanFailure(`universe "${universeKey}" is empty — check EARLYBIRD_UNIVERSE or the swing_scanner_universe.json override`);
      return;
    }

    // NIFTY first: if the index gives no direction there is nothing to confirm
    // against, but the engine still wants the full stock funnel for the log, so
    // the fetch runs regardless and buildDayPlan decides.
    let niftyCandles = [];
    try {
      niftyCandles = await _fetchIntradayToday(NIFTY_INDEX_SYMBOL, cfg.resolutionMins);
    } catch (e) {
      _noteScanFailure(`NIFTY history fetch failed: ${e.message}`);
      return;
    }
    if (!Array.isArray(niftyCandles) || !niftyCandles.length) {
      _noteScanFailure("NIFTY history returned 0 candles — this is almost always an EXPIRED FYERS TOKEN (an expired token answers no_data rather than throwing). Re-login and the scan retries.");
      return;
    }

    // ── THE STOCK FETCH. Skipped ENTIRELY in option-ONLY mode.
    //    The engine already refuses to evaluate stocks there, but the fetch is
    //    the expensive half: ~220 symbols × 2 history calls, rate-limited, is
    //    the minutes-long part of the scan. Not making those calls is the whole
    //    reason option-only mode exists — NIFTY's own candle is all it needs.
    const scanStocks = earlyBird.tradesStock(cfg);
    const stocks = [];
    const fetchFailures = [];

    if (!scanStocks) {
      log(`⚡ ${LOG_TAG} TRADE MODE "${cfg.tradeMode}" — OPTION ONLY. Skipping the ${symbols.length}-symbol stock history fetch entirely; NIFTY's own opening candle is the whole signal and no stock is scanned, checked or traded.`);
    } else {
      const results = await _mapLimit(symbols, _scanConcurrency(), async (sym) => {
        const fySym = fyersSymbol(sym);
        const [intraday, daily] = await Promise.all([
          _fetchIntradayToday(fySym, cfg.resolutionMins),
          _fetchDaily(fySym),
        ]);
        return { sym, fySym, intraday, daily };
      });

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const sym = symbols[i];
        if (!r || !r.ok) {
          fetchFailures.push({ symbol: sym, reason: `history fetch failed — ${(r && r.error) || "unknown error"}` });
          // Still handed to the engine with no candle, so it appears in the
          // funnel with a reason instead of vanishing from the count.
          stocks.push({ symbol: sym, candles: [], prevClose: null });
          continue;
        }
        const { intraday, daily } = r.value;
        stocks.push({
          symbol: sym,
          candles: Array.isArray(intraday) ? intraday : [],
          prevClose: _prevCloseFrom(daily),
        });
      }
    }

    const plan = earlyBird.buildDayPlan(niftyCandles, stocks, { cfg });
    state.plan = plan;
    state.planBuiltAt = Date.now();
    state.planNextTryMs = null;

    _logPlanFunnel(plan, cfg, universeKey, fetchFailures, Date.now() - t0);

    // The OPTION leg is armed BEFORE the stock verdict below, because it is
    // INDEPENDENT of it: it needs no confirming stock, so a day the stock leg
    // rejects is still a day the option leg trades. In option-only mode
    // plan.tradeable is ALWAYS false by design — closing the day on it would
    // silently cancel the only leg that mode has.
    _armOptionSetup(plan, cfg);

    if (!plan.tradeable) {
      if (!scanStocks) {
        // Option-only: there is no stock verdict to act on. The day stays open
        // for the option leg unless the option leg itself has nothing to do.
        if (!state.optionPending) {
          _closeDay(plan.skipReason || plan.reason || "option-only mode: no option setup today");
        }
        return;
      }
      skipLogger.appendSkipLog(MODE_KEY, {
        gate: plan.nifty && plan.nifty.signal ? "not_enough_confirming_stocks" : "nifty_no_signal",
        reason: plan.skipReason || plan.reason,
        scanned: plan.scanned,
        confirming: plan.confirmingCount,
        niftyDirection: plan.nifty ? plan.nifty.direction : null,
      });
      // In "both" mode a live option setup keeps the day open — the stock leg
      // failing its confirmation gate says nothing about the option leg.
      if (state.optionPending) {
        log(`ℹ️ ${LOG_TAG} STOCK LEG closed for the day (${plan.skipReason || plan.reason}) — but the OPTION leg is armed and unaffected; it never needed a confirming stock.`);
        return;
      }
      _closeDay(plan.skipReason || plan.reason || "no tradeable plan today");
      return;
    }

    _armPendingSetups(plan, cfg);
  } catch (e) {
    _noteScanFailure(`scan error: ${e.message}`);
  } finally {
    state.planInFlight = false;
  }
}

/**
 * A scan that could not produce a plan. Backs off and retries — a token that
 * comes back at 09:40 should still give the day a plan, as long as the entry
 * window has not closed (the pending-setup arming checks that).
 */
function _noteScanFailure(why) {
  const backoffMs = Math.min(120000, 10000 * Math.min(state.planAttempts, 12));
  state.planNextTryMs = Date.now() + backoffMs;
  log(`⚠️ ${LOG_TAG} Day plan not built (attempt ${state.planAttempts}) — ${why}. Retrying in ${Math.round(backoffMs / 1000)}s.`);
}

/**
 * The whole funnel, out loud. ~220 rejection lines once a day is what was
 * asked for — but the grouped counts come FIRST so the log stays readable.
 */
function _logPlanFunnel(plan, cfg, universeKey, fetchFailures, elapsedMs) {
  const n = plan.nifty || {};
  const c = n.candle || {};
  log(`📊 ${LOG_TAG} Scan complete in ${(elapsedMs / 1000).toFixed(1)}s — ${plan.scanned} symbol(s) scanned from "${universeKey}"`);
  log(`📊 ${LOG_TAG} NIFTY ${cfg.resolutionMins}-min opening candle: O ${c.open != null ? c.open : "—"} · H ${c.high != null ? c.high : "—"} · L ${c.low != null ? c.low : "—"} · C ${c.close != null ? c.close : "—"}`);
  if (n.detail) {
    log(`📊 ${LOG_TAG} NIFTY candle shape: body ${n.detail.bodyPct != null ? n.detail.bodyPct + "%" : "—"} of range ${n.detail.range != null ? n.detail.range : "—"} · opposing wick ${n.detail.opposingWickPct != null ? n.detail.opposingWickPct + "%" : "—"} (allowed ≤${cfg.maxOpposingWickPct}%) · favourable wick ${n.detail.favourableWickPct != null ? n.detail.favourableWickPct + "%" : "—"} · min body ${cfg.minBodyPct}%`);
  }
  log(`${n.signal ? "✅" : "🚫"} ${LOG_TAG} NIFTY verdict: ${n.reason || "—"}`);

  if (fetchFailures.length) {
    log(`⚠️ ${LOG_TAG} ${fetchFailures.length} symbol(s) failed to fetch and were treated as no-data:`);
    for (const f of fetchFailures) log(`   ⚠️ ${f.symbol} — ${f.reason}`);
  }

  // Grouped rejection counts, then the full per-symbol list.
  const groups = new Map();
  for (const r of (plan.rejected || [])) {
    const key = _rejectGroup(r.reason);
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  if (groups.size) {
    const summary = Array.from(groups.entries()).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ×${v}`).join("  ·  ");
    log(`📊 ${LOG_TAG} Rejections by reason (${plan.rejected.length} total): ${summary}`);
  }

  log(`✅ ${LOG_TAG} ACCEPTED ${plan.candidates.length} of ${plan.scanned} — need ${cfg.minConfirmingStocks}, cap ${cfg.maxConcurrent} concurrent`);
  for (const s of (plan.candidates || [])) {
    const cd = s.candle || {};
    log(`   ✅ ${s.symbol} ${s.side} — candle O ${cd.open} H ${cd.high} L ${cd.low} C ${cd.close} · ${s.detail ? s.detail.shape : "—"} · entry ${s.entry} · SL ${s.stop} (${s.slBasis}${s.bigCandle ? ", BIG-CANDLE rule" : ""}) · target ${s.target} · risk ₹${s.riskPts}/sh × ${s.qty} = ₹${_r2(s.riskPts * s.qty)} · gap ${s.gapPct}% vs prev close ${s.prevClose}`);
  }
  log(`🚫 ${LOG_TAG} REJECTED ${plan.rejected.length} — per-symbol reasons follow`);
  for (const r of (plan.rejected || [])) {
    log(`   🚫 ${r.symbol} — ${r.reason}`);
  }
  log(`📋 ${LOG_TAG} Plan verdict: ${plan.reason || plan.skipReason || "—"}`);
  log(`🔎 ${LOG_TAG} ── end of scan ──────────────────────────────────────────`);
}

/** Bucket a rejection sentence into a countable label. Log presentation only. */
function _rejectGroup(reason) {
  const r = String(reason || "");
  if (/no .* candle \(no data\)/i.test(r))       return "no data";
  if (/history fetch failed/i.test(r))           return "fetch failed";
  if (/previous day's close unknown/i.test(r))   return "no prev close";
  if (/gapped/i.test(r))                         return "gap > limit";
  if (/not aligned/i.test(r))                    return "wrong direction";
  if (/body .* of range </i.test(r))             return "body too small";
  if (/wick .* of range >/i.test(r))             return "opposing wick too big";
  if (/doji/i.test(r))                           return "doji";
  if (/flat candle/i.test(r))                    return "flat candle";
  if (/range .* < required/i.test(r))            return "range too small";
  if (/risk is zero/i.test(r))                   return "zero risk";
  return "other";
}

function _r2(x) { return Math.round(x * 100) / 100; }

/**
 * Turn the plan's candidates into PENDING SETUPS. Frozen at 09:30, never
 * recomputed. Only the first maxConcurrent (already ranked tightest-risk-first
 * by the engine) are armed — arming more would let the cap be decided by
 * whichever stock happened to trigger first.
 */
function _armPendingSetups(plan, cfg) {
  const cap = cfg.maxConcurrent;
  const armed = [];
  for (const s of plan.candidates) {
    if (armed.length >= cap) break;
    if (state.attempted.has(s.symbol)) continue;   // already traded today (restart)
    const setup = {
      symbol:        s.symbol,
      fyersSymbol:   fyersSymbol(s.symbol),
      side:          s.side,
      qty:           s.qty,
      entry:         s.entry,
      stop:          s.stop,
      target:        s.target,
      riskPts:       s.riskPts,
      rewardPts:     s.rewardPts,
      bigCandle:     s.bigCandle,
      slBasis:       s.slBasis,
      gapPct:        s.gapPct,
      prevClose:     s.prevClose,
      shape:         s.detail ? s.detail.shape : null,
      signalOpen:    s.candle ? s.candle.open : null,
      signalHigh:    s.candle ? s.candle.high : null,
      signalLow:     s.candle ? s.candle.low : null,
      signalClose:   s.candle ? s.candle.close : null,
      signalBarTime: s.signalBarTime,
      entryReason:   s.reason,
      armedAt:       Date.now(),
    };
    state.pending.set(s.symbol, setup);
    armed.push(setup);
  }

  log(`🎯 ${LOG_TAG} ARMED ${armed.length} pending setup(s) — ${plan.side} day, entries allowed until ${_fmtMins(cfg.entryEndMin)}, cap ${cap} concurrent, qty ${cfg.qty}/stock`);
  for (const s of armed) {
    log(`   🎯 ${s.symbol} ${s.side} — waiting for price to ${s.side === "LONG" ? "trade UP through" : "trade DOWN through"} ₹${s.entry}. SL ₹${s.stop}, target ₹${s.target}, risk ₹${_r2(s.riskPts * s.qty)}.`);
  }
  if (plan.candidates.length > armed.length) {
    const skippedNames = plan.candidates.slice(armed.length).map(x => x.symbol).join(", ");
    log(`   ℹ️ ${LOG_TAG} ${plan.candidates.length - armed.length} confirming name(s) NOT armed (concurrency cap ${cap}): ${skippedNames}`);
  }
  _persist();
  _logShortlist();
}

function _fmtMins(mins) {
  return earlyBird._fmtMins(mins);
}

/**
 * How the option leg's strike is described on the page. EARLYBIRD_ITM_STEPS is
 * consumed inside config/instrument.js through a computed `${MODE}_ITM_STEPS`
 * lookup, so it is deliberately NOT on the engine's cfg — read it here the same
 * way instrument.js does, including its "missing = 1 step" default, so the page
 * never claims ATM while the broker leg is actually buying 1-step ITM.
 */
function _itmStepsLabel() {
  const n = parseInt(process.env.EARLYBIRD_ITM_STEPS || "1", 10);
  if (!Number.isFinite(n) || n <= 0) return "ATM";
  return `${n}-step ITM`;
}

// ═════════════════════════════════════════════════════════════════════════════
// OPTION LEG — EARLYBIRD_TRADE_MODE = "option" | "both"
//
// EVERYTHING in this block is behind earlyBird.tradesOption(cfg). In the default
// "stock" mode not one of these functions does anything: each returns at its
// first line, and no option module, symbol or quote is ever touched.
//
// The rules live in the engine (buildNiftyOptionSetup / isEntryTriggered /
// checkExitOnTick). Nothing here compares a price to a level or invents one.
//
// THE ONE THING THAT IS DIFFERENT FROM THE STOCK LEG: every level is a NIFTY
// SPOT level and is tested against SPOT (state.lastTickPrice, from the shared
// tick feed), but the P&L is on the PREMIUM. A bought PE profits when spot
// FALLS, because its premium RISES — so earlyBird.computePnl (cash-equity,
// direction-signed) must not be used, and is not.
// ═════════════════════════════════════════════════════════════════════════════

/** Contracts per option trade. getLotQty() already applies the global (clamped)
 *  LOT_MULTIPLIER, so EARLYBIRD_OPTION_LOTS multiplies the ALREADY-multiplied
 *  lot — it is a lot COUNT, not a second multiplier to divide back out. */
function _optionQty(cfg) {
  const lots = (cfg && cfg.optionLots) || earlyBird.getConfig().optionLots;
  const base = instrumentConfig.getLotQty();
  if (typeof base !== "number" || !Number.isFinite(base) || base <= 0) return 0;
  return base * lots;
}

/** How long to wait before retrying a premium fetch that came back empty. */
function _optionLtpRetryMs() {
  return _intEnv(process.env.EARLYBIRD_OPTION_LTP_RETRY_MS, 5000, 1000, 60000);
}

/**
 * Arm the option leg from the day plan. Called once, from the 09:30 scan.
 * `plan.optionSetup` is built by the engine and is already null in stock mode.
 */
function _armOptionSetup(plan, cfg) {
  if (!earlyBird.tradesOption(cfg)) return;

  const s = plan && plan.optionSetup;
  if (!s) {
    log(`🚫 ${LOG_TAG} OPTION LEG — no setup was built (NIFTY gave no signal: ${plan && plan.nifty ? plan.nifty.reason : "—"})`);
    return;
  }

  state.optionSetup = s;

  if (!s.ok) {
    log(`🚫 ${LOG_TAG} OPTION LEG — no trade today: ${s.skipReason || s.reason}`);
    skipLogger.appendSkipLog(MODE_KEY, {
      gate: "option_no_setup",
      reason: s.skipReason || s.reason,
      leg: "option",
      niftyDirection: plan.nifty ? plan.nifty.direction : null,
    });
    return;
  }

  if (state.optionAttempted) {
    log(`ℹ️ ${LOG_TAG} OPTION LEG — a setup exists but today's one option trade has already been taken (restart recovery). Not re-arming: there is no re-entry.`);
    return;
  }

  const qty = _optionQty(cfg);
  state.optionPending = {
    side:          s.side,          // LONG | SHORT — the SPOT direction
    optionSide:    s.optionSide,    // CE | PE      — what we BUY
    entry:         s.entry,
    stop:          s.stop,
    target:        s.target,
    riskPts:       s.riskPts,
    rewardPts:     s.rewardPts,
    bigCandle:     s.bigCandle,
    slBasis:       s.slBasis,
    lots:          cfg.optionLots,
    qty,
    shape:         s.detail ? s.detail.shape : null,
    signalOpen:    s.candle ? s.candle.open : null,
    signalHigh:    s.candle ? s.candle.high : null,
    signalLow:     s.candle ? s.candle.low : null,
    signalClose:   s.candle ? s.candle.close : null,
    signalBarTime: s.signalBarTime,
    entryReason:   s.reason,
    armedAt:       Date.now(),
  };

  const c = s.candle || {};
  log(`🎯 ${LOG_TAG} OPTION LEG ARMED — BUY NIFTY ${s.optionSide} on a ${s.side} signal. NO stock confirmation is used or required for this leg.`);
  log(`   ├─ Signal : NIFTY ${_fmtMins(cfg.sessionStartMin)} candle O ${c.open} H ${c.high} L ${c.low} C ${c.close} · ${state.optionPending.shape || "—"}`);
  log(`   ├─ Trigger: SPOT must ${s.side === "LONG" ? "trade UP through" : "trade DOWN through"} ${s.entry} (a NIFTY SPOT level, not a premium)`);
  log(`   ├─ Stop   : SPOT ${s.stop} (${s.slBasis}${s.bigCandle ? " — BIG-CANDLE rule moved it onto the body" : ""}) · risk ${s.riskPts} spot pts`);
  log(`   ├─ Target : SPOT ${s.target} @ 1:${cfg.targetRR} · reward ${s.rewardPts} spot pts`);
  log(`   └─ Size   : ${cfg.optionLots} lot(s) = ${qty} qty · entries allowed until ${_fmtMins(cfg.entryEndMin)} · square-off ${_fmtMins(cfg.forcedExitMin)} · ONE option trade per day, no re-entry`);
  _persist();
}

/**
 * Fetch one option's premium. Returns a number or null — never a guess, and
 * never a stale value from another symbol: attribution is by symbol, with the
 * single-row/single-request exception that every other quote reader here uses.
 */
async function _fetchOptionPremium(symbol) {
  const r = await fyers.getQuotes([symbol]);
  if (!r || r.s !== "ok" || !Array.isArray(r.d) || !r.d.length) return null;
  for (const row of r.d) {
    const v = (row && row.v) || {};
    const ltp = v.lp || v.ltp;
    if (typeof ltp !== "number" || !Number.isFinite(ltp) || !(ltp > 0)) continue;
    let sym = row && (row.n || row.symbol);
    if (!sym && r.d.length === 1) sym = symbol;
    if (sym !== symbol) continue;
    return ltp;
  }
  return null;
}

/**
 * The option leg's per-poll step: trigger, then exit.
 *
 * EXITS ARE CHECKED FIRST, for the same reason the stock leg does it — a stop
 * must never queue behind a new fill.
 *
 * ASYNC, because pricing an option needs a round-trip that the stock leg never
 * needed (its fill price is a frozen level). Everything that DECIDES is
 * synchronous and happens before the first await; the await only fetches the
 * premium, and `optionEntryLock` (set before it, cleared in a finally) plus a
 * re-check of `optionPosition` AFTER it stop two concurrent polls entering twice.
 */
async function _stepOptionLeg() {
  const cfg = earlyBird.getConfig();
  if (!earlyBird.tradesOption(cfg)) return;
  if (!state.running) return;

  const nowMins = getISTMinutes();
  const spot = state.lastTickPrice;

  // ── EXIT first ────────────────────────────────────────────────────────────
  if (state.optionPosition) {
    if (typeof spot === "number" && Number.isFinite(spot) && spot > 0) {
      _trackOptionExcursion(state.optionPosition, spot);
      const ex = earlyBird.checkExitOnTick(state.optionPosition, spot, { nowMins, cfg });
      if (ex && ex.exit) { await _closeOptionPosition(ex); return; }
    } else if (Number.isFinite(nowMins) && nowMins >= cfg.forcedExitMin) {
      // The square-off clock must fire even with a dead spot feed, exactly as the
      // stock leg's does — a position is never held past it for want of a tick.
      log(`⚠️ ${LOG_TAG} OPTION — forced exit is due but there is no fresh NIFTY spot tick. Squaring off on the clock.`);
      await _closeOptionPosition({
        exitType: "EOD",
        reason: `Forced exit at ${_fmtMins(cfg.forcedExitMin)} (no spot tick — squared off on the clock)`,
        price: state.optionPosition.entrySpot,
      });
    }
    return;                            // one option position, so nothing else to do
  }

  // ── ENTRY ─────────────────────────────────────────────────────────────────
  // Every guard below is SYNCHRONOUS and complete before the first await.
  if (state.dayClosed) return;
  if (state.optionAttempted) return;               // one trade per day, no re-entry
  if (state.optionEntryLock) return;               // an entry is already in flight
  if (!state.optionPending) return;
  if (!Number.isFinite(nowMins)) return;
  if (nowMins < cfg.entryStartMin) return;
  if (nowMins > cfg.entryEndMin) { _dropExpiredOptionSetup(cfg, spot); return; }
  if (state.tradesTaken >= _maxDailyTrades()) { _applyDayBreakers(); return; }
  if (typeof spot !== "number" || !Number.isFinite(spot) || spot <= 0) return;
  if (!earlyBird.isEntryTriggered(state.optionPending, spot)) return;
  // A premium fetch that just failed is retried on a timer, not on every tick —
  // a dead symbol would otherwise hammer the quote API twice a second.
  if (state.optionLtpFailAt && Date.now() - state.optionLtpFailAt < _optionLtpRetryMs()) return;

  state.optionEntryLock = true;
  try {
    await _openOptionPosition(state.optionPending, spot, nowMins, cfg);
  } catch (e) {
    console.error(`🚨 ${LOG_TAG} option entry error: ${e.message}`);
    state.optionLtpFailAt = Date.now();
  } finally {
    state.optionEntryLock = false;
  }
}

/**
 * Resolve the strike, price it, and open THE option position.
 *
 * The trade is recorded at the SETUP'S FROZEN SPOT ENTRY LEVEL, not at the tick
 * that broke it — identical to the stock leg, and for the identical reason: a
 * resting stop order would have filled at the level. The premium, by contrast,
 * is the live one, because that is genuinely what the option cost at that moment.
 */
async function _openOptionPosition(setup, triggerSpot, nowMins, cfg) {
  const optionSide = setup.optionSide;
  const entrySpot  = setup.entry;

  log(`⚡ ${LOG_TAG} OPTION TRIGGER — NIFTY spot ${triggerSpot} ${setup.side === "LONG" ? "traded UP through" : "traded DOWN through"} the ${setup.entry} entry level. Resolving the ${optionSide} strike…`);

  let optInfo;
  try {
    optInfo = await instrumentConfig.validateAndGetOptionSymbol(triggerSpot, optionSide, "EARLYBIRD");
  } catch (e) {
    state.optionLtpFailAt = Date.now();
    log(`❌ ${LOG_TAG} OPTION — strike/expiry resolve failed: ${e.message}. Will retry while the entry window is open.`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "option_symbol", leg: "option", reason: e.message, side: optionSide, spot: triggerSpot });
    return;
  }
  if (!optInfo || optInfo.invalid || !optInfo.symbol) {
    state.optionLtpFailAt = Date.now();
    log(`❌ ${LOG_TAG} OPTION — no valid expiry for the ${optionSide} strike. Entry blocked; will retry while the entry window is open.`);
    skipLogger.appendSkipLog(MODE_KEY, {
      gate: "option_expiry", leg: "option",
      reason: "no valid option expiry", side: optionSide, spot: triggerSpot,
      strike: optInfo ? optInfo.strike : null,
    });
    return;
  }

  let premium = null;
  try {
    premium = await _fetchOptionPremium(optInfo.symbol);
  } catch (e) {
    log(`⚠️ ${LOG_TAG} OPTION — premium fetch threw for ${optInfo.symbol}: ${e.message}`);
  }

  // ── RE-CHECKED AFTER THE AWAIT. Two concurrent polls could both have passed
  //    the synchronous guards before either reached here.
  if (state.optionPosition || state.optionAttempted) {
    log(`⏭️ ${LOG_TAG} OPTION — entry abandoned after the premium fetch: a position was opened while it was in flight.`);
    return;
  }
  if (!state.running || state.dayClosed) {
    log(`⏭️ ${LOG_TAG} OPTION — entry abandoned after the premium fetch: the session closed while it was in flight.`);
    return;
  }

  if (typeof premium !== "number" || !Number.isFinite(premium) || premium <= 0) {
    state.optionLtpFails++;
    state.optionLtpFailAt = Date.now();
    log(`❌ ${LOG_TAG} OPTION — no premium available for ${optInfo.symbol} (attempt ${state.optionLtpFails}). NOT entering without a fill price; retrying in ${Math.round(_optionLtpRetryMs() / 1000)}s while the entry window is open (until ${_fmtMins(cfg.entryEndMin)}).`);
    skipLogger.appendSkipLog(MODE_KEY, {
      gate: "option_ltp", leg: "option",
      reason: "no option LTP — entry deferred, will retry inside the entry window",
      symbol: optInfo.symbol, side: optionSide, spot: triggerSpot,
      strike: optInfo.strike, expiry: optInfo.expiry, attempt: state.optionLtpFails,
    });
    return;
  }

  try { tickRecorder.recordOptionLtp(optInfo.symbol, premium, "early-bird-paper"); } catch (_) {}

  const qty = setup.qty;
  if (!(qty > 0)) {
    state.optionLtpFailAt = Date.now();
    log(`❌ ${LOG_TAG} OPTION — computed qty is ${qty}; refusing to enter.`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "option_qty", leg: "option", reason: `qty ${qty} unusable`, symbol: optInfo.symbol });
    return;
  }

  // Capital check — advisory only, exactly as on the stock leg.
  const _cap = capitalPool.check(MODE_KEY, qty * premium);
  if (!_cap.ok) {
    log(`⚠️ ${LOG_TAG} ${_cap.reason} — option entry taken anyway, pool now overdrawn`);
    capitalPool.noteShortfall(MODE_KEY, _cap, { side: optionSide, symbol: optInfo.symbol });
  }

  const pos = {
    leg:            "option",
    symbol:         optInfo.symbol,      // the FULL Fyers option symbol
    optionSide,                          // CE | PE
    optionStrike:   optInfo.strike,
    optionExpiry:   optInfo.expiry,
    side:           setup.side,          // LONG | SHORT — the SPOT direction the engine tests
    qty,
    lots:           setup.lots,
    optionEntryLtp: premium,
    entrySpot,                           // the FROZEN level, not the trigger tick
    triggerSpot,
    // These three are what earlyBird.checkExitOnTick reads. They are SPOT levels.
    stop:           setup.stop,
    target:         setup.target,
    riskPts:        setup.riskPts,
    rewardPts:      setup.rewardPts,
    bigCandle:      setup.bigCandle,
    slBasis:        setup.slBasis,
    shape:          setup.shape,
    signalOpen:     setup.signalOpen,
    signalHigh:     setup.signalHigh,
    signalLow:      setup.signalLow,
    signalClose:    setup.signalClose,
    signalBarTime:  setup.signalBarTime,
    entryReason:    setup.entryReason,
    entryTime:      istNow(),
    entryTimeMs:    Date.now(),
    entryUnixSec:   Math.floor(Date.now() / 1000),
    entryMins:      nowMins,
    peakSpot:       entrySpot,
    troughSpot:     entrySpot,
    mfePts: 0, maePts: 0, secsToMFE: 0, secsToMAE: 0,
  };

  state.optionPosition  = pos;
  state.optionPending   = null;
  state.optionAttempted = true;
  state.optionLtp       = premium;
  state.optionLtpFails  = 0;
  state.optionLtpFailAt = null;
  state.tradesTaken++;
  capitalPool.block(MODE_KEY, qty * premium, { side: optionSide, symbol: optInfo.symbol, qty, premium });
  _persist();

  const slip = _r2(Math.abs(triggerSpot - entrySpot));
  log(`🟢 ${LOG_TAG} OPTION FILL — BUY ${qty}× ${optInfo.symbol} @ ₹${premium} premium`);
  log(`   ├─ Strike : ${optInfo.strike} ${optionSide} · expiry ${optInfo.expiry} · ${setup.lots} lot(s) × ${instrumentConfig.getLotQty()} = ${qty} qty · ₹${_r2(qty * premium)} deployed`);
  log(`   ├─ Spot   : entered on the frozen ${entrySpot} level (the trigger tick printed ${triggerSpot}, ${slip} away). ${setup.side} signal → bought a ${optionSide}.`);
  log(`   ├─ Stop   : SPOT ${setup.stop} (${setup.slBasis}${setup.bigCandle ? " — BIG-CANDLE rule" : ""}) · ${setup.riskPts} spot pts`);
  log(`   ├─ Target : SPOT ${setup.target} @ 1:${cfg.targetRR} · ${setup.rewardPts} spot pts`);
  log(`   └─ P&L    : measured on the PREMIUM — (exit − ₹${premium}) × ${qty}. A ${optionSide} bought on a ${setup.side} signal gains when its PREMIUM rises${optionSide === "PE" ? ", which is when spot FALLS" : ""}. Trades used today: ${state.tradesTaken}/${_maxDailyTrades()}.`);

  notifyEntry({
    mode: "EARLYBIRD-PAPER",
    side: optionSide, symbol: optInfo.symbol,
    spotAtEntry: entrySpot, optionEntryLtp: premium,
    qty, stopLoss: setup.stop, target: setup.target,
    entryTime: pos.entryTime,
    entryReason: setup.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "early-bird-paper",
      sessionId: state._sessionId,
      ts: Date.now(),
      side: optionSide, symbol: optInfo.symbol, qty,
      spotEntry: entrySpot, optionEntry: premium,
      stopLoss: setup.stop, target: setup.target,
      reason: setup.entryReason,
    });
  } catch (_) {}
}

/** MFE / MAE in SPOT points. Pure analytics — no decision reads these. */
function _trackOptionExcursion(pos, spot) {
  const dir = pos.side === "SHORT" ? -1 : 1;
  const favPts = (spot - pos.entrySpot) * dir;
  if (spot > pos.peakSpot)   pos.peakSpot = spot;
  if (spot < pos.troughSpot) pos.troughSpot = spot;
  if (favPts > (pos.mfePts || 0)) {
    pos.mfePts = _r2(favPts);
    pos.secsToMFE = _r2((Date.now() - pos.entryTimeMs) / 1000);
  }
  if (favPts < (pos.maePts || 0)) {
    pos.maePts = _r2(favPts);
    pos.secsToMAE = _r2((Date.now() - pos.entryTimeMs) / 1000);
  }
}

/**
 * Book the option position. `ex` is the engine's exit verdict, whose `price` is
 * a SPOT level — the exit PREMIUM is fetched separately, because that is what
 * the P&L is made of. A premium fetch that fails falls back to the last one
 * seen and says so out loud rather than leaving the position open forever.
 */
async function _closeOptionPosition(ex) {
  const pos = state.optionPosition;
  if (!pos) return;
  // Claim it synchronously: this function awaits, and a second poll must not be
  // able to book the same position twice.
  state.optionPosition = null;

  const cfg = earlyBird.getConfig();
  let exitPremium = null;
  let premiumSource = "live quote";
  try {
    exitPremium = await _fetchOptionPremium(pos.symbol);
    if (exitPremium != null) { try { tickRecorder.recordOptionLtp(pos.symbol, exitPremium, "early-bird-paper"); } catch (_) {} }
  } catch (e) {
    log(`⚠️ ${LOG_TAG} OPTION — exit premium fetch threw for ${pos.symbol}: ${e.message}`);
  }
  if (typeof exitPremium !== "number" || !Number.isFinite(exitPremium) || exitPremium <= 0) {
    exitPremium = (typeof state.optionLtp === "number" && Number.isFinite(state.optionLtp) && state.optionLtp > 0)
      ? state.optionLtp : pos.optionEntryLtp;
    premiumSource = "last known premium (quote unavailable at exit)";
    log(`⚠️ ${LOG_TAG} OPTION — no live premium at exit; booking at the ${premiumSource} ₹${exitPremium}.`);
  }
  state.optionLtp = exitPremium;

  const exitSpot = (typeof ex.price === "number" && Number.isFinite(ex.price)) ? ex.price : pos.entrySpot;
  const qty = pos.qty;

  // A BOUGHT option: profit is (exit − entry) × qty, whichever side it is.
  // earlyBird.computePnl is cash-equity and direction-signed — using it here
  // would flip the sign on every PE and report a winner as a loser.
  const gross   = _r2((exitPremium - pos.optionEntryLtp) * qty);
  const charges = getCharges({ broker: "fyers", isSpot: false, entryPremium: pos.optionEntryLtp, exitPremium, qty });
  const pnl     = _r2(gross - charges);

  state.sessionPnl = _r2(state.sessionPnl + pnl);
  if (ex.exitType === "SL") state.stopOuts++;

  const trade = {
    leg:            "option",
    symbol:         pos.symbol,
    optionSide:     pos.optionSide,
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    side:           pos.side,
    qty,
    lots:           pos.lots,
    optionEntryLtp: pos.optionEntryLtp,
    optionExitLtp:  exitPremium,
    entryPrice:     pos.optionEntryLtp,
    exitPrice:      exitPremium,
    entrySpot:      pos.entrySpot,
    exitSpot,
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    entryBarTime:   pos.signalBarTime,
    entryUnixSec:   pos.entryUnixSec,
    exitUnixSec:    Math.floor(Date.now() / 1000),
    pnl,
    grossPnl:       gross,
    charges,
    pnlMode:        `option premium: BUY ${pos.optionSide} ${qty} × ₹${pos.optionEntryLtp} → ₹${exitPremium} (${premiumSource}); every level measured on NIFTY SPOT`,
    exitReason:     ex.reason,
    exitType:       ex.exitType,
    entryReason:    pos.entryReason,
    stopLoss:       pos.stop,
    initialStopLoss: pos.stop,
    target:         pos.target,
    riskPts:        pos.riskPts,
    rewardPts:      pos.rewardPts,
    bigCandle:      pos.bigCandle,
    slBasis:        pos.slBasis,
    shape:          pos.shape,
    signalOpen:     pos.signalOpen,
    signalHigh:     pos.signalHigh,
    signalLow:      pos.signalLow,
    signalClose:    pos.signalClose,
    signalBarTime:  pos.signalBarTime,
    triggerPrice:   pos.triggerSpot,
    peakSpot:       pos.peakSpot,
    troughSpot:     pos.troughSpot,
    mfePts:         pos.mfePts || 0,
    maePts:         pos.maePts || 0,
    secsToMFE:      pos.secsToMFE || 0,
    secsToMAE:      pos.secsToMAE || 0,
    durationMs:     Date.now() - pos.entryTimeMs,
    instrument:     "NIFTY_OPTION",
    isSpot:         false,
  };

  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog(MODE_KEY, trade);
  capitalPool.release(MODE_KEY, pnl);
  _persist();

  const held = Math.round(trade.durationMs / 1000);
  log(`${pnl >= 0 ? "✅" : "❌"} ${LOG_TAG} OPTION EXIT [${ex.exitType}] ${pos.optionSide} ${qty}×${pos.symbol} — ${ex.reason}`);
  log(`   ├─ Spot   : ${pos.entrySpot} → ${exitSpot} (${_r2(exitSpot - pos.entrySpot)} pts) · the level that fired this exit`);
  log(`   ├─ Premium: ₹${pos.optionEntryLtp} → ₹${exitPremium} (${premiumSource}) · ${_r2(exitPremium - pos.optionEntryLtp)}/qty × ${qty}`);
  log(`   ├─ P&L    : gross ₹${gross} − charges ₹${charges} = ₹${pnl} · held ${held}s · MFE ${trade.mfePts} spot pts / MAE ${trade.maePts} spot pts`);
  log(`   └─ Book   : session ₹${state.sessionPnl} · ${state.stopOuts} stop-out(s) · ${state.positions.size} stock position(s) still open · no option re-entry today`);

  notifyExit({
    mode: "EARLYBIRD-PAPER",
    side: pos.optionSide, symbol: pos.symbol,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    optionEntryLtp: pos.optionEntryLtp, optionExitLtp: exitPremium,
    pnl, sessionPnl: state.sessionPnl,
    exitReason: ex.reason, entryReason: pos.entryReason,
    entryTime: pos.entryTime, exitTime: trade.exitTime, qty,
    heldMs: trade.durationMs,
  });

  try {
    tickRecorder.recordExit({
      mode: "early-bird-paper", sessionId: state._sessionId, ts: Date.now(),
      side: pos.optionSide, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitPremium, pnl, reason: ex.reason,
    });
  } catch (_) {}

  _applyDayBreakers();
}

/** The option setup never triggered by EARLYBIRD_ENTRY_END. Named, not vanished. */
function _dropExpiredOptionSetup(cfg, spot) {
  const setup = state.optionPending;
  if (!setup) return;
  state.optionPending = null;
  state.optionDropped = { ...setup, droppedAt: istNow(), lastSpot: (typeof spot === "number" && Number.isFinite(spot)) ? spot : null };
  log(`⌛ ${LOG_TAG} OPTION NEVER TRIGGERED — ${setup.side} (${setup.optionSide}): NIFTY spot never reached the ${setup.entry} entry by ${_fmtMins(cfg.entryEndMin)}${state.optionDropped.lastSpot != null ? ` (last spot ${state.optionDropped.lastSpot})` : " (no recent tick)"}. Setup dropped, no option trade today.`);
  skipLogger.appendSkipLog(MODE_KEY, {
    gate: "option_never_triggered", leg: "option",
    reason: `spot entry ${setup.entry} never touched by ${_fmtMins(cfg.entryEndMin)}`,
    side: setup.side, optionSide: setup.optionSide,
    entry: setup.entry, stop: setup.stop, target: setup.target,
    lastSpot: state.optionDropped.lastSpot,
  });
  _persist();
}

/**
 * Mark the open option to market, for the screen only.
 *
 * NO EXIT READS THIS. Every exit level is a SPOT level and is tested against the
 * tick feed in _stepOptionLeg — this poll exists so the status page can show a
 * live premium and a live P&L, and so a stale premium is never what a trade is
 * booked at when the exit's own fetch fails.
 */
async function _pollOptionPremium() {
  if (!state.optionPosition) return;
  if (!earlyBird.tradesOption()) return;
  const sym = state.optionPosition.symbol;
  try {
    const ltp = await _fetchOptionPremium(sym);
    if (typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0) {
      state.optionLtp = ltp;
      try { tickRecorder.recordOptionLtp(sym, ltp, "early-bird-paper"); } catch (_) {}
    }
  } catch (_) { /* the exit path has its own fetch + fallback; a mark-to-market miss is not an event */ }
}

/** Live premium + P&L for the status surfaces. Null-safe, never a guess. */
function _optionView() {
  const cfg = earlyBird.getConfig();
  if (!earlyBird.tradesOption(cfg)) return null;

  const pos = state.optionPosition;
  const ltp = (typeof state.optionLtp === "number" && Number.isFinite(state.optionLtp) && state.optionLtp > 0)
    ? state.optionLtp : null;

  return {
    enabled:   true,
    tradeMode: cfg.tradeMode,
    lots:      cfg.optionLots,
    lotQty:    instrumentConfig.getLotQty(),
    setup: state.optionSetup ? {
      ok:         !!state.optionSetup.ok,
      side:       state.optionSetup.side,
      optionSide: state.optionSetup.optionSide,
      entry:      state.optionSetup.entry,
      stop:       state.optionSetup.stop,
      target:     state.optionSetup.target,
      riskPts:    state.optionSetup.riskPts,
      rewardPts:  state.optionSetup.rewardPts,
      bigCandle:  !!state.optionSetup.bigCandle,
      slBasis:    state.optionSetup.slBasis,
      shape:      state.optionSetup.detail ? state.optionSetup.detail.shape : null,
      reason:     state.optionSetup.reason || state.optionSetup.skipReason,
    } : null,
    armed:     !!state.optionPending,
    triggered: !!state.optionAttempted,
    spot:      (typeof state.lastTickPrice === "number" && Number.isFinite(state.lastTickPrice)) ? state.lastTickPrice : null,
    distance:  (state.optionPending && typeof state.lastTickPrice === "number" && Number.isFinite(state.lastTickPrice))
      ? _r2(Math.abs(state.optionPending.entry - state.lastTickPrice)) : null,
    position: pos ? {
      symbol:         pos.symbol,
      optionSide:     pos.optionSide,
      optionStrike:   pos.optionStrike,
      optionExpiry:   pos.optionExpiry,
      side:           pos.side,
      qty:            pos.qty,
      optionEntryLtp: pos.optionEntryLtp,
      optionLtp:      ltp,
      entrySpot:      pos.entrySpot,
      stop:           pos.stop,
      target:         pos.target,
      entryTime:      pos.entryTime,
      heldSec:        Math.round((Date.now() - pos.entryTimeMs) / 1000),
      // Premium P&L — the same arithmetic the exit books, so the screen and the
      // trade record can never disagree about which way a PE is going.
      livePnl:        ltp != null ? _r2((ltp - pos.optionEntryLtp) * pos.qty) : null,
      mfePts:         pos.mfePts || 0,
      maePts:         pos.maePts || 0,
    } : null,
    dropped: state.optionDropped ? {
      side: state.optionDropped.side, optionSide: state.optionDropped.optionSide,
      entry: state.optionDropped.entry, lastSpot: state.optionDropped.lastSpot,
    } : null,
    ltpFails: state.optionLtpFails,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICE FEED — REST quote poll of the shortlist
// ─────────────────────────────────────────────────────────────────────────────

/** Every symbol whose price matters right now: pending setups + open positions. */
function _shortlist() {
  const out = new Map();   // fyersSymbol -> plain symbol
  for (const s of state.pending.values()) out.set(s.fyersSymbol, s.symbol);
  for (const p of state.positions.values()) out.set(p.fyersSymbol, p.symbol);
  return out;
}

function _logShortlist() {
  const sl = _shortlist();
  log(`📡 ${LOG_TAG} Price source: REST quote poll every ${_pollMs()}ms for ${sl.size} shortlisted symbol(s) — ${Array.from(sl.values()).join(", ") || "none"}. The shared NIFTY socket supplies the heartbeat only; no EarlyBird decision reads it.`);
}

/**
 * Pull LTPs out of a getQuotes response.
 *
 * Attribution is STRICTLY by symbol — never "whatever is left over". A row with
 * no identifiable symbol is DROPPED, except when a single-symbol request came
 * back with a single row, where there is nothing to confuse it with. Writing
 * one stock's price into another's slot would fire the wrong stop.
 *
 * Exported for the offline test harness: this decides the price every exit is
 * measured against, so it is tested rather than trusted.
 */
function attributeQuotes(resp, requested) {
  const out = new Map();   // fyers symbol -> ltp
  if (!resp || resp.s !== "ok" || !Array.isArray(resp.d)) return out;
  const want = new Set(Array.isArray(requested) ? requested : []);
  for (const row of resp.d) {
    const v = (row && row.v) || {};
    const ltp = v.lp || v.ltp;
    if (typeof ltp !== "number" || !Number.isFinite(ltp) || !(ltp > 0)) continue;
    let sym = row && (row.n || row.symbol);
    if (!sym && resp.d.length === 1 && want.size === 1) sym = Array.from(want)[0];
    if (!sym || !want.has(sym)) continue;
    out.set(sym, ltp);
  }
  return out;
}

async function _pollQuotes() {
  const sl = _shortlist();
  if (!sl.size) return;
  const all = Array.from(sl.keys());
  const chunk = _quoteChunk();
  let got = 0;
  let lastErr = null;

  for (let i = 0; i < all.length; i += chunk) {
    const batch = all.slice(i, i + chunk);
    try {
      const r = await fyers.getQuotes(batch);
      const prices = attributeQuotes(r, batch);
      const now = Date.now();
      for (const [fySym, ltp] of prices) {
        const plain = sl.get(fySym) || plainSymbol(fySym);
        state.prices.set(plain, { price: ltp, ts: now });
        got++;
        try { tickRecorder.recordOptionLtp(fySym, ltp, "early-bird-paper"); } catch (_) {}
      }
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
  }

  if (got > 0) {
    if (state.quoteFailures >= 3) {
      log(`✅ ${LOG_TAG} Quote feed recovered after ${state.quoteFailures} failed poll(s) — ${got} price(s) in this round.`);
    }
    state.quoteFailures = 0;
    state.lastQuoteError = null;
    state.lastQuoteOkMs = Date.now();
  } else {
    state.quoteFailures++;
    state.lastQuoteError = lastErr || "quote response carried no usable prices";
    // Loud, but not once every 2 seconds. A position is NEVER left frozen with
    // no price and no warning — this is the warning, and _checkExits refuses to
    // act on a stale price rather than acting on a wrong one.
    if (state.quoteFailures === 3 || state.quoteFailures % 20 === 0) {
      log(`⚠️ ${LOG_TAG} Quote poll has failed ${state.quoteFailures}× in a row (${state.lastQuoteError}). ${state.positions.size} open position(s) are NOT being priced — exits cannot fire until quotes return.`);
    }
  }
}

/** A usable, fresh price for one symbol, or null. Never guesses. */
function _priceOf(symbol) {
  const rec = state.prices.get(symbol);
  if (!rec) return null;
  if (typeof rec.price !== "number" || !Number.isFinite(rec.price) || rec.price <= 0) return null;
  if ((Date.now() - rec.ts) / 1000 > _quoteStaleSec()) return null;
  return rec.price;
}

// ── Poll loop ────────────────────────────────────────────────────────────────
let _pollTimer = null;
let _pollStopped = true;

function startPolling() {
  stopPolling();
  _pollStopped = false;
  const poll = async () => {
    if (_pollStopped) return;

    // 1. The 09:30 scan, once.
    if (_planDue()) {
      _buildDayPlan().catch(e => console.error(`🚨 ${LOG_TAG} plan build error: ${e.message}`));
    }

    // 2. Prices for the shortlist.
    try { await _pollQuotes(); }
    catch (e) { console.error(`🚨 ${LOG_TAG} quote poll error: ${e.message}`); }

    // 3. Exits BEFORE entries — a stop must never wait behind a new fill.
    try { _checkExits(); } catch (e) { console.error(`🚨 ${LOG_TAG} exit-check error: ${e.message}`); }
    try { _checkTriggers(); } catch (e) { console.error(`🚨 ${LOG_TAG} trigger-check error: ${e.message}`); }
    try { _dropExpiredSetups(); } catch (e) { console.error(`🚨 ${LOG_TAG} setup-expiry error: ${e.message}`); }

    // 4. The OPTION leg (EARLYBIRD_TRADE_MODE=option|both). A no-op in the
    //    default "stock" mode — it returns on its first line. Awaited so a slow
    //    premium fetch cannot overlap the next poll's copy of itself.
    try { await _stepOptionLeg(); } catch (e) { console.error(`🚨 ${LOG_TAG} option-leg error: ${e.message}`); }
    try { await _pollOptionPremium(); } catch (e) { console.error(`🚨 ${LOG_TAG} option premium poll error: ${e.message}`); }

    if (!_pollStopped) _pollTimer = setTimeout(poll, _pollMs());
  };
  _pollTimer = setTimeout(poll, 250);
}

function stopPolling() {
  _pollStopped = true;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test every pending setup against its own latest price.
 *
 * ALL GUARDS ARE SYNCHRONOUS and complete before the position is created —
 * there is no await in the fill path at all, because the fill price is the
 * setup's frozen entry LEVEL, not something that has to be fetched. With
 * several positions the guards are per-symbol (an entry lock plus the
 * `attempted` set) AND global (the concurrency cap and the day breakers).
 */
function _checkTriggers() {
  if (!state.running || state.dayClosed) return;
  if (!state.pending.size) return;

  const cfg = earlyBird.getConfig();
  const nowMins = getISTMinutes();
  if (nowMins < cfg.entryStartMin) return;
  if (nowMins > cfg.entryEndMin) return;      // _dropExpiredSetups reports these

  for (const setup of Array.from(state.pending.values())) {
    if (state.positions.size >= cfg.maxConcurrent) return;
    if (state.tradesTaken >= _maxDailyTrades()) { _applyDayBreakers(); return; }
    if (state.positions.has(setup.symbol)) continue;
    if (state.attempted.has(setup.symbol)) { state.pending.delete(setup.symbol); continue; }
    if (state._entryLocks.has(setup.symbol)) continue;

    const price = _priceOf(setup.symbol);
    if (price == null) continue;
    if (!earlyBird.isEntryTriggered(setup, price)) continue;

    state._entryLocks.add(setup.symbol);
    try { _openPosition(setup, price, nowMins); }
    catch (e) { console.error(`🚨 ${LOG_TAG} entry error for ${setup.symbol}: ${e.message}`); }
    finally { state._entryLocks.delete(setup.symbol); }
  }
}

/**
 * Fill a triggered setup AT ITS ENTRY LEVEL — see the engine header. The tick
 * that broke the level may be far past it; a stop order would have filled at the
 * level, so that is what is recorded. The distance is logged so the difference
 * is visible rather than hidden.
 */
function _openPosition(setup, triggerPrice, nowMins) {
  const cfg = earlyBird.getConfig();
  const fillPrice = setup.entry;
  const qty = setup.qty;

  // Capital check — advisory only: an overdrawn pool raises a dashboard alert,
  // it never stops a paper trade.
  const _cap = capitalPool.check(MODE_KEY, qty * fillPrice);
  if (!_cap.ok) {
    log(`⚠️ ${LOG_TAG} ${_cap.reason} — ${setup.symbol} entry taken anyway, pool now overdrawn`);
    capitalPool.noteShortfall(MODE_KEY, _cap, { side: setup.side, symbol: setup.symbol });
  }

  const pos = {
    symbol:        setup.symbol,
    fyersSymbol:   setup.fyersSymbol,
    side:          setup.side,
    qty,
    entryPrice:    fillPrice,
    triggerPrice,
    stop:          setup.stop,
    target:        setup.target,
    riskPts:       setup.riskPts,
    rewardPts:     setup.rewardPts,
    bigCandle:     setup.bigCandle,
    slBasis:       setup.slBasis,
    gapPct:        setup.gapPct,
    prevClose:     setup.prevClose,
    shape:         setup.shape,
    signalOpen:    setup.signalOpen,
    signalHigh:    setup.signalHigh,
    signalLow:     setup.signalLow,
    signalClose:   setup.signalClose,
    signalBarTime: setup.signalBarTime,
    entryReason:   setup.entryReason,
    entryTime:     istNow(),
    entryTimeMs:   Date.now(),
    entryUnixSec:  Math.floor(Date.now() / 1000),
    entryMins:     nowMins,
    peakPrice:     fillPrice,
    troughPrice:   fillPrice,
    mfePts: 0, mfePnl: 0, maePts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
  };

  state.positions.set(setup.symbol, pos);
  state.pending.delete(setup.symbol);
  state.attempted.add(setup.symbol);
  state.tradesTaken++;
  capitalPool.block(MODE_KEY, qty * fillPrice, { side: setup.side, symbol: setup.symbol, qty, premium: fillPrice });
  _persist();

  const slip = _r2(Math.abs(triggerPrice - fillPrice));
  log(`🟢 ${LOG_TAG} FILL ${setup.side} ${qty}×${setup.symbol} @ ₹${fillPrice} (the frozen entry LEVEL; the trigger tick printed ₹${triggerPrice}, ${slip} away)`);
  log(`   ├─ Signal : ${setup.shape || "—"} · candle O ${setup.signalOpen} H ${setup.signalHigh} L ${setup.signalLow} C ${setup.signalClose} · gap ${setup.gapPct}% vs prev close ₹${setup.prevClose}`);
  log(`   ├─ Stop   : ₹${setup.stop} (${setup.slBasis}${setup.bigCandle ? " — BIG-CANDLE rule moved it onto the body" : ""}) · risk ₹${setup.riskPts}/sh = ₹${_r2(setup.riskPts * qty)} total`);
  log(`   ├─ Target : ₹${setup.target} @ 1:${cfg.targetRR} · reward ₹${setup.rewardPts}/sh = ₹${_r2(setup.rewardPts * qty)} total`);
  log(`   └─ Book   : ${state.positions.size}/${cfg.maxConcurrent} open · ${state.pending.size} still pending · ${state.tradesTaken}/${_maxDailyTrades()} trades used today`);

  notifyEntry({
    mode: "EARLYBIRD-PAPER",
    side: setup.side, symbol: setup.symbol,
    spotAtEntry: fillPrice, optionEntryLtp: fillPrice,
    qty, stopLoss: setup.stop, target: setup.target,
    entryTime: pos.entryTime,
    entryReason: setup.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "early-bird-paper",
      sessionId: state._sessionId,
      ts: Date.now(),
      side: setup.side, symbol: setup.fyersSymbol, qty,
      spotEntry: fillPrice, optionEntry: fillPrice,
      stopLoss: setup.stop, target: setup.target,
      reason: setup.entryReason,
    });
  } catch (_) {}
}

/**
 * Pending setups that never triggered by EARLYBIRD_ENTRY_END are dropped and
 * named. The user asked to see the small things: a setup that spent the morning
 * never being touched is exactly the kind of thing that otherwise disappears.
 */
function _dropExpiredSetups() {
  if (!state.pending.size) return;
  const cfg = earlyBird.getConfig();
  if (getISTMinutes() <= cfg.entryEndMin) return;

  for (const setup of Array.from(state.pending.values())) {
    const last = _priceOf(setup.symbol);
    const rec = { ...setup, droppedAt: istNow(), lastPrice: last };
    state.dropped.push(rec);
    state.pending.delete(setup.symbol);
    log(`⌛ ${LOG_TAG} NEVER TRIGGERED — ${setup.side} ${setup.symbol}: price never reached the ₹${setup.entry} entry by ${_fmtMins(cfg.entryEndMin)}${last != null ? ` (last seen ₹${last})` : " (no recent price)"}. Setup dropped.`);
    skipLogger.appendSkipLog(MODE_KEY, {
      gate: "never_triggered",
      reason: `entry ${setup.entry} never touched by ${_fmtMins(cfg.entryEndMin)}`,
      symbol: setup.symbol, side: setup.side,
      entry: setup.entry, stop: setup.stop, target: setup.target,
      lastPrice: last,
    });
  }
  _persist();
}

// ─────────────────────────────────────────────────────────────────────────────
// EXITS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every open position, tested against its own latest price. The engine owns
 * the whole test (SL / TARGET / forced-exit clock) — nothing here compares a
 * price to a level.
 *
 * A position whose price is missing or stale is NOT exited and NOT silently
 * ignored: it keeps its `noPriceSince` stamp, which the status page shows and
 * the quote-failure log line counts.
 */
function _checkExits() {
  if (!state.positions.size) return;
  const cfg = earlyBird.getConfig();
  const nowMins = getISTMinutes();

  for (const pos of Array.from(state.positions.values())) {
    const price = _priceOf(pos.symbol);

    if (price == null) {
      if (!pos.noPriceSince) pos.noPriceSince = Date.now();
      // The forced-exit clock must still fire without a price, or a dead quote
      // feed would hold a position past the square-off. The engine's own EOD
      // branch needs a price for its exit fill, so the last known one is used
      // and the log says so.
      if (nowMins >= cfg.forcedExitMin) {
        const rec = state.prices.get(pos.symbol);
        const fallback = rec && typeof rec.price === "number" && Number.isFinite(rec.price) && rec.price > 0
          ? rec.price : pos.entryPrice;
        log(`⚠️ ${LOG_TAG} ${pos.symbol} — forced exit is due but the quote feed is stale. Squaring off at the last known price ₹${fallback}.`);
        _closePosition(pos, {
          exitType: "EOD",
          reason: `Forced exit at ${_fmtMins(cfg.forcedExitMin)} (quote feed stale — filled at the last known price)`,
          price: fallback,
        });
      }
      continue;
    }
    if (pos.noPriceSince) {
      log(`✅ ${LOG_TAG} ${pos.symbol} price feed restored after ${Math.round((Date.now() - pos.noPriceSince) / 1000)}s`);
      pos.noPriceSince = null;
    }

    _trackExcursion(pos, price);

    const ex = earlyBird.checkExitOnTick(pos, price, { nowMins, cfg });
    if (ex && ex.exit) _closePosition(pos, ex);
  }
}

/** MFE / MAE bookkeeping. Pure analytics — no decision reads these. */
function _trackExcursion(pos, price) {
  const dir = pos.side === "SHORT" ? -1 : 1;
  const favPts = (price - pos.entryPrice) * dir;
  const curPnl = favPts * pos.qty;
  if (price > pos.peakPrice)   pos.peakPrice = price;
  if (price < pos.troughPrice) pos.troughPrice = price;
  if (favPts > (pos.mfePts || 0)) {
    pos.mfePts = _r2(favPts);
    pos.mfePnl = _r2(curPnl);
    pos.secsToMFE = _r2((Date.now() - pos.entryTimeMs) / 1000);
  }
  if (favPts < (pos.maePts || 0)) {
    pos.maePts = _r2(favPts);
    pos.maePnl = _r2(curPnl);
    pos.secsToMAE = _r2((Date.now() - pos.entryTimeMs) / 1000);
  }
}

/**
 * Book one position. `ex` is the engine's exit verdict (or a route-built one for
 * a manual / session-stop exit), always carrying { exitType, reason, price }.
 */
function _closePosition(pos, ex) {
  if (!state.positions.has(pos.symbol)) return;

  const exitPrice = (typeof ex.price === "number" && Number.isFinite(ex.price) && ex.price > 0)
    ? ex.price : pos.entryPrice;
  const qty = pos.qty;
  const gross = earlyBird.computePnl(pos.side, pos.entryPrice, exitPrice, qty);
  const charges = _equityCharges(qty, pos.entryPrice, exitPrice);
  const pnl = _r2(gross - charges);

  state.sessionPnl = _r2(state.sessionPnl + pnl);
  if (ex.exitType === "SL") state.stopOuts++;

  const trade = {
    symbol:         pos.symbol,
    fyersSymbol:    pos.fyersSymbol,
    side:           pos.side,
    qty,
    entryPrice:     pos.entryPrice,
    exitPrice,
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    entryBarTime:   pos.signalBarTime,
    entryUnixSec:   pos.entryUnixSec,
    exitUnixSec:    Math.floor(Date.now() / 1000),
    pnl,
    grossPnl:       gross,
    charges,
    pnlMode:        `cash equity: ${pos.side} ${qty} × ${pos.symbol}, ₹${pos.entryPrice} → ₹${exitPrice}`,
    exitReason:     ex.reason,
    exitType:       ex.exitType,
    entryReason:    pos.entryReason,
    stopLoss:       pos.stop,
    initialStopLoss: pos.stop,
    target:         pos.target,
    riskPts:        pos.riskPts,
    rewardPts:      pos.rewardPts,
    bigCandle:      pos.bigCandle,
    slBasis:        pos.slBasis,
    gapPct:         pos.gapPct,
    prevClose:      pos.prevClose,
    shape:          pos.shape,
    signalOpen:     pos.signalOpen,
    signalHigh:     pos.signalHigh,
    signalLow:      pos.signalLow,
    signalClose:    pos.signalClose,
    signalBarTime:  pos.signalBarTime,
    triggerPrice:   pos.triggerPrice,
    peakPrice:      pos.peakPrice,
    troughPrice:    pos.troughPrice,
    mfePts:         pos.mfePts || 0,
    mfePnl:         pos.mfePnl || 0,
    maePts:         pos.maePts || 0,
    maePnl:         pos.maePnl || 0,
    secsToMFE:      pos.secsToMFE || 0,
    secsToMAE:      pos.secsToMAE || 0,
    durationMs:     Date.now() - pos.entryTimeMs,
    instrument:     "NSE_EQUITY",
    isSpot:         true,
  };

  state.positions.delete(pos.symbol);
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog(MODE_KEY, trade);
  capitalPool.release(MODE_KEY, pnl);
  _persist();

  const held = Math.round(trade.durationMs / 1000);
  log(`${pnl >= 0 ? "✅" : "❌"} ${LOG_TAG} EXIT [${ex.exitType}] ${pos.side} ${qty}×${pos.symbol} @ ₹${exitPrice} — ${ex.reason}`);
  log(`   ├─ P&L    : gross ₹${gross} − charges ₹${charges} = ₹${pnl} · held ${held}s · MFE ₹${trade.mfePnl} / MAE ₹${trade.maePnl}`);
  log(`   └─ Book   : ${state.positions.size} open · ${state.pending.size} pending · session ₹${state.sessionPnl} · ${state.stopOuts} stop-out(s)`);

  notifyExit({
    mode: "EARLYBIRD-PAPER",
    side: pos.side, symbol: pos.symbol,
    spotAtEntry: pos.entryPrice, spotAtExit: exitPrice,
    optionEntryLtp: pos.entryPrice, optionExitLtp: exitPrice,
    pnl, sessionPnl: state.sessionPnl,
    exitReason: ex.reason, entryReason: pos.entryReason,
    entryTime: pos.entryTime, exitTime: trade.exitTime, qty,
    peakPnl: trade.mfePnl, maxDrawdown: trade.maePnl, heldMs: trade.durationMs,
  });

  try {
    tickRecorder.recordExit({
      mode: "early-bird-paper", sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.fyersSymbol, qty,
      spotExit: exitPrice, optionExit: exitPrice, pnl, reason: ex.reason,
    });
  } catch (_) {}

  _applyDayBreakers();
}

/**
 * Intraday cash-equity charges, both legs. Rates follow the published NSE/SEBI
 * schedule for the EQUITY INTRADAY segment and are overridable, because they
 * move. utils/charges.js is deliberately NOT used: it prices OPTIONS and
 * FUTURES (0.15% STT on sell premium, options exchange txn rate), and applying
 * it to an equity trade would overstate the cost by roughly an order of
 * magnitude on the STT line alone.
 */
function _equityCharges(qty, entryPrice, exitPrice) {
  const buyTurnover  = qty * (entryPrice || 0);
  const sellTurnover = qty * (exitPrice || 0);
  const turnover = buyTurnover + sellTurnover;
  if (!(turnover > 0)) return 0;

  const brokerage = Math.min(_floatEnv(process.env.EARLYBIRD_BROKERAGE_PER_ORDER, 20), 0.0003 * buyTurnover)
                  + Math.min(_floatEnv(process.env.EARLYBIRD_BROKERAGE_PER_ORDER, 20), 0.0003 * sellTurnover);
  const stt   = _floatEnv(process.env.EARLYBIRD_STT_PCT,   0.025)   / 100 * sellTurnover;   // intraday: sell side only
  const txn   = _floatEnv(process.env.EARLYBIRD_TXN_PCT,   0.00297) / 100 * turnover;
  const sebi  = _floatEnv(process.env.EARLYBIRD_SEBI_PCT,  0.0001)  / 100 * turnover;
  const stamp = _floatEnv(process.env.EARLYBIRD_STAMP_PCT, 0.003)   / 100 * buyTurnover;    // intraday: buy side only
  const gst   = 0.18 * (brokerage + txn + sebi);

  return _r2(brokerage + stt + txn + sebi + stamp + gst);
}

// ── Day-level breakers ───────────────────────────────────────────────────────
/**
 * Evaluated after every exit. Each one CLOSES the day for NEW entries. Open
 * positions are deliberately left to their own stop / target / square-off — a
 * breaker is a "stop opening risk" signal, not a panic button, and dumping five
 * live positions at market on a loss cap is how a bad day becomes a worse one.
 */
function _applyDayBreakers() {
  if (state.dayClosed) return;
  const maxLoss = _maxDailyLoss();
  const lock    = _dailyProfitLock();
  const maxOuts = _maxDailyLosses();

  if (maxLoss > 0 && state.sessionPnl <= -maxLoss) {
    _closeDay(`Daily loss cap hit (₹${state.sessionPnl} ≤ -₹${maxLoss})`);
    return;
  }
  if (lock > 0 && state.sessionPnl >= lock) {
    _closeDay(`Daily profit lock hit (₹${state.sessionPnl} ≥ ₹${lock}) — banking the day`);
    return;
  }
  if (maxOuts > 0 && state.stopOuts >= maxOuts) {
    _closeDay(`${state.stopOuts} stop-out(s) ≥ ${maxOuts} — no more entries today`);
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
  const dropped = state.pending.size;
  if (dropped) {
    for (const s of state.pending.values()) {
      log(`   ⏸️ ${LOG_TAG} Pending setup cancelled — ${s.side} ${s.symbol} @ ₹${s.entry} (${reason})`);
    }
    state.pending.clear();
  }
  // A day breaker stops NEW risk of every kind, so an un-triggered option setup
  // is cancelled with the stock ones. An OPEN option position is deliberately
  // left to its own stop / target / square-off, exactly as open stocks are.
  let optCancelled = false;
  if (state.optionPending) {
    log(`   ⏸️ ${LOG_TAG} Pending OPTION setup cancelled — ${state.optionPending.side} ${state.optionPending.optionSide} @ spot ${state.optionPending.entry} (${reason})`);
    state.optionPending = null;
    optCancelled = true;
  }
  if (dropped || optCancelled) _persist();
  log(`⏸️ ${LOG_TAG} ${reason} — no more entries today${dropped ? `, ${dropped} pending setup(s) cancelled` : ""}. ${state.positions.size} open position(s) still run to their own stop/target/square-off.`);
  skipLogger.appendSkipLog(MODE_KEY, { gate: "day_closed", reason, sessionPnl: state.sessionPnl });
}

/** Weekly / portfolio caps, checked once at session start. */
function _checkRiskCapsAtStart() {
  const maxWeek = _maxWeeklyLoss();
  if (maxWeek > 0) {
    const wk = weeklyPnl();
    if (wk <= -maxWeek) { _closeDay(`Weekly loss cap hit (week P&L ₹${wk} ≤ -₹${maxWeek})`); return; }
  }
  try {
    const pf = require("../utils/portfolioRisk").checkPortfolioCap();
    if (pf.blocked) _closeDay(pf.reason);
  } catch (_) {}
}

// ── onTick — the shared NIFTY 50 feed ────────────────────────────────────────
// WHAT IT DRIVES DEPENDS ON EARLYBIRD_TRADE_MODE.
//
//   stock (default) — it drives NOTHING. The stock leg reads the 09:15 candle
//     from history and executes off the equity quote poll; the index price is
//     not an input to either. The callback is then a heartbeat, and the reason
//     the session shows up as a socket consumer.
//
//   option / both — `lastTickPrice` IS the option leg's price feed. Every level
//     of that leg (entry trigger, stop, 1:2 target) is a NIFTY SPOT level, and
//     this is where the spot comes from. A stale or absent tick therefore stops
//     the option leg from entering — and its square-off still fires on the clock
//     (see _stepOptionLeg), so a dead feed cannot hold a position past 13:00.
function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return;
  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;
}

// ── Auto-stop at TRADE_STOP_TIME ─────────────────────────────────────────────
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
  if (state.running) return res.redirect("/early-bird-paper/status");

  if (String(process.env.EARLYBIRD_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("EarlyBird Disabled", "Enable EarlyBird Mode in Settings first", "/settings", "Go to Settings"));
  }
  if (String(process.env.EARLYBIRD_PAPER_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("EarlyBird Paper Disabled", "Enable EarlyBird Paper Trading in Settings first", "/settings", "Go to Settings"));
  }

  const check = sharedSocketState.canStart("EARLY_BIRD_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/early-bird-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/early-bird-paper/status", "← Back"));

  const cfg = earlyBird.getConfig();
  if (getISTMinutes() >= cfg.forcedExitMin) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${_fmtMins(cfg.forcedExitMin)} IST — EarlyBird squares everything off by then`, "/early-bird-paper/status", "← Back"));
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `early-bird-paper:${Date.now()}`;

  sharedSocketState.setEarlyBirdActive("EARLY_BIRD_PAPER");

  const universeSize = getUniverse(cfg.universe).length;
  const _tradesStock  = earlyBird.tradesStock(cfg);
  const _tradesOption = earlyBird.tradesOption(cfg);

  log(`🟢 ${LOG_TAG} Session started — ${STRATEGY_NAME}`);
  log(`⚙️ ${LOG_TAG} TRADE MODE: "${cfg.tradeMode}" — ${
    cfg.tradeMode === "stock"  ? "STOCK LEG ONLY. Cash equity of the F&O stocks that confirm NIFTY's signal. No option is resolved, priced or traded."
  : cfg.tradeMode === "option" ? "OPTION LEG ONLY. ONE NIFTY CE/PE off NIFTY's own opening candle, with NO stock confirmation whatsoever — no stock is scanned, checked or traded, and the whole stock history fetch is skipped."
  : "BOTH LEGS, running at once and INDEPENDENTLY. The option leg fires even if zero stocks confirm, because it never needed them."}`);
  if (_tradesStock) {
    log(`⚙️ ${LOG_TAG} Stock leg : NSE CASH EQUITY of F&O stocks — ${cfg.qty} shares per position, up to ${cfg.maxConcurrent} at once. NIFTY is a FILTER, never traded.`);
  }
  if (_tradesOption) {
    log(`⚙️ ${LOG_TAG} Option leg: BUY ${cfg.optionLots} lot(s) = ${_optionQty(cfg)} qty of ONE NIFTY CE (bullish candle) or PE (bearish candle). Entry trigger, stop and 1:${cfg.targetRR} target are all NIFTY **SPOT** levels off NIFTY's own ${_fmtMins(cfg.sessionStartMin)} candle; P&L is on the PREMIUM, so a bought PE profits when spot falls. ONE option trade per day, no re-entry. It does NOT count against the ${cfg.maxConcurrent}-position stock cap.`);
  }
  log(`⚙️ ${LOG_TAG} Universe  : "${cfg.universe}" — ${universeSize} symbol(s)`);
  log(`⚙️ ${LOG_TAG} Signal    : the day's FIRST ${cfg.resolutionMins}-min candle (${_fmtMins(cfg.sessionStartMin)}→${_fmtMins(cfg.sessionStartMin + cfg.resolutionMins)}) for NIFTY and every stock. Body ≥${cfg.minBodyPct}% of range, opposing wick ≤${cfg.maxOpposingWickPct}%. ≥${cfg.minConfirmingStocks} stock(s) must match NIFTY's direction.`);
  log(`⚙️ ${LOG_TAG} Gap rule  : a stock opening more than ${cfg.maxGapPct}% from its previous daily close is dropped either way.`);
  log(`⚙️ ${LOG_TAG} Levels    : entry = signal high/low ±${cfg.entryBufferPts} · stop = the other end ±${cfg.entryBufferPts}, moved onto the BODY edge if the wick risk exceeds ₹${cfg.maxSlPts} · target = 1:${cfg.targetRR} of the actual risk. All frozen at ${_fmtMins(cfg.sessionStartMin + cfg.resolutionMins)}, never trailed.`);
  log(`⚙️ ${LOG_TAG} Windows   : entries ${_fmtMins(cfg.entryStartMin)}–${_fmtMins(cfg.entryEndMin)} · everything squared off at ${_fmtMins(cfg.forcedExitMin)}`);
  log(`⚙️ ${LOG_TAG} Breakers  : max ${_maxDailyTrades()} trade(s)/day · loss cap ₹${_maxDailyLoss()} · ${_maxDailyLosses()} stop-out(s) · profit lock ${_dailyProfitLock() > 0 ? "₹" + _dailyProfitLock() : "off"} · weekly cap ${_maxWeeklyLoss() > 0 ? "₹" + _maxWeeklyLoss() : "off"}`);
  log(`⚙️ ${LOG_TAG} Prices    : REST quote poll every ${_pollMs()}ms for the SHORTLIST only (candidates + open positions, ${_quoteChunk()} symbols per call). No second socket — that is a repo invariant — and socketManager.subscribeExtra is reserved for option contracts.`);
  log(`⏳ ${LOG_TAG} Waiting for ${_fmtMins(cfg.sessionStartMin + cfg.resolutionMins)} + ${_historyLagMs()}ms before the one and only scan of the day.`);

  _checkRiskCapsAtStart();
  startPolling();

  try {
    tickRecorder.recordSessionStart({
      mode: "early-bird-paper",
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: [],
      meta: {
        instrument: "NSE_EQUITY",
        resolutionMin: cfg.resolutionMins,
        spotSymbol: NIFTY_INDEX_SYMBOL,
        universe: cfg.universe,
        universeSize,
        sessionStartISO: state.sessionStart,
        recordsOptionLtps: false,
      },
    });
  } catch (_) {}

  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log(`📡 ${LOG_TAG} Piggybacking on the existing WebSocket (NIFTY 50 index — heartbeat only)`);
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log(`📡 ${LOG_TAG} Started the WebSocket (NIFTY 50 index — heartbeat only)`);
  }

  scheduleAutoStop();

  notifyStarted({
    mode: "EARLYBIRD-PAPER",
    text: [
      `🐦 EARLYBIRD PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${STRATEGY_NAME} (cash equity, F&O stocks)`,
      `Universe  : ${cfg.universe} — ${universeSize} symbols`,
      `Signal    : the ${_fmtMins(cfg.sessionStartMin)} ${cfg.resolutionMins}-min candle, NIFTY-confirmed`,
      `Size      : ${cfg.qty} shares × up to ${cfg.maxConcurrent} stocks`,
      `Levels    : entry ±${cfg.entryBufferPts} · target 1:${cfg.targetRR} · no trail`,
      `Windows   : entries ${_fmtMins(cfg.entryStartMin)}–${_fmtMins(cfg.entryEndMin)} · square-off ${_fmtMins(cfg.forcedExitMin)}`,
      `Max trades: ${_maxDailyTrades()}/day · loss cap ₹${_maxDailyLoss()}`,
    ].join("\n"),
  });

  res.redirect("/early-bird-paper/status");
});

function stopSession() {
  if (!state.running) return;

  for (const pos of Array.from(state.positions.values())) {
    const price = _priceOf(pos.symbol);
    _closePosition(pos, {
      exitType: "MANUAL",
      reason: "Session stopped",
      price: price != null ? price : pos.entryPrice,
    });
  }
  if (state.pending.size) {
    log(`⏹️ ${LOG_TAG} ${state.pending.size} pending setup(s) cancelled by the session stop: ${Array.from(state.pending.keys()).join(", ")}`);
    state.pending.clear();
  }

  // The OPTION leg. Its square-off needs a premium fetch, so unlike the stock
  // legs above it cannot complete synchronously — it is started here and the
  // trade is booked when the quote returns. The session save below therefore
  // may not include it; the JSONL trade log always does, and the session is
  // rebuilt from that on the next boot (rehydrateSessionFromJsonl).
  let optionClose = null;
  if (state.optionPosition) {
    log(`⏹️ ${LOG_TAG} Squaring off the open OPTION position (${state.optionPosition.symbol}) — fetching its exit premium…`);
    optionClose = _closeOptionPosition({ exitType: "MANUAL", reason: "Session stopped", price: state.lastTickPrice })
      .catch(e => console.error(`🚨 ${LOG_TAG} option session-stop exit error: ${e.message}`));
  }
  if (state.optionPending) {
    log(`⏹️ ${LOG_TAG} Pending OPTION setup cancelled by the session stop (${state.optionPending.side} ${state.optionPending.optionSide} @ spot ${state.optionPending.entry})`);
    state.optionPending = null;
  }

  state.running = false;
  stopPolling();
  // The snapshot is cleared only AFTER that async close has booked its trade —
  // _closeOptionPosition ends in a _persist(), which would otherwise re-create
  // the file we just deleted and leave a phantom snapshot for the next boot.
  const _clearSnapshot = () => { try { require("../utils/positionPersist").clearEarlyBirdPositions(); } catch (_) {} };
  if (optionClose) optionClose.then(_clearSnapshot, _clearSnapshot);
  else _clearSnapshot();

  try { tickRecorder.recordSessionStop({ mode: "early-bird-paper", sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  sharedSocketState.clearEarlyBird();   // clear OWN mode first (else the socket never stops → leak)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: STRATEGY_NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = _r2(data.totalPnl + state.sessionPnl);
      data.capital  = _r2(parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl);
      saveData(data);
      log(`💾 ${LOG_TAG} Session saved — ${state.sessionTrades.length} trade(s), PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ ${LOG_TAG} Save failed: ${e.message}`);
    }
  }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  log(`📋 ${LOG_TAG} Day summary — ${state.sessionTrades.length} trade(s), ${wins}W/${state.sessionTrades.length - wins}L, net ₹${state.sessionPnl}, week ₹${weeklyPnl()}`);
  if (state.plan) {
    log(`📋 ${LOG_TAG} Funnel — ${state.plan.scanned} scanned → ${state.plan.confirmingCount} confirmed → ${state.attempted.size} entered → ${state.dropped.length} never triggered`);
  }
  log(`🔴 ${LOG_TAG} Session stopped`);

  notifyDayReport({
    mode: "EARLYBIRD-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/early-bird-paper/status"); });

/**
 * Manual exit. With no query it squares off EVERY open position; `?symbol=XYZ`
 * exits just that one. The distinction matters here in a way it never did for a
 * single-position route.
 */
router.get("/exit", (req, res) => {
  const only = String(req.query.symbol || "").trim().toUpperCase();
  const list = only
    ? (state.positions.has(only) ? [state.positions.get(only)] : [])
    : Array.from(state.positions.values());
  // The OPTION leg is matched by its full Fyers symbol, and is included in a
  // bare "exit everything" call. It is not in state.positions (that Map is the
  // stock book), so it needs its own line here or a manual square-off would
  // leave it open.
  const optSym = state.optionPosition ? state.optionPosition.symbol : null;
  const exitOption = !!optSym && (!only || only === String(optSym).toUpperCase());

  if (only && !list.length && !exitOption) log(`⚠️ ${LOG_TAG} Manual exit requested for ${only}, but there is no open position in it`);
  for (const pos of list) {
    const price = _priceOf(pos.symbol);
    _closePosition(pos, {
      exitType: "MANUAL",
      reason: only ? `Manual exit (${only})` : "Manual exit (all positions)",
      price: price != null ? price : pos.entryPrice,
    });
  }
  if (exitOption) {
    log(`⏹️ ${LOG_TAG} Manual exit of the OPTION position (${optSym}) — fetching its exit premium…`);
    _closeOptionPosition({
      exitType: "MANUAL",
      reason: only ? `Manual exit (${only})` : "Manual exit (all positions)",
      price: state.lastTickPrice,
    }).catch(e => console.error(`🚨 ${LOG_TAG} option manual-exit error: ${e.message}`));
  }
  res.redirect("/early-bird-paper/status");
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON surfaces
// ─────────────────────────────────────────────────────────────────────────────

function _positionsView() {
  return Array.from(state.positions.values()).map(p => {
    const price = _priceOf(p.symbol);
    const rec = state.prices.get(p.symbol);
    return {
      symbol: p.symbol, side: p.side, qty: p.qty,
      entryPrice: p.entryPrice, stop: p.stop, target: p.target,
      riskPts: p.riskPts, rewardPts: p.rewardPts,
      bigCandle: p.bigCandle, slBasis: p.slBasis,
      gapPct: p.gapPct, shape: p.shape,
      ltp: price, ltpAgeSec: rec ? Math.round((Date.now() - rec.ts) / 1000) : null,
      stale: price == null,
      livePnl: price != null ? earlyBird.computePnl(p.side, p.entryPrice, price, p.qty) : null,
      entryTime: p.entryTime,
      heldSec: Math.round((Date.now() - p.entryTimeMs) / 1000),
      mfePnl: p.mfePnl || 0, maePnl: p.maePnl || 0,
    };
  });
}

function _pendingView() {
  return Array.from(state.pending.values()).map(s => {
    const price = _priceOf(s.symbol);
    return {
      symbol: s.symbol, side: s.side, qty: s.qty,
      entry: s.entry, stop: s.stop, target: s.target,
      riskPts: s.riskPts, rewardPts: s.rewardPts,
      bigCandle: s.bigCandle, slBasis: s.slBasis,
      gapPct: s.gapPct, shape: s.shape,
      ltp: price,
      distance: price != null ? _r2(Math.abs(s.entry - price)) : null,
    };
  });
}

/** The full per-symbol funnel for the on-screen scan table. */
function _scanRows() {
  const plan = state.plan;
  if (!plan) return [];
  const rows = [];
  for (const c of (plan.candidates || [])) {
    rows.push({
      symbol: c.symbol, verdict: "ACCEPTED", reason: c.reason,
      side: c.side, entry: c.entry, stop: c.stop, target: c.target,
      riskPts: c.riskPts, gapPct: c.gapPct, slBasis: c.slBasis,
      bigCandle: c.bigCandle, shape: c.detail ? c.detail.shape : null,
      open: c.candle ? c.candle.open : null, high: c.candle ? c.candle.high : null,
      low: c.candle ? c.candle.low : null, close: c.candle ? c.candle.close : null,
      group: "accepted",
    });
  }
  for (const r of (plan.rejected || [])) {
    rows.push({
      symbol: r.symbol, verdict: "REJECTED", reason: r.reason,
      side: null, entry: null, stop: null, target: null,
      riskPts: null, gapPct: null, slBasis: null, bigCandle: false, shape: null,
      open: null, high: null, low: null, close: null,
      group: _rejectGroup(r.reason),
    });
  }
  return rows;
}

router.get("/status/data", (req, res) => {
  const data = loadData();
  const cfg = earlyBird.getConfig();
  const plan = state.plan;

  const cumPnl = []; let cum = 0;
  for (const t of state.sessionTrades) { cum += (t.pnl || 0); cumPnl.push({ t: t.exitTime || t.entryTime, pnl: _r2(cum) }); }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const winRate = state.sessionTrades.length ? ((wins / state.sessionTrades.length) * 100).toFixed(1) : null;
  const bestTrade = state.sessionTrades.length ? Math.max(...state.sessionTrades.map(t => t.pnl || 0)) : null;
  const worstTrade = state.sessionTrades.length ? Math.min(...state.sessionTrades.map(t => t.pnl || 0)) : null;

  const rejectGroups = {};
  if (plan) for (const r of (plan.rejected || [])) {
    const g = _rejectGroup(r.reason);
    rejectGroups[g] = (rejectGroups[g] || 0) + 1;
  }

  let openPnl = 0;
  for (const v of _positionsView()) if (typeof v.livePnl === "number") openPnl += v.livePnl;
  // The option leg's open P&L belongs in the same total — it is the same
  // session's money, even though it is measured on a premium and not a share.
  const _optView = _optionView();
  if (_optView && _optView.position && typeof _optView.position.livePnl === "number") {
    openPnl += _optView.position.livePnl;
  }

  res.json({
    running: state.running,
    sessionPnl: state.sessionPnl,
    openPnl: _r2(openPnl),
    tradesTaken: state.tradesTaken,
    sessionTrades: state.sessionTrades.slice(-50),
    log: state.log.slice(-300),
    tickCount: state.tickCount,
    lastTickPrice: state.lastTickPrice,
    tickAgeSec: state.lastTickTime ? Math.round((Date.now() - state.lastTickTime) / 1000) : null,
    sessionStart: state.sessionStart,
    wins, losses, winRate, bestTrade, worstTrade, cumPnl,
    weeklyPnl: weeklyPnl(),

    positions: _positionsView(),
    pending: _pendingView(),
    dropped: state.dropped.map(d => ({ symbol: d.symbol, side: d.side, entry: d.entry, lastPrice: d.lastPrice })),
    maxConcurrent: cfg.maxConcurrent,

    // ── OPTION LEG. `null` in the default "stock" mode, so every existing
    //    consumer (the live-harness page proxies this response verbatim) simply
    //    sees a field that is not there and renders exactly what it did before.
    tradeMode: cfg.tradeMode,
    tradesStock: earlyBird.tradesStock(cfg),
    tradesOption: earlyBird.tradesOption(cfg),
    option: _optionView(),

    planBuilt: !!plan,
    planBuiltAt: state.planBuiltAt,
    planAttempts: state.planAttempts,
    planInFlight: state.planInFlight,
    scanned: plan ? plan.scanned : 0,
    confirming: plan ? plan.confirmingCount : 0,
    rejectedCount: plan ? (plan.rejected || []).length : 0,
    rejectGroups,
    side: plan ? plan.side : null,
    tradeable: plan ? plan.tradeable : false,
    planReason: plan ? (plan.reason || plan.skipReason) : null,
    nifty: plan && plan.nifty ? {
      signal: plan.nifty.signal,
      direction: plan.nifty.direction,
      reason: plan.nifty.reason,
      candle: plan.nifty.candle,
      bodyPct: plan.nifty.detail ? plan.nifty.detail.bodyPct : null,
      opposingWickPct: plan.nifty.detail ? plan.nifty.detail.opposingWickPct : null,
      favourableWickPct: plan.nifty.detail ? plan.nifty.detail.favourableWickPct : null,
      shape: plan.nifty.detail ? plan.nifty.detail.shape : null,
    } : null,
    scanRows: _scanRows(),

    quoteFailures: state.quoteFailures,
    lastQuoteError: state.lastQuoteError,
    quoteAgeSec: state.lastQuoteOkMs ? Math.round((Date.now() - state.lastQuoteOkMs) / 1000) : null,
    shortlistSize: _shortlist().size,

    dayClosed: state.dayClosed, dayClosedReason: state.dayClosedReason,
    stopOuts: state.stopOuts, maxDailyLosses: _maxDailyLosses(),
    maxDailyTrades: _maxDailyTrades(),
    dailyProfitLock: _dailyProfitLock(), maxDailyLoss: _maxDailyLoss(),

    cfg: {
      resMin: cfg.resolutionMins,
      universe: cfg.universe,
      qty: cfg.qty,
      maxConcurrent: cfg.maxConcurrent,
      targetRR: cfg.targetRR,
      entryBufferPts: cfg.entryBufferPts,
      maxSlPts: cfg.maxSlPts,
      maxGapPct: cfg.maxGapPct,
      minBodyPct: cfg.minBodyPct,
      maxOpposingWickPct: cfg.maxOpposingWickPct,
      minConfirmingStocks: cfg.minConfirmingStocks,
      sessionStart: _fmtMins(cfg.sessionStartMin),
      entryStart: _fmtMins(cfg.entryStartMin),
      entryEnd: _fmtMins(cfg.entryEndMin),
      forcedExit: _fmtMins(cfg.forcedExitMin),
      pollMs: _pollMs(),
    },

    totalPnl: data.totalPnl, capital: data.capital,
  });
});

/**
 * Chart data. EarlyBird reads ONE bar per symbol per day, so there is no candle
 * series to draw — the meaningful picture is the per-position level ladder
 * (entry / stop / target against the live price) plus the session P&L curve.
 * Sent as data, not as a candle chart that would have three bars in it.
 */
router.get("/status/chart-data", (req, res) => {
  try {
    let cum = 0;
    const equity = state.sessionTrades.map(t => {
      cum += (t.pnl || 0);
      return { t: t.exitTime || t.entryTime, pnl: _r2(cum) };
    });
    res.json({
      equity,
      ladders: _positionsView().map(p => ({
        symbol: p.symbol, side: p.side,
        entry: p.entryPrice, stop: p.stop, target: p.target, ltp: p.ltp,
      })),
      pending: _pendingView().map(p => ({
        symbol: p.symbol, side: p.side,
        entry: p.entry, stop: p.stop, target: p.target, ltp: p.ltp,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATUS PAGE
// ─────────────────────────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getEarlyBirdMode() === "EARLY_BIRD_LIVE";
  const data = loadData();
  const cfg  = earlyBird.getConfig();
  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  const universeSize = getUniverse(cfg.universe).length;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>EarlyBird — Paper</title>${faviconLink()}
<style>${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.eb-card{background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;margin-bottom:18px;}
.eb-title{font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:8px;}
.eb-row{display:flex;gap:18px;flex-wrap:wrap;font-size:0.78rem;color:#e2e8f0;}
.eb-row .k{color:var(--muted-1,#8ba1c2);margin-right:5px;}
.eb-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.7rem;font-weight:600;letter-spacing:0.03em;}
.eb-long{background:rgba(16,185,129,0.15);color:#10b981;}
.eb-short{background:rgba(239,68,68,0.15);color:#ef4444;}
.eb-none{background:rgba(148,163,184,0.15);color:#94a3b8;}
.eb-warn{font-size:0.72rem;color:#f59e0b;margin-top:8px;}
.eb-tblwrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.eb-tbl{width:100%;border-collapse:collapse;font-size:0.72rem;min-width:640px;}
.eb-tbl th{text-align:left;color:var(--muted-1,#8ba1c2);font-weight:600;padding:6px 8px;border-bottom:1px solid #1a2236;white-space:nowrap;text-transform:uppercase;font-size:0.62rem;letter-spacing:0.04em;}
.eb-tbl td{padding:6px 8px;border-bottom:1px solid #131c2e;color:#cbd5e1;white-space:nowrap;}
.eb-tbl tr:hover td{background:rgba(59,130,246,0.05);}
.eb-ok{color:#10b981;}.eb-bad{color:#ef4444;}.eb-mut{color:var(--muted-1,#8ba1c2);}
.eb-chip{display:inline-block;padding:2px 7px;border-radius:5px;background:#0d1320;border:1px solid #1a2236;font-size:0.66rem;color:#94a3b8;margin:2px 4px 2px 0;}
.eb-toggle{background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:5px 11px;border-radius:6px;font-size:0.7rem;cursor:pointer;font-family:inherit;min-height:32px;}
.eb-filter{background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:5px 9px;border-radius:6px;font-size:0.72rem;font-family:inherit;}
.rule-list{margin:8px 0 0;padding-left:18px;color:var(--muted-1,#8ba1c2);font-size:0.73rem;line-height:1.7;}
.rule-list b{color:#cbd5e1;font-weight:600;}
/* The OPTION leg. Deliberately a different colour from the stock tables — it is
   a different instrument with a different P&L basis, and reading a premium as a
   share price is the one mistake this card exists to prevent. */
.eb-optcard{border-color:#3b2a5c;background:linear-gradient(180deg,#120a22 0%,#0a1020 60%);}
.eb-opt{background:rgba(192,132,252,0.15);color:#c084fc;}
.eb-optgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px;}
.eb-optgrid .b{background:#0d1320;border:1px solid #241a3a;border-radius:7px;padding:7px 9px;}
.eb-optgrid .b .k{display:block;color:var(--muted-1,#8ba1c2);font-size:0.62rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px;}
.eb-optgrid .b .v{color:#e2e8f0;font-size:0.84rem;font-weight:600;}
/* The home-indicator strip at the bottom of a notched iPhone overlaps the last
   ~34px of the viewport. bbRsiStyleCSS()'s .main-content padding is a plain
   pixel value, so the final card sits under it — this adds the inset on top of
   whatever that padding already is, at every width (the strip is there in
   landscape too). env() is 0 on hardware without an inset, so it costs nothing
   elsewhere. Set here rather than in bbRsiStyleUI.js: that file is shared with
   BB_RSI's pages and this is an EarlyBird-scoped fix. */
.main-content{padding-bottom:calc(40px + env(safe-area-inset-bottom));}
/* Belt-and-braces against a sideways page pan: the shared .main-content already
   carries overflow-x:clip under 768px, and every wide table is inside an
   .eb-tblwrap, but a single unwrapped wide element would still drag the whole
   page. min-width:0 lets the flex child actually shrink to the viewport. */
.main-content{min-width:0;max-width:100%;}
/* Mobile — iPhone 17 Pro Max portrait is ~440px. The page body never scrolls
   sideways; wide tables scroll inside their own box. Controls stay ≥44px tall. */
@media (max-width: 640px) {
  /* bbRsiStyleCSS()'s own 640px rule sets padding:14px 12px 40px. Keep that
     12px gutter and ADD the landscape notch inset on top of it — writing the
     inset alone here would drop the gutter to 0 in portrait, where env() is 0. */
  .main-content{padding-left:calc(12px + env(safe-area-inset-left));padding-right:calc(12px + env(safe-area-inset-right));}
  .eb-card{padding:12px;border-radius:9px;}
  .eb-row{gap:8px 14px;font-size:0.74rem;}
  .eb-tbl{font-size:0.68rem;min-width:560px;}
  .eb-tbl th,.eb-tbl td{padding:5px 6px;}
  .rule-list{font-size:0.71rem;padding-left:16px;}
  .eb-toggle,.eb-filter{min-height:44px;padding:8px 12px;font-size:0.76rem;}
  /* At ~440px the option level boxes go two-up rather than shrinking to
     unreadable — the card is short enough that a second row costs nothing. */
  .eb-optgrid{grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:6px;}
  .eb-optgrid .b{padding:6px 7px;}
  .eb-optgrid .b .v{font-size:0.78rem;}
}
</style>
</head><body>
${buildSidebar('earlyBirdPaper', liveActive)}
<div class="main-content">
${bbRsiTopBar({
  title: "🐦 EarlyBird — Paper",
  metaLine: `${earlyBird.tradesStock(cfg)
      ? `NSE CASH EQUITY of F&O stocks · NIFTY is the filter, never traded · ${cfg.qty} shares × up to ${cfg.maxConcurrent} stocks`
      : `NIFTY ${_itmStepsLabel()} CE/PE · ${cfg.optionLots} lot(s) · no stock is scanned`} · the ${_fmtMins(cfg.sessionStartMin)} ${cfg.resolutionMins}-min candle decides the whole day · target 1:${cfg.targetRR} · square-off ${_fmtMins(cfg.forcedExitMin)}`,
  running: state.running,
  primaryAction: { href: "/early-bird-paper/start", label: "▶ Start", color: "#0369a1" },
  stopAction:    { href: "/early-bird-paper/stop",  label: "■ Stop" },
  historyHref: "/early-bird-paper/history",
  resetJs: "ebHandleReset(this)",
})}

${bbRsiCapitalStrip({ starting: startCap, current: startCap + (data.totalPnl || 0), allTime: data.totalPnl || 0 })}

<div class="eb-card">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div class="eb-title" style="margin-bottom:0;">The day's decision — made once at ${_fmtMins(cfg.sessionStartMin + cfg.resolutionMins)}</div>
    <div style="font-size:0.78rem;color:#94a3b8;" id="eb-feed">feed —</div>
  </div>
  <div class="eb-row" id="eb-plan" style="margin-top:10px;"><div>Waiting for the ${_fmtMins(cfg.sessionStartMin)} candle to close…</div></div>
  <div id="eb-nifty" style="font-size:0.73rem;color:var(--muted-1,#8ba1c2);margin-top:8px;"></div>
  <div id="eb-quotewarn" class="eb-warn"></div>
  ${state.dayClosed ? `<div class="eb-warn">⏸️ ${state.dayClosedReason}</div>` : ""}
  <ul class="rule-list">
    <li><b>1. NIFTY's first candle picks the side.</b> It has to be a strong candle — the body at least ${cfg.minBodyPct}% of the whole candle, and the wick pushing back against the move under ${cfg.maxOpposingWickPct}%. ${earlyBird.tradesStock(cfg) && earlyBird.tradesOption(cfg)
      ? "Green = buy stocks + a CE, red = short stocks + buy a PE"
      : earlyBird.tradesStock(cfg) ? "Green = buy stocks, red = short stocks" : "Green = buy a CE, red = buy a PE"}. Anything weaker and the day is skipped.</li>
    ${earlyBird.tradesStock(cfg)
      ? `<li><b>2. Then pick the stocks.</b> A stock joins in only if its own first candle looks the same and points the same way as NIFTY, and it did not open more than ${cfg.maxGapPct}% away from yesterday's close. At least ${cfg.minConfirmingStocks} must qualify, and at most ${cfg.maxConcurrent} are traded.${earlyBird.tradesOption(cfg) ? " The NIFTY option leg does not wait for this — it trades even if no stock qualifies." : ""}</li>`
      : `<li><b>2. No stocks are checked.</b> This mode trades NIFTY's own candle, so it does not wait for any stock to agree. The stock list, the gap rule and the confirming count do nothing here.</li>`}
    <li><b>3. Enter ₹${cfg.entryBufferPts} beyond that candle</b> — above it on a green day, below it on a red one. The order waits there and fills the moment price reaches it. The <b>stop</b> sits ₹${cfg.entryBufferPts} beyond the other end of the candle — or on the candle's body instead, if the candle was so big that the wick would risk more than ₹${cfg.maxSlPts}. The <b>target</b> is ${cfg.targetRR}× whatever the stop is risking.</li>
    <li><b>4. Exit.</b> Whichever comes first — target, stop, or ${_fmtMins(cfg.forcedExitMin)} square-off. No new trades after ${_fmtMins(cfg.entryEndMin)}. The stop never moves once set, and a stopped-out name is not re-entered that day.</li>
  </ul>
</div>

${bbRsiStatGrid([
  { label: "Session P&L", value: inr(state.sessionPnl), color: state.sessionPnl >= 0 ? "#10b981" : "#ef4444" },
  { label: "Open / Cap", value: `${state.positions.size}/${cfg.maxConcurrent}` },
  { label: "Trades", value: `${state.tradesTaken}/${_maxDailyTrades()}` },
  { label: "W / L", value: `${wins} / ${losses}` },
  ...(earlyBird.tradesStock(cfg)
    ? [{ label: "Universe", value: `${cfg.universe} (${universeSize})` },
       { label: "Qty / stock", value: String(cfg.qty) }]
    : [{ label: "Instrument", value: "NIFTY option" },
       { label: "Lots", value: String(cfg.optionLots) }]),
])}

${earlyBird.tradesOption(cfg) ? `
<div class="eb-card eb-optcard">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div class="eb-title" style="margin-bottom:0;color:#c084fc;">🎟️ NIFTY option leg — ${cfg.tradeMode === "option" ? "the ONLY leg today" : "runs alongside the stock leg, independently"}</div>
    <div class="eb-pill eb-opt" id="eb-optstate">waiting</div>
  </div>
  <div style="font-size:0.73rem;color:var(--muted-1,#8ba1c2);margin-top:8px;line-height:1.6;">
    <b style="color:#cbd5e1;">No stock confirmation is used for this leg.</b> If NIFTY's own ${_fmtMins(cfg.sessionStartMin)} candle is a signal candle we buy ONE NIFTY ${"CE"} (bullish) or ${"PE"} (bearish), ${cfg.optionLots} lot(s) = ${_optionQty(cfg)} qty.
    The trigger, the stop and the 1:${cfg.targetRR} target are all <b style="color:#cbd5e1;">NIFTY SPOT levels</b>; the <b style="color:#cbd5e1;">P&amp;L is on the premium</b>, so a bought PE gains when spot falls. One trade per day, no re-entry, and it does not use a slot of the ${cfg.maxConcurrent}-stock cap.
  </div>
  <div class="eb-optgrid" id="eb-optsetup" style="margin-top:10px;"><div class="eb-mut">Waiting for the ${_fmtMins(cfg.sessionStartMin)} candle to close…</div></div>
  <div id="eb-optreason" style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-top:8px;"></div>
  <div class="eb-tblwrap" style="margin-top:10px;"><table class="eb-tbl">
    <thead><tr><th>Contract</th><th>Side</th><th>Qty</th><th>Entry ₹</th><th>Now ₹</th><th>P&amp;L</th><th>Spot in</th><th>SL spot</th><th>Tgt spot</th><th>Held</th></tr></thead>
    <tbody id="eb-opttbody"><tr><td colspan="10" class="eb-mut">No option position.</td></tr></tbody>
  </table></div>
</div>` : ""}

<div class="eb-card">
  <div class="eb-title">Open positions${earlyBird.tradesOption(cfg) ? " — stock leg" : ""} <span id="eb-poscount" class="eb-mut"></span></div>
  <div class="eb-tblwrap"><table class="eb-tbl">
    <thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>LTP</th><th>Stop</th><th>Target</th><th>Live P&L</th><th>Held</th><th>SL basis</th></tr></thead>
    <tbody id="eb-postbody"><tr><td colspan="10" class="eb-mut">No open positions.</td></tr></tbody>
  </table></div>
</div>

<div class="eb-card">
  <div class="eb-title">Pending setups — armed, waiting for the trigger <span id="eb-pendcount" class="eb-mut"></span></div>
  <div class="eb-tblwrap"><table class="eb-tbl">
    <thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>LTP</th><th>Distance</th><th>Stop</th><th>Target</th><th>Risk/sh</th><th>Gap %</th><th>Shape</th></tr></thead>
    <tbody id="eb-pendtbody"><tr><td colspan="10" class="eb-mut">Nothing armed yet.</td></tr></tbody>
  </table></div>
  <div id="eb-dropped" style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-top:8px;"></div>
</div>

<div class="eb-card">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div class="eb-title" style="margin-bottom:0;">Morning scan funnel — every symbol, every reason</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <input id="eb-scansearch" class="eb-filter" placeholder="Search symbol…" oninput="ebRenderScan()" style="width:150px;"/>
      <select id="eb-scanfilter" class="eb-filter" onchange="ebRenderScan()"><option value="">All</option><option value="accepted">Accepted only</option></select>
      <button class="eb-toggle" id="eb-scantoggle" onclick="ebToggleScan()">Show table</button>
    </div>
  </div>
  <div id="eb-scansummary" style="margin-top:10px;font-size:0.73rem;color:var(--muted-1,#8ba1c2);">The scan runs once, a few seconds after ${_fmtMins(cfg.sessionStartMin + cfg.resolutionMins)}.</div>
  <div id="eb-scangroups" style="margin-top:8px;"></div>
  <div id="eb-scanbox" style="display:none;margin-top:10px;">
    <div class="eb-tblwrap"><table class="eb-tbl">
      <thead><tr><th>Symbol</th><th>Verdict</th><th>Side</th><th>O</th><th>H</th><th>L</th><th>C</th><th>Entry</th><th>Stop</th><th>Target</th><th>Risk</th><th>Gap %</th><th>Reason</th></tr></thead>
      <tbody id="eb-scantbody"></tbody>
    </table></div>
    <div id="eb-scanmore" style="margin-top:8px;"></div>
  </div>
</div>

${bbRsiActivityLog({ logsJSON: JSON.stringify(state.log.slice(-400)) })}
</div>
<script>
${modalJS()}

// Wipes every stored EarlyBird paper session and puts capital back to
// FYERS_INV_AMOUNT. The server refuses while a session is running, so the
// button only ever has to handle a stopped engine plus the double confirm.
async function ebHandleReset(btn){
  var ok = await showDoubleConfirm({
    icon: '⚠️', title: 'Reset EarlyBird Paper Trade',
    message: 'Reset ALL EarlyBird paper trade history?\\nThis wipes all sessions and restores starting capital.\\nCannot be undone.',
    confirmText: 'Reset All', confirmClass: 'modal-btn-danger',
    subject: 'ALL EarlyBird paper sessions & capital',
    secondConfirmText: 'Yes, reset all'
  });
  if (!ok) return;
  if (btn) { btn.textContent = '⏳...'; btn.disabled = true; }
  try {
    var res = await secretFetch('/early-bird-paper/reset');
    if (!res) { if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; } return; }
    var data;
    try { data = await res.json(); } catch(_) { data = { success: false, error: 'Server error (status ' + res.status + ')' }; }
    if (!data.success) {
      if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; }
      await showAlert({ icon: '❌', title: 'Reset Failed', message: data.error || 'Reset failed', btnClass: 'modal-btn-danger' });
      return;
    }
    location.reload();
  } catch(e) {
    if (btn) { btn.textContent = '↺ Reset'; btn.disabled = false; }
    await showAlert({ icon: '❌', title: 'Reset Failed', message: e.message, btnClass: 'modal-btn-danger' });
  }
}

var EB_SCAN = [], EB_SCAN_OPEN = false, EB_SCAN_LIMIT = 80;

function ebEsc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function ebNum(v){ return (typeof v === 'number' && isFinite(v)) ? v : null; }
function ebFmt(v){ var n = ebNum(v); return n === null ? '—' : String(n); }
function ebMoney(v){ var n = ebNum(v); return n === null ? '—' : (n >= 0 ? '+' : '') + '₹' + n.toFixed(0); }

function ebToggleScan(){
  EB_SCAN_OPEN = !EB_SCAN_OPEN;
  document.getElementById('eb-scanbox').style.display = EB_SCAN_OPEN ? 'block' : 'none';
  document.getElementById('eb-scantoggle').textContent = EB_SCAN_OPEN ? 'Hide table' : 'Show table';
  if (EB_SCAN_OPEN) ebRenderScan();
}

function ebRenderScan(){
  if (!EB_SCAN_OPEN) return;
  var q = (document.getElementById('eb-scansearch').value || '').toUpperCase();
  var f = document.getElementById('eb-scanfilter').value;
  var rows = EB_SCAN.filter(function(r){
    if (f === 'accepted' && r.verdict !== 'ACCEPTED') return false;
    if (q && String(r.symbol || '').indexOf(q) < 0) return false;
    return true;
  });
  var shown = rows.slice(0, EB_SCAN_LIMIT);
  var tb = document.getElementById('eb-scantbody');
  if (!shown.length) { tb.innerHTML = '<tr><td colspan="13" class="eb-mut">No rows.</td></tr>'; document.getElementById('eb-scanmore').innerHTML = ''; return; }
  tb.innerHTML = shown.map(function(r){
    var vc = r.verdict === 'ACCEPTED' ? 'eb-ok' : 'eb-mut';
    return '<tr><td>' + ebEsc(r.symbol) + '</td>'
      + '<td class="' + vc + '">' + ebEsc(r.verdict) + '</td>'
      + '<td>' + ebEsc(r.side || '—') + '</td>'
      + '<td>' + ebFmt(r.open) + '</td><td>' + ebFmt(r.high) + '</td><td>' + ebFmt(r.low) + '</td><td>' + ebFmt(r.close) + '</td>'
      + '<td>' + ebFmt(r.entry) + '</td><td>' + ebFmt(r.stop) + '</td><td>' + ebFmt(r.target) + '</td>'
      + '<td>' + ebFmt(r.riskPts) + '</td><td>' + ebFmt(r.gapPct) + '</td>'
      + '<td class="eb-mut" style="white-space:normal;">' + ebEsc(r.reason) + '</td></tr>';
  }).join('');
  document.getElementById('eb-scanmore').innerHTML = rows.length > shown.length
    ? '<button class="eb-toggle" onclick="EB_SCAN_LIMIT += 200; ebRenderScan();">Show more (' + (rows.length - shown.length) + ' hidden)</button>'
    : '';
}

/* The OPTION leg card. Every element it touches only exists when the mode
   trades options, so the whole function no-ops in the default stock mode. */
function ebRenderOption(d){
  var box = document.getElementById('eb-optsetup');
  if (!box) return;                       /* stock mode — the card is not rendered */
  var o = d.option;
  var st = document.getElementById('eb-optstate');
  var rs = document.getElementById('eb-optreason');
  var tb = document.getElementById('eb-opttbody');

  if (!o) {
    box.innerHTML = '<div class="eb-mut">Option leg is off for this mode.</div>';
    if (st) st.textContent = 'off';
    return;
  }

  var s = o.setup;
  if (!s) {
    box.innerHTML = '<div class="eb-mut">The scan runs once, a few seconds after the opening candle closes.</div>';
    if (st) st.textContent = d.planBuilt ? 'no setup' : 'waiting';
  } else if (!s.ok) {
    box.innerHTML = '<div class="eb-mut">No option trade today — the NIFTY opening candle is not a signal candle.</div>';
    if (st) st.textContent = 'no signal';
  } else {
    var cell = function(k, v){ return '<div class="b"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; };
    box.innerHTML =
      cell('Buy', ebEsc(s.optionSide) + ' <span class="eb-mut" style="font-weight:400;">(' + ebEsc(s.side) + ')</span>')
      + cell('Entry spot', ebFmt(s.entry))
      + cell('Stop spot', ebFmt(s.stop))
      + cell('Target spot', ebFmt(s.target))
      + cell('Risk / reward', ebFmt(s.riskPts) + ' / ' + ebFmt(s.rewardPts) + ' pt')
      + cell('NIFTY now', ebFmt(o.spot))
      + (o.distance !== null && o.distance !== undefined ? cell('Spot to go', ebFmt(o.distance) + ' pt') : '')
      + cell('Size', ebFmt(o.lots) + ' lot × ' + ebFmt(o.lotQty));
    if (st) st.textContent = o.position ? 'in position' : o.triggered ? 'done for the day' : o.armed ? 'armed — waiting for the trigger' : 'not armed';
  }

  if (rs) {
    var bits = [];
    if (s && s.reason) bits.push(s.reason);
    if (s && s.ok && s.bigCandle) bits.push('BIG-CANDLE rule moved the stop onto the candle body (' + ebEsc(s.slBasis) + ').');
    if (o.dropped) bits.push('Never triggered: spot did not reach ' + ebFmt(o.dropped.entry) + ' inside the entry window' + (o.dropped.lastSpot != null ? ' (last spot ' + ebFmt(o.dropped.lastSpot) + ')' : '') + '.');
    if (o.ltpFails) bits.push('Premium unavailable ' + o.ltpFails + '× — the entry is deferred, never taken without a fill price.');
    rs.textContent = bits.join(' ');
  }

  if (tb) {
    var p = o.position;
    if (!p) {
      tb.innerHTML = '<tr><td colspan="10" class="eb-mut">' + (o.triggered ? 'Option trade closed — no re-entry today.' : 'No option position.') + '</td></tr>';
    } else {
      var pc = (typeof p.livePnl === 'number' && p.livePnl < 0) ? 'eb-bad' : 'eb-ok';
      tb.innerHTML = '<tr><td>' + ebEsc(p.symbol) + '</td>'
        + '<td><span class="eb-pill eb-opt">' + ebEsc(p.optionSide) + '</span></td>'
        + '<td>' + ebFmt(p.qty) + '</td>'
        + '<td>' + ebFmt(p.optionEntryLtp) + '</td>'
        + '<td>' + (p.optionLtp === null ? '<span class="eb-mut">—</span>' : ebFmt(p.optionLtp)) + '</td>'
        + '<td class="' + pc + '">' + ebMoney(p.livePnl) + '</td>'
        + '<td>' + ebFmt(p.entrySpot) + '</td>'
        + '<td>' + ebFmt(p.stop) + '</td><td>' + ebFmt(p.target) + '</td>'
        + '<td>' + ebFmt(p.heldSec) + 's</td></tr>';
    }
  }
}

async function ebRefresh(){
  try {
    var r = await fetch('/early-bird-paper/status/data', { cache: 'no-store' });
    var d = await r.json();

    var feed = document.getElementById('eb-feed');
    if (feed) feed.textContent = 'quotes: ' + d.shortlistSize + ' symbol(s)'
      + (d.quoteAgeSec != null ? ' · ' + d.quoteAgeSec + 's ago' : ' · none yet')
      + (d.lastTickPrice != null ? '  ·  NIFTY ' + d.lastTickPrice : '');

    var plan = document.getElementById('eb-plan');
    if (plan) {
      var cells = [];
      var sc = d.side === 'LONG' ? 'eb-long' : d.side === 'SHORT' ? 'eb-short' : 'eb-none';
      cells.push('<div><span class="k">Day</span><span class="eb-pill ' + sc + '">' + (d.side || 'no side') + '</span></div>');
      cells.push('<div><span class="k">Scanned</span>' + d.scanned + '</div>');
      cells.push('<div><span class="k">Confirmed</span>' + d.confirming + '</div>');
      cells.push('<div><span class="k">Rejected</span>' + d.rejectedCount + '</div>');
      cells.push('<div><span class="k">Open</span>' + (d.positions || []).length + ' / ' + d.maxConcurrent + '</div>');
      cells.push('<div><span class="k">Pending</span>' + (d.pending || []).length + '</div>');
      cells.push('<div><span class="k">Open P&L</span>' + ebMoney(d.openPnl) + '</div>');
      if (!d.planBuilt) cells.push('<div class="eb-mut">scan not run yet' + (d.planInFlight ? ' (running…)' : d.planAttempts ? ' — ' + d.planAttempts + ' attempt(s)' : '') + '</div>');
      plan.innerHTML = cells.join('');
    }

    var nf = document.getElementById('eb-nifty');
    if (nf) {
      if (d.nifty && d.nifty.candle) {
        var c = d.nifty.candle;
        nf.textContent = 'NIFTY ' + (d.cfg ? d.cfg.sessionStart : '') + ' candle — O ' + ebFmt(c.open) + ' H ' + ebFmt(c.high) + ' L ' + ebFmt(c.low) + ' C ' + ebFmt(c.close)
          + ' · body ' + ebFmt(d.nifty.bodyPct) + '% · opposing wick ' + ebFmt(d.nifty.opposingWickPct) + '% · ' + (d.nifty.reason || '');
      } else {
        nf.textContent = d.planReason || '';
      }
    }

    var qw = document.getElementById('eb-quotewarn');
    if (qw) qw.textContent = d.quoteFailures >= 3
      ? '⚠️ Quote poll has failed ' + d.quoteFailures + '× in a row (' + (d.lastQuoteError || 'unknown') + '). Open positions are not being priced — exits cannot fire until quotes return.'
      : '';

    ebRenderOption(d);

    var pos = d.positions || [];
    document.getElementById('eb-poscount').textContent = pos.length ? '(' + pos.length + ')' : '';
    document.getElementById('eb-postbody').innerHTML = pos.length ? pos.map(function(p){
      var pc = (typeof p.livePnl === 'number' && p.livePnl < 0) ? 'eb-bad' : 'eb-ok';
      return '<tr><td>' + ebEsc(p.symbol) + '</td>'
        + '<td><span class="eb-pill ' + (p.side === 'LONG' ? 'eb-long' : 'eb-short') + '">' + ebEsc(p.side) + '</span></td>'
        + '<td>' + ebFmt(p.qty) + '</td><td>' + ebFmt(p.entryPrice) + '</td>'
        + '<td>' + (p.stale ? '<span class="eb-bad">stale</span>' : ebFmt(p.ltp)) + '</td>'
        + '<td>' + ebFmt(p.stop) + '</td><td>' + ebFmt(p.target) + '</td>'
        + '<td class="' + pc + '">' + ebMoney(p.livePnl) + '</td>'
        + '<td>' + ebFmt(p.heldSec) + 's</td>'
        + '<td class="eb-mut">' + ebEsc(p.slBasis) + '</td></tr>';
    }).join('') : '<tr><td colspan="10" class="eb-mut">No open positions.</td></tr>';

    var pend = d.pending || [];
    document.getElementById('eb-pendcount').textContent = pend.length ? '(' + pend.length + ')' : '';
    document.getElementById('eb-pendtbody').innerHTML = pend.length ? pend.map(function(p){
      return '<tr><td>' + ebEsc(p.symbol) + '</td>'
        + '<td><span class="eb-pill ' + (p.side === 'LONG' ? 'eb-long' : 'eb-short') + '">' + ebEsc(p.side) + '</span></td>'
        + '<td>' + ebFmt(p.entry) + '</td><td>' + ebFmt(p.ltp) + '</td><td>' + ebFmt(p.distance) + '</td>'
        + '<td>' + ebFmt(p.stop) + '</td><td>' + ebFmt(p.target) + '</td><td>' + ebFmt(p.riskPts) + '</td>'
        + '<td>' + ebFmt(p.gapPct) + '</td><td class="eb-mut">' + ebEsc(p.shape) + '</td></tr>';
    }).join('') : '<tr><td colspan="10" class="eb-mut">Nothing armed yet.</td></tr>';

    var drop = d.dropped || [];
    document.getElementById('eb-dropped').textContent = drop.length
      ? 'Never triggered: ' + drop.map(function(x){ return x.symbol + ' (' + x.side + ' @ ' + x.entry + ')'; }).join(', ')
      : '';

    EB_SCAN = d.scanRows || [];
    var ss = document.getElementById('eb-scansummary');
    if (ss) ss.textContent = d.planBuilt
      ? d.scanned + ' scanned → ' + d.confirming + ' confirmed → ' + d.rejectedCount + ' rejected. ' + (d.planReason || '')
      : 'The scan runs once, a few seconds after the opening candle closes.' + (d.planInFlight ? ' Running now…' : '');
    var gb = document.getElementById('eb-scangroups');
    if (gb) {
      var g = d.rejectGroups || {};
      var keys = Object.keys(g).sort(function(a,b){ return g[b] - g[a]; });
      gb.innerHTML = keys.map(function(k){ return '<span class="eb-chip">' + ebEsc(k) + ' × ' + g[k] + '</span>'; }).join('');
    }
    ebRenderScan();
  } catch (e) {}
}
ebRefresh();
setInterval(ebRefresh, 4000);
</script>
</body></html>`;
  res.send(html);
});

// ── History + daily-file viewers + restore + reset ────────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = sharedSocketState.getEarlyBirdMode() === "EARLY_BIRD_LIVE";
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  res.send(renderHistoryPage({
    routePrefix: "/early-bird-paper",
    allowDailyFileDelete: true,
    sidebarKey: "earlyBirdHistory",
    pageTitle: "🐦 EarlyBird Paper Trade History",
    pageDocTitle: "EarlyBird Paper — History",
    modalLabel: "EarlyBird Paper",
    broker: "fyers",
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap,
    emptyLabel: "Start EarlyBird paper trading to record your first session.",
  }));
});

const _EB_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/download/daily-files", (req, res) => {
  const skips  = skipLogger.listDates(MODE_KEY);
  const trades = tradeLogger.listDailyDates(MODE_KEY);
  const byDate = new Map();
  for (const s of skips)  byDate.set(s.date, { date: s.date, skipsSize: s.size, tradesSize: 0 });
  for (const t of trades) { const row = byDate.get(t.date) || { date: t.date, skipsSize: 0, tradesSize: 0 }; row.tradesSize = t.size; byDate.set(t.date, row); }
  const rows = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  res.json(dailyFilesPaginate(rows, req.query));
});

router.get("/download/skips-all", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="early_bird_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates(MODE_KEY).map(d => d.date).sort();
  let body = "";
  for (const d of dates) { try { const p = skipLogger.filePathFor(MODE_KEY, d); if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8"); } catch (_) {} }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_EB_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `early_bird_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_EB_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `early_bird_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_EB_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_EB_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop EarlyBird paper trading first before deleting a session." });
  const data = loadData();
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= (data.sessions || []).length) return res.status(400).json({ success: false, error: "Invalid session index." });
  data.sessions.splice(idx, 1);
  data.totalPnl = _r2(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0));
  data.capital  = _r2(parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl);
  saveData(data);
  return res.json({ success: true, message: "Session deleted successfully." });
});

router.post("/restore-session/:date", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop EarlyBird paper trading before restoring." });
  const date = String(req.params.date || "").trim();
  if (!_EB_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades(MODE_KEY, date);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; if (key) seen.add(String(key)); }
  const missing = allTrades.filter(t => { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; return key && !seen.has(String(key)); });
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = _r2(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0));
  data.sessions.push({ date, strategy: (missing[0] && missing[0].strategy) || STRATEGY_NAME, pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  data.totalPnl = _r2(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0));
  data.capital  = _r2(parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl);
  saveData(data);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

// Delete one day's JSONL files (trade + skip). The session rows in
// early_bird_paper_trades.json are deleted separately from the Sessions table;
// this only removes the raw day files, which is also what /restore-session
// rebuilds from — so deleting here makes that day unrecoverable.
router.post("/daily-files/:date", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop EarlyBird paper trading before deleting daily files." });
  const date = String(req.params.date || "").trim();
  if (!_EB_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const removed = [];
  const failed  = [];
  for (const [label, p] of [["trades", tradeLogger.dailyFilePathFor(MODE_KEY, date)], ["skips", skipLogger.filePathFor(MODE_KEY, date)]]) {
    try { if (p && fs.existsSync(p)) { fs.unlinkSync(p); removed.push(label); } }
    catch (e) { failed.push(`${label}: ${e.message}`); }
  }
  if (failed.length) return res.status(500).json({ success: false, error: `Could not delete — ${failed.join("; ")}` });
  if (!removed.length) return res.status(404).json({ success: false, error: `No daily files found for ${date}.` });
  console.log(`🗑️ ${LOG_TAG} Deleted daily file(s) for ${date}: ${removed.join(" + ")}`);
  return res.json({ success: true, removed, message: `Deleted ${removed.join(" + ")} file(s) for ${date}.` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop EarlyBird paper trading before resetting." });
  const fresh = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  // The status page reads Session P&L / trades / W-L off the in-memory state,
  // not off the file — wiping only the file left the last stopped session's
  // numbers on screen. Safe to reset wholesale: we already refused above
  // unless the engine is stopped.
  state = _freshState();
  return res.json({ success: true, message: `EarlyBird paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
});

router.get("/download/trades.jsonl", (req, res) => {
  try {
    const data = loadData();
    const records = [];
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) records.push(Object.assign({ date: s.date, mode: MODE_KEY, strategy: s.strategy }, t));
    const today = new Date().toISOString().slice(0, 10);
    const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
    if (ai) {
      const md = aiExport.buildMarkdown(records, { title: "EarlyBird paper trades (full log)", source: "early-bird-paper" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="early_bird_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="early_bird_paper_trades_${today}.jsonl"`);
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

module.exports = router;
module.exports.stopSession = stopSession;
// Exposed for offline unit-testing — these decide which price every exit is
// measured against and which previous close the gap rule sees, so they are
// tested rather than trusted.
module.exports.attributeQuotes = attributeQuotes;
module.exports._prevCloseFrom  = _prevCloseFrom;
// OPTION LEG test hooks. The leg's entry price, exit and P&L sign cannot be
// exercised through an HTTP route (they need a tick feed and a broker), and the
// PE-profits-when-spot-falls case is precisely the one a plausible-looking edit
// would get backwards — so it is tested rather than trusted.
module.exports.__armOptionSetup = _armOptionSetup;
module.exports.__stepOptionLeg  = _stepOptionLeg;
module.exports.__optionView     = _optionView;
Object.defineProperty(module.exports, "__state", { get() { return state; } });
module.exports._acquireSlot      = _acquireSlot;       // exported for the rate-limiter test
module.exports._resetRateLimiter = _resetRateLimiter;

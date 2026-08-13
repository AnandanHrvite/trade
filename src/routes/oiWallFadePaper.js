/**
 * OI WALL FADE PAPER — /oi-wall-fade-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL surface. Every decision / fill / exit semantic for OI_WALL_FADE
 * lives here; the live harness must match THIS, never the reverse (see
 * feedback_paper_logic_untouchable).
 *
 * The day in one paragraph: the option chain recorder polls the ATM±N strikes
 * every few seconds and feeds services/oiChain.js, which knows the highest-OI CE
 * strike (the resistance wall) and the highest-OI PE strike (the support wall).
 * When a closed 5-minute NIFTY 50 candle presses one of those walls, the wall's
 * own OI is still RISING (writers holding), and the candle closes back away from
 * it, the wall is faded: buy a PE at the CE wall, a CE at the PE wall, target the
 * mid-band, stop OIWF_SL_BUFFER_PTS beyond the wall.
 *
 * TWO DATA SOURCES, TWO JOBS:
 *   • NIFTY 50 INDEX candles (Fyers HISTORY endpoint, closed bars only) — the
 *     PRICE half of the decision, and every exit level. The shared spot
 *     WebSocket supplies the live index price that those levels are tested
 *     against, tick by tick.
 *   • services/oiChain.js — the OI half. LIVE in-memory ladder, filled by
 *     utils/optionChainRecorder.js. Nothing here fetches OI itself.
 *
 * THIS STRATEGY CANNOT RUN WITHOUT THE CHAIN RECORDER. /start refuses when
 * OPTION_CHAIN_RECORDER_ENABLED or OPTION_CHAIN_RECORD_OI is off, because the
 * ladder would stay empty and the session would sit mute all day looking healthy.
 *
 * Exits, in the order they are tested on every index tick:
 *   1. stop    — the FROZEN level beyond the faded wall. Never moves.
 *   2. target  — the FROZEN mid-band level. Never moves.
 *   3. EOD square-off at OIWF_FORCED_EXIT
 * There is deliberately NO trail, NO breakeven jump, NO time stop, NO premium
 * stop, NO partial booking and NO OI-based exit — a wall that starts shedding
 * mid-trade does not close the position. The user's rule is two levels and an EOD.
 *
 * Day-level breakers: OIWF_MAX_DAILY_TRADES, OIWF_MAX_DAILY_LOSS,
 * OIWF_DAILY_PROFIT_LOCK and OIWF_MAX_DAILY_LOSSES stop-outs.
 *
 * Signal engine: src/strategies/oi_wall_fade.js (shared by paper, the live
 * harness and replay — no rule is re-implemented in this file).
 *
 * Uses LIVE data but SIMULATES orders locally.
 * Endpoints: /start /stop /exit /status /status/data /status/chart-data
 *            /history /reset /session/:i /restore-session/:date /download/... /view/...
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const oiStrategy         = require("../strategies/oi_wall_fade");
const oiChain            = require("../services/oiChain");
const optionChainRecorder = require("../utils/optionChainRecorder");
const instrumentConfig   = require("../config/instrument");
const sharedSocketState  = require("../utils/sharedSocketState");
const socketManager      = require("../utils/socketManager");
const tickRecorder       = require("../utils/tickRecorder");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { renderHistoryPage, dailyFilesPaginate } = require("../utils/paperHistoryUI");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiCapitalStrip, bbRsiStatGrid, bbRsiCurrentBar, bbRsiActivityLog, inr } = require("../utils/bbRsiStyleUI");
const { isTradingAllowed } = require("../utils/nseHolidays");
const tradeLogger = require("../utils/tradeLogger");
const aiExport    = require("../utils/aiExport");
const fyers       = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, notifyDayReport } = require("../utils/notify");
const { getCharges } = require("../utils/charges");
const { getISTMinutes, getBucketStart } = require("../utils/tradeUtils");
const skipLogger = require("../utils/skipLogger");
const capitalPool = require("../utils/capitalPool");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID        = "oiWallFadePaper";
const MODE_KEY           = "oi_wall_fade";     // tradeLogger / skipLogger key

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const PT_FILE  = path.join(DATA_DIR, "oi_wall_fade_paper_trades.json");

// ── Config readers (Settings mutates process.env live — never cache) ──────────
function _resMin() { return oiStrategy.getConfig().resolutionMins; }
function _parseMins(envKey, fallback) {
  return oiStrategy._parseHHMM(process.env[envKey], oiStrategy._parseHHMM(fallback, 0));
}
function _envStr(key, fallback) { return String(process.env[key] || fallback); }
function _maxDailyTrades()  { return Math.max(1, parseInt(process.env.OIWF_MAX_DAILY_TRADES || "3", 10) || 3); }
function _maxDailyLosses()  { return Math.max(0, parseInt(process.env.OIWF_MAX_DAILY_LOSSES || "2", 10)); }
function _maxDailyLoss()    { return parseFloat(process.env.OIWF_MAX_DAILY_LOSS    || "3000"); }
function _dailyProfitLock() { return parseFloat(process.env.OIWF_DAILY_PROFIT_LOCK || "0"); }
function _maxWeeklyLoss()   { return parseFloat(process.env.OIWF_MAX_WEEKLY_LOSS   || "0"); }
function _optPollMs() {
  const v = parseInt(process.env.OIWF_OPT_POLL_MS || "2000", 10);
  return Number.isFinite(v) && v >= 500 && v <= 30000 ? v : 2000;
}
/**
 * How long after a bar closes before the Fyers history endpoint is asked for it.
 * Fetching the instant the clock ticks over often returns the bar still one
 * short, which would silently delay every decision by a whole bar.
 */
function _historyLagMs() {
  const v = parseInt(process.env.OIWF_HISTORY_LAG_MS || "5000", 10);
  return Number.isFinite(v) && v >= 0 && v <= 60000 ? v : 5000;
}

/**
 * Position size. OIWF_LOT_MULTIPLIER (when > 0) overrides the global
 * LOT_MULTIPLIER for this strategy only, clamped by the same MAX_LOT_MULTIPLIER
 * ceiling. Divides by the multiplier getLotQty ACTUALLY applied (it clamps
 * internally), not the raw env value. Default 0 = use the common setting.
 */
function oiLotQty() {
  const base = instrumentConfig.getLotQty();
  const raw  = parseInt(process.env.OIWF_LOT_MULTIPLIER || "0", 10);
  if (!Number.isFinite(raw) || raw <= 0) return base;

  let maxMult = parseInt(process.env.MAX_LOT_MULTIPLIER || "10", 10);
  if (!Number.isFinite(maxMult) || maxMult < 1) maxMult = 10;

  let globalMult = parseInt(process.env.LOT_MULTIPLIER || "1", 10);
  if (!Number.isFinite(globalMult) || globalMult <= 0) globalMult = 1;
  if (globalMult > maxMult) globalMult = maxMult;

  return Math.round((base / globalMult) * Math.min(raw, maxMult));
}

/**
 * The OI ladder as the engine will see it. Spot comes from THIS session's tick
 * feed when we have one and from the recorder otherwise, so the ATM marker is
 * right even before the first tick arrives.
 */
function oiSnapshot() {
  let spot = state.lastTickPrice;
  if (!(typeof spot === "number" && spot > 0)) {
    try { spot = optionChainRecorder.getStats().lastSpot; } catch (_) { spot = null; }
  }
  try { return oiChain.snapshot({ spot, lookbacks: [1, oiStrategy.getConfig().oiLookback, 6] }); }
  catch (_) { return null; }
}

/** Is the per-strike OI feed actually on? Both flags are needed for a ladder. */
function chainRecorderState() {
  try {
    const s = optionChainRecorder.getStats();
    return { ok: !!s.enabled && !!s.oiEnabled, enabled: !!s.enabled, oiEnabled: !!s.oiEnabled, failStreak: s.failStreak || 0 };
  } catch (_) {
    return { ok: false, enabled: false, oiEnabled: false, failStreak: 0 };
  }
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
    console.error("[oi-wall-fade-paper] oi_wall_fade_paper_trades.json corrupt — resetting:", e.message);
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
    tradesTaken:    0,
    stopOuts:       0,
    consecutiveLosses: 0,
    // INDEX bars — the decision series. Closed bars only, from the history API.
    candles:        [],
    lastClosedBarTime: null,
    formingBar:     null,   // display-only: built from the live tick feed
    tickCount:      0,
    lastTickTime:   null,
    lastTickPrice:  null,   // NIFTY 50 INDEX — what every exit is measured against
    position:       null,
    optionLtp:      null,
    optionLtpUpdatedAt: null,
    log:            [],
    _sessionId:     null,
    // OI_WALL_FADE specific
    lastSignal:     null,
    lastBand:       null,   // the most recent wall band, for the UI
    dayClosed:      false,
    dayClosedReason: null,
    _histInFlight:  false,
    _histBucket:    null,   // bucket whose history fetch has already been done
    _histFailures:  0,
    _histNextTryMs: null,   // backoff floor after a failed history fetch
    _entryInFlight: false,
    _lastEntryAttemptMs: null,
    _pendingEntry:  null,   // a signalled entry whose FILL failed — retried per poll
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

// ── Crash/restart recovery: rehydrate today's in-memory session from JSONL ─────
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
    // Must match the exit reason _checkExits actually writes — "CE wall 24800
    // broke — stop 24825 hit (…)". A pattern that misses it silently rearms the
    // OIWF_MAX_DAILY_LOSSES breaker after a restart, so a day that had already
    // spent its stop-outs would be allowed to take them again.
    state.stopOuts = trades.filter(t => /wall \S+ broke|stop \S+ hit/i.test(String(t.exitReason || ""))).length;
    state.sessionPnl = parseFloat(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2));
    if (!state.sessionStart) state.sessionStart = trades[0].entryTime || trades[0].loggedAt || null;
    console.log(`♻️ [OIWF-PAPER] Restart recovery — loaded ${trades.length} trade(s) from ${source} (PnL ₹${state.sessionPnl}, ${state.stopOuts} stop-out(s))`);
  } catch (err) {
    console.warn(`[OIWF-PAPER] session rehydrate failed: ${err.message}`);
  }
}
rehydrateSessionFromJsonl();
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => state, "[OIWF-PAPER]");

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

// ── Poll loop ────────────────────────────────────────────────────────────────
// The index price arrives on the shared socket for free, so this loop exists for
// three narrower jobs: the option LTP while a position is open (P&L only — no
// exit reads it), the bar-close history refresh, and the EOD backstop for a
// stalled tick feed.
let _pollTimer = null;
let _pollStopped = true;

function startPolling() {
  stopPolling();
  _pollStopped = false;
  const poll = async () => {
    if (_pollStopped) return;
    if (state.position) {
      try {
        const optSym = state.position.symbol;
        const r = await fyers.getQuotes([optSym]);
        if (r && r.s === "ok" && Array.isArray(r.d) && r.d.length) {
          const v = r.d[0].v || {};
          const ltp = v.lp || v.ltp;
          if (typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0) {
            state.optionLtp = ltp;
            state.optionLtpUpdatedAt = Date.now();
            try { tickRecorder.recordOptionLtp(optSym, ltp, "oi-wall-fade-paper"); } catch (_) {}
          }
        }
      } catch (_) {}
    }

    try { _enforceEod(); } catch (e) { console.error(`🚨 [OIWF-PAPER] eod error: ${e.message}`); }
    _maybeRefreshHistory().catch(e => console.error(`🚨 [OIWF-PAPER] history refresh error: ${e.message}`));
    if (!state.position && state._pendingEntry) {
      _retryPendingEntry().catch(e => console.error(`🚨 [OIWF-PAPER] entry-retry error: ${e.message}`));
    }

    if (!_pollStopped) _pollTimer = setTimeout(poll, _optPollMs());
  };
  _pollTimer = setTimeout(poll, 250);
}

function stopPolling() {
  _pollStopped = true;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

// ── Index history — the ONLY source of the closed bars decisions read ─────────
/**
 * Fetch today's closed index bars once per bar, a short lag after the bar
 * closes. The PRICE half of every decision comes from here, which is what makes
 * the candle side of Paper and Replay agree. (The OI half does not — see the
 * header.)
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
    const bars = await _fetchIndexToday();
    if (Array.isArray(bars) && bars.length) {
      state._histBucket = bucketMs;
      state._histFailures = 0;
      state._histNextTryMs = null;
      _mergeBars(bars);
    } else {
      // An EXPIRED Fyers token returns no data rather than an auth error, so
      // "empty" and "broken" look identical here — both are treated as a failure.
      _noteHistoryFailure(null);
    }
  } catch (e) {
    _noteHistoryFailure(e && e.message);
  } finally {
    state._histInFlight = false;
  }
}

/**
 * Record a failed history fetch and back off. The poll runs every
 * OIWF_OPT_POLL_MS (2s by default) and the bucket guard only advances on
 * SUCCESS, so without a backoff a dead token would turn one bar into ~150
 * history calls. Backoff grows 5s per failure to a 60s ceiling, and never
 * exceeds one bar — so there is still at least one attempt per bar, which is the
 * soonest a retry could return anything new anyway.
 */
function _noteHistoryFailure(why) {
  state._histFailures++;
  const backoffMs = Math.min(_resMin() * 60_000, 5000 * Math.min(state._histFailures, 12));
  state._histNextTryMs = Date.now() + backoffMs;
  if (state._histFailures === 3 || state._histFailures % 20 === 0) {
    log(`⚠️ [OIWF-PAPER] Index history unavailable ${state._histFailures}× ${why ? `(${why}) ` : ""}— an expired Fyers token returns NO DATA rather than an auth error. Re-login if this persists. Retrying in ${Math.round(backoffMs / 1000)}s.`);
  }
}

/** Today's index bars at the strategy resolution. Uncached — today is live. */
async function _fetchIndexToday() {
  const { fetchCandles } = require("../services/backtestEngine");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return fetchCandles(NIFTY_INDEX_SYMBOL, String(_resMin()), today, today);
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

  if (!fresh.length) return;
  const newest = fresh[fresh.length - 1];
  state.lastClosedBarTime = newest.time;
  // Fire ONCE, for the newest bar only. evaluateEntry always reads the LAST
  // element of state.candles, and — more to the point — it reads the LIVE OI
  // ladder, which has only one value. Replaying older bars would judge them all
  // against this instant's walls.
  try { onCandleClose(newest); }
  catch (e) { console.error(`🚨 [OIWF-PAPER] onCandleClose error: ${e.message}`); }
}

// ── Trade simulation ─────────────────────────────────────────────────────────
async function simulateBuy(side, sig) {
  const spot = state.lastTickPrice;
  if (!side) return;
  if (typeof spot !== "number" || !(spot > 0)) {
    log(`⚠️ [OIWF-PAPER] No NIFTY index price yet — entry deferred`);
    return;
  }

  let optInfo;
  try {
    optInfo = await instrumentConfig.validateAndGetOptionSymbol(spot, side, "OIWF");
  } catch (e) {
    log(`❌ [OIWF-PAPER] Symbol resolve failed: ${e.message}`);
    return;
  }
  if (!optInfo || optInfo.invalid) {
    log(`❌ [OIWF-PAPER] No valid expiry — skip ${side} entry`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "expiry", reason: "no valid option expiry", side, spot });
    return;
  }

  let optionEntryLtp = null;
  try {
    const r = await fyers.getQuotes([optInfo.symbol]);
    if (r && r.s === "ok" && r.d && r.d.length) {
      const v = r.d[0].v || {};
      const ltp = v.lp || v.ltp;
      if (typeof ltp === "number" && ltp > 0) {
        optionEntryLtp = ltp;
        try { tickRecorder.recordOptionLtp(optInfo.symbol, ltp, "oi-wall-fade-paper"); } catch (_) {}
      }
    }
  } catch (e) {
    log(`⚠️ [OIWF-PAPER] Option LTP fetch failed: ${e.message} — entry blocked`);
    return;
  }
  if (!optionEntryLtp) {
    log(`❌ [OIWF-PAPER] Option LTP not available — entry skipped`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "option_ltp", reason: "no option LTP", symbol: optInfo.symbol, side, spot });
    return;
  }

  // The target and the stop are LEVELS the engine read off the wall ladder — the
  // mid-band and the wall strike. Unlike a distance-based bracket they are NOT
  // re-anchored to the fill: re-anchoring would move the stop away from the wall,
  // which is the one thing this strategy is about. A slipped fill simply changes
  // the R:R, and that is reported.
  const slSpot     = sig.slSpot;
  const targetSpot = sig.targetSpot;
  if (!Number.isFinite(slSpot) || !Number.isFinite(targetSpot)) {
    log(`🚫 [OIWF-PAPER] Entry ABORTED — stop (${slSpot}) or target (${targetSpot}) unusable. Refusing to enter without both.`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "levels_uncomputable", reason: `stop ${slSpot} / target ${targetSpot} unusable`, side, spot });
    return;
  }
  // The fill may have already run past a level while the quote round-tripped.
  if (oiStrategy.stopHit(side, spot, slSpot)) {
    log(`🚫 [OIWF-PAPER] Entry ABORTED — spot ${spot} is already through the stop ${slSpot}`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "fill_past_stop", reason: `spot ${spot} already beyond stop ${slSpot}`, side, spot });
    return;
  }
  if (oiStrategy.targetHit(side, spot, targetSpot)) {
    log(`🚫 [OIWF-PAPER] Entry ABORTED — spot ${spot} already reached the mid-band ${targetSpot} before the fill`);
    skipLogger.appendSkipLog(MODE_KEY, { gate: "target_already_hit", reason: `spot ${spot} already at mid-band ${targetSpot}`, side, spot });
    return;
  }

  const qty = oiLotQty();
  const slPts     = parseFloat(Math.abs(slSpot - spot).toFixed(2));
  const targetPts = parseFloat(Math.abs(targetSpot - spot).toFixed(2));
  const rr        = slPts > 0 ? parseFloat((targetPts / slPts).toFixed(2)) : null;

  // Capital check — advisory only: an overdrawn pool raises a dashboard alert,
  // it never stops a paper trade. Sits AFTER the last abort path.
  const _cap = capitalPool.check(MODE_KEY, qty * optionEntryLtp);
  if (!_cap.ok) {
    log(`⚠️ [OIWF-PAPER] ${_cap.reason} — entry taken anyway, pool now overdrawn`);
    capitalPool.noteShortfall(MODE_KEY, _cap, { side, symbol: optInfo.symbol });
  }

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
    entryUnixSec:   Math.floor(Date.now() / 1000),
    entryBarTime:   Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    slSpot,
    initialSlSpot:  slSpot,
    targetSpot,
    slPts,
    targetPts,
    riskPts:        slPts,
    rr,
    // Signal context (kept on the trade record for analytics / reports). The OI
    // fields are the whole thesis, so they are recorded in full — replay cannot
    // reconstruct them.
    signalSpot:     sig.entrySpot,
    signalSlPts:    sig.slPts,
    signalTargetPts: sig.targetPts,
    signalRr:       sig.rr,
    wallStrike:     sig.wallStrike,
    wallSide:       sig.wallSide,
    wallOi:         sig.wallOi,
    wallDeltaPct:   sig.wallDeltaPct,
    wallDeltaSpanSec: sig.wallDeltaSpanSec,
    ceWallStrike:   sig.ceWall ? sig.ceWall.strike : null,
    ceWallOi:       sig.ceWall ? sig.ceWall.oi : null,
    peWallStrike:   sig.peWall ? sig.peWall.strike : null,
    peWallOi:       sig.peWall ? sig.peWall.oi : null,
    bandPts:        sig.bandPts,
    bandLo:         sig.bandLo,
    bandHi:         sig.bandHi,
    bandMid:        sig.bandMid,
    atBandEdge:     sig.atBandEdge,
    pcrAtEntry:     sig.pcr,
    oiStrikes:      sig.oiStrikes,
    peakPremium:    optionEntryLtp,
    signalStrength: sig.signalStrength,
    mfeSpotPts:     0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
    entryReason:    sig.reason,
  };

  state.position = pos;
  capitalPool.block(MODE_KEY, qty * optionEntryLtp, { side, symbol: optInfo.symbol, qty, premium: optionEntryLtp });
  try { require("../utils/positionPersist").saveOiWallFadePosition(pos, { sessionPnl: state.sessionPnl }); } catch (_) {}
  state.optionLtp = optionEntryLtp;
  state.optionLtpUpdatedAt = Date.now();
  state.tradesTaken++;

  log(`🟢 [OIWF-PAPER] BUY_${side} ${optInfo.symbol} qty=${qty} @ spot=${spot} optLtp=₹${optionEntryLtp}`);
  log(`   ├─ Fading the ${pos.wallSide} wall ${pos.wallStrike} · OI ${pos.wallOi} · ΔOI +${pos.wallDeltaPct}%${pos.wallDeltaSpanSec != null ? ` over ${pos.wallDeltaSpanSec}s` : ""}`);
  log(`   ├─ Band ${pos.bandLo}–${pos.bandHi} (${pos.bandPts}pt) · mid ${pos.bandMid}${pos.atBandEdge ? " ⚠ a wall sits at the polled-band edge" : ""}`);
  log(`   └─ TGT ${targetSpot} (${targetPts}pt) · SL ${slSpot} (${slPts}pt) · R:R ${rr} · EOD ${_envStr("OIWF_FORCED_EXIT", "15:15")}`);

  notifyEntry({
    mode: "OI-WALL-FADE-PAPER",
    side, symbol: optInfo.symbol,
    spotAtEntry: spot, optionEntryLtp,
    qty, stopLoss: slSpot, target: targetSpot,
    entryTime: pos.entryTime,
    entryReason: pos.entryReason,
  });

  try {
    tickRecorder.recordEntry({
      mode: "oi-wall-fade-paper",
      sessionId: state._sessionId,
      ts: Date.now(),
      side, symbol: optInfo.symbol, qty,
      spotEntry: spot, optionEntry: optionEntryLtp,
      stopLoss: slSpot, target: targetSpot,
      reason: pos.entryReason,
    });
  } catch (_) {}
}

function simulateSell(reason, opts) {
  if (!state.position) return;
  const o = opts || {};
  const pos = state.position;
  const exitOptLtp = state.optionLtp || pos.optionEntryLtp;
  const exitSpot   = state.lastTickPrice || pos.entrySpot;
  const qty        = pos.qty;
  const charges    = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitOptLtp, qty });
  const pnl        = parseFloat(((exitOptLtp - pos.optionEntryLtp) * qty - charges).toFixed(2));

  state.sessionPnl = parseFloat((state.sessionPnl + pnl).toFixed(2));
  if (pnl < 0) state.consecutiveLosses++; else if (pnl > 0) state.consecutiveLosses = 0;
  // Only a REAL stop-out burns one of the day's allowed losses. isStopOut is set
  // by the caller, never inferred from the sign of the P&L, so a stop that
  // happens to net positive still counts.
  if (o.isStopOut) state.stopOuts++;

  // The wall ladder AS IT IS NOW, for review only — no exit rule reads it. It is
  // the cheapest way to answer the question this strategy exists to test: when
  // the fade failed, had the wall already started shedding?
  let wallOiAtExit = null, wallDeltaAtExit = null;
  try {
    const snap = oiSnapshot();
    const d = snap ? oiStrategy.wallDelta(snap, pos.wallStrike, pos.wallSide) : null;
    if (d) { wallOiAtExit = d.oi; wallDeltaAtExit = d.pct; }
  } catch (_) {}

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
    bestOptionLtp:  pos.peakPremium || null,
    entryTime:      pos.entryTime,
    exitTime:       istNow(),
    entryBarTime:   pos.entryBarTime,
    exitBarTime:    Math.floor(getBucketStart(Date.now(), _resMin()) / 1000),
    pnl,
    pnlMode:        `option premium: entry ₹${pos.optionEntryLtp} → exit ₹${exitOptLtp} (levels measured on the NIFTY 50 index)`,
    exitReason:     reason,
    entryReason:    pos.entryReason,
    stopLoss:       pos.slSpot,
    initialStopLoss: pos.initialSlSpot,
    target:         pos.targetSpot,
    optionStrike:   pos.optionStrike,
    optionExpiry:   pos.optionExpiry,
    optionType:     pos.side,
    optionEntrySymbol: pos.symbol,
    signalStrength: pos.signalStrength,
    riskPts:        pos.riskPts,
    targetPts:      pos.targetPts,
    rr:             pos.rr,
    // OI_WALL_FADE signal context
    wallStrike:     pos.wallStrike,
    wallSide:       pos.wallSide,
    wallOi:         pos.wallOi,
    wallDeltaPct:   pos.wallDeltaPct,
    wallDeltaSpanSec: pos.wallDeltaSpanSec,
    wallOiAtExit,
    wallDeltaPctAtExit: wallDeltaAtExit,
    ceWallStrike:   pos.ceWallStrike,
    ceWallOi:       pos.ceWallOi,
    peWallStrike:   pos.peWallStrike,
    peWallOi:       pos.peWallOi,
    bandPts:        pos.bandPts,
    bandLo:         pos.bandLo,
    bandHi:         pos.bandHi,
    bandMid:        pos.bandMid,
    atBandEdge:     pos.atBandEdge,
    pcrAtEntry:     pos.pcrAtEntry,
    oiStrikes:      pos.oiStrikes,
    mfeSpotPts:     pos.mfeSpotPts || 0,
    mfePnl:         pos.mfePnl || 0,
    maeSpotPts:     pos.maeSpotPts || 0,
    maePnl:         pos.maePnl || 0,
    secsToMFE:      pos.secsToMFE || 0,
    secsToMAE:      pos.secsToMAE || 0,
    durationMs:     Date.now() - pos.entryTimeMs,
    charges,
    isFutures:      false,
    instrument:     "NIFTY_OPTIONS",
  };
  state.sessionTrades.push(trade);
  tradeLogger.appendTradeLog(MODE_KEY, trade);

  log(`🔴 [OIWF-PAPER] EXIT ${pos.side} ${pos.symbol} @ optLtp=₹${exitOptLtp} spot=${exitSpot} | PnL=₹${pnl} (${reason})`);
  if (wallDeltaAtExit != null) {
    log(`   └─ The ${pos.wallSide} wall ${pos.wallStrike} was at ΔOI ${wallDeltaAtExit}% on the way out (was +${pos.wallDeltaPct}% at entry)`);
  }

  notifyExit({
    mode: "OI-WALL-FADE-PAPER",
    side: pos.side, symbol: pos.symbol,
    spotAtEntry: pos.entrySpot, spotAtExit: exitSpot,
    optionEntryLtp: pos.optionEntryLtp, optionExitLtp: exitOptLtp,
    pnl, sessionPnl: state.sessionPnl,
    exitReason: reason, entryReason: pos.entryReason,
    entryTime: pos.entryTime, exitTime: trade.exitTime, qty,
    peakPremium: trade.bestOptionLtp, peakPnl: trade.mfePnl,
    maxDrawdown: trade.maePnl, heldMs: trade.durationMs,
  });

  try {
    tickRecorder.recordExit({
      mode: "oi-wall-fade-paper", sessionId: state._sessionId, ts: Date.now(),
      side: pos.side, symbol: pos.symbol, qty,
      spotExit: exitSpot, optionExit: exitOptLtp, pnl, reason,
    });
  } catch (_) {}

  state.position = null;
  capitalPool.release(MODE_KEY, pnl);
  try { require("../utils/positionPersist").clearOiWallFadePosition(); } catch (_) {}
  state.optionLtp = null;
  state.optionLtpUpdatedAt = null;

  _applyDayBreakers();
}

/** Day-level breakers, evaluated after every exit. Each one CLOSES the day. */
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
    _closeDay(`${state.stopOuts} stop-out(s) ≥ ${maxOuts} — day over`);
    return;
  }
  if (state.tradesTaken >= _maxDailyTrades()) {
    _closeDay(`Daily trade budget spent (${state.tradesTaken}/${_maxDailyTrades()})`);
  }
}

function _closeDay(reason) {
  state.dayClosed = true;
  state.dayClosedReason = reason;
  log(`⏸️ [OIWF-PAPER] ${reason} — no more entries today`);
  skipLogger.appendSkipLog(MODE_KEY, { gate: "day_closed", reason, sessionPnl: state.sessionPnl, spot: state.lastTickPrice });
}

// ── Exits ────────────────────────────────────────────────────────────────────
// Two levels and an EOD. Priority: stop → target. The stop is tested FIRST so a
// move that reached both between two ticks books the loss, which is the only
// honest reading when the path between samples is unknown.
// Every level is guarded with Number.isFinite before it is compared: `price <= null`
// is `price <= 0`, which would square the trade off on its very first tick.
function _checkExits(spot) {
  if (!state.position) return;
  if (typeof spot !== "number" || !Number.isFinite(spot) || spot <= 0) return;
  const pos = state.position;
  const optLtp = state.optionLtp || pos.optionEntryLtp;

  if (optLtp > pos.peakPremium) pos.peakPremium = optLtp;
  const favPts = (spot - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const curPnl = (optLtp - pos.optionEntryLtp) * pos.qty;
  if (favPts > (pos.mfeSpotPts || 0)) { pos.mfeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMFE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl > (pos.mfePnl     || 0)) pos.mfePnl = parseFloat(curPnl.toFixed(2));
  if (favPts < (pos.maeSpotPts || 0)) { pos.maeSpotPts = parseFloat(favPts.toFixed(2)); pos.secsToMAE = parseFloat(((Date.now() - pos.entryTimeMs) / 1000).toFixed(1)); }
  if (curPnl < (pos.maePnl     || 0)) pos.maePnl = parseFloat(curPnl.toFixed(2));

  // 1. Stop — price went through the wall we were fading. The thesis was wrong.
  if (oiStrategy.stopHit(pos.side, spot, pos.slSpot)) {
    simulateSell(
      `${pos.wallSide} wall ${pos.wallStrike} broke — stop ${pos.slSpot} hit (spot ${spot}, ${pos.riskPts}pt against)`,
      { isStopOut: true }
    );
    return;
  }

  // 2. Target — the mid-band. That is the entire trade.
  if (oiStrategy.targetHit(pos.side, spot, pos.targetSpot)) {
    simulateSell(`Mid-band reached — ${pos.bandLo}–${pos.bandHi} band, target ${pos.targetSpot} (spot ${spot}, +${favPts.toFixed(1)}pt)`);
  }
}

function _enforceEod() {
  if (!state.position) return;
  if (getISTMinutes() >= _parseMins("OIWF_FORCED_EXIT", "15:15")) {
    simulateSell(`EOD square-off (${_envStr("OIWF_FORCED_EXIT", "15:15")} IST) — the mid-band was never reached`);
  }
}

// ── Entry evaluation (on candle close — CLOSED bars only) ────────────────────
const ENTRY_RETRY_MS = 5000;

async function evaluateEntry() {
  // Every guard here is synchronous and runs before the first await, so
  // concurrent polls can never open two positions.
  if (state.position || state._entryInFlight || state.dayClosed) return;
  if (state._lastEntryAttemptMs && Date.now() - state._lastEntryAttemptMs < ENTRY_RETRY_MS) return;
  if (state.tradesTaken >= _maxDailyTrades()) { _applyDayBreakers(); return; }

  // ── Risk gates ──────────────────────────────────────────────────────────
  const maxWeek = _maxWeeklyLoss();
  if (maxWeek > 0) {
    const wk = weeklyPnl();
    if (wk <= -maxWeek) { _closeDay(`Weekly loss cap hit (week P&L ₹${wk} ≤ -₹${maxWeek})`); return; }
  }
  {
    const pf = require("../utils/portfolioRisk").checkPortfolioCap();
    if (pf.blocked) { _closeDay(pf.reason); return; }
  }

  // ── The signal ──────────────────────────────────────────────────────────
  const snap = oiSnapshot();
  const sig = oiStrategy.getSignal(state.candles, snap, { alreadyTraded: false, silent: true });
  state.lastSignal = sig;
  if (sig.ceWall && sig.peWall) {
    state.lastBand = {
      ce: sig.ceWall, pe: sig.peWall, lo: sig.bandLo, hi: sig.bandHi,
      mid: sig.bandMid, bandPts: sig.bandPts, atBandEdge: sig.atBandEdge,
      pcr: sig.pcr, seenAt: istNow(),
    };
  }

  if (sig.signal === "NONE" || !sig.side) {
    // Only log the interesting near-misses — a "no ladder yet" line every 5
    // minutes would bury the day file. A skip is worth recording once price is
    // actually at a wall, which is where the OI reading starts to matter.
    if (!sig.warmup && sig.pressed) {
      skipLogger.appendSkipLog(MODE_KEY, {
        // The two OI refusals must be distinguishable from a price refusal in
        // the log, because they are the whole point of collecting it: an
        // UNKNOWN Δ (no samples yet / strike out of the polled band) and a
        // STALE Δ are both "we would not read the wall", not "the wall said no".
        // Both leave defend and breakAway null, so neither can be inferred from
        // those flags alone.
        gate: sig.wallDeltaPct == null ? "oi_unknown"
            : sig.breakAway            ? "wall_shedding"
            : sig.defend === false     ? "wall_not_defended"
            : sig.defend == null       ? "oi_stale"
            : sig.rejected === false   ? "no_rejection"
            : "band",
        reason: sig.skipReason || sig.reason,
        spot: state.lastTickPrice,
        wallStrike: sig.wallStrike, wallSide: sig.wallSide, wallOi: sig.wallOi,
        wallDeltaPct: sig.wallDeltaPct, wallDeltaSpanSec: sig.wallDeltaSpanSec,
        bandLo: sig.bandLo, bandHi: sig.bandHi, bandPts: sig.bandPts, bandMid: sig.bandMid,
        atBandEdge: sig.atBandEdge, pcr: sig.pcr, oiStrikes: sig.oiStrikes,
        defend: sig.defend, breakAway: sig.breakAway, rejected: sig.rejected,
        rr: sig.rr, slPts: sig.slPts, targetPts: sig.targetPts,
      });
    }
    return;
  }

  log(`🎯 [OIWF-PAPER] SETUP: ${sig.reason}`);
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
      // signal so the next polls can retry it — see _retryPendingEntry. The
      // retry throttle lives on THIS object, not on state._lastEntryAttemptMs:
      // sharing that field would let a retry firing seconds before a bar close
      // throttle out the new bar's own evaluation.
      state._pendingEntry = { side: sig.side, sig, lastAttemptMs: Date.now() };
      log(`⚠️ [OIWF-PAPER] Entry attempt failed — retrying every ${ENTRY_RETRY_MS / 1000}s until this bar is superseded`);
    }
  }
}

/**
 * Retry a signalled entry whose FILL failed (option LTP unavailable, expiry
 * unresolved, quotes blip). The DECISION is already made — re-running it mid-bar
 * would judge the same candle against a newer OI ladder, which is a different
 * decision — so this re-attempts only the broker side, throttled so a persistent
 * failure never hammers the API.
 *
 * The pending signal is dropped at the next candle close (onCandleClose), so a
 * stale setup can never fill minutes later against a wall that has since moved.
 */
async function _retryPendingEntry() {
  const p = state._pendingEntry;
  if (!p) return;
  if (state.position || state._entryInFlight) return;
  if (state.dayClosed || state.tradesTaken >= _maxDailyTrades()) { state._pendingEntry = null; return; }
  if (getISTMinutes() >= _parseMins("OIWF_FORCED_EXIT", "15:15")) { state._pendingEntry = null; return; }
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
function onCandleClose(bar) {
  // A new bar supersedes any setup still waiting on a failed fill — the market
  // and the ladder have both moved on, and this bar's own evaluation is the
  // current truth.
  state._pendingEntry = null;
  if (state.position) return;                    // exits are per-tick, not per-bar
  if (!bar || typeof bar.time !== "number") return;
  const cfg = oiStrategy.getConfig();
  const closeMins = oiStrategy._utcSecToIstMins(bar.time) + cfg.resolutionMins;
  if (closeMins > cfg.entryEndMin) return;
  evaluateEntry().catch(e => console.error(`🚨 [OIWF-PAPER] entry-eval error: ${e.message}`));
}

// ── onTick — the NIFTY 50 INDEX feed. Every exit is measured on this price. ──
function onTick(tick) {
  if (!state.running) return;
  const price = tick && tick.ltp;
  if (!price || price <= 0) return;

  const resMin = _resMin();
  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  // Display-only forming bar. No decision reads it — the engine only ever sees
  // closed bars from the history endpoint.
  const bucketSec = Math.floor(getBucketStart(Date.now(), resMin) / 1000);
  if (!state.formingBar || state.formingBar.time !== bucketSec) {
    state.formingBar = { time: bucketSec, open: price, high: price, low: price, close: price };
  } else {
    state.formingBar.high  = Math.max(state.formingBar.high, price);
    state.formingBar.low   = Math.min(state.formingBar.low, price);
    state.formingBar.close = price;
  }

  try { if (state.position) _checkExits(price); } catch (e) { console.error(`🚨 [OIWF-PAPER] exit-check error: ${e.message}`); }
  _enforceEod();
}

// ── Preload index history ────────────────────────────────────────────────────
// Only TODAY matters: the rule reads one closed candle and the live OI ladder,
// and there is no indicator to seed. A restart at 13:00 recovers in one call.
async function preloadHistory() {
  try {
    const bars = await _fetchIndexToday();
    if (Array.isArray(bars) && bars.length) {
      const resMin = _resMin();
      const nowBucketSec = Math.floor(getBucketStart(Date.now(), resMin) / 1000);
      state.candles = bars
        .filter(b => b && typeof b.time === "number" && b.time < nowBucketSec)
        .sort((a, b) => a.time - b.time)
        .slice(-400);
      state._histBucket = getBucketStart(Date.now(), resMin);
      state.lastClosedBarTime = state.candles.length ? state.candles[state.candles.length - 1].time : null;
      log(`📊 [OIWF-PAPER] Preloaded ${state.candles.length} closed ${resMin}-min NIFTY 50 candles`);
    } else {
      log(`📊 [OIWF-PAPER] No index history yet — an expired Fyers token returns no data rather than an auth error.`);
    }
  } catch (e) {
    log(`⚠️ [OIWF-PAPER] Index preload failed: ${e.message}`);
  }
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
  _autoStopTimer = setTimeout(() => { log(`⏰ [OIWF-PAPER] Auto-stop @ ${raw} IST`); stopSession(); }, minsLeft * 60 * 1000);
}

// ── Session lifecycle ────────────────────────────────────────────────────────
router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/oi-wall-fade-paper/status");

  if (String(process.env.OIWF_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("OI Wall Fade Disabled", "Enable OI Wall Fade Mode in Settings first", "/settings", "Go to Settings"));
  }
  if (String(process.env.OIWF_PAPER_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).send(_errorPage("OI Wall Fade Paper Disabled", "Enable OI Wall Fade Paper Trading in Settings first", "/settings", "Go to Settings"));
  }

  // Without the chain recorder there is no ladder, and without the ladder this
  // strategy has no input at all. Refuse loudly rather than sit mute all day.
  const rec = chainRecorderState();
  if (!rec.ok) {
    const why = !rec.enabled
      ? "The option chain recorder is off (OPTION_CHAIN_RECORDER_ENABLED, and it also needs TICK_RECORDER_ENABLED)."
      : "Per-strike OI capture is off (OPTION_CHAIN_RECORD_OI).";
    return res.status(400).send(_errorPage("No OI Feed", `${why} OI Wall Fade reads nothing else — every decision is a wall reading.`, "/settings", "Go to Settings"));
  }

  const check = sharedSocketState.canStart("OI_WALL_FADE_PAPER");
  if (!check.allowed) return res.status(409).send(_errorPage("Cannot Start", check.reason, "/oi-wall-fade-paper/status", "← Back"));

  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).send(_errorPage("Not Authenticated", auth.message, "/auth/login", "Login with Fyers"));

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) return res.status(400).send(_errorPage("Trading Not Allowed", holiday.reason, "/oi-wall-fade-paper/status", "← Back"));

  if (getISTMinutes() >= _parseMins("OIWF_FORCED_EXIT", "15:15")) {
    return res.status(400).send(_errorPage("Session Closed", `Past ${_envStr("OIWF_FORCED_EXIT", "15:15")} IST — OI Wall Fade does not trade after this`, "/oi-wall-fade-paper/status", "← Back"));
  }

  state = _freshState();
  state.running = true;
  state.sessionStart = new Date().toISOString();
  state._sessionId = `oi-wall-fade-paper:${Date.now()}`;

  sharedSocketState.setOiWallFadeActive("OI_WALL_FADE_PAPER");

  const cfg = oiStrategy.getConfig();
  log(`🟢 [OIWF-PAPER] Session started — ${oiStrategy.NAME}`);
  log(`⚙️ [OIWF-PAPER] NIFTY 50 @ ${cfg.resolutionMins}m · band ≥${cfg.minBandPts}pt · press within ${cfg.wallNearPts}pt of a wall · wall ΔOI ≥+${cfg.wallBuildPct}% over ${cfg.oiLookback} move(s) · shed ≤-${cfg.wallShedPct}% stands aside`);
  log(`⚙️ [OIWF-PAPER] Target = mid-band · SL = ${cfg.slBufferPts}pt beyond the wall · entries ${_envStr("OIWF_ENTRY_START", "09:45")}–${_envStr("OIWF_ENTRY_END", "14:45")} · max ${_maxDailyTrades()}/day · loss cap ₹${_maxDailyLoss()} · EOD ${_envStr("OIWF_FORCED_EXIT", "15:15")} · qty ${oiLotQty()}`);
  if (cfg.minTargetPts || cfg.requireInnerWall || cfg.maxOiSpanSec) {
    log(`⚙️ [OIWF-PAPER] Guards — ${[cfg.maxOiSpanSec ? `ΔOI must have accumulated within ${cfg.maxOiSpanSec}s` : null, cfg.minTargetPts ? `min target ${cfg.minTargetPts}pt` : null, cfg.requireInnerWall ? "both walls must be inside the polled band" : null].filter(Boolean).join(" · ")}`);
  }
  log(`ℹ️ [OIWF-PAPER] The OI half of every decision is LIVE in-memory state. /replay reproduces the candles, NOT the walls — every wall reading is written onto the trade record instead.`);

  await preloadHistory();
  startPolling();

  try {
    tickRecorder.recordSessionStart({
      mode: "oi-wall-fade-paper",
      sessionId: state._sessionId,
      settings: tickRecorder.snapshotSettings ? tickRecorder.snapshotSettings() : {},
      warmup: state.candles.map(c => ({ ...c })),
      meta: {
        instrument: instrumentConfig.INSTRUMENT,
        resolutionMin: cfg.resolutionMins,
        spotSymbol: NIFTY_INDEX_SYMBOL,
        sessionStartISO: state.sessionStart,
        recordsOptionLtps: true,
        oiLadderIsLiveOnly: true,
      },
    });
  } catch (_) {}

  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [OIWF-PAPER] Piggybacking on existing WebSocket (NIFTY 50 index)");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [OIWF-PAPER] Started WebSocket (NIFTY 50 index)");
  }

  scheduleAutoStop();

  notifyStarted({
    mode: "OI-WALL-FADE-PAPER",
    text: [
      `📄 OI WALL FADE PAPER — STARTED`,
      ``,
      `📅 ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`,
      `🕐 ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`,
      ``,
      `Strategy  : ${oiStrategy.NAME}`,
      `Chart     : NIFTY 50 @ ${cfg.resolutionMins}-min + the live per-strike OI ladder`,
      `Setup     : price presses a wall whose OI is still rising (≥+${cfg.wallBuildPct}%) and the candle closes back away from it`,
      `Target    : the mid-band · Stop: ${cfg.slBufferPts}pt beyond the wall`,
      `Max trades: ${_maxDailyTrades()}/day · loss cap ₹${_maxDailyLoss()}`,
      `Square-off: ${_envStr("OIWF_FORCED_EXIT", "15:15")} IST`,
    ].filter(Boolean).join("\n"),
  });

  res.redirect("/oi-wall-fade-paper/status");
});

function stopSession() {
  if (!state.running) return;
  if (state.position) simulateSell("Session stopped");
  state.running = false;
  stopPolling();

  try { tickRecorder.recordSessionStop({ mode: "oi-wall-fade-paper", sessionId: state._sessionId || null, reason: "user_stop" }); } catch (_) {}

  socketManager.removeCallback(CALLBACK_ID);
  sharedSocketState.clearOiWallFade();   // clear OWN mode first (else the socket never stops → leak)
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  if (state.sessionTrades.length > 0) {
    try {
      const data = loadData();
      data.sessions.push({ date: state.sessionStart, strategy: oiStrategy.NAME, pnl: state.sessionPnl, trades: state.sessionTrades });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
      saveData(data);
      log(`💾 [OIWF-PAPER] Session saved — ${state.sessionTrades.length} trades, PnL ₹${state.sessionPnl}`);
    } catch (e) {
      log(`⚠️ [OIWF-PAPER] Save failed: ${e.message}`);
    }
  }

  const wins = state.sessionTrades.filter(t => t.pnl > 0).length;
  log(`📋 [OIWF-PAPER] Day summary — ${state.sessionTrades.length} trade(s), ${wins}W/${state.sessionTrades.length - wins}L, net ₹${state.sessionPnl}, week ₹${weeklyPnl()}`);
  log("🔴 [OIWF-PAPER] Session stopped");

  notifyDayReport({
    mode: "OI-WALL-FADE-PAPER",
    sessionTrades: state.sessionTrades,
    sessionPnl: state.sessionPnl,
    sessionStart: state.sessionStart,
  });
}

router.get("/stop", (req, res) => { stopSession(); res.redirect("/oi-wall-fade-paper/status"); });
router.get("/exit", (req, res) => { if (state.position) simulateSell("Manual exit"); res.redirect("/oi-wall-fade-paper/status"); });

// ── /status/chart-data — index candles + wall band + bracket ──────────────────
router.get("/status/chart-data", (req, res) => {
  try {
    const cfg = oiStrategy.getConfig();
    const candles = state.candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (state.formingBar && (!candles.length || state.formingBar.time > candles[candles.length - 1].time)) {
      candles.push({ time: state.formingBar.time, open: state.formingBar.open, high: state.formingBar.high, low: state.formingBar.low, close: state.formingBar.close });
    }

    const markers = [];
    for (const t of state.sessionTrades) {
      if (t.entryBarTime) markers.push({ time: t.entryBarTime, position: t.side === "CE" ? "belowBar" : "aboveBar", color: t.side === "CE" ? "#10b981" : "#ef4444", shape: t.side === "CE" ? "arrowUp" : "arrowDown", text: `${t.side} ${t.entryPrice}` });
      if (t.exitBarTime)  markers.push({ time: t.exitBarTime,  position: t.side === "CE" ? "aboveBar" : "belowBar", color: (t.pnl || 0) >= 0 ? "#10b981" : "#ef4444", shape: "circle", text: `${(t.pnl || 0) >= 0 ? "+" : ""}${Math.round(t.pnl || 0)}` });
    }

    // The band drawn on the chart is the LIVE one when flat, and the FROZEN one
    // the trade was entered against while a position is open — otherwise the
    // lines would drift away from the bracket they are supposed to explain.
    const pos = state.position;
    const b = pos
      ? { ceStrike: pos.ceWallStrike, peStrike: pos.peWallStrike, mid: pos.bandMid }
      : (state.lastBand ? { ceStrike: state.lastBand.ce.strike, peStrike: state.lastBand.pe.strike, mid: state.lastBand.mid } : null);

    res.json({
      candles, markers,
      ceWall: b ? b.ceStrike : null,
      peWall: b ? b.peStrike : null,
      bandMid: b ? b.mid : null,
      bandFrozen: !!pos,
      entryPrice: pos ? pos.entrySpot : null,
      stopLoss:   pos ? pos.slSpot : null,
      target:     pos ? pos.targetSpot : null,
      resMin:     cfg.resolutionMins,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /status/oi-data — the live ladder, for the page's wall table ──────────────
router.get("/status/oi-data", (req, res) => {
  try {
    const cfg  = oiStrategy.getConfig();
    const snap = oiSnapshot();
    const band = oiStrategy.readBand(snap, cfg);
    const rows = snap && Array.isArray(snap.rows) ? snap.rows.map(r => ({
      strike: r.strike,
      isAtm:  r.isAtm,
      ceOi:   r.CE ? r.CE.oi : null,
      peOi:   r.PE ? r.PE.oi : null,
      ceD:    r.CE && r.CE.deltas && r.CE.deltas[cfg.oiLookback] ? parseFloat(r.CE.deltas[cfg.oiLookback].pct.toFixed(1)) : null,
      peD:    r.PE && r.PE.deltas && r.PE.deltas[cfg.oiLookback] ? parseFloat(r.PE.deltas[cfg.oiLookback].pct.toFixed(1)) : null,
    })) : [];
    res.json({
      rows,
      band: { lo: band.lo, hi: band.hi, mid: band.mid, bandPts: band.bandPts, atBandEdge: band.atBandEdge },
      ceWall: band.ce, peWall: band.pe,
      pcr: snap && snap.pcr && typeof snap.pcr.pcr === "number" ? parseFloat(snap.pcr.pcr.toFixed(2)) : null,
      strikeCount: snap ? snap.strikeCount : 0,
      lastIngestSec: snap && snap.lastIngestTs ? Math.round((Date.now() - snap.lastIngestTs) / 1000) : null,
      recorder: chainRecorderState(),
      lookback: cfg.oiLookback,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const optAge = state.optionLtpUpdatedAt ? Math.round((Date.now() - state.optionLtpUpdatedAt) / 1000) : null;
  const data = loadData();
  const cfg = oiStrategy.getConfig();

  let livePnl = null;
  if (pos && state.optionLtp != null) {
    livePnl = parseFloat(((state.optionLtp - pos.optionEntryLtp) * (pos.qty || oiLotQty())).toFixed(2));
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
    // OI_WALL_FADE context
    lastBand: state.lastBand,
    lastWallStrike: s ? s.wallStrike : null,
    lastWallSide:   s ? s.wallSide : null,
    lastWallDelta:  s ? s.wallDeltaPct : null,
    lastPressed:    s ? s.pressed : null,
    lastDefend:     s ? s.defend : null,
    lastBreakAway:  s ? s.breakAway : null,
    lastRejected:   s ? s.rejected : null,
    oiStrikes:      s ? s.oiStrikes : 0,
    recorder: chainRecorderState(),
    dayClosed: state.dayClosed, dayClosedReason: state.dayClosedReason,
    stopOuts: state.stopOuts, maxDailyLosses: _maxDailyLosses(),
    maxDailyTrades: _maxDailyTrades(),
    dailyProfitLock: _dailyProfitLock(), maxDailyLoss: _maxDailyLoss(),
    lastSkipReason: s && s.signal === "NONE" ? (s.skipReason || s.reason) : null,
    cfg: {
      resMin: cfg.resolutionMins, minBandPts: cfg.minBandPts, wallNearPts: cfg.wallNearPts,
      oiLookback: cfg.oiLookback, wallBuildPct: cfg.wallBuildPct, wallShedPct: cfg.wallShedPct,
      maxOiSpanSec: cfg.maxOiSpanSec, slBufferPts: cfg.slBufferPts,
      minTargetPts: cfg.minTargetPts, requireInnerWall: cfg.requireInnerWall,
      entryStart: _envStr("OIWF_ENTRY_START", "09:45"), entryEnd: _envStr("OIWF_ENTRY_END", "14:45"),
      forcedExit: _envStr("OIWF_FORCED_EXIT", "15:15"),
    },
    position: pos ? {
      side: pos.side, symbol: pos.symbol, entrySpot: pos.entrySpot, optionEntryLtp: pos.optionEntryLtp,
      slSpot: pos.slSpot, targetSpot: pos.targetSpot, riskPts: pos.riskPts, targetPts: pos.targetPts, rr: pos.rr,
      wallStrike: pos.wallStrike, wallSide: pos.wallSide, wallDeltaPct: pos.wallDeltaPct,
      bandLo: pos.bandLo, bandHi: pos.bandHi, bandMid: pos.bandMid, bandPts: pos.bandPts,
      optionStrike: pos.optionStrike, optionExpiry: pos.optionExpiry,
      peakPremium: pos.peakPremium, entryTime: pos.entryTime, signalStrength: pos.signalStrength,
      qty: pos.qty, currentOptLtp: state.optionLtp,
      heldSec: Math.round((Date.now() - pos.entryTimeMs) / 1000),
    } : null,
    totalPnl: data.totalPnl, capital: data.capital,
  });
});

router.get("/status", (req, res) => {
  const liveActive = sharedSocketState.getOiWallFadeMode() === "OI_WALL_FADE_LIVE";
  const data = loadData();
  const pos  = state.position;
  const cfg  = oiStrategy.getConfig();
  const rec  = chainRecorderState();

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl < 0).length;
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OI Wall Fade — Paper</title>${faviconLink()}
<style>${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.oi-card{background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;margin-bottom:18px;}
.oi-row{display:flex;gap:20px;flex-wrap:wrap;font-size:0.78rem;color:#e2e8f0;margin-top:8px;}
.oi-row .k{color:var(--muted-1,#8ba1c2);margin-right:5px;}
.brk{font-size:0.72rem;color:#f59e0b;margin-top:8px;}
.chart-box{background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;}
.ladder-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
table.ladder{width:100%;min-width:420px;border-collapse:collapse;font-size:0.74rem;}
table.ladder th{text-align:right;color:var(--muted-1,#8ba1c2);font-weight:600;padding:5px 8px;border-bottom:1px solid #1a2236;text-transform:uppercase;letter-spacing:0.04em;font-size:0.64rem;}
table.ladder td{text-align:right;padding:5px 8px;border-bottom:1px solid #101a2c;color:#cbd5e1;}
table.ladder tr.atm td{background:#101a2c;color:#e2e8f0;}
table.ladder td.wall{color:#f59e0b;font-weight:600;}
.up{color:#10b981;} .down{color:#ef4444;}
@media(max-width:640px){ table.ladder{min-width:340px;font-size:0.7rem;} }
</style>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
</head><body>
${buildSidebar('oiWallFadePaper', liveActive)}
<!-- main-content, NOT main: no stylesheet in this app defines a bare .main rule,
     so that class leaves the page sitting underneath the 200px sidebar and
     overflowing to the right. bbRsiStyleCSS owns the margin-left and the 900px
     breakpoint that drops it to 0. --><div class="main-content">
${bbRsiTopBar({
  title: "🧱 OI Wall Fade — Paper",
  metaLine: `NIFTY 50 ${cfg.resolutionMins}m · fade the wall the writers are still defending (ΔOI ≥+${cfg.wallBuildPct}%) · target the mid-band · stop ${cfg.slBufferPts}pt beyond the wall`,
  running: state.running,
  primaryAction: { href: "/oi-wall-fade-paper/start", label: "▶ Start", color: "#0369a1" },
  stopAction:    { href: "/oi-wall-fade-paper/stop",  label: "■ Stop" },
  historyHref: "/oi-wall-fade-paper/history",
})}

${bbRsiCapitalStrip({ starting: startCap, current: startCap + (data.totalPnl || 0), allTime: data.totalPnl || 0 })}

${rec.ok ? "" : `<div class="oi-card" style="border-color:#7f1d1d;background:#2a0e0e;"><strong style="color:#fecaca;">No OI feed.</strong> <span style="font-size:0.78rem;color:#fca5a5;">${rec.enabled ? "Per-strike OI capture is off (OPTION_CHAIN_RECORD_OI)." : "The option chain recorder is off (OPTION_CHAIN_RECORDER_ENABLED + TICK_RECORDER_ENABLED)."} This strategy reads nothing else and cannot start.</span></div>`}

<div class="oi-card">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Today — the wall watch</div>
    <div style="font-size:0.8rem;color:#94a3b8;" id="oi-age">—</div>
  </div>
  <div class="oi-row" id="oi-row"><div>Waiting for the first OI ladder…</div></div>
  <div id="oi-skip" style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-top:8px;"></div>
  ${state.dayClosed ? `<div class="brk">⏸️ ${state.dayClosedReason}</div>` : ""}
</div>

${bbRsiStatGrid([
  { label: "Session P&L", value: inr(state.sessionPnl), color: state.sessionPnl >= 0 ? "#10b981" : "#ef4444" },
  { label: "Trades", value: `${state.tradesTaken}/${_maxDailyTrades()}` },
  { label: "W / L", value: `${wins} / ${losses}` },
  { label: "CE Wall", value: state.lastBand ? String(state.lastBand.ce.strike) : "—" },
  { label: "PE Wall", value: state.lastBand ? String(state.lastBand.pe.strike) : "—" },
  { label: "Spot", value: state.lastTickPrice != null ? String(state.lastTickPrice) : "—" },
])}

${bbRsiCurrentBar({ bar: state.formingBar, resMin: cfg.resolutionMins })}

<div style="margin-bottom:18px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;font-weight:600;">NIFTY 50 ${cfg.resolutionMins}m — walls, mid-band and the bracket</div>
  <div class="chart-box" style="height:420px;">
    <div id="chart" style="width:100%;height:100%;"></div>
    <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;">
      <span style="color:#f59e0b;">── CE / PE walls</span> &nbsp;<span style="color:#0ea5e9;">── Mid-band</span> &nbsp;<span style="color:#ef4444;">── Stop</span>
    </div>
  </div>
</div>

<div class="oi-card">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:8px;">The ladder — OI and ΔOI over ${cfg.oiLookback} OI move(s)</div>
  <div class="ladder-wrap">
    <table class="ladder"><thead><tr><th>CE ΔOI</th><th>CE OI</th><th>Strike</th><th>PE OI</th><th>PE ΔOI</th></tr></thead>
    <tbody id="ladder-body"><tr><td colspan="5" style="text-align:center;color:var(--muted-1,#8ba1c2);">Waiting for the chain recorder…</td></tr></tbody></table>
  </div>
</div>

<div id="pos-card" style="margin-bottom:18px;">${_positionCardHtml(pos, state.optionLtp)}</div>

${bbRsiActivityLog({ logsJSON: JSON.stringify(state.log.slice(-200)) })}
</div>
<script>
${modalJS()}
async function oiRefresh() {
  try {
    const r = await fetch('/oi-wall-fade-paper/status/data', { cache: 'no-store' });
    const d = await r.json();
    var row = document.getElementById('oi-row');
    if (row) {
      var b = d.lastBand;
      var cells = [];
      cells.push('<div><span class="k">Band</span>' + (b ? b.lo + ' – ' + b.hi + ' (' + b.bandPts + 'pt)' : '—') + '</div>');
      cells.push('<div><span class="k">Mid</span>' + (b ? b.mid : '—') + '</div>');
      cells.push('<div><span class="k">Pressing</span>' + (d.lastWallStrike != null ? d.lastWallSide + ' ' + d.lastWallStrike : 'no wall') + '</div>');
      cells.push('<div><span class="k">Wall ΔOI</span>' + (d.lastWallDelta != null ? (d.lastWallDelta > 0 ? '+' : '') + d.lastWallDelta + '%' : '—') + '</div>');
      cells.push('<div><span class="k">Reading</span>' + (d.lastBreakAway ? 'BREAK — stand aside' : (d.lastDefend ? 'DEFEND' : '—')) + '</div>');
      cells.push('<div><span class="k">Rejected</span>' + (d.lastRejected == null ? '—' : (d.lastRejected ? 'yes' : 'no')) + '</div>');
      cells.push('<div><span class="k">Live strikes</span>' + (d.oiStrikes || 0) + '</div>');
      row.innerHTML = cells.join('');
    }
    var sk = document.getElementById('oi-skip');
    if (sk) sk.textContent = d.lastSkipReason || '';
  } catch (e) {}
}
async function ladderRefresh() {
  try {
    const r = await fetch('/oi-wall-fade-paper/status/oi-data', { cache: 'no-store' });
    const d = await r.json();
    var tb = document.getElementById('ladder-body');
    if (!tb) return;
    if (!d.rows || !d.rows.length) {
      tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#8ba1c2;">No live strikes — the chain recorder has nothing yet.</td></tr>';
    } else {
      var ceW = d.ceWall ? d.ceWall.strike : null, peW = d.peWall ? d.peWall.strike : null;
      function pct(v){ if (v == null) return '<span style="color:#64748b;">—</span>'; return '<span class="' + (v >= 0 ? 'up' : 'down') + '">' + (v > 0 ? '+' : '') + v + '%</span>'; }
      function oi(v){ return v == null ? '—' : Number(v).toLocaleString('en-IN'); }
      tb.innerHTML = d.rows.map(function(r){
        return '<tr class="' + (r.isAtm ? 'atm' : '') + '">' +
          '<td>' + pct(r.ceD) + '</td>' +
          '<td class="' + (r.strike === ceW ? 'wall' : '') + '">' + oi(r.ceOi) + '</td>' +
          '<td>' + r.strike + (r.isAtm ? ' •' : '') + '</td>' +
          '<td class="' + (r.strike === peW ? 'wall' : '') + '">' + oi(r.peOi) + '</td>' +
          '<td>' + pct(r.peD) + '</td></tr>';
      }).join('');
    }
    var age = document.getElementById('oi-age');
    if (age) age.textContent = (d.pcr != null ? 'band PCR ' + d.pcr + '  ·  ' : '') + (d.lastIngestSec != null ? 'OI updated ' + d.lastIngestSec + 's ago' : 'no OI yet');
  } catch (e) {}
}
oiRefresh(); ladderRefresh();
setInterval(oiRefresh, 4000);
setInterval(ladderRefresh, 6000);
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
  var lines = [], _zoomed = false;
  function addLine(price, color, title, style) {
    if (price == null || !isFinite(price)) return;
    lines.push(cs.createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title }));
  }
  async function fetchChart(){
    try {
      var r = await fetch('/oi-wall-fade-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        if (!_zoomed) { try {
          chart.timeScale().setVisibleRange({ from:d.candles[0].time, to:d.candles[d.candles.length-1].time }); _zoomed=true;
        } catch(_){} }
      }
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      lines.forEach(function(l){ try { cs.removePriceLine(l); } catch(_){} });
      lines = [];
      var tag = d.bandFrozen ? ' (frozen)' : '';
      addLine(d.ceWall,  '#f59e0b', 'CE wall' + tag, LightweightCharts.LineStyle.Dashed);
      addLine(d.peWall,  '#f59e0b', 'PE wall' + tag, LightweightCharts.LineStyle.Dashed);
      addLine(d.bandMid, '#0ea5e9', 'Mid-band', LightweightCharts.LineStyle.Dotted);
      addLine(d.entryPrice, '#94a3b8', 'Entry', LightweightCharts.LineStyle.Dotted);
      addLine(d.stopLoss,   '#ef4444', 'Stop',  LightweightCharts.LineStyle.Solid);
      addLine(d.target,     '#10b981', 'Target', LightweightCharts.LineStyle.Solid);
    } catch(e) {}
  }
  fetchChart();
  setInterval(fetchChart, 4000);
  window.addEventListener('resize', function(){ chart.applyOptions({ width: container.clientWidth }); });
})();
</script>
</body></html>`;
  res.send(html);
});

function _positionCardHtml(pos, optLtp) {
  if (!pos) {
    return `<div style="background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;color:var(--muted-1,#8ba1c2);font-size:0.78rem;">No open position.</div>`;
  }
  const live = optLtp != null ? ((optLtp - pos.optionEntryLtp) * pos.qty).toFixed(0) : "—";
  return `<div style="background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;">
  <div style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:8px;">Open position</div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:0.8rem;color:#e2e8f0;">
    <div><span style="color:var(--muted-1,#8ba1c2);">Side</span> ${pos.side}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Symbol</span> ${pos.symbol}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Fading</span> ${pos.wallSide} wall ${pos.wallStrike} (ΔOI +${pos.wallDeltaPct}%)</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Entry</span> ${pos.entrySpot}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Mid-band</span> ${pos.targetSpot} (${pos.targetPts}pt)</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Stop</span> ${pos.slSpot} (${pos.riskPts}pt)</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">R:R</span> ${pos.rr}</div>
    <div><span style="color:var(--muted-1,#8ba1c2);">Live P&L</span> ₹${live}</div>
  </div>
</div>`;
}

// ── History + daily-file viewers + restore + reset ────────────────────────────
router.get("/history", (req, res) => {
  const data = loadData();
  const liveActive = sharedSocketState.getOiWallFadeMode() === "OI_WALL_FADE_LIVE";
  const startCap = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  res.send(renderHistoryPage({
    routePrefix: "/oi-wall-fade-paper",
    sidebarKey: "oiWallFadeHistory",
    pageTitle: "🧱 OI Wall Fade Paper Trade History",
    pageDocTitle: "OI Wall Fade Paper — History",
    modalLabel: "OI Wall Fade Paper",
    liveActive,
    sessions: data.sessions || [],
    totalPnl: data.totalPnl,
    startCap,
    emptyLabel: "Start OI Wall Fade paper trading to record your first session.",
  }));
});

const _OIWF_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  res.setHeader("Content-Disposition", `attachment; filename="oi_wall_fade_paper_skips_all_${today}.txt"`);
  const dates = skipLogger.listDates(MODE_KEY).map(d => d.date).sort();
  let body = "";
  for (const d of dates) { try { const p = skipLogger.filePathFor(MODE_KEY, d); if (fs.existsSync(p)) body += fs.readFileSync(p, "utf8"); } catch (_) {} }
  res.send(body);
});

router.get("/download/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_OIWF_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `oi_wall_fade_paper_skips_${date}.txt`);
});

router.get("/download/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_OIWF_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.download(p, `oi_wall_fade_paper_trades_${date}.txt`);
});

router.get("/view/skips/:date", (req, res) => {
  const date = req.params.date;
  if (!_OIWF_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.get("/view/trades/:date", (req, res) => {
  const date = req.params.date;
  if (!_OIWF_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(p);
});

router.delete("/session/:index", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop OI Wall Fade paper trading first before deleting a session." });
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
  if (state.running) return res.status(400).json({ success: false, error: "Stop OI Wall Fade paper trading before restoring." });
  const date = String(req.params.date || "").trim();
  if (!_OIWF_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const allTrades = tradeLogger.readDailyTrades(MODE_KEY, date);
  if (!allTrades.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadData();
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; if (key) seen.add(String(key)); }
  const missing = allTrades.filter(t => { const key = t.entryBarTime || t.entryTime || `${t.symbol}@${t.entryPrice}@${t.entryTime}`; return key && !seen.has(String(key)); });
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const sessionPnl = parseFloat(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2));
  data.sessions.push({ date, strategy: (missing[0] && missing[0].strategy) || oiStrategy.NAME, pnl: sessionPnl, trades: missing, restoredFromJsonl: true });
  data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  data.totalPnl = parseFloat(data.sessions.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2));
  data.capital  = parseFloat((parseFloat(process.env.FYERS_INV_AMOUNT || "100000") + data.totalPnl).toFixed(2));
  saveData(data);
  return res.json({ success: true, restored: missing.length, sessionPnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/reset", (req, res) => {
  if (state.running) return res.status(400).json({ success: false, error: "Stop OI Wall Fade paper trading before resetting." });
  const fresh = parseFloat(process.env.FYERS_INV_AMOUNT || "100000");
  saveData({ capital: fresh, totalPnl: 0, sessions: [] });
  return res.json({ success: true, message: `OI Wall Fade paper trade history cleared. Capital reset to ₹${fresh.toLocaleString("en-IN")}` });
});

router.get("/download/trades.jsonl", (req, res) => {
  try {
    const data = loadData();
    const records = [];
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) records.push(Object.assign({ date: s.date, mode: MODE_KEY, strategy: s.strategy }, t));
    const today = new Date().toISOString().slice(0, 10);
    const ai = String(req.query.format || "").toLowerCase() === "ai" || req.query.ai === "1";
    if (ai) {
      const md = aiExport.buildMarkdown(records, { title: "OI Wall Fade paper trades (full log)", source: "oi-wall-fade-paper" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="oi_wall_fade_paper_trades_AI_${today}.md"`);
      return res.send(md);
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="oi_wall_fade_paper_trades_${today}.jsonl"`);
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

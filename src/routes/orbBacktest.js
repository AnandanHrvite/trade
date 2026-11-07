/**
 * ORB BACKTEST — /orb-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest of the Opening Range Breakout strategy. Reuses the
 * shared backtest UI helper for full parity with bb_rsi/PA backtest pages.
 *
 * Endpoints:
 *   GET /orb-backtest                → redirects to the last 30 days (no separate
 *                                      idle form — matches bb_rsi/PA/Trend_PB)
 *   GET /orb-backtest?from=&to=      → queue a background job + progress page
 *   GET /orb-backtest?…&jobId=       → render the completed job
 *   GET /orb-backtest/status?jobId=  → job progress poll (JSON)
 *   GET /orb-backtest/idle           → idle probe for /all-backtest (JSON or redirect)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const orbStrategy = require("../strategies/orb_breakout");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const vixFilter = require("../services/vixFilter");
const { faviconLink } = require("../utils/sharedNav");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const { isExpiryDate } = require("../utils/nseHolidays");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");
const tradeGuards = require("../utils/tradeGuards");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const ACCENT = "#10b981";
const ENDPOINT = "/orb-backtest";
const RESULT_KEY = "ORB_BACKTEST";


/**
 * Names the entry gates that paper/live apply but this backtest CANNOT, because
 * they need a live option chain (premium, bid-ask spread, futures OI) or a live
 * VIX quote — none of which exist in historical 5-min spot candles.
 *
 * Built from the CURRENT env rather than hard-coded, because a hard-coded sentence
 * silently goes stale the moment someone flips a toggle. Any gate listed here makes
 * the backtest OPTIMISTIC on trade count: paper/live will take the same trades or
 * fewer, never more. The OI gate in particular ships enabled and was invisible in
 * this disclosure until 2026-07-26.
 */
function _paperOnlyGates() {
  const on = (k, d) => (process.env[k] || d || "false").toLowerCase() === "true";
  const g = [];
  // Every default here MUST mirror the route's own read (orbPaper/orbLive
  // _simulateBuyInner). Hard-coding "80" for the premium floor advertised a band the
  // engine never used — the real fallback is 120.
  if (on("ORB_PREMIUM_GATE_ENABLED", "false")) g.push(`option-premium band ₹${process.env.ORB_PREMIUM_MIN || "120"}–₹${process.env.ORB_PREMIUM_MAX || "400"}`);
  // The spread gate has no on/off switch — paper/live call tradeGuards.checkSpread()
  // unconditionally — so it is ALWAYS active and must always be disclosed. Two ways
  // the old `parseFloat(ORB_MAX_SPREAD_PTS || "0") > 0` test fell silent on a LIVE
  // gate: (1) the ORB key unset, where paper/live fall back to the global
  // MAX_BID_ASK_SPREAD_PTS and then 2pt; (2) a zero or non-numeric threshold, which
  // does not disable the gate — checkSpread returns `spread <= max`, false for every
  // real quote, so it rejects essentially every entry. Say so rather than hiding it.
  const _rawSpread = process.env.ORB_MAX_SPREAD_PTS || process.env.MAX_BID_ASK_SPREAD_PTS || "2";
  const _maxSpread = parseFloat(_rawSpread);
  g.push(Number.isFinite(_maxSpread) && _maxSpread > 0
    ? `bid-ask spread ≤ ${_maxSpread}pt`
    : `bid-ask spread — threshold "${_rawSpread}" is not a positive number, so paper/live reject EVERY quote that has a spread`);
  if (on("OI_FILTER_ENABLED") && on("ORB_OI_ENABLED")) g.push("OI buildup filter");
  if (on("ORB_VIX_ENABLED")) g.push(`VIX ≤ ${process.env.ORB_VIX_MAX_ENTRY || "22"}`);
  return g;
}
function _paperOnlyGatesNote() {
  const g = _paperOnlyGates();
  return g.length
    ? `⚠️ ${g.length} entry gate${g.length > 1 ? "s are" : " is"} active in paper/live but NOT modelled here (no option chain in historical spot candles): ${g.join(", ")}. Paper/live will take these trades or FEWER — never more.`
    : `No paper/live-only entry gates are currently enabled, so the trade count here should match paper.`;
}

function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _parseMin(envKey, fallback) {
  const v = (process.env[envKey] || fallback).trim();
  const [h, m] = v.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
}
function istDateOf(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function istHHMMSS(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
function entryTsStr(unixSec) { return `${istDateOf(unixSec)}, ${istHHMMSS(unixSec)}`; }

async function runOrbBacktest(allCandles, expirySet, vixCandles = []) {
  if (!allCandles || !allCandles.length) return [];
  // Ascending time order is required so the flat array aligns with the per-day
  // grouping below (globalBase bookkeeping) for the multi-day signal window.
  allCandles = allCandles.slice().sort((a, b) => a.time - b.time);

  // Daily VIX series for the entry gate paper runs once a signal exists. No-op
  // unless ORB_VIX_ENABLED=true — checkBacktestVix decides that for itself.
  const lookupVix = vixFilter.buildVixLookup(vixCandles || []);

  const EXPIRY_ONLY = (process.env.ORB_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true";
  const DELTA      = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY  = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  // Use the same lot-qty helper as paper/live so LOT_MULTIPLIER and
  // NIFTY_LOT_SIZE flow through end-to-end (lot qty = NIFTY_LOT_SIZE × LOT_MULTIPLIER).
  const LOT_SIZE   = instrumentConfig.getLotQty();
  // EXIT (mirrors paper/live, 2026-11-07): the global profit lock is the ONLY
  // automatic exit. It is defined on option premium, so it is simulated on the
  // δ-modelled premium below; a position it never closes is closed at the day's
  // last candle (paper's TRADE_STOP_TIME session teardown).
  //
  // FUTURES MODE (2026-08-13). INSTRUMENT=NIFTY_FUTURES prices the SAME trades in
  // spot points: no delta, no theta, futures charges, slippage in index points.
  // Paper/live never apply the premium profit lock to a futures leg, so here too a
  // futures trade is held to the end of the session.
  const IS_FUT = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const PREM_GATE_ON = (process.env.ORB_PREMIUM_GATE_ENABLED || "false").toLowerCase() === "true";
  const PREM_MIN     = parseFloat(process.env.ORB_PREMIUM_MIN || "120");           // widened for slightly-ITM
  const PREM_MAX     = parseFloat(process.env.ORB_PREMIUM_MAX || "400");
  // Signal engine (orb_breakout.getSignal) needs prior-day history to seed its
  // volatility yardsticks — ATR(5m) and ATR(15m). We feed it a trailing MULTI-DAY
  // window ending at the current candle (OR + VWAP are day-scoped internally, so
  // the prior days do not pollute today's range). ~260 5-min bars ≈ 3.5 trading
  // days, which covers a 14-period ATR on 15-min bars from the first candle of
  // every day except day 1 of the range — that day is skipped outright (see the
  // _hasPriorDay parity guard below).
  // Not exposed in Settings, matching TREND_PB_SIG_WINDOW: it is harness plumbing
  // sized to the indicators, not a tuning dial.
  const SIG_WINDOW      = parseInt(process.env.ORB_SIG_WINDOW || "260", 10);
  const ENTRY_END_MIN   = _parseMin("ORB_ENTRY_END",   "11:30");
  const SEED_PREMIUM    = parseFloat(process.env.ORB_BT_SEED_PREMIUM || "240");   // slightly-ITM ≈ ATM + one strike intrinsic
  const SLIPPAGE_PREM   = parseFloat(process.env.ORB_BT_SLIPPAGE_PTS || "1.5");   // spread+slippage haircut EACH way (premium pts); was 0/frictionless
  // Global wait-after-any-exit cooldown (EXIT_REENTRY_COOLDOWN_CANDLES), unix secs.
  // Paper measures it from the exit's clock time: a tick exit inside the bar is
  // stamped at the bar open here, one given back by the close at the bar's CLOSE.
  const _REENTRY_COOLDOWN_SECS = tradeGuards.reentryCooldownMs(5) / 1000;
  // Confirmation and the retest/resume fallback both live INSIDE the engine, so the
  // backtest has no entry logic of its own — it polls getSignal each candle. The old
  // backtest-only `armed` retest gate and the V1/V2/V3 switches are gone.

  const byDate = new Map();
  for (const c of allCandles) {
    const d = new Date((c.time + 19800) * 1000);
    const dt = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    if (!byDate.has(dt)) byDate.set(dt, []);
    byDate.get(dt).push(c);
  }

  const trades = [];

  /** Simulated option premium at a spot price (δ model; theta is charged at the fill). */
  const _premAt = (pos, spot) => {
    const move = pos.side === "CE" ? (spot - pos.entrySpot) : (pos.entrySpot - spot);
    return Math.max(0.05, pos.optionEntryLtp + move * DELTA);
  };
  /** The spot level at which the simulated premium equals `prem`. */
  const _spotForPrem = (pos, prem) => {
    const move = DELTA > 0 ? (prem - pos.optionEntryLtp) / DELTA : 0;
    return pos.side === "CE" ? pos.entrySpot + move : pos.entrySpot - move;
  };

  // Global index of the first candle of the current day within `allCandles`.
  // Advanced by dayCandles.length on EVERY outer iteration (including skipped
  // days) so allCandles[globalBase + i] === dayCandles[i] stays true.
  let globalBase = 0;
  for (const [_dateStr, dayCandles] of byDate) {
    // Yield once per session so live ticks/orders sharing this process are not
    // starved while a long backtest runs.
    await new Promise(resolve => setImmediate(resolve));
    const _dayLen = dayCandles.length;
    if (dayCandles.length < 5) { globalBase += _dayLen; continue; }
    if (EXPIRY_ONLY && expirySet && !expirySet.has(_dateStr)) { globalBase += _dayLen; continue; }
    let position = null;
    let _reentryBlockUntilTs = 0;   // wait-after-any-exit cooldown, reset per day like paper's /start
    // Book a closed position. `exitClockTs` = when paper's clock sees the exit —
    // the start of the wait-after-exit cooldown.
    const _book = (pos, exitClockTs) => {
      trades.push(buildTradeRecord(pos));
      if (_REENTRY_COOLDOWN_SECS > 0) _reentryBlockUntilTs = exitClockTs + _REENTRY_COOLDOWN_SECS;
    };

    for (let i = 0; i < dayCandles.length; i++) {
      const c = dayCandles[i];
      const istMin = _utcSecToIstMins(c.time);
      // This candle's index in the flat multi-day array. The signal engine needs
      // the multi-day window, not just today's bars.
      const gIdx = globalBase + i;

      // ── In-position: the global profit lock, simulated on the δ-modelled premium ──
      //    Paper checks it on every tick; a bar is replayed as open → adverse
      //    extreme → favourable extreme → close (the conservative path). A lock
      //    tripped on the way down fills at the spot level of its floor (never
      //    better than the open); one armed and given back inside the bar fills at
      //    the close. Futures legs never carry the premium lock (paper/live skip it).
      if (position && !IS_FUT) {
        const isCE = position.side === "CE";
        const _lock = (prem) => tradeGuards.checkProfitLock(position.optionEntryLtp, prem, position.peakPremium);
        // a) the open
        const pOpen = _premAt(position, c.open);
        if (pOpen > position.peakPremium) position.peakPremium = pOpen;
        let hit = _lock(pOpen);
        if (hit) {
          closePos(position, c.open, c.time, hit);
          _book(position, c.time); position = null; continue;
        }
        // b) open → adverse extreme
        hit = _lock(_premAt(position, isCE ? c.low : c.high));
        if (hit) {
          const floor = tradeGuards.profitLockFloorLtp(position.optionEntryLtp, position.peakPremium,
            tradeGuards.PROFIT_LOCK_FLOOR_PCT, tradeGuards.PROFIT_LOCK_TRAIL_PCT);
          const raw = _spotForPrem(position, floor);
          const fill = isCE ? Math.min(c.open, raw) : Math.max(c.open, raw);
          closePos(position, fill, c.time, hit);
          _book(position, c.time); position = null; continue;
        }
        // c) adverse → favourable extreme: the peak rises, nothing exits
        const pFav = _premAt(position, isCE ? c.high : c.low);
        if (pFav > position.peakPremium) position.peakPremium = pFav;
        // d) favourable → close: a lock armed by THIS peak and given back
        hit = _lock(_premAt(position, c.close));
        if (hit) {
          closePos(position, c.close, c.time, hit);
          _book(position, c.time + 5 * 60); position = null; continue;
        }
      }

      // Flat → eval ORB signal.
      if (!position && istMin < ENTRY_END_MIN) {
        // Open the position at candle `oc` from signal `s`. Closes over `position`
        // from the day loop.
        const _open = (s, oc, suffix) => {
          position = {
            date: istDateOf(oc.time),
            side: s.side,
            entryTime: oc.time,
            entrySpot: oc.close,
            optionEntryLtp: SEED_PREMIUM,
            peakPremium: SEED_PREMIUM,
            orh: s.orh, orl: s.orl, rangePts: s.rangePts,
            targetSpot: s.targetSpot,
            signalStrength: s.signalStrength,
            vwap: s.vwap, volRatio: s.volRatio, wickRatio: s.wickRatio,
            entryReason: s.reason + (suffix || ""),
          };
        };
        // Premium-range gate — backtest uses SEED_PREMIUM as the entry-premium
        // proxy, so this gate is effectively a config sanity check (will skip
        // every trade if SEED_PREMIUM lies outside the band).
        const _premOk = !(PREM_GATE_ON && (SEED_PREMIUM < PREM_MIN || SEED_PREMIUM > PREM_MAX));

        // Multi-day trailing window ending at THIS candle so getSignal can seed
        // ATR(5m)/ATR(15m) from prior days. The signal fires on the CONFIRMATION
        // candle, so `c` is the entry candle and _open(sig, c) buys its close.
        const seen = allCandles.slice(Math.max(0, gIdx - SIG_WINDOW), gIdx + 1);

        // PARITY GUARD: paper/live ALWAYS hold a ~7-day preload, so getSignal there
        // never runs without prior-day history. On the FIRST day of a backtest range
        // the window contains today only, ATR is unseeded, and the ATR-dependent
        // gates (decisive body, OR-vs-ATR15) fail OPEN — so the backtest could take a
        // day-1 trade that paper, with its preload, would have filtered. Skip that
        // day rather than report a trade the live engine could never produce.
        const _hasPriorDay = seen.length > 0
          && Math.floor((seen[0].time + 19800) / 86400) < Math.floor((c.time + 19800) / 86400);
        if (!_hasPriorDay) continue;

        // The engine owns confirmation AND the retest/resume fallback internally,
        // so the backtest just polls it each candle and buys whatever it returns.
        const sig = orbStrategy.getSignal(seen, { silent: true });
        // VIX gate — paper runs it only AFTER a signal exists, so keep that order.
        const _vixOk = sig.signal === "NONE" || !sig.side
          || vixFilter.checkBacktestVix(lookupVix(c.time), sig.signalStrength, { mode: "orb" }).allowed;
        // Wait-after-any-exit cooldown: both sides (paper rejects in simulateBuy, after VIX).
        const _reentryBlocked = _reentryBlockUntilTs > 0 && c.time < _reentryBlockUntilTs;
        if ((sig.signal === "BUY_CE" || sig.signal === "BUY_PE") && _premOk && _vixOk && !_reentryBlocked) _open(sig, c);
      }
    }
    // Session teardown: paper's TRADE_STOP_TIME auto-stop closes whatever is still
    // open, so the day's last candle close is where an unclosed trade ends here.
    if (position) {
      const last = dayCandles[dayCandles.length - 1];
      closePos(position, last.close, last.time, "Session stopped (end of day candles)");
      trades.push(buildTradeRecord(position));
    }
    globalBase += _dayLen;
  }

  function closePos(pos, exitSpot, exitTime, reason) {
    const candlesHeld = ((exitTime - pos.entryTime) / 60) / 5;
    const thetaCost = (THETA_DAY * candlesHeld) / 78;
    const spotMove = pos.side === "CE" ? (exitSpot - pos.entrySpot) : (pos.entrySpot - exitSpot);

    if (IS_FUT) {
      // Index points, both ways, with the same per-side slippage the option run pays
      // (ORB_BT_SLIPPAGE_PTS, read here as INDEX points rather than premium points).
      const netPts  = spotMove - 2 * SLIPPAGE_PREM;
      const charges = getCharges({ broker: "fyers", isFutures: true, entryPremium: pos.entrySpot, exitPremium: exitSpot, qty: LOT_SIZE });
      const fpnl = parseFloat((netPts * LOT_SIZE - charges).toFixed(2));
      pos.exitTime = exitTime;
      pos.exitSpot = exitSpot;
      pos.optionExitLtp = null;      // no option leg in this mode
      pos.exitReason = reason;
      pos.pnl = fpnl;
      pos.heldCandles = Math.round(candlesHeld);
      return;
    }

    // Buy high / sell low: haircut the exit premium by slippage on BOTH legs so
    // fills aren't frictionless (was overstating every ORB trade's P&L).
    const exitPrem = Math.max(0.05, pos.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE - 2 * SLIPPAGE_PREM);
    const charges = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
    const pnl = parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2));
    pos.exitTime = exitTime;
    pos.exitSpot = exitSpot;
    pos.optionExitLtp = parseFloat(exitPrem.toFixed(2));
    pos.exitReason = reason;
    pos.pnl = pnl;
    pos.heldCandles = Math.round(candlesHeld);
  }

  function buildTradeRecord(p) {
    return {
      side: p.side,
      entry: entryTsStr(p.entryTime),
      exit:  entryTsStr(p.exitTime),
      entryTs: p.entryTime, exitTs: p.exitTime,
      ePrice: p.entrySpot, xPrice: p.exitSpot, sl: null,   // no stop exists — profit lock only
      pnl: p.pnl,
      reason: p.exitReason,
      entryReason: p.entryReason,
      // ORB-specific
      orh: p.orh, orl: p.orl, rangePts: p.rangePts,
      strength: p.signalStrength,
      eOpt: p.optionEntryLtp, xOpt: p.optionExitLtp,
      held: p.heldCandles,
    };
  }

  return trades;
}

// ── Routes ──────────────────────────────────────────────────────────────────

// /idle is polled by /all-backtest to detect when the synchronous backtest finishes.
// Poll endpoint for the progress page (mirrors EMA_RSI_ST backtest).
router.get("/status", (req, res) => {
  const job = backtestJobs.getJob(req.query.jobId);
  if (!job) return res.json({ status: "not_found" });
  res.json({ status: job.status, progress: job.progress, elapsed: Date.now() - job.startedAt, error: job.error });
});

router.get("/idle", (req, res) => {
  if (req.accepts(["json", "html"]) === "json" || req.query.json === "1") {
    return res.json({ idle: backtestJobs.isIdle() });
  }
  return res.redirect("/orb-backtest");
});

// Rendered trade-log / stats helper — shared by the completed-job branch.
function _renderOrbResults(res, from, to, trades, stats) {
  const html = renderBacktestResults({
    mode: "ORB",
    accent: ACCENT,
    strategyName: orbStrategy.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "orbBacktest",
    extraTradeColumns: [
      { key: "rangePts", label: "Range (pt)" },
      { key: "strength", label: "Sig" },
    ],
    extraStats: [
      { label: "Avg OR Range", value: trades.length ? `${Math.round(trades.reduce((a, t) => a + (t.rangePts || 0), 0) / trades.length)}pt` : "—" },
      { label: "STRONG Signals", value: trades.filter(t => t.strength === "STRONG").length },
      { label: "Avg Held Candles", value: trades.length ? Math.round(trades.reduce((a, t) => a + (t.held || 0), 0) / trades.length) : "—" },
    ],
    notes: `${instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" ? "FUTURES MODE — P&L is index points × lot, futures charges, no δ/θ (the premium profit lock is skipped, as in paper/live — trades are held to the session end). " : ""}Premium approximated via δ + θ from historical 5-min candles (no live option chain) — treat ₹ as directional only; slightly-ITM entry seeded at ₹${process.env.ORB_BT_SEED_PREMIUM || "240"}. Entry: 09:15–09:30 opening range, day sanity (OR ≤ ${process.env.ORB_OR_ATR_MAX || "2.5"}×ATR15${parseFloat(process.env.ORB_OR_MAX_PTS || "0") > 0 ? ` and ≤ ${process.env.ORB_OR_MAX_PTS}pt` : ""}, gap ≤ ${process.env.ORB_GAP_OR_MULT || "3"}×OR), first close beyond OR ± buffer whose body is ≥ ${process.env.ORB_BODY_ATR_MULT || "0.6"}×ATR5${parseFloat(process.env.ORB_BODY_OR_CAP || "0") > 0 ? ` (capped at ${process.env.ORB_BODY_OR_CAP}×OR)` : ""} on the right side of VWAP (a close that clears the edge but is not decisive is skipped and the hunt continues unless ORB_BREAKOUT_RESCAN=false), then ONE confirmation candle (or a retest/resume within ${process.env.ORB_RETEST_MAX_WAIT || "6"} candles); cut-off ${process.env.ORB_ENTRY_END || "11:30"} IST. Exit: the global profit lock only (simulated on the δ-modelled premium); anything still open is closed at the day's last candle. ${_paperOnlyGatesNote()}`,
  });
  res.send(html);
}

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  // No params → default to last 30 days so the page always renders the full
  // results layout (matches bb_rsi/PA backtest behaviour — no separate idle UI).
  if (!from || !to) {
    const today = new Date();
    const def30 = new Date(); def30.setDate(today.getDate() - 30);
    const fmt = d => d.toISOString().slice(0, 10);
    return res.redirect(`/orb-backtest?from=${fmt(def30)}&to=${fmt(today)}`);
  }

  // ── Background job system ──────────────────────────────────────────────────
  // The fetch chunks the range into months (350ms rate-limit sleep + retries per
  // month), so a multi-year range takes minutes — far past an HTTP timeout if run
  // synchronously (which returned an empty candle set → 0 trades). Run it as a
  // background job with progress polling, exactly like the EMA_RSI_ST backtest.
  const jobId = req.query.jobId;

  if (!jobId) {
    const activeJob = backtestJobs.getActiveJob();
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "ORB Backtest"));

    const { id } = backtestJobs.createJob("orb");

    (async () => {
      try {
        console.log(`🔍 ORB Backtest job ${id}: ${from} → ${to}`);
        backtestJobs.updateProgress(id, { phase: "Fetching candle data…", pct: 0 });
        const _onFetchProgress = (p) => backtestJobs.updateProgress(id, p);
        const candles = await fetchCandlesCachedBT(NIFTY_INDEX_SYMBOL, "5", from, to, false, _onFetchProgress);

        if (!Array.isArray(candles) || candles.length < 5) {
          // Distinguish "Fyers had no data for this range" (0 candles — future dates,
          // beyond available history, or a token/entitlement gap) from a genuinely
          // narrow range (a handful of candles). The old message told the user to
          // "widen the range" even when they'd asked for a whole month and Fyers
          // simply returned nothing — misleading. Real reason is in the server logs
          // (fetchChunk logs the Fyers getHistory response).
          const n = Array.isArray(candles) ? candles.length : 0;
          const msg = n === 0
            ? `Fyers returned no historical candles for ${from} → ${to}. Most often the Fyers session needs re-login — an expired token returns no data (not an auth error), so this looks like "no history". Log in to Fyers again, then retry. Otherwise the range may be in the future / beyond available history. The getHistory response is in the server logs.`
            : `Only ${n} candle(s) for ${from} → ${to} — the range is too narrow. Widen it to at least a week of trading days.`;
          backtestJobs.failJob(id, msg);
          return;
        }

        // Pre-compute expiry-day set if ORB_EXPIRY_DAY_ONLY is on
        let expirySet = null;
        if ((process.env.ORB_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
          const uniqueDates = new Set();
          for (const c of candles) {
            const d = new Date((c.time + 19800) * 1000);
            uniqueDates.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
          }
          expirySet = new Set();
          for (const dt of uniqueDates) {
            try { if (await isExpiryDate(dt)) expirySet.add(dt); } catch (_) {}
          }
          console.log(`📅 ORB expiry-only: ${expirySet.size}/${uniqueDates.size} trading days qualified`);
        }

        // Daily VIX for the entry gate. Only fetched when the gate is on; a failed
        // fetch leaves it empty and checkBacktestVix applies VIX_FAIL_MODE, exactly
        // as paper behaves when the live VIX read fails.
        const vixCandles = vixFilter.getVixEnabled("orb")
          ? await fetchCandlesCachedBT(vixFilter.VIX_SYMBOL, "D", from, to, false).catch((e) => {
              console.warn(`[orb-backtest] VIX candle fetch failed: ${e.message}`);
              return [];
            })
          : [];

        backtestJobs.updateProgress(id, { phase: `Running ORB backtest (${candles.length.toLocaleString()} candles)…`, pct: 5 });
        const trades = await runOrbBacktest(candles, expirySet, vixCandles);
        const stats = computeBacktestStats(trades);
        // P&L is computed in ₹ (premium × LOT_SIZE − charges). Mark the result
        // so /all-backtest renders it as ₹ instead of "pts".
        stats.optionSim   = true;
        stats.delta       = parseFloat(process.env.BACKTEST_DELTA     || "0.55");
        stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");

        // Save for /all-backtest dashboard
        try {
          saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: "5" } });
        } catch (e) { console.warn("[orb-backtest] saveResult failed:", e.message); }

        backtestJobs.completeJob(id, { trades, stats, from, to });
        console.log(`✅ ORB Backtest job ${id} complete — ${trades.length} trades`);
      } catch (err) {
        console.error("[orb-backtest] job error:", err);
        backtestJobs.failJob(id, err.message);
      }
    })();

    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "ORB Backtest"));
  }

  // ── Render completed job ───────────────────────────────────────────────────
  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "ORB Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));

  const { trades, stats } = job.result;
  return _renderOrbResults(res, from, to, trades, stats);
});


function _errLightAttr() {
  return require("../utils/theme").resolveTheme() === "light" ? ' data-theme="light"' : "";
}

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html${_errLightAttr()}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>ORB Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;}
:root[data-theme="light"] body{background:#f4f6f9;color:#334155;}
:root[data-theme="light"] h2{color:#b91c1c;}
:root[data-theme="light"] a{border-color:#e0e4ea;background:#ffffff;color:#047857;}
@media(max-width:768px){body{padding:24px 14px;}a{min-height:44px;display:inline-flex;align-items:center;justify-content:center;}}</style>
</head><body><h2>ORB Backtest Failed</h2><p>${msg}</p><p><b>${from || ""}</b> → <b>${to || ""}</b></p><a href="/orb-backtest">← Back</a></body></html>`;
}

module.exports = router;
// Exposed for offline unit-testing of the entry/exit engine (no Fyers needed).
module.exports.runOrbBacktest = runOrbBacktest;
// Exported for the regression suite: the disclosure of paper/live-only entry gates
// must track the live env, not a sentence someone forgets to update.
module.exports._paperOnlyGates = _paperOnlyGates;

/**
 * ORB BACKTEST — /orb-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest of the Opening Range Breakout strategy. Reuses the
 * shared backtest UI helper for full parity with bb_rsi/PA backtest pages.
 *
 * Endpoints:
 *   GET /orb-backtest                → form (no params)
 *   GET /orb-backtest?from=&to=      → run + render results
 *   GET /orb-backtest/idle           → idle landing
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const orbStrategy = require("../strategies/orb_breakout");
const orbExits    = require("../strategies/orbExits");
const orbStopRisk = require("../utils/orbStopRisk");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");
const sharedSocketState = require("../utils/sharedSocketState");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const { isExpiryDate } = require("../utils/nseHolidays");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");

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
  if (on("ORB_PREMIUM_GATE_ENABLED", "true")) g.push(`option-premium band ₹${process.env.ORB_PREMIUM_MIN || "80"}–₹${process.env.ORB_PREMIUM_MAX || "400"}`);
  if (parseFloat(process.env.ORB_MAX_SPREAD_PTS || "0") > 0) g.push(`bid-ask spread ≤ ${process.env.ORB_MAX_SPREAD_PTS}pt`);
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

function runOrbBacktest(allCandles, expirySet) {
  if (!allCandles || !allCandles.length) return [];
  // Ascending time order is required so the flat array aligns with the per-day
  // grouping below (globalBase bookkeeping) for the multi-day signal window.
  allCandles = allCandles.slice().sort((a, b) => a.time - b.time);

  const EXPIRY_ONLY = (process.env.ORB_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true";
  const DELTA      = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY  = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  // Use the same lot-qty helper as paper/live so LOT_MULTIPLIER and
  // NIFTY_LOT_SIZE flow through end-to-end (lot qty = NIFTY_LOT_SIZE × LOT_MULTIPLIER).
  const LOT_SIZE   = instrumentConfig.getLotQty();
  // Trend-following exit (mirrors paper/live): initial hard SL = breakout candle
  // low/high, breakeven after +N pts, EMA close-trail, strong-opposite-candle
  // exit, per-trade rupee loss cap, 15:15 EOD. (Replaced the old 2-candle swing
  // trail that exited winners on the first pullback.)
  // Breakeven / EMA-trail / opposite-candle thresholds are NOT read here any more —
  // they belong to the shared exit engine (src/strategies/orbExits.js), which reads
  // them fresh per call so a Settings change takes effect without a restart.
  const MAX_TRADE_LOSS = parseFloat(process.env.ORB_MAX_TRADE_LOSS || "1500");
  const PREM_STOP_PCT  = parseFloat(process.env.ORB_PREMIUM_STOP_PCT || "35");     // premium disaster backstop
  const PREM_GATE_ON = (process.env.ORB_PREMIUM_GATE_ENABLED || "true").toLowerCase() === "true";
  const PREM_MIN     = parseFloat(process.env.ORB_PREMIUM_MIN || "120");           // widened for slightly-ITM
  const PREM_MAX     = parseFloat(process.env.ORB_PREMIUM_MAX || "400");
  // Signal engine (orb_breakout.getSignal) needs prior-day history to seed
  // EMA20/EMA50/ADX/RSI. We feed it a trailing MULTI-DAY window ending at the
  // current candle (OR + VWAP are day-scoped internally, so the prior days do
  // not pollute today's range). ~260 5-min bars ≈ 3.5 trading days — enough to
  // seed a 50-EMA + ADX from the first minute of every day except day 1 of the
  // whole range (which then simply takes no trade — trend filter fails closed).
  const SIG_WINDOW      = parseInt(process.env.ORB_SIG_WINDOW || "260", 10);
  const FORCED_EXIT_MIN = _parseMin("ORB_FORCED_EXIT", "15:15");
  const ENTRY_END_MIN   = _parseMin("ORB_ENTRY_END",   "11:30");
  const SEED_PREMIUM    = parseFloat(process.env.ORB_BT_SEED_PREMIUM || "240");   // slightly-ITM ≈ ATM + one strike intrinsic
  const SLIPPAGE_PREM   = parseFloat(process.env.ORB_BT_SLIPPAGE_PTS || "1.5");   // spread+slippage haircut EACH way (premium pts); was 0/frictionless
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

  // Global index of the first candle of the current day within `allCandles`.
  // Advanced by dayCandles.length on EVERY outer iteration (including skipped
  // days) so allCandles[globalBase + i] === dayCandles[i] stays true.
  let globalBase = 0;
  for (const [_dateStr, dayCandles] of byDate) {
    const _dayLen = dayCandles.length;
    if (dayCandles.length < 5) { globalBase += _dayLen; continue; }
    if (EXPIRY_ONLY && expirySet && !expirySet.has(_dateStr)) { globalBase += _dayLen; continue; }
    let position = null;
    let tradesTaken = 0;
    const maxTrades = parseInt(process.env.ORB_MAX_DAILY_TRADES || "1", 10);

    for (let i = 0; i < dayCandles.length; i++) {
      const c = dayCandles[i];
      const istMin = _utcSecToIstMins(c.time);
      // This candle's index in the flat multi-day array. Both the signal engine and
      // the shared EMA trail need the multi-day window, not just today's bars.
      const gIdx = globalBase + i;

      // EOD forced exit. Paper checks the clock on every TICK, so it squares off at
      // the first tick at/after ORB_FORCED_EXIT — i.e. this candle's OPEN, not its
      // close. Booking c.close handed the backtest an extra 5 minutes of drift the
      // live engine never gets.
      if (position && istMin >= FORCED_EXIT_MIN) {
        closePos(position, c.open, c.time, `EOD square-off (${process.env.ORB_FORCED_EXIT || "15:15"})`);
        trades.push(buildTradeRecord(position));
        position = null; continue;
      }

      // ── In-position management ────────────────────────────────────────────
      // ORDER MATTERS, AND IT MIRRORS PAPER'S REAL TIMELINE:
      //   paper runs _checkExits on EVERY TICK   → rupee cap, premium stop, hard SL
      //   paper runs _managePositionOnClose once → opposite candle, breakeven, EMA
      // So inside a single candle the intrabar exits always get first refusal, and a
      // close-based rule can only fire on a candle that never touched the stop.
      //
      // This file used to evaluate them the other way round (opposite/EMA first),
      // which let a close-based rule book the candle's CLOSE on bars where paper had
      // already been stopped out minutes earlier — the backtest silently reported a
      // different trade from the one the live engine would have taken.
      if (position) {
        // ── 1. INTRABAR: per-trade loss cap + premium disaster stop ───────────
        //    Evaluated against the candle's adverse extreme to decide IF they trip,
        //    but the FILL is the spot level where the threshold is actually reached —
        //    not the bar extreme. Paper/live check per tick and fill at that tick, so
        //    booking the bar's worst price systematically overshot the very budget the
        //    cap exists to enforce (observed: a −₹2,052 fill on a ₹1,500 cap, 37%
        //    over). Gap-through stays honest: if the bar OPENED past the level, fill
        //    at the open.
        if (MAX_TRADE_LOSS > 0 || PREM_STOP_PCT > 0) {
          const _adverse  = position.side === "CE" ? c.low : c.high;
          const _spotMove = position.side === "CE" ? (_adverse - position.entrySpot) : (position.entrySpot - _adverse);
          const _curPrem  = Math.max(0.05, position.optionEntryLtp + _spotMove * DELTA);
          // Thresholds come from the shared exit engine — the backtest only decides
          // the FILL price (below), never the rule.
          const _hitLoss  = orbExits.isMaxTradeLossHit((_curPrem - position.optionEntryLtp) * LOT_SIZE);
          const _hitPrem  = orbExits.isPremiumStopHit(_curPrem, position.optionEntryLtp);
          if (_hitLoss || _hitPrem) {
            // premium drop that trips the binding threshold → the spot level it implies
            const _dropPrem = _hitLoss
              ? MAX_TRADE_LOSS / LOT_SIZE
              : position.optionEntryLtp * (PREM_STOP_PCT / 100);
            const _dropSpot = DELTA > 0 ? _dropPrem / DELTA : Math.abs(_spotMove);
            let _fill = position.side === "CE" ? position.entrySpot - _dropSpot : position.entrySpot + _dropSpot;
            // never better than the bar could actually offer
            if (position.side === "CE") _fill = Math.min(_fill, c.open <= _fill ? c.open : _fill);
            else                        _fill = Math.max(_fill, c.open >= _fill ? c.open : _fill);
            closePos(position, _fill, c.time, (_hitPrem && !_hitLoss) ? `Premium disaster stop (−${PREM_STOP_PCT}%)` : `Max trade loss (₹${MAX_TRADE_LOSS})`);
            trades.push(buildTradeRecord(position)); position = null; continue;
          }
        }
        // ── 2. INTRABAR: hard SL breach against this candle's extreme ─────────
        //    Gap-through: fill at the open if the bar gapped past the stop.
        if (position.side === "CE" && c.low <= position.slSpot) {
          closePos(position, c.open < position.slSpot ? c.open : position.slSpot, c.time, `Hard SL hit (${position.slSpot})`);
          trades.push(buildTradeRecord(position)); position = null; continue;
        }
        if (position.side === "PE" && c.high >= position.slSpot) {
          closePos(position, c.open > position.slSpot ? c.open : position.slSpot, c.time, `Hard SL hit (${position.slSpot})`);
          trades.push(buildTradeRecord(position)); position = null; continue;
        }
        // ── 3–5. CANDLE CLOSE: opposite candle → breakeven → EMA trend-trail ──
        //    One call into the SHARED exit engine (src/strategies/orbExits.js), the
        //    same function paper and live run. These three rules used to be copied
        //    out by hand here, which is how this file once evaluated them in the
        //    wrong order and silently reported trades paper would never have taken.
        //
        //    The EMA window is the MULTI-DAY slice, not `dayCandles`. Paper computes
        //    its trail over state.candles — a ~7-day preload — so its EMA20 is live
        //    from the first candle of the session. This file used to pass today's
        //    bars only, so a 20-period EMA stayed null until ~11:05 IST and the
        //    trend-trail was effectively DEAD for the entire ORB entry window. Same
        //    rule, different data, different trades: a real backtest/paper mismatch.
        const _emaSeen = allCandles.slice(Math.max(0, gIdx - SIG_WINDOW), gIdx + 1);
        const _d = orbExits.evaluateCloseExits(position, c, _emaSeen);
        if (_d.exit) {
          closePos(position, c.close, c.time, _d.reason);
          trades.push(buildTradeRecord(position)); position = null; continue;
        }
      }

      // Flat → eval ORB signal
      if (!position && tradesTaken < maxTrades && istMin < ENTRY_END_MIN) {
        // Open the position at candle `oc` from signal `s`. Initial hard SL comes
        // from the STRATEGY (s.slSpot = wider of the candle extreme and
        // ORB_SL_ATR_MULT × ATR5) so the backtest matches paper/live exactly.
        // Closes over `position` / `tradesTaken` from the day loop.
        const _open = (s, oc, suffix) => {
          // Same reconciliation paper/live apply: the strategy's stop is clamped to
          // whatever ORB_MAX_TRADE_LOSS actually allows, so all three modes place
          // the stop at the same level. Without this the backtest used a 50–83pt
          // stop while paper/live were really exiting at ~38pt on the rupee cap.
          const initSl = orbStopRisk.resolveInitialStop({
            side: s.side, entrySpot: oc.close, strategyStop: s.slSpot, qty: LOT_SIZE,
            fallbackStop: s.side === "CE" ? oc.low : oc.high,
          }).slSpot;
          position = {
            date: istDateOf(oc.time),
            side: s.side,
            entryTime: oc.time,
            entrySpot: oc.close,
            optionEntryLtp: SEED_PREMIUM,
            orh: s.orh, orl: s.orl, rangePts: s.rangePts,
            slSpot: initSl, targetSpot: s.targetSpot,
            breakevenArmed: false, emaArmed: false,
            signalStrength: s.signalStrength,
            vwap: s.vwap, volRatio: s.volRatio, wickRatio: s.wickRatio,
            entryReason: s.reason + (suffix || ""),
          };
          tradesTaken++;
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
        const sig = orbStrategy.getSignal(seen, { silent: true, alreadyTraded: false });
        if ((sig.signal === "BUY_CE" || sig.signal === "BUY_PE") && _premOk) _open(sig, c);
      }
    }
    if (position) {
      const last = dayCandles[dayCandles.length - 1];
      closePos(position, last.close, last.time, "EOD (end of day candles)");
      trades.push(buildTradeRecord(position));
    }
    globalBase += _dayLen;
  }

  function closePos(pos, exitSpot, exitTime, reason) {
    const candlesHeld = ((exitTime - pos.entryTime) / 60) / 5;
    const thetaCost = (THETA_DAY * candlesHeld) / 78;
    const spotMove = pos.side === "CE" ? (exitSpot - pos.entrySpot) : (pos.entrySpot - exitSpot);
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
      ePrice: p.entrySpot, xPrice: p.exitSpot, sl: p.slSpot,
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
    notes: `Premium approximated via δ + θ from historical 5-min candles (no live option chain) — treat ₹ as directional only; slightly-ITM entry seeded at ₹${process.env.ORB_BT_SEED_PREMIUM || "240"}. Entry: 09:15–09:30 opening range, day sanity (OR ≤ ${process.env.ORB_OR_ATR_MAX || "2.5"}×ATR15, gap ≤ ${process.env.ORB_GAP_OR_MULT || "3"}×OR), first close beyond OR ± buffer, breakout body ≥ ${process.env.ORB_BODY_ATR_MULT || "0.6"}×ATR5 on the right side of VWAP, then ONE confirmation candle (or a retest/resume within ${process.env.ORB_RETEST_MAX_WAIT || "6"} candles); one trade/day, cut-off ${process.env.ORB_ENTRY_END || "11:30"} IST. Exits: initial SL = wider of the entry-candle extreme and ${process.env.ORB_SL_ATR_MULT || "1.5"}×ATR5 → breakeven at +${process.env.ORB_BREAKEVEN_PTS || "20"}pt → EMA${process.env.ORB_TRAIL_EMA || "20"} close-trail → ₹${process.env.ORB_MAX_TRADE_LOSS || "1500"} / −${process.env.ORB_PREMIUM_STOP_PCT || "35"}% caps → ${process.env.ORB_FORCED_EXIT || "15:15"} EOD. ${_paperOnlyGatesNote()}`,
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

        backtestJobs.updateProgress(id, { phase: `Running ORB backtest (${candles.length.toLocaleString()} candles)…`, pct: 5 });
        const trades = runOrbBacktest(candles, expirySet);
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

function renderIdleForm() {
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  const today = new Date().toISOString().slice(0, 10);
  const def30 = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>ORB Backtest</title>
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:'IBM Plex Mono',monospace;}
body{background:#060810;color:#a0b8d8;}
${sidebarCSS()}
.main{flex:1;margin-left:200px;padding:20px;}
@media(max-width:900px){.main{margin-left:0;padding:14px;}}
.title{font-size:1.1rem;font-weight:700;color:#e0eaf8;margin-bottom:6px;}
.sub{font-size:0.72rem;color:#4a6080;margin-bottom:18px;}
.run-form{display:flex;align-items:flex-end;gap:10px;background:#08091a;border:0.5px solid #0e1428;border-radius:10px;padding:14px 18px;flex-wrap:wrap;}
.run-form label{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.2px;color:#4a6080;display:block;margin-bottom:4px;}
.run-form input{background:#fff;border:1px solid #1e3a8a;color:#0f172a;padding:6px 10px;border-radius:5px;font-size:0.78rem;font-family:inherit;}
.run-btn{background:${ACCENT};color:#040c18;border:1px solid ${ACCENT};padding:7px 16px;border-radius:5px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;}
.run-btn:hover{filter:brightness(1.15);}
.preset-row{display:flex;gap:6px;margin-top:14px;flex-wrap:wrap;}
.preset-btn{font-size:0.65rem;padding:4px 12px;border-radius:4px;background:rgba(16,185,129,0.08);color:${ACCENT};border:0.5px solid rgba(16,185,129,0.2);cursor:pointer;font-family:inherit;}
.preset-btn:hover{background:rgba(16,185,129,0.18);}
.notes{margin-top:18px;font-size:0.72rem;color:#94a3b8;background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:14px 16px;}
</style></head><body>
<div class="app-shell">
${buildSidebar('orbBacktest', liveActive)}
<main class="main">
  <div class="title">🔍 ORB Backtest</div>
  <div class="sub">Opening Range Breakout (15-min OR, 5-min confirm) — date-range historical backtest with delta + theta option premium simulation.</div>
  <form method="get" class="run-form">
    <div><label>From</label><input type="date" name="from" value="${def30}"/></div>
    <div><label>To</label><input type="date" name="to" value="${today}"/></div>
    <button type="submit" class="run-btn">▶ Run Backtest</button>
  </form>
  <div class="preset-row">
    <button class="preset-btn" onclick="goto('thisWeek')">This week</button>
    <button class="preset-btn" onclick="goto('thisMonth')">This month</button>
    <button class="preset-btn" onclick="goto('last3')">Last 3 months</button>
    <button class="preset-btn" onclick="goto('last6')">Last 6 months</button>
    <button class="preset-btn" onclick="goto('thisYear')">This year</button>
    <button class="preset-btn" onclick="goto('lastYear')">Last year</button>
    <button class="preset-btn" onclick="goto('last2y')">Last 2 yr</button>
    <button class="preset-btn" onclick="goto('last3y')">Last 3 yr</button>
  </div>
  <div class="notes">
    <b>Backtest sim model:</b> Option premium estimated via δ (BACKTEST_DELTA, default 0.55) + θ (BACKTEST_THETA_DAY, default ₹8/day) seeded at ₹${process.env.ORB_BT_SEED_PREMIUM || "240"} per side. Qty per trade = ${instrumentConfig.getLotQty()} (= NIFTY_LOT_SIZE ${process.env.NIFTY_LOT_SIZE || "65"} × LOT_MULTIPLIER ${process.env.LOT_MULTIPLIER || "1"}). <b>Entry:</b> the 09:15–09:30 opening range is frozen; the day is skipped if OR &gt; ${process.env.ORB_OR_ATR_MAX || "2.5"}×ATR(15m) or the gap exceeds ${process.env.ORB_GAP_OR_MULT || "3"}×OR. The first 5-min <i>close</i> clearing the OR edge by max(15% of the range, 0.3×ATR5) is the one committed breakout of the day; it must be a decisive bar (body ≥ ${process.env.ORB_BODY_ATR_MULT || "0.6"}×ATR5) closing on the right side of session VWAP. That candle is never bought — the next candle must extend the move, or a retest-and-hold / trend-resume must occur within ${process.env.ORB_RETEST_MAX_WAIT || "6"} candles. Cut-off ${process.env.ORB_ENTRY_END || "11:30"} IST, one trade/day. <b>Exits mirror the paper route exactly:</b> initial hard SL = the wider of the entry candle's extreme and ${process.env.ORB_SL_ATR_MULT || "1.5"}×ATR(5m), breakeven after +${process.env.ORB_BREAKEVEN_PTS || "20"}pt, EMA${process.env.ORB_TRAIL_EMA || "20"} close-trail (exit only when a candle closes back across the EMA), a ₹${process.env.ORB_MAX_TRADE_LOSS || "1500"} per-trade loss cap, and a ${process.env.ORB_FORCED_EXIT || "15:15"} EOD square-off. ${_paperOnlyGatesNote()} Use Replay (recorded ticks) for tick-accurate backtests.
  </div>
</main>
<script>
function goto(p){
  var d=new Date(),y=d.getFullYear(),m=d.getMonth(),day=d.getDay();
  function f(dt){return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');}
  var today=f(d);
  var monday=new Date(d); monday.setDate(d.getDate()-(day===0?6:day-1));
  var presets={thisWeek:[f(monday),today],thisMonth:[f(new Date(y,m,1)),today],last3:[f(new Date(y,m-2,1)),today],last6:[f(new Date(y,m-5,1)),today],thisYear:[f(new Date(y,0,1)),today],lastYear:[f(new Date(y-1,0,1)),f(new Date(y-1,11,31))],last2y:[f(new Date(y-2,0,1)),today],last3y:[f(new Date(y-3,0,1)),today]};
  var p2=presets[p];
  window.location='/orb-backtest?from='+p2[0]+'&to='+p2[1];
}
</script>
</div></body></html>`;
}

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>ORB Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>ORB Backtest Failed</h2><p>${msg}</p><p><b>${from || ""}</b> → <b>${to || ""}</b></p><a href="/orb-backtest">← Back</a></body></html>`;
}

module.exports = router;
// Exposed for offline unit-testing of the entry/exit engine (no Fyers needed).
module.exports.runOrbBacktest = runOrbBacktest;
// Exported for the regression suite: the disclosure of paper/live-only entry gates
// must track the live env, not a sentence someone forgets to update.
module.exports._paperOnlyGates = _paperOnlyGates;

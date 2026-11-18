/**
 * TREND PULLBACK BACKTEST — /trend-pb-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest of the Trend Pullback strategy. Replays 5-min candles
 * through the SAME signal engine (src/strategies/trend_pb.js) and RE-IMPLEMENTS
 * the paper route's exit (paper is canonical): the global profit lock on the
 * simulated premium, else held to the end of the day's session. It does NOT use
 * the shared single-pass backtestEngine (whose exits are EMA_RSI_ST-flavored).
 *
 * Honesty features (agreed in design review):
 *   • Realistic costs — getCharges (brokerage + statutory) PLUS a spread/slippage
 *     haircut of BACKTEST_SLIPPAGE_PTS premium points EACH WAY. Without this a
 *     backtest of option BUYING looks great and loses money live.
 *   • Dumb baseline — the same range is run with a naive "enter in the 15m-trend
 *     direction at the window open, same exit; no pullback filter" engine. The strategy must BEAT this baseline, else its filters are
 *     curve-fit noise.
 *   • Walk-forward — trades are split into rolling out-of-sample folds (walkForward.js)
 *     with a stability verdict + thin-fold flags. Params are fixed defaults, so
 *     every fold is OOS by construction.
 *
 * Option P&L is δ+θ simulated (no historical option chain) — treat ₹ as
 * DIRECTIONAL, not exact. Endpoints mirror the ORB backtest (background job).
 *
 * MARKETS. This page is NIFTY; the unified /backtest page runs the SAME loop on
 * BANKNIFTY, SENSEX and NIFTY futures through `backtestPage` (exported below):
 * the market's spot candles, lot, exchange charges (BSE for SENSEX) and — for
 * NIFTY_FUT — futures pricing (index points 1:1, the common futures stop in
 * place of the premium lock) come from services/backtestMarket.js, and the
 * market's pair settings are mapped onto the TREND_PB_* keys for that run only
 * (services/backtestPage.js). With market NIFTY nothing changes. MCX and stock
 * markets are not backtestable yet (no index candles / rule expiry there).
 */

const express = require("express");
const router  = express.Router();
const trendPbStrategy = require("../strategies/trend_pb");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const vixFilter = require("../services/vixFilter");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");
const sharedSocketState = require("../utils/sharedSocketState");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { walkForward } = require("../utils/walkForward");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");
const tradeGuards = require("../utils/tradeGuards");
const backtestMarket = require("../services/backtestMarket");

// Futures stop on the long-equivalent futures "premium" (entry, price and peak
// all in index points): tradeGuards.futuresStopLevel with best move = peak − entry.
// `g` = the run's guards (default: the common set).
function _futStopLvl(entry, peak, g = tradeGuards) { return g.futuresStopLevel("CE", entry, peak - entry); }
function _futStopMsg(entry, px, peak, g = tradeGuards) {
  const lvl = _futStopLvl(entry, peak, g);
  if (lvl == null || px > lvl) return null;
  return g.premiumStopSpotReason(Math.round((lvl - entry) * 100) / 100, peak - entry);
}
const backtestCosts = require("../config/backtestCosts");

const ACCENT = "#ec4899";
const ENDPOINT = "/trend-pb-backtest";
const RESULT_KEY = "TREND_PB_BACKTEST";

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

/**
 * Run the backtest. `baseline=true` swaps the entry rule for the naive
 * bias-at-window-open engine but keeps the identical exit machinery + costs.
 * `market` is a backtestMarket.context() — the market's lot, exchange and
 * futures flag. Omitted = NIFTY options, exactly as before markets existed.
 */
async function runTrendPbBacktest(allCandles, { baseline = false, vixCandles = [], market = null } = {}) {
  if (!allCandles || !allCandles.length) return [];
  allCandles = allCandles.slice().sort((a, b) => a.time - b.time);

  // Daily VIX series → same gate paper runs before every entry (no-op unless
  // TREND_PB_VIX_ENABLED=true, which checkBacktestVix decides for itself).
  const lookupVix = vixFilter.buildVixLookup(vixCandles || []);

  const M = market || backtestMarket.context("NIFTY");
  // FUTURES MODE (the NIFTY_FUT market only) — index points are rupees 1:1: no
  // delta, no theta, and the "premium" the sim carries IS the spot level.
  const IS_FUT       = M.isFutures === true;
  const DELTA        = IS_FUT ? 1.0 : parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = IS_FUT ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  // Own Common Rules (utils/commonRules.js): TREND_PB's own values on a NIFTY run, else common.
  const tradeGuards  = require("../utils/tradeGuards").forStrategy(M.key === "NIFTY" ? "TREND_PB" : null);
  const LOT_SIZE     = M.key === "NIFTY" ? require("../config/instrument").getLotQty(undefined, undefined, "TREND_PB") : M.lotQty;
  const EXCHANGE     = M.exchange;
  const SEED_PREMIUM = backtestCosts.seedPremium();
  // In futures the entry "premium" is the entry SPOT — seeded per trade below.     // slightly-ITM ≈ ATM + one strike intrinsic
  const SLIPPAGE_PTS = backtestCosts.slippagePts();     // spread+slippage haircut EACH way (premium pts)
  const SIG_WINDOW   = parseInt(process.env.TREND_PB_SIG_WINDOW || "300", 10);        // trailing bars to seed EMA50(15m)

  const ENTRY_START_MIN = _parseMin("TREND_PB_ENTRY_START", "09:45");
  const ENTRY_END_MIN   = _parseMin("TREND_PB_ENTRY_END",   "14:30");
  // Paper's session auto-stop (TRADE_STOP_TIME, NSE / BSE for every market here):
  // it squares off an open trade and ends the day, so no bar closing after it is walked.
  const STOP_MIN = _parseMin("TRADE_STOP_TIME", "15:30");
  // Paper's premium band (simulateBuy), same keys + defaults; the backtest's entry
  // premium is the seed. Futures trade at the index — paper skips the band there.
  const PREM_MIN     = parseFloat(process.env.TREND_PB_PREMIUM_MIN || "120");
  const PREM_MAX     = parseFloat(process.env.TREND_PB_PREMIUM_MAX || "400");
  const PREM_GATE_ON = !IS_FUT && (process.env.TREND_PB_PREMIUM_GATE_ENABLED || "true").toLowerCase() === "true";
  // Another market's <PAIR>_EXPIRY_DAY_ONLY (paper: rt.expiryDayOnly() at /start,
  // checked against THAT market's expiry calendar). NIFTY has no expiry-day rule.
  const _pairRt = M.key === "NIFTY" ? null : require("../utils/pairRuntime").forStrategy("trendPb", M.key);
  const EXPIRY_ONLY = !!(_pairRt && _pairRt.expiryDayOnly());

  // Group candles by IST date; keep a global index so getSignal gets a multi-day window.
  const byDate = new Map();
  for (const c of allCandles) {
    const d = new Date((c.time + 19800) * 1000);
    const dt = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    if (!byDate.has(dt)) byDate.set(dt, []);
    byDate.get(dt).push(c);
  }

  const trades = [];
  let globalBase = 0;
  // Global wait-after-any-exit cooldown (EXIT_REENTRY_COOLDOWN_CANDLES), unix secs.
  // Paper measures it from the exit's clock time — every exit is a tick INSIDE
  // bar k, even one given back near its close — and tests it at the entry fill
  // (a bar's CLOSE). Here both ends sit one bar earlier: from the exit bar's OPEN,
  // tested against the signal bar's OPEN, so N=2 refuses the k+1 close and allows
  // the k+2 close, exactly as paper.
  const _REENTRY_COOLDOWN_SECS = tradeGuards.reentryCooldownMs(5) / 1000;
  let _reentryBlockUntilTs = 0;
  // MAX_TRADES_PER_DAY — trades closed this IST day (reset with the block each day).
  let _closedToday = 0;

  // Simulated MARKET premium (δ+θ, no slippage) at a raw spot and time — the
  // price the profit lock reads, exactly as paper reads the live option LTP.
  function _thetaPerUnit(pos, t) { return ((THETA_DAY * (((t - pos.entryTime) / 60) / 5)) / 78) / LOT_SIZE; }
  function premAt(pos, spot, t) {
    const spotMove = pos.side === "CE" ? (spot - pos.entrySpot) : (pos.entrySpot - spot);
    return Math.max(0.05, parseFloat((pos.optionEntryLtp + spotMove * DELTA - _thetaPerUnit(pos, t)).toFixed(2)));
  }
  /** Inverse of premAt: the raw spot at which the premium equals `prem`. */
  function spotForPrem(pos, prem, t) {
    const dir = pos.side === "CE" ? 1 : -1;
    return pos.entrySpot + dir * (prem - pos.optionEntryLtp + _thetaPerUnit(pos, t)) / DELTA;
  }

  // δ+θ premium sim + spread/slippage haircut both ways. Returns pnl (₹) + exit premium.
  function priceExit(pos, exitSpot, exitTime) {
    const candlesHeld = ((exitTime - pos.entryTime) / 60) / 5;
    const thetaCost = (THETA_DAY * candlesHeld) / 78;
    const spotMove = pos.side === "CE" ? (exitSpot - pos.entrySpot) : (pos.entrySpot - exitSpot);
    const exitPremRaw = Math.max(0.05, pos.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE);
    const exitPrem = Math.max(0.05, exitPremRaw - 2 * SLIPPAGE_PTS);   // buy high + sell low
    const charges = getCharges({ broker: "fyers", isFutures: IS_FUT, exchange: EXCHANGE, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
    const pnl = parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2));
    return { pnl, exitPrem: parseFloat(exitPrem.toFixed(2)), heldCandles: Math.round(candlesHeld) };
  }

  function closeAndPush(pos, exitSpot, exitTime, reason) {
    const p = priceExit(pos, exitSpot, exitTime);
    // Wait-after-any-exit cooldown — every exit reason, both sides. `exitTime` is
    // the exit bar's open on every call.
    if (_REENTRY_COOLDOWN_SECS > 0) _reentryBlockUntilTs = exitTime + _REENTRY_COOLDOWN_SECS;
    // MAX_TRADES_PER_DAY — paper (reentryCooldownUntil(…, MODE)) blocks every new
    // entry for the rest of the IST day once N trades have closed. The day reset clears it.
    _closedToday++;
    if (tradeGuards.dayCapReached(_closedToday)) _reentryBlockUntilTs = Infinity;
    trades.push({
      side: pos.side,
      entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitTime),
      entryTs: pos.entryTime, exitTs: exitTime,
      ePrice: pos.entrySpot, xPrice: parseFloat(exitSpot.toFixed(2)), sl: null,
      pnl: p.pnl, reason, entryReason: pos.entryReason,
      trendBias: pos.trendBias, strength: pos.signalStrength, peakPremium: pos.peak,
      eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.heldCandles,
    });
  }

  for (const [dayKey, dayCandles] of byDate) {
    // Yield once per session so live ticks/orders sharing this process are not
    // starved while a long backtest runs.
    await new Promise(resolve => setImmediate(resolve));
    const _dayLen = dayCandles.length;
    if (dayCandles.length < 5) { globalBase += _dayLen; continue; }
    if (EXPIRY_ONLY && !_pairRt.isExpiryDay(Date.parse(`${dayKey}T09:15:00+05:30`))) { globalBase += _dayLen; continue; }
    let position = null;
    let lastBar = null;   // the last bar walked before paper's auto-stop
    let baselineDone = false;
    _reentryBlockUntilTs = 0;
    _closedToday = 0;

    for (let i = 0; i < dayCandles.length; i++) {
      const c = dayCandles[i];
      const istMin = _utcSecToIstMins(c.time);
      const gIdx = globalBase + i;
      if (istMin + 5 > STOP_MIN) break;   // paper has auto-stopped
      lastBar = c;

      // ── In-position management (mirrors paper _checkExits): the global profit
      //    lock on the simulated premium is the only automatic exit. Intra-bar
      //    path, NO look-ahead: open → adverse extreme → favourable extreme →
      //    close. Futures: paper skips the lock, runs the index-point stop. ──
      if (position) {
        const pos = position;
        // Futures: paper skips the lock but runs the common stop in index points.
        // The "premium" here IS the futures price (DELTA 1, no theta), same walk.
        const lockAt  = IS_FUT ? (e, px, pk) => _futStopMsg(e, px, pk, tradeGuards) : tradeGuards.checkProfitLock;
        const levelAt = IS_FUT ? (e, pk) => _futStopLvl(e, pk, tradeGuards) : tradeGuards.exitLevelLtp;
        walk: {
          const isCE = pos.side === "CE";
          const barEnd = c.time + 5 * 60;
          // a) the open
          const pOpen = premAt(pos, c.open, c.time);
          if (pOpen > pos.peak) pos.peak = pOpen;
          let lock = lockAt(pos.optionEntryLtp, pOpen, pos.peak);
          if (lock) { closeAndPush(pos, c.open, c.time, `${lock} (bar opened through it — filled at the open)`); position = null; break walk; }
          // b) open → adverse extreme: the floor is crossed on the way down.
          const pAdv = premAt(pos, isCE ? c.low : c.high, barEnd);
          lock = lockAt(pos.optionEntryLtp, pAdv, pos.peak);
          if (lock) {
            const lvl = levelAt(pos.optionEntryLtp, pos.peak);
            const raw = spotForPrem(pos, lvl, barEnd);
            // Never better than the open (the open did not trigger, so the level lies past it).
            const fill = isCE ? Math.min(c.open, raw) : Math.max(c.open, raw);
            closeAndPush(pos, fill, c.time, lock); position = null; break walk;
          }
          // c) adverse → favourable extreme: the peak rises, nothing exits.
          const pFav = premAt(pos, isCE ? c.high : c.low, c.time);
          if (pFav > pos.peak) pos.peak = pFav;
          // d) favourable → close: a lock armed by THIS peak and given back.
          const pClose = premAt(pos, c.close, barEnd);
          lock = lockAt(pos.optionEntryLtp, pClose, pos.peak);
          if (lock) { closeAndPush(pos, c.close, c.time, `${lock} (armed and given back inside the bar — filled at the close)`); position = null; break walk; }
        }
        // Still open → this candle is handled. Closed by a tick exit → fall through
        // to the entry question on this bar's close, as paper's onCandleClose does
        // once the position is gone (the wait-after-exit / day cap still apply).
        if (position) continue;
      }

      // ── Flat → look for an entry ──
      // Paper's portfolio-wide cap is cross-strategy live state and has no meaning
      // in a single-strategy backtest, so it is not mirrored.
      if (istMin < ENTRY_START_MIN || istMin >= ENTRY_END_MIN) continue;
      const seen = allCandles.slice(Math.max(0, gIdx - SIG_WINDOW), gIdx + 1);
      const sig = trendPbStrategy.getSignal(seen, { silent: true });

      // VIX gate — paper runs it only once a signal exists, so the block count means
      // the same thing on both sides. No-op unless TREND_PB_VIX_ENABLED=true.
      // Runs BEFORE the side-selection block below: that block latches `baselineDone`
      // on the baseline's one and only entry of the day, so blocking after it would
      // burn the latch and leave the baseline flat for the whole session while the
      // real strategy simply retried on the next bar — an asymmetry that would make
      // the "bar to beat" artificially easy.
      // The `|| "STRONG"` only ever applies to the BASELINE: the engine sets
      // signalStrength="STRONG" on its single BUY return, so the real path always
      // has it, while the baseline fires off trendBias alone and leaves it null.
      // Passing null there would let `checkBacktestVix`'s STRONG_ONLY tier block the
      // baseline in regimes the real strategy trades — the same asymmetry again.
      const _hasSignal = baseline
        ? (sig.trendBias === "UP" || sig.trendBias === "DOWN")
        : (sig.signal === "BUY_CE" || sig.signal === "BUY_PE");
      if (_hasSignal
          && !vixFilter.checkBacktestVix(lookupVix(c.time), sig.signalStrength || "STRONG", { mode: "trend_pb" }).allowed) {
        continue;
      }

      let side = null, entryReason = null, bias = sig.trendBias;
      if (!baseline) {
        if (sig.signal === "BUY_CE" || sig.signal === "BUY_PE") { side = sig.side; entryReason = sig.reason; }
      } else if (!baselineDone && (sig.trendBias === "UP" || sig.trendBias === "DOWN")) {
        // Naive baseline: first window candle with a 15m bias → enter that side.
        side = sig.trendBias === "UP" ? "CE" : "PE";
        entryReason = `BASELINE: 15m ${sig.trendBias} bias at window open (no pullback filter)`;
        baselineDone = true;
      }
      if (!side) continue;
      // Wait-after-any-exit cooldown: blocks both sides (paper: simulateBuy).
      if (c.time < _reentryBlockUntilTs) continue;

      const _entryPrem = IS_FUT ? c.close : SEED_PREMIUM;
      // Premium gate (paper: simulateBuy) — entry skipped outside [MIN, MAX].
      if (PREM_GATE_ON && (_entryPrem < PREM_MIN || _entryPrem > PREM_MAX)) continue;
      position = {
        side, entryTime: c.time, entrySpot: c.close,
        optionEntryLtp: _entryPrem, peak: _entryPrem,
        trendBias: bias, signalStrength: baseline ? "BASELINE" : (sig.signalStrength || "STRONG"),
        entryReason,
      };
    }

    // Session teardown: paper's TRADE_STOP_TIME auto-stop squares off any open
    // position — at the close of the last bar walked before it.
    if (position) {
      const last = lastBar;
      closeAndPush(position, last.close, last.time, "Session end — squared off at TRADE_STOP_TIME (last bar before paper's auto-stop)");
      position = null;
    }
    globalBase += _dayLen;
  }

  return trades;
}

// ── Routes ──────────────────────────────────────────────────────────────────
router.get("/status", (req, res) => {
  const job = backtestJobs.getJob(req.query.jobId);
  if (!job) return res.json({ status: "not_found" });
  res.json({ status: job.status, progress: job.progress, elapsed: Date.now() - job.startedAt, error: job.error });
});

router.get("/idle", (req, res) => {
  if (req.accepts(["json", "html"]) === "json" || req.query.json === "1") return res.json({ idle: backtestJobs.isIdle() });
  return res.redirect(ENDPOINT);
});

/** `market` is the run's market key (absent / "NIFTY" on a NIFTY run). */
function _resultsView(from, to, trades, stats, baselineStats, wf, market) {
  const inf = (x) => x === Infinity ? "∞" : x;
  const M = backtestMarket.context(market || "NIFTY");
  const futMode = M.isFutures === true;
  const beatsBaseline = (stats.totalPnl || 0) - (baselineStats.totalPnl || 0);
  const wfLine = wf.foldCount
    ? `Walk-forward (${wf.foldCount} × ${wf.testDays}-day OOS folds): net ₹${wf.oosNetPnl}, PF ${inf(wf.oosProfitFactor)}, ${wf.positiveFolds}/${wf.foldCount} folds positive${wf.thinFolds ? `, ${wf.thinFolds} thin (<${wf.minTrades} trades)` : ""} — ${wf.verdict}.`
    : "Walk-forward: no trades to fold.";
  return {
    mode: "TREND_PB",
    accent: ACCENT,
    strategyName: trendPbStrategy.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "trendPbBacktest",
    strategyId: "trendPb",
    extraTradeColumns: [
      { key: "trendBias", label: "Bias" },
      { key: "peakPremium", label: "Peak Prem" },
      { key: "held", label: "Held" },
    ],
    extraStats: [
      { label: "Profit Factor", value: inf(stats.profitFactor) },
      { label: "Expectancy /trade", value: `₹${stats.expectancy}` },
      { label: "Sharpe (daily, ann.)", value: stats.sharpeRatio },
      { label: "Max Drawdown", value: `₹${stats.maxDrawdown}` },
      { label: "vs Dumb Baseline", value: `${beatsBaseline >= 0 ? "+" : ""}₹${beatsBaseline.toFixed(0)} (base ₹${baselineStats.totalPnl}, ${baselineStats.totalTrades}t/${baselineStats.winRate}%)` },
      { label: "WF verdict", value: wf.foldCount ? `${wf.positiveFolds}/${wf.foldCount} folds +ve` : "—" },
    ],
    notes: `${M.key !== "NIFTY" ? `<b>MARKET: ${M.label}</b> — ${M.spotSymbol} candles, lot ${M.lotQty}, ${M.exchange} charges. ` : ""}${futMode ? "FUTURES MODE — P&L is index points × lot with futures charges, no δ/θ and no profit lock (it is defined on option premium); a PE is a SHORT. " : ""}Option premium δ+θ simulated (BACKTEST_DELTA ${process.env.BACKTEST_DELTA || "0.55"}, θ ₹${process.env.BACKTEST_THETA_DAY || "8"}/day) seeded slightly-ITM at ₹${backtestCosts.seedPremium()}, PLUS a spread/slippage haircut of ${backtestCosts.slippagePts()}pt EACH way — treat ₹ as directional, not exact. Entry: 15m bias (HH/HL + EMA20>EMA50 + slope + VWAP) → healthy 5m pullback to EMA20 → resumption body ≥ ${process.env.TREND_PB_BODY_ATR_MULT || "0.5"}×ATR5. Exit: the global profit lock on the simulated premium is the only automatic exit; otherwise the trade is held to the day's last candle (session end). <b>${wfLine}</b> The DUMB BASELINE (enter in the 15m-trend direction at the window open, same exit, NO pullback filter) is the bar to beat: if the strategy doesn't clear it out-of-sample, the pullback filter is noise. Use Replay (recorded ticks) for tick-accurate fills.`,
  };
}

function _renderResults(res, from, to, trades, stats, baselineStats, wf) {
  const html = renderBacktestResults(_resultsView(from, to, trades, stats, baselineStats, wf));
  res.send(html);
}

/**
 * One run, start to finish, on job `id` — fetch, simulate, save, then
 * completeJob / failJob. This page and the unified /backtest page both call it.
 *   p = { from, to, market? }   market: a markets.js key, default NIFTY
 */
async function _runJob(id, p) {
  const { from, to } = p;
  const M = backtestMarket.context(p.market || "NIFTY");
  const home = M.key === "NIFTY";
  try {
    console.log(`🔍 Trend Pullback Backtest job ${id}: ${from} → ${to}${home ? "" : ` on ${M.key}`}`);
    backtestJobs.updateProgress(id, { phase: "Fetching candle data…", pct: 0 });
    const candles = await fetchCandlesCachedBT(M.spotSymbol, "5", from, to, false, (p) => backtestJobs.updateProgress(id, p));
    if (!Array.isArray(candles) || candles.length < 5) {
      const n = Array.isArray(candles) ? candles.length : 0;
      const msg = n === 0
        ? `Fyers returned no historical candles for ${from} → ${to}. Most often the Fyers session needs re-login — an expired token returns no data (not an auth error). Log in to Fyers again, then retry. Otherwise the range may be in the future / beyond available history.`
        : `Only ${n} candle(s) for ${from} → ${to} — widen the range to at least a week of trading days.`;
      backtestJobs.failJob(id, msg);
      return;
    }
    // Daily VIX for the entry gate. Only fetched when the gate is on; a failed
    // fetch leaves it empty and checkBacktestVix applies VIX_FAIL_MODE, exactly
    // as paper does when the live VIX read fails.
    const vixCandles = vixFilter.getVixEnabled("trend_pb")
      ? await fetchCandlesCachedBT(vixFilter.VIX_SYMBOL, "D", from, to, false).catch((e) => {
          console.warn(`[trend-pb-backtest] VIX candle fetch failed: ${e.message}`);
          return [];
        })
      : [];

    backtestJobs.updateProgress(id, { phase: `Running Trend Pullback backtest (${candles.length.toLocaleString()} candles)…`, pct: 5 });
    const trades = await runTrendPbBacktest(candles, { baseline: false, vixCandles, market: M });
    const stats = computeBacktestStats(trades);
    stats.optionSim = !M.isFutures;
    stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
    stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
    if (M.isFutures) stats.isFutures = true;   // ₹ (index pts × lot − charges), not raw pts

    backtestJobs.updateProgress(id, { phase: "Running dumb baseline + walk-forward…", pct: 90 });
    const baselineTrades = await runTrendPbBacktest(candles, { baseline: true, vixCandles, market: M });
    const baselineStats = computeBacktestStats(baselineTrades);
    const wf = walkForward(trades, {});

    // The legacy last-run slot (/all-backtest) is NIFTY's; other markets are
    // kept by the /backtest page's own saved runs.
    if (home) {
      try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: "5" } }); }
      catch (e) { console.warn("[trend-pb-backtest] saveResult failed:", e.message); }
    }

    const result = { trades, stats, baselineStats, wf, from, to };
    if (!home) result.market = M.key;
    backtestJobs.completeJob(id, result);
    console.log(`✅ Trend Pullback Backtest job ${id} complete — ${trades.length} trades (baseline ${baselineTrades.length}); WF: ${wf.verdict}`);
  } catch (err) {
    console.error("[trend-pb-backtest] job error:", err);
    backtestJobs.failJob(id, err.message);
  }
}

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  if (!from || !to) {
    const today = new Date();
    const def30 = new Date(); def30.setDate(today.getDate() - 30);
    const fmt = d => d.toISOString().slice(0, 10);
    return res.redirect(`${ENDPOINT}?from=${fmt(def30)}&to=${fmt(today)}`);
  }

  const jobId = req.query.jobId;
  if (!jobId) {
    const activeJob = backtestJobs.getActiveJob();
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "Trend Pullback Backtest"));
    const { id } = backtestJobs.createJob("trend_pb");
    _runJob(id, { from, to });
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "Trend Pullback Backtest"));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "Trend Pullback Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));
  const { trades, stats, baselineStats, wf } = job.result;
  return _renderResults(res, from, to, trades, stats, baselineStats, wf);
});

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>Trend Pullback Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>Trend Pullback Backtest Failed</h2><p>${msg}</p><p><b>${from || ""}</b> → <b>${to || ""}</b></p><a href="${ENDPOINT}">← Back</a></body></html>`;
}

module.exports = router;
// The unified /backtest page's hook (see services/backtestPage.js).
module.exports.backtestPage = {
  markets: ["NIFTY", "BANKNIFTY", "SENSEX", "NIFTY_FUT"],
  resolution: null,
  run: (id, p) => _runJob(id, { from: p.from, to: p.to, market: p.market }),
  view: (r, p) => _resultsView(r.from || p.from, r.to || p.to, r.trades, r.stats, r.baselineStats, r.wf, r.market || p.market),
};
// Exposed for offline unit-testing of the entry/exit engine (no Fyers needed).
module.exports.runTrendPbBacktest = runTrendPbBacktest;

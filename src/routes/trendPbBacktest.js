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
 *     haircut of TREND_PB_BT_SLIPPAGE_PTS premium points EACH WAY. Without this a
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
const instrumentConfig = require("../config/instrument");
const tradeGuards = require("../utils/tradeGuards");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
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
 */
async function runTrendPbBacktest(allCandles, { baseline = false, vixCandles = [] } = {}) {
  if (!allCandles || !allCandles.length) return [];
  allCandles = allCandles.slice().sort((a, b) => a.time - b.time);

  // Daily VIX series → same gate paper runs before every entry (no-op unless
  // TREND_PB_VIX_ENABLED=true, which checkBacktestVix decides for itself).
  const lookupVix = vixFilter.buildVixLookup(vixCandles || []);

  // FUTURES MODE — index points are rupees 1:1: no delta, no theta, and the
  // "premium" the sim carries IS the spot level (see instrumentMode.js).
  const IS_FUT       = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const DELTA        = IS_FUT ? 1.0 : parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = IS_FUT ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE     = instrumentConfig.getLotQty();
  const SEED_PREMIUM = parseFloat(process.env.TREND_PB_BT_SEED_PREMIUM || "240");
  // In futures the entry "premium" is the entry SPOT — seeded per trade below.     // slightly-ITM ≈ ATM + one strike intrinsic
  const SLIPPAGE_PTS = parseFloat(process.env.TREND_PB_BT_SLIPPAGE_PTS || "1.5");     // spread+slippage haircut EACH way (premium pts)
  const SIG_WINDOW   = parseInt(process.env.TREND_PB_SIG_WINDOW || "300", 10);        // trailing bars to seed EMA50(15m)

  const ENTRY_START_MIN = _parseMin("TREND_PB_ENTRY_START", "09:45");
  const ENTRY_END_MIN   = _parseMin("TREND_PB_ENTRY_END",   "14:30");

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
  // Paper measures it from the exit's clock time: a tick stop exits INSIDE the
  // bar (≈ bar open here), a candle-close rule exits at the bar's CLOSE.
  const _REENTRY_COOLDOWN_SECS = tradeGuards.reentryCooldownMs(5) / 1000;
  let _reentryBlockUntilTs = 0;

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
    const charges = getCharges({ broker: "fyers", isFutures: IS_FUT, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
    const pnl = parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2));
    return { pnl, exitPrem: parseFloat(exitPrem.toFixed(2)), heldCandles: Math.round(candlesHeld) };
  }

  function closeAndPush(pos, exitSpot, exitTime, reason, atClose = false) {
    const p = priceExit(pos, exitSpot, exitTime);
    // Wait-after-any-exit cooldown — every exit reason, both sides.
    if (_REENTRY_COOLDOWN_SECS > 0) _reentryBlockUntilTs = exitTime + (atClose ? 5 * 60 : 0) + _REENTRY_COOLDOWN_SECS;
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

  for (const [, dayCandles] of byDate) {
    // Yield once per session so live ticks/orders sharing this process are not
    // starved while a long backtest runs.
    await new Promise(resolve => setImmediate(resolve));
    const _dayLen = dayCandles.length;
    if (dayCandles.length < 5) { globalBase += _dayLen; continue; }
    let position = null;
    let baselineDone = false;
    _reentryBlockUntilTs = 0;

    for (let i = 0; i < dayCandles.length; i++) {
      const c = dayCandles[i];
      const istMin = _utcSecToIstMins(c.time);
      const gIdx = globalBase + i;

      // ── In-position management (mirrors paper _checkExits): the global profit
      //    lock on the simulated premium is the only automatic exit. Intra-bar
      //    path, NO look-ahead: open → adverse extreme → favourable extreme →
      //    close. Futures have no premium, so paper skips the lock — so do we. ──
      if (position) {
        const pos = position;
        if (!IS_FUT) {
          const isCE = pos.side === "CE";
          const barEnd = c.time + 5 * 60;
          // a) the open
          const pOpen = premAt(pos, c.open, c.time);
          if (pOpen > pos.peak) pos.peak = pOpen;
          let lock = tradeGuards.checkProfitLock(pos.optionEntryLtp, pOpen, pos.peak);
          if (lock) { closeAndPush(pos, c.open, c.time, `${lock} (bar opened through it — filled at the open)`); position = null; continue; }
          // b) open → adverse extreme: the floor is crossed on the way down.
          const pAdv = premAt(pos, isCE ? c.low : c.high, barEnd);
          lock = tradeGuards.checkProfitLock(pos.optionEntryLtp, pAdv, pos.peak);
          if (lock) {
            const lvl = tradeGuards.profitLockFloorLtp(pos.optionEntryLtp, pos.peak, tradeGuards.PROFIT_LOCK_FLOOR_PCT, tradeGuards.PROFIT_LOCK_TRAIL_PCT, tradeGuards.PROFIT_LOCK_TRAIL_TIERS);
            const raw = spotForPrem(pos, lvl, barEnd);
            // Never better than the open (the open did not trigger, so the level lies past it).
            const fill = isCE ? Math.min(c.open, raw) : Math.max(c.open, raw);
            closeAndPush(pos, fill, c.time, lock); position = null; continue;
          }
          // c) adverse → favourable extreme: the peak rises, nothing exits.
          const pFav = premAt(pos, isCE ? c.high : c.low, c.time);
          if (pFav > pos.peak) pos.peak = pFav;
          // d) favourable → close: a lock armed by THIS peak and given back.
          const pClose = premAt(pos, c.close, barEnd);
          lock = tradeGuards.checkProfitLock(pos.optionEntryLtp, pClose, pos.peak);
          if (lock) { closeAndPush(pos, c.close, c.time, `${lock} (armed and given back inside the bar — filled at the close)`, true); position = null; continue; }
        }
        continue;   // in-position candle handled
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
      position = {
        side, entryTime: c.time, entrySpot: c.close,
        optionEntryLtp: _entryPrem, peak: _entryPrem,
        trendBias: bias, signalStrength: baseline ? "BASELINE" : (sig.signalStrength || "STRONG"),
        entryReason,
      };
    }

    // Session teardown: close any open position at the last candle of the day
    // (mirrors paper's TRADE_STOP_TIME auto-stop) so every trade's P&L is defined.
    if (position) {
      const last = dayCandles[dayCandles.length - 1];
      closeAndPush(position, last.close, last.time, "Session end (last candle of the day)");
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

function _renderResults(res, from, to, trades, stats, baselineStats, wf) {
  const inf = (x) => x === Infinity ? "∞" : x;
  const beatsBaseline = (stats.totalPnl || 0) - (baselineStats.totalPnl || 0);
  const wfLine = wf.foldCount
    ? `Walk-forward (${wf.foldCount} × ${wf.testDays}-day OOS folds): net ₹${wf.oosNetPnl}, PF ${inf(wf.oosProfitFactor)}, ${wf.positiveFolds}/${wf.foldCount} folds positive${wf.thinFolds ? `, ${wf.thinFolds} thin (<${wf.minTrades} trades)` : ""} — ${wf.verdict}.`
    : "Walk-forward: no trades to fold.";
  const html = renderBacktestResults({
    mode: "TREND_PB",
    accent: ACCENT,
    strategyName: trendPbStrategy.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "trendPbBacktest",
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
    notes: `${instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" ? "FUTURES MODE — P&L is index points × lot with futures charges, no δ/θ and no profit lock (it is defined on option premium); a PE is a SHORT. " : ""}Option premium δ+θ simulated (BACKTEST_DELTA ${process.env.BACKTEST_DELTA || "0.55"}, θ ₹${process.env.BACKTEST_THETA_DAY || "8"}/day) seeded slightly-ITM at ₹${process.env.TREND_PB_BT_SEED_PREMIUM || "240"}, PLUS a spread/slippage haircut of ${process.env.TREND_PB_BT_SLIPPAGE_PTS || "1.5"}pt EACH way — treat ₹ as directional, not exact. Entry: 15m bias (HH/HL + EMA20>EMA50 + slope + VWAP) → healthy 5m pullback to EMA20 → resumption body ≥ ${process.env.TREND_PB_BODY_ATR_MULT || "0.5"}×ATR5. Exit: the global profit lock on the simulated premium is the only automatic exit; otherwise the trade is held to the day's last candle (session end). <b>${wfLine}</b> The DUMB BASELINE (enter in the 15m-trend direction at the window open, same exit, NO pullback filter) is the bar to beat: if the strategy doesn't clear it out-of-sample, the pullback filter is noise. Use Replay (recorded ticks) for tick-accurate fills.`,
  });
  res.send(html);
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
    (async () => {
      try {
        console.log(`🔍 Trend Pullback Backtest job ${id}: ${from} → ${to}`);
        backtestJobs.updateProgress(id, { phase: "Fetching candle data…", pct: 0 });
        const candles = await fetchCandlesCachedBT(NIFTY_INDEX_SYMBOL, "5", from, to, false, (p) => backtestJobs.updateProgress(id, p));
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
        const trades = await runTrendPbBacktest(candles, { baseline: false, vixCandles });
        const stats = computeBacktestStats(trades);
        stats.optionSim = true;
        stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
        stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");

        backtestJobs.updateProgress(id, { phase: "Running dumb baseline + walk-forward…", pct: 90 });
        const baselineTrades = await runTrendPbBacktest(candles, { baseline: true, vixCandles });
        const baselineStats = computeBacktestStats(baselineTrades);
        const wf = walkForward(trades, {});

        try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: "5" } }); }
        catch (e) { console.warn("[trend-pb-backtest] saveResult failed:", e.message); }

        backtestJobs.completeJob(id, { trades, stats, baselineStats, wf, from, to });
        console.log(`✅ Trend Pullback Backtest job ${id} complete — ${trades.length} trades (baseline ${baselineTrades.length}); WF: ${wf.verdict}`);
      } catch (err) {
        console.error("[trend-pb-backtest] job error:", err);
        backtestJobs.failJob(id, err.message);
      }
    })();
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
// Exposed for offline unit-testing of the entry/exit engine (no Fyers needed).
module.exports.runTrendPbBacktest = runTrendPbBacktest;

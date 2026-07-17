/**
 * TREND PULLBACK BACKTEST — /trend-pb-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest of the Trend Pullback strategy. Replays 5-min candles
 * through the SAME signal engine (src/strategies/trend_pb.js) and RE-IMPLEMENTS
 * the paper route's SPOT-based exits (paper is canonical) — it does NOT use the
 * shared single-pass backtestEngine (whose exits are EMA_RSI_ST-flavored).
 *
 * Honesty features (agreed in design review):
 *   • Realistic costs — getCharges (brokerage + statutory) PLUS a spread/slippage
 *     haircut of TREND_PB_BT_SLIPPAGE_PTS premium points EACH WAY. Without this a
 *     backtest of option BUYING looks great and loses money live.
 *   • Dumb baseline — the same range is run with a naive "enter in the 15m-trend
 *     direction at the window open, ATR-trail on spot, EOD exit; no pullback
 *     filter" engine. The strategy must BEAT this baseline, else its filters are
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
const { EMA, ATR } = require("technicalindicators");
const trendPbStrategy = require("../strategies/trend_pb");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");
const sharedSocketState = require("../utils/sharedSocketState");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { walkForward } = require("../utils/walkForward");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");

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

function _emaAtLast(closes, period) {
  if (!closes || closes.length < period) return null;
  const arr = EMA.calculate({ period, values: closes });
  return arr && arr.length ? arr[arr.length - 1] : null;
}
function _atrAtLast(window, period) {
  if (!window || window.length < period + 1) return null;
  const arr = ATR.calculate({ period, high: window.map(c => c.high), low: window.map(c => c.low), close: window.map(c => c.close) });
  return arr && arr.length ? arr[arr.length - 1] : null;
}

/**
 * Run the backtest. `baseline=true` swaps the entry rule for the naive
 * bias-at-window-open engine but keeps the identical exit machinery + costs.
 */
function runTrendPbBacktest(allCandles, { baseline = false } = {}) {
  if (!allCandles || !allCandles.length) return [];
  allCandles = allCandles.slice().sort((a, b) => a.time - b.time);

  const DELTA        = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE     = instrumentConfig.getLotQty();
  const SEED_PREMIUM = parseFloat(process.env.TREND_PB_BT_SEED_PREMIUM || "240");     // slightly-ITM ≈ ATM + one strike intrinsic
  const SLIPPAGE_PTS = parseFloat(process.env.TREND_PB_BT_SLIPPAGE_PTS || "1.5");     // spread+slippage haircut EACH way (premium pts)
  const SIG_WINDOW   = parseInt(process.env.TREND_PB_SIG_WINDOW || "300", 10);        // trailing bars to seed EMA50(15m)

  // Exit params — mirror trendPbPaper.js exactly.
  const CLAMP_MIN    = parseFloat(process.env.TREND_PB_STOP_CLAMP_MIN || "8");
  const CLAMP_MAX    = parseFloat(process.env.TREND_PB_STOP_CLAMP_MAX || "30");
  const BE_R         = parseFloat(process.env.TREND_PB_BREAKEVEN_R || "1.0");
  const TRAIL_MULT   = parseFloat(process.env.TREND_PB_TRAIL_ATR_MULT || "2.5");
  const ATR_PERIOD   = parseInt(process.env.TREND_PB_ATR_PERIOD || "14", 10);
  const TRAIL_EMA    = Math.max(2, parseInt(process.env.TREND_PB_TRAIL_EMA || "20", 10));
  const EMA5_PERIOD  = parseInt(process.env.TREND_PB_EMA5_PERIOD || "20", 10);
  const TS_CANDLES   = parseInt(process.env.TREND_PB_TIME_STOP_CANDLES || "6", 10);
  const TS_FLAT      = parseFloat(process.env.TREND_PB_TIME_STOP_FLAT_PTS || "12");
  const PREM_STOP_PCT= parseFloat(process.env.TREND_PB_PREMIUM_STOP_PCT || "35");
  const MAX_TRADE_LOSS = parseFloat(process.env.TREND_PB_MAX_TRADE_LOSS || "0");
  const MAX_TRADES   = parseInt(process.env.TREND_PB_MAX_DAILY_TRADES || "3", 10);
  const FORCED_EXIT_MIN = _parseMin("TREND_PB_FORCED_EXIT", "15:15");
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

  // δ+θ premium sim + spread/slippage haircut both ways. Returns pnl (₹) + exit premium.
  function priceExit(pos, exitSpot, exitTime) {
    const candlesHeld = ((exitTime - pos.entryTime) / 60) / 5;
    const thetaCost = (THETA_DAY * candlesHeld) / 78;
    const spotMove = pos.side === "CE" ? (exitSpot - pos.entrySpot) : (pos.entrySpot - exitSpot);
    const exitPremRaw = Math.max(0.05, pos.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE);
    const exitPrem = Math.max(0.05, exitPremRaw - 2 * SLIPPAGE_PTS);   // buy high + sell low
    const charges = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
    const pnl = parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2));
    return { pnl, exitPrem: parseFloat(exitPrem.toFixed(2)), heldCandles: Math.round(candlesHeld) };
  }

  function closeAndPush(pos, exitSpot, exitTime, reason) {
    const p = priceExit(pos, exitSpot, exitTime);
    trades.push({
      side: pos.side,
      entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitTime),
      entryTs: pos.entryTime, exitTs: exitTime,
      ePrice: pos.entrySpot, xPrice: parseFloat(exitSpot.toFixed(2)), sl: pos.slSpot,
      pnl: p.pnl, reason, entryReason: pos.entryReason,
      trendBias: pos.trendBias, riskPts: pos.riskPts, strength: pos.signalStrength,
      eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.heldCandles,
    });
  }

  for (const [, dayCandles] of byDate) {
    const _dayLen = dayCandles.length;
    if (dayCandles.length < 5) { globalBase += _dayLen; continue; }
    let position = null;
    let tradesTaken = 0;
    let baselineDone = false;

    for (let i = 0; i < dayCandles.length; i++) {
      const c = dayCandles[i];
      const istMin = _utcSecToIstMins(c.time);
      const gIdx = globalBase + i;

      // ── EOD forced square-off ──
      if (position && istMin >= FORCED_EXIT_MIN) {
        closeAndPush(position, c.close, c.time, `EOD square-off (${process.env.TREND_PB_FORCED_EXIT || "15:15"} IST)`);
        position = null; continue;
      }

      // ── In-position management (mirrors paper _checkExits + _managePositionOnClose).
      //    Conservative ordering, NO look-ahead: adverse stops use slSpot/best set by
      //    PRIOR candles; only after surviving do we ratchet the trail with THIS candle. ──
      if (position) {
        const pos = position;
        const win = allCandles.slice(Math.max(0, gIdx - SIG_WINDOW), gIdx + 1);
        const atr5 = _atrAtLast(win, ATR_PERIOD);
        const ema5 = _emaAtLast(win.map(x => x.close), EMA5_PERIOD);

        // A. adverse intra-candle exits (stop set by earlier candles)
        const advSpot = pos.side === "CE" ? c.low : c.high;
        const advMove = pos.side === "CE" ? (c.low - pos.entrySpot) : (pos.entrySpot - c.high);
        const advPrem = Math.max(0.05, pos.optionEntryLtp + advMove * DELTA);
        if (PREM_STOP_PCT > 0 && advPrem <= pos.optionEntryLtp * (1 - PREM_STOP_PCT / 100)) {
          closeAndPush(pos, advSpot, c.time, `Premium disaster stop (−${PREM_STOP_PCT}%)`); position = null; continue;
        }
        if (MAX_TRADE_LOSS > 0 && (advPrem - pos.optionEntryLtp) * LOT_SIZE <= -MAX_TRADE_LOSS) {
          closeAndPush(pos, advSpot, c.time, `Max trade loss (₹${MAX_TRADE_LOSS})`); position = null; continue;
        }
        // Gap-through: fill at the open if the bar gapped past the stop (worse).
        if (pos.side === "CE" && c.low <= pos.slSpot)  { closeAndPush(pos, c.open < pos.slSpot ? c.open : pos.slSpot, c.time, `Stop hit (${pos.slSpot}${pos.trailArmed ? " · trail" : pos.breakevenArmed ? " · BE" : ""})`); position = null; continue; }
        if (pos.side === "PE" && c.high >= pos.slSpot) { closeAndPush(pos, c.open > pos.slSpot ? c.open : pos.slSpot, c.time, `Stop hit (${pos.slSpot}${pos.trailArmed ? " · trail" : pos.breakevenArmed ? " · BE" : ""})`); position = null; continue; }

        // B. survived the candle → ratchet stop + close-based exits for the NEXT candle
        pos.candlesHeld++;
        if (pos.side === "CE") { if (c.high > pos.bestSpot) pos.bestSpot = c.high; } else { if (c.low < pos.bestSpot) pos.bestSpot = c.low; }
        const favPts = (c.close - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
        // breakeven (tighten only)
        if (!pos.breakevenArmed && BE_R > 0 && pos.riskPts > 0 && favPts >= BE_R * pos.riskPts) {
          if (pos.side === "CE" && pos.entrySpot > pos.slSpot) pos.slSpot = pos.entrySpot;
          if (pos.side === "PE" && pos.entrySpot < pos.slSpot) pos.slSpot = pos.entrySpot;
          pos.breakevenArmed = true;
        }
        // ATR chandelier trail (ratchet one way)
        if (atr5 != null) {
          const cand = pos.side === "CE" ? pos.bestSpot - TRAIL_MULT * atr5 : pos.bestSpot + TRAIL_MULT * atr5;
          if (pos.side === "CE" && cand > pos.slSpot) { pos.slSpot = parseFloat(cand.toFixed(2)); pos.trailArmed = true; }
          if (pos.side === "PE" && cand < pos.slSpot) { pos.slSpot = parseFloat(cand.toFixed(2)); pos.trailArmed = true; }
        }
        // EMA20(5m) close trend-failure (arm then fire)
        if (ema5 != null) {
          if (pos.side === "CE") {
            if (c.close >= ema5) pos.emaArmed = true;
            else if (pos.emaArmed) { closeAndPush(pos, c.close, c.time, `Closed below EMA${TRAIL_EMA}(5m) — trend failed`); position = null; continue; }
          } else {
            if (c.close <= ema5) pos.emaArmed = true;
            else if (pos.emaArmed) { closeAndPush(pos, c.close, c.time, `Closed above EMA${TRAIL_EMA}(5m) — trend failed`); position = null; continue; }
          }
        }
        // time-stop (theta bleed while flat)
        if (TS_CANDLES > 0 && pos.candlesHeld >= TS_CANDLES && Math.abs(favPts) < TS_FLAT) {
          closeAndPush(pos, c.close, c.time, `Time stop (${pos.candlesHeld} candles, flat ${favPts.toFixed(1)}pt)`); position = null; continue;
        }
        continue;   // in-position candle handled
      }

      // ── Flat → look for an entry ──
      if (tradesTaken >= MAX_TRADES) continue;
      if (istMin < ENTRY_START_MIN || istMin >= ENTRY_END_MIN) continue;
      const seen = allCandles.slice(Math.max(0, gIdx - SIG_WINDOW), gIdx + 1);
      const sig = trendPbStrategy.getSignal(seen, { silent: true, alreadyTraded: false });

      let side = null, structStop = null, entryReason = null, bias = sig.trendBias;
      if (!baseline) {
        if (sig.signal === "BUY_CE" || sig.signal === "BUY_PE") { side = sig.side; structStop = sig.slSpot; entryReason = sig.reason; }
      } else if (!baselineDone && (sig.trendBias === "UP" || sig.trendBias === "DOWN")) {
        // Naive baseline: first window candle with a 15m bias → enter that side, widest stop.
        side = sig.trendBias === "UP" ? "CE" : "PE";
        structStop = side === "CE" ? c.close - CLAMP_MAX : c.close + CLAMP_MAX;
        entryReason = `BASELINE: 15m ${sig.trendBias} bias at window open (no pullback filter)`;
        baselineDone = true;
      }
      if (!side) continue;

      let riskPts = Math.abs(c.close - (typeof structStop === "number" ? structStop : (side === "CE" ? c.close - CLAMP_MIN : c.close + CLAMP_MIN)));
      riskPts = Math.min(Math.max(riskPts, CLAMP_MIN), CLAMP_MAX);
      const initSl = parseFloat((side === "CE" ? c.close - riskPts : c.close + riskPts).toFixed(2));
      position = {
        side, entryTime: c.time, entrySpot: c.close,
        optionEntryLtp: SEED_PREMIUM, slSpot: initSl, riskPts,
        bestSpot: c.close, breakevenArmed: false, trailArmed: false, emaArmed: false,
        candlesHeld: 0, trendBias: bias, signalStrength: baseline ? "BASELINE" : (sig.signalStrength || "STRONG"),
        entryReason,
      };
      tradesTaken++;
    }

    // close any open position at the last candle of the day
    if (position) {
      const last = dayCandles[dayCandles.length - 1];
      closeAndPush(position, last.close, last.time, "EOD (end of day candles)");
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
      { key: "riskPts", label: "Risk (pt)" },
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
    notes: `Option premium δ+θ simulated (BACKTEST_DELTA ${process.env.BACKTEST_DELTA || "0.55"}, θ ₹${process.env.BACKTEST_THETA_DAY || "8"}/day) seeded slightly-ITM at ₹${process.env.TREND_PB_BT_SEED_PREMIUM || "240"}, PLUS a spread/slippage haircut of ${process.env.TREND_PB_BT_SLIPPAGE_PTS || "1.5"}pt EACH way — treat ₹ as directional, not exact. Entry: 15m bias (HH/HL + EMA20>EMA50 + slope + VWAP) → healthy 5m pullback to EMA20 → resumption body ≥ ${process.env.TREND_PB_BODY_ATR_MULT || "0.5"}×ATR5. Exits (all on SPOT except the premium backstop): structural stop (clamped ${process.env.TREND_PB_STOP_CLAMP_MIN || "8"}–${process.env.TREND_PB_STOP_CLAMP_MAX || "30"}pt) → breakeven ${process.env.TREND_PB_BREAKEVEN_R || "1.0"}R → ATR-chandelier trail ${process.env.TREND_PB_TRAIL_ATR_MULT || "2.5"}×ATR5 → EMA${process.env.TREND_PB_TRAIL_EMA || "20"}(5m)-close → time-stop ${process.env.TREND_PB_TIME_STOP_CANDLES || "6"} → premium −${process.env.TREND_PB_PREMIUM_STOP_PCT || "35"}% → 15:15 EOD. <b>${wfLine}</b> The DUMB BASELINE (enter in the 15m-trend direction at the window open, same trail+EOD, NO pullback filter) is the bar to beat: if the strategy doesn't clear it out-of-sample, the pullback filter is noise. Use Replay (recorded ticks) for tick-accurate fills.`,
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
        backtestJobs.updateProgress(id, { phase: `Running Trend Pullback backtest (${candles.length.toLocaleString()} candles)…`, pct: 5 });
        const trades = runTrendPbBacktest(candles, { baseline: false });
        const stats = computeBacktestStats(trades);
        stats.optionSim = true;
        stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
        stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");

        backtestJobs.updateProgress(id, { phase: "Running dumb baseline + walk-forward…", pct: 90 });
        const baselineTrades = runTrendPbBacktest(candles, { baseline: true });
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

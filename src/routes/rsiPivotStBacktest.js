/**
 * RSI_PIVOT_ST BACKTEST — /rsi-pivot-st-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest on 5-minute NIFTY 50 INDEX candles. The RSI, the pivot
 * levels, the cross test, the strike choice and the SuperTrend stop all come
 * from the SAME engine the paper route uses (src/strategies/rsi_pivot_st.js) —
 * there is no second copy of the rules here. This file only re-implements the
 * paper route's exits, because paper is canonical:
 *
 *   for each IST day:
 *     pivots = computePivots(daily bars, { forDayKey: this day })   ← yesterday's
 *     for each closed 5-min bar:
 *       getSignal(bars so far, { pivots })  → BUY_CE / BUY_PE / NONE
 *   exits: premium floor → SuperTrend (CE only, trailed) → EOD
 *
 * TWO SERIES ARE FETCHED. The intraday 5-min bars drive every decision; a
 * separate DAILY series supplies each session's pivots. The daily series is
 * requested from a week BEFORE the range so the first day in the range still has
 * a yesterday to compute R1/S1 from — without that padding the first session of
 * every run would silently take no trades.
 *
 * CONSERVATIVE INTRA-BAR ORDERING (this is where naive backtests lie):
 *   • the adverse STOP is tested on the bar's high/low BEFORE anything
 *     favourable, so a bar that touched both books the LOSS;
 *   • a bar that OPENED beyond a level fills at the OPEN, never at the better
 *     level — no assuming a fill the market never offered;
 *   • entry is the signal bar's CLOSE, exactly as paper reads it;
 *   • the SuperTrend trail advances only on a bar CLOSE, matching paper, so the
 *     stop can never tighten on a level the bar merely traded through.
 *
 * THE PREMIUM STOP IS APPROXIMATED. Paper measures the 25% floor against a real
 * option LTP; there is no historical option chain here, so the premium is δ+θ
 * simulated and the floor is applied to that simulated premium. It is directional,
 * not exact — a 25% premium move is roughly a `0.25 × premium / delta` spot move,
 * and that conversion is where this backtest is least trustworthy.
 *
 * A spread/slippage haircut of RSI_PIVOT_ST_BT_SLIPPAGE_PTS is applied EACH way —
 * without it a backtest of option BUYING always flatters.
 */

const express = require("express");
const router  = express.Router();
const rsiPivotStrategy = require("../strategies/rsi_pivot_st");
const { fetchCandles } = require("../services/backtestEngine");
const { fyersErrText } = require("../utils/fyersErr");
const { faviconLink } = require("../utils/sharedNav");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");

const ACCENT = "#c2410c";
const ENDPOINT = "/rsi-pivot-st-backtest";
const RESULT_KEY = "RSI_PIVOT_ST_BACKTEST";
const SPOT_SYMBOL = "NSE:NIFTY50-INDEX";

function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _resMin() { return rsiPivotStrategy.getConfig().resolutionMins; }
function istDateOf(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function istHHMMSS(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
function entryTsStr(unixSec) { return `${istDateOf(unixSec)}, ${istHHMMSS(unixSec)}`; }

function escHtml(x) {
  return String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** `from` shifted back by `days`, as YYYY-MM-DD. Used to pad the daily series. */
function _shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function runRsiPivotStBacktest(intraday, daily) {
  const empty = {
    trades: [], days: 0, skipped: [],
    gateStats: { noPivots: 0, crossNoRsi: 0, rsiNoCross: 0, noSuperTrend: 0, setups: 0 },
  };
  if (!intraday || !intraday.length) return empty;

  const cfg = rsiPivotStrategy.getConfig();
  // FUTURES MODE — index points are rupees 1:1: no delta, no theta, and the
  // "premium" the sim carries IS the spot level (see instrumentMode.js).
  const IS_FUT       = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const DELTA        = IS_FUT ? 1.0 : parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = IS_FUT ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE     = instrumentConfig.getLotQty();
  const SEED_PREMIUM = parseFloat(process.env.RSI_PIVOT_ST_BT_SEED_PREMIUM || "180");
  // In futures the entry "premium" is the entry SPOT — seeded per trade below.
  const SLIPPAGE_PTS = parseFloat(process.env.RSI_PIVOT_ST_BT_SLIPPAGE_PTS || "2");
  const RES          = cfg.resolutionMins;

  const MAX_TRADES   = cfg.maxDailyTrades;
  const MAX_DAY_LOSS = cfg.maxDailyLoss;
  const FORCED_EXIT_MIN = cfg.exitTime;

  const sorted = intraday.slice().sort((a, b) => a.time - b.time);
  const dailySorted = Array.isArray(daily) ? daily.slice().sort((a, b) => a.time - b.time) : [];

  // Group by IST day. Each session is evaluated against its OWN bars only: RSI
  // and SuperTrend are seeded from the day's own history exactly as the paper
  // route does after its preload, and the pivots come from the previous DAILY
  // bar rather than from yesterday's intraday tail.
  const dayKeys = [];
  const byDay = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const k = rsiPivotStrategy._istDayOf(sorted[i].time);
    if (!byDay.has(k)) { byDay.set(k, []); dayKeys.push(k); }
    byDay.get(k).push(sorted[i]);
  }

  const trades = [];
  const skipped = [];
  let days = 0;
  const gateStats = { noPivots: 0, crossNoRsi: 0, rsiNoCross: 0, noSuperTrend: 0, setups: 0 };

  for (const k of dayKeys) {
    const bars = byDay.get(k);
    if (!bars || bars.length < 3) continue;
    days++;
    const dayTs = bars[0].time;

    // The day's levels, from the newest daily bar strictly BEFORE this day. This
    // is the no-lookahead guarantee: the engine is handed the day key and picks
    // its own yesterday, so a run walking through history can never read the
    // session it is currently trading.
    const pivots = rsiPivotStrategy.computePivots(dailySorted, { forDayKey: k });
    if (!pivots) {
      gateStats.noPivots++;
      skipped.push({ date: istDateOf(dayTs), reason: "no previous daily candle — R1/S1 could not be computed" });
      continue;
    }

    let dayPnl = 0, dayTrades = 0, dayStopOuts = 0, dayClosed = false;
    let pos = null;
    let sawSetup = false;

    /**
     * Simulated premium at a given spot, with theta decay and the slippage
     * haircut applied both ways. This is also what the premium FLOOR is measured
     * against — see the header note about that approximation.
     */
    function premiumAt(exitPx, exitTime) {
      const barsHeld = Math.max(0, (exitTime - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const move = pos.side === "CE" ? (exitPx - pos.entrySpot) : (pos.entrySpot - exitPx);
      return Math.max(0.05, pos.optionEntryLtp + move * DELTA - thetaCost / LOT_SIZE);
    }

    function priceAt(exitPx, exitTime) {
      const raw = premiumAt(exitPx, exitTime);
      const exitPrem = Math.max(0.05, raw - 2 * SLIPPAGE_PTS);   // buy high + sell low
      const charges = getCharges({ broker: "zerodha", isFutures: IS_FUT, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
      return {
        pnl: parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2)),
        exitPrem: parseFloat(exitPrem.toFixed(2)),
        held: Math.round((exitTime - pos.entryTime) / 60 / RES),
      };
    }

    function close(exitPx, exitTime, reason, isStopOut) {
      const p = priceAt(exitPx, exitTime);
      dayPnl += p.pnl;
      if (isStopOut) dayStopOuts++;
      trades.push({
        side: pos.side,
        entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitTime),
        entryTs: pos.entryTime, exitTs: exitTime,
        ePrice: pos.entrySpot, xPrice: parseFloat(exitPx.toFixed(2)),
        sl: pos.slSpot, target: null,
        riskPts: pos.slPts,
        rsi: pos.rsi, pp: pos.pp, r1: pos.r1, s1: pos.s1,
        crossedLevel: pos.crossedLevel, pivotFrom: pos.pivotFrom,
        strike: pos.strike, strikeMode: pos.strikeMode,
        premiumFloor: Number.isFinite(pos.premiumFloor) ? parseFloat(pos.premiumFloor.toFixed(2)) : null,
        pnl: p.pnl, reason, entryReason: pos.entryReason,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.held,
      });
      pos = null;
      // Day-level breakers — identical thresholds to the paper route.
      if (MAX_DAY_LOSS > 0 && dayPnl <= -MAX_DAY_LOSS) dayClosed = true;
      else if (dayTrades >= MAX_TRADES) dayClosed = true;
    }

    for (let i = 0; i < bars.length; i++) {
      const c = bars[i];
      const istMin = _utcSecToIstMins(c.time);

      // ── Manage an open position on THIS bar. ───────────────────────────────
      if (pos) {
        if (istMin >= FORCED_EXIT_MIN) {
          close(c.open, c.time, `EOD square-off (${rsiPivotStrategy._fmtMins(FORCED_EXIT_MIN)} IST)`, false);
        } else {
          const isCE = pos.side === "CE";
          // 1. The PREMIUM floor, tested against the bar's ADVERSE extreme —
          //    the worst premium the bar could have printed. Paper tests this
          //    first too, and it is the only stop a PE carries.
          const adverse = isCE ? c.low : c.high;
          const worstPrem = premiumAt(adverse, c.time);
          // Explicit isFinite: a side with the premium stop switched off carries
          // a null floor, and `worstPrem <= null` would silently mean "<= 0".
          if (Number.isFinite(pos.premiumFloor) && worstPrem <= pos.premiumFloor) {
            // Convert the floor back into the spot that produced it, so the fill
            // is the level rather than the bar's extreme — unless the bar OPENED
            // already through it, in which case the open is the honest fill.
            const floorSpot = pos.entrySpot + (isCE ? 1 : -1) * ((pos.premiumFloor - pos.optionEntryLtp) / DELTA);
            const openThrough = isCE ? c.open <= floorSpot : c.open >= floorSpot;
            const fill = openThrough ? c.open : floorSpot;
            const trailing = pos.premiumFloor > pos.initialPremiumFloor;
            close(fill, c.time,
              `Premium ${trailing ? "trailing " : ""}stop — simulated premium reached the ${cfg.premiumStopPct}% floor ₹${pos.premiumFloor.toFixed(2)}` +
              (trailing ? ` (peak ₹${pos.peakPremium.toFixed(2)})` : ""),
              true);
          }
        }
      }

      // 2. The SuperTrend stop, on whichever sides carry it. Tested against the
      //    bar's ADVERSE extreme — the low for a CE, the high for a PE.
      if (pos && Number.isFinite(pos.slSpot)) {
        const stIsCE = pos.side === "CE";
        const adverseSt = stIsCE ? c.low : c.high;
        if (rsiPivotStrategy.stopHit(pos.side, adverseSt, pos.slSpot)) {
          // A bar that OPENED already through the level fills at the open.
          const openThroughSt = stIsCE ? c.open < pos.slSpot : c.open > pos.slSpot;
          const fill = openThroughSt ? c.open : pos.slSpot;
          const trailing = stIsCE ? pos.slSpot > pos.initialSlSpot : pos.slSpot < pos.initialSlSpot;
          close(fill, c.time,
            `SuperTrend ${trailing ? "trailing " : ""}stop hit at ${pos.slSpot}` + (trailing ? ` (initial ${pos.initialSlSpot})` : ""),
            true);
        }
      }

      // ── Trail on the bar's CLOSE, exactly as paper does. ───────────────────
      if (pos) {
        // Premium high-water → floor ratchet.
        const closePrem = premiumAt(c.close, c.time);
        if (closePrem > pos.peakPremium) {
          pos.peakPremium = closePrem;
          const trailed = rsiPivotStrategy.premiumStop(pos.optionEntryLtp, pos.peakPremium, cfg, pos.side);
          if (Number.isFinite(trailed) && trailed > pos.premiumFloor) pos.premiumFloor = trailed;
        }
        // SuperTrend ratchet / flip, mirrored per side — exactly as paper does.
        if (rsiPivotStrategy.stApplies(pos.side, cfg)) {
          const stIsCE = pos.side === "CE";
          const series = rsiPivotStrategy.computeSuperTrendSeries(bars.slice(0, i + 1), cfg);
          const st = rsiPivotStrategy.superTrendStop(pos.side, series, pos.slSpot, cfg);
          if (st) {
            if (st.flipped) {
              close(c.close, c.time, `SuperTrend flipped ${stIsCE ? "bearish" : "bullish"} — the ${pos.side}'s trend premise is gone`, true);
            } else if (Number.isFinite(st.stop) &&
                       (!Number.isFinite(pos.slSpot) || (stIsCE ? st.stop > pos.slSpot : st.stop < pos.slSpot))) {
              pos.slSpot = st.stop;
            }
          }
        }
      }

      // ── Look for a new entry on this bar's close. ──────────────────────────
      if (!pos && !dayClosed && dayTrades < MAX_TRADES) {
        const closeMins = istMin + RES;
        if (closeMins > cfg.entryEndMin) continue;
        const sig = rsiPivotStrategy.getSignal(bars.slice(0, i + 1), { cfg, pivots, silent: true });

        if (sig.signal === "NONE") {
          // Attribute the near-misses so a zero-trade run can be explained.
          const why = String(sig.skipReason || "");
          if (/not above|not below/.test(why)) gateStats.crossNoRsi++;
          else if (/no fresh cross/.test(why)) gateStats.rsiNoCross++;
          else if (/SuperTrend/.test(why)) gateStats.noSuperTrend++;
          continue;
        }
        if (!sig.side) continue;

        gateStats.setups++;
        sawSetup = true;

        const entryPrem = IS_FUT ? sig.entrySpot : SEED_PREMIUM;
        // null when the premium stop is switched off for this side — the exit
        // block below skips the floor test entirely in that case.
        // Futures have no premium, so the premium floor is absent — matching the
        // paper route, which disables it rather than deriving one from a spot.
        const floor = IS_FUT ? null : rsiPivotStrategy.premiumStop(entryPrem, null, cfg, sig.side);
        pos = {
          side: sig.side,
          entryTime: c.time,
          entrySpot: sig.entrySpot,          // the bar's CLOSE — same as paper
          optionEntryLtp: entryPrem,
          peakPremium: entryPrem,
          premiumFloor: floor,
          initialPremiumFloor: floor,
          slSpot: sig.slSpot,                // null when this side has no SuperTrend
          initialSlSpot: sig.slSpot,
          slPts: sig.slPts,
          rsi: sig.rsi, pp: sig.pp, r1: sig.r1, s1: sig.s1,
          crossedLevel: sig.crossedLevel,
          pivotFrom: pivots.from,
          strike: sig.strike, strikeMode: sig.strikeMode,
          entryReason: sig.reason,
        };
        dayTrades++;
      }
    }

    if (pos) {
      const last = bars[bars.length - 1];
      close(last.close, last.time, "EOD (end of day candles)", false);
    }
    if (!sawSetup) {
      skipped.push({ date: istDateOf(dayTs), reason: `no RSI+pivot cross all session (R1 ${pivots.r1}, S1 ${pivots.s1})` });
    }
  }

  return { trades, days, skipped, gateStats };
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

function _renderResults(res, from, to, trades, stats, meta) {
  const inf = (x) => x === Infinity ? "∞" : x;
  const cfg = rsiPivotStrategy.getConfig();
  const gs = meta.gateStats || { noPivots: 0, crossNoRsi: 0, rsiNoCross: 0, noSuperTrend: 0, setups: 0 };
  const html = renderBacktestResults({
    mode: "RSI_PIVOT_ST",
    accent: ACCENT,
    strategyName: rsiPivotStrategy.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "rsiPivotStBacktest",
    extraTradeColumns: [
      { key: "rsi", label: "RSI" },
      { key: "crossedLevel", label: "Level" },
      { key: "strike", label: "Strike" },
      { key: "riskPts", label: "Risk (pt)" },
      { key: "held", label: "Held" },
    ],
    extraStats: [
      { label: "Profit Factor", value: inf(stats.profitFactor) },
      { label: "Expectancy /trade", value: `₹${stats.expectancy}` },
      { label: "Max Drawdown", value: `₹${stats.maxDrawdown}` },
      { label: "Sessions scanned", value: meta.days },
      { label: "Setups taken", value: gs.setups },
      { label: "Skipped — no pivot levels", value: gs.noPivots },
      { label: "Skipped — crossed, RSI failed", value: gs.crossNoRsi },
      { label: "Skipped — RSI ok, no fresh cross", value: gs.rsiNoCross },
      { label: "Skipped — CE without SuperTrend", value: gs.noSuperTrend },
      { label: "Trade frequency", value: meta.days ? `${((trades.length / meta.days) * 100).toFixed(1)}% of sessions` : "—" },
    ],
    notes: `${instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" ? "FUTURES MODE — P&L is index points × lot with futures charges, no δ/θ and no premium stop (they have no meaning without a premium); a PE is a SHORT. " : ""}<b>Chart:</b> NIFTY 50 INDEX ${cfg.resolutionMins}-min for every decision, plus a DAILY series (padded a week before the range) for the pivots. <b>Levels:</b> Standard/floor pivots from the PREVIOUS day's high/low/close — PP=(H+L+C)/3, R1=2·PP−L, S1=2·PP−H. They are fixed for the whole session and the engine picks each day's own yesterday, so no run can read the session it is trading. <b>Setup:</b> CE = RSI(${cfg.rsiPeriod}) &gt; ${cfg.rsiCeMin} AND a candle that CROSSES and CLOSES above R1 (the previous close must have been at or below it — a bar already above R1 is not a cross); PE = RSI &lt; ${cfg.rsiPeMax} AND a cross-and-close below S1${cfg.pivotBufferPts ? `, with a ${cfg.pivotBufferPts}pt buffer` : ""}. <b>Strike:</b> ${cfg.strikeMode} at ${cfg.strikePct}% of spot, rounded to the nearest 50. <b>Stops (both are per-side toggles):</b> a SuperTrend(${cfg.stPeriod},${cfg.stMultiplier}) trail on <b>${cfg.stSides}</b> (<code>RSI_PIVOT_ST_ST_SIDES</code>) — bullish line below a CE, bearish line above a PE, ratcheting only in the trade's favour, and a flip is itself an exit — plus a ${cfg.premiumStopPct}% premium floor on <b>${cfg.premiumStopSides}</b> (<code>RSI_PIVOT_ST_PREMIUM_SL_SIDES</code>)${["CE","PE"].filter(s => rsiPivotStrategy.isStoplessSide(s, cfg)).map(s => ` <b>[${s} therefore has NO stop and can only exit at EOD]</b>`).join("")}. Both trail and neither ever loosens. There is <b>no profit target</b> — the trade runs until a stop trails into it or ${rsiPivotStrategy._fmtMins(cfg.exitTime)} forces it out. Max ${cfg.maxDailyTrades} trades/day, day ends on a ₹${cfg.maxDailyLoss} loss. <b>Intra-bar ordering is conservative:</b> the premium floor is tested against the bar's adverse extreme and the SuperTrend against the bar's low, both BEFORE any trail advances, and a bar that opened beyond a level fills at the open. <b>The premium stop is the weakest part of this simulation</b> — there is no historical option chain, so premium is δ+θ simulated (BACKTEST_DELTA ${process.env.BACKTEST_DELTA || "0.55"}, θ ₹${process.env.BACKTEST_THETA_DAY || "8"}/day) seeded at ₹${process.env.RSI_PIVOT_ST_BT_SEED_PREMIUM || "180"}, and the 25% floor is measured against that simulated number rather than a real quote, PLUS ${process.env.RSI_PIVOT_ST_BT_SLIPPAGE_PTS || "2"}pt slippage EACH way. Treat ₹ as directional, not exact. <b>This strategy has NEVER traded live or on paper, and no threshold in it has been fitted or validated.</b>`,
  });
  res.send(html);
}

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  if (!from || !to) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    return res.redirect(`${ENDPOINT}?from=${_shiftDate(today, -90)}&to=${today}`);
  }

  const jobId = req.query.jobId;
  if (!jobId) {
    const activeJob = backtestJobs.getActiveJob();
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "RSI Pivot ST Backtest"));
    const { id } = backtestJobs.createJob("rsi_pivot_st");
    (async () => {
      try {
        console.log(`🔍 RSI_PIVOT_ST Backtest job ${id}: ${from} → ${to}`);
        backtestJobs.updateProgress(id, { phase: `Fetching ${_resMin()}-min NIFTY candles…`, pct: 20 });

        let intraday = [];
        try {
          intraday = await fetchCandles(SPOT_SYMBOL, String(_resMin()), from, to);
        } catch (err) {
          backtestJobs.failJob(id, `Fyers refused the intraday request for ${from} → ${to}: ${fyersErrText(err).slice(0, 300)}`);
          return;
        }
        if (!Array.isArray(intraday) || intraday.length < 50) {
          backtestJobs.failJob(id, (!intraday || !intraday.length)
            ? `Fyers returned no historical candles for ${from} → ${to}. Most often the Fyers session needs re-login — an expired token returns no data (NOT an auth error). Log in to Fyers again, then retry.`
            : `Only ${intraday.length} candle(s) for ${from} → ${to} — widen the range.`);
          return;
        }

        // The DAILY series for the pivots, padded back a week so the first
        // session in the range still has a yesterday to compute R1/S1 from.
        backtestJobs.updateProgress(id, { phase: "Fetching daily candles for the pivot levels…", pct: 45 });
        let daily = [];
        try {
          daily = await fetchCandles(SPOT_SYMBOL, "D", _shiftDate(from, -10), to);
        } catch (err) {
          backtestJobs.failJob(id, `Intraday candles fetched, but the DAILY series (needed for R1/S1) was refused: ${fyersErrText(err).slice(0, 300)}`);
          return;
        }
        if (!Array.isArray(daily) || daily.length < 2) {
          backtestJobs.failJob(id, `No usable daily candles for ${_shiftDate(from, -10)} → ${to}. Standard pivots are computed from the PREVIOUS day's high/low/close, so without a daily series this strategy cannot produce a single trade.`);
          return;
        }

        backtestJobs.updateProgress(id, { phase: `Running RSI Pivot ST backtest (${intraday.length.toLocaleString()} candles, ${daily.length} daily bars)…`, pct: 75 });
        const result = runRsiPivotStBacktest(intraday, daily);
        const stats = computeBacktestStats(result.trades);
        stats.optionSim = true;
        stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
        stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");

        try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: String(_resMin()) } }); }
        catch (e) { console.warn("[rsi-pivot-st-backtest] saveResult failed:", e.message); }

        backtestJobs.completeJob(id, { trades: result.trades, stats, from, to, meta: { days: result.days, skipped: result.skipped, gateStats: result.gateStats } });
        console.log(`✅ RSI_PIVOT_ST Backtest job ${id} complete — ${result.trades.length} trades over ${result.days} sessions`);
      } catch (err) {
        console.error("[rsi-pivot-st-backtest] job error:", err);
        backtestJobs.failJob(id, err.message);
      }
    })();
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "RSI Pivot ST Backtest"));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "RSI Pivot ST Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));
  const { trades, stats, meta } = job.result;
  return _renderResults(res, from, to, trades, stats, meta || { days: 0, skipped: [], gateStats: {} });
});

function _errLightAttr() {
  return require("../utils/theme").resolveTheme() === "light" ? ' data-theme="light"' : "";
}

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html${_errLightAttr()}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>RSI Pivot ST Backtest — error</title>${faviconLink()}
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1220;color:#e2e8f0;margin:0;padding:40px 16px}
.box{max-width:640px;margin:0 auto;background:#111827;border:1px solid #1e293b;border-radius:12px;padding:24px}
h1{font-size:1.1rem;margin:0 0 12px;color:#f87171}
p{color:#cbd5e1;line-height:1.65;font-size:0.9rem}
a{display:inline-block;margin-top:16px;background:${ACCENT};color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-size:0.85rem}
</style></head><body><div class="box">
<h1>Backtest could not run</h1>
<p>${escHtml(msg)}</p>
<a href="${ENDPOINT}?from=${escHtml(from || "")}&to=${escHtml(to || "")}">← Try again</a>
</div></body></html>`;
}

module.exports = router;

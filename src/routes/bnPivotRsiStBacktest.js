/**
 * BN_PIVOT_RSI_ST BACKTEST — /bn-pivot-rsi-st-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest on 5-minute NIFTY BANK (NSE:NIFTYBANK-INDEX) candles —
 * the SAME rules as RSI_PIVOT_ST, on a different underlying. The RSI, the pivot
 * levels, the cross test, the strike choice and the SuperTrend filter all come
 * from the SAME engine the paper route uses (src/strategies/bn_pivot_rsi_st.js) —
 * there is no second copy of the rules here. This file only re-implements the
 * paper route's exits, because paper is canonical:
 *
 *   for each IST day:
 *     pivots = computePivots(daily bars, { forDayKey: this day })   ← yesterday's
 *     for each closed 5-min bar:
 *       getSignal(bars so far, { pivots })  → BUY_CE / BUY_PE / NONE
 *   exit: the global profit lock on the simulated premium, else the day's last bar
 *
 * TWO SERIES ARE FETCHED. The intraday 5-min bars drive every decision; a
 * separate DAILY series supplies each session's pivots. The daily series is
 * requested from a week BEFORE the range so the first day in the range still has
 * a yesterday to compute R1/S1 from — without that padding the first session of
 * every run would silently take no trades.
 *
 * THE PROFIT LOCK (tradeGuards.checkProfitLock) is the ONLY automatic exit, as
 * in paper. There is no historical option chain, so it is applied to a δ+θ
 * simulated premium. Each bar is walked open → adverse extreme → favourable
 * extreme → close: the peak only rises on the open and the favourable leg, so a
 * bar can never lock in a gain it had not yet printed. A trade still open at the
 * day's last bar is closed there (paper's session teardown).
 *
 * A spread/slippage haircut of BACKTEST_SLIPPAGE_PTS is applied EACH way —
 * without it a backtest of option BUYING always flatters.
 */

const express = require("express");
const router  = express.Router();
const bnPivotStrategy = require("../strategies/bn_pivot_rsi_st");
const { fetchCandles } = require("../services/backtestEngine");
const { fyersErrText } = require("../utils/fyersErr");
const { faviconLink } = require("../utils/sharedNav");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");
const tradeGuards = require("../utils/tradeGuards");
const backtestCosts = require("../config/backtestCosts");

const ACCENT = "#c2410c";
const ENDPOINT = "/bn-pivot-rsi-st-backtest";
const RESULT_KEY = "BN_PIVOT_RSI_ST_BACKTEST";

/**
 * THE UNDERLYING IS NIFTY BANK, NOT NIFTY 50. Everything that differs from
 * RSI_PIVOT_ST follows from this one line: the spot symbol the candles are
 * fetched for, the 100-point strike grid, the 30-lot contract and the
 * monthly-only expiry all come out of the shared underlying table rather than
 * being spelled here — see src/config/instrument.js UNDERLYING_DEFS.BANKNIFTY.
 */
const UNDERLYING = "BANKNIFTY";
/** The resolved row, read LIVE so a Settings save (lot size, strike step) lands
 *  on the next run without a restart. `spot` itself is static. */
function _u() { return instrumentConfig.underlyingOf(UNDERLYING); }
const BANKNIFTY_INDEX_SYMBOL = _u().spot;   // NSE:NIFTYBANK-INDEX

/**
 * The one-line instrument banner every run prints and the results page repeats.
 * It exists because a BANKNIFTY run that silently fetched NIFTY candles would
 * look completely healthy in the numbers — the label, the symbol, the strike
 * grid, the lot and the expiry regime are the only way to see it from the log.
 */
function instrumentBanner() {
  const u = _u();
  return `${u.label} (${u.spot}) — strikes every ${bnPivotStrategy.strikeStep()} pts, lot ${instrumentConfig.getLotQty(UNDERLYING)}, ` +
         (u.weekly
           ? "weekly + monthly expiries"
           : "MONTHLY expiry only (NSE withdrew BANKNIFTY weeklies in Nov-2024)");
}

function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _resMin() { return bnPivotStrategy.getConfig().resolutionMins; }
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

async function runBnPivotRsiStBacktest(intraday, daily) {
  const empty = {
    trades: [], days: 0, skipped: [],
    gateStats: { noPivots: 0, crossNoRsi: 0, rsiNoCross: 0, noSuperTrend: 0, setups: 0 },
  };
  if (!intraday || !intraday.length) return empty;

  const cfg = bnPivotStrategy.getConfig();
  // FUTURES MODE — index points are rupees 1:1: no delta, no theta, and the
  // "premium" the sim carries IS the spot level (see instrumentMode.js).
  const IS_FUT       = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const DELTA        = IS_FUT ? 1.0 : parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = IS_FUT ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE     = instrumentConfig.getLotQty(UNDERLYING);   // BANKNIFTY lot, not NIFTY's
  const SEED_PREMIUM = backtestCosts.seedPremium();
  // In futures the entry "premium" is the entry SPOT — seeded per trade below.
  const SLIPPAGE_PTS = backtestCosts.slippagePts();
  const RES          = cfg.resolutionMins;
  // Global wait-after-any-exit cooldown (EXIT_REENTRY_COOLDOWN_CANDLES), secs.
  // Paper measures it from the exit's clock time: an exit INSIDE the bar
  // (≈ bar open here), or one at the bar's CLOSE.
  const REENTRY_COOLDOWN_SECS = tradeGuards.reentryCooldownMs(RES) / 1000;

  const sorted = intraday.slice().sort((a, b) => a.time - b.time);
  const dailySorted = Array.isArray(daily) ? daily.slice().sort((a, b) => a.time - b.time) : [];

  // Group by IST day. Each session is evaluated against its OWN bars only: RSI
  // and SuperTrend are seeded from the day's own history exactly as the paper
  // route does after its preload, and the pivots come from the previous DAILY
  // bar rather than from yesterday's intraday tail.
  const dayKeys = [];
  const byDay = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const k = bnPivotStrategy._istDayOf(sorted[i].time);
    if (!byDay.has(k)) { byDay.set(k, []); dayKeys.push(k); }
    byDay.get(k).push(sorted[i]);
  }

  const trades = [];
  const skipped = [];
  let days = 0;
  const gateStats = { noPivots: 0, crossNoRsi: 0, rsiNoCross: 0, noSuperTrend: 0, setups: 0 };

  for (const k of dayKeys) {
    // Yield once per session so live ticks/orders sharing this process are not
    // starved while a long backtest runs.
    await new Promise(resolve => setImmediate(resolve));
    const bars = byDay.get(k);
    if (!bars || bars.length < 3) continue;
    days++;
    const dayTs = bars[0].time;

    // The day's levels, from the newest daily bar strictly BEFORE this day. This
    // is the no-lookahead guarantee: the engine is handed the day key and picks
    // its own yesterday, so a run walking through history can never read the
    // session it is currently trading.
    const pivots = bnPivotStrategy.computePivots(dailySorted, { forDayKey: k });
    if (!pivots) {
      gateStats.noPivots++;
      skipped.push({ date: istDateOf(dayTs), reason: "no previous daily candle — R1/S1 could not be computed" });
      continue;
    }

    let pos = null;
    let sawSetup = false;
    let reentryBlockUntil = 0;   // wait-after-any-exit cooldown (unix secs)

    /**
     * Simulated premium at a given spot, with theta decay. This is also what the
     * profit lock is measured against — see the header note.
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

    function close(exitPx, exitTime, reason, atBarClose) {
      if (REENTRY_COOLDOWN_SECS > 0) reentryBlockUntil = exitTime + (atBarClose ? RES * 60 : 0) + REENTRY_COOLDOWN_SECS;
      const p = priceAt(exitPx, exitTime);
      trades.push({
        side: pos.side,
        entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitTime),
        entryTs: pos.entryTime, exitTs: exitTime,
        ePrice: pos.entrySpot, xPrice: parseFloat(exitPx.toFixed(2)),
        sl: null, target: null,
        rsi: pos.rsi, pp: pos.pp, r1: pos.r1, s1: pos.s1,
        crossedLevel: pos.crossedLevel, pivotFrom: pos.pivotFrom,
        strike: pos.strike, strikeMode: pos.strikeMode,
        peakPremium: parseFloat(pos.peakPremium.toFixed(2)),
        pnl: p.pnl, reason, entryReason: pos.entryReason,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.held,
      });
      // PER-TRADE LOG. Names the RESOLVED strike and the exit that closed the
      // trade — a run whose strikes are off the 100-pt BANKNIFTY grid is
      // invisible in the summary numbers.
      const _strikeStr = pos.strike != null ? `${pos.strike}${pos.side}` : `${pos.side} (no strike — futures)`;
      console.log(
        `   ${p.pnl >= 0 ? "🟢" : "🔴"} ${entryTsStr(pos.entryTime)} ${_strikeStr}` +
        ` | spot ${pos.entrySpot} → ${parseFloat(exitPx.toFixed(2))}` +
        ` | prem ₹${parseFloat(pos.optionEntryLtp.toFixed(2))} → ₹${p.exitPrem}` +
        ` | ${p.held} bar(s) | ₹${p.pnl} | exit: ${reason}`
      );
      pos = null;
    }

    /**
     * The global profit lock on one bar, walked open → adverse → favourable →
     * close. Options only — paper skips it in futures mode, where the "premium"
     * is the spot itself.
     */
    function lockExit(c) {
      if (IS_FUT) return;
      const isCE = pos.side === "CE";
      const entry = pos.optionEntryLtp;
      const pOpen = premiumAt(c.open, c.time);
      if (pOpen > pos.peakPremium) pos.peakPremium = pOpen;
      let msg = tradeGuards.checkProfitLock(entry, pOpen, pos.peakPremium);
      if (msg) { close(c.open, c.time, `${msg} (bar opened through it — filled at the open)`); return; }
      msg = tradeGuards.checkProfitLock(entry, premiumAt(isCE ? c.low : c.high, c.time), pos.peakPremium);
      if (msg) {
        // Fill at the spot that produces the locked floor, never better than the open.
        const floor = tradeGuards.exitLevelLtp(entry, pos.peakPremium);
        const raw = pos.entrySpot + (isCE ? 1 : -1) * ((floor - entry) / DELTA);
        close(isCE ? Math.min(c.open, raw) : Math.max(c.open, raw), c.time, msg);
        return;
      }
      const pFav = premiumAt(isCE ? c.high : c.low, c.time);
      if (pFav > pos.peakPremium) pos.peakPremium = pFav;
      msg = tradeGuards.checkProfitLock(entry, premiumAt(c.close, c.time), pos.peakPremium);
      if (msg) close(c.close, c.time, `${msg} (armed and given back inside the bar — filled at the close)`, true);
    }

    for (let i = 0; i < bars.length; i++) {
      const c = bars[i];
      const istMin = _utcSecToIstMins(c.time);

      // ── Manage an open position on THIS bar — the profit lock only. ────────
      if (pos) lockExit(c);

      // ── Look for a new entry on this bar's close. ──────────────────────────
      if (!pos) {
        const closeMins = istMin + RES;
        if (closeMins > cfg.entryEndMin) continue;
        const sig = bnPivotStrategy.getSignal(bars.slice(0, i + 1), { cfg, pivots, silent: true });

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
        // Wait-after-any-exit cooldown: paper's simulateBuy rejects both sides.
        if (c.time < reentryBlockUntil) continue;

        const entryPrem = IS_FUT ? sig.entrySpot : SEED_PREMIUM;
        pos = {
          side: sig.side,
          entryTime: c.time,
          entrySpot: sig.entrySpot,          // the bar's CLOSE — same as paper
          optionEntryLtp: entryPrem,
          peakPremium: entryPrem,
          rsi: sig.rsi, pp: sig.pp, r1: sig.r1, s1: sig.s1,
          crossedLevel: sig.crossedLevel,
          pivotFrom: pivots.from,
          strike: sig.strike, strikeMode: sig.strikeMode,
          entryReason: sig.reason,
        };
      }
    }

    if (pos) {
      const last = bars[bars.length - 1];
      close(last.close, last.time, "Session end (last candle of the day)", true);
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
  const cfg = bnPivotStrategy.getConfig();
  const gs = meta.gateStats || { noPivots: 0, crossNoRsi: 0, rsiNoCross: 0, noSuperTrend: 0, setups: 0 };
  const html = renderBacktestResults({
    mode: "BN_PIVOT_RSI_ST",
    accent: ACCENT,
    strategyName: bnPivotStrategy.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "bnPivotRsiStBacktest",
    extraTradeColumns: [
      { key: "rsi", label: "RSI" },
      { key: "crossedLevel", label: "Level" },
      { key: "strike", label: "Strike" },
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
      { label: "Skipped — SuperTrend disagreed", value: gs.noSuperTrend },
      { label: "Trade frequency", value: meta.days ? `${((trades.length / meta.days) * 100).toFixed(1)}% of sessions` : "—" },
    ],
    notes: `${instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" ? "FUTURES MODE — P&L is index points × lot with futures charges, no δ/θ and no profit lock (it is defined on option premium); a PE is a SHORT. " : ""}<b>Instrument:</b> ${escHtml(instrumentBanner())}. <b>Chart:</b> ${escHtml(_u().label)} INDEX (<code>${escHtml(_u().spot)}</code>) ${cfg.resolutionMins}-min for every decision, plus a DAILY series (padded a week before the range) for the pivots. <b>Levels:</b> Standard/floor pivots from the PREVIOUS day's high/low/close — PP=(H+L+C)/3, R1=2·PP−L, S1=2·PP−H. They are fixed for the whole session and the engine picks each day's own yesterday, so no run can read the session it is trading. <b>Setup:</b> CE = RSI(${cfg.rsiPeriod}) &gt; ${cfg.rsiCeMin} AND a candle that CROSSES and CLOSES above R1 (the previous close must have been at or below it — a bar already above R1 is not a cross); PE = RSI &lt; ${cfg.rsiPeMax} AND a cross-and-close below S1${cfg.pivotBufferPts ? `, with a ${cfg.pivotBufferPts}pt buffer` : ""}. <b>Strike:</b> ${cfg.strikeMode} at ${cfg.strikePct}% of spot, rounded to the nearest ${bnPivotStrategy.strikeStep()}-point BANKNIFTY strike, ${_u().weekly ? "weekly or monthly expiry" : "<b>MONTHLY expiry only</b> (NSE withdrew BANKNIFTY weeklies in Nov-2024, so the premium decays more slowly than a NIFTY weekly)"}. <b>SuperTrend filter:</b> SuperTrend(${cfg.stPeriod},${cfg.stMultiplier}) must agree with the trade on <b>${cfg.stSides}</b> (<code>BN_PIVOT_RSI_ST_ST_SIDES</code>) — bullish for a CE, bearish for a PE. <b>Exit:</b> the global profit lock is the ONLY automatic exit — there is no stop loss, trail, target or day-loss limit; a trade still open at the day's last candle is closed there. Each bar is walked open → adverse extreme → favourable extreme → close. There is no historical option chain, so premium is δ+θ simulated (BACKTEST_DELTA ${process.env.BACKTEST_DELTA || "0.55"}, θ ₹${process.env.BACKTEST_THETA_DAY || "8"}/day) seeded at ₹${backtestCosts.seedPremium()}, and the lock is measured against that simulated number rather than a real quote, PLUS ${backtestCosts.slippagePts()}pt slippage EACH way. The δ, θ and seed-premium DEFAULTS are NIFTY-weekly-shaped — a BANKNIFTY monthly ATM premium is several times ₹180 and decays slower — so set <code>BACKTEST_SEED_PREMIUM</code>, <code>BACKTEST_THETA_DAY</code> and <code>BACKTEST_DELTA</code> for the contract you are actually simulating. Treat ₹ as directional, not exact. <b>This strategy has NEVER traded live or on paper, and no threshold in it has been fitted or validated.</b>`,
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
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "BN Pivot RSI ST Backtest"));
    const { id } = backtestJobs.createJob("bn_pivot_rsi_st");
    (async () => {
      try {
        console.log(`🔍 BN_PIVOT_RSI_ST Backtest job ${id}: ${from} → ${to}`);
        console.log(`   └ instrument: ${instrumentBanner()}`);
        if (instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES") {
          console.warn(`   ⚠️ Seed premium is the common BACKTEST_SEED_PREMIUM (₹${backtestCosts.seedPremium()}), a NIFTY-weekly figure. A BANKNIFTY MONTHLY ATM premium is several times that and decays slower, so the simulated premium (and the profit lock measured on it) is off. Rule unchanged; only the simulation's premium seed is wrong.`);
        }
        backtestJobs.updateProgress(id, { phase: `Fetching ${_resMin()}-min ${_u().label} candles (${BANKNIFTY_INDEX_SYMBOL})…`, pct: 20 });

        let intraday = [];
        try {
          intraday = await fetchCandles(BANKNIFTY_INDEX_SYMBOL, String(_resMin()), from, to);
        } catch (err) {
          backtestJobs.failJob(id, `Fyers refused the intraday request for ${BANKNIFTY_INDEX_SYMBOL} ${from} → ${to}: ${fyersErrText(err).slice(0, 300)}`);
          return;
        }
        if (!Array.isArray(intraday) || intraday.length < 50) {
          backtestJobs.failJob(id, (!intraday || !intraday.length)
            ? `Fyers returned no historical candles for ${BANKNIFTY_INDEX_SYMBOL} (${_u().label}) ${from} → ${to}. Most often the Fyers session needs re-login — an expired token returns no data (NOT an auth error). Log in to Fyers again, then retry.`
            : `Only ${intraday.length} candle(s) for ${from} → ${to} — widen the range.`);
          return;
        }

        // The DAILY series for the pivots, padded back a week so the first
        // session in the range still has a yesterday to compute R1/S1 from.
        backtestJobs.updateProgress(id, { phase: `Fetching ${_u().label} DAILY candles for the pivot levels…`, pct: 45 });
        let daily = [];
        try {
          daily = await fetchCandles(BANKNIFTY_INDEX_SYMBOL, "D", _shiftDate(from, -10), to);
        } catch (err) {
          backtestJobs.failJob(id, `Intraday candles fetched, but the DAILY series (needed for R1/S1) was refused: ${fyersErrText(err).slice(0, 300)}`);
          return;
        }
        if (!Array.isArray(daily) || daily.length < 2) {
          backtestJobs.failJob(id, `No usable daily candles for ${BANKNIFTY_INDEX_SYMBOL} ${_shiftDate(from, -10)} → ${to}. Standard pivots are computed from the PREVIOUS day's high/low/close, so without a daily series this strategy cannot produce a single trade.`);
          return;
        }

        backtestJobs.updateProgress(id, { phase: `Running BN Pivot RSI ST backtest on ${_u().label} (${intraday.length.toLocaleString()} candles, ${daily.length} daily bars)…`, pct: 75 });
        const result = await runBnPivotRsiStBacktest(intraday, daily);
        const stats = computeBacktestStats(result.trades);
        stats.optionSim = true;
        stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
        stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");

        try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: String(_resMin()) } }); }
        catch (e) { console.warn("[bn-pivot-rsi-st-backtest] saveResult failed:", e.message); }

        backtestJobs.completeJob(id, { trades: result.trades, stats, from, to, meta: { days: result.days, skipped: result.skipped, gateStats: result.gateStats } });
        console.log(`✅ BN_PIVOT_RSI_ST Backtest job ${id} complete — ${result.trades.length} trades over ${result.days} sessions on ${_u().label}`);
      } catch (err) {
        console.error("[bn-pivot-rsi-st-backtest] job error:", err);
        backtestJobs.failJob(id, err.message);
      }
    })();
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "BN Pivot RSI ST Backtest"));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "BN Pivot RSI ST Backtest"));
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
<title>BN Pivot RSI ST Backtest — error</title>${faviconLink()}
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

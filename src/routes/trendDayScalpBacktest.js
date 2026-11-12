/**
 * TREND DAY SCALP BACKTEST — /trend-day-scalp-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest. The DAY GATE and the ENTRY decision both come from the
 * SAME engine the paper route uses (src/strategies/trend_day_scalp.js) — there
 * is no second copy of the rules here. This file only re-implements the paper
 * route's exit, because paper is canonical:
 *
 *   for each trading day:
 *     evaluateDayGate(bars up to 10:15)     → tradeable? which side?
 *     for each later closed bar until 14:00:
 *       getSignal(bars, {dayGate})          → BUY_CE / BUY_PE / NONE
 *     exit: the global profit lock (tradeGuards.checkProfitLock) on the
 *           simulated premium; anything still open closes at the day's last bar
 *           (paper's TRADE_STOP_TIME session teardown).
 *
 * INTRA-BAR ORDERING per bar: open → adverse extreme → favourable extreme →
 * close. A bar that OPENED through the lock floor fills at the open; a floor
 * crossed on the adverse leg fills at its spot-equivalent, never better than
 * the open; a lock armed by THIS bar's peak and given back fills at the close.
 *
 * There is NO historical option chain, so premium is δ+θ simulated. Treat ₹ as
 * DIRECTIONAL, not exact. A spread/slippage haircut of BACKTEST_SLIPPAGE_PTS is
 * applied EACH way — without it a backtest of option BUYING always flatters.
 * Futures mode: paper skips the premium lock, so trades run to the day's end.
 *
 * MARKETS. This page is NIFTY; the unified /backtest page runs the SAME loop on
 * BANKNIFTY, SENSEX and NIFTY futures through `backtestPage` (exported below):
 * the market's spot candles, lot, exchange charges (BSE for SENSEX) and, for
 * NIFTY_FUT, futures pricing come from services/backtestMarket.js; the market's
 * pair settings (config/pairs.js: own key, else NIFTY's, else the default) are
 * mapped onto the TDS_* keys the engine reads, for that run only
 * (utils/scopedEnv.js). With market NIFTY nothing changes. MCX and SAIL stay
 * "coming soon": backtestMarket has no MCX spot series or rule expiry, and SAIL
 * is not one of its backtest markets yet.
 */

const express = require("express");
const router  = express.Router();
const tdsStrategy = require("../strategies/trend_day_scalp");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { faviconLink } = require("../utils/sharedNav");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");
const tradeGuards = require("../utils/tradeGuards");

// Futures stop on the long-equivalent futures "premium" (entry, price and peak
// all in index points): tradeGuards.futuresStopLevel with best move = peak − entry.
function _futStopLvl(entry, peak) { return tradeGuards.futuresStopLevel("CE", entry, peak - entry); }
function _futStopMsg(entry, px, peak) {
  const lvl = _futStopLvl(entry, peak);
  if (lvl == null || px > lvl) return null;
  return tradeGuards.premiumStopSpotReason(Math.round((lvl - entry) * 100) / 100, peak - entry);
}
const backtestCosts = require("../config/backtestCosts");
const backtestMarket = require("../services/backtestMarket");

const ACCENT = "#a855f7";
const ENDPOINT = "/trend-day-scalp-backtest";
const RESULT_KEY = "TREND_DAY_SCALP_BACKTEST";

function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _resMin() {
  const v = parseInt(process.env.TDS_RESOLUTION || "5", 10);
  return [1, 3, 5, 10, 15, 30, 60].includes(v) ? v : 5;
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
 * @param {Array} intraday TDS_RESOLUTION-minute spot candles across the range,
 *        INCLUDING enough warm-up before `from` for EMA/ATR to seed.
 * @param {object} [mkt] a backtestMarket.context(): the market's lot, exchange
 *        and futures flag. Omitted = NIFTY options, exactly as before markets existed.
 */
async function runTrendDayScalpBacktest(intraday, mkt) {
  if (!intraday || !intraday.length) return { trades: [], days: 0, skipped: [], gateStats: { decided: 0, tradeable: 0 } };

  const cfg = tdsStrategy.getConfig();
  const M = mkt || backtestMarket.context("NIFTY");
  // FUTURES MODE (the NIFTY_FUT market only) — index points are rupees 1:1: no
  // delta, no theta, and the "premium" the sim carries IS the spot level.
  const IS_FUT       = M.isFutures === true;
  const DELTA        = IS_FUT ? 1.0 : parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = IS_FUT ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE     = M.lotQty;
  const EXCHANGE     = M.exchange;
  const SEED_PREMIUM = backtestCosts.seedPremium();
  // In futures the entry "premium" is the entry SPOT — seeded per trade below.
  const SLIPPAGE_PTS = backtestCosts.slippagePts();
  const RES          = _resMin();
  // Global wait-after-any-exit cooldown (EXIT_REENTRY_COOLDOWN_CANDLES), unix secs.
  // Paper takes EVERY TDS exit on a tick (onCandleClose returns while in a
  // position), so each one is measured from the exit bar's open (≈ c.time here).
  const REENTRY_COOLDOWN_SECS = tradeGuards.reentryCooldownMs(RES) / 1000;

  const sorted = intraday.slice().sort((a, b) => a.time - b.time);

  // Group by IST day, but ALWAYS evaluate the engine against the full
  // continuous series up to the bar in question. Paper's state.candles spans
  // several days (preloadHistory pulls ~150 bars), so EMA20/ATR14 are warm at
  // the open; slicing per-day would restart them every morning and make the
  // backtest disagree with Paper for the first ~20 bars of every session.
  const dayKeys = [];
  const byDay = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const k = tdsStrategy._istDayOf(sorted[i].time);
    if (!byDay.has(k)) { byDay.set(k, []); dayKeys.push(k); }
    byDay.get(k).push(i);              // store INDICES into `sorted`
  }

  // VWAP/EMA/ATR computed ONCE over every bar and read at each bar's index —
  // see computeBacktestSeries. Replaces a per-bar prefix slice + recompute.
  const fullSeries = tdsStrategy.computeBacktestSeries(sorted, cfg);

  const trades = [];
  const skipped = [];
  let days = 0;
  const gateStats = { decided: 0, tradeable: 0 };

  for (const k of dayKeys) {
    // Yield once per session so live ticks/orders sharing this process are not
    // starved while a long backtest runs.
    await new Promise(resolve => setImmediate(resolve));
    const idxs = byDay.get(k);
    if (!idxs.length) continue;
    days++;
    const dayTs = sorted[idxs[0]].time;

    // ── The day gate: evaluated once on the bar that closes at TDS_GATE_TIME. ──
    const gateStartMin = cfg.gateMin - RES;
    const gateIdxPos = idxs.findIndex(i => _utcSecToIstMins(sorted[i].time) === gateStartMin);
    if (gateIdxPos < 0) { skipped.push({ date: istDateOf(dayTs), reason: `no ${tdsStrategy._fmtMins(cfg.gateMin)} gate bar in the session` }); continue; }

    // evaluateDayGate reads only the last bar's IST-day bars (in order), so
    // today's bars up to the gate bar are the exact input the full prefix gave.
    const gate = tdsStrategy.evaluateDayGate(idxs.slice(0, gateIdxPos + 1).map(i => sorted[i]), { cfg, silent: true });
    if (gate.decided) gateStats.decided++;
    if (!gate.tradeable) { skipped.push({ date: istDateOf(dayTs), reason: gate.reason }); continue; }
    gateStats.tradeable++;

    // ── Hunt entries on later closed bars. ────────────────────────────────────
    let reentryBlockUntilTs = 0;   // wait-after-any-exit cooldown, per day like paper's session
    let pos = null;

    function priceAt(exitSpot, exitTime) {
      const barsHeld = Math.max(0, (exitTime - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const spotMove = pos.side === "CE" ? (exitSpot - pos.entrySpot) : (pos.entrySpot - exitSpot);
      const raw = Math.max(0.05, pos.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE);
      const exitPrem = Math.max(0.05, raw - 2 * SLIPPAGE_PTS);   // buy high + sell low
      const charges = getCharges({ broker: "fyers", isFutures: IS_FUT, exchange: EXCHANGE, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
      return {
        pnl: parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2)),
        exitPrem: parseFloat(exitPrem.toFixed(2)),
        held: Math.round(barsHeld),
      };
    }
    /** Mirrors the premium the paper route would be watching, for the profit lock. */
    function premiumAt(spot, t) {
      const barsHeld = Math.max(0, (t - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const spotMove = pos.side === "CE" ? (spot - pos.entrySpot) : (pos.entrySpot - spot);
      // Rounded to paise like a real LTP, so the lock sees a quotable price.
      return Math.max(0.05, parseFloat((pos.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE).toFixed(2)));
    }
    /** Inverse of premiumAt: the spot at which the simulated premium equals `prem`. */
    function spotForPrem(prem, t) {
      const barsHeld = Math.max(0, (t - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const spotMove = (prem - pos.optionEntryLtp + thetaCost / LOT_SIZE) / DELTA;
      return pos.side === "CE" ? pos.entrySpot + spotMove : pos.entrySpot - spotMove;
    }
    /** The profit lock on one simulated premium. Futures: paper skips the lock but
     *  runs the common stop in index points — the "premium" IS the futures price. */
    function lockHit(prem) {
      if (IS_FUT) return _futStopMsg(pos.optionEntryLtp, prem, pos.peak);
      return tradeGuards.checkProfitLock(pos.optionEntryLtp, prem, pos.peak);
    }
    function close(exitSpot, exitTime, reason) {
      const p = priceAt(exitSpot, exitTime);
      trades.push({
        side: pos.side,
        entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitTime),
        entryTs: pos.entryTime, exitTs: exitTime,
        ePrice: pos.entrySpot, xPrice: parseFloat(exitSpot.toFixed(2)),
        sl: null, target: null, peakPrem: parseFloat(pos.peak.toFixed(2)),
        pnl: p.pnl, reason, entryReason: pos.entryReason,
        zone: pos.zone, atr: pos.atr, bodyPts: pos.bodyPts,
        gateSide: gate.side, gateRangePts: gate.rangePts, gateRangePct: gate.rangePct,
        gateExtensionPts: gate.extensionPts,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.held,
      });
      pos = null;
      // Wait-after-any-exit cooldown — every exit reason, both sides.
      if (REENTRY_COOLDOWN_SECS > 0) reentryBlockUntilTs = exitTime + REENTRY_COOLDOWN_SECS;
    }

    for (let p = gateIdxPos + 1; p < idxs.length; p++) {
      const i = idxs[p];
      const c = sorted[i];
      const istMin = _utcSecToIstMins(c.time);

      // ── Manage an open position on THIS bar (profit lock only). ───────────
      if (pos) {
        const isCE = pos.side === "CE";
        const barEnd = c.time + RES * 60;
        // a) the open
        const pOpen = premiumAt(c.open, c.time);
        if (pOpen > pos.peak) pos.peak = pOpen;
        let hit = lockHit(pOpen);
        if (hit) {
          close(c.open, c.time, `${hit} (bar opened through it — filled at the open ${c.open})`);
        } else {
          // b) open → adverse extreme: a floor armed earlier is crossed first.
          const adv = isCE ? c.low : c.high;
          hit = lockHit(premiumAt(adv, barEnd));
          if (hit) {
            const lvl = IS_FUT ? _futStopLvl(pos.optionEntryLtp, pos.peak) : tradeGuards.exitLevelLtp(pos.optionEntryLtp, pos.peak);
            const raw = spotForPrem(lvl, barEnd);
            // Never better than the open (the open did not trigger, so the level lies past it).
            const fill = isCE ? Math.min(c.open, raw) : Math.max(c.open, raw);
            close(fill, barEnd, `${hit} — level premium ₹${lvl} ≈ spot ${parseFloat(raw.toFixed(2))}`);
          } else {
            // c) adverse → favourable extreme: the peak rises, nothing exits.
            const pFav = premiumAt(isCE ? c.high : c.low, c.time);
            if (pFav > pos.peak) pos.peak = pFav;
            // d) favourable → close: a lock armed by THIS peak and given back.
            hit = lockHit(premiumAt(c.close, barEnd));
            if (hit) close(c.close, barEnd, `${hit} (armed and given back inside the bar — filled at the close ${c.close})`);
          }
        }
      }

      // ── Look for a new entry on this bar's close. ──────────────────────────
      if (!pos) {
        const closeMins = istMin + RES;
        if (closeMins > cfg.entryEndMin) continue;
        const sig = tdsStrategy.getSignal(sorted, {
          dayGate: gate, cfg, silent: true,
          precomputed: { series: fullSeries, endIdx: i },
        });
        if (sig.signal === "NONE" || !sig.side) continue;
        // Wait-after-any-exit cooldown: blocks both sides (paper: evaluateEntry).
        if (c.time < reentryBlockUntilTs) continue;

        pos = {
          side: sig.side,
          entryTime: c.time,
          entrySpot: sig.entrySpot,          // the bar's CLOSE — same as paper
          optionEntryLtp: IS_FUT ? sig.entrySpot : SEED_PREMIUM,
          zone: sig.zone, atr: sig.atr, bodyPts: sig.bodyPts,
          entryReason: sig.reason,
        };
        pos.peak = pos.optionEntryLtp;
      }
    }

    if (pos) {
      const last = sorted[idxs[idxs.length - 1]];
      close(last.close, last.time + RES * 60, "Session end — closed at the day's last bar (paper's TRADE_STOP_TIME teardown)");
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

function _escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * The results-page options for one finished run: this page and the unified
 * /backtest page render the same view. `meta.market` is the run's market key
 * (absent on a NIFTY run).
 */
function _resultsView(from, to, trades, stats, meta) {
  const inf = (x) => x === Infinity ? "∞" : x;
  const cfg = tdsStrategy.getConfig();
  const M   = backtestMarket.context(meta.market || "NIFTY");
  const gs = meta.gateStats || { decided: 0, tradeable: 0 };
  return {
    mode: "TREND_DAY_SCALP",
    accent: ACCENT,
    strategyName: tdsStrategy.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "trendDayScalpBacktest",
    extraTradeColumns: [
      { key: "gateRangePct", label: "1h range %" },
      { key: "peakPrem", label: "Peak prem" },
      { key: "held", label: "Held" },
    ],
    extraStats: [
      { label: "Profit Factor", value: inf(stats.profitFactor) },
      { label: "Expectancy /trade", value: `₹${stats.expectancy}` },
      { label: "Max Drawdown", value: `₹${stats.maxDrawdown}` },
      { label: "Sessions scanned", value: meta.days },
      { label: "Day gate PASSED", value: `${gs.tradeable} / ${gs.decided} (${gs.decided ? ((gs.tradeable / gs.decided) * 100).toFixed(0) : 0}%)` },
      { label: "Trade frequency", value: meta.days ? `${((trades.length / meta.days) * 100).toFixed(1)}% of sessions` : "—" },
    ],
    notes: `${M.key !== "NIFTY" ? `<b>MARKET: ${_escHtml(M.label)}</b> — ${_escHtml(M.spotSymbol)} candles, lot ${M.lotQty}, ${_escHtml(M.exchange)} charges. ` : ""}${M.isFutures === true ? "FUTURES MODE — P&L is index points × lot with futures charges, no δ/θ and no premium profit lock (it has no meaning without a premium), so trades run to the day's end; a PE is a SHORT. " : ""}<b>Day gate (${process.env.TDS_GATE_TIME || "10:15"}, decided once then frozen):</b> first-hour range ≥ ${cfg.minRangePct}% of spot, the last ${cfg.vwapStreakBars} closes all one side of VWAP, and spot extended ≥ ${cfg.extensionMult}× the range from VWAP. Fail any one → NO TRADE that day; the side is then LOCKED (above VWAP = CE only). <b>Entry:</b> a pullback whose ${cfg.pullbackWindow}-bar extreme reaches the nearer of VWAP / EMA${cfg.emaPeriod}, reclaimed by a bar CLOSING back through it with body ≥ ${cfg.bodyAtrMult}× ATR${cfg.atrPeriod}. Setups deeper than ${cfg.maxSlPts}pt are SKIPPED. <b>Exit:</b> the global profit lock on the simulated premium is the only exit; anything still open closes at the day's last bar. <b>Intra-bar ordering:</b> open → adverse extreme → favourable extreme → close; a bar that opened through the lock floor fills at the open. Option premium is δ+θ simulated (BACKTEST_DELTA ${process.env.BACKTEST_DELTA || "0.55"}, θ ₹${process.env.BACKTEST_THETA_DAY || "8"}/day) seeded at ₹${backtestCosts.seedPremium()}, PLUS ${backtestCosts.slippagePts()}pt slippage EACH way — treat ₹ as directional, not exact. <b>This strategy stands aside on most days by design, so a short range will show very few trades. It has NEVER traded live or on paper — nothing here is validated.</b>`,
  };
}

function _renderResults(res, from, to, trades, stats, meta) {
  const html = renderBacktestResults(_resultsView(from, to, trades, stats, meta));
  res.send(html);
}

/**
 * One run, start to finish, on job `id` — fetch, simulate, save, then
 * completeJob / failJob. This page and the unified /backtest page both call it.
 */
async function _runJob(id, p) {
  const { from, to } = p;
  const M = backtestMarket.context(p.market || "NIFTY");
  const home = M.key === "NIFTY";
  try {
    console.log(`🔍 TREND_DAY_SCALP Backtest job ${id}: ${from} → ${to}${home ? "" : ` on ${M.key}`}`);
    backtestJobs.updateProgress(id, { phase: home ? "Fetching intraday candles…" : `Fetching ${M.shortLabel} intraday candles…`, pct: 0 });
    // Warm-up runway BEFORE `from` so EMA20/ATR14 are seeded on day one of the
    // range — exactly as Paper's preloadHistory does. ~10 calendar days is
    // ~7 sessions ≈ 525 five-minute bars, far past the ~150-bar convergence.
    const warmDays = 10;
    const warmFrom = new Date(new Date(from + "T00:00:00+05:30").getTime() - warmDays * 86400000)
      .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const intraday = await fetchCandlesCachedBT(M.spotSymbol, String(_resMin()), warmFrom, to, false, (p) => backtestJobs.updateProgress(id, p));
    if (!Array.isArray(intraday) || intraday.length < 50) {
      const n = Array.isArray(intraday) ? intraday.length : 0;
      backtestJobs.failJob(id, n === 0
        ? `Fyers returned no historical candles for ${from} → ${to}. Most often the Fyers session needs re-login — an expired token returns no data (not an auth error). Log in to Fyers again, then retry.`
        : `Only ${n} candle(s) for ${from} → ${to} — widen the range.`);
      return;
    }

    backtestJobs.updateProgress(id, { phase: `Running Trend Day Scalp backtest (${intraday.length.toLocaleString()} candles)…`, pct: 70 });
    // Drop the warm-up days from the RESULT window while leaving them in the
    // series the engine reads (indicators stay warm, trades stay in range).
    const fromTs = Math.floor(new Date(from + "T00:00:00+05:30").getTime() / 1000);
    const all = await runTrendDayScalpBacktest(intraday, M);
    const trades = all.trades.filter(t => t.entryTs >= fromTs);
    const days = all.days;
    const stats = computeBacktestStats(trades);
    stats.optionSim = !M.isFutures;
    stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
    stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
    if (M.isFutures) stats.isFutures = true;   // ₹ (index pts × lot − charges), not raw pts

    // The legacy last-run slot (/all-backtest) is NIFTY's; other markets are
    // kept by the /backtest page's own saved runs.
    if (home) {
      try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: String(_resMin()) } }); }
      catch (e) { console.warn("[trend-day-scalp-backtest] saveResult failed:", e.message); }
    }

    const meta = { days, skipped: all.skipped, gateStats: all.gateStats };
    if (!home) meta.market = M.key;
    backtestJobs.completeJob(id, { trades, stats, from, to, meta });
    console.log(`✅ TREND_DAY_SCALP Backtest job ${id} complete — ${trades.length} trades over ${days} sessions (gate passed ${all.gateStats.tradeable}/${all.gateStats.decided})`);
  } catch (err) {
    console.error("[trend-day-scalp-backtest] job error:", err);
    backtestJobs.failJob(id, err.message);
  }
}

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  if (!from || !to) {
    const today = new Date();
    const def = new Date(); def.setDate(today.getDate() - 90);
    const fmt = d => d.toISOString().slice(0, 10);
    return res.redirect(`${ENDPOINT}?from=${fmt(def)}&to=${fmt(today)}`);
  }

  const jobId = req.query.jobId;
  if (!jobId) {
    const activeJob = backtestJobs.getActiveJob();
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "Trend Day Scalp Backtest"));
    const { id } = backtestJobs.createJob("trend_day_scalp");
    _runJob(id, { from, to });
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "Trend Day Scalp Backtest"));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "Trend Day Scalp Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));
  const { trades, stats, meta } = job.result;
  return _renderResults(res, from, to, trades, stats, meta || { days: 0, skipped: [], gateStats: { decided: 0, tradeable: 0 } });
});


function _errLightAttr() {
  return require("../utils/theme").resolveTheme() === "light" ? ' data-theme="light"' : "";
}

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html${_errLightAttr()}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>Trend Day Scalp Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;}
:root[data-theme="light"] body{background:#f4f6f9;color:#334155;}
:root[data-theme="light"] h2{color:#b91c1c;}
:root[data-theme="light"] a{border-color:#e0e4ea;background:#ffffff;color:#7e22ce;}
@media(max-width:768px){body{padding:24px 14px;}a{min-height:44px;display:inline-flex;align-items:center;justify-content:center;}}</style>
</head><body><h2>Trend Day Scalp Backtest Failed</h2><p>${msg}</p><p><b>${from || ""}</b> → <b>${to || ""}</b></p><a href="${ENDPOINT}">← Back</a></body></html>`;
}

module.exports = router;
// The unified /backtest page's hook (see services/backtestPage.js).
module.exports.backtestPage = {
  markets: ["NIFTY", "BANKNIFTY", "SENSEX", "NIFTY_FUT"],
  resolution: null,
  run: (id, p) => _runJob(id, { from: p.from, to: p.to, market: p.market }),
  view: (r, p) => _resultsView(r.from || p.from, r.to || p.to, r.trades, r.stats, r.meta || { days: 0, skipped: [], gateStats: { decided: 0, tradeable: 0 } }),
};
// Exposed for offline unit-testing of the entry/exit engine (no Fyers needed).
module.exports.runTrendDayScalpBacktest = runTrendDayScalpBacktest;

/**
 * TREND DAY SCALP BACKTEST — /trend-day-scalp-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest. The DAY GATE and the ENTRY decision both come from the
 * SAME engine the paper route uses (src/strategies/trend_day_scalp.js) — there
 * is no second copy of the rules here. This file only re-implements the paper
 * route's exits, because paper is canonical:
 *
 *   for each trading day:
 *     evaluateDayGate(bars up to 10:15)     → tradeable? which side?
 *     for each later closed bar until 14:00:
 *       getSignal(bars, {dayGate})          → BUY_CE / BUY_PE / NONE
 *     exits: hard stop → fixed target → breakeven jump → time stop → EOD
 *
 * CONSERVATIVE INTRA-BAR ORDERING (this is where naive backtests lie):
 *   • the adverse STOP is tested on the bar's high/low BEFORE the favourable
 *     target is tested, so a bar that touched both books the LOSS;
 *   • a bar that OPENED beyond a level fills at the OPEN, never at the better
 *     level — no assuming a fill the market never offered;
 *   • the breakeven jump arms off the bar's favourable EXTREME (paper arms it
 *     per tick, and a tick is what an extreme is made of), but the resulting
 *     stop can only be hit on a LATER bar — never on the same bar that armed it.
 *
 * There is NO historical option chain, so premium is δ+θ simulated. Treat ₹ as
 * DIRECTIONAL, not exact. A spread/slippage haircut of TDS_BT_SLIPPAGE_PTS is
 * applied EACH way — without it a backtest of option BUYING always flatters.
 * The premium stop (-TDS_PREMIUM_STOP_PCT%) is modelled off that simulated
 * premium, so it fires on the δ+θ curve rather than on a real IV crush.
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
const instrumentConfig = require("../config/instrument");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
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
 */
function runTrendDayScalpBacktest(intraday) {
  if (!intraday || !intraday.length) return { trades: [], days: 0, skipped: [], gateStats: { decided: 0, tradeable: 0 } };

  const cfg = tdsStrategy.getConfig();
  // FUTURES MODE — index points are rupees 1:1: no delta, no theta, and the
  // "premium" the sim carries IS the spot level (see instrumentMode.js).
  const IS_FUT       = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const DELTA        = IS_FUT ? 1.0 : parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = IS_FUT ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE     = instrumentConfig.getLotQty();
  const SEED_PREMIUM = parseFloat(process.env.TDS_BT_SEED_PREMIUM || "240");
  // In futures the entry "premium" is the entry SPOT — seeded per trade below.
  const SLIPPAGE_PTS = parseFloat(process.env.TDS_BT_SLIPPAGE_PTS || "1.5");
  const RES          = _resMin();

  const MAX_TRADES  = Math.max(1, parseInt(process.env.TDS_MAX_DAILY_TRADES || "2", 10) || 2);
  const MAX_LOSSES  = Math.max(0, parseInt(process.env.TDS_MAX_DAILY_LOSSES || "2", 10));
  const MAX_DAY_LOSS = parseFloat(process.env.TDS_MAX_DAILY_LOSS   || "3000");
  const PROFIT_LOCK  = parseFloat(process.env.TDS_DAILY_PROFIT_LOCK || "3000");
  const FORCED_EXIT_MIN = tdsStrategy._parseHHMM(process.env.TDS_FORCED_EXIT, 15 * 60 + 10);

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

  const trades = [];
  const skipped = [];
  let days = 0;
  const gateStats = { decided: 0, tradeable: 0 };

  for (const k of dayKeys) {
    const idxs = byDay.get(k);
    if (!idxs.length) continue;
    days++;
    const dayTs = sorted[idxs[0]].time;

    // ── The day gate: evaluated once on the bar that closes at TDS_GATE_TIME. ──
    const gateStartMin = cfg.gateMin - RES;
    const gateIdxPos = idxs.findIndex(i => _utcSecToIstMins(sorted[i].time) === gateStartMin);
    if (gateIdxPos < 0) { skipped.push({ date: istDateOf(dayTs), reason: `no ${tdsStrategy._fmtMins(cfg.gateMin)} gate bar in the session` }); continue; }

    const gate = tdsStrategy.evaluateDayGate(sorted.slice(0, idxs[gateIdxPos] + 1), { cfg, silent: true });
    if (gate.decided) gateStats.decided++;
    if (!gate.tradeable) { skipped.push({ date: istDateOf(dayTs), reason: gate.reason }); continue; }
    gateStats.tradeable++;

    // ── Hunt entries on later closed bars. ────────────────────────────────────
    let dayPnl = 0, dayTrades = 0, dayStopOuts = 0, dayClosed = false;
    let pos = null;

    function priceAt(exitSpot, exitTime) {
      const barsHeld = Math.max(0, (exitTime - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const spotMove = pos.side === "CE" ? (exitSpot - pos.entrySpot) : (pos.entrySpot - exitSpot);
      const raw = Math.max(0.05, pos.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE);
      const exitPrem = Math.max(0.05, raw - 2 * SLIPPAGE_PTS);   // buy high + sell low
      const charges = getCharges({ broker: "fyers", isFutures: IS_FUT, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
      return {
        pnl: parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2)),
        exitPrem: parseFloat(exitPrem.toFixed(2)),
        held: Math.round(barsHeld),
      };
    }
    /** Mirrors the premium the paper route would be watching, for the -25% stop. */
    function premiumAt(spot, t) {
      const barsHeld = Math.max(0, (t - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const spotMove = pos.side === "CE" ? (spot - pos.entrySpot) : (pos.entrySpot - spot);
      return Math.max(0.05, pos.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE);
    }
    function close(exitSpot, exitTime, reason, isStopOut) {
      const p = priceAt(exitSpot, exitTime);
      dayPnl += p.pnl;
      if (isStopOut) dayStopOuts++;
      trades.push({
        side: pos.side,
        entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitTime),
        entryTs: pos.entryTime, exitTs: exitTime,
        ePrice: pos.entrySpot, xPrice: parseFloat(exitSpot.toFixed(2)),
        sl: pos.slSpot, initialSl: pos.initialSlSpot, target: pos.targetSpot,
        beArmed: !!pos.beArmed, riskPts: pos.slPts, targetR: cfg.targetR,
        pnl: p.pnl, reason, entryReason: pos.entryReason,
        zone: pos.zone, atr: pos.atr, bodyPts: pos.bodyPts,
        gateSide: gate.side, gateRangePts: gate.rangePts, gateRangePct: gate.rangePct,
        gateExtensionPts: gate.extensionPts,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.held,
      });
      pos = null;
      // Day-level breakers — identical thresholds to the paper route.
      if (MAX_DAY_LOSS > 0 && dayPnl <= -MAX_DAY_LOSS) dayClosed = true;
      else if (PROFIT_LOCK > 0 && dayPnl >= PROFIT_LOCK) dayClosed = true;
      else if (MAX_LOSSES > 0 && dayStopOuts >= MAX_LOSSES) dayClosed = true;
      else if (dayTrades >= MAX_TRADES) dayClosed = true;
    }

    for (let p = gateIdxPos + 1; p < idxs.length; p++) {
      const i = idxs[p];
      const c = sorted[i];
      const istMin = _utcSecToIstMins(c.time);

      // ── Manage an open position on THIS bar. ───────────────────────────────
      if (pos) {
        if (istMin >= FORCED_EXIT_MIN) {
          close(c.open, c.time, `EOD square-off (${process.env.TDS_FORCED_EXIT || "15:10"} IST)`, false);
        } else {
          const isCE = pos.side === "CE";
          // Same comparison paper runs per tick (tdsStrategy.stopHit / targetHit),
          // fed the bar's adverse / favourable extreme instead of a tick price —
          // bar-vs-tick sampling is the only difference, the rule is the engine's.
          // The helpers also own the "level must be a real number" guard.
          const stopTouched = tdsStrategy.stopHit(pos.side, isCE ? c.low : c.high, pos.slSpot);
          const tgtTouched  = tdsStrategy.targetHit(pos.side, isCE ? c.high : c.low, pos.targetSpot);

          if (stopTouched) {
            // Worse-of open/level fill; a gap through the stop fills at the open.
            const fill = isCE
              ? (c.open < pos.slSpot ? c.open : pos.slSpot)
              : (c.open > pos.slSpot ? c.open : pos.slSpot);
            close(fill, c.time,
              pos.beArmed
                ? `Breakeven stop — price came back to ${pos.slSpot} after arming at +${cfg.breakevenR}R`
                : `Stop hit — ${pos.slPts}pt against, at ${pos.slSpot}`,
              !pos.beArmed);
          } else if (tgtTouched) {
            const fill = isCE
              ? (c.open > pos.targetSpot ? c.open : pos.targetSpot)
              : (c.open < pos.targetSpot ? c.open : pos.targetSpot);
            close(fill, c.time, `Target hit — ${cfg.targetR}R at ${pos.targetSpot}`, false);
          } else {
            // Breakeven arm off this bar's favourable extreme. The moved stop can
            // only be hit from the NEXT bar on — arming and stopping inside one
            // bar would need intra-bar ordering the data cannot supply.
            if (!pos.beArmed) {
              const fav = isCE ? c.high : c.low;
              const be = tdsStrategy.breakevenJump(pos.side, pos.entrySpot, fav, pos.slPts, cfg);
              if (be.armed && typeof be.stop === "number" && Number.isFinite(be.stop)) {
                pos.beArmed = true;
                pos.slSpot = be.stop;
              }
            }
            // Time stop — only while breakeven has not armed (same rule as paper).
            if (pos && tdsStrategy.timeStopHit(pos.entryTime, c.time, pos.beArmed, cfg)) {
              close(c.close, c.time, `Time stop — ${cfg.timeStopMins}m elapsed without reaching +${cfg.breakevenR}R`, false);
            } else if (pos && tdsStrategy.premiumStopHit(pos.optionEntryLtp, premiumAt(c.close, c.time), cfg)) {
              close(c.close, c.time, `Premium stop — simulated premium -${cfg.premiumStopPct}%`, false);
            }
          }
        }
      }

      // ── Look for a new entry on this bar's close. ──────────────────────────
      if (!pos && !dayClosed && dayTrades < MAX_TRADES) {
        const closeMins = istMin + RES;
        if (closeMins > cfg.entryEndMin) continue;
        const sig = tdsStrategy.getSignal(sorted.slice(0, i + 1), { dayGate: gate, cfg, silent: true });
        if (sig.signal === "NONE" || !sig.side) continue;

        pos = {
          side: sig.side,
          entryTime: c.time,
          entrySpot: sig.entrySpot,          // the bar's CLOSE — same as paper
          optionEntryLtp: IS_FUT ? sig.entrySpot : SEED_PREMIUM,
          slPts: sig.slPts,
          slSpot: sig.slSpot,
          initialSlSpot: sig.slSpot,
          targetSpot: sig.targetSpot,
          beArmed: false,
          zone: sig.zone, atr: sig.atr, bodyPts: sig.bodyPts,
          entryReason: sig.reason,
        };
        dayTrades++;
      }
    }

    if (pos) {
      const last = sorted[idxs[idxs.length - 1]];
      close(last.close, last.time, "EOD (end of day candles)", false);
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
  const cfg = tdsStrategy.getConfig();
  const gs = meta.gateStats || { decided: 0, tradeable: 0 };
  const html = renderBacktestResults({
    mode: "TREND_DAY_SCALP",
    accent: ACCENT,
    strategyName: tdsStrategy.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "trendDayScalpBacktest",
    extraTradeColumns: [
      { key: "riskPts", label: "Risk (pt)" },
      { key: "gateRangePct", label: "1h range %" },
      { key: "beArmed", label: "BE armed" },
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
    notes: `<b>Day gate (${process.env.TDS_GATE_TIME || "10:15"}, decided once then frozen):</b> first-hour range ≥ ${cfg.minRangePct}% of spot, the last ${cfg.vwapStreakBars} closes all one side of VWAP, and spot extended ≥ ${cfg.extensionMult}× the range from VWAP. Fail any one → NO TRADE that day; the side is then LOCKED (above VWAP = CE only). <b>Entry:</b> a pullback whose ${cfg.pullbackWindow}-bar extreme reaches the nearer of VWAP / EMA${cfg.emaPeriod}, reclaimed by a bar CLOSING back through it with body ≥ ${cfg.bodyAtrMult}× ATR${cfg.atrPeriod}. <b>Risk:</b> stop = the pullback extreme floored to ${cfg.minSlPts}pt and SKIPPED entirely above ${cfg.maxSlPts}pt, fixed ${cfg.targetR}R target, one breakeven jump at +${cfg.breakevenR}R to entry±${cfg.breakevenBuffer} (never a rolling trail), ${cfg.timeStopMins}m time stop while un-armed, −${cfg.premiumStopPct}% premium stop, EOD ${process.env.TDS_FORCED_EXIT || "15:10"}. Max ${process.env.TDS_MAX_DAILY_TRADES || "2"} trades/day, day ends on ${process.env.TDS_MAX_DAILY_LOSSES || "2"} stop-outs / ₹${process.env.TDS_MAX_DAILY_LOSS || "3000"} loss / ₹${process.env.TDS_DAILY_PROFIT_LOCK || "3000"} profit lock. <b>Intra-bar ordering is conservative:</b> the stop is tested on the bar high/low BEFORE the target, so a bar touching both books the loss, and a bar that opened beyond a level fills at the open. Option premium is δ+θ simulated (BACKTEST_DELTA ${process.env.BACKTEST_DELTA || "0.55"}, θ ₹${process.env.BACKTEST_THETA_DAY || "8"}/day) seeded at ₹${process.env.TDS_BT_SEED_PREMIUM || "240"}, PLUS ${process.env.TDS_BT_SLIPPAGE_PTS || "1.5"}pt slippage EACH way — treat ₹ as directional, not exact. <b>This strategy stands aside on most days by design, so a short range will show very few trades. It has NEVER traded live or on paper — nothing here is validated.</b>`,
  });
  res.send(html);
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
    (async () => {
      try {
        console.log(`🔍 TREND_DAY_SCALP Backtest job ${id}: ${from} → ${to}`);
        backtestJobs.updateProgress(id, { phase: "Fetching intraday candles…", pct: 0 });
        // Warm-up runway BEFORE `from` so EMA20/ATR14 are seeded on day one of the
        // range — exactly as Paper's preloadHistory does. ~10 calendar days is
        // ~7 sessions ≈ 525 five-minute bars, far past the ~150-bar convergence.
        const warmDays = 10;
        const warmFrom = new Date(new Date(from + "T00:00:00+05:30").getTime() - warmDays * 86400000)
          .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const intraday = await fetchCandlesCachedBT(NIFTY_INDEX_SYMBOL, String(_resMin()), warmFrom, to, false, (p) => backtestJobs.updateProgress(id, p));
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
        const all = runTrendDayScalpBacktest(intraday);
        const trades = all.trades.filter(t => t.entryTs >= fromTs);
        const days = all.days;
        const stats = computeBacktestStats(trades);
        stats.optionSim = true;
        stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
        stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");

        try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: String(_resMin()) } }); }
        catch (e) { console.warn("[trend-day-scalp-backtest] saveResult failed:", e.message); }

        backtestJobs.completeJob(id, { trades, stats, from, to, meta: { days, skipped: all.skipped, gateStats: all.gateStats } });
        console.log(`✅ TREND_DAY_SCALP Backtest job ${id} complete — ${trades.length} trades over ${days} sessions (gate passed ${all.gateStats.tradeable}/${all.gateStats.decided})`);
      } catch (err) {
        console.error("[trend-day-scalp-backtest] job error:", err);
        backtestJobs.failJob(id, err.message);
      }
    })();
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
// Exposed for offline unit-testing of the entry/exit engine (no Fyers needed).
module.exports.runTrendDayScalpBacktest = runTrendDayScalpBacktest;

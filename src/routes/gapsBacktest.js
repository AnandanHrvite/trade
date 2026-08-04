/**
 * GAPS BACKTEST — /gaps-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest of the GAPS strategy. The ENTRY decision comes from the
 * SAME signal engine the paper route uses (src/strategies/gaps.js) — there is no
 * second copy of the rules here. This file only re-implements the paper route's
 * exits, because paper is canonical:
 *
 *   for each trading day:
 *     yesterday = last CLOSED daily candle before that day  (daily series)
 *     todayOpen = open of the first intraday candle of the day
 *     gapsStrategy.getSignal(daily, todayOpen)  →  BUY_CE / BUY_PE / NONE
 *     exits: gap-size stop (spot) → intraday EMA trail on a CLOSE through it → EOD
 *
 * Option P&L is δ+θ simulated (no historical option chain) — treat ₹ as
 * DIRECTIONAL, not exact. A spread/slippage haircut of GAPS_BT_SLIPPAGE_PTS is
 * applied EACH way, without which a backtest of option BUYING always flatters.
 */

const express = require("express");
const router  = express.Router();
const gapsStrategy = require("../strategies/gaps");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { faviconLink } = require("../utils/sharedNav");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const ACCENT = "#0ea5e9";
const ENDPOINT = "/gaps-backtest";
const RESULT_KEY = "GAPS_BACKTEST";

function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _parseMin(envKey, fallback) {
  const v = String(process.env[envKey] || fallback).trim();
  const [h, m] = v.split(":").map(Number);
  return (h || 0) * 60 + (isNaN(m) ? 0 : m);
}
function _resMin() {
  const v = parseInt(process.env.GAPS_EXIT_TF || "5", 10);
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
 * @param {Array} intraday  GAPS_EXIT_TF-minute spot candles across the range.
 * @param {Array} daily     daily spot candles, INCLUDING enough warmup before the
 *                          range for RSI(len) on the configured source to seed.
 */
function runGapsBacktest(intraday, daily) {
  if (!intraday || !intraday.length || !daily || !daily.length) return { trades: [], days: 0, skipped: [] };

  const cfg = gapsStrategy.getConfig();
  const DELTA        = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE     = instrumentConfig.getLotQty();
  const SEED_PREMIUM = parseFloat(process.env.GAPS_BT_SEED_PREMIUM || "240");
  const SLIPPAGE_PTS = parseFloat(process.env.GAPS_BT_SLIPPAGE_PTS || "1.5");
  const RES          = _resMin();

  const TRAIL_ON        = cfg.trailEnabled;
  const TRAIL_LEN       = cfg.trailLength;
  const ENTRY_START_MIN = _parseMin("GAPS_ENTRY_START", "09:15");
  const ENTRY_END_MIN   = _parseMin("GAPS_ENTRY_END",   "09:30");
  const FORCED_EXIT_MIN = _parseMin("GAPS_FORCED_EXIT", "15:15");

  const sortedIntraday = intraday.slice().sort((a, b) => a.time - b.time);
  const sortedDaily    = daily.slice().sort((a, b) => a.time - b.time);

  // The trailing EMA is computed ONCE over the whole continuous intraday series
  // and looked up per bar. That mirrors Paper exactly: `state.candles` there also
  // spans several days (preloadHistory pulls 5), so the EMA is already warm at
  // the open instead of restarting from scratch every morning. Computing it
  // per-day would make the backtest exit differently from Paper for the first
  // ~TRAIL_LEN bars of every session.
  const trailAt = new Map();
  if (TRAIL_ON) {
    for (const p of gapsStrategy.computeTrailEma(sortedIntraday, TRAIL_LEN).series) trailAt.set(p.time, p.value);
  }

  // Group intraday candles by IST day.
  const byDay = new Map();
  for (const c of sortedIntraday) {
    const k = gapsStrategy._istDayOf(c.time);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(c);
  }

  const trades = [];
  const skipped = [];
  let days = 0;

  for (const [, dayCandles] of byDay) {
    if (!dayCandles.length) continue;
    days++;
    const dayTs = dayCandles[0].time;

    // Entry candle = the first candle inside the entry window.
    const entryBar = dayCandles.find(c => {
      const m = _utcSecToIstMins(c.time);
      return m >= ENTRY_START_MIN && m < ENTRY_END_MIN;
    });
    if (!entryBar) { skipped.push({ date: istDateOf(dayTs), reason: "no candle inside the entry window" }); continue; }

    const snap = gapsStrategy.getPrevDaySnapshot(sortedDaily, dayTs, cfg);
    if (!snap.ok) { skipped.push({ date: istDateOf(dayTs), reason: snap.reason }); continue; }

    const sig = gapsStrategy.getSignal(sortedDaily, entryBar.open, {
      snapshot: snap, sessionDayUnixSec: dayTs, silent: true, cfg,
    });
    if (sig.signal === "NONE" || !sig.side) {
      skipped.push({ date: istDateOf(dayTs), reason: sig.skipReason || sig.reason });
      continue;
    }

    const pos = {
      side: sig.side,
      entryTime: entryBar.time,
      entrySpot: sig.todayOpen,          // fill at the open — that IS the signal price
      optionEntryLtp: SEED_PREMIUM,
      // Same rule as Paper: the stop is the gap SIZE from the fill. The backtest
      // fills at the day's open, so this lands on yesterday's close exactly.
      slPts:  sig.slPts,
      slSpot: gapsStrategy.stopFromFill(sig.side, sig.todayOpen, sig.slPts),
      trailSpot: null,      // filled in as the trail is consulted, for the record
      entryReason: sig.reason,
      prevRsi: sig.prevRsi, prevEma: sig.prevEma, prevClose: sig.prevClose,
      todayRsi: sig.todayRsi, todayEma: sig.todayEma,
      gapPts: sig.gapPts, gapPct: sig.gapPct, gapDir: sig.gapDir,
    };

    function priceExit(exitSpot, exitTime) {
      const barsHeld = Math.max(0, (exitTime - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const spotMove = pos.side === "CE" ? (exitSpot - pos.entrySpot) : (pos.entrySpot - exitSpot);
      const raw = Math.max(0.05, pos.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE);
      const exitPrem = Math.max(0.05, raw - 2 * SLIPPAGE_PTS);   // buy high + sell low
      const charges = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
      return {
        pnl: parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2)),
        exitPrem: parseFloat(exitPrem.toFixed(2)),
        held: Math.round(barsHeld),
      };
    }
    function close(exitSpot, exitTime, reason) {
      const p = priceExit(exitSpot, exitTime);
      trades.push({
        side: pos.side,
        entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitTime),
        entryTs: pos.entryTime, exitTs: exitTime,
        ePrice: pos.entrySpot, xPrice: parseFloat(exitSpot.toFixed(2)),
        sl: pos.slSpot, trailSpot: pos.trailSpot, trailLength: TRAIL_ON ? TRAIL_LEN : null,
        pnl: p.pnl, reason, entryReason: pos.entryReason,
        gapPts: pos.gapPts, gapPct: pos.gapPct, gapDir: pos.gapDir,
        prevRsi: pos.prevRsi, prevEma: pos.prevEma, prevClose: pos.prevClose,
        todayRsi: pos.todayRsi, todayEma: pos.todayEma,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.held,
      });
    }

    // ── Walk the day's candles from the entry bar. Conservative ordering: the
    //    adverse gap-size stop is tested on the bar's high/low BEFORE the trail
    //    is tested on the close, so a bar that touched both books the loss. ──
    let closed = false;
    const startIdx = dayCandles.indexOf(entryBar);
    for (let i = startIdx; i < dayCandles.length && !closed; i++) {
      const c = dayCandles[i];
      const istMin = _utcSecToIstMins(c.time);

      if (istMin >= FORCED_EXIT_MIN) {
        close(c.open, c.time, `EOD square-off (${process.env.GAPS_FORCED_EXIT || "15:15"} IST)`);
        closed = true; break;
      }

      // Gap-size stop. A null/NaN level must never read as a hit (`high >= null`
      // is `high >= 0`), so require a real number first.
      // If the bar OPENED beyond the level the fill is the open
      // (worse than the level) — never assume a better-than-market fill.
      const _slOk = typeof pos.slSpot === "number" && Number.isFinite(pos.slSpot);
      if (_slOk && pos.side === "PE" && c.high >= pos.slSpot) {
        close(c.open > pos.slSpot ? c.open : pos.slSpot, c.time, `Stop hit — ${pos.slPts}pt (the gap) against, at ${pos.slSpot}`);
        closed = true; break;
      }
      if (_slOk && pos.side === "CE" && c.low <= pos.slSpot) {
        close(c.open < pos.slSpot ? c.open : pos.slSpot, c.time, `Stop hit — ${pos.slPts}pt (the gap) against, at ${pos.slSpot}`);
        closed = true; break;
      }

      // Trailing stop on the CLOSE only (mirrors _checkTrailOnClose in paper).
      if (TRAIL_ON) {
        const tv = trailAt.get(c.time);
        if (typeof tv === "number") {
          pos.trailSpot = tv;
          if (gapsStrategy.trailExitHit(pos.side, c.close, tv)) {
            close(c.close, c.time,
              `Trail — ${RES}m candle closed ${pos.side === "PE" ? "above" : "below"} EMA${TRAIL_LEN} ` +
              `(${c.close} ${pos.side === "PE" ? ">" : "<"} ${tv})`);
            closed = true; break;
          }
        }
      }
    }
    if (!closed) {
      const last = dayCandles[dayCandles.length - 1];
      close(last.close, last.time, "EOD (end of day candles)");
    }
  }

  return { trades, days, skipped };
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
  const cfg = gapsStrategy.getConfig();
  const setups = meta.skipped.filter(s => /needs a gap/.test(s.reason || "")).length;
  const html = renderBacktestResults({
    mode: "GAPS",
    accent: ACCENT,
    strategyName: gapsStrategy.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "gapsBacktest",
    extraTradeColumns: [
      { key: "gapPts", label: "Gap (pt)" },
      { key: "todayRsi", label: "RSI (today)" },
      { key: "held", label: "Held" },
    ],
    extraStats: [
      { label: "Profit Factor", value: inf(stats.profitFactor) },
      { label: "Expectancy /trade", value: `₹${stats.expectancy}` },
      { label: "Max Drawdown", value: `₹${stats.maxDrawdown}` },
      { label: "Sessions scanned", value: meta.days },
      { label: "Extreme-RSI days, wrong gap", value: setups },
      { label: "Trade frequency", value: meta.days ? `${((trades.length / meta.days) * 100).toFixed(1)}% of sessions` : "—" },
    ],
    notes: `Entry (from the shared engine, identical to Paper): yesterday's DAILY RSI(${cfg.rsiLength} on ${cfg.rsiSource}) &gt; ${cfg.rsiUpper} with a gap DOWN → BUY PE; &lt; ${cfg.rsiLower} with a gap UP → BUY CE. Entry fills at the day's open inside ${process.env.GAPS_ENTRY_START || "09:15"}–${process.env.GAPS_ENTRY_END || "09:30"}. Exits: base stop = the GAP SIZE in points from the fill — filling at the open, that is yesterday's close exactly (tested on the bar high/low, worse-of open/level fill) → ${cfg.trailEnabled ? `trailing stop on a ${_resMin()}m CLOSE back through the ${_resMin()}m EMA${cfg.trailLength} (PE exits on a close ABOVE, CE on a close BELOW; the EMA spans days so it is warm at the open, exactly as in Paper)` : "trail DISABLED"} → ${process.env.GAPS_FORCED_EXIT || "15:15"} EOD. No fixed target, no breakeven, no time stop. Option premium δ+θ simulated (BACKTEST_DELTA ${DELTA_TXT()}, θ ₹${process.env.BACKTEST_THETA_DAY || "8"}/day) seeded at ₹${process.env.GAPS_BT_SEED_PREMIUM || "240"}, PLUS a spread/slippage haircut of ${process.env.GAPS_BT_SLIPPAGE_PTS || "1.5"}pt EACH way — treat ₹ as directional, not exact. <b>GAPS is a low-frequency strategy: a 30-day range will usually produce very few trades, so widen the range before drawing any conclusion.</b> Use Replay (recorded ticks) for tick-accurate fills.`,
  });
  res.send(html);
}
function DELTA_TXT() { return process.env.BACKTEST_DELTA || "0.55"; }

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  if (!from || !to) {
    const today = new Date();
    const def = new Date(); def.setDate(today.getDate() - 180);   // GAPS is rare — default to a wide window
    const fmt = d => d.toISOString().slice(0, 10);
    return res.redirect(`${ENDPOINT}?from=${fmt(def)}&to=${fmt(today)}`);
  }

  const jobId = req.query.jobId;
  if (!jobId) {
    const activeJob = backtestJobs.getActiveJob();
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "GAPS Backtest"));
    const { id } = backtestJobs.createJob("gaps");
    (async () => {
      try {
        console.log(`🔍 GAPS Backtest job ${id}: ${from} → ${to}`);
        backtestJobs.updateProgress(id, { phase: "Fetching intraday candles…", pct: 0 });
        const intraday = await fetchCandlesCachedBT(NIFTY_INDEX_SYMBOL, String(_resMin()), from, to, false, (p) => backtestJobs.updateProgress(id, p));
        if (!Array.isArray(intraday) || intraday.length < 5) {
          const n = Array.isArray(intraday) ? intraday.length : 0;
          backtestJobs.failJob(id, n === 0
            ? `Fyers returned no historical candles for ${from} → ${to}. Most often the Fyers session needs re-login — an expired token returns no data (not an auth error). Log in to Fyers again, then retry.`
            : `Only ${n} candle(s) for ${from} → ${to} — widen the range.`);
          return;
        }

        // Daily history needs a warmup runway BEFORE `from` so RSI-on-EMA is
        // already seeded on the very first day of the range. Baseline is the same
        // convention as the other backtests (emaRsiSt / ema9vwap): 150 calendar
        // days, measured in IST — ~103 sessions, ample for the ~35 closed bars
        // RSI(14)-on-EMA21 needs. But GAPS's requirement scales with the configured
        // lengths (Settings allows EMA up to 200 / RSI up to 100), so a fixed 150
        // would silently under-fetch there: grow the runway with needDaily at ~1.5
        // calendar days per session plus a holiday buffer. Wide ranges are safe
        // because fetchCandles now chunks daily at the Fyers 366-day cap.
        backtestJobs.updateProgress(id, { phase: "Fetching daily candles (indicator warmup)…", pct: 40 });
        const cfg = gapsStrategy.getConfig();
        const needDaily = cfg.rsiLength + (cfg.rsiSource === "ema" ? cfg.emaLength - 1 : 0) + 1;
        const _warmupDays = Math.max(150, Math.ceil(needDaily * 1.5) + 30);
        const warmFrom = new Date(new Date(from + "T00:00:00+05:30").getTime() - _warmupDays * 86400000)
          .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const daily = await fetchCandlesCachedBT(NIFTY_INDEX_SYMBOL, "D", warmFrom, to, false);
        if (!Array.isArray(daily) || daily.length < needDaily) {
          backtestJobs.failJob(id, `Only ${Array.isArray(daily) ? daily.length : 0} daily candle(s) — GAPS needs at least ${needDaily} for RSI(${cfg.rsiLength}) on ${cfg.rsiSource}. Re-login to Fyers or widen the range.`);
          return;
        }

        backtestJobs.updateProgress(id, { phase: `Running GAPS backtest (${intraday.length.toLocaleString()} intraday / ${daily.length} daily candles)…`, pct: 70 });
        const { trades, days, skipped } = runGapsBacktest(intraday, daily);
        const stats = computeBacktestStats(trades);
        stats.optionSim = true;
        stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
        stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");

        try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: String(_resMin()) } }); }
        catch (e) { console.warn("[gaps-backtest] saveResult failed:", e.message); }

        backtestJobs.completeJob(id, { trades, stats, from, to, meta: { days, skipped } });
        console.log(`✅ GAPS Backtest job ${id} complete — ${trades.length} trades over ${days} sessions`);
      } catch (err) {
        console.error("[gaps-backtest] job error:", err);
        backtestJobs.failJob(id, err.message);
      }
    })();
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "GAPS Backtest"));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "GAPS Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));
  const { trades, stats, meta } = job.result;
  return _renderResults(res, from, to, trades, stats, meta || { days: 0, skipped: [] });
});

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>GAPS Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>GAPS Backtest Failed</h2><p>${msg}</p><p><b>${from || ""}</b> → <b>${to || ""}</b></p><a href="${ENDPOINT}">← Back</a></body></html>`;
}

module.exports = router;
// Exposed for offline unit-testing of the entry/exit engine (no Fyers needed).
module.exports.runGapsBacktest = runGapsBacktest;

/**
 * HA SCALP BACKTEST — /ha-scalp-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest on 15-minute **NIFTY 50 INDEX spot** candles. Every rule —
 * the Heikin Ashi construction, the 50-MA trend gate, the no-wick entry candle,
 * the frozen raw stop level and the doji / weak-candle exits — comes from the
 * SAME engine the paper route uses (src/strategies/ha_scalp.js). There is no
 * second copy of the maths here: this file fetches candles, walks bars, and
 * calls the engine.
 *
 *   for each closed 15-min spot bar:
 *     getSignal(bars up to here, { ha, ma })   → BUY_CE / BUY_PE / NONE
 *   fill: the NEXT raw bar's OPEN (the signal fires on a closed bar)
 *   exits: stop (frozen raw level) → candle exit (doji/weak/opposite) → EOD
 *
 * ONE INSTRUMENT. Unlike the futures strategies there is no contract roll and no
 * second symbol: NSE:NIFTY50-INDEX is perpetual, so the whole range is one fetch
 * through the month-granular disk cache. There is also NO volume test anywhere
 * in this engine, so the index's absent/unreliable volume is irrelevant.
 *
 * WARM-UP RUNWAY. The engine refuses to decide until it has
 * max(HA_SCALP_MA_PERIOD, HA_SCALP_HA_WARMUP_BARS) + 1 bars behind it (51 at the
 * defaults) — the 50 MA needs its period and the recursive Heikin Ashi haOpen
 * needs its seed to decay. At ~25 bars per 15-minute session that is more than
 * two full days, so the requested range is fetched with
 * HA_SCALP_WARMUP_DAYS (default 15) calendar days of runway PREPENDED, and only
 * bars inside the requested range may open a trade. Without the runway the first
 * two sessions of every run would be silently mute.
 *
 * CONSERVATIVE INTRA-BAR ORDERING (this is where naive backtests lie):
 *   • the adverse STOP is tested on the bar's low (CE) / high (PE) BEFORE the
 *     favourable close-based candle exit, so a bar that did both books the LOSS;
 *   • a bar that OPENED beyond the stop fills at the OPEN, never at the better
 *     stop level — no assuming a fill the market never offered;
 *   • the signal candle itself can never exit the trade (the fill happens on the
 *     bar AFTER it), so exits are only ever read from bars past signalBarTime.
 *
 * There is NO TARGET on this engine — do not add one here. There is also no
 * trail, no breakeven and no premium stop; the trade runs to the stop, a doji, a
 * weak candle, or the square-off.
 *
 * There is NO historical option chain, so premium is δ+θ simulated. Treat ₹ as
 * DIRECTIONAL, not exact. A spread/slippage haircut of HA_SCALP_BT_SLIPPAGE_PTS
 * is applied EACH way — without it a backtest of option BUYING always flatters.
 */

const express = require("express");
const router  = express.Router();
const haStrategy = require("../strategies/ha_scalp");
// fetchCandlesCachedBT (NOT the raw fetchCandles the futures pages use). The
// cached variant rewrites the requested range into WHOLE calendar months before
// calling Fyers, which is harmless — and a large win — for a PERPETUAL index
// symbol. NSE:NIFTY50-INDEX is never delisted and has no expiry to run past, so
// the widened range is always servable and the disk cache pays for itself across
// repeated runs.
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { fyersErrText } = require("../utils/fyersErr");
const { faviconLink } = require("../utils/sharedNav");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");

const ACCENT = "#f59e0b";
const ENDPOINT = "/ha-scalp-backtest";
const RESULT_KEY = "HA_SCALP_BACKTEST";
const LOG = "[HA-SCALP-BACKTEST]";
const SPOT_SYMBOL = "NSE:NIFTY50-INDEX";

function _resMin() { return haStrategy.getConfig().resolutionMins; }

function istDateOf(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function istHHMMSS(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
function entryTsStr(unixSec) { return `${istDateOf(unixSec)}, ${istHHMMSS(unixSec)}`; }

/** Escape text that came from an external API before it lands in the notes HTML. */
function escHtml(x) {
  return String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Warm-up runway ───────────────────────────────────────────────────────────
/**
 * How many calendar days of history to prepend to the requested range so the
 * FIRST requested session can already trade. Calendar days, not sessions: the
 * fetch window is a date range and holidays/weekends inside it simply return no
 * bars, so the default is generous (15 → ~10 sessions → ~250 bars, five times
 * the 51 the engine needs).
 */
function _warmupDays() {
  const v = parseInt(process.env.HA_SCALP_WARMUP_DAYS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 15;
}

/** "YYYY-MM-DD" shifted back by `days` calendar days. */
function shiftDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * The fetch range for a requested [from, to]: `from` pulled back by the warm-up
 * runway, `to` untouched. Exposed for tests — the runway is the one thing that
 * silently decides whether day one of a run can trade at all.
 */
function warmupRange(from, to) {
  return { fetchFrom: shiftDateStr(from, _warmupDays()), fetchTo: to, warmupDays: _warmupDays() };
}

// ── The backtest ─────────────────────────────────────────────────────────────
/**
 * @param {Array}  intraday HA_SCALP_RESOLUTION-minute NIFTY 50 INDEX spot
 *        candles, ascending, INCLUDING the warm-up runway before `rangeFrom`.
 * @param {string} rangeFrom "YYYY-MM-DD" IST — the first day a TRADE may open.
 *        Bars before it are warm-up only: they feed the Heikin Ashi chain and
 *        the MA, and are never entered on.
 *
 * Heikin Ashi and the MA are computed ONCE over the whole array and passed into
 * every getSignal call. That is not only cheaper — haOpen is recursive, so
 * recomputing it from a truncated slice each bar would give a different (more
 * seed-contaminated) series than the chart shows, and the decision and the chart
 * must agree.
 */
function runHaScalpBacktest(intraday, rangeFrom) {
  const empty = {
    trades: [], days: 0, skipped: [],
    funnel: { barsSeen: 0, warmupBars: 0, tradableBars: 0, setups: 0, entries: 0, trendUp: 0, trendDown: 0, trendFlat: 0 },
    skipReasons: {}, exitReasons: {},
  };
  if (!intraday || !intraday.length) return empty;

  const cfg = haStrategy.getConfig();
  // FUTURES MODE — index points are rupees 1:1: no delta, no theta, and the
  // "premium" the sim carries IS the spot level (see instrumentMode.js).
  const IS_FUT       = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const DELTA        = IS_FUT ? 1.0 : parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = IS_FUT ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE     = instrumentConfig.getLotQty();
  const SEED_PREMIUM = parseFloat(process.env.HA_SCALP_BT_SEED_PREMIUM || "240");
  // In futures the entry "premium" is the entry SPOT — seeded per trade below.
  const SLIPPAGE_PTS = parseFloat(process.env.HA_SCALP_BT_SLIPPAGE_PTS || "1.5");
  const RES          = cfg.resolutionMins;

  const MAX_TRADES      = Math.max(1, parseInt(process.env.HA_SCALP_MAX_DAILY_TRADES || "3", 10) || 3);
  const FORCED_EXIT_RAW = process.env.HA_SCALP_FORCED_EXIT || "15:15";
  const FORCED_EXIT_MIN = haStrategy._parseHHMM(FORCED_EXIT_RAW, 15 * 60 + 15);

  // The engine's own warm-up requirement, restated here only so the log can say
  // WHY a day was mute. The decision itself stays inside getSignal().
  const MIN_BARS = Math.max(cfg.maPeriod, cfg.haWarmupBars) + 1;

  const sorted = intraday.slice().sort((a, b) => a.time - b.time);

  // ONE HA series and ONE MA series over the whole array, index-aligned to it.
  const haAll = haStrategy.toHeikinAshi(sorted, { cfg });
  const maAll = haStrategy.computeMA(sorted, { cfg });

  // Group by IST day, keeping the global index of every bar so a day's slice can
  // still be evaluated against the FULL history behind it (the HA chain and the
  // MA both reach back across the day boundary — HA_SCALP_HA_CONTINUOUS is the
  // engine's default and matches TradingView).
  const dayKeys = [];
  const byDay = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const k = haStrategy._istDayOf(sorted[i].time);
    if (!byDay.has(k)) { byDay.set(k, []); dayKeys.push(k); }
    byDay.get(k).push(i);
  }

  const trades = [];
  const skipped = [];
  const skipReasons = {};   // first-line skip reason → count (diagnostic only)
  const exitReasons = {};   // engine exit reason code → count
  const funnel = { barsSeen: 0, warmupBars: 0, tradableBars: 0, setups: 0, entries: 0, trendUp: 0, trendDown: 0, trendFlat: 0 };
  let days = 0;

  for (const k of dayKeys) {
    const idxs = byDay.get(k);
    if (!idxs || !idxs.length) continue;
    const dayTs = sorted[idxs[0]].time;
    const dayStr = haStrategy._istDateStr(dayTs);

    // Warm-up days are fed to the series above but never traded.
    if (rangeFrom && dayStr < rangeFrom) {
      funnel.warmupBars += idxs.length;
      continue;
    }
    days++;

    let dayTrades = 0, daySetups = 0, dayEntries = 0, dayWarmupBars = 0;
    let dayTrendUp = 0, dayTrendDown = 0;
    let pos = null;
    let pendingEntry = null;   // signal fired on a closed bar → fill on the NEXT bar's open
    const dayExits = [];
    let firstSkip = null;

    function priceAt(exitPx, exitTime) {
      const barsHeld = Math.max(0, (exitTime - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const move = pos.side === "CE" ? (exitPx - pos.entrySpot) : (pos.entrySpot - exitPx);
      const raw = Math.max(0.05, pos.optionEntryLtp + move * DELTA - thetaCost / LOT_SIZE);
      const exitPrem = Math.max(0.05, raw - 2 * SLIPPAGE_PTS);   // buy high + sell low
      const charges = getCharges({ broker: "fyers", isFutures: IS_FUT, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
      return {
        pnl: parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2)),
        exitPrem: parseFloat(exitPrem.toFixed(2)),
        held: Math.round(barsHeld),
      };
    }

    function close(exitPx, exitTime, reason, reasonCode) {
      const p = priceAt(exitPx, exitTime);
      exitReasons[reasonCode] = (exitReasons[reasonCode] || 0) + 1;
      dayExits.push(`${istHHMMSS(exitTime)} ${pos.side} → ${reasonCode} @ ${parseFloat(exitPx.toFixed(2))} (${p.held} bar(s), ₹${p.pnl})`);
      trades.push({
        side: pos.side,
        entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitTime),
        entryTs: pos.entryTime, exitTs: exitTime,
        ePrice: pos.entrySpot, xPrice: parseFloat(exitPx.toFixed(2)),
        sl: pos.slSpot, target: null,
        riskPts: pos.slPts,
        trend: pos.trend, ma: pos.ma, maType: pos.maType,
        bodyPct: pos.bodyPct, wickPct: pos.wickPct,
        haOpen: pos.haOpen, haClose: pos.haClose,
        signalClose: pos.signalClose, signalBarTime: pos.signalBarTime,
        exitCode: reasonCode,
        pnl: p.pnl, reason, entryReason: pos.entryReason,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.held,
      });
      pos = null;
    }

    for (let j = 0; j < idxs.length; j++) {
      const gi = idxs[j];
      const c = sorted[gi];
      const istMin = haStrategy._utcSecToIstMins(c.time);
      funnel.barsSeen++;

      // ── 1. Fill a pending entry at THIS bar's OPEN. The signal fired on the
      //    previous closed bar; the next thing the market prints is this open.
      //    The fill happens before any exit test, so a trade always exists for
      //    at least the bar it was filled on. ───────────────────────────────────
      if (pendingEntry && !pos) {
        const sig = pendingEntry;
        pendingEntry = null;
        if (typeof c.open === "number" && Number.isFinite(c.open)) {
          // A gap through the frozen stop between the signal close and this open
          // is a real event: the trade is filled and immediately stopped below,
          // at the open. Nothing is skipped to flatter the result.
          pos = {
            side: sig.side,
            entryTime: c.time,
            entrySpot: parseFloat(c.open.toFixed(2)),   // NEXT candle's OPEN — the rule
            optionEntryLtp: IS_FUT ? parseFloat(c.open.toFixed(2)) : SEED_PREMIUM,
            slSpot: sig.slSpot,
            // Risk is restated against the ACTUAL fill, not the signal close —
            // the signal's own slPts was measured from a price we did not get.
            slPts: parseFloat(Math.abs(c.open - sig.slSpot).toFixed(2)),
            trend: sig.trend, ma: sig.ma, maType: sig.maType,
            bodyPct: sig.bodyPct,
            wickPct: sig.side === "CE" ? sig.lowerWickPct : sig.upperWickPct,
            haOpen: sig.haOpen, haClose: sig.haClose,
            signalClose: sig.entrySpot, signalBarTime: sig.signalBarTime,
            entryReason: sig.reason,
          };
          dayTrades++; dayEntries++; funnel.entries++;
          console.log(`${LOG} ${dayStr} ${istHHMMSS(c.time)} ENTER ${pos.side} @ ${pos.entrySpot} (next-bar open) | trend ${pos.trend} vs ${pos.maType.toUpperCase()}${cfg.maPeriod} ${pos.ma} | HA body ${pos.bodyPct}% wick ${pos.wickPct}% | SL ${pos.slSpot} (${pos.slPts}pt)`);
        } else {
          console.log(`${LOG} ${dayStr} ${istHHMMSS(c.time)} entry DROPPED — the next bar has no usable open, refusing to invent a fill`);
        }
      }

      // ── 2. Manage an open position on THIS bar. ────────────────────────────
      if (pos) {
        if (istMin >= FORCED_EXIT_MIN) {
          close(c.open, c.time, `EOD square-off (${FORCED_EXIT_RAW} IST) — position carried to the cut-off`, "EOD");
        } else {
          const isCE = pos.side === "CE";
          // The stop is tested on the bar's ADVERSE extreme, and BEFORE the
          // close-based candle exit — a bar that took the stop out and then
          // closed as a doji books the loss, not the doji.
          const stopTouched = haStrategy.stopHit(pos.side, isCE ? c.low : c.high, pos.slSpot);
          if (stopTouched) {
            // Worse-of open/level fill; a bar that opened through the stop fills
            // at the open, never at the better stop level.
            const fill = isCE
              ? (c.open < pos.slSpot ? c.open : pos.slSpot)
              : (c.open > pos.slSpot ? c.open : pos.slSpot);
            close(fill, c.time, `Stop hit — signal candle's raw ${isCE ? "low" : "high"} ${pos.slSpot} taken out (${pos.slPts}pt against)`, "STOP");
          } else if (c.time > pos.signalBarTime) {
            // Candle exit, on this CLOSED bar's HA candle. The `>` guard is what
            // stops the SIGNAL candle from exiting the trade it just opened —
            // it is by construction a strong with-trend candle, but a later
            // re-read of it would still be wrong.
            const ex = haStrategy.exitSignal(pos.side, haAll[gi], { cfg });
            if (ex) close(c.close, c.time, `${ex.label} — ${ex.detail}`, ex.reason);
          }
        }
      }

      // ── 3. Look for a new signal on this bar's CLOSE. ──────────────────────
      if (!pos && !pendingEntry) {
        const alreadyTraded = dayTrades >= MAX_TRADES;
        const sig = haStrategy.getSignal(sorted.slice(0, gi + 1), {
          cfg, silent: true, alreadyTraded, ha: haAll.slice(0, gi + 1), ma: maAll.slice(0, gi + 1),
        });
        if (sig.warmup) { dayWarmupBars++; }
        else {
          funnel.tradableBars++;
          if (sig.trend === "UP") { dayTrendUp++; funnel.trendUp++; }
          else if (sig.trend === "DOWN") { dayTrendDown++; funnel.trendDown++; }
          else if (sig.trend === "FLAT") funnel.trendFlat++;
        }
        if (sig.signal === "NONE" || !sig.side) {
          if (sig.skipReason) {
            // Bucket by the reason's leading phrase so the tally stays readable
            // — the full string carries live prices and would never repeat.
            const bucket = String(sig.skipReason).split("(")[0].trim().slice(0, 80);
            skipReasons[bucket] = (skipReasons[bucket] || 0) + 1;
            if (!firstSkip && !sig.warmup) firstSkip = sig.skipReason;
          }
          continue;
        }
        // A valid setup. It only becomes a trade if a NEXT bar exists to fill on.
        daySetups++; funnel.setups++;
        console.log(`${LOG} ${dayStr} ${istHHMMSS(c.time)} SETUP ${sig.side} — ${sig.reason}`);
        if (j === idxs.length - 1) {
          console.log(`${LOG} ${dayStr} ${istHHMMSS(c.time)} setup NOT taken — it is the day's last bar, there is no next candle to open on`);
        } else {
          pendingEntry = sig;
        }
      }
    }

    // A position still open at the last bar of the day is squared off there. The
    // forced-exit test above only fires on a bar that actually printed at or
    // after the cut-off; a short session would otherwise carry overnight.
    if (pos) {
      const last = sorted[idxs[idxs.length - 1]];
      close(last.close, last.time, "EOD (last candle of the session) — no cut-off bar printed", "EOD");
    }
    pendingEntry = null;

    funnel.warmupBars += dayWarmupBars;
    const trendMix = dayWarmupBars >= idxs.length
      ? `WARM-UP (${dayWarmupBars}/${idxs.length} bars still short of the ${MIN_BARS} the ${cfg.maPeriod} ${cfg.maType.toUpperCase()} + HA chain need)`
      : `trend UP ${dayTrendUp} / DOWN ${dayTrendDown} bar(s)`;
    console.log(`${LOG} ${dayStr}: ${idxs.length} bars | ${trendMix} | ${daySetups} setup(s) | ${dayEntries} entr${dayEntries === 1 ? "y" : "ies"}${dayExits.length ? ` | exits: ${dayExits.join("; ")}` : " | no exits"}`);

    if (!dayEntries) {
      skipped.push({
        date: istDateOf(dayTs),
        reason: dayWarmupBars >= idxs.length
          ? `still warming up — the ${cfg.maPeriod} ${cfg.maType.toUpperCase()} and the Heikin Ashi chain need ${MIN_BARS} bars`
          : daySetups
            ? "setup found but no next candle to fill on"
            : (firstSkip || "no no-wick Heikin Ashi candle in the trend's direction all session"),
      });
    }
  }

  return { trades, days, skipped, funnel, skipReasons, exitReasons };
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

router.get("/result", (req, res) => {
  const jobId = req.query.jobId;
  const job = jobId ? backtestJobs.getJob(jobId) : null;
  if (!job) return res.status(404).json({ error: "not_found" });
  if (job.status !== "done") return res.json({ status: job.status, error: job.error || null });
  const { trades, stats, from, to, meta } = job.result;
  return res.json({ status: "done", from, to, stats, meta, trades });
});

/**
 * Mobile CSS for the results page. renderBacktestResults() already collapses its
 * stat grid and drops the sidebar margin under 768px, but the HA-specific notes
 * block and the wider trades table still need a ~440px pass: nothing may force
 * the page body to scroll sideways, so the table scrolls inside its own box.
 */
const MOBILE_CSS = `<style>
@media(max-width:640px){
  html,body{max-width:100%;overflow-x:hidden;}
  .main-content{padding-left:10px;padding-right:10px;}
  /* Any table on this page scrolls inside its own container, never the page. */
  table{min-width:640px;}
  .table-wrap,.trades-wrap,.tbl-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
  /* Retro-fit a scroll container onto tables the shared renderer emitted bare. */
  table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:nowrap;}
  a,button,select,input{min-height:44px;}
  body{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);}
}
</style>`;

function _renderResults(res, from, to, trades, stats, meta) {
  const inf = (x) => x === Infinity ? "∞" : x;
  const cfg = haStrategy.getConfig();
  const f = meta.funnel || { barsSeen: 0, warmupBars: 0, tradableBars: 0, setups: 0, entries: 0, trendUp: 0, trendDown: 0, trendFlat: 0 };
  const xr = meta.exitReasons || {};
  const exitMix = Object.keys(xr).length
    ? Object.entries(xr).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")
    : "—";

  const html = renderBacktestResults({
    mode: "HA_SCALP",
    accent: ACCENT,
    strategyName: haStrategy.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "haScalpBacktest",
    extraTradeColumns: [
      { key: "trend", label: "Trend" },
      { key: "ma", label: `MA${cfg.maPeriod}` },
      { key: "bodyPct", label: "HA body %" },
      { key: "wickPct", label: "Wick %" },
      { key: "riskPts", label: "Risk (pt)" },
      { key: "exitCode", label: "Exit" },
      { key: "held", label: "Held" },
    ],
    extraStats: [
      { label: "Profit Factor", value: inf(stats.profitFactor) },
      { label: "Expectancy /trade", value: `₹${stats.expectancy}` },
      { label: "Max Drawdown", value: `₹${stats.maxDrawdown}` },
      { label: "Sessions scanned", value: meta.days },
      { label: "Bars decided on", value: f.tradableBars },
      { label: "Warm-up bars skipped", value: f.warmupBars },
      { label: "Trend UP / DOWN bars", value: `${f.trendUp} / ${f.trendDown}` },
      { label: "No-wick setups found", value: f.setups },
      { label: "Setups filled", value: f.entries },
      { label: "Exit mix", value: exitMix },
      { label: "Trade frequency", value: meta.days ? `${((trades.length / meta.days) * 100).toFixed(1)}% of sessions` : "—" },
    ],
    notes: `${instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" ? "FUTURES MODE — P&L is index points × lot with futures charges, no δ/θ and no premium stop (they have no meaning without a premium); a PE is a SHORT. " : ""}<b>Chart:</b> NIFTY 50 <b>INDEX spot</b> (<code>${escHtml(SPOT_SYMBOL)}</code>) ${cfg.resolutionMins}-min — not futures, and no volume is read anywhere in this strategy. Heikin Ashi is built ${cfg.haContinuous ? "CONTINUOUSLY across days (TradingView's own behaviour)" : "reseeded each IST day"}. <b>Warm-up:</b> ${escHtml(String(meta.warmupDays))} calendar day(s) of history were fetched BEFORE ${escHtml(from)} so the first requested session could already decide — the engine refuses to signal until it holds ${Math.max(cfg.maPeriod, cfg.haWarmupBars) + 1} bars (the ${cfg.maPeriod} ${cfg.maType.toUpperCase()} plus the recursive HA seed decay); those runway bars never open a trade. <b>Trend gate:</b> raw close above the ${cfg.maPeriod} ${cfg.maType.toUpperCase()} → CE only, below → PE only. A with-trend candle on the wrong side of the MA is skipped on purpose. <b>Entry candle:</b> a Heikin Ashi candle of the trend's colour with NO ${cfg.maxWickPct > 0 ? `wick beyond ${cfg.maxWickPct}% of its range` : "wick at all (exact zero — strict by the user's choice, so low frequency is expected)"} on the trend side, body ≥ ${cfg.minBodyPts}pt. <b>Fill:</b> the NEXT raw candle's OPEN — the signal fires on a closed bar and is filled on the bar that follows, which is what Paper and Live do on the first tick after the close. <b>Stop:</b> the signal candle's RAW ${cfg.slBufferPts ? `low−${cfg.slBufferPts}pt / high+${cfg.slBufferPts}pt` : "low / high"}, frozen at entry and never moved. <b>There is NO target</b>, no trail, no breakeven and no premium stop — the trade runs to the stop, a doji (HA body ≤ ${cfg.dojiBodyPct}% of range${cfg.exitOnDoji ? "" : ", currently OFF"}), a weak/opposite candle (body &lt; ${cfg.weakBodyPct}%${cfg.exitOnWeak ? "" : ", currently OFF"}), or the ${escHtml(process.env.HA_SCALP_FORCED_EXIT || "15:15")} square-off. Max ${escHtml(process.env.HA_SCALP_MAX_DAILY_TRADES || "3")} trades/day; the entry window is ${haStrategy._fmtMins(cfg.entryStartMin)}–${haStrategy._fmtMins(cfg.entryEndMin)}. Optional SL cap ${cfg.maxSlPts > 0 ? `<b>ON</b> at ${cfg.maxSlPts}pt` : "is OFF (default)"}. <b>Intra-bar ordering is conservative:</b> the stop is tested on the bar low/high BEFORE the candle exit is read on its close, so a bar doing both books the loss, and a bar that opened beyond the stop fills at the open. Option premium is δ+θ simulated (BACKTEST_DELTA ${escHtml(process.env.BACKTEST_DELTA || "0.55")}, θ ₹${escHtml(process.env.BACKTEST_THETA_DAY || "8")}/day) seeded at ₹${escHtml(process.env.HA_SCALP_BT_SEED_PREMIUM || "240")}, PLUS ${escHtml(process.env.HA_SCALP_BT_SLIPPAGE_PTS || "1.5")}pt slippage EACH way — treat ₹ as directional, not exact. <b>This strategy has NEVER traded live or on paper. Nothing here is validated, and the no-wick frequency has never been measured.</b>`,
  });
  // Appended, so the shared renderer's own responsive rules load first and these
  // ~440px overrides win.
  res.send(html.replace("</body>", `${MOBILE_CSS}</body>`));
}

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  if (!from || !to) {
    // Repo-standard 90-day default. NSE:NIFTY50-INDEX is perpetual — unlike the
    // futures pages there is no delisted contract to avoid, so the widest useful
    // default is simply the last 90 days.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    return res.redirect(`${ENDPOINT}?from=${shiftDateStr(today, 90)}&to=${today}`);
  }

  const jobId = req.query.jobId;
  if (!jobId) {
    const activeJob = backtestJobs.getActiveJob();
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "HA Scalp Backtest"));
    const { id } = backtestJobs.createJob("ha_scalp");
    (async () => {
      try {
        const cfg = haStrategy.getConfig();
        const minBars = Math.max(cfg.maPeriod, cfg.haWarmupBars) + 1;
        const { fetchFrom, fetchTo, warmupDays } = warmupRange(from, to);
        console.log(`${LOG} job ${id}: ${from} → ${to} (fetching from ${fetchFrom} — ${warmupDays} warm-up day(s) so day one already holds the ${minBars} bars the ${cfg.maPeriod} ${cfg.maType.toUpperCase()} + Heikin Ashi chain need)`);

        backtestJobs.updateProgress(id, { phase: `Fetching ${SPOT_SYMBOL} ${cfg.resolutionMins}-min candles (${fetchFrom} → ${fetchTo})…`, pct: 10 });
        let intraday;
        try {
          intraday = await fetchCandlesCachedBT(SPOT_SYMBOL, String(cfg.resolutionMins), fetchFrom, fetchTo, false,
            (p) => backtestJobs.updateProgress(id, { phase: p && p.phase ? p.phase : `Fetching ${SPOT_SYMBOL}…`, pct: Math.min(65, 10 + Math.round((p && p.pct ? p.pct : 0) * 0.55)) }));
        } catch (err) {
          const msg = fyersErrText(err);
          console.warn(`${LOG} fetch refused: ${msg.slice(0, 300)}`);
          backtestJobs.failJob(id,
            `Fyers refused the ${SPOT_SYMBOL} history request for ${fetchFrom} → ${fetchTo}: ${msg.slice(0, 200)}. ` +
            `That wording is Fyers' own. "Could not authenticate the user" means the Fyers session needs re-login.`);
          return;
        }
        intraday = Array.isArray(intraday) ? intraday.slice().sort((a, b) => a.time - b.time) : [];

        if (intraday.length < minBars) {
          // The overwhelmingly common cause in this repo is a dead Fyers token:
          // an expired session returns no_data (zero candles), NOT an auth error.
          backtestJobs.failJob(id, intraday.length === 0
            ? `Fyers returned no historical candles for ${SPOT_SYMBOL} ${fetchFrom} → ${fetchTo}. Most often the Fyers session needs re-login — an expired token returns no data rather than an auth error. Log in to Fyers again, then retry.`
            : `Only ${intraday.length} ${cfg.resolutionMins}-min candle(s) for ${fetchFrom} → ${fetchTo}, and this engine cannot decide anything until it holds ${minBars} (the ${cfg.maPeriod} ${cfg.maType.toUpperCase()} plus the Heikin Ashi warm-up). Widen the range or raise HA_SCALP_WARMUP_DAYS (currently ${warmupDays}).`);
          return;
        }
        console.log(`${LOG} job ${id}: ${intraday.length.toLocaleString()} ${cfg.resolutionMins}-min spot candles fetched (warm-up included)`);

        backtestJobs.updateProgress(id, { phase: `Running HA Scalp backtest (${intraday.length.toLocaleString()} spot candles)…`, pct: 75 });
        const result = runHaScalpBacktest(intraday, from);
        const stats = computeBacktestStats(result.trades);
        stats.optionSim = true;
        stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
        stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");

        try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: String(cfg.resolutionMins) } }); }
        catch (e) { console.warn(`${LOG} saveResult failed:`, e.message); }

        const topSkips = Object.entries(result.skipReasons).sort((a, b) => b[1] - a[1]).slice(0, 5);
        console.log(`${LOG} funnel: ${result.funnel.barsSeen} bars seen | ${result.funnel.warmupBars} warm-up | ${result.funnel.tradableBars} decided | trend UP ${result.funnel.trendUp} / DOWN ${result.funnel.trendDown} / FLAT ${result.funnel.trendFlat} | ${result.funnel.setups} setup(s) → ${result.funnel.entries} entr${result.funnel.entries === 1 ? "y" : "ies"}`);
        if (topSkips.length) console.log(`${LOG} top skip reasons: ${topSkips.map(([k, v]) => `${v}× ${k}`).join(" | ")}`);
        const exitMix = Object.entries(result.exitReasons).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
        console.log(`${LOG} exits: ${exitMix}`);

        backtestJobs.completeJob(id, {
          trades: result.trades, stats, from, to,
          meta: {
            days: result.days, skipped: result.skipped, funnel: result.funnel,
            skipReasons: result.skipReasons, exitReasons: result.exitReasons,
            warmupDays, fetchFrom, candles: intraday.length,
          },
        });
        console.log(`${LOG} job ${id} complete — ${result.trades.length} trades over ${result.days} sessions (${result.funnel.setups} no-wick setups seen)`);
      } catch (err) {
        console.error(`${LOG} job error:`, err);
        backtestJobs.failJob(id, err.message);
      }
    })();
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "HA Scalp Backtest"));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "HA Scalp Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));
  const { trades, stats, meta } = job.result;
  return _renderResults(res, from, to, trades, stats, meta || { days: 0, skipped: [], funnel: {}, exitReasons: {}, warmupDays: _warmupDays() });
});

function _errLightAttr() {
  return require("../utils/theme").resolveTheme() === "light" ? ' data-theme="light"' : "";
}

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html${_errLightAttr()}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>HA Scalp — Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;}
:root[data-theme="light"] body{background:#f4f6f9;color:#334155;}
:root[data-theme="light"] h2{color:#b91c1c;}
:root[data-theme="light"] a{border-color:#e0e4ea;background:#ffffff;color:#b45309;}
@media(max-width:768px){body{padding:24px 14px;}a{min-height:44px;display:inline-flex;align-items:center;justify-content:center;}}
@media(max-width:640px){html,body{max-width:100%;overflow-x:hidden;}p{word-break:break-word;}}</style>
</head><body><h2>HA Scalp Backtest Failed</h2><p>${escHtml(msg)}</p><p><b>${escHtml(from || "")}</b> → <b>${escHtml(to || "")}</b></p><a href="${ENDPOINT}">← Back</a></body></html>`;
}

module.exports = router;
// Exposed for offline unit-testing of the entry/exit engine (no Fyers needed).
module.exports.runHaScalpBacktest = runHaScalpBacktest;
module.exports.warmupRange = warmupRange;
module.exports.shiftDateStr = shiftDateStr;

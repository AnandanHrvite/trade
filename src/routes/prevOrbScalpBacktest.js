/**
 * PREV ORB SCALP BACKTEST — /prev-orb-scalp-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest on 3-minute NIFTY 50 INDEX spot candles. The setup (09:15
 * 15-min candle vs yesterday's high/low), the first-break entry, the stop, the
 * target and the post-target trail all come from the SAME engine the paper
 * route uses (src/strategies/prev_orb_scalp.js). This file only walks bars and
 * re-implements paper's EXIT ORDER on bar data.
 *
 *   for each closed bar (only until the day's question is settled):
 *     getSignal(yesterday + today up to this bar)  → BUY_CE / BUY_PE / NONE
 *   fill: the NEXT bar's OPEN (paper fills on the first tick after the close)
 *   exits per bar: EOD → adverse test (stop, or the profit-lock floor if armed,
 *                  whichever is tighter) → favourable test (target) → trail
 *
 * CONSERVATIVE INTRA-BAR ORDERING:
 *   • the adverse level is tested on the bar's high (PE) / low (CE) BEFORE the
 *     favourable target, so a bar that did both books the loss;
 *   • a bar that OPENED beyond a level fills at the open, never the level;
 *   • a bar that reaches the target and then closes back through the new
 *     (target) stop exits at the target level — paper's tick would do the same.
 *   • a fill whose open is already through the stop is ABORTED, exactly as
 *     paper aborts an entry whose spot is already through the stop.
 *
 * PROFIT LOCK: the global premium lock (tradeGuards) is simulated on the δ
 * premium: once the bar extremes have pushed the simulated premium past the arm
 * level, the floor is converted back to a spot level and treated as a stop. It
 * is armed only from bars ALREADY closed, so it never reads the future.
 *
 * PERFORMANCE: each getSignal call is handed only yesterday + today (≤ ~250
 * bars), and evaluation stops for the day as soon as the setup is dead, spent
 * or traded — a 90-day run is a few thousand cheap calls.
 *
 * There is NO historical option chain: premium is δ+θ simulated with a
 * slippage haircut each way. Treat ₹ as DIRECTIONAL, not exact.
 */

const express = require("express");
const router  = express.Router();
const strat = require("../strategies/prev_orb_scalp");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { fyersErrText } = require("../utils/fyersErr");
const { faviconLink } = require("../utils/sharedNav");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");
const tradeGuards = require("../utils/tradeGuards");

const ACCENT = "#e879f9";
const ENDPOINT = "/prev-orb-scalp-backtest";
const RESULT_KEY = "PREV_ORB_SCALP_BACKTEST";
const LOG = "[PREV-ORB-SCALP-BACKTEST]";
const SPOT_SYMBOL = "NSE:NIFTY50-INDEX";

function istDateOf(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function istHHMMSS(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
function entryTsStr(unixSec) { return `${istDateOf(unixSec)}, ${istHHMMSS(unixSec)}`; }
function escHtml(x) {
  return String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function _r2(x) { return Math.round(x * 100) / 100; }

/** Calendar days prepended so the first requested day has a "yesterday". */
function _warmupDays() {
  const v = parseInt(process.env.PREV_ORB_SCALP_WARMUP_DAYS, 10);
  return Number.isFinite(v) && v >= 2 && v <= 30 ? v : 7;
}
function shiftDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function warmupRange(from, to) {
  return { fetchFrom: shiftDateStr(from, _warmupDays()), fetchTo: to, warmupDays: _warmupDays() };
}

// ── The backtest ─────────────────────────────────────────────────────────────
/**
 * @param {Array}  intraday  PREV_ORB_SCALP_RESOLUTION-minute NIFTY spot candles,
 *                           ascending, INCLUDING the warm-up runway.
 * @param {string} rangeFrom "YYYY-MM-DD" IST — the first day a trade may open.
 * @param {object} [opts]    { cfg, lock: { enabled, armPct, floorPct } } — test hooks
 */
async function runPrevOrbScalpBacktest(intraday, rangeFrom, opts) {
  const o = opts || {};
  const funnel = {
    days: 0, noPrevDay: 0, incomplete: 0, insideRange: 0, peDays: 0, ceDays: 0,
    noBreak: 0, spentLate: 0, breaks: 0, entries: 0, abortedPastStop: 0,
  };
  const empty = { trades: [], days: 0, skipped: [], funnel, exitReasons: {}, candleSizes: [] };
  if (!Array.isArray(intraday) || !intraday.length) return empty;

  const cfg = o.cfg || strat.getConfig();
  const IS_FUT       = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const DELTA        = IS_FUT ? 1.0 : parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = IS_FUT ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE     = instrumentConfig.getLotQty();
  const SEED_PREMIUM = parseFloat(process.env.PREV_ORB_SCALP_BT_SEED_PREMIUM || "260");
  const SLIPPAGE_PTS = parseFloat(process.env.PREV_ORB_SCALP_BT_SLIPPAGE_PTS || "1.5");
  const RES          = cfg.resolutionMins;
  const lock = o.lock || {
    enabled: tradeGuards.PROFIT_LOCK_ENABLED,
    armPct: tradeGuards.PROFIT_LOCK_ARM_PCT,
    floorPct: tradeGuards.PROFIT_LOCK_FLOOR_PCT,
    trailPct: tradeGuards.PROFIT_LOCK_TRAIL_PCT,
  };
  const lockOk = !IS_FUT && lock.enabled && Number.isFinite(lock.armPct) && Number.isFinite(lock.floorPct) &&
    lock.armPct > 0 && lock.floorPct >= 0 && lock.floorPct < lock.armPct;

  const sorted = intraday.filter(c => c && typeof c.time === "number").sort((a, b) => a.time - b.time);

  // Day buckets with global indices, so each call can be handed yesterday+today.
  const dayKeys = [];
  const byDay = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const k = strat._istDayOf(sorted[i].time);
    if (!byDay.has(k)) { byDay.set(k, []); dayKeys.push(k); }
    byDay.get(k).push(i);
  }

  const trades = [];
  const skipped = [];
  const exitReasons = {};
  const candleSizes = [];

  for (let d = 0; d < dayKeys.length; d++) {
    // Yield once per session so live ticks/orders sharing this process are not
    // starved while a long backtest runs.
    await new Promise(resolve => setImmediate(resolve));
    const k = dayKeys[d];
    const idxs = byDay.get(k);
    const dayTs = sorted[idxs[0]].time;
    const dayStr = strat._istDateStr(dayTs);
    if (rangeFrom && dayStr < rangeFrom) continue;
    funnel.days++;

    // The window starts at the previous day that has bars (the engine picks
    // "yesterday" as the latest earlier day present, same as paper).
    const winStart = d > 0 ? byDay.get(dayKeys[d - 1])[0] : idxs[0];

    let pos = null;
    let pending = null;
    let settled = false;      // the day's entry question is answered — stop calling getSignal
    let dayTrades = 0;
    let dayBreak = false;
    let daySpent = false;
    let dayNote = null;

    const barsPerDay = Math.max(1, Math.round(375 / RES));
    function premAt(spotPx, t) {
      const barsHeld = Math.max(0, (t - pos.entryTime) / 60 / RES);
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const move = pos.side === "CE" ? (spotPx - pos.entrySpot) : (pos.entrySpot - spotPx);
      return Math.max(0.05, pos.optionEntryLtp + move * DELTA - thetaCost / LOT_SIZE);
    }
    function close(exitPx, exitTime, reason, code) {
      const raw = premAt(exitPx, exitTime);
      const exitPrem = Math.max(0.05, raw - 2 * SLIPPAGE_PTS);
      const charges = getCharges({ broker: "zerodha", isFutures: IS_FUT, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
      const pnl = _r2((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges);
      exitReasons[code] = (exitReasons[code] || 0) + 1;
      trades.push({
        side: pos.side,
        entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitTime),
        entryTs: pos.entryTime, exitTs: exitTime,
        ePrice: pos.entrySpot, xPrice: _r2(exitPx),
        sl: pos.initialSl, target: pos.targetSpot,
        riskPts: pos.riskPts, candleSize: pos.candleSize,
        prevHigh: pos.prevHigh, prevLow: pos.prevLow, orClose: pos.orClose,
        targetReached: pos.targetReached ? "yes" : "no",
        exitCode: code,
        pnl, reason, entryReason: pos.entryReason,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: _r2(exitPrem),
        held: Math.round(Math.max(0, (exitTime - pos.entryTime) / 60 / RES)),
      });
      pos = null;
    }

    for (let j = 0; j < idxs.length; j++) {
      const gi = idxs[j];
      const c = sorted[gi];
      const istMin = strat._utcSecToIstMins(c.time);

      // ── 1. Fill a pending entry at THIS bar's open. ─────────────────────────
      if (pending && !pos) {
        const sig = pending;
        pending = null;
        if (typeof c.open === "number" && Number.isFinite(c.open)) {
          if (strat.stopHit(sig.side, c.open, sig.slSpot)) {
            funnel.abortedPastStop++;
            dayNote = `break at ${istHHMMSS(sig.signalBarTime)} but the next open ${c.open} was already through the stop ${sig.slSpot} — aborted (paper does the same)`;
          } else {
            pos = {
              side: sig.side, entryTime: c.time, entrySpot: _r2(c.open),
              optionEntryLtp: IS_FUT ? _r2(c.open) : SEED_PREMIUM,
              slSpot: sig.slSpot, initialSl: sig.slSpot, targetSpot: sig.targetSpot,
              riskPts: _r2(Math.abs(c.open - sig.slSpot)), candleSize: sig.candleSize,
              targetReached: false, peakPrem: null,
              prevHigh: sig.prevHigh, prevLow: sig.prevLow, orClose: sig.orClose,
              signalBarTime: sig.signalBarTime, entryReason: sig.reason,
            };
            pos.peakPrem = pos.optionEntryLtp;
            dayTrades++; funnel.entries++;
          }
        }
      }

      // ── 2. Manage an open position on this bar. ─────────────────────────────
      if (pos) {
        const isCE = pos.side === "CE";
        const dir = isCE ? 1 : -1;
        if (istMin >= cfg.forcedExitMin) {
          close(c.open, c.time, `EOD square-off (${strat._fmtMins(cfg.forcedExitMin)} IST)`, "EOD");
        } else {
          // Adverse level: the stop, or the armed profit-lock floor if tighter.
          let lockSpot = null;
          if (lockOk && pos.peakPrem >= pos.optionEntryLtp * (1 + lock.armPct / 100)) {
            const floorPrem = tradeGuards.profitLockFloorLtp(pos.optionEntryLtp, pos.peakPrem, lock.floorPct, lock.trailPct);
            lockSpot = pos.entrySpot + dir * (floorPrem - pos.optionEntryLtp) / DELTA;
          }
          const useLock = lockSpot != null && (lockSpot - pos.slSpot) * dir > 0;
          const adverseLvl = useLock ? lockSpot : pos.slSpot;
          const adverseExt = isCE ? c.low : c.high;
          if (strat.stopHit(pos.side, adverseExt, adverseLvl)) {
            const fill = isCE ? Math.min(c.open, adverseLvl) : Math.max(c.open, adverseLvl);
            if (useLock) close(fill, c.time, `Profit lock +${lock.floorPct}% — simulated premium fell back to the locked floor`, "PROFIT_LOCK");
            else close(fill, c.time, pos.targetReached ? `Trailed stop ${_r2(pos.slSpot)} hit after target` : `Stop hit — break candle ${isCE ? "low" : "high"} ${pos.slSpot}`, pos.targetReached ? "TRAIL_STOP" : "STOP");
          } else {
            // Favourable side: premium peak, then the target.
            const favExt = isCE ? c.high : c.low;
            const favPrem = premAt(favExt, c.time);
            if (favPrem > pos.peakPrem) pos.peakPrem = favPrem;
            if (!pos.targetReached && strat.targetHit(pos.side, favExt, pos.targetSpot)) {
              const act = strat.onTarget(pos, { cfg });
              if (!act || act.action === "EXIT") {
                const fill = isCE ? Math.max(c.open, pos.targetSpot) : Math.min(c.open, pos.targetSpot);
                close(fill, c.time, `Target ${pos.targetSpot} hit (candle size ${pos.candleSize}pt)`, "TARGET");
              } else {
                pos.targetReached = true;
                pos.slSpot = act.stop;
                // Reached the target and closed back through it — paper's tick exits at the level.
                if (strat.stopHit(pos.side, c.close, pos.slSpot)) {
                  close(pos.slSpot, c.time, `Target ${pos.targetSpot} reached, then price came back to it (locked)`, "TARGET_LOCK");
                }
              }
            }
            // Profit lock armed inside this bar and closed back below its floor.
            if (pos && lockOk && pos.peakPrem >= pos.optionEntryLtp * (1 + lock.armPct / 100)) {
              const floorPrem = tradeGuards.profitLockFloorLtp(pos.optionEntryLtp, pos.peakPrem, lock.floorPct, lock.trailPct);
              const lvl = pos.entrySpot + dir * (floorPrem - pos.optionEntryLtp) / DELTA;
              if ((lvl - pos.slSpot) * dir > 0 && strat.stopHit(pos.side, c.close, lvl)) {
                close(c.close, c.time, `Profit lock +${lock.floorPct}% — armed and given back inside the bar`, "PROFIT_LOCK");
              }
            }
            // Candle-close trail (only after the target).
            if (pos) {
              const tr = strat.trailStop(pos, c);
              if (tr) pos.slSpot = tr.stop;
            }
          }
        }
      }

      // ── 3. The entry question, on this bar's close. ─────────────────────────
      if (!pos && !pending && !settled) {
        const sig = strat.getSignal(sorted.slice(winStart, gi + 1), { cfg, silent: true });
        if (sig.signal !== "NONE" && sig.side) {
          funnel.breaks++;
          dayBreak = true;
          candleSizes.push(sig.candleSize);
          if (j === idxs.length - 1) dayNote = "break on the day's last bar — nothing to fill on";
          else pending = sig;
          // Only the FIRST break can ever trade, so the day is settled here.
          settled = true;
          continue;
        }
        if (sig.warmup) {
          if (/incomplete/.test(sig.skipReason)) funnel.incomplete++; else funnel.noPrevDay++;
          dayNote = sig.skipReason; settled = true;
        } else if (sig.dayDead) {
          if (/inside yesterday's range/.test(sig.skipReason)) funnel.insideRange++; else funnel.incomplete++;
          dayNote = sig.skipReason; settled = true;
        } else if (sig.spent) {
          funnel.spentLate++;
          daySpent = true;
          dayNote = sig.skipReason; settled = true;
        }
        if (sig.setupSide && !dayNote) dayNote = sig.skipReason;
      }
    }

    // A position still open at the last bar is squared off at its close.
    if (pos) {
      const last = sorted[idxs[idxs.length - 1]];
      close(last.close, last.time, "EOD (last candle of the session)", "EOD");
    }

    // Side tally from the engine's own levels for this day.
    const lv = strat.dayLevels(sorted.slice(winStart, idxs[idxs.length - 1] + 1), { cfg });
    const side = strat.setupSide(lv);
    if (side === "PE") funnel.peDays++;
    else if (side === "CE") funnel.ceDays++;
    if (side && !dayBreak && !daySpent) funnel.noBreak++;

    if (!dayTrades) skipped.push({ date: istDateOf(dayTs), reason: dayNote || "no setup" });
  }

  return { trades, days: funnel.days, skipped, funnel, exitReasons, candleSizes };
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
  const job = req.query.jobId ? backtestJobs.getJob(req.query.jobId) : null;
  if (!job) return res.status(404).json({ error: "not_found" });
  if (job.status !== "done") return res.json({ status: job.status, error: job.error || null });
  const { trades, stats, from, to, meta } = job.result;
  return res.json({ status: "done", from, to, stats, meta, trades });
});

const MOBILE_CSS = `<style>
@media(max-width:640px){
  html,body{max-width:100%;overflow-x:hidden;}
  .main-content{padding-left:10px;padding-right:10px;}
  table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:nowrap;}
  a,button,select,input{min-height:44px;}
  body{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);}
}
</style>`;

function _median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : _r2((s[m - 1] + s[m]) / 2);
}

function _renderResults(res, from, to, trades, stats, meta) {
  const inf = (x) => x === Infinity ? "∞" : x;
  const cfg = strat.getConfig();
  const f = meta.funnel || {};
  const xr = meta.exitReasons || {};
  const exitMix = Object.keys(xr).length ? Object.entries(xr).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") : "—";
  const sizes = meta.candleSizes || [];

  const html = renderBacktestResults({
    mode: "PREV_ORB_SCALP",
    accent: ACCENT,
    strategyName: strat.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "prevOrbScalpBacktest",
    extraTradeColumns: [
      { key: "prevHigh", label: "Yday H" },
      { key: "prevLow", label: "Yday L" },
      { key: "orClose", label: "09:15 C" },
      { key: "candleSize", label: "Candle pt" },
      { key: "target", label: "Target" },
      { key: "targetReached", label: "Tgt hit" },
      { key: "exitCode", label: "Exit" },
      { key: "held", label: "Held" },
    ],
    extraStats: [
      { label: "Profit Factor", value: inf(stats.profitFactor) },
      { label: "Expectancy /trade", value: `₹${stats.expectancy}` },
      { label: "Max Drawdown", value: `₹${stats.maxDrawdown}` },
      { label: "Sessions scanned", value: meta.days },
      { label: "PE days / CE days", value: `${f.peDays || 0} / ${f.ceDays || 0}` },
      { label: "Inside yesterday's range", value: f.insideRange || 0 },
      { label: "Setup, no break", value: f.noBreak || 0 },
      { label: "Breaks → entries", value: `${f.breaks || 0} → ${f.entries || 0}` },
      { label: "Median break-candle size", value: sizes.length ? `${_median(sizes)}pt` : "—" },
      { label: "Exit mix", value: exitMix },
      { label: "Trade frequency", value: meta.days ? `${((trades.length / meta.days) * 100).toFixed(1)}% of sessions` : "—" },
    ],
    notes: `<b>Chart:</b> NIFTY 50 INDEX spot (<code>${escHtml(SPOT_SYMBOL)}</code>) ${cfg.resolutionMins}-min. The ${strat._fmtMins(cfg.sessionStartMin)} ${cfg.orMins}-min candle is built from those bars. <b>Setup:</b> it closes below yesterday's LOW → PE day, above yesterday's HIGH → CE day. <b>Entry:</b> the FIRST ${cfg.resolutionMins}-min close beyond that candle's low/high, filled at the NEXT bar's open (paper fills on the first tick after the close), until ${strat._fmtMins(cfg.entryEndMin)}. A fill already through the stop is aborted, as in paper. <b>Stop</b> = break candle's high (PE) / low (CE). <b>Target</b> = break candle size from its close. ${cfg.trailAfterTarget ? "At the target the stop moves to the target, then trails each closed candle's high/low." : "Exit at the target."} <b>Profit lock</b> (global, ${lockText()}) is simulated on the δ premium. Square-off ${strat._fmtMins(cfg.forcedExitMin)}. Warm-up: ${escHtml(String(meta.warmupDays))} calendar day(s) fetched before ${escHtml(from)} so day one has a yesterday. Conservative ordering: the adverse level is tested before the target. Premium is δ+θ simulated (BACKTEST_DELTA ${escHtml(process.env.BACKTEST_DELTA || "0.55")}) seeded at ₹${escHtml(process.env.PREV_ORB_SCALP_BT_SEED_PREMIUM || "260")} with ${escHtml(process.env.PREV_ORB_SCALP_BT_SLIPPAGE_PTS || "1.5")}pt slippage each way — treat ₹ as directional. <b>Never traded live or on paper; nothing here is validated.</b>`,
  });
  res.send(html.replace("</body>", `${MOBILE_CSS}</body>`));
}

function lockText() {
  return tradeGuards.PROFIT_LOCK_ENABLED ? `arm +${tradeGuards.PROFIT_LOCK_ARM_PCT}% / floor +${tradeGuards.PROFIT_LOCK_FLOOR_PCT}%` : "OFF";
}

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !dateRe.test(from) || !dateRe.test(to)) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    return res.redirect(`${ENDPOINT}?from=${shiftDateStr(today, 90)}&to=${today}`);
  }

  const jobId = req.query.jobId;
  if (!jobId) {
    if (backtestJobs.getActiveJob()) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "Prev ORB Scalp Backtest"));
    const { id } = backtestJobs.createJob("prev_orb_scalp");
    (async () => {
      try {
        const cfg = strat.getConfig();
        const { fetchFrom, fetchTo, warmupDays } = warmupRange(from, to);
        backtestJobs.updateProgress(id, { phase: `Fetching ${SPOT_SYMBOL} ${cfg.resolutionMins}-min candles (${fetchFrom} → ${fetchTo})…`, pct: 10 });
        let intraday;
        try {
          intraday = await fetchCandlesCachedBT(SPOT_SYMBOL, String(cfg.resolutionMins), fetchFrom, fetchTo, false,
            (p) => backtestJobs.updateProgress(id, { phase: p && p.phase ? p.phase : `Fetching ${SPOT_SYMBOL}…`, pct: Math.min(65, 10 + Math.round((p && p.pct ? p.pct : 0) * 0.55)) }));
        } catch (err) {
          const msg = fyersErrText(err);
          backtestJobs.failJob(id, `Fyers refused the ${SPOT_SYMBOL} history request for ${fetchFrom} → ${fetchTo}: ${msg.slice(0, 200)}. "Could not authenticate the user" means the Fyers session needs re-login.`);
          return;
        }
        intraday = Array.isArray(intraday) ? intraday : [];
        if (!intraday.length) {
          backtestJobs.failJob(id, `Fyers returned no historical candles for ${SPOT_SYMBOL} ${fetchFrom} → ${fetchTo}. Most often the Fyers session needs re-login — an expired token returns no data rather than an auth error.`);
          return;
        }
        backtestJobs.updateProgress(id, { phase: `Running Prev ORB Scalp backtest (${intraday.length.toLocaleString()} candles)…`, pct: 75 });
        const result = await runPrevOrbScalpBacktest(intraday, from);
        const stats = computeBacktestStats(result.trades);
        stats.optionSim = true;
        stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
        stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
        try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: String(cfg.resolutionMins) } }); }
        catch (e) { console.warn(`${LOG} saveResult failed: ${e.message}`); }
        const fn = result.funnel;
        console.log(`${LOG} ${from}→${to}: ${fn.days} days | PE ${fn.peDays} / CE ${fn.ceDays} / inside ${fn.insideRange} | breaks ${fn.breaks} → entries ${fn.entries} | exits ${JSON.stringify(result.exitReasons)}`);
        backtestJobs.completeJob(id, {
          trades: result.trades, stats, from, to,
          meta: { days: result.days, skipped: result.skipped, funnel: result.funnel, exitReasons: result.exitReasons, candleSizes: result.candleSizes, warmupDays, fetchFrom, candles: intraday.length },
        });
      } catch (err) {
        console.error(`${LOG} job error:`, err);
        backtestJobs.failJob(id, err.message);
      }
    })();
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "Prev ORB Scalp Backtest"));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "Prev ORB Scalp Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));
  const { trades, stats, meta } = job.result;
  return _renderResults(res, from, to, trades, stats, meta || { days: 0, funnel: {}, exitReasons: {}, warmupDays: _warmupDays() });
});

function renderErrorPage(msg, from, to) {
  const light = require("../utils/theme").resolveTheme() === "light" ? ' data-theme="light"' : "";
  return `<!DOCTYPE html><html${light}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>Prev ORB Scalp — Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;word-break:break-word;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;display:inline-flex;min-height:44px;align-items:center;}
:root[data-theme="light"] body{background:#f4f6f9;color:#334155;}
@media(max-width:768px){body{padding:24px 14px;}}</style>
</head><body><h2>Prev ORB Scalp Backtest Failed</h2><p>${escHtml(msg)}</p><p><b>${escHtml(from || "")}</b> → <b>${escHtml(to || "")}</b></p><a href="${ENDPOINT}">← Back</a></body></html>`;
}

module.exports = router;
module.exports.runPrevOrbScalpBacktest = runPrevOrbScalpBacktest;
module.exports.warmupRange = warmupRange;
module.exports.shiftDateStr = shiftDateStr;

/**
 * EMA9_CROSS BACKTEST — /ema9_cross-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest on 5-minute NIFTY 50 INDEX candles for EMA9_CROSS.
 *
 * THE ENGINE OWNS THE RULES. Every entry AND the EMA9 exit come from
 * src/strategies/ema9_cross.js (`getSignal`, `exitSignal`) — the same calls the
 * paper route makes. There is NO indicator maths and NO threshold comparison here.
 * This file re-implements only paper's EXIT SEQUENCING:
 *
 *   for each IST day, for each closed bar:
 *     1. common premium stop + profit lock on THIS bar (tick-ordered walk)
 *     2. EMA9 exit on the bar CLOSE (engine.exitSignal) — paper's candle-close exit
 *     3. session-end square-off (TRADE_STOP_TIME / last bar)
 *     4. entry on the bar CLOSE when the close freshly crossed EMA9 — which is also
 *        the FLIP when step 2 just closed the other side (the common wait-after-exit
 *        blocks it while that rule is on, exactly as paper's simulateBuy does)
 *
 * Paper fills an entry at the first tick after the signal bar closes; this fills
 * at that bar's close — the same market moment.
 *
 * CONSERVATIVE INTRA-BAR ORDERING: each bar is walked open → adverse extreme →
 * favourable extreme → close, so the stop is tested on the adverse leg BEFORE the
 * favourable extreme raises the peak; a bar that opened through the stop fills at
 * the OPEN; BACKTEST_SLIPPAGE_PTS is applied each way.
 *
 * WARM-UP: EMA9_CROSS_WARMUP_DAYS (default 5) calendar days are fetched BEFORE
 * `from` purely to seed the EMA; no bar before `from` can trade (`warmupViolations`).
 *
 * THE PREMIUM IS SIMULATED (δ+θ from the spot move). Treat ₹ as directional.
 *
 * MARKETS. This page is NIFTY; the unified /backtest page runs the SAME loop on
 * BANKNIFTY, SENSEX and NIFTY futures through `backtestPage` (exported below),
 * with the pair's settings mapped onto the EMA9_CROSS_* keys for that run only.
 */

const express = require("express");
const router  = express.Router();

const engine             = require("../strategies/ema9_cross");
const tradeGuards        = require("../utils/tradeGuards");
const vixFilter          = require("../services/vixFilter");

// Futures stop on the long-equivalent futures "premium" (entry, price and peak
// all in index points): tradeGuards.futuresStopLevel with best move = peak − entry.
function _futStopLvl(entry, peak) { return tradeGuards.futuresStopLevel("CE", entry, peak - entry); }
function _futStopMsg(entry, px, peak) {
  const lvl = _futStopLvl(entry, peak);
  if (lvl == null || px > lvl) return null;
  return tradeGuards.premiumStopSpotReason(Math.round((lvl - entry) * 100) / 100, peak - entry);
}
const { fetchCandlesCachedBT: fetchCandles } = require("../services/backtestEngine");
const { fyersErrText }   = require("../utils/fyersErr");
const { faviconLink }    = require("../utils/sharedNav");
const { getCharges }     = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult }     = require("../utils/resultStore");
const backtestJobs       = require("../utils/backtestJobManager");
const backtestCosts = require("../config/backtestCosts");
const backtestMarket = require("../services/backtestMarket");

const ACCENT      = "#2563eb";
const ENDPOINT    = "/ema9_cross-backtest";
const MODE_KEY    = "ema9_cross";
const LABEL       = "EMA9_CROSS";
const RESULT_KEY  = "EMA9_CROSS_BACKTEST";
const SPOT_SYMBOL = "NSE:NIFTY50-INDEX";
const PAGE_TITLE  = "EMA9_CROSS Backtest";

// ── Small time helpers (IST = UTC+5:30 = +19800s; no ICU, no locale cost) ────
function _istMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _istDateOf(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function _istHHMMSS(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
function _tsStr(unixSec) { return `${_istDateOf(unixSec)}, ${_istHHMMSS(unixSec)}`; }

/** "HH:MM" → minutes past IST midnight. Falls back to `fallback` on junk. */
function _parseMins(envKey, fallback) {
  const raw   = process.env[envKey] || fallback;
  const parts = String(raw).split(":");
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h)) {
    const fb = String(fallback).split(":");
    return parseInt(fb[0], 10) * 60 + (parseInt(fb[1], 10) || 0);
  }
  return h * 60 + (Number.isFinite(m) ? m : 0);
}
function _fmtMins(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** `dateStr` shifted by `days`, as YYYY-MM-DD. Used for the warm-up runway. */
function _shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function _escHtml(x) {
  return String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function _int(envKey, fallback) {
  const v = parseInt(process.env[envKey] || fallback, 10);
  return Number.isFinite(v) ? v : parseInt(fallback, 10);
}
function _num(envKey, fallback) {
  const v = parseFloat(process.env[envKey] || fallback);
  return Number.isFinite(v) ? v : parseFloat(fallback);
}
function _bool(envKey, fallback) {
  return String(process.env[envKey] || fallback).toLowerCase() === "true";
}

/**
 * Guard config — EMA9_CROSS's own keys plus the session keys paper reads
 * (TRADE_START_TIME / TRADE_STOP_TIME / TRADE_RESOLUTION).
 */
function getGuardConfig() {
  return {
    entryStartMin:  _parseMins("EMA9_CROSS_ENTRY_START", "10:30"),
    entryEndMin:    _parseMins("EMA9_CROSS_ENTRY_END",   "14:00"),
    sessionStopMin: _parseMins("TRADE_STOP_TIME", "15:30"),
    tradeStartMin:  _parseMins("TRADE_START_TIME", "09:15"),
    warmupDays:     _int("EMA9_CROSS_WARMUP_DAYS", "5"),
    slippagePts:    backtestCosts.slippagePts(),
    seedPremium:    backtestCosts.seedPremium(),
    resolutionMins: _int("TRADE_RESOLUTION", "5"),
  };
}

// ── The engine loop ─────────────────────────────────────────────────────────
/**
 * runEma9CrossBacktest(candles, activeFromTs, mkt, vixCandles, expiryDates)
 * `candles` includes the warm-up runway; bars before `activeFromTs` never trade.
 */
async function runEma9CrossBacktest(candles, activeFromTs, mkt, vixCandles = null, expiryDates = null) {
  const empty = {
    trades: [], days: 0, warmupViolations: 0, warmupBars: 0,
    gateStats: { setups: 0, entries: 0, flips: 0, emaExits: 0,
                 blockedWarmup: 0, blockedWindow: 0, blockedExpiry: 0,
                 blockedReentry: 0, blockedVix: 0, blockedMinCross: 0 },
  };
  if (!Array.isArray(candles) || !candles.length) return empty;

  const g = getGuardConfig();
  // VIX gate — paper's candle-close entry runs checkLiveVix("STRONG"); backtest VIX
  // is the PRIOR day's India VIX close (no look-ahead).
  const VIX_ON   = vixFilter.VIX_ENABLED;
  const lookupVix = vixFilter.buildVixLookup(vixCandles || []);
  const stratCfg = engine.getConfig();
  const M = mkt || backtestMarket.context("NIFTY");
  // This run's guards: EMA9_CROSS's Own Common Rules on NIFTY, else the common set.
  const tradeGuards = require("../utils/tradeGuards").forStrategy(M.key === "NIFTY" ? "EMA9_CROSS" : null);

  // FUTURES MODE (NIFTY_FUT only) — index points are rupees 1:1: no delta, no theta.
  const IS_FUT    = M.isFutures === true;
  const DELTA     = IS_FUT ? 1.0 : _num("BACKTEST_DELTA", "0.55");
  const THETA_DAY = IS_FUT ? 0   : _num("BACKTEST_THETA_DAY", "8");
  const LOT_SIZE  = M.key === "NIFTY" ? require("../config/instrument").getLotQty(undefined, undefined, "EMA9_CROSS") : M.lotQty;
  const EXCHANGE  = M.exchange;
  const RES       = g.resolutionMins > 0 ? g.resolutionMins : 5;
  const SLIP      = g.slippagePts;
  // Common wait-after-any-exit (secs). A tick exit (stop/lock) is taken ≈ the bar
  // open here, a candle-close exit at the bar's CLOSE — paper measures from both.
  const REENTRY_COOLDOWN_SECS = tradeGuards.reentryCooldownMs(RES) / 1000;
  const lockOpts = {
    enabled:  tradeGuards.PROFIT_LOCK_ENABLED,
    armPct:   tradeGuards.PROFIT_LOCK_ARM_PCT,
    floorPct: tradeGuards.PROFIT_LOCK_FLOOR_PCT,
    trailPct: tradeGuards.PROFIT_LOCK_TRAIL_PCT,
    tiers:    tradeGuards.PROFIT_LOCK_TRAIL_TIERS,
  };
  const LOCK_ON = !IS_FUT && lockOpts.enabled;
  const ENTRY_CUTOFF_MIN = g.sessionStopMin - 10;   // paper's isMarketHours() upper bound

  const sorted = candles.slice().sort((a, b) => a.time - b.time);

  const trades = [];
  const gateStats = Object.assign({}, empty.gateStats);
  let warmupViolations = 0;
  let warmupBars = 0;
  for (const c of sorted) if (c.time < activeFromTs) warmupBars++;

  const dayKeys = [];
  const byDay = new Map();
  for (const c of sorted) {
    const k = _istDateOf(c.time);
    if (!byDay.has(k)) { byDay.set(k, []); dayKeys.push(k); }
    byDay.get(k).push(c);
  }
  const globalIndex = new Map();
  for (let i = 0; i < sorted.length; i++) globalIndex.set(sorted[i].time, i);

  // EMA computed ONCE over every bar (causal, so identical to the per-bar prefix read).
  const fullSeries = engine.computeSeries(sorted, stratCfg);

  let days = 0;

  for (const k of dayKeys) {
    // Yield once per session so live ticks sharing this process are not starved.
    await new Promise(resolve => setImmediate(resolve));
    const bars = byDay.get(k);
    if (!bars || !bars.length) continue;
    if (bars[bars.length - 1].time >= activeFromTs) days++;

    let reentryBlockUntilTs = 0;   // wait-after-any-exit — no entry on a bar closing before this
    let dayClosedTrades = 0;       // MAX_TRADES_PER_DAY
    let pos = null;

    function premiumAt(exitPx, exitTime) {
      const barsHeld   = Math.max(0, (exitTime - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost  = (THETA_DAY * barsHeld) / barsPerDay;
      const move = pos.side === "CE" ? (exitPx - pos.entrySpot) : (pos.entrySpot - exitPx);
      return Math.max(0.05, pos.optionEntryLtp + move * DELTA - thetaCost / LOT_SIZE);
    }
    function spotForPremium(prem, exitTime) {
      if (!(DELTA > 0)) return pos.entrySpot;
      const barsHeld   = Math.max(0, (exitTime - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost  = (THETA_DAY * barsHeld) / barsPerDay;
      const move = (prem - pos.optionEntryLtp + thetaCost / LOT_SIZE) / DELTA;
      return pos.side === "CE" ? pos.entrySpot + move : pos.entrySpot - move;
    }
    function priceAt(exitPx, exitTime) {
      const raw      = premiumAt(exitPx, exitTime);
      const exitPrem = Math.max(0.05, raw - 2 * SLIP);   // buy high + sell low
      const charges  = getCharges({
        broker: "zerodha", isFutures: IS_FUT, exchange: EXCHANGE,
        entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE,
      });
      return {
        pnl:      parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2)),
        exitPrem: parseFloat(exitPrem.toFixed(2)),
        held:     Math.round((exitTime - pos.entryTime) / 60 / RES),
      };
    }

    // exitTime = the bar's open time; atBarClose = the exit happened at the bar CLOSE.
    function close(exitPx, exitTime, reason, atBarClose = false) {
      const p = priceAt(exitPx, exitTime + (atBarClose ? RES * 60 : 0));
      const spotPts = parseFloat(
        (pos.side === "CE" ? exitPx - pos.entrySpot : pos.entrySpot - exitPx).toFixed(2));
      trades.push({
        side:  pos.side,
        entry: _tsStr(pos.entryTime), exit: _tsStr(exitTime + (atBarClose ? RES * 60 : 0)),
        entryTs: pos.entryTime,       exitTs: exitTime + (atBarClose ? RES * 60 : 0),
        ePrice: parseFloat(pos.entrySpot.toFixed(2)),
        xPrice: parseFloat(exitPx.toFixed(2)),
        spotPts,
        ema9: pos.ema9,
        peakPremium: parseFloat(pos.peak.toFixed(2)),
        pnl:  p.pnl,
        reason,
        entryReason: pos.entryReason,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.held,
      });
      if (REENTRY_COOLDOWN_SECS > 0) {
        reentryBlockUntilTs = exitTime + (atBarClose ? RES * 60 : 0) + REENTRY_COOLDOWN_SECS;
      }
      dayClosedTrades++;
      if (tradeGuards.dayCapReached(dayClosedTrades)) reentryBlockUntilTs = Infinity;
      pos = null;
    }

    // Entry at the CLOSE of bar c (time = the moment the bar closes, like paper).
    function openPosition(side, c, sig) {
      const entryTime = c.time + RES * 60;
      if (c.time < activeFromTs) { warmupViolations++; return; }
      const entryPrem = IS_FUT ? c.close : g.seedPremium;
      const entryPremSlipped = parseFloat(Math.max(0.05, entryPrem + SLIP).toFixed(2));
      pos = {
        side,
        entryTime,
        entrySpot: c.close,
        optionEntryLtp: entryPremSlipped,
        peak:           entryPremSlipped,
        ema9:  sig.ema9 != null ? sig.ema9 : null,
        entryReason: sig.reason || `${side} cross`,
      };
      gateStats.entries++;
    }

    for (let i = 0; i < bars.length; i++) {
      const c = bars[i];
      const gIdx = globalIndex.get(c.time);
      const istMin = _istMins(c.time);
      const closeMin = istMin + RES;   // paper decides at the bar's close
      const pre = { series: fullSeries, endIdx: gIdx, cfg: stratCfg };

      // ── 1. Common premium stop + profit lock on THIS bar (paper: per tick) ──
      // Only on bars after the entry bar — the entry fills at the entry bar's close.
      if (pos && c.time >= pos.entryTime && (LOCK_ON || IS_FUT || tradeGuards.PREMIUM_SL_ENABLED)) {
        const lockAt  = IS_FUT ? _futStopMsg : tradeGuards.checkProfitLock;
        const levelAt = IS_FUT ? _futStopLvl : tradeGuards.exitLevelLtp;
        const isCE = pos.side === "CE";
        const entryPrem = pos.optionEntryLtp;
        const prem = (px) => Math.round(premiumAt(px, c.time) * 100) / 100;
        const pOpen = prem(c.open);
        if (pOpen > pos.peak) pos.peak = pOpen;
        let lock = lockAt(entryPrem, pOpen, pos.peak, lockOpts);
        if (lock) {
          close(c.open, c.time, `${lock} (bar opened through it — filled at the open ${c.open})`);
        } else {
          const adverse = isCE ? c.low : c.high;
          lock = lockAt(entryPrem, prem(adverse), pos.peak, lockOpts);
          if (lock) {
            const floor = levelAt(entryPrem, pos.peak, lockOpts);
            const raw = spotForPremium(floor, c.time);
            const fill = isCE ? Math.min(c.open, raw) : Math.max(c.open, raw);
            close(fill, c.time, `${lock} — floor premium ₹${floor} ≈ spot ${fill.toFixed(2)}`);
          } else {
            const pFav = prem(isCE ? c.high : c.low);
            if (pFav > pos.peak) pos.peak = pFav;
            lock = lockAt(entryPrem, prem(c.close), pos.peak, lockOpts);
            if (lock) close(c.close, c.time, `${lock} (armed and given back inside the bar — filled at the close ${c.close})`, true);
          }
        }
      }

      // ── 2. Read the engine on this bar's CLOSE ─────────────────────────────
      const sig = engine.getSignal(sorted, { silent: true, precomputed: pre });

      // ── 3. EMA9 exit on the close (engine.exitSignal — paper's candle-close exit) ──
      let exitedOnEma = false;
      if (pos && c.time >= pos.entryTime) {
        const why = engine.exitSignal(sig, pos.side);
        if (why) { close(c.close, c.time, why, true); gateStats.emaExits++; exitedOnEma = true; }
      }

      // ── 4. Session-end square-off — paper's TRADE_STOP_TIME teardown ───────
      if (closeMin >= g.sessionStopMin) {
        if (pos) close(c.close, c.time, `Session end — squared off at the close of the bar ending at/after ${_fmtMins(g.sessionStopMin)} IST`, true);
        continue;
      }

      // ── 5. Entry (and the flip) on a fresh cross at this bar's close ───────
      const sigSide = sig.signal === "BUY_CE" ? "CE" : sig.signal === "BUY_PE" ? "PE" : null;
      if (!pos && sig.skipReason === "minCross" && c.time >= activeFromTs) gateStats.blockedMinCross++;
      if (!pos && sigSide) {
        const barEnd = c.time + RES * 60;
        let blocked = null;
        if (c.time < activeFromTs) blocked = "blockedWarmup";
        else if (expiryDates && !expiryDates.has(_istDateOf(c.time))) blocked = "blockedExpiry";
        else if (closeMin < g.tradeStartMin || closeMin >= ENTRY_CUTOFF_MIN) blocked = "blockedWindow";
        else if (barEnd < reentryBlockUntilTs) blocked = "blockedReentry";
        else if (VIX_ON && !vixFilter.checkBacktestVix(lookupVix(c.time), "STRONG").allowed) blocked = "blockedVix";
        if (blocked !== "blockedWarmup") gateStats.setups++;
        if (blocked) gateStats[blocked] = (gateStats[blocked] || 0) + 1;
        else {
          openPosition(sigSide, c, sig);
          if (exitedOnEma) gateStats.flips++;
        }
      }
    }

    // Anything still open at the last bar of the session is squared off there.
    if (pos) {
      const last = bars[bars.length - 1];
      close(last.close, last.time, "Session end — the day's candles ended before the square-off, filled at the last close", true);
    }
  }

  return { trades, days, warmupViolations, warmupBars, gateStats };
}

// ── Routes ──────────────────────────────────────────────────────────────────
router.get("/status", (req, res) => {
  const job = backtestJobs.getJob(req.query.jobId);
  if (!job) return res.json({ status: "not_found" });
  res.json({ status: job.status, progress: job.progress, elapsed: Date.now() - job.startedAt, error: job.error });
});

router.get("/idle", (req, res) => {
  if (req.accepts(["json", "html"]) === "json" || req.query.json === "1") {
    return res.json({ idle: backtestJobs.isIdle() });
  }
  return res.redirect(ENDPOINT);
});

router.get("/cancel", (req, res) => {
  const id = req.query.jobId;
  try {
    if (id && typeof backtestJobs.cancelJob === "function") backtestJobs.cancelJob(id);
  } catch (e) {
    console.warn(`[${ENDPOINT}] cancel failed:`, e.message);
  }
  if (req.accepts(["json", "html"]) === "json" || req.query.json === "1") {
    return res.json({ cancelled: true, jobId: id || null });
  }
  return res.redirect(ENDPOINT);
});

/** Completed result as JSON — used by tooling and the AI export. */
router.get("/results.json", (req, res) => {
  const job = backtestJobs.getJob(req.query.jobId);
  if (!job) return res.status(404).json({ error: "not_found" });
  if (job.status !== "done") return res.json({ status: job.status });
  const r = job.result || {};
  res.json({
    status: "done", mode: MODE_KEY, strategy: LABEL,
    from: r.from, to: r.to, summary: r.stats, meta: r.meta, trades: r.trades,
  });
});

/**
 * The results-page options (renderBacktestResults) for one finished run — this
 * page and the unified /backtest page render the same view. `meta.market` is
 * the run's market key (absent on a NIFTY run).
 */
function _resultsView(from, to, trades, stats, meta) {
  const inf = (x) => x === Infinity ? "∞" : x;
  const M   = backtestMarket.context(meta.market || "NIFTY");
  const futMode = M.isFutures === true;
  const g   = getGuardConfig();
  const c   = engine.getConfig();
  const gs  = meta.gateStats || {};
  const wv  = meta.warmupViolations || 0;
  const tradeGuards = require("../utils/tradeGuards").forStrategy(M.key === "NIFTY" ? "EMA9_CROSS" : null); // the run's lock values
  const lockOn    = tradeGuards.PROFIT_LOCK_ENABLED;
  const lockArm   = tradeGuards.PROFIT_LOCK_ARM_PCT;
  const lockFloor = tradeGuards.PROFIT_LOCK_FLOOR_PCT;
  const lockTrail = tradeGuards.PROFIT_LOCK_TRAIL_PCT;
  const lockTiers = tradeGuards.PROFIT_LOCK_TRAIL_TIERS;

  return {
    mode: LABEL,
    accent: ACCENT,
    strategyName: engine.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "ema9CrossBacktest",
    extraTradeColumns: [
      { key: "ema9",    label: `EMA${c.EMA_PERIOD}` },
      { key: "peakPremium", label: "Peak prem" },
      { key: "spotPts", label: "Spot (pt)" },
      { key: "held",    label: "Held" },
    ],
    extraStats: [
      { label: "Profit Factor",        value: inf(stats.profitFactor) },
      { label: "Expectancy /trade",    value: `₹${stats.expectancy}` },
      { label: "Max Drawdown",         value: `₹${stats.maxDrawdown}` },
      { label: "Sessions scanned",     value: meta.days },
      { label: "Crosses seen (in range)", value: gs.setups || 0 },
      { label: "Entries",              value: gs.entries || 0 },
      { label: "Flips (exit + reverse)", value: gs.flips || 0 },
      { label: "EMA9 exits",           value: gs.emaExits || 0 },
      { label: "Blocked — entry window / session", value: gs.blockedWindow || 0 },
      { label: "Blocked — wait after exit / max trades", value: gs.blockedReentry || 0 },
      { label: "Blocked — VIX", value: gs.blockedVix || 0 },
      { label: "Blocked — cross too small", value: gs.blockedMinCross || 0 },
      { label: "Blocked — not expiry day", value: gs.blockedExpiry || 0 },
      { label: "Warm-up bars fetched",    value: meta.warmupBars || 0 },
      {
        label: "Warm-up leak", value: wv === 0 ? "none ✓" : `${wv} ⚠`,
        color: wv === 0 ? "#10b981" : "#ef4444",
        sub: wv === 0 ? "no pre-range bar traded" : "BUG — runway produced trades",
      },
      { label: "Trades per session", value: meta.days ? (trades.length / meta.days).toFixed(2) : "—" },
    ],
    notes:
      `${meta.planTrimmedFrom ? `<b>⚠ DATA STARTS ${_escHtml(meta.planTrimmedFrom)}, NOT ${_escHtml(from)}</b> — your Fyers plan refuses intraday history older than that, so earlier dates were skipped. ` : ""}` +
      `${M.key !== "NIFTY" ? `<b>MARKET: ${_escHtml(M.label)}</b> — ${_escHtml(M.spotSymbol)} candles, lot ${M.lotQty}, ${_escHtml(M.exchange)} charges. ` : ""}` +
      `${futMode ? "<b>FUTURES MODE</b> — P&L is index points × lot with futures charges, no δ/θ; a PE is a SHORT. " : ""}` +
      `<b>Rules come from the engine</b> (<code>src/strategies/ema9_cross.js</code>) — the same getSignal / exitSignal calls paper makes. ` +
      `<b>Entry:</b> a ${g.resolutionMins}-min candle CLOSES across EMA${c.EMA_PERIOD} (previous close on the other side) — above → CE, below → PE — between ${_fmtMins(g.entryStartMin)} and ${_fmtMins(g.entryEndMin)}. Filled at that bar's close (paper: the first tick after it). ` +
      `<b>Exit:</b> (1) the common premium stop${tradeGuards.PREMIUM_SL_ENABLED ? ` (−${tradeGuards.PREMIUM_SL_PCT}%, trail ${tradeGuards.PREMIUM_SL_TRAIL_PCT}%)` : " — <b>currently OFF</b>"} and profit lock (arm +${lockArm}%, floor +${lockFloor}%, trail ${lockTrail}%${lockTiers ? `, tiers ${_escHtml(lockTiers)}` : ""})${lockOn ? "" : " — <b>lock currently OFF</b>"}, tested intra-bar on the simulated premium; (2) a candle CLOSE back across EMA${c.EMA_PERIOD} — on a fresh opposite cross the trade FLIPS to the other side on that close, unless the common wait-after-exit (${tradeGuards.EXIT_REENTRY_COOLDOWN_CANDLES} candles) blocks it; (3) the session end (${_fmtMins(g.sessionStopMin)} IST) or the day's last bar. ` +
      `<b>Re-entry</b> only on a fresh cross — a stop-out while price stays on the same side of EMA${c.EMA_PERIOD} waits for the next cross. ` +
      `<b>Warm-up:</b> the engine refuses below ${engine.warmupBars(c)} candles, so ${g.warmupDays} calendar days of runway are fetched BEFORE ${_escHtml(from)}. ${meta.warmupBars || 0} such bars were loaded and ${wv === 0 ? "<b>none of them produced a trade</b>" : `<b>⚠ ${wv} produced a trade — this is a bug, do not trust these results</b>`}. ` +
      `<b>Intra-bar ordering is conservative:</b> open → adverse extreme → favourable extreme → close; a bar that opened through the stop fills at the OPEN. ` +
      `<b>P&L is simulated</b> — premium is δ+θ modelled (BACKTEST_DELTA ${_num("BACKTEST_DELTA", "0.55")}, θ ₹${_num("BACKTEST_THETA_DAY", "8")}/day) seeded at ₹${g.seedPremium}, PLUS ${g.slippagePts}pt slippage EACH way and real brokerage. Treat ₹ as directional, not exact.`,
  };
}

function _renderResults(res, from, to, trades, stats, meta) {
  res.send(renderBacktestResults(_resultsView(from, to, trades, stats, meta)));
}

/**
 * One run, start to finish, on job `id` — fetch, simulate, save, complete (or
 * fail). This page and the unified /backtest page both call it.
 *   p = { from, to, market? }   market: a markets.js key, default NIFTY
 */
async function _runJob(id, p) {
  const { from, to } = p;
  const M = backtestMarket.context(p.market || "NIFTY");
  const home = M.key === "NIFTY";
  try {
    const g   = getGuardConfig();
    const res5 = String(g.resolutionMins);
    // The runway starts WARMUP_DAYS calendar days before `from`. Calendar,
    // not trading, days — weekends/holidays simply return no bars, so a
    // generous default is the safe direction to err in.
    const fetchFrom = _shiftDate(from, -Math.max(1, g.warmupDays));
    const activeFromTs = Math.floor(new Date(`${from}T00:00:00+05:30`).getTime() / 1000);

    console.log(`🔍 ${LABEL} Backtest job ${id}: ${from} → ${to} (runway from ${fetchFrom})${home ? "" : ` on ${M.key}`}`);
    backtestJobs.updateProgress(id, { phase: `Fetching ${res5}-min ${M.shortLabel} candles (+${g.warmupDays}d warm-up runway)…`, pct: 20 });

    let candles = [];
    try {
      candles = await fetchCandles(M.spotSymbol, res5, fetchFrom, to);
    } catch (err) {
      backtestJobs.failJob(id, `Fyers refused the candle request for ${fetchFrom} → ${to}: ${fyersErrText(err).slice(0, 300)}`);
      return;
    }
    if (Array.isArray(candles) && !candles.length && candles.planTrimmedFrom) {
      backtestJobs.failJob(id, `Your Fyers plan has no intraday history before ${candles.planTrimmedFrom}, and this whole range is older than that. Pick a start date on or after ${candles.planTrimmedFrom}.`);
      return;
    }
    if (!Array.isArray(candles) || !candles.length) {
      backtestJobs.failJob(id,
        `Fyers returned no historical candles for ${fetchFrom} → ${to}. Most often the Fyers session needs re-login — an expired token returns no data (NOT an auth error). Log in to Fyers again, then retry.`);
      return;
    }

    const need = engine.warmupBars(engine.getConfig());
    if (candles.length < need + 10) {
      backtestJobs.failJob(id,
        `Only ${candles.length} candle(s) for ${fetchFrom} → ${to}. The EMA9_CROSS engine refuses below ${need} candles (more than one session), so this range cannot produce a single trade. Widen the range or raise EMA9_CROSS_WARMUP_DAYS (currently ${g.warmupDays}).`);
      return;
    }

    if (candles.planTrimmedFrom) {
      backtestJobs.updateProgress(id, { phase: `⚠ Fyers plan only allows history from ${candles.planTrimmedFrom} — older dates skipped`, pct: 60 });
    }
    backtestJobs.updateProgress(id, { phase: `Running ${LABEL} backtest (${candles.length.toLocaleString()} candles)…`, pct: 70 });
    // India VIX daily closes for the VIX gate — only when paper's filter is on.
    // A failed fetch leaves VIX unknown, which paper treats per path (see the run).
    let vixCandles = [];
    if (vixFilter.VIX_ENABLED) {
      try { vixCandles = await fetchCandles(vixFilter.VIX_SYMBOL, "D", fetchFrom, to); }
      catch (err) { console.warn(`⚠️ ${LABEL} backtest: VIX fetch failed — ${fyersErrText(err).slice(0, 200)}`); vixCandles = []; }
    }
    // Expiry-day-only — paper's /start check. NIFTY keeps the shared
    // TRADE_EXPIRY_DAY_ONLY; another market reads its own <PAIR>_EXPIRY_DAY_ONLY
    // against THAT market's expiry calendar (rt.expiryDayOnly / rt.isExpiryDay).
    let expiryDates = null;
    const _pairRt = home ? null : require("../utils/pairRuntime").forStrategy("ema9Cross", M.key);
    if (home ? (process.env.TRADE_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true"
             : !!(_pairRt && _pairRt.expiryDayOnly())) {
      const { isExpiryDate } = require("../utils/nseHolidays");
      expiryDates = new Set();
      for (const d of new Set(candles.map(c => _istDateOf(c.time)))) {
        if (home ? await isExpiryDate(d) : _pairRt.isExpiryDay(Date.parse(`${d}T09:15:00+05:30`))) expiryDates.add(d);
      }
    }
    const result = await runEma9CrossBacktest(candles, activeFromTs, M, vixCandles, expiryDates);

    const stats = computeBacktestStats(result.trades);
    stats.optionSim   = !M.isFutures;
    stats.delta       = _num("BACKTEST_DELTA", "0.55");
    stats.thetaPerDay = _num("BACKTEST_THETA_DAY", "8");
    if (M.isFutures) stats.isFutures = true;   // ₹ (index pts × lot − charges), not raw pts

    if (result.warmupViolations > 0) {
      console.warn(`⚠ ${LABEL} Backtest job ${id}: ${result.warmupViolations} warm-up bar(s) attempted a trade — runway is leaking into results.`);
    }

    // The legacy last-run slot (/all-backtest) is NIFTY's; other markets are
    // kept by the /backtest page's own saved runs.
    if (home) {
      try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: res5 } }); }
      catch (e) { console.warn(`[${ENDPOINT}] saveResult failed:`, e.message); }
    }

    const meta = {
      days: result.days,
      gateStats: result.gateStats,
      warmupViolations: result.warmupViolations,
      warmupBars: result.warmupBars,
    };
    if (candles.planTrimmedFrom) meta.planTrimmedFrom = candles.planTrimmedFrom;
    if (!home) meta.market = M.key;
    backtestJobs.completeJob(id, { trades: result.trades, stats, from, to, meta });
    console.log(`✅ ${LABEL} Backtest job ${id} complete — ${result.trades.length} trades over ${result.days} sessions`);
  } catch (err) {
    console.error(`[${ENDPOINT}] job error:`, err);
    backtestJobs.failJob(id, err.message);
  }
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
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, PAGE_TITLE));

    const { id } = backtestJobs.createJob(MODE_KEY);
    _runJob(id, { from, to });
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, PAGE_TITLE));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, PAGE_TITLE));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));

  const { trades, stats, meta } = job.result;
  return _renderResults(res, from, to, trades, stats,
    meta || { days: 0, gateStats: {}, warmupViolations: 0, warmupBars: 0 });
});

function _errLightAttr() {
  return require("../utils/theme").resolveTheme() === "light" ? ' data-theme="light"' : "";
}

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html lang="en"${_errLightAttr()}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${PAGE_TITLE} — error</title>${faviconLink()}
<style>
*{box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1220;color:#e2e8f0;margin:0;padding:40px 16px;padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right));}
.box{max-width:640px;margin:0 auto;background:#111827;border:1px solid #1e293b;border-radius:12px;padding:24px}
h1{font-size:1.1rem;margin:0 0 12px;color:#f87171}
p{color:#cbd5e1;line-height:1.65;font-size:0.9rem;word-break:break-word}
a{display:inline-flex;align-items:center;min-height:44px;margin-top:16px;background:${ACCENT};color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:0.85rem}
</style></head><body><div class="box">
<h1>Backtest could not run</h1>
<p>${_escHtml(msg)}</p>
<a href="${ENDPOINT}?from=${_escHtml(from || "")}&to=${_escHtml(to || "")}">← Try again</a>
</div></body></html>`;
}

module.exports = router;
module.exports.runEma9CrossBacktest = runEma9CrossBacktest;
// The unified /backtest page's hook (see services/backtestPage.js).
module.exports.backtestPage = {
  markets: ["NIFTY", "BANKNIFTY", "SENSEX", "NIFTY_FUT"],
  resolution: null,   // TRADE_RESOLUTION — the global candle size paper uses
  run: _runJob,
  view: (result) => _resultsView(result.from, result.to, result.trades, result.stats,
    result.meta || { days: 0, gateStats: {}, warmupViolations: 0, warmupBars: 0 }),
};

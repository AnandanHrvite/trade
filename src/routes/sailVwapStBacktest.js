/**
 * SAIL_VWAP_ST BACKTEST — /sail_vwap_st-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest on SAIL 5-minute candles (NSE:SAIL-EQ, SAIL_VWAP_ST_TF).
 * Every RULE — the session VWAP, the cross, the breakout confirmation, the
 * SuperTrend agreement, the entry window, the candle-close exit test and the
 * SuperTrend trail — comes from the SAME engine the paper route uses
 * (src/strategies/sail_vwap_st.js). There is no second copy of the rules here.
 * This file only re-creates the paper route's FILLS and its TICK exits, because
 * paper (src/routes/sailVwapStPaper.js) is canonical:
 *
 *   for each closed bar i (indicators computed ONCE over the whole array — both
 *   are causal, so this equals paper recomputing on the bars so far):
 *     in a position → the tick exits inside bar i (below), then on its CLOSE:
 *        engine.exitCheck(side, bar, supertrend[i], stop in force BEFORE bar i)
 *        → exit, filled at bar i+1's OPEN; else engine.trailStop() tightens.
 *     flat → engine.getSignal() on bar i's close → BUY_CE / BUY_PE
 *        → filled at bar i+1's OPEN.
 *
 * FILLS — paper fills an entry AND a candle-close exit at the first tick after
 * the candle closes. The backtest uses the NEXT bar's OPEN for both: the same
 * market moment. When there is no next bar the same IST day (data ends), a
 * candle-close exit fills at that bar's close and an entry is not taken.
 * SAIL_VWAP_ST_BT_SLIPPAGE_PTS (₹ of SAIL SPOT, default 0.05) is applied
 * ADVERSELY on both the entry and the exit fill.
 *
 * THE OPTION PREMIUM IS SIMULATED — THERE IS NO HISTORICAL OPTION CHAIN.
 *   premium(spot, t) = SEED + δ × (spot − entry spot, in the trade's direction)
 *                      − θ × (market minutes held / 375)
 *   SEED  = SAIL_VWAP_ST_BT_SEED_PREMIUM (₹5 / share), δ = SAIL_VWAP_ST_BT_DELTA
 *   (0.5), θ = SAIL_VWAP_ST_BT_THETA_DAY (₹0.1 / share / trading day). These are
 *   SAIL-specific on purpose: the global BACKTEST_DELTA / BACKTEST_THETA_DAY are
 *   NIFTY-scaled and would be nonsense on a ₹170 stock's ₹5 option. The P&L, the
 *   profit lock, the breakeven stop and the option stop are all measured on this
 *   SIMULATED premium. Treat ₹ as directional, not exact.
 *
 * TICK EXITS (paper runs them on every tick, on the option premium, in this
 * order: EOD square-off → profit lock → breakeven → option stop). A bar's tick
 * path is unknown, so it is walked CONSERVATIVELY:
 *     open → ADVERSE extreme (low for a CE, high for a PE) → favourable extreme
 *          → close
 *   • open: the premium at the open is tested first — a bar that OPENS beyond a
 *     level fills at the open, never at the better level;
 *   • open → adverse: the premium falls; the highest armed level is hit first
 *     (lock floor > entry premium [breakeven] > option stop) and fills AT that
 *     level (tradeGuards.profitLockFloorLtp gives the lock floor, the same helper
 *     paper's checkProfitLock uses);
 *   • adverse → favourable: the peak premium rises; nothing exits on a rise;
 *   • favourable → close: a lock / breakeven armed by THIS bar's peak and given
 *     back by the close fills at the CLOSE (worse than the level — the path is
 *     unknown, so the level is not credited).
 *   EOD: the first bar starting at/after SAIL_VWAP_ST_EOD_EXIT_TIME exits at its
 *   open (paper: first tick at/after 15:15) — after any candle-close exit of the
 *   bar before, which paper processes first on that same tick.
 *
 * SESSION — entry window inside the engine; SAIL_VWAP_ST_MAX_DAILY_TRADES (1)
 * and SAIL_VWAP_ST_MAX_DAILY_LOSS checked at the signal close, exactly as paper.
 * A signal on the candle whose close triggered a candle-close exit is not taken
 * (paper's exitedThisBar). Size = SAIL_VWAP_ST_LOTS × SAIL lot (4700), the lot
 * count clamped by MAX_LOT_MULTIPLIER like paper's sailLotQty().
 *
 * WARM-UP — a runway of calendar days BEFORE `from` (sized like paper's own
 * preload fetch) is fetched so SuperTrend has a history on the first session;
 * no trade is ever taken in the runway. SuperTrend is path-dependent, so its
 * values can differ in the second decimal from paper's (which seeds on exactly
 * SAIL_VWAP_ST_WARMUP_DAYS sessions); it converges within a session.
 *
 * NOT MARKET-VALIDATED. This strategy has never traded, paper or live.
 */

const express = require("express");
const router  = express.Router();
const engine  = require("../strategies/sail_vwap_st");
const tradeGuards = require("../utils/tradeGuards");
const { fetchCandles } = require("../services/backtestEngine");
const { fyersErrText } = require("../utils/fyersErr");
const { faviconLink } = require("../utils/sharedNav");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");

const ACCENT = "#0e7490";
const ENDPOINT = "/sail_vwap_st-backtest";
const RESULT_KEY = "SAIL_VWAP_ST_BACKTEST";
const TITLE = "SAIL VWAP ST Backtest";

/** The resolved SAIL row, read LIVE so a Settings save (lot size) lands on the next run. */
function _u() { return instrumentConfig.underlyingOf(engine.UNDERLYING); }
const SAIL_SPOT_SYMBOL = _u().spot;   // NSE:SAIL-EQ

/** Exit-reason categories — every trade's exitReason is exactly one of these. */
const EXIT = {
  ST_FLIP:   "SuperTrend flip",
  ST_STOP:   "SuperTrend stop",
  LOCK:      "profit lock",
  BREAKEVEN: "breakeven",
  OPT_STOP:  "option stop",
  EOD:       "EOD",
};

// ── Env readers — the same finite/range guards the engine uses ───────────────
function _numEnv(key, def, min, max) {
  const v = parseFloat(process.env[key]);
  if (!Number.isFinite(v)) return def;
  if (min != null && v < min) return def;
  if (max != null && v > max) return def;
  return v;
}
/** The simulation's own knobs (SAIL-scaled; NOT the NIFTY BACKTEST_* keys). */
function btConfig() {
  return {
    SLIPPAGE_PTS: _numEnv("SAIL_VWAP_ST_BT_SLIPPAGE_PTS", 0.05, 0, 5),
    SEED_PREMIUM: _numEnv("SAIL_VWAP_ST_BT_SEED_PREMIUM", 5, 0.05, 1000),
    DELTA:        _numEnv("SAIL_VWAP_ST_BT_DELTA", 0.5, 0.05, 1),
    THETA_DAY:    _numEnv("SAIL_VWAP_ST_BT_THETA_DAY", 0.1, 0, 100),
  };
}
/** The repo-wide common exits, read live from tradeGuards (the getters paper's calls use). */
function guardConfig() {
  return {
    lockEnabled:   tradeGuards.PROFIT_LOCK_ENABLED,
    lockArmPct:    tradeGuards.PROFIT_LOCK_ARM_PCT,
    lockFloorPct:  tradeGuards.PROFIT_LOCK_FLOOR_PCT,
    lockTrailPct:  tradeGuards.PROFIT_LOCK_TRAIL_PCT,
    lockTiers:     tradeGuards.PROFIT_LOCK_TRAIL_TIERS,
    beEnabled:     tradeGuards.BREAKEVEN_STOP_ENABLED,
    beArmPct:      tradeGuards.BREAKEVEN_ARM_PCT,
  };
}
/** Contracts per trade — engine.lotQty() with paper's MAX_LOT_MULTIPLIER clamp on the lot count. */
function qtyFor(cfg) {
  let maxMult = parseInt(process.env.MAX_LOT_MULTIPLIER || "10", 10);
  if (!Number.isFinite(maxMult) || maxMult < 1) maxMult = 10;
  return engine.lotQty(Object.assign({}, cfg, { LOTS: Math.min(cfg.LOTS, maxMult) }));
}

// ── Time helpers ─────────────────────────────────────────────────────────────
function _r2(x) { return Math.round(x * 100) / 100; }
function _fmtMins(mins) { return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`; }
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
/** `dateStr` shifted by `days`, as YYYY-MM-DD. */
function _shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
/** Calendar days of runway fetched before `from` — the same sizing as paper's preload fetch. */
function runwayCalendarDays() { return engine.warmupDays() * 2 + 7; }

function _quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return _r2(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

/**
 * simulate(candles, opts) — PURE. No broker, no network, no disk. Synchronous
 * and O(n): indicators are computed once, getSignal/trailStop read them through
 * their `precomputed` options.
 *
 *   candles — ascending closed bars { time (unix s), open, high, low, close, volume }
 *             on the trade timeframe, INCLUDING the warm-up runway.
 *   opts.tradeFrom    — "YYYY-MM-DD": the first IST day a trade may be taken.
 *                       Default: the first day with engine.warmupDays() earlier
 *                       sessions in the array (so a bare array still has a runway).
 *   opts.tradeTo      — "YYYY-MM-DD": the last IST day a trade may be ENTERED.
 *   opts.cfgOverrides — merged over engine.getConfig() (e.g. { BREAKOUT_BARS: 2 }).
 *   opts.bt           — merged over btConfig() (SLIPPAGE_PTS/SEED_PREMIUM/DELTA/THETA_DAY).
 *   opts.guards       — merged over guardConfig() (profit lock / breakeven).
 *
 * Returns { trades, stats, days, funnel, exitMix, stopDist, params }.
 */
function simulate(candles, opts) {
  const o = opts || {};
  const cfg = Object.assign({}, engine.getConfig(), o.cfgOverrides || {});
  const bt  = Object.assign({}, btConfig(), o.bt || {});
  const g   = Object.assign({}, guardConfig(), o.guards || {});
  const RES = cfg.TRADE_RES;
  const QTY = qtyFor(cfg);
  const SLIP = bt.SLIPPAGE_PTS, SEED = bt.SEED_PREMIUM, DELTA = bt.DELTA, THETA = bt.THETA_DAY;
  const lockOpts = { enabled: g.lockEnabled, armPct: g.lockArmPct, floorPct: g.lockFloorPct, trailPct: g.lockTrailPct, tiers: g.lockTiers };
  const beOpts   = { enabled: g.beEnabled, armPct: g.beArmPct };

  const bars = (Array.isArray(candles) ? candles : [])
    .filter(c => c && Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) &&
                 Number.isFinite(c.low) && Number.isFinite(c.close))
    .slice().sort((a, b) => a.time - b.time);
  const n = bars.length;
  const funnel = {
    sessions: 0, runwaySessions: 0, confirmed: 0, entries: 0,
    skipWindow: 0, skipStDisagrees: 0, blockedDayCap: 0, blockedDayLoss: 0,
    blockedExitBar: 0, blockedPastEod: 0, noNextBar: 0, gapThroughStop: 0,
  };
  const empty = { trades: [], stats: computeBacktestStats([]), days: 0, funnel, exitMix: {}, stopDist: null, params: { cfg, bt, guards: g, qty: QTY } };
  if (!n) return empty;

  const dayOf = bars.map(c => engine._istDayOf(c.time));
  // tradeFrom default: the first day with warmupDays() earlier sessions present.
  const dayList = [...new Set(dayOf)];
  let fromDay;
  if (o.tradeFrom) fromDay = Math.floor((Date.parse(`${o.tradeFrom}T00:00:00Z`) / 1000) / 86400);
  else fromDay = dayList.length > engine.warmupDays() ? dayList[engine.warmupDays()] : Infinity;
  const toDay = o.tradeTo ? Math.floor((Date.parse(`${o.tradeTo}T00:00:00Z`) / 1000) / 86400) : Infinity;
  for (const k of dayList) { if (k < fromDay) funnel.runwaySessions++; else if (k <= toDay) funnel.sessions++; }

  const series = engine.computeSeries(bars, cfg);
  const pre = { series, endIdx: 0, cfg };
  const preTrail = { supertrend: series.supertrend, endIdx: 0 };

  const trades = [];
  let pos = null;
  let curDay = null, dayTrades = 0, dayPnl = 0;

  /** Simulated MARKET premium at a raw spot and time (no slippage). */
  function premAt(spot, t) {
    const dir = pos.side === "CE" ? 1 : -1;
    const mins = Math.max(0, (t - pos.entryTime) / 60);
    // Rounded to paise like a real LTP, so the guard thresholds see a quotable price.
    return Math.max(0.05, _r2(SEED + dir * DELTA * (spot - pos.entrySpot) - THETA * mins / 375));
  }
  /** Inverse of premAt: the raw spot at which the premium equals `prem`. */
  function spotForPrem(prem, t) {
    const dir = pos.side === "CE" ? 1 : -1;
    const mins = Math.max(0, (t - pos.entryTime) / 60);
    return pos.entrySpot + dir * (prem - SEED + THETA * mins / 375) / DELTA;
  }

  function close(rawSpot, t, exitBarTime, kind, detail) {
    const dir = pos.side === "CE" ? 1 : -1;
    const exitSpot = _r2(rawSpot - dir * SLIP);            // sell into the adverse side
    const exitPrem = _r2(premAt(exitSpot, t));
    const charges = getCharges({ isFutures: false, entryPremium: SEED, exitPremium: exitPrem, qty: QTY });
    const pnl = _r2((exitPrem - SEED) * QTY - charges);
    dayPnl += pnl;
    trades.push({
      side: pos.side,
      signalBarTime: pos.signalBarTime, entryBarTime: pos.entryTime, exitBarTime,
      entrySpot: pos.entrySpot, exitSpot,
      stopLoss: pos.initialStop, finalStop: pos.stop,
      entryPremium: SEED, exitPremium: exitPrem, peakPremium: _r2(pos.peak),
      qty: QTY, pnl, charges, exitReason: kind, exitDetail: detail,
      stopDist: _r2(Math.abs(pos.entrySpot - pos.initialStop)),
      vwap: pos.vwap, crossLevel: pos.crossLevel,
      held: Math.max(0, Math.round((exitBarTime - pos.entryTime) / 60 / RES)),
      // backtestUI columns
      entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitBarTime),
      entryTs: pos.entryTime, exitTs: exitBarTime,
      ePrice: pos.entrySpot, xPrice: exitSpot, sl: pos.initialStop, target: null,
      reason: `${kind} — ${detail}`, entryReason: pos.entryReason, strength: "STRONG",
      eOpt: SEED, xOpt: exitPrem,
    });
    pos = null;
  }

  /** The common premium exits on one simulated tick. Returns the category or null. */
  function tickExitKind(cur) {
    const lock = tradeGuards.checkProfitLock(SEED, cur, pos.peak, lockOpts);
    if (lock) return { kind: EXIT.LOCK, detail: lock };
    const be = tradeGuards.checkBreakevenStop(SEED, cur, pos.peak, beOpts);
    if (be) return { kind: EXIT.BREAKEVEN, detail: be };
    if (cfg.OPT_STOP_PCT > 0) {
      const stopLtp = parseFloat((SEED * (1 - cfg.OPT_STOP_PCT)).toFixed(2));
      if (cur <= stopLtp) return { kind: EXIT.OPT_STOP, detail: `Option stop ${(cfg.OPT_STOP_PCT * 100).toFixed(0)}% — simulated premium ₹${_r2(cur)} ≤ ₹${stopLtp}`, level: stopLtp };
    }
    return null;
  }
  /** The premium level each kind fills at when crossed on the way down (open → adverse leg). */
  function levelFor(hit) {
    if (hit.kind === EXIT.LOCK) return tradeGuards.profitLockFloorLtp(SEED, pos.peak, g.lockFloorPct, g.lockTrailPct, g.lockTiers);
    if (hit.kind === EXIT.BREAKEVEN) return SEED;
    return hit.level;
  }

  for (let i = 0; i < n; i++) {
    const c = bars[i];
    const day = dayOf[i];
    if (day !== curDay) { curDay = day; dayTrades = 0; dayPnl = 0; }
    const barEnd = c.time + RES * 60;
    const startMin = engine._istMins(c.time);

    // ── 1. Tick exits inside this bar (the position may have opened at its open). ──
    if (pos) {
      const isCE = pos.side === "CE";
      if (startMin >= cfg.EOD_EXIT) {
        close(c.open, c.time, c.time, EXIT.EOD, `square-off ${_fmtMins(cfg.EOD_EXIT)} at the bar's open ${c.open}`);
      } else {
        // a) the open
        const pOpen = premAt(c.open, c.time);
        if (pOpen > pos.peak) pos.peak = pOpen;
        let hit = tickExitKind(pOpen);
        if (hit) {
          close(c.open, c.time, c.time, hit.kind, `${hit.detail} (bar opened through it — filled at the open ${c.open})`);
        } else {
          // b) open → adverse extreme: the highest armed level is crossed first.
          const adv = isCE ? c.low : c.high;
          const pAdv = premAt(adv, barEnd);
          hit = tickExitKind(pAdv);
          if (hit) {
            const lvl = levelFor(hit);
            const raw = spotForPrem(lvl, barEnd);
            // Never better than the open (the open did not trigger, so the level lies past it).
            const fill = isCE ? Math.min(c.open, raw) : Math.max(c.open, raw);
            close(fill, barEnd, c.time, hit.kind, `${hit.detail} — level premium ₹${_r2(lvl)} ≈ spot ${_r2(raw)}`);
          } else {
            // c) adverse → favourable extreme: the peak rises, nothing exits.
            const pFav = premAt(isCE ? c.high : c.low, c.time);
            if (pFav > pos.peak) pos.peak = pFav;
            // d) favourable → close: a lock/breakeven armed by THIS peak and given back.
            const pClose = premAt(c.close, barEnd);
            hit = tickExitKind(pClose);
            if (hit) close(c.close, barEnd, c.time, hit.kind, `${hit.detail} (armed and given back inside the bar — filled at the close ${c.close})`);
          }
        }
        // Mid-bar square-off (EOD not on a bar boundary): out at this bar's close.
        if (pos && engine._istMins(barEnd) > cfg.EOD_EXIT && startMin < cfg.EOD_EXIT) {
          close(c.close, barEnd, c.time, EXIT.EOD, `square-off ${_fmtMins(cfg.EOD_EXIT)} falls inside this bar — filled at its close ${c.close}`);
        }
      }
    }

    // ── 2. Candle-close exit test, then the trail. ────────────────────────────
    const next = i + 1 < n && dayOf[i + 1] === day ? bars[i + 1] : null;
    let exitedThisBar = false;
    if (pos) {
      const stBar = series.supertrend[i] || null;
      const ex = engine.exitCheck(pos.side, c, stBar, pos.stop);
      if (ex.exit) {
        const kind = /flipped/.test(ex.reason) ? EXIT.ST_FLIP : EXIT.ST_STOP;
        if (next) close(next.open, next.time, next.time, kind, `${ex.reason} (stop in force ${pos.stop}) — filled at the next open ${next.open}`);
        else      close(c.close, barEnd, barEnd, kind, `${ex.reason} (stop in force ${pos.stop}) — no next bar today, filled at the close`);
        exitedThisBar = true;
      } else {
        preTrail.endIdx = i;
        const tr = engine.trailStop(bars, pos.side, pos.stop, cfg, preTrail);
        if (tr && tr.changed && Number.isFinite(tr.stop)) pos.stop = tr.stop;
      }
    }

    // A day's data that ends with the position still open (half day / gap in data).
    if (pos && !next) {
      close(c.close, barEnd, barEnd, EXIT.EOD, `the day's candles ended at ${istHHMMSS(barEnd)} before the square-off — filled at the last close`);
    }

    // ── 3. The entry question on this bar's close. ────────────────────────────
    if (pos) continue;
    if (day < fromDay || day > toDay) continue;          // never trade the warm-up runway
    pre.endIdx = i;
    const sig = engine.getSignal(bars, { precomputed: pre, silent: true });
    if (sig.signal !== "BUY_CE" && sig.signal !== "BUY_PE") {
      if (sig.skipReason === "window") funnel.skipWindow++;
      else if (sig.skipReason === "st_disagrees") funnel.skipStDisagrees++;
      continue;
    }
    funnel.confirmed++;
    if (exitedThisBar) { funnel.blockedExitBar++; continue; }
    if (cfg.MAX_DAILY_LOSS > 0 && dayPnl <= -cfg.MAX_DAILY_LOSS) { funnel.blockedDayLoss++; continue; }
    if (dayTrades >= cfg.MAX_DAILY_TRADES) { funnel.blockedDayCap++; continue; }
    if (!next) { funnel.noNextBar++; continue; }
    if (engine._istMins(next.time) >= cfg.EOD_EXIT) { funnel.blockedPastEod++; continue; }

    const side = sig.signal === "BUY_CE" ? "CE" : "PE";
    const dir = side === "CE" ? 1 : -1;
    const entrySpot = _r2(next.open + dir * SLIP);         // buy into the adverse side
    // Paper does not refuse a fill that opened beyond the stop; neither does this.
    if ((side === "CE" && next.open <= sig.stopLoss) || (side === "PE" && next.open >= sig.stopLoss)) funnel.gapThroughStop++;
    pos = {
      side, signalBarTime: c.time, entryTime: next.time, entrySpot,
      stop: sig.stopLoss, initialStop: sig.stopLoss, peak: SEED,
      vwap: sig.vwap, crossLevel: sig.crossLevel, entryReason: sig.reason,
    };
    dayTrades++;
    funnel.entries++;
  }
  // The array ended with a position open (cannot happen once each day's last bar closes it).
  if (pos) {
    const c = bars[n - 1];
    close(c.close, c.time + RES * 60, c.time + RES * 60, EXIT.EOD, "data ended — filled at the last close");
  }

  const exitMix = {};
  for (const t of trades) exitMix[t.exitReason] = (exitMix[t.exitReason] || 0) + 1;
  const dists = trades.map(t => t.stopDist).filter(Number.isFinite).sort((a, b) => a - b);
  const stopDist = dists.length ? { p10: _quantile(dists, 0.1), median: _quantile(dists, 0.5), p90: _quantile(dists, 0.9) } : null;
  return {
    trades,
    stats: computeBacktestStats(trades),
    days: funnel.sessions,
    funnel, exitMix, stopDist,
    params: { cfg, bt, guards: g, qty: QTY },
  };
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
  const cfg = engine.getConfig();
  const bt = btConfig();
  const f = meta.funnel || {};
  const mix = meta.exitMix || {};
  const sd = meta.stopDist;
  const u = _u();
  const html = renderBacktestResults({
    mode: "SAIL_VWAP_ST",
    accent: ACCENT,
    strategyName: engine.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "sailVwapStBacktest",
    extraTradeColumns: [
      { key: "vwap", label: "VWAP" },
      { key: "crossLevel", label: "Cross lvl" },
      { key: "stopDist", label: "Stop ₹" },
      { key: "finalStop", label: "Final stop" },
      { key: "exitReason", label: "Exit" },
      { key: "held", label: "Held" },
    ],
    extraStats: [
      { label: "Profit Factor", value: inf(stats.profitFactor) },
      { label: "Expectancy /trade", value: `₹${stats.expectancy}` },
      { label: "Max Drawdown", value: `₹${stats.maxDrawdown}` },
      { label: "Sessions scanned", value: f.sessions || 0, sub: `${f.runwaySessions || 0} warm-up session(s) before ${escHtml(from)} — never traded` },
      { label: "Breakouts confirmed", value: f.confirmed || 0, sub: `${f.entries || 0} entered · ${f.blockedDayCap || 0} day-cap · ${f.blockedDayLoss || 0} loss-cap · ${f.blockedExitBar || 0} exit-bar` },
      { label: "Skipped — outside window", value: f.skipWindow || 0 },
      { label: "Skipped — SuperTrend disagreed", value: f.skipStDisagrees || 0 },
      { label: "Exit mix", value: Object.keys(mix).length ? Object.entries(mix).map(([k, v]) => `${escHtml(k)} ${v}`).join(" · ") : "—" },
      { label: "Stop distance (₹ SAIL)", value: sd ? `${sd.median}` : "—", sub: sd ? `p10 ${sd.p10} · p90 ${sd.p90}` : "" },
      { label: "Entry opened past the stop", value: f.gapThroughStop || 0, sub: "taken anyway — paper does not refuse them" },
    ],
    notes: `<b>Instrument:</b> ${escHtml(u.label)} stock (<code>${escHtml(u.spot)}</code>) ${cfg.TRADE_RES}-min candles with volume; ATM monthly SAIL options, lot ${u.lotSize} × ${cfg.LOTS} lot(s). <b>Entry:</b> a candle closes across the session VWAP (hlc3, volume-weighted, restarts daily), then within ${cfg.BREAKOUT_BARS} candles one closes beyond the cross candle's high (CE) / low (PE) with every close staying on that side of VWAP, and SuperTrend(${cfg.ST_PERIOD},${cfg.ST_MULT}) agrees. Signal-candle close ${_fmtMins(cfg.ENTRY_START)}–${_fmtMins(cfg.ENTRY_END)}; filled at the NEXT bar's open (= paper's first tick after the close). <b>Exits:</b> on each candle close a SuperTrend flip or a close through the trailed SuperTrend stop (filled at the next open); on ticks the profit lock, breakeven and a ${(cfg.OPT_STOP_PCT * 100).toFixed(0)}% option stop; square-off ${_fmtMins(cfg.EOD_EXIT)}. Max ${cfg.MAX_DAILY_TRADES} trade(s)/day, day ends on a ₹${cfg.MAX_DAILY_LOSS} loss. <b>THE OPTION PREMIUM IS SIMULATED</b> — there is no historical option chain: premium = ₹${bt.SEED_PREMIUM} seed + δ ${bt.DELTA} × spot move − θ ₹${bt.THETA_DAY}/day (<code>SAIL_VWAP_ST_BT_SEED_PREMIUM</code> / <code>_BT_DELTA</code> / <code>_BT_THETA_DAY</code>), and the P&amp;L, the profit lock, the breakeven and the option stop are all measured on that number, plus ₹${bt.SLIPPAGE_PTS} of SAIL spot slippage EACH way (<code>SAIL_VWAP_ST_BT_SLIPPAGE_PTS</code>). <b>Intra-bar ordering is conservative:</b> the adverse extreme is walked before the favourable one, a bar that opens through a level fills at the open, and a lock armed and given back inside one bar fills at the close. Treat ₹ as directional, not exact. <b>This strategy has NEVER traded, paper or live, and no threshold in it has been fitted.</b>`,
  });
  res.send(html);
}

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  if (!from || !to) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    return res.redirect(`${ENDPOINT}?from=${_shiftDate(today, -60)}&to=${today}`);
  }

  const jobId = req.query.jobId;
  if (!jobId) {
    const activeJob = backtestJobs.getActiveJob();
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, TITLE));
    const { id } = backtestJobs.createJob("sail_vwap_st");
    (async () => {
      try {
        const cfg = engine.getConfig();
        const res_ = String(cfg.TRADE_RES);
        const runwayFrom = _shiftDate(from, -runwayCalendarDays());
        console.log(`🔍 SAIL_VWAP_ST Backtest job ${id}: ${from} → ${to} (warm-up runway from ${runwayFrom}, never traded)`);
        console.log(`   └ instrument: ${_u().label} (${SAIL_SPOT_SYMBOL}) ${res_}-min, lot ${_u().lotSize} — premium SIMULATED (seed ₹${btConfig().SEED_PREMIUM}, δ ${btConfig().DELTA}, θ ₹${btConfig().THETA_DAY}/day)`);
        backtestJobs.updateProgress(id, { phase: `Fetching ${res_}-min ${_u().label} candles (${SAIL_SPOT_SYMBOL})…`, pct: 25 });

        let candles = [];
        try {
          candles = await fetchCandles(SAIL_SPOT_SYMBOL, res_, runwayFrom, to);
        } catch (err) {
          backtestJobs.failJob(id, `Fyers refused the request for ${SAIL_SPOT_SYMBOL} ${runwayFrom} → ${to}: ${fyersErrText(err).slice(0, 300)}`);
          return;
        }
        if (!Array.isArray(candles) || candles.length < 50) {
          backtestJobs.failJob(id, (!candles || !candles.length)
            ? `Fyers returned no historical candles for ${SAIL_SPOT_SYMBOL} ${runwayFrom} → ${to}. Most often the Fyers session needs re-login — an expired token returns no data (NOT an auth error). Log in to Fyers again, then retry.`
            : `Only ${candles.length} candle(s) for ${runwayFrom} → ${to} — widen the range.`);
          return;
        }
        // VWAP is volume-weighted: a series with no volume cannot produce one signal.
        if (!candles.some(c => Number.isFinite(c.volume) && c.volume > 0)) {
          backtestJobs.failJob(id, `The ${SAIL_SPOT_SYMBOL} candles carry no volume, so the session VWAP cannot be computed and this strategy cannot take a single trade.`);
          return;
        }

        backtestJobs.updateProgress(id, { phase: `Running SAIL VWAP ST backtest (${candles.length.toLocaleString()} candles)…`, pct: 70 });
        await new Promise(resolve => setImmediate(resolve));
        const result = simulate(candles, { tradeFrom: from, tradeTo: to });
        const stats = result.stats;
        stats.optionSim = true;
        stats.delta = result.params.bt.DELTA;
        stats.thetaPerDay = result.params.bt.THETA_DAY;
        for (const t of result.trades) {
          console.log(`   ${t.pnl >= 0 ? "🟢" : "🔴"} ${t.entry} ${t.side} | spot ${t.entrySpot} → ${t.exitSpot} | SL ${t.stopLoss} → ${t.finalStop}` +
                      ` | prem ₹${t.entryPremium} → ₹${t.exitPremium} | ₹${t.pnl} | ${t.exitReason}`);
        }

        try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: res_ } }); }
        catch (e) { console.warn("[sail_vwap_st-backtest] saveResult failed:", e.message); }

        backtestJobs.completeJob(id, { trades: result.trades, stats, from, to, meta: { days: result.days, funnel: result.funnel, exitMix: result.exitMix, stopDist: result.stopDist } });
        console.log(`✅ SAIL_VWAP_ST Backtest job ${id} complete — ${result.trades.length} trades over ${result.days} sessions`);
      } catch (err) {
        console.error("[sail_vwap_st-backtest] job error:", err);
        backtestJobs.failJob(id, err.message);
      }
    })();
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, TITLE));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, TITLE));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));
  const { trades, stats, meta } = job.result;
  return _renderResults(res, from, to, trades, stats, meta || { days: 0, funnel: {}, exitMix: {}, stopDist: null });
});

function _errLightAttr() {
  return require("../utils/theme").resolveTheme() === "light" ? ' data-theme="light"' : "";
}

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html${_errLightAttr()}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${TITLE} — error</title>${faviconLink()}
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
// Offline / test entry point — pure, no broker or network call.
module.exports.simulate = simulate;
module.exports.EXIT = EXIT;
module.exports.btConfig = btConfig;

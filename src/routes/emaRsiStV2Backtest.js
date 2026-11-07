/**
 * EMA_RSI_ST_V2 BACKTEST — /ema_rsi_st_v2-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest on 5-minute NIFTY 50 INDEX candles for EMA_RSI_ST_V2.
 *
 * THE ENGINE OWNS THE RULES. Every entry decision comes from
 * src/strategies/ema_rsi_st_v2.js `getSignal()`. There is NO indicator maths and
 * NO threshold comparison in this file — if you find yourself typing `rsi >` or `ema20 >` here, you are writing a
 * second copy of the strategy and it WILL drift from paper.
 *
 * What this file re-implements is only the EXIT SEQUENCING, because the Paper
 * route is canonical in this repo and a backtest must mirror its semantics:
 *
 *   for each IST day:
 *     for each closed 5-min bar:
 *       manage the open position on THIS bar   (the profit lock, tick-ordered)
 *       square off at the session end           (TRADE_STOP_TIME / last bar)
 *       look for a new entry on the bar CLOSE  (engine getSignal)
 *
 * V2's EXIT SET — and this is the WHOLE list:
 *   1. The global profit lock (tradeGuards.checkProfitLock) on the simulated
 *      option premium, with the peak premium tracked intra-bar — paper's only
 *      automatic exit.
 *   2. The session-end square-off — paper's TRADE_STOP_TIME teardown, or the
 *      day's last bar when the data ends first.
 * There is NO stop loss, NO trail, NO target, NO breakeven, NO time-stop, NO
 * signal exit, NO early square-off and NO loss-based day limit. Options only:
 * paper's lock is defined on option premium, so in futures mode it is off and a
 * trade runs to the session end.
 *
 * CONSERVATIVE INTRA-BAR ORDERING (this is where naive backtests lie):
 *   • each bar is walked open → adverse extreme → favourable extreme → close, so
 *     the lock is tested on the adverse leg BEFORE the favourable extreme can
 *     raise the peak;
 *   • a bar that OPENED already through the locked floor fills at the OPEN, never
 *     at the better floor level;
 *   • a spread/slippage haircut of BACKTEST_SLIPPAGE_PTS is applied EACH
 *     way — without it a backtest of option BUYING always flatters.
 *
 * CONFIRMATION CANDLE (EMA_RSI_ST_V2_CONFIRM_CANDLE_ENABLED, default ON): the
 * signal bar does NOT enter. Its CLOSE is armed as the trigger and the fill is
 * taken on the IMMEDIATELY-next bar via confirmCandle.barCrossFill — the same
 * market moment paper fills at on its first tick past the trigger.
 *
 * WARM-UP: the engine refuses below ~55 bars, which is MORE than one session, so
 * a naive fetch starting at `from` would silently take no trades for the first
 * day or two. A runway of EMA_RSI_ST_V2_WARMUP_DAYS (default 5) calendar days is
 * fetched BEFORE `from` purely to seed the indicators; no bar before `from` can
 * produce a trade (asserted at run time — see `warmupViolations`).
 *
 * THE PREMIUM IS SIMULATED. There is no historical option chain here, so P&L is
 * δ+θ modelled from the spot move. Treat ₹ as directional, not exact.
 */

const express = require("express");
const router  = express.Router();

const engine             = require("../strategies/ema_rsi_st_v2");
const confirmCandle      = require("../utils/confirmCandle");
const tradeGuards        = require("../utils/tradeGuards");
const { fetchCandles }   = require("../services/backtestEngine");
const { fyersErrText }   = require("../utils/fyersErr");
const { faviconLink }    = require("../utils/sharedNav");
const { getCharges }     = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult }     = require("../utils/resultStore");
const backtestJobs       = require("../utils/backtestJobManager");
const instrumentConfig   = require("../config/instrument");
const backtestCosts = require("../config/backtestCosts");

const ACCENT      = "#2563eb";
const ENDPOINT    = "/ema_rsi_st_v2-backtest";
const MODE_KEY    = "ema_rsi_st_v2";
const LABEL       = "EMA_RSI_ST_V2";
const RESULT_KEY  = "EMA_RSI_ST_V2_BACKTEST";
const SPOT_SYMBOL = "NSE:NIFTY50-INDEX";
const PAGE_TITLE  = "EMA_RSI_ST_V2 Backtest";

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
 * Guard config — V2's OWN prefixed keys. The one shared global read here is
 * TRADE_STOP_TIME, the session teardown paper's auto-stop also reads. V1 reads
 * TRADE_ENTRY_START / TRADE_ENTRY_END; reading those here would let a V1 tuning
 * session silently change V2's results.
 */
function getGuardConfig() {
  return {
    entryStartMin:  _parseMins("EMA_RSI_ST_V2_ENTRY_START", "10:30"),
    entryEndMin:    _parseMins("EMA_RSI_ST_V2_ENTRY_END",   "13:00"),
    // Session teardown — the same global key paper's auto-stop reads. Entries
    // stop 10 min before it (paper's _ENTRY_STOP_MINS).
    sessionStopMin: _parseMins("TRADE_STOP_TIME", "15:30"),
    warmupDays:     _int("EMA_RSI_ST_V2_WARMUP_DAYS", "5"),
    slippagePts:    backtestCosts.slippagePts(),
    seedPremium:    backtestCosts.seedPremium(),
    resolutionMins: _int("TRADE_RESOLUTION", "5"),
    confirmEnabled: confirmCandle.enabled("EMA_RSI_ST_V2"),
  };
}

// ── The engine loop ─────────────────────────────────────────────────────────
/**
 * runEmaRsiStV2Backtest(candles, activeFromTs)
 *
 * `candles` includes the warm-up runway; `activeFromTs` is the unix second at
 * which the REQUESTED range begins. Bars before it feed the indicators and are
 * never allowed to open a trade — `warmupViolations` counts any attempt, and a
 * non-zero count is a bug in this file, surfaced on the results page rather than
 * swallowed.
 */
async function runEmaRsiStV2Backtest(candles, activeFromTs) {
  const empty = {
    trades: [], days: 0, warmupViolations: 0, warmupBars: 0,
    gateStats: { setups: 0, confirmArmed: 0, confirmFilled: 0, confirmExpired: 0,
                 blockedWarmup: 0, blockedWindow: 0,
                 blockedReentry: 0 },
  };
  if (!Array.isArray(candles) || !candles.length) return empty;

  const g = getGuardConfig();
  const stratCfg = engine.getConfig();

  // FUTURES MODE — index points are rupees 1:1: no delta, no theta, and the
  // "premium" the sim carries IS the spot level.
  const IS_FUT    = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const DELTA     = IS_FUT ? 1.0 : _num("BACKTEST_DELTA", "0.55");
  const THETA_DAY = IS_FUT ? 0   : _num("BACKTEST_THETA_DAY", "8");
  const LOT_SIZE  = instrumentConfig.getLotQty();
  const RES       = g.resolutionMins > 0 ? g.resolutionMins : 5;
  const SLIP      = g.slippagePts;
  // Global wait-after-any-exit cooldown (EXIT_REENTRY_COOLDOWN_CANDLES), secs.
  // Paper measures it from the exit's clock time: a tick exit (the lock) fires
  // INSIDE the bar (≈ bar open here), a candle-close exit at the bar's CLOSE.
  const REENTRY_COOLDOWN_SECS = tradeGuards.reentryCooldownMs(RES) / 1000;
  // The global profit lock — the ONLY automatic exit, read from the same live
  // getters paper's checkProfitLock() call uses, snapshotted for the run.
  // Options only (paper's lock is defined on premium; in futures mode the
  // "premium" here IS spot and the lock would test an 8% move in the index).
  const lockOpts = {
    enabled:  tradeGuards.PROFIT_LOCK_ENABLED,
    armPct:   tradeGuards.PROFIT_LOCK_ARM_PCT,
    floorPct: tradeGuards.PROFIT_LOCK_FLOOR_PCT,
    trailPct: tradeGuards.PROFIT_LOCK_TRAIL_PCT,
    tiers:    tradeGuards.PROFIT_LOCK_TRAIL_TIERS,
  };
  const LOCK_ON = !IS_FUT && lockOpts.enabled;
  const ENTRY_CUTOFF_MIN = g.sessionStopMin - 10;

  const sorted = candles.slice().sort((a, b) => a.time - b.time);

  const trades = [];
  const gateStats = Object.assign({}, empty.gateStats);
  let warmupViolations = 0;
  let warmupBars = 0;
  for (const c of sorted) if (c.time < activeFromTs) warmupBars++;

  // Day boundaries. Per-session state (cooldowns, the open position) resets per
  // IST session, exactly as paper's per-day state does.
  const dayKeys = [];
  const byDay = new Map();
  for (const c of sorted) {
    const k = _istDateOf(c.time);
    if (!byDay.has(k)) { byDay.set(k, []); dayKeys.push(k); }
    byDay.get(k).push(c);
  }

  // The engine needs history ACROSS days (warm-up is longer than one session),
  // so getSignal is always handed the running prefix of ALL bars, not
  // just the current day's. `globalIdx` maps a day-local bar back to that prefix.
  const globalIndex = new Map();
  for (let i = 0; i < sorted.length; i++) globalIndex.set(sorted[i].time, i);

  // Indicator series computed ONCE over every bar, then read at each bar's
  // global index. EMA/RSI/ATR-SuperTrend are causal forward recursions, so the
  // value at gIdx over the full array is bit-identical to the last value over
  // sorted.slice(0, gIdx + 1) — the per-bar prefix copy + full recompute this
  // replaces was O(n²) and blocked the event loop for seconds on a long range.
  // stratCfg is also the snapshot the engine reads for the whole run.
  const fullSeries = engine.computeSeries(sorted, stratCfg);

  let days = 0;

  for (const k of dayKeys) {
    // Yield once per session so live ticks/orders sharing this process are not
    // starved while a long backtest runs.
    await new Promise(resolve => setImmediate(resolve));
    const bars = byDay.get(k);
    if (!bars || !bars.length) continue;
    // Only sessions inside the requested range count as "scanned".
    if (bars[bars.length - 1].time >= activeFromTs) days++;

    let reentryBlockUntilTs = 0;   // wait-after-any-exit — no entry on a bar opening before this
    let pos = null;
    let armed = null;              // { side, triggerLevel, barTime, signal }

    /** δ+θ simulated premium at `exitPx`, before the slippage haircut. */
    function premiumAt(exitPx, exitTime) {
      const barsHeld   = Math.max(0, (exitTime - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost  = (THETA_DAY * barsHeld) / barsPerDay;
      const move = pos.side === "CE" ? (exitPx - pos.entrySpot) : (pos.entrySpot - exitPx);
      return Math.max(0.05, pos.optionEntryLtp + move * DELTA - thetaCost / LOT_SIZE);
    }

    /** The spot at which premiumAt() equals `prem` — inverts the δ+θ model so a
     *  profit-lock fill on the adverse leg books the floor premium, not a guess. */
    function spotForPremium(prem, exitTime) {
      if (!(DELTA > 0)) return pos.entrySpot;
      const barsHeld   = Math.max(0, (exitTime - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost  = (THETA_DAY * barsHeld) / barsPerDay;
      const move = (prem - pos.optionEntryLtp + thetaCost / LOT_SIZE) / DELTA;
      return pos.side === "CE" ? pos.entrySpot + move : pos.entrySpot - move;
    }

    /** Net P&L of closing at `exitPx`, with slippage BOTH ways and real charges. */
    function priceAt(exitPx, exitTime) {
      const raw      = premiumAt(exitPx, exitTime);
      const exitPrem = Math.max(0.05, raw - 2 * SLIP);   // buy high + sell low
      const charges  = getCharges({
        broker: "zerodha", isFutures: IS_FUT,
        entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE,
      });
      return {
        pnl:      parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2)),
        exitPrem: parseFloat(exitPrem.toFixed(2)),
        held:     Math.round((exitTime - pos.entryTime) / 60 / RES),
      };
    }

    function close(exitPx, exitTime, reason, globalIdx, atBarClose = false) {
      const p = priceAt(exitPx, exitTime);
      const spotPts = parseFloat(
        (pos.side === "CE" ? exitPx - pos.entrySpot : pos.entrySpot - exitPx).toFixed(2));

      trades.push({
        side:  pos.side,
        entry: _tsStr(pos.entryTime), exit: _tsStr(exitTime),
        entryTs: pos.entryTime,       exitTs: exitTime,
        ePrice: parseFloat(pos.entrySpot.toFixed(2)),
        xPrice: parseFloat(exitPx.toFixed(2)),
        spotPts,
        rsi:  pos.rsi, ema20: pos.ema20, ema50: pos.ema50,
        peakPremium: parseFloat(pos.peak.toFixed(2)),
        pnl:  p.pnl,
        reason,
        entryReason: pos.entryReason,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.held,
      });

      // Wait-after-any-exit cooldown — every exit reason, both sides.
      if (REENTRY_COOLDOWN_SECS > 0) {
        reentryBlockUntilTs = exitTime + (atBarClose ? RES * 60 : 0) + REENTRY_COOLDOWN_SECS;
      }
      pos = null;
      armed = null;
    }

    /** Why this side cannot be taken right now, or null if it can. */
    function entryBlockedReason(side, gIdx, barTime) {
      const istMin = _istMins(barTime);
      // WARM-UP RUNWAY. Bars before the requested range exist ONLY to seed the
      // indicators — the engine refuses below ~55 candles, which is more than one
      // session, so without a runway the first day or two of every run would
      // silently take no trades. Blocking here (rather than only at the fill)
      // keeps a runway bar from ever arming a confirmation, so the first REAL bar
      // of the range starts from a clean slate exactly as a fresh paper session
      // would. `warmupViolations` in openPosition is the belt-and-braces assertion
      // that this gate actually holds.
      if (barTime < activeFromTs) return "blockedWarmup";
      // The engine already refuses outside its own window, but the SIGNAL bar's
      // close is what arms — re-checking here keeps the funnel counters honest.
      if (istMin < g.entryStartMin || istMin >= g.entryEndMin || istMin >= ENTRY_CUTOFF_MIN) return "blockedWindow";
      return null;
    }

    function openPosition(side, entrySpot, entryTime, sig, gIdx) {
      // The warm-up runway exists ONLY to seed indicators. If a bar before the
      // requested range ever opens a trade, the runway is leaking into results —
      // count it and refuse the trade rather than quietly reporting it.
      if (entryTime < activeFromTs) { warmupViolations++; return; }

      const entryPrem = IS_FUT ? entrySpot : g.seedPremium;
      // Entry premium carries the slippage haircut too (we buy high).
      const entryPremSlipped = parseFloat(Math.max(0.05, entryPrem + SLIP).toFixed(2));

      pos = {
        side,
        entryTime,
        entrySpot,
        optionEntryLtp: entryPremSlipped,
        peak:           entryPremSlipped,   // best simulated premium — the lock's peak
        rsi:   sig.rsi   != null ? sig.rsi   : null,
        ema20: sig.ema20 != null ? sig.ema20 : null,
        ema50: sig.ema50 != null ? sig.ema50 : null,
        entryReason: sig.reason || `${side} setup`,
      };
    }

    for (let i = 0; i < bars.length; i++) {
      const c = bars[i];
      const gIdx = globalIndex.get(c.time);
      const istMin = _istMins(c.time);
      // The engine reads ALL bars up to and including this one (endIdx = gIdx) —
      // its warm-up is longer than one session, so it must see previous days too.
      const pre = { series: fullSeries, endIdx: gIdx, cfg: stratCfg };

      // ── 1. Manage an open position on THIS bar — the profit lock ───────────
      // The global profit lock is the ONLY automatic exit. The bar is walked
      // open → adverse extreme → favourable extreme → close, so the lock is
      // tested on the adverse leg BEFORE the favourable extreme raises the peak.
      if (pos && LOCK_ON) {
        const isCE = pos.side === "CE";
        const entryPrem = pos.optionEntryLtp;
        // Simulated premium at a spot level on this bar, in paise like a real quote.
        const prem = (px) => Math.round(premiumAt(px, c.time) * 100) / 100;
        // a) the open
        const pOpen = prem(c.open);
        if (pOpen > pos.peak) pos.peak = pOpen;
        let lock = tradeGuards.checkProfitLock(entryPrem, pOpen, pos.peak, lockOpts);
        if (lock) {
          close(c.open, c.time, `${lock} (bar opened through it — filled at the open ${c.open})`, gIdx);
        } else {
          // b) open → adverse extreme: the floor set by the peak so far is crossed.
          const adverse = isCE ? c.low : c.high;
          lock = tradeGuards.checkProfitLock(entryPrem, prem(adverse), pos.peak, lockOpts);
          if (lock) {
            const floor = tradeGuards.exitLevelLtp(entryPrem, pos.peak, lockOpts);
            const raw = spotForPremium(floor, c.time);
            // Never better than the open — the open did not trigger, so the floor lies past it.
            const fill = isCE ? Math.min(c.open, raw) : Math.max(c.open, raw);
            close(fill, c.time, `${lock} — floor premium ₹${floor} ≈ spot ${fill.toFixed(2)}`, gIdx);
          } else {
            // c) adverse → favourable extreme: the peak rises, nothing exits.
            const pFav = prem(isCE ? c.high : c.low);
            if (pFav > pos.peak) pos.peak = pFav;
            // d) favourable → close: a lock armed by THIS bar's peak and given back.
            lock = tradeGuards.checkProfitLock(entryPrem, prem(c.close), pos.peak, lockOpts);
            if (lock) close(c.close, c.time, `${lock} (armed and given back inside the bar — filled at the close ${c.close})`, gIdx, true);
          }
        }
      }

      // ── 2. Session-end square-off — paper's TRADE_STOP_TIME teardown ───────
      if (pos && istMin + RES >= g.sessionStopMin) {
        close(c.close, c.time, `Session end — squared off at the close of the bar ending at/after ${_fmtMins(g.sessionStopMin)} IST`, gIdx, true);
      }

      // ── 3. Read the engine on this bar's CLOSE (entry search only) ─────────
      const sig = engine.getSignal(sorted, { silent: true, precomputed: pre });
      const sigSide = sig.signal === "BUY_CE" ? "CE" : sig.signal === "BUY_PE" ? "PE" : null;

      // ── 4. Confirmation-candle fill ────────────────────────────────────────
      // An armed trigger is valid for exactly ONE bar: the immediately-next one.
      if (!pos && armed) {
        if (confirmCandle.isNextBar(c.time, armed.barTime, RES)) {
          const fill = confirmCandle.barCrossFill(armed.side, c, armed.triggerLevel);
          // The entry window is honoured on the CONFIRMATION bar too — a trigger
          // armed at 12:59 must not fill at 13:04.
          const inWindow = istMin >= g.entryStartMin && istMin < g.entryEndMin && istMin < ENTRY_CUTOFF_MIN;
          const reentryBlocked = c.time < reentryBlockUntilTs;
          if (fill != null && inWindow && !reentryBlocked) {
            openPosition(armed.side, fill, c.time, armed.signal, gIdx);
            gateStats.confirmFilled++;
          } else {
            if (fill != null && !inWindow) gateStats.blockedWindow++;
            else if (fill != null && reentryBlocked) gateStats.blockedReentry++;
            gateStats.confirmExpired++;
          }
          armed = null;
        } else {
          // Not the immediately-next bar (a day gap, or a bar was skipped) —
          // the trigger expires rather than firing late.
          gateStats.confirmExpired++;
          armed = null;
        }
      }

      // ── 5. Look for a NEW setup on this bar's close ────────────────────────
      if (!pos && sigSide) {
        const blocked = entryBlockedReason(sigSide, gIdx, c.time);
        // Warm-up setups are not part of the requested range's funnel — counting
        // them under `setups` would inflate every ratio on the results page.
        if (blocked !== "blockedWarmup") gateStats.setups++;
        if (blocked) {
          gateStats[blocked] = (gateStats[blocked] || 0) + 1;
        } else if (g.confirmEnabled) {
          // Arm — the signal bar itself never enters. Its CLOSE is the trigger.
          armed = {
            side: sigSide,
            triggerLevel: Number.isFinite(sig.triggerLevel) ? sig.triggerLevel : c.close,
            barTime: c.time,
            signal: sig,
          };
          gateStats.confirmArmed++;
        } else if (c.time < reentryBlockUntilTs) {
          // Confirmation off — paper's simulateBuy rejects inside the wait-after-exit window.
          gateStats.blockedReentry++;
        } else {
          // Confirmation off — paper enters at the signal bar's close.
          openPosition(sigSide, c.close, c.time, sig, gIdx);
        }
      }
    }

    // Anything still open at the last bar of the session is squared off there.
    if (pos) {
      const last = bars[bars.length - 1];
      close(last.close, last.time, "Session end — the day's candles ended before the square-off, filled at the last close", globalIndex.get(last.time), true);
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

function _renderResults(res, from, to, trades, stats, meta) {
  const inf = (x) => x === Infinity ? "∞" : x;
  const g   = getGuardConfig();
  const c   = engine.getConfig();
  const gs  = meta.gateStats || {};
  const wv  = meta.warmupViolations || 0;
  const lockOn    = tradeGuards.PROFIT_LOCK_ENABLED;
  const lockArm   = tradeGuards.PROFIT_LOCK_ARM_PCT;
  const lockFloor = tradeGuards.PROFIT_LOCK_FLOOR_PCT;
  const lockTrail = tradeGuards.PROFIT_LOCK_TRAIL_PCT;
  const lockTiers = tradeGuards.PROFIT_LOCK_TRAIL_TIERS;

  const html = renderBacktestResults({
    mode: LABEL,
    accent: ACCENT,
    strategyName: engine.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "emaRsiStV2Backtest",
    extraTradeColumns: [
      { key: "rsi",     label: "RSI" },
      { key: "ema20",   label: "EMA20" },
      { key: "ema50",   label: "EMA50" },
      { key: "peakPremium", label: "Peak prem" },
      { key: "spotPts", label: "Spot (pt)" },
      { key: "held",    label: "Held" },
    ],
    extraStats: [
      { label: "Profit Factor",        value: inf(stats.profitFactor) },
      { label: "Expectancy /trade",    value: `₹${stats.expectancy}` },
      { label: "Max Drawdown",         value: `₹${stats.maxDrawdown}` },
      { label: "Sessions scanned",     value: meta.days },
      { label: "Setups seen",          value: gs.setups || 0 },
      { label: "Confirmations armed",  value: gs.confirmArmed || 0 },
      { label: "Confirmations filled", value: gs.confirmFilled || 0 },
      { label: "Confirmations expired", value: gs.confirmExpired || 0 },
      { label: "Blocked — warm-up runway", value: gs.blockedWarmup || 0 },
      { label: "Blocked — entry window", value: gs.blockedWindow || 0 },
      { label: "Warm-up bars fetched",    value: meta.warmupBars || 0 },
      {
        label: "Warm-up leak", value: wv === 0 ? "none ✓" : `${wv} ⚠`,
        color: wv === 0 ? "#10b981" : "#ef4444",
        sub: wv === 0 ? "no pre-range bar traded" : "BUG — runway produced trades",
      },
      { label: "Trade frequency", value: meta.days ? `${((trades.length / meta.days) * 100).toFixed(1)}% of sessions` : "—" },
    ],
    notes:
      `${instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" ? "<b>FUTURES MODE</b> — P&L is index points × lot with futures charges, no δ/θ; a PE is a SHORT. " : ""}` +
      `<b>Rules come from the engine</b> (<code>src/strategies/ema_rsi_st_v2.js</code>) — this page re-implements only the exit sequencing, because Paper is canonical. ` +
      `<b>Entry:</b> CE = EMA${c.EMA_FAST} &gt; EMA${c.EMA_SLOW} AND the bar CLOSES above EMA${c.EMA_FAST} AND RSI(${c.RSI_PERIOD}) &gt; ${c.RSI_CE_MIN}; PE is the exact mirror (&lt;, &lt;, RSI &lt; ${c.RSI_PE_MAX}). ` +
      `There is deliberately <b>no SuperTrend entry gate and no RSI cap</b> — a CE may fire while SuperTrend is red, and RSI 95 is a valid CE. ` +
      `<b>Confirmation candle is ${g.confirmEnabled ? "ON" : "OFF"}</b> (<code>EMA_RSI_ST_V2_CONFIRM_CANDLE_ENABLED</code>)${g.confirmEnabled ? ": the signal bar never enters — its CLOSE is armed as the trigger and the fill is taken on the IMMEDIATELY-next bar, the same market moment paper fills at on its first tick past the trigger" : ": entry is the signal bar's close"}. ` +
      `<b>Exit:</b> the global profit lock is the ONLY automatic exit (arm +${lockArm}%, floor +${lockFloor}%, trail ${lockTrail}%${lockTiers ? `, tiers ${_escHtml(lockTiers)}` : ""} — the shared <code>PROFIT_LOCK_*</code> keys)${lockOn ? "" : " — <b>currently OFF</b>"}${instrumentConfig.INSTRUMENT === "NIFTY_FUTURES" ? " — off in futures mode (it is defined on option premium)" : ""}, tested on the simulated premium with the peak tracked intra-bar. Anything still open is squared off at the session end (${_fmtMins(g.sessionStopMin)} IST, <code>TRADE_STOP_TIME</code>) or the day's last bar. ` +
      `There is <b>no stop loss, no trail, no target</b>, no breakeven, no time-stop, no signal exit and no early square-off. ` +
      `<b>Guards (V2's own keys):</b> entries ${_fmtMins(g.entryStartMin)}–${_fmtMins(g.entryEndMin)}, plus the global wait-after-exit cooldown. No loss-based day limits. ` +
      `<b>Warm-up:</b> the engine refuses below ${engine.warmupBars(c)} candles — more than one session — so ${g.warmupDays} calendar days of runway are fetched BEFORE ${_escHtml(from)} purely to seed the indicators. ${meta.warmupBars || 0} such bars were loaded and ${wv === 0 ? "<b>none of them produced a trade</b> (asserted, not assumed)" : `<b>⚠ ${wv} produced a trade — this is a bug, do not trust these results</b>`}. ` +
      `<b>Intra-bar ordering is conservative:</b> each bar is walked open → adverse extreme → favourable extreme → close, so the lock is tested on the adverse leg before the favourable extreme can raise the peak, and a bar that opened through the locked floor fills at the OPEN. ` +
      `<b>P&L is simulated</b> — no historical option chain exists here, so premium is δ+θ modelled (BACKTEST_DELTA ${_num("BACKTEST_DELTA", "0.55")}, θ ₹${_num("BACKTEST_THETA_DAY", "8")}/day) seeded at ₹${g.seedPremium}, PLUS ${g.slippagePts}pt slippage EACH way (<code>BACKTEST_SLIPPAGE_PTS</code>) and real brokerage. Treat ₹ as directional, not exact.`,
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
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, PAGE_TITLE));

    const { id } = backtestJobs.createJob(MODE_KEY);
    (async () => {
      try {
        const g   = getGuardConfig();
        const res5 = String(g.resolutionMins);
        // The runway starts WARMUP_DAYS calendar days before `from`. Calendar,
        // not trading, days — weekends/holidays simply return no bars, so a
        // generous default is the safe direction to err in.
        const fetchFrom = _shiftDate(from, -Math.max(1, g.warmupDays));
        const activeFromTs = Math.floor(new Date(`${from}T00:00:00+05:30`).getTime() / 1000);

        console.log(`🔍 ${LABEL} Backtest job ${id}: ${from} → ${to} (runway from ${fetchFrom})`);
        backtestJobs.updateProgress(id, { phase: `Fetching ${res5}-min NIFTY candles (+${g.warmupDays}d warm-up runway)…`, pct: 20 });

        let candles = [];
        try {
          candles = await fetchCandles(SPOT_SYMBOL, res5, fetchFrom, to);
        } catch (err) {
          backtestJobs.failJob(id, `Fyers refused the candle request for ${fetchFrom} → ${to}: ${fyersErrText(err).slice(0, 300)}`);
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
            `Only ${candles.length} candle(s) for ${fetchFrom} → ${to}. The EMA_RSI_ST_V2 engine refuses below ${need} candles (more than one session), so this range cannot produce a single trade. Widen the range or raise EMA_RSI_ST_V2_WARMUP_DAYS (currently ${g.warmupDays}).`);
          return;
        }

        backtestJobs.updateProgress(id, { phase: `Running ${LABEL} backtest (${candles.length.toLocaleString()} candles)…`, pct: 70 });
        const result = await runEmaRsiStV2Backtest(candles, activeFromTs);

        const stats = computeBacktestStats(result.trades);
        stats.optionSim   = instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES";
        stats.delta       = _num("BACKTEST_DELTA", "0.55");
        stats.thetaPerDay = _num("BACKTEST_THETA_DAY", "8");

        if (result.warmupViolations > 0) {
          console.warn(`⚠ ${LABEL} Backtest job ${id}: ${result.warmupViolations} warm-up bar(s) attempted a trade — runway is leaking into results.`);
        }

        try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: res5 } }); }
        catch (e) { console.warn(`[${ENDPOINT}] saveResult failed:`, e.message); }

        backtestJobs.completeJob(id, {
          trades: result.trades, stats, from, to,
          meta: {
            days: result.days,
            gateStats: result.gateStats,
            warmupViolations: result.warmupViolations,
            warmupBars: result.warmupBars,
          },
        });
        console.log(`✅ ${LABEL} Backtest job ${id} complete — ${result.trades.length} trades over ${result.days} sessions`);
      } catch (err) {
        console.error(`[${ENDPOINT}] job error:`, err);
        backtestJobs.failJob(id, err.message);
      }
    })();
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
module.exports.runEmaRsiStV2Backtest = runEmaRsiStV2Backtest;

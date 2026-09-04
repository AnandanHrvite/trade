/**
 * EMA_RSI_ST_V2 BACKTEST — /ema_rsi_st_v2-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest on 5-minute NIFTY 50 INDEX candles for EMA_RSI_ST_V2.
 *
 * THE ENGINE OWNS THE RULES. Every entry decision comes from
 * src/strategies/ema_rsi_st_v2.js `getSignal()` and every stop advance from its
 * `trailStop()`. There is NO indicator maths and NO threshold comparison in this
 * file — if you find yourself typing `rsi >` or `ema20 >` here, you are writing a
 * second copy of the strategy and it WILL drift from paper.
 *
 * What this file re-implements is only the EXIT SEQUENCING, because the Paper
 * route is canonical in this repo and a backtest must mirror its semantics:
 *
 *   for each IST day:
 *     for each closed 5-min bar:
 *       manage the open position on THIS bar   (stop first, then favourable)
 *       advance the SuperTrend trail on the bar CLOSE
 *       look for a new entry on the bar CLOSE  (engine getSignal)
 *
 * V2's EXIT SET — deliberately tiny, and this is the WHOLE list:
 *   1. SuperTrend(10,2) stop, seeded at entry from the signal's own stopLoss and
 *      re-read at every bar close via engine.trailStop(), TIGHTEN-ONLY.
 *   2. Opposite-signal exit — the engine prints the other side while we are in.
 *   3. Hard square-off at EMA_RSI_ST_V2_EOD_EXIT_TIME (default 14:00 IST).
 * There is NO profit target, NO breakeven, NO time-stop, NO fixed-point stop, NO
 * option-premium stop, NO negative-candle stop, NO candle trail and NO EMA21
 * anything. V1 has all of those; V2 deleted them on purpose. Do not add them back.
 *
 * CONSERVATIVE INTRA-BAR ORDERING (this is where naive backtests lie):
 *   • the adverse STOP is tested on the bar's high/low BEFORE any favourable exit
 *     on the close, so a bar that touched both books the LOSS;
 *   • a bar that OPENED already beyond the stop fills at the OPEN, never at the
 *     better stop level — no assuming a fill the market never offered;
 *   • the trail advances only on a bar CLOSE, matching paper, so the stop can
 *     never tighten onto a level the bar merely traded through;
 *   • a spread/slippage haircut of EMA_RSI_ST_V2_BT_SLIPPAGE_PTS is applied EACH
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
const { fetchCandles }   = require("../services/backtestEngine");
const { fyersErrText }   = require("../utils/fyersErr");
const { faviconLink }    = require("../utils/sharedNav");
const { getCharges }     = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult }     = require("../utils/resultStore");
const backtestJobs       = require("../utils/backtestJobManager");
const instrumentConfig   = require("../config/instrument");

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
 * Guard config — V2's OWN prefixed keys, never the shared globals.
 * V1 reads MAX_DAILY_TRADES / MAX_DAILY_LOSS / TRADE_ENTRY_START / TRADE_ENTRY_END;
 * reading those here would let a V1 tuning session silently change V2's results.
 */
function getGuardConfig() {
  return {
    entryStartMin:  _parseMins("EMA_RSI_ST_V2_ENTRY_START", "10:30"),
    entryEndMin:    _parseMins("EMA_RSI_ST_V2_ENTRY_END",   "13:00"),
    eodExitMin:     _parseMins("EMA_RSI_ST_V2_EOD_EXIT_TIME", "14:00"),
    maxDailyTrades: _int("EMA_RSI_ST_V2_MAX_DAILY_TRADES", "2"),
    maxDailyLoss:   _num("EMA_RSI_ST_V2_MAX_DAILY_LOSS",   "1000"),
    maxConsecLosses: _int("EMA_RSI_ST_V2_MAX_CONSEC_LOSSES", "2"),
    slPauseCandles: _int("EMA_RSI_ST_V2_SL_PAUSE_CANDLES", "2"),
    oppCooldownEnabled: _bool("EMA_RSI_ST_V2_OPPOSITE_SIDE_COOLDOWN_ENABLED", "true"),
    oppCooldownCandles: _int("EMA_RSI_ST_V2_OPPOSITE_SIDE_COOLDOWN_CANDLES", "2"),
    warmupDays:     _int("EMA_RSI_ST_V2_WARMUP_DAYS", "5"),
    slippagePts:    _num("EMA_RSI_ST_V2_BT_SLIPPAGE_PTS", "2"),
    seedPremium:    _num("EMA_RSI_ST_V2_BT_SEED_PREMIUM", "180"),
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
function runEmaRsiStV2Backtest(candles, activeFromTs) {
  const empty = {
    trades: [], days: 0, warmupViolations: 0, warmupBars: 0,
    gateStats: { setups: 0, confirmArmed: 0, confirmFilled: 0, confirmExpired: 0,
                 blockedWarmup: 0, blockedWindow: 0, blockedMaxTrades: 0,
                 blockedDayLoss: 0, blockedConsecLoss: 0, blockedSlPause: 0,
                 blockedOppCooldown: 0 },
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

  const sorted = candles.slice().sort((a, b) => a.time - b.time);

  const trades = [];
  const gateStats = Object.assign({}, empty.gateStats);
  let warmupViolations = 0;
  let warmupBars = 0;
  for (const c of sorted) if (c.time < activeFromTs) warmupBars++;

  // Day boundaries. Guards (trade count, day loss, consecutive losses, pauses)
  // all reset per IST session, exactly as paper's per-day state does.
  const dayKeys = [];
  const byDay = new Map();
  for (const c of sorted) {
    const k = _istDateOf(c.time);
    if (!byDay.has(k)) { byDay.set(k, []); dayKeys.push(k); }
    byDay.get(k).push(c);
  }

  // The engine needs history ACROSS days (warm-up is longer than one session),
  // so getSignal/trailStop are always handed the running prefix of ALL bars, not
  // just the current day's. `globalIdx` maps a day-local bar back to that prefix.
  const globalIndex = new Map();
  for (let i = 0; i < sorted.length; i++) globalIndex.set(sorted[i].time, i);

  let days = 0;

  for (const k of dayKeys) {
    const bars = byDay.get(k);
    if (!bars || !bars.length) continue;
    // Only sessions inside the requested range count as "scanned".
    if (bars[bars.length - 1].time >= activeFromTs) days++;

    let dayPnl = 0, dayTrades = 0, dayClosed = false;
    let consecLosses = 0;
    let pauseUntilIdx = -1;        // SL_PAUSE_CANDLES — index (global) to resume at
    let oppCooldownSide = null;    // side we may NOT take
    let oppCooldownUntilIdx = -1;
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

    function close(exitPx, exitTime, reason, globalIdx) {
      const p = priceAt(exitPx, exitTime);
      dayPnl += p.pnl;
      const spotPts = parseFloat(
        (pos.side === "CE" ? exitPx - pos.entrySpot : pos.entrySpot - exitPx).toFixed(2));

      trades.push({
        side:  pos.side,
        entry: _tsStr(pos.entryTime), exit: _tsStr(exitTime),
        entryTs: pos.entryTime,       exitTs: exitTime,
        ePrice: parseFloat(pos.entrySpot.toFixed(2)),
        xPrice: parseFloat(exitPx.toFixed(2)),
        sl:     pos.slSpot,
        initialSL: pos.initialSlSpot,
        riskPts: Number.isFinite(pos.initialSlSpot)
          ? parseFloat(Math.abs(pos.entrySpot - pos.initialSlSpot).toFixed(2)) : null,
        spotPts,
        rsi:  pos.rsi, ema20: pos.ema20, ema50: pos.ema50,
        supertrend: pos.slSpot,
        pnl:  p.pnl,
        reason,
        entryReason: pos.entryReason,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.held,
      });

      if (p.pnl < 0) {
        consecLosses++;
        // A loss pauses fresh entries for SL_PAUSE_CANDLES bars, matching paper.
        if (g.slPauseCandles > 0) pauseUntilIdx = globalIdx + g.slPauseCandles;
      } else {
        consecLosses = 0;
      }
      if (g.oppCooldownEnabled && g.oppCooldownCandles > 0) {
        // Cool off the OPPOSITE side for N candles after any exit — flipping
        // straight into the other side on the same bar is how paper's cooldown
        // stops a whipsaw pair.
        oppCooldownSide     = pos.side === "CE" ? "PE" : "CE";
        oppCooldownUntilIdx = globalIdx + g.oppCooldownCandles;
      }
      pos = null;
      armed = null;

      // Day-level breakers — identical thresholds to the paper route.
      if (g.maxDailyLoss > 0 && dayPnl <= -g.maxDailyLoss) dayClosed = true;
      else if (g.maxDailyTrades > 0 && dayTrades >= g.maxDailyTrades) dayClosed = true;
      else if (g.maxConsecLosses > 0 && consecLosses >= g.maxConsecLosses) dayClosed = true;
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
      if (istMin < g.entryStartMin || istMin >= g.entryEndMin) return "blockedWindow";
      if (g.maxDailyTrades > 0 && dayTrades >= g.maxDailyTrades) return "blockedMaxTrades";
      if (g.maxDailyLoss > 0 && dayPnl <= -g.maxDailyLoss) return "blockedDayLoss";
      if (g.maxConsecLosses > 0 && consecLosses >= g.maxConsecLosses) return "blockedConsecLoss";
      if (gIdx <= pauseUntilIdx) return "blockedSlPause";
      if (g.oppCooldownEnabled && side === oppCooldownSide && gIdx <= oppCooldownUntilIdx) {
        return "blockedOppCooldown";
      }
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
      const sl = Number.isFinite(sig.slSpot) ? sig.slSpot
               : Number.isFinite(sig.stopLoss) ? sig.stopLoss : null;

      pos = {
        side,
        entryTime,
        entrySpot,
        optionEntryLtp: entryPremSlipped,
        slSpot:        sl,
        initialSlSpot: sl,
        rsi:   sig.rsi   != null ? sig.rsi   : null,
        ema20: sig.ema20 != null ? sig.ema20 : null,
        ema50: sig.ema50 != null ? sig.ema50 : null,
        entryReason: sig.reason || `${side} setup`,
      };
      dayTrades++;
    }

    for (let i = 0; i < bars.length; i++) {
      const c = bars[i];
      const gIdx = globalIndex.get(c.time);
      const istMin = _istMins(c.time);
      // Prefix of ALL bars up to and including this one — the engine's warm-up is
      // longer than one session, so it must see previous days too.
      const upTo = sorted.slice(0, gIdx + 1);

      // ── 1. Manage an open position on THIS bar ─────────────────────────────
      // ORDER MATTERS. The stop is tested against the bar's ADVERSE extreme
      // FIRST; only if it survives do we consider anything favourable.
      if (pos) {
        const isCE = pos.side === "CE";

        // 1a. Hard square-off. Tested before the stop only because at/after the
        // EOD minute there is no "next bar" to trail into — the position is out
        // at this bar's OPEN regardless of what the rest of the bar did.
        if (istMin >= g.eodExitMin) {
          close(c.open, c.time, `EOD square-off (${_fmtMins(g.eodExitMin)} IST)`, gIdx);
        } else if (Number.isFinite(pos.slSpot)) {
          // 1b. The SuperTrend stop, on the bar's adverse extreme.
          const adverse = isCE ? c.low : c.high;
          const hit = isCE ? adverse <= pos.slSpot : adverse >= pos.slSpot;
          if (hit) {
            // A bar that OPENED already through the level fills at the OPEN —
            // the better stop level was never on offer.
            const openThrough = isCE ? c.open <= pos.slSpot : c.open >= pos.slSpot;
            const fill = openThrough ? c.open : pos.slSpot;
            const trailing = isCE ? pos.slSpot > pos.initialSlSpot : pos.slSpot < pos.initialSlSpot;
            close(fill, c.time,
              `SuperTrend ${trailing ? "trailing " : ""}stop hit at ${pos.slSpot}` +
              (trailing ? ` (initial ${pos.initialSlSpot})` : ""),
              gIdx);
          }
        }
      }

      // ── 2. Advance the trail on the bar CLOSE (tighten-only, engine-owned) ──
      // Only after the stop survived the bar, so the stop can never tighten onto
      // a level this same bar merely traded through.
      if (pos) {
        const t = engine.trailStop(upTo, pos.side, pos.slSpot, stratCfg);
        if (t && t.changed && Number.isFinite(t.stop)) pos.slSpot = t.stop;
      }

      // ── 3. Read the engine on this bar's CLOSE ─────────────────────────────
      // One call serves both the opposite-signal exit and the entry search, so
      // the two can never disagree about what this bar printed.
      const sig = engine.getSignal(upTo, { silent: true });
      const sigSide = sig.signal === "BUY_CE" ? "CE" : sig.signal === "BUY_PE" ? "PE" : null;

      // 3a. OPPOSITE-SIGNAL EXIT — kept from V1. A favourable/close-based exit,
      // so it runs only after the adverse stop above had its chance.
      if (pos && sigSide && sigSide !== pos.side) {
        close(c.close, c.time,
          `Opposite signal — engine printed BUY_${sigSide} while long ${pos.side}`, gIdx);
      }

      // ── 4. Confirmation-candle fill ────────────────────────────────────────
      // An armed trigger is valid for exactly ONE bar: the immediately-next one.
      if (!pos && armed) {
        if (confirmCandle.isNextBar(c.time, armed.barTime, RES)) {
          const fill = confirmCandle.barCrossFill(armed.side, c, armed.triggerLevel);
          // The entry window is honoured on the CONFIRMATION bar too — a trigger
          // armed at 12:59 must not fill at 13:04.
          const inWindow = istMin >= g.entryStartMin && istMin < g.entryEndMin;
          if (fill != null && inWindow && !dayClosed && istMin < g.eodExitMin) {
            openPosition(armed.side, fill, c.time, armed.signal, gIdx);
            gateStats.confirmFilled++;
          } else {
            if (fill != null && !inWindow) gateStats.blockedWindow++;
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
      if (!pos && !dayClosed && sigSide) {
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
        } else {
          // Confirmation off — paper enters at the signal bar's close.
          openPosition(sigSide, c.close, c.time, sig, gIdx);
        }
      }
    }

    // Anything still open at the last bar of the session is squared off there.
    if (pos) {
      const last = bars[bars.length - 1];
      close(last.close, last.time, "EOD (end of day candles)", globalIndex.get(last.time));
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
      { key: "riskPts", label: "Risk (pt)" },
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
      { label: "Blocked — max trades",   value: gs.blockedMaxTrades || 0 },
      { label: "Blocked — day loss cap", value: gs.blockedDayLoss || 0 },
      { label: "Blocked — consec losses", value: gs.blockedConsecLoss || 0 },
      { label: "Blocked — SL pause",      value: gs.blockedSlPause || 0 },
      { label: "Blocked — opp cooldown",  value: gs.blockedOppCooldown || 0 },
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
      `<b>Stop:</b> SuperTrend(${c.ST_PERIOD},${c.ST_MULT}) and nothing else — seeded from the signal at entry, re-read at every bar CLOSE via the engine's own <code>trailStop()</code>, tighten-only, then tested intra-bar on the NEXT bar's high/low. ` +
      `<b>V2 has no profit target</b>, no breakeven, no time-stop, no fixed-point stop, no option-premium stop, no negative-candle stop, no candle trail and no EMA21 anything — V1 has all of those and V2 dropped them on purpose. ` +
      `The only other exits are the <b>opposite signal</b> and the hard square-off at ${_fmtMins(g.eodExitMin)} IST (<code>EMA_RSI_ST_V2_EOD_EXIT_TIME</code>). ` +
      `<b>Guards (V2's own keys, never the shared globals):</b> entries ${_fmtMins(g.entryStartMin)}–${_fmtMins(g.entryEndMin)}, max ${g.maxDailyTrades} trades/day, day ends on a ₹${g.maxDailyLoss} loss or ${g.maxConsecLosses} consecutive losses, ${g.slPauseCandles}-candle pause after a loss, opposite-side cooldown ${g.oppCooldownEnabled ? `${g.oppCooldownCandles} candles` : "off"}. ` +
      `<b>Warm-up:</b> the engine refuses below ${engine.warmupBars(c)} candles — more than one session — so ${g.warmupDays} calendar days of runway are fetched BEFORE ${_escHtml(from)} purely to seed the indicators. ${meta.warmupBars || 0} such bars were loaded and ${wv === 0 ? "<b>none of them produced a trade</b> (asserted, not assumed)" : `<b>⚠ ${wv} produced a trade — this is a bug, do not trust these results</b>`}. ` +
      `<b>Intra-bar ordering is conservative:</b> the stop is tested on the bar's high/low BEFORE any favourable exit on the close, a bar that opened beyond the stop fills at the OPEN, and the trail advances only on a bar close. ` +
      `<b>P&L is simulated</b> — no historical option chain exists here, so premium is δ+θ modelled (BACKTEST_DELTA ${_num("BACKTEST_DELTA", "0.55")}, θ ₹${_num("BACKTEST_THETA_DAY", "8")}/day) seeded at ₹${g.seedPremium}, PLUS ${g.slippagePts}pt slippage EACH way (<code>EMA_RSI_ST_V2_BT_SLIPPAGE_PTS</code>) and real brokerage. Treat ₹ as directional, not exact.`,
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
        const result = runEmaRsiStV2Backtest(candles, activeFromTs);

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

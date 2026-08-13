/**
 * ORB — SHARED EXIT ENGINE
 * ═════════════════════════════════════════════════════════════════════════════
 * The single owner of ORB's in-position rules. Paper, Live, Backtest and
 * scripts/orbValidate.js all call THIS module; none of them may keep a private
 * copy of an exit rule.
 *
 * WHY THIS EXISTS (2026-08-04)
 * ─────────────────────────────
 * ORB's entry has had one owner since the 2026-07-26 rebuild (orb_breakout.js), but
 * its EXITS were hand-maintained in four places:
 *
 *     src/routes/orbPaper.js      _managePositionOnClose + _checkExits   (canonical)
 *     src/routes/orbLive.js       a line-by-line re-implementation
 *     src/routes/orbBacktest.js   ~70 inline lines inside the day loop
 *     scripts/orbValidate.js      a fourth copy driving the published statistics
 *
 * That is not a hypothetical risk. orbBacktest.js still carries the comment
 * describing when it evaluated the close-based rules BEFORE the intrabar ones and
 * "silently reported a different trade from the one the live engine would have
 * taken". Four copies means that class of divergence recurs on every edit, and it
 * recurs SILENTLY — nothing in the repo compares the copies.
 *
 * Replay was never part of the problem: it re-runs paper's own onTick(), so it
 * inherits whatever paper does. Making the other three inherit the same functions
 * is what finally makes "Replay == Backtest == Paper == Live" structural rather
 * than a review item.
 *
 * ── DESIGN NOTES ────────────────────────────────────────────────────────────
 * • NO BEHAVIOUR CHANGE. This module is a faithful extraction of paper's rules,
 *   which are canonical (see feedback_paper_logic_untouchable). Thresholds,
 *   ordering, rounding and env keys are exactly as they were. If you want to
 *   change a rule, that is a strategy hypothesis and belongs behind validation —
 *   not in a refactor.
 *
 * • ORDERING IS PART OF THE CONTRACT. Paper's real timeline is:
 *       every tick        → evaluateTickExits()   (rupee cap, premium stop, hard SL)
 *       every candle close → evaluateCloseExits()  (opposite candle, breakeven, EMA)
 *   so within one candle the intrabar exits always get first refusal, and a
 *   close-based rule can only fire on a bar that never touched the stop. Harnesses
 *   that replay bars rather than ticks MUST call them in that order.
 *
 * • DECISIONS ARE RETURNED, NOT EXECUTED. Paper simulates a fill, Live places a
 *   broker order, Backtest back-solves a fill price from the bar. Those are
 *   execution concerns; this module only decides. Mutation of the position is
 *   limited to the bookkeeping each rule owns (breakeven stop, EMA arming,
 *   excursion tracking) and is always explicit in the function name.
 *
 * • PREDICATES ARE EXPORTED SEPARATELY so a bar-based harness can ask "would this
 *   have tripped inside the bar?" and then compute its own realistic fill, instead
 *   of duplicating the threshold arithmetic.
 */

const { EMA } = require("technicalindicators");

const _r2 = (x) => Math.round(x * 100) / 100;
const _envNum = (key, dflt) => parseFloat(process.env[key] || dflt);
const _envOn = (key, dflt) => (process.env[key] || dflt).toLowerCase() === "true";

// ── Tunables, read fresh on every call ──────────────────────────────────────
// Settings writes to process.env at runtime, so caching these would pin a value
// until the next restart and make the Settings page lie.
function maxTradeLossINR()   { return _envNum("ORB_MAX_TRADE_LOSS", "0"); }
function premiumStopPct()    { return _envNum("ORB_PREMIUM_STOP_PCT", "35"); }
function trailEmaPeriod()    { return Math.max(2, parseInt(process.env.ORB_TRAIL_EMA || "20", 10)); }
function oppositeExitOn()    { return _envOn("ORB_OPP_CANDLE_EXIT", "false"); }

/**
 * How far in profit the trade must be before the EMA trail is allowed to ARM.
 * `0` (default) = arm on the first close on the correct side, i.e. today's rule.
 *
 * WHY IT EXISTS (2026-08-13). ORB enters on the confirmation candle's close, by
 * which point price is already extended, so the very next candle often pulls back
 * through a 20-EMA that is still sitting right under the entry. Across 2025+2026
 * the EMA trail is where most of the small bleeds land — a long tail of −₹200 to
 * −₹1,200 scratches, each of which also pays ~₹420 in spread + theta. Delaying the
 * arm leaves only the hard stop / rupee cap in charge until the trade has actually
 * gone somewhere. This is a HYPOTHESIS, not a finding: it must clear TRAIN *and*
 * TEST in scripts/orbSweep.js before the default moves off 0.
 */
// NaN-safe on purpose: both of these fail towards "the trail never exits at all"
// if a hand-edited .env carries a non-numeric value, which would silently leave a
// live position with only the hard stop. A bad value degrades to the shipped rule.
function trailArmPts()       { const v = _envNum("ORB_TRAIL_ARM_PTS", "0"); return Number.isFinite(v) && v > 0 ? v : 0; }

/**
 * Consecutive closes on the wrong side of the EMA needed to exit. `1` (default) is
 * today's rule — the first close through the trail ends the trade. `2` rides out a
 * single noise candle at the cost of giving back one more bar when the move is
 * genuinely over.
 */
function trailConfirmCloses(){ const v = parseInt(process.env.ORB_TRAIL_CONFIRM_CLOSES || "1", 10); return Number.isFinite(v) && v > 1 ? v : 1; }

/**
 * Adaptive breakeven trigger: max(fixed pts, ORB_BREAKEVEN_OR_MULT × OR width), so
 * a wide-range day gets more room before the stop tightens to entry.
 */
function breakevenTriggerPts(rangePts) {
  const mult  = _envNum("ORB_BREAKEVEN_OR_MULT", "0");
  const fixed = _envNum("ORB_BREAKEVEN_PTS", "0");
  return (mult > 0 && rangePts) ? Math.max(fixed, Math.round(mult * rangePts)) : fixed;
}

/** Opposite-candle body threshold, in points: ORB_OPP_CANDLE_BODY_MULT × OR width. */
function oppositeCandleThreshPts(rangePts) {
  return _envNum("ORB_OPP_CANDLE_BODY_MULT", "0.3") * (rangePts || 0);
}

/**
 * EMA of candle closes — null until `period` closes exist. Seeded from the routes'
 * multi-day preload so the trend-trail is live even for a 09:35 entry (a 20-EMA on
 * 5-min needs ~100 minutes of bars that today alone cannot supply).
 */
function computeEma(candles, period) {
  if (!candles || candles.length < period) return null;
  const closes = candles.map(c => c && c.close).filter(v => typeof v === "number");
  if (closes.length < period) return null;
  const arr = EMA.calculate({ period, values: closes });
  return arr && arr.length ? arr[arr.length - 1] : null;
}

// ── Threshold predicates (for bar-based harnesses that back-solve a fill) ────
function isMaxTradeLossHit(unrealisedINR) {
  const cap = maxTradeLossINR();
  return cap > 0 && unrealisedINR <= -cap;
}
function isPremiumStopHit(optionLtp, entryLtp) {
  const pct = premiumStopPct();
  return pct > 0 && optionLtp <= entryLtp * (1 - pct / 100);
}
function isHardSlHit(side, spotPrice, slSpot) {
  return side === "CE" ? spotPrice <= slSpot : spotPrice >= slSpot;
}

/**
 * Peak-premium + MFE/MAE bookkeeping. Observer-only: feeds the trade record and the
 * Telegram summary, never a decision. Separated from the exit evaluation so a
 * harness can track excursion without also being forced through the tick rules.
 *
 * @param {object} pos        the open position (mutated)
 * @param {number} spotPrice
 * @param {number} optionLtp
 * @param {number} nowMs      clock for secsToMFE/secsToMAE (injected so replay,
 *                            which compresses time, stays honest)
 */
function trackExcursion(pos, spotPrice, optionLtp, nowMs) {
  if (!pos) return;
  if (optionLtp > pos.peakPremium) pos.peakPremium = optionLtp;

  const favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const curPnl = (optionLtp - pos.optionEntryLtp) * pos.qty;
  if (favPts > (pos.mfeSpotPts || 0)) {
    pos.mfeSpotPts = parseFloat(favPts.toFixed(2));
    pos.secsToMFE  = parseFloat(((nowMs - pos.entryTimeMs) / 1000).toFixed(1));
  }
  if (curPnl > (pos.mfePnl || 0)) pos.mfePnl = parseFloat(curPnl.toFixed(2));
  if (favPts < (pos.maeSpotPts || 0)) {
    pos.maeSpotPts = parseFloat(favPts.toFixed(2));
    pos.secsToMAE  = parseFloat(((nowMs - pos.entryTimeMs) / 1000).toFixed(1));
  }
  if (curPnl < (pos.maePnl || 0)) pos.maePnl = parseFloat(curPnl.toFixed(2));
}

/**
 * Tick-level exits, in paper's order: per-trade rupee cap → premium disaster stop →
 * spot hard SL (which may already have been lifted to breakeven).
 *
 * @returns {{exit:boolean, reason:string|null}}
 */
function evaluateTickExits(pos, { spotPrice, optionLtp }) {
  if (!pos) return { exit: false, reason: null };

  const curPnl = (optionLtp - pos.optionEntryLtp) * pos.qty;

  // The daily-loss gate only fires when flat, so THIS is what caps one open trade.
  if (isMaxTradeLossHit(curPnl)) {
    return { exit: true, reason: `Max trade loss (₹${Math.round(curPnl)} ≤ -₹${maxTradeLossINR()})` };
  }
  // Catches IV-crush / vega losses the spot-based stop can miss.
  if (isPremiumStopHit(optionLtp, pos.optionEntryLtp)) {
    return { exit: true, reason: `Premium disaster stop (₹${optionLtp} ≤ −${premiumStopPct()}% of entry ₹${pos.optionEntryLtp})` };
  }
  if (isHardSlHit(pos.side, spotPrice, pos.slSpot)) {
    return { exit: true, reason: `Hard SL hit (${spotPrice} ${pos.side === "CE" ? "≤" : "≥"} ${pos.slSpot})` };
  }
  return { exit: false, reason: null };
}

/**
 * Candle-close management, in paper's order:
 *   1. strong opposite reversal candle → exit now
 *   2. breakeven — lift the hard SL to entry once far enough in profit (never loosens)
 *   3. EMA trend-trail — exit only when a candle CLOSES back across the EMA, and only
 *      after price has first closed on the correct side of it (emaArmed). Without the
 *      arm, a fresh entry taken below a stale/gap-day EMA would be stopped out on its
 *      very first candle.
 *
 * Mutates `pos.slSpot` / `pos.breakevenArmed` / `pos.emaArmed` / `pos.lastEma`.
 * `breakevenArmed` in the result is true ONLY on the candle that arms it, so callers
 * can log it and re-snapshot for crash recovery exactly once. `favPts` / `bePts` ride
 * along so the routes can keep logging the numbers that justified the arm — those
 * are how a breakeven exit is diagnosed after the fact.
 *
 * @param {Array} candles  close series for the EMA trail (route state or day slice)
 * @returns {{exit:boolean, reason:string|null, breakevenArmed:boolean,
 *            favPts:number|null, bePts:number|null}}
 */
function evaluateCloseExits(pos, bar, candles) {
  const none = { exit: false, reason: null, breakevenArmed: false, favPts: null, bePts: null };
  if (!pos || !bar || typeof bar.close !== "number") return none;
  const close = bar.close;

  // 1. Strong opposite reversal candle (big body closing back inside the box)
  const oppThresh = oppositeCandleThreshPts(pos.rangePts);
  const bodyPts   = Math.abs(bar.close - bar.open);
  if (oppositeExitOn() && oppThresh > 0 && bodyPts >= oppThresh) {
    if (pos.side === "CE" && bar.close < bar.open && bar.close < pos.orh) {
      return { exit: true, reason: `Strong opposite candle (red body ${bodyPts.toFixed(1)}pt ≥ ${oppThresh.toFixed(1)}pt, closed below ORH)`, breakevenArmed: false, favPts: null, bePts: null };
    }
    if (pos.side === "PE" && bar.close > bar.open && bar.close > pos.orl) {
      return { exit: true, reason: `Strong opposite candle (green body ${bodyPts.toFixed(1)}pt ≥ ${oppThresh.toFixed(1)}pt, closed above ORL)`, breakevenArmed: false, favPts: null, bePts: null };
    }
  }

  // 2. Breakeven
  let armedNow = false;
  const bePts  = breakevenTriggerPts(pos.rangePts);
  const favPts = (close - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  if (!pos.breakevenArmed && bePts > 0 && favPts >= bePts) {
    if (pos.side === "CE" && pos.entrySpot > pos.slSpot) pos.slSpot = _r2(pos.entrySpot);
    if (pos.side === "PE" && pos.entrySpot < pos.slSpot) pos.slSpot = _r2(pos.entrySpot);
    pos.breakevenArmed = true;
    armedNow = true;
  }

  // 3. EMA trend-trail
  const emaPeriod = trailEmaPeriod();
  const ema = computeEma(candles, emaPeriod);
  if (ema != null) {
    pos.lastEma = _r2(ema);
    const onSide = pos.side === "CE" ? close >= ema : close <= ema;
    if (onSide) {
      // Arm only once the trade is far enough in profit. At the default 0pt this is
      // "arm on the first close on the right side", exactly as before.
      const armPts = trailArmPts();
      if (armPts <= 0 || favPts >= armPts) pos.emaArmed = true;
      pos.emaBreaks = 0;
    } else if (pos.emaArmed) {
      // `emaBreaks` is intentionally not part of the crash-recovery snapshot: after a
      // restart it resets to 0, so a reloaded position needs a fresh run of closes
      // through the trail. That errs towards holding, never towards a phantom exit.
      pos.emaBreaks = (pos.emaBreaks || 0) + 1;
      const need = trailConfirmCloses();
      if (pos.emaBreaks >= need) {
        const side = pos.side === "CE" ? "below" : "above";
        const runs = need > 1 ? ` ${pos.emaBreaks} closes running` : "";
        return { exit: true, reason: `Closed ${side} EMA${emaPeriod}${runs} (${close} ${pos.side === "CE" ? "<" : ">"} ${pos.lastEma})`, breakevenArmed: armedNow, favPts, bePts };
      }
    }
  }

  return { exit: false, reason: null, breakevenArmed: armedNow, favPts, bePts };
}

/**
 * Was this exit a STOP-OUT (the trade was proved wrong) rather than a trend exit?
 *
 * The single owner of that classification, because ORB's re-entry rule turns on it
 * (see orb_breakout.reentryPlan) and paper/live/backtest each hold their own exit
 * reason strings. A hand-written regex in three routes is exactly how this repo
 * ended up with four copies of the exit rules in the first place.
 *
 * TRUE for the three ways a position is forced out against us — the hard spot stop
 * (including one already lifted to breakeven), the per-trade rupee cap and the
 * premium disaster stop. FALSE for the EMA trend-trail, the strong-opposite-candle
 * exit, EOD square-off and any manual close: those mean the MOVE ended, not that
 * the breakout failed, so there is nothing to re-enter.
 *
 * Matching is on the reason PREFIX, which every emitter (orbExits itself,
 * orbBacktest's back-solved fills, scripts/lib/orbSim) writes verbatim.
 */
function isStopOutExit(reason) {
  if (!reason || typeof reason !== "string") return false;
  return /^\s*(hard sl hit|max trade loss|premium disaster stop)/i.test(reason);
}

/**
 * Has the option premium gone stale? Warn-only across this repo — every other
 * strategy logs it and leaves the exit rules untouched (see emaRsiStPaper: "Warn
 * only — the exit rules are unchanged"), and ORB was the one engine missing the
 * warning entirely. Gating exits on staleness would be a behaviour change, so it
 * deliberately is not one.
 */
function isLtpStale(updatedAtMs, nowMs) {
  if (!updatedAtMs) return false;
  // NEVER during replay. The replay harness pins global Date.now() to the recorded
  // session clock, which advances far faster than the real 3-second option-poll
  // cadence — so both the stamp and this comparison are in replay time and the gap
  // between two polls looks like many "minutes". The warning would fire on every
  // single replay run, and an alarm that always fires trains you to ignore the one
  // time it matters. Same lazy-require idiom as optionChainRecorder.js; lazy because
  // tickReplay requires the routes, which require this module.
  try { if (require("../services/tickReplay").isReplayInProgress()) return false; } catch (_) {}
  const staleMs = parseInt(process.env.LTP_STALE_THRESHOLD_SEC || "15", 10) * 1000;
  return (nowMs - updatedAtMs) > staleMs;
}

/**
 * DELIBERATELY NARROW EXPORT SURFACE.
 *
 * Only the decision functions and the three threshold PREDICATES leave this module.
 * The raw thresholds (breakevenTriggerPts, oppositeCandleThreshPts, trailEmaPeriod,
 * maxTradeLossINR, premiumStopPct, oppositeExitOn) stay private on purpose: exporting
 * a number invites a caller to re-derive the rule around it, which is precisely how
 * ORB ended up with four copies of its exits in the first place. If a new harness
 * needs a decision, ask for the decision — do not export the ingredients.
 *
 * The predicates exist only because a BAR-based harness (orbBacktest, orbValidate)
 * must ask "would this have tripped inside the candle?" before it can compute a
 * realistic fill price, which is an execution concern this module cannot answer.
 */
module.exports = {
  trackExcursion,
  evaluateTickExits,
  evaluateCloseExits,
  isLtpStale,
  isStopOutExit,
  isMaxTradeLossHit,
  isPremiumStopHit,
  isHardSlHit,
};

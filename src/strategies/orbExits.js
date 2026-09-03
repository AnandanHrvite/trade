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
// Repo convention: SuperTrend is not in `technicalindicators`, so the one shared
// implementation is used here too — the same module orb_breakout.js reads for its
// entry gate and for ORB_SL_SOURCE=supertrend. No cycle: supertrend.js requires
// nothing from this repo.
const { computeSuperTrend } = require("../utils/supertrend");

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
 * CANDLE TRAIL (2026-08-17, ships OFF).
 *
 * Ratchets the hard stop up behind price, one candle at a time: on every close that
 * is in profit, the stop moves to the extreme of the last N completed candles (the
 * same shape ORB_SL_SOURCE=lookback gives the initial stop, so the stop keeps the
 * geometry it started with). It only ever TIGHTENS — a pullback candle whose low is
 * further away leaves the stop where it is.
 *
 * It does not replace the EMA trail; both run, and whichever ends the trade first
 * wins. The EMA trail exits on a CLOSE through the line — this exits intrabar via
 * the shared hard-SL check, so it gives back less on a sharp reversal and more on
 * a noisy one. UNPROVEN: measure with scripts/orbSweep.js before trusting it.
 */
function candleTrailOn()     { return _envOn("ORB_CANDLE_TRAIL_ENABLED", "false"); }
function candleTrailBars()   { const v = parseInt(process.env.ORB_CANDLE_TRAIL_CANDLES || "2", 10); return Number.isFinite(v) && v > 0 ? v : 1; }

/**
 * SUPERTREND TRAIL (2026-09-04, ships OFF).
 *
 * The classic SuperTrend stop: the hard SL is ratcheted onto the
 * SuperTrend(ORB_SL_ST_PERIOD, ORB_SL_ST_MULT) line — 10/2 by default — on every
 * candle close, and price crossing that line ends the trade INTRABAR through the
 * shared hard-SL check. Pair it with ORB_SL_SOURCE=supertrend and the initial stop
 * and the trail are literally the same line, which is the whole point of the
 * indicator: one level that starts as the stop and walks itself up behind price.
 *
 * Deliberately reads its OWN period/multiplier rather than the ORB_ST_* entry gate's
 * (10/3). Those are two different jobs — a direction filter wants a slower band, a
 * stop wants a tighter one — and sharing the keys would silently retune the entry
 * gate whenever the stop was tightened.
 *
 * Three safety properties, all shared with the candle trail:
 *   • TIGHTEN-ONLY. A widening band never pushes the stop back out, so the trail
 *     can never undo breakeven or hand back risk that was already taken off.
 *   • NEVER AT THE CLOSE. A line on the wrong side of the close is refused; it
 *     would be triggered by the very next tick.
 *   • DIRECTION-CHECKED. The line is only used while SuperTrend agrees with the
 *     position (bullish under a CE, bearish over a PE). When it flips against the
 *     trade the line is on the far side of price and the previous two rules would
 *     reject it anyway — this just makes the intent explicit.
 *
 * It does not replace the EMA trail; both run and whichever ends the trade first
 * wins. UNPROVEN: measure with scripts/orbSweep.js before moving the default.
 */
function stTrailOn()         { return _envOn("ORB_ST_TRAIL_ENABLED", "false"); }

/**
 * THE ONE OWNER of ORB_SL_ST_PERIOD / ORB_SL_ST_MULT — exported, unlike every other
 * threshold in this module, because orb_breakout.js's ORB_SL_SOURCE=supertrend anchor
 * has to land on the SAME line this trail then ratchets. Two parses of one pair of
 * keys is not a style question here: it is the "wider of" contract silently breaking.
 *
 * The export is narrow on purpose — it hands over the resolved PARAMETERS, not the
 * stop level, so the anchor still computes its own stop and this module still owns
 * the trail decision. That keeps the rule about not exporting ingredients intact:
 * what is shared is the configuration, not the rule.
 *
 * NaN- and zero-safe in the same direction as trailArmPts(): a hand-edited .env with
 * a non-numeric or 0 value degrades to the documented 10/2. This matters more than it
 * looks. computeSuperTrend() applies its OWN defaults for a falsy argument (10/3, the
 * classic swing setting), so an unguarded NaN or 0 did not disable anything loudly —
 * it silently placed the INITIAL STOP on a 3x band while the TRAIL ratcheted a 2x one,
 * i.e. two different stops for one trade, with the logged reason reading
 * "SuperTrend(10,NaN)".
 */
function stopSuperTrendParams() {
  const p = parseInt(process.env.ORB_SL_ST_PERIOD || "10", 10);
  const m = _envNum("ORB_SL_ST_MULT", "2");
  return {
    period: Number.isFinite(p) && p >= 2 ? p : 10,
    mult:   Number.isFinite(m) && m > 0  ? m : 2,
  };
}

/**
 * The bar series with `bar` guaranteed present exactly once as the LAST element.
 * Paper pushes the closing bar into state.candles before managing the position;
 * the backtest slices a window that already ends on it; a future harness may do
 * neither. Indicator maths cannot tolerate the bar being missing OR duplicated, so
 * normalise rather than assume. Multi-day on purpose — unlike the candle trail this
 * needs the preload to warm ATR up.
 */
function _seriesWithBar(candles, bar) {
  const arr = Array.isArray(candles) ? candles : [];
  if (typeof bar.time !== "number") {
    return (arr.length && arr[arr.length - 1] === bar) ? arr : arr.concat([bar]);
  }
  return arr.filter(c => c && typeof c.time === "number" && c.time < bar.time).concat([bar]);
}

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
/**
 * Open-trade P&L in ₹, for whichever instrument the position holds.
 *
 * Options are BOUGHT, so the premium move IS the P&L for both CE and PE.
 * A futures position prices on the INDEX and carries a direction: CE = LONG,
 * PE = SHORT. Without the sign a winning short reports as a loss and the
 * per-trade rupee cap would exit it.
 */
function _openPnl(pos, spotPrice, optionLtp) {
  if (pos && pos.isFutures) {
    return (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1) * pos.qty;
  }
  return (optionLtp - pos.optionEntryLtp) * pos.qty;
}

function trackExcursion(pos, spotPrice, optionLtp, nowMs) {
  if (!pos) return;
  if (optionLtp > pos.peakPremium) pos.peakPremium = optionLtp;   // spot high in futures mode

  const favPts = (spotPrice - pos.entrySpot) * (pos.side === "CE" ? 1 : -1);
  const curPnl = _openPnl(pos, spotPrice, optionLtp);
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

  const curPnl = _openPnl(pos, spotPrice, optionLtp);

  // The daily-loss gate only fires when flat, so THIS is what caps one open trade.
  if (isMaxTradeLossHit(curPnl)) {
    return { exit: true, reason: `Max trade loss (₹${Math.round(curPnl)} ≤ -₹${maxTradeLossINR()})` };
  }
  // Catches IV-crush / vega losses the spot-based stop can miss. Futures have
  // neither premium nor IV — and in that mode optionLtp mirrors the SPOT, so
  // leaving this on would test a 35% fall in NIFTY itself.
  if (!pos.isFutures && isPremiumStopHit(optionLtp, pos.optionEntryLtp)) {
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
 *  2b. candle trail — ratchet the hard SL behind the last N candles while in profit
 *      (ORB_CANDLE_TRAIL_ENABLED, ships off; never loosens)
 *  2c. SuperTrend trail — ratchet the hard SL onto the SuperTrend line
 *      (ORB_ST_TRAIL_ENABLED, ships off; never loosens)
 *   3. EMA trend-trail — exit only when a candle CLOSES back across the EMA, and only
 *      after price has first closed on the correct side of it (emaArmed). Without the
 *      arm, a fresh entry taken below a stale/gap-day EMA would be stopped out on its
 *      very first candle.
 *
 * Mutates `pos.slSpot` / `pos.breakevenArmed` / `pos.emaArmed` / `pos.lastEma` /
 * `pos.lastStopSt` (the stop-SuperTrend line, observer-only like `lastEma`).
 * `breakevenArmed` in the result is true ONLY on the candle that arms it, and
 * `trailMoved` only on a candle that actually moved the stop (with `trailNote`
 * naming WHICH trail moved it), so callers can
 * log it and re-snapshot for crash recovery exactly once. `favPts` / `bePts` ride
 * along so the routes can keep logging the numbers that justified the arm — those
 * are how a breakeven exit is diagnosed after the fact.
 *
 * @param {Array} candles  the bar series (OHLC) — EMA trail, candle trail and the
 *                          SuperTrend trail all read it
 * @returns {{exit:boolean, reason:string|null, breakevenArmed:boolean,
 *            trailMoved:boolean, trailNote:string|null,
 *            favPts:number|null, bePts:number|null}}
 */
function evaluateCloseExits(pos, bar, candles) {
  const none = { exit: false, reason: null, breakevenArmed: false, trailMoved: false, trailNote: null, favPts: null, bePts: null };
  if (!pos || !bar || typeof bar.close !== "number") return none;
  const close = bar.close;

  // 1. Strong opposite reversal candle (big body closing back inside the box)
  const oppThresh = oppositeCandleThreshPts(pos.rangePts);
  const bodyPts   = Math.abs(bar.close - bar.open);
  if (oppositeExitOn() && oppThresh > 0 && bodyPts >= oppThresh) {
    if (pos.side === "CE" && bar.close < bar.open && bar.close < pos.orh) {
      return { exit: true, reason: `Strong opposite candle (red body ${bodyPts.toFixed(1)}pt ≥ ${oppThresh.toFixed(1)}pt, closed below ORH)`, breakevenArmed: false, trailMoved: false, trailNote: null, favPts: null, bePts: null };
    }
    if (pos.side === "PE" && bar.close > bar.open && bar.close > pos.orl) {
      return { exit: true, reason: `Strong opposite candle (green body ${bodyPts.toFixed(1)}pt ≥ ${oppThresh.toFixed(1)}pt, closed above ORL)`, breakevenArmed: false, trailMoved: false, trailNote: null, favPts: null, bePts: null };
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

  // 2b. Candle trail — ratchet the stop behind the last N closed candles, but only
  //     once this close is in profit. Tighten-only: a wider pullback candle can
  //     never push the stop back out. See candleTrailOn() for why it ships off.
  let trailMoved = false;
  // Which trail actually moved the stop, so the routes can log the truth instead of
  // hard-coding "Candle trail" — two rules can move it now.
  let trailNote  = null;
  if (candleTrailOn() && favPts > 0) {
    const n     = candleTrailBars();
    const _day  = (t) => Math.floor((t + 19800) / 86400);
    const barDay = typeof bar.time === "number" ? _day(bar.time) : null;
    // Built from `candles` + `bar` rather than assuming the harness has already
    // pushed the closing bar into the series — paper does, a future one may not.
    // Same session only: yesterday's low is not a stop.
    const hist = (Array.isArray(candles) ? candles : []).filter(c =>
      c && typeof c.time === "number" && typeof bar.time === "number" &&
      c.time < bar.time && _day(c.time) === barDay);
    // n === 1 means "this candle only". Guarded because slice(-0) is slice(0), i.e.
    // the WHOLE session — which would silently make the tightest setting the loosest.
    const win = (n > 1 ? hist.slice(-(n - 1)) : []).concat([bar]);

    let ext = pos.side === "CE" ? Infinity : -Infinity;
    for (const c of win) {
      const v = pos.side === "CE" ? c.low : c.high;
      if (typeof v !== "number") continue;
      ext = pos.side === "CE" ? Math.min(ext, v) : Math.max(ext, v);
    }
    // `tighter` keeps the ratchet one-way; `clear` refuses a stop sitting AT the
    // close, which the very next tick would trigger.
    const tighter = pos.side === "CE" ? ext > pos.slSpot : ext < pos.slSpot;
    const clear   = pos.side === "CE" ? ext < close      : ext > close;
    if (Number.isFinite(ext) && tighter && clear) {
      pos.slSpot = _r2(ext);
      trailMoved = true;
      trailNote  = `Candle trail (last ${n})`;
    }
  }

  // 2c. SuperTrend trail — ratchet the stop onto the SuperTrend line. Runs AFTER
  //     the candle trail so that when both are on the tighter of the two wins (each
  //     is tighten-only, so whichever moves the stop further simply survives).
  //     No profit precondition, unlike the candle trail: the SuperTrend line IS the
  //     stop from the moment of entry when ORB_SL_SOURCE=supertrend, and requiring
  //     profit first would leave the trade on a stale level for exactly the bars
  //     where the trend is deciding. Tighten-only keeps that safe.
  if (stTrailOn()) {
    const { period: stPeriod, mult: stMult } = stopSuperTrendParams();
    const stArr = computeSuperTrend(_seriesWithBar(candles, bar), stPeriod, stMult);
    const line  = stArr.length ? stArr[stArr.length - 1] : null;
    if (line && line.value != null) {
      pos.lastStopSt = _r2(line.value);
      // Only while SuperTrend agrees with the trade — see the note on stTrailOn().
      if (line.trend === (pos.side === "CE" ? 1 : -1)) {
        const v       = line.value;
        const tighter = pos.side === "CE" ? v > pos.slSpot : v < pos.slSpot;
        const clear   = pos.side === "CE" ? v < close      : v > close;
        if (tighter && clear) {
          pos.slSpot = _r2(v);
          trailMoved = true;
          trailNote  = `SuperTrend(${stPeriod},${stMult}) trail`;
        }
      }
    }
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
        return { exit: true, reason: `Closed ${side} EMA${emaPeriod}${runs} (${close} ${pos.side === "CE" ? "<" : ">"} ${pos.lastEma})`, breakevenArmed: armedNow, trailMoved, trailNote, favPts, bePts };
      }
    }
  }

  return { exit: false, reason: null, breakevenArmed: armedNow, trailMoved, trailNote, favPts, bePts };
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
 * The ONE exception is stopSuperTrendParams(), and it proves the rule rather than
 * breaking it: the initial-stop anchor and the trail must sit on the SAME SuperTrend
 * line, so the CONFIGURATION is shared while each side still owns its own decision.
 *
 * The predicates exist only because a BAR-based harness (orbBacktest, orbValidate)
 * must ask "would this have tripped inside the candle?" before it can compute a
 * realistic fill price, which is an execution concern this module cannot answer.
 */
module.exports = {
  trackExcursion,
  stopSuperTrendParams,
  evaluateTickExits,
  evaluateCloseExits,
  isLtpStale,
  isStopOutExit,
  isMaxTradeLossHit,
  isPremiumStopHit,
  isHardSlHit,
};

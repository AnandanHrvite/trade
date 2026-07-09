/**
 * ORB — Opening Range Breakout (15-minute opening range, single-leg option buy)
 * ─────────────────────────────────────────────────────────────────────────────
 * Setup:
 *   • Build a 15-min "opening range" from the first 9:15–9:30 candles.
 *   • Once range is locked, watch for a 5-min CLOSE that CLEARS the range by a
 *     buffer (max(ORB_BREAKOUT_BUFFER_MIN=8, ORB_BREAKOUT_BUFFER_PCT=0.15×range)):
 *       — Close > ORH + buffer → BUY CE (bullish breakout, ATM strike)
 *       — Close < ORL − buffer → BUY PE (bearish breakdown, ATM strike)
 *     The buffer stops bare-touch false breakouts (a poke of a point or two
 *     beyond the edge that immediately reverses back into the box).
 *   • Take ONE trade per session, intraday MIS, square-off at 15:15 IST.
 *
 * Confirmation filters (all env-toggled):
 *   • Range size sanity: ORH-ORL between ORB_MIN_RANGE_PTS (25) and
 *     ORB_MAX_RANGE_PTS (100). Too tight = noise. Too wide = exhausted.
 *   • Body size: breakout candle body >= ORB_MIN_BODY (8pt)
 *   • Wick rejection: upper/lower wick ratio <= ORB_MAX_WICK_RATIO (0.6).
 *     ORB_WICK_FILTER_ENABLED toggles.
 *   • VWAP alignment: CE only if close > VWAP, PE only if close < VWAP.
 *     ORB_VWAP_FILTER_ENABLED toggles. Falls back to TWAP if candles carry
 *     no volume.
 *   • Volume confirmation: breakout candle volume >= ORB_VOL_MULT × prev-5
 *     candle average. ORB_VOL_FILTER_ENABLED toggles — DEFAULT OFF: NIFTY spot
 *     has no real volume, so paper/live see only a per-tick COUNT while backtest
 *     candles carry zero; the gate can't agree across modes, so it's disabled.
 *     (Still silently skipped if somehow on and candles carry no volume.)
 *   • Entry window: 9:30 – ORB_ENTRY_END (12:00). Stale breakouts after
 *     noon tend to fade.
 *
 * Exit (handled by route, not signal file) — trend-following model (2026-07-09):
 *   • Initial hard SL = the breakout candle's own low (CE) / high (PE).
 *   • Breakeven: once favourable by ORB_BREAKEVEN_PTS (20), lift SL to entry.
 *   • EMA trend-trail (ORB_TRAIL_EMA=20): exit only when a candle CLOSES back
 *     across the EMA — lets a winner ride the whole trend instead of being
 *     shaken out by a single pullback.
 *   • Strong opposite reversal candle (body ≥ ORB_OPP_CANDLE_BODY_MULT×range,
 *     closing back inside the box) → exit now.
 *   • Per-trade loss cap ORB_MAX_TRADE_LOSS (₹) — disaster backstop (the daily
 *     loss gate only fires when flat, so it never caps a single open trade).
 *   • Time stop: hard square-off at 15:15 IST.
 *   • REPLACED the old ORB_SL_CANDLES 2-candle swing trail (exited winners on
 *     the first pullback and gave back most of the peak profit).
 *
 * Returns:
 *   { signal, side, reason, orh, orl, rangePts, entrySpot, slSpot, targetSpot,
 *     signalStrength, vwap, vwapAligned, volRatio, volPass, wickRatio, wickPass }
 *   (slSpot = opposite-OR-edge fallback, targetSpot = 1.5× range — both kept as
 *    reference values; the route sets the real initial stop from the breakout
 *    candle low/high and then manages it via the exit model above.)
 *   signal:  "BUY_CE" | "BUY_PE" | "NONE"
 *   strength: STRONG when range size is in the sweet spot AND breakout body
 *             strong AND all enabled filters pass. MARGINAL otherwise.
 */

const NAME        = "ORB_15MIN";
const DESCRIPTION = "Opening Range Breakout — 15-min OR, 5-min confirm, ATM CE/PE buying";

function _parseMins(envKey, fallback) {
  const v = (process.env[envKey] || fallback).trim();
  const parts = v.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function _utcSecToIstMins(unixSec) {
  return Math.floor((unixSec + 19800) / 60) % 1440;
}

// IST calendar-day index (days since epoch, IST). Used to day-scope the opening
// range + VWAP so callers can preload MULTI-DAY history (to seed the EMA trail)
// without the prior days' 09:15–09:30 bars leaking into today's OR.
function _istDayOf(unixSec) {
  return Math.floor((unixSec + 19800) / 86400);
}

function _hasVolume(c) {
  return c && typeof c.volume === "number" && c.volume > 0;
}

let _loggedNoVolumeOnce = false;
function _warnNoVolumeOnce(silent) {
  if (silent || _loggedNoVolumeOnce) return;
  _loggedNoVolumeOnce = true;
  console.log(`[ORB] note: candles carry no volume — VWAP falls back to TWAP, volume filter is skipped (indices have no spot volume; option-side volume not wired in live)`);
}

/**
 * Cumulative session VWAP from 09:15 to last candle. Returns null if no
 * candles in session window. Uses typical-price ((H+L+C)/3) × volume / Σvol.
 * When no candles carry volume, returns the TWAP (equal-weighted typical price)
 * as a fallback — the alignment check (close above/below) is still meaningful.
 */
function computeVwap(candles) {
  const rangeStartMin = _parseMins("ORB_RANGE_START", "09:15");
  if (!candles || candles.length === 0) return null;
  const day = _istDayOf(candles[candles.length - 1].time);
  let sumPV = 0, sumV = 0, sumP = 0, count = 0, anyVol = false;
  for (const c of candles) {
    if (_istDayOf(c.time) !== day) continue;
    if (_utcSecToIstMins(c.time) < rangeStartMin) continue;
    const tp = (c.high + c.low + c.close) / 3;
    sumP += tp; count++;
    if (_hasVolume(c)) { sumPV += tp * c.volume; sumV += c.volume; anyVol = true; }
  }
  if (count === 0) return null;
  if (anyVol && sumV > 0) return Math.round((sumPV / sumV) * 100) / 100;
  return Math.round((sumP / count) * 100) / 100;
}

/**
 * Volume ratio: (last candle volume) / (avg of previous N candles' volume).
 * Returns null if any of the candles in the window lack volume.
 */
function computeVolumeRatio(candles, lookback) {
  if (!candles || candles.length < lookback + 1) return null;
  const last = candles[candles.length - 1];
  if (!_hasVolume(last)) return null;
  let sum = 0;
  for (let i = candles.length - 1 - lookback; i < candles.length - 1; i++) {
    if (!_hasVolume(candles[i])) return null;
    sum += candles[i].volume;
  }
  const avg = sum / lookback;
  if (!avg) return null;
  return last.volume / avg;
}

/**
 * Compute the opening range from the first 9:15–9:30 candles in `candles`.
 * Returns null if the range cannot yet be determined (still in OR window).
 */
function computeOpeningRange(candles) {
  const rangeStartMin = _parseMins("ORB_RANGE_START", "09:15");
  const rangeEndMin   = _parseMins("ORB_RANGE_END",   "09:30");
  if (!candles || candles.length === 0) return null;
  // Day-scope to the latest candle's IST day (see _istDayOf). NOTE: we can no
  // longer `break` on rangeEnd — with multi-day input the array is not a single
  // ascending intraday run, so we filter every candle instead.
  const day = _istDayOf(candles[candles.length - 1].time);

  let high = -Infinity;
  let low  =  Infinity;
  let count = 0;
  for (const c of candles) {
    if (_istDayOf(c.time) !== day) continue;
    const m = _utcSecToIstMins(c.time);
    if (m < rangeStartMin || m >= rangeEndMin) continue;
    if (c.high > high) high = c.high;
    if (c.low  < low)  low  = c.low;
    count++;
  }
  if (count === 0 || high === -Infinity) return null;
  return { high: Math.round(high * 100) / 100, low: Math.round(low * 100) / 100, candleCount: count };
}

/**
 * getSignal(candles, opts) — returns ORB breakout signal on the latest candle.
 *
 * @param {Array<{time, open, high, low, close, volume?}>} candles — IST-aware 5-min candles
 * @param {object} [opts]
 *   silent — suppress console.log
 *   alreadyTraded — true if a trade has already been taken this session
 */
function getSignal(candles, opts) {
  const silent = !!(opts && opts.silent);
  const alreadyTraded = !!(opts && opts.alreadyTraded);
  const base = {
    signal:        "NONE",
    side:          null,
    orh:           null,
    orl:           null,
    rangePts:      null,
    entrySpot:     null,
    slSpot:        null,
    targetSpot:    null,
    signalStrength: null,
    vwap:          null,
    vwapAligned:   null,
    volRatio:      null,
    volPass:       null,
    wickRatio:     null,
    wickPass:      null,
    reason:        "",
  };

  if (!candles || candles.length < 4) {
    return Object.assign({}, base, { reason: `Warming up (${candles ? candles.length : 0}/4 candles)` });
  }

  // ── Trading window ──────────────────────────────────────────────────────
  const entryStartMin = _parseMins("ORB_RANGE_END",   "09:30");
  const entryEndMin   = _parseMins("ORB_ENTRY_END",   "12:00");
  const last = candles[candles.length - 1];
  const lastIst = _utcSecToIstMins(last.time);
  if (lastIst < entryStartMin) {
    return Object.assign({}, base, { reason: `Building opening range (waiting for ${process.env.ORB_RANGE_END || "09:30"} IST)` });
  }
  if (lastIst >= entryEndMin)  {
    return Object.assign({}, base, { reason: `Past ${process.env.ORB_ENTRY_END || "12:00"} IST — no new ORB entries (stale breakout window)` });
  }

  if (alreadyTraded) {
    return Object.assign({}, base, { reason: "Already traded this session — ORB takes only 1 trade/day" });
  }

  // ── Compute opening range ───────────────────────────────────────────────
  const or = computeOpeningRange(candles);
  if (!or) {
    return Object.assign({}, base, { reason: "Opening range not yet formed" });
  }
  const rangePts = Math.round((or.high - or.low) * 100) / 100;
  const minR = parseFloat(process.env.ORB_MIN_RANGE_PTS || "25");
  const maxR = parseFloat(process.env.ORB_MAX_RANGE_PTS || "100");

  // Compute diagnostics that are used in skip reasons too
  const vwap = computeVwap(candles);
  const vwapAligned = (vwap == null) ? null
                    : (last.close > or.high ? last.close > vwap
                    :  last.close < or.low  ? last.close < vwap
                    :  null);
  const volLookback = parseInt(process.env.ORB_VOL_LOOKBACK || "5", 10);
  const volRatio = computeVolumeRatio(candles, volLookback);
  if (volRatio == null) _warnNoVolumeOnce(silent);

  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const minBody = parseFloat(process.env.ORB_MIN_BODY || "8");

  const orBase = Object.assign({}, base, {
    orh: or.high, orl: or.low, rangePts,
    vwap, vwapAligned, volRatio,
  });

  if (rangePts < minR) {
    return Object.assign({}, orBase, { reason: `Range too tight (${rangePts}pt < ${minR}pt) — likely noise, skip` });
  }
  if (rangePts > maxR) {
    return Object.assign({}, orBase, { reason: `Range too wide (${rangePts}pt > ${maxR}pt) — open already moved, skip` });
  }

  // ── Breakout check on the most recent CLOSED candle ─────────────────────
  //    Require the close to CLEAR the OR edge by a buffer, not merely touch it.
  //    Buffer = max(ORB_BREAKOUT_BUFFER_MIN, ORB_BREAKOUT_BUFFER_PCT × range).
  //    A bare touch (close a fraction beyond ORH/ORL) was the dominant false-
  //    breakout entry — every near-touch reversed straight back into the box.
  const bufMin = parseFloat(process.env.ORB_BREAKOUT_BUFFER_MIN || "8");
  const bufPct = parseFloat(process.env.ORB_BREAKOUT_BUFFER_PCT || "0.15");
  const buffer = Math.round(Math.max(bufMin, bufPct * rangePts) * 100) / 100;
  const bullishBreak = last.close > or.high + buffer && last.close > last.open && body >= minBody;
  const bearishBreak = last.close < or.low  - buffer && last.close < last.open && body >= minBody;

  if (!bullishBreak && !bearishBreak) {
    const aboveH = last.close > or.high;
    const belowL = last.close < or.low;
    let why;
    if (aboveH || belowL) {
      const beyond = aboveH ? (last.close - or.high) : (or.low - last.close);
      why = `Break ${aboveH ? "above ORH" : "below ORL"} by only ${beyond.toFixed(1)}pt < buffer ${buffer}pt (or body ${body.toFixed(1)}pt < ${minBody}pt / against)`;
    } else {
      why = `Close ${last.close} inside range [${or.low}, ${or.high}]`;
    }
    return Object.assign({}, orBase, { reason: why });
  }

  const side = bullishBreak ? "CE" : "PE";

  // ── Wick-rejection filter ──────────────────────────────────────────────
  // Bullish: upper wick must be small relative to body. Bearish: lower wick.
  const wickFilterOn = (process.env.ORB_WICK_FILTER_ENABLED || "true").toLowerCase() === "true";
  const maxWickRatio = parseFloat(process.env.ORB_MAX_WICK_RATIO || "0.6");
  const relevantWick = side === "CE" ? upperWick : lowerWick;
  const wickRatio = body > 0 ? relevantWick / body : 999;
  const wickPass = wickRatio <= maxWickRatio;
  if (wickFilterOn && !wickPass) {
    return Object.assign({}, orBase, {
      wickRatio: Math.round(wickRatio * 100) / 100,
      wickPass:  false,
      reason: `Wick rejection — ${side === "CE" ? "upper" : "lower"} wick ${relevantWick.toFixed(1)}pt vs body ${body.toFixed(1)}pt (ratio ${wickRatio.toFixed(2)} > ${maxWickRatio})`,
    });
  }

  // ── VWAP alignment ─────────────────────────────────────────────────────
  const vwapFilterOn = (process.env.ORB_VWAP_FILTER_ENABLED || "true").toLowerCase() === "true";
  if (vwapFilterOn && vwap != null) {
    const ok = side === "CE" ? last.close > vwap : last.close < vwap;
    if (!ok) {
      return Object.assign({}, orBase, {
        wickRatio: Math.round(wickRatio * 100) / 100,
        wickPass:  true,
        reason: `VWAP misaligned — ${side} break but close ${last.close} ${side === "CE" ? "<=" : ">="} VWAP ${vwap}`,
      });
    }
  }

  // ── Volume confirmation ───────────────────────────────────────────────
  const volFilterOn = (process.env.ORB_VOL_FILTER_ENABLED || "false").toLowerCase() === "true";
  const volMult = parseFloat(process.env.ORB_VOL_MULT || "1.2");
  let volPass = null;
  if (volRatio != null) {
    volPass = volRatio >= volMult;
    if (volFilterOn && !volPass) {
      return Object.assign({}, orBase, {
        wickRatio: Math.round(wickRatio * 100) / 100,
        wickPass:  true,
        volPass:   false,
        reason: `Low volume — breakout volume ${volRatio.toFixed(2)}× avg(${volLookback}) < ${volMult}×`,
      });
    }
  }

  // ── Build signal ────────────────────────────────────────────────────────
  const entrySpot  = last.close;
  const slSpot     = side === "CE" ? or.low  : or.high;
  const tgtMult    = parseFloat(process.env.ORB_TARGET_RANGE_MULT || "1.5");
  const targetSpot = side === "CE" ? or.high + rangePts * tgtMult
                                   : or.low  - rangePts * tgtMult;

  const sweetMin   = parseFloat(process.env.ORB_SWEET_MIN || "30");
  const sweetMax   = parseFloat(process.env.ORB_SWEET_MAX || "80");
  const strongBody = parseFloat(process.env.ORB_STRONG_BODY || "15");
  const rangeSweet = rangePts >= sweetMin && rangePts <= sweetMax;
  const bodyStrong = body >= strongBody;
  const volStrong  = volPass !== false && (volRatio == null || volRatio >= volMult * 1.25);
  const wickClean  = wickRatio <= maxWickRatio * 0.6;
  const strength   = (rangeSweet && bodyStrong && volStrong && wickClean) ? "STRONG" : "MARGINAL";

  if (!silent) {
    const istStr = new Date(last.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    const volStr = volRatio != null ? `vol=${volRatio.toFixed(2)}×` : "vol=n/a";
    const vwapStr = vwap != null ? `vwap=${vwap}` : "vwap=n/a";
    console.log(`[ORB ${istStr}] BREAK ${side} | ORH=${or.high} ORL=${or.low} range=${rangePts}pt | close=${last.close} body=${body.toFixed(1)}pt wick=${wickRatio.toFixed(2)} ${vwapStr} ${volStr} [${strength}]`);
  }

  return Object.assign({}, orBase, {
    signal:        side === "CE" ? "BUY_CE" : "BUY_PE",
    side,
    entrySpot:     Math.round(entrySpot * 100) / 100,
    slSpot:        Math.round(slSpot * 100) / 100,
    targetSpot:    Math.round(targetSpot * 100) / 100,
    signalStrength: strength,
    wickRatio:     Math.round(wickRatio * 100) / 100,
    wickPass:      true,
    volPass:       volPass,
    reason: `ORB ${side} break (close ${last.close} ${side === "CE" ? ">" : "<"} ${side === "CE" ? "ORH" : "ORL"} ${side === "CE" ? or.high : or.low} + buffer ${buffer}pt, range=${rangePts}pt, body=${body.toFixed(1)}pt, wick=${wickRatio.toFixed(2)}${vwap != null ? `, vwap=${vwap}` : ""}${volRatio != null ? `, vol=${volRatio.toFixed(2)}×` : ""}) [${strength}]`,
  });
}

module.exports = { NAME, DESCRIPTION, getSignal, computeOpeningRange, computeVwap, computeVolumeRatio };

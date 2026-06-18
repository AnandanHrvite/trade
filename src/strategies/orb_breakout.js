/**
 * ORB — Opening Range Breakout (15-minute opening range, single-leg option buy)
 * ─────────────────────────────────────────────────────────────────────────────
 * Setup:
 *   • Build a 15-min "opening range" from the first 9:15–9:30 candles.
 *   • Once range is locked, watch for a 5-min CLOSE outside the range:
 *       — Close above ORH → BUY CE (bullish breakout, ATM strike)
 *       — Close below ORL → BUY PE (bearish breakdown, ATM strike)
 *   • Take ONE trade per session, intraday MIS, square-off at 15:15 IST.
 *
 * Confirmation filters (all env-toggled):
 *   • Range size sanity: ORH-ORL between ORB_MIN_RANGE_PTS (25) and
 *     ORB_MAX_RANGE_PTS (120). Too tight = noise. Too wide = exhausted.
 *   • Body size: breakout candle body >= ORB_MIN_BODY (8pt)
 *   • Wick rejection: upper/lower wick ratio <= ORB_MAX_WICK_RATIO (0.6).
 *     ORB_WICK_FILTER_ENABLED toggles.
 *   • VWAP alignment: CE only if close > VWAP, PE only if close < VWAP.
 *     ORB_VWAP_FILTER_ENABLED toggles. Falls back to TWAP if candles carry
 *     no volume.
 *   • Volume confirmation: breakout candle volume >= ORB_VOL_MULT × prev-5
 *     candle average. ORB_VOL_FILTER_ENABLED toggles. Silently skipped if
 *     candles carry no volume (indices have no spot volume — log once).
 *   • Entry window: 9:30 – ORB_ENTRY_END (12:00). Stale breakouts after
 *     noon tend to fade.
 *
 * Exit (handled by route, not signal file):
 *   • Target: +ORB_TARGET_PCT premium (40%) OR 1.5× range on spot
 *   • SL: −ORB_STOP_PCT premium (25%) OR opposite OR edge
 *   • Trail layer A: once spot moves >= 1× range in favour, lift SL to entry
 *   • Trail layer B (one-shot): once premium hits +ORB_PREMIUM_LOCKIN_PCT (25%)
 *     profit, lift premium SL to entry × (1 + ORB_PREMIUM_LOCKIN_FLOOR_PCT) (5%)
 *   • Trail layer C (continuous, ORB_TRAIL_ENABLED): once premium arms at
 *     +ORB_TRAIL_ARM_PCT (8%), ratchet premium SL behind the peak to keep
 *     ORB_TRAIL_LOCK_PCT (50%) of the running peak profit — stops a winner
 *     round-tripping to a loss.
 *   • Time stop: hard square-off at 15:15 IST.
 *
 * Returns:
 *   { signal, side, reason, orh, orl, rangePts, entrySpot, slSpot, targetSpot,
 *     signalStrength, vwap, vwapAligned, volRatio, volPass, wickRatio, wickPass }
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
  let sumPV = 0, sumV = 0, sumP = 0, count = 0, anyVol = false;
  for (const c of candles) {
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

  let high = -Infinity;
  let low  =  Infinity;
  let count = 0;
  for (const c of candles) {
    const m = _utcSecToIstMins(c.time);
    if (m < rangeStartMin) continue;
    if (m >= rangeEndMin)  break;
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
  const maxR = parseFloat(process.env.ORB_MAX_RANGE_PTS || "120");

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
  const bullishBreak = last.close > or.high && last.close > last.open && body >= minBody;
  const bearishBreak = last.close < or.low  && last.close < last.open && body >= minBody;

  if (!bullishBreak && !bearishBreak) {
    const aboveH = last.close > or.high;
    const belowL = last.close < or.low;
    let why;
    if (aboveH || belowL) {
      why = `Break ${aboveH ? "above" : "below"} but body too small or against (body=${body.toFixed(1)}pt, min=${minBody}pt)`;
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
  const volFilterOn = (process.env.ORB_VOL_FILTER_ENABLED || "true").toLowerCase() === "true";
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
    reason: `ORB ${side} break (close ${last.close} ${side === "CE" ? ">" : "<"} ${side === "CE" ? "ORH" : "ORL"} ${side === "CE" ? or.high : or.low}, range=${rangePts}pt, body=${body.toFixed(1)}pt, wick=${wickRatio.toFixed(2)}${vwap != null ? `, vwap=${vwap}` : ""}${volRatio != null ? `, vol=${volRatio.toFixed(2)}×` : ""}) [${strength}]`,
  });
}

module.exports = { NAME, DESCRIPTION, getSignal, computeOpeningRange, computeVwap, computeVolumeRatio };

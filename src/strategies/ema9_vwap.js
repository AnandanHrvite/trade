/**
 * EMA9 + VWAP-band crossover strategy  (NAME: "EMA9_VWAP")
 * ─────────────────────────────────────────────────────────────────────────────
 * 5-minute, intraday. Mirrors the TradingView setup the user trades by eye:
 *   • EMA 9 on close
 *   • Session-anchored VWAP (source = HLC3) with Standard-Deviation bands,
 *     multiplier #1 = 1  →  top line = VWAP + 1σ, bottom line = VWAP − 1σ
 *
 * Signals (evaluated on CLOSED candles — "wait for timeframe close"):
 *   CE entry : EMA9 crosses ABOVE the VWAP top line (VWAP + mult·σ)
 *   PE entry : EMA9 crosses BELOW the VWAP bottom line (VWAP − mult·σ)
 *
 * Exit is a PURE signal exit (no SL / target / trail — the engine owns EOD):
 *   CE exit  : EMA9 crosses back BELOW the top line (re-enters the band)
 *   PE exit  : EMA9 crosses back ABOVE the bottom line (re-enters the band)
 *
 * The engine (paper/live-harness/backtest) reads `signal` for entries and
 * `exitCE` / `exitPE` for exits, so all three surfaces stay identical.
 *
 * VWAP note (same caveat the ORB strategy documents): the NIFTY spot index has
 * no real per-bar volume in the Fyers feed, so this VWAP degenerates to a
 * session-anchored TWAP (equal/tick-count-weighted HLC3) and the σ bands to a
 * TWAP standard deviation. It tracks the TradingView shape closely but values
 * are not tick-identical. Band multiplier + EMA period are env-tunable.
 *
 * Contract: getSignal(candles, opts) → {
 *   signal: "BUY_CE" | "BUY_PE" | "NONE", side, reason, stopLoss(=null),
 *   signalStrength, ema9, vwap, vwapUpper, vwapLower, stdev, exitCE, exitPE
 * }
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { EMA } = require("technicalindicators");

const NAME = "EMA9_VWAP";
const DESCRIPTION = "EMA9 crosses VWAP ±σ band (5m, session-anchored)";

function _round2(n) { return Math.round(n * 100) / 100; }

// IST minutes-of-day from a unix-SECONDS candle time (UTC+5:30 = +19800s).
function _utcSecToIstMins(unixSec) {
  return Math.floor((unixSec + 19800) / 60) % 1440;
}

function _emaPeriod() { return Math.max(2, parseInt(process.env.EMA9VWAP_EMA_PERIOD || "9", 10) || 9); }
function _bandMult()  { const m = parseFloat(process.env.EMA9VWAP_BAND_MULT); return isNaN(m) ? 1.0 : m; }
// Strength grading: how far EMA9 broke PAST the band edge, measured in σ units
// (scale-free, so it adapts to the day's volatility). A break of >= this many σ
// is "STRONG", anything smaller is "WEAK" (likely noise). Default 0.25σ.
function _strongMinSigma() { const s = parseFloat(process.env.EMA9VWAP_STRONG_MIN_SIGMA); return isNaN(s) ? 0.25 : Math.max(0, s); }
// When ON, WEAK crosses are suppressed (fewer, higher-quality entries). Default
// OFF so behaviour is unchanged until you validate it on backtest/replay.
function _strengthFilterOn() { return String(process.env.EMA9VWAP_STRENGTH_FILTER || "false").toLowerCase() === "true"; }
// Classify a break distance (EMA9 beyond the band edge, in points) vs σ.
function _gradeStrength(distPts, stdev) {
  if (!(stdev > 0)) return "STRONG";           // no vol estimate → don't filter
  return distPts >= _strongMinSigma() * stdev ? "STRONG" : "WEAK";
}
function _anchorMins() {
  const raw = process.env.EMA9VWAP_VWAP_SESSION_START || "09:15";
  const [h, m] = raw.split(":").map(Number);
  return (h || 0) * 60 + (isNaN(m) ? 0 : m);
}

/**
 * Session-anchored VWAP + Standard-Deviation bands over the given candles.
 * Volume-weighted when candles carry real volume; equal-weighted (TWAP) fallback
 * otherwise — exactly matching the ORB computeVwap convention, extended with the
 * volume-weighted variance TradingView uses for its "Standard Deviation" bands.
 * Returns { vwap, upper, lower, stdev } or null if no in-session candles.
 */
function computeVwapBands(candles, anchorMins, mult) {
  if (!candles || candles.length === 0) return null;
  if (anchorMins == null) anchorMins = _anchorMins();
  if (mult == null) mult = _bandMult();
  let sumPV = 0, sumV = 0, sumPV2 = 0;       // volume-weighted accumulators
  let sumP = 0, sumP2 = 0, count = 0;        // equal-weight fallback accumulators
  let anyVol = false;
  // Session-anchored: VWAP resets every trading day. The candle array may span many
  // days (warmup history), so restrict to the SAME IST date as the latest candle.
  const _lastDay = Math.floor((candles[candles.length - 1].time + 19800) / 86400);
  for (const c of candles) {
    if (Math.floor((c.time + 19800) / 86400) !== _lastDay) continue; // current day only
    if (_utcSecToIstMins(c.time) < anchorMins) continue;
    const tp = (c.high + c.low + c.close) / 3;   // HLC3 typical price (TV VWAP source)
    sumP += tp; sumP2 += tp * tp; count++;
    const v = (typeof c.volume === "number" && c.volume > 0) ? c.volume : 0;
    if (v > 0) { sumPV += tp * v; sumV += v; sumPV2 += tp * tp * v; anyVol = true; }
  }
  if (count === 0) return null;
  let vwap, variance;
  if (anyVol && sumV > 0) {
    vwap = sumPV / sumV;
    variance = (sumPV2 / sumV) - vwap * vwap;
  } else {
    vwap = sumP / count;
    variance = (sumP2 / count) - vwap * vwap;
  }
  const stdev = Math.sqrt(Math.max(variance, 0));
  return {
    vwap:  _round2(vwap),
    upper: _round2(vwap + mult * stdev),
    lower: _round2(vwap - mult * stdev),
    stdev: _round2(stdev),
  };
}

/**
 * Per-candle VWAP/band series for charting. Returns an array aligned to `candles`
 * (entries before the session anchor are null). Each entry: {time, vwap, upper, lower}.
 */
function vwapSeries(candles, anchorMins, mult) {
  if (anchorMins == null) anchorMins = _anchorMins();
  if (mult == null) mult = _bandMult();
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const b = computeVwapBands(candles.slice(0, i + 1), anchorMins, mult);
    out.push(b ? { time: candles[i].time, vwap: b.vwap, upper: b.upper, lower: b.lower } : null);
  }
  return out;
}

/**
 * getSignal — evaluate the EMA9-vs-VWAP-band cross on the latest CLOSED candle.
 * `candles` is ascending OHLC(+volume); the last element is the signal candle.
 */
function getSignal(candles, opts) {
  opts = opts || {};
  const period = _emaPeriod();
  const mult   = _bandMult();
  const anchor = _anchorMins();
  const base = {
    signal: "NONE", side: null, reason: "warming up", stopLoss: null,
    signalStrength: "STRONG",
    ema9: null, vwap: null, vwapUpper: null, vwapLower: null, stdev: null,
    exitCE: false, exitPE: false,
  };

  if (!candles || candles.length < period + 2) return base;

  const closes = candles.map(c => c.close);
  const emaArr = EMA.calculate({ period, values: closes });
  if (emaArr.length < 2) return base;
  const ema9Now  = emaArr[emaArr.length - 1];   // aligns with last candle
  const ema9Prev = emaArr[emaArr.length - 2];   // aligns with previous candle

  const bandsNow  = computeVwapBands(candles, anchor, mult);                 // band at last candle
  const bandsPrev = computeVwapBands(candles.slice(0, -1), anchor, mult);    // band at previous candle
  if (!bandsNow || !bandsPrev || ema9Now == null || ema9Prev == null) {
    return { ...base, reason: "vwap warming up" };
  }

  const upNow = bandsNow.upper, loNow = bandsNow.lower;
  const upPrev = bandsPrev.upper, loPrev = bandsPrev.lower;

  // Series crossovers (EMA9 vs the band line, comparing each at its own candle).
  const crossAboveTop    = ema9Prev <= upPrev && ema9Now > upNow;   // CE entry
  const crossBelowBottom = ema9Prev >= loPrev && ema9Now < loNow;   // PE entry
  const crossBackInsideTop    = ema9Prev >= upPrev && ema9Now < upNow; // CE exit
  const crossBackInsideBottom = ema9Prev <= loPrev && ema9Now > loNow; // PE exit

  const result = {
    ...base,
    ema9: _round2(ema9Now),
    vwap: bandsNow.vwap, vwapUpper: upNow, vwapLower: loNow, stdev: bandsNow.stdev,
    exitCE: crossBackInsideTop,
    exitPE: crossBackInsideBottom,
  };

  if (crossAboveTop) {
    result.signal = "BUY_CE"; result.side = "CE";
    const dist = _round2(ema9Now - upNow);                       // pts EMA9 broke above the top band
    result.signalStrength = _gradeStrength(dist, bandsNow.stdev);
    result.reason = `EMA9 ${result.ema9} crossed ABOVE VWAP top ${upNow} (VWAP ${bandsNow.vwap} +${mult}σ) | break ${dist}pt = ${result.signalStrength}`;
  } else if (crossBelowBottom) {
    result.signal = "BUY_PE"; result.side = "PE";
    const dist = _round2(loNow - ema9Now);                       // pts EMA9 broke below the bottom band
    result.signalStrength = _gradeStrength(dist, bandsNow.stdev);
    result.reason = `EMA9 ${result.ema9} crossed BELOW VWAP bottom ${loNow} (VWAP ${bandsNow.vwap} -${mult}σ) | break ${dist}pt = ${result.signalStrength}`;
  } else {
    result.reason = `no cross — EMA9 ${result.ema9} vs band [${loNow}, ${upNow}]`;
  }

  // Strength filter (default OFF): drop WEAK crosses so only meaningful breaks
  // trade. Applied here in the shared strategy so paper / live-harness / backtest
  // all behave identically. Exits (exitCE/exitPE) are left untouched.
  if (result.signal !== "NONE" && result.signalStrength === "WEAK" && _strengthFilterOn()) {
    result.reason = `filtered WEAK ${result.side} break — ${result.reason}`;
    result.signal = "NONE"; result.side = null;
  }

  if (!opts.silent) {
    // logging is the engine's job; keep the module quiet by default
  }
  return result;
}

module.exports = { NAME, DESCRIPTION, getSignal, computeVwapBands, vwapSeries };

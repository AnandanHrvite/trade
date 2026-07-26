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
 * ── Why equal-weight (TWAP), and why it is NOT optional ─────────────────────
 * This VWAP is an EQUAL-WEIGHTED mean of HLC3 over the session, with σ bands from
 * the equal-weighted variance. Volume is deliberately never read. That is a
 * PARITY requirement, not a simplification:
 *
 *   • Fyers HISTORY for NSE:NIFTY50-INDEX DOES return per-bar volume
 *     (e.g. 41,002,444 on a 5-min bar) — the Backtest sees it.
 *   • The Fyers live TICK feed does NOT carry per-bar index volume; Paper/Live
 *     build bars with `volume: tick.vol_traded_today || 0`, i.e. zero.
 *   • Replay rebuilds bars from recorded ticks — also zero.
 *
 * So a volume-aware formula makes each engine compute a DIFFERENT band from the
 * same session. Measured on 20 real April-2026 sessions, a volume-weighted
 * Backtest vs an equal-weighted Paper differed by up to 80.49 points on a band
 * line and flipped the signal/exit flag on 41 of 640 evaluations (6.4%).
 * Equal-weight is the only formula all four engines can compute identically, and
 * it is the formula every recorded Paper trade was produced with (Paper is
 * canonical). Removing the volume branch is what makes ONE implementation
 * authoritative — no engine can silently diverge.
 *
 * TRADE-OFF (documented, not hidden): TradingView's VWAP is volume-weighted, so
 * absolute band values here will differ from a TV VWAP overlay on a volume-
 * bearing NIFTY chart. The EMA9 cross, the σ-band shape and the session anchor
 * are faithful; the weighting is not. Matching TV exactly would require per-bar
 * volume on the LIVE path, which the tick feed does not provide — see
 * "Remaining limitation" in the EMA9+VWAP section of README.md.
 *
 * Band multiplier + EMA period are env-tunable.
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

// IST calendar-day index from a unix-SECONDS candle time. India has no DST, so a
// fixed +5:30 shift is exact. Same convention computeVwapBands uses internally.
function _istDay(unixSec) {
  return Math.floor((unixSec + 19800) / 86400);
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
  // σ == 0 happens on the FIRST in-session candle (one sample, zero variance).
  // Grading that "STRONG" would make the noisiest bar of the day rate best, so
  // an unmeasurable break is graded WEAK — conservative, and it only matters
  // when EMA9VWAP_STRENGTH_FILTER is on (the filter drops WEAK). With the
  // filter off (the default) this label is metadata only and changes no trade.
  if (!(stdev > 0)) return "WEAK";
  return distPts >= _strongMinSigma() * stdev ? "STRONG" : "WEAK";
}
// Parse "HH:MM" → minutes-of-day. Falls back to `def` on anything malformed
// rather than silently collapsing to midnight (a bad value used to widen the
// VWAP anchor / entry window to the whole day without a word).
function _parseHHMM(raw, def) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(raw == null ? "" : raw));
  if (!m) return def;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return def;
  return h * 60 + mm;
}

function _anchorMins() {
  return _parseHHMM(process.env.EMA9VWAP_VWAP_SESSION_START, 9 * 60 + 15);
}

/**
 * THE entry-window rule, shared by Paper, Live and Backtest so no engine can
 * drift. Evaluated from the CANDLE TIMESTAMP — never from wall-clock — so the
 * same candle always yields the same answer in live, replay and backtest.
 *
 * The window bounds a signal by the time the signal EXISTS, i.e. the moment its
 * candle CLOSES (= candle.time + resolution). This matches what Paper has always
 * done (it evaluated wall-clock inside onCandleClose, which fires on the close);
 * the Backtest used to gate on the candle's START time and therefore shifted the
 * whole window one bar in both directions.
 *
 * @param {number} candleTimeSec  bar START time, unix seconds
 * @param {number} resolutionMins bar length in minutes
 */
function isEntryWindowOpen(candleTimeSec, resolutionMins) {
  const start = _parseHHMM(process.env.EMA9VWAP_ENTRY_START, 10 * 60 + 30);
  const end   = _parseHHMM(process.env.EMA9VWAP_ENTRY_END,   14 * 60 + 30);
  const res   = Number.isFinite(resolutionMins) && resolutionMins > 0 ? resolutionMins : 5;
  const closeMins = _utcSecToIstMins(candleTimeSec) + res;   // when the bar closes
  return closeMins >= start && closeMins < end;
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
  // ── ONE authoritative weighting: EQUAL-WEIGHT (TWAP) of HLC3. See the
  //    "Why equal-weight" note in the file header. `candle.volume` is
  //    deliberately NOT read here — it is the only field whose provenance
  //    differs between engines, and reading it is what made Paper and Backtest
  //    compute different bands for the same session.
  let sumP = 0, sumP2 = 0, count = 0;
  // Session-anchored: VWAP resets every trading day. The candle array may span many
  // days (warmup history), so restrict to the SAME IST date as the latest candle.
  const _lastDay = Math.floor((candles[candles.length - 1].time + 19800) / 86400);
  for (const c of candles) {
    if (Math.floor((c.time + 19800) / 86400) !== _lastDay) continue; // current day only
    if (_utcSecToIstMins(c.time) < anchorMins) continue;
    const tp = (c.high + c.low + c.close) / 3;   // HLC3 typical price (TV VWAP source)
    sumP += tp; sumP2 += tp * tp; count++;
  }
  if (count === 0) return null;
  const vwap     = sumP / count;
  const variance = (sumP2 / count) - vwap * vwap;
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

  // Session-boundary guard. computeVwapBands anchors on the IST day of the LAST
  // candle it is given, so on the first candle of a new day `candles.slice(0,-1)`
  // ends on YESTERDAY and returns yesterday's completed band — comparing today's
  // EMA9 against it is meaningless. The previous band must come from the same
  // session; when there is no same-day predecessor we are still warming up.
  const _lastC = candles[candles.length - 1];
  const _prevC = candles[candles.length - 2];
  const _sameSession = !!_prevC && _istDay(_prevC.time) === _istDay(_lastC.time);
  const bandsPrev = _sameSession ? computeVwapBands(candles.slice(0, -1), anchor, mult) : null;
  if (!bandsNow || !bandsPrev || ema9Now == null || ema9Prev == null) {
    return {
      ...base,
      reason: _sameSession
        ? "vwap warming up"
        : "vwap warming up — first candle of session (no same-day previous band)",
    };
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

module.exports = {
  NAME, DESCRIPTION, getSignal, computeVwapBands, vwapSeries,
  // Shared so Paper / Live / Backtest cannot drift on the window rule.
  isEntryWindowOpen,
};

/**
 * BB_RSI V8: Bollinger Band MEAN REVERSION + RSI extreme
 *
 * Replaces the V7 breakout engine outright (2026-08-14). V7 bought the BREAK — CE when
 * price closed ABOVE the upper band. V8 fades it: an extreme stretch away from the mean
 * is expected to come back to it, so the side is inverted and SuperTrend is gone (a
 * trend filter agrees with the breakout and therefore vetoes every fade).
 *
 * ENTRY (evaluated on a closed candle, all required):
 *   CE (fade a drop): close ≤ BB lower  AND RSI ≤ BB_RSI_RSI_CE_THRESHOLD (default 25)
 *   PE (fade a rip):  close ≥ BB upper  AND RSI ≥ BB_RSI_RSI_PE_THRESHOLD (default 75)
 *
 *   BB_RSI_DIRECTION (default "fade") picks which way those two triggers are traded:
 *     • fade     — as above. The V8 mean-reversion engine, unchanged.
 *     • breakout — the SAME two signal bars, opposite side: a close above the upper
 *       band buys CE, a close below the lower band buys PE (the V7 side mapping).
 *       Everything else — the chop guards and the signal-candle width cap — is
 *       identical, which is the point: it makes fade-vs-break a controlled A/B over
 *       one backtest range rather than a comparison of two different engines.
 *       "STRONG" flips to mean RSI further WITH the break instead of further into
 *       the extreme.
 *       The divergence filter below is a mean-reversion tell — it argues the move is
 *       exhausted — so leave it off in breakout mode; requiring it would keep only the
 *       breakouts that are already failing.
 *
 *   Chop guards — the failure mode the operator described: a sideways tape pins price to
 *   a band that has collapsed to noise width, the fade signal repeats every few candles
 *   and each one bleeds.
 *     • Band width (BB_RSI_BAND_WIDTH_ENABLED, default on): require
 *       (upper − lower) ≥ BB_RSI_MIN_BAND_WIDTH_PTS. A skinny band is not a stretch.
 *     • RSI range (BB_RSI_RSI_RANGE_ENABLED, default on): over the
 *       BB_RSI_RSI_RANGE_LOOKBACK candles ENDING AT THE PREVIOUS BAR — deliberately
 *       excluding the signal bar, whose own spike would otherwise satisfy the test —
 *       require max(RSI) − min(RSI) ≥ BB_RSI_RSI_RANGE_MIN. A tape whose RSI has been
 *       pinned mid-range is dead, and its band touches mean nothing.
 *     • ADX ceiling (BB_RSI_ADX_ENABLED, default off): block when ADX(14) ≥
 *       BB_RSI_ADX_MAX. NOTE the direction is inverted vs V7: a fade is run over by a
 *       strong trend, so a HIGH ADX is the danger here, not a low one.
 *
 *   Divergence (BB_RSI_DIVERGENCE_ENABLED, default OFF — optional filter): require the
 *   classic reversal tell — price makes a new extreme that RSI does not confirm.
 *     CE: signal bar's low  < the most recent confirmed pivot low,  RSI now > RSI there.
 *     PE: signal bar's high > the most recent confirmed pivot high, RSI now < RSI there.
 *   A pivot needs BB_RSI_DIV_PIVOT_BARS bars either side to be confirmed, and is looked
 *   for within BB_RSI_DIV_LOOKBACK bars. No pivot found = no divergence = blocked (the
 *   gate fails closed; an unprovable filter must not wave the trade through).
 *
 *   RSI turning (BB_RSI_RSI_TURNING, default off): also require RSI to have already
 *   turned back (CE: RSI rising vs the prior bar; PE: falling) — the earliest possible
 *   confirmation that the stretch is done.
 *
 *   Signal-candle width cap: BB_RSI_MAX_ENTRY_SL_PTS skips entries whose signal candle's
 *   extreme (CE → its low, PE → its high) is more than N pts from close. The extreme is
 *   also returned as `stopLoss` / the middle band as `target` — signal metadata only
 *   (the swing scanner displays them); no engine trades on either.
 *
 * EXIT: none here. The only automatic exit in every BB_RSI engine is the global profit
 * lock (tradeGuards.checkProfitLock); the session teardown closes anything still open.
 */

const { BollingerBands, RSI, ADX } = require("technicalindicators");

const NAME        = "BB_RSI_MEAN_REVERSION_V8";
const DESCRIPTION = "BB fade + RSI extreme";

// ── Env-prefix parameterisation ──────────────────────────────────────────────
// This ONE engine serves the BB_RSI options strategy and its NIFTY FUTURES twin
// (FUT_BB_RSI). Every strategy-own key is read as `<prefix>_<NAME>`, so the twin
// tunes independently on FUT_BB_RSI_* while the rules stay one implementation.
// The module's own exports are bound to the default prefix and read exactly the
// BB_RSI_* keys they always did; forPrefix("FUT_BB_RSI") returns the same API
// bound to the twin. Common keys (TRADE_RESOLUTION) are not prefixed.
const DEFAULT_PREFIX = "BB_RSI";
const PREFIXES = { BB_RSI: "NIFTY", FUT_BB_RSI: "NIFTY" };
function _P(prefix) { return prefix || DEFAULT_PREFIX; }

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }
function cfgOn(key, fb) { return String(cfg(key, fb)).toLowerCase() === "true"; }

// ── Strict numeric config reads ──────────────────────────────────────────────
// A malformed value falls back to the DOCUMENTED DEFAULT — never to NaN, and never to
// a half-parsed number. Both of those failure modes are silent and both are dangerous
// here: a NaN threshold makes every comparison against it false, which switches a chop
// guard OFF rather than on, and bare parseFloat("5o") hands back 5 when the operator
// meant 50. This repo has already ruled that class of bug out twice — boundedExit's
// LIVE_EXIT_WAIT_MS falls back rather than removing its ceiling, and EMA9_VWAP's HH:MM
// window falls back rather than collapsing to midnight — so the same rule applies here.
// An explicit 0 still parses cleanly, so every documented "0 = off" opt-out keeps working.
//
// The optional `min` is a FLOOR for the structural inputs — periods, lookbacks and
// candle counts — where a 0 expresses no intent and produces nonsense rather than
// "off" (those have their own toggles). Without it BB_PERIOD=0 throws straight out of
// BollingerBands.calculate, and an opposite-candle COUNT of 0 makes `count >= 0`
// always true, i.e. exit on the first candle close of every trade. Thresholds and
// point values deliberately take NO floor: 0 is a documented opt-out for those.
function num(key, fb, min) {
  var raw = String(cfg(key, fb)).trim();
  var v = /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw) ? parseFloat(raw) : NaN;
  if (!Number.isFinite(v)) v = parseFloat(fb);
  return (min != null && v < min) ? min : v;
}
function int(key, fb, min) {
  var raw = String(cfg(key, fb)).trim();
  var v = /^[+-]?\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(v)) v = parseInt(fb, 10);
  return (min != null && v < min) ? min : v;
}

// ── Direction: fade the band, or trade the break ─────────────────────────────
// Same signal bars either way — only the side flips. Unrecognised values fall back to
// "fade" so a typo cannot silently invert every live entry; the fallback is the shipped
// V8 behaviour, i.e. an untouched .env is unaffected by this key existing.
// Read live from process.env (never cached) so a Settings save reaches Paper and
// Backtest without a restart, exactly like every other key in this engine.
const DIRECTION_CHOICES = ["fade", "breakout"];
function direction(prefix) {
  const raw = String(cfg(_P(prefix) + "_DIRECTION", "fade")).trim().toLowerCase();
  return DIRECTION_CHOICES.indexOf(raw) !== -1 ? raw : "fade";
}
function isBreakout(prefix) { return direction(prefix) === "breakout"; }

// ── Candle timeframe ─────────────────────────────────────────────────────────
// BB_RSI may run on its own candle size instead of the global TRADE_RESOLUTION.
// This is a fade of a stretched band, so 3-min and 5-min are genuinely different
// strategies — 3-min reaches the band more often and reverts sooner — and the
// operator needs to be able to run one without dragging every other strategy
// with it. Only 3 and 5 are offered: the RSI/band defaults are tuned around
// intraday bars, and 15-min gives a mean-reversion engine too few bars to work
// with inside the 09:21–14:30 window.
//
// "global" (the default) follows TRADE_RESOLUTION, so an untouched .env behaves
// exactly as it did before this key existed. Anything unrecognised — a typo, a
// stale 15 left over from a global-resolution experiment — also falls back to
// the global rather than to NaN, which would poison every bucket boundary.
// It lives in the engine, not in the three routes, so Paper / Live / Backtest
// cannot drift onto different candle sizes.
const RESOLUTION_CHOICES = [3, 5];
function resolutionMin(prefix) {
  var raw = String(cfg(_P(prefix) + "_RESOLUTION", "global")).trim();
  var v = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  if (RESOLUTION_CHOICES.indexOf(v) !== -1) return v;
  return int("TRADE_RESOLUTION", "5", 1);
}

// ── Trading window ───────────────────────────────────────────────────────────
// "HH:MM" → minutes past midnight, or null if it is not a real time of day.
function _hhmm(s) {
  var m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s == null ? "" : s));
  if (!m) return null;
  var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
// A malformed window must fall back to the documented default, never to NaN: a NaN
// bound makes BOTH window comparisons false, which silently removes the entry window
// altogether and trades the entire session.
function _parseMins(envKey, fallback) {
  var v = _hhmm(process.env[envKey]);
  return v == null ? _hhmm(fallback) : v;
}
function _fmtTime(mins) {
  var h = Math.floor(mins / 60), m = mins % 60;
  var suffix = h >= 12 ? "PM" : "AM";
  var h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return h12 + ":" + (m < 10 ? "0" : "") + m + " " + suffix;
}

function isInTradingWindow(unixSec, prefix) {
  var P = _P(prefix);
  var d = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  var startMin = _parseMins(P + "_ENTRY_START", "09:21");
  var endMin   = _parseMins(P + "_ENTRY_END",   "14:30");
  if (totalMin < startMin) return { ok: false, reason: "Before " + _fmtTime(startMin) };
  if (totalMin >= endMin)  return { ok: false, reason: "After " + _fmtTime(endMin) };
  return { ok: true, reason: null };
}

// ── Indicator cache — avoid redundant recalculation on every tick ────────────
// Cache key = last closed candle time + current candle OHLC (changes on each tick)
// If the closed candles haven't changed AND current bar is same, reuse cached indicators.
// One cache PER PREFIX, and getSignal adds the BB/RSI periods to the key: a twin tuned to
// different periods, or a /backtest run with custom periods (utils/scopedEnv.js) sharing
// this process with paper, must never be handed indicators computed for other periods.
const _indicatorCaches = {};
function _emptyCache() { return { key: null, bb: null, rsiArr: null, adx: null }; }
function _cacheFor(P) { return _indicatorCaches[P] || (_indicatorCaches[P] = _emptyCache()); }

function _makeIndicatorKey(candles) {
  if (candles.length < 2) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  // Key on: prev candle time (closed candles change) + current bar OHLC
  return `${prev.time}:${candles.length}:${last.open}:${last.high}:${last.low}:${last.close}`;
}

// ── Divergence ───────────────────────────────────────────────────────────────
// The newer of the two comparison points is the SIGNAL candle itself, not a confirmed
// pivot: a pivot needs bars to its right to be confirmed, so waiting for one would put
// the entry several candles after the extreme it is fading. The older point is the most
// recent CONFIRMED pivot within the lookback.
//   rsiArr is the raw technicalindicators output; rsiOffset maps candle index → RSI
//   index (rsi for candles[i] is rsiArr[i - rsiOffset]).
// Returns null when no pivot exists in range — the caller treats that as "not proven".
function _findDivergence(candles, rsiArr, rsiOffset, side, lookback, pivotBars) {
  var n = candles.length;
  var cur = candles[n - 1];
  var curRsi = rsiArr[(n - 1) - rsiOffset];
  if (curRsi == null) return null;

  var last  = n - 1 - pivotBars;                              // newest index that can be confirmed
  var first = Math.max(rsiOffset + pivotBars, n - 1 - lookback);
  for (var i = last; i >= first; i--) {
    var isPivot = true;
    for (var k = i - pivotBars; k <= i + pivotBars; k++) {
      if (k < 0 || k >= n || k === i) continue;
      var beaten = side === "CE" ? (candles[k].low < candles[i].low) : (candles[k].high > candles[i].high);
      if (beaten) { isPivot = false; break; }
    }
    if (!isPivot) continue;

    var pivRsi = rsiArr[i - rsiOffset];
    if (pivRsi == null) continue;

    if (side === "CE") {
      // Bullish: price prints a LOWER low while RSI prints a HIGHER low.
      return {
        ok: cur.low < candles[i].low && curRsi > pivRsi,
        barsBack: n - 1 - i,
        pivotPrice: parseFloat(candles[i].low.toFixed(2)),
        pivotRsi: parseFloat(pivRsi.toFixed(1)),
        nowPrice: parseFloat(cur.low.toFixed(2)),
        nowRsi: parseFloat(curRsi.toFixed(1)),
      };
    }
    // Bearish: price prints a HIGHER high while RSI prints a LOWER high.
    return {
      ok: cur.high > candles[i].high && curRsi < pivRsi,
      barsBack: n - 1 - i,
      pivotPrice: parseFloat(candles[i].high.toFixed(2)),
      pivotRsi: parseFloat(pivRsi.toFixed(1)),
      nowPrice: parseFloat(cur.high.toFixed(2)),
      nowRsi: parseFloat(curRsi.toFixed(1)),
    };
  }
  return null;
}

// ── Main signal function ─────────────────────────────────────────────────────
function getSignal(candles, opts) {
  opts = opts || {};
  var silent = opts.silent === true;
  var P = _P(opts.prefix);
  var _cache = _cacheFor(P);

  var BB_PERIOD   = int(P + "_BB_PERIOD", "30", 2);
  var BB_STDDEV   = num(P + "_BB_STDDEV", "2", 0.1);
  var RSI_PERIOD  = int(P + "_RSI_PERIOD", "14", 2);
  var RSI_CE      = num(P + "_RSI_CE_THRESHOLD", "25"); // CE needs RSI AT OR BELOW this
  var RSI_PE      = num(P + "_RSI_PE_THRESHOLD", "75"); // PE needs RSI AT OR ABOVE this
  var RSI_TURNING = cfgOn(P + "_RSI_TURNING", "false");             // require RSI to have already turned back
  var MAX_ENTRY_SL_PTS = num(P + "_MAX_ENTRY_SL_PTS", "50"); // signal-candle extreme distance cap (0 = off)
  var ADX_ENABLED = cfgOn(P + "_ADX_ENABLED", "false");
  var ADX_MAX     = num(P + "_ADX_MAX", "30");          // block when the trend is too strong to fade

  var BW_ENABLED  = cfgOn(P + "_BAND_WIDTH_ENABLED", "true");
  var BW_MIN      = num(P + "_MIN_BAND_WIDTH_PTS", "50");
  var RR_ENABLED  = cfgOn(P + "_RSI_RANGE_ENABLED", "true");
  var RR_LOOKBACK = int(P + "_RSI_RANGE_LOOKBACK", "20");
  var RR_MIN      = num(P + "_RSI_RANGE_MIN", "30");
  var DIV_ENABLED = cfgOn(P + "_DIVERGENCE_ENABLED", "false");
  var DIV_LOOKBACK  = int(P + "_DIV_LOOKBACK", "20", 1);
  var DIV_PIVOT_BARS = int(P + "_DIV_PIVOT_BARS", "2", 1);

  var base = {
    signal: "NONE", reason: "", stopLoss: null, target: null,
    rsi: null, adx: null,
    bbUpper: null, bbMiddle: null, bbLower: null,
  };

  // Warm-up
  var minCandles = Math.max(BB_PERIOD + 5, RSI_PERIOD + 5, 30);
  if (candles.length < minCandles) {
    base.reason = "Warming up (" + candles.length + "/" + minCandles + ")";
    return base;
  }

  var sc = candles[candles.length - 1];
  if (!opts.skipTimeCheck) {
    var windowCheck = isInTradingWindow(sc.time, P);
    if (!windowCheck.ok) {
      base.reason = windowCheck.reason;
      return base;
    }
  }

  // ── Indicators (with cache to avoid redundant recalculation) ──────────────
  var cacheKey = _makeIndicatorKey(candles);
  if (cacheKey) cacheKey += "|" + BB_PERIOD + ":" + BB_STDDEV + ":" + RSI_PERIOD;
  var bb, rsiArr, adx;

  if (cacheKey && _cache.key === cacheKey && _cache.bb) {
    bb     = _cache.bb;
    rsiArr = _cache.rsiArr;
    adx    = _cache.adx;
  } else {
    var closes = candles.map(function(c) { return c.close; });
    var highs  = candles.map(function(c) { return c.high; });
    var lows   = candles.map(function(c) { return c.low; });

    // Bollinger Bands
    var bbArr = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes });
    if (bbArr.length < 1) { base.reason = "BB warming up"; return base; }
    bb = bbArr[bbArr.length - 1];

    // RSI — the whole series is kept: the range filter and the divergence scan both
    // need history, not just the latest value.
    rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
    if (rsiArr.length < 1) { base.reason = "RSI warming up"; return base; }

    // ADX (trend strength) — computed every candle so it can be charted and logged at
    // entry/exit, not just when the ADX ceiling filter is on.
    var adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    adx = adxArr.length > 0 ? adxArr[adxArr.length - 1].adx : null;

    // Cache for next tick with same window
    _cache = _indicatorCaches[P] = { key: cacheKey, bb: bb, rsiArr: rsiArr, adx: adx };
  }

  // RSI index for candles[i] is rsiArr[i - rsiOffset].
  var rsiOffset = candles.length - rsiArr.length;
  var rsi     = rsiArr[rsiArr.length - 1];
  var rsiPrev = rsiArr.length >= 2 ? rsiArr[rsiArr.length - 2] : rsi;

  base.bbUpper  = parseFloat(bb.upper.toFixed(2));
  base.bbMiddle = parseFloat(bb.middle.toFixed(2));
  base.bbLower  = parseFloat(bb.lower.toFixed(2));
  base.bbWidth  = parseFloat((bb.upper - bb.lower).toFixed(2));
  base.rsi = parseFloat(rsi.toFixed(1));
  base.adx = adx != null ? parseFloat(adx.toFixed(1)) : null;

  var _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23" });

  // ── Chop guard 1: band width ──────────────────────────────────────────────
  // A band collapsed to noise width has no "stretch" to fade — every touch is just the
  // tape breathing, and each fade pays the spread for nothing.
  // (the width itself is already on base.bbWidth, which is what the skip log records)
  var bandWidth = bb.upper - bb.lower;
  if (BW_ENABLED && BW_MIN > 0 && bandWidth < BW_MIN) {
    base.reason = "No setup (band too narrow — " + bandWidth.toFixed(0) + "pts < " + BW_MIN + ")";
    return base;
  }

  // ── Chop guard 2: RSI has been alive recently ─────────────────────────────
  // Measured over the bars BEFORE the signal bar. Including the signal bar would make
  // the test self-satisfying: its own spike to 75/25 is exactly the excursion being
  // measured, so a dead tape with one poke would always pass.
  var rsiRange = null;
  if (RR_ENABLED && RR_LOOKBACK > 0 && rsiArr.length >= 6) {
    var seg = rsiArr.slice(Math.max(0, rsiArr.length - 1 - RR_LOOKBACK), rsiArr.length - 1);
    if (seg.length >= 5) {
      rsiRange = parseFloat((Math.max.apply(null, seg) - Math.min.apply(null, seg)).toFixed(1));
      base.rsiRange = rsiRange;
      if (rsiRange < RR_MIN) {
        base.reason = "No setup (RSI flat — " + rsiRange + " range over " + seg.length + " bars < " + RR_MIN + ")";
        return base;
      }
    }
  }

  // ── Chop guard 3: ADX ceiling (optional) ──────────────────────────────────
  // Inverted vs the V7 breakout engine: a fade is run over by a strong trend, so block
  // when ADX is HIGH. If ADX has no value yet (warm-up), pass through.
  if (ADX_ENABLED && Number.isFinite(adx) && adx >= ADX_MAX) {
    base.reason = "No setup (trend too strong to fade — ADX=" + adx.toFixed(1) + " ≥ " + ADX_MAX + ")";
    return base;
  }

  // ── ENTRY CONDITIONS ──────────────────────────────────────────────────────
  // The two triggers are the same in both directions; only the side they buy differs.
  //   stretched DOWN: close BELOW the lower band with RSI oversold   → fade CE / break PE
  //   stretched UP:   close ABOVE the upper band with RSI overbought → fade PE / break CE
  var BREAKOUT  = isBreakout(P);
  var ceStretch = sc.close <= bb.lower;   // stretched down
  var peStretch = sc.close >= bb.upper;   // stretched up
  var _dnSide   = BREAKOUT ? "PE" : "CE"; // side taken on a downward stretch
  var _upSide   = BREAKOUT ? "CE" : "PE"; // side taken on an upward stretch

  // ── Near-miss filter audit (additive-only logging; does NOT affect signal) ──
  // Keyed by the side that WOULD be entered, so the near-miss log still reads as
  // "how close was the CE entry" whichever direction is configured.
  var _dnAuditChecks = [
    { name: "below BB lower", ok: ceStretch,      detail: "close=" + sc.close + " vs BB_L=" + bb.lower.toFixed(1) },
    { name: "RSI oversold",   ok: rsi <= RSI_CE,  detail: "RSI=" + rsi.toFixed(1) + " vs ≤" + RSI_CE },
  ];
  var _upAuditChecks = [
    { name: "above BB upper", ok: peStretch,      detail: "close=" + sc.close + " vs BB_U=" + bb.upper.toFixed(1) },
    { name: "RSI overbought", ok: rsi >= RSI_PE,  detail: "RSI=" + rsi.toFixed(1) + " vs ≥" + RSI_PE },
  ];
  var _ceAuditChecks = BREAKOUT ? _upAuditChecks : _dnAuditChecks;
  var _peAuditChecks = BREAKOUT ? _dnAuditChecks : _upAuditChecks;
  function _auditSide(checks) {
    var passed = [], failed = [];
    for (var i = 0; i < checks.length; i++) {
      if (checks[i].ok) passed.push(checks[i].name);
      else              failed.push({ name: checks[i].name, detail: checks[i].detail });
    }
    return { passed: passed.length, total: checks.length, passedNames: passed, failed: failed };
  }
  base.filterAudit = { ce: _auditSide(_ceAuditChecks), pe: _auditSide(_peAuditChecks) };

  // Shared tail for both sides: RSI-turning, divergence, stop distance, then emit.
  //   side      — the option side being bought
  //   stretchUp — which band was breached (true = closed above the upper band). Kept
  //               separate from `side` because the two are only coupled in fade mode.
  function _emit(side, stretchUp) {
    var isCE = side === "CE";

    if (RSI_TURNING) {
      var turned = isCE ? (rsi > rsiPrev) : (rsi < rsiPrev);
      if (!turned) {
        base.reason = side + " blocked: RSI has not turned yet (" + rsiPrev.toFixed(1) + " → " + rsi.toFixed(1) + ")";
        return base;
      }
    }

    var div = null;
    if (DIV_ENABLED) {
      // Measured against the STRETCH, not the side: divergence is a statement about the
      // extreme just printed (a lower low the RSI did not confirm), which is the same
      // question whichever way that extreme is then traded. In fade mode the two are
      // the same value, so this is behaviour-identical there.
      div = _findDivergence(candles, rsiArr, rsiOffset, stretchUp ? "PE" : "CE", DIV_LOOKBACK, DIV_PIVOT_BARS);
      if (!div) {
        base.reason = side + " blocked: no confirmed pivot within " + DIV_LOOKBACK + " bars to measure divergence against";
        return base;
      }
      if (!div.ok) {
        base.reason = side + " blocked: no divergence (price " + div.nowPrice + " vs " + div.pivotPrice
                    + ", RSI " + div.nowRsi + " vs " + div.pivotRsi + ")";
        return base;
      }
      base.divergence = div;
    }

    // Signal candle's own extreme — the width cap reads it; returned as metadata only.
    var slLine = isCE ? sc.low : sc.high;
    var slPts  = parseFloat(Math.abs(sc.close - slLine).toFixed(2));
    if (MAX_ENTRY_SL_PTS > 0 && slPts > MAX_ENTRY_SL_PTS) {
      base.reason = side + " blocked: signal candle too wide (" + slPts.toFixed(0) + "pts > " + MAX_ENTRY_SL_PTS + ")";
      return base;
    }

    var band  = stretchUp ? bb.upper : bb.lower;
    var _tag  = stretchUp ? "above BB upper(" + band.toFixed(0) + ")" : "below BB lower(" + band.toFixed(0) + ")";
    var _divTag = div && div.ok ? " + divergence(" + div.barsBack + " bars)" : "";
    // Middle band as signal metadata (the mean sits behind a breakout entry).
    var _target = BREAKOUT ? null : parseFloat(bb.middle.toFixed(2));
    var _tgtTag = BREAKOUT ? "" : " | BB mid(" + bb.middle.toFixed(0) + ")";
    if (!silent) {
      console.log("[" + P + " " + _ist + "] " + side + (BREAKOUT ? " BREAK" : " FADE") + ": close(" + sc.close + ") " + _tag
        + " + RSI=" + rsi.toFixed(1) + _divTag + _tgtTag + " SL line=" + slLine.toFixed(2) + " [" + slPts.toFixed(1) + "pts]");
    }
    return Object.assign({}, base, {
      signal: isCE ? "BUY_CE" : "BUY_PE",
      signalStrength: "BB_RSI",
      stopLoss: parseFloat(slLine.toFixed(2)),
      slSource: "Signal candle",
      target: _target,
      slPts: slPts,
      reason: side + (BREAKOUT ? " break: " : " fade: ") + _tag + " + RSI=" + rsi.toFixed(0) + _divTag
            + _tgtTag + " | SL line=" + slLine.toFixed(2) + " [" + slPts.toFixed(1) + "pts]",
    });
  }

  if (ceStretch && rsi <= RSI_CE) return _emit(_dnSide, false);
  if (peStretch && rsi >= RSI_PE) return _emit(_upSide, true);

  // No signal — build descriptive reason showing which leg failed
  var parts = [];
  if (ceStretch && !(rsi <= RSI_CE)) parts.push(_dnSide + " stretched below band but RSI=" + rsi.toFixed(0) + ">" + RSI_CE);
  if (peStretch && !(rsi >= RSI_PE)) parts.push(_upSide + " stretched above band but RSI=" + rsi.toFixed(0) + "<" + RSI_PE);

  base.reason = parts.length > 0 ? "No setup (" + parts.join("; ") + ")" : "No setup";
  return base;
}

// ── Signal strength (drives BB_RSI_VIX_STRONG_ONLY) ─────────────────────────
// STRONG when RSI is clearly PAST its threshold by 5 — deeper into the extreme. Which
// threshold that is depends on the direction: a fade CE comes off an OVERSOLD stretch,
// a breakout CE off an OVERBOUGHT one, so the two modes read opposite ends of the scale
// for the same side. Shared by paper/live/backtest so the three cannot drift apart.
function signalStrength(result, prefix) {
  var P = _P(prefix);
  var rsi = result && typeof result.rsi === "number" ? result.rsi : null;
  if (rsi === null) return "MARGINAL";
  var oversold   = rsi <= num(P + "_RSI_CE_THRESHOLD", "25") - 5;
  var overbought = rsi >= num(P + "_RSI_PE_THRESHOLD", "75") + 5;
  var brk = isBreakout(P);
  if (result.signal === "BUY_CE") return (brk ? overbought : oversold)   ? "STRONG" : "MARGINAL";
  if (result.signal === "BUY_PE") return (brk ? oversold   : overbought) ? "STRONG" : "MARGINAL";
  return "MARGINAL";
}

function reset(prefix) { _indicatorCaches[_P(prefix)] = _emptyCache(); }

/**
 * The same engine API bound to another env prefix — every strategy-own key is read
 * as `<prefix>_<NAME>`. forPrefix("FUT_BB_RSI") is the NIFTY FUTURES twin's engine.
 * Only registered prefixes are accepted: a typo must fail loudly at require time,
 * not silently trade on defaults because no `<typo>_*` key exists.
 */
function forPrefix(prefix) {
  if (!Object.prototype.hasOwnProperty.call(PREFIXES, prefix)) {
    throw new Error(`bb_rsi.forPrefix: unknown prefix "${prefix}" (known: ${Object.keys(PREFIXES).join(", ")})`);
  }
  return {
    NAME, DESCRIPTION,
    PREFIX:         prefix,
    UNDERLYING:     PREFIXES[prefix],
    getSignal:      function (candles, opts) { return getSignal(candles, Object.assign({}, opts, { prefix: prefix })); },
    signalStrength: function (result) { return signalStrength(result, prefix); },
    resolutionMin:  function () { return resolutionMin(prefix); },
    direction:      function () { return direction(prefix); },
    reset:          function () { reset(prefix); },
  };
}

module.exports = {
  NAME, DESCRIPTION, getSignal, signalStrength, resolutionMin, direction,
  reset,
  DEFAULT_PREFIX, PREFIXES, forPrefix,
};

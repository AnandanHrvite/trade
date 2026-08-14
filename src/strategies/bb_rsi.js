/**
 * BB_RSI V8: Bollinger Band MEAN REVERSION + RSI extreme (2-opposite-candle exits)
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
 *   Entry stop line = the signal candle's own extreme (CE → its low, PE → its high). It
 *   is recorded and displayed for sizing; it is NOT an intra-tick stop (the exits below
 *   are). BB_RSI_MAX_ENTRY_SL_PTS skips entries whose signal candle is wider than N pts
 *   from close, so one huge bar cannot open a position with uncapped risk.
 *
 * EXIT:
 *   1. Middle-band target (BB_RSI_TARGET_MIDDLE_BAND, default on) — the mean IS the
 *      objective of a mean-reversion trade. Per-tick; exits at the middle band line.
 *   2. Two-opposite-candle stop (BB_RSI_OPP_CANDLE_SL_ENABLED, default on) — on candle
 *      close, exit after BB_RSI_OPP_CANDLE_SL_COUNT consecutive candles closing against
 *      the position (CE: red bodies, PE: green). The initial stop.
 *   3. Two-opposite-candle trail (BB_RSI_OPP_CANDLE_TRAIL_ENABLED, default on) — the
 *      same rule with its own count, taking over once the trade has run
 *      BB_RSI_TRAIL_ARM_PTS in favour. Independently toggleable: turning the trail off
 *      leaves the initial stop live for the whole trade, and vice versa.
 *   4. Hard stop (BB_RSI_STOP_LOSS_PTS) and profit lock (BB_RSI_PROFIT_LOCK_*) remain
 *      as optional per-tick caps. Both default to the target/candle rules doing the
 *      work — set to 0 to disable.
 *   5. EOD / daily loss / max trades / SL-pause cooldown (handled by routes)
 */

const { BollingerBands, RSI, ADX } = require("technicalindicators");

const NAME        = "BB_RSI_MEAN_REVERSION_V8";
const DESCRIPTION = "BB fade + RSI extreme";

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }
function cfgOn(key, fb) { return String(cfg(key, fb)).toLowerCase() === "true"; }

// ── Trading window ───────────────────────────────────────────────────────────
function _parseMins(envKey, fallback) {
  var v = process.env[envKey] || fallback;
  var parts = v.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}
function _fmtTime(mins) {
  var h = Math.floor(mins / 60), m = mins % 60;
  var suffix = h >= 12 ? "PM" : "AM";
  var h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return h12 + ":" + (m < 10 ? "0" : "") + m + " " + suffix;
}

function isInTradingWindow(unixSec) {
  var d = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  var startMin = _parseMins("BB_RSI_ENTRY_START", "09:21");
  var endMin   = _parseMins("BB_RSI_ENTRY_END",   "14:30");
  if (totalMin < startMin) return { ok: false, reason: "Before " + _fmtTime(startMin) };
  if (totalMin >= endMin)  return { ok: false, reason: "After " + _fmtTime(endMin) };
  return { ok: true, reason: null };
}

// ── Indicator cache — avoid redundant recalculation on every tick ────────────
// Cache key = last closed candle time + current candle OHLC (changes on each tick)
// If the closed candles haven't changed AND current bar is same, reuse cached indicators.
let _indicatorCache = { key: null, bb: null, rsiArr: null, adx: null };

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

  var BB_PERIOD   = parseInt(cfg("BB_RSI_BB_PERIOD", "30"), 10);
  var BB_STDDEV   = parseFloat(cfg("BB_RSI_BB_STDDEV", "2"));
  var RSI_PERIOD  = parseInt(cfg("BB_RSI_RSI_PERIOD", "14"), 10);
  var RSI_CE      = parseFloat(cfg("BB_RSI_RSI_CE_THRESHOLD", "25")); // CE needs RSI AT OR BELOW this
  var RSI_PE      = parseFloat(cfg("BB_RSI_RSI_PE_THRESHOLD", "75")); // PE needs RSI AT OR ABOVE this
  var RSI_TURNING = cfgOn("BB_RSI_RSI_TURNING", "false");             // require RSI to have already turned back
  var MAX_ENTRY_SL_PTS = parseFloat(cfg("BB_RSI_MAX_ENTRY_SL_PTS", "50")); // signal-candle extreme distance cap (0 = off)
  var ADX_ENABLED = cfgOn("BB_RSI_ADX_ENABLED", "false");
  var ADX_MAX     = parseFloat(cfg("BB_RSI_ADX_MAX", "30"));          // block when the trend is too strong to fade

  var BW_ENABLED  = cfgOn("BB_RSI_BAND_WIDTH_ENABLED", "true");
  var BW_MIN      = parseFloat(cfg("BB_RSI_MIN_BAND_WIDTH_PTS", "50"));
  var RR_ENABLED  = cfgOn("BB_RSI_RSI_RANGE_ENABLED", "true");
  var RR_LOOKBACK = parseInt(cfg("BB_RSI_RSI_RANGE_LOOKBACK", "20"), 10);
  var RR_MIN      = parseFloat(cfg("BB_RSI_RSI_RANGE_MIN", "30"));
  var DIV_ENABLED = cfgOn("BB_RSI_DIVERGENCE_ENABLED", "false");
  var DIV_LOOKBACK  = parseInt(cfg("BB_RSI_DIV_LOOKBACK", "20"), 10);
  var DIV_PIVOT_BARS = parseInt(cfg("BB_RSI_DIV_PIVOT_BARS", "2"), 10);

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
    var windowCheck = isInTradingWindow(sc.time);
    if (!windowCheck.ok) {
      base.reason = windowCheck.reason;
      return base;
    }
  }

  // ── Indicators (with cache to avoid redundant recalculation) ──────────────
  var cacheKey = _makeIndicatorKey(candles);
  var bb, rsiArr, adx;

  if (cacheKey && _indicatorCache.key === cacheKey && _indicatorCache.bb) {
    bb     = _indicatorCache.bb;
    rsiArr = _indicatorCache.rsiArr;
    adx    = _indicatorCache.adx;
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
    _indicatorCache = { key: cacheKey, bb: bb, rsiArr: rsiArr, adx: adx };
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

  var _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

  // ── Chop guard 1: band width ──────────────────────────────────────────────
  // A band collapsed to noise width has no "stretch" to fade — every touch is just the
  // tape breathing, and each fade pays the spread for nothing.
  var bandWidth = bb.upper - bb.lower;
  base.bandWidthOk = !(BW_ENABLED && BW_MIN > 0 && bandWidth < BW_MIN);
  if (!base.bandWidthOk) {
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

  // ── ENTRY CONDITIONS (V8: mean reversion) ─────────────────────────────────
  //   CE = fade a drop: price stretched BELOW the lower band with RSI oversold.
  //   PE = fade a rip:  price stretched ABOVE the upper band with RSI overbought.
  var ceStretch = sc.close <= bb.lower;
  var peStretch = sc.close >= bb.upper;

  // ── Near-miss filter audit (additive-only logging; does NOT affect signal) ──
  var _ceAuditChecks = [
    { name: "below BB lower", ok: ceStretch,      detail: "close=" + sc.close + " vs BB_L=" + bb.lower.toFixed(1) },
    { name: "RSI oversold",   ok: rsi <= RSI_CE,  detail: "RSI=" + rsi.toFixed(1) + " vs ≤" + RSI_CE },
  ];
  var _peAuditChecks = [
    { name: "above BB upper", ok: peStretch,      detail: "close=" + sc.close + " vs BB_U=" + bb.upper.toFixed(1) },
    { name: "RSI overbought", ok: rsi >= RSI_PE,  detail: "RSI=" + rsi.toFixed(1) + " vs ≥" + RSI_PE },
  ];
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
  function _emit(side) {
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
      div = _findDivergence(candles, rsiArr, rsiOffset, side, DIV_LOOKBACK, DIV_PIVOT_BARS);
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

    // Stop line = the signal candle's own extreme. Recorded/displayed for sizing; the
    // live stop is the two-opposite-candle rule.
    var slLine = isCE ? sc.low : sc.high;
    var slPts  = parseFloat(Math.abs(sc.close - slLine).toFixed(2));
    if (MAX_ENTRY_SL_PTS > 0 && slPts > MAX_ENTRY_SL_PTS) {
      base.reason = side + " blocked: signal candle too wide (" + slPts.toFixed(0) + "pts > " + MAX_ENTRY_SL_PTS + ")";
      return base;
    }

    var band  = isCE ? bb.lower : bb.upper;
    var _tag  = isCE ? "below BB lower(" + band.toFixed(0) + ")" : "above BB upper(" + band.toFixed(0) + ")";
    var _divTag = div && div.ok ? " + divergence(" + div.barsBack + " bars)" : "";
    if (!silent) {
      console.log("[BB_RSI " + _ist + "] " + side + " FADE: close(" + sc.close + ") " + _tag
        + " + RSI=" + rsi.toFixed(1) + _divTag + " | target=BB mid(" + bb.middle.toFixed(1) + ") SL line=" + slLine.toFixed(2) + " [" + slPts.toFixed(1) + "pts]");
    }
    return Object.assign({}, base, {
      signal: isCE ? "BUY_CE" : "BUY_PE",
      signalStrength: "BB_RSI",
      stopLoss: parseFloat(slLine.toFixed(2)),
      slSource: "Signal candle",
      target: parseFloat(bb.middle.toFixed(2)),
      slPts: slPts,
      reason: side + " fade: " + _tag + " + RSI=" + rsi.toFixed(0) + _divTag
            + " | target BB mid(" + bb.middle.toFixed(0) + ") | SL line=" + slLine.toFixed(2) + " [" + slPts.toFixed(1) + "pts]",
    });
  }

  if (ceStretch && rsi <= RSI_CE) return _emit("CE");
  if (peStretch && rsi >= RSI_PE) return _emit("PE");

  // No signal — build descriptive reason showing which leg failed
  var parts = [];
  if (ceStretch && !(rsi <= RSI_CE)) parts.push("CE stretched below band but RSI=" + rsi.toFixed(0) + ">" + RSI_CE);
  if (peStretch && !(rsi >= RSI_PE)) parts.push("PE stretched above band but RSI=" + rsi.toFixed(0) + "<" + RSI_PE);

  base.reason = parts.length > 0 ? "No setup (" + parts.join("; ") + ")" : "No setup";
  return base;
}

// ── Signal strength (drives BB_RSI_VIX_STRONG_ONLY) ─────────────────────────
// STRONG when RSI is clearly PAST its threshold by 5 — i.e. deeper into the extreme
// being faded. Inverted vs V7, where "past the threshold" meant further with the trend.
// Shared by paper/live/backtest so the three cannot drift apart.
function signalStrength(result) {
  var rsi = result && typeof result.rsi === "number" ? result.rsi : null;
  if (rsi === null) return "MARGINAL";
  if (result.signal === "BUY_CE") {
    var ce = parseFloat(cfg("BB_RSI_RSI_CE_THRESHOLD", "25"));
    return rsi <= ce - 5 ? "STRONG" : "MARGINAL";
  }
  if (result.signal === "BUY_PE") {
    var pe = parseFloat(cfg("BB_RSI_RSI_PE_THRESHOLD", "75"));
    return rsi >= pe + 5 ? "STRONG" : "MARGINAL";
  }
  return "MARGINAL";
}

// ── Profit lock (optional per-tick upside cap) ───────────────────────────────
// Spot-POINTS ratcheting profit lock. Tracks the favourable spot move since entry
// (CE = price−entry, PE = entry−price). Once the PEAK favourable move reaches
// BB_RSI_PROFIT_LOCK_TRIGGER_PTS, exit as soon as it gives back below
// BB_RSI_PROFIT_LOCK_PCT% of that peak. Defaults to 0 = OFF in V8: the middle-band
// target and the two-candle trail are the intended upside exits, and a lock firing
// before the mean is reached would cut the trade short of its whole objective.
// Returns { hit, floor }.
function profitLock(favPts, peakFavPts) {
  var trigger = parseFloat(cfg("BB_RSI_PROFIT_LOCK_TRIGGER_PTS", "0"));
  var pct     = parseFloat(cfg("BB_RSI_PROFIT_LOCK_PCT", "50"));
  if (trigger <= 0 || peakFavPts == null || peakFavPts < trigger) return { hit: false, floor: null };
  var floor = parseFloat(((pct / 100) * peakFavPts).toFixed(2));
  return { hit: favPts <= floor, floor: floor };
}

// ── Hard stop (catastrophic loss cap, per-tick, spot POINTS) ─────────────────
// Backstop under the two-opposite-candle stop, which can only fire on a candle close:
// a single violent bar against a fade can travel a long way before that close arrives.
// Exit once the trade has moved BB_RSI_STOP_LOSS_PTS against entry. 0 disables.
//   favPts — current favourable spot points (CE = price−entry, PE = entry−price)
// Returns { hit, stop }.
function hardStop(favPts) {
  var stop = parseFloat(cfg("BB_RSI_STOP_LOSS_PTS", "30"));
  if (stop <= 0 || favPts == null) return { hit: false, stop: null };
  return { hit: favPts <= -stop, stop: stop };
}

// ── Middle-band target (the objective of the fade) ───────────────────────────
// The mean is what price is reverting TO, so reaching it completes the trade. Checked
// per-tick against the band from COMPLETED candles (fixed during the forming bar), so
// paper/live/backtest all measure the same line.
//   middle — bb.middle from the caller's cached bbLevels()
//   price  — current spot
// Returns { hit, level }.
function middleBandTarget(middle, side, price) {
  if (!cfgOn("BB_RSI_TARGET_MIDDLE_BAND", "true")) return { hit: false, level: null };
  if (middle == null || price == null) return { hit: false, level: null };
  // CE entered BELOW the lower band → reverting up to the middle. PE entered above → down.
  var hit = side === "CE" ? price >= middle : price <= middle;
  return { hit: hit, level: parseFloat(middle.toFixed(2)) };
}

// ── Opposite-candle counting ─────────────────────────────────────────────────
// "Opposite" = the candle BODY closed against the position: CE is hurt by a red body
// (close < open), PE by a green one (close > open). A doji (close === open) is not
// opposite and breaks the streak — it is indecision, not a move against the trade.
// Counts backwards from the last CLOSED candle.
function countOppositeCandles(candles, side) {
  var n = 0;
  for (var i = candles.length - 1; i >= 0; i--) {
    var c = candles[i];
    var against = side === "CE" ? (c.close < c.open) : (c.close > c.open);
    if (!against) break;
    n++;
  }
  return n;
}

// ── Two-opposite-candle stop / trail (candle close) ──────────────────────────
// One rule, two independently-toggleable phases:
//   • before the trade has run BB_RSI_TRAIL_ARM_PTS in favour → the initial STOP
//     (BB_RSI_OPP_CANDLE_SL_ENABLED / _COUNT)
//   • after it has → the TRAIL (BB_RSI_OPP_CANDLE_TRAIL_ENABLED / _COUNT)
// Turning the trail off leaves the initial stop live for the whole trade; turning the
// stop off leaves the position unprotected until the trail arms (the hard stop still
// applies either way). The reason string for the stop contains "SL" because that is
// what arms the per-side cooldown in every route; the trail's deliberately does not —
// a trail exit banks a profit and must not pause the side.
//   mfeSpotPts — best favourable spot points seen this trade
// Returns { hit, reason, count, need, armed }.
function oppositeCandleExit(candles, side, mfeSpotPts) {
  var slOn    = cfgOn("BB_RSI_OPP_CANDLE_SL_ENABLED", "true");
  var slCount = parseInt(cfg("BB_RSI_OPP_CANDLE_SL_COUNT", "2"), 10) || 2;
  var trOn    = cfgOn("BB_RSI_OPP_CANDLE_TRAIL_ENABLED", "true");
  var trCount = parseInt(cfg("BB_RSI_OPP_CANDLE_TRAIL_COUNT", "2"), 10) || 2;
  var armPts  = parseFloat(cfg("BB_RSI_TRAIL_ARM_PTS", "10"));

  var armed = trOn && (mfeSpotPts || 0) >= armPts;
  var count = countOppositeCandles(candles, side);

  if (armed) {
    if (count >= trCount) {
      return { hit: true, reason: "Trail (" + trCount + " opposite candles)", count: count, need: trCount, armed: true };
    }
    return { hit: false, reason: null, count: count, need: trCount, armed: true };
  }
  if (slOn && count >= slCount) {
    return { hit: true, reason: "SL (" + slCount + " opposite candles)", count: count, need: slCount, armed: false };
  }
  return { hit: false, reason: null, count: count, need: slCount, armed: false };
}

// Latest BB upper/middle/lower from the supplied (completed) candles, same inputs the
// entry uses. Exposed so the routes can run the middle-band target intra-candle
// (per-tick spot vs the mean) instead of only on candle close. null if insufficient data.
function bbLevels(candles) {
  var BB_PERIOD = parseInt(cfg("BB_RSI_BB_PERIOD", "30"), 10);
  var BB_STDDEV = parseFloat(cfg("BB_RSI_BB_STDDEV", "2"));
  var closes = candles.map(function(c) { return c.close; });
  var bbArr = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes });
  if (bbArr.length < 1) return null;
  return bbArr[bbArr.length - 1];
}

function reset() { _indicatorCache = { key: null, bb: null, rsiArr: null, adx: null }; }

module.exports = {
  NAME, DESCRIPTION, getSignal, signalStrength,
  profitLock, hardStop, middleBandTarget, countOppositeCandles, oppositeCandleExit,
  bbLevels, reset,
};

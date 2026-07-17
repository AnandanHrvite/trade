/**
 * STRATEGY: PRICE ACTION (5-min candles)
 *
 * Pure chart-pattern breakout strategy — no RSI/ADX confluence, no lagging
 * indicators. The pattern breakout candle IS the signal (as per the charts).
 *
 * PATTERNS DETECTED (the only four entry logics):
 *   1. Double Bottom (W) — two equal swing lows + neckline breakout → CE
 *   2. Double Top (M)    — two equal swing highs + neckline breakdown → PE
 *   3. Ascending Triangle  — flat resistance + rising lows, breakout → CE
 *   4. Descending Triangle — flat support + falling highs, breakdown → PE
 *
 * SUPPORT/RESISTANCE:
 *   Dynamic S/R from recent swing highs/lows (lookback 30 candles).
 *   Pattern detection works off the last two swing highs/lows within the
 *   lookback (PA_CHART_PATTERN_TOL tolerance for "equal" levels).
 *
 * ENTRY GATE:
 *   Min body: the breakout candle body must be >= PA_MIN_BODY points. That's
 *   the only confluence filter — no RSI, no ADX.
 *
 * EXIT (as per the chart-pattern playbook):
 *   Hard SL: placed purely at the pattern structure (no min/max clamp) — just
 *     below the twin bottoms / rising-low support (CE), just above the twin tops
 *     / falling-high resistance (PE). A small internal buffer sits beyond it.
 *   Breakeven: once peak profit >= PA_BREAKEVEN_TRIGGER (₹), the SL is lifted to
 *     entry +/- PA_BREAKEVEN_BUFFER so a winner can't round-trip to a loss.
 *   Trail: swing-structure tightening (only tighten) from there.
 *   (Breakeven + trail are applied by the route engines, not getSignal.)
 *
 * Timeframe: 5-min | Window: PA_ENTRY_START – PA_ENTRY_END IST
 */

const { EMA } = require("technicalindicators"); // repo convention — don't hand-roll indicators

const NAME        = "PRICE_ACTION_5M";
const DESCRIPTION = "5-min | Double Top/Bottom (M/W) + Ascending/Descending Triangle breakouts | pure chart patterns";

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }

// ── Trend bias (course rule #1: trade breakouts WITH the trend) ───────────────
// A simple EMA-vs-close read on the trading timeframe. The course teaches that
// in an uptrend price holds above the 20-period MA (and below it in a downtrend);
// we use that as the regime gate for the *continuation* patterns (triangles).
// Returns "UP" | "DOWN" | "FLAT" plus the EMA value (null until warmed up).
function _trendBias(candles, period, flatBand) {
  if (candles.length < period + 1) return { bias: "FLAT", ema: null };
  var closes = candles.map(function (c) { return c.close; });
  var arr = EMA.calculate({ period: period, values: closes });
  if (!arr.length) return { bias: "FLAT", ema: null };
  var ema   = arr[arr.length - 1];
  var close = closes[closes.length - 1];
  if (close > ema + flatBand) return { bias: "UP",   ema: ema };
  if (close < ema - flatBand) return { bias: "DOWN", ema: ema };
  return { bias: "FLAT", ema: ema };
}

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
  var startMin = _parseMins("PA_ENTRY_START", "09:20");
  var endMin   = _parseMins("PA_ENTRY_END",   "14:30");
  if (totalMin < startMin) return { ok: false, reason: "Before " + _fmtTime(startMin) };
  if (totalMin >= endMin)  return { ok: false, reason: "After " + _fmtTime(endMin) };
  return { ok: true, reason: null };
}

// ── Swing high/low detection ─────────────────────────────────────────────────
// A swing high: candle[i].high > candle[i-1].high AND candle[i].high > candle[i+1].high
// A swing low:  candle[i].low  < candle[i-1].low  AND candle[i].low  < candle[i+1].low
function findSwingPoints(candles, lookback) {
  var swingHighs = [];
  var swingLows  = [];
  var start = Math.max(1, candles.length - lookback);
  for (var i = start; i < candles.length - 1; i++) {
    var prev = candles[i - 1];
    var curr = candles[i];
    var next = candles[i + 1];
    if (curr.high > prev.high && curr.high > next.high) {
      swingHighs.push({ price: curr.high, index: i, time: curr.time });
    }
    if (curr.low < prev.low && curr.low < next.low) {
      swingLows.push({ price: curr.low, index: i, time: curr.time });
    }
  }
  return { swingHighs, swingLows };
}

// ── Pattern detection ────────────────────────────────────────────────────────

function candleBody(c) { return Math.abs(c.close - c.open); }

/**
 * Double Top: Two swing highs at similar price, current candle breaks below the neckline (valley between them)
 * Double Bottom: Two swing lows at similar price, current candle breaks above the neckline (peak between them)
 * Requires at least 2 swing points and the valley/peak between them.
 */
function checkDoubleTop(candle, swingHighs, candles, tolerancePts) {
  if (swingHighs.length < 2) return { detected: false };
  // Check last two swing highs
  var sh1 = swingHighs[swingHighs.length - 2];
  var sh2 = swingHighs[swingHighs.length - 1];
  // Two highs must be at similar levels
  if (Math.abs(sh1.price - sh2.price) > tolerancePts) return { detected: false };
  // Must have some separation (at least 5 candles apart)
  if (sh2.index - sh1.index < 5) return { detected: false };
  // Find the neckline: lowest low between the two swing highs
  var neckline = Infinity;
  for (var i = sh1.index; i <= sh2.index; i++) {
    if (i < candles.length && candles[i].low < neckline) neckline = candles[i].low;
  }
  if (neckline === Infinity) return { detected: false };
  // Current candle must break below neckline (close below, open was above or near)
  var topLevel = (sh1.price + sh2.price) / 2;
  if (candle.close < neckline && candle.open >= neckline) {
    return { detected: true, neckline: neckline, topLevel: topLevel,
      points: [ { time: sh1.time, price: sh1.price, label: "Top 1" },
                { time: sh2.time, price: sh2.price, label: "Top 2" } ] };
  }
  return { detected: false };
}

function checkDoubleBottom(candle, swingLows, candles, tolerancePts) {
  if (swingLows.length < 2) return { detected: false };
  var sl1 = swingLows[swingLows.length - 2];
  var sl2 = swingLows[swingLows.length - 1];
  if (Math.abs(sl1.price - sl2.price) > tolerancePts) return { detected: false };
  if (sl2.index - sl1.index < 5) return { detected: false };
  // Find the neckline: highest high between the two swing lows
  var neckline = -Infinity;
  for (var i = sl1.index; i <= sl2.index; i++) {
    if (i < candles.length && candles[i].high > neckline) neckline = candles[i].high;
  }
  if (neckline === -Infinity) return { detected: false };
  var bottomLevel = (sl1.price + sl2.price) / 2;
  if (candle.close > neckline && candle.open <= neckline) {
    return { detected: true, neckline: neckline, bottomLevel: bottomLevel,
      points: [ { time: sl1.time, price: sl1.price, label: "Bottom 1" },
                { time: sl2.time, price: sl2.price, label: "Bottom 2" } ] };
  }
  return { detected: false };
}

/**
 * Ascending Triangle: Flat resistance (swing highs at similar levels) + rising swing lows
 * Descending Triangle: Flat support (swing lows at similar levels) + falling swing highs
 * Need at least 2 swing highs and 2 swing lows to confirm the pattern.
 */
function checkAscendingTriangle(candle, swingHighs, swingLows, tolerancePts) {
  if (swingHighs.length < 2 || swingLows.length < 2) return { detected: false };
  var sh1 = swingHighs[swingHighs.length - 2];
  var sh2 = swingHighs[swingHighs.length - 1];
  var sl1 = swingLows[swingLows.length - 2];
  var sl2 = swingLows[swingLows.length - 1];
  // Flat resistance: swing highs at similar levels
  if (Math.abs(sh1.price - sh2.price) > tolerancePts) return { detected: false };
  // Rising lows: second swing low must be higher than first
  if (sl2.price <= sl1.price) return { detected: false };
  var resistanceLevel = (sh1.price + sh2.price) / 2;
  // Breakout: current candle closes above resistance
  if (candle.close > resistanceLevel && candle.open <= resistanceLevel) {
    return { detected: true, resistance: resistanceLevel, risingLow: sl2.price,
      points: [ { time: sh1.time, price: sh1.price, label: "R1" },
                { time: sh2.time, price: sh2.price, label: "R2" },
                { time: sl1.time, price: sl1.price, label: "Low 1" },
                { time: sl2.time, price: sl2.price, label: "Low 2" } ] };
  }
  return { detected: false };
}

function checkDescendingTriangle(candle, swingHighs, swingLows, tolerancePts) {
  if (swingHighs.length < 2 || swingLows.length < 2) return { detected: false };
  var sh1 = swingHighs[swingHighs.length - 2];
  var sh2 = swingHighs[swingHighs.length - 1];
  var sl1 = swingLows[swingLows.length - 2];
  var sl2 = swingLows[swingLows.length - 1];
  // Flat support: swing lows at similar levels
  if (Math.abs(sl1.price - sl2.price) > tolerancePts) return { detected: false };
  // Falling highs: second swing high must be lower than first
  if (sh2.price >= sh1.price) return { detected: false };
  var supportLevel = (sl1.price + sl2.price) / 2;
  // Breakout: current candle closes below support
  if (candle.close < supportLevel && candle.open >= supportLevel) {
    return { detected: true, support: supportLevel, fallingHigh: sh2.price,
      points: [ { time: sl1.time, price: sl1.price, label: "S1" },
                { time: sl2.time, price: sl2.price, label: "S2" },
                { time: sh1.time, price: sh1.price, label: "High 1" },
                { time: sh2.time, price: sh2.price, label: "High 2" } ] };
  }
  return { detected: false };
}

// ── Pending breakout (retest watch) — module state across candles ─────────────
let _pendingBreakout = null; // { side, pattern, structLevel, level, points, slSource, barsWaited }

// Structural SL placement, clamped to [minPts, maxPts] distance from entry.
function _clampedSL(side, structLevel, entryClose, buffer, minPts, maxPts) {
  if (side === "CE") {
    var raw = structLevel - buffer;                 // just below the pattern
    var gap = Math.max(Math.min(entryClose - raw, maxPts), minPts);
    return parseFloat((entryClose - gap).toFixed(2));
  }
  var rawP = structLevel + buffer;                  // just above the pattern
  var gapP = Math.max(Math.min(rawP - entryClose, maxPts), minPts);
  return parseFloat((entryClose + gapP).toFixed(2));
}

// ── Main signal function ─────────────────────────────────────────────────────
function getSignal(candles, opts) {
  opts = opts || {};
  var silent = opts.silent === true;
  var preview = opts.preview === true; // read-only call (UI/status) — must not mutate pending state

  // All of these are computed/derived internally — not exposed as Settings knobs.
  var MIN_BODY      = parseFloat(cfg("PA_MIN_BODY", "5"));
  var SR_LOOKBACK   = parseInt(cfg("PA_SR_LOOKBACK", "30"), 10);
  var SL_BUFFER     = parseFloat(cfg("PA_SL_BUFFER_PTS", "3")); // cushion beyond the pattern level
  var MIN_SL_PTS    = parseFloat(cfg("PA_MIN_SL_PTS", "8"));    // floor on SL distance
  var MAX_SL_PTS    = parseFloat(cfg("PA_MAX_SL_PTS", "25"));   // cap on structural SL distance
  var CHART_PATTERN_TOL = parseFloat(cfg("PA_CHART_PATTERN_TOL", "12")); // tolerance for "equal" levels
  var RETEST_ENABLED   = cfg("PA_RETEST_ENABLED", "true") === "true"; // wait for breakout retest before entry
  var RETEST_TOL       = parseFloat(cfg("PA_RETEST_TOL_PTS", "10"));   // how close price must return to the broken level
  var RETEST_MAX_WAIT  = parseInt(cfg("PA_RETEST_MAX_WAIT", "4"), 10); // candles to wait for the retest
  // Per-pattern toggles (the only four entry logics)
  var PATTERN_DOUBLE_TOP    = cfg("PA_PATTERN_DOUBLE_TOP",    "true") === "true";
  var PATTERN_DOUBLE_BOTTOM = cfg("PA_PATTERN_DOUBLE_BOTTOM", "true") === "true";
  var PATTERN_ASC_TRIANGLE  = cfg("PA_PATTERN_ASC_TRIANGLE",  "true") === "true";
  var PATTERN_DESC_TRIANGLE = cfg("PA_PATTERN_DESC_TRIANGLE", "true") === "true";
  // Trend filter (default OFF — ships dark, replay-validate before enabling).
  // Continuation patterns (triangles) must align with the EMA trend bias;
  // reversal patterns (double top/bottom) must sit at a genuine range extreme.
  var TREND_FILTER  = cfg("PA_TREND_FILTER_ENABLED", "false") === "true";
  var TREND_PERIOD  = parseInt(cfg("PA_TREND_EMA_PERIOD", "20"), 10);
  var TREND_FLAT    = parseFloat(cfg("PA_TREND_FLAT_BAND", "0")); // neutral band (pts) around EMA

  var base = {
    signal: "NONE", reason: "", stopLoss: null, target: null,
    pattern: null, srLevel: null, patternLevel: null, patternPoints: null,
    swingHighs: [], swingLows: [],
    signalStrength: null,
  };

  // Warm-up
  var minCandles = Math.max(SR_LOOKBACK + 5, 30);
  if (candles.length < minCandles) {
    base.reason = "Warming up (" + candles.length + "/" + minCandles + ")";
    return base;
  }

  var sc   = candles[candles.length - 1];

  if (!opts.skipTimeCheck) {
    var windowCheck = isInTradingWindow(sc.time);
    if (!windowCheck.ok) {
      if (_pendingBreakout && !preview) _pendingBreakout = null; // outside window — drop stale pending
      base.reason = windowCheck.reason;
      return base;
    }
  }

  // ── Swing points ───────────────────────────────────────────────────────────
  var swings = findSwingPoints(candles, SR_LOOKBACK);
  base.swingHighs = swings.swingHighs.slice(-3).map(function(s) { return s.price; });
  base.swingLows  = swings.swingLows.slice(-3).map(function(s) { return s.price; });

  // ── Trend bias + range extremes (only used when TREND_FILTER is on) ──────────
  var trend = TREND_FILTER ? _trendBias(candles, TREND_PERIOD, TREND_FLAT) : { bias: null, ema: null };
  base.trendBias = trend.bias;
  base.trendEma  = trend.ema != null ? parseFloat(trend.ema.toFixed(2)) : null;
  // A double top/bottom only counts as a reversal when its twin level is the
  // actual high/low of the recent swing range — not a mid-range wiggle.
  function _isTopExtreme(level) {
    if (!swings.swingHighs.length) return true;
    var maxH = Math.max.apply(null, swings.swingHighs.map(function(s){ return s.price; }));
    return level >= maxH - CHART_PATTERN_TOL;
  }
  function _isBottomExtreme(level) {
    if (!swings.swingLows.length) return true;
    var minL = Math.min.apply(null, swings.swingLows.map(function(s){ return s.price; }));
    return level <= minL + CHART_PATTERN_TOL;
  }
  var _trendSkip = null; // reason a detected breakout was blocked by the filter

  var _ist = "";
  if (!silent) {
    _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  }

  // Build a ready-to-enter signal from captured pattern info (structural SL + cap).
  function _enter(side, pattern, structLevel, level, points, slSource) {
    var sl = _clampedSL(side, structLevel, sc.close, SL_BUFFER, MIN_SL_PTS, MAX_SL_PTS);
    var dir = side === "CE" ? "above" : "below";
    if (!silent) console.log("[PA " + _ist + "] " + side + " " + pattern + " " + dir + " " + level.toFixed(0) + " SL=" + sl);
    return Object.assign({}, base, {
      signal: side === "CE" ? "BUY_CE" : "BUY_PE", signalStrength: "STRONG",
      pattern: pattern, stopLoss: sl, slSource: slSource,
      srLevel: level, patternLevel: level, patternPoints: points || null,
      reason: side + ": " + pattern + " " + dir + " " + level.toFixed(0) + " | SL=" + sl,
    });
  }
  // Snapshot fields for a breakout still waiting on its retest.
  function _pendingSnapshot(pb, note) {
    base.reason = "Breakout @ " + pb.level.toFixed(0) + " — " + note;
    base.pattern = pb.pattern + " (pending retest)";
    base.srLevel = pb.level; base.patternLevel = pb.level; base.patternPoints = pb.points;
    return base;
  }

  // ── RETEST WATCH ────────────────────────────────────────────────────────────
  // A confirmed breakout is parked until price pulls back to the broken level and
  // closes back on the breakout side (a "retest"). Filters breakout-then-instant-
  // reversal false signals. The breakout candle itself never enters.
  if (RETEST_ENABLED && _pendingBreakout) {
    var pb = _pendingBreakout;
    if (preview) return _pendingSnapshot(pb, "awaiting retest");
    pb.barsWaited = (pb.barsWaited || 0) + 1;
    var L = pb.level;
    if (pb.side === "CE" && sc.close < L - RETEST_TOL) { _pendingBreakout = null; base.reason = "Breakout failed — closed back below " + L.toFixed(0); return base; }
    if (pb.side === "PE" && sc.close > L + RETEST_TOL) { _pendingBreakout = null; base.reason = "Breakout failed — closed back above " + L.toFixed(0); return base; }
    var retestCE = pb.side === "CE" && sc.low  <= L + RETEST_TOL && sc.close > L;
    var retestPE = pb.side === "PE" && sc.high >= L - RETEST_TOL && sc.close < L;
    if (retestCE || retestPE) {
      var sigR = _enter(pb.side, pb.pattern, pb.structLevel, pb.level, pb.points, pb.slSource);
      _pendingBreakout = null;
      return sigR;
    }
    if (pb.barsWaited >= RETEST_MAX_WAIT) { _pendingBreakout = null; base.reason = "Retest not seen in " + RETEST_MAX_WAIT + " candles — skipped " + pb.pattern; return base; }
    return _pendingSnapshot(pb, "awaiting retest (" + pb.barsWaited + "/" + RETEST_MAX_WAIT + ")");
  }

  // ── PATTERN DETECTION ───────────────────────────────────────────────────────
  // A fresh breakout either enters immediately (retest off) or is parked for its retest.
  function _onBreakout(side, pattern, structLevel, level, points, slSource) {
    if (!RETEST_ENABLED) return _enter(side, pattern, structLevel, level, points, slSource);
    if (!preview) {
      _pendingBreakout = { side: side, pattern: pattern, structLevel: structLevel, level: level, points: points, slSource: slSource, barsWaited: 0 };
      if (!silent) console.log("[PA " + _ist + "] " + side + " " + pattern + " breakout @ " + level.toFixed(0) + " — awaiting retest");
    }
    return _pendingSnapshot({ pattern: pattern, level: level, points: points }, "awaiting retest (0/" + RETEST_MAX_WAIT + ")");
  }

  var dblTop = { detected: false };
  var dblBot = { detected: false };
  var ascTri = { detected: false };
  var descTri = { detected: false };

  if (PATTERN_DOUBLE_TOP) {
    dblTop = checkDoubleTop(sc, swings.swingHighs, candles, CHART_PATTERN_TOL);
    if (dblTop.detected && candleBody(sc) >= MIN_BODY) {
      if (!TREND_FILTER || _isTopExtreme(dblTop.topLevel))
        return _onBreakout("PE", "Double Top", dblTop.topLevel, dblTop.neckline, dblTop.points, "Above Double Top");
      _trendSkip = "Double Top " + dblTop.topLevel.toFixed(0) + " not at range-high extreme";
    }
  }
  if (PATTERN_DOUBLE_BOTTOM) {
    dblBot = checkDoubleBottom(sc, swings.swingLows, candles, CHART_PATTERN_TOL);
    if (dblBot.detected && candleBody(sc) >= MIN_BODY) {
      if (!TREND_FILTER || _isBottomExtreme(dblBot.bottomLevel))
        return _onBreakout("CE", "Double Bottom", dblBot.bottomLevel, dblBot.neckline, dblBot.points, "Below Double Bottom");
      _trendSkip = "Double Bottom " + dblBot.bottomLevel.toFixed(0) + " not at range-low extreme";
    }
  }
  if (PATTERN_ASC_TRIANGLE) {
    ascTri = checkAscendingTriangle(sc, swings.swingHighs, swings.swingLows, CHART_PATTERN_TOL);
    if (ascTri.detected && candleBody(sc) >= MIN_BODY) {
      if (!TREND_FILTER || trend.bias === "UP")
        return _onBreakout("CE", "Ascending Triangle", ascTri.risingLow, ascTri.resistance, ascTri.points, "Rising Swing Low");
      _trendSkip = "Ascending Triangle CE blocked — trend bias " + trend.bias + " (need UP)";
    }
  }
  if (PATTERN_DESC_TRIANGLE) {
    descTri = checkDescendingTriangle(sc, swings.swingHighs, swings.swingLows, CHART_PATTERN_TOL);
    if (descTri.detected && candleBody(sc) >= MIN_BODY) {
      if (!TREND_FILTER || trend.bias === "DOWN")
        return _onBreakout("PE", "Descending Triangle", descTri.fallingHigh, descTri.support, descTri.points, "Falling Swing High");
      _trendSkip = "Descending Triangle PE blocked — trend bias " + trend.bias + " (need DOWN)";
    }
  }

  // ── No signal — build reason ───────────────────────────────────────────────
  base.reason = _trendSkip ? ("Trend filter: " + _trendSkip) : "No setup";

  // ── Filter audit (additive logging — does not affect entry decisions) ─────
  // Records which filters passed/failed for CE and PE so the structured skip
  // log captures *why* this bar produced no signal. Patterns are checked
  // regardless of toggle state; disabled patterns are tagged "(off)" so we
  // can see opportunity cost in the data window.
  var _auditDblTop     = checkDoubleTop(sc, swings.swingHighs, candles, CHART_PATTERN_TOL);
  var _auditDblBot     = checkDoubleBottom(sc, swings.swingLows, candles, CHART_PATTERN_TOL);
  var _auditAscTri     = checkAscendingTriangle(sc, swings.swingHighs, swings.swingLows, CHART_PATTERN_TOL);
  var _auditDescTri    = checkDescendingTriangle(sc, swings.swingHighs, swings.swingLows, CHART_PATTERN_TOL);

  var _bullFormed = [];
  if (_auditDblBot.detected) _bullFormed.push("DblBot"  + (PATTERN_DOUBLE_BOTTOM ? "" : "(off)"));
  if (_auditAscTri.detected) _bullFormed.push("AscTri"  + (PATTERN_ASC_TRIANGLE  ? "" : "(off)"));
  var _bearFormed = [];
  if (_auditDblTop.detected) _bearFormed.push("DblTop"    + (PATTERN_DOUBLE_TOP    ? "" : "(off)"));
  if (_auditDescTri.detected)_bearFormed.push("DescTri"   + (PATTERN_DESC_TRIANGLE ? "" : "(off)"));

  var _ceAuditChecks = [
    { name: "Bullish pattern", ok: _bullFormed.length > 0,
      detail: _bullFormed.length ? _bullFormed.join(",") : "none formed (DblBot/AscTri)" },
  ];
  var _peAuditChecks = [
    { name: "Bearish pattern", ok: _bearFormed.length > 0,
      detail: _bearFormed.length ? _bearFormed.join(",") : "none formed (DblTop/DescTri)" },
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

  return base;
}

// ── Trailing SL: Swing structure based ───────────────────────────────────────
// For CE: trail SL to the most recent swing low (only tighten)
// For PE: trail SL to the most recent swing high (only tighten)
function updateTrailingSL(candles, currentSL, side, opts) {
  var SR_LOOKBACK = parseInt(cfg("PA_SR_LOOKBACK", "30"), 10);
  var swings = findSwingPoints(candles, SR_LOOKBACK);

  if (side === "CE" && swings.swingLows.length > 0) {
    var lastSwingLow = swings.swingLows[swings.swingLows.length - 1].price;
    var close = candles[candles.length - 1].close;
    // Only tighten (move up), must be below current price
    if (lastSwingLow > currentSL && lastSwingLow < close) {
      return { sl: parseFloat(lastSwingLow.toFixed(2)), source: "Swing Low" };
    }
  }
  if (side === "PE" && swings.swingHighs.length > 0) {
    var lastSwingHigh = swings.swingHighs[swings.swingHighs.length - 1].price;
    var close = candles[candles.length - 1].close;
    // Only tighten (move down), must be above current price
    if (lastSwingHigh < currentSL && lastSwingHigh > close) {
      return { sl: parseFloat(lastSwingHigh.toFixed(2)), source: "Swing High" };
    }
  }

  return { sl: currentSL, source: null };
}

function reset() {
  _pendingBreakout = null; // drop any breakout awaiting its retest
}

module.exports = {
  NAME,
  DESCRIPTION,
  getSignal,
  updateTrailingSL,
  reset,
  // Expose helpers for backtest
  findSwingPoints,
  isInTradingWindow,
};

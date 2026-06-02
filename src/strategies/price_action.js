/**
 * STRATEGY: PRICE ACTION (5-min candles)
 *
 * Chart-pattern breakout/reversal strategy with RSI/ADX confluence filters.
 * No lagging indicators as primary signal — reads what price IS doing.
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
 * ENTRY CONFLUENCE & QUALITY GATES:
 *   RSI(14): CE min/max, PE min/max — blocks entries at exhausted-move extremes
 *   ADX level: blocks entries when market is ranging (PA_ADX_MIN)
 *   Min body: breakout candle body must be >= PA_MIN_BODY points
 *
 * EXIT (as per the chart-pattern playbook):
 *   Hard SL: placed at the pattern structure + PA_SL_BUFFER_PTS — below the
 *     twin bottoms / rising-low support (CE), above the twin tops / falling-high
 *     resistance (PE) — then clamped to [PA_MIN_SL_PTS, PA_MAX_SL_PTS].
 *   Breakeven: once peak profit >= PA_BREAKEVEN_TRIGGER (₹), the SL is lifted to
 *     entry +/- PA_BREAKEVEN_BUFFER so a winner can't round-trip to a loss.
 *   Trail: swing-structure tightening (only tighten) from there.
 *   (Breakeven + trail are applied by the route engines, not getSignal.)
 *
 * Timeframe: 5-min | Window: PA_ENTRY_START – PA_ENTRY_END IST
 */

const { RSI, ADX } = require("technicalindicators");

const NAME        = "PRICE_ACTION_5M";
const DESCRIPTION = "5-min | Double Top/Bottom (M/W) + Ascending/Descending Triangle breakouts | S/R swings | RSI confluence";

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }

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
    return { detected: true, neckline: neckline, topLevel: topLevel };
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
    return { detected: true, neckline: neckline, bottomLevel: bottomLevel };
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
    return { detected: true, resistance: resistanceLevel, risingLow: sl2.price };
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
    return { detected: true, support: supportLevel, fallingHigh: sh2.price };
  }
  return { detected: false };
}

// ── Indicator cache ──────────────────────────────────────────────────────────
let _indicatorCache = { key: null, rsi: null };

function _makeKey(candles) {
  if (candles.length < 2) return null;
  var last = candles[candles.length - 1];
  var prev = candles[candles.length - 2];
  return prev.time + ":" + candles.length + ":" + last.open + ":" + last.high + ":" + last.low + ":" + last.close;
}

// ── Main signal function ─────────────────────────────────────────────────────
function getSignal(candles, opts) {
  opts = opts || {};
  var silent = opts.silent === true;

  var RSI_PERIOD    = parseInt(cfg("PA_RSI_PERIOD", "14"), 10);
  var RSI_CE_MIN    = parseFloat(cfg("PA_RSI_CE_MIN", "45"));
  var RSI_CAPS_ON   = cfg("PA_RSI_CAPS_ENABLED", "false") === "true";
  var RSI_CE_MAX    = RSI_CAPS_ON ? parseFloat(cfg("PA_RSI_CE_MAX", "85")) : 999;
  var RSI_PE_MAX    = parseFloat(cfg("PA_RSI_PE_MAX", "55"));
  var RSI_PE_MIN    = RSI_CAPS_ON ? parseFloat(cfg("PA_RSI_PE_MIN", "15")) : -999;
  var ADX_ENABLED   = cfg("PA_ADX_ENABLED", "false") === "true";
  var ADX_MIN       = parseFloat(cfg("PA_ADX_MIN", "20"));
  var MIN_BODY      = parseFloat(cfg("PA_MIN_BODY", "5"));
  var SR_LOOKBACK   = parseInt(cfg("PA_SR_LOOKBACK", "30"), 10);
  var MAX_SL_PTS    = parseFloat(cfg("PA_MAX_SL_PTS", "25"));
  var MIN_SL_PTS    = parseFloat(cfg("PA_MIN_SL_PTS", "8"));
  var SL_BUFFER     = parseFloat(cfg("PA_SL_BUFFER_PTS", "3")); // pts beyond the pattern level for the structural SL
  var CHART_PATTERN_TOL = parseFloat(cfg("PA_CHART_PATTERN_TOL", "12")); // tolerance for double top/bottom & triangles
  // Per-pattern toggles (the only four entry logics)
  var PATTERN_DOUBLE_TOP    = cfg("PA_PATTERN_DOUBLE_TOP",    "true") === "true";
  var PATTERN_DOUBLE_BOTTOM = cfg("PA_PATTERN_DOUBLE_BOTTOM", "true") === "true";
  var PATTERN_ASC_TRIANGLE  = cfg("PA_PATTERN_ASC_TRIANGLE",  "true") === "true";
  var PATTERN_DESC_TRIANGLE = cfg("PA_PATTERN_DESC_TRIANGLE", "true") === "true";

  var base = {
    signal: "NONE", reason: "", stopLoss: null, target: null,
    rsi: null, pattern: null, srLevel: null,
    swingHighs: [], swingLows: [],
    signalStrength: null,
  };

  // Warm-up
  var minCandles = Math.max(RSI_PERIOD + 5, SR_LOOKBACK + 5, 30);
  if (candles.length < minCandles) {
    base.reason = "Warming up (" + candles.length + "/" + minCandles + ")";
    return base;
  }

  var sc   = candles[candles.length - 1];

  if (!opts.skipTimeCheck) {
    var windowCheck = isInTradingWindow(sc.time);
    if (!windowCheck.ok) {
      base.reason = windowCheck.reason;
      return base;
    }
  }

  // ── RSI (with cache) ──────────────────────────────────────────────────────
  var cacheKey = _makeKey(candles);
  var rsi;

  if (cacheKey && _indicatorCache.key === cacheKey && _indicatorCache.rsi !== null) {
    rsi = _indicatorCache.rsi;
  } else {
    var closes = candles.map(function(c) { return c.close; });
    var rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
    if (rsiArr.length < 1) { base.reason = "RSI warming up"; return base; }
    rsi = rsiArr[rsiArr.length - 1];
    _indicatorCache = { key: cacheKey, rsi: rsi };
  }

  base.rsi = parseFloat(rsi.toFixed(1));

  // ── ADX trend filter ──────────────────────────────────────────────────────
  var adxVal = null;
  var isTrending = true; // default pass if ADX disabled
  if (ADX_ENABLED) {
    var highs  = candles.map(function(c) { return c.high; });
    var lows   = candles.map(function(c) { return c.low; });
    var adxCloses = candles.map(function(c) { return c.close; });
    var adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: adxCloses });
    adxVal = adxArr.length > 0 ? adxArr[adxArr.length - 1].adx : null;
    isTrending = adxVal === null ? true : adxVal >= ADX_MIN;
  }
  base.adx = adxVal !== null ? parseFloat(adxVal.toFixed(1)) : null;
  base.isTrending = isTrending;

  // ── Swing points ───────────────────────────────────────────────────────────
  var swings = findSwingPoints(candles, SR_LOOKBACK);
  base.swingHighs = swings.swingHighs.slice(-3).map(function(s) { return s.price; });
  base.swingLows  = swings.swingLows.slice(-3).map(function(s) { return s.price; });

  var _ist = "";
  if (!silent) {
    _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  }

  // ── ADX chop gate — block all entries when market is ranging ────────────────
  if (ADX_ENABLED && !isTrending) {
    var _adxSkip = "ADX=" + (adxVal !== null ? adxVal.toFixed(1) : "n/a") + " < " + ADX_MIN + " (ranging)";
    base.reason = "No setup (market ranging — " + _adxSkip + ")";
    return base;
  }

  // ── PATTERN 1: DOUBLE TOP (Bearish reversal) ────────────────────────────────
  var dblTop = { detected: false };
  var dblBot = { detected: false };
  var ascTri = { detected: false };
  var descTri = { detected: false };
  if (PATTERN_DOUBLE_TOP) {
  dblTop = checkDoubleTop(sc, swings.swingHighs, candles, CHART_PATTERN_TOL);
  if (dblTop.detected && rsi < RSI_PE_MAX && rsi > RSI_PE_MIN && candleBody(sc) >= MIN_BODY) {
    var rawSL = dblTop.topLevel + SL_BUFFER; // above the twin tops
    var slPts = Math.max(Math.min(rawSL - sc.close, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close + slPts).toFixed(2));
    if (!silent) console.log("[PA " + _ist + "] PE Double Top neckline break " + dblTop.neckline.toFixed(0) + " top=" + dblTop.topLevel.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_PE", signalStrength: "STRONG",
      pattern: "Double Top",
      stopLoss: sl, slSource: "Above Double Top",
      srLevel: dblTop.neckline,
      reason: "PE: Double Top neckline break " + dblTop.neckline.toFixed(0) + " | top=" + dblTop.topLevel.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
    });
  }
  } // end PATTERN_DOUBLE_TOP

  // ── PATTERN 2: DOUBLE BOTTOM (Bullish reversal) ───────────────────────────
  if (PATTERN_DOUBLE_BOTTOM) {
  dblBot = checkDoubleBottom(sc, swings.swingLows, candles, CHART_PATTERN_TOL);
  if (dblBot.detected && rsi > RSI_CE_MIN && rsi < RSI_CE_MAX && candleBody(sc) >= MIN_BODY) {
    var rawSL = dblBot.bottomLevel - SL_BUFFER; // below the twin bottoms
    var slPts = Math.max(Math.min(sc.close - rawSL, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close - slPts).toFixed(2));
    if (!silent) console.log("[PA " + _ist + "] CE Double Bottom neckline break " + dblBot.neckline.toFixed(0) + " bottom=" + dblBot.bottomLevel.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_CE", signalStrength: "STRONG",
      pattern: "Double Bottom",
      stopLoss: sl, slSource: "Below Double Bottom",
      srLevel: dblBot.neckline,
      reason: "CE: Double Bottom neckline break " + dblBot.neckline.toFixed(0) + " | bottom=" + dblBot.bottomLevel.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
    });
  }
  } // end PATTERN_DOUBLE_BOTTOM

  // ── PATTERN 3: ASCENDING TRIANGLE (Bullish breakout) ──────────────────────
  if (PATTERN_ASC_TRIANGLE) {
  ascTri = checkAscendingTriangle(sc, swings.swingHighs, swings.swingLows, CHART_PATTERN_TOL);
  if (ascTri.detected && rsi > RSI_CE_MIN && rsi < RSI_CE_MAX && candleBody(sc) >= MIN_BODY) {
    var rawSL = ascTri.risingLow - SL_BUFFER; // below the rising-low support line
    var slPts = Math.max(Math.min(sc.close - rawSL, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close - slPts).toFixed(2));
    if (!silent) console.log("[PA " + _ist + "] CE Ascending Triangle breakout above " + ascTri.resistance.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_CE", signalStrength: "STRONG",
      pattern: "Ascending Triangle",
      stopLoss: sl, slSource: "Rising Swing Low",
      srLevel: ascTri.resistance,
      reason: "CE: Ascending Triangle breakout above " + ascTri.resistance.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
    });
  }
  } // end PATTERN_ASC_TRIANGLE

  // ── PATTERN 4: DESCENDING TRIANGLE (Bearish breakout) ─────────────────────
  if (PATTERN_DESC_TRIANGLE) {
  descTri = checkDescendingTriangle(sc, swings.swingHighs, swings.swingLows, CHART_PATTERN_TOL);
  if (descTri.detected && rsi < RSI_PE_MAX && rsi > RSI_PE_MIN && candleBody(sc) >= MIN_BODY) {
    var rawSL = descTri.fallingHigh + SL_BUFFER; // above the falling-high resistance line
    var slPts = Math.max(Math.min(rawSL - sc.close, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close + slPts).toFixed(2));
    if (!silent) console.log("[PA " + _ist + "] PE Descending Triangle breakdown below " + descTri.support.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_PE", signalStrength: "STRONG",
      pattern: "Descending Triangle",
      stopLoss: sl, slSource: "Falling Swing High",
      srLevel: descTri.support,
      reason: "PE: Descending Triangle breakdown below " + descTri.support.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
    });
  }
  } // end PATTERN_DESC_TRIANGLE

  // ── No signal — build reason ───────────────────────────────────────────────
  base.reason = "No setup";

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
    { name: "RSI in CE range", ok: rsi > RSI_CE_MIN && rsi < RSI_CE_MAX,
      detail: "RSI=" + rsi.toFixed(1) + " vs " + RSI_CE_MIN + "-" + RSI_CE_MAX },
    { name: "ADX trending", ok: !ADX_ENABLED || isTrending,
      detail: ADX_ENABLED ? ("ADX=" + (adxVal !== null ? adxVal.toFixed(1) : "n/a") + " vs >=" + ADX_MIN) : "ADX off" },
    { name: "Bullish pattern", ok: _bullFormed.length > 0,
      detail: _bullFormed.length ? _bullFormed.join(",") : "none formed (DblBot/AscTri)" },
  ];
  var _peAuditChecks = [
    { name: "RSI in PE range", ok: rsi > RSI_PE_MIN && rsi < RSI_PE_MAX,
      detail: "RSI=" + rsi.toFixed(1) + " vs " + RSI_PE_MIN + "-" + RSI_PE_MAX },
    { name: "ADX trending", ok: !ADX_ENABLED || isTrending,
      detail: ADX_ENABLED ? ("ADX=" + (adxVal !== null ? adxVal.toFixed(1) : "n/a") + " vs >=" + ADX_MIN) : "ADX off" },
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
  _indicatorCache = { key: null, rsi: null };
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

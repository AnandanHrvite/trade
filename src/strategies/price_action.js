/**
 * STRATEGY: PRICE ACTION (5-min candles)
 *
 * Pure price action patterns with RSI confluence filter.
 * No lagging indicators as primary signal — reads what price IS doing.
 *
 * PATTERNS DETECTED:
 *   1. Bullish/Bearish Engulfing at S/R levels
 *   2. Pin Bar (Hammer / Shooting Star) at S/R levels
 *   3. Inside Bar Breakout (consolidation → expansion)
 *   4. Break of Structure (BOS) — higher-high / lower-low confirmation
 *
 * SUPPORT/RESISTANCE:
 *   Dynamic S/R from recent swing highs/lows (lookback 30 candles)
 *   S/R zone = swing point +/- SR_ZONE_PTS (default 10pts)
 *
 * CONFLUENCE:
 *   RSI(14) as confirmation — not primary signal
 *   CE: RSI > 45 (not oversold = momentum supports up move)
 *   PE: RSI < 55 (not overbought = momentum supports down move)
 *
 * EXIT:
 *   SL = signal candle wick (engulfing/pin bar) or inside bar boundary
 *   Trailing via swing structure
 *
 * Timeframe: 5-min | Window: 9:20 AM – 2:30 PM IST
 */

const { RSI } = require("technicalindicators");

const NAME        = "PRICE_ACTION_5M";
const DESCRIPTION = "5-min | Engulfing + Pin Bar + Inside Bar + BOS | S/R zones | RSI confluence";

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

// ── Check if price is near a S/R zone ────────────────────────────────────────
function isNearSupport(price, swingLows, zonePts) {
  for (var i = swingLows.length - 1; i >= 0; i--) {
    if (Math.abs(price - swingLows[i].price) <= zonePts) {
      return { near: true, level: swingLows[i].price };
    }
  }
  return { near: false, level: null };
}

function isNearResistance(price, swingHighs, zonePts) {
  for (var i = swingHighs.length - 1; i >= 0; i--) {
    if (Math.abs(price - swingHighs[i].price) <= zonePts) {
      return { near: true, level: swingHighs[i].price };
    }
  }
  return { near: false, level: null };
}

// ── Pattern detection ────────────────────────────────────────────────────────

function candleBody(c) { return Math.abs(c.close - c.open); }
function candleRange(c) { return c.high - c.low; }
function isGreen(c) { return c.close > c.open; }
function isRed(c) { return c.close < c.open; }
function upperWick(c) { return c.high - Math.max(c.open, c.close); }
function lowerWick(c) { return Math.min(c.open, c.close) - c.low; }

/**
 * Bullish Engulfing: current green candle's body fully engulfs previous red candle's body
 */
function isBullishEngulfing(prev, curr, minBody) {
  if (!isRed(prev) || !isGreen(curr)) return false;
  if (candleBody(curr) < minBody) return false;
  return curr.open <= prev.close && curr.close >= prev.open;
}

/**
 * Bearish Engulfing: current red candle's body fully engulfs previous green candle's body
 */
function isBearishEngulfing(prev, curr, minBody) {
  if (!isGreen(prev) || !isRed(curr)) return false;
  if (candleBody(curr) < minBody) return false;
  return curr.open >= prev.close && curr.close <= prev.open;
}

/**
 * Hammer (Bullish Pin Bar): small body at top, long lower wick (>= 2x body)
 */
function isHammer(c, minWickRatio) {
  var body = candleBody(c);
  var lw   = lowerWick(c);
  var uw   = upperWick(c);
  if (body < 2) return false; // minimum body
  return lw >= body * minWickRatio && uw <= body * 0.5;
}

/**
 * Shooting Star (Bearish Pin Bar): small body at bottom, long upper wick (>= 2x body)
 */
function isShootingStar(c, minWickRatio) {
  var body = candleBody(c);
  var uw   = upperWick(c);
  var lw   = lowerWick(c);
  if (body < 2) return false;
  return uw >= body * minWickRatio && lw <= body * 0.5;
}

/**
 * Inside Bar: current candle's range is completely within previous candle's range
 */
function isInsideBar(prev, curr) {
  return curr.high <= prev.high && curr.low >= prev.low;
}

/**
 * Break of Structure (BOS):
 * Bullish BOS: current candle closes above the most recent swing high
 * Bearish BOS: current candle closes below the most recent swing low
 */
function checkBOS(candle, swingHighs, swingLows) {
  var result = { bullish: false, bearish: false, level: null };
  if (swingHighs.length > 0) {
    var lastSwingHigh = swingHighs[swingHighs.length - 1];
    if (candle.close > lastSwingHigh.price && candle.open <= lastSwingHigh.price) {
      result.bullish = true;
      result.level = lastSwingHigh.price;
    }
  }
  if (swingLows.length > 0) {
    var lastSwingLow = swingLows[swingLows.length - 1];
    if (candle.close < lastSwingLow.price && candle.open >= lastSwingLow.price) {
      result.bearish = true;
      result.level = lastSwingLow.price;
    }
  }
  return result;
}

// ── Indicator cache ──────────────────────────────────────────────────────────
let _indicatorCache = { key: null, rsi: null };

function _makeKey(candles) {
  if (candles.length < 2) return null;
  var last = candles[candles.length - 1];
  var prev = candles[candles.length - 2];
  return prev.time + ":" + candles.length + ":" + last.open + ":" + last.high + ":" + last.low + ":" + last.close;
}

// ── Internal state for inside bar tracking ───────────────────────────────────
let _insideBarPending = null; // { motherCandle, direction: null, triggerHigh, triggerLow }

// ── Main signal function ─────────────────────────────────────────────────────
function getSignal(candles, opts) {
  opts = opts || {};
  var silent = opts.silent === true;

  var RSI_PERIOD    = parseInt(cfg("PA_RSI_PERIOD", "14"), 10);
  var RSI_CE_MIN    = parseFloat(cfg("PA_RSI_CE_MIN", "45"));
  var RSI_PE_MAX    = parseFloat(cfg("PA_RSI_PE_MAX", "55"));
  var MIN_BODY      = parseFloat(cfg("PA_MIN_BODY", "5"));
  var PIN_WICK_RATIO = parseFloat(cfg("PA_PIN_WICK_RATIO", "2"));
  var SR_LOOKBACK   = parseInt(cfg("PA_SR_LOOKBACK", "30"), 10);
  var SR_ZONE_PTS   = parseFloat(cfg("PA_SR_ZONE_PTS", "15"));
  var MAX_SL_PTS    = parseFloat(cfg("PA_MAX_SL_PTS", "25"));
  var MIN_SL_PTS    = parseFloat(cfg("PA_MIN_SL_PTS", "8"));

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
  var prev = candles[candles.length - 2];
  var prev2 = candles[candles.length - 3];

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

  // ── Swing points & S/R zones ───────────────────────────────────────────────
  var swings = findSwingPoints(candles, SR_LOOKBACK);
  base.swingHighs = swings.swingHighs.slice(-3).map(function(s) { return s.price; });
  base.swingLows  = swings.swingLows.slice(-3).map(function(s) { return s.price; });

  var supportCheck    = isNearSupport(sc.low, swings.swingLows, SR_ZONE_PTS);
  var resistanceCheck = isNearResistance(sc.high, swings.swingHighs, SR_ZONE_PTS);

  var _ist = "";
  if (!silent) {
    _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  }

  // ── INSIDE BAR BREAKOUT CHECK ──────────────────────────────────────────────
  // If we had a pending inside bar, check if this candle breaks out
  if (_insideBarPending) {
    var mother = _insideBarPending;
    if (sc.close > mother.triggerHigh && rsi > RSI_CE_MIN) {
      // Bullish breakout
      var rawSL = mother.motherCandle.low;
      var slPts = Math.max(Math.min(sc.close - rawSL, MAX_SL_PTS), MIN_SL_PTS);
      var sl = parseFloat((sc.close - slPts).toFixed(2));
      _insideBarPending = null;
      if (!silent) console.log("[PA " + _ist + "] CE Inside Bar Breakout: close=" + sc.close + " > mother.high=" + mother.triggerHigh + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
      return Object.assign({}, base, {
        signal: "BUY_CE", signalStrength: "STRONG",
        pattern: "Inside Bar Breakout",
        stopLoss: sl, slSource: "Mother Bar Low",
        srLevel: mother.triggerHigh,
        reason: "CE: Inside Bar Breakout above " + mother.triggerHigh.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
      });
    }
    if (sc.close < mother.triggerLow && rsi < RSI_PE_MAX) {
      // Bearish breakout
      var rawSL = mother.motherCandle.high;
      var slPts = Math.max(Math.min(rawSL - sc.close, MAX_SL_PTS), MIN_SL_PTS);
      var sl = parseFloat((sc.close + slPts).toFixed(2));
      _insideBarPending = null;
      if (!silent) console.log("[PA " + _ist + "] PE Inside Bar Breakout: close=" + sc.close + " < mother.low=" + mother.triggerLow + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
      return Object.assign({}, base, {
        signal: "BUY_PE", signalStrength: "STRONG",
        pattern: "Inside Bar Breakout",
        stopLoss: sl, slSource: "Mother Bar High",
        srLevel: mother.triggerLow,
        reason: "PE: Inside Bar Breakout below " + mother.triggerLow.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
      });
    }
    // If 3 candles pass without breakout, cancel
    if (!_insideBarPending._waitCount) _insideBarPending._waitCount = 0;
    _insideBarPending._waitCount++;
    if (_insideBarPending._waitCount > 3) _insideBarPending = null;
  }

  // ── Check for new inside bar (queue for next candle breakout) ──────────────
  if (isInsideBar(prev, sc)) {
    _insideBarPending = {
      motherCandle: prev,
      triggerHigh: prev.high,
      triggerLow: prev.low,
      _waitCount: 0,
    };
    base.reason = "Inside Bar detected — waiting for breakout (mother: " + prev.high.toFixed(0) + "/" + prev.low.toFixed(0) + ")";
    base.pattern = "Inside Bar (pending)";
    return base;
  }

  // ── PATTERN 1: BULLISH ENGULFING at Support ────────────────────────────────
  if (isBullishEngulfing(prev, sc, MIN_BODY) && supportCheck.near && rsi > RSI_CE_MIN) {
    var rawSL = sc.low;
    var slPts = Math.max(Math.min(sc.close - rawSL, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close - slPts).toFixed(2));
    if (!silent) console.log("[PA " + _ist + "] CE Bullish Engulfing at support " + supportCheck.level.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_CE", signalStrength: "STRONG",
      pattern: "Bullish Engulfing",
      stopLoss: sl, slSource: "Signal Candle Low",
      srLevel: supportCheck.level,
      reason: "CE: Bullish Engulfing at support " + supportCheck.level.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
    });
  }

  // ── PATTERN 2: BEARISH ENGULFING at Resistance ─────────────────────────────
  if (isBearishEngulfing(prev, sc, MIN_BODY) && resistanceCheck.near && rsi < RSI_PE_MAX) {
    var rawSL = sc.high;
    var slPts = Math.max(Math.min(rawSL - sc.close, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close + slPts).toFixed(2));
    if (!silent) console.log("[PA " + _ist + "] PE Bearish Engulfing at resistance " + resistanceCheck.level.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_PE", signalStrength: "STRONG",
      pattern: "Bearish Engulfing",
      stopLoss: sl, slSource: "Signal Candle High",
      srLevel: resistanceCheck.level,
      reason: "PE: Bearish Engulfing at resistance " + resistanceCheck.level.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
    });
  }

  // ── PATTERN 3: HAMMER (Pin Bar) at Support ─────────────────────────────────
  if (isHammer(sc, PIN_WICK_RATIO) && supportCheck.near && rsi > RSI_CE_MIN) {
    var rawSL = sc.low;
    var slPts = Math.max(Math.min(sc.close - rawSL, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close - slPts).toFixed(2));
    if (!silent) console.log("[PA " + _ist + "] CE Hammer at support " + supportCheck.level.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_CE", signalStrength: "MARGINAL",
      pattern: "Hammer",
      stopLoss: sl, slSource: "Pin Bar Low",
      srLevel: supportCheck.level,
      reason: "CE: Hammer at support " + supportCheck.level.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
    });
  }

  // ── PATTERN 4: SHOOTING STAR (Pin Bar) at Resistance ───────────────────────
  if (isShootingStar(sc, PIN_WICK_RATIO) && resistanceCheck.near && rsi < RSI_PE_MAX) {
    var rawSL = sc.high;
    var slPts = Math.max(Math.min(rawSL - sc.close, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close + slPts).toFixed(2));
    if (!silent) console.log("[PA " + _ist + "] PE Shooting Star at resistance " + resistanceCheck.level.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_PE", signalStrength: "MARGINAL",
      pattern: "Shooting Star",
      stopLoss: sl, slSource: "Pin Bar High",
      srLevel: resistanceCheck.level,
      reason: "PE: Shooting Star at resistance " + resistanceCheck.level.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
    });
  }

  // ── PATTERN 5: BREAK OF STRUCTURE ──────────────────────────────────────────
  var bos = checkBOS(sc, swings.swingHighs, swings.swingLows);
  if (bos.bullish && rsi > RSI_CE_MIN && candleBody(sc) >= MIN_BODY) {
    var rawSL = Math.min(sc.low, prev.low);
    var slPts = Math.max(Math.min(sc.close - rawSL, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close - slPts).toFixed(2));
    if (!silent) console.log("[PA " + _ist + "] CE BOS above " + bos.level.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_CE", signalStrength: "STRONG",
      pattern: "Break of Structure",
      stopLoss: sl, slSource: "Recent Swing Low",
      srLevel: bos.level,
      reason: "CE: BOS above swing high " + bos.level.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
    });
  }
  if (bos.bearish && rsi < RSI_PE_MAX && candleBody(sc) >= MIN_BODY) {
    var rawSL = Math.max(sc.high, prev.high);
    var slPts = Math.max(Math.min(rawSL - sc.close, MAX_SL_PTS), MIN_SL_PTS);
    var sl = parseFloat((sc.close + slPts).toFixed(2));
    if (!silent) console.log("[PA " + _ist + "] PE BOS below " + bos.level.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl);
    return Object.assign({}, base, {
      signal: "BUY_PE", signalStrength: "STRONG",
      pattern: "Break of Structure",
      stopLoss: sl, slSource: "Recent Swing High",
      srLevel: bos.level,
      reason: "PE: BOS below swing low " + bos.level.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl,
    });
  }

  // ── No signal — build reason ───────────────────────────────────────────────
  var parts = [];
  if (isBullishEngulfing(prev, sc, MIN_BODY) && !supportCheck.near) parts.push("Bull Engulf but no support");
  if (isBearishEngulfing(prev, sc, MIN_BODY) && !resistanceCheck.near) parts.push("Bear Engulf but no resistance");
  if (isHammer(sc, PIN_WICK_RATIO) && !supportCheck.near) parts.push("Hammer but no support");
  if (isShootingStar(sc, PIN_WICK_RATIO) && !resistanceCheck.near) parts.push("Shooting Star but no resistance");

  base.reason = parts.length > 0 ? "No setup (" + parts.join("; ") + ")" : "No setup";
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
  _insideBarPending = null;
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

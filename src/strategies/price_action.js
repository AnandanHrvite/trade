/**
 * STRATEGY: PRICE ACTION (5-min candles)
 *
 * Pure price action patterns with RSI/ADX confluence filters.
 * No lagging indicators as primary signal — reads what price IS doing.
 *
 * PATTERNS DETECTED:
 *   1. Bullish/Bearish Engulfing at S/R levels
 *   2. Pin Bar (Hammer / Shooting Star) at S/R levels
 *   3. Inside Bar Breakout (consolidation → expansion)
 *   4. Break of Structure (BOS) — higher-high / lower-low confirmation
 *   5. Double Top / Double Bottom — two equal swing points + neckline break (opt)
 *   6. Ascending / Descending Triangle — flat S/R + converging trendline break (opt)
 *
 * SUPPORT/RESISTANCE:
 *   Dynamic S/R from recent swing highs/lows (lookback 30 candles)
 *   S/R zone = swing point +/- SR_ZONE_PTS
 *
 * ENTRY CONFLUENCE & QUALITY GATES:
 *   RSI(14): CE min/max, PE min/max — blocks entries at exhausted-move extremes
 *   ADX level: blocks entries when market is ranging (PA_ADX_MIN)
 *   ADX rising (all patterns when PA_ADX_RISING_REQUIRED=true):
 *     require ADX[now] >= ADX[2 bars ago]. Blocks any setup when the trend is
 *     fading — counter-trend reversals at "support" most often fail when ADX
 *     is dropping.
 *   ADX directional (PA_ADX_DIRECTIONAL=true): require +DI > -DI for CE,
 *     -DI > +DI for PE. Blocks counter-trend bullish/bearish patterns inside
 *     a strong opposite-direction trend.
 *   Structural SL cap (BOS/IB only): skip when raw swing/mother-bar distance
 *     exceeds PA_MAX_STRUCT_SL_PTS. Thin structure → false breakout risk.
 *
 * EXIT:
 *   Hard SL: signal candle wick / mother bar / recent swing, clamped to
 *     [PA_MIN_SL_PTS, PA_MAX_SL_PTS] to bound per-trade loss.
 *   Trail: swing-structure tightening (only tighten) + candle-trail (N-bar
 *     low/high, primary) + tiered profit-lock floor (safety net on large
 *     winners). Activates once peak PnL >= PA_TRAIL_START.
 *   Time-stop: exit flat trades after PA_TIME_STOP_CANDLES with |PnL| <
 *     PA_TIME_STOP_FLAT_PTS points (theta bleed guard).
 *
 * Timeframe: 5-min | Window: PA_ENTRY_START – PA_ENTRY_END IST
 */

const { RSI, ADX } = require("technicalindicators");

const NAME        = "PRICE_ACTION_5M";
const DESCRIPTION = "5-min | Engulfing + Pin Bar + Inside Bar + BOS + Double Top/Bottom + Triangles | S/R zones | RSI confluence";

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

// ── Internal state for inside bar tracking ───────────────────────────────────
let _insideBarPending = null; // { motherCandle, direction: null, triggerHigh, triggerLow }

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
  var PIN_WICK_RATIO = parseFloat(cfg("PA_PIN_WICK_RATIO", "2"));
  var SR_LOOKBACK   = parseInt(cfg("PA_SR_LOOKBACK", "30"), 10);
  var SR_ZONE_PTS   = parseFloat(cfg("PA_SR_ZONE_PTS", "15"));
  var MAX_SL_PTS    = parseFloat(cfg("PA_MAX_SL_PTS", "12"));
  var MIN_SL_PTS    = parseFloat(cfg("PA_MIN_SL_PTS", "8"));
  var MAX_STRUCT_SL_PTS = parseFloat(cfg("PA_MAX_STRUCT_SL_PTS", "15")); // skip BOS/IB if raw structural SL > this
  var ADX_RISING_REQ = cfg("PA_ADX_RISING_REQUIRED", "true") === "true"; // require ADX[t] >= ADX[t-2] for ALL patterns
  var ADX_DIRECTIONAL = cfg("PA_ADX_DIRECTIONAL", "true") === "true";    // require +DI>-DI for CE, -DI>+DI for PE
  var CHART_PATTERN_TOL = parseFloat(cfg("PA_CHART_PATTERN_TOL", "12")); // tolerance for double top/bottom & triangles
  // Per-pattern toggles
  var PATTERN_ENGULFING     = cfg("PA_PATTERN_ENGULFING",     "true")  === "true";
  var PATTERN_PINBAR        = cfg("PA_PATTERN_PINBAR",        "true")  === "true";
  var PATTERN_BOS           = cfg("PA_PATTERN_BOS",           "true")  === "true";
  var PATTERN_INSIDE_BAR    = cfg("PA_PATTERN_INSIDE_BAR",    "true")  === "true";
  var PATTERN_DOUBLE_TOP    = cfg("PA_PATTERN_DOUBLE_TOP",    "false") === "true";
  var PATTERN_DOUBLE_BOTTOM = cfg("PA_PATTERN_DOUBLE_BOTTOM", "false") === "true";
  var PATTERN_ASC_TRIANGLE  = cfg("PA_PATTERN_ASC_TRIANGLE",  "false") === "true";
  var PATTERN_DESC_TRIANGLE = cfg("PA_PATTERN_DESC_TRIANGLE", "false") === "true";

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

  // ── ADX trend filter ──────────────────────────────────────────────────────
  var adxVal = null;
  var adxPrev2 = null;
  var pdiVal = null; // +DI (bullish directional)
  var mdiVal = null; // -DI (bearish directional)
  var isTrending = true; // default pass if ADX disabled
  var adxRising = true;  // default pass if ADX disabled or insufficient history
  if (ADX_ENABLED) {
    var highs  = candles.map(function(c) { return c.high; });
    var lows   = candles.map(function(c) { return c.low; });
    var adxCloses = candles.map(function(c) { return c.close; });
    var adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: adxCloses });
    if (adxArr.length > 0) {
      var lastAdx = adxArr[adxArr.length - 1];
      adxVal = lastAdx.adx;
      pdiVal = lastAdx.pdi !== undefined ? lastAdx.pdi : null;
      mdiVal = lastAdx.mdi !== undefined ? lastAdx.mdi : null;
    }
    // Slope check: current ADX vs. 2 bars ago (rising = trend firming, falling = trend dying)
    adxPrev2 = adxArr.length >= 3 ? adxArr[adxArr.length - 3].adx : null;
    isTrending = adxVal === null ? true : adxVal >= ADX_MIN;
    adxRising  = (adxVal !== null && adxPrev2 !== null) ? adxVal >= adxPrev2 : true;
  }
  base.adx = adxVal !== null ? parseFloat(adxVal.toFixed(1)) : null;
  base.pdi = pdiVal !== null ? parseFloat(pdiVal.toFixed(1)) : null;
  base.mdi = mdiVal !== null ? parseFloat(mdiVal.toFixed(1)) : null;
  base.adxRising = adxRising;
  base.isTrending = isTrending;

  // ── Directional ADX gate helpers (used by every pattern below) ────────────
  // Returns false (block) when directional check is enabled and the requested
  // side is fighting the dominant +DI/-DI direction. Default-pass when ADX is
  // off OR DI values are missing (insufficient history).
  function _diOk(side) {
    if (!ADX_ENABLED || !ADX_DIRECTIONAL) return true;
    if (pdiVal === null || mdiVal === null) return true;
    return side === "CE" ? pdiVal > mdiVal : mdiVal > pdiVal;
  }
  // ADX-rising gate (all patterns). Default-pass when ADX off / disabled flag.
  function _risingOk() {
    if (!ADX_ENABLED || !ADX_RISING_REQ) return true;
    return adxRising;
  }
  function _risingDetail() {
    return "ADX " + (adxVal !== null ? adxVal.toFixed(1) : "n/a") +
           " vs " + (adxPrev2 !== null ? adxPrev2.toFixed(1) : "n/a") + " 2 bars ago";
  }
  function _diDetail(side) {
    var want = side === "CE" ? "+DI>-DI" : "-DI>+DI";
    return want + " (+DI=" + (pdiVal !== null ? pdiVal.toFixed(1) : "n/a") +
           " -DI=" + (mdiVal !== null ? mdiVal.toFixed(1) : "n/a") + ")";
  }

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

  // ── ADX chop gate — block all entries when market is ranging ────────────────
  if (ADX_ENABLED && !isTrending) {
    var _adxSkip = "ADX=" + (adxVal !== null ? adxVal.toFixed(1) : "n/a") + " < " + ADX_MIN + " (ranging)";
    base.reason = "No setup (market ranging — " + _adxSkip + ")";
    if (_insideBarPending) {
      if (!_insideBarPending._waitCount) _insideBarPending._waitCount = 0;
      _insideBarPending._waitCount++;
      if (_insideBarPending._waitCount > 3) _insideBarPending = null;
    }
    return base;
  }

  // ── INSIDE BAR BREAKOUT CHECK ──────────────────────────────────────────────
  // If pattern toggled off mid-session, drop any stale pending state
  if (!PATTERN_INSIDE_BAR && _insideBarPending) _insideBarPending = null;
  // If we had a pending inside bar, check if this candle breaks out
  if (PATTERN_INSIDE_BAR && _insideBarPending) {
    var mother = _insideBarPending;
    if (sc.close > mother.triggerHigh && rsi > RSI_CE_MIN && rsi < RSI_CE_MAX) {
      // Bullish breakout — quality gates: structural SL cap + ADX rising + directional
      var rawSL = mother.motherCandle.low;
      var rawStructGap = sc.close - rawSL;
      if (rawStructGap > MAX_STRUCT_SL_PTS) {
        _insideBarPending = null;
        base.reason = "IB breakout skipped — structure too wide (" + rawStructGap.toFixed(1) + " > " + MAX_STRUCT_SL_PTS + " pts)";
        return base;
      }
      if (!_risingOk()) {
        _insideBarPending = null;
        base.reason = "IB breakout skipped — ADX not rising (" + _risingDetail() + ")";
        return base;
      }
      if (!_diOk("CE")) {
        _insideBarPending = null;
        base.reason = "IB breakout skipped — wrong direction (" + _diDetail("CE") + ")";
        return base;
      }
      var slPts = Math.max(Math.min(rawStructGap, MAX_SL_PTS), MIN_SL_PTS);
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
    if (sc.close < mother.triggerLow && rsi < RSI_PE_MAX && rsi > RSI_PE_MIN) {
      // Bearish breakout — quality gates: structural SL cap + ADX rising + directional
      var rawSL = mother.motherCandle.high;
      var rawStructGap = rawSL - sc.close;
      if (rawStructGap > MAX_STRUCT_SL_PTS) {
        _insideBarPending = null;
        base.reason = "IB breakout skipped — structure too wide (" + rawStructGap.toFixed(1) + " > " + MAX_STRUCT_SL_PTS + " pts)";
        return base;
      }
      if (!_risingOk()) {
        _insideBarPending = null;
        base.reason = "IB breakout skipped — ADX not rising (" + _risingDetail() + ")";
        return base;
      }
      if (!_diOk("PE")) {
        _insideBarPending = null;
        base.reason = "IB breakout skipped — wrong direction (" + _diDetail("PE") + ")";
        return base;
      }
      var slPts = Math.max(Math.min(rawStructGap, MAX_SL_PTS), MIN_SL_PTS);
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
  if (PATTERN_INSIDE_BAR && isInsideBar(prev, sc)) {
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
  if (PATTERN_ENGULFING && isBullishEngulfing(prev, sc, MIN_BODY) && supportCheck.near && rsi > RSI_CE_MIN && rsi < RSI_CE_MAX) {
    if (!_risingOk()) { base.reason = "Bull Engulf skipped — ADX not rising (" + _risingDetail() + ")"; return base; }
    if (!_diOk("CE")) { base.reason = "Bull Engulf skipped — wrong direction (" + _diDetail("CE") + ")"; return base; }
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
  if (PATTERN_ENGULFING && isBearishEngulfing(prev, sc, MIN_BODY) && resistanceCheck.near && rsi < RSI_PE_MAX && rsi > RSI_PE_MIN) {
    if (!_risingOk()) { base.reason = "Bear Engulf skipped — ADX not rising (" + _risingDetail() + ")"; return base; }
    if (!_diOk("PE")) { base.reason = "Bear Engulf skipped — wrong direction (" + _diDetail("PE") + ")"; return base; }
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
  if (PATTERN_PINBAR && isHammer(sc, PIN_WICK_RATIO) && supportCheck.near && rsi > RSI_CE_MIN && rsi < RSI_CE_MAX) {
    if (!_risingOk()) { base.reason = "Hammer skipped — ADX not rising (" + _risingDetail() + ")"; return base; }
    if (!_diOk("CE")) { base.reason = "Hammer skipped — wrong direction (" + _diDetail("CE") + ")"; return base; }
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
  if (PATTERN_PINBAR && isShootingStar(sc, PIN_WICK_RATIO) && resistanceCheck.near && rsi < RSI_PE_MAX && rsi > RSI_PE_MIN) {
    if (!_risingOk()) { base.reason = "Shooting Star skipped — ADX not rising (" + _risingDetail() + ")"; return base; }
    if (!_diOk("PE")) { base.reason = "Shooting Star skipped — wrong direction (" + _diDetail("PE") + ")"; return base; }
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
  // Quality gates: reject BOS when structure is thin (swing too far = false-break risk)
  // or when the trend is fading (ADX not rising vs 2 bars ago).
  var bos = PATTERN_BOS ? checkBOS(sc, swings.swingHighs, swings.swingLows) : { bullish: false, bearish: false };
  if (bos.bullish && rsi > RSI_CE_MIN && rsi < RSI_CE_MAX && candleBody(sc) >= MIN_BODY) {
    var rawSL = Math.min(sc.low, prev.low);
    var rawStructGap = sc.close - rawSL;
    if (rawStructGap > MAX_STRUCT_SL_PTS) {
      base.reason = "BOS skipped — structure too wide (" + rawStructGap.toFixed(1) + " > " + MAX_STRUCT_SL_PTS + " pts)";
      return base;
    }
    if (!_risingOk()) {
      base.reason = "BOS skipped — ADX not rising (" + _risingDetail() + ")";
      return base;
    }
    if (!_diOk("CE")) {
      base.reason = "BOS skipped — wrong direction (" + _diDetail("CE") + ")";
      return base;
    }
    var slPts = Math.max(Math.min(rawStructGap, MAX_SL_PTS), MIN_SL_PTS);
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
  if (bos.bearish && rsi < RSI_PE_MAX && rsi > RSI_PE_MIN && candleBody(sc) >= MIN_BODY) {
    var rawSL = Math.max(sc.high, prev.high);
    var rawStructGap = rawSL - sc.close;
    if (rawStructGap > MAX_STRUCT_SL_PTS) {
      base.reason = "BOS skipped — structure too wide (" + rawStructGap.toFixed(1) + " > " + MAX_STRUCT_SL_PTS + " pts)";
      return base;
    }
    if (!_risingOk()) {
      base.reason = "BOS skipped — ADX not rising (" + _risingDetail() + ")";
      return base;
    }
    if (!_diOk("PE")) {
      base.reason = "BOS skipped — wrong direction (" + _diDetail("PE") + ")";
      return base;
    }
    var slPts = Math.max(Math.min(rawStructGap, MAX_SL_PTS), MIN_SL_PTS);
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

  // ── PATTERN 6: DOUBLE TOP (Bearish reversal) ────────────────────────────────
  var dblTop = { detected: false };
  var dblBot = { detected: false };
  var ascTri = { detected: false };
  var descTri = { detected: false };
  if (PATTERN_DOUBLE_TOP) {
  dblTop = checkDoubleTop(sc, swings.swingHighs, candles, CHART_PATTERN_TOL);
  if (dblTop.detected && rsi < RSI_PE_MAX && rsi > RSI_PE_MIN && candleBody(sc) >= MIN_BODY) {
    if (!_risingOk()) { base.reason = "Double Top skipped — ADX not rising (" + _risingDetail() + ")"; return base; }
    if (!_diOk("PE")) { base.reason = "Double Top skipped — wrong direction (" + _diDetail("PE") + ")"; return base; }
    var rawSL = dblTop.topLevel;
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

  // ── PATTERN 7: DOUBLE BOTTOM (Bullish reversal) ───────────────────────────
  if (PATTERN_DOUBLE_BOTTOM) {
  dblBot = checkDoubleBottom(sc, swings.swingLows, candles, CHART_PATTERN_TOL);
  if (dblBot.detected && rsi > RSI_CE_MIN && rsi < RSI_CE_MAX && candleBody(sc) >= MIN_BODY) {
    if (!_risingOk()) { base.reason = "Double Bottom skipped — ADX not rising (" + _risingDetail() + ")"; return base; }
    if (!_diOk("CE")) { base.reason = "Double Bottom skipped — wrong direction (" + _diDetail("CE") + ")"; return base; }
    var rawSL = dblBot.bottomLevel;
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

  // ── PATTERN 8: ASCENDING TRIANGLE (Bullish breakout) ──────────────────────
  if (PATTERN_ASC_TRIANGLE) {
  ascTri = checkAscendingTriangle(sc, swings.swingHighs, swings.swingLows, CHART_PATTERN_TOL);
  if (ascTri.detected && rsi > RSI_CE_MIN && rsi < RSI_CE_MAX && candleBody(sc) >= MIN_BODY) {
    if (!_risingOk()) { base.reason = "Asc Triangle skipped — ADX not rising (" + _risingDetail() + ")"; return base; }
    if (!_diOk("CE")) { base.reason = "Asc Triangle skipped — wrong direction (" + _diDetail("CE") + ")"; return base; }
    var rawSL = ascTri.risingLow;
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

  // ── PATTERN 9: DESCENDING TRIANGLE (Bearish breakout) ─────────────────────
  if (PATTERN_DESC_TRIANGLE) {
  descTri = checkDescendingTriangle(sc, swings.swingHighs, swings.swingLows, CHART_PATTERN_TOL);
  if (descTri.detected && rsi < RSI_PE_MAX && rsi > RSI_PE_MIN && candleBody(sc) >= MIN_BODY) {
    if (!_risingOk()) { base.reason = "Desc Triangle skipped — ADX not rising (" + _risingDetail() + ")"; return base; }
    if (!_diOk("PE")) { base.reason = "Desc Triangle skipped — wrong direction (" + _diDetail("PE") + ")"; return base; }
    var rawSL = descTri.fallingHigh;
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
  var parts = [];
  if (isBullishEngulfing(prev, sc, MIN_BODY) && !supportCheck.near) parts.push("Bull Engulf but no support");
  if (isBearishEngulfing(prev, sc, MIN_BODY) && !resistanceCheck.near) parts.push("Bear Engulf but no resistance");
  if (isHammer(sc, PIN_WICK_RATIO) && !supportCheck.near) parts.push("Hammer but no support");
  if (isShootingStar(sc, PIN_WICK_RATIO) && !resistanceCheck.near) parts.push("Shooting Star but no resistance");

  base.reason = parts.length > 0 ? "No setup (" + parts.join("; ") + ")" : "No setup";

  // ── Filter audit (additive logging — does not affect entry decisions) ─────
  // Records which filters passed/failed for CE and PE so the structured skip
  // log captures *why* this bar produced no signal. Patterns are checked
  // regardless of toggle state, but only enabled+formed patterns count toward
  // the "pattern" filter — disabled (off) ones are surfaced in detail for
  // opportunity-cost visibility but never pass the gate.
  var _auditBullEngulf = isBullishEngulfing(prev, sc, MIN_BODY);
  var _auditBearEngulf = isBearishEngulfing(prev, sc, MIN_BODY);
  var _auditHammer     = isHammer(sc, PIN_WICK_RATIO);
  var _auditShootStar  = isShootingStar(sc, PIN_WICK_RATIO);
  var _auditBOS        = checkBOS(sc, swings.swingHighs, swings.swingLows);
  var _auditIBBull     = !!(_insideBarPending && sc.close > _insideBarPending.triggerHigh);
  var _auditIBBear     = !!(_insideBarPending && sc.close < _insideBarPending.triggerLow);
  var _auditDblTop     = checkDoubleTop(sc, swings.swingHighs, candles, CHART_PATTERN_TOL);
  var _auditDblBot     = checkDoubleBottom(sc, swings.swingLows, candles, CHART_PATTERN_TOL);
  var _auditAscTri     = checkAscendingTriangle(sc, swings.swingHighs, swings.swingLows, CHART_PATTERN_TOL);
  var _auditDescTri    = checkDescendingTriangle(sc, swings.swingHighs, swings.swingLows, CHART_PATTERN_TOL);

  // Split "formed" patterns into enabled vs disabled — only enabled count
  // toward the "Bullish/Bearish pattern" gate; disabled are shown for context.
  var _bullEnabled = [], _bullDisabled = [];
  function _addBull(formed, name, enabled) {
    if (!formed) return;
    if (enabled) _bullEnabled.push(name);
    else         _bullDisabled.push(name + "(off)");
  }
  _addBull(_auditBullEngulf,      "Engulf",  PATTERN_ENGULFING);
  _addBull(_auditHammer,          "Hammer",  PATTERN_PINBAR);
  _addBull(_auditBOS.bullish,     "BOS",     PATTERN_BOS);
  _addBull(_auditIBBull,          "IB",      PATTERN_INSIDE_BAR);
  _addBull(_auditDblBot.detected, "DblBot",  PATTERN_DOUBLE_BOTTOM);
  _addBull(_auditAscTri.detected, "AscTri",  PATTERN_ASC_TRIANGLE);
  var _bearEnabled = [], _bearDisabled = [];
  function _addBear(formed, name, enabled) {
    if (!formed) return;
    if (enabled) _bearEnabled.push(name);
    else         _bearDisabled.push(name + "(off)");
  }
  _addBear(_auditBearEngulf,      "Engulf",    PATTERN_ENGULFING);
  _addBear(_auditShootStar,       "ShootStar", PATTERN_PINBAR);
  _addBear(_auditBOS.bearish,     "BOS",       PATTERN_BOS);
  _addBear(_auditIBBear,          "IB",        PATTERN_INSIDE_BAR);
  _addBear(_auditDblTop.detected, "DblTop",    PATTERN_DOUBLE_TOP);
  _addBear(_auditDescTri.detected,"DescTri",   PATTERN_DESC_TRIANGLE);

  function _patternDetail(enabled, disabled, allList) {
    if (enabled.length) {
      return enabled.join(",") + (disabled.length ? " (also: " + disabled.join(",") + ")" : "");
    }
    if (disabled.length) return "only disabled patterns formed: " + disabled.join(",");
    return "none formed (" + allList + ")";
  }

  function _nearestDist(price, levels) {
    var best = null;
    for (var i = 0; i < levels.length; i++) {
      var d = Math.abs(price - levels[i].price);
      if (best === null || d < best) best = d;
    }
    return best;
  }
  var _nearLowDist  = _nearestDist(sc.low,  swings.swingLows);
  var _nearHighDist = _nearestDist(sc.high, swings.swingHighs);

  // ADX-rising / directional gates — mirror _risingOk()/_diOk() exactly so
  // the audit reflects what the strategy actually checks per pattern.
  var _risingActive = ADX_ENABLED && ADX_RISING_REQ;
  var _risingPass   = !_risingActive || adxRising;
  var _risingDetailStr = _risingActive
    ? ("ADX=" + (adxVal !== null ? adxVal.toFixed(1) : "n/a") +
       " vs " + (adxPrev2 !== null ? adxPrev2.toFixed(1) : "n/a") + " 2 bars ago")
    : "rising gate off";

  var _diActive = ADX_ENABLED && ADX_DIRECTIONAL;
  var _diMissing = pdiVal === null || mdiVal === null;
  var _diCePass = !_diActive || _diMissing || pdiVal > mdiVal;
  var _diPePass = !_diActive || _diMissing || mdiVal > pdiVal;
  function _diDetailStr(side) {
    if (!_diActive) return "directional gate off";
    if (_diMissing) return "DI not available (warming)";
    return (side === "CE" ? "+DI>-DI" : "-DI>+DI") +
           " (+DI=" + pdiVal.toFixed(1) + " -DI=" + mdiVal.toFixed(1) + ")";
  }

  var _ceAuditChecks = [
    { name: "RSI in CE range", ok: rsi > RSI_CE_MIN && rsi < RSI_CE_MAX,
      detail: "RSI=" + rsi.toFixed(1) + " vs " + RSI_CE_MIN + "-" + RSI_CE_MAX },
    { name: "ADX trending", ok: !ADX_ENABLED || isTrending,
      detail: ADX_ENABLED ? ("ADX=" + (adxVal !== null ? adxVal.toFixed(1) : "n/a") + " vs >=" + ADX_MIN) : "ADX off" },
    { name: "ADX rising", ok: _risingPass, detail: _risingDetailStr },
    { name: "ADX directional", ok: _diCePass, detail: _diDetailStr("CE") },
    { name: "Near support", ok: supportCheck.near,
      detail: supportCheck.near
        ? ("support=" + supportCheck.level.toFixed(0))
        : ("no swing low within " + SR_ZONE_PTS + "pts" + (_nearLowDist !== null ? " (nearest " + _nearLowDist.toFixed(0) + "pts)" : "")) },
    { name: "Bullish pattern (enabled)", ok: _bullEnabled.length > 0,
      detail: _patternDetail(_bullEnabled, _bullDisabled, "Engulf/Hammer/BOS/IB/DblBot/AscTri") },
  ];
  var _peAuditChecks = [
    { name: "RSI in PE range", ok: rsi > RSI_PE_MIN && rsi < RSI_PE_MAX,
      detail: "RSI=" + rsi.toFixed(1) + " vs " + RSI_PE_MIN + "-" + RSI_PE_MAX },
    { name: "ADX trending", ok: !ADX_ENABLED || isTrending,
      detail: ADX_ENABLED ? ("ADX=" + (adxVal !== null ? adxVal.toFixed(1) : "n/a") + " vs >=" + ADX_MIN) : "ADX off" },
    { name: "ADX rising", ok: _risingPass, detail: _risingDetailStr },
    { name: "ADX directional", ok: _diPePass, detail: _diDetailStr("PE") },
    { name: "Near resistance", ok: resistanceCheck.near,
      detail: resistanceCheck.near
        ? ("resistance=" + resistanceCheck.level.toFixed(0))
        : ("no swing high within " + SR_ZONE_PTS + "pts" + (_nearHighDist !== null ? " (nearest " + _nearHighDist.toFixed(0) + "pts)" : "")) },
    { name: "Bearish pattern (enabled)", ok: _bearEnabled.length > 0,
      detail: _patternDetail(_bearEnabled, _bearDisabled, "Engulf/ShootStar/BOS/IB/DblTop/DescTri") },
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

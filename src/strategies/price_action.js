/**
 * STRATEGY: PRICE ACTION — MARKET STRUCTURE + ZONES (5-min candles)
 *
 * Pure market structure strategy. NO candlestick patterns.
 * Reads structure (HH/HL/LH/LL), identifies supply/demand zones,
 * and enters on high-probability institutional setups.
 *
 * SIGNALS (priority order):
 *   1. Liquidity Sweep — stop hunt past swing level, same-candle reversal
 *   2. Zone Pullback — pullback into fresh demand/supply zone, trend-aligned
 *   3. Break & Retest — broken zone flips role, enter on retest from new side
 *
 * STRUCTURE:
 *   Fractal swing detection (N candles each side)
 *   HH + HL = Bullish | LH + LL = Bearish
 *
 * ZONES:
 *   Demand = base candle before strong impulse UP from swing low
 *   Supply = base candle before strong impulse DOWN from swing high
 *   Fresh zones only (tested <= max)
 *
 * EXIT:
 *   SL = below/above the zone (structure-based)
 *   Target = next opposing zone or swing level
 *   Trail = tiered % of peak profit
 *
 * Timeframe: 5-min | Window: 9:20 AM – 2:30 PM IST
 */

const { RSI, EMA } = require("technicalindicators");

const NAME        = "PA_STRUCTURE_ZONES";
const DESCRIPTION = "5-min | Structure + Supply/Demand Zones + Liquidity Sweep + Break & Retest";

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

// ── Fractal Swing Detection ──────────────────────────────────────────────────
// A swing high: candle[i].high > all N candles before AND after
// A swing low:  candle[i].low  < all N candles before AND after
function findSwingPoints(candles, lookback, fractalN) {
  fractalN = fractalN || 2;
  var swingHighs = [];
  var swingLows  = [];
  var start = Math.max(fractalN, candles.length - lookback);
  var end   = candles.length - fractalN;

  for (var i = start; i < end; i++) {
    var isHigh = true;
    var isLow  = true;
    for (var j = 1; j <= fractalN; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low  >= candles[i - j].low  || candles[i].low  >= candles[i + j].low)  isLow  = false;
    }
    if (isHigh) swingHighs.push({ price: candles[i].high, index: i, time: candles[i].time });
    if (isLow)  swingLows.push({ price: candles[i].low,  index: i, time: candles[i].time });
  }
  return { swingHighs, swingLows };
}

// ── Market Structure Detection ───────────────────────────────────────────────
// Labels: HH (higher high), HL (higher low), LH (lower high), LL (lower low)
function detectStructure(swingHighs, swingLows) {
  var result = { trend: "RANGING", lastHighLabel: null, lastLowLabel: null };

  if (swingHighs.length >= 2) {
    var last = swingHighs[swingHighs.length - 1].price;
    var prev = swingHighs[swingHighs.length - 2].price;
    result.lastHighLabel = last > prev ? "HH" : "LH";
  }
  if (swingLows.length >= 2) {
    var last = swingLows[swingLows.length - 1].price;
    var prev = swingLows[swingLows.length - 2].price;
    result.lastLowLabel = last > prev ? "HL" : "LL";
  }

  // Both confirm → strong trend; one confirms → weak trend
  if (result.lastHighLabel === "HH" && result.lastLowLabel === "HL") result.trend = "BULLISH";
  else if (result.lastHighLabel === "LH" && result.lastLowLabel === "LL") result.trend = "BEARISH";
  else if (result.lastHighLabel === "HH" || result.lastLowLabel === "HL") result.trend = "BULLISH";
  else if (result.lastHighLabel === "LH" || result.lastLowLabel === "LL") result.trend = "BEARISH";

  return result;
}

// ── Supply/Demand Zone Detection ─────────────────────────────────────────────
// Demand zone: base candle at swing low + strong impulse UP after it
// Supply zone: base candle at swing high + strong impulse DOWN after it
function findZones(candles, swingPoints, type, minImpulse) {
  var zones = [];
  for (var i = 0; i < swingPoints.length; i++) {
    var idx = swingPoints[i].index;
    if (idx + 3 >= candles.length) continue;

    var base = candles[idx];
    var impulse = 0;

    // Measure impulse: how far price moved away from zone in next 5 candles
    for (var j = 1; j <= 5 && idx + j < candles.length; j++) {
      var move;
      if (type === "DEMAND") {
        move = candles[idx + j].close - base.low;
      } else {
        move = base.high - candles[idx + j].close;
      }
      if (move > impulse) impulse = move;
    }

    if (impulse < minImpulse) continue;

    // Zone boundaries: body of base candle defines the zone
    var top, bottom;
    if (type === "DEMAND") {
      top    = Math.max(base.open, base.close);
      bottom = base.low;
    } else {
      top    = base.high;
      bottom = Math.min(base.open, base.close);
    }

    // Count times zone has been tested after formation
    var tested = 0;
    for (var j = idx + 3; j < candles.length - 1; j++) {
      if (type === "DEMAND" && candles[j].low <= top && candles[j].close > bottom) tested++;
      if (type === "SUPPLY" && candles[j].high >= bottom && candles[j].close < top) tested++;
    }

    zones.push({
      type: type,
      top: top,
      bottom: bottom,
      impulse: impulse,
      time: base.time,
      index: idx,
      tested: tested,
    });
  }
  return zones;
}

// ── Indicator cache ──────────────────────────────────────────────────────────
var _indicatorCache = { key: null, rsi: null, ema: null };

function _makeKey(candles) {
  if (candles.length < 3) return null;
  var a = candles[candles.length - 2];
  var b = candles[candles.length - 1];
  return "" + a.time + "_" + a.close + "_" + b.time + "_" + b.close + "_" + candles.length;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN SIGNAL FUNCTION
// ══════════════════════════════════════════════════════════════════════════════
function getSignal(candles, opts) {
  opts = opts || {};
  var silent = opts.silent === true;

  // ── Config ──
  var RSI_PERIOD     = parseInt(cfg("PA_RSI_PERIOD", "14"), 10);
  var RSI_CE_MIN     = parseFloat(cfg("PA_RSI_CE_MIN", "45"));
  var RSI_PE_MAX     = parseFloat(cfg("PA_RSI_PE_MAX", "55"));
  var RSI_CAPS_ON    = cfg("PA_RSI_CAPS_ENABLED", "false") === "true";
  var RSI_CE_MAX     = RSI_CAPS_ON ? parseFloat(cfg("PA_RSI_CE_MAX", "85")) : 999;
  var RSI_PE_MIN     = RSI_CAPS_ON ? parseFloat(cfg("PA_RSI_PE_MIN", "15")) : -999;
  var SR_LOOKBACK    = parseInt(cfg("PA_SR_LOOKBACK", "30"), 10);
  var FRACTAL_N      = parseInt(cfg("PA_FRACTAL_N", "2"), 10);
  var ZONE_MIN_IMPULSE = parseFloat(cfg("PA_ZONE_MIN_IMPULSE", "15"));
  var ZONE_MAX_TESTS = parseInt(cfg("PA_ZONE_MAX_TESTS", "2"), 10);
  var SWEEP_MAX_PTS  = parseFloat(cfg("PA_SWEEP_MAX_PTS", "20"));
  var SWEEP_MIN_RECOVERY = parseFloat(cfg("PA_SWEEP_MIN_RECOVERY", "5")); // close must be X pts past swing after sweep
  var ZONE_BOUNCE_MIN = parseFloat(cfg("PA_ZONE_BOUNCE_MIN", "5"));       // close must be X pts above/below zone edge
  var MAX_SL_PTS     = parseFloat(cfg("PA_MAX_SL_PTS", "25"));
  var MIN_SL_PTS     = parseFloat(cfg("PA_MIN_SL_PTS", "8"));
  var MIN_RR         = parseFloat(cfg("PA_MIN_RR", "0"));
  var EMA_TREND_ENABLED = cfg("PA_EMA_TREND_ENABLED", "false") === "true";
  var EMA_PERIOD     = parseInt(cfg("PA_EMA_PERIOD", "20"), 10);
  var ADX_ENABLED    = cfg("PA_ADX_ENABLED", "false") === "true"; // kept for compat
  var ADX_MIN        = parseFloat(cfg("PA_ADX_MIN", "20"));
  var BR_MAX_AGE     = 20; // max candles between break and retest

  var base = {
    signal: "NONE", reason: "", stopLoss: null, target: null,
    rsi: null, pattern: null, srLevel: null,
    swingHighs: [], swingLows: [],
    signalStrength: null,
    ema: null, structure: null,
    trendUp: true, trendDown: true,
    adx: null, isTrending: true,
  };

  // Warm-up: need enough candles for fractal swings + RSI
  var minCandles = Math.max(RSI_PERIOD + 2, FRACTAL_N * 4 + 5, 20);
  if (candles.length < minCandles) {
    base.reason = "Warming up (" + candles.length + "/" + minCandles + ")";
    return base;
  }

  var sc   = candles[candles.length - 1];
  var prev = candles[candles.length - 2];

  // Trading window check
  if (!opts.skipTimeCheck) {
    var wc = isInTradingWindow(sc.time);
    if (!wc.ok) { base.reason = wc.reason; return base; }
  }

  // ── RSI + EMA ──────────────────────────────────────────────────────────────
  var cacheKey = _makeKey(candles);
  var rsi, emaVal = null;
  var closes = candles.map(function(c) { return c.close; });

  if (cacheKey && _indicatorCache.key === cacheKey && _indicatorCache.rsi !== null) {
    rsi    = _indicatorCache.rsi;
    emaVal = _indicatorCache.ema;
  } else {
    var rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
    if (rsiArr.length < 1) { base.reason = "RSI warming up"; return base; }
    rsi = rsiArr[rsiArr.length - 1];

    if (EMA_TREND_ENABLED) {
      var emaArr = EMA.calculate({ period: EMA_PERIOD, values: closes });
      emaVal = emaArr.length > 0 ? emaArr[emaArr.length - 1] : null;
    }
    _indicatorCache = { key: cacheKey, rsi: rsi, ema: emaVal };
  }

  base.rsi = parseFloat(rsi.toFixed(1));
  base.ema = emaVal !== null ? parseFloat(emaVal.toFixed(2)) : null;

  // EMA trend direction (for zone pullback filtering)
  var emaTrendUp   = true;
  var emaTrendDown = true;
  if (EMA_TREND_ENABLED && emaVal !== null) {
    emaTrendUp   = sc.close > emaVal;
    emaTrendDown = sc.close < emaVal;
  }
  base.trendUp   = emaTrendUp;
  base.trendDown = emaTrendDown;

  // ── Swing Points & Structure ───────────────────────────────────────────────
  var swings = findSwingPoints(candles, SR_LOOKBACK, FRACTAL_N);
  base.swingHighs = swings.swingHighs.slice(-3).map(function(s) { return s.price; });
  base.swingLows  = swings.swingLows.slice(-3).map(function(s) { return s.price; });

  var structure = detectStructure(swings.swingHighs, swings.swingLows);
  base.structure = structure.trend;

  if (swings.swingHighs.length < 2 && swings.swingLows.length < 2) {
    base.reason = "Insufficient swing points for structure";
    return base;
  }

  // ── Zones ──────────────────────────────────────────────────────────────────
  var demandZones = findZones(candles, swings.swingLows,  "DEMAND", ZONE_MIN_IMPULSE);
  var supplyZones = findZones(candles, swings.swingHighs, "SUPPLY", ZONE_MIN_IMPULSE);

  var freshDemand = demandZones.filter(function(z) { return z.tested <= ZONE_MAX_TESTS; });
  var freshSupply = supplyZones.filter(function(z) { return z.tested <= ZONE_MAX_TESTS; });

  var _ist = "";
  if (!silent) {
    _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  }

  // ── Helper: find target at opposing zone/swing & check R:R ─────────────────
  function _findTarget(side, entryPrice, slPts) {
    var target = null;
    if (side === "CE") {
      // Target = nearest supply zone bottom or swing high above entry
      for (var i = 0; i < freshSupply.length; i++) {
        var lvl = freshSupply[i].bottom;
        if (lvl > entryPrice + 5) {
          if (target === null || lvl < target) target = lvl;
        }
      }
      for (var i = 0; i < swings.swingHighs.length; i++) {
        var lvl = swings.swingHighs[i].price;
        if (lvl > entryPrice + 5) {
          if (target === null || lvl < target) target = lvl;
        }
      }
    } else {
      // Target = nearest demand zone top or swing low below entry
      for (var i = 0; i < freshDemand.length; i++) {
        var lvl = freshDemand[i].top;
        if (lvl < entryPrice - 5) {
          if (target === null || lvl > target) target = lvl;
        }
      }
      for (var i = 0; i < swings.swingLows.length; i++) {
        var lvl = swings.swingLows[i].price;
        if (lvl < entryPrice - 5) {
          if (target === null || lvl > target) target = lvl;
        }
      }
    }

    if (MIN_RR > 0 && target !== null && slPts > 0) {
      var reward = Math.abs(target - entryPrice);
      if (reward / slPts < MIN_RR) return { target: target, rrOk: false, rr: parseFloat((reward / slPts).toFixed(2)) };
      return { target: target, rrOk: true, rr: parseFloat((reward / slPts).toFixed(2)) };
    }
    return { target: target, rrOk: true, rr: null };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SIGNAL 1: LIQUIDITY SWEEP (highest priority)
  // Price sweeps past swing level and reverses on the same candle = stop hunt
  // NO structure or EMA requirement — sweep IS the signal
  // ══════════════════════════════════════════════════════════════════════════

  // CE: Price sweeps below swing low, closes back above (bears trapped)
  for (var i = swings.swingLows.length - 1; i >= Math.max(0, swings.swingLows.length - 4); i--) {
    var swLow = swings.swingLows[i].price;
    var _recovery = sc.close - swLow; // how far above swing did it close?
    // Wick ratio: lower wick should dominate (rejection proof)
    var _range = sc.high - sc.low;
    var _lowerWick = Math.min(sc.open, sc.close) - sc.low;
    var _wickRatio = _range > 0 ? _lowerWick / _range : 0;
    if (sc.low < swLow && sc.close > swLow && _recovery >= SWEEP_MIN_RECOVERY && _wickRatio >= 0.5 && rsi > 25) {
      var sweepPts = swLow - sc.low;
      if (sweepPts > 0 && sweepPts <= SWEEP_MAX_PTS) {
        var rawSL = sc.low;
        var slPts = Math.max(Math.min(sc.close - rawSL, MAX_SL_PTS), MIN_SL_PTS);
        var sl = parseFloat((sc.close - slPts).toFixed(2));
        var tgt = _findTarget("CE", sc.close, slPts);

        if (tgt.rrOk) {
          if (!silent) console.log("[PA " + _ist + "] CE Liquidity Sweep below " + swLow.toFixed(0) + " (" + sweepPts.toFixed(1) + "pts) RSI=" + rsi.toFixed(1) + " SL=" + sl + (tgt.target ? " TGT=" + tgt.target.toFixed(0) + " RR=" + tgt.rr : ""));
          return Object.assign({}, base, {
            signal: "BUY_CE", signalStrength: "STRONG",
            pattern: "Liquidity Sweep",
            stopLoss: sl, slSource: "Sweep Low",
            srLevel: swLow,
            target: tgt.target,
            reason: "CE: Sweep below " + swLow.toFixed(0) + " (" + sweepPts.toFixed(1) + "pts) → reversed | RSI=" + rsi.toFixed(0) + " | SL=" + sl + (tgt.target ? " | TGT=" + tgt.target.toFixed(0) : ""),
          });
        } else if (!silent) {
          console.log("[PA " + _ist + "] CE Sweep SKIPPED: R:R=" + tgt.rr + " < " + MIN_RR);
        }
      }
    }
  }

  // PE: Price sweeps above swing high, closes back below (bulls trapped)
  for (var i = swings.swingHighs.length - 1; i >= Math.max(0, swings.swingHighs.length - 4); i--) {
    var swHigh = swings.swingHighs[i].price;
    var _recovery = swHigh - sc.close; // how far below swing did it close?
    var _range = sc.high - sc.low;
    var _upperWick = sc.high - Math.max(sc.open, sc.close);
    var _wickRatio = _range > 0 ? _upperWick / _range : 0;
    if (sc.high > swHigh && sc.close < swHigh && _recovery >= SWEEP_MIN_RECOVERY && _wickRatio >= 0.5 && rsi < 75) {
      var sweepPts = sc.high - swHigh;
      if (sweepPts > 0 && sweepPts <= SWEEP_MAX_PTS) {
        var rawSL = sc.high;
        var slPts = Math.max(Math.min(rawSL - sc.close, MAX_SL_PTS), MIN_SL_PTS);
        var sl = parseFloat((sc.close + slPts).toFixed(2));
        var tgt = _findTarget("PE", sc.close, slPts);

        if (tgt.rrOk) {
          if (!silent) console.log("[PA " + _ist + "] PE Liquidity Sweep above " + swHigh.toFixed(0) + " (" + sweepPts.toFixed(1) + "pts) RSI=" + rsi.toFixed(1) + " SL=" + sl + (tgt.target ? " TGT=" + tgt.target.toFixed(0) + " RR=" + tgt.rr : ""));
          return Object.assign({}, base, {
            signal: "BUY_PE", signalStrength: "STRONG",
            pattern: "Liquidity Sweep",
            stopLoss: sl, slSource: "Sweep High",
            srLevel: swHigh,
            target: tgt.target,
            reason: "PE: Sweep above " + swHigh.toFixed(0) + " (" + sweepPts.toFixed(1) + "pts) → reversed | RSI=" + rsi.toFixed(0) + " | SL=" + sl + (tgt.target ? " | TGT=" + tgt.target.toFixed(0) : ""),
          });
        } else if (!silent) {
          console.log("[PA " + _ist + "] PE Sweep SKIPPED: R:R=" + tgt.rr + " < " + MIN_RR);
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SIGNAL 2: ZONE PULLBACK
  // Price pulls back into a fresh demand/supply zone and bounces
  // Requires trend confirmation (structure + optional EMA)
  // ══════════════════════════════════════════════════════════════════════════

  // CE: Pullback to demand zone in bullish structure
  if (structure.trend === "BULLISH" && emaTrendUp && rsi > RSI_CE_MIN && rsi < RSI_CE_MAX) {
    for (var i = freshDemand.length - 1; i >= 0; i--) {
      var zone = freshDemand[i];
      // Price low touched/entered demand zone AND closed well above zone top = strong bounce
      if (sc.low <= zone.top && sc.close > zone.top + ZONE_BOUNCE_MIN) {
        var rawSL = zone.bottom;
        var slPts = Math.max(Math.min(sc.close - rawSL, MAX_SL_PTS), MIN_SL_PTS);
        var sl = parseFloat((sc.close - slPts).toFixed(2));
        var tgt = _findTarget("CE", sc.close, slPts);

        if (tgt.rrOk) {
          if (!silent) console.log("[PA " + _ist + "] CE Zone Pullback: demand " + zone.bottom.toFixed(0) + "-" + zone.top.toFixed(0) + " impulse=" + zone.impulse.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl + (tgt.target ? " TGT=" + tgt.target.toFixed(0) + " RR=" + tgt.rr : ""));
          return Object.assign({}, base, {
            signal: "BUY_CE", signalStrength: "STRONG",
            pattern: "Zone Pullback",
            stopLoss: sl, slSource: "Below Demand Zone",
            srLevel: zone.top,
            target: tgt.target,
            reason: "CE: Pullback to demand " + zone.bottom.toFixed(0) + "-" + zone.top.toFixed(0) + " | impulse=" + zone.impulse.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl + (tgt.target ? " | TGT=" + tgt.target.toFixed(0) : ""),
          });
        } else if (!silent) {
          console.log("[PA " + _ist + "] CE Zone Pullback SKIPPED: R:R=" + tgt.rr + " < " + MIN_RR);
        }
        break; // only check most recent zone
      }
    }
  }

  // PE: Pullback to supply zone in bearish structure
  if (structure.trend === "BEARISH" && emaTrendDown && rsi < RSI_PE_MAX && rsi > RSI_PE_MIN) {
    for (var i = freshSupply.length - 1; i >= 0; i--) {
      var zone = freshSupply[i];
      // Price high touched/entered supply zone AND closed well below zone bottom = strong rejection
      if (sc.high >= zone.bottom && sc.close < zone.bottom - ZONE_BOUNCE_MIN) {
        var rawSL = zone.top;
        var slPts = Math.max(Math.min(rawSL - sc.close, MAX_SL_PTS), MIN_SL_PTS);
        var sl = parseFloat((sc.close + slPts).toFixed(2));
        var tgt = _findTarget("PE", sc.close, slPts);

        if (tgt.rrOk) {
          if (!silent) console.log("[PA " + _ist + "] PE Zone Pullback: supply " + zone.bottom.toFixed(0) + "-" + zone.top.toFixed(0) + " impulse=" + zone.impulse.toFixed(0) + " RSI=" + rsi.toFixed(1) + " SL=" + sl + (tgt.target ? " TGT=" + tgt.target.toFixed(0) + " RR=" + tgt.rr : ""));
          return Object.assign({}, base, {
            signal: "BUY_PE", signalStrength: "STRONG",
            pattern: "Zone Pullback",
            stopLoss: sl, slSource: "Above Supply Zone",
            srLevel: zone.bottom,
            target: tgt.target,
            reason: "PE: Pullback to supply " + zone.bottom.toFixed(0) + "-" + zone.top.toFixed(0) + " | impulse=" + zone.impulse.toFixed(0) + " | RSI=" + rsi.toFixed(0) + " | SL=" + sl + (tgt.target ? " | TGT=" + tgt.target.toFixed(0) : ""),
          });
        } else if (!silent) {
          console.log("[PA " + _ist + "] PE Zone Pullback SKIPPED: R:R=" + tgt.rr + " < " + MIN_RR);
        }
        break;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SIGNAL 3: BREAK & RETEST
  // A supply zone broken upward becomes demand → enter CE on retest
  // A demand zone broken downward becomes supply → enter PE on retest
  // No structure requirement — the break itself defines new structure
  // ══════════════════════════════════════════════════════════════════════════

  // CE: Supply zone was broken upward, now retesting as support
  for (var i = supplyZones.length - 1; i >= Math.max(0, supplyZones.length - 5); i--) {
    var zone = supplyZones[i];
    // Was zone broken? Any candle after zone closed solidly above zone.top
    var broken = false;
    var breakIdx = -1;
    for (var j = zone.index + FRACTAL_N + 1; j < candles.length - 1; j++) {
      if (candles[j].close > zone.top + 3) { broken = true; breakIdx = j; break; }
    }
    if (!broken || breakIdx < 0) continue;
    // Must have gap between break and retest (at least 2 candles)
    var age = candles.length - 1 - breakIdx;
    if (age < 2 || age > BR_MAX_AGE) continue;

    // Current candle retests the broken zone from above
    if (sc.low <= zone.top + 5 && sc.low >= zone.bottom - 5 && sc.close > zone.top + ZONE_BOUNCE_MIN && rsi > RSI_CE_MIN && emaTrendUp) {
      var rawSL = zone.bottom;
      var slPts = Math.max(Math.min(sc.close - rawSL, MAX_SL_PTS), MIN_SL_PTS);
      var sl = parseFloat((sc.close - slPts).toFixed(2));
      var tgt = _findTarget("CE", sc.close, slPts);

      if (tgt.rrOk) {
        if (!silent) console.log("[PA " + _ist + "] CE Break & Retest: broken supply " + zone.bottom.toFixed(0) + "-" + zone.top.toFixed(0) + " as support RSI=" + rsi.toFixed(1) + " SL=" + sl + (tgt.target ? " TGT=" + tgt.target.toFixed(0) + " RR=" + tgt.rr : ""));
        return Object.assign({}, base, {
          signal: "BUY_CE", signalStrength: "STRONG",
          pattern: "Break & Retest",
          stopLoss: sl, slSource: "Below Broken Zone",
          srLevel: zone.top,
          target: tgt.target,
          reason: "CE: Broken supply " + zone.bottom.toFixed(0) + "-" + zone.top.toFixed(0) + " retest | RSI=" + rsi.toFixed(0) + " | SL=" + sl + (tgt.target ? " | TGT=" + tgt.target.toFixed(0) : ""),
        });
      } else if (!silent) {
        console.log("[PA " + _ist + "] CE B&R SKIPPED: R:R=" + tgt.rr + " < " + MIN_RR);
      }
      break;
    }
  }

  // PE: Demand zone was broken downward, now retesting as resistance
  for (var i = demandZones.length - 1; i >= Math.max(0, demandZones.length - 5); i--) {
    var zone = demandZones[i];
    var broken = false;
    var breakIdx = -1;
    for (var j = zone.index + FRACTAL_N + 1; j < candles.length - 1; j++) {
      if (candles[j].close < zone.bottom - 3) { broken = true; breakIdx = j; break; }
    }
    if (!broken || breakIdx < 0) continue;
    var age = candles.length - 1 - breakIdx;
    if (age < 2 || age > BR_MAX_AGE) continue;

    if (sc.high >= zone.bottom - 5 && sc.high <= zone.top + 5 && sc.close < zone.bottom - ZONE_BOUNCE_MIN && rsi < RSI_PE_MAX && emaTrendDown) {
      var rawSL = zone.top;
      var slPts = Math.max(Math.min(rawSL - sc.close, MAX_SL_PTS), MIN_SL_PTS);
      var sl = parseFloat((sc.close + slPts).toFixed(2));
      var tgt = _findTarget("PE", sc.close, slPts);

      if (tgt.rrOk) {
        if (!silent) console.log("[PA " + _ist + "] PE Break & Retest: broken demand " + zone.bottom.toFixed(0) + "-" + zone.top.toFixed(0) + " as resistance RSI=" + rsi.toFixed(1) + " SL=" + sl + (tgt.target ? " TGT=" + tgt.target.toFixed(0) + " RR=" + tgt.rr : ""));
        return Object.assign({}, base, {
          signal: "BUY_PE", signalStrength: "STRONG",
          pattern: "Break & Retest",
          stopLoss: sl, slSource: "Above Broken Zone",
          srLevel: zone.bottom,
          target: tgt.target,
          reason: "PE: Broken demand " + zone.bottom.toFixed(0) + "-" + zone.top.toFixed(0) + " retest | RSI=" + rsi.toFixed(0) + " | SL=" + sl + (tgt.target ? " | TGT=" + tgt.target.toFixed(0) : ""),
        });
      } else if (!silent) {
        console.log("[PA " + _ist + "] PE B&R SKIPPED: R:R=" + tgt.rr + " < " + MIN_RR);
      }
      break;
    }
  }

  // ── No signal — build reason ───────────────────────────────────────────────
  var parts = [];
  parts.push(structure.trend + " " + (structure.lastHighLabel || "-") + "/" + (structure.lastLowLabel || "-"));
  if (freshDemand.length === 0 && freshSupply.length === 0) parts.push("No fresh zones");
  else parts.push("D:" + freshDemand.length + " S:" + freshSupply.length + " zones");
  if (EMA_TREND_ENABLED && emaVal !== null) parts.push("EMA=" + emaVal.toFixed(0) + (sc.close > emaVal ? "↑" : "↓"));
  parts.push("RSI=" + rsi.toFixed(0));

  base.reason = "No setup (" + parts.join("; ") + ")";
  return base;
}

// ── Trailing SL: Swing structure based ───────────────────────────────────────
function updateTrailingSL(candles, currentSL, side, opts) {
  var SR_LOOKBACK = parseInt(cfg("PA_SR_LOOKBACK", "30"), 10);
  var FRACTAL_N   = parseInt(cfg("PA_FRACTAL_N", "2"), 10);
  var swings = findSwingPoints(candles, SR_LOOKBACK, FRACTAL_N);

  if (side === "CE" && swings.swingLows.length > 0) {
    var lastSwingLow = swings.swingLows[swings.swingLows.length - 1].price;
    var close = candles[candles.length - 1].close;
    if (lastSwingLow > currentSL && lastSwingLow < close) {
      return { sl: parseFloat(lastSwingLow.toFixed(2)), source: "Swing Low" };
    }
  }
  if (side === "PE" && swings.swingHighs.length > 0) {
    var lastSwingHigh = swings.swingHighs[swings.swingHighs.length - 1].price;
    var close = candles[candles.length - 1].close;
    if (lastSwingHigh < currentSL && lastSwingHigh > close) {
      return { sl: parseFloat(lastSwingHigh.toFixed(2)), source: "Swing High" };
    }
  }

  return { sl: currentSL, source: null };
}

function reset() {
  _indicatorCache = { key: null, rsi: null, ema: null };
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

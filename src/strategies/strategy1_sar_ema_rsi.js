/**
 * STRATEGY: SAR_EMA21_RSI  (SWING — redefined 2026-05-27)
 *
 * A deliberately simple, chart-driven rule set. Replaces the old EMA9-touch /
 * 3-logic-path / ADX / body / SAR-distance / STRONG-MARGINAL system.
 *
 * Indicators: EMA21 (OHLC4) · RSI(14) · Parabolic SAR (0.02 / 0.2).
 *
 * ENTRY — BUY_CE (bullish), ALL must be true (evaluated every tick while flat):
 *   1. RSI(14)  >  RSI_CE_MIN (default 52)
 *   2. Price at or ABOVE EMA21 — fires whether the candle is already above EMA21
 *      OR is currently crossing up through it  →  signalCandle.high >= ema21
 *   3. SAR below the candle  →  SAR.trend === 1 (dots below price)
 *
 * ENTRY — BUY_PE (bearish), mirror:
 *   1. RSI(14)  <  RSI_PE_MAX (default 48)
 *   2. Price at or BELOW EMA21  →  signalCandle.low <= ema21
 *   3. SAR above the candle  →  SAR.trend === -1 (dots above price)
 *
 * STOP LOSS (set by the execution layer, value seeded here):
 *   CE: previous (last completed) candle LOW
 *   PE: previous (last completed) candle HIGH
 *   The execution layer trails this candle-by-candle (tighten-only) and adds
 *   breakeven, option-stop-%, opposite-signal and EOD exits.
 *
 * Timeframe: 5-min or 15-min (TRADE_RESOLUTION) · EMA on OHLC4 · window 09:30–14:00 IST.
 */

const { EMA, RSI } = require("technicalindicators");
const { computeSuperTrend } = require("../utils/supertrend");

const NAME        = "SAR_EMA21_RSI";
const DESCRIPTION = "SWING | EMA21(OHLC4) + RSI + SAR | price vs EMA21 + RSI gate + SAR side | prev-candle trailing SL | thresholds via Settings";

// ── Parabolic SAR (step=0.02, max=0.2) ───────────────────────────────────────
// trend=1  → uptrend,   SAR dots BELOW price
// trend=-1 → downtrend, SAR dots ABOVE price
function calcSAR(candles, step, max) {
  step = step || 0.02;
  max  = max  || 0.2;
  if (candles.length < 3) return [];

  var result = [];
  var trend  = 1;
  var sar    = candles[0].low;
  var ep     = candles[0].high;
  var af     = step;

  for (var i = 1; i < candles.length; i++) {
    var prev   = candles[i - 1];
    var curr   = candles[i];
    var newSar = sar + af * (ep - sar);

    if (trend === 1) {
      newSar = Math.min(newSar, prev.low, i >= 2 ? candles[i - 2].low : prev.low);
      if (curr.low < newSar) {
        trend = -1; newSar = ep; ep = curr.low; af = step;
      } else {
        if (curr.high > ep) { ep = curr.high; af = Math.min(af + step, max); }
      }
    } else {
      newSar = Math.max(newSar, prev.high, i >= 2 ? candles[i - 2].high : prev.high);
      if (curr.high > newSar) {
        trend = 1; newSar = ep; ep = curr.high; af = step;
      } else {
        if (curr.low < ep) { ep = curr.low; af = Math.min(af + step, max); }
      }
    }
    sar = newSar;
    result.push({ sar: Math.round(sar * 100) / 100, trend: trend });
  }
  return result;
}

// ── Trading window ────────────────────────────────────────────────────────
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
  // Fast IST conversion: UTC+5:30 = +19800 seconds (avoids expensive toLocaleString/ICU)
  var istSec   = unixSec + 19800;
  var totalMin = Math.floor(istSec / 60) % 1440;
  var startMin = _parseMins("TRADE_ENTRY_START", "09:30");
  var endMin   = _parseMins("TRADE_ENTRY_END",   "14:00");
  if (totalMin < startMin) return { ok: false, reason: "Before " + _fmtTime(startMin) + " — waiting for indicators to stabilise" };
  if (totalMin >= endMin)  return { ok: false, reason: "After " + _fmtTime(endMin) + " — no new entries (EOD risk)" };
  return { ok: true, reason: null };
}

/**
 * getSignal(candles, opts)
 *
 * candles: ascending array of { time, open, high, low, close }.
 * The LAST element is the signal candle (the forming bar during intra-candle
 * evaluation, or the just-closed candle at candle close).
 *
 * Returns { signal: "BUY_CE"|"BUY_PE"|"NONE", reason, stopLoss, prevCandleLow,
 *           prevCandleHigh, rsi, ema21, sar, sarTrend, signalStrength }.
 * signalStrength is always "STRONG" — there is no strength tier any more, but the
 * field is kept so the VIX gate's call shape (which only hard-blocks > VIX_MAX_ENTRY)
 * is unchanged.
 */
function getSignal(candles, opts) {
  var silent = (opts && opts.silent === true);

  // Warm-up: EMA21 + RSI(14) + SAR need a stable history. 30 candles is comfortable.
  if (candles.length < 30) {
    return {
      signal: "NONE",
      reason: "Warming up (" + candles.length + "/30 candles)",
      stopLoss: null,
      prevCandleHigh: null,
      prevCandleLow:  null,
    };
  }

  var signalCandle = candles[candles.length - 1];
  var prevCandle   = candles[candles.length - 2];

  // skipTimeCheck: bypass the entry window. Used only by at-exit indicator
  // snapshots (so EOD/after-window exits still log indicator values) — never
  // by the live entry path, which always enforces the window.
  var skipTimeCheck = (opts && opts.skipTimeCheck === true);
  var windowCheck = skipTimeCheck ? { ok: true, reason: null } : isInTradingWindow(signalCandle.time);
  if (!windowCheck.ok) {
    return {
      signal: "NONE",
      reason: windowCheck.reason,
      stopLoss: null,
      prevCandleHigh: signalCandle.high,
      prevCandleLow:  signalCandle.low,
    };
  }

  // ── Indicators ──────────────────────────────────────────────────────────────
  var ohlc4  = candles.map(function(c) { return (c.open + c.high + c.low + c.close) / 4; });
  var closes = candles.map(function(c) { return c.close; });

  var ema21arr = EMA.calculate({ period: 21, values: ohlc4 });
  var ema21    = ema21arr.length > 0 ? ema21arr[ema21arr.length - 1] : null;

  var rsiArr = RSI.calculate({ period: 14, values: closes });
  var rsi    = rsiArr[rsiArr.length - 1];

  var sarArr  = calcSAR(candles);
  var currSAR = sarArr[sarArr.length - 1];  // SAR after this candle

  // ── Trend-confirmation source: PSAR (default) or SuperTrend(10,3) ──────────
  // Mutually exclusive — exactly one drives the directional confirmation.
  // SWING_USE_SUPERTREND=true swaps SAR's "which side is the trend on?" role for
  // SuperTrend's. The SL seed (prev-candle low/high) is unchanged either way.
  var USE_SUPERTREND = (process.env.SWING_USE_SUPERTREND || "false").toLowerCase() === "true";
  var ST_PERIOD = parseInt(process.env.SWING_SUPERTREND_PERIOD || "10", 10) || 10;
  var ST_MULT   = parseFloat(process.env.SWING_SUPERTREND_MULT || "3") || 3;
  var currST = null;
  if (USE_SUPERTREND) {
    var stArr = computeSuperTrend(candles, ST_PERIOD, ST_MULT);
    currST = stArr[stArr.length - 1];
  }

  if (ema21 === null || !currSAR || rsi === undefined || (USE_SUPERTREND && (!currST || currST.trend == null))) {
    return {
      signal: "NONE",
      reason: "Indicators not ready",
      stopLoss: null,
      prevCandleHigh: signalCandle.high,
      prevCandleLow:  signalCandle.low,
    };
  }

  var RSI_CE_MIN = parseFloat(process.env.RSI_CE_MIN || "52");  // bullish momentum threshold (CE needs RSI above this)
  var RSI_PE_MAX = parseFloat(process.env.RSI_PE_MAX || "48");  // bearish momentum threshold (PE needs RSI below this)
  // Overbought / oversold guards — block chasing exhausted moves.
  // CE blocked when RSI >= RSI_CE_MAX (overbought). PE blocked when RSI <= RSI_PE_MIN (oversold).
  var RSI_CE_MAX = parseFloat(process.env.RSI_CE_MAX || "80");  // CE overbought cap
  var RSI_PE_MIN = parseFloat(process.env.RSI_PE_MIN || "20");  // PE oversold floor

  // ── The three conditions per side ─────────────────────────────────────────
  // CE: price at/above EMA21 (already above OR crossing up) — signalCandle.high reaches the line.
  // PE: price at/below EMA21 (already below OR crossing down) — signalCandle.low reaches the line.
  var priceAboveEma = signalCandle.high >= ema21;
  var priceBelowEma = signalCandle.low  <= ema21;
  // Directional confirmation comes from whichever trend source is active.
  // PSAR: trend===1 → dots below price (CE) / ===-1 → dots above (PE).
  // SuperTrend: trend===1 → line below price (CE) / ===-1 → line above (PE).
  var trendUp   = USE_SUPERTREND ? (currST.trend === 1)  : (currSAR.trend === 1);
  var trendDown = USE_SUPERTREND ? (currST.trend === -1) : (currSAR.trend === -1);
  var _srcLabel = USE_SUPERTREND ? "ST" : "SAR";        // active trend source label for logs
  var _srcVal   = USE_SUPERTREND ? currST.value : currSAR.sar;
  var sarBelow      = trendUp;   // supports CE
  var sarAbove      = trendDown; // supports PE
  var rsiCE         = rsi > RSI_CE_MIN && rsi < RSI_CE_MAX;  // above momentum floor, below overbought cap
  var rsiPE         = rsi < RSI_PE_MAX && rsi > RSI_PE_MIN;  // below momentum cap, above oversold floor

  // ── EMA21-cross requirement (optional, off by default) ───────────────────
  // When SWING_ENTRY_REQUIRE_CROSS=true, an entry is allowed only if the signal
  // candle — or any of the last SWING_ENTRY_CROSS_TOLERANCE prior candles —
  // had its range straddle its own EMA21 (low <= ema21 <= high). This blocks
  // entries where price has already drifted far past EMA21.
  var REQUIRE_CROSS   = (process.env.SWING_ENTRY_REQUIRE_CROSS || "false").toLowerCase() === "true";
  var CROSS_TOLERANCE = Math.max(0, parseInt(process.env.SWING_ENTRY_CROSS_TOLERANCE || "0", 10) || 0);
  var crossOk = !REQUIRE_CROSS || (function () {
    // ema21arr[k] aligns with candles[k + 20] (EMA needs 21 prior values).
    var lastIdx  = candles.length - 1;
    var firstIdx = Math.max(0, lastIdx - CROSS_TOLERANCE);
    for (var i = lastIdx; i >= firstIdx; i--) {
      var emaIdx = i - 20;
      if (emaIdx < 0) continue;
      var e = ema21arr[emaIdx];
      if (candles[i].low <= e && candles[i].high >= e) return true;
    }
    return false;
  })();

  var base = {
    ema21:          Math.round(ema21 * 100) / 100,
    rsi:            Math.round(rsi * 10) / 10,
    sar:            currSAR.sar,
    sarTrend:       currSAR.trend === 1 ? "BULLISH" : "BEARISH",
    sarTrendInt:    currSAR.trend,
    // SuperTrend (populated only when SWING_USE_SUPERTREND is on; the active source)
    supertrend:     currST ? currST.value : null,
    stTrend:        currST ? (currST.trend === 1 ? "BULLISH" : "BEARISH") : null,
    stTrendInt:     currST ? currST.trend : null,
    trendSource:    USE_SUPERTREND ? "SUPERTREND" : "PSAR",
    prevCandleHigh: prevCandle.high,
    prevCandleLow:  prevCandle.low,
    // SL seed: previous (last completed) candle low (CE) / high (PE).
    // Set below once the side is known; null here for NONE.
    stopLoss:       null,
    signalStrength: "STRONG",
  };

  var _istTime = new Date(signalCandle.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  var _trendStr = USE_SUPERTREND
    ? "ST=" + currST.value + "(" + (currST.trend === 1 ? "BULL" : "BEAR") + ")"
    : "SAR=" + currSAR.sar + "(" + (currSAR.trend === 1 ? "BULL" : "BEAR") + ")";
  if (!silent) console.log(
    "[STRAT " + _istTime + "] EMA21=" + ema21.toFixed(1) +
    " | RSI=" + rsi.toFixed(1) +
    " | " + _trendStr +
    " | C=" + signalCandle.close + " H=" + signalCandle.high + " L=" + signalCandle.low
  );

  // ── BUY CE ────────────────────────────────────────────────────────────────
  if (rsiCE && priceAboveEma && sarBelow) {
    if (!crossOk) {
      if (!silent) console.log("  ⛔ BUY_CE blocked — no EMA21 cross within last " + (CROSS_TOLERANCE + 1) + " candle(s)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "CE blocked: no EMA21 cross within last " + (CROSS_TOLERANCE + 1) + " candle(s) (SWING_ENTRY_REQUIRE_CROSS)",
      });
    }
    var slCE = Math.round(prevCandle.low * 100) / 100;
    if (!silent) console.log("  🟢 BUY_CE — RSI " + rsi.toFixed(1) + ">" + RSI_CE_MIN + " | price>=EMA21 " + ema21.toFixed(1) + " | " + _srcLabel + " below | SL(prevLow)=" + slCE);
    return Object.assign({}, base, {
      signal:   "BUY_CE",
      stopLoss: slCE,
      reason:   "CE: RSI=" + rsi.toFixed(1) + ">" + RSI_CE_MIN + " | price " + signalCandle.high + ">=EMA21 " + ema21.toFixed(1) + " | " + _srcLabel + " below @ " + _srcVal + " | SL=prevLow " + slCE,
    });
  }

  // ── BUY PE ────────────────────────────────────────────────────────────────
  if (rsiPE && priceBelowEma && sarAbove) {
    if (!crossOk) {
      if (!silent) console.log("  ⛔ BUY_PE blocked — no EMA21 cross within last " + (CROSS_TOLERANCE + 1) + " candle(s)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "PE blocked: no EMA21 cross within last " + (CROSS_TOLERANCE + 1) + " candle(s) (SWING_ENTRY_REQUIRE_CROSS)",
      });
    }
    var slPE = Math.round(prevCandle.high * 100) / 100;
    if (!silent) console.log("  🔴 BUY_PE — RSI " + rsi.toFixed(1) + "<" + RSI_PE_MAX + " | price<=EMA21 " + ema21.toFixed(1) + " | " + _srcLabel + " above | SL(prevHigh)=" + slPE);
    return Object.assign({}, base, {
      signal:   "BUY_PE",
      stopLoss: slPE,
      reason:   "PE: RSI=" + rsi.toFixed(1) + "<" + RSI_PE_MAX + " | price " + signalCandle.low + "<=EMA21 " + ema21.toFixed(1) + " | " + _srcLabel + " above @ " + _srcVal + " | SL=prevHigh " + slPE,
    });
  }

  // ── No signal — explain which condition(s) failed ─────────────────────────
  var why = [];
  if (trendUp) {
    // trend bullish → only CE possible; report CE misses
    if (!rsiCE)         why.push("RSI=" + rsi.toFixed(1) + (rsi >= RSI_CE_MAX ? " >=" + RSI_CE_MAX + " (overbought)" : " <=" + RSI_CE_MIN + " (need >)"));
    if (!priceAboveEma) why.push("price " + signalCandle.high + " < EMA21 " + ema21.toFixed(1));
  } else {
    if (!rsiPE)         why.push("RSI=" + rsi.toFixed(1) + (rsi <= RSI_PE_MIN ? " <=" + RSI_PE_MIN + " (oversold)" : " >=" + RSI_PE_MAX + " (need <)"));
    if (!priceBelowEma) why.push("price " + signalCandle.low + " > EMA21 " + ema21.toFixed(1));
  }
  if (why.length === 0) why.push(_srcLabel + " " + (trendUp ? "BULL" : "BEAR") + " but other side conditions unmet");

  return Object.assign({}, base, {
    signal: "NONE",
    reason: why.join(" | ") + " | " + _srcLabel + " " + (trendUp ? "BULL" : "BEAR") + " @ " + _srcVal,
  });
}

module.exports = { NAME: NAME, DESCRIPTION: DESCRIPTION, getSignal: getSignal, calcSAR: calcSAR };

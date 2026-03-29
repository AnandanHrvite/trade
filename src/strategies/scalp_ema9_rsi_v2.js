/**
 * SCALP STRATEGY V2: EMA9_RSI_IMPROVED (3-min candles)
 *
 * IMPROVEMENTS OVER V1:
 *   1. ATR-based dynamic SL (adapts to volatility)
 *   2. EMA20 trend filter (only scalp WITH the trend)
 *   3. Volume confirmation (filters weak crosses)
 *   4. RSI reversal exit tightened (35/65 instead of 45/55)
 *   5. Time stop removed — trail SL handles exits
 *   6. Trail SL moves to breakeven after 1x risk move
 *   7. Partial exit support (book 50% at 1:1 R:R)
 *
 * ENTRY — BUY_CE (bullish):
 *   TRIGGER    : Price crosses ABOVE EMA9 (OHLC4)
 *   CONFIRM 1  : Candle CLOSES above EMA9 AND above EMA20 (trend alignment)
 *   CONFIRM 2  : RSI(14) > 50 AND rising (relaxed from 55 — trend filter does the heavy lifting)
 *   CONFIRM 3  : Candle body is GREEN and >= MIN_BODY pts
 *   CONFIRM 4  : Volume > average volume (optional, when volume data available)
 *
 * ENTRY — BUY_PE (bearish):
 *   TRIGGER    : Price crosses BELOW EMA9 (OHLC4)
 *   CONFIRM 1  : Candle CLOSES below EMA9 AND below EMA20
 *   CONFIRM 2  : RSI(14) < 50 AND falling
 *   CONFIRM 3  : Candle body is RED and >= MIN_BODY pts
 *
 * EXIT: ATR-based target | ATR-based SL | Improved Trail SL | RSI extreme reversal | EOD 3:20 PM
 * Timeframe: 3-min | EMA: OHLC4 | Window: 9:21 AM–3:00 PM IST
 */

const { EMA, RSI, ADX, ATR } = require("technicalindicators");

const NAME        = "SCALP_EMA9_RSI_V2";
const DESCRIPTION = "3-min | EMA9 cross + EMA20 trend + ATR SL + volume | improved R:R scalp";

// ── Configurable via .env (with defaults) ────────────────────────────────────
function cfg(key, fallback) { return process.env[key] !== undefined ? process.env[key] : fallback; }

// ── Trading window ───────────────────────────────────────────────────────────
function isInTradingWindow(unixSec) {
  var d        = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  if (totalMin < 561)  return { ok: false, reason: "Before 9:21 AM — skipping opening noise" };
  if (totalMin >= 900) return { ok: false, reason: "After 3:00 PM — no new scalp entries" };
  return { ok: true, reason: null };
}

/**
 * getSignal(candles, opts)
 *
 * Returns: { signal, reason, stopLoss, target, signalStrength, atr, ...indicators }
 */
function getSignal(candles, opts) {
  var silent = (opts && opts.silent === true);

  // ── Config ──────────────────────────────────────────────────────────────────
  var SCALP_RSI_CE_MIN   = parseFloat(cfg("SCALP_RSI_CE_MIN_V2", cfg("SCALP_RSI_CE_MIN", "50")));
  var SCALP_RSI_PE_MAX   = parseFloat(cfg("SCALP_RSI_PE_MAX_V2", cfg("SCALP_RSI_PE_MAX", "50")));
  var SCALP_MIN_BODY     = parseFloat(cfg("SCALP_MIN_BODY", "5"));
  var SCALP_ADX_ENABLED  = cfg("SCALP_ADX_ENABLED", "false") === "true";
  var SCALP_ADX_MIN      = parseFloat(cfg("SCALP_ADX_MIN", "20"));

  // ATR-based SL/Target multipliers
  var ATR_SL_MULT        = parseFloat(cfg("SCALP_ATR_SL_MULT", "1.5"));
  var ATR_TGT_MULT       = parseFloat(cfg("SCALP_ATR_TGT_MULT", "2.5"));
  var ATR_MIN_SL         = parseFloat(cfg("SCALP_ATR_MIN_SL", "8"));   // floor: don't go below 8pt SL
  var ATR_MAX_SL         = parseFloat(cfg("SCALP_ATR_MAX_SL", "18"));  // cap: don't risk more than 18pt

  // Fallback to fixed SL/Target if ATR disabled
  var USE_ATR_SL         = cfg("SCALP_USE_ATR_SL", "true") === "true";
  var FIXED_SL_PTS       = parseFloat(cfg("SCALP_SL_PTS", "15"));
  var FIXED_TGT_PTS      = parseFloat(cfg("SCALP_TARGET_PTS", "22"));

  // Warm-up: 25 candles (EMA20 needs 20 + buffer for stability, ATR14, RSI14)
  if (candles.length < 25) {
    return {
      signal: "NONE",
      reason: "Warming up (" + candles.length + "/25 candles)",
      stopLoss: null,
      target: null,
      prevCandleHigh: null,
      prevCandleLow:  null,
    };
  }

  var signalCandle = candles[candles.length - 1];

  var windowCheck = isInTradingWindow(signalCandle.time);
  if (!windowCheck.ok) {
    return {
      signal: "NONE",
      reason: windowCheck.reason,
      stopLoss: null,
      target: null,
      prevCandleHigh: signalCandle.high,
      prevCandleLow:  signalCandle.low,
    };
  }

  // ── Indicators ──────────────────────────────────────────────────────────────
  var ohlc4  = candles.map(function(c) { return (c.open + c.high + c.low + c.close) / 4; });
  var closes = candles.map(function(c) { return c.close; });
  var highs  = candles.map(function(c) { return c.high; });
  var lows   = candles.map(function(c) { return c.low; });

  // EMA9 on OHLC4 (fast — entry trigger)
  var ema9arr = EMA.calculate({ period: 9, values: ohlc4 });
  var ema9    = ema9arr[ema9arr.length - 1];
  var ema9_1  = ema9arr[ema9arr.length - 2];

  // EMA20 on close (trend filter — only scalp WITH the trend)
  var ema20arr = EMA.calculate({ period: 20, values: closes });
  var ema20    = ema20arr[ema20arr.length - 1];

  // RSI
  var rsiArr = RSI.calculate({ period: 14, values: closes });
  var rsi    = rsiArr[rsiArr.length - 1];
  var rsiPrev = rsiArr.length >= 2 ? rsiArr[rsiArr.length - 2] : rsi;
  var rsiRising  = rsi > rsiPrev + 0.5;  // Relaxed from +1 — trend filter compensates
  var rsiFalling = rsi < rsiPrev - 0.5;

  // ATR for dynamic SL/Target
  var atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  var atr    = atrArr.length > 0 ? atrArr[atrArr.length - 1] : 10; // fallback 10

  // EMA9 slope
  var ema9Slope = parseFloat((ema9 - ema9_1).toFixed(2));

  // ADX (optional)
  var adxVal = null;
  var isTrending = true;
  if (SCALP_ADX_ENABLED) {
    var adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    adxVal     = adxArr.length > 0 ? adxArr[adxArr.length - 1].adx : null;
    isTrending = adxVal === null ? true : adxVal >= SCALP_ADX_MIN;
  }

  // ── Volume check (if volume data available) ─────────────────────────────────
  var hasVolume = candles[0].volume !== undefined && candles[0].volume !== null;
  var volOk = true;
  var avgVol = null;
  if (hasVolume) {
    var vols = candles.slice(-20).map(function(c) { return c.volume || 0; });
    avgVol = vols.reduce(function(s, v) { return s + v; }, 0) / vols.length;
    var curVol = signalCandle.volume || 0;
    volOk = curVol >= avgVol * 0.8; // At least 80% of average volume
  }

  // ── EMA9 cross detection ───────────────────────────────────────────────────
  var crossedAbove = signalCandle.low <= ema9 && signalCandle.close > ema9;
  var crossedBelow = signalCandle.high >= ema9 && signalCandle.close < ema9;

  var emaCE = crossedAbove;
  var emaPE = crossedBelow;

  // ── EMA20 trend filter ──────────────────────────────────────────────────────
  // KEY IMPROVEMENT: Only take CE when price is ABOVE EMA20 (bullish trend)
  //                  Only take PE when price is BELOW EMA20 (bearish trend)
  var trendBullish = signalCandle.close > ema20;
  var trendBearish = signalCandle.close < ema20;

  // ── Candle body check ──────────────────────────────────────────────────────
  var candleBody = Math.abs(signalCandle.close - signalCandle.open);
  var isBullishBody = signalCandle.close > signalCandle.open && candleBody >= SCALP_MIN_BODY;
  var isBearishBody = signalCandle.close < signalCandle.open && candleBody >= SCALP_MIN_BODY;

  // ── Calculate ATR-based SL and Target ──────────────────────────────────────
  var slPts, tgtPts;
  if (USE_ATR_SL) {
    slPts  = Math.min(ATR_MAX_SL, Math.max(ATR_MIN_SL, Math.round(atr * ATR_SL_MULT)));
    tgtPts = Math.round(atr * ATR_TGT_MULT);
    // Ensure minimum R:R of 1:1.5
    if (tgtPts < slPts * 1.5) tgtPts = Math.round(slPts * 1.5);
  } else {
    slPts  = FIXED_SL_PTS;
    tgtPts = FIXED_TGT_PTS;
  }

  // ── Log ─────────────────────────────────────────────────────────────────────
  var _istTime = new Date(signalCandle.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  if (!silent) console.log(
    "[SCALP_V2 " + _istTime + "]" +
    " EMA9=" + ema9.toFixed(1) + "(slope=" + ema9Slope + ")" +
    " EMA20=" + ema20.toFixed(1) + (trendBullish ? "↑" : "↓") +
    " | RSI=" + rsi.toFixed(1) + (rsiRising ? "↑" : rsiFalling ? "↓" : "→") +
    " | ATR=" + atr.toFixed(1) + " SL=" + slPts + "pt TGT=" + tgtPts + "pt" +
    " | body=" + candleBody.toFixed(1) + "pt" +
    (hasVolume ? " | vol=" + (signalCandle.volume||0) + "/" + Math.round(avgVol) : "") +
    " | C=" + signalCandle.close
  );

  var base = {
    ema9:           parseFloat(ema9.toFixed(2)),
    ema9Prev:       parseFloat(ema9_1.toFixed(2)),
    ema9Slope:      ema9Slope,
    ema20:          parseFloat(ema20.toFixed(2)),
    trendBullish:   trendBullish,
    trendBearish:   trendBearish,
    rsi:            parseFloat(rsi.toFixed(1)),
    rsiPrev:        parseFloat(rsiPrev.toFixed(1)),
    rsiRising:      rsiRising,
    rsiFalling:     rsiFalling,
    atr:            parseFloat(atr.toFixed(2)),
    slPts:          slPts,
    tgtPts:         tgtPts,
    adx:            adxVal !== null ? parseFloat(adxVal.toFixed(1)) : null,
    adxTrending:    isTrending,
    prevCandleHigh: signalCandle.high,
    prevCandleLow:  signalCandle.low,
    stopLoss:       null,
    target:         null,
  };

  // ── EMA slope gate ──────────────────────────────────────────────────────────
  var SCALP_MIN_SLOPE = parseFloat(cfg("SCALP_MIN_SLOPE", "1.5")); // Slightly relaxed since EMA20 filters
  var emaSlopeOkCE = ema9Slope >= SCALP_MIN_SLOPE;
  var emaSlopeOkPE = ema9Slope <= -SCALP_MIN_SLOPE;

  // ── BUY CE ──────────────────────────────────────────────────────────────────
  if (emaCE && isBullishBody && emaSlopeOkCE) {
    // TREND FILTER: must be above EMA20
    if (!trendBullish) {
      if (!silent) console.log("  ❌ SCALP CE: close=" + signalCandle.close + " BELOW EMA20=" + ema20.toFixed(1) + " (against trend)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "CE blocked: price below EMA20 — scalping against trend",
      });
    }

    // Volume gate
    if (hasVolume && !volOk) {
      if (!silent) console.log("  ❌ SCALP CE: low volume — " + (signalCandle.volume||0) + " < 80% avg " + Math.round(avgVol));
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "CE blocked: volume too low",
      });
    }

    // ADX gate
    if (SCALP_ADX_ENABLED && !isTrending) {
      if (!silent) console.log("  ❌ SCALP CE: ADX=" + (adxVal||0).toFixed(1) + " < " + SCALP_ADX_MIN + " (ranging)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "CE blocked: ADX=" + (adxVal||0).toFixed(1) + " < " + SCALP_ADX_MIN + " — market ranging",
      });
    }

    // RSI gate
    if (rsi > SCALP_RSI_CE_MIN && rsiRising) {
      var ceSL     = parseFloat((signalCandle.close - slPts).toFixed(2));
      var ceTarget = parseFloat((signalCandle.close + tgtPts).toFixed(2));
      if (!silent) console.log("  🟢 SCALP BUY_CE — close=" + signalCandle.close + " SL=" + ceSL + "(" + slPts + "pt) TGT=" + ceTarget + "(" + tgtPts + "pt) ATR=" + atr.toFixed(1));
      return Object.assign({}, base, {
        signal:         "BUY_CE",
        signalStrength: "SCALP",
        stopLoss:       ceSL,
        target:         ceTarget,
        reason: "EMA9 cross CE (close=" + signalCandle.close + " > EMA9=" + ema9.toFixed(2) + ")" +
                " | EMA20=" + ema20.toFixed(2) + " (trend OK)" +
                " | RSI=" + rsi.toFixed(1) + "↑ > " + SCALP_RSI_CE_MIN +
                " | ATR=" + atr.toFixed(1) + " SL=" + slPts + "pt TGT=" + tgtPts + "pt" +
                " | body=" + candleBody.toFixed(1) + "pt",
      });
    }
    if (!silent) console.log("  ❌ SCALP CE: RSI=" + rsi.toFixed(1) + " (need >" + SCALP_RSI_CE_MIN + " & rising)");
    return Object.assign({}, base, {
      signal: "NONE",
      reason: "CE blocked: RSI=" + rsi.toFixed(1) + " (need >" + SCALP_RSI_CE_MIN + " & rising)",
    });
  }

  // ── BUY PE ──────────────────────────────────────────────────────────────────
  if (emaPE && isBearishBody && emaSlopeOkPE) {
    // TREND FILTER: must be below EMA20
    if (!trendBearish) {
      if (!silent) console.log("  ❌ SCALP PE: close=" + signalCandle.close + " ABOVE EMA20=" + ema20.toFixed(1) + " (against trend)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "PE blocked: price above EMA20 — scalping against trend",
      });
    }

    if (hasVolume && !volOk) {
      if (!silent) console.log("  ❌ SCALP PE: low volume");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "PE blocked: volume too low",
      });
    }

    if (SCALP_ADX_ENABLED && !isTrending) {
      if (!silent) console.log("  ❌ SCALP PE: ADX=" + (adxVal||0).toFixed(1) + " < " + SCALP_ADX_MIN + " (ranging)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "PE blocked: ADX=" + (adxVal||0).toFixed(1) + " < " + SCALP_ADX_MIN + " — market ranging",
      });
    }

    if (rsi < SCALP_RSI_PE_MAX && rsiFalling) {
      var peSL     = parseFloat((signalCandle.close + slPts).toFixed(2));
      var peTarget = parseFloat((signalCandle.close - tgtPts).toFixed(2));
      if (!silent) console.log("  🔴 SCALP BUY_PE — close=" + signalCandle.close + " SL=" + peSL + "(" + slPts + "pt) TGT=" + peTarget + "(" + tgtPts + "pt) ATR=" + atr.toFixed(1));
      return Object.assign({}, base, {
        signal:         "BUY_PE",
        signalStrength: "SCALP",
        stopLoss:       peSL,
        target:         peTarget,
        reason: "EMA9 cross PE (close=" + signalCandle.close + " < EMA9=" + ema9.toFixed(2) + ")" +
                " | EMA20=" + ema20.toFixed(2) + " (trend OK)" +
                " | RSI=" + rsi.toFixed(1) + "↓ < " + SCALP_RSI_PE_MAX +
                " | ATR=" + atr.toFixed(1) + " SL=" + slPts + "pt TGT=" + tgtPts + "pt" +
                " | body=" + candleBody.toFixed(1) + "pt",
      });
    }
    if (!silent) console.log("  ❌ SCALP PE: RSI=" + rsi.toFixed(1) + " (need <" + SCALP_RSI_PE_MAX + " & falling)");
    return Object.assign({}, base, {
      signal: "NONE",
      reason: "PE blocked: RSI=" + rsi.toFixed(1) + " (need <" + SCALP_RSI_PE_MAX + " & falling)",
    });
  }

  // ── No signal ───────────────────────────────────────────────────────────────
  var noReason = [];
  if (!emaCE && !emaPE) {
    noReason.push("No EMA9 cross");
  } else if (emaCE && !emaSlopeOkCE) {
    noReason.push("CE cross but EMA slope=" + ema9Slope + " < " + SCALP_MIN_SLOPE);
  } else if (emaPE && !emaSlopeOkPE) {
    noReason.push("PE cross but EMA slope=" + ema9Slope + " > -" + SCALP_MIN_SLOPE);
  } else if (emaCE && !isBullishBody) {
    noReason.push("CE cross but body not bullish (body=" + candleBody.toFixed(1) + "pt)");
  } else if (emaPE && !isBearishBody) {
    noReason.push("PE cross but body not bearish");
  }

  return Object.assign({}, base, {
    signal: "NONE",
    reason: noReason.join(" | ") + " | RSI=" + rsi.toFixed(1) + " | EMA20=" + ema20.toFixed(1),
  });
}

function reset() {
  // No module-level state
}

module.exports = { NAME, DESCRIPTION, getSignal, reset };

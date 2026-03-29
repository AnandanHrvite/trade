/**
 * SCALP STRATEGY: EMA9_RSI (3-min candles)
 *
 * ENTRY — BUY_CE (bullish):
 *   TRIGGER    : Price crosses ABOVE EMA9 (OHLC4)
 *   CONFIRM 1  : Candle CLOSES above EMA9 (double confirmation — not just wick)
 *   CONFIRM 2  : RSI(14) > 55 AND rising (current RSI > previous RSI)
 *   CONFIRM 3  : Candle body is GREEN and >= 5 pts (filters dojis)
 *
 * ENTRY — BUY_PE (bearish):
 *   TRIGGER    : Price crosses BELOW EMA9 (OHLC4)
 *   CONFIRM 1  : Candle CLOSES below EMA9
 *   CONFIRM 2  : RSI(14) < 45 AND falling
 *   CONFIRM 3  : Candle body is RED and >= 5 pts
 *
 * EXIT: Target pts | SL pts | Trail SL | Time stop (4 candles) | RSI reversal | EOD 3:20 PM
 * Timeframe: 3-min | EMA: OHLC4 | Window: 9:21 AM–3:00 PM IST
 *
 * NO SAR — too laggy for 3-min, creates late entries
 * NO 50% rule — swing concept, doesn't apply to scalps
 * ADX optional (light threshold >= 20 if enabled)
 */

const { EMA, RSI, ADX } = require("technicalindicators");

const NAME        = "SCALP_EMA9_RSI";
const DESCRIPTION = "3-min | EMA9 OHLC4 cross + close confirm + RSI 55/45 + body>=5pt | scalp target/SL/trail/time-stop";

// ── Configurable via .env (with defaults) ────────────────────────────────────
function cfg(key, fallback) { return process.env[key] || fallback; }

// ── Trading window — tuned for 3-min scalp ───────────────────────────────────
// Skip first 2 candles (9:15–9:21): opening volatility is noise on 3-min
// No entries after 3:00 PM
function isInTradingWindow(unixSec) {
  var d        = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  if (totalMin < 561)  return { ok: false, reason: "Before 9:21 AM — skipping opening noise (first 2 candles)" };
  if (totalMin >= 900) return { ok: false, reason: "After 3:00 PM — no new scalp entries" };
  return { ok: true, reason: null };
}

/**
 * getSignal(candles, opts)
 *
 * Returns: { signal, reason, stopLoss, target, signalStrength, ...indicators }
 *
 * signal: "BUY_CE" | "BUY_PE" | "NONE"
 * stopLoss: calculated SL price (EMA9-based for scalp)
 * target: calculated target price
 */
function getSignal(candles, opts) {
  var silent = (opts && opts.silent === true);

  // Read scalp-specific config (allows runtime changes via settings)
  var SCALP_RSI_CE_MIN   = parseFloat(cfg("SCALP_RSI_CE_MIN", "55"));
  var SCALP_RSI_PE_MAX   = parseFloat(cfg("SCALP_RSI_PE_MAX", "45"));
  var SCALP_SL_PTS       = parseFloat(cfg("SCALP_SL_PTS", "12"));
  var SCALP_TARGET_PTS   = parseFloat(cfg("SCALP_TARGET_PTS", "18"));
  var SCALP_MIN_BODY     = parseFloat(cfg("SCALP_MIN_BODY", "5"));
  var SCALP_ADX_ENABLED  = cfg("SCALP_ADX_ENABLED", "false") === "true";
  var SCALP_ADX_MIN      = parseFloat(cfg("SCALP_ADX_MIN", "20"));

  // Warm-up: 15 candles (RSI needs 14 + 1 for comparison)
  if (candles.length < 15) {
    return {
      signal: "NONE",
      reason: "Warming up (" + candles.length + "/15 candles)",
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

  var ema9arr = EMA.calculate({ period: 9, values: ohlc4 });
  var ema9    = ema9arr[ema9arr.length - 1];
  var ema9_1  = ema9arr[ema9arr.length - 2];

  var rsiArr = RSI.calculate({ period: 14, values: closes });
  var rsi    = rsiArr[rsiArr.length - 1];
  var rsiPrev = rsiArr.length >= 2 ? rsiArr[rsiArr.length - 2] : rsi;
  // RSI must move meaningfully (>= 1pt) — not just 0.01 noise
  var rsiRising  = rsi > rsiPrev + 1;
  var rsiFalling = rsi < rsiPrev - 1;

  // EMA9 slope
  var ema9Slope = parseFloat((ema9 - ema9_1).toFixed(2));

  // ADX (optional for scalp — lighter filter)
  var adxVal = null;
  var isTrending = true; // default pass if ADX disabled
  if (SCALP_ADX_ENABLED) {
    var highs  = candles.map(function(c) { return c.high; });
    var lows   = candles.map(function(c) { return c.low; });
    var adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    adxVal     = adxArr.length > 0 ? adxArr[adxArr.length - 1].adx : null;
    isTrending = adxVal === null ? true : adxVal >= SCALP_ADX_MIN;
  }

  // ── EMA9 cross detection ───────────────────────────────────────────────────
  // Double confirmation: candle must CLOSE above/below EMA9
  var closedAboveEMA = signalCandle.close > ema9;
  var closedBelowEMA = signalCandle.close < ema9;

  // Cross: price must have been on the other side (high touched from below for CE, low from above for PE)
  // This is the PRIMARY entry — price actually crosses through EMA9 and closes on the other side.
  var crossedAbove = signalCandle.low <= ema9 && signalCandle.close > ema9;   // came from below, closed above
  var crossedBelow = signalCandle.high >= ema9 && signalCandle.close < ema9;  // came from above, closed below

  // NOTE: Continuation entries (already above/below EMA9) REMOVED.
  // They generated 10-15 entries/day on every candle in a trend direction = massive overtrading.
  // Scalp should only enter on the actual EMA9 cross — the decisive moment.
  var emaCE = crossedAbove;
  var emaPE = crossedBelow;

  // ── Candle body check ──────────────────────────────────────────────────────
  var candleBody = Math.abs(signalCandle.close - signalCandle.open);
  var isBullishBody = signalCandle.close > signalCandle.open && candleBody >= SCALP_MIN_BODY;
  var isBearishBody = signalCandle.close < signalCandle.open && candleBody >= SCALP_MIN_BODY;

  // ── Comprehensive indicator log ────────────────────────────────────────────
  var _istTime = new Date(signalCandle.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  if (!silent) console.log(
    "[SCALP " + _istTime + "]" +
    " EMA9=" + ema9.toFixed(1) + "(slope=" + ema9Slope + ")" +
    " | RSI=" + rsi.toFixed(1) + (rsiRising ? "↑" : rsiFalling ? "↓" : "→") +
    " | body=" + candleBody.toFixed(1) + "pt" +
    (SCALP_ADX_ENABLED ? " | ADX=" + (adxVal !== null ? adxVal.toFixed(1) : "n/a") : "") +
    " | C=" + signalCandle.close + " H=" + signalCandle.high + " L=" + signalCandle.low
  );

  var base = {
    ema9:           parseFloat(ema9.toFixed(2)),
    ema9Prev:       parseFloat(ema9_1.toFixed(2)),
    ema9Slope:      ema9Slope,
    rsi:            parseFloat(rsi.toFixed(1)),
    rsiPrev:        parseFloat(rsiPrev.toFixed(1)),
    rsiRising:      rsiRising,
    rsiFalling:     rsiFalling,
    adx:            adxVal !== null ? parseFloat(adxVal.toFixed(1)) : null,
    adxTrending:    isTrending,
    prevCandleHigh: signalCandle.high,
    prevCandleLow:  signalCandle.low,
    stopLoss:       null,
    target:         null,
  };

  // ── EMA slope gate — require minimum slope for entry direction ──────────────
  // Flat EMA9 crosses are noise on 3-min — need the EMA to actually be moving our way.
  var SCALP_MIN_SLOPE = parseFloat(cfg("SCALP_MIN_SLOPE", "2"));
  var emaSlopeOkCE = ema9Slope >= SCALP_MIN_SLOPE;   // EMA9 rising for CE
  var emaSlopeOkPE = ema9Slope <= -SCALP_MIN_SLOPE;  // EMA9 falling for PE

  // ── BUY CE ──────────────────────────────────────────────────────────────────
  if (emaCE && isBullishBody && emaSlopeOkCE) {
    // ADX gate
    if (SCALP_ADX_ENABLED && !isTrending) {
      if (!silent) console.log("  ❌ SCALP CE: ADX=" + (adxVal||0).toFixed(1) + " < " + SCALP_ADX_MIN + " (ranging)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "CE blocked: ADX=" + (adxVal||0).toFixed(1) + " < " + SCALP_ADX_MIN + " — market ranging",
      });
    }
    // RSI gate: must be > threshold AND rising
    if (rsi > SCALP_RSI_CE_MIN && rsiRising) {
      var ceSL     = parseFloat((signalCandle.close - SCALP_SL_PTS).toFixed(2));
      var ceTarget = parseFloat((signalCandle.close + SCALP_TARGET_PTS).toFixed(2));
      if (!silent) console.log("  🟢 SCALP BUY_CE — close=" + signalCandle.close + " SL=" + ceSL + " TGT=" + ceTarget);
      return Object.assign({}, base, {
        signal:         "BUY_CE",
        signalStrength: "SCALP",
        stopLoss:       ceSL,
        target:         ceTarget,
        reason: "EMA9 cross CE (close=" + signalCandle.close + " > EMA9=" + ema9.toFixed(2) + ")" +
                " | RSI=" + rsi.toFixed(1) + "↑ > " + SCALP_RSI_CE_MIN +
                " | body=" + candleBody.toFixed(1) + "pt" +
                " | SL=" + ceSL + " TGT=" + ceTarget,
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
    if (SCALP_ADX_ENABLED && !isTrending) {
      if (!silent) console.log("  ❌ SCALP PE: ADX=" + (adxVal||0).toFixed(1) + " < " + SCALP_ADX_MIN + " (ranging)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "PE blocked: ADX=" + (adxVal||0).toFixed(1) + " < " + SCALP_ADX_MIN + " — market ranging",
      });
    }
    if (rsi < SCALP_RSI_PE_MAX && rsiFalling) {
      var peSL     = parseFloat((signalCandle.close + SCALP_SL_PTS).toFixed(2));
      var peTarget = parseFloat((signalCandle.close - SCALP_TARGET_PTS).toFixed(2));
      if (!silent) console.log("  🔴 SCALP BUY_PE — close=" + signalCandle.close + " SL=" + peSL + " TGT=" + peTarget);
      return Object.assign({}, base, {
        signal:         "BUY_PE",
        signalStrength: "SCALP",
        stopLoss:       peSL,
        target:         peTarget,
        reason: "EMA9 cross PE (close=" + signalCandle.close + " < EMA9=" + ema9.toFixed(2) + ")" +
                " | RSI=" + rsi.toFixed(1) + "↓ < " + SCALP_RSI_PE_MAX +
                " | body=" + candleBody.toFixed(1) + "pt" +
                " | SL=" + peSL + " TGT=" + peTarget,
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
    noReason.push("No EMA9 cross (close=" + signalCandle.close + " EMA9=" + ema9.toFixed(2) + ")");
  } else if (emaCE && !emaSlopeOkCE) {
    noReason.push("CE cross but EMA slope=" + ema9Slope + " < " + SCALP_MIN_SLOPE + " (flat EMA)");
  } else if (emaPE && !emaSlopeOkPE) {
    noReason.push("PE cross but EMA slope=" + ema9Slope + " > -" + SCALP_MIN_SLOPE + " (flat EMA)");
  } else if (emaCE && !isBullishBody) {
    noReason.push("CE EMA cross but body not bullish (body=" + candleBody.toFixed(1) + "pt)");
  } else if (emaPE && !isBearishBody) {
    noReason.push("PE EMA cross but body not bearish (body=" + candleBody.toFixed(1) + "pt)");
  }

  return Object.assign({}, base, {
    signal: "NONE",
    reason: noReason.join(" | ") + " | RSI=" + rsi.toFixed(1) + " | EMA9slope=" + ema9Slope,
  });
}

// Reset hook (called by backtest between runs)
function reset() {
  // No module-level state to reset in scalp strategy
}

module.exports = { NAME, DESCRIPTION, getSignal, reset };

/**
 * SCALP V2: SAR FLIP + EMA9 CROSS + NEXT CANDLE CONFIRMATION (3-min)
 *
 * DOUBLE CANDLE CONFIRMATION:
 *   Candle 1: EMA9 cross detected + SAR flipped → "pending signal"
 *   Candle 2: Must close ABOVE candle 1's high (CE) or BELOW candle 1's low (PE)
 *   Only THEN entry is taken on candle 2's close
 *
 * This eliminates false crosses — if the next candle doesn't continue, no trade.
 * Window: 9:21 AM – 2:00 PM | Candle: 3-min
 */

const { EMA, RSI, PSAR, ATR } = require("technicalindicators");

const NAME        = "SCALP_EMA9_RSI_V2";
const DESCRIPTION = "3-min | SAR flip + EMA9 cross + next candle confirm";

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }

// ── Module-level state for pending signals ────────────────────────────────
var _pending = null;  // { side: "CE"|"PE", high, low, time, sar, ema9 }

function isInTradingWindow(unixSec) {
  var d = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  if (totalMin < 561)  return { ok: false, reason: "Before 9:21 AM" };
  if (totalMin >= 840) return { ok: false, reason: "After 2:00 PM" };
  return { ok: true, reason: null };
}

function getSignal(candles, opts) {
  var silent = (opts && opts.silent === true);

  var SCALP_RSI_CE_MIN   = parseFloat(cfg("SCALP_RSI_CE_MIN", "50"));
  var SCALP_RSI_PE_MAX   = parseFloat(cfg("SCALP_RSI_PE_MAX", "50"));
  var SCALP_MIN_BODY     = parseFloat(cfg("SCALP_MIN_BODY", "3"));
  var SCALP_MIN_SLOPE    = parseFloat(cfg("SCALP_MIN_SLOPE", "1"));
  var SCALP_MAX_SL       = parseFloat(cfg("SCALP_MAX_SAR_GAP", "15"));
  var SCALP_MIN_SL       = parseFloat(cfg("SCALP_MIN_SAR_GAP", "3"));

  if (candles.length < 35) {
    return { signal: "NONE", reason: "Warming up", stopLoss: null, target: null, prevCandleHigh: null, prevCandleLow: null };
  }

  var signalCandle = candles[candles.length - 1];
  var prevCandle   = candles[candles.length - 2];

  var windowCheck = isInTradingWindow(signalCandle.time);
  if (!windowCheck.ok) {
    _pending = null;
    return { signal: "NONE", reason: windowCheck.reason, stopLoss: null, target: null, prevCandleHigh: signalCandle.high, prevCandleLow: signalCandle.low };
  }

  // ── Indicators ──────────────────────────────────────────────────────────────
  var ohlc4  = candles.map(function(c) { return (c.open + c.high + c.low + c.close) / 4; });
  var closes = candles.map(function(c) { return c.close; });
  var highs  = candles.map(function(c) { return c.high; });
  var lows   = candles.map(function(c) { return c.low; });

  var ema9arr = EMA.calculate({ period: 9, values: ohlc4 });
  var ema9 = ema9arr[ema9arr.length - 1], ema9_1 = ema9arr[ema9arr.length - 2];
  var ema9Slope = parseFloat((ema9 - ema9_1).toFixed(2));

  var ema20arr = EMA.calculate({ period: 20, values: closes });
  var ema20 = ema20arr[ema20arr.length - 1];

  var rsiArr = RSI.calculate({ period: 14, values: closes });
  var rsi = rsiArr[rsiArr.length - 1];

  var atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  var atr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : 10;

  var sarArr = PSAR.calculate({ step: 0.02, max: 0.2, high: highs, low: lows });
  var sarNow = sarArr.length > 0 ? sarArr[sarArr.length - 1] : null;
  var sarPrev = sarArr.length > 1 ? sarArr[sarArr.length - 2] : null;

  if (sarNow === null) {
    return { signal: "NONE", reason: "SAR warming up", stopLoss: null, target: null, prevCandleHigh: signalCandle.high, prevCandleLow: signalCandle.low };
  }

  var sarBelowNow = sarNow < signalCandle.close;
  var sarAboveNow = sarNow > signalCandle.close;

  // SAR flip detection (current vs previous)
  var sarFlippedBullish = false, sarFlippedBearish = false;
  if (sarPrev !== null) {
    var prevClose = closes[closes.length - 2];
    var sarWasAbove = sarPrev > prevClose;
    var sarWasBelow = sarPrev < prevClose;
    sarFlippedBullish = sarWasAbove && sarBelowNow;  // was bearish → now bullish
    sarFlippedBearish = sarWasBelow && sarAboveNow;  // was bullish → now bearish
  }

  var crossedAbove = signalCandle.low <= ema9 && signalCandle.close > ema9;
  var crossedBelow = signalCandle.high >= ema9 && signalCandle.close < ema9;
  var candleBody = Math.abs(signalCandle.close - signalCandle.open);

  var _ist = new Date(signalCandle.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

  var base = { ema9: parseFloat(ema9.toFixed(2)), ema9Slope: ema9Slope, ema20: parseFloat(ema20.toFixed(2)), rsi: parseFloat(rsi.toFixed(1)), atr: parseFloat(atr.toFixed(2)), sar: parseFloat(sarNow.toFixed(2)), prevCandleHigh: signalCandle.high, prevCandleLow: signalCandle.low, stopLoss: null, target: null, slPts: 0, tgtPts: 0 };

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 1: Check if previous candle set a PENDING signal → confirm now
  // ══════════════════════════════════════════════════════════════════════════
  if (_pending !== null) {
    var confirmed = false;
    var pendingSide = _pending.side;
    var pendingInfo = _pending;
    _pending = null;  // consume it regardless

    if (pendingSide === "CE" && signalCandle.close > pendingInfo.high) {
      // Candle 2 closed ABOVE candle 1's high → CE confirmed!
      confirmed = true;
      if (!silent) console.log("  ✅ SCALP CE CONFIRMED — close " + signalCandle.close + " > prev high " + pendingInfo.high);
    }
    if (pendingSide === "PE" && signalCandle.close < pendingInfo.low) {
      // Candle 2 closed BELOW candle 1's low → PE confirmed!
      confirmed = true;
      if (!silent) console.log("  ✅ SCALP PE CONFIRMED — close " + signalCandle.close + " < prev low " + pendingInfo.low);
    }

    if (confirmed) {
      var sarGap = pendingSide === "CE"
        ? parseFloat((signalCandle.close - sarNow).toFixed(2))
        : parseFloat((sarNow - signalCandle.close).toFixed(2));
      var slPts = Math.min(Math.max(sarGap, SCALP_MIN_SL), SCALP_MAX_SL);
      var tgtPts = Math.round(slPts * 3);  // 1:3 R:R target (high, trail will capture earlier)

      if (pendingSide === "CE") {
        // Final gates on confirmation candle
        if (signalCandle.close <= ema20) {
          if (!silent) console.log("  ❌ CE confirm rejected: below EMA20");
          // fall through to new signal detection
        } else if (rsi <= SCALP_RSI_CE_MIN) {
          if (!silent) console.log("  ❌ CE confirm rejected: RSI " + rsi.toFixed(1));
        } else {
          var ceSL = parseFloat((signalCandle.close - slPts).toFixed(2));
          var ceTgt = parseFloat((signalCandle.close + tgtPts).toFixed(2));
          if (!silent) console.log("  🟢 SCALP BUY_CE [2-candle confirmed] SL=" + ceSL + " TGT=" + ceTgt);
          return Object.assign({}, base, { signal: "BUY_CE", signalStrength: "SCALP", stopLoss: ceSL, target: ceTgt, slPts: slPts, tgtPts: tgtPts, reason: "2-candle CE: SAR flip + EMA9 cross + next candle > prev high | RSI=" + rsi.toFixed(1) });
        }
      } else {
        if (signalCandle.close >= ema20) {
          if (!silent) console.log("  ❌ PE confirm rejected: above EMA20");
        } else if (rsi >= SCALP_RSI_PE_MAX) {
          if (!silent) console.log("  ❌ PE confirm rejected: RSI " + rsi.toFixed(1));
        } else {
          var peSL = parseFloat((signalCandle.close + slPts).toFixed(2));
          var peTgt = parseFloat((signalCandle.close - tgtPts).toFixed(2));
          if (!silent) console.log("  🔴 SCALP BUY_PE [2-candle confirmed] SL=" + peSL + " TGT=" + peTgt);
          return Object.assign({}, base, { signal: "BUY_PE", signalStrength: "SCALP", stopLoss: peSL, target: peTgt, slPts: slPts, tgtPts: tgtPts, reason: "2-candle PE: SAR flip + EMA9 cross + next candle < prev low | RSI=" + rsi.toFixed(1) });
        }
      }
    } else {
      if (!silent) console.log("  ⏸ Pending " + pendingSide + " NOT confirmed — next candle didn't break prev " + (pendingSide === "CE" ? "high " + pendingInfo.high : "low " + pendingInfo.low));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 2: Detect new SAR flip + EMA9 cross → set PENDING for next candle
  // ══════════════════════════════════════════════════════════════════════════

  // Also check within last 3 candles for SAR flip (not just immediate)
  var recentFlipBull = sarFlippedBullish;
  var recentFlipBear = sarFlippedBearish;
  if (!recentFlipBull && sarBelowNow && sarArr.length > 2) {
    var sar2 = sarArr[sarArr.length - 3];
    var close2 = closes[closes.length - 3];
    if (sar2 > close2) recentFlipBull = true;
  }
  if (!recentFlipBear && sarAboveNow && sarArr.length > 2) {
    var sar2b = sarArr[sarArr.length - 3];
    var close2b = closes[closes.length - 3];
    if (sar2b < close2b) recentFlipBear = true;
  }

  var isBullishBody = signalCandle.close > signalCandle.open && candleBody >= SCALP_MIN_BODY;
  var isBearishBody = signalCandle.close < signalCandle.open && candleBody >= SCALP_MIN_BODY;

  if (recentFlipBull && crossedAbove && isBullishBody && ema9Slope >= SCALP_MIN_SLOPE) {
    _pending = { side: "CE", high: signalCandle.high, low: signalCandle.low, time: signalCandle.time };
    if (!silent) console.log("[SCALP_V2 " + _ist + "] 🔔 CE PENDING — SAR flip↑ + EMA9 cross. Wait for next candle > " + signalCandle.high);
    return Object.assign({}, base, { signal: "NONE", reason: "CE pending — waiting for next candle confirmation > " + signalCandle.high });
  }

  if (recentFlipBear && crossedBelow && isBearishBody && ema9Slope <= -SCALP_MIN_SLOPE) {
    _pending = { side: "PE", high: signalCandle.high, low: signalCandle.low, time: signalCandle.time };
    if (!silent) console.log("[SCALP_V2 " + _ist + "] 🔔 PE PENDING — SAR flip↓ + EMA9 cross. Wait for next candle < " + signalCandle.low);
    return Object.assign({}, base, { signal: "NONE", reason: "PE pending — waiting for next candle confirmation < " + signalCandle.low });
  }

  return Object.assign({}, base, { signal: "NONE", reason: "No SAR flip + EMA9 cross" });
}

function reset() { _pending = null; }
module.exports = { NAME, DESCRIPTION, getSignal, reset };
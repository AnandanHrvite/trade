/**
 * SCALP V2: EMA9 CROSS + SAR DIRECTION + NEXT CANDLE CONFIRM (3-min)
 *
 * Simplified high-probability approach:
 *   Candle 1: Strong cross above/below EMA9 + SAR on correct side + RSI ok
 *             → stored as "pending", NOT entered yet
 *   Candle 2: Closes ABOVE candle 1's HIGH (CE) or BELOW candle 1's LOW (PE)
 *             → CONFIRMED, enter trade
 *
 * No SAR flip needed — just SAR direction (below=bullish, above=bearish)
 * SL = SAR value capped at 15pt | Breakeven +4pt | Trail 3pt gap
 */

const { EMA, RSI, PSAR, ATR } = require("technicalindicators");

const NAME        = "SCALP_EMA9_RSI_V2";
const DESCRIPTION = "3-min | EMA9 cross + SAR + next candle confirm";

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }

var _pending = null;

function isInTradingWindow(unixSec) {
  var d = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  if (totalMin < 561)  return { ok: false, reason: "Before 9:21 AM" };
  if (totalMin >= 840) return { ok: false, reason: "After 2:00 PM" };
  return { ok: true, reason: null };
}

function getSignal(candles, opts) {
  var silent = (opts && opts.silent === true);
  var SCALP_RSI_CE_MIN = parseFloat(cfg("SCALP_RSI_CE_MIN", "50"));
  var SCALP_RSI_PE_MAX = parseFloat(cfg("SCALP_RSI_PE_MAX", "50"));
  var SCALP_MIN_BODY   = parseFloat(cfg("SCALP_MIN_BODY", "3"));
  var SCALP_MIN_SLOPE  = parseFloat(cfg("SCALP_MIN_SLOPE", "1"));
  var SCALP_MAX_SL     = parseFloat(cfg("SCALP_ATR_MAX_SL", "10"));
  var SCALP_MIN_SL     = parseFloat(cfg("SCALP_ATR_MIN_SL", "3"));

  if (candles.length < 30) {
    return { signal: "NONE", reason: "Warming up", stopLoss: null, target: null, prevCandleHigh: null, prevCandleLow: null };
  }

  var sc = candles[candles.length - 1];
  var windowCheck = isInTradingWindow(sc.time);
  if (!windowCheck.ok) {
    _pending = null;
    return { signal: "NONE", reason: windowCheck.reason, stopLoss: null, target: null, prevCandleHigh: sc.high, prevCandleLow: sc.low };
  }

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
  var sar = sarArr.length > 0 ? sarArr[sarArr.length - 1] : null;

  if (sar === null) return { signal: "NONE", reason: "SAR warming up", stopLoss: null, target: null, prevCandleHigh: sc.high, prevCandleLow: sc.low };

  var sarBelow = sar < sc.close;
  var sarAbove = sar > sc.close;
  var crossUp   = sc.low <= ema9 && sc.close > ema9;
  var crossDown = sc.high >= ema9 && sc.close < ema9;
  var body = Math.abs(sc.close - sc.open);

  var _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  var base = { ema9: parseFloat(ema9.toFixed(2)), ema9Slope: ema9Slope, ema20: parseFloat(ema20.toFixed(2)), rsi: parseFloat(rsi.toFixed(1)), atr: parseFloat(atr.toFixed(2)), sar: parseFloat(sar.toFixed(2)), prevCandleHigh: sc.high, prevCandleLow: sc.low, stopLoss: null, target: null, slPts: 0, tgtPts: 0 };

  // ═══ STEP 1: Check pending confirmation ═══════════════════════════════════
  if (_pending !== null) {
    var p = _pending;
    _pending = null;

    if (p.side === "CE" && sc.close > p.high && sc.close > ema20 && rsi > SCALP_RSI_CE_MIN) {
      var gap = Math.max(SCALP_MIN_SL, parseFloat((sc.close - sar).toFixed(2)));
      var sl = Math.min(gap, SCALP_MAX_SL);
      var tgt = Math.round(sl * 3);
      if (!silent) console.log("  🟢 SCALP CE CONFIRMED — close " + sc.close + " > prev high " + p.high);
      return Object.assign({}, base, { signal: "BUY_CE", signalStrength: "SCALP", stopLoss: parseFloat((sc.close - sl).toFixed(2)), target: parseFloat((sc.close + tgt).toFixed(2)), slPts: sl, tgtPts: tgt, reason: "CE confirmed: cross + SAR + next candle > " + p.high });
    }
    if (p.side === "PE" && sc.close < p.low && sc.close < ema20 && rsi < SCALP_RSI_PE_MAX) {
      var gap = Math.max(SCALP_MIN_SL, parseFloat((sar - sc.close).toFixed(2)));
      var sl = Math.min(gap, SCALP_MAX_SL);
      var tgt = Math.round(sl * 3);
      if (!silent) console.log("  🔴 SCALP PE CONFIRMED — close " + sc.close + " < prev low " + p.low);
      return Object.assign({}, base, { signal: "BUY_PE", signalStrength: "SCALP", stopLoss: parseFloat((sc.close + sl).toFixed(2)), target: parseFloat((sc.close - tgt).toFixed(2)), slPts: sl, tgtPts: tgt, reason: "PE confirmed: cross + SAR + next candle < " + p.low });
    }
    if (!silent) console.log("  ⏸ " + p.side + " not confirmed");
  }

  // ═══ STEP 2: Detect new cross → set pending ══════════════════════════════
  // CE: EMA9 cross up + SAR below + bullish body + slope
  if (crossUp && sarBelow && sc.close > sc.open && body >= SCALP_MIN_BODY && ema9Slope >= SCALP_MIN_SLOPE) {
    _pending = { side: "CE", high: sc.high, low: sc.low, time: sc.time };
    if (!silent) console.log("[SCALP " + _ist + "] 🔔 CE PENDING — cross up + SAR below. Confirm: next close > " + sc.high);
    return Object.assign({}, base, { signal: "NONE", reason: "CE pending → wait next candle > " + sc.high });
  }
  // PE: EMA9 cross down + SAR above + bearish body + slope
  if (crossDown && sarAbove && sc.close < sc.open && body >= SCALP_MIN_BODY && ema9Slope <= -SCALP_MIN_SLOPE) {
    _pending = { side: "PE", high: sc.high, low: sc.low, time: sc.time };
    if (!silent) console.log("[SCALP " + _ist + "] 🔔 PE PENDING — cross down + SAR above. Confirm: next close < " + sc.low);
    return Object.assign({}, base, { signal: "NONE", reason: "PE pending → wait next candle < " + sc.low });
  }

  return Object.assign({}, base, { signal: "NONE", reason: "No cross" });
}

function reset() { _pending = null; }
module.exports = { NAME, DESCRIPTION, getSignal, reset };
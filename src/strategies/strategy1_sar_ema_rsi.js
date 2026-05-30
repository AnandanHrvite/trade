/**
 * STRATEGY: SAR_EMA_RSI  (SWING — entry redefined 2026-05-31)
 *
 * Trend-following rule set driven by an EMA20/EMA50 crossover-state gate.
 *
 * Indicators: EMA20 (close) · EMA50 (close) · RSI(14) · Parabolic SAR (0.02/0.2)
 *             or SuperTrend(10,3) — PSAR vs SuperTrend selected by SWING_USE_SUPERTREND.
 *             EMA21 (OHLC4) is still computed but ONLY for the SL "ema" mode and the
 *             trade-record snapshot — it is NOT part of the entry decision any more.
 *
 * ENTRY — BUY_CE (bullish), ALL must be true (evaluated every tick while flat):
 *   1. EMA20 ABOVE EMA50 (fast on top of slow)
 *   2. RSI(14) in the CE band  →  RSI_CE_MIN < RSI < RSI_CE_MAX
 *   3. Trend source GREEN  →  SAR below price (SAR.trend===1) OR SuperTrend bullish (trend===1)
 *
 * ENTRY — BUY_PE (bearish), mirror:
 *   1. EMA20 BELOW EMA50 (fast under slow)
 *   2. RSI(14) in the PE band  →  RSI_PE_MIN < RSI < RSI_PE_MAX
 *   3. Trend source RED  →  SAR above price (SAR.trend===-1) OR SuperTrend bearish (trend===-1)
 *
 * STOP LOSS (unchanged — set by the execution layer, value seeded here):
 *   CE: previous (last completed) candle LOW
 *   PE: previous (last completed) candle HIGH
 *   The execution layer trails this candle-by-candle (tighten-only) and adds
 *   breakeven, option-stop-%, opposite-signal and EOD exits.
 *
 * Timeframe: 5-min or 15-min (TRADE_RESOLUTION) · window 09:30–14:00 IST.
 */

const { EMA, RSI } = require("technicalindicators");
const { computeSuperTrend } = require("../utils/supertrend");

const NAME        = "SAR_EMA_RSI";
const DESCRIPTION = "SWING | EMA20/EMA50(close) + RSI + SAR/SuperTrend | EMA20-vs-EMA50 trend + RSI gate + PSAR/ST side | prev-candle trailing SL | thresholds via Settings";

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
 *           prevCandleHigh, rsi, ema20, ema50, ema21, sar, sarTrend, signalStrength }.
 * signalStrength is always "STRONG" — there is no strength tier, but the field is
 * kept so the VIX gate's call shape (which only hard-blocks > VIX_MAX_ENTRY) is unchanged.
 */
function getSignal(candles, opts) {
  var silent = (opts && opts.silent === true);

  // EMA periods (close-based) — the fast/slow pair that gates direction.
  var EMA_FAST = parseInt(process.env.SWING_EMA_FAST || "20", 10) || 20;
  var EMA_SLOW = parseInt(process.env.SWING_EMA_SLOW || "50", 10) || 50;
  // Warm-up: the slow EMA needs EMA_SLOW closes; +5 buffer for RSI/SAR to settle.
  var WARMUP = Math.max(EMA_SLOW, 30) + 5;

  if (candles.length < WARMUP) {
    return {
      signal: "NONE",
      reason: "Warming up (" + candles.length + "/" + WARMUP + " candles)",
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
  var closes = candles.map(function(c) { return c.close; });
  var ohlc4  = candles.map(function(c) { return (c.open + c.high + c.low + c.close) / 4; });

  // Entry EMAs — fast/slow on CLOSE.
  var emaFastArr = EMA.calculate({ period: EMA_FAST, values: closes });
  var emaSlowArr = EMA.calculate({ period: EMA_SLOW, values: closes });
  var emaFast = emaFastArr.length > 0 ? emaFastArr[emaFastArr.length - 1] : null;
  var emaSlow = emaSlowArr.length > 0 ? emaSlowArr[emaSlowArr.length - 1] : null;

  // EMA21 (OHLC4) — retained ONLY for the SL "ema" mode + record snapshot. Not an entry input.
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

  if (emaFast === null || emaSlow === null || !currSAR || rsi === undefined ||
      (USE_SUPERTREND && (!currST || currST.trend == null))) {
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
  // 1. EMA20-vs-EMA50 alignment (fast above slow = CE, below = PE).
  var emaUp   = emaFast > emaSlow;   // EMA20 on top of EMA50 — supports CE
  var emaDown = emaFast < emaSlow;   // EMA20 below EMA50      — supports PE
  // 2. RSI band (unchanged).
  var rsiCE = rsi > RSI_CE_MIN && rsi < RSI_CE_MAX;  // above momentum floor, below overbought cap
  var rsiPE = rsi < RSI_PE_MAX && rsi > RSI_PE_MIN;  // below momentum cap, above oversold floor
  // 3. Directional confirmation from whichever trend source is active.
  //    PSAR: trend===1 → dots below price (CE) / ===-1 → dots above (PE).
  //    SuperTrend: trend===1 → line below price (CE) / ===-1 → line above (PE).
  var trendUp   = USE_SUPERTREND ? (currST.trend === 1)  : (currSAR.trend === 1);
  var trendDown = USE_SUPERTREND ? (currST.trend === -1) : (currSAR.trend === -1);
  var _srcLabel = USE_SUPERTREND ? "ST" : "SAR";        // active trend source label for logs
  var _srcVal   = USE_SUPERTREND ? currST.value : currSAR.sar;

  var base = {
    ema20:          Math.round(emaFast * 100) / 100,
    ema50:          Math.round(emaSlow * 100) / 100,
    // EMA21 kept for SL "ema" mode + record continuity (not an entry input).
    ema21:          ema21 != null ? Math.round(ema21 * 100) / 100 : null,
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
    "[STRAT " + _istTime + "] EMA20=" + emaFast.toFixed(1) + " EMA50=" + emaSlow.toFixed(1) +
    "(" + (emaUp ? "20>50" : emaDown ? "20<50" : "=") + ")" +
    " | RSI=" + rsi.toFixed(1) +
    " | " + _trendStr +
    " | C=" + signalCandle.close
  );

  // ── BUY CE ────────────────────────────────────────────────────────────────
  if (emaUp && rsiCE && trendUp) {
    var slCE = Math.round(prevCandle.low * 100) / 100;
    if (!silent) console.log("  🟢 BUY_CE — EMA20 " + emaFast.toFixed(1) + ">EMA50 " + emaSlow.toFixed(1) + " | RSI " + rsi.toFixed(1) + ">" + RSI_CE_MIN + " | " + _srcLabel + " GREEN | SL(prevLow)=" + slCE);
    return Object.assign({}, base, {
      signal:   "BUY_CE",
      stopLoss: slCE,
      reason:   "CE: EMA20 " + emaFast.toFixed(1) + ">EMA50 " + emaSlow.toFixed(1) + " | RSI=" + rsi.toFixed(1) + ">" + RSI_CE_MIN + " | " + _srcLabel + " GREEN @ " + _srcVal + " | SL=prevLow " + slCE,
    });
  }

  // ── BUY PE ────────────────────────────────────────────────────────────────
  if (emaDown && rsiPE && trendDown) {
    var slPE = Math.round(prevCandle.high * 100) / 100;
    if (!silent) console.log("  🔴 BUY_PE — EMA20 " + emaFast.toFixed(1) + "<EMA50 " + emaSlow.toFixed(1) + " | RSI " + rsi.toFixed(1) + "<" + RSI_PE_MAX + " | " + _srcLabel + " RED | SL(prevHigh)=" + slPE);
    return Object.assign({}, base, {
      signal:   "BUY_PE",
      stopLoss: slPE,
      reason:   "PE: EMA20 " + emaFast.toFixed(1) + "<EMA50 " + emaSlow.toFixed(1) + " | RSI=" + rsi.toFixed(1) + "<" + RSI_PE_MAX + " | " + _srcLabel + " RED @ " + _srcVal + " | SL=prevHigh " + slPE,
    });
  }

  // ── No signal — explain which condition(s) failed ─────────────────────────
  var why = [];
  if (emaUp) {
    // EMA bullish → only CE possible; report CE misses
    if (!rsiCE)   why.push("RSI=" + rsi.toFixed(1) + (rsi >= RSI_CE_MAX ? " >=" + RSI_CE_MAX + " (overbought)" : " <=" + RSI_CE_MIN + " (need >)"));
    if (!trendUp) why.push(_srcLabel + " not GREEN @ " + _srcVal);
  } else if (emaDown) {
    if (!rsiPE)     why.push("RSI=" + rsi.toFixed(1) + (rsi <= RSI_PE_MIN ? " <=" + RSI_PE_MIN + " (oversold)" : " >=" + RSI_PE_MAX + " (need <)"));
    if (!trendDown) why.push(_srcLabel + " not RED @ " + _srcVal);
  } else {
    why.push("EMA20=" + emaFast.toFixed(1) + " ≈ EMA50 " + emaSlow.toFixed(1) + " (no alignment)");
  }
  if (why.length === 0) why.push("EMA " + (emaUp ? "20>50" : "20<50") + " but other conditions unmet");

  return Object.assign({}, base, {
    signal: "NONE",
    reason: why.join(" | ") + " | EMA " + (emaUp ? "20>50" : emaDown ? "20<50" : "flat"),
  });
}

module.exports = { NAME: NAME, DESCRIPTION: DESCRIPTION, getSignal: getSignal, calcSAR: calcSAR };

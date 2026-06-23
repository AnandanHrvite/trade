/**
 * STRATEGY: SAR_EMA_RSI  (SWING — entry redefined 2026-05-31, PSAR stripped 2026-06-12)
 *
 * Trend-following rule set driven by an EMA crossover-state gate + SuperTrend confirmation.
 *
 * Indicators: EMA20 (close) · EMA50 (close) · RSI(14) · SuperTrend(10,3).
 *             EMA9 (close) is computed ONLY when the triple-stack toggle is ON.
 *             EMA21 (OHLC4) is still computed but ONLY for the SL "ema" trail and the
 *             trade-record snapshot — it is NOT part of the entry decision.
 *             (Parabolic SAR removed 2026-06-12 — SuperTrend is the only trend source.)
 *
 * ENTRY — BUY_CE (bullish), ALL must be true (evaluated every tick while flat):
 *   1. EMA alignment bullish:
 *        2-EMA (default)      →  EMA20 ABOVE EMA50
 *        triple-stack (opt-in) →  EMA9 > EMA20 > EMA50   (SWING_EMA_TRIPLE_STACK_ENABLED)
 *   2. RSI(14) in the CE band  →  RSI_CE_MIN < RSI < RSI_CE_MAX
 *   3. SuperTrend bullish (trend===1)
 *   4. Close beyond base EMA (opt-in, default ON — SWING_CLOSE_BEYOND_EMA_ENABLED):
 *        signal candle CLOSE > base EMA, where base = EMA9 (fastest) when the triple
 *        stack is on, else EMA20 (fast). Blocks buying into dips that close below the
 *        fast EMA while the lines are still stacked from an earlier move.
 *
 * ENTRY — BUY_PE (bearish), mirror:
 *   1. EMA alignment bearish:  EMA20 BELOW EMA50  (or EMA9 < EMA20 < EMA50 when stacked)
 *   2. RSI(14) in the PE band  →  RSI_PE_MIN < RSI < RSI_PE_MAX
 *   3. SuperTrend bearish (trend===-1)
 *   4. Close beyond base EMA (opt-in, default ON):  signal candle CLOSE < base EMA.
 *
 * STOP LOSS (unchanged — set by the execution layer, value seeded here):
 *   CE: previous (last completed) candle LOW
 *   PE: previous (last completed) candle HIGH
 *   The execution layer trails this candle-by-candle (tighten-only) via EMA21 and adds
 *   option-stop-%, points-stop, opposite-signal and EOD exits.
 *
 * Timeframe: 5-min or 15-min (TRADE_RESOLUTION) · window 09:30–14:00 IST.
 */

const { EMA, RSI } = require("technicalindicators");
const { computeSuperTrend } = require("../utils/supertrend");

const NAME        = "SAR_EMA_RSI";
const DESCRIPTION = "SWING | EMA20/EMA50(close) + RSI + SuperTrend(10,3) | EMA alignment (2-EMA or 9>20>50 stack) + RSI gate + SuperTrend side | prev-candle/EMA21 trailing SL | thresholds via Settings";

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
 *           prevCandleHigh, rsi, ema9, ema20, ema50, ema21, supertrend, stTrend, signalStrength }.
 * signalStrength is always "STRONG" — there is no strength tier, but the field is
 * kept so the VIX gate's call shape (which only hard-blocks > VIX_MAX_ENTRY) is unchanged.
 */
function getSignal(candles, opts) {
  var silent = (opts && opts.silent === true);

  // EMA periods (close-based) — the fast/slow pair that gates direction.
  var EMA_FAST = parseInt(process.env.SWING_EMA_FAST || "20", 10) || 20;
  var EMA_SLOW = parseInt(process.env.SWING_EMA_SLOW || "50", 10) || 50;
  // Triple-stack (opt-in): require EMA(fastest) > EMA_FAST > EMA_SLOW (CE) / reverse (PE).
  // When OFF (default) the gate is the classic EMA_FAST-vs-EMA_SLOW cross.
  var TRIPLE_STACK  = (process.env.SWING_EMA_TRIPLE_STACK_ENABLED || "false").toLowerCase() === "true";
  var EMA_FASTEST   = parseInt(process.env.SWING_EMA_FASTEST || "9", 10) || 9;
  // Close-beyond-EMA gate (opt-in, default ON): the signal candle must CLOSE on the
  // trade side of a BASE EMA — EMA(fastest) when the triple stack is ON, else EMA(fast).
  // The stack/2-EMA gate only checks EMA *ordering*; without this, the strategy buys CE
  // into dips that close BELOW the base EMA while the lines stay stacked from an earlier
  // move (the 23-Jun midday-chop false breakouts: entered ~3–9pt below EMA9). The base
  // EMA's PERIOD is whatever its Settings value is (SWING_EMA_FASTEST / SWING_EMA_FAST) —
  // nothing hardcoded.
  var CLOSE_BEYOND_EMA = (process.env.SWING_CLOSE_BEYOND_EMA_ENABLED || "true").toLowerCase() === "true";
  // Warm-up: the slow EMA needs EMA_SLOW closes; +5 buffer for RSI/SuperTrend to settle.
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

  // Fastest EMA — computed ONLY when the triple-stack gate is enabled.
  var emaFastest = null;
  if (TRIPLE_STACK) {
    var emaFastestArr = EMA.calculate({ period: EMA_FASTEST, values: closes });
    emaFastest = emaFastestArr.length > 0 ? emaFastestArr[emaFastestArr.length - 1] : null;
  }

  // Base EMA for the close-beyond-EMA gate: fastest when stacked, else the fast EMA.
  // (Triple-stack ON → EMA9 base; OFF → EMA20 base — both per Settings periods.)
  var baseEma     = TRIPLE_STACK ? emaFastest : emaFast;
  var BASE_PERIOD = TRIPLE_STACK ? EMA_FASTEST : EMA_FAST;

  // EMA21 (OHLC4) — retained ONLY for the SL "ema" trail + record snapshot. Not an entry input.
  var ema21arr = EMA.calculate({ period: 21, values: ohlc4 });
  var ema21    = ema21arr.length > 0 ? ema21arr[ema21arr.length - 1] : null;

  var rsiArr = RSI.calculate({ period: 14, values: closes });
  var rsi    = rsiArr[rsiArr.length - 1];

  // ── Trend-confirmation source: SuperTrend(10,3) — the only directional gate. ──
  var ST_PERIOD = parseInt(process.env.SWING_SUPERTREND_PERIOD || "10", 10) || 10;
  var ST_MULT   = parseFloat(process.env.SWING_SUPERTREND_MULT || "3") || 3;
  var stArr  = computeSuperTrend(candles, ST_PERIOD, ST_MULT);
  var currST = stArr[stArr.length - 1];

  if (emaFast === null || emaSlow === null || rsi === undefined ||
      !currST || currST.trend == null ||
      (TRIPLE_STACK && emaFastest === null)) {
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
  // 1. EMA alignment. Default: fast-vs-slow cross. Triple-stack: fastest>fast>slow.
  var emaUp, emaDown;
  if (TRIPLE_STACK) {
    emaUp   = emaFastest > emaFast && emaFast > emaSlow;   // EMA9>EMA20>EMA50 — supports CE
    emaDown = emaFastest < emaFast && emaFast < emaSlow;   // EMA9<EMA20<EMA50 — supports PE
  } else {
    emaUp   = emaFast > emaSlow;   // EMA20 on top of EMA50 — supports CE
    emaDown = emaFast < emaSlow;   // EMA20 below EMA50      — supports PE
  }
  // 2. RSI band (unchanged).
  var rsiCE = rsi > RSI_CE_MIN && rsi < RSI_CE_MAX;  // above momentum floor, below overbought cap
  var rsiPE = rsi < RSI_PE_MAX && rsi > RSI_PE_MIN;  // below momentum cap, above oversold floor
  // 3. Directional confirmation from SuperTrend (trend===1 → line below price = CE; ===-1 = PE).
  var trendUp   = currST.trend === 1;
  var trendDown = currST.trend === -1;
  var _stVal    = currST.value;
  // EMA-alignment label for logs/reasons (stack-aware).
  var _emaUpLbl   = TRIPLE_STACK ? "EMA9>20>50" : "EMA20>50";
  var _emaDownLbl = TRIPLE_STACK ? "EMA9<20<50" : "EMA20<50";
  // 4. Close-beyond-EMA gate: the signal candle close must sit on the trade side of the
  //    base EMA (CE: above, PE: below). Disabled → always true (legacy ordering-only gate).
  var _baseLbl    = "EMA" + BASE_PERIOD;
  var closeOkCE   = !CLOSE_BEYOND_EMA || (baseEma != null && signalCandle.close > baseEma);
  var closeOkPE   = !CLOSE_BEYOND_EMA || (baseEma != null && signalCandle.close < baseEma);

  var base = {
    ema20:          Math.round(emaFast * 100) / 100,
    ema50:          Math.round(emaSlow * 100) / 100,
    // EMA9 populated only when the triple-stack gate is on (record snapshot; not always an input).
    ema9:           emaFastest != null ? Math.round(emaFastest * 100) / 100 : null,
    // EMA21 kept for SL "ema" trail + record continuity (not an entry input).
    ema21:          ema21 != null ? Math.round(ema21 * 100) / 100 : null,
    rsi:            Math.round(rsi * 10) / 10,
    // SuperTrend — the only directional source.
    supertrend:     currST.value,
    stTrend:        currST.trend === 1 ? "BULLISH" : "BEARISH",
    stTrendInt:     currST.trend,
    trendSource:    "SUPERTREND",
    prevCandleHigh: prevCandle.high,
    prevCandleLow:  prevCandle.low,
    // SL seed: previous (last completed) candle low (CE) / high (PE).
    // Set below once the side is known; null here for NONE.
    stopLoss:       null,
    signalStrength: "STRONG",
  };

  var _istTime = new Date(signalCandle.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  var _emaStr = TRIPLE_STACK
    ? "EMA9=" + emaFastest.toFixed(1) + " EMA20=" + emaFast.toFixed(1) + " EMA50=" + emaSlow.toFixed(1) + "(" + (emaUp ? "9>20>50" : emaDown ? "9<20<50" : "mixed") + ")"
    : "EMA20=" + emaFast.toFixed(1) + " EMA50=" + emaSlow.toFixed(1) + "(" + (emaUp ? "20>50" : emaDown ? "20<50" : "=") + ")";
  if (!silent) console.log(
    "[STRAT " + _istTime + "] " + _emaStr +
    " | RSI=" + rsi.toFixed(1) +
    " | ST=" + currST.value + "(" + (currST.trend === 1 ? "BULL" : "BEAR") + ")" +
    " | C=" + signalCandle.close
  );

  // ── BUY CE ────────────────────────────────────────────────────────────────
  if (emaUp && rsiCE && trendUp && closeOkCE) {
    var slCE = Math.round(prevCandle.low * 100) / 100;
    var _ceCloseTag = CLOSE_BEYOND_EMA ? " | C " + signalCandle.close + ">" + _baseLbl + " " + baseEma.toFixed(1) : "";
    if (!silent) console.log("  🟢 BUY_CE — " + _emaUpLbl + " | RSI " + rsi.toFixed(1) + ">" + RSI_CE_MIN + " | ST GREEN" + _ceCloseTag + " | SL(prevLow)=" + slCE);
    return Object.assign({}, base, {
      signal:   "BUY_CE",
      stopLoss: slCE,
      reason:   "CE: " + _emaUpLbl + " | RSI=" + rsi.toFixed(1) + ">" + RSI_CE_MIN + " | ST GREEN @ " + _stVal + _ceCloseTag + " | SL=prevLow " + slCE,
    });
  }

  // ── BUY PE ────────────────────────────────────────────────────────────────
  if (emaDown && rsiPE && trendDown && closeOkPE) {
    var slPE = Math.round(prevCandle.high * 100) / 100;
    var _peCloseTag = CLOSE_BEYOND_EMA ? " | C " + signalCandle.close + "<" + _baseLbl + " " + baseEma.toFixed(1) : "";
    if (!silent) console.log("  🔴 BUY_PE — " + _emaDownLbl + " | RSI " + rsi.toFixed(1) + "<" + RSI_PE_MAX + " | ST RED" + _peCloseTag + " | SL(prevHigh)=" + slPE);
    return Object.assign({}, base, {
      signal:   "BUY_PE",
      stopLoss: slPE,
      reason:   "PE: " + _emaDownLbl + " | RSI=" + rsi.toFixed(1) + "<" + RSI_PE_MAX + " | ST RED @ " + _stVal + _peCloseTag + " | SL=prevHigh " + slPE,
    });
  }

  // ── No signal — explain which condition(s) failed ─────────────────────────
  var why = [];
  if (emaUp) {
    // EMA bullish → only CE possible; report CE misses
    if (!rsiCE)   why.push("RSI=" + rsi.toFixed(1) + (rsi >= RSI_CE_MAX ? " >=" + RSI_CE_MAX + " (overbought)" : " <=" + RSI_CE_MIN + " (need >)"));
    if (!trendUp) why.push("ST not GREEN @ " + _stVal);
    if (CLOSE_BEYOND_EMA && !closeOkCE) why.push("C " + signalCandle.close + " <=" + _baseLbl + " " + (baseEma != null ? baseEma.toFixed(1) : "?") + " (need close above)");
  } else if (emaDown) {
    if (!rsiPE)     why.push("RSI=" + rsi.toFixed(1) + (rsi <= RSI_PE_MIN ? " <=" + RSI_PE_MIN + " (oversold)" : " >=" + RSI_PE_MAX + " (need <)"));
    if (!trendDown) why.push("ST not RED @ " + _stVal);
    if (CLOSE_BEYOND_EMA && !closeOkPE) why.push("C " + signalCandle.close + " >=" + _baseLbl + " " + (baseEma != null ? baseEma.toFixed(1) : "?") + " (need close below)");
  } else {
    why.push(TRIPLE_STACK ? "EMA stack not aligned (9/20/50)" : "EMA20=" + emaFast.toFixed(1) + " ≈ EMA50 " + emaSlow.toFixed(1) + " (no alignment)");
  }
  if (why.length === 0) why.push("EMA " + (emaUp ? _emaUpLbl : _emaDownLbl) + " but other conditions unmet");

  return Object.assign({}, base, {
    signal: "NONE",
    reason: why.join(" | ") + " | EMA " + (emaUp ? _emaUpLbl : emaDown ? _emaDownLbl : "flat"),
  });
}

module.exports = { NAME: NAME, DESCRIPTION: DESCRIPTION, getSignal: getSignal };

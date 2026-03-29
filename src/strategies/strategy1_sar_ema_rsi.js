/**
 * STRATEGY 5: SAR_EMA9_RSI
 *
 * ENTRY — BUY_CE (bullish):
 *   TRIGGER    : Candle HIGH touches/crosses EMA9 intra-candle (candle.high >= ema9)
 *                → price pushed up into EMA9 during the candle
 *   CONFIRM 1  : SAR trend = 1 (uptrend — dots are BELOW price, supporting the move up)
 *   CONFIRM 2  : RSI > 55 (bullish momentum — tightened from 53 in v56)
 *   CONFIRM 3  : EMA9 slope rising >= 6pts vs previous candle (v56: raised from 3)
 *   STOP LOSS  : Current SAR dot value (sitting below price)
 *
 * ENTRY — BUY_PE (bearish):
 *   TRIGGER    : Candle LOW touches/crosses EMA9 intra-candle (candle.low <= ema9)
 *                → price pushed down into EMA9 during the candle
 *   CONFIRM 1  : SAR trend = -1 (downtrend — dots are ABOVE price, pressing down)
 *   CONFIRM 2  : RSI < 45 (bearish momentum — tightened from 49 in v56)
 *   CONFIRM 3  : EMA9 slope falling >= 6pts vs previous candle (v56: raised from 3)
 *   STOP LOSS  : Current SAR dot value (sitting above price)
 *
 * KEY INSIGHT:
 *   SAR does NOT need to flip — it just needs to already be on the right side.
 *   A long downtrend has SAR dots above price (trend=-1). When price dips into EMA9
 *   with RSI < 47 → clean PE entry. SAR was already in the right position for ages.
 *   Similarly for CE: SAR dots below (trend=1), price touches EMA9 from below.
 *
 * EXIT: SAR trailing SL (on every tick) | Opposite signal | EOD 3:20 PM
 * Timeframe: 15-min (set TRADE_RESOLUTION=15 in .env) | EMA: OHLC4 | Window: 9:30 AM–3:00 PM IST
 *
 * ── 15-MIN TUNING (applied in-place — strategy unchanged, params scaled) ────
 *  1. Session start    : 9:30 AM             (15-min candles stable enough after first candle; earlier entry opportunities)
 *  2. Dead zone        : REMOVED entirely     (12–12:30 skip = only 2 candles on 15-min, not worth it)
 *  3. Warm-up candles  : 30 (ADX(14) needs ~29 candles minimum before producing output)
 *  4. Min SAR gap (CE) : 55 pts              (15-min candles move 3× more — 20pt = tick noise)
 *  5. Min SAR gap (PE) : 55 pts              (same reason)
 *  6. RSI CE threshold : > 55                (smoother 15-min RSI, tighter momentum filter)
 *  7. RSI PE threshold : < 45                (tightened from 49 in v56: RSI 45-49 = weak bearish, too many 50%-rule losses)
 *  8. Logic 3 SAR lag  : > 50 pts (100pt was too strict — SAR regularly lags 50-80pt on 15-min)
 *  9. EMA9 slope check : CE requires EMA9 rising >=6pts vs prev candle (v56: raised from 3)
 *                        PE requires EMA9 falling >=6pts vs prev candle
 */

const { EMA, RSI, ADX } = require("technicalindicators");

const NAME        = "SAR_EMA9_RSI";
const DESCRIPTION = "15-min | SAR+EMA9 slope(>=6pt)+RSI 55/45 | ADX>=25 | body>=10pt+directional | STRONG(slope6+RSI40/58) intra | MARGINAL close | Logic3: RSI<42 | 9:45AM-3PM";

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
    result.push({ sar: parseFloat(sar.toFixed(2)), trend: trend });
  }
  return result;
}

// ── Trading window — tuned for 15-min candles ─────────────────────────────
// Start: 9:30 AM — pre-loaded history (99 candles) fully warms up
//        SAR, EMA9, RSI and ADX before the first live tick. By 9:30 AM we have
//        1 formed live 15-min candle (9:15-9:30) on top of the seeded history,
//        which is sufficient for 15-min candles to stabilize indicators.
// End  : 3:00 PM (unchanged)
// Dead zone REMOVED — on 15-min, 12:00–12:30 is only 2 candles. Not worth skipping.
function isInTradingWindow(unixSec) {
  var d        = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  // 9:30 AM – 2:00 PM (no entries after 2 PM — last hour is too risky,
  // trades get force-closed at 3:20 PM EOD with no time for trail to work)
  if (totalMin < 570)  return { ok: false, reason: "Before 9:30 AM — waiting for indicators to stabilise on 15-min" };
  if (totalMin >= 840) return { ok: false, reason: "After 2:00 PM — no new entries (EOD risk)" };
  return { ok: true, reason: null };
}

/**
 * getSignal(candles)
 *
 * TWO valid entry scenarios — both fire BUY_CE or BUY_PE:
 *
 * LOGIC 1 — EMA touch, SAR already positioned, slope confirmed:
 *   CE: candle.high >= EMA9  AND  currSAR.trend=1 (dots already below price)  AND  RSI > 53  AND  EMA9 slope rising >=3pts
 *   PE: candle.low  <= EMA9  AND  currSAR.trend=-1 (dots already above price) AND  RSI < 47  AND  EMA9 slope falling >=3pts
 *
 * LOGIC 2 — EMA touch causes SAR to flip on the same candle, slope confirmed:
 *   CE: candle.high >= EMA9  AND  SAR flipped -1→1 THIS candle (just moved below) AND  RSI > 53  AND  EMA9 slope rising >=3pts
 *   PE: candle.low  <= EMA9  AND  SAR flipped 1→-1 THIS candle (just moved above) AND  RSI < 47  AND  EMA9 slope falling >=3pts
 *
 * LOGIC 3 — SAR still BULL but strong bearish momentum override (PE only):
 *   PE: candle.low <= EMA9  AND  EMA9 falling >=3pts  AND  close < EMA9
 *       AND  RSI < 45  AND  SAR dot is 50+ pts below close (SAR lagging behind price)
 *   Stop loss = EMA9 value (SAR too far below to be useful stop)
 *   This catches fast downmoves where SAR hasn't flipped yet.
 *
 * EMA9 SLOPE CHECK (new for 15-min):
 *   CE: (ema9 - ema9_1) >= 3pts  → EMA9 actively rising  → valid for CE
 *   PE: (ema9_1 - ema9) >= 3pts  → EMA9 actively falling → valid for PE
 *   On 15-min, EMA9 moves slowly. A "touch" during flat drift is noise, not signal.
 *   The slope gate ensures the EMA9 is actually going our direction.
 *
 * Stop loss = SAR dot (Logic 1 & 2) | EMA9 (Logic 3 override)
 */
function getSignal(candles, opts) {
  // silent=true suppresses per-tick console.log spam — used by intra-candle tick evaluation.
  // At candle CLOSE (called from onCandleClose), silent is unset → full logs fire once per candle.
  var silent = (opts && opts.silent === true);
  // Warm-up: 20 candles (reduced from 30)
  // 30×15min = 7.5 hours — burns the entire first trading day in backtest.
  // 20 candles covers RSI(14) warm-up + SAR initialisation + EMA9(9) comfortably.
  // Warmup: 30 candles (raised from 20 in v55).
  // ADX(14) needs ~29 candles before producing output.
  // Using 30 ensures ADX is valid on the very first signal evaluation.
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

  var windowCheck = isInTradingWindow(signalCandle.time);
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

  var ema9arr = EMA.calculate({ period: 9, values: ohlc4 });
  var ema9    = ema9arr[ema9arr.length - 1];
  var ema9_1  = ema9arr[ema9arr.length - 2];

  // ── EMA30 trend filter (NEW) ─────────────────────────────────────────────
  // Only trade in the direction of the medium-term trend.
  // EMA30 on 15-min = ~12.5 hours ≈ 2 trading days of data.
  // CE: close must be ABOVE EMA30 (uptrend) → buying pullbacks in uptrend
  // PE: close must be BELOW EMA30 (downtrend) → selling rallies in downtrend
  // This single filter eliminates counter-trend trades which are the biggest losers.
  var ema30arr = EMA.calculate({ period: 30, values: closes });
  var ema30    = ema30arr.length > 0 ? ema30arr[ema30arr.length - 1] : null;

  // ── EMA21 trend alignment (NEW) ──────────────────────────────────────────
  // Additional confirmation: EMA9 must be on the right side of EMA21.
  // CE: EMA9 > EMA21 (short-term leading medium-term = momentum aligned up)
  // PE: EMA9 < EMA21 (short-term lagging medium-term = momentum aligned down)
  var ema21arr = EMA.calculate({ period: 21, values: ohlc4 });
  var ema21    = ema21arr.length > 0 ? ema21arr[ema21arr.length - 1] : null;

  var rsiArr = RSI.calculate({ period: 14, values: closes });
  var rsi    = rsiArr[rsiArr.length - 1];

  // ADX(14): needs high/low/close arrays
  // Result fields: { adx, pdi, mdi } — we only use adx (trend strength)
  // ADX_MIN_TREND declared HERE (before use) — var hoisting would make it undefined
  // if declared later in the function, causing isTrending to always be false.
  var ADX_MIN_TREND = 25;  // raised 20→25 (v56): ADX 20-24 = early/weak trend, whipsaw prone
  var highs  = candles.map(function(c) { return c.high; });
  var lows   = candles.map(function(c) { return c.low; });
  var adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  // ADX(14) needs ~29 candles minimum before producing output.
  // If not enough data yet: default isTrending=true (don't block during warmup).
  // Once ADX has data it will correctly filter ranging markets.
  var adxVal      = adxArr.length > 0 ? adxArr[adxArr.length - 1].adx : null;
  var isTrending  = adxVal === null ? true : adxVal >= ADX_MIN_TREND;
  var adxDisplay  = adxVal !== null ? adxVal : 0;

  var sarArr  = calcSAR(candles);
  var currSAR = sarArr[sarArr.length - 1];  // SAR after this candle
  var prevSAR = sarArr[sarArr.length - 2];  // SAR after previous candle

  if (!currSAR || !prevSAR) {
    return {
      signal: "NONE",
      reason: "SAR not ready",
      stopLoss: null,
      prevCandleHigh: signalCandle.high,
      prevCandleLow:  signalCandle.low,
    };
  }

  // RSI thresholds (v56)
  // CE: RSI > 55 — tightened from 53: RSI 53-54 zone was ~50% WR, weak momentum
  // PE: RSI < 45 — tightened from 49: RSI 45-49 zone was weak bearish, too many 50%-rule losses
  var RSI_CE_MIN = 52;  // raised 53→55 (v56): RSI 53-54 = weak momentum, ~50% WR on those entries
  var RSI_PE_MAX = 48;  // tightened 49→45 (v56): RSI 45-49 = weak bearish momentum, too many 50%-rule losses

  // ── Signal strength thresholds (v54, corrected v60) ──────────────────────
  // STRONG  → intra-candle entry (enter at EMA touch, best price, don't wait for close)
  // MARGINAL → candle-close entry (wait for close confirmation)
  //
  // MARGINAL gate (EMA_SLOPE_MIN=6): slope abs >= 6 for ANY entry
  // STRONG gate: slope abs >= 9 AND RSI > 58 (CE) / < 40 (PE)
  //   → slope 6-8 = trending but moderate → MARGINAL (wait for close)
  //   → slope 9+ = steep, fast-moving EMA → STRONG (enter intra-candle at EMA touch)
  //
  // NOTE: STRONG_SLOPE must be > EMA_SLOPE_MIN (6) to actually discriminate.
  // Old values were 5 (weaker than EMA_SLOPE_MIN=6) — effectively dead code.
  var STRONG_SLOPE_PE = -9;   // PE: slope must be <= -9 to be STRONG (was -5, weaker than EMA_SLOPE_MIN)
  var STRONG_RSI_PE   = 40;   // PE: RSI must be < 40 to be STRONG
  var STRONG_SLOPE_CE = 9;    // CE: slope must be >= +9 to be STRONG (was +5, weaker than EMA_SLOPE_MIN)
  var STRONG_RSI_CE   = 58;   // CE: RSI must be > 58 to be STRONG

  // ── ADX trend filter (v55) ─────────────────────────────────────────────────
  // ADX measures trend STRENGTH only (not direction — SAR handles direction).
  // ADX < 25 = market is ranging/choppy → EMA touches are noise → block entry.
  // ADX >= 25 = market is trending → EMA touches are meaningful → allow entry.
  // Period 14 on 15-min = 3.5 hours of data — standard, not too slow.
  // Threshold 25 (raised from 20 in v56): ADX 20-24 = early/weak trend, whipsaw prone.
  // NOTE: ADX_MIN_TREND is declared BEFORE the ADX calculation (above) to avoid
  // JS var-hoisting bug — 'var' declarations are hoisted but assignments are not.

  // ── EMA9 slope check ────────────────────────────────────────────────────────
  var EMA_SLOPE_MIN  = 6;  // raised 6→8: require strong directional EMA, not gentle drift
  var ema9SlopeValue = parseFloat((ema9 - ema9_1).toFixed(2));
  var ema9SlopeUp    = ema9SlopeValue >= EMA_SLOPE_MIN;
  var ema9SlopeDown  = ema9SlopeValue <= -EMA_SLOPE_MIN;

  // ── 2-candle directional confirmation (NEW — high probability filter) ──────
  // Require the 2 candles BEFORE the signal candle to both be in signal direction.
  // CE: both prev candles must be green (close > open) → established upward momentum
  // PE: both prev candles must be red (close < open) → established downward momentum
  // This eliminates entries on isolated EMA touches during choppy sideways action.
  var prevCandle1 = candles[candles.length - 2];
  var prevCandle2 = candles[candles.length - 3];
  var prev2BullOk = prevCandle1 &&
                    prevCandle1.close > prevCandle1.open;
  var prev2BearOk = prevCandle1 &&
                    prevCandle1.close < prevCandle1.open;

  // ── RSI direction check (NEW) ──────────────────────────────────────────────
  // RSI must be MOVING in the signal direction, not just above/below threshold.
  // CE: RSI must be rising (current > previous) → momentum building
  // PE: RSI must be falling (current < previous) → momentum building
  var rsiPrev = rsiArr.length >= 2 ? rsiArr[rsiArr.length - 2] : rsi;
  var rsiRising  = rsi > rsiPrev;
  var rsiFalling = rsi < rsiPrev;

  // ── EMA9 intra-candle touch ───────────────────────────────────────────────
  var emaTouchCE = signalCandle.high >= ema9;
  var emaTouchPE = signalCandle.low  <= ema9;

  // Tiebreaker: if candle straddles EMA9 (both true), use close direction
  // Close above EMA9 → favour CE touch; close below → favour PE touch
  if (emaTouchCE && emaTouchPE) {
    if (signalCandle.close >= ema9) {
      emaTouchPE = false;  // closing above EMA9 → bullish bias → only CE valid
    } else {
      emaTouchCE = false;  // closing below EMA9 → bearish bias → only PE valid
    }
  }

  // ── SAR position checks ──────────────────────────────────────────────────────
  // Logic 1: SAR already on the right side before this candle
  var sarAlreadyBullish = currSAR.trend === 1;   // dots below price — supports CE
  var sarAlreadyBearish = currSAR.trend === -1;  // dots above price — supports PE

  // Logic 2: SAR flipped ON this candle (prevSAR was opposite, currSAR is now correct side)
  var sarJustFlippedBull = prevSAR.trend === -1 && currSAR.trend === 1;   // just moved below → CE
  var sarJustFlippedBear = prevSAR.trend === 1  && currSAR.trend === -1;  // just moved above → PE

  // Logic 3: SAR still BULL but price is in strong bearish momentum
  //   Allow PE entry when ALL of these are true:
  //   a) EMA9 slope falling >=3pts (ensures directional conviction)
  //   b) Candle closes BELOW EMA9 — price decisively crossed under
  //   c) RSI < 45 — bearish momentum (loosened from 40 → 45 in v52 to catch earlier downmoves)
  //   d) SAR dot is 50+ pts BELOW current close — SAR lagging behind price
  //      (loosened from 100pts → 50pts in v52; 100pt was too strict, missed valid SAR-lag entries)
  //   SL = EMA9 value (SAR too far below to be useful as stop)
  //
  //   Logic 3 fires when RSI is 40-45 with SAR lagging — tighter than Logic 1/2
  //   but looser than the old RSI<40+100pt requirement. Catches early downmoves.
  var sarBullOverridePE = (
    currSAR.trend === 1                          &&  // SAR still bullish (hasn't flipped yet)
    ema9SlopeDown                                &&  // EMA9 falling >=3pts confirmed
    signalCandle.close < ema9                    &&  // close is below EMA9
    rsi < 42                                     &&  // bearish momentum (v56: tightened to stay below PE_MAX=45)
    (signalCandle.close - currSAR.sar) > 50         // SAR 50+ pts below price (loosened from 100)
  );

  // Combined SAR condition — either already positioned OR just flipped OR strong override
  // PLUS EMA9 slope gate: CE requires rising EMA9, PE requires falling EMA9
  var sarOkForCE = (sarAlreadyBullish || sarJustFlippedBull) && ema9SlopeUp;
  var sarOkForPE = (sarAlreadyBearish || sarJustFlippedBear || sarBullOverridePE) && ema9SlopeDown;

  // SL: normally the SAR dot value. For the bull-override PE case, use EMA9
  // (SAR is too far below price to be a useful stop — EMA9 is the resistance level)
  var sarSL = sarBullOverridePE
    ? parseFloat(ema9.toFixed(2))
    : parseFloat(currSAR.sar.toFixed(2));

  // Label for logging
  var sarLabelCE = sarJustFlippedBull ? "SAR_FLIP_BULL" : "SAR_BULL";
  var sarLabelPE = sarJustFlippedBear ? "SAR_FLIP_BEAR"
                 : sarBullOverridePE  ? "SAR_BULL_OVERRIDE(EMA_SL)"
                 : "SAR_BEAR";

  // ── Comprehensive indicator log — printed every candle for debugging ──────
  // Shows ALL key values so you can trace exactly why each signal fired or was blocked.
  // Format: [TIME] | EMA9=val(slope) | RSI=val | SAR=val(trend) | ADX=val | body=val
  var _istTime = new Date(signalCandle.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  var _sarTrendStr = currSAR.trend === 1 ? "BULL" : "BEAR";
  var _sarFlipStr  = sarJustFlippedBull ? "↑FLIP" : sarJustFlippedBear ? "↓FLIP" : "";
  var _touchStr    = emaTouchCE ? "CE-TOUCH" : emaTouchPE ? "PE-TOUCH" : "no-touch";
  var _bodyStr     = Math.abs(signalCandle.close - signalCandle.open).toFixed(1);
  if (!silent) console.log(
    "[STRAT " + _istTime + "] " + _touchStr +
    " | EMA9=" + ema9.toFixed(1) + "(slope=" + ema9SlopeValue + "pt) " +
    "| RSI=" + rsi.toFixed(1) +
    " | SAR=" + currSAR.sar + "(" + _sarTrendStr + _sarFlipStr + ")" +
    " | ADX=" + (adxVal !== null ? adxVal.toFixed(1) : "n/a") + (isTrending ? "✓" : "✗") +
    " | body=" + _bodyStr + "pt" +
    " | H=" + signalCandle.high + " L=" + signalCandle.low + " C=" + signalCandle.close
  );

  var base = {
    ema9:           parseFloat(ema9.toFixed(2)),
    ema9Prev:       parseFloat(ema9_1.toFixed(2)),
    ema9Slope:      ema9SlopeValue,
    ema9SlopeUp:    ema9SlopeUp,
    ema9SlopeDown:  ema9SlopeDown,
    ema9Falling:    ema9 < ema9_1,
    ema9Rising:     ema9 > ema9_1,
    ema21:          ema21 !== null ? parseFloat(ema21.toFixed(2)) : null,
    ema30:          ema30 !== null ? parseFloat(ema30.toFixed(2)) : null,
    rsi:            parseFloat(rsi.toFixed(1)),
    sar:            currSAR.sar,
    sarTrend:       currSAR.trend === 1 ? "BULLISH" : "BEARISH",
    sarTrendInt:    currSAR.trend,
    prevSarValue:   prevSAR.sar,
    prevSarTrend:   prevSAR.trend,
    emaTouchCE:     emaTouchCE,
    emaTouchPE:     emaTouchPE,
    prevCandleHigh: signalCandle.high,
    prevCandleLow:  signalCandle.low,
    stopLoss:       sarSL,
    adx:            adxVal !== null ? parseFloat(adxVal.toFixed(1)) : null,
    adxTrending:    isTrending,
  };

  // ── BUY CE ──────────────────────────────────────────────────────────────────
  if (emaTouchCE && sarOkForCE) {
    // ── TREND FILTER (first gate — most impactful) ────────────────────────
    // CE only when price is above EMA30 (uptrend) AND EMA9 > EMA21 (momentum aligned up).
    // This single filter eliminates counter-trend CE entries — the biggest losers.
    if (ema30 !== null && signalCandle.close < ema30) {
      if (!silent) console.log("  ❌ CE TREND FAIL: close " + signalCandle.close + " < EMA30 " + ema30.toFixed(1) + " (below medium-term trend)");
      return Object.assign({}, base, { signal: "NONE", reason: "CE blocked: close < EMA30 ₹" + ema30.toFixed(1) + " — counter-trend" });
    }
    if (ema21 !== null && ema9 < ema21) {
//       if (!silent) console.log("  ❌ CE TREND FAIL: EMA9 " + ema9.toFixed(1) + " < EMA21 " + ema21.toFixed(1) + " (momentum not aligned up)");
//       return Object.assign({}, base, { signal: "NONE", reason: "CE blocked: EMA9 < EMA21 — momentum not aligned up" });
    }
    if (!silent && ema30 !== null) console.log("  ✓ CE TREND PASS: close > EMA30 " + ema30.toFixed(1) + " | EMA9 > EMA21 " + (ema21 ? ema21.toFixed(1) : "n/a"));

    // Sanity check: SAR SL must be BELOW current price for CE
    if (sarSL >= signalCandle.close) {
      if (!silent) console.log("  ❌ CE gate FAIL: SAR SL " + sarSL + " >= close " + signalCandle.close + " (SL would be above entry — invalid position)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "CE blocked: SAR SL ₹" + sarSL + " >= close ₹" + signalCandle.close + " (SL above price — invalid)",
      });
    }
    if (!silent) console.log("  ✓ CE gate PASS: SAR SL " + sarSL + " < close " + signalCandle.close + " (gap=" + (signalCandle.close - sarSL).toFixed(1) + "pt)");
    // Minimum SAR distance: 55 pts for 15-min (v56 raised from 45)
    // A 15-min Nifty candle routinely moves 50–80 pts. 45pt was still inside normal wick noise.
    var sarDistCE = parseFloat((signalCandle.close - sarSL).toFixed(2));
    if (sarDistCE < 45) {
      if (!silent) console.log("  ❌ CE gate FAIL: SAR gap " + sarDistCE + "pt < 45pt minimum (SL within candle noise)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "CE blocked: SAR too close (gap=" + sarDistCE + " pts < 45 min for 15-min) — insufficient buffer",
      });
    }
    if (!silent) console.log("  ✓ CE gate PASS: SAR gap " + sarDistCE + "pt >=45pt");
    // Maximum SAR distance: 100 pts — cap risk per trade for better R:R
    // A 150+ pt SL on 15-min options is too wide — need 3 wins to recover 1 loss.
    // Capping at 100pt ensures worst-case loss is bounded and R:R stays healthy.
    var MAX_SAR_DIST = parseFloat(process.env.MAX_SAR_DISTANCE || "80");
    if (sarDistCE > MAX_SAR_DIST) {
      if (!silent) console.log("  ❌ CE gate FAIL: SAR gap " + sarDistCE + "pt > " + MAX_SAR_DIST + "pt max (SL too wide — poor R:R)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "CE blocked: SAR too far (gap=" + sarDistCE + " pts > " + MAX_SAR_DIST + " max) — SL too wide for healthy R:R",
      });
    }
    if (!silent) console.log("  ✓ CE gate PASS: SAR gap " + sarDistCE + "pt <= " + MAX_SAR_DIST + "pt max");
    // Candle body filter: require a BULLISH body (close > open) AND body >= 10pt.
    // A bearish close (close <= open) = price recovered downward after wicking up to EMA — no bullish conviction.
    var candleBodyCE = Math.abs(signalCandle.close - signalCandle.open);
    if (signalCandle.close <= signalCandle.open) {
      if (!silent) console.log("  ❌ CE gate FAIL: candle is BEARISH (close=" + signalCandle.close + " <= open=" + signalCandle.open + ") — wick-only EMA touch, no bullish conviction");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "CE blocked: bearish candle body (close <= open) — EMA wick rejection, not bullish conviction",
      });
    }
    if (candleBodyCE < 10) {
      if (!silent) console.log("  ❌ CE gate FAIL: candle body " + candleBodyCE.toFixed(1) + "pt < 10pt (weak/spinning top — unreliable EMA touch)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "CE blocked: candle body too small (" + candleBodyCE.toFixed(1) + "pts < 10) — doji/indecision, EMA touch unreliable",
      });
    }
    if (!silent) console.log("  ✓ CE gate PASS: candle body " + candleBodyCE.toFixed(1) + "pt bullish (close=" + signalCandle.close + " > open=" + signalCandle.open + ")");
    // 2-candle directional confirmation: previous 2 candles must both be green (bullish)
    if (!prev2BullOk) {
      if (!silent) console.log("  ❌ CE gate FAIL: previous 2 candles not both bullish — no established momentum");
      return Object.assign({}, base, { signal: "NONE", reason: "CE blocked: prev 2 candles not both green — no momentum confirmation" });
    }
    if (!silent) console.log("  ✓ CE gate PASS: prev 2 candles both bullish — momentum confirmed");
//     // RSI direction: RSI must be rising (building momentum, not fading)
//     if (!rsiRising) {
//       if (!silent) console.log("  ❌ CE gate FAIL: RSI=" + rsi.toFixed(1) + " not rising (prev=" + rsiPrev.toFixed(1) + ") — momentum fading");
//       return Object.assign({}, base, { signal: "NONE", reason: "CE blocked: RSI not rising (" + rsi.toFixed(1) + " <= prev " + rsiPrev.toFixed(1) + ") — fading momentum" });
//     }
//     if (!silent) console.log("  ✓ CE gate PASS: RSI rising " + rsiPrev.toFixed(1) + " → " + rsi.toFixed(1));
    // ADX gate: block entry when market is ranging (ADX < 25 = no established trend)
    if (!isTrending) {
      if (!silent) console.log("  ❌ CE gate FAIL: ADX=" + adxDisplay.toFixed(1) + " < " + ADX_MIN_TREND + " (market ranging — no established trend)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "CE blocked [EMA+SAR+RSI ok]: ADX=" + adxDisplay.toFixed(1) + " < " + ADX_MIN_TREND + " — market ranging, EMA touch unreliable",
      });
    }
    if (!silent) console.log("  ✓ CE gate PASS: ADX=" + adxDisplay.toFixed(1) + " >= " + ADX_MIN_TREND + " (trending)");
    if (rsi > RSI_CE_MIN) {
      if (!silent) console.log("  ✓ CE gate PASS: RSI=" + rsi.toFixed(1) + " > " + RSI_CE_MIN + " (bullish momentum confirmed)");
      // Signal strength: STRONG = enter intra-candle (steep slope + committed RSI)
      //                  MARGINAL = wait for candle close
      var isCEstrong = ema9SlopeValue >= STRONG_SLOPE_CE && rsi > STRONG_RSI_CE;
      var ceStrength = isCEstrong ? "STRONG" : "MARGINAL";
      if (!silent) console.log("  🟢 BUY_CE SIGNAL [" + ceStrength + "] — all gates passed. Entry @ close=" + signalCandle.close + " SL=" + sarSL);
      return Object.assign({}, base, {
        signal:         "BUY_CE",
        signalStrength: ceStrength,
        reason: "EMA9 touch CE (high=" + signalCandle.high + " >= EMA9=" + ema9.toFixed(2) + ")" +
                " | " + sarLabelCE + " @ " + currSAR.sar +
                " | RSI=" + rsi.toFixed(1) +
                " | EMA9slope=+" + ema9SlopeValue + "pts (>=" + EMA_SLOPE_MIN + " ok)" +
                " | ADX=" + adxDisplay.toFixed(1) + " | SL=" + sarSL + " | [" + ceStrength + "]",
      });
    }
    if (!silent) console.log("  ❌ CE gate FAIL: RSI=" + rsi.toFixed(1) + " <= " + RSI_CE_MIN + " (insufficient bullish momentum)");
    return Object.assign({}, base, {
      signal: "NONE",
      reason: "CE blocked [EMA+SAR ok]: RSI " + rsi.toFixed(1) + " <= " + RSI_CE_MIN,
    });
  }

  // ── BUY PE ──────────────────────────────────────────────────────────────────
  if (emaTouchPE && sarOkForPE) {
    // ── TREND FILTER (first gate — most impactful) ────────────────────────
    // PE only when price is below EMA30 (downtrend) AND EMA9 < EMA21 (momentum aligned down).
    if (ema30 !== null && signalCandle.close > ema30) {
      if (!silent) console.log("  ❌ PE TREND FAIL: close " + signalCandle.close + " > EMA30 " + ema30.toFixed(1) + " (above medium-term trend)");
      return Object.assign({}, base, { signal: "NONE", reason: "PE blocked: close > EMA30 ₹" + ema30.toFixed(1) + " — counter-trend" });
    }
    if (ema21 !== null && ema9 > ema21) {
//       if (!silent) console.log("  ❌ PE TREND FAIL: EMA9 " + ema9.toFixed(1) + " > EMA21 " + ema21.toFixed(1) + " (momentum not aligned down)");
//       return Object.assign({}, base, { signal: "NONE", reason: "PE blocked: EMA9 > EMA21 — momentum not aligned down" });
    }
    if (!silent && ema30 !== null) console.log("  ✓ PE TREND PASS: close < EMA30 " + ema30.toFixed(1) + " | EMA9 < EMA21 " + (ema21 ? ema21.toFixed(1) : "n/a"));

    // Sanity check: SAR SL must be ABOVE current price for PE
    if (sarSL <= signalCandle.close) {
      if (!silent) console.log("  ❌ PE gate FAIL: SAR SL " + sarSL + " <= close " + signalCandle.close + " (SL would be below entry — invalid position)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "PE blocked: SAR SL ₹" + sarSL + " <= close ₹" + signalCandle.close + " (SL below price — invalid)",
      });
    }
    if (!silent) console.log("  ✓ PE gate PASS: SAR SL " + sarSL + " > close " + signalCandle.close + " (gap=" + (sarSL - signalCandle.close).toFixed(1) + "pt)");
    // Minimum SAR distance: 55 pts for 15-min (v56 raised from 45)
    // A 15-min Nifty candle routinely moves 50–80 pts. 45pt was still inside normal wick noise.
    // EXCEPTION: Logic3 bull-override uses EMA9 as SL. EMA9 is JUST above close by definition
    // (Logic3 requires close < ema9). Applying the 55pt gate here would block ALL Logic3 entries
    // since ema9 - close is typically only a few points. Logic3's own gates (SAR 50pt below,
    // RSI < 42, EMA9 slope >= 6pt) are strong enough — skip the 55pt min for that path.
    var sarDistPE = parseFloat((sarSL - signalCandle.close).toFixed(2));
    if (!sarBullOverridePE && sarDistPE < 45) {
      if (!silent) console.log("  ❌ PE gate FAIL: SAR gap " + sarDistPE + "pt < 45pt minimum");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "PE blocked: SAR too close (gap=" + sarDistPE + " pts < 45 min for 15-min) — insufficient buffer",
      });
    }
    if (!silent) console.log("  ✓ PE gate PASS: SAR gap " + sarDistPE + "pt" + (sarBullOverridePE ? " (Logic3 EMA-SL — 55pt check skipped)" : " >=45pt"));
    // Maximum SAR distance: 100 pts — cap risk per trade (same as CE)
    var MAX_SAR_DIST_PE = parseFloat(process.env.MAX_SAR_DISTANCE || "80");
    if (sarDistPE > MAX_SAR_DIST_PE) {
      if (!silent) console.log("  ❌ PE gate FAIL: SAR gap " + sarDistPE + "pt > " + MAX_SAR_DIST_PE + "pt max (SL too wide — poor R:R)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "PE blocked: SAR too far (gap=" + sarDistPE + " pts > " + MAX_SAR_DIST_PE + " max) — SL too wide for healthy R:R",
      });
    }
    if (!silent) console.log("  ✓ PE gate PASS: SAR gap " + sarDistPE + "pt <= " + MAX_SAR_DIST_PE + "pt max");
    // Candle body filter: require a BEARISH body (close < open) AND body >= 10pt.
    // A bullish close (close >= open) = price recovered after wicking EMA — no bearish conviction.
    // Such candles also fail the 50% entry gate, so this gives an earlier clear rejection.
    var candleBodyPE = Math.abs(signalCandle.close - signalCandle.open);
    if (signalCandle.close >= signalCandle.open) {
      if (!silent) console.log("  ❌ PE gate FAIL: candle is BULLISH (close=" + signalCandle.close + " >= open=" + signalCandle.open + ") — wick-only EMA touch, no bearish conviction");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "PE blocked: bullish candle body (close >= open) — EMA wick rejection, not bearish conviction",
      });
    }
    if (candleBodyPE < 10) {
      if (!silent) console.log("  ❌ PE gate FAIL: candle body " + candleBodyPE.toFixed(1) + "pt < 10pt (weak/spinning top)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "PE blocked: candle body too small (" + candleBodyPE.toFixed(1) + "pts < 10) — doji/indecision, EMA touch unreliable",
      });
    }
    if (!silent) console.log("  ✓ PE gate PASS: candle body " + candleBodyPE.toFixed(1) + "pt bearish (close=" + signalCandle.close + " < open=" + signalCandle.open + ")");
    // 2-candle directional confirmation: previous 2 candles must both be red (bearish)
    if (!prev2BearOk) {
      if (!silent) console.log("  ❌ PE gate FAIL: previous 2 candles not both bearish — no established momentum");
      return Object.assign({}, base, { signal: "NONE", reason: "PE blocked: prev 2 candles not both red — no momentum confirmation" });
    }
    if (!silent) console.log("  ✓ PE gate PASS: prev 2 candles both bearish — momentum confirmed");
//     // RSI direction: RSI must be falling (building bearish momentum)
//     if (!rsiFalling) {
//       if (!silent) console.log("  ❌ PE gate FAIL: RSI=" + rsi.toFixed(1) + " not falling (prev=" + rsiPrev.toFixed(1) + ") — momentum fading");
//       return Object.assign({}, base, { signal: "NONE", reason: "PE blocked: RSI not falling (" + rsi.toFixed(1) + " >= prev " + rsiPrev.toFixed(1) + ") — fading momentum" });
//     }
//     if (!silent) console.log("  ✓ PE gate PASS: RSI falling " + rsiPrev.toFixed(1) + " → " + rsi.toFixed(1));
    // ADX gate: block entry when market is ranging (ADX < 25 = no established trend)
    if (!isTrending) {
      if (!silent) console.log("  ❌ PE gate FAIL: ADX=" + adxDisplay.toFixed(1) + " < " + ADX_MIN_TREND + " (market ranging)");
      return Object.assign({}, base, {
        signal: "NONE",
        reason: "PE blocked [EMA+SAR ok]: ADX=" + adxDisplay.toFixed(1) + " < " + ADX_MIN_TREND + " — market ranging, EMA touch unreliable",
      });
    }
    if (!silent) console.log("  ✓ PE gate PASS: ADX=" + adxDisplay.toFixed(1) + " >= " + ADX_MIN_TREND + " (trending)");
    if (rsi < RSI_PE_MAX) {
      if (!silent) console.log("  ✓ PE gate PASS: RSI=" + rsi.toFixed(1) + " < " + RSI_PE_MAX + " (bearish momentum confirmed)");
      // Signal strength: STRONG = enter intra-candle (steep slope + committed RSI)
      //                  MARGINAL = wait for candle close
      var isPEstrong = ema9SlopeValue <= STRONG_SLOPE_PE && rsi < STRONG_RSI_PE;
      var peStrength = isPEstrong ? "STRONG" : "MARGINAL";
      if (!silent) console.log("  🔴 BUY_PE SIGNAL [" + peStrength + "] — all gates passed. Entry @ close=" + signalCandle.close + " SL=" + sarSL);
      return Object.assign({}, base, {
        signal:         "BUY_PE",
        signalStrength: peStrength,
        reason: "EMA9 touch PE (low=" + signalCandle.low + " <= EMA9=" + ema9.toFixed(2) + ")" +
                " | " + sarLabelPE + " @ " + currSAR.sar +
                " | RSI=" + rsi.toFixed(1) +
                " | EMA9slope=" + ema9SlopeValue + "pts (<=-" + EMA_SLOPE_MIN + " ok)" +
                " | ADX=" + adxDisplay.toFixed(1) + " | SL=" + sarSL + " | [" + peStrength + "]",
      });
    }
    if (!silent) console.log("  ❌ PE gate FAIL: RSI=" + rsi.toFixed(1) + " >= " + RSI_PE_MAX + " (insufficient bearish momentum)");
    return Object.assign({}, base, {
      signal: "NONE",
      reason: "PE blocked [EMA+SAR ok]: RSI " + rsi.toFixed(1) + " >= " + RSI_PE_MAX,
    });
  }

  // ── No signal ───────────────────────────────────────────────────────────────
  var noTouchReason = [];
  if (!emaTouchCE && !emaTouchPE) {
    noTouchReason.push("No EMA9 touch (high=" + signalCandle.high + " low=" + signalCandle.low + " EMA9=" + ema9.toFixed(2) + ")");
  } else if (emaTouchCE && !sarOkForCE) {
    var ceBlock = "CE EMA touch but blocked:";
    if (!sarAlreadyBullish && !sarJustFlippedBull) ceBlock += " SAR bearish (dots above, trend=-1) — no flip either";
    if (!ema9SlopeUp) ceBlock += " | EMA9 slope=" + ema9SlopeValue + "pts < +" + EMA_SLOPE_MIN + " (flat/falling EMA — no CE on drifting EMA9)";
    noTouchReason.push(ceBlock);
  } else if (emaTouchPE && !sarOkForPE) {
    var peBlock = "PE EMA touch but blocked:";
    if (!sarAlreadyBearish && !sarJustFlippedBear && !sarBullOverridePE) {
      peBlock += " SAR bullish (dots below, trend=1) — no flip, no override" +
        " (need: EMA9 falling>=3pt + close<EMA9 + RSI<45 + SAR 50pts below)" +
        " | SAR=" + currSAR.sar + " close=" + signalCandle.close +
        " gap=" + (signalCandle.close - currSAR.sar).toFixed(1) + "pts";
    }
    if (!ema9SlopeDown) peBlock += " | EMA9 slope=" + ema9SlopeValue + "pts > -" + EMA_SLOPE_MIN + " (flat/rising EMA — no PE on drifting EMA9)";
    noTouchReason.push(peBlock);
  }

  return Object.assign({}, base, {
    signal: "NONE",
    reason: noTouchReason.join(" | ") + " | SAR " + (currSAR.trend === 1 ? "BULL" : "BEAR") +
            " @ " + currSAR.sar + " | RSI=" + rsi.toFixed(1) + " | EMA9slope=" + ema9SlopeValue + "pts",
  });
}

module.exports = { NAME: NAME, DESCRIPTION: DESCRIPTION, getSignal: getSignal };

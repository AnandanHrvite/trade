/**
 * SuperTrend(period, multiplier) — ATR-banded trend indicator.
 *
 * Built on the `technicalindicators` ATR primitive (the package has no
 * SuperTrend), mirroring how the Swing strategy hand-rolls SAR on top of the
 * same package. Default 10 / 3 (the classic NIFTY scalper/swing setting).
 *
 * Returns an array aligned 1:1 with the input candles. Each element is
 * { value, trend } where:
 *   trend =  1 → bullish, SuperTrend line is BELOW price (acts as support / SL)
 *   trend = -1 → bearish, SuperTrend line is ABOVE price (acts as resistance / SL)
 * Warm-up bars (before ATR has enough history) are { value: null, trend: null }.
 *
 * A "flip" is when trend changes sign on candle close — the SuperTrend analogue
 * of a PSAR flip. The `value` is the active band the line sits on, so it doubles
 * as a stop-loss level exactly like PSAR does for the scalp engine.
 */

const { ATR } = require("technicalindicators");

function computeSuperTrend(candles, period, multiplier) {
  period     = period     || 10;
  multiplier = multiplier || 3;

  var n = candles.length;
  var out = new Array(n);
  for (var z = 0; z < n; z++) out[z] = { value: null, trend: null };
  if (n < period + 1) return out;

  var high  = candles.map(function (c) { return c.high; });
  var low   = candles.map(function (c) { return c.low; });
  var close = candles.map(function (c) { return c.close; });

  // ATR.calculate returns (n - period) values; atrArr[k] aligns to candle k+period.
  var atrArr = ATR.calculate({ period: period, high: high, low: low, close: close });
  if (!atrArr.length) return out;

  var prevFinalUpper = 0, prevFinalLower = 0, prevST = 0;

  for (var k = 0; k < atrArr.length; k++) {
    var i   = k + period;             // candle index this ATR value belongs to
    var atr = atrArr[k];
    var hl2 = (high[i] + low[i]) / 2;
    var basicUpper = hl2 + multiplier * atr;
    var basicLower = hl2 - multiplier * atr;

    var finalUpper, finalLower, st, trend;

    if (k === 0) {
      // Seed bar: no previous band to carry. Start in an uptrend on the lower band.
      finalUpper = basicUpper;
      finalLower = basicLower;
      st    = basicLower;
      trend = 1;
    } else {
      finalUpper = (basicUpper < prevFinalUpper || close[i - 1] > prevFinalUpper)
        ? basicUpper : prevFinalUpper;
      finalLower = (basicLower > prevFinalLower || close[i - 1] < prevFinalLower)
        ? basicLower : prevFinalLower;

      // Carry the line from the previous bar's band, flipping when price closes through it.
      if (prevST === prevFinalUpper) {
        st = (close[i] <= finalUpper) ? finalUpper : finalLower;
      } else {
        st = (close[i] >= finalLower) ? finalLower : finalUpper;
      }
      trend = (st === finalLower) ? 1 : -1;
    }

    out[i] = { value: Math.round(st * 100) / 100, trend: trend };
    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevST = st;
  }

  return out;
}

module.exports = { computeSuperTrend: computeSuperTrend };

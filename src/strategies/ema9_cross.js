/**
 * STRATEGY: EMA9_CROSS  (created 2026-11-18)
 *
 * The simplest EMA strategy in the repo: the 5-min candle CLOSE crossing EMA9.
 *
 * Indicator: EMA(EMA9_CROSS_EMA_PERIOD, default 9) on the 5-min CLOSE. Nothing else.
 *
 * ENTRY — on a FINISHED candle (no intra-candle entry, no confirmation candle):
 *   BUY_CE  previous candle closed AT/BELOW its EMA9 and this candle closes ABOVE EMA9
 *   BUY_PE  previous candle closed AT/ABOVE its EMA9 and this candle closes BELOW EMA9
 *   Only inside the entry window (EMA9_CROSS_ENTRY_START–_ENTRY_END, overridden by
 *   the Common Trade Window when that is ON).
 *
 * EXIT — also on a FINISHED candle, at any time of day (not window-gated):
 *   holding CE → exit when a candle closes BELOW EMA9
 *   holding PE → exit when a candle closes ABOVE EMA9
 *   A close exactly ON EMA9 holds. When that exit candle is also a fresh cross the
 *   route FLIPS — it buys the other side on the same close (if the window and the
 *   common rules allow it).
 *
 * STOP: none in this file. The initial stop and its trail are the COMMON premium
 * stop + profit lock (tradeGuards.checkProfitLock) the routes run per tick.
 *
 * RE-ENTRY: only on a FRESH cross. After the common stop closes a CE while price
 * is still above EMA9 there is no new CE until price closes below and crosses back
 * above again — a "still above" candle is not a cross, so getSignal returns NONE.
 *
 * WHICH BAR IS READ: the LAST element of `candles` is the signal candle and must be
 * fully closed. Nothing reads the forming bar or the live spot, so Paper, Backtest
 * and Replay all see the same numbers. Paper fills at the first tick after the
 * signal bar closes; Backtest fills at that bar's close (the same market moment).
 *
 * DELIBERATELY LEFT OUT (the user asked for EMA9 only — do NOT add these back):
 *   no RSI, no SuperTrend, no EMA20/50 alignment, no confirmation candle, no
 *   EMA21 trail, no previous-candle stop, no red-candle exit, no target, no
 *   volume / ADX / VWAP / ATR filter.
 *
 * WARM-UP: refused below warmupBars() = max(3 × period, 30) + 2 candles (32 at
 * period 9) so the EMA has settled from its SMA seed. The paper route preloads
 * EMA9_CROSS_WARMUP_DAYS calendar days; the backtest fetches the same runway
 * before `from` and never trades on it.
 */

const { EMA } = require("technicalindicators");

const DEFAULT_PREFIX = "EMA9_CROSS";
const NAME        = "EMA9_CROSS";
const DESCRIPTION = "EMA9_CROSS | 5-min close crosses EMA9 → CE above / PE below | exit + flip on the opposite close | stop = common premium stop + profit lock";

// Env read with (strategy, market) pair inheritance — see config/pairs.js envGet.
var _pairsMod = null;
function _env(k) {
  if (!_pairsMod) _pairsMod = require("../config/pairs");
  return _pairsMod.envGet(k);
}

function _parseMins(envKey, fallback) {
  var v = (envKey ? _env(envKey) : undefined) || fallback;
  var parts = String(v).split(":");
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  if (!Number.isFinite(h)) return _parseMins(null, fallback);
  return h * 60 + (Number.isFinite(m) ? m : 0);
}
function _fmtTime(mins) {
  var h = Math.floor(mins / 60), m = mins % 60;
  var suffix = h >= 12 ? "PM" : "AM";
  var h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return h12 + ":" + (m < 10 ? "0" : "") + m + " " + suffix;
}

/** Entry window check on a candle's start time (unix seconds). */
function isInTradingWindow(unixSec, prefix) {
  var P = prefix || DEFAULT_PREFIX;
  var totalMin = Math.floor((unixSec + 19800) / 60) % 1440;
  var startMin = _parseMins(P + "_ENTRY_START", "10:30");
  var endMin   = _parseMins(P + "_ENTRY_END",   "14:00");
  if (totalMin < startMin) return { ok: false, reason: "Before " + _fmtTime(startMin) + " — outside the entry window" };
  if (totalMin >= endMin)  return { ok: false, reason: "After " + _fmtTime(endMin) + " — no new entries" };
  return { ok: true, reason: null };
}

/** Live read of the env — never cached, so a Settings save applies at once. */
function getConfig(prefix) {
  var P = prefix || DEFAULT_PREFIX;
  var p = parseInt(_env(P + "_EMA_PERIOD") || "9", 10);
  return {
    PREFIX: P,
    EMA_PERIOD: Number.isFinite(p) && p >= 2 ? p : 9,
  };
}

/** Candles the engine refuses below. */
function warmupBars(cfg) {
  if (typeof cfg === "string") cfg = getConfig(cfg);
  cfg = cfg || getConfig();
  return Math.max(cfg.EMA_PERIOD * 3, 30) + 2;
}

function _num(x) { return typeof x === "number" && Number.isFinite(x); }
function _r2(x) { return Math.round(x * 100) / 100; }

/**
 * computeSeries(candles, cfg) → { ema9 } — 1:1 with `candles`, null on warm-up bars.
 * technicalindicators EMA(p) over N values gives N−p+1 outputs; out[i] ↔ values[i+p-1].
 */
function computeSeries(candles, cfg) {
  if (typeof cfg === "string") cfg = getConfig(cfg);
  cfg = cfg || getConfig();
  var n = Array.isArray(candles) ? candles.length : 0;
  var ema = new Array(n).fill(null);
  if (n < cfg.EMA_PERIOD) return { ema9: ema };
  var closes = candles.map(function (c) { return c.close; });
  var out = EMA.calculate({ period: cfg.EMA_PERIOD, values: closes });
  for (var i = 0; i < out.length; i++) ema[i + cfg.EMA_PERIOD - 1] = out[i];
  return { ema9: ema };
}

function _empty(reason, extra) {
  return Object.assign({
    signal: "NONE", warmup: true, reason: reason, cross: null,
    ema9: null, prevEma9: null, closeVsEma: null,
    stopLoss: null, slSpot: null, entrySpot: null, triggerLevel: null,
    prevCandleHigh: null, prevCandleLow: null, signalStrength: "STRONG",
  }, extra || {});
}

/**
 * getSignal(candles, opts)
 *   opts.prefix        pair env prefix (default EMA9_CROSS)
 *   opts.silent        no console line
 *   opts.skipTimeCheck ignore the entry window (exit snapshots only)
 *   opts.precomputed   BACKTEST ONLY: { series, endIdx, cfg } — computeSeries over the
 *                      whole array; EMA is causal so series[endIdx] equals the prefix read.
 *
 * Returns { signal: "BUY_CE"|"BUY_PE"|"NONE", cross: "UP"|"DOWN"|null,
 *           closeVsEma: "ABOVE"|"BELOW"|"ON"|null, ema9, prevEma9, reason, warmup,
 *           entrySpot, triggerLevel, stopLoss:null, slSpot:null, signalStrength }.
 * `cross` is NOT window-gated (the exit/flip reads it); `signal` is.
 */
function getSignal(candles, opts) {
  var silent = !!(opts && opts.silent === true);
  var prefix = (opts && opts.prefix) || DEFAULT_PREFIX;
  var pre    = (opts && opts.precomputed) || null;
  var cfg    = (pre && pre.cfg) || getConfig(prefix);
  var WARMUP = warmupBars(cfg);
  var nBars  = !Array.isArray(candles) ? 0 : pre ? pre.endIdx + 1 : candles.length;

  if (!Array.isArray(candles) || nBars < WARMUP) {
    return _empty("Warming up (" + nBars + "/" + WARMUP + " candles)");
  }
  var sig  = candles[nBars - 1];
  var prev = candles[nBars - 2];
  if (!sig || !prev || !_num(sig.close) || !_num(sig.high) || !_num(sig.low) || !_num(prev.close)) {
    return _empty("Bad candle data (non-finite OHLC on the signal or previous candle)");
  }

  var series = pre ? pre.series : computeSeries(candles, cfg);
  var ema  = series.ema9[nBars - 1];
  var pEma = series.ema9[nBars - 2];
  if (!_num(ema) || !_num(pEma)) {
    return _empty("EMA" + cfg.EMA_PERIOD + " not ready", { prevCandleHigh: sig.high, prevCandleLow: sig.low });
  }

  var c = sig.close, pc = prev.close;
  var closeVsEma = c > ema ? "ABOVE" : c < ema ? "BELOW" : "ON";
  var cross = (pc <= pEma && c > ema) ? "UP" : (pc >= pEma && c < ema) ? "DOWN" : null;
  var L = "EMA" + cfg.EMA_PERIOD;

  var base = {
    warmup: false,
    cross: cross,
    closeVsEma: closeVsEma,
    ema9: _r2(ema),
    prevEma9: _r2(pEma),
    emaPeriod: cfg.EMA_PERIOD,
    entrySpot: c,
    triggerLevel: c,
    stopLoss: null,
    slSpot: null,
    prevCandleHigh: prev.high,
    prevCandleLow: prev.low,
    signalStrength: "STRONG",
  };

  if (!silent) {
    var _t = new Date(sig.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23" });
    console.log("[" + prefix + " " + _t + "] C=" + c + " " + L + "=" + ema.toFixed(2) +
      " (prev C=" + pc + " " + L + "=" + pEma.toFixed(2) + ") → " + (cross ? "CROSS " + cross : "no cross, close " + closeVsEma));
  }

  if (!cross) {
    return Object.assign({}, base, {
      signal: "NONE",
      reason: "No " + L + " cross — close " + c + " " + closeVsEma.toLowerCase() + " " + L + " " + ema.toFixed(2) +
              " (prev close " + pc + " vs " + pEma.toFixed(2) + ")",
    });
  }

  var crossTxt = cross === "UP"
    ? "C " + c + " crossed ABOVE " + L + " " + ema.toFixed(2) + " (prev C " + pc + " ≤ " + pEma.toFixed(2) + ")"
    : "C " + c + " crossed BELOW " + L + " " + ema.toFixed(2) + " (prev C " + pc + " ≥ " + pEma.toFixed(2) + ")";

  var skipTimeCheck = !!(opts && opts.skipTimeCheck === true);
  var win = skipTimeCheck ? { ok: true } : isInTradingWindow(sig.time, prefix);
  if (!win.ok) {
    return Object.assign({}, base, { signal: "NONE", skipReason: "window", reason: crossTxt + " — " + win.reason });
  }
  return Object.assign({}, base, {
    signal: cross === "UP" ? "BUY_CE" : "BUY_PE",
    reason: (cross === "UP" ? "CE: " : "PE: ") + crossTxt,
  });
}

/**
 * exitSignal(sig, side) — the strategy's own exit, read from a getSignal() result
 * of the same closed candle. CE exits on a close BELOW EMA9, PE on a close ABOVE.
 * Returns the exit reason string, or null to hold (warm-up / bad data also hold).
 */
function exitSignal(sig, side) {
  if (!sig || sig.warmup || !_num(sig.ema9) || !_num(sig.entrySpot)) return null;
  var L = "EMA" + (sig.emaPeriod || 9);
  if (side === "CE" && sig.closeVsEma === "BELOW") return L + " exit — close " + sig.entrySpot + " below " + L + " " + sig.ema9;
  if (side === "PE" && sig.closeVsEma === "ABOVE") return L + " exit — close " + sig.entrySpot + " above " + L + " " + sig.ema9;
  return null;
}

module.exports = {
  NAME: NAME,
  DEFAULT_PREFIX: DEFAULT_PREFIX,
  DESCRIPTION: DESCRIPTION,
  getConfig: getConfig,
  warmupBars: warmupBars,
  computeSeries: computeSeries,
  getSignal: getSignal,
  exitSignal: exitSignal,
  isInTradingWindow: isInTradingWindow,
};

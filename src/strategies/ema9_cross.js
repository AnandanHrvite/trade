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
 * MIN CROSS GAP (EMA9_CROSS_MIN_CROSS_PTS, default 0 = off, added 2026-11-18 on
 * request): an ENTRY needs the cross candle to close at least that many spot
 * points past EMA9. A smaller cross is skipped (and is not retried — the next
 * candle is no longer a fresh cross). Exits and flips-as-exits are unchanged.
 *
 * HTF TREND (EMA9_CROSS_HTF_TREND_ENABLED, default false, added 2026-11-18 on
 * request): a CE needs the last FINISHED HTF candle (EMA9_CROSS_HTF_MINUTES, 15)
 * to have closed above its EMA (EMA9_CROSS_HTF_EMA_PERIOD, 20); a PE needs below.
 * Built from the same candles (see _htfSeries). Exits are unchanged.
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
  var m = parseFloat(_env(P + "_MIN_CROSS_PTS") || "0");
  var hm = parseInt(_env(P + "_HTF_MINUTES") || "15", 10);
  var hp = parseInt(_env(P + "_HTF_EMA_PERIOD") || "20", 10);
  return {
    PREFIX: P,
    EMA_PERIOD: Number.isFinite(p) && p >= 2 ? p : 9,
    // Entry only when the cross candle CLOSES at least this many spot points past
    // the EMA. 0 = off (any cross). Exit and the "cross" field are NOT gated.
    MIN_CROSS_PTS: Number.isFinite(m) && m > 0 ? m : 0,
    // Higher-timeframe trend filter (default OFF): CE only while the last FINISHED
    // HTF candle closed above its EMA, PE only while it closed below. Exits unchanged.
    HTF_ENABLED: String(_env(P + "_HTF_TREND_ENABLED") || "false").trim().toLowerCase() === "true",
    HTF_MINUTES: HTF_CHOICES.indexOf(hm) !== -1 ? hm : 15,
    HTF_EMA_PERIOD: Number.isFinite(hp) && hp >= 2 ? hp : 20,
    RES: resolutionMin(P),
  };
}
var HTF_CHOICES = [15, 30, 60];

/**
 * Candle size (minutes) for this strategy alone. EMA9_CROSS_RESOLUTION = 3/5/15;
 * "global" (default) or anything else follows TRADE_RESOLUTION, so an untouched
 * .env behaves as before. Lives in the engine so paper and backtest cannot drift.
 */
var RESOLUTION_CHOICES = [3, 5, 15];
function resolutionMin(prefix) {
  var P = prefix || DEFAULT_PREFIX;
  var raw = String(_env(P + "_RESOLUTION") || "global").trim();
  var v = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  if (RESOLUTION_CHOICES.indexOf(v) !== -1) return v;
  var g = parseInt(_env("TRADE_RESOLUTION") || "5", 10);
  return Number.isFinite(g) && g > 0 ? g : 5;
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
  var htf = cfg.HTF_ENABLED ? _htfSeries(candles, cfg) : { htfClose: new Array(n).fill(null), htfEma: new Array(n).fill(null) };
  if (n < cfg.EMA_PERIOD) return { ema9: ema, htfClose: htf.htfClose, htfEma: htf.htfEma };
  var closes = candles.map(function (c) { return c.close; });
  var out = EMA.calculate({ period: cfg.EMA_PERIOD, values: closes });
  for (var i = 0; i < out.length; i++) ema[i + cfg.EMA_PERIOD - 1] = out[i];
  return { ema9: ema, htfClose: htf.htfClose, htfEma: htf.htfEma };
}

/**
 * _htfSeries — the higher-timeframe trend, built from the SAME candles (no second
 * fetch, so Paper / Backtest / Replay agree). HTF buckets start at 09:15 IST each
 * day (exchange-aligned). For bar i, the value is the LAST FINISHED bucket as of
 * bar i's CLOSE — the bucket bar i completes counts, a still-forming one does not
 * (no look-ahead). EMA is over finished-bucket closes, so it is causal and a
 * whole-array run equals the per-bar prefix read.
 */
var SESSION_START_MIN = 555; // 09:15 IST
function _htfSeries(candles, cfg) {
  var n = candles.length;
  var hClose = new Array(n).fill(null), hEma = new Array(n).fill(null);
  var H = cfg.HTF_MINUTES, RES = cfg.RES || 5;
  var keys = new Array(n), ends = new Array(n);
  for (var i = 0; i < n; i++) {
    var t = candles[i].time, ist = t + 19800;
    var day = Math.floor(ist / 86400), mod = Math.floor((ist % 86400) / 60) - SESSION_START_MIN;
    var k = Math.floor(mod / H);
    keys[i] = day * 1000 + k;
    ends[i] = day * 86400 - 19800 + (SESSION_START_MIN + (k + 1) * H) * 60;
  }
  // Finished buckets in order: a bucket is finished at bar i when bar i closes at/after
  // its end, or when bar i already belongs to a later bucket (a gap in the data).
  var bucketCloses = [], bucketKeyAt = [];
  var finishedIdx = new Array(n).fill(-1);
  var lastKey = null, lastClose = null;
  for (var j = 0; j < n; j++) {
    var c = candles[j];
    if (lastKey !== null && keys[j] !== lastKey) {
      // previous bucket ended without a bar reaching its end time — close it now
      if (bucketKeyAt[bucketKeyAt.length - 1] !== lastKey) { bucketCloses.push(lastClose); bucketKeyAt.push(lastKey); }
    }
    lastKey = keys[j]; lastClose = c.close;
    if (c.time + RES * 60 >= ends[j] && bucketKeyAt[bucketKeyAt.length - 1] !== keys[j]) {
      bucketCloses.push(c.close); bucketKeyAt.push(keys[j]);
    }
    finishedIdx[j] = bucketCloses.length - 1;
  }
  var P = cfg.HTF_EMA_PERIOD;
  var bEma = new Array(bucketCloses.length).fill(null);
  if (bucketCloses.length >= P) {
    var out = EMA.calculate({ period: P, values: bucketCloses });
    for (var q = 0; q < out.length; q++) bEma[q + P - 1] = out[q];
  }
  for (var r = 0; r < n; r++) {
    var b = finishedIdx[r];
    if (b >= 0) { hClose[r] = bucketCloses[b]; hEma[r] = bEma[b]; }
  }
  return { htfClose: hClose, htfEma: hEma };
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

  var gap = Math.abs(c - ema);
  if (cfg.MIN_CROSS_PTS > 0 && gap < cfg.MIN_CROSS_PTS) {
    return Object.assign({}, base, {
      signal: "NONE", skipReason: "minCross",
      reason: crossTxt + " — close only " + gap.toFixed(2) + " pt past " + L + " (min " + cfg.MIN_CROSS_PTS + ")",
    });
  }

  if (cfg.HTF_ENABLED) {
    var hc = series.htfClose ? series.htfClose[nBars - 1] : null;
    var he = series.htfEma ? series.htfEma[nBars - 1] : null;
    var HL = cfg.HTF_MINUTES + "m EMA" + cfg.HTF_EMA_PERIOD;
    if (!_num(hc) || !_num(he)) {
      return Object.assign({}, base, { signal: "NONE", skipReason: "htfTrend", reason: crossTxt + " — " + HL + " trend not ready yet" });
    }
    var htfTrend = hc > he ? "UP" : hc < he ? "DOWN" : "FLAT";
    if (htfTrend !== cross) {
      return Object.assign({}, base, {
        signal: "NONE", skipReason: "htfTrend", htfTrend: htfTrend,
        reason: crossTxt + " — against the " + HL + " trend (" + cfg.HTF_MINUTES + "m close " + hc + " vs " + he.toFixed(2) + ")",
      });
    }
    base.htfTrend = htfTrend;
  }

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
  resolutionMin: resolutionMin,
  warmupBars: warmupBars,
  computeSeries: computeSeries,
  getSignal: getSignal,
  exitSignal: exitSignal,
  isInTradingWindow: isInTradingWindow,
};

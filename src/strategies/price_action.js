/**
 * STRATEGY: PRICE ACTION — SMART MONEY ORDER-BLOCK RETEST (TRADE_RESOLUTION candles)
 *
 * Replaced the chart-pattern breakouts on 2026-11-03. One setup, both directions
 * (described for CE; PE is the exact mirror):
 *
 *   1. BREAK      a candle CLOSES above the last swing high (a wick does not count).
 *   2. INDUCEMENT the first pullback low after the break. While price keeps rising
 *                 without taking it, it shifts up to each newer pullback low. With no
 *                 pullback yet, it is the last pullback low before the break.
 *   3. SWEEP      price trades below the inducement. The highest high before the
 *                 sweep is the TARGET.
 *   4. BLOCK      the lowest candle of the up move that took out an earlier minor low
 *                 and has a gap after it (third candle's low above its high). Candle
 *                 colour does not matter; inside candles are skipped when counting.
 *                 The block must not have been touched since the gap formed.
 *   5. ENTRY      price first returns to the block, then a candle closes up within
 *                 PA_SMC_REACT_WAIT candles. A block is used ONCE.
 *
 * STOP   : beyond the block by PA_SL_BUFFER_PTS, floored at PA_MIN_SL_PTS.
 * SKIPS  : stop wider than PA_MAX_SL_PTS, or reward:risk under PA_SMC_MIN_RR.
 * EXIT   : stop, target, plus the common rules applied by the route engines.
 * WINDOW : PA_ENTRY_START – PA_ENTRY_END IST.
 *
 * Single timeframe by design: the course maps structure on a higher chart, but this
 * engine sees one candle series. getSignal keeps NO state between calls — it re-reads
 * the same fixed tail each time — so paper, live, backtest and replay cannot drift and
 * a setup cannot fire twice.
 */

const NAME        = "PRICE_ACTION_SMC";
const DESCRIPTION = "Smart money order-block retest | close break → inducement sweep → block with gap → reaction candle";

const BULL_LABEL = "Bullish OB";
const BEAR_LABEL = "Bearish OB";

function cfg(key, fb) { return process.env[key] !== undefined ? process.env[key] : fb; }

// A bad number from .env falls back to the default: a NaN here would give a trade
// with no working stop, or a swing check that throws on every candle.
function num(key, fb, min, max) {
  var v = parseFloat(cfg(key, fb));
  if (!Number.isFinite(v)) v = parseFloat(fb);
  return Math.min(Math.max(v, min), max);
}
function int(key, fb, min, max) { return Math.floor(num(key, fb, min, max)); }

// Candles the setup logic reads. Every route keeps at least 99, and a setup lives at
// most 45, so its break always has history behind it for finding the swing.
var TAIL_BARS = 90;

// Stop limits, shared with the routes that place a stop of their own (manual entries).
function stopLimits() {
  return { min: num("PA_MIN_SL_PTS", "8", 0, Infinity), max: num("PA_MAX_SL_PTS", "25", 0, Infinity) };
}

// ── Trading window ───────────────────────────────────────────────────────────
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
  var d = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var totalMin = d.getHours() * 60 + d.getMinutes();
  var startMin = _parseMins("PA_ENTRY_START", "09:20");
  var endMin   = _parseMins("PA_ENTRY_END",   "14:30");
  if (totalMin < startMin) return { ok: false, reason: "Before " + _fmtTime(startMin) };
  if (totalMin >= endMin)  return { ok: false, reason: "After " + _fmtTime(endMin) };
  return { ok: true, reason: null };
}

// ── Swing high/low detection (structure trail + status display) ──────────────
// A swing high: candle[i].high > candle[i-1].high AND candle[i].high > candle[i+1].high
// A swing low:  candle[i].low  < candle[i-1].low  AND candle[i].low  < candle[i+1].low
function findSwingPoints(candles, lookback) {
  var swingHighs = [];
  var swingLows  = [];
  var start = Math.max(1, candles.length - lookback);
  for (var i = start; i < candles.length - 1; i++) {
    var prev = candles[i - 1];
    var curr = candles[i];
    var next = candles[i + 1];
    if (curr.high > prev.high && curr.high > next.high) {
      swingHighs.push({ price: curr.high, index: i, time: curr.time });
    }
    if (curr.low < prev.low && curr.low < next.low) {
      swingLows.push({ price: curr.low, index: i, time: curr.time });
    }
  }
  return { swingHighs, swingLows };
}

// ── Mirror view ──────────────────────────────────────────────────────────────
// The setup logic is written once, for the up direction. A down setup runs the same
// code on negated prices (a low becomes a high), so CE and PE cannot disagree.
function _mirror(bars) {
  return bars.map(function (c) {
    return { time: c.time, open: -c.open, high: -c.low, low: -c.high, close: -c.close };
  });
}

function _isSwingHigh(v, k, n) {
  if (k - n < 0 || k + n >= v.length) return false;
  for (var m = 1; m <= n; m++) {
    if (!(v[k].high > v[k - m].high && v[k].high > v[k + m].high)) return false;
  }
  return true;
}

function _isMinorLow(v, k) {
  return k >= 1 && k + 1 < v.length && v[k].low < v[k - 1].low && v[k].low < v[k + 1].low;
}

// Newest minor low already confirmed before bar idx (its right neighbour has closed).
function _lastMinorLowBefore(v, idx) {
  for (var k = idx - 2; k >= 1; k--) {
    if (_isMinorLow(v, k)) return k;
  }
  return -1;
}

// ── Order block ──────────────────────────────────────────────────────────────
// Walks up the impulse from its lowest candle and returns the first that qualifies.
function _findOrderBlock(v, startIdx, breakIdx, sweepIdx, needLiquidity) {
  for (var k = startIdx; k < breakIdx; k++) {
    if (needLiquidity) {
      var m = _lastMinorLowBefore(v, k + 1);
      if (m < 0 || v[k].low >= v[m].low) continue;        // took no liquidity
    }

    var second = k + 1;                                   // skip inside candles
    while (second < sweepIdx && v[second].high <= v[k].high) second++;
    var third = second + 1;
    if (third >= sweepIdx) continue;
    if (v[third].low <= v[k].high) continue;              // no gap

    var clean = true;
    for (var x = k + 1; x < sweepIdx && clean; x++) {
      if (v[x].low < v[k].low) clean = false;             // a later candle went lower
      if (x > third && v[x].low <= v[k].high) clean = false; // block already touched
    }
    if (clean) return k;
  }
  return -1;
}

// ── Setup state machine ──────────────────────────────────────────────────────
var STAGE = { IDM: 1, TAP: 2, REACT: 3, DONE: 4 };

function _newSetup(v, dir, pivot, i) {
  // i + 1: the break candle itself confirms a pullback low on the candle before it.
  var idmIdx = _lastMinorLowBefore(v, i + 1);
  return {
    dir: dir, v: v, level: pivot.price, levelIdx: pivot.index, breakIdx: i,
    stage: idmIdx < 0 ? STAGE.DONE : STAGE.IDM,
    note: idmIdx < 0 ? "no pullback to use as inducement" : null,
    idm: idmIdx < 0 ? null : v[idmIdx].low, idmIdx: idmIdx,
    target: null, ob: null, sweepIdx: null, tapIdx: null, fireIdx: null,
  };
}

function _finish(s, note) { s.stage = STAGE.DONE; s.note = note; }

function _onSweep(s, i, p) {
  var v = s.v;
  s.sweepIdx = i;
  s.target = -Infinity;
  for (var h = s.breakIdx; h < i; h++) s.target = Math.max(s.target, v[h].high);

  var start = s.levelIdx;
  for (var a = s.levelIdx; a <= s.breakIdx; a++) if (v[a].low < v[start].low) start = a;

  var k = _findOrderBlock(v, start, s.breakIdx, i, p.blockLiquidity);
  if (k < 0) return _finish(s, "inducement swept, no valid order block");
  s.ob = { index: k, high: v[k].high, low: v[k].low };
  s.stage = STAGE.TAP;
}

function _advance(s, i, p) {
  var v = s.v, c = v[i];
  if (s.stage === STAGE.DONE) return;
  if (i - s.breakIdx > p.maxAge) return _finish(s, "setup expired");

  if (s.stage === STAGE.IDM) {
    if (c.low < s.idm) {
      _onSweep(s, i, p);
      if (s.stage === STAGE.DONE) return;
    } else {
      if (i - 1 > s.breakIdx && _isMinorLow(v, i - 1)) { s.idm = v[i - 1].low; s.idmIdx = i - 1; }
      return;
    }
  }

  if (c.close < s.ob.low) return _finish(s, "closed through the order block");

  if (s.stage === STAGE.TAP) {
    if (i > s.sweepIdx && c.high >= s.target) return _finish(s, "target reached before the retest");
    if (c.low > s.ob.high) return;
    s.tapIdx = i;
    s.stage = STAGE.REACT;
  }

  if (s.stage === STAGE.REACT) {
    if (i - s.tapIdx > p.reactWait) return _finish(s, "no reaction at the order block");
    if (c.close > c.open) { s.fireIdx = i; s.stage = STAGE.DONE; s.note = "entry already taken"; }
  }
}

// Replays the tail bar by bar. The newest break always replaces the older setup: a
// break the other way is a change of character, so the old direction is finished.
function _scan(bars, p) {
  var views = { 1: bars, "-1": _mirror(bars) };
  var pivots = { 1: null, "-1": null };
  var active = null;
  for (var i = 0; i < bars.length; i++) {
    var broke = false;
    [1, -1].forEach(function (dir) {
      var v = views[dir];
      if (_isSwingHigh(v, i - p.swingBars, p.swingBars)) {
        pivots[dir] = { price: v[i - p.swingBars].high, index: i - p.swingBars, broken: false };
      }
      var piv = pivots[dir];
      if (piv && !piv.broken && v[i].close > piv.price) {
        piv.broken = true;
        active = _newSetup(v, dir, piv, i);
        broke = true;
      }
    });
    if (!broke && active) _advance(active, i, p);
  }
  return active;
}

// Structural SL placement: beyond the block, never closer than minPts.
function _structuralSL(side, structLevel, entryClose, buffer, minPts) {
  if (side === "CE") {
    return parseFloat((entryClose - Math.max(entryClose - (structLevel - buffer), minPts)).toFixed(2));
  }
  return parseFloat((entryClose + Math.max((structLevel + buffer) - entryClose, minPts)).toFixed(2));
}

function _auditFromSetup(s, dir) {
  var mine = s && s.dir === dir ? s : null;
  var reached = mine ? mine.stage : 0;
  var checks = [
    { name: "Close break",     ok: !!mine,                 detail: "no break of the last swing" },
    { name: "Inducement swept", ok: !!(mine && mine.sweepIdx != null), detail: "inducement not taken" },
    { name: "Order block",     ok: !!(mine && mine.ob),    detail: "no block with a gap" },
    { name: "Retest",          ok: !!(mine && mine.tapIdx != null), detail: "price has not returned" },
    { name: "Reaction candle", ok: !!(mine && mine.fireIdx != null), detail: reached === STAGE.REACT ? "waiting for an up close" : "not reached" },
  ];
  var passed = [], failed = [];
  checks.forEach(function (c) {
    if (c.ok) passed.push(c.name); else failed.push({ name: c.name, detail: c.detail });
  });
  return { passed: passed.length, total: checks.length, passedNames: passed, failed: failed };
}

// ── Main signal function ─────────────────────────────────────────────────────
function getSignal(candles, opts) {
  opts = opts || {};
  var silent = opts.silent === true;

  var SR_LOOKBACK = int("PA_SR_LOOKBACK", "30", 3, 200);
  var SL_BUFFER   = num("PA_SL_BUFFER_PTS", "3", 0, Infinity);  // cushion beyond the block
  var limits      = stopLimits();
  var MIN_SL_PTS  = limits.min;                                 // floor on SL distance
  var MAX_SL_PTS  = limits.max;                                 // wider than this = skip
  var MIN_RR      = num("PA_SMC_MIN_RR", "1.5", 0, Infinity);
  var params = {
    swingBars: int("PA_SMC_SWING_BARS", "2", 1, 5),
    maxAge:    int("PA_SMC_MAX_AGE", "30", 10, 45),            // candles a setup may live after its break
    reactWait: int("PA_SMC_REACT_WAIT", "3", 0, 10),            // candles after the retest to see an up close
    blockLiquidity: cfg("PA_SMC_BLOCK_LIQUIDITY", "true") === "true", // block must have taken an earlier low
  };
  var BULL_ON = cfg("PA_PATTERN_BULL_OB", "true") === "true";
  var BEAR_ON = cfg("PA_PATTERN_BEAR_OB", "true") === "true";

  var base = {
    signal: "NONE", reason: "", stopLoss: null, target: null,
    pattern: null, srLevel: null, patternLevel: null, patternPoints: null,
    swingHighs: [], swingLows: [],
    signalStrength: null,
  };

  // The same fixed tail in every mode is what makes this call deterministic.
  if (candles.length < TAIL_BARS) {
    base.reason = "Warming up (" + candles.length + "/" + TAIL_BARS + ")";
    return base;
  }

  var sc = candles[candles.length - 1];

  if (!opts.skipTimeCheck) {
    var windowCheck = isInTradingWindow(sc.time);
    if (!windowCheck.ok) {
      base.reason = windowCheck.reason;
      return base;
    }
  }

  var swings = findSwingPoints(candles, SR_LOOKBACK);
  base.swingHighs = swings.swingHighs.slice(-3).map(function (s) { return s.price; });
  base.swingLows  = swings.swingLows.slice(-3).map(function (s) { return s.price; });

  var bars = candles.slice(-TAIL_BARS);
  var s = _scan(bars, params);

  base.filterAudit = { ce: _auditFromSetup(s, 1), pe: _auditFromSetup(s, -1) };

  if (!s) { base.reason = "No setup"; return base; }

  var label = s.dir > 0 ? BULL_LABEL : BEAR_LABEL;
  var side  = s.dir > 0 ? "CE" : "PE";
  var real  = function (x) { return s.dir > 0 ? x : -x; };
  var points = [
    { time: bars[s.breakIdx].time, price: real(s.level), label: "Break" },
  ];
  if (s.idm != null && s.idmIdx >= 0) points.push({ time: bars[s.idmIdx].time, price: real(s.idm), label: "IDM" });
  if (s.ob) points.push({ time: bars[s.ob.index].time, price: real(s.ob.high), label: "OB" });
  base.patternPoints = points;
  base.pattern = label + " (setup)";
  base.srLevel = real(s.level);
  if (s.ob) base.patternLevel = real(s.ob.high);

  if (s.fireIdx !== bars.length - 1) {
    if (s.stage === STAGE.IDM) {
      base.reason = label + ": broke " + real(s.level).toFixed(0) + ", waiting for inducement " + real(s.idm).toFixed(0);
    } else if (s.stage === STAGE.TAP) {
      base.reason = label + ": waiting for retest of " + real(s.ob.low).toFixed(0) + "-" + real(s.ob.high).toFixed(0);
    } else if (s.stage === STAGE.REACT) {
      base.reason = label + ": retested, waiting for reaction candle";
    } else {
      base.reason = label + ": " + s.note;
    }
    return base;
  }

  if (s.dir > 0 ? !BULL_ON : !BEAR_ON) {
    base.reason = label + " turned off in Settings";
    return base;
  }

  var structLevel = real(s.ob.low);
  var target      = parseFloat(real(s.target).toFixed(2));
  var rawRisk     = s.dir > 0 ? sc.close - (structLevel - SL_BUFFER) : (structLevel + SL_BUFFER) - sc.close;
  var risk        = Math.max(rawRisk, MIN_SL_PTS);
  var reward      = s.dir > 0 ? target - sc.close : sc.close - target;

  if (risk > MAX_SL_PTS) {
    base.reason = label + ": stop " + risk.toFixed(0) + " pts is wider than " + MAX_SL_PTS;
    return base;
  }
  if (reward / risk < MIN_RR) {
    base.reason = label + ": reward:risk " + (reward / risk).toFixed(2) + " is below " + MIN_RR;
    return base;
  }

  var sl    = _structuralSL(side, structLevel, sc.close, SL_BUFFER, MIN_SL_PTS);
  var dir   = s.dir > 0 ? "above" : "below";
  var level = real(s.ob.high);
  if (!silent) {
    var _ist = new Date(sc.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23" });
    console.log("[PA " + _ist + "] " + side + " " + label + " " + dir + " " + level.toFixed(0) + " SL=" + sl + " Target=" + target);
  }
  return Object.assign({}, base, {
    signal: s.dir > 0 ? "BUY_CE" : "BUY_PE", signalStrength: "STRONG",
    pattern: label, stopLoss: sl, target: target, slSource: "Order Block",
    srLevel: level, patternLevel: level,
    reason: side + ": " + label + " retest " + dir + " " + level.toFixed(0) + " | SL=" + sl + " | Target=" + target,
  });
}

// ── Trailing SL: Swing structure based ───────────────────────────────────────
// Off by default: the setup's own exit is stop and target. When on:
// For CE: trail SL to the most recent swing low (only tighten)
// For PE: trail SL to the most recent swing high (only tighten)
function updateTrailingSL(candles, currentSL, side, opts) {
  if (cfg("PA_SMC_TRAIL_ENABLED", "false") !== "true") return { sl: currentSL, source: null };
  var SR_LOOKBACK = int("PA_SR_LOOKBACK", "30", 3, 200);
  var swings = findSwingPoints(candles, SR_LOOKBACK);

  if (side === "CE" && swings.swingLows.length > 0) {
    var lastSwingLow = swings.swingLows[swings.swingLows.length - 1].price;
    var close = candles[candles.length - 1].close;
    // Only tighten (move up), must be below current price
    if (lastSwingLow > currentSL && lastSwingLow < close) {
      return { sl: parseFloat(lastSwingLow.toFixed(2)), source: "Swing Low" };
    }
  }
  if (side === "PE" && swings.swingHighs.length > 0) {
    var lastSwingHigh = swings.swingHighs[swings.swingHighs.length - 1].price;
    var close = candles[candles.length - 1].close;
    // Only tighten (move down), must be above current price
    if (lastSwingHigh < currentSL && lastSwingHigh > close) {
      return { sl: parseFloat(lastSwingHigh.toFixed(2)), source: "Swing High" };
    }
  }

  return { sl: currentSL, source: null };
}

// getSignal holds no state; kept because the routes call it at session start.
function reset() {}

module.exports = {
  NAME,
  DESCRIPTION,
  getSignal,
  updateTrailingSL,
  reset,
  stopLimits,
  TAIL_BARS,
  // Expose helpers for backtest
  findSwingPoints,
  isInTradingWindow,
};

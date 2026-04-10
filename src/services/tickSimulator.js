/**
 * tickSimulator.js — Fake tick generator for after-hours paper trade testing
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates realistic NIFTY tick streams for different market scenarios.
 * Feeds ticks into the existing onTick() pipeline so the full strategy
 * (BB + RSI + PSAR, SL, trailing, etc.) runs exactly as in live mode.
 *
 * Scenarios:
 *   trending_up    — Steady upward drift with small pullbacks
 *   trending_down  — Steady downward drift with small rallies
 *   choppy         — Range-bound oscillation, mean-reverting
 *   volatile       — Large swings in both directions
 *   breakout_up    — Tight consolidation then sharp upward breakout
 *   breakout_down  — Tight consolidation then sharp downward breakout
 *   v_recovery     — Sharp drop then V-shaped recovery
 *   inverted_v     — Sharp rise then reversal down
 *
 * Usage:
 *   const sim = require("./tickSimulator");
 *   sim.start({ scenario: "trending_up", basePrice: 24500, onTick, onDone, speed: 10 });
 *   sim.stop();
 */

const EventEmitter = require("events");

// ── Scenario definitions ────────────────────────────────────────────────────
// Each scenario defines candle-level behavior over ~75 candles (≈ one 9:15–15:30 session at 3-min)
const SCENARIOS = {
  trending_up: {
    label: "Trending Up",
    desc:  "Steady rally with small pullbacks — tests CE entries & trailing profit",
    generate: (base, count) => generateTrending(base, count, 1),
  },
  trending_down: {
    label: "Trending Down",
    desc:  "Steady selloff with small rallies — tests PE entries & trailing profit",
    generate: (base, count) => generateTrending(base, count, -1),
  },
  choppy: {
    label: "Choppy / Range-bound",
    desc:  "Oscillates in tight range — tests SL hits & false signal filtering",
    generate: (base, count) => generateChoppy(base, count),
  },
  volatile: {
    label: "High Volatility",
    desc:  "Large swings both ways — tests rapid SL / re-entry / trailing",
    generate: (base, count) => generateVolatile(base, count),
  },
  breakout_up: {
    label: "Breakout Up",
    desc:  "Tight consolidation then sharp upward move — tests breakout capture",
    generate: (base, count) => generateBreakout(base, count, 1),
  },
  breakout_down: {
    label: "Breakout Down",
    desc:  "Tight consolidation then sharp downward move — tests breakdown capture",
    generate: (base, count) => generateBreakout(base, count, -1),
  },
  v_recovery: {
    label: "V-Recovery",
    desc:  "Sharp 100pt drop then recovery — tests SL, re-entry timing",
    generate: (base, count) => generateVShape(base, count, 1),
  },
  inverted_v: {
    label: "Inverted V",
    desc:  "Sharp 100pt rally then reversal — tests profit booking vs holding",
    generate: (base, count) => generateVShape(base, count, -1),
  },
};

// ── Candle generators ───────────────────────────────────────────────────────

function rand(min, max) { return min + Math.random() * (max - min); }

function generateTrending(base, count, dir) {
  // dir: +1 = up, -1 = down
  const candles = [];
  let price = base;
  const drift = dir * rand(1.5, 3.5);       // pts per candle avg drift
  const pullbackChance = 0.2;               // 20% candles are pullbacks
  for (let i = 0; i < count; i++) {
    const isPullback = Math.random() < pullbackChance;
    const move = isPullback ? -dir * rand(2, 8) : dir * rand(0.5, 6);
    const open = price;
    const close = price + move;
    price = close + drift * (isPullback ? 0.3 : 1);
    const wick = rand(1, 4);
    const high = Math.max(open, close) + wick;
    const low  = Math.min(open, close) - wick;
    candles.push({ open: r2(open), high: r2(high), low: r2(low), close: r2(close) });
  }
  return candles;
}

function generateChoppy(base, count) {
  const candles = [];
  let price = base;
  const rangeHalf = 25; // ±25 pts range
  for (let i = 0; i < count; i++) {
    const distFromCenter = price - base;
    // Mean-revert: stronger pull when far from center
    const revert = -distFromCenter * 0.15;
    const noise = rand(-6, 6);
    const move = revert + noise;
    const open = price;
    const close = price + move;
    price = close;
    // Clamp to range
    if (price > base + rangeHalf) price = base + rangeHalf - rand(2, 5);
    if (price < base - rangeHalf) price = base - rangeHalf + rand(2, 5);
    const wick = rand(1, 5);
    const high = Math.max(open, close) + wick;
    const low  = Math.min(open, close) - wick;
    candles.push({ open: r2(open), high: r2(high), low: r2(low), close: r2(close) });
  }
  return candles;
}

function generateVolatile(base, count) {
  const candles = [];
  let price = base;
  for (let i = 0; i < count; i++) {
    const bigMove = Math.random() < 0.3; // 30% are big candles
    const amplitude = bigMove ? rand(15, 35) : rand(3, 12);
    const dir = Math.random() < 0.5 ? 1 : -1;
    const open = price;
    const close = price + dir * amplitude;
    price = close;
    const wick = rand(2, bigMove ? 10 : 4);
    const high = Math.max(open, close) + wick;
    const low  = Math.min(open, close) - wick;
    candles.push({ open: r2(open), high: r2(high), low: r2(low), close: r2(close) });
  }
  return candles;
}

function generateBreakout(base, count, dir) {
  const candles = [];
  let price = base;
  const consolPhase = Math.floor(count * 0.6); // 60% consolidation
  for (let i = 0; i < count; i++) {
    if (i < consolPhase) {
      // Tight range — ±8 pts
      const move = rand(-4, 4) - (price - base) * 0.2;
      const open = price;
      const close = price + move;
      price = close;
      const wick = rand(0.5, 3);
      candles.push({ open: r2(open), high: r2(Math.max(open, close) + wick), low: r2(Math.min(open, close) - wick), close: r2(close) });
    } else if (i === consolPhase) {
      // Breakout candle — big move
      const open = price;
      const close = price + dir * rand(20, 40);
      price = close;
      const wick = rand(1, 3);
      const high = dir > 0 ? close + wick : open + wick;
      const low  = dir > 0 ? open - wick : close - wick;
      candles.push({ open: r2(open), high: r2(high), low: r2(low), close: r2(close) });
    } else {
      // Follow-through with small pullbacks
      const isPullback = Math.random() < 0.25;
      const move = isPullback ? -dir * rand(2, 6) : dir * rand(2, 10);
      const open = price;
      const close = price + move;
      price = close;
      const wick = rand(1, 4);
      candles.push({ open: r2(open), high: r2(Math.max(open, close) + wick), low: r2(Math.min(open, close) - wick), close: r2(close) });
    }
  }
  return candles;
}

function generateVShape(base, count, recovery) {
  // recovery = 1: V (drop then recover), -1: inverted V (rise then drop)
  const candles = [];
  let price = base;
  const half = Math.floor(count / 2);
  const dropDir = recovery === 1 ? -1 : 1; // first half direction
  for (let i = 0; i < count; i++) {
    const phase1 = i < half;
    const dir = phase1 ? dropDir : -dropDir;
    // Accelerate into the turn, decelerate out
    const distFromTurn = phase1 ? (half - i) : (i - half);
    const intensity = phase1 ? rand(3, 8) : rand(2, 7);
    const move = dir * intensity;
    const open = price;
    const close = price + move;
    price = close;
    const wick = rand(1, 5);
    candles.push({ open: r2(open), high: r2(Math.max(open, close) + wick), low: r2(Math.min(open, close) - wick), close: r2(close) });
  }
  return candles;
}

function r2(n) { return parseFloat(n.toFixed(2)); }

// ── Tick interpolation within a candle ──────────────────────────────────────
// Generates ~20 ticks per candle following a realistic O→H→L→C or O→L→H→C path

function interpolateTicks(candle, ticksPerCandle = 20) {
  const { open, high, low, close } = candle;
  const ticks = [];

  // Determine path: if close > open (bullish), go O → L → H → C
  //                 if close < open (bearish), go O → H → L → C
  const bullish = close >= open;
  const path = bullish
    ? [open, low, high, close]
    : [open, high, low, close];

  // Distribute ticks across path segments (3 segments, ~ticksPerCandle total)
  const segs = [
    Math.floor(ticksPerCandle * 0.25),
    Math.floor(ticksPerCandle * 0.45),
    ticksPerCandle - Math.floor(ticksPerCandle * 0.25) - Math.floor(ticksPerCandle * 0.45),
  ];

  for (let s = 0; s < 3; s++) {
    const from = path[s], to = path[s + 1];
    const n = segs[s];
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n;
      // Add small noise to make it realistic
      const noise = rand(-0.5, 0.5);
      const price = from + (to - from) * t + noise;
      // Clamp within candle range
      ticks.push(r2(Math.min(high, Math.max(low, price))));
    }
  }

  return ticks;
}

// ── Simulator engine ────────────────────────────────────────────────────────

let _simTimer   = null;
let _simRunning = false;
let _simCandles = [];  // generated scenario candles (for status display)

/**
 * Core tick emission loop — shared by start() and startFromCandles()
 * @param {Array}    warmup         — candles for indicator warmup (returned, not emitted)
 * @param {Array}    sessionCandles — candles to emit as ticks
 * @param {number}   resolutionMin  — candle resolution in minutes (3, 5, 15)
 * @param {number}   speed          — speed multiplier
 * @param {Function} onTick         — callback receiving { ltp }
 * @param {Function} onCandleDone   — optional, called after each candle's ticks
 * @param {Function} onDone         — called when all candles are emitted
 */
function _emitLoop(warmup, sessionCandles, resolutionMin, speed, onTick, onCandleDone, onDone) {
  _simCandles = [...warmup, ...sessionCandles];
  _simRunning = true;

  const tickInterval = (resolutionMin * 60 * 1000) / speed;
  const ticksPerCandle = 20;
  const tickDelay = tickInterval / ticksPerCandle;

  let candleIdx = 0;
  let tickIdx = 0;
  let currentTicks = [];

  function emitNext() {
    if (!_simRunning) return;

    if (tickIdx >= currentTicks.length) {
      if (onCandleDone && candleIdx > 0) {
        onCandleDone(sessionCandles[candleIdx - 1], candleIdx - 1);
      }
      if (candleIdx >= sessionCandles.length) {
        _simRunning = false;
        if (onDone) onDone();
        return;
      }
      currentTicks = interpolateTicks(sessionCandles[candleIdx], ticksPerCandle);
      tickIdx = 0;
      candleIdx++;
    }

    onTick({ ltp: currentTicks[tickIdx] });
    tickIdx++;
    _simTimer = setTimeout(emitNext, tickDelay);
  }

  emitNext();
  return { warmupCandles: warmup, totalSessionCandles: sessionCandles.length };
}

/**
 * Start simulation from synthetic scenario
 * @param {Object} opts
 * @param {string}   opts.scenario      — scenario key (e.g. "trending_up")
 * @param {number}   opts.basePrice     — starting NIFTY price (default 24500)
 * @param {Function} opts.onTick        — callback receiving { ltp }
 * @param {Function} opts.onCandleDone  — optional
 * @param {Function} opts.onDone        — called when all candles are emitted
 * @param {number}   opts.speed         — speed multiplier (default 10)
 * @param {number}   opts.candleCount   — session candles (default 75)
 * @param {number}   opts.warmupCandles — warmup candles (default 30)
 * @param {number}   opts.resolution    — candle resolution in minutes (default 3)
 */
function start(opts) {
  if (_simRunning) throw new Error("Simulation already running");

  const {
    scenario     = "trending_up",
    basePrice    = 24500,
    onTick,
    onCandleDone,
    onDone,
    speed        = 10,
    candleCount  = 75,
    warmupCandles = 30,
    resolution   = 3,
  } = opts;

  if (!SCENARIOS[scenario]) throw new Error(`Unknown scenario: ${scenario}`);
  if (!onTick) throw new Error("onTick callback required");

  const totalCandles = warmupCandles + candleCount;
  const allCandles = SCENARIOS[scenario].generate(basePrice, totalCandles);

  // Assign simulated timestamps using the correct resolution
  const simDate = new Date();
  simDate.setUTCHours(3, 45, 0, 0); // 09:15 IST
  const startUnixSec = Math.floor(simDate.getTime() / 1000);

  for (let i = 0; i < allCandles.length; i++) {
    allCandles[i].time = startUnixSec + i * (resolution * 60);
    allCandles[i].volume = Math.floor(rand(50000, 200000));
  }

  const warmup = allCandles.slice(0, warmupCandles);
  const sessionCandles = allCandles.slice(warmupCandles);

  return _emitLoop(warmup, sessionCandles, resolution, speed, onTick, onCandleDone, onDone);
}

/**
 * Start simulation from real historical candles (date replay)
 * @param {Object} opts
 * @param {Array}    opts.candles       — pre-fetched OHLC candles (must include warmup + session)
 * @param {number}   opts.warmupCount   — how many candles to use for warmup (default 30)
 * @param {number}   opts.resolution    — candle resolution in minutes (3, 5, 15)
 * @param {Function} opts.onTick        — callback receiving { ltp }
 * @param {Function} opts.onCandleDone  — optional
 * @param {Function} opts.onDone        — called when all candles are emitted
 * @param {number}   opts.speed         — speed multiplier (default 10)
 */
function startFromCandles(opts) {
  if (_simRunning) throw new Error("Simulation already running");

  const {
    candles,
    warmupCount  = 30,
    resolution   = 15,
    onTick,
    onCandleDone,
    onDone,
    speed        = 10,
  } = opts;

  if (!candles || candles.length === 0) throw new Error("No candles provided");
  if (!onTick) throw new Error("onTick callback required");

  if (candles.length <= warmupCount) {
    throw new Error(`Need more than ${warmupCount} candles for warmup — got ${candles.length}. Try an earlier date range.`);
  }

  const warmup = candles.slice(0, warmupCount);
  const sessionCandles = candles.slice(warmupCount);

  return _emitLoop(warmup, sessionCandles, resolution, speed, onTick, onCandleDone, onDone);
}

function stop() {
  _simRunning = false;
  if (_simTimer) { clearTimeout(_simTimer); _simTimer = null; }
}

function isRunning() { return _simRunning; }
function getScenarios() { return SCENARIOS; }
function getSimCandles() { return _simCandles; }

module.exports = { start, startFromCandles, stop, isRunning, getScenarios, getSimCandles, SCENARIOS };

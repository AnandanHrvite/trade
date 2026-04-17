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
// Random-walk-with-anchors: ticks zigzag noisily inside [low, high],
// guaranteed to start at open, touch the candle's high & low, end at close.
// Mimics real intra-candle price action instead of a smooth O→H→L→C arc.

function interpolateTicks(candle, ticksPerCandle = 20) {
  const { open, high, low, close } = candle;
  const range = Math.max(0.01, high - low);

  if (ticksPerCandle < 4) {
    return [open, high, low, close].slice(0, ticksPerCandle).map(r2);
  }

  // Bullish candles tend to dip first then rally; bearish do the opposite.
  const bullish = close >= open;
  const firstAnchorPrice  = bullish ? low  : high;
  const secondAnchorPrice = bullish ? high : low;

  // Place the two extreme-anchors randomly inside the sequence (not at endpoints).
  const inner = ticksPerCandle - 2;
  const halfA = Math.floor(inner / 2);
  const halfB = inner - halfA;
  let a1 = 1 + Math.floor(Math.random() * halfA);
  let a2 = 1 + halfA + Math.floor(Math.random() * halfB);
  if (a2 <= a1) a2 = Math.min(ticksPerCandle - 2, a1 + 1);

  const waypoints = {
    0: open,
    [a1]: firstAnchorPrice,
    [a2]: secondAnchorPrice,
    [ticksPerCandle - 1]: close,
  };
  const wpKeys = Object.keys(waypoints).map(Number).sort((a, b) => a - b);

  // Noise dominates drift so the walk genuinely wiggles instead of crawling.
  const noiseScale = Math.max(0.5, range * 0.20);

  const ticks = [r2(open)];
  let prev = open;

  for (let i = 1; i < ticksPerCandle; i++) {
    if (waypoints[i] !== undefined) {
      prev = waypoints[i];
      ticks.push(r2(prev));
      continue;
    }
    const nextIdx   = wpKeys.find(k => k > i);
    const nextPrice = waypoints[nextIdx];
    const stepsLeft = nextIdx - i + 1;
    const drift     = (nextPrice - prev) / stepsLeft;
    let next = prev + drift + rand(-noiseScale, noiseScale);
    // Bounce off the candle's high/low instead of clamping flat.
    if (next > high) next = high - Math.random() * noiseScale * 0.3;
    if (next < low)  next = low  + Math.random() * noiseScale * 0.3;
    ticks.push(r2(next));
    prev = next;
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
 * @param {Array}    [tickCandles]  — optional finer-resolution candles for tick generation
 * @param {number}   [tickRes]      — resolution of tickCandles in minutes (e.g. 1)
 */
function _emitLoop(warmup, sessionCandles, resolutionMin, speed, onTick, onCandleDone, onDone, tickCandles, tickRes) {
  _simCandles = [...warmup, ...sessionCandles];
  _simRunning = true;

  // If finer tick candles provided, group them by parent candle time buckets
  let tickGroups = null;
  if (tickCandles && tickCandles.length > 0 && tickRes) {
    const parentResMs = resolutionMin * 60;
    tickGroups = new Map();
    for (const tc of tickCandles) {
      const bucket = Math.floor(tc.time / parentResMs) * parentResMs;
      if (!tickGroups.has(bucket)) tickGroups.set(bucket, []);
      tickGroups.get(bucket).push(tc);
    }
  }

  const ticksPerCandle = 20;
  // When using tick candles, each 1-min candle gets fewer interpolated ticks
  const ticksPerSubCandle = tickGroups ? Math.max(4, Math.floor(ticksPerCandle / (resolutionMin / (tickRes || 1)))) : ticksPerCandle;

  const tickInterval = (resolutionMin * 60 * 1000) / speed;
  const totalTicksPerParent = tickGroups ? ticksPerSubCandle * (resolutionMin / (tickRes || 1)) : ticksPerCandle;
  const tickDelay = tickInterval / totalTicksPerParent;

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

      // Generate ticks: use finer candles if available, else interpolate from parent
      const parentCandle = sessionCandles[candleIdx];
      if (tickGroups) {
        const parentResMs = resolutionMin * 60;
        const bucket = Math.floor(parentCandle.time / parentResMs) * parentResMs;
        const subCandles = tickGroups.get(bucket);
        if (subCandles && subCandles.length > 0) {
          currentTicks = [];
          for (const sc of subCandles) {
            currentTicks.push(...interpolateTicks(sc, ticksPerSubCandle));
          }
        } else {
          currentTicks = interpolateTicks(parentCandle, ticksPerCandle);
        }
      } else {
        currentTicks = interpolateTicks(parentCandle, ticksPerCandle);
      }

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
    tickCandles,        // optional: finer-resolution candles for tick generation
    tickResolution,     // optional: resolution of tickCandles in minutes (e.g. 1)
  } = opts;

  if (!candles || candles.length === 0) throw new Error("No candles provided");
  if (!onTick) throw new Error("onTick callback required");

  if (candles.length <= warmupCount) {
    throw new Error(`Need more than ${warmupCount} candles for warmup — got ${candles.length}. Try an earlier date range.`);
  }

  const warmup = candles.slice(0, warmupCount);
  const sessionCandles = candles.slice(warmupCount);

  return _emitLoop(warmup, sessionCandles, resolution, speed, onTick, onCandleDone, onDone, tickCandles, tickResolution);
}

function stop() {
  _simRunning = false;
  if (_simTimer) { clearTimeout(_simTimer); _simTimer = null; }
}

function isRunning() { return _simRunning; }
function getScenarios() { return SCENARIOS; }
function getSimCandles() { return _simCandles; }

module.exports = { start, startFromCandles, stop, isRunning, getScenarios, getSimCandles, SCENARIOS };

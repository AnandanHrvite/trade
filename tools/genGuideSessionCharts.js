/* Regenerate the "whole session" chart in each strategy guide.
 *
 * Problem this solves: all six were hand-written from one template — same price
 * base (~24,1xx), same 09:15–14:00 window, same rally-then-fade shape — so they
 * read as the same picture with different overlays. Worse, the overlays were also
 * hand-written, so an "EMA20" line was not actually the EMA20 of its own candles.
 *
 * Here each strategy gets its own day shape and its own price base, and every
 * overlay (EMA / VWAP / σ-band / Bollinger) is COMPUTED from the generated candles,
 * so the picture is internally consistent with the rule it illustrates.
 *
 * Deterministic: a seeded LCG, no Math.random, so re-running produces byte-identical
 * output and the guides do not churn in git.
 */
const fs = require("fs");
const path = require("path");


const GUIDES = path.join(__dirname, "..", "documents");

// ── deterministic noise ─────────────────────────────────────────────────────
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const r2 = x => Math.round(x * 100) / 100;

// Build 5-min candles from a close-path. Each bar gets a plausible open/high/low
// around its close so the body/wick shapes look like a real chart.
function toCandles(closes, rnd, wick) {
  wick = wick || 1;
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    const open = i === 0 ? closes[0] - (rnd() - 0.5) * 6 : closes[i - 1];
    const c = closes[i];
    const span = Math.max(Math.abs(c - open), 3) * (0.5 + rnd() * 0.9) * wick;
    const high = Math.max(open, c) + span * (0.3 + rnd() * 0.7);
    const low = Math.min(open, c) - span * (0.3 + rnd() * 0.7);
    out.push([r2(open), r2(high), r2(low), r2(c)]);
  }
  return out;
}

function times(n, startMin) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const m = startMin + i * 5;
    out.push(String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));
  }
  return out;
}

// ── indicators, computed from the candles the chart actually draws ──────────
function ema(vals, period) {
  const k = 2 / (period + 1), out = [];
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (prev === null) { let s = 0; for (let j = 0; j <= i; j++) s += vals[j]; prev = s / (i + 1); }
    else prev = vals[i] * k + prev * (1 - k);
    out.push(r2(prev));
  }
  return out;
}
// Session-anchored, EQUAL-WEIGHTED VWAP over HLC3 + σ bands — exactly the formula
// ema9_vwap.js uses (volume is deliberately never read).
function vwapBands(candles, mult) {
  const vwap = [], up = [], lo = [];
  let sumP = 0, sumP2 = 0, n = 0;
  for (const c of candles) {
    const tp = (c[1] + c[2] + c[3]) / 3;
    sumP += tp; sumP2 += tp * tp; n++;
    const v = sumP / n;
    const sd = Math.sqrt(Math.max(sumP2 / n - v * v, 0));
    vwap.push(r2(v)); up.push(r2(v + mult * sd)); lo.push(r2(v - mult * sd));
  }
  return { vwap, up, lo };
}
function bollinger(closes, period, mult) {
  const mid = [], up = [], lo = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { mid.push(null); up.push(null); lo.push(null); continue; }
    const w = closes.slice(i - period + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) * (b - m), 0) / period);
    mid.push(r2(m)); up.push(r2(m + mult * sd)); lo.push(r2(m - mult * sd));
  }
  return { mid, up, lo };
}

// ── the six day shapes ──────────────────────────────────────────────────────
// Each is a different base price AND a different structure, so no two charts
// can be mistaken for one another.
function pathFrom(base, legs, rnd) {
  // legs: [{ n, to }] — walk `n` candles toward `to`, with noise.
  const closes = [];
  let p = base;
  for (const leg of legs) {
    const step = (leg.to - p) / leg.n;
    for (let i = 0; i < leg.n; i++) {
      p += step + (rnd() - 0.5) * (leg.noise == null ? 9 : leg.noise);
      closes.push(r2(p));
    }
    p = leg.to;
  }
  return closes;
}

const N = 72;                    // 09:15 → 15:10
const T = times(N, 9 * 60 + 15);

const SPECS = {};

// 1. EMA_RSI_ST — a BEARISH day. Flat morning, EMA20 rolls under EMA50 at ~11:05,
//    then a steady afternoon slide. Deliberately a PE trade: every other guide
//    shows a CE, so this one is unmistakable at a glance.
{
  const rnd = lcg(11);
  const closes = pathFrom(24680, [
    { n: 14, to: 24694, noise: 14 },   // 09:15–10:20 chop
    { n: 8,  to: 24662, noise: 11 },   // roll over
    { n: 10, to: 24610, noise: 10 },   // break down
    { n: 22, to: 24486, noise: 11 },   // trend down
    { n: 18, to: 24448, noise: 12 },   // grind + late bounce
  ], rnd);
  const candles = toCandles(closes, rnd);
  const e20 = ema(closes, 20), e50 = ema(closes, 50), e21 = ema(candles.map(c => (c[0] + c[1] + c[2] + c[3]) / 4), 21);
  SPECS.ers = {
    file: "EMA_RSI_ST_Strategy_Guide.html", id: "ers-session",
    spec: {
      title: "NIFTY 50 Index", subtitle: "5m · NSE · an EMA_RSI_ST bearish (PE) day",
      times: T, candles,
      overlays: [
        { name: "EMA20", color: "#3b82f6", data: e20 },
        { name: "EMA50", color: "#a78bfa", data: e50 },
        { name: "EMA21 trail", color: "#f5a623", dash: true, data: e21 },
      ],
      markers: [
        { i: 25, type: "dot", color: "#fbbf24", price: candles[25][3], text: "signal candle" },
        { i: 26, type: "exit", price: candles[26][3], text: "BUY PE " + Math.round(candles[26][3]) },
        { i: 63, type: "buy", price: candles[63][3], text: "EXIT " + Math.round(candles[63][3]) },
      ],
      legend: [{ color: "#3b82f6", label: "EMA20" }, { color: "#a78bfa", label: "EMA50" },
        { color: "#f5a623", label: "EMA21 trail" }, { color: "#ef5350", label: "BUY PE" },
        { color: "#26a69a", label: "EXIT" }],
    },
  };
}

// 2. BB_RSI — a fast scalp day at a LOWER base. Tight range, one clean upper-band
//    break held for ~8 candles, banked by the profit lock, then back to chop.
{
  const rnd = lcg(23);
  const closes = pathFrom(23860, [
    { n: 20, to: 23872, noise: 16 },   // range
    { n: 4,  to: 23932, noise: 8 },    // band break
    { n: 8,  to: 23988, noise: 9 },    // the run
    { n: 6,  to: 23948, noise: 10 },   // giveback → profit lock
    { n: 34, to: 23930, noise: 18 },   // chop, no more trades
  ], rnd);
  const candles = toCandles(closes, rnd, 1.15);
  const bb = bollinger(closes, 20, 1);
  SPECS.bbr = {
    file: "BB_RSI_Strategy_Guide.html", id: "bbr-session",
    spec: {
      title: "NIFTY 50 Index", subtitle: "5m · NSE · a BB_RSI scalp day (one trade, held ~40 min)",
      times: T, candles,
      bands: [{ upper: bb.up, lower: bb.lo, mid: bb.mid, color: "#7890c8", fill: "rgba(120,144,200,0.10)" }],
      markers: [
        { i: 23, type: "dot", color: "#fbbf24", price: candles[23][3], text: "band break" },
        { i: 24, type: "buy", price: candles[24][3], text: "BUY CE " + Math.round(candles[24][3]) },
        { i: 32, type: "exit", price: candles[32][3], text: "EXIT — profit lock" },
      ],
      legend: [{ color: "#7890c8", label: "Bollinger 20, 1σ" }, { color: "#fbbf24", label: "band break" },
        { color: "#26a69a", label: "BUY" }, { color: "#ef5350", label: "EXIT" }],
    },
  };
}

// 3. Price Action — a V-shaped double bottom, retest, then the rally.
{
  const rnd = lcg(37);
  const closes = pathFrom(24460, [
    { n: 10, to: 24382, noise: 10 },   // first leg down
    { n: 6,  to: 24428, noise: 9 },    // bounce
    { n: 8,  to: 24386, noise: 8 },    // second bottom (equal low)
    { n: 6,  to: 24442, noise: 9 },    // break the neckline
    { n: 5,  to: 24424, noise: 7 },    // retest
    { n: 37, to: 24556, noise: 12 },   // the move
  ], rnd);
  const candles = toCandles(closes, rnd);
  SPECS.pa = {
    file: "Price_Action_Strategy_Guide.html", id: "pa-session",
    spec: {
      title: "NIFTY 50 Index", subtitle: "5m · NSE · a Price Action double-bottom day",
      times: T, candles,
      // Zone derived from the candles it frames, not hand-typed — otherwise the box
      // and the "equal lows" it is meant to mark drift apart.
      zones: [{
        from: 7, to: 25,
        top: r2(Math.max(candles[9][2], candles[23][2]) + 22),
        bottom: r2(Math.min(candles[9][2], candles[23][2]) - 4),
        label: "double bottom", color: "rgba(63,185,80,0.08)", stroke: "#3fb950",
      }],
      markers: [
        { i: 9,  type: "dot", color: "#8b98ac", price: candles[9][3], text: "low 1" },
        { i: 23, type: "dot", color: "#8b98ac", price: candles[23][3], text: "low 2" },
        { i: 29, type: "dot", color: "#fbbf24", price: candles[29][3], text: "neckline break" },
        { i: 34, type: "buy", price: candles[34][3], text: "BUY CE on retest" },
        { i: 68, type: "exit", price: candles[68][3], text: "EXIT — swing trail" },
      ],
      legend: [{ color: "#3fb950", label: "double bottom" }, { color: "#fbbf24", label: "breakout" },
        { color: "#26a69a", label: "BUY" }, { color: "#ef5350", label: "EXIT" }],
    },
  };
}

// 4. ORB — narrow opening box, breakout 09:50, trend day. Its own base again.
{
  const rnd = lcg(53);
  const closes = pathFrom(25120, [
    { n: 3,  to: 25132, noise: 34 },   // the 09:15–09:30 box — a realistic ~45pt open
    { n: 4,  to: 25140, noise: 8 },    // coil under the top
    { n: 4,  to: 25182, noise: 7 },    // breakout + confirmation
    { n: 33, to: 25352, noise: 10 },   // trend
    { n: 12, to: 25390, noise: 9 },    // final push
    { n: 16, to: 25306, noise: 11 },   // EMA20 breaks → exit + fade
  ], rnd);
  const candles = toCandles(closes, rnd);
  const orh = Math.max(...candles.slice(0, 3).map(c => c[1]));
  const orl = Math.min(...candles.slice(0, 3).map(c => c[2]));
  const vb = vwapBands(candles, 1);
  SPECS.orb = {
    file: "ORB_Strategy_Guide.html", id: "orb-session",
    spec: {
      title: "NIFTY 50 Index", subtitle: "5m · NSE · an ORB trend day (1 trade, held all day)",
      times: T, candles,
      zones: [{ from: 0, to: 2, top: r2(orh), bottom: r2(orl), label: "Opening range " + Math.round(orh - orl) + "pt", color: "rgba(96,165,250,0.09)", stroke: "#60a5fa" }],
      overlays: [
        { name: "VWAP", color: "#a78bfa", data: vb.vwap },
        { name: "EMA20", color: "#f5a623", data: ema(closes, 20) },
      ],
      markers: [
        { i: 8,  type: "dot", color: "#fbbf24", price: candles[8][3], text: "breakout candle" },
        { i: 9,  type: "buy", price: candles[9][3], text: "BUY CE " + Math.round(candles[9][3]) },
        { i: 58, type: "exit", price: candles[58][3], text: "EXIT — closed below EMA20" },
      ],
      legend: [{ color: "#60a5fa", label: "Opening range" }, { color: "#a78bfa", label: "VWAP" },
        { color: "#f5a623", label: "EMA20 trail" }, { color: "#26a69a", label: "BUY" }, { color: "#ef5350", label: "EXIT" }],
    },
  };
}

// 5. EMA9+VWAP — the fast line hugs the channel all morning, breaks out midday,
//    reversal candle ends it. Base again distinct.
{
  const rnd = lcg(71);
  const closes = pathFrom(22940, [
    { n: 26, to: 22958, noise: 15 },   // inside the band, no trade
    { n: 5,  to: 23012, noise: 8 },    // the break
    { n: 14, to: 23096, noise: 9 },    // the run
    { n: 3,  to: 23044, noise: 8 },    // 2-candle reversal
    { n: 24, to: 23020, noise: 14 },   // drift, cooldown blocks re-entry
  ], rnd);
  const candles = toCandles(closes, rnd);
  const vb = vwapBands(candles, 1);
  SPECS.ev = {
    file: "EMA9_VWAP_Strategy_Guide.html", id: "ev-session",
    spec: {
      title: "NIFTY 50 Index", subtitle: "5m · NSE · an EMA9+VWAP day (one break, reversal exit)",
      times: T, candles,
      bands: [{ upper: vb.up, lower: vb.lo, mid: vb.vwap, color: "#a78bfa", fill: "rgba(167,139,250,0.07)" }],
      overlays: [{ name: "EMA9", color: "#26a69a", data: ema(closes, 9) }],
      markers: [
        { i: 20, type: "dot", color: "#8b98ac", price: candles[20][3], text: "inside band — no trade" },
        { i: 30, type: "buy", price: candles[30][3], text: "BUY CE " + Math.round(candles[30][3]) },
        { i: 46, type: "exit", price: candles[46][3], text: "EXIT — 2-candle reversal" },
      ],
      legend: [{ color: "#26a69a", label: "EMA9 (5m)" }, { color: "#a78bfa", label: "VWAP ±1σ" },
        { color: "#8b98ac", label: "no trade" }, { color: "#ef5350", label: "EXIT" }],
    },
  };
}

// 6. Trend Pullback — a staircase: two clean pullbacks to EMA20, one taken.
{
  const rnd = lcg(97);
  const closes = pathFrom(26240, [
    { n: 12, to: 26318, noise: 9 },    // leg 1 up
    { n: 6,  to: 26286, noise: 7 },    // pullback 1 (too early — before window)
    { n: 12, to: 26372, noise: 9 },    // leg 2 up
    { n: 7,  to: 26336, noise: 7 },    // pullback 2 → the trade
    { n: 20, to: 26468, noise: 10 },   // resumption
    { n: 15, to: 26420, noise: 11 },   // trail gives back a little
  ], rnd);
  const candles = toCandles(closes, rnd);
  SPECS.tpb = {
    file: "Trend_Pullback_Strategy_Guide.html", id: "tpb-session",
    spec: {
      title: "NIFTY 50 Index", subtitle: "5m · NSE · a Trend Pullback staircase day",
      times: T, candles,
      overlays: [{ name: "EMA20", color: "#f5a623", data: ema(closes, 20) }],
      markers: [
        { i: 15, type: "dot", color: "#8b98ac", price: candles[15][3], text: "pullback 1 — passed over" },
        { i: 34, type: "dot", color: "#fbbf24", price: candles[34][3], text: "pullback 2" },
        { i: 37, type: "buy", price: candles[37][3], text: "BUY CE — resumption candle" },
        { i: 62, type: "exit", price: candles[62][3], text: "EXIT — chandelier trail" },
      ],
      legend: [{ color: "#f5a623", label: "EMA20 (5m)" }, { color: "#fbbf24", label: "pullback" },
        { color: "#26a69a", label: "BUY" }, { color: "#ef5350", label: "EXIT" }],
    },
  };
}

// ── patch each guide's session render call in place ─────────────────────────
let changed = 0;
for (const key of Object.keys(SPECS)) {
  const { file, id, spec } = SPECS[key];
  const p = path.join(GUIDES, file);
  let html = fs.readFileSync(p, "utf-8");
  const marker = `TVChart.render("${id}", `;
  const start = html.indexOf(marker);
  if (start < 0) { console.log(`✗ ${file}: no render call for ${id}`); continue; }
  // find the matching ");" that closes this call
  let depth = 0, i = start + marker.length, end = -1;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") { depth--; if (depth < 0) { end = i; break; } }
  }
  if (end < 0) { console.log(`✗ ${file}: unbalanced render call for ${id}`); continue; }
  const tail = html.slice(end);                        // starts at the ")"
  const next = html.slice(0, start) + marker + JSON.stringify(spec) + tail;
  if (next !== html) { fs.writeFileSync(p, next); changed++; }
  console.log(`✓ ${file} — ${id} regenerated (${spec.candles.length} candles, base ${spec.candles[0][3]})`);
}
console.log(`\n${changed} guide(s) rewritten.`);

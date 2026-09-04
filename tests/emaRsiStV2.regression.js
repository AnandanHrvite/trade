#!/usr/bin/env node
/**
 * EMA_RSI_ST_V2 INVARIANTS
 *
 *   node tests/emaRsiStV2.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Nothing here
 * opens a socket, a broker connection or a session.
 *
 * EMA_RSI_ST_V2 is a deliberate SIMPLIFICATION of EMA_RSI_ST (V1). The whole
 * point of the strategy is what it does NOT do, and that is exactly what rots:
 * someone "fixes" V2 by copying a block back from V1 and the two strategies
 * quietly become one. So GROUP 2 pins each deliberate omission as an assertion
 * — no SuperTrend entry gate, no RSI cap, no EMA21, no negative-candle stop,
 * no option stop, no points stop, no target — and fails the moment one returns.
 *
 * GROUP 3 pins the other direction: V2 must never read V1's env keys or the
 * shared globals V1 reads (MAX_DAILY_TRADES, MAX_DAILY_LOSS, TRADE_ENTRY_*).
 * Sharing a key would make tuning one strategy silently retune the other, which
 * is the single failure this split was created to prevent.
 *
 * GROUP 5 asserts V1 is untouched: its engine still has the gates V2 dropped.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const SRC  = path.join(__dirname, "../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");
const exists = (rel) => fs.existsSync(path.join(SRC, rel));

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

const v2 = require("../src/strategies/ema_rsi_st_v2");
const v1 = require("../src/strategies/strategy1_sar_ema_rsi");

// ── Fixture builder ─────────────────────────────────────────────────────────
// 5-minute bars on real IST boundaries, ending inside V2's 10:30–13:00 window.
const IST = 19800;
function seriesEndingAt(closes, endH, endM) {
  // Place the LAST bar at endH:endM IST on 2026-03-10 (a Tuesday).
  const dayUTC = Math.floor(Date.UTC(2026, 2, 10) / 1000);
  const endSec = dayUTC + (endH * 60 + endM) * 60 - IST;
  const n = closes.length;
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return {
      time: endSec - (n - 1 - i) * 300,
      open: o, close: c,
      high: Math.max(o, c) + 5,
      low:  Math.min(o, c) - 5,
      volume: 0,
    };
  });
}
// A clean uptrend: EMA20>EMA50, closes above EMA20, RSI high.
function upSeries(n1 = 40, n2 = 30, step = 25) {
  const c = [];
  for (let i = 0; i < n1; i++) c.push(20000 + i);
  for (let i = 0; i < n2; i++) c.push(20000 + n1 + (i + 1) * step);
  return c;
}
function downSeries(n1 = 40, n2 = 30, step = 25) {
  const c = [];
  for (let i = 0; i < n1; i++) c.push(20000 - i);
  for (let i = 0; i < n2; i++) c.push(20000 - n1 - (i + 1) * step);
  return c;
}
function clearV2Env() {
  for (const k of Object.keys(process.env)) if (k.startsWith("EMA_RSI_ST_V2_")) delete process.env[k];
}

const ENGINE_SRC = read("strategies/ema_rsi_st_v2.js");

// ═══════════════════════════════════════════════════════════════════════════
section("Group 1 — the three entry rules, and nothing else");
// ═══════════════════════════════════════════════════════════════════════════

check("a clean uptrend inside the window buys CE", () => {
  clearV2Env();
  const r = v2.getSignal(seriesEndingAt(upSeries(), 11, 0), { silent: true });
  assert.strictEqual(r.signal, "BUY_CE", r.reason);
  assert.ok(r.ema20 >= r.ema50, "EMA20 must be at or above EMA50");
  assert.ok(r.rsi > 52, `RSI ${r.rsi} must exceed 52`);
});

check("a clean downtrend inside the window buys PE", () => {
  clearV2Env();
  const r = v2.getSignal(seriesEndingAt(downSeries(), 11, 0), { silent: true });
  assert.strictEqual(r.signal, "BUY_PE", r.reason);
  assert.ok(r.ema20 <= r.ema50, "EMA20 must be at or below EMA50");
  assert.ok(r.rsi < 48, `RSI ${r.rsi} must be under 48`);
});

check("the RSI threshold really gates the entry", () => {
  clearV2Env();
  const c = seriesEndingAt(upSeries(), 11, 0);
  const r = v2.getSignal(c, { silent: true });
  process.env.EMA_RSI_ST_V2_RSI_CE_MIN = String(r.rsi + 5);
  assert.strictEqual(v2.getSignal(c, { silent: true }).signal, "NONE");
  clearV2Env();
});

check("a close on the wrong side of EMA20 blocks the entry", () => {
  clearV2Env();
  // Rally hard, then one bar that dumps back below EMA20 while EMA20 is still > EMA50.
  const c = upSeries();
  c.push(c[c.length - 1] - 700);
  const r = v2.getSignal(seriesEndingAt(c, 11, 0), { silent: true });
  assert.strictEqual(r.signal, "NONE", r.reason);
  assert.ok(/EMA20/.test(r.reason), `reason should name the EMA20 miss: ${r.reason}`);
});

check("warm-up is refused outright, never guessed", () => {
  clearV2Env();
  const short = seriesEndingAt(new Array(54).fill(0).map((_, i) => 20000 + i), 11, 0);
  const r = v2.getSignal(short, { silent: true });
  assert.strictEqual(r.signal, "NONE");
  assert.strictEqual(r.warmup, true);
  assert.strictEqual(r.stopLoss, null);
  assert.strictEqual(v2.getSignal([], { silent: true }).warmup, true);
  assert.strictEqual(v2.getSignal(null, { silent: true }).warmup, true);
});

check("the engine refuses more bars than one session holds, so preload must span days", () => {
  clearV2Env();
  // 55 five-minute bars is 4h35m — longer than the 6h15m session only in the
  // sense that it cannot be met from the entry window alone. If this ever drops
  // below ~45 the paper route's multi-day preload could be quietly removed.
  assert.strictEqual(v2.warmupBars(), 55);
});

check("non-finite OHLC on the signal candle never produces a trade", () => {
  clearV2Env();
  const c = seriesEndingAt(upSeries(), 11, 0);
  for (const bad of [null, undefined, NaN, "", "abc"]) {
    const t = c.map((x, i) => (i === c.length - 1 ? Object.assign({}, x, { close: bad }) : x));
    const r = v2.getSignal(t, { silent: true });
    assert.strictEqual(r.signal, "NONE", `close=${JSON.stringify(bad)} produced ${r.signal}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
section("Group 2 — the deliberate omissions (V2 is defined by what it lacks)");
// ═══════════════════════════════════════════════════════════════════════════

check("NO RSI cap: a wildly overbought reading still buys CE", () => {
  clearV2Env();
  const c = [];
  for (let i = 0; i < 40; i++) c.push(20000);
  for (let i = 0; i < 30; i++) c.push(20000 + (i + 1) * 60);
  const r = v2.getSignal(seriesEndingAt(c, 11, 0), { silent: true });
  assert.ok(r.rsi > 80, `fixture should be overbought, got RSI ${r.rsi}`);
  assert.strictEqual(r.signal, "BUY_CE", "V1 would block this at RSI_CE_MAX; V2 must not");
});

check("NO RSI cap: setting a *_RSI_CE_MAX key changes nothing", () => {
  clearV2Env();
  const c = [];
  for (let i = 0; i < 40; i++) c.push(20000);
  for (let i = 0; i < 30; i++) c.push(20000 + (i + 1) * 60);
  const s = seriesEndingAt(c, 11, 0);
  process.env.EMA_RSI_ST_V2_RSI_CE_MAX = "60";
  process.env.RSI_CE_MAX = "60";
  const r = v2.getSignal(s, { silent: true });
  delete process.env.RSI_CE_MAX;
  clearV2Env();
  assert.strictEqual(r.signal, "BUY_CE", "an RSI cap key must be dead in V2");
});

check("NO SuperTrend ENTRY gate — neither side branch vetoes on trend", () => {
  const ce = ENGINE_SRC.slice(
    ENGINE_SRC.indexOf("if (emaUp && closeOkCE && rsiCE)"),
    ENGINE_SRC.indexOf("// ── BUY PE"));
  const pe = ENGINE_SRC.slice(
    ENGINE_SRC.indexOf("if (emaDown && closeOkPE && rsiPE)"),
    ENGINE_SRC.indexOf("// ── No signal"));
  assert.ok(ce.length > 100 && pe.length > 100, "could not locate the entry branches");
  assert.ok(!/trendUp/.test(ce), "CE branch must not test a SuperTrend direction");
  assert.ok(!/trendDown/.test(pe), "PE branch must not test a SuperTrend direction");
  // The ONLY SuperTrend test allowed at entry is the protective-side check.
  assert.ok(/stProtectsCE/.test(ce), "CE branch should check the stop is protective");
  assert.ok(/stProtectsPE/.test(pe), "PE branch should check the stop is protective");
});

check("NO EMA21 and no OHLC4 series anywhere in the engine", () => {
  assert.ok(!/period:\s*21/.test(ENGINE_SRC), "engine must not compute a 21-period EMA");
  assert.ok(!/\bohlc4\b/.test(ENGINE_SRC), "engine must not build an OHLC4 series");
  assert.ok(!/ema21:\s*Math\.round/.test(ENGINE_SRC), "engine must not populate a real ema21 value");
});

check("NO triple-stack option", () => {
  assert.ok(!/TRIPLE_STACK/.test(ENGINE_SRC));
  assert.ok(!/EMA_FASTEST/.test(ENGINE_SRC));
});

check("SuperTrend is the stop, and the returned stop IS the SuperTrend line", () => {
  clearV2Env();
  const c = seriesEndingAt(upSeries(), 11, 0);
  const r = v2.getSignal(c, { silent: true });
  assert.strictEqual(r.signal, "BUY_CE");
  assert.strictEqual(r.stopLoss, r.supertrend, "the CE stop must be the SuperTrend value itself");
  assert.strictEqual(r.stopLoss, r.slSpot);
  assert.ok(r.stopLoss < c[c.length - 1].close, "a CE stop must sit below the entry close");
});

check("a setup whose SuperTrend cannot protect it is SKIPPED, not opened unprotected", () => {
  clearV2Env();
  // Search real-shaped data for the case; the engine must never return a signal
  // whose stop is on the wrong side of the close.
  let sawSkip = false;
  for (let shift = 0; shift < 60 && !sawSkip; shift++) {
    const c = [];
    for (let i = 0; i < 40; i++) c.push(20000 + Math.sin(i / 3) * 40);
    for (let i = 0; i < 30; i++) c.push(20000 + Math.sin((i + shift) / 2) * 90 + i * 6);
    const r = v2.getSignal(seriesEndingAt(c, 11, 0), { silent: true });
    if (r.skipReason === "st_above_price" || r.skipReason === "st_below_price") {
      sawSkip = true;
      assert.strictEqual(r.signal, "NONE", "an unprotectable setup must not become a trade");
      assert.ok(/SuperTrend/.test(r.reason), "the skip must say why");
    }
    if (r.signal === "BUY_CE") assert.ok(r.stopLoss < r.entrySpot, "CE stop below entry");
    if (r.signal === "BUY_PE") assert.ok(r.stopLoss > r.entrySpot, "PE stop above entry");
  }
  assert.ok(sawSkip, "fixture never produced an unprotectable setup — test is not exercising the branch");
});

check("the trail tightens only, on both sides, and survives null/NaN", () => {
  clearV2Env();
  const c = seriesEndingAt(upSeries(), 11, 0);
  const lvl = v2.getSignal(c, { silent: true }).supertrend;

  assert.strictEqual(v2.trailStop(c, "CE", lvl - 100).changed, true, "CE should tighten upward");
  assert.strictEqual(v2.trailStop(c, "CE", lvl + 100).changed, false, "CE must never loosen");
  assert.strictEqual(v2.trailStop(c, "CE", lvl + 100).stop, lvl + 100, "a loosening trail returns the old stop");
  assert.strictEqual(v2.trailStop(c, "PE", lvl + 100).changed, true, "PE should tighten downward");
  assert.strictEqual(v2.trailStop(c, "PE", lvl - 100).changed, false, "PE must never loosen");
  assert.strictEqual(v2.trailStop(c, "CE", null).changed, true, "a null stop seeds");
  assert.strictEqual(v2.trailStop(c, "CE", NaN).changed, true, "a NaN stop seeds");
  assert.strictEqual(v2.trailStop([], "CE", 100).changed, false, "no candles → no change");
  assert.strictEqual(v2.trailStop(c, "XX", 100).changed, false, "unknown side → no change");

  // monotonic across the whole fixture
  let stop = null;
  for (let i = 60; i < c.length; i++) {
    const t = v2.trailStop(c.slice(0, i + 1), "CE", stop);
    if (t.changed) {
      assert.ok(stop === null || t.stop >= stop, "CE trail loosened mid-walk");
      stop = t.stop;
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
section("Group 3 — V2 owns its own keys (tuning V1 must never move V2)");
// ═══════════════════════════════════════════════════════════════════════════

check("the engine reads no EMA_RSI_ST_* (V1) key", () => {
  const keys = ENGINE_SRC.match(/process\.env\.[A-Z0-9_]+/g) || [];
  const leaked = keys.filter((k) => /process\.env\.EMA_RSI_ST_(?!V2_)/.test(k));
  assert.deepStrictEqual(leaked, [], `V1 keys leaked into V2: ${leaked.join(", ")}`);
});

check("the engine reads none of the shared globals V1 reads", () => {
  const keys = ENGINE_SRC.match(/process\.env\.[A-Z0-9_]+/g) || [];
  const shared = keys.filter((k) =>
    /(TRADE_ENTRY_START|TRADE_ENTRY_END|MAX_DAILY_TRADES|MAX_DAILY_LOSS|OPT_STOP_PCT)$/.test(k) &&
    !/V2_/.test(k));
  assert.deepStrictEqual(shared, [], `shared globals leaked into V2: ${shared.join(", ")}`);
});

check("every V2 knob is configurable and garbage falls back to the default", () => {
  clearV2Env();
  process.env.EMA_RSI_ST_V2_EMA_FAST = "9";
  process.env.EMA_RSI_ST_V2_EMA_SLOW = "21";
  process.env.EMA_RSI_ST_V2_RSI_PERIOD = "9";
  process.env.EMA_RSI_ST_V2_SUPERTREND_PERIOD = "7";
  process.env.EMA_RSI_ST_V2_SUPERTREND_MULT = "2.5";
  process.env.EMA_RSI_ST_V2_RSI_CE_MIN = "60";
  process.env.EMA_RSI_ST_V2_RSI_PE_MAX = "40";
  let c = v2.getConfig();
  assert.deepStrictEqual(
    [c.EMA_FAST, c.EMA_SLOW, c.RSI_PERIOD, c.ST_PERIOD, c.ST_MULT, c.RSI_CE_MIN, c.RSI_PE_MAX],
    [9, 21, 9, 7, 2.5, 60, 40]);

  process.env.EMA_RSI_ST_V2_EMA_FAST = "abc";
  process.env.EMA_RSI_ST_V2_SUPERTREND_MULT = "";
  process.env.EMA_RSI_ST_V2_RSI_CE_MIN = "oops";
  c = v2.getConfig();
  assert.strictEqual(c.EMA_FAST, 20, "garbage must fall back to 20, never 0/NaN");
  assert.strictEqual(c.ST_MULT, 2, "empty must fall back to 2");
  assert.strictEqual(c.RSI_CE_MIN, 52);
  clearV2Env();
});

check("the default SuperTrend multiplier is 2 (V1 uses 3)", () => {
  clearV2Env();
  assert.strictEqual(v2.getConfig().ST_MULT, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
section("Group 4 — the 10:30–13:00 entry window");
// ═══════════════════════════════════════════════════════════════════════════

const dayUTC = Math.floor(Date.UTC(2026, 2, 10) / 1000);
const at = (h, m) => dayUTC + (h * 60 + m) * 60 - IST;

check("the window opens at 10:30 and closes at 13:00", () => {
  clearV2Env();
  assert.strictEqual(v2.isInTradingWindow(at(10, 29)).ok, false);
  assert.strictEqual(v2.isInTradingWindow(at(10, 30)).ok, true);
  assert.strictEqual(v2.isInTradingWindow(at(12, 55)).ok, true);
  assert.strictEqual(v2.isInTradingWindow(at(13, 0)).ok, false, "13:00 is exclusive");
  assert.strictEqual(v2.isInTradingWindow(at(9, 30)).ok, false);
  assert.strictEqual(v2.isInTradingWindow(at(14, 0)).ok, false);
});

check("the window is configurable through V2's own keys", () => {
  clearV2Env();
  process.env.EMA_RSI_ST_V2_ENTRY_START = "09:30";
  process.env.EMA_RSI_ST_V2_ENTRY_END = "14:30";
  assert.strictEqual(v2.isInTradingWindow(at(9, 45)).ok, true);
  assert.strictEqual(v2.isInTradingWindow(at(14, 15)).ok, true);
  clearV2Env();
});

check("a perfect setup outside the window is refused", () => {
  clearV2Env();
  const r = v2.getSignal(seriesEndingAt(upSeries(), 9, 45), { silent: true });
  assert.strictEqual(r.signal, "NONE");
  assert.ok(/Before/.test(r.reason), r.reason);
  // …but an at-exit snapshot may bypass it
  const s = v2.getSignal(seriesEndingAt(upSeries(), 9, 45), { silent: true, skipTimeCheck: true });
  assert.strictEqual(s.signal, "BUY_CE", "skipTimeCheck is for exit snapshots");
});

// ═══════════════════════════════════════════════════════════════════════════
section("Group 5 — V1 is untouched, and the two really are different");
// ═══════════════════════════════════════════════════════════════════════════

const V1_SRC = read("strategies/strategy1_sar_ema_rsi.js");

check("V1 still has the SuperTrend entry gate V2 dropped", () => {
  assert.ok(/trendUp/.test(V1_SRC) && /trendDown/.test(V1_SRC),
    "V1 must still gate entries on SuperTrend — V2's change must not have leaked into it");
});

check("V1 still has the RSI caps V2 dropped", () => {
  assert.ok(/RSI_CE_MAX/.test(V1_SRC) && /RSI_PE_MIN/.test(V1_SRC),
    "V1 must still carry its overbought/oversold caps");
});

check("V1 still computes EMA21", () => {
  assert.ok(/period:\s*21/.test(V1_SRC), "V1's EMA21 must survive");
});

check("V1 and V2 reach different decisions on the same candles", () => {
  clearV2Env();
  // An overbought run: V2 buys it, V1's cap refuses it.
  const c = [];
  for (let i = 0; i < 40; i++) c.push(20000);
  for (let i = 0; i < 30; i++) c.push(20000 + (i + 1) * 60);
  const bars = seriesEndingAt(c, 11, 0);
  const prevStart = process.env.TRADE_ENTRY_START, prevEnd = process.env.TRADE_ENTRY_END;
  process.env.TRADE_ENTRY_START = "10:30";
  process.env.TRADE_ENTRY_END = "13:00";
  const a = v2.getSignal(bars, { silent: true }).signal;
  const b = v1.getSignal(bars, { silent: true }).signal;
  if (prevStart === undefined) delete process.env.TRADE_ENTRY_START; else process.env.TRADE_ENTRY_START = prevStart;
  if (prevEnd === undefined) delete process.env.TRADE_ENTRY_END; else process.env.TRADE_ENTRY_END = prevEnd;
  assert.strictEqual(a, "BUY_CE", "V2 should take the overbought trend");
  assert.notStrictEqual(b, "BUY_CE", "V1 should refuse it (RSI cap) — the two must differ here");
});

check("V2 has no legacy hand-written *Live.js (live can only come from paper)", () => {
  assert.ok(!exists("routes/emaRsiStV2Live.js"),
    "a second live implementation is exactly what drifts from paper");
  assert.ok(exists("routes/emaRsiStV2LiveHarness.js"), "the paper-wrapping harness must exist");
});

check("the live harness is triple-gated and defaults to dry-run", () => {
  const h = read("routes/emaRsiStV2LiveHarness.js");
  assert.ok(/EMA_RSI_ST_V2_LIVE_ENABLED/.test(h), "must read its own live gate");
  assert.ok(!/[^2]_LIVE_ENABLED/.test(h.replace(/EMA_RSI_ST_V2_LIVE_ENABLED/g, "")),
    "must not read another strategy's live gate");
  assert.ok(/isDryRun\("EMA_RSI_ST_V2"\)/.test(h), "must ask liveDryRun with its own key");
  assert.ok(/isAuthenticated/.test(h), "must check broker auth before real orders");
});

check("the paper route is the only place the rules are executed", () => {
  if (!exists("routes/emaRsiStV2Paper.js")) throw new Error("paper route missing");
  const p = read("routes/emaRsiStV2Paper.js");
  assert.ok(/require\("\.\.\/strategies\/ema_rsi_st_v2"\)/.test(p),
    "paper must call the V2 engine");
  // Strip comments first: the route carries a deliberate warning comment naming
  // getActiveStrategy(), and matching that would fail the very rule it documents.
  const code = p.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/getActiveStrategy\s*\(/.test(code),
    "getActiveStrategy() resolves to V1 — the V2 route must never CALL it");
  assert.ok(!/require\(["']\.\.\/strategies["']\)/.test(code),
    "the V2 route must not pull in the V1 strategy registry");
});

check("V2 claims its OWN socket mutex slot, so V1 and V2 run in parallel", () => {
  const sss = require("../src/utils/sharedSocketState");
  sss.clear(); sss.clearEmaRsiStV2Mode();
  try {
    // V1 running must NOT block V2 — they are separate strategies.
    sss.setActive("EMA_RSI_ST_PAPER");
    assert.strictEqual(sss.canStart("EMA_RSI_ST_V2_PAPER").allowed, true,
      "V1 paper must not block V2 paper");
    // …but V2 must still exclude itself.
    sss.setEmaRsiStV2Mode("EMA_RSI_ST_V2_PAPER");
    assert.strictEqual(sss.canStart("EMA_RSI_ST_V2_PAPER").allowed, false);
    assert.strictEqual(sss.canStart("EMA_RSI_ST_V2_LIVE").allowed, false,
      "V2 live must not start while V2 paper runs");
    // Stopping V2 must leave V1 alone.
    sss.clearEmaRsiStV2Mode();
    assert.strictEqual(sss.getMode(), "EMA_RSI_ST_PAPER",
      "clearing V2 must not clear V1's session");
  } finally { sss.clear(); sss.clearEmaRsiStV2Mode(); }
});

check("the V2 paper route never touches V1's mutex helpers", () => {
  const code = read("routes/emaRsiStV2Paper.js")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["setActive(", "getMode(", "isActive("]) {
    assert.ok(!code.includes("sharedSocketState." + bad),
      `sharedSocketState.${bad}) is V1's slot — V2 must use its own EmaRsiStV2 helpers`);
  }
  assert.ok(/setEmaRsiStV2Mode\(/.test(code) && /clearEmaRsiStV2Mode\(/.test(code),
    "V2 must claim and release its own slot");
});

// ═══════════════════════════════════════════════════════════════════════════
section("Group 6 — the NIFTY and NIFTY BANK variants share ONE engine");
// ═══════════════════════════════════════════════════════════════════════════

const BN = "BN_EMA_RSI_ST_V2";
function clearBnEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith("BN_EMA_RSI_ST_V2_")) delete process.env[k];
}

check("both prefixes are registered and map to the right underlying", () => {
  assert.strictEqual(v2.underlyingFor("EMA_RSI_ST_V2"), "NIFTY");
  assert.strictEqual(v2.underlyingFor(BN), "BANKNIFTY");
  assert.strictEqual(v2.underlyingFor("nonsense"), "NIFTY", "unknown prefix falls back to NIFTY");
  assert.strictEqual(v2.underlyingFor(), "NIFTY", "no prefix means NIFTY");
});

check("the two variants share defaults but tune INDEPENDENTLY", () => {
  clearV2Env(); clearBnEnv();
  assert.strictEqual(v2.getConfig().RSI_CE_MIN, v2.getConfig(BN).RSI_CE_MIN, "same rules by default");
  process.env.BN_EMA_RSI_ST_V2_RSI_CE_MIN = "65";
  process.env.BN_EMA_RSI_ST_V2_SUPERTREND_MULT = "3";
  assert.strictEqual(v2.getConfig(BN).RSI_CE_MIN, 65, "BN must follow its own key");
  assert.strictEqual(v2.getConfig(BN).ST_MULT, 3);
  assert.strictEqual(v2.getConfig().RSI_CE_MIN, 52, "tuning BN must NOT move NIFTY");
  assert.strictEqual(v2.getConfig().ST_MULT, 2);
  clearBnEnv();
});

check("the entry window is per-variant", () => {
  clearV2Env(); clearBnEnv();
  process.env.BN_EMA_RSI_ST_V2_ENTRY_START = "09:45";
  assert.strictEqual(v2.isInTradingWindow(at(10, 0), BN).ok, true, "BN window widened");
  assert.strictEqual(v2.isInTradingWindow(at(10, 0)).ok, false, "NIFTY window unchanged");
  clearBnEnv();
});

check("the SAME candles produce the SAME decision under both prefixes", () => {
  clearV2Env(); clearBnEnv();
  const bars = seriesEndingAt(upSeries(), 11, 0);
  const a = v2.getSignal(bars, { silent: true });
  const b = v2.getSignal(bars, { silent: true, prefix: BN });
  assert.strictEqual(a.signal, b.signal, "one engine, one rule set");
  assert.strictEqual(a.stopLoss, b.stopLoss, "same stop");
  assert.strictEqual(a.rsi, b.rsi);
  assert.strictEqual(b.signal, "BUY_CE");
});

check("there is no second engine file to drift from this one", () => {
  assert.ok(!exists("strategies/bn_ema_rsi_st_v2.js"),
    "the BN variant must SHARE this engine, not copy it — a copy is what BN_PIVOT_RSI_ST's own regression test exists to police");
});

// ═══════════════════════════════════════════════════════════════════════════
section("Group 7 — V2 ships DARK (every default-off surface)");
// ═══════════════════════════════════════════════════════════════════════════
// Every other strategy defaults ON when its key is unset, so each generic
// `process.env[k] || "true"` gate silently enabled V2. Three of them really did
// (notify's report/alerts, sharedNav's Start-All roster, both consolidations),
// which is why each is pinned individually rather than trusting one flag.

function withV2Unset(fn) {
  const prev = process.env.EMA_RSI_ST_V2_MODE_ENABLED;
  delete process.env.EMA_RSI_ST_V2_MODE_ENABLED;
  try { return fn(); }
  finally { if (prev === undefined) delete process.env.EMA_RSI_ST_V2_MODE_ENABLED; else process.env.EMA_RSI_ST_V2_MODE_ENABLED = prev; }
}
function withV2On(fn) {
  const prev = process.env.EMA_RSI_ST_V2_MODE_ENABLED;
  process.env.EMA_RSI_ST_V2_MODE_ENABLED = "true";
  try { return fn(); }
  finally { if (prev === undefined) delete process.env.EMA_RSI_ST_V2_MODE_ENABLED; else process.env.EMA_RSI_ST_V2_MODE_ENABLED = prev; }
}

check("Telegram alerts and the EOD report exclude V2 until it is switched on", () => {
  const notify = require("../src/utils/notify");
  assert.strictEqual(withV2Unset(() => notify.isModeEnabled("EMA_RSI_ST_V2")), false);
  assert.strictEqual(withV2On(() => notify.isModeEnabled("EMA_RSI_ST_V2")), true);
  // …and no other strategy's default was disturbed.
  assert.strictEqual(notify.isModeEnabled("BB_RSI"), true, "BB_RSI must still default ON");
  assert.strictEqual(notify.modeGroup("EMA_RSI_ST_V2-PAPER"), "EMA_RSI_ST_V2",
    "a V2 mode string must never fall through to V1's group");
});

check("Start-All / consolidated report / edge analytics exclude V2 until switched on", () => {
  const { enabledStrategies } = require("../src/utils/sharedNav");
  const modes = () => enabledStrategies().map((s) => s.mode);
  assert.ok(!withV2Unset(modes).includes("EMA_RSI_ST_V2"), "V2 must not be in the roster by default");
  assert.ok(withV2On(modes).includes("EMA_RSI_ST_V2"), "…and must appear once enabled");
  assert.ok(withV2Unset(modes).includes("EMA_RSI_ST"), "V1 must still default ON");
});

check("the stock scanner excludes V2 until it is switched on", () => {
  const { activeAdapters } = require("../src/services/swingStrategyAdapters");
  const keys = () => activeAdapters().map((a) => a.key);
  assert.ok(!withV2Unset(keys).includes("EMA_RSI_ST_V2"));
  assert.ok(withV2On(keys).includes("EMA_RSI_ST_V2"));
  assert.ok(withV2Unset(keys).includes("EMA_RSI_ST"), "V1 must still default ON");
});

check("both consolidation screens default V2 off without disturbing other modes", () => {
  for (const f of ["routes/consolidation.js", "routes/liveConsolidation.js"]) {
    const src = read(f);
    assert.ok(/_DEFAULT_OFF_MODES/.test(src), `${f} must carry the default-off set`);
    assert.ok(/"EMA_RSI_ST_V2"/.test(src.slice(src.indexOf("_DEFAULT_OFF_MODES"), src.indexOf("_DEFAULT_OFF_MODES") + 200)),
      `${f} must list EMA_RSI_ST_V2 as default-off`);
  }
});

check("live orders stay double-gated and default to dry-run", () => {
  const dry = require("../src/utils/liveDryRun");
  const keys = ["LIVE_HARNESS_DRY_RUN", "EMA_RSI_ST_V2_LIVE_ENABLED", "EMA_RSI_ST_V2_LIVE_DRY_RUN"];
  const prev = keys.map((k) => process.env[k]);
  const set = (o) => { keys.forEach((k) => delete process.env[k]); Object.assign(process.env, o); };
  try {
    set({});
    assert.strictEqual(dry.isDryRun("EMA_RSI_ST_V2"), true, "defaults must be dry-run");
    set({ LIVE_HARNESS_DRY_RUN: "false" });
    assert.strictEqual(dry.isDryRun("EMA_RSI_ST_V2"), true, "global off alone must NOT arm V2");
    set({ LIVE_HARNESS_DRY_RUN: "false", EMA_RSI_ST_V2_LIVE_ENABLED: "true" });
    assert.strictEqual(dry.isDryRun("EMA_RSI_ST_V2"), false, "both gates open = real orders");
    set({ LIVE_HARNESS_DRY_RUN: "false", EMA_RSI_ST_V2_LIVE_ENABLED: "true", EMA_RSI_ST_V2_LIVE_DRY_RUN: "true" });
    assert.strictEqual(dry.isDryRun("EMA_RSI_ST_V2"), true, "the hold-back override must win");
  } finally { keys.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; }); }
});

check("the paper route refuses to start while V2 is disabled", () => {
  const code = read("routes/emaRsiStV2Paper.js");
  assert.ok(/EMA_RSI_ST_V2_MODE_ENABLED \|\| "false"/.test(code), "master toggle must gate /start and default off");
  assert.ok(/EMA_RSI_ST_V2_PAPER_ENABLED \|\| "false"/.test(code), "paper toggle must gate /start and default off");
});

check("the chart reads the SAME config the strategy trades", () => {
  const code = read("routes/emaRsiStV2Paper.js");
  assert.ok(!/EMA_RSI_ST_V2_SUPERTREND_MULT/.test(code),
    "the chart must call engine.getConfig(), not re-derive SuperTrend from env — it defaulted to 3 while the engine used 2");
});

// ═══════════════════════════════════════════════════════════════════════════
section("Group 8 — the BANKNIFTY twin trades ITS OWN settings");
// ═══════════════════════════════════════════════════════════════════════════
// Both variants share one engine, so the ONLY thing separating them is the
// prefix each route passes. An engine call that omits it silently falls back to
// DEFAULT_PREFIX and the BANKNIFTY strategy trades NIFTY's tuning — this really
// happened in the BN backtest route, which also required a bn_ema_rsi_st_v2.js
// engine that does not (and must not) exist.

const BN_ROUTES = [
  "routes/bnEmaRsiStV2Paper.js",
  "routes/bnEmaRsiStV2Backtest.js",
  "routes/bnEmaRsiStV2LiveHarness.js",
];

check("every BN route exists and shares the ONE engine file", () => {
  for (const f of BN_ROUTES) assert.ok(exists(f), `${f} is missing`);
  assert.ok(!exists("strategies/bn_ema_rsi_st_v2.js"),
    "the BN variant must share ema_rsi_st_v2.js, never copy it");
  for (const f of [BN_ROUTES[0], BN_ROUTES[1]]) {
    const src = read(f);
    assert.ok(/require\("\.\.\/strategies\/ema_rsi_st_v2"\)/.test(src),
      `${f} must require the shared engine`);
    assert.ok(!/strategies\/bn_ema_rsi_st_v2/.test(src),
      `${f} requires an engine file that does not exist`);
  }
});

check("EVERY engine call in the BN routes carries the BN prefix", () => {
  const CALL = /engine\.(getSignal|getConfig|trailStop|warmupBars|computeSeries|isInTradingWindow)\s*\(/g;
  for (const f of [BN_ROUTES[0], BN_ROUTES[1]]) {
    // strip comments so prose mentioning engine.trailStop() is not counted
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(/PREFIX\s*=\s*"BN_EMA_RSI_ST_V2"/.test(code), `${f} must declare the BN prefix`);
    let m, n = 0;
    while ((m = CALL.exec(code))) {
      // the call plus its argument list, up to the matching newline-ish window
      const seg = code.slice(m.index, m.index + 220);
      assert.ok(/PREFIX|stratCfg|\bcfg\b|\bc\b\s*\)/.test(seg),
        `${f}: engine.${m[1]}() at offset ${m.index} does not pass the BN prefix — it would use NIFTY's settings`);
      n++;
    }
    assert.ok(n > 0, `${f}: found no engine calls at all — the grep is wrong`);
  }
});

check("the BN routes trade BANKNIFTY, not NIFTY 50", () => {
  const paper = read(BN_ROUTES[0]);
  assert.ok(!/NIFTY50/.test(paper),
    "a hardcoded NSE:NIFTY50-INDEX would feed NIFTY prices into BANKNIFTY option trades");
  assert.ok(/UNDERLYING\s*=\s*"BANKNIFTY"/.test(paper), "must declare the BANKNIFTY underlying");
  assert.ok(/underlyingOf\(/.test(paper), "spot/strike/lot must come from underlyingOf(), not literals");
});

check("BN and NIFTY tune independently through the shared engine", () => {
  clearV2Env(); clearBnEnv();
  process.env.BN_EMA_RSI_ST_V2_RSI_CE_MIN = "70";
  process.env.BN_EMA_RSI_ST_V2_SUPERTREND_MULT = "3.5";
  const bn = v2.getConfig(BN), ni = v2.getConfig();
  assert.strictEqual(bn.RSI_CE_MIN, 70);
  assert.strictEqual(bn.ST_MULT, 3.5);
  assert.strictEqual(ni.RSI_CE_MIN, 52, "the NIFTY variant must be untouched");
  assert.strictEqual(ni.ST_MULT, 2);
  clearBnEnv();
});

check("the BN tick callback is BOUND to the BANKNIFTY index", () => {
  // socketManager is multi-index and delivers a tick only to callbacks whose
  // symbol matches (strict positive match, socketManager.js ~line 650). A route
  // that passes onTick to start() instead registers as the PRIMARY callback and,
  // on a socket already pointed at NIFTY 50, would silently build NIFTY candles
  // under a BANKNIFTY name — the highest-consequence bug in a two-index build.
  const code = read(BN_ROUTES[0]).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(/socketManager\.addCallback\(\s*SOCKET_CALLBACK_ID\s*,\s*onTick\s*,[^)]*subscribeSymbol/.test(code),
    "onTick must be registered via addCallback() bound to the BANKNIFTY symbol");
  assert.ok(!/socketManager\.start\(\s*subscribeSymbol\s*,\s*onTick/.test(code),
    "passing onTick to start() registers it as the primary callback — it would receive the other index's ticks");
  assert.ok(/socketManager\.removeCallback\(/.test(code),
    "the callback must be removed on teardown or it leaks on the shared socket");
});

check("BANKNIFTY option symbols are parsed as BANKNIFTY, not NIFTY", () => {
  const code = read(BN_ROUTES[0]).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/NSE:NIFTY[0-9]/.test(code),
    "a hardcoded NSE:NIFTY… option regex would blank strike/expiry on every BANKNIFTY trade record");
  assert.ok(/optPrefix|strikeStep/.test(code),
    "strike/expiry parsing must derive from the underlying, not a NIFTY literal");
});

check("the BN live path is the harness only, and stays double-gated", () => {
  assert.ok(!exists("routes/bnEmaRsiStV2Live.js"), "no second live implementation");
  const h = read(BN_ROUTES[2]);
  assert.ok(/BN_EMA_RSI_ST_V2_LIVE_ENABLED/.test(h), "must read its OWN live gate");
  assert.ok(/isDryRun\("BN_EMA_RSI_ST_V2"\)/.test(h), "must ask liveDryRun with its own key");
});

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail ? "FAILURES" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

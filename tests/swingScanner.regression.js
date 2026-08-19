#!/usr/bin/env node
/**
 * SWING SCANNER INVARIANTS
 *
 *   node tests/swingScanner.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Nothing here
 * opens a socket, contacts a broker, or places an order — the scan engine is
 * driven through its injectable history hook over deterministic fixtures.
 *
 * The rules these assertions defend, and the bug each one pins:
 *
 *   GROUP 1  A strategy's signal must be the STRATEGY's, not a copy. Price
 *            Action remembers a breakout across bars in module-level state, so
 *            a scanner that called getSignal once per symbol would (a) never
 *            produce a PA entry at all, since the breakout bar itself never
 *            enters, and (b) leak one symbol's pending breakout into the next
 *            symbol scanned. Both failures are silent.
 *
 *   GROUP 2  Point-based thresholds are calibrated for NIFTY at ~24,000.
 *            Applied raw to a ₹150 share, a 50-point minimum band width is a
 *            third of the share price and nothing ever signals. The rescale
 *            must happen, and must be reverted afterwards so a scan cannot
 *            leave a mutated threshold behind for a live engine to read.
 *
 *   GROUP 3  A 4-hour and a weekly bar are BUILT here, not fetched. Their
 *            grouping (session-anchored fours; Monday weeks, current week
 *            dropped) is what makes the scan agree with a chart, and a partial
 *            weekly bar makes indicators flip and un-flip mid-week.
 *
 *   GROUP 4  A broker error is not "no data". Fyers answers an expired token
 *            with an error object carrying no candles; classified as emptiness
 *            it reports every symbol as delisted and points nowhere near the
 *            login.
 *
 *   GROUP 5  Wiring. A page that is not mounted, not gated by a Settings
 *            toggle, or whose order endpoint is in the open-paths list is a
 *            defect regardless of how well the engine works.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");
// Prose that merely mentions code is not code. The source assertions below run
// on decommented text so a header comment that NAMES sharedSocketState (to say
// the page deliberately does not use it) cannot fail the assertion that the page
// does not use it. Same helper, same reason, as configFidelity.regression.js.
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

let pass = 0, fail = 0;
const QUEUE = [];
function check(name, fn) { QUEUE.push({ name, fn }); }
function section(title) { QUEUE.push({ section: title }); }
async function run() {
  for (const item of QUEUE) {
    if (item.section) { console.log(`\n${item.section}`); continue; }
    try { await item.fn(); console.log(`  ✅ ${item.name}`); pass++; }
    catch (e) { console.log(`  ❌ ${item.name}\n       ${e.message}`); fail++; }
  }
}

// Deterministic env. Set BEFORE the modules load so nothing reads a developer's
// own .env and passes (or fails) by luck.
Object.assign(process.env, {
  TZ: "Asia/Calcutta",
  SWING_SCANNER_SCALE_THRESHOLDS: "true",
  SWING_SCANNER_NIFTY_REF: "24000",
  SWING_SCANNER_CONCURRENCY: "4",
  EMA_RSI_ST_MODE_ENABLED: "true",
  BB_RSI_MODE_ENABLED: "true",
  PA_MODE_ENABLED: "true",
  RSI_PIVOT_ST_MODE_ENABLED: "true",
});

const F         = require("./swingScanner.fixtures");
const scanner   = require("../src/services/swingScanner");
const adapters  = require("../src/services/swingStrategyAdapters");
const universe  = require("../src/utils/stockUniverse");
const paModule  = require("../src/strategies/price_action");

// ─────────────────────────────────────────────────────────────────────────────
section("Universe");

check("the three presets exist, are non-empty and carry no duplicates", () => {
  for (const key of ["NIFTY50", "NIFTY100", "FNO"]) {
    const list = universe.BUILTIN[key].symbols;
    assert.ok(list.length > 0, `${key} is empty`);
    assert.strictEqual(new Set(list).size, list.length, `${key} has duplicate symbols`);
  }
});

check("each preset is a superset of the smaller one", () => {
  const n50 = new Set(universe.BUILTIN.NIFTY50.symbols);
  const n100 = new Set(universe.BUILTIN.NIFTY100.symbols);
  for (const s of n50) assert.ok(n100.has(s), `${s} is in NIFTY50 but not NIFTY100`);
  const fno = new Set(universe.BUILTIN.FNO.symbols);
  for (const s of n100) assert.ok(fno.has(s), `${s} is in NIFTY100 but not FNO`);
});

check("the two symbol forms are distinct and never mixed up", () => {
  // The whole point of these helpers: Kite rejects "RELIANCE-EQ", Fyers rejects
  // "RELIANCE". A single shared spelling would break one of the two silently.
  assert.strictEqual(universe.fyersSymbol("reliance"), "NSE:RELIANCE-EQ");
  assert.deepStrictEqual(universe.zerodhaSymbol("reliance"), { exchange: "NSE", tradingsymbol: "RELIANCE" });
  assert.strictEqual(universe.plainSymbol("NSE:M&M-EQ"), "M&M");
  assert.strictEqual(universe.plainSymbol(universe.fyersSymbol("BAJAJ-AUTO")), "BAJAJ-AUTO");
});

check("convertSymbol must NOT be used for equities (it produces the wrong form)", () => {
  // Pins the reason placeEquityOrder takes a plain tradingsymbol instead.
  const zerodha = require("../src/services/zerodhaBroker");
  const wrong = zerodha.convertSymbol(universe.fyersSymbol("RELIANCE"));
  assert.strictEqual(wrong.tradingsymbol, "RELIANCE-EQ",
    "if this ever returns RELIANCE, re-check whether placeEquityOrder still needs its own path");
  assert.notStrictEqual(wrong.tradingsymbol, universe.zerodhaSymbol("RELIANCE").tradingsymbol);
});

check("a malformed override file degrades to the built-ins instead of throwing", () => {
  const file = universe.OVERRIDE_FILE;
  const had  = fs.existsSync(file);
  const bak  = had ? fs.readFileSync(file, "utf-8") : null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json");
    const { universes, error } = universe.listUniverses();
    assert.ok(error, "a broken override must be reported, not swallowed");
    assert.strictEqual(universes.length, 3, "the built-ins must still be offered");
    assert.strictEqual(universe.getUniverse("NIFTY50").length, universe.BUILTIN.NIFTY50.symbols.length);
  } finally {
    if (had) fs.writeFileSync(file, bak); else { try { fs.unlinkSync(file); } catch (_) {} }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 3 — bar aggregation");

check("4h groups in fours from each session open and never spans a day", () => {
  const hourly = F.hourly({ sessions: 6, start: 1000, seed: 11 });
  const h4 = scanner.aggregateTo4H(hourly);
  const dayOf = t => scanner.istDayKey(t);
  const perDay = new Map();
  for (const b of h4) perDay.set(dayOf(b.time), (perDay.get(dayOf(b.time)) || 0) + 1);
  // NSE gives 7 hourly bars: one full four, then a 3-bar tail.
  for (const [, n] of perDay) assert.strictEqual(n, 2, "expected 2 four-hour bars per session");

  const day1 = hourly.filter(c => dayOf(c.time) === dayOf(hourly[0].time));
  const agg1 = h4.filter(c => dayOf(c.time) === dayOf(h4[0].time))[0];
  assert.strictEqual(agg1.open,  day1[0].open,  "open comes from the first bar");
  assert.strictEqual(agg1.close, day1[3].close, "close comes from the fourth");
  assert.strictEqual(agg1.high,  Math.max(...day1.slice(0, 4).map(c => c.high)));
  assert.strictEqual(agg1.low,   Math.min(...day1.slice(0, 4).map(c => c.low)));
  assert.strictEqual(agg1.volume, day1.slice(0, 4).reduce((a, c) => a + c.volume, 0), "volume is summed, not averaged");
});

check("weekly groups Monday→Friday and DROPS the current, still-forming week", () => {
  const daily = F.daily({ sessions: 60, start: 500, seed: 4 });
  const nowSec = daily[daily.length - 1].time + 86400;      // "today" is inside that last week
  const weekly = scanner.aggregateToWeekly(daily, nowSec);
  const weekOf = t => Math.floor((scanner.istDayKey(t) + 3) / 7);
  assert.ok(weekly.length > 0, "some weeks must survive");
  assert.ok(weekOf(weekly[weekly.length - 1].time) < weekOf(nowSec),
    "the week containing 'now' must not be emitted — a partial weekly bar moves every indicator on it");
  for (let i = 1; i < weekly.length; i++) {
    assert.ok(weekOf(weekly[i].time) > weekOf(weekly[i - 1].time), "one bar per week, ascending");
  }
});

check("a holiday-shortened week is still exactly one bar", () => {
  const daily = F.daily({ sessions: 30, start: 500, seed: 9 });
  // Drop a Wednesday to simulate a mid-week holiday.
  const wed = daily.findIndex(c => scanner.istWeekday(c.time) === 3);
  const gapped = daily.filter((_, i) => i !== wed);
  const before = scanner.aggregateToWeekly(daily,  daily[daily.length - 1].time + 7 * 86400).length;
  const after  = scanner.aggregateToWeekly(gapped, daily[daily.length - 1].time + 7 * 86400).length;
  assert.strictEqual(after, before, "removing one session must not remove a week");
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 1 — signals come from the strategies themselves");

check("every adapter names a strategy that actually exists and is switched on", () => {
  const nav = require("../src/utils/sharedNav");
  const known = new Set(nav.STRATEGY_MODES.map(m => m.envKey));
  for (const a of adapters.ADAPTERS) {
    assert.ok(known.has(a.envKey), `${a.key} is gated by ${a.envKey}, which sharedNav does not know about`);
  }
});

check("the dropdown drops a strategy the moment its Settings toggle goes off", () => {
  const before = adapters.activeAdapters().map(a => a.key);
  assert.ok(before.includes("PA"), "PA should be on for this suite");
  process.env.PA_MODE_ENABLED = "false";
  try {
    assert.ok(!adapters.activeAdapters().map(a => a.key).includes("PA"), "PA must disappear");
  } finally { process.env.PA_MODE_ENABLED = "true"; }
  assert.deepStrictEqual(adapters.activeAdapters().map(a => a.key), before, "and come back");
});

check("PA fires on a double bottom ONLY when the tail is replayed", () => {
  // This is the invariant that a naive one-call-per-symbol scanner breaks.
  const pa   = adapters.getAdapter("PA");
  const bars = F.paDoubleBottomSetup();

  const replayed = adapters.evaluateSymbol(pa, bars, { tfMinutes: 60, dailyCandles: [], replayBars: pa.replayBars });
  assert.strictEqual(replayed.side, "LONG", `replayed PA should enter, got: ${replayed.reason}`);
  assert.ok(/Double Bottom/i.test(replayed.reason), replayed.reason);

  paModule.reset();
  const single = adapters.withScaledEnv(pa.scaleKeys, bars[bars.length - 1].close,
    () => paModule.getSignal(bars, { silent: true, skipTimeCheck: true }));
  assert.strictEqual(single.value.signal, "NONE",
    "a single call on the last bar must NOT enter — if this starts passing, PA's retest rule changed and replayBars should be re-derived");
});

check("PA state cannot leak from one symbol into the next", () => {
  const pa = adapters.getAdapter("PA");
  // Leave a pending breakout behind, deliberately.
  adapters.evaluateSymbol(pa, F.paDoubleBottomSetup().slice(0, -1), { tfMinutes: 60, dailyCandles: [], replayBars: pa.replayBars });
  // A flat, patternless series must be judged on its own merits.
  const flat = F.hourly({ sessions: 60, start: 900, drift: 0, vol: 0.0015, seed: 77 });
  const next = adapters.evaluateSymbol(pa, flat, { tfMinutes: 60, dailyCandles: [], replayBars: pa.replayBars });
  assert.strictEqual(next.side, null, `a clean symbol inherited a signal: ${next.reason}`);
});

check("BB_RSI's memoised indicator cache is cleared between symbols", () => {
  const bb = adapters.getAdapter("BB_RSI");
  assert.strictEqual(typeof bb.reset, "function", "BB_RSI adapter must declare a reset");
  // Two series identical in length and previous-bar time — the parts of the
  // module's cache key that are NOT price — must still be evaluated separately.
  const a = F.hourly({ sessions: 60, start: 1000, seed: 21 });
  const b = F.hourly({ sessions: 60, start: 1000, seed: 22 });
  assert.strictEqual(a.length, b.length);
  const ra = adapters.evaluateSymbol(bb, a, { tfMinutes: 60, dailyCandles: [] });
  const rb = adapters.evaluateSymbol(bb, b, { tfMinutes: 60, dailyCandles: [] });
  assert.notStrictEqual(ra.indicators.BBmiddle, rb.indicators.BBmiddle,
    "two different price series produced the same band — the cache was reused across symbols");
});

check("BUY_CE maps to LONG and BUY_PE to SHORT, nothing else signals", () => {
  assert.strictEqual(adapters.sideFromSignal("BUY_CE"), "LONG");
  assert.strictEqual(adapters.sideFromSignal("BUY_PE"), "SHORT");
  for (const v of ["NONE", "", null, undefined, "BUY", "LONG"]) {
    assert.strictEqual(adapters.sideFromSignal(v), null, `"${v}" must not become a signal`);
  }
});

check("RSI_PIVOT_ST refuses the weekly timeframe rather than inventing an answer", () => {
  const rp = adapters.getAdapter("RSI_PIVOT_ST");
  assert.ok(!adapters.supportsTimeframe(rp, "W"), "weekly must be unsupported — its levels are previous-DAY pivots");
  assert.ok(adapters.supportsTimeframe(rp, "60"));
  assert.ok(rp.timeframeNote, "an unsupported timeframe must come with a reason the UI can show");
});

check("every adapter supports at least the 1-hour timeframe and declares a warm-up", () => {
  for (const a of adapters.ADAPTERS) {
    assert.ok(a.timeframes.includes("60"), `${a.key} does not support 1h`);
    assert.ok(a.minBars() >= 20, `${a.key} warm-up looks wrong: ${a.minBars()}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 2 — point thresholds rescaled to the stock, then restored");

check("a NIFTY point value becomes the same PERCENTAGE of the stock's price", () => {
  process.env.BB_RSI_MIN_BAND_WIDTH_PTS = "50";
  const { scaled } = adapters.withScaledEnv(
    [{ key: "BB_RSI_MIN_BAND_WIDTH_PTS", def: "50" }], 1200, () => null);
  // 50 points on NIFTY 24000 = 0.2083%; on a ₹1200 share that is ₹2.50.
  assert.strictEqual(scaled.BB_RSI_MIN_BAND_WIDTH_PTS.from, 50);
  assert.ok(Math.abs(scaled.BB_RSI_MIN_BAND_WIDTH_PTS.to - 2.5) < 0.001,
    `expected ~2.5, got ${scaled.BB_RSI_MIN_BAND_WIDTH_PTS.to}`);
});

check("the env is restored afterwards — a scan cannot leave a live engine mistuned", () => {
  process.env.PA_MIN_SL_PTS = "8";
  delete process.env.PA_MAX_SL_PTS;                       // previously UNSET
  adapters.withScaledEnv(
    [{ key: "PA_MIN_SL_PTS", def: "8" }, { key: "PA_MAX_SL_PTS", def: "25" }], 900, () => {
      assert.notStrictEqual(process.env.PA_MIN_SL_PTS, "8", "should be rescaled inside the call");
    });
  assert.strictEqual(process.env.PA_MIN_SL_PTS, "8", "a set key must be restored to its value");
  assert.strictEqual(process.env.PA_MAX_SL_PTS, undefined, "an unset key must be restored to UNSET, not to a string");
});

check("the env is restored even when the strategy throws", () => {
  process.env.PA_MIN_SL_PTS = "8";
  assert.throws(() => adapters.withScaledEnv([{ key: "PA_MIN_SL_PTS", def: "8" }], 900, () => {
    throw new Error("boom");
  }), /boom/);
  assert.strictEqual(process.env.PA_MIN_SL_PTS, "8", "restored through the throw");
});

check("scaling OFF passes the raw values through untouched", () => {
  process.env.SWING_SCANNER_SCALE_THRESHOLDS = "false";
  try {
    process.env.PA_MIN_SL_PTS = "8";
    const { scaled } = adapters.withScaledEnv([{ key: "PA_MIN_SL_PTS", def: "8" }], 900, () => null);
    assert.deepStrictEqual(scaled, {}, "nothing should be rescaled");
    assert.strictEqual(process.env.PA_MIN_SL_PTS, "8");
  } finally { process.env.SWING_SCANNER_SCALE_THRESHOLDS = "true"; }
});

check("a malformed threshold is left alone rather than turned into NaN", () => {
  process.env.PA_MIN_SL_PTS = "8o";
  try {
    const { scaled } = adapters.withScaledEnv([{ key: "PA_MIN_SL_PTS", def: "8" }], 900, () => null);
    assert.strictEqual(scaled.PA_MIN_SL_PTS, undefined, "an unparseable value must not be scaled");
    assert.strictEqual(process.env.PA_MIN_SL_PTS, "8o", "and must be left exactly as the operator wrote it");
  } finally { process.env.PA_MIN_SL_PTS = "8"; }
});

check("EMA_RSI_ST declares no point thresholds — its entry has none to rescale", () => {
  assert.deepStrictEqual(adapters.getAdapter("EMA_RSI_ST").scaleKeys, [],
    "if EMA_RSI_ST gains an absolute-point gate, it must be added here or stocks will be judged on NIFTY distances");
});

// ─────────────────────────────────────────────────────────────────────────────
section("Scoring");

check("score is 0–100 and its four parts add up to it", () => {
  const bars = F.hourly({ sessions: 80, start: 1000, drift: 0.0005, seed: 31 });
  const s = scanner.scoreRow(bars, "LONG", bars[bars.length - 1].close, bars[bars.length - 1].close * 0.97);
  assert.ok(s.score >= 0 && s.score <= 100, `score out of range: ${s.score}`);
  const sum = s.parts.liquidity + s.parts.risk + s.parts.trend + s.parts.volume;
  assert.ok(Math.abs(sum - s.score) <= 2, `parts ${sum} do not reconstruct score ${s.score}`);
});

check("a missing stop scores zero for risk rather than being treated as riskless", () => {
  const bars = F.hourly({ sessions: 80, start: 1000, seed: 32 });
  const s = scanner.scoreRow(bars, "LONG", bars[bars.length - 1].close, null);
  assert.strictEqual(s.parts.risk, 0);
  assert.strictEqual(s.stopPct, null);
});

check("a sane 1–6% stop scores full risk marks; too tight and too wide do not", () => {
  const bars = F.hourly({ sessions: 80, start: 1000, seed: 33 });
  const p = bars[bars.length - 1].close;
  assert.strictEqual(scanner.scoreRow(bars, "LONG", p, p * 0.97).parts.risk, 25, "3% stop");
  assert.ok(scanner.scoreRow(bars, "LONG", p, p * 0.999).parts.risk < 25, "0.1% stop is inside the noise");
  assert.ok(scanner.scoreRow(bars, "LONG", p, p * 0.80).parts.risk < 25, "20% stop is not a swing stop");
});

check("trend marks favour the trade's own direction", () => {
  const up = F.hourly({ sessions: 80, start: 1000, drift: 0.0012, vol: 0.002, seed: 34 });
  const p  = up[up.length - 1].close;
  const long  = scanner.scoreRow(up, "LONG",  p, p * 0.97);
  const short = scanner.scoreRow(up, "SHORT", p, p * 1.03);
  assert.ok(long.parts.trend > short.parts.trend,
    `in an uptrend LONG must out-score SHORT on trend (${long.parts.trend} vs ${short.parts.trend})`);
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 4 — a broker error is not 'no data'");

const HISTORY_CASES = {
  ok:      () => ({ s: "ok", candles: F.hourly({ sessions: 300, start: 1000, seed: 51 }).map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]) }),
  nodata:  () => ({ s: "no_data" }),
  authErr: () => ({ s: "error", code: -16, message: "Could not authenticate the user" }),
};

function stubHistory(pick) {
  scanner._setHistoryFn(async (params) => {
    const kind = pick(params.symbol);
    const body = HISTORY_CASES[kind]();
    if (kind !== "ok") return body;
    const from = new Date(params.range_from).getTime() / 1000;
    const to   = new Date(params.range_to).getTime() / 1000 + 86399;
    return { s: "ok", candles: body.candles.filter(c => c[0] >= from && c[0] <= to) };
  });
}

function withUniverse(list, fn) {
  const file = universe.OVERRIDE_FILE;
  const had  = fs.existsSync(file);
  const bak  = had ? fs.readFileSync(file, "utf-8") : null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ REGRESSION: list }));
  return Promise.resolve()
    .then(fn)
    .finally(() => { if (had) fs.writeFileSync(file, bak); else { try { fs.unlinkSync(file); } catch (_) {} } });
}

async function runScan(opts) {
  const { job } = scanner.startScan(opts);
  const deadline = Date.now() + 20000;
  while (job.status === "running" && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  return job;
}

check("an auth error is reported as an auth error, not as a delisted symbol", async () => {
  stubHistory(sym => sym.includes("BADAUTH") ? "authErr" : "ok");
  await withUniverse(["GOODCO", "BADAUTH"], async () => {
    const job = await runScan({ strategy: "EMA_RSI_ST", timeframe: "60", universe: "REGRESSION" });
    assert.strictEqual(job.status, "done");
    const skip = job.skipped.find(s => s.symbol === "BADAUTH");
    assert.ok(skip, "the failing symbol must be reported");
    assert.ok(/authenticate/i.test(skip.reason), `reason must name the auth failure, got: ${skip.reason}`);
    assert.ok(!/delisted/i.test(skip.reason), "and must NOT blame the symbol");
  });
});

check("a genuinely empty symbol IS reported as having no data", async () => {
  stubHistory(sym => sym.includes("EMPTYCO") ? "nodata" : "ok");
  await withUniverse(["GOODCO", "EMPTYCO"], async () => {
    const job = await runScan({ strategy: "EMA_RSI_ST", timeframe: "60", universe: "REGRESSION" });
    const skip = job.skipped.find(s => s.symbol === "EMPTYCO");
    assert.ok(/no data/i.test(skip.reason), skip.reason);
  });
});

check("a whole-universe failure is called out once, not left as N identical rows", async () => {
  stubHistory(() => "authErr");
  await withUniverse(["A1", "A2", "A3", "A4", "A5", "A6"], async () => {
    const job = await runScan({ strategy: "EMA_RSI_ST", timeframe: "60", universe: "REGRESSION" });
    assert.ok(job.systemic, "a systemic failure must be summarised");
    assert.strictEqual(job.systemic.count, 6);
    assert.ok(/authenticate/i.test(job.systemic.reason), job.systemic.reason);
  });
});

check("one bad symbol never ends the scan", async () => {
  stubHistory(sym => sym.includes("BADAUTH") ? "authErr" : "ok");
  await withUniverse(["G1", "BADAUTH", "G2", "G3"], async () => {
    const job = await runScan({ strategy: "EMA_RSI_ST", timeframe: "60", universe: "REGRESSION" });
    assert.strictEqual(job.status, "done");
    assert.strictEqual(job.rows.length, 3, "the three good symbols must still be evaluated");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
section("Scan jobs");

check("an unsupported strategy/timeframe pair is refused up front", async () => {
  await withUniverse(["G1"], async () => {
    assert.throws(() => scanner.startScan({ strategy: "RSI_PIVOT_ST", timeframe: "W", universe: "REGRESSION" }),
      /does not support/i);
    assert.throws(() => scanner.startScan({ strategy: "NOPE", timeframe: "60", universe: "REGRESSION" }), /Unknown strategy/i);
    assert.throws(() => scanner.startScan({ strategy: "EMA_RSI_ST", timeframe: "3", universe: "REGRESSION" }), /Unknown timeframe/i);
    assert.throws(() => scanner.startScan({ strategy: "EMA_RSI_ST", timeframe: "60", universe: "NOSUCH" }), /empty or unknown/i);
  });
});

check("a strategy switched off in Settings cannot be scanned", async () => {
  await withUniverse(["G1"], async () => {
    process.env.BB_RSI_MODE_ENABLED = "false";
    try {
      assert.throws(() => scanner.startScan({ strategy: "BB_RSI", timeframe: "60", universe: "REGRESSION" }), /switched off/i);
    } finally { process.env.BB_RSI_MODE_ENABLED = "true"; }
  });
});

check("pressing Search twice re-attaches instead of scanning twice", async () => {
  stubHistory(() => "ok");
  await withUniverse(["G1", "G2", "G3"], async () => {
    const first  = scanner.startScan({ strategy: "EMA_RSI_ST", timeframe: "60", universe: "REGRESSION" });
    const second = scanner.startScan({ strategy: "EMA_RSI_ST", timeframe: "60", universe: "REGRESSION" });
    assert.strictEqual(second.reused, true);
    assert.strictEqual(second.job.id, first.job.id);
    while (first.job.status === "running") await new Promise(r => setTimeout(r, 20));
  });
});

check("a DIFFERENT scan is refused while one is running", async () => {
  stubHistory(() => "ok");
  await withUniverse(["G1", "G2", "G3", "G4", "G5", "G6"], async () => {
    const { job } = scanner.startScan({ strategy: "EMA_RSI_ST", timeframe: "60", universe: "REGRESSION" });
    try {
      assert.throws(() => scanner.startScan({ strategy: "BB_RSI", timeframe: "15", universe: "REGRESSION" }), /already running/i);
    } finally { while (job.status === "running") await new Promise(r => setTimeout(r, 20)); }
  });
});

check("cancel stops a scan and marks it cancelled", async () => {
  stubHistory(() => "ok");
  await withUniverse(["G1", "G2", "G3", "G4"], async () => {
    const { job } = scanner.startScan({ strategy: "EMA_RSI_ST", timeframe: "60", universe: "REGRESSION" });
    scanner.cancelJob(job.id);
    while (job.status === "running") await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(job.status, "cancelled");
  });
});

check("rows are ranked signals-first, then by score", async () => {
  stubHistory(() => "ok");
  await withUniverse(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"], async () => {
    const job = await runScan({ strategy: "EMA_RSI_ST", timeframe: "60", universe: "REGRESSION" });
    let seenBlank = false;
    for (const r of job.rows) {
      if (!r.side) seenBlank = true;
      else assert.ok(!seenBlank, "a signal row appeared after a no-signal row");
    }
    const sig = job.rows.filter(r => r.side);
    for (let i = 1; i < sig.length; i++) assert.ok(sig[i - 1].score >= sig[i].score, "signals must descend by score");
  });
});

check("the public job view never leaks internal control fields", async () => {
  stubHistory(() => "ok");
  await withUniverse(["G1"], async () => {
    const job = await runScan({ strategy: "EMA_RSI_ST", timeframe: "60", universe: "REGRESSION" });
    const view = scanner.jobView(job);
    assert.strictEqual(view.cancelRequested, undefined);
    for (const k of ["id", "status", "progress", "rows", "skipped", "stats"]) {
      assert.ok(k in view, `jobView must expose ${k}`);
    }
  });
});

scanner._resetHistoryFn();

// ─────────────────────────────────────────────────────────────────────────────
section("Order routing");

check("market hours pick a regular order; everything else becomes an AMO", () => {
  // 2026-08-19 is a Wednesday. 09:15 IST = 03:45 UTC.
  const wedOpen  = Date.UTC(2026, 7, 19, 5, 0,  0) / 1000;   // 10:30 IST
  const wedPre   = Date.UTC(2026, 7, 19, 3, 0,  0) / 1000;   // 08:30 IST
  const wedPost  = Date.UTC(2026, 7, 19, 12, 0, 0) / 1000;   // 17:30 IST
  const satNoon  = Date.UTC(2026, 7, 22, 6, 30, 0) / 1000;   // Saturday
  assert.strictEqual(scanner.orderPlan(wedOpen).variety, "regular");
  assert.strictEqual(scanner.orderPlan(wedPre).variety,  "amo");
  assert.strictEqual(scanner.orderPlan(wedPost).variety, "amo");
  assert.strictEqual(scanner.orderPlan(satNoon).variety, "amo");
  assert.ok(/weekend/i.test(scanner.orderPlan(satNoon).reason), "a weekend should say so");
});

check("the boundary minutes fall on the right side", () => {
  const at = (h, m) => Date.UTC(2026, 7, 19, h - 5, m - 30, 0) / 1000;   // IST → UTC
  assert.strictEqual(scanner.orderPlan(at(9, 14)).variety,  "amo",     "09:14 is pre-open");
  assert.strictEqual(scanner.orderPlan(at(9, 15)).variety,  "regular", "09:15 is the open");
  assert.strictEqual(scanner.orderPlan(at(15, 29)).variety, "regular", "15:29 is still open");
  assert.strictEqual(scanner.orderPlan(at(15, 30)).variety, "amo",     "15:30 is the close");
});

check("the post-close AMO blackout is warned about rather than discovered", () => {
  const at = (h, m) => Date.UTC(2026, 7, 19, h - 5, m - 30, 0) / 1000;
  assert.ok(scanner.orderPlan(at(15, 35)).warning, "15:35 sits in Kite's AMO refusal band");
  assert.ok(!scanner.orderPlan(at(16, 30)).warning, "16:30 is a clean AMO window");
});

check("delivery charges are computed, not guessed", () => {
  const c = scanner.equityBuyCharges(10, 1000);            // ₹10,000 turnover
  assert.strictEqual(c.turnover, 10000);
  assert.strictEqual(c.breakup.brokerage, 0, "Zerodha CNC brokerage is zero");
  assert.ok(Math.abs(c.breakup.stt   - 10)   < 0.01, "STT 0.1%");
  assert.ok(Math.abs(c.breakup.stamp - 1.5)  < 0.01, "stamp 0.015%");
  const sum = Object.values(c.breakup).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - c.total) < 0.02, "the breakup must reconstruct the total");
});

check("a zero or negative order has no charges rather than NaN", () => {
  for (const [q, p] of [[0, 100], [10, 0], [-5, 100]]) {
    const c = scanner.equityBuyCharges(q, p);
    assert.strictEqual(c.total, 0, `qty=${q} price=${p}`);
  }
});

check("placeEquityOrder rejects a malformed quantity before the broker sees it", async () => {
  const zerodha = require("../src/services/zerodhaBroker");
  const had = process.env.ZERODHA_ACCESS_TOKEN;
  process.env.ZERODHA_ACCESS_TOKEN = "regression-token";
  try {
    for (const q of [0, -1, 2.5, NaN, "5"]) {
      const r = await zerodha.placeEquityOrder("RELIANCE", q);
      assert.strictEqual(r.success, false, `qty ${q} must be refused`);
      assert.ok(/Invalid qty/.test(r.raw.error), r.raw.error);
    }
    const bad = await zerodha.placeEquityOrder("RELIANCE", 1, { variety: "iceberg" });
    assert.ok(/Invalid variety/.test(bad.raw.error), "only regular and amo are allowed");
  } finally {
    if (had === undefined) delete process.env.ZERODHA_ACCESS_TOKEN;
    else process.env.ZERODHA_ACCESS_TOKEN = had;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 5 — wiring");

check("the router is mounted in app.js", () => {
  assert.ok(/app\.use\("\/swing-scanner",\s*require\("\.\/routes\/swingScanner"\)\)/.test(read("src/app.js")),
    "swingScanner must be mounted");
});

check("the ORDER endpoint is NOT in the open-paths list", () => {
  const app = read("src/app.js");
  const block = app.slice(app.indexOf("const OPEN_PATHS"), app.indexOf("const OPEN_PREFIXES"));
  assert.ok(!/"\/swing-scanner\/order"/.test(block),
    "the order endpoint places real money orders — it must require API_SECRET");
  assert.ok(/"\/swing-scanner"/.test(block), "the page itself should be readable");
  assert.ok(/"\/swing-scanner\/scan"/.test(block), "starting a read-only scan should be open");
});

check("no OPEN_PREFIXES entry accidentally covers the whole page subtree", () => {
  const app = read("src/app.js");
  const block = app.slice(app.indexOf("const OPEN_PREFIXES"), app.indexOf("app.use((req, res, next)"));
  assert.ok(!/swing-scanner/.test(block),
    "a prefix would open every future sub-route, including writes");
});

check("the sidebar entry exists and is gated by a Settings toggle", () => {
  const nav = read("src/utils/sharedNav.js");
  assert.ok(/UI_SHOW_SWING_SCANNER/.test(nav), "nav must read the toggle");
  assert.ok(/href: '\/swing-scanner'/.test(nav), "nav must link the page");
});

check("that toggle is exposed in Settings, with the strategy toggles it depends on", () => {
  const settings = read("src/routes/settings.js");
  for (const key of ["UI_SHOW_SWING_SCANNER", "SWING_SCANNER_MAX_ORDER_VALUE",
                     "SWING_SCANNER_SCALE_THRESHOLDS", "SWING_SCANNER_NIFTY_REF"]) {
    assert.ok(settings.includes(`"${key}"`), `${key} is missing from the Settings schema`);
  }
});

check("every SWING_SCANNER_* key the code reads is settable from Settings or documented", () => {
  const src = [read("src/services/swingScanner.js"), read("src/services/swingStrategyAdapters.js"),
               read("src/routes/swingScanner.js")].join("\n");
  const used = new Set((src.match(/process\.env\.(SWING_SCANNER_[A-Z0-9_]+)/g) || [])
    .map(m => m.replace("process.env.", "")));
  const settings = read("src/routes/settings.js");
  const envExample = read(".env.example");
  for (const key of used) {
    assert.ok(settings.includes(`"${key}"`) || envExample.includes(key),
      `${key} is read by the code but reachable from neither Settings nor .env.example`);
  }
  assert.ok(used.size >= 5, `expected several tunables, found ${used.size}`);
});

check("the scanner never mutates shared trading state", () => {
  const src = [read("src/services/swingScanner.js"), read("src/services/swingStrategyAdapters.js"),
               read("src/routes/swingScanner.js")].map(decomment).join("\n");
  for (const forbidden of ["sharedSocketState", "positionPersist", "capitalPool", "socketManager"]) {
    assert.ok(!src.includes(forbidden),
      `the scanner touches ${forbidden} — it is a read-only research page and must hold no engine state`);
  }
});

check("the timeframe dropdown cannot reconfigure a live engine", () => {
  const src = [read("src/services/swingScanner.js"), read("src/routes/swingScanner.js")].map(decomment).join("\n");
  assert.ok(!/TRADE_RESOLUTION\s*=/.test(src), "the scanner must never write TRADE_RESOLUTION");
});

// ─────────────────────────────────────────────────────────────────────────────
run().then(() => {
  console.log(`\n${fail ? "FAILURES" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

/**
 * ema9Cross.regression.js — EMA9_CROSS rules, exits, guards and paper/backtest parity
 * ─────────────────────────────────────────────────────────────────────────────
 *   • engine: EMA alignment vs technicalindicators, warm-up refusal, the fresh-cross
 *     entry (CE / PE), "still beyond" is not a cross, window gating, exitSignal,
 *     close ON the EMA holds, NaN / null guards, the period is configurable
 *   • backtest: the EMA9 exit, the flip, the common wait-after-exit blocking the
 *     flip, the premium stop, the session end, no warm-up leak
 *   • paper route: decisions only through the engine (no indicator maths), entry
 *     only at candle close (no intra-candle path), the EMA exit + flip wiring
 *
 *   node tests/ema9Cross.regression.js
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const { EMA } = require("technicalindicators");

let pass = 0, fail = 0;
const _queue = [];
function section(t) { _queue.push({ section: t }); }
function check(name, fn) { _queue.push({ name, fn }); }

// Clean env for the keys this strategy reads.
for (const k of Object.keys(process.env)) {
  if (/^EMA9_CROSS_|^PREMIUM_SL_|^PROFIT_LOCK_|^EXIT_REENTRY_|^MAX_TRADES_PER_DAY$|^VIX_FILTER_ENABLED$|^TRADE_(START|STOP)_TIME$|^TRADE_RESOLUTION$|^TRADE_EXPIRY_DAY_ONLY$|^BACKTEST_/.test(k)) delete process.env[k];
}
process.env.VIX_FILTER_ENABLED = "false";

const engine = require("../src/strategies/ema9_cross");
const SRC = path.join(__dirname, "../src");

// ── Fixtures ────────────────────────────────────────────────────────────────
// 5-min bars from 09:15 IST on 2026-11-02 (a Monday). Each day 75 bars.
const DAY0 = Math.floor(Date.parse("2026-11-02T09:15:00+05:30") / 1000);
function bars(closes, startTs = DAY0) {
  return closes.map((c, i) => ({ time: startTs + i * 300, open: c, high: c + 1, low: c - 1, close: c }));
}
function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); }
  finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
// A flat run then a jump: closes 100 × n, then `last` — the last bar crosses up.
const flatThen = (n, last) => bars([...Array(n).fill(100), last]);

// ─────────────────────────────────────────────────────────────────────────────
section("Engine — indicator");

check("computeSeries matches technicalindicators EMA(9), aligned out[i] ↔ values[i+8]", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
  const s = engine.computeSeries(bars(closes)).ema9;
  const ref = EMA.calculate({ period: 9, values: closes });
  assert.strictEqual(s.length, 60);
  for (let i = 0; i < 8; i++) assert.strictEqual(s[i], null, `bar ${i} is warm-up`);
  for (let i = 0; i < ref.length; i++) assert.strictEqual(s[i + 8], ref[i]);
});
check("the EMA period is a setting (EMA9_CROSS_EMA_PERIOD)", () => {
  withEnv({ EMA9_CROSS_EMA_PERIOD: "20" }, () => {
    assert.strictEqual(engine.getConfig().EMA_PERIOD, 20);
    const s = engine.computeSeries(bars(Array(40).fill(100))).ema9;
    assert.strictEqual(s[18], null); assert.ok(Number.isFinite(s[19]));
    assert.strictEqual(engine.warmupBars(), 62);
  });
  withEnv({ EMA9_CROSS_EMA_PERIOD: "junk" }, () => assert.strictEqual(engine.getConfig().EMA_PERIOD, 9));
  withEnv({ EMA9_CROSS_EMA_PERIOD: "1" }, () => assert.strictEqual(engine.getConfig().EMA_PERIOD, 9, "period < 2 falls back"));
  assert.strictEqual(engine.warmupBars(), 32);
});

section("Engine — entry");

// Window defaults 10:30–14:00; bar index 36 starts 12:15 IST, inside it.
check("warm-up: refuses below warmupBars() candles", () => {
  const r = engine.getSignal(flatThen(20, 120), { silent: true });
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.warmup, true);
  assert.ok(/Warming up \(21\/32/.test(r.reason), r.reason);
  assert.strictEqual(engine.getSignal(null, { silent: true }).warmup, true);
});
check("a close crossing ABOVE EMA9 from at/below → BUY_CE", () => {
  const r = engine.getSignal(flatThen(36, 110), { silent: true });
  assert.strictEqual(r.signal, "BUY_CE"); assert.strictEqual(r.cross, "UP");
  assert.strictEqual(r.closeVsEma, "ABOVE"); assert.strictEqual(r.entrySpot, 110);
  assert.strictEqual(r.prevEma9, 100);
  assert.ok(r.ema9 > 100 && r.ema9 < 110, `ema9 ${r.ema9}`);
  assert.strictEqual(r.stopLoss, null, "no stop of its own — the common premium stop is the stop");
});
check("a close crossing BELOW EMA9 from at/above → BUY_PE", () => {
  const r = engine.getSignal(flatThen(36, 90), { silent: true });
  assert.strictEqual(r.signal, "BUY_PE"); assert.strictEqual(r.cross, "DOWN");
});
check("a close STILL above EMA9 (no cross this bar) is not an entry — re-entry waits for a fresh cross", () => {
  const c = bars([...Array(35).fill(100), 110, 112]);   // crossed on bar 35, still above on 36
  const r = engine.getSignal(c, { silent: true });
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.cross, null); assert.strictEqual(r.closeVsEma, "ABOVE");
});
check("a close exactly ON the EMA is neither a cross nor an exit", () => {
  const r = engine.getSignal(bars(Array(40).fill(100)), { silent: true });
  assert.strictEqual(r.closeVsEma, "ON"); assert.strictEqual(r.signal, "NONE");
  assert.strictEqual(engine.exitSignal(r, "CE"), null); assert.strictEqual(engine.exitSignal(r, "PE"), null);
});
check("entry window: a cross outside 10:30–14:00 is reported (cross) but not a signal", () => {
  const early = engine.getSignal(flatThen(31, 110), { silent: true });   // bar 31 = 11:50 → inside
  assert.strictEqual(early.signal, "BUY_CE");
  const pre = bars([...Array(40).fill(100), 110], DAY0 - 40 * 300 + 0); // last bar starts 09:15 → before 10:30
  const r = engine.getSignal(pre, { silent: true });
  assert.strictEqual(r.cross, "UP"); assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.skipReason, "window");
  const late = bars([...Array(60).fill(100), 110]);                     // bar 60 = 14:15 → after 14:00
  assert.strictEqual(engine.getSignal(late, { silent: true }).signal, "NONE");
  withEnv({ EMA9_CROSS_ENTRY_END: "15:00" }, () => assert.strictEqual(engine.getSignal(late, { silent: true }).signal, "BUY_CE"));
  assert.strictEqual(engine.getSignal(late, { silent: true, skipTimeCheck: true }).signal, "BUY_CE");
});
check("bad data refuses: null / NaN / string close on the signal or previous bar", () => {
  for (const bad of [null, NaN, "", "110", undefined]) {
    const c = flatThen(36, 110); c[c.length - 1].close = bad;
    assert.strictEqual(engine.getSignal(c, { silent: true }).warmup, true, `signal close ${bad}`);
    const d = flatThen(36, 110); d[d.length - 2].close = bad;
    assert.strictEqual(engine.getSignal(d, { silent: true }).warmup, true, `prev close ${bad}`);
  }
});
check("precomputed series (backtest) gives the same answer as the prefix read", () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 4) * 8);
  const all = bars(closes), cfg = engine.getConfig(), series = engine.computeSeries(all, cfg);
  for (let i = 40; i < 120; i++) {
    const a = engine.getSignal(all.slice(0, i + 1), { silent: true, skipTimeCheck: true });
    const b = engine.getSignal(all, { silent: true, skipTimeCheck: true, precomputed: { series, endIdx: i, cfg } });
    assert.deepStrictEqual(b, a, `bar ${i}`);
  }
});

section("Engine — exit");

check("exitSignal: CE exits on a close BELOW EMA9, PE on a close ABOVE; otherwise holds", () => {
  const down = engine.getSignal(flatThen(36, 90), { silent: true });
  const up   = engine.getSignal(flatThen(36, 110), { silent: true });
  assert.ok(/^EMA9 exit — close 90 below EMA9/.test(engine.exitSignal(down, "CE")));
  assert.strictEqual(engine.exitSignal(down, "PE"), null);
  assert.ok(/^EMA9 exit — close 110 above EMA9/.test(engine.exitSignal(up, "PE")));
  assert.strictEqual(engine.exitSignal(up, "CE"), null);
});
check("exitSignal is NOT window-gated (an open trade exits after 14:00 too)", () => {
  const late = engine.getSignal(bars([...Array(60).fill(100), 90]), { silent: true });
  assert.strictEqual(late.signal, "NONE");
  assert.ok(engine.exitSignal(late, "CE"));
});
check("exitSignal holds on warm-up / bad data (never exits on a missing number)", () => {
  assert.strictEqual(engine.exitSignal(engine.getSignal(flatThen(5, 90), { silent: true }), "CE"), null);
  assert.strictEqual(engine.exitSignal(null, "CE"), null);
  assert.strictEqual(engine.exitSignal({ warmup: false, ema9: null, entrySpot: 90, closeVsEma: "BELOW" }, "CE"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
section("Backtest — same engine, paper's exits");

const bt = require("../src/routes/ema9CrossBacktest");
// The run is async (it yields once per session), so the env must stay set until it settles.
async function withEnvAsync(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const run = (candles, env = {}, activeFrom) => withEnvAsync(Object.assign({
  PREMIUM_SL_ENABLED: "false", PROFIT_LOCK_ENABLED: "false", EXIT_REENTRY_COOLDOWN_ENABLED: "false",
  MAX_TRADES_PER_DAY: "0", BACKTEST_SLIPPAGE_PTS: "0",
}, env), () => bt.runEma9CrossBacktest(candles, activeFrom != null ? activeFrom : candles[0].time, null));

// Day 1 = 75 flat bars (warm-up, previous session); day 2 is the test day.
const DAY2 = DAY0 + 86400;
function twoDays(day2closes) {
  return [...bars(Array(75).fill(100)), ...bars(day2closes, DAY2)];
}
// Day-2 bar 15 = 10:30. A cross up at bar 16, cross down at bar 20, cross up at bar 24.
function path1() {
  const c = Array(75).fill(null).map(() => 100);
  for (let i = 16; i < 20; i++) c[i] = 110;      // CE cross at 16, held
  for (let i = 20; i < 24; i++) c[i] = 90;       // close below → exit CE + flip PE at 20
  for (let i = 24; i < 75; i++) c[i] = 115;      // close above → exit PE + flip CE at 24
  return c;
}
let r1;
check("runs: entries at the cross close, EMA9 exit, flips on the opposite cross, session end", async () => {
  const candles = twoDays(path1());
  r1 = await run(candles);
  const t = r1.trades;
  assert.strictEqual(r1.warmupViolations, 0);
  assert.deepStrictEqual(t.map(x => x.side), ["CE", "PE", "CE"]);
  assert.strictEqual(t[0].ePrice, 110); assert.strictEqual(t[0].xPrice, 90);
  assert.ok(/^EMA9 exit/.test(t[0].reason)); assert.ok(/^EMA9 exit/.test(t[1].reason));
  assert.ok(/^Session end/.test(t[2].reason), t[2].reason);
  assert.strictEqual(t[1].ePrice, 90, "the flip enters on the same close it exited");
  assert.strictEqual(t[0].exitTs, t[1].entryTs, "flip: exit and entry at the same moment");
  assert.strictEqual(r1.gateStats.flips, 2);
  assert.strictEqual(r1.gateStats.emaExits, 2);
});
check("the warm-up day never trades (activeFrom = day 2)", async () => {
  const c = twoDays(path1());
  const r = await run(c, {}, DAY2);
  assert.strictEqual(r.warmupViolations, 0);
  assert.ok(r.trades.every(x => x.entryTs >= DAY2));
  assert.strictEqual(r.warmupBars, 75);
});
check("common wait-after-exit ON blocks the flip — the next trade waits for a FRESH cross", async () => {
  const r = await run(twoDays(path1()), { EXIT_REENTRY_COOLDOWN_ENABLED: "true", EXIT_REENTRY_COOLDOWN_CANDLES: "2" });
  assert.deepStrictEqual(r.trades.map(x => x.side), ["CE", "CE"], "both flips blocked; bar 24 is a fresh CE cross");
  assert.strictEqual(r.gateStats.flips, 0);
  assert.ok(r.gateStats.blockedReentry >= 1);
});
check("MAX_TRADES_PER_DAY = 1 stops the flip", async () => {
  const r = await run(twoDays(path1()), { MAX_TRADES_PER_DAY: "1" });
  assert.strictEqual(r.trades.length, 1);
});
check("the common premium stop exits intra-bar and the strategy waits for a fresh cross", async () => {
  // CE at bar 16 (110); bar 17 drops to 100.5 low but closes 109 (still above EMA): the stop
  // fires, and no re-entry happens while price stays above EMA9 without a new cross.
  const c = path1();
  const candles = twoDays(c);
  const b17 = candles[75 + 17];
  b17.low = 60;   // a deep wick through the premium stop
  const r = await run(candles, { EMA9_CROSS_COMMON_STOP_ENABLED: "true", PREMIUM_SL_ENABLED: "true", PREMIUM_SL_PCT: "10", PREMIUM_SL_TRAIL_PCT: "" });
  assert.ok(/^Stop-loss/.test(r.trades[0].reason), r.trades[0].reason);
  assert.strictEqual(r.trades[0].exitTs, b17.time, "stopped inside bar 17");
  assert.strictEqual(r.trades[1].side, "PE", "next trade is the fresh PE cross at bar 20, not a CE re-entry");
  assert.strictEqual(r.trades[1].entryTs, candles[75 + 20].time + 300);
});
check("common stop OFF (default): the same deep wick does NOT exit — only the EMA close does", async () => {
  const candles = twoDays(path1());
  candles[75 + 17].low = 60;
  const r = await run(candles, { PREMIUM_SL_ENABLED: "true", PREMIUM_SL_PCT: "10", PREMIUM_SL_TRAIL_PCT: "" });
  assert.ok(!/^Stop-loss|^Profit lock/.test(r.trades[0].reason), r.trades[0].reason);
  assert.ok(r.trades[0].exitTs > candles[75 + 17].time, "held through bar 17");
});
check("no trade carries a stop level of its own; every PE/CE has a real entry and exit", () => {
  for (const t of r1.trades) {
    assert.ok(Number.isFinite(t.ePrice) && Number.isFinite(t.xPrice));
    assert.ok(!("stopLoss" in t));
    assert.ok(t.exitTs >= t.entryTs);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section("Paper route — wiring");

const paper = fs.readFileSync(path.join(SRC, "routes/ema9CrossPaper.js"), "utf8");
const btSrc = fs.readFileSync(path.join(SRC, "routes/ema9CrossBacktest.js"), "utf8");
const code = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

check("no indicator maths in the routes — EMA only through the engine", () => {
  for (const [n, s] of [["paper", paper], ["backtest", btSrc]]) {
    assert.ok(!/require\(["']technicalindicators["']\)/.test(s), `${n} imports technicalindicators`);
    assert.ok(!/EMA\.calculate|RSI\.calculate|computeSuperTrend/.test(code(s)), `${n} computes an indicator`);
    assert.ok(!/confirmCandle/.test(code(s)), `${n} still has a confirmation candle`);
  }
});
check("paper enters ONLY at candle close: no intra-candle entry, signal from engine.getSignal", () => {
  const onTick = paper.slice(paper.indexOf("function onTick(tick)"), paper.indexOf("function saveSession()"));
  assert.ok(!/simulateBuy\(/.test(onTick), "onTick must not open a position");
  assert.ok(!/engine\.getSignal/.test(onTick), "onTick must not read a signal");
  const occ = paper.slice(paper.indexOf("async function onCandleClose"), paper.indexOf("function onTick(tick)"));
  assert.ok(/engine\.getSignal\(ptState\.candles, ENG\(\)\)/.test(occ));
  assert.ok(/simulateBuy\(/.test(occ));
});
check("paper's candle-close exit is engine.exitSignal, before the entry block (that is the flip)", () => {
  const occ = paper.slice(paper.indexOf("async function onCandleClose"), paper.indexOf("function onTick(tick)"));
  const ex = occ.indexOf("engine.exitSignal(sig, _p.side)");
  const sell = occ.indexOf("simulateSell(candle.close, _exitMsg, candle.close)");
  const entry = occ.indexOf("candle-close entry @");
  assert.ok(ex > 0 && sell > ex && entry > sell);
  assert.ok(/_ownsClose/.test(occ.slice(0, ex)), "acts only on the position open at this close");
});
check("paper's per-tick exits are the common premium stop / profit lock (tradeGuards.checkProfitLock)", () => {
  const onTick = paper.slice(paper.indexOf("function onTick(tick)"), paper.indexOf("function saveSession()"));
  assert.ok(/tradeGuards\.checkProfitLock\(/.test(onTick));
  assert.ok(/_cmnStop && ptState\.position && ptState\.position\.optionEntryLtp/.test(onTick), "premium stop gated by EMA9_CROSS_COMMON_STOP_ENABLED");
  assert.ok(/_cmnStop && ptState\.position && rt\.instrumentName\(\) === "NIFTY_FUTURES"/.test(onTick), "futures stop gated too");
});
check("backtest calls the same engine functions", () => {
  assert.ok(/engine\.getSignal\(sorted, \{ silent: true, precomputed: pre \}\)/.test(btSrc));
  assert.ok(/engine\.exitSignal\(sig, pos\.side\)/.test(btSrc));
});
check("both modes read the same Settings keys with the same defaults", () => {
  const schema = fs.readFileSync(path.join(SRC, "routes/settings.js"), "utf8");
  const def = (k) => (new RegExp(`key: "${k}",[^\\n]*?default: "([^"]*)"`).exec(schema) || [])[1];
  assert.strictEqual(def("EMA9_CROSS_EMA_PERIOD"), "9");
  assert.strictEqual(def("EMA9_CROSS_ENTRY_START"), "10:30");
  assert.strictEqual(def("EMA9_CROSS_ENTRY_END"), "14:00");
  assert.strictEqual(def("EMA9_CROSS_WARMUP_DAYS"), "5");
  assert.ok(/_parseMins\("EMA9_CROSS_ENTRY_START", "10:30"\)/.test(btSrc) && /_parseMins\("EMA9_CROSS_ENTRY_END",\s+"14:00"\)/.test(btSrc));
  assert.ok(/_int\("EMA9_CROSS_WARMUP_DAYS", "5"\)/.test(btSrc));
  assert.ok(/\$\{PREFIX\}_WARMUP_DAYS`\) \|\| "5"/.test(paper));
});
check("the live-key / log-key pairing: tradeLogger and skipLogger know ema9_cross", () => {
  const tl = require("../src/utils/tradeLogger");
  assert.doesNotThrow(() => tl.dailyFilePathFor ? tl.dailyFilePathFor("ema9_cross", "2026-11-18") : null);
  const reg = require("../src/config/strategyRegistry").byId("ema9Cross");
  assert.strictEqual(reg.modeKey, "ema9_cross"); assert.strictEqual(reg.broker, "zerodha");
  assert.strictEqual(tl.FILE_BY_MODE.ema9_cross, "ema9_cross_paper_trades_log.jsonl");
  assert.ok(require("../src/utils/skipLogger").FILE_PREFIX_BY_MODE.ema9_cross);
  assert.ok(/ema9_cross: \{ broker: "zerodha"/.test(fs.readFileSync(path.join(SRC, "utils/capitalPool.js"), "utf8")));
});

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  for (const q of _queue) {
    if (q.section) { console.log(`\n${q.section}`); continue; }
    try { await q.fn(); console.log(`  ✅ ${q.name}`); pass++; }
    catch (e) { console.log(`  ❌ ${q.name}\n       ${e && e.message}`); fail++; }
  }
  console.log(`\nEMA9_CROSS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

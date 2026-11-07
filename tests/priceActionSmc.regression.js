/**
 * PRICE ACTION (Smart Money order-block retest) — rule + wiring regression.
 *
 * Each setup rule is proved by breaking exactly that rule in an otherwise valid
 * hand-written setup. Run: node tests/priceActionSmc.regression.js
 */
process.env.TZ = "Asia/Calcutta";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Load every route FIRST: each one loads the local .env on require, and that would
// otherwise put back the keys these tests clear below.
const { runPABacktest } = require("../src/routes/paBacktest");
const _silence = console.log; console.log = () => {};
const _paPaper = require("../src/routes/paPaper");
console.log = _silence;

const KEYS = ["PA_SMC_SWING_BARS", "PA_SMC_MAX_AGE", "PA_SMC_REACT_WAIT", "PA_SMC_MIN_RR", "PA_SMC_BLOCK_LIQUIDITY",
  "PA_SL_BUFFER_PTS", "PA_MIN_SL_PTS", "PA_MAX_SL_PTS", "PA_PATTERN_BULL_OB", "PA_PATTERN_BEAR_OB"];
KEYS.forEach(k => delete process.env[k]);
process.env.PA_ENTRY_START = "09:20"; process.env.PA_ENTRY_END = "14:30";
process.env.COMMON_TRADE_WINDOW_ENABLED = "false";

const pa = require("../src/strategies/price_action");
const { bullBars, toCandles, mirrorRows } = require("./priceActionSmc.fixture");

let passed = 0, failed = 0;
const pending = [];
function check(name, fn) { pending.push([name, fn]); }

const sig = (rows, opts) => pa.getSignal(toCandles(rows), Object.assign({ silent: true, skipTimeCheck: true }, opts));
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const done = () => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.finally(done);
    done();
    return r;
  } catch (e) { done(); throw e; }
}
const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// ── The valid setup ─────────────────────────────────────────────────────────
check("a valid setup enters CE on the reaction candle with the right stop and target", () => {
  const s = sig(bullBars());
  assert.strictEqual(s.signal, "BUY_CE", s.reason);
  assert.strictEqual(s.stopLoss, 987, "stop = block low 990 - 3 buffer");
  assert.strictEqual(s.target, 1045, "target = highest high before the sweep");
  assert.strictEqual(s.pattern, "Bullish OB");
  assert.strictEqual(s.patternLevel, 1000);
});

check("it fires once: nothing on the bar before, nothing on the bars after", () => {
  const rows = bullBars();
  assert.strictEqual(sig(rows.slice(0, -1)).signal, "NONE", "no entry before the reaction closes");
  // Later up-closes near the entry, so stop and target would still allow a second entry.
  const after = rows.concat([[1004, 1007, 1002, 1006], [1005, 1008, 1003, 1007], [1006, 1009, 1004, 1008]]);
  for (let n = rows.length + 1; n <= after.length; n++) {
    assert.strictEqual(sig(after.slice(0, n)).signal, "NONE", `re-fired ${n - rows.length} bars later`);
  }
});

check("PE is the exact mirror of CE", () => {
  const s = sig(mirrorRows(bullBars()));
  assert.strictEqual(s.signal, "BUY_PE", s.reason);
  assert.strictEqual(s.stopLoss, 2000 - 987);
  assert.strictEqual(s.target, 2000 - 1045);
  assert.strictEqual(s.pattern, "Bearish OB");
});

check("calls hold no state: repeating a call, or a longer history, gives the same answer", () => {
  const rows = bullBars();
  const a = sig(rows), b = sig(rows), c = sig(rows, { preview: true });
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, c);
  // A seeded walk, so swings really do roll out of the tail: only the last 90 candles count.
  let seed = 7, px = 1000;
  const walk = Array.from({ length: 400 }, () => {
    seed = (seed * 16807) % 2147483647;
    const o = px, c = o + ((seed % 41) - 20);
    px = c;
    return [o, Math.max(o, c) + (seed % 7), Math.min(o, c) - (seed % 5), c];
  });
  const cs = toCandles(walk);
  for (let i = 150; i <= cs.length; i++) {
    const full = pa.getSignal(cs.slice(0, i), { silent: true, skipTimeCheck: true });
    const tail = pa.getSignal(cs.slice(i - pa.TAIL_BARS, i), { silent: true, skipTimeCheck: true });
    assert.strictEqual(full.reason, tail.reason, `bar ${i}`);
    assert.strictEqual(full.signal, tail.signal, `bar ${i}`);
  }
});

// ── One rule broken at a time ────────────────────────────────────────────────
check("a wick above the swing is not a break — it must CLOSE above", () => {
  // Same shape as the valid setup, but no candle closes above 1020. If a wick counted
  // as a break, this would still enter on the last bar.
  const rows = bullBars({ a10: [1014, 1024, 1012, 1019], a11: [1019, 1035, 1018, 1019], a12: [1019, 1040, 1018.5, 1019.5],
    a13: [1019.5, 1020, 1016, 1018], a14: [1018, 1045, 1017, 1019], a15: [1019, 1020, 1014, 1016], a16: [1016, 1017, 1010, 1012] });
  assert.strictEqual(sig(rows).signal, "NONE", sig(rows).reason);
});

check("no entry until the inducement is taken", () => {
  const s = sig(bullBars({ a15: [1042, 1043, 1029, 1031], a16: [1031, 1032, 1029.5, 1030], a17: [1030, 1031, 1029.2, 1030.5], a18: [1030.5, 1032, 1029.4, 1031.5] }));
  assert.strictEqual(s.signal, "NONE", s.reason);
  assert.ok(/waiting for inducement/.test(s.reason), s.reason);
});

check("no gap after the block = no block", () => {
  const s = sig(bullBars({ a9: [1004, 1016, 999, 1014] })); // low 999 reaches back under the block's 1000
  assert.strictEqual(s.signal, "NONE", s.reason);
});

check("a block that did not take an earlier low is rejected, unless that rule is off", () => {
  const rows = bullBars({ a1: [996, 997, 985, 995] }); // the earlier low is now under the block
  assert.strictEqual(sig(rows).signal, "NONE");
  withEnv({ PA_SMC_BLOCK_LIQUIDITY: "false" }, () => {
    assert.strictEqual(sig(rows).signal, "BUY_CE", sig(rows).reason);
  });
});

check("no entry if price reaches the target before the retest", () => {
  const s = sig(bullBars({ a16: [1027, 1046, 1020, 1030] }));
  assert.strictEqual(s.signal, "NONE", s.reason);
});

check("no reaction within the wait uses the block up", () => {
  const s = withEnv({ PA_SMC_REACT_WAIT: "0" }, () => sig(bullBars()));
  assert.strictEqual(s.signal, "NONE", s.reason);
  assert.ok(/no reaction/.test(s.reason), s.reason);
});

check("a close through the block ends the setup", () => {
  // a6 ties a7's low so the block is not a swing low, and a7's close already broke the
  // older low, so no opposite break can take over: only this rule can end the setup.
  const rows = bullBars({ a6: [1010, 1012, 990, 998], a7: [998, 1000, 990, 991], a17: [1012, 1013, 985, 988] });
  const s = sig(rows);
  assert.strictEqual(s.signal, "NONE", s.reason);
  assert.ok(/closed through/.test(s.reason), s.reason);
});

check("a stop wider than the max is skipped, not narrowed", () => {
  const s = withEnv({ PA_MAX_SL_PTS: "15" }, () => sig(bullBars()));
  assert.strictEqual(s.signal, "NONE", s.reason);
  assert.ok(/wider than 15/.test(s.reason), s.reason);
});

check("reward:risk under the minimum is skipped", () => {
  const s = withEnv({ PA_SMC_MIN_RR: "2.5" }, () => sig(bullBars()));
  assert.strictEqual(s.signal, "NONE", s.reason);
  assert.ok(/reward:risk/.test(s.reason), s.reason);
});

check("a tight block still gets the minimum stop", () => {
  const s = withEnv({ PA_MIN_SL_PTS: "24" }, () => sig(bullBars()));
  assert.strictEqual(s.stopLoss, 1007 - 24);
});

check("each direction has its own Settings toggle", () => {
  withEnv({ PA_PATTERN_BULL_OB: "false" }, () => assert.strictEqual(sig(bullBars()).signal, "NONE"));
  withEnv({ PA_PATTERN_BEAR_OB: "false" }, () => {
    assert.strictEqual(sig(bullBars()).signal, "BUY_CE");
    assert.strictEqual(sig(mirrorRows(bullBars())).signal, "NONE");
  });
});

check("a swing older than the tail is forgotten", () => {
  const rows = [...Array.from({ length: 10 }, () => [1000, 1001, 999, 1000]),
    [1000, 1005, 999, 1001], [1001, 1010, 1000, 1002], [1002, 1005, 999, 1000], // swing high 1010
    ...Array.from({ length: 95 }, () => [1000, 1001, 999, 1000]),
    [1000, 1015, 999, 1012]];                                                   // closes above it
  const s = sig(rows);
  assert.strictEqual(s.reason, "No setup", s.reason);
});

check("the inducement can be the pullback low on the candle just before the break", () => {
  const rows = bullBars({ a8: [992, 1010, 1005, 1008], a9: [1008, 1016, 1003, 1014] }).slice(0, -8);
  assert.ok(/waiting for inducement 1003/.test(sig(rows).reason), sig(rows).reason);
});

check("the inducement shifts up to each newer pullback low", () => {
  const rows = bullBars().slice(0, -4); // ends on a14, after the a13 pullback
  assert.ok(/waiting for inducement 1028/.test(sig(rows).reason), sig(rows).reason);
});

check("a wick through the inducement is enough to sweep it", () => {
  const s = sig(bullBars({ a15: [1042, 1043, 1025, 1030] }));
  assert.strictEqual(s.signal, "BUY_CE", s.reason);
});

check("the target ignores the sweep candle's own high", () => {
  const s = sig(bullBars({ a15: [1042, 1050, 1025, 1027] }));
  assert.strictEqual(s.target, 1045, s.reason);
});

check("inside candles are skipped when looking for the gap", () => {
  const rows = bullBars();
  rows.splice(rows.length - 11, 0, [992, 999, 991, 995]); // inside the block candle, right after it
  const s = sig(rows);
  assert.strictEqual(s.signal, "BUY_CE", s.reason);
  assert.strictEqual(s.stopLoss, 987);
});

check("a block already touched before the sweep is rejected", () => {
  const s = sig(bullBars({ a11: [1022, 1035, 999, 1032] }));
  assert.strictEqual(s.signal, "NONE", s.reason);
  assert.ok(/no valid order block/.test(s.reason), s.reason);
});

check("a setup expires after its life", () => {
  const rows = bullBars();
  rows.splice(rows.length - 2, 0, ...Array.from({ length: 6 }, () => [1012, 1014, 1008, 1012]));
  assert.strictEqual(sig(rows).signal, "BUY_CE", sig(rows).reason);
  withEnv({ PA_SMC_MAX_AGE: "10" }, () => {
    assert.strictEqual(sig(rows).signal, "NONE");
    assert.ok(/expired/.test(sig(rows).reason), sig(rows).reason);
  });
});

check("a minimum stop above the maximum means skip, not a wide stop", () => {
  const s = withEnv({ PA_MIN_SL_PTS: "30", PA_MAX_SL_PTS: "25" }, () => sig(bullBars()));
  assert.strictEqual(s.signal, "NONE", s.reason);
  assert.ok(/wider than 25/.test(s.reason), s.reason);
});

check("a bad number in .env falls back to the default instead of a trade with no stop", () => {
  const good = sig(bullBars());
  for (const k of ["PA_MIN_SL_PTS", "PA_MAX_SL_PTS", "PA_SL_BUFFER_PTS", "PA_SMC_MIN_RR", "PA_SMC_SWING_BARS", "PA_SMC_MAX_AGE", "PA_SMC_REACT_WAIT"]) {
    withEnv({ [k]: "abc" }, () => assert.deepStrictEqual(sig(bullBars()), good, `${k}=abc changed the answer`));
  }
});

check("a setup life too long for the kept history cannot leave it warming up forever", () => {
  withEnv({ PA_SMC_MAX_AGE: "500" }, () => {
    const c = Array.from({ length: pa.TAIL_BARS }, () => [1000, 1001, 999, 1000]);
    assert.ok(!/Warming up/.test(sig(c).reason), sig(c).reason);
  });
});

check("the trading window is honoured", () => {
  // The reaction candle lands after 09:15 + 78 bars of 5 min = next day; check via a late bar.
  const rows = bullBars();
  const candles = toCandles(rows, 300, 75 - rows.length); // last bar is 15:25 IST
  const s = pa.getSignal(candles, { silent: true });
  assert.strictEqual(s.signal, "NONE");
  assert.ok(/^After /.test(s.reason), s.reason);
});

check("warms up instead of guessing on short history", () => {
  const s = sig(bullBars().slice(-30));
  assert.strictEqual(s.signal, "NONE");
  assert.ok(/Warming up/.test(s.reason), s.reason);
});

// ── Backtest: the real engine, end to end ───────────────────────────────────
async function backtestAfter(extraRows, env) {
  return withEnv(Object.assign({
    PROFIT_LOCK_ENABLED: "false",
    PA_SLIPPAGE_PTS: "0", EXIT_REENTRY_COOLDOWN_ENABLED: "false", PA_VIX_ENABLED: "false",
    BACKTEST_OPTION_SIM: "false", INSTRUMENT: "NIFTY_OPTIONS",
  }, env || {}), async () => {
    const log = console.log; console.log = () => {};
    try {
      return await runPABacktest(toCandles(bullBars().concat(extraRows), 300, 0), 500000, [], null, null);
    } finally { console.log = log; }
  });
}

// The lock in spot points: arm 4% of a 200 premium at delta 0.55 ≈ 14.5 pts, floor 2% ≈ 7.27 pts.
const LOCK_ENV = { PROFIT_LOCK_ENABLED: "true", PROFIT_LOCK_ARM_PCT: "4", PROFIT_LOCK_FLOOR_PCT: "2", BACKTEST_DELTA: "0.55", PROFIT_LOCK_TRAIL_PCT: "0", PROFIT_LOCK_TRAIL_TIERS: "" };

check("backtest: fills at the NEXT open and, with no lock armed, closes at the day's last bar", async () => {
  // bullBars ends on bar 98 of day 1 (bars 75-149). Entry on bar 99, then flat to the
  // day's last bar 149, then one bar of the next day.
  const flat = Array.from({ length: 50 }, () => [1018, 1019, 1017, 1018]);
  const { trades } = await backtestAfter([[1008, 1020, 1006, 1018], ...flat, [1030, 1031, 1029, 1030]]);
  assert.strictEqual(trades.length, 1, JSON.stringify(trades));
  assert.strictEqual(trades[0].side, "CE");
  assert.strictEqual(trades[0].entryPrice, 1008, "entry = next candle's open, not the signal close");
  assert.strictEqual(trades[0].exitReason, "Session end");
  assert.strictEqual(trades[0].exitPrice, 1018, "closed at the day's last close, not the next day's");
});

check("backtest: no stop — a candle far below entry does not close the trade", async () => {
  const { trades } = await backtestAfter([[1008, 1010, 960, 965], [965, 1000, 960, 990]]);
  assert.strictEqual(trades.length, 1, JSON.stringify(trades));
  assert.strictEqual(trades[0].exitReason, "Session end");
  assert.strictEqual(trades[0].exitPrice, 990);
});

check("backtest: an armed lock fills at its floor, not at the candle's low", async () => {
  const { trades } = await backtestAfter([[1008, 1038, 1010, 1030], [1030, 1032, 980, 985]], LOCK_ENV);
  assert.ok(/Profit lock/.test(trades[0].exitReason), trades[0].exitReason);
  assert.strictEqual(trades[0].exitPrice, 1015.27);
});

check("backtest: slippage works against the entry and the lock fill", async () => {
  const { trades } = await backtestAfter([[1008, 1038, 1010, 1030], [1030, 1032, 980, 985]], Object.assign({ PA_SLIPPAGE_PTS: "2" }, LOCK_ENV));
  assert.strictEqual(trades[0].entryPrice, 1010);
  assert.strictEqual(trades[0].exitPrice, 1015.27, "floor 1017.27 less 2 pts");
});

check("backtest: a candle gapping through the lock floor fills at the open", async () => {
  const { trades } = await backtestAfter([[1008, 1030, 1006, 1028], [1000, 1002, 995, 998]], LOCK_ENV);
  assert.ok(/Profit lock/.test(trades[0].exitReason), trades[0].exitReason);
  assert.strictEqual(trades[0].exitPrice, 1000);
});

check("backtest: the common profit lock arms on an earlier candle, never the same one", async () => {
  // Arm 4% of a 200 premium at delta 0.55 ≈ 14.5 pts. The first bar peaks at +30 and
  // dips in the same bar: no exit (order inside a bar is unknown). The next bar exits.
  const { trades } = await backtestAfter([[1008, 1038, 1010, 1030], [1030, 1032, 1012, 1014]], LOCK_ENV);
  assert.strictEqual(trades.length, 1, JSON.stringify(trades));
  assert.ok(/Profit lock/.test(trades[0].exitReason), trades[0].exitReason);
  assert.ok(trades[0].exitTs > trades[0].entryTs, "must not exit on the entry candle");
});

// ── Wiring ───────────────────────────────────────────────────────────────────
check("paper exits only through the common lock", () => {
  for (const f of ["src/routes/paPaper.js"]) {
    const src = read(f);
    assert.ok(/tradeGuards\.checkProfitLock/.test(src), `${f} has no profit lock`);
    for (const gone of [/"Target hit"/, /checkBreakevenStop/, /checkTimeStop/, /pos\.stopLoss/, /updateTrailingSL/, /EOD square-off/, /HardSL/, /_dailyLossHit/, /_slPauseUntil/]) {
      assert.ok(!gone.test(src), `${f} still has ${gone}`);
    }
    assert.ok(/!isFut && pos\.optionEntryLtp && state\.optionLtp\) \{\s*const _plMsg/.test(src), `${f}: the premium lock must not run on a futures leg`);
  }
});

check("the backtest applies the common lock only to options, like paper, and nothing else exits", () => {
  const file = read("src/routes/paBacktest.js");
  // The engine only: the results page still labels exit reasons of saved older runs.
  const src = file.slice(file.indexOf("async function runPABacktest"), file.indexOf("function errorPage"));
  assert.ok(/_PL_VALID\s*=\s*!isFutures/.test(src));
  for (const gone of [/_BE_VALID/, /"Target hit"/, /SL hit/, /updateTrailingSL/, /EOD square-off/, /PA_MAX_DAILY/]) {
    assert.ok(!gone.test(src), `paBacktest.js still has ${gone}`);
  }
});

check("every setting is on the Settings page, and its default matches the engine", () => {
  const src = read("src/routes/settings.js");
  const engine = read("src/strategies/price_action.js");
  for (const k of KEYS) {
    const m = new RegExp(`key: "${k}".*?default: "([^"]*)"`).exec(src);
    assert.ok(m, `${k} is missing from Settings`);
    const code = new RegExp(`(?:cfg|num|int)\\("${k}", "([^"]*)"`).exec(engine);
    assert.ok(code, `${k} is not read by the engine`);
    assert.strictEqual(m[1], code[1], `${k}: Settings default ${m[1]} ≠ code default ${code[1]}`);
  }
  assert.ok(!/PA_PATTERN_DOUBLE|PA_PATTERN_ASC|PA_TREND_|PA_RETEST_/.test(src + engine), "old PA keys are still referenced");
  // Manual entries place no stop, so the routes read no stop limits of their own.
  for (const f of ["src/routes/paPaper.js"]) {
    assert.ok(!/stopLimits|PA_M(AX|IN)_SL_PTS/.test(read(f)), f);
  }
});

check("the Settings section title is the same everywhere, or daily logs lose their PA settings", () => {
  const src = read("src/routes/settings.js");
  const title = /section: "(PRICE ACTION STRATEGY[^"]*)"/.exec(src)[1];
  const uses = src.match(/"PRICE ACTION STRATEGY[^"]*"/g);
  assert.ok(uses.length >= 3, "expected the section plus its two lookups");
  for (const u of uses) assert.strictEqual(u, JSON.stringify(title));
});

check("every simulate path and every ready label follows the real warm-up", () => {
  const paper = read("src/routes/paPaper.js");
  assert.ok(!/warmupCandles: 30\b|slice\(-30\)/.test(paper), "a simulate path still warms up on 30 candles");
  assert.ok(!/candleCount >= (15|30)|state\.candles\.length >= (15|30) \?/.test(paper), "a ready label still uses the old count");
});

check("Start All includes Price Action, and drops it when switched off", () => {
  const log = console.log, warn = console.warn; console.log = console.warn = () => {};
  try {
    const express = require("express");
    const { trackMounts, startAllRoster } = require("../src/utils/startAllRoster");
    const app = express(); trackMounts(app);
    app.use("/pa-paper", _paPaper);
    process.env.PA_MODE_ENABLED = "true";
    const row = startAllRoster().find(m => m.mode === "PA");
    assert.ok(row, "PA is missing from the roster");
    assert.strictEqual(row.paper, "/pa-paper/start");
    process.env.PA_MODE_ENABLED = "false";
    assert.ok(!startAllRoster().find(m => m.mode === "PA"), "PA must leave the roster when off");
  } finally { process.env.PA_MODE_ENABLED = "true"; console.log = log; console.warn = warn; }
});

(async () => {
  for (const [name, fn] of pending) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
  }
  console.log(`\nPRICE_ACTION_SMC: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

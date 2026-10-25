#!/usr/bin/env node
/**
 * GLOBAL WAIT-AFTER-ANY-EXIT COOLDOWN — RULE INVARIANTS
 *
 *   node tests/reentryCooldown.regression.js
 *
 * The rule, in the operator's own words: "make this a common rule in all the
 * strategies, all the exits — once exited, don't re-enter immediately."
 * (23 Oct 2026: EMA_RSI_ST breakeven exit 10:48, same PE re-entered 10:50.)
 *
 * Defends the RULE (tradeGuards helper: default 2 candles, 0 = off) and the
 * REACH: every paper engine, native live engine and backtest reads it, so a new
 * strategy fails this suite until it is wired.
 */

process.env.TZ = process.env.TZ || "Asia/Calcutta";

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const SRC  = path.join(__dirname, "../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");
/** Prose that merely mentions code is not code. */
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

delete process.env.EXIT_REENTRY_COOLDOWN_CANDLES;
const guards = require("../src/utils/tradeGuards");

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}
function withEnv(v, fn) {
  const prev = process.env.EXIT_REENTRY_COOLDOWN_CANDLES;
  if (v === undefined) delete process.env.EXIT_REENTRY_COOLDOWN_CANDLES;
  else process.env.EXIT_REENTRY_COOLDOWN_CANDLES = v;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.EXIT_REENTRY_COOLDOWN_CANDLES;
    else process.env.EXIT_REENTRY_COOLDOWN_CANDLES = prev;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section("Rule — the helper");

check("ships ON at 2 candles", () => withEnv(undefined, () => {
  assert.strictEqual(guards.EXIT_REENTRY_COOLDOWN_CANDLES, 2);
  assert.strictEqual(guards.reentryCooldownMs(5), 10 * 60 * 1000);
}));

check("23 Oct case: exit 10:48:49 on 5-min → blocked until 10:58:49", () => withEnv("2", () => {
  const exit = Date.parse("2026-10-23T10:48:49+05:30");
  assert.strictEqual(guards.reentryCooldownUntil(exit, 5), Date.parse("2026-10-23T10:58:49+05:30"));
}));

check("0, negative and garbage mean off (no block)", () => {
  for (const v of ["0", "-3", "abc", ""]) withEnv(v, () => {
    assert.strictEqual(guards.reentryCooldownMs(5), 0, `"${v}" should be off`);
    assert.strictEqual(guards.reentryCooldownUntil(Date.now(), 5), 0, `"${v}" should be off`);
  });
});

check("bad resolution never blocks", () => withEnv("2", () => {
  for (const r of [0, -5, NaN, undefined, "x"]) assert.strictEqual(guards.reentryCooldownMs(r), 0);
}));

check("read live from env — a Settings save applies without a restart", () => {
  withEnv("3", () => assert.strictEqual(guards.reentryCooldownMs(15), 45 * 60 * 1000));
  withEnv("1", () => assert.strictEqual(guards.reentryCooldownMs(15), 15 * 60 * 1000));
});

// ═══════════════════════════════════════════════════════════════════════════
section("Config — Settings, recorder, replay");

check("Settings exposes the key", () => {
  assert.ok(read("routes/settings.js").includes(`key: "EXIT_REENTRY_COOLDOWN_CANDLES"`));
});

check("recordings always carry the effective value", () => {
  const src = decomment(read("utils/tickRecorder.js"));
  assert.ok(/\^EXIT_REENTRY_/.test(src), "tick recorder does not capture EXIT_REENTRY_*");
  assert.ok(/EXIT_REENTRY_COOLDOWN_CANDLES = "2"/.test(src), "snapshot does not default the key when unset");
});

check("snapshot replay of a pre-feature recording runs with the cooldown OFF", () => {
  const src = decomment(read("services/tickReplay.js"));
  assert.ok(/EXIT_REENTRY_COOLDOWN_CANDLES = "0"/.test(src),
    "old recordings would replay with a wait the live session never had");
});

// ═══════════════════════════════════════════════════════════════════════════
section("Reach — every engine honours it");

const uses = (rel) => /reentryCooldown(Ms|Until)/.test(decomment(read(rel)));

check("every paper engine", () => {
  const dir = path.join(SRC, "routes");
  const missing = [];
  for (const f of fs.readdirSync(dir).filter(x => /Paper\.js$/.test(x))) {
    const src = decomment(read(`routes/${f}`));
    // The COMMODITY (MCX) pages are thin wrappers; services/commodityPaper.js owns entries.
    if (/utils\/commodityPaperRouter/.test(src)) continue;
    // GAP_RUNAWAY + its scanner: no common rule applies (the user's rule), and it
    // takes one trade a day per instrument with no re-entry — asserted below.
    if (f === "gapRunawayPaper.js" || f === "gapRunawayStkPaper.js") continue;
    if (!uses(`routes/${f}`)) missing.push(f);
  }
  assert.deepStrictEqual(missing, [], `paper engines without the cooldown: ${missing.join(", ")}`);
});

check("GAP_RUNAWAY never applies the wait-after-exit cooldown (no common rules, no re-entry)", () => {
  for (const f of ["routes/gapRunawayPaper.js", "routes/gapRunawayStkPaper.js"]) {
    assert.ok(!uses(f), `${f} must not apply the common cooldown`);
  }
});

check("the commodity paper engine", () => {
  assert.ok(uses("services/commodityPaper.js"), "services/commodityPaper.js does not apply the cooldown");
});

check("every native live engine (harness ones inherit it from paper)", () => {
  const missing = ["emaRsiStLive.js", "bbRsiLive.js", "paLive.js", "orbLive.js"]
    .filter(f => !uses(`routes/${f}`));
  assert.deepStrictEqual(missing, [], `native live engines without the cooldown: ${missing.join(", ")}`);
});

check("every strategy backtest", () => {
  const dir = path.join(SRC, "routes");
  // allBacktest is the dashboard; paPatternBacktest is per-pattern attribution.
  const skip = new Set(["allBacktest.js", "paPatternBacktest.js"]);
  const missing = [];
  for (const f of fs.readdirSync(dir).filter(x => /Backtest\.js$/.test(x) && !skip.has(x))) {
    const src = decomment(read(`routes/${f}`));
    if (uses(`routes/${f}`)) continue;
    // A route may delegate its bar loop to a shared engine in services/.
    const eng = [...src.matchAll(/require\("\.\.\/services\/([A-Za-z0-9]+)"\)/g)].map(m => `services/${m[1]}.js`)
      .filter(p => fs.existsSync(path.join(SRC, p)) && /Backtest|backtestEngine/i.test(p));
    if (eng.some(uses) && /runBacktest|run[A-Z][A-Za-z0-9]*Backtest/.test(src)) continue;
    missing.push(f);
  }
  assert.deepStrictEqual(missing, [], `backtests without the cooldown: ${missing.join(", ")}`);
});

console.log(`\n${fail ? "FAILURES" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * GLOBAL PROFIT LOCK — RULE INVARIANTS
 *
 *   node tests/profitLock.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Nothing here
 * opens a socket, a broker connection or a session.
 *
 * The rule, in the operator's own words: "arm +8% / lock +5% — common, not at
 * strategy level, and it has to be honoured by any active strategy even if I
 * add a new one in future."
 *
 * So the assertions below defend two different things:
 *
 *   1. The RULE — a one-way ratchet on option premium. Once premium has touched
 *      entry × (1 + arm%), the position may never again be sold below
 *      entry × (1 + floor%). It never widens a stop, never fires before the arm
 *      threshold, and never caps a runner that keeps climbing.
 *
 *   2. The REACH — that every engine which can hold an option position actually
 *      calls it. This is the half that rots: a new strategy added next month
 *      inherits the rule only if its per-tick exit path calls checkProfitLock,
 *      so the last group fails the build when an engine is missing it. That is
 *      deliberate — a new engine should have to either wire the lock or state
 *      in ENGINES_WITHOUT_OPTION_POSITIONS why it has no premium to lock.
 *
 * WHY THESE NUMBERS — measured over 346 recorded paper trades (Jul–Sep 2026):
 * losing trades peaked a median 3 minutes after entry at +6 spot pts, winners a
 * median 25 minutes in at +39.5 pts. Replaying the 321 active-strategy trades at
 * arm 8 / floor 5 changed 70 exits and moved the book from -Rs6,028 to
 * +Rs32,110. A grid search preferred arm 12 / floor 10, which is the in-sample
 * optimum and almost certainly overfit — 8/5 is the deliberately un-tuned pick.
 */

process.env.TZ = process.env.TZ || "Asia/Calcutta";

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const SRC  = path.join(__dirname, "../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");
/** Prose that merely mentions code is not code. */
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// Deterministic env, applied BEFORE the require. The developer's real .env must
// not decide whether this suite passes.
for (const k of Object.keys(process.env)) if (k.startsWith("PROFIT_LOCK_")) delete process.env[k];

const guards = require("../src/utils/tradeGuards");

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}
/** Wipe every PROFIT_LOCK_ key so one case cannot leak into the next. */
function freshEnv(over) {
  for (const k of Object.keys(process.env)) if (k.startsWith("PROFIT_LOCK_")) delete process.env[k];
  Object.assign(process.env, over || {});
}

// ═══════════════════════════════════════════════════════════════════════════
section("Defaults — the shipped numbers ARE the rule");

check("ships armed at +8% with a +5% floor, enabled", () => {
  freshEnv();
  assert.strictEqual(guards.PROFIT_LOCK_ARM_PCT, 8);
  assert.strictEqual(guards.PROFIT_LOCK_FLOOR_PCT, 5);
  assert.strictEqual(guards.PROFIT_LOCK_ENABLED, true);
});

check("defaults are ON — a strategy inherits the lock without opting in", () => {
  freshEnv();
  // Entry 100, peaked 108 (+8% → armed), now back at 105 (the floor).
  assert.ok(guards.checkProfitLock(100, 105, 108), "the shipped default did not fire");
});

// ═══════════════════════════════════════════════════════════════════════════
section("The ratchet — arms once, never loosens, never caps a runner");

check("does not fire before the arm threshold is reached", () => {
  freshEnv();
  // Peaked +5%, never touched +8%: the lock was never armed, so a fall to entry
  // is the strategy's own business.
  assert.strictEqual(guards.checkProfitLock(100, 100, 105), null);
  assert.strictEqual(guards.checkProfitLock(100, 90,  105), null);
});

check("fires once armed and premium falls back TO the floor", () => {
  freshEnv();
  const msg = guards.checkProfitLock(100, 105, 108);
  assert.ok(msg, "armed lock did not fire at the floor");
  assert.ok(/105/.test(msg), `message should name the floor: ${msg}`);
});

check("fires once armed and premium falls THROUGH the floor (gap down)", () => {
  freshEnv();
  // A tick can jump straight past the floor — the lock must still fire, not
  // wait for an exact touch it may never see.
  assert.ok(guards.checkProfitLock(100, 101, 108));
  assert.ok(guards.checkProfitLock(100,  60, 108));
});

check("stays silent while premium is still above the floor", () => {
  freshEnv();
  assert.strictEqual(guards.checkProfitLock(100, 106, 108), null);
});

check("never caps a runner — a trade still climbing is left alone", () => {
  freshEnv();
  // This is what preserves the few large winners that carry the book. The lock
  // is a floor, not a take-profit.
  assert.strictEqual(guards.checkProfitLock(100, 140, 140), null);
  assert.strictEqual(guards.checkProfitLock(100, 300, 300), null);
});

check("the floor is fixed at entry+floor%, it does not trail the peak", () => {
  freshEnv();
  // Peak 200 (+100%) but price back to 106: still above the +5% floor, so the
  // global lock holds its tongue and the strategy's own trail owns the exit.
  assert.strictEqual(guards.checkProfitLock(100, 106, 200), null);
  assert.ok(guards.checkProfitLock(100, 104, 200));
});

// ═══════════════════════════════════════════════════════════════════════════
section("Configuration — live reads, and misconfiguration is inert");

check("a Settings change applies on the next tick, with no restart", () => {
  freshEnv({ PROFIT_LOCK_ARM_PCT: "20", PROFIT_LOCK_FLOOR_PCT: "15" });
  assert.strictEqual(guards.checkProfitLock(100, 105, 108), null, "should not arm at +8% when arm is 20%");
  assert.ok(guards.checkProfitLock(100, 115, 125), "should arm at +25% and fire at the +15% floor");
  freshEnv();
  assert.ok(guards.checkProfitLock(100, 105, 108), "reverting the env should restore the default rule");
});

check("disabled means inert", () => {
  freshEnv({ PROFIT_LOCK_ENABLED: "false" });
  assert.strictEqual(guards.checkProfitLock(100, 105, 108), null);
});

check("floor >= arm is refused rather than inverting the ratchet", () => {
  // A floor at or above the arm could otherwise exit above the price that armed
  // it — a stop that fires on the way UP. Refuse instead.
  freshEnv({ PROFIT_LOCK_ARM_PCT: "8", PROFIT_LOCK_FLOOR_PCT: "8" });
  assert.strictEqual(guards.checkProfitLock(100, 105, 108), null);
  freshEnv({ PROFIT_LOCK_ARM_PCT: "8", PROFIT_LOCK_FLOOR_PCT: "20" });
  assert.strictEqual(guards.checkProfitLock(100, 105, 108), null);
});

check("a non-numeric or negative setting is inert, never a 0% floor", () => {
  // The dangerous failure is a garbage value silently becoming "sell at entry".
  freshEnv({ PROFIT_LOCK_ARM_PCT: "abc" });
  assert.strictEqual(guards.checkProfitLock(100, 105, 108), null);
  freshEnv({ PROFIT_LOCK_ARM_PCT: "-5" });
  assert.strictEqual(guards.checkProfitLock(100, 105, 108), null);
  freshEnv({ PROFIT_LOCK_FLOOR_PCT: "-1" });
  assert.strictEqual(guards.checkProfitLock(100, 105, 108), null);
});

// ═══════════════════════════════════════════════════════════════════════════
section("Bad inputs cannot become a price");

check("null / NaN / zero / missing premiums are refused", () => {
  freshEnv();
  for (const bad of [null, undefined, NaN, 0, -1, "x"]) {
    assert.strictEqual(guards.checkProfitLock(bad, 105, 108), null, `entry=${bad}`);
    assert.strictEqual(guards.checkProfitLock(100, bad, 108), null, `current=${bad}`);
    assert.strictEqual(guards.checkProfitLock(100, 105, bad), null, `peak=${bad}`);
  }
});

check("a peak below entry cannot arm the lock", () => {
  freshEnv();
  // An underwater trade has no profit to lock; this is the case where firing
  // would turn the guard into an unintended stop-loss.
  assert.strictEqual(guards.checkProfitLock(100, 90, 95), null);
});

// ═══════════════════════════════════════════════════════════════════════════
section("Reach — every engine that can hold an option honours the lock");

// Engines with no option premium of their own to lock. Anything listed here is
// claiming "I cannot hold an option position"; if that stops being true, the
// entry must be removed and the engine wired instead.
const ENGINES_WITHOUT_OPTION_POSITIONS = new Set([
  "paPaper.js", "paLive.js",                 // PA is disabled (PA_MODE_ENABLED=false)
  "trendPbPaper.js", "trendDayScalpPaper.js", // harness-run, disabled
  "earlyBirdPaper.js",                        // stock mode, not options
  "bbRsiLive.js", "emaRsiStLive.js", "orbLive.js", // live engines — see note below
]);

check("every enabled paper engine calls checkProfitLock", () => {
  const dir = path.join(SRC, "routes");
  const engines = fs.readdirSync(dir).filter(f => /Paper\.js$/.test(f));
  const missing = [];
  for (const f of engines) {
    if (ENGINES_WITHOUT_OPTION_POSITIONS.has(f)) continue;
    const src = decomment(read(`routes/${f}`));
    // ORB delegates its tick exits to the shared orbExits module.
    if (/orbExits\.evaluateTickExits/.test(src)) continue;
    if (!/checkProfitLock/.test(src)) missing.push(f);
  }
  assert.deepStrictEqual(missing, [],
    `paper engines that can hold an option but never call checkProfitLock: ${missing.join(", ")}`);
});

check("ORB honours it through the shared orbExits module", () => {
  const src = decomment(read("strategies/orbExits.js"));
  assert.ok(/checkProfitLock/.test(src), "orbExits.evaluateTickExits does not call the lock");
  // ORB can run in futures mode, where optionLtp mirrors the SPOT — locking on
  // that would test an 8% move in NIFTY itself.
  assert.ok(/isFutures/.test(src), "orbExits must not apply the premium lock to a futures leg");
});

check("futures legs are excluded wherever an engine can trade them", () => {
  // Same trap as above: in futures mode these engines mirror spot into optionLtp.
  for (const f of ["bnEmaRsiStV2Paper.js", "haScalpPaper.js", "rsiPivotStPaper.js", "bnPivotRsiStPaper.js"]) {
    const src = decomment(read(`routes/${f}`));
    const i = src.indexOf("checkProfitLock");
    assert.ok(i > 0, `${f} does not call checkProfitLock`);
    const window = src.slice(Math.max(0, i - 400), i);
    assert.ok(/isFutures/.test(window), `${f} applies the premium lock without excluding a futures leg`);
  }
});

check("the lock is checked BEFORE the engine's own stop, not after", () => {
  // Once armed the locked floor sits ABOVE entry, so a stop below entry must not
  // get first refusal — otherwise the lock can only ever fire on trades that
  // were already going to exit anyway.
  for (const [f, stopMarker] of [
    ["emaRsiStPaper.js",   "Option-premium stop"],
    ["ema9vwapPaper.js",   "Option-premium stop"],
    ["emaRsiStV2Paper.js", "SuperTrend trailing SL hit"],
  ]) {
    const src = read(`routes/${f}`);
    const lock = src.indexOf("checkProfitLock");
    const stop = src.indexOf(stopMarker, Math.max(0, lock - 2000));
    assert.ok(lock > 0 && stop > 0, `${f}: could not locate both the lock and "${stopMarker}"`);
    assert.ok(lock < stop, `${f}: the profit lock runs AFTER "${stopMarker}" — it must run before it`);
  }
});

check("the native LIVE engines honour it too", () => {
  // Most live trading runs through the harness, which literally runs the paper
  // engine — so it inherits the lock for free. These four have their own tick
  // loops and do not, which is exactly why they can silently drift from paper.
  for (const f of ["emaRsiStLive.js", "bbRsiLive.js", "paLive.js"]) {
    const src = decomment(read(`routes/${f}`));
    assert.ok(/checkProfitLock/.test(src), `${f} never calls checkProfitLock — live would drift from paper`);
  }
  // ORB live goes through the shared orbExits module.
  assert.ok(/checkProfitLock/.test(decomment(read("strategies/orbExits.js"))));
});

check("the live harness inherits the lock by running paper", () => {
  // If a harness ever stops wrapping its paper route, it stops inheriting every
  // paper rule — the lock included — without any test here failing otherwise.
  const dir = path.join(SRC, "routes");
  const missing = [];
  for (const f of fs.readdirSync(dir).filter(x => /LiveHarness\.js$/.test(x))) {
    if (!/require\("\.\/[a-zA-Z0-9]*Paper"\)/.test(read(`routes/${f}`))) missing.push(f);
  }
  assert.deepStrictEqual(missing, [],
    `harness routes that no longer wrap their paper engine: ${missing.join(", ")}`);
});

check("BACKTEST applies the lock, in spot-equivalent terms", () => {
  // The backtest engines have no option chain, so they convert the premium
  // thresholds to spot points the same way they already convert the option stop.
  // Without this the backtest reports exits paper would never take, which breaks
  // the repo's rule that backtest must match paper.
  for (const f of ["backtestEngine.js", "ema9vwapBacktestEngine.js"]) {
    const src = decomment(read(`services/${f}`));
    assert.ok(/PROFIT_LOCK_ARM_PCT/.test(src),  `${f} does not read the profit-lock arm %`);
    assert.ok(/PROFIT_LOCK_FLOOR_PCT/.test(src), `${f} does not read the profit-lock floor %`);
    assert.ok(/DELTA/.test(src), `${f} must convert the premium thresholds via DELTA`);
  }
});

check("a backtest cannot arm the lock without tracking the peak", () => {
  // The lock must arm on the running favourable extreme, not just the current
  // bar — otherwise a trade that peaked on an earlier candle never arms.
  for (const f of ["backtestEngine.js", "ema9vwapBacktestEngine.js"]) {
    const src = decomment(read(`services/${f}`));
    assert.ok(/bestPrice/.test(src), `${f} has no favourable-extreme tracking for the lock to arm on`);
    const upd = src.search(/bestPrice\s*=\s*candle\.(high|low)/);
    assert.ok(upd > 0, `${f} never updates bestPrice from the bar`);
    // Compare against where the arm threshold is USED (the >= comparison), not
    // where the constant is declared — the declaration sits at the top of the
    // run, long before any bar is seen, so matching it would always "fail".
    const use = src.search(/>=\s*(_PL_ARM_SPOT_PTS|_plArmSpotPts)/);
    assert.ok(use > 0, `${f} never compares against the arm distance`);
    assert.ok(upd < use, `${f} reads the peak before updating it`);
  }
});

check("Settings exposes every PROFIT_LOCK_ key the code reads", () => {
  const settings = read("routes/settings.js");
  const sources  = ["utils/tradeGuards.js", "strategies/orbExits.js"].map(read).join("\n");
  const keys = new Set(sources.match(/PROFIT_LOCK_[A-Z0-9_]+/g) || []);
  assert.ok(keys.size >= 3, `expected the three PROFIT_LOCK_ keys, found ${[...keys].join(", ")}`);
  const missing = [...keys].filter(k => !settings.includes(`"${k}"`));
  assert.deepStrictEqual(missing, [], `keys read by the code but absent from Settings: ${missing.join(", ")}`);
});

check("the lock is defined once, globally — no per-strategy copies", () => {
  // The operator asked for this explicitly: common, not at strategy level. A
  // {STRATEGY}_PROFIT_LOCK_* key would let one engine drift from the rule.
  const dir = path.join(SRC, "routes");
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".js"))) {
    const m = decomment(read(`routes/${f}`)).match(/[A-Z0-9]+_PROFIT_LOCK_(?:ARM|FLOOR|ENABLED)[A-Z0-9_]*/g);
    if (m) offenders.push(`${f}: ${[...new Set(m)].join(", ")}`);
  }
  assert.deepStrictEqual(offenders, [],
    `the global profit lock must not be shadowed per strategy: ${offenders.join(" | ")}`);
});

console.log(`\n${fail ? "FAILURES" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

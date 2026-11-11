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
 *      entry × (1 + floor%). It never fires before the arm threshold and never
 *      caps a runner that keeps climbing. Since 2026-11-07 it is the ONLY
 *      automatic exit in every strategy.
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
for (const k of Object.keys(process.env)) if (k.startsWith("PROFIT_LOCK_") || k.startsWith("PREMIUM_SL_")) delete process.env[k];

const guards = require("../src/utils/tradeGuards");

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}
/** Wipe every PROFIT_LOCK_ key so one case cannot leak into the next. */
function wipeEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith("PROFIT_LOCK_") || k.startsWith("PREMIUM_SL_")) delete process.env[k];
}
/** Wiped env with the lock switched ON (it ships OFF), so the lock math is tested. */
function freshEnv(over) {
  wipeEnv();
  Object.assign(process.env, { PROFIT_LOCK_ENABLED: "true" }, over || {});
}

// ═══════════════════════════════════════════════════════════════════════════
section("Defaults — the shipped numbers ARE the rule");

check("ships armed at +8% with a +5% floor, switched OFF", () => {
  wipeEnv();
  assert.strictEqual(guards.PROFIT_LOCK_ARM_PCT, 8);
  assert.strictEqual(guards.PROFIT_LOCK_FLOOR_PCT, 5);
  assert.strictEqual(guards.PROFIT_LOCK_ENABLED, false);
});

check("default is OFF — no strategy uses the lock until Common Rules turns it on", () => {
  wipeEnv();
  // Entry 100, peaked 108 (+8%), now back at 105 (the floor) — would fire if on.
  assert.strictEqual(guards.checkProfitLock(100, 105, 108), null);
  freshEnv();
  assert.ok(guards.checkProfitLock(100, 105, 108), "the switched-on lock did not fire");
});

// ═══════════════════════════════════════════════════════════════════════════
section("The ratchet — arms once, never loosens, never caps a runner");

check("does not fire before the arm threshold is reached", () => {
  freshEnv();
  // Peaked +5%, never touched +8%: the lock was never armed, so a fall to entry
  // does not exit.
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
  // Peak +8% → tier floor 106.8 (85% of the gain).
  assert.strictEqual(guards.checkProfitLock(100, 107, 108), null);
});

check("never caps a runner — a trade still climbing is left alone", () => {
  freshEnv();
  // This is what preserves the few large winners that carry the book. The lock
  // is a floor, not a take-profit.
  assert.strictEqual(guards.checkProfitLock(100, 140, 140), null);
  assert.strictEqual(guards.checkProfitLock(100, 300, 300), null);
});

check("trail 0 = fixed floor at entry+floor%, it does not follow the peak", () => {
  freshEnv({ PROFIT_LOCK_TRAIL_PCT: "0" });
  // Peak 200 (+100%) but price back to 106: still above the +5% floor, so the
  // lock holds its tongue.
  assert.strictEqual(guards.checkProfitLock(100, 106, 200), null);
  assert.ok(guards.checkProfitLock(100, 104, 200));
});

check("trail ships at 70% of the best gain", () => {
  freshEnv();
  assert.strictEqual(guards.PROFIT_LOCK_TRAIL_PCT, 70);
});

check("trail: floor follows the peak — the 2026-10-01 V2 PE case", () => {
  freshEnv();
  // Entry 142.75, peak 330 → keep 70% of 187.25 → floor 273.82.
  assert.strictEqual(guards.profitLockFloorLtp(142.75, 330, 5, 70), 273.82);
  assert.strictEqual(guards.checkProfitLock(142.75, 274, 330), null);
  const msg = guards.checkProfitLock(142.75, 273.8, 330);
  assert.ok(msg && /trail/.test(msg) && /273\.82/.test(msg), `trail did not fire: ${msg}`);
});

check("trail never sits below the fixed floor and never fires before arming", () => {
  freshEnv();
  // Peak +8.5%: 85% of the gain (first tier) is +7.22% — above the +5% floor, so it wins.
  assert.strictEqual(guards.profitLockFloorLtp(100, 108.5, 5, 70), 107.22);
  // Flat trail (tiers blank): 70% of the gain is +5.95%.
  assert.strictEqual(guards.profitLockFloorLtp(100, 108.5, 5, 70, ""), 105.95);
  // Peak +6%: not armed, so nothing fires even though 70% of the gain is +4.2%.
  assert.strictEqual(guards.checkProfitLock(100, 101, 106), null);
});

check("tiers: a small peak keeps more, a big runner keeps the flat trail", () => {
  freshEnv();
  assert.strictEqual(guards.PROFIT_LOCK_TRAIL_TIERS, "20:85,40:80");
  assert.strictEqual(guards.profitLockFloorLtp(100, 110, 5, 70), 108.5);   // 85% of +10
  assert.strictEqual(guards.profitLockFloorLtp(100, 130, 5, 70), 124);     // 80% of +30
  assert.strictEqual(guards.profitLockFloorLtp(100, 150, 5, 70), 135);     // 70% of +50
  const msg = guards.checkProfitLock(100, 108.4, 110);
  assert.ok(msg && /trail 85%/.test(msg) && /108\.5/.test(msg), `tier did not fire: ${msg}`);
});

check("tiers: the floor never drops as the peak crosses a tier edge", () => {
  freshEnv();
  let prev = 0;
  for (let best = 108; best <= 200; best += 0.05) {
    const f = guards.profitLockFloorLtp(100, best, 5, 70);
    assert.ok(f >= prev, `floor fell from ${prev} to ${f} at peak ${best.toFixed(2)}`);
    prev = f;
  }
});

check("tiers: trail 0 turns them off too, and garbage tiers fall back to the flat trail", () => {
  freshEnv({ PROFIT_LOCK_TRAIL_PCT: "0" });
  assert.strictEqual(guards.profitLockFloorLtp(100, 110, 5, guards.PROFIT_LOCK_TRAIL_PCT), 105);
  for (const v of ["", "abc", "20:150,x:y", "-5:80"]) {
    freshEnv({ PROFIT_LOCK_TRAIL_TIERS: v });
    assert.strictEqual(guards.profitLockFloorLtp(100, 110, 5, 70), 107, `tiers=${v}`);
  }
});

check("a garbage trail is ignored, never a wider floor", () => {
  for (const v of ["abc", "-10", "100", "250"]) {
    freshEnv({ PROFIT_LOCK_TRAIL_PCT: v });
    assert.strictEqual(guards.checkProfitLock(100, 106, 200), null, `trail=${v} changed the floor`);
    assert.ok(guards.checkProfitLock(100, 104, 200), `trail=${v} disabled the fixed floor`);
  }
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
  // An underwater trade has no profit to lock; firing here would turn the guard
  // into a stop-loss, which no strategy has.
  assert.strictEqual(guards.checkProfitLock(100, 90, 95), null);
});

// ═══════════════════════════════════════════════════════════════════════════
section("Reach — every engine that can hold an option honours the lock");

// Engines with no option premium of their own to lock. Anything listed here is
// claiming "I cannot hold an option position"; if that stops being true, the
// entry must be removed and the engine wired instead.
const ENGINES_WITHOUT_OPTION_POSITIONS = new Set([
  "earlyBirdPaper.js",                        // stock mode, not options
  // GAP_RUNAWAY's stock scanner holds shares — checked in tests/gapRunaway.regression.js.
  "gapRunawayStkPaper.js",
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
    // The COMMODITY (MCX) pages are built by utils/commodityPaperRouter, whose
    // engine (services/commodityPaper.js) owns the exits.
    if (/utils\/commodityPaperRouter/.test(src)
        && /services\/commodityPaper/.test(decomment(read("utils/commodityPaperRouter.js")))
        && /checkProfitLock/.test(decomment(read("services/commodityPaper.js")))) continue;
    if (!/checkProfitLock/.test(src)) missing.push(f);
  }
  assert.deepStrictEqual(missing, [],
    `paper engines that can hold an option but never call checkProfitLock: ${missing.join(", ")}`);
});

check("GAP_RUNAWAY (NIFTY) applies the profit lock like every other strategy", () => {
  // It used to be exempt from every common rule. The user's 2026-11-07 order puts
  // the lock on ALL strategies, so the exemption is gone.
  const src = decomment(read("routes/gapRunawayPaper.js"));
  assert.ok(/tradeGuards\.checkProfitLock\(/.test(src), "gapRunawayPaper.js must call checkProfitLock");
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
  for (const f of ["haScalpPaper.js", "rsiPivotStPaper.js", "prevOrbScalpPaper.js"]) {
    const src = decomment(read(`routes/${f}`));
    const i = src.indexOf("checkProfitLock");
    assert.ok(i > 0, `${f} does not call checkProfitLock`);
    const window = src.slice(Math.max(0, i - 400), i);
    assert.ok(/isFutures/.test(window), `${f} applies the premium lock without excluding a futures leg`);
  }
});

check("BACKTEST applies the lock, in spot-equivalent terms", () => {
  // The backtest engines have no option chain, so they model the premium from
  // the spot move via DELTA. Without this the backtest reports exits paper would
  // never take, which breaks the repo's rule that backtest must match paper.
  const bt = decomment(read("services/backtestEngine.js"));
  assert.ok(/PROFIT_LOCK_ARM_PCT/.test(bt),  "backtestEngine.js does not read the profit-lock arm %");
  assert.ok(/PROFIT_LOCK_FLOOR_PCT/.test(bt), "backtestEngine.js does not read the profit-lock floor %");
  assert.ok(/DELTA/.test(bt), "backtestEngine.js must convert the premium thresholds via DELTA");
  // EMA9+VWAP runs the real checkProfitLock on a δ-modelled premium.
  const ev = decomment(read("services/ema9vwapBacktestEngine.js"));
  assert.ok(/_tradeGuards\.checkProfitLock\(/.test(ev), "ema9vwapBacktestEngine.js does not call checkProfitLock");
  assert.ok(/exitLevelLtp\(/.test(ev), "ema9vwapBacktestEngine.js does not price the fill at the lock floor / stop");
  assert.ok(/DELTA/.test(ev), "ema9vwapBacktestEngine.js must model the premium via DELTA");
});

check("a backtest cannot arm and fire the lock on the SAME bar (look-ahead)", () => {
  // The dangerous bug: arming on this bar's HIGH and exiting on this bar's LOW.
  // A bar gives us both extremes but not their order, so that silently assumes
  // the move went up-then-down and manufactures profitable exits paper could
  // never take — inflating every backtest.
  //
  // Shared engine: arms off a peak snapshotted BEFORE the current bar is folded in.
  {
    const src = decomment(read("services/backtestEngine.js"));
    assert.ok(/bestPricePrevBar/.test(src),
      "backtestEngine.js does not snapshot a previous-bar peak — the lock can arm on the same bar it exits");
    const armLine = src.split("\n").find(l => />=\s*_PL_ARM_SPOT_PTS/.test(l));
    assert.ok(armLine, "backtestEngine.js: could not find the arm comparison");
    const guard = src.split("\n").find(l => /_PL_VALID/.test(l) && /bestPricePrevBar/.test(l));
    assert.ok(guard, "backtestEngine.js: the lock is not gated on the previous-bar snapshot");
    const snap = src.indexOf("bestPricePrevBar = position.bestPrice");
    const upd  = src.search(/bestPrice = candle\.(high|low)/);
    assert.ok(snap > 0 && upd > 0 && snap < upd,
      "backtestEngine.js: the previous-bar snapshot must be taken before this bar's peak update");
  }
  // EMA9+VWAP: path model open → adverse extreme → favourable extreme. The
  // adverse leg is checked against the peak BEFORE this bar's favourable extreme
  // can raise it, so a bar can never arm and give back on its own high/low pair.
  {
    const src = decomment(read("services/ema9vwapBacktestEngine.js"));
    const adv = src.search(/checkProfitLock\(_priceBase\(\),\s*pAdv/);
    const fav = src.search(/if \(pFav > position\.peak\) position\.peak = pFav/);
    assert.ok(adv > 0 && fav > 0, "ema9vwapBacktestEngine.js: could not find the adverse check and the favourable peak update");
    assert.ok(adv < fav, "ema9vwapBacktestEngine.js raises the peak on the favourable extreme before checking the adverse leg");
  }
});

check("a backtest cannot arm the lock without tracking the peak", () => {
  // The lock must arm on the running favourable extreme, not just the current
  // bar — otherwise a trade that peaked on an earlier candle never arms.
  {
    const src = decomment(read("services/backtestEngine.js"));
    const upd = src.search(/bestPrice\s*=\s*candle\.(high|low)/);
    assert.ok(upd > 0, "backtestEngine.js never updates bestPrice from the bar");
    // Compare against where the arm threshold is USED (the >= comparison), not
    // where the constant is declared.
    const use = src.search(/>=\s*_PL_ARM_SPOT_PTS/);
    assert.ok(use > 0, "backtestEngine.js never compares against the arm distance");
    assert.ok(upd < use, "backtestEngine.js reads the peak before updating it");
  }
  {
    const src = decomment(read("services/ema9vwapBacktestEngine.js"));
    assert.ok(/position\.peak = _priceBase\(\)/.test(src), "ema9vwapBacktestEngine.js does not seed the lock peak at entry");
    assert.ok(/if \(pOpen > position\.peak\) position\.peak = pOpen/.test(src), "ema9vwapBacktestEngine.js does not raise the peak at the bar open");
    assert.ok(/checkProfitLock\(_priceBase\(\),\s*pOpen,\s*position\.peak\)/.test(src), "ema9vwapBacktestEngine.js does not pass the carried peak to the lock");
  }
});

check("a profit-lock exit is never treated as a stop-out", () => {
  // It exits in PROFIT. If any mode classified it as an SL it would start an SL
  // pause, so a run of successful locks would progressively shut the strategy down.
  for (const f of ["emaRsiStPaper.js", "ema9vwapPaper.js", "bbRsiPaper.js",
                   "emaRsiStV2Paper.js"]) {
    const src = decomment(read(`routes/${f}`));
    const i = src.indexOf("checkProfitLock");
    assert.ok(i > 0, `${f}: no checkProfitLock call`);
    // Look at the exit branch that follows the call, not the whole file.
    const branch = src.slice(i, i + 700);
    assert.ok(!/_setSlPause/.test(branch),
      `${f}: the profit lock arms the SL pause — it exits in profit and must not`);
  }
});

check("a profit-lock exit does not block a same-bar re-entry", () => {
  // Paper fires the lock inside onTick, which returns from the TICK handler only
  // — the bar still closes and the entry section runs. A backtest that blocked
  // the bar would take fewer trades than paper on exactly the bars the lock works.
  // Only the global wait-after-exit cooldown may delay the next entry.
  const ev = decomment(read("services/ema9vwapBacktestEngine.js"));
  const i = ev.indexOf("if (exitReason) {");
  const j = ev.indexOf("} else if (isSessionEnd)", i);
  assert.ok(i > 0 && j > i, "could not find the ema9vwap profit-lock exit branch");
  assert.ok(!/blockEntryThisCandle = true/.test(ev.slice(i, j)),
    "ema9vwap backtest blocks re-entry after a profit lock — paper does not");
  // The shared engine adds no extra bar after a tick (lock) exit — only the cooldown.
  const bt = read("services/backtestEngine.js");
  assert.ok(/_reentryBlockUntilTs = candle\.time \+ \(_exitedOnTick \? 0 :/.test(bt),
    "shared engine blocks the rest of the bar after a profit lock — paper does not");
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

section("PREMIUM STOP-LOSS & TRAIL (PREMIUM_SL_*) — same call as the lock");

/** Run fn with the given PREMIUM_SL_ / PROFIT_LOCK_ env, then wipe both. */
function withSl(env, fn) {
  for (const k of Object.keys(process.env)) if (k.startsWith("PREMIUM_SL_") || k.startsWith("PROFIT_LOCK_")) delete process.env[k];
  Object.assign(process.env, env);
  try { fn(); } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith("PREMIUM_SL_") || k.startsWith("PROFIT_LOCK_")) delete process.env[k];
  }
}

check("off by default — unset PREMIUM_SL_ENABLED never exits", () => withSl({}, () => {
  assert.strictEqual(guards.checkProfitLock(100, 50, 100), null);
  assert.strictEqual(guards.premiumStopLtp(100, 100), null);
}));

check("one trailing 20%: buy 100 → stop 80; peak 110 → 88; peak 150 → 120", () => withSl({ PREMIUM_SL_ENABLED: "true" }, () => {
  assert.strictEqual(guards.premiumStopLtp(100, 100), 80);
  assert.strictEqual(guards.premiumStopLtp(100, 110), 88);
  assert.strictEqual(guards.premiumStopLtp(100, 150), 120);
  assert.strictEqual(guards.checkProfitLock(100, 81, 100), null);
  assert.ok(/^Stop-loss -20%/.test(guards.checkProfitLock(100, 80, 100)));
  assert.ok(/^Stop-loss trail 20%/.test(guards.checkProfitLock(100, 120, 150)));
  assert.strictEqual(guards.checkProfitLock(100, 121, 150), null);
}));

check("the stop only moves up — a peak below entry leaves it at the first stop", () => withSl({ PREMIUM_SL_ENABLED: "true", PREMIUM_SL_PCT: "10" }, () => {
  assert.strictEqual(guards.premiumStopLtp(100, 90), 90);
  assert.strictEqual(guards.premiumStopLtp(100, undefined), 90);
  assert.strictEqual(guards.premiumStopLtp(100, 200), 180);
}));

check("bad config never becomes a stop", () => {
  for (const env of [{ PREMIUM_SL_PCT: "0" }, { PREMIUM_SL_PCT: "100" }, { PREMIUM_SL_PCT: "x" }]) {
    withSl({ PREMIUM_SL_ENABLED: "true", ...env }, () => {
      assert.strictEqual(guards.checkProfitLock(100, 1, 100), null, JSON.stringify(env));
    });
  }
});

check("futures: the stop in index points — 20% of a ₹200 base", () => withSl({ PREMIUM_SL_ENABLED: "true" }, () => {
  assert.strictEqual(guards.checkFuturesStop("CE", 24000, 23961, 0), null);
  assert.ok(/^Stop-loss -20%/.test(guards.checkFuturesStop("CE", 24000, 23960, 0)));
  assert.ok(/^Stop-loss -20%/.test(guards.checkFuturesStop("PE", 24000, 24040, 0)));        // short
  assert.strictEqual(guards.futuresStopLevel("CE", 24000, 60), 24008);                     // 260 × 0.8 − 200
  assert.strictEqual(guards.futuresStopLevel("PE", 24000, 60), 23992);
  assert.ok(/^Stop-loss trail/.test(guards.checkFuturesStop("CE", 24000, 23992, 40)));       // best +40 → stop −8
  assert.strictEqual(guards.checkFuturesStop("CE", 24000, 23993, 40), null);
  // The futures options give the same level on the index itself.
  assert.strictEqual(guards.exitLevelLtp(24000, 24000, guards.futuresStopOpts(24000)), 23960);
  assert.strictEqual(guards.exitLevelLtp(24000, 24060, guards.futuresStopOpts(24000)), 24008);
}));

check("futures + stock stops stay off with the switch off", () => withSl({}, () => {
  assert.strictEqual(guards.checkFuturesStop("CE", 24000, 20000, 0), null);
  assert.strictEqual(guards.checkProfitLock(1000, 500, 1000, guards.stockStopOpts(1000)), null);
}));

check("stocks: 1 / 1 / 0.5% — buy 1000 → stop 990; best 1010 → 1005", () => withSl({ PREMIUM_SL_ENABLED: "true" }, () => {
  const o = guards.stockStopOpts(1000);
  assert.strictEqual(guards.exitLevelLtp(1000, 1000, o), 990);
  assert.strictEqual(guards.exitLevelLtp(1000, 1010, o), 1005);
  assert.strictEqual(guards.checkProfitLock(1000, 990.5, 1000, o), null);
  assert.ok(/^Stop-loss -1%/.test(guards.checkProfitLock(1000, 990, 1000, o)));
}));

check("next to the profit lock, the higher level wins (and is the fill level)", () => withSl({
  PREMIUM_SL_ENABLED: "true", PROFIT_LOCK_ENABLED: "true",
}, () => {
  // peak 110: lock floor 108.5 (tier 85%), stop still 80 → the lock decides.
  assert.strictEqual(guards.exitLevelLtp(100, 110), 108.5);
  assert.ok(/^Profit lock/.test(guards.checkProfitLock(100, 108, 110)));
  // peak 400: lock floor 310 (70% trail), stop 320 → the stop decides.
  assert.strictEqual(guards.exitLevelLtp(100, 400), 320);
  assert.ok(/^Stop-loss trail/.test(guards.checkProfitLock(100, 319, 400)));
}));

check("spot-point form matches the premium form (seed 200, delta 0.5)", () => withSl({ PREMIUM_SL_ENABLED: "true" }, () => {
  assert.strictEqual(guards.premiumStopSpotPts(0, 0.5), -80);      // 40 premium / 0.5
  assert.strictEqual(guards.premiumStopSpotPts(80, 0.5), (240 * 0.8 - 200) / 0.5);
  assert.strictEqual(guards.premiumStopSpotPts(0, 0), null);
}));

check("Settings exposes every PREMIUM_SL_ key, and replay snapshots capture them", () => {
  const settings = read("routes/settings.js");
  const keys = new Set(read("utils/tradeGuards.js").match(/PREMIUM_SL_[A-Z0-9_]+/g) || []);
  assert.ok(keys.size >= 2, `expected two PREMIUM_SL_ keys, found ${[...keys].join(", ")}`);
  const missing = [...keys].filter(k => !settings.includes(`"${k}"`));
  assert.deepStrictEqual(missing, [], `absent from Settings: ${missing.join(", ")}`);
  assert.ok(/\^PREMIUM_SL_/.test(read("utils/tickRecorder.js")), "tickRecorder does not snapshot PREMIUM_SL_*");
  assert.ok(/"PREMIUM_SL_ENABLED" in _snapSettings/.test(read("services/tickReplay.js")), "replay does not force the stop off for old recordings");
});

check("backtests fill at the shared level, not the lock-only floor", () => {
  const dir = path.join(SRC, "routes");
  const offenders = fs.readdirSync(dir).filter(f => /Backtest\.js$/.test(f))
    .filter(f => /profitLockFloorLtp\(/.test(decomment(read(`routes/${f}`))));
  assert.deepStrictEqual(offenders, [], `use tradeGuards.exitLevelLtp: ${offenders.join(", ")}`);
  for (const f of ["services/backtestEngine.js", "routes/paBacktest.js"]) {
    assert.ok(/premiumStopSpotPts\(/.test(decomment(read(f))), `${f} does not apply the premium stop`);
  }
});

console.log(`\n${fail ? "FAILURES" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * CONFIGURATION-FIDELITY INVARIANTS
 *
 *   node tests/configFidelity.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Nothing here opens
 * a socket, a broker connection or a session — the two behavioural groups call
 * pure/short-circuiting code paths only.
 *
 * The rule these assertions defend: a value the operator can configure must be the
 * value the engine actually acts on. Both groups below pinned a real defect found in
 * the 2026-07-26 configuration audit, and in both cases the failure mode was silent
 * — the config said one thing and the engine did another, with no error anywhere.
 *
 *   GROUP 1  A stale (already-expired) option-expiry override was used to build an
 *            option symbol for a contract that no longer exists. ORB and TREND_PB
 *            blocked the entry, but EMA_RSI_ST and BB_RSI entered anyway on "spot
 *            proxy" P&L — with the percentage option stop inert, because it needs an
 *            entry premium that never arrived. A configured stop that silently does
 *            not exist is the worst outcome available, hence: refuse the trade.
 *
 *   GROUP 2  The back-to-back-loss breaker fired at a HARDCODED 3 while
 *            {STRATEGY}_MAX_CONSEC_LOSSES was set to 0, which Settings labels
 *            "OFF". Three losses paused entries for 20 minutes on a strategy whose
 *            streak breaker the operator had explicitly disabled.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const SRC    = path.join(__dirname, "../src");
const read   = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");
// Prose that merely mentions code is not code. Every source assertion below runs on
// decommented text, so the explanatory comments these fixes added cannot satisfy —
// or accidentally break — an assertion about the code.
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// Async-aware runner. The sibling suites use a synchronous `check`, but several
// assertions here await validateAndGetOptionSymbol — and a sync runner would
// increment `pass` the moment the promise was created, turning every async failure
// into a silent green tick. Cases are queued and awaited in order instead, so the
// expiry-override env mutations in one case cannot leak into the next.
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

const instrument = require("../src/config/instrument");

// Deterministic env, applied AFTER the require on purpose. instrument.js calls
// dotenv.config() at load time, so anything scrubbed before the require is simply
// refilled from the developer's real .env — which is how a first draft of this suite
// ended up asserting against a live EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE and passing by
// luck. instrument.js reads every one of these keys lazily (per call, via getters),
// so setting them here is fully effective.
Object.assign(process.env, {
  TZ:                       "Asia/Calcutta",
  NIFTY_LOT_SIZE:           "65",
  LOT_MULTIPLIER:           "1",
  STRIKE_OFFSET_CE:         "0",
  STRIKE_OFFSET_PE:         "0",
  INSTRUMENT:               "NIFTY_OPTIONS",
  OPTION_EXPIRY_OVERRIDE:   "",
  OPTION_EXPIRY_TYPE:       "weekly",
});
// Per-mode expiry overrides were REMOVED on 2026-08-05 (README "One common expiry
// for every strategy"): instrument.js now reads OPTION_EXPIRY_OVERRIDE only. They are
// still scrubbed here so a leftover key in a developer's .env cannot make the
// single-key assertion below pass for the wrong reason.
const RETIRED_PREFIXES = ["EMA_RSI_ST", "BB_RSI", "PA", "ORB", "EMA9VWAP", "TREND_PB"];
for (const p of RETIRED_PREFIXES) {
  delete process.env[`${p}_OPTION_EXPIRY_OVERRIDE`];
  delete process.env[`${p}_OPTION_EXPIRY_TYPE`];
}

// IST calendar date N days from now, as "YYYY-MM-DD". Derived from the clock rather
// than hardcoded so the suite does not rot into passing (or failing) on a fixed date.
const istDateOffset = (days) =>
  new Date(Date.now() + 19800000 + days * 86400000).toISOString().slice(0, 10);

const PAST   = istDateOffset(-30);
const FUTURE = istDateOffset(+30);

// ── GROUP 1a — the staleness predicate itself ───────────────────────────────
section("Expiry-override staleness predicate");

check("a date well in the past is stale", () => {
  assert.strictEqual(instrument.isExpiryOverrideStale(PAST), true, `${PAST} should be stale`);
});

check("a date well in the future is NOT stale", () => {
  assert.strictEqual(instrument.isExpiryOverrideStale(FUTURE), false, `${FUTURE} should not be stale`);
});

check("staleness is decided at the expiry day's 15:30 IST close, not at midnight", () => {
  // The contract trades all through its expiry day, so "today" must not be stale
  // before 15:30 IST and must be stale after. Asserting the boundary directly keeps
  // this honest whatever time the suite runs at.
  const today = istDateOffset(0);
  const istMins = (() => {
    const d = new Date(Date.now() + 19800000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  })();
  const expected = istMins > (15 * 60 + 30);
  assert.strictEqual(instrument.isExpiryOverrideStale(today), expected,
    `today (${today}) at ${istMins} IST-minutes: expected stale=${expected}`);
});

check("blank and malformed input are not treated as stale", () => {
  // The caller reports format errors separately; this predicate must not turn a typo
  // into a trading halt.
  for (const bad of ["", "   ", null, undefined, "not-a-date", "2026-13", "yyyy-mm-dd"]) {
    assert.strictEqual(instrument.isExpiryOverrideStale(bad), false,
      `${JSON.stringify(bad)} should not be stale`);
  }
});

// ── GROUP 1b — the entry guard ──────────────────────────────────────────────
section("Stale expiry blocks option-symbol resolution");

// These calls short-circuit inside the manual-override branch, so no Fyers request
// is made in either direction.
const resolve = (side, mode) => instrument.validateAndGetOptionSymbol(24600, side, mode);

check("a stale COMMON override refuses to build a symbol", async () => {
  process.env.OPTION_EXPIRY_OVERRIDE = PAST;
  const r = await resolve("CE");
  assert.strictEqual(r.invalid, true, "expected invalid:true");
  assert.strictEqual(r.symbol, null, "a refused resolution must not hand back a symbol");
  assert.strictEqual(r.staleExpiry, PAST);
  assert.strictEqual(r.overrideKey, "OPTION_EXPIRY_OVERRIDE", "the banner needs the key that actually bound");
});

check("a stale override blocks EVERY mode, including the ones with no per-mode key", async () => {
  process.env.OPTION_EXPIRY_OVERRIDE = PAST;
  for (const mode of ["EMA_RSI_ST", "ORB", "EMA9VWAP", "TREND_PB", undefined]) {
    const r = await resolve("CE", mode);
    assert.strictEqual(r.invalid, true, `${mode}: expected invalid:true`);
    assert.strictEqual(r.symbol, null, `${mode}: expected no symbol`);
  }
});

check("a RETIRED per-mode override is ignored — the common key is the only one that binds", async () => {
  // Per-mode expiry keys were removed on 2026-08-05; every engine trades the one
  // common weekly expiry. A leftover {MODE}_OPTION_EXPIRY_OVERRIDE in an old .env
  // must therefore be completely inert — the danger is a half-migration where it
  // still silently wins for one strategy and quietly trades a different contract.
  process.env.OPTION_EXPIRY_OVERRIDE = FUTURE;
  process.env.EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE = PAST;   // stale, and must NOT bind
  try {
    const r = await resolve("CE", "EMA_RSI_ST");
    assert.ok(!r.invalid, "a stale retired per-mode key must not block the fresh common expiry");
    assert.ok(/^NSE:NIFTY/.test(r.symbol || ""), `expected a NIFTY symbol, got ${r.symbol}`);
    // ...and a mode that never had its own key behaves identically.
    const other = await resolve("CE", "ORB");
    assert.ok(!other.invalid && other.symbol, "ORB should resolve on the same common expiry");
  } finally {
    delete process.env.EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE;
  }
});

check("the common key still blocks even when a retired per-mode key is fresh", async () => {
  // The mirror image: a fresh per-mode leftover must not rescue a stale common
  // date, or the refuse-the-trade guard could be bypassed by dead config.
  process.env.OPTION_EXPIRY_OVERRIDE = PAST;
  process.env.EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE = FUTURE;
  try {
    const r = await resolve("CE", "EMA_RSI_ST");
    assert.strictEqual(r.invalid, true, "a stale common expiry must block regardless of retired keys");
    assert.strictEqual(r.overrideKey, "OPTION_EXPIRY_OVERRIDE", "the error must name the common key");
  } finally {
    delete process.env.EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE;
  }
});

check("the guard does NOT over-block: a future override still resolves", async () => {
  // A guard that blocks everything would be "safe" and useless. Pin the happy path.
  process.env.OPTION_EXPIRY_OVERRIDE = FUTURE;
  const r = await resolve("CE");
  assert.ok(!r.invalid, "a future expiry must not be refused");
  assert.ok(/^NSE:NIFTY/.test(r.symbol || ""), `expected a NIFTY symbol, got ${r.symbol}`);
});

check("a refused resolution never falls through to a DIFFERENT expiry", async () => {
  // Quietly substituting the auto-detected nearest expiry would change the premium,
  // theta and therefore the risk of every position — the operator's call, not ours.
  process.env.OPTION_EXPIRY_OVERRIDE = PAST;
  const r = await resolve("PE", "EMA9VWAP");
  assert.strictEqual(r.symbol, null,
    "refusal must not be silently replaced by an auto-detected expiry");
});

// ── GROUP 1c — the guard is reachable ───────────────────────────────────────
section("Stale-expiry guard is wired end to end");

check("the dashboard banner shares the resolver's staleness predicate", () => {
  const app = decomment(read("app.js"));
  assert.ok(/isExpiryOverrideStale/.test(app),
    "app.js re-implements staleness instead of importing it — the banner and the engine can disagree");
  assert.ok(!/T15:30:00\+05:30/.test(app),
    "app.js still hand-rolls the 15:30 IST boundary; delete it and use isExpiryOverrideStale");
});

check("no engine has re-grown a per-mode expiry override", () => {
  // The banner used to enumerate per-mode prefixes because the resolver honoured
  // them. Both sides were removed together on 2026-08-05, so the invariant that
  // matters now is the inverse: nothing in src/ may READ a {MODE}_OPTION_EXPIRY_*
  // key again, or the Settings page and the Dashboard banner — which only show the
  // common one — would stop describing what the engines actually trade.
  const readers = [];
  for (const p of RETIRED_PREFIXES) {
    for (const f of ["config/instrument.js", "app.js", "routes/settings.js"]) {
      if (new RegExp(`${p}_OPTION_EXPIRY_(OVERRIDE|TYPE)`).test(decomment(read(f)))) {
        readers.push(`${f}: ${p}_OPTION_EXPIRY_*`);
      }
    }
  }
  assert.deepStrictEqual(readers, [],
    `per-mode expiry overrides are retired but still read by: ${readers.join(", ")}`);
});

check("manual-entry routes refuse an unresolvable symbol, like the automatic paths do", () => {
  // The two automatic entry paths always checked `invalid`; the manual button did
  // not, so it would have entered on symbol=null.
  for (const f of ["routes/emaRsiStPaper.js", "routes/ema9vwapPaper.js"]) {
    const src = decomment(read(f));
    const i = src.indexOf("validateAndGetOptionSymbol(spot, side,");
    assert.ok(i >= 0, `${f}: manual-entry symbol lookup not found`);
    const block = src.slice(i, i + 700);
    assert.ok(/optResult\.invalid/.test(block),
      `${f}: manual entry does not check optResult.invalid — it can enter with no option symbol`);
    assert.ok(/return res\.status\(\s*409/.test(block),
      `${f}: manual entry should reject with a 409 rather than enter`);
  }
});

// ── GROUP 2 — the consecutive-loss breaker honours its config key ───────────
section("Consecutive-loss breaker is configuration-driven");

// Every engine that owns a copy of the breaker, and the key each one must read.
const STREAK_ENGINES = [
  { file: "routes/emaRsiStPaper.js",   key: "EMA_RSI_ST_MAX_CONSEC_LOSSES" },
  { file: "routes/emaRsiStLive.js",    key: "EMA_RSI_ST_MAX_CONSEC_LOSSES" },
  { file: "routes/ema9vwapPaper.js",   key: "EMA9VWAP_MAX_CONSEC_LOSSES"   },
  { file: "services/backtestEngine.js", key: "EMA_RSI_ST_MAX_CONSEC_LOSSES" },
];

check("no engine still triggers the breaker at a hardcoded 3", () => {
  const offenders = [];
  for (const { file } of STREAK_ENGINES) {
    if (/_consecutiveLosses\s*>=\s*3\b/.test(decomment(read(file)))) offenders.push(file);
  }
  assert.deepStrictEqual(offenders, [],
    `hardcoded 3-loss breaker survives in: ${offenders.join(", ")} — a configured 0 ("OFF") would still pause entries`);
});

for (const { file, key } of STREAK_ENGINES) {
  check(`${path.basename(file)}: the breaker reads ${key}`, () => {
    const src = decomment(read(file));
    assert.ok(src.includes(key), `${file} never reads ${key}`);
    // 0 must be a real OFF, not "trigger on the very first loss".
    assert.ok(/_streakMax\s*>\s*0\s*&&/.test(src) || /_streakMax\s*>\s*0\s*\)/.test(src),
      `${file}: the breaker does not guard on a positive limit — 0 would fire immediately or not at all by accident`);
  });
}

check("the paper/live status payload exposes the limit so the UI cannot invent one", () => {
  for (const f of ["routes/emaRsiStPaper.js", "routes/emaRsiStLive.js", "routes/ema9vwapPaper.js"]) {
    const src = decomment(read(f));
    assert.ok(/consecStreakLimit/.test(src),
      `${f}: status payload has no consecStreakLimit — the client falls back to a hardcoded denominator`);
  }
});

check("no Loss Streak card renders a literal '/ 3'", () => {
  // The card used to read "2 / 3 ⚠️ 1 more = pause" while the breaker was disabled.
  const offenders = [];
  for (const f of ["routes/emaRsiStPaper.js", "routes/emaRsiStLive.js", "routes/ema9vwapPaper.js"]) {
    if (/['"` ]\/ 3['"`<]/.test(decomment(read(f)))) offenders.push(f);
  }
  assert.deepStrictEqual(offenders, [],
    `hardcoded "/ 3" denominator still rendered in: ${offenders.join(", ")}`);
});

// ── Run ─────────────────────────────────────────────────────────────────────
run().then(() => {
  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
});

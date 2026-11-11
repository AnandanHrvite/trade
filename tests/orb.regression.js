#!/usr/bin/env node
/**
 * ORB regression + risk-invariant suite.
 *
 *   node tests/orb.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Uses REAL cached
 * NIFTY 5-min candles from ~/trading-data/backtest_cache when present, and falls
 * back to a deterministic synthetic series so the suite still runs on a clean
 * machine.
 *
 * Every assertion exists because a real defect was found in the 2026-07-26 rebuild
 * and its adversarial review. Read the label to know what regression it guards.
 *
 * 2026-11-07: the global profit lock is ORB's ONLY automatic exit (owner order).
 * The stop / trail / breakeven / re-entry / daily-limit assertions went with the
 * features they guarded; the "profit lock is the only exit" block replaces them.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");

// Deterministic env so a developer's .env cannot change expected values.
Object.assign(process.env, {
  TZ:                        "Asia/Calcutta",
  ORB_RANGE_START:           "09:15",
  ORB_RANGE_END:             "09:30",
  ORB_ENTRY_END:             "11:30",
  ORB_OR_ATR_MAX:            "2.5",
  ORB_GAP_OR_MULT:           "3.0",
  ORB_BODY_ATR_MULT:         "0.6",
  ORB_RETEST_MAX_WAIT:       "6",
  ORB_DEBUG_TRACE:           "false",
  NIFTY_LOT_SIZE:            "65",
  LOT_MULTIPLIER:            "1",
});

const S    = require("../src/strategies/orb_breakout");

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); pass++; }
  catch (err) { console.log(`  ❌ ${label}\n       ${err.message}`); fail++; }
}

const DAY = t => Math.floor((t + 19800) / 86400);
const MIN = t => Math.floor((t + 19800) / 60) % 1440;

// ── Fixtures ────────────────────────────────────────────────────────────────
function loadCandles() {
  const dir = path.join(os.homedir(), "trading-data", "backtest_cache");
  let out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^NSE_NIFTY50-INDEX_5_/.test(f)) continue;
      const arr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (Array.isArray(arr)) out = out.concat(arr);
    }
  } catch (_) { /* fall through to synthetic */ }
  if (out.length) {
    const seen = new Set();
    return out.filter(c => (seen.has(c.time) ? false : (seen.add(c.time), true)))
              .sort((a, b) => a.time - b.time);
  }
  // Deterministic synthetic: 6 sessions, 09:15–15:25, gentle drift + noise.
  const bars = [];
  const base = Math.floor(Date.UTC(2026, 2, 2, 3, 45) / 1000);   // 09:15 IST
  for (let d = 0; d < 6; d++) {
    let px = 24000 + d * 40;
    for (let i = 0; i < 74; i++) {
      const t = base + d * 86400 + i * 300;
      const drift = Math.sin((i + d * 7) / 5) * 18 + (i < 4 ? 30 : 0);
      const o = px, c = px + drift;
      bars.push({ time: t, open: o, high: Math.max(o, c) + 6, low: Math.min(o, c) - 6, close: c, volume: 100000 + i * 37 });
      px = c;
    }
  }
  return bars;
}
const CANDLES = loadCandles();
const IDX = new Map(CANDLES.map((c, i) => [c.time, i]));
const DAYS = [...new Set(CANDLES.map(c => DAY(c.time)))].sort((a, b) => a - b);

/** Every signal the engine produces over the whole fixture, one entry per day. */
function allSignals() {
  const out = [];
  for (const d of DAYS) {
    for (const c of CANDLES.filter(x => DAY(x.time) === d)) {
      const gi = IDX.get(c.time);
      const sig = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true });
      out.push({ bar: c, sig });
    }
  }
  return out;
}
const ALL_SIGS = allSignals();
const ENTRIES  = ALL_SIGS.filter(x => x.sig.signal !== "NONE");

(async () => {
  console.log(`\nORB regression suite — ${CANDLES.length} candles / ${DAYS.length} sessions, ${ENTRIES.length} entry signals\n`);

  // ── Profit lock is the ONLY automatic exit (2026-11-07) ──────────────────
  console.log("Profit lock is the only exit");

  check("the shared exit engine exposes no exit but the profit lock", () => {
    const orbExits = require("../src/strategies/orbExits");
    assert.deepStrictEqual(Object.keys(orbExits).sort(), ["evaluateTickExits", "isLtpStale", "trackExcursion"],
      "orbExits grew a second exit rule (or a stop/trail helper) again");
  });

  check("evaluateTickExits fires on the profit lock, and on nothing else", () => {
    const orbExits = require("../src/strategies/orbExits");
    const keys = ["PROFIT_LOCK_ENABLED", "PROFIT_LOCK_ARM_PCT", "PROFIT_LOCK_FLOOR_PCT", "PROFIT_LOCK_TRAIL_PCT"];
    const snap = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    try {
      Object.assign(process.env, { PROFIT_LOCK_ENABLED: "true", PROFIT_LOCK_ARM_PCT: "8", PROFIT_LOCK_FLOOR_PCT: "5", PROFIT_LOCK_TRAIL_PCT: "0" });
      const mk = (peak) => ({ side: "CE", isFutures: false, entrySpot: 24000, optionEntryLtp: 200, qty: 65, peakPremium: peak, entryTimeMs: Date.now() });
      // A collapsing premium on an unarmed trade: no stop exists, so it must HOLD.
      const crash = orbExits.evaluateTickExits(mk(200), { spotPrice: 23500, optionLtp: 20 });
      assert.strictEqual(crash.exit, false, `exited a losing trade with no lock armed: ${crash.reason}`);
      // Armed (+10% peak), then back to the +5% floor → the lock exits.
      const lock = orbExits.evaluateTickExits(mk(220), { spotPrice: 24010, optionLtp: 210 });
      assert.ok(lock.exit && /Profit lock/.test(lock.reason), `armed lock did not exit at its floor: ${lock.reason}`);
      // Futures never carry the premium lock.
      const fut = orbExits.evaluateTickExits(Object.assign(mk(30000), { isFutures: true }), { spotPrice: 1, optionLtp: 1 });
      assert.strictEqual(fut.exit, false, "the premium lock fired on a futures leg");
    } finally {
      for (const k of keys) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k]; }
    }
  });

  check("no ORB engine reads a removed exit / day-limit key", () => {
    const DEAD = /process\.env\.(ORB_MAX_TRADE_LOSS|ORB_PREMIUM_STOP_PCT|ORB_SL_|ORB_TRAIL_|ORB_BREAKEVEN_|ORB_OPP_CANDLE_|ORB_CANDLE_TRAIL_|ORB_ST_TRAIL_|ORB_FORCED_EXIT|ORB_MAX_DAILY_|ORB_REENTRY_AFTER_SL|ORB_RISK_THROTTLE_ENABLED|ORB_LOSS_STREAK_SKIP|ORB_MAX_WEEKLY_LOSS|HARD_SL_)/;
    for (const rel of ["../src/routes/orbPaper.js", "../src/routes/orbBacktest.js",
                       "../src/strategies/orbExits.js", "../src/strategies/orb_breakout.js"]) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf-8");
      const m = src.match(DEAD);
      assert.ok(!m, `${rel} still reads ${m && m[0]}`);
      assert.ok(!/_envNum\("ORB_|_envOn\("ORB_/.test(src), `${rel} reads an ORB exit key through a helper`);
    }
  });

  check("the strategy proposes no stop", () => {
    for (const { sig } of ENTRIES) assert.ok(!("slSpot" in sig), "getSignal still returns an slSpot");
  });

  // ── Engine invariants ──  // ── Engine invariants ────────────────────────────────────────────────────
  console.log("\nEntry-engine invariants");

  check("never enters before the opening range is frozen (09:30)", () => {
    for (const { bar, sig } of ALL_SIGS) {
      if (MIN(bar.time) < 570) assert.strictEqual(sig.signal, "NONE", `entered at ${MIN(bar.time)} min IST`);
    }
  });

  check("never enters at or after ORB_ENTRY_END", () => {
    for (const { bar, sig } of ALL_SIGS) {
      if (MIN(bar.time) >= 690) assert.strictEqual(sig.signal, "NONE", `entered at ${MIN(bar.time)} min IST`);
    }
  });

  check("ORB_ENTRY_START defaults to the OR freeze — no behaviour change", () => {
    const prev = process.env.ORB_ENTRY_START;
    delete process.env.ORB_ENTRY_START;
    try {
      for (const { bar, sig } of ALL_SIGS) {
        const gi = IDX.get(bar.time);
        const again = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true });
        assert.strictEqual(again.signal, sig.signal, "unset ORB_ENTRY_START changed a signal");
      }
    } finally { if (prev === undefined) delete process.env.ORB_ENTRY_START; else process.env.ORB_ENTRY_START = prev; }
  });

  check("ORB_ENTRY_START blocks every entry before it", () => {
    const prev = process.env.ORB_ENTRY_START;
    process.env.ORB_ENTRY_START = "10:30";   // 630 min IST
    try {
      for (const d of DAYS) {
        for (const c of CANDLES.filter(x => DAY(x.time) === d)) {
          const gi = IDX.get(c.time);
          const sig = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true });
          if (sig.signal !== "NONE") assert.ok(MIN(c.time) >= 630, `entered at ${MIN(c.time)} min IST, before ORB_ENTRY_START`);
        }
      }
    } finally { if (prev === undefined) delete process.env.ORB_ENTRY_START; else process.env.ORB_ENTRY_START = prev; }
  });

  check("ORB_ENTRY_START earlier than the OR freeze is clamped, not honoured", () => {
    const prev = process.env.ORB_ENTRY_START;
    process.env.ORB_ENTRY_START = "09:00";   // before ORB_RANGE_END — the OR does not exist yet
    try {
      for (const d of DAYS) {
        for (const c of CANDLES.filter(x => DAY(x.time) === d)) {
          const gi = IDX.get(c.time);
          const sig = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true });
          if (sig.signal !== "NONE") assert.ok(MIN(c.time) >= 570, `entered at ${MIN(c.time)} min IST, before the opening range froze`);
        }
      }
    } finally { if (prev === undefined) delete process.env.ORB_ENTRY_START; else process.env.ORB_ENTRY_START = prev; }
  });

  check("a garbage ORB_ENTRY_START degrades to the shipped rule, not to a dead session", () => {
    // A non-time value must not leave entryStart = NaN, which would make every window
    // comparison false and silently stop ORB trading for the whole day.
    const prev = process.env.ORB_ENTRY_START;
    process.env.ORB_ENTRY_START = "not-a-time";
    try {
      let entries = 0;
      for (const { bar } of ALL_SIGS) {
        const gi = IDX.get(bar.time);
        const sig = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true });
        if (sig.signal !== "NONE") entries++;
      }
      assert.strictEqual(entries, ENTRIES.length, "a garbage entry-start changed the number of entries");
    } finally { if (prev === undefined) delete process.env.ORB_ENTRY_START; else process.env.ORB_ENTRY_START = prev; }
  });

  check("the opening range is FROZEN — same ORH/ORL all day, never repainted", () => {
    for (const d of DAYS) {
      const dayBars = CANDLES.filter(x => DAY(x.time) === d && MIN(x.time) >= 570);
      let first = null;
      for (const c of dayBars) {
        const gi = IDX.get(c.time);
        const or = S.computeOpeningRange(CANDLES.slice(Math.max(0, gi - 199), gi + 1));
        if (!or) continue;
        if (!first) { first = or; continue; }
        assert.strictEqual(or.high, first.high, "ORH changed after 09:30");
        assert.strictEqual(or.low,  first.low,  "ORL changed after 09:30");
      }
    }
  });

  check("no look-ahead: a signal never depends on candles after the decision bar", () => {
    for (const { bar, sig } of ALL_SIGS) {
      if (sig.signal === "NONE") continue;
      const gi = IDX.get(bar.time);
      const truncated = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true });
      assert.strictEqual(truncated.signal, sig.signal, "signal changed when future candles were withheld");
    }
  });

  check("entry is always the decision candle's CLOSE (never intrabar)", () => {
    for (const { bar, sig } of ENTRIES) {
      assert.strictEqual(sig.entrySpot, Math.round(bar.close * 100) / 100, "entrySpot is not the bar close");
    }
  });

  check("the day-sanity gates actually hold on every entry taken", () => {
    for (const { sig } of ENTRIES) {
      if (sig.atr15) assert.ok(sig.rangePts / sig.atr15 <= 2.5 + 1e-9, `OR ${sig.rangePts} = ${(sig.rangePts / sig.atr15).toFixed(2)}xATR15 > 2.5`);
      if (sig.gapPts != null) assert.ok(Math.abs(sig.gapPts) <= 3 * sig.rangePts + 1e-9, `gap ${sig.gapPts} > 3xOR`);
    }
  });

  check("CE breaks ABOVE the range and PE BELOW it (no inverted side)", () => {
    for (const { sig } of ENTRIES) {
      if (sig.side === "CE") assert.ok(sig.entrySpot > sig.orh, `CE entry ${sig.entrySpot} not above ORH ${sig.orh}`);
      else                   assert.ok(sig.entrySpot < sig.orl, `PE entry ${sig.entrySpot} not below ORL ${sig.orl}`);
    }
  });

  check("a gate trace is attached on EVERY return path, warm-up included", () => {
    for (const { sig } of ALL_SIGS) {
      assert.ok(Array.isArray(sig.gates) && sig.gates.length > 0,
        "sig.gates missing/empty — the skip log would lose the funnel for this candle");
    }
    const warm = S.getSignal([], { silent: true });
    assert.ok(Array.isArray(warm.gates) && warm.gates.length > 0, "warm-up path returned no trace");
  });

  check("the only gate allowed to FAIL on an entry is confirmation, and only via the retest fallback", () => {
    for (const { sig } of ENTRIES) {
      const failed = sig.gates.filter(g => g.status === "FAIL").map(g => g.gate);
      const unexpected = failed.filter(g => g !== "confirmation");
      assert.strictEqual(unexpected.length, 0, `entered with hard-gate failure(s): ${unexpected.join(",")}`);
      if (failed.includes("confirmation")) {
        // Confirmation may fail and the trade still enter — but ONLY because the
        // documented retest/resume fallback took over. Anything else is a bug.
        const fb = sig.gates.find(g => g.gate === "retest window" && g.status === "PASS");
        assert.ok(fb, "confirmation FAILED and the trade still entered, with no retest-fallback PASS to justify it");
        assert.ok(/\[resume\]|\[retest\]/.test(sig.reason), `entry reason does not record the fallback path: ${sig.reason}`);
      }
    }
  });

  check("the skip log gets the WHOLE funnel, compactly (docs claim this — keep it true)", () => {
    const withGates = ALL_SIGS.filter(x => x.sig.gates && x.sig.gates.length);
    assert.ok(withGates.length, "no signal produced gates at all");
    for (const { sig } of withGates) {
      const f = S.summarizeGates(sig);
      assert.ok(typeof f === "string" && f.length, "summarizeGates returned nothing for a traced signal");
      assert.strictEqual(f.split(",").length, sig.gates.length, "funnel dropped gates — it must encode ALL of them, not just the blocker");
      assert.ok(/^[^,]+:[PFSI](,[^,]+:[PFSI])*$/.test(f), `funnel not in name:CODE form: ${f}`);
      assert.ok(f.length < 400, `funnel too long for a per-candle log row: ${f.length} bytes`);
    }
    assert.strictEqual(S.summarizeGates(null), null, "summarizeGates must tolerate a null signal");
    assert.strictEqual(S.summarizeGates({}), null, "summarizeGates must tolerate a signal with no gates");
  });

  check("the paper route actually WRITES the funnel to the skip log", () => {
    for (const f of ["orbPaper.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "../src/routes", f), "utf-8");
      // The route is a create(pair) builder: the skip-log mode is the pair's MODE ("orb" on NIFTY).
      const m = src.match(/appendSkipLog\((?:"orb"|MODE),\s*\{\s*gate:\s*"signal_none"[^}]*\}/);
      assert.ok(m, `${f} has no signal_none skip log`);
      assert.ok(/funnel:\s*orbStrategy\.summarizeGates\(sig\)/.test(m[0]),
        `${f} logs signal_none WITHOUT the funnel — the README claim would be false`);
    }
  });

  check("removed config keys have no effect (dead knobs cannot resurrect)", () => {
    const baseline = ENTRIES.length;
    const dead = { ORB_PRIORDAY_LEVEL_FILTER: "true", ORB_CLOSE_POS_PCT: "0.01",
                   ORB_ENTRY_V2_ENABLED: "true", ORB_ENTRY_V3_ENABLED: "false",
                   ORB_OR_ATR_MIN: "2.4", ORB_RETEST_MODE: "off" };
    const saved = {};
    for (const k of Object.keys(dead)) { saved[k] = process.env[k]; process.env[k] = dead[k]; }
    try {
      assert.strictEqual(allSignals().filter(x => x.sig.signal !== "NONE").length, baseline,
        "a deleted key still changes behaviour — it was not fully removed");
    } finally {
      for (const k of Object.keys(dead)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });

  // ── Backtest end-to-end ──────────────────────────────────────────────────
  console.log("\nBacktest end-to-end");

  const BT = require("../src/routes/orbBacktest").runOrbBacktest;
  const BT_TRADES = await BT(CANDLES, null);

  check("the backtest actually runs and produces well-formed records", () => {
    assert.ok(Array.isArray(BT_TRADES), "runOrbBacktest did not return an array");
    for (const t of BT_TRADES) {
      for (const [k, v] of Object.entries(t)) {
        assert.ok(v !== undefined, `field ${k} is undefined`);
        assert.ok(!(typeof v === "number" && !isFinite(v)), `field ${k} is not finite`);
      }
    }
  });

  check("backtest exits are only the profit lock or the session end", () => {
    for (const t of BT_TRADES) {
      assert.ok(/^Profit lock|^Session stopped/.test(t.reason), `backtest booked a removed exit: ${t.reason}`);
    }
  });

  // ── Mode parity ──────────────────────────────────────────────────────────
  console.log("\nPaper engine safety");

  check("paper persists a position for crash recovery", () => {
    for (const f of ["orbPaper.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "../src/routes", f), "utf-8");
      // Persisted through the pair runtime: on NIFTY rt.persist is positionPersist's
      // saveOrbPosition / clearOrbPosition (checked below), elsewhere the pair's own snapshot.
      assert.ok(/rt\.persist\.save\(/.test(src),  `${f} never persists — a restart mid-trade leaves an untracked position`);
      assert.ok(/rt\.persist\.clear\(/.test(src), `${f} never clears the snapshot — stale orphan warnings on every boot`);
    }
  });

  check("the NIFTY instance persists through saveOrbPosition / clearOrbPosition", () => {
    const pp = require("../src/utils/positionPersist");
    const rt = require("../src/utils/pairRuntime").forStrategy("orb", "NIFTY");
    const calls = [];
    const saved = { s: pp.saveOrbPosition, c: pp.clearOrbPosition };
    assert.strictEqual(typeof saved.s, "function"); assert.strictEqual(typeof saved.c, "function");
    pp.saveOrbPosition = (p) => calls.push(["save", p.side]);
    pp.clearOrbPosition = () => calls.push(["clear"]);
    try { rt.persist.save({ side: "CE" }, {}); rt.persist.clear(); }
    finally { pp.saveOrbPosition = saved.s; pp.clearOrbPosition = saved.c; }
    assert.deepStrictEqual(calls, [["save", "CE"], ["clear"]]);
  });

  check("the paper entry path guards the await window against a duplicate entry", () => {
    for (const f of ["orbPaper.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "../src/routes", f), "utf-8");
      assert.ok(/_entryInFlight/.test(src), `${f} has no in-flight guard — two candle closes could open two positions`);
      assert.ok(/_entryInFlight\s*=\s*false/.test(src), `${f} never releases the in-flight guard`);
    }
  });

  // ── Anti-duplication: ONE owner for the exit rules ────────────────────────
  // ORB's exits used to be hand-maintained in four places, which is how this repo
  // once shipped a backtest that evaluated the rules in the wrong order and silently
  // reported trades the live engine could not have taken. Nothing but orbExits.js may
  // spell an exit rule out again.
  check("no ORB engine keeps a private copy of an exit rule", () => {
    const OWNED = [
      [/ORB_BREAKEVEN_OR_MULT/,     "the adaptive-breakeven trigger"],
      [/ORB_OPP_CANDLE_BODY_MULT/,  "the opposite-candle threshold"],
      [/ORB_TRAIL_EMA/,             "the EMA trend-trail period"],
      [/ORB_PREMIUM_STOP_PCT/,      "the premium disaster stop"],
    ];
    const CONSUMERS = ["../src/routes/orbPaper.js", "../scripts/lib/orbSim.js"];
    // These drive the simulation instead of owning one, so they must delegate to
    // scripts/lib/orbSim.js rather than require orbExits themselves — but they are
    // held to the same no-private-copy rule (2026-08-11).
    const DELEGATES = ["../scripts/orbValidate.js", "../scripts/orbSweep.js"];
    const noPrivateCopy = (rel, code) => {
      for (const [re, what] of OWNED) {
        const reads = new RegExp(`process\\.env\\.${re.source.replace(/[/\\]/g, "")}`);
        assert.ok(!reads.test(code),
          `${rel} reads ${what} directly — that rule belongs to src/strategies/orbExits.js. Four copies is how paper, live, backtest and orbValidate silently drifted apart.`);
      }
    };
    for (const rel of CONSUMERS) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf-8");
      // Strip comments and HTML/template display strings — a route may still NAME a
      // key when it renders it; what it may not do is READ it to make a decision.
      noPrivateCopy(rel, src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""));
      assert.ok(/require\(.*orbExits.*\)/.test(src),
        `${rel} does not require the shared exit engine`);
    }
    for (const rel of DELEGATES) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf-8");
      noPrivateCopy(rel, src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""));
      assert.ok(/require\(.*lib\/orbSim.*\)/.test(src),
        `${rel} does not drive scripts/lib/orbSim.js — it has grown a second day loop, which is how the published numbers stop describing the shipped strategy`);
    }
  });

  const PAPER_SRC = fs.readFileSync(path.join(__dirname, "../src/routes/orbPaper.js"), "utf-8");

  // The pool used to be advisory ("entry taken anyway, pool now overdrawn"). It is
  // now a hard gate: an entry the pool cannot fund is refused and skip-logged, so
  // the paper book can never spend money it does not have.
  check("the paper capital gate REFUSES an unfunded entry instead of entering anyway", () => {
    const i = PAPER_SRC.indexOf("capitalPool.gate(MODE");   // MODE = "orb" on NIFTY
    assert.ok(i >= 0, "orbPaper does not run capitalPool.gate() before entering");
    assert.ok(!/capitalPool\.check\(/.test(PAPER_SRC), "orbPaper still uses the advisory capitalPool.check()");
    assert.ok(!/entry taken anyway/.test(PAPER_SRC), "orbPaper still enters when the pool cannot fund the trade");
    const after = PAPER_SRC.slice(i, i + 900);
    assert.ok(/if \(!_cap\.ok\) \{[\s\S]*?gate: "capital"[\s\S]*?return;\s*\}/.test(after),
      "a refused capital gate must skip-log the signal and return without a position");
  });

  // The backtest cannot see an option chain, so premium / spread / OI gates simply do
  // not run there. That is fine — silently NOT SAYING SO is not. The OI gate ships
  // enabled, so the backtest reports more trades than paper will ever take.
  check("the backtest discloses whichever paper/live-only gates are actually enabled", () => {
    const { _paperOnlyGates } = require("../src/routes/orbBacktest");
    const snap = { OI_FILTER_ENABLED: process.env.OI_FILTER_ENABLED, ORB_OI_ENABLED: process.env.ORB_OI_ENABLED, ORB_VIX_ENABLED: process.env.ORB_VIX_ENABLED };
    try {
      process.env.OI_FILTER_ENABLED = "true"; process.env.ORB_OI_ENABLED = "true"; process.env.ORB_VIX_ENABLED = "true";
      const on = _paperOnlyGates().join(" | ");
      assert.ok(/OI buildup/.test(on), `OI gate enabled but not disclosed: ${on}`);
      assert.ok(/VIX/.test(on),        `VIX gate enabled but not disclosed: ${on}`);

      process.env.OI_FILTER_ENABLED = "false"; process.env.ORB_OI_ENABLED = "false"; process.env.ORB_VIX_ENABLED = "false";
      const off = _paperOnlyGates().join(" | ");
      assert.ok(!/OI buildup/.test(off), `OI gate disabled but still claimed: ${off}`);
      assert.ok(!/VIX/.test(off),        `VIX gate disabled but still claimed: ${off}`);
    } finally {
      for (const [k, v] of Object.entries(snap)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    // the old hard-coded sentence named only premium/spread and could not go stale-proof
    const src = fs.readFileSync(path.join(__dirname, "../src/routes/orbBacktest.js"), "utf-8");
    assert.ok(!/premium\/spread gates apply in paper\/live only/.test(src),
      "the hard-coded gate disclosure is back — it cannot track a toggle being flipped");
  });

  // Both were live dials that could not change any automated trade: one only moved a
  // chart line on manual entries, the other appeared in no .env/Settings/doc yet
  // silently overrode the live dashboard's starting capital.
  check("removed phantom config keys stay removed", () => {
    for (const rel of ["../src/routes/orbPaper.js", "../src/strategies/orb_breakout.js"]) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf-8");
      assert.ok(!/process\.env\.ORB_TARGET_RANGE_MULT/.test(src), `${rel} resurrected ORB_TARGET_RANGE_MULT`);
      assert.ok(!/process\.env\.ORB_LIVE_CAPITAL/.test(src),      `${rel} resurrected ORB_LIVE_CAPITAL`);
    }
    const strat = require("../src/strategies/orb_breakout");
    assert.strictEqual(typeof strat.TARGET_OR_MULT, "number", "the strategy must own the target multiplier the routes draw");
  });

  // ── 2026-11-08: an RSI/SuperTrend block spends that breakout, not the day ──
  console.log("\nGate-blocked confirmation");
  check("RSI blocks the first confirmation → the next breakout is hunted and can enter", () => {
    const keys = ["ORB_ENTRY_START","ORB_RETEST_MAX_WAIT","ORB_ST_ENABLED","ORB_RSI_ENABLED","ORB_RSI_CE_MIN",
      "ORB_BODY_ATR_MULT","ORB_OR_ATR_MAX","ORB_GAP_OR_MULT","ORB_BUFFER_MIN_PTS","ORB_CONFIRM_MODE","ORB_BREAKOUT_RESCAN"];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    Object.assign(process.env, { ORB_ENTRY_START: "09:30", ORB_RETEST_MAX_WAIT: "0", ORB_ST_ENABLED: "false",
      ORB_RSI_ENABLED: "true", ORB_RSI_CE_MIN: "82", ORB_BODY_ATR_MULT: "0", ORB_OR_ATR_MAX: "0", ORB_GAP_OR_MULT: "0",
      ORB_BUFFER_MIN_PTS: "5", ORB_CONFIRM_MODE: "close", ORB_BREAKOUT_RESCAN: "true" });
    try {
      const base = Math.floor(Date.UTC(2026, 2, 2, 3, 45) / 1000);   // 09:15 IST
      const bars = [];
      for (let d = 0; d < 3; d++) { let px = 24000; for (let i = 0; i < 75; i++) {
        const o = px, c = px + (i % 2 ? 3 : -3);
        bars.push({ time: base + d * 86400 + i * 300, open: o, high: Math.max(o, c) + 5, low: Math.min(o, c) - 5, close: c, volume: 1 }); px = c; } }
      const t0 = base + 3 * 86400;
      const mk = (i, o, c) => ({ time: t0 + i * 300, open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c, volume: 1 });
      for (let i = 0; i < 3; i++) bars.push({ time: t0 + i * 300, open: 24000, high: 24010, low: 23990, close: 24002, volume: 1 });
      bars.push(mk(3, 24005, 24030), mk(4, 24030, 24045), mk(5, 24045, 24060));
      const n = bars.length;
      const atConfirm = S.getSignal(bars.slice(0, n - 1), { silent: true });   // 09:35 confirm, RSI ~79.6 < 82
      assert.strictEqual(atConfirm.signal, "NONE");
      assert.ok(/RSI gate blocked/.test(atConfirm.reason), atConfirm.reason);
      const next = S.getSignal(bars, { silent: true });                         // 09:40: fresh breakout confirmed, RSI ~83
      assert.strictEqual(next.signal, "BUY_CE", next.reason);
      assert.ok(!/already confirmed/.test(next.reason), next.reason);
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error("SUITE ERROR:", err); process.exit(1); });

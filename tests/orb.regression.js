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
 * The stop-risk assertions are the important ones: they guard CAPITAL, not P&L.
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
  ORB_SL_ATR_MULT:           "1.5",
  ORB_MAX_TRADE_LOSS:        "1500",
  ORB_DEBUG_TRACE:           "false",
  NIFTY_LOT_SIZE:            "65",
  LOT_MULTIPLIER:            "1",
});

const S    = require("../src/strategies/orb_breakout");
const RISK = require("../src/utils/orbStopRisk");

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
      const sig = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true, alreadyTraded: false });
      out.push({ bar: c, sig });
    }
  }
  return out;
}
const ALL_SIGS = allSignals();
const ENTRIES  = ALL_SIGS.filter(x => x.sig.signal !== "NONE");

(async () => {
  console.log(`\nORB regression suite — ${CANDLES.length} candles / ${DAYS.length} sessions, ${ENTRIES.length} entry signals\n`);

  // ── Stop ↔ risk-budget reconciliation (CAPITAL SAFETY) ───────────────────
  console.log("Stop / risk-budget reconciliation");

  check("a stop wider than the rupee budget is CLAMPED to the budget", () => {
    const r = RISK.resolveInitialStop({ side: "CE", entrySpot: 24000, strategyStop: 23900, qty: 65 });
    assert.ok(r.clamped, "expected clamped=true for a 100pt stop on a 1500 INR budget");
    assert.ok(r.slSpot > 23900, "clamped stop must be TIGHTER (higher for CE) than requested");
    const impliedLoss = (24000 - r.slSpot) * RISK.ASSUMED_DELTA * 65;
    assert.ok(impliedLoss <= 1500 + 1, `clamped stop still risks ${impliedLoss.toFixed(0)} INR > 1500`);
  });

  check("a stop already inside the budget is left untouched", () => {
    const r = RISK.resolveInitialStop({ side: "CE", entrySpot: 24000, strategyStop: 23985, qty: 65 });
    assert.strictEqual(r.clamped, false);
    assert.strictEqual(r.slSpot, 23985);
  });

  check("PE clamps on the correct side (stop ABOVE entry, and tightened downward)", () => {
    const r = RISK.resolveInitialStop({ side: "PE", entrySpot: 24000, strategyStop: 24100, qty: 65 });
    assert.ok(r.clamped);
    assert.ok(r.slSpot > 24000, "PE stop must sit above entry");
    assert.ok(r.slSpot < 24100, "PE stop must be tightened downward");
    const impliedLoss = (r.slSpot - 24000) * RISK.ASSUMED_DELTA * 65;
    assert.ok(impliedLoss <= 1500 + 1, `clamped PE stop risks ${impliedLoss.toFixed(0)} INR > 1500`);
  });

  check("clamped risk NEVER exceeds the budget, across qty and stop width", () => {
    for (const qty of [65, 130, 195]) {
      for (const width of [5, 20, 39, 80, 250]) {
        for (const side of ["CE", "PE"]) {
          const entry = 24000;
          const proposed = side === "CE" ? entry - width : entry + width;
          const r = RISK.resolveInitialStop({ side, entrySpot: entry, strategyStop: proposed, qty });
          const risk = Math.abs(entry - r.slSpot) * RISK.ASSUMED_DELTA * qty;
          assert.ok(risk <= 1500 + 1, `qty=${qty} width=${width} ${side}: risk ${risk.toFixed(0)} > 1500`);
        }
      }
    }
  });

  check("ORB_MAX_TRADE_LOSS=0 disables the clamp (opt-out honoured)", () => {
    const prev = process.env.ORB_MAX_TRADE_LOSS;
    process.env.ORB_MAX_TRADE_LOSS = "0";
    try {
      const r = RISK.resolveInitialStop({ side: "CE", entrySpot: 24000, strategyStop: 23800, qty: 65 });
      assert.strictEqual(r.clamped, false);
      assert.strictEqual(r.slSpot, 23800);
    } finally { process.env.ORB_MAX_TRADE_LOSS = prev; }
  });

  check("a null/garbage strategy stop falls back rather than producing NaN", () => {
    for (const bad of [null, undefined, NaN, "abc"]) {
      const r = RISK.resolveInitialStop({ side: "CE", entrySpot: 24000, strategyStop: bad, qty: 65, fallbackStop: 23950 });
      assert.ok(Number.isFinite(r.slSpot), `slSpot not finite for strategyStop=${String(bad)}`);
    }
    const noFallback = RISK.resolveInitialStop({ side: "CE", entrySpot: 24000, strategyStop: null, qty: 65 });
    assert.ok(Number.isFinite(noFallback.slSpot), "slSpot not finite with no fallback either");
  });

  check("the clamp note names the binding constraint (operator must not be misled)", () => {
    const wide = RISK.resolveInitialStop({ side: "CE", entrySpot: 24000, strategyStop: 23900, qty: 65 });
    assert.ok(/ORB_MAX_TRADE_LOSS/.test(wide.note), "clamped note must tell the operator which knob to change");
    const tight = RISK.resolveInitialStop({ side: "CE", entrySpot: 24000, strategyStop: 23990, qty: 65 });
    assert.ok(/spot SL binds/.test(tight.note), "un-clamped note must say the spot SL binds");
  });

  // ── Engine invariants ────────────────────────────────────────────────────
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

  check("alreadyTraded=true always blocks (the 1-trade/day guard)", () => {
    for (const d of DAYS) {
      for (const c of CANDLES.filter(x => DAY(x.time) === d)) {
        const gi = IDX.get(c.time);
        const sig = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true, alreadyTraded: true });
        assert.strictEqual(sig.signal, "NONE", "entered despite alreadyTraded");
      }
    }
  });

  // ── Re-entry after a stop-out (ORB_REENTRY_AFTER_SL) ──────────────────────
  // Guards the two halves separately: the BUDGET helper (which exits qualify) and
  // the ENGINE's re-arm (that a re-entry needs a genuinely fresh breakout candle).

  check("reentryPlan is a no-op while ORB_REENTRY_AFTER_SL is off", () => {
    const prev = process.env.ORB_REENTRY_AFTER_SL;
    delete process.env.ORB_REENTRY_AFTER_SL;
    try {
      const p = S.reentryPlan([{ reason: "Hard SL hit (24500)", atUnixSec: 1000 }], 1);
      assert.strictEqual(p.maxTrades, 1, "budget grew with the key off");
      assert.strictEqual(p.rearmAfterTime, null, "re-armed with the key off");
    } finally { if (prev === undefined) delete process.env.ORB_REENTRY_AFTER_SL; else process.env.ORB_REENTRY_AFTER_SL = prev; }
  });

  check("only a STOP-OUT buys a re-entry — a trail/EOD exit never does", () => {
    const prev = process.env.ORB_REENTRY_AFTER_SL;
    process.env.ORB_REENTRY_AFTER_SL = "1";
    try {
      for (const reason of ["Hard SL hit (24500)", "Max trade loss (₹1500)", "Premium disaster stop (−35%)"]) {
        const p = S.reentryPlan([{ reason, atUnixSec: 1000 }], 1);
        assert.strictEqual(p.maxTrades, 2, `stop-out "${reason}" did not extend the budget`);
        assert.strictEqual(p.rearmAfterTime, 1000, `stop-out "${reason}" did not re-arm`);
      }
      for (const reason of ["Closed below EMA20 (24437.55 < 24437.87)", "EOD square-off (15:15)", "Strong opposite candle (red body 30pt ≥ 20pt, closed below ORH)"]) {
        const p = S.reentryPlan([{ reason, atUnixSec: 1000 }], 1);
        assert.strictEqual(p.maxTrades, 1, `non-stop exit "${reason}" extended the budget`);
        assert.strictEqual(p.rearmAfterTime, null, `non-stop exit "${reason}" re-armed`);
      }
    } finally { if (prev === undefined) delete process.env.ORB_REENTRY_AFTER_SL; else process.env.ORB_REENTRY_AFTER_SL = prev; }
  });

  check("re-entries are capped, and a trail exit AFTER a stop stops the re-arm", () => {
    const prev = process.env.ORB_REENTRY_AFTER_SL;
    process.env.ORB_REENTRY_AFTER_SL = "1";
    try {
      const two = S.reentryPlan([
        { reason: "Hard SL hit (24500)", atUnixSec: 1000 },
        { reason: "Hard SL hit (24480)", atUnixSec: 2000 },
      ], 1);
      assert.strictEqual(two.maxTrades, 2, "two stop-outs bought more than the cap allows");
      const trailed = S.reentryPlan([
        { reason: "Hard SL hit (24500)", atUnixSec: 1000 },
        { reason: "Closed below EMA20 (1 < 2)", atUnixSec: 2000 },
      ], 1);
      assert.strictEqual(trailed.rearmAfterTime, null, "re-armed after the move had already ended on the trail");
    } finally { if (prev === undefined) delete process.env.ORB_REENTRY_AFTER_SL; else process.env.ORB_REENTRY_AFTER_SL = prev; }
  });

  check("rearmAfterTime makes every candle up to the stop invisible to the hunt", () => {
    // For each real entry, re-run the SAME bar with the hunt re-armed past that bar.
    // The breakout that produced it is then out of scope, so the engine must either
    // find a genuinely later breakout or return NONE — it may never re-report the
    // same entry, which is what "re-buying the bar that just stopped us" would be.
    let checked = 0;
    for (const { bar, sig } of ENTRIES) {
      const gi = IDX.get(bar.time);
      const win = CANDLES.slice(Math.max(0, gi - 199), gi + 1);
      const re = S.getSignal(win, { silent: true, alreadyTraded: false, rearmAfterTime: bar.time });
      assert.strictEqual(re.signal, "NONE", `re-entered on the very bar the stop was hit (${MIN(bar.time)} min IST)`);
      assert.notStrictEqual(re.reason, sig.reason, "re-armed run reproduced the original entry reason");
      checked++;
    }
    assert.ok(checked > 0, "no entries in the fixture to test the re-arm against");
  });

  check("ORB_ENTRY_START defaults to the OR freeze — no behaviour change", () => {
    const prev = process.env.ORB_ENTRY_START;
    delete process.env.ORB_ENTRY_START;
    try {
      for (const { bar, sig } of ALL_SIGS) {
        const gi = IDX.get(bar.time);
        const again = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true, alreadyTraded: false });
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
          const sig = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true, alreadyTraded: false });
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
          const sig = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true, alreadyTraded: false });
          if (sig.signal !== "NONE") assert.ok(MIN(c.time) >= 570, `entered at ${MIN(c.time)} min IST, before the opening range froze`);
        }
      }
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
      const truncated = S.getSignal(CANDLES.slice(Math.max(0, gi - 199), gi + 1), { silent: true, alreadyTraded: false });
      assert.strictEqual(truncated.signal, sig.signal, "signal changed when future candles were withheld");
      assert.strictEqual(truncated.slSpot, sig.slSpot, "slSpot changed when future candles were withheld");
    }
  });

  check("entry is always the decision candle's CLOSE (never intrabar)", () => {
    for (const { bar, sig } of ENTRIES) {
      assert.strictEqual(sig.entrySpot, Math.round(bar.close * 100) / 100, "entrySpot is not the bar close");
    }
  });

  check("stop is on the correct side of entry, and non-zero", () => {
    for (const { sig } of ENTRIES) {
      if (sig.side === "CE") assert.ok(sig.slSpot < sig.entrySpot, `CE stop ${sig.slSpot} not below entry ${sig.entrySpot}`);
      else                   assert.ok(sig.slSpot > sig.entrySpot, `PE stop ${sig.slSpot} not above entry ${sig.entrySpot}`);
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

  check("both routes actually WRITE the funnel to the skip log", () => {
    for (const f of ["orbPaper.js", "orbLive.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "../src/routes", f), "utf-8");
      const m = src.match(/appendSkipLog\("orb",\s*\{\s*gate:\s*"signal_none"[^}]*\}/);
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
  const BT_TRADES = BT(CANDLES, null);

  check("the backtest actually runs and produces well-formed records", () => {
    assert.ok(Array.isArray(BT_TRADES), "runOrbBacktest did not return an array");
    for (const t of BT_TRADES) {
      for (const [k, v] of Object.entries(t)) {
        assert.ok(v !== undefined, `field ${k} is undefined`);
        assert.ok(!(typeof v === "number" && !isFinite(v)), `field ${k} is not finite`);
      }
    }
  });

  check("no backtest trade loses materially more than the per-trade budget", () => {
    // The cap is enforced on GROSS premium movement; the booked pnl additionally
    // carries the slippage haircut and charges, so allow exactly that overlay.
    const cap   = parseFloat(process.env.ORB_MAX_TRADE_LOSS || "1500");
    const qty   = parseInt(process.env.NIFTY_LOT_SIZE || "65", 10) * parseInt(process.env.LOT_MULTIPLIER || "1", 10);
    const slip  = parseFloat(process.env.ORB_BT_SLIPPAGE_PTS || "1.5") * 2 * qty;
    const allow = cap + slip + 150;   // 150 INR headroom for brokerage + taxes
    for (const t of BT_TRADES) {
      assert.ok(t.pnl >= -allow,
        `${t.entry} ${t.side} lost ${Math.round(t.pnl)} INR, beyond the ${Math.round(allow)} INR budget+costs allowance`);
    }
  });

  check("the rupee cap fills at the level it trips, not at the bar extreme", () => {
    // Regression: the cap used to book at the candle's worst price, overshooting the
    // budget by ~37% (a -2052 INR fill on a 1500 INR cap). It must fill at the spot
    // level the threshold implies.
    const src = fs.readFileSync(path.join(__dirname, "../src/routes/orbBacktest.js"), "utf-8");
    const m = src.match(/_hitLoss \|\| _hitPrem[\s\S]{0,900}?closePos\(position,\s*([^,]+),/);
    assert.ok(m, "could not locate the cap exit");
    assert.ok(!/c\.(low|high)\s*,\s*c\.time/.test(m[0]),
      "cap exit still books at the bar extreme — it will overshoot the risk budget");
    assert.ok(/_fill/.test(m[1]), `cap exit fills with ${m[1].trim()}, expected the computed threshold level`);
  });

  // ── Mode parity ──────────────────────────────────────────────────────────
  console.log("\nMode parity");

  check("paper, live and backtest all resolve the stop through orbStopRisk", () => {
    for (const f of ["orbPaper.js", "orbLive.js", "orbBacktest.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "../src/routes", f), "utf-8");
      assert.ok(/orbStopRisk\.resolveInitialStop/.test(src), `${f} does not reconcile the stop — it will drift from the others`);
      assert.ok(!/_brk\s*\?\s*_brk\.low/.test(src), `${f} still recomputes its own stop`);
    }
  });

  check("paper AND live both persist a position for crash recovery", () => {
    for (const f of ["orbPaper.js", "orbLive.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "../src/routes", f), "utf-8");
      assert.ok(/saveOrbPosition/.test(src),  `${f} never persists — a restart mid-trade leaves an untracked position`);
      assert.ok(/clearOrbPosition/.test(src), `${f} never clears the snapshot — stale orphan warnings on every boot`);
    }
  });

  check("both entry paths guard the await window against a duplicate entry", () => {
    for (const f of ["orbPaper.js", "orbLive.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "../src/routes", f), "utf-8");
      assert.ok(/_entryInFlight/.test(src), `${f} has no in-flight guard — two candle closes could open two positions`);
      assert.ok(/_entryInFlight\s*=\s*false/.test(src), `${f} never releases the in-flight guard`);
    }
  });

  // Paper's real timeline is: every TICK runs _checkExits (rupee cap → premium stop
  // → hard SL); the candle CLOSE then runs _managePositionOnClose (opposite candle →
  // breakeven → EMA trail). Offline engines see only OHLC, so they must evaluate the
  // intrabar group FIRST — otherwise a close-based rule books the candle's close on a
  // bar where paper was already stopped out minutes earlier.
  check("offline engines check intrabar exits BEFORE close-based exits (paper's order)", () => {
    // The close-based group now lives behind ONE call (orbExits.evaluateCloseExits),
    // so the ordering invariant is: the intrabar hard-SL check must appear before it.
    const targets = [
      ["../src/routes/orbBacktest.js", /Hard SL hit/],
      // The offline day loop moved out of orbValidate into scripts/lib/orbSim.js
      // (2026-08-11) so orbValidate and orbSweep share one simulation. The
      // invariant did not move — it just lives in the file that now runs it.
      ["../scripts/lib/orbSim.js",     /isHardSlHit/],
    ];
    for (const [rel, slRe] of targets) {
      // Strip comments first — this is an assertion about the order of EXECUTION,
      // and prose that merely mentions a rule must not be able to fail (or pass) it.
      const src = fs.readFileSync(path.join(__dirname, rel), "utf-8")
        .replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const sl = src.search(slRe), close = src.search(/evaluateCloseExits/);
      assert.ok(sl >= 0, `${rel}: no intrabar hard-SL check found`);
      assert.ok(close >= 0, `${rel}: does not delegate to orbExits.evaluateCloseExits — it has grown its own copy of the close-based rules again`);
      assert.ok(sl < close, `${rel}: close-based exits are evaluated before the hard SL — they can book a close on a bar paper had already stopped out`);
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
    const CONSUMERS = ["../src/routes/orbPaper.js", "../src/routes/orbLive.js", "../scripts/lib/orbSim.js"];
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

  // The validation script produces the number quoted in the strategy header, so its
  // exit model is not allowed to be gentler than the paper route it stands in for.
  // Asserted BEHAVIOURALLY against the shared engine rather than by grepping text.
  check("the shared exit engine really runs paper's rules, not a friendlier subset", () => {
    const orbExits = require("../src/strategies/orbExits");
    const snap = { opp: process.env.ORB_OPP_CANDLE_EXIT, mult: process.env.ORB_OPP_CANDLE_BODY_MULT,
                   be: process.env.ORB_BREAKEVEN_PTS, beOr: process.env.ORB_BREAKEVEN_OR_MULT };
    try {
      process.env.ORB_OPP_CANDLE_EXIT = "true";
      process.env.ORB_OPP_CANDLE_BODY_MULT = "0.3";
      process.env.ORB_BREAKEVEN_PTS = "20";
      process.env.ORB_BREAKEVEN_OR_MULT = "0";

      // 1. the opposite-candle exit fires (orbValidate once omitted it entirely,
      //    which made every trade it "saved" fictional)
      const p1 = { side: "CE", entrySpot: 24000, slSpot: 23960, orh: 24010, orl: 23950,
                   rangePts: 60, breakevenArmed: false, emaArmed: false };
      const r1 = orbExits.evaluateCloseExits(p1, { open: 24005, close: 23980, high: 24006, low: 23979 }, []);
      assert.ok(r1.exit && /opposite candle/i.test(r1.reason),
        "the opposite-candle exit no longer fires at its documented default");

      // 2. breakeven arms off the CLOSE, never the intrabar extreme. Arming off the
      //    high turns any trade that merely TOUCHED the trigger into a scratch and
      //    flatters every loser in the published statistics.
      const p2 = { side: "CE", entrySpot: 24000, slSpot: 23960, orh: 24010, orl: 23950,
                   rangePts: 60, breakevenArmed: false, emaArmed: false };
      // high is +40 (past the 20pt trigger) but the CLOSE is only +5 → must NOT arm
      orbExits.evaluateCloseExits(p2, { open: 24000, close: 24005, high: 24040, low: 23999 }, []);
      assert.strictEqual(p2.breakevenArmed, false, "breakeven armed off the intrabar high, not the close");
      assert.strictEqual(p2.slSpot, 23960, "the stop moved even though breakeven never armed");
      // now the close itself clears the trigger → must arm, and lift the stop to entry
      const r3 = orbExits.evaluateCloseExits(p2, { open: 24005, close: 24025, high: 24030, low: 24004 }, []);
      assert.ok(r3.breakevenArmed, "breakeven did not arm on a close past the trigger");
      assert.strictEqual(p2.slSpot, 24000, "breakeven did not lift the stop to entry");
    } finally {
      process.env.ORB_OPP_CANDLE_EXIT = snap.opp; process.env.ORB_OPP_CANDLE_BODY_MULT = snap.mult;
      process.env.ORB_BREAKEVEN_PTS = snap.be;    process.env.ORB_BREAKEVEN_OR_MULT = snap.beOr;
    }
  });

  // ── Paper ↔ Live parity ──────────────────────────────────────────────────
  // Paper is canonical. Every one of these pinned an actual defect found on
  // 2026-07-26, when live was a hand-written mirror of paper end to end.
  // Since 2026-08-04 the EXIT rules are shared (src/strategies/orbExits.js) and are
  // guarded by the anti-duplication check above — but live's ENTRY path, its gate
  // ORDER, its skip-log surface and its session teardown are still written out by
  // hand in both files, so these assertions remain load-bearing.
  const PAPER_SRC = fs.readFileSync(path.join(__dirname, "../src/routes/orbPaper.js"), "utf-8");
  const LIVE_SRC  = fs.readFileSync(path.join(__dirname, "../src/routes/orbLive.js"),  "utf-8");
  const onCandleCloseOf = (src) => {
    const i = src.indexOf("async function onCandleClose");
    assert.ok(i >= 0, "onCandleClose not found");
    return src.slice(i, src.indexOf("\n}", i));
  };
  // Order of the entry gates, as they appear in the source. Same list, same order.
  const gateSeq = (body) => {
    const seen = [];
    const re = /maxTrades\b|maxLoss\b|checkPortfolioCap|getThrottle|_expiryDayBlocked|getSignal|ORB_VIX_ENABLED|getOiEnabled/g;
    let m;
    while ((m = re.exec(body))) if (seen[seen.length - 1] !== m[0]) { if (!seen.includes(m[0])) seen.push(m[0]); }
    return seen;
  };

  check("paper and live run the SAME entry gates in the SAME order", () => {
    const p = gateSeq(onCandleCloseOf(PAPER_SRC));
    const l = gateSeq(onCandleCloseOf(LIVE_SRC));
    assert.deepStrictEqual(l, p, `live gate order ${JSON.stringify(l)} != paper ${JSON.stringify(p)}`);
    // spot-check the two that were actually wrong: the portfolio cap was missing
    // from live entirely, and max-trades/daily-loss were swapped.
    assert.ok(p.includes("checkPortfolioCap"), "paper lost the portfolio cap");
    assert.ok(p.indexOf("maxTrades") < p.indexOf("maxLoss"), "paper's documented order is max-trades before daily-loss");
  });

  check("paper and live record the same set of skip-log gates", () => {
    const gates = (src) => [...new Set((src.match(/gate: "[a-z_]+"/g) || []))].sort();
    assert.deepStrictEqual(gates(LIVE_SRC), gates(PAPER_SRC),
      "a rejection reason is recorded by one mode and not the other — the day files disagree on why no trade was taken");
  });

  // Paper's simulateSell is synchronous, so its stopSession bookkeeping always sees
  // the final trade. Live's exit is a broker round-trip; firing it un-awaited let
  // saveData()/recordDay()/notifyDayReport() run on a session missing its last trade
  // (and skip the save entirely when it was the day's only trade).
  check("live stopSession awaits the broker exit BEFORE it saves the session", () => {
    const i = LIVE_SRC.indexOf("async function stopSession");
    assert.ok(i >= 0, "live stopSession is not async — it cannot await the exit");
    const body = LIVE_SRC.slice(i, LIVE_SRC.indexOf("\n}", i));
    const sell = body.search(/await\s+(awaitExit\(\s*)?placeLiveSell\(/);
    const save = body.indexOf("saveData(");
    const rec  = body.indexOf("orbRiskState.recordDay");
    assert.ok(sell >= 0, "live stopSession does not await the exit");
    assert.ok(save >= 0 && sell < save, "live saves the session before the exit completes");
    assert.ok(rec  >= 0 && sell < rec,  "live records the risk-breaker day before the exit completes");
  });

  check("every caller of live stopSession observes its promise", () => {
    // Strip comment lines first — prose that merely mentions stopSession() is not a call.
    const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const [file, raw] of [["orbLive.js", LIVE_SRC], ["app.js", fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf-8")]]) {
      const src = decomment(raw);
      const re = /stopSession\(\)/g;
      let m;
      while ((m = re.exec(src))) {
        const ctx = src.slice(Math.max(0, m.index - 30), m.index + 40);
        if (/function stopSession/.test(ctx)) continue;          // the declaration itself
        assert.ok(/await\s+(?:route\.)?stopSession\(\)|stopSession\(\)\s*\.(catch|then)/.test(ctx),
          `${file}: stopSession() called without await/.catch — "${ctx.replace(/\s+/g, " ").trim()}" — a rejected broker exit would vanish`);
      }
    }
  });

  check("paper and live both re-persist the position when breakeven lifts the stop", () => {
    // The rule now lives in orbExits, which reports `breakevenArmed` on the ONE candle
    // that arms it. Both routes must act on that flag by re-snapshotting, else a crash
    // recovers the pre-breakeven stop.
    for (const [name, src] of [["paper", PAPER_SRC], ["live", LIVE_SRC]]) {
      const i = src.search(/if \(d\.breakevenArmed\)/);
      assert.ok(i >= 0, `${name}: no handler for the shared engine's breakevenArmed signal`);
      const block = src.slice(i, i + 500);
      assert.ok(/saveOrbPosition/.test(block),
        `${name} does not re-snapshot on breakeven — a crash would recover the pre-breakeven stop`);
    }
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
    for (const rel of ["../src/routes/orbPaper.js", "../src/routes/orbLive.js", "../src/strategies/orb_breakout.js"]) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf-8");
      assert.ok(!/process\.env\.ORB_TARGET_RANGE_MULT/.test(src), `${rel} resurrected ORB_TARGET_RANGE_MULT`);
      assert.ok(!/process\.env\.ORB_LIVE_CAPITAL/.test(src),      `${rel} resurrected ORB_LIVE_CAPITAL`);
    }
    const strat = require("../src/strategies/orb_breakout");
    assert.strictEqual(typeof strat.TARGET_OR_MULT, "number", "the strategy must own the target multiplier the routes draw");
  });

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error("SUITE ERROR:", err); process.exit(1); });

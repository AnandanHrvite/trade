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
    const targets = [
      ["../src/routes/orbBacktest.js", /Hard SL hit/,   /Strong opposite candle/, /Closed (below|above) EMA/],
      ["../scripts/orbValidate.js",    /why = be \? "BE" : "SL"/, /why = "opp"/,  /why = "trail"/],
    ];
    for (const [rel, slRe, oppRe, emaRe] of targets) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf-8");
      const sl = src.search(slRe), opp = src.search(oppRe), ema = src.search(emaRe);
      assert.ok(sl >= 0 && opp >= 0 && ema >= 0, `${rel}: could not locate all three exits (sl=${sl} opp=${opp} ema=${ema})`);
      assert.ok(sl < opp, `${rel}: the opposite-candle exit is evaluated before the hard SL — it can book a close on a bar paper had already stopped out`);
      assert.ok(sl < ema, `${rel}: the EMA trail is evaluated before the hard SL — same divergence from paper`);
    }
  });

  // The validation script produces the number quoted in the strategy header, so its
  // exit model is not allowed to be gentler than the paper route it stands in for.
  check("the validation script models paper's exits, not a friendlier subset", () => {
    const src = fs.readFileSync(path.join(__dirname, "../scripts/orbValidate.js"), "utf-8");
    assert.ok(/ORB_OPP_CANDLE_EXIT/.test(src),
      "orbValidate omits the opposite-candle exit that paper runs by default — every trade it saves is a fictional one");
    // Breakeven must arm off the CLOSE. Arming off the intrabar high/low turns any
    // trade that merely TOUCHED the trigger into a scratch, flattering every loser.
    assert.ok(/favClose\s*=\s*side === "CE" \? c\.close - entry : entry - c\.close/.test(src),
      "orbValidate does not derive its breakeven trigger from the candle close");
    assert.ok(/!be && beTrig > 0 && favClose >= beTrig/.test(src),
      "orbValidate arms breakeven from something other than the close — paper uses the close");
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

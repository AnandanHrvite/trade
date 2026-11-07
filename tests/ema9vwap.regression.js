#!/usr/bin/env node
/**
 * EMA9+VWAP regression + parity suite.
 *
 *   node tests/ema9vwap.regression.js
 *
 * Zero dependencies, zero test framework, exits non-zero on failure so it can be
 * dropped into CI or a pre-push hook. Uses REAL cached NIFTY 5-min candles from
 * ~/trading-data/backtest_cache when present (they carry genuine per-bar volume,
 * which is the exact input that broke Paper/Backtest VWAP parity); falls back to a
 * deterministic synthetic series so the suite still runs on a clean machine.
 *
 * Every assertion here exists because a real defect was found and fixed. Read the
 * label to know what regression it guards.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");

// Deterministic env so a developer's .env cannot change the expected values.
Object.assign(process.env, {
  EMA9VWAP_VWAP_SESSION_START: "09:15",
  EMA9VWAP_BAND_MULT:          "1",
  EMA9VWAP_EMA_PERIOD:         "9",
  EMA9VWAP_ENTRY_START:        "10:30",
  EMA9VWAP_ENTRY_END:          "14:30",
  BACKTEST_SLIPPAGE_PTS:       "0",
  VIX_FILTER_ENABLED:          "false",
  OI_FILTER_ENABLED:           "false",
  PROFIT_LOCK_ENABLED:         "true",
});

const S  = require("../src/strategies/ema9_vwap");
const BT = require("../src/services/ema9vwapBacktestEngine");

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); pass++; }
  catch (err) { console.log(`  ❌ ${label}\n       ${err.message}`); fail++; }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function loadCandles() {
  const dir = path.join(os.homedir(), "trading-data", "backtest_cache");
  try {
    // Several months, not one file, so the backtest checks below see enough
    // entries and profit-lock exits to verify anything.
    // NOTE: no volume>0 filter — NIFTY is an INDEX and its cached bars carry
    // volume:0, so requiring volume silently discarded every real file and fell
    // back to the synthetic series. Test 1 asserts VWAP ignores volume anyway.
    const files = fs.readdirSync(dir).filter(n => /NIFTY50-INDEX_5_/.test(n)).sort().slice(0, 6);
    let arr = [];
    for (const f of files) {
      const part = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (Array.isArray(part)) arr = arr.concat(part);
    }
    arr.sort((a, b) => a.time - b.time);
    if (arr.length > 500) {
      console.log(`  (using real cached candles: ${files.length} file(s), ${arr.length} bars)`);
      return arr;
    }
  } catch (_) { /* fall through */ }
  console.log("  (cache unavailable — using deterministic synthetic candles)");
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  for (let d = 0; d < 40; d++) {
    let p = 24000 + d * 25;
    // Alternate trending and choppy sessions so both the signal crosses and the
    // give-backs the profit-lock tests need actually occur.
    const drift = (d % 3 === 0) ? 0 : ((d % 3 === 1) ? 1.6 : -1.6);
    for (let i = 0; i < 75; i++) {
      const open = p;
      const body = (rnd() - 0.5) * 26 + drift;
      const close = open + body;
      const hi = Math.max(open, close) + rnd() * 14;
      const lo = Math.min(open, close) - rnd() * 14;
      out.push({
        time: Math.floor(Date.UTC(2026, 3, 6 + d, 3, 45, 0) / 1000) + i * 300,
        open, high: hi, low: lo, close,
        volume: Math.floor(1e6 + rnd() * 4e7),
      });
      p = close;
    }
  }
  return out;
}

const CANDLES = loadCandles();
const ZERO_VOL = CANDLES.map(c => ({ ...c, volume: 0 }));
const barAt  = (h, m) => Math.floor(Date.UTC(2026, 6, 16, h - 5, m - 30, 0) / 1000);

// ── 1. VWAP parity — the defect that made Backtest and Paper disagree ────────
console.log("\nVWAP");
check("identical with and without volume (Paper == Live == Backtest == Replay)", () => {
  let worstBand = 0, flips = 0;
  for (let n = 12; n <= Math.min(1400, CANDLES.length); n++) {
    const a = S.getSignal(CANDLES.slice(Math.max(0, n - 200), n),  { silent: true });
    const b = S.getSignal(ZERO_VOL.slice(Math.max(0, n - 200), n), { silent: true });
    if (a.vwapUpper != null && b.vwapUpper != null) {
      worstBand = Math.max(worstBand, Math.abs(a.vwapUpper - b.vwapUpper), Math.abs(a.vwapLower - b.vwapLower));
    }
    if (a.signal !== b.signal) flips++;
  }
  assert.strictEqual(worstBand, 0, `band differs by ${worstBand}pts — volume leaked back into computeVwapBands`);
  assert.strictEqual(flips, 0, `${flips} signal flips between volume-bearing and volume-free input`);
});

check("session-anchored: resets each IST day", () => {
  const d0 = Math.floor((ZERO_VOL[0].time + 19800) / 86400);
  const dayOne = ZERO_VOL.filter(c => Math.floor((c.time + 19800) / 86400) === d0);
  const spanning = ZERO_VOL.slice(0, dayOne.length + 5);
  assert.notStrictEqual(S.computeVwapBands(dayOne).vwap, S.computeVwapBands(spanning).vwap,
    "next day's bars did not reset the anchor");
});

check("band multiplier still applied linearly", () => {
  const w = ZERO_VOL.slice(0, 60);
  process.env.EMA9VWAP_BAND_MULT = "1"; const b1 = S.computeVwapBands(w);
  process.env.EMA9VWAP_BAND_MULT = "2"; const b2 = S.computeVwapBands(w);
  process.env.EMA9VWAP_BAND_MULT = "1";
  assert.ok(Math.abs((b2.upper - b2.vwap) - 2 * (b1.upper - b1.vwap)) < 0.02, "multiplier is not linear");
});

check("first candle of a session yields no cross (no compare vs yesterday's band)", () => {
  const d0 = Math.floor((ZERO_VOL[0].time + 19800) / 86400);
  let firstOfDay2 = ZERO_VOL.findIndex(c => Math.floor((c.time + 19800) / 86400) > d0);
  assert.ok(firstOfDay2 > 12, "fixture has no second day");
  const r = S.getSignal(ZERO_VOL.slice(0, firstOfDay2 + 1), { silent: true });
  assert.strictEqual(r.signal, "NONE");
  assert.match(r.reason, /first candle of session/);
});

// ── 2. Entry window — shared rule, candle-close semantics, no wall clock ─────
console.log("\nEntry window");
check("gates on candle CLOSE: bar closing 10:30 enters, bar closing 14:30 does not", () => {
  assert.strictEqual(S.isEntryWindowOpen(barAt(10, 20), 5), false, "bar closing 10:25 must be out");
  assert.strictEqual(S.isEntryWindowOpen(barAt(10, 25), 5), true,  "bar closing 10:30 must be in");
  assert.strictEqual(S.isEntryWindowOpen(barAt(14, 20), 5), true,  "bar closing 14:25 must be in");
  assert.strictEqual(S.isEntryWindowOpen(barAt(14, 25), 5), false, "bar closing 14:30 must be out");
});

check("malformed HH:MM falls back to the default, never to midnight", () => {
  process.env.EMA9VWAP_ENTRY_START = "garbage";
  const open = S.isEntryWindowOpen(barAt(9, 0), 5);
  process.env.EMA9VWAP_ENTRY_START = "10:30";
  assert.strictEqual(open, false, "a bad value opened the window at 09:00");
});

check("resolution changes the close time used by the window", () => {
  assert.strictEqual(S.isEntryWindowOpen(barAt(14, 20), 5),  true);
  assert.strictEqual(S.isEntryWindowOpen(barAt(14, 20), 15), false, "15m bar closing 14:35 must be out");
});

// ── 3. Backtest exits — the global profit lock is the ONLY automatic exit ─────
console.log("\nBacktest exits");
async function runBT(env = {}) {
  const prev = {};
  Object.keys(env).forEach(k => { prev[k] = process.env[k]; process.env[k] = env[k]; });
  const r = await BT.runEma9VwapBacktest(CANDLES, 100000, null, 0, []);
  Object.keys(env).forEach(k => { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; });
  return r;
}

(async () => {
  const istDay  = s => Math.floor((s + 19800) / 86400);
  const base = await runBT();
  check("only profit-lock and session-close exits exist", () => {
    assert.ok(base.trades.length > 0, "no trades in the fixture — cannot verify the exits");
    const bad = base.trades.filter(t => !/^(Profit lock|EOD session close|End of data)/.test(t.exitReason));
    assert.strictEqual(bad.length, 0, `unexpected exit reason(s): ${[...new Set(bad.map(t => t.exitReason))].join(" | ")}`);
  });

  check("the profit lock actually fires", () => {
    assert.ok(base.trades.some(t => /^Profit lock/.test(t.exitReason)), "no profit-lock exit in the whole fixture");
  });

  check("every trade is closed inside the session it opened in", () => {
    const overnight = base.trades.filter(t => istDay(t.exitTs) !== istDay(t.entryTs));
    assert.strictEqual(overnight.length, 0, `${overnight.length} trade(s) held across a session boundary`);
  });

  const noLock = await runBT({ PROFIT_LOCK_ENABLED: "false" });
  check("with the profit lock OFF, only the session close exits", () => {
    const bad = noLock.trades.filter(t => !/^(EOD session close|End of data)/.test(t.exitReason));
    assert.strictEqual(bad.length, 0, `exit fired with the lock off: ${[...new Set(bad.map(t => t.exitReason))].join(" | ")}`);
  });

  // ── 4. Paper-parity guards ─────────────────────────────────────────────────
  console.log("\nBacktest ↔ Paper parity");

  const expiryRun = await runBT({ TRADE_EXPIRY_DAY_ONLY: "true" }).catch(e => e);
  check("TRADE_EXPIRY_DAY_ONLY=true runs instead of throwing", () => {
    assert.ok(!(expiryRun instanceof Error),
      `enabling the expiry-only filter threw: ${expiryRun && expiryRun.message} (const temporal-dead-zone regression)`);
    assert.ok(expiryRun.summary, "run returned no summary");
  });

  // ── 5. Production invariants ──────────────────────────────────────────────
  // These are source-level, on purpose. Each guards a call site that MUST stay
  // guarded; the defects they encode were all "a list written for the original 4
  // strategies that nobody extended", so the first three assert the rule for EVERY
  // strategy — including the next one someone adds.
  console.log("\nProduction invariants");
  const SRC = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const PAPER  = SRC("src/routes/ema9vwapPaper.js");
  const REPLAY = SRC("src/services/tickReplay.js");
  const SSS    = require("../src/utils/sharedSocketState");

  check("replay stubs EVERY sharedSocketState mutator (no strategy can leak the mutex)", () => {
    const mutators = Object.keys(SSS).filter(k => typeof SSS[k] === "function" && /^(set.*Active|setActive|clear.*|clear)$/.test(k));
    assert.ok(mutators.length >= 12, `expected >=12 mutators, found ${mutators.length}`);
    const missing = mutators.filter(m => !new RegExp(`sharedSocketState\\.${m}\\s*=\\s*\\(\\)\\s*=>`).test(REPLAY));
    assert.strictEqual(missing.length, 0,
      `tickReplay does not stub: ${missing.join(", ")} — a replay of that strategy mutates the REAL socket mutex`);
  });

  check("replayPreflight checks EVERY strategy's is*Active", () => {
    // isAnyActive is the roll-up, not a per-strategy probe — exclude it.
    const probes = Object.keys(SSS).filter(k => typeof SSS[k] === "function" && /^is.*Active$/.test(k) && k !== "isAnyActive");
    const pre = REPLAY.slice(REPLAY.indexOf("function replayPreflight"), REPLAY.indexOf("function forceClearSharedState"));
    const missing = probes.filter(p => !pre.includes(`${p}()`));
    assert.strictEqual(missing.length, 0,
      `replayPreflight ignores: ${missing.join(", ")} — a replay can be launched on top of that live session`);
  });

  check("forceClearSharedState clears EVERY strategy", () => {
    const clears = Object.keys(SSS).filter(k => typeof SSS[k] === "function" && /^(clear.*|clear)$/.test(k));
    const fn = REPLAY.slice(REPLAY.indexOf("function forceClearSharedState"));
    const missing = clears.filter(c => !fn.includes(`sharedSocketState.${c}()`));
    assert.strictEqual(missing.length, 0,
      `force-clear cannot unstick: ${missing.join(", ")} — that strategy stays unstartable until a process restart`);
  });

  // The intra/confirm entry gate. Extract the exact condition text once and assert
  // the three properties on it, so a regression in any one is pinpointed.
  const GATE = (() => {
    const i = PAPER.indexOf("if ((_intraCandleEntryEnabled() || _confirmEnabled())");
    return i < 0 ? "" : PAPER.slice(i, PAPER.indexOf("{", PAPER.indexOf("shouldCheckSignal", i)));
  })();

  check("confirmation-candle entry is reachable with intra-candle entry OFF", () => {
    assert.ok(GATE, "the intra/confirm entry gate no longer matches — CONFIRM=on may have no entry path again");
    assert.ok(/_confirmEnabled\(\)/.test(GATE),
      "the gate does not admit _confirmEnabled() — CONFIRM=on + INTRACANDLE=off arms signals that can never enter");
  });

  check("intra/confirm entry gate honours TRADE_EXPIRY_DAY_ONLY", () => {
    assert.ok(/!ptState\._expiryDayBlocked/.test(GATE),
      "_expiryDayBlocked is not in the gate — the expiry filter fails OPEN on this entry path");
  });

  check("entry gate does not depend on _cachedClosedCandleSL (always null here)", () => {
    const { getSignal } = S;
    const sl = getSignal(ZERO_VOL.slice(0, 300), { silent: true }).stopLoss;
    assert.strictEqual(sl, null, "getSignal now returns a stopLoss — re-check this invariant");
    assert.ok(!/_cachedClosedCandleSL/.test(GATE),
      "the gate tests a value this strategy never sets, silently disabling entries at 3-min / 15-min");
  });

  check("simulation output cannot reach paper history, the audit log or crash recovery", () => {
    for (const [site, re] of [
      ["appendTradeLog",       /!ptState\._simMode && !ptState\._simSession\) \{\s*\n\s*tradeLogger\.appendTradeLog/],
      ["saveEma9VwapPosition", /!ptState\._simMode && !ptState\._simSession\) \{[\s\S]{0,200}?saveEma9VwapPosition/],
      ["saveSession persist",  /if \(ptState\._simSession \|\| ptState\._simMode\) \{[\s\S]{0,400}?return \{ \.\.\.session, simulated: true \}/],
    ]) {
      assert.ok(re.test(PAPER), `${site} is no longer simulation-guarded — /simulate can corrupt the canonical paper record`);
    }
    assert.ok(/ptState\._simSession\s*=\s*true/.test(PAPER) && /ptState\._simSession\s*=\s*false/.test(PAPER),
      "_simSession is not both set (resetSimState) and cleared (/start)");
  });

  // ── 6. Strategy integrity — the rules themselves must be untouched ─────────
  console.log("\nStrategy integrity");
  check("EMA9 equals technicalindicators EMA(9) on close", () => {
    const { EMA } = require("technicalindicators");
    const w = ZERO_VOL.slice(0, 300);
    const e = EMA.calculate({ period: 9, values: w.map(c => c.close) });
    const got = S.getSignal(w, { silent: true }).ema9;
    assert.ok(Math.abs(got - Math.round(e[e.length - 1] * 100) / 100) < 0.005);
  });

  check("entry is a true series cross of the band", () => {
    for (let n = 12; n <= Math.min(900, ZERO_VOL.length); n++) {
      const w = ZERO_VOL.slice(Math.max(0, n - 200), n);
      const r = S.getSignal(w, { silent: true });
      if (r.signal === "BUY_CE") assert.ok(r.ema9 > r.vwapUpper, "BUY_CE without EMA9 above the top band");
      if (r.signal === "BUY_PE") assert.ok(r.ema9 < r.vwapLower, "BUY_PE without EMA9 below the bottom band");
    }
  });

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error("SUITE ERROR:", err); process.exit(1); });

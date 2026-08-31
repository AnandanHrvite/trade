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
    // Several months, not one file: the rare paths below (a points stop winning a
    // bar against the negative-candle stop, a same-side re-entry inside the SL
    // cooldown) simply never occur in ~1,650 bars, and their tests then fail on
    // their own "cannot verify" preconditions rather than on any real defect.
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
    // adverse excursions the stop tests need actually occur.
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
const sigKey = r => [r.signal, r.ema9, r.vwap, r.vwapUpper, r.vwapLower, r.stdev, r.exitCE, r.exitPE].join("|");
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
    if (a.signal !== b.signal || a.exitCE !== b.exitCE || a.exitPE !== b.exitPE) flips++;
  }
  assert.strictEqual(worstBand, 0, `band differs by ${worstBand}pts — volume leaked back into computeVwapBands`);
  assert.strictEqual(flips, 0, `${flips} signal/exit flips between volume-bearing and volume-free input`);
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

// ── 3. Backtest optional stops — each must fire, and at the right price ──────
console.log("\nBacktest optional stops");
async function runBT(env = {}) {
  Object.assign(process.env, env);
  const r = await BT.runEma9VwapBacktest(CANDLES, 100000, null, 0, []);
  Object.keys(env).forEach(k => delete process.env[k]);
  return r;
}

(async () => {
  const base = await runBT();
  check("defaults produce only signal/reversal/EOD exits (no stop leaks in)", () => {
    const bad = base.trades.filter(t => /Trail|SL \(|Option stop|Negative|Time-stop/.test(t.exitReason));
    assert.strictEqual(bad.length, 0, `optional stop fired with all stops OFF: ${bad.map(t => t.exitReason)}`);
  });

  const trail = await runBT({ EMA9VWAP_CANDLE_TRAIL_ENABLED: "true", EMA9VWAP_CANDLE_TRAIL_BARS: "3" });
  check("candle trail does NOT fire on the candle that sets it", () => {
    const share = trail.trades.filter(t => /Trail SL hit/.test(t.exitReason)).length / Math.max(1, trail.trades.length);
    assert.ok(share < 0.95,
      `trail took ${(share * 100).toFixed(0)}% of exits — it is triggering on its own candle again`);
    const sameBar = trail.trades.filter(t => /Trail SL hit/.test(t.exitReason) && t.candlesHeld <= 1).length;
    assert.strictEqual(sameBar, 0, `${sameBar} trail exits on candlesHeld<=1 — the set-and-test order regressed`);
  });

  const sl = await runBT({ EMA9VWAP_STOP_LOSS_PTS: "25" });
  check("points stop books the STOP LEVEL, not the candle close", () => {
    const hits = sl.trades.filter(t => /^SL \(25pts\)/.test(t.exitReason));
    assert.ok(hits.length > 0, "the 25pt stop never fired — cannot verify its price");
    for (const t of hits) {
      assert.ok(Math.abs(Math.abs(t.spotPnlPts) - 25) < 0.011,
        `stop exit booked ${t.spotPnlPts}pts, expected exactly -25 (candle.close leaked back in)`);
    }
  });

  // Paper runs the protective stops in onTick (intrabar, from the prior close's
  // level) and the time-stop / negative-candle in onCandleClose. So when both would
  // fire on the same bar, the PROTECTIVE stop must win — and must book its own
  // level, not the close. The engine used to check time-stop / negative-candle
  // first, reporting the wrong rule and the wrong price.
  // 10pts, NOT 25: a 25pt adverse move is rarer than "still red after 2 candles",
  // so the negative-candle stop took every bar and the points stop never fired —
  // the test could not distinguish correct precedence from the bug. At 10pts the
  // two rules genuinely contend (verified: reversing their order fails this).
  const both = await runBT({ EMA9VWAP_STOP_LOSS_PTS: "10", EMA9VWAP_NEG_CANDLE_LIMIT: "2" });
  check("protective stops outrank the candle-close stops (paper precedence)", () => {
    const slHits = both.trades.filter(t => /^SL \(10pts\)/.test(t.exitReason));
    assert.ok(slHits.length > 0, "the points stop never won a bar — precedence cannot be verified");
    for (const t of slHits) {
      assert.ok(Math.abs(Math.abs(t.spotPnlPts) - 10) < 0.011,
        `a points-stop exit booked ${t.spotPnlPts}pts — a candle-close rule took the bar first`);
    }
    // The invariant with teeth: a candle-close rule may only win a bar the
    // intrabar points stop did NOT already breach. Paper's points stop fires on
    // that bar's ticks, before onCandleClose ever runs. Checking the exit bar's
    // own adverse excursion proves the ordering directly, with no golden number.
    const byTs = new Map(CANDLES.map(c => [c.time, c]));
    let stolen = 0;
    for (const t of both.trades.filter(x => /^Negative 2-candle stop/.test(x.exitReason))) {
      const c = byTs.get(t.exitTs);
      if (!c) continue;
      const adverse = t.side === "CE" ? (c.low - t.entryPrice) : (t.entryPrice - c.high);
      if (adverse <= -10) stolen++;
    }
    assert.strictEqual(stolen, 0,
      `${stolen} bar(s) went to the negative-candle stop although the 10pt points stop was breached on that same bar — candle-close rules are being evaluated before the intrabar stops`);
  });

  for (const [k, v, label, re] of [
    ["EMA9VWAP_NEG_CANDLE_LIMIT", "3", "negative-candle stop", /Negative 3-candle stop/],
    ["EMA9VWAP_SL_MODE", "candle", "time-stop", /Time-stop/],
  ]) {
    const r = await runBT({ [k]: v });
    check(`${label} fires when enabled`, () => {
      assert.ok(r.trades.some(t => re.test(t.exitReason)), `${label} never fired`);
    });
  }

  // ── 4. Paper-parity guards the backtest used to be missing ────────────────
  console.log("\nBacktest ↔ Paper parity");
  const istMins = s => Math.floor((s + 19800) / 60) % 1440;
  const istDay  = s => Math.floor((s + 19800) / 86400);

  const expiryRun = await runBT({ TRADE_EXPIRY_DAY_ONLY: "true" }).catch(e => e);
  check("TRADE_EXPIRY_DAY_ONLY=true runs instead of throwing", () => {
    assert.ok(!(expiryRun instanceof Error),
      `enabling the expiry-only filter threw: ${expiryRun && expiryRun.message} (const temporal-dead-zone regression)`);
    assert.ok(expiryRun.summary, "run returned no summary");
  });

  check("EOD square-off takes the FIRST bar closing at/after the exit time", () => {
    // Paper squares off inside onCandleClose, i.e. when the bar CLOSES, so the exit
    // bar must be the earliest bar of that day whose close reached EMA9VWAP_EOD_EXIT_TIME
    // and which the trade was still open on. Gating on the bar's START instead held
    // the position one extra bar and booked a later price.
    const EOD = 15 * 60 + 15, RES = 5;
    const eods = base.trades.filter(t => /EOD square-off/.test(t.exitReason));
    assert.ok(eods.length > 0, "no EOD exits in the fixture — cannot verify the boundary");
    for (const t of eods) {
      const day = istDay(t.exitTs);
      const earlier = CANDLES.filter(c =>
        istDay(c.time) === day && c.time > t.entryTs && c.time < t.exitTs &&
        istMins(c.time) + RES >= EOD);
      assert.strictEqual(earlier.length, 0,
        `EOD exit at bar closing ${istMins(t.exitTs) + RES}min held past ${earlier.length} earlier bar(s) that already closed at/after the 15:15 cut`);
    }
  });

  // 10pts for the same reason as the precedence test above: at 25pts the stop fired
  // too rarely to block anything, so pause=10 and pause=0 produced identical trade
  // counts and the check proved nothing. (Verified: disabling the cooldown arming
  // in the engine now fails this test.)
  const slPause = await runBT({ EMA9VWAP_STOP_LOSS_PTS: "10", EMA9VWAP_SL_PAUSE_CANDLES: "10" });
  const slNoPause = await runBT({ EMA9VWAP_STOP_LOSS_PTS: "10", EMA9VWAP_SL_PAUSE_CANDLES: "0" });
  check("same-side SL cooldown blocks re-entry on the stopped-out side", () => {
    const RES = 5, N = 10;
    let violations = 0;
    for (let i = 1; i < slPause.trades.length; i++) {
      const t = slPause.trades[i];
      for (let j = 0; j < i; j++) {
        const p = slPause.trades[j];
        if (!/^SL \(10pts\)/.test(p.exitReason)) continue;
        if (p.side !== t.side || istDay(p.exitTs) !== istDay(t.entryTs)) continue;
        if (t.entryTs < p.exitTs + N * RES * 60) violations++;
      }
    }
    assert.strictEqual(violations, 0,
      `${violations} entr(ies) re-took a side inside its ${N}-candle SL cooldown — paper's _setSlPause is not mirrored`);
    assert.notStrictEqual(slPause.trades.length, slNoPause.trades.length,
      "SL_PAUSE_CANDLES=10 and =0 produced the same trade count — the cooldown is inert, so this test proves nothing");
  });

  // CHOP=1 because this fixture's worst day only ever strings 2 losses together and
  // never trades again after the 2nd — a threshold of 2 would be silently inert here.
  const CHOP = 1;
  const chopOn = await runBT({ EMA9VWAP_STOP_LOSS_PTS: "25", EMA9VWAP_MAX_CONSEC_LOSSES: String(CHOP) });
  check("chop guard halts the day after N straight losses", () => {
    const byDay = new Map();
    for (const t of chopOn.trades) {
      const d = istDay(t.entryTs);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(t);
    }
    for (const [d, ts] of byDay) {
      let streak = 0;
      for (let i = 0; i < ts.length; i++) {
        assert.ok(streak < CHOP, `day ${d}: trade ${i + 1} was entered after ${streak} straight losses (chop guard = ${CHOP})`);
        if (ts[i].pnl > 0) streak = 0; else if (ts[i].pnl < 0) streak++;
      }
    }
    // Baseline = same stop config, chop guard off (`sl`), so the only difference is the guard.
    assert.ok(chopOn.trades.length < sl.trades.length,
      "chop guard removed no trades — the guard is inert, so this test proves nothing");
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
  const BTE    = SRC("src/services/ema9vwapBacktestEngine.js");
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

  check("protective stops do not block same-bar re-entry (paper falls through; onTick returns)", () => {
    // Paper's points/option/trail stops return from the TICK handler only — the bar
    // still closes and onCandleClose's entry section runs. Blocking the bar here
    // diverged from paper whenever both cooldowns were off.
    const n = (BTE.match(/armSlPause = true; blocksReentry = false/g) || []).length
            + (BTE.match(/blocksReentry = false;\s+\/\/ onTick exit/g) || []).length;
    assert.strictEqual(n, 3, `expected all 3 protective stops to set blocksReentry=false, found ${n}`);
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

  check("exitCE / exitPE are mutually exclusive with the same-side entry", () => {
    for (let n = 12; n <= Math.min(900, ZERO_VOL.length); n++) {
      const r = S.getSignal(ZERO_VOL.slice(Math.max(0, n - 200), n), { silent: true });
      assert.ok(!(r.signal === "BUY_CE" && r.exitCE), "same candle both entered and exited CE");
      assert.ok(!(r.signal === "BUY_PE" && r.exitPE), "same candle both entered and exited PE");
    }
  });

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error("SUITE ERROR:", err); process.exit(1); });

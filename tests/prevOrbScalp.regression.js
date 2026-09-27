#!/usr/bin/env node
/**
 * PREV_ORB_SCALP — RULE INVARIANTS
 *
 *   node tests/prevOrbScalp.regression.js
 *
 * Zero dependencies, exits non-zero on failure. No socket, no broker, no
 * session. HOME is pointed at a temp dir BEFORE anything is required, so the
 * paper-route exit tests can never write into the real ~/trading-data.
 *
 * The rules (user-confirmed 2026-09-27):
 *   setup  : the 09:15 15-min candle CLOSES below yesterday's LOW (PE) / above
 *            yesterday's HIGH (CE); otherwise no trade that day
 *   entry  : the FIRST 3-min close beyond the 09:15 candle's low (PE) / high (CE),
 *            at that close; entries until 14:30; one trade a day
 *   stop   : break candle's high (PE) / low (CE)
 *   target : break candle size from the entry; then SL → target, trail each
 *            closed candle's high (PE) / low (CE)
 */

process.env.TZ = "Asia/Calcutta";
const os = require("os");
const fs = require("fs");
const path = require("path");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prevorb-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
for (const k of Object.keys(process.env)) if (k.startsWith("PREV_ORB_SCALP_") || k.startsWith("TG_")) delete process.env[k];
process.env.PROFIT_LOCK_ENABLED = "false";

const assert = require("assert");
const strat = require("../src/strategies/prev_orb_scalp");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`✗ ${name}\n    ${e.message}`); }
}

// ── fixtures ────────────────────────────────────────────────────────────────
function ist(date, hh, mm) {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d, hh, mm) - 19800 * 1000) / 1000);
}
/** A full flat 3-min session around `base`, range ±`amp`. */
function session(date, base, amp, res) {
  const r = res || 3;
  const out = [];
  for (let t = 9 * 60 + 15; t < 15 * 60 + 30; t += r) {
    out.push({ time: ist(date, Math.floor(t / 60), t % 60), open: base, high: base + amp, low: base - amp, close: base, volume: 0 });
  }
  return out;
}
function bar(date, hh, mm, o, h, l, c) { return { time: ist(date, hh, mm), open: o, high: h, low: l, close: c, volume: 0 }; }

const YDAY = "2026-03-26", TODAY = "2026-03-27";
// Yesterday: 23000 ± 50 → high 23050, low 22950 (one spike to set clean levels)
function yesterday() {
  const s = session(YDAY, 23000, 20);
  s[40] = { ...s[40], high: 23050 };
  s[80] = { ...s[80], low: 22950 };
  return s;
}
/** Today's 09:15 candle as five 3-min bars; O/H/L/C of the aggregate given. */
function orBars(o, h, l, c) {
  return [
    bar(TODAY, 9, 15, o, h, Math.max(l, Math.min(o, c)), (o + c) / 2),
    bar(TODAY, 9, 18, (o + c) / 2, (o + c) / 2 + 1, (o + c) / 2 - 1, (o + c) / 2),
    bar(TODAY, 9, 21, (o + c) / 2, (o + c) / 2 + 1, l, (o + c) / 2),
    bar(TODAY, 9, 24, (o + c) / 2, (o + c) / 2 + 1, (o + c) / 2 - 1, (o + c) / 2),
    bar(TODAY, 9, 27, (o + c) / 2, (o + c) / 2 + 1, Math.min(c, (o + c) / 2) - 1, c),
  ];
}
// PE day: 09:15 candle O 22980 H 22990 L 22900 C 22920 (close < yday low 22950)
function peDay() { return yesterday().concat(orBars(22980, 22990, 22900, 22920)); }

const cfg0 = () => strat.getConfig();

// ── levels ──────────────────────────────────────────────────────────────────
test("defaults", () => {
  const c = cfg0();
  assert.strictEqual(c.resolutionMins, 3);
  assert.strictEqual(c.orMins, 15);
  assert.strictEqual(c.sessionStartMin, 555);
  assert.strictEqual(c.entryStartMin, 570);
  assert.strictEqual(c.entryEndMin, 870);
  assert.strictEqual(c.forcedExitMin, 915);
  assert.strictEqual(c.trailAfterTarget, true);
});

test("dayLevels: yesterday high/low and 09:15 aggregate", () => {
  const lv = strat.dayLevels(peDay().concat([bar(TODAY, 9, 30, 22920, 22925, 22910, 22915)]));
  assert.strictEqual(lv.prevDay.high, 23050);
  assert.strictEqual(lv.prevDay.low, 22950);
  assert.strictEqual(lv.prevDay.complete, true);
  assert.strictEqual(lv.prevDay.date, YDAY);
  assert.strictEqual(lv.or.complete, true);
  assert.strictEqual(lv.or.open, 22980);
  assert.strictEqual(lv.or.high, 22990);
  assert.strictEqual(lv.or.low, 22900);
  assert.strictEqual(lv.or.close, 22920);
  assert.strictEqual(strat.setupSide(lv), "PE");
});

test("dayLevels ignores bars at/after 15:30 for yesterday's range", () => {
  const y = yesterday();
  y.push(bar(YDAY, 15, 30, 23000, 23500, 22500, 23000));
  const lv = strat.dayLevels(y.concat(orBars(22980, 22990, 22900, 22920)));
  assert.strictEqual(lv.prevDay.high, 23050);
  assert.strictEqual(lv.prevDay.low, 22950);
});

test("pre-open: with an explicit day, yesterday is yesterday and there is no 09:15 candle yet", () => {
  const lv = strat.dayLevels(yesterday(), { day: strat._istDayOf(ist(TODAY, 9, 0)) });
  assert.strictEqual(lv.prevDay.date, YDAY);
  assert.strictEqual(lv.prevDay.high, 23050);
  assert.strictEqual(lv.or, null);
  assert.strictEqual(strat.setupSide(lv), null);
});

test("yesterday = latest earlier day present (skips weekend gap)", () => {
  const older = session("2026-03-20", 25000, 500);
  const lv = strat.dayLevels(older.concat(peDay()));
  assert.strictEqual(lv.prevDay.high, 23050);
});

// ── signal: PE ──────────────────────────────────────────────────────────────
test("09:15 candle still forming → no signal", () => {
  const s = strat.getSignal(yesterday().concat(orBars(22980, 22990, 22900, 22920).slice(0, 3)), { silent: true });
  assert.strictEqual(s.signal, "NONE");
  assert.ok(/still forming/.test(s.skipReason), s.skipReason);
});

test("PE: no break yet → waiting", () => {
  const s = strat.getSignal(peDay().concat([bar(TODAY, 9, 30, 22920, 22930, 22905, 22910)]), { silent: true });
  assert.strictEqual(s.signal, "NONE");
  assert.strictEqual(s.setupSide, "PE");
  assert.ok(/waiting for/.test(s.skipReason), s.skipReason);
  assert.strictEqual(s.spent, false);
});

test("PE: a WICK below the 09:15 low without a close below is not a break", () => {
  const s = strat.getSignal(peDay().concat([bar(TODAY, 9, 30, 22920, 22930, 22880, 22905)]), { silent: true });
  assert.strictEqual(s.signal, "NONE");
});

test("PE: first 3-min close below the 09:15 low fires, levels exact", () => {
  const brk = bar(TODAY, 9, 33, 22910, 22915, 22880, 22885); // size 35
  const s = strat.getSignal(peDay().concat([bar(TODAY, 9, 30, 22920, 22930, 22905, 22910), brk]), { silent: true });
  assert.strictEqual(s.signal, "BUY_PE");
  assert.strictEqual(s.side, "PE");
  assert.strictEqual(s.entrySpot, 22885);
  assert.strictEqual(s.slSpot, 22915);
  assert.strictEqual(s.slPts, 30);
  assert.strictEqual(s.candleSize, 35);
  assert.strictEqual(s.targetSpot, 22850);
  assert.strictEqual(s.breakLevel, 22900);
  assert.strictEqual(s.prevLow, 22950);
  assert.strictEqual(s.signalBarTime, brk.time);
});

test("PE: close exactly AT the 09:15 low is not below it", () => {
  const s = strat.getSignal(peDay().concat([bar(TODAY, 9, 30, 22920, 22925, 22890, 22900)]), { silent: true });
  assert.strictEqual(s.signal, "NONE");
});

test("only the FIRST break counts — a later close below is spent", () => {
  const s = strat.getSignal(peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22880, 22885),
    bar(TODAY, 9, 33, 22885, 22920, 22880, 22910),
    bar(TODAY, 9, 36, 22910, 22912, 22870, 22875),
  ]), { silent: true });
  assert.strictEqual(s.signal, "NONE");
  assert.strictEqual(s.spent, true);
  assert.ok(/already used/.test(s.skipReason), s.skipReason);
});

test("09:15 close inside yesterday's range → day dead", () => {
  const s = strat.getSignal(yesterday().concat(orBars(23000, 23010, 22960, 22970), [bar(TODAY, 9, 30, 22970, 22975, 22900, 22910)]), { silent: true });
  assert.strictEqual(s.signal, "NONE");
  assert.strictEqual(s.dayDead, true);
  assert.strictEqual(s.setupSide, null);
});

test("09:15 LOW below yesterday's low but CLOSE inside → no setup (close decides)", () => {
  const s = strat.getSignal(yesterday().concat(orBars(22990, 23000, 22930, 22960), [bar(TODAY, 9, 30, 22960, 22965, 22900, 22905)]), { silent: true });
  assert.strictEqual(s.dayDead, true);
});

// ── signal: CE mirror ───────────────────────────────────────────────────────
test("CE: 09:15 closes above yesterday's high, first close above its high fires", () => {
  const base = yesterday().concat(orBars(23020, 23100, 23010, 23080));
  const brk = bar(TODAY, 9, 30, 23090, 23130, 23085, 23120); // size 45
  const s = strat.getSignal(base.concat([brk]), { silent: true });
  assert.strictEqual(s.signal, "BUY_CE");
  assert.strictEqual(s.slSpot, 23085);
  assert.strictEqual(s.candleSize, 45);
  assert.strictEqual(s.targetSpot, 23165);
  assert.strictEqual(s.breakLevel, 23100);
});

// ── window + budget ─────────────────────────────────────────────────────────
function lateBreak(hh, mm) {
  const bars = peDay();
  for (let t = 9 * 60 + 30; t < hh * 60 + mm; t += 3) bars.push(bar(TODAY, Math.floor(t / 60), t % 60, 22920, 22925, 22905, 22910));
  bars.push(bar(TODAY, hh, mm, 22910, 22915, 22880, 22885));
  return bars;
}
test("break candle closing exactly 14:30 is allowed", () => {
  assert.strictEqual(strat.getSignal(lateBreak(14, 27), { silent: true }).signal, "BUY_PE");
});
test("break candle closing after 14:30 is refused (and spent)", () => {
  const s = strat.getSignal(lateBreak(14, 30), { silent: true });
  assert.strictEqual(s.signal, "NONE");
  assert.strictEqual(s.spent, true);
  assert.ok(/cut-off/.test(s.skipReason));
});
test("alreadyTraded → no entry", () => {
  const s = strat.getSignal(lateBreak(9, 33), { silent: true, alreadyTraded: true });
  assert.strictEqual(s.signal, "NONE");
});

// ── refusals ────────────────────────────────────────────────────────────────
test("no previous session → warmup", () => {
  const s = strat.getSignal(orBars(22980, 22990, 22900, 22920).concat([bar(TODAY, 9, 30, 22910, 22915, 22880, 22885)]), { silent: true });
  assert.strictEqual(s.warmup, true);
});
test("incomplete previous session → warmup refusal", () => {
  const y = yesterday().slice(0, 60);
  const s = strat.getSignal(y.concat(orBars(22980, 22990, 22900, 22920), [bar(TODAY, 9, 30, 22910, 22915, 22880, 22885)]), { silent: true });
  assert.strictEqual(s.warmup, true);
  assert.ok(/incomplete/.test(s.skipReason));
});
test("missing 09:15 sub-bar → day dead", () => {
  const ob = orBars(22980, 22990, 22900, 22920); ob.splice(2, 1);
  const s = strat.getSignal(yesterday().concat(ob, [bar(TODAY, 9, 30, 22910, 22915, 22880, 22885)]), { silent: true });
  assert.strictEqual(s.dayDead, true);
});
test("NaN bar in the 09:15 window → day dead, never a price of 0", () => {
  const ob = orBars(22980, 22990, 22900, 22920); ob[1] = { ...ob[1], low: null };
  const s = strat.getSignal(yesterday().concat(ob, [bar(TODAY, 9, 30, 22910, 22915, 22880, 22885)]), { silent: true });
  assert.strictEqual(s.signal, "NONE");
});
test("break candle closing at its own high (zero risk) is refused", () => {
  const s = strat.getSignal(peDay().concat([bar(TODAY, 9, 30, 22880, 22890, 22870, 22890)]), { silent: true });
  // close 22890 < 22900 break, high 22890 == close → zero risk
  assert.strictEqual(s.signal, "NONE");
  assert.ok(/zero-risk/.test(s.skipReason), s.skipReason);
});
test("unusable last candle refused", () => {
  const s = strat.getSignal(peDay().concat([{ time: ist(TODAY, 9, 30), open: 1, high: null, low: 1, close: 1 }]), { silent: true });
  assert.strictEqual(s.signal, "NONE");
});
test("empty / non-array input", () => {
  assert.strictEqual(strat.getSignal([], { silent: true }).warmup, true);
  assert.strictEqual(strat.getSignal(null, { silent: true }).warmup, true);
});

// ── exits ───────────────────────────────────────────────────────────────────
test("stopHit / targetHit guards and sides", () => {
  assert.strictEqual(strat.stopHit("PE", 22915, 22915), true);
  assert.strictEqual(strat.stopHit("PE", 22914, 22915), false);
  assert.strictEqual(strat.stopHit("CE", 23085, 23085), true);
  assert.strictEqual(strat.stopHit("PE", 22920, null), false);
  assert.strictEqual(strat.stopHit("PE", NaN, 1), false);
  assert.strictEqual(strat.targetHit("PE", 22850, 22850), true);
  assert.strictEqual(strat.targetHit("PE", 22851, 22850), false);
  assert.strictEqual(strat.targetHit("CE", 23165, 23165), true);
  assert.strictEqual(strat.targetHit("CE", 23000, undefined), false);
});
test("onTarget: trail ON → LOCK at target; OFF → EXIT", () => {
  const pos = { side: "PE", slSpot: 22915, targetSpot: 22850 };
  assert.deepStrictEqual(strat.onTarget(pos), { action: "LOCK", stop: 22850 });
  process.env.PREV_ORB_SCALP_TRAIL_AFTER_TARGET = "false";
  assert.deepStrictEqual(strat.onTarget(pos), { action: "EXIT" });
  delete process.env.PREV_ORB_SCALP_TRAIL_AFTER_TARGET;
  assert.strictEqual(strat.onTarget({ side: "PE", slSpot: 1, targetSpot: null }), null);
});
test("trailStop: only after target, ratchets only, both sides", () => {
  const pe = { side: "PE", slSpot: 22850, targetReached: false };
  const b = bar(TODAY, 10, 0, 22840, 22845, 22820, 22825);
  assert.strictEqual(strat.trailStop(pe, b), null);
  pe.targetReached = true;
  assert.deepStrictEqual(strat.trailStop(pe, b), { stop: 22845 });
  assert.strictEqual(strat.trailStop({ ...pe, slSpot: 22845 }, bar(TODAY, 10, 3, 22840, 22848, 22830, 22832)), null);
  const ce = { side: "CE", slSpot: 23165, targetReached: true };
  assert.deepStrictEqual(strat.trailStop(ce, bar(TODAY, 10, 0, 23170, 23190, 23168, 23185)), { stop: 23168 });
  assert.strictEqual(strat.trailStop(ce, bar(TODAY, 10, 0, 23170, 23190, 23160, 23185)), null);
  assert.strictEqual(strat.trailStop({ ...ce, slSpot: null }, b), null);
});

// ── config is live ──────────────────────────────────────────────────────────
test("settings are read live (entry end, OR length, malformed time)", () => {
  process.env.PREV_ORB_SCALP_ENTRY_END = "10:00";
  assert.strictEqual(cfg0().entryEndMin, 600);
  process.env.PREV_ORB_SCALP_ENTRY_END = "25:99";
  assert.strictEqual(cfg0().entryEndMin, 870);
  delete process.env.PREV_ORB_SCALP_ENTRY_END;
  process.env.PREV_ORB_SCALP_OR_MINS = "30";
  assert.strictEqual(cfg0().entryStartMin, 585);
  delete process.env.PREV_ORB_SCALP_OR_MINS;
  process.env.PREV_ORB_SCALP_RESOLUTION = "99";
  assert.strictEqual(cfg0().resolutionMins, 3);
  delete process.env.PREV_ORB_SCALP_RESOLUTION;
});
test("5-min resolution works end to end", () => {
  process.env.PREV_ORB_SCALP_RESOLUTION = "5";
  const y = session(YDAY, 23000, 20, 5); y[20] = { ...y[20], low: 22950 }; y[30] = { ...y[30], high: 23050 };
  const t = [bar(TODAY, 9, 15, 22980, 22990, 22960, 22970), bar(TODAY, 9, 20, 22970, 22975, 22900, 22930), bar(TODAY, 9, 25, 22930, 22935, 22910, 22920), bar(TODAY, 9, 30, 22920, 22925, 22880, 22890)];
  const s = strat.getSignal(y.concat(t), { silent: true });
  delete process.env.PREV_ORB_SCALP_RESOLUTION;
  assert.strictEqual(s.signal, "BUY_PE");
  assert.strictEqual(s.targetSpot, 22845);
});

// ── backtest ────────────────────────────────────────────────────────────────
const { runPrevOrbScalpBacktest } = require("../src/routes/prevOrbScalpBacktest");
const NOLOCK = { lock: { enabled: false } };
function fillDay(bars, fromMin, px) {
  const have = new Set(bars.map(b => b.time));
  for (let t = fromMin; t < 15 * 60 + 30; t += 3) {
    const tm = ist(TODAY, Math.floor(t / 60), t % 60);
    if (!have.has(tm)) bars.push({ time: tm, open: px, high: px + 2, low: px - 2, close: px, volume: 0 });
  }
  return bars.sort((a, b) => a.time - b.time);
}

test("backtest: PE target reached → SL to target → trailed stop exit", () => {
  const bars = peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22880, 22885),   // break: SL 22915, target 22850
    bar(TODAY, 9, 33, 22884, 22890, 22860, 22865),   // fill at open 22884
    bar(TODAY, 9, 36, 22865, 22870, 22845, 22848),   // target touched → SL 22850, trail → 22870? no: high 22870 > 22850 keeps 22850
    bar(TODAY, 9, 39, 22848, 22849, 22820, 22825),   // trail → 22849
    bar(TODAY, 9, 42, 22825, 22830, 22800, 22805),   // trail → 22830
    bar(TODAY, 9, 45, 22806, 22840, 22800, 22835),   // high 22840 ≥ 22830 → stop at 22830
  ]);
  const r = runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 48, 22835), TODAY, NOLOCK);
  assert.strictEqual(r.trades.length, 1);
  const t = r.trades[0];
  assert.strictEqual(t.side, "PE");
  assert.strictEqual(t.ePrice, 22884);
  assert.strictEqual(t.sl, 22915);
  assert.strictEqual(t.target, 22850);
  assert.strictEqual(t.targetReached, "yes");
  assert.strictEqual(t.exitCode, "TRAIL_STOP");
  assert.strictEqual(t.xPrice, 22830);
  assert.ok(t.pnl > 0);
});

test("backtest: stop tested BEFORE target on a bar that does both", () => {
  const bars = peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22880, 22885),
    bar(TODAY, 9, 33, 22884, 22920, 22840, 22900),
  ]);
  const r = runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 36, 22900), TODAY, NOLOCK);
  assert.strictEqual(r.trades[0].exitCode, "STOP");
  assert.strictEqual(r.trades[0].xPrice, 22915);
});

test("backtest: gap through the stop fills at the open, not the level", () => {
  const bars = peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22880, 22885),
    bar(TODAY, 9, 33, 22884, 22890, 22880, 22889),
    bar(TODAY, 9, 36, 22940, 22950, 22935, 22945),
  ]);
  const r = runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 39, 22945), TODAY, NOLOCK);
  assert.strictEqual(r.trades[0].exitCode, "STOP");
  assert.strictEqual(r.trades[0].xPrice, 22940);
});

test("backtest: fill already through the stop is aborted (paper parity)", () => {
  const bars = peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22880, 22885),
    bar(TODAY, 9, 33, 22920, 22925, 22900, 22910),
  ]);
  const r = runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 36, 22910), TODAY, NOLOCK);
  assert.strictEqual(r.trades.length, 0);
  assert.strictEqual(r.funnel.abortedPastStop, 1);
});

test("backtest: target touched then closed back through → TARGET_LOCK at target", () => {
  const bars = peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22880, 22885),
    bar(TODAY, 9, 33, 22884, 22890, 22845, 22870),
  ]);
  const r = runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 36, 22870), TODAY, NOLOCK);
  assert.strictEqual(r.trades[0].exitCode, "TARGET_LOCK");
  assert.strictEqual(r.trades[0].xPrice, 22850);
});

test("backtest: trail OFF → exit at target", () => {
  process.env.PREV_ORB_SCALP_TRAIL_AFTER_TARGET = "false";
  const bars = peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22880, 22885),
    bar(TODAY, 9, 33, 22884, 22890, 22845, 22870),
  ]);
  const r = runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 36, 22870), TODAY, NOLOCK);
  delete process.env.PREV_ORB_SCALP_TRAIL_AFTER_TARGET;
  assert.strictEqual(r.trades[0].exitCode, "TARGET");
  assert.strictEqual(r.trades[0].xPrice, 22850);
});

test("backtest: EOD square-off at 15:15 open", () => {
  const bars = peDay().concat([bar(TODAY, 9, 30, 22910, 22915, 22880, 22885)]);
  const r = runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 33, 22880), TODAY, NOLOCK);
  assert.strictEqual(r.trades[0].exitCode, "EOD");
  assert.strictEqual(r.trades[0].exit.slice(-8), "15:15:00");
});

test("backtest: one trade a day, warm-up day never trades, inside-range day counted", () => {
  const bars = peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22880, 22885),
    bar(TODAY, 9, 33, 22884, 22920, 22880, 22918),   // stopped
    bar(TODAY, 9, 36, 22918, 22920, 22870, 22875),   // second close below — must NOT trade
  ]);
  const r = runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 39, 22875), TODAY, NOLOCK);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.days, 1);
  const r2 = runPrevOrbScalpBacktest(yesterday().concat(fillDay(orBars(23000, 23010, 22960, 22970), 9 * 60 + 30, 22970)), TODAY, NOLOCK);
  assert.strictEqual(r2.trades.length, 0);
  assert.strictEqual(r2.funnel.insideRange, 1);
});

test("backtest: every trade's stop is on the losing side of its entry", () => {
  const bars = peDay().concat([bar(TODAY, 9, 30, 22910, 22915, 22880, 22885)]);
  const r = runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 33, 22880), TODAY, NOLOCK);
  for (const t of r.trades) assert.ok(t.side === "PE" ? t.sl > t.ePrice : t.sl < t.ePrice);
});

test("backtest: simulated profit lock fires on a give-back", () => {
  // δ 0.55, seed 260: arm +8% = +20.8 premium ≈ 37.8 spot pts; floor +5% ≈ 23.6 pts.
  const bars = peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22800, 22805),   // break: SL 22915, size 115 → target 22690
    bar(TODAY, 9, 33, 22804, 22806, 22760, 22765),   // fill 22804, favourable 44pt → arms lock
    bar(TODAY, 9, 36, 22766, 22790, 22765, 22788),   // back to 22790 → through floor (~22780)
  ]);
  const r = runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 39, 22788), TODAY, { lock: { enabled: true, armPct: 8, floorPct: 5 } });
  assert.strictEqual(r.trades[0].exitCode, "PROFIT_LOCK");
  assert.ok(r.trades[0].pnl > -500, `pnl ${r.trades[0].pnl}`);
});

test("backtest: empty input", () => {
  assert.strictEqual(runPrevOrbScalpBacktest([], "2026-01-01").trades.length, 0);
});

// ── paper route exits (canonical) ───────────────────────────────────────────
const paper = require("../src/routes/prevOrbScalpPaper");
function paperPos(extra) {
  return Object.assign({
    isFutures: false, side: "PE", symbol: "NSE:NIFTY26MAR22900PE", qty: 75,
    entrySpot: 22885, entryPrice: 22885, optionEntryLtp: 200, entryTime: "x", entryTimeMs: Date.now(),
    entryBarTime: ist(TODAY, 9, 33), slSpot: 22915, initialSlSpot: 22915, slPts: 30, riskPts: 30,
    targetSpot: 22850, targetReached: false, candleSize: 35, signalBarTime: ist(TODAY, 9, 30),
    peakPremium: 200, mfeSpotPts: 0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
  }, extra || {});
}
function freshRun(pos) {
  const s = paper._test.freshState();
  s.running = true; s.position = pos; s.tradesTaken = 1; s.optionLtp = 200;
  paper._test.setState(s);
  return s;
}

test("paper: stop at the break candle high", () => {
  const s = freshRun(paperPos());
  s.lastTickPrice = 22916;
  paper._test.checkExits(22916);
  assert.strictEqual(s.position, null);
  assert.ok(/Stop hit/.test(s.sessionTrades[0].exitReason));
  assert.strictEqual(s.dayClosed, true);
});

test("paper: target → SL jumps to target, trail on candle close, then exit", () => {
  const s = freshRun(paperPos());
  paper._test.checkExits(22850);
  assert.ok(s.position, "must not exit at target when trailing");
  assert.strictEqual(s.position.targetReached, true);
  assert.strictEqual(s.position.slSpot, 22850);
  s.candles = [bar(TODAY, 9, 36, 22845, 22847, 22830, 22835)];
  paper._test.onCandleClose(s.candles[0], false);
  assert.strictEqual(s.position.slSpot, 22847);
  s.lastTickPrice = 22848;
  paper._test.checkExits(22848);
  assert.strictEqual(s.position, null);
  assert.ok(/trailed stop/.test(s.sessionTrades[0].exitReason), s.sessionTrades[0].exitReason);
  assert.strictEqual(s.sessionTrades[0].targetReached, true);
});

test("paper: trail OFF → exits at target", () => {
  process.env.PREV_ORB_SCALP_TRAIL_AFTER_TARGET = "false";
  const s = freshRun(paperPos());
  paper._test.checkExits(22849);
  delete process.env.PREV_ORB_SCALP_TRAIL_AFTER_TARGET;
  assert.strictEqual(s.position, null);
  assert.ok(/Target hit/.test(s.sessionTrades[0].exitReason));
});

test("paper: trail never loosens and ignores the signal bar", () => {
  const s = freshRun(paperPos({ targetReached: true, slSpot: 22840 }));
  s.candles = [bar(TODAY, 9, 30, 22910, 22915, 22880, 22885)];
  paper._test.onCandleClose(s.candles[0], false);   // signal bar — ignored
  assert.strictEqual(s.position.slSpot, 22840);
  const b = bar(TODAY, 9, 39, 22830, 22845, 22820, 22825);
  s.candles.push(b);
  paper._test.onCandleClose(b, false);             // high 22845 > 22840 — no loosen
  assert.strictEqual(s.position.slSpot, 22840);
});

test("paper: global profit lock exits on premium give-back", () => {
  process.env.PROFIT_LOCK_ENABLED = "true";
  const s = freshRun(paperPos());
  s.optionLtp = 220; paper._test.checkExits(22870);   // +10% → armed (peak 220)
  assert.ok(s.position);
  s.optionLtp = 209; paper._test.checkExits(22880);   // floor 210 → exit
  process.env.PROFIT_LOCK_ENABLED = "false";
  assert.strictEqual(s.position, null);
  assert.ok(/Profit lock/.test(s.sessionTrades[0].exitReason));
});

test("paper: bad spot never exits", () => {
  const s = freshRun(paperPos());
  paper._test.checkExits(null); paper._test.checkExits(NaN); paper._test.checkExits(0);
  assert.ok(s.position);
});

test("paper: late batched break candle is not filled — day closed", () => {
  const s = paper._test.freshState();
  s.running = true;
  const brk = bar(TODAY, 9, 30, 22910, 22915, 22880, 22885);
  const nxt = bar(TODAY, 9, 33, 22885, 22890, 22870, 22875);
  s.candles = peDay().concat([brk, nxt]);
  paper._test.setState(s);
  paper._test.onCandleClose(brk, true);
  assert.strictEqual(s.position, null);
  assert.strictEqual(s.dayClosed, true);
  assert.ok(/late/.test(s.dayClosedReason));
});

test("paper: quote attribution is by symbol only", () => {
  const a = paper.attributeQuotes({ s: "ok", d: [{ n: "OTHER", v: { lp: 5 } }, { n: "SYM", v: { lp: 9 } }] }, ["SYM"], "SYM");
  assert.strictEqual(a.optLtp, 9);
  assert.strictEqual(paper.attributeQuotes({ s: "ok", d: [{ v: { lp: 5 } }, { v: { lp: 6 } }] }, ["SYM"], "SYM").optLtp, null);
});

// ── no rule duplicated in the routes ───────────────────────────────────────
test("routes never re-implement the break/target maths", () => {
  for (const f of ["prevOrbScalpPaper.js", "prevOrbScalpBacktest.js", "prevOrbScalpLiveHarness.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", f), "utf8");
    assert.ok(!/\.high\s*-\s*\w*\.low/.test(src), `${f} computes a candle size itself`);
    assert.ok(!/prevDay\.low\s*[<>]/.test(src) && !/orLow\s*[<>]/.test(src), `${f} compares setup levels itself`);
  }
});

try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
console.log(`\nprevOrbScalp: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

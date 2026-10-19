#!/usr/bin/env node
/**
 * ST_RSI_PIV_BB — RULE INVARIANTS
 *
 *   node tests/stRsiPivBb.regression.js
 *
 * Zero dependencies, exits non-zero on failure. Engine only — no socket, no
 * broker, no session. HOME points at a temp dir before anything is required.
 *
 * The rules (user-confirmed 2026-10-19):
 *   entry : on ONE closed candle, all four — SuperTrend(10,2) green, RSI(14)>70,
 *           close>R1 (previous-day traditional pivot), close>BB(20,2) upper.
 *           PE mirror: red, RSI<30, close<S1, close<BB lower. No confirm candle.
 *   tf    : ENTRY_TF 3 | 5 | BOTH (BOTH = 3-min AND latest closed 5-min both 4/4)
 *   exit  : candle close only — SuperTrend flips, or close beyond the trailed stop.
 *           Trail tighten-only. Square-off 15:15.
 */

process.env.TZ = "Asia/Calcutta";
const os = require("os");
const fs = require("fs");
const path = require("path");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "strsipivbb-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
for (const k of Object.keys(process.env)) if (k.startsWith("ST_RSI_PIV_BB_")) delete process.env[k];

const assert = require("assert");
const { RSI, BollingerBands } = require("technicalindicators");
const { computeSuperTrend } = require("../src/utils/supertrend");
const E = require("../src/strategies/st_rsi_piv_bb");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`✗ ${name}\n    ${e.message}`); }
}
function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}

// ── fixtures ────────────────────────────────────────────────────────────────
function ist(date, hh, mm) {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d, hh, mm) - 19800 * 1000) / 1000);
}
const DAY = "2026-10-15";
const DAY_KEY = E._istDayOf(ist(DAY, 12, 0));

/** 1-minute closes from 09:15: `flat` minutes oscillating ±0.3 round `base`, then a ramp. */
function minutePath(flat, ramp, base, step) {
  const out = [];
  for (let i = 0; i < flat; i++) out.push(base + (i % 2 ? 0.3 : -0.3));
  for (let i = 1; i <= ramp; i++) out.push(base + i * step);
  return out;
}
/** Aggregate a 1-min close path into `res`-minute OHLC bars starting 09:15 IST. */
function bars(pathCloses, res, date) {
  const t0 = ist(date || DAY, 9, 15);
  const out = [];
  for (let i = 0; i + res <= pathCloses.length; i += res) {
    const seg = pathCloses.slice(i, i + res);
    const open = i === 0 ? seg[0] : pathCloses[i - 1];
    out.push({ time: t0 + i * 60, open, high: Math.max(open, ...seg) + 0.1, low: Math.min(open, ...seg) - 0.1, close: seg[seg.length - 1] });
  }
  return out;
}
function daily(h, l, c, date) { return { time: ist(date, 9, 15), open: c, high: h, low: l, close: c }; }
const PIV = E.computePivots([daily(101, 99, 100, "2026-10-14")], { forDayKey: DAY_KEY }); // PP 100, R1 101, S1 99

// 150 flat minutes then a 30-minute ramp of +1/min → the last bars are 4/4 CE.
const UP_PATH = minutePath(150, 30, 100, 1);
const DOWN_PATH = UP_PATH.map((x) => 200 - x);   // exact mirror round 100
const UP3 = bars(UP_PATH, 3), UP5 = bars(UP_PATH, 5);
const DN3 = bars(DOWN_PATH, 3), DN5 = bars(DOWN_PATH, 5);

// ── config ──────────────────────────────────────────────────────────────────
test("defaults are the user's rules", () => {
  const c = E.getConfig();
  assert.strictEqual(c.ENTRY_TF, "BOTH");
  assert.strictEqual(c.TRADE_RES, 3);
  assert.strictEqual(c.CONFIRM_RES, 5);
  assert.deepStrictEqual([c.RSI_PERIOD, c.RSI_CE_MIN, c.RSI_PE_MAX], [14, 70, 30]);
  assert.deepStrictEqual([c.ST_PERIOD, c.ST_MULT, c.BB_PERIOD, c.BB_STDDEV], [10, 2, 20, 2]);
  assert.deepStrictEqual([c.ENTRY_START, c.ENTRY_END, c.EOD_EXIT], [570, 900, 915]);
  assert.deepStrictEqual([c.MAX_DAILY_TRADES, c.MAX_DAILY_LOSS], [3, 5000]);
  assert.strictEqual(E.warmupBars(c), 25);
});
test("ENTRY_TF 3 / 5 / junk", () => {
  withEnv({ ST_RSI_PIV_BB_ENTRY_TF: "3" }, () => { const c = E.getConfig(); assert.strictEqual(c.TRADE_RES, 3); assert.strictEqual(c.CONFIRM_RES, null); });
  withEnv({ ST_RSI_PIV_BB_ENTRY_TF: "5" }, () => { const c = E.getConfig(); assert.strictEqual(c.TRADE_RES, 5); assert.strictEqual(c.CONFIRM_RES, null); });
  withEnv({ ST_RSI_PIV_BB_ENTRY_TF: "both" }, () => assert.strictEqual(E.getConfig().ENTRY_TF, "BOTH"));
  withEnv({ ST_RSI_PIV_BB_ENTRY_TF: "15" }, () => assert.strictEqual(E.getConfig().ENTRY_TF, "BOTH"));
});
test("env overrides apply live and out-of-range values fall back", () => {
  withEnv({ ST_RSI_PIV_BB_RSI_CE_MIN: "65", ST_RSI_PIV_BB_ST_MULT: "3", ST_RSI_PIV_BB_ENTRY_START: "10:00" }, () => {
    const c = E.getConfig();
    assert.strictEqual(c.RSI_CE_MIN, 65); assert.strictEqual(c.ST_MULT, 3); assert.strictEqual(c.ENTRY_START, 600);
  });
  withEnv({ ST_RSI_PIV_BB_RSI_CE_MIN: "150", ST_RSI_PIV_BB_BB_PERIOD: "x", ST_RSI_PIV_BB_ENTRY_END: "25:99" }, () => {
    const c = E.getConfig();
    assert.strictEqual(c.RSI_CE_MIN, 70); assert.strictEqual(c.BB_PERIOD, 20); assert.strictEqual(c.ENTRY_END, 900);
  });
});

// ── pivots ──────────────────────────────────────────────────────────────────
test("traditional pivots from the previous day", () => {
  assert.deepStrictEqual([PIV.pp, PIV.r1, PIV.s1, PIV.r2, PIV.s2], [100, 101, 99, 102, 98]);
  assert.strictEqual(PIV.forDayKey, DAY_KEY);
  assert.strictEqual(PIV.from, "2026-10-14");
});
test("pivots never read the day being traded", () => {
  const p = E.computePivots([daily(101, 99, 100, "2026-10-14"), daily(500, 1, 300, DAY)], { forDayKey: DAY_KEY });
  assert.strictEqual(p.r1, 101);
});
test("pivots refuse: empty, intraday (two bars one day), high<low", () => {
  assert.strictEqual(E.computePivots([], { forDayKey: DAY_KEY }), null);
  assert.strictEqual(E.computePivots(null), null);
  const d = daily(101, 99, 100, "2026-10-14");
  assert.strictEqual(E.computePivots([d, Object.assign({}, d, { time: d.time + 300 })], { forDayKey: DAY_KEY }), null);
  assert.strictEqual(E.computePivots([daily(99, 101, 100, "2026-10-14")], { forDayKey: DAY_KEY }), null);
});

// ── series alignment ─────────────────────────────────────────────────────────
test("series are 1:1 and match technicalindicators alignment", () => {
  const cfg = E.getConfig();
  const s = E.computeSeries(UP3, cfg);
  const closes = UP3.map((c) => c.close);
  assert.strictEqual(s.rsi.length, UP3.length);
  for (let i = 0; i < 14; i++) assert.strictEqual(s.rsi[i], null);
  const r = RSI.calculate({ period: 14, values: closes });
  assert.strictEqual(s.rsi[14], r[0]);
  assert.strictEqual(s.rsi[UP3.length - 1], r[r.length - 1]);
  for (let i = 0; i < 19; i++) assert.strictEqual(s.bbUpper[i], null);
  const b = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  assert.strictEqual(s.bbUpper[19], b[0].upper);
  assert.strictEqual(s.bbLower[UP3.length - 1], b[b.length - 1].lower);
  assert.deepStrictEqual(s.supertrend, computeSuperTrend(UP3, 10, 2));
});

// ── checkBar: each box on its own ────────────────────────────────────────────
function fakeSeries(rsi, up, lo, stv, trend) {
  return { rsi: [rsi], bbUpper: [up], bbMiddle: [(up + lo) / 2], bbLower: [lo], supertrend: [{ value: stv, trend }] };
}
const BAR = { time: ist(DAY, 11, 0), open: 104, high: 106, low: 103, close: 105 };
test("checkBar: all four CE", () => {
  const k = E.checkBar(BAR, 0, fakeSeries(75, 104, 96, 100, 1), PIV);
  assert.ok(k.ready); assert.strictEqual(k.CE.count, 4); assert.strictEqual(k.PE.count, 0);
});
test("checkBar: each CE box fails on its own", () => {
  assert.strictEqual(E.checkBar(BAR, 0, fakeSeries(75, 104, 96, 110, -1), PIV).CE.st, false);
  assert.strictEqual(E.checkBar(BAR, 0, fakeSeries(70, 104, 96, 100, 1), PIV).CE.rsi, false);       // 70 is not > 70
  assert.strictEqual(E.checkBar(BAR, 0, fakeSeries(75, 106, 96, 100, 1), PIV).CE.bb, false);
  assert.strictEqual(E.checkBar(BAR, 0, fakeSeries(75, 105, 96, 100, 1), PIV).CE.bb, false);        // equal is not above
  const hiPiv = Object.assign({}, PIV, { r1: 105 });
  assert.strictEqual(E.checkBar(BAR, 0, fakeSeries(75, 104, 96, 100, 1), hiPiv).CE.piv, false);
  assert.strictEqual(E.checkBar(BAR, 0, fakeSeries(75, 104, 96, 100, 1), hiPiv).CE.count, 3);
});
test("checkBar: PE mirror", () => {
  const b = { time: BAR.time, open: 96, high: 97, low: 94, close: 95 };
  const k = E.checkBar(b, 0, fakeSeries(25, 104, 96, 100, -1), PIV);
  assert.strictEqual(k.PE.count, 4);
  assert.strictEqual(E.checkBar(b, 0, fakeSeries(30, 104, 96, 100, -1), PIV).PE.rsi, false);       // 30 is not < 30
});
test("checkBar: PE reads S1 and the LOWER band, not R1 / the upper band", () => {
  // Close 100: below R1 (101) but above S1 (99) → pivot box must fail.
  const mid = { time: BAR.time, open: 100, high: 100.5, low: 99.5, close: 100 };
  assert.strictEqual(E.checkBar(mid, 0, fakeSeries(25, 104, 90, 103, -1), PIV).PE.piv, false);
  // Close 95: below the upper band (104) but above the lower band (94) → band box must fail.
  const b = { time: BAR.time, open: 96, high: 97, low: 94, close: 95 };
  assert.strictEqual(E.checkBar(b, 0, fakeSeries(25, 104, 94, 100, -1), PIV).PE.bb, false);
  assert.strictEqual(E.checkBar(b, 0, fakeSeries(25, 104, 94, 100, -1), PIV).PE.count, 3);
  // And CE mirrors: close 100 is above S1 but not R1; above the lower band but not the upper.
  assert.strictEqual(E.checkBar(mid, 0, fakeSeries(75, 104, 96, 97, 1), PIV).CE.piv, false);
  assert.strictEqual(E.checkBar(mid, 0, fakeSeries(75, 104, 96, 97, 1), PIV).CE.bb, false);
});
test("checkBar: missing inputs → not ready", () => {
  assert.strictEqual(E.checkBar(BAR, 0, fakeSeries(null, 104, 96, 100, 1), PIV).ready, false);
  assert.strictEqual(E.checkBar(BAR, 0, fakeSeries(75, 104, 96, null, 1), PIV).ready, false);
  assert.strictEqual(E.checkBar(BAR, 0, fakeSeries(75, 104, 96, 100, 1), null).ready, false);
  assert.strictEqual(E.checkBar(Object.assign({}, BAR, { close: null }), 0, fakeSeries(75, 104, 96, 100, 1), PIV).ready, false);
});

// ── getSignal ────────────────────────────────────────────────────────────────
const TF3 = { ST_RSI_PIV_BB_ENTRY_TF: "3" };
test("3-min: the ramp's last bar is BUY_CE with SL = SuperTrend below the close", () => withEnv(TF3, () => {
  const r = E.getSignal(UP3, { pivots: PIV, silent: true });
  assert.strictEqual(r.signal, "BUY_CE", r.reason);
  const st = E.computeSeries(UP3).supertrend[UP3.length - 1];
  assert.strictEqual(r.stopLoss, st.value);
  assert.ok(r.stopLoss < UP3[UP3.length - 1].close);
  assert.strictEqual(r.checks.CE.count, 4);
  assert.strictEqual(r.r1, 101);
}));
test("3-min: the mirror path is BUY_PE with SL above the close", () => withEnv(TF3, () => {
  const r = E.getSignal(DN3, { pivots: PIV, silent: true });
  assert.strictEqual(r.signal, "BUY_PE", r.reason);
  assert.ok(r.stopLoss > DN3[DN3.length - 1].close);
}));
test("3-min: flat bars give no signal", () => withEnv(TF3, () => {
  const r = E.getSignal(UP3.slice(0, 50), { pivots: PIV, silent: true });
  assert.strictEqual(r.signal, "NONE");
  assert.strictEqual(r.warmup, false);
}));
test("a raised RSI threshold blocks the same bar", () => withEnv(Object.assign({ ST_RSI_PIV_BB_RSI_CE_MIN: "99.9" }, TF3), () => {
  assert.strictEqual(E.getSignal(UP3, { pivots: PIV, silent: true }).signal, "NONE");
}));
test("R1 above the close blocks the same bar", () => withEnv(TF3, () => {
  const p = Object.assign({}, PIV, { r1: 1000 });
  const r = E.getSignal(UP3, { pivots: p, silent: true });
  assert.strictEqual(r.signal, "NONE");
  assert.ok(/R1/.test(r.reason), r.reason);
}));
test("warm-up refused below 25 bars", () => withEnv(TF3, () => {
  const r = E.getSignal(UP3.slice(0, 24), { pivots: PIV, silent: true });
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.warmup, true);
}));
test("no pivots / pivots for another day → refuse", () => withEnv(TF3, () => {
  assert.strictEqual(E.getSignal(UP3, { silent: true }).warmup, true);
  const stale = Object.assign({}, PIV, { forDayKey: DAY_KEY - 1 });
  const r = E.getSignal(UP3, { pivots: stale, silent: true });
  assert.strictEqual(r.signal, "NONE"); assert.ok(/another day/.test(r.reason));
}));
test("non-finite signal candle → refuse, never coerce to 0", () => withEnv(TF3, () => {
  const c = UP3.slice(); c[c.length - 1] = Object.assign({}, c[c.length - 1], { close: null });
  const r = E.getSignal(c, { pivots: PIV, silent: true });
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.warmup, true);
}));
test("entry window reads the candle CLOSE time", () => withEnv(TF3, () => {
  const cfg = E.getConfig();
  assert.strictEqual(E.isInTradingWindow(ist(DAY, 9, 24), cfg).ok, false);   // closes 09:27
  assert.strictEqual(E.isInTradingWindow(ist(DAY, 9, 27), cfg).ok, true);    // closes 09:30
  assert.strictEqual(E.isInTradingWindow(ist(DAY, 14, 57), cfg).ok, true);   // closes 15:00
  assert.strictEqual(E.isInTradingWindow(ist(DAY, 15, 0), cfg).ok, false);   // closes 15:03
  // The same 4/4 ramp shifted to end after 15:00 → no entry.
  const late = UP3.map((b) => Object.assign({}, b, { time: b.time + 5 * 3600 }));
  const r = E.getSignal(late, { pivots: PIV, silent: true });
  assert.strictEqual(r.signal, "NONE"); assert.ok(/After 15:00/.test(r.reason), r.reason);
}));
test("precomputed path is bit-identical to the plain path", () => withEnv(TF3, () => {
  const cfg = E.getConfig();
  const series = E.computeSeries(UP3, cfg);
  for (const end of [30, 45, UP3.length - 1]) {
    const a = E.getSignal(UP3.slice(0, end + 1), { pivots: PIV, silent: true });
    const b = E.getSignal(UP3, { pivots: PIV, silent: true, precomputed: { series, endIdx: end, cfg } });
    assert.deepStrictEqual(b, a);
  }
}));
test("deterministic: same input, same output", () => withEnv(TF3, () => {
  assert.deepStrictEqual(E.getSignal(UP3, { pivots: PIV, silent: true }), E.getSignal(UP3, { pivots: PIV, silent: true }));
}));

// ── BOTH ─────────────────────────────────────────────────────────────────────
test("confirm index: 3-min close → the 5-min candle closed in the last 5 minutes", () => {
  const five = [ist(DAY, 9, 35), ist(DAY, 9, 40), ist(DAY, 9, 45)].map((t) => ({ time: t }));
  assert.strictEqual(E._confirmIndex(five, ist(DAY, 9, 48), 5), 1);   // 09:48 → 09:40-09:45 bar
  assert.strictEqual(E._confirmIndex(five, ist(DAY, 9, 45), 5), 1);   // 09:45 → the 09:40-09:45 bar (closes exactly at T)
  assert.strictEqual(E._confirmIndex(five, ist(DAY, 9, 51), 5), 2);   // 09:51 → 09:45-09:50
});
test("confirm index: the bar closing exactly at T is read; forming bars never", () => {
  const five = [ist(DAY, 9, 35), ist(DAY, 9, 40)].map((t) => ({ time: t }));
  assert.strictEqual(E._confirmIndex(five, ist(DAY, 9, 45), 5), 1);   // closes 09:45 = T
  assert.strictEqual(E._confirmIndex(five, ist(DAY, 9, 42), 5), 0);   // 09:40-09:45 is still forming at 09:42
  assert.strictEqual(E._confirmIndex(five, ist(DAY, 9, 51), 5), -1);  // newest closed 09:45 is > 5 min old
});
test("BOTH: 3-min and 5-min both 4/4 → BUY_CE, with the 5-min checklist", () => {
  const r = E.getSignal(UP3, { pivots: PIV, confirmCandles: UP5, silent: true });
  assert.strictEqual(r.signal, "BUY_CE", r.reason);
  assert.strictEqual(r.confirmChecks.CE.count, 4);
  assert.strictEqual(r.confirmTime + 300, UP3[UP3.length - 1].time + 180);
});
test("BOTH: PE mirror", () => {
  assert.strictEqual(E.getSignal(DN3, { pivots: PIV, confirmCandles: DN5, silent: true }).signal, "BUY_PE");
});
test("BOTH: no 5-min candles → refuse", () => {
  const r = E.getSignal(UP3, { pivots: PIV, silent: true });
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.warmup, true);
});
test("BOTH: the 5-min chart not yet appended for this moment → refuse (paper must append 5-min first)", () => {
  const r = E.getSignal(UP3, { pivots: PIV, confirmCandles: UP5.slice(0, -1), silent: true });
  assert.strictEqual(r.signal, "NONE"); assert.ok(/no closed 5-min/.test(r.reason), r.reason);
});
test("BOTH: 5-min chart disagrees (flat) → no trade", () => {
  // Same moment, but the 5-min bars come from the flat stretch only, re-timed to end at T.
  const flat5 = bars(minutePath(180, 0, 100, 1), 5);
  const r = E.getSignal(UP3, { pivots: PIV, confirmCandles: flat5, silent: true });
  assert.strictEqual(r.signal, "NONE");
  assert.ok(/5m only/.test(r.reason), r.reason);
});
test("BOTH: 5-min chart warming up → refuse", () => {
  // 24 bars: every 5-min indicator is ready and 4/4, but the chart is one bar
  // short of the 25 the engine requires — only the warm-up guard can refuse.
  const short = UP5.slice(-24);
  const r = E.getSignal(UP3, { pivots: PIV, confirmCandles: short, silent: true });
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.warmup, true);
  assert.ok(/warming up \(24\/25\)/.test(r.reason), r.reason);
  // …and 25 of the same bars is enough.
  assert.strictEqual(E.getSignal(UP3, { pivots: PIV, confirmCandles: UP5.slice(-25), silent: true }).signal, "BUY_CE");
});
test("ENTRY_TF 5: trades the 5-min chart alone", () => withEnv({ ST_RSI_PIV_BB_ENTRY_TF: "5" }, () => {
  const r = E.getSignal(UP5, { pivots: PIV, silent: true });
  assert.strictEqual(r.signal, "BUY_CE", r.reason);
  assert.strictEqual(r.tradeRes, 5); assert.strictEqual(r.confirmChecks, null);
}));

// ── exit + trail ─────────────────────────────────────────────────────────────
const B = (close) => ({ time: ist(DAY, 11, 0), open: close, high: close + 1, low: close - 1, close });
test("exitCheck CE: close below the stop exits; equal does not", () => {
  assert.strictEqual(E.exitCheck("CE", B(99.5), { value: 99, trend: 1 }, 100).exit, true);
  assert.strictEqual(E.exitCheck("CE", B(100), { value: 99, trend: 1 }, 100).exit, false);
  assert.strictEqual(E.exitCheck("CE", B(101), { value: 99, trend: 1 }, 100).exit, false);
});
test("exitCheck CE: a SuperTrend flip to red exits even above the stop", () => {
  const r = E.exitCheck("CE", B(101), { value: 103, trend: -1 }, 100);
  assert.strictEqual(r.exit, true); assert.ok(/flipped red/.test(r.reason));
});
test("exitCheck PE mirror", () => {
  assert.strictEqual(E.exitCheck("PE", B(100.5), { value: 101, trend: -1 }, 100).exit, true);
  assert.strictEqual(E.exitCheck("PE", B(100), { value: 101, trend: -1 }, 100).exit, false);
  assert.strictEqual(E.exitCheck("PE", B(99), { value: 97, trend: 1 }, 100).exit, true);
});
test("exitCheck: null stop / bad bar never invents an exit (spot >= null)", () => {
  assert.strictEqual(E.exitCheck("CE", B(50), { value: 40, trend: 1 }, null).exit, false);
  assert.strictEqual(E.exitCheck("PE", B(500), { value: 600, trend: -1 }, undefined).exit, false);
  assert.strictEqual(E.exitCheck("CE", { time: 1, open: 1, high: 1, low: 1, close: null }, { value: 1, trend: -1 }, 5).exit, false);
  assert.strictEqual(E.exitCheck("XX", B(1), { value: 9, trend: -1 }, 5).exit, false);
});
test("exit uses the CLOSE, not the wick", () => {
  const wick = { time: 1, open: 101, high: 102, low: 95, close: 101 };
  assert.strictEqual(E.exitCheck("CE", wick, { value: 99, trend: 1 }, 100).exit, false);
});
test("trailStop: CE tightens up, never loosens", () => withEnv(TF3, () => {
  const cfg = E.getConfig();
  const st = E.computeSeries(UP3, cfg).supertrend;
  const lvl = st[UP3.length - 1].value;
  const t1 = E.trailStop(UP3, "CE", lvl - 5, cfg);
  assert.strictEqual(t1.changed, true); assert.strictEqual(t1.stop, lvl);
  const t2 = E.trailStop(UP3, "CE", lvl + 1, cfg);
  assert.strictEqual(t2.changed, false); assert.strictEqual(t2.stop, lvl + 1);
}));
test("trailStop: PE tightens down, never loosens", () => withEnv(TF3, () => {
  const cfg = E.getConfig();
  const lvl = E.computeSeries(DN3, cfg).supertrend[DN3.length - 1].value;
  const t1 = E.trailStop(DN3, "PE", lvl + 5, cfg);
  assert.strictEqual(t1.changed, true); assert.strictEqual(t1.stop, lvl);
  const t2 = E.trailStop(DN3, "PE", lvl - 1, cfg);
  assert.strictEqual(t2.changed, false); assert.strictEqual(t2.stop, lvl - 1);
}));
test("trailStop: an opposite-trend SuperTrend never moves the stop", () => withEnv(TF3, () => {
  const cfg = E.getConfig();
  assert.strictEqual(E.trailStop(UP3, "PE", 1000, cfg).changed, false);   // ST green → PE stop untouched
  assert.strictEqual(E.trailStop(DN3, "CE", 1, cfg).changed, false);      // ST red → CE stop untouched
}));
test("trailStop: precomputed equals plain", () => withEnv(TF3, () => {
  const cfg = E.getConfig();
  const st = E.computeSeries(UP3, cfg).supertrend;
  for (const end of [40, 55, UP3.length - 1]) {
    assert.deepStrictEqual(E.trailStop(UP3, "CE", 50, cfg, { supertrend: st, endIdx: end }), E.trailStop(UP3.slice(0, end + 1), "CE", 50, cfg));
  }
}));
test("EOD square-off at 15:15", () => {
  assert.strictEqual(E.isEodExit(ist(DAY, 15, 14)), false);
  assert.strictEqual(E.isEodExit(ist(DAY, 15, 15)), true);
});
test("walk the ramp bar by bar: entry once 4/4, stop always below the close", () => withEnv(TF3, () => {
  const cfg = E.getConfig();
  let pos = null;
  for (let i = 25; i < UP3.length; i++) {
    const c = UP3.slice(0, i + 1);
    if (!pos) {
      const s = E.getSignal(c, { pivots: PIV, silent: true });
      assert.notStrictEqual(s.signal, "BUY_PE");
      if (s.signal === "BUY_CE") { pos = { side: "CE", stop: s.stopLoss }; assert.ok(s.stopLoss < c[i].close); }
    } else {
      const st = E.computeSeries(c, cfg).supertrend[i];
      assert.strictEqual(E.exitCheck("CE", c[i], st, pos.stop).exit, false);
      const t = E.trailStop(c, "CE", pos.stop, cfg);
      assert.ok(t.stop >= pos.stop); pos.stop = t.stop;
      assert.ok(pos.stop < c[i].close);
    }
  }
  assert.ok(pos, "the ramp must produce an entry");
}));

console.log(`\nST_RSI_PIV_BB: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

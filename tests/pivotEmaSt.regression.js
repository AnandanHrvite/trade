#!/usr/bin/env node
/**
 * PIVOT_EMA_ST — RULE INVARIANTS
 *
 *   node tests/pivotEmaSt.regression.js
 *
 * Zero dependencies, exits non-zero on failure. Engine only — no socket, no
 * broker, no session. HOME points at a temp dir before anything is required.
 *
 * The rules (user-confirmed 2026-10-24):
 *   entry : on ONE closed 3-min candle, all three —
 *             CE: PP < close < R1, EMA20 crosses ABOVE EMA50 on THIS candle with the cross
 *                 level ((EMA20+EMA50)/2) inside PP–R1, SuperTrend(10,3) green
 *             PE: S1 < close < PP, EMA20 crosses BELOW EMA50 on THIS candle inside S1–PP, ST red
 *           Close above R1 / below S1 never enters. Initial stop = SuperTrend.
 *   exit  : candle close only — SuperTrend flips, or close beyond the trailed stop.
 *           Trail tighten-only.
 */

process.env.TZ = "Asia/Calcutta";
const os = require("os");
const fs = require("fs");
const path = require("path");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pivotemast-test-"));
const REAL_HOME = os.homedir();
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
for (const k of Object.keys(process.env)) if (/^(BN_|SAIL_)?PIVOT_EMA_ST_/.test(k)) delete process.env[k];

const assert = require("assert");
const { EMA } = require("technicalindicators");
const { computeSuperTrend } = require("../src/utils/supertrend");
const E = require("../src/strategies/pivot_ema_st");

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
const DAY = "2026-10-21";
const DAY_KEY = E._istDayOf(ist(DAY, 12, 0));
// Pivots from a previous-day bar H 23,120 / L 22,700 / C 22,760:
//   PP 22,860 · R1 23,020 · S1 22,600
const PREV_DAILY = { time: ist("2026-10-20", 9, 15), open: 23000, high: 23120, low: 22700, close: 22760 };
const PIV = E.computePivots([PREV_DAILY], { forDayKey: DAY_KEY });

/** `n` 3-min bars ending with the signal bar at `hh:mm` IST on DAY, all closing at `close`. */
function bars(n, close, hh = 10, mm = 30) {
  const end = ist(DAY, hh, mm);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = end - (n - 1 - i) * 180;
    out.push({ time: t, open: close, high: close + 5, low: close - 5, close });
  }
  return out;
}
/**
 * A hand-made series so each rule can be tested in isolation. The last two
 * bars carry (prevFast, prevSlow) → (fast, slow) and the SuperTrend state.
 */
function series(n, { pf, ps, f, s, st, trend }) {
  const emaFast = new Array(n).fill(100), emaSlow = new Array(n).fill(100);
  const supertrend = new Array(n).fill(null).map(() => ({ value: st, trend }));
  emaFast[n - 2] = pf; emaSlow[n - 2] = ps; emaFast[n - 1] = f; emaSlow[n - 1] = s;
  return { emaFast, emaSlow, supertrend };
}
const N = 60;
function sig(close, ser, opts = {}) {
  const c = opts.candles || bars(N, close, opts.hh, opts.mm);
  return E.getSignal(c, Object.assign({ pivots: PIV, silent: true, precomputed: { series: ser, endIdx: c.length - 1 } }, opts.extra || {}));
}
const BULL_CROSS = { pf: 22870, ps: 22872, f: 22881, s: 22879 };
const BEAR_CROSS = { pf: 22790, ps: 22788, f: 22770, s: 22775 };

// ── config ──────────────────────────────────────────────────────────────────
test("defaults: TF 3, EMA 20/50, ST 10/3, window 10:00–14:00, EOD 15:00, 3 trades, ₹5000", () => {
  const c = E.getConfig();
  assert.strictEqual(c.PREFIX, "PIVOT_EMA_ST");
  assert.strictEqual(c.TF, 3);
  assert.strictEqual(c.EMA_FAST, 20); assert.strictEqual(c.EMA_SLOW, 50);
  assert.strictEqual(c.ST_PERIOD, 10); assert.strictEqual(c.ST_MULT, 3);
  assert.strictEqual(c.ENTRY_START, 600); assert.strictEqual(c.ENTRY_END, 840); assert.strictEqual(c.EOD_EXIT, 900);
  assert.strictEqual(c.MAX_DAILY_TRADES, 3); assert.strictEqual(c.MAX_DAILY_LOSS, 5000);
});
test("every threshold is configurable through its prefix", () => withEnv({
  PIVOT_EMA_ST_TF: "5", PIVOT_EMA_ST_EMA_FAST: "9", PIVOT_EMA_ST_EMA_SLOW: "21",
  PIVOT_EMA_ST_ST_PERIOD: "7", PIVOT_EMA_ST_ST_MULT: "2.5", PIVOT_EMA_ST_ENTRY_START: "09:30",
  PIVOT_EMA_ST_ENTRY_END: "15:00", PIVOT_EMA_ST_EOD_EXIT_TIME: "15:15",
  PIVOT_EMA_ST_MAX_DAILY_TRADES: "5", PIVOT_EMA_ST_MAX_DAILY_LOSS: "2000", PIVOT_EMA_ST_WARMUP_DAYS: "5",
}, () => {
  const c = E.getConfig("PIVOT_EMA_ST");
  assert.deepStrictEqual([c.TF, c.EMA_FAST, c.EMA_SLOW, c.ST_PERIOD, c.ST_MULT], [5, 9, 21, 7, 2.5]);
  assert.deepStrictEqual([c.ENTRY_START, c.ENTRY_END, c.EOD_EXIT], [570, 900, 915]);
  assert.deepStrictEqual([c.MAX_DAILY_TRADES, c.MAX_DAILY_LOSS], [5, 2000]);
  assert.strictEqual(E.warmupDays("PIVOT_EMA_ST"), 5);
}));
test("prefixes are independent: a BN / SAIL key never moves NIFTY", () => withEnv({
  BN_PIVOT_EMA_ST_EMA_FAST: "9", SAIL_PIVOT_EMA_ST_TF: "15",
}, () => {
  assert.strictEqual(E.getConfig("PIVOT_EMA_ST").EMA_FAST, 20);
  assert.strictEqual(E.getConfig("BN_PIVOT_EMA_ST").EMA_FAST, 9);
  assert.strictEqual(E.getConfig("SAIL_PIVOT_EMA_ST").TF, 15);
  assert.strictEqual(E.getConfig("PIVOT_EMA_ST").TF, 3);
  assert.strictEqual(E.getConfig("BN_PIVOT_EMA_ST").PREFIX, "BN_PIVOT_EMA_ST");
}));
test("garbage env falls back: TF 4 → 3, slow ≤ fast → 50, bad HH:MM → default", () => withEnv({
  PIVOT_EMA_ST_TF: "4", PIVOT_EMA_ST_EMA_FAST: "30", PIVOT_EMA_ST_EMA_SLOW: "30", PIVOT_EMA_ST_ENTRY_START: "25:00",
}, () => {
  const c = E.getConfig();
  assert.strictEqual(c.TF, 3); assert.strictEqual(c.EMA_SLOW, 50); assert.strictEqual(c.ENTRY_START, 600);
}));
test("warm-up is 56 bars at defaults and follows EMA_SLOW", () => {
  assert.strictEqual(E.warmupBars(E.getConfig()), 56);
  withEnv({ PIVOT_EMA_ST_EMA_SLOW: "100" }, () => assert.strictEqual(E.warmupBars(E.getConfig()), 106));
});
test("preload days: default 3, raised to what the timeframe needs (5m→5, 15m→11), never lowered below it", () => {
  assert.strictEqual(E.warmupDays(), 3);
  withEnv({ PIVOT_EMA_ST_TF: "5" }, () => assert.strictEqual(E.warmupDays("PIVOT_EMA_ST"), 5));
  withEnv({ PIVOT_EMA_ST_TF: "15" }, () => assert.strictEqual(E.warmupDays("PIVOT_EMA_ST"), 11));
  withEnv({ PIVOT_EMA_ST_TF: "15", PIVOT_EMA_ST_WARMUP_DAYS: "4" }, () => assert.strictEqual(E.warmupDays("PIVOT_EMA_ST"), 11));
  withEnv({ PIVOT_EMA_ST_WARMUP_DAYS: "7" }, () => assert.strictEqual(E.warmupDays("PIVOT_EMA_ST"), 7));
  withEnv({ BN_PIVOT_EMA_ST_TF: "15" }, () => { assert.strictEqual(E.warmupDays("BN_PIVOT_EMA_ST"), 11); assert.strictEqual(E.warmupDays("PIVOT_EMA_ST"), 3); });
});

// ── pivots ──────────────────────────────────────────────────────────────────
test("traditional pivots from the previous day: PP 22860, R1 23020, S1 22600", () => {
  assert.deepStrictEqual([PIV.pp, PIV.r1, PIV.s1, PIV.r2, PIV.s2], [22860, 23020, 22600, 23280, 22440]);
  assert.strictEqual(PIV.forDayKey, DAY_KEY);
});
test("pivots never read the day they are for, and refuse intraday candles", () => {
  const today = { time: ist(DAY, 9, 15), open: 1, high: 99999, low: 1, close: 5 };
  assert.strictEqual(E.computePivots([PREV_DAILY, today], { forDayKey: DAY_KEY }).pp, 22860);
  const dup = { time: ist("2026-10-20", 9, 20), open: 1, high: 2, low: 1, close: 1 };
  assert.strictEqual(E.computePivots([PREV_DAILY, dup], { forDayKey: DAY_KEY }), null);
  assert.strictEqual(E.computePivots([], {}), null);
  assert.strictEqual(E.computePivots(null, {}), null);
  assert.strictEqual(E.computePivots([today], { forDayKey: DAY_KEY }), null);
});

// ── indicator alignment ─────────────────────────────────────────────────────
test("computeSeries is 1:1 with candles and matches technicalindicators EMA alignment", () => {
  const c = [];
  for (let i = 0; i < 120; i++) { const x = 22800 + Math.sin(i / 7) * 40 + i; c.push({ time: ist(DAY, 9, 15) + i * 180, open: x, high: x + 6, low: x - 6, close: x + 1 }); }
  const s = E.computeSeries(c, E.getConfig());
  assert.strictEqual(s.emaFast.length, 120); assert.strictEqual(s.emaSlow.length, 120); assert.strictEqual(s.supertrend.length, 120);
  const closes = c.map((b) => b.close);
  const f = EMA.calculate({ period: 20, values: closes }), sl = EMA.calculate({ period: 50, values: closes });
  assert.strictEqual(s.emaFast[18], null); assert.strictEqual(s.emaFast[19], f[0]); assert.strictEqual(s.emaFast[119], f[f.length - 1]);
  assert.strictEqual(s.emaSlow[48], null); assert.strictEqual(s.emaSlow[49], sl[0]); assert.strictEqual(s.emaSlow[119], sl[sl.length - 1]);
  const st = computeSuperTrend(c, 10, 3);
  assert.deepStrictEqual(s.supertrend[119], st[119]);
});

// ── entry: CE ───────────────────────────────────────────────────────────────
test("CE: close in PP–R1 + EMA20 crosses above EMA50 on this candle + ST green → BUY_CE, stop = ST", () => {
  const r = sig(22900, series(N, { ...BULL_CROSS, st: 22840, trend: 1 }));
  assert.strictEqual(r.signal, "BUY_CE", r.reason);
  assert.strictEqual(r.stopLoss, 22840); assert.strictEqual(r.slSpot, 22840); assert.strictEqual(r.entrySpot, 22900);
  assert.strictEqual(r.zone, "PP_R1");
  assert.deepStrictEqual([r.checks.CE.zone, r.checks.CE.cross, r.checks.CE.st, r.checks.CE.count], [true, true, true, 3]);
  assert.ok(/3\/3/.test(r.reason));
});
test("CE: the cross happened on an EARLIER candle → no entry", () => {
  const r = sig(22900, series(N, { pf: 22875, ps: 22872, f: 22881, s: 22879, st: 22840, trend: 1 }));
  assert.strictEqual(r.signal, "NONE");
  assert.ok(/no EMA20↑50 cross/.test(r.reason), r.reason);
});
test("CE: EMAs equal on the previous bar, fast above now → counts as the cross", () => {
  const r = sig(22900, series(N, { pf: 22870, ps: 22870, f: 22881, s: 22879, st: 22840, trend: 1 }));
  assert.strictEqual(r.signal, "BUY_CE", r.reason);
});
test("CE: SuperTrend red → no entry", () => {
  const r = sig(22900, series(N, { ...BULL_CROSS, st: 22950, trend: -1 }));
  assert.strictEqual(r.signal, "NONE");
  assert.ok(/ST not green/.test(r.reason), r.reason);
});
test("CE: close ABOVE R1 with cross + green → no entry (no-trade zone)", () => {
  const r = sig(23050, series(N, { ...BULL_CROSS, st: 22990, trend: 1 }));
  assert.strictEqual(r.signal, "NONE");
  assert.strictEqual(r.zone, "ABOVE_R1"); assert.strictEqual(r.skipReason, "outside_zone");
});
test("close exactly on R1 or PP is not inside the zone", () => {
  assert.strictEqual(sig(23020, series(N, { ...BULL_CROSS, st: 22990, trend: 1 })).signal, "NONE");
  const onPP = sig(22860, series(N, { ...BULL_CROSS, st: 22800, trend: 1 }));
  assert.strictEqual(onPP.signal, "NONE"); assert.strictEqual(onPP.zone, "ON_LEVEL");
});
test("CE: close in PP–R1 but the EMAs crossed BELOW PP → no entry (the cross must be in the zone)", () => {
  // EMAs cross at ~22,841 (below PP 22,860) while the candle closes at 22,900.
  const r = sig(22900, series(N, { pf: 22838, ps: 22840, f: 22842, s: 22840, st: 22830, trend: 1 }));
  assert.strictEqual(r.signal, "NONE");
  assert.strictEqual(r.checks.crossedUp, true);
  assert.strictEqual(r.checks.CE.cross, false);
  assert.ok(/crossed at 22841, outside the PP–R1 zone/.test(r.reason), r.reason);
});
test("CE: EMAs crossed ABOVE R1 while the close is back in PP–R1 → no entry", () => {
  const r = sig(23000, series(N, { pf: 23028, ps: 23030, f: 23032, s: 23030, st: 22980, trend: 1 }));
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.checks.CE.cross, false);
});
test("PE: EMAs crossed ABOVE PP while the close is in S1–PP → no entry", () => {
  const r = sig(22850, series(N, { pf: 22872, ps: 22870, f: 22868, s: 22870, st: 22890, trend: -1 }));
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.checks.crossedDown, true); assert.strictEqual(r.checks.PE.cross, false);
});
test("the cross level is reported on the signal", () => {
  const r = sig(22900, series(N, { ...BULL_CROSS, st: 22840, trend: 1 }));
  assert.strictEqual(r.crossLevel, 22880);
  assert.ok(/at 22880 \(in zone\)/.test(r.reason), r.reason);
});
test("bearish cross + red ST inside PP–R1 is NOT a PE (PE needs S1–PP)", () => {
  const r = sig(22900, series(N, { pf: 22890, ps: 22888, f: 22880, s: 22885, st: 22950, trend: -1 }));
  assert.strictEqual(r.signal, "NONE");
});

// ── entry: PE ───────────────────────────────────────────────────────────────
test("PE: close in S1–PP + EMA20 crosses below EMA50 on this candle + ST red → BUY_PE, stop = ST", () => {
  const r = sig(22760, series(N, { ...BEAR_CROSS, st: 22820, trend: -1 }));
  assert.strictEqual(r.signal, "BUY_PE", r.reason);
  assert.strictEqual(r.stopLoss, 22820); assert.strictEqual(r.zone, "S1_PP");
});
test("PE: no fresh bearish cross → no entry", () => {
  const r = sig(22760, series(N, { pf: 22770, ps: 22775, f: 22765, s: 22772, st: 22820, trend: -1 }));
  assert.strictEqual(r.signal, "NONE"); assert.ok(/no EMA20↓50 cross/.test(r.reason), r.reason);
});
test("PE: SuperTrend green → no entry", () => {
  const r = sig(22760, series(N, { ...BEAR_CROSS, st: 22700, trend: 1 }));
  assert.strictEqual(r.signal, "NONE"); assert.ok(/ST not red/.test(r.reason), r.reason);
});
test("PE: close BELOW S1 with cross + red → no entry (no-trade zone)", () => {
  const r = sig(22580, series(N, { ...BEAR_CROSS, st: 22640, trend: -1 }));
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.zone, "BELOW_S1"); assert.strictEqual(r.skipReason, "outside_zone");
});
test("bullish cross + green ST inside S1–PP is NOT a CE", () => {
  const r = sig(22760, series(N, { pf: 22750, ps: 22752, f: 22758, s: 22755, st: 22700, trend: 1 }));
  assert.strictEqual(r.signal, "NONE");
});

// ── refusals ────────────────────────────────────────────────────────────────
test("SuperTrend on the wrong side of the close → refuse (no stop, no trade)", () => {
  const r = sig(22900, series(N, { ...BULL_CROSS, st: 22910, trend: 1 }));
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.skipReason, "st_wrong_side");
});
test("fewer than 56 bars → warm-up refusal", () => {
  const c = bars(55, 22900);
  const r = E.getSignal(c, { pivots: PIV, silent: true });
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.warmup, true); assert.ok(/55\/56/.test(r.reason), r.reason);
});
test("no pivots / pivots for another day → refuse", () => {
  const ser = series(N, { ...BULL_CROSS, st: 22840, trend: 1 });
  const c = bars(N, 22900);
  const a = E.getSignal(c, { pivots: null, silent: true, precomputed: { series: ser, endIdx: N - 1 } });
  assert.strictEqual(a.signal, "NONE"); assert.strictEqual(a.warmup, true);
  const stale = Object.assign({}, PIV, { forDayKey: DAY_KEY - 1 });
  const b = E.getSignal(c, { pivots: stale, silent: true, precomputed: { series: ser, endIdx: N - 1 } });
  assert.strictEqual(b.signal, "NONE"); assert.ok(/another day/.test(b.reason));
  const nanPiv = Object.assign({}, PIV, { r1: NaN });
  assert.strictEqual(E.getSignal(c, { pivots: nanPiv, silent: true, precomputed: { series: ser, endIdx: N - 1 } }).signal, "NONE");
});
test("pivots must come from the LAST session the candles show (a missing daily bar is refused)", () => {
  const ser = series(N, { ...BULL_CROSS, st: 22840, trend: 1 });
  // 60 bars: the first 20 on 2026-10-20 (yesterday), the rest today.
  const c = bars(N, 22900);
  for (let i = 0; i < 20; i++) c[i].time = ist("2026-10-20", 14, 0) + i * 60;
  const ok = E.getSignal(c, { pivots: PIV, silent: true, precomputed: { series: ser, endIdx: N - 1 } });
  assert.strictEqual(ok.signal, "BUY_CE", ok.reason);
  const older = { time: ist("2026-10-19", 9, 15), open: 23000, high: 23120, low: 22700, close: 22760 };
  const stale = E.computePivots([older], { forDayKey: DAY_KEY });   // feed missing 20-Oct → 19-Oct levels
  const r = E.getSignal(c, { pivots: stale, silent: true, precomputed: { series: ser, endIdx: N - 1 } });
  assert.strictEqual(r.signal, "NONE"); assert.strictEqual(r.warmup, true); assert.strictEqual(r.skipReason, "stale_pivots");
  assert.ok(/older than the last session 2026-10-20/.test(r.reason), r.reason);
});
test("pivots NEWER than the last candle session are accepted (Muhurat: daily bar, no 09:15 candles)", () => {
  const ser = series(N, { ...BULL_CROSS, st: 22840, trend: 1 });
  const c = bars(N, 22900);
  for (let i = 0; i < 20; i++) c[i].time = ist("2026-10-19", 14, 0) + i * 60;   // last intraday session 19-Oct
  const r = E.getSignal(c, { pivots: PIV, silent: true, precomputed: { series: ser, endIdx: N - 1 } });   // pivots from 20-Oct
  assert.strictEqual(r.signal, "BUY_CE", r.reason);
});
test("null / NaN guards: missing EMA or ST or bad OHLC never invents a signal", () => {
  const ser = series(N, { ...BULL_CROSS, st: 22840, trend: 1 });
  ser.emaFast[N - 2] = null;
  const a = sig(22900, ser);
  assert.strictEqual(a.signal, "NONE"); assert.strictEqual(a.warmup, true);
  const ser2 = series(N, { ...BULL_CROSS, st: null, trend: 1 });
  assert.strictEqual(sig(22900, ser2).signal, "NONE");
  const c = bars(N, 22900); c[N - 1].close = NaN;
  assert.strictEqual(sig(22900, series(N, { ...BULL_CROSS, st: 22840, trend: 1 }), { candles: c }).signal, "NONE");
  const c2 = bars(N, 22900); c2[N - 1].high = null;
  assert.strictEqual(sig(22900, series(N, { ...BULL_CROSS, st: 22840, trend: 1 }), { candles: c2 }).signal, "NONE");
});

// ── entry window ────────────────────────────────────────────────────────────
test("entry window is on the candle CLOSE: 09:54 bar (closes 09:57) refused, 09:57 bar (closes 10:00) allowed", () => {
  const ser = series(N, { ...BULL_CROSS, st: 22840, trend: 1 });
  assert.strictEqual(sig(22900, ser, { hh: 9, mm: 54 }).signal, "NONE");
  assert.strictEqual(sig(22900, ser, { hh: 9, mm: 57 }).signal, "BUY_CE");
});
test("13:57 bar (closes 14:00) allowed; 14:00 bar (closes 14:03) refused", () => {
  const ser = series(N, { ...BULL_CROSS, st: 22840, trend: 1 });
  assert.strictEqual(sig(22900, ser, { hh: 13, mm: 57 }).signal, "BUY_CE");
  assert.strictEqual(sig(22900, ser, { hh: 14, mm: 0 }).signal, "NONE");
});
test("after 14:00 close → refused; skipTimeCheck bypasses (commodity owns its window)", () => {
  const ser = series(N, { ...BULL_CROSS, st: 22840, trend: 1 });
  const late = sig(22900, ser, { hh: 13, mm: 58 });
  assert.strictEqual(late.signal, "NONE"); assert.ok(/After 14:00/.test(late.reason));
  assert.strictEqual(sig(22900, ser, { hh: 13, mm: 58, extra: { skipTimeCheck: true } }).signal, "BUY_CE");
});
test("square-off at 15:00", () => {
  assert.strictEqual(E.isEodExit(ist(DAY, 14, 59)), false);
  assert.strictEqual(E.isEodExit(ist(DAY, 15, 0)), true);
});

// ── exits ───────────────────────────────────────────────────────────────────
const B = (close) => ({ time: ist(DAY, 11, 0), open: close, high: close + 5, low: close - 5, close });
test("CE exit: SuperTrend flips red on the close", () => {
  const r = E.exitCheck("CE", B(22900), { value: 22950, trend: -1 }, 22840);
  assert.strictEqual(r.exit, true); assert.ok(/flipped red/.test(r.reason));
});
test("CE exit: close below the trailed stop", () => {
  const r = E.exitCheck("CE", B(22830), { value: 22800, trend: 1 }, 22840);
  assert.strictEqual(r.exit, true); assert.ok(/below SuperTrend stop/.test(r.reason));
});
test("CE hold: wick through the stop that closes above it does not exit", () => {
  const bar = { time: ist(DAY, 11, 0), open: 22860, high: 22870, low: 22800, close: 22850 };
  assert.strictEqual(E.exitCheck("CE", bar, { value: 22840, trend: 1 }, 22840).exit, false);
});
test("PE exits: flip green, close above stop; PE hold otherwise", () => {
  assert.strictEqual(E.exitCheck("PE", B(22760), { value: 22700, trend: 1 }, 22820).exit, true);
  assert.strictEqual(E.exitCheck("PE", B(22830), { value: 22850, trend: -1 }, 22820).exit, true);
  assert.strictEqual(E.exitCheck("PE", B(22760), { value: 22810, trend: -1 }, 22820).exit, false);
});
test("exit guards: null stop never exits on its own, bad bar never exits", () => {
  assert.strictEqual(E.exitCheck("CE", B(1), { value: 22840, trend: 1 }, null).exit, false);
  assert.strictEqual(E.exitCheck("PE", B(99999), { value: 22840, trend: -1 }, null).exit, false);
  assert.strictEqual(E.exitCheck("CE", { time: 1, open: 1, high: 1, low: 1, close: NaN }, { trend: -1 }, 22840).exit, false);
  assert.strictEqual(E.exitCheck("CE", B(22900), null, 22840).exit, false);
});

// ── trail ───────────────────────────────────────────────────────────────────
function trailCase(side, stop, st, close) {
  const c = bars(30, close);
  const sup = new Array(30).fill(null).map(() => st);
  return E.trailStop(c, side, stop, E.getConfig(), { supertrend: sup, endIdx: 29 });
}
test("trail: CE moves up to the new SuperTrend, never down", () => {
  assert.deepStrictEqual(trailCase("CE", 22840, { value: 22860, trend: 1 }, 22900), { stop: 22860, changed: true, tag: "SuperTrend" });
  assert.strictEqual(trailCase("CE", 22840, { value: 22820, trend: 1 }, 22900).changed, false);
  assert.strictEqual(trailCase("CE", 22840, { value: 22950, trend: -1 }, 22900).changed, false);
  assert.strictEqual(trailCase("CE", 22840, { value: 22910, trend: 1 }, 22900).changed, false);
});
test("trail: PE moves down to the new SuperTrend, never up", () => {
  assert.strictEqual(trailCase("PE", 22820, { value: 22800, trend: -1 }, 22760).stop, 22800);
  assert.strictEqual(trailCase("PE", 22820, { value: 22830, trend: -1 }, 22760).changed, false);
  assert.strictEqual(trailCase("PE", 22820, { value: 22700, trend: 1 }, 22760).changed, false);
});
test("trail: too few bars or null ST leaves the stop alone", () => {
  assert.strictEqual(E.trailStop(bars(5, 22900), "CE", 22840, E.getConfig()).changed, false);
  assert.strictEqual(trailCase("CE", 22840, { value: null, trend: 1 }, 22900).changed, false);
});

// ── a natural session through the real indicators ──────────────────────────
test("real indicators: a dip-then-rally inside PP–R1 produces exactly the 3-condition CE, stop below entry", () => {
  // Two prior days around 22,820, then today drifts down and rallies inside 22,860–23,020.
  const c = [];
  let t = ist("2026-10-20", 9, 15);
  const push = (x) => { c.push({ time: t, open: x - 1, high: x + 4, low: x - 4, close: x }); t += 180; };
  for (let i = 0; i < 60; i++) push(22950 - i * 0.8);          // slow drift down → EMA20 < EMA50
  t = ist(DAY, 9, 15);
  for (let i = 0; i < 20; i++) push(22900 - i * 0.5);
  for (let i = 0; i < 40; i++) push(22890 + i * 2.5);          // rally → EMA20 crosses up, ST green
  const cfg = E.getConfig();
  const ser = E.computeSeries(c, cfg);
  let entries = 0;
  for (let i = E.warmupBars(cfg) - 1; i < c.length; i++) {
    const r = E.getSignal(c, { pivots: E.computePivots([PREV_DAILY], { forDayKey: E._istDayOf(c[i].time) }), silent: true, precomputed: { series: ser, endIdx: i } });
    if (r.signal === "NONE") continue;
    entries++;
    assert.strictEqual(r.signal, "BUY_CE");
    assert.ok(c[i].close > PIV.pp && c[i].close < PIV.r1);
    assert.ok(ser.emaFast[i - 1] <= ser.emaSlow[i - 1] && ser.emaFast[i] > ser.emaSlow[i]);
    assert.strictEqual(ser.supertrend[i].trend, 1);
    assert.ok(r.stopLoss < c[i].close);
  }
  assert.strictEqual(entries, 1, `expected one fresh cross, got ${entries}`);
});

// ── real cached candles (skipped when the cache is absent) ──────────────────
test("real NIFTY 5-min cache: every signal obeys all three rules; every stop is protective", () => {
  const dir = path.join(REAL_HOME, "trading-data", "backtest_cache");
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => /NIFTY50-INDEX_5_/.test(n)).sort().slice(-6); } catch (_) {}
  if (!files.length) return;
  let c = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const arr = Array.isArray(j) ? j : (j.candles || []);
    for (const x of arr) c.push(Array.isArray(x) ? { time: x[0], open: x[1], high: x[2], low: x[3], close: x[4] } : x);
  }
  const seen = new Set();
  c = c.filter((b) => !seen.has(b.time) && seen.add(b.time)).sort((a, b) => a.time - b.time);
  const daily = new Map();
  for (const b of c) {
    const k = E._istDayOf(b.time);
    const d = daily.get(k);
    if (!d) daily.set(k, { time: k * 86400 - 19800 + 33300, open: b.open, high: b.high, low: b.low, close: b.close });
    else { d.high = Math.max(d.high, b.high); d.low = Math.min(d.low, b.low); d.close = b.close; }
  }
  const dailyArr = [...daily.values()];
  withEnv({ PIVOT_EMA_ST_TF: "5" }, () => {
    const cfg = E.getConfig();
    const ser = E.computeSeries(c, cfg);
    let signals = 0;
    for (let i = 1; i < c.length; i++) {
      const piv = E.computePivots(dailyArr, { forDayKey: E._istDayOf(c[i].time) });
      const r = E.getSignal(c, { pivots: piv, silent: true, cfg, precomputed: { series: ser, endIdx: i } });
      if (r.signal === "NONE") continue;
      const ce = r.signal === "BUY_CE";
      assert.ok(ce ? (c[i].close > piv.pp && c[i].close < piv.r1) : (c[i].close < piv.pp && c[i].close > piv.s1), "zone");
      assert.ok(ce ? (ser.emaFast[i - 1] <= ser.emaSlow[i - 1] && ser.emaFast[i] > ser.emaSlow[i])
                   : (ser.emaFast[i - 1] >= ser.emaSlow[i - 1] && ser.emaFast[i] < ser.emaSlow[i]), "cross");
      const lvl = (ser.emaFast[i] + ser.emaSlow[i]) / 2;
      assert.ok(ce ? (lvl > piv.pp && lvl < piv.r1) : (lvl < piv.pp && lvl > piv.s1), "cross level in zone");
      signals++;
      assert.strictEqual(ser.supertrend[i].trend, ce ? 1 : -1, "ST colour");
      assert.ok(ce ? r.stopLoss < c[i].close : r.stopLoss > c[i].close, "stop side");
    }
    assert.ok(signals > 0, "six months of real candles produced no signal at all");
  });
});

console.log(`\nPIVOT_EMA_ST: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

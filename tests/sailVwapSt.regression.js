#!/usr/bin/env node
/**
 * SAIL_VWAP_ST — RULE INVARIANTS
 *
 *   node tests/sailVwapSt.regression.js
 *
 * Zero dependencies, exits non-zero on failure. Engine + the SAIL instrument
 * row only — no socket, no broker, no session. HOME points at a temp dir first.
 *
 * The rules (user-confirmed 2026-10-20):
 *   entry : SAIL 5-min close crosses session VWAP (hlc3); within 3 candles a
 *           close beyond the cross candle's high (CE) / low (PE); every close in
 *           between stays on the cross side; SuperTrend(10,2) must agree, else
 *           skip. Only the FIRST breakout close counts.
 *   exit  : candle close only — SuperTrend flips, or close beyond the trailed
 *           stop. Trail tighten-only. Square-off 15:15. 1 trade/day.
 */

process.env.TZ = "Asia/Calcutta";
const os = require("os");
const fs = require("fs");
const path = require("path");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sailvwapst-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const assert = require("assert");
const { computeSuperTrend } = require("../src/utils/supertrend");
const E = require("../src/strategies/sail_vwap_st");
const instrument = require("../src/config/instrument");
// instrument.js loads the repo .env on require — clear what it may have set so
// the test reads code defaults, whatever is in the local .env.
for (const k of Object.keys(process.env)) if (k.startsWith("SAIL_")) delete process.env[k];

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
const PREV = "2026-10-15", DAY = "2026-10-16";
function bar(t, o, h, l, c, v) { return { time: t, open: o, high: h, low: l, close: c, volume: v }; }

/** Previous day: 60 five-minute bars ramping 160 → 166 (SuperTrend settles green). */
function prevDayUp() {
  const out = [];
  for (let i = 0; i < 60; i++) {
    const c = 160 + i * 0.1;
    out.push(bar(ist(PREV, 9, 15) + i * 300, c - 0.05, c + 0.1, c - 0.1, c, 1000));
  }
  return out;
}
/** Today: open bar, a dip below VWAP, the cross (bar 4), a waiting bar, the breakout (bar 6), one more above. */
function todayCE() {
  const t = (i) => ist(DAY, 9, 15) + i * 300;
  return [
    bar(t(0), 167.0, 167.5, 166.5, 167.0, 10000),   // VWAP ≈ 167.0
    bar(t(1), 166.9, 166.95, 166.75, 166.8, 1000),
    bar(t(2), 166.8, 166.85, 166.55, 166.6, 1000),
    bar(t(3), 166.6, 166.75, 166.6, 166.7, 1000),
    bar(t(4), 166.7, 167.4, 166.8, 167.3, 1000),    // CROSS: close above VWAP, prev at/below
    bar(t(5), 167.3, 167.38, 167.2, 167.35, 1000),  // above VWAP, not above 167.4 → waiting
    bar(t(6), 167.35, 167.7, 167.3, 167.6, 1000),   // BREAKOUT: close 167.6 > 167.4
    bar(t(7), 167.6, 167.9, 167.55, 167.8, 1000),   // second close above — setup already used
  ];
}
const CE_SET = () => prevDayUp().concat(todayCE());
const N_PREV = 60;

/** Independent VWAP: Σ hlc3·v / Σ v, per IST day. */
function refVwap(cs) {
  let day = null, pv = 0, v = 0;
  return cs.map((c) => {
    const k = Math.floor((c.time + 19800) / 86400);
    if (k !== day) { day = k; pv = 0; v = 0; }
    pv += ((c.high + c.low + c.close) / 3) * c.volume; v += c.volume;
    return v > 0 ? pv / v : null;
  });
}
const close2 = (a, b) => Math.abs(a - b) < 1e-9;

// ── config ──────────────────────────────────────────────────────────────────
test("defaults match the confirmed rules", () => {
  const c = E.getConfig();
  assert.strictEqual(c.TRADE_RES, 5);
  assert.strictEqual(c.ST_PERIOD, 10);
  assert.strictEqual(c.ST_MULT, 2);
  assert.strictEqual(c.BREAKOUT_BARS, 3);
  assert.strictEqual(c.ENTRY_START, 9 * 60 + 30);
  assert.strictEqual(c.ENTRY_END, 14 * 60 + 30);
  assert.strictEqual(c.EOD_EXIT, 15 * 60 + 15);
  assert.strictEqual(c.MAX_DAILY_TRADES, 1);
  assert.strictEqual(c.MAX_DAILY_LOSS, 5000);
  assert.strictEqual(c.LOTS, 1);
  assert.strictEqual(c.OPT_STOP_PCT, 0.25);
  assert.strictEqual(c.UNDERLYING, "SAIL");
  assert.strictEqual(E.warmupDays(), 2);
  assert.strictEqual(E.warmupBars(c), 17);
});
test("every threshold is configurable; garbage falls back", () => withEnv({
  SAIL_VWAP_ST_TF: "15", SAIL_VWAP_ST_ST_PERIOD: "7", SAIL_VWAP_ST_ST_MULT: "1", SAIL_VWAP_ST_BREAKOUT_BARS: "5",
  SAIL_VWAP_ST_ENTRY_START: "10:00", SAIL_VWAP_ST_ENTRY_END: "13:00", SAIL_VWAP_ST_EOD_EXIT_TIME: "15:00",
  SAIL_VWAP_ST_MAX_DAILY_TRADES: "2", SAIL_VWAP_ST_MAX_DAILY_LOSS: "0", SAIL_VWAP_ST_LOTS: "3", SAIL_VWAP_ST_OPT_STOP_PCT: "0",
  SAIL_VWAP_ST_WARMUP_DAYS: "4",
}, () => {
  const c = E.getConfig();
  assert.deepStrictEqual([c.TRADE_RES, c.ST_PERIOD, c.ST_MULT, c.BREAKOUT_BARS], [15, 7, 1, 5]);
  assert.deepStrictEqual([c.ENTRY_START, c.ENTRY_END, c.EOD_EXIT], [600, 780, 900]);
  assert.deepStrictEqual([c.MAX_DAILY_TRADES, c.MAX_DAILY_LOSS, c.LOTS, c.OPT_STOP_PCT], [2, 0, 3, 0]);
  assert.strictEqual(E.warmupDays(), 4);
}));
test("bad env values fall back to defaults", () => withEnv({
  SAIL_VWAP_ST_TF: "7", SAIL_VWAP_ST_BREAKOUT_BARS: "0", SAIL_VWAP_ST_ENTRY_START: "25:99", SAIL_VWAP_ST_LOTS: "abc", SAIL_VWAP_ST_ST_MULT: "",
}, () => {
  const c = E.getConfig();
  assert.deepStrictEqual([c.TRADE_RES, c.BREAKOUT_BARS, c.ENTRY_START, c.LOTS, c.ST_MULT], [5, 3, 570, 1, 2]);
}));
test("qty = SAIL lots × SAIL lot size (4700), lot size from Settings", () => {
  assert.strictEqual(E.lotQty(), 4700);
  withEnv({ SAIL_VWAP_ST_LOTS: "2" }, () => assert.strictEqual(E.lotQty(), 9400));
  withEnv({ SAIL_LOT_SIZE: "5000" }, () => assert.strictEqual(E.lotQty(), 5000));
});

// ── instrument row ──────────────────────────────────────────────────────────
test("SAIL instrument: NSE:SAIL-EQ, ₹2.5 grid, monthly only, lot 4700", () => {
  const u = instrument.underlyingOf("SAIL");
  assert.strictEqual(u.key, "SAIL");
  assert.strictEqual(u.spot, "NSE:SAIL-EQ");
  assert.strictEqual(u.strikeStep, 2.5);
  assert.strictEqual(u.lotSize, 4700);
  assert.strictEqual(u.weekly, false);
  assert.strictEqual(u.expiryType, "monthly");
});
test("SAIL ATM strike on the 2.5 grid, printed without float noise", () => {
  assert.strictEqual(instrument.calcATMStrike(169.9, "CE", "SAIL"), 170);
  assert.strictEqual(instrument.calcATMStrike(168.6, "PE", "SAIL"), 167.5);
  assert.strictEqual(instrument.calcATMStrike(168.74, null, "SAIL"), 167.5);
  assert.strictEqual(String(instrument.calcATMStrike(166.3, "CE", "SAIL")), "167.5");
  withEnv({ SAIL_STRIKE_OFFSET_CE: "-2.5" }, () => assert.strictEqual(instrument.calcATMStrike(169.9, "CE", "SAIL"), 167.5));
});
test("SAIL expiry code is the monthly YYMMM form", () => {
  assert.strictEqual(instrument.expiryCodeFor(new Date(2026, 9, 27), "SAIL"), "26OCT");
  assert.strictEqual(instrument.expiryCodeFor(new Date(2026, 9, 6), "SAIL"), "26OCT");
});
test("NIFTY / BANKNIFTY rows are unchanged by the SAIL row", () => {
  const n = instrument.underlyingOf("NIFTY"), b = instrument.underlyingOf("BANKNIFTY");
  assert.strictEqual(n.strikeStep, 50); assert.strictEqual(b.strikeStep, 100);
  withEnv({ STRIKE_OFFSET_CE: "0", STRIKE_OFFSET: "" }, () => assert.strictEqual(instrument.calcATMStrike(24333, "CE"), 24350));
  withEnv({ STRIKE_OFFSET_CE: "50" }, () => assert.strictEqual(instrument.calcATMStrike(24333, "CE"), 24400));
  withEnv({ STRIKE_OFFSET_CE: "-50" }, () => assert.strictEqual(instrument.calcATMStrike(24333, "CE"), 24300));
  assert.strictEqual(instrument.underlyingOf(undefined).key, "NIFTY");
});
test("SAIL feed/health gate follows SAIL_VWAP_ST_MODE_ENABLED; indices always on", () => {
  // SAIL_PIVOT_EMA_ST (default ON) also enables SAIL, so pin it OFF to test this toggle alone.
  withEnv({ SAIL_PIVOT_EMA_ST_MODE_ENABLED: "false" }, () => assert.strictEqual(instrument.isUnderlyingEnabled("SAIL"), false));
  withEnv({ SAIL_VWAP_ST_MODE_ENABLED: "true" }, () => assert.strictEqual(instrument.isUnderlyingEnabled("SAIL"), true));
  // Either toggle is enough: SAIL_PIVOT_EMA_ST unset = ON.
  withEnv({ SAIL_VWAP_ST_MODE_ENABLED: "false" }, () => assert.strictEqual(instrument.isUnderlyingEnabled("SAIL"), true));
  assert.strictEqual(instrument.isUnderlyingEnabled("NIFTY"), true);
  assert.strictEqual(instrument.isUnderlyingEnabled("BANKNIFTY"), true);
});

// ── VWAP ────────────────────────────────────────────────────────────────────
test("VWAP = Σ hlc3·volume / Σ volume, restarting every IST day", () => {
  const cs = CE_SET();
  const v = E.computeVwap(cs), r = refVwap(cs);
  assert.strictEqual(v.length, cs.length);
  for (let i = 0; i < cs.length; i++) assert.ok(close2(v[i], r[i]), `bar ${i}: ${v[i]} vs ${r[i]}`);
  // first bar of today = its own hlc3 (yesterday does not leak in)
  const f = cs[N_PREV];
  assert.ok(close2(v[N_PREV], (f.high + f.low + f.close) / 3));
});
test("VWAP is null until the day has volume; missing/negative volume counts as 0", () => {
  const cs = CE_SET().map((c, i) => (i >= N_PREV && i < N_PREV + 2 ? Object.assign({}, c, { volume: i === N_PREV ? 0 : -5 }) : c));
  const v = E.computeVwap(cs);
  assert.strictEqual(v[N_PREV], null);
  assert.strictEqual(v[N_PREV + 1], null);
  assert.ok(Number.isFinite(v[N_PREV + 2]));
  const noVol = CE_SET().map((c) => { const x = Object.assign({}, c); delete x.volume; return x; });
  assert.ok(E.computeVwap(noVol).every((x) => x === null));
});
test("computeSeries is 1:1 with the candles and SuperTrend is the shared helper", () => {
  const cs = CE_SET(), s = E.computeSeries(cs);
  assert.strictEqual(s.vwap.length, cs.length);
  assert.strictEqual(s.supertrend.length, cs.length);
  assert.deepStrictEqual(s.supertrend, computeSuperTrend(cs, 10, 2));
  assert.deepStrictEqual(E.computeSeries([]), { vwap: [], supertrend: [] });
});

// ── the fixture really is what it claims (self-checking) ────────────────────
test("fixture: bar 4 crosses up, bars 5–7 stay above VWAP, ST green on bar 6", () => {
  const cs = CE_SET(), s = E.computeSeries(cs), k = N_PREV + 4;
  assert.ok(cs[k].close > s.vwap[k] && cs[k - 1].close <= s.vwap[k - 1], "cross at bar 4");
  for (let j = k + 1; j <= k + 3; j++) assert.ok(cs[j].close > s.vwap[j], `bar ${j - N_PREV} above VWAP`);
  assert.ok(cs[k + 1].close <= cs[k].high, "bar 5 does not break the cross high");
  assert.ok(cs[k + 2].close > cs[k].high, "bar 6 breaks the cross high");
  assert.strictEqual(s.supertrend[k + 2].trend, 1);
  assert.ok(s.supertrend[k + 2].value < cs[k + 2].close);
});

// ── entry ───────────────────────────────────────────────────────────────────
test("CE: breakout close above the cross candle's high → BUY_CE, stop = SuperTrend", () => {
  const cs = CE_SET(), end = N_PREV + 6;
  const s = E.getSignal(cs.slice(0, end + 1), { silent: true });
  const st = E.computeSeries(cs.slice(0, end + 1)).supertrend[end];
  assert.strictEqual(s.signal, "BUY_CE", s.reason);
  assert.strictEqual(s.stopLoss, Math.round(st.value * 100) / 100);
  assert.ok(s.stopLoss < cs[end].close);
  assert.strictEqual(s.crossLevel, 167.4);
  assert.strictEqual(s.setup.status, "confirmed");
  assert.strictEqual(s.setup.side, "CE");
  assert.strictEqual(s.crossTime, cs[N_PREV + 4].time);
  assert.ok(/cross high 167\.4/.test(s.reason));
});
test("waiting bar: cross happened, no breakout close yet → NONE with the level to beat", () => {
  const cs = CE_SET(), end = N_PREV + 5;
  const s = E.getSignal(cs.slice(0, end + 1), { silent: true });
  assert.strictEqual(s.signal, "NONE");
  assert.strictEqual(s.setup.status, "waiting");
  assert.strictEqual(s.setup.level, 167.4);
  assert.strictEqual(s.setup.barsSince, 1);
});
test("the cross candle itself is never the entry", () => {
  const cs = CE_SET(), end = N_PREV + 4;
  const s = E.getSignal(cs.slice(0, end + 1), { silent: true });
  assert.strictEqual(s.signal, "NONE");
  assert.strictEqual(s.setup.status, "waiting");
  assert.strictEqual(s.setup.barsSince, 0);
  assert.strictEqual(s.setup.side, "CE");
  assert.ok(/needs a close above 167\.4/.test(s.reason), s.reason);
});
test("only the FIRST breakout close counts — a later close above is 'used'", () => {
  const cs = CE_SET(), end = N_PREV + 7;
  const s = E.getSignal(cs.slice(0, end + 1), { silent: true });
  assert.strictEqual(s.signal, "NONE");
  assert.strictEqual(s.setup.status, "used");
});
test("a close back at/below VWAP cancels the setup", () => {
  const cs = CE_SET();
  const k5 = N_PREV + 5;
  cs[k5] = bar(cs[k5].time, 167.3, 167.3, 166.0, 166.1, 1000);   // back below VWAP
  // bar 6 still closes above the cross high, but the setup is gone
  const s = E.getSignal(cs.slice(0, N_PREV + 7), { silent: true });
  assert.notStrictEqual(s.signal, "BUY_CE");
});
test("BREAKOUT_BARS is honoured: 1 → bar 6 is too late; 2 → it confirms", () => {
  const cs = CE_SET().slice(0, N_PREV + 7);
  withEnv({ SAIL_VWAP_ST_BREAKOUT_BARS: "1" }, () => {
    assert.strictEqual(E.getSignal(cs, { silent: true }).signal, "NONE");
    const atFive = E.getSignal(cs.slice(0, N_PREV + 6), { silent: true });
    assert.strictEqual(atFive.setup.status, "expired");
  });
  withEnv({ SAIL_VWAP_ST_BREAKOUT_BARS: "2" }, () => assert.strictEqual(E.getSignal(cs, { silent: true }).signal, "BUY_CE"));
});
test("SuperTrend disagreeing → skipped, never entered", () => {
  const cs = CE_SET().slice(0, N_PREV + 7), cfg = E.getConfig();
  const series = E.computeSeries(cs, cfg);
  const red = series.supertrend.slice();
  red[cs.length - 1] = { value: cs[cs.length - 1].close + 1, trend: -1 };
  const s = E.getSignal(cs, { silent: true, precomputed: { series: { vwap: series.vwap, supertrend: red }, endIdx: cs.length - 1, cfg } });
  assert.strictEqual(s.signal, "NONE");
  assert.strictEqual(s.skipReason, "st_disagrees");
  // green trend but line ABOVE the close is also refused (no protective stop)
  const bad = series.supertrend.slice();
  bad[cs.length - 1] = { value: cs[cs.length - 1].close + 0.5, trend: 1 };
  assert.strictEqual(E.getSignal(cs, { silent: true, precomputed: { series: { vwap: series.vwap, supertrend: bad }, endIdx: cs.length - 1, cfg } }).signal, "NONE");
});
test("entry window on the signal candle's close time", () => {
  const cs = CE_SET().slice(0, N_PREV + 7);   // signal candle closes 09:50
  withEnv({ SAIL_VWAP_ST_ENTRY_START: "10:00" }, () => {
    const s = E.getSignal(cs, { silent: true });
    assert.strictEqual(s.signal, "NONE");
    assert.strictEqual(s.skipReason, "window");
  });
  withEnv({ SAIL_VWAP_ST_ENTRY_END: "09:45" }, () => assert.strictEqual(E.getSignal(cs, { silent: true }).signal, "NONE"));
  withEnv({ SAIL_VWAP_ST_ENTRY_START: "09:50" }, () => assert.strictEqual(E.getSignal(cs, { silent: true }).signal, "BUY_CE"));
});

/** Mirror a CE fixture into a PE one: price p → 400 − p (high/low swap). */
function mirror(cs) {
  return cs.map((c) => bar(c.time, 400 - c.open, 400 - c.low, 400 - c.high, 400 - c.close, c.volume));
}
test("PE mirror: close below the cross candle's low with SuperTrend red → BUY_PE", () => {
  const cs = mirror(CE_SET()), end = N_PREV + 6;
  const s = E.getSignal(cs.slice(0, end + 1), { silent: true });
  assert.strictEqual(s.signal, "BUY_PE", s.reason);
  assert.ok(s.stopLoss > cs[end].close);
  assert.strictEqual(s.crossLevel, Math.round((400 - 167.4) * 100) / 100);
  assert.strictEqual(s.setup.side, "PE");
});
test("a VWAP cross needs both candles on the same day (VWAP restarts)", () => {
  const cs = CE_SET(), s = E.computeSeries(cs);
  // today's bar 0 vs yesterday's last bar is never a cross, whatever the prices:
  // here bar 0 closes above its VWAP and yesterday's last close was far below
  // today's VWAP — a cross if days were joined, but not a setup.
  assert.ok(cs[N_PREV].close >= s.vwap[N_PREV] - 1e-9 && cs[N_PREV - 1].close < s.vwap[N_PREV]);
  assert.strictEqual(E.findSetup(cs, s.vwap, N_PREV, E.getConfig()), null);
});
test("CE and PE never both fire; walking the day yields exactly one signal", () => {
  const cs = CE_SET();
  const sigs = [];
  for (let i = E.warmupBars(); i < cs.length; i++) {
    const s = E.getSignal(cs.slice(0, i + 1), { silent: true });
    if (s.signal !== "NONE") sigs.push([i, s.signal]);
  }
  assert.deepStrictEqual(sigs, [[N_PREV + 6, "BUY_CE"]]);
});

// ── refusals / guards ───────────────────────────────────────────────────────
test("warm-up: fewer than warmupBars candles → refuse", () => {
  const s = E.getSignal(CE_SET().slice(0, 10), { silent: true });
  assert.strictEqual(s.signal, "NONE"); assert.strictEqual(s.warmup, true);
  assert.strictEqual(E.getSignal(null).warmup, true);
  assert.strictEqual(E.getSignal([]).warmup, true);
});
test("no volume today → no VWAP → refuse (never guess)", () => {
  const cs = CE_SET().map((c, i) => (i >= N_PREV ? Object.assign({}, c, { volume: 0 }) : c)).slice(0, N_PREV + 7);
  const s = E.getSignal(cs, { silent: true });
  assert.strictEqual(s.signal, "NONE"); assert.strictEqual(s.warmup, true);
  assert.ok(/No VWAP/.test(s.reason));
});
test("non-finite OHLC on the signal candle → refuse", () => {
  const cs = CE_SET().slice(0, N_PREV + 7);
  cs[cs.length - 1] = Object.assign({}, cs[cs.length - 1], { close: NaN });
  assert.strictEqual(E.getSignal(cs, { silent: true }).warmup, true);
  const cs2 = CE_SET().slice(0, N_PREV + 7);
  cs2[cs2.length - 1] = Object.assign({}, cs2[cs2.length - 1], { close: null });
  assert.strictEqual(E.getSignal(cs2, { silent: true }).signal, "NONE");
});
test("precomputed series gives the identical decision at every bar", () => {
  const cs = CE_SET().concat(mirror(CE_SET()).map((c) => Object.assign({}, c, { time: c.time + 86400 * 4 })));
  const cfg = E.getConfig(), series = E.computeSeries(cs, cfg);
  for (let i = E.warmupBars(); i < cs.length; i++) {
    const a = E.getSignal(cs.slice(0, i + 1), { silent: true });
    const b = E.getSignal(cs, { silent: true, precomputed: { series, endIdx: i, cfg } });
    assert.strictEqual(a.signal, b.signal, `bar ${i}`);
    assert.strictEqual(a.stopLoss, b.stopLoss, `bar ${i}`);
    assert.strictEqual(a.reason, b.reason, `bar ${i}`);
  }
});

// ── exits ───────────────────────────────────────────────────────────────────
const B = (c) => bar(ist(DAY, 11, 0), c, c + 0.1, c - 0.1, c, 100);
test("CE exits: SuperTrend flip red, or close below the trailed stop", () => {
  assert.strictEqual(E.exitCheck("CE", B(170), { value: 170.5, trend: -1 }, 169).exit, true);
  assert.ok(/flipped red/.test(E.exitCheck("CE", B(170), { value: 170.5, trend: -1 }, 169).reason));
  assert.strictEqual(E.exitCheck("CE", B(168.9), { value: 168.5, trend: 1 }, 169).exit, true);
  assert.ok(/SuperTrend stop/.test(E.exitCheck("CE", B(168.9), { value: 168.5, trend: 1 }, 169).reason));
  assert.strictEqual(E.exitCheck("CE", B(169), { value: 168.5, trend: 1 }, 169).exit, false);   // equal is not below
  assert.strictEqual(E.exitCheck("CE", B(170), { value: 169.5, trend: 1 }, 169).exit, false);
});
test("PE exits: SuperTrend flip green, or close above the trailed stop", () => {
  assert.strictEqual(E.exitCheck("PE", B(168), { value: 167.5, trend: 1 }, 169).exit, true);
  assert.strictEqual(E.exitCheck("PE", B(169.1), { value: 169.5, trend: -1 }, 169).exit, true);
  assert.strictEqual(E.exitCheck("PE", B(168), { value: 168.5, trend: -1 }, 169).exit, false);
});
test("exit null guards: a null stop or bad bar never exits by itself", () => {
  assert.strictEqual(E.exitCheck("CE", B(1), { value: 0.5, trend: 1 }, null).exit, false);   // spot >= null must not fire
  assert.strictEqual(E.exitCheck("PE", B(1e6), { value: 2e6, trend: -1 }, undefined).exit, false);
  assert.strictEqual(E.exitCheck("CE", { time: 1, open: 1, high: 1, low: 1, close: NaN }, { trend: -1 }, 5).exit, false);
  assert.strictEqual(E.exitCheck("CE", B(170), null, 169).exit, false);
  assert.strictEqual(E.exitCheck("XX", B(170), { value: 1, trend: -1 }, 169).exit, false);
});
test("trail is tighten-only and follows SuperTrend on its own side", () => {
  const cs = CE_SET(), cfg = E.getConfig();
  const st = computeSuperTrend(cs, 10, 2), last = cs.length - 1;
  const lvl = Math.round(st[last].value * 100) / 100;
  const t = E.trailStop(cs, "CE", 100, cfg);
  assert.strictEqual(t.changed, true); assert.strictEqual(t.stop, lvl);
  const same = E.trailStop(cs, "CE", lvl + 0.5, cfg);   // never loosens
  assert.strictEqual(same.changed, false); assert.strictEqual(same.stop, lvl + 0.5);
  assert.strictEqual(E.trailStop(cs, "PE", 300, cfg).changed, false);   // green line never trails a PE
  assert.strictEqual(E.trailStop(cs.slice(0, 5), "CE", 100, cfg).changed, false);
  assert.deepStrictEqual(E.trailStop(cs, "CE", 100, cfg, { supertrend: st, endIdx: last }), t);
});
test("PE trail tightens downward only", () => {
  const cs = mirror(CE_SET()), cfg = E.getConfig();
  const t = E.trailStop(cs, "PE", 500, cfg);
  assert.strictEqual(t.changed, true); assert.ok(t.stop > cs[cs.length - 1].close && t.stop < 500);
  assert.strictEqual(E.trailStop(cs, "PE", t.stop - 0.5, cfg).changed, false);
});
test("EOD square-off at 15:15", () => {
  assert.strictEqual(E.isEodExit(ist(DAY, 15, 14)), false);
  assert.strictEqual(E.isEodExit(ist(DAY, 15, 15)), true);
});
test("walk: entry once, stop below every close while held, trail never loosens", () => {
  const cs = CE_SET(), cfg = E.getConfig();
  let pos = null;
  for (let i = E.warmupBars(); i < cs.length; i++) {
    const c = cs.slice(0, i + 1);
    if (!pos) {
      const s = E.getSignal(c, { silent: true });
      if (s.signal === "BUY_CE") pos = { stop: s.stopLoss };
    } else {
      const stb = E.computeSeries(c, cfg).supertrend[i];
      if (E.exitCheck("CE", c[i], stb, pos.stop).exit) { pos = null; continue; }
      const t = E.trailStop(c, "CE", pos.stop, cfg);
      assert.ok(t.stop >= pos.stop); pos.stop = t.stop;
      assert.ok(pos.stop < c[i].close);
    }
  }
});

console.log(`\nSAIL_VWAP_ST: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

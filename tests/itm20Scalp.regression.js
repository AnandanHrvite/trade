#!/usr/bin/env node
/**
 * ITM20_SCALP — RULE INVARIANTS
 *
 *   node tests/itm20Scalp.regression.js
 *
 * Zero dependencies, exits non-zero on failure. No socket, no broker. HOME is
 * pointed at a temp dir BEFORE anything is required, so the paper-route exit
 * tests can never write into the real ~/trading-data.
 *
 * Rules (user-confirmed 2026-11-08): 09:15–09:30 range; CE = 5-min close above
 * the high with close > VWAP, EMA9 > VWAP, EMA9 rising → retest (low within 5pt
 * of the high) within 3 candles, never closing back inside → green candle
 * closing above the previous high; PE mirrors. 1 strike ITM. +20 / −10 premium.
 * Max 2 trades, stop after a win / 2 losses / −20 pts. Entries 09:30–11:30,
 * square-off 15:15, expiry day skipped by default.
 */

process.env.TZ = "Asia/Calcutta";
const os = require("os");
const fs = require("fs");
const path = require("path");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "itm20-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
for (const k of Object.keys(process.env)) if (k.startsWith("ITM20_SCALP_") || k.startsWith("TG_")) delete process.env[k];
process.env.PROFIT_LOCK_ENABLED = "false";
process.env.PREMIUM_SL_ENABLED = "false";
process.env.EXIT_REENTRY_COOLDOWN_CANDLES = "0";
process.env.BACKTEST_SLIPPAGE_PTS = "1.5";
process.env.BACKTEST_SEED_PREMIUM = "200";
process.env.BACKTEST_DELTA = "0.5";
process.env.BACKTEST_THETA_DAY = "0";

const assert = require("assert");
const { EMA } = require("technicalindicators");
const strat = require("../src/strategies/itm20_scalp");

let passed = 0, failed = 0;
let _chain = Promise.resolve();
function test(name, fn) {
  _chain = _chain.then(async () => {
    try { await fn(); passed++; }
    catch (e) { failed++; console.error(`✗ ${name}\n    ${e.message}`); }
  });
}

// ── fixtures ────────────────────────────────────────────────────────────────
function ist(date, hh, mm) {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d, hh, mm) - 19800 * 1000) / 1000);
}
const Y = "2026-11-02", D = "2026-11-03";
/** Flat full session at `base`. */
function flatDay(date, base) {
  const out = [];
  for (let t = 9 * 60 + 15; t < 15 * 60 + 30; t += 5) out.push({ time: ist(date, Math.floor(t / 60), t % 60), open: base, high: base + 2, low: base - 2, close: base });
  return out;
}
function bar(hh, mm, o, h, l, c, date) { return { time: ist(date || D, hh, mm), open: o, high: h, low: l, close: c }; }

/**
 * CE day: range H 24020 / L 23900 · 09:30 breakout close 24035 · 09:35 retest
 * (low 24022, red) · 09:40 green close 24045 above 09:35's high 24038 → signal.
 */
function ceToday(over) {
  const o = over || {};
  const bars = [
    bar(9, 15, 24000, 24020, 23900, 24010),
    bar(9, 20, 24010, 24015, 23950, 24005),
    bar(9, 25, 24005, 24018, 23960, 24012),
    bar(9, 30, 24012, 24040, 24010, 24035),
    o.b935 || bar(9, 35, 24035, 24038, 24022, 24030),
    o.b940 || bar(9, 40, 24030, 24050, 24028, 24045),
  ];
  return bars.concat(o.after || []);
}
function upTo(bars, hh, mm) { const t = ist(D, hh, mm); return bars.filter(b => b.time <= t); }
/** Mirror prices around 24000 (CE fixture → PE fixture). */
function mirror(bars) {
  return bars.map(b => ({ time: b.time, open: 48000 - b.open, high: 48000 - b.low, low: 48000 - b.high, close: 48000 - b.close }));
}
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}
const yday = flatDay(Y, 24000);

// ── indicators ──────────────────────────────────────────────────────────────
test("EMA alignment: out[i] ↔ values[i+p-1], first p-1 are null", () => {
  const all = yday.concat(ceToday());
  const S = strat.computeSeries(all, strat.getConfig());
  const ref = EMA.calculate({ period: 9, values: S.bars.map(b => b.close) });
  for (let i = 0; i < 8; i++) assert.strictEqual(S.ema[i], null);
  assert.strictEqual(S.ema[8], ref[0]);
  assert.strictEqual(S.ema[S.ema.length - 1], ref[ref.length - 1]);
  assert.strictEqual(S.ema.length, S.bars.length);
});
test("EMA period is configurable", () => withEnv({ ITM20_SCALP_EMA_PERIOD: "5" }, () => {
  const S = strat.computeSeries(yday.concat(ceToday()), strat.getConfig());
  assert.strictEqual(S.ema[3], null); assert.ok(typeof S.ema[4] === "number");
}));
test("VWAP = equal-weight running mean of HLC3, reset each day", () => {
  const S = strat.computeSeries(yday.concat(ceToday()), strat.getConfig());
  const today = S.bars.map((b, i) => ({ b, i })).filter(x => strat._istDayOf(x.b.time) === strat._istDayOf(ist(D, 9, 15)));
  const first = today[0];
  assert.ok(Math.abs(S.vwap[first.i] - (24020 + 23900 + 24010) / 3) < 1e-9);
  const hlc = today.slice(0, 4).map(x => (x.b.high + x.b.low + x.b.close) / 3);
  assert.ok(Math.abs(S.vwap[today[3].i] - hlc.reduce((a, b) => a + b, 0) / 4) < 1e-9);
  assert.ok(Math.abs(S.vwap[0] - 24000) < 1e-9, "yesterday's VWAP is its own");
});
test("window is previous session + today only (older days ignored)", () => {
  const older = flatDay("2026-10-30", 30000);
  const a = strat.computeSeries(yday.concat(ceToday()), strat.getConfig());
  const b = strat.computeSeries(older.concat(yday, ceToday()), strat.getConfig());
  assert.deepStrictEqual(a.ema, b.ema);
  assert.deepStrictEqual(a.vwap, b.vwap);
});

// ── opening range + warm-up ─────────────────────────────────────────────────
test("opening range is the 09:15–09:30 high/low; nothing before 09:30", () => {
  const all = yday.concat(ceToday());
  const s925 = strat.getSignal(upTo(all, 9, 25), { silent: true });
  assert.strictEqual(s925.signal, "NONE"); assert.ok(/still forming/.test(s925.reason));
  const s930 = strat.getSignal(upTo(all, 9, 30), { silent: true });
  assert.strictEqual(s930.orHigh, 24020); assert.strictEqual(s930.orLow, 23900);
});
test("incomplete opening range → no trade today", () => {
  const t = ceToday().filter(b => b.time !== ist(D, 9, 20));
  const s = strat.getSignal(yday.concat(t), { silent: true });
  assert.strictEqual(s.signal, "NONE"); assert.ok(s.dayDead);
});
test("no previous session → warm-up refusal", () => {
  const s = strat.getSignal(ceToday(), { silent: true });
  assert.ok(s.warmup); assert.strictEqual(s.signal, "NONE");
});
test("incomplete previous session → warm-up refusal", () => {
  const s = strat.getSignal(yday.slice(0, 20).concat(ceToday()), { silent: true });
  assert.ok(s.warmup); assert.ok(/incomplete/.test(s.reason));
});
test("bad latest bar → refuse", () => {
  const s = strat.getSignal(yday.concat(ceToday(), [{ time: ist(D, 9, 45), open: null, high: 1, low: 1, close: 1 }]), { silent: true });
  assert.strictEqual(s.signal, "NONE");
});

// ── CE entry ────────────────────────────────────────────────────────────────
test("CE: breakout at 09:30 arms, 09:35 retest, 09:40 confirm fires BUY_CE", () => {
  const all = yday.concat(ceToday());
  const s930 = strat.getSignal(upTo(all, 9, 30), { silent: true });
  assert.strictEqual(s930.phase, "up"); assert.strictEqual(s930.breakoutTime, ist(D, 9, 30)); assert.strictEqual(s930.retestTime, null);
  const s935 = strat.getSignal(upTo(all, 9, 35), { silent: true });
  assert.strictEqual(s935.signal, "NONE"); assert.strictEqual(s935.retestTime, ist(D, 9, 35));
  const s940 = strat.getSignal(all, { silent: true });
  assert.strictEqual(s940.signal, "BUY_CE"); assert.strictEqual(s940.side, "CE");
  assert.strictEqual(s940.entrySpot, 24045); assert.strictEqual(s940.signalBarTime, ist(D, 9, 40));
  assert.ok(s940.ema > s940.vwap);
});
test("CE: retest must come within tolerance (5pt default, configurable)", () => withEnv({}, async () => {
  const t = ceToday({ b935: bar(9, 35, 24035, 24040, 24030, 24033), b940: bar(9, 40, 24033, 24050, 24028, 24045) });
  assert.strictEqual(strat.getSignal(yday.concat(t), { silent: true }).signal, "NONE");
  await withEnv({ ITM20_SCALP_RETEST_TOL_PTS: "10" }, () => {
    assert.strictEqual(strat.getSignal(yday.concat(t), { silent: true }).signal, "BUY_CE");
  });
}));
test("CE: a close back inside the range kills the setup", () => {
  const t = ceToday({ b935: bar(9, 35, 24035, 24038, 24012, 24018) });
  const s = strat.getSignal(yday.concat(t), { silent: true });
  assert.strictEqual(s.signal, "NONE");
  assert.ok(s.breakoutTime == null || s.breakoutTime === ist(D, 9, 40), "the old setup is gone");
});
test("CE: confirmation must be green and close above the previous high", () => {
  const red = ceToday({ b940: bar(9, 40, 24048, 24050, 24028, 24040) });
  assert.strictEqual(strat.getSignal(yday.concat(red), { silent: true }).signal, "NONE");
  const low = ceToday({ b940: bar(9, 40, 24030, 24037, 24028, 24036) });
  assert.strictEqual(strat.getSignal(yday.concat(low), { silent: true }).signal, "NONE");
});
test("CE: the retest candle itself can confirm", () => {
  // 09:30 breakout, 09:35 dips to 24024 and closes green above 09:30's high 24040.
  const t = ceToday({ b935: bar(9, 35, 24030, 24060, 24024, 24055), b940: bar(9, 40, 24055, 24056, 24050, 24052) });
  const s = strat.getSignal(upTo(yday.concat(t), 9, 35), { silent: true });
  assert.strictEqual(s.signal, "BUY_CE"); assert.strictEqual(s.retestTime, ist(D, 9, 35));
});
test("CE: no confirmation within 3 candles → expired, needs a close back inside", () => {
  const t = ceToday({
    b940: bar(9, 40, 24030, 24036, 24026, 24031),
    after: [bar(9, 45, 24031, 24036, 24026, 24030), bar(9, 50, 24030, 24060, 24029, 24058)],
  });
  const s945 = strat.getSignal(upTo(yday.concat(t), 9, 45), { silent: true });
  assert.strictEqual(s945.signal, "NONE"); assert.strictEqual(s945.phase, "need_inside"); assert.ok(/expired/.test(s945.reason));
  const s950 = strat.getSignal(yday.concat(t), { silent: true });
  assert.strictEqual(s950.signal, "NONE"); assert.strictEqual(s950.phase, "need_inside");
});
test("CE: breakout needs EMA9 rising and above VWAP", () => {
  // Same day after a high previous session → EMA9 above but FALLING into the breakout.
  const s = strat.getSignal(flatDay(Y, 24300).concat(ceToday()), { silent: true });
  assert.strictEqual(s.signal, "NONE"); assert.notStrictEqual(s.phase, "up");
});
test("CE: retest candles window is configurable", () => withEnv({ ITM20_SCALP_RETEST_CANDLES: "1" }, () => {
  assert.strictEqual(strat.getSignal(yday.concat(ceToday()), { silent: true }).signal, "NONE");
}));
test("entry cut-off: confirm candle must close by ENTRY_END", async () => {
  await withEnv({ ITM20_SCALP_ENTRY_END: "09:40" }, () => {
    assert.strictEqual(strat.getSignal(yday.concat(ceToday()), { silent: true }).signal, "NONE");
  });
  await withEnv({ ITM20_SCALP_ENTRY_END: "09:45" }, () => {
    assert.strictEqual(strat.getSignal(yday.concat(ceToday()), { silent: true }).signal, "BUY_CE");
  });
});
test("entry start: no breakout candle before ENTRY_START", () => withEnv({ ITM20_SCALP_ENTRY_START: "09:35" }, () => {
  assert.strictEqual(strat.getSignal(yday.concat(ceToday()), { silent: true }).signal, "NONE");
}));

// ── PE entry ────────────────────────────────────────────────────────────────
test("PE: the mirrored day fires BUY_PE at 09:40", () => {
  const all = mirror(yday.concat(ceToday()));
  const s = strat.getSignal(all, { silent: true });
  assert.strictEqual(s.signal, "BUY_PE"); assert.strictEqual(s.side, "PE");
  assert.strictEqual(s.orLow, 48000 - 24020); assert.ok(s.ema < s.vwap);
  assert.strictEqual(strat.getSignal(mirror(upTo(yday.concat(ceToday()), 9, 35)), { silent: true }).signal, "NONE");
});
test("PE: a close back inside kills the PE setup", () => {
  const t = mirror(yday.concat(ceToday({ b935: bar(9, 35, 24035, 24038, 24012, 24018) })));
  assert.strictEqual(strat.getSignal(t, { silent: true }).signal, "NONE");
});

// ── resume after a trade / no look-ahead ────────────────────────────────────
test("after a trade, the scan resumes needing a close back inside", () => {
  const t = ceToday({ after: [bar(9, 45, 24045, 24070, 24044, 24065), bar(9, 50, 24065, 24070, 24010, 24015), bar(9, 55, 24015, 24045, 24014, 24040)] });
  const all = yday.concat(t);
  const s945 = strat.getSignal(upTo(all, 9, 45), { silent: true, resumeAfterSec: ist(D, 9, 47) });
  assert.strictEqual(s945.phase, "need_inside");
  const s950 = strat.getSignal(upTo(all, 9, 50), { silent: true, resumeAfterSec: ist(D, 9, 47) });
  assert.strictEqual(s950.phase, "armed", "09:50 closed inside → re-armed");
  const s955 = strat.getSignal(all, { silent: true, resumeAfterSec: ist(D, 9, 47) });
  assert.strictEqual(s955.breakoutTime === ist(D, 9, 55) || s955.phase !== "up", true);
});
test("a signal on an earlier bar is reported as missed, never re-fired", () => {
  const all = yday.concat(ceToday({ after: [bar(9, 45, 24045, 24060, 24040, 24055)] }));
  const s = strat.getSignal(all, { silent: true });
  assert.strictEqual(s.signal, "NONE"); assert.strictEqual(s.missedSignalTime, ist(D, 9, 40));
});
test("no look-ahead: a decision never changes when later bars are appended or altered", () => {
  const base = yday.concat(ceToday());
  const sigA = strat.getSignal(base, { silent: true });
  const future = base.concat([bar(9, 45, 25000, 26000, 20000, 21000), bar(9, 50, 1, 99999, 1, 5)]);
  const sliced = future.slice(0, base.length);
  const sigB = strat.getSignal(sliced, { silent: true });
  assert.deepStrictEqual({ ...sigA, cfg: null }, { ...sigB, cfg: null });
  const SA = strat.computeSeries(base, strat.getConfig()), SF = strat.computeSeries(future, strat.getConfig());
  for (let i = 0; i < SA.bars.length; i++) {
    assert.strictEqual(SA.ema[i], SF.ema[i]); assert.strictEqual(SA.vwap[i], SF.vwap[i]);
  }
});

// ── strike ──────────────────────────────────────────────────────────────────
test("ITM strike: exactly one listed strike in the money", () => {
  assert.strictEqual(strat.itmStrike(24590, "CE", 50), 24550);
  assert.strictEqual(strat.itmStrike(24560, "CE", 50), 24550);
  assert.strictEqual(strat.itmStrike(24550, "CE", 50), 24500);
  assert.strictEqual(strat.itmStrike(24560, "PE", 50), 24600);
  assert.strictEqual(strat.itmStrike(24510, "PE", 50), 24550);
  assert.strictEqual(strat.itmStrike(24600, "PE", 50), 24650);
  assert.strictEqual(strat.itmStrike(24590, "CE", 100), 24500);
  assert.strictEqual(strat.itmStrike(null, "CE", 50), null);
  assert.strictEqual(strat.itmStrike(24590, "XX", 50), null);
  assert.strictEqual(strat.itmStrike(24590, "CE", 0), null);
});

// ── exits + day limits ──────────────────────────────────────────────────────
test("target = entry + 20, stop = entry − 10", () => {
  assert.strictEqual(strat.targetLevel(150), 170);
  assert.deepStrictEqual(strat.stopLevel(150, 0), { level: 140, kind: "SL" });
  assert.deepStrictEqual(strat.stopLevel(150, -5), { level: 140, kind: "SL" });
  assert.strictEqual(strat.targetLevel(null), null);
  assert.strictEqual(strat.stopLevel(null, 0).level, null);
});
test("daily loss cap tightens (never widens) the second stop", () => {
  assert.deepStrictEqual(strat.stopLevel(150, -13), { level: 143, kind: "DAILY_LOSS" });
});
test("day gate: win stops, one loss allows one more, two losses stop, −20 stops, max trades", () => {
  assert.ok(strat.dayRiskGate([]).allowed);
  const w = strat.dayRiskGate([{ points: 18 }]); assert.ok(!w.allowed); assert.strictEqual(w.status, "TARGET_DONE");
  const l1 = strat.dayRiskGate([{ points: -10 }]); assert.ok(l1.allowed); assert.strictEqual(l1.status, "ONE_LOSS");
  const l2 = strat.dayRiskGate([{ points: -5 }, { points: -5 }]); assert.ok(!l2.allowed); assert.strictEqual(l2.status, "TWO_LOSSES");
  const cap = strat.dayRiskGate([{ points: -21 }]); assert.ok(!cap.allowed); assert.strictEqual(cap.status, "LOSS_CAP");
  const flat = strat.dayRiskGate([{ points: 0 }, { points: 0 }]); assert.ok(!flat.allowed); assert.strictEqual(flat.status, "MAX_TRADES");
  assert.ok(strat.dayRiskGate([{ points: NaN }]).allowed, "NaN points count as 0, never as a price");
});
test("config: targets/stops/limits are env-driven with safe fallbacks", () => withEnv({
  ITM20_SCALP_TARGET_PTS: "30", ITM20_SCALP_SL_PTS: "abc", ITM20_SCALP_MAX_TRADES: "9", ITM20_SCALP_DAILY_LOSS_PTS: "-4",
}, () => {
  const c = strat.getConfig();
  assert.strictEqual(c.targetPts, 30); assert.strictEqual(c.slPts, 10); assert.strictEqual(c.maxTrades, 2); assert.strictEqual(c.dailyLossPts, 20);
  assert.strictEqual(c.tradeExpiryDay, false);
}));

// ── backtest ────────────────────────────────────────────────────────────────
const bt = require("../src/routes/itm20ScalpBacktest");
const noExpiry = async () => false;
function dayWith(after) {
  const t = ceToday({ after: after || [] });
  const last = t[t.length - 1];
  const out = t.slice();
  const lastMin = strat._utcSecToIstMins(last.time);
  for (let m = lastMin + 5; m < 15 * 60 + 30; m += 5) out.push({ time: ist(D, Math.floor(m / 60), m % 60), open: last.close, high: last.close + 1, low: last.close - 1, close: last.close });
  return yday.concat(out);
}
async function runBt(bars, extra) { return bt.runItm20ScalpBacktest(bars, D, Object.assign({ isExpiryDate: noExpiry }, extra || {})); }

test("backtest: fill at next bar open, target exit = +20 − 3 slippage", async () => {
  // Entry 09:45 open 24045; +20 premium at δ 0.5 = +40 spot → 24085.
  const r = await runBt(dayWith([bar(9, 45, 24045, 24090, 24040, 24080)]));
  assert.strictEqual(r.trades.length, 1);
  const t = r.trades[0];
  assert.strictEqual(t.side, "CE"); assert.strictEqual(t.ePrice, 24045); assert.strictEqual(t.eOpt, 200);
  assert.strictEqual(t.exitCode, "TARGET"); assert.strictEqual(t.points, 17); assert.strictEqual(t.strike, 24000);
  assert.ok(t.pnl < t.grossPnl, "charges are deducted");
});
test("backtest: stop exit = −10 − 3 slippage", async () => {
  const r = await runBt(dayWith([bar(9, 45, 24045, 24050, 24020, 24030)]));
  assert.strictEqual(r.trades[0].exitCode, "SL"); assert.strictEqual(r.trades[0].points, -13);
});
test("backtest: a bar touching both target and stop is a STOP", async () => {
  const r = await runBt(dayWith([bar(9, 45, 24045, 24100, 24000, 24090)]));
  assert.strictEqual(r.trades[0].exitCode, "SL");
});
test("backtest: a bar opening through the stop fills at the open (worse)", async () => {
  const r = await runBt(dayWith([bar(9, 45, 24045, 24050, 24040, 24046), bar(9, 50, 24000, 24005, 23995, 24000)]));
  assert.strictEqual(r.trades[0].exitCode, "SL"); assert.strictEqual(r.trades[0].points, -25.5);
});
test("backtest: nothing hit → square-off at 15:15", async () => {
  const r = await runBt(dayWith([bar(9, 45, 24045, 24050, 24040, 24046)]));
  const t = r.trades[0];
  assert.strictEqual(t.exitCode, "SQUARE_OFF"); assert.ok(/15:15:00/.test(t.exit));
});
test("backtest: no second trade after a win", async () => {
  // Target at 09:45, then a fresh inside → breakout → retest → confirm later.
  const r = await runBt(dayWith([
    bar(9, 45, 24045, 24090, 24040, 24080),
    bar(9, 50, 24080, 24081, 24010, 24015),
    bar(9, 55, 24015, 24040, 24014, 24038), bar(10, 0, 24038, 24040, 24021, 24030), bar(10, 5, 24030, 24060, 24029, 24055),
  ]));
  assert.strictEqual(r.trades.length, 1); assert.strictEqual(r.dayStops.TARGET_DONE, 1);
});
test("backtest: after one loss a second setup trades, with the tightened day-cap stop", async () => {
  const r = await runBt(dayWith([
    bar(9, 45, 24045, 24050, 24020, 24030),                          // SL (−13)
    bar(9, 50, 24030, 24031, 24010, 24015),                          // back inside → re-armed
    bar(9, 55, 24015, 24060, 24014, 24055),                          // breakout
    bar(10, 0, 24055, 24058, 24023, 24050),                          // retest
    bar(10, 5, 24050, 24075, 24049, 24070),                          // confirm
  ]));
  assert.strictEqual(r.trades.length, 2, JSON.stringify(r.trades.map(t => t.exitCode)));
  assert.strictEqual(r.trades[1].sl, 193, "200 − (20 − 13)");
  assert.ok(r.trades.reduce((a, t) => a + t.points, 0) >= -20 - 3 - 1e-9, "day loss stays at the cap (+ slippage)");
});
test("backtest: expiry day skipped by default, traded when enabled", async () => {
  const bars = dayWith([bar(9, 45, 24045, 24090, 24040, 24080)]);
  const yes = async (d) => d === D;
  const r1 = await bt.runItm20ScalpBacktest(bars, D, { isExpiryDate: yes });
  assert.strictEqual(r1.trades.length, 0); assert.strictEqual(r1.funnel.expirySkipped, 1);
  await withEnv({ ITM20_SCALP_TRADE_EXPIRY_DAY: "true" }, async () => {
    const r2 = await bt.runItm20ScalpBacktest(bars, D, { isExpiryDate: yes });
    assert.strictEqual(r2.trades.length, 1);
  });
});
test("backtest: warm-up runway never trades; report + CSV", async () => {
  const r = await runBt(dayWith([bar(9, 45, 24045, 24090, 24040, 24080)]));
  assert.ok(r.trades.every(t => strat._istDateStr(t.entryTs) === D));
  const rep = bt.buildReport(r.trades);
  assert.strictEqual(rep.bySide.CE.n, 1); assert.strictEqual(rep.months[0].key, "2026-11"); assert.strictEqual(rep.times[0].key, "09:30");
  const csv = bt.toCsv(r.trades);
  assert.ok(csv.split("\r\n")[0].startsWith("Entry time,Exit time,Side"));
  assert.strictEqual(csv.trim().split("\r\n").length, 2);
  assert.strictEqual(bt.buildReport([{ pnl: -1, entryTs: 0 }, { pnl: -1, entryTs: 0 }, { pnl: 2, entryTs: 0 }, { pnl: -1, entryTs: 0 }]).maxConsecLosses, 2);
});

// ── paper exits (no broker) ─────────────────────────────────────────────────
const paper = require("../src/routes/itm20ScalpPaper");
function paperPos(extra) {
  const s = paper._test.freshState();
  s.running = true;
  s.position = Object.assign({
    side: "CE", symbol: "NSE:NIFTY26N1024000CE", optionStrike: 24000, qty: 65,
    entrySpot: 24045, entryPrice: 24045, indexAtEntry: 24045, optionEntryLtp: 150,
    targetPrem: 170, stopPrem: 140, stopKind: "SL", peakPremium: 150,
    entryTime: "x", entryTimeMs: Date.now(), entryBarTime: 0,
    mfeSpotPts: 0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
  }, extra || {});
  s.lastTickPrice = 24050;
  paper._test.setState(s);
  return s;
}
test("paper: premium ≥ target exits TARGET", () => {
  const s = paperPos(); s.optionLtp = 170.5; paper._test.checkExits(24080);
  const st = paper._test.getState();
  assert.strictEqual(st.position, null); assert.strictEqual(st.sessionTrades[0].exitCode, "TARGET"); assert.strictEqual(st.sessionTrades[0].points, 20.5);
  assert.ok(st.dayClosed, "a win closes the day");
});
test("paper: premium ≤ stop exits SL; one loss keeps the day open", () => {
  const s = paperPos(); s.optionLtp = 139; paper._test.checkExits(24020);
  const st = paper._test.getState();
  assert.strictEqual(st.sessionTrades[0].exitCode, "SL"); assert.strictEqual(st.sessionTrades[0].points, -11);
  assert.ok(!st.dayClosed); assert.ok(typeof st.lastExitSec === "number");
});
test("paper: between the levels nothing happens; null LTP never exits", () => {
  const s = paperPos(); s.optionLtp = 160; paper._test.checkExits(24050);
  assert.ok(paper._test.getState().position);
  s.optionLtp = null; paper._test.checkExits(24050);
  assert.ok(paper._test.getState().position);
  paperPos({ stopPrem: null, targetPrem: null }).optionLtp = 1; paper._test.checkExits(24050);
  assert.ok(paper._test.getState().position, "a null level is never compared as 0");
});
test("paper: attribute quotes by symbol only", () => {
  const a = paper.attributeQuotes({ s: "ok", d: [{ n: "OTHER", v: { lp: 5 } }, { n: "SYM", v: { lp: 9 } }] }, ["SYM"], "SYM");
  assert.strictEqual(a.optLtp, 9);
});

// ── no rule duplicated in the routes ───────────────────────────────────────
test("routes never re-implement indicators or entry/exit levels", () => {
  for (const f of ["itm20ScalpPaper.js", "itm20ScalpBacktest.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", f), "utf8");
    assert.ok(!/technicalindicators|EMA\.calculate/.test(src), `${f} computes an indicator`);
    assert.ok(!/[+-]\s*cfg\.retestTolPts|orHigh\s*[<>]|orLow\s*[<>]|\.close\s*>\s*\w+\.open/.test(src), `${f} re-implements the setup`);
    assert.ok(!/(Ltp|Prem|PREMIUM|entry\w*)\s*[+-]\s*cfg\.(targetPts|slPts)/.test(src), `${f} computes exit levels itself`);
  }
});

_chain.then(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
  console.log(`\nitm20Scalp: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});

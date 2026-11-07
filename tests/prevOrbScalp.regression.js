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
 *   exit   : the global profit lock only — no stop, target or trail
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
// The 09:30-ish break candles below test the strategy's own window, not the
// Common Rules 10:00 start.
process.env.COMMON_TRADE_WINDOW_ENABLED = "false";

const assert = require("assert");
const strat = require("../src/strategies/prev_orb_scalp");

let passed = 0, failed = 0;
// Tests run strictly in order on one promise chain — the backtest runner is
// async (it yields to the event loop per session), and several tests set and
// then delete env keys, so they must never overlap.
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
  assert.strictEqual(s.candleSize, 35);
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
  assert.strictEqual(s.candleSize, 45);
  assert.strictEqual(s.breakLevel, 23100);
});

// ── window ──────────────────────────────────────────────────────────────────
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
test("unusable last candle refused", () => {
  const s = strat.getSignal(peDay().concat([{ time: ist(TODAY, 9, 30), open: 1, high: null, low: 1, close: 1 }]), { silent: true });
  assert.strictEqual(s.signal, "NONE");
});
test("empty / non-array input", () => {
  assert.strictEqual(strat.getSignal([], { silent: true }).warmup, true);
  assert.strictEqual(strat.getSignal(null, { silent: true }).warmup, true);
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

test("backtest: no stop/target — an open trade is closed at the day's last candle", async () => {
  const bars = peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22880, 22885),
    bar(TODAY, 9, 33, 22884, 22990, 22880, 22980),   // runs well past the old stop — no exit
  ]);
  const r = await runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 36, 22980), TODAY, NOLOCK);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].exitCode, "SESSION_END");
  assert.strictEqual(r.trades[0].exit.slice(-8), "15:27:00");
});

test("backtest: one trade a day, warm-up day never trades, inside-range day counted", async () => {
  const bars = peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22880, 22885),
    bar(TODAY, 9, 33, 22884, 22920, 22880, 22918),
    bar(TODAY, 9, 36, 22918, 22920, 22870, 22875),   // second close below — must NOT trade
  ]);
  const r = await runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 39, 22875), TODAY, NOLOCK);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.days, 1);
  const r2 = await runPrevOrbScalpBacktest(yesterday().concat(fillDay(orBars(23000, 23010, 22960, 22970), 9 * 60 + 30, 22970)), TODAY, NOLOCK);
  assert.strictEqual(r2.trades.length, 0);
  assert.strictEqual(r2.funnel.insideRange, 1);
});

test("backtest: simulated profit lock fires on a give-back", async () => {
  // δ 0.55, seed 260: arm +8% = +20.8 premium ≈ 37.8 spot pts; floor +5% ≈ 23.6 pts.
  const bars = peDay().concat([
    bar(TODAY, 9, 30, 22910, 22915, 22800, 22805),   // break candle
    bar(TODAY, 9, 33, 22804, 22806, 22760, 22765),   // fill 22804, favourable 44pt → arms lock
    bar(TODAY, 9, 36, 22766, 22790, 22765, 22788),   // back to 22790 → through floor (~22780)
  ]);
  const r = await runPrevOrbScalpBacktest(fillDay(bars, 9 * 60 + 39, 22788), TODAY, { lock: { enabled: true, armPct: 8, floorPct: 5 } });
  assert.strictEqual(r.trades[0].exitCode, "PROFIT_LOCK");
  assert.ok(r.trades[0].pnl > -500, `pnl ${r.trades[0].pnl}`);
});

test("backtest: empty input", async () => {
  assert.strictEqual((await runPrevOrbScalpBacktest([], "2026-01-01")).trades.length, 0);
});

// ── paper route exits (canonical) ───────────────────────────────────────────
const paper = require("../src/routes/prevOrbScalpPaper");
function paperPos(extra) {
  return Object.assign({
    isFutures: false, side: "PE", symbol: "NSE:NIFTY26MAR22900PE", qty: 75,
    entrySpot: 22885, entryPrice: 22885, optionEntryLtp: 200, entryTime: "x", entryTimeMs: Date.now(),
    entryBarTime: ist(TODAY, 9, 33), candleSize: 35, signalBarTime: ist(TODAY, 9, 30),
    peakPremium: 200, mfeSpotPts: 0, mfePnl: 0, maeSpotPts: 0, maePnl: 0, secsToMFE: 0, secsToMAE: 0,
  }, extra || {});
}
function freshRun(pos) {
  const s = paper._test.freshState();
  s.running = true; s.position = pos; s.tradesTaken = 1; s.optionLtp = 200;
  paper._test.setState(s);
  return s;
}

test("paper: no stop/target — a move either way never exits on its own", () => {
  const s = freshRun(paperPos());
  s.lastTickPrice = 22990; paper._test.checkExits(22990);   // far through the break candle's high
  assert.ok(s.position);
  s.lastTickPrice = 22700; paper._test.checkExits(22700);   // far past the old target
  assert.ok(s.position);
  s.candles = [bar(TODAY, 9, 36, 22845, 22847, 22830, 22835)];
  paper._test.onCandleClose(s.candles[0], false);           // a closed bar never exits either
  assert.ok(s.position);
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
  for (const f of ["prevOrbScalpPaper.js", "prevOrbScalpBacktest.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", f), "utf8");
    assert.ok(!/\.high\s*-\s*\w*\.low/.test(src), `${f} computes a candle size itself`);
    assert.ok(!/prevDay\.low\s*[<>]/.test(src) && !/orLow\s*[<>]/.test(src), `${f} compares setup levels itself`);
  }
});

_chain.then(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
  console.log(`\nprevOrbScalp: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});

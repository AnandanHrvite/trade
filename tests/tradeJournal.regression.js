#!/usr/bin/env node
/**
 * tradeJournal.regression.js — the per-trade journal (utils/tradeJournal), its
 * JSONL / post-exit wiring, the golden harness's observer-key rule, the
 * consolidated trade-detail join and the daily CSV + summary export.
 *
 *   node tests/tradeJournal.regression.js
 *
 * Isolated: HOME points at a temp dir before any src module loads, so nothing
 * touches ~/trading-data. No network, no broker, no timers left running.
 */

"use strict";

// UI_THEME=auto resolves by time of day; pin it so the page script under test is the same at any hour.
process.env.UI_THEME = "dark";
const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "journal-reg-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
assert.strictEqual(os.homedir(), HOME, "os.homedir() must follow HOME");
const DATA = path.join(HOME, "trading-data");
fs.mkdirSync(path.join(DATA, "post_exit"), { recursive: true });

const REPO  = path.resolve(__dirname, "..");
const UTILS = path.join(REPO, "src", "utils");
const J     = require(path.join(UTILS, "tradeJournal.js"));

let pass = 0, fail = 0;
const QUEUE = [];
function check(name, fn) { QUEUE.push({ name, fn }); }
function section(title) { QUEUE.push({ section: title }); }
async function run() {
  for (const item of QUEUE) {
    if (item.section) { console.log(`\n${item.section}`); continue; }
    try { await item.fn(); console.log(`  ✅ ${item.name}`); pass++; }
    catch (e) { console.log(`  ❌ ${item.name}\n       ${e.stack.split("\n").slice(0, 3).join("\n       ")}`); fail++; }
  }
}

const ist = (date, hms) => Date.parse(`${date}T${hms.length === 5 ? hms + ":00" : hms}+05:30`);
const DAY = "2026-11-11";
const T0 = ist(DAY, "10:00:00");
const MIN = 60000;

function opened(extra) {
  const pos = { side: "CE", qty: 65, entryTimeMs: T0 };
  J.onEntry(pos, Object.assign({ reason: "BB break + RSI 72", spot: 24000, optionLtp: 100, strategy: "BB_RSI", market: "NIFTY",
    sl: 80, target: 150, nowMs: T0 }, extra || {}));
  return pos;
}

// ─────────────────────────────────────────────────────────────────────────────
section("1. Entry snapshot");

check("entry: reason, spread, VIX, expiry → DTE, IST time, initial stop recorded", () => {
  const pos = opened({ bid: 99.5, ask: 100.5, vix: 13.456, expiry: "2026-11-13", expectedPrice: 99.8,
    indicators: { rsi: 72.123456, ema20: 23990.5, nested: { a: 1 }, fn() {} }, signal: "BB_UPPER_BREAK" });
  const e = pos.journal.entry;
  assert.strictEqual(e.ist, "10:00:00");
  assert.strictEqual(e.date, DAY);
  assert.strictEqual(e.reason, "BB break + RSI 72");
  assert.strictEqual(e.spread, 1);
  assert.strictEqual(e.spreadPct, 1);
  assert.strictEqual(e.vix, 13.46);
  assert.strictEqual(e.expiry, "2026-11-13");
  assert.strictEqual(e.dte, 2);
  assert.strictEqual(e.slippagePts, 0.2, "bought 0.2 above the wanted price = 0.2 adverse");
  assert.deepStrictEqual(e.indicators, { rsi: 72.1235, ema20: 23990.5, nested: { a: 1 } });
  assert.strictEqual(e.signal, "BB_UPPER_BREAK");
  assert.strictEqual(pos.journal.stops.length, 1);
  assert.strictEqual(pos.journal.stops[0].kind, "initial");
  assert.strictEqual(pos.journal.stops[0].to, 80);
  assert.ok(pos.journal.id.startsWith("NIFTY-BB_RSI-CE-"));
});

check("entry: expiry on the day = 0 DTE; DD-MM-YYYY and Date accepted; junk kept raw with null DTE", () => {
  assert.strictEqual(opened({ expiry: "11-11-2026" }).journal.entry.dte, 0);
  assert.strictEqual(opened({ expiry: new Date(ist("2026-11-18", "15:30")) }).journal.entry.dte, 7);
  const junk = opened({ expiry: "26N13" }).journal.entry;
  assert.strictEqual(junk.expiry, "26N13");
  assert.strictEqual(junk.dte, null);
});

check("entry: market/strategy from the logger mode when not passed", () => {
  const pos = { side: "PE" };
  J.onEntry(pos, { mode: "sail_vwap_st", nowMs: T0 });
  assert.strictEqual(pos.journal.market, "SAIL");
  assert.strictEqual(pos.journal.strategy, "SAIL_VWAP_ST");
});

check("entry: last 10 completed candles kept, Fyers rows + objects, extra numeric keys = indicators", () => {
  const candles = [];
  for (let i = 0; i < 25; i++) candles.push({ time: T0 / 1000 - (25 - i) * 300, open: 1 + i, high: 2 + i, low: i, close: 1.5 + i, volume: 100 + i, ema20: 10 + i, label: "x" });
  const fy = [[T0 / 1000 - 60, 100, 102, 99, 101, 0]];
  const pos = opened({ candles, optionCandles: fy });
  const e = pos.journal.entry;
  assert.strictEqual(e.candles.length, 10);
  assert.strictEqual(e.candles[9].c, 25.5);
  assert.deepStrictEqual(e.candles[9].ind, { ema20: 34 }, "string keys are not indicator values");
  assert.strictEqual(e.candles[9].t, "09:55");
  assert.deepStrictEqual(e.optionCandles, [{ t: "09:59", ms: T0 - 60000, o: 100, h: 102, l: 99, c: 101, v: 0 }]);
});

// ─────────────────────────────────────────────────────────────────────────────
section("2. Peak / drawdown timing");

check("peak and worst carry pts, ₹, IST time and minutes from entry; later equal values do not move them", () => {
  const pos = opened();
  const path_ = [[1, 5, 162.5], [3, -8, -260], [7, 22, 715], [9, 22, 715], [12, 4, 130], [14, -8, -260]];
  for (const [m, f, rs] of path_) J.onTick(pos, { favPts: f, pnlRs: rs, spot: 24000 + f, ltp: 100 + f / 2, nowMs: T0 + m * MIN });
  const j = pos.journal;
  assert.deepStrictEqual(j.peak, { pts: 22, rs: 715, ms: T0 + 7 * MIN, ist: "10:07:00", minFromEntry: 7 });
  assert.deepStrictEqual(j.worst, { pts: -8, rs: -260, ms: T0 + 3 * MIN, ist: "10:03:00", minFromEntry: 3 });
  assert.strictEqual(j.peakRs.rs, 715);
  assert.strictEqual(j.worstRs.ist, "10:03:00");
  assert.strictEqual(j.ticks, 6);
});

check("peak by ₹ is tracked separately from peak by points (option vs spot units)", () => {
  const pos = opened();
  J.onTick(pos, { favPts: 10, pnlRs: 300, nowMs: T0 + MIN });
  J.onTick(pos, { favPts: 8, pnlRs: 500, nowMs: T0 + 2 * MIN });   // premium rose while spot eased
  assert.strictEqual(pos.journal.peak.pts, 10);
  assert.strictEqual(pos.journal.peakRs.rs, 500);
  assert.strictEqual(pos.journal.peakRs.minFromEntry, 2);
});

check("tradePath reused on the journal's own copy: first move + 30 s path, pos top-level untouched", () => {
  const pos = opened();
  const before = Object.keys(pos).sort();
  for (let s = 5; s <= 120; s += 5) J.onTick(pos, { favPts: s / 10, nowMs: T0 + s * 1000 });
  const r = J.record(pos);
  assert.strictEqual(r.path.firstMoveDir, "UP");
  assert.strictEqual(r.path.secsToFirstMove, 30);
  assert.deepStrictEqual(r.path.pathPts, [3, 6, 9, 12]);
  assert.deepStrictEqual(Object.keys(pos).sort(), before, "only pos.journal may change");
  assert.ok(!("pathPts" in pos) && !("firstMoveDir" in pos));
  assert.ok(!("entryTimeMs" in r.path) && !("pathPrevPts" in r.path), "working state is not persisted");
});

// ─────────────────────────────────────────────────────────────────────────────
section("3. Stop / trail history");

check("ordered history: initial → breakeven → trail → lock; no-op moves ignored; context recorded", () => {
  const pos = opened();
  J.onTick(pos, { favPts: 12, pnlRs: 390, nowMs: T0 + 4 * MIN });
  J.onStopChange(pos, { from: 80, to: 100, kind: "breakeven", reason: "BE at +10", nowMs: T0 + 4 * MIN });
  J.onStopChange(pos, { from: 100, to: 100, kind: "trail", nowMs: T0 + 5 * MIN });          // same level
  J.onStopChange(pos, { to: 100, kind: "trail", nowMs: T0 + 5 * MIN });                     // repeat of the last level
  J.onStopChange(pos, { to: 108, kind: "trail", reason: "70% of peak", ltp: 115, nowMs: T0 + 6 * MIN });
  J.onStopChange(pos, { to: 112, kind: "lock", reason: "tier 40:80", nowMs: T0 + 8 * MIN });
  J.onStopChange(pos, { to: 180, kind: "target", reason: "target raised", nowMs: T0 + 8 * MIN });
  J.onStopChange(pos, { to: 115, kind: "weird", nowMs: T0 + 9 * MIN });
  const s = pos.journal.stops;
  assert.deepStrictEqual(s.map(x => [x.n, x.kind, x.from, x.to]), [
    [1, "initial", null, 80], [2, "breakeven", 80, 100], [3, "trail", 100, 108], [4, "lock", 108, 112],
    [5, "target", 150, 180], [6, "manual", 112, 115]]);
  assert.strictEqual(s[1].favPts, 12);
  assert.strictEqual(s[1].peakPts, 12);
  assert.strictEqual(s[2].ist, "10:06:00");
  assert.strictEqual(s[2].minFromEntry, 6);
  assert.strictEqual(s[2].ltp, 115);
  assert.strictEqual(pos.journal.target, 180, "a target move updates the current target");
  J.onExit(pos, { reason: "trail", nowMs: T0 + 10 * MIN });
  assert.strictEqual(pos.journal.exit.finalStop, 115, "final stop ignores target entries");
});

check("cap: ≤ MAX_STOPS kept, the initial stop always first, the newest last, drops counted", () => {
  const pos = opened();
  for (let i = 1; i <= 100; i++) J.onStopChange(pos, { to: 80 + i, kind: "trail", nowMs: T0 + i * 1000 });
  const s = pos.journal.stops;
  assert.strictEqual(s.length, J.MAX_STOPS);
  assert.strictEqual(s[0].kind, "initial");
  assert.strictEqual(s[s.length - 1].to, 180);
  assert.strictEqual(s[s.length - 1].n, 101);
  assert.strictEqual(pos.journal.stopsDropped, 101 - J.MAX_STOPS);
  for (let i = 2; i < s.length; i++) assert.ok(s[i].n > s[i - 1].n, "order kept");
});

// ─────────────────────────────────────────────────────────────────────────────
section("4. Exit: giveback, slippage, holding");

check("CE (bought option): giveback pts/₹/% of peak, slippage on the premium, hold minutes, candles", () => {
  const pos = opened({ qty: 75 });
  J.onTick(pos, { favPts: 40, pnlRs: 1500, nowMs: T0 + 10 * MIN });
  J.onTick(pos, { favPts: 10, pnlRs: 375, nowMs: T0 + 25 * MIN });
  J.onExit(pos, { reason: "trail hit", kind: "trail", spot: 24010, optionLtp: 105, expectedPrice: 106, bid: 104.5, ask: 105.5, candlesHeld: 5, nowMs: T0 + 25 * MIN });
  const x = pos.journal.exit;
  assert.strictEqual(x.givebackPts, 30);
  assert.strictEqual(x.givebackRs, 1125);
  assert.strictEqual(x.givebackPctOfPeak, 75);
  assert.strictEqual(x.fill, 105);
  assert.strictEqual(x.slippagePts, 1, "sold 1 below the wanted price = 1 adverse");
  assert.strictEqual(x.slippageRs, 75);
  assert.strictEqual(x.holdMin, 25);
  assert.strictEqual(x.candlesHeld, 5);
  assert.strictEqual(x.spread, 1);
  assert.strictEqual(x.ist, "10:25:00");
});

check("PE (bought option): same maths — favPts is already in the trade's favour", () => {
  const pos = { side: "PE", qty: 65 };
  J.onEntry(pos, { spot: 24000, optionLtp: 90, nowMs: T0, strategy: "ORB" });
  J.onTick(pos, { favPts: 25, pnlRs: 800, nowMs: T0 + 5 * MIN });
  J.onExit(pos, { favPts: 20, pnlRs: 600, optionLtp: 98, expectedPrice: 97, nowMs: T0 + 6 * MIN });
  const x = pos.journal.exit;
  assert.strictEqual(pos.journal.instDir, 1, "a bought PE is a long instrument");
  assert.strictEqual(x.givebackPts, 5);
  assert.strictEqual(x.givebackRs, 200);
  assert.strictEqual(x.givebackPctOfPeak, 20);
  assert.strictEqual(x.slippagePts, -1, "filled 1 ABOVE expected on a sale = favourable (negative)");
});

check("long futures: slippage on the futures price, sold below expected is adverse", () => {
  const pos = { side: "CE", qty: 75, isFutures: true };
  J.onEntry(pos, { spot: 24000, nowMs: T0, expectedPrice: 23999, strategy: "EMA_RSI_ST_V2", market: "NIFTY_FUT" });
  assert.strictEqual(pos.journal.entry.slippagePts, 1, "bought 1 above expected");
  J.onTick(pos, { favPts: 30, pnlRs: 2250, nowMs: T0 + MIN });
  J.onExit(pos, { spot: 24018, favPts: 18, pnlRs: 1350, expectedPrice: 24020, nowMs: T0 + 2 * MIN });
  assert.strictEqual(pos.journal.exit.slippagePts, 2);
  assert.strictEqual(pos.journal.exit.slippageRs, 150);
  assert.strictEqual(pos.journal.exit.givebackPts, 12);
  assert.strictEqual(pos.journal.exit.givebackPctOfPeak, 40);
});

check("short futures (side PE): buying back ABOVE expected is adverse", () => {
  const pos = { side: "PE", qty: 75, isFutures: true };
  J.onEntry(pos, { spot: 24000, nowMs: T0, expectedPrice: 24001, strategy: "EMA_RSI_ST_V2" });
  assert.strictEqual(pos.journal.instDir, -1);
  assert.strictEqual(pos.journal.entry.slippagePts, 1, "sold 1 below expected on the way in");
  J.onTick(pos, { favPts: 30, pnlRs: 2250, nowMs: T0 + MIN });
  J.onExit(pos, { spot: 23982, favPts: 18, pnlRs: 1350, expectedPrice: 23980, nowMs: T0 + 2 * MIN });
  assert.strictEqual(pos.journal.exit.slippagePts, 2);
  assert.strictEqual(pos.journal.exit.givebackPts, 12);
});

check("never in profit → giveback null; no expected price → slippage null", () => {
  const pos = opened();
  J.onTick(pos, { favPts: -5, pnlRs: -160, nowMs: T0 + MIN });
  J.onExit(pos, { optionLtp: 90, nowMs: T0 + 2 * MIN });
  assert.strictEqual(pos.journal.exit.givebackPts, null);
  assert.strictEqual(pos.journal.exit.givebackPctOfPeak, null);
  assert.strictEqual(pos.journal.exit.slippagePts, null);
  assert.strictEqual(pos.journal.exit.favPts, -5, "defaults to the last tick");
});

check("after exit, ticks / stops / candles are ignored", () => {
  const pos = opened();
  J.onExit(pos, { nowMs: T0 + MIN });
  J.onTick(pos, { favPts: 50, nowMs: T0 + 2 * MIN });
  J.onStopChange(pos, { to: 120, kind: "trail", nowMs: T0 + 2 * MIN });
  J.onCandle(pos, { candle: { time: T0 / 1000, open: 1, high: 1, low: 1, close: 1 } });
  assert.strictEqual(pos.journal.peak, null);
  assert.strictEqual(pos.journal.stops.length, 1);
  assert.strictEqual(pos.journal.bars.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
section("5. Minute rows (tick-built and route candles) + cap");

check("tick-built 1-minute rows: spot + option OHLC, P&L / stop / target at the minute's close, partial exit minute", () => {
  const pos = opened();
  const ticks = [[0, 24000, 100, 0], [20, 24010, 104, 10], [40, 23995, 98, -5], [59, 24005, 102, 5], [61, 24020, 108, 20], [90, 24030, 112, 30]];
  for (const [s, spot, ltp, f] of ticks) J.onTick(pos, { favPts: f, pnlRs: f * 30, spot, ltp, nowMs: T0 + s * 1000 });
  J.onStopChange(pos, { to: 95, kind: "trail", nowMs: T0 + 95 * 1000 });
  J.onExit(pos, { reason: "x", nowMs: T0 + 100 * 1000 });
  const b = pos.journal.bars;
  assert.strictEqual(pos.journal.barSource, "ticks");
  assert.strictEqual(b.length, 2);
  assert.deepStrictEqual(b[0], { t: "10:00", ms: T0, s: [24000, 24010, 23995, 24005], o: [100, 104, 98, 102], v: null, pnl: 150, pts: 5, sl: 80, tg: 150 });
  assert.deepStrictEqual(b[1].s, [24020, 24030, 24020, 24030]);
  assert.strictEqual(b[1].partial, true);
  assert.strictEqual(b[1].sl, 95);
  assert.strictEqual(pos.journal.exit.candlesFrom, "journal");
  assert.strictEqual(pos.journal.exit.candles.length, 2, "exit candles default to the journal's minute rows");
});

check("route candles (onCandle) take over: volume + indicators kept, option OHLC from ticks since the last candle", () => {
  const pos = opened();
  J.onTick(pos, { favPts: 1, spot: 24001, ltp: 101, nowMs: T0 + 10000 });
  J.onTick(pos, { favPts: 3, spot: 24003, ltp: 99, nowMs: T0 + 20000 });
  J.onCandle(pos, { candle: { time: T0 / 1000, open: 24000, high: 24004, low: 23999, close: 24003, volume: 1234 }, indicators: { rsi: 61 }, nowMs: T0 + 60000 });
  J.onTick(pos, { favPts: 6, spot: 24006, ltp: 105, nowMs: T0 + 70000 });
  J.onCandle(pos, { candle: [T0 / 1000 + 60, 24003, 24007, 24002, 24006, 900], optionCandle: { open: 1, high: 2, low: 1, close: 2 }, sl: 90, target: 200, pnlRs: 77 });
  const b = pos.journal.bars;
  assert.strictEqual(pos.journal.barSource, "route");
  assert.strictEqual(b.length, 2);
  assert.deepStrictEqual(b[0], { t: "10:00", ms: T0, s: [24000, 24004, 23999, 24003], o: [101, 101, 99, 99], v: 1234, pnl: null, pts: 3, sl: 80, tg: 150, ind: { rsi: 61 } });
  assert.deepStrictEqual(b[1].o, [1, 2, 1, 2]);
  assert.strictEqual(b[1].sl, 90);
  assert.strictEqual(b[1].tg, 200);
  assert.strictEqual(b[1].pnl, 77);
  J.onExit(pos, { nowMs: T0 + 130000 });
  assert.strictEqual(pos.journal.bars.length, 2, "no partial tick-built row once the route owns the rows");
});

check("cap: a 7-hour trade keeps ≤ MAX_BARS rows — the first BARS_HEAD and the latest — and counts the drop", () => {
  const pos = opened();
  const minutes = 7 * 60;
  for (let m = 0; m <= minutes; m++) J.onTick(pos, { favPts: m, spot: 24000 + m, ltp: 100, nowMs: T0 + m * MIN });
  J.onExit(pos, { nowMs: T0 + minutes * MIN + 1000 });
  const b = pos.journal.bars;
  assert.strictEqual(b.length, J.MAX_BARS);
  assert.strictEqual(b[0].t, "10:00");
  assert.strictEqual(b[J.BARS_HEAD - 1].ms, T0 + (J.BARS_HEAD - 1) * MIN, "head rows untouched");
  assert.strictEqual(b[b.length - 1].ms, T0 + minutes * MIN, "newest row last");
  assert.strictEqual(pos.journal.barsDropped, (minutes + 1) - J.MAX_BARS);
  for (let i = 1; i < b.length; i++) assert.ok(b[i].ms > b[i - 1].ms);
});

// ─────────────────────────────────────────────────────────────────────────────
section("6. Bounded memory, observer safety");

check("a full session of ticks stays bounded (bars, path, stops, snapshots) and onTick is O(1)", () => {
  const big = {}; for (let i = 0; i < 500; i++) big["k" + i] = i + 0.123456789;
  const pos = opened({ indicators: big, reason: "x".repeat(5000), signal: { arr: Array.from({ length: 1000 }, (_, i) => i) } });
  const N = 6 * 3600 * 2;                         // a tick every 0.5 s for 6 hours
  const t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) J.onTick(pos, { favPts: Math.sin(i / 500) * 40, pnlRs: i % 997, spot: 24000 + (i % 50), ltp: 100 + (i % 7), nowMs: T0 + i * 500 });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  for (let i = 0; i < 200; i++) J.onStopChange(pos, { to: 80 + i, kind: "trail", reason: "r".repeat(1000), nowMs: T0 + i });
  J.onExit(pos, { nowMs: T0 + N * 500, indicators: big });
  const r = J.record(pos);
  assert.ok(r.bars.length <= J.MAX_BARS);
  assert.ok(r.path.pathPts.length <= 30);
  assert.strictEqual(r.stops.length, J.MAX_STOPS);
  assert.ok(Object.keys(r.entry.indicators).length <= J.MAX_KEYS + 1);
  assert.strictEqual(r.entry.indicators._truncated, true);
  assert.ok(r.entry.reason.length <= J.MAX_STR);
  assert.ok(r.stops[5].reason.length <= J.MAX_STR);
  assert.strictEqual(r.entry.signal.arr.length, 5);
  const size = JSON.stringify(r).length;
  assert.ok(size < 120 * 1024, `journal is ${size} bytes`);
  assert.ok(ms < 3000, `${N} ticks took ${ms.toFixed(0)} ms`);
});

check("hooks never throw and return nothing; un-hooked positions get no journal; fields() is {} then", () => {
  for (const bad of [null, undefined, 5, "x", {}]) {
    assert.strictEqual(J.onEntry(bad, null), undefined);
    assert.strictEqual(J.onTick(bad, { favPts: 1 }), undefined);
    assert.strictEqual(J.onCandle(bad, { candle: null }), undefined);
    assert.strictEqual(J.onStopChange(bad, { to: 1 }), undefined);
    assert.strictEqual(J.onExit(bad, {}), undefined);
  }
  const pos = { side: "CE", qty: 1 };
  J.onTick(pos, { favPts: 5 });
  J.onExit(pos, { reason: "x" });
  assert.ok(!("journal" in pos), "onTick/onExit must not create a journal");
  assert.deepStrictEqual(J.fields(pos), {});
  const throwing = opened();
  Object.defineProperty(throwing.journal, "ticks", { get() { throw new Error("boom"); }, set() { throw new Error("boom"); } });
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try { assert.strictEqual(J.onTick(throwing, { favPts: 1, nowMs: T0 }), undefined); } finally { console.warn = warn; }
  assert.strictEqual(warned, 1, "an internal error is swallowed and logged once");
});

check("a restored position (positionPersist JSON round-trip) keeps recording", () => {
  const pos = opened();
  J.onTick(pos, { favPts: 10, spot: 24010, ltp: 105, nowMs: T0 + MIN });
  const restored = JSON.parse(JSON.stringify(pos));
  J.onTick(restored, { favPts: 20, spot: 24020, ltp: 110, nowMs: T0 + 2 * MIN });
  assert.strictEqual(restored.journal.peak.pts, 20);
  assert.strictEqual(restored.journal.ticks, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
section("7. JSONL round-trip + post-exit link");

const tl = require(path.join(UTILS, "tradeLogger.js"));

function closedTrade() {
  const pos = opened({ qty: 65 });
  J.onTick(pos, { favPts: 30, pnlRs: 975, spot: 24030, ltp: 115, nowMs: T0 + 5 * MIN });
  J.onStopChange(pos, { to: 105, kind: "trail", nowMs: T0 + 6 * MIN });
  J.onExit(pos, { reason: "trail", spot: 24020, optionLtp: 108, expectedPrice: 108.5, nowMs: T0 + 8 * MIN });
  return { pos, trade: { side: "CE", symbol: "NSE:NIFTY26NOV24000CE", qty: 65, pnl: 520, spotAtEntry: 24000, spotAtExit: 24020,
    entryTime: "10:00:00", exitTime: "10:08:00", entryReason: "BB break", exitReason: "trail", ...J.fields(pos) } };
}

check("the JSONL line carries the journal record and its id as tradeId; parse(stringify) is lossless", () => {
  const { pos, trade } = closedTrade();
  const before = JSON.stringify(trade);
  const rec = tl._tradeRecord("bb_rsi", T0 + 8 * MIN, trade);
  assert.strictEqual(JSON.stringify(trade), before, "the route's trade object is not mutated");
  assert.strictEqual(rec.tradeId, pos.journal.id);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rec)).journal, J.record(pos));
  assert.ok(!("_acc" in rec.journal) && !("entryTimeMs" in rec.journal.path));
  const bare = tl._tradeRecord("orb", 0, { side: "CE", pnl: 1 });
  assert.ok("tradeId" in bare && bare.tradeId === null, "no journal → tradeId null");
  assert.ok(!("journal" in bare));
  assert.strictEqual(tl._tradeRecord("orb", 0, { side: "CE", tradeId: "own-1" }).tradeId, "own-1");
});

check("appendTradeLog writes it to the day file and the line reads back with the same journal", async () => {
  const { pos, trade } = closedTrade();
  tl.appendTradeLog("bb_rsi", trade);
  await new Promise(r => setTimeout(r, 150));
  const lines = tl.readDailyTrades("bb_rsi", tl.istDateString()).filter(l => !l.type);
  const got = lines.find(l => l.tradeId === pos.journal.id);
  assert.ok(got, "line with the tradeId written");
  assert.deepStrictEqual(got.journal, J.record(pos));
});

check("post-exit tracker stores the tradeId on the watch and in the finished record", () => {
  const pe = require(path.join(UTILS, "postExitTracker.js"));
  const { trade } = closedTrade();
  const n0 = pe._internals.trackers.length;
  pe.track("bb_rsi", trade, { market: "NIFTY", strategy: "BB_RSI", tradeId: trade.journal.id });
  const k = pe._internals.trackers[pe._internals.trackers.length - 1];
  if (pe._internals.trackers.length > n0) {          // only when the market is still open right now
    assert.strictEqual(k.tradeId, trade.journal.id);
    pe._internals.trackers.splice(n0);
  }
  const rec = pe._internals.summarise({ mode: "bb_rsi", sym: "NSE:NIFTY50-INDEX", dir: 1, side: "CE", exitSpot: 24020, exitMs: T0,
    exitTime: "10:08:00", date: DAY, hi: null, lo: null, last: null, marks: {}, ticks: 0, tradeId: "NIFTY-BB_RSI-CE-1" });
  assert.strictEqual(rec.tradeId, "NIFTY-BB_RSI-CE-1");
  const old = pe._internals.summarise({ mode: "bb_rsi", sym: "x", dir: 1, side: "CE", exitSpot: 1, exitMs: T0, date: DAY, marks: {}, ticks: 0 });
  assert.strictEqual(old.tradeId, null, "a pre-journal watch summarises with tradeId null");
});

// ─────────────────────────────────────────────────────────────────────────────
section("8. Golden harness ignores ONLY `journal`");

const baseline = require(path.join(REPO, "scripts", "strategyBaseline.js"));

check("OBSERVER_KEYS is exactly ['journal']", () => {
  assert.deepStrictEqual(baseline.OBSERVER_KEYS, ["journal"]);
});

check("a trade with a journal builds the same golden as without; any other field change still differs", () => {
  const strat = { route: "bbRsiPaper", mode: "bb_rsi-paper" };
  const t = { side: "CE", entryTime: "10:00:00", exitTime: "10:08:00", pnl: 520, exitReason: "trail" };
  const run_ = (trades) => [{ date: DAY, regime: "trend", ok: true, ticksReplayed: 10, tradeCount: trades.length, sessionPnl: 520, warmupBlind: false, trades, skips: {} }];
  const plain = baseline.buildGolden(strat, run_([t]));
  const withJ = baseline.buildGolden(strat, run_([{ ...t, journal: closedTrade().trade.journal }]));
  assert.strictEqual(JSON.stringify(withJ), JSON.stringify(plain));
  for (const [k, v] of [["pnl", 521], ["exitReason", "sl"], ["journalX", 1], ["mfeSpotPts", 3]]) {
    const changed = baseline.buildGolden(strat, run_([{ ...t, [k]: v, journal: {} }]));
    assert.notStrictEqual(JSON.stringify(changed), JSON.stringify(plain), `a change to ${k} must still show`);
    assert.ok(baseline.firstDiff(plain, changed), `firstDiff finds ${k}`);
  }
  const nested = baseline.buildGolden(strat, run_([{ ...t, meta: { journal: 1 } }]));
  assert.notStrictEqual(JSON.stringify(nested), JSON.stringify(plain), "only the TOP-LEVEL journal key is ignored");
});

check("stripObserverKeys returns the same object when there is no journal, never mutates its input", () => {
  const t = { a: 1 };
  assert.strictEqual(baseline.stripObserverKeys(t), t);
  const tj = { a: 1, journal: { v: 1 } };
  const out = baseline.stripObserverKeys(tj);
  assert.deepStrictEqual(out, { a: 1 });
  assert.ok("journal" in tj);
});

check("the golden files are untouched by this change (no journal key in any of them)", () => {
  const dir = path.join(REPO, "tests", "baseline");
  const files = fs.readdirSync(dir).filter(n => n.endsWith(".json"));
  assert.ok(files.length >= 17);
  for (const f of files) assert.ok(!fs.readFileSync(path.join(dir, f), "utf-8").includes('"journal"'), `${f} has a journal key`);
});

// ─────────────────────────────────────────────────────────────────────────────
section("9. Consolidated page: journal id, detail lookup, post-exit join by id");

check("a journaled trade's row carries journalId; journalsFor reads it from the book; post-exit joins by tradeId", () => {
  const { trade } = closedTrade();
  const id = trade.journal.id;
  fs.writeFileSync(path.join(DATA, "bb_rsi_paper_trades.json"), JSON.stringify({ sessions: [{ date: DAY, trades: [
    { ...trade, exitTime: "11/11/2026, 10:08:00", entryTime: "11/11/2026, 10:00:00" },
    { side: "PE", pnl: -100, exitReason: "SL", entryTime: "11/11/2026, 11:00:00", exitTime: "11/11/2026, 11:10:00" },
  ] }] }));
  // Exit time string deliberately different from the trade's: only the id can join it.
  fs.writeFileSync(path.join(DATA, "post_exit", `${DAY}.jsonl`), JSON.stringify({ type: "post_exit", date: DAY, mode: "bb_rsi", side: "CE", tradeId: id,
    exitTime: "99:99:99", spotAtExit: 1, bestAfterExit: { spot: 24050, pts: 30, time: "10:40", minutesAfterExit: 32 }, worstAfterExit: { spot: 24010, pts: -10, time: "10:12" } }) + "\n");
  const consolidation = require(path.join(REPO, "src", "routes", "consolidation.js"));
  const rows = consolidation.loadConsolidatedTrades().trades.filter(t => t.mode === "BB_RSI");
  const jRow = rows.find(t => t.journalId === id);
  assert.ok(jRow, "row has journalId");
  assert.strictEqual(jRow.postExit.bestPts, 30, "post-exit joined by tradeId");
  assert.strictEqual(rows.find(t => t.side === "PE").journalId, null, "old record → journalId null");
  const found = consolidation.journalsFor([id], "BB_RSI");
  assert.deepStrictEqual(found.get(id), trade.journal);
  assert.strictEqual(consolidation.postExitRecordFor(jRow).tradeId, id);
  const data = consolidation.loadAllTrades();
  assert.ok(data.every(t => !("journalId" in t) && !("journal" in t)), "the shared /data rows are unchanged");
});

check("the page renders the detail sheet, a details button per row and the 'not recorded' fallback", () => {
  const consolidation = require(path.join(REPO, "src", "routes", "consolidation.js"));
  const layer = consolidation.stack.find(l => l.route && l.route.path === "/");
  let html = "";
  layer.route.stack[0].handle({ query: {} }, { send: (h) => { html = h; } });
  for (const s of ['id="tdSheet"', "function openTrade(", "function renderTrade(", "not recorded", "/consolidation/trade-detail?id=",
                   "aria-label=\"Trade details\"", "@media(max-width:768px){\n      .td-sheet", "min-height:44px", "function exportDay("]) {
    assert.ok(html.includes(s), `page is missing ${s}`);
  }
  const detail = consolidation.stack.find(l => l.route && l.route.path === "/trade-detail");
  assert.ok(detail && detail.route.methods.get, "GET /trade-detail exists");
  const exp = consolidation.stack.find(l => l.route && l.route.path === "/export-day");
  assert.ok(exp && exp.route.methods.post, "POST /export-day exists");
  const app = fs.readFileSync(path.join(REPO, "src", "app.js"), "utf-8");
  assert.ok(app.includes('"/consolidation/trade-detail"'), "trade-detail is an open read");
  assert.ok(!app.includes('"/consolidation/export-day"'), "export-day stays protected (secret)");
});

check("the sheet's own render code shows every journal part, and 'not recorded' for an old trade", () => {
  const vm = require("vm");
  const consolidation = require(path.join(REPO, "src", "routes", "consolidation.js"));
  const layer = consolidation.stack.find(l => l.route && l.route.path === "/");
  let html = "";
  layer.route.stack[0].handle({ query: {} }, { send: (h) => { html = h; } });
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).pop();
  const els = {};
  const mkEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", style: {}, dataset: {}, options: [], tagName: "DIV",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, appendChild() {}, focus() {},
    querySelector() { return mkEl("_q"); }, querySelectorAll() { return []; }, getContext() { return {}; }, closest() { return null; },
  });
  const doc = {
    getElementById: (id) => (els[id] = els[id] || mkEl(id)), querySelector: (s) => (els[s] = els[s] || mkEl(s)), querySelectorAll: () => [],
    addEventListener() {}, createElement: () => mkEl("_n"), documentElement: { getAttribute: () => null },
    body: { classList: { add() {}, remove() {}, contains() { return false; } }, appendChild() {} },
  };
  const ctx = { document: doc, window: {}, navigator: {}, console, setTimeout, clearTimeout, URLSearchParams, Blob: function () {}, URL: {},
    location: { search: "", pathname: "/consolidation", hash: "" }, history: { replaceState() {} }, Chart: function () { this.destroy = () => {}; },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const { trade } = closedTrade();
  const row = { strategyId: "BB_RSI", market: "NIFTY", side: "CE", symbol: "NSE:X", date: DAY, qty: 65, pnl: 520, entryPrice: 1, exitPrice: 2,
    entryTime: "10:00:00", exitTime: "10:08:00", entryReason: "BB break", exitReason: "trail", journalId: trade.journal.id };
  ctx.renderTrade(row, trade.journal, { bestAfterExit: { pts: 30, time: "10:40", minutesAfterExit: 32 }, worstAfterExit: { pts: -10, time: "10:12" } }, false);
  const body = els.tdBody.innerHTML;
  for (const s of ["Entry — why", "BB break + RSI 72", "Peak", "10:05:00", "Stop / trail timeline", "#2 trail", "Minute path",
                   "Exit — why", "Gave back from peak", "% of peak", "Slippage", "Best after exit", "+30.0 pts"]) {
    assert.ok(body.includes(s), `journal sheet is missing "${s}"`);
  }
  assert.ok(!body.includes("not recorded"), "a journaled trade has nothing 'not recorded'");
  ctx.renderTrade({ ...row, journalId: null, postExit: null }, null, null, false);
  const old = els.tdBody.innerHTML;
  for (const s of ["Entry snapshot — not recorded", "Peak and drawdown — not recorded", "Stop history — not recorded", "Exit snapshot — not recorded", "Post-exit move — not recorded", "BB break"]) {
    assert.ok(old.includes(s), `old-trade sheet is missing "${s}"`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section("10. Daily export: CSV + summary");

const DX = require(path.join(UTILS, "dailyExport.js"));

function fakeConsolidation(rows, journals) {
  return { loadConsolidatedTrades: () => ({ trades: rows }), journalsFor: () => journals || new Map(), extraOf: () => null };
}
const RowsDay = () => {
  const { trade } = closedTrade();
  return {
    rows: [
      { date: DAY, market: "NIFTY", strategyId: "BB_RSI", mode: "BB_RSI", side: "CE", symbol: "NSE:NIFTY26NOV24000CE", optionStrike: 24000, qty: 65,
        entryTime: "10:00:00", exitTime: "10:08:00", entryPrice: 24000, exitPrice: 24020, entryReason: 'BB break, "strong"', exitReason: "=trail",
        pnl: 520, charges: 40, gross: 560, journalId: trade.journal.id, postExit: { bestPts: 30, bestTime: "10:40" } },
      { date: DAY, market: "BANKNIFTY", strategyId: "ORB", mode: "ORB", side: "PE", qty: 30, entryTime: "11:00:00", exitTime: "11:30:00", pnl: -300, charges: 35, gross: -265 },
      { date: DAY, market: "NIFTY", strategyId: "BB_RSI", mode: "BB_RSI", side: "PE", qty: 65, entryTime: "09:30:00", exitTime: "09:40:00", pnl: 200, charges: 30, gross: 230 },
      { date: DAY, market: "NIFTY", strategyId: "BB_RSI", mode: "BB_RSI", side: "CE", qty: 65, entryTime: "12:00:00", exitTime: "12:10:00", pnl: -500, charges: 30, gross: -470 },
      { date: "2026-11-10", market: "NIFTY", strategyId: "BB_RSI", mode: "BB_RSI", side: "CE", pnl: 9999 },
    ],
    journals: new Map([[trade.journal.id, trade.journal]]),
    trade,
  };
};

check("summary maths: W/L, win rate, gross profit/loss, net, charges, PF, averages, max drawdown, MFE/MAE, skips", () => {
  const { rows, journals } = RowsDay();
  const out = DX.buildExport(DAY, rows.filter(r => r.date === DAY), journals, { bb_rsi: 4, orb: 0, pa: 2 });
  const s = out.summary;
  assert.deepStrictEqual(out.rows.map(r => r.net), [200, 520, -300, -500], "exit order");
  assert.strictEqual(s.trades, 4); assert.strictEqual(s.wins, 2); assert.strictEqual(s.losses, 2);
  assert.strictEqual(s.winRatePct, 50);
  assert.strictEqual(s.grossProfit, 720); assert.strictEqual(s.grossLoss, -800);
  assert.strictEqual(s.net, -80); assert.strictEqual(s.charges, 135); assert.strictEqual(s.gross, 55);
  assert.strictEqual(s.profitFactor, 0.9);
  assert.strictEqual(s.avgWin, 360); assert.strictEqual(s.avgLoss, -400);
  assert.strictEqual(s.maxDrawdown, 800, "peak +720 → trough −80");
  assert.strictEqual(s.mfe.trades, 1); assert.strictEqual(s.mfe.maxPts, 30);
  assert.strictEqual(s.journaled, 1);
  assert.deepStrictEqual(s.skippedSignals, { total: 6, byMode: { bb_rsi: 4, pa: 2 } });
  assert.deepStrictEqual(s.byMarket.BANKNIFTY, { trades: 1, wins: 0, net: -300 });
  assert.deepStrictEqual(s.byStrategy.BB_RSI, { trades: 3, wins: 2, net: 220 });
  const none = DX.summarise(DAY, [{ net: 100 }], {});
  assert.strictEqual(none.profitFactor, null);
  assert.strictEqual(none.profitFactorNote, "no losing trades");
});

check("CSV: header, one row per trade, quoting, formula guard, journal fields, post-exit best", () => {
  const { rows, journals, trade } = RowsDay();
  const out = DX.buildExport(DAY, rows.filter(r => r.date === DAY), journals, {});
  const lines = out.csv.trimEnd().split("\r\n");
  assert.strictEqual(lines[0], DX.CSV_COLUMNS.join(","));
  assert.strictEqual(lines.length, 5);
  const row = lines[2];
  assert.ok(row.includes('"BB break, ""strong"""'), "comma + quotes quoted");
  assert.ok(row.includes(",'=trail,"), "a text cell starting with = is defused");
  const r = out.rows[1];
  assert.strictEqual(r.peak_pts, 30); assert.strictEqual(r.peak_time, "10:05:00");
  assert.strictEqual(r.giveback_pts, trade.journal.exit.givebackPts);
  assert.strictEqual(r.slippage_pts, 0.5);
  assert.strictEqual(r.post_exit_best_pts, 30);
  assert.strictEqual(r.trade_id, trade.journal.id);
  assert.strictEqual(DX.csvCell(-12.5), "-12.5", "negative numbers are not defused");
  assert.ok(!/token|secret|api_key/i.test(out.csv + JSON.stringify(out.summary)), "nothing secret-shaped is exported");
});

check("writeDay: atomic files in exports/, only that day's trades, no tmp left; refuses in weekday market hours", () => {
  const { rows, journals } = RowsDay();
  const dir = path.join(HOME, "trading-data", "exports");
  const after = ist(DAY, "17:00");
  const res = DX.writeDay(DAY, { nowMs: after, consolidation: fakeConsolidation(rows, journals), skips: {}, dir });
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.trades, 4);
  assert.strictEqual(res.csvPath, path.join(dir, `trades_${DAY}.csv`));
  assert.strictEqual(res.summaryPath, path.join(dir, `daily_summary_${DAY}.json`));
  assert.strictEqual(JSON.parse(fs.readFileSync(res.summaryPath, "utf-8")).net, -80);
  assert.ok(!fs.readdirSync(dir).some(n => n.endsWith(".tmp")), "no tmp file left behind");
  assert.strictEqual(DX.EXPORT_DIR, dir, "default dir is ~/trading-data/exports");
  const blocked = DX.writeDay(DAY, { nowMs: ist(DAY, "11:00"), consolidation: fakeConsolidation(rows, journals), dir });
  assert.strictEqual(blocked.ok, false);
  assert.ok(/09:00–15:30/.test(blocked.error));
  assert.ok(DX.inMarketHours(ist(DAY, "09:00")) && DX.inMarketHours(ist(DAY, "15:29")));
  assert.ok(!DX.inMarketHours(ist(DAY, "15:30")) && !DX.inMarketHours(ist("2026-11-14", "11:00")), "Saturday is free");
  assert.strictEqual(DX.writeDay("11-11-2026", { nowMs: after, consolidation: fakeConsolidation([]), dir }).ok, false, "bad date refused");
});

check("scheduled check: not before 16:30, once per day, skips non-trading days", async () => {
  const { rows, journals } = RowsDay();
  const dir = path.join(HOME, "sched");
  const opts = { consolidation: fakeConsolidation(rows, journals), skips: {}, dir, isNonTradingDay: async () => false };
  assert.strictEqual((await DX.check(ist(DAY, "16:29"), opts)).ran, false);
  assert.strictEqual((await DX.check(ist(DAY, "13:00"), opts)).ran, false);
  const log = console.log; console.log = () => {};
  let first;
  try { first = await DX.check(ist(DAY, "16:31"), opts); } finally { console.log = log; }
  assert.strictEqual(first.ran, true);
  const again = await DX.check(ist(DAY, "18:00"), opts);
  assert.strictEqual(again.ran, false); assert.strictEqual(again.why, "already ran today");
  const hol = await DX.check(ist("2026-11-12", "17:00"), { ...opts, isNonTradingDay: async () => true });
  assert.strictEqual(hol.why, "not a trading day");
});

check("exports/ is protected from the disk auto-cleanup", () => {
  const dr = require(path.join(UTILS, "diskRetention.js"));
  const ctx = { dataDir: path.join(HOME, "trading-data"), ticksDir: path.join(HOME, "ticks"), env: {} };
  const roots = dr._internals.protectedRoots(ctx);
  assert.ok(roots.includes(path.join(ctx.dataDir, "exports")));
  const f = path.join(ctx.dataDir, "exports", `trades_${DAY}.csv`);
  for (const def of dr.folders(ctx)) assert.strictEqual(dr._internals.isSafeTarget(f, def, ctx), false, `${def.key} could delete an export`);
  const exp = dr.folders(ctx).find(d => d.key === "exports");
  assert.ok(exp && exp.protected === true);
});

// ─────────────────────────────────────────────────────────────────────────────
section("11. Wiring");

check("npm test runs this suite; no paper route file was edited to add journal hooks here", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf-8"));
  assert.ok(pkg.scripts.test.includes("node tests/tradeJournal.regression.js"));
  assert.ok(fs.readFileSync(path.join(UTILS, "tradeLogger.js"), "utf-8").includes('require("./tradeJournal")'));
  assert.ok(fs.readFileSync(path.join(REPO, "src", "app.js"), "utf-8").includes('require("./utils/dailyExport").start()'));
  const recipe = fs.readFileSync(path.join(UTILS, "tradeJournal.js"), "utf-8").slice(0, 6000);
  for (const hook of ["onEntry(pos", "onTick(pos", "onCandle(pos", "onStopChange(pos", "onExit(pos", "...tradeJournal.fields(pos)"]) {
    assert.ok(recipe.includes(hook), `recipe is missing ${hook}`);
  }
});

run().then(() => {
  // appendTradeLog above may have opened a post-exit watch (market open now);
  // drop it, and remove the temp HOME after the tracker's own exit-save hook.
  try { require(path.join(UTILS, "postExitTracker.js"))._internals.trackers.splice(0); } catch (_) {}
  try { DX.stop(); } catch (_) {}
  process.on("exit", () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {} });
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

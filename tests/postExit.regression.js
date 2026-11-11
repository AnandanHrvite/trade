#!/usr/bin/env node
/**
 * POST-EXIT + TRADE-LOG TAGS — every trade is logged with its market, strategy
 * and entry/exit reasons, and every exit is watched until its market closes,
 * across a restart.
 *
 *   node tests/postExit.regression.js
 *
 * Zero dependencies, exits non-zero on failure. HOME is pointed at a throwaway
 * temp dir before anything is required, so nothing touches the real
 * ~/trading-data. socketManager and the logger are replaced by fakes in the
 * require cache: no socket is opened and console is not intercepted. The clock
 * is Date.now() overridden per check.
 */

"use strict";

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "postexit-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const SRC = path.join(__dirname, "../src");
const UTILS = path.join(SRC, "utils");

// ── Fakes ────────────────────────────────────────────────────────────────────
const fakeSock = {
  subs: ["NSE:NIFTY50-INDEX"],
  callbacks: new Map(),
  calls: [],
  spotSymbols() { return this.subs.slice(); },
  addCallback(id, fn, _log, sym) { this.calls.push(["addCallback", id, sym]); this.callbacks.set(id, { fn, sym }); },
  removeCallback(id) { this.calls.push(["removeCallback", id]); this.callbacks.delete(id); },
  start() { this.calls.push(["start"]); },
  addSpotSymbol() { this.calls.push(["addSpotSymbol"]); },
  subscribeExtra() { this.calls.push(["subscribeExtra"]); },
};
const logged = [];
function _stub(rel, exportsObj) {
  const file = require.resolve(path.join(SRC, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}
_stub("utils/socketManager.js", fakeSock);
_stub("services/logger.js", { logAs: (mode, line) => logged.push({ mode, line }) });

const realNow = Date.now;
// IST wall clock → epoch ms.
const ist = (date, hhmm, ss = 0) => Date.parse(`${date}T${hhmm}:${String(ss).padStart(2, "0")}+05:30`);
const setNow = (ms) => { Date.now = () => ms; };
const DAY = "2026-11-11";

function freshTracker() {
  const file = require.resolve(path.join(UTILS, "postExitTracker.js"));
  const old = require.cache[file];
  if (old) {
    // Stop the old instance's timer so the test process can exit.
    try { const k = old.exports._internals.trackers; k.length = 0; old.exports._internals.check(); } catch (_) {}
    delete require.cache[file];
  }
  return require(file);
}
const tick = (sym, ltp) => {
  for (const { fn, sym: s } of fakeSock.callbacks.values()) if (s === sym) fn({ ltp, symbol: sym });
};
const settle = () => new Promise((r) => setTimeout(r, 30));
const outFile = (date) => path.join(TMP_HOME, "trading-data", "post_exit", `${date}.jsonl`);
const readOut = (date) => {
  try { return fs.readFileSync(outFile(date), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch (_) { return []; }
};
function resetWorld() {
  fakeSock.callbacks.clear(); fakeSock.calls.length = 0; fakeSock.subs = ["NSE:NIFTY50-INDEX"];
  logged.length = 0;
  fs.rmSync(path.join(TMP_HOME, "trading-data", "post_exit"), { recursive: true, force: true });
}

let pass = 0, fail = 0;
const QUEUE = [];
function check(name, fn) { QUEUE.push({ name, fn }); }
function section(title) { QUEUE.push({ section: title }); }
async function run() {
  for (const item of QUEUE) {
    if (item.section) { console.log(`\n${item.section}`); continue; }
    resetWorld();
    try { await item.fn(); console.log(`  ✅ ${item.name}`); pass++; }
    catch (e) { console.log(`  ❌ ${item.name}\n       ${e && e.stack || e}`); fail++; }
    finally { Date.now = realNow; await settle(); }   // let async saves land before the next wipe
  }
}

const niftyCE = (over = {}) => ({ side: "CE", symbol: "NSE:NIFTY25N1824000CE", spotAtEntry: 23950, spotAtExit: 24000,
  entryTime: "09:50:00", exitTime: "10:00:00", entryReason: "EMA cross + RSI 62", exitReason: "SuperTrend flip", pnl: 450, ...over });

// ── 1. Market close times + spot symbol ──────────────────────────────────────
section("1. Market close times and which spot is watched");

check("NSE/BSE markets close 15:30, MCX markets 23:30", () => {
  const { closeMinFor } = freshTracker()._internals;
  for (const m of ["NIFTY", "BANKNIFTY", "SENSEX", "SAIL", "STOCKS", undefined]) assert.strictEqual(closeMinFor(m), 15 * 60 + 30, String(m));
  for (const m of ["CRUDE", "GOLD", "SILVER", "crude", "MCX_GOLD"]) assert.strictEqual(closeMinFor(m), 23 * 60 + 30, m);
});

check("spot symbol: trade's own first, then the market's, MCX needs its own", () => {
  const { spotSymbolFor } = freshTracker()._internals;
  assert.strictEqual(spotSymbolFor("bb_rsi", {}, "NIFTY"), "NSE:NIFTY50-INDEX");
  assert.strictEqual(spotSymbolFor("bb_rsi", {}, "BANKNIFTY"), "NSE:NIFTYBANK-INDEX");
  assert.strictEqual(spotSymbolFor("bb_rsi", {}, "SENSEX"), "BSE:SENSEX-INDEX");
  assert.strictEqual(spotSymbolFor("sail_vwap_st", {}, "SAIL"), "NSE:SAIL-EQ");
  assert.strictEqual(spotSymbolFor("x", { spotSymbol: "MCX:CRUDEOIL25DECFUT" }, "CRUDE"), "MCX:CRUDEOIL25DECFUT");
  assert.strictEqual(spotSymbolFor("x", {}, "CRUDE"), null, "MCX without a spot symbol cannot be tracked");
  assert.strictEqual(spotSymbolFor("early_bird", { instrument: "NSE_EQUITY", symbol: "NSE:TCS-EQ" }, "STOCKS"), "NSE:TCS-EQ");
  assert.strictEqual(spotSymbolFor("gap_runaway_stk", {}, "STOCKS"), null);
  assert.strictEqual(spotSymbolFor("orb", {}, undefined), "NSE:NIFTY50-INDEX", "legacy call without a market");
});

check("a NIFTY exit after 15:30 is not watched; a CRUDE exit then is, until 23:30", async () => {
  const pe = freshTracker();
  fakeSock.subs.push("MCX:CRUDEOIL25DECFUT");
  setNow(ist(DAY, "15:31"));
  pe.track("bb_rsi", niftyCE(), { market: "NIFTY", strategy: "BB_RSI" });
  assert.strictEqual(pe._internals.trackers.length, 0);
  pe.track("bb_rsi", niftyCE({ spotAtExit: 6100, spotSymbol: "MCX:CRUDEOIL25DECFUT" }), { market: "CRUDE", strategy: "BB_RSI" });
  assert.strictEqual(pe._internals.trackers.length, 1);
  setNow(ist(DAY, "18:00")); tick("MCX:CRUDEOIL25DECFUT", 6130);
  setNow(ist(DAY, "23:00")); pe._internals.check();
  assert.strictEqual(pe._internals.trackers.length, 1, "still open at 23:00");
  setNow(ist(DAY, "23:30")); pe._internals.check();
  await settle();
  assert.strictEqual(pe._internals.trackers.length, 0);
  const [rec] = readOut(DAY);
  assert.strictEqual(rec.market, "CRUDE");
  assert.strictEqual(rec.marketClose, "23:30");
  assert.strictEqual(rec.bestAfterExit.pts, 30);
  assert.strictEqual(rec.bestAfterExit.time, "18:00");
});

// ── 2. Best / worst timing ───────────────────────────────────────────────────
section("2. Best / worst move, marks and minutes-to-best");

check("CE: best/worst with time, +5/+15/+30/+60 marks, minutesToBest, close cut-off", async () => {
  const pe = freshTracker();
  setNow(ist(DAY, "10:00"));
  pe.track("bb_rsi", niftyCE(), { market: "NIFTY", strategy: "BB_RSI" });
  assert.deepStrictEqual(fakeSock.calls.filter((c) => c[0] !== "addCallback"), [], "observer: only addCallback");
  const seq = [["10:02", 24010], ["10:07", 24050], ["10:20", 23970], ["10:40", 23990], ["11:05", 24020], ["15:29", 24005]];
  for (const [t, px] of seq) { setNow(ist(DAY, t)); tick("NSE:NIFTY50-INDEX", px); }
  setNow(ist(DAY, "15:31")); tick("NSE:NIFTY50-INDEX", 25000);   // after close: ignored
  pe._internals.check();
  await settle();
  const [rec] = readOut(DAY);
  assert(rec, "no post_exit record written");
  assert.strictEqual(rec.type, "post_exit");
  assert.strictEqual(rec.market, "NIFTY");
  assert.strictEqual(rec.strategy, "BB_RSI");
  assert.strictEqual(rec.entryReason, "EMA cross + RSI 62");
  assert.strictEqual(rec.exitReason, "SuperTrend flip");
  assert.strictEqual(rec.ticksAfterExit, 6, "post-close tick must not count");
  assert.deepStrictEqual(rec.bestAfterExit, { spot: 24050, pts: 50, time: "10:07", minutesAfterExit: 7 });
  assert.deepStrictEqual(rec.worstAfterExit, { spot: 23970, pts: -30, time: "10:20", minutesAfterExit: 20 });
  assert.strictEqual(rec.minutesToBest, 7);
  assert.deepStrictEqual(rec.plus5m, { spot: 24050, pts: 50, time: "10:07" });
  assert.deepStrictEqual(rec.plus15m, { spot: 23970, pts: -30, time: "10:20" });
  assert.deepStrictEqual(rec.plus30m, { spot: 23990, pts: -10, time: "10:40" });
  assert.deepStrictEqual(rec.plus60m, { spot: 24020, pts: 20, time: "11:05" });
  assert.deepStrictEqual(rec.lastBeforeClose, { spot: 24005, pts: 5, time: "15:29" });
  assert.strictEqual(rec.restarts, 0);
  assert(logged.some((l) => l.mode === "bb_rsi" && /7 min after exit/.test(l.line)), "server-log line names minutes to best");
});

check("PE: favourable is DOWN", async () => {
  const pe = freshTracker();
  setNow(ist(DAY, "11:00"));
  pe.track("orb", niftyCE({ side: "PE", spotAtExit: 24000 }), { market: "NIFTY", strategy: "ORB" });
  setNow(ist(DAY, "11:10")); tick("NSE:NIFTY50-INDEX", 23940);
  setNow(ist(DAY, "11:30")); tick("NSE:NIFTY50-INDEX", 24025);
  setNow(ist(DAY, "15:30")); pe._internals.check();
  await settle();
  const [rec] = readOut(DAY);
  assert.strictEqual(rec.bestAfterExit.pts, 60);
  assert.strictEqual(rec.bestAfterExit.time, "11:10");
  assert.strictEqual(rec.worstAfterExit.pts, -25);
  assert.strictEqual(rec.minutesToBest, 10);
});

check("never subscribes: a symbol the feed is not carrying gets no callback", () => {
  const pe = freshTracker();
  setNow(ist(DAY, "10:00"));
  pe.track("sail_vwap_st", niftyCE({ spotAtExit: 120 }), { market: "SAIL", strategy: "SAIL_VWAP_ST" });
  assert.strictEqual(pe._internals.trackers.length, 1);
  assert.deepStrictEqual(fakeSock.calls, [], "must not addCallback/subscribe NSE:SAIL-EQ when it is not streaming");
});

// ── 3. Restart resume ────────────────────────────────────────────────────────
section("3. Restart: pending watches persist and resume");

check("mid-day restart: watch survives, keeps pre-restart extremes, counts downtime", async () => {
  let pe = freshTracker();
  setNow(ist(DAY, "10:00"));
  pe.track("ema_rsi_st", niftyCE(), { market: "NIFTY", strategy: "EMA_RSI_ST" });
  await settle();                                     // let the async save land
  setNow(ist(DAY, "10:07")); tick("NSE:NIFTY50-INDEX", 24080);   // best, before the restart
  setNow(ist(DAY, "10:10")); pe._internals.persistSync();         // last save before the "crash"
  const saved = JSON.parse(fs.readFileSync(pe.PENDING_FILE, "utf-8"));
  assert.strictEqual(saved.watches.length, 1);
  assert.strictEqual(saved.watches[0].hi.px, 24080);

  // New process: empty memory, app boots at 10:40.
  fakeSock.callbacks.clear();
  pe = freshTracker();
  assert.strictEqual(pe._internals.trackers.length, 0);
  setNow(ist(DAY, "10:40"));
  assert.deepStrictEqual(pe.resume(), { resumed: 1, finalised: 0 });
  assert.deepStrictEqual(pe.resume(), { resumed: 0, finalised: 0 }, "resume is idempotent");
  assert.strictEqual(pe._internals.trackers.length, 1);
  setNow(ist(DAY, "10:45")); tick("NSE:NIFTY50-INDEX", 23960);   // worst, after the restart
  setNow(ist(DAY, "15:30")); pe._internals.check();
  await settle();
  const [rec] = readOut(DAY);
  assert.strictEqual(rec.restarts, 1);
  assert.strictEqual(rec.downtimeMin, 30, "10:10 → 10:40 unwatched");
  assert.strictEqual(rec.bestAfterExit.pts, 80);
  assert.strictEqual(rec.bestAfterExit.time, "10:07");
  assert.strictEqual(rec.worstAfterExit.pts, -40);
  assert.strictEqual(rec.ticksAfterExit, 2);
  assert.strictEqual(rec.strategy, "EMA_RSI_ST");
  const after = JSON.parse(fs.readFileSync(pe.PENDING_FILE, "utf-8"));
  assert.strictEqual(after.watches.length, 0, "finished watch leaves _pending.json");
});

check("restart after the close: watch is finalised from what it had", async () => {
  let pe = freshTracker();
  setNow(ist(DAY, "14:00"));
  pe.track("pa", niftyCE(), { market: "NIFTY", strategy: "PA" });
  await settle();
  setNow(ist(DAY, "14:20")); tick("NSE:NIFTY50-INDEX", 24030);
  pe._internals.persistSync();
  pe = freshTracker();
  setNow(ist("2026-11-12", "09:00"));                 // next morning
  assert.deepStrictEqual(pe.resume(), { resumed: 0, finalised: 1 });
  await settle();
  const [rec] = readOut(DAY);
  assert.strictEqual(rec.date, DAY, "filed under the trade's own day");
  assert.strictEqual(rec.bestAfterExit.pts, 30);
  assert.strictEqual(rec.restarts, 1);
  assert.strictEqual(rec.downtimeMin, 70, "14:20 → 15:30, capped at the close");
});

check("a torn / garbage _pending.json is ignored, not thrown", () => {
  const pe = freshTracker();
  fs.mkdirSync(pe.OUT_DIR, { recursive: true });
  fs.writeFileSync(pe.PENDING_FILE, "{\"version\":1,\"watches\":[{\"mode\":");
  assert.deepStrictEqual(pe.resume(), { resumed: 0, finalised: 0 });
  fs.writeFileSync(pe.PENDING_FILE, JSON.stringify({ watches: [{ mode: "x" }, null, 5] }));
  assert.deepStrictEqual(pe.resume(), { resumed: 0, finalised: 0 });
});

check("no tmp files left behind after saves", async () => {
  const pe = freshTracker();
  setNow(ist(DAY, "10:00"));
  pe.track("bb_rsi", niftyCE(), { market: "NIFTY" });
  await settle();
  pe._internals.persistSync();
  const left = fs.readdirSync(pe.OUT_DIR).filter((n) => n.endsWith(".tmp"));
  assert.deepStrictEqual(left, []);
});

// ── 4. Trade / skip record tags + old-record compatibility ───────────────────
section("4. Trade and skip records carry market/strategy/reasons; old records still read");

const tl = require(path.join(UTILS, "tradeLogger.js"));
const sl = require(path.join(UTILS, "skipLogger.js"));
const tags = require(path.join(UTILS, "logTags.js"));

check("trade line: market + strategy derived from the mode, reasons explicit, input untouched", () => {
  const trade = niftyCE();
  const before = JSON.stringify(trade);
  const rec = tl._tradeRecord("bb_rsi", ist(DAY, "10:00"), trade);
  assert.strictEqual(JSON.stringify(trade), before, "the route's trade object must not be mutated");
  assert.strictEqual(rec.mode, "bb_rsi");
  assert.strictEqual(rec.market, "NIFTY");
  assert.strictEqual(rec.strategy, "BB_RSI");
  assert.strictEqual(rec.entryReason, "EMA cross + RSI 62");
  assert.strictEqual(rec.exitReason, "SuperTrend flip");
  assert.strictEqual(rec.pnl, 450);
  const bare = tl._tradeRecord("orb", 0, { side: "CE", pnl: 1 });
  assert.ok("entryReason" in bare && bare.entryReason === null);
  assert.ok("exitReason" in bare && bare.exitReason === null);
});

check("market/strategy per mode: SAIL, STOCKS, TDS, EARLYBIRD, own values win", () => {
  assert.deepStrictEqual(tags.tagsFor("sail_vwap_st", {}), { market: "SAIL", strategy: "SAIL_VWAP_ST" });
  assert.deepStrictEqual(tags.tagsFor("gap_runaway_stk", { strategy: "GAP_RUNAWAY_STK" }), { market: "STOCKS", strategy: "GAP_RUNAWAY_STK" });
  assert.deepStrictEqual(tags.tagsFor("trend_day_scalp", {}), { market: "NIFTY", strategy: "TDS" });
  assert.deepStrictEqual(tags.tagsFor("early_bird", {}), { market: "NIFTY", strategy: "EARLYBIRD" });
  assert.strictEqual(tags.marketFor("early_bird", { instrument: "NSE_EQUITY" }), "STOCKS", "EarlyBird's cash-equity leg");
  assert.strictEqual(tags.marketFor("bb_rsi", { market: "banknifty" }), "BANKNIFTY", "a trade naming its market keeps it");
  // Every logger mode gets a non-empty id.
  for (const m of Object.keys(tl.DAILY_PREFIX_BY_MODE)) assert.ok(tags.strategyIdFor(m), m);
});

check("skip row: market + strategy + reason (gate name when the caller gave none)", () => {
  const entry = { gate: "vix", spot: 24000 };
  const rec = sl._skipRecord("ema9vwap", ist(DAY, "10:00"), entry);
  assert.deepStrictEqual(entry, { gate: "vix", spot: 24000 }, "caller's entry untouched");
  assert.strictEqual(rec.market, "NIFTY");
  assert.strictEqual(rec.strategy, "EMA9VWAP");
  assert.strictEqual(rec.reason, "vix");
  assert.strictEqual(rec.istDate, DAY);
  const withReason = sl._skipRecord("gap_runaway_stk", 0, { gate: "data", reason: "no quote", stock: "TCS" });
  assert.strictEqual(withReason.reason, "no quote");
  assert.strictEqual(withReason.market, "STOCKS");
});

check("appendTradeLog writes the tagged line; a day file mixing old + new lines reads fine", async () => {
  setNow(ist(DAY, "16:00"));                          // after close → the tracker stays out of it
  const fp = tl.dailyFilePathFor("bb_rsi", DAY);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  // An old (pre-tag) line already on disk.
  fs.writeFileSync(fp, JSON.stringify({ mode: "bb_rsi", loggedAt: "2026-11-11T04:00:00.000Z", side: "PE", pnl: -120, exitReason: "SL" }) + "\n");
  tl.appendTradeLog("bb_rsi", niftyCE());
  await settle();
  const rows = tl.readDailyTrades("bb_rsi", DAY);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].market, undefined, "old line read as-is");
  assert.strictEqual(rows[0].pnl, -120);
  assert.strictEqual(rows[1].market, "NIFTY");
  assert.strictEqual(rows[1].strategy, "BB_RSI");
  const total = rows.reduce((s, r) => s + (Number(r.pnl) || 0), 0);
  assert.strictEqual(total, 330, "P&L sums unaffected by the new keys");
  const tradeSources = require(path.join(UTILS, "tradeSources.js"));
  assert.strictEqual(tradeSources.readRecords("bb_rsi", DAY).length, 2, "MCP reader serves both");
});

check("old in-memory/legacy watch shape (no market, numeric marks) still summarises", () => {
  const { summarise, lineFor } = freshTracker()._internals;
  const k = { mode: "orb", sym: "NSE:NIFTY50-INDEX", dir: 1, side: "CE", symbol: null, exitSpot: 100,
    exitMs: ist(DAY, "10:00"), exitTime: "10:00:00", entryTime: null, spotAtEntry: null, exitReason: "x", pnl: 1,
    date: DAY, hi: { px: 110, ms: ist(DAY, "10:30") }, lo: { px: 95, ms: ist(DAY, "10:10") },
    last: { px: 101, ms: ist(DAY, "15:29") }, marks: { 5: 99, 15: 104 }, ticks: 4 };
  const rec = summarise(k);
  assert.strictEqual(rec.market, "NIFTY");
  assert.strictEqual(rec.strategy, "ORB");
  assert.strictEqual(rec.marketClose, "15:30");
  assert.deepStrictEqual(rec.plus5m, { spot: 99, pts: -1, time: null });
  assert.strictEqual(rec.minutesToBest, 30);
  assert.strictEqual(rec.restarts, 0);
  assert.ok(lineFor(rec).includes("+10.0 pts"));
});

check("the /post-exit reader's day-file pattern never matches _pending.json", () => {
  const re = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;   // routes/mcpData.js
  assert.ok(!re.test(path.basename(freshTracker().PENDING_FILE)));
  const src = fs.readFileSync(path.join(SRC, "routes/mcpData.js"), "utf-8");
  assert.ok(src.includes("/^(\\d{4}-\\d{2}-\\d{2})\\.jsonl$/"), "mcpData day-file regex changed — re-check _pending.json is excluded");
});

check("tracker is wired: tradeLogger passes tags, app.js resumes at boot", () => {
  const tlSrc = fs.readFileSync(path.join(UTILS, "tradeLogger.js"), "utf-8");
  assert.ok(/postExitTracker"\)\.track\(mode, trade, \{ market: rec\.market, strategy: rec\.strategy, tradeId: rec\.tradeId \}\)/.test(tlSrc));
  const app = fs.readFileSync(path.join(SRC, "app.js"), "utf-8");
  assert.ok(app.includes('require("./utils/postExitTracker").resume()'));
});

run().then(() => {
  freshTracker();                                     // clears the last instance's trackers
  // Registered after every tracker's own exit-save hook, so it runs last.
  process.on("exit", () => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {} });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

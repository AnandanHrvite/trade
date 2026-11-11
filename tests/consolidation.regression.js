#!/usr/bin/env node
/**
 * CONSOLIDATION INVARIANTS — the consolidated page must show every paper trade's
 * P&L correctly, under every filter combination.
 *
 *   node tests/consolidation.regression.js
 *
 * Zero dependencies, exits non-zero on failure. Runs against fixture trade books
 * written into a TEMP HOME (never ~/trading-data), opens no socket or broker.
 *
 *   GROUP 1 — old records get the right market / strategy defaults
 *   GROUP 2 — filters combine; URL state round-trips
 *   GROUP 3 — totals (net, gross, charges, WR, avg, PF, max DD, daily)
 *   GROUP 4 — RECONCILIATION: for every book and date range, the consolidated
 *             total equals the total the strategy's OWN history page computes
 *             (its rendered trades-data, summed the way that page sums it)
 *   GROUP 5 — retired copy books + post-exit join + the page itself
 */

// UI_THEME=auto resolves by time of day; pin it so the page script under test is the same at any hour.
process.env.UI_THEME = "dark";
const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const vm     = require("vm");

// ── Temp HOME — must be set before ANY src module computes its data dir ──────
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "consol-reg-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const DATA = path.join(HOME, "trading-data");
fs.mkdirSync(path.join(DATA, "cmx"), { recursive: true });
fs.mkdirSync(path.join(DATA, "post_exit"), { recursive: true });
assert.strictEqual(os.homedir(), HOME, "os.homedir() must follow HOME for the fixture to be isolated");

// Default-OFF strategy switched on so its book is in the live set.
process.env.SAIL_VWAP_ST_MODE_ENABLED = "true";

let pass = 0, fail = 0;
const QUEUE = [];
function check(name, fn) { QUEUE.push({ name, fn }); }
function section(title) { QUEUE.push({ section: title }); }
async function run() {
  for (const item of QUEUE) {
    if (item.section) { console.log(`\n${item.section}`); continue; }
    try { await item.fn(); console.log(`  ✅ ${item.name}`); pass++; }
    catch (e) { console.log(`  ❌ ${item.name}\n       ${e.message}`); fail++; }
  }
}

// ── Fixture books ────────────────────────────────────────────────────────────
const T = (o) => Object.assign({ qty: 65, entryPrice: 24000, exitPrice: 24020, symbol: "NSE:NIFTY26NOV24000CE" }, o);
const books = {
  "ema_rsi_st_paper_trades.json": { capital: 100000, totalPnl: 0, sessions: [
    // ISO session start, Tue 3 Nov (NIFTY expiry day)
    { date: "2026-11-03T03:50:00.000Z", strategy: "SWING_EMA_RSI_ST", trades: [
      T({ side: "CE", pnl: 1200.5, charges: 40.25, exitReason: "Target hit", entryTime: "03/11/2026, 09:31:00", exitTime: "03/11/2026, 10:15:00", spotAtExit: 24055 }),
      T({ side: "PE", pnl: -300.25, charges: 38, exitReason: "SL hit @ 24010", entryTime: "03/11/2026, 11:02:00", exitTime: "03/11/2026, 11:20:00" }),
    ]},
    // en-IN restart stamp (day first) → Mon 9 Nov: a PREPONED expiry (Tue 10 Nov is a holiday)
    { date: "9/11/2026, 09:20:15", trades: [
      T({ side: "CE", pnl: -150, exitReason: "EOD square off", entryTime: "09/11/2026, 13:40:00", exitTime: "09/11/2026, 15:15:00" }),
    ]},
    // Thu 5 Nov — not an expiry
    { date: "2026-11-05T04:00:00Z", trades: [
      T({ side: "CE", pnl: 500, charges: 41, exitReason: "Trailing stop hit", entryTime: "05/11/2026, 10:00:00", exitTime: "05/11/2026, 10:40:00" }),
      T({ side: "PE", pnl: 77.1, exitReason: "Manual exit", entryTime: "05/11/2026, 12:00:00", exitTime: "05/11/2026, 12:30:00" }),
    ]},
  ]},
  "bb_rsi_paper_trades.json": { capital: 100000, totalPnl: 0, sessions: [
    { date: "2026-11-04", trades: [
      T({ side: "PE", pnl: 800, charges: 30, exitReason: "BB re-entry", entryTime: "04/11/2026, 10:05:00", exitTime: "04/11/2026, 10:25:00" }),
      T({ side: "PE", pnl: -200.1, charges: 30, exitReason: "Hard SL", entryTime: "04/11/2026, 13:05:00", exitTime: "04/11/2026, 13:10:00" }),
      T({ side: "CE", pnl: 0, exitReason: "Time stop", entryTime: "04/11/2026, 14:00:00", exitTime: "04/11/2026, 14:20:00" }),   // flat
    ]},
  ]},
  // New-format record: the trade names its own market / strategy / contract expiry.
  "pivot_ema_st_paper_trades.json": { capital: 100000, totalPnl: 0, sessions: [
    { date: "2026-11-06", trades: [
      T({ side: "CE", pnl: 250, market: "SENSEX", strategy: "PIVOT_EMA_ST", expiryDate: "2026-11-06", exitCategory: "TARGET", exitReason: "x", entryTime: "06/11/2026, 10:00:00", exitTime: "06/11/2026, 10:30:00" }),
    ]},
  ]},
  "sail_vwap_st_paper_trades.json": { capital: 100000, totalPnl: 0, sessions: [
    { date: "2026-11-06", trades: [ T({ side: "CE", pnl: 90, exitReason: "VWAP cross", entryTime: "06/11/2026, 11:00:00", exitTime: "06/11/2026, 11:40:00" }) ] },
  ]},
  "gap_runaway_stk_paper_trades.json": { capital: 100000, totalPnl: 0, sessions: [
    { date: "2026-11-05", trades: [ T({ side: "LONG", symbol: "NSE:TATASTEEL-EQ", pnl: 300, exitReason: "Target", entryTime: "05/11/2026, 09:20:00", exitTime: "05/11/2026, 09:50:00" }) ] },
  ]},
  // ── The NIFTY BANK EMA_RSI_ST_V2 book — a running (strategy, market) pair
  //    again (config/pairs.js), switched OFF here: still on the consolidated page ──
  "bn_ema_rsi_st_v2_paper_trades.json": { capital: 100000, totalPnl: 0, sessions: [
    { date: "2026-11-03T03:50:00.000Z", trades: [ T({ side: "CE", pnl: 700, exitReason: "Target", entryTime: "03/11/2026, 10:00:00", exitTime: "03/11/2026, 10:20:00" }) ] },
  ]},
  "bn_pivot_rsi_st_paper_trades.json": { capital: 100000, totalPnl: 0, sessions: [
    { date: "2026-11-04", trades: [ T({ side: "PE", pnl: -90, exitReason: "SL", entryTime: "04/11/2026, 10:00:00", exitTime: "04/11/2026, 10:20:00" }) ] },
  ]},
  "fut_ema_rsi_st_paper_trades.json": { capital: 100000, totalPnl: 0, sessions: [
    { date: "2026-11-04", trades: [ T({ side: "PE", pnl: -120, isFutures: true, instrument: "NIFTY_FUTURES", charges: 25, exitReason: "Stop loss", entryTime: "04/11/2026, 11:00:00", exitTime: "04/11/2026, 11:30:00" }) ] },
  ]},
  "sail_pivot_ema_st_paper_trades.json": { capital: 100000, totalPnl: 0, sessions: [
    { date: "2026-11-05", trades: [ T({ side: "CE", pnl: 60, exitReason: "Target", entryTime: "05/11/2026, 10:00:00", exitTime: "05/11/2026, 10:10:00" }) ] },
  ]},
};
for (const [n, b] of Object.entries(books)) fs.writeFileSync(path.join(DATA, n), JSON.stringify(b));
// Commodity book: { days: { date: { trades } } }, ISO entry times.
const cmxBook = { days: {
  "2026-11-06": { trades: [ { side: "CE", pnl: 450, exitReason: "Target", entryTime: "2026-11-06T10:00:00.000Z", exitTime: "2026-11-06T11:00:00.000Z" } ] },
  "2026-11-09": { trades: [ { side: "PE", pnl: -180.4, exitReason: "Stop loss", entryTime: "2026-11-09T10:00:00.000Z", exitTime: "2026-11-09T10:30:00.000Z" } ] },
}};
fs.writeFileSync(path.join(DATA, "cmx", "cmx_gold_ema_rsi_st_paper_trades.json"), JSON.stringify(cmxBook));
// A file that is NOT a retired copy book must not be picked up.
fs.writeFileSync(path.join(DATA, "straddle_paper_trades.json"), JSON.stringify({ sessions: [{ date: "2026-11-03", trades: [{ side: "CE", pnl: 9999 }] }] }));
// Post-exit record for the 3 Nov EMA_RSI_ST CE trade.
fs.writeFileSync(path.join(DATA, "post_exit", "2026-11-03.jsonl"), [
  JSON.stringify({ type: "post_exit", date: "2026-11-03", mode: "ema_rsi_st", side: "CE", exitTime: "03/11/2026, 10:15:00", spotAtExit: 24055,
    bestAfterExit: { spot: 24067.5, pts: 12.5, time: "10:42" }, worstAfterExit: { spot: 24049, pts: -6, time: "10:20" },
    plus5m: { spot: 24050, pts: -5 }, plus15m: { spot: 24060, pts: 5 }, plus30m: { spot: 24066, pts: 11 }, plus60m: null }),
  "not json",
].join("\n") + "\n");

const CC = require("../src/utils/consolidationCore");
const consolidation = require("../src/routes/consolidation");
const { renderHistoryPage } = require("../src/utils/paperHistoryUI");
const { trades: ALL, retiredBooks } = consolidation.loadConsolidatedTrades();
const TODAY = "2026-11-11";   // Wed
const pick = (f) => CC.filterTrades(ALL, Object.assign(CC.emptyFilter(), f), TODAY);
const sum = (list) => list.reduce((a, t) => a + t.pnl, 0);
const r2 = (n) => Math.round(n * 100) / 100;
const byMode = (m) => ALL.filter((t) => t.mode === m);

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 1 — old records get the right market / strategy defaults");

check("markets default by book key when the record carries none", () => {
  const mk = (m) => [...new Set(byMode(m).map((t) => t.market))];
  assert.deepStrictEqual(mk("EMA_RSI_ST"), ["NIFTY"]);
  assert.deepStrictEqual(mk("SAIL_VWAP_ST"), ["SAIL"]);
  assert.deepStrictEqual(mk("GAP_RUNAWAY_STK"), ["STOCKS"]);
  assert.deepStrictEqual(mk("BN_EMA_RSI_ST_V2"), ["BANKNIFTY"]);
  assert.deepStrictEqual(mk("BN_PIVOT_RSI_ST"), ["BANKNIFTY"]);
  assert.deepStrictEqual(mk("FUT_EMA_RSI_ST"), ["NIFTY_FUT"]);
  assert.deepStrictEqual(mk("SAIL_PIVOT_EMA_ST"), ["SAIL"]);
  assert.deepStrictEqual(mk("CMX_GOLD_EMA_RSI_ST"), ["GOLD"]);
});

check("the pure defaults cover every rule in the spec", () => {
  const cases = { ema_rsi_st: "NIFTY", sail_vwap_st: "SAIL", gap_runaway_stk: "STOCKS", bn_pivot_ema_st: "BANKNIFTY",
    fut_bb_rsi: "NIFTY_FUT", cmx_crude_pivot_ema_st: "CRUDE", cmx_gold_ema_rsi_st_v2: "GOLD", cmx_silver_ema_rsi_st: "SILVER",
    sail_pivot_ema_st: "SAIL", trend_day_scalp: "NIFTY" };
  for (const [k, want] of Object.entries(cases)) assert.strictEqual(CC.marketOf(k, {}), want, k);
  assert.strictEqual(CC.marketOf("ema_rsi_st", { market: "banknifty" }), "BANKNIFTY", "a record's own market wins");
  assert.strictEqual(CC.marketOf("ema_rsi_st", { market: "NIFTY_FUTURES" }), "NIFTY_FUT", "aliases normalise");
});

check("a record's own market wins over the book default", () => {
  assert.deepStrictEqual(byMode("PIVOT_EMA_ST").map((t) => t.market), ["SENSEX"]);
});

check("copy books fold into the strategy they copied", () => {
  const st = (m) => [...new Set(byMode(m).map((t) => t.strategyId))];
  assert.deepStrictEqual(st("BN_EMA_RSI_ST_V2"), ["EMA_RSI_ST_V2"]);
  assert.deepStrictEqual(st("BN_PIVOT_RSI_ST"), ["RSI_PIVOT_ST"]);
  assert.deepStrictEqual(st("FUT_EMA_RSI_ST"), ["EMA_RSI_ST"]);
  assert.deepStrictEqual(st("SAIL_PIVOT_EMA_ST"), ["PIVOT_EMA_ST"]);
  assert.deepStrictEqual(st("CMX_GOLD_EMA_RSI_ST"), ["EMA_RSI_ST"]);
  assert.deepStrictEqual(st("GAP_RUNAWAY_STK"), ["GAP_RUNAWAY"]);
  assert.deepStrictEqual(st("SAIL_VWAP_ST"), ["SAIL_VWAP_ST"], "SAIL_VWAP_ST is its own strategy, not a copy");
  assert.strictEqual(CC.baseStrategyOfMode("TDS"), "TDS", "a live strategy's id is its mode");
});

check("session-date shapes resolve to the IST day (ISO, en-IN day-first, bare)", () => {
  assert.deepStrictEqual([...new Set(byMode("EMA_RSI_ST").map((t) => t.date))].sort(), ["2026-11-03", "2026-11-05", "2026-11-09"]);
});

check("direction: CE / LONG are long, PE / SHORT are short", () => {
  assert.strictEqual(byMode("GAP_RUNAWAY_STK")[0].dir, "LONG");
  assert.ok(byMode("BB_RSI").filter((t) => t.side === "PE").every((t) => t.dir === "SHORT"));
});

check("exit reasons bucket into categories; a record's own category wins", () => {
  const cat = (r) => CC.exitCategory({ exitReason: r });
  assert.strictEqual(cat("Target hit"), "Target");
  assert.strictEqual(cat("SL hit @ 24010"), "Stop loss");
  assert.strictEqual(cat("Trailing stop hit"), "Trailing stop");
  assert.strictEqual(cat("Time stop"), "EOD / time");
  assert.strictEqual(cat("EOD square off"), "EOD / time");
  assert.strictEqual(cat("Manual exit"), "Manual");
  assert.strictEqual(cat("Profit lock floor"), "Profit lock");
  assert.strictEqual(cat("BB re-entry"), "Signal / reversal");
  assert.strictEqual(cat(""), "Other");
  assert.strictEqual(byMode("PIVOT_EMA_ST")[0].exitCat, "Target", "exitCategory on the record wins over its text");
});

check("expiry day: NIFTY from the NSE calendar (incl. a preponed Monday), others from the record or unknown", () => {
  const d = (m, date) => byMode(m).find((t) => t.date === date).isExpiry;
  assert.strictEqual(d("EMA_RSI_ST", "2026-11-03"), true, "Tuesday");
  assert.strictEqual(d("EMA_RSI_ST", "2026-11-09"), true, "Monday before the Balipratipada holiday");
  assert.strictEqual(d("EMA_RSI_ST", "2026-11-05"), false);
  assert.strictEqual(d("FUT_EMA_RSI_ST", "2026-11-04"), false, "NIFTY_FUT follows the NIFTY calendar");
  assert.strictEqual(d("PIVOT_EMA_ST", "2026-11-06"), true, "SENSEX record carrying its own expiryDate");
  assert.strictEqual(d("SAIL_VWAP_ST", "2026-11-06"), null, "no calendar, no expiryDate → unknown, never guessed");
  assert.ok(typeof CC.EXPIRY_CALENDARS.NIFTY === "function", "the per-market hook is a plain map");
});

check("charges / gross: own charges add back, missing charges leave gross = net", () => {
  const t = byMode("EMA_RSI_ST").find((x) => x.pnl === 1200.5);
  assert.strictEqual(t.charges, 40.25);
  assert.strictEqual(r2(t.gross), 1240.75);
  const u = byMode("EMA_RSI_ST").find((x) => x.pnl === -150);
  assert.strictEqual(u.charges, null);
  assert.strictEqual(u.gross, -150);
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 2 — filters combine; URL state round-trips");

check("market filter", () => {
  assert.strictEqual(pick({ market: "BANKNIFTY" }).length, 2);
  assert.strictEqual(pick({ market: "GOLD" }).length, 2);
  assert.ok(pick({ market: "NIFTY" }).every((t) => t.market === "NIFTY"));
});

check("strategy + market isolates one book", () => {
  const rows = pick({ strategy: "EMA_RSI_ST", market: "NIFTY_FUT" });
  assert.deepStrictEqual([...new Set(rows.map((t) => t.mode))], ["FUT_EMA_RSI_ST"]);
  const all = pick({ strategy: "EMA_RSI_ST" });
  assert.deepStrictEqual([...new Set(all.map((t) => t.mode))].sort(), ["CMX_GOLD_EMA_RSI_ST", "EMA_RSI_ST", "FUT_EMA_RSI_ST"]);
});

check("side: CE / PE exact, LONG / SHORT by direction", () => {
  assert.ok(pick({ side: "CE" }).every((t) => t.side === "CE"));
  const longs = pick({ side: "LONG" });
  assert.ok(longs.some((t) => t.side === "LONG") && longs.some((t) => t.side === "CE"));
  assert.ok(pick({ side: "SHORT" }).every((t) => t.side === "PE"));
});

check("win / loss leave flat trades out of both", () => {
  const w = pick({ result: "win" }), l = pick({ result: "loss" });
  assert.ok(w.every((t) => t.pnl > 0) && l.every((t) => t.pnl < 0));
  assert.strictEqual(w.length + l.length + ALL.filter((t) => t.pnl === 0).length, ALL.length);
});

check("exit-reason filter", () => {
  assert.ok(pick({ exit: "Stop loss" }).every((t) => t.exitCat === "Stop loss"));
  assert.strictEqual(pick({ exit: "Manual" }).length, 1);
});

check("expiry filter: unknown status matches neither choice, and is counted", () => {
  const e = pick({ expiry: "expiry" }), n = pick({ expiry: "non" });
  assert.ok(e.every((t) => t.isExpiry === true) && n.every((t) => t.isExpiry === false));
  const unknown = ALL.filter((t) => t.isExpiry == null).length;
  assert.ok(unknown > 0, "fixture must hold an unknown-expiry trade");
  assert.strictEqual(e.length + n.length + unknown, ALL.length);
  assert.strictEqual(CC.unknownExpiryHidden(ALL, Object.assign(CC.emptyFilter(), { expiry: "expiry" }), TODAY), unknown);
});

check("date presets: today / this week (Mon-start) / this month / custom", () => {
  assert.deepStrictEqual(CC.resolveRange({ preset: "td" }, TODAY), { from: TODAY, to: TODAY });
  assert.deepStrictEqual(CC.resolveRange({ preset: "wk" }, TODAY), { from: "2026-11-09", to: TODAY });
  assert.deepStrictEqual(CC.resolveRange({ preset: "wk" }, "2026-11-15"), { from: "2026-11-09", to: "2026-11-15" }, "Sunday stays in its week");
  assert.deepStrictEqual(CC.resolveRange({ preset: "wk" }, "2026-11-09"), { from: "2026-11-09", to: "2026-11-09" });
  assert.deepStrictEqual(CC.resolveRange({ preset: "tm" }, TODAY), { from: "2026-11-01", to: TODAY });
  assert.deepStrictEqual(CC.resolveRange({ preset: "custom", from: "2026-11-04", to: "2026-11-05" }, TODAY), { from: "2026-11-04", to: "2026-11-05" });
  assert.deepStrictEqual(pick({ preset: "wk" }).map((t) => t.date).sort(), ["2026-11-09", "2026-11-09"]);
  assert.strictEqual(pick({ preset: "td" }).length, 0);
});

check("filters combine (AND), and the combination is order-independent", () => {
  const f = { market: "NIFTY", preset: "custom", from: "2026-11-03", to: "2026-11-05", side: "PE", result: "loss" };
  const rows = pick(f);
  assert.deepStrictEqual(rows.map((t) => t.pnl).sort((a, b) => a - b), [-300.25, -200.1]);
  const manual = ALL.filter((t) => t.market === "NIFTY" && t.date >= "2026-11-03" && t.date <= "2026-11-05" && t.side === "PE" && t.pnl < 0);
  assert.strictEqual(rows.length, manual.length);
});

check("URL query round-trips and drops defaults", () => {
  const f = Object.assign(CC.emptyFilter(), { market: "BANKNIFTY", strategy: "EMA_RSI_ST_V2", preset: "custom", from: "2026-11-01", to: "2026-11-09", side: "LONG", result: "win", exit: "Stop loss", expiry: "non", q: "nifty" });
  const back = CC.parseQuery(CC.toQuery(f));
  assert.deepStrictEqual(back, f);
  assert.strictEqual(CC.toQuery(CC.emptyFilter()), "", "the default view has a bare URL");
  assert.strictEqual(CC.toQuery(Object.assign(CC.emptyFilter(), { preset: "tm", from: "2026-01-01" })), "?preset=tm", "a preset carries no stale from/to");
  assert.strictEqual(CC.parseQuery("?from=2026-11-04").preset, "custom", "a bare from/to is a custom range");
  assert.strictEqual(CC.parseQuery("?preset=bogus").preset, "all");
  assert.strictEqual(CC.parseQuery("?mode=bn_ema_rsi_st_v2").mode, "BN_EMA_RSI_ST_V2");
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 3 — totals");

check("net / gross / charges / counts / win rate / averages / PF on a hand-checked set", () => {
  const rows = pick({ mode: "EMA_RSI_ST" });   // 1200.5, -300.25, -150, 500, 77.1
  const o = CC.totals(rows);
  assert.strictEqual(o.trades, 5);
  assert.strictEqual(o.wins, 3); assert.strictEqual(o.losses, 2);
  assert.strictEqual(r2(o.net), 1327.35);
  assert.strictEqual(r2(o.charges), 119.25); assert.strictEqual(o.chargesN, 3);
  assert.strictEqual(r2(o.gross), 1446.6);
  assert.strictEqual(r2(o.winRate), 60);
  assert.strictEqual(r2(o.avgWin), r2((1200.5 + 500 + 77.1) / 3));
  assert.strictEqual(r2(o.avgLoss), r2((-300.25 - 150) / 2));
  assert.strictEqual(r2(o.pf), r2(1777.6 / 450.25));
});

check("max drawdown walks the equity curve in time order (day, then exit clock)", () => {
  // 3 Nov: +1200.5 then -300.25 → peak 1200.5, eq 900.25 · 5 Nov: +500, +77.1 → 1477.35 · 9 Nov: -150
  const o = CC.totals(pick({ mode: "EMA_RSI_ST" }));
  assert.strictEqual(r2(o.maxDD), 300.25);
  assert.strictEqual(o.ddTroughDate, "2026-11-03");
  // Out-of-order input must give the same answer.
  const o2 = CC.totals(pick({ mode: "EMA_RSI_ST" }).slice().reverse());
  assert.strictEqual(r2(o2.maxDD), 300.25);
  const z = CC.totals([]);
  assert.strictEqual(z.trades, 0); assert.strictEqual(z.pf, null); assert.strictEqual(z.maxDD, 0);
  assert.strictEqual(CC.totals([{ pnl: 5, date: "2026-11-01" }]).pf, Infinity, "no losses → PF ∞, not a divide error");
});

check("per-market and per-strategy breakdowns add back to the total", () => {
  const net = r2(sum(ALL));
  assert.strictEqual(r2(CC.breakdown(ALL, (t) => t.market).reduce((a, r) => a + r.net, 0)), net);
  assert.strictEqual(r2(CC.breakdown(ALL, (t) => t.strategyId).reduce((a, r) => a + r.net, 0)), net);
  assert.strictEqual(CC.breakdown(ALL, (t) => t.market).reduce((a, r) => a + r.trades, 0), ALL.length);
});

check("daily list: one row per day, cumulative ends at the net", () => {
  const d = CC.daily(ALL);
  assert.deepStrictEqual(d.map((x) => x.date), [...new Set(ALL.map((t) => t.date))].sort());
  assert.strictEqual(r2(d[d.length - 1].cum), r2(sum(ALL)));
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 4 — reconciliation with each strategy's own history page");

// What a strategy's history page itself says: render the real page from the book
// and read the trades it embeds (each already dated by the page's own istDay).
function historyPageTrades(book) {
  const html = renderHistoryPage({ routePrefix: "/x-paper", sidebarKey: "x", pageTitle: "x", modalLabel: "x",
    sessions: book.sessions || [], capital: book.capital, totalPnl: book.totalPnl, startCap: 100000, emptyLabel: "" });
  const m = html.match(/<script id="trades-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, "history page no longer embeds trades-data — update this harness");
  return JSON.parse(m[1]);
}
// The page's own sum: (t.pnl || 0) per trade inside the range.
const histSum = (trades, from, to) => trades.filter((t) => (!from || t.date >= from) && (!to || t.date <= to)).reduce((a, t) => a + (t.pnl || 0), 0);
// Commodity history pages summed d.trades[].pnl per day key.
const cmxSum = (from, to) => Object.entries(cmxBook.days).filter(([d]) => (!from || d >= from) && (!to || d <= to))
  .reduce((a, [, d]) => a + d.trades.reduce((x, t) => x + (Number(t.pnl) || 0), 0), 0);

const RANGES = [["", ""], ["2026-11-03", "2026-11-03"], ["2026-11-04", "2026-11-06"], ["2026-11-05", ""], ["", "2026-11-04"], ["2026-11-09", "2026-11-09"], ["2026-12-01", "2026-12-31"]];

check("every session book: consolidated (mode) total === history page total, for every range", () => {
  let compared = 0;
  for (const [file, book] of Object.entries(books)) {
    const mode = file.replace(/_paper_trades\.json$/, "").toUpperCase()
      .replace(/^TREND_DAY_SCALP$/, "TDS").replace(/^EARLY_BIRD$/, "EARLYBIRD");
    const hist = historyPageTrades(book);
    for (const [from, to] of RANGES) {
      const f = { mode, preset: from || to ? "custom" : "all", from, to };
      const ours = r2(sum(pick(f)));
      const theirs = r2(histSum(hist, from, to));
      assert.strictEqual(ours, theirs, `${mode} ${from || "…"}→${to || "…"}: consolidated ${ours} ≠ history ${theirs}`);
      assert.strictEqual(pick(f).length, hist.filter((t) => (!from || t.date >= from) && (!to || t.date <= to)).length, `${mode} trade count`);
      compared++;
    }
  }
  assert.ok(compared >= Object.keys(books).length * RANGES.length);
});

check("strategy + market filters reconcile too (the way a user picks a book)", () => {
  const pairs = [
    ["EMA_RSI_ST", "NIFTY", "ema_rsi_st_paper_trades.json"], ["EMA_RSI_ST", "NIFTY_FUT", "fut_ema_rsi_st_paper_trades.json"],
    ["EMA_RSI_ST_V2", "BANKNIFTY", "bn_ema_rsi_st_v2_paper_trades.json"], ["RSI_PIVOT_ST", "BANKNIFTY", "bn_pivot_rsi_st_paper_trades.json"],
    ["PIVOT_EMA_ST", "SAIL", "sail_pivot_ema_st_paper_trades.json"], ["GAP_RUNAWAY", "STOCKS", "gap_runaway_stk_paper_trades.json"],
    ["BB_RSI", "NIFTY", "bb_rsi_paper_trades.json"],
  ];
  for (const [strategy, market, file] of pairs) {
    const hist = historyPageTrades(books[file]);
    for (const [from, to] of RANGES) {
      const ours = r2(sum(pick({ strategy, market, preset: from || to ? "custom" : "all", from, to })));
      assert.strictEqual(ours, r2(histSum(hist, from, to)), `${strategy}@${market} ${from}→${to}`);
    }
  }
});

check("commodity book reconciles with its day-keyed history", () => {
  for (const [from, to] of RANGES) {
    const ours = r2(sum(pick({ market: "GOLD", preset: from || to ? "custom" : "all", from, to })));
    assert.strictEqual(ours, r2(cmxSum(from, to)), `GOLD ${from}→${to}`);
  }
});

check("the history page still dates and sums trades the way this harness assumes", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/utils/paperHistoryUI.js"), "utf-8");
  assert.ok(/istDay:\s*istDayFromAny\(s\.date\)/.test(src), "history page no longer dates sessions with istDayFromAny");
  assert.ok(/a \+ \(t\.pnl\|\|0\)/.test(src), "history page no longer sums (t.pnl||0)");
});

check("the cached loadAllTrades() rows are not mutated by the consolidated view", () => {
  const raw = consolidation.loadAllTrades();
  assert.ok(raw.length > 0);
  assert.ok(raw.every((t) => !("exitCat" in t) && !("postExit" in t)), "annotation leaked into the shared /data rows");
  assert.ok(!raw.some((t) => /^(BN|FUT|CMX|SAIL_PIVOT)_/.test(t.mode)), "retired books must stay out of loadAllTrades() (dashboard + EOD reports)");
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 5 — retired books, post-exit join, the page");

check("retired copy books are discovered from disk; unrelated books are not", () => {
  assert.deepStrictEqual(retiredBooks.map((b) => b.mode).sort(),
    ["BN_PIVOT_RSI_ST", "CMX_GOLD_EMA_RSI_ST", "FUT_EMA_RSI_ST", "SAIL_PIVOT_EMA_ST"]);
  // BN_EMA_RSI_ST_V2 is a live pair book now (its route runs again) — not retired,
  // and its history is still listed while the pair is switched off.
  assert.ok(byMode("BN_EMA_RSI_ST_V2").length && byMode("BN_EMA_RSI_ST_V2").every((t) => !t.retired));
  assert.ok(!ALL.some((t) => t.pnl === 9999), "straddle book must not be swept in");
  assert.ok(ALL.filter((t) => t.retired).every((t) => retiredBooks.some((b) => b.mode === t.mode)));
});

check("post-exit move joins onto its trade (best / worst / minutes to best)", () => {
  const t = byMode("EMA_RSI_ST").find((x) => x.pnl === 1200.5);
  assert.deepStrictEqual(t.postExit, { bestPts: 12.5, bestTime: "10:42", minsToBest: 27, worstPts: -6, worstTime: "10:20", p5: -5, p15: 5, p30: 11, p60: null });
  assert.strictEqual(ALL.filter((x) => x.postExit).length, 1, "no other trade may borrow that record");
});

function renderPage(query) {
  const layer = consolidation.stack.find((l) => l.route && l.route.path === "/" && l.route.methods.get);
  let html = "";
  layer.route.stack[0].handle({ query: query || {} }, { send: (h) => { html = h; }, set() {}, get() {} });
  return html;
}

check("the page renders, every inline script parses, and the core is embedded verbatim", () => {
  const html = renderPage();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2);
  scripts.forEach((code, i) => { try { new vm.Script(code); } catch (e) { throw new Error(`inline script #${i}: ${e.message}`); } });
  assert.ok(html.includes(CC.coreFactory.toString()), "page must run the exact factory the tests check");
  assert.ok(/<meta name="viewport"/.test(html));
  for (const id of ["fMarket", "fStrat", "fPreset", "fFrom", "fTo", "fSide", "fResult", "fExit", "fExpiry", "fSearch", "totGrid", "bdMarket", "bdStrat", "tradesTbl", "fSheet"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(/<option value="BANKNIFTY">/.test(html) && /<option value="GOLD">/.test(html), "retired markets must be filterable");
});

check("the trades JSON is embedded with '<' escaped (no </script> break-out)", () => {
  const p = path.join(DATA, "orb_paper_trades.json");
  fs.writeFileSync(p, JSON.stringify({ sessions: [{ date: "2026-11-05", trades: [{ side: "CE", pnl: 1, exitReason: "</script><b>x" }] }] }));
  try {
    const html = renderPage();
    assert.ok(!html.includes("</script><b>x"));
  } finally { fs.unlinkSync(p); }
});

// Run the page's own script against a minimal DOM stub: it must load from a
// bookmarked URL, apply that filter, and render totals that match the core.
check("the page script restores filters from the URL and renders matching totals", () => {
  const html = renderPage();
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).pop();
  const els = {};
  const mkEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", style: {}, dataset: {}, disabled: false, tagName: /^f(Market|Strat|Preset|Side|Result|Exit|Expiry)$/.test(id) ? "SELECT" : "DIV",
    options: [], classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, appendChild(o) { this.options.push(o); }, focus() {},
    querySelector() { return mkEl("_q"); }, querySelectorAll() { return []; }, getContext() { return {}; },
    closest() { return mkEl("_c"); }, parentElement: null,
  });
  // Selects only take values they list — mimic that for the market select.
  const html2opts = (id) => (html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`)) || ["", ""])[1].match(/value="([^"]*)"/g).map((s) => ({ value: s.slice(7, -1) }));
  const doc = {
    getElementById: (id) => {
      if (!els[id]) { els[id] = mkEl(id); if (els[id].tagName === "SELECT") els[id].options = html2opts(id); }
      return els[id];
    },
    querySelector: (sel) => (els[sel] = els[sel] || mkEl(sel)), querySelectorAll: () => [], addEventListener() {},
    createElement: () => mkEl("_n"), documentElement: { getAttribute: () => null }, body: { classList: { add() {}, remove() {}, contains() { return false; } }, appendChild() {} },
  };
  let replaced = null;
  const ctx = {
    document: doc, window: {}, navigator: {}, console, setTimeout, clearTimeout, URLSearchParams, Blob: function () {}, URL: {},
    location: { search: "?market=NIFTY&preset=custom&from=2026-11-03&to=2026-11-05&result=loss", pathname: "/consolidation", hash: "" },
    history: { replaceState: (a, b, u) => { replaced = u; } },
    Chart: function () { this.destroy = () => {}; },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  assert.strictEqual(els.fMarket.value, "NIFTY");
  assert.strictEqual(els.fResult.value, "loss");
  assert.strictEqual(replaced, "/consolidation?market=NIFTY&preset=custom&from=2026-11-03&to=2026-11-05&result=loss");
  const want = CC.totals(pick({ market: "NIFTY", preset: "custom", from: "2026-11-03", to: "2026-11-05", result: "loss" }));
  assert.ok(els.totGrid.innerHTML.includes(String(want.trades)), "totals tile missing trade count");
  const fmt = (n) => "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.ok(els.totGrid.innerHTML.includes(fmt(want.net)), `net ${fmt(want.net)} not shown`);
  assert.ok(/NIFTY/.test(els["#bdMarket tbody"].innerHTML), "per-market breakdown not rendered");
  assert.ok(/EMA_RSI_ST/.test(els["#bdStrat tbody"].innerHTML) && /BB_RSI/.test(els["#bdStrat tbody"].innerHTML), "per-strategy breakdown not rendered");
});

check("npm test runs this suite", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"));
  assert.ok(/tests\/consolidation\.regression\.js/.test(pkg.scripts.test));
});

run().then(() => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${fail ? "FAILURES" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

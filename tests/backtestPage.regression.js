#!/usr/bin/env node
/**
 * THE ONE BACKTEST PAGE (/backtest) — regression suite
 *
 *   node tests/backtestPage.regression.js
 *
 * Zero dependencies beyond the app's own (express is already one), no network,
 * no Fyers: every candle request is answered from the deterministic synthetic
 * market the golden baseline uses (scripts/lib/syntheticMarket.js), and every
 * write lands in a temp dir.
 *
 * What it proves:
 *   1. form options — every strategy with a backtest is on the page, with its
 *      candle-size choice and a settings list GENERATED from the Settings schema;
 *   2. offered-market filtering — only pairs.js-offered markets are listed, only
 *      the ones the engine runs are enabled, the rest are "coming soon", and a
 *      run on anything else is refused;
 *   3. NIFTY parity — a run through /backtest and a run through the strategy's
 *      OLD page produce byte-identical job results (trades + stats);
 *   4. EMA_RSI_ST_V2 and EMA_RSI_ST are market-aware — SENSEX / BANKNIFTY /
 *      NIFTY_FUT fetch the market's own candles and price with its lot, its
 *      exchange's charges and (futures) futures P&L, and read the market's pair
 *      settings;
 *   5. custom settings apply to the run only — never to process.env;
 *   6. saved results record strategy, market and the exact settings used, and
 *      re-open.
 */

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const http   = require("http");

const SRC = path.join(__dirname, "../src");
const say = console.log.bind(console);   // console.log is muted while a check runs

// ── A clean sandbox ─────────────────────────────────────────────────────────
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "backtest-page-"));
process.chdir(SANDBOX);   // Settings reads <cwd>/.env — there is none here
for (const k of Object.keys(process.env)) {
  if (/^(EMA_RSI_ST_V2|TDS_|HA_SCALP_|SENSEX_|BN_|FUT_|ORB_|TREND_PB_|PROFIT_LOCK_|PREMIUM_SL_|BACKTEST_|UI_SHOW_|API_SECRET|LOGIN_SECRET|DEMO_)/.test(k)) delete process.env[k];
}
process.env.ACCESS_TOKEN = "test-token";   // the page refuses to start without a Fyers login

// ── Stubs, installed BEFORE any route loads (routes destructure at require) ──
const market = require("../scripts/lib/syntheticMarket");
const SCALE = { "NSE:NIFTY50-INDEX": 1, "NSE:NIFTYBANK-INDEX": 2.2, "BSE:SENSEX-INDEX": 3.3 };
const fetchLog = [];
function synthCandles(symbol, resolution, from, to) {
  fetchLog.push({ symbol, resolution, from, to });
  const k = SCALE[symbol] != null ? SCALE[symbol] : 1;
  const days = market.tradingDaysBetween(from, to);
  const scale = (b) => ({ time: b.time, open: +(b.open * k).toFixed(2), high: +(b.high * k).toFixed(2), low: +(b.low * k).toFixed(2), close: +(b.close * k).toFixed(2), volume: b.volume || 0 });
  if (String(resolution).toUpperCase() === "D") return days.map((d) => market.dailyBar(d)).filter(Boolean).map(scale);
  const res = parseInt(resolution, 10) || 5;
  const out = [];
  for (const d of days) for (const b of market.intradayBars(d, res)) out.push(scale(b));
  return out;
}
const engineSvc = require("../src/services/backtestEngine");
engineSvc.fetchCandles = async (symbol, resolution, from, to) => synthCandles(symbol, resolution, from, to);
engineSvc.fetchCandlesCachedBT = async (symbol, resolution, from, to) => synthCandles(symbol, resolution, from, to);

const resultStore = require("../src/utils/resultStore");
const legacySaves = [];
resultStore._writeResult = (key, v) => { legacySaves.push(key); };
resultStore._setRunsDir(path.join(SANDBOX, "runs"));

const express      = require("express");
const registry     = require("../src/config/strategyRegistry");
const pairs        = require("../src/config/pairs");
const markets      = require("../src/config/markets");
const backtestJobs = require("../src/utils/backtestJobManager");
const page         = require("../src/services/backtestPage");
const bm           = require("../src/services/backtestMarket");
const scopedEnv    = require("../src/utils/scopedEnv");
const { getCharges } = require("../src/utils/charges");
const { renderBacktestResults } = require("../src/utils/backtestUI");
const settings     = require("../src/routes/settings");
const nav          = require("../src/utils/sharedNav");

let pass = 0, fail = 0;
const _queue = [];
function section(t) { _queue.push({ section: t }); }
function check(name, fn) { _queue.push({ name, fn }); }

// ── HTTP harness: the old pages + the new page on one throwaway server ──────
const app = express();
const OLD = ["emaRsiStV2", "orb", "emaRsiSt", "bbRsi", "ema9vwap", "trendPb", "haScalp", "pa", "trendDayScalp", "rsiPivotSt"];
for (const id of OLD) {
  const s = registry.byId(id);
  app.use(s.backtest.path, require(registry.srcPath(s.backtest.module)));
}
app.use("/backtest", require("../src/routes/backtest"));
let BASE = "";
function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(BASE + urlPath, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function jobIdOf(html) {
  const m = html.match(/const JOB_ID = "([0-9a-f]+)"/);
  assert.ok(m, `no progress page in the response: ${html.slice(0, 300)}`);
  return m[1];
}
async function waitJob(id, viaPage) {
  for (let i = 0; i < 1200; i++) {
    const st = viaPage ? page.status(id).status : (backtestJobs.getJob(id) || {}).status;
    if (st && st !== "running") return st;
    await sleep(25);
  }
  throw new Error(`job ${id} did not finish`);
}
async function runOld(id, qs) {
  const s = registry.byId(id);
  const r = await get(`${s.backtest.path}?${qs}`);
  const job = jobIdOf(r.body);
  const st = await waitJob(job, false);
  const j = backtestJobs.getJob(job);
  assert.strictEqual(st, "done", `old ${id} page job ended ${st}: ${j && j.error}`);
  return j.result;
}
async function runNew(query) {
  const q = new URLSearchParams(query).toString();
  const r = await get(`/backtest/run?${q}`);
  assert.strictEqual(r.status, 200, `/backtest/run answered ${r.status}: ${r.body.slice(0, 300)}`);
  const job = jobIdOf(r.body);
  const st = await waitJob(job, true);
  const j = backtestJobs.getJob(job);
  assert.strictEqual(st, "done", `/backtest job ended ${st}: ${(j && j.error) || page.status(job).error}`);
  return { id: job, result: j.result, record: resultStore.loadRun(job) };
}

const FROM = "2026-08-17", TO = "2026-10-16";

// ─────────────────────────────────────────────────────────────────────────────
section("1. Form options per strategy");

check("every strategy with a backtest is on the page, in sidebar order, and each is runnable", () => {
  const want = registry.strategies().filter((s) => s.backtest).sort((a, b) => a.nav.order - b.nav.order).map((s) => s.id);
  const got = page.strategies();
  assert.deepStrictEqual(got.map((s) => s.id), want);
  for (const s of got) assert.ok(s.ready, `${s.id} has no backtestPage hook`);
  assert.ok(!got.some((s) => !registry.byId(s.id).backtest), "a strategy without a backtest is listed");
});

check("every hook has the contract: markets ⊆ offered, run/view functions, resolution null or options+default", () => {
  for (const s of page.strategies()) {
    const h = page.hookOf(s.id);
    assert.strictEqual(typeof h.run, "function"); assert.strictEqual(typeof h.view, "function");
    assert.ok(Array.isArray(h.markets) && h.markets.length, `${s.id}: no markets`);
    for (const mk of h.markets) assert.ok(pairs.isOffered(s.id, mk), `${s.id}: hook runs ${mk}, which pairs.js does not offer`);
    if (h.resolution) {
      const ro = page.resolutionOptions(s.id);
      assert.ok(ro.options.length && ro.options.includes(ro.default), `${s.id}: default candle ${ro.default} not in ${ro.options}`);
    }
  }
});

check("candle size: pickable where the old page took ?resolution=, fixed elsewhere", () => {
  for (const id of ["emaRsiSt", "bbRsi", "pa", "ema9vwap"]) {
    const ro = page.resolutionOptions(id);
    assert.ok(ro, `${id} should offer a candle choice`);
    assert.deepStrictEqual(ro.options, ["3", "5", "15"]);
  }
  assert.strictEqual(page.resolutionOptions("emaRsiSt").default, "5");
  for (const id of ["emaRsiStV2", "orb", "trendPb", "simple930", "earlyBird"]) assert.strictEqual(page.resolutionOptions(id), null, id);
});

check("the custom-settings list is GENERATED from the Settings schema (pairFieldsFor), minus paper/live switches", () => {
  for (const s of page.strategies()) {
    const mk = pairs.homeMarket(s.id);
    const pair = pairs.get(s.id, mk);
    const schemaKeys = settings.pairSettings.pairFieldsFor(pair).fields.map((f) => f.key);
    const fields = page.settingsFields(s.id, mk);
    for (const f of fields) {
      assert.ok(schemaKeys.includes(f.key), `${s.id}: ${f.key} is not in the Settings schema`);
      assert.ok(!page.NOT_BACKTEST.test(f.homeKey), `${s.id}: ${f.key} is a paper/live switch`);
      assert.strictEqual(f.key, f.homeKey, `${s.id}: home-market field ${f.key} maps to ${f.homeKey}`);
    }
    const dropped = schemaKeys.filter((k) => !fields.some((f) => f.key === k));
    for (const k of dropped) assert.ok(page.NOT_BACKTEST.test(k), `${s.id}: ${k} was dropped but is not a paper/live switch`);
  }
  const v2 = page.settingsFields("emaRsiStV2", "NIFTY").map((f) => f.key);
  assert.ok(v2.includes("EMA_RSI_ST_V2_ENTRY_START") && v2.includes("EMA_RSI_ST_V2_RSI_CE_MIN"), "V2 lost its entry settings");
  assert.ok(!v2.includes("EMA_RSI_ST_V2_PAPER_ENABLED") && !v2.includes("EMA_RSI_ST_V2_MODE_ENABLED"));
});

check("another market's list is that pair's keys, each mapped to the home key the engine reads", () => {
  const f = page.settingsFields("emaRsiStV2", "SENSEX");
  assert.ok(f.length > 5);
  for (const x of f) {
    assert.ok(x.key.startsWith("SENSEX_EMA_RSI_ST_V2_"), x.key);
    assert.strictEqual(x.homeKey, x.key.replace(/^SENSEX_/, ""));
  }
  process.env.EMA_RSI_ST_V2_RSI_CE_MIN = "55";
  try {
    const row = page.settingsFields("emaRsiStV2", "SENSEX").find((x) => x.key === "SENSEX_EMA_RSI_ST_V2_RSI_CE_MIN");
    assert.strictEqual(row.value, "55"); assert.strictEqual(row.source, "inherited");
  } finally { delete process.env.EMA_RSI_ST_V2_RSI_CE_MIN; }
});

check("the form renders every strategy, with a viewport meta and an inline script that compiles", () => {
  const html = require("../src/routes/backtest")._renderForm({}, null);
  assert.ok(/<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"\/>/.test(html));
  for (const s of page.strategies()) assert.ok(html.includes(`<option value="${s.id}"`), `form has no ${s.id}`);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const sc of scripts) new Function(sc);   // throws on a syntax error
  const cat = JSON.parse(html.match(/<script type="application\/json" id="bt-catalog">([\s\S]*?)<\/script>/)[1]);
  assert.ok(cat.emaRsiStV2.markets.some((m) => m.key === "SENSEX" && m.enabled));
});

// ─────────────────────────────────────────────────────────────────────────────
section("2. Offered-market filtering");

check("only pairs.js-offered markets are listed (no MCX for a strategy that needs the 09:15 index open)", () => {
  for (const s of page.strategies()) {
    const keys = page.marketOptions(s.id).map((m) => m.key);
    const offered = markets.list().map((M) => M.key).filter((k) => pairs.isOffered(s.id, k));
    assert.deepStrictEqual(keys, offered, s.id);
  }
  const orb = page.marketOptions("orb").map((m) => m.key);
  assert.ok(!orb.includes("CRUDE") && !orb.includes("GOLD"), "ORB needs the index open — no MCX");
  assert.ok(page.marketOptions("emaRsiStV2").some((m) => m.key === "CRUDE"), "V2 is offered on MCX (not runnable yet)");
});

check("enabled = the engine runs there; everything else is 'coming soon'", () => {
  const v2 = page.marketOptions("emaRsiStV2");
  const on = v2.filter((m) => m.enabled).map((m) => m.key);
  assert.deepStrictEqual(on.sort(), ["BANKNIFTY", "NIFTY", "NIFTY_FUT", "SENSEX"]);
  for (const m of v2) if (!m.enabled) assert.strictEqual(m.note, "coming soon");
  const v1 = page.marketOptions("emaRsiSt").filter((m) => m.enabled).map((m) => m.key);
  assert.deepStrictEqual(v1.sort(), ["BANKNIFTY", "NIFTY", "NIFTY_FUT", "SENSEX"], "EMA_RSI_ST backtests the index + futures pairs");
  for (const m of page.marketOptions("emaRsiSt")) if (!m.enabled) assert.strictEqual(m.note, "coming soon", `EMA_RSI_ST ${m.key}`);
  const bb = page.marketOptions("bbRsi");
  assert.deepStrictEqual(bb.filter((m) => m.enabled).map((m) => m.key).sort(), ["BANKNIFTY", "NIFTY", "NIFTY_FUT", "SENSEX"]);
  for (const m of bb) if (!m.enabled) assert.strictEqual(m.note, "coming soon", `bbRsi ${m.key}`);
  assert.ok(bb.some((m) => m.key === "CRUDE" && !m.enabled) && bb.some((m) => m.key === "SAIL" && !m.enabled), "BB_RSI MCX / stock backtests are coming soon");
  // Price Action runs the same four; MCX and the stock stay "coming soon".
  const pa = page.marketOptions("pa");
  assert.deepStrictEqual(pa.filter((m) => m.enabled).map((m) => m.key).sort(), ["BANKNIFTY", "NIFTY", "NIFTY_FUT", "SENSEX"]);
  for (const m of pa) if (!m.enabled) assert.strictEqual(m.note, "coming soon");
  const e9 = page.marketOptions("ema9vwap");
  assert.deepStrictEqual(e9.filter((m) => m.enabled).map((m) => m.key).sort(), ["BANKNIFTY", "NIFTY", "NIFTY_FUT", "SENSEX"]);
  for (const m of e9) if (!m.enabled) assert.strictEqual(m.note, "coming soon", `ema9vwap ${m.key}`);
  assert.ok(e9.some((m) => m.key === "CRUDE" && !m.enabled) && e9.some((m) => m.key === "SAIL" && !m.enabled), "EMA9+VWAP MCX / stock backtests are coming soon");
  const tpb = page.marketOptions("trendPb");
  assert.deepStrictEqual(tpb.filter((m) => m.enabled).map((m) => m.key).sort(), ["BANKNIFTY", "NIFTY", "NIFTY_FUT", "SENSEX"]);
  for (const m of tpb) if (!m.enabled) assert.strictEqual(m.note, "coming soon", `trendPb ${m.key}: MCX / stocks stay coming soon`);
  const tds = page.marketOptions("trendDayScalp");
  assert.deepStrictEqual(tds.filter((m) => m.enabled).map((m) => m.key).sort(), ["BANKNIFTY", "NIFTY", "NIFTY_FUT", "SENSEX"]);
  for (const m of tds) if (!m.enabled) assert.strictEqual(m.note, "coming soon", `trendDayScalp ${m.key}`);
  assert.ok(page.marketOptions("trendDayScalp").some((m) => m.key === "CRUDE" && !m.enabled), "TDS on MCX is offered, coming soon");
  const has = page.marketOptions("haScalp");
  assert.deepStrictEqual(has.filter((m) => m.enabled).map((m) => m.key).sort(), ["BANKNIFTY", "NIFTY", "NIFTY_FUT", "SENSEX"]);
  for (const m of has) if (!m.enabled) assert.strictEqual(m.note, "coming soon", `haScalp ${m.key}`);
  assert.ok(has.some((m) => m.key === "CRUDE" && !m.enabled), "HA SCALP on MCX is offered, coming soon");
  const rps = page.marketOptions("rsiPivotSt");
  assert.deepStrictEqual(rps.filter((m) => m.enabled).map((m) => m.key).sort(), ["BANKNIFTY", "NIFTY", "NIFTY_FUT", "SENSEX"]);
  for (const m of rps) if (!m.enabled) assert.strictEqual(m.note, "coming soon", `rsiPivotSt ${m.key}`);
  const MARKET_AWARE = new Set(["emaRsiStV2", "emaRsiSt", "bbRsi", "pa", "orb", "ema9vwap", "trendPb", "trendDayScalp", "haScalp", "rsiPivotSt"]);
  const orb = page.marketOptions("orb");
  assert.deepStrictEqual(orb.filter((m) => m.enabled).map((m) => m.key).sort(), ["BANKNIFTY", "NIFTY", "NIFTY_FUT", "SENSEX"]);
  for (const m of orb) if (!m.enabled) assert.strictEqual(m.note, "coming soon", `orb ${m.key}: stocks stay coming soon`);
  for (const s of page.strategies()) {
    if (MARKET_AWARE.has(s.id)) continue;
    const on2 = page.marketOptions(s.id).filter((m) => m.enabled).map((m) => m.key);
    assert.deepStrictEqual(on2, [pairs.homeMarket(s.id)], `${s.id} runs only on its home market today`);
  }
});

check("a run on a non-offered / coming-soon market or a bad request is refused before any job starts", () => {
  const base = { strategy: "orb", from: FROM, to: TO, resolution: null, settingsSource: "current", custom: {} };
  assert.ok(/not offered/.test(page.start({ ...base, market: "CRUDE" }).error));
  assert.ok(/coming soon/.test(page.start({ ...base, strategy: "rsiPivotSt", market: "CRUDE" }).error));
  assert.ok(/Unknown strategy/.test(page.start({ ...base, strategy: "nope", market: "NIFTY" }).error));
  assert.ok(/on or before/.test(page.start({ ...base, market: "NIFTY", from: TO, to: FROM }).error));
  assert.ok(/candle size/i.test(page.start({ ...base, strategy: "emaRsiSt", market: "NIFTY", resolution: "7" }).error));
  assert.ok(backtestJobs.isIdle(), "a refused request took the job slot");
});

// ─────────────────────────────────────────────────────────────────────────────
section("3. NIFTY parity — /backtest vs each strategy's old page");

const PARITY = [
  { id: "emaRsiStV2", qs: `from=${FROM}&to=${TO}` },
  { id: "orb",        qs: `from=${FROM}&to=${TO}` },
  { id: "emaRsiSt",   qs: `from=${FROM}&to=${TO}&resolution=5` },
  { id: "bbRsi",      qs: `from=${FROM}&to=${TO}&resolution=5` },
  { id: "ema9vwap",   qs: `from=${FROM}&to=${TO}&resolution=5` },
  { id: "trendPb",    qs: `from=${FROM}&to=${TO}` },
  { id: "haScalp",    qs: `from=${FROM}&to=${TO}` },
  { id: "pa",         qs: `from=${FROM}&to=${TO}&resolution=5` },
  { id: "trendDayScalp", qs: `from=${FROM}&to=${TO}` },
  { id: "rsiPivotSt", qs: `from=${FROM}&to=${TO}` },
];
const parityNotes = [];
for (const P of PARITY) {
  check(`${P.id}: byte-identical trades and stats through both paths`, async () => {
    const before = legacySaves.length;
    const oldRes = await runOld(P.id, P.qs);
    const q = Object.fromEntries(new URLSearchParams(P.qs));
    const neu = await runNew({ strategy: P.id, market: "NIFTY", settings: "current", ...q });
    assert.strictEqual(JSON.stringify(neu.result.trades), JSON.stringify(oldRes.trades), "trades differ");
    const strip = (r) => { const o = { ...r }; delete o.trades; return JSON.stringify(o); };
    assert.strictEqual(strip(neu.result), strip(oldRes), "stats / meta differ");
    assert.strictEqual(legacySaves.length, before + 2, "both runs should update the legacy last-run slot");
    assert.deepStrictEqual(neu.record.overriddenKeys, [], "current NIFTY settings must override nothing");
    parityNotes.push(`${P.id}: ${(oldRes.trades || []).length} trade(s)`);
  });
}
check("emaRsiSt NIFTY parity with trades (VIX gate off — the stub's VIX is not a VIX series)", async () => {
  const had = process.env.VIX_FILTER_ENABLED;
  process.env.VIX_FILTER_ENABLED = "false";
  try {
    const oldRes = await runOld("emaRsiSt", `from=${FROM}&to=${TO}&resolution=5`);
    const neu = await runNew({ strategy: "emaRsiSt", market: "NIFTY", settings: "current", from: FROM, to: TO, resolution: "5" });
    assert.ok(oldRes.trades.length > 0, "no trade — this parity proves nothing");
    assert.strictEqual(JSON.stringify(neu.result.trades), JSON.stringify(oldRes.trades), "trades differ");
    const strip = (r) => { const o = { ...r }; delete o.trades; return JSON.stringify(o); };
    assert.strictEqual(strip(neu.result), strip(oldRes), "stats / meta differ");
    assert.strictEqual(neu.result.market, undefined, "a NIFTY result must not grow a market field");
  } finally { if (had === undefined) delete process.env.VIX_FILTER_ENABLED; else process.env.VIX_FILTER_ENABLED = had; }
});
check("the parity set actually traded (a 0-trade parity proves nothing)", () => {
  const traded = parityNotes.filter((n) => !/: 0 trade/.test(n));
  say(`       ${parityNotes.join(" · ")}`);
  assert.ok(traded.length >= 3, `only ${traded.length} of ${parityNotes.length} parity strategies traded`);
});

// ─────────────────────────────────────────────────────────────────────────────
section("4. EMA_RSI_ST_V2 is market-aware");

check("market contexts: spot symbol, lot, exchange, futures flag", () => {
  const S = bm.context("SENSEX"), B = bm.context("BANKNIFTY"), F = bm.context("NIFTY_FUT"), N = bm.context("NIFTY");
  assert.deepStrictEqual([S.spotSymbol, S.exchange, S.lotQty, S.isFutures], ["BSE:SENSEX-INDEX", "BSE", 20, false]);
  assert.deepStrictEqual([B.spotSymbol, B.exchange, B.lotQty, B.isFutures], ["NSE:NIFTYBANK-INDEX", "NSE", 30, false]);
  assert.deepStrictEqual([F.spotSymbol, F.exchange, F.isFutures], ["NSE:NIFTY50-INDEX", "NSE", true]);
  assert.strictEqual(F.lotQty, require("../src/config/instrument").getLotQty("NIFTY", "NIFTY_FUTURES"));
  assert.strictEqual(N.lotQty, require("../src/config/instrument").getLotQty());
});

check("contracts: each market's own option stem, strike grid and rule expiry (no live override applied to history)", () => {
  process.env.OPTION_EXPIRY_OVERRIDE = "2030-01-01";
  try {
    const t = Math.floor(Date.parse("2026-09-17T10:35:00+05:30") / 1000);   // Thu 17-Sep-2026
    const n = bm.contractAt(bm.context("NIFTY"), 24567, "CE", t);
    assert.deepStrictEqual(n, { symbol: "NSE:NIFTY2692224550CE", expiry: "2026-09-22" });
    const s = bm.contractAt(bm.context("SENSEX"), 81234, "PE", t);
    assert.ok(/^BSE:SENSEX26\w+81200PE$/.test(s.symbol), s.symbol);
    const b = bm.contractAt(bm.context("BANKNIFTY"), 52345, "CE", t);
    assert.deepStrictEqual(b, { symbol: "NSE:BANKNIFTY26SEP52300CE", expiry: "2026-09-29" });
    const f = bm.contractAt(bm.context("NIFTY_FUT"), 24567, "CE", t);
    assert.strictEqual(f.symbol, "NSE:NIFTY26SEPFUT");
  } finally { delete process.env.OPTION_EXPIRY_OVERRIDE; }
});

check("BSE charges differ from NSE on options; NSE stays exactly as before", () => {
  const o = { isFutures: false, entryPremium: 150, exitPremium: 170, qty: 20 };
  const nse = getCharges({ ...o, broker: "zerodha" });
  assert.strictEqual(getCharges({ ...o, broker: "zerodha", exchange: "NSE" }), nse);
  assert.notStrictEqual(getCharges({ ...o, broker: "zerodha", exchange: "BSE" }), nse);
});

const MKT_RUNS = {};
for (const mk of ["SENSEX", "BANKNIFTY", "NIFTY_FUT"]) {
  check(`${mk}: fetches its own candles, prices with its lot + exchange charges, records the market`, async () => {
    const mark = fetchLog.length;
    const neu = await runNew({ strategy: "emaRsiStV2", market: mk, settings: "current", from: FROM, to: TO });
    MKT_RUNS[mk] = neu;
    const ctx = bm.context(mk);
    const asked = fetchLog.slice(mark).map((f) => f.symbol);
    assert.ok(asked.length && asked.every((s) => s === ctx.spotSymbol), `fetched ${asked.join(",")} for ${mk}`);
    assert.strictEqual(neu.result.meta.market, mk);
    assert.strictEqual(neu.record.market, mk);
    const trades = neu.result.trades;
    assert.ok(trades.length > 0, `${mk}: the synthetic market produced no trade`);
    for (const t of trades) {
      const charges = getCharges({ broker: "zerodha", isFutures: ctx.isFutures, exchange: ctx.exchange, entryPremium: t.eOpt, exitPremium: t.xOpt, qty: ctx.lotQty });
      const want = (t.xOpt - t.eOpt) * ctx.lotQty - charges;
      // xOpt is stored rounded to the paisa; the P&L was booked on the unrounded
      // premium — so allow half a paisa per unit of the lot.
      assert.ok(Math.abs(t.pnl - want) <= ctx.lotQty * 0.005 + 0.02,
        `${mk} trade ${t.entry}: pnl ${t.pnl} ≠ (${t.xOpt}−${t.eOpt})×${ctx.lotQty}−${charges}`);
      const wrongLot = (t.xOpt - t.eOpt) * 65 - charges;
      if (ctx.lotQty !== 65 && Math.abs(t.xOpt - t.eOpt) > 1) assert.ok(Math.abs(t.pnl - wrongLot) > 1, `${mk}: priced with NIFTY's lot`);
      if (ctx.isFutures) {
        // Futures: the "premium" IS the index level (+ slippage) — no δ/θ seed.
        assert.ok(Math.abs(t.eOpt - t.ePrice) < 50, `${mk}: futures entry ${t.eOpt} is not the index level ${t.ePrice}`);
      }
    }
    assert.strictEqual(!!neu.result.stats.isFutures, ctx.isFutures);
    assert.strictEqual(neu.result.stats.optionSim, !ctx.isFutures);
    assert.ok(!legacySaves.slice(-1).includes("EMA_RSI_ST_V2_BACKTEST") || mk === "NIFTY", "a non-NIFTY run overwrote NIFTY's legacy slot");
    const rows = neu.record.view.trades;
    assert.strictEqual(rows.length, trades.length);
    assert.ok(/MARKET: /.test(neu.record.view.notes), "the results notes do not name the market");
  });
}

check("NIFTY_FUT and SENSEX P&L differ from NIFTY options on the same signal path (the market really changed pricing)", () => {
  const S = MKT_RUNS.SENSEX, F = MKT_RUNS.NIFTY_FUT;
  assert.ok(S && F, "market runs missing");
  const eo = F.result.trades.map((t) => t.eOpt);
  assert.ok(eo.every((x) => x > 1000), "futures entries should be index levels, not option premiums");
  assert.ok(S.result.trades.every((t) => t.ePrice > 50000), "SENSEX trades should be on the SENSEX (scaled) series");
});

check("pair settings: a SENSEX-own key reaches the engine (as its home key) for that run only", async () => {
  process.env.SENSEX_EMA_RSI_ST_V2_ENTRY_END = "11:00";
  try {
    const { overrides, settings: used } = page.buildOverrides("emaRsiStV2", "SENSEX", null);
    assert.strictEqual(overrides.EMA_RSI_ST_V2_ENTRY_END, "11:00");
    assert.strictEqual(used.find((s) => s.key === "SENSEX_EMA_RSI_ST_V2_ENTRY_END").source, "own");
    const neu = await runNew({ strategy: "emaRsiStV2", market: "SENSEX", settings: "current", from: FROM, to: TO });
    assert.ok(neu.record.overriddenKeys.includes("EMA_RSI_ST_V2_ENTRY_END"));
    for (const t of neu.result.trades) {
      const hhmm = t.entry.split(", ")[1].slice(0, 5);
      assert.ok(hhmm < "11:00", `SENSEX trade entered at ${hhmm}, after its own 11:00 entry end`);
    }
    assert.strictEqual(process.env.EMA_RSI_ST_V2_ENTRY_END, undefined, "the pair value leaked into the real env");
  } finally { delete process.env.SENSEX_EMA_RSI_ST_V2_ENTRY_END; }
});

check("the old V2 page is untouched by markets: NIFTY run reads NIFTY's candles and lot", async () => {
  const mark = fetchLog.length;
  const oldRes = await runOld("emaRsiStV2", `from=${FROM}&to=${TO}`);
  assert.ok(fetchLog.slice(mark).every((f) => f.symbol === "NSE:NIFTY50-INDEX"));
  assert.strictEqual(oldRes.meta.market, undefined, "a NIFTY result must not grow a market field");
});

// ─────────────────────────────────────────────────────────────────────────────
section("4b. EMA_RSI_ST is market-aware");

// The engine's option-sim P&L (services/backtestEngine): net premium pts × lot −
// charges on a ₹200 seed premium; futures = index pts × lot − futures charges.
// pnlMode spells the δ-move and θ it used on a non-EOD exit.
// The stub answers the India VIX symbol with the NIFTY-scaled series, so the
// EMA_RSI_ST VIX gate (on by default) would block every entry: these runs turn
// the shared VIX_FILTER_ENABLED off (and back) so the market path really trades.
const V1_RUNS = {};
async function withVixOff(fn) {
  const had = process.env.VIX_FILTER_ENABLED;
  process.env.VIX_FILTER_ENABLED = "false";
  try { return await fn(); }
  finally { if (had === undefined) delete process.env.VIX_FILTER_ENABLED; else process.env.VIX_FILTER_ENABLED = had; }
}
for (const mk of ["SENSEX", "BANKNIFTY", "NIFTY_FUT"]) {
  check(`EMA_RSI_ST ${mk}: its own candles, its lot + exchange charges, the market on the result`, async () => {
    const mark = fetchLog.length;
    const saves = legacySaves.length;
    const neu = await withVixOff(() => runNew({ strategy: "emaRsiSt", market: mk, settings: "current", from: FROM, to: TO, resolution: "5" }));
    V1_RUNS[mk] = neu;
    const ctx = bm.context(mk);
    const asked = fetchLog.slice(mark).map((f) => f.symbol).filter((s) => s !== "NSE:INDIAVIX-INDEX");
    assert.ok(asked.length && asked.every((s) => s === ctx.spotSymbol), `fetched ${asked.join(",")} for ${mk}`);
    assert.strictEqual(neu.result.market, mk);
    assert.strictEqual(neu.record.market, mk);
    assert.strictEqual(neu.result.summary.lotSize, ctx.lotQty, `${mk}: lot`);
    assert.strictEqual(legacySaves.length, saves, "a non-NIFTY run overwrote NIFTY's legacy last-run slot");
    const trades = neu.result.trades;
    assert.ok(trades.length > 0, `${mk}: the synthetic market produced no trade`);
    let exact = 0;
    for (const t of trades) {
      if (ctx.isFutures) {
        assert.ok(/^futures/.test(t.pnlMode), `${mk}: ${t.pnlMode}`);
        if (t.pnlMode === "futures") continue;   // EOD row: charged on the last close
        const chg = getCharges({ isFutures: true, exitPremium: t.exitPrice, entryPremium: t.entryPrice, qty: ctx.lotQty, exchange: ctx.exchange });
        assert.ok(Math.abs(t.pnl - (t.spotPnlPts * ctx.lotQty - chg)) <= 0.02, `${mk} ${t.entryTime}: ${t.pnl}`);
        exact++;
      } else {
        const m = /^opt_sim \(spot=.*− θ(-?[\d.]+)pt\) × (\d+)lots/.exec(t.pnlMode);
        if (!m) { assert.strictEqual(t.pnlMode, "opt_sim", t.pnlMode); continue; }
        assert.strictEqual(Number(m[2]), ctx.lotQty, `${mk}: priced with lot ${m[2]}`);
        const net = t.spotPnlPts * 0.55 - Number(m[1]);
        const chg = getCharges({ isFutures: false, exitPremium: Math.max(1, 200 + net), entryPremium: 200, qty: ctx.lotQty, exchange: ctx.exchange });
        assert.ok(Math.abs(t.pnl - (net * ctx.lotQty - chg)) <= 0.02, `${mk} ${t.entryTime}: pnl ${t.pnl} ≠ ${net}×${ctx.lotQty}−${chg}`);
        exact++;
      }
    }
    assert.ok(exact > 0, `${mk}: no trade could be re-priced`);
    assert.strictEqual(!!neu.result.summary.optionSim, !ctx.isFutures);
    assert.ok(new RegExp(`MARKET: ${ctx.label}`).test(neu.record.view.notes), "the results notes do not name the market");
    assert.strictEqual(neu.record.view.trades.length, trades.length);
  });
}

check("EMA_RSI_ST SENSEX is charged at BSE rates (≠ the NSE charge on the same trade)", () => {
  const t = V1_RUNS.SENSEX.result.trades.find((x) => /lots/.test(x.pnlMode));
  assert.ok(t, "no non-EOD SENSEX trade");
  const o = { isFutures: false, entryPremium: 200, exitPremium: 220, qty: 20 };
  assert.notStrictEqual(getCharges({ ...o, exchange: "BSE" }), getCharges(o));
});

check("EMA_RSI_ST pair settings: a BANKNIFTY-own key reaches the engine as its home key, for that run only", async () => {
  process.env.BN_EMA_RSI_ST_ENTRY_END = "11:00";
  try {
    const { overrides } = page.buildOverrides("emaRsiSt", "BANKNIFTY", null);
    assert.strictEqual(overrides.TRADE_ENTRY_END, "11:00");
    const neu = await withVixOff(() => runNew({ strategy: "emaRsiSt", market: "BANKNIFTY", settings: "current", from: FROM, to: TO, resolution: "5" }));
    assert.ok(neu.record.overriddenKeys.includes("TRADE_ENTRY_END"));
    for (const t of neu.result.trades) {
      const hhmm = t.entryTime.split(", ")[1].slice(0, 5);
      assert.ok(hhmm < "11:00", `BANKNIFTY trade entered at ${hhmm}, after its own 11:00 entry end`);
    }
    assert.ok(neu.result.trades.length < V1_RUNS.BANKNIFTY.result.trades.length, "an 11:00 entry end should drop later entries");
    assert.strictEqual(process.env.TRADE_ENTRY_END, undefined, "the pair value leaked into the real env");
  } finally { delete process.env.BN_EMA_RSI_ST_ENTRY_END; }
});

check("EMA_RSI_ST BANKNIFTY expiry-day-only trades only on BANKNIFTY's own (monthly) expiry days", async () => {
  process.env.BN_EMA_RSI_ST_EXPIRY_DAY_ONLY = "true";
  try {
    const neu = await withVixOff(() => runNew({ strategy: "emaRsiSt", market: "BANKNIFTY", settings: "current", from: FROM, to: TO, resolution: "5" }));
    const ctx = bm.context("BANKNIFTY");
    const days = new Set(neu.result.trades.map((t) => new Date((t.entryTs + 19800) * 1000).toISOString().slice(0, 10)));
    assert.ok(neu.result.trades.length > 0, "no trade on an expiry day — this check proves nothing");
    assert.ok(neu.result.trades.length < V1_RUNS.BANKNIFTY.result.trades.length, "expiry-only should drop non-expiry days");
    for (const d of days) {
      const t = neu.result.trades.find((x) => new Date((x.entryTs + 19800) * 1000).toISOString().slice(0, 10) === d);
      assert.strictEqual(bm.contractAt(ctx, t.entryPrice, "CE", t.entryTs).expiry, d, `BANKNIFTY traded on ${d}, not its expiry`);
    }
    assert.strictEqual(process.env.EMA_RSI_ST_EXPIRY_DAY_ONLY, undefined, "the pair value leaked into the real env");
  } finally { delete process.env.BN_EMA_RSI_ST_EXPIRY_DAY_ONLY; }
  // Paper's pair reads <PAIR>_EXPIRY_DAY_ONLY → EMA_RSI_ST_EXPIRY_DAY_ONLY, never
  // NIFTY's shared TRADE_EXPIRY_DAY_ONLY — and neither does the backtest.
  const hadT = process.env.TRADE_EXPIRY_DAY_ONLY;
  process.env.TRADE_EXPIRY_DAY_ONLY = "true";
  try {
    const neu = await withVixOff(() => runNew({ strategy: "emaRsiSt", market: "BANKNIFTY", settings: "current", from: FROM, to: TO, resolution: "5" }));
    assert.strictEqual(neu.result.trades.length, V1_RUNS.BANKNIFTY.result.trades.length, "TRADE_EXPIRY_DAY_ONLY reached a BANKNIFTY run");
  } finally { if (hadT === undefined) delete process.env.TRADE_EXPIRY_DAY_ONLY; else process.env.TRADE_EXPIRY_DAY_ONLY = hadT; }
});

check("EMA_RSI_ST NIFTY_FUT expiry-day-only trades on the month's expiry days paper trades on", async () => {
  process.env.FUT_EMA_RSI_ST_EXPIRY_DAY_ONLY = "true";
  try {
    const neu = await withVixOff(() => runNew({ strategy: "emaRsiSt", market: "NIFTY_FUT", settings: "current", from: FROM, to: TO, resolution: "5" }));
    const rt = require("../src/utils/pairRuntime").forStrategy("emaRsiSt", "NIFTY_FUT");
    assert.ok(neu.result.trades.length > 0, "no futures trade on a monthly expiry day — the futures roll hid every expiry");
    assert.ok(neu.result.trades.length < V1_RUNS.NIFTY_FUT.result.trades.length, "expiry-only should drop non-expiry days");
    for (const t of neu.result.trades) {
      const d = new Date((t.entryTs + 19800) * 1000).toISOString().slice(0, 10);
      assert.ok(rt.isExpiryDay(t.entryTs * 1000), `NIFTY_FUT traded on ${d}, not a day paper calls expiry`);
    }
  } finally { delete process.env.FUT_EMA_RSI_ST_EXPIRY_DAY_ONLY; }
});

check("the old EMA_RSI_ST page stays NIFTY: NIFTY candles, NIFTY lot, no market field", async () => {
  const mark = fetchLog.length;
  const oldRes = await withVixOff(() => runOld("emaRsiSt", `from=${FROM}&to=${TO}&resolution=5`));
  assert.ok(fetchLog.slice(mark).every((f) => f.symbol === "NSE:NIFTY50-INDEX" || f.symbol === "NSE:INDIAVIX-INDEX"));
  assert.ok(oldRes.trades.length > 0, "the NIFTY run produced no trade");
  // Same signal path on every market (the stub scales one series), different pricing.
  assert.strictEqual(oldRes.trades.length, V1_RUNS.SENSEX.result.trades.length);
  assert.notStrictEqual(JSON.stringify(oldRes.trades.map((t) => t.pnl)), JSON.stringify(V1_RUNS.SENSEX.result.trades.map((t) => t.pnl)), "SENSEX priced like NIFTY");
  assert.strictEqual(oldRes.market, undefined, "a NIFTY result must not grow a market field");
  assert.strictEqual(oldRes.summary.lotSize, require("../src/config/instrument").getLotQty());
});

// ─────────────────────────────────────────────────────────────────────────────
section("4c. BB_RSI is market-aware");

const BB_RUNS = {};
for (const mk of ["SENSEX", "BANKNIFTY", "NIFTY_FUT"]) {
  check(`BB_RSI on ${mk}: its own candles, lot + exchange charges (futures: ₹ on the index), market recorded`, async () => {
    const mark = fetchLog.length, saves = legacySaves.length;
    const neu = await runNew({ strategy: "bbRsi", market: mk, settings: "current", from: FROM, to: TO, resolution: "5" });
    BB_RUNS[mk] = neu;
    const ctx = bm.context(mk);
    const asked = fetchLog.slice(mark).map((f) => f.symbol).filter((s) => !/VIX/.test(s));
    assert.ok(asked.length && asked.every((s) => s === ctx.spotSymbol), `fetched ${asked.join(",")} for ${mk}`);
    assert.strictEqual(neu.result.meta.market, mk);
    assert.strictEqual(neu.record.market, mk);
    assert.strictEqual(legacySaves.length, saves, `a ${mk} run overwrote NIFTY's legacy BB_RSI slot`);
    assert.ok(/MARKET: /.test(neu.record.view.notes), "the results notes do not name the market");
    const CPD = Math.max(1, Math.round(390 / 5)), DELTA = 0.55, THETA = 10;
    for (const t of neu.result.trades) {
      let want;
      if (ctx.isFutures) {
        assert.strictEqual(t.pnlMode, "futures");
        const chg = getCharges({ broker: "fyers", isFutures: true, exchange: ctx.exchange, exitPremium: t.exitPrice, entryPremium: t.entryPrice, qty: ctx.lotQty });
        want = t.spotPnlPts * ctx.lotQty - chg;
      } else {
        const theta = (THETA * t.candlesHeld) / CPD;
        const estExit = Math.max(1, 200 + t.spotPnlPts * DELTA - theta / ctx.lotQty);
        const chg = getCharges({ broker: "fyers", isFutures: false, exchange: ctx.exchange, exitPremium: estExit, entryPremium: 200, qty: ctx.lotQty });
        want = t.spotPnlPts * DELTA * ctx.lotQty - theta - chg;
      }
      // spotPnlPts is stored rounded to the paisa; allow half a paisa per unit of the lot.
      assert.ok(Math.abs(t.pnl - want) <= ctx.lotQty * 0.01 + 0.05, `${mk} trade ${t.entryTime}: pnl ${t.pnl} ≠ ${want.toFixed(2)}`);
    }
    assert.strictEqual(!!neu.result.summary.isFutures, ctx.isFutures);
  });
}

check("BB_RSI market runs traded on their own (scaled) series", () => {
  const n = Object.values(BB_RUNS).reduce((k, r) => k + r.result.trades.length, 0);
  assert.ok(n > 0, "no BB_RSI market run produced a trade — the market checks above proved nothing");
  assert.ok((BB_RUNS.SENSEX ? BB_RUNS.SENSEX.result.trades : []).every((t) => t.entryPrice > 50000), "SENSEX trades should be on the SENSEX (scaled) series");
});

for (const mk of ["SENSEX", "NIFTY_FUT"]) {
  check(`BB_RSI on ${mk} with <PAIR>_EXPIRY_DAY_ONLY trades only that market's expiry days (the paper /start rule)`, async () => {
    const rt = require("../src/utils/pairRuntime").forStrategy("bbRsi", mk);
    const key = `${rt.envPrefix}_EXPIRY_DAY_ONLY`;
    const neu = await runNew({ strategy: "bbRsi", market: mk, settings: "custom", from: FROM, to: TO, resolution: "5", [`s.${key}`]: "true" });
    assert.deepStrictEqual(neu.record.overriddenKeys, ["BB_RSI_EXPIRY_DAY_ONLY"]);
    assert.strictEqual(process.env.BB_RSI_EXPIRY_DAY_ONLY, undefined, "custom value leaked into process.env");
    const all = BB_RUNS[mk].result.trades;
    const exp = all.filter((t) => rt.isExpiryDay(t.entryTs * 1000));
    assert.ok(neu.result.trades.every((t) => rt.isExpiryDay(t.entryTs * 1000)), `${mk}: an expiry-only run entered off ${mk}'s expiry day`);
    assert.ok(neu.result.trades.length < all.length || all.length === exp.length, `${mk}: expiry-only dropped nothing`);
    assert.ok(exp.length === 0 || neu.result.trades.length > 0, `${mk}: expiry-only blocked every expiry day too`);
    if (mk === "SENSEX") assert.ok(exp.length > 0, "the SENSEX run must trade an expiry day, or this check proves nothing");
  });
}

check("the old BB_RSI page is untouched by markets: NIFTY run reads NIFTY's candles and saves its slot", async () => {
  const mark = fetchLog.length, saves = legacySaves.length;
  const oldRes = await runOld("bbRsi", `from=${FROM}&to=${TO}&resolution=5`);
  assert.ok(fetchLog.slice(mark).filter((f) => !/VIX/.test(f.symbol)).every((f) => f.symbol === "NSE:NIFTY50-INDEX"));
  assert.strictEqual(oldRes.meta, undefined, "a NIFTY result must not grow a market field");
  assert.ok(legacySaves.slice(saves).includes("BB_RSI_BACKTEST"));
});

// ─────────────────────────────────────────────────────────────────────────────
section("4d. PRICE ACTION is market-aware");

// PA's stop-width filter is in index points (8–25 on NIFTY): on SENSEX /
// BANKNIFTY the pair's OWN key widens it — which also proves a pair key reaches
// the engine as its PA_* home key for that run only.
const PA_OWN = { SENSEX: { SENSEX_PA_MIN_SL_PTS: "25", SENSEX_PA_MAX_SL_PTS: "80" }, BANKNIFTY: { BN_PA_MIN_SL_PTS: "18", BN_PA_MAX_SL_PTS: "60" }, NIFTY_FUT: {} };
const PA_RUNS = {};
for (const mk of ["SENSEX", "BANKNIFTY", "NIFTY_FUT"]) {
  check(`PA ${mk}: its own candles, lot and charges; NIFTY's last-run slot untouched; market recorded`, async () => {
    Object.assign(process.env, PA_OWN[mk]);
    try {
      const mark = fetchLog.length, saves = legacySaves.length;
      const neu = await runNew({ strategy: "pa", market: mk, settings: "current", from: FROM, to: TO, resolution: "5" });
      PA_RUNS[mk] = neu;
      const ctx = bm.context(mk);
      const asked = fetchLog.slice(mark).map((f) => f.symbol);
      assert.ok(asked.length && asked.every((sym) => sym === ctx.spotSymbol), `fetched ${asked.join(",")} for ${mk}`);
      assert.strictEqual(neu.result.meta.market, mk);
      assert.strictEqual(neu.record.market, mk);
      assert.ok(!legacySaves.slice(saves).includes("PA_BACKTEST"), "a non-NIFTY PA run overwrote NIFTY's legacy slot");
      for (const k of Object.keys(PA_OWN[mk])) {
        const home = k.replace(/^(SENSEX|BN)_/, "");
        assert.ok(neu.record.overriddenKeys.includes(home), `${k} did not reach the engine as ${home}`);
        assert.strictEqual(process.env[home], undefined, `${home} leaked into the real env`);
      }
      const trades = neu.result.trades;
      assert.ok(trades.length > 0, `${mk}: the synthetic market produced no PA trade`);
      for (const t of trades) {
        if (ctx.isFutures) {
          // Futures: rupees = index points × futures lot − futures charges.
          const chg = getCharges({ broker: "fyers", isFutures: true, exitPremium: t.exitPrice, entryPremium: t.entryPrice, qty: ctx.lotQty });
          assert.strictEqual(t.pnlMode, "futures");
          assert.ok(Math.abs(t.pnl - (t.spotPnlPts * ctx.lotQty - chg)) < 0.05, `${mk} pnl ${t.pnl} ≠ ${t.spotPnlPts}×${ctx.lotQty}−${chg}`);
        } else {
          assert.strictEqual(t.pnlMode, "option sim");
          assert.ok(t.entryPrice > 40000, `${mk} trade is not on the ${mk} series (${t.entryPrice})`);
        }
      }
      assert.strictEqual(!!neu.result.summary.isFutures, ctx.isFutures);
      assert.ok(/MARKET: /.test(neu.record.view.notes), "the results notes do not name the market");
    } finally { for (const k of Object.keys(PA_OWN[mk])) delete process.env[k]; }
  });
}

check("PA NIFTY_FUT expiry-day-only uses paper's expiry rule (the month contract's own expiry day)", async () => {
  // futuresContractAt has already rolled to next month's contract on expiry day,
  // so matching its expiry found no expiry day at all: the run never traded.
  const rt = require("../src/utils/pairRuntime").forStrategy("pa", "NIFTY_FUT");
  const ymd = (ms) => new Date(ms + 19800000).toISOString().slice(0, 10);
  assert.ok(rt.isExpiryDay(Date.parse("2026-09-29T09:15:00+05:30")), "paper: 29 Sep 2026 is the NIFTY futures expiry");
  // The synthetic market's PA trades fall on 30 Sep / 16 Oct: make 30 Sep paper's
  // expiry day, and the backtest must trade it and nothing else.
  const real = rt.isExpiryDay;
  rt.isExpiryDay = (ms) => ymd(ms) === "2026-09-30";
  process.env.FUT_PA_EXPIRY_DAY_ONLY = "true";
  try {
    const neu = await runNew({ strategy: "pa", market: "NIFTY_FUT", settings: "current", from: FROM, to: TO, resolution: "5" });
    const days = neu.result.trades.map((t) => ymd(t.entryTs * 1000));
    assert.ok(days.length > 0, "an expiry-day-only NIFTY_FUT run found no expiry day");
    assert.ok(days.every((d) => d === "2026-09-30"), `traded off paper's expiry day: ${days.join(",")}`);
  } finally { rt.isExpiryDay = real; delete process.env.FUT_PA_EXPIRY_DAY_ONLY; }
});

check("PA: a SENSEX run is priced with the SENSEX lot and BSE charges (not NIFTY's)", () => {
  const S = PA_RUNS.SENSEX;
  assert.ok(S, "SENSEX run missing");
  const ctx = bm.context("SENSEX");
  // Same option-sim formula the engine uses, with the market's lot and exchange.
  const DELTA = S.result.summary.delta, THETA = S.result.summary.thetaPerDay;
  for (const t of S.result.trades) {
    const theta = (THETA * t.candlesHeld) / Math.round(390 / 5);
    const estExit = Math.max(1, 200 + (t.spotPnlPts * DELTA - theta / ctx.lotQty));
    const chg = getCharges({ broker: "fyers", isFutures: false, exchange: "BSE", exitPremium: estExit, entryPremium: 200, qty: ctx.lotQty });
    assert.ok(Math.abs(t.pnl - (t.spotPnlPts * DELTA * ctx.lotQty - theta - chg)) < 0.05, `SENSEX pnl ${t.pnl} not priced on lot ${ctx.lotQty} + BSE`);
  }
});

check("the old PA page is untouched by markets: NIFTY run reads NIFTY's candles and saves its slot", async () => {
  const mark = fetchLog.length, saves = legacySaves.length;
  const oldRes = await runOld("pa", `from=${FROM}&to=${TO}&resolution=5`);
  assert.ok(fetchLog.slice(mark).every((f) => f.symbol === "NSE:NIFTY50-INDEX"));
  assert.strictEqual(oldRes.meta, undefined, "a NIFTY PA result must not grow a market field");
  assert.ok(legacySaves.slice(saves).includes("PA_BACKTEST"));
});

// ─────────────────────────────────────────────────────────────────────────────
section("4e. ORB is market-aware");

const ORB_RUNS = {};
const _ymd = (ms) => new Date(ms + 19800000).toISOString().slice(0, 10);
for (const mk of ["SENSEX", "BANKNIFTY", "NIFTY_FUT"]) {
  check(`ORB on ${mk}: its own candles, lot, exchange charges; NIFTY's legacy slot untouched`, async () => {
    const mark = fetchLog.length, saves = legacySaves.length;
    const neu = await runNew({ strategy: "orb", market: mk, settings: "current", from: FROM, to: TO });
    ORB_RUNS[mk] = neu;
    const ctx = bm.context(mk);
    const asked = fetchLog.slice(mark).filter((f) => String(f.resolution) !== "D").map((f) => f.symbol);
    assert.ok(asked.length && asked.every((s) => s === ctx.spotSymbol), `fetched ${asked.join(",")} for ${mk}`);
    assert.strictEqual(neu.result.market, mk);
    assert.strictEqual(neu.record.market, mk);
    assert.strictEqual(legacySaves.length, saves, "a non-NIFTY run overwrote NIFTY's legacy slot");
    const trades = neu.result.trades;
    assert.ok(trades.length > 0, `${mk}: the synthetic market produced no trade`);
    const slip = require("../src/config/backtestCosts").slippagePts();
    for (const t of trades) {
      let want;
      if (ctx.isFutures) {
        // Futures: index points × lot − futures charges, slippage in index points; no option leg.
        const charges = getCharges({ broker: "fyers", isFutures: true, exchange: ctx.exchange, entryPremium: t.ePrice, exitPremium: t.xPrice, qty: ctx.lotQty });
        want = ((t.xPrice - t.ePrice) * (t.side === "CE" ? 1 : -1) - 2 * slip) * ctx.lotQty - charges;
        assert.strictEqual(t.xOpt, null, `${mk}: a futures trade carries an option exit`);
      } else {
        const charges = getCharges({ broker: "fyers", isFutures: false, exchange: ctx.exchange, entryPremium: t.eOpt, exitPremium: t.xOpt, qty: ctx.lotQty });
        want = (t.xOpt - t.eOpt) * ctx.lotQty - charges;
      }
      assert.ok(Math.abs(t.pnl - want) <= ctx.lotQty * 0.005 + 0.02, `${mk} trade ${t.entry}: pnl ${t.pnl} ≠ ${want.toFixed(2)}`);
    }
    assert.strictEqual(!!neu.result.stats.isFutures, ctx.isFutures);
    assert.strictEqual(neu.result.stats.optionSim, !ctx.isFutures);
    assert.ok(/MARKET: /.test(neu.record.view.notes), "the results notes do not name the market");
    if (ctx.isFutures) assert.ok(/FUTURES MODE/.test(neu.record.view.notes), "a NIFTY_FUT run is not labelled futures");
  });
}
check("ORB: SENSEX trades sit on the SENSEX series; the old NIFTY page reads NIFTY only", async () => {
  assert.ok(ORB_RUNS.SENSEX && ORB_RUNS.SENSEX.result.trades.every((t) => t.ePrice > 50000));
  const mark = fetchLog.length;
  const oldRes = await runOld("orb", `from=${FROM}&to=${TO}`);
  assert.ok(fetchLog.slice(mark).filter((f) => String(f.resolution) !== "D").every((f) => f.symbol === "NSE:NIFTY50-INDEX"));
  assert.strictEqual(oldRes.market, undefined, "a NIFTY result must not grow a market field");
});
check("ORB pair settings: a BANKNIFTY-own key reaches the engine for that run only", async () => {
  process.env.BN_ORB_ENTRY_END = "09:50";
  try {
    const { overrides } = page.buildOverrides("orb", "BANKNIFTY", null);
    assert.strictEqual(overrides.ORB_ENTRY_END, "09:50");
    const neu = await runNew({ strategy: "orb", market: "BANKNIFTY", settings: "current", from: FROM, to: TO });
    assert.ok(neu.record.overriddenKeys.includes("ORB_ENTRY_END"));
    for (const t of neu.result.trades) assert.ok(t.entry.split(", ")[1].slice(0, 5) < "09:50", `BANKNIFTY trade entered at ${t.entry}`);
    assert.ok(neu.result.trades.length < ORB_RUNS.BANKNIFTY.result.trades.length, "the earlier cut-off removed no trade");
    assert.strictEqual(process.env.ORB_ENTRY_END, undefined, "the pair value leaked into the real env");
  } finally { delete process.env.BN_ORB_ENTRY_END; }
});
check("ORB expiry-day-only: an options market trades its own rule expiry; NIFTY_FUT uses paper's expiry rule", async () => {
  // BANKNIFTY is monthly-only: only its rule expiry days may trade.
  process.env.BN_ORB_EXPIRY_DAY_ONLY = "true";
  try {
    const neu = await runNew({ strategy: "orb", market: "BANKNIFTY", settings: "current", from: FROM, to: TO });
    const ctx = bm.context("BANKNIFTY");
    for (const t of neu.result.trades) {
      const d = _ymd(t.entryTs * 1000);
      assert.strictEqual(bm.contractAt(ctx, 100, "CE", Math.floor(Date.parse(`${d}T09:15:00+05:30`) / 1000)).expiry, d, `BANKNIFTY traded ${d}, not its expiry`);
    }
    assert.ok(neu.result.trades.length < ORB_RUNS.BANKNIFTY.result.trades.length, "expiry-day-only removed no BANKNIFTY trade");
  } finally { delete process.env.BN_ORB_EXPIRY_DAY_ONLY; }
  // NIFTY_FUT: pin paper's rule to a day the synthetic market trades, and only it may trade.
  const days0 = ORB_RUNS.NIFTY_FUT.result.trades.map((t) => _ymd(t.entryTs * 1000));
  assert.ok(days0.length > 1, "NIFTY_FUT baseline run too thin");
  const rt = require("../src/utils/pairRuntime").forStrategy("orb", "NIFTY_FUT");
  const real = rt.isExpiryDay;
  rt.isExpiryDay = (ms) => _ymd(ms) === days0[0];
  process.env.FUT_ORB_EXPIRY_DAY_ONLY = "true";
  try {
    const neu = await runNew({ strategy: "orb", market: "NIFTY_FUT", settings: "current", from: FROM, to: TO });
    const days = neu.result.trades.map((t) => _ymd(t.entryTs * 1000));
    assert.ok(days.length > 0, "an expiry-day-only NIFTY_FUT run found no expiry day");
    assert.ok(days.every((d) => d === days0[0]), `traded off paper's expiry day: ${days.join(",")}`);
  } finally { rt.isExpiryDay = real; delete process.env.FUT_ORB_EXPIRY_DAY_ONLY; }
});

// ─────────────────────────────────────────────────────────────────────────────
section("4f. EMA9+VWAP is market-aware");

// EMA9+VWAP's VIX gate is ON by default (global key) and the synthetic VIX series
// is the index level itself, so every entry would be VIX-blocked and the checks
// below would price nothing. The shared key is switched off for this section only.
let _e9VixWas;
check("EMA9+VWAP section: global VIX filter off for these runs", () => {
  _e9VixWas = process.env.VIX_FILTER_ENABLED;
  process.env.VIX_FILTER_ENABLED = "false";
});
const E9_RUNS = {};
for (const mk of ["SENSEX", "BANKNIFTY", "NIFTY_FUT"]) {
  check(`EMA9+VWAP on ${mk}: its own candles, lot + exchange charges (futures: ₹ on the index), market recorded`, async () => {
    const mark = fetchLog.length, saves = legacySaves.length;
    const neu = await runNew({ strategy: "ema9vwap", market: mk, settings: "current", from: FROM, to: TO, resolution: "5" });
    E9_RUNS[mk] = neu;
    const ctx = bm.context(mk);
    const asked = fetchLog.slice(mark).map((f) => f.symbol).filter((s) => !/VIX/.test(s));
    assert.ok(asked.length && asked.every((s) => s === ctx.spotSymbol), `fetched ${asked.join(",")} for ${mk}`);
    assert.strictEqual(neu.result.meta.market, mk);
    assert.strictEqual(neu.record.market, mk);
    assert.strictEqual(legacySaves.length, saves, `a ${mk} run overwrote NIFTY's legacy EMA9_VWAP slot`);
    assert.ok(/MARKET: /.test(neu.record.view.notes), "the results notes do not name the market");
    assert.strictEqual(neu.result.summary.lotSize, ctx.lotQty, `${mk}: priced with the wrong lot`);
    const CPD = Math.max(1, Math.round(390 / 5)), DELTA = 0.55, THETA = 10;
    for (const t of neu.result.trades) {
      let want;
      if (ctx.isFutures) {
        assert.ok(/^futures /.test(t.pnlMode), t.pnlMode);
        const chg = getCharges({ isFutures: true, exchange: ctx.exchange, exitPremium: t.exitPrice, entryPremium: t.entryPrice, qty: ctx.lotQty });
        want = t.spotPnlPts * ctx.lotQty - chg;
      } else {
        const theta = Math.round((THETA / CPD) * (t.candlesHeld || 1) * 100) / 100;
        const net = t.spotPnlPts * DELTA - theta;
        const chg = getCharges({ isFutures: false, exchange: ctx.exchange, exitPremium: Math.max(1, 200 + net), entryPremium: 200, qty: ctx.lotQty });
        want = net * ctx.lotQty - chg;
      }
      assert.ok(Math.abs(t.pnl - want) <= 0.02, `${mk} trade ${t.entryTime}: pnl ${t.pnl} ≠ ${want.toFixed(2)}`);
    }
    assert.strictEqual(!!neu.result.summary.isFutures, ctx.isFutures);
  });
}

check("EMA9+VWAP market runs traded on their own (scaled) series", () => {
  const n = Object.values(E9_RUNS).reduce((k, r) => k + r.result.trades.length, 0);
  say(`       ${Object.entries(E9_RUNS).map(([k, r]) => `${k}: ${r.result.trades.length} trade(s)`).join(" · ")}`);
  assert.ok(Object.values(E9_RUNS).every((r) => r.result.trades.length > 0), "an EMA9+VWAP market run produced no trade — its pricing check proved nothing");
  assert.ok(n > 0, "no EMA9+VWAP market run produced a trade — the market checks above proved nothing");
  assert.ok((E9_RUNS.SENSEX ? E9_RUNS.SENSEX.result.trades : []).every((t) => t.entryPrice > 50000), "SENSEX trades should be on the SENSEX (scaled) series");
  const S = E9_RUNS.SENSEX.result.trades, B = E9_RUNS.BANKNIFTY.result.trades;
  if (S.length) assert.strictEqual(getCharges({ isFutures: false, exchange: "BSE", exitPremium: 210, entryPremium: 200, qty: 20 }) !== getCharges({ isFutures: false, exitPremium: 210, entryPremium: 200, qty: 20 }), true, "BSE charges must differ from NSE");
  assert.ok(B.every((t) => t.entryPrice > 30000), "BANKNIFTY trades should be on the BANKNIFTY (scaled) series");
});

for (const mk of ["SENSEX", "NIFTY_FUT"]) {
  check(`EMA9+VWAP on ${mk} with <PAIR>_EXPIRY_DAY_ONLY trades only that market's expiry days (the paper /start rule)`, async () => {
    const rt = require("../src/utils/pairRuntime").forStrategy("ema9vwap", mk);
    const key = `${rt.envPrefix}_EXPIRY_DAY_ONLY`;
    const neu = await runNew({ strategy: "ema9vwap", market: mk, settings: "custom", from: FROM, to: TO, resolution: "5", [`s.${key}`]: "true" });
    assert.deepStrictEqual(neu.record.overriddenKeys, ["EMA9VWAP_EXPIRY_DAY_ONLY"]);
    assert.strictEqual(process.env.EMA9VWAP_EXPIRY_DAY_ONLY, undefined, "custom value leaked into process.env");
    const all = E9_RUNS[mk].result.trades;
    const exp = all.filter((t) => rt.isExpiryDay(t.entryTs * 1000));
    assert.ok(neu.result.trades.every((t) => rt.isExpiryDay(t.entryTs * 1000)), `${mk}: an expiry-only run entered off ${mk}'s expiry day`);
    assert.ok(neu.result.trades.length < all.length || all.length === exp.length, `${mk}: expiry-only dropped nothing`);
    assert.ok(exp.length === 0 || neu.result.trades.length > 0, `${mk}: expiry-only blocked every expiry day too`);
  });
}

check("the old EMA9+VWAP page is untouched by markets: NIFTY run reads NIFTY's candles and saves its slot", async () => {
  const mark = fetchLog.length, saves = legacySaves.length;
  const oldRes = await runOld("ema9vwap", `from=${FROM}&to=${TO}&resolution=5`);
  assert.ok(fetchLog.slice(mark).filter((f) => !/VIX/.test(f.symbol)).every((f) => f.symbol === "NSE:NIFTY50-INDEX"));
  assert.strictEqual(oldRes.meta, undefined, "a NIFTY result must not grow a market field");
  assert.strictEqual(oldRes.summary.isFutures, undefined, "a NIFTY result must not grow an isFutures flag");
  assert.ok(legacySaves.slice(saves).includes("EMA9_VWAP"));
  assert.ok(oldRes.trades.length > 0, "the NIFTY run produced no trade — the comparison proves nothing");
});

check("EMA9+VWAP section: global VIX filter restored", () => {
  if (_e9VixWas === undefined) delete process.env.VIX_FILTER_ENABLED;
  else process.env.VIX_FILTER_ENABLED = _e9VixWas;
});

// ─────────────────────────────────────────────────────────────────────────────
section("4g. Trend Pullback is market-aware");

const TPB_RUNS = {};
for (const mk of ["SENSEX", "BANKNIFTY", "NIFTY_FUT"]) {
  check(`Trend Pullback on ${mk}: its own candles, lot, exchange charges; NIFTY's legacy slot untouched`, async () => {
    const mark = fetchLog.length, saves = legacySaves.length;
    const neu = await runNew({ strategy: "trendPb", market: mk, settings: "current", from: FROM, to: TO });
    TPB_RUNS[mk] = neu;
    const ctx = bm.context(mk);
    const asked = fetchLog.slice(mark).filter((f) => String(f.resolution) !== "D").map((f) => f.symbol);
    assert.ok(asked.length && asked.every((s) => s === ctx.spotSymbol), `fetched ${asked.join(",")} for ${mk}`);
    assert.strictEqual(neu.result.market, mk);
    assert.strictEqual(neu.record.market, mk);
    assert.strictEqual(legacySaves.length, saves, "a non-NIFTY run overwrote NIFTY's legacy slot");
    const trades = neu.result.trades;
    assert.ok(trades.length > 0, `${mk}: the synthetic market produced no trade`);
    for (const t of trades) {
      const charges = getCharges({ broker: "fyers", isFutures: ctx.isFutures, exchange: ctx.exchange, entryPremium: t.eOpt, exitPremium: t.xOpt, qty: ctx.lotQty });
      const want = (t.xOpt - t.eOpt) * ctx.lotQty - charges;
      assert.ok(Math.abs(t.pnl - want) <= ctx.lotQty * 0.005 + 0.02,
        `${mk} trade ${t.entry}: pnl ${t.pnl} ≠ (${t.xOpt}−${t.eOpt})×${ctx.lotQty}−${charges}`);
      if (ctx.isFutures) assert.strictEqual(t.eOpt, t.ePrice, `${mk}: a futures entry is the index level`);
    }
    assert.strictEqual(!!neu.result.stats.isFutures, ctx.isFutures);
    assert.strictEqual(neu.result.stats.optionSim, !ctx.isFutures);
    assert.ok(/MARKET: /.test(neu.record.view.notes), "the results notes do not name the market");
  });
}
check("Trend Pullback: SENSEX trades sit on the SENSEX series; the old NIFTY page reads NIFTY only", async () => {
  assert.ok(TPB_RUNS.SENSEX && TPB_RUNS.SENSEX.result.trades.every((t) => t.ePrice > 50000));
  const mark = fetchLog.length;
  const oldRes = await runOld("trendPb", `from=${FROM}&to=${TO}`);
  assert.ok(fetchLog.slice(mark).filter((f) => String(f.resolution) !== "D").every((f) => f.symbol === "NSE:NIFTY50-INDEX"));
  assert.strictEqual(oldRes.market, undefined, "a NIFTY result must not grow a market field");
});
check("Trend Pullback pair settings: a BANKNIFTY-own key reaches the engine for that run only", async () => {
  process.env.BN_TREND_PB_ENTRY_END = "11:00";
  try {
    const { overrides } = page.buildOverrides("trendPb", "BANKNIFTY", null);
    assert.strictEqual(overrides.TREND_PB_ENTRY_END, "11:00");
    const neu = await runNew({ strategy: "trendPb", market: "BANKNIFTY", settings: "current", from: FROM, to: TO });
    for (const t of neu.result.trades) assert.ok(t.entry.split(", ")[1].slice(0, 5) < "11:00", `BANKNIFTY trade entered at ${t.entry}`);
    assert.strictEqual(process.env.TREND_PB_ENTRY_END, undefined, "the pair value leaked into the real env");
  } finally { delete process.env.BN_TREND_PB_ENTRY_END; }
});

// ─────────────────────────────────────────────────────────────────────────────
section("4h. TREND DAY SCALP is market-aware");

const TDS_RUNS = {};
for (const mk of ["SENSEX", "BANKNIFTY", "NIFTY_FUT"]) {
  check(`TDS ${mk}: fetches its own candles, prices with its lot + exchange charges, records the market`, async () => {
    const mark = fetchLog.length;
    const neu = await runNew({ strategy: "trendDayScalp", market: mk, settings: "current", from: FROM, to: TO });
    TDS_RUNS[mk] = neu;
    const ctx = bm.context(mk);
    const asked = fetchLog.slice(mark).map((f) => f.symbol);
    assert.ok(asked.length && asked.every((s) => s === ctx.spotSymbol), `fetched ${asked.join(",")} for ${mk}`);
    assert.strictEqual(neu.result.meta.market, mk);
    assert.strictEqual(neu.record.market, mk);
    for (const t of neu.result.trades) {
      const charges = getCharges({ broker: "fyers", isFutures: ctx.isFutures, exchange: ctx.exchange, entryPremium: t.eOpt, exitPremium: t.xOpt, qty: ctx.lotQty });
      const want = (t.xOpt - t.eOpt) * ctx.lotQty - charges;
      assert.ok(Math.abs(t.pnl - want) <= ctx.lotQty * 0.005 + 0.02, `${mk} trade ${t.entry}: pnl ${t.pnl} ≠ (${t.xOpt}−${t.eOpt})×${ctx.lotQty}−${charges}`);
      if (ctx.isFutures) assert.ok(Math.abs(t.eOpt - t.ePrice) < 50, `${mk}: futures entry ${t.eOpt} is not the index level ${t.ePrice}`);
    }
    assert.strictEqual(!!neu.result.stats.isFutures, ctx.isFutures);
    assert.strictEqual(neu.result.stats.optionSim, !ctx.isFutures);
    assert.ok(!legacySaves.slice(-1).includes("TREND_DAY_SCALP_BACKTEST"), "a non-NIFTY run overwrote NIFTY's legacy slot");
    assert.ok(/MARKET: /.test(neu.record.view.notes), "the results notes do not name the market");
  });
}
check("TDS: the market runs scanned their own scaled series (and at least one traded)", () => {
  const S = TDS_RUNS.SENSEX, B = TDS_RUNS.BANKNIFTY, F = TDS_RUNS.NIFTY_FUT;
  assert.ok(S && B && F, "market runs missing");
  for (const r of [S, B, F]) assert.ok(r.result.meta.days > 0, "no sessions scanned");
  assert.ok(S.result.trades.every((t) => t.ePrice > 50000), "SENSEX trades should be on the SENSEX (scaled) series");
  assert.ok(F.result.trades.every((t) => t.eOpt > 1000), "futures entries should be index levels, not option premiums");
  const n = [S, B, F].reduce((a, r) => a + r.result.trades.length, 0);
  say(`       TDS trades: SENSEX ${S.result.trades.length} · BANKNIFTY ${B.result.trades.length} · NIFTY_FUT ${F.result.trades.length}`);
  assert.ok(n > 0, "no TDS market run traded — the pricing checks above proved nothing");
});
check("TDS pair settings: a SENSEX-own key reaches the engine (as its TDS_* key) for that run only", async () => {
  process.env.SENSEX_TDS_ENTRY_END = "11:00";
  try {
    const { overrides } = page.buildOverrides("trendDayScalp", "SENSEX", null);
    assert.strictEqual(overrides.TDS_ENTRY_END, "11:00");
    const neu = await runNew({ strategy: "trendDayScalp", market: "SENSEX", settings: "current", from: FROM, to: TO });
    assert.ok(neu.record.overriddenKeys.includes("TDS_ENTRY_END"));
    for (const t of neu.result.trades) assert.ok(t.entry.split(", ")[1].slice(0, 5) < "11:00", `SENSEX TDS entered at ${t.entry}`);
    assert.strictEqual(process.env.TDS_ENTRY_END, undefined, "the pair value leaked into the real env");
  } finally { delete process.env.SENSEX_TDS_ENTRY_END; }
});
check("the old TDS page is untouched by markets: NIFTY run reads NIFTY's candles, no market field", async () => {
  const mark = fetchLog.length;
  const oldRes = await runOld("trendDayScalp", `from=${FROM}&to=${TO}`);
  assert.ok(fetchLog.slice(mark).every((f) => f.symbol === "NSE:NIFTY50-INDEX"));
  assert.strictEqual(oldRes.meta.market, undefined, "a NIFTY result must not grow a market field");
});

// ─────────────────────────────────────────────────────────────────────────────
section("4i. HA SCALP is market-aware");

const HA_RUNS = {};
for (const mk of ["SENSEX", "BANKNIFTY", "NIFTY_FUT"]) {
  check(`HA SCALP ${mk}: fetches its own candles, prices with its lot + exchange charges, records the market`, async () => {
    const mark = fetchLog.length;
    const neu = await runNew({ strategy: "haScalp", market: mk, settings: "current", from: FROM, to: TO });
    HA_RUNS[mk] = neu;
    const ctx = bm.context(mk);
    const asked = fetchLog.slice(mark).map((f) => f.symbol);
    assert.ok(asked.length && asked.every((s) => s === ctx.spotSymbol), `fetched ${asked.join(",")} for ${mk}`);
    assert.strictEqual(neu.result.meta.market, mk);
    assert.strictEqual(neu.record.market, mk);
    for (const t of neu.result.trades) {
      const charges = getCharges({ broker: "fyers", isFutures: ctx.isFutures, exchange: ctx.exchange, entryPremium: t.eOpt, exitPremium: t.xOpt, qty: ctx.lotQty });
      const want = (t.xOpt - t.eOpt) * ctx.lotQty - charges;
      assert.ok(Math.abs(t.pnl - want) <= ctx.lotQty * 0.005 + 0.02, `${mk} trade ${t.entry}: pnl ${t.pnl} ≠ (${t.xOpt}−${t.eOpt})×${ctx.lotQty}−${charges}`);
      if (ctx.isFutures) assert.ok(Math.abs(t.eOpt - t.ePrice) < 50, `${mk}: futures entry ${t.eOpt} is not the index level ${t.ePrice}`);
    }
    assert.strictEqual(!!neu.result.stats.isFutures, ctx.isFutures);
    assert.strictEqual(neu.result.stats.optionSim, !ctx.isFutures);
    assert.ok(!legacySaves.slice(-1).includes("HA_SCALP_BACKTEST"), "a non-NIFTY run overwrote NIFTY's legacy slot");
    assert.ok(/MARKET: /.test(neu.record.view.notes), "the results notes do not name the market");
  });
}
check("HA SCALP: the market runs scanned their own scaled series (and at least one traded)", () => {
  const S = HA_RUNS.SENSEX, B = HA_RUNS.BANKNIFTY, F = HA_RUNS.NIFTY_FUT;
  assert.ok(S && B && F, "market runs missing");
  for (const r of [S, B, F]) assert.ok(r.result.meta.days > 0, "no sessions scanned");
  assert.ok(S.result.trades.every((t) => t.ePrice > 50000), "SENSEX trades should be on the SENSEX (scaled) series");
  assert.ok(F.result.trades.every((t) => t.eOpt > 1000), "futures entries should be index levels, not option premiums");
  const n = [S, B, F].reduce((a, r) => a + r.result.trades.length, 0);
  say(`       HA SCALP trades: SENSEX ${S.result.trades.length} · BANKNIFTY ${B.result.trades.length} · NIFTY_FUT ${F.result.trades.length}`);
  assert.ok(n > 0, "no HA SCALP market run traded — the pricing checks above proved nothing");
});
check("HA SCALP pair settings: a SENSEX-own key reaches the engine (as its HA_SCALP_* key) for that run only", async () => {
  process.env.SENSEX_HA_SCALP_ENTRY_END = "11:00";
  try {
    const { overrides } = page.buildOverrides("haScalp", "SENSEX", null);
    assert.strictEqual(overrides.HA_SCALP_ENTRY_END, "11:00");
    const neu = await runNew({ strategy: "haScalp", market: "SENSEX", settings: "current", from: FROM, to: TO });
    assert.ok(neu.record.overriddenKeys.includes("HA_SCALP_ENTRY_END"));
    for (const t of neu.result.trades) assert.ok(t.entry.split(", ")[1].slice(0, 5) <= "11:00", `SENSEX HA SCALP entered at ${t.entry}`);
    assert.strictEqual(process.env.HA_SCALP_ENTRY_END, undefined, "the pair value leaked into the real env");
  } finally { delete process.env.SENSEX_HA_SCALP_ENTRY_END; }
});
check("the old HA SCALP page is untouched by markets: NIFTY run reads NIFTY's candles, no market field", async () => {
  const mark = fetchLog.length;
  const oldRes = await runOld("haScalp", `from=${FROM}&to=${TO}`);
  assert.ok(fetchLog.slice(mark).every((f) => f.symbol === "NSE:NIFTY50-INDEX"));
  assert.strictEqual(oldRes.meta.market, undefined, "a NIFTY result must not grow a market field");
});

// ─────────────────────────────────────────────────────────────────────────────
section("4j. RSI PIVOT ST is market-aware");

const RPS_RUNS = {};
for (const mk of ["SENSEX", "BANKNIFTY", "NIFTY_FUT"]) {
  check(`RSI PIVOT ST ${mk}: fetches its own intraday + daily candles, prices with its lot + exchange charges, records the market`, async () => {
    const mark = fetchLog.length;
    const neu = await runNew({ strategy: "rsiPivotSt", market: mk, settings: "current", from: FROM, to: TO });
    RPS_RUNS[mk] = neu;
    const ctx = bm.context(mk);
    const asked = fetchLog.slice(mark);
    assert.ok(asked.length && asked.every((f) => f.symbol === ctx.spotSymbol), `fetched ${asked.map((f) => f.symbol).join(",")} for ${mk}`);
    assert.ok(asked.some((f) => String(f.resolution).toUpperCase() === "D"), "the pivots' daily series must be the market's own");
    assert.strictEqual(neu.result.meta.market, mk);
    assert.strictEqual(neu.record.market, mk);
    for (const t of neu.result.trades) {
      const charges = getCharges({ broker: "fyers", isFutures: ctx.isFutures, exchange: ctx.exchange, entryPremium: t.eOpt, exitPremium: t.xOpt, qty: ctx.lotQty });
      const want = (t.xOpt - t.eOpt) * ctx.lotQty - charges;
      assert.ok(Math.abs(t.pnl - want) <= ctx.lotQty * 0.005 + 0.02, `${mk} trade ${t.entry}: pnl ${t.pnl} ≠ (${t.xOpt}−${t.eOpt})×${ctx.lotQty}−${charges}`);
      if (ctx.isFutures) assert.ok(Math.abs(t.eOpt - t.ePrice) < 50, `${mk}: futures entry ${t.eOpt} is not the index level ${t.ePrice}`);
      else assert.strictEqual(t.strike % ctx.strikeStep, 0, `${mk}: strike ${t.strike} is off the ${ctx.strikeStep}-pt grid`);
    }
    assert.strictEqual(!!neu.result.stats.isFutures, ctx.isFutures);
    assert.strictEqual(neu.result.stats.optionSim, !ctx.isFutures);
    assert.ok(!legacySaves.slice(-1).includes("RSI_PIVOT_ST_BACKTEST"), "a non-NIFTY run overwrote NIFTY's legacy slot");
    assert.ok(/MARKET: /.test(neu.record.view.notes), "the results notes do not name the market");
  });
}
check("RSI PIVOT ST: the market runs scanned their own scaled series", () => {
  const S = RPS_RUNS.SENSEX, B = RPS_RUNS.BANKNIFTY, F = RPS_RUNS.NIFTY_FUT;
  assert.ok(S && B && F, "market runs missing");
  for (const r of [S, B, F]) assert.ok(r.result.meta.days > 0, "no sessions scanned");
  assert.ok(S.result.trades.every((t) => t.ePrice > 50000), "SENSEX trades should be on the SENSEX (scaled) series");
  assert.ok(F.result.trades.every((t) => t.eOpt > 1000), "futures entries should be index levels, not option premiums");
  say(`       RSI PIVOT ST trades: SENSEX ${S.result.trades.length} · BANKNIFTY ${B.result.trades.length} · NIFTY_FUT ${F.result.trades.length}`);
});
check("RSI PIVOT ST pair settings: a BANKNIFTY-own key (BN_PIVOT_RSI_ST_*) reaches the engine for that run only", async () => {
  process.env.BN_PIVOT_RSI_ST_ENTRY_END = "11:00";
  try {
    const { overrides } = page.buildOverrides("rsiPivotSt", "BANKNIFTY", null);
    assert.strictEqual(overrides.RSI_PIVOT_ST_ENTRY_END, "11:00");
    const neu = await runNew({ strategy: "rsiPivotSt", market: "BANKNIFTY", settings: "current", from: FROM, to: TO });
    assert.ok(neu.record.overriddenKeys.includes("RSI_PIVOT_ST_ENTRY_END"));
    for (const t of neu.result.trades) assert.ok(t.entry.split(", ")[1].slice(0, 5) < "11:00", `BANKNIFTY RSI PIVOT ST entered at ${t.entry}`);
    assert.strictEqual(process.env.RSI_PIVOT_ST_ENTRY_END, undefined, "the pair value leaked into the real env");
  } finally { delete process.env.BN_PIVOT_RSI_ST_ENTRY_END; }
});

// ─────────────────────────────────────────────────────────────────────────────
section("5. Custom settings apply to the run only");

check("scopedEnv: overrides are visible inside the async scope only, and writes go to the real env", async () => {
  process.env.ZZ_SCOPE_PROBE = "real";
  let inside, outsideDuring;
  const t = setInterval(() => { outsideDuring = process.env.ZZ_SCOPE_PROBE; }, 1);
  await scopedEnv.run({ ZZ_SCOPE_PROBE: "custom", ZZ_UNSET: null }, async () => {
    await sleep(15);
    inside = process.env.ZZ_SCOPE_PROBE;
    assert.strictEqual("ZZ_UNSET" in process.env, false);
  });
  clearInterval(t);
  assert.strictEqual(inside, "custom");
  assert.strictEqual(outsideDuring, "real", "a timer outside the run saw the custom value");
  assert.strictEqual(process.env.ZZ_SCOPE_PROBE, "real");
  delete process.env.ZZ_SCOPE_PROBE;
});

check("a custom V2 entry window changes the run, is recorded, and never touches process.env", async () => {
  const cur = MKT_RUNS.NIFTY || await runNew({ strategy: "emaRsiStV2", market: "NIFTY", settings: "current", from: FROM, to: TO });
  const saves = legacySaves.length;
  const neu = await runNew({ strategy: "emaRsiStV2", market: "NIFTY", settings: "custom", from: FROM, to: TO, "s.EMA_RSI_ST_V2_ENTRY_START": "12:00" });
  assert.strictEqual(process.env.EMA_RSI_ST_V2_ENTRY_START, undefined, "custom value leaked into process.env");
  assert.strictEqual(legacySaves.length, saves, "a custom run overwrote the strategy's current-settings last-run slot");
  const row = neu.record.settings.find((s) => s.key === "EMA_RSI_ST_V2_ENTRY_START");
  assert.deepStrictEqual([row.value, row.source, row.engineValue], ["12:00", "custom", "12:00"]);
  assert.deepStrictEqual(neu.record.overriddenKeys, ["EMA_RSI_ST_V2_ENTRY_START"]);
  assert.strictEqual(neu.record.settingsSource, "custom");
  for (const t of neu.result.trades) assert.ok(t.entry.split(", ")[1] >= "12:00", `custom run entered at ${t.entry}`);
  assert.ok(neu.result.trades.length < cur.result.trades.length || cur.result.trades.every((t) => t.entry.split(", ")[1] >= "12:00"),
    "a later entry start should drop the pre-12:00 trades");
  assert.ok(/12:00/.test(neu.record.view.notes), "the results notes should show the custom window");
});

check("bb_rsi's shared indicator cache never hands a custom-period run's bands to paper (or back)", async () => {
  const bbRsi = require("../src/strategies/bb_rsi");
  const c = [];
  for (let i = 0, p = 24000; i < 100; i++) { const o = p; p += Math.sin(i / 5) * 20; c.push({ time: 1762747200 + i * 300, open: o, high: Math.max(o, p) + 3, low: Math.min(o, p) - 3, close: p }); }
  const o = { silent: true, skipTimeCheck: true };
  bbRsi.reset();
  const paper = bbRsi.getSignal(c, o);
  const custom = { BB_RSI_BB_PERIOD: "20", BB_RSI_BB_STDDEV: "1", BB_RSI_RSI_PERIOD: "7" };
  let run;
  await scopedEnv.run(custom, async () => { run = bbRsi.getSignal(c, o); });
  assert.notStrictEqual(run.bbUpper, paper.bbUpper, "the custom run was handed paper's cached bands");
  assert.strictEqual(bbRsi.getSignal(c, o).bbUpper, paper.bbUpper, "paper was handed the custom run's cached bands");
  bbRsi.reset();
});

check("a 'custom' value equal to the current one is not custom (no override, source unchanged)", () => {
  const cur = page.settingsFields("emaRsiStV2", "NIFTY").find((f) => f.key === "EMA_RSI_ST_V2_RSI_CE_MIN");
  const { overrides, settings: used } = page.buildOverrides("emaRsiStV2", "NIFTY", { EMA_RSI_ST_V2_RSI_CE_MIN: cur.value });
  assert.deepStrictEqual(overrides, {});
  assert.notStrictEqual(used.find((s) => s.key === "EMA_RSI_ST_V2_RSI_CE_MIN").source, "custom");
});

// ─────────────────────────────────────────────────────────────────────────────
section("6. Saved results");

// Only the newest 40 runs are kept, and the market sections above make more
// than that — re-run the SENSEX V2 case so the checks below read a live record.
check("(re-run SENSEX V2 so its saved record is among the newest kept)", async () => {
  MKT_RUNS.SENSEX = await runNew({ strategy: "emaRsiStV2", market: "SENSEX", settings: "current", from: FROM, to: TO });
});

check("every run is saved with strategy, market, range and the exact settings, and lists newest first", () => {
  const list = resultStore.listRuns(100);
  assert.ok(list.length >= 8, `only ${list.length} saved runs`);
  for (let i = 1; i < list.length; i++) assert.ok(String(list[i - 1].savedAt) >= String(list[i].savedAt));
  const rec = resultStore.loadRun(MKT_RUNS.SENSEX.id);
  for (const k of ["id", "strategyId", "strategyLabel", "market", "marketLabel", "from", "to", "settingsSource", "settings", "overriddenKeys", "view", "savedAt"]) {
    assert.ok(rec[k] !== undefined, `saved run has no ${k}`);
  }
  assert.deepStrictEqual([rec.strategyId, rec.market, rec.from, rec.to], ["emaRsiStV2", "SENSEX", FROM, TO]);
  assert.ok(rec.settings.length > 5 && rec.settings.every((s) => s.key && s.homeKey && s.source && "engineValue" in s));
  assert.ok(Array.isArray(rec.view.trades) && rec.view.summary.totalTrades === rec.view.trades.length);
});

check("profit factor ∞ survives the save (JSON has no Infinity)", () => {
  resultStore.saveRun({ id: "inftest01", strategyId: "orb", market: "NIFTY", view: { summary: { profitFactor: Infinity, totalTrades: 1 }, trades: [] } });
  assert.strictEqual(resultStore.loadRun("inftest01").view.summary.profitFactor, Infinity);
  assert.strictEqual(resultStore.loadRun("../etc/passwd"), null, "a malformed id must not reach the disk");
});

check("a saved run re-opens: HTML results (cards on a phone, panels open) and JSON", async () => {
  const id = MKT_RUNS.SENSEX.id;
  const r = await get(`/backtest/result/${id}`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes("EMA_RSI_ST_V2") && r.body.includes("SENSEX"));
  assert.ok(r.body.includes('class="tw bt-cards"') && r.body.includes("labelCells(tbody)"), "trade table is not a phone card list");
  assert.ok(r.body.includes("toggleDayWise(); toggleAnalytics();"), "per-day P&L / equity curve not opened");
  assert.ok(r.body.includes("var ENDPOINT_Q = \"strategy=emaRsiStV2&market=SENSEX&settings=current&\""), "Run Again would lose the strategy/market");
  for (const sc of [...r.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) new Function(sc);
  const j = await get(`/backtest/result/${id}.json`);
  assert.strictEqual(JSON.parse(j.body).market, "SENSEX");
  assert.strictEqual((await get("/backtest/result/doesnotexist")).status, 404);
  const done = await get(`/backtest/run?strategy=emaRsiStV2&market=SENSEX&from=${FROM}&to=${TO}&jobId=${id}`);
  assert.ok(done.status === 302 && done.headers.location === `/backtest/result/${id}`, "a finished job id should redirect to its saved result");
});

check("the old pages render byte-for-byte as before (no new option leaks into a default render)", () => {
  const html = renderBacktestResults({ mode: "X", endpoint: "/x-backtest", from: FROM, to: TO, summary: require("../src/utils/backtestUI").computeBacktestStats([]), trades: [] });
  for (const s of ["bt-cards", "ENDPOINT_Q", "labelCells", "bt-crumb", "toggleAnalytics(); }"]) assert.ok(!html.includes(s), `default render contains ${s}`);
  assert.ok(html.includes("window.location = ENDPOINT+'?from='+f+'&to='+t;"));
});

// ─────────────────────────────────────────────────────────────────────────────
section("Wiring: sidebar, Settings toggle, app mount");

check("sidebar: one Backtest item under Dashboard, default on, hidden by UI_SHOW_BACKTEST_PAGE=false", () => {
  delete process.env.UI_SHOW_BACKTEST_PAGE;
  const on = nav.buildSidebar("backtest", false);
  assert.strictEqual((on.match(/href="\/backtest"/g) || []).length, 1);
  const dash = on.match(/<div class="sb-group-items[^"]*" id="nav-dashboard">([\s\S]*?)<\/div>/);
  assert.ok(dash && dash[1].includes('href="/backtest"'), "the Backtest item is not in the Dashboard group");
  process.env.UI_SHOW_BACKTEST_PAGE = "false";
  try { assert.ok(!nav.buildSidebar("x", false).includes('href="/backtest"')); }
  finally { delete process.env.UI_SHOW_BACKTEST_PAGE; }
});

check("Settings has the UI_SHOW_BACKTEST_PAGE toggle (default true) and the BSE charge keys", () => {
  const src = fs.readFileSync(path.join(SRC, "routes/settings.js"), "utf8");
  assert.ok(/key: "UI_SHOW_BACKTEST_PAGE",[^\n]*type: "toggle"[^\n]*default: "true"/.test(src));
  assert.ok(/key: "EXCHANGE_TXN_OPT_PCT_BSE"/.test(src) && /key: "EXCHANGE_TXN_FUT_PCT_BSE"/.test(src));
});

check("app.js mounts /backtest and opens its read-only GETs to API_SECRET-less browser loads", () => {
  const src = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
  assert.ok(/app\.use\("\/backtest",\s+lazyRouter\(\(\) => require\("\.\/routes\/backtest"\)\)\)/.test(src));
  for (const p of ["/backtest", "/backtest/run", "/backtest/status", "/backtest/idle", "/backtest/options.json"]) assert.ok(src.includes(`  "${p}",`), `${p} not in OPEN_PATHS`);
  assert.ok(src.includes('"/backtest/result/",'), "/backtest/result/ not in OPEN_PREFIXES");
});

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const origLog = console.log;
  for (const item of _queue) {
    if (item.section) { origLog(`\n${item.section}`); continue; }
    // The engines are chatty; keep the suite's own output readable.
    console.log = () => {};
    let err = null;
    try { await item.fn(); } catch (e) { err = e; }
    console.log = origLog;
    if (err) { origLog(`  ❌ ${item.name}\n       ${err.stack ? err.stack.split("\n").slice(0, 3).join("\n       ") : err.message}`); fail++; }
    else { origLog(`  ✅ ${item.name}`); pass++; }
  }
  server.close();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
  origLog(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();

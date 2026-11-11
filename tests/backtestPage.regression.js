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
 *   4. EMA_RSI_ST_V2 is market-aware — SENSEX / BANKNIFTY / NIFTY_FUT fetch the
 *      market's own candles and price with its lot, its exchange's charges and
 *      (futures) futures P&L, and read the market's pair settings;
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
  if (/^(EMA_RSI_ST_V2|SENSEX_|BN_|FUT_|ORB_|TREND_PB_|PROFIT_LOCK_|PREMIUM_SL_|BACKTEST_|UI_SHOW_|API_SECRET|LOGIN_SECRET|DEMO_)/.test(k)) delete process.env[k];
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
resultStore.saveResult = (key, v) => { legacySaves.push(key); };
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
const OLD = ["emaRsiStV2", "orb", "emaRsiSt", "bbRsi", "ema9vwap", "trendPb", "haScalp"];
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
  for (const s of page.strategies()) {
    if (s.id === "emaRsiStV2") continue;
    const on2 = page.marketOptions(s.id).filter((m) => m.enabled).map((m) => m.key);
    assert.deepStrictEqual(on2, [pairs.homeMarket(s.id)], `${s.id} runs only on its home market today`);
  }
});

check("a run on a non-offered / coming-soon market or a bad request is refused before any job starts", () => {
  const base = { strategy: "orb", from: FROM, to: TO, resolution: null, settingsSource: "current", custom: {} };
  assert.ok(/not offered/.test(page.start({ ...base, market: "CRUDE" }).error));
  assert.ok(/coming soon/.test(page.start({ ...base, market: "BANKNIFTY" }).error));
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
  const neu = await runNew({ strategy: "emaRsiStV2", market: "NIFTY", settings: "custom", from: FROM, to: TO, "s.EMA_RSI_ST_V2_ENTRY_START": "12:00" });
  assert.strictEqual(process.env.EMA_RSI_ST_V2_ENTRY_START, undefined, "custom value leaked into process.env");
  const row = neu.record.settings.find((s) => s.key === "EMA_RSI_ST_V2_ENTRY_START");
  assert.deepStrictEqual([row.value, row.source, row.engineValue], ["12:00", "custom", "12:00"]);
  assert.deepStrictEqual(neu.record.overriddenKeys, ["EMA_RSI_ST_V2_ENTRY_START"]);
  assert.strictEqual(neu.record.settingsSource, "custom");
  for (const t of neu.result.trades) assert.ok(t.entry.split(", ")[1] >= "12:00", `custom run entered at ${t.entry}`);
  assert.ok(neu.result.trades.length < cur.result.trades.length || cur.result.trades.every((t) => t.entry.split(", ")[1] >= "12:00"),
    "a later entry start should drop the pre-12:00 trades");
  assert.ok(/12:00/.test(neu.record.view.notes), "the results notes should show the custom window");
});

check("a 'custom' value equal to the current one is not custom (no override, source unchanged)", () => {
  const cur = page.settingsFields("emaRsiStV2", "NIFTY").find((f) => f.key === "EMA_RSI_ST_V2_RSI_CE_MIN");
  const { overrides, settings: used } = page.buildOverrides("emaRsiStV2", "NIFTY", { EMA_RSI_ST_V2_RSI_CE_MIN: cur.value });
  assert.deepStrictEqual(overrides, {});
  assert.notStrictEqual(used.find((s) => s.key === "EMA_RSI_ST_V2_RSI_CE_MIN").source, "custom");
});

// ─────────────────────────────────────────────────────────────────────────────
section("6. Saved results");

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

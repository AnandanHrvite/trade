/**
 * dashboard.regression.js — the Dashboard ("/", routes/dashboard.js) and the
 * Real-Time Monitor (routes/realtime.js, also "/" while a session runs).
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Rows and markets come from registry × running pairs (dashboardModel).
 *   2. Both pages render: viewport meta, inline scripts compile, one section
 *      per market holding exactly that market's strategies, and a market filter
 *      whose list is derived from registry × pairs (not hand-typed).
 *   3. The shared summary table groups by market, and the market subtotals add
 *      up to the grand TOTAL (also with a market filter applied).
 *   4. The monitor's real poll → hero / cards / table path, run in a stub DOM.
 *   5. The filter is remembered per device and survives blocked storage.
 *
 * UI_THEME is pinned: "auto" resolves by time of day.
 * ─────────────────────────────────────────────────────────────────────────────
 */

process.env.UI_THEME = "dark";
// The quick links follow the menu toggles; pin them so a local .env that hides a menu cannot fail the check.
process.env.UI_SHOW_REALTIME = "true";
process.env.UI_SHOW_PAPER_HISTORY = "true";
process.env.UI_SHOW_BACKTEST_PAGE = "true";
// A mix of markets: home strategies (NIFTY, SAIL → STOCKS, the stock scanner →
// STOCKS) plus running non-home pairs on BANKNIFTY and CRUDE.
process.env.SAIL_VWAP_ST_MODE_ENABLED = "true";
process.env.GAP_RUNAWAY_STK_MODE_ENABLED = "true";

const assert = require("assert");
const path   = require("path");
const vm     = require("vm");

const SRC = path.join(__dirname, "..", "src");
const registry = require(path.join(SRC, "config/strategyRegistry"));
const markets  = require(path.join(SRC, "config/markets"));
const pairs    = require(path.join(SRC, "config/pairs"));
const model    = require(path.join(SRC, "utils/dashboardModel"));
const ui       = require(path.join(SRC, "utils/dashboardUI"));

// Switch ON every running pair on two markets (whatever strategies run as pairs today).
const PAIR_MARKETS = ["BANKNIFTY", "CRUDE"];
for (const p of pairs.runnable()) if (PAIR_MARKETS.includes(p.marketKey)) process.env[p.enabledKey] = "true";

let pass = 0, fail = 0;
const quiet = (fn) => { const o = [console.log, console.warn, console.error]; console.log = console.warn = console.error = () => {}; try { return fn(); } finally { [console.log, console.warn, console.error] = o; } };
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n     ") : e}`); }
}
const section = (t) => console.log(`\n${t}`);

// Expected market list, computed here straight from the config — not from dashboardModel.
const groupOf = (k) => (markets.MARKET_DEFS[k].group === "stock" ? "STOCKS" : k);
const ORDER = [...new Set(Object.keys(markets.MARKET_DEFS).map(groupOf))];
function expectedMarkets() {
  const on = (key, def) => String(process.env[key] || def).toLowerCase() === "true";
  const have = new Set();
  for (const e of registry.all()) {
    if (!on(e.modeEnabled.key, e.modeEnabled.default)) continue;
    have.add(e.kind === "tool" ? "STOCKS" : groupOf(pairs.homeMarket(e.id)));
  }
  for (const p of pairs.runnable({ enabledOnly: true })) have.add(groupOf(p.marketKey));
  return ORDER.filter((k) => have.has(k));
}
const scriptsOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const filterList = (html) => [...html.matchAll(/data-dh-filter="([^"]+)"/g)].map((m) => m[1]);
// "<section … data-dh-market="X" …>…</section>" → { X: [data-mode / card keys] }
function sections(html, tag, keyRe) {
  const out = {};
  for (const m of html.matchAll(new RegExp(`<section class="${tag}"[^>]*data-dh-market="([A-Z_]+)"[^>]*>([\\s\\S]*?)</section>`, "g"))) {
    out[m[1]] = [...m[2].matchAll(keyRe)].map((k) => k[1]);
  }
  return out;
}

// ── 1 ───────────────────────────────────────────────────────────────────────
section("1. Rows and markets — registry × running pairs");

check("every registry entry is one row on its home market; every running pair one row on its own", () => {
  const rows = model.allRows();
  for (const e of registry.all()) {
    const mine = rows.filter((r) => r.key === e.key);
    assert.strictEqual(mine.length, 1, e.key);
    assert.strictEqual(mine[0].paperPrefix, e.paper.path, e.key);
    assert.strictEqual(mine[0].market, e.kind === "tool" ? "STOCKS" : groupOf(pairs.homeMarket(e.id)), e.key);
  }
  for (const p of pairs.runnable()) {
    const mine = rows.filter((r) => r.key === p.envPrefix);
    assert.strictEqual(mine.length, 1, p.envPrefix);
    assert.strictEqual(mine[0].market, groupOf(p.marketKey), p.envPrefix);
    assert.strictEqual(mine[0].modeFlag, p.enabledKey, p.envPrefix);
  }
  assert.strictEqual(rows.length, registry.all().length + pairs.runnable().length);
});

check("market groups follow markets.js order, stocks folded into STOCKS", () => {
  assert.deepStrictEqual(model.MARKET_GROUPS.map((g) => g.key), ORDER);
  assert.ok(ORDER.includes("STOCKS") && !ORDER.includes("SAIL"));
  assert.strictEqual(model.MARKET_GROUPS.find((g) => g.key === "NIFTY_FUT").label, "NIFTY FUT");
});

check("enabled markets = the markets of the enabled rows, derived", () => {
  assert.deepStrictEqual(model.marketsOf(model.enabledRows()).map((g) => g.key), expectedMarkets());
  assert.ok(expectedMarkets().length >= 3, "the fixture should span several markets");
});

// ── 2 ───────────────────────────────────────────────────────────────────────
section("2. Both pages render, grouped by market");

const rtRoute = require(path.join(SRC, "routes/realtime"));
const rtHtml = quiet(() => rtRoute.renderRealtimePage({ sidebarKey: "realtime" }));
// Pin a trading day: on a weekend/holiday the page hides the hero and expiry strip.
const nseHolidays = require(path.join(SRC, "utils/nseHolidays"));
const _realNonTrading = nseHolidays.isNonTradingDaySync;
nseHolidays.isNonTradingDaySync = () => false;
const dashHtml = quiet(() => require(path.join(SRC, "routes/dashboard")).renderDashboard());
nseHolidays.isNonTradingDaySync = () => true;
const dashLeaveHtml = quiet(() => require(path.join(SRC, "routes/dashboard")).renderDashboard());
nseHolidays.isNonTradingDaySync = _realNonTrading;

for (const [name, html] of [["Real-Time Monitor", rtHtml], ["Dashboard", dashHtml]]) {
  check(`${name}: viewport meta (device width, safe-area aware)`, () => {
    assert.ok(/<meta name="viewport" content="width=device-width,\s*initial-scale=1(\.0)?,\s*viewport-fit=cover"/.test(html));
    assert.ok(/env\(safe-area-inset-left\)/.test(html) && /env\(safe-area-inset-right\)/.test(html));
  });
  check(`${name}: every inline script compiles`, () => {
    const s = scriptsOf(html);
    assert.ok(s.length >= 1);
    s.forEach((code, i) => new vm.Script(code, { filename: `${name}#${i}` }));
  });
  check(`${name}: market filter = All + the derived markets`, () => {
    assert.deepStrictEqual(filterList(html), ["ALL", ...expectedMarkets()]);
    for (const k of expectedMarkets()) assert.ok(html.includes(`id="dh-chip-${k}"`), `no hero chip for ${k}`);
  });
  check(`${name}: hero, light-theme tokens and quick links`, () => {
    assert.ok(html.includes('id="dh-hero-total"'));
    assert.ok(/:root\[data-theme="light"\] \{[^}]*--dh-card:#ffffff/.test(html), "no light-theme tokens");
    for (const href of ["/consolidation", "/backtest", "/settings"]) assert.ok(html.includes(`class="dh-link" href="${href}"`), href);
  });
}

check("Real-Time Monitor: one section per market, each holding exactly its strategies' cards", () => {
  const got = sections(rtHtml, "rt-mkt", /id="card-([A-Z0-9_]+)"/g);
  const rows = model.enabledRows();
  assert.deepStrictEqual(Object.keys(got), expectedMarkets());
  for (const m of Object.keys(got)) assert.deepStrictEqual(got[m], rows.filter((r) => r.market === m).map((r) => r.key), m);
  for (const p of pairs.runnable({ enabledOnly: true })) assert.ok(got[groupOf(p.marketKey)].includes(p.envPrefix), p.envPrefix);
});

check("Real-Time Monitor: every card keeps Copy Day Log / Open Status / Exit Trade", () => {
  for (const r of model.enabledRows()) {
    assert.ok(rtHtml.includes(`id="open-${r.key}" href="${r.paperPrefix}/status"`), r.key);
    assert.ok(rtHtml.includes(`id="exit-${r.key}" onclick="exitPosition('${r.key}', this)"`), r.key);
    if (r.hasDayLog) assert.ok(rtHtml.includes(`id="copy-${r.key}" onclick="copyDayLog('${r.key}', this)"`), r.key);
  }
  assert.ok(rtHtml.includes('id="stop-nse"') && rtHtml.includes("🛑 Stop All"));
});

check("Dashboard: P&L chart cards grouped by market, one per enabled row", () => {
  const got = sections(dashHtml, "mm-mkt", /data-mode="([A-Z0-9_]+)"/g);
  const rows = model.enabledRows();
  assert.deepStrictEqual(Object.keys(got), expectedMarkets());
  for (const m of Object.keys(got)) assert.deepStrictEqual(got[m], rows.filter((r) => r.market === m).map((r) => r.key), m);
});

check("Dashboard: today panel, broker strip and Start All are still there", () => {
  assert.ok(dashHtml.includes('id="dashAnalytics"') && dashHtml.includes('id="da-body"'));
  assert.ok(dashHtml.includes('id="btn-all-start"') && dashHtml.includes("startAll(this)"));
  assert.ok(dashHtml.includes('class="brokers"') && dashHtml.includes("saveDashExpiry("));
  // order: filter + links → brokers → hero → today panel → charts
  const at = (s) => { const i = dashHtml.indexOf(s); assert.ok(i > 0, s); return i; };
  const seq = ['id="dh-filter"', 'class="dh-links"', 'class="brokers"', 'class="dh-hero"', 'id="dashAnalytics"', 'id="dashCumCard"', 'class="mm-mkt"'].map(at);
  assert.deepStrictEqual(seq, seq.slice().sort((a, b) => a - b), "sections out of order");
});

check("Dashboard: a leave day hides the hero and the expiry strip, keeps the rest", () => {
  assert.ok(!dashLeaveHtml.includes('class="dh-hero"'), "hero shown on a leave day");
  assert.ok(!dashLeaveHtml.includes("brk-cfg-strip\">"), "expiry strip shown on a leave day");
  assert.ok(dashLeaveHtml.includes('id="dashAnalytics"') && dashLeaveHtml.includes('class="brokers"'));
  assert.ok(/<option value="tm" selected>/.test(dashLeaveHtml), "leave day must open on This month");
});

check("no retired copy-strategy tiles (BN_/FUT_/CMX_/SAIL_PIVOT) unless they are real running pairs", () => {
  const running = new Set(pairs.runnable().map((p) => p.envPrefix));
  for (const html of [rtHtml, dashHtml]) {
    for (const m of html.matchAll(/(?:data-mode="|id="card-)((?:BN|FUT|CMX|SAIL_PIVOT)_[A-Z0-9_]+)/g)) {
      assert.ok(running.has(m[1]), `stale tile ${m[1]}`);
    }
    assert.ok(!/SAIL_PIVOT|CMX_/.test(html.replace(/<script>[\s\S]*?<\/script>/g, "")), "retired copy named on the page");
  }
});

// ── 3 ───────────────────────────────────────────────────────────────────────
section("3. Summary table — grouped, subtotals add up to the total");

function clientCtx(storage) {
  const ctx = { console, localStorage: storage, document: { querySelectorAll: () => [], getElementById: () => null } };
  vm.createContext(ctx);
  vm.runInContext(ui.dashClientJS(), ctx);
  return ctx;
}
const MK = [{ key: "NIFTY", label: "NIFTY" }, { key: "BANKNIFTY", label: "BANKNIFTY" }, { key: "CRUDE", label: "CRUDE" }];
const ROWS = [
  { key: "A", label: "Alpha", market: "NIFTY", running: true, open: 120.4, closed: -300, trades: 3, w: 1, l: 2 },
  { key: "B", label: "Beta", market: "NIFTY", running: true, open: 0, closed: 0, trades: 0, w: 0, l: 0, quiet: true },
  { key: "C", label: "Gamma", market: "BANKNIFTY", running: false, open: 0, closed: 845.6, trades: 2, w: 2, l: 0 },
  { key: "D", label: "Delta", market: "CRUDE", running: true, open: -77.2, closed: 10, trades: 1, w: 1, l: 0 },
  { key: "E", label: "Eps", market: "CRUDE", offline: true },
];
const sum = (xs, f) => xs.reduce((a, x) => a + (+x[f] || 0), 0);

check("one <tbody> per market in market order, subtotal on the market row", () => {
  const c = clientCtx({});
  const out = c.dhSummary(ROWS, MK, {});
  assert.deepStrictEqual([...out.html.matchAll(/<tbody data-market="([A-Z_]+)">/g)].map((m) => m[1]), ["NIFTY", "BANKNIFTY", "CRUDE"]);
  assert.ok(/<tr class="dh-mrow"><td>NIFTY<\/td>[\s\S]*?Alpha/.test(out.html));
  assert.ok(!out.html.includes(">Beta<"), "a quiet strategy gets no line");
  assert.ok(/1 more, no trade yet today/.test(out.html));
  assert.ok(/Eps[\s\S]*?OFFLINE/.test(out.html));
});

check("market subtotals add up to the TOTAL — every column", () => {
  const c = clientCtx({});
  const out = c.dhSummary(ROWS, MK, {});
  for (const f of ["open", "closed", "trades", "w", "l"]) {
    const subs = Object.values(out.byMarket).reduce((a, s) => a + s[f], 0);
    assert.ok(Math.abs(subs - out.total[f]) < 1e-9, f);
    assert.ok(Math.abs(out.total[f] - sum(ROWS.filter((r) => !r.offline), f)) < 1e-9, f);
  }
  const grand = out.total.open + out.total.closed;
  const m = /<tr class="dh-grand"><td>TOTAL<\/td>[\s\S]*?data-label="Today total" class="[^"]*">([^<]+)</.exec(out.html);
  assert.ok(m, "TOTAL row");
  assert.strictEqual(m[1], c.dhFmtINR(grand));
  // each market row's Today total = its own open + closed
  for (const g of MK) {
    const s = out.byMarket[g.key];
    const r = new RegExp(`<tr class="dh-mrow"><td>${g.label}</td>[\\s\\S]*?data-label="Today total" class="[^"]*">([^<]+)<`).exec(out.html);
    assert.strictEqual(r[1], c.dhFmtINR(s.open + s.closed), g.key);
  }
});

check("a market filter renders only that market, and its TOTAL is that subtotal", () => {
  const c = clientCtx({});
  const out = c.dhSummary(ROWS, MK, { market: "CRUDE" });
  assert.deepStrictEqual([...out.html.matchAll(/<tbody data-market="([A-Z_]+)">/g)].map((m) => m[1]), ["CRUDE"]);
  assert.ok(Math.abs(out.total.open + out.total.closed - (-67.2)) < 1e-9);
  assert.ok(out.html.includes("TOTAL · CRUDE"));
});

check("closed-only (last session) table has no Status / Open columns", () => {
  const c = clientCtx({});
  const out = c.dhSummary(ROWS.filter((r) => !r.offline), MK, { closedOnly: true, quietText: "no trade that day" });
  assert.ok(!/<th>Status<\/th>/.test(out.html) && /<th>Net P&amp;L<\/th>/.test(out.html));
  assert.ok(/no trade that day/.test(out.html));
});

check("phone layout: rows become labelled cards, P&L green/red", () => {
  const css = ui.dashCSS();
  assert.ok(/@media \(max-width:640px\)[\s\S]*\.dh-sum thead \{ display:none; \}/.test(css));
  assert.ok(/content:attr\(data-label\)/.test(css));
  assert.ok(/\.dh-fbtn \{[^}]*min-height:44px/.test(css) && /\.dh-chip \{[^}]*min-height:44px/.test(css));
  const c = clientCtx({});
  assert.strictEqual(c.dhCls(5), "dh-pos"); assert.strictEqual(c.dhCls(-5), "dh-neg"); assert.strictEqual(c.dhCls(0.2), "dh-zero");
  assert.strictEqual(c.dhFmtINR(-1234.6), "-₹1,235");
});

// ── 4 ───────────────────────────────────────────────────────────────────────
section("4. Monitor poll in a stub DOM — hero, cards and table from /status/data");

function makeDom() {
  const els = new Map();
  const mk = (id) => {
    const cl = new Set();
    return {
      id, hidden: false, disabled: false, textContent: "", innerHTML: "", className: "", style: {}, dataset: {}, _attrs: {},
      classList: { add: (c) => cl.add(c), remove: (c) => cl.delete(c), toggle: (c, on) => { if (on === undefined ? !cl.has(c) : on) cl.add(c); else cl.delete(c); }, contains: (c) => cl.has(c) },
      setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; }, addEventListener() {},
    };
  };
  // Every id in the page exists; the card ones start hidden like the markup.
  for (const m of rtHtml.matchAll(/id="([^"]+)"/g)) els.set(m[1], mk(m[1]));
  return {
    els,
    getElementById: (id) => els.get(id) || null,
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
    createElement: () => mk("x"), body: { appendChild() {} }, documentElement: { setAttribute() {}, getAttribute() {} }, hidden: false,
  };
}

// poll() paints the hero per market, groups the table and shows only open cards.
const pollCase = (async () => {
  const rows = model.enabledRows();
  const withPos = rows[0];                     // a NIFTY home strategy holds a position
  const pairRow = rows.find((r) => r.market === "BANKNIFTY");
  const data = {};
  for (const r of rows) data[r.paperPrefix + "/status/data"] = { running: true, sessionPnl: 0, tradeCount: 0, wins: 0, losses: 0 };
  data[withPos.paperPrefix + "/status/data"] = { running: true, sessionPnl: -250, tradeCount: 2, wins: 1, losses: 1,
    unrealisedPnl: 400, position: { side: "CE", symbol: "NSE:NIFTY26NOV24000CE", entryPrice: 24000, optionEntryLtp: 100, optionCurrentLtp: 105, qty: 75, entryTime: "10:01" } };
  if (pairRow) data[pairRow.paperPrefix + "/status/data"] = { running: true, sessionPnl: 900, tradeCount: 1, wins: 1, losses: 0 };
  const doc = makeDom();
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, document: doc, window: {}, navigator: {}, location: { replace() {}, reload() {} },
    localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    fetch: async (url) => {
      if (url === "/realtime/capital") return { ok: true, json: async () => ({ pools: {}, alerts: [] }) };
      const d = data[url];
      return d ? { ok: true, json: async () => d } : { ok: false, status: 404, json: async () => null };
    },
  };
  vm.createContext(ctx);
  const code = scriptsOf(rtHtml).find((s) => s.includes("async function poll()"));
  vm.runInContext(code, ctx);
  await vm.runInContext("poll()", ctx);
  await new Promise((r) => setImmediate(r));
  const hero = doc.els.get("dh-hero-total").textContent;
  const expect = (400 - 250) + (pairRow ? 900 : 0);
  assert.strictEqual(hero, vm.runInContext(`dhFmtINR(${expect})`, ctx), "hero total");
  assert.strictEqual(doc.els.get("dh-chip-NIFTY").textContent, vm.runInContext("dhFmtINR(150)", ctx));
  if (pairRow) assert.strictEqual(doc.els.get("dh-chip-BANKNIFTY").textContent, vm.runInContext("dhFmtINR(900)", ctx));
  assert.strictEqual(doc.els.get("card-" + withPos.key).hidden, false, "the open position's card shows");
  assert.strictEqual(doc.els.get("rt-mkt-NIFTY").hidden, false);
  for (const r of rows) if (r !== withPos) assert.strictEqual(doc.els.get("card-" + r.key).hidden, true, r.key);
  assert.strictEqual(doc.els.get("exit-" + withPos.key).hidden, false, "Exit Trade shows with the position");
  assert.ok(/Entry[\s\S]*100[\s\S]*Current[\s\S]*105/.test(doc.els.get("body-" + withPos.key).innerHTML));
  const table = doc.els.get("rollup-body").innerHTML;
  assert.ok(/<tbody data-market="NIFTY">/.test(table) && /dh-grand/.test(table));
  // blocked storage → the filter falls back to All, no throw
  assert.strictEqual(vm.runInContext("dhMarket()", ctx), "ALL");
})();

// The idle Dashboard's own script: today's hero from saved trades, the
// "Last session" table from the same list (market closed — a Sunday).
const dashCase = (async () => {
  const rows = model.enabledRows();
  const nifty = rows.find((r) => r.market === "NIFTY");
  const other = rows.find((r) => r.market !== "NIFTY");
  const TODAY = "2026-11-08", PREV = "2026-11-06";
  const trades = [
    { mode: nifty.key, date: TODAY, pnl: 500 },
    { mode: other.key, date: TODAY, pnl: -200 },
    { mode: nifty.key, date: PREV, pnl: 50 },
  ];
  const doc = makeDomFrom(dashHtml);
  const RealDate = Date;
  const fixed = new RealDate("2026-11-08T06:00:00Z").getTime();   // Sun 11:30 IST — market closed
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } }
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, document: doc, window: { innerWidth: 440, addEventListener() {} }, navigator: {},
    location: { replace() {}, reload() {}, search: "" }, localStorage: { getItem: () => null, setItem() {} }, Date: FakeDate,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, getComputedStyle: () => ({}),
    fetch: async (url) => {
      if (String(url).startsWith("/consolidation/data")) return { ok: true, status: 200, json: async () => ({ trades }) };
      if (url === "/api/holidays") return { ok: true, status: 200, json: async () => ({ holidays: [] }) };
      return { ok: false, status: 404, json: async () => null };
    },
    Chart: function () { return { destroy() {} }; },
  };
  ctx.Chart.register = () => {};
  vm.createContext(ctx);
  const code = scriptsOf(dashHtml).find((s) => s.includes("function _paintHero"));
  vm.runInContext(code, ctx);   // the whole page script must run without throwing
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(doc.els.get("dh-hero-total").textContent, vm.runInContext("dhFmtINR(300)", ctx), "hero = today's closed trades");
  assert.strictEqual(doc.els.get("dh-chip-NIFTY").textContent, vm.runInContext("dhFmtINR(500)", ctx));
  assert.strictEqual(doc.els.get("dh-chip-" + other.market).textContent, vm.runInContext("dhFmtINR(-200)", ctx));
  const body = doc.els.get("da-body").innerHTML;
  assert.ok(/Last trading day · 2026-11-08/.test(body), "last session = the latest traded day");
  assert.ok(/<tbody data-market="NIFTY">/.test(body) && /dh-grand/.test(body), "last-session table grouped by market");
})();

function makeDomFrom(html) {
  const d = makeDom();
  for (const m of html.matchAll(/id="([^"]+)"/g)) if (!d.els.has(m[1])) d.els.set(m[1], makeDom().createElement());
  return d;
}

// ── 5 ───────────────────────────────────────────────────────────────────────
section("5. Market filter memory");

check("a saved market is restored; an unknown or blocked one falls back to All", () => {
  const store = { v: "CRUDE", getItem() { return this.v; }, setItem(k, v) { this.v = v; } };
  let c = clientCtx(store);
  c.dhMarketInit(["NIFTY", "CRUDE"]);
  assert.strictEqual(c.dhMarket(), "CRUDE");
  store.v = "GOLD";
  c = clientCtx(store); c.dhMarketInit(["NIFTY", "CRUDE"]);
  assert.strictEqual(c.dhMarket(), "ALL");
  c = clientCtx({ getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); } });
  c.dhMarketInit(["NIFTY", "CRUDE"]);
  assert.strictEqual(c.dhMarket(), "ALL");
});

check("npm test runs this suite", () => {
  const pkg = require(path.join(__dirname, "..", "package.json"));
  assert.ok(pkg.scripts.test.includes("node tests/dashboard.regression.js"));
});

const settle = (p, name) => p.then(() => { pass++; console.log(`  ✅ ${name}`); },
  (e) => { fail++; console.log(`  ❌ ${name}\n     ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n     ") : e}`); });
settle(pollCase, "monitor poll() → hero per market, open cards only, grouped table")
  .then(() => settle(dashCase, "dashboard script → today's hero from saved trades, last-session table by market"))
  .then(() => {
    console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

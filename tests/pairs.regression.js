/**
 * pairs.regression.js — the (strategy, market) pair model, its sidebar and its
 * Settings panes
 * ─────────────────────────────────────────────────────────────────────────────
 *   • NIFTY pairs are today's exact keys; other markets use the
 *     <MARKETPREFIX>_<ENVPREFIX> scheme (BN_ / FUT_ spellings unchanged)
 *   • non-NIFTY pairs default OFF; settings fall back to NIFTY ("Same as NIFTY")
 *   • MCX markets never offer a strategy that needs the 09:15 index open
 *   • the sidebar shows only pairs switched ON; with every pair OFF the NIFTY
 *     and STOCKS menus are exactly what they were before pairs existed
 *   • the Settings page renders the NIFTY / STOCKS strategy sections exactly as
 *     before (tests/pairs.baseline.json), plus only the new Trade days field
 *   • pair settings are GENERATED from the home section — none hand-written
 *
 *   node tests/pairs.regression.js
 *   node tests/pairs.regression.js --write-baseline <settings.html> <sidebar-settings.html> <sidebar-orbPaper.html>
 *        (rebuild the baseline from renders saved before a deliberate change)
 */

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const BASELINE = path.join(__dirname, "pairs.baseline.json");

// ── Extract structure from rendered HTML ─────────────────────────────────────
// Settings: the original strategy sections (class exactly "settings-section"),
// each with its tab titles and its data-key inputs in order, for the rail
// groups NIFTY and STOCKS.
function settingsStructure(html) {
  const railGroups = {};
  const railRe = /<div class="rail-group">([^<]+)<\/div>|data-target="([^"]+)"/g;
  let cur = null, m;
  while ((m = railRe.exec(html))) {
    if (m[1]) cur = m[1];
    else if (cur) railGroups[m[2]] = cur;
  }
  const marks = [];
  const re = /<div class="settings-section" data-section="([^"]+)">/g;
  while ((m = re.exec(html))) marks.push([m[1], m.index]);
  const end = html.indexOf('id="secNone"');
  const out = {};
  marks.forEach(([id, at], i) => {
    if (!["NIFTY", "STOCKS"].includes(railGroups[id])) return;
    const chunk = html.slice(at, i + 1 < marks.length ? marks[i + 1][1] : end);
    out[id] = {
      group: railGroups[id],
      tabs: [...chunk.matchAll(/class="tab-btn[^"]*" data-tab="\d+" onclick="showTab\(this\)">([^<]*)<span/g)].map(x => x[1]),
      keys: [...chunk.matchAll(/data-key="([^"]+)"/g)].map(x => x[1]),
    };
  });
  return out;
}

// Sidebar: every strategy group with its parent, header, open state and links.
function sidebarStructure(html) {
  const parents = [];
  const events = [];
  for (const m of html.matchAll(/<div class="sb-parent-items[^"]*" id="(nav-parent-[a-z_]+)">/g)) {
    parents.push(m[1]); events.push({ at: m.index, parent: m[1] });
  }
  const headers = {};
  for (const m of html.matchAll(/data-group="([^"]+)">\s*<span>([^<]*)<\/span>/g)) headers[m[1]] = m[2];
  const groups = [];
  for (const m of html.matchAll(/<div class="sb-group-items([^"]*)" id="([^"]+)">([\s\S]*?)<\/div>/g)) {
    const before = events.filter(e => e.at < m.index).pop();
    const gid = m[2];
    const parent = gid === "nav-dashboard" || gid === "nav-system" ? null : (before ? before.parent : null);
    const items = [...m[3].matchAll(/<a href="([^"]+)" class="sb-nav-item( active)?">\s*<span class="sb-nav-icon">[^<]*<\/span>\s*([^<\n]+)/g)]
      .map(x => [x[1], x[3].trim(), !!x[2]]);
    groups.push({ gid, header: headers[gid], parent, collapsed: /collapsed/.test(m[1]), items });
  }
  return { parents, groups };
}
const homeNav = (s) => ({
  parents: s.parents.filter(p => p === "nav-parent-nifty" || p === "nav-parent-stocks"),
  groups: s.groups.filter(g => g.parent === "nav-parent-nifty" || g.parent === "nav-parent-stocks"),
});

if (process.argv[2] === "--write-baseline") {
  const [settingsHtml, sbSettings, sbOrb] = process.argv.slice(3).map(f => fs.readFileSync(f, "utf8"));
  fs.writeFileSync(BASELINE, JSON.stringify({
    settings: settingsStructure(settingsHtml),
    sidebar: { settings: homeNav(sidebarStructure(sbSettings)), orbPaper: homeNav(sidebarStructure(sbOrb)) },
  }, null, 1) + "\n");
  console.log(`wrote ${BASELINE}`);
  process.exit(0);
}

// ── A clean, default environment ─────────────────────────────────────────────
// No .env (Settings reads <cwd>/.env), no secrets, no menu / mode toggles from
// the shell — the baseline was rendered with every toggle at its default.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pairs-regression-"));
process.chdir(SANDBOX);
for (const k of Object.keys(process.env)) {
  if (/(_MODE_ENABLED|_EXPIRY_DAY_ONLY)$|^UI_SHOW_|^(API_SECRET|LOGIN_SECRET|DEMO_)/.test(k)) delete process.env[k];
}

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}
function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); }
  finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const reg      = require("../src/config/strategyRegistry");
const markets  = require("../src/config/markets");
const pairs    = require("../src/config/pairs");
const nav      = require("../src/utils/sharedNav");
const settings = require("../src/routes/settings");
const PS = settings.pairSettings;
const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

const STRATS = reg.strategies();
const MARKETS = Object.keys(markets.MARKET_DEFS);
const MCX = MARKETS.filter(k => markets.MARKET_DEFS[k].kind === "mcx");

function renderSettings() {
  const layer = settings.stack.find(l => l.route && l.route.path === "/" && l.route.methods.get);
  let html = "";
  layer.route.stack[0].handle({ query: {}, headers: {} },
    { setHeader() {}, send(h) { html = h; }, status() { return this; }, json() {} }, () => {});
  return html;
}
function getPairSection(slug) {
  const layer = settings.stack.find(l => l.route && l.route.path === "/pair-section");
  let out = null;
  const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { out = { code: this.code, ...o }; } };
  layer.route.stack[0].handle({ query: { slug } }, res, () => {});
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
section("Pair keys");

check("NIFTY pairs are today's exact keys (env prefix, mode key, ON/OFF key and default)", () => {
  for (const s of STRATS) {
    if (s.id === "sailVwapSt") continue;
    const p = pairs.get(s.id, "NIFTY");
    assert.ok(p && p.home, `${s.id}: no home NIFTY pair`);
    assert.strictEqual(p.envPrefix, s.envPrefix);
    assert.strictEqual(p.modeKey, s.modeKey);
    assert.strictEqual(p.enabledKey, s.modeEnabled.key);
    assert.strictEqual(p.enabledDefault, s.modeEnabled.default);
    assert.strictEqual(p.expiryDayOnlyKey, `${s.envPrefix}_EXPIRY_DAY_ONLY`);
  }
});
check("SAIL_VWAP_ST: its current keys are its SAIL pair; other markets prefix it", () => {
  const p = pairs.get("sailVwapSt", "SAIL");
  assert.ok(p.home);
  assert.deepStrictEqual([p.envPrefix, p.modeKey, p.enabledKey], ["SAIL_VWAP_ST", "sail_vwap_st", "SAIL_VWAP_ST_MODE_ENABLED"]);
  assert.strictEqual(pairs.get("sailVwapSt", "NIFTY").envPrefix, "NIFTY_SAIL_VWAP_ST");
  assert.strictEqual(pairs.get("sailVwapSt", "BANKNIFTY").envPrefix, "BN_SAIL_VWAP_ST");
});
check("market prefixes: FUT_, BN_, SENSEX_, CRUDE_, GOLD_, SILVER_, SAIL_", () => {
  const want = { NIFTY_FUT: "FUT", BANKNIFTY: "BN", SENSEX: "SENSEX", CRUDE: "CRUDE", GOLD: "GOLD", SILVER: "SILVER", SAIL: "SAIL" };
  for (const [m, pre] of Object.entries(want)) {
    assert.strictEqual(pairs.marketPrefix(m), pre, m);
    const p = pairs.get("emaRsiSt", m);
    assert.strictEqual(p.envPrefix, `${pre}_EMA_RSI_ST`);
    assert.strictEqual(p.modeKey, `${pre.toLowerCase()}_ema_rsi_st`);
    assert.strictEqual(p.enabledKey, `${pre}_EMA_RSI_ST_MODE_ENABLED`);
    assert.strictEqual(p.expiryDayOnlyKey, `${pre}_EMA_RSI_ST_EXPIRY_DAY_ONLY`);
  }
});
check("the BN_ / FUT_ spellings the engines' forPrefix twins already read are unchanged", () => {
  assert.strictEqual(pairs.get("emaRsiStV2", "BANKNIFTY").envPrefix, "BN_EMA_RSI_ST_V2");
  assert.strictEqual(pairs.get("emaRsiStV2", "BANKNIFTY").modeKey, "bn_ema_rsi_st_v2");
  assert.strictEqual(pairs.get("pivotEmaSt", "BANKNIFTY").envPrefix, "BN_PIVOT_EMA_ST");
  assert.strictEqual(pairs.get("pivotEmaSt", "SAIL").envPrefix, "SAIL_PIVOT_EMA_ST");
  for (const id of ["emaRsiSt", "bbRsi", "ema9vwap", "rsiPivotSt", "stRsiPivBb", "emaRsiStV2", "pivotEmaSt"]) {
    assert.strictEqual(pairs.get(id, "NIFTY_FUT").envPrefix, `FUT_${reg.byId(id).envPrefix}`);
  }
});
check("EMA9+VWAP runs as a pair on every offered market; its pair keys inherit NIFTY's", () => {
  assert.ok(pairs.RUNS_AS_PAIR.has("ema9vwap"));
  const offered = pairs.all().filter(p => p.strategyId === "ema9vwap");
  assert.ok(offered.length > 4 && offered.every(p => p.runs), "every EMA9+VWAP pair runs (home included)");
  assert.ok(offered.some(p => p.marketKey === "CRUDE"), "EMA9+VWAP does not need the index open — MCX is offered");
  const bn = pairs.get("ema9vwap", "BANKNIFTY");
  assert.deepStrictEqual([bn.envPrefix, bn.modeKey, bn.paperPath, bn.socketMode, bn.tag, bn.broker],
    ["BN_EMA9VWAP", "bn_ema9vwap", "/bn_ema9vwap-paper", "BN_EMA9VWAP_PAPER", "BN_EMA9VWAP", "fyers"]);
  const home = pairs.get("ema9vwap", "NIFTY");
  assert.deepStrictEqual([home.envPrefix, home.paperPath, home.socketMode, home.broker], ["EMA9VWAP", "/ema9vwap-paper", "EMA9VWAP_PAPER", "zerodha"]);
  assert.strictEqual(pairs.envGet("BN_EMA9VWAP_BAND_MULT", { EMA9VWAP_BAND_MULT: "1.5" }), "1.5", "unset pair key → NIFTY's");
  assert.strictEqual(pairs.envGet("BN_EMA9VWAP_BAND_MULT", { EMA9VWAP_BAND_MULT: "1.5", BN_EMA9VWAP_BAND_MULT: "2" }), "2");
  assert.strictEqual(pairs.envGet("SENSEX_EMA9VWAP_BAND_MULT", { BN_EMA9VWAP_BAND_MULT: "2" }), undefined, "no leak across pairs");
  assert.strictEqual(pairs.byReplayMode("fut_ema9vwap-paper").marketKey, "NIFTY_FUT");
});
check("every non-NIFTY pair defaults OFF", () => {
  for (const p of pairs.all().filter(p => !p.home)) {
    assert.strictEqual(p.enabledDefault, "false", p.id);
    assert.strictEqual(pairs.isEnabled(p, {}), false, p.id);
  }
  assert.strictEqual(pairs.isEnabled(pairs.get("orb", "BANKNIFTY"), { BN_ORB_MODE_ENABLED: "true" }), true);
});
check("MCX markets never offer a needsIndexOpen strategy; every other market offers all 18", () => {
  for (const m of MCX) {
    const ids = pairs.forMarket(m).map(p => p.strategyId);
    for (const s of STRATS) assert.strictEqual(ids.includes(s.id), !s.needsIndexOpen, `${m} / ${s.id}`);
    assert.ok(ids.length > 0 && ids.length < STRATS.length);
  }
  for (const m of MARKETS.filter(k => !MCX.includes(k))) assert.strictEqual(pairs.forMarket(m).length, STRATS.length, m);
});
check("the GAP_RUNAWAY stock scanner (a tool) is never paired", () => {
  assert.ok(!pairs.all().some(p => p.strategyId === "gapRunawayStk"));
  assert.strictEqual(pairs.get("gapRunawayStk", "SAIL"), null);
});
check("pair env prefixes, mode keys, ON/OFF keys and slugs are unique; none reuses another strategy's key", () => {
  const all = pairs.all();
  for (const f of [p => p.envPrefix, p => p.modeKey, p => p.enabledKey, p => p.slug, p => p.id]) {
    const v = all.map(f);
    assert.deepStrictEqual(v.filter((x, i) => v.indexOf(x) !== i), []);
  }
  const homePrefixes = new Set(reg.all().map(s => s.envPrefix));
  for (const p of all.filter(p => !p.home)) assert.ok(!homePrefixes.has(p.envPrefix), p.envPrefix);
});

// ─────────────────────────────────────────────────────────────────────────────
section("Setting lookup — Same as NIFTY");

check("an unset pair key falls back to the NIFTY value, then to the schema default", () => {
  const p = pairs.get("orb", "BANKNIFTY");
  let r = pairs.resolve(p, "ORB_ST_MULT", { ORB_ST_MULT: "3.5" }, "3");
  assert.deepStrictEqual([r.key, r.value, r.inherited], ["BN_ORB_ST_MULT", "3.5", true]);
  r = pairs.resolve(p, "ORB_ST_MULT", {}, "3");
  assert.deepStrictEqual([r.value, r.inherited], ["3", true]);
  r = pairs.resolve(p, "ORB_ST_MULT", { ORB_ST_MULT: "3.5", BN_ORB_ST_MULT: "4" }, "3");
  assert.deepStrictEqual([r.value, r.own, r.inherited], ["4", true, false]);
  r = pairs.resolve(p, "ORB_ST_MULT", { ORB_ST_MULT: "3.5", BN_ORB_ST_MULT: "" }, "3");
  assert.strictEqual(r.value, "3.5", "an empty pair value means unset");
});
check("shared keys are not per pair; EMA_RSI_ST maps its legacy TRADE_* keys", () => {
  const p = pairs.get("emaRsiSt", "BANKNIFTY");
  assert.strictEqual(pairs.pairKey(p, "VIX_MAX_ENTRY"), null);
  assert.strictEqual(pairs.pairKey(p, "RSI_CE_MIN"), null);
  assert.strictEqual(pairs.pairKey(p, "TRADE_EXPIRY_DAY_ONLY"), null, "the shared TRADE_EXPIRY_DAY_ONLY stays global");
  assert.strictEqual(pairs.pairKey(p, "TRADE_ENTRY_START"), "BN_EMA_RSI_ST_ENTRY_START");
  assert.strictEqual(pairs.pairKey(p, "EMA_RSI_ST_EMA_FAST"), "BN_EMA_RSI_ST_EMA_FAST");
  assert.strictEqual(pairs.pairKey(pairs.get("emaRsiSt", "NIFTY"), "EMA_RSI_ST_EMA_FAST"), "EMA_RSI_ST_EMA_FAST");
});

// ─────────────────────────────────────────────────────────────────────────────
section("Generated pair settings");

check("every strategy's home section has its Trade days key; ORB / PA / BB_RSI keep their own toggle", () => {
  for (const s of STRATS) {
    const sec = PS.homeSectionOf(s.id);
    assert.ok(sec, `${s.id}: no home section`);
    const f = sec.fields.find(x => x.key === `${s.envPrefix}_EXPIRY_DAY_ONLY`);
    assert.ok(f, `${s.id}: no ${s.envPrefix}_EXPIRY_DAY_ONLY`);
    if (["orb", "pa", "bbRsi"].includes(s.id)) assert.strictEqual(f.type, "toggle", s.id);
    else assert.deepStrictEqual([f.type, f.default, f.generated], ["select", "false", "tradeDays"], s.id);
  }
});
check("pair fields are generated from the home section (one per own key), grouped in the five groups", () => {
  for (const p of pairs.all().filter(p => !p.home)) {
    const { section: sec, fields: allFields, shared } = PS.pairFieldsFor(p);
    // A running pair adds its own pair-only fields (no NIFTY twin) — checked below.
    const fields = allFields.filter(f => !f.pairOnly);
    const own = sec.fields.filter(f => pairs.pairKey(p, f.key) && !/_LIVE_|_POS_FILE$/.test(f.key));
    assert.strictEqual(fields.length, own.length, p.id);
    assert.strictEqual(fields.length + shared.length + (sec.fields.length - own.length - shared.length), sec.fields.length);
    for (const f of fields) {
      assert.strictEqual(f.key, pairs.pairKey(p, f.homeKey));
      assert.ok(PS.PAIR_GROUPS.includes(f.group), `${f.key}: group ${f.group}`);
    }
    const td = fields.filter(f => f.group === "Trade days");
    assert.deepStrictEqual(td.map(f => f.key), [p.expiryDayOnlyKey], `${p.id}: Trade days`);
    assert.strictEqual(td[0].type, "select");
  }
});
check("a running pair's pane adds exactly its fill-at-quote and spread-limit keys; other pairs add none", () => {
  for (const p of pairs.all().filter(p => !p.home)) {
    const extra = PS.pairFieldsFor(p).fields.filter(f => f.pairOnly).map(f => f.key);
    assert.deepStrictEqual(extra, p.runs ? [`${p.envPrefix}_PAPER_FILL_AT_QUOTE`, `${p.envPrefix}_MAX_SPREAD_PTS`] : [], p.id);
  }
  withEnv({ MAX_BID_ASK_SPREAD_PTS: "3" }, () => {
    const html = PS.renderPairSection(pairs.get("emaRsiStV2", "SENSEX"), { ...process.env });
    const row = html.split('<div class="setting-row pair-row').find(r => r.includes('data-key="SENSEX_EMA_RSI_ST_V2_MAX_SPREAD_PTS"'));
    assert.ok(row && row.includes("Common limit (<b>3</b>)"), "spread limit shows the common limit");
    const fill = html.split('<div class="setting-row pair-row').find(r => r.includes('data-key="SENSEX_EMA_RSI_ST_V2_PAPER_FILL_AT_QUOTE"'));
    assert.ok(fill && fill.includes("Default (<b>On</b>)") && /data-key="SENSEX_EMA_RSI_ST_V2_PAPER_FILL_AT_QUOTE" checked/.test(fill), "fill-at-quote defaults ON");
  });
});
check("no market-pair field is hand-written in the Settings schema", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/routes/settings.js"), "utf8");
  const literal = new Set([...src.matchAll(/\{\s*key:\s*"([A-Z0-9_]+)"/g)].map(m => m[1]));
  const hand = [];
  for (const p of pairs.all().filter(p => !p.home)) {
    if (literal.has(p.enabledKey)) hand.push(p.enabledKey);
    for (const f of PS.pairFieldsFor(p).fields) if (literal.has(f.key)) hand.push(f.key);
  }
  assert.deepStrictEqual(hand, []);
});
check("a pair pane shows 'Same as NIFTY (value)' until changed, then highlights the change", () => {
  withEnv({ ORB_ST_MULT: "3.5" }, () => {
    const html = PS.renderPairSection(pairs.get("orb", "BANKNIFTY"), { ...process.env });
    const row = html.split('<div class="setting-row pair-row').find(r => r.includes('data-key="BN_ORB_ST_MULT"'));
    assert.ok(/data-own="0" data-state="same"/.test(row), "unset → same");
    assert.ok(row.includes("Same as NIFTY (<b>3.5</b>)"));
    assert.ok(/data-key="BN_ORB_ST_MULT" value="3.5"/.test(row));
  });
  withEnv({ ORB_ST_MULT: "3.5", BN_ORB_ST_MULT: "4" }, () => {
    const html = PS.renderPairSection(pairs.get("orb", "BANKNIFTY"), { ...process.env });
    const row = html.split('<div class="setting-row pair-row').find(r => r.includes('data-key="BN_ORB_ST_MULT"'));
    assert.ok(/^ pair-own" data-own="1" data-state="own"/.test(row), "own → highlighted");
    assert.ok(/data-key="BN_ORB_ST_MULT" value="4"/.test(row));
    assert.ok(row.includes("Reset to NIFTY"));
    assert.ok(/<span data-pair-own-count>1<\/span> changed from NIFTY/.test(html));
  });
});
check("points fields carry a check-for-this-market note; a SAIL_VWAP_ST pair says Same as SAIL", () => {
  const html = PS.renderPairSection(pairs.get("pa", "BANKNIFTY"), { ...process.env });
  const row = html.split('<div class="setting-row pair-row').find(r => r.includes('data-key="BN_PA_MAX_SL_PTS"'));
  assert.ok(row && row.includes("pair-pts"), "PA Max Stop (pts) has the points note");
  const sail = PS.renderPairSection(pairs.get("sailVwapSt", "NIFTY"), { ...process.env });
  assert.ok(sail.includes("Same as SAIL ("));
});
check("GET /settings/pair-section serves a non-home pair only", () => {
  const ok = getPairSection("bn-orb");
  assert.strictEqual(ok.code, 200);
  assert.ok(ok.success && ok.html.includes('data-section="pair-bn-orb"'));
  assert.strictEqual(getPairSection("orb").code, 404, "a home pair has no generated pane");
  assert.strictEqual(getPairSection("nope").code, 404);
});

// ─────────────────────────────────────────────────────────────────────────────
section("Sidebar");

check("with every pair OFF the NIFTY and STOCKS menus are unchanged", () => {
  const a = sidebarStructure(nav.buildSidebar("settings", false));
  const b = sidebarStructure(nav.buildSidebar("orbPaper", false));
  assert.deepStrictEqual(homeNav(a), baseline.sidebar.settings);
  assert.deepStrictEqual(homeNav(b), baseline.sidebar.orbPaper);
  assert.deepStrictEqual(a.parents, ["nav-parent-nifty", "nav-parent-stocks"], "no other market shows");
});
check("a pair switched ON appears under its market; the rest stay hidden; NIFTY is untouched", () => {
  withEnv({ BN_ORB_MODE_ENABLED: "true", SAIL_PA_MODE_ENABLED: "true", CRUDE_BB_RSI_MODE_ENABLED: "true" }, () => {
    const s = sidebarStructure(nav.buildSidebar("orbPaper", false));
    assert.deepStrictEqual(s.parents, ["nav-parent-nifty", "nav-parent-banknifty", "nav-parent-crude", "nav-parent-stocks"]);
    const bn = s.groups.filter(g => g.parent === "nav-parent-banknifty");
    assert.deepStrictEqual(bn.map(g => [g.header, g.items.map(i => i[0])]), [["ORB", ["/settings#pair-bn-orb"]]]);
    const crude = s.groups.filter(g => g.parent === "nav-parent-crude");
    assert.deepStrictEqual(crude.map(g => g.header), ["BB_RSI"]);
    const stocks = s.groups.filter(g => g.parent === "nav-parent-stocks").map(g => g.header);
    assert.ok(stocks.includes("SAIL · PRICE ACTION"), stocks.join(", "));
    assert.ok(stocks.includes("GAP_RUNAWAY SCANNER"), "STOCKS keeps the gap-runaway scanner");
    assert.deepStrictEqual(s.groups.filter(g => g.parent === "nav-parent-nifty"),
      baseline.sidebar.orbPaper.groups.filter(g => g.parent === "nav-parent-nifty"));
  });
});
check("a RUNNING pair switched ON links its real Paper / History pages (and opens on them)", () => {
  withEnv({ SENSEX_EMA_RSI_ST_V2_MODE_ENABLED: "true" }, () => {
    const s = sidebarStructure(nav.buildSidebar("pair:sensex_ema_rsi_st_v2:paper", false));
    const g = s.groups.filter(g => g.parent === "nav-parent-sensex");
    assert.deepStrictEqual(g.map(x => [x.header, x.items.map(i => i[0])]),
      [["EMA_RSI_ST_V2", ["/sensex_ema_rsi_st_v2-paper/status", "/sensex_ema_rsi_st_v2-paper/history", "/settings#pair-sensex-ema-rsi-st-v2"]]]);
    assert.strictEqual(g[0].collapsed, false, "the active pair's group is open");
    assert.ok(g[0].items[0][2], "its Paper page is the active item");
  });
});
check("an MCX market never lists a needsIndexOpen strategy, even when its key is set", () => {
  withEnv({ CRUDE_ORB_MODE_ENABLED: "true" }, () => {
    const s = sidebarStructure(nav.buildSidebar("dashboard", false));
    assert.ok(!s.parents.includes("nav-parent-crude"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
section("Settings page");

const html = renderSettings();

check("NIFTY / STOCKS strategy sections render as before — only the Trade days field is new", () => {
  const now = settingsStructure(html);
  assert.deepStrictEqual(Object.keys(now).sort(), Object.keys(baseline.settings).sort(), "same sections on screen");
  for (const [id, was] of Object.entries(baseline.settings)) {
    const cur = now[id];
    const added = cur.keys.filter(k => !was.keys.includes(k));
    for (const k of added) assert.ok(/_EXPIRY_DAY_ONLY$/.test(k), `${id}: unexpected new key ${k}`);
    assert.deepStrictEqual(cur.keys.filter(k => !added.includes(k)), was.keys, `${id}: keys / order changed`);
    if (added.length) {
      assert.deepStrictEqual(cur.keys.slice(-added.length), added, `${id}: Trade days is appended last`);
      assert.deepStrictEqual(cur.tabs, [...was.tabs, "Trade days"], `${id}: tabs`);
    } else {
      assert.deepStrictEqual(cur.tabs, was.tabs, `${id}: tabs`);
    }
  }
});
check("market picker: one chip per market, one strategy list per market", () => {
  for (const k of MARKETS) {
    assert.ok(html.includes(`class="mk-chip" data-market="${k}"`), `chip ${k}`);
    assert.ok(html.includes(`data-section="market-${k}"`), `pane ${k}`);
  }
});
check("each strategy list has every offered pair with its ON/OFF switch (MCX without needsIndexOpen ones)", () => {
  for (const k of MARKETS) {
    const start = html.indexOf(`data-section="market-${k}"`);
    const chunk = html.slice(start, html.indexOf('<div class="settings-section', start + 10));
    const keys = [...chunk.matchAll(/data-(?:key|proxy-for)="([A-Z0-9_]+_MODE_ENABLED)"/g)].map(m => m[1]);
    assert.deepStrictEqual(keys, pairs.forMarket(k).map(p => p.enabledKey), k);
  }
  // A home pair's switch proxies its Menu Visibility field: one input per key.
  for (const s of STRATS) {
    const n = (html.match(new RegExp(`data-key="${s.modeEnabled.key}"`, "g")) || []).length;
    assert.strictEqual(n, 1, `${s.modeEnabled.key} inputs`);
  }
});
check("every pair's ON/OFF key is in Settings (no sidebar item without a Settings toggle)", () => {
  for (const p of pairs.all()) assert.ok(html.includes(`"${p.enabledKey}"`), p.enabledKey);
});
check("the page's inline scripts compile", () => {
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) new Function(m[1]);
});

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
// Required modules hold timers (holiday cache, loggers); don't wait on them.
process.exit(fail ? 1 : 0);

/**
 * strategyRegistry.regression.js — the ONE strategy list stays true to the code
 * ─────────────────────────────────────────────────────────────────────────────
 * src/config/strategyRegistry.js feeds the shared rosters (sidebar roster,
 * loggers, report pages, replay, shutdown, common trade window, …). These
 * checks keep it honest:
 *
 *   • every module it names resolves; ids / keys / mode keys / env prefixes /
 *     socket modes are unique
 *   • every strategy route mounted in app.js is in the registry, and vice versa
 *   • its facts agree with the code that still keeps its own copy (Settings
 *     schema, sharedSocketState, capitalPool, realtime, consolidation)
 *   • the shared lists really are derived from it
 *
 *   node tests/strategyRegistry.regression.js
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const SRC = path.join(__dirname, "../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

const reg = require("../src/config/strategyRegistry");
const ALL = reg.all();
const ids = (list) => list.map(e => e.id);

// ─────────────────────────────────────────────────────────────────────────────
section("Shape");

check("18 strategies + the GAP_RUNAWAY stock scanner tool", () => {
  assert.strictEqual(reg.strategies().length, 18);
  assert.deepStrictEqual(ids(ALL.filter(e => e.kind === "tool")), ["gapRunawayStk"]);
  for (const e of ALL) assert.ok(["strategy", "tool"].includes(e.kind), `${e.id}: kind ${e.kind}`);
});
check("ids, keys, mode keys, env prefixes, socket modes, paper paths, trade files are unique", () => {
  for (const f of [e => e.id, e => e.key, e => e.modeKey, e => e.envPrefix, e => e.socket.mode,
                   e => e.paper.path, e => e.tradesFile, e => e.nav.groupId, e => e.modeEnabled.key]) {
    const vals = ALL.map(f);
    const dup = vals.filter((v, i) => vals.indexOf(v) !== i);
    assert.deepStrictEqual(dup, [], `duplicates: ${dup.join(", ")}`);
  }
});
check("every entry carries every field", () => {
  const req = ["id", "kind", "key", "label", "modeKey", "envPrefix", "modeEnabled", "paperEnabled", "paper",
               "backtest", "engine", "broker", "socket", "needsIndexOpen", "telegram", "nav", "commonWindow",
               "tradesFile", "replay"];
  for (const e of ALL) for (const k of req) assert.ok(k in e, `${e.id}: no ${k}`);
});
check("value formats: keys, defaults, brokers, file names", () => {
  for (const e of ALL) {
    assert.ok(/^[A-Z0-9_]+$/.test(e.key) && /^[A-Z0-9_]+$/.test(e.envPrefix), e.id);
    assert.ok(/^[a-z0-9_]+$/.test(e.modeKey), e.id);
    assert.strictEqual(e.modeEnabled.key, `${e.key}_MODE_ENABLED`, e.id);
    assert.ok(["true", "false"].includes(e.modeEnabled.default), e.id);
    if (e.paperEnabled) {
      assert.strictEqual(e.paperEnabled.key, `${e.key}_PAPER_ENABLED`, e.id);
      assert.ok(["true", "false"].includes(e.paperEnabled.default), e.id);
    }
    assert.ok(["zerodha", "fyers"].includes(e.broker), e.id);
    assert.strictEqual(e.tradesFile, `${e.modeKey}_paper_trades.json`, e.id);
    assert.ok(/^\/[a-z0-9_-]+-paper$/.test(e.paper.path), e.id);
    if (e.backtest) assert.ok(/^\/[a-z0-9_-]+-backtest$/.test(e.backtest.path), e.id);
    assert.ok(/_PAPER$/.test(e.socket.mode), e.id);
    assert.strictEqual(typeof e.needsIndexOpen, "boolean", e.id);
    assert.strictEqual(typeof e.replay, "boolean", e.id);
  }
});
check("the registry is frozen (a consumer cannot edit it for everyone)", () => {
  assert.ok(Object.isFrozen(ALL) && Object.isFrozen(ALL[0]) && Object.isFrozen(ALL[0].paper));
  assert.ok(Object.isFrozen(reg.ORDERS.logs));
});
check("lookups", () => {
  assert.strictEqual(reg.byId("trendDayScalp").key, "TDS");
  assert.strictEqual(reg.byKey("EARLYBIRD").modeKey, "early_bird");
  assert.strictEqual(reg.byModeKey("ema_rsi_st_v2").id, "emaRsiStV2");
  assert.strictEqual(reg.bySocketMode("EARLY_BIRD_PAPER").id, "earlyBird");
  assert.strictEqual(reg.byId("nope"), null);
  assert.throws(() => reg.inOrder("nope"));
});

// ─────────────────────────────────────────────────────────────────────────────
section("Modules resolve");

check("paper / backtest / extra route modules and engines resolve", () => {
  for (const e of ALL) {
    const mods = [e.paper.module, e.engine, ...(e.backtest ? [e.backtest.module] : []),
                  ...(e.extraRoutes || []).map(r => r.module)];
    for (const m of mods) assert.ok(require.resolve(reg.srcPath(m)), `${e.id}: ${m}`);
  }
});
check("the paper module is routes/<id>Paper, the backtest routes/<id>Backtest", () => {
  for (const e of ALL) {
    assert.strictEqual(e.paper.module, `routes/${e.id}Paper`, e.id);
    if (e.backtest) assert.strictEqual(e.backtest.module, `routes/${e.id}Backtest`, e.id);
  }
});
check("each paper route requires the engine the registry names", () => {
  for (const e of ALL) {
    const src = read(e.paper.module + ".js");
    const direct = src.includes(`require("../${e.engine}")`);
    // EMA_RSI_ST reads its engine through strategies/index.js (getActiveStrategy).
    const viaIndex = e.engine === "strategies/strategy1_sar_ema_rsi" && src.includes('require("../strategies")')
      && /require\("\.\/strategy1_sar_ema_rsi"\)/.test(read("strategies/index.js"));
    assert.ok(direct || viaIndex, `${e.paper.module} does not require ${e.engine}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section("app.js mounts ⇔ registry");

const appSrc = decomment(read("app.js"));
const paperMounts = new Map([...appSrc.matchAll(/app\.use\("(\/[^"]+-paper)",\s*require\("\.\/(routes\/\w+)"\)\)/g)]
  .map(m => [m[1], m[2]]));
const backtestMounts = new Map([...appSrc.matchAll(/app\.use\("(\/[^"]+-backtest)",\s*lazyRouter\(\(\)\s*=>\s*require\("\.\/(routes\/\w+)"\)\)\)/g)]
  .map(m => [m[1], m[2]]));
const NON_STRATEGY_BACKTEST = new Set(["/all-backtest"]);   // the unified dashboard

check("every mounted -paper route is a registry entry, with the same module", () => {
  assert.ok(paperMounts.size >= 19, `only ${paperMounts.size} paper mounts parsed`);
  for (const [p, mod] of paperMounts) {
    const e = ALL.find(x => x.paper.path === p);
    assert.ok(e, `${p} is mounted but not in the registry`);
    assert.strictEqual(e.paper.module, mod, p);
  }
});
check("every registry paper route is mounted", () => {
  for (const e of ALL) assert.strictEqual(paperMounts.get(e.paper.path), e.paper.module, `${e.paper.path} not mounted`);
});
check("every mounted -backtest route is a registry backtest/extra route, and vice versa", () => {
  const known = new Map();
  for (const e of ALL) for (const r of [e.backtest, ...(e.extraRoutes || [])].filter(Boolean)) known.set(r.path, r.module);
  for (const [p, mod] of backtestMounts) {
    if (NON_STRATEGY_BACKTEST.has(p)) continue;
    assert.strictEqual(known.get(p), mod, `${p} mounted with ${mod}`);
  }
  for (const [p, mod] of known) assert.strictEqual(backtestMounts.get(p), mod, `${p} not mounted`);
});

// ─────────────────────────────────────────────────────────────────────────────
section("Orders");

check("ORDERS.logs and ORDERS.reports list every entry exactly once", () => {
  for (const name of ["logs", "reports"]) {
    assert.deepStrictEqual([...reg.ORDERS[name]].sort(), ids(ALL).sort(), name);
  }
});
check("ORDERS.replay lists exactly the replayable entries", () => {
  assert.deepStrictEqual([...reg.ORDERS.replay].sort(), ids(ALL.filter(e => e.replay)).sort());
});
check("nav.order is 0..n-1, each groupId + header is a sidebar group in that order", () => {
  assert.deepStrictEqual(ALL.map(e => e.nav.order).sort((a, b) => a - b), ALL.map((_, i) => i));
  const nav = read("utils/sharedNav.js");
  const byOrder = [...ALL].sort((a, b) => a.nav.order - b.nav.order);
  let last = -1;
  for (const e of byOrder) {
    const re = new RegExp(`header: '${e.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}',[^\\n]*\\n\\s*groupId: '${e.nav.groupId}'`);
    const m = re.exec(nav);
    assert.ok(m, `${e.id}: no sidebar group '${e.label}' / ${e.nav.groupId}`);
    assert.ok(m.index > last, `${e.id}: sidebar group is out of nav.order`);
    last = m.index;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section("Facts agree with the code that keeps its own copy");

const settingsSrc = read("routes/settings.js");
const settingDefault = (key) => {
  const m = new RegExp(`key: "${key}",[^\\n]*?default: "([a-z]+)"`).exec(settingsSrc);
  return m ? m[1] : null;
};
check("MODE_ENABLED / PAPER_ENABLED keys and defaults match the Settings schema", () => {
  for (const e of ALL) {
    assert.strictEqual(settingDefault(e.modeEnabled.key), e.modeEnabled.default, e.modeEnabled.key);
    if (e.paperEnabled) assert.strictEqual(settingDefault(e.paperEnabled.key), e.paperEnabled.default, e.paperEnabled.key);
  }
});
check("no strategy has a *_PAPER_ENABLED Settings key the registry does not know", () => {
  for (const e of ALL.filter(x => !x.paperEnabled)) {
    assert.strictEqual(settingDefault(`${e.key}_PAPER_ENABLED`), null, `${e.key}_PAPER_ENABLED`);
  }
});
check("every Telegram key is a Settings toggle", () => {
  for (const e of ALL) {
    for (const k of ["started", "entry", "exit", "dayReport"]) assert.ok(e.telegram[k], `${e.id}: no telegram.${k}`);
    for (const v of Object.values(e.telegram)) {
      assert.ok(v.startsWith(`TG_${e.key}_`), v);
      assert.ok(settingsSrc.includes(`key: "${v}"`), `${v} is not in the Settings schema`);
    }
  }
});
check("sharedSocketState has every slot function, and the slot starts idle", () => {
  const sss = require("../src/utils/sharedSocketState");
  for (const e of ALL) {
    for (const fn of ["set", "clear", "isActive", "get"]) {
      assert.strictEqual(typeof sss[e.socket[fn]], "function", `${e.id}: sharedSocketState.${e.socket[fn]}`);
    }
    assert.ok(sss.canStart(e.socket.mode, { reserve: false }).allowed, `${e.socket.mode} unknown to canStart`);
    sss[e.socket.set](e.socket.mode);
    try {
      assert.strictEqual(sss[e.socket.get](), e.socket.mode);
      assert.ok(sss[e.socket.isActive]());
      assert.ok(!sss.canStart(e.socket.mode, { reserve: false }).allowed, `${e.socket.mode} not exclusive`);
    } finally { sss[e.socket.clear](); }
    assert.ok(!sss[e.socket.isActive](), `${e.id}: ${e.socket.clear} did not clear`);
  }
  assert.ok(!sss.isAnyActive());
});
check("capitalPool routes every mode key to the registry broker and trades file", () => {
  const cp = decomment(read("utils/capitalPool.js"));
  for (const e of ALL) {
    const m = new RegExp(`\\b${e.modeKey}:\\s*\\{\\s*broker:\\s*"([a-z]+)",[^}]*file:\\s*"([^"]+)"`).exec(cp);
    assert.ok(m, `no ${e.modeKey} row in capitalPool.STRATEGIES`);
    assert.strictEqual(m[1], e.broker, e.modeKey);
    assert.strictEqual(m[2], e.tradesFile, e.modeKey);
  }
});
check("realtime STRATEGY_DEFS: same keys, paper prefixes and mode flags", () => {
  const rt = decomment(read("routes/realtime.js"));
  const rows = [...rt.matchAll(/\{ key:'([A-Z0-9_]+)',[^\n]*paperPrefix:'([^']+)'[^\n]*modeFlag:'([A-Z0-9_]+)'/g)];
  assert.deepStrictEqual(rows.map(r => r[1]).sort(), ALL.map(e => e.key).sort());
  for (const [, key, prefix, flag] of rows) {
    const e = reg.byKey(key);
    assert.strictEqual(prefix, e.paper.path, key);
    assert.strictEqual(flag, e.modeEnabled.key, key);
  }
});
check("consolidation SOURCES: same modes and files, in ORDERS.reports order", () => {
  const c = decomment(read("routes/consolidation.js"));
  const rows = [...c.matchAll(/\{ mode: "([A-Z0-9_]+)",\s*file: path\.join\(DATA_DIR, "([^"]+)"\)/g)].map(m => [m[1], m[2]]);
  assert.deepStrictEqual(rows, reg.inOrder("reports").map(e => [e.key, e.tradesFile]));
});
check("portfolioRisk PAPER_MODES are all registry mode keys", () => {
  const { PAPER_MODES } = require("../src/utils/portfolioRisk");
  for (const m of PAPER_MODES) assert.ok(reg.byModeKey(m), m);
});
check("commonWindow keys are real Settings keys", () => {
  for (const e of ALL) for (const k of [e.commonWindow.start, e.commonWindow.end].filter(Boolean)) {
    assert.ok(settingsSrc.includes(`key: "${k}"`), `${e.id}: ${k} is not in the Settings schema`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section("Shared lists are derived from the registry");

check("sharedNav STRATEGY_MODES = registry roster", () => {
  const { STRATEGY_MODES } = require("../src/utils/sharedNav");
  assert.deepStrictEqual(STRATEGY_MODES.map(r => r.mode), ALL.map(e => e.key));
  assert.deepStrictEqual(STRATEGY_MODES.map(r => r.envKey), ALL.map(e => e.modeEnabled.key));
  assert.deepStrictEqual(STRATEGY_MODES.filter(r => r.slug).map(r => [r.mode, r.slug]), [["TDS", "trend-day-scalp"]]);
  assert.deepStrictEqual(STRATEGY_MODES.filter(r => r.envDefault === "false").map(r => r.mode),
    ["EMA_RSI_ST_V2", "ST_RSI_PIV_BB", "SAIL_VWAP_ST"]);
  assert.deepStrictEqual(STRATEGY_MODES.filter(r => r.paperDefault).map(r => r.mode),
    ["EMA_RSI_ST_V2", "ST_RSI_PIV_BB", "SAIL_VWAP_ST"]);
});
check("tradeLogger / skipLogger maps cover every mode key, in ORDERS.logs order", () => {
  const tl = require("../src/utils/tradeLogger");
  const sl = require("../src/utils/skipLogger");
  const want = reg.inOrder("logs").map(e => e.modeKey);
  assert.deepStrictEqual(Object.keys(tl.FILE_BY_MODE), want);
  assert.deepStrictEqual(Object.keys(tl.DAILY_PREFIX_BY_MODE), want);
  assert.deepStrictEqual(Object.keys(sl.FILE_PREFIX_BY_MODE), want);
  assert.strictEqual(tl.FILE_BY_MODE.early_bird, "early_bird_paper_trades_log.jsonl");
  assert.strictEqual(tl.DAILY_PREFIX_BY_MODE.trend_day_scalp, "trend_day_scalp_paper_trades_");
  assert.strictEqual(sl.FILE_PREFIX_BY_MODE.gap_runaway_stk, "gap_runaway_stk_paper_skips_");
});
check("tickReplay replays exactly the replayable entries", () => {
  const { _internals } = require("../src/services/tickReplay");
  const want = reg.inOrder("replay");
  assert.deepStrictEqual(Object.entries(_internals.MODE_TO_MODULE),
    want.map(e => [e.paper.path.slice(1), "../" + e.paper.module]));
  assert.deepStrictEqual(Object.entries(_internals._MODE_TO_CANONICAL_FILE),
    want.map(e => [e.paper.path.slice(1), e.tradesFile]));
});
check("commonTradeWindow overrides exactly the registry commonWindow keys", () => {
  const src = read("utils/commonTradeWindow.js");
  assert.ok(/strategyRegistry/.test(src), "commonTradeWindow no longer reads the registry");
  const ctw = require("../src/utils/commonTradeWindow");
  const keys = ALL.flatMap(e => [e.commonWindow.start, e.commonWindow.end]).filter(Boolean);
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const restore = () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const prev = process.env.COMMON_TRADE_WINDOW_ENABLED;
  const prevOrbEnd = process.env.ORB_ENTRY_END;
  try {
    for (const k of keys) process.env[k] = "09:20";
    process.env.ORB_ENTRY_END = "10:15";
    process.env.COMMON_TRADE_WINDOW_ENABLED = "true";
    ctw.apply();
    for (const e of ALL) {
      if (e.commonWindow.start) assert.strictEqual(process.env[e.commonWindow.start], ctw.ENTRY_START, e.commonWindow.start);
      if (e.commonWindow.end) assert.strictEqual(process.env[e.commonWindow.end], ctw.ENTRY_END, e.commonWindow.end);
    }
    assert.strictEqual(process.env.ORB_ENTRY_END, "10:15", "ORB keeps its own entry cut-off");
    process.env.COMMON_TRADE_WINDOW_ENABLED = "false";
    ctw.apply();
    for (const k of keys) assert.strictEqual(process.env[k], "09:20", `${k}: own value not restored`);
  } finally {
    if (prev === undefined) delete process.env.COMMON_TRADE_WINDOW_ENABLED; else process.env.COMMON_TRADE_WINDOW_ENABLED = prev;
    if (prevOrbEnd === undefined) delete process.env.ORB_ENTRY_END; else process.env.ORB_ENTRY_END = prevOrbEnd;
    restore();
  }
});

console.log(`\nSTRATEGY REGISTRY: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

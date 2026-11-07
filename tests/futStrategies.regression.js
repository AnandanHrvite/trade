#!/usr/bin/env node
/**
 * FUT_* TWIN WIRING INVARIANTS — seven NIFTY-futures strategies, wired like their originals
 *
 *   node tests/futStrategies.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. No socket, no
 * broker, no session: HOME is pointed at a temp dir BEFORE anything is required,
 * so nothing here can touch the real ~/trading-data.
 *
 * Each twin is an options strategy's rules forced onto the NIFTY future (CE signal
 * = LONG, PE = SHORT) with its OWN FUT_-prefixed settings and its own state. A
 * twin is only useful if it is wired everywhere its original is — and only safe
 * if it is wired SEPARATELY: a twin that reads one of its original's keys, shares
 * its mutex slot, writes its trade file or fires on its Telegram toggles is the
 * options strategy wearing a futures label. Each group below pins one of those
 * seams, for every twin, in both directions (FUT change ⇏ options change, and
 * options change ⇏ FUT change).
 *
 * The twin table is the contract other files were wired against (the creation
 * manifests). `envKeys` is every FUT_ key the twin reads.
 */

process.env.TZ = "Asia/Calcutta";
const os   = require("os");
const fs   = require("fs");
const path = require("path");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fut-twins-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const assert = require("assert");
const Module = require("module");

const SRC    = path.join(__dirname, "../src");
const ROUTES = path.join(SRC, "routes");
const read   = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");
// Prose that merely mentions code is not code: whole-line comments, inline
// `/* … */` and trailing ` // …` are dropped before any source assertion.
const codeOf = (s) => s.split("\n")
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map(l => l.replace(/\/\*.*?\*\//g, "").replace(/(^|\s)\/\/\s.*$/, "$1"))
  .join("\n");

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

// ── The twins ────────────────────────────────────────────────────────────────
// prefix      = env prefix (no trailing "_") = notify group = sharedNav mode.
// orig        = the original's env prefix / notify group.
// mode        = lowercase key for tradeLogger / skipLogger / capitalPool.
// ss / origSs = sharedSocketState functions and canStart mode strings.
// engine      = how the twin binds the shared engine: "forPrefix" (a bound copy)
//               or "arg" (every call passes PREFIX).
const TWINS = [
  {
    prefix: "FUT_EMA_RSI_ST", orig: "EMA_RSI_ST", mode: "fut_ema_rsi_st", origMode: "ema_rsi_st", broker: "zerodha",
    files: ["futEmaRsiStPaper.js", "futEmaRsiStBacktest.js"],
    mounts: { "futEmaRsiStPaper": "/fut_ema_rsi_st-paper", "futEmaRsiStBacktest": "/fut_ema_rsi_st-backtest" },
    origPaperMount: "/ema_rsi_st-paper",
    ss: { set: "setFutEmaRsiStActive", clear: "clearFutEmaRsiSt", is: "isFutEmaRsiStActive", get: "getFutEmaRsiStMode", mode: "FUT_EMA_RSI_ST_PAPER" },
    origSs: { set: "setActive", clear: "clear", mode: "EMA_RSI_ST_PAPER" },
    stems: ["EMA_RSI_ST"], lowerStems: ["ema_rsi_st", "emaRsiSt"],
    engineFile: "strategy1_sar_ema_rsi", engine: "forPrefix",
    knob: "EMA_SLOW", knobVal: "100",
    probe: (e) => e.getSignal(_bars(10), { silent: true }).reason,
    bind: (e, P) => (P ? e.forPrefix(P) : e),
    envKeys: ["FUT_EMA_RSI_ST_EMA_FAST", "FUT_EMA_RSI_ST_EMA_SLOW", "FUT_EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED",
      "FUT_EMA_RSI_ST_EMA_FASTEST", "FUT_EMA_RSI_ST_CLOSE_BEYOND_EMA_ENABLED", "FUT_EMA_RSI_ST_MAX_EMA_DIST_PTS",
      "FUT_EMA_RSI_ST_SUPERTREND_PERIOD", "FUT_EMA_RSI_ST_SUPERTREND_MULT", "FUT_EMA_RSI_ST_FRESH_SIGNAL_ENABLED",
      "FUT_EMA_RSI_ST_ONE_TRADE_PER_MOVE_ENABLED", "FUT_EMA_RSI_ST_CONFIRM_CANDLE_ENABLED",
      "FUT_EMA_RSI_ST_OI_ENABLED", "TG_FUT_EMA_RSI_ST_DAYREPORT", "TG_FUT_EMA_RSI_ST_STARTED",
      "TG_FUT_EMA_RSI_ST_ENTRY", "TG_FUT_EMA_RSI_ST_EXIT", "TG_FUT_EMA_RSI_ST_SIGNALS", "FUT_EMA_RSI_ST_MODE_ENABLED",
      "UI_SHOW_FUT_EMA_RSI_ST_PAPER", "UI_SHOW_FUT_EMA_RSI_ST_BACKTEST"],
  },
  {
    prefix: "FUT_BB_RSI", orig: "BB_RSI", mode: "fut_bb_rsi", origMode: "bb_rsi", broker: "fyers",
    files: ["futBbRsiPaper.js", "futBbRsiBacktest.js"],
    mounts: { "futBbRsiPaper": "/fut_bb_rsi-paper", "futBbRsiBacktest": "/fut_bb_rsi-backtest" },
    origPaperMount: "/bb_rsi-paper",
    ss: { set: "setFutBbRsiActive", clear: "clearFutBbRsi", is: "isFutBbRsiActive", get: "getFutBbRsiMode", mode: "FUT_BB_RSI_PAPER" },
    origSs: { set: "setBbRsiActive", clear: "clearBbRsi", mode: "BB_RSI_PAPER" },
    stems: ["BB_RSI"], lowerStems: ["bb_rsi", "bbRsi"],
    engineFile: "bb_rsi", engine: "forPrefix",
    knob: "DIRECTION", knobVal: "breakout",
    probe: (e) => e.direction(),
    bind: (e, P) => (P ? e.forPrefix(P) : e),
    envKeys: ["FUT_BB_RSI_DIRECTION", "FUT_BB_RSI_RESOLUTION", "FUT_BB_RSI_ENTRY_START", "FUT_BB_RSI_ENTRY_END",
      "FUT_BB_RSI_BB_PERIOD", "FUT_BB_RSI_BB_STDDEV", "FUT_BB_RSI_RSI_PERIOD", "FUT_BB_RSI_RSI_CE_THRESHOLD",
      "FUT_BB_RSI_RSI_PE_THRESHOLD", "FUT_BB_RSI_RSI_TURNING", "FUT_BB_RSI_MAX_ENTRY_SL_PTS", "FUT_BB_RSI_ADX_ENABLED",
      "FUT_BB_RSI_ADX_MAX", "FUT_BB_RSI_BAND_WIDTH_ENABLED", "FUT_BB_RSI_MIN_BAND_WIDTH_PTS",
      "FUT_BB_RSI_RSI_RANGE_ENABLED", "FUT_BB_RSI_RSI_RANGE_LOOKBACK", "FUT_BB_RSI_RSI_RANGE_MIN",
      "FUT_BB_RSI_DIVERGENCE_ENABLED", "FUT_BB_RSI_DIV_LOOKBACK", "FUT_BB_RSI_DIV_PIVOT_BARS",
      "FUT_BB_RSI_CONFIRM_CANDLE_ENABLED", "FUT_BB_RSI_CONFIRM_ON_CLOSE", "FUT_BB_RSI_EXPIRY_DAY_ONLY",
      "FUT_BB_RSI_VIX_ENABLED", "FUT_BB_RSI_VIX_MAX_ENTRY", "FUT_BB_RSI_VIX_STRONG_ONLY", "FUT_BB_RSI_OI_ENABLED",
      "FUT_BB_RSI_MODE_ENABLED", "UI_SHOW_FUT_BB_RSI_PAPER", "UI_SHOW_FUT_BB_RSI_BACKTEST", "TG_FUT_BB_RSI_STARTED",
      "TG_FUT_BB_RSI_ENTRY", "TG_FUT_BB_RSI_EXIT", "TG_FUT_BB_RSI_SIGNALS", "TG_FUT_BB_RSI_DAYREPORT"],
  },
  {
    prefix: "FUT_EMA9VWAP", orig: "EMA9VWAP", mode: "fut_ema9vwap", origMode: "ema9vwap", broker: "zerodha",
    files: ["futEma9vwapPaper.js", "futEma9vwapBacktest.js"],
    mounts: { "futEma9vwapPaper": "/fut_ema9vwap-paper", "futEma9vwapBacktest": "/fut_ema9vwap-backtest" },
    origPaperMount: "/ema9vwap-paper",
    ss: { set: "setFutEma9VwapActive", clear: "clearFutEma9Vwap", is: "isFutEma9VwapActive", get: "getFutEma9VwapMode", mode: "FUT_EMA9VWAP_PAPER" },
    origSs: { set: "setEma9VwapActive", clear: "clearEma9Vwap", mode: "EMA9VWAP_PAPER" },
    stems: ["EMA9VWAP", "EMA9_VWAP"], lowerStems: ["ema9vwap", "ema9_vwap", "ema9Vwap"],
    engineFile: "ema9_vwap", engine: "forPrefix",
    knob: "ENTRY_START", knobVal: "09:30",
    // A 10:00 IST bar closes 10:05 — inside a 09:30 window, outside the 10:30 default.
    probe: (e) => e.isEntryWindowOpen(_istSec(10, 0), 5),
    bind: (e, P) => (P ? e.forPrefix(P) : e),
    envKeys: ["FUT_EMA9VWAP_VWAP_SESSION_START", "FUT_EMA9VWAP_ENTRY_START", "FUT_EMA9VWAP_ENTRY_END",
      "FUT_EMA9VWAP_BAND_MULT", "FUT_EMA9VWAP_EMA_PERIOD", "FUT_EMA9VWAP_CONFIRM_CANDLE_ENABLED",
      "FUT_EMA9VWAP_INTRACANDLE_ENTRY", "FUT_EMA9VWAP_STRENGTH_FILTER", "FUT_EMA9VWAP_STRONG_MIN_SIGMA",
      "FUT_EMA9VWAP_VIX_ENABLED", "FUT_EMA9VWAP_VIX_MAX_ENTRY", "FUT_EMA9VWAP_VIX_STRONG_ONLY",
      "FUT_EMA9VWAP_OI_ENABLED", "FUT_EMA9VWAP_MODE_ENABLED", "UI_SHOW_FUT_EMA9VWAP_BACKTEST",
      "UI_SHOW_FUT_EMA9VWAP_PAPER", "UI_SHOW_FUT_EMA9VWAP_HISTORY", "TG_FUT_EMA9VWAP_STARTED", "TG_FUT_EMA9VWAP_ENTRY",
      "TG_FUT_EMA9VWAP_EXIT", "TG_FUT_EMA9VWAP_SIGNALS", "TG_FUT_EMA9VWAP_DAYREPORT"],
  },
  {
    prefix: "FUT_RSI_PIVOT_ST", orig: "RSI_PIVOT_ST", mode: "fut_rsi_pivot_st", origMode: "rsi_pivot_st", broker: "zerodha",
    files: ["futRsiPivotStPaper.js", "futRsiPivotStBacktest.js"],
    mounts: { "futRsiPivotStPaper": "/fut-rsi-pivot-st-paper", "futRsiPivotStBacktest": "/fut-rsi-pivot-st-backtest" },
    origPaperMount: "/rsi-pivot-st-paper",
    ss: { set: "setFutRsiPivotStActive", clear: "clearFutRsiPivotSt", is: "isFutRsiPivotStActive", get: "getFutRsiPivotStMode", mode: "FUT_RSI_PIVOT_ST_PAPER" },
    origSs: { set: "setRsiPivotStActive", clear: "clearRsiPivotSt", mode: "RSI_PIVOT_ST_PAPER" },
    stems: ["RSI_PIVOT_ST"], lowerStems: ["rsi_pivot_st", "rsi-pivot-st"],
    engineFile: "rsi_pivot_st", engine: "forPrefix",
    knob: "RSI_CE_MIN", knobVal: "80",
    probe: (e) => e.getConfig().rsiCeMin,
    bind: (e, P) => (P ? e.forPrefix(P) : e),
    // The original's strike picker (RSI_PIVOT_ST_STRIKE_MODE / _PCT) cannot select
    // a future — it is deliberately NOT offered in the twin's Settings (asserted below).
    futuresInert: ["FUT_RSI_PIVOT_ST_STRIKE_MODE", "FUT_RSI_PIVOT_ST_STRIKE_PCT"],
    envKeys: ["FUT_RSI_PIVOT_ST_MODE_ENABLED", "FUT_RSI_PIVOT_ST_PAPER_ENABLED", "FUT_RSI_PIVOT_ST_RESOLUTION",
      "FUT_RSI_PIVOT_ST_RSI_PERIOD", "FUT_RSI_PIVOT_ST_RSI_CE_MIN", "FUT_RSI_PIVOT_ST_RSI_PE_MAX",
      "FUT_RSI_PIVOT_ST_PIVOT_BUFFER_PTS", "FUT_RSI_PIVOT_ST_CONFIRM_ENABLED", "FUT_RSI_PIVOT_ST_SESSION_START",
      "FUT_RSI_PIVOT_ST_ENTRY_START", "FUT_RSI_PIVOT_ST_ENTRY_END", "FUT_RSI_PIVOT_ST_ST_PERIOD",
      "FUT_RSI_PIVOT_ST_ST_MULT", "FUT_RSI_PIVOT_ST_ST_SIDES", "FUT_RSI_PIVOT_ST_STRIKE_MODE",
      "FUT_RSI_PIVOT_ST_STRIKE_PCT", "FUT_RSI_PIVOT_ST_ST_CE_ENABLED", "FUT_RSI_PIVOT_ST_POLL_MS",
      "FUT_RSI_PIVOT_ST_HISTORY_LAG_MS", "UI_SHOW_FUT_RSI_PIVOT_ST_BACKTEST", "UI_SHOW_FUT_RSI_PIVOT_ST_PAPER",
      "UI_SHOW_FUT_RSI_PIVOT_ST_HISTORY", "TG_FUT_RSI_PIVOT_ST_STARTED", "TG_FUT_RSI_PIVOT_ST_ENTRY",
      "TG_FUT_RSI_PIVOT_ST_EXIT", "TG_FUT_RSI_PIVOT_ST_DAYREPORT"],
  },
  {
    prefix: "FUT_EMA_RSI_ST_V2", orig: "EMA_RSI_ST_V2", mode: "fut_ema_rsi_st_v2", origMode: "ema_rsi_st_v2", broker: "zerodha",
    files: ["futEmaRsiStV2Paper.js", "futEmaRsiStV2Backtest.js"],
    mounts: { "futEmaRsiStV2Paper": "/fut_ema_rsi_st_v2-paper", "futEmaRsiStV2Backtest": "/fut_ema_rsi_st_v2-backtest" },
    origPaperMount: "/ema_rsi_st_v2-paper",
    ss: { set: "setFutEmaRsiStV2Mode", clear: "clearFutEmaRsiStV2Mode", is: "isFutEmaRsiStV2Active", get: "getFutEmaRsiStV2Mode", mode: "FUT_EMA_RSI_ST_V2_PAPER" },
    origSs: { set: "setEmaRsiStV2Mode", clear: "clearEmaRsiStV2Mode", mode: "EMA_RSI_ST_V2_PAPER" },
    // V1's stem too: a V2 twin must not read V1's options keys either.
    stems: ["EMA_RSI_ST_V2", "EMA_RSI_ST"], lowerStems: ["ema_rsi_st_v2", "emaRsiStV2", "ema_rsi_st", "emaRsiSt"],
    engineFile: "ema_rsi_st_v2", engine: "arg",
    knob: "RSI_CE_MIN", knobVal: "60",
    probe: (e, P) => e.getConfig(P).RSI_CE_MIN,
    bind: (e) => e,
    envKeys: ["FUT_EMA_RSI_ST_V2_MODE_ENABLED", "FUT_EMA_RSI_ST_V2_PAPER_ENABLED", "FUT_EMA_RSI_ST_V2_EMA_FAST",
      "FUT_EMA_RSI_ST_V2_EMA_SLOW", "FUT_EMA_RSI_ST_V2_RSI_PERIOD", "FUT_EMA_RSI_ST_V2_RSI_CE_MIN",
      "FUT_EMA_RSI_ST_V2_RSI_PE_MAX", "FUT_EMA_RSI_ST_V2_SUPERTREND_PERIOD", "FUT_EMA_RSI_ST_V2_SUPERTREND_MULT",
      "FUT_EMA_RSI_ST_V2_ENTRY_START", "FUT_EMA_RSI_ST_V2_ENTRY_END", "FUT_EMA_RSI_ST_V2_CONFIRM_CANDLE_ENABLED",
      "FUT_EMA_RSI_ST_V2_WARMUP_DAYS", "TG_FUT_EMA_RSI_ST_V2_DAYREPORT", "TG_FUT_EMA_RSI_ST_V2_STARTED",
      "TG_FUT_EMA_RSI_ST_V2_ENTRY", "TG_FUT_EMA_RSI_ST_V2_EXIT", "UI_SHOW_FUT_EMA_RSI_ST_V2_PAPER",
      "UI_SHOW_FUT_EMA_RSI_ST_V2_BACKTEST", "UI_SHOW_FUT_EMA_RSI_ST_V2_HISTORY"],
  },
  {
    prefix: "FUT_ST_RSI_PIV_BB", orig: "ST_RSI_PIV_BB", mode: "fut_st_rsi_piv_bb", origMode: "st_rsi_piv_bb", broker: "zerodha",
    files: ["futStRsiPivBbPaper.js"],
    mounts: { "futStRsiPivBbPaper": "/fut_st_rsi_piv_bb-paper" },
    origPaperMount: "/st_rsi_piv_bb-paper",
    ss: { set: "setFutStRsiPivBbMode", clear: "clearFutStRsiPivBbMode", is: "isFutStRsiPivBbActive", get: "getFutStRsiPivBbMode", mode: "FUT_ST_RSI_PIV_BB_PAPER" },
    origSs: { set: "setStRsiPivBbMode", clear: "clearStRsiPivBbMode", mode: "ST_RSI_PIV_BB_PAPER" },
    stems: ["ST_RSI_PIV_BB"], lowerStems: ["st_rsi_piv_bb", "stRsiPivBb"],
    engineFile: "st_rsi_piv_bb", engine: "forPrefix",
    knob: "RSI_CE_MIN", knobVal: "75",
    probe: (e) => e.getConfig().RSI_CE_MIN,
    bind: (e, P) => (P ? e.forPrefix(P) : e),
    envKeys: ["FUT_ST_RSI_PIV_BB_MODE_ENABLED", "FUT_ST_RSI_PIV_BB_PAPER_ENABLED", "FUT_ST_RSI_PIV_BB_ENTRY_TF",
      "FUT_ST_RSI_PIV_BB_RSI_PERIOD", "FUT_ST_RSI_PIV_BB_RSI_CE_MIN", "FUT_ST_RSI_PIV_BB_RSI_PE_MAX",
      "FUT_ST_RSI_PIV_BB_ST_PERIOD", "FUT_ST_RSI_PIV_BB_ST_MULT", "FUT_ST_RSI_PIV_BB_BB_PERIOD",
      "FUT_ST_RSI_PIV_BB_BB_STDDEV", "FUT_ST_RSI_PIV_BB_ENTRY_START", "FUT_ST_RSI_PIV_BB_ENTRY_END",
      "FUT_ST_RSI_PIV_BB_WARMUP_DAYS", "TG_FUT_ST_RSI_PIV_BB_DAYREPORT", "TG_FUT_ST_RSI_PIV_BB_STARTED",
      "TG_FUT_ST_RSI_PIV_BB_ENTRY", "TG_FUT_ST_RSI_PIV_BB_EXIT", "UI_SHOW_FUT_ST_RSI_PIV_BB_PAPER",
      "UI_SHOW_FUT_ST_RSI_PIV_BB_HISTORY"],
  },
  {
    prefix: "FUT_PIVOT_EMA_ST", orig: "PIVOT_EMA_ST", mode: "fut_pivot_ema_st", origMode: "pivot_ema_st", broker: "zerodha",
    files: ["futPivotEmaStPaper.js"],
    mounts: { "futPivotEmaStPaper": "/fut_pivot_ema_st-paper" },
    origPaperMount: "/pivot_ema_st-paper",
    ss: { set: "setFutPivotEmaStMode", clear: "clearFutPivotEmaStMode", is: "isFutPivotEmaStActive", get: "getFutPivotEmaStMode", mode: "FUT_PIVOT_EMA_ST_PAPER" },
    origSs: { set: "setPivotEmaStMode", clear: "clearPivotEmaStMode", mode: "PIVOT_EMA_ST_PAPER" },
    stems: ["PIVOT_EMA_ST"], lowerStems: ["pivot_ema_st", "pivotEmaSt"],
    engineFile: "pivot_ema_st", engine: "arg",
    knob: "EMA_FAST", knobVal: "9",
    probe: (e, P) => e.getConfig(P).EMA_FAST,
    bind: (e) => e,
    envKeys: ["FUT_PIVOT_EMA_ST_TF", "FUT_PIVOT_EMA_ST_EMA_FAST", "FUT_PIVOT_EMA_ST_EMA_SLOW",
      "FUT_PIVOT_EMA_ST_ST_PERIOD", "FUT_PIVOT_EMA_ST_ST_MULT", "FUT_PIVOT_EMA_ST_ENTRY_START",
      "FUT_PIVOT_EMA_ST_ENTRY_END", "FUT_PIVOT_EMA_ST_WARMUP_DAYS", "FUT_PIVOT_EMA_ST_MODE_ENABLED",
      "TG_FUT_PIVOT_EMA_ST_DAYREPORT", "TG_FUT_PIVOT_EMA_ST_STARTED", "TG_FUT_PIVOT_EMA_ST_ENTRY",
      "TG_FUT_PIVOT_EMA_ST_EXIT", "UI_SHOW_FUT_PIVOT_EMA_ST_PAPER", "UI_SHOW_FUT_PIVOT_EMA_ST_HISTORY"],
  },
];

// Deterministic env: no FUT_ / twin-related key leaks in from the shell.
const _TOUCHED = new Set();
for (const k of Object.keys(process.env)) {
  if (/^(TG_|UI_SHOW_)?FUT_/.test(k)) delete process.env[k];
}
for (const t of TWINS) for (const k of [`${t.prefix}_MODE_ENABLED`, `${t.orig}_MODE_ENABLED`]) delete process.env[k];

/** Run fn with the given env (undefined deletes), then restore exactly. */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    _TOUCHED.add(k);
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { return fn(); }
  finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function _istSec(hh, mm) { return Math.floor((Date.UTC(2026, 10, 6, hh, mm) - 19800 * 1000) / 1000); }
function _bars(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ time: _istSec(9, 15) + i * 300, open: 24000, high: 24002, low: 23998, close: 24000 });
  return out;
}
/** Every call `name(…)` with its balanced argument text; declarations skipped. */
function callsOf(src, name) {
  const out = [];
  const re = new RegExp(`(?<![A-Za-z0-9_$])${name}\\(`, "g");
  let m;
  while ((m = re.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 10), m.index))) continue;
    let depth = 1, i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}
const constValue = (src, name) => {
  const m = src.match(new RegExp(`\\bconst\\s+${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? m[1] : null;
};
/** A module loaded fresh with some of its private functions exported for the test. */
function loadInternals(rel, names) {
  const file = path.join(SRC, rel);
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, "utf-8") + `\n;module.exports.__t = { ${names.join(", ")} };`, file);
  return m.exports;
}
/** SETTINGS_SCHEMA, evaluated from the source (it is not exported). */
function loadSettingsSchema() {
  const t = read("routes/settings.js");
  const a = t.indexOf("const EFFECT = {");
  const s = t.indexOf("const SETTINGS_SCHEMA = [");
  const e = t.indexOf("\n];", s);
  assert.ok(a >= 0 && s > a && e > s, "settings.js: SETTINGS_SCHEMA not found");
  // eslint-disable-next-line no-new-func
  return new Function(t.slice(a, e + 3) + "\nreturn SETTINGS_SCHEMA;")();
}
/** The original's key for a twin key: drop the first FUT_ (FUT_X → X, TG_FUT_X → TG_X). */
const origKeyOf = (k) => k.replace(/FUT_/, "");

const appSrc   = codeOf(read("app.js"));
const SCHEMA   = loadSettingsSchema();
const FIELDS   = new Map();
for (const sec of SCHEMA) for (const f of sec.fields || []) FIELDS.set(f.key, { ...f, section: sec.section, group: sec.group, nav: sec.nav });
const srcOfTwin = (t) => t.files.map(f => codeOf(read(path.join("routes", f)))).join("\n");
const paperOf   = (t) => t.files.find(f => /Paper\.js$/.test(f));

const sharedSocketState = require("../src/utils/sharedSocketState");
const sharedNav         = require("../src/utils/sharedNav");
const tradeLogger       = require("../src/utils/tradeLogger");
const skipLogger        = require("../src/utils/skipLogger");
const capitalPool       = require("../src/utils/capitalPool");
const portfolioRisk     = require("../src/utils/portfolioRisk");
const notify            = loadInternals("utils/notify.js", ["_isFuturesAlert"]);

// ─────────────────────────────────────────────────────────────────────────────
section("1. Each twin's routes exist and are mounted in app.js at the FUT path");

for (const t of TWINS) {
  check(`${t.prefix}: ${t.files.join(" + ")} exist and are mounted once each`, () => {
    for (const f of t.files) assert.ok(fs.existsSync(path.join(ROUTES, f)), `src/routes/${f} is missing`);
    for (const [stem, mount] of Object.entries(t.mounts)) {
      const req = `require\\(\\s*["']\\.\\/routes\\/${stem}["']\\s*\\)`;
      const re = new RegExp(`app\\.use\\(\\s*["']${mount.replace(/[-/]/g, "\\$&")}["']\\s*,\\s*(?:${req}|lazyRouter\\(\\s*\\(\\)\\s*=>\\s*${req}\\s*\\))\\s*\\)`, "g");
      const n = (appSrc.match(re) || []).length;
      assert.strictEqual(n, 1, `app.js mounts ${stem} at ${mount} ${n} times (expected exactly 1)`);
      assert.ok(!new RegExp(`app\\.use\\(\\s*["'](?!${mount.replace(/[-/]/g, "\\$&")}["'])[^"']+["']\\s*,\\s*(?:lazyRouter\\(\\s*\\(\\)\\s*=>\\s*)?${req}`).test(appSrc),
        `app.js also mounts ${stem} at some other path`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
section("2. Sidebar: under NIFTY FUTURES, gated by the twin's own MODE toggle");

function sidebar() { return sharedNav.buildSidebar("settings", null, false, {}); }
function futuresParentOf(html) {
  const i = html.indexOf('id="nav-parent-futures"');
  if (i < 0) return "";
  const rest = html.slice(i + 10);
  const j = rest.search(/id="nav-parent-|id="nav-system"/);
  return j < 0 ? rest : rest.slice(0, j);
}

for (const t of TWINS) {
  const MODE = `${t.prefix}_MODE_ENABLED`, OMODE = `${t.orig}_MODE_ENABLED`;
  const href = `href="${t.mounts[paperOf(t).replace(/\.js$/, "")]}/status"`;
  const origHref = `href="${t.origPaperMount}/status"`;
  const show = { [`UI_SHOW_${t.prefix}_PAPER`]: "true", [`UI_SHOW_${t.orig}_PAPER`]: "true" };

  check(`${t.prefix}: a STRATEGY_MODES row labelled "FUT …" keyed on ${MODE}`, () => {
    const row = sharedNav.STRATEGY_MODES.find(r => r.mode === t.prefix);
    assert.ok(row, `sharedNav.STRATEGY_MODES has no ${t.prefix} row`);
    assert.strictEqual(row.envKey, MODE);
    assert.ok(/^FUT /.test(row.label), `label "${row.label}" does not say it is the futures twin`);
  });

  check(`${t.prefix}: Paper item sits under NIFTY FUTURES only while ${MODE} is on`, () => {
    withEnv({ ...show, [MODE]: "true", [OMODE]: "false" }, () => {
      const html = sidebar(), fut = futuresParentOf(html);
      assert.ok(fut.includes(href), `${href} is not under the NIFTY FUTURES parent (with the original OFF)`);
      assert.strictEqual(html.split(href).length - 1, fut.split(href).length - 1, `${href} also appears outside NIFTY FUTURES`);
    });
    withEnv({ ...show, [MODE]: "false", [OMODE]: "true" }, () => {
      const html = sidebar();
      assert.ok(!html.includes(href), `${MODE}=false still shows ${href}`);
      assert.ok(html.includes(origHref), `turning the twin off hid the ORIGINAL (${origHref})`);
      assert.ok(!futuresParentOf(html).includes(origHref), `the original ${origHref} is filed under NIFTY FUTURES`);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
section("3. Settings: the MODE toggle and every FUT key are exposed, mirroring the original");

for (const t of TWINS) {
  const MODE = `${t.prefix}_MODE_ENABLED`;
  const src = srcOfTwin(t);
  // Every FUT key the twin reads: the contract list + every literal read in its source.
  const discovered = new Set(t.envKeys);
  for (const re of [/process\.env\.((?:TG_|UI_SHOW_)?FUT_[A-Z0-9_]+)/g,
                    /process\.env\[\s*["']((?:TG_|UI_SHOW_)?FUT_[A-Z0-9_]+)["']\s*\]/g,
                    /canSend\(\s*["'](TG_FUT_[A-Z0-9_]+)["']/g]) {
    let m; while ((m = re.exec(src))) discovered.add(m[1]);
  }
  const inert = new Set(t.futuresInert || []);

  check(`${t.prefix}: ${MODE} and every FUT key it reads are in SETTINGS_SCHEMA`, () => {
    assert.ok(FIELDS.has(MODE), `${MODE} is not in the Settings UI — no new menu item ships without a toggle`);
    const missing = [];
    for (const k of discovered) {
      if (FIELDS.has(k) || inert.has(k)) continue;
      if (!FIELDS.has(origKeyOf(k))) continue;   // the original exposes no field for it either — mirrored
      missing.push(k);
    }
    assert.deepStrictEqual(missing, [], `${t.prefix} reads keys the Settings UI never offers: ${missing.join(", ")}`);
  });

  if (inert.size) {
    check(`${t.prefix}: its unexposed keys really are inert for a future`, () => {
      for (const k of inert) {
        assert.ok(FIELDS.has(origKeyOf(k)), `${k} is exempt only because the original exposes ${origKeyOf(k)} — it does not`);
        assert.ok(!FIELDS.has(k), `${k} is now in Settings — drop it from futuresInert`);
      }
      assert.ok(/instrumentMode\.resolveEntryInstrument\(/.test(src) && !/strikeOverride/.test(src) &&
                !/validateAndGetOptionSymbol\(/.test(src),
        `${t.prefix} must resolve its contract through instrumentMode.futures with no strike — else the strike keys matter`);
    });
  }

  check(`${t.prefix}: every FUT field mirrors its original's default and Settings group`, () => {
    const mine = [...FIELDS.values()].filter(f => new RegExp(`^(TG_|UI_SHOW_)?${t.prefix}_`).test(f.key) &&
      // FUT_EMA_RSI_ST_ must not sweep in FUT_EMA_RSI_ST_V2_ keys.
      !TWINS.some(o => o !== t && o.prefix.startsWith(t.prefix + "_") && new RegExp(`^(TG_|UI_SHOW_)?${o.prefix}_`).test(f.key)));
    assert.ok(mine.length >= 3, `found only ${mine.length} ${t.prefix} fields`);
    for (const f of mine) {
      const o = FIELDS.get(origKeyOf(f.key));
      if (!o) continue;   // a twin-only field (none expected, but not a mirror defect)
      assert.strictEqual(String(f.default), String(o.default),
        `${f.key} defaults to ${JSON.stringify(f.default)} but ${o.key} defaults to ${JSON.stringify(o.default)}`);
      const wantGroup = o.group === "NIFTY" ? "NIFTY FUTURES" : o.group;
      assert.strictEqual(f.group, wantGroup, `${f.key} is in group "${f.group}", its original ${o.key} in "${o.group}"`);
    }
  });

  check(`${t.prefix}: the MODE toggle ships with ONE default everywhere it is read`, () => {
    const want = String(FIELDS.get(`${t.orig}_MODE_ENABLED`).default);
    assert.strictEqual(String(FIELDS.get(MODE).default), want, `Settings shows ${MODE} default ≠ original (${want})`);
    const row = sharedNav.STRATEGY_MODES.find(r => r.mode === t.prefix) || {};
    assert.strictEqual(String(row.envDefault || "true"), want, `sharedNav envDefault ≠ ${want}`);
    const gate = src.match(new RegExp(`process\\.env\\.${MODE}\\s*\\|\\|\\s*["'](\\w+)["']`));
    if (gate) assert.strictEqual(gate[1], want, `the route's /start gate falls back to "${gate[1]}", Settings to "${want}"`);
    withEnv({ [MODE]: undefined }, () => {
      assert.strictEqual(notify.isModeEnabled(t.prefix), want === "true", `notify treats an unset ${MODE} as ${!(want === "true")}`);
    });
    // Replay's dropdown mirrors the original's entry (modeDefault included).
    const rp = read("routes/replay.js");
    const line = (m) => (rp.match(new RegExp(`\\{\\s*mode:\\s*"${m.replace(/[-]/g, "\\-")}"[^\\n]*\\}`)) || [null])[0];
    const origLine = line(t.origPaperMount.slice(1));
    const twinLine = line(t.mounts[paperOf(t).replace(/\.js$/, "")].slice(1));
    if (origLine) {
      assert.ok(twinLine, `replay offers ${t.origPaperMount.slice(1)} but not its futures twin`);
      const md = (l) => (l.match(/modeDefault:\s*"(\w+)"/) || [null, "true"])[1];
      assert.strictEqual(md(twinLine), md(origLine), `replay modeDefault for the twin (${md(twinLine)}) ≠ original (${md(origLine)})`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
section("4. No twin reads an un-prefixed (options) key, mode string or trade file");

for (const t of TWINS) {
  for (const f of t.files) {
    const src = codeOf(read(path.join("routes", f)));
    check(`${f} names only FUT_ keys and fut_ modes`, () => {
      const bad = [];
      for (const stem of t.stems) {
        // Not preceded by an identifier char (so FUT_X, _X locals are fine) nor by
        // "FUT " (display labels: "FUT BB_RSI Paper").
        const re = new RegExp(`(?<![A-Za-z0-9_])(?<!FUT )(?:TG_|UI_SHOW_)?${stem}(?:_[A-Z0-9]+)*`, "g");
        let m;
        while ((m = re.exec(src))) {
          // A bare name in prose ("… twin of ST_RSI_PIV_BB (CE …") is not a key; a
          // bare name in quotes or as a mode tag ("BB_RSI", "BB_RSI-PAPER") is.
          const bare = m[0] === stem;
          const prev = src[m.index - 1], next = src[m.index + m[0].length];
          if (bare && !/["'`]/.test(prev || "") && !/["'`-]/.test(next || "")) continue;
          bad.push(m[0]);
        }
      }
      for (const stem of t.lowerStems) {
        // A quoted mode key, a route path or a data-file stem — not a require path.
        const re = new RegExp(`(?<![A-Za-z0-9_\\-])(?<!strategies\\/|services\\/)${stem}(?=["'\`]|-paper|-backtest|_paper|_trades|_skips)`, "g");
        let m; while ((m = re.exec(src))) bad.push(m[0]);
      }
      assert.deepStrictEqual([...new Set(bad)], [], `${f} references the ORIGINAL's names: ${[...new Set(bad)].join(", ")}`);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section("5. The engine reads FUT_ keys through the prefix — and only through it");

for (const t of TWINS) {
  const engine = require(path.join(SRC, "strategies", t.engineFile));
  const FK = `${t.prefix}_${t.knob}`, OK = `${t.orig}_${t.knob}`;
  const futVal = () => t.probe(t.bind(engine, t.prefix), t.prefix);
  const optVal = () => t.probe(t.bind(engine, null), undefined);

  check(`${t.prefix}: ${FK} moves the FUT config only; ${OK} moves the options config only`, () => {
    withEnv({ [FK]: undefined, [OK]: undefined }, () => {
      const f0 = futVal(), o0 = optVal();
      assert.deepStrictEqual(f0, o0, `with no keys set the twin (${f0}) must decide like the original (${o0})`);
      withEnv({ [FK]: t.knobVal }, () => {
        assert.notDeepStrictEqual(futVal(), f0, `${FK}=${t.knobVal} did not change the FUT engine — it is not reading its prefix`);
        assert.deepStrictEqual(optVal(), o0, `${FK} leaked into the OPTIONS engine`);
      });
      withEnv({ [OK]: t.knobVal }, () => {
        assert.notDeepStrictEqual(optVal(), o0, `fixture: ${OK} should move the options engine`);
        assert.deepStrictEqual(futVal(), f0, `${OK} (an options key) leaked into the FUT engine`);
      });
    });
  });

  check(`${t.prefix}: every route binds the engine to ${t.prefix}`, () => {
    for (const f of t.files) {
      const src = codeOf(read(path.join("routes", f)));
      const reqRe = new RegExp(`require\\(\\s*["']\\.\\.\\/strategies\\/${t.engineFile}["']\\s*\\)(\\.forPrefix\\(\\s*([^)]*)\\))?`, "g");
      const reqs = [...src.matchAll(reqRe)];
      const delegates = /run(Ema9Vwap)?Backtest\(/.test(src) && !reqs.length;
      if (delegates) {
        // A thin backtest: the prefix rides in the engine options instead.
        assert.ok(new RegExp(`prefix:\\s*(["']${t.prefix}["']|[A-Z_]+)`).test(src), `${f} hands its engine no ${t.prefix} prefix`);
        const pc = src.match(/prefix:\s*([A-Z_]+)\b/);
        if (pc && !/["']/.test(pc[1])) assert.strictEqual(constValue(src, pc[1]), t.prefix, `${f}: ${pc[1]} ≠ "${t.prefix}"`);
        continue;
      }
      assert.ok(reqs.length > 0, `${f} never requires ../strategies/${t.engineFile}`);
      if (t.engine === "forPrefix") {
        for (const r of reqs) {
          assert.ok(r[1], `${f} requires the ${t.engineFile} engine UN-prefixed — it would read ${t.orig}_* keys`);
          const arg = r[2].trim();
          const val = /^["']/.test(arg) ? arg.replace(/["']/g, "") : constValue(src, arg);
          assert.strictEqual(val, t.prefix, `${f}: forPrefix(${arg}) is not ${t.prefix}`);
        }
      } else {
        assert.strictEqual(constValue(src, "PREFIX"), t.prefix, `${f}: const PREFIX must be "${t.prefix}"`);
        const calls = callsOf(src, "engine\\.getConfig");
        assert.ok(calls.length > 0, `${f} never reads engine.getConfig(PREFIX)`);
        for (const a of calls) assert.ok(/\bPREFIX\b/.test(a), `${f}: engine.getConfig(${a}) drops the prefix`);
        for (const a of callsOf(src, "engine\\.getSignal")) {
          assert.ok(/prefix:\s*PREFIX\b/.test(a), `${f}: engine.getSignal(${a.replace(/\s+/g, " ").slice(0, 80)}…) drops the prefix`);
        }
        for (const a of callsOf(src, "engine\\.isInTradingWindow")) assert.ok(/\bPREFIX\b/.test(a), `${f}: isInTradingWindow(${a}) drops the prefix`);
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
section("6. sharedSocketState: each twin has its own slot, free to run beside its original");

const ssCalls = (t) => {
  const names = new Set();
  for (const f of t.files) for (const m of codeOf(read(path.join("routes", f))).matchAll(/sharedSocketState\.([A-Za-z0-9_]+)\(/g)) names.add(m[1]);
  return names;
};

for (const t of TWINS) {
  check(`${t.prefix}: its four functions exist, and every one the route calls exists`, () => {
    for (const k of ["set", "clear", "is", "get"]) {
      assert.strictEqual(typeof sharedSocketState[t.ss[k]], "function", `sharedSocketState.${t.ss[k]} is missing`);
    }
    for (const n of ssCalls(t)) {
      assert.strictEqual(typeof sharedSocketState[n], "function", `${paperOf(t)} calls sharedSocketState.${n}(), which does not exist`);
      if (/^(set|clear)/.test(n)) assert.ok(/Fut/.test(n), `${paperOf(t)} mutates the ORIGINAL's slot via ${n}()`);
    }
  });

  check(`${t.prefix}: canStart("${t.ss.mode}") is allowed while ${t.orig} runs, refused while itself runs`, () => {
    const ss = sharedSocketState;
    try {
      ss[t.origSs.set](t.origSs.mode);
      const r = ss.canStart(t.ss.mode, { reserve: false });
      assert.strictEqual(r.allowed, true, `blocked by its options original: ${r.reason}`);
      ss[t.ss.set](t.ss.mode);
      assert.strictEqual(ss[t.ss.is](), true, `${t.ss.is}() is false after ${t.ss.set}()`);
      assert.strictEqual(ss[t.ss.get](), t.ss.mode);
      assert.strictEqual(ss.canStart(t.ss.mode, { reserve: false }).allowed, false, "a second start of the same twin must be refused");
      const o = ss.canStart(t.origSs.mode, { reserve: false });
      ss[t.origSs.clear]();
      const o2 = ss.canStart(t.origSs.mode, { reserve: false });
      assert.strictEqual(o2.allowed, true, `the running twin blocks its original: ${o2.reason}`);
      assert.strictEqual(o.allowed, false, "fixture: the original was running, so its own canStart must refuse");
      assert.strictEqual(ss.isAnyActive(), true, "isAnyActive() ignores a running twin");
      for (const other of TWINS) {
        if (other === t) continue;
        const x = ss.canStart(other.ss.mode, { reserve: false });
        assert.strictEqual(x.allowed, true, `${t.prefix} running blocks ${other.prefix}: ${x.reason}`);
      }
    } finally {
      ss[t.ss.clear](); ss[t.origSs.clear]();
    }
    assert.strictEqual(sharedSocketState[t.ss.is](), false, `${t.ss.clear}() left the slot set`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
section("7. tradeLogger / skipLogger / capitalPool / portfolioRisk know each twin's mode");

check("fixture: the capital gate is enabled for these probes", () => {
  withEnv({ PAPER_CAPITAL_GATE_ENABLED: "true" }, () => assert.strictEqual(capitalPool.isEnabled(), true));
});

for (const t of TWINS) {
  check(`${t.prefix}: "${t.mode}" has its own trade log, skip log, capital row and risk cap`, () => {
    const D = "2026-11-06";
    assert.strictEqual(path.basename(tradeLogger.filePathFor(t.mode)), `${t.mode}_paper_trades_log.jsonl`);
    assert.strictEqual(path.basename(tradeLogger.dailyFilePathFor(t.mode, D)), `${t.mode}_paper_trades_${D}.jsonl`);
    assert.notStrictEqual(tradeLogger.filePathFor(t.mode), tradeLogger.filePathFor(t.origMode), "shares the original's trade log");
    assert.strictEqual(path.basename(skipLogger.filePathFor(t.mode, D)), `${t.mode}_paper_skips_${D}.jsonl`);
    withEnv({ PAPER_CAPITAL_GATE_ENABLED: "true" }, () => {
      const c = capitalPool.check(t.mode, 1000);
      assert.strictEqual(c.disabled, false, `capitalPool does not know "${t.mode}": ${c.reason}`);
      assert.strictEqual(c.broker, t.broker, `"${t.mode}" is in the ${c.broker} pool, expected ${t.broker}`);
      assert.strictEqual(c.broker, capitalPool.check(t.origMode, 1000).broker, "a twin is charged to its original's broker");
    });
    assert.ok(portfolioRisk.PAPER_MODES.includes(t.mode), `"${t.mode}" is not counted toward the portfolio daily cap`);
  });

  check(`${paperOf(t)} logs, gates and books under "${t.mode}" — never another mode`, () => {
    const src = codeOf(read(path.join("routes", paperOf(t))));
    const fns = ["appendTradeLog", "appendSkipLog", "capitalPool\\.gate", "capitalPool\\.block", "capitalPool\\.release",
                 "capitalPool\\.trackSession", "capitalPool\\.sessionSaved", "capitalPool\\.clear"];
    let n = 0;
    for (const fn of fns) for (const a of callsOf(src, fn)) {
      n++;
      const first = a.split(",")[0].trim();
      const val = /^["']/.test(first) ? first.replace(/["']/g, "") : constValue(src, first);
      assert.strictEqual(val, t.mode, `${paperOf(t)}: ${fn.replace("\\", "")}(${first}, …) is not "${t.mode}"`);
    }
    assert.ok(n >= 3, `${paperOf(t)} makes only ${n} logger/capital calls — the scan found nothing to check`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
section("8. notify files each twin under its own group, and as FUTURES");

for (const t of TWINS) {
  const MODE = `${t.prefix}_MODE_ENABLED`, OMODE = `${t.orig}_MODE_ENABLED`;
  check(`${t.prefix}: "${t.prefix}-PAPER" → group ${t.prefix}, gated by ${MODE} alone`, () => {
    for (const m of [`${t.prefix}-PAPER`, `${t.prefix}_PAPER`, t.prefix]) {
      assert.strictEqual(notify.modeGroup(m), t.prefix, `modeGroup("${m}") = ${notify.modeGroup(m)}`);
    }
    assert.ok(!/^FUT_/.test(notify.modeGroup(`${t.orig}-PAPER`)), `the original's mode is filed under a FUT group`);
    withEnv({ [MODE]: "false", [OMODE]: "true" }, () => assert.strictEqual(notify.isModeEnabled(t.prefix), false, `${MODE}=false does not silence it`));
    withEnv({ [MODE]: "true", [OMODE]: "false" }, () => assert.strictEqual(notify.isModeEnabled(t.prefix), true, `${OMODE}=false silenced the twin`));
  });

  check(`${t.prefix}: every alert the route sends is a FUTURES alert in a FUT group`, () => {
    const src = codeOf(read(path.join("routes", paperOf(t))));
    const modes = [];
    for (const fn of ["notifyStarted", "notifyEntry", "notifyExit", "notifySignal", "notifyDayReport"]) {
      for (const a of callsOf(src, fn)) {
        const m = a.match(/\bmode:\s*["']([^"']+)["']/);
        if (m) modes.push({ fn, mode: m[1] });
      }
    }
    assert.ok(modes.some(x => x.fn === "notifyEntry") && modes.some(x => x.fn === "notifyExit"),
      `${paperOf(t)}: no notifyEntry/notifyExit mode found to check`);
    for (const { fn, mode } of modes) {
      const g = notify.modeGroup(mode);
      assert.ok(/^FUT_/.test(g), `${fn}({ mode: "${mode}" }) is filed under the OPTIONS group ${g} — its toggles and report are the original's`);
      if (fn !== "notifySignal") assert.strictEqual(g, t.prefix, `${fn}({ mode: "${mode}" }) → ${g}, expected ${t.prefix}`);
      assert.strictEqual(notify.__t._isFuturesAlert({ mode, isFutures: false }), true, `"${mode}" is rendered as an option`);
    }
    assert.strictEqual(notify.__t._isFuturesAlert({ mode: `${t.orig}-PAPER`, isFutures: false }), false,
      "the original's alert is rendered as a future");
  });
}

check("FUT_EMA_RSI_ST and FUT_EMA_RSI_ST_V2 never collide (prefix overlap)", () => {
  assert.strictEqual(notify.modeGroup("FUT_EMA_RSI_ST_V2-PAPER"), "FUT_EMA_RSI_ST_V2");
  assert.strictEqual(notify.modeGroup("FUT_EMA_RSI_ST_V2_PAPER"), "FUT_EMA_RSI_ST_V2");
  assert.strictEqual(notify.modeGroup("FUT_EMA_RSI_ST-PAPER"), "FUT_EMA_RSI_ST");
  assert.strictEqual(notify.modeGroup("FUT_EMA_RSI_ST_PAPER"), "FUT_EMA_RSI_ST");
  // …and the options pair still classifies as before.
  assert.strictEqual(notify.modeGroup("EMA_RSI_ST_V2-PAPER"), "EMA_RSI_ST_V2");
  assert.strictEqual(notify.modeGroup("PAPER"), "EMA_RSI_ST");
  withEnv({ FUT_EMA_RSI_ST_MODE_ENABLED: "false", FUT_EMA_RSI_ST_V2_MODE_ENABLED: "true" }, () => {
    assert.strictEqual(notify.isModeEnabled(notify.modeGroup("FUT_EMA_RSI_ST_V2-PAPER")), true, "V1 twin's toggle silenced the V2 twin");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
for (const k of _TOUCHED) if (/^(TG_|UI_SHOW_)?FUT_/.test(k)) delete process.env[k];
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

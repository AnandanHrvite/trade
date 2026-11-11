#!/usr/bin/env node
/**
 * strategyBaseline.js — golden paper-trade baseline for the 17 NIFTY paper strategies
 * ─────────────────────────────────────────────────────────────────────────────
 * Drives every NIFTY paper route through a fixed set of SYNTHETIC, seeded market
 * sessions using the real replay engine (src/services/tickReplay.replaySession)
 * and records every trade it books. The output is one golden JSON per strategy
 * under tests/baseline/. The purpose is a refactor safety net: a change that is
 * meant to leave paper decisions untouched must leave these files byte-identical.
 *
 * PAIRS: the same harness also replays the (strategy, market) pairs a create(pair)
 * builder runs (PAIRS below) through synthetic SENSEX / BANKNIFTY / NIFTY-futures
 * sessions — each market recorded into its own ticks dir, so the NIFTY recording
 * is byte-for-byte what it always was — into tests/baseline/<route>.<MARKET>.json.
 *
 *   node scripts/strategyBaseline.js            regenerate tests/baseline/*.json
 *   node scripts/strategyBaseline.js --check    re-run and diff against them (exit 1 on any difference)
 *   npm run test:baseline                       same as --check
 *
 * Options:
 *   --only=bbRsiPaper,orbPaper    restrict to these strategies (route file names)
 *   --jobs=N                      parallel child processes (default: CPUs - 1, max 8)
 *   --keep                        keep the temp dir (recordings, per-run logs) for debugging
 *   --verbose                     print each run as it finishes
 *
 * Isolation — every run is its own child process (scripts/lib/baselineWorker.js)
 * started with a minimal env, HOME / cwd / TMPDIR inside a throwaway temp dir,
 * TZ=UTC (what the EC2 host runs), network primitives blocked and the clock
 * frozen to the replayed tick; setTimeout delays > 30 s and setInterval are
 * parked (never fire) so the outcome cannot depend on machine speed. Nothing is
 * read from or written to the repo's
 * data/ticks, ~/trading-data or any .env; nothing under src/ is modified.
 * A fresh process per (strategy, day) also means no module-level state leaks
 * between runs, so a refactor that changes module caching cannot move a result.
 *
 * Inputs are fixed in this file: the sessions (scripts/lib/syntheticMarket.js),
 * the settings snapshot below, and the recording format. Code defaults for every
 * key NOT listed in SETTINGS come from src/ itself — on purpose, so a refactor
 * that shifts a default shows up as a diff.
 */

"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawn } = require("child_process");

const REPO        = path.resolve(__dirname, "..");
const BASELINE_DIR = path.join(REPO, "tests", "baseline");
const WORKER      = path.join(__dirname, "lib", "baselineWorker.js");
const market      = require("./lib/syntheticMarket");

// The 17 NIFTY paper strategies: route file → replay mode key.
const STRATEGIES = [
  { route: "emaRsiStPaper",      mode: "ema_rsi_st-paper" },
  { route: "bbRsiPaper",         mode: "bb_rsi-paper" },
  { route: "paPaper",            mode: "pa-paper" },
  { route: "orbPaper",           mode: "orb-paper" },
  { route: "ema9vwapPaper",      mode: "ema9vwap-paper" },
  { route: "trendPbPaper",       mode: "trend-pb-paper" },
  { route: "trendDayScalpPaper", mode: "trend-day-scalp-paper" },
  { route: "haScalpPaper",       mode: "ha-scalp-paper" },
  { route: "prevOrbScalpPaper",  mode: "prev-orb-scalp-paper" },
  { route: "itm20ScalpPaper",    mode: "itm20-scalp-paper" },
  { route: "rsiPivotStPaper",    mode: "rsi-pivot-st-paper" },
  { route: "simple930Paper",     mode: "simple930-paper" },
  { route: "earlyBirdPaper",     mode: "early-bird-paper" },
  { route: "emaRsiStV2Paper",    mode: "ema_rsi_st_v2-paper" },
  { route: "stRsiPivBbPaper",    mode: "st_rsi_piv_bb-paper" },
  { route: "pivotEmaStPaper",    mode: "pivot_ema_st-paper" },
  { route: "gapRunawayPaper",    mode: "gap_runaway-paper" },
];

// The settings snapshot every synthetic session records. Replay applies it over
// a clean env, so anything not listed runs on the code default.
//   · Mode/paper toggles: several strategies refuse /start while they are off.
//   · The profit lock and the premium stop are the only automatic exits the
//     engines have; with both off every session would hold one position until
//     the 15:30 square-off. Both ON, at their shipped percentages.
//   · Keys tickReplay forces to a "pre-feature" value when they are ABSENT from
//     a snapshot (confirm candle, trail %, tiers, re-entry cooldown, fresh
//     signal, one-trade-per-move) are written explicitly at their live defaults
//     so the baseline exercises the code as it ships today.
const SETTINGS = {
  EMA_RSI_ST_V2_MODE_ENABLED: "true",  EMA_RSI_ST_V2_PAPER_ENABLED: "true",
  ST_RSI_PIV_BB_MODE_ENABLED: "true",  ST_RSI_PIV_BB_PAPER_ENABLED: "true",
  PIVOT_EMA_ST_MODE_ENABLED: "true",
  GAP_RUNAWAY_MODE_ENABLED: "true",
  ORB_MODE_ENABLED: "true",
  TREND_PB_MODE_ENABLED: "true",
  TDS_MODE_ENABLED: "true",            TDS_PAPER_ENABLED: "true",
  HA_SCALP_MODE_ENABLED: "true",       HA_SCALP_PAPER_ENABLED: "true",
  PREV_ORB_SCALP_MODE_ENABLED: "true", PREV_ORB_SCALP_PAPER_ENABLED: "true",
  ITM20_SCALP_MODE_ENABLED: "true",    ITM20_SCALP_PAPER_ENABLED: "true",
  RSI_PIVOT_ST_MODE_ENABLED: "true",   RSI_PIVOT_ST_PAPER_ENABLED: "true",
  SIMPLE930_MODE_ENABLED: "true",      SIMPLE930_PAPER_ENABLED: "true",
  EARLYBIRD_MODE_ENABLED: "true",      EARLYBIRD_PAPER_ENABLED: "true",
  PROFIT_LOCK_ENABLED: "true",
  PROFIT_LOCK_TRAIL_PCT: "70",
  PROFIT_LOCK_TRAIL_TIERS: "20:85,40:80",
  PREMIUM_SL_ENABLED: "true",
  EXIT_REENTRY_COOLDOWN_CANDLES: "2",
  EMA_RSI_ST_CONFIRM_CANDLE_ENABLED: "true",
  BB_RSI_CONFIRM_CANDLE_ENABLED: "true",
  EMA_RSI_ST_FRESH_SIGNAL_ENABLED: "true",
  EMA_RSI_ST_ONE_TRADE_PER_MOVE_ENABLED: "true",
  // EarlyBird's default "stock" leg trades NIFTY-50 constituents' cash equity,
  // which needs a per-stock quote + history feed the synthetic market does not
  // model. "option" runs the NIFTY-only leg (same signal candle, NIFTY CE/PE).
  EARLYBIRD_TRADE_MODE: "option",
  // Common Trade Rules → "Trade window (all strategies)" (src/utils/
  // commonTradeWindow.js, ON by default). app.js applies it to process.env at
  // boot, so every live recording's snapshot carries the overridden values;
  // the harness never loads app.js, so it pins them here. NIFTY keys only.
  ...Object.fromEntries([
    "TRADE_ENTRY_START", "BB_RSI_ENTRY_START", "PA_ENTRY_START", "ORB_ENTRY_START",
    "EMA9VWAP_ENTRY_START", "TREND_PB_ENTRY_START", "HA_SCALP_ENTRY_START",
    "RSI_PIVOT_ST_ENTRY_START", "EMA_RSI_ST_V2_ENTRY_START", "ST_RSI_PIV_BB_ENTRY_START",
    "PIVOT_EMA_ST_ENTRY_START",
  ].map(k => [k, "10:00"])),
  ...Object.fromEntries([
    "TRADE_ENTRY_END", "BB_RSI_ENTRY_END", "PA_ENTRY_END", "EMA9VWAP_ENTRY_END",
    "TREND_PB_ENTRY_END", "TDS_ENTRY_END", "HA_SCALP_ENTRY_END", "PREV_ORB_SCALP_ENTRY_END",
    "RSI_PIVOT_ST_ENTRY_END", "EMA_RSI_ST_V2_ENTRY_END", "ST_RSI_PIV_BB_ENTRY_END",
    "PIVOT_EMA_ST_ENTRY_END",
  ].map(k => [k, "14:00"])),
};

// (strategy, market) pairs replayed on their own synthetic market. mode / key
// are config/pairs.js's for that pair (spelled here so the parent never loads
// src/): mode = "<modeKey>-paper", enabledKey = "<PAIR>_MODE_ENABLED".
//   SENSEX     BSE, weekly Thursday, grid 100, lot 20, ~77–83k
//   BANKNIFTY  NSE, monthly only, grid 100, lot 30, ~56–60k
//   NIFTY_FUT  the NIFTY 50 month future, priced at the index
// Every pair ships OFF, so its switch is set in its recording's snapshot; the
// rest of SETTINGS (paper switch, entry window, profit lock, premium stop …) is
// inherited from NIFTY's keys exactly as a live pair would.
const PAIRS = [
  { route: "emaRsiStV2Paper", market: "SENSEX",    mode: "sensex_ema_rsi_st_v2-paper", enabledKey: "SENSEX_EMA_RSI_ST_V2_MODE_ENABLED" },
  { route: "emaRsiStV2Paper", market: "BANKNIFTY", mode: "bn_ema_rsi_st_v2-paper",     enabledKey: "BN_EMA_RSI_ST_V2_MODE_ENABLED" },
  { route: "emaRsiStV2Paper", market: "NIFTY_FUT", mode: "fut_ema_rsi_st_v2-paper",    enabledKey: "FUT_EMA_RSI_ST_V2_MODE_ENABLED" },
].map(p => ({ ...p, name: `${p.route}.${p.market}` }));

const RECORDING_SPEC = {
  settings: SETTINGS,
  modes: STRATEGIES.map(s => s.mode),
  sessionStart: [9, 14, 0],     // IST — /start runs pre-open, as an operator would
  sessionStop:  [15, 30, 0],
  optionEveryMs: 5000,          // one quote per strike per 5 s
  strikeBand: 600,              // ±600 pts (±12 strikes) around spot, CE + PE
};

// Bump when the harness inputs change on purpose (recording format, settings,
// sessions); a golden file from another version is reported, not diffed.
const BASELINE_VERSION = 1;

// ── argv ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt  = (k) => { const a = argv.find(x => x.startsWith(`${k}=`)); return a ? a.slice(k.length + 1) : null; };
const CHECK   = flag("--check");
const KEEP    = flag("--keep");
const VERBOSE = flag("--verbose");
const ONLY    = opt("--only") ? new Set(opt("--only").split(",").map(s => s.trim()).filter(Boolean)) : null;
const JOBS    = Math.max(1, Math.min(16, parseInt(opt("--jobs") || "", 10) || Math.min(8, Math.max(1, os.cpus().length - 1))));

// ── child processes ──────────────────────────────────────────────────────────
function runWorker(args, tmpRoot, tag) {
  const home = path.join(tmpRoot, "runs", tag, "home");
  const cwd  = path.join(tmpRoot, "runs", tag, "cwd");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    TMPDIR: path.join(tmpRoot, "runs", tag),
    TZ: "UTC",
    LANG: "en_US.UTF-8",
    BASELINE_TMP_ROOT: tmpRoot,
    TICK_RECORDER_ENABLED: "false",
    NODE_ENV: "test",
  };
  const log = path.join(tmpRoot, "runs", tag, "worker.log");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, ...args, "--log", log], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", d => { stderr += d; });
    child.on("close", (code) => resolve({ code, stderr, log }));
  });
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ── canonical trade view ─────────────────────────────────────────────────────
// Routes name their trade fields differently; this pulls the decision-relevant
// ones into one shape for a readable diff. The FULL trade object is kept too
// (`raw`), so a change to any field is still caught.
const pick = (t, ...keys) => { for (const k of keys) if (t[k] !== undefined && t[k] !== null && t[k] !== "") return t[k]; return null; };
function compactTrade(t) {
  return {
    side:      pick(t, "side", "type"),
    symbol:    pick(t, "symbol", "optionSymbol"),
    strike:    pick(t, "optionStrike", "strike"),
    qty:       pick(t, "qty", "quantity", "lotQty"),
    entryTime: pick(t, "entryTime", "entry"),
    exitTime:  pick(t, "exitTime", "exit"),
    entrySpot: pick(t, "spotAtEntry", "entryPrice", "eSpot"),
    exitSpot:  pick(t, "spotAtExit", "exitPrice", "xSpot"),
    entryLtp:  pick(t, "optionEntryLtp", "entryLtp", "eOpt"),
    exitLtp:   pick(t, "optionExitLtp", "exitLtp", "xOpt"),
    reason:    pick(t, "exitReason", "reason"),
    pnl:       pick(t, "pnl", "netPnl"),
  };
}

function buildGolden(strategy, runs) {
  const sessions = runs.map(r => ({
    date: r.date,
    regime: r.regime,
    ok: r.ok,
    error: r.error || null,
    ticksReplayed: r.ticksReplayed,
    tradeCount: r.tradeCount,
    sessionPnl: r.sessionPnl,
    warmupBlind: r.warmupBlind,
    trades: (r.trades || []).map(compactTrade),
    skips: r.skips,
    raw: r.trades || [],
  }));
  return {
    baselineVersion: BASELINE_VERSION,
    strategy: strategy.route,
    mode: strategy.mode,
    totalTrades: sessions.reduce((n, s) => n + (s.trades ? s.trades.length : 0), 0),
    sessions,
  };
}

// ── diff ─────────────────────────────────────────────────────────────────────
function firstDiff(a, b, p = "") {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return { path: p || "(root)", golden: a, actual: b };
  }
  if (Array.isArray(a) !== Array.isArray(b)) return { path: p, golden: a, actual: b };
  if (Array.isArray(a) && a.length !== b.length) {
    // Report the first differing element (most informative), then the length.
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const d = firstDiff(a[i], b[i], `${p}[${i}]`); if (d) return d; }
    return { path: `${p}.length`, golden: a.length, actual: b.length };
  }
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], Array.isArray(a) ? `${p}[${k}]` : (p ? `${p}.${k}` : k));
    if (d) return d;
  }
  return null;
}
const short = (v) => { const s = JSON.stringify(v); return s === undefined ? "undefined" : (s.length > 300 ? s.slice(0, 300) + "…" : s); };

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const t0 = Date.now();
  const strategies = STRATEGIES.filter(s => !ONLY || ONLY.has(s.route) || ONLY.has(s.mode));
  // A pair runs with --only naming its own name ("emaRsiStV2Paper.SENSEX") or
  // mode, or with no --only at all; naming the route alone selects NIFTY only.
  const pairJobs = PAIRS.filter(p => !ONLY || ONLY.has(p.name) || ONLY.has(p.mode));
  if (!strategies.length && !pairJobs.length) { console.error(`No strategy matches --only=${[...ONLY].join(",")}`); process.exit(2); }

  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "strategy-baseline-")));
  const ticksDir = path.join(tmpRoot, "ticks");
  fs.mkdirSync(ticksDir, { recursive: true });
  let exitCode = 0;
  try {
    // 1. Synthetic recordings (generated in a sandboxed child too — it loads src/config/instrument).
    const specFile = path.join(tmpRoot, "recording-spec.json");
    fs.writeFileSync(specFile, JSON.stringify(RECORDING_SPEC));
    const genOut = path.join(tmpRoot, "generate.json");
    const g = await runWorker(["--generate", "--ticks", ticksDir, "--settings", specFile, "--out", genOut], tmpRoot, "generate");
    if (g.code !== 0) throw new Error(`recording generation failed (exit ${g.code}) — see ${g.log}\n${g.stderr}`);
    const gen = JSON.parse(fs.readFileSync(genOut, "utf8"));
    console.log(`📼 synthetic recordings: ${gen.summary.map(s => `${s.date} ${s.regime}`).join(" · ")}`);

    // 1b. One recording per pair market, in its own ticks dir.
    for (const p of pairJobs) {
      p.ticksDir = path.join(tmpRoot, `ticks-${p.market}`);
      fs.mkdirSync(p.ticksDir, { recursive: true });
      const pSpec = path.join(tmpRoot, `recording-spec-${p.market}.json`);
      fs.writeFileSync(pSpec, JSON.stringify({ ...RECORDING_SPEC, settings: { ...SETTINGS, [p.enabledKey]: "true" }, modes: [p.mode] }));
      const pOut = path.join(tmpRoot, `generate-${p.market}.json`);
      const pg = await runWorker(["--generate", "--market", p.market, "--ticks", p.ticksDir, "--settings", pSpec, "--out", pOut], tmpRoot, `generate-${p.market}`);
      if (pg.code !== 0) throw new Error(`${p.market} recording generation failed (exit ${pg.code}) — see ${pg.log}\n${pg.stderr}`);
      const pr = JSON.parse(fs.readFileSync(pOut, "utf8"));
      console.log(`📼 ${p.market}: ${pr.summary.map(s => `${s.date.slice(5)}→${s.expiry.slice(5)}`).join(" ")}`);
    }

    // 2. One child per (strategy, session).
    const jobs = [];
    for (const s of strategies) for (const sess of market.SESSIONS) jobs.push({ s, date: sess.date });
    for (const p of pairJobs) for (const sess of market.SESSIONS) jobs.push({ s: { route: p.name, mode: p.mode }, pair: p, date: sess.date });
    console.log(`▶ ${jobs.length} replays (${strategies.length} strategies + ${pairJobs.length} pairs × ${market.SESSIONS.length} sessions), ${JOBS} in parallel…`);
    const results = await pool(jobs, JOBS, async (job) => {
      const tag = `${job.s.route}-${job.date}`;
      const out = path.join(tmpRoot, "runs", `${tag}.json`);
      const wargs = ["--mode", job.s.mode, "--date", job.date, "--ticks", job.pair ? job.pair.ticksDir : ticksDir, "--out", out];
      if (job.pair) wargs.push("--market", job.pair.market);
      const r = await runWorker(wargs, tmpRoot, tag);
      let res;
      try { res = JSON.parse(fs.readFileSync(out, "utf8")); }
      catch (_) { res = { ok: false, error: `worker exit ${r.code}, no result (log: ${r.log}) ${r.stderr.slice(0, 500)}` }; }
      res.date = res.date || job.date;
      res.regime = res.regime || (market.SESSIONS.find(x => x.date === job.date) || {}).regime;
      res._log = r.log;
      if (VERBOSE) console.log(`   ${tag}: ${res.ok ? `${(res.trades || []).length} trade(s)` : `FAILED ${res.error}`}`);
      return { job, res };
    });

    // 3. Sandbox integrity: no write may escape, every run must have completed.
    const problems = [];
    for (const { job, res } of results) {
      const d = res._diag || {};
      if (d.writeViolations && d.writeViolations.length) problems.push(`${job.s.route} ${job.date}: write outside sandbox: ${d.writeViolations.join("; ")}`);
      if (!res.ok) problems.push(`${job.s.route} ${job.date}: replay failed: ${res.error}`);
    }

    // 4. Golden build / compare.
    const allGoldens = strategies.concat(pairJobs.map(p => ({ route: p.name, mode: p.mode })));
    const byStrategy = new Map(allGoldens.map(s => [s.route, []]));
    for (const { job, res } of results) byStrategy.get(job.s.route).push(res);
    const counts = [];
    let diffs = 0;
    if (!CHECK) fs.mkdirSync(BASELINE_DIR, { recursive: true });
    for (const s of allGoldens) {
      const runs = byStrategy.get(s.route).sort((a, b) => a.date.localeCompare(b.date));
      const golden = buildGolden(s, runs);
      const perDay = golden.sessions.map(x => (x.trades || []).length);
      const netBlocked = runs.reduce((n, r) => n + ((r._diag && r._diag.blockedNetworkCount) || 0), 0);
      counts.push({ strategy: s.route, total: golden.totalTrades, perDay, netBlocked });
      const file = path.join(BASELINE_DIR, `${s.route}.json`);
      const text = JSON.stringify(golden, null, 2) + "\n";
      // Never bless a run that broke the sandbox or failed to complete.
      if (!CHECK) { if (!problems.length) fs.writeFileSync(file, text); continue; }
      if (!fs.existsSync(file)) { diffs++; console.log(`❌ ${s.route}: no golden file ${path.relative(REPO, file)} — run without --check to create it`); continue; }
      const want = JSON.parse(fs.readFileSync(file, "utf8"));
      if (want.baselineVersion !== BASELINE_VERSION) { diffs++; console.log(`❌ ${s.route}: golden is baselineVersion ${want.baselineVersion}, harness is ${BASELINE_VERSION} — regenerate`); continue; }
      if (JSON.stringify(want) === JSON.stringify(golden)) continue;
      diffs++;
      console.log(`❌ ${s.route} (${s.mode}) differs from ${path.relative(REPO, file)}`);
      for (let i = 0; i < Math.max(want.sessions.length, golden.sessions.length); i++) {
        const a = want.sessions[i], b = golden.sessions[i];
        const d = firstDiff(a, b);
        if (!d) continue;
        const date = (a || b).date;
        const na = a && a.trades ? a.trades.length : 0, nb = b && b.trades ? b.trades.length : 0;
        console.log(`   ${date} ${(a || b).regime}: trades golden=${na} actual=${nb}`);
        // Point at the first differing trade in the readable view when there is one.
        const tdiff = a && b ? firstDiff(a.trades, b.trades, "trades") : null;
        const show = tdiff || d;
        console.log(`     first difference at ${show.path}`);
        console.log(`       golden: ${short(show.golden)}`);
        console.log(`       actual: ${short(show.actual)}`);
      }
    }

    // 5. Report.
    console.log("");
    console.log("strategy                          trades  per session (" + market.SESSIONS.map(s => s.date.slice(5)).join(" ") + ")");
    for (const c of counts) console.log(`  ${c.strategy.padEnd(32)}${String(c.total).padStart(5)}   ${c.perDay.map(n => String(n).padStart(5)).join(" ")}`);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (problems.length) {
      exitCode = 1;
      console.log(`\n⚠️  ${problems.length} run problem(s):`);
      for (const p of problems.slice(0, 40)) console.log(`   ${p}`);
    }
    if (CHECK) {
      if (diffs) { exitCode = 1; console.log(`\n❌ baseline check FAILED — ${diffs} strateg${diffs === 1 ? "y" : "ies"} differ (${secs}s)`); }
      else if (!problems.length) console.log(`\n✅ baseline check passed — ${strategies.length} strategies + ${pairJobs.length} pairs byte-identical to tests/baseline (${secs}s)`);
    } else if (!problems.length) {
      console.log(`\n💾 wrote ${allGoldens.length} golden file(s) to ${path.relative(REPO, BASELINE_DIR)}/ (${secs}s)`);
    }
  } catch (e) {
    exitCode = 1;
    console.error(`❌ ${e.stack || e}`);
  } finally {
    if (KEEP || exitCode) console.log(`(temp dir kept: ${tmpRoot})`);
    else fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  process.exit(exitCode);
})();

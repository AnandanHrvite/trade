#!/usr/bin/env node
/**
 * PAPER-RESET INVARIANTS — "Reset Paper" must cover every paper engine, forever
 *
 *   node tests/paperReset.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Nothing here opens
 * a socket, a broker connection or a session, and nothing touches ~/trading-data.
 *
 * The rule this suite defends: the Settings "🧹 RESET PAPER" button (and the Logs
 * page Reset Data dialog) reset EVERY paper strategy the app mounts — including
 * ones that do not exist yet. That only holds if (a) discovery is done from the
 * live Express router stack rather than a list, and (b) every paper route keeps
 * the shape discovery looks for: mounted at `/<x>-paper` with a GET `/reset`.
 *
 * The original Logs-page dialog carried a hand-written list of six strategies
 * while fourteen were mounted; the other eight silently kept their capital and
 * sessions across a "full" reset. GROUP 3 is what stops that from coming back.
 */

const assert  = require("assert");
const fs      = require("fs");
const path    = require("path");
const express = require("express");

const SRC  = path.join(__dirname, "../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

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

const paperReset = require("../src/utils/paperReset");

// ── Fixture app: the shapes real paper routes answer /reset with ─────────────
function buildApp() {
  const app = express();
  const calls = [];
  const mk = (name, handler) => {
    const r = express.Router();
    r.get("/status", (q, s) => s.send("status"));
    if (handler) r.get("/reset", (q, s) => { calls.push(name); handler(q, s); });
    return r;
  };
  app.use("/alpha-paper",   mk("alpha",   (q, s) => s.json({ success: true, message: "alpha cleared" })));
  app.use("/beta_x-paper",  mk("beta",    (q, s) => s.status(400).json({ success: false, error: "Stop beta paper trading first before resetting." })));
  app.use("/gamma-paper",   mk("gamma",   (q, s) => s.status(400).send("<html><body>Cannot Reset — Stop the session first.</body></html>")));
  app.use("/delta-paper",   mk("delta",   (q, s) => s.redirect("/delta-paper/history")));
  app.use("/eps-paper",     mk("eps",     (q, s) => { throw new Error("boom"); }));
  app.use("/zeta-paper",    mk("zeta",    null));                                  // no /reset → not a target
  app.use("/alpha-live",    mk("alive",   (q, s) => s.json({ success: true })));   // live → never touched
  app.use("/alpha-backtest",mk("abt",     (q, s) => s.json({ success: true })));
  app.use("/settings",      mk("settings",(q, s) => s.json({ success: true })));
  return { app, calls };
}

const appSrc = decomment(read("app.js"));
const paperMounts = [...appSrc.matchAll(/app\.use\(\s*"(\/[^"]+-paper)"\s*,\s*require\("\.\/routes\/([A-Za-z0-9_]+)"\)/g)]
  .map(m => ({ mount: m[1], file: m[2] }));
const paperFiles = fs.readdirSync(path.join(SRC, "routes")).filter(f => /Paper\.js$/.test(f)).map(f => f.replace(/\.js$/, ""));

section("GROUP 1 — discovery walks the live router stack, not a list");

check("finds every /<x>-paper mount that owns a GET /reset, in mount order", () => {
  const { app } = buildApp();
  const mounts = paperReset.discoverTargets(app).map(t => t.mount);
  assert.deepStrictEqual(mounts, ["/alpha-paper", "/beta_x-paper", "/gamma-paper", "/delta-paper", "/eps-paper"]);
});

check("a paper mount without /reset, and live/backtest/settings mounts, are never targets", () => {
  const { app } = buildApp();
  const mounts = paperReset.discoverTargets(app).map(t => t.mount);
  for (const m of ["/zeta-paper", "/alpha-live", "/alpha-backtest", "/settings"]) assert(!mounts.includes(m), `${m} was discovered`);
});

check("a strategy mounted AFTER the first discovery is picked up on the next call (no restart, no list edit)", () => {
  const { app } = buildApp();
  const before = paperReset.discoverTargets(app).length;
  const r = express.Router(); r.get("/reset", (q, s) => s.json({ success: true }));
  app.use("/new-strategy-paper", r);
  const after = paperReset.discoverTargets(app).map(t => t.mount);
  assert.strictEqual(after.length, before + 1);
  assert(after.includes("/new-strategy-paper"));
});

check("modeOfMount maps every real mount to the file-name mode key tradeLogger uses", () => {
  const tl = decomment(read("utils/tradeLogger.js"));
  const known = new Set([...tl.matchAll(/^\s*([a-z0-9_]+):\s*"\1_paper_trades_"/gm)].map(m => m[1]));
  assert(known.size >= 14, `only ${known.size} modes parsed from tradeLogger DAILY_PREFIX_BY_MODE`);
  const unmapped = paperMounts.map(m => m.mount).filter(m => !known.has(paperReset.modeOfMount(m)));
  assert.deepStrictEqual(unmapped, [], `mount → mode key not in tradeLogger: ${unmapped.join(", ")}`);
});

check("label is derived from the mount, so nothing needs naming by hand", () => {
  const { app } = buildApp();
  const byMount = Object.fromEntries(paperReset.discoverTargets(app).map(t => [t.mount, t.label]));
  assert.strictEqual(byMount["/beta_x-paper"], "BETA X");
  assert.strictEqual(byMount["/alpha-paper"],  "ALPHA");
});

section("GROUP 2 — dispatch runs each router's OWN /reset and classifies the answer");

check("2xx JSON → ok; 400 JSON running-guard → skipped; 400 HTML running-guard → skipped", async () => {
  const { app, calls } = buildApp();
  const r = await paperReset.resetAllPaperEngines(app);
  const by = Object.fromEntries(r.map(x => [x.mount, x]));
  assert.strictEqual(by["/alpha-paper"].ok, true);
  assert.strictEqual(by["/alpha-paper"].message, "alpha cleared");
  assert.strictEqual(by["/beta_x-paper"].ok, false);
  assert.strictEqual(by["/beta_x-paper"].skipped, true);
  assert.strictEqual(by["/gamma-paper"].ok, false);
  assert.strictEqual(by["/gamma-paper"].skipped, true);
  assert(!/<[^>]+>/.test(by["/gamma-paper"].message), "HTML must be stripped from the message");
  assert.deepStrictEqual(calls, ["alpha", "beta", "gamma", "delta", "eps"], "every target's own handler must run, once, in order");
});

check("redirect-on-success engines (rsi_pivot_st style) count as ok", async () => {
  const { app } = buildApp();
  const r = await paperReset.resetAllPaperEngines(app);
  const d = r.find(x => x.mount === "/delta-paper");
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.skipped, false);
});

check("a handler that throws is reported as failed (not skipped) and does not abort the others", async () => {
  const { app } = buildApp();
  const r = await paperReset.resetAllPaperEngines(app);
  const e = r.find(x => x.mount === "/eps-paper");
  assert.strictEqual(e.ok, false);
  assert.strictEqual(e.skipped, false);
  assert.strictEqual(r.length, 5, "all five targets must still report");
});

check("a handler that never answers resolves as failed after the timeout, not a hang", async () => {
  const app = express();
  const r = express.Router(); r.get("/reset", () => { /* never responds */ });
  app.use("/hang-paper", r);
  const [t] = paperReset.discoverTargets(app);
  const out = await paperReset.dispatchReset(t, { timeoutMs: 50 });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 504);
});

section("GROUP 3 — every real paper route keeps the discoverable shape");

check("app.js mounts at least the fourteen paper engines that existed when this suite was written", () => {
  assert(paperMounts.length >= 14, `only ${paperMounts.length} /<x>-paper mounts found in app.js`);
});

check("every /<x>-paper mount's router defines router.get(\"/reset\") — otherwise Reset Paper silently misses it", () => {
  const missing = paperMounts.filter(({ file }) => !/router\.get\(\s*"\/reset"/.test(decomment(read(`routes/${file}.js`))));
  assert.deepStrictEqual(missing.map(m => m.mount), [], `no GET /reset in: ${missing.map(m => m.file).join(", ")}`);
});

check("every routes/*Paper.js that has a /reset is mounted at a path ending in -paper", () => {
  const mountedFiles = new Set(paperMounts.map(m => m.file));
  const orphans = paperFiles.filter(f => /router\.get\(\s*"\/reset"/.test(decomment(read(`routes/${f}.js`))) && !mountedFiles.has(f));
  assert.deepStrictEqual(orphans, [], `has /reset but no /<x>-paper mount: ${orphans.join(", ")}`);
});

check("every real /reset handler answers JSON — the shared history-page Reset button parses r.json()", () => {
  // RSI_PIVOT_ST and BN_PIVOT_RSI_ST used to redirect to /history (and 400 with an
  // HTML page), so their own Reset button wiped the data and then showed
  // "Server error". paperHistoryUI.confirmReset() is shared by all 14 pages.
  const bad = [];
  for (const { file } of paperMounts) {
    const src = decomment(read(`routes/${file}.js`));
    const start = src.indexOf('router.get("/reset"');
    if (start < 0) continue;
    const body = src.slice(start, src.indexOf("\n});", start));
    if (!/res\.json\(/.test(body) || /res\.redirect\(|_errorPage\(/.test(body)) bad.push(file);
  }
  assert.deepStrictEqual(bad, [], `non-JSON /reset in: ${bad.join(", ")}`);
});

check("settings.js /reset-paper and tradeLogs.js carry no hand-written strategy list", () => {
  const settings  = decomment(read("routes/settings.js"));
  const tradeLogs = decomment(read("routes/tradeLogs.js"));
  assert(!/RESET_PAPER_MODES/.test(settings), "RESET_PAPER_MODES list is back in settings.js");
  assert(!/-paper\/reset'/.test(tradeLogs), "tradeLogs.js fans out to hard-coded /<x>-paper/reset URLs again");
  assert(/paperReset\.discoverTargets\(req\.app\)/.test(settings), "settings.js must discover targets from req.app");
  assert(/discoverTargets\(req\.app\)\.length === 0/.test(settings), "settings.js /reset-paper must refuse when discovery finds nothing");
  assert(/req\.body\.skip === false/.test(settings), "settings.js /reset-paper must honour body.skip === false (Logs dialog with Skip unchecked)");
  assert(/excludeModes:\s*skippedModes/.test(settings), "settings.js /reset-paper must leave a running (skipped) engine's files alone");
  assert(/JSON\.stringify\(\{ skip: cats\.skip \}\)/.test(tradeLogs), "tradeLogs.js must pass the Skip checkbox to /settings/reset-paper");
  assert(/paperReset\.resetAllPaperEngines\(req\.app\)/.test(settings), "settings.js must reset via resetAllPaperEngines(req.app)");
  assert(/secretFetch\('\/settings\/reset-paper'/.test(tradeLogs), "tradeLogs.js must delegate the full paper wipe to /settings/reset-paper");
});

check("Reset Paper never writes .env — the endpoint touches no settings writer", () => {
  const settings = decomment(read("routes/settings.js"));
  const start = settings.indexOf('router.post("/reset-paper"');
  const end   = settings.indexOf('router.post("/reset-data"');
  assert(start > 0 && end > start, "could not locate the /reset-paper handler");
  const body = settings.slice(start, end);
  assert(!/writeEnv|saveEnv|\.env|fs\.writeFileSync/.test(body), "/reset-paper must not write settings");
});

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

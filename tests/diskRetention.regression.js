#!/usr/bin/env node
/**
 * DISK RETENTION INVARIANTS — the /monitor clean-up may only ever delete what it says
 *
 *   node tests/diskRetention.regression.js
 *
 * Zero dependencies, exits non-zero on failure. Everything runs inside a fresh
 * temp HOME + temp repo dir with a fixed IST clock; the real ~/trading-data and
 * data/ticks are never read or written.
 *
 * Rules defended:
 *   - keep N days: a file exactly N days old is kept, N+1 days old is deleted,
 *     and today's files are never deleted.
 *   - trade logs, post_exit, backups, root books and tokens are never deleted,
 *     even by a forged plan.
 *   - nothing is deleted 09:00–15:30 IST on a weekday, by hand or by the daily job.
 *   - the dry-run list is exactly what gets deleted — nothing more.
 *   - defaults delete no more than the app already did (ticks 30d, backtest 90d,
 *     server logs 7d; everything else off), and nothing runs at boot.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");

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

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "diskret-"));
process.env.HOME = path.join(TMP_ROOT, "home-default");   // belt and braces: nothing may land in the real HOME
const dr = require("../src/utils/diskRetention");

const DAY = 86400000;
// Wednesday 2026-11-11 17:00 IST (11:30 UTC) — after close, a weekday.
const NOW = Date.UTC(2026, 10, 11, 11, 30);
const IST = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - 19800000;

let _n = 0;
function fixture(env) {
  const root = path.join(TMP_ROOT, `fx${++_n}`);
  const home = path.join(root, "home");
  const dataDir = path.join(home, "trading-data");
  const ticksDir = path.join(root, "repo", "data", "ticks");
  const pm2LogsDir = path.join(home, ".pm2", "logs");
  const put = (p, body, mtimeMs) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body || "x".repeat(100));
    if (mtimeMs != null) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
    return p;
  };
  const old = NOW - 400 * DAY;
  const f = {
    // ticks — dated by folder name
    tickToday:  put(path.join(ticksDir, "2026-11-11", "spot.jsonl")),
    tick30:     put(path.join(ticksDir, "2026-10-12", "spot.jsonl")),   // exactly 30 days → kept
    tick31:     put(path.join(ticksDir, "2026-10-11", "spot.jsonl")),   // 31 days → deleted
    tickOld:    put(path.join(ticksDir, "2026-01-01", "options.jsonl")),
    tickMisc:   put(path.join(ticksDir, "notes", "readme.txt"), "x", old),  // not a date dir → ignored
    replayOld:  put(path.join(ticksDir, "_replay_trades", "orb-paper_replay.jsonl"), "x", old),
    replayNew:  put(path.join(ticksDir, "_replay_trades_sim", "pa-paper_sim.jsonl"), "x", NOW - DAY),
    // backtest cache — dated by mtime
    btToday:    put(path.join(dataDir, "backtest_cache", "a.json"), "x", NOW - 60000),
    bt90:       put(path.join(dataDir, "backtest_cache", "b.json"), "x", NOW - 90 * DAY),
    bt91:       put(path.join(dataDir, "backtest_cache", "c.json"), "x", NOW - 91 * DAY),
    bt200:      put(path.join(dataDir, "backtest_cache", "sub", "d.json"), "x", NOW - 200 * DAY),
    candleOld:  put(path.join(dataDir, "candle_cache", "NIFTY_5.json"), "x", old),
    // server logs — dated by file name
    logToday:   put(path.join(dataDir, "server_logs", "2026-11-11.jsonl")),
    log7:       put(path.join(dataDir, "server_logs", "2026-11-04.jsonl")),
    log8:       put(path.join(dataDir, "server_logs", "2026-11-03.jsonl")),
    // protected — all ancient
    trades:     put(path.join(dataDir, "trades", "orb_paper_trades_2025-01-01.jsonl"), "x", old),
    postExit:   put(path.join(dataDir, "post_exit", "2025-01-01.jsonl"), "x", old),
    backup:     put(path.join(dataDir, "_backups", "backup-2025-01-01.tar.gz"), "x", old),
    book:       put(path.join(dataDir, "orb_paper_trades.json"), "x", old),
    token:      put(path.join(dataDir, ".fyers_token"), "x", old),
    // pm2
    pm2Live:    put(path.join(pm2LogsDir, "trading-bot-out.log"), "line\n", old),
    pm2Rotated: put(path.join(pm2LogsDir, "trading-bot-out__2025-01-01_00-00-00.log"), "line\n", old),
    pm2Err:     put(path.join(pm2LogsDir, "trading-bot-error.log"), "line\n", NOW - 60000),
  };
  const ctx = { home, dataDir, ticksDir, pm2LogsDir, now: () => NOW, env: env || {} };
  return { ctx, f, root, dataDir };
}
const ex = (p) => fs.existsSync(p);
function allFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allFiles(p, out); else out.push(p);
  }
  return out;
}
const covers = (plan, p) => plan.items.some(it => it.path === p || p.startsWith(it.path + path.sep));

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 1 — keep-days boundaries");
// ─────────────────────────────────────────────────────────────────────────────
check("ticks keep 30: today and exactly-30-days kept; 31 days and older listed", async () => {
  const { ctx, f } = fixture();
  const plan = await dr.planCleanup("ticks", 30, ctx);
  assert.strictEqual(plan.cutoffDate, "2026-10-12");
  assert(covers(plan, f.tick31), "31-day-old tick folder must be listed");
  assert(covers(plan, f.tickOld), "ancient tick folder must be listed");
  assert(!covers(plan, f.tick30), "exactly 30-day-old tick folder must be kept");
  assert(!covers(plan, f.tickToday), "today's ticks must be kept");
  assert(!covers(plan, f.tickMisc), "a non-date folder under ticks must never be listed");
  assert(!covers(plan, f.replayOld), "replay outputs are not tick recordings");
  assert.strictEqual(plan.items.length, 2);
  assert.strictEqual(plan.files, 2);
});

check("candle cache keep 90 (mtime): a 400-day-old file is listed", async () => {
  const { ctx, f } = fixture();
  const plan = await dr.planCleanup("candle_cache", 90, ctx);
  assert.deepStrictEqual(plan.items.map(i => i.path), [f.candleOld]);
});

check("server logs keep 7 (by file name): 7 days kept, 8 listed", async () => {
  const { ctx, f } = fixture();
  const plan = await dr.planCleanup("server_logs", 7, ctx);
  assert.deepStrictEqual(plan.items.map(i => i.path), [f.log8]);
});

check("keep 1 still never lists anything dated today", async () => {
  const { ctx, f } = fixture();
  for (const key of ["candle_cache", "server_logs", "replay", "pm2_logs"]) {
    const plan = await dr.planCleanup(key, 1, ctx);
    for (const p of [f.btToday, f.logToday, f.pm2Err, f.replayNew]) {
      assert(!covers(plan, p), `${key} keep 1 listed a file from today/yesterday: ${p}`);
    }
  }
  const plan = await dr.planCleanup("ticks", 7, ctx);
  assert(!covers(plan, f.tickToday));
});

check("bad keep-days are refused: 0, negative, fractional, ticks below 7", async () => {
  const { ctx } = fixture();
  for (const [key, d] of [["candle_cache", 0], ["candle_cache", -3], ["candle_cache", 1.5], ["ticks", 6], ["ticks", NaN]]) {
    await assert.rejects(() => dr.planCleanup(key, d, ctx), undefined, `${key} keep ${d} should be refused`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 2 — protected data is never touched");
// ─────────────────────────────────────────────────────────────────────────────
check("protected folders cannot even be planned", async () => {
  const { ctx } = fixture();
  for (const key of ["trade_logs", "post_exit", "backups", "backtest_cache"]) {
    await assert.rejects(() => dr.planCleanup(key, 1, ctx), /protected/);
  }
});

check("a forged plan pointing at trades / post_exit / books / tokens deletes nothing", async () => {
  const { ctx, f } = fixture();
  const targets = [f.trades, f.postExit, f.backup, f.book, f.token, path.join(ctx.dataDir, "trades")];
  const plan = { key: "candle_cache", cutoffDate: "9999-12-31", items: targets.map(p => ({ path: p, isDir: false, action: "delete", bytes: 1, files: 1 })) };
  const r = await dr.applyPlan(plan, ctx);
  assert.strictEqual(r.deleted.length, 0);
  for (const p of targets) assert(ex(p), `protected path was removed: ${p}`);
  // and a forged plan for a protected folder key is refused outright
  const r2 = await dr.applyPlan({ key: "trade_logs", cutoffDate: "9999-12-31", items: [{ path: f.trades, action: "delete" }] }, ctx);
  assert.strictEqual(r2.ok, false);
  assert(ex(f.trades));
});

check("the most aggressive auto-clean-up leaves every protected file in place", async () => {
  const env = { TICK_RECORDER_RETAIN_DAYS: "1", CANDLE_CACHE_KEEP_DAYS: "1",
    REPLAY_OUTPUT_KEEP_DAYS: "1", SERVER_LOG_RETAIN_DAYS: "1", PM2_LOG_MAX_MB: "1" };
  const { ctx, f } = fixture(env);
  const r = await dr.runAutoCleanup({ ctx });
  assert.strictEqual(r.ran, true);
  for (const p of [f.trades, f.postExit, f.backup, f.book, f.token, f.bt91, f.bt200]) assert(ex(p), `protected file deleted: ${p}`);
  for (const p of [f.tickToday, f.btToday, f.logToday, f.pm2Err]) assert(ex(p), `today's file deleted: ${p}`);
});

check("ticks keep-days below 7 is clamped to 7 by the daily job", () => {
  const def = dr.folderByKey("ticks", {});
  assert.strictEqual(dr.keepDaysFor(def, { env: { TICK_RECORDER_RETAIN_DAYS: "2" } }), 7);
});

check("symlinks inside a cleanable folder are never followed or deleted", async () => {
  const { ctx, f } = fixture();
  const link = path.join(ctx.dataDir, "candle_cache", "link-to-trades");
  fs.symlinkSync(path.join(ctx.dataDir, "trades"), link);
  const plan = await dr.planCleanup("candle_cache", 1, ctx);
  assert(!plan.items.some(i => i.path.startsWith(link)), "symlink was listed");
  await dr.applyPlan(plan, ctx);
  assert(ex(f.trades) && fs.lstatSync(link).isSymbolicLink());
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 3 — market-hours block");
// ─────────────────────────────────────────────────────────────────────────────
check("09:00–15:30 IST on a weekday is blocked; edges and weekends are not", () => {
  assert.strictEqual(dr.isMarketHoursBlocked(IST(2026, 11, 11, 8, 59)), false);
  assert.strictEqual(dr.isMarketHoursBlocked(IST(2026, 11, 11, 9, 0)), true);
  assert.strictEqual(dr.isMarketHoursBlocked(IST(2026, 11, 11, 12, 0)), true);
  assert.strictEqual(dr.isMarketHoursBlocked(IST(2026, 11, 11, 15, 30)), true);
  assert.strictEqual(dr.isMarketHoursBlocked(IST(2026, 11, 11, 15, 31)), false);
  assert.strictEqual(dr.isMarketHoursBlocked(IST(2026, 11, 14, 11, 0)), false, "Saturday is not market hours");
});

check("a manual delete during market hours removes nothing", async () => {
  const { ctx, f } = fixture();
  const plan = await dr.planCleanup("candle_cache", 90, ctx);
  assert(plan.items.length > 0);
  const r = await dr.applyPlan(plan, Object.assign({}, ctx, { now: () => IST(2026, 11, 11, 10, 30) }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.blocked, true);
  assert(ex(f.candleOld), "files were deleted during market hours");
});

check("the daily job does not run during market hours", async () => {
  const { ctx, f } = fixture();
  const r = await dr.runAutoCleanup({ ctx: Object.assign({}, ctx, { now: () => IST(2026, 11, 11, 11, 0) }) });
  assert.strictEqual(r.ran, false);
  assert(ex(f.tick31) && ex(f.bt91) && ex(f.log8));
});

check("PM2 size trim does nothing during market hours", async () => {
  const { ctx, f } = fixture();
  fs.writeFileSync(f.pm2Err, "y".repeat(3 * 1024 * 1024));
  const r = await dr.trimPm2Logs(1, Object.assign({}, ctx, { now: () => IST(2026, 11, 11, 10, 0) }));
  assert.strictEqual(r.trimmed.length, 0);
  assert.strictEqual(fs.statSync(f.pm2Err).size, 3 * 1024 * 1024);
});

check("scheduler: only after 16:30 IST, never in the first 30 min after boot, once a day, toggle respected", () => {
  const should = dr._internals._shouldAutoRun;
  const on = { env: {} }, off = { env: { DISK_AUTO_CLEANUP_ENABLED: "false" } };
  assert.strictEqual(should(IST(2026, 11, 11, 16, 0), 99999, null, on), false, "16:00 is before the run window");
  assert.strictEqual(should(IST(2026, 11, 11, 16, 30), 99999, null, on), true);
  assert.strictEqual(should(IST(2026, 11, 11, 17, 0), 60, null, on), false, "must not run right after boot");
  assert.strictEqual(should(IST(2026, 11, 11, 17, 0), 99999, "2026-11-11", on), false, "already ran today");
  assert.strictEqual(should(IST(2026, 11, 11, 17, 0), 99999, null, off), false, "toggle off");
  assert.strictEqual(should(IST(2026, 11, 12, 10, 0), 99999, "2026-11-11", on), false, "next morning is before the window");
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 4 — the dry run is exactly what gets deleted");
// ─────────────────────────────────────────────────────────────────────────────
for (const [key, days] of [["ticks", 30], ["server_logs", 7], ["replay", 30], ["candle_cache", 30], ["pm2_logs", 30]]) {
  check(`${key} keep ${days}: deleted set == preview set, every other file untouched`, async () => {
    const { ctx, root } = fixture();
    const before = allFiles(root);
    const plan = await dr.planCleanup(key, days, ctx);
    const r = await dr.applyPlan(plan, ctx);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.deleted.slice().sort(), plan.items.map(i => i.path).sort(), "deleted list differs from the preview");
    assert.strictEqual(r.bytesFreed, plan.bytes);
    for (const p of before) {
      const it = plan.items.find(i => i.path === p || p.startsWith(i.path + path.sep));
      if (!it) assert(ex(p), `${p} was not in the preview but is gone`);
      else if (it.action === "empty") assert.strictEqual(fs.statSync(p).size, 0, `${p} should be emptied, not removed`);
      else assert(!ex(p), `${p} was in the preview but still exists`);
    }
  });
}

check("a file touched after the preview is skipped, not deleted", async () => {
  const { ctx, f } = fixture();
  const plan = await dr.planCleanup("candle_cache", 90, ctx);
  fs.utimesSync(f.candleOld, new Date(NOW), new Date(NOW));    // a backtest just used it
  const r = await dr.applyPlan(plan, ctx);
  assert(ex(f.candleOld), "touched file was deleted");
  assert.strictEqual(r.skipped.length, 1);
});

check("PM2: old live log is emptied (PM2 keeps its handle), old rotated copy deleted, recent log untouched", async () => {
  const { ctx, f } = fixture();
  const plan = await dr.planCleanup("pm2_logs", 30, ctx);
  const byPath = Object.fromEntries(plan.items.map(i => [i.path, i.action]));
  assert.strictEqual(byPath[f.pm2Live], "empty");
  assert.strictEqual(byPath[f.pm2Rotated], "delete");
  assert(!(f.pm2Err in byPath));
});

check("PM2 size cap keeps the newest whole lines and stays under the cap", async () => {
  const { ctx, f } = fixture();
  const lines = []; for (let i = 0; i < 40000; i++) lines.push(`line ${i} ` + "z".repeat(60));
  fs.writeFileSync(f.pm2Err, lines.join("\n") + "\n");
  const r = await dr.trimPm2Logs(1, ctx);
  assert.deepStrictEqual(r.trimmed, [f.pm2Err]);
  const after = fs.readFileSync(f.pm2Err, "utf-8");
  assert(after.length <= 512 * 1024, `trimmed file is ${after.length} bytes`);
  assert(after.endsWith(`line 39999 ${"z".repeat(60)}\n`), "the newest line must survive");
  assert(/^line \d+ /.test(after), "trim must start on a whole line");
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 5 — defaults and the usage report");
// ─────────────────────────────────────────────────────────────────────────────
check("defaults: ticks 30, server logs 7; backtest history protected; candle cache, replay and PM2 size off", () => {
  const k = (key) => dr.keepDaysFor(dr.folderByKey(key, {}), { env: {} });
  assert.strictEqual(k("ticks"), 30);
  assert.strictEqual(dr.folderByKey("backtest_cache", {}).protected, true);
  assert.strictEqual(k("server_logs"), 7);
  assert.strictEqual(k("candle_cache"), 0);
  assert.strictEqual(k("replay"), 0);
  assert.strictEqual(dr.autoStatus({ env: {} }).pm2MaxMB, 0);
  assert.strictEqual(dr.autoStatus({ env: {} }).enabled, true);
});

check("auto-clean-up with default settings removes only what the app already pruned", async () => {
  const { ctx, f } = fixture({});
  await dr.runAutoCleanup({ ctx });
  for (const p of [f.tick31, f.tickOld, f.log8]) assert(!ex(p), `${p} should be pruned by defaults`);
  for (const p of [f.tick30, f.tickToday, f.bt90, f.bt91, f.bt200, f.btToday, f.log7, f.candleOld, f.replayOld, f.pm2Live, f.pm2Rotated])
    assert(ex(p), `${p} must survive default settings`);
});

check("a running backtest makes the daily job skip the candle cache", async () => {
  const { ctx, f } = fixture({ CANDLE_CACHE_KEEP_DAYS: "30" });
  const r = await dr.runAutoCleanup({ ctx, isBacktestBusy: () => true });
  assert(ex(f.bt91) && ex(f.candleOld));
  assert(r.results.some(x => x.key === "candle_cache" && x.skipped));
});

check("report: per-folder size, count and date range; ticks exclude replay outputs", async () => {
  const { ctx } = fixture();
  const rep = await dr.getDiskReport({ ctx });
  const by = Object.fromEntries(rep.folders.map(x => [x.key, x]));
  assert.strictEqual(by.ticks.files, 4);
  assert.strictEqual(by.ticks.oldest, "2026-01-01");
  assert.strictEqual(by.ticks.newest, "2026-11-11");
  assert.strictEqual(by.replay.files, 2);
  assert.strictEqual(by.backtest_cache.files, 4);
  assert.strictEqual(by.server_logs.oldest, "2026-11-03");
  assert.strictEqual(by.trade_logs.protected, true);
  assert.strictEqual(by.trade_logs.deletable, false);
  for (const key of ["ticks", "backtest_cache", "candle_cache", "replay", "server_logs", "pm2_logs", "post_exit", "trade_logs"]) {
    assert(by[key], `report is missing ${key}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 6 — wiring");
// ─────────────────────────────────────────────────────────────────────────────
const SRC = path.join(__dirname, "..", "src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");

check("delete is a protected /monitor/action/* POST; only the read-only report is open", () => {
  const mon = read("routes/monitor.js");
  const app = read("app.js");
  assert(/router\.post\("\/action\/disk-delete"/.test(mon));
  assert(/secretFetch\('\/monitor\/action\/disk-delete'/.test(mon), "UI must call the delete through secretFetch");
  assert(/secretFetch\('\/monitor\/disk\/preview/.test(mon), "UI must preview through secretFetch");
  assert(/"\/monitor\/disk",/.test(app), "/monitor/disk (read-only report) should be open");
  assert(!/"\/monitor\/disk\/preview"/.test(app), "the preview must not be an open path");
  assert(!/"\/monitor\/action/.test(app), "no /monitor/action route may be opened");
  assert(/showDoubleConfirm\(/.test(mon.slice(mon.indexOf("async function diskDelete"))), "delete must require a confirm");
});

check("nothing deletes at boot: app.js only schedules the job", () => {
  const app = read("app.js");
  assert(/diskRetention"\)\.startAutoCleanup\(/.test(app));
  assert(!/runAutoCleanup\(/.test(app), "app.js must not run the clean-up directly");
});

check("Settings exposes every retention key in a System section", () => {
  const s = read("routes/settings.js");
  const start = s.indexOf('section: "Disk & Retention"');
  assert(start > 0, "Disk & Retention section missing");
  const block = s.slice(start, s.indexOf("fields: [", start) + 6000);
  assert(/group: "System"/.test(block.slice(0, 200)));
  for (const k of ["DISK_AUTO_CLEANUP_ENABLED", "TICK_RECORDER_RETAIN_DAYS",
                   "CANDLE_CACHE_KEEP_DAYS", "REPLAY_OUTPUT_KEEP_DAYS", "SERVER_LOG_RETAIN_DAYS", "PM2_LOG_MAX_MB"]) {
    assert(block.includes(`key: "${k}"`), `${k} missing from the Disk & Retention section`);
    assert.strictEqual(s.split(`key: "${k}"`).length - 1, 1, `${k} must appear exactly once in the schema`);
  }
});

check("npm test runs this suite", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
  assert(pkg.scripts.test.includes("tests/diskRetention.regression.js"));
});

run().then(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

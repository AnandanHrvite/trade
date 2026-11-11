/**
 * diskRetention.js — Disk usage report + retention clean-up for /monitor
 * ─────────────────────────────────────────────────────────────────────────────
 * One place that knows which folders the app fills, how big they are, and which
 * of them may be trimmed. Three callers:
 *
 *   getDiskReport()          → per-folder size / file count / oldest + newest
 *                              date, walked with fs.promises (never blocks the
 *                              event loop), work-capped and cached ~60 s.
 *   planCleanup(key, days)   → DRY RUN: the exact list of files a
 *                              "Delete older than N days" would remove.
 *   applyPlan(plan)          → deletes exactly the files of a plan (each one
 *                              re-checked first) — never anything the plan did
 *                              not list.
 *   runAutoCleanup()         → the daily job: applies each folder's keep-days
 *                              setting. startAutoCleanup() schedules it.
 *
 * Safety rules (the regression suite tests/diskRetention.regression.js pins them):
 *   - Trade logs (trades/), post_exit/, backups, the *.json books and tokens at
 *     the ~/trading-data root are PROTECTED: shown on the panel, never deleted.
 *   - Anything dated today (IST) is never deleted. Keep N days = a file exactly
 *     N days old is kept; N+1 days old is deleted (same rule as tickRecorder).
 *   - No deletion between 09:00 and 15:30 IST on a weekday (market hours), for
 *     the manual buttons and the daily job alike.
 *   - Nothing runs at boot: the daily job fires only after 16:30 IST, and never
 *     in the first 30 minutes after the process starts.
 *   - Symlinks are never followed or deleted.
 *
 * Keep-days settings (0 = never auto-delete that folder):
 *   TICK_RECORDER_RETAIN_DAYS  30   (min 7 — ticks are the source of truth for /replay)
 *   BACKTEST_CACHE_KEEP_DAYS   90   (same as backtestCache's own built-in prune)
 *   CANDLE_CACHE_KEEP_DAYS     0
 *   REPLAY_OUTPUT_KEEP_DAYS    0
 *   SERVER_LOG_RETAIN_DAYS     7    (logArchive prunes on its own as well)
 *   PM2_LOG_MAX_MB             0    (PM2 log over this size is cut to its last 2 MB)
 *   DISK_AUTO_CLEANUP_ENABLED  true
 */

const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const crypto = require("crypto");

const DAY_MS        = 86400000;
const IST_OFFSET_MS = 19800000;
const DATE_RE       = /^\d{4}-\d{2}-\d{2}$/;
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:\.|$)/;
// PM2 writes to <app>-out.log / <app>-error.log (optionally -<id>). Anything else
// in ~/.pm2/logs is a rotated copy (pm2-logrotate: app-out__2026-11-10_00-00-00.log).
const PM2_ACTIVE_RE = /^.+-(?:out|error)(?:-\d+)?\.log$/;
const PM2_TAIL_KEEP_BYTES = 2 * 1024 * 1024;

const MAX_ENTRIES   = 100000;   // per folder walk — caps work on a pathological tree
const STAT_BATCH    = 16;
const REPORT_TTL_MS = 60000;
const PLAN_TTL_MS   = 10 * 60000;
const MAX_PLANS     = 20;
const AUTO_MIN_IST  = 16 * 60 + 30;   // daily job runs at/after 16:30 IST (after the 16:00 backup)
const AUTO_BOOT_GRACE_SEC = 1800;     // never within 30 min of process start
const AUTO_CHECK_MS = 10 * 60000;

// ── Context: real paths by default; tests pass temp dirs + a fake clock ──────
function defaultCtx() {
  const home = os.homedir();
  const repoRoot = path.resolve(__dirname, "..", "..");
  return {
    home,
    dataDir:    path.join(home, "trading-data"),
    ticksDir:   path.join(repoRoot, "data", "ticks"),
    pm2LogsDir: path.join(process.env.PM2_HOME || path.join(home, ".pm2"), "logs"),
    now:        () => Date.now(),
    env:        process.env,
  };
}
function ctxOf(ctx) { return Object.assign(defaultCtx(), ctx || {}); }

// ── IST helpers ──────────────────────────────────────────────────────────────
function istDate(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const m = d.getUTCMonth() + 1, dd = d.getUTCDate();
  return `${d.getUTCFullYear()}-${m < 10 ? "0" : ""}${m}-${dd < 10 ? "0" : ""}${dd}`;
}
function istMinutes(ms) { const d = new Date(ms + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function istWeekday(ms) { return new Date(ms + IST_OFFSET_MS).getUTCDay(); }

/** True between 09:00 and 15:30 IST, Monday–Friday — no deletion then. */
function isMarketHoursBlocked(ms) {
  const wd = istWeekday(ms);
  if (wd === 0 || wd === 6) return false;
  const m = istMinutes(ms);
  return m >= 9 * 60 && m <= 15 * 60 + 30;
}

// ── Folder catalogue ─────────────────────────────────────────────────────────
// unit: dateDir  = YYYY-MM-DD sub-folders, dated by name   (ticks)
//       dateFile = YYYY-MM-DD.* files, dated by name       (server logs)
//       file     = every file in the tree, dated by mtime  (caches, replay output)
//       pm2      = flat PM2 log dir; live logs are emptied, rotated ones deleted
function folders(ctx) {
  const c = ctxOf(ctx);
  const d = c.dataDir, t = c.ticksDir;
  return [
    { key: "ticks", label: "Tick recordings", bases: [t], unit: "dateDir",
      keepKey: "TICK_RECORDER_RETAIN_DAYS", keepDefault: 30, minKeep: 7,
      note: "Recorded market data — what /replay plays back. Deleted days cannot be replayed again." },
    { key: "backtest_cache", label: "Backtest cache", bases: [path.join(d, "backtest_cache")], unit: "file",
      keepKey: "BACKTEST_CACHE_KEEP_DAYS", keepDefault: 90, minKeep: 1, busyOnBacktest: true,
      note: "Downloaded history for backtests. Safe to delete — a backtest re-downloads it from Fyers." },
    { key: "candle_cache", label: "Candle cache", bases: [path.join(d, "candle_cache")], unit: "file",
      keepKey: "CANDLE_CACHE_KEEP_DAYS", keepDefault: 0, minKeep: 1, busyOnBacktest: true,
      note: "Cached intraday candles. Safe to delete — re-downloaded when needed." },
    { key: "replay", label: "Replay outputs", bases: [path.join(t, "_replay_trades"), path.join(t, "_replay_trades_sim"), path.join(t, "_replay_cache")], unit: "file",
      keepKey: "REPLAY_OUTPUT_KEEP_DAYS", keepDefault: 0, minKeep: 1,
      note: "Results of past /replay runs. Safe to delete — re-run the replay to get them back." },
    { key: "server_logs", label: "Server logs", bases: [path.join(d, "server_logs")], unit: "dateFile",
      keepKey: "SERVER_LOG_RETAIN_DAYS", keepDefault: 7, minKeep: 1,
      note: "Daily copy of the server console (Logs → Server Logs)." },
    { key: "pm2_logs", label: "PM2 logs", bases: [c.pm2LogsDir], unit: "pm2",
      keepKey: null, keepDefault: 0, minKeep: 1, sizeKey: "PM2_LOG_MAX_MB",
      note: "PM2's own stdout/stderr files. Old live logs are emptied, old rotated copies deleted." },
    { key: "post_exit", label: "Post-exit data", bases: [path.join(d, "post_exit")], unit: "file", protected: true,
      note: "Price path after each exit. Protected — never deleted here." },
    { key: "trade_logs", label: "Trade logs", bases: [path.join(d, "trades")], unit: "file", protected: true,
      note: "Per-day trade audit logs. Protected — never deleted here." },
    { key: "backups", label: "Backups", bases: [path.join(d, "_backups")], unit: "file", protected: true,
      note: "Daily backup snapshots — managed under Settings → Backup & Restore." },
  ];
}
function folderByKey(key, ctx) { return folders(ctx).find(f => f.key === key) || null; }

// Paths no code path in this module may ever remove, whatever a plan says.
function protectedRoots(ctx) {
  const c = ctxOf(ctx);
  return ["trades", "post_exit", "_backups"].map(n => path.join(c.dataDir, n));
}
function isInside(p, dir) {
  const rp = path.resolve(p), rd = path.resolve(dir);
  return rp.startsWith(rd + path.sep);
}
/** A path is deletable only if it sits under one of the folder's bases and
 *  under none of the protected roots, and is not a loose ~/trading-data file. */
function isSafeTarget(p, def, ctx) {
  const c = ctxOf(ctx);
  if (!def || def.protected) return false;
  if (!def.bases.some(b => isInside(p, b))) return false;
  if (protectedRoots(c).some(r => path.resolve(p) === path.resolve(r) || isInside(p, r))) return false;
  if (path.dirname(path.resolve(p)) === path.resolve(c.dataDir)) return false; // books / tokens
  if (/\.(fyers|zerodha)_token$/.test(p)) return false;
  return true;
}

// ── Keep-days settings (read live from env) ──────────────────────────────────
function readInt(env, key, def) {
  const n = parseInt(env[key], 10);
  return Number.isFinite(n) ? n : def;
}
/** Effective keep-days for the daily job: 0 = off; otherwise never below minKeep. */
function keepDaysFor(def, ctx) {
  if (!def || !def.keepKey) return 0;
  const n = readInt(ctxOf(ctx).env, def.keepKey, def.keepDefault);
  if (n <= 0) return 0;
  return Math.max(def.minKeep, n);
}
function pm2MaxMB(ctx) { return Math.max(0, readInt(ctxOf(ctx).env, "PM2_LOG_MAX_MB", 0)); }
function autoEnabled(ctx) { return String(ctxOf(ctx).env.DISK_AUTO_CLEANUP_ENABLED || "true").toLowerCase() !== "false"; }

// ── Async walk (lstat, no symlinks, capped) ──────────────────────────────────
async function exists(p) { try { await fs.promises.lstat(p); return true; } catch (_) { return false; } }

async function walkFiles(dir, out, budget) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch (_) { return out; }
  const files = [];
  for (const e of entries) {
    if (budget.left <= 0) { budget.truncated = true; break; }
    if (e.isSymbolicLink()) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { await walkFiles(fp, out, budget); continue; }
    if (e.isFile()) { files.push(fp); budget.left -= 1; }
  }
  for (let i = 0; i < files.length; i += STAT_BATCH) {
    const stats = await Promise.all(files.slice(i, i + STAT_BATCH).map(fp =>
      fs.promises.lstat(fp).then(s => ({ fp, s }), () => null)));
    for (const r of stats) if (r && r.s.isFile()) out.push({ path: r.fp, size: r.s.size, mtimeMs: r.s.mtimeMs });
  }
  return out;
}

async function listDateDirs(base) {
  let entries;
  try { entries = await fs.promises.readdir(base, { withFileTypes: true }); } catch (_) { return []; }
  return entries.filter(e => e.isDirectory() && !e.isSymbolicLink() && DATE_RE.test(e.name))
    .map(e => ({ name: e.name, path: path.join(base, e.name) }));
}

// ── Usage report ─────────────────────────────────────────────────────────────
async function folderUsage(def, ctx) {
  const c = ctxOf(ctx);
  const budget = { left: MAX_ENTRIES, truncated: false };
  let bytes = 0, files = 0, oldest = null, newest = null, any = false;
  const seen = (date) => { if (!oldest || date < oldest) oldest = date; if (!newest || date > newest) newest = date; };
  for (const base of def.bases) {
    if (!(await exists(base))) continue;
    any = true;
    if (def.unit === "dateDir") {
      for (const dd of await listDateDirs(base)) {
        const list = await walkFiles(dd.path, [], budget);
        for (const f of list) { bytes += f.size; files += 1; }
        seen(dd.name);
      }
    } else {
      const list = await walkFiles(base, [], budget);
      for (const f of list) {
        bytes += f.size; files += 1;
        const m = def.unit === "dateFile" && DATE_PREFIX_RE.exec(path.basename(f.path));
        seen(m ? m[1] : istDate(f.mtimeMs));
      }
    }
  }
  return {
    key: def.key, label: def.label, note: def.note, exists: any,
    bytes, files, oldest, newest, truncated: budget.truncated,
    protected: !!def.protected, deletable: !def.protected,
    keepKey: def.keepKey, keepDays: keepDaysFor(def, c), keepDefault: def.keepDefault, minKeep: def.minKeep || 1,
    sizeKey: def.sizeKey || null, maxMB: def.sizeKey ? pm2MaxMB(c) : null,
  };
}

let _report = null, _reportAt = 0, _reportInflight = null;

/** All folders, cached REPORT_TTL_MS; concurrent callers share one walk. */
async function getDiskReport({ force = false, ctx } = {}) {
  const fresh = _report && Date.now() - _reportAt < REPORT_TTL_MS;
  if (!force && !ctx && fresh) return _report;
  if (!ctx && _reportInflight) return _reportInflight;
  const run = (async () => {
    const c = ctxOf(ctx);
    const out = [];
    for (const def of folders(c)) out.push(await folderUsage(def, c));
    return { at: Date.now(), today: istDate(c.now()), folders: out };
  })();
  if (ctx) return run;
  _reportInflight = run;
  try {
    _report = await run;
    _reportAt = Date.now();
    return _report;
  } finally { _reportInflight = null; }
}
function invalidateReport() { _report = null; _reportAt = 0; }

// ── Dry run ──────────────────────────────────────────────────────────────────
/**
 * The exact list of files "keep the last keepDays days" would remove from one
 * folder. Nothing is touched. Throws on a protected folder or a bad keepDays.
 */
async function planCleanup(key, keepDays, ctx) {
  const c = ctxOf(ctx);
  const def = folderByKey(key, c);
  if (!def) throw new Error(`Unknown folder "${key}"`);
  if (def.protected) throw new Error(`${def.label} is protected and is never deleted`);
  const days = Number(keepDays);
  if (!Number.isInteger(days) || days < def.minKeep || days > 3650) {
    throw new Error(`Keep-days for ${def.label} must be a whole number from ${def.minKeep} to 3650`);
  }
  const now = c.now();
  const today = istDate(now);
  const cutoffDate = istDate(now - days * DAY_MS);
  const old = (date) => date < cutoffDate && date < today;
  const items = [];
  const budget = { left: MAX_ENTRIES, truncated: false };

  for (const base of def.bases) {
    if (!(await exists(base))) continue;
    if (def.unit === "dateDir") {
      for (const dd of await listDateDirs(base)) {
        if (!old(dd.name)) continue;
        const list = await walkFiles(dd.path, [], budget);
        items.push({ path: dd.path, date: dd.name, isDir: true, action: "delete",
          files: list.length, bytes: list.reduce((s, f) => s + f.size, 0) });
      }
    } else if (def.unit === "pm2") {
      let entries = [];
      try { entries = await fs.promises.readdir(base, { withFileTypes: true }); } catch (_) {}
      for (const e of entries) {
        if (!e.isFile() || e.isSymbolicLink()) continue;
        const fp = path.join(base, e.name);
        let s; try { s = await fs.promises.lstat(fp); } catch (_) { continue; }
        const date = istDate(s.mtimeMs);
        if (!old(date)) continue;
        const live = PM2_ACTIVE_RE.test(e.name);
        if (live && s.size === 0) continue;   // already empty
        items.push({ path: fp, date, isDir: false, action: live ? "empty" : "delete", files: 1, bytes: s.size, mtimeMs: s.mtimeMs });
      }
    } else {
      for (const f of await walkFiles(base, [], budget)) {
        const m = def.unit === "dateFile" && DATE_PREFIX_RE.exec(path.basename(f.path));
        const date = m ? m[1] : istDate(f.mtimeMs);
        if (!old(date)) continue;
        items.push({ path: f.path, date, isDir: false, action: "delete", files: 1, bytes: f.size, mtimeMs: f.mtimeMs });
      }
    }
  }
  const safe = items.filter(it => isSafeTarget(it.path, def, c));
  safe.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.path < b.path ? -1 : 1));
  return {
    key: def.key, label: def.label, keepDays: days, today, cutoffDate,
    items: safe,
    files: safe.reduce((s, it) => s + it.files, 0),
    bytes: safe.reduce((s, it) => s + it.bytes, 0),
    truncated: budget.truncated,
  };
}

// ── Apply ────────────────────────────────────────────────────────────────────
/**
 * Delete exactly the items of `plan` — each re-checked against the same rules
 * first (still inside the folder, not protected, still older than the cutoff,
 * not dated today). Returns what was removed and what was skipped and why.
 */
async function applyPlan(plan, ctx) {
  const c = ctxOf(ctx);
  const now = c.now();
  if (isMarketHoursBlocked(now)) {
    return { ok: false, blocked: true, error: "Blocked: no deleting between 09:00 and 15:30 IST on weekdays (market hours).", deleted: [], skipped: [], bytesFreed: 0 };
  }
  const def = folderByKey(plan && plan.key, c);
  if (!def || def.protected) return { ok: false, error: "Folder is protected or unknown", deleted: [], skipped: [], bytesFreed: 0 };
  const today = istDate(now);
  const deleted = [], skipped = [];
  let bytesFreed = 0;
  for (const it of plan.items || []) {
    const why = await _recheck(it, def, plan, today, c);
    if (why) { skipped.push({ path: it.path, reason: why }); continue; }
    try {
      if (it.isDir) await fs.promises.rm(it.path, { recursive: true, force: true });
      else if (it.action === "empty") await fs.promises.truncate(it.path, 0);
      else await fs.promises.unlink(it.path);
      deleted.push(it.path);
      bytesFreed += it.bytes;
    } catch (err) {
      skipped.push({ path: it.path, reason: err.message });
    }
  }
  invalidateReport();
  return { ok: true, deleted, skipped, bytesFreed, files: deleted.length };
}

async function _recheck(it, def, plan, today, c) {
  if (!isSafeTarget(it.path, def, c)) return "outside the folder or protected";
  let s;
  try { s = await fs.promises.lstat(it.path); } catch (_) { return "already gone"; }
  if (s.isSymbolicLink()) return "symlink";
  if (it.isDir) {
    if (!s.isDirectory()) return "no longer a folder";
    const name = path.basename(it.path);
    if (!DATE_RE.test(name) || name >= plan.cutoffDate || name >= today) return "not old enough";
    return null;
  }
  if (!s.isFile()) return "no longer a file";
  const m = def.unit === "dateFile" && DATE_PREFIX_RE.exec(path.basename(it.path));
  const date = m ? m[1] : istDate(s.mtimeMs);
  if (date >= plan.cutoffDate || date >= today) return "changed since the preview";
  return null;
}

// ── Preview store: the delete button deletes exactly what it previewed ──────
const _plans = new Map();
function storePlan(plan) {
  const now = Date.now();
  for (const [id, p] of _plans) if (now - p.at > PLAN_TTL_MS) _plans.delete(id);
  while (_plans.size >= MAX_PLANS) _plans.delete(_plans.keys().next().value);
  const id = crypto.randomBytes(12).toString("hex");
  _plans.set(id, { at: now, plan });
  return id;
}
function takePlan(id) {
  const p = _plans.get(String(id || ""));
  if (!p) return null;
  _plans.delete(id);
  if (Date.now() - p.at > PLAN_TTL_MS) return null;
  return p.plan;
}

// ── PM2 size cap ─────────────────────────────────────────────────────────────
/** Cut each live PM2 log bigger than maxMB down to its last 2 MB (whole lines). */
async function trimPm2Logs(maxMB, ctx) {
  const c = ctxOf(ctx);
  const out = { trimmed: [], bytesFreed: 0 };
  if (!(maxMB > 0)) return out;
  if (isMarketHoursBlocked(c.now())) return out;
  const def = folderByKey("pm2_logs", c);
  const base = def.bases[0];
  let entries = [];
  try { entries = await fs.promises.readdir(base, { withFileTypes: true }); } catch (_) { return out; }
  const maxBytes = maxMB * 1024 * 1024;
  for (const e of entries) {
    if (!e.isFile() || e.isSymbolicLink() || !PM2_ACTIVE_RE.test(e.name)) continue;
    const fp = path.join(base, e.name);
    if (!isSafeTarget(fp, def, c)) continue;
    let fh;
    try {
      const s = await fs.promises.lstat(fp);
      if (s.size <= maxBytes) continue;
      const keep = Math.min(PM2_TAIL_KEEP_BYTES, Math.floor(maxBytes / 2));
      fh = await fs.promises.open(fp, "r");
      const buf = Buffer.alloc(keep);
      const { bytesRead } = await fh.read(buf, 0, keep, s.size - keep);
      await fh.close(); fh = null;
      let tail = buf.slice(0, bytesRead);
      const nl = tail.indexOf(10);
      if (nl >= 0) tail = tail.slice(nl + 1);
      await fs.promises.truncate(fp, 0);
      // Append, not write-at-0: PM2 holds the file open in append mode, so any
      // line it wrote since the truncate stays intact instead of being overwritten.
      await fs.promises.appendFile(fp, tail);
      out.trimmed.push(fp);
      out.bytesFreed += s.size - tail.length;
    } catch (_) {
      if (fh) { try { await fh.close(); } catch (__) {} }
    }
  }
  return out;
}

// ── Daily job ────────────────────────────────────────────────────────────────
let _lastAuto = null;     // { day, at, results, error? }
let _autoRunning = false;

/** Apply every folder's keep-days setting once. Never in market hours. */
async function runAutoCleanup({ ctx, isBacktestBusy } = {}) {
  const c = ctxOf(ctx);
  const now = c.now();
  if (isMarketHoursBlocked(now)) return { ran: false, reason: "market-hours" };
  const results = [];
  for (const def of folders(c)) {
    if (def.protected || !def.keepKey) continue;
    const days = keepDaysFor(def, c);
    if (days <= 0) continue;
    if (def.busyOnBacktest && typeof isBacktestBusy === "function" && isBacktestBusy()) {
      results.push({ key: def.key, keepDays: days, skipped: "backtest running" });
      continue;
    }
    try {
      const plan = await planCleanup(def.key, days, c);
      const r = plan.items.length ? await applyPlan(plan, c) : { deleted: [], bytesFreed: 0, skipped: [] };
      results.push({ key: def.key, keepDays: days, cutoffDate: plan.cutoffDate, files: plan.files, removed: r.deleted.length, bytesFreed: r.bytesFreed, skippedItems: (r.skipped || []).length });
    } catch (err) {
      results.push({ key: def.key, keepDays: days, error: err.message });
    }
  }
  const maxMB = pm2MaxMB(c);
  if (maxMB > 0) {
    const r = await trimPm2Logs(maxMB, c);
    results.push({ key: "pm2_logs", maxMB, removed: r.trimmed.length, bytesFreed: r.bytesFreed });
  }
  invalidateReport();
  return { ran: true, day: istDate(now), results };
}

function fmtMB(b) { return (b / 1048576).toFixed(1) + " MB"; }

function _shouldAutoRun(now, uptimeSec, lastDay, ctx) {
  if (!autoEnabled(ctx)) return false;
  if (uptimeSec < AUTO_BOOT_GRACE_SEC) return false;
  if (istMinutes(now) < AUTO_MIN_IST) return false;
  if (isMarketHoursBlocked(now)) return false;
  return istDate(now) !== lastDay;
}

let _autoTimer = null;
function startAutoCleanup({ isBacktestBusy } = {}) {
  if (_autoTimer) return;
  const tick = async () => {
    const now = Date.now();
    if (_autoRunning || !_shouldAutoRun(now, process.uptime(), _lastAuto && _lastAuto.day)) return;
    _autoRunning = true;
    try {
      const r = await runAutoCleanup({ isBacktestBusy });
      if (r.ran) {
        _lastAuto = { day: r.day, at: now, results: r.results };
        const freed = r.results.reduce((s, x) => s + (x.bytesFreed || 0), 0);
        const removed = r.results.reduce((s, x) => s + (x.removed || 0), 0);
        const detail = r.results.map(x => `${x.key}:${x.error ? "error" : x.skipped ? "skipped" : (x.removed || 0)}`).join(" ");
        console.log(`[disk] daily clean-up: removed ${removed} item(s), freed ${fmtMB(freed)} (${detail || "nothing enabled"})`);
      }
    } catch (err) {
      _lastAuto = { day: istDate(now), at: now, error: err.message, results: [] };
      console.warn(`[disk] daily clean-up failed: ${err.message}`);
    } finally { _autoRunning = false; }
  };
  _autoTimer = setInterval(() => { tick(); }, AUTO_CHECK_MS);
  if (typeof _autoTimer.unref === "function") _autoTimer.unref();
}

function autoStatus(ctx) {
  return { enabled: autoEnabled(ctx), runsAfterIst: "16:30", last: _lastAuto, pm2MaxMB: pm2MaxMB(ctx) };
}

module.exports = {
  folders, folderByKey, getDiskReport, invalidateReport,
  planCleanup, applyPlan, storePlan, takePlan,
  trimPm2Logs, runAutoCleanup, startAutoCleanup, autoStatus,
  isMarketHoursBlocked, keepDaysFor, istDate,
  _internals: { isSafeTarget, protectedRoots, _shouldAutoRun, PM2_ACTIVE_RE, AUTO_MIN_IST, AUTO_BOOT_GRACE_SEC },
};

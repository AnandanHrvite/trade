/**
 * backupManager.js — Daily downloadable data snapshots
 * ─────────────────────────────────────────────────────────────────────────────
 * Goal: if the EC2 instance is ever lost, the user must not lose trading data.
 * This builds a self-contained .tar.gz of everything stateful and lets the user
 * download it from the Settings page. A global banner nags until the day's copy
 * has actually been downloaded.
 *
 * What's inside a snapshot (full, self-contained — one file fully restores):
 *   ~/trading-data/        (trades, positions, settings audit, day JSONLs)  → archive path "trading-data/…"
 *   <repo>/data/ticks/     (recorded tick feed for /replay)                 → archive path "data/ticks/…"
 *
 * Excluded (regenerated or disposable):
 *   trading-data/backtest_cache  trading-data/candle_cache   — disk caches
 *   trading-data/.fyers_token    trading-data/.zerodha_token — daily OAuth tokens
 *   trading-data/_backups        — the snapshot store itself (no self-nesting)
 *
 * Restore (documented on the Settings card + README):
 *   tar xzf backup-YYYY-MM-DD.tar.gz -C ~      # trading-data/ → $HOME; data/ticks/ → repo's data/
 *   (move data/ticks into the repo if you unpacked elsewhere) then restart PM2.
 *
 * Env:
 *   BACKUP_ENABLED       (default true)   master gate — scheduler + banner + routes
 *   BACKUP_HOUR_IST      (default 16)     hour (IST) the daily snapshot is cut, after market close
 *   BACKUP_RETAIN_DAYS   (default 14)     prune snapshots older than this
 *   BACKUP_TG_ENABLED    (default false)  Telegram heartbeat when a snapshot is ready
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs    = require("fs");
const path  = require("path");
const os    = require("os");
const { spawn } = require("child_process");

const HOME       = os.homedir();
const DATA_DIR   = path.join(HOME, "trading-data");          // archive entry: trading-data/…
const REPO_ROOT  = path.resolve(__dirname, "..", "..");      // src/utils → repo root
const TICKS_REL  = path.join("data", "ticks");               // archive entry: data/ticks/…
const TICKS_DIR  = path.join(REPO_ROOT, TICKS_REL);
const BACKUP_DIR = path.join(DATA_DIR, "_backups");
const STATE_FILE = path.join(BACKUP_DIR, ".backup-state.json");

const TAR_EXCLUDES = [
  "trading-data/backtest_cache",
  "trading-data/candle_cache",
  "trading-data/_backups",
  "trading-data/.fyers_token",
  "trading-data/.zerodha_token",
];

function isEnabled() {
  return String(process.env.BACKUP_ENABLED || "true").toLowerCase() !== "false";
}
function tgEnabled() {
  return String(process.env.BACKUP_TG_ENABLED || "false").toLowerCase() === "true";
}
function retainDays() {
  const n = parseInt(process.env.BACKUP_RETAIN_DAYS || "14", 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
}
function backupHourIST() {
  const n = parseInt(process.env.BACKUP_HOUR_IST || "16", 10);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 16;
}

/** YYYY-MM-DD in IST for the given (or current) date. */
function istDateStr(d = new Date()) {
  const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const pad = (x) => String(x).padStart(2, "0");
  return `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())}`;
}

function fileFor(dateStr) {
  return path.join(BACKUP_DIR, `backup-${dateStr}.tar.gz`);
}

function ensureDir() {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (_) {}
}

// ── State (download tracking) ────────────────────────────────────────────────
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {}; }
  catch (_) { return {}; }
}
function writeState(state) {
  ensureDir();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (_) {}
}
function markDownloaded(dateStr) {
  const state = readState();
  state[dateStr] = { ...(state[dateStr] || {}), downloaded: true, downloadedAt: new Date().toISOString() };
  writeState(state);
}

// ── Create a snapshot ─────────────────────────────────────────────────────────
/**
 * Build backup-<date>.tar.gz. Writes to a .tmp then renames so a download can
 * never read a half-written archive. Resolves { ok, file, sizeBytes, error }.
 */
function createSnapshot(dateStr = istDateStr(), opts = {}) {
  const recordState = opts.recordState !== false;
  return new Promise((resolve) => {
    if (!fs.existsSync(DATA_DIR)) {
      return resolve({ ok: false, error: `${DATA_DIR} does not exist` });
    }
    ensureDir();
    const out = fileFor(dateStr);
    const tmp = out + ".tmp";

    // GNU/BSD tar both honour repeated -C (applies to subsequent paths) and
    // --exclude (must precede the path it filters). data/ticks added only if present.
    const args = ["-czf", tmp];
    for (const ex of TAR_EXCLUDES) args.push(`--exclude=${ex}`);
    args.push("-C", HOME, "trading-data");
    if (fs.existsSync(TICKS_DIR)) args.push("-C", REPO_ROOT, TICKS_REL);

    const tar = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    tar.stderr.on("data", (c) => { stderr += c.toString(); });
    tar.on("error", (err) => {
      try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
      resolve({ ok: false, error: err.message });
    });
    tar.on("close", (code) => {
      // tar exit 1 = "some files differ / vanished mid-read" — non-fatal warning.
      if (code !== 0 && code !== 1) {
        try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
        return resolve({ ok: false, error: `tar exited ${code}: ${stderr.trim().slice(0, 200)}` });
      }
      try {
        fs.renameSync(tmp, out);
        const sizeBytes = fs.statSync(out).size;
        if (recordState) {
          const state = readState();
          // A fresh snapshot is "not yet downloaded" — re-arms the nag banner.
          state[dateStr] = { createdAt: new Date().toISOString(), sizeBytes, downloaded: false };
          writeState(state);
        }
        resolve({ ok: true, file: out, sizeBytes });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  });
}

// ── Restore (from an uploaded archive) ────────────────────────────────────────
const RESTORE_PREFIXES = ["trading-data/", "data/ticks/"];

/** List entry names + a verbose dump for type checks. Resolves { names, verbose }. */
function inspectArchive(file) {
  return new Promise((resolve) => {
    const names = spawn("tar", ["tzf", file], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    names.stdout.on("data", (c) => { out += c.toString(); });
    names.on("error", () => resolve({ ok: false }));
    names.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false });
      // Verbose pass for symlink/hardlink detection (best-effort).
      const v = spawn("tar", ["tzvf", file], { stdio: ["ignore", "pipe", "ignore"] });
      let vout = "";
      v.stdout.on("data", (c) => { vout += c.toString(); });
      v.on("error", () => resolve({ ok: true, names: out.split("\n").filter(Boolean), verbose: "" }));
      v.on("close", () => resolve({ ok: true, names: out.split("\n").filter(Boolean), verbose: vout }));
    });
  });
}

/** True if an archive entry name is safe to restore (no traversal, allowed dir). */
function isSafeEntry(name) {
  if (!name || name.startsWith("/")) return false;          // no absolute paths
  if (name.split("/").some((seg) => seg === "..")) return false; // no traversal
  if (name === "trading-data/" || name === "data/ticks/") return true;
  return RESTORE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Restore from an already-uploaded .tar.gz at `file`.
 *  1. Validate every entry is inside trading-data/ or data/ticks/ (no traversal/symlinks).
 *  2. Snapshot current data first (pre-restore safety net) so a bad restore is reversible.
 *  3. Selectively extract each known dir to its target (-C). Members outside the
 *     two allowed names are never extracted, even if present in the archive.
 * Resolves { ok, restored:[...], preRestore, error }.
 */
async function restoreFromFile(file) {
  if (!fs.existsSync(file)) return { ok: false, error: "uploaded file not found" };

  const info = await inspectArchive(file);
  if (!info.ok) return { ok: false, error: "not a valid .tar.gz archive" };
  if (!info.names.length) return { ok: false, error: "archive is empty" };

  const bad = info.names.find((n) => !isSafeEntry(n));
  if (bad) return { ok: false, error: `unsafe archive entry: ${bad}` };
  // Reject symlink (l) / hardlink (h) entries — our backups never contain them.
  if (info.verbose && /^[lh]/m.test(info.verbose)) {
    return { ok: false, error: "archive contains link entries (refused)" };
  }

  const hasTrading = info.names.some((n) => n.startsWith("trading-data/"));
  const hasTicks   = info.names.some((n) => n.startsWith("data/ticks/"));
  if (!hasTrading && !hasTicks) return { ok: false, error: "archive has no trading-data or data/ticks" };

  // Pre-restore safety snapshot of whatever is on disk right now.
  let preRestore = null;
  try {
    const stamp = istDateStr().replace(/-/g, "") + "-" + Date.now();
    const r = await createSnapshot(`prerestore-${stamp}`, { recordState: false });
    if (r.ok) preRestore = path.basename(r.file);
  } catch (_) {}

  const extract = (cwd, member) => new Promise((resolve) => {
    const p = spawn("tar", ["xzf", file, "-C", cwd, member], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (c) => { err += c.toString(); });
    p.on("error", (e) => resolve({ ok: false, error: e.message }));
    p.on("close", (code) => resolve(code === 0 || code === 1 ? { ok: true } : { ok: false, error: err.trim().slice(0, 200) }));
  });

  const restored = [];
  if (hasTrading) {
    const r = await extract(HOME, "trading-data");
    if (!r.ok) return { ok: false, error: `trading-data restore failed: ${r.error}`, preRestore };
    restored.push("trading-data");
  }
  if (hasTicks) {
    const r = await extract(REPO_ROOT, "data/ticks");
    if (!r.ok) return { ok: false, error: `ticks restore failed: ${r.error}`, preRestore };
    restored.push("data/ticks");
  }
  return { ok: true, restored, preRestore };
}

// ── Listing / status ────────────────────────────────────────────────────────
function listBackups() {
  const state = readState();
  let names = [];
  try {
    names = fs.readdirSync(BACKUP_DIR).filter(n => /^backup-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(n));
  } catch (_) { return []; }
  return names.map((n) => {
    const date = n.slice("backup-".length, -".tar.gz".length);
    let sizeBytes = 0, mtimeMs = 0;
    try { const st = fs.statSync(path.join(BACKUP_DIR, n)); sizeBytes = st.size; mtimeMs = st.mtimeMs; } catch (_) {}
    const s = state[date] || {};
    return { date, file: n, sizeBytes, mtimeMs, downloaded: !!s.downloaded, downloadedAt: s.downloadedAt || null };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));
}

function getBackupFile(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return null;
  const f = fileFor(dateStr);
  return fs.existsSync(f) ? f : null;
}

/** Compact status for the download-nag banner. */
function todayStatus() {
  const date = istDateStr();
  const exists = !!getBackupFile(date);
  const s = readState()[date] || {};
  return { enabled: isEnabled(), date, exists, downloaded: !!s.downloaded };
}

// ── Prune ─────────────────────────────────────────────────────────────────────
function pruneOld() {
  const keep = retainDays();
  const cutoff = Date.now() - keep * 24 * 3600 * 1000;
  let deleted = 0;
  for (const b of listBackups()) {
    const t = new Date(b.date + "T00:00:00+05:30").getTime();
    if (Number.isFinite(t) && t < cutoff) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, b.file)); deleted++; } catch (_) {}
      const state = readState();
      if (state[b.date]) { delete state[b.date]; writeState(state); }
    }
  }
  // Pre-restore safety snapshots (backup-prerestore-*.tar.gz) aren't in the
  // dated list — prune them by file mtime instead.
  try {
    for (const n of fs.readdirSync(BACKUP_DIR)) {
      if (!/^backup-prerestore-.*\.tar\.gz$/.test(n)) continue;
      const f = path.join(BACKUP_DIR, n);
      try { if (fs.statSync(f).mtimeMs < cutoff) { fs.unlinkSync(f); deleted++; } } catch (_) {}
    }
  } catch (_) {}
  return deleted;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
let _timer = null;

function msUntilNextRun() {
  const hour = backupHourIST();
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const target = new Date(ist);
  target.setHours(hour, 0, 0, 0);
  let delta = target.getTime() - ist.getTime();
  if (delta <= 0) delta += 24 * 3600 * 1000; // tomorrow
  return delta;
}

async function runDaily() {
  if (!isEnabled()) return;
  const date = istDateStr();
  const r = await createSnapshot(date);
  if (r.ok) {
    const mb = (r.sizeBytes / (1024 * 1024)).toFixed(2);
    console.log(`[backup] daily snapshot ready: backup-${date}.tar.gz (${mb} MB)`);
    const pruned = pruneOld();
    if (pruned > 0) console.log(`[backup] pruned ${pruned} snapshot(s) older than ${retainDays()}d`);
    if (tgEnabled()) {
      try {
        require("./notify").sendTelegram(`📦 Data backup ready for ${date} (${mb} MB). Download it from Settings → Backup & Restore.`);
      } catch (_) {}
    }
  } else {
    console.warn(`[backup] daily snapshot FAILED: ${r.error}`);
    if (tgEnabled()) {
      try { require("./notify").sendTelegram(`⚠️ Data backup FAILED for ${date}: ${r.error}`); } catch (_) {}
    }
  }
}

function scheduleNext() {
  if (_timer) clearTimeout(_timer);
  const wait = msUntilNextRun();
  _timer = setTimeout(async () => {
    await runDaily();
    scheduleNext();
  }, wait);
  if (_timer.unref) _timer.unref();
}

/** Start the scheduler and ensure today has a snapshot to grab right away. */
function start() {
  if (!isEnabled()) {
    console.log("[backup] disabled (BACKUP_ENABLED=false)");
    return;
  }
  ensureDir();
  const date = istDateStr();
  if (!getBackupFile(date)) {
    // No snapshot for today yet — cut one now so there's always a file to download.
    createSnapshot(date).then((r) => {
      if (r.ok) console.log(`[backup] boot snapshot ready: backup-${date}.tar.gz (${(r.sizeBytes / 1048576).toFixed(2)} MB)`);
      else console.warn(`[backup] boot snapshot failed: ${r.error}`);
    });
  }
  scheduleNext();
  const hh = String(backupHourIST()).padStart(2, "0");
  console.log(`[backup] scheduler armed — daily snapshot at ${hh}:00 IST, retain ${retainDays()}d`);
}

module.exports = {
  start,
  createSnapshot,
  restoreFromFile,
  listBackups,
  getBackupFile,
  markDownloaded,
  todayStatus,
  pruneOld,
  istDateStr,
  isEnabled,
  BACKUP_DIR,
};

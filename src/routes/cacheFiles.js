/**
 * cacheFiles.js — Application cache / data-file browser
 *
 * One page to inspect, download, and delete every cached / generated file the
 * app stores on disk, grouped by purpose. Mirrors the Trade Logs UX (per-group
 * sections with View / Download / Delete + Download-All / Delete-All), but for
 * the *cache* artefacts rather than the canonical trade JSONLs (which keep their
 * own dedicated page).
 *
 * Groups span two roots:
 *   ~/trading-data/{backtest_cache,candle_cache,_replay_trades,_replay_trades_sim}
 *   ~/trading-data/ (loose JSON/JSONL state files at the root)
 *   <repo>/data/ticks/ (recorded tick feed — source of truth for /replay)
 *
 * Routes:
 *   GET  /cache-files                         → UI page
 *   GET  /cache-files/groups                  → JSON: per-group {fileCount,totalSize,exists}
 *   GET  /cache-files/list?group=&page=&pageSize=  → JSON: paged files for one group
 *   GET  /cache-files/view?group=&path=       → JSON: file content (text, capped)
 *   GET  /cache-files/download?group=&path=   → stream one raw file
 *   GET  /cache-files/download-all?group=     → stream group as .tar.gz
 *   POST /cache-files/delete?group=&path=     → delete one file (API_SECRET-protected)
 *   POST /cache-files/delete-all?group=       → delete every file in a group (protected)
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const os      = require("os");
const { spawn } = require("child_process");
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, toastJS } = require("../utils/sharedNav");

const HOME      = os.homedir();
const DATA_DIR  = path.join(HOME, "trading-data");
const TICKS_DIR = path.resolve(__dirname, "..", "..", "data", "ticks");

const VIEW_MAX_BYTES = 1024 * 1024; // 1 MB cap on the View modal

// Each group = one base directory. flat:true lists only files directly in the
// base (used for the trading-data root so the grouped sub-folders aren't doubled).
const GROUPS = [
  { key: "backtest_cache", label: "Backtest Cache",      icon: "📊", cls: "mode-ema_rsi_st",    base: path.join(DATA_DIR, "backtest_cache"),     flat: false, desc: "Cached historical OHLC pulls used by backtests (auto-pruned)." },
  { key: "candle_cache",   label: "Candle Cache",        icon: "🕯", cls: "mode-bb_rsi",    base: path.join(DATA_DIR, "candle_cache"),       flat: false, desc: "Cached intraday candle series." },
  { key: "ticks",          label: "Recorded Ticks",      icon: "📡", cls: "mode-orb",      base: TICKS_DIR,                                 flat: false, desc: "Recorded spot / option / VIX ticks per IST date — source of truth for Replay. (Replay outputs/cache under the same root are listed separately below.)" },
  { key: "replay",         label: "Replay Trades",       icon: "📼", cls: "mode-pa",       base: path.join(TICKS_DIR, "_replay_trades"),     flat: false, tagged: true, desc: "Replay outputs in snapshot mode (recorded session-start settings)." },
  { key: "replay_sim",     label: "Replay Trades (Sim)", icon: "🧪", cls: "mode-sim",      base: path.join(TICKS_DIR, "_replay_trades_sim"), flat: false, tagged: true, desc: "Replay outputs in current-settings (sim) mode." },
  { key: "replay_cache",   label: "Replay Cache",        icon: "⚡", cls: "mode-pa",       base: path.join(TICKS_DIR, "_replay_cache"),      flat: false, tagged: true, desc: "Cached deterministic replay results — re-run hits these to skip the tick stream. Deleting forces a fresh recompute on the next run (safe)." },
  { key: "root",           label: "Root Data Files",     icon: "🗂", cls: "mode-ema_rsi_st",    base: DATA_DIR,                                  flat: true,  desc: "Loose JSON / JSONL state files directly under ~/trading-data (the grouped sub-folders are listed above)." },
];
const GROUP_BY_KEY = Object.fromEntries(GROUPS.map(g => [g.key, g]));

const IGNORE_NAMES = new Set([".DS_Store", ".gitkeep"]);

// Strategy → display badge. The mode strings replay writes are "{strategy}-paper"
// (e.g. "bb_rsi-paper"); we tag on the leading strategy token so a hash-named
// replay-cache file can still be told apart by which engine produced it.
const STRATEGY_BADGE = {
  ema_rsi_st:    { label: "EMA_RSI_ST",    cls: "mode-ema_rsi_st" },
  bb_rsi:    { label: "BB_RSI",    cls: "mode-bb_rsi" },
  pa:       { label: "PA",       cls: "mode-pa" },
  orb:      { label: "ORB",      cls: "mode-orb" },
  trend_pb: { label: "TREND PB", cls: "mode-trend_pb" },
};

// Cache: abs path → { mtimeMs, meta } so we don't re-parse a file every list call.
const _tagCache = new Map();

// IST date string from an epoch-ms value (used to recover a session date from a
// numeric sessionId when the cached result predates the stored `date` field).
function _istDateFromMs(ms) {
  if (!Number.isFinite(ms) || ms < 1577836800000) return null; // sanity: after 2020
  const ist = new Date(ms + 19800000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

// Resolve { strat, date } for a file in a tagged group.
//   _replay_trades / _replay_trades_sim → "{mode}_{suffix}.jsonl" — strat from name.
//   _replay_cache                       → sha1-named .json; the result JSON carries
//                                         a top-level "mode" (and now "date") field.
// strat is a strategy key (ema_rsi_st|bb_rsi|pa|orb) or null; date is "YYYY-MM-DD" or null.
function detectMeta(group, rel, abs, mtimeMs) {
  if (!group.tagged) return { strat: null, date: null };
  // Filename-encoded modes (replay / replay_sim outputs) — no per-file date.
  const nameMatch = path.basename(rel).match(/^(ema_rsi_st|bb_rsi|pa|orb|trend_pb)\b/i);
  if (nameMatch) return { strat: nameMatch[1].toLowerCase(), date: null };
  // Hash-named replay-cache JSON: read embedded mode/date, with an mtime cache.
  const cached = _tagCache.get(abs);
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
  let meta = { strat: null, date: null };
  try {
    const obj = JSON.parse(fs.readFileSync(abs, "utf-8"));
    const m = String(obj && obj.mode || "").match(/^(ema_rsi_st|bb_rsi|pa|orb|trend[-_]pb)/i);
    if (m) meta.strat = m[1].toLowerCase().replace(/-/g, "_");   // "trend-pb" → "trend_pb"
    // `date` was added to cached results later; fall back to a numeric sessionId (epoch ms).
    if (typeof obj.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.date)) meta.date = obj.date;
    else if (typeof obj.sessionId === "number") meta.date = _istDateFromMs(obj.sessionId);
  } catch (_) { /* leave nulls */ }
  _tagCache.set(abs, { mtimeMs, meta });
  return meta;
}

function validGroup(k) { return Object.prototype.hasOwnProperty.call(GROUP_BY_KEY, k); }

// IST date string for download filenames.
function istDateString() {
  const ist = new Date(Date.now() + 19800000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Reject traversal / absolute paths, then confirm the resolved path stays inside base.
function resolveInGroup(group, rel) {
  if (typeof rel !== "string" || !rel.length || rel.includes("\0")) return null;
  const norm = path.normalize(rel);
  if (norm.startsWith("..") || path.isAbsolute(norm)) return null;
  const baseResolved = path.resolve(group.base);
  const abs = path.resolve(baseResolved, norm);
  if (abs !== baseResolved && !abs.startsWith(baseResolved + path.sep)) return null;
  return abs;
}

// Recursive (or flat) file walk → [{ rel, size, mtimeMs }], newest first.
function listFiles(group) {
  const out = [];
  (function walk(dir, prefix) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      if (IGNORE_NAMES.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel  = prefix ? prefix + "/" + e.name : e.name;
      if (e.isDirectory()) {
        // Skip underscore-prefixed dirs (_replay_trades, _replay_trades_sim,
        // _replay_cache) — they share the ticks ROOT_DIR but have their own
        // groups, so the "Recorded Ticks" walk shouldn't sweep them in. Real
        // tick folders are date-named (YYYY-MM-DD), never underscore-prefixed.
        if (e.name.startsWith("_")) continue;
        if (!group.flat) walk(full, rel);
      } else if (e.isFile()) {
        let st; try { st = fs.statSync(full); } catch (_) { continue; }
        out.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  })(group.base, "");
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function parsePaging(req, defaultSize = 10, maxSize = 500) {
  const rawPage = req.query.page;
  if (rawPage === undefined || rawPage === null || rawPage === "") return null;
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || defaultSize, 1), maxSize);
  return { page, pageSize };
}

// ── GET /cache-files/groups — summary for every group ───────────────────────
router.get("/groups", (_req, res) => {
  const groups = GROUPS.map(g => {
    const files = listFiles(g);
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    return {
      key: g.key, label: g.label, icon: g.icon, cls: g.cls, desc: g.desc,
      exists: fs.existsSync(g.base),
      fileCount: files.length,
      totalSize,
    };
  });
  res.json({ success: true, groups });
});

// ── GET /cache-files/list — paged files for one group ───────────────────────
router.get("/list", (req, res) => {
  const key = String(req.query.group || "");
  if (!validGroup(key)) return res.status(400).json({ success: false, error: "bad group" });
  const group = GROUP_BY_KEY[key];
  let files = listFiles(group);
  // Attach a strategy tag for tagged groups; collect the distinct tags present
  // so the UI can offer a per-strategy filter.
  const tagsPresent = new Set();
  if (group.tagged) {
    for (const f of files) {
      const meta = detectMeta(group, f.rel, path.join(group.base, f.rel), f.mtimeMs);
      f.tag = meta.strat;
      f.sessionDate = meta.date;
      if (f.tag) tagsPresent.add(f.tag);
    }
  }
  const unfilteredTotal = files.length; // group-wide count for the page overview
  // Optional strategy filter — scopes both the listing and the totals so a
  // filtered "Delete All" only touches that strategy's files.
  const tagFilter = String(req.query.tag || "").toLowerCase();
  if (group.tagged && tagFilter && STRATEGY_BADGE[tagFilter]) {
    files = files.filter(f => f.tag === tagFilter);
  }
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const paging = parsePaging(req, 10);
  const total = files.length;
  const slice = paging
    ? files.slice((paging.page - 1) * paging.pageSize, (paging.page - 1) * paging.pageSize + paging.pageSize)
    : files;
  res.json({
    success: true,
    group: key,
    tagged: !!group.tagged,
    tags: Array.from(tagsPresent).sort(),
    tagFilter: (group.tagged && tagFilter && STRATEGY_BADGE[tagFilter]) ? tagFilter : null,
    page: paging ? paging.page : 1,
    pageSize: paging ? paging.pageSize : total,
    total, totalSize, unfilteredTotal,
    count: slice.length,
    rows: slice,
  });
});

// ── GET /cache-files/view — text content of one file (capped) ───────────────
router.get("/view", (req, res) => {
  const key = String(req.query.group || "");
  if (!validGroup(key)) return res.status(400).json({ success: false, error: "bad group" });
  const abs = resolveInGroup(GROUP_BY_KEY[key], String(req.query.path || ""));
  if (!abs) return res.status(400).json({ success: false, error: "bad path" });
  let st;
  try { st = fs.statSync(abs); }
  catch (_) { return res.status(404).json({ success: false, error: "file not found" }); }
  if (!st.isFile()) return res.status(400).json({ success: false, error: "not a file" });
  let content, truncated = false;
  try {
    if (st.size > VIEW_MAX_BYTES) {
      const fd = fs.openSync(abs, "r");
      const buf = Buffer.alloc(VIEW_MAX_BYTES);
      const n = fs.readSync(fd, buf, 0, VIEW_MAX_BYTES, 0);
      fs.closeSync(fd);
      content = buf.slice(0, n).toString("utf-8");
      truncated = true;
    } else {
      content = fs.readFileSync(abs, "utf-8");
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
  // Pretty-print whole-file JSON when it parses (and isn't truncated).
  if (!truncated && /\.json$/i.test(abs)) {
    try { content = JSON.stringify(JSON.parse(content), null, 2); } catch (_) { /* leave raw */ }
  }
  res.json({ success: true, group: key, path: String(req.query.path), size: st.size, mtimeMs: st.mtimeMs, truncated, content });
});

// ── GET /cache-files/download — stream one raw file ─────────────────────────
router.get("/download", (req, res) => {
  const key = String(req.query.group || "");
  if (!validGroup(key)) return res.status(400).send("bad group");
  const abs = resolveInGroup(GROUP_BY_KEY[key], String(req.query.path || ""));
  if (!abs || !fs.existsSync(abs)) return res.status(404).send("file not found");
  res.setHeader("Content-Disposition", `attachment; filename="${path.basename(abs)}"`);
  res.setHeader("Content-Type", "application/octet-stream");
  fs.createReadStream(abs).pipe(res);
});

// ── GET /cache-files/download-all — stream a group as .tar.gz ───────────────
router.get("/download-all", (req, res) => {
  const key = String(req.query.group || "");
  if (!validGroup(key)) return res.status(400).send("bad group");
  const group = GROUP_BY_KEY[key];
  let files = listFiles(group);
  const tagFilter = String(req.query.tag || "").toLowerCase();
  if (group.tagged && tagFilter && STRATEGY_BADGE[tagFilter]) {
    files = files.filter(f => detectMeta(group, f.rel, path.join(group.base, f.rel), f.mtimeMs).strat === tagFilter);
  }
  if (!files.length) return res.status(404).send("no files for this group");
  const filename = `${group.key}${tagFilter ? "_" + tagFilter : ""}_${istDateString()}.tar.gz`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/gzip");
  // Feed the explicit relative file list on stdin (-T -) so the flat "root"
  // group excludes sub-folders and we never hit ARG_MAX on large tick dirs.
  const tar = spawn("tar", ["-czf", "-", "-C", group.base, "-T", "-"]);
  tar.stdout.pipe(res);
  tar.stderr.on("data", () => {});
  tar.on("error", () => { if (!res.headersSent) res.status(500); res.end(); });
  tar.stdin.on("error", () => {});
  tar.stdin.write(files.map(f => f.rel).join("\n") + "\n");
  tar.stdin.end();
});

// ── POST /cache-files/delete — delete one file (write op, gated) ────────────
router.post("/delete", (req, res) => {
  const key = String(req.query.group || req.body?.group || "");
  if (!validGroup(key)) return res.status(400).json({ success: false, error: "bad group" });
  const rel = String(req.query.path || req.body?.path || "");
  const abs = resolveInGroup(GROUP_BY_KEY[key], rel);
  if (!abs) return res.status(400).json({ success: false, error: "bad path" });
  try {
    fs.unlinkSync(abs);
    _tagCache.delete(abs);
    console.log(`[cache-files] deleted ${abs}`);
    res.json({ success: true, deleted: path.basename(abs) });
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ success: false, error: "file not found" });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /cache-files/delete-all — delete every file in a group (gated) ─────
router.post("/delete-all", (req, res) => {
  const key = String(req.query.group || req.body?.group || "");
  if (!validGroup(key)) return res.status(400).json({ success: false, error: "bad group" });
  const group = GROUP_BY_KEY[key];
  let files = listFiles(group);
  // Scope the wipe to one strategy when a valid tag filter is supplied — this is
  // what lets "Delete All" clear only BB_RSI without touching EMA_RSI_ST.
  const tagFilter = String(req.query.tag || req.body?.tag || "").toLowerCase();
  if (group.tagged && tagFilter && STRATEGY_BADGE[tagFilter]) {
    files = files.filter(f => detectMeta(group, f.rel, path.join(group.base, f.rel), f.mtimeMs).strat === tagFilter);
  }
  const deleted = [];
  const failed = [];
  for (const f of files) {
    const abs = resolveInGroup(group, f.rel);
    if (!abs) { failed.push({ path: f.rel, error: "bad path" }); continue; }
    try { fs.unlinkSync(abs); _tagCache.delete(abs); deleted.push(f.rel); }
    catch (err) { if (err.code !== "ENOENT") failed.push({ path: f.rel, error: err.message }); }
  }
  console.log(`[cache-files] delete-all group=${key}${tagFilter ? ` tag=${tagFilter}` : ""} removed=${deleted.length} failed=${failed.length}`);
  res.json({ success: failed.length === 0, group: key, tag: tagFilter || null, deleted, failed });
});

// ── GET /cache-files — UI page ──────────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  // Embedded mode: rendered inside an <iframe> on the Logs (/trade-logs) page as a tab.
  const embed = req.query.embed === "1" || req.query.embed === "true";
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  ${faviconLink()}
  <title>Cache Files — Trading BOT</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    html, body { height:100%; }
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; }
    ${sidebarCSS()}
    ${modalCSS()}
    .page { padding:22px 28px 80px; max-width:1240px; }
    .sub { font-size:0.72rem; color:#4a6080; margin-bottom:14px; }
    .sub code { background:#0d1320; padding:1px 5px; border-radius:3px; color:#94a3b8; }
    .overview { display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid #1a2236; margin-bottom:14px; padding-bottom:10px; flex-wrap:wrap; }
    .overview-meta { font-size:0.72rem; color:#64748b; font-family:'IBM Plex Mono',monospace; }
    .page-size-ctrl { display:flex; align-items:center; gap:8px; font-size:0.66rem; color:#4a6080; text-transform:uppercase; letter-spacing:0.5px; }
    .page-size-ctrl select { padding:5px 9px; background:#0a1528; border:1px solid #1e3a5a; border-radius:6px; color:#c8d8f0; font-family:inherit; font-size:0.72rem; outline:none; }
    .pager { display:flex; align-items:center; justify-content:space-between; padding:8px 14px; background:#08111e; border-top:1px solid #121a2a; gap:10px; flex-wrap:wrap; }
    .pager-info { font-size:0.66rem; color:#64748b; font-family:'IBM Plex Mono',monospace; }
    .pager-btns { display:flex; align-items:center; gap:6px; }
    .pager-btns button { font-size:0.66rem; padding:3px 10px; background:#0a1528; border:1px solid #1e3a5a; border-radius:5px; color:#94a3b8; cursor:pointer; font-family:inherit; }
    .pager-btns button:hover:not(:disabled) { color:#60a5fa; border-color:#3b82f6; }
    .pager-btns button:disabled { opacity:0.35; cursor:not-allowed; }
    .pager-btns .pager-page { font-size:0.66rem; color:#94a3b8; font-family:'IBM Plex Mono',monospace; padding:0 4px; }
    .mode-section { margin-bottom:22px; background:#0a1018; border:1px solid #1a2236; border-radius:8px; overflow:hidden; }
    .mode-head { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:#0d1320; border-bottom:1px solid #1a2236; gap:10px; flex-wrap:wrap; }
    .mode-name { font-weight:700; font-size:0.78rem; letter-spacing:0.5px; text-transform:uppercase; }
    .mode-ema_rsi_st    { color:#60a5fa; }
    .mode-bb_rsi    { color:#fbbf24; }
    .mode-pa       { color:#a78bfa; }
    .mode-orb      { color:#10b981; }
    .mode-trend_pb { color:#f472b6; }
    .mode-sim      { color:#ec4899; }
    .mode-desc { font-size:0.66rem; color:#4a6080; margin:6px 14px 0; font-style:italic; }
    .mode-meta { font-size:0.68rem; color:#4a6080; }
    table { width:100%; border-collapse:collapse; font-size:0.72rem; }
    th, td { padding:8px 12px; text-align:left; border-bottom:1px solid #121a2a; }
    th { background:#0a0e18; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; font-size:0.62rem; }
    tr:hover td { background:#0d1320; }
    .empty { padding:18px 14px; color:#4a6080; font-size:0.72rem; font-style:italic; }
    .btn { font-size:0.66rem; font-weight:600; padding:4px 10px; border-radius:5px; border:1px solid; cursor:pointer; font-family:inherit; text-decoration:none; display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
    .btn-view     { background:#071428; border-color:#0e2850; color:#60a5fa; }
    .btn-download { background:#060a14; border-color:#0e1a28; color:#818cf8; }
    .btn-delete   { background:#180508; border-color:#401018; color:#f87171; }
    .btn:hover { filter:brightness(1.2); }
    .actions { display:flex; gap:5px; }
    .num  { font-family:'IBM Plex Mono',monospace; }
    .fname { font-family:'IBM Plex Mono',monospace; color:#c8d8f0; word-break:break-all; }
    .tag { display:inline-block; font-size:0.6rem; font-weight:700; letter-spacing:0.5px; padding:2px 7px; border-radius:10px; border:1px solid currentColor; text-transform:uppercase; }
    .tag-none { color:#475569; }
    .sdate { font-family:'IBM Plex Mono',monospace; font-size:0.66rem; color:#64748b; }
    .tag-filter { display:flex; align-items:center; gap:6px; font-size:0.62rem; color:#4a6080; text-transform:uppercase; letter-spacing:0.5px; }
    .tag-filter select { padding:3px 7px; background:#0a1528; border:1px solid #1e3a5a; border-radius:5px; color:#c8d8f0; font-family:inherit; font-size:0.66rem; outline:none; }
    :root[data-theme="light"] .tag-none { color:#94a3b8; }
    :root[data-theme="light"] .sdate { color:#64748b; }
    :root[data-theme="light"] .tag-filter { color:#64748b; }
    :root[data-theme="light"] .tag-filter select { background:#fff; border-color:#e0e4ea; color:#334155; }

    /* File-view modal */
    .tv-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:1000; align-items:flex-start; justify-content:center; padding:40px 16px; overflow-y:auto; }
    .tv-overlay.visible { display:flex; }
    .tv-box { width:100%; max-width:1100px; background:#0a1018; border:1px solid #1a2236; border-radius:10px; }
    .tv-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid #1a2236; }
    .tv-title { font-size:0.85rem; font-weight:600; color:#c8d8f0; word-break:break-all; }
    .tv-close { background:transparent; border:none; color:#64748b; cursor:pointer; font-size:1.2rem; padding:0 6px; }
    .tv-body { padding:12px 18px 18px; max-height:70vh; overflow-y:auto; }
    .tv-body pre { background:#0d1320; border:1px solid #1a2236; border-radius:5px; padding:9px 11px; font-family:'IBM Plex Mono',monospace; font-size:0.66rem; color:#94a3b8; white-space:pre-wrap; word-break:break-all; }

    @media (max-width:640px) {
      html, body { height:auto; }
      body { display:block; height:auto; overflow-x:hidden; }
      .page { padding:14px; }
      table { font-size:0.66rem; }
      th, td { padding:6px 8px; }
    }

    /* ── LIGHT THEME OVERRIDES (UI_THEME=light) ───────────────────────── */
    :root[data-theme="light"] body { background:#f4f6f9; color:#334155; }
    :root[data-theme="light"] .page { color:#334155; }
    :root[data-theme="light"] .sub { color:#64748b; }
    :root[data-theme="light"] .sub code { background:#f1f5f9; color:#475569; }
    :root[data-theme="light"] .overview { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .overview-meta { color:#64748b; }
    :root[data-theme="light"] .page-size-ctrl { color:#64748b; }
    :root[data-theme="light"] .page-size-ctrl select { background:#fff; border-color:#e0e4ea; color:#334155; }
    :root[data-theme="light"] .pager { background:#f8fafc; border-top-color:#e0e4ea; }
    :root[data-theme="light"] .pager-info, :root[data-theme="light"] .pager-btns .pager-page { color:#64748b; }
    :root[data-theme="light"] .pager-btns button { background:#fff; border-color:#e0e4ea; color:#475569; }
    :root[data-theme="light"] .pager-btns button:hover:not(:disabled) { color:#1e40af; border-color:#3b82f6; }
    :root[data-theme="light"] .mode-section { background:#fff; border-color:#e0e4ea; }
    :root[data-theme="light"] .mode-head { background:#f8fafc; border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .mode-meta, :root[data-theme="light"] .mode-desc { color:#94a3b8; }
    :root[data-theme="light"] .fname { color:#334155; }
    :root[data-theme="light"] th { background:#f1f5f9; color:#64748b; }
    :root[data-theme="light"] th, :root[data-theme="light"] td { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] tr:hover td { background:#f8fafc; }
    :root[data-theme="light"] .empty { color:#94a3b8; }
    :root[data-theme="light"] .btn-view     { background:#eff6ff; border-color:#bfdbfe; color:#1e40af; }
    :root[data-theme="light"] .btn-download { background:#eef2ff; border-color:#c7d2fe; color:#4338ca; }
    :root[data-theme="light"] .btn-delete   { background:#fef2f2; border-color:#fecaca; color:#b91c1c; }
    :root[data-theme="light"] .tv-overlay { background:rgba(15,23,42,0.55); }
    :root[data-theme="light"] .tv-box { background:#fff; border-color:#e0e4ea; }
    :root[data-theme="light"] .tv-head { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .tv-title { color:#1e293b; }
    :root[data-theme="light"] .tv-close { color:#94a3b8; }
    :root[data-theme="light"] .tv-body pre { background:#f8fafc; border-color:#e0e4ea; color:#475569; }
  </style>
</head>
<body>
${embed ? '<style>.main-content{margin-left:0 !important;} .top-bar{display:none !important;}</style>' : ''}
<div class="app-shell">
${embed ? '' : buildSidebar('cacheFiles', liveActive)}
<div class="main-content">

<div class="top-bar">
  <div>
    <div class="top-bar-title">🧰 Cache Files</div>
    <div class="top-bar-meta">All cached / generated data files on disk · ~/trading-data + recorded ticks</div>
  </div>
</div>

<div class="page">
  <div class="sub">Inspect, download, or clear every cache / generated file the app stores. The canonical trade &amp; skip JSONLs live on the <code>Trade Logs</code> page — this page covers the <em>caches</em>: backtest/candle caches, recorded ticks, replay outputs, and loose root state files. Deleting a cache is safe — the app regenerates it on demand.</div>

  <div class="overview">
    <div class="overview-meta" id="overviewMeta">Loading…</div>
    <div class="page-size-ctrl">
      <label for="pageSizeSelect">Rows per page</label>
      <select id="pageSizeSelect" onchange="onPageSizeChange()">
        <option value="5">5</option>
        <option value="10">10</option>
        <option value="25">25</option>
        <option value="50">50</option>
        <option value="100">100</option>
      </select>
    </div>
  </div>

  <div id="groupsArea">Loading…</div>
</div>

<!-- File-view modal -->
<div class="tv-overlay" id="tvOverlay" onclick="if(event.target===this) closeTV()">
  <div class="tv-box">
    <div class="tv-head">
      <div class="tv-title" id="tvTitle">File</div>
      <button class="tv-close" onclick="closeTV()">✕</button>
    </div>
    <div class="tv-body" id="tvBody">…</div>
  </div>
</div>

<script>
  ${modalJS()}
  ${toastJS()}

  var GROUPS = [];  // populated from /cache-files/groups
  var _totals = {}; // key -> file count (for overview)
  var _tagFilter = {}; // group key -> active strategy filter ('' = all)
  var STRAT_BADGE = {
    ema_rsi_st:    { label: 'EMA_RSI_ST',    cls: 'mode-ema_rsi_st' },
    bb_rsi:    { label: 'BB_RSI',    cls: 'mode-bb_rsi' },
    pa:       { label: 'PA',       cls: 'mode-pa' },
    orb:      { label: 'ORB',      cls: 'mode-orb' },
    trend_pb: { label: 'TREND PB', cls: 'mode-trend_pb' },
  };
  function badgeHtml(strat) {
    var b = STRAT_BADGE[strat];
    if (!b) return '<span class="tag tag-none">—</span>';
    return '<span class="tag ' + b.cls + '">' + b.label + '</span>';
  }

  var _pageSize = (function(){
    try {
      var v = parseInt(localStorage.getItem('cacheFiles_pageSize'), 10);
      if (v === 5 || v === 10 || v === 25 || v === 50 || v === 100) return v;
    } catch (_) {}
    return 10;
  })();
  var _page = {}; // group key -> current page

  function fmtSize(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/(1024*1024)).toFixed(2) + ' MB';
  }
  function fmtMtime(ms) {
    try { return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', ''); }
    catch (_) { return '—'; }
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) { return escHtml(s).replace(/\\\\/g, '&#92;'); }

  function initPageSizeSelector() {
    var el = document.getElementById('pageSizeSelect');
    if (el) el.value = String(_pageSize);
  }

  function onPageSizeChange() {
    var v = parseInt(document.getElementById('pageSizeSelect').value, 10);
    if (![5, 10, 25, 50, 100].includes(v)) v = 10;
    _pageSize = v;
    try { localStorage.setItem('cacheFiles_pageSize', String(v)); } catch (_) {}
    Object.keys(_page).forEach(function(k){ _page[k] = 1; });
    GROUPS.forEach(function(g){ loadGroupSection(g.key); });
  }

  function pagerHtml(groupKey, page, pageSize, total) {
    var maxPage = Math.max(1, Math.ceil(total / pageSize));
    var p = Math.min(page, maxPage);
    var start = total === 0 ? 0 : (p - 1) * pageSize + 1;
    var end = Math.min(p * pageSize, total);
    var prevDisabled = p <= 1 ? ' disabled' : '';
    var nextDisabled = p >= maxPage ? ' disabled' : '';
    return '<div class="pager">' +
      '<div class="pager-info">' + (total === 0 ? '0 files' : ('Showing ' + start + '–' + end + ' of ' + total)) + '</div>' +
      '<div class="pager-btns">' +
        '<button onclick="goPage(\\'' + groupKey + '\\',-1)"' + prevDisabled + '>‹ Prev</button>' +
        '<span class="pager-page">Page ' + p + ' / ' + maxPage + '</span>' +
        '<button onclick="goPage(\\'' + groupKey + '\\',1)"' + nextDisabled + '>Next ›</button>' +
      '</div>' +
    '</div>';
  }

  function goPage(groupKey, delta) {
    _page[groupKey] = Math.max(1, (_page[groupKey] || 1) + delta);
    loadGroupSection(groupKey);
  }

  function loadGroups() {
    fetch('/cache-files/groups', { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.success) { document.getElementById('groupsArea').innerHTML = '<div class="empty">Failed to load.</div>'; return; }
        GROUPS = d.groups || [];
        GROUPS.forEach(function(g){ _page[g.key] = 1; _totals[g.key] = g.fileCount || 0; });
        document.getElementById('groupsArea').innerHTML = GROUPS.map(function(g){
          return '<div class="mode-section" id="section-' + g.key + '"><div class="mode-head"><div class="mode-name ' + g.cls + '">' + g.icon + ' ' + escHtml(g.label) + '</div><div class="mode-meta">loading…</div></div></div>';
        }).join('');
        updateOverview();
        GROUPS.forEach(function(g){ loadGroupSection(g.key); });
      })
      .catch(function(){ document.getElementById('groupsArea').innerHTML = '<div class="empty">Cannot reach server.</div>'; });
  }

  function updateOverview() {
    var files = 0, bytes = 0;
    GROUPS.forEach(function(g){ files += (g.fileCount || 0); bytes += (g.totalSize || 0); });
    document.getElementById('overviewMeta').textContent =
      GROUPS.length + ' groups · ' + files + ' file' + (files === 1 ? '' : 's') + ' · ' + fmtSize(bytes) + ' total';
  }

  function groupMeta(key) { return GROUPS.find(function(g){ return g.key === key; }) || {}; }

  function loadGroupSection(key) {
    var g = groupMeta(key);
    var page = _page[key] || 1;
    var tf = _tagFilter[key] || '';
    var url = '/cache-files/list?group=' + encodeURIComponent(key) + '&page=' + page + '&pageSize=' + _pageSize +
      (tf ? '&tag=' + encodeURIComponent(tf) : '');
    return fetch(url, { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        var el = document.getElementById('section-' + key);
        if (!el) return;
        if (!d || !d.success) { el.innerHTML = '<div class="empty">Failed to load.</div>'; return; }
        // keep overview totals fresh after deletes (group-wide, ignoring any active filter)
        var gm = groupMeta(key);
        if (gm) { gm.fileCount = (d.unfilteredTotal != null ? d.unfilteredTotal : d.total); gm.totalSize = d.totalSize; }
        updateOverview();
        el.innerHTML = renderSectionHTML(g, d);
      })
      .catch(function(){
        var el = document.getElementById('section-' + key);
        if (el) el.innerHTML = '<div class="empty">Cannot reach server.</div>';
      });
  }

  function renderSectionHTML(g, d) {
    var rows = d.rows || [];
    var total = d.total || 0;
    var tagged = !!d.tagged;
    var tf = _tagFilter[g.key] || '';
    var stratTh  = tagged ? '<th>Strategy</th><th>Session</th>' : '';
    var bodyHtml = rows.length === 0
      ? '<div class="empty">No files' + (tf ? ' for ' + escHtml((STRAT_BADGE[tf]||{}).label || tf) : '') + ' in ' + escHtml(g.label) + '.</div>'
      : '<table><thead><tr><th>File</th>' + stratTh + '<th>Size</th><th>Modified (IST)</th><th></th></tr></thead><tbody>' +
        rows.map(function(r){
          var pEnc = encodeURIComponent(r.rel);
          var pJs  = "'" + escAttr(r.rel) + "'";
          var stratTd = tagged
            ? '<td>' + badgeHtml(r.tag) + '</td><td class="sdate">' + (r.sessionDate ? escHtml(r.sessionDate) : '—') + '</td>'
            : '';
          return '<tr>' +
            '<td class="fname">' + escHtml(r.rel) + '</td>' +
            stratTd +
            '<td class="num">' + fmtSize(r.size) + '</td>' +
            '<td class="num">' + fmtMtime(r.mtimeMs) + '</td>' +
            '<td><div class="actions">' +
              '<button class="btn btn-view"     onclick="viewFile(\\''+g.key+'\\',' + pJs + ')">👁 View</button>' +
              '<a       class="btn btn-download" href="/cache-files/download?group='+g.key+'&path='+pEnc+'">⬇ Download</a>' +
              '<button class="btn btn-delete"   onclick="delFile(\\''+g.key+'\\',' + pJs + ')">🗑 Delete</button>' +
            '</div></td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    // Strategy filter dropdown — only for tagged groups that actually hold tags.
    var filterHtml = '';
    if (tagged && (d.tags || []).length) {
      var opts = '<option value="">All strategies</option>' + d.tags.map(function(t){
        var lbl = (STRAT_BADGE[t] || {}).label || t.toUpperCase();
        return '<option value="' + escAttr(t) + '"' + (t === tf ? ' selected' : '') + '>' + escHtml(lbl) + '</option>';
      }).join('');
      filterHtml = '<div class="tag-filter"><span>Strategy</span><select onchange="onTagFilter(\\''+g.key+'\\',this.value)">' + opts + '</select></div>';
    }
    var dlAll = total > 0
      ? '<a class="btn btn-download" href="/cache-files/download-all?group=' + g.key + (tf ? '&tag=' + encodeURIComponent(tf) : '') + '" title="Download all ' + total + ' files as a .tar.gz">⬇ Download All (' + total + ')</a>'
      : '';
    var delLabel = tf ? ('Delete All ' + ((STRAT_BADGE[tf]||{}).label || tf) + ' (' + total + ')') : ('Delete All (' + total + ')');
    var delAll = total > 0
      ? '<button class="btn btn-delete" onclick="delAll(\\''+g.key+'\\','+total+')" title="Delete '+(tf?'every '+escHtml((STRAT_BADGE[tf]||{}).label||tf)+' file':'every file in this group')+'">🗑 ' + escHtml(delLabel) + '</button>'
      : '';
    var head = '<div class="mode-head">' +
        '<div class="mode-name ' + g.cls + '">' + g.icon + ' ' + escHtml(g.label) + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          filterHtml +
          '<div class="mode-meta">' + total + ' file' + (total === 1 ? '' : 's') + ' · ' + fmtSize(d.totalSize) + '</div>' +
          dlAll + delAll +
        '</div>' +
      '</div>' +
      (g.desc ? '<div class="mode-desc">' + escHtml(g.desc) + '</div>' : '');
    return head + bodyHtml + (total > _pageSize ? pagerHtml(g.key, d.page, d.pageSize, total) : '');
  }

  function onTagFilter(groupKey, val) {
    _tagFilter[groupKey] = val || '';
    _page[groupKey] = 1;
    loadGroupSection(groupKey);
  }

  // ── File view modal ──────────────────────────────────────────────────
  function viewFile(group, rel) {
    document.getElementById('tvTitle').textContent = group + ' · ' + rel;
    document.getElementById('tvBody').innerHTML = 'Loading…';
    document.getElementById('tvOverlay').classList.add('visible');
    fetch('/cache-files/view?group=' + encodeURIComponent(group) + '&path=' + encodeURIComponent(rel), { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.success) { document.getElementById('tvBody').innerHTML = '<div class="empty">Failed to load.</div>'; return; }
        var hdr = '<div style="margin-bottom:10px;font-size:0.72rem;color:#4a6080;">' + fmtSize(d.size) + ' · ' + fmtMtime(d.mtimeMs) +
          (d.truncated ? ' · <span style="color:#fbbf24;">showing first ' + fmtSize(d.content.length) + ' (truncated)</span>' : '') + '</div>';
        document.getElementById('tvBody').innerHTML = hdr + '<pre>' + escHtml(d.content) + '</pre>';
      })
      .catch(function(){ document.getElementById('tvBody').innerHTML = '<div class="empty">Network error.</div>'; });
  }
  function closeTV() { document.getElementById('tvOverlay').classList.remove('visible'); }

  async function delFile(group, rel) {
    var ok = await showDoubleConfirm({
      icon: '🗑',
      title: 'Delete cached file',
      message: 'Permanently delete this file?\\n\\n' + group + ' / ' + rel + '\\n\\nCache files are regenerated by the app on demand.',
      confirmText: 'Delete',
      confirmClass: 'modal-btn-danger',
      subject: rel,
      secondConfirmText: 'Yes, delete it',
    });
    if (!ok) return;
    var res = await secretFetch('/cache-files/delete?group=' + encodeURIComponent(group) + '&path=' + encodeURIComponent(rel), { method: 'POST' });
    if (!res) return;
    var data = await res.json().catch(function(){ return null; });
    if (!data || !data.success) { showToast('Delete failed: ' + ((data && data.error) || res.status), '#f87171'); return; }
    showToast('Deleted ' + (data.deleted || rel), '#10b981');
    loadGroupSection(group);
  }

  async function delAll(group, count) {
    var g = groupMeta(group);
    var tf = _tagFilter[group] || '';
    var scope = tf ? (((STRAT_BADGE[tf]||{}).label || tf) + ' files in ' + (g.label || group)) : ('files in ' + (g.label || group));
    var ok = await showDoubleConfirm({
      icon: '🗑',
      title: 'Delete ' + (tf ? ((STRAT_BADGE[tf]||{}).label || tf) + ' ' : 'ALL ') + (g.label || group) + ' files',
      message: 'Permanently delete every ' + scope + ' (' + count + ' file' + (count === 1 ? '' : 's') + ')?\\n\\n' +
        (tf ? 'Only ' + ((STRAT_BADGE[tf]||{}).label || tf) + ' files will be removed — other strategies are kept.\\n\\n' : '') +
        'This cannot be undone. Cache files are regenerated by the app on demand.',
      confirmText: 'Delete All',
      confirmClass: 'modal-btn-danger',
      subject: 'ALL ' + count + ' ' + scope,
      secondConfirmText: 'Yes, delete all',
    });
    if (!ok) return;
    var res = await secretFetch('/cache-files/delete-all?group=' + encodeURIComponent(group) + (tf ? '&tag=' + encodeURIComponent(tf) : ''), { method: 'POST' });
    if (!res) return;
    var data = await res.json().catch(function(){ return null; });
    if (!data) { showToast('Delete failed: ' + res.status, '#f87171'); return; }
    var n = (data.deleted || []).length;
    if (data.failed && data.failed.length) showToast('Deleted ' + n + ', ' + data.failed.length + ' failed', '#f87171');
    else showToast('Deleted all ' + n + ' file' + (n === 1 ? '' : 's'), '#10b981');
    // Clearing all of one strategy removes it from the filter list — drop the
    // filter so the dropdown and listing don't desync (select shows "All" while
    // the list stays scoped to a now-absent strategy).
    if (tf) _tagFilter[group] = '';
    _page[group] = 1;
    loadGroupSection(group);
  }

  initPageSizeSelector();
  loadGroups();
</script>
</div>
</div>
</body>
</html>`);
});

module.exports = router;

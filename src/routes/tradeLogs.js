/**
 * tradeLogs.js — Per-trade JSONL viewer / downloader / deleter
 *
 * One page to manage the daily ~/trading-data/trades/*.jsonl files written
 * by utils/tradeLogger.js across all 3 modes (swing / scalp / pa), plus a
 * Checkpoints tab that lists settings-audit entries (from settingsAudit.js)
 * so settings changes can be correlated with the trade JSONLs.
 *
 * Routes:
 *   GET  /trade-logs                        → UI page (Files + Checkpoints tabs)
 *   GET  /trade-logs/list                   → JSON: all daily files across all modes
 *   GET  /trade-logs/view?mode=&date=       → JSON: parsed trades for one file
 *   GET  /trade-logs/download?mode=&date=   → stream raw JSONL with Content-Disposition
 *   POST /trade-logs/delete?mode=&date=     → delete one file (API_SECRET-protected)
 *   GET  /trade-logs/audit                  → JSON: settings audit entries (newest first)
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, toastJS } = require("../utils/sharedNav");
const tradeLogger   = require("../utils/tradeLogger");
const skipLogger    = require("../utils/skipLogger");
const settingsAudit = require("../utils/settingsAudit");

const MODES = ["swing", "scalp", "pa", "orb"];

function validMode(m) { return MODES.includes(m); }
function validDate(d) { return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d); }

// Parse ?page= / ?pageSize=. Returns null when ?page is absent (legacy callers).
function parsePaging(req, defaultSize = 10, maxSize = 500) {
  const rawPage = req.query.page;
  if (rawPage === undefined || rawPage === null || rawPage === "") return null;
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || defaultSize, 1), maxSize);
  return { page, pageSize };
}

// Count trades + checkpoint markers in a daily trade JSONL.
function countTradesFile(mode, date) {
  let trades = 0, checkpoints = 0;
  try {
    const text = fs.readFileSync(tradeLogger.dailyFilePathFor(mode, date), "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && obj.type === "checkpoint") checkpoints++;
        else trades++;
      } catch (_) { /* skip bad line */ }
    }
  } catch (_) { /* file vanished */ }
  return { trades, checkpoints };
}

// ── GET /trade-logs/list — daily files. Supports ?mode= for per-mode paging. ─
// Legacy shape (no params)        → { success, modes: { swing: [...], ... } }
// Paged shape (?mode=&page=...)   → { success, mode, page, pageSize, total, count, rows }
router.get("/list", (req, res) => {
  const requestedMode = String(req.query.mode || "").toLowerCase();
  const paging = parsePaging(req, 10);

  if (requestedMode) {
    if (!validMode(requestedMode)) return res.status(400).json({ success: false, error: "bad mode" });
    let dates;
    try { dates = tradeLogger.listDailyDates(requestedMode); }
    catch (_) { dates = []; }
    const total = dates.length;
    const slice = paging
      ? dates.slice((paging.page - 1) * paging.pageSize, (paging.page - 1) * paging.pageSize + paging.pageSize)
      : dates;
    const rows = slice.map(f => {
      const c = countTradesFile(requestedMode, f.date);
      return { date: f.date, size: f.size, mtimeMs: f.mtimeMs, trades: c.trades, checkpoints: c.checkpoints };
    });
    return res.json({
      success: true,
      mode: requestedMode,
      page: paging ? paging.page : 1,
      pageSize: paging ? paging.pageSize : total,
      total,
      count: rows.length,
      rows,
    });
  }

  // Legacy aggregate shape for callers that don't pass ?mode.
  const out = {};
  for (const mode of MODES) {
    let files;
    try { files = tradeLogger.listDailyDates(mode); }
    catch (_) { files = []; }
    out[mode] = files.map(f => {
      const c = countTradesFile(mode, f.date);
      return { date: f.date, size: f.size, mtimeMs: f.mtimeMs, trades: c.trades, checkpoints: c.checkpoints };
    });
  }
  res.json({ success: true, modes: out });
});

// ── GET /trade-logs/view — parsed JSONL for one file ────────────────────────
// Legacy (no ?page)  → { success, mode, date, count, trades: [all] }
// Paged (?page=...)  → { success, mode, date, page, pageSize, total, count, trades: [slice] }
router.get("/view", (req, res) => {
  const mode = String(req.query.mode || "").toLowerCase();
  const date = String(req.query.date || "");
  if (!validMode(mode)) return res.status(400).json({ success: false, error: "bad mode" });
  if (!validDate(date)) return res.status(400).json({ success: false, error: "bad date" });
  let trades;
  try { trades = tradeLogger.readDailyTrades(mode, date); }
  catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  const paging = parsePaging(req, 25);
  if (!paging) {
    return res.json({ success: true, mode, date, count: trades.length, trades });
  }
  const total = trades.length;
  const start = (paging.page - 1) * paging.pageSize;
  const slice = trades.slice(start, start + paging.pageSize);
  res.json({
    success: true,
    mode, date,
    page: paging.page, pageSize: paging.pageSize,
    total, count: slice.length,
    trades: slice,
  });
});

// ── GET /trade-logs/download — raw JSONL stream ─────────────────────────────
router.get("/download", (req, res) => {
  const mode = String(req.query.mode || "").toLowerCase();
  const date = String(req.query.date || "");
  if (!validMode(mode)) return res.status(400).send("bad mode");
  if (!validDate(date)) return res.status(400).send("bad date");
  const fp = tradeLogger.dailyFilePathFor(mode, date);
  if (!fs.existsSync(fp)) return res.status(404).send("file not found");
  const filename = `${mode}_paper_trades_${date}.txt`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  fs.createReadStream(fp).pipe(res);
});

// ── GET /trade-logs/download-all — concat ALL daily JSONLs for a mode ───────
// Oldest first so the resulting file reads as a chronological log.
router.get("/download-all", (req, res) => {
  const mode = String(req.query.mode || "").toLowerCase();
  if (!validMode(mode)) return res.status(400).send("bad mode");
  let dates;
  try { dates = tradeLogger.listDailyDates(mode); }
  catch (_) { dates = []; }
  if (!dates.length) return res.status(404).send("no files for this mode");
  // listDailyDates is newest-first; reverse for chronological output.
  dates.sort((a, b) => a.date.localeCompare(b.date));
  const today = tradeLogger.istDateString();
  const filename = `${mode}_paper_trades_ALL_${today}.txt`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  (function writeNext(i) {
    if (i >= dates.length) return res.end();
    const fp = tradeLogger.dailyFilePathFor(mode, dates[i].date);
    const rs = fs.createReadStream(fp);
    rs.on("end", () => writeNext(i + 1));
    rs.on("error", () => writeNext(i + 1));
    rs.pipe(res, { end: false });
  })(0);
});

// ── GET /trade-logs/download-everything — concat ALL daily JSONLs, ALL modes ─
// One button to grab every strategy's logs. Grouped by mode, oldest-first within
// each mode. Each JSONL line carries its own "mode" field, so the merged file
// stays self-describing regardless of ordering.
router.get("/download-everything", (req, res) => {
  // Optional inclusive date-range filter. Either bound may be omitted.
  const from = validDate(String(req.query.from || "")) ? String(req.query.from) : null;
  const to = validDate(String(req.query.to || "")) ? String(req.query.to) : null;
  if (from && to && from > to) return res.status(400).send("from date is after to date");
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const files = []; // flat list of { mode, date }, in download order
  for (const mode of MODES) {
    let dates;
    try { dates = tradeLogger.listDailyDates(mode); }
    catch (_) { dates = []; }
    dates.sort((a, b) => a.date.localeCompare(b.date)); // oldest-first per mode
    for (const d of dates) if (inRange(d.date)) files.push({ mode, date: d.date });
  }
  if (!files.length) return res.status(404).send("no trade logs found for the selected range");
  const today = tradeLogger.istDateString();
  const rangeTag = (from || to) ? `_${from || "start"}_to_${to || today}` : "";
  const filename = `all_strategies_paper_trades_ALL${rangeTag}_${today}.txt`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  (function writeNext(i) {
    if (i >= files.length) return res.end();
    const fp = tradeLogger.dailyFilePathFor(files[i].mode, files[i].date);
    const rs = fs.createReadStream(fp);
    rs.on("end", () => writeNext(i + 1));
    rs.on("error", () => writeNext(i + 1));
    rs.pipe(res, { end: false });
  })(0);
});



// ── POST /trade-logs/delete — delete one file (write op, gated) ─────────────
router.post("/delete", (req, res) => {
  const mode = String(req.query.mode || req.body?.mode || "").toLowerCase();
  const date = String(req.query.date || req.body?.date || "");
  if (!validMode(mode)) return res.status(400).json({ success: false, error: "bad mode" });
  if (!validDate(date)) return res.status(400).json({ success: false, error: "bad date" });
  const fp = tradeLogger.dailyFilePathFor(mode, date);
  try {
    fs.unlinkSync(fp);
    console.log(`[trade-logs] deleted ${fp}`);
    res.json({ success: true, deleted: path.basename(fp) });
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ success: false, error: "file not found" });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /trade-logs/delete-all — delete every daily file for a mode ────────
router.post("/delete-all", (req, res) => {
  const mode = String(req.query.mode || req.body?.mode || "").toLowerCase();
  if (!validMode(mode)) return res.status(400).json({ success: false, error: "bad mode" });
  let dates;
  try { dates = tradeLogger.listDailyDates(mode); }
  catch (_) { dates = []; }
  const deleted = [];
  const failed = [];
  for (const d of dates) {
    const fp = tradeLogger.dailyFilePathFor(mode, d.date);
    try { fs.unlinkSync(fp); deleted.push(d.date); }
    catch (err) { if (err.code !== "ENOENT") failed.push({ date: d.date, error: err.message }); }
  }
  console.log(`[trade-logs] delete-all mode=${mode} removed=${deleted.length} failed=${failed.length}`);
  res.json({ success: failed.length === 0, mode, deleted, failed });
});

// Count skip lines + per-gate buckets for a daily skip JSONL.
function countSkipsFile(mode, date) {
  let total = 0;
  const byGate = {};
  try {
    const text = fs.readFileSync(skipLogger.filePathFor(mode, date), "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        total++;
        const g = obj && obj.gate ? String(obj.gate) : "unknown";
        byGate[g] = (byGate[g] || 0) + 1;
      } catch (_) { /* skip bad line */ }
    }
  } catch (_) { /* file vanished */ }
  return { total, byGate };
}

// ── GET /trade-logs/skips/list — daily skip files. Same paging contract as /list.
router.get("/skips/list", (req, res) => {
  const requestedMode = String(req.query.mode || "").toLowerCase();
  const paging = parsePaging(req, 10);

  if (requestedMode) {
    if (!validMode(requestedMode)) return res.status(400).json({ success: false, error: "bad mode" });
    let dates;
    try { dates = skipLogger.listDates(requestedMode); }
    catch (_) { dates = []; }
    const total = dates.length;
    const slice = paging
      ? dates.slice((paging.page - 1) * paging.pageSize, (paging.page - 1) * paging.pageSize + paging.pageSize)
      : dates;
    const rows = slice.map(f => {
      const c = countSkipsFile(requestedMode, f.date);
      return { date: f.date, size: f.size, mtimeMs: f.mtimeMs, total: c.total, byGate: c.byGate };
    });
    return res.json({
      success: true,
      mode: requestedMode,
      page: paging ? paging.page : 1,
      pageSize: paging ? paging.pageSize : total,
      total,
      count: rows.length,
      rows,
    });
  }

  const out = {};
  for (const mode of MODES) {
    let files;
    try { files = skipLogger.listDates(mode); }
    catch (_) { files = []; }
    out[mode] = files.map(f => {
      const c = countSkipsFile(mode, f.date);
      return { date: f.date, size: f.size, mtimeMs: f.mtimeMs, total: c.total, byGate: c.byGate };
    });
  }
  res.json({ success: true, modes: out });
});

// ── GET /trade-logs/skips/view — parsed JSONL for one skip file ─────────────
router.get("/skips/view", (req, res) => {
  const mode = String(req.query.mode || "").toLowerCase();
  const date = String(req.query.date || "");
  if (!validMode(mode)) return res.status(400).json({ success: false, error: "bad mode" });
  if (!validDate(date)) return res.status(400).json({ success: false, error: "bad date" });
  let skips;
  try { skips = skipLogger.readDailySkips(mode, date); }
  catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  const paging = parsePaging(req, 25);
  if (!paging) {
    return res.json({ success: true, mode, date, count: skips.length, skips });
  }
  const total = skips.length;
  const start = (paging.page - 1) * paging.pageSize;
  const slice = skips.slice(start, start + paging.pageSize);
  res.json({
    success: true,
    mode, date,
    page: paging.page, pageSize: paging.pageSize,
    total, count: slice.length,
    skips: slice,
  });
});

// ── GET /trade-logs/skips/download — raw JSONL stream ───────────────────────
router.get("/skips/download", (req, res) => {
  const mode = String(req.query.mode || "").toLowerCase();
  const date = String(req.query.date || "");
  if (!validMode(mode)) return res.status(400).send("bad mode");
  if (!validDate(date)) return res.status(400).send("bad date");
  const fp = skipLogger.filePathFor(mode, date);
  if (!fs.existsSync(fp)) return res.status(404).send("file not found");
  const filename = `${mode}_paper_skips_${date}.txt`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  fs.createReadStream(fp).pipe(res);
});

// ── GET /trade-logs/skips/download-all — concat ALL daily skip JSONLs ───────
router.get("/skips/download-all", (req, res) => {
  const mode = String(req.query.mode || "").toLowerCase();
  if (!validMode(mode)) return res.status(400).send("bad mode");
  let dates;
  try { dates = skipLogger.listDates(mode); }
  catch (_) { dates = []; }
  if (!dates.length) return res.status(404).send("no files for this mode");
  dates.sort((a, b) => a.date.localeCompare(b.date));
  const today = skipLogger.istDateString();
  const filename = `${mode}_paper_skips_ALL_${today}.txt`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  (function writeNext(i) {
    if (i >= dates.length) return res.end();
    const fp = skipLogger.filePathFor(mode, dates[i].date);
    const rs = fs.createReadStream(fp);
    rs.on("end", () => writeNext(i + 1));
    rs.on("error", () => writeNext(i + 1));
    rs.pipe(res, { end: false });
  })(0);
});

// ── GET /trade-logs/skips/download-everything — concat ALL skip JSONLs, ALL modes ─
// One button for every strategy's skip logs. Grouped by mode, oldest-first within
// each mode. Each line carries its own "mode" field, so the merge stays self-describing.
router.get("/skips/download-everything", (req, res) => {
  const files = []; // flat list of { mode, date }, in download order
  for (const mode of MODES) {
    let dates;
    try { dates = skipLogger.listDates(mode); }
    catch (_) { dates = []; }
    dates.sort((a, b) => a.date.localeCompare(b.date)); // oldest-first per mode
    for (const d of dates) files.push({ mode, date: d.date });
  }
  if (!files.length) return res.status(404).send("no skip logs found");
  const today = skipLogger.istDateString();
  const filename = `all_strategies_paper_skips_ALL_${today}.txt`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  (function writeNext(i) {
    if (i >= files.length) return res.end();
    const fp = skipLogger.filePathFor(files[i].mode, files[i].date);
    const rs = fs.createReadStream(fp);
    rs.on("end", () => writeNext(i + 1));
    rs.on("error", () => writeNext(i + 1));
    rs.pipe(res, { end: false });
  })(0);
});

// ── POST /trade-logs/skips/delete — delete one skip file (gated) ────────────
router.post("/skips/delete", (req, res) => {
  const mode = String(req.query.mode || req.body?.mode || "").toLowerCase();
  const date = String(req.query.date || req.body?.date || "");
  if (!validMode(mode)) return res.status(400).json({ success: false, error: "bad mode" });
  if (!validDate(date)) return res.status(400).json({ success: false, error: "bad date" });
  const fp = skipLogger.filePathFor(mode, date);
  try {
    fs.unlinkSync(fp);
    console.log(`[trade-logs] deleted skip file ${fp}`);
    res.json({ success: true, deleted: path.basename(fp) });
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ success: false, error: "file not found" });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /trade-logs/skips/delete-all — delete every daily skip file ────────
router.post("/skips/delete-all", (req, res) => {
  const mode = String(req.query.mode || req.body?.mode || "").toLowerCase();
  if (!validMode(mode)) return res.status(400).json({ success: false, error: "bad mode" });
  let dates;
  try { dates = skipLogger.listDates(mode); }
  catch (_) { dates = []; }
  const deleted = [];
  const failed = [];
  for (const d of dates) {
    const fp = skipLogger.filePathFor(mode, d.date);
    try { fs.unlinkSync(fp); deleted.push(d.date); }
    catch (err) { if (err.code !== "ENOENT") failed.push({ date: d.date, error: err.message }); }
  }
  console.log(`[trade-logs] skips delete-all mode=${mode} removed=${deleted.length} failed=${failed.length}`);
  res.json({ success: failed.length === 0, mode, deleted, failed });
});

// ── GET /trade-logs/audit — settings audit entries (newest first) ───────────
// Filters (key, action, noted) are applied server-side. ?page= enables paging.
router.get("/audit", (req, res) => {
  const key    = req.query.key || null;
  const action = req.query.action || null;
  const onlyNoted = String(req.query.noted || "") === "1";
  const paging = parsePaging(req, 25);

  // When paged, read full filtered set then slice. When not paged, honor legacy ?limit=.
  const limit = paging
    ? 100000
    : Math.min(parseInt(req.query.limit, 10) || 1000, 5000);

  let entries;
  try { entries = settingsAudit.readAuditLog({ limit, key, action }); }
  catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  if (onlyNoted) entries = entries.filter(e => typeof e.note === "string" && e.note.trim().length > 0);

  if (!paging) {
    return res.json({ success: true, count: entries.length, entries });
  }
  const total = entries.length;
  const start = (paging.page - 1) * paging.pageSize;
  const slice = entries.slice(start, start + paging.pageSize);
  res.json({
    success: true,
    page: paging.page, pageSize: paging.pageSize,
    total, count: slice.length,
    entries: slice,
  });
});

// Which strategy sections to show — mirrors sidebar/Settings master toggles.
function enabledModesFromEnv() {
  const on = (v) => String(v == null ? "true" : v).toLowerCase() === "true";
  return {
    swing:    on(process.env.SWING_MODE_ENABLED),
    scalp:    on(process.env.SCALP_MODE_ENABLED),
    pa:       on(process.env.PA_MODE_ENABLED),
    orb:      on(process.env.ORB_MODE_ENABLED),
  };
}

// ── GET /trade-logs — UI page ───────────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const enabled = enabledModesFromEnv();
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  ${faviconLink()}
  <title>Trade Logs — Trading BOT</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    html, body { height:100%; }
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; }
    ${sidebarCSS()}
    ${modalCSS()}
    .page { padding:22px 28px 80px; max-width:1240px; }
    h1 { font-size:1.05rem; color:#60a5fa; font-weight:600; margin-bottom:4px; }
    .sub { font-size:0.72rem; color:#4a6080; margin-bottom:18px; }
    .tabs-row { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; border-bottom:1px solid #1a2236; margin-bottom:14px; flex-wrap:wrap; }
    .tabs { display:flex; gap:6px; }
    .page-size-ctrl { display:flex; align-items:center; gap:8px; padding-bottom:6px; font-size:0.66rem; color:#4a6080; text-transform:uppercase; letter-spacing:0.5px; }
    .page-size-ctrl select { padding:5px 9px; background:#0a1528; border:1px solid #1e3a5a; border-radius:6px; color:#c8d8f0; font-family:inherit; font-size:0.72rem; outline:none; }
    .pager { display:flex; align-items:center; justify-content:space-between; padding:8px 14px; background:#08111e; border-top:1px solid #121a2a; gap:10px; flex-wrap:wrap; }
    .pager-info { font-size:0.66rem; color:#64748b; font-family:'IBM Plex Mono',monospace; }
    .pager-btns { display:flex; align-items:center; gap:6px; }
    .pager-btns button { font-size:0.66rem; padding:3px 10px; background:#0a1528; border:1px solid #1e3a5a; border-radius:5px; color:#94a3b8; cursor:pointer; font-family:inherit; }
    .pager-btns button:hover:not(:disabled) { color:#60a5fa; border-color:#3b82f6; }
    .pager-btns button:disabled { opacity:0.35; cursor:not-allowed; }
    .pager-btns .pager-page { font-size:0.66rem; color:#94a3b8; font-family:'IBM Plex Mono',monospace; padding:0 4px; }
    .tab { padding:9px 16px; cursor:pointer; font-size:0.74rem; font-weight:600; color:#4a6080; border-bottom:2px solid transparent; user-select:none; }
    .tab.active { color:#60a5fa; border-bottom-color:#3b82f6; }
    .tab .badge { display:inline-block; margin-left:6px; padding:1px 7px; font-size:0.6rem; background:#0a1528; border:1px solid #1e3a5a; border-radius:999px; color:#94a3b8; }
    .tab-pane { display:none; }
    .tab-pane.active { display:block; }
    .mode-section { margin-bottom:22px; background:#0a1018; border:1px solid #1a2236; border-radius:8px; overflow:hidden; }
    .mode-head { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:#0d1320; border-bottom:1px solid #1a2236; }
    .mode-name { font-weight:700; font-size:0.78rem; letter-spacing:0.5px; text-transform:uppercase; }
    .mode-swing    { color:#60a5fa; }
    .mode-scalp    { color:#fbbf24; }
    .mode-pa       { color:#a78bfa; }
    .mode-orb      { color:#10b981; }
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
    .btn-restore  { background:#07140a; border-color:#14401f; color:#34d399; }
    .btn:hover { filter:brightness(1.2); }
    .actions { display:flex; gap:5px; }
    .files-toolbar { display:flex; justify-content:flex-end; align-items:center; gap:10px; margin-bottom:14px; }
    .dl-range-lbl { font-size:0.68rem; color:#4a6080; display:flex; align-items:center; gap:5px; }
    .dl-range-inp { font-size:0.68rem; padding:4px 6px; border:1px solid #cfe0f4; border-radius:5px; background:#fff; color:#1d3a5f; }
    .btn-download-all { font-size:0.72rem; padding:7px 14px; }
    .num { font-family:'IBM Plex Mono',monospace; }
    .filt-bar { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; align-items:center; }
    .filt-bar input, .filt-bar select { padding:6px 10px; background:#0a1528; border:1px solid #1e3a5a; border-radius:6px; color:#c8d8f0; font-family:inherit; font-size:0.72rem; outline:none; }
    .filt-bar label { font-size:0.66rem; color:#4a6080; text-transform:uppercase; letter-spacing:0.5px; }
    .badge-ck { display:inline-block; padding:1px 7px; font-size:0.6rem; background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.3); border-radius:4px; color:#fbbf24; margin-left:6px; }

    /* Audit table */
    .audit-row.has-note { background:rgba(96,165,250,0.04); }
    .audit-row.has-note td:first-child { border-left:2px solid #3b82f6; }
    .audit-note { display:block; margin-top:4px; font-size:0.66rem; color:#94a3b8; font-style:italic; }
    .act-add    { color:#10b981; }
    .act-update { color:#f59e0b; }
    .act-delete { color:#ef4444; }
    .from-val { color:#fca5a5; font-family:'IBM Plex Mono',monospace; }
    .to-val   { color:#86efac; font-family:'IBM Plex Mono',monospace; }

    /* Trade-view modal */
    .tv-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:1000; align-items:flex-start; justify-content:center; padding:40px 16px; overflow-y:auto; }
    .tv-overlay.visible { display:flex; }
    .tv-box { width:100%; max-width:1100px; background:#0a1018; border:1px solid #1a2236; border-radius:10px; }
    .tv-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid #1a2236; }
    .tv-title { font-size:0.85rem; font-weight:600; color:#c8d8f0; }
    .tv-close { background:transparent; border:none; color:#64748b; cursor:pointer; font-size:1.2rem; padding:0 6px; }
    .tv-body { padding:12px 18px 18px; max-height:70vh; overflow-y:auto; }
    .tv-body table { font-size:0.68rem; }
    .tv-body pre { background:#0d1320; border:1px solid #1a2236; border-radius:5px; padding:9px 11px; font-family:'IBM Plex Mono',monospace; font-size:0.66rem; color:#94a3b8; white-space:pre-wrap; word-break:break-all; }

    @media (max-width:640px) {
      html, body { height:auto; }
      body { display:block; height:auto; overflow-x:hidden; }
      .page { padding:14px; }
      table { font-size:0.66rem; }
      th, td { padding:6px 8px; }
    }

    /* ── LIGHT THEME OVERRIDES ─────────────────────────────────────────
       Activated when UI_THEME=light. sharedNav.js sets data-theme="light"
       on <html> at runtime; these rules mirror the same palette used by
       Settings / Dashboard so this page matches the rest of the app. */
    :root[data-theme="light"] body { background:#f4f6f9; color:#334155; }
    :root[data-theme="light"] .page { color:#334155; }
    :root[data-theme="light"] h1 { color:#1e40af; }
    :root[data-theme="light"] .sub { color:#64748b; }
    :root[data-theme="light"] .sub code { background:#f1f5f9; padding:1px 5px; border-radius:3px; color:#475569; }
    :root[data-theme="light"] .tabs-row { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .page-size-ctrl { color:#64748b; }
    :root[data-theme="light"] .page-size-ctrl select { background:#fff; border-color:#e0e4ea; color:#334155; }
    :root[data-theme="light"] .pager { background:#f8fafc; border-top-color:#e0e4ea; }
    :root[data-theme="light"] .pager-info, :root[data-theme="light"] .pager-btns .pager-page { color:#64748b; }
    :root[data-theme="light"] .pager-btns button { background:#fff; border-color:#e0e4ea; color:#475569; }
    :root[data-theme="light"] .pager-btns button:hover:not(:disabled) { color:#1e40af; border-color:#3b82f6; }
    :root[data-theme="light"] .tab { color:#94a3b8; }
    :root[data-theme="light"] .tab.active { color:#1e40af; border-bottom-color:#3b82f6; }
    :root[data-theme="light"] .tab .badge { background:#f1f5f9; border-color:#e0e4ea; color:#64748b; }
    :root[data-theme="light"] .mode-section { background:#fff; border-color:#e0e4ea; }
    :root[data-theme="light"] .mode-head { background:#f8fafc; border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .mode-meta { color:#94a3b8; }
    :root[data-theme="light"] th { background:#f1f5f9; color:#64748b; }
    :root[data-theme="light"] th, :root[data-theme="light"] td { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] tr:hover td { background:#f8fafc; }
    :root[data-theme="light"] .empty { color:#94a3b8; }
    :root[data-theme="light"] .filt-bar input,
    :root[data-theme="light"] .filt-bar select { background:#fff; border-color:#e0e4ea; color:#334155; }
    :root[data-theme="light"] .filt-bar label { color:#64748b; }
    :root[data-theme="light"] .btn-view     { background:#eff6ff; border-color:#bfdbfe; color:#1e40af; }
    :root[data-theme="light"] .btn-download { background:#eef2ff; border-color:#c7d2fe; color:#4338ca; }
    :root[data-theme="light"] .btn-delete   { background:#fef2f2; border-color:#fecaca; color:#b91c1c; }
    :root[data-theme="light"] .btn-restore  { background:#ecfdf5; border-color:#a7f3d0; color:#047857; }
    :root[data-theme="light"] .tv-overlay { background:rgba(15,23,42,0.55); }
    :root[data-theme="light"] .tv-box { background:#fff; border-color:#e0e4ea; }
    :root[data-theme="light"] .tv-head { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .tv-title { color:#1e293b; }
    :root[data-theme="light"] .tv-close { color:#94a3b8; }
    :root[data-theme="light"] .tv-body pre { background:#f8fafc; border-color:#e0e4ea; color:#475569; }
    :root[data-theme="light"] .audit-row.has-note { background:rgba(59,130,246,0.04); }
    :root[data-theme="light"] .audit-note { color:#475569; }
    :root[data-theme="light"] .from-val { color:#b91c1c; }
    :root[data-theme="light"] .to-val   { color:#15803d; }
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('tradeLogs', liveActive)}
<div class="main-content">

<div class="top-bar">
  <div>
    <div class="top-bar-title">🗂 Trade Logs</div>
    <div class="top-bar-meta">Per-trade JSONL files · settings checkpoints · stored under ~/trading-data/trades</div>
  </div>
</div>

<div class="page">
  <div class="tabs-row">
    <div class="tabs">
      <div class="tab active" data-tab="files" onclick="setTab('files')">📁 Trade Files <span class="badge" id="filesBadge">—</span></div>
      <div class="tab" data-tab="skips" onclick="setTab('skips')">🚫 Skip Logs <span class="badge" id="skipsBadge">—</span></div>
      <div class="tab" data-tab="audit" onclick="setTab('audit')">🔖 Checkpoints &amp; Settings Changes <span class="badge" id="auditBadge">—</span></div>
    </div>
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

  <!-- ── FILES TAB ─────────────────────────────────────────────────── -->
  <div class="tab-pane active" id="pane-files">
    <div class="files-toolbar">
      <label class="dl-range-lbl">From <input type="date" id="dlFrom" class="dl-range-inp"/></label>
      <label class="dl-range-lbl">To <input type="date" id="dlTo" class="dl-range-inp"/></label>
      <a class="btn btn-download btn-download-all" href="/trade-logs/download-everything" onclick="return onDownloadEverything(event)"
         title="Download every strategy's daily trade logs as one combined file (grouped by mode, oldest first). Leave the dates blank for all history, or pick a From/To range. Each line carries its own mode field.">⬇ Download Everything (all strategies)</a>
    </div>
    <div id="filesArea">Loading…</div>
  </div>

  <!-- ── SKIPS TAB ─────────────────────────────────────────────────── -->
  <div class="tab-pane" id="pane-skips">
    <div class="sub">Strategy / VIX / spread filter rejections — every signal that <em>almost</em> entered but was blocked by a gate. Files at <code>~/trading-data/skips/</code>. Click View to see per-row reason + indicator snapshot. Operational gates (cooldown, daily-loss cap, market-hours) are NOT logged here — only strategy gates.</div>
    <div class="files-toolbar">
      <a class="btn btn-download btn-download-all" href="/trade-logs/skips/download-everything"
         title="Download every strategy's daily skip logs as one combined file (grouped by mode, oldest first). Each line carries its own mode field.">⬇ Download Everything (all strategies)</a>
    </div>
    <div id="skipsArea">Click the tab to load…</div>
  </div>

  <!-- ── AUDIT TAB ─────────────────────────────────────────────────── -->
  <div class="tab-pane" id="pane-audit">
    <div class="sub">Every settings save through <code>/settings</code> writes old→new for each changed key here (with the optional checkpoint note you typed). Use this to correlate trade outcomes with the settings active at the time.</div>
    <div class="filt-bar">
      <label>Filter key</label>
      <input id="filtKey" type="text" placeholder="e.g. SCALP_ or ADX_MIN" oninput="onAuditFilterChange()"/>
      <label>Action</label>
      <select id="filtAction" onchange="onAuditFilterChange()">
        <option value="">all</option>
        <option value="update">update</option>
        <option value="add">add</option>
        <option value="delete">delete</option>
      </select>
      <label><input id="filtNoted" type="checkbox" onchange="onAuditFilterChange()"/> Checkpoints only (have note)</label>
      <span style="flex:1"></span>
      <span id="auditCount" style="font-size:0.66rem; color:#4a6080;"></span>
    </div>
    <div id="auditArea">Loading…</div>
  </div>
</div>

<!-- Trade-view modal -->
<div class="tv-overlay" id="tvOverlay" onclick="if(event.target===this) closeTV()">
  <div class="tv-box">
    <div class="tv-head">
      <div class="tv-title" id="tvTitle">Trades</div>
      <button class="tv-close" onclick="closeTV()">✕</button>
    </div>
    <div class="tv-body" id="tvBody">…</div>
  </div>
</div>

<script>
  ${modalJS()}
  ${toastJS()}

  var ENABLED_MODES = ${JSON.stringify(enabled)};

  var MODE_LIST = [
    { key: 'swing',    label: 'SWING',        cls: 'mode-swing' },
    { key: 'scalp',    label: 'SCALP',        cls: 'mode-scalp' },
    { key: 'pa',       label: 'PRICE ACTION', cls: 'mode-pa' },
    { key: 'orb',      label: 'ORB',          cls: 'mode-orb' },
  ];
  function enabledModes() { return MODE_LIST.filter(function(m){ return ENABLED_MODES[m.key] !== false; }); }

  // Page size is global across all paginated views, persisted in localStorage.
  var _pageSize = (function(){
    try {
      var v = parseInt(localStorage.getItem('tradeLogs_pageSize'), 10);
      if (v === 5 || v === 10 || v === 25 || v === 50 || v === 100) return v;
    } catch (_) {}
    return 10;
  })();

  // Per-section page state.
  var _filesPage  = { swing:1, scalp:1, pa:1, orb:1 };
  var _skipsPage  = { swing:1, scalp:1, pa:1, orb:1 };
  var _auditPage  = 1;
  var _view = { mode:null, date:null, kind:null, page:1, total:0, pageSize:25 }; // modal state

  // Section totals cached so the badge survives prev/next clicks without refetching all modes.
  var _filesTotals = { swing:0, scalp:0, pa:0, orb:0 };
  var _skipsTotals = { swing:0, scalp:0, pa:0, orb:0 };

  function fmtSize(n) {
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

  // Initialise the page-size selector to the persisted value before any loads.
  function initPageSizeSelector() {
    var el = document.getElementById('pageSizeSelect');
    if (el) el.value = String(_pageSize);
  }

  // Build the download-everything URL from the optional From/To date inputs,
  // then navigate to it (browser handles the file download via Content-Disposition).
  function onDownloadEverything(ev) {
    ev.preventDefault();
    var from = (document.getElementById('dlFrom').value || '').trim();
    var to = (document.getElementById('dlTo').value || '').trim();
    if (from && to && from > to) { alert('From date is after To date.'); return false; }
    var qs = [];
    if (from) qs.push('from=' + encodeURIComponent(from));
    if (to) qs.push('to=' + encodeURIComponent(to));
    window.location = '/trade-logs/download-everything' + (qs.length ? '?' + qs.join('&') : '');
    return false;
  }

  function onPageSizeChange() {
    var v = parseInt(document.getElementById('pageSizeSelect').value, 10);
    if (![5, 10, 25, 50, 100].includes(v)) v = 10;
    _pageSize = v;
    try { localStorage.setItem('tradeLogs_pageSize', String(v)); } catch (_) {}
    // Reset every page state to 1 and reload the visible tab.
    Object.keys(_filesPage).forEach(function(k){ _filesPage[k] = 1; });
    Object.keys(_skipsPage).forEach(function(k){ _skipsPage[k] = 1; });
    _auditPage = 1;
    _view.page = 1;
    _view.pageSize = v;
    var active = document.querySelector('.tab.active');
    var tab = active ? active.dataset.tab : 'files';
    if (tab === 'files') loadFiles();
    else if (tab === 'skips') loadSkips();
    else if (tab === 'audit') loadAudit();
    // If the modal is open, refresh its current page too.
    if (document.getElementById('tvOverlay').classList.contains('visible') && _view.mode) {
      loadViewPage();
    }
  }

  function setTab(name) {
    document.querySelectorAll('.tab').forEach(function(t){ t.classList.toggle('active', t.dataset.tab === name); });
    document.querySelectorAll('.tab-pane').forEach(function(p){ p.classList.toggle('active', p.id === 'pane-' + name); });
    if (name === 'audit') loadAudit();
    if (name === 'skips') loadSkips();
  }

  // Render a pagination footer. The "kind" arg decides which JS handler to invoke on click.
  function pagerHtml(kind, modeKey, page, pageSize, total) {
    var maxPage = Math.max(1, Math.ceil(total / pageSize));
    var p = Math.min(page, maxPage);
    var start = total === 0 ? 0 : (p - 1) * pageSize + 1;
    var end = Math.min(p * pageSize, total);
    var modeArg = modeKey ? ("'" + modeKey + "'") : 'null';
    var prevDisabled = p <= 1 ? ' disabled' : '';
    var nextDisabled = p >= maxPage ? ' disabled' : '';
    return '<div class="pager">' +
      '<div class="pager-info">' + (total === 0 ? '0 rows' : ('Showing ' + start + '–' + end + ' of ' + total)) + '</div>' +
      '<div class="pager-btns">' +
        '<button onclick="goPage(\\'' + kind + '\\',' + modeArg + ',-1)"' + prevDisabled + '>‹ Prev</button>' +
        '<span class="pager-page">Page ' + p + ' / ' + maxPage + '</span>' +
        '<button onclick="goPage(\\'' + kind + '\\',' + modeArg + ',1)"' + nextDisabled + '>Next ›</button>' +
      '</div>' +
    '</div>';
  }

  function goPage(kind, modeKey, delta) {
    if (kind === 'files') {
      _filesPage[modeKey] = Math.max(1, (_filesPage[modeKey] || 1) + delta);
      loadFileSection(modeKey);
    } else if (kind === 'skips') {
      _skipsPage[modeKey] = Math.max(1, (_skipsPage[modeKey] || 1) + delta);
      loadSkipSection(modeKey);
    } else if (kind === 'audit') {
      _auditPage = Math.max(1, _auditPage + delta);
      loadAudit();
    } else if (kind === 'view') {
      _view.page = Math.max(1, _view.page + delta);
      loadViewPage();
    }
  }

  // ── FILES tab ───────────────────────────────────────────────────────
  function loadFiles() {
    var modes = enabledModes();
    if (modes.length === 0) {
      document.getElementById('filesArea').innerHTML = '<div class="empty">No strategies enabled.</div>';
      document.getElementById('filesBadge').textContent = '0';
      return;
    }
    // Build empty shells so each section can populate independently.
    document.getElementById('filesArea').innerHTML = modes.map(function(m){
      return '<div class="mode-section" id="filesSection-' + m.key + '"><div class="mode-head"><div class="mode-name ' + m.cls + '">' + m.label + '</div><div class="mode-meta">loading…</div></div></div>';
    }).join('');
    Promise.all(modes.map(function(m){ return loadFileSection(m.key); })).then(function(){
      var sum = 0;
      modes.forEach(function(m){ sum += (_filesTotals[m.key] || 0); });
      document.getElementById('filesBadge').textContent = sum;
    });
  }

  function loadFileSection(modeKey) {
    var page = _filesPage[modeKey] || 1;
    var url = '/trade-logs/list?mode=' + modeKey + '&page=' + page + '&pageSize=' + _pageSize;
    return fetch(url, { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.success) {
          document.getElementById('filesSection-' + modeKey).innerHTML = '<div class="empty">Failed to load.</div>';
          return;
        }
        _filesTotals[modeKey] = d.total || 0;
        _filesPage[modeKey] = d.page || 1;
        var m = MODE_LIST.find(function(x){ return x.key === modeKey; });
        document.getElementById('filesSection-' + modeKey).innerHTML = renderFileSectionHTML(m, d);
        // Recompute the badge from cached per-mode totals (works after prev/next too).
        var sum = 0;
        enabledModes().forEach(function(em){ sum += (_filesTotals[em.key] || 0); });
        document.getElementById('filesBadge').textContent = sum;
      })
      .catch(function(){
        document.getElementById('filesSection-' + modeKey).innerHTML = '<div class="empty">Cannot reach server.</div>';
      });
  }

  function renderFileSectionHTML(m, d) {
    var rows = d.rows || [];
    var total = d.total || 0;
    var totalTrades = rows.reduce(function(s,r){ return s + (r.trades || 0); }, 0);
    var bodyHtml = rows.length === 0
      ? '<div class="empty">No JSONL files yet for ' + m.label + '.</div>'
      : '<table><thead><tr><th>IST Date</th><th>Trades</th><th>Size</th><th>Modified (IST)</th><th></th></tr></thead><tbody>' +
        rows.map(function(r){
          var ckBadge = r.checkpoints > 0
            ? '<span class="badge-ck" title="' + r.checkpoints + ' checkpoint marker(s) in this file">🔖 ' + r.checkpoints + '</span>'
            : '';
          return '<tr>' +
            '<td class="num">' + escHtml(r.date) + ckBadge + '</td>' +
            '<td class="num">' + r.trades + '</td>' +
            '<td class="num">' + fmtSize(r.size) + '</td>' +
            '<td class="num">' + fmtMtime(r.mtimeMs) + '</td>' +
            '<td><div class="actions">' +
              '<button class="btn btn-view"     onclick="viewFile(\\''+m.key+'\\',\\''+r.date+'\\')">👁 View</button>' +
              '<a       class="btn btn-download" href="/trade-logs/download?mode='+m.key+'&date='+encodeURIComponent(r.date)+'">⬇ Download</a>' +
              '<button class="btn btn-delete"   onclick="delFile(\\''+m.key+'\\',\\''+r.date+'\\')">🗑 Delete</button>' +
            '</div></td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    var dlAll = total > 0
      ? '<a class="btn btn-download" href="/trade-logs/download-all?mode=' + m.key + '" title="Download all ' + total + ' daily files concatenated, oldest first">⬇ Download All (' + total + ')</a>'
      : '';
    var delAll = total > 0
      ? '<button class="btn btn-delete" onclick="delAllFiles(\\''+m.key+'\\','+total+')" title="Delete every daily file for this mode">🗑 Delete All (' + total + ')</button>'
      : '';
    return '<div class="mode-head">' +
        '<div class="mode-name ' + m.cls + '">' + m.label + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<div class="mode-meta">' + total + ' file' + (total === 1 ? '' : 's') + ' · ' + totalTrades + ' trade' + (totalTrades === 1 ? '' : 's') + ' on page</div>' +
          dlAll + delAll +
        '</div>' +
      '</div>' +
      bodyHtml +
      (total > _pageSize ? pagerHtml('files', m.key, d.page, d.pageSize, total) : '');
  }

  function viewFile(mode, date) {
    _view = { mode: mode, date: date, kind: 'trades', page: 1, total: 0, pageSize: _pageSize };
    document.getElementById('tvTitle').textContent = mode.toUpperCase() + ' · ' + date;
    document.getElementById('tvBody').innerHTML = 'Loading…';
    document.getElementById('tvOverlay').classList.add('visible');
    loadViewPage();
  }

  function loadViewPage() {
    if (!_view.mode || !_view.date) return;
    _view.pageSize = _pageSize;
    var url = _view.kind === 'skips'
      ? '/trade-logs/skips/view?mode=' + _view.mode + '&date=' + encodeURIComponent(_view.date) + '&page=' + _view.page + '&pageSize=' + _view.pageSize
      : '/trade-logs/view?mode=' + _view.mode + '&date=' + encodeURIComponent(_view.date) + '&page=' + _view.page + '&pageSize=' + _view.pageSize;
    document.getElementById('tvBody').innerHTML = 'Loading…';
    fetch(url, { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.success) { document.getElementById('tvBody').innerHTML = '<div class="empty">Failed to load.</div>'; return; }
        var items = _view.kind === 'skips' ? d.skips : d.trades;
        _view.total = d.total || 0;
        _view.page = d.page || 1;
        if (!items || items.length === 0) { document.getElementById('tvBody').innerHTML = '<div class="empty">Empty file.</div>'; return; }
        var startIdx = (_view.page - 1) * _view.pageSize;
        var html;
        if (_view.kind === 'skips') {
          var byGate = {};
          items.forEach(function(s){ var g = s.gate || 'unknown'; byGate[g] = (byGate[g] || 0) + 1; });
          var gateList = Object.keys(byGate).sort(function(a,b){ return byGate[b] - byGate[a]; });
          html = '<div style="margin-bottom:10px;font-size:0.72rem;color:#4a6080;">' + _view.total + ' skip record(s) · showing page ' + _view.page + '.</div>';
          html += '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">' +
            gateList.map(function(g){ return '<span style="font-size:0.66rem;padding:3px 9px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);border-radius:4px;color:#fbbf24;"><b>' + byGate[g] + '</b> · ' + escHtml(g) + ' (this page)</span>'; }).join('') +
            '</div>';
          html += items.map(function(s, i){
            var when = s.ts || '';
            return '<div style="margin-bottom:9px;"><div style="font-size:0.66rem;color:#64748b;margin-bottom:3px;">#' + (startIdx + i + 1) + ' · ' + escHtml(when) + ' · gate=<span style="color:#fbbf24;">' + escHtml(s.gate || '?') + '</span>' + (s.reason ? ' · reason=' + escHtml(s.reason) : '') + '</div><pre>' + escHtml(JSON.stringify(s, null, 2)) + '</pre></div>';
          }).join('');
        } else {
          html = '<div style="margin-bottom:10px;font-size:0.72rem;color:#4a6080;">' + _view.total + ' record(s) in this file · showing page ' + _view.page + '.</div>';
          html += items.map(function(t, i){
            var label = t.type === 'checkpoint' ? '🔖 CHECKPOINT' : ('#' + (startIdx + i + 1));
            return '<div style="margin-bottom:9px;"><div style="font-size:0.66rem;color:#64748b;margin-bottom:3px;">' + label + (t.loggedAt ? ' · ' + escHtml(t.loggedAt) : '') + '</div><pre>' + escHtml(JSON.stringify(t, null, 2)) + '</pre></div>';
          }).join('');
        }
        html += pagerHtml('view', null, _view.page, _view.pageSize, _view.total);
        document.getElementById('tvBody').innerHTML = html;
      })
      .catch(function(){ document.getElementById('tvBody').innerHTML = '<div class="empty">Network error.</div>'; });
  }

  function closeTV() {
    document.getElementById('tvOverlay').classList.remove('visible');
    _view = { mode:null, date:null, kind:null, page:1, total:0, pageSize:_pageSize };
  }

  async function delFile(mode, date) {
    var ok = await showDoubleConfirm({
      icon: '🗑',
      title: 'Delete trade log',
      message: 'Permanently delete ' + mode.toUpperCase() + ' trade log for ' + date + '?\\n\\nThis removes the daily JSONL file from ~/trading-data/trades/. The cumulative log (separate file) is not affected.',
      confirmText: 'Delete',
      confirmClass: 'modal-btn-danger',
      subject: mode.toUpperCase() + ' · ' + date,
      secondConfirmText: 'Yes, delete it',
    });
    if (!ok) return;
    var res = await secretFetch('/trade-logs/delete?mode=' + mode + '&date=' + encodeURIComponent(date), { method: 'POST' });
    if (!res) return;
    var data = await res.json().catch(function(){ return null; });
    if (!data || !data.success) { showToast('Delete failed: ' + ((data && data.error) || res.status), '#f87171'); return; }
    showToast('Deleted ' + (data.deleted || (mode + ' ' + date)), '#10b981');
    _filesPage[mode] = 1;
    loadFileSection(mode);
  }

  async function delAllFiles(mode, count) {
    var ok = await showDoubleConfirm({
      icon: '🗑',
      title: 'Delete ALL ' + mode.toUpperCase() + ' trade logs',
      message: 'Permanently delete every ' + mode.toUpperCase() + ' daily trade log (' + count + ' file' + (count === 1 ? '' : 's') + ')?\\n\\nThis cannot be undone. The cumulative log (separate file) is not affected.',
      confirmText: 'Delete All',
      confirmClass: 'modal-btn-danger',
      subject: 'ALL ' + count + ' ' + mode.toUpperCase() + ' daily file' + (count === 1 ? '' : 's'),
      secondConfirmText: 'Yes, delete all',
    });
    if (!ok) return;
    var res = await secretFetch('/trade-logs/delete-all?mode=' + mode, { method: 'POST' });
    if (!res) return;
    var data = await res.json().catch(function(){ return null; });
    if (!data) { showToast('Delete failed: ' + res.status, '#f87171'); return; }
    var n = (data.deleted || []).length;
    if (data.failed && data.failed.length) {
      showToast('Deleted ' + n + ', ' + data.failed.length + ' failed', '#f87171');
    } else {
      showToast('Deleted all ' + n + ' ' + mode.toUpperCase() + ' file' + (n === 1 ? '' : 's'), '#10b981');
    }
    _filesPage[mode] = 1;
    loadFileSection(mode);
  }

  // ── SKIPS tab ───────────────────────────────────────────────────────
  function loadSkips() {
    var modes = enabledModes();
    if (modes.length === 0) {
      document.getElementById('skipsArea').innerHTML = '<div class="empty">No strategies enabled.</div>';
      document.getElementById('skipsBadge').textContent = '0';
      return;
    }
    document.getElementById('skipsArea').innerHTML = modes.map(function(m){
      return '<div class="mode-section" id="skipsSection-' + m.key + '"><div class="mode-head"><div class="mode-name ' + m.cls + '">' + m.label + '</div><div class="mode-meta">loading…</div></div></div>';
    }).join('');
    Promise.all(modes.map(function(m){ return loadSkipSection(m.key); })).then(function(){
      var sum = 0;
      modes.forEach(function(m){ sum += (_skipsTotals[m.key] || 0); });
      document.getElementById('skipsBadge').textContent = sum;
    });
  }

  function loadSkipSection(modeKey) {
    var page = _skipsPage[modeKey] || 1;
    var url = '/trade-logs/skips/list?mode=' + modeKey + '&page=' + page + '&pageSize=' + _pageSize;
    return fetch(url, { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.success) {
          document.getElementById('skipsSection-' + modeKey).innerHTML = '<div class="empty">Failed to load.</div>';
          return;
        }
        _skipsTotals[modeKey] = d.total || 0;
        _skipsPage[modeKey] = d.page || 1;
        var m = MODE_LIST.find(function(x){ return x.key === modeKey; });
        document.getElementById('skipsSection-' + modeKey).innerHTML = renderSkipSectionHTML(m, d);
        var sum = 0;
        enabledModes().forEach(function(em){ sum += (_skipsTotals[em.key] || 0); });
        document.getElementById('skipsBadge').textContent = sum;
      })
      .catch(function(){
        document.getElementById('skipsSection-' + modeKey).innerHTML = '<div class="empty">Cannot reach server.</div>';
      });
  }

  function renderSkipSectionHTML(m, d) {
    var rows = d.rows || [];
    var total = d.total || 0;
    var totalSkips = rows.reduce(function(s,r){ return s + (r.total || 0); }, 0);
    var bodyHtml = rows.length === 0
      ? '<div class="empty">No skip files yet for ' + m.label + '.</div>'
      : '<table><thead><tr><th>IST Date</th><th>Skips</th><th>Top Reasons</th><th>Size</th><th>Modified (IST)</th><th></th></tr></thead><tbody>' +
        rows.map(function(r){
          var gates = Object.keys(r.byGate || {}).map(function(g){ return [g, r.byGate[g]]; });
          gates.sort(function(a,b){ return b[1] - a[1]; });
          var top = gates.slice(0, 3).map(function(g){ return '<span title="' + escHtml(g[0]) + '" style="display:inline-block;margin-right:6px;font-size:0.62rem;color:#94a3b8;"><span style="color:#fbbf24;">' + g[1] + '</span> ' + escHtml(g[0]) + '</span>'; }).join('');
          if (gates.length > 3) top += '<span style="font-size:0.62rem;color:#4a6080;">+' + (gates.length - 3) + ' more</span>';
          return '<tr>' +
            '<td class="num">' + escHtml(r.date) + '</td>' +
            '<td class="num">' + r.total + '</td>' +
            '<td>' + (top || '<span style="color:#4a6080;">—</span>') + '</td>' +
            '<td class="num">' + fmtSize(r.size) + '</td>' +
            '<td class="num">' + fmtMtime(r.mtimeMs) + '</td>' +
            '<td><div class="actions">' +
              '<button class="btn btn-view"     onclick="viewSkipFile(\\''+m.key+'\\',\\''+r.date+'\\')">👁 View</button>' +
              '<a       class="btn btn-download" href="/trade-logs/skips/download?mode='+m.key+'&date='+encodeURIComponent(r.date)+'">⬇ Download</a>' +
              '<button class="btn btn-delete"   onclick="delSkipFile(\\''+m.key+'\\',\\''+r.date+'\\')">🗑 Delete</button>' +
            '</div></td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    var dlAll = total > 0
      ? '<a class="btn btn-download" href="/trade-logs/skips/download-all?mode=' + m.key + '" title="Download all ' + total + ' daily skip files concatenated, oldest first">⬇ Download All (' + total + ')</a>'
      : '';
    var delAll = total > 0
      ? '<button class="btn btn-delete" onclick="delAllSkips(\\''+m.key+'\\','+total+')" title="Delete every daily skip file for this mode">🗑 Delete All (' + total + ')</button>'
      : '';
    return '<div class="mode-head">' +
        '<div class="mode-name ' + m.cls + '">' + m.label + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<div class="mode-meta">' + total + ' file' + (total === 1 ? '' : 's') + ' · ' + totalSkips + ' skip' + (totalSkips === 1 ? '' : 's') + ' on page</div>' +
          dlAll + delAll +
        '</div>' +
      '</div>' +
      bodyHtml +
      (total > _pageSize ? pagerHtml('skips', m.key, d.page, d.pageSize, total) : '');
  }

  function viewSkipFile(mode, date) {
    _view = { mode: mode, date: date, kind: 'skips', page: 1, total: 0, pageSize: _pageSize };
    document.getElementById('tvTitle').textContent = mode.toUpperCase() + ' SKIPS · ' + date;
    document.getElementById('tvBody').innerHTML = 'Loading…';
    document.getElementById('tvOverlay').classList.add('visible');
    loadViewPage();
  }

  async function delSkipFile(mode, date) {
    var ok = await showDoubleConfirm({
      icon: '🗑',
      title: 'Delete skip log',
      message: 'Permanently delete ' + mode.toUpperCase() + ' SKIP log for ' + date + '?\\n\\nThis removes the daily skip JSONL from ~/trading-data/skips/. Cannot be undone.',
      confirmText: 'Delete',
      confirmClass: 'modal-btn-danger',
      subject: mode.toUpperCase() + ' SKIP · ' + date,
      secondConfirmText: 'Yes, delete it',
    });
    if (!ok) return;
    var res = await secretFetch('/trade-logs/skips/delete?mode=' + mode + '&date=' + encodeURIComponent(date), { method: 'POST' });
    if (!res) return;
    var data = await res.json().catch(function(){ return null; });
    if (!data || !data.success) { showToast('Delete failed: ' + ((data && data.error) || res.status), '#f87171'); return; }
    showToast('Deleted ' + (data.deleted || (mode + ' ' + date)), '#10b981');
    _skipsPage[mode] = 1;
    loadSkipSection(mode);
  }

  async function delAllSkips(mode, count) {
    var ok = await showDoubleConfirm({
      icon: '🗑',
      title: 'Delete ALL ' + mode.toUpperCase() + ' skip logs',
      message: 'Permanently delete every ' + mode.toUpperCase() + ' daily skip log (' + count + ' file' + (count === 1 ? '' : 's') + ')?\\n\\nThis cannot be undone.',
      confirmText: 'Delete All',
      confirmClass: 'modal-btn-danger',
      subject: 'ALL ' + count + ' ' + mode.toUpperCase() + ' daily skip file' + (count === 1 ? '' : 's'),
      secondConfirmText: 'Yes, delete all',
    });
    if (!ok) return;
    var res = await secretFetch('/trade-logs/skips/delete-all?mode=' + mode, { method: 'POST' });
    if (!res) return;
    var data = await res.json().catch(function(){ return null; });
    if (!data) { showToast('Delete failed: ' + res.status, '#f87171'); return; }
    var n = (data.deleted || []).length;
    if (data.failed && data.failed.length) {
      showToast('Deleted ' + n + ', ' + data.failed.length + ' failed', '#f87171');
    } else {
      showToast('Deleted all ' + n + ' ' + mode.toUpperCase() + ' skip file' + (n === 1 ? '' : 's'), '#10b981');
    }
    _skipsPage[mode] = 1;
    loadSkipSection(mode);
  }

  // ── AUDIT tab ───────────────────────────────────────────────────────
  // Filter changes reset the page back to 1 (server filters, so this is correct).
  function onAuditFilterChange() { _auditPage = 1; loadAudit(); }

  function loadAudit() {
    var fk = (document.getElementById('filtKey').value || '').trim().toUpperCase();
    var fa = document.getElementById('filtAction').value;
    var fn = document.getElementById('filtNoted').checked;
    var qs = 'page=' + _auditPage + '&pageSize=' + _pageSize;
    if (fk) qs += '&key=' + encodeURIComponent(fk);
    if (fa) qs += '&action=' + encodeURIComponent(fa);
    if (fn) qs += '&noted=1';
    document.getElementById('auditArea').innerHTML = 'Loading…';
    fetch('/trade-logs/audit?' + qs, { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.success) { document.getElementById('auditArea').innerHTML = '<div class="empty">Failed to load.</div>'; return; }
        var entries = d.entries || [];
        var total = d.total || 0;
        var page = d.page || 1;
        var pageSize = d.pageSize || _pageSize;
        _auditPage = page;
        document.getElementById('auditBadge').textContent = total;
        document.getElementById('auditCount').textContent =
          total === 0 ? '0 entries' : ('Showing ' + ((page-1)*pageSize + 1) + '–' + Math.min(page*pageSize, total) + ' of ' + total);
        if (entries.length === 0) {
          document.getElementById('auditArea').innerHTML = '<div class="empty">No matching entries.</div>';
          return;
        }
        var fmtTs = function(ts){
          try { return new Date(ts).toLocaleString('en-IN', { timeZone:'Asia/Kolkata', hour12:false }).replace(',', ''); }
          catch (_) { return ts; }
        };
        var fmtVal = function(v){
          if (v === null || v === undefined) return '<span style="color:#4a6080;">∅</span>';
          var s = String(v);
          if (s.length > 60) return '<span title="' + escHtml(s) + '">' + escHtml(s.slice(0, 60)) + '…</span>';
          return escHtml(s);
        };
        var html = '<table><thead><tr>' +
          '<th>When (IST)</th><th>Action</th><th>Key</th><th>From</th><th>To</th><th>Source</th><th>Note</th><th></th>' +
          '</tr></thead><tbody>' +
          entries.map(function(e){
            var hasNote = e.note && String(e.note).trim();
            // base64-encode the entry (notes may contain quotes) for the onclick payload.
            var entB64 = btoa(unescape(encodeURIComponent(JSON.stringify({
              ts: e.ts, key: e.key,
              from: (e.from === undefined ? null : e.from),
              to:   (e.to   === undefined ? null : e.to),
              note: e.note || '', action: e.action || ''
            }))));
            return '<tr class="audit-row' + (hasNote ? ' has-note' : '') + '">' +
              '<td class="num" style="white-space:nowrap;">' + escHtml(fmtTs(e.ts)) + '</td>' +
              '<td><span class="act-' + (e.action || '') + '" style="font-weight:700;text-transform:uppercase;font-size:0.62rem;">' + escHtml(e.action || '') + '</span></td>' +
              '<td style="font-weight:600;color:#e2e8f0;">' + escHtml(e.key || '') + '</td>' +
              '<td class="from-val">' + fmtVal(e.from) + '</td>' +
              '<td class="to-val">'   + fmtVal(e.to)   + '</td>' +
              '<td style="color:#64748b;font-size:0.66rem;">' + escHtml(e.source || '') + '</td>' +
              '<td>' + (hasNote ? '<span class="audit-note">📝 ' + escHtml(e.note) + '</span>' : '<span style="color:#2a3a5a;">—</span>') + '</td>' +
              '<td><button class="btn btn-restore" title="Revert this key to its previous value" onclick="restoreAudit(\\'' + entB64 + '\\')">↩ Restore</button></td>' +
            '</tr>';
          }).join('') +
          '</tbody></table>' +
          (total > pageSize ? pagerHtml('audit', null, page, pageSize, total) : '');
        document.getElementById('auditArea').innerHTML = html;
      })
      .catch(function(){ document.getElementById('auditArea').innerHTML = '<div class="empty">Cannot reach server.</div>'; });
  }

  // ── Restore (revert a settings change to its prior value) ─────────────
  function decodeEntry(b64) {
    try { return JSON.parse(decodeURIComponent(escape(atob(b64)))); }
    catch (_) { return null; }
  }

  async function restoreAudit(b64) {
    var e = decodeEntry(b64);
    if (!e) { showToast('Bad audit entry', '#f87171'); return; }
    var hasNote = e.note && String(e.note).trim();
    var toTxt   = (e.to === null || e.to === undefined || e.to === '') ? '∅' : String(e.to);
    var fromTxt = (e.from === null || e.from === undefined) ? '∅ (delete key — it was added)' : String(e.from);
    var msg = 'Revert <b>' + escHtml(e.key) + '</b> to its previous value?' +
      '<div style="margin-top:8px;font-family:monospace;font-size:0.7rem;">' +
      '<span style="color:#fca5a5;">' + escHtml(toTxt) + '</span> → <span style="color:#86efac;">' + escHtml(fromTxt) + '</span></div>';
    if (hasNote) {
      msg += '<div style="margin-top:12px;padding:10px;border:1px solid #1e3a5a;border-radius:6px;text-align:left;">' +
        '<label style="display:flex;gap:8px;align-items:flex-start;font-size:0.72rem;cursor:pointer;">' +
        '<input type="checkbox" id="restoreSameNote" style="margin-top:2px;flex:none;">' +
        '<span>Restore <b>all keys</b> with the same note<br><i style="color:#94a3b8;">"' + escHtml(String(e.note).trim()) + '"</i></span>' +
        '</label></div>';
    }
    var ok = await showConfirm({ icon:'↩', title:'Restore setting', message: msg, confirmText:'Restore', confirmClass:'modal-btn-primary', cancelText:'Cancel' });
    if (!ok) return;
    // Read the checkbox while the (now-hidden) modal DOM is still intact.
    var allSameNote = false;
    if (hasNote) { var cb = document.getElementById('restoreSameNote'); allSameNote = !!(cb && cb.checked); }
    var res = await secretFetch('/settings/audit-restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: e.ts, key: e.key, note: hasNote ? String(e.note).trim() : null, allSameNote: allSameNote }),
    });
    if (!res) return;
    var data = await res.json().catch(function(){ return null; });
    if (!data || !data.success) { showToast('Restore failed: ' + ((data && data.error) || res.status), '#f87171'); return; }
    showToast('Restored ' + data.restoredCount + ' key' + (data.restoredCount === 1 ? '' : 's'), '#10b981');
    loadAudit();
    if (data.needsRestart && data.needsRestart.length) restoreRestartPrompt(data.needsRestart);
  }

  // Some restored keys are cached at startup — offer a one-click server restart.
  async function restoreRestartPrompt(keys) {
    var preview = keys.slice(0, 8).join(', ') + (keys.length > 8 ? ', +' + (keys.length - 8) + ' more' : '');
    var ok = await showConfirm({
      icon: '🔄', title: 'Restart required',
      message: 'Restored key' + (keys.length > 1 ? 's are' : ' is') + ' cached at startup — restart to apply:' +
        '<div style="margin-top:6px;font-family:monospace;font-size:0.7rem;">' + escHtml(preview) + '</div>' +
        '<div style="margin-top:10px;">Restart the server now? Active trading sessions will stop and the page will reload.</div>',
      cancelText: 'Later', confirmText: 'Restart now', confirmClass: 'modal-btn-danger',
    });
    if (!ok) { showToast('Restart later to apply: ' + keys.join(', '), '#f59e0b'); return; }
    showToast('Restarting server — page reloads when it returns…', '#f59e0b');
    secretFetch('/settings/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(function(){});
    var attempts = 0;
    var poller = setInterval(function(){
      attempts++;
      if (attempts > 30) { clearInterval(poller); showToast('Server did not come back — check manually', '#f87171'); return; }
      fetch('/settings/data', { cache: 'no-store' })
        .then(function(r){ if (r.ok) { clearInterval(poller); showToast('Server restarted!', '#10b981'); setTimeout(function(){ window.location.reload(); }, 600); } })
        .catch(function(){});
    }, 1000);
  }

  initPageSizeSelector();
  loadFiles();
</script>

</div></div>
</body>
</html>`);
});

module.exports = router;

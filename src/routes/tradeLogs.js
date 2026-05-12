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
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const tradeLogger   = require("../utils/tradeLogger");
const settingsAudit = require("../utils/settingsAudit");

const MODES = ["swing", "scalp", "pa"];

function validMode(m) { return MODES.includes(m); }
function validDate(d) { return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d); }

// ── GET /trade-logs/list — all daily files across all 3 modes ───────────────
router.get("/list", (req, res) => {
  const out = {};
  for (const mode of MODES) {
    let files;
    try { files = tradeLogger.listDailyDates(mode); }
    catch (_) { files = []; }
    out[mode] = files.map(f => {
      // Count parseable trade lines and any checkpoint markers in this file.
      // Cheap full-read: these files are at most a few thousand lines.
      let trades = 0, checkpoints = 0;
      try {
        const text = fs.readFileSync(tradeLogger.dailyFilePathFor(mode, f.date), "utf-8");
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          try {
            const obj = JSON.parse(t);
            if (obj && obj.type === "checkpoint") checkpoints++;
            else trades++;
          } catch (_) { /* skip bad line */ }
        }
      } catch (_) { /* file vanished — ignore */ }
      return { date: f.date, size: f.size, mtimeMs: f.mtimeMs, trades, checkpoints };
    });
  }
  res.json({ success: true, modes: out });
});

// ── GET /trade-logs/view — parsed JSONL for one file ────────────────────────
router.get("/view", (req, res) => {
  const mode = String(req.query.mode || "").toLowerCase();
  const date = String(req.query.date || "");
  if (!validMode(mode)) return res.status(400).json({ success: false, error: "bad mode" });
  if (!validDate(date)) return res.status(400).json({ success: false, error: "bad date" });
  let trades;
  try { trades = tradeLogger.readDailyTrades(mode, date); }
  catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  res.json({ success: true, mode, date, count: trades.length, trades });
});

// ── GET /trade-logs/download — raw JSONL stream ─────────────────────────────
router.get("/download", (req, res) => {
  const mode = String(req.query.mode || "").toLowerCase();
  const date = String(req.query.date || "");
  if (!validMode(mode)) return res.status(400).send("bad mode");
  if (!validDate(date)) return res.status(400).send("bad date");
  const fp = tradeLogger.dailyFilePathFor(mode, date);
  if (!fs.existsSync(fp)) return res.status(404).send("file not found");
  const filename = `${mode}_paper_trades_${date}.jsonl`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/jsonl; charset=utf-8");
  fs.createReadStream(fp).pipe(res);
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

// ── GET /trade-logs/audit — settings audit entries (newest first) ───────────
router.get("/audit", (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
  const key    = req.query.key || null;
  const action = req.query.action || null;
  const onlyNoted = String(req.query.noted || "") === "1";
  let entries;
  try { entries = settingsAudit.readAuditLog({ limit, key, action }); }
  catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  if (onlyNoted) entries = entries.filter(e => typeof e.note === "string" && e.note.trim().length > 0);
  res.json({ success: true, count: entries.length, entries });
});

// ── GET /trade-logs — UI page ───────────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
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
    .tabs { display:flex; gap:6px; margin-bottom:14px; border-bottom:1px solid #1a2236; }
    .tab { padding:9px 16px; cursor:pointer; font-size:0.74rem; font-weight:600; color:#4a6080; border-bottom:2px solid transparent; user-select:none; }
    .tab.active { color:#60a5fa; border-bottom-color:#3b82f6; }
    .tab .badge { display:inline-block; margin-left:6px; padding:1px 7px; font-size:0.6rem; background:#0a1528; border:1px solid #1e3a5a; border-radius:999px; color:#94a3b8; }
    .tab-pane { display:none; }
    .tab-pane.active { display:block; }
    .mode-section { margin-bottom:22px; background:#0a1018; border:1px solid #1a2236; border-radius:8px; overflow:hidden; }
    .mode-head { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:#0d1320; border-bottom:1px solid #1a2236; }
    .mode-name { font-weight:700; font-size:0.78rem; letter-spacing:0.5px; text-transform:uppercase; }
    .mode-swing { color:#60a5fa; }
    .mode-scalp { color:#fbbf24; }
    .mode-pa    { color:#a78bfa; }
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
  <div class="tabs">
    <div class="tab active" data-tab="files" onclick="setTab('files')">📁 Trade Files <span class="badge" id="filesBadge">—</span></div>
    <div class="tab" data-tab="audit" onclick="setTab('audit')">🔖 Checkpoints &amp; Settings Changes <span class="badge" id="auditBadge">—</span></div>
  </div>

  <!-- ── FILES TAB ─────────────────────────────────────────────────── -->
  <div class="tab-pane active" id="pane-files">
    <div class="sub">One JSONL per mode per IST date — crash-safe record of every paper trade taken that day. Use these for post-window analysis.</div>
    <div id="filesArea">Loading…</div>
  </div>

  <!-- ── AUDIT TAB ─────────────────────────────────────────────────── -->
  <div class="tab-pane" id="pane-audit">
    <div class="sub">Every settings save through <code>/settings</code> writes old→new for each changed key here (with the optional checkpoint note you typed). Use this to correlate trade outcomes with the settings active at the time.</div>
    <div class="filt-bar">
      <label>Filter key</label>
      <input id="filtKey" type="text" placeholder="e.g. SCALP_ or ADX_MIN" oninput="renderAudit()"/>
      <label>Action</label>
      <select id="filtAction" onchange="renderAudit()">
        <option value="">all</option>
        <option value="update">update</option>
        <option value="add">add</option>
        <option value="delete">delete</option>
      </select>
      <label><input id="filtNoted" type="checkbox" onchange="renderAudit()"/> Checkpoints only (have note)</label>
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

  var _files = null;
  var _audit = null;

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

  function setTab(name) {
    document.querySelectorAll('.tab').forEach(function(t){ t.classList.toggle('active', t.dataset.tab === name); });
    document.querySelectorAll('.tab-pane').forEach(function(p){ p.classList.toggle('active', p.id === 'pane-' + name); });
    if (name === 'audit' && _audit === null) loadAudit();
  }

  // ── FILES tab ───────────────────────────────────────────────────────
  function loadFiles() {
    fetch('/trade-logs/list', { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data || !data.success) {
          document.getElementById('filesArea').innerHTML = '<div class="empty">Failed to load.</div>';
          return;
        }
        _files = data.modes;
        renderFiles();
      })
      .catch(function() {
        document.getElementById('filesArea').innerHTML = '<div class="empty">Cannot reach server.</div>';
      });
  }

  function renderFiles() {
    if (!_files) return;
    var modes = [
      { key: 'swing', label: 'SWING', cls: 'mode-swing' },
      { key: 'scalp', label: 'SCALP', cls: 'mode-scalp' },
      { key: 'pa',    label: 'PRICE ACTION', cls: 'mode-pa' },
    ];
    var totalFiles = 0;
    var html = '';
    modes.forEach(function(m) {
      var rows = (_files[m.key] || []);
      totalFiles += rows.length;
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
      html +=
        '<div class="mode-section">' +
          '<div class="mode-head">' +
            '<div class="mode-name ' + m.cls + '">' + m.label + '</div>' +
            '<div class="mode-meta">' + rows.length + ' file' + (rows.length === 1 ? '' : 's') + '</div>' +
          '</div>' +
          bodyHtml +
        '</div>';
    });
    document.getElementById('filesArea').innerHTML = html;
    document.getElementById('filesBadge').textContent = totalFiles;
  }

  function viewFile(mode, date) {
    document.getElementById('tvTitle').textContent = mode.toUpperCase() + ' · ' + date;
    document.getElementById('tvBody').innerHTML = 'Loading…';
    document.getElementById('tvOverlay').classList.add('visible');
    fetch('/trade-logs/view?mode=' + mode + '&date=' + encodeURIComponent(date), { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d) {
        if (!d || !d.success) { document.getElementById('tvBody').innerHTML = '<div class="empty">Failed to load.</div>'; return; }
        if (!d.trades || d.trades.length === 0) { document.getElementById('tvBody').innerHTML = '<div class="empty">Empty file.</div>'; return; }
        var keysSet = {};
        d.trades.forEach(function(t){ Object.keys(t).forEach(function(k){ keysSet[k] = true; }); });
        // Show a compact list — each row is one JSON object pretty-printed.
        var html = '<div style="margin-bottom:10px;font-size:0.72rem;color:#4a6080;">' + d.count + ' record(s) in this file. Showing raw JSON for each line.</div>';
        html += d.trades.map(function(t, i){
          var label = t.type === 'checkpoint' ? '🔖 CHECKPOINT' : ('#' + (i+1));
          return '<div style="margin-bottom:9px;"><div style="font-size:0.66rem;color:#64748b;margin-bottom:3px;">' + label + (t.loggedAt ? ' · ' + escHtml(t.loggedAt) : '') + '</div><pre>' + escHtml(JSON.stringify(t, null, 2)) + '</pre></div>';
        }).join('');
        document.getElementById('tvBody').innerHTML = html;
      })
      .catch(function(){ document.getElementById('tvBody').innerHTML = '<div class="empty">Network error.</div>'; });
  }

  function closeTV() { document.getElementById('tvOverlay').classList.remove('visible'); }

  async function delFile(mode, date) {
    var ok = await showConfirm({
      icon: '🗑',
      title: 'Delete trade log',
      message: 'Permanently delete ' + mode.toUpperCase() + ' trade log for ' + date + '?\\n\\nThis removes the daily JSONL file from ~/trading-data/trades/. The cumulative log (separate file) is not affected.',
      confirmText: 'Delete',
      confirmClass: 'modal-btn-danger',
    });
    if (!ok) return;
    var res = await secretFetch('/trade-logs/delete?mode=' + mode + '&date=' + encodeURIComponent(date), { method: 'POST' });
    if (!res) return;
    var data = await res.json().catch(function(){ return null; });
    if (!data || !data.success) { showToast('Delete failed: ' + ((data && data.error) || res.status), 'error'); return; }
    showToast('Deleted ' + (data.deleted || (mode + ' ' + date)), 'success');
    loadFiles();
  }

  // ── AUDIT tab ───────────────────────────────────────────────────────
  function loadAudit() {
    document.getElementById('auditArea').innerHTML = 'Loading…';
    fetch('/trade-logs/audit?limit=2000', { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.success) { document.getElementById('auditArea').innerHTML = '<div class="empty">Failed to load.</div>'; return; }
        _audit = d.entries || [];
        document.getElementById('auditBadge').textContent = _audit.length;
        renderAudit();
      })
      .catch(function(){ document.getElementById('auditArea').innerHTML = '<div class="empty">Cannot reach server.</div>'; });
  }

  function renderAudit() {
    if (!_audit) return;
    var fk = (document.getElementById('filtKey').value || '').trim().toUpperCase();
    var fa = document.getElementById('filtAction').value;
    var fn = document.getElementById('filtNoted').checked;
    var rows = _audit.filter(function(e){
      if (fa && e.action !== fa) return false;
      if (fk && (!e.key || e.key.indexOf(fk) === -1)) return false;
      if (fn && !(e.note && String(e.note).trim())) return false;
      return true;
    });
    document.getElementById('auditCount').textContent =
      rows.length + ' of ' + _audit.length + ' entries';
    if (rows.length === 0) {
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
      '<th>When (IST)</th><th>Action</th><th>Key</th><th>From</th><th>To</th><th>Source</th><th>Note</th>' +
      '</tr></thead><tbody>' +
      rows.map(function(e){
        var hasNote = e.note && String(e.note).trim();
        return '<tr class="audit-row' + (hasNote ? ' has-note' : '') + '">' +
          '<td class="num" style="white-space:nowrap;">' + escHtml(fmtTs(e.ts)) + '</td>' +
          '<td><span class="act-' + (e.action || '') + '" style="font-weight:700;text-transform:uppercase;font-size:0.62rem;">' + escHtml(e.action || '') + '</span></td>' +
          '<td style="font-weight:600;color:#e2e8f0;">' + escHtml(e.key || '') + '</td>' +
          '<td class="from-val">' + fmtVal(e.from) + '</td>' +
          '<td class="to-val">'   + fmtVal(e.to)   + '</td>' +
          '<td style="color:#64748b;font-size:0.66rem;">' + escHtml(e.source || '') + '</td>' +
          '<td>' + (hasNote ? '<span class="audit-note">📝 ' + escHtml(e.note) + '</span>' : '<span style="color:#2a3a5a;">—</span>') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
    document.getElementById('auditArea').innerHTML = html;
  }

  loadFiles();
</script>

</div></div>
</body>
</html>`);
});

module.exports = router;

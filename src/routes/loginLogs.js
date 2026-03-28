/**
 * loginLogs.js — Failed login attempts viewer
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /login-logs           → UI page with paginated log history
 * GET  /login-logs/data      → JSON data (paginated)
 * POST /login-logs/clear     → Reset / clear all logs
 */

const express = require("express");
const router  = express.Router();
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const loginLogStore = require("../utils/loginLogStore");

// ── Paginated JSON data ─────────────────────────────────────────────────────
router.get("/data", (req, res) => {
  const all   = loginLogStore.loadAll(); // already newest-first
  const page  = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 100);
  const start = (page - 1) * limit;
  const slice = all.slice(start, start + limit);
  const totalPages = Math.max(1, Math.ceil(all.length / limit));
  res.json({ total: all.length, page, totalPages, limit, logs: slice });
});

// ── Clear all logs ──────────────────────────────────────────────────────────
router.post("/clear", (req, res) => {
  loginLogStore.clearAll();
  console.log("🧹 Login logs cleared by user via /login-logs/clear");
  res.json({ success: true, message: "Login logs cleared." });
});

// ── UI page ─────────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>Login Logs — Palani Andawar Trading Bot</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg:       #080c14;
      --surface:  #0d1320;
      --surface2: #111827;
      --border:   #1a2236;
      --border2:  #243048;
      --text:     #c8d8f0;
      --text2:    #e0eaf8;
      --muted:    #4a6080;
      --dim:      #3a5070;
      --accent:   #3b82f6;
      --green:    #10b981;
      --red:      #ef4444;
      --yellow:   #f59e0b;
    }
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'IBM Plex Sans',system-ui,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; overflow-x:hidden; }

    ${sidebarCSS()}
    ${modalCSS()}

    /* ── Page body ─────────────────────────────────────────── */
    .page { padding:24px 28px 60px; max-width:1100px; }

    /* ── Toolbar ──────────────────────────────────────────── */
    .toolbar { display:flex; align-items:center; gap:10px; margin-bottom:18px; flex-wrap:wrap; }
    .badge-count { display:flex; align-items:center; gap:5px; font-size:0.68rem; font-weight:700; padding:4px 12px; border-radius:5px; border:0.5px solid var(--border2); background:var(--surface); color:var(--muted); }
    .badge-count .num { color:var(--text2); }

    .btn { font-size:0.7rem; font-weight:600; padding:5px 14px; border-radius:6px; border:1px solid; cursor:pointer; font-family:inherit; display:inline-flex; align-items:center; gap:5px; white-space:nowrap; transition:all 0.12s; }
    .btn-danger { background:#180508; border-color:#401018; color:#f87171; }
    .btn-danger:hover { background:#200810; border-color:#601828; }
    .btn-nav { background:var(--surface); border-color:var(--border); color:var(--muted); }
    .btn-nav:hover { background:var(--surface2); border-color:var(--border2); color:var(--text); }
    .btn-nav:disabled, .btn-nav.disabled { opacity:0.3; cursor:not-allowed; pointer-events:none; }

    /* ── Table ────────────────────────────────────────────── */
    .tbl-wrap { border-radius:10px; border:0.5px solid var(--border); overflow:hidden; }
    table { width:100%; border-collapse:collapse; font-size:0.72rem; }
    thead { position:sticky; top:0; z-index:2; }
    th { background:#060e1c; color:var(--muted); font-weight:600; font-size:0.62rem; text-transform:uppercase; letter-spacing:0.8px; text-align:left; padding:10px 14px; white-space:nowrap; border-bottom:1px solid var(--border); }
    td { padding:10px 14px; border-top:1px solid #0a1428; color:var(--text); vertical-align:top; }
    tr:hover td { background:rgba(59,130,246,0.03); }
    .mono { font-family:'IBM Plex Mono',monospace; font-size:0.68rem; }
    .pw { color:#f87171; font-weight:600; }
    .empty-state { text-align:center; padding:50px 24px; color:var(--dim); font-size:0.78rem; }
    .empty-state .icon { font-size:1.8rem; margin-bottom:10px; display:block; }
    .loc { color:#60a5fa; font-size:0.66rem; }
    .loc-dash { color:var(--dim); }
    .geo-tag { display:inline-block; font-size:0.52rem; font-weight:700; padding:1px 5px; border-radius:3px; margin-left:4px; vertical-align:middle; }
    .geo-gps { background:rgba(16,185,129,0.15); color:#10b981; border:0.5px solid rgba(16,185,129,0.3); }
    .geo-ip  { background:rgba(245,158,11,0.15); color:#f59e0b; border:0.5px solid rgba(245,158,11,0.3); }
    .ua { color:#64748b; font-size:0.64rem; max-width:280px; word-break:break-all; line-height:1.5; }
    .time-main { color:var(--text2); }
    .time-date { color:var(--dim); font-size:0.6rem; }
    .idx { color:var(--dim); font-weight:600; }

    /* ── Pagination ───────────────────────────────────────── */
    .pager { display:flex; align-items:center; justify-content:center; gap:8px; margin-top:16px; padding:12px 0; }
    .pager-info { font-size:0.65rem; color:var(--muted); font-weight:600; }

    /* ── Mobile ───────────────────────────────────────────── */
    @media (max-width:768px) {
      .page { padding:16px 12px 40px; }
      .tbl-wrap { border-radius:8px; overflow-x:auto; }
      table { min-width:700px; }
    }
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('loginLogs', liveActive)}
<div class="main-content">

<div class="top-bar">
  <div>
    <div class="top-bar-title">🔐 Failed Login Attempts</div>
    <div class="top-bar-meta">Only invalid login tries are logged — IP, password, location, browser</div>
  </div>
  <div class="top-bar-right">
    <span class="top-bar-badge" id="topBadge">● 0</span>
  </div>
</div>

<div class="page">
  <div class="toolbar">
    <span class="badge-count" id="totalBadge"><span class="num">0</span>&nbsp;attempts</span>
    <button class="btn btn-danger" onclick="resetLogs()">🗑 Reset Logs</button>
  </div>

  <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th>#</th>
        <th>Time</th>
        <th>IP Address</th>
        <th>Password Tried</th>
        <th>Location</th>
        <th>Browser / User Agent</th>
      </tr></thead>
      <tbody id="logBody">
        <tr><td colspan="6" class="empty-state"><span class="icon">⏳</span>Loading…</td></tr>
      </tbody>
    </table>
  </div>

  <div class="pager" id="pager"></div>
</div>

</div>
</div>

<script>
${modalJS()}

var currentPage = 1;
var PER_PAGE = 10;

function fetchLogs(page) {
  fetch('/login-logs/data?page=' + page + '&limit=' + PER_PAGE, { cache: 'no-store' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      renderTable(d);
      renderPager(d);
      currentPage = d.page;
      document.getElementById('topBadge').textContent = '● ' + d.total;
    })
    .catch(function(e) { console.error(e); });
}

function renderTable(d) {
  var numEl = document.querySelector('#totalBadge .num');
  if (numEl) numEl.textContent = d.total;
  var tbody = document.getElementById('logBody');
  if (!d.logs.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><span class="icon">✅</span>No failed login attempts recorded.</td></tr>';
    return;
  }
  tbody.innerHTML = d.logs.map(function(l, i) {
    var idx = (d.page - 1) * d.limit + i + 1;
    var geoTag = l.geoSource === 'gps'
      ? '<span class="geo-tag geo-gps">GPS</span>'
      : (l.lat ? '<span class="geo-tag geo-ip">IP</span>' : '');
    var loc = l.lat && l.lon
      ? '<span class="loc">' + esc(String(l.lat)) + ', ' + esc(String(l.lon)) + (l.city ? ' (' + esc(l.city) + ')' : '') + geoTag + '</span>'
      : '<span class="loc-dash">—</span>';
    return '<tr>'
      + '<td class="idx">' + idx + '</td>'
      + '<td class="mono"><span class="time-main">' + esc(l.time || '') + '</span><br><span class="time-date">' + esc(l.date || '') + '</span></td>'
      + '<td class="mono">' + esc(l.ip || '—') + '</td>'
      + '<td class="pw mono">' + esc(l.password || '') + '</td>'
      + '<td>' + loc + '</td>'
      + '<td class="ua">' + esc(l.userAgent || '—') + '</td>'
      + '</tr>';
  }).join('');
}

function renderPager(d) {
  var el = document.getElementById('pager');
  if (d.totalPages <= 1) { el.innerHTML = ''; return; }
  var h = '<button class="btn btn-nav" onclick="go(' + (d.page-1) + ')"' + (d.page<=1?' disabled':'') + '>‹ Prev</button>';
  h += '<span class="pager-info">Page ' + d.page + ' / ' + d.totalPages + '</span>';
  h += '<button class="btn btn-nav" onclick="go(' + (d.page+1) + ')"' + (d.page>=d.totalPages?' disabled':'') + '>Next ›</button>';
  el.innerHTML = h;
}

function go(p) { if (p >= 1) fetchLogs(p); }

function resetLogs() {
  if (!confirm('Clear all failed login logs?')) return;
  var secret = new URLSearchParams(location.search).get('secret') || '';
  fetch('/login-logs/clear' + (secret ? '?secret=' + secret : ''), { method: 'POST' })
    .then(function() { fetchLogs(1); });
}

function esc(s) { var d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

fetchLogs(1);
</script>
</body>
</html>`);
});

module.exports = router;

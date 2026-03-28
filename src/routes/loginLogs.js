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
  res.json({ success: true, message: "Login logs cleared." });
});

// ── UI page ─────────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";
  const sidebar = buildSidebar("loginLogs", liveActive, false);

  const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login Logs — Trading Bot</title>
${faviconLink}
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
${sidebarCSS}
${modalCSS}

/* ── page layout ─────────────────────────────────────────── */
.main{margin-left:220px;padding:28px 32px;min-height:100vh;background:#080c14;color:#c9d6e8;font-family:'IBM Plex Sans',sans-serif;}
@media(max-width:900px){.main{margin-left:0;padding:20px 10px;}}
h1{font-size:1.15rem;font-weight:700;color:#e0eaf8;margin-bottom:6px;display:flex;align-items:center;gap:10px;}
.sub{font-size:0.72rem;color:#3a5070;margin-bottom:18px;}

/* toolbar */
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;}
.btn{padding:7px 16px;border-radius:7px;border:none;font-size:0.75rem;font-weight:600;font-family:inherit;cursor:pointer;transition:background 0.15s;}
.btn-danger{background:#7f1d1d;color:#fca5a5;}.btn-danger:hover{background:#991b1b;}
.btn-nav{background:#1e293b;color:#94a3b8;}.btn-nav:hover{background:#334155;}
.btn-nav.disabled{opacity:0.4;cursor:not-allowed;}
.badge{background:#1e293b;color:#94a3b8;padding:4px 12px;border-radius:6px;font-size:0.72rem;font-weight:600;}

/* table */
.tbl-wrap{overflow-x:auto;border-radius:10px;border:1px solid #1a2236;}
table{width:100%;border-collapse:collapse;font-size:0.75rem;}
th{background:#0d1320;color:#5a7a9e;font-weight:600;text-align:left;padding:10px 12px;white-space:nowrap;position:sticky;top:0;}
td{padding:9px 12px;border-top:1px solid #111a2e;color:#c9d6e8;vertical-align:top;}
tr:hover td{background:#0f1728;}
.mono{font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
.pw{color:#f87171;font-weight:600;}
.empty{text-align:center;padding:40px;color:#3a5070;font-size:0.82rem;}
.loc{color:#60a5fa;font-size:0.68rem;}
.ua{color:#64748b;font-size:0.66rem;max-width:260px;word-break:break-all;}

/* pagination */
.pager{display:flex;align-items:center;gap:8px;margin-top:14px;justify-content:center;}
</style></head><body>
${sidebar}
<div class="main">
  <h1>🔐 Failed Login Attempts</h1>
  <div class="sub">Only invalid login tries are logged — IP, password, location, browser</div>

  <div class="toolbar">
    <span class="badge" id="totalBadge">0 attempts</span>
    <button class="btn btn-danger" onclick="resetLogs()">🗑 Reset Logs</button>
  </div>

  <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th>#</th><th>Time</th><th>IP</th><th>Password Tried</th><th>Location</th><th>Browser / UA</th>
      </tr></thead>
      <tbody id="logBody"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody>
    </table>
  </div>

  <div class="pager" id="pager"></div>
</div>

${modalJS}
<script>
let currentPage = 1;
const PER_PAGE = 10;

async function fetchLogs(page) {
  try {
    const r = await fetch('/login-logs/data?page=' + page + '&limit=' + PER_PAGE);
    const d = await r.json();
    renderTable(d);
    renderPager(d);
    currentPage = d.page;
  } catch(e) { console.error(e); }
}

function renderTable(d) {
  document.getElementById('totalBadge').textContent = d.total + ' attempt' + (d.total !== 1 ? 's' : '');
  const tbody = document.getElementById('logBody');
  if (!d.logs.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No failed login attempts recorded.</td></tr>';
    return;
  }
  tbody.innerHTML = d.logs.map((l, i) => {
    const idx = (d.page - 1) * d.limit + i + 1;
    const loc = l.lat && l.lon
      ? '<span class="loc">' + l.lat + ', ' + l.lon + (l.city ? ' (' + esc(l.city) + ')' : '') + '</span>'
      : '<span class="loc" style="color:#475569">—</span>';
    return '<tr>'
      + '<td>' + idx + '</td>'
      + '<td class="mono">' + esc(l.time || '') + '<br><span style="color:#475569;font-size:0.65rem">' + esc(l.date || '') + '</span></td>'
      + '<td class="mono">' + esc(l.ip || '—') + '</td>'
      + '<td class="pw mono">' + esc(l.password || '') + '</td>'
      + '<td>' + loc + '</td>'
      + '<td class="ua">' + esc(l.userAgent || '—') + '</td>'
      + '</tr>';
  }).join('');
}

function renderPager(d) {
  const el = document.getElementById('pager');
  if (d.totalPages <= 1) { el.innerHTML = ''; return; }
  let h = '<button class="btn btn-nav' + (d.page <= 1 ? ' disabled' : '') + '" onclick="go(' + (d.page-1) + ')"' + (d.page<=1?' disabled':'') + '>‹ Prev</button>';
  h += '<span class="badge">Page ' + d.page + ' / ' + d.totalPages + '</span>';
  h += '<button class="btn btn-nav' + (d.page >= d.totalPages ? ' disabled' : '') + '" onclick="go(' + (d.page+1) + ')"' + (d.page>=d.totalPages?' disabled':'') + '>Next ›</button>';
  el.innerHTML = h;
}

function go(p) { if (p >= 1) fetchLogs(p); }

async function resetLogs() {
  if (!confirm('Clear all failed login logs?')) return;
  const secret = new URLSearchParams(location.search).get('secret') || '';
  await fetch('/login-logs/clear' + (secret ? '?secret=' + secret : ''), { method: 'POST' });
  fetchLogs(1);
}

function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

fetchLogs(1);
</script>
</body></html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

module.exports = router;

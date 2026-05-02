/**
 * realtime.js — Unified real-time monitor for PAPER or LIVE trades
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only single screen that shows current state for SWING, SCALP, PA in
 * three side-by-side columns, with a common rollup P&L table below. Toggle
 * at the top switches between PAPER and LIVE data sources. The page polls
 * each strategy's existing /status/data endpoint every 4s — no new backend
 * aggregation; we read from the same source the dedicated pages already use.
 */

const express = require("express");
const router  = express.Router();
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");

router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  res.send(renderPage(liveActive));
});

function renderPage(liveActive) {
  const sidebar = buildSidebar("realtime", liveActive);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Real-Time Monitor</title>
${faviconLink()}
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
  ${sidebarCSS()}
  body { margin:0; background:#040c18; color:#e0eaf8; font-family:'Segoe UI',-apple-system,sans-serif; }
  .main-content { padding:20px 24px; }
  .top-bar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:16px; flex-wrap:wrap; }
  .top-bar h1 { margin:0; font-size:1.4rem; font-weight:600; letter-spacing:0.2px; }
  .top-bar .sub { color:#7d8aa3; font-size:0.78rem; margin-top:2px; }
  .toggle { display:inline-flex; background:#0a1628; border:1px solid #1c2c47; border-radius:8px; padding:3px; }
  .toggle button { background:transparent; border:none; color:#9aa9c2; font-size:0.82rem; font-weight:600; padding:7px 18px; border-radius:6px; cursor:pointer; transition:all 0.15s; letter-spacing:0.5px; }
  .toggle button.active[data-mode="PAPER"] { background:#3b82f6; color:#fff; }
  .toggle button.active[data-mode="LIVE"]  { background:#ef4444; color:#fff; }

  .cols { display:grid; grid-template-columns:repeat(3, 1fr); gap:14px; margin-bottom:18px; }
  @media (max-width: 1100px) { .cols { grid-template-columns:1fr; } }

  .card { background:#0a1628; border:1px solid #1c2c47; border-top-width:3px; border-radius:10px; padding:14px 16px; min-height:280px; display:flex; flex-direction:column; gap:10px; }
  .card.swing { border-top-color:#3b82f6; }
  .card.scalp { border-top-color:#f59e0b; }
  .card.pa    { border-top-color:#a855f7; }

  .card-header { display:flex; align-items:center; justify-content:space-between; }
  .card-title { font-size:1rem; font-weight:600; letter-spacing:0.5px; }
  .card.swing .card-title { color:#60a5fa; }
  .card.scalp .card-title { color:#fbbf24; }
  .card.pa    .card-title { color:#c084fc; }

  .badge { font-size:0.66rem; padding:3px 8px; border-radius:4px; border:1px solid; font-weight:600; letter-spacing:0.4px; }
  .badge.run  { background:rgba(16,185,129,0.12); color:#10b981; border-color:rgba(16,185,129,0.35); }
  .badge.stop { background:rgba(148,163,184,0.10); color:#94a3b8; border-color:rgba(148,163,184,0.30); }
  .badge.err  { background:rgba(239,68,68,0.12);  color:#ef4444; border-color:rgba(239,68,68,0.35); }

  .pos-block, .flat-block { background:#040c18; border:1px solid #15243d; border-radius:8px; padding:10px 12px; }
  .pos-side { display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.72rem; font-weight:700; letter-spacing:0.5px; margin-right:6px; }
  .pos-side.CE { background:rgba(16,185,129,0.18); color:#10b981; }
  .pos-side.PE { background:rgba(239,68,68,0.18);  color:#ef4444; }
  .pos-symbol { font-size:0.78rem; color:#cbd5e1; word-break:break-all; }

  .pnl-big { font-size:1.5rem; font-weight:700; line-height:1.1; margin-top:4px; }
  .pnl-big .pct { font-size:0.78rem; font-weight:500; color:#94a3b8; margin-left:6px; }
  .pos-grid { display:grid; grid-template-columns:1fr 1fr; gap:5px 12px; margin-top:8px; font-size:0.75rem; }
  .pos-grid .lbl { color:#7d8aa3; }
  .pos-grid .val { color:#e0eaf8; text-align:right; font-variant-numeric:tabular-nums; }

  .flat-block { text-align:center; color:#94a3b8; font-size:0.86rem; padding:18px 12px; }

  .stats-row { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:auto; }
  .stat { background:#040c18; border:1px solid #15243d; border-radius:6px; padding:7px 8px; text-align:center; }
  .stat .lbl { font-size:0.62rem; color:#7d8aa3; text-transform:uppercase; letter-spacing:0.5px; }
  .stat .val { font-size:0.95rem; font-weight:700; margin-top:2px; font-variant-numeric:tabular-nums; }

  .pos-pos { color:#10b981 !important; }
  .pos-neg { color:#ef4444 !important; }
  .pos-zero { color:#94a3b8 !important; }

  .footer-meta { font-size:0.68rem; color:#5d6c87; display:flex; justify-content:space-between; padding-top:6px; border-top:1px solid #15243d; }

  /* Rollup table */
  .rollup { width:100%; border-collapse:collapse; background:#0a1628; border:1px solid #1c2c47; border-radius:10px; overflow:hidden; }
  .rollup th { background:#0e1c33; color:#9aa9c2; font-size:0.72rem; font-weight:600; letter-spacing:0.5px; padding:10px 12px; text-align:right; border-bottom:1px solid #1c2c47; }
  .rollup th:first-child { text-align:left; }
  .rollup td { padding:10px 12px; font-size:0.85rem; text-align:right; border-bottom:1px solid #15243d; font-variant-numeric:tabular-nums; }
  .rollup td:first-child { text-align:left; font-weight:600; }
  .rollup tr:last-child td { border-bottom:none; background:#0e1c33; font-weight:700; }
  .rollup tr.swing td:first-child { color:#60a5fa; }
  .rollup tr.scalp td:first-child { color:#fbbf24; }
  .rollup tr.pa    td:first-child { color:#c084fc; }
  .rollup tr.total td:first-child { color:#e0eaf8; }

  .pulse { display:inline-block; width:7px; height:7px; border-radius:50%; background:#10b981; margin-left:6px; animation:pulse 1.5s ease-in-out infinite; vertical-align:middle; }
  @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }

  /* ── Light-theme overrides ── */
  :root[data-theme="light"] .top-bar h1 { color:#1e293b; }
  :root[data-theme="light"] .top-bar .sub { color:#64748b; }
  :root[data-theme="light"] .toggle { background:#fff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  :root[data-theme="light"] .toggle button { color:#64748b; }
  :root[data-theme="light"] .card { background:#fff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  :root[data-theme="light"] .card.swing .card-title { color:#2563eb; }
  :root[data-theme="light"] .card.scalp .card-title { color:#d97706; }
  :root[data-theme="light"] .card.pa    .card-title { color:#9333ea; }
  :root[data-theme="light"] .pos-block,
  :root[data-theme="light"] .flat-block { background:#f8fafc !important; border-color:#e0e4ea !important; }
  :root[data-theme="light"] .flat-block { color:#64748b; }
  :root[data-theme="light"] .pos-symbol { color:#475569; }
  :root[data-theme="light"] .pos-grid .lbl { color:#64748b; }
  :root[data-theme="light"] .pos-grid .val { color:#1e293b; }
  :root[data-theme="light"] .stat { background:#f8fafc !important; border-color:#e0e4ea !important; }
  :root[data-theme="light"] .stat .lbl { color:#64748b; }
  :root[data-theme="light"] .stat .val { color:#1e293b; }
  :root[data-theme="light"] .footer-meta { color:#94a3b8; border-top-color:#e0e4ea; }
  :root[data-theme="light"] .rollup { background:#fff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  :root[data-theme="light"] .rollup th { background:#f1f5f9 !important; color:#64748b !important; border-bottom-color:#e0e4ea !important; }
  :root[data-theme="light"] .rollup td { color:#334155; border-bottom-color:#e0e4ea; }
  :root[data-theme="light"] .rollup tr:last-child td { background:#f8fafc !important; color:#1e293b; }
  :root[data-theme="light"] .rollup tr.swing td:first-child { color:#2563eb; }
  :root[data-theme="light"] .rollup tr.scalp td:first-child { color:#d97706; }
  :root[data-theme="light"] .rollup tr.pa    td:first-child { color:#9333ea; }
  :root[data-theme="light"] .pos-zero { color:#64748b !important; }
  :root[data-theme="light"] .pos-pos  { color:#059669 !important; }
  :root[data-theme="light"] .pos-neg  { color:#dc2626 !important; }
</style>
</head>
<body>
${sidebar}
<main class="main-content">
  <div class="top-bar">
    <div>
      <h1>📡 Real-Time Monitor</h1>
      <div class="sub">Live view of all 3 strategies — polls every 4s <span id="pulse" class="pulse"></span></div>
    </div>
    <div class="toggle" id="mode-toggle">
      <button data-mode="PAPER" class="active">PAPER</button>
      <button data-mode="LIVE">LIVE</button>
    </div>
  </div>

  <div class="cols">
    <div class="card swing" id="card-SWING">
      <div class="card-header">
        <div class="card-title">SWING</div>
        <div class="badge stop" id="badge-SWING">—</div>
      </div>
      <div id="body-SWING"><div class="flat-block">Loading…</div></div>
      <div class="stats-row" id="stats-SWING"></div>
      <div class="footer-meta" id="meta-SWING"><span>—</span><span>—</span></div>
    </div>
    <div class="card scalp" id="card-SCALP">
      <div class="card-header">
        <div class="card-title">SCALP</div>
        <div class="badge stop" id="badge-SCALP">—</div>
      </div>
      <div id="body-SCALP"><div class="flat-block">Loading…</div></div>
      <div class="stats-row" id="stats-SCALP"></div>
      <div class="footer-meta" id="meta-SCALP"><span>—</span><span>—</span></div>
    </div>
    <div class="card pa" id="card-PA">
      <div class="card-header">
        <div class="card-title">PRICE ACTION</div>
        <div class="badge stop" id="badge-PA">—</div>
      </div>
      <div id="body-PA"><div class="flat-block">Loading…</div></div>
      <div class="stats-row" id="stats-PA"></div>
      <div class="footer-meta" id="meta-PA"><span>—</span><span>—</span></div>
    </div>
  </div>

  <table class="rollup">
    <thead>
      <tr>
        <th>Strategy</th>
        <th>Status</th>
        <th>Open P&amp;L</th>
        <th>Closed P&amp;L (Today)</th>
        <th>Trades</th>
        <th>W / L</th>
        <th>Today Total (Open + Closed)</th>
      </tr>
    </thead>
    <tbody id="rollup-body">
      <tr class="swing"><td>SWING</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
      <tr class="scalp"><td>SCALP</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
      <tr class="pa"><td>PRICE ACTION</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
      <tr class="total"><td>TOTAL</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
    </tbody>
  </table>
</main>

<script>
const ENDPOINTS = {
  PAPER: { SWING:'/swing-paper/status/data', SCALP:'/scalp-paper/status/data', PA:'/pa-paper/status/data' },
  LIVE:  { SWING:'/swing-live/status/data',  SCALP:'/scalp-live/status/data',  PA:'/pa-live/status/data'  }
};
let mode = 'PAPER';
let timer = null;

const fmtINR = n => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const v = Number(n);
  const sign = v < 0 ? '-' : '';
  return sign + '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
};
const fmtNum = n => (n === null || n === undefined || isNaN(n)) ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const cls = n => (n === null || n === undefined || isNaN(n) || +n === 0) ? 'pos-zero' : (+n > 0 ? 'pos-pos' : 'pos-neg');

// Endpoints disagree on key: swing uses unrealisedPnl, scalp/pa use unrealised
const openPnl = d => d ? (d.unrealisedPnl ?? d.unrealised ?? 0) : 0;

function renderColumn(strategy, d) {
  const badgeEl = document.getElementById('badge-' + strategy);
  const bodyEl  = document.getElementById('body-' + strategy);
  const statsEl = document.getElementById('stats-' + strategy);
  const metaEl  = document.getElementById('meta-' + strategy);

  if (!d) {
    badgeEl.className = 'badge err'; badgeEl.textContent = 'OFFLINE';
    bodyEl.innerHTML = '<div class="flat-block">Endpoint unavailable</div>';
    statsEl.innerHTML = '';
    metaEl.innerHTML = '<span>—</span><span>—</span>';
    return;
  }

  badgeEl.className = 'badge ' + (d.running ? 'run' : 'stop');
  badgeEl.textContent = d.running ? 'RUNNING' : 'STOPPED';

  const pos = d.position;
  if (pos) {
    const upnl = openPnl(d);
    const pct = pos.optPremiumPct;
    bodyEl.innerHTML = \`
      <div class="pos-block">
        <div>
          <span class="pos-side \${pos.side}">\${pos.side || ''}</span>
          <span class="pos-symbol">\${pos.symbol || ''}</span>
        </div>
        <div class="pnl-big \${cls(upnl)}">\${fmtINR(upnl)}\${pct !== null && pct !== undefined ? '<span class="pct">' + (pct >= 0 ? '+' : '') + Number(pct).toFixed(2) + '%</span>' : ''}</div>
        <div class="pos-grid">
          <div class="lbl">Qty</div><div class="val">\${pos.qty ?? '—'}</div>
          <div class="lbl">Entry Spot</div><div class="val">\${fmtNum(pos.entryPrice)}</div>
          <div class="lbl">Entry Opt</div><div class="val">\${fmtNum(pos.optionEntryLtp)}</div>
          <div class="lbl">Curr Opt</div><div class="val">\${fmtNum(pos.optionCurrentLtp)}</div>
          <div class="lbl">Live Spot</div><div class="val">\${fmtNum(pos.liveClose)}</div>
          <div class="lbl">Pts Moved</div><div class="val \${cls(pos.pointsMoved)}">\${fmtNum(pos.pointsMoved)}</div>
          <div class="lbl">Stop Loss</div><div class="val">\${fmtNum(pos.stopLoss)}</div>
          <div class="lbl">Entry Time</div><div class="val">\${pos.entryTime || '—'}</div>
        </div>
      </div>\`;
  } else {
    bodyEl.innerHTML = \`<div class="flat-block">FLAT — no open position</div>\`;
  }

  const sessPnl = d.sessionPnl ?? 0;
  statsEl.innerHTML = \`
    <div class="stat"><div class="lbl">Trades</div><div class="val">\${d.tradeCount ?? 0}</div></div>
    <div class="stat"><div class="lbl">W / L</div><div class="val">\${d.wins ?? 0} / \${d.losses ?? 0}</div></div>
    <div class="stat"><div class="lbl">Session P&amp;L</div><div class="val \${cls(sessPnl)}">\${fmtINR(sessPnl)}</div></div>\`;

  const ltp = d.lastTickPrice ? fmtNum(d.lastTickPrice) : '—';
  const tickTime = d.lastTickTime || '';
  metaEl.innerHTML = \`<span>LTP \${ltp}\${tickTime ? ' · ' + tickTime : ''}</span><span>\${d.tickCount ?? 0} ticks</span>\`;
}

function renderRollup(all) {
  const rows = [
    { key:'SWING', cls:'swing', label:'SWING',         d: all.SWING },
    { key:'SCALP', cls:'scalp', label:'SCALP',         d: all.SCALP },
    { key:'PA',    cls:'pa',    label:'PRICE ACTION',  d: all.PA    },
  ];

  let totalOpen = 0, totalClosed = 0, totalTrades = 0, totalW = 0, totalL = 0;
  let anyRunning = false, anyData = false;

  const tbody = document.getElementById('rollup-body');
  let html = '';
  for (const r of rows) {
    const d = r.d;
    if (!d) {
      html += \`<tr class="\${r.cls}"><td>\${r.label}</td><td>OFFLINE</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>\`;
      continue;
    }
    anyData = true;
    const open = +openPnl(d) || 0;
    const closed = +(d.sessionPnl ?? 0) || 0;
    const dayTotal = open + closed;
    const trades = d.tradeCount ?? 0;
    const w = d.wins ?? 0;
    const l = d.losses ?? 0;
    if (d.running) anyRunning = true;
    totalOpen += open;
    totalClosed += closed;
    totalTrades += +trades || 0;
    totalW += +w || 0;
    totalL += +l || 0;
    html += \`<tr class="\${r.cls}">
      <td>\${r.label}</td>
      <td>\${d.running ? 'RUNNING' : 'STOPPED'}</td>
      <td class="\${cls(open)}">\${fmtINR(open)}</td>
      <td class="\${cls(closed)}">\${fmtINR(closed)}</td>
      <td>\${trades}</td>
      <td>\${w} / \${l}</td>
      <td class="\${cls(dayTotal)}">\${fmtINR(dayTotal)}</td>
    </tr>\`;
  }
  const grandDayTotal = totalOpen + totalClosed;
  html += \`<tr class="total">
    <td>TOTAL</td>
    <td>\${anyData ? (anyRunning ? 'RUNNING' : 'STOPPED') : '—'}</td>
    <td class="\${cls(totalOpen)}">\${fmtINR(totalOpen)}</td>
    <td class="\${cls(totalClosed)}">\${fmtINR(totalClosed)}</td>
    <td>\${totalTrades}</td>
    <td>\${totalW} / \${totalL}</td>
    <td class="\${cls(grandDayTotal)}">\${fmtINR(grandDayTotal)}</td>
  </tr>\`;
  tbody.innerHTML = html;
}

async function poll() {
  const eps = ENDPOINTS[mode];
  const fetchOne = url => fetch(url, { cache:'no-store' })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
  const [s, sc, p] = await Promise.all([fetchOne(eps.SWING), fetchOne(eps.SCALP), fetchOne(eps.PA)]);
  renderColumn('SWING', s);
  renderColumn('SCALP', sc);
  renderColumn('PA', p);
  renderRollup({ SWING:s, SCALP:sc, PA:p });
}

document.querySelectorAll('#mode-toggle button').forEach(b => {
  b.addEventListener('click', () => {
    if (b.classList.contains('active')) return;
    document.querySelectorAll('#mode-toggle button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    mode = b.dataset.mode;
    poll();
  });
});

poll();
timer = setInterval(poll, 4000);
</script>
</body>
</html>`;
}

module.exports = router;

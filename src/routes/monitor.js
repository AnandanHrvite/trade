/**
 * monitor.js — EC2 Instance Health Monitor
 * ────────────────────────────────────────────────────────────
 * GET  /monitor       → Real-time system metrics dashboard
 * GET  /monitor/data  → JSON snapshot of CPU, memory, disk, process stats
 */

const express = require("express");
const os      = require("os");
const { execSync } = require("child_process");
const router  = express.Router();
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, toastJS } = require("../utils/sharedNav");

// ── CPU snapshot helper ─────────────────────────────────────────────────────
let _prevCpus = os.cpus();

function cpuUsage() {
  const curCpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  const perCore = [];

  for (let i = 0; i < curCpus.length; i++) {
    const prev = _prevCpus[i] ? _prevCpus[i].times : curCpus[i].times;
    const cur  = curCpus[i].times;
    const idle  = cur.idle - prev.idle;
    const total = (cur.user - prev.user) + (cur.nice - prev.nice)
                + (cur.sys - prev.sys) + (cur.irq - prev.irq) + idle;
    totalIdle += idle;
    totalTick += total;
    perCore.push(total === 0 ? 0 : +((1 - idle / total) * 100).toFixed(1));
  }
  _prevCpus = curCpus;
  return {
    average: totalTick === 0 ? 0 : +((1 - totalIdle / totalTick) * 100).toFixed(1),
    perCore,
  };
}

// ── Disk usage (works on Linux & macOS) ─────────────────────────────────────
function diskUsage() {
  try {
    const line = execSync("df -k / | tail -1", { encoding: "utf8" }).trim();
    const parts = line.split(/\s+/);
    // df -k columns: Filesystem 1K-blocks Used Available Use% Mounted
    const totalKB = parseInt(parts[1], 10);
    const usedKB  = parseInt(parts[2], 10);
    const availKB = parseInt(parts[3], 10);
    return {
      totalGB: +(totalKB / 1048576).toFixed(2),
      usedGB:  +(usedKB  / 1048576).toFixed(2),
      availGB: +(availKB / 1048576).toFixed(2),
      pct:     totalKB === 0 ? 0 : +((usedKB / totalKB) * 100).toFixed(1),
    };
  } catch (_) {
    return { totalGB: 0, usedGB: 0, availGB: 0, pct: 0 };
  }
}

// ── Load average (1, 5, 15 min) ─────────────────────────────────────────────
function loadAvg() {
  const la = os.loadavg();
  return { m1: +la[0].toFixed(2), m5: +la[1].toFixed(2), m15: +la[2].toFixed(2) };
}

// ── JSON data endpoint ──────────────────────────────────────────────────────
router.get("/data", (_req, res) => {
  const mem   = { total: os.totalmem(), free: os.freemem() };
  mem.used    = mem.total - mem.free;
  mem.pct     = +((mem.used / mem.total) * 100).toFixed(1);

  const proc = process.memoryUsage();

  res.json({
    ts:       Date.now(),
    cpu:      cpuUsage(),
    mem: {
      totalMB: +(mem.total / 1048576).toFixed(0),
      usedMB:  +(mem.used  / 1048576).toFixed(0),
      freeMB:  +(mem.free  / 1048576).toFixed(0),
      pct:     mem.pct,
    },
    disk:     diskUsage(),
    load:     loadAvg(),
    process: {
      rss:      +(proc.rss / 1048576).toFixed(1),
      heapUsed: +(proc.heapUsed / 1048576).toFixed(1),
      heapTotal:+(proc.heapTotal / 1048576).toFixed(1),
      external: +(proc.external  / 1048576).toFixed(1),
      uptimeSec: +(process.uptime()).toFixed(0),
    },
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch:     os.arch(),
      cores:    os.cpus().length,
      model:    os.cpus()[0] ? os.cpus()[0].model : 'unknown',
      uptimeSec: os.uptime(),
    },
  });
});

// ── Main UI page ────────────────────────────────────────────────────────────
router.get("/", (_req, res) => {
  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";

  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monitor — Trading Bot</title>
${faviconLink()}
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
<style>
${sidebarCSS()}
${modalCSS()}

/* ── page layout ── */
.main-content { margin-left:220px; padding:28px 32px 40px; min-height:100vh; background:#080c14; }
@media(max-width:900px){ .main-content{margin-left:0;padding:18px 10px 32px;} }

.page-title { font-size:1.1rem; font-weight:700; color:#e0eaf8; margin-bottom:6px; }
.page-sub   { font-size:0.72rem; color:#3a5070; margin-bottom:22px; }

/* ── stat cards ── */
.stat-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; margin-bottom:22px; }
.stat-card { background:#090f09; border:0.5px solid #162416; border-radius:8px; padding:16px 18px; }
.stat-label { font-size:0.65rem; color:#3a5070; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; }
.stat-value { font-size:1.35rem; font-weight:700; color:#e0eaf8; font-family:'IBM Plex Mono',monospace; }
.stat-sub   { font-size:0.65rem; color:#3a5070; margin-top:4px; }

/* ── chart cards ── */
.chart-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(400px,1fr)); gap:16px; margin-bottom:22px; }
@media(max-width:900px){ .chart-grid{grid-template-columns:1fr;} }
.chart-card { background:#090f09; border:0.5px solid #162416; border-radius:10px; padding:18px 20px; }
.chart-title { font-size:0.72rem; font-weight:700; color:#6b8fc2; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; }
canvas { width:100%!important; height:220px!important; }

/* ── process table ── */
.proc-card { background:#090f09; border:0.5px solid #162416; border-radius:10px; padding:18px 20px; margin-bottom:22px; }
.proc-title { font-size:0.72rem; font-weight:700; color:#6b8fc2; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; }
.proc-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; }
.proc-item .pi-label { font-size:0.62rem; color:#3a5070; }
.proc-item .pi-val   { font-size:0.9rem; font-weight:600; color:#e0eaf8; font-family:'IBM Plex Mono',monospace; }

/* ── progress bar ── */
.bar-track { height:8px; background:#111827; border-radius:4px; overflow:hidden; margin-top:6px; }
.bar-fill  { height:100%; border-radius:4px; transition:width 0.4s; }
.bar-cpu  { background:linear-gradient(90deg,#3b82f6,#60a5fa); }
.bar-mem  { background:linear-gradient(90deg,#f59e0b,#fbbf24); }
.bar-disk { background:linear-gradient(90deg,#10b981,#34d399); }

:root[data-theme="light"] { filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(1.05); background-color: #fff; }
:root[data-theme="light"] img, :root[data-theme="light"] .sidebar-icon { filter: invert(1) hue-rotate(180deg); }
</style>
</head><body>
<div class="app-shell">
${buildSidebar("monitor", liveActive)}
<div class="main-content">

<div class="page-title">Instance Monitor</div>
<div class="page-sub" id="sysInfo">Loading system info…</div>

<!-- ── Top stat cards ── -->
<div class="stat-row">
  <div class="stat-card">
    <div class="stat-label">CPU Usage</div>
    <div class="stat-value" id="cpuVal">–</div>
    <div class="bar-track"><div class="bar-fill bar-cpu" id="cpuBar" style="width:0%"></div></div>
    <div class="stat-sub" id="cpuSub"></div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Memory</div>
    <div class="stat-value" id="memVal">–</div>
    <div class="bar-track"><div class="bar-fill bar-mem" id="memBar" style="width:0%"></div></div>
    <div class="stat-sub" id="memSub"></div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Disk</div>
    <div class="stat-value" id="diskVal">–</div>
    <div class="bar-track"><div class="bar-fill bar-disk" id="diskBar" style="width:0%"></div></div>
    <div class="stat-sub" id="diskSub"></div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Load Average</div>
    <div class="stat-value" id="loadVal">–</div>
    <div class="stat-sub" id="loadSub"></div>
  </div>
</div>

<!-- ── Charts ── -->
<div class="chart-grid">
  <div class="chart-card">
    <div class="chart-title">CPU % (last 5 min)</div>
    <canvas id="cpuChart"></canvas>
  </div>
  <div class="chart-card">
    <div class="chart-title">Memory MB (last 5 min)</div>
    <canvas id="memChart"></canvas>
  </div>
  <div class="chart-card">
    <div class="chart-title">Node.js Heap MB (last 5 min)</div>
    <canvas id="heapChart"></canvas>
  </div>
  <div class="chart-card">
    <div class="chart-title">Load Average (last 5 min)</div>
    <canvas id="loadChart"></canvas>
  </div>
</div>

<!-- ── Node process details ── -->
<div class="proc-card">
  <div class="proc-title">Node.js Process</div>
  <div class="proc-grid">
    <div class="proc-item"><div class="pi-label">RSS</div><div class="pi-val" id="pRss">–</div></div>
    <div class="proc-item"><div class="pi-label">Heap Used</div><div class="pi-val" id="pHeapUsed">–</div></div>
    <div class="proc-item"><div class="pi-label">Heap Total</div><div class="pi-val" id="pHeapTotal">–</div></div>
    <div class="proc-item"><div class="pi-label">External</div><div class="pi-val" id="pExternal">–</div></div>
    <div class="proc-item"><div class="pi-label">Process Uptime</div><div class="pi-val" id="pUptime">–</div></div>
    <div class="proc-item"><div class="pi-label">System Uptime</div><div class="pi-val" id="sUptime">–</div></div>
  </div>
</div>

</div></div>

<script>
${modalJS()}

/* ── theme ── */
(function(){
  var theme = '${process.env.UI_THEME || "dark"}';
  if (theme === 'light') document.documentElement.setAttribute('data-theme','light');
})();

/* ── Chart.js defaults ── */
Chart.defaults.color = '#3a5070';
Chart.defaults.borderColor = '#1a2236';
Chart.defaults.font.family = "'IBM Plex Mono', monospace";
Chart.defaults.font.size = 10;
Chart.defaults.animation.duration = 300;

const MAX_PTS = 150; // 5 min at 2s interval

function makeChart(id, datasets, yOpts = {}) {
  return new Chart(document.getElementById(id), {
    type: 'line',
    data: { labels: [], datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: datasets.length > 1, labels: { boxWidth: 8, padding: 8 } } },
      scales: {
        x: { display: true, ticks: { maxTicksLimit: 8, font: { size: 9 } }, grid: { display: false } },
        y: { beginAtZero: true, ...yOpts, grid: { color: '#111827' }, ticks: { font: { size: 9 } } },
      },
      elements: { point: { radius: 0 }, line: { borderWidth: 1.5 } },
    }
  });
}

const cpuChart  = makeChart('cpuChart',  [{ label: 'CPU %', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', fill: true }], { max: 100, ticks: { callback: v => v + '%' } });
const memChart  = makeChart('memChart',  [
  { label: 'Used MB', data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.08)', fill: true },
  { label: 'Free MB', data: [], borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', fill: true },
]);
const heapChart = makeChart('heapChart', [
  { label: 'Heap Used', data: [], borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.08)', fill: true },
  { label: 'Heap Total', data: [], borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.08)', fill: false, borderDash: [4,3] },
]);
const loadChrt  = makeChart('loadChart', [
  { label: '1m', data: [], borderColor: '#ef4444', fill: false },
  { label: '5m', data: [], borderColor: '#f59e0b', fill: false },
  { label: '15m', data: [], borderColor: '#10b981', fill: false },
]);

function pushPt(chart, label, vals) {
  chart.data.labels.push(label);
  vals.forEach((v, i) => chart.data.datasets[i].data.push(v));
  if (chart.data.labels.length > MAX_PTS) {
    chart.data.labels.shift();
    chart.data.datasets.forEach(ds => ds.data.shift());
  }
  chart.update('none');
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
        m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return (d > 0 ? d + 'd ' : '') + h + 'h ' + m + 'm ' + s + 's';
}

async function poll() {
  try {
    const r = await fetch('/monitor/data');
    const d = await r.json();
    const t = new Date(d.ts).toLocaleTimeString();

    // stat cards
    document.getElementById('cpuVal').textContent  = d.cpu.average + '%';
    document.getElementById('cpuBar').style.width   = d.cpu.average + '%';
    document.getElementById('cpuSub').textContent   = d.cpu.perCore.length + ' cores  ·  ' + d.cpu.perCore.map(c=>c+'%').join('  ');

    document.getElementById('memVal').textContent  = d.mem.pct + '%';
    document.getElementById('memBar').style.width   = d.mem.pct + '%';
    document.getElementById('memSub').textContent   = d.mem.usedMB + ' / ' + d.mem.totalMB + ' MB';

    document.getElementById('diskVal').textContent  = d.disk.pct + '%';
    document.getElementById('diskBar').style.width   = d.disk.pct + '%';
    document.getElementById('diskSub').textContent   = d.disk.usedGB + ' / ' + d.disk.totalGB + ' GB';

    document.getElementById('loadVal').textContent  = d.load.m1;
    document.getElementById('loadSub').textContent   = '1m: ' + d.load.m1 + '  ·  5m: ' + d.load.m5 + '  ·  15m: ' + d.load.m15;

    // process
    document.getElementById('pRss').textContent       = d.process.rss + ' MB';
    document.getElementById('pHeapUsed').textContent   = d.process.heapUsed + ' MB';
    document.getElementById('pHeapTotal').textContent  = d.process.heapTotal + ' MB';
    document.getElementById('pExternal').textContent   = d.process.external + ' MB';
    document.getElementById('pUptime').textContent     = fmtUptime(d.process.uptimeSec);
    document.getElementById('sUptime').textContent     = fmtUptime(d.system.uptimeSec);

    // system info (once)
    document.getElementById('sysInfo').textContent =
      d.system.hostname + '  ·  ' + d.system.platform + '/' + d.system.arch + '  ·  ' +
      d.system.cores + ' cores  ·  ' + d.system.model;

    // charts
    pushPt(cpuChart, t, [d.cpu.average]);
    pushPt(memChart, t, [d.mem.usedMB, d.mem.freeMB]);
    pushPt(heapChart, t, [d.process.heapUsed, d.process.heapTotal]);
    pushPt(loadChrt, t, [d.load.m1, d.load.m5, d.load.m15]);

    // color CPU bar based on severity
    const bar = document.getElementById('cpuBar');
    bar.style.background = d.cpu.average > 90 ? 'linear-gradient(90deg,#ef4444,#f87171)'
      : d.cpu.average > 70 ? 'linear-gradient(90deg,#f59e0b,#fbbf24)'
      : 'linear-gradient(90deg,#3b82f6,#60a5fa)';

  } catch(e) { console.warn('Monitor poll error:', e); }
}

poll();
setInterval(poll, 2000);

${toastJS()}
<\/script>
</body></html>`);
});

module.exports = router;

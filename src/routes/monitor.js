/**
 * monitor.js — EC2 Instance Health Monitor
 * ────────────────────────────────────────────────────────────
 * GET  /monitor       → Real-time system metrics dashboard
 * GET  /monitor/data  → JSON snapshot of CPU, memory, disk, process stats
 * GET  /monitor/disk  → per-folder disk usage + free space + retention settings (open, read-only)
 * GET  /monitor/disk/preview?folder=&days= → dry run of "delete older than N days" (API_SECRET)
 * POST /monitor/action/disk-delete {planId} → deletes exactly what that preview listed (API_SECRET)
 */

const express = require("express");
const os      = require("os");
const { exec } = require("child_process");
const router  = express.Router();
const { resolveTheme } = require("../utils/theme");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, toastJS } = require("../utils/sharedNav");
const backtestCache = require("../utils/backtestCache");
const backtestJobs  = require("../utils/backtestJobManager");
const path          = require("path");
const diskRetention = require("../utils/diskRetention");

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
// Disk fill changes slowly, but /monitor/data is polled every few seconds.
// Spawning `df` synchronously on each poll blocked the event loop; instead we
// cache the last reading and refresh it asynchronously at most every 30s, so
// the handler never blocks and we spawn df ~once per 30s regardless of polling.
let _diskCache      = { totalGB: 0, usedGB: 0, availGB: 0, pct: 0 };
let _diskCacheAt    = 0;
let _diskRefreshing = false;
const DISK_TTL_MS   = 30_000;

function refreshDiskAsync() {
  if (_diskRefreshing || Date.now() - _diskCacheAt < DISK_TTL_MS) return;
  _diskRefreshing = true;
  exec("df -k / | tail -1", { encoding: "utf8" }, (err, stdout) => {
    _diskRefreshing = false;
    if (err) return;
    try {
      const parts = stdout.trim().split(/\s+/);
      // df -k columns: Filesystem 1K-blocks Used Available Use% Mounted
      const totalKB = parseInt(parts[1], 10);
      const usedKB  = parseInt(parts[2], 10);
      const availKB = parseInt(parts[3], 10);
      if (!Number.isFinite(totalKB)) return;
      _diskCache = {
        totalGB: +(totalKB / 1048576).toFixed(2),
        usedGB:  +(usedKB  / 1048576).toFixed(2),
        availGB: +(availKB / 1048576).toFixed(2),
        pct:     totalKB === 0 ? 0 : +((usedKB / totalKB) * 100).toFixed(1),
      };
      _diskCacheAt = Date.now();
    } catch (_) { /* leave last good value */ }
  });
}
refreshDiskAsync(); // prime at module load so the first poll has real data

function diskUsage() {
  refreshDiskAsync();  // kick off a refresh if stale; returns immediately
  return _diskCache;   // serve last known value — never blocks the event loop
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

// ── Disk usage by folder ────────────────────────────────────────────────────
// The walk is async and cached ~60s inside diskRetention; a forced rescan is
// rate-limited so a stuck refresh button cannot keep the disk busy.
let _lastForcedScan = 0;
router.get("/disk", async (req, res) => {
  try {
    let force = req.query.force === "1";
    if (force && Date.now() - _lastForcedScan < 10_000) force = false;
    if (force) _lastForcedScan = Date.now();
    const report = await diskRetention.getDiskReport({ force });
    res.json({
      ok: true,
      free: diskUsage(),
      report,
      auto: diskRetention.autoStatus(),
      blocked: diskRetention.isMarketHoursBlocked(Date.now()),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function _relName(def, p) {
  const base = def.bases.find(b => p.startsWith(b + path.sep)) || def.bases[0];
  return path.relative(path.dirname(base), p);
}

// Dry run. Not in OPEN_PATHS — it lists file names and is step one of a delete.
router.get("/disk/preview", async (req, res) => {
  try {
    const key  = String(req.query.folder || "");
    const days = parseInt(req.query.days, 10);
    const plan = await diskRetention.planCleanup(key, days);
    const def  = diskRetention.folderByKey(key);
    const planId = plan.items.length ? diskRetention.storePlan(plan) : null;
    res.json({
      ok: true, planId,
      key: plan.key, label: plan.label, keepDays: plan.keepDays,
      cutoffDate: plan.cutoffDate, today: plan.today,
      items: plan.items.length, files: plan.files, bytes: plan.bytes, truncated: plan.truncated,
      sample: plan.items.slice(0, 15).map(it => ({ name: _relName(def, it.path), date: it.date, bytes: it.bytes, files: it.files, action: it.action })),
      blocked: diskRetention.isMarketHoursBlocked(Date.now()),
      backtestBusy: !!def.busyOnBacktest && !backtestJobs.isIdle(),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Main UI page ────────────────────────────────────────────────────────────
router.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monitor — Trading Bot</title>
${faviconLink()}
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
<style>
${sidebarCSS()}
${modalCSS()}
/* ── base reset ── */
*, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; min-height:100vh; overflow-x:hidden; }

/* ── page layout ── */
.main-content { margin-left:200px; padding:28px 32px 40px; min-height:100vh; background:#080c14; }
@media(max-width:768px){ .main-content{margin-left:0;padding:18px 10px 32px;} }

.page-title { font-size:1.1rem; font-weight:700; color:#e0eaf8; margin-bottom:6px; }
.page-sub   { font-size:0.72rem; color:var(--muted-2,#6d85a8); margin-bottom:22px; }

/* ── Breadcrumb ── */
.breadcrumb { display:flex; align-items:center; gap:6px; font-size:0.68rem; font-weight:600; margin-bottom:6px; }
.bc-link { color:var(--muted-1,#8ba1c2); text-decoration:none; padding:2px 6px; border-radius:4px; transition:color 0.15s, background 0.15s; }
.bc-link:hover { color:#3b82f6; background:#0f1624; }
.bc-sep { color:var(--muted-2,#6d85a8); font-size:0.75rem; }
.bc-current { color:#e0eaf8; padding:2px 6px; }
:root[data-theme="light"] .bc-link { color:#4b5769; }
:root[data-theme="light"] .bc-link:hover { color:#2563eb; background:#f1f5f9; }
:root[data-theme="light"] .bc-sep { color:#5c6b7f; }
:root[data-theme="light"] .bc-current { color:#1e293b; }

/* ── stat cards ── */
.stat-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; margin-bottom:22px; }
.stat-card { background:#090f09; border:0.5px solid #162416; border-radius:8px; padding:16px 18px; }
.stat-label { font-size:0.56rem; color:#7f9b5c; text-transform:uppercase; letter-spacing:1.2px; margin-bottom:5px; }
.stat-value { font-size:1.35rem; font-weight:700; color:#c0d8b0; font-family:'IBM Plex Mono',monospace; }
.stat-sub   { font-size:0.6rem; color:#7f9b5c; margin-top:3px; }

/* ── chart cards ── */
.chart-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(400px,100%),1fr)); gap:16px; margin-bottom:22px; }
@media(max-width:900px){ .chart-grid{grid-template-columns:1fr;} }
.chart-card { background:#090f09; border:0.5px solid #162416; border-radius:10px; padding:18px 20px; }
.chart-title { font-size:0.56rem; font-weight:700; color:#7f9b5c; text-transform:uppercase; letter-spacing:1.2px; margin-bottom:12px; }
canvas { width:100%!important; height:220px!important; }

/* ── process table ── */
.proc-card { background:#090f09; border:0.5px solid #162416; border-radius:10px; padding:18px 20px; margin-bottom:22px; }
.proc-title { font-size:0.56rem; font-weight:700; color:#7f9b5c; text-transform:uppercase; letter-spacing:1.2px; margin-bottom:12px; }
.proc-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; }
.proc-item .pi-label { font-size:0.56rem; color:#7f9b5c; text-transform:uppercase; letter-spacing:1.2px; }
.proc-item .pi-val   { font-size:0.9rem; font-weight:600; color:#c0d8b0; font-family:'IBM Plex Mono',monospace; }

/* ── action bar ── */
.action-bar { background:#090f09; border:0.5px solid #162416; border-radius:10px; padding:14px 18px; margin-bottom:22px; }
.action-title { font-size:0.56rem; font-weight:700; color:#7f9b5c; text-transform:uppercase; letter-spacing:1.2px; margin-bottom:10px; }
.action-buttons { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
.action-note { font-size:0.68rem; color:#7f9b5c; font-style:italic; }
.act-btn { font-family:'IBM Plex Mono',monospace; font-size:0.72rem; font-weight:600; padding:7px 14px; border-radius:6px; cursor:pointer; border:0.5px solid transparent; transition:all 0.12s; background:transparent; }
.act-btn:hover { transform:translateY(-1px); filter:brightness(1.15); }
.act-btn:active { transform:translateY(0); }
.act-btn:disabled { opacity:0.4; cursor:not-allowed; transform:none; }
.act-blue   { background:rgba(59,130,246,0.08);  color:#60a5fa; border-color:rgba(59,130,246,0.3); }
.act-amber  { background:rgba(245,158,11,0.08);  color:#fbbf24; border-color:rgba(245,158,11,0.3); }
.act-purple { background:rgba(139,92,246,0.08);  color:#a78bfa; border-color:rgba(139,92,246,0.3); }
.act-red    { background:rgba(239,68,68,0.08);   color:#f87171; border-color:rgba(239,68,68,0.3); }
:root[data-theme="light"] .action-bar { background:#ffffff; border-color:#e0e4ea; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
:root[data-theme="light"] .action-title { color:#4b5769; }
:root[data-theme="light"] .action-note { color:#5c6b7f; }
:root[data-theme="light"] .act-blue   { color:#1d4ed8; border-color:#bfdbfe; background:#eff6ff; }
:root[data-theme="light"] .act-amber  { color:#b45309; border-color:#fde68a; background:#fffbeb; }
:root[data-theme="light"] .act-purple { color:#6d28d9; border-color:#ddd6fe; background:#f5f3ff; }
:root[data-theme="light"] .act-red    { color:#b91c1c; border-color:#fecaca; background:#fef2f2; }

/* ── progress bar ── */
.bar-track { height:6px; background:#0a120a; border-radius:4px; overflow:hidden; margin-top:6px; }
.bar-fill  { height:100%; border-radius:4px; transition:width 0.4s; }
.bar-cpu  { background:linear-gradient(90deg,#3b82f6,#60a5fa); }
.bar-mem  { background:linear-gradient(90deg,#f59e0b,#fbbf24); }
.bar-disk { background:linear-gradient(90deg,#10b981,#34d399); }

/* ── MONITOR LIGHT THEME ── */
:root[data-theme="light"] body { background:#f4f6f9; color:#334155; }
:root[data-theme="light"] .main-content { background:#f4f6f9; }
:root[data-theme="light"] .page-title { color:#1e293b; }
:root[data-theme="light"] .page-sub { color:#5c6b7f; }
:root[data-theme="light"] .stat-card { background:#ffffff; border-color:#e0e4ea; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
:root[data-theme="light"] .stat-label { color:#4b5769; }
:root[data-theme="light"] .stat-value { color:#1e293b; }
:root[data-theme="light"] .stat-sub { color:#5c6b7f; }
:root[data-theme="light"] .bar-track { background:#e2e8f0; }
:root[data-theme="light"] .chart-card { background:#ffffff; border-color:#e0e4ea; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
:root[data-theme="light"] .chart-title { color:#4b5769; }
:root[data-theme="light"] .proc-card { background:#ffffff; border-color:#e0e4ea; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
:root[data-theme="light"] .proc-title { color:#4b5769; }
:root[data-theme="light"] .proc-item .pi-label { color:#4b5769; }
:root[data-theme="light"] .proc-item .pi-val { color:#1e293b; }

/* ── disk usage by folder ── */
.disk-card { background:#090f09; border:0.5px solid #162416; border-radius:10px; padding:14px 18px; margin-bottom:22px; }
.disk-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
.disk-head .action-title { margin-bottom:0; }
.disk-free { font-size:0.82rem; font-weight:600; color:#c0d8b0; font-family:'IBM Plex Mono',monospace; margin-bottom:4px; overflow-wrap:anywhere; }
.disk-auto { font-size:0.68rem; color:#7f9b5c; margin-bottom:12px; line-height:1.5; }
.disk-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr)); gap:10px; }
.disk-row { border:0.5px solid #162416; border-radius:8px; padding:12px 14px; min-width:0; }
.dr-top { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
.dr-name { font-size:0.8rem; font-weight:700; color:#e0eaf8; }
.dr-size { font-size:0.9rem; font-weight:700; color:#c0d8b0; font-family:'IBM Plex Mono',monospace; white-space:nowrap; }
.dr-meta { font-size:0.66rem; color:#7f9b5c; font-family:'IBM Plex Mono',monospace; margin-top:3px; overflow-wrap:anywhere; }
.dr-note { font-size:0.66rem; color:#6d85a8; margin-top:4px; line-height:1.45; }
.dr-keep { font-size:0.66rem; color:#a3b8d0; margin-top:4px; }
.dr-keep.prot { color:#34d399; }
.dr-act { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:10px; }
.dr-act label { font-size:0.72rem; color:#a3b8d0; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dr-act input { width:76px; min-height:44px; font-size:16px; padding:6px 8px; border-radius:6px; border:0.5px solid #24402a; background:#0a120a; color:#e0eaf8; font-family:'IBM Plex Mono',monospace; }
.dr-act .act-btn, .disk-head .act-btn { min-height:44px; }
.modal-msg { overflow-wrap:anywhere; max-height:55vh; overflow-y:auto; }
@media(max-width:768px){ .act-btn { min-height:44px; } }
:root[data-theme="light"] .disk-card { background:#ffffff; border-color:#e0e4ea; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
:root[data-theme="light"] .disk-row { border-color:#e0e4ea; }
:root[data-theme="light"] .disk-free, :root[data-theme="light"] .dr-size, :root[data-theme="light"] .dr-name { color:#1e293b; }
:root[data-theme="light"] .disk-auto, :root[data-theme="light"] .dr-meta, :root[data-theme="light"] .dr-note { color:#5c6b7f; }
:root[data-theme="light"] .dr-keep, :root[data-theme="light"] .dr-act label { color:#334155; }
:root[data-theme="light"] .dr-keep.prot { color:#047857; }
:root[data-theme="light"] .dr-act input { background:#f8fafc; border-color:#cbd5e1; color:#1e293b; }
</style>
</head><body>
<div class="app-shell">
${buildSidebar("monitor", false)}
<div class="main-content">

<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/" class="bc-link">⌂ Dashboard</a>
  <span class="bc-sep">›</span>
  <a href="/settings" class="bc-link">⚙ Settings</a>
  <span class="bc-sep">›</span>
  <span class="bc-current">📈 Monitor</span>
</nav>
<div class="page-title">Instance Monitor</div>
<div class="page-sub" id="sysInfo">Loading system info…</div>

<!-- ── Maintenance action bar ── -->
<div class="action-bar">
  <div class="action-title">Reduce Resource Usage</div>
  <div class="action-buttons">
    <button class="act-btn act-blue"   onclick="doAction('gc','Force GC','Force Node.js garbage collection?',false)"              title="Trigger V8 garbage collection — reclaims heap held by finished backtests">♻ Force GC</button>
    <button class="act-btn act-amber"  onclick="doAction('prune-cache','Prune cache (90d)','Prune backtest cache files older than 90 days?',true)" title="Delete cached candle files older than 90 days">🧹 Prune Cache (90d)</button>
    <button class="act-btn act-amber"  onclick="doAction('clear-cache-all','Clear ALL cache','Delete ALL backtest cache files? Next backtest will refetch from Fyers API.',true)" title="Delete every cached candle file — backtests will refetch from API">🗑 Clear All Cache</button>
    <button class="act-btn act-purple" onclick="doAction('clear-jobs','Clear finished jobs','Clear finished backtest jobs from memory?',true)" title="Drop stored backtest trade arrays from memory">📦 Clear Finished Jobs</button>
    <button class="act-btn act-red"    onclick="doAction('restart','Restart Node','Restart the Node.js process? Any running backtest will be killed.',true)" title="Restart the bot via PM2 — blocked when LIVE mode is active">⟳ Restart Node</button>
  </div>
  <div class="action-note">Tip: most memory growth comes from backtest trade arrays. Force GC + Clear Finished Jobs is the safest combo.</div>
</div>

<!-- ── Disk usage by folder ── -->
<div class="disk-card" id="diskCard">
  <div class="disk-head">
    <div class="action-title">Disk Usage by Folder</div>
    <button class="act-btn act-blue" onclick="loadDisk(true)" title="Re-measure every folder now">↻ Re-scan</button>
  </div>
  <div class="disk-free" id="diskFree">Measuring folders…</div>
  <div class="disk-auto" id="diskAuto"></div>
  <div class="disk-list" id="diskList"></div>
</div>

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
  var theme = '${resolveTheme()}';
  if (theme === 'light') document.documentElement.setAttribute('data-theme','light');
})();

/* ── Chart.js defaults ── */
Chart.defaults.color = '#2a3a20';
Chart.defaults.borderColor = 'rgba(0,0,0,0)';
Chart.defaults.font.family = "'IBM Plex Mono', monospace";
Chart.defaults.font.size = 10;
Chart.defaults.animation.duration = 300;

const MAX_PTS = 150; // 5 min at 2s interval

var _lt = document.documentElement.getAttribute('data-theme') === 'light';
var _mGridC = _lt ? '#e0e4ea' : 'rgba(22,36,22,0.4)';
var _mTickC = _lt ? '#64748b' : '#2a3a20';

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
        x: { display: true, ticks: { maxTicksLimit: 8, font: { size: 9 }, color: _mTickC }, grid: { display: false }, border: { display: false } },
        y: { beginAtZero: true, ...yOpts, grid: { color: _mGridC }, ticks: { font: { size: 9 }, color: _mTickC }, border: { display: false } },
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

async function doAction(action, title, confirmMsg, destructive) {
  var ok = destructive
    ? await showDoubleConfirm({
        icon: '⚠️', title: title || 'Confirm action',
        message: confirmMsg, confirmText: 'Proceed', confirmClass: 'modal-btn-danger',
        secondConfirmText: 'Yes, proceed'
      })
    : await showConfirm({
        icon: '⚠️', title: title || 'Confirm action',
        message: confirmMsg, confirmText: 'Proceed', confirmClass: 'modal-btn-danger'
      });
  if (!ok) return;
  const buttons = document.querySelectorAll('.act-btn');
  buttons.forEach(b => b.disabled = true);
  try {
    const r = await secretFetch('/monitor/action/' + action, { method: 'POST' });
    if (!r) return;
    const d = await r.json();
    if (d.ok) {
      if (typeof window.showToast === 'function') window.showToast(d.message || 'Done', 'success');
      else alert(d.message || 'Done');
      // Refresh stats immediately so the user sees the effect
      setTimeout(poll, 300);
    } else {
      if (typeof window.showToast === 'function') window.showToast(d.error || 'Action failed', 'error');
      else alert('Error: ' + (d.error || 'Action failed'));
    }
  } catch (e) {
    if (typeof window.showToast === 'function') window.showToast('Request failed: ' + e.message, 'error');
    else alert('Request failed: ' + e.message);
  } finally {
    buttons.forEach(b => b.disabled = false);
  }
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

/* ── Disk usage by folder ── */
function escH(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; });
}
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}
function diskToast(msg, ok) {
  if (typeof window.showToast === 'function') window.showToast(msg, ok ? '#10b981' : '#ef4444');
  else alert(msg);
}
var _diskFolders = {};

async function loadDisk(force) {
  try {
    var r = await fetch('/monitor/disk' + (force ? '?force=1' : ''));
    var d = await r.json();
    if (!d.ok) throw new Error(d.error || 'scan failed');
    var f = d.free || {};
    var total = d.report.folders.reduce(function(s, x){ return s + x.bytes; }, 0);
    document.getElementById('diskFree').textContent =
      'Free: ' + (f.availGB != null ? f.availGB : '–') + ' GB of ' + (f.totalGB != null ? f.totalGB : '–') + ' GB (' + (f.pct != null ? f.pct : '–') + '% used) · these folders: ' + fmtBytes(total);
    var a = d.auto || {};
    var last = a.last ? (a.last.error ? 'last run failed: ' + a.last.error
      : 'last run ' + new Date(a.last.at).toLocaleString('en-IN') + ', freed ' + fmtBytes(a.last.results.reduce(function(s, x){ return s + (x.bytesFreed || 0); }, 0)))
      : 'not run yet since the server started';
    document.getElementById('diskAuto').textContent =
      'Daily auto-clean-up: ' + (a.enabled ? 'ON, runs once a day after ' + a.runsAfterIst + ' IST (' + last + ')' : 'OFF (Settings → Disk & Retention)')
      + '. Deleting is never allowed 09:00–15:30 IST on weekdays' + (d.blocked ? ' — blocked right now.' : '.')
      + ' Measured ' + new Date(d.report.at).toLocaleTimeString('en-IN') + '.';
    var html = '';
    _diskFolders = {};
    d.report.folders.forEach(function(x) {
      _diskFolders[x.key] = x;
      var range = x.oldest ? (x.oldest === x.newest ? x.oldest : x.oldest + ' → ' + x.newest) : 'no files';
      var keep;
      if (x.protected) keep = '<div class="dr-keep prot">🔒 Protected — never deleted automatically or from here.</div>';
      else if (x.key === 'pm2_logs') keep = '<div class="dr-keep">Auto: ' + (x.maxMB > 0 ? 'a log over ' + x.maxMB + ' MB is cut back to its last 2 MB' : 'off (no size limit set)') + '</div>';
      else keep = '<div class="dr-keep">Auto: ' + (x.keepDays > 0 ? 'keeps the last ' + x.keepDays + ' days' : 'off — nothing deleted automatically') + '</div>';
      var act = '';
      if (!x.protected) {
        var def = x.keepDays > 0 ? x.keepDays : Math.max(x.minKeep, 30);
        act = '<div class="dr-act"><label for="keep_' + x.key + '">Delete older than'
          + ' <input type="number" inputmode="numeric" id="keep_' + x.key + '" min="' + x.minKeep + '" max="3650" step="1" value="' + def + '"> days</label>'
          + '<button class="act-btn act-red" onclick="diskDelete(\\'' + x.key + '\\')">🗑 Delete…</button></div>';
      }
      html += '<div class="disk-row">'
        + '<div class="dr-top"><span class="dr-name">' + escH(x.label) + '</span><span class="dr-size">' + (x.exists ? fmtBytes(x.bytes) : '—') + '</span></div>'
        + '<div class="dr-meta">' + (x.exists ? x.files.toLocaleString('en-IN') + ' files · ' + escH(range) + (x.truncated ? ' · (partial count)' : '') : 'folder not created yet') + '</div>'
        + '<div class="dr-note">' + escH(x.note) + '</div>' + keep + act + '</div>';
    });
    document.getElementById('diskList').innerHTML = html;
  } catch (e) {
    document.getElementById('diskFree').textContent = 'Could not measure folders: ' + e.message;
  }
}

async function diskDelete(key) {
  var x = _diskFolders[key];
  if (!x) return;
  var days = parseInt(document.getElementById('keep_' + key).value, 10);
  if (!Number.isInteger(days) || days < x.minKeep || days > 3650) {
    await showAlert({ icon: '⚠️', title: 'Check the number of days', message: escH(x.label) + ': enter a whole number of days from ' + x.minKeep + ' to 3650.' });
    return;
  }
  var r = await secretFetch('/monitor/disk/preview?folder=' + encodeURIComponent(key) + '&days=' + days, { timeoutMs: 60000 });
  if (!r) return;
  var p = await r.json();
  if (!p.ok) { await showAlert({ icon: '⚠️', title: 'Cannot preview', message: escH(p.error || 'Preview failed') }); return; }
  if (!p.items) {
    await showAlert({ icon: '✅', title: 'Nothing to delete', message: escH(p.label) + ' has nothing dated before ' + p.cutoffDate + ' (older than ' + days + ' days).' });
    return;
  }
  var lines = p.sample.map(function(s){
    return s.date + '  ' + s.name + (s.files > 1 ? ' (' + s.files + ' files)' : '') + '  ' + fmtBytes(s.bytes) + (s.action === 'empty' ? '  [emptied, not removed]' : '');
  });
  if (p.items > p.sample.length) lines.push('…and ' + (p.items - p.sample.length) + ' more');
  var summary = p.files.toLocaleString('en-IN') + ' file(s), ' + fmtBytes(p.bytes);
  if (p.blocked) {
    await showAlert({ icon: '⏰', title: 'Blocked during market hours', message: 'This would delete ' + summary + ' from ' + escH(p.label) + ', but deleting is not allowed 09:00–15:30 IST on weekdays. Try again after 15:30.' });
    return;
  }
  if (p.backtestBusy) {
    await showAlert({ icon: '⏳', title: 'Backtest running', message: 'A backtest is reading ' + escH(p.label) + ' right now. Try again when it finishes.' });
    return;
  }
  var ok = await showDoubleConfirm({
    icon: '🗑', title: 'Delete from ' + escH(p.label) + '?',
    message: 'This will delete ' + summary + ' dated before ' + p.cutoffDate + '. Today and the last ' + days + ' days are kept.\\n\\n' + escH(lines.join('\\n')),
    confirmText: 'Delete ' + fmtBytes(p.bytes), confirmClass: 'modal-btn-danger',
    subject: escH(p.label) + ' · ' + summary, secondConfirmText: 'Yes, delete'
  });
  if (!ok) return;
  var r2 = await secretFetch('/monitor/action/disk-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: p.planId }), timeoutMs: 120000
  });
  if (!r2) return;
  var d2 = await r2.json();
  diskToast(d2.ok ? d2.message : (d2.error || 'Delete failed'), !!d2.ok);
  loadDisk(true);
  setTimeout(poll, 300);
}

loadDisk(false);
setInterval(function(){ if (!document.hidden) loadDisk(false); }, 60000);

poll();
// Background tabs skip the fetch; one catch-up refresh when the tab is shown again.
setInterval(function(){ if (!document.hidden) poll(); }, 5000);
document.addEventListener('visibilitychange', function(){ if (!document.hidden) poll(); });

${toastJS()}
<\/script>
</body></html>`);
});

// ── Action endpoints ────────────────────────────────────────────────────────
// Let the user reclaim memory without SSHing into the box.

router.post("/action/gc", (_req, res) => {
  const before = process.memoryUsage();
  if (typeof global.gc !== "function") {
    return res.status(400).json({ ok: false, error: "global.gc unavailable. Start Node with --expose-gc (see ecosystem.config.js)." });
  }
  try {
    global.gc();
    const after = process.memoryUsage();
    const freedMB = +((before.heapUsed - after.heapUsed) / 1048576).toFixed(1);
    res.json({
      ok: true,
      message: `GC freed ${freedMB} MB`,
      before: { heapUsed: +(before.heapUsed/1048576).toFixed(1), rss: +(before.rss/1048576).toFixed(1) },
      after:  { heapUsed: +(after.heapUsed/1048576).toFixed(1),  rss: +(after.rss/1048576).toFixed(1)  },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/action/prune-cache", (_req, res) => {
  try {
    const before = backtestCache.getCacheStats();
    // Force prune by calling the exposed function (reuses internal 90-day cutoff)
    if (typeof backtestCache.pruneOldCacheFiles === "function") {
      backtestCache.pruneOldCacheFiles();
    }
    const after = backtestCache.getCacheStats();
    const freedMB = +(parseFloat(before.sizeMB) - parseFloat(after.sizeMB)).toFixed(2);
    res.json({ ok: true, message: `Pruned backtest cache: ${freedMB} MB freed (${before.files}→${after.files} files)`, before, after });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/action/clear-cache-all", (_req, res) => {
  try {
    const removed = backtestCache.clearAllCache();
    res.json({ ok: true, message: `Cleared all ${removed} cached backtest files` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/action/clear-jobs", (_req, res) => {
  try {
    // Keep only the active running job; drop everything else from memory
    let removed = 0;
    if (typeof backtestJobs._purgeInactive === "function") {
      removed = backtestJobs._purgeInactive();
    }
    res.json({ ok: true, message: `Cleared ${removed} finished backtest jobs from memory` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/action/restart", (_req, res) => {
  // PM2 will relaunch the process; respond first so the client gets a success toast.
  res.json({ ok: true, message: "Restart triggered. Page will reconnect in ~5 seconds." });
  setTimeout(() => {
    exec("pm2 restart trading-bot", (err) => {
      // If pm2 isn't on PATH, log loudly instead of silently calling
      // process.exit(0) — a silent exit here would look identical to the
      // "no-log crash" we're trying to diagnose.
      if (err) console.error(`[MONITOR] pm2 restart failed: ${err.message}. Not exiting — restart manually via SSH.`);
    });
  }, 300);
});

// Deletes exactly the files of an earlier preview (each re-checked first), so the
// confirm dialog's count and size are what actually goes. Protected by API_SECRET
// like every /monitor/action/* route.
router.post("/action/disk-delete", async (req, res) => {
  try {
    const plan = diskRetention.takePlan(req.body && req.body.planId);
    if (!plan) return res.status(410).json({ ok: false, error: "That preview has expired. Press the delete button again to see a fresh list." });
    const def = diskRetention.folderByKey(plan.key);
    if (def && def.busyOnBacktest && !backtestJobs.isIdle()) {
      return res.status(409).json({ ok: false, error: "A backtest is running and reads this cache. Try again when it finishes." });
    }
    const r = await diskRetention.applyPlan(plan);
    if (!r.ok) return res.status(r.blocked ? 423 : 400).json({ ok: false, error: r.error });
    const mb = (r.bytesFreed / 1048576).toFixed(1);
    console.log(`[disk] ${plan.label}: deleted ${r.deleted.length} item(s) older than ${plan.keepDays}d (before ${plan.cutoffDate}), freed ${mb} MB${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`);
    res.json({
      ok: true,
      message: `${plan.label}: deleted ${r.deleted.length} item(s), freed ${mb} MB` + (r.skipped.length ? ` (${r.skipped.length} skipped, changed since the preview)` : ""),
      deleted: r.deleted.length, skipped: r.skipped.length, bytesFreed: r.bytesFreed,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;

/**
 * COMPARE — /compare
 * ─────────────────────────────────────────────────────────────────────────────
 * Side-by-side comparison of Paper Trade sessions vs Backtest results.
 *
 * Routes:
 *   GET /compare/trading   → Compare regular paper trades vs backtest
 *   GET /compare/scalping  → Compare scalp paper trades vs scalp backtest
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const { loadResult } = require("../utils/resultStore");
const { ACTIVE }     = require("../strategies");
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");

const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");

const inr = (n) => typeof n === "number" ? "\u20b9" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "\u2014";
const pnlColor = (n) => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";

// ── Load paper trade data ───────────────────────────────────────────────────
function loadPaperData(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return { capital: 100000, totalPnl: 0, sessions: [] };
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); }
  catch (_) { return { capital: 100000, totalPnl: 0, sessions: [] }; }
}

// ── Aggregate paper sessions into summary ───────────────────────────────────
function aggregatePaperSessions(sessions) {
  const allTrades = [];
  sessions.forEach(s => {
    if (s.trades && Array.isArray(s.trades)) {
      s.trades.forEach(t => allTrades.push(t));
    }
  });

  const wins   = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalPnl = allTrades.reduce((s, t) => s + (t.pnl || 0), 0);

  const avgWin  = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0)   / wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  // Max drawdown (equity curve)
  let equity = 0, peak = 0, maxDD = 0;
  allTrades.forEach(t => { equity += (t.pnl || 0); peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity); });

  const maxProfit = allTrades.length ? Math.max(...allTrades.map(t => t.pnl || 0)) : 0;
  const totalDrawdown = allTrades.length ? Math.min(...allTrades.map(t => t.pnl || 0)) : 0;

  return {
    totalTrades: allTrades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     allTrades.length ? parseFloat(((wins.length / allTrades.length) * 100).toFixed(1)) : 0,
    totalPnl:    parseFloat(totalPnl.toFixed(2)),
    avgWin:      parseFloat(avgWin.toFixed(2)),
    avgLoss:     parseFloat(avgLoss.toFixed(2)),
    maxProfit:   parseFloat(maxProfit.toFixed(2)),
    totalDrawdown: parseFloat(totalDrawdown.toFixed(2)),
    maxDrawdown: parseFloat(maxDD.toFixed(2)),
    trades:      allTrades,
    sessionCount: sessions.length,
  };
}

// ── Per-day aggregation helper ──────────────────────────────────────────────
function aggregateByDay(trades, dateExtractor) {
  const map = {};
  trades.forEach(t => {
    const d = dateExtractor(t);
    if (!d) return;
    if (!map[d]) map[d] = { date: d, trades: 0, wins: 0, losses: 0, pnl: 0 };
    map[d].trades++;
    if ((t.pnl || 0) > 0) map[d].wins++;
    else map[d].losses++;
    map[d].pnl += (t.pnl || 0);
  });
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Extract date from trade ─────────────────────────────────────────────────
function extractDate(t) {
  // Backtest trades: entryTime like "05/04/2025 09:18:00" or "2025-04-05 09:18"
  // Paper trades: entryTime like "09:18:00 IST" (date from session)
  if (t.entryTime) {
    // Try DD/MM/YYYY format
    const m1 = t.entryTime.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
    // Try YYYY-MM-DD format
    const m2 = t.entryTime.match(/(\d{4}-\d{2}-\d{2})/);
    if (m2) return m2[1];
  }
  // For paper trades that only have HH:MM:SS, use session date
  if (t._sessionDate) return t._sessionDate;
  return null;
}

// ── Shared CSS ──────────────────────────────────────────────────────────────
function pageCSS() {
  return `
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;min-height:100vh;}
    .page{padding:16px 20px 40px;}

    h1{font-size:1.2rem;font-weight:700;color:#e2e8f0;margin-bottom:4px;}
    .subtitle{font-size:0.72rem;color:#4a6080;margin-bottom:20px;}

    .compare-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;}
    @media(max-width:768px){.compare-grid{grid-template-columns:1fr;}}

    .panel{background:#08091a;border:0.5px solid #0e1428;border-radius:10px;padding:16px 18px;position:relative;overflow:hidden;}
    .panel::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
    .panel.paper::before{background:#3b82f6;}
    .panel.backtest::before{background:#f59e0b;}
    .panel-title{font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:14px;}
    .panel.paper .panel-title{color:#3b82f6;}
    .panel.backtest .panel-title{color:#f59e0b;}

    .metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
    .metric{background:#0a0c1a;border:0.5px solid #0e1428;border-radius:6px;padding:10px 12px;}
    .metric-label{font-size:0.52rem;text-transform:uppercase;letter-spacing:1px;color:#2a3c5a;margin-bottom:4px;}
    .metric-val{font-size:0.95rem;font-weight:700;color:#a0b8d8;}
    .metric-sub{font-size:0.58rem;color:#4a6080;margin-top:2px;}

    .diff-section{margin-bottom:24px;}
    .diff-title{font-size:0.8rem;font-weight:700;color:#e2e8f0;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid #0e1428;}

    .diff-table{width:100%;border-collapse:collapse;font-size:0.75rem;}
    .diff-table th{text-align:left;padding:8px 10px;color:#4a6080;font-weight:600;font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #0e1428;}
    .diff-table td{padding:8px 10px;border-bottom:1px solid #080a16;}
    .diff-table tr:hover{background:#0a0d1a;}
    .diff-table .better{color:#10b981;}
    .diff-table .worse{color:#ef4444;}
    .diff-table .neutral{color:#a0b8d8;}

    .day-table{width:100%;border-collapse:collapse;font-size:0.72rem;margin-top:12px;}
    .day-table th{text-align:left;padding:7px 8px;color:#4a6080;font-weight:600;font-size:0.55rem;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #0e1428;}
    .day-table td{padding:7px 8px;border-bottom:1px solid #080a16;}
    .day-table tr:hover{background:#0a0d1a;}

    .no-data{text-align:center;padding:40px;color:#4a6080;font-size:0.85rem;}
    .tag{display:inline-block;font-size:0.58rem;font-weight:600;padding:2px 7px;border-radius:4px;margin-left:6px;}
    .tag.paper{background:rgba(59,130,246,0.15);color:#3b82f6;border:1px solid rgba(59,130,246,0.3);}
    .tag.backtest{background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3);}

    .chart-wrap{background:#08091a;border:0.5px solid #0e1428;border-radius:10px;padding:16px;margin-bottom:24px;}
    .chart-title{font-size:0.7rem;font-weight:700;color:#e2e8f0;margin-bottom:10px;}
  `;
}

// ── Build comparison page ───────────────────────────────────────────────────
function buildComparePage(mode, paperSummary, backtestResult, activePage) {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const title = mode === "scalping" ? "Scalp: Paper vs Backtest" : "Trading: Paper vs Backtest";
  const bt = backtestResult ? backtestResult.summary : null;

  const p = paperSummary;

  // Metric comparison rows
  const metrics = [
    { label: "Total Trades",   paper: p.totalTrades,                     backtest: bt ? bt.totalTrades : null,     fmt: v => v },
    { label: "Wins",           paper: p.wins,                            backtest: bt ? bt.wins : null,            fmt: v => v },
    { label: "Losses",         paper: p.losses,                          backtest: bt ? bt.losses : null,          fmt: v => v },
    { label: "Win Rate",       paper: p.winRate,                         backtest: bt ? bt.winRate : null,         fmt: v => v + "%",  higherBetter: true },
    { label: "Total PnL",      paper: p.totalPnl,                        backtest: bt ? bt.totalPnl : null,       fmt: v => inr(v),   higherBetter: true },
    { label: "Avg Win",        paper: p.avgWin,                          backtest: bt ? bt.avgWin : null,          fmt: v => inr(v),   higherBetter: true },
    { label: "Avg Loss",       paper: p.avgLoss,                         backtest: bt ? bt.avgLoss : null,         fmt: v => inr(v),   higherBetter: false },
    { label: "Max Drawdown",   paper: p.maxDrawdown,                     backtest: bt ? bt.maxDrawdown : null,     fmt: v => inr(v),   higherBetter: false },
    { label: "Best Trade",     paper: p.maxProfit,                       backtest: bt ? bt.maxProfit : null,       fmt: v => inr(v),   higherBetter: true },
    { label: "Worst Trade",    paper: p.totalDrawdown,                   backtest: bt ? bt.totalDrawdown : null,   fmt: v => inr(v),   higherBetter: false },
  ];

  function diffCell(paper, backtest, higherBetter) {
    if (paper == null || backtest == null) return `<td class="neutral">\u2014</td>`;
    const diff = paper - backtest;
    if (Math.abs(diff) < 0.01) return `<td class="neutral">0</td>`;
    const isHigher = diff > 0;
    const cls = (higherBetter === undefined) ? "neutral" : ((isHigher === higherBetter) ? "better" : "worse");
    const arrow = diff > 0 ? "\u25B2" : "\u25BC";
    const val = typeof paper === "number" && Math.abs(paper) > 10 ? inr(Math.abs(diff)) : Math.abs(diff).toFixed(1);
    return `<td class="${cls}">${arrow} ${val}</td>`;
  }

  const metricsRows = metrics.map(m => {
    const pVal = m.paper != null ? m.fmt(m.paper) : "\u2014";
    const bVal = m.backtest != null ? m.fmt(m.backtest) : "\u2014";
    return `<tr>
      <td style="font-weight:600;">${m.label}</td>
      <td>${pVal}</td>
      <td>${bVal}</td>
      ${diffCell(m.paper, m.backtest, m.higherBetter)}
    </tr>`;
  }).join("");

  // Day-by-day comparison
  const paperTrades = (p.trades || []).map((t, i) => ({ ...t }));
  const backtestTrades = bt && backtestResult.trades ? [...backtestResult.trades] : [];

  // Tag paper trades with session dates for date extraction
  if (paperSummary._sessions) {
    let idx = 0;
    paperSummary._sessions.forEach(s => {
      if (s.trades) {
        s.trades.forEach(() => {
          if (idx < paperTrades.length) {
            paperTrades[idx]._sessionDate = s.date;
            idx++;
          }
        });
      }
    });
  }

  const paperDays   = aggregateByDay(paperTrades, extractDate);
  const backtestDays = aggregateByDay(backtestTrades, extractDate);

  // Merge days
  const allDates = new Set([...paperDays.map(d => d.date), ...backtestDays.map(d => d.date)]);
  const sortedDates = [...allDates].sort();
  const paperDayMap   = Object.fromEntries(paperDays.map(d => [d.date, d]));
  const backtestDayMap = Object.fromEntries(backtestDays.map(d => [d.date, d]));

  const dayRows = sortedDates.map(date => {
    const pd = paperDayMap[date]   || { trades: 0, wins: 0, losses: 0, pnl: 0 };
    const bd = backtestDayMap[date] || { trades: 0, wins: 0, losses: 0, pnl: 0 };
    const pnlDiff = pd.pnl - bd.pnl;
    const diffCls = pnlDiff > 0 ? "better" : pnlDiff < 0 ? "worse" : "neutral";
    return `<tr>
      <td>${date}</td>
      <td>${pd.trades}</td>
      <td style="color:${pnlColor(pd.pnl)};">${inr(pd.pnl)}</td>
      <td>${pd.wins}W/${pd.losses}L</td>
      <td>${bd.trades}</td>
      <td style="color:${pnlColor(bd.pnl)};">${inr(bd.pnl)}</td>
      <td>${bd.wins}W/${bd.losses}L</td>
      <td class="${diffCls}">${pnlDiff >= 0 ? "+" : ""}${inr(pnlDiff)}</td>
    </tr>`;
  }).join("");

  // Equity curve data for chart
  const paperEquity = [];
  let pEq = 0;
  paperTrades.forEach((t, i) => { pEq += (t.pnl || 0); paperEquity.push(pEq); });

  const btEquity = [];
  let bEq = 0;
  backtestTrades.forEach((t, i) => { bEq += (t.pnl || 0); btEquity.push(bEq); });

  const btParams = backtestResult && backtestResult.params
    ? `${backtestResult.params.from} to ${backtestResult.params.to} | ${backtestResult.params.resolution || "?"}m`
    : "No backtest params";

  const noBacktest = !bt;
  const noPaper = p.totalTrades === 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u2696</text></svg>">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <title>${title}</title>
  <style>
    ${pageCSS()}
    ${sidebarCSS()}
    ${modalCSS()}
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar(activePage, liveActive)}
<div class="main-content">
<div class="page">
  <h1>${title}</h1>
  <div class="subtitle">Paper sessions: ${p.sessionCount} | Backtest: ${btParams}</div>

  ${noBacktest && noPaper ? `<div class="no-data">No paper trades or backtest results found. Run a backtest and complete some paper trade sessions first.</div>` :
    noBacktest ? `<div class="no-data" style="margin-bottom:20px;padding:16px;border:1px solid #f59e0b33;border-radius:8px;color:#f59e0b;">No backtest results found. Run a backtest first to compare.</div>` :
    noPaper ? `<div class="no-data" style="margin-bottom:20px;padding:16px;border:1px solid #3b82f633;border-radius:8px;color:#3b82f6;">No paper trade sessions found. Complete some paper sessions first to compare.</div>` : ""}

  <!-- Side-by-side summary panels -->
  <div class="compare-grid">
    <div class="panel paper">
      <div class="panel-title">Paper Trade</div>
      <div class="metric-grid">
        <div class="metric"><div class="metric-label">Total Trades</div><div class="metric-val">${p.totalTrades}</div><div class="metric-sub">${p.wins}W \u00b7 ${p.losses}L</div></div>
        <div class="metric"><div class="metric-label">Win Rate</div><div class="metric-val">${p.winRate}%</div></div>
        <div class="metric"><div class="metric-label">Total PnL</div><div class="metric-val" style="color:${pnlColor(p.totalPnl)};">${inr(p.totalPnl)}</div></div>
        <div class="metric"><div class="metric-label">Max Drawdown</div><div class="metric-val" style="color:#ef4444;">${inr(p.maxDrawdown)}</div></div>
        <div class="metric"><div class="metric-label">Avg Win</div><div class="metric-val" style="color:#10b981;">${inr(p.avgWin)}</div></div>
        <div class="metric"><div class="metric-label">Avg Loss</div><div class="metric-val" style="color:#ef4444;">${inr(p.avgLoss)}</div></div>
      </div>
    </div>

    <div class="panel backtest">
      <div class="panel-title">Backtest</div>
      ${bt ? `<div class="metric-grid">
        <div class="metric"><div class="metric-label">Total Trades</div><div class="metric-val">${bt.totalTrades}</div><div class="metric-sub">${bt.wins}W \u00b7 ${bt.losses}L</div></div>
        <div class="metric"><div class="metric-label">Win Rate</div><div class="metric-val">${bt.winRate}%</div></div>
        <div class="metric"><div class="metric-label">Total PnL</div><div class="metric-val" style="color:${pnlColor(bt.totalPnl)};">${inr(bt.totalPnl)}</div></div>
        <div class="metric"><div class="metric-label">Max Drawdown</div><div class="metric-val" style="color:#ef4444;">${inr(bt.maxDrawdown)}</div></div>
        <div class="metric"><div class="metric-label">Avg Win</div><div class="metric-val" style="color:#10b981;">${inr(bt.avgWin)}</div></div>
        <div class="metric"><div class="metric-label">Avg Loss</div><div class="metric-val" style="color:#ef4444;">${inr(bt.avgLoss)}</div></div>
      </div>` : `<div class="no-data" style="padding:20px;">No backtest data</div>`}
    </div>
  </div>

  <!-- Metric-by-metric comparison table -->
  <div class="diff-section">
    <div class="diff-title">Metric Comparison</div>
    <table class="diff-table">
      <thead>
        <tr>
          <th>Metric</th>
          <th>Paper <span class="tag paper">P</span></th>
          <th>Backtest <span class="tag backtest">B</span></th>
          <th>Diff (P \u2212 B)</th>
        </tr>
      </thead>
      <tbody>
        ${metricsRows}
      </tbody>
    </table>
  </div>

  <!-- Equity curve chart -->
  ${(paperEquity.length > 0 || btEquity.length > 0) ? `
  <div class="chart-wrap">
    <div class="chart-title">Equity Curve Comparison</div>
    <canvas id="equityChart" height="220"></canvas>
  </div>` : ""}

  <!-- Day-by-day comparison -->
  ${sortedDates.length > 0 ? `
  <div class="diff-section">
    <div class="diff-title">Day-by-Day Comparison</div>
    <div style="overflow-x:auto;">
    <table class="day-table">
      <thead>
        <tr>
          <th>Date</th>
          <th colspan="3" style="text-align:center;color:#3b82f6;">Paper</th>
          <th colspan="3" style="text-align:center;color:#f59e0b;">Backtest</th>
          <th>PnL Diff</th>
        </tr>
        <tr>
          <th></th>
          <th>Trades</th><th>PnL</th><th>W/L</th>
          <th>Trades</th><th>PnL</th><th>W/L</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${dayRows}
      </tbody>
    </table>
    </div>
  </div>` : ""}

</div>
</div>
</div>

<script>
${modalJS()}

// Equity chart
${(paperEquity.length > 0 || btEquity.length > 0) ? `
(function(){
  const paperData   = ${JSON.stringify(paperEquity)};
  const btData      = ${JSON.stringify(btEquity)};
  const maxLen      = Math.max(paperData.length, btData.length);
  const labels      = Array.from({length: maxLen}, (_, i) => i + 1);

  const ctx = document.getElementById('equityChart').getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Paper Trade',
          data: paperData,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.08)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'Backtest',
          data: btData,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.08)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#a0b8d8', font: { family: "'IBM Plex Mono', monospace", size: 11 } } },
        tooltip: {
          backgroundColor: '#0d1320',
          borderColor: '#1e3050',
          borderWidth: 1,
          titleColor: '#e2e8f0',
          bodyColor: '#a0b8d8',
          callbacks: {
            label: function(ctx) {
              return ctx.dataset.label + ': \\u20b9' + (ctx.parsed.y || 0).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
            }
          }
        }
      },
      scales: (function(){
        var _lt = document.documentElement.getAttribute('data-theme') === 'light';
        var _gc = _lt ? '#e0e4ea' : '#0a0e1a';
        var _tc = _lt ? '#64748b' : '#2a3c5a';
        var _lc = _lt ? '#64748b' : '#4a6080';
        return {
        x: {
          title: { display: true, text: 'Trade #', color: _lc, font: { size: 10 } },
          ticks: { color: _tc, font: { size: 9 } },
          grid: { color: _gc },
        },
        y: {
          title: { display: true, text: 'Cumulative PnL (\\u20b9)', color: _lc, font: { size: 10 } },
          ticks: { color: _tc, font: { size: 9 }, callback: v => '\\u20b9' + v.toLocaleString('en-IN') },
          grid: { color: _gc },
        }};
      })()
      }
    }
  });
})();` : ""}
</script>
</body>
</html>`;
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// GET /compare/trading
router.get("/trading", (req, res) => {
  const paperData = loadPaperData("paper_trades.json");
  const backtestResult = loadResult(ACTIVE);

  const paperSummary = aggregatePaperSessions(paperData.sessions || []);
  paperSummary._sessions = paperData.sessions || [];

  res.setHeader("Content-Type", "text/html");
  res.send(buildComparePage("trading", paperSummary, backtestResult, "compare"));
});

// GET /compare/scalping
router.get("/scalping", (req, res) => {
  const paperData = loadPaperData("scalp_paper_trades.json");
  const backtestResult = loadResult("SCALP_BACKTEST");

  const paperSummary = aggregatePaperSessions(paperData.sessions || []);
  paperSummary._sessions = paperData.sessions || [];

  res.setHeader("Content-Type", "text/html");
  res.send(buildComparePage("scalping", paperSummary, backtestResult, "scalpCompare"));
});

module.exports = router;

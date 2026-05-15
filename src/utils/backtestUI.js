/**
 * backtestUI.js — Shared full-featured backtest results page renderer.
 * ─────────────────────────────────────────────────────────────────────────────
 * Used by orbBacktest + straddleBacktest to render a results page with the
 * same shape as scalpBacktest/swingBacktest: sticky breadcrumb, run-bar with
 * date pickers + split-by-year/month, preset rows (week/month/year + each
 * year + each month), 14-card stat grid, cumulative P&L chart, equity /
 * monthly / drawdown / hourly analytics, day-wise toggle, filterable +
 * sortable trades table with pagination + per-trade detail modal.
 *
 * Strategy-specific bits (extra stat cards, extra table columns) are passed
 * as config so this file stays mode-agnostic.
 *
 * Usage:
 *   const { renderBacktestForm, renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
 *   ...
 *   const stats = computeBacktestStats(trades);
 *   res.send(renderBacktestResults({
 *     mode: "ORB", accent: "#10b981", strategyName: "ORB_15MIN",
 *     endpoint: "/orb-backtest", from, to, summary: stats, trades,
 *     extraTradeColumns: [{ key: "rangePts", label: "Range" }, ...],
 *     extraTopRowStats: [{ label: "OR Range Avg", value: "..." }],
 *     activePage: "orbBacktest",
 *   }));
 */

const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("./sharedNav");
const sharedSocketState = require("./sharedSocketState");

// ── Stats computer ──────────────────────────────────────────────────────────
/**
 * trade fields: { entry, exit, ePrice, xPrice, sl, side, pnl, entryReason, reason, entryTs, exitTs, spotPts? }
 */
function computeBacktestStats(trades) {
  const wins = trades.filter(t => (t.pnl || 0) > 0);
  const losses = trades.filter(t => (t.pnl || 0) < 0);
  const totalPnl = trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  // Sequential drawdown
  let eq = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    eq += (t.pnl || 0);
    if (eq > peak) peak = eq;
    const dd = eq - peak;
    if (dd < maxDD) maxDD = dd;
  }
  const winRate = trades.length ? ((wins.length / trades.length) * 100).toFixed(1) : "0.0";
  const avgWin  = wins.length   ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const maxProfit = wins.length ? Math.max(...wins.map(t => t.pnl)) : 0;
  const maxLoss   = losses.length ? Math.min(...losses.map(t => t.pnl)) : 0;
  const profitFactor = grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? Infinity : 0);
  const expectancy = trades.length ? parseFloat((totalPnl / trades.length).toFixed(2)) : 0;
  const recoveryFactor = maxDD < 0 ? parseFloat((totalPnl / Math.abs(maxDD)).toFixed(2)) : 0;
  const riskReward = avgLoss !== 0 ? `1 : ${(avgWin / Math.abs(avgLoss)).toFixed(2)}` : "—";

  // Daily Sharpe approximation
  const dayMap = {};
  for (const t of trades) {
    const d = (t.entry || "").split(",")[0].trim();
    if (!dayMap[d]) dayMap[d] = 0;
    dayMap[d] += (t.pnl || 0);
  }
  const dayPnls = Object.values(dayMap);
  const mean = dayPnls.length ? dayPnls.reduce((a, b) => a + b, 0) / dayPnls.length : 0;
  const variance = dayPnls.length ? dayPnls.reduce((a, b) => a + (b - mean) ** 2, 0) / dayPnls.length : 0;
  const std = Math.sqrt(variance);
  const sharpeRatio = std > 0 ? parseFloat(((mean / std) * Math.sqrt(252)).toFixed(2)) : 0;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat(winRate),
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    grossProfit: parseFloat(grossProfit.toFixed(2)),
    grossLoss: parseFloat(grossLoss.toFixed(2)),
    maxProfit: parseFloat(maxProfit.toFixed(2)),
    maxLoss: parseFloat(maxLoss.toFixed(2)),
    maxDrawdown: parseFloat(maxDD.toFixed(2)),
    totalDrawdown: parseFloat((-grossLoss).toFixed(2)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    riskReward,
    profitFactor: profitFactor === Infinity ? Infinity : parseFloat(profitFactor.toFixed(2)),
    expectancy,
    recoveryFactor,
    sharpeRatio,
  };
}

// ── Page renderer ───────────────────────────────────────────────────────────

function renderBacktestResults(opts) {
  const {
    mode = "ORB",
    accent = "#10b981",
    strategyName = "Strategy",
    endpoint = "/orb-backtest",   // path used by Run/preset form submission
    from, to,
    summary: s,
    trades,
    extraStats = [],          // [{ label, value, color, sub }]
    extraTradeColumns = [],   // [{ key, label, render?: function (t) { return string } }]
    activePage = "orbBacktest",
    notes = "",
  } = opts;

  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  // Embed trades safely
  const tradesJSON = JSON.stringify(trades).replace(/<\/script>/gi, "<\\/script>");

  // Build extra trade columns header + cell JS
  const extraTHs = extraTradeColumns.map(c => `<th>${c.label}</th>`).join("");
  // Provide a serializable JS function for extra column rendering — we'll
  // build the cell HTML inline in the client by reading fields from each
  // trade row, so just pass the key list.
  const extraKeys = JSON.stringify(extraTradeColumns.map(c => ({ key: c.key, label: c.label })));

  const fmt = n => n != null ? Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  const fmtPnl = n => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const pnlColor = n => n > 0 ? "#10b981" : n < 0 ? "#ef4444" : "#4a6080";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
${faviconLink()}
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<title>${mode} Backtest — ${strategyName}</title>
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;min-height:100vh;}
.page{padding:16px 20px 40px;}
.main-content{flex:1;margin-left:200px;}
@media(max-width:900px){.main-content{margin-left:0;}}
.stat-grid,.stat-grid-2{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;margin-bottom:16px;}
@media(max-width:900px){.stat-grid,.stat-grid-2{grid-template-columns:repeat(3,1fr);}}
@media(max-width:640px){.stat-grid,.stat-grid-2{grid-template-columns:1fr 1fr;}}
.sc{background:#08091a;border:0.5px solid #0e1428;border-radius:7px;padding:12px 14px;position:relative;overflow:hidden;}
.sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
.sc.blue::before{background:#3b82f6;}.sc.green::before{background:#10b981;}.sc.red::before{background:#ef4444;}.sc.yellow::before{background:#f59e0b;}.sc.purple::before{background:#8b5cf6;}.sc.orange::before{background:#f97316;}.sc.cyan::before{background:#06b6d4;}.sc.pink::before{background:#ec4899;}
.sc-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.2px;color:#1e3050;margin-bottom:5px;}
.sc-val{font-size:1.05rem;font-weight:700;color:#a0b8d8;line-height:1.2;}
.sc-sub{font-size:0.6rem;color:#4a6080;margin-top:3px;}
.run-bar{display:flex;align-items:flex-end;gap:10px;background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:11px 14px;margin-bottom:14px;flex-wrap:wrap;}
.run-bar label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;display:block;margin-bottom:3px;}
.run-bar input{background:#fff;border:1px solid #1e3a8a;color:#0f172a;padding:5px 8px;border-radius:5px;font-size:0.75rem;font-family:inherit;cursor:pointer;color-scheme:light;}
.run-btn{background:${accent};color:#040c18;border:1px solid ${accent};padding:6px 14px;border-radius:5px;font-size:0.7rem;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;}
.run-btn:hover{filter:brightness(1.15);}
.preset-btn{font-size:0.65rem;padding:3px 10px;border-radius:4px;background:rgba(59,130,246,0.08);color:#60a5fa;border:0.5px solid rgba(59,130,246,0.2);cursor:pointer;font-family:inherit;transition:all 0.15s;}
.preset-btn:hover{background:rgba(59,130,246,0.18);}
.preset-row{display:flex;gap:6px;margin:0 0 6px;flex-wrap:wrap;align-items:center;}

.tbar{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;}
.tbar input,.tbar select{background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:5px 9px;border-radius:6px;font-size:0.76rem;font-family:inherit;}
.tbar input:focus,.tbar select:focus{outline:none;border-color:${accent};}
.tbar-label{color:#4a6080;font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:1px;}
.tbar-count{color:#4a6080;font-size:0.7rem;}
.dw-toggle{background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:${accent};font-size:0.85rem;}
.dw-toggle:hover{border-color:${accent};background:#0a1e3d;}
.dw-toggle.active{background:#0a1e3d;border-color:${accent};}
.copy-btn{background:#0d1320;border:1px solid #1a2236;color:${accent};padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;white-space:nowrap;}
.copy-btn:hover{background:#0a1e3d;border-color:${accent};}
.copy-btn.copied{background:#064e3b;border-color:#10b981;color:#10b981;}

.tw{border:0.5px solid #0e1428;border-radius:8px;overflow:hidden;margin-bottom:10px;}
table{width:100%;border-collapse:collapse;}
thead th{background:#04060e;padding:7px 10px;text-align:left;font-size:0.58rem;text-transform:uppercase;letter-spacing:0.8px;color:#1e3050;cursor:pointer;user-select:none;white-space:nowrap;}
thead th:hover{color:#c8d8f0;}
thead th.sorted{color:${accent};}
tbody tr{border-top:0.5px solid #080e1a;}
tbody tr:hover{background:#060c1a;}
tbody td{padding:6px 10px;font-size:0.72rem;color:#4a6080;}

.pag{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:14px;}
.pag button{background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 9px;border-radius:5px;font-size:0.72rem;cursor:pointer;font-family:inherit;}
.pag button:hover{border-color:${accent};color:${accent};}
.pag button.active{background:#0a1e3d;border-color:${accent};color:${accent};font-weight:700;}
.pag button:disabled{opacity:.3;cursor:default;}
.pag-info{font-size:0.7rem;color:#4a6080;padding:0 4px;}

#tooltip{position:fixed;z-index:9999;background:#1e293b;color:#e2e8f0;border:1px solid ${accent};border-radius:7px;padding:8px 12px;font-size:0.72rem;max-width:340px;word-break:break-word;box-shadow:0 8px 24px rgba(0,0,0,.7);pointer-events:none;display:none;line-height:1.5;font-family:sans-serif;}

.ana-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
@media(max-width:900px){.ana-row{grid-template-columns:1fr;}}
.ana-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;}
@media(max-width:900px){.ana-row3{grid-template-columns:1fr;}}
.ana-card{background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:14px 16px;position:relative;}
.ana-card h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:10px;}
.ana-chart-wrap{position:relative;height:220px;}
.ana-mini{background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:12px 14px;}
.ana-mini h3{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:8px;}
.ana-tbl{width:100%;border-collapse:collapse;}
.ana-tbl th{text-align:left;font-size:0.55rem;text-transform:uppercase;letter-spacing:0.8px;color:#1e3050;padding:5px 8px;border-bottom:0.5px solid #0e1428;}
.ana-tbl td{padding:5px 8px;font-size:0.72rem;color:#4a6080;border-bottom:0.5px solid #060a14;}
.ana-tbl tr:hover{background:#060c1a;}
.ana-stat{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;}
.ana-stat-val{font-size:1rem;font-weight:700;}
.ana-stat-label{font-size:0.62rem;color:#3a5070;}

.dw-table{width:100%;border-collapse:collapse;}
.dw-table thead th{background:#04060e;padding:7px 10px;text-align:left;font-size:0.58rem;text-transform:uppercase;letter-spacing:0.8px;color:#1e3050;}
.dw-table tbody tr{border-top:0.5px solid #080e1a;}
.dw-table tbody tr:hover{background:#060c1a;}
.dw-table tbody td{padding:6px 10px;font-size:0.72rem;color:#4a6080;}
.dw-table tfoot td{padding:8px 10px;font-size:0.72rem;font-weight:700;border-top:1px solid #1a2236;background:#04060e;}

${sidebarCSS()}
${modalCSS()}

:root[data-theme="light"] body{background:#f5f6fa;color:#1e293b;}
:root[data-theme="light"] .sc{background:#ffffff;border-color:#e0e4ea;}
:root[data-theme="light"] .sc-val{color:#1e293b;}
:root[data-theme="light"] .sc-label,:root[data-theme="light"] .sc-sub{color:#94a3b8;}
:root[data-theme="light"] .run-bar,:root[data-theme="light"] .ana-card,:root[data-theme="light"] .ana-mini,:root[data-theme="light"] .tw{background:#ffffff;border-color:#e0e4ea;}
:root[data-theme="light"] thead th{background:#f1f5f9;color:#64748b;}
:root[data-theme="light"] tbody td,:root[data-theme="light"] .dw-table tbody td{color:#475569;}
</style>
</head>
<body>
<div class="app-shell">
${buildSidebar(activePage, liveActive)}
<div class="main-content">
<div class="page">

<!-- Breadcrumb -->
<div style="background:#06090e;border-bottom:0.5px solid #0e1428;padding:6px 20px;display:flex;align-items:center;gap:7px;margin:-16px -20px 14px;position:sticky;top:0;z-index:90;">
  <span style="font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;background:${accent}22;color:${accent};border:0.5px solid ${accent}55;text-transform:uppercase;letter-spacing:0.5px;">${mode} BACKTEST</span>
  <span style="color:#1e2a40;font-size:10px;">›</span>
  <span style="font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;background:rgba(16,185,129,0.1);color:#34d399;border:0.5px solid rgba(16,185,129,0.2);text-transform:uppercase;">${strategyName}</span>
  <span style="color:#1e2a40;font-size:10px;">›</span>
  <span style="font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;background:rgba(245,158,11,0.1);color:#fbbf24;border:0.5px solid rgba(245,158,11,0.2);">${from} → ${to}</span>
  <span style="margin-left:auto;font-size:0.6rem;color:#1e2a40;">${trades.length.toLocaleString()} trades · 5-min</span>
</div>

<!-- Run-bar -->
<div class="run-bar">
  <div><label>From</label><input type="date" id="f" value="${from}"/></div>
  <div><label>To</label><input type="date" id="t" value="${to}"/></div>
  <div style="display:flex;align-items:center;gap:5px;"><input type="checkbox" id="splitYears" style="accent-color:${accent};cursor:pointer;" onchange="if(this.checked)document.getElementById('splitMonths').checked=false;"/><label for="splitYears" style="font-size:0.65rem;color:#4a6080;cursor:pointer;white-space:nowrap;">Split by years</label></div>
  <div style="display:flex;align-items:center;gap:5px;"><input type="checkbox" id="splitMonths" style="accent-color:#f59e0b;cursor:pointer;" onchange="if(this.checked)document.getElementById('splitYears').checked=false;"/><label for="splitMonths" style="font-size:0.65rem;color:#4a6080;cursor:pointer;white-space:nowrap;">Split by months</label></div>
  <button class="run-btn" id="runBtn">🔄 Run Again</button>
  <span style="font-size:0.7rem;color:#4a6080;margin-left:auto;">Strategy: <strong style="color:${accent};">${strategyName}</strong></span>
</div>

<!-- Preset rows -->
<div class="preset-row">
  <button class="preset-btn" onclick="setPreset('thisWeek')">This week</button>
  <button class="preset-btn" onclick="setPreset('lastWeek')">Last week</button>
  <button class="preset-btn" onclick="setPreset('thisMonth')">This month</button>
  <button class="preset-btn" onclick="setPreset('lastMonth')">Last month</button>
  <button class="preset-btn" onclick="setPreset('last3')">Last 3 months</button>
  <button class="preset-btn" onclick="setPreset('last6')">Last 6 months</button>
  <button class="preset-btn" onclick="setPreset('thisYear')">This year</button>
  <button class="preset-btn" onclick="setPreset('lastYear')">Last year</button>
</div>
<div class="preset-row">
  <button class="preset-btn" onclick="setPreset('last2y')">Last 2 yr</button>
  <button class="preset-btn" onclick="setPreset('last3y')">Last 3 yr</button>
  <button class="preset-btn" onclick="setPreset('last5y')">Last 5 yr</button>
</div>
<div class="preset-row">
  ${(() => { const cy = new Date().getFullYear(); return Array.from({ length: 6 }, (_, i) => cy - i).map(yr => `<button class="preset-btn" onclick="setPreset('y${yr}')">${yr}</button>`).join(""); })()}
</div>
<div class="preset-row">
  <span style="font-size:0.6rem;color:#94a3b8;">${new Date().getFullYear()}</span>
  ${(() => { const mths = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]; const labels = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; const curMonth = new Date().getMonth(); return mths.map((k, i) => i <= curMonth ? `<button class="preset-btn" onclick="setPreset('${k}')">${labels[i]}</button>` : `<button class="preset-btn" disabled style="opacity:0.3;cursor:not-allowed">${labels[i]}</button>`).join(""); })()}
</div>
${notes ? `<div style="background:#1a1800;border:1px solid #3a3000;border-radius:8px;padding:10px 16px;margin:10px 0 14px;font-size:0.72rem;color:#b8a040;">${notes}</div>` : ""}

<!-- Stat grid row 1 -->
<div class="stat-grid">
  <div class="sc blue"><div class="sc-label">Total Trades</div><div class="sc-val">${s.totalTrades}</div><div class="sc-sub">${s.wins}W · ${s.losses}L</div></div>
  <div class="sc green"><div class="sc-label">Max Profit</div><div class="sc-val" style="color:#10b981;">${fmtPnl(s.maxProfit)}</div><div class="sc-sub">Best single trade</div></div>
  <div class="sc ${s.totalPnl >= 0 ? "green" : "red"}"><div class="sc-label">Total PnL</div><div class="sc-val" style="color:${pnlColor(s.totalPnl)};">${fmtPnl(s.totalPnl)}</div><div class="sc-sub">Sim: δ + θ approximation</div></div>
  <div class="sc red"><div class="sc-label">Max Drawdown</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.maxDrawdown)}</div><div class="sc-sub">Worst peak-to-trough</div></div>
  <div class="sc red"><div class="sc-label">Gross Loss</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(-s.grossLoss)}</div><div class="sc-sub">Sum of losing trades</div></div>
  <div class="sc purple"><div class="sc-label">Risk/Reward</div><div class="sc-val">${s.riskReward}</div><div class="sc-sub">1 : avg win ÷ avg loss</div></div>
  <div class="sc yellow"><div class="sc-label">Win Rate</div><div class="sc-val">${s.winRate}%</div><div class="sc-sub">${s.wins} of ${s.totalTrades}</div></div>
</div>
<!-- Stat grid row 2 -->
<div class="stat-grid-2">
  <div class="sc orange"><div class="sc-label">Profit Factor</div><div class="sc-val" style="color:${s.profitFactor >= 1.5 ? "#10b981" : s.profitFactor >= 1 ? "#f59e0b" : "#ef4444"};">${s.profitFactor === Infinity ? "∞" : s.profitFactor}</div><div class="sc-sub">Gross P ${fmtPnl(s.grossProfit)} / L ${fmtPnl(s.grossLoss)}</div></div>
  <div class="sc cyan"><div class="sc-label">Expectancy</div><div class="sc-val" style="color:${pnlColor(s.expectancy)};">${fmtPnl(s.expectancy)}</div><div class="sc-sub">Avg P&L per trade</div></div>
  <div class="sc red"><div class="sc-label">Max Loss</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.maxLoss)}</div><div class="sc-sub">Worst single trade</div></div>
  <div class="sc green"><div class="sc-label">Avg Win</div><div class="sc-val" style="color:#10b981;">${fmtPnl(s.avgWin)}</div><div class="sc-sub">${s.wins} winning trades</div></div>
  <div class="sc red"><div class="sc-label">Avg Loss</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.avgLoss)}</div><div class="sc-sub">${s.losses} losing trades</div></div>
  <div class="sc blue"><div class="sc-label">Recovery Factor</div><div class="sc-val" style="color:${s.recoveryFactor >= 2 ? "#10b981" : s.recoveryFactor >= 1 ? "#f59e0b" : "#ef4444"};">${s.recoveryFactor}</div><div class="sc-sub">PnL ÷ Max DD</div></div>
  <div class="sc purple"><div class="sc-label">Sharpe Ratio</div><div class="sc-val" style="color:${s.sharpeRatio >= 1 ? "#10b981" : s.sharpeRatio >= 0.5 ? "#f59e0b" : "#ef4444"};">${s.sharpeRatio}</div><div class="sc-sub">Annualized (daily)</div></div>
</div>

${extraStats.length ? `<div class="stat-grid">${extraStats.map(e => `<div class="sc pink"><div class="sc-label">${e.label}</div><div class="sc-val" style="color:${e.color || "#a0b8d8"};">${e.value}</div><div class="sc-sub">${e.sub || ""}</div></div>`).join("")}</div>` : ""}

<!-- Day-wise toggle -->
<div id="dayWiseWrap" style="display:none;margin-bottom:16px;">
  <div class="tw">
    <table class="dw-table">
      <thead><tr><th>Date</th><th>Trades</th><th>Wins</th><th>Losses</th><th>Day P&L</th><th>Cumulative P&L</th></tr></thead>
      <tbody id="dwBody"></tbody>
    </table>
  </div>
</div>

<!-- Analytics -->
<div id="anaWrap" style="display:none;margin-bottom:16px;">
  <div class="ana-row">
    <div class="ana-card"><h3>📈 Equity Curve</h3><div class="ana-chart-wrap"><canvas id="anaEquity"></canvas></div></div>
    <div class="ana-card"><h3>📊 Monthly P&L</h3><div class="ana-chart-wrap"><canvas id="anaMonthly"></canvas></div></div>
  </div>
  <div class="ana-row">
    <div class="ana-card"><h3>📉 Drawdown</h3><div class="ana-chart-wrap"><canvas id="anaDrawdown"></canvas></div></div>
    <div class="ana-card"><h3>⏰ Hourly Performance</h3><div class="ana-chart-wrap"><canvas id="anaHourly"></canvas></div></div>
  </div>
  <div class="ana-row3">
    <div class="ana-mini"><h3>🔥 Streaks &amp; Days</h3><div id="anaStreaks"></div></div>
    <div class="ana-mini"><h3>🚪 Exit Reason Breakdown</h3><div style="overflow-x:auto;max-height:300px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Count</th><th>P&L</th><th>Avg</th></tr></thead><tbody id="anaExitBody"></tbody></table></div></div>
    <div class="ana-mini"><h3>📅 Day of Week</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Day</th><th>Trades</th><th>WR%</th><th>P&L</th></tr></thead><tbody id="anaDowBody"></tbody></table></div></div>
  </div>
</div>

<!-- Filter bar -->
<div class="tbar">
  <span class="tbar-label">Trade Log</span>
  <button id="dwToggle" class="dw-toggle" onclick="toggleDayWise()">👁 Day P&L</button>
  <button id="anaToggle" class="dw-toggle" onclick="toggleAnalytics()">📊 Analytics</button>
  <input id="fSearch" placeholder="Search reason…" oninput="doFilter()" style="width:150px;"/>
  <select id="fSide" onchange="doFilter()"><option value="">All Sides</option><option value="CE">CE only</option><option value="PE">PE only</option><option value="STRADDLE">Straddle only</option></select>
  <select id="fResult" onchange="doFilter()"><option value="">All Results</option><option value="win">Wins only</option><option value="loss">Losses only</option></select>
  <select id="fPP" onchange="doFilter()"><option value="5">5/page</option><option value="10" selected>10/page</option><option value="25">25/page</option><option value="9999">All</option></select>
  <span class="tbar-count" id="cntLabel"></span>
  <button class="copy-btn" onclick="copyTradeLog(this)" style="margin-left:auto;">📋 Copy Trade Log</button>
  <button onclick="doReset()" style="background:#0d1320;border:1px solid #1a2236;color:#4a6080;padding:4px 10px;border-radius:6px;font-size:0.7rem;cursor:pointer;font-family:inherit;">Reset</button>
</div>

<!-- Table -->
<div class="tw">
  <table>
    <thead><tr>
      <th onclick="doSort('side')" id="h-side">Side ▼</th>
      <th onclick="doSort('entry')" id="h-entry" class="sorted">Date ▼</th>
      <th>Entry Time</th>
      <th onclick="doSort('ePrice')" id="h-ePrice">Entry Spot</th>
      <th>Exit Time</th>
      <th onclick="doSort('xPrice')" id="h-xPrice">Exit Spot</th>
      <th onclick="doSort('sl')" id="h-sl">SL</th>
      ${extraTHs}
      <th onclick="doSort('pnl')" id="h-pnl">PnL</th>
      <th>Entry Reason</th>
      <th>Exit Reason</th>
      <th style="text-align:center;">Action</th>
    </tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>
<div class="pag" id="pagBar"></div>
<div id="tooltip"></div>

<!-- Trade Detail Modal -->
<div id="btModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
  <div style="background:#0d1320;border:1px solid #1d3b6e;border-radius:16px;padding:24px 28px;max-width:680px;width:100%;max-height:90vh;overflow-y:auto;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
      <div><span id="btm-badge" style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:4px 10px;border-radius:6px;"></span><span style="font-size:0.65rem;color:#4a6080;margin-left:10px;">${mode} Backtest — Full Details</span></div>
      <button onclick="document.getElementById('btModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:#4a6080;font-size:1rem;cursor:pointer;padding:4px 10px;border-radius:6px;">✕ Close</button>
    </div>
    <div id="btm-grid"></div>
  </div>
</div>

</div></div></div>

<script id="trades-data" type="application/json">${tradesJSON}</script>
<script>
${modalJS()}
var ACCENT = '${accent}';
var ENDPOINT = '${endpoint}';
var EXTRA_COLS = ${extraKeys};
var MODE_LABEL = '${mode}';

var TRADES = JSON.parse(document.getElementById('trades-data').textContent);
var filtered = TRADES.slice();
var sortCol = 'entry', sortDir = -1, pg = 1, pp = 10;

function fmt(n){ return n!=null ? Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; }
function fmtAna(n){ var s = n>=0?'+':'−'; return s + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN'); }
function fpts(n){ if(n==null) return '—'; var s = n>=0?'+':'−'; return s+'₹'+Math.round(Math.abs(n)).toLocaleString('en-IN'); }
function fmtDate(dt){ if(!dt) return '—'; var p=dt.split(', '); var d=(p[0]||'').split('/'); if(d.length===3) return d[0].padStart(2,'0')+'/'+d[1].padStart(2,'0')+'/'+d[2]; return p[0]||'—'; }
function fmtTime(dt){ if(!dt) return '—'; var p=dt.split(', '); return p[1]||'—'; }

// ── Run button ─────────────────────────────────────────────────────────────
document.getElementById('runBtn').onclick = function(){
  var f=document.getElementById('f').value, t=document.getElementById('t').value;
  if(!f || !t){ alert('Set both From and To dates'); return; }
  if(document.getElementById('splitYears').checked){
    var fy=parseInt(f.split('-')[0]), ty=parseInt(t.split('-')[0]);
    for(var y=fy;y<=ty;y++){
      var yf=(y===fy)?f:y+'-01-01', yt=(y===ty)?t:y+'-12-31';
      window.open(ENDPOINT+'?from='+yf+'&to='+yt,'_blank');
    }
  } else if(document.getElementById('splitMonths').checked){
    var fd=new Date(f), td=new Date(t);
    var cm=fd.getFullYear()*12+fd.getMonth(), em=td.getFullYear()*12+td.getMonth();
    for(var m=cm;m<=em;m++){
      var yr=Math.floor(m/12), mo=m%12;
      var mf=(m===cm)?f:yr+'-'+String(mo+1).padStart(2,'0')+'-01';
      var last=new Date(yr,mo+1,0);
      var mt=(m===em)?t:yr+'-'+String(mo+1).padStart(2,'0')+'-'+String(last.getDate()).padStart(2,'0');
      window.open(ENDPOINT+'?from='+mf+'&to='+mt,'_blank');
    }
  } else {
    window.location = ENDPOINT+'?from='+f+'&to='+t;
  }
};

function setPreset(p){
  var d=new Date(),y=d.getFullYear(),m=d.getMonth(),day=d.getDay();
  function fmtD(dt){var yy=dt.getFullYear(),mm=String(dt.getMonth()+1).padStart(2,'0'),dd=String(dt.getDate()).padStart(2,'0');return yy+'-'+mm+'-'+dd;}
  var today=fmtD(d);
  var monday=new Date(d); monday.setDate(d.getDate()-(day===0?6:day-1));
  var lastWeekMon=new Date(monday); lastWeekMon.setDate(lastWeekMon.getDate()-7);
  var lastWeekFri=new Date(lastWeekMon); lastWeekFri.setDate(lastWeekFri.getDate()+4);
  var monthMap={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  if(monthMap.hasOwnProperty(p)){var mi=monthMap[p];var endD=fmtD(new Date(y,mi+1,0));document.getElementById('f').value=fmtD(new Date(y,mi,1));document.getElementById('t').value=mi<m?endD:(mi===m?today:endD);return;}
  if(/^y\\d{4}$/.test(p)){var yr=parseInt(p.slice(1));document.getElementById('f').value=yr+'-01-01';document.getElementById('t').value=(yr===y)?today:(yr+'-12-31');return;}
  var presets={
    thisWeek:[fmtD(monday),today], lastWeek:[fmtD(lastWeekMon),fmtD(lastWeekFri)],
    thisMonth:[fmtD(new Date(y,m,1)),today], lastMonth:[fmtD(new Date(y,m-1,1)),fmtD(new Date(y,m,0))],
    last3:[fmtD(new Date(y,m-2,1)),today], last6:[fmtD(new Date(y,m-5,1)),today],
    thisYear:[fmtD(new Date(y,0,1)),today], lastYear:[fmtD(new Date(y-1,0,1)),fmtD(new Date(y-1,11,31))],
    last2y:[fmtD(new Date(y-2,0,1)),today], last3y:[fmtD(new Date(y-3,0,1)),today], last5y:[fmtD(new Date(y-5,0,1)),today]
  };
  document.getElementById('f').value=presets[p][0];
  document.getElementById('t').value=presets[p][1];
}

// ── Filter / Sort / Render ──────────────────────────────────────────────────
function doFilter(){
  var s=document.getElementById('fSearch').value.toLowerCase();
  var side=document.getElementById('fSide').value;
  var res=document.getElementById('fResult').value;
  pp=parseInt(document.getElementById('fPP').value);
  pg=1;
  filtered=TRADES.filter(function(t){
    if(side && t.side!==side) return false;
    if(res==='win'  && (t.pnl==null||t.pnl<=0)) return false;
    if(res==='loss' && (t.pnl==null||t.pnl>=0)) return false;
    if(s && ((t.reason||'').toLowerCase().indexOf(s)<0)) return false;
    return true;
  });
  doSort2();
}
function doSort(col){
  if(sortCol===col){ sortDir*=-1; } else { sortCol=col; sortDir=-1; }
  document.querySelectorAll('thead th').forEach(function(th){ th.classList.remove('sorted'); th.innerHTML=th.innerHTML.replace(/ [▼▲]$/,''); });
  var h=document.getElementById('h-'+col);
  if(h){ h.classList.add('sorted'); h.innerHTML=h.innerHTML.replace(/ [▼▲]$/,'')+(sortDir===-1?' ▼':' ▲'); }
  doSort2();
}
function doSort2(){
  var sortKey = sortCol === 'entry' ? 'entryTs' : sortCol === 'exit' ? 'exitTs' : sortCol;
  filtered.sort(function(a,b){
    var av=a[sortKey], bv=b[sortKey];
    if(av==null) av=sortDir===-1?-1e18:1e18;
    if(bv==null) bv=sortDir===-1?-1e18:1e18;
    if(typeof av==='string') return av<bv?-sortDir:av>bv?sortDir:0;
    return (av-bv)*sortDir;
  });
  render();
}

function render(){
  var start=(pg-1)*pp, slice=filtered.slice(start,start+pp);
  var tbody=document.getElementById('tbody');
  document.getElementById('cntLabel').textContent=filtered.length+' of '+TRADES.length+' trades';
  if(slice.length===0){
    tbody.innerHTML='<tr><td colspan="'+(11+EXTRA_COLS.length)+'" style="text-align:center;padding:20px;color:#4a6080;">No trades match filters.</td></tr>';
    document.getElementById('pagBar').innerHTML='';
    return;
  }
  window._btSlice = slice;
  var rows='';
  for(var i=0;i<slice.length;i++){
    var t=slice[i];
    var sc=t.side==='CE'?'#10b981':t.side==='PE'?'#ef4444':'#ec4899';
    var pc=t.pnl==null?'#c8d8f0':t.pnl>0?'#10b981':t.pnl<0?'#ef4444':'#c8d8f0';
    var sr=(t.reason||'').length>25?t.reason.substring(0,25)+'…':(t.reason||'');
    var ser=t.entryReason?(t.entryReason.length>25?t.entryReason.substring(0,25)+'…':t.entryReason):'—';
    var extraCells = '';
    for(var k=0;k<EXTRA_COLS.length;k++){
      var col=EXTRA_COLS[k];
      var val=t[col.key];
      if(val==null) val='—';
      extraCells += '<td style="color:#94a3b8;">'+val+'</td>';
    }
    rows+='<tr>'
      +'<td style="color:'+sc+';font-weight:700;">'+t.side+'</td>'
      +'<td style="font-size:0.75rem;">'+fmtDate(t.entry)+'</td>'
      +'<td style="font-size:0.75rem;">'+fmtTime(t.entry)+'</td>'
      +'<td>'+fmt(t.ePrice)+'</td>'
      +'<td style="font-size:0.75rem;">'+fmtTime(t.exit)+'</td>'
      +'<td>'+fmt(t.xPrice)+'</td>'
      +'<td style="color:#f59e0b;">'+(t.sl!=null?fmt(t.sl):'—')+'</td>'
      + extraCells
      +'<td style="color:'+pc+';font-weight:700;">'+fpts(t.pnl)+'</td>'
      +'<td style="font-size:0.7rem;color:#4a6080;cursor:default;" data-ereason="'+(t.entryReason||'').replace(/"/g,'&quot;')+'">'+ser+'</td>'
      +'<td style="font-size:0.7rem;color:#4a6080;cursor:default;" data-reason="'+(t.reason||'').replace(/"/g,'&quot;')+'">'+sr+'</td>'
      +'<td style="text-align:center;padding:6px 8px;"><button data-idx="'+i+'" class="bt-eye-btn" style="background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:'+ACCENT+';font-size:0.85rem;">👁</button></td>'
      +'</tr>';
  }
  tbody.innerHTML=rows;
  Array.from(tbody.querySelectorAll('.bt-eye-btn')).forEach(function(btn){
    btn.addEventListener('click',function(){ showBTModal(window._btSlice[parseInt(this.getAttribute('data-idx'))]); });
  });
  Array.from(tbody.querySelectorAll('td[data-reason],td[data-ereason]')).forEach(function(td){
    td.addEventListener('mouseenter',function(e){ var v=td.getAttribute('data-reason')||td.getAttribute('data-ereason'); if(!v) return; var tip=document.getElementById('tooltip'); tip.textContent=v; tip.style.display='block'; moveTip(e); });
    td.addEventListener('mouseleave',function(){ document.getElementById('tooltip').style.display='none'; });
    td.addEventListener('mousemove',moveTip);
  });
  renderPag();
}
function moveTip(e){ var tip=document.getElementById('tooltip'); var x=e.clientX+14, y=e.clientY+14; if(x+360>window.innerWidth) x=e.clientX-360; if(y+80>window.innerHeight) y=e.clientY-60; tip.style.left=x+'px'; tip.style.top=y+'px'; }
function renderPag(){
  var total=Math.ceil(filtered.length/pp);
  var bar=document.getElementById('pagBar');
  if(total<=1){ bar.innerHTML=''; return; }
  var h='<button onclick="goPg('+(pg-1)+')" '+(pg===1?'disabled':'')+'>← Prev</button>';
  h+='<span class="pag-info">Page '+pg+' of '+total+'</span>';
  var s=Math.max(1,pg-2), e=Math.min(total,pg+2);
  for(var p=s;p<=e;p++) h+='<button onclick="goPg('+p+')" class="'+(p===pg?'active':'')+'">'+p+'</button>';
  h+='<button onclick="goPg('+(pg+1)+')" '+(pg===total?'disabled':'')+'>Next →</button>';
  bar.innerHTML=h;
}
function goPg(p){ var total=Math.ceil(filtered.length/pp); pg=Math.max(1,Math.min(total,p)); render(); window.scrollTo({top:0,behavior:'smooth'}); }
function doReset(){
  document.getElementById('fSearch').value=''; document.getElementById('fSide').value=''; document.getElementById('fResult').value=''; document.getElementById('fPP').value='10';
  document.querySelectorAll('thead th').forEach(function(th){ th.classList.remove('sorted'); });
  var h=document.getElementById('h-entry'); if(h) h.classList.add('sorted');
  sortCol='entry'; sortDir=-1; pp=10; pg=1;
  filtered=TRADES.slice(); doSort2();
}

function showBTModal(t){
  var modal=document.getElementById('btModal');
  var badge=document.getElementById('btm-badge');
  var grid=document.getElementById('btm-grid');
  var sc=t.side==='CE'?'rgba(16,185,129,0.18)':t.side==='PE'?'rgba(239,68,68,0.18)':'rgba(236,72,153,0.18)';
  var col=t.side==='CE'?'#10b981':t.side==='PE'?'#ef4444':'#ec4899';
  badge.style.background=sc; badge.style.color=col;
  badge.textContent=t.side+' · '+fmtDate(t.entry);
  function row(k,v,c){ return '<tr><td style="padding:6px 10px;color:#4a6080;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.8px;">'+k+'</td><td style="padding:6px 10px;color:'+(c||'#c8d8f0')+';font-size:0.78rem;font-weight:600;">'+v+'</td></tr>'; }
  var h='<table style="width:100%;border-collapse:collapse;">';
  h+=row('Entry Time', t.entry || '—');
  h+=row('Exit Time', t.exit || '—');
  h+=row('Side', t.side, col);
  h+=row('Entry Spot', fmt(t.ePrice));
  h+=row('Exit Spot', fmt(t.xPrice));
  h+=row('Stop Loss', t.sl!=null?fmt(t.sl):'—');
  for(var k=0;k<EXTRA_COLS.length;k++){
    var ec=EXTRA_COLS[k]; h += row(ec.label, t[ec.key]!=null ? t[ec.key] : '—');
  }
  h+=row('P&L', fpts(t.pnl), t.pnl>=0?'#10b981':'#ef4444');
  h+='<tr><td style="padding:8px 10px;color:#4a6080;font-size:0.7rem;text-transform:uppercase;vertical-align:top;">Entry Reason</td><td style="padding:8px 10px;color:#c8d8f0;font-size:0.75rem;white-space:pre-wrap;line-height:1.5;">'+(t.entryReason||'—')+'</td></tr>';
  h+='<tr><td style="padding:8px 10px;color:#4a6080;font-size:0.7rem;text-transform:uppercase;vertical-align:top;">Exit Reason</td><td style="padding:8px 10px;color:#c8d8f0;font-size:0.75rem;white-space:pre-wrap;line-height:1.5;">'+(t.reason||'—')+'</td></tr>';
  h+='</table>';
  grid.innerHTML=h;
  modal.style.display='flex';
}

function copyTradeLog(btn){
  var lines = ['Date,Entry Time,Exit Time,Side,EntrySpot,ExitSpot,SL,'+EXTRA_COLS.map(function(c){return c.label;}).join(',')+',PnL,Entry Reason,Exit Reason'];
  filtered.forEach(function(t){
    var extras = EXTRA_COLS.map(function(c){ return JSON.stringify(t[c.key]||''); }).join(',');
    lines.push([fmtDate(t.entry), fmtTime(t.entry), fmtTime(t.exit), t.side, t.ePrice, t.xPrice, t.sl, extras, t.pnl, JSON.stringify(t.entryReason||''), JSON.stringify(t.reason||'')].join(','));
  });
  navigator.clipboard.writeText(lines.join('\\n')).then(function(){
    btn.classList.add('copied'); btn.textContent='✓ Copied'; setTimeout(function(){ btn.classList.remove('copied'); btn.textContent='📋 Copy Trade Log'; },1500);
  });
}

// ── Day-wise ─────────────────────────────────────────────────────────────
var dwVisible = false;
function toggleDayWise(){ dwVisible=!dwVisible; document.getElementById('dayWiseWrap').style.display=dwVisible?'block':'none'; document.getElementById('dwToggle').classList.toggle('active',dwVisible); if(dwVisible) renderDayWise(); }
function renderDayWise(){
  var dayMap={};
  filtered.forEach(function(t){ var d=(t.entry||'').split(',')[0].trim(); if(!dayMap[d]) dayMap[d]={date:d,ts:t.entryTs,trades:0,wins:0,losses:0,pnl:0}; dayMap[d].trades++; if(t.pnl>0) dayMap[d].wins++; else if(t.pnl<0) dayMap[d].losses++; dayMap[d].pnl+=(t.pnl||0); });
  var days=Object.values(dayMap).sort(function(a,b){ return a.ts-b.ts; });
  var cum=0;
  var rows='';
  days.forEach(function(d){ cum+=d.pnl; var pc=d.pnl>=0?'#10b981':'#ef4444'; var cc=cum>=0?'#10b981':'#ef4444'; rows+='<tr><td>'+d.date+'</td><td>'+d.trades+'</td><td style="color:#10b981;">'+d.wins+'</td><td style="color:#ef4444;">'+d.losses+'</td><td style="color:'+pc+';font-weight:700;">'+fpts(d.pnl)+'</td><td style="color:'+cc+';font-weight:700;">'+fpts(cum)+'</td></tr>'; });
  document.getElementById('dwBody').innerHTML = rows || '<tr><td colspan="6" style="text-align:center;color:#4a6080;padding:18px;">No days in this range</td></tr>';
}

// ── Analytics ────────────────────────────────────────────────────────────
var anaVisible=false, anaCharts={};
function toggleAnalytics(){ anaVisible=!anaVisible; document.getElementById('anaWrap').style.display=anaVisible?'block':'none'; document.getElementById('anaToggle').classList.toggle('active',anaVisible); if(anaVisible) renderAnalytics(); }
function renderAnalytics(){
  var trades=filtered.slice();
  if(!trades.length){ Object.keys(anaCharts).forEach(function(k){ if(anaCharts[k]) anaCharts[k].destroy(); anaCharts[k]=null; }); document.getElementById('anaStreaks').innerHTML='<div class="ana-stat-label">No trades</div>'; document.getElementById('anaExitBody').innerHTML=''; document.getElementById('anaDowBody').innerHTML=''; return; }
  var _gc='#0e1428', _tc='#3a5070';
  // Equity
  var cum=[], labels=[], eq=0;
  trades.forEach(function(t,i){ eq+=(t.pnl||0); cum.push(eq); labels.push(i+1); });
  if(anaCharts.eq) anaCharts.eq.destroy();
  anaCharts.eq = new Chart(document.getElementById('anaEquity'),{ type:'line', data:{ labels:labels, datasets:[{ data:cum, borderColor:ACCENT, borderWidth:1.5, backgroundColor:ACCENT+'22', fill:true, pointRadius:0, tension:0.3 }] }, options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}}}} });
  // Monthly
  var mm={};
  trades.forEach(function(t){ var p=(t.entry||'').split(',')[0].trim().split('/'); if(p.length<3) return; var k=p[2]+'-'+p[1].padStart(2,'0'); mm[k]=(mm[k]||0)+(t.pnl||0); });
  var mkeys=Object.keys(mm).sort();
  var mlabels=mkeys.map(function(k){ var p=k.split('-'); var mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return mn[parseInt(p[1])]+" '"+p[0].slice(2); });
  var mvals=mkeys.map(function(k){ return Math.round(mm[k]); });
  var mcols=mvals.map(function(v){ return v>=0?'#10b981':'#ef4444'; });
  if(anaCharts.mo) anaCharts.mo.destroy();
  anaCharts.mo = new Chart(document.getElementById('anaMonthly'),{ type:'bar', data:{ labels:mlabels, datasets:[{ data:mvals, backgroundColor:mcols, borderRadius:4, barPercentage:0.7 }] }, options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:_tc,font:{size:10}}},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}}}} });
  // DD
  var eqA=[], peak=0, dd=[];
  var eq2=0;
  trades.forEach(function(t){ eq2+=(t.pnl||0); eqA.push(eq2); if(eq2>peak) peak=eq2; dd.push(eq2-peak); });
  if(anaCharts.dd) anaCharts.dd.destroy();
  anaCharts.dd = new Chart(document.getElementById('anaDrawdown'),{ type:'line', data:{ labels:labels, datasets:[{ data:dd, borderColor:'#ef4444', borderWidth:1.5, backgroundColor:'rgba(239,68,68,0.12)', fill:true, pointRadius:0, tension:0.3 }] }, options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}}}} });
  // Hourly
  var hm={};
  trades.forEach(function(t){ var hM=(t.entry||'').match(/(\\d{1,2}):\\d{2}:\\d{2}$/); if(!hM){ var hM2=(t.entry||'').match(/(\\d{1,2}):\\d{2}$/); if(!hM2) return; var h2=parseInt(hM2[1]); if(!hm[h2]) hm[h2]={pnl:0,cnt:0,wins:0}; hm[h2].pnl+=(t.pnl||0); hm[h2].cnt++; if(t.pnl>0) hm[h2].wins++; return; } var h=parseInt(hM[1]); if(!hm[h]) hm[h]={pnl:0,cnt:0,wins:0}; hm[h].pnl+=(t.pnl||0); hm[h].cnt++; if(t.pnl>0) hm[h].wins++; });
  var hours=Object.keys(hm).map(Number).sort(function(a,b){return a-b;});
  if(anaCharts.hr) anaCharts.hr.destroy();
  anaCharts.hr = new Chart(document.getElementById('anaHourly'),{ type:'bar', data:{ labels:hours.map(function(h){return h+':00';}), datasets:[{ data:hours.map(function(h){return Math.round(hm[h].pnl);}), backgroundColor:hours.map(function(h){return hm[h].pnl>=0?'rgba(16,185,129,0.7)':'rgba(239,68,68,0.7)';}), borderRadius:4, barPercentage:0.7 }] }, options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:_tc,font:{size:10}}},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10}}}}} });
  // Streaks
  var maxWS=0,maxLS=0,curWS=0,curLS=0;
  trades.forEach(function(t){ if(t.pnl>0){ curWS++; curLS=0; if(curWS>maxWS) maxWS=curWS; } else if(t.pnl<0){ curLS++; curWS=0; if(curLS>maxLS) maxLS=curLS; } });
  var dayMap={};
  trades.forEach(function(t){ var d=(t.entry||'').split(',')[0].trim(); if(!dayMap[d]) dayMap[d]=0; dayMap[d]+=(t.pnl||0); });
  var profDays=0,lossDays=0;
  Object.values(dayMap).forEach(function(v){ if(v>=0) profDays++; else lossDays++; });
  var totalDays=Math.max(1,profDays+lossDays);
  document.getElementById('anaStreaks').innerHTML =
    '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+maxWS+'</span><span class="ana-stat-label">Best win streak</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+maxLS+'</span><span class="ana-stat-label">Worst loss streak</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+profDays+'</span><span class="ana-stat-label">Profitable days ('+((profDays/totalDays)*100).toFixed(0)+'%)</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+lossDays+'</span><span class="ana-stat-label">Losing days ('+((lossDays/totalDays)*100).toFixed(0)+'%)</span></div>';
  // Exit reasons
  var rm={};
  trades.forEach(function(t){ var r=t.reason||'Unknown'; if(!rm[r]) rm[r]={cnt:0,pnl:0}; rm[r].cnt++; rm[r].pnl+=(t.pnl||0); });
  var reasons=Object.keys(rm).sort(function(a,b){ return rm[b].pnl-rm[a].pnl; });
  document.getElementById('anaExitBody').innerHTML = reasons.map(function(r){ var d=rm[r]; var pc=d.pnl>=0?'#10b981':'#ef4444'; return '<tr><td style="color:#c8d8f0;">'+r+'</td><td>'+d.cnt+'</td><td style="color:'+pc+';font-weight:700;">'+fmtAna(d.pnl)+'</td><td style="color:'+pc+';">'+fmtAna(Math.round(d.pnl/d.cnt))+'</td></tr>'; }).join('') || '<tr><td colspan="4" style="text-align:center;color:#4a6080;padding:18px;">No data</td></tr>';
  // Day of week
  var dow={};
  trades.forEach(function(t){ var p=(t.entry||'').split(',')[0].trim().split('/'); if(p.length<3) return; var dt=new Date(p[2],parseInt(p[1])-1,p[0]); var d=dt.getDay(); if(!dow[d]) dow[d]={cnt:0,wins:0,pnl:0}; dow[d].cnt++; if(t.pnl>0) dow[d].wins++; dow[d].pnl+=(t.pnl||0); });
  var dowNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  document.getElementById('anaDowBody').innerHTML = [1,2,3,4,5].map(function(d){ var x=dow[d]; if(!x) return '<tr><td>'+dowNames[d]+'</td><td>0</td><td>—</td><td>—</td></tr>'; var wr=((x.wins/x.cnt)*100).toFixed(0); var pc=x.pnl>=0?'#10b981':'#ef4444'; return '<tr><td>'+dowNames[d]+'</td><td>'+x.cnt+'</td><td>'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAna(x.pnl)+'</td></tr>'; }).join('');
}

doSort('entry');
</script>
</body>
</html>`;
}

module.exports = { computeBacktestStats, renderBacktestResults };

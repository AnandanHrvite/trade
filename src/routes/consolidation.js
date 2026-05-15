/**
 * CONSOLIDATION — /consolidation
 * ─────────────────────────────────────────────────────────────────────────────
 * Aggregated, cross-mode trade history + analytics (Swing / Scalp / Price Action).
 * Reads the three paper-trade JSON files, flattens every trade with its mode
 * + date, and renders a single unified view with:
 *   • Daily / Monthly / Yearly P&L roll-ups
 *   • Filters (mode, side, date range, search)
 *   • Per-trade copy + bulk copy (daily / weekly / monthly)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, toastJS } = require("../utils/sharedNav");

const _HOME = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");

const SOURCES = [
  { mode: "SWING", file: path.join(DATA_DIR, "paper_trades.json"),       color: "#3b82f6" },
  { mode: "SCALP", file: path.join(DATA_DIR, "scalp_paper_trades.json"), color: "#f59e0b" },
  { mode: "PA",    file: path.join(DATA_DIR, "pa_paper_trades.json"),    color: "#a855f7" },
];

function safeRead(p) {
  try {
    if (!fs.existsSync(p)) return { capital: 0, totalPnl: 0, sessions: [] };
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) {
    return { capital: 0, totalPnl: 0, sessions: [] };
  }
}

function loadAllTrades() {
  const out = [];
  for (const src of SOURCES) {
    const data = safeRead(src.file);
    for (const s of (data.sessions || [])) {
      const rawDate = s.date || "";
      const sessionDate = rawDate.slice(0, 10);
      for (const t of (s.trades || [])) {
        out.push({
          mode:        src.mode,
          date:        sessionDate,
          strategy:    s.strategy || "",
          instrument:  s.instrument || "NIFTY",
          side:        t.side || "",
          symbol:      t.symbol || "",
          qty:         t.qty || 0,
          entryPrice:  t.entryPrice,
          exitPrice:   t.exitPrice,
          spotAtEntry: t.spotAtEntry,
          spotAtExit:  t.spotAtExit,
          optionEntryLtp: t.optionEntryLtp,
          optionExitLtp:  t.optionExitLtp,
          entryTime:   t.entryTime || "",
          exitTime:    t.exitTime || "",
          pnl:         Number(t.pnl) || 0,
          pnlMode:     t.pnlMode || "",
          entryReason: t.entryReason || "",
          exitReason:  t.exitReason || "",
          optionStrike: t.optionStrike,
          optionType:  t.optionType || t.side || "",
          optionExpiry: t.optionExpiry || "",
        });
      }
    }
  }
  // Sort oldest → newest so cumulative curves read left-to-right
  out.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  return out;
}

router.get("/", (req, res) => {
  const trades = loadAllTrades();

  const modeCounts = { SWING: 0, SCALP: 0, PA: 0 };
  let totalPnl = 0, wins = 0, losses = 0;
  for (const t of trades) {
    modeCounts[t.mode] = (modeCounts[t.mode] || 0) + 1;
    totalPnl += t.pnl;
    if (t.pnl > 0) wins++;
    else if (t.pnl < 0) losses++;
  }
  const total   = trades.length;
  const winRate = total ? ((wins / total) * 100).toFixed(1) : "0.0";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>ௐ Palani Andawar Thunai ॐ — Consolidation</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    ${modalCSS()}
    .main-content{flex:1;margin-left:200px;padding:18px 22px 40px;min-height:100vh;}
    @media(max-width:900px){.main-content{margin-left:0;padding:14px;}}
    .page-title{font-size:1.1rem;font-weight:700;color:#e0eaf8;margin-bottom:2px;}
    .page-sub{font-size:0.72rem;color:#4a6080;margin-bottom:14px;}
    .stat-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:16px;}
    @media(max-width:1100px){.stat-grid{grid-template-columns:repeat(3,1fr);}}
    @media(max-width:560px){.stat-grid{grid-template-columns:repeat(2,1fr);}}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent,#3b82f6);}
    .sc-label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:5px;font-family:'IBM Plex Mono',monospace;}
    .sc-val{font-size:1.15rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#e0eaf8;}
    .sc-sub{font-size:0.6rem;color:#4a6080;margin-top:3px;}

    .panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
    .panel h3{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.4px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}

    .tbar{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;margin-bottom:12px;flex-wrap:wrap;}
    .tbar label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:#3a5070;font-family:'IBM Plex Mono',monospace;}
    .tbar input,.tbar select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:6px 10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;outline:none;}
    .tbar input:focus,.tbar select:focus{border-color:#3b82f6;}
    .btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:6px 12px;border-radius:6px;font-size:0.7rem;cursor:pointer;font-family:inherit;transition:all 0.15s;}
    .btn:hover{background:#0a1e3d;border-color:#3b82f6;}
    .btn.copied{background:#064e3b!important;border-color:#10b981!important;color:#10b981!important;}
    .btn.warn{border-color:rgba(239,68,68,0.3);color:#ef4444;}
    .btn.warn:hover{background:rgba(239,68,68,0.08);}

    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .tbl th{padding:8px 10px;text-align:left;font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;position:sticky;top:0;}
    .tbl th.sortable{cursor:pointer;user-select:none;}
    .tbl th.sortable:hover{color:#4a9cf5;}
    .tbl th.sortable::after{content:'⇅';margin-left:4px;opacity:0.35;font-size:0.7rem;}
    .tbl th.sorted-asc::after{content:'↑';opacity:1;color:#3b82f6;}
    .tbl th.sorted-desc::after{content:'↓';opacity:1;color:#3b82f6;}
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;vertical-align:middle;}
    .tbl tr:hover td{background:rgba(59,130,246,0.04);}
    .tbl-wrap{overflow-x:auto;max-height:560px;overflow-y:auto;border:0.5px solid #0e1e36;border-radius:10px;}

    .pager{display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap;font-family:'IBM Plex Mono',monospace;font-size:0.66rem;color:#4a6080;}
    .pager label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1px;color:#3a5070;}
    .pager select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:3px 6px;border-radius:5px;font-family:inherit;font-size:0.66rem;outline:none;cursor:pointer;}
    .pager select:focus{border-color:#3b82f6;}
    .pager-info{margin:0 4px;color:#4a6080;}
    .pager-btn{padding:3px 8px;font-size:0.72rem;line-height:1;min-width:26px;}
    .pager-btn:disabled{opacity:0.35;cursor:not-allowed;}
    :root[data-theme="light"] .pager label{color:#64748b!important;}
    :root[data-theme="light"] .pager select{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .pager,:root[data-theme="light"] .pager-info{color:#64748b!important;}
    .badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:0.6rem;font-weight:700;}
    .badge-ce{background:rgba(16,185,129,0.12);color:#10b981;border:0.5px solid rgba(16,185,129,0.25);}
    .badge-pe{background:rgba(239,68,68,0.12);color:#ef4444;border:0.5px solid rgba(239,68,68,0.25);}
    .badge-mode{padding:2px 7px;border-radius:4px;font-size:0.58rem;font-weight:700;letter-spacing:0.5px;}
    .badge-SWING{background:rgba(59,130,246,0.12);color:#3b82f6;border:0.5px solid rgba(59,130,246,0.3);}
    .badge-SCALP{background:rgba(245,158,11,0.12);color:#f59e0b;border:0.5px solid rgba(245,158,11,0.3);}
    .badge-PA{background:rgba(168,85,247,0.12);color:#a855f7;border:0.5px solid rgba(168,85,247,0.3);}

    .roll-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;}
    @media(max-width:1100px){.roll-grid{grid-template-columns:1fr;}}
    .chart-wrap{position:relative;height:240px;}
    .empty{text-align:center;padding:40px 20px;color:#4a6080;font-size:0.8rem;}

    /* ── Analytics panel (parity with paper-history pages) ───────────────── */
    .ana-panel{margin-bottom:14px;}
    .ana-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
    @media(max-width:900px){.ana-row{grid-template-columns:1fr;}}
    .ana-card{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;position:relative;}
    .ana-card h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
    .ana-chart-wrap{position:relative;height:220px;}
    .ana-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;}
    @media(max-width:900px){.ana-row3{grid-template-columns:1fr;}}
    .ana-mini{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;}
    .ana-mini h3{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:8px;font-family:'IBM Plex Mono',monospace;}
    .ana-tbl{width:100%;border-collapse:collapse;}
    .ana-tbl th{text-align:left;font-size:0.55rem;text-transform:uppercase;letter-spacing:0.8px;color:#1e3050;padding:5px 8px;border-bottom:0.5px solid #0e1e36;font-family:'IBM Plex Mono',monospace;}
    .ana-tbl td{padding:5px 8px;font-size:0.72rem;font-family:'IBM Plex Mono',monospace;color:#c8d8f0;border-bottom:0.5px solid #060d18;}
    .ana-tbl tr:hover td{background:rgba(59,130,246,0.04);}
    .ana-stat{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;}
    .ana-stat-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
    .ana-stat-label{font-size:0.62rem;color:#3a5070;}
    .ana-section-title{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.5px;color:#ef4444;font-weight:700;margin:16px 0 12px;padding-top:12px;border-top:0.5px solid #0e1e36;font-family:'IBM Plex Mono',monospace;}
    .ana-section-title.gain{color:#10b981;}
    .ana-section-title.cross{color:#a855f7;}

    /* Per-table filter bar + sortable headers + pager */
    .ana-tbl-bar{display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;}
    .ana-tbl-filter{flex:1;min-width:120px;background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:4px 8px;border-radius:5px;font-family:'IBM Plex Mono',monospace;font-size:0.66rem;outline:none;}
    .ana-tbl-filter:focus{border-color:#3b82f6;}
    .ana-tbl-count{font-size:0.55rem;color:#3a5070;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:0.6px;}
    .ana-sortable{cursor:pointer;user-select:none;white-space:nowrap;}
    .ana-sortable::after{content:'⇅';margin-left:3px;opacity:0.35;font-size:0.65rem;}
    .ana-sortable:hover{color:#4a9cf5;}
    .ana-sortable.ana-sorted-asc::after{content:'↑';opacity:1;color:#3b82f6;}
    .ana-sortable.ana-sorted-desc::after{content:'↓';opacity:1;color:#3b82f6;}
    .ana-tbl-pager{display:flex;align-items:center;gap:5px;margin-top:6px;flex-wrap:wrap;font-family:'IBM Plex Mono',monospace;font-size:0.6rem;color:#3a5070;}
    .ana-tbl-pager label{font-size:0.55rem;text-transform:uppercase;letter-spacing:0.6px;color:#3a5070;}
    .ana-tbl-pager select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:2px 5px;border-radius:4px;font-family:inherit;font-size:0.62rem;outline:none;cursor:pointer;}
    .ana-tbl-pager select:focus{border-color:#3b82f6;}
    .ana-tbl-pager-info{margin:0 4px;}
    .ana-tbl-pager .btn{padding:2px 6px;min-width:22px;font-size:0.68rem;line-height:1;}
    .ana-tbl-pager .btn:disabled{opacity:0.35;cursor:not-allowed;}

    /* Light theme overrides for new controls */
    :root[data-theme="light"] .ana-tbl-filter{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .ana-tbl-count,
    :root[data-theme="light"] .ana-tbl-pager,
    :root[data-theme="light"] .ana-tbl-pager label{color:#64748b!important;}
    :root[data-theme="light"] .ana-tbl-pager select{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}

    /* Light theme overrides for analytics */
    :root[data-theme="light"] .ana-card,
    :root[data-theme="light"] .ana-mini{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .ana-card h3,
    :root[data-theme="light"] .ana-mini h3{color:#64748b!important;}
    :root[data-theme="light"] .ana-tbl th{color:#64748b!important;border-bottom-color:#e0e4ea!important;background:#f1f5f9!important;}
    :root[data-theme="light"] .ana-tbl td{color:#334155!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .ana-tbl tr:hover td{background:rgba(59,130,246,0.05)!important;}
    :root[data-theme="light"] .ana-stat-label{color:#64748b!important;}
    :root[data-theme="light"] .ana-section-title{border-color:#e0e4ea!important;}

    /* Light theme overrides */
    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .page-title{color:#1e293b!important;}
    :root[data-theme="light"] .page-sub{color:#94a3b8!important;}
    :root[data-theme="light"] .sc{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .sc-label{color:#64748b!important;}
    :root[data-theme="light"] .sc-val{color:#1e293b!important;}
    :root[data-theme="light"] .sc-sub{color:#94a3b8!important;}
    :root[data-theme="light"] .panel{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .panel h3{color:#64748b!important;}
    :root[data-theme="light"] .tbar{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbar label{color:#64748b!important;}
    :root[data-theme="light"] .tbar input,.tbar select{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .btn{background:#f8fafc!important;border-color:#e0e4ea!important;color:#2563eb!important;}
    :root[data-theme="light"] .btn:hover{background:#eff6ff!important;border-color:#3b82f6!important;}
    :root[data-theme="light"] .tbl th{background:#f1f5f9!important;color:#64748b!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbl td{border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .tbl tr:hover td{background:rgba(59,130,246,0.05)!important;}
    :root[data-theme="light"] .tbl-wrap{border-color:#e0e4ea!important;}
    :root[data-theme="light"] .empty{color:#94a3b8!important;}

    @media(max-width:768px){
      .stat-grid{grid-template-columns:repeat(2,1fr);}
      .tbl{font-size:0.65rem;}
      .tbl th,.tbl td{padding:5px 6px;}
    }
  </style>
</head>
<body>
<div class="app-shell">
  ${buildSidebar('consolidation', false)}
  <div class="main-content">
    <h1 class="page-title">🧾 Consolidation</h1>
    <div class="page-sub">Unified trade history across Swing, Scalp &amp; Price Action — with daily / monthly / yearly analytics.</div>

    <div class="stat-grid">
      <div class="sc" style="--accent:#10b981;">
        <div class="sc-label">Total P&amp;L</div>
        <div class="sc-val" style="color:${totalPnl >= 0 ? '#10b981' : '#ef4444'};">${fmtINR(totalPnl)}</div>
        <div class="sc-sub">${total} trade${total !== 1 ? 's' : ''} · ${wins}W / ${losses}L · WR ${winRate}%</div>
      </div>
      <div class="sc" style="--accent:#3b82f6;">
        <div class="sc-label">Swing</div>
        <div class="sc-val">${modeCounts.SWING}</div>
        <div class="sc-sub">trades</div>
      </div>
      <div class="sc" style="--accent:#f59e0b;">
        <div class="sc-label">Scalp</div>
        <div class="sc-val">${modeCounts.SCALP}</div>
        <div class="sc-sub">trades</div>
      </div>
      <div class="sc" style="--accent:#a855f7;">
        <div class="sc-label">Price Action</div>
        <div class="sc-val">${modeCounts.PA}</div>
        <div class="sc-sub">trades</div>
      </div>
      <div class="sc" style="--accent:#10b981;">
        <div class="sc-label">Wins</div>
        <div class="sc-val" style="color:#10b981;">${wins}</div>
        <div class="sc-sub">profitable</div>
      </div>
      <div class="sc" style="--accent:#ef4444;">
        <div class="sc-label">Losses</div>
        <div class="sc-val" style="color:#ef4444;">${losses}</div>
        <div class="sc-sub">losing</div>
      </div>
    </div>

    <!-- Filter bar -->
    <div class="tbar">
      <label>Mode</label>
      <select id="fMode">
        <option value="">All</option>
        <option value="SWING">Swing</option>
        <option value="SCALP">Scalp</option>
        <option value="PA">Price Action</option>
      </select>
      <label>Side</label>
      <select id="fSide">
        <option value="">All</option>
        <option value="CE">CE</option>
        <option value="PE">PE</option>
      </select>
      <label>From</label>
      <input type="date" id="fFrom"/>
      <label>To</label>
      <input type="date" id="fTo"/>
      <label>Search</label>
      <input type="text" id="fSearch" placeholder="symbol / reason…" style="min-width:160px;"/>
      <button class="btn" onclick="applyFilters()">Apply</button>
      <button class="btn" onclick="resetFilters()">Reset</button>
      <span class="tbar-count" id="fCount" style="margin-left:auto;font-size:0.7rem;color:#4a6080;"></span>
    </div>

    <!-- Bulk copy bar -->
    <div class="tbar">
      <label>Copy filtered as</label>
      <button class="btn" onclick="copyGroup('daily')">📋 Daily</button>
      <button class="btn" onclick="copyGroup('weekly')">📋 Weekly</button>
      <button class="btn" onclick="copyGroup('monthly')">📋 Monthly</button>
      <button class="btn" onclick="copyGroup('yearly')">📋 Yearly</button>
      <button class="btn" onclick="copyAll()">📋 All Trades</button>
      <button class="btn" onclick="downloadCSV()">⬇ CSV</button>
      <button id="dvToggle" class="btn" onclick="toggleDayView()" style="margin-left:auto;" title="Day-wise P&L summary across all modes">👁 Day View</button>
      <button id="anaToggle" class="btn" onclick="toggleAnalytics()" title="Performance analytics across all modes (respects filters)">📊 Analytics</button>
    </div>

    <!-- Day View (toggleable) -->
    <div class="panel" id="dayViewPanel" style="display:none;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <h3 style="margin:0;">Day View</h3>
        <span id="dvCount" style="font-size:0.62rem;color:#4a6080;font-family:'IBM Plex Mono',monospace;"></span>
        <button class="btn" onclick="copyDayView(event.target)" style="margin-left:auto;">📋 Copy Day View</button>
      </div>
      <div class="tbl-wrap" style="max-height:420px;">
        <table class="tbl" id="dayViewTbl">
          <thead><tr>
            <th>Date</th>
            <th>Trades</th>
            <th>Swing</th>
            <th>Scalp</th>
            <th>PA</th>
            <th>Wins</th>
            <th>Losses</th>
            <th>P&amp;L</th>
            <th>Cumulative P&amp;L</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <!-- Analytics Panel (toggleable) -->
    <div id="anaPanel" class="ana-panel" style="display:none;">
      <!-- Cross-mode comparison (unique to consolidation) -->
      <div class="ana-mini" style="margin-bottom:12px;">
        <h3>🧭 Cross-Mode Comparison</h3>
        <div style="overflow-x:auto;">
          <table class="ana-tbl">
            <thead><tr>
              <th>Mode</th><th>Trades</th><th>Wins</th><th>Losses</th><th>WR%</th>
              <th>Net P&amp;L</th><th>Avg Win</th><th>Avg Loss</th><th>Profit Factor</th><th>Expectancy</th>
            </tr></thead>
            <tbody id="anaModeBody"></tbody>
          </table>
        </div>
      </div>

      <!-- Headline risk metrics + streaks (overall) -->
      <div class="ana-row3">
        <div class="ana-mini"><h3>📊 Risk Metrics (overall)</h3><div id="anaRiskMetrics"></div></div>
        <div class="ana-mini"><h3>🔥 Win / Loss Streaks</h3><div id="anaStreaks"></div></div>
        <div class="ana-mini"><h3>📅 Day-of-Week</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Day</th><th>Trades</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaDowBody"></tbody></table></div></div>
      </div>

      <!-- Equity / Monthly / Drawdown / Hourly -->
      <div class="ana-row">
        <div class="ana-card"><h3>📈 Equity Curve (per-trade)</h3><div class="ana-chart-wrap"><canvas id="anaEquity"></canvas></div></div>
        <div class="ana-card"><h3>📊 Monthly P&amp;L</h3><div class="ana-chart-wrap"><canvas id="anaMonthly"></canvas></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-card"><h3>📉 Drawdown</h3><div class="ana-chart-wrap"><canvas id="anaDrawdown"></canvas></div></div>
        <div class="ana-card"><h3>⏰ Hourly Performance</h3><div class="ana-chart-wrap"><canvas id="anaHourly"></canvas></div></div>
      </div>

      <!-- Reason breakdowns -->
      <div class="ana-row">
        <div class="ana-mini"><h3>📥 Entry Reason Breakdown</h3><div style="overflow-x:auto;max-height:320px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Mode</th><th>Count</th><th>Wins</th><th>Losses</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaEntryBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🚪 Exit Reason Breakdown</h3><div style="overflow-x:auto;max-height:320px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Mode</th><th>Count</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaExitBody"></tbody></table></div></div>
      </div>

      <!-- Loss analysis section -->
      <div class="ana-section-title">🔍 Loss Analysis</div>
      <div class="ana-row">
        <div class="ana-card"><h3>📊 Loss Distribution</h3><div class="ana-chart-wrap"><canvas id="anaLossDist"></canvas></div></div>
        <div class="ana-card"><h3>🔀 CE vs PE Performance</h3><div class="ana-chart-wrap"><canvas id="anaSidePerf"></canvas></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>💀 Top 10 Worst Trades</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Mode</th><th>Side</th><th>P&amp;L</th><th>Exit</th></tr></thead><tbody id="anaWorstBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🔥 Consecutive Loss Streaks</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Start</th><th>Trades</th><th>Total Loss</th><th>Avg Loss</th></tr></thead><tbody id="anaLossStreakBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📅 Worst Trading Days</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Trades</th><th>Day P&amp;L</th><th>Losses</th><th>Worst</th></tr></thead><tbody id="anaWorstDayBody"></tbody></table></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-mini"><h3>🚪 Loss by Exit Reason</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Loss Count</th><th>Total Loss</th><th>Avg Loss</th><th>% of Losses</th></tr></thead><tbody id="anaLossReasonBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>⏰ Losing Hours</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Hour</th><th>Losses</th><th>Loss P&amp;L</th><th>Avg Loss</th><th>Loss%</th></tr></thead><tbody id="anaLossHourBody"></tbody></table></div></div>
      </div>

      <!-- Best trades -->
      <div class="ana-section-title gain">🏆 Best Performance</div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>🌟 Top 10 Best Trades</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Mode</th><th>Side</th><th>P&amp;L</th><th>Exit</th></tr></thead><tbody id="anaBestBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📅 Best Trading Days</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Trades</th><th>Day P&amp;L</th><th>Wins</th><th>Best</th></tr></thead><tbody id="anaBestDayBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>⏰ Winning Hours</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Hour</th><th>Wins</th><th>Win P&amp;L</th><th>Avg Win</th><th>Win%</th></tr></thead><tbody id="anaWinHourBody"></tbody></table></div></div>
      </div>

      <!-- Cross-mode comparison charts -->
      <div class="ana-section-title cross">🧭 Cross-Mode Detail</div>
      <div class="ana-row">
        <div class="ana-card"><h3>📈 Cumulative P&amp;L by Mode</h3><div class="ana-chart-wrap"><canvas id="anaCumByMode"></canvas></div></div>
        <div class="ana-card"><h3>📊 Monthly P&amp;L (stacked by mode)</h3><div class="ana-chart-wrap"><canvas id="anaMonthlyStacked"></canvas></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-card"><h3>📊 P&amp;L Distribution (all trades)</h3><div class="ana-chart-wrap"><canvas id="anaPnlDist"></canvas></div></div>
        <div class="ana-card"><h3>📈 Rolling 30-trade Win Rate</h3><div class="ana-chart-wrap"><canvas id="anaRollWr"></canvas></div></div>
      </div>

      <!-- Time / duration / spot analytics -->
      <div class="ana-section-title" style="color:#60a5fa;">⏱ Time &amp; Spot Analytics</div>
      <div class="ana-row">
        <div class="ana-card"><h3>⏱ Trade Duration Distribution (minutes)</h3><div class="ana-chart-wrap"><canvas id="anaDurDist"></canvas></div></div>
        <div class="ana-card"><h3>🎯 NIFTY Spot Move Distribution (points)</h3><div class="ana-chart-wrap"><canvas id="anaSpotMove"></canvas></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-mini"><h3>⏱ Duration vs P&amp;L (buckets)</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Bucket</th><th>Trades</th><th>Wins</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaDurBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🗓 Day × Hour Heatmap (Net P&amp;L)</h3><div id="anaHeatmap" style="font-family:'IBM Plex Mono',monospace;font-size:0.62rem;"></div></div>
      </div>

      <!-- Weekly + drawdown stats -->
      <div class="ana-row">
        <div class="ana-mini"><h3>📅 Weekly Performance</h3><div style="overflow-x:auto;max-height:320px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Week</th><th>Trades</th><th>Wins</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaWeeklyBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📉 Drawdown Stats</h3><div id="anaDdStats"></div></div>
      </div>

      <!-- Strike / expiry / symbol concentration -->
      <div class="ana-section-title" style="color:#f59e0b;">🎯 Contract Analytics</div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>🏷 Top Option Symbols</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Symbol</th><th>Trades</th><th>WR%</th><th>P&amp;L</th></tr></thead><tbody id="anaSymBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🎯 Strike Analysis</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Strike</th><th>Trades</th><th>WR%</th><th>P&amp;L</th></tr></thead><tbody id="anaStrikeBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📅 Expiry Analysis</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Expiry</th><th>Trades</th><th>WR%</th><th>P&amp;L</th></tr></thead><tbody id="anaExpiryBody"></tbody></table></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-mini"><h3>🧬 Strategy Variant Breakdown</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Strategy</th><th>Mode</th><th>Trades</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaStratBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🔢 Quantity Buckets</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Qty</th><th>Trades</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaQtyBody"></tbody></table></div></div>
      </div>
    </div>

    <!-- Analytics -->
    <div class="panel">
      <h3>Cumulative P&amp;L</h3>
      <div class="chart-wrap"><canvas id="cumChart"></canvas></div>
    </div>

    <div class="roll-grid">
      <div class="panel">
        <h3>Daily Roll-up</h3>
        <div class="tbl-wrap" style="max-height:300px;">
          <table class="tbl" id="dailyTbl">
            <thead><tr>
              <th class="sortable" data-key="key">Date</th>
              <th class="sortable" data-key="count">Trades</th>
              <th class="sortable" data-key="pnl">P&amp;L</th>
              <th></th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="pager" data-for="dailyTbl">
          <label>Rows</label>
          <select class="pager-size">
            <option value="5">5</option><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="0">All</option>
          </select>
          <span class="pager-info"></span>
          <button class="btn pager-btn" data-action="first" title="First">«</button>
          <button class="btn pager-btn" data-action="prev"  title="Prev">‹</button>
          <button class="btn pager-btn" data-action="next"  title="Next">›</button>
          <button class="btn pager-btn" data-action="last"  title="Last">»</button>
        </div>
      </div>
      <div class="panel">
        <h3>Monthly Roll-up</h3>
        <div class="tbl-wrap" style="max-height:300px;">
          <table class="tbl" id="monthlyTbl">
            <thead><tr>
              <th class="sortable" data-key="key">Month</th>
              <th class="sortable" data-key="count">Trades</th>
              <th class="sortable" data-key="pnl">P&amp;L</th>
              <th></th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="pager" data-for="monthlyTbl">
          <label>Rows</label>
          <select class="pager-size">
            <option value="5">5</option><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="0">All</option>
          </select>
          <span class="pager-info"></span>
          <button class="btn pager-btn" data-action="first" title="First">«</button>
          <button class="btn pager-btn" data-action="prev"  title="Prev">‹</button>
          <button class="btn pager-btn" data-action="next"  title="Next">›</button>
          <button class="btn pager-btn" data-action="last"  title="Last">»</button>
        </div>
      </div>
      <div class="panel">
        <h3>Yearly Roll-up</h3>
        <div class="tbl-wrap" style="max-height:300px;">
          <table class="tbl" id="yearlyTbl">
            <thead><tr>
              <th class="sortable" data-key="key">Year</th>
              <th class="sortable" data-key="count">Trades</th>
              <th class="sortable" data-key="pnl">P&amp;L</th>
              <th></th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="pager" data-for="yearlyTbl">
          <label>Rows</label>
          <select class="pager-size">
            <option value="5">5</option><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="0">All</option>
          </select>
          <span class="pager-info"></span>
          <button class="btn pager-btn" data-action="first" title="First">«</button>
          <button class="btn pager-btn" data-action="prev"  title="Prev">‹</button>
          <button class="btn pager-btn" data-action="next"  title="Next">›</button>
          <button class="btn pager-btn" data-action="last"  title="Last">»</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>All Trades (Filtered)</h3>
      <div class="tbl-wrap">
        <table class="tbl" id="tradesTbl">
          <thead><tr>
            <th>#</th>
            <th class="sortable" data-key="mode">Mode</th>
            <th class="sortable" data-key="date">Date</th>
            <th class="sortable" data-key="side">Side</th>
            <th class="sortable" data-key="symbol">Symbol</th>
            <th class="sortable" data-key="qty">Qty</th>
            <th class="sortable" data-key="entryPrice">Entry</th>
            <th class="sortable" data-key="exitPrice">Exit</th>
            <th class="sortable" data-key="entryTime">Entry Time</th>
            <th class="sortable" data-key="exitTime">Exit Time</th>
            <th class="sortable" data-key="pnl">P&amp;L</th>
            <th class="sortable" data-key="exitReason">Exit Reason</th>
            <th>Copy</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="pager" data-for="tradesTbl">
        <label>Rows</label>
        <select class="pager-size">
          <option value="10">10</option><option value="25" selected>25</option><option value="50">50</option><option value="100">100</option><option value="0">All</option>
        </select>
        <span class="pager-info"></span>
        <button class="btn pager-btn" data-action="first" title="First">«</button>
        <button class="btn pager-btn" data-action="prev"  title="Prev">‹</button>
        <button class="btn pager-btn" data-action="next"  title="Next">›</button>
        <button class="btn pager-btn" data-action="last"  title="Last">»</button>
      </div>
      <div id="emptyState" class="empty" style="display:none;">No trades match your filters.</div>
    </div>
  </div>
</div>

<script>
const TRADES = ${JSON.stringify(trades)};

function fmtINR(n){
  if (typeof n !== 'number' || isNaN(n)) return '—';
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pnlColor(n){ return (n >= 0) ? '#10b981' : '#ef4444'; }
function pnlRowBg(n){ return n > 0 ? 'rgba(16,185,129,0.07)' : (n < 0 ? 'rgba(239,68,68,0.07)' : 'transparent'); }

// Display formatter: convert any stored date/timestamp string into
// a UI-friendly form ("DD/MM/YYYY HH:MM" in IST when time present, else "DD/MM/YYYY").
// Pass-through for week/month/year rollup keys ("YYYY-Www", "YYYY-MM", "YYYY").
function fmtDateTime(s){
  if (s == null || s === '') return '—';
  const v = String(s);
  // ISO timestamp (YYYY-MM-DDT..)
  if (/^\\d{4}-\\d{2}-\\d{2}T/.test(v)){
    const d = new Date(v);
    if (isNaN(d)) return v;
    const ist = new Date(d.getTime() + 19800000);
    const dd = String(ist.getUTCDate()).padStart(2,'0');
    const mm = String(ist.getUTCMonth()+1).padStart(2,'0');
    const yyyy = ist.getUTCFullYear();
    const hh = String(ist.getUTCHours()).padStart(2,'0');
    const mi = String(ist.getUTCMinutes()).padStart(2,'0');
    return dd + '/' + mm + '/' + yyyy + ' ' + hh + ':' + mi;
  }
  // YYYY-MM-DD
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(v)){
    return v.slice(8,10) + '/' + v.slice(5,7) + '/' + v.slice(0,4);
  }
  // YYYY-MM (monthly key)
  if (/^\\d{4}-\\d{2}$/.test(v)){
    return v.slice(5,7) + '/' + v.slice(0,4);
  }
  // Trade entry/exit time: "DD/MM/YYYY, HH:MM:SS" → "DD/MM/YYYY HH:MM"
  const tm = v.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})[,\\s]+(\\d{1,2}):(\\d{2})/);
  if (tm){
    return \`\${tm[1].padStart(2,'0')}/\${tm[2].padStart(2,'0')}/\${tm[3]} \${tm[4].padStart(2,'0')}:\${tm[5]}\`;
  }
  // YYYY-Www, YYYY, anything else — leave as-is
  return v;
}

// Parse entry/exit times of the form "HH:MM, DD/MM/YYYY"
function parseEntryTime(t){
  if (!t) return null;
  const m = String(t).match(/(\\d{1,2}):(\\d{2}),\\s*(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/);
  if (!m) return null;
  return new Date(+m[5], +m[4]-1, +m[3], +m[1], +m[2]);
}

function getState(){
  return {
    mode:   document.getElementById('fMode').value,
    side:   document.getElementById('fSide').value,
    from:   document.getElementById('fFrom').value,
    to:     document.getElementById('fTo').value,
    search: document.getElementById('fSearch').value.trim().toLowerCase(),
  };
}

function filterTrades(){
  const f = getState();
  return TRADES.filter(t => {
    if (f.mode && t.mode !== f.mode) return false;
    if (f.side && t.side !== f.side) return false;
    if (f.from && t.date < f.from) return false;
    if (f.to   && t.date > f.to)   return false;
    if (f.search){
      const hay = (t.symbol + ' ' + t.entryReason + ' ' + t.exitReason + ' ' + t.strategy).toLowerCase();
      if (hay.indexOf(f.search) === -1) return false;
    }
    return true;
  });
}

function weekKey(dateStr){
  // ISO week: YYYY-Www (Monday-start). dateStr is "YYYY-MM-DD".
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return '';
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return tmp.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}
function monthKey(d){ return (d || '').slice(0, 7);  } // YYYY-MM
function yearKey(d) { return (d || '').slice(0, 4);  } // YYYY

function rollup(trades, keyFn){
  const out = new Map();
  for (const t of trades){
    const k = keyFn(t.date);
    if (!k) continue;
    if (!out.has(k)) out.set(k, { key: k, count: 0, pnl: 0, trades: [] });
    const b = out.get(k);
    b.count++;
    b.pnl += t.pnl;
    b.trades.push(t);
  }
  return Array.from(out.values()).sort((a, b) => b.key.localeCompare(a.key));
}

// ── Sort + pagination state ──────────────────────────────────────────────────
const TBL_STATE = {
  dailyTbl:   { sortKey: 'key',  sortDir: 'desc', page: 1, pageSize: 10, totalPages: 1 },
  monthlyTbl: { sortKey: 'key',  sortDir: 'desc', page: 1, pageSize: 10, totalPages: 1 },
  yearlyTbl:  { sortKey: 'key',  sortDir: 'desc', page: 1, pageSize: 10, totalPages: 1 },
  tradesTbl:  { sortKey: 'date', sortDir: 'desc', page: 1, pageSize: 25, totalPages: 1 },
};

// Rendered (sorted + sliced) arrays kept so copy buttons can map local index → row
const _rendered = { dailyTbl: [], monthlyTbl: [], yearlyTbl: [], tradesTbl: [] };

// Time-time like "HH:MM, DD/MM/YYYY" → numeric (ms) for sorting
function timeStrToNum(s){
  const d = parseEntryTime(s);
  return d ? d.getTime() : -Infinity;
}

function sortValue(row, key){
  if (key === 'entryTime' || key === 'exitTime') return timeStrToNum(row[key]);
  return row[key];
}

function cmpVals(a, b, dir){
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  let r;
  if (typeof a === 'number' && typeof b === 'number') r = a - b;
  else r = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? r : -r;
}

function sortRows(rows, key, dir){
  return rows.slice().sort((a, b) => cmpVals(sortValue(a, key), sortValue(b, key), dir));
}

function paginate(rows, page, pageSize){
  if (!pageSize) return { slice: rows, page: 1, totalPages: 1 };
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  return { slice: rows.slice(start, start + pageSize), page: p, totalPages };
}

function updatePagerUI(tableId, total, shown, page, totalPages){
  const pager = document.querySelector(\`.pager[data-for="\${tableId}"]\`);
  if (!pager) return;
  const info = pager.querySelector('.pager-info');
  const st = TBL_STATE[tableId];
  st.totalPages = totalPages;
  if (!total){
    info.textContent = '0 of 0';
  } else if (!st.pageSize){
    info.textContent = \`All \${total}\`;
  } else {
    const start = (page - 1) * st.pageSize + 1;
    const end = Math.min(total, start + shown - 1);
    info.textContent = \`\${start}–\${end} of \${total} · pg \${page}/\${totalPages}\`;
  }
  pager.querySelector('[data-action="first"]').disabled = (page <= 1);
  pager.querySelector('[data-action="prev"]').disabled  = (page <= 1);
  pager.querySelector('[data-action="next"]').disabled  = (page >= totalPages);
  pager.querySelector('[data-action="last"]').disabled  = (page >= totalPages);
}

function updateSortIndicators(tableId){
  const st = TBL_STATE[tableId];
  const ths = document.querySelectorAll(\`#\${tableId} thead th.sortable\`);
  ths.forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === st.sortKey){
      th.classList.add(st.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function renderRollupTable(id, rows){
  const tb = document.querySelector('#' + id + ' tbody');
  updateSortIndicators(id);
  if (!rows.length){
    tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#4a6080;padding:18px;">No data</td></tr>';
    _rendered[id] = [];
    updatePagerUI(id, 0, 0, 1, 1);
    return;
  }
  const st = TBL_STATE[id];
  const sorted = sortRows(rows, st.sortKey, st.sortDir);
  const pg = paginate(sorted, st.page, st.pageSize);
  st.page = pg.page;
  _rendered[id] = pg.slice;
  tb.innerHTML = pg.slice.map((r, i) => \`
    <tr style="background:\${pnlRowBg(r.pnl)};">
      <td style="font-weight:600;">\${fmtDateTime(r.key)}</td>
      <td>\${r.count}</td>
      <td style="color:\${pnlColor(r.pnl)};font-weight:700;">\${r.pnl >= 0 ? '+' : ''}\${fmtINR(r.pnl)}</td>
      <td><button class="btn" onclick="copyBucket('\${id}', \${i})">📋</button></td>
    </tr>\`).join('');
  updatePagerUI(id, sorted.length, pg.slice.length, pg.page, pg.totalPages);
}

function renderTradesTable(rows){
  const tb = document.querySelector('#tradesTbl tbody');
  const empty = document.getElementById('emptyState');
  updateSortIndicators('tradesTbl');
  if (!rows.length){
    tb.innerHTML = '';
    empty.style.display = 'block';
    _rendered.tradesTbl = [];
    updatePagerUI('tradesTbl', 0, 0, 1, 1);
    return;
  }
  empty.style.display = 'none';
  const st = TBL_STATE.tradesTbl;
  const sorted = sortRows(rows, st.sortKey, st.sortDir);
  const pg = paginate(sorted, st.page, st.pageSize);
  st.page = pg.page;
  _rendered.tradesTbl = pg.slice;
  const startNo = st.pageSize ? (pg.page - 1) * st.pageSize : 0;
  tb.innerHTML = pg.slice.map((t, i) => \`
    <tr style="background:\${pnlRowBg(t.pnl)};">
      <td>\${startNo + i + 1}</td>
      <td><span class="badge-mode badge-\${t.mode}">\${t.mode}</span></td>
      <td>\${fmtDateTime(t.date)}</td>
      <td><span class="badge \${t.side === 'CE' ? 'badge-ce' : 'badge-pe'}">\${t.side || '—'}</span></td>
      <td style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="\${esc(t.symbol)}">\${esc(t.symbol) || '—'}</td>
      <td>\${t.qty || '—'}</td>
      <td>\${fmtINR(t.entryPrice)}</td>
      <td>\${fmtINR(t.exitPrice)}</td>
      <td style="font-size:0.65rem;">\${esc(fmtDateTime(t.entryTime))}</td>
      <td style="font-size:0.65rem;">\${esc(fmtDateTime(t.exitTime))}</td>
      <td style="color:\${pnlColor(t.pnl)};font-weight:700;">\${t.pnl >= 0 ? '+' : ''}\${fmtINR(t.pnl)}</td>
      <td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:0.65rem;" title="\${esc(t.exitReason)}">\${esc(t.exitReason) || '—'}</td>
      <td><button class="btn" onclick="copyOne(\${i})">📋</button></td>
    </tr>\`).join('');
  updatePagerUI('tradesTbl', sorted.length, pg.slice.length, pg.page, pg.totalPages);
}

function esc(s){
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function tradeToLine(t){
  return [
    t.date, t.mode, t.side, t.symbol || '—',
    'qty=' + (t.qty || 0),
    'entry=' + (t.entryPrice ?? '—'),
    'exit='  + (t.exitPrice ?? '—'),
    'entryTime=' + (t.entryTime || '—'),
    'exitTime='  + (t.exitTime || '—'),
    'pnl=' + (typeof t.pnl === 'number' ? t.pnl.toFixed(2) : '—'),
    'reason=' + (t.exitReason || '—'),
  ].join(' | ');
}

function tradesToText(list, header){
  const totalPnl = list.reduce((a, t) => a + (t.pnl || 0), 0);
  const w = list.filter(t => t.pnl > 0).length;
  const l = list.filter(t => t.pnl < 0).length;
  const head = header ? header + '\\n' : '';
  const summary = \`-- \${list.length} trades | \${w}W/\${l}L | Total P&L: \${totalPnl >= 0 ? '+' : ''}\${totalPnl.toFixed(2)} --\\n\`;
  return head + summary + list.map(tradeToLine).join('\\n');
}

function tradesToCSV(list){
  const cols = ['date','mode','side','symbol','qty','entryPrice','exitPrice','spotAtEntry','spotAtExit','optionEntryLtp','optionExitLtp','entryTime','exitTime','pnl','pnlMode','entryReason','exitReason','optionStrike','optionType','optionExpiry','strategy','instrument'];
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[,"\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = cols.join(',');
  const body = list.map(t => cols.map(c => esc(t[c])).join(',')).join('\\n');
  return header + '\\n' + body;
}

async function copyText(text, btn){
  try {
    await navigator.clipboard.writeText(text);
    if (btn){
      const orig = btn.textContent;
      btn.classList.add('copied');
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = orig; }, 1400);
    }
  } catch(e) {
    alert('Copy failed: ' + e.message);
  }
}

let _lastFiltered = [];
let _lastRollups  = { daily: [], weekly: [], monthly: [], yearly: [] };

function copyOne(idx){
  const t = _rendered.tradesTbl[idx];
  if (!t) return;
  copyText(tradesToText([t], '# Trade'), event.target);
}

function copyBucket(tableId, idx){
  const list = _rendered[tableId] && _rendered[tableId][idx];
  if (!list) return;
  const header = \`# \${list.key} (\${list.count} trades)\`;
  copyText(tradesToText(list.trades, header), event.target);
}

function copyGroup(period){
  if (!_lastFiltered.length){ alert('No trades to copy — filters are empty.'); return; }
  let keyFn;
  if (period === 'daily')   keyFn = d => d;
  if (period === 'weekly')  keyFn = weekKey;
  if (period === 'monthly') keyFn = monthKey;
  if (period === 'yearly')  keyFn = yearKey;
  const buckets = rollup(_lastFiltered, keyFn);
  const chunks = buckets.map(b =>
    tradesToText(b.trades, \`# \${b.key} (\${b.count} trades, P&L: \${b.pnl >= 0 ? '+' : ''}\${b.pnl.toFixed(2)})\`)
  );
  copyText(chunks.join('\\n\\n'), event.target);
}

function copyAll(){
  if (!_lastFiltered.length){ alert('No trades to copy.'); return; }
  copyText(tradesToText(_lastFiltered, '# All filtered trades'), event.target);
}

function downloadCSV(){
  if (!_lastFiltered.length){ alert('No trades to export.'); return; }
  const csv = tradesToCSV(_lastFiltered);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'consolidation_' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

let _cumChart = null;
function renderCumChart(rows){
  const ctx = document.getElementById('cumChart');
  if (!ctx) return;
  // Sort by (date, entryTime) ascending for a monotonic x-axis
  const sorted = rows.slice().sort((a, b) => {
    const da = (a.date || '') + ' ' + (a.entryTime || '');
    const db = (b.date || '') + ' ' + (b.entryTime || '');
    return da.localeCompare(db);
  });
  let cum = 0;
  const labels = [], data = [];
  for (const t of sorted){
    cum += (t.pnl || 0);
    labels.push(fmtDateTime(t.entryTime || t.date));
    data.push(cum);
  }
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const gridCol = isLight ? '#e0e4ea' : '#0e1e36';
  const tickCol = isLight ? '#64748b' : '#3a5070';
  const GREEN = '#10b981', RED = '#ef4444', FLAT = '#4a6080';
  const baseColor = cum > 0 ? GREEN : (cum < 0 ? RED : FLAT);
  const baseFill  = cum > 0 ? 'rgba(16,185,129,0.14)' : (cum < 0 ? 'rgba(239,68,68,0.14)' : 'rgba(74,96,128,0.10)');
  if (_cumChart) _cumChart.destroy();
  _cumChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{
      data, borderColor: baseColor, backgroundColor: baseFill,
      borderWidth: 2, fill: true, tension: 0.25, pointRadius: 0,
      segment: {
        borderColor: function(ctx){
          const y0 = ctx.p0.parsed.y, y1 = ctx.p1.parsed.y;
          return ((y0 + y1) / 2) >= 0 ? GREEN : RED;
        },
      },
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: function(ctx){ return fmtINR(ctx.parsed.y); } } } },
      scales: {
        x: { ticks: { display: false }, grid: { display: false } },
        y: { ticks: { color: tickCol, font: { size: 10 }, callback: function(v){ return fmtINR(v); } }, grid: { color: gridCol } },
      },
    },
  });
}

function applyFilters(){
  const rows = filterTrades();
  _lastFiltered = rows;
  _lastRollups.daily   = rollup(rows, d => d);
  _lastRollups.weekly  = rollup(rows, weekKey);
  _lastRollups.monthly = rollup(rows, monthKey);
  _lastRollups.yearly  = rollup(rows, yearKey);

  // Reset page on filter change
  ['dailyTbl','monthlyTbl','yearlyTbl','tradesTbl'].forEach(id => { TBL_STATE[id].page = 1; });

  renderRollupTable('dailyTbl',   _lastRollups.daily);
  renderRollupTable('monthlyTbl', _lastRollups.monthly);
  renderRollupTable('yearlyTbl',  _lastRollups.yearly);
  renderTradesTable(rows);
  renderCumChart(rows);
  if (_dvVisible) buildDayView();
  if (_anaVisible) renderAnalytics();

  const totalPnl = rows.reduce((a, t) => a + (t.pnl || 0), 0);
  document.getElementById('fCount').innerHTML =
    \`<strong>\${rows.length}</strong> trades · Net: <span style="color:\${pnlColor(totalPnl)};font-weight:700;">\${totalPnl >= 0 ? '+' : ''}\${fmtINR(totalPnl)}</span>\`;
}

// ── Day View ─────────────────────────────────────────────────────────────────
let _dvVisible = false;
let _dvDays = [];

function toggleDayView(){
  _dvVisible = !_dvVisible;
  document.getElementById('dayViewPanel').style.display = _dvVisible ? 'block' : 'none';
  document.getElementById('dvToggle').classList.toggle('copied', _dvVisible);
  if (_dvVisible) buildDayView();
}

function buildDayView(){
  const map = new Map();
  for (const t of _lastFiltered){
    const d = t.date || 'Unknown';
    if (!map.has(d)) map.set(d, { date: d, trades: 0, wins: 0, losses: 0, pnl: 0, SWING: 0, SCALP: 0, PA: 0 });
    const b = map.get(d);
    b.trades++;
    b.pnl += (t.pnl || 0);
    if (t.pnl > 0) b.wins++; else if (t.pnl < 0) b.losses++;
    if (t.mode && b[t.mode] != null) b[t.mode]++;
  }
  const days = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  _dvDays = days;
  const tb = document.querySelector('#dayViewTbl tbody');
  if (!days.length){
    tb.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#4a6080;padding:18px;">No data</td></tr>';
    document.getElementById('dvCount').textContent = '';
    return;
  }
  let cum = 0;
  tb.innerHTML = days.map(dy => {
    cum += dy.pnl;
    const pc = pnlColor(dy.pnl), cc = pnlColor(cum);
    const pbg = dy.pnl > 0 ? 'rgba(16,185,129,0.12)' : (dy.pnl < 0 ? 'rgba(239,68,68,0.12)' : 'transparent');
    const cbg = cum    > 0 ? 'rgba(16,185,129,0.12)' : (cum    < 0 ? 'rgba(239,68,68,0.12)' : 'transparent');
    const modeCell = (n, cls) => n ? \`<span class="badge-mode badge-\${cls}">\${n}</span>\` : '<span style="color:#3a5070;">—</span>';
    return \`<tr style="background:\${pnlRowBg(dy.pnl)};">
      <td style="font-weight:600;">\${dy.date}</td>
      <td>\${dy.trades}</td>
      <td>\${modeCell(dy.SWING, 'SWING')}</td>
      <td>\${modeCell(dy.SCALP, 'SCALP')}</td>
      <td>\${modeCell(dy.PA, 'PA')}</td>
      <td style="color:#10b981;">\${dy.wins}</td>
      <td style="color:#ef4444;">\${dy.losses}</td>
      <td style="color:\${pc};font-weight:700;background:\${pbg};">\${dy.pnl >= 0 ? '+' : ''}\${fmtINR(dy.pnl)}</td>
      <td style="color:\${cc};font-weight:700;background:\${cbg};">\${cum    >= 0 ? '+' : ''}\${fmtINR(cum)}</td>
    </tr>\`;
  }).join('');
  document.getElementById('dvCount').textContent = days.length + ' day' + (days.length === 1 ? '' : 's');
}

function copyDayView(btn){
  if (!_dvDays.length){ alert('No data to copy.'); return; }
  const lines = ['Date\\tTrades\\tSwing\\tScalp\\tPA\\tWins\\tLosses\\tPnL\\tCumulative PnL'];
  let cum = 0;
  for (const dy of _dvDays){
    cum += dy.pnl;
    lines.push([dy.date, dy.trades, dy.SWING, dy.SCALP, dy.PA, dy.wins, dy.losses, dy.pnl.toFixed(2), cum.toFixed(2)].join('\\t'));
  }
  copyText(lines.join('\\n'), btn);
}

function resetFilters(){
  ['fMode','fSide','fFrom','fTo','fSearch'].forEach(id => { document.getElementById(id).value = ''; });
  applyFilters();
}

// Re-render a single table using cached data (used by sort / pagination handlers)
function rerender(tableId){
  if (tableId === 'tradesTbl')   return renderTradesTable(_lastFiltered);
  if (tableId === 'dailyTbl')    return renderRollupTable('dailyTbl',   _lastRollups.daily);
  if (tableId === 'monthlyTbl')  return renderRollupTable('monthlyTbl', _lastRollups.monthly);
  if (tableId === 'yearlyTbl')   return renderRollupTable('yearlyTbl',  _lastRollups.yearly);
}

// Wire sort + pager handlers once
function wireTableControls(){
  ['dailyTbl','monthlyTbl','yearlyTbl','tradesTbl'].forEach(id => {
    document.querySelectorAll(\`#\${id} thead th.sortable\`).forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        const st = TBL_STATE[id];
        if (st.sortKey === key) st.sortDir = (st.sortDir === 'asc') ? 'desc' : 'asc';
        else { st.sortKey = key; st.sortDir = 'asc'; }
        st.page = 1;
        rerender(id);
      });
    });

    const pager = document.querySelector(\`.pager[data-for="\${id}"]\`);
    if (!pager) return;
    pager.querySelector('.pager-size').addEventListener('change', e => {
      TBL_STATE[id].pageSize = parseInt(e.target.value, 10) || 0;
      TBL_STATE[id].page = 1;
      rerender(id);
    });
    pager.querySelectorAll('.pager-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const st = TBL_STATE[id];
        const a = btn.dataset.action;
        if (a === 'first') st.page = 1;
        if (a === 'prev')  st.page = Math.max(1, st.page - 1);
        if (a === 'next')  st.page = Math.min(st.totalPages, st.page + 1);
        if (a === 'last')  st.page = st.totalPages;
        rerender(id);
      });
    });
  });
}

// ── Analytics Panel ─────────────────────────────────────────────────────────
let _anaVisible = false;
const _anaCharts = {};
const _MODE_COLOR = { SWING: '#3b82f6', SCALP: '#f59e0b', PA: '#a855f7' };

function fmtAna(v){ return '₹' + Math.round(Math.abs(v||0)).toLocaleString('en-IN'); }
function fmtAnaSigned(v){ const n = v||0; return (n>=0?'+':'-') + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN'); }
function fmtAnaShort(v){ return Math.abs(v||0)>=1000 ? '₹'+Math.round((v||0)/1000)+'k' : '₹'+Math.round(v||0); }

// ── Generic per-table enhancer: filter + sort + pager for analytics tables ──
const _anaTblState = new Map();
function _anaCellNum(s){
  if (s == null) return null;
  let v = String(s).trim();
  if (!v) return null;
  v = v.replace(/^\\(([\\d.,]+)\\)$/, '-$1');
  if (v === '∞') return Number.POSITIVE_INFINITY;
  if (v === '—' || v === '-' || v === '–') return null;
  const stripped = v.replace(/[₹%,\\s+]/g, '');
  if (/^-?\\d+(\\.\\d+)?$/.test(stripped)) return parseFloat(stripped);
  return null;
}
function _anaParseRows(html){
  const t = document.createElement('table');
  t.innerHTML = '<tbody>' + (html||'') + '</tbody>';
  return [...t.querySelectorAll('tbody > tr')].map(tr => {
    const cells = [...tr.querySelectorAll('td')].map(td => (td.textContent||'').trim());
    return { html: tr.outerHTML, cells, lc: cells.map(c => c.toLowerCase()).join(' \\u0001 ') };
  });
}
function anaEnhance(tbodyId, rowsHtml, emptyHtml, opts){
  opts = opts || {};
  const tb = document.getElementById(tbodyId);
  if (!tb) return;
  const table = tb.closest('table');
  const wrap  = table.parentElement;
  const mini  = wrap.parentElement;

  let st = _anaTblState.get(tbodyId);
  if (!st){
    st = { rows:[], emptyHtml:'', filter:'', sortIdx:-1, sortDir:1, page:0, size:10, opts };
    _anaTblState.set(tbodyId, st);

    if (opts.filter){
      const bar = document.createElement('div');
      bar.className = 'ana-tbl-bar';
      bar.innerHTML = '<input type="text" class="ana-tbl-filter" placeholder="Filter rows..." />'
                    + '<span class="ana-tbl-count"></span>';
      mini.insertBefore(bar, wrap);
      bar.querySelector('.ana-tbl-filter').addEventListener('input', e => {
        st.filter = (e.target.value||'').toLowerCase();
        st.page = 0;
        _anaRenderTbl(tbodyId);
      });
    }

    table.querySelectorAll('thead th').forEach((th, i) => {
      th.classList.add('ana-sortable');
      th.addEventListener('click', () => {
        if (st.sortIdx === i){ st.sortDir = -st.sortDir; }
        else { st.sortIdx = i; st.sortDir = 1; }
        st.page = 0;
        _anaRenderTbl(tbodyId);
      });
    });

    if (opts.pager){
      const pg = document.createElement('div');
      pg.className = 'ana-tbl-pager';
      pg.innerHTML = '<label>Rows</label>'
        + '<select class="ana-tbl-size">'
        +   '<option value="5">5</option>'
        +   '<option value="10" selected>10</option>'
        +   '<option value="25">25</option>'
        +   '<option value="50">50</option>'
        +   '<option value="0">All</option>'
        + '</select>'
        + '<span class="ana-tbl-pager-info"></span>'
        + '<button class="btn" data-act="first" title="First">«</button>'
        + '<button class="btn" data-act="prev"  title="Prev">‹</button>'
        + '<button class="btn" data-act="next"  title="Next">›</button>'
        + '<button class="btn" data-act="last"  title="Last">»</button>';
      wrap.parentNode.insertBefore(pg, wrap.nextSibling);
      pg.querySelector('.ana-tbl-size').addEventListener('change', e => {
        st.size = parseInt(e.target.value, 10) || 0;
        st.page = 0;
        _anaRenderTbl(tbodyId);
      });
      pg.querySelectorAll('button[data-act]').forEach(btn => btn.addEventListener('click', () => {
        const filt = _anaFilteredRows(tbodyId);
        const total = filt.length;
        const sz = st.size || total || 1;
        const last = Math.max(0, Math.ceil(total/sz) - 1);
        const act = btn.dataset.act;
        if (act === 'first') st.page = 0;
        else if (act === 'prev')  st.page = Math.max(0, st.page - 1);
        else if (act === 'next')  st.page = Math.min(last, st.page + 1);
        else if (act === 'last')  st.page = last;
        _anaRenderTbl(tbodyId);
      }));
    }
  }

  st.rows = _anaParseRows(rowsHtml);
  st.emptyHtml = emptyHtml || '';
  _anaRenderTbl(tbodyId);
}
function _anaFilteredRows(tbodyId){
  const st = _anaTblState.get(tbodyId);
  if (!st) return [];
  let rows = st.rows.slice();
  if (st.filter){
    rows = rows.filter(r => r.lc.indexOf(st.filter) !== -1);
  }
  if (st.sortIdx >= 0){
    const idx = st.sortIdx, dir = st.sortDir;
    rows.sort((a,b) => {
      const av = a.cells[idx] || '', bv = b.cells[idx] || '';
      const an = _anaCellNum(av), bn = _anaCellNum(bv);
      let cmp;
      if (an != null && bn != null) cmp = an - bn;
      else cmp = av.localeCompare(bv, undefined, { numeric: true });
      return cmp * dir;
    });
  }
  return rows;
}
function _anaRenderTbl(tbodyId){
  const st = _anaTblState.get(tbodyId);
  if (!st) return;
  const tb = document.getElementById(tbodyId);
  if (!tb) return;
  const table = tb.closest('table');
  const wrap  = table.parentElement;
  const mini  = wrap.parentElement;

  if (!st.rows.length){
    tb.innerHTML = st.emptyHtml || '<tr><td style="text-align:center;color:#3a5070;">No data</td></tr>';
    const bar0 = mini.querySelector('.ana-tbl-bar');
    if (bar0) bar0.querySelector('.ana-tbl-count').textContent = '0 rows';
    const pg0 = mini.querySelector('.ana-tbl-pager');
    if (pg0){
      pg0.querySelector('.ana-tbl-pager-info').textContent = '0–0 of 0';
      pg0.querySelectorAll('button[data-act]').forEach(b => b.disabled = true);
    }
    table.querySelectorAll('thead th').forEach((th, i) => {
      th.classList.remove('ana-sorted-asc','ana-sorted-desc');
      if (i === st.sortIdx) th.classList.add(st.sortDir>0?'ana-sorted-asc':'ana-sorted-desc');
    });
    return;
  }

  const filtered = _anaFilteredRows(tbodyId);
  const total = filtered.length;
  const sz = st.size || total;
  const pgCount = Math.max(1, Math.ceil(total/Math.max(1,sz)));
  if (st.page >= pgCount) st.page = pgCount - 1;
  if (st.page < 0) st.page = 0;
  const start = sz ? st.page*sz : 0;
  const end = sz ? Math.min(total, start + sz) : total;
  const slice = filtered.slice(start, end);

  tb.innerHTML = slice.length
    ? slice.map(r => r.html).join('')
    : '<tr><td colspan="20" style="text-align:center;color:#3a5070;">No rows match filter</td></tr>';

  table.querySelectorAll('thead th').forEach((th, i) => {
    th.classList.remove('ana-sorted-asc','ana-sorted-desc');
    if (i === st.sortIdx) th.classList.add(st.sortDir>0?'ana-sorted-asc':'ana-sorted-desc');
  });
  const bar = mini.querySelector('.ana-tbl-bar');
  if (bar){
    bar.querySelector('.ana-tbl-count').textContent = total + ' row' + (total===1?'':'s')
      + (st.filter ? ' (of ' + st.rows.length + ')' : '');
  }
  const pg = mini.querySelector('.ana-tbl-pager');
  if (pg){
    pg.querySelector('.ana-tbl-pager-info').textContent =
      total === 0 ? '0–0 of 0' : (start+1) + '–' + end + ' of ' + total;
    const bs = pg.querySelectorAll('button[data-act]');
    const firstPage = st.page === 0;
    const lastPage  = st.page >= pgCount - 1;
    bs[0].disabled = bs[1].disabled = firstPage;
    bs[2].disabled = bs[3].disabled = lastPage;
  }
}

// Parse entry/exit time "HH:MM, DD/MM/YYYY" or "HH:MM:SS, DD/MM/YYYY" → ms or null
function _parseTimeMs(t){
  if (!t) return null;
  const m = String(t).match(/(\\d{1,2}):(\\d{2})(?::(\\d{2}))?,\\s*(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/);
  if (!m) return null;
  return new Date(+m[6], +m[5]-1, +m[4], +m[1], +m[2], +(m[3]||0)).getTime();
}
function _hourOf(t){
  const ts = t.entryTime || '';
  const m = String(ts).match(/(\\d{1,2}):(\\d{2})/);
  return m ? parseInt(m[1], 10) : null;
}
function _dowOf(t){
  if (!t.date) return null;
  const d = new Date(t.date + 'T00:00:00');
  return isNaN(d) ? null : d.getDay();
}
function _monthOf(t){ return (t.date || '').slice(0, 7); }
function _durMin(t){
  const a = _parseTimeMs(t.entryTime), b = _parseTimeMs(t.exitTime);
  if (a == null || b == null || b < a) return null;
  return Math.round((b - a) / 60000);
}

function toggleAnalytics(){
  _anaVisible = !_anaVisible;
  document.getElementById('anaPanel').style.display = _anaVisible ? 'block' : 'none';
  document.getElementById('anaToggle').classList.toggle('copied', _anaVisible);
  if (_anaVisible) renderAnalytics();
}

function renderAnalytics(){
  const trades = _lastFiltered.slice();
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const _gc = isLight ? '#e0e4ea' : '#0e1e36';
  const _tc = isLight ? '#64748b' : '#3a5070';
  const baseChartOpts = (extra) => Object.assign({
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: _tc, font: { size: 9, family: 'IBM Plex Mono' } }, grid: { display: false } },
      y: { ticks: { color: _tc, font: { size: 10, family: 'IBM Plex Mono' }, callback: v => fmtAnaShort(v) }, grid: { color: _gc } },
    },
  }, extra || {});

  // ── Cross-mode comparison ──
  (function(){
    const modes = ['SWING','SCALP','PA'];
    const EMPTY = '<tr><td colspan="10" style="text-align:center;color:#3a5070;">No data</td></tr>';
    if (!trades.length){ anaEnhance('anaModeBody', '', EMPTY, {}); return; }
    {
      let html = '';
      const overall = { count:0, wins:0, losses:0, pnl:0, gp:0, gl:0 };
      modes.forEach(m => {
        const sub = trades.filter(t => t.mode === m);
        const wins = sub.filter(t => t.pnl > 0), losses = sub.filter(t => t.pnl < 0);
        const gp = wins.reduce((s,t)=>s+t.pnl,0), gl = losses.reduce((s,t)=>s+t.pnl,0);
        const pnl = sub.reduce((s,t)=>s+(t.pnl||0),0);
        const wr = sub.length ? ((wins.length/sub.length)*100).toFixed(1) : '0.0';
        const aw = wins.length ? Math.round(gp/wins.length) : 0;
        const al = losses.length ? Math.round(gl/losses.length) : 0;
        const pf = gl !== 0 ? (gp / Math.abs(gl)).toFixed(2) : (gp>0?'∞':'—');
        const exp = sub.length ? Math.round(pnl/sub.length) : 0;
        const pc = pnl>=0?'#10b981':'#ef4444';
        const pfNum = parseFloat(pf);
        const pfCol = isNaN(pfNum) ? '#c8d8f0' : (pfNum>=1.5?'#10b981':pfNum>=1?'#f59e0b':'#ef4444');
        html += '<tr>'
          + '<td><span class="badge-mode badge-'+m+'">'+m+'</span></td>'
          + '<td>'+sub.length+'</td>'
          + '<td style="color:#10b981;">'+wins.length+'</td>'
          + '<td style="color:#ef4444;">'+losses.length+'</td>'
          + '<td style="color:'+(parseFloat(wr)>=55?'#10b981':parseFloat(wr)>=45?'#f59e0b':'#ef4444')+';font-weight:700;">'+wr+'%</td>'
          + '<td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(pnl)+'</td>'
          + '<td style="color:#10b981;">'+fmtAna(aw)+'</td>'
          + '<td style="color:#ef4444;">'+fmtAna(al)+'</td>'
          + '<td style="color:'+pfCol+';font-weight:700;">'+pf+'</td>'
          + '<td style="color:'+(exp>=0?'#10b981':'#ef4444')+';">'+fmtAnaSigned(exp)+'</td>'
          + '</tr>';
        overall.count += sub.length; overall.wins += wins.length; overall.losses += losses.length;
        overall.pnl += pnl; overall.gp += gp; overall.gl += gl;
      });
      const wrAll = overall.count ? ((overall.wins/overall.count)*100).toFixed(1) : '0.0';
      const awAll = overall.wins ? Math.round(overall.gp/overall.wins) : 0;
      const alAll = overall.losses ? Math.round(overall.gl/overall.losses) : 0;
      const pfAll = overall.gl !== 0 ? (overall.gp/Math.abs(overall.gl)).toFixed(2) : (overall.gp>0?'∞':'—');
      const expAll = overall.count ? Math.round(overall.pnl/overall.count) : 0;
      const pcAll = overall.pnl>=0?'#10b981':'#ef4444';
      html += '<tr style="border-top:1px solid #0e1e36;background:rgba(59,130,246,0.04);">'
        + '<td style="font-weight:700;color:#60a5fa;">ALL</td>'
        + '<td style="font-weight:700;">'+overall.count+'</td>'
        + '<td style="color:#10b981;font-weight:700;">'+overall.wins+'</td>'
        + '<td style="color:#ef4444;font-weight:700;">'+overall.losses+'</td>'
        + '<td style="font-weight:700;">'+wrAll+'%</td>'
        + '<td style="color:'+pcAll+';font-weight:700;">'+fmtAnaSigned(overall.pnl)+'</td>'
        + '<td style="color:#10b981;">'+fmtAna(awAll)+'</td>'
        + '<td style="color:#ef4444;">'+fmtAna(alAll)+'</td>'
        + '<td style="font-weight:700;">'+pfAll+'</td>'
        + '<td style="color:'+(expAll>=0?'#10b981':'#ef4444')+';font-weight:700;">'+fmtAnaSigned(expAll)+'</td>'
        + '</tr>';
      anaEnhance('anaModeBody', html, '', {});
    }
  })();

  // ── Risk Metrics ──
  (function(){
    const wins = trades.filter(t=>t.pnl>0), losses = trades.filter(t=>t.pnl<0);
    const totalPnl = trades.reduce((s,t)=>s+(t.pnl||0),0);
    const gp = wins.reduce((s,t)=>s+t.pnl,0), gl = losses.reduce((s,t)=>s+t.pnl,0);
    const pf = gl !== 0 ? (gp/Math.abs(gl)).toFixed(2) : (gp>0?'∞':'—');
    const aw = wins.length ? Math.round(gp/wins.length) : 0;
    const al = losses.length ? Math.round(gl/losses.length) : 0;
    const exp = trades.length ? (totalPnl/trades.length) : 0;
    const payoff = (al !== 0) ? (Math.abs(aw)/Math.abs(al)).toFixed(2) : '—';
    let maxConsLoss = 0, cur = 0;
    trades.forEach(t => { if (t.pnl<0){ cur++; if (cur>maxConsLoss) maxConsLoss = cur; } else cur = 0; });
    const sortedPnl = trades.map(t=>t.pnl||0).sort((a,b)=>a-b);
    const p5 = sortedPnl[Math.floor(sortedPnl.length*0.05)] || 0;
    const p95 = sortedPnl[Math.floor(sortedPnl.length*0.95)] || 0;
    // Sharpe-like (per-trade)
    const mean = trades.length ? totalPnl/trades.length : 0;
    const variance = trades.length ? trades.reduce((s,t)=>s+Math.pow((t.pnl||0)-mean,2),0)/trades.length : 0;
    const stdev = Math.sqrt(variance);
    const sharpe = stdev > 0 ? (mean/stdev).toFixed(2) : '—';
    // Sortino-like
    const negs = trades.filter(t=>(t.pnl||0)<0).map(t=>t.pnl);
    const downVar = negs.length ? negs.reduce((s,v)=>s+v*v,0)/negs.length : 0;
    const downStd = Math.sqrt(downVar);
    const sortino = downStd > 0 ? (mean/downStd).toFixed(2) : '—';
    // Loss-after-loss
    let lossAfterLoss = 0, totalAfterLoss = 0;
    for (let i=1; i<trades.length; i++){ if ((trades[i-1].pnl||0)<0){ totalAfterLoss++; if ((trades[i].pnl||0)<0) lossAfterLoss++; } }
    const lalPct = totalAfterLoss ? ((lossAfterLoss/totalAfterLoss)*100).toFixed(0) : '—';
    const pfNum = parseFloat(pf);
    const pfCol = isNaN(pfNum) ? '#c8d8f0' : (pfNum>=1.5?'#10b981':pfNum>=1?'#f59e0b':'#ef4444');
    document.getElementById('anaRiskMetrics').innerHTML =
      '<div class="ana-stat"><span class="ana-stat-val" style="color:'+pfCol+';">'+pf+'</span><span class="ana-stat-label">Profit Factor</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:'+(exp>=0?'#10b981':'#ef4444')+';">'+fmtAnaSigned(exp)+'</span><span class="ana-stat-label">Expectancy / trade</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+fmtAna(aw)+'</span><span class="ana-stat-label">Avg Win</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+fmtAna(al)+'</span><span class="ana-stat-label">Avg Loss</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#60a5fa;">'+payoff+'</span><span class="ana-stat-label">Payoff (W/L)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+maxConsLoss+'</span><span class="ana-stat-label">Max consecutive losses</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:'+(parseFloat(lalPct)>=50?'#ef4444':'#10b981')+';">'+lalPct+'%</span><span class="ana-stat-label">Loss-after-loss %</span></div>'
      + '<div style="border-top:0.5px solid #0e1e36;margin:8px 0;padding-top:8px;">'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#60a5fa;">'+sharpe+'</span><span class="ana-stat-label">Sharpe-like (μ/σ)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#a855f7;">'+sortino+'</span><span class="ana-stat-label">Sortino-like</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+fmtAna(p95)+'</span><span class="ana-stat-label">95th pct (best case)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+fmtAna(Math.abs(p5))+'</span><span class="ana-stat-label">5th pct (worst case)</span></div>'
      + '</div>';
  })();

  // ── Win/Loss Streaks ──
  (function(){
    let maxWS=0, maxLS=0, curWS=0, curLS=0;
    const wsArr = [], lsArr = [];
    trades.forEach(t => {
      if (t.pnl>0){ curWS++; if (curLS>0) lsArr.push(curLS); curLS=0; if (curWS>maxWS) maxWS=curWS; }
      else if (t.pnl<0){ curLS++; if (curWS>0) wsArr.push(curWS); curWS=0; if (curLS>maxLS) maxLS=curLS; }
    });
    if (curWS>0) wsArr.push(curWS); if (curLS>0) lsArr.push(curLS);
    const avgW = wsArr.length ? (wsArr.reduce((a,b)=>a+b,0)/wsArr.length).toFixed(1) : '0';
    const avgL = lsArr.length ? (lsArr.reduce((a,b)=>a+b,0)/lsArr.length).toFixed(1) : '0';
    const dayMap = new Map();
    trades.forEach(t => { const d = t.date||'?'; dayMap.set(d, (dayMap.get(d)||0)+(t.pnl||0)); });
    let profDays=0, lossDays=0;
    for (const v of dayMap.values()){ if (v>=0) profDays++; else lossDays++; }
    const totalDays = profDays + lossDays;
    const avgDaily = totalDays ? Array.from(dayMap.values()).reduce((a,b)=>a+b,0)/totalDays : 0;
    document.getElementById('anaStreaks').innerHTML =
      '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+maxWS+'</span><span class="ana-stat-label">Best win streak</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+maxLS+'</span><span class="ana-stat-label">Worst loss streak</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#60a5fa;">'+avgW+'</span><span class="ana-stat-label">Avg win streak</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#f59e0b;">'+avgL+'</span><span class="ana-stat-label">Avg loss streak</span></div>'
      + '<div style="border-top:0.5px solid #0e1e36;margin:8px 0;padding-top:8px;">'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+profDays+'</span><span class="ana-stat-label">Profitable days ('+(totalDays?((profDays/totalDays)*100).toFixed(0):'0')+'%)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+lossDays+'</span><span class="ana-stat-label">Losing days ('+(totalDays?((lossDays/totalDays)*100).toFixed(0):'0')+'%)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:'+(avgDaily>=0?'#10b981':'#ef4444')+';">'+fmtAnaSigned(avgDaily)+'</span><span class="ana-stat-label">Avg daily P&amp;L</span></div>'
      + '</div>';
  })();

  // ── Day of Week ──
  (function(){
    const dow = {0:{n:'Sun',t:0,w:0,p:0},1:{n:'Mon',t:0,w:0,p:0},2:{n:'Tue',t:0,w:0,p:0},3:{n:'Wed',t:0,w:0,p:0},4:{n:'Thu',t:0,w:0,p:0},5:{n:'Fri',t:0,w:0,p:0},6:{n:'Sat',t:0,w:0,p:0}};
    trades.forEach(t => { const d=_dowOf(t); if (d==null) return; dow[d].t++; if (t.pnl>0) dow[d].w++; dow[d].p+=(t.pnl||0); });
    let html = '';
    [1,2,3,4,5].forEach(d => { const dd=dow[d]; if (!dd.t) return;
      const wr = ((dd.w/dd.t)*100).toFixed(0);
      const pc = dd.p>=0?'#10b981':'#ef4444';
      html += '<tr><td style="font-weight:600;">'+dd.n+'</td><td>'+dd.t+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(dd.p)+'</td><td style="color:'+pc+';">'+fmtAnaSigned(Math.round(dd.p/dd.t))+'</td></tr>';
    });
    anaEnhance('anaDowBody', html, '<tr><td colspan="5" style="text-align:center;color:#3a5070;">No data</td></tr>', {});
  })();

  // ── Equity Curve (per trade, oldest → newest by entry time) ──
  (function(){
    const sorted = trades.slice().sort((a,b) => {
      const ta = _parseTimeMs(a.entryTime), tb = _parseTimeMs(b.entryTime);
      if (ta!=null && tb!=null) return ta - tb;
      return (a.date||'').localeCompare(b.date||'');
    });
    let eq = 0;
    const data = sorted.map(t => (eq += (t.pnl||0)));
    const labels = sorted.map((_, i) => i+1);
    if (_anaCharts.equity) _anaCharts.equity.destroy();
    _anaCharts.equity = new Chart(document.getElementById('anaEquity'), {
      type: 'line',
      data: { labels, datasets: [{ data, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.10)', borderWidth: 1.5, fill: true, pointRadius: 0, tension: 0.25 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => 'Equity: '+fmtAna(c.raw) } } }, scales: { x: { display: false }, y: { ticks: { color: _tc, callback: v => fmtAnaShort(v) }, grid: { color: _gc } } } }),
    });
  })();

  // ── Monthly P&L (overall) ──
  (function(){
    const m = new Map();
    trades.forEach(t => { const k=_monthOf(t); if (!k) return; m.set(k, (m.get(k)||0)+(t.pnl||0)); });
    const keys = Array.from(m.keys()).sort();
    const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const labels = keys.map(k => monthNames[parseInt(k.slice(5,7),10)] + " '" + k.slice(2,4));
    const vals = keys.map(k => Math.round(m.get(k)));
    const colors = vals.map(v => v>=0?'#10b981':'#ef4444');
    if (_anaCharts.monthly) _anaCharts.monthly.destroy();
    _anaCharts.monthly = new Chart(document.getElementById('anaMonthly'), {
      type: 'bar',
      data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderRadius: 4, barPercentage: 0.7 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtAnaSigned(c.raw) } } } }),
    });
  })();

  // ── Drawdown ──
  (function(){
    const sorted = trades.slice().sort((a,b) => {
      const ta = _parseTimeMs(a.entryTime), tb = _parseTimeMs(b.entryTime);
      if (ta!=null && tb!=null) return ta - tb;
      return (a.date||'').localeCompare(b.date||'');
    });
    let eq=0, peak=0;
    const dd = [], labels = [];
    sorted.forEach((t,i) => { eq+=(t.pnl||0); if (eq>peak) peak=eq; dd.push(eq-peak); labels.push(i+1); });
    if (_anaCharts.dd) _anaCharts.dd.destroy();
    _anaCharts.dd = new Chart(document.getElementById('anaDrawdown'), {
      type: 'line',
      data: { labels, datasets: [{ data: dd, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 1.5, fill: true, pointRadius: 0, tension: 0.25 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => 'DD: '+fmtAna(c.raw) } } }, scales: { x: { display: false }, y: { ticks: { color: _tc, callback: v => fmtAnaShort(v) }, grid: { color: _gc } } } }),
    });
  })();

  // ── Hourly Performance ──
  (function(){
    const hourMap = {};
    trades.forEach(t => { const h=_hourOf(t); if (h==null) return; if (!hourMap[h]) hourMap[h]={pnl:0,cnt:0,wins:0}; hourMap[h].pnl+=(t.pnl||0); hourMap[h].cnt++; if (t.pnl>0) hourMap[h].wins++; });
    const hours = Object.keys(hourMap).map(Number).sort((a,b)=>a-b);
    const labels = hours.map(h => h+':00');
    const vals = hours.map(h => Math.round(hourMap[h].pnl));
    const colors = vals.map(v => v>=0 ? 'rgba(16,185,129,0.7)' : 'rgba(239,68,68,0.7)');
    if (_anaCharts.hourly) _anaCharts.hourly.destroy();
    _anaCharts.hourly = new Chart(document.getElementById('anaHourly'), {
      type: 'bar',
      data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderRadius: 4, barPercentage: 0.7 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { title: c => { const h = hours[c[0].dataIndex]; return h+':00 ('+hourMap[h].cnt+' trades, '+((hourMap[h].wins/hourMap[h].cnt)*100).toFixed(0)+'% WR)'; }, label: c => fmtAnaSigned(c.raw) } } } }),
    });
  })();

  // ── Entry Reason Breakdown ──
  (function(){
    const map = new Map();
    trades.forEach(t => {
      let r = (t.entryReason || 'Unknown'); if (r.length > 60) r = r.slice(0,60)+'…';
      const key = r + '|' + t.mode;
      if (!map.has(key)) map.set(key, { reason: r, mode: t.mode, cnt: 0, wins: 0, losses: 0, pnl: 0 });
      const b = map.get(key);
      b.cnt++; b.pnl += (t.pnl||0);
      if (t.pnl>0) b.wins++; else if (t.pnl<0) b.losses++;
    });
    const rows = Array.from(map.values()).sort((a,b)=>b.cnt-a.cnt);
    let html = '';
    rows.forEach(d => {
      const pc = d.pnl>=0?'#10b981':'#ef4444';
      const wr = d.cnt ? ((d.wins/d.cnt)*100).toFixed(0) : '0';
      html += '<tr>'
        + '<td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(d.reason)+'">'+esc(d.reason)+'</td>'
        + '<td><span class="badge-mode badge-'+d.mode+'">'+d.mode+'</span></td>'
        + '<td>'+d.cnt+'</td>'
        + '<td style="color:#10b981;">'+d.wins+'</td>'
        + '<td style="color:#ef4444;">'+d.losses+'</td>'
        + '<td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td>'
        + '<td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td>'
        + '<td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td>'
        + '</tr>';
    });
    anaEnhance('anaEntryBody', html, '<tr><td colspan="8" style="text-align:center;color:#3a5070;">No data</td></tr>', { filter:true, pager:true });
  })();

  // ── Exit Reason Breakdown ──
  (function(){
    const map = new Map();
    trades.forEach(t => {
      const r = t.exitReason || 'Unknown';
      const key = r + '|' + t.mode;
      if (!map.has(key)) map.set(key, { reason: r, mode: t.mode, cnt: 0, pnl: 0 });
      const b = map.get(key); b.cnt++; b.pnl += (t.pnl||0);
    });
    const rows = Array.from(map.values()).sort((a,b) => b.pnl - a.pnl);
    let html = '';
    rows.forEach(d => {
      const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(d.reason)+'">'+esc(d.reason)+'</td>'
        + '<td><span class="badge-mode badge-'+d.mode+'">'+d.mode+'</span></td>'
        + '<td>'+d.cnt+'</td>'
        + '<td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td>'
        + '<td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td></tr>';
    });
    anaEnhance('anaExitBody', html, '<tr><td colspan="5" style="text-align:center;color:#3a5070;">No data</td></tr>', { filter:true, pager:true });
  })();

  // ── Loss Distribution ──
  (function(){
    const lossTrades = trades.filter(t => t.pnl<0);
    if (_anaCharts.lossDist) _anaCharts.lossDist.destroy();
    if (!lossTrades.length){
      _anaCharts.lossDist = new Chart(document.getElementById('anaLossDist'), { type: 'bar', data: { labels: [], datasets: [{ data: [] }] }, options: baseChartOpts() });
      return;
    }
    const vals = lossTrades.map(t => Math.abs(t.pnl)).sort((a,b)=>a-b);
    const maxV = vals[vals.length-1];
    const buckets = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(vals.length))));
    let step = Math.ceil(maxV/buckets/100)*100; if (step<1) step=1;
    const bins = new Array(buckets).fill(0), labels = [];
    for (let i=0;i<buckets;i++) labels.push(fmtAnaShort(i*step)+'–'+fmtAnaShort((i+1)*step));
    vals.forEach(v => { const idx = Math.min(Math.floor(v/step), buckets-1); bins[idx]++; });
    _anaCharts.lossDist = new Chart(document.getElementById('anaLossDist'), {
      type: 'bar',
      data: { labels, datasets: [{ data: bins, backgroundColor: 'rgba(239,68,68,0.6)', borderRadius: 4, barPercentage: 0.85 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.raw+' trades ('+((c.raw/lossTrades.length)*100).toFixed(0)+'%)' } } }, scales: { x: { ticks: { color: _tc, font: { size: 9, family: 'IBM Plex Mono' }, maxRotation: 45 }, grid: { display: false } }, y: { ticks: { color: _tc, stepSize: 1 }, grid: { color: _gc } } } }),
    });
  })();

  // ── CE vs PE Performance (overall) ──
  (function(){
    const sides = { CE: { wins: 0, losses: 0, winPnl: 0, lossPnl: 0, total: 0 }, PE: { wins: 0, losses: 0, winPnl: 0, lossPnl: 0, total: 0 } };
    trades.forEach(t => { const s = t.side; if (!sides[s]) return; sides[s].total++; if (t.pnl>0){ sides[s].wins++; sides[s].winPnl+=t.pnl; } else if (t.pnl<0){ sides[s].losses++; sides[s].lossPnl+=t.pnl; } });
    const labels = ['CE','PE'].map(s => s+' ('+sides[s].total+' · '+((sides[s].wins/Math.max(sides[s].total,1))*100).toFixed(0)+'% WR)');
    const winPnl = ['CE','PE'].map(s => Math.round(sides[s].winPnl));
    const lossPnl = ['CE','PE'].map(s => Math.round(sides[s].lossPnl));
    const net = ['CE','PE'].map(s => Math.round(sides[s].winPnl + sides[s].lossPnl));
    if (_anaCharts.side) _anaCharts.side.destroy();
    _anaCharts.side = new Chart(document.getElementById('anaSidePerf'), {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Win P&L',  data: winPnl,  backgroundColor: 'rgba(16,185,129,0.65)', borderRadius: 4, barPercentage: 0.6 },
        { label: 'Loss P&L', data: lossPnl, backgroundColor: 'rgba(239,68,68,0.65)', borderRadius: 4, barPercentage: 0.6 },
        { label: 'Net P&L',  data: net,     backgroundColor: net.map(v => v>=0?'rgba(59,130,246,0.65)':'rgba(245,158,11,0.65)'), borderRadius: 4, barPercentage: 0.6 },
      ] },
      options: baseChartOpts({ plugins: { legend: { labels: { color: _tc, font: { size: 9, family: 'IBM Plex Mono' } } } } }),
    });
  })();

  // ── Top 10 Worst Trades ──
  (function(){
    const worst = trades.filter(t=>t.pnl<0).sort((a,b)=>a.pnl-b.pnl).slice(0,10);
    let html = '';
    worst.forEach(t => {
      html += '<tr><td>'+(t.date||'—')+'</td><td><span class="badge-mode badge-'+t.mode+'">'+t.mode+'</span></td><td><span class="badge '+(t.side==='CE'?'badge-ce':'badge-pe')+'">'+(t.side||'—')+'</span></td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(t.pnl)+'</td><td style="font-size:0.65rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(t.exitReason)+'">'+esc(t.exitReason||'—')+'</td></tr>';
    });
    anaEnhance('anaWorstBody', html, '<tr><td colspan="5" style="text-align:center;color:#3a5070;">No losing trades</td></tr>', {});
  })();

  // ── Consecutive Loss Streaks ──
  (function(){
    const streaks = []; let cur = [];
    trades.forEach((t,i) => { if (t.pnl<0) cur.push({t,i}); else { if (cur.length>=2) streaks.push(cur.slice()); cur = []; } });
    if (cur.length>=2) streaks.push(cur.slice());
    streaks.sort((a,b) => a.reduce((s,c)=>s+c.t.pnl,0) - b.reduce((s,c)=>s+c.t.pnl,0));
    let html = '';
    streaks.slice(0,10).forEach(s => {
      const total = s.reduce((sum,c)=>sum+c.t.pnl,0);
      const avg = total / s.length;
      html += '<tr><td>'+(s[0].t.date||'—')+'</td><td>'+s.length+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(total)+'</td><td style="color:#ef4444;">'+fmtAnaSigned(avg)+'</td></tr>';
    });
    anaEnhance('anaLossStreakBody', html, '<tr><td colspan="4" style="text-align:center;color:#3a5070;">No loss streaks (2+)</td></tr>', { pager:true });
  })();

  // ── Worst/Best Trading Days ──
  (function(){
    const m = new Map();
    trades.forEach(t => { const d=t.date||'?'; if (!m.has(d)) m.set(d, { date: d, trades: 0, pnl: 0, losses: 0, wins: 0, worst: 0, best: 0 }); const b=m.get(d); b.trades++; b.pnl+=(t.pnl||0); if (t.pnl<0){ b.losses++; if (t.pnl<b.worst) b.worst=t.pnl; } if (t.pnl>0){ b.wins++; if (t.pnl>b.best) b.best=t.pnl; } });
    const arr = Array.from(m.values());
    const lossDays = arr.filter(d=>d.pnl<0).sort((a,b)=>a.pnl-b.pnl).slice(0,10);
    let html = '';
    lossDays.forEach(d => { html += '<tr><td>'+d.date+'</td><td>'+d.trades+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td>'+d.losses+'</td><td style="color:#ef4444;">'+fmtAnaSigned(d.worst)+'</td></tr>'; });
    anaEnhance('anaWorstDayBody', html, '<tr><td colspan="5" style="text-align:center;color:#3a5070;">No losing days</td></tr>', { filter:true, pager:true });
    const winDays = arr.filter(d=>d.pnl>0).sort((a,b)=>b.pnl-a.pnl).slice(0,10);
    let html2 = '';
    winDays.forEach(d => { html2 += '<tr><td>'+d.date+'</td><td>'+d.trades+'</td><td style="color:#10b981;font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td>'+d.wins+'</td><td style="color:#10b981;">'+fmtAnaSigned(d.best)+'</td></tr>'; });
    anaEnhance('anaBestDayBody', html2, '<tr><td colspan="5" style="text-align:center;color:#3a5070;">No winning days</td></tr>', { filter:true, pager:true });
  })();

  // ── Loss by Exit Reason ──
  (function(){
    const lossTrades = trades.filter(t=>t.pnl<0);
    const m = new Map();
    lossTrades.forEach(t => { const r = t.exitReason||'Unknown'; if (!m.has(r)) m.set(r, { cnt: 0, pnl: 0 }); const b = m.get(r); b.cnt++; b.pnl += t.pnl; });
    const rows = Array.from(m.entries()).sort((a,b) => a[1].pnl - b[1].pnl);
    let html = '';
    rows.forEach(([r,d]) => {
      const pct = ((d.cnt/Math.max(lossTrades.length,1))*100).toFixed(0);
      html += '<tr><td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(r)+'">'+esc(r)+'</td><td>'+d.cnt+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td style="color:#ef4444;">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td><td style="font-weight:600;">'+pct+'%</td></tr>';
    });
    anaEnhance('anaLossReasonBody', html, '<tr><td colspan="5" style="text-align:center;color:#3a5070;">No losses</td></tr>', {});
  })();

  // ── Losing Hours / Winning Hours ──
  (function(){
    const m = {};
    trades.forEach(t => { const h=_hourOf(t); if (h==null) return; if (!m[h]) m[h]={total:0,wins:0,losses:0,winPnl:0,lossPnl:0}; m[h].total++; if (t.pnl>0){ m[h].wins++; m[h].winPnl+=t.pnl; } else if (t.pnl<0){ m[h].losses++; m[h].lossPnl+=t.pnl; } });
    const hours = Object.keys(m).map(Number).sort((a,b)=>a-b);
    let lh = '', wh = '';
    hours.forEach(h => {
      const d = m[h];
      if (d.losses > 0){
        const pct = ((d.losses/d.total)*100).toFixed(0);
        const col = parseFloat(pct)>=60?'#ef4444':parseFloat(pct)>=45?'#f59e0b':'#10b981';
        lh += '<tr><td style="font-weight:600;">'+h+':00</td><td>'+d.losses+' / '+d.total+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(d.lossPnl)+'</td><td style="color:#ef4444;">'+fmtAnaSigned(Math.round(d.lossPnl/d.losses))+'</td><td style="color:'+col+';font-weight:700;">'+pct+'%</td></tr>';
      }
      if (d.wins > 0){
        const pct = ((d.wins/d.total)*100).toFixed(0);
        const col = parseFloat(pct)>=60?'#10b981':parseFloat(pct)>=45?'#f59e0b':'#ef4444';
        wh += '<tr><td style="font-weight:600;">'+h+':00</td><td>'+d.wins+' / '+d.total+'</td><td style="color:#10b981;font-weight:700;">'+fmtAnaSigned(d.winPnl)+'</td><td style="color:#10b981;">'+fmtAnaSigned(Math.round(d.winPnl/d.wins))+'</td><td style="color:'+col+';font-weight:700;">'+pct+'%</td></tr>';
      }
    });
    anaEnhance('anaLossHourBody', lh, '<tr><td colspan="5" style="text-align:center;color:#3a5070;">No data</td></tr>', {});
    anaEnhance('anaWinHourBody', wh, '<tr><td colspan="5" style="text-align:center;color:#3a5070;">No data</td></tr>', {});
  })();

  // ── Top 10 Best Trades ──
  (function(){
    const best = trades.filter(t=>t.pnl>0).sort((a,b)=>b.pnl-a.pnl).slice(0,10);
    let html = '';
    best.forEach(t => {
      html += '<tr><td>'+(t.date||'—')+'</td><td><span class="badge-mode badge-'+t.mode+'">'+t.mode+'</span></td><td><span class="badge '+(t.side==='CE'?'badge-ce':'badge-pe')+'">'+(t.side||'—')+'</span></td><td style="color:#10b981;font-weight:700;">'+fmtAnaSigned(t.pnl)+'</td><td style="font-size:0.65rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(t.exitReason)+'">'+esc(t.exitReason||'—')+'</td></tr>';
    });
    anaEnhance('anaBestBody', html, '<tr><td colspan="5" style="text-align:center;color:#3a5070;">No winning trades</td></tr>', {});
  })();

  // ── Cumulative P&L by Mode ──
  (function(){
    const modes = ['SWING','SCALP','PA'];
    const sorted = trades.slice().sort((a,b) => {
      const ta = _parseTimeMs(a.entryTime), tb = _parseTimeMs(b.entryTime);
      if (ta!=null && tb!=null) return ta - tb;
      return (a.date||'').localeCompare(b.date||'');
    });
    const labels = sorted.map((_,i)=>i+1);
    const dsets = modes.map(m => {
      let eq = 0;
      const data = sorted.map(t => { if (t.mode===m) eq += (t.pnl||0); return eq; });
      return { label: m, data, borderColor: _MODE_COLOR[m], backgroundColor: _MODE_COLOR[m]+'22', borderWidth: 1.5, fill: false, pointRadius: 0, tension: 0.25 };
    });
    if (_anaCharts.cumByMode) _anaCharts.cumByMode.destroy();
    _anaCharts.cumByMode = new Chart(document.getElementById('anaCumByMode'), {
      type: 'line',
      data: { labels, datasets: dsets },
      options: baseChartOpts({ plugins: { legend: { display: true, labels: { color: _tc, font: { size: 10, family: 'IBM Plex Mono' } } }, tooltip: { callbacks: { label: c => c.dataset.label+': '+fmtAna(c.raw) } } }, scales: { x: { display: false }, y: { ticks: { color: _tc, callback: v => fmtAnaShort(v) }, grid: { color: _gc } } } }),
    });
  })();

  // ── Monthly P&L stacked by mode ──
  (function(){
    const modes = ['SWING','SCALP','PA'];
    const monthsSet = new Set();
    const data = {}; modes.forEach(m => data[m] = new Map());
    trades.forEach(t => { const k=_monthOf(t); if (!k) return; monthsSet.add(k); if (!data[t.mode]) return; data[t.mode].set(k, (data[t.mode].get(k)||0) + (t.pnl||0)); });
    const keys = Array.from(monthsSet).sort();
    const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const labels = keys.map(k => monthNames[parseInt(k.slice(5,7),10)] + " '" + k.slice(2,4));
    const dsets = modes.map(m => ({ label: m, data: keys.map(k => Math.round(data[m].get(k)||0)), backgroundColor: _MODE_COLOR[m], borderRadius: 3 }));
    if (_anaCharts.monthlyStacked) _anaCharts.monthlyStacked.destroy();
    _anaCharts.monthlyStacked = new Chart(document.getElementById('anaMonthlyStacked'), {
      type: 'bar',
      data: { labels, datasets: dsets },
      options: baseChartOpts({ plugins: { legend: { display: true, labels: { color: _tc, font: { size: 10, family: 'IBM Plex Mono' } } }, tooltip: { callbacks: { label: c => c.dataset.label+': '+fmtAnaSigned(c.raw) } } }, scales: { x: { stacked: true, ticks: { color: _tc, font: { size: 9, family: 'IBM Plex Mono' } }, grid: { display: false } }, y: { stacked: true, ticks: { color: _tc, callback: v => fmtAnaShort(v) }, grid: { color: _gc } } } }),
    });
  })();

  // ── P&L Distribution (all trades, signed) ──
  (function(){
    if (!trades.length){ if (_anaCharts.pnlDist) _anaCharts.pnlDist.destroy(); return; }
    const vals = trades.map(t => t.pnl||0);
    const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    const span = mx - mn;
    const buckets = Math.min(20, Math.max(8, Math.ceil(Math.sqrt(vals.length))));
    const step = span > 0 ? span/buckets : 1;
    const bins = new Array(buckets).fill(0), labels = [], colors = [];
    for (let i=0;i<buckets;i++){
      const lo = mn + i*step, hi = lo + step;
      labels.push(fmtAnaShort(lo) + '…' + fmtAnaShort(hi));
      colors.push((lo+hi)/2 >= 0 ? 'rgba(16,185,129,0.6)' : 'rgba(239,68,68,0.6)');
    }
    vals.forEach(v => { const idx = Math.min(buckets-1, Math.max(0, Math.floor((v-mn)/step))); bins[idx]++; });
    if (_anaCharts.pnlDist) _anaCharts.pnlDist.destroy();
    _anaCharts.pnlDist = new Chart(document.getElementById('anaPnlDist'), {
      type: 'bar',
      data: { labels, datasets: [{ data: bins, backgroundColor: colors, borderRadius: 3, barPercentage: 0.9 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.raw+' trades ('+((c.raw/vals.length)*100).toFixed(1)+'%)' } } }, scales: { x: { ticks: { color: _tc, font: { size: 8, family: 'IBM Plex Mono' }, maxRotation: 60 }, grid: { display: false } }, y: { ticks: { color: _tc, stepSize: 1 }, grid: { color: _gc } } } }),
    });
  })();

  // ── Rolling 30-trade WR ──
  (function(){
    const sorted = trades.slice().sort((a,b) => {
      const ta = _parseTimeMs(a.entryTime), tb = _parseTimeMs(b.entryTime);
      if (ta!=null && tb!=null) return ta - tb;
      return (a.date||'').localeCompare(b.date||'');
    });
    const WIN = 30;
    const labels = [], data = [];
    for (let i=0; i<sorted.length; i++){
      const start = Math.max(0, i - WIN + 1);
      const slice = sorted.slice(start, i+1);
      const w = slice.filter(t=>t.pnl>0).length;
      labels.push(i+1);
      data.push(slice.length ? +((w/slice.length)*100).toFixed(1) : 0);
    }
    if (_anaCharts.rollWr) _anaCharts.rollWr.destroy();
    _anaCharts.rollWr = new Chart(document.getElementById('anaRollWr'), {
      type: 'line',
      data: { labels, datasets: [{ data, borderColor: '#a855f7', backgroundColor: 'rgba(168,85,247,0.10)', borderWidth: 1.5, fill: true, pointRadius: 0, tension: 0.25 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => 'WR: '+c.raw+'%' } } }, scales: { x: { display: false }, y: { min: 0, max: 100, ticks: { color: _tc, callback: v => v+'%' }, grid: { color: _gc } } } }),
    });
  })();

  // ── Trade Duration Distribution + buckets table ──
  (function(){
    const durs = trades.map(t => ({ d: _durMin(t), p: t.pnl||0 })).filter(x => x.d != null);
    if (_anaCharts.durDist) _anaCharts.durDist.destroy();
    if (!durs.length){
      anaEnhance('anaDurBody', '', '<tr><td colspan="6" style="text-align:center;color:#3a5070;">No duration data</td></tr>', {});
      _anaCharts.durDist = new Chart(document.getElementById('anaDurDist'), { type: 'bar', data: { labels: [], datasets: [{ data: [] }] }, options: baseChartOpts() });
      return;
    }
    const buckets = [
      { lbl: '0–5m',     min: 0,    max: 5 },
      { lbl: '5–15m',    min: 5,    max: 15 },
      { lbl: '15–30m',   min: 15,   max: 30 },
      { lbl: '30–60m',   min: 30,   max: 60 },
      { lbl: '1–2h',     min: 60,   max: 120 },
      { lbl: '2–4h',     min: 120,  max: 240 },
      { lbl: '4h+',      min: 240,  max: Infinity },
    ];
    const bins = buckets.map(()=> ({ cnt: 0, wins: 0, pnl: 0 }));
    durs.forEach(x => { for (let i=0;i<buckets.length;i++){ if (x.d >= buckets[i].min && x.d < buckets[i].max){ bins[i].cnt++; if (x.p>0) bins[i].wins++; bins[i].pnl+=x.p; break; } } });
    const labels = buckets.map(b => b.lbl);
    const cntVals = bins.map(b => b.cnt);
    const cntCols = bins.map(b => b.pnl>=0 ? 'rgba(16,185,129,0.6)' : 'rgba(239,68,68,0.6)');
    _anaCharts.durDist = new Chart(document.getElementById('anaDurDist'), {
      type: 'bar',
      data: { labels, datasets: [{ data: cntVals, backgroundColor: cntCols, borderRadius: 4, barPercentage: 0.75 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => bins[c.dataIndex].cnt+' trades · P&L '+fmtAnaSigned(bins[c.dataIndex].pnl) } } }, scales: { x: { ticks: { color: _tc, font: { size: 9, family: 'IBM Plex Mono' } }, grid: { display: false } }, y: { ticks: { color: _tc, stepSize: 1 }, grid: { color: _gc } } } }),
    });
    let html = '';
    buckets.forEach((b,i) => { const d=bins[i]; if (!d.cnt) return; const wr = ((d.wins/d.cnt)*100).toFixed(0); const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="font-weight:600;">'+b.lbl+'</td><td>'+d.cnt+'</td><td style="color:#10b981;">'+d.wins+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td></tr>'; });
    anaEnhance('anaDurBody', html, '<tr><td colspan="6" style="text-align:center;color:#3a5070;">No duration data</td></tr>', {});
  })();

  // ── NIFTY spot move (points) distribution ──
  (function(){
    const moves = [];
    trades.forEach(t => {
      const e = t.spotAtEntry, x = t.spotAtExit;
      if (typeof e !== 'number' || typeof x !== 'number' || !t.side) return;
      const m = (t.side === 'PE') ? (e - x) : (x - e);
      moves.push(m);
    });
    if (_anaCharts.spotMove) _anaCharts.spotMove.destroy();
    if (!moves.length){
      _anaCharts.spotMove = new Chart(document.getElementById('anaSpotMove'), { type: 'bar', data: { labels: [], datasets: [{ data: [] }] }, options: baseChartOpts() });
      return;
    }
    const mn = Math.min.apply(null, moves), mx = Math.max.apply(null, moves);
    const span = mx - mn || 1;
    const buckets = Math.min(16, Math.max(6, Math.ceil(Math.sqrt(moves.length))));
    const step = span/buckets;
    const bins = new Array(buckets).fill(0), labels = [], colors = [];
    for (let i=0;i<buckets;i++){ const lo = mn + i*step, hi = lo + step; labels.push(lo.toFixed(0)+'…'+hi.toFixed(0)); colors.push((lo+hi)/2 >= 0 ? 'rgba(16,185,129,0.6)' : 'rgba(239,68,68,0.6)'); }
    moves.forEach(v => { const idx = Math.min(buckets-1, Math.max(0, Math.floor((v-mn)/step))); bins[idx]++; });
    _anaCharts.spotMove = new Chart(document.getElementById('anaSpotMove'), {
      type: 'bar',
      data: { labels, datasets: [{ data: bins, backgroundColor: colors, borderRadius: 3, barPercentage: 0.9 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.raw+' trades ('+((c.raw/moves.length)*100).toFixed(1)+'%)' } } }, scales: { x: { ticks: { color: _tc, font: { size: 8, family: 'IBM Plex Mono' }, maxRotation: 60 }, grid: { display: false } }, y: { ticks: { color: _tc, stepSize: 1 }, grid: { color: _gc } } } }),
    });
  })();

  // ── Day × Hour Heatmap (Net P&L) ──
  (function(){
    const cells = {};
    trades.forEach(t => { const dow=_dowOf(t), h=_hourOf(t); if (dow==null || h==null) return; const k = dow+'_'+h; cells[k] = (cells[k]||0) + (t.pnl||0); });
    const hours = [9,10,11,12,13,14,15];
    const days = [{i:1,n:'Mon'},{i:2,n:'Tue'},{i:3,n:'Wed'},{i:4,n:'Thu'},{i:5,n:'Fri'}];
    let absMax = 1;
    Object.values(cells).forEach(v => { if (Math.abs(v) > absMax) absMax = Math.abs(v); });
    function col(v){
      if (!v) return 'rgba(74,96,128,0.10)';
      const ratio = Math.min(1, Math.abs(v)/absMax);
      const alpha = (0.15 + 0.6*ratio).toFixed(2);
      return v>0 ? 'rgba(16,185,129,'+alpha+')' : 'rgba(239,68,68,'+alpha+')';
    }
    let html = '<table style="border-collapse:collapse;width:100%;font-size:0.6rem;font-family:IBM Plex Mono,monospace;"><thead><tr><th style="padding:4px;color:'+_tc+';">Day\\\\Hr</th>';
    hours.forEach(h => { html += '<th style="padding:4px;color:'+_tc+';">'+h+':00</th>'; });
    html += '</tr></thead><tbody>';
    days.forEach(d => {
      html += '<tr><td style="padding:4px;color:#c8d8f0;font-weight:600;">'+d.n+'</td>';
      hours.forEach(h => { const v = cells[d.i+'_'+h] || 0; const c = col(v); const lbl = v ? fmtAnaShort(v) : '·'; const tc = !v ? '#3a5070' : (v>=0?'#10b981':'#ef4444');
        html += '<td style="padding:6px 4px;background:'+c+';color:'+tc+';text-align:center;border:1px solid '+_gc+';font-weight:700;" title="'+d.n+' '+h+':00 — '+fmtAnaSigned(v)+'">'+lbl+'</td>'; });
      html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('anaHeatmap').innerHTML = html;
  })();

  // ── Weekly Performance ──
  (function(){
    const m = new Map();
    trades.forEach(t => { const k = weekKey(t.date); if (!k) return; if (!m.has(k)) m.set(k, { key: k, trades: 0, wins: 0, pnl: 0 }); const b=m.get(k); b.trades++; if (t.pnl>0) b.wins++; b.pnl += (t.pnl||0); });
    const rows = Array.from(m.values()).sort((a,b)=>b.key.localeCompare(a.key));
    let html = '';
    rows.forEach(d => { const wr = d.trades ? ((d.wins/d.trades)*100).toFixed(0) : '0'; const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="font-weight:600;">'+d.key+'</td><td>'+d.trades+'</td><td style="color:#10b981;">'+d.wins+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.trades))+'</td></tr>'; });
    anaEnhance('anaWeeklyBody', html, '<tr><td colspan="6" style="text-align:center;color:#3a5070;">No data</td></tr>', { filter:true, pager:true });
  })();

  // ── Drawdown stats ──
  (function(){
    const sorted = trades.slice().sort((a,b) => {
      const ta = _parseTimeMs(a.entryTime), tb = _parseTimeMs(b.entryTime);
      if (ta!=null && tb!=null) return ta - tb;
      return (a.date||'').localeCompare(b.date||'');
    });
    let eq = 0, peak = 0, maxDd = 0, maxDdEnd = -1;
    let inDd = false, ddLen = 0, maxDdLen = 0, curRecovery = 0, maxRecovery = 0;
    sorted.forEach((t,i) => {
      eq += (t.pnl||0);
      if (eq > peak){ peak = eq; if (inDd){ if (curRecovery > maxRecovery) maxRecovery = curRecovery; } inDd = false; ddLen = 0; curRecovery = 0; }
      else if (eq < peak){ inDd = true; ddLen++; curRecovery++; if (ddLen > maxDdLen) maxDdLen = ddLen; if (eq - peak < maxDd){ maxDd = eq - peak; maxDdEnd = i; } }
    });
    const totalPnl = eq;
    const ddPct = peak > 0 ? ((Math.abs(maxDd)/peak)*100).toFixed(1) : '—';
    document.getElementById('anaDdStats').innerHTML =
      '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+fmtAna(Math.abs(maxDd))+'</span><span class="ana-stat-label">Max drawdown</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#f59e0b;">'+ddPct+'%</span><span class="ana-stat-label">Max DD as % of peak</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#a855f7;">'+maxDdLen+'</span><span class="ana-stat-label">Longest DD (trades)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#60a5fa;">'+maxRecovery+'</span><span class="ana-stat-label">Longest recovery (trades)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:'+(totalPnl>=0?'#10b981':'#ef4444')+';">'+fmtAnaSigned(totalPnl)+'</span><span class="ana-stat-label">Final equity</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+fmtAna(peak)+'</span><span class="ana-stat-label">Peak equity</span></div>';
  })();

  // ── Top option symbols / strikes / expiries ──
  function _topTable(keyFn, bodyId){
    const m = new Map();
    trades.forEach(t => { const k = keyFn(t); if (k == null || k === '') return; if (!m.has(k)) m.set(k, { key: k, cnt: 0, wins: 0, pnl: 0 }); const b=m.get(k); b.cnt++; if (t.pnl>0) b.wins++; b.pnl += (t.pnl||0); });
    const rows = Array.from(m.values()).sort((a,b) => b.cnt - a.cnt);
    let html = '';
    rows.forEach(d => { const wr = d.cnt ? ((d.wins/d.cnt)*100).toFixed(0) : '0'; const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(d.key)+'">'+esc(d.key)+'</td><td>'+d.cnt+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td></tr>'; });
    anaEnhance(bodyId, html, '<tr><td colspan="4" style="text-align:center;color:#3a5070;">No data</td></tr>', { filter:true, pager:true });
  }
  _topTable(t => t.symbol, 'anaSymBody');
  _topTable(t => t.optionStrike, 'anaStrikeBody');
  _topTable(t => t.optionExpiry, 'anaExpiryBody');

  // ── Strategy variant breakdown ──
  (function(){
    const m = new Map();
    trades.forEach(t => { const s = t.strategy || 'default'; const k = s + '|' + t.mode; if (!m.has(k)) m.set(k, { strat: s, mode: t.mode, cnt: 0, wins: 0, pnl: 0 }); const b=m.get(k); b.cnt++; if (t.pnl>0) b.wins++; b.pnl += (t.pnl||0); });
    const rows = Array.from(m.values()).sort((a,b)=>b.cnt-a.cnt);
    let html = '';
    rows.forEach(d => { const wr = d.cnt ? ((d.wins/d.cnt)*100).toFixed(0) : '0'; const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(d.strat)+'">'+esc(d.strat)+'</td><td><span class="badge-mode badge-'+d.mode+'">'+d.mode+'</span></td><td>'+d.cnt+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td></tr>'; });
    anaEnhance('anaStratBody', html, '<tr><td colspan="6" style="text-align:center;color:#3a5070;">No data</td></tr>', { filter:true, pager:true });
  })();

  // ── Quantity Buckets ──
  (function(){
    const m = new Map();
    trades.forEach(t => { const q = t.qty || 0; if (!q) return; if (!m.has(q)) m.set(q, { q, cnt: 0, wins: 0, pnl: 0 }); const b=m.get(q); b.cnt++; if (t.pnl>0) b.wins++; b.pnl += (t.pnl||0); });
    const rows = Array.from(m.values()).sort((a,b) => a.q - b.q);
    let html = '';
    rows.forEach(d => { const wr = d.cnt ? ((d.wins/d.cnt)*100).toFixed(0) : '0'; const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="font-weight:600;">'+d.q+'</td><td>'+d.cnt+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td></tr>'; });
    anaEnhance('anaQtyBody', html, '<tr><td colspan="5" style="text-align:center;color:#3a5070;">No data</td></tr>', {});
  })();
}

wireTableControls();
applyFilters();
</script>
</body>
</html>`;

  res.send(html);
});

// JSON endpoint — used by dashboard cumulative P&L chart
router.get("/data", (req, res) => {
  const trades = loadAllTrades();
  res.json({ success: true, trades });
});

// ── Helper used in the outer HTML template (server-side) ──────────────────────
function fmtINR(n) {
  if (typeof n !== "number" || isNaN(n)) return "—";
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = router;

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
      const sessionDate = s.date || "";
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
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;vertical-align:middle;}
    .tbl tr:hover td{background:rgba(59,130,246,0.04);}
    .tbl-wrap{overflow-x:auto;max-height:560px;overflow-y:auto;border:0.5px solid #0e1e36;border-radius:10px;}
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
            <thead><tr><th>Date</th><th>Trades</th><th>P&amp;L</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h3>Monthly Roll-up</h3>
        <div class="tbl-wrap" style="max-height:300px;">
          <table class="tbl" id="monthlyTbl">
            <thead><tr><th>Month</th><th>Trades</th><th>P&amp;L</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h3>Yearly Roll-up</h3>
        <div class="tbl-wrap" style="max-height:300px;">
          <table class="tbl" id="yearlyTbl">
            <thead><tr><th>Year</th><th>Trades</th><th>P&amp;L</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>All Trades (Filtered)</h3>
      <div class="tbl-wrap">
        <table class="tbl" id="tradesTbl">
          <thead><tr>
            <th>#</th><th>Mode</th><th>Date</th><th>Side</th><th>Symbol</th><th>Qty</th>
            <th>Entry</th><th>Exit</th><th>Entry Time</th><th>Exit Time</th>
            <th>P&amp;L</th><th>Exit Reason</th><th>Copy</th>
          </tr></thead>
          <tbody></tbody>
        </table>
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

function renderRollupTable(id, rows){
  const tb = document.querySelector('#' + id + ' tbody');
  if (!rows.length){
    tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#4a6080;padding:18px;">No data</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((r, i) => \`
    <tr>
      <td style="font-weight:600;">\${r.key}</td>
      <td>\${r.count}</td>
      <td style="color:\${pnlColor(r.pnl)};font-weight:700;">\${r.pnl >= 0 ? '+' : ''}\${fmtINR(r.pnl)}</td>
      <td><button class="btn" onclick="copyBucket('\${id}', \${i})">📋</button></td>
    </tr>\`).join('');
}

function renderTradesTable(rows){
  const tb = document.querySelector('#tradesTbl tbody');
  const empty = document.getElementById('emptyState');
  if (!rows.length){
    tb.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tb.innerHTML = rows.map((t, i) => \`
    <tr>
      <td>\${i + 1}</td>
      <td><span class="badge-mode badge-\${t.mode}">\${t.mode}</span></td>
      <td>\${t.date || '—'}</td>
      <td><span class="badge \${t.side === 'CE' ? 'badge-ce' : 'badge-pe'}">\${t.side || '—'}</span></td>
      <td style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="\${esc(t.symbol)}">\${esc(t.symbol) || '—'}</td>
      <td>\${t.qty || '—'}</td>
      <td>\${fmtINR(t.entryPrice)}</td>
      <td>\${fmtINR(t.exitPrice)}</td>
      <td style="font-size:0.65rem;">\${esc(t.entryTime) || '—'}</td>
      <td style="font-size:0.65rem;">\${esc(t.exitTime) || '—'}</td>
      <td style="color:\${pnlColor(t.pnl)};font-weight:700;">\${t.pnl >= 0 ? '+' : ''}\${fmtINR(t.pnl)}</td>
      <td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:0.65rem;" title="\${esc(t.exitReason)}">\${esc(t.exitReason) || '—'}</td>
      <td><button class="btn" onclick="copyOne(\${i})">📋</button></td>
    </tr>\`).join('');
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
  const t = _lastFiltered[idx];
  if (!t) return;
  copyText(tradesToText([t], '# Trade'), event.target);
}

function copyBucket(tableId, idx){
  let list;
  if (tableId === 'dailyTbl')   list = _lastRollups.daily[idx];
  if (tableId === 'monthlyTbl') list = _lastRollups.monthly[idx];
  if (tableId === 'yearlyTbl')  list = _lastRollups.yearly[idx];
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
    labels.push((t.date || '') + (t.entryTime ? ' ' + t.entryTime.split(',')[0] : ''));
    data.push(cum);
  }
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const gridCol = isLight ? '#e0e4ea' : '#0e1e36';
  const tickCol = isLight ? '#64748b' : '#3a5070';
  if (_cumChart) _cumChart.destroy();
  _cumChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{
      data, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)',
      borderWidth: 2, fill: true, tension: 0.25, pointRadius: 0,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: tickCol, maxTicksLimit: 8, font: { size: 10 } }, grid: { color: gridCol } },
        y: { ticks: { color: tickCol, font: { size: 10 } }, grid: { color: gridCol } },
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

  renderRollupTable('dailyTbl',   _lastRollups.daily);
  renderRollupTable('monthlyTbl', _lastRollups.monthly);
  renderRollupTable('yearlyTbl',  _lastRollups.yearly);
  renderTradesTable(rows);
  renderCumChart(rows);

  const totalPnl = rows.reduce((a, t) => a + (t.pnl || 0), 0);
  document.getElementById('fCount').innerHTML =
    \`<strong>\${rows.length}</strong> trades · Net: <span style="color:\${pnlColor(totalPnl)};font-weight:700;">\${totalPnl >= 0 ? '+' : ''}\${fmtINR(totalPnl)}</span>\`;
}

function resetFilters(){
  ['fMode','fSide','fFrom','fTo','fSearch'].forEach(id => { document.getElementById(id).value = ''; });
  applyFilters();
}

applyFilters();
</script>
</body>
</html>`;

  res.send(html);
});

// ── Helper used in the outer HTML template (server-side) ──────────────────────
function fmtINR(n) {
  if (typeof n !== "number" || isNaN(n)) return "—";
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = router;

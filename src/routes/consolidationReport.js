/**
 * Consolidation Report — a printable, DAILY consolidated report of every recorded
 * trade (paper + live), rendered as one table with a row per trading day.
 *
 * Mirrors the Telegram "CONSOLIDATED DAY REPORT" layout (per-strategy trades + P&L,
 * then Total / Wins / Losses / Win rate / Net P&L) but for every day at once, in a
 * table you can filter (Book + the shared sharedNav date range) and export to PDF.
 *
 * Reached via the "📑 Consolidation Report" button on the Edge Analytics page — it
 * is NOT a separate sidebar menu item. Read-only: loads the same per-strategy session
 * files that /consolidation (paper) + /live-consolidation (live) use, flattens them,
 * embeds the trade array, and computes everything client-side so filters recompute
 * instantly with no server round-trip.
 *
 * Export: "🖨 Save as PDF" prints the report through a dedicated @media print
 * stylesheet (sidebar / toolbar / buttons hidden, white page, page-break-safe table).
 * No external PDF library — the browser's native print-to-PDF is used.
 *
 * Gated by UI_SHOW_CONSOLIDATION_REPORT (Settings → Menu Visibility). No new data
 * is written.
 */
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { buildSidebar, sidebarCSS, faviconLink, enabledStrategies,
        dateRangeOptionsHTML, dateRangeJS } = require("../utils/sharedNav");

const _HOME = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");

// Mirror the source maps used by consolidation.js (paper) + liveConsolidation.js (live).
const PAPER_SOURCES = [
  { mode: "EMA_RSI_ST", file: "ema_rsi_st_paper_trades.json" },
  { mode: "BB_RSI",     file: "bb_rsi_paper_trades.json" },
  { mode: "PA",         file: "pa_paper_trades.json" },
  { mode: "ORB",        file: "orb_paper_trades.json" },
  { mode: "EMA9VWAP",   file: "ema9vwap_paper_trades.json" },
  { mode: "TREND_PB",   file: "trend_pb_paper_trades.json" },
  { mode: "GAPS",       file: "gaps_paper_trades.json" },
];
const LIVE_SOURCES = [
  { mode: "EMA_RSI_ST", file: "ema_rsi_st_live_trades.json" },
  { mode: "BB_RSI",     file: "bb_rsi_live_trades.json" },
  { mode: "PA",         file: "pa_live_trades.json" },
  { mode: "ORB",        file: "orb_live_trades.json" },
  { mode: "EMA9VWAP",   file: "ema9vwap_live_trades.json" },
  { mode: "TREND_PB",   file: "trend_pb_live_trades.json" },
  { mode: "GAPS",       file: "gaps_live_trades.json" },
];

function safeRead(p) {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) { return {}; }
}

function loadBook(sources, book) {
  const out = [];
  for (const src of sources) {
    const data = safeRead(path.join(DATA_DIR, src.file));
    for (const s of (data.sessions || [])) {
      const sessionDate = String(s.date || "").slice(0, 10);
      for (const t of (s.trades || [])) {
        out.push({
          book,
          mode: src.mode,
          date: sessionDate,
          pnl:  Number(t.pnl) || 0,
          // VIX is market-wide, so any strategy's entry-VIX represents the day.
          // Kept per-trade here; byDay() averages the non-null values into one figure.
          vix:  (t.vixAtEntry != null && isFinite(Number(t.vixAtEntry))) ? Number(t.vixAtEntry) : null,
        });
      }
    }
  }
  return out;
}

// Cache the flattened trade list — same approach as consolidation.js / edgeAnalytics.js.
// Invalidate by a cheap mtime+size signature so a new trade is picked up immediately.
let _cache = null;
let _sig   = null;
function _sourcesSig() {
  let sig = "";
  for (const src of [...PAPER_SOURCES, ...LIVE_SOURCES]) {
    try { const st = fs.statSync(path.join(DATA_DIR, src.file)); sig += `${src.mode}:${st.mtimeMs}:${st.size}|`; }
    catch (_) { sig += `${src.mode}:0|`; }
  }
  return sig;
}
function loadAllTrades() {
  const sig = _sourcesSig();
  if (_cache && sig === _sig) return _cache;
  const trades = loadBook(PAPER_SOURCES, "paper").concat(loadBook(LIVE_SOURCES, "live"));
  trades.sort((a, b) => (a.date || "").localeCompare(b.date || "")); // oldest → newest
  _cache = trades;
  _sig   = sig;
  return trades;
}

router.get("/", (req, res) => {
  // Only report strategies that are enabled in Settings — a disabled strategy is
  // hidden from the sidebar, so its columns (and its trades in the day totals)
  // must not appear here either. Filtered per-request, never cached: Settings
  // saves mutate process.env while the process is running.
  const enabled     = enabledStrategies();
  const enabledSet  = new Set(enabled.map(s => s.mode));
  const trades      = loadAllTrades().filter(t => enabledSet.has(t.mode));
  const theme = (process.env.UI_THEME || "dark").toLowerCase();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>ௐ Palani Andawar Thunai ॐ — Consolidation Report</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script>(function(){ if ('${theme}' === 'light') document.documentElement.setAttribute('data-theme','light'); })();</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    .main-content{flex:1;margin-left:200px;padding:18px 22px 40px;min-width:0;min-height:100vh;}
    @media(max-width:900px){.main-content{margin-left:0;padding:14px;}}
    .page-title{font-size:1.1rem;font-weight:700;color:#e0eaf8;margin-bottom:2px;}
    .page-sub{font-size:0.72rem;color:#4a6080;margin-bottom:14px;}
    .page-sub a{color:#7dd3fc;text-decoration:none;}
    .tbar{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;margin-bottom:14px;flex-wrap:wrap;}
    .tbar label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:#3a5070;font-family:'IBM Plex Mono',monospace;}
    .tbar input,.tbar select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:6px 10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;outline:none;}
    .tbar input:focus,.tbar select:focus{border-color:#38bdf8;}
    .seg{display:inline-flex;border:0.5px solid #0e1e36;border-radius:6px;overflow:hidden;}
    .seg button{background:#04090f;border:none;color:#4a6080;padding:6px 12px;font-family:'IBM Plex Mono',monospace;font-size:0.7rem;cursor:pointer;}
    .seg button.on{background:#0c4a6e;color:#7dd3fc;}
    .pdf-btn{margin-left:auto;background:#0c4a6e;border:0.5px solid #1e5a80;color:#7dd3fc;padding:7px 14px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}
    .pdf-btn:hover{background:#0e5a84;}
    .rpt-head{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;}
    .rpt-head .rh-title{font-size:1rem;font-weight:700;color:#e0eaf8;}
    .rpt-head .rh-meta{font-family:'IBM Plex Mono',monospace;font-size:0.66rem;color:#4a6080;margin-top:4px;line-height:1.7;}
    .rpt-head .rh-meta b{color:#7dd3fc;font-weight:600;}
    .rpt-head .rh-brand{text-align:right;font-family:'IBM Plex Mono',monospace;font-size:0.66rem;color:#4a6080;}
    .stat-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:16px;}
    @media(max-width:1300px){.stat-grid{grid-template-columns:repeat(3,1fr);}}
    @media(max-width:560px){.stat-grid{grid-template-columns:repeat(2,1fr);}}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent,#38bdf8);}
    .sc-label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:5px;font-family:'IBM Plex Mono',monospace;}
    .sc-val{font-size:1.05rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#e0eaf8;}
    .sc-sub{font-size:0.6rem;color:#4a6080;margin-top:3px;}
    .panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
    .panel h3{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.4px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
    .tbl-scroll{overflow-x:auto;}
    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .tbl th{padding:8px 10px;text-align:right;font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;white-space:nowrap;}
    .tbl th:first-child{text-align:left;}
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;text-align:right;white-space:nowrap;vertical-align:top;}
    .tbl td:first-child{text-align:left;}
    .tbl tr:hover td{background:rgba(56,189,248,0.05);}
    .tbl tfoot td{border-top:1px solid #17324f;font-weight:700;color:#e0eaf8;background:#04090f;}
    .cnt{font-size:0.56rem;color:#4a6080;font-weight:400;}
    .muted{color:#2a3a52;}
    .badge-mode{padding:2px 6px;border-radius:4px;font-size:0.52rem;font-weight:700;letter-spacing:0.5px;}
    .badge-EMA_RSI_ST{background:rgba(59,130,246,0.12);color:#3b82f6;}
    .badge-BB_RSI{background:rgba(245,158,11,0.12);color:#f59e0b;}
    .badge-PA{background:rgba(168,85,247,0.12);color:#a855f7;}
    .badge-ORB{background:rgba(16,185,129,0.12);color:#10b981;}
    .badge-EMA9VWAP{background:rgba(6,182,212,0.12);color:#06b6d4;}
    .badge-TREND_PB{background:rgba(236,72,153,0.12);color:#ec4899;}
    .badge-GAPS{background:rgba(14,165,233,0.12);color:#0ea5e9;}
    .res-profit{color:#10b981;font-weight:700;}
    .res-loss{color:#ef4444;font-weight:700;}
    .res-flat{color:#4a6080;}
    .empty{text-align:center;padding:50px 20px;color:#4a6080;font-size:0.85rem;}
    /* light theme */
    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .page-title,:root[data-theme="light"] .rh-title{color:#1e293b!important;}
    :root[data-theme="light"] .page-sub,:root[data-theme="light"] .sc-label,:root[data-theme="light"] .sc-sub,:root[data-theme="light"] .panel h3,:root[data-theme="light"] .tbar label,:root[data-theme="light"] .rh-meta,:root[data-theme="light"] .rh-brand,:root[data-theme="light"] .cnt{color:#64748b!important;}
    :root[data-theme="light"] .sc,:root[data-theme="light"] .panel,:root[data-theme="light"] .rpt-head{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .sc-val{color:#1e293b!important;}
    :root[data-theme="light"] .tbar{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbar input,:root[data-theme="light"] .tbar select,:root[data-theme="light"] .seg button{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .seg button.on{background:#e0f2fe!important;color:#0369a1!important;}
    :root[data-theme="light"] .tbl th{background:#f1f5f9!important;color:#64748b!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbl td{border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .tbl tfoot td{background:#f1f5f9!important;color:#1e293b!important;}
    :root[data-theme="light"] .muted{color:#cbd5e1!important;}
    :root[data-theme="light"] .empty{color:#94a3b8!important;}
    /* ── PRINT / Save-as-PDF ─────────────────────────────────────────── */
    @media print {
      @page { size: A4 landscape; margin: 12mm; }
      body{background:#fff!important;color:#111!important;overflow:visible!important;}
      .sidebar,.hamburger,.sidebar-overlay,.deploy-chip,#socket-broken-banner,#telegram-broken-banner,#backup-nag-banner,.tbar,.pdf-btn,.page-sub a{display:none!important;}
      .app-shell{display:block!important;}
      .main-content{margin-left:0!important;padding:0!important;min-height:auto!important;}
      .rpt-head,.sc,.panel{background:#fff!important;border:1px solid #d0d7e2!important;box-shadow:none!important;break-inside:avoid;}
      .rh-title{color:#111!important;} .rh-meta,.rh-brand,.page-sub{color:#555!important;}
      .sc-val{color:#111!important;} .sc-label,.sc-sub,.panel h3{color:#555!important;}
      .tbl{font-size:0.6rem;} .tbl th{background:#eef2f7!important;color:#333!important;}
      .tbl td{color:#222!important;border-color:#d0d7e2!important;}
      .tbl tfoot td{background:#eef2f7!important;color:#111!important;}
      .tbl-scroll{overflow:visible!important;}
      .tbl tr{break-inside:avoid;}
      thead{display:table-header-group;}
    }
  </style>
</head>
<body>
<div class="app-shell">
  ${buildSidebar('consolidationReport', false)}
  <div class="main-content">
    <h1 class="page-title">📑 Consolidation Report</h1>
    <p class="page-sub">Day-by-day consolidated report of every recorded trade — per-strategy P&amp;L, wins/losses and net for each day. <a href="/edge-analytics">← Edge Analytics</a></p>

    <div class="tbar">
      <label>Book</label>
      <div class="seg" id="segBook">
        <button data-book="paper" class="on">Paper</button>
        <button data-book="live">Live</button>
        <button data-book="all">Both</button>
      </div>
      <label>Range</label>
      <select id="fRange">${dateRangeOptionsHTML('tm')}</select>
      <span id="customWrap" style="display:none;">
        <label>From</label><input type="date" id="fFrom"/>
        <label>To</label><input type="date" id="fTo"/>
      </span>
      <button class="pdf-btn" onclick="window.print()">🖨 Save as PDF</button>
    </div>

    <div id="content"></div>
  </div>
</div>

<script>
${dateRangeJS()}
const ALL = ${JSON.stringify(trades)};
const MODES = ${JSON.stringify(enabled.map(s => s.mode))};
const MODE_LABEL = ${JSON.stringify(Object.fromEntries(enabled.map(s => [s.mode, s.mode])))};

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function inr2(n){ return (n<0?'-':'')+'₹'+Math.abs(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function inr(n){ const v=Math.round(n); return (v<0?'-':'')+'₹'+Math.abs(v).toLocaleString('en-IN'); }
function pc(n){ return n>=0?'#10b981':'#ef4444'; }
function fmtVix(n){ return (n==null)?'<span class="muted">—</span>':n.toFixed(2); }

// 'YYYY-MM-DD' → "Tue, 14 Jul 2026"  (matches the Telegram day-report header)
function prettyDate(s){ const d=new Date(s+'T12:00:00'); if(isNaN(d)) return s; return d.toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short',year:'numeric'}); }

// Range bounds come from sharedNav's drRange() — the same resolver the Dashboard
// and Edge Analytics use, so "This month" means one thing across the whole app.
// The printed "Period:" line reads the option's own text rather than a private
// label map, which is what let this page's list drift from the others before.
function rangeLabelFor(range, from, to){
  if(range==='custom') return (from||'…')+' → '+(to||'…');
  const sel = document.getElementById('fRange');
  const txt = (sel.options[sel.selectedIndex] || {}).text || range;
  // The expiry cycle is the one range whose dates a reader can't infer, so spell it out.
  return range==='exp' ? txt+' ('+(from||'…')+' → '+(to||'today')+')' : txt;
}

function currentFilter(){
  const book = document.querySelector('#segBook button.on').dataset.book;
  const range = document.getElementById('fRange').value;
  const r = drRange(range, document.getElementById('fFrom').value, document.getElementById('fTo').value);
  return {book,from:r.from,to:r.to,rangeLabel:rangeLabelFor(range,r.from,r.to)};
}
function applyFilter(f){
  return ALL.filter(t=>{
    if(f.book!=='all' && t.book!==f.book) return false;
    if(f.from && t.date < f.from) return false;
    if(f.to   && t.date > f.to)   return false;
    return true;
  });
}

// Build one bucket per day: per-strategy {n,pnl} + totals {n,wins,losses,net}
function byDay(arr){
  const m=new Map();
  for(const t of arr){
    const d=t.date||'—';
    if(!m.has(d)) m.set(d,{ date:d, modes:{}, n:0, wins:0, losses:0, net:0, vixSum:0, vixCnt:0 });
    const g=m.get(d);
    if(!g.modes[t.mode]) g.modes[t.mode]={n:0,pnl:0};
    g.modes[t.mode].n++; g.modes[t.mode].pnl+=t.pnl;
    g.n++; g.net+=t.pnl;
    if(t.pnl>0) g.wins++; else if(t.pnl<0) g.losses++;
    if(t.vix!=null){ g.vixSum+=t.vix; g.vixCnt++; }
  }
  // Collapse the day's entry-VIX readings into one representative average.
  for(const g of m.values()) g.vix = g.vixCnt ? g.vixSum/g.vixCnt : null;
  return [...m.values()].sort((a,b)=>b.date.localeCompare(a.date)); // newest day first
}

function render(){
  const f=currentFilter();
  const arr=applyFilter(f);
  const C=document.getElementById('content');

  const bookLabel = f.book==='all'?'Paper + Live':(f.book==='live'?'Live':'Paper');
  const gen = new Date().toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'});
  const days = byDay(arr);

  // Only show strategy columns that actually traded in this range (keeps it narrow)
  const activeModes = MODES.filter(mo => arr.some(t => t.mode===mo));

  // overall totals
  let tN=0,tW=0,tL=0,tNet=0; const totByMode={};
  for(const mo of activeModes) totByMode[mo]={n:0,pnl:0};
  for(const t of arr){ tN++; tNet+=t.pnl; if(t.pnl>0)tW++; else if(t.pnl<0)tL++; if(totByMode[t.mode]){ totByMode[t.mode].n++; totByMode[t.mode].pnl+=t.pnl; } }
  const tWR = tN?(tW/tN*100):0;

  let head='<div class="rpt-head"><div>'
    +'<div class="rh-title">Consolidated Day Report</div>'
    +'<div class="rh-meta">Book: <b>'+bookLabel+'</b> &nbsp;·&nbsp; Period: <b>'+esc(f.rangeLabel)+'</b> &nbsp;·&nbsp; Trading days: <b>'+days.length+'</b> &nbsp;·&nbsp; Trades: <b>'+tN+'</b></div>'
    +'</div><div class="rh-brand">ௐ Palani Andawar Thunai ॐ<br>Generated '+esc(gen)+'</div></div>';

  if(!days.length){ C.innerHTML=head+'<div class="empty">No trades for this filter. Try widening the range or switching Book.</div>'; return; }

  // summary cards (mirror the Telegram totals block)
  const cards=[
    {l:'Total Trades',v:tN,sub:days.length+' trading days',a:'#38bdf8'},
    {l:'Wins',v:tW,sub:'',a:'#10b981'},
    {l:'Losses',v:tL,sub:'',a:'#ef4444'},
    {l:'Win Rate',v:tWR.toFixed(1)+'%',sub:'',a:tWR>=50?'#10b981':'#f59e0b'},
    {l:'Net P&L',v:inr(tNet),sub:tNet>=0?'🟢 PROFIT':'🔴 LOSS',a:pc(tNet)},
    {l:'Avg / Day',v:inr(days.length?tNet/days.length:0),sub:'per trading day',a:pc(tNet)},
  ];
  let h=head+'<div class="stat-grid">';
  for(const c of cards) h+='<div class="sc" style="--accent:'+c.a+'"><div class="sc-label">'+c.l+'</div><div class="sc-val" style="color:'+c.a+'">'+c.v+'</div><div class="sc-sub">'+c.sub+'</div></div>';
  h+='</div>';

  // the daily table
  let thead='<tr><th>Date</th><th>VIX</th>';
  for(const mo of activeModes) thead+='<th>'+esc(MODE_LABEL[mo])+'</th>';
  thead+='<th>Trades</th><th>W</th><th>L</th><th>Win%</th><th>Net P&amp;L</th><th>Result</th></tr>';

  let body='';
  for(const g of days){
    let row='<td>'+esc(prettyDate(g.date))+'</td><td>'+fmtVix(g.vix)+'</td>';
    for(const mo of activeModes){
      const c=g.modes[mo];
      if(!c || !c.n){ row+='<td class="muted">—</td>'; continue; }
      row+='<td><span style="color:'+pc(c.pnl)+'">'+inr2(c.pnl)+'</span><br><span class="cnt">'+c.n+' trade'+(c.n>1?'s':'')+'</span></td>';
    }
    const wr=g.n?(g.wins/g.n*100):0;
    const rc = g.net>0?'res-profit':(g.net<0?'res-loss':'res-flat');
    const rl = g.net>0?'🟢 PROFIT':(g.net<0?'🔴 LOSS':'— FLAT');
    row+='<td>'+g.n+'</td><td style="color:#10b981">'+g.wins+'</td><td style="color:#ef4444">'+g.losses+'</td><td>'+wr.toFixed(0)+'%</td>'
      +'<td style="color:'+pc(g.net)+';font-weight:700">'+inr2(g.net)+'</td><td class="'+rc+'">'+rl+'</td>';
    body+='<tr>'+row+'</tr>';
  }

  // totals footer — VIX averaged across the days that have a reading (equal weight per day)
  const vixDays = days.filter(g => g.vix != null);
  const avgVix  = vixDays.length ? vixDays.reduce((s,g)=>s+g.vix,0)/vixDays.length : null;
  let foot='<tr><td><b>TOTAL</b></td><td>'+fmtVix(avgVix)+'</td>';
  for(const mo of activeModes){ const c=totByMode[mo]; foot+='<td><span style="color:'+pc(c.pnl)+'">'+inr2(c.pnl)+'</span><br><span class="cnt">'+c.n+'</span></td>'; }
  foot+='<td>'+tN+'</td><td style="color:#10b981">'+tW+'</td><td style="color:#ef4444">'+tL+'</td><td>'+tWR.toFixed(0)+'%</td>'
    +'<td style="color:'+pc(tNet)+'">'+inr2(tNet)+'</td><td class="'+(tNet>=0?'res-profit':'res-loss')+'">'+(tNet>=0?'🟢':'🔴')+'</td></tr>';

  h+='<div class="panel"><h3>Daily Breakdown</h3><div class="tbl-scroll"><table class="tbl"><thead>'+thead+'</thead><tbody>'+body+'</tbody><tfoot>'+foot+'</tfoot></table></div></div>';
  C.innerHTML=h;
}

// wire controls
document.querySelectorAll('#segBook button').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('#segBook button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); render();
}));
document.getElementById('fRange').addEventListener('change',()=>{
  const range = document.getElementById('fRange').value;
  document.getElementById('customWrap').style.display = range==='custom'?'inline':'none';
  // Only 'Current week expiry' needs the expiry calendar — fetched on first use
  // and cached, so every later selection resolves without a round-trip.
  if(range==='exp'){ drReady().then(render); return; }
  render();
});
document.getElementById('fFrom').addEventListener('change',render);
document.getElementById('fTo').addEventListener('change',render);
render();
</script>
</body>
</html>`;
  res.send(html);
});

module.exports = router;

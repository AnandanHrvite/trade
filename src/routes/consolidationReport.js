/**
 * Consolidation Report — a single printable, filterable consolidated report of
 * every recorded trade (paper + live) across all strategies.
 *
 * Read-only. Loads the same per-strategy session files that /consolidation (paper)
 * and /live-consolidation (live) use, flattens them to one trade array (with the
 * richer per-trade fields the ledger needs), embeds it in the page, and computes
 * everything client-side so the Book / Strategy / Range / Group-by filters recompute
 * instantly with no server round-trip.
 *
 * Filters: Book (Paper / Live / Both), Strategy, and a Range preset covering
 * This week / Last week / This month / Last month / Last 7·30 days / This FY /
 * All time / Custom (from–to). A Group-by (Day / Week / Month / Strategy) drives
 * the period-breakdown table.
 *
 * Export: "Save as PDF" prints the report through a dedicated @media print
 * stylesheet (sidebar / toolbar / buttons hidden, white page, page-break-safe
 * tables). No external PDF library — the browser's native print-to-PDF is used.
 *
 * Gated by UI_SHOW_CONSOLIDATION_REPORT (Settings → Menu Visibility). No new data
 * is written.
 */
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");

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
];
const LIVE_SOURCES = [
  { mode: "EMA_RSI_ST", file: "ema_rsi_st_live_trades.json" },
  { mode: "BB_RSI",     file: "bb_rsi_live_trades.json" },
  { mode: "PA",         file: "pa_live_trades.json" },
  { mode: "ORB",        file: "orb_live_trades.json" },
  { mode: "EMA9VWAP",   file: "ema9vwap_live_trades.json" },
  { mode: "TREND_PB",   file: "trend_pb_live_trades.json" },
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
          mode:        src.mode,
          date:        sessionDate,
          side:        t.side || t.optionType || "",
          symbol:      t.symbol || "",
          qty:         t.qty || 0,
          entryPrice:  t.entryPrice,
          exitPrice:   t.exitPrice,
          entryTime:   t.entryTime || "",
          exitTime:    t.exitTime || "",
          pnl:         Number(t.pnl) || 0,
          exitReason:  t.exitReason || "",
        });
      }
    }
  }
  return out;
}

// Cache the flattened+sorted trade list — same approach as consolidation.js /
// edgeAnalytics.js. Invalidate by a cheap mtime+size signature so a new trade is
// picked up immediately without re-parsing when nothing changed.
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
  const trades = loadAllTrades();
  const theme = (process.env.UI_THEME || "dark").toLowerCase();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>ௐ Palani Andawar Thunai ॐ — Consolidation Report</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <script>(function(){ if ('${theme}' === 'light') document.documentElement.setAttribute('data-theme','light'); })();</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    .main-content{flex:1;margin-left:200px;padding:18px 22px 40px;min-width:0;min-height:100vh;}
    @media(max-width:900px){.main-content{margin-left:0;padding:14px;}}
    .page-title{font-size:1.1rem;font-weight:700;color:#e0eaf8;margin-bottom:2px;}
    .page-sub{font-size:0.72rem;color:#4a6080;margin-bottom:14px;}
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
    .chart-wrap{position:relative;height:230px;}
    .tbl-scroll{overflow-x:auto;}
    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .tbl th{padding:8px 10px;text-align:right;font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;white-space:nowrap;}
    .tbl th:first-child{text-align:left;}
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;text-align:right;white-space:nowrap;}
    .tbl td:first-child{text-align:left;}
    .tbl tr:hover td{background:rgba(56,189,248,0.05);}
    .tbl tfoot td{border-top:1px solid #17324f;font-weight:700;color:#e0eaf8;background:#04090f;}
    .badge-mode{padding:2px 7px;border-radius:4px;font-size:0.58rem;font-weight:700;letter-spacing:0.5px;}
    .badge-EMA_RSI_ST{background:rgba(59,130,246,0.12);color:#3b82f6;border:0.5px solid rgba(59,130,246,0.3);}
    .badge-BB_RSI{background:rgba(245,158,11,0.12);color:#f59e0b;border:0.5px solid rgba(245,158,11,0.3);}
    .badge-PA{background:rgba(168,85,247,0.12);color:#a855f7;border:0.5px solid rgba(168,85,247,0.3);}
    .badge-ORB{background:rgba(16,185,129,0.12);color:#10b981;border:0.5px solid rgba(16,185,129,0.3);}
    .badge-EMA9VWAP{background:rgba(6,182,212,0.12);color:#06b6d4;border:0.5px solid rgba(6,182,212,0.3);}
    .badge-TREND_PB{background:rgba(236,72,153,0.12);color:#ec4899;border:0.5px solid rgba(236,72,153,0.3);}
    .badge-book{padding:2px 6px;border-radius:4px;font-size:0.54rem;font-weight:700;letter-spacing:0.5px;}
    .badge-paper{background:rgba(56,189,248,0.10);color:#38bdf8;border:0.5px solid rgba(56,189,248,0.28);}
    .badge-live{background:rgba(239,68,68,0.10);color:#ef4444;border:0.5px solid rgba(239,68,68,0.28);}
    .empty{text-align:center;padding:50px 20px;color:#4a6080;font-size:0.85rem;}
    .ledger-wrap{max-height:640px;overflow:auto;}
    /* light theme */
    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .page-title,:root[data-theme="light"] .rh-title{color:#1e293b!important;}
    :root[data-theme="light"] .page-sub,:root[data-theme="light"] .sc-label,:root[data-theme="light"] .sc-sub,:root[data-theme="light"] .panel h3,:root[data-theme="light"] .tbar label,:root[data-theme="light"] .rh-meta,:root[data-theme="light"] .rh-brand{color:#64748b!important;}
    :root[data-theme="light"] .sc,:root[data-theme="light"] .panel,:root[data-theme="light"] .rpt-head{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .sc-val{color:#1e293b!important;}
    :root[data-theme="light"] .tbar{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbar input,:root[data-theme="light"] .tbar select,:root[data-theme="light"] .seg button{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .seg button.on{background:#e0f2fe!important;color:#0369a1!important;}
    :root[data-theme="light"] .tbl th{background:#f1f5f9!important;color:#64748b!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbl td{border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .tbl tfoot td{background:#f1f5f9!important;color:#1e293b!important;}
    :root[data-theme="light"] .empty{color:#94a3b8!important;}
    /* ── PRINT / Save-as-PDF ─────────────────────────────────────────────
       Hide the app chrome, force a light print theme, keep tables page-safe. */
    @media print {
      @page { size: A4 landscape; margin: 12mm; }
      body{background:#fff!important;color:#111!important;overflow:visible!important;}
      .sidebar,.hamburger,.sidebar-overlay,.deploy-chip,#socket-broken-banner,#telegram-broken-banner,#backup-nag-banner,.tbar,.pdf-btn{display:none!important;}
      .app-shell{display:block!important;}
      .main-content{margin-left:0!important;padding:0!important;min-height:auto!important;}
      .rpt-head,.sc,.panel{background:#fff!important;border:1px solid #d0d7e2!important;box-shadow:none!important;break-inside:avoid;}
      .rh-title{color:#111!important;} .rh-meta,.rh-brand,.page-sub{color:#555!important;}
      .sc-val{color:#111!important;} .sc-label,.sc-sub,.panel h3{color:#555!important;}
      .tbl{font-size:0.62rem;} .tbl th{background:#eef2f7!important;color:#333!important;}
      .tbl td{color:#222!important;border-color:#d0d7e2!important;}
      .tbl tfoot td{background:#eef2f7!important;color:#111!important;}
      .ledger-wrap{max-height:none!important;overflow:visible!important;}
      .tbl-scroll{overflow:visible!important;}
      .panel,.tbl tr{break-inside:avoid;}
      thead{display:table-header-group;}  /* repeat table header on each page */
      .chart-wrap{height:200px!important;}
    }
  </style>
</head>
<body>
<div class="app-shell">
  ${buildSidebar('consolidationReport', false)}
  <div class="main-content">
    <h1 class="page-title">📑 Consolidation Report</h1>
    <p class="page-sub">One consolidated, printable report of every recorded trade — filter by book, strategy, week / month / date range, then export to PDF.</p>

    <div class="tbar">
      <label>Book</label>
      <div class="seg" id="segBook">
        <button data-book="paper" class="on">Paper</button>
        <button data-book="live">Live</button>
        <button data-book="all">Both</button>
      </div>
      <label>Strategy</label>
      <select id="fMode">
        <option value="">All</option>
        <option value="EMA_RSI_ST">EMA_RSI_ST</option>
        <option value="BB_RSI">BB_RSI</option>
        <option value="PA">Price Action</option>
        <option value="ORB">ORB</option>
        <option value="EMA9VWAP">EMA9+VWAP</option>
        <option value="TREND_PB">Trend Pullback</option>
      </select>
      <label>Range</label>
      <select id="fRange">
        <option value="all">All time</option>
        <option value="tw">This week</option>
        <option value="lw">Last week</option>
        <option value="tm">This month</option>
        <option value="lm">Last month</option>
        <option value="7">Last 7 days</option>
        <option value="30">Last 30 days</option>
        <option value="fy">This FY (Apr–Mar)</option>
        <option value="custom">Custom</option>
      </select>
      <span id="customWrap" style="display:none;">
        <label>From</label><input type="date" id="fFrom"/>
        <label>To</label><input type="date" id="fTo"/>
      </span>
      <label>Group by</label>
      <select id="fGroup">
        <option value="day">Day</option>
        <option value="week">Week</option>
        <option value="month" selected>Month</option>
        <option value="mode">Strategy</option>
      </select>
      <button class="pdf-btn" onclick="window.print()">🖨 Save as PDF</button>
    </div>

    <div id="content"></div>
  </div>
</div>

<script>
const ALL = ${JSON.stringify(trades)};

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function inr(n){ const v=Math.round(n); return (v<0?'-':'')+'₹'+Math.abs(v).toLocaleString('en-IN'); }
function inr2(n){ return (n<0?'-':'')+'₹'+Math.abs(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function sign(n){ return n>0?'+':''; }
function pc(n){ return n>=0?'#10b981':'#ef4444'; }
function num(v){ return (v==null||v==='')?'—':(+v).toLocaleString('en-IN'); }
const MODE_LABEL={EMA_RSI_ST:'EMA_RSI_ST',BB_RSI:'BB_RSI',PA:'Price Action',ORB:'ORB',EMA9VWAP:'EMA9+VWAP',TREND_PB:'Trend Pullback'};

function ymd(d){ const p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
function fyStart(){ const now=new Date(); const y=now.getMonth()>=3?now.getFullYear():now.getFullYear()-1; return y+'-04-01'; }
// Monday of the week that contains d (local time).
function mondayOf(d){ const x=new Date(d.getFullYear(),d.getMonth(),d.getDate()); const dow=(x.getDay()+6)%7; x.setDate(x.getDate()-dow); return x; }

function currentFilter(){
  const book = document.querySelector('#segBook button.on').dataset.book;
  const mode = document.getElementById('fMode').value;
  const range = document.getElementById('fRange').value;
  const group = document.getElementById('fGroup').value;
  const now=new Date();
  let from='', to='', rangeLabel='All time';
  if(range==='custom'){
    from=document.getElementById('fFrom').value; to=document.getElementById('fTo').value;
    rangeLabel = (from||'…')+' → '+(to||'…');
  } else if(range==='fy'){ from=fyStart(); rangeLabel='This FY ('+from.slice(0,4)+'–'+(+from.slice(0,4)+1)+')'; }
  else if(range==='7'||range==='30'){ const d=new Date(); d.setDate(d.getDate()-(+range)+1); from=ymd(d); rangeLabel='Last '+range+' days'; }
  else if(range==='tw'){ from=ymd(mondayOf(now)); rangeLabel='This week (from '+from+')'; }
  else if(range==='lw'){ const m=mondayOf(now); const s=new Date(m); s.setDate(s.getDate()-7); const e=new Date(m); e.setDate(e.getDate()-1); from=ymd(s); to=ymd(e); rangeLabel='Last week ('+from+' → '+to+')'; }
  else if(range==='tm'){ from=ymd(new Date(now.getFullYear(),now.getMonth(),1)); rangeLabel='This month'; }
  else if(range==='lm'){ from=ymd(new Date(now.getFullYear(),now.getMonth()-1,1)); to=ymd(new Date(now.getFullYear(),now.getMonth(),0)); rangeLabel='Last month'; }
  return {book,mode,from,to,group,rangeLabel};
}
function applyFilter(f){
  return ALL.filter(t=>{
    if(f.book!=='all' && t.book!==f.book) return false;
    if(f.mode && t.mode!==f.mode) return false;
    if(f.from && t.date < f.from) return false;
    if(f.to   && t.date > f.to)   return false;
    return true;
  });
}

function stats(arr){
  let net=0,gw=0,gl=0,wins=0,losses=0,scratch=0,sumWin=0,sumLoss=0,best=-1e9,worst=1e9;
  let eq=0,peak=0,maxDD=0,curW=0,curL=0,maxW=0,maxL=0; const eqS=[];
  for(const t of arr){
    const p=t.pnl; net+=p; eq+=p; eqS.push(eq);
    if(eq>peak) peak=eq;
    if(eq-peak<maxDD) maxDD=eq-peak;
    if(p>0){wins++;gw+=p;sumWin+=p;curW++;curL=0;if(curW>maxW)maxW=curW;}
    else if(p<0){losses++;gl+=-p;sumLoss+=p;curL++;curW=0;if(curL>maxL)maxL=curL;}
    else{scratch++;curW=0;curL=0;}
    if(p>best)best=p; if(p<worst)worst=p;
  }
  const n=arr.length;
  return { n, net, gw, gl, wins, losses, scratch,
    wr: n?wins/n*100:0, exp: n?net/n:0,
    pf: gl>0?gw/gl:(gw>0?Infinity:0),
    avgWin: wins?sumWin/wins:0, avgLoss: losses?sumLoss/losses:0,
    best: n?best:0, worst: n?worst:0, maxDD, maxW, maxL, eqS };
}

// group key + human label for the period-breakdown table
function periodKey(t, group){
  if(group==='mode') return {k:t.mode, label:MODE_LABEL[t.mode]||t.mode};
  const d=t.date||''; if(!d) return {k:'—', label:'—'};
  if(group==='day')   return {k:d, label:d};
  if(group==='month') return {k:d.slice(0,7), label:d.slice(0,7)};
  // week → Monday of that date
  const dt=new Date(d+'T12:00:00'); const m=mondayOf(dt); const mk=ymd(m);
  return {k:mk, label:'Wk '+mk};
}

let charts={};
function destroyCharts(){ for(const k in charts){ try{charts[k].destroy();}catch(_){} } charts={}; }
function themed(){
  const light=document.documentElement.getAttribute('data-theme')==='light';
  return { grid: light?'rgba(0,0,0,0.06)':'rgba(255,255,255,0.05)', tick: light?'#64748b':'#4a6080' };
}

function render(){
  const f=currentFilter();
  const arr=applyFilter(f);
  destroyCharts();
  const C=document.getElementById('content');

  const bookLabel = f.book==='all'?'Paper + Live':(f.book==='live'?'Live':'Paper');
  const modeLabel = f.mode?(MODE_LABEL[f.mode]||f.mode):'All strategies';
  const gen = new Date().toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'});

  // Report header (always shown; also the top of the printed page)
  let head='<div class="rpt-head"><div>'
    +'<div class="rh-title">Consolidated Trade Report</div>'
    +'<div class="rh-meta">Book: <b>'+bookLabel+'</b> &nbsp;·&nbsp; Strategy: <b>'+esc(modeLabel)+'</b> &nbsp;·&nbsp; Period: <b>'+esc(f.rangeLabel)+'</b><br>'
    +'Trades in report: <b>'+arr.length+'</b>'+(arr.length?(' &nbsp;·&nbsp; '+esc((arr[0].date||''))+' → '+esc((arr[arr.length-1].date||''))):'')+'</div>'
    +'</div><div class="rh-brand">ௐ Palani Andawar Thunai ॐ<br>Generated '+esc(gen)+'</div></div>';

  if(!arr.length){ C.innerHTML=head+'<div class="empty">No trades for this filter. Try widening the range or switching book / strategy.</div>'; return; }
  const s=stats(arr);

  const cards=[
    {l:'Trades',v:s.n,sub:s.wins+'W / '+s.losses+'L'+(s.scratch?' / '+s.scratch+'BE':''),a:'#38bdf8'},
    {l:'Win Rate',v:s.wr.toFixed(1)+'%',sub:'',a:s.wr>=50?'#10b981':'#f59e0b'},
    {l:'Net P&L',v:inr(s.net),sub:'expectancy '+inr(s.exp)+'/trade',a:pc(s.net)},
    {l:'Gross Win / Loss',v:inr(s.gw)+' / -'+inr(s.gl),sub:'',a:'#38bdf8'},
    {l:'Profit Factor',v:(s.pf===Infinity?'∞':s.pf.toFixed(2)),sub:'gross win ÷ loss',a:s.pf>=1.5?'#10b981':(s.pf>=1?'#f59e0b':'#ef4444')},
    {l:'Max Drawdown',v:inr(s.maxDD),sub:'streaks '+s.maxW+'W / '+s.maxL+'L',a:'#ef4444'},
  ];
  let h=head+'<div class="stat-grid">';
  for(const c of cards) h+='<div class="sc" style="--accent:'+c.a+'"><div class="sc-label">'+c.l+'</div><div class="sc-val" style="color:'+c.a+'">'+c.v+'</div><div class="sc-sub">'+c.sub+'</div></div>';
  h+='</div>';

  h+='<div class="panel"><h3>Equity Curve (cumulative net P&L · trade-by-trade)</h3><div class="chart-wrap"><canvas id="eqChart"></canvas></div></div>';
  h+='<div class="panel"><h3>By Strategy</h3><div class="tbl-scroll">'+modeTable(arr)+'</div></div>';
  h+='<div class="panel"><h3>By '+({day:'Day',week:'Week',month:'Month',mode:'Strategy'}[f.group])+'</h3><div class="tbl-scroll">'+periodTable(arr,f.group)+'</div></div>';
  h+='<div class="panel"><h3>Trade Ledger ('+arr.length+' trades)</h3><div class="ledger-wrap tbl-scroll">'+ledgerTable(arr,f.book)+'</div></div>';
  C.innerHTML=h;

  drawEquity(s.eqS);
}

function statRow(label, badge, st){
  return '<tr><td>'+badge+'</td>'
    +'<td>'+st.n+'</td><td>'+st.wr.toFixed(0)+'%</td>'
    +'<td style="color:#10b981">'+inr(st.gw)+'</td>'
    +'<td style="color:#ef4444">-'+inr(st.gl)+'</td>'
    +'<td style="color:'+pc(st.net)+'">'+sign(st.net)+inr(st.net)+'</td>'
    +'<td style="color:'+pc(st.exp)+'">'+inr(st.exp)+'</td>'
    +'<td>'+(st.pf===Infinity?'∞':st.pf.toFixed(2))+'</td></tr>';
}

function modeTable(arr){
  const m=new Map();
  for(const t of arr){ if(!m.has(t.mode)) m.set(t.mode,[]); m.get(t.mode).push(t); }
  const rows=[...m.entries()].map(([mode,ts])=>({mode,s:stats(ts)})).sort((a,b)=>b.s.net-a.s.net);
  let h='<table class="tbl"><thead><tr><th>Strategy</th><th>Trades</th><th>WR</th><th>Gross Win</th><th>Gross Loss</th><th>Net</th><th>Exp</th><th>PF</th></tr></thead><tbody>';
  for(const r of rows) h+=statRow(r.mode,'<span class="badge-mode badge-'+r.mode+'">'+(MODE_LABEL[r.mode]||r.mode)+'</span>',r.s);
  h+='</tbody>';
  const tot=stats(arr);
  h+='<tfoot>'+statRow('TOTAL','<b>TOTAL</b>',tot).replace('<td><b>TOTAL</b></td>','<td><b>TOTAL</b></td>')+'</tfoot>';
  return h+'</table>';
}

function periodTable(arr, group){
  const m=new Map();
  for(const t of arr){ const {k,label}=periodKey(t,group); if(!m.has(k)) m.set(k,{label,ts:[]}); m.get(k).ts.push(t); }
  // chronological (strategy grouping falls back to net desc)
  let keys=[...m.keys()];
  if(group==='mode') keys.sort((a,b)=>stats(m.get(b).ts).net-stats(m.get(a).ts).net);
  else keys.sort();
  let cum=0;
  let h='<table class="tbl"><thead><tr><th>'+({day:'Day',week:'Week',month:'Month',mode:'Strategy'}[group])+'</th><th>Trades</th><th>WR</th><th>Gross Win</th><th>Gross Loss</th><th>Net</th><th>Cumulative</th></tr></thead><tbody>';
  for(const k of keys){
    const st=stats(m.get(k).ts); cum+=st.net;
    h+='<tr><td>'+esc(m.get(k).label)+'</td>'
      +'<td>'+st.n+'</td><td>'+st.wr.toFixed(0)+'%</td>'
      +'<td style="color:#10b981">'+inr(st.gw)+'</td>'
      +'<td style="color:#ef4444">-'+inr(st.gl)+'</td>'
      +'<td style="color:'+pc(st.net)+'">'+sign(st.net)+inr(st.net)+'</td>'
      +'<td style="color:'+pc(cum)+'">'+sign(cum)+inr(cum)+'</td></tr>';
  }
  const tot=stats(arr);
  h+='</tbody><tfoot><tr><td><b>TOTAL</b></td><td>'+tot.n+'</td><td>'+tot.wr.toFixed(0)+'%</td>'
    +'<td style="color:#10b981">'+inr(tot.gw)+'</td><td style="color:#ef4444">-'+inr(tot.gl)+'</td>'
    +'<td style="color:'+pc(tot.net)+'">'+sign(tot.net)+inr(tot.net)+'</td><td style="color:'+pc(tot.net)+'">'+sign(tot.net)+inr(tot.net)+'</td></tr></tfoot>';
  return h+'</table>';
}

function ledgerTable(arr, book){
  const showBook = book==='all';
  let h='<table class="tbl"><thead><tr><th>#</th><th>Date</th>'+(showBook?'<th>Book</th>':'')+'<th>Strategy</th><th>Side</th><th>Symbol</th><th>Qty</th><th>Entry</th><th>Exit</th><th>In</th><th>Out</th><th>P&amp;L</th><th>Exit Reason</th></tr></thead><tbody>';
  arr.forEach((t,i)=>{
    const side=(t.side||'').toUpperCase();
    const sideC = side==='CE'?'#10b981':(side==='PE'?'#ef4444':'#c8d8f0');
    h+='<tr><td>'+(i+1)+'</td><td>'+esc(t.date||'—')+'</td>'
      +(showBook?'<td><span class="badge-book badge-'+t.book+'">'+t.book.toUpperCase()+'</span></td>':'')
      +'<td><span class="badge-mode badge-'+t.mode+'">'+(MODE_LABEL[t.mode]||t.mode)+'</span></td>'
      +'<td style="color:'+sideC+';font-weight:700">'+esc(side||'—')+'</td>'
      +'<td style="text-align:left;font-size:0.66rem">'+esc(t.symbol||'—')+'</td>'
      +'<td>'+num(t.qty)+'</td><td>'+num(t.entryPrice)+'</td><td>'+num(t.exitPrice)+'</td>'
      +'<td style="font-size:0.64rem">'+esc(String(t.entryTime||'—').slice(0,5)||'—')+'</td>'
      +'<td style="font-size:0.64rem">'+esc(String(t.exitTime||'—').slice(0,5)||'—')+'</td>'
      +'<td style="color:'+pc(t.pnl)+';font-weight:700">'+sign(t.pnl)+inr2(t.pnl)+'</td>'
      +'<td style="text-align:left;max-width:220px;white-space:normal;font-size:0.64rem" title="'+esc(t.exitReason)+'">'+esc(t.exitReason||'—')+'</td></tr>';
  });
  const tot=stats(arr);
  const span = showBook?11:10;
  h+='</tbody><tfoot><tr><td colspan="'+span+'" style="text-align:right"><b>NET</b></td>'
    +'<td style="color:'+pc(tot.net)+';font-weight:700">'+sign(tot.net)+inr2(tot.net)+'</td><td></td></tr></tfoot>';
  return h+'</table>';
}

function drawEquity(eqS){
  const th=themed();
  charts.eq=new Chart(document.getElementById('eqChart'),{
    type:'line',
    data:{ labels:eqS.map((_,i)=>i+1), datasets:[{
      data:eqS, borderColor:'#38bdf8', borderWidth:2, pointRadius:0, tension:0.15,
      fill:true, backgroundColor:(ctx)=>{ const g=ctx.chart.ctx.createLinearGradient(0,0,0,300); g.addColorStop(0,'rgba(56,189,248,0.25)'); g.addColorStop(1,'rgba(56,189,248,0)'); return g; },
    }]},
    options:{ responsive:true, maintainAspectRatio:false, animation:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{title:i=>'Trade #'+i[0].label, label:c=>'Equity: '+inr(c.parsed.y)}}},
      scales:{ x:{grid:{color:th.grid},ticks:{color:th.tick,maxTicksLimit:12}}, y:{grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}} } }
  });
}

// wire controls
document.querySelectorAll('#segBook button').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('#segBook button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); render();
}));
document.getElementById('fMode').addEventListener('change',render);
document.getElementById('fGroup').addEventListener('change',render);
document.getElementById('fRange').addEventListener('change',()=>{
  document.getElementById('customWrap').style.display = document.getElementById('fRange').value==='custom'?'inline':'none';
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

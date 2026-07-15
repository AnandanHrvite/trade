/**
 * Edge Analytics — turns the trade JSONL/JSON you already collect into edge metrics.
 *
 * Read-only. Loads the same per-strategy session files that /consolidation (paper) and
 * /live-consolidation (live) use, flattens them to one trade array, embeds it in the page,
 * and computes everything client-side so the Book / Strategy / Date filters recompute
 * instantly without a server round-trip.
 *
 * Metrics: win rate, expectancy, profit factor, payoff, avg win/loss, max drawdown,
 * win/loss streaks, equity curve, P&L by hour-of-day, P&L by weekday, P&L by exit reason,
 * and a per-strategy breakdown table.
 *
 * Gated by UI_SHOW_EDGE_ANALYTICS (Settings → Menu Visibility). No new data is written.
 */
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");

const _HOME = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");

// Mirror the source maps used by consolidation.js (paper) + liveConsolidation.js (live).
// ORB live files are included defensively — safeRead() no-ops if absent.
const PAPER_SOURCES = [
  { mode: "EMA_RSI_ST",    file: "ema_rsi_st_paper_trades.json" },
  { mode: "BB_RSI",    file: "bb_rsi_paper_trades.json" },
  { mode: "PA",       file: "pa_paper_trades.json" },
  { mode: "ORB",      file: "orb_paper_trades.json" },
  { mode: "EMA9VWAP", file: "ema9vwap_paper_trades.json" },
  { mode: "TREND_PB", file: "trend_pb_paper_trades.json" },
];
const LIVE_SOURCES = [
  { mode: "EMA_RSI_ST",    file: "ema_rsi_st_live_trades.json" },
  { mode: "BB_RSI",    file: "bb_rsi_live_trades.json" },
  { mode: "PA",       file: "pa_live_trades.json" },
  { mode: "ORB",      file: "orb_live_trades.json" },
  { mode: "EMA9VWAP", file: "ema9vwap_live_trades.json" },
  { mode: "TREND_PB", file: "trend_pb_live_trades.json" },
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
          entryTime:   t.entryTime || "",
          exitTime:    t.exitTime || "",
          pnl:         Number(t.pnl) || 0,
          exitReason:  t.exitReason || "—",
        });
      }
    }
  }
  return out;
}

// Cache the flattened+sorted trade list — same approach as consolidation.js.
// Re-reading + JSON.parsing all 8 (growing) trade files on every page hit is
// wasteful; invalidate by a cheap mtime+size signature so a new trade is picked
// up immediately without re-parsing when nothing changed.
let _edgeCache = null;
let _edgeSig   = null;
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
  if (_edgeCache && sig === _edgeSig) return _edgeCache;
  const trades = loadBook(PAPER_SOURCES, "paper").concat(loadBook(LIVE_SOURCES, "live"));
  // oldest → newest so the equity curve reads left-to-right
  trades.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  _edgeCache = trades;
  _edgeSig   = sig;
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
  <title>ௐ Palani Andawar Thunai ॐ — Edge Analytics</title>
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
    .stat-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:10px;margin-bottom:16px;}
    @media(max-width:1300px){.stat-grid{grid-template-columns:repeat(4,1fr);}}
    @media(max-width:560px){.stat-grid{grid-template-columns:repeat(2,1fr);}}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent,#38bdf8);}
    .sc-label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:5px;font-family:'IBM Plex Mono',monospace;}
    .sc-val{font-size:1.05rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#e0eaf8;}
    .sc-sub{font-size:0.6rem;color:#4a6080;margin-top:3px;}
    .panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
    .panel h3{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.4px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
    .row2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
    @media(max-width:1000px){.row2{grid-template-columns:1fr;}}
    .chart-wrap{position:relative;height:260px;}
    .chart-wrap.tall{height:300px;}
    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .tbl th{padding:8px 10px;text-align:right;font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;}
    .tbl th:first-child{text-align:left;}
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;text-align:right;}
    .tbl td:first-child{text-align:left;}
    .tbl tr:hover td{background:rgba(56,189,248,0.05);}
    .badge-mode{padding:2px 7px;border-radius:4px;font-size:0.58rem;font-weight:700;letter-spacing:0.5px;}
    .badge-EMA_RSI_ST{background:rgba(59,130,246,0.12);color:#3b82f6;border:0.5px solid rgba(59,130,246,0.3);}
    .badge-BB_RSI{background:rgba(245,158,11,0.12);color:#f59e0b;border:0.5px solid rgba(245,158,11,0.3);}
    .badge-PA{background:rgba(168,85,247,0.12);color:#a855f7;border:0.5px solid rgba(168,85,247,0.3);}
    .badge-ORB{background:rgba(16,185,129,0.12);color:#10b981;border:0.5px solid rgba(16,185,129,0.3);}
    .empty{text-align:center;padding:50px 20px;color:#4a6080;font-size:0.85rem;}
    /* light theme */
    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .page-title{color:#1e293b!important;}
    :root[data-theme="light"] .page-sub,:root[data-theme="light"] .sc-label,:root[data-theme="light"] .sc-sub,:root[data-theme="light"] .panel h3,:root[data-theme="light"] .tbar label{color:#64748b!important;}
    :root[data-theme="light"] .sc,:root[data-theme="light"] .panel{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .sc-val{color:#1e293b!important;}
    :root[data-theme="light"] .tbar{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbar input,:root[data-theme="light"] .tbar select,:root[data-theme="light"] .seg button{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .seg button.on{background:#e0f2fe!important;color:#0369a1!important;}
    :root[data-theme="light"] .tbl th{background:#f1f5f9!important;color:#64748b!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbl td{border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .empty{color:#94a3b8!important;}
  </style>
</head>
<body>
<div class="app-shell">
  ${buildSidebar('edgeAnalytics', false)}
  <div class="main-content">
    <h1 class="page-title">📈 Edge Analytics</h1>
    <p class="page-sub">Win rate · expectancy · profit factor · drawdown · best hours — computed from your recorded trades.</p>

    <div class="tbar">
      <label>Book</label>
      <div class="seg" id="segBook">
        <button data-book="paper" class="on">Paper</button>
        <button data-book="live">Live</button>
      </div>
      <label>Strategy</label>
      <select id="fMode">
        <option value="">All</option>
        <option value="EMA_RSI_ST">EMA_RSI_ST</option>
        <option value="BB_RSI">BB_RSI</option>
        <option value="PA">Price Action</option>
        <option value="ORB">ORB</option>
      </select>
      <label>Range</label>
      <select id="fRange">
        <option value="all">All time</option>
        <option value="7">Last 7 days</option>
        <option value="30">Last 30 days</option>
        <option value="fy">This FY (Apr–Mar)</option>
        <option value="custom">Custom</option>
      </select>
      <span id="customWrap" style="display:none;">
        <label>From</label><input type="date" id="fFrom"/>
        <label>To</label><input type="date" id="fTo"/>
      </span>
      <span id="cntPill" style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:0.7rem;color:#4a6080;"></span>
    </div>

    <div id="content"></div>
  </div>
</div>

<script>
const ALL = ${JSON.stringify(trades)};

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function inr(n){ const v=Math.round(n); return (v<0?'-':'')+'₹'+Math.abs(v).toLocaleString('en-IN'); }
function sign(n){ return n>0?'+':''; }
function pc(n){ return n>=0?'#10b981':'#ef4444'; }

// "HH:MM, DD/MM/YYYY" (IST local) OR ISO "YYYY-MM-DDTHH:MM..Z" (UTC → +5:30)
function entryHour(t){
  const v=String(t||'');
  let m=v.match(/^(\\d{1,2}):(\\d{2}),/);
  if(m) return +m[1];
  m=v.match(/^\\d{4}-\\d{2}-\\d{2}T/);
  if(m){ const d=new Date(v); if(!isNaN(d)) return new Date(d.getTime()+19800000).getUTCHours(); }
  return null;
}
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function weekday(dateStr){ if(!dateStr) return null; const d=new Date(dateStr+'T12:00:00'); return isNaN(d)?null:d.getDay(); }

function fyStart(){
  const now=new Date();
  const y = now.getMonth()>=3 ? now.getFullYear() : now.getFullYear()-1; // Apr=month 3
  return y+'-04-01';
}
function ymd(d){ return d.toISOString().slice(0,10); }

function currentFilter(){
  const book = document.querySelector('#segBook button.on').dataset.book;
  const mode = document.getElementById('fMode').value;
  const range = document.getElementById('fRange').value;
  let from='', to='';
  if(range==='custom'){ from=document.getElementById('fFrom').value; to=document.getElementById('fTo').value; }
  else if(range==='fy'){ from=fyStart(); }
  else if(range==='7'||range==='30'){ const d=new Date(); d.setDate(d.getDate()-(+range)+1); from=ymd(d); }
  return {book,mode,from,to};
}
function applyFilter(f){
  return ALL.filter(t=>{
    if(t.book!==f.book) return false;
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
  return {
    n, net, wins, losses, scratch,
    wr: n?wins/n*100:0,
    exp: n?net/n:0,
    pf: gl>0?gw/gl:(gw>0?Infinity:0),
    avgWin: wins?sumWin/wins:0,
    avgLoss: losses?sumLoss/losses:0,
    payoff: (losses&&sumLoss!==0)?Math.abs((sumWin/Math.max(wins,1))/(sumLoss/losses)):0,
    best: n?best:0, worst: n?worst:0,
    maxDD, maxW, maxL, eqS,
  };
}

function groupNet(arr, keyFn){
  const m=new Map();
  for(const t of arr){
    const k=keyFn(t); if(k===null||k===undefined) continue;
    if(!m.has(k)) m.set(k,{key:k,net:0,n:0,wins:0});
    const g=m.get(k); g.net+=t.pnl; g.n++; if(t.pnl>0)g.wins++;
  }
  return m;
}

let charts={};
function destroyCharts(){ for(const k in charts){ try{charts[k].destroy();}catch(_){} } charts={}; }

function themed(){
  const light = document.documentElement.getAttribute('data-theme')==='light';
  return { grid: light?'rgba(0,0,0,0.06)':'rgba(255,255,255,0.05)', tick: light?'#64748b':'#4a6080' };
}

function render(){
  const f=currentFilter();
  const arr=applyFilter(f);
  document.getElementById('cntPill').textContent = arr.length+' trades';
  destroyCharts();
  const C=document.getElementById('content');
  if(!arr.length){ C.innerHTML='<div class="empty">No '+f.book+' trades for this filter. Try widening the date range or switching book/strategy.</div>'; return; }
  const s=stats(arr);

  const cards=[
    {l:'Trades',v:s.n,sub:s.wins+'W / '+s.losses+'L'+(s.scratch?' / '+s.scratch+'BE':''),a:'#38bdf8'},
    {l:'Win Rate',v:s.wr.toFixed(1)+'%',sub:'',a:s.wr>=50?'#10b981':'#f59e0b'},
    {l:'Net P&L',v:inr(s.net),sub:'',a:pc(s.net)},
    {l:'Expectancy',v:inr(s.exp),sub:'per trade',a:pc(s.exp)},
    {l:'Profit Factor',v:(s.pf===Infinity?'∞':s.pf.toFixed(2)),sub:'gross win ÷ loss',a:s.pf>=1.5?'#10b981':(s.pf>=1?'#f59e0b':'#ef4444')},
    {l:'Avg Win / Loss',v:inr(s.avgWin)+' / '+inr(s.avgLoss),sub:'payoff '+s.payoff.toFixed(2)+'×',a:'#38bdf8'},
    {l:'Max Drawdown',v:inr(s.maxDD),sub:'peak-to-trough',a:'#ef4444'},
    {l:'Streaks',v:s.maxW+'W / '+s.maxL+'L',sub:'best run / worst run',a:'#a855f7'},
  ];
  let h='<div class="stat-grid">';
  for(const c of cards) h+='<div class="sc" style="--accent:'+c.a+'"><div class="sc-label">'+c.l+'</div><div class="sc-val" style="color:'+c.a+'">'+c.v+'</div><div class="sc-sub">'+c.sub+'</div></div>';
  h+='</div>';

  h+='<div class="panel"><h3>Equity Curve (cumulative net P&L · trade-by-trade)</h3><div class="chart-wrap tall"><canvas id="eqChart"></canvas></div></div>';
  h+='<div class="row2">';
  h+='<div class="panel"><h3>P&L by Hour of Day (entry)</h3><div class="chart-wrap"><canvas id="hourChart"></canvas></div></div>';
  h+='<div class="panel"><h3>P&L by Weekday</h3><div class="chart-wrap"><canvas id="dowChart"></canvas></div></div>';
  h+='</div>';

  // per-strategy table (only when viewing All)
  h+='<div class="row2">';
  h+='<div class="panel"><h3>By Strategy</h3>'+modeTable(arr)+'</div>';
  h+='<div class="panel"><h3>By Exit Reason</h3>'+reasonTable(arr)+'</div>';
  h+='</div>';
  C.innerHTML=h;

  drawEquity(s.eqS);
  drawHour(arr);
  drawDow(arr);
}

function modeTable(arr){
  const m=new Map();
  for(const t of arr){ if(!m.has(t.mode)) m.set(t.mode,[]); m.get(t.mode).push(t); }
  const rows=[...m.entries()].map(([mode,ts])=>({mode,s:stats(ts)})).sort((a,b)=>b.s.net-a.s.net);
  let h='<table class="tbl"><thead><tr><th>Strategy</th><th>Trades</th><th>WR</th><th>Net</th><th>Exp</th><th>PF</th></tr></thead><tbody>';
  for(const r of rows){
    h+='<tr><td><span class="badge-mode badge-'+r.mode+'">'+r.mode+'</span></td>'
      +'<td>'+r.s.n+'</td><td>'+r.s.wr.toFixed(0)+'%</td>'
      +'<td style="color:'+pc(r.s.net)+'">'+sign(r.s.net)+inr(r.s.net)+'</td>'
      +'<td style="color:'+pc(r.s.exp)+'">'+inr(r.s.exp)+'</td>'
      +'<td>'+(r.s.pf===Infinity?'∞':r.s.pf.toFixed(2))+'</td></tr>';
  }
  return h+'</tbody></table>';
}

function reasonTable(arr){
  const m=groupNet(arr, t=>t.exitReason||'—');
  const rows=[...m.values()].sort((a,b)=>a.net-b.net); // worst first — find the bleed
  let h='<table class="tbl"><thead><tr><th>Exit Reason</th><th>N</th><th>WR</th><th>Net</th><th>Avg</th></tr></thead><tbody>';
  for(const r of rows){
    h+='<tr><td title="'+esc(r.key)+'">'+esc(r.key.length>26?r.key.slice(0,26)+'…':r.key)+'</td>'
      +'<td>'+r.n+'</td><td>'+(r.n?(r.wins/r.n*100).toFixed(0):0)+'%</td>'
      +'<td style="color:'+pc(r.net)+'">'+sign(r.net)+inr(r.net)+'</td>'
      +'<td style="color:'+pc(r.net/r.n)+'">'+inr(r.net/r.n)+'</td></tr>';
  }
  return h+'</tbody></table>';
}

function drawEquity(eqS){
  const th=themed();
  charts.eq=new Chart(document.getElementById('eqChart'),{
    type:'line',
    data:{ labels:eqS.map((_,i)=>i+1), datasets:[{
      data:eqS, borderColor:'#38bdf8', borderWidth:2, pointRadius:0, tension:0.15,
      fill:true, backgroundColor:(ctx)=>{ const g=ctx.chart.ctx.createLinearGradient(0,0,0,300); g.addColorStop(0,'rgba(56,189,248,0.25)'); g.addColorStop(1,'rgba(56,189,248,0)'); return g; },
    }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{title:i=>'Trade #'+i[0].label, label:c=>'Equity: '+inr(c.parsed.y)}}},
      scales:{ x:{grid:{color:th.grid},ticks:{color:th.tick,maxTicksLimit:12}}, y:{grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}} } }
  });
}

function barColors(vals){ return vals.map(v=>v>=0?'rgba(16,185,129,0.65)':'rgba(239,68,68,0.65)'); }

function drawHour(arr){
  const th=themed();
  const m=groupNet(arr, t=>entryHour(t.entryTime));
  const hours=[...m.keys()].sort((a,b)=>a-b);
  const net=hours.map(h=>m.get(h).net);
  charts.hour=new Chart(document.getElementById('hourChart'),{
    type:'bar',
    data:{ labels:hours.map(h=>String(h).padStart(2,'0')+':00'), datasets:[{data:net,backgroundColor:barColors(net)}]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>{const g=m.get(hours[c.dataIndex]); return [inr(g.net),g.n+' trades · '+(g.wins/g.n*100).toFixed(0)+'% WR'];}}}},
      scales:{ x:{grid:{display:false},ticks:{color:th.tick}}, y:{grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}} } }
  });
}

function drawDow(arr){
  const th=themed();
  const m=groupNet(arr, t=>weekday(t.date));
  const days=[1,2,3,4,5].filter(d=>m.has(d)); // Mon–Fri (drop empty)
  const net=days.map(d=>m.get(d).net);
  charts.dow=new Chart(document.getElementById('dowChart'),{
    type:'bar',
    data:{ labels:days.map(d=>DOW[d]), datasets:[{data:net,backgroundColor:barColors(net)}]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>{const g=m.get(days[c.dataIndex]); return [inr(g.net),g.n+' trades · '+(g.wins/g.n*100).toFixed(0)+'% WR'];}}}},
      scales:{ x:{grid:{display:false},ticks:{color:th.tick}}, y:{grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}} } }
  });
}

// wire controls
document.querySelectorAll('#segBook button').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('#segBook button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); render();
}));
document.getElementById('fMode').addEventListener('change',render);
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

/**
 * Settings Advisor — reads your recorded trades and suggests what to change.
 *
 * Read-only page over utils/settingsAdvisor.js. It never writes a setting: every
 * card names the exact Settings key(s) involved and leaves the save to you, so
 * an acted-on suggestion still goes through the normal Settings audit trail.
 *
 * GET /advisor        → page shell (analysis is fetched, so Book/Window changes
 *                       do not need a reload)
 * GET /advisor/data   → JSON report for the current filters
 *
 * Gated by UI_SHOW_ADVISOR (Settings → Menu Visibility).
 */
const express = require("express");
const router = express.Router();
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");
const advisor = require("../utils/settingsAdvisor");

router.get("/data", (req, res) => {
  try {
    const report = advisor.analyze({
      book: req.query.book,
      lookbackDays: req.query.days,
    });
    const saved = advisor.readReport();
    report.lastWeekly = saved ? { generatedAt: saved.generatedAt, periodKey: saved.periodKey || null } : null;
    res.json({ success: true, report });
  } catch (err) {
    console.error(`[advisor] analyse failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/", (req, res) => {
  const theme = (process.env.UI_THEME || "dark").toLowerCase();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>ௐ Palani Andawar Thunai ॐ — Settings Advisor</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script>(function(){ if ('${theme}' === 'light') document.documentElement.setAttribute('data-theme','light'); })();</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    .main-content{flex:1;margin-left:200px;padding:18px 22px 40px;min-width:0;min-height:100vh;}
    @media(max-width:900px){.main-content{margin-left:0;padding:14px;}}
    .page-title{font-size:1.1rem;font-weight:700;margin-bottom:2px;}
    .page-sub{font-size:0.72rem;color:#4a6080;margin-bottom:14px;}
    .tbar{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;margin-bottom:14px;flex-wrap:wrap;}
    .tbar label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:#3a5070;font-family:'IBM Plex Mono',monospace;}
    .tbar select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:6px 10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;outline:none;}
    .tbar select:focus{border-color:#38bdf8;}
    .btn{background:#0c4a6e;border:0.5px solid #1e5a80;color:#7dd3fc;padding:7px 14px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;font-weight:600;cursor:pointer;}
    .btn:hover{background:#0e5a84;}
    .meta{margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:0.66rem;color:#4a6080;}
    .stat-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px;}
    @media(max-width:1000px){.stat-grid{grid-template-columns:repeat(2,1fr);}}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent,#38bdf8);}
    .sc-label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:5px;font-family:'IBM Plex Mono',monospace;}
    .sc-val{font-size:1.05rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
    .panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
    .panel h3{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.4px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
    .f{border:0.5px solid #0e1e36;border-left:3px solid var(--sev,#38bdf8);border-radius:8px;padding:12px 14px;margin-bottom:10px;background:#04090f;}
    .f-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;}
    .f-sev{font-family:'IBM Plex Mono',monospace;font-size:0.54rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 7px;border-radius:4px;}
    .f-title{font-size:0.84rem;font-weight:600;color:#e0eaf8;}
    .f-detail{font-size:0.74rem;color:#8fa6c4;line-height:1.5;margin-bottom:6px;}
    .f-sug{font-size:0.76rem;color:#c8d8f0;line-height:1.5;}
    .f-sug b{color:#7dd3fc;font-weight:600;}
    .f-keys{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;}
    .f-key{font-family:'IBM Plex Mono',monospace;font-size:0.62rem;background:rgba(56,189,248,0.1);border:0.5px solid rgba(56,189,248,0.3);color:#7dd3fc;padding:2px 7px;border-radius:4px;text-decoration:none;}
    .f-key:hover{background:rgba(56,189,248,0.2);}
    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .tbl th{padding:8px 10px;text-align:right;font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#04090f;border-bottom:0.5px solid #0e1e36;}
    .tbl th:first-child{text-align:left;}
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;text-align:right;}
    .tbl td:first-child{text-align:left;}
    .empty{text-align:center;padding:50px 20px;color:#4a6080;font-size:0.85rem;}
    .note{font-size:0.68rem;color:#4a6080;line-height:1.6;}
    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .page-title{color:#1e293b!important;}
    :root[data-theme="light"] .page-sub,:root[data-theme="light"] .sc-label,:root[data-theme="light"] .panel h3,:root[data-theme="light"] .tbar label,:root[data-theme="light"] .meta,:root[data-theme="light"] .note{color:#64748b!important;}
    :root[data-theme="light"] .sc,:root[data-theme="light"] .panel{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .tbar{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbar select{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .f{background:#f8fafc!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .f-title{color:#1e293b!important;}
    :root[data-theme="light"] .f-detail{color:#64748b!important;}
    :root[data-theme="light"] .f-sug{color:#334155!important;}
    :root[data-theme="light"] .tbl th{background:#f1f5f9!important;color:#64748b!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbl td{border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .empty{color:#94a3b8!important;}
  </style>
</head>
<body>
<div class="app-shell">
  ${buildSidebar('advisor', false)}
  <div class="main-content">
    <h1 class="page-title">🧭 Settings Advisor</h1>
    <p class="page-sub">Reads your own recorded trades and says which setting to look at. Runs offline — nothing is sent anywhere, and nothing is changed for you.</p>

    <div class="tbar">
      <label>Book</label>
      <select id="fBook"><option value="paper">Paper</option><option value="live">Live</option></select>
      <label>Window</label>
      <select id="fDays">
        <option value="30">Last 30 days</option>
        <option value="90" selected>Last 90 days</option>
        <option value="180">Last 180 days</option>
        <option value="3650">Everything</option>
      </select>
      <button class="btn" id="btnRun">↻ Re-analyse</button>
      <span class="meta" id="meta"></span>
    </div>

    <div id="content"><div class="empty">Analysing…</div></div>
  </div>
</div>

<script>
const SEV = { high:{c:'#ef4444',l:'Act on this'}, medium:{c:'#f59e0b',l:'Worth a look'}, info:{c:'#38bdf8',l:'Context'} };

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function inr(n){ const v=Math.round(n); return (v<0?'-':'')+'₹'+Math.abs(v).toLocaleString('en-IN'); }
function pc(n){ return n>=0?'#10b981':'#ef4444'; }

async function load(){
  const book = document.getElementById('fBook').value;
  const days = document.getElementById('fDays').value;
  const C = document.getElementById('content');
  C.innerHTML = '<div class="empty">Analysing…</div>';
  let j;
  try {
    const r = await fetch('/advisor/data?book='+encodeURIComponent(book)+'&days='+encodeURIComponent(days));
    j = await r.json();
  } catch(e){
    C.innerHTML = '<div class="empty">Could not load the report: '+esc(e.message)+'</div>';
    return;
  }
  if(!j || !j.success){
    C.innerHTML = '<div class="empty">Could not load the report: '+esc(j && j.error)+'</div>';
    return;
  }
  render(j.report);
}

function render(r){
  const t = r.totals;
  document.getElementById('meta').textContent =
    r.window.from+' → '+r.window.to
    + (r.lastWeekly ? '  ·  weekly snapshot: '+new Date(r.lastWeekly.generatedAt).toLocaleDateString('en-IN') : '');

  let h = '<div class="stat-grid">'
    + card('Trades', t.trades, '#38bdf8')
    + card('Net P&L', inr(t.net), pc(t.net))
    + card('Win Rate', t.winRate.toFixed(1)+'%', t.winRate>=50?'#10b981':'#f59e0b')
    + card('Profit Factor', (t.profitFactor===null?'∞':t.profitFactor.toFixed(2)), t.profitFactor===null||t.profitFactor>=1.2?'#10b981':(t.profitFactor>=1?'#f59e0b':'#ef4444'))
    + card('Action Items', r.counts.high+r.counts.medium, (r.counts.high?'#ef4444':(r.counts.medium?'#f59e0b':'#10b981')))
    + '</div>';

  if(!t.trades){
    h += '<div class="panel"><div class="empty">No '+esc(r.book)+' trades in this window. Widen the window, or switch book.</div></div>';
    document.getElementById('content').innerHTML = h;
    return;
  }

  h += '<div class="panel"><h3>What to change</h3>';
  if(!r.findings.length){
    h += '<div class="empty">Nothing stands out. Keep collecting sessions.</div>';
  } else {
    for(const f of r.findings) h += finding(f);
  }
  h += '</div>';

  h += '<div class="panel"><h3>By Strategy — worst first</h3><table class="tbl"><thead><tr>'
    + '<th>Strategy</th><th>Trades</th><th>WR</th><th>Net</th><th>Per trade</th><th>PF</th><th>Worst run (1 day)</th>'
    + '</tr></thead><tbody>';
  for(const m of r.perMode){
    h += '<tr><td>'+esc(m.label)+'</td><td>'+m.trades+'</td><td>'+m.winRate.toFixed(0)+'%</td>'
      + '<td style="color:'+pc(m.net)+'">'+inr(m.net)+'</td>'
      + '<td style="color:'+pc(m.expectancy)+'">'+inr(m.expectancy)+'</td>'
      + '<td>'+(m.profitFactor===null?'∞':m.profitFactor.toFixed(2))+'</td>'
      + '<td>'+m.maxLossStreak+'L</td></tr>';
  }
  h += '</tbody></table></div>';

  h += '<div class="panel"><h3>How to read this</h3><p class="note">'
    + 'Findings only appear once a strategy has at least '+r.minTrades+' trades in the window, and a bucket '
    + '(exit reason, hour, weekday) needs at least 5 trades of its own. Nothing here is applied automatically — '
    + 'open Settings, change the named key, save with a checkpoint note, then compare next week. '
    + 'Trades taken before a bug fix were produced by different code, so prefer a clean recent window when tuning.'
    + '</p></div>';

  document.getElementById('content').innerHTML = h;
}

function card(label, val, colour){
  return '<div class="sc" style="--accent:'+colour+'"><div class="sc-label">'+label+'</div>'
       + '<div class="sc-val" style="color:'+colour+'">'+val+'</div></div>';
}

function finding(f){
  const s = SEV[f.severity] || SEV.info;
  let h = '<div class="f" style="--sev:'+s.c+'">'
    + '<div class="f-head">'
    + '<span class="f-sev" style="background:'+s.c+'22;color:'+s.c+'">'+s.l+'</span>'
    + '<span class="f-title">'+esc(f.title)+'</span></div>'
    + '<div class="f-detail">'+esc(f.detail)+'</div>'
    + '<div class="f-sug"><b>Do this:</b> '+esc(f.suggestion)+'</div>';
  if(f.keys && f.keys.length){
    h += '<div class="f-keys">';
    for(const k of f.keys) h += '<a class="f-key" href="/settings" title="Open Settings and search for this key">'+esc(k)+'</a>';
    h += '</div>';
  }
  return h + '</div>';
}

document.getElementById('fBook').addEventListener('change', load);
document.getElementById('fDays').addEventListener('change', load);
document.getElementById('btnRun').addEventListener('click', load);
load();
</script>
</body>
</html>`;
  res.send(html);
});

module.exports = router;

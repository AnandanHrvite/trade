/**
 * SCALP-STYLE UI HELPERS — shared shell for ORB / Straddle / Scalp paper & live pages.
 *
 * The Scalp Paper page (src/routes/scalpPaper.js) is the canonical UI design.
 * These helpers extract the look-and-feel pieces (CSS, top bar, capital strip,
 * stat-card grid, current-bar grid, activity log) so the other strategy pages
 * can mirror it without duplicating ~600 lines of HTML each.
 *
 * Strategy-specific content (position panel, chart overlays, trades table,
 * AJAX field mapping) still lives inline in each route file — only the
 * **shell** is shared.
 */

function inr(n) {
  return typeof n === "number"
    ? "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
}

function scalpStyleCSS() {
  return `
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#060810;color:#c0d0e8;min-height:100vh;display:flex;flex-direction:column;}
.main-content{flex:1;padding:28px 32px;margin-left:220px;}
@media(max-width:900px){.main-content{margin-left:0;padding:16px;}}

/* Top bar */
.top-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px;}
.top-bar-title{font-size:1.15rem;font-weight:700;color:#e0eaf8;}
.top-bar-meta{font-size:0.68rem;color:#4a6080;margin-top:3px;}
.top-bar-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.top-bar-badge{font-size:0.65rem;font-weight:700;padding:4px 10px;border-radius:6px;text-transform:uppercase;letter-spacing:0.8px;display:inline-flex;align-items:center;gap:5px;border:1px solid #1a2236;color:#4a6080;}
.badge-running{background:#064e3b;color:#10b981;border:1px solid #10b981;}
.badge-stopped{background:#1c1017;color:#ef4444;border:1px solid #ef4444;}
.badge-dry{background:rgba(245,158,11,0.12);color:#fbbf24;border:1px solid rgba(245,158,11,0.4);}
.badge-live{background:rgba(239,68,68,0.12);color:#ef4444;border:1px solid rgba(239,68,68,0.4);}

/* Banner (live pages) */
.banner{border-radius:8px;padding:8px 14px;margin-bottom:14px;font-size:0.72rem;font-weight:700;}
.banner-dry{background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.4);color:#fbbf24;}
.banner-live{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.4);color:#ef4444;}

/* Capital strip */
.capital-strip{display:flex;background:#0d1320;border:1px solid #1a2236;border-radius:9px;overflow:hidden;margin-bottom:14px;}
.cap-cell{flex:1;padding:11px 16px;border-right:1px solid #1a2236;}
.cap-cell:last-child{border-right:none;}
.cap-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.5px;color:#4a6080;margin-bottom:4px;}
.cap-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#c8d8f0;}

/* Stat cards */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-bottom:16px;}
.sc{background:#0d1320;border:1px solid #1a2236;border-radius:8px;padding:12px 14px;position:relative;overflow:hidden;}
.sc-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.2px;color:#4a6080;margin-bottom:5px;}
.sc-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#c8d8f0;}
.sc-sub{font-size:0.6rem;color:#4a6080;margin-top:3px;}

/* Section title */
.section-title{font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#4a6080;margin-bottom:8px;display:flex;align-items:center;gap:8px;}
.section-title::after{content:'';flex:1;height:0.5px;background:#1a2236;}

/* Copy buttons */
.copy-btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;transition:all 0.15s;white-space:nowrap;}
.copy-btn:hover{background:#0a1e3d;border-color:#3b82f6;}
.copy-btn.copied{background:#064e3b;border-color:#10b981;color:#10b981;}

/* Pulse animation */
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.4;}}

/* Activity log */
.log-box{background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:12px 16px;max-height:360px;overflow-y:auto;}

/* Mobile */
@media(max-width:640px){
  .main-content{margin-left:0;padding:14px 12px 40px;}
  .stat-grid{grid-template-columns:1fr 1fr;gap:7px;}
  .capital-strip{flex-wrap:wrap;}
  .cap-cell{min-width:50%;}
}
`;
}

/**
 * Top bar — title + meta line + status badge + optional VIX + action buttons.
 *
 * opts:
 *   title           string
 *   metaLine        string (smaller subtitle below the title)
 *   running         boolean
 *   vix             { enabled, value, maxEntry, strongOnly? }  (or null)
 *   primaryAction   { label, href, color? }  e.g. Start Scalp Paper
 *   stopAction      { label, href }          shown when running
 *   historyHref     string (or null)
 *   resetJs         string (or null) — inline onclick JS
 *   liveBadge       { kind: 'dry' | 'live' } | null
 */
function scalpTopBar(opts) {
  const o = opts || {};
  const vixBadge = (o.vix && o.vix.enabled)
    ? (() => {
        const v = o.vix.value;
        const m = o.vix.maxEntry;
        const s = o.vix.strongOnly == null ? Infinity : o.vix.strongOnly;
        const c = v == null ? "#94a3b8" : v > m ? "#ef4444" : v > s ? "#eab308" : "#10b981";
        const bg = v == null ? "rgba(100,116,139,0.08)" : v > m ? "rgba(239,68,68,0.1)" : v > s ? "rgba(234,179,8,0.1)" : "rgba(16,185,129,0.1)";
        const bd = v == null ? "rgba(100,116,139,0.3)" : v > m ? "rgba(239,68,68,0.3)" : v > s ? "rgba(234,179,8,0.3)" : "rgba(16,185,129,0.3)";
        const label = v == null ? "n/a" : (v.toFixed(1) + (v > m ? " · BLOCKED" : v > s ? " · STRONG ONLY" : " · NORMAL"));
        return `<span class="top-bar-badge" style="border-color:${bd};background:${bg};color:${c};">VIX ${label}</span>`;
      })()
    : "";

  const liveBadge = o.liveBadge
    ? (o.liveBadge.kind === "dry"
        ? `<span class="top-bar-badge badge-dry">DRY-RUN</span>`
        : `<span class="top-bar-badge badge-live">LIVE</span>`)
    : "";

  const statusBadge = o.running
    ? `<span class="top-bar-badge badge-running"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>RUNNING</span>`
    : `<span class="top-bar-badge badge-stopped">IDLE</span>`;

  const primaryBtn = o.running
    ? (o.stopAction
        ? `<button onclick="location='${o.stopAction.href}'" style="background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;padding:5px 14px;border-radius:6px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;">${o.stopAction.label}</button>`
        : "")
    : (o.primaryAction
        ? `<button onclick="location='${o.primaryAction.href}'" style="background:${o.primaryAction.color || "#1e40af"};border:1px solid #3b82f6;color:#fff;padding:5px 14px;border-radius:6px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;">${o.primaryAction.label}</button>`
        : "");

  const historyBtn = o.historyHref
    ? `<a href="${o.historyHref}" style="background:rgba(59,130,246,0.08);border:0.5px solid rgba(59,130,246,0.3);color:#60a5fa;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;text-decoration:none;font-family:inherit;">\u{1f4ca} History</a>`
    : "";
  const resetBtn = o.resetJs
    ? `<button onclick="${o.resetJs}" style="background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;">↺ Reset</button>`
    : "";

  return `
<div class="top-bar">
  <div>
    <div class="top-bar-title">${o.title || ""}</div>
    <div class="top-bar-meta">${o.metaLine || ""}</div>
  </div>
  <div class="top-bar-right">
    ${statusBadge}
    ${liveBadge}
    ${vixBadge}
    ${primaryBtn}
    ${historyBtn}
    ${resetBtn}
  </div>
</div>`;
}

/**
 * Capital strip — 3 cells + note cell.
 *
 * opts: { starting, current, allTime, note, currentId, allTimeId, startingThreshold }
 */
function scalpCapitalStrip(opts) {
  const o = opts || {};
  const starting = o.starting || 0;
  const current = o.current || 0;
  const allTime = o.allTime || 0;
  const threshold = o.startingThreshold == null ? starting : o.startingThreshold;
  const currColor = current >= threshold ? "#10b981" : "#ef4444";
  const allColor = allTime >= 0 ? "#10b981" : "#ef4444";
  return `
<div class="capital-strip">
  <div class="cap-cell">
    <div class="cap-label">Starting Capital</div>
    <div class="cap-val">₹${starting.toLocaleString("en-IN")}</div>
  </div>
  <div class="cap-cell">
    <div class="cap-label">Current Capital</div>
    <div class="cap-val" id="${o.currentId || "ajax-current-capital"}" style="color:${currColor};">₹${current.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
  </div>
  <div class="cap-cell">
    <div class="cap-label">All-Time PnL</div>
    <div class="cap-val" id="${o.allTimeId || "ajax-alltime-pnl"}" style="color:${allColor};">${allTime >= 0 ? "+" : ""}₹${allTime.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
  </div>
  <div class="cap-cell" style="font-size:0.62rem;color:#4a6080;max-width:200px;line-height:1.5;display:flex;align-items:center;">${o.note || "Capital updates when sessions complete. Reset wipes history."}</div>
</div>`;
}

/**
 * Single stat card.
 *
 * card: { label, value, valueId?, sub?, subId?, accent? (border-top color), color? (val color) }
 */
function scalpStatCard(card) {
  const c = card || {};
  const border = c.accent ? `border-top:2px solid ${c.accent};` : "";
  const valColor = c.color ? `color:${c.color};` : "";
  const valId = c.valueId ? `id="${c.valueId}"` : "";
  const subId = c.subId ? `id="${c.subId}"` : "";
  return `
<div class="sc" style="${border}">
  <div class="sc-label">${c.label || ""}</div>
  <div class="sc-val" ${valId} style="${valColor}">${c.value == null ? "—" : c.value}</div>
  ${c.sub ? `<div class="sc-sub" ${subId}>${c.sub}</div>` : ""}
</div>`;
}

/**
 * Stat grid wrapper.
 */
function scalpStatGrid(cards) {
  return `<div class="stat-grid">${(cards || []).map(scalpStatCard).join("")}</div>`;
}

/**
 * Current N-min bar (forming) — OHLC mini cards.
 */
function scalpCurrentBar(opts) {
  const o = opts || {};
  const bar = o.bar || null;
  const resMin = o.resMin || 5;
  const keys = ["open", "high", "low", "close"];
  return `
<div style="margin-bottom:18px;">
  <div class="section-title">Current ${resMin}-Min Bar (forming)</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
    ${keys.map(k => `
    <div class="sc">
      <div class="sc-label">${k.toUpperCase()}</div>
      <div class="sc-val" id="ajax-bar-${k}" style="font-size:1rem;">${bar && typeof bar[k] === "number" ? inr(bar[k]) : "—"}</div>
    </div>`).join("")}
  </div>
</div>`;
}

/**
 * Activity log section + JS for search/filter/paginate.
 * Emits a <div id="logBox"> and a <div id="logPag"> plus inline script.
 */
function scalpActivityLog(opts) {
  const o = opts || {};
  const logsJSON = o.logsJSON || "[]";
  return `
<!-- Activity Log -->
<div style="margin-bottom:18px;">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
    <div class="section-title" style="margin-bottom:0;">Activity Log</div>
    <input id="logSearch" placeholder="Search log…" oninput="logFilter()"
      style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 9px;border-radius:6px;font-size:0.73rem;font-family:inherit;width:180px;"/>
    <select id="logType" onchange="logFilter()"
      style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
      <option value="">All entries</option>
      <option value="BUY">Entries</option>
      <option value="Exit">Exits</option>
      <option value="✅">Wins</option>
      <option value="❌">Losses</option>
      <option value="🚨">Alerts</option>
    </select>
    <select id="logPP" onchange="logFilter()"
      style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
      <option value="50">50/page</option>
      <option value="100">100/page</option>
      <option value="9999">All</option>
    </select>
    <span id="logCount" style="font-size:0.7rem;color:#4a6080;"></span>
    <button class="copy-btn" onclick="copyActivityLog(this)" style="margin-left:auto;">\u{1f4cb} Copy Log</button>
  </div>
  <div id="logBox" class="log-box"></div>
  <div id="logPag" style="display:flex;gap:5px;margin-top:8px;flex-wrap:wrap;"></div>
</div>

<script id="log-data" type="application/json">${logsJSON}</script>
<script>
var LOG_ALL = JSON.parse(document.getElementById('log-data').textContent);
var logFiltered = LOG_ALL.slice(), logPg = 1, logPP = 50;
function logFilter(){
  var s = document.getElementById('logSearch').value.toLowerCase();
  var t = document.getElementById('logType').value;
  logPP = parseInt(document.getElementById('logPP').value);
  logPg = 1;
  logFiltered = LOG_ALL.filter(function(l){
    if(t && l.indexOf(t)<0) return false;
    if(s && l.toLowerCase().indexOf(s)<0) return false;
    return true;
  });
  logRender();
}
function logRender(){
  var start=(logPg-1)*logPP, slice=logFiltered.slice(start,start+logPP);
  document.getElementById('logCount').textContent = logFiltered.length+' of '+LOG_ALL.length;
  var box=document.getElementById('logBox');
  if(slice.length===0){ box.innerHTML='<div style="color:#4a6080;font-size:0.78rem;">No entries match.</div>'; document.getElementById('logPag').innerHTML=''; return; }
  box.innerHTML = slice.map(function(l){
    var isBuy = l.indexOf('BUY')>=0;
    var isExit = l.indexOf('Exit')>=0;
    var c = l.indexOf('\\u274c')>=0?'#ef4444':l.indexOf('\\u2705')>=0?'#10b981':l.indexOf('\\ud83d\\udea8')>=0?'#f59e0b':isBuy?'#60a5fa':isExit?'#f472b6':'#4a6080';
    var bg = isBuy?'rgba(96,165,250,0.06)':isExit?'rgba(244,114,182,0.06)':'transparent';
    var lbl = isBuy?'<span style="background:#1e3a5f;color:#60a5fa;font-size:0.58rem;font-weight:700;padding:1px 5px;border-radius:3px;margin-right:6px;">ENTRY</span>':isExit?'<span style="background:#4a1942;color:#f472b6;font-size:0.58rem;font-weight:700;padding:1px 5px;border-radius:3px;margin-right:6px;">EXIT</span>':'';
    return '<div style="padding:5px 6px;border-bottom:1px solid #1a2236;font-size:0.72rem;font-family:monospace;color:'+c+';line-height:1.4;background:'+bg+';">'+lbl+l+'</div>';
  }).join('');
  var total=Math.ceil(logFiltered.length/logPP);
  var pag=document.getElementById('logPag');
  if(total<=1){ pag.innerHTML=''; return; }
  var h='<button onclick="logGo('+(logPg-1)+')" '+(logPg===1?'disabled':'')+' style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">Prev</button>';
  for(var p=Math.max(1,logPg-2);p<=Math.min(total,logPg+2);p++)
    h+='<button onclick="logGo('+p+')" style="background:'+(p===logPg?'#0a1e3d':'#0d1320')+';border:1px solid '+(p===logPg?'#3b82f6':'#1a2236')+';color:'+(p===logPg?'#3b82f6':'#c8d8f0')+';padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">'+p+'</button>';
  h+='<button onclick="logGo('+(logPg+1)+')" '+(logPg===total?'disabled':'')+' style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">Next</button>';
  pag.innerHTML=h;
}
function logGo(p){ logPg=Math.max(1,Math.min(Math.ceil(logFiltered.length/logPP),p)); logRender(); }
function copyActivityLog(btn){
  var orig = btn.innerHTML;
  var text = LOG_ALL.join('\\n');
  function onOk(){ btn.classList.add('copied'); btn.innerHTML='\\u2705 Copied!'; setTimeout(function(){ btn.classList.remove('copied'); btn.innerHTML=orig; },2000); }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(onOk).catch(function(){
      var ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); onOk();
    });
  } else {
    var ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); onOk();
  }
}
logFilter();
</script>
`;
}

module.exports = {
  inr,
  scalpStyleCSS,
  scalpTopBar,
  scalpCapitalStrip,
  scalpStatCard,
  scalpStatGrid,
  scalpCurrentBar,
  scalpActivityLog,
};

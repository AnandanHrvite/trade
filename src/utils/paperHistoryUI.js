/**
 * paperHistoryUI.js — shared builder for the per-strategy Paper Trade History page.
 *
 * The BB_RSI Paper history page is the canonical UI. This module reproduces that
 * exact layout (top-bar, summary stat cards, server-paginated Daily Data Files,
 * Day View, full Analytics + Loss Analysis panels, session cards, trade-detail
 * and JSONL-viewer modals) so every strategy renders an identical page.
 *
 * Two ways to use it:
 *   1. renderHistoryPage(cfg) — full page (used by ORB).
 *   2. dailyFilesSectionHTML() + dailyFilesClusterJS(prefix) — the
 *      server-side-paginated Daily Data Files cluster, used to patch the
 *      already-built BB_RSI/EMA_RSI_ST/PA pages in place.
 *
 * Server-side pagination: the per-strategy `/download/daily-files` endpoint
 * accepts `?page=&pageSize=` and returns one slice via dailyFilesPaginate().
 */

const {
  buildSidebar, sidebarCSS, modalCSS, modalJS,
  tableEnhancerCSS, tableEnhancerJS, faviconLink,
} = require("./sharedNav");
const {
  attachContractNotes, brokerForRoute,
  contractNoteModalHTML, contractNoteClientJS,
} = require("./contractNote");

function inr(n) {
  return typeof n === "number"
    ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
}
function pnlColor(n) { return (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444"; }

// ── Server-side pagination helper for the daily-files endpoint ───────────────
/**
 * @param {Array} allRows  full, already-sorted row list
 * @param {Object} query   req.query ({ page, pageSize })
 * @returns {{rows:Array,total:number,page:number,pageSize:number,totalPages:number}}
 * pageSize omitted or 0 → return all rows (used by "Copy All Data").
 */
function dailyFilesPaginate(allRows, query) {
  const rows = Array.isArray(allRows) ? allRows : [];
  const total = rows.length;
  let pageSize = (query && query.pageSize !== undefined) ? parseInt(query.pageSize, 10) : 0;
  if (!Number.isFinite(pageSize) || pageSize < 0) pageSize = 0;
  let page = (query && query.page !== undefined) ? parseInt(query.page, 10) : 1;
  if (!Number.isFinite(page) || page < 1) page = 1;

  if (pageSize === 0) {
    return { rows, total, page: 1, pageSize: 0, totalPages: 1 };
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (page > totalPages) page = totalPages;
  const paged = rows.slice((page - 1) * pageSize, page * pageSize);
  return { rows: paged, total, page, pageSize, totalPages };
}

// ── Theme: activation script + light-mode overrides ─────────────────────────
// The Settings UI writes UI_THEME (dark|light). This <script> flips the
// data-theme attribute so the :root[data-theme="light"] rules below (and the
// shared sidebar/top-bar rules in sidebarCSS) take effect.
function themeInitScript() {
  return `<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>`;
}

// Light-mode overrides for the history page's own classes (sidebarCSS only
// themes the shell). Mirrors the EMA_RSI_ST history page's light rules so all five
// strategies look identical in either theme.
function historyLightCSS() {
  return `
    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .section-title{color:#475569!important;}
    :root[data-theme="light"] .session-card{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .session-head{background:#f8fafc!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .session-meta{color:#94a3b8!important;}
    :root[data-theme="light"] .session-wl{color:#64748b!important;}
    :root[data-theme="light"] .tbl th{color:#64748b!important;background:#f1f5f9!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbl td{border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .tbl tr:hover td{background:rgba(59,130,246,0.05)!important;}
    :root[data-theme="light"] .export-btn{background:#f8fafc!important;border-color:#e0e4ea!important;color:#64748b!important;}
    :root[data-theme="light"] .export-btn:hover{border-color:#3b82f6!important;color:#2563eb!important;}
    :root[data-theme="light"] .copy-btn{background:#f8fafc!important;border-color:#e0e4ea!important;color:#2563eb!important;}
    :root[data-theme="light"] .copy-btn:hover{background:#eff6ff!important;border-color:#3b82f6!important;}
    :root[data-theme="light"] .dw-toggle{border-color:#e0e4ea!important;color:#2563eb!important;}
    :root[data-theme="light"] .dw-toggle:hover,:root[data-theme="light"] .dw-toggle.active{background:#eff6ff!important;border-color:#3b82f6!important;}
    :root[data-theme="light"] .ana-card{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .ana-card h3{color:#64748b!important;}
    :root[data-theme="light"] .ana-mini{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .ana-mini h3{color:#64748b!important;}
    :root[data-theme="light"] .ana-tbl th{color:#64748b!important;border-bottom-color:#e0e4ea!important;background:#f1f5f9!important;}
    :root[data-theme="light"] .ana-tbl td{color:#334155!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .ana-tbl tr:hover{background:#f8fafc!important;}
    :root[data-theme="light"] .ana-stat-label{color:#64748b!important;}
    :root[data-theme="light"] .tbar{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbar-label{color:#64748b!important;}
    :root[data-theme="light"] .tbar-count{color:#94a3b8!important;}
    :root[data-theme="light"] .sc{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .sc-label{color:#64748b!important;}
    :root[data-theme="light"] .sc-val{color:#1e293b!important;}
    :root[data-theme="light"] .sc-sub{color:#94a3b8!important;}
    :root[data-theme="light"] .reset-btn{background:rgba(239,68,68,0.08)!important;color:#dc2626!important;border-color:rgba(239,68,68,0.3)!important;}`;
}

// ── CSS (mirrors the BB_RSI history page <style> block) ───────────────────────
function historyCSS() {
  return `
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    ${modalCSS()}
    ${tableEnhancerCSS()}
    .session-card{background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;overflow:hidden;margin-bottom:18px;}
    .session-head{padding:16px 20px;display:flex;align-items:center;justify-content:space-between;background:#040c18;border-bottom:0.5px solid #0e1e36;gap:12px;flex-wrap:wrap;cursor:pointer;transition:background 0.15s;}
    .session-head:hover{background:#060e1c;}
    .session-meta{font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;margin-bottom:4px;}
    .session-pnl{font-size:1.5rem;font-weight:800;font-family:'IBM Plex Mono',monospace;text-align:right;}
    .session-wl{font-size:0.7rem;color:#4a6080;text-align:right;margin-top:2px;}
    .session-body{display:none;}
    .session-card.open .session-body{display:block;}
    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.75rem;}
    .tbl th{padding:8px 14px;text-align:left;font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;}
    .tbl td{padding:8px 14px;border-top:0.5px solid #0e1e36;color:#4a6080;vertical-align:middle;}
    .tbl tr:hover td{background:rgba(59,130,246,0.03);}
    .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.65rem;font-weight:700;}
    .badge-ce{background:rgba(16,185,129,0.12);color:#10b981;border:0.5px solid rgba(16,185,129,0.25);}
    .badge-pe{background:rgba(239,68,68,0.12);color:#ef4444;border:0.5px solid rgba(239,68,68,0.25);}
    .export-btn{background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 12px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.12s;}
    .export-btn:hover{border-color:#3b82f6;color:#60a5fa;}
    .reset-btn{background:#1a0508;border:0.5px solid #3b0a0a;color:#ef4444;padding:5px 12px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.12s;}
    .reset-btn:hover{background:#2a0810;border-color:#ef4444;}
    .copy-btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;transition:all 0.15s;white-space:nowrap;}
    .copy-btn:hover{background:#0a1e3d;border-color:#3b82f6;}
    .copy-btn.copied{background:#064e3b;border-color:#10b981;color:#10b981;}
    .dw-toggle{background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;transition:all 0.15s;}.dw-toggle:hover{border-color:#3b82f6;background:#0a1e3d;}.dw-toggle.active{background:#0a1e3d;border-color:#3b82f6;}
    .ana-panel{margin-bottom:16px;}
    .ana-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
    @media(max-width:900px){.ana-row{grid-template-columns:1fr;}}
    .ana-card{background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:14px 16px;position:relative;}
    .ana-card h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
    .ana-chart-wrap{position:relative;height:220px;}
    .ana-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;}
    @media(max-width:900px){.ana-row3{grid-template-columns:1fr;}}
    .ana-mini{background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:12px 14px;}
    .ana-mini h3{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:8px;font-family:'IBM Plex Mono',monospace;}
    .ana-tbl{width:100%;border-collapse:collapse;}
    .ana-tbl th{text-align:left;font-size:0.55rem;text-transform:uppercase;letter-spacing:0.8px;color:#1e3050;padding:5px 8px;border-bottom:0.5px solid #0e1428;font-family:'IBM Plex Mono',monospace;}
    .ana-tbl td{padding:5px 8px;font-size:0.72rem;font-family:'IBM Plex Mono',monospace;color:#4a6080;border-bottom:0.5px solid #060a14;}
    .ana-tbl tr:hover{background:#060c1a;}
    .ana-stat{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;}
    .ana-stat-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
    .ana-stat-label{font-size:0.62rem;color:#3a5070;}
    .tbar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#07111f;border:0.5px solid #0e1e36;border-radius:8px;margin-bottom:10px;flex-wrap:wrap;}
    .tbar-label{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.5px;color:#3a5070;font-weight:700;font-family:'IBM Plex Mono',monospace;}
    .tbar-count{font-size:0.68rem;color:#4a6080;}
    @media print {
      .sidebar, .hamburger, .sidebar-overlay, .top-bar, .export-btn, .reset-btn, .copy-btn, .dw-toggle, .ana-panel, #dayWiseWrap, .tbar { display: none !important; }
      .main-content { margin-left: 0 !important; }
      body { background: #fff !important; color: #000 !important; }
      .session-card { background: #fff !important; border: 1px solid #ccc !important; break-inside: avoid; }
      .tbl td, .tbl th { color: #000 !important; border-color: #ddd !important; }
    }
    @media(max-width:768px){
      .sidebar{transform:translateX(-100%);}
      .main-content{margin-left:0;}
      .tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
      .tbl{min-width:700px;}
      .tbl td,.tbl th{padding:6px 8px;font-size:0.68rem;}
      .top-bar{padding:7px 10px 7px 48px;}
      .top-bar-meta{display:none;}
      .stat-grid{grid-template-columns:1fr 1fr;}
      .top-bar-right{gap:4px;}
      .export-btn,.reset-btn{padding:4px 8px;font-size:0.62rem;}
    }`;
}

// ── Daily Data Files section (server-side paginated) ─────────────────────────
function dailyFilesSectionHTML() {
  return `
    <div id="dailyFilesWrap" style="margin-bottom:16px;">
      <div class="tbar">
        <span class="tbar-label">📁 Daily Data Files</span>
        <span class="tbar-count" id="dailyFilesCnt"></span>
        <button class="copy-btn" onclick="copyAllDailyFiles(this)" style="margin-left:auto;" title="Copy all skip + trade JSONL across all dates">📋 Copy All Data</button>
        <button class="dw-toggle" onclick="toggleDailyFiles()" id="dailyFilesToggle">Show</button>
      </div>
      <div id="dailyFilesBody" style="overflow-x:auto;display:none;">
        <table id="dailyFilesTbl" class="tbl" style="width:100%;"><thead><tr>
          <th>Date (IST)</th><th>Skip JSONL</th><th>Trade JSONL</th><th>Actions</th>
        </tr></thead><tbody id="dailyFilesRows"><tr><td colspan="4" style="text-align:center;color:#4a6080;padding:12px;">Loading…</td></tr></tbody></table>
        <div id="dfPager" style="display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap;font-family:'IBM Plex Mono',monospace;font-size:0.66rem;color:#4a6080;">
          <label style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1px;color:#3a5070;">Rows</label>
          <select id="dfPageSize" style="background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:3px 6px;border-radius:5px;font-family:inherit;font-size:0.66rem;outline:none;cursor:pointer;">
            <option value="5">5</option><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="0">All</option>
          </select>
          <span id="dfPagerInfo" style="margin:0 4px;"></span>
          <button class="copy-btn" id="dfFirst" style="padding:3px 8px;min-width:26px;" title="First">«</button>
          <button class="copy-btn" id="dfPrev"  style="padding:3px 8px;min-width:26px;" title="Prev">‹</button>
          <button class="copy-btn" id="dfNext"  style="padding:3px 8px;min-width:26px;" title="Next">›</button>
          <button class="copy-btn" id="dfLast"  style="padding:3px 8px;min-width:26px;" title="Last">»</button>
        </div>
      </div>
    </div>`;
}

// ── Daily Data Files + JSONL-viewer client runtime (server-side paginated) ───
function dailyFilesClusterJS(routePrefix) {
  return `
// ── Daily Data Files (skip + trade JSONL, server-side paginated) ─────────────
var _DF_PREFIX = '${routePrefix}';
var _dfPage = 1, _dfPageSize = 10;
function _dfFmtBytes(n){ if (!n) return '—'; if (n<1024) return n+' B'; if (n<1048576) return (n/1024).toFixed(1)+' KB'; return (n/1048576).toFixed(2)+' MB'; }
async function loadDailyFiles(){
  var tbody = document.getElementById('dailyFilesRows');
  try {
    var res = await fetch(_DF_PREFIX + '/download/daily-files?page=' + _dfPage + '&pageSize=' + _dfPageSize, { cache: 'no-store' });
    var d = await res.json();
    var rows = d.rows || [];
    document.getElementById('dailyFilesCnt').textContent = (d.total||0) + ' day' + ((d.total===1)?'':'s');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#4a6080;padding:12px;">No daily files yet — they\\'ll appear after the next paper session runs.</td></tr>';
    } else {
      tbody.innerHTML = rows.map(function(r){
        var sCell = r.skipsSize ? _dfFmtBytes(r.skipsSize) : '<span style="color:#4a6080;">—</span>';
        var tCell = r.tradesSize ? _dfFmtBytes(r.tradesSize) : '<span style="color:#4a6080;">—</span>';
        var btns  = '';
        if (r.skipsSize)  btns += '<button class="export-btn" style="margin-right:4px;" onclick="viewJsonl(\\'skips\\',\\''+r.date+'\\')" title="View skip JSONL for '+r.date+'">👁 Skips</button>';
        if (r.tradesSize) btns += '<button class="export-btn" style="margin-right:4px;" onclick="viewJsonl(\\'trades\\',\\''+r.date+'\\')" title="View trade JSONL for '+r.date+'">👁 Trades</button>';
        if (r.tradesSize) btns += '<button class="export-btn" style="background:rgba(16,185,129,0.08);color:#10b981;border-color:rgba(16,185,129,0.3);" onclick="restoreSession(\\''+r.date+'\\')" title="Rebuild session from JSONL — recovers deleted/missing trades">♻ Restore</button>';
        if (!btns) btns = '<span style="color:#4a6080;">—</span>';
        return '<tr><td>'+r.date+'</td><td>'+sCell+'</td><td>'+tCell+'</td><td>'+btns+'</td></tr>';
      }).join('');
    }
    _dfRenderPager(d);
  } catch(e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#e94560;padding:12px;">Failed to load: '+(e&&e.message||e)+'</td></tr>';
  }
}
function _dfRenderPager(d){
  var ps = _dfPageSize, total = d.total||0, totalPages = d.totalPages||1, page = d.page||1;
  _dfPage = page;
  var info = document.getElementById('dfPagerInfo');
  if (info){
    if (!total) info.textContent = '0 of 0';
    else if (ps === 0) info.textContent = 'All ' + total;
    else { var s=(page-1)*ps+1, e=Math.min(total,page*ps); info.textContent = s+'–'+e+' of '+total+' · pg '+page+'/'+totalPages; }
  }
  var f=document.getElementById('dfFirst'), p=document.getElementById('dfPrev'), n=document.getElementById('dfNext'), l=document.getElementById('dfLast');
  if (f) f.disabled = page<=1;
  if (p) p.disabled = page<=1;
  if (n) n.disabled = page>=totalPages;
  if (l) l.disabled = page>=totalPages;
}
(function wireDfPager(){
  var ps=document.getElementById('dfPageSize');
  if(ps) ps.addEventListener('change', function(e){ _dfPageSize = parseInt(e.target.value,10)||0; _dfPage = 1; loadDailyFiles(); });
  var b;
  b=document.getElementById('dfFirst'); if(b) b.addEventListener('click', function(){ if(_dfPage>1){ _dfPage=1; loadDailyFiles(); } });
  b=document.getElementById('dfPrev');  if(b) b.addEventListener('click', function(){ if(_dfPage>1){ _dfPage--; loadDailyFiles(); } });
  b=document.getElementById('dfNext');  if(b) b.addEventListener('click', function(){ _dfPage++; loadDailyFiles(); });
  b=document.getElementById('dfLast');  if(b) b.addEventListener('click', function(){ _dfPage=999999; loadDailyFiles(); });
})();
function toggleDailyFiles(){
  var b = document.getElementById('dailyFilesBody');
  var t = document.getElementById('dailyFilesToggle');
  if (b.style.display === 'none') { b.style.display = ''; t.textContent = 'Hide'; } else { b.style.display = 'none'; t.textContent = 'Show'; }
}
async function restoreSession(date){
  var ok = await showConfirm({
    icon: '🔄',
    title: 'Rebuild session',
    message: 'Rebuild session for '+date+' from daily JSONL?\\nThis will add any trades found there that are not already in a session.',
    confirmText: 'Rebuild'
  });
  if (!ok) return;
  try {
    var res = await fetch(_DF_PREFIX + '/restore-session/'+date, { method: 'POST', cache: 'no-store' });
    var d = await res.json();
    if (!d.success) { showAlert({icon:'⚠️',title:'Restore failed',message:d.error||'Unknown error',btnClass:'modal-btn-danger'}); return; }
    if (d.restored === 0) { showAlert({icon:'ℹ️',title:'Nothing to restore',message:d.message||'Nothing to restore',btnClass:'modal-btn-primary'}); return; }
    await showAlert({icon:'✅',title:'Restored',message:'Restored ' + d.restored + ' trade(s) — PnL ₹' + (d.sessionPnl || 0),btnClass:'modal-btn-success'});
    location.reload();
  } catch(e) { showAlert({icon:'⚠️',title:'Restore error',message:(e && e.message) || String(e),btnClass:'modal-btn-danger'}); }
}
loadDailyFiles();

// ── JSONL Table Viewer (modal) ────────────────────────────────────────────
var _JSONL_CURRENT_TEXT = '';
function _jsonlEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _renderJsonlTable(text){
  var lines = text.split(/\\r?\\n/).filter(function(l){ return l.trim(); });
  if (!lines.length) return { html: '<div style="padding:16px;color:#4a6080;text-align:center;">No data</div>', rows: 0, cols: 0 };
  var rows = [];
  var keys = [];
  var seen = {};
  for (var i=0; i<lines.length; i++){
    try {
      var o = JSON.parse(lines[i]);
      rows.push(o);
      for (var k in o) { if (!seen[k]) { seen[k] = 1; keys.push(k); } }
    } catch(_){ }
  }
  var html = '<div style="overflow:auto;max-height:72vh;border:1px solid #1a2236;border-radius:8px;"><table class="tbl" style="width:100%;font-size:0.68rem;font-family:\\'IBM Plex Mono\\',monospace;">';
  html += '<thead style="position:sticky;top:0;background:#07111f;z-index:1;"><tr>';
  html += '<th style="padding:6px 8px;color:#4a6080;">#</th>';
  for (var j=0; j<keys.length; j++) html += '<th style="padding:6px 8px;color:#4a9cf5;white-space:nowrap;">' + _jsonlEsc(keys[j]) + '</th>';
  html += '</tr></thead><tbody>';
  for (var r=0; r<rows.length; r++){
    html += '<tr>';
    html += '<td style="padding:4px 8px;color:#3a5070;">' + (r+1) + '</td>';
    for (var c=0; c<keys.length; c++){
      var v = rows[r][keys[c]];
      var disp = (v==null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
      html += '<td style="padding:4px 8px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + _jsonlEsc(disp) + '">' + _jsonlEsc(disp) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return { html: html, rows: rows.length, cols: keys.length };
}
async function viewJsonl(type, date){
  var modal = document.getElementById('jsonlModal');
  var body  = document.getElementById('jsonlm-body');
  var title = document.getElementById('jsonlm-title');
  var meta  = document.getElementById('jsonlm-meta');
  title.textContent = (type === 'skips' ? 'Skip' : 'Trade') + ' JSONL — ' + date;
  meta.textContent = 'Loading…';
  body.innerHTML = '<div style="padding:24px;color:#4a6080;text-align:center;">Loading…</div>';
  _JSONL_CURRENT_TEXT = '';
  modal.style.display = 'flex';
  try {
    var res = await fetch(_DF_PREFIX + '/view/' + type + '/' + date, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var text = await res.text();
    _JSONL_CURRENT_TEXT = text;
    var rendered = _renderJsonlTable(text);
    body.innerHTML = rendered.html;
    meta.textContent = rendered.rows + ' row' + (rendered.rows===1?'':'s') + ' · ' + rendered.cols + ' column' + (rendered.cols===1?'':'s');
  } catch(e) {
    meta.textContent = '';
    body.innerHTML = '<div style="padding:16px;color:#e94560;text-align:center;">Failed to load: ' + _jsonlEsc(e && e.message || e) + '</div>';
  }
}
function copyJsonlViewed(btn){
  if (!_JSONL_CURRENT_TEXT) { showAlert({icon:'\\u26a0\\ufe0f',title:'No Data',message:'Nothing to copy yet',btnClass:'modal-btn-primary'}); return; }
  doCopy(_JSONL_CURRENT_TEXT, btn, 'JSONL');
}
async function copyAllDailyFiles(btn){
  var orig = btn.innerHTML;
  btn.innerHTML = '\\u23f3 Fetching…';
  btn.disabled = true;
  try {
    var res = await fetch(_DF_PREFIX + '/download/daily-files?pageSize=0', { cache: 'no-store' });
    var d = await res.json();
    if (!d.rows || !d.rows.length) {
      btn.innerHTML = orig; btn.disabled = false;
      showAlert({icon:'\\u26a0\\ufe0f',title:'No Data',message:'No daily files to copy',btnClass:'modal-btn-primary'});
      return;
    }
    var parts = [];
    for (var i=0; i<d.rows.length; i++){
      var r = d.rows[i];
      if (r.skipsSize){
        var sres = await fetch(_DF_PREFIX + '/view/skips/' + r.date, { cache: 'no-store' });
        if (sres.ok) { var st = await sres.text(); parts.push('# === SKIPS ' + r.date + ' ===\\n' + st.replace(/\\s+$/, '')); }
      }
      if (r.tradesSize){
        var tres = await fetch(_DF_PREFIX + '/view/trades/' + r.date, { cache: 'no-store' });
        if (tres.ok) { var tt = await tres.text(); parts.push('# === TRADES ' + r.date + ' ===\\n' + tt.replace(/\\s+$/, '')); }
      }
    }
    var combined = parts.join('\\n\\n');
    btn.innerHTML = orig; btn.disabled = false;
    doCopy(combined, btn, 'All Data');
  } catch(e) {
    btn.innerHTML = orig; btn.disabled = false;
    showAlert({icon:'\\u274c',title:'Copy Failed',message:(e && e.message) || String(e),btnClass:'modal-btn-danger'});
  }
}
if (document.getElementById('jsonlModal')) {
  document.getElementById('jsonlModal').addEventListener('click', function(e){ if (e.target === this) this.style.display = 'none'; });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') { var m = document.getElementById('jsonlModal'); if (m && m.style.display !== 'none') m.style.display = 'none'; } });
}
if (typeof doCopy === 'undefined') {
  window.doCopy = function(text,btn,label){
    var orig='\\ud83d\\udccb Copy '+label;
    function onOk(){ btn.classList.add('copied');btn.textContent='\\u2705 Copied!'; setTimeout(function(){ btn.classList.remove('copied');btn.textContent=orig; },2000); }
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(onOk).catch(function(){
        var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
        document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);onOk();
      });
    } else {
      var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);onOk();
    }
  };
}`;
}

// ── JSONL viewer modal markup ────────────────────────────────────────────────
function jsonlModalHTML() {
  return `
<div id="jsonlModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
  <div style="background:#0d1320;border:1px solid #1d3b6e;border-radius:16px;padding:18px 20px;max-width:1400px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.9);">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
      <div>
        <span id="jsonlm-title" style="color:#e0eaf8;font-size:0.85rem;font-weight:600;"></span>
        <span id="jsonlm-meta" style="color:#4a6080;font-size:0.65rem;margin-left:8px;"></span>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="copy-btn" onclick="copyJsonlViewed(this)" id="jsonlm-copy">📋 Copy</button>
        <button onclick="document.getElementById('jsonlModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:#4a6080;font-size:0.75rem;cursor:pointer;padding:4px 12px;border-radius:6px;font-family:inherit;" onmouseover="this.style.color='#ef4444';this.style.borderColor='#ef4444'" onmouseout="this.style.color='#4a6080';this.style.borderColor='#1a2236'">Close</button>
      </div>
    </div>
    <div id="jsonlm-body" style="flex:1;overflow:auto;"></div>
  </div>
</div>`;
}

// ── Trade-detail modal markup ────────────────────────────────────────────────
function tradeModalHTML(modalLabel) {
  return `
<div id="histModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
  <div style="background:#0d1320;border:1px solid #1d3b6e;border-radius:16px;padding:24px 28px;max-width:720px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.9);position:relative;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
      <div>
        <span id="histm-badge" style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:4px 10px;border-radius:6px;"></span>
        <span style="font-size:0.65rem;color:#4a6080;margin-left:10px;">${modalLabel} — Trade Details</span>
      </div>
      <button onclick="document.getElementById('histModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:#4a6080;font-size:1rem;cursor:pointer;padding:4px 10px;border-radius:6px;font-family:inherit;" onmouseover="this.style.color='#ef4444';this.style.borderColor='#ef4444'" onmouseout="this.style.color='#4a6080';this.style.borderColor='#1a2236'">Close</button>
    </div>
    <div id="histm-body"></div>
  </div>
</div>`;
}

// ── Day View + Analytics section markup ──────────────────────────────────────
function dayViewSectionHTML() {
  return `
    <div id="dayWiseWrap" style="display:none;margin-bottom:16px;">
      <div class="tbar">
        <span class="tbar-label">Day View</span>
        <span class="tbar-count" id="dayCntLabel"></span>
        <button class="copy-btn" onclick="copyDayView(this)" style="margin-left:auto;">📋 Copy Day View</button>
      </div>
      <div style="overflow-x:auto;">
        <table class="tbl">
          <thead><tr>
            <th>Date</th><th>Trades</th><th>Wins</th><th>Losses</th><th>PnL</th><th>Cumulative PnL</th>
          </tr></thead>
          <tbody id="dayBody"></tbody>
        </table>
      </div>
      <div id="dwPager" style="display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap;font-family:'IBM Plex Mono',monospace;font-size:0.66rem;color:#4a6080;">
        <label style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1px;color:#3a5070;">Rows</label>
        <select id="dwPageSize" style="background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:3px 6px;border-radius:5px;font-family:inherit;font-size:0.66rem;outline:none;cursor:pointer;">
          <option value="5">5</option><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="0">All</option>
        </select>
        <span id="dwPagerInfo" style="margin:0 4px;"></span>
        <button class="copy-btn" id="dwFirst" style="padding:3px 8px;min-width:26px;" title="First">«</button>
        <button class="copy-btn" id="dwPrev"  style="padding:3px 8px;min-width:26px;" title="Prev">‹</button>
        <button class="copy-btn" id="dwNext"  style="padding:3px 8px;min-width:26px;" title="Next">›</button>
        <button class="copy-btn" id="dwLast"  style="padding:3px 8px;min-width:26px;" title="Last">»</button>
      </div>
    </div>`;
}

function analyticsSectionHTML(extraTopHTML) {
  return `
    <div id="anaWrap" style="display:none;margin-bottom:16px;" class="ana-panel">
      ${extraTopHTML || ""}
      <div class="ana-row">
        <div class="ana-card"><h3>📈 Equity Curve</h3><div class="ana-chart-wrap"><canvas id="anaEquity"></canvas></div></div>
        <div class="ana-card"><h3>📊 Monthly P&L</h3><div class="ana-chart-wrap"><canvas id="anaMonthly"></canvas></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-card"><h3>📉 Drawdown</h3><div class="ana-chart-wrap"><canvas id="anaDrawdown"></canvas></div></div>
        <div class="ana-card"><h3>⏰ Hourly Performance</h3><div class="ana-chart-wrap"><canvas id="anaHourly"></canvas></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>🔥 Win/Loss Streaks</h3><div id="anaStreaks"></div></div>
        <div class="ana-mini"><h3>📥 Entry Reason Breakdown</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Count</th><th>Wins</th><th>Losses</th><th>WR%</th><th>P&L</th><th>Avg</th></tr></thead><tbody id="anaEntryBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🚪 Exit Reason Breakdown</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Count</th><th>P&L</th><th>Avg</th></tr></thead><tbody id="anaExitBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📅 Day of Week</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Day</th><th>Trades</th><th>WR%</th><th>P&L</th><th>Avg</th></tr></thead><tbody id="anaDowBody"></tbody></table></div></div>
      </div>
      <div style="border-top:0.5px solid #0e1428;margin:16px 0 12px;padding-top:12px;">
        <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:1.5px;color:#ef4444;font-weight:700;margin-bottom:12px;font-family:'IBM Plex Mono',monospace;">🔍 Loss Analysis</div>
      </div>
      <div class="ana-row">
        <div class="ana-card"><h3>📊 Loss Distribution</h3><div class="ana-chart-wrap"><canvas id="anaLossDist"></canvas></div></div>
        <div class="ana-card"><h3>🔀 CE vs PE Performance</h3><div class="ana-chart-wrap"><canvas id="anaSidePerf"></canvas></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>💀 Top 10 Worst Trades</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Side</th><th>P&L</th><th>Exit</th></tr></thead><tbody id="anaWorstBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🔥 Consecutive Loss Streaks</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Start</th><th>Trades</th><th>Total Loss</th><th>Avg Loss</th></tr></thead><tbody id="anaLossStreakBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📊 Risk Metrics</h3><div id="anaRiskMetrics"></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>📅 Worst Trading Days</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Trades</th><th>Day P&L</th><th>Losses</th><th>Worst Trade</th></tr></thead><tbody id="anaWorstDayBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🚪 Loss by Exit Reason</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Loss Count</th><th>Total Loss</th><th>Avg Loss</th><th>% of Losses</th></tr></thead><tbody id="anaLossReasonBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>⏰ Losing Hours</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Hour</th><th>Losses</th><th>Loss P&L</th><th>Avg Loss</th><th>Loss%</th></tr></thead><tbody id="anaLossHourBody"></tbody></table></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini" style="grid-column:1 / -1;"><h3>📆 Day-wise Loss</h3><div style="overflow-x:auto;max-height:320px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Trades</th><th>Losing Trades</th><th>Gross Loss</th><th>Day Net</th></tr></thead><tbody id="anaDayLossBody"></tbody></table></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini" style="grid-column:1 / -1;"><h3>🕯️ Losses by Candles Held</h3><div style="overflow-x:auto;max-height:320px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Side</th><th>Candles Held</th><th>Loss</th><th>Exit</th></tr></thead><tbody id="anaLossCandleBody"></tbody></table></div></div>
      </div>
    </div>`;
}

// ── Trade-detail modal + Day View + Analytics client runtime ─────────────────
function tradeModalJS() {
  return `
function histFmt(n){ return (n != null && n !== 0 && n !== '') ? '\\u20b9' + Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '\\u2014'; }
function histCell(label, val, color, sub){
  return '<div style="background:#060910;border:1px solid #1a2236;border-radius:8px;padding:11px 13px;">'
    + '<div style="font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:5px;">' + label + '</div>'
    + '<div style="font-size:0.9rem;font-weight:700;color:' + (color||'#e0eaf8') + ';font-family:monospace;line-height:1.3;word-break:break-word;">' + (val||'\\u2014') + '</div>'
    + (sub ? '<div style="font-size:0.62rem;color:#4a6080;margin-top:3px;">' + sub + '</div>' : '')
    + '</div>';
}
function showHistoryTradeModal(sessionIdx, tradeIdx){
  var session = ALL_SESSIONS_JSON[sessionIdx]; if (!session || !session.trades) return;
  var t = session.trades[tradeIdx]; if (!t) return;
  var eSpot = t.spotAtEntry || t.entryPrice || null;
  var xSpot = t.spotAtExit  || t.exitPrice  || null;
  var eSl   = t.stopLoss || t.initialStopLoss || null;
  var pc  = t.pnl == null ? '#c8d8f0' : t.pnl >= 0 ? '#10b981' : '#ef4444';
  var sc  = t.side === 'CE' ? '#10b981' : '#ef4444';
  var optDiff = (t.optionEntryLtp != null && t.optionExitLtp != null) ? parseFloat((t.optionExitLtp - t.optionEntryLtp).toFixed(2)) : null;
  var dc  = optDiff == null ? '#c8d8f0' : optDiff >= 0 ? '#10b981' : '#ef4444';
  var pnlPts = (eSpot && xSpot && t.side) ? parseFloat(((t.side==='PE' ? eSpot - xSpot : xSpot - eSpot)).toFixed(2)) : null;
  var badge = document.getElementById('histm-badge');
  badge.textContent = (t.side || '\\u2014') + (t.optionStrike ? ' \\u00b7 ' + t.optionStrike : '') + (t.optionType ? ' ' + t.optionType : '');
  badge.style.background = t.side === 'CE' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
  badge.style.color = sc;
  badge.style.border = '1px solid ' + (t.side === 'CE' ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)');

  var contractHtml = '<div style="background:#06100e;border:1px solid #0d3020;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a6040;margin-bottom:8px;font-weight:700;">Option Contract</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
    + histCell('Symbol', t.symbol || '\\u2014', '#c8d8f0')
    + histCell('Strike', t.optionStrike || '\\u2014', '#e0eaf8')
    + histCell('Expiry', t.optionExpiry || '\\u2014', '#f59e0b')
    + histCell('Option Type', t.optionType || t.side || '\\u2014', sc)
    + histCell('Qty', t.qty ? t.qty + ' qty' : '\\u2014', '#c8d8f0')
    + histCell('PnL Mode', t.pnlMode || 'spot-diff', '#8b8bf0')
    + '</div></div>';
  var entryHtml = '<div style="background:#060c18;border:1px solid #0d2040;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a4080;margin-bottom:8px;font-weight:700;">Entry</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
    + histCell('Entry Time', t.entryTime || '\\u2014', '#c8d8f0')
    + histCell('NIFTY Spot @ Entry', histFmt(eSpot), '#e0eaf8')
    + histCell('Option LTP @ Entry', histFmt(t.optionEntryLtp), '#60a5fa')
    + histCell('Initial Stop Loss', histFmt(eSl), '#f59e0b', 'NIFTY spot SL level')
    + histCell('SL Distance', (eSl && eSpot) ? Math.abs(eSpot - eSl).toFixed(2) + ' pts' : '\\u2014', '#f59e0b')
    + histCell('Entry Signal', t.entryReason || '\\u2014', '#c8d8f0')
    + '</div></div>';
  var exitHtml = '<div style="background:#0c0608;border:1px solid #3a0d12;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#801a20;margin-bottom:8px;font-weight:700;">Exit</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'
    + histCell('Exit Time', t.exitTime || '\\u2014', '#c8d8f0')
    + histCell('NIFTY Spot @ Exit', histFmt(xSpot), '#e0eaf8')
    + histCell('Option LTP @ Exit', histFmt(t.optionExitLtp), '#60a5fa')
    + histCell('NIFTY Move (pts)', pnlPts != null ? (pnlPts >= 0 ? '+' : '') + pnlPts + ' pts' : '\\u2014', pnlPts != null ? (pnlPts >= 0 ? '#10b981' : '#ef4444') : '#c8d8f0', t.side === 'PE' ? 'Entry-Exit (PE profits on fall)' : 'Exit-Entry (CE profits on rise)')
    + histCell('Option Move (pts)', optDiff != null ? (optDiff >= 0 ? '\\u25b2 +' : '\\u25bc ') + optDiff + ' pts' : '\\u2014', dc)
    + histCell('Net PnL', t.pnl != null ? (t.pnl >= 0 ? '+' : '') + histFmt(t.pnl) : '\\u2014', pc, 'After STT + charges')
    + '</div></div>';
  var reasonHtml = '<div style="background:#060910;border:1px solid #1a2236;border-radius:10px;padding:12px 14px;">'
    + '<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#3a5070;margin-bottom:6px;font-weight:700;">Exit Reason</div>'
    + '<div style="font-size:0.82rem;color:#a0b8d0;line-height:1.6;font-family:monospace;word-break:break-word;">' + (t.exitReason || '\\u2014') + '</div>'
    + '</div>';
  document.getElementById('histm-body').innerHTML = contractHtml + entryHtml + exitHtml + reasonHtml;
  document.getElementById('histModal').style.display = 'flex';
}
if (document.getElementById('histModal')) {
  document.getElementById('histModal').addEventListener('click', function(e){ if (e.target === this) this.style.display = 'none'; });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') { var m = document.getElementById('histModal'); if (m) m.style.display = 'none'; } });
}`;
}

/**
 * Shared helpers (fmt + copy) + Day View + full Analytics runtime.
 * @param {Object} opts { routePrefix, startCap }
 */
function dayViewAnalyticsJS(opts) {
  const routePrefix = opts.routePrefix;
  const startCap = opts.startCap;
  const filter = opts.filter || null; // { field, label } — enables applyHistoryFilter
  return `
async function confirmReset() {
  var ok = await showDoubleConfirm({
    icon: '🗑️',
    title: 'Reset All Paper History?',
    message: 'This will permanently delete all sessions, trades, and reset capital to ₹${Number(startCap).toLocaleString("en-IN")}. This cannot be undone.',
    confirmText: 'Yes, Reset Everything',
    confirmClass: 'modal-btn-danger',
    subject: 'ALL paper sessions, trades & capital',
    secondConfirmText: 'Yes, reset everything'
  });
  if (!ok) return;
  try {
    var r = await secretFetch('${routePrefix}/reset');
    if (!r) return;
    var d;
    try { d = await r.json(); } catch(_) { d = { success: false, error: 'Server error' }; }
    if (d.success) { window.location.reload(); }
    else { showAlert({icon:'⚠️',title:'Error',message:d.error||'Reset failed',btnClass:'modal-btn-primary'}); }
  } catch(e) { showAlert({icon:'⚠️',title:'Error',message:'Network error: ' + e.message,btnClass:'modal-btn-primary'}); }
}
async function deleteSession(idx, label) {
  var ok = await showDoubleConfirm({
    icon: '🗑️',
    title: 'Delete ' + label + '?',
    message: 'This will permanently delete this session and all its trades. Capital and P&L will be recalculated. This cannot be undone.',
    confirmText: 'Yes, Delete',
    confirmClass: 'modal-btn-danger',
    subject: label,
    secondConfirmText: 'Yes, delete session'
  });
  if (!ok) return;
  try {
    var r = await secretFetch('${routePrefix}/session/' + idx, { method: 'DELETE' });
    if (!r) return;
    var d;
    try { d = await r.json(); } catch(_) { d = { success: false, error: 'Server error' }; }
    if (d.success) { window.location.reload(); }
    else { showAlert({icon:'⚠️',title:'Error',message:d.error||'Delete failed',btnClass:'modal-btn-primary'}); }
  } catch(e) { showAlert({icon:'⚠️',title:'Error',message:'Network error: ' + e.message,btnClass:'modal-btn-primary'}); }
}
function copySessionLog(btn, idx) {
  var session = ALL_SESSIONS_JSON[idx];
  if (!session || !session.trades || !session.trades.length) {
    showAlert({icon:'⚠️',title:'No Data',message:'No trades in this session to copy',btnClass:'modal-btn-primary'});
    return;
  }
  var lines = ['Side\\tDate\\tEntry\\tEntry Time\\tExit\\tExit Time\\tSL\\tPnL\\tEntry Reason\\tExit Reason'];
  session.trades.forEach(function(t) {
    var eDate = t.entryTime ? t.entryTime.split(', ')[0] : '';
    var eTime = t.entryTime ? (t.entryTime.split(', ')[1]||'') : '';
    var xTime = t.exitTime ? (t.exitTime.split(', ')[1]||'') : '';
    lines.push((t.side||'')+'\\t'+eDate+'\\t'+(t.spotAtEntry||t.entryPrice||'')+'\\t'+eTime+'\\t'+(t.spotAtExit||t.exitPrice||'')+'\\t'+xTime+'\\t'+(t.stopLoss||'')+'\\t'+(t.pnl!=null?t.pnl.toFixed(2):'')+'\\t'+(t.entryReason||'')+'\\t'+(t.exitReason||''));
  });
  doCopy(lines.join('\\n'), btn, 'Trade Log');
}
function doCopy(text,btn,label){
  var orig='\\ud83d\\udccb Copy '+label;
  function onOk(){ btn.classList.add('copied');btn.textContent='\\u2705 Copied!'; setTimeout(function(){ btn.classList.remove('copied');btn.textContent=orig; },2000); }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(onOk).catch(function(){
      var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);onOk();
    });
  } else {
    var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);onOk();
  }
}
function fmtAna(v){ return '\\u20b9'+Math.round(Math.abs(v)).toLocaleString('en-IN'); }
function fmtAnaSigned(v){ var n=v||0; var s=n>=0?'+':'-'; return s+'\\u20b9'+Math.round(Math.abs(n)).toLocaleString('en-IN'); }
function fmtAnaShort(v){ return Math.abs(v)>=1000 ? '\\u20b9'+Math.round(v/1000)+'k' : '\\u20b9'+Math.round(v); }
function copyAllJsonl(btn) {
  var orig = btn.innerHTML;
  btn.innerHTML = '\\u23f3 Fetching\\u2026';
  btn.disabled = true;
  fetch('${routePrefix}/download/trades.jsonl', { cache: 'no-store' }).then(function(res){
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }).then(function(text){
    btn.innerHTML = orig; btn.disabled = false;
    if (!text || !text.trim()) { showAlert({icon:'\\u26a0\\ufe0f',title:'No Data',message:'No trade logs to copy yet',btnClass:'modal-btn-primary'}); return; }
    doCopy(text, btn, 'JSONL');
  }).catch(function(e){
    btn.innerHTML = orig; btn.disabled = false;
    showAlert({icon:'\\u274c',title:'Copy Failed',message:(e && e.message) || String(e),btnClass:'modal-btn-danger'});
  });
}
function copyDayView(btn){
  var days=window._dayData||[];
  var lines=['Date\\tTrades\\tWins\\tLosses\\tPnL\\tCumulative PnL'];
  var cumPnl=0;
  days.forEach(function(dy){
    cumPnl+=dy.pnl;
    lines.push(dy.date+'\\t'+dy.trades+'\\t'+dy.wins+'\\t'+dy.losses+'\\t'+(dy.pnl!=null?dy.pnl.toFixed(2):'\\u2014')+'\\t'+cumPnl.toFixed(2));
  });
  doCopy(lines.join('\\n'),btn,'Day View');
}

// Active dataset for Day View + Analytics (narrowed by the optional filter).
var ACTIVE_TRADES = ALL_TRADES_JSON;

// ── Day View ──────────────────────────────────────────────────────────────
var dwVisible = false;
function toggleDayWise(){
  dwVisible = !dwVisible;
  document.getElementById('dayWiseWrap').style.display = dwVisible ? 'block' : 'none';
  document.getElementById('dwToggle').classList.toggle('active', dwVisible);
  if(dwVisible) buildDayView();
}
var dwPage = 1, dwPageSize = 10;
function buildDayView(){
  var dayMap={};
  ACTIVE_TRADES.forEach(function(t){
    var d = t.date || 'Unknown';
    if(!dayMap[d]) dayMap[d]={date:d,trades:0,wins:0,losses:0,pnl:0};
    dayMap[d].trades++;
    dayMap[d].pnl += (t.pnl||0);
    if(t.pnl > 0) dayMap[d].wins++; else if(t.pnl < 0) dayMap[d].losses++;
  });
  var days = Object.values(dayMap).sort(function(a,b){ return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  var cumAll=0;
  for(var k=0;k<days.length;k++){ cumAll+=days[k].pnl; days[k]._cum=cumAll; }
  window._dayData = days;

  var totalPages = dwPageSize === 0 ? 1 : Math.max(1, Math.ceil(days.length / dwPageSize));
  if(dwPage > totalPages) dwPage = totalPages;
  if(dwPage < 1) dwPage = 1;
  var start = dwPageSize === 0 ? 0 : (dwPage - 1) * dwPageSize;
  var end = dwPageSize === 0 ? days.length : Math.min(start + dwPageSize, days.length);
  var slice = days.slice(start, end);

  var rows='';
  for(var i=0;i<slice.length;i++){
    var dy=slice[i];
    var pc=dy.pnl>=0?'#10b981':'#ef4444';
    var cc=dy._cum>=0?'#10b981':'#ef4444';
    var pbg=dy.pnl>=0?'rgba(16,185,129,0.12)':'rgba(239,68,68,0.12)';
    var cbg=dy._cum>=0?'rgba(16,185,129,0.12)':'rgba(239,68,68,0.12)';
    rows+='<tr><td style="color:#c8d8f0;">'+dy.date+'</td><td>'+dy.trades+'</td>'
      +'<td style="color:#10b981;">'+dy.wins+'</td><td style="color:#ef4444;">'+dy.losses+'</td>'
      +'<td style="color:'+pc+';font-weight:700;background:'+pbg+';">'+fmtAnaSigned(dy.pnl)+'</td>'
      +'<td style="color:'+cc+';font-weight:700;background:'+cbg+';">'+fmtAnaSigned(dy._cum)+'</td></tr>';
  }
  document.getElementById('dayBody').innerHTML = rows || '<tr><td colspan="6" style="text-align:center;padding:20px;color:#4a6080;">No data.</td></tr>';
  document.getElementById('dayCntLabel').textContent = days.length+' days';

  var info=document.getElementById('dwPagerInfo');
  if(info){
    if(!days.length) info.textContent='0 of 0';
    else if(dwPageSize===0) info.textContent='All '+days.length;
    else info.textContent=(start+1)+'–'+end+' of '+days.length+' · pg '+dwPage+'/'+totalPages;
  }
  var fb=document.getElementById('dwFirst'), pb=document.getElementById('dwPrev'), nb=document.getElementById('dwNext'), lb=document.getElementById('dwLast');
  if(fb) fb.disabled=dwPage<=1;
  if(pb) pb.disabled=dwPage<=1;
  if(nb) nb.disabled=dwPage>=totalPages;
  if(lb) lb.disabled=dwPage>=totalPages;
}
(function wireDwPager(){
  var ps=document.getElementById('dwPageSize');
  if(ps) ps.addEventListener('change', function(e){ dwPageSize = parseInt(e.target.value,10)||0; dwPage = 1; buildDayView(); });
  var b;
  b=document.getElementById('dwFirst'); if(b) b.addEventListener('click', function(){ if(dwPage>1){ dwPage=1; buildDayView(); } });
  b=document.getElementById('dwPrev');  if(b) b.addEventListener('click', function(){ if(dwPage>1){ dwPage--; buildDayView(); } });
  b=document.getElementById('dwNext');  if(b) b.addEventListener('click', function(){ var d=window._dayData||[]; var tp=dwPageSize===0?1:Math.max(1,Math.ceil(d.length/dwPageSize)); if(dwPage<tp){ dwPage++; buildDayView(); } });
  b=document.getElementById('dwLast');  if(b) b.addEventListener('click', function(){ var d=window._dayData||[]; var tp=dwPageSize===0?1:Math.max(1,Math.ceil(d.length/dwPageSize)); if(dwPage<tp){ dwPage=tp; buildDayView(); } });
})();

// ── Analytics Panel ───────────────────────────────────────────────────────
var anaVisible = false;
var anaCharts = {};
function spGetHour(t){ var ts = t.entryTime || ''; var m = ts.match(/(\\d{1,2}):(\\d{2})/); return m ? parseInt(m[1]) : 9; }
function spGetDow(t){ var d = t.date ? new Date(t.date) : new Date(); return isNaN(d) ? 1 : d.getDay(); }
function spGetMonth(t){ var d = t.date ? new Date(t.date) : null; if(!d || isNaN(d)) return '2025-01'; return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
function spGetDateStr(t){ return t.date || 'Unknown'; }
function toggleAnalytics(){
  anaVisible = !anaVisible;
  document.getElementById('anaWrap').style.display = anaVisible ? 'block' : 'none';
  document.getElementById('anaToggle').classList.toggle('active', anaVisible);
  if(anaVisible) renderAnalytics();
}
function renderAnalytics(){
  if (typeof renderExtraAnalytics === 'function') renderExtraAnalytics();
  var trades = ACTIVE_TRADES.slice();
  if(!trades.length){
    Object.keys(anaCharts).forEach(function(k){ if(anaCharts[k] && anaCharts[k].destroy){ anaCharts[k].destroy(); delete anaCharts[k]; } });
    ['anaEntryBody','anaExitBody','anaDowBody','anaWorstBody','anaLossStreakBody','anaWorstDayBody','anaLossReasonBody','anaLossHourBody','anaDayLossBody','anaLossCandleBody'].forEach(function(id){ var el=document.getElementById(id); if(el) el.innerHTML=''; });
    var _st=document.getElementById('anaStreaks'); if(_st) _st.innerHTML='';
    var _rm=document.getElementById('anaRiskMetrics'); if(_rm) _rm.innerHTML='';
    return;
  }
  var _gc = '#0e1428';
  var _tc = '#3a5070';

  var cumPnl=[], labels=[], equity=0;
  trades.forEach(function(t,i){ equity+=(t.pnl||0); cumPnl.push(equity); labels.push(i+1); });
  if(anaCharts.equity) anaCharts.equity.destroy();
  anaCharts.equity = new Chart(document.getElementById('anaEquity'),{
    type:'line',data:{labels:labels,datasets:[{label:'Cumulative P&L',data:cumPnl,borderColor:'#3b82f6',borderWidth:1.5,backgroundColor:'rgba(59,130,246,0.08)',fill:true,pointRadius:0,tension:0.3}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return 'P&L: '+fmtAna(ctx.raw);}}}},scales:{x:{display:false},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}}}
  });

  var monthMap={};
  trades.forEach(function(t){ var key=spGetMonth(t); if(!monthMap[key])monthMap[key]=0; monthMap[key]+=(t.pnl||0); });
  var monthKeys=Object.keys(monthMap).sort();
  var monthLabels=monthKeys.map(function(k){ var p=k.split('-'); var mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return mn[parseInt(p[1])]+" '"+p[0].slice(2); });
  var monthVals=monthKeys.map(function(k){return Math.round(monthMap[k]);});
  var monthColors=monthVals.map(function(v){return v>=0?'#10b981':'#ef4444';});
  if(anaCharts.monthly) anaCharts.monthly.destroy();
  anaCharts.monthly = new Chart(document.getElementById('anaMonthly'),{
    type:'bar',data:{labels:monthLabels,datasets:[{data:monthVals,backgroundColor:monthColors,borderRadius:4,barPercentage:0.7}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return fmtAna(ctx.raw);}}}},scales:{x:{grid:{display:false},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'}}},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}}}
  });

  var eq2=0,peak=0,ddArr=[];
  trades.forEach(function(t){ eq2+=(t.pnl||0); if(eq2>peak)peak=eq2; ddArr.push(eq2-peak); });
  if(anaCharts.dd) anaCharts.dd.destroy();
  anaCharts.dd = new Chart(document.getElementById('anaDrawdown'),{
    type:'line',data:{labels:labels,datasets:[{label:'Drawdown',data:ddArr,borderColor:'#ef4444',borderWidth:1.5,backgroundColor:'rgba(239,68,68,0.12)',fill:true,pointRadius:0,tension:0.3}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return 'DD: '+fmtAna(ctx.raw);}}}},scales:{x:{display:false},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}}}
  });

  var hourMap={};
  trades.forEach(function(t){ var h=spGetHour(t); if(!hourMap[h])hourMap[h]={pnl:0,cnt:0,wins:0}; hourMap[h].pnl+=(t.pnl||0); hourMap[h].cnt++; if(t.pnl>0)hourMap[h].wins++; });
  var hours=Object.keys(hourMap).map(Number).sort(function(a,b){return a-b;});
  var hourLabels=hours.map(function(h){return h+':00';});
  var hourPnl=hours.map(function(h){return Math.round(hourMap[h].pnl);});
  var hourBarColors=hourPnl.map(function(v){return v>=0?'rgba(16,185,129,0.7)':'rgba(239,68,68,0.7)';});
  if(anaCharts.hourly) anaCharts.hourly.destroy();
  anaCharts.hourly = new Chart(document.getElementById('anaHourly'),{
    type:'bar',data:{labels:hourLabels,datasets:[{data:hourPnl,backgroundColor:hourBarColors,borderRadius:4,barPercentage:0.7}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:function(ctx){var h=hours[ctx[0].dataIndex];return h+':00 - '+(h+1)+':00 ('+hourMap[h].cnt+' trades, '+((hourMap[h].wins/hourMap[h].cnt)*100).toFixed(0)+'% WR)';},label:function(ctx){return fmtAna(ctx.raw);}}}},scales:{x:{grid:{display:false},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'}}},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}}}
  });

  var maxWS=0,maxLS=0,curWS=0,curLS=0,avgWS=[],avgLS=[];
  trades.forEach(function(t){
    if(t.pnl>0){ curWS++; if(curLS>0)avgLS.push(curLS); curLS=0; if(curWS>maxWS)maxWS=curWS; }
    else if(t.pnl<0){ curLS++; if(curWS>0)avgWS.push(curWS); curWS=0; if(curLS>maxLS)maxLS=curLS; }
  });
  if(curWS>0)avgWS.push(curWS); if(curLS>0)avgLS.push(curLS);
  var avgW=avgWS.length>0?(avgWS.reduce(function(a,b){return a+b;},0)/avgWS.length).toFixed(1):'0';
  var avgL=avgLS.length>0?(avgLS.reduce(function(a,b){return a+b;},0)/avgLS.length).toFixed(1):'0';
  var dayPnlMap={};
  trades.forEach(function(t){ var d=spGetDateStr(t); if(!dayPnlMap[d])dayPnlMap[d]=0; dayPnlMap[d]+=(t.pnl||0); });
  var profDays=0,lossDays=0;
  Object.values(dayPnlMap).forEach(function(v){if(v>=0)profDays++;else lossDays++;});
  var totalDays=profDays+lossDays;
  document.getElementById('anaStreaks').innerHTML=
    '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+maxWS+'</span><span class="ana-stat-label">Best win streak</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+maxLS+'</span><span class="ana-stat-label">Worst loss streak</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#60a5fa;">'+avgW+'</span><span class="ana-stat-label">Avg win streak</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#f59e0b;">'+avgL+'</span><span class="ana-stat-label">Avg loss streak</span></div>'
    +'<div style="border-top:0.5px solid #0e1428;margin:8px 0;padding-top:8px;">'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+profDays+'</span><span class="ana-stat-label">Profitable days ('+(totalDays>0?((profDays/totalDays)*100).toFixed(0):'0')+'%)</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+lossDays+'</span><span class="ana-stat-label">Losing days ('+(totalDays>0?((lossDays/totalDays)*100).toFixed(0):'0')+'%)</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#c8d8f0;">'+fmtAna(totalDays>0?Object.values(dayPnlMap).reduce(function(a,b){return a+b;},0)/totalDays:0)+'</span><span class="ana-stat-label">Avg daily P&L</span></div>'
    +'</div>';

  var entryReasonMap={};
  trades.forEach(function(t){
    var r = t.entryReason || 'Unknown';
    if(r.length>50) r=r.substring(0,50)+'…';
    if(!entryReasonMap[r]) entryReasonMap[r]={cnt:0,wins:0,losses:0,pnl:0};
    entryReasonMap[r].cnt++;
    if(t.pnl>0) entryReasonMap[r].wins++;
    else if(t.pnl<0) entryReasonMap[r].losses++;
    entryReasonMap[r].pnl+=(t.pnl||0);
  });
  var entryReasons=Object.keys(entryReasonMap).sort(function(a,b){return entryReasonMap[b].cnt-entryReasonMap[a].cnt;});
  var entryHtml='';
  entryReasons.forEach(function(r){
    var d=entryReasonMap[r];
    var pc=d.pnl>=0?'#10b981':'#ef4444';
    var wr=d.cnt>0?((d.wins/d.cnt)*100).toFixed(0):'0';
    var avgPnl=d.cnt>0?Math.round(d.pnl/d.cnt):0;
    entryHtml+='<tr><td style="color:#c8d8f0;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+r+'">'+r+'</td><td>'+d.cnt+'</td>'
      +'<td style="color:#10b981;">'+d.wins+'</td><td style="color:#ef4444;">'+d.losses+'</td>'
      +'<td>'+wr+'%</td>'
      +'<td style="color:'+pc+';font-weight:700;">'+fmtAna(d.pnl)+'</td>'
      +'<td style="color:'+pc+';">'+fmtAna(avgPnl)+'</td></tr>';
  });
  document.getElementById('anaEntryBody').innerHTML=entryHtml;

  var reasonMap={};
  trades.forEach(function(t){ var r=t.exitReason||'Unknown'; if(!reasonMap[r])reasonMap[r]={cnt:0,pnl:0}; reasonMap[r].cnt++; reasonMap[r].pnl+=(t.pnl||0); });
  var reasons=Object.keys(reasonMap).sort(function(a,b){return reasonMap[b].pnl-reasonMap[a].pnl;});
  var exitHtml='';
  reasons.forEach(function(r){ var d=reasonMap[r]; var pc=d.pnl>=0?'#10b981':'#ef4444'; exitHtml+='<tr><td style="color:#c8d8f0;">'+r+'</td><td>'+d.cnt+'</td><td style="color:'+pc+';font-weight:700;">'+fmtAna(d.pnl)+'</td><td style="color:'+pc+';">'+fmtAna(Math.round(d.pnl/d.cnt))+'</td></tr>'; });
  document.getElementById('anaExitBody').innerHTML=exitHtml;

  var dowMap={0:{n:'Sun',t:0,w:0,p:0},1:{n:'Mon',t:0,w:0,p:0},2:{n:'Tue',t:0,w:0,p:0},3:{n:'Wed',t:0,w:0,p:0},4:{n:'Thu',t:0,w:0,p:0},5:{n:'Fri',t:0,w:0,p:0},6:{n:'Sat',t:0,w:0,p:0}};
  trades.forEach(function(t){ var dow=spGetDow(t); dowMap[dow].t++; if(t.pnl>0)dowMap[dow].w++; dowMap[dow].p+=(t.pnl||0); });
  var dowHtml='';
  [1,2,3,4,5].forEach(function(d){ var dd=dowMap[d]; if(dd.t===0)return; var wr=((dd.w/dd.t)*100).toFixed(0); var pc=dd.p>=0?'#10b981':'#ef4444'; dowHtml+='<tr><td style="color:#c8d8f0;font-weight:600;">'+dd.n+'</td><td>'+dd.t+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAna(dd.p)+'</td><td style="color:'+pc+';">'+fmtAna(Math.round(dd.p/dd.t))+'</td></tr>'; });
  document.getElementById('anaDowBody').innerHTML=dowHtml;

  var lossTrades=trades.filter(function(t){return t.pnl<0;});
  var winTrades=trades.filter(function(t){return t.pnl>0;});

  (function(){
    if(!lossTrades.length) return;
    var lossVals=lossTrades.map(function(t){return Math.abs(t.pnl);}).sort(function(a,b){return a-b;});
    var maxVal=lossVals[lossVals.length-1];
    var bucketCount=Math.min(12,Math.max(5,Math.ceil(Math.sqrt(lossVals.length))));
    var step=Math.ceil(maxVal/bucketCount/100)*100; if(step<1)step=1;
    var buckets=[],bucketLabels=[];
    for(var i=0;i<bucketCount;i++){buckets.push(0);bucketLabels.push(fmtAnaShort(i*step)+'-'+fmtAnaShort((i+1)*step));}
    lossVals.forEach(function(v){var idx=Math.min(Math.floor(v/step),bucketCount-1);buckets[idx]++;});
    if(anaCharts.lossDist) anaCharts.lossDist.destroy();
    anaCharts.lossDist = new Chart(document.getElementById('anaLossDist'),{
      type:'bar',data:{labels:bucketLabels,datasets:[{data:buckets,backgroundColor:'rgba(239,68,68,0.6)',borderRadius:4,barPercentage:0.85}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return ctx.raw+' trades ('+((ctx.raw/lossTrades.length)*100).toFixed(0)+'%)';}}}},scales:{x:{grid:{display:false},ticks:{color:_tc,font:{size:9,family:'IBM Plex Mono'},maxRotation:45}},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},stepSize:1}}}}
    });
  })();

  (function(){
    if(!trades.length) return;
    var sides={CE:{wins:0,losses:0,winPnl:0,lossPnl:0,total:0},PE:{wins:0,losses:0,winPnl:0,lossPnl:0,total:0}};
    trades.forEach(function(t){ var s=t.side||'CE'; if(!sides[s])return; sides[s].total++; if(t.pnl>0){sides[s].wins++;sides[s].winPnl+=t.pnl;} else if(t.pnl<0){sides[s].losses++;sides[s].lossPnl+=t.pnl;} });
    var sLabels=['CE','PE'];
    var sWinPnl=sLabels.map(function(s){return Math.round(sides[s].winPnl);});
    var sLossPnl=sLabels.map(function(s){return Math.round(sides[s].lossPnl);});
    var sNet=sLabels.map(function(s){return Math.round(sides[s].winPnl+sides[s].lossPnl);});
    if(anaCharts.sidePerf) anaCharts.sidePerf.destroy();
    anaCharts.sidePerf = new Chart(document.getElementById('anaSidePerf'),{
      type:'bar',data:{labels:sLabels.map(function(s){return s+' ('+sides[s].total+' trades, '+((sides[s].wins/Math.max(sides[s].total,1))*100).toFixed(0)+'% WR)';}),datasets:[
        {label:'Win P&L',data:sWinPnl,backgroundColor:'rgba(16,185,129,0.65)',borderRadius:4,barPercentage:0.6},
        {label:'Loss P&L',data:sLossPnl,backgroundColor:'rgba(239,68,68,0.65)',borderRadius:4,barPercentage:0.6},
        {label:'Net P&L',data:sNet,backgroundColor:sNet.map(function(v){return v>=0?'rgba(59,130,246,0.65)':'rgba(245,158,11,0.65)';}),borderRadius:4,barPercentage:0.6}
      ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:_tc,font:{size:9,family:'IBM Plex Mono'}}}},scales:{x:{grid:{display:false},ticks:{color:_tc,font:{size:9,family:'IBM Plex Mono'}}},y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}}}
    });
  })();

  (function(){
    var worst=lossTrades.slice().sort(function(a,b){return a.pnl-b.pnl;}).slice(0,10);
    var html='';
    worst.forEach(function(t){ html+='<tr><td style="color:#c8d8f0;">'+spGetDateStr(t)+'</td><td style="color:'+(t.side==='CE'?'#10b981':'#ef4444')+';font-weight:700;">'+(t.side||'\\u2014')+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAna(t.pnl)+'</td><td style="font-size:0.65rem;">'+(t.exitReason||'\\u2014')+'</td></tr>'; });
    document.getElementById('anaWorstBody').innerHTML=html||'<tr><td colspan="4" style="text-align:center;color:#3a5070;">No losses</td></tr>';
  })();

  (function(){
    var streaks=[],cur=[];
    trades.forEach(function(t,i){ if(t.pnl<0){cur.push({trade:t,idx:i});} else {if(cur.length>=2)streaks.push({items:cur.slice(),startIdx:cur[0].idx});cur=[];} });
    if(cur.length>=2)streaks.push({items:cur.slice(),startIdx:cur[0].idx});
    streaks.sort(function(a,b){ return a.items.reduce(function(s,c){return s+c.trade.pnl;},0)-b.items.reduce(function(s,c){return s+c.trade.pnl;},0); });
    var html='';
    streaks.slice(0,10).forEach(function(streak){
      var totalLoss=streak.items.reduce(function(s,c){return s+c.trade.pnl;},0);
      var avgLoss=totalLoss/streak.items.length;
      html+='<tr><td style="color:#c8d8f0;">'+spGetDateStr(streak.items[0].trade)+'</td><td>'+streak.items.length+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAna(totalLoss)+'</td><td style="color:#ef4444;">'+fmtAna(avgLoss)+'</td></tr>';
    });
    document.getElementById('anaLossStreakBody').innerHTML=html||'<tr><td colspan="4" style="text-align:center;color:#3a5070;">No consecutive loss streaks (2+)</td></tr>';
  })();

  (function(){
    var maxConsLoss=0,curCons=0;
    trades.forEach(function(t){if(t.pnl<0){curCons++;if(curCons>maxConsLoss)maxConsLoss=curCons;}else{curCons=0;}});
    var sortedPnl=trades.map(function(t){return t.pnl||0;}).sort(function(a,b){return a-b;});
    var p5Idx=Math.floor(sortedPnl.length*0.05);
    var p95Idx=Math.floor(sortedPnl.length*0.95);
    var p5=sortedPnl[p5Idx]||0;
    var p95=sortedPnl[p95Idx]||0;
    var grossProfit=winTrades.reduce(function(s,t){return s+t.pnl;},0);
    var grossLoss=lossTrades.reduce(function(s,t){return s+t.pnl;},0);
    var profitFactor=grossLoss!==0?(grossProfit/Math.abs(grossLoss)).toFixed(2):'\\u221e';
    var avgWinVal=winTrades.length>0?Math.round(grossProfit/winTrades.length):0;
    var avgLossVal=lossTrades.length>0?Math.round(grossLoss/lossTrades.length):0;
    var lossAfterLoss=0,totalAfterLoss=0;
    for(var i=1;i<trades.length;i++){if((trades[i-1].pnl||0)<0){totalAfterLoss++;if((trades[i].pnl||0)<0)lossAfterLoss++;}}
    var lossAfterLossPct=totalAfterLoss>0?((lossAfterLoss/totalAfterLoss)*100).toFixed(0):'\\u2014';
    document.getElementById('anaRiskMetrics').innerHTML=
      '<div class="ana-stat"><span class="ana-stat-val" style="color:'+(parseFloat(profitFactor)>=1.5?'#10b981':parseFloat(profitFactor)>=1?'#f59e0b':'#ef4444')+';">'+profitFactor+'</span><span class="ana-stat-label">Profit Factor</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+fmtAna(avgWinVal)+'</span><span class="ana-stat-label">Avg Win</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+fmtAna(avgLossVal)+'</span><span class="ana-stat-label">Avg Loss</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+maxConsLoss+'</span><span class="ana-stat-label">Max consecutive losses</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:'+(parseFloat(lossAfterLossPct)>=50?'#ef4444':'#10b981')+';">'+lossAfterLossPct+'%</span><span class="ana-stat-label">Loss after loss probability</span></div>'
      +'<div style="border-top:0.5px solid #0e1428;margin:8px 0;padding-top:8px;">'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+fmtAna(Math.abs(p5))+'</span><span class="ana-stat-label">5th percentile (worst case)</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+fmtAna(p95)+'</span><span class="ana-stat-label">95th percentile (best case)</span></div>'
      +'</div>';
  })();

  (function(){
    var dayTrades={};
    trades.forEach(function(t){ var d=spGetDateStr(t); if(!dayTrades[d])dayTrades[d]={trades:[],pnl:0,losses:0,worstTrade:0}; dayTrades[d].trades.push(t); dayTrades[d].pnl+=(t.pnl||0); if(t.pnl<0)dayTrades[d].losses++; if(t.pnl<dayTrades[d].worstTrade)dayTrades[d].worstTrade=t.pnl; });
    var days=Object.keys(dayTrades).filter(function(d){return dayTrades[d].pnl<0;});
    days.sort(function(a,b){return dayTrades[a].pnl-dayTrades[b].pnl;});
    var html='';
    days.slice(0,10).forEach(function(d){ var dd=dayTrades[d]; html+='<tr><td style="color:#c8d8f0;">'+d+'</td><td>'+dd.trades.length+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAna(dd.pnl)+'</td><td>'+dd.losses+'</td><td style="color:#ef4444;">'+fmtAna(dd.worstTrade)+'</td></tr>'; });
    document.getElementById('anaWorstDayBody').innerHTML=html||'<tr><td colspan="5" style="text-align:center;color:#3a5070;">No losing days</td></tr>';
  })();

  (function(){
    var lrMap={};
    lossTrades.forEach(function(t){ var r=t.exitReason||'Unknown'; if(!lrMap[r])lrMap[r]={cnt:0,pnl:0}; lrMap[r].cnt++; lrMap[r].pnl+=t.pnl; });
    var reasons2=Object.keys(lrMap).sort(function(a,b){return lrMap[a].pnl-lrMap[b].pnl;});
    var totalLossCnt=lossTrades.length;
    var html='';
    reasons2.forEach(function(r){ var d=lrMap[r]; var pct=((d.cnt/totalLossCnt)*100).toFixed(0); html+='<tr><td style="color:#c8d8f0;">'+r+'</td><td>'+d.cnt+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAna(d.pnl)+'</td><td style="color:#ef4444;">'+fmtAna(Math.round(d.pnl/d.cnt))+'</td><td style="font-weight:600;">'+pct+'%</td></tr>'; });
    document.getElementById('anaLossReasonBody').innerHTML=html;
  })();

  (function(){
    var lhMap={};
    trades.forEach(function(t){ var h=spGetHour(t); if(!lhMap[h])lhMap[h]={total:0,losses:0,lossPnl:0}; lhMap[h].total++; if(t.pnl<0){lhMap[h].losses++;lhMap[h].lossPnl+=t.pnl;} });
    var hrs=Object.keys(lhMap).map(Number).sort(function(a,b){return a-b;});
    var html='';
    hrs.forEach(function(h){ var d=lhMap[h]; if(d.losses===0)return; var lossPct=((d.losses/d.total)*100).toFixed(0); var dangerColor=parseFloat(lossPct)>=60?'#ef4444':parseFloat(lossPct)>=45?'#f59e0b':'#10b981'; html+='<tr><td style="color:#c8d8f0;font-weight:600;">'+h+':00</td><td>'+d.losses+' / '+d.total+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAna(d.lossPnl)+'</td><td style="color:#ef4444;">'+fmtAna(Math.round(d.lossPnl/d.losses))+'</td><td style="color:'+dangerColor+';font-weight:700;">'+lossPct+'%</td></tr>'; });
    document.getElementById('anaLossHourBody').innerHTML=html;
  })();

  (function(){
    var dlMap={};
    trades.forEach(function(t){ var d=spGetDateStr(t); if(!dlMap[d])dlMap[d]={trades:0,losses:0,grossLoss:0,net:0}; dlMap[d].trades++; dlMap[d].net+=(t.pnl||0); if(t.pnl<0){dlMap[d].losses++; dlMap[d].grossLoss+=t.pnl;} });
    var days=Object.keys(dlMap).sort();
    var html='';
    days.forEach(function(d){ var dd=dlMap[d]; var nc=dd.net>=0?'#10b981':'#ef4444'; html+='<tr><td style="color:#c8d8f0;">'+d+'</td><td>'+dd.trades+'</td><td style="color:#ef4444;">'+dd.losses+'</td><td style="color:#ef4444;font-weight:700;">'+(dd.grossLoss<0?'-'+fmtAna(dd.grossLoss):'—')+'</td><td style="color:'+nc+';font-weight:700;">'+fmtAnaSigned(dd.net)+'</td></tr>'; });
    document.getElementById('anaDayLossBody').innerHTML=html||'<tr><td colspan="5" style="text-align:center;color:#3a5070;">No data</td></tr>';
  })();

  (function(){
    var rows=lossTrades.map(function(t){ var ch=(typeof t.candlesHeld==='number')?t.candlesHeld:null; return {t:t,ch:ch}; });
    rows.sort(function(a,b){ return (b.ch==null?-1:b.ch)-(a.ch==null?-1:a.ch); });
    var html='';
    rows.forEach(function(r){ var t=r.t; var sc=t.side==='CE'?'#10b981':'#ef4444'; var chTxt=r.ch==null?'—':r.ch; html+='<tr><td style="color:#c8d8f0;">'+spGetDateStr(t)+'</td><td style="color:'+sc+';font-weight:600;">'+(t.side||'—')+'</td><td style="color:#c8d8f0;font-weight:700;">'+chTxt+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(t.pnl)+'</td><td style="color:#7a90b0;font-size:0.65rem;">'+(t.exitReason||'—')+'</td></tr>'; });
    document.getElementById('anaLossCandleBody').innerHTML=html||'<tr><td colspan="5" style="text-align:center;color:#3a5070;">No losing trades</td></tr>';
  })();
}
${filter ? `
// ── History filter (narrows Day View + Analytics + session cards) ───────────
var FILTER_FIELD = ${JSON.stringify(filter.field)};
var FILTER_LABEL = ${JSON.stringify(filter.label || "filter")};
var ACTIVE_FILTER = 'ALL';
function applyHistoryFilter(g){
  ACTIVE_FILTER = g || 'ALL';
  ACTIVE_TRADES = (ACTIVE_FILTER === 'ALL')
    ? ALL_TRADES_JSON.slice()
    : ALL_TRADES_JSON.filter(function(t){ return String(t[FILTER_FIELD]==null?'Unknown':t[FILTER_FIELD]) === ACTIVE_FILTER; });

  document.querySelectorAll('.session-card tbody tr').forEach(function(tr){
    var pg = tr.getAttribute('data-filter-group');
    tr.style.display = (ACTIVE_FILTER === 'ALL' || pg === ACTIVE_FILTER) ? '' : 'none';
  });
  document.querySelectorAll('.session-card').forEach(function(card){
    var vis = Array.prototype.filter.call(card.querySelectorAll('tbody tr'), function(tr){ return tr.style.display !== 'none'; });
    var n = vis.length, w = 0, l = 0, pnl = 0;
    vis.forEach(function(tr){ var p = parseFloat(tr.getAttribute('data-pnl')) || 0; pnl += p; if (p > 0) w++; else if (p < 0) l++; });
    var wr = n > 0 ? ((w/n)*100).toFixed(1) + '%' : '—';
    var setText = function(sel, txt){ var el = card.querySelector(sel); if (el) el.textContent = txt; };
    setText('.sc-trade-count', n + ' trade' + (n!==1 ? 's' : ''));
    setText('.sc-wins', w + 'W'); setText('.sc-losses', l + 'L'); setText('.sc-wr', 'WR ' + wr);
    var pe = card.querySelector('.session-pnl-val'); if (pe){ pe.style.color = pnl >= 0 ? '#10b981' : '#ef4444'; pe.textContent = fmtAnaSigned(pnl); }
    var we = card.querySelector('.session-wl-val'); if (we) we.textContent = w + 'W / ' + l + 'L';
    card.style.display = (n === 0 && ACTIVE_FILTER !== 'ALL') ? 'none' : '';
  });

  var tn = ACTIVE_TRADES.length;
  var tw = ACTIVE_TRADES.filter(function(t){ return (t.pnl||0) > 0; }).length;
  var tl = ACTIVE_TRADES.filter(function(t){ return (t.pnl||0) < 0; }).length;
  var tp = ACTIVE_TRADES.reduce(function(s,t){ return s + (t.pnl||0); }, 0);
  var sumPnl = document.getElementById('sumPnl');
  if (sumPnl){ sumPnl.style.color = tp >= 0 ? '#10b981' : '#ef4444'; sumPnl.textContent = fmtAnaSigned(tp); }
  var sumWr = document.getElementById('sumWr'); if (sumWr) sumWr.textContent = tn ? ((tw/tn)*100).toFixed(1) + '%' : '—';
  var sumWrSub = document.getElementById('sumWrSub'); if (sumWrSub) sumWrSub.textContent = tw + 'W · ' + tl + 'L · ' + tn + ' trades';
  var suffix = ACTIVE_FILTER === 'ALL' ? '' : ' (' + ACTIVE_FILTER + ')';
  var sumPnlLabel = document.getElementById('sumPnlLabel'); if (sumPnlLabel) sumPnlLabel.textContent = 'All-Time PnL' + suffix;
  var sumWrLabel = document.getElementById('sumWrLabel'); if (sumWrLabel) sumWrLabel.textContent = 'Win Rate' + suffix;
  var sumSessionsSub = document.getElementById('sumSessionsSub');
  if (sumSessionsSub){
    var visS = Array.prototype.filter.call(document.querySelectorAll('.session-card'), function(c){ return c.style.display !== 'none'; }).length;
    sumSessionsSub.textContent = ACTIVE_FILTER === 'ALL' ? 'across all time' : visS + ' session(s) with this ' + FILTER_LABEL.toLowerCase();
  }

  if (typeof dwVisible !== 'undefined' && dwVisible) buildDayView();
  if (typeof anaVisible !== 'undefined' && anaVisible) renderAnalytics();
}
(function(){
  try {
    var u = new URLSearchParams(window.location.search);
    var g = u.get('filter') || u.get('pattern');
    if (g){ var sel = document.getElementById('historyFilter'); if (sel) sel.value = g; applyHistoryFilter(g); }
  } catch(_){}
})();` : ""}`;
}

// ── Session cards (canonical BB_RSI column layout) ────────────────────────────
function buildSessionCards(sessions, opts) {
  opts = opts || {};
  const emptyLabel = opts.emptyLabel || "Start paper trading to record your first session.";
  const filterField = opts.filterField || null; // when set, rows carry data-filter-group for live filtering
  const replayMode = opts.replayMode || ""; // strategy mode for the "View chart" deep-link into /replay
  if (!sessions || sessions.length === 0) {
    return `<div style="text-align:center;padding:60px 24px;background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;">
        <div style="font-size:3rem;margin-bottom:16px;">📭</div>
        <div style="font-size:1rem;font-weight:600;color:#e0eaf8;margin-bottom:8px;">No sessions yet</div>
        <div style="font-size:0.82rem;color:#4a6080;">${emptyLabel}</div>
       </div>`;
  }
  return sessions.slice().reverse().map((s, idx) => {
    const sIdx = sessions.length - idx;
    const actualIdx = sessions.length - 1 - idx;
    const trades = s.trades || [];
    const sessionWins   = trades.filter(t => t.pnl > 0).length;
    const sessionLosses = trades.filter(t => t.pnl < 0).length;
    const winRate = trades.length ? ((sessionWins / trades.length) * 100).toFixed(1) + "%" : "—";
    // Session PnL field name varies by strategy (bb_rsi/pa/orb: pnl, ema_rsi_st: sessionPnl);
    // fall back to summing trade PnL so the header always shows a number.
    const sPnl = (typeof s.pnl === "number") ? s.pnl
               : (typeof s.sessionPnl === "number") ? s.sessionPnl
               : trades.reduce((a, t) => a + (typeof t.pnl === "number" ? t.pnl : 0), 0);

    const tradeRows = trades.map((t, ti) => {
      const badgeCls = t.side === "CE" ? "badge-ce" : "badge-pe";
      const entrySpot = inr(t.spotAtEntry || t.entryPrice);
      const exitSpot = inr(t.spotAtExit || t.exitPrice);
      const pnlStr = `<span style="font-weight:800;color:${pnlColor(t.pnl)};">${t.pnl >= 0 ? "+" : ""}${inr(t.pnl)}</span>`;
      const entryDate = t.entryTime ? String(t.entryTime).split(', ')[0] : '—';
      const entryTimeOnly = t.entryTime ? (String(t.entryTime).split(', ')[1] || '—') : '—';
      const exitTimeOnly = t.exitTime ? (String(t.exitTime).split(', ')[1] || '—') : '—';
      const entryReasonShort = (t.entryReason||'—').substring(0,25) + ((t.entryReason||'').length>25?'…':'');
      const exitReasonShort = (t.exitReason||'—').substring(0,25) + ((t.exitReason||'').length>25?'…':'');
      const grp = filterField ? String(t[filterField] == null ? 'Unknown' : t[filterField]) : '';
      return `<tr data-filter-group="${grp.replace(/"/g,'&quot;')}" data-pnl="${typeof t.pnl === 'number' ? t.pnl : 0}">
        <td><span class="badge ${badgeCls}">${t.side}</span></td>
        <td style="color:#c8d8f0;font-size:0.75rem;">${entryDate}</td>
        <td style="color:#c8d8f0;">${entrySpot}</td>
        <td style="color:#c8d8f0;font-size:0.75rem;">${entryTimeOnly}</td>
        <td style="color:#c8d8f0;">${exitSpot}</td>
        <td style="color:#c8d8f0;font-size:0.75rem;">${exitTimeOnly}</td>
        <td style="color:#f59e0b;">${t.stopLoss ? inr(parseFloat(t.stopLoss)) : '—'}</td>
        <td>${pnlStr}</td>
        <td style="font-size:0.7rem;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${(t.entryReason||'').replace(/"/g,'&quot;')}">${entryReasonShort}</td>
        <td style="font-size:0.7rem;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${(t.exitReason||'').replace(/"/g,'&quot;')}">${exitReasonShort}</td>
        <td style="text-align:center;padding:4px 8px;"><button onclick="event.stopPropagation();showHistoryTradeModal(${actualIdx}, ${ti})" class="copy-btn" style="padding:3px 10px;font-size:0.75rem;" title="View full details">\u{1F441} View</button></td>
      </tr>`;
    }).join("");

    return `
    <div class="session-card">
      <div class="session-head" onclick="this.parentElement.classList.toggle('open')">
        <div>
          <div class="session-meta">Session ${sIdx} &middot; ${String(s.date || "").slice(0,10)} &middot; ${s.strategy || "—"}</div>
          <div style="margin-top:4px;display:flex;gap:10px;font-size:0.7rem;color:#4a6080;">
            <span class="sc-trade-count">${trades.length} trade${trades.length !== 1 ? "s" : ""}</span>
            <span class="sc-wins" style="color:#10b981;">${sessionWins}W</span>
            <span class="sc-losses" style="color:#ef4444;">${sessionLosses}L</span>
            <span class="sc-wr">WR ${winRate}</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${replayMode && s.date ? `<a class="copy-btn" href="/replay?from=${String(s.date).slice(0,10)}&to=${String(s.date).slice(0,10)}&mode=${replayMode}&settings=snapshot&run=1" target="_blank" rel="noopener" onclick="event.stopPropagation();" title="Open this session's candlestick chart + trade markers in Replay" style="text-decoration:none;">📈 View chart</a>` : ""}
          <button class="copy-btn" onclick="event.stopPropagation();openContractNote('session',${actualIdx})" title="Contract note (gross, charges, net P&L) for this day">📄 Report</button>
          <button class="copy-btn" onclick="event.stopPropagation();copySessionLog(this,${actualIdx})">📋 Copy Trade Log</button>
          <button class="reset-btn" onclick="event.stopPropagation();deleteSession(${actualIdx}, 'Session ${sIdx} (${String(s.date || "").slice(0,10)})')">🗑 Delete Session</button>
        </div>
        <div>
          <div class="session-pnl session-pnl-val" style="color:${pnlColor(sPnl)};">${sPnl >= 0 ? "+" : ""}${inr(sPnl)}</div>
          <div class="session-wl session-wl-val">${sessionWins}W / ${sessionLosses}L</div>
        </div>
      </div>
      <div class="session-body">
      ${trades.length > 0 ? `
      <div style="overflow-x:auto;">
        <div class="tbl-wrap"><table class="tbl enh-table-sort-filter">
          <thead><tr>
            <th>Side</th><th>Date</th><th>Entry</th><th>Entry Time</th><th>Exit</th><th>Exit Time</th><th>SL</th><th>PnL</th><th>Entry Reason</th><th>Exit Reason</th><th data-no-sort="1" style="text-align:center;">Action</th>
          </tr></thead>
          <tbody>${tradeRows}</tbody>
        </table></div>
      </div>` : `<div style="padding:14px 20px;color:#4a6080;font-size:0.82rem;">No trades in this session.</div>`}
      </div>
    </div>`;
  }).join("");
}

/**
 * Render the complete Paper Trade History page.
 * @param {Object} cfg
 *   routePrefix   e.g. '/orb-paper'
 *   sidebarKey    e.g. 'orbHistory'
 *   pageTitle     e.g. '🎯 ORB Paper Trade History'
 *   modalLabel    e.g. 'ORB Paper'
 *   pageDocTitle  e.g. 'ORB Paper — History'
 *   liveActive    boolean
 *   sessions      array of session objects
 *   capital       current capital (number)
 *   totalPnl      all-time net PnL (number)
 *   startCap      starting capital (number)
 *   emptyLabel    empty-state hint
 *   filter        OPTIONAL { field, label } — adds a top-bar dropdown that
 *                 narrows session cards + stat cards + Day View + Analytics by
 *                 a per-trade field (e.g. PA's patternGroup). Groups are
 *                 auto-derived from the data.
 *   extraAnalyticsHTML / extraAnalyticsJS  OPTIONAL — injected at the top of
 *                 the Analytics panel; the JS may define renderExtraAnalytics()
 *                 (called whenever Analytics renders, always on full data).
 */
function renderHistoryPage(cfg) {
  // Attach a contract-note row (_cn) to every trade so the Report modal can be
  // built entirely client-side from the embedded data — broker is derived from
  // the route prefix (ema_rsi_st → Zerodha rates, others → Fyers).
  const cnBroker = (cfg.broker !== undefined) ? cfg.broker : brokerForRoute(cfg.routePrefix);
  const sessions = (cfg.sessions || []).map(s => ({ ...s, trades: attachContractNotes(s.trades || [], cnBroker) }));
  const allTrades = sessions.flatMap(s => (s.trades || []).map(t => ({ ...t, date: s.date })));
  const totalWins   = allTrades.filter(t => t.pnl > 0).length;
  const totalLosses = allTrades.filter(t => t.pnl < 0).length;
  const startCap = cfg.startCap;
  const capital  = (typeof cfg.capital === "number") ? cfg.capital : (startCap + (cfg.totalPnl || 0));
  const totalPnl = (typeof cfg.totalPnl === "number") ? cfg.totalPnl : allTrades.reduce((a, t) => a + (t.pnl || 0), 0);

  const filter = cfg.filter || null;
  // Distinct filter groups, ordered by trade count (desc), for the dropdown.
  let filterSelectHTML = "";
  if (filter && filter.field) {
    const counts = new Map();
    for (const t of allTrades) {
      const g = (t[filter.field] == null) ? "Unknown" : String(t[filter.field]);
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    const groups = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    filterSelectHTML = `
      <label style="display:flex;align-items:center;gap:6px;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#3a5070;font-weight:700;font-family:'IBM Plex Mono',monospace;">
        ${esc(filter.label || "Filter")}
        <select id="historyFilter" onchange="applyHistoryFilter(this.value)" style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.7rem;font-family:'IBM Plex Mono',monospace;cursor:pointer;outline:none;">
          <option value="ALL">All (${allTrades.length})</option>
          ${groups.map(([g, n]) => `<option value="${esc(g)}">${esc(g)} (${n})</option>`).join("")}
        </select>
      </label>`;
  }

  const sessionCards = buildSessionCards(sessions, { emptyLabel: cfg.emptyLabel, filterField: filter && filter.field, replayMode: (cfg.routePrefix || "").replace(/^\//, "") });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>${cfg.pageDocTitle || cfg.modalLabel + " — History"}</title>
  ${themeInitScript()}
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>${historyCSS()}${historyLightCSS()}</style>
</head>
<body>
<div class="app-shell">
${buildSidebar(cfg.sidebarKey, cfg.liveActive)}
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">${cfg.pageTitle}</div>
      <div class="top-bar-meta">${sessions.length} sessions · ${allTrades.length} total trades</div>
    </div>
    <div class="top-bar-right">
      ${filterSelectHTML}
      <button id="dwToggle" class="dw-toggle" onclick="toggleDayWise()" title="Day-wise P&L summary">👁 Day P&L</button>
      <button id="anaToggle" class="dw-toggle" onclick="toggleAnalytics()" title="Performance Analytics">📊 Analytics</button>
      <button onclick="openContractNote('all')" class="export-btn" title="Contract note (gross, charges breakdown, net P&L) for all sessions">📄 Report</button>
      <button onclick="copyAllJsonl(this)" class="export-btn" title="Copy the full per-trade JSONL log to clipboard">📋 Copy JSONL</button>
      <a href="${cfg.routePrefix}/download/trades.jsonl" class="export-btn" style="text-decoration:none;display:inline-block;" title="Cumulative per-trade log (.txt) — full field capture for offline analysis">⬇ tradeLogs</a>
      <a href="${cfg.routePrefix}/download/skips-all" class="export-btn" style="text-decoration:none;display:inline-block;" title="Cumulative skip log (.txt) — all daily skip files concatenated">⬇ skipLogs</a>
      <button onclick="confirmReset()" class="reset-btn">🗑 Reset</button>
      <a href="${cfg.routePrefix}/status" style="background:#07111f;border:0.5px solid #0e1e36;color:#4a6080;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;text-decoration:none;cursor:pointer;">← Status</a>
    </div>
  </div>

  <div class="page">

    <div class="stat-grid" style="margin-bottom:22px;">
      <div class="sc">
        <div class="sc-label">Starting Capital</div>
        <div class="sc-val">${inr(startCap)}</div>
      </div>
      <div class="sc">
        <div class="sc-label">Current Capital</div>
        <div class="sc-val" style="color:${pnlColor(capital - startCap)};">${inr(capital)}</div>
        <div class="sc-sub">${(capital - startCap) >= 0 ? '▲' : '▼'} ${inr(Math.abs(capital - startCap))} vs start</div>
      </div>
      <div class="sc">
        <div class="sc-label" id="sumPnlLabel">All-Time PnL</div>
        <div class="sc-val" id="sumPnl" style="color:${pnlColor(totalPnl)};">${totalPnl >= 0 ? '+' : ''}${inr(totalPnl)}</div>
      </div>
      <div class="sc">
        <div class="sc-label" id="sumWrLabel">Overall Win Rate</div>
        <div class="sc-val" id="sumWr">${allTrades.length ? ((totalWins / allTrades.length) * 100).toFixed(1) + '%' : '—'}</div>
        <div class="sc-sub" id="sumWrSub">${totalWins}W · ${totalLosses}L · ${allTrades.length} trades</div>
      </div>
      <div class="sc">
        <div class="sc-label">Sessions</div>
        <div class="sc-val">${sessions.length}</div>
        <div class="sc-sub" id="sumSessionsSub">across all time</div>
      </div>
    </div>

    ${dailyFilesSectionHTML()}

    ${dayViewSectionHTML()}

    ${analyticsSectionHTML(cfg.extraAnalyticsHTML)}

    <div class="section-title">Sessions — newest first</div>
    ${sessionCards}

  </div>
</div>
</div>

${tradeModalHTML(cfg.modalLabel)}
${jsonlModalHTML()}
${contractNoteModalHTML()}

<script>${modalJS()}</script>
<script id="trades-data" type="application/json">${JSON.stringify(allTrades).replace(/<\/script>/gi, "<\\/script>")}</script>
<script id="sessions-data" type="application/json">${JSON.stringify(sessions).replace(/<\/script>/gi, "<\\/script>")}</script>
<script>
var ALL_TRADES_JSON = JSON.parse(document.getElementById('trades-data').textContent);
var ALL_SESSIONS_JSON = JSON.parse(document.getElementById('sessions-data').textContent);
var CN_STRAT_LABEL = ${JSON.stringify(cfg.modalLabel || "Contract")};
${contractNoteClientJS()}
// Resolve the trade set for a Report click and open the contract-note modal.
function openContractNote(scope, idx){
  var trades, sub, file;
  if(scope==='session'){
    var s=(ALL_SESSIONS_JSON||[])[idx]||{}; trades=s.trades||[];
    var d=s.date?String(s.date).slice(0,10):'';
    sub='Session '+(idx+1)+(d?(' · '+d):'')+' · '+trades.length+' trade'+(trades.length!==1?'s':'');
    file=CN_STRAT_LABEL.replace(/\\s+/g,'-').toLowerCase()+'-'+(d||('session-'+(idx+1)));
  } else {
    trades=ALL_TRADES_JSON||[];
    sub='All sessions · '+trades.length+' trade'+(trades.length!==1?'s':'');
    file=CN_STRAT_LABEL.replace(/\\s+/g,'-').toLowerCase()+'-all-sessions';
  }
  openContractNoteFor(CN_STRAT_LABEL+' — Contract Note', sub, trades, file);
}
${tradeModalJS()}
${dayViewAnalyticsJS({ routePrefix: cfg.routePrefix, startCap, filter })}
${cfg.extraAnalyticsJS || ""}
${dailyFilesClusterJS(cfg.routePrefix)}
${tableEnhancerJS()}
</script>
</body>
</html>`;
}

module.exports = {
  renderHistoryPage,
  buildSessionCards,
  dailyFilesSectionHTML,
  dailyFilesClusterJS,
  jsonlModalHTML,
  dailyFilesPaginate,
  themeInitScript,
  historyLightCSS,
};

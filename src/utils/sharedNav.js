/**
 * sharedNav.js — Unified navigation component
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders the sidebar nav (same design as Live Trade page) for ALL pages.
 * Used by: Dashboard, Backtest, Paper Trade, Live Trade, Logs
 *
 * @param {string}  activePage  - 'dashboard' | 'backtest' | 'paper' | 'live' | 'logs'
 * @param {boolean} liveActive  - true when LIVE_TRADE socket is running
 * @param {boolean} isRunning   - true when THIS page's trade/session is running
 * @param {object}  opts        - { showStopBtn, showStartBtn, showExitBtn, stopLabel, startLabel }
 */

function buildSidebar(activePage, liveActive, isRunning = false, opts = {}) {
  const {
    showStopBtn  = false,
    showStartBtn = false,
    showExitBtn  = false,
    stopBtnJs    = '',
    startBtnJs   = '',
    exitBtnJs    = '',
    stopLabel    = '■ Stop Trading',
    startLabel   = '▶ Start Trading',
    exitLabel    = '🚪 Exit Trade',
    statusLabel  = isRunning ? 'RUNNING' : 'STOPPED',
  } = opts;

  const pages = [
    { key: 'dashboard', href: '/',                     icon: '⌂',  label: 'Dashboard' },
    { key: 'backtest',  href: '/backtest',              icon: '🔍', label: 'Backtest'  },
    { key: 'paper',     href: '/paperTrade/status',     icon: '📋', label: 'Paper'     },
    { key: 'history',   href: '/paperTrade/history',    icon: '📊', label: 'History'   },
    { key: 'tracker',   href: '/tracker/status',        icon: '🎯', label: 'Tracker'   },
    { key: 'live',      href: '/trade/status',          icon: '●',  label: 'Live'      },
    { key: 'logs',      href: '/logs',                  icon: '📜', label: 'Logs'      },
    { key: 'settings', href: '/settings',              icon: '⚙',  label: 'Settings'  },
  ];

  // Keys blocked during live trade
  const blocked = liveActive ? ['backtest', 'paper'] : [];

  const navItems = pages.map(p => {
    const isActive   = p.key === activePage;
    const isDisabled = blocked.includes(p.key);

    if (isDisabled) {
      return `<span class="sb-nav-item disabled" title="Disabled — Live trade is running">
        <span class="sb-nav-icon">${p.icon}</span> ${p.label}
        <span class="sb-nav-badge" style="margin-left:auto;font-size:0.5rem;">🔒</span>
      </span>`;
    }

    const liveBadge = p.key === 'live' && liveActive
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const runningBadge = p.key === 'paper' && isRunning && activePage === 'paper'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    return `<a href="${p.href}" class="sb-nav-item${isActive ? ' active' : ''}">
      <span class="sb-nav-icon">${p.icon}</span> ${p.label}
      ${liveBadge}${runningBadge}
    </a>`;
  }).join('');

  const bottomBtns = [
    showExitBtn  ? `<button onclick="${exitBtnJs}"  class="sb-action-btn sb-exit-btn">${exitLabel}</button>`  : '',
    showStopBtn  ? `<button onclick="${stopBtnJs}"  class="sb-action-btn sb-stop-btn">${stopLabel}</button>`  : '',
    showStartBtn ? `<button onclick="${startBtnJs}" class="sb-action-btn sb-start-btn">${startLabel}</button>` : '',
  ].filter(Boolean).join('\n');

  return `
<button class="hamburger" onclick="toggleSidebar()" aria-label="Menu" style="display:none;">
  <span></span><span></span><span></span>
</button>
<div class="sidebar-overlay" id="sb-overlay" onclick="closeSidebar()"></div>
<nav class="sidebar" id="main-sidebar">
  <div class="sb-brand">
    <div class="sb-brand-icon">🪔</div>
    <div class="sb-brand-name">ௐ Palani Andawar Thunai ॐ</div>
    <div class="sb-brand-sub">TRADING BOT</div>
  </div>
  <div class="sb-nav">
    ${navItems}
  </div>
  <div class="sb-bottom">
    <div class="sb-status-row">
      <span class="sb-status-dot ${isRunning ? '' : 'stopped'}"></span>
      ${statusLabel}
    </div>
    ${bottomBtns}
  </div>
</nav>
<script>
(function(){
  if(window.innerWidth<=768){
    var hb=document.querySelector('.hamburger');
    if(hb) hb.style.display='flex';
  }
  window.addEventListener('resize',function(){
    var hb=document.querySelector('.hamburger');
    if(!hb) return;
    hb.style.display=window.innerWidth<=768?'flex':'none';
    if(window.innerWidth>768) closeSidebar();
  });
})();
function toggleSidebar(){
  var sb=document.getElementById('main-sidebar');
  var ov=document.getElementById('sb-overlay');
  if(!sb) return;
  var open=sb.classList.toggle('mobile-open');
  if(ov) ov.classList.toggle('active',open);
  document.body.style.overflow=open?'hidden':'';
}
function closeSidebar(){
  var sb=document.getElementById('main-sidebar');
  var ov=document.getElementById('sb-overlay');
  if(sb) sb.classList.remove('mobile-open');
  if(ov) ov.classList.remove('active');
  document.body.style.overflow='';
}
</script>`;
}

/**
 * Shared CSS for the sidebar + main-content shell.
 * Include once per page inside <style>.
 */
function sidebarCSS() {
  return `
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
    @keyframes ltpulse{0%,100%{opacity:1}50%{opacity:.25}}

    /* ── SIDEBAR ── */
    .app-shell{display:flex;min-height:100vh;}
    .sidebar{width:200px;flex-shrink:0;background:#03080e;border-right:1px solid #0e1e36;display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:100;overflow-y:auto;}
    .sb-brand{padding:20px 16px 16px;border-bottom:1px solid #0e1e36;}
    .sb-brand-icon{font-size:20px;margin-bottom:6px;}
    .sb-brand-name{font-size:0.72rem;font-weight:700;color:#3b82f6;letter-spacing:0.3px;line-height:1.4;}
    .sb-brand-sub{font-size:0.6rem;color:#1a3050;letter-spacing:2px;text-transform:uppercase;margin-top:2px;}
    .sb-nav{padding:10px 0;flex:1;}
    .sb-nav-item{display:flex;align-items:center;gap:8px;padding:9px 16px;font-size:0.72rem;color:#2a4060;cursor:pointer;border-left:2px solid transparent;transition:all 0.12s;text-decoration:none;}
    .sb-nav-item:hover{color:#7aacf0;background:rgba(59,130,246,0.04);}
    .sb-nav-item.active{color:#60a5fa;background:rgba(59,130,246,0.08);border-left-color:#3b82f6;}
    .sb-nav-item.disabled{color:#1a2a3a;cursor:not-allowed;opacity:0.4;pointer-events:none;}
    .sb-nav-icon{font-size:13px;width:16px;flex-shrink:0;}
    .sb-nav-badge{margin-left:auto;font-size:0.55rem;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(59,130,246,0.15);color:#60a5fa;border:0.5px solid rgba(59,130,246,0.3);white-space:nowrap;}
    .sb-nav-badge.live{background:rgba(239,68,68,0.15);color:#ef4444;border-color:rgba(239,68,68,0.3);animation:pulse 1.2s infinite;}
    .sb-divider{height:0.5px;background:#0e1e36;margin:6px 16px;}
    .sb-bottom{padding:14px 16px;border-top:1px solid #0e1e36;}
    .sb-status-row{display:flex;align-items:center;gap:6px;font-size:0.62rem;color:#1a3050;margin-bottom:10px;}
    .sb-status-dot{width:5px;height:5px;border-radius:50%;background:#3b82f6;animation:pulse 1.3s infinite;}
    .sb-status-dot.stopped{background:#2a4060;animation:none;}
    .sb-action-btn{width:100%;padding:7px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.68rem;font-weight:700;cursor:pointer;text-align:center;border:1px solid;transition:all 0.12s;background:transparent;margin-bottom:6px;}
    .sb-stop-btn{border-color:#1a3a6a;color:#60a5fa;}
    .sb-stop-btn:hover{background:rgba(59,130,246,0.08);border-color:#3b82f6;}
    .sb-start-btn{border-color:#065f46;color:#10b981;}
    .sb-start-btn:hover{background:rgba(16,185,129,0.06);border-color:#10b981;}
    .sb-exit-btn{border-color:#7f1d1d;color:#f87171;font-size:0.63rem;}
    .sb-exit-btn:hover{background:rgba(239,68,68,0.06);}
    .sb-paper-btn{border-color:#78350f;color:#f59e0b;}
    .sb-paper-btn:hover{background:rgba(245,158,11,0.06);border-color:#f59e0b;}
    .sb-reset-btn{border-color:#312e0f;color:#a16207;font-size:0.62rem;}
    .sb-reset-btn:hover{background:rgba(161,98,7,0.06);}

    /* ── MAIN CONTENT ── */
    .main-content{margin-left:200px;flex:1;display:flex;flex-direction:column;min-height:100vh;}
    .top-bar{background:#040c18;border-bottom:1px solid #0e1e36;padding:7px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50;}
    .top-bar-title{font-size:0.82rem;font-weight:700;color:#e0eaf8;}
    .top-bar-meta{font-size:0.62rem;color:#2a4060;margin-top:1px;}
    .top-bar-right{display:flex;align-items:center;gap:8px;}
    .top-bar-badge{display:flex;align-items:center;gap:5px;font-size:0.6rem;font-weight:700;padding:3px 9px;border-radius:4px;border:0.5px solid rgba(59,130,246,0.3);background:rgba(59,130,246,0.1);color:#60a5fa;}
    .top-bar-badge.live-active{border-color:rgba(239,68,68,0.3);background:rgba(239,68,68,0.1);color:#ef4444;animation:pulse 1.2s infinite;}
    .top-bar-badge.paper-active{border-color:rgba(16,185,129,0.3);background:rgba(16,185,129,0.1);color:#10b981;animation:pulse 1.2s infinite;}
    .broker-badges{display:flex;gap:6px;padding:8px 24px;background:#040c18;border-bottom:1px solid #0e1e36;flex-wrap:wrap;}
    .broker-badge{font-size:0.65rem;font-weight:600;padding:3px 10px;border-radius:5px;}
    .broker-badge.ok{background:#060e20;border:0.5px solid #0e2850;color:#60a5fa;}
    .broker-badge.err{background:#160608;border:0.5px solid #3a1020;color:#f87171;}

    /* ── PAGE BODY ── */
    .page{padding:24px;padding-bottom:60px;}
    .page-header{margin-bottom:20px;}
    .page-status-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
    .page-status-dot{width:7px;height:7px;border-radius:50%;background:#2a4060;}
    .page-status-dot.running{background:#3b82f6;animation:pulse 1.5s infinite;}
    .page-status-dot.paper-run{background:#10b981;animation:pulse 1.5s infinite;}
    .page-status-text{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#2a4060;}
    .page-status-text.running{color:#60a5fa;}
    .page-status-text.paper-run{color:#10b981;}
    .page-title{font-size:1.4rem;font-weight:700;color:#e0eaf8;letter-spacing:-0.5px;}
    .page-subtitle{font-size:0.72rem;color:#2a4060;margin-top:4px;}

    /* ── STAT CARDS ── */
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;margin-bottom:20px;}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:9px;padding:14px 16px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;right:0;height:1.5px;background:var(--accent,#1e3080);}
    .sc-label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:#1e3050;margin-bottom:6px;}
    .sc-val{font-size:1.1rem;font-weight:700;color:#e0eaf8;}
    .sc-sub{font-size:0.62rem;color:#1e3050;margin-top:3px;}

    /* ── SECTION TITLES ── */
    .section-title{font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:1.8px;color:#1e3050;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
    .section-title::after{content:'';flex:1;height:0.5px;background:#0e1e36;}

    /* ── TABLE ── */
    .data-table{width:100%;border-collapse:collapse;}
    .data-table th{padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;background:#0a0f1c;}
    .data-table td{padding:8px 12px;border-top:1px solid #1a2236;font-family:monospace;font-size:0.78rem;vertical-align:top;}

    /* ── MOBILE (iPhone 15 = 393px) ── */
    @media(max-width:768px){
      /* Sidebar: hidden by default, toggled by hamburger */
      .sidebar{transform:translateX(-100%);transition:transform 0.25s ease;z-index:200;}
      .sidebar.mobile-open{transform:translateX(0);}
      .main-content{margin-left:0;}

      /* Hamburger button */
      .hamburger{display:flex;flex-direction:column;gap:4px;cursor:pointer;padding:8px;background:none;border:none;position:fixed;top:8px;left:12px;z-index:300;}
      .hamburger span{display:block;width:20px;height:2px;background:#4a6080;border-radius:2px;transition:all 0.2s;}

      /* Overlay when sidebar open */
      .sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:150;}
      .sidebar-overlay.active{display:block;}

      /* Top bar: compress */
      .top-bar{padding:7px 12px 7px 48px;}
      .top-bar-meta{display:none;}

      /* Page padding */
      .page{padding:14px 12px 60px;}

      /* Stat grid: 2 columns */
      .stat-grid{grid-template-columns:1fr 1fr;gap:8px;}
      .sc{padding:10px 12px;}
      .sc-val{font-size:0.95rem;}

      /* Data table: scrollable */
      .data-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
      .data-table{min-width:600px;}
    }
    @media(max-width:400px){
      .stat-grid{grid-template-columns:1fr;}
    }`
    ;
}

/**
 * Common JS snippet for toast notifications (used on Paper+Live pages).
 */
function toastJS() {
  return `
function showToast(msg, color) {
  var t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#0d1320;border:1px solid '+color+';color:'+color+';padding:12px 24px;border-radius:10px;font-size:0.85rem;font-weight:700;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,0.6);letter-spacing:0.5px;pointer-events:none;';
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 3500);
}`;
}

/**
 * Shared log viewer HTML + JS (reused by Paper Trade and Live Trade status pages).
 * @param {string} logsJSON    - JSON string of log array (newest first)
 * @param {string} prefix      - Unique prefix for element IDs ('log' | 'ptlog')
 */
function logViewerHTML(logsJSON, prefix = 'log') {
  return `
  <div style="margin-top:8px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
      <div class="section-title" style="margin-bottom:0;">Activity Log</div>
      <input id="${prefix}Search" placeholder="Search log…" oninput="${prefix}Filter()"
        style="background:#07111f;border:1px solid #0e1e36;color:#c8d8f0;padding:4px 9px;border-radius:6px;font-size:0.73rem;font-family:inherit;width:180px;"/>
      <select id="${prefix}Type" onchange="${prefix}Filter()"
        style="background:#07111f;border:1px solid #0e1e36;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All entries</option>
        <option value="✅">✅ Wins</option>
        <option value="❌">❌ Errors</option>
        <option value="🚨">🚨 Alerts</option>
        <option value="🛑">🛑 SL Hits</option>
      </select>
      <select id="${prefix}PP" onchange="${prefix}Filter()"
        style="background:#07111f;border:1px solid #0e1e36;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="50">50/page</option>
        <option value="100">100/page</option>
        <option value="9999">All</option>
      </select>
      <span id="${prefix}Count" style="font-size:0.7rem;color:#4a6080;"></span>
    </div>
    <div id="${prefix}Box" style="background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;padding:12px 16px;max-height:360px;overflow-y:auto;"></div>
    <div id="${prefix}Pag" style="display:flex;gap:5px;margin-top:8px;flex-wrap:wrap;"></div>
  </div>

  <script id="${prefix}-data" type="application/json">${logsJSON}</script>
  <script>
  var ${prefix}_ALL = JSON.parse(document.getElementById('${prefix}-data').textContent);
  var ${prefix}Filtered = ${prefix}_ALL.slice(), ${prefix}Pg = 1, ${prefix}PP_val = 50;
  function ${prefix}Filter(){
    var s = document.getElementById('${prefix}Search').value.toLowerCase();
    var t = document.getElementById('${prefix}Type').value;
    ${prefix}PP_val = parseInt(document.getElementById('${prefix}PP').value);
    ${prefix}Pg = 1;
    ${prefix}Filtered = ${prefix}_ALL.filter(function(l){
      if(t && l.indexOf(t)<0) return false;
      if(s && l.toLowerCase().indexOf(s)<0) return false;
      return true;
    });
    ${prefix}Render();
  }
  function ${prefix}Render(){
    var start=(${prefix}Pg-1)*${prefix}PP_val, slice=${prefix}Filtered.slice(start,start+${prefix}PP_val);
    document.getElementById('${prefix}Count').textContent = ${prefix}Filtered.length+' of '+${prefix}_ALL.length;
    var box=document.getElementById('${prefix}Box');
    if(slice.length===0){ box.innerHTML='<div style="color:#4a6080;font-size:0.78rem;">No entries match.</div>'; document.getElementById('${prefix}Pag').innerHTML=''; return; }
    box.innerHTML = slice.map(function(l){
      var c = l.indexOf('❌')>=0?'#ef4444':l.indexOf('✅')>=0?'#10b981':l.indexOf('🚨')>=0||l.indexOf('🛑')>=0?'#f59e0b':l.indexOf('🎯')>=0||l.indexOf('⚡')>=0?'#3b82f6':'#4a6080';
      return '<div style="padding:5px 0;border-bottom:1px solid #0e1e36;font-size:0.72rem;font-family:monospace;color:'+c+';line-height:1.4;">'+l+'</div>';
    }).join('');
    var total=Math.ceil(${prefix}Filtered.length/${prefix}PP_val);
    var pag=document.getElementById('${prefix}Pag');
    if(total<=1){ pag.innerHTML=''; return; }
    var h='<button onclick="${prefix}Go('+(${prefix}Pg-1)+')" '+(${prefix}Pg===1?'disabled':'')+' style="background:#07111f;border:1px solid #0e1e36;color:#c8d8f0;padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">\u2190 Prev</button>';
    for(var p=Math.max(1,${prefix}Pg-2);p<=Math.min(total,${prefix}Pg+2);p++)
      h+='<button onclick="${prefix}Go('+p+')" style="background:'+(p===${prefix}Pg?'#0a1e3d':'#07111f')+';border:1px solid '+(p===${prefix}Pg?'#3b82f6':'#0e1e36')+';color:'+(p===${prefix}Pg?'#3b82f6':'#c8d8f0')+';padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">'+p+'</button>';
    h+='<button onclick="${prefix}Go('+(${prefix}Pg+1)+')" '+(${prefix}Pg===total?'disabled':'')+' style="background:#07111f;border:1px solid #0e1e36;color:#c8d8f0;padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">Next \u2192</button>';
    pag.innerHTML=h;
  }
  function ${prefix}Go(p){ ${prefix}Pg=Math.max(1,Math.min(Math.ceil(${prefix}Filtered.length/${prefix}PP_val),p)); ${prefix}Render(); }
  ${prefix}Filter();
  </script>`;
}

module.exports = { buildSidebar, sidebarCSS, toastJS, logViewerHTML };

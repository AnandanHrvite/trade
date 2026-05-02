/**
 * sharedNav.js — Unified navigation component
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders the sidebar nav (same design as Live Trade page) for ALL pages.
 * Used by: Dashboard, Backtest, Paper Trade, Live Trade, Logs
 *
 * @param {string}  activePage  - 'dashboard' | 'swingBacktest' | 'swingPaper' | 'swingLive' | 'logs'
 * @param {boolean} liveActive  - true when SWING_LIVE socket is running
 * @param {boolean} isRunning   - true when THIS page's trade/session is running
 * @param {object}  opts        - { showStopBtn, showStartBtn, showExitBtn, stopLabel, startLabel }
 */

function buildSidebar(activePage, liveActive, isRunning = false, opts = {}) {
  // Import scalp/primary/PA state inline to avoid circular dependency issues
  let _scalpMode = null;
  let _primaryMode = null;
  let _paMode = null;
  try {
    const sss = require('./sharedSocketState');
    _scalpMode = sss.getScalpMode();
    _primaryMode = sss.getMode();
    _paMode = sss.getPAMode();
  } catch (_) {}

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

  const scalpModeOn = (process.env.SCALP_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const paModeOn    = (process.env.PA_MODE_ENABLED || 'true').toLowerCase() === 'true';

  // ── Per-module menu-visibility toggles (managed from Settings page) ──
  const showSim      = (process.env.UI_SHOW_SIMULATE || 'false').toLowerCase() === 'true';
  const showCompare  = (process.env.UI_SHOW_COMPARE  || 'false').toLowerCase() === 'true';
  const showTracker  = (process.env.UI_SHOW_TRACKER  || 'false').toLowerCase() === 'true';

  // Determine which collapsible group the active page belongs to
  const tradingKeys = ['swingBacktest', 'swingPaper', 'swingSim', 'swingHistory', 'swingCompare', 'swingTracker', 'swingLive'];
  const scalpKeys   = ['scalpBacktest', 'scalpPaper', 'scalpSim', 'scalpHistory', 'scalpCompare', 'scalpLive'];
  const paKeys      = ['paBacktest', 'paPatternBacktest', 'paPaper', 'paSim', 'paHistory', 'paCompare', 'paLive'];

  const isTradingOpen = tradingKeys.includes(activePage);
  const isScalpOpen   = scalpKeys.includes(activePage);
  const isPAOpen      = paKeys.includes(activePage);

  // Build a swing items list with per-feature toggle
  const swingItems = [
    { key: 'swingBacktest', href: '/swing-backtest',       icon: '🔍', label: 'Backtest' },
    { key: 'swingPaper',    href: '/swing-paper/status',   icon: '📋', label: 'Paper'    },
    ...(showSim      ? [{ key: 'swingSim',     href: '/swing-paper/simulate', icon: '🎮', label: 'Simulate' }] : []),
    ...(showCompare  ? [{ key: 'swingCompare', href: '/compare/trading',      icon: '⚖',  label: 'Compare'  }] : []),
    ...(showTracker  ? [{ key: 'swingTracker', href: '/tracker/status',       icon: '🎯', label: 'Tracker'  }] : []),
    { key: 'swingLive',     href: '/swing-live/status',    icon: '●',  label: 'Live'     },
  ];

  const scalpItems = [
    { key: 'scalpBacktest', href: '/scalp-backtest',     icon: '⚡', label: 'Backtest' },
    { key: 'scalpPaper',    href: '/scalp-paper/status', icon: '⚡', label: 'Paper'    },
    ...(showSim     ? [{ key: 'scalpSim',     href: '/scalp-paper/simulate', icon: '🎮', label: 'Simulate' }] : []),
    ...(showCompare ? [{ key: 'scalpCompare', href: '/compare/scalping',     icon: '⚖',  label: 'Compare'  }] : []),
    { key: 'scalpLive',     href: '/scalp-live/status',  icon: '⚡', label: 'Live'     },
  ];

  const paItems = [
    { key: 'paBacktest',        href: '/pa-backtest',         icon: '📐', label: 'Backtest' },
    { key: 'paPatternBacktest', href: '/pa-pattern-backtest', icon: '△',  label: 'Pattern Test' },
    { key: 'paPaper',    href: '/pa-paper/status',   icon: '📐', label: 'Paper'    },
    ...(showSim     ? [{ key: 'paSim',     href: '/pa-paper/simulate',   icon: '🎮', label: 'Simulate' }] : []),
    ...(showCompare ? [{ key: 'paCompare', href: '/compare/priceaction', icon: '⚖',  label: 'Compare'  }] : []),
    { key: 'paLive',     href: '/pa-live/status',    icon: '📐', label: 'Live'     },
  ];

  // ── Grouped navigation sections (collapsible) ──
  const sections = [
    {
      header: null, collapsible: false,
      items: [
        { key: 'dashboard',         href: '/',                   icon: '⌂',  label: 'Dashboard' },
        { key: 'allBacktest',       href: '/all-backtest',       icon: '⏺',  label: 'Backtest' },
        { key: 'realtime',          href: '/realtime',           icon: '📡', label: 'Real-Time' },
        { key: 'consolidation',     href: '/consolidation',      icon: '🧾', label: 'Paper Traded History' },
        { key: 'liveConsolidation', href: '/live-consolidation', icon: '🔴', label: 'Live Traded History' },
      ]
    },
    {
      header: 'SWING', collapsible: true, collapsed: !isTradingOpen,
      groupId: 'nav-swing',
      items: swingItems,
    },
    ...(scalpModeOn ? [{
      header: 'SCALP', collapsible: true, collapsed: !isScalpOpen,
      groupId: 'nav-scalp',
      items: scalpItems,
    }] : []),
    ...(paModeOn ? [{
      header: 'PRICE ACTION', collapsible: true, collapsed: !isPAOpen,
      groupId: 'nav-pa',
      items: paItems,
    }] : []),
    {
      header: 'SYSTEM', collapsible: false,
      items: [
        { key: 'logs',      href: '/logs',       icon: '📜', label: 'Logs'       },
        { key: 'settings',  href: '/settings',   icon: '⚙',  label: 'Settings'   },
      ]
    },
  ];

  // Block all backtest & paper (trading + scalping + PA) when ANY live mode is active
  const anyLiveActive = liveActive || _scalpMode === 'SCALP_LIVE' || _paMode === 'PA_LIVE';
  const blocked = anyLiveActive ? ['allBacktest', 'swingBacktest', 'swingPaper', 'scalpBacktest', 'scalpPaper', 'paBacktest', 'paPatternBacktest', 'paPaper'] : [];

  function renderItem(p) {
    const isActive   = p.key === activePage;
    const isDisabled = blocked.includes(p.key);

    if (isDisabled) {
      return `<span class="sb-nav-item disabled" title="Disabled — Live trading is active">
        <span class="sb-nav-icon">${p.icon}</span> ${p.label}
        <span class="sb-nav-badge" style="margin-left:auto;font-size:0.5rem;">🔒</span>
      </span>`;
    }

    const liveBadge = p.key === 'swingLive' && liveActive
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const runningBadge = p.key === 'swingPaper' && (_primaryMode === 'SWING_PAPER' || isRunning)
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    const scalpLiveBadge = p.key === 'scalpLive' && _scalpMode === 'SCALP_LIVE'
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const scalpPaperBadge = p.key === 'scalpPaper' && _scalpMode === 'SCALP_PAPER'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    const paLiveBadge = p.key === 'paLive' && _paMode === 'PA_LIVE'
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const paPaperBadge = p.key === 'paPaper' && _paMode === 'PA_PAPER'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    return `<a href="${p.href}" class="sb-nav-item${isActive ? ' active' : ''}">
      <span class="sb-nav-icon">${p.icon}</span> ${p.label}
      ${liveBadge}${runningBadge}${scalpLiveBadge}${scalpPaperBadge}${paLiveBadge}${paPaperBadge}
    </a>`;
  }

  const navItems = sections.map(section => {
    const items = section.items.map(renderItem).join('');
    if (section.collapsible && section.header) {
      const gid = section.groupId || 'nav-' + section.header.toLowerCase().replace(/\s+/g, '-');
      const collapsed = section.collapsed ? ' collapsed' : '';
      return `<div class="sb-section">
        <div class="sb-section-header sb-collapsible${collapsed}" onclick="toggleNavGroup('${gid}')" data-group="${gid}">
          <span>${section.header}</span>
          <span class="sb-chevron">${section.collapsed ? '›' : '‹'}</span>
        </div>
        <div class="sb-group-items${collapsed}" id="${gid}">${items}</div>
      </div>`;
    }
    const header = section.header
      ? `<div class="sb-section-header">${section.header}</div>`
      : '';
    return `<div class="sb-section">${header}${items}</div>`;
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
    ${process.env.LOGIN_SECRET ? '<a href="/logout" class="sb-nav-item" style="margin-top:6px;font-size:0.62rem;color:#4a5878;justify-content:center;padding:5px;"><span class="sb-nav-icon">🔓</span> Logout</a>' : ''}
  </div>
</nav>
<div class="deploy-chip" id="deploy-chip" style="display:none;">
  <span class="deploy-chip-dot" id="deploy-chip-dot"></span>
  <span id="deploy-chip-label"></span>
</div>
<script>
window.__LOGIN_GATE_ACTIVE = ${!!process.env.LOGIN_SECRET};
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
function toggleNavGroup(gid){
  var el=document.getElementById(gid);
  var hdr=document.querySelector('[data-group="'+gid+'"]');
  if(!el) return;
  var willOpen = el.classList.contains('collapsed'); // we're about to open it
  // Accordion: close every other group first
  document.querySelectorAll('.sb-group-items').forEach(function(g){
    if(g.id === gid) return;
    g.classList.add('collapsed');
    var h=document.querySelector('[data-group="'+g.id+'"]');
    if(h) h.classList.add('collapsed');
    try{sessionStorage.setItem('nav_'+g.id,'0');}catch(e){}
  });
  // Toggle the clicked group
  if(willOpen){
    el.classList.remove('collapsed');
    if(hdr) hdr.classList.remove('collapsed');
    try{sessionStorage.setItem('nav_'+gid,'1');}catch(e){}
    try{sessionStorage.setItem('nav_last_open',gid);}catch(e){}
  } else {
    el.classList.add('collapsed');
    if(hdr) hdr.classList.add('collapsed');
    try{sessionStorage.setItem('nav_'+gid,'0');}catch(e){}
    try{sessionStorage.removeItem('nav_last_open');}catch(e){}
  }
}
// Restore: only the "last open" group stays open; everything else collapses.
(function(){
  var lastOpen = null;
  try{ lastOpen = sessionStorage.getItem('nav_last_open'); }catch(e){}
  // If there is an "active" group (the one whose page is current), prefer it
  var activeGroup = document.querySelector('.sb-group-items .sb-nav-item.active');
  if(activeGroup){
    var parent = activeGroup.closest('.sb-group-items');
    if(parent) lastOpen = parent.id;
  }
  document.querySelectorAll('.sb-group-items').forEach(function(g){
    var shouldOpen = (lastOpen && g.id === lastOpen);
    var hdr = document.querySelector('[data-group="'+g.id+'"]');
    if(shouldOpen){
      g.classList.remove('collapsed');
      if(hdr) hdr.classList.remove('collapsed');
      try{sessionStorage.setItem('nav_'+g.id,'1');}catch(e){}
    } else {
      g.classList.add('collapsed');
      if(hdr) hdr.classList.add('collapsed');
      try{sessionStorage.setItem('nav_'+g.id,'0');}catch(e){}
    }
  });
})();

/* ── Deploy status chip (top-right floating) ───────────────── */
(function(){
  var chip=document.getElementById('deploy-chip');
  var dot=document.getElementById('deploy-chip-dot');
  var lbl=document.getElementById('deploy-chip-label');
  if(!chip) return;

  var hideTimer=null;

  function elapsed(iso){
    var s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
    if(s<60) return s+'s';
    var m=Math.floor(s/60); s=s%60;
    return m+'m '+s+'s';
  }
  function ago(iso){
    var s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
    if(s<60) return s+'s ago';
    var m=Math.floor(s/60);
    if(m<60) return m+'m ago';
    var h=Math.floor(m/60);
    return h+'h ago';
  }

  var deployingTimer=null;
  var deployStart=null;

  function poll(){
    fetch('/deploy/status').then(function(r){return r.json()}).then(function(d){
      if(d.status==='idle'){
        chip.style.display='none';
        clearInterval(deployingTimer); deployingTimer=null;
        return;
      }
      chip.style.display='flex';
      clearTimeout(hideTimer);

      if(d.status==='deploying'){
        chip.className='deploy-chip deploying';
        deployStart=d.startedAt;
        lbl.textContent='DEPLOYING '+elapsed(d.startedAt);
        if(!deployingTimer){
          deployingTimer=setInterval(function(){
            if(deployStart) lbl.textContent='DEPLOYING '+elapsed(deployStart);
          },1000);
        }
      } else {
        clearInterval(deployingTimer); deployingTimer=null;
        if(d.status==='success'){
          chip.className='deploy-chip success';
          lbl.textContent='DEPLOYED '+ago(d.finishedAt);
        } else {
          chip.className='deploy-chip failure';
          lbl.textContent='DEPLOY FAILED '+ago(d.finishedAt);
        }
        // auto-hide after 5 minutes
        hideTimer=setTimeout(function(){ chip.style.display='none'; },5*60*1000);
      }
    }).catch(function(){});
  }

  poll();
  setInterval(poll,8000);
})();
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

    /* ── THEME OVERRIDE (Day View) ── */
    :root[data-theme="light"] { background-color:#f4f6f9 !important; }
    :root[data-theme="light"] body { background:#f4f6f9 !important; color:#334155 !important; }

    /* Sidebar — keep dark for contrast */
    :root[data-theme="light"] .sidebar { background:#1b2638 !important; border-right-color:#15202f !important; }
    :root[data-theme="light"] .sb-brand { border-bottom-color:#253347; }
    :root[data-theme="light"] .sb-brand-sub { color:#5a7090; }
    :root[data-theme="light"] .sb-section + .sb-section { border-top-color:#253347; }
    :root[data-theme="light"] .sb-section-header { color:#5a80a8; }
    :root[data-theme="light"] .sb-nav-item { color:#8aa0c0; }
    :root[data-theme="light"] .sb-nav-item:hover { color:#c8dcf0; background:rgba(59,130,246,0.08); }
    :root[data-theme="light"] .sb-nav-item.active { color:#ffffff; background:rgba(59,130,246,0.15); }
    :root[data-theme="light"] .sb-divider { background:#253347; }
    :root[data-theme="light"] .sb-bottom { border-top-color:#253347; }
    :root[data-theme="light"] .sb-status-row { color:#5a7090; }

    /* Top bar */
    :root[data-theme="light"] .top-bar { background:#ffffff !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .top-bar-title { color:#1e293b !important; }
    :root[data-theme="light"] .top-bar-meta { color:#94a3b8 !important; }
    :root[data-theme="light"] .broker-badges { background:#ffffff !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .broker-badge.ok { background:#eff6ff !important; border-color:#bfdbfe !important; color:#2563eb !important; }
    :root[data-theme="light"] .broker-badge.err { background:#fef2f2 !important; border-color:#fecaca !important; color:#dc2626 !important; }

    /* Page body */
    :root[data-theme="light"] .page-status-dot { background:#94a3b8 !important; }
    :root[data-theme="light"] .page-status-text { color:#94a3b8 !important; }
    :root[data-theme="light"] .page-title { color:#1e293b !important; }
    :root[data-theme="light"] .page-subtitle { color:#94a3b8 !important; }
    :root[data-theme="light"] .page-sub { color:#94a3b8 !important; }

    /* Stat cards */
    :root[data-theme="light"] .sc { background:#ffffff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06) !important; }
    :root[data-theme="light"] .sc::before { background:var(--accent,#93c5fd) !important; }
    :root[data-theme="light"] .sc-label { color:#64748b !important; }
    :root[data-theme="light"] .sc-val { color:#1e293b !important; }
    :root[data-theme="light"] .sc-sub { color:#94a3b8 !important; }

    /* Section titles */
    :root[data-theme="light"] .section-title { color:#64748b !important; }
    :root[data-theme="light"] .section-title::after { background:#e0e4ea !important; }

    /* Tables */
    :root[data-theme="light"] .data-table th { color:#64748b !important; background:#f1f5f9 !important; }
    :root[data-theme="light"] .data-table td { border-top-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] table th { color:#64748b !important; background:#f1f5f9 !important; }
    :root[data-theme="light"] table td { border-color:#e0e4ea !important; }
    :root[data-theme="light"] table tr { border-color:#e0e4ea !important; }

    /* Main content area */
    :root[data-theme="light"] .main-content { background:#f4f6f9 !important; }

    /* Page wrapper */
    :root[data-theme="light"] .page { color:#334155 !important; }

    /* Text selection */
    :root[data-theme="light"] ::selection { background:#bfdbfe !important; color:#1e293b !important; }
    :root[data-theme="light"] ::-moz-selection { background:#bfdbfe !important; color:#1e293b !important; }

    /* Sidebar overlay */
    :root[data-theme="light"] .sidebar-overlay.active { background:rgba(0,0,0,0.3) !important; }

    /* ── PAGE-SPECIFIC CLASS OVERRIDES ── */
    /* (Inline style="" colors are handled by JS rewriter in modalJS) */

    /* Generic — cards, boxes, containers used across pages */
    :root[data-theme="light"] .card,
    :root[data-theme="light"] .box,
    :root[data-theme="light"] .err-box,
    :root[data-theme="light"] .confirm-box { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .err-box,
    :root[data-theme="light"] .confirm-box { border-color:#fca5a5 !important; }

    /* Backtest/ScalpBacktest — run bar, stat cards, tables, toggles, copy btns */
    :root[data-theme="light"] .run-bar { background:#f8fafc !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .dw-table tbody tr:hover { background:#f8fafc !important; }
    :root[data-theme="light"] tbody tr:hover { background:#f8fafc !important; }
    :root[data-theme="light"] .tbar input,
    :root[data-theme="light"] .tbar select { background:#f8fafc !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .tw { border-color:#e0e4ea !important; }
    :root[data-theme="light"] .pag button { background:#ffffff !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .pag button.active { background:#eff6ff !important; border-color:#3b82f6 !important; color:#2563eb !important; }
    :root[data-theme="light"] .pag-info { color:#64748b !important; }
    :root[data-theme="light"] .dw-toggle { border-color:#e0e4ea !important; color:#2563eb !important; }
    :root[data-theme="light"] .dw-toggle:hover,
    :root[data-theme="light"] .dw-toggle.active { background:#eff6ff !important; border-color:#3b82f6 !important; }
    :root[data-theme="light"] .copy-btn { background:#ffffff !important; border-color:#e0e4ea !important; color:#2563eb !important; }
    :root[data-theme="light"] .copy-btn:hover { background:#eff6ff !important; border-color:#3b82f6 !important; }
    :root[data-theme="light"] .copy-btn.copied { background:#dcfce7 !important; border-color:#10b981 !important; color:#059669 !important; }
    :root[data-theme="light"] #tooltip { background:#1e293b !important; }

    /* Analytics cards (scalp/backtest) */
    :root[data-theme="light"] .ana-card { background:#ffffff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06) !important; }
    :root[data-theme="light"] .ana-card h3 { color:#64748b !important; }
    :root[data-theme="light"] .ana-mini { background:#ffffff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06) !important; }
    :root[data-theme="light"] .ana-mini h3 { color:#64748b !important; }
    :root[data-theme="light"] .ana-tbl th { color:#64748b !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .ana-tbl td { color:#334155 !important; border-bottom-color:#f1f5f9 !important; }
    :root[data-theme="light"] .ana-tbl tr:hover { background:#f8fafc !important; }
    :root[data-theme="light"] .ana-stat-label { color:#94a3b8 !important; }

    /* Trade/Paper/Scalp — capital strip, stat cards, session cards, export btns */
    :root[data-theme="light"] .capital-strip { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .session-card { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .session-head { background:#f8fafc !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .export-btn { background:#f8fafc !important; border-color:#e0e4ea !important; color:#64748b !important; }
    :root[data-theme="light"] .export-btn:hover { background:#eff6ff !important; border-color:#2563eb !important; color:#2563eb !important; }
    :root[data-theme="light"] .badge-running { background:#dcfce7 !important; color:#059669 !important; border-color:#10b981 !important; }
    :root[data-theme="light"] .scalp-toast { background:#ffffff !important; box-shadow:0 4px 24px rgba(0,0,0,0.12) !important; }

    /* Scalp/Trade — broker badges, top bar overrides */
    :root[data-theme="light"] .broker-badge.ok { background:#eff6ff !important; border-color:#bfdbfe !important; color:#2563eb !important; }
    :root[data-theme="light"] .broker-badge.err { background:#fef2f2 !important; border-color:#fecaca !important; color:#dc2626 !important; }

    /* Docs page */
    :root[data-theme="light"] .tab { background:#f8fafc !important; border-color:#e0e4ea !important; color:#64748b !important; }
    :root[data-theme="light"] .tab.active { background:#ffffff !important; border-color:#2563eb !important; color:#2563eb !important; }
    :root[data-theme="light"] .doc-card { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .doc-card h2 { border-bottom-color:#e0e4ea !important; color:#1e293b !important; }
    :root[data-theme="light"] .doc-card code { background:#f1f5f9 !important; color:#334155 !important; }
    :root[data-theme="light"] .doc-card pre { background:#f8fafc !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .guide-link { border-color:#e0e4ea !important; }
    :root[data-theme="light"] .guide-link:hover { background:#f8fafc !important; border-color:#2563eb !important; }

    /* Logs page */
    :root[data-theme="light"] .toolbar { background:#ffffff !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .counter { background:#f1f5f9 !important; border-color:#e0e4ea !important; color:#64748b !important; }
    :root[data-theme="light"] .badge-live { background:#dcfce7 !important; border-color:#86efac !important; color:#16a34a !important; }
    :root[data-theme="light"] .fp[data-level="ALL"]   { background:#f1f5f9 !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .fp[data-level="LOG"]   { background:#eff6ff !important; border-color:#bfdbfe !important; color:#2563eb !important; }
    :root[data-theme="light"] .fp[data-level="INFO"]  { background:#f0fdf4 !important; border-color:#bbf7d0 !important; color:#059669 !important; }
    :root[data-theme="light"] .fp[data-level="WARN"]  { background:#fffbeb !important; border-color:#fcd34d !important; color:#d97706 !important; }
    :root[data-theme="light"] .fp[data-level="ERROR"] { background:#fef2f2 !important; border-color:#fca5a5 !important; color:#dc2626 !important; }
    :root[data-theme="light"] #search { background:#f8fafc !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] #search::placeholder { color:#94a3b8 !important; }
    :root[data-theme="light"] .btn { border-color:#e0e4ea !important; }
    :root[data-theme="light"] .btn-scroll { background:#ffffff !important; border-color:#e0e4ea !important; color:#64748b !important; }
    :root[data-theme="light"] .btn-scroll.on { background:#eff6ff !important; border-color:#3b82f6 !important; color:#2563eb !important; }
    :root[data-theme="light"] .btn-export { background:#eff6ff !important; border-color:#bfdbfe !important; color:#2563eb !important; }
    :root[data-theme="light"] .btn-exportj { background:#f5f3ff !important; border-color:#c4b5fd !important; color:#7c3aed !important; }
    :root[data-theme="light"] .btn-clear { background:#fef2f2 !important; border-color:#fca5a5 !important; color:#dc2626 !important; }
    :root[data-theme="light"] .log-wrap { background:#ffffff !important; }
    :root[data-theme="light"] .log-wrap::-webkit-scrollbar-track { background:#f4f6f9 !important; }
    :root[data-theme="light"] .log-wrap::-webkit-scrollbar-thumb { background:#cbd5e1 !important; }
    :root[data-theme="light"] .log-row { border-bottom-color:#f1f5f9 !important; }
    :root[data-theme="light"] .log-row:hover { background:#f8fafc !important; }
    :root[data-theme="light"] .log-row[data-level="WARN"] { background:#fffbeb !important; }
    :root[data-theme="light"] .log-row[data-level="WARN"]:hover { background:#fef9c3 !important; }
    :root[data-theme="light"] .log-row[data-level="ERROR"] { background:#fef2f2 !important; }

    /* History pages (paperTrade, scalpPaper) */
    :root[data-theme="light"] .session-card { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .session-head { background:#f8fafc !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .summary-table th { background:#f1f5f9 !important; color:#64748b !important; }
    :root[data-theme="light"] .summary-table td { border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .holiday-table th { background:#f1f5f9 !important; color:#64748b !important; }
    :root[data-theme="light"] .holiday-table td { border-color:#e0e4ea !important; }

    /* Manual Tracker page */
    :root[data-theme="light"] .log-box { background:#ffffff !important; border-color:#e0e4ea !important; }

    /* Paper Trade pages (green-tinted dark theme) */
    :root[data-theme="light"] .capital-strip { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .cap-cell { border-right-color:#e0e4ea !important; }
    :root[data-theme="light"] .cap-label { color:#64748b !important; }
    :root[data-theme="light"] .cap-val { color:#1e293b !important; }
    :root[data-theme="light"] .cap-val.white { color:#1e293b !important; }
    :root[data-theme="light"] .cap-val.green { color:#16a34a !important; }

    /* Compare page */
    :root[data-theme="light"] .panel { background:#ffffff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06) !important; }
    :root[data-theme="light"] .metric { background:#f8fafc !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .metric-label { color:#64748b !important; }
    :root[data-theme="light"] .metric-val { color:#1e293b !important; }
    :root[data-theme="light"] .metric-sub { color:#94a3b8 !important; }
    :root[data-theme="light"] .subtitle { color:#94a3b8 !important; }
    :root[data-theme="light"] h1 { color:#1e293b !important; }
    :root[data-theme="light"] .diff-title { color:#1e293b !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .diff-table th { color:#64748b !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .diff-table td { border-bottom-color:#f1f5f9 !important; color:#334155 !important; }
    :root[data-theme="light"] .diff-table tr:hover { background:#f8fafc !important; }
    :root[data-theme="light"] .diff-table .neutral { color:#334155 !important; }
    :root[data-theme="light"] .day-table th { color:#64748b !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .day-table td { border-bottom-color:#f1f5f9 !important; }
    :root[data-theme="light"] .day-table tr:hover { background:#f8fafc !important; }
    :root[data-theme="light"] .chart-wrap { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .chart-title { color:#1e293b !important; }
    :root[data-theme="light"] .no-data { color:#94a3b8 !important; }
    :root[data-theme="light"] .tag.paper { background:rgba(59,130,246,0.1) !important; }
    :root[data-theme="light"] .tag.backtest { background:rgba(245,158,11,0.1) !important; }

    /* Settings page */
    :root[data-theme="light"] .auth-box { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .auth-box h2 { color:#2563eb !important; }
    :root[data-theme="light"] .auth-box p { color:#64748b !important; }
    :root[data-theme="light"] .auth-box input { background:#f8fafc !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .auth-box button { background:#2563eb !important; }
    :root[data-theme="light"] .auth-err { color:#dc2626 !important; }
    :root[data-theme="light"] .env-key-tag { color:#2563eb !important; }

    /* ── SIDEBAR ── */
    .app-shell{display:flex;min-height:100vh;}
    .sidebar{width:200px;flex-shrink:0;background:#03080e;border-right:1px solid #0e1e36;display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:100;overflow-y:auto;}
    .sb-brand{padding:20px 16px 16px;border-bottom:1px solid #0e1e36;}
    .sb-brand-name{font-size:0.72rem;font-weight:700;color:#3b82f6;letter-spacing:0.3px;line-height:1.4;white-space:nowrap;}
    .sb-brand-sub{font-size:0.6rem;color:#1a3050;letter-spacing:2px;text-transform:uppercase;margin-top:2px;}
    .sb-nav{padding:6px 0;flex:1;}
    .sb-section{padding-bottom:4px;}
    .sb-section + .sb-section{border-top:1px solid #0e1e36;padding-top:4px;}
    .sb-section-header{font-size:0.52rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#1e3a5a;padding:8px 16px 2px;user-select:none;}
    .sb-section-header.sb-collapsible{cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding-right:16px;transition:color 0.15s;}
    .sb-section-header.sb-collapsible:hover{color:#3b82f6;}
    .sb-chevron{font-size:0.7rem;transition:transform 0.2s;display:inline-block;}
    .sb-section-header.sb-collapsible:not(.collapsed) .sb-chevron{transform:rotate(-90deg);}
    .sb-section-header.sb-collapsible.collapsed .sb-chevron{transform:rotate(0deg);}
    .sb-group-items{overflow:hidden;max-height:500px;transition:max-height 0.25s ease-in-out,opacity 0.2s;opacity:1;}
    .sb-group-items.collapsed{max-height:0;opacity:0;padding:0;}
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
    .deploy-chip{display:none;position:fixed;bottom:16px;right:20px;z-index:9999;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;font-family:'IBM Plex Mono',monospace;font-size:0.65rem;font-weight:600;letter-spacing:0.4px;backdrop-filter:blur(8px);box-shadow:0 2px 12px rgba(0,0,0,0.3);cursor:default;transition:all 0.3s;}
    .deploy-chip.deploying{background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);color:#f59e0b;}
    .deploy-chip.success{background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);color:#10b981;}
    .deploy-chip.failure{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);color:#ef4444;}
    .deploy-chip-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}
    .deploy-chip.deploying .deploy-chip-dot{background:#f59e0b;animation:pulse 1s infinite;}
    .deploy-chip.success .deploy-chip-dot{background:#10b981;}
    .deploy-chip.failure .deploy-chip-dot{background:#ef4444;animation:ltpulse 1.5s infinite;}
    :root[data-theme="light"] .deploy-chip{box-shadow:0 2px 12px rgba(0,0,0,0.1);}
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
  var isLight = document.documentElement.getAttribute('data-theme') === 'light';
  var bg = isLight ? '#ffffff' : '#0d1320';
  var shadow = isLight ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.6)';
  t.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:'+bg+';border:1px solid '+color+';color:'+color+';padding:12px 24px;border-radius:10px;font-size:0.85rem;font-weight:700;z-index:9999;box-shadow:0 4px 24px '+shadow+';letter-spacing:0.5px;pointer-events:none;';
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


/**
 * Shared favicon link tag (OM icon for browser tab).
 * Include once per page inside <head>.
 */
function faviconLink() {
  return `<link rel="icon" type="image/png" href="data:image/png;base64,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"/>`;
}

/**
 * CSS for the custom modal system (alert, confirm, prompt replacements).
 */
function modalCSS() {
  return `
    .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.15s;pointer-events:none;}
    .modal-overlay.active{opacity:1;pointer-events:all;}
    .modal-box{background:#0d1320;border:1px solid #1a2236;border-radius:14px;padding:28px 24px 22px;width:400px;max-width:90vw;box-shadow:0 8px 40px rgba(0,0,0,0.6);transform:scale(0.95);transition:transform 0.15s;}
    .modal-overlay.active .modal-box{transform:scale(1);}
    .modal-icon{font-size:1.6rem;text-align:center;margin-bottom:10px;}
    .modal-title{font-size:0.9rem;font-weight:700;color:#e0eaf8;text-align:center;margin-bottom:6px;}
    .modal-msg{font-size:0.76rem;color:#6a8ab0;text-align:center;line-height:1.6;margin-bottom:18px;white-space:pre-line;}
    .modal-input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #1a2a40;background:#070d18;color:#e0eaf8;font-size:0.82rem;font-family:inherit;outline:none;margin-bottom:16px;transition:border-color 0.15s;}
    .modal-input:focus{border-color:#3b82f6;}
    .modal-btns{display:flex;gap:10px;justify-content:center;}
    .modal-btn{padding:9px 22px;border-radius:8px;font-size:0.78rem;font-weight:700;font-family:inherit;cursor:pointer;border:1px solid;transition:all 0.12s;}
    .modal-btn-primary{background:#1e40af;border-color:#1e40af;color:#fff;}
    .modal-btn-primary:hover{background:#2563eb;}
    .modal-btn-danger{background:#7f1d1d;border-color:#7f1d1d;color:#fff;}
    .modal-btn-danger:hover{background:#991b1b;}
    .modal-btn-cancel{background:transparent;border-color:#1a2a40;color:#6a8ab0;}
    .modal-btn-cancel:hover{border-color:#3a5070;color:#a0c0e0;}
    .modal-btn-success{background:#065f46;border-color:#065f46;color:#fff;}
    .modal-btn-success:hover{background:#047857;}

    /* ── MODAL LIGHT THEME ── */
    :root[data-theme="light"] .modal-overlay { background:rgba(0,0,0,0.3); }
    :root[data-theme="light"] .modal-box { background:#ffffff; border-color:#e0e4ea; box-shadow:0 8px 40px rgba(0,0,0,0.15); }
    :root[data-theme="light"] .modal-title { color:#1e293b; }
    :root[data-theme="light"] .modal-msg { color:#64748b; }
    :root[data-theme="light"] .modal-input { background:#f8fafc; border-color:#e0e4ea; color:#1e293b; }
    :root[data-theme="light"] .modal-input:focus { border-color:#3b82f6; }
    :root[data-theme="light"] .modal-btn-cancel { border-color:#e0e4ea; color:#64748b; }
    :root[data-theme="light"] .modal-btn-cancel:hover { border-color:#94a3b8; color:#334155; }
  `;
}

/**
 * JS for the custom modal system + API_SECRET session helper.
 * Include once per page inside <script>.
 */
function modalJS() {
  return `
// ── Modal System ────────────────────────────────────────────────────────────
// Guard: only create overlay once (safe when modalJS is injected multiple times on a page)
(function(){
  if (document.getElementById('modal-overlay')) return;
  var ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'modal-overlay';
  ov.innerHTML = '<div class="modal-box" id="modal-box"></div>';
  document.body.appendChild(ov);
  // Backdrop click — dismiss modal (click on overlay, not the box)
  ov.addEventListener('click', function(e) {
    if (e.target === ov) {
      _hideModal();
      if (_modalResolve) { _modalResolve(null); _modalResolve = null; }
    }
  });
})();

// Guard: only define functions once
if (typeof _showModal === 'undefined') {

var _modalResolve = null; // current modal's resolve callback

function _showModal(html) {
  var ov = document.getElementById('modal-overlay');
  var box = document.getElementById('modal-box');
  box.innerHTML = html;
  ov.classList.add('active');
  var inp = box.querySelector('.modal-input');
  if (inp) setTimeout(function(){ inp.focus(); }, 50);
}

function _hideModal() {
  var ov = document.getElementById('modal-overlay');
  if (ov) ov.classList.remove('active');
}

function showAlert(opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    _modalResolve = function(){ resolve(); };
    _showModal(
      '<div class="modal-icon">' + (opts.icon || 'ℹ️') + '</div>'
      + (opts.title ? '<div class="modal-title">' + opts.title + '</div>' : '')
      + '<div class="modal-msg">' + (opts.message || '') + '</div>'
      + '<div class="modal-btns"><button class="modal-btn ' + (opts.btnClass || 'modal-btn-primary') + '" id="modal-ok-btn">' + (opts.btnText || 'OK') + '</button></div>'
    );
    document.getElementById('modal-ok-btn').onclick = function(){ _hideModal(); _modalResolve(); };
  });
}

function showConfirm(opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    _modalResolve = function(v){ resolve(v); };
    _showModal(
      '<div class="modal-icon">' + (opts.icon || '⚠️') + '</div>'
      + '<div class="modal-title">' + (opts.title || 'Confirm') + '</div>'
      + '<div class="modal-msg">' + (opts.message || 'Are you sure?') + '</div>'
      + '<div class="modal-btns">'
      + '<button class="modal-btn modal-btn-cancel" id="modal-cancel-btn">' + (opts.cancelText || 'Cancel') + '</button>'
      + '<button class="modal-btn ' + (opts.confirmClass || 'modal-btn-danger') + '" id="modal-confirm-btn">' + (opts.confirmText || 'Yes') + '</button>'
      + '</div>'
    );
    document.getElementById('modal-cancel-btn').onclick = function(){ _hideModal(); _modalResolve(false); };
    document.getElementById('modal-confirm-btn').onclick = function(){ _hideModal(); _modalResolve(true); };
  });
}

function showPrompt(opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    _modalResolve = function(v){ resolve(v); };
    _showModal(
      '<div class="modal-icon">' + (opts.icon || '🔑') + '</div>'
      + (opts.title ? '<div class="modal-title">' + opts.title + '</div>' : '')
      + (opts.message ? '<div class="modal-msg">' + opts.message + '</div>' : '')
      + '<input type="' + (opts.inputType || 'password') + '" class="modal-input" id="modal-input" placeholder="' + (opts.placeholder || '') + '">'
      + '<div class="modal-btns">'
      + '<button class="modal-btn modal-btn-cancel" id="modal-cancel-btn">Cancel</button>'
      + '<button class="modal-btn modal-btn-primary" id="modal-ok-btn">Submit</button>'
      + '</div>'
    );
    var inp = document.getElementById('modal-input');
    inp.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); _hideModal(); _modalResolve(inp.value); } });
    document.getElementById('modal-cancel-btn').onclick = function(){ _hideModal(); _modalResolve(null); };
    document.getElementById('modal-ok-btn').onclick = function(){ _hideModal(); _modalResolve(inp.value); };
  });
}

// ── Idle timeout — auto-logout after 15 min of no activity ──────────────────
(function(){
  if (!window.__LOGIN_GATE_ACTIVE) return;
  var IDLE_MS = 15 * 60 * 1000;
  var WARN_MS = 14 * 60 * 1000;
  var _idleTimer = null;
  var _warnTimer = null;
  var _loggedOut = false;

  function resetIdle() {
    if (_loggedOut) return;
    clearTimeout(_idleTimer);
    clearTimeout(_warnTimer);
    _warnTimer = setTimeout(onWarn, WARN_MS);
    _idleTimer = setTimeout(onIdle, IDLE_MS);
  }

  function onWarn() {
    if (_loggedOut) return;
    showAlert({
      icon: '⏰', title: 'Session Expiring',
      message: 'You will be logged out in 1 minute due to inactivity.\\nMove your mouse or press a key to stay logged in.',
      btnText: 'Stay Logged In', btnClass: 'modal-btn-success'
    }).then(function() { resetIdle(); });
  }

  function onIdle() {
    _loggedOut = true;
    showAlert({
      icon: '🔒', title: 'Session Expired',
      message: 'Logged out due to 15 minutes of inactivity.',
      btnText: 'Login Again', btnClass: 'modal-btn-primary'
    }).then(function() { window.location.href = '/logout'; });
    setTimeout(function() { window.location.href = '/logout'; }, 5000);
  }

  // Throttled activity tracker — resets idle timer at most once per 200ms
  var _throttle = null;
  function onActivity() {
    if (_loggedOut || _throttle) return;
    _throttle = setTimeout(function() { _throttle = null; }, 200);
    resetIdle();
  }

  ['mousemove','mousedown','keydown','touchstart','scroll','click'].forEach(function(evt) {
    document.addEventListener(evt, onActivity, { passive: true });
  });

  resetIdle();
})();

} // end guard: typeof _showModal === 'undefined'

// ── API_SECRET session helper (outside guard — must always be defined) ─────
function getApiSecret() { return sessionStorage.getItem('__api_secret') || ''; }
function setApiSecret(val) { sessionStorage.setItem('__api_secret', val); }

async function askApiSecret() {
  var stored = getApiSecret();
  if (stored) return stored;
  var val = await showPrompt({
    icon: '🔐',
    title: 'API Secret Required',
    message: 'This action requires your API_SECRET.\\nIt will be remembered for this browser session.',
    placeholder: 'Enter API_SECRET from .env',
    inputType: 'password'
  });
  if (val === null) return null;
  if (val) setApiSecret(val);
  return val || '';
}

async function secretFetch(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  var secret = getApiSecret();
  if (secret) opts.headers['x-api-secret'] = secret;
  var controller = new AbortController();
  var tid = setTimeout(function(){ controller.abort(); }, 15000);
  opts.signal = controller.signal;
  var res;
  try { res = await fetch(url, opts); } finally { clearTimeout(tid); }
  if (res.status === 403) {
    sessionStorage.removeItem('__api_secret');
    var isRetry = !!secret;
    if (isRetry) await showAlert({ icon: '🚫', title: 'Wrong API Secret', message: 'The API secret was incorrect. Please try again.', btnClass: 'modal-btn-danger' });
    secret = await askApiSecret();
    if (secret === null) return null;
    opts.headers['x-api-secret'] = secret;
    var c2 = new AbortController();
    var t2 = setTimeout(function(){ c2.abort(); }, 15000);
    opts.signal = c2.signal;
    try { res = await fetch(url, opts); } finally { clearTimeout(t2); }
  }
  return res;
}

// ── Theme overriding ────────────────────────────────────────────────────────
(function(){
  if ('${process.env.UI_THEME || "dark"}' !== 'light') return;
  document.documentElement.setAttribute('data-theme', 'light');

  // ── Force body style immediately ──
  document.body.style.setProperty('background', '#f4f6f9', 'important');
  document.body.style.setProperty('color', '#334155', 'important');

  // ── Inject light-theme CSS at END of <head> to guarantee cascade wins ──
  var _ltStyle = document.createElement('style');
  _ltStyle.id = 'light-theme-force';
  _ltStyle.textContent = [
    'body{background:#f4f6f9!important;color:#334155!important;}',
    '.main-content{background:#f4f6f9!important;}',
    '.page{color:#334155!important;}',
    '.top-bar{background:#fff!important;border-bottom-color:#e0e4ea!important;}',
    '.top-bar-title{color:#1e293b!important;}',
    '.top-bar-meta{color:#94a3b8!important;}',
    'h1{color:#1e293b!important;}',
    '.page-title{color:#1e293b!important;}',
    '.subtitle,.page-subtitle,.page-sub{color:#94a3b8!important;}',
    '.sc{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,.06)!important;}',
    '.sc-label,.cap-label{color:#64748b!important;}',
    '.sc-val{color:#1e293b!important;}',
    '.sc-sub{color:#94a3b8!important;}',
    '.section-title{color:#64748b!important;}',
    '.section-title::after{background:#e0e4ea!important;}',
    'table th{color:#64748b!important;background:#f1f5f9!important;}',
    'table td{border-color:#e0e4ea!important;}',
    'table tr{border-color:#e0e4ea!important;}',
    'tbody tr:hover{background:#f8fafc!important;}',
    // Cards & panels
    '.card,.box,.err-box,.confirm-box,.panel,.chart-wrap,.session-card,.ana-card,.ana-mini,.log-box,.capital-strip{background:#fff!important;border-color:#e0e4ea!important;}',
    '.metric{background:#f8fafc!important;border-color:#e0e4ea!important;}',
    '.session-head{background:#f8fafc!important;border-bottom-color:#e0e4ea!important;}',
    '.run-bar{background:#f8fafc!important;border-color:#e0e4ea!important;}',
    // Text colors
    '.panel-title,.chart-title,.diff-title,.session-name{color:#1e293b!important;}',
    '.metric-label,.cap-label,.proc-title,.stat-label,.chart-title-text,.ana-card h3,.ana-mini h3{color:#64748b!important;}',
    '.metric-val,.cap-val,.stat-value,.proc-item .pi-val{color:#1e293b!important;}',
    '.metric-sub,.cap-sub,.no-data{color:#94a3b8!important;}',
    '.cap-val.white{color:#1e293b!important;}',
    '.cap-val.green{color:#16a34a!important;}',
    // Tables (compare, diff, day, history, data)
    '.diff-table th,.day-table th,.data-table th,.summary-table th,.holiday-table th,.ana-tbl th,.tbl th{color:#64748b!important;border-bottom-color:#e0e4ea!important;background:#f1f5f9!important;}',
    '.diff-table td,.day-table td,.data-table td,.summary-table td,.ana-tbl td,.tbl td{border-color:#e0e4ea!important;color:#334155!important;}',
    '.diff-table .neutral{color:#334155!important;}',
    '.diff-table tr:hover,.day-table tr:hover,.ana-tbl tr:hover{background:#f8fafc!important;}',
    // Cap cells
    '.cap-cell{border-right-color:#e0e4ea!important;}',
    // Stat cards for monitor
    '.stat-card,.chart-card,.proc-card{background:#fff!important;border-color:#e0e4ea!important;}',
    '.stat-sub,.proc-item .pi-label{color:#94a3b8!important;}',
    '.bar-track{background:#e2e8f0!important;}',
    // Logs
    '.toolbar{background:#fff!important;border-bottom-color:#e0e4ea!important;}',
    '.log-wrap{background:#fff!important;}',
    '.log-row{border-bottom-color:#f1f5f9!important;}',
    '#search{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}',
    // Export/action btns
    '.export-btn,.copy-btn{background:#f8fafc!important;border-color:#e0e4ea!important;color:#64748b!important;}',
    // Broker badges
    '.broker-badges{background:#fff!important;border-bottom-color:#e0e4ea!important;}',
    '.broker-badge.ok{background:#eff6ff!important;border-color:#bfdbfe!important;color:#2563eb!important;}',
    '.broker-badge.err{background:#fef2f2!important;border-color:#fecaca!important;color:#dc2626!important;}',
    // Selection
    '::selection{background:#bfdbfe!important;color:#1e293b!important;}',
  ].join('\\n');
  document.head.appendChild(_ltStyle);

  // ── Light-theme inline style rewriter ──────────────────────────────────────
  // Maps dark hex colors → light equivalents for inline style="" attributes.
  var bgMap = {
    '#080c14':'#f4f6f9','#040c18':'#f4f6f9','#030b18':'#f4f6f9',
    '#0d1320':'#ffffff','#07111f':'#ffffff','#070d18':'#f8fafc',
    '#0a0f1c':'#f1f5f9','#06101a':'#ffffff','#0a1528':'#f8fafc',
    '#08091a':'#ffffff','#0d1117':'#ffffff','#090f09':'#ffffff',
    '#0c0c18':'#f8fafc','#0a0a12':'#f8fafc','#0e0e1e':'#f1f5f9',
    '#0a0f14':'#f8fafc','#060910':'#f4f6f9','#040c18':'#f4f6f9',
    '#0a0e18':'#f8fafc','#060c18':'#f4f6f9','#04060e':'#f4f6f9',
    '#050d1a':'#f4f6f9','#060810':'#f4f6f9','#060c1a':'#f4f6f9',
    '#080e1a':'#f8fafc','#0a1220':'#f8fafc','#0a1424':'#f8fafc',
    '#0a1a2a':'#f8fafc','#0d1726':'#f8fafc','#0f1117':'#ffffff',
    '#0f172a':'#f8fafc','#111827':'#f8fafc','#04090f':'#f4f6f9',
    '#06090e':'#f4f6f9','#060a14':'#f4f6f9','#0a120a':'#f4f6f9',
    '#0d0e00':'#fffbeb','#080700':'#fffbeb','#1a1200':'#fffbeb',
    '#1c1400':'#fffbeb','#1c0d00':'#fffbeb','#120e00':'#fffbeb',
    '#1a1a2e':'#f1f5f9','#1a1f2e':'#f1f5f9','#0e1828':'#f1f5f9',
    '#0e1a28':'#f1f5f9','#0a0c1a':'#f8fafc','#0a0d1a':'#f8fafc','#080a16':'#f1f5f9',
    // Green-tinted dark backgrounds → light green
    '#071a12':'#f0fdf4','#04100a':'#f0fdf4','#071e0f':'#f0fdf4',
    '#072014':'#f0fdf4','#060e06':'#f0fdf4','#0a1f0a':'#f0fdf4',
    '#0a2a0a':'#f0fdf4','#0a3018':'#dcfce7','#0d3018':'#dcfce7',
    '#0d3020':'#dcfce7','#0d3a18':'#dcfce7','#06180e':'#dcfce7',
    '#0d2a14':'#dcfce7','#06100e':'#f0fdf4','#134e35':'#dcfce7',
    '#064e3b':'#d1fae5','#065f46':'#d1fae5','#166534':'#bbf7d0',
    // Blue-tinted dark backgrounds → light blue
    '#07112e':'#eff6ff','#071428':'#eff6ff','#0a1e3d':'#dbeafe',
    '#0d2040':'#dbeafe','#0e2850':'#dbeafe','#0e2860':'#dbeafe',
    '#071a3e':'#dbeafe','#1d3b6e':'#dbeafe','#1e40af':'#2563eb',
    '#0e2045':'#dbeafe',
    // Red-tinted dark backgrounds → light red
    '#100408':'#fef2f2','#0a0408':'#fef2f2','#0c0608':'#fef2f2',
    '#120608':'#fef2f2','#150608':'#fef2f2','#160608':'#fef2f2',
    '#180508':'#fef2f2','#100508':'#fef2f2','#200708':'#fef2f2',
    '#200810':'#fef2f2','#1c0610':'#fee2e2','#2d0a0a':'#fee2e2',
    '#3a0f1c':'#fecaca','#3a1010':'#fecaca','#3a1020':'#fecaca',
    '#1a0505':'#fef2f2','#1a0508':'#fef2f2','#1a0707':'#fef2f2',
    '#2a0810':'#fef2f2','#2d1515':'#fee2e2','#3a1a1a':'#fee2e2',
    '#3b0a0a':'#fee2e2','#1c1017':'#fef2f2',
    // Orange/yellow dark backgrounds → light amber
    '#2a1600':'#fffbeb','#2d1600':'#fffbeb','#2d1800':'#fffbeb',
    '#2d1000':'#fffbeb','#3a2a00':'#fef9c3',
    // Purple-tinted dark → light purple
    '#0e0a28':'#f5f3ff','#1e0a3d':'#f5f3ff','#1e1550':'#ede9fe',
    '#252550':'#ede9fe','#060e20':'#eff6ff','#060e1c':'#eff6ff',
  };

  var textMap = {
    '#e0eaf8':'#1e293b','#c8d8f0':'#334155','#c0d8b0':'#1e293b',
    '#4a6080':'#64748b','#3a5070':'#94a3b8','#2a4060':'#94a3b8',
    '#1e3050':'#94a3b8','#1a3050':'#94a3b8','#3a5878':'#64748b',
    '#6a8ab0':'#64748b','#a0c0e0':'#334155','#8aa1bd':'#64748b',
    '#2a3a20':'#64748b','#2a3a50':'#94a3b8','#2a3a52':'#94a3b8',
    '#3a4060':'#94a3b8','#4a5878':'#94a3b8','#2a6080':'#64748b',
    '#1e2940':'#64748b','#1e2a40':'#64748b','#a0b8d8':'#334155','#2a3c5a':'#64748b',
    '#c0d8b0':'#1e293b','#a0c880':'#16a34a','#2a3a20':'#64748b','#e2e8f0':'#1e293b',
    // Bright colors → darker for light bg
    '#60a5fa':'#2563eb','#34d399':'#059669','#f87171':'#dc2626',
    '#fbbf24':'#d97706','#a78bfa':'#7c3aed','#4ade80':'#16a34a',
    '#818cf8':'#6366f1','#f6ad55':'#ea580c','#fbd38d':'#d97706',
  };

  var borderMap = {
    '#0e1e36':'#e0e4ea','#1a2236':'#e0e4ea','#1a2a40':'#e0e4ea',
    '#0e1428':'#e0e4ea','#1a2640':'#e0e4ea','#1e1e36':'#e2e8f0',
    '#1a3a6a':'#bfdbfe','#1e3a5a':'#cbd5e1','#1e3a5f':'#cbd5e1',
    '#1a3a8a':'#93c5fd','#162416':'#d1fae5','#0e3018':'#86efac',
    '#0e4020':'#86efac','#134e35':'#86efac','#0e2850':'#93c5fd',
    '#0e2860':'#93c5fd','#0e2045':'#93c5fd','#0d2545':'#93c5fd',
    '#0d3a1e':'#86efac','#500e20':'#fca5a5','#3a0f1c':'#fca5a5',
    '#3a1020':'#fca5a5','#5a1010':'#fca5a5','#3a0d12':'#fca5a5',
    '#243048':'#cbd5e1','#253347':'#334155','#2a2a48':'#e2e8f0',
    '#1a2a18':'#d1fae5','#1a2a3a':'#e0e4ea','#1a4080':'#93c5fd',
    '#312e0f':'#fcd34d','#2a3446':'#e0e4ea',
  };

  function rewriteInlineStyles() {
    var els = document.querySelectorAll('[style]');
    for (var i = 0; i < els.length; i++) {
      var s = els[i].getAttribute('style');
      if (!s) continue;
      var orig = s;
      // Replace backgrounds
      s = s.replace(/background\s*:\s*(#[0-9a-fA-F]{6})/gi, function(m, hex) {
        var l = hex.toLowerCase();
        return bgMap[l] ? 'background:' + bgMap[l] : m;
      });
      // Replace text colors (not border-color)
      s = s.replace(/(^|[;}\s])color\s*:\s*(#[0-9a-fA-F]{6})/gi, function(m, pre, hex) {
        var l = hex.toLowerCase();
        return textMap[l] ? pre + 'color:' + textMap[l] : m;
      });
      // Replace border colors
      s = s.replace(/border[^:]*:\s*[^;]*?(#[0-9a-fA-F]{6})/gi, function(m, hex) {
        var l = hex.toLowerCase();
        return borderMap[l] ? m.replace(hex, borderMap[l]) : m;
      });
      if (s !== orig) els[i].setAttribute('style', s);
    }
  }

  // Run after DOM ready + observe dynamic content
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rewriteInlineStyles);
  } else {
    rewriteInlineStyles();
  }
  // Re-run on dynamic content changes (socket updates, etc.)
  var _ltObs = new MutationObserver(function(mutations) {
    var needsRewrite = false;
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].type === 'childList' && mutations[i].addedNodes.length) {
        needsRewrite = true; break;
      }
    }
    if (needsRewrite) rewriteInlineStyles();
  });
  _ltObs.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
`;
}

/**
 * Styled error page — shared across all trade route files.
 * @param {string} title — error title
 * @param {string} message — error description
 * @param {string} linkHref — back-link URL
 * @param {string} linkText — back-link label
 * @param {string} sidebarKey — active sidebar page key (e.g. 'scalpLive')
 */
function errorPage(title, message, linkHref, linkText, sidebarKey) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
${sidebarCSS()}
*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'IBM Plex Sans',sans-serif;background:#060810;color:#a0b8d8;min-height:100vh;display:flex;flex-direction:column;}
.main-content{flex:1;padding:40px 32px;margin-left:220px;display:flex;align-items:center;justify-content:center;}
@media(max-width:900px){.main-content{margin-left:0;}}
.err-box{background:#0d1320;border:1px solid #7f1d1d;border-radius:14px;padding:40px 48px;max-width:480px;text-align:center;}
.err-icon{font-size:2.5rem;margin-bottom:16px;}
.err-title{color:#ef4444;margin-bottom:12px;font-size:1.1rem;font-weight:700;}
.err-msg{font-size:0.85rem;color:#8899aa;margin-bottom:24px;line-height:1.6;}
.err-link{background:#1e40af;color:#fff;padding:9px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.85rem;display:inline-block;}
.err-link:hover{background:#2563eb;}
</style></head><body>
<div class="app-shell">
${buildSidebar(sidebarKey || 'dashboard', false)}
<div class="main-content">
<div class="err-box">
<div class="err-icon">\u{1F6AB}</div>
<h2 class="err-title">${title}</h2>
<p class="err-msg">${message}</p>
${linkHref ? `<a href="${linkHref}" class="err-link">${linkText || 'Go Back'}</a>` : ''}
</div></div></div></body></html>`;
}

module.exports = { buildSidebar, sidebarCSS, toastJS, logViewerHTML, faviconLink, modalCSS, modalJS, errorPage };

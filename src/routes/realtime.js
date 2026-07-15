/**
 * realtime.js — Unified real-time monitor for PAPER or LIVE trades
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only single screen that shows current state for every strategy that is
 * enabled in Settings (EMA_RSI_ST / BB_RSI / PA / ORB), side-by-side,
 * with a common rollup P&L table below. Toggle at the top switches between
 * PAPER and LIVE data sources. The page polls each strategy's existing
 * /status/data endpoint every 4s — no new backend aggregation; we read from
 * the same source the dedicated pages already use.
 *
 * The strategy list is gated by {STRATEGY}_MODE_ENABLED (Settings → Menu
 * Visibility). Field-shape differences between strategies are normalised in
 * the client (ORB returns `livePnl`/`tradesTaken`).
 */

const express = require("express");
const router  = express.Router();
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");

// hasDayLog: only strategies that expose /download/{trades,skips}/:date show
// the Copy Day Log button. ORB paper exposes cumulative JSONL only.
const STRATEGY_DEFS = [
  { key:'EMA_RSI_ST',    label:'EMA_RSI_ST',        accentClass:'ema_rsi_st',    accent:'#3b82f6', paperPrefix:'/ema_rsi_st-paper',    livePrefix:'/ema_rsi_st-live',    hasDayLog:true,  modeFlag:'EMA_RSI_ST_MODE_ENABLED'    },
  { key:'BB_RSI',    label:'BB_RSI',        accentClass:'bb_rsi',    accent:'#f59e0b', paperPrefix:'/bb_rsi-paper',    livePrefix:'/bb_rsi-live',    hasDayLog:true,  modeFlag:'BB_RSI_MODE_ENABLED'    },
  { key:'PA',       label:'PRICE ACTION', accentClass:'pa',       accent:'#a855f7', paperPrefix:'/pa-paper',       livePrefix:'/pa-live',       hasDayLog:true,  modeFlag:'PA_MODE_ENABLED'       },
  { key:'ORB',      label:'ORB',          accentClass:'orb',      accent:'#10b981', paperPrefix:'/orb-paper',      livePrefix:'/orb-live',      hasDayLog:false, modeFlag:'ORB_MODE_ENABLED'      },
  { key:'EMA9VWAP', label:'EMA9+VWAP',    accentClass:'ema9vwap', accent:'#06b6d4', paperPrefix:'/ema9vwap-paper', livePrefix:'/ema9vwap-live', hasDayLog:true,  modeFlag:'EMA9VWAP_MODE_ENABLED' },
  { key:'TREND_PB', label:'TREND PB',     accentClass:'trendpb',  accent:'#ec4899', paperPrefix:'/trend-pb-paper', livePrefix:'/trend-pb-live', hasDayLog:false, modeFlag:'TREND_PB_MODE_ENABLED' },
];

function enabledStrategies() {
  return STRATEGY_DEFS.filter(s => (process.env[s.modeFlag] || 'true').toLowerCase() !== 'false');
}

// Broker investment pools: each strategy's paper P&L draws from one shared pool.
// EMA_RSI_ST trades through Zerodha; BB_RSI/PA/ORB through Fyers.
const BROKER_OF = { EMA_RSI_ST:'ZERODHA', BB_RSI:'FYERS', PA:'FYERS', ORB:'FYERS', EMA9VWAP:'ZERODHA', TREND_PB:'FYERS' };
function brokerPools(strategies) {
  const z = parseFloat(process.env.ZERODHA_INV_AMOUNT || '100000');
  const f = parseFloat(process.env.FYERS_INV_AMOUNT   || '100000');
  const pools = [];
  if (strategies.some(s => BROKER_OF[s.key] === 'ZERODHA'))
    pools.push({ id:'ZERODHA', label:'ZERODHA', sub:'EMA_RSI_ST · EMA9+VWAP', inv:z });
  if (strategies.some(s => BROKER_OF[s.key] === 'FYERS'))
    pools.push({ id:'FYERS', label:'FYERS', sub:'BB_RSI · PA · ORB · TREND PB', inv:f });
  return pools;
}

router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  res.send(renderPage({ liveActive, sidebarKey: "dashboard", autoFlipBack: false }));
});

function renderPage({ liveActive, sidebarKey = "realtime", autoFlipBack = false } = {}) {
  const sidebar = buildSidebar(sidebarKey, liveActive);
  const strategies = enabledStrategies();
  // Hide the broker-balance ribbon while any session is running — mirrors the
  // dashboard convention of hiding broker cards mid-trade so they can't distract.
  const sessionActive = sharedSocketState.isAnyActive();

  const endpointsJson = JSON.stringify({
    PAPER: Object.fromEntries(strategies.map(s => [s.key, s.paperPrefix + '/status/data'])),
    LIVE:  Object.fromEntries(strategies.map(s => [s.key, s.livePrefix  + '/status/data'])),
  });
  const statusPagesJson = JSON.stringify({
    PAPER: Object.fromEntries(strategies.map(s => [s.key, s.paperPrefix + '/status'])),
    LIVE:  Object.fromEntries(strategies.map(s => [s.key, s.livePrefix  + '/status'])),
  });
  const labelsJson      = JSON.stringify(Object.fromEntries(strategies.map(s => [s.key, s.label])));
  const dayLogPrefixes  = JSON.stringify(Object.fromEntries(strategies.filter(s => s.hasDayLog).map(s => [s.key, s.paperPrefix])));
  const strategyOrder   = JSON.stringify(strategies.map(s => s.key));

  const pools           = brokerPools(strategies);
  const poolsJson       = JSON.stringify(pools);
  const brokerOfJson    = JSON.stringify(BROKER_OF);
  const inrFmt = n => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const walletsHtml = pools.map(p => `
    <div class="wallet" id="wallet-${p.id}">
      <div class="w-head"><span class="w-broker">${p.label}</span><span class="w-sub">${p.sub}</span></div>
      <div class="w-remain" id="wallet-remain-${p.id}">${inrFmt(p.inv)}</div>
      <div class="w-meta"><span>Invested ${inrFmt(p.inv)}</span><span class="w-delta" id="wallet-delta-${p.id}">—</span></div>
    </div>`).join('\n');

  const cardsHtml = strategies.map(s => `
    <div class="card ${s.accentClass}" id="card-${s.key}">
      <div class="card-header">
        <div class="card-title">${s.label}</div>
        <div class="badge stop" id="badge-${s.key}">—</div>
      </div>
      <div id="body-${s.key}"><div class="flat-block">Loading…</div></div>
      <div class="activity" id="activity-${s.key}"><div class="empty">Waiting for activity…</div></div>
      <div class="stats-row" id="stats-${s.key}"></div>
      <div class="footer-meta" id="meta-${s.key}"><span>—</span><span>—</span></div>
      <div class="actions">
        ${s.hasDayLog
          ? `<button type="button" class="act-btn" id="copy-${s.key}" onclick="copyDayLog('${s.key}', this)">📋 Copy Day Log</button>`
          : `<span class="act-btn act-btn-disabled" title="Per-date JSONL not exposed for this strategy">— No Day Log —</span>`}
        <a class="act-btn" id="open-${s.key}" href="${s.paperPrefix}/status">Open Status →</a>
      </div>
    </div>`).join('\n');

  const rollupRowsHtml = strategies.map(s =>
    `<tr class="${s.accentClass}" data-key="${s.key}"><td>${s.label}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`
  ).join('\n      ') + `\n      <tr class="total"><td>TOTAL</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Real-Time Monitor</title>
${faviconLink()}
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
  ${sidebarCSS()}
  body { margin:0; background:#040c18; color:#e0eaf8; font-family:'Segoe UI',-apple-system,sans-serif; }
  .main-content { padding:20px 24px; }
  .top-bar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:16px; flex-wrap:wrap; }
  .top-bar h1 { margin:0; font-size:1.4rem; font-weight:600; letter-spacing:0.2px; }
  .top-bar .sub { color:#7d8aa3; font-size:0.78rem; margin-top:2px; }
  .toggle { display:inline-flex; background:#0a1628; border:1px solid #1c2c47; border-radius:8px; padding:3px; }
  .toggle button { background:transparent; border:none; color:#9aa9c2; font-size:0.82rem; font-weight:600; padding:7px 18px; border-radius:6px; cursor:pointer; transition:all 0.15s; letter-spacing:0.5px; }
  .toggle button.active[data-mode="PAPER"] { background:#3b82f6; color:#fff; }
  .toggle button.active[data-mode="LIVE"]  { background:#ef4444; color:#fff; }

  /* Broker investment-pool wallets */
  .wallets { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:14px; margin-bottom:18px; }
  .wallet { background:#0a1628; border:1px solid #1c2c47; border-left-width:4px; border-left-color:#3b82f6; border-radius:10px; padding:12px 16px; }
  .wallet#wallet-FYERS { border-left-color:#f59e0b; }
  .w-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
  .w-broker { font-size:0.95rem; font-weight:700; letter-spacing:0.6px; color:#cbd5e1; }
  .w-sub { font-size:0.66rem; color:#7d8aa3; text-transform:uppercase; letter-spacing:0.4px; }
  .w-remain { font-size:1.5rem; font-weight:700; line-height:1.2; margin-top:4px; font-variant-numeric:tabular-nums; }
  .w-meta { display:flex; justify-content:space-between; font-size:0.72rem; color:#7d8aa3; margin-top:4px; }
  .w-delta { font-variant-numeric:tabular-nums; font-weight:600; }

  .cols { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:14px; margin-bottom:18px; }

  .card { background:#0a1628; border:1px solid #1c2c47; border-top-width:3px; border-radius:10px; padding:14px 16px; min-height:280px; display:flex; flex-direction:column; gap:10px; min-width:0; }
  .card.ema_rsi_st    { border-top-color:#3b82f6; }
  .card.bb_rsi    { border-top-color:#f59e0b; }
  .card.pa       { border-top-color:#a855f7; }
  .card.orb      { border-top-color:#10b981; }
  .card.ema9vwap { border-top-color:#06b6d4; }
  .card.trendpb  { border-top-color:#ec4899; }

  .card-header { display:flex; align-items:center; justify-content:space-between; }
  .card-title { font-size:1rem; font-weight:600; letter-spacing:0.5px; }
  .card.ema_rsi_st    .card-title { color:#60a5fa; }
  .card.bb_rsi    .card-title { color:#fbbf24; }
  .card.pa       .card-title { color:#c084fc; }
  .card.orb      .card-title { color:#34d399; }
  .card.ema9vwap .card-title { color:#22d3ee; }
  .card.trendpb  .card-title { color:#f472b6; }

  .badge { font-size:0.66rem; padding:3px 8px; border-radius:4px; border:1px solid; font-weight:600; letter-spacing:0.4px; }
  .badge.run  { background:rgba(16,185,129,0.12); color:#10b981; border-color:rgba(16,185,129,0.35); }
  .badge.stop { background:rgba(148,163,184,0.10); color:#94a3b8; border-color:rgba(148,163,184,0.30); }
  .badge.err  { background:rgba(239,68,68,0.12);  color:#ef4444; border-color:rgba(239,68,68,0.35); }

  .pos-block, .flat-block { background:#040c18; border:1px solid #15243d; border-radius:8px; padding:10px 12px; }
  .pos-side { display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.72rem; font-weight:700; letter-spacing:0.5px; margin-right:6px; }
  .pos-side.CE { background:rgba(16,185,129,0.18); color:#10b981; }
  .pos-side.PE { background:rgba(239,68,68,0.18);  color:#ef4444; }
  .pos-symbol { font-size:0.78rem; color:#cbd5e1; word-break:break-all; }
  .pos-symbol-line { display:block; }

  .pnl-big { font-size:1.5rem; font-weight:700; line-height:1.1; margin-top:4px; }
  .pnl-big .pct { font-size:0.78rem; font-weight:500; color:#94a3b8; margin-left:6px; }
  .pos-grid { display:grid; grid-template-columns:1fr 1fr; gap:5px 12px; margin-top:8px; font-size:0.75rem; }
  .pos-grid .lbl { color:#7d8aa3; }
  .pos-grid .val { color:#e0eaf8; text-align:right; font-variant-numeric:tabular-nums; }

  .flat-block { text-align:center; color:#94a3b8; font-size:0.86rem; padding:18px 12px; }

  /* Recent activity mini-log */
  .activity { background:#040c18; border:1px solid #15243d; border-radius:6px; padding:6px 8px; font-family:'SF Mono','Menlo','Monaco',monospace; font-size:0.68rem; line-height:1.45; color:#9aa9c2; max-height:110px; overflow:hidden; min-width:0; }
  .activity .ahead { display:flex; justify-content:space-between; align-items:center; color:#7d8aa3; font-size:0.62rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; font-family:inherit; }
  .activity .arow { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .activity .empty { color:#5d6c87; font-style:italic; padding:6px 0; text-align:center; }

  .stats-row { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:auto; }
  .stat { background:#040c18; border:1px solid #15243d; border-radius:6px; padding:7px 8px; text-align:center; }
  .stat .lbl { font-size:0.62rem; color:#7d8aa3; text-transform:uppercase; letter-spacing:0.5px; }
  .stat .val { font-size:0.95rem; font-weight:700; margin-top:2px; font-variant-numeric:tabular-nums; }

  .pos-pos { color:#10b981 !important; }
  .pos-neg { color:#ef4444 !important; }
  .pos-zero { color:#94a3b8 !important; }

  .footer-meta { font-size:0.68rem; color:#5d6c87; display:flex; justify-content:space-between; padding-top:6px; border-top:1px solid #15243d; }

  .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:6px; }
  .act-btn { display:inline-flex; align-items:center; justify-content:center; background:#040c18; border:1px solid #1c2c47; color:#cbd5e1; font-size:0.74rem; font-weight:600; padding:8px 10px; border-radius:6px; cursor:pointer; text-align:center; text-decoration:none; transition:all 0.15s; letter-spacing:0.3px; line-height:1.2; font-family:inherit; }
  .act-btn:hover { background:#0e1c33; border-color:#3b82f6; color:#fff; }
  .act-btn.copied { background:rgba(16,185,129,0.18); border-color:#10b981; color:#10b981; }
  .act-btn-disabled { background:#040c18; border-style:dashed; color:#5d6c87; cursor:default; }
  .act-btn-disabled:hover { background:#040c18; color:#5d6c87; border-color:#1c2c47; }
  .card.ema_rsi_st    .act-btn:not(.act-btn-disabled):hover { border-color:#3b82f6; }
  .card.bb_rsi    .act-btn:not(.act-btn-disabled):hover { border-color:#f59e0b; }
  .card.pa       .act-btn:not(.act-btn-disabled):hover { border-color:#a855f7; }
  .card.orb      .act-btn:not(.act-btn-disabled):hover { border-color:#10b981; }
  .card.ema9vwap .act-btn:not(.act-btn-disabled):hover { border-color:#06b6d4; }
  .card.trendpb  .act-btn:not(.act-btn-disabled):hover { border-color:#ec4899; }

  /* Rollup table */
  .rollup { width:100%; border-collapse:collapse; background:#0a1628; border:1px solid #1c2c47; border-radius:10px; overflow:hidden; }
  .rollup th { background:#0e1c33; color:#9aa9c2; font-size:0.72rem; font-weight:600; letter-spacing:0.5px; padding:10px 12px; text-align:right; border-bottom:1px solid #1c2c47; }
  .rollup th:first-child { text-align:left; }
  .rollup td { padding:10px 12px; font-size:0.85rem; text-align:right; border-bottom:1px solid #15243d; font-variant-numeric:tabular-nums; }
  .rollup td:first-child { text-align:left; font-weight:600; }
  .rollup tr:last-child td { border-bottom:none; background:#0e1c33; font-weight:700; }
  .rollup tr.ema_rsi_st    td:first-child { color:#60a5fa; }
  .rollup tr.bb_rsi    td:first-child { color:#fbbf24; }
  .rollup tr.pa       td:first-child { color:#c084fc; }
  .rollup tr.orb      td:first-child { color:#34d399; }
  .rollup tr.ema9vwap td:first-child { color:#22d3ee; }
  .rollup tr.trendpb  td:first-child { color:#f472b6; }
  .rollup tr.total    td:first-child { color:#e0eaf8; }

  .pulse { display:inline-block; width:7px; height:7px; border-radius:50%; background:#10b981; margin-left:6px; animation:pulse 1.5s ease-in-out infinite; vertical-align:middle; }
  @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }

  /* ── Light-theme overrides ── */
  :root[data-theme="light"] .top-bar h1 { color:#1e293b; }
  :root[data-theme="light"] .top-bar .sub { color:#64748b; }
  :root[data-theme="light"] .toggle { background:#fff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  :root[data-theme="light"] .toggle button { color:#64748b; }
  :root[data-theme="light"] .card { background:#fff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  :root[data-theme="light"] .card.ema_rsi_st    .card-title { color:#2563eb; }
  :root[data-theme="light"] .card.bb_rsi    .card-title { color:#d97706; }
  :root[data-theme="light"] .card.pa       .card-title { color:#9333ea; }
  :root[data-theme="light"] .card.orb      .card-title { color:#059669; }
  :root[data-theme="light"] .card.ema9vwap .card-title { color:#0891b2; }
  :root[data-theme="light"] .card.trendpb  .card-title { color:#db2777; }
  :root[data-theme="light"] .pos-block,
  :root[data-theme="light"] .flat-block { background:#f8fafc !important; border-color:#e0e4ea !important; }
  :root[data-theme="light"] .flat-block { color:#64748b; }
  :root[data-theme="light"] .pos-symbol { color:#475569; }
  :root[data-theme="light"] .pos-grid .lbl { color:#64748b; }
  :root[data-theme="light"] .pos-grid .val { color:#1e293b; }
  :root[data-theme="light"] .activity { background:#f8fafc !important; border-color:#e0e4ea !important; color:#475569; }
  :root[data-theme="light"] .activity .ahead { color:#94a3b8; }
  :root[data-theme="light"] .activity .empty { color:#94a3b8; }
  :root[data-theme="light"] .stat { background:#f8fafc !important; border-color:#e0e4ea !important; }
  :root[data-theme="light"] .stat .lbl { color:#64748b; }
  :root[data-theme="light"] .stat .val { color:#1e293b; }
  :root[data-theme="light"] .footer-meta { color:#94a3b8; border-top-color:#e0e4ea; }
  :root[data-theme="light"] .rollup { background:#fff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  :root[data-theme="light"] .rollup th { background:#f1f5f9 !important; color:#64748b !important; border-bottom-color:#e0e4ea !important; }
  :root[data-theme="light"] .rollup td { color:#334155; border-bottom-color:#e0e4ea; }
  :root[data-theme="light"] .rollup tr:last-child td { background:#f8fafc !important; color:#1e293b; }
  :root[data-theme="light"] .rollup tr.ema_rsi_st    td:first-child { color:#2563eb; }
  :root[data-theme="light"] .rollup tr.bb_rsi    td:first-child { color:#d97706; }
  :root[data-theme="light"] .rollup tr.pa       td:first-child { color:#9333ea; }
  :root[data-theme="light"] .rollup tr.orb      td:first-child { color:#059669; }
  :root[data-theme="light"] .rollup tr.ema9vwap td:first-child { color:#0891b2; }
  :root[data-theme="light"] .rollup tr.trendpb  td:first-child { color:#db2777; }
  :root[data-theme="light"] .pos-zero { color:#64748b !important; }
  :root[data-theme="light"] .pos-pos  { color:#059669 !important; }
  :root[data-theme="light"] .pos-neg  { color:#dc2626 !important; }
  :root[data-theme="light"] .act-btn { background:#f8fafc !important; border-color:#e0e4ea !important; color:#475569; }
  :root[data-theme="light"] .act-btn:hover { background:#fff !important; color:#1e293b; }
  :root[data-theme="light"] .act-btn.copied { background:rgba(16,185,129,0.10) !important; border-color:#10b981 !important; color:#059669; }
  :root[data-theme="light"] .act-btn-disabled { color:#94a3b8 !important; }
  :root[data-theme="light"] .wallet { background:#fff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  :root[data-theme="light"] .w-broker { color:#1e293b; }
  :root[data-theme="light"] .w-sub { color:#94a3b8; }
  :root[data-theme="light"] .w-meta { color:#64748b; }
</style>
</head>
<body>
${sidebar}
<main class="main-content">
  <div class="top-bar">
    <div>
      <h1>📡 Real-Time Monitor</h1>
      <div class="sub">Live view of all enabled strategies — polls every 4s <span id="pulse" class="pulse"></span></div>
    </div>
    ${!sessionActive ? `<div class="toggle" id="mode-toggle">
      <button data-mode="PAPER" class="active">PAPER</button>
      <button data-mode="LIVE">LIVE</button>
    </div>` : ''}
  </div>

  ${(pools.length && !sessionActive) ? `<div class="wallets">\n${walletsHtml}\n  </div>` : ''}

  <div class="cols">
${cardsHtml}
  </div>

  <table class="rollup">
    <thead>
      <tr>
        <th>Strategy</th>
        <th>Status</th>
        <th>Open P&amp;L</th>
        <th>Closed P&amp;L (Today)</th>
        <th>Trades</th>
        <th>W / L</th>
        <th>Today Total (Open + Closed)</th>
      </tr>
    </thead>
    <tbody id="rollup-body">
      ${rollupRowsHtml}
    </tbody>
  </table>
</main>

<script>
const STRATEGY_KEYS    = ${strategyOrder};
const ENDPOINTS        = ${endpointsJson};
const STATUS_PAGES     = ${statusPagesJson};
const STRATEGY_LABELS  = ${labelsJson};
const JSONL_PREFIX     = ${dayLogPrefixes};
const WALLET_POOLS     = ${poolsJson};
const BROKER_OF        = ${brokerOfJson};
let mode = 'PAPER';
let timer = null;

function updateOpenLinks() {
  const pages = STATUS_PAGES[mode];
  for (const k of STRATEGY_KEYS) {
    const a = document.getElementById('open-' + k);
    if (a) a.href = pages[k];
  }
}

const fmtINR = n => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const v = Number(n);
  const sign = v < 0 ? '-' : '';
  return sign + '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
};
const fmtNum = n => (n === null || n === undefined || isNaN(n)) ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const cls = n => (n === null || n === undefined || isNaN(n) || +n === 0) ? 'pos-zero' : (+n > 0 ? 'pos-pos' : 'pos-neg');

// EMA_RSI_ST uses unrealisedPnl, BB_RSI/PA use unrealised, ORB uses livePnl.
function openPnl(d) {
  if (!d) return 0;
  const v = (d.unrealisedPnl !== undefined ? d.unrealisedPnl
          : d.unrealised   !== undefined ? d.unrealised
          : d.livePnl      !== undefined ? d.livePnl
          : 0);
  return v == null ? 0 : v;
}
// EMA_RSI_ST/BB_RSI/PA: tradeCount. ORB: tradesTaken.
function tradeCountOf(d) {
  if (!d) return 0;
  return d.tradeCount ?? d.tradesTaken ?? 0;
}
// EMA_RSI_ST/BB_RSI/PA: logs[] + logTotal. ORB: log[] (strings only).
function logsOf(d) {
  if (!d) return { lines: [], total: 0 };
  if (Array.isArray(d.logs)) return { lines: d.logs, total: d.logTotal ?? d.logs.length };
  if (Array.isArray(d.log))  return { lines: d.log,  total: d.log.length };
  return { lines: [], total: 0 };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderActivity(strategy, d) {
  const el = document.getElementById('activity-' + strategy);
  if (!el) return;
  const { lines, total } = logsOf(d);
  if (!lines.length) {
    el.innerHTML = '<div class="empty">' + (d ? 'Waiting for activity…' : 'No data') + '</div>';
    return;
  }
  const head = lines.slice(0, 5);
  let html = '<div class="ahead"><span>Recent activity</span><span>' + total + ' entries</span></div>';
  for (const line of head) html += '<div class="arow">' + escapeHtml(line) + '</div>';
  el.innerHTML = html;
}

function renderPositionStandard(d, pos) {
  const upnl = openPnl(d);
  const entryPrice = pos.entryPrice ?? pos.entrySpot ?? null;
  const optionEntry = pos.optionEntryLtp ?? null;
  const optionCurrent = pos.optionCurrentLtp ?? pos.currentOptLtp ?? null;
  const stopLoss = pos.stopLoss ?? pos.slSpot ?? null;
  const liveClose = pos.liveClose ?? d.lastTickPrice ?? null;
  const sideMult = pos.side === 'CE' ? 1 : (pos.side === 'PE' ? -1 : 0);
  const pointsMoved = pos.pointsMoved != null
    ? pos.pointsMoved
    : (liveClose != null && entryPrice != null && sideMult ? (liveClose - entryPrice) * sideMult : null);
  const pct = pos.optPremiumPct != null
    ? pos.optPremiumPct
    : (optionEntry && optionCurrent ? ((optionCurrent - optionEntry) / optionEntry) * 100 : null);
  const sideClass = pos.side === 'CE' || pos.side === 'PE' ? pos.side : '';
  return \`
    <div class="pos-block">
      <div>
        <span class="pos-side \${sideClass}">\${pos.side || ''}</span>
        <span class="pos-symbol">\${pos.symbol || ''}</span>
      </div>
      <div class="pnl-big \${cls(upnl)}">\${fmtINR(upnl)}\${pct !== null ? '<span class="pct">' + (pct >= 0 ? '+' : '') + Number(pct).toFixed(2) + '%</span>' : ''}</div>
      <div class="pos-grid">
        <div class="lbl">Qty</div><div class="val">\${pos.qty ?? '—'}</div>
        <div class="lbl">Entry Spot</div><div class="val">\${fmtNum(entryPrice)}</div>
        <div class="lbl">Entry Opt</div><div class="val">\${fmtNum(optionEntry)}</div>
        <div class="lbl">Curr Opt</div><div class="val">\${fmtNum(optionCurrent)}</div>
        <div class="lbl">Live Spot</div><div class="val">\${fmtNum(liveClose)}</div>
        <div class="lbl">Pts Moved</div><div class="val \${cls(pointsMoved)}">\${fmtNum(pointsMoved)}</div>
        <div class="lbl">Stop Loss</div><div class="val">\${fmtNum(stopLoss)}</div>
        <div class="lbl">Entry Time</div><div class="val">\${pos.entryTime || '—'}</div>
      </div>
    </div>\`;
}

function renderColumn(strategy, d) {
  const badgeEl = document.getElementById('badge-' + strategy);
  const bodyEl  = document.getElementById('body-' + strategy);
  const statsEl = document.getElementById('stats-' + strategy);
  const metaEl  = document.getElementById('meta-' + strategy);

  renderActivity(strategy, d);

  if (!d) {
    badgeEl.className = 'badge err'; badgeEl.textContent = 'OFFLINE';
    bodyEl.innerHTML = '<div class="flat-block">Endpoint unavailable</div>';
    statsEl.innerHTML = '';
    metaEl.innerHTML = '<span>—</span><span>—</span>';
    return;
  }

  badgeEl.className = 'badge ' + (d.running ? 'run' : 'stop');
  badgeEl.textContent = d.running ? 'RUNNING' : 'STOPPED';

  const pos = d.position;
  if (pos) {
    bodyEl.innerHTML = renderPositionStandard(d, pos);
  } else {
    bodyEl.innerHTML = \`<div class="flat-block">FLAT — no open position</div>\`;
  }

  const sessPnl = d.sessionPnl ?? 0;
  statsEl.innerHTML = \`
    <div class="stat"><div class="lbl">Trades</div><div class="val">\${tradeCountOf(d)}</div></div>
    <div class="stat"><div class="lbl">W / L</div><div class="val">\${d.wins ?? 0} / \${d.losses ?? 0}</div></div>
    <div class="stat"><div class="lbl">Session P&amp;L</div><div class="val \${cls(sessPnl)}">\${fmtINR(sessPnl)}</div></div>\`;

  const ltp = d.lastTickPrice ? fmtNum(d.lastTickPrice) : '—';
  const tickTime = d.lastTickTime || '';
  metaEl.innerHTML = \`<span>LTP \${ltp}\${tickTime ? ' · ' + tickTime : ''}</span><span>\${d.tickCount ?? 0} ticks</span>\`;
}

function renderRollup(all) {
  let totalOpen = 0, totalClosed = 0, totalTrades = 0, totalW = 0, totalL = 0;
  let anyRunning = false, anyData = false;

  const tbody = document.getElementById('rollup-body');
  let html = '';
  for (const key of STRATEGY_KEYS) {
    const d = all[key];
    const accent = key.toLowerCase();
    const label = STRATEGY_LABELS[key];
    if (!d) {
      html += \`<tr class="\${accent}" data-key="\${key}"><td>\${label}</td><td>OFFLINE</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>\`;
      continue;
    }
    anyData = true;
    const open = +openPnl(d) || 0;
    const closed = +(d.sessionPnl ?? 0) || 0;
    const dayTotal = open + closed;
    const trades = tradeCountOf(d) || 0;
    const w = d.wins ?? 0;
    const l = d.losses ?? 0;
    if (d.running) anyRunning = true;
    totalOpen += open;
    totalClosed += closed;
    totalTrades += +trades || 0;
    totalW += +w || 0;
    totalL += +l || 0;
    html += \`<tr class="\${accent}" data-key="\${key}">
      <td>\${label}</td>
      <td>\${d.running ? 'RUNNING' : 'STOPPED'}</td>
      <td class="\${cls(open)}">\${fmtINR(open)}</td>
      <td class="\${cls(closed)}">\${fmtINR(closed)}</td>
      <td>\${trades}</td>
      <td>\${w} / \${l}</td>
      <td class="\${cls(dayTotal)}">\${fmtINR(dayTotal)}</td>
    </tr>\`;
  }
  const grandDayTotal = totalOpen + totalClosed;
  html += \`<tr class="total">
    <td>TOTAL</td>
    <td>\${anyData ? (anyRunning ? 'RUNNING' : 'STOPPED') : '—'}</td>
    <td class="\${cls(totalOpen)}">\${fmtINR(totalOpen)}</td>
    <td class="\${cls(totalClosed)}">\${fmtINR(totalClosed)}</td>
    <td>\${totalTrades}</td>
    <td>\${totalW} / \${totalL}</td>
    <td class="\${cls(grandDayTotal)}">\${fmtINR(grandDayTotal)}</td>
  </tr>\`;
  tbody.innerHTML = html;
}

// Broker wallet = investment pool + all-time P&L of every strategy on that broker.
// totalPnl is exposed by each /status/data; fall back to (capital - inv) when absent.
function renderWallets(all) {
  for (const p of WALLET_POOLS) {
    let pnl = 0;
    for (const k of STRATEGY_KEYS) {
      if (BROKER_OF[k] !== p.id) continue;
      const d = all[k];
      if (!d) continue;
      const tp = (d.totalPnl !== undefined && d.totalPnl !== null) ? +d.totalPnl
               : (d.capital  !== undefined && d.capital  !== null) ? (+d.capital - p.inv)
               : 0;
      pnl += (+tp || 0);
    }
    const remain = p.inv + pnl;
    const remEl = document.getElementById('wallet-remain-' + p.id);
    const dEl   = document.getElementById('wallet-delta-' + p.id);
    if (remEl) { remEl.textContent = fmtINR(remain); remEl.className = 'w-remain ' + cls(pnl); }
    if (dEl)   { dEl.textContent = (pnl >= 0 ? '▲ ' : '▼ ') + fmtINR(Math.abs(pnl)); dEl.className = 'w-delta ' + cls(pnl); }
  }
}

async function poll() {
  const eps = ENDPOINTS[mode];
  const fetchOne = url => fetch(url, { cache:'no-store' })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
  const results = await Promise.all(STRATEGY_KEYS.map(k => fetchOne(eps[k])));
  const all = {};
  STRATEGY_KEYS.forEach((k, i) => { all[k] = results[i]; renderColumn(k, results[i]); });
  renderRollup(all);
  renderWallets(all);
}

document.querySelectorAll('#mode-toggle button').forEach(b => {
  b.addEventListener('click', () => {
    if (b.classList.contains('active')) return;
    document.querySelectorAll('#mode-toggle button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    mode = b.dataset.mode;
    updateOpenLinks();
    poll();
  });
});

async function fetchText(url) {
  try {
    const r = await fetch(url, { cache:'no-store' });
    if (!r.ok) return { ok:false, status:r.status, text:'' };
    return { ok:true, status:200, text: await r.text() };
  } catch (e) {
    return { ok:false, status:0, text:'', err:String(e) };
  }
}

async function copyDayLog(strategy, btn) {
  const origLabel = btn.textContent;
  btn.textContent = 'Copying…';
  btn.disabled = true;

  // YYYY-MM-DD in IST (en-CA locale gives ISO date format)
  const istDate = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' });
  const prefix  = JSONL_PREFIX[strategy];

  const [tradesRes, skipsRes] = await Promise.all([
    fetchText(prefix + '/download/trades/' + istDate),
    fetchText(prefix + '/download/skips/'  + istDate),
  ]);

  const tradesText = tradesRes.ok ? tradesRes.text.trim() : '';
  const skipsText  = skipsRes.ok  ? skipsRes.text.trim()  : '';
  const tradeCount = tradesText ? tradesText.split(/\\r?\\n/).length : 0;
  const skipCount  = skipsText  ? skipsText.split(/\\r?\\n/).length  : 0;

  const out = [];
  out.push('# ' + STRATEGY_LABELS[strategy] + ' (' + mode + ') — ' + istDate);
  out.push('# entries: ' + tradeCount + '   skips: ' + skipCount);
  out.push('');
  out.push('=== ENTRY LOG (' + tradeCount + ' trades) ===');
  if (tradesText) {
    out.push(tradesText);
  } else {
    out.push('(no trades file for ' + istDate + (tradesRes.status === 404 ? ' — none today' : ' — http ' + tradesRes.status) + ')');
  }
  out.push('');
  out.push('=== SKIP LOG (' + skipCount + ' skips) ===');
  if (skipsText) {
    out.push(skipsText);
  } else {
    out.push('(no skips file for ' + istDate + (skipsRes.status === 404 ? ' — none today' : ' — http ' + skipsRes.status) + ')');
  }

  const text = out.join('\\n');
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    btn.textContent = '✓ ' + tradeCount + ' entries, ' + skipCount + ' skips';
  } catch (err) {
    console.error('clipboard write failed', err);
    btn.textContent = 'Copy failed';
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = origLabel; }, 2200);
  }
}

updateOpenLinks();
poll();
timer = setInterval(poll, 4000);

// When rendered at /, flip back to normal dashboard the moment no session is active.
const AUTO_FLIP_BACK = ${autoFlipBack ? "true" : "false"};
if (AUTO_FLIP_BACK) {
  setInterval(async () => {
    try {
      const r = await fetch('/api/session-active', { cache:'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.active === false) location.replace('/');
    } catch {}
  }, 5000);
}
</script>
</body>
</html>`;
}

module.exports = router;
module.exports.renderRealtimePage = renderPage;

/**
 * realtime.js — Unified real-time monitor for PAPER or LIVE trades
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only single screen that shows current state for every strategy that is
 * enabled in Settings (EMA_RSI_ST / BB_RSI / PA / ORB), side-by-side,
 * with a common rollup P&L table below. Toggle at the top switches between
 * PAPER and LIVE data sources. Every 4s the page polls each strategy's existing
 * /status/data endpoint — the same source the dedicated pages use — plus this
 * router's own /capital, the one piece that cannot come from a per-strategy
 * page because it is cross-strategy by nature (see utils/capitalPool.js). The
 * latter feeds the broker wallet ribbon and the shortfall alert banner; both
 * read that single response, so they can never disagree.
 *
 * The strategy list is gated by {STRATEGY}_MODE_ENABLED (Settings → Menu
 * Visibility). Field-shape differences between strategies are normalised in
 * the client (ORB returns `livePnl`/`tradesTaken`).
 */

const express = require("express");
const router  = express.Router();
const sharedSocketState = require("../utils/sharedSocketState");
// modalCSS/modalJS carry secretFetch + the API-secret prompt: /stop requires
// API_SECRET (only the read-only /status/data paths are in app.js OPEN_PATHS),
// so Stop All would 403 on every engine without them.
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { resolveTheme } = require("../utils/theme");

// hasDayLog: only strategies that expose /download/{trades,skips}/:date show
// the Copy Day Log button. TREND_PB still exposes cumulative JSONL only.
const STRATEGY_DEFS = [
  { key:'EMA_RSI_ST',    label:'EMA_RSI_ST',        accentClass:'ema_rsi_st',    accent:'#3b82f6', paperPrefix:'/ema_rsi_st-paper',    livePrefix:'/ema_rsi_st-live',    hasDayLog:true,  modeFlag:'EMA_RSI_ST_MODE_ENABLED'    },
  { key:'BB_RSI',    label:'BB_RSI',        accentClass:'bb_rsi',    accent:'#f59e0b', paperPrefix:'/bb_rsi-paper',    livePrefix:'/bb_rsi-live',    hasDayLog:true,  modeFlag:'BB_RSI_MODE_ENABLED'    },
  { key:'PA',       label:'PRICE ACTION', accentClass:'pa',       accent:'#a855f7', paperPrefix:'/pa-paper',       livePrefix:'/pa-live',       hasDayLog:true,  modeFlag:'PA_MODE_ENABLED'       },
  { key:'ORB',      label:'ORB',          accentClass:'orb',      accent:'#10b981', paperPrefix:'/orb-paper',      livePrefix:'/orb-live',      hasDayLog:true,  modeFlag:'ORB_MODE_ENABLED'      },
  { key:'EMA9VWAP', label:'EMA9+VWAP',    accentClass:'ema9vwap', accent:'#06b6d4', paperPrefix:'/ema9vwap-paper', livePrefix:'/ema9vwap-live', hasDayLog:true,  modeFlag:'EMA9VWAP_MODE_ENABLED' },
  { key:'TREND_PB', label:'TREND PB',     accentClass:'trendpb',  accent:'#ec4899', paperPrefix:'/trend-pb-paper', livePrefix:'/trend-pb-live', hasDayLog:false, modeFlag:'TREND_PB_MODE_ENABLED' },
  { key:'TDS',      label:'TREND DAY SCALP', accentClass:'tds',   accent:'#a855f7', paperPrefix:'/trend-day-scalp-paper', livePrefix:'/trend-day-scalp-live', hasDayLog:true, modeFlag:'TDS_MODE_ENABLED' },
  { key:'HA_SCALP', label:'HA SCALP',        accentClass:'hascalp', accent:'#f97316', paperPrefix:'/ha-scalp-paper',      livePrefix:'/ha-scalp-live',        hasDayLog:true, modeFlag:'HA_SCALP_MODE_ENABLED' },
  { key:'RSI_PIVOT_ST', label:'RSI PIVOT ST', accentClass:'rsipivotst', accent:'#facc15', paperPrefix:'/rsi-pivot-st-paper', livePrefix:'/rsi-pivot-st-live', hasDayLog:true, modeFlag:'RSI_PIVOT_ST_MODE_ENABLED' },
  { key:'SIMPLE930', label:'SIMPLE_9:30', accentClass:'simple930', accent:'#fb923c', paperPrefix:'/simple930-paper', livePrefix:'/simple930-live', hasDayLog:true, modeFlag:'SIMPLE930_MODE_ENABLED' },
];

function enabledStrategies() {
  return STRATEGY_DEFS.filter(s => (process.env[s.modeFlag] || 'true').toLowerCase() !== 'false');
}

// Broker investment pools: each strategy's paper P&L draws from one shared pool.
// EMA_RSI_ST trades through Zerodha; BB_RSI/PA/ORB through Fyers.
const BROKER_OF = { EMA_RSI_ST:'ZERODHA', BB_RSI:'FYERS', PA:'FYERS', ORB:'FYERS', EMA9VWAP:'ZERODHA', TREND_PB:'FYERS', TDS:'FYERS', HA_SCALP:'ZERODHA', RSI_PIVOT_ST:'ZERODHA', SIMPLE930:'ZERODHA' };
function brokerPools(strategies) {
  const z = parseFloat(process.env.ZERODHA_INV_AMOUNT || '100000');
  const f = parseFloat(process.env.FYERS_INV_AMOUNT   || '100000');
  const pools = [];
  if (strategies.some(s => BROKER_OF[s.key] === 'ZERODHA'))
    pools.push({ id:'ZERODHA', label:'ZERODHA', sub:'EMA_RSI_ST · EMA9+VWAP', inv:z });
  if (strategies.some(s => BROKER_OF[s.key] === 'FYERS'))
    pools.push({ id:'FYERS', label:'FYERS', sub:'BB_RSI · PA · ORB · TREND PB · TREND DAY SCALP', inv:f });
  return pools;
}

// Capital-pool poll — per-broker money and any entry the pool could not fund.
// Read-only; the alert banner is the only consumer.
router.get("/capital", (req, res) => {
  try {
    const capitalPool = require("../utils/capitalPool");
    res.json({
      enabled: capitalPool.isEnabled(),
      pools: capitalPool.snapshot(),
      alerts: capitalPool.getAlerts(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  res.send(renderPage({ liveActive, sidebarKey: "dashboard", autoFlipBack: false }));
});

function renderPage({ liveActive, sidebarKey = "realtime", autoFlipBack = false } = {}) {
  const sidebar = buildSidebar(sidebarKey, liveActive);
  const strategies = enabledStrategies();
  // Mid-session the PAPER/LIVE source toggle is hidden — the running session
  // decides the source, so letting it be switched would only mislead. (The
  // broker-balance ribbon used to be hidden here too; it now stays up, because
  // while trading is exactly when "how much is left" matters.)
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
  const accentsJson     = JSON.stringify(Object.fromEntries(strategies.map(s => [s.key, s.accentClass])));
  const dayLogPrefixes  = JSON.stringify(Object.fromEntries(strategies.filter(s => s.hasDayLog).map(s => [s.key, s.paperPrefix])));
  const strategyOrder   = JSON.stringify(strategies.map(s => s.key));
  // Stop-all hits BOTH prefixes for every strategy, regardless of which source
  // the PAPER/LIVE toggle is showing — "stop everything" has to mean everything,
  // or a live harness keeps trading because the page happened to be on PAPER.
  // statusUrl is probed first so the report can name what was ACTUALLY running:
  // most paper /stop handlers redirect unconditionally (their stopSession() is a
  // no-op when idle), so the HTTP response alone cannot tell running from idle.
  const stopUrlsJson    = JSON.stringify(strategies.map(s => ([
    { key: s.key, mode: 'PAPER', url: s.paperPrefix + '/stop', statusUrl: s.paperPrefix + '/status/data' },
    { key: s.key, mode: 'LIVE',  url: s.livePrefix  + '/stop', statusUrl: s.livePrefix  + '/status/data' },
  ])).flat());

  const pools           = brokerPools(strategies);
  const poolsJson       = JSON.stringify(pools);
  // Sign goes BEFORE the ₹, matching the client's fmtINR — otherwise an
  // overdrawn pool paints "₹-1,50,000" and jumps to "-₹1,50,000" on first poll.
  const inrFmt = n => (Number(n) < 0 ? '-' : '') + '₹' + Math.abs(Number(n)).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  // Seed the ribbon with the real pool so the first paint is already right —
  // otherwise a page opened with positions open shows the untouched investment
  // amount as "free to trade" until the first 4s poll corrects it.
  let poolSnap = {};
  try { poolSnap = require("../utils/capitalPool").snapshot(); } catch (_) {}
  // Mirrors the client's cls() — the first paint must carry the same colour the
  // poll would give it, or an overdrawn pool shows grey for the first 4 seconds.
  const clsOf = n => (n === null || n === undefined || isNaN(n) || +n === 0) ? 'pos-zero' : (+n > 0 ? 'pos-pos' : 'pos-neg');
  // Headline is FREE cash — the number that decides whether the next entry fits.
  // The pool's worth (investment + P&L) and what open positions hold sit below it.
  const walletsHtml = pools.map(p => {
    const q = poolSnap[p.id.toLowerCase()] || { realized: 0, blocked: 0, available: p.inv, base: p.inv };
    const sign = q.realized >= 0 ? '▲ ' : '▼ ';
    return `
    <div class="wallet" id="wallet-${p.id}">
      <div class="w-head"><span class="w-broker">${p.label}</span><span class="w-sub">${p.sub}</span></div>
      <div class="w-remain ${clsOf(q.available < 0 ? -1 : q.realized)}" id="wallet-remain-${p.id}">${inrFmt(q.available)}</div>
      <div class="w-cap">Free to trade</div>
      <div class="w-meta"><span>Invested ${inrFmt(p.inv)}</span><span class="w-delta ${clsOf(q.realized)}" id="wallet-delta-${p.id}">${sign}${inrFmt(Math.abs(q.realized))}</span></div>
      <div class="w-meta"><span id="wallet-used-${p.id}">In use ${inrFmt(q.blocked)}</span><span id="wallet-pool-${p.id}">Pool ${inrFmt(q.base + q.realized)}</span></div>
    </div>`;
  }).join('\n');

  const cardsHtml = strategies.map(s => `
    <div class="card ${s.accentClass}" id="card-${s.key}" hidden>
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

  // Rows arrive with the first poll (≤4s), which is also what decides which
  // strategies have earned one — pre-rendering all of them would flash a full
  // table that then collapses.
  const rollupRowsHtml =
    `<tr class="quiet"><td colspan="7">Loading…</td></tr>\n      `
    + `<tr class="total"><td>TOTAL</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Real-Time Monitor</title>
${faviconLink()}
<script>(function(){ if ('${resolveTheme()}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
  ${sidebarCSS()}
  ${modalCSS()}
  body { margin:0; background:#040c18; color:#e0eaf8; font-family:'Segoe UI',-apple-system,sans-serif; }
  .main-content { padding:20px 24px; }
  .top-bar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:16px; flex-wrap:wrap; }
  .top-bar h1 { margin:0; font-size:1.4rem; font-weight:600; letter-spacing:0.2px; }
  .top-bar .sub { color:#7d8aa3; font-size:0.78rem; margin-top:2px; }
  .toggle { display:inline-flex; background:#0a1628; border:1px solid #1c2c47; border-radius:8px; padding:3px; }
  .toggle button { background:transparent; border:none; color:#9aa9c2; font-size:0.82rem; font-weight:600; padding:7px 18px; border-radius:6px; cursor:pointer; transition:all 0.15s; letter-spacing:0.5px; }
  .toggle button.active[data-mode="PAPER"] { background:#2563eb; color:#fff; }
  .toggle button.active[data-mode="LIVE"]  { background:#dc2626; color:#fff; }

  /* Stop All — the panic button. Kept visually distinct from the PAPER/LIVE
     toggle so it can never be hit while aiming for a mode switch. */
  .top-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .stop-all { background:#7f1d1d; border:1px solid #b91c1c; color:#fee2e2; font-size:0.82rem; font-weight:700; letter-spacing:0.4px; padding:0 16px; min-height:44px; border-radius:8px; cursor:pointer; transition:all 0.15s; }
  .stop-all:hover:not(:disabled) { background:#b91c1c; color:#fff; }
  .stop-all:disabled { opacity:0.6; cursor:default; }
  .stop-all.armed { background:#dc2626; color:#fff; border-color:#ef4444; }
  .stop-all-note { background:#2a0f0f; border:1px solid #7f1d1d; border-left:4px solid #dc2626; border-radius:10px; padding:10px 14px; margin-bottom:14px; font-size:0.78rem; color:#fca5a5; line-height:1.6; }
  :root[data-theme="light"] .stop-all { background:#fef2f2 !important; border-color:#dc2626 !important; color:#b91c1c; }
  :root[data-theme="light"] .stop-all:hover:not(:disabled) { background:#dc2626 !important; color:#fff; }
  :root[data-theme="light"] .stop-all.armed { background:#dc2626 !important; color:#fff; }
  :root[data-theme="light"] .stop-all-note { background:#fef2f2 !important; border-color:#fecaca !important; color:#b91c1c; }

  /* Broker investment-pool wallets */
  .wallets { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(260px,100%), 1fr)); gap:14px; margin-bottom:18px; }
  .wallet { background:#0a1628; border:1px solid #1c2c47; border-left-width:4px; border-left-color:#3b82f6; border-radius:10px; padding:12px 16px; }
  .wallet#wallet-FYERS { border-left-color:#f59e0b; }
  .w-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
  .w-broker { font-size:0.95rem; font-weight:700; letter-spacing:0.6px; color:#cbd5e1; }
  .w-sub { font-size:0.66rem; color:#7d8aa3; text-transform:uppercase; letter-spacing:0.4px; }
  .w-remain { font-size:1.5rem; font-weight:700; line-height:1.2; margin-top:4px; font-variant-numeric:tabular-nums; }
  .w-cap { font-size:0.62rem; color:#7d8aa3; text-transform:uppercase; letter-spacing:0.5px; }
  .w-meta { display:flex; justify-content:space-between; font-size:0.72rem; color:#7d8aa3; margin-top:4px; }
  .w-delta { font-variant-numeric:tabular-nums; font-weight:600; }

  /* Capital shortfall alert — a paper entry the broker pool could not fund.
     Amber, not red: nothing was stopped, the play money simply ran out. */
  .cap-alert { background:#2a1f06; border:1px solid #7c5e10; border-left:4px solid #f59e0b; border-radius:10px; padding:12px 16px; margin-bottom:18px; }
  .cap-alert-head { font-size:0.9rem; font-weight:700; color:#fbbf24; letter-spacing:0.3px; }
  .cap-alert-sub { font-size:0.75rem; color:#c9a94a; margin-top:4px; line-height:1.55; }
  .cap-alert-list { margin:8px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:4px; }
  .cap-alert-list li { font-size:0.72rem; color:#e6d9a8; font-variant-numeric:tabular-nums; }
  .cap-alert-list .t { color:#9a8a55; }

  .cols { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(280px,100%), 1fr)); gap:14px; margin-bottom:18px; }
  .cards-empty { background:#0a1628; border:1px dashed #1c2c47; border-radius:10px; padding:22px 16px; margin-bottom:18px; text-align:center; color:#7d8aa3; font-size:0.85rem; }

  .card { background:#0a1628; border:1px solid #1c2c47; border-top-width:3px; border-radius:10px; padding:14px 16px; min-height:280px; display:flex; flex-direction:column; gap:10px; min-width:0; }
  .card[hidden] { display:none; }   /* display:flex above would beat the UA [hidden] rule */
  .card.ema_rsi_st    { border-top-color:#3b82f6; }
  .card.bb_rsi    { border-top-color:#f59e0b; }
  .card.pa       { border-top-color:#a855f7; }
  .card.orb      { border-top-color:#10b981; }
  .card.ema9vwap { border-top-color:#06b6d4; }
  .card.trendpb  { border-top-color:#ec4899; }
  .card.tds      { border-top-color:#a855f7; }
.card.hascalp  { border-top-color:#f97316; }
  .card.rsipivotst { border-top-color:#facc15; }
  .card.simple930 { border-top-color:#fb923c; }

  .card-header { display:flex; align-items:center; justify-content:space-between; }
  .card-title { font-size:1rem; font-weight:600; letter-spacing:0.5px; }
  .card.ema_rsi_st    .card-title { color:#60a5fa; }
  .card.bb_rsi    .card-title { color:#fbbf24; }
  .card.pa       .card-title { color:#c084fc; }
  .card.orb      .card-title { color:#34d399; }
  .card.ema9vwap .card-title { color:#22d3ee; }
  .card.trendpb  .card-title { color:#f472b6; }
  .card.tds      .card-title { color:#c084fc; }
.card.hascalp  .card-title { color:#fdba74; }
  .card.rsipivotst .card-title { color:#fde047; }
  .card.simple930 .card-title { color:#fdba74; }

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
  .activity .empty { color:var(--muted-1,#8ba1c2); font-style:italic; padding:6px 0; text-align:center; }

  .stats-row { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:auto; }
  .stat { background:#040c18; border:1px solid #15243d; border-radius:6px; padding:7px 8px; text-align:center; }
  .stat .lbl { font-size:0.62rem; color:#7d8aa3; text-transform:uppercase; letter-spacing:0.5px; }
  .stat .val { font-size:0.95rem; font-weight:700; margin-top:2px; font-variant-numeric:tabular-nums; }

  .pos-pos { color:#10b981 !important; }
  .pos-neg { color:#ef4444 !important; }
  .pos-zero { color:#94a3b8 !important; }

  .footer-meta { font-size:0.68rem; color:var(--muted-1,#8ba1c2); display:flex; justify-content:space-between; padding-top:6px; border-top:1px solid #15243d; }

  .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:6px; }
  .act-btn { display:inline-flex; align-items:center; justify-content:center; background:#040c18; border:1px solid #1c2c47; color:#cbd5e1; font-size:0.74rem; font-weight:600; padding:8px 10px; border-radius:6px; cursor:pointer; text-align:center; text-decoration:none; transition:all 0.15s; letter-spacing:0.3px; line-height:1.2; font-family:inherit; }
  .act-btn:hover { background:#0e1c33; border-color:#3b82f6; color:#fff; }
  .act-btn.copied { background:rgba(16,185,129,0.18); border-color:#10b981; color:#10b981; }
  .act-btn-disabled { background:#040c18; border-style:dashed; color:var(--muted-1,#8ba1c2); cursor:default; }
  .act-btn-disabled:hover { background:#040c18; color:var(--muted-1,#8ba1c2); border-color:#1c2c47; }
  .card.ema_rsi_st    .act-btn:not(.act-btn-disabled):hover { border-color:#3b82f6; }
  .card.bb_rsi    .act-btn:not(.act-btn-disabled):hover { border-color:#f59e0b; }
  .card.pa       .act-btn:not(.act-btn-disabled):hover { border-color:#a855f7; }
  .card.orb      .act-btn:not(.act-btn-disabled):hover { border-color:#10b981; }
  .card.ema9vwap .act-btn:not(.act-btn-disabled):hover { border-color:#06b6d4; }
  .card.trendpb  .act-btn:not(.act-btn-disabled):hover { border-color:#ec4899; }
  .card.tds      .act-btn:not(.act-btn-disabled):hover { border-color:#a855f7; }
.card.hascalp  .act-btn:not(.act-btn-disabled):hover { border-color:#f97316; }
  .card.rsipivotst .act-btn:not(.act-btn-disabled):hover { border-color:#facc15; }
  .card.simple930 .act-btn:not(.act-btn-disabled):hover { border-color:#fb923c; }

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
  .rollup tr.tds      td:first-child { color:#c084fc; }
.rollup tr.hascalp  td:first-child { color:#fdba74; }
  .rollup tr.rsipivotst td:first-child { color:#fde047; }
  .rollup tr.simple930 td:first-child { color:#fdba74; }
  .rollup tr.total    td:first-child { color:#e0eaf8; }
  .rollup tr.quiet td { color:#7d8aa3; font-weight:400; font-size:0.8rem; text-align:left; }

  .pulse { display:inline-block; width:7px; height:7px; border-radius:50%; background:#10b981; margin-left:6px; animation:pulse 1.5s ease-in-out infinite; vertical-align:middle; }
  @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }

  /* ── Light-theme overrides ── */
  :root[data-theme="light"] .top-bar h1 { color:#1e293b; }
  :root[data-theme="light"] .top-bar .sub { color:#4b5769; }
  :root[data-theme="light"] .toggle { background:#fff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  :root[data-theme="light"] .toggle button:not(.active) { color:#4b5769; }
  :root[data-theme="light"] .card { background:#fff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  :root[data-theme="light"] .cards-empty { background:#fff; border-color:#d7dce4; color:#4b5769; }
  :root[data-theme="light"] .card.ema_rsi_st    .card-title { color:#1d4ed8; }
  :root[data-theme="light"] .card.bb_rsi    .card-title { color:#b45309; }
  :root[data-theme="light"] .card.pa       .card-title { color:#7e22ce; }
  :root[data-theme="light"] .card.orb      .card-title { color:#047857; }
  :root[data-theme="light"] .card.ema9vwap .card-title { color:#0e7490; }
  :root[data-theme="light"] .card.trendpb  .card-title { color:#be185d; }
  :root[data-theme="light"] .card.tds      .card-title { color:#7e22ce; }
:root[data-theme="light"] .card.hascalp  .card-title { color:#c2410c; }
  :root[data-theme="light"] .card.rsipivotst .card-title { color:#a16207; }
  :root[data-theme="light"] .card.simple930 .card-title { color:#c2410c; }
  :root[data-theme="light"] .pos-block,
  :root[data-theme="light"] .flat-block { background:#f8fafc !important; border-color:#e0e4ea !important; }
  :root[data-theme="light"] .flat-block { color:#4b5769; }
  :root[data-theme="light"] .pos-symbol { color:#475569; }
  :root[data-theme="light"] .pos-grid .lbl { color:#4b5769; }
  :root[data-theme="light"] .pos-grid .val { color:#1e293b; }
  :root[data-theme="light"] .activity { background:#f8fafc !important; border-color:#e0e4ea !important; color:#475569; }
  :root[data-theme="light"] .activity .ahead { color:#5c6b7f; }
  :root[data-theme="light"] .activity .empty { color:#5c6b7f; }
  :root[data-theme="light"] .stat { background:#f8fafc !important; border-color:#e0e4ea !important; }
  :root[data-theme="light"] .stat .lbl { color:#4b5769; }
  :root[data-theme="light"] .stat .val { color:#1e293b; }
  :root[data-theme="light"] .footer-meta { color:#5c6b7f; border-top-color:#e0e4ea; }
  .rollup-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; border-radius:10px; }
  @media(max-width:768px){
    /* .rollup sets overflow:hidden for its rounded corners, which outranks the
       shared table rule and clipped the last three columns. The wrapper scrolls
       instead, and the table keeps a readable minimum width. */
    .rollup { min-width:620px; }
    .rollup th, .rollup td { padding:9px 10px; white-space:nowrap; }
  }
  :root[data-theme="light"] .rollup { background:#fff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  :root[data-theme="light"] .rollup th { background:#f1f5f9 !important; color:#4b5769 !important; border-bottom-color:#e0e4ea !important; }
  :root[data-theme="light"] .rollup td { color:#334155; border-bottom-color:#e0e4ea; }
  :root[data-theme="light"] .rollup tr:last-child td { background:#f8fafc !important; color:#1e293b; }
  /* Needs the theme prefix: the plain .rollup td rule above outranks tr.quiet. */
  :root[data-theme="light"] .rollup tr.quiet td { color:#64748b; }
  :root[data-theme="light"] .rollup tr.ema_rsi_st    td:first-child { color:#1d4ed8; }
  :root[data-theme="light"] .rollup tr.bb_rsi    td:first-child { color:#b45309; }
  :root[data-theme="light"] .rollup tr.pa       td:first-child { color:#7e22ce; }
  :root[data-theme="light"] .rollup tr.orb      td:first-child { color:#047857; }
  :root[data-theme="light"] .rollup tr.ema9vwap td:first-child { color:#0e7490; }
  :root[data-theme="light"] .rollup tr.trendpb  td:first-child { color:#be185d; }
  :root[data-theme="light"] .rollup tr.tds      td:first-child { color:#7e22ce; }
:root[data-theme="light"] .rollup tr.hascalp  td:first-child { color:#c2410c; }
  :root[data-theme="light"] .rollup tr.rsipivotst td:first-child { color:#a16207; }
  :root[data-theme="light"] .rollup tr.simple930 td:first-child { color:#c2410c; }
  :root[data-theme="light"] .pos-zero { color:#4b5769 !important; }
  :root[data-theme="light"] .pos-pos  { color:#059669 !important; }
  :root[data-theme="light"] .pos-neg  { color:#dc2626 !important; }
  :root[data-theme="light"] .act-btn { background:#f8fafc !important; border-color:#e0e4ea !important; color:#475569; }
  :root[data-theme="light"] .act-btn:hover { background:#fff !important; color:#1e293b; }
  :root[data-theme="light"] .act-btn.copied { background:rgba(16,185,129,0.10) !important; border-color:#10b981 !important; color:#059669; }
  :root[data-theme="light"] .act-btn-disabled { color:#5c6b7f !important; }
  :root[data-theme="light"] .wallet { background:#fff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  :root[data-theme="light"] .w-broker { color:#1e293b; }
  :root[data-theme="light"] .w-sub { color:#5c6b7f; }
  :root[data-theme="light"] .w-meta { color:#4b5769; }
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
    <div class="top-actions">
      ${!sessionActive ? `<div class="toggle" id="mode-toggle">
        <button data-mode="PAPER" class="active">PAPER</button>
        <button data-mode="LIVE">LIVE</button>
      </div>` : ''}
      <button type="button" class="stop-all" id="stop-all">🛑 Stop All</button>
    </div>
  </div>
  <div class="stop-all-note" id="stop-all-note" hidden></div>

  <!-- Capital shortfall alert — filled by /realtime/capital. Trades are never
       stopped when the pool runs dry; this is how you find out that it did. -->
  <div class="cap-alert" id="cap-alert" hidden></div>

  <!-- Shown during a running session too: while trading is exactly when "how much
       is left" matters. Numbers come from /realtime/capital, not from the
       per-strategy pages, so they include what open positions are holding. -->
  ${pools.length ? `<div class="wallets" id="wallets">\n${walletsHtml}\n  </div>` : ''}

  <div class="cols">
${cardsHtml}
  </div>
  <!-- Cards are hidden until a strategy actually has something to watch (open
       position, a trade today, or a dead endpoint). With ten strategies the wall
       of identical FLAT boxes buried the one card that mattered. The rollup
       table below still lists every strategy. -->
  <div class="cards-empty" id="cards-empty" hidden>No strategy has taken a trade yet — cards appear here on the first entry.</div>

  <div class="rollup-wrap">
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
  </div>
</main>

<script>
${modalJS()}
const STRATEGY_KEYS    = ${strategyOrder};
const ENDPOINTS        = ${endpointsJson};
const STATUS_PAGES     = ${statusPagesJson};
const STRATEGY_LABELS  = ${labelsJson};
const STRATEGY_ACCENTS = ${accentsJson};
const JSONL_PREFIX     = ${dayLogPrefixes};
const WALLET_POOLS     = ${poolsJson};
const STOP_URLS        = ${stopUrlsJson};
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
// After a restart with no trades yet today, a strategy restores its LAST saved session
// so its own page isn't blank — flagged as staleSession. Those are not today's trades,
// so every "today" figure on this monitor must read zero for them; otherwise a week-old
// win shows up as today's P&L.
function isStale(d) { return !!(d && d.staleSession); }
function todayClosed(d) { return isStale(d) ? 0 : (+(d?.sessionPnl ?? 0) || 0); }
function todayTrades(d) { return isStale(d) ? 0 : (tradeCountOf(d) || 0); }
function todayWins(d)   { return isStale(d) ? 0 : (d?.wins   ?? 0); }
function todayLosses(d) { return isStale(d) ? 0 : (d?.losses ?? 0); }
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
    // A dead endpoint stays on screen — hiding it would look like a quiet
    // strategy instead of a broken one.
    showCard(strategy, true);
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

  const sessPnl = todayClosed(d);
  statsEl.innerHTML = \`
    <div class="stat"><div class="lbl">Trades</div><div class="val">\${todayTrades(d)}</div></div>
    <div class="stat"><div class="lbl">W / L</div><div class="val">\${todayWins(d)} / \${todayLosses(d)}</div></div>
    <div class="stat"><div class="lbl">Session P&amp;L</div><div class="val \${cls(sessPnl)}">\${fmtINR(sessPnl)}</div></div>\`;

  const ltp = d.lastTickPrice ? fmtNum(d.lastTickPrice) : '—';
  const tickTime = d.lastTickTime || '';
  metaEl.innerHTML = \`<span>LTP \${ltp}\${tickTime ? ' · ' + tickTime : ''}</span><span>\${d.tickCount ?? 0} ticks</span>\`;

  // Worth a card only once there is something to watch: money at risk now, or a
  // trade already taken today. Everything else lives in the rollup table.
  showCard(strategy, !!pos || todayTrades(d) > 0);
}

// Cards are hidden, not removed, so the poll can bring one back the moment its
// strategy enters — and the copy/open buttons keep their handlers throughout.
function showCard(strategy, visible) {
  const card = document.getElementById('card-' + strategy);
  if (card) card.hidden = !visible;
}

function renderCardsEmpty() {
  const box = document.getElementById('cards-empty');
  if (!box) return;
  const anyVisible = STRATEGY_KEYS.some(k => {
    const card = document.getElementById('card-' + k);
    return card && !card.hidden;
  });
  box.hidden = anyVisible;
}

function renderRollup(all) {
  let totalOpen = 0, totalClosed = 0, totalTrades = 0, totalW = 0, totalL = 0;
  let anyRunning = false, anyData = false;
  let rows = 0, quiet = 0;   // rows drawn vs strategies hidden for having nothing yet

  const tbody = document.getElementById('rollup-body');
  let html = '';
  for (const key of STRATEGY_KEYS) {
    const d = all[key];
    const accent = STRATEGY_ACCENTS[key] || key.toLowerCase();
    const label = STRATEGY_LABELS[key];
    if (!d) {
      html += \`<tr class="\${accent}" data-key="\${key}"><td>\${label}</td><td>OFFLINE</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>\`;
      continue;
    }
    anyData = true;
    const open = +openPnl(d) || 0;
    const closed = todayClosed(d);
    const dayTotal = open + closed;
    const trades = todayTrades(d);
    const w = todayWins(d);
    const l = todayLosses(d);
    if (d.running) anyRunning = true;
    totalOpen += open;
    totalClosed += closed;
    totalTrades += +trades || 0;
    totalW += +w || 0;
    totalL += +l || 0;
    // Same rule as the cards above: a strategy earns a row once it has money at
    // risk or a trade today. It is only the row that is dropped — its numbers
    // are already in the totals, so TOTAL still speaks for every strategy.
    if (!d.position && !(trades > 0)) { quiet++; continue; }
    rows++;
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
  // A lone TOTAL row reads like a broken table — say why it is alone.
  if (!rows && quiet) {
    html += \`<tr class="quiet"><td colspan="7">\${quiet} \${quiet === 1 ? 'strategy is' : 'strategies are'} running with no trade yet today</td></tr>\`;
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

// IST weekday, 09:15–15:30 — same window the trading engines run in.
function isMarketRunning() {
  const local = new Date();
  const now = new Date(Date.now() + (330 - local.getTimezoneOffset()) * 60000);
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

// Broker wallets, straight from the capital pool — one source, so the ribbon
// cannot disagree with the alert banner below it. Summing the per-strategy
// /status/data totals (the old way) missed both the money open positions are
// holding and the P&L of a session that has not been saved yet.
//   headline = free to trade   ·   Pool = investment + P&L   ·   In use = blocked
function renderPools(d) {
  // The pool is paper money only — there is no live-margin equivalent, so the
  // ribbon has nothing honest to say in LIVE mode. Hide it rather than show
  // paper rupees under a LIVE heading.
  const box = document.getElementById('wallets');
  if (box) box.style.display = (mode === 'LIVE' || isMarketRunning()) ? 'none' : '';
  const pools = (d && d.pools) || null;
  if (!pools) return;   // failed poll — keep the last good numbers on screen
  const set = (id, text, klass) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (klass) el.className = klass;
  };
  for (const p of WALLET_POOLS) {
    const q = pools[p.id.toLowerCase()];
    if (!q) continue;
    // Free cash drives the colour: red the moment the book is past its money.
    set('wallet-remain-' + p.id, fmtINR(q.available), 'w-remain ' + cls(q.available < 0 ? -1 : q.realized));
    set('wallet-delta-'  + p.id, (q.realized >= 0 ? '▲ ' : '▼ ') + fmtINR(Math.abs(q.realized)), 'w-delta ' + cls(q.realized));
    set('wallet-used-'   + p.id, 'In use ' + fmtINR(q.blocked));
    set('wallet-pool-'   + p.id, 'Pool ' + fmtINR(q.base + q.realized));
  }
}

// Capital alert — the broker pool could not fund an entry. The trade was taken
// anyway (a paper session must keep collecting data), so this banner is the only
// place that says the play money ran out.
function renderCapitalAlert(d) {
  const box = document.getElementById('cap-alert');
  if (!box || !d) return;   // failed poll — keep the alert up, same as the ribbon
  const alerts = d.alerts || [];
  const pools  = d.pools  || {};
  const dry    = Object.values(pools).filter(p => p && p.available < 0);
  if (!alerts.length && !dry.length) { box.hidden = true; box.innerHTML = ''; return; }

  const poolLine = dry.map(p =>
    p.broker.toUpperCase() + ' overdrawn by ' + fmtINR(Math.abs(p.available))
    + ' (invested ' + fmtINR(p.base) + ', P&L ' + fmtINR(p.realized) + ', ' + fmtINR(p.blocked) + ' in open positions)'
  ).join(' · ');

  const rows = alerts.slice(0, 5).map(a => {
    const t = new Date(a.ts).toLocaleTimeString('en-IN', { hour12:false });
    return '<li><span class="t">' + t + '</span> — ' + a.label + ' ' + (a.side || '')
         + ' needed ' + fmtINR(a.cost) + ', pool had ' + fmtINR(a.available)
         + ' (short ' + fmtINR(a.short) + ')</li>';
  }).join('');

  box.innerHTML =
      // Says PAPER explicitly: unlike the ribbon this banner stays up under the
      // LIVE toggle (an alert you can hide by switching tabs is not an alert),
      // so it must name whose money ran out.
      '<div class="cap-alert-head">⚠️ Paper capital pool exhausted — trades are still running</div>'
    + '<div class="cap-alert-sub">'
    + (poolLine || 'A paper entry cost more than the broker pool had left.')
    + '<br>Nothing was stopped. Raise the investment amount in Settings → Instrument &amp; Backtest → Capital, or reset the paper history for that strategy.</div>'
    + (rows ? '<ul class="cap-alert-list">' + rows + '</ul>' : '')
    + (alerts.length > 5 ? '<div class="cap-alert-sub">…and ' + (alerts.length - 5) + ' more</div>' : '');
  box.hidden = false;
}

async function poll() {
  const eps = ENDPOINTS[mode];
  const fetchOne = url => fetch(url, { cache:'no-store' })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
  // Capital rides along with the strategy fetches — one round trip, not two.
  const results = await Promise.all(
    STRATEGY_KEYS.map(k => fetchOne(eps[k])).concat(fetchOne('/realtime/capital'))
  );
  const capital = results.pop();
  const all = {};
  STRATEGY_KEYS.forEach((k, i) => { all[k] = results[i]; renderColumn(k, results[i]); });
  renderCardsEmpty();
  renderRollup(all);
  renderPools(capital);
  renderCapitalAlert(capital);
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

// ── Stop All ────────────────────────────────────────────────────────────────
// Fans out GET /stop across every enabled strategy, PAPER and LIVE both. Each
// engine's own /stop is reused verbatim, so an open position is squared off by
// exactly the same code path the per-strategy Stop button uses.
//
// Two clicks: the first arms, the second fires. This squares off real money in
// LIVE — a stray click on a phone must not be able to flatten the book.
let stopArmed = false;
let stopArmTimer = null;
let stopBusy = false;   // a sweep is in flight — btn.disabled alone does not stop a key-repeat

function disarmStopAll() {
  stopArmed = false;
  if (stopArmTimer) { clearTimeout(stopArmTimer); stopArmTimer = null; }
  const btn = document.getElementById('stop-all');
  if (btn) { btn.classList.remove('armed'); btn.textContent = '🛑 Stop All'; }
}

function stopNote(html) {
  const box = document.getElementById('stop-all-note');
  if (!box) return;
  box.innerHTML = html;
  box.hidden = !html;
}

async function stopAll() {
  const btn = document.getElementById('stop-all');
  if (!btn) return;
  if (stopBusy) return;   // never start a second sweep over a running one

  if (!stopArmed) {
    stopArmed = true;
    btn.classList.add('armed');
    btn.textContent = '🛑 Click again to confirm';
    stopNote('This stops <b>every</b> strategy in <b>both</b> PAPER and LIVE, and squares off any open position. Click Stop All again within 6s to confirm.');
    stopArmTimer = setTimeout(() => { disarmStopAll(); stopNote(''); }, 6000);
    return;
  }

  if (stopArmTimer) { clearTimeout(stopArmTimer); stopArmTimer = null; }
  stopArmed = false;
  stopBusy = true;
  btn.classList.remove('armed');
  btn.disabled = true;
  btn.textContent = 'Stopping…';
  stopNote('Checking which engines are running…');
  try {

  // Which engines are actually up? Probed in parallel — these are cheap reads,
  // and the answer decides both what gets stopped and what the report may claim.
  // An unreachable status endpoint is treated as "might be running": better to
  // send a harmless stop to an idle engine than to skip a live one.
  const live = [];
  await Promise.all(STOP_URLS.map(async t => {
    try {
      const r = await fetch(t.statusUrl, { cache:'no-store' });
      if (!r.ok) { live.push(t); return; }          // can't tell → stop it anyway
      const d = await r.json();
      if (!d) { live.push(t); return; }
      // The harness LIVE routes spread the underlying paper engine's status, so
      // their "running" is true whenever PAPER is running — even with no harness
      // installed. "installed" is the only field that means LIVE is armed; the
      // paper entry already covers the paper session itself.
      if (typeof d.installed === 'boolean') { if (d.installed) live.push(t); return; }
      if (d.running) live.push(t);
    } catch (e) { live.push(t); }
  }));

  if (!live.length) {
    stopNote('<b>Nothing to stop</b> — no strategy is running in PAPER or LIVE.');
    return;
  }

  // Sequential, not parallel: several /stop handlers place a real square-off
  // order, and firing them all at once is how you get rate-limited mid-flatten.
  stopNote('Stopping ' + live.length + ' engine' + (live.length === 1 ? '' : 's') + '…');
  const stopped = [], failed = [];
  for (const t of live) {
    try {
      // secretFetch, not fetch: /stop requires API_SECRET. It prompts once and
      // remembers for the session, and returns null if the prompt is cancelled.
      const r = await secretFetch(t.url, { cache:'no-store', redirect:'follow' });
      if (!r) { failed.push({ ...t, status: 403 }); continue; }
      // 400 = "not running" / "harness not installed" for the harness routes —
      // it raced us to idle, which is the outcome we wanted anyway.
      if (r.ok || r.status === 400) stopped.push(t);
      else failed.push({ ...t, status: r.status });
    } catch (e) {
      failed.push({ ...t, status: 0 });
    }
  }

  const name = t => STRATEGY_LABELS[t.key] + ' ' + t.mode;
  let msg = '<b>Stop All finished.</b> ';
  if (stopped.length) msg += 'Stopped: ' + stopped.map(name).join(', ') + '. ';
  if (failed.length) {
    msg += '<b>Could not stop:</b> ' + failed.map(t => name(t) + ' (http ' + t.status + ')').join(', ')
         + ' — open that strategy\\'s page and stop it there.';
  }
  stopNote(msg);
  poll();

  } finally {
    // Always release, even if something above threw — otherwise the button
    // stays greyed out and the only way back is a page reload.
    stopBusy = false;
    btn.disabled = false;
    btn.textContent = '🛑 Stop All';
  }
}

document.getElementById('stop-all')?.addEventListener('click', stopAll);

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

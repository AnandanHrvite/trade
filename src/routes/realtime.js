/**
 * realtime.js — Unified real-time monitor for PAPER trades
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only single screen for every strategy (and every running strategy ×
 * market pair) enabled in Settings: today's P&L with one chip per market, a
 * market filter, open-position cards grouped by market, and a summary table
 * grouped by market with subtotals. Also the Dashboard ("/") while any session
 * runs. Every 4s the page polls each strategy's existing
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

// Every row comes from the registry × running pairs (utils/dashboardModel.js),
// so a strategy converted to pairs appears here under each market it runs on
// with no edit to this file. label = short name inside its market group;
// title = full name used in confirmations and copied logs.
// hasDayLog: only routes that expose /download/{trades,skips}/:date show the
// Copy Day Log button (TREND_PB has cumulative JSONL only).
const dashboardModel = require("../utils/dashboardModel");
const dashboardUI    = require("../utils/dashboardUI");
const STRATEGY_DEFS = dashboardModel.allRows().map(r => ({
  key: r.key, label: r.label, title: r.title, market: r.market, accent: r.accent,
  paperPrefix: r.paperPrefix, hasDayLog: r.hasDayLog, modeFlag: r.modeFlag, defaultOff: !r.defaultOn,
}));

function enabledStrategies() {
  return dashboardModel.sortByMarket(STRATEGY_DEFS.filter(s => dashboardModel.isOn({ modeFlag: s.modeFlag, defaultOn: !s.defaultOff })));
}

// Broker investment pools: each strategy's paper P&L draws from one shared pool.
// The pool is the registry's capitalPool broker (Fyers candles + Zerodha
// orders count as ZERODHA).
const BROKER_OF = Object.fromEntries(require("../config/strategyRegistry").all()
  .map(s => [s.key, s.broker.toUpperCase()])
  .concat(require("../config/pairs").runnable().map(p => [p.envPrefix, p.broker.toUpperCase()])));
const brokerOfKey = (key) => BROKER_OF[key];
function brokerPools(strategies) {
  // Same fallback as capitalPool.baseCapital — the ribbon must show the amount the gate uses.
  const inv = (v) => (n => Number.isFinite(n) && n >= 0 ? n : 100000)(parseFloat(v || '100000'));
  const z = inv(process.env.ZERODHA_INV_AMOUNT);
  const f = inv(process.env.FYERS_INV_AMOUNT);
  const pools = [];
  // sub = the enabled strategies actually routed to that broker, never a
  // hardcoded list (it went stale every time a strategy was added).
  const subOf = (broker) => strategies.filter(s => brokerOfKey(s.key) === broker)
                                      .map(s => s.title).join(' \u00b7 ');
  const zSub = subOf('ZERODHA');
  const fSub = subOf('FYERS');
  if (zSub) pools.push({ id:'ZERODHA', label:'ZERODHA', sub:zSub, inv:z });
  if (fSub) pools.push({ id:'FYERS', label:'FYERS', sub:fSub, inv:f });
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
  res.send(renderPage({ sidebarKey: "dashboard", autoFlipBack: false }));
});

function renderPage({ sidebarKey = "realtime", autoFlipBack = false } = {}) {
  const sidebar = buildSidebar(sidebarKey, false);
  const strategies = enabledStrategies();
  // When nothing runs this page can still start the paper roster (the
  // Dashboard's button is not reachable from here).
  const nseActive     = sharedSocketState.isAnyActive();

  const endpointsJson = JSON.stringify({
    PAPER: Object.fromEntries(strategies.map(s => [s.key, s.paperPrefix + '/status/data'])),
  });
  const statusPagesJson = JSON.stringify({
    PAPER: Object.fromEntries(strategies.map(s => [s.key, s.paperPrefix + '/status'])),
  });
  // Manual square-off targets.
  const exitUrlsJson = JSON.stringify({
    PAPER: Object.fromEntries(strategies.map(s => [s.key, s.paperPrefix + '/exit'])),
  });
  // Full names for confirmations / copied logs; short names inside a market group.
  const labelsJson      = JSON.stringify(Object.fromEntries(strategies.map(s => [s.key, s.title])));
  const shortJson       = JSON.stringify(Object.fromEntries(strategies.map(s => [s.key, s.label])));
  const accentsJson     = JSON.stringify(Object.fromEntries(strategies.map(s => [s.key, s.accent])));
  const marketOfJson    = JSON.stringify(Object.fromEntries(strategies.map(s => [s.key, s.market])));
  const marketGroups    = dashboardModel.marketsOf(strategies);
  const marketsJson     = JSON.stringify(marketGroups);
  const dayLogPrefixes  = JSON.stringify(Object.fromEntries(strategies.filter(s => s.hasDayLog).map(s => [s.key, s.paperPrefix])));
  const strategyOrder   = JSON.stringify(strategies.map(s => s.key));
  // Stop-all hits every strategy's paper prefix.
  // statusUrl is probed first so the report can name what was ACTUALLY running:
  // most paper /stop handlers redirect unconditionally (their stopSession() is a
  // no-op when idle), so the HTTP response alone cannot tell running from idle.
  const stopUrlsJson    = JSON.stringify(strategies.map(s => ([
    { key: s.key, mode: 'PAPER', url: s.paperPrefix + '/stop', statusUrl: s.paperPrefix + '/status/data' },
  ])).flat());
  const paperOnlyJson   = JSON.stringify(strategies.filter(s => s.paperOnly).map(s => s.key));
  // Strategies flagged futures:true hold futures — their cards read LONG/SHORT, never premium.
  const futuresJson     = JSON.stringify(strategies.filter(s => s.futures).map(s => s.key));

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

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  // One card per strategy, grouped under its market. A card is shown only while
  // that strategy holds a position (or its endpoint is dead) — see showCard().
  // Exit Trade sits right under the position, ahead of the less urgent details.
  const cardHtml = s => `
      <article class="card" id="card-${s.key}" style="--acc:${esc(s.accent)}" hidden>
        <div class="card-header">
          <div class="card-title">${esc(s.label)}</div>
          <div class="badge stop" id="badge-${s.key}">—</div>
        </div>
        <div id="body-${s.key}"><div class="flat-block">Loading…</div></div>
        <button type="button" class="act-btn exit-btn" id="exit-${s.key}" onclick="exitPosition('${s.key}', this)" hidden>🚪 Exit Trade</button>
        <div class="stats-row" id="stats-${s.key}"></div>
        <details class="act-wrap">
          <summary>Recent activity</summary>
          <div class="activity" id="activity-${s.key}"><div class="empty">Waiting for activity…</div></div>
        </details>
        <div class="footer-meta" id="meta-${s.key}"><span>—</span><span>—</span></div>
        <div class="actions">
          ${s.hasDayLog
            ? `<button type="button" class="act-btn" id="copy-${s.key}" onclick="copyDayLog('${s.key}', this)">📋 Copy Day Log</button>`
            : `<span class="act-btn act-btn-disabled" title="Per-date JSONL not exposed for this strategy">— No Day Log —</span>`}
          <a class="act-btn" id="open-${s.key}" href="${s.paperPrefix}/status">Open Status →</a>
        </div>
      </article>`;
  // Market sections stay hidden until one of their cards is (renderCardsEmpty).
  const cardsHtml = marketGroups.map(g => `
    <section class="rt-mkt" id="rt-mkt-${g.key}" data-dh-market="${g.key}" hidden>
      <div class="dh-mhead">${esc(g.label)}</div>
      <div class="cols">${strategies.filter(s => s.market === g.key).map(cardHtml).join('')}
      </div>
    </section>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Real-Time Monitor</title>
${faviconLink()}
<script>(function(){ if ('${resolveTheme()}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
  ${sidebarCSS()}
  ${modalCSS()}
  ${dashboardUI.dashCSS()}
  body { margin:0; background:#040c18; color:#e0eaf8; font-family:'Segoe UI',-apple-system,sans-serif; }
  :root[data-theme="light"] body { background:#f4f6f9; color:#1e293b; }
  .main-content { padding:20px max(24px, env(safe-area-inset-right)) calc(28px + env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left)); }
  @media(max-width:768px){ .main-content { padding:12px max(16px, env(safe-area-inset-right)) calc(28px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); } }
  .top-bar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:16px; flex-wrap:wrap; }
  .top-bar h1 { margin:0; font-size:1.4rem; font-weight:600; letter-spacing:0.2px; }
  .top-bar .sub { color:#7d8aa3; font-size:0.78rem; margin-top:2px; }

  /* Stop All — the panic button. */
  .top-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .stop-all { background:#7f1d1d; border:1px solid #b91c1c; color:#fee2e2; font-size:0.82rem; font-weight:700; letter-spacing:0.4px; padding:0 16px; min-height:44px; border-radius:8px; cursor:pointer; transition:all 0.15s; }
  .stop-all:hover:not(:disabled) { background:#b91c1c; color:#fff; }
  .stop-all:disabled { opacity:0.6; cursor:default; }
  .stop-all.armed { background:#dc2626; color:#fff; border-color:#ef4444; }
  .nse-start { background:#0c2a4a; border:1px solid #2563eb; color:#93c5fd; font-size:0.82rem; font-weight:700; letter-spacing:0.4px; padding:0 16px; min-height:44px; border-radius:8px; cursor:pointer; transition:all 0.15s; }
  .nse-start:hover:not(:disabled) { background:#2563eb; color:#fff; }
  .nse-start:disabled { opacity:0.6; cursor:default; }
  :root[data-theme="light"] .nse-start { background:#eff6ff !important; border-color:#2563eb !important; color:#1d4ed8; }
  :root[data-theme="light"] .nse-start:hover:not(:disabled) { background:#2563eb !important; color:#fff; }
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

  /* Capital shortfall alert — a paper entry the broker pool REFUSED to fund.
     Red: a signal was dropped, and every further signal will be until the pool
     is topped up or a position exits. */
  .cap-alert { background:#2a0e0e; border:1px solid #7c1d1d; border-left:4px solid #ef4444; border-radius:10px; padding:12px 16px; margin-bottom:18px; }
  .cap-alert-head { font-size:0.9rem; font-weight:700; color:#f87171; letter-spacing:0.3px; }
  .cap-alert-sub { font-size:0.75rem; color:#d08a8a; margin-top:4px; line-height:1.55; }
  .cap-alert-list { margin:8px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:4px; }
  .cap-alert-list li { font-size:0.72rem; color:#e6d9a8; font-variant-numeric:tabular-nums; }
  .cap-alert-list .t { color:#9a8a55; }

  .cols { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(300px,100%), 1fr)); gap:12px; }
  .rt-mkt { margin-bottom:6px; }
  .rt-mkt[hidden] { display:none; }
  .cards-empty { background:var(--dh-card); border:1px dashed var(--dh-border); border-radius:10px; padding:18px 16px; text-align:center; color:var(--dh-dim); font-size:0.84rem; }

  /* Strategy card — accent from --acc (set inline per strategy). */
  .card { background:var(--dh-card); border:1px solid var(--dh-border); border-top:3px solid var(--acc,#3b82f6); border-radius:10px; padding:12px 14px; display:flex; flex-direction:column; gap:10px; min-width:0; color:var(--dh-text); }
  .card[hidden] { display:none; }   /* display:flex above would beat the UA [hidden] rule */
  .card-header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .card-title { font-size:0.95rem; font-weight:700; letter-spacing:0.3px; min-width:0; overflow-wrap:anywhere; }

  .badge { font-size:0.66rem; padding:3px 8px; border-radius:4px; border:1px solid; font-weight:700; letter-spacing:0.4px; white-space:nowrap; }
  .badge.run  { background:rgba(16,185,129,0.12); color:var(--dh-pos); border-color:rgba(16,185,129,0.35); }
  .badge.stop { background:rgba(148,163,184,0.10); color:var(--dh-zero); border-color:rgba(148,163,184,0.30); }
  .badge.err  { background:rgba(239,68,68,0.12);  color:var(--dh-neg); border-color:rgba(239,68,68,0.35); }

  .pos-block, .flat-block { background:var(--dh-inset); border:1px solid var(--dh-line); border-radius:8px; padding:10px 12px; }
  .pos-top { display:flex; align-items:center; gap:6px; min-width:0; }
  .pos-side { display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.72rem; font-weight:700; letter-spacing:0.5px; flex-shrink:0; }
  .pos-side.CE { background:rgba(16,185,129,0.18); color:var(--dh-pos); }
  .pos-side.PE { background:rgba(239,68,68,0.18);  color:var(--dh-neg); }
  .pos-symbol { font-size:0.76rem; color:var(--dh-muted); overflow-wrap:anywhere; min-width:0; }
  .pnl-big { font-size:1.6rem; font-weight:700; line-height:1.15; margin-top:6px; font-variant-numeric:tabular-nums; }
  .pnl-big .pct { font-size:0.8rem; font-weight:600; color:var(--dh-muted); margin-left:6px; }
  .pos-kv { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:6px; margin-top:8px; }
  .pos-kv .kv { background:var(--dh-card); border:1px solid var(--dh-line); border-radius:6px; padding:5px 7px; min-width:0; }
  .pos-kv .k { font-size:0.6rem; color:var(--dh-dim); text-transform:uppercase; letter-spacing:0.4px; }
  .pos-kv .v { font-size:0.84rem; font-weight:600; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pos-more { display:flex; flex-wrap:wrap; justify-content:space-between; gap:2px 12px; margin-top:7px; font-size:0.72rem; color:var(--dh-dim); font-variant-numeric:tabular-nums; }
  @media(max-width:400px){ .pos-kv { grid-template-columns:repeat(2, minmax(0,1fr)); } }
  /* EarlyBird aggregate block — several cash-equity positions in one card. */
  .eb-head { margin-bottom:2px; }
  .eb-list { margin-top:8px; display:flex; flex-direction:column; gap:5px; }
  .eb-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto auto auto auto; gap:8px; align-items:center; font-size:0.74rem; color:var(--dh-text); font-variant-numeric:tabular-nums; }
  .eb-sym { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .eb-qty, .eb-px, .eb-pts, .eb-pnl { white-space:nowrap; text-align:right; }
  .eb-pnl { font-weight:600; }
  /* Per-leg square-off — 44px tall on touch. */
  .eb-exit { background:transparent; border:1px solid #7f1d1d; color:#f87171; border-radius:5px; font-size:0.68rem; font-weight:700; padding:3px 7px; cursor:pointer; font-family:inherit; line-height:1.2; white-space:nowrap; }
  .eb-exit:hover { background:rgba(239,68,68,0.16); border-color:#ef4444; color:#fca5a5; }
  .eb-exit:disabled { opacity:0.5; cursor:default; }
  @media(max-width:768px){
    .eb-row { grid-template-columns:auto minmax(0,1fr) auto auto; row-gap:2px; }
    .eb-px { grid-column:2 / 4; text-align:left; color:var(--dh-dim); }
    .eb-exit { min-height:44px; padding:6px 12px; }
  }
  :root[data-theme="light"] .eb-exit { border-color:#fecaca; color:#b91c1c; }

  .flat-block { text-align:center; color:var(--dh-dim); font-size:0.86rem; padding:16px 12px; }

  /* Recent activity — folded away; the position and the Exit button come first. */
  .act-wrap > summary { cursor:pointer; list-style:none; font-size:0.72rem; font-weight:600; color:var(--dh-muted); min-height:32px; display:flex; align-items:center; }
  .act-wrap > summary::-webkit-details-marker { display:none; }
  .act-wrap > summary::before { content:"▸"; margin-right:6px; }
  .act-wrap[open] > summary::before { content:"▾"; }
  .activity { background:var(--dh-inset); border:1px solid var(--dh-line); border-radius:6px; padding:6px 8px; font-family:'SF Mono','Menlo','Monaco',monospace; font-size:0.68rem; line-height:1.45; color:var(--dh-muted); max-height:120px; overflow:hidden; min-width:0; }
  .activity .ahead { display:flex; justify-content:space-between; align-items:center; color:var(--dh-dim); font-size:0.62rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; font-family:inherit; }
  .activity .arow { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .activity .empty { color:var(--dh-dim); font-style:italic; padding:6px 0; text-align:center; }

  .stats-row { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
  .stat { background:var(--dh-inset); border:1px solid var(--dh-line); border-radius:6px; padding:6px 8px; }
  .stat .lbl { font-size:0.6rem; color:var(--dh-dim); text-transform:uppercase; letter-spacing:0.4px; }
  .stat .val { font-size:0.9rem; font-weight:700; margin-top:2px; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }

  .pos-pos { color:var(--dh-pos) !important; }
  .pos-neg { color:var(--dh-neg) !important; }
  .pos-zero { color:var(--dh-zero) !important; }

  .footer-meta { font-size:0.68rem; color:var(--dh-dim); display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; padding-top:6px; border-top:1px solid var(--dh-line); }

  .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .act-btn { display:inline-flex; align-items:center; justify-content:center; min-height:44px; background:var(--dh-inset); border:1px solid var(--dh-border); color:var(--dh-text); font-size:0.76rem; font-weight:600; padding:8px 10px; border-radius:8px; cursor:pointer; text-align:center; text-decoration:none; transition:border-color 0.15s, background 0.15s; letter-spacing:0.2px; line-height:1.2; font-family:inherit; }
  .act-btn:hover { border-color:var(--acc,#3b82f6); }
  .act-btn.copied { background:rgba(16,185,129,0.15); border-color:var(--dh-pos); color:var(--dh-pos); }
  .act-btn-disabled { border-style:dashed; color:var(--dh-dim); cursor:default; }
  .act-btn-disabled:hover { border-color:var(--dh-border); }
  /* Manual square-off — full width, only while the strategy holds something:
     a live Exit button on a flat card is an invitation to a misclick. */
  .exit-btn { width:100%; background:rgba(239,68,68,0.12); border-color:#b91c1c; color:#f87171; font-size:0.86rem; font-weight:700; }
  .card .act-btn.exit-btn:hover { background:rgba(239,68,68,0.22); border-color:#ef4444; color:#fca5a5; }
  .exit-btn:disabled { opacity:0.55; cursor:default; }
  .exit-btn[hidden] { display:none; }
  :root[data-theme="light"] .exit-btn { background:#fef2f2; border-color:#fca5a5; color:#b91c1c; }
  :root[data-theme="light"] .card .act-btn.exit-btn:hover { background:#fee2e2; border-color:#dc2626; color:#991b1b; }

  #rollup-body { margin-bottom:6px; }

  .pulse { display:inline-block; width:7px; height:7px; border-radius:50%; background:#10b981; margin-left:6px; animation:pulse 1.5s ease-in-out infinite; vertical-align:middle; }
  .pulse.stale { background:#f59e0b; animation:none; }
  @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }

  /* ── Light-theme overrides (top bar + wallets; cards and tables use --dh-*) ── */
  :root[data-theme="light"] .top-bar h1 { color:#1e293b; }
  :root[data-theme="light"] .top-bar .sub { color:#4b5769; }
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
      <h1>${autoFlipBack ? '⌂ Dashboard' : '📡 Real-Time Monitor'}</h1>
      <div class="sub">Paper trading · live · updates every 4s <span id="pulse" class="pulse" title="Last update"></span></div>
    </div>
    <div class="top-actions">
      ${!nseActive && strategies.some(s => !s.paperOnly) ? `<button type="button" class="nse-start" id="nse-start" title="Start every enabled paper strategy — same list as the Dashboard's Start All (Paper)" hidden>▶ Start All (Paper)</button>` : ''}
      ${strategies.some(s => !s.paperOnly) ? `<button type="button" class="stop-all" id="stop-nse" title="Stop every paper strategy on every market and square off open positions">🛑 Stop All</button>` : ''}
    </div>
  </div>
  <div class="stop-all-note" id="stop-all-note" hidden></div>

  <!-- Capital shortfall alert — filled by /realtime/capital. Entries are REFUSED
       when the pool runs dry; this is how you find out that one was. -->
  <div class="cap-alert" id="cap-alert" hidden></div>

  <!-- ① Today's P&L — open + closed, every enabled strategy; one chip per market. -->
  ${dashboardUI.heroHTML(marketGroups, { sub: 'Waiting for the first update…' })}
  ${dashboardUI.filterHTML(marketGroups)}

  <!-- ② Open positions, grouped by market. A card is shown only while that
       strategy holds a position (or its endpoint is dead); a strategy that
       traded and is flat again is in the summary below. -->
  <div class="dh-h"><h2>Open positions</h2><span class="dh-h-note" id="open-count"></span></div>
${cardsHtml}
  <div class="cards-empty" id="cards-empty" hidden>No open positions right now — a card appears here while a strategy is holding one. Today's trades are in the summary below.</div>

  <!-- ③ Today by market — every strategy with a position or a trade today, a
       subtotal on each market row and the grand TOTAL at the bottom. -->
  <div class="dh-h"><h2>Today by market</h2><span class="dh-h-note">Open + closed P&amp;L</span></div>
  <div id="rollup-body"><div class="dh-sum-empty">Loading…</div></div>

  <!-- ④ Broker money — after the close (hidden during market hours). Numbers
       come from /realtime/capital, so they include what open positions hold. -->
  ${pools.length ? `<div class="dh-h" id="wallets-h"><h2>Broker money (paper)</h2></div>\n  <div class="wallets" id="wallets">\n${walletsHtml}\n  </div>` : ''}

  ${dashboardUI.quickLinksHTML({ skip: ['realtime'], demo: require("../utils/demoMode").isDemo() })}
</main>

<script>
${modalJS()}
${dashboardUI.dashClientJS()}
const STRATEGY_KEYS    = ${strategyOrder};
const ENDPOINTS        = ${endpointsJson};
const STATUS_PAGES     = ${statusPagesJson};
const EXIT_URLS        = ${exitUrlsJson};
const STRATEGY_LABELS  = ${labelsJson};    // full names (confirmations, copied logs)
const SHORT_LABELS     = ${shortJson};     // names inside a market group
const STRATEGY_ACCENTS = ${accentsJson};
const MARKET_OF        = ${marketOfJson};  // strategy key → market group
const MARKETS          = ${marketsJson};   // [{ key, label }] — markets with an enabled strategy
const JSONL_PREFIX     = ${dayLogPrefixes};
const WALLET_POOLS     = ${poolsJson};
const STOP_URLS        = ${stopUrlsJson};
const PAPER_ONLY       = ${paperOnlyJson};   // paperOnly strategies — outside the start/stop roster
const FUTURES_KEYS     = ${futuresJson};     // futures:true strategies — futures legs, no premium
const mode = 'PAPER';
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

// EMA_RSI_ST uses unrealisedPnl, BB_RSI/PA use unrealised, ORB uses livePnl,
// EarlyBird uses openPnl (already summed across its several open positions).
function openPnl(d) {
  if (!d) return 0;
  const v = (d.unrealisedPnl !== undefined ? d.unrealisedPnl
          : d.unrealised   !== undefined ? d.unrealised
          : d.livePnl      !== undefined ? d.livePnl
          : d.openPnl      !== undefined ? d.openPnl
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

// futuresStrategy: the card belongs to a futures:true strategy, whose position is
// always a future even if its /status/data payload omits pos.isFutures.
function renderPositionStandard(d, pos, futuresStrategy) {
  const upnl = openPnl(d);
  const entryPrice = pos.entryPrice ?? pos.entrySpot ?? null;
  const optionEntry = pos.optionEntryLtp ?? null;
  const optionCurrent = pos.optionCurrentLtp ?? pos.currentOptLtp ?? null;
  const liveClose = pos.liveClose ?? d.lastTickPrice ?? null;
  const sideMult = pos.side === 'CE' ? 1 : (pos.side === 'PE' ? -1 : 0);
  const pointsMoved = pos.pointsMoved != null
    ? pos.pointsMoved
    : (liveClose != null && entryPrice != null && sideMult ? (liveClose - entryPrice) * sideMult : null);
  // A futures leg has no premium: CE reads LONG, PE reads SHORT, and the two
  // option-premium rows (and the premium %) are dropped rather than shown as a
  // permanent em-dash.
  // Truthy, not strict ===: every producer sends a real boolean today, but a
  // string "true" arriving from JSON would silently render a future as an
  // option — degrade toward the loud case, not the wrong one.
  const isFut = !!pos.isFutures || !!futuresStrategy;
  const pct = isFut ? null : pos.optPremiumPct != null
    ? pos.optPremiumPct
    : (optionEntry && optionCurrent ? ((optionCurrent - optionEntry) / optionEntry) * 100 : null);
  const sideClass = pos.side === 'CE' || pos.side === 'PE' ? pos.side : '';
  const sideTxt = isFut ? (pos.side === 'CE' ? 'LONG' : pos.side === 'PE' ? 'SHORT' : (pos.side || '')) : (pos.side || '');
  // Entry / Current are what the P&L is priced on: the option premium for an
  // option, the contract itself for a future. The underlying's spot move sits
  // on the line below for options, so nothing the old grid showed is lost.
  const kv = (k, v, klass) => '<div class="kv"><div class="k">' + k + '</div><div class="v' + (klass ? ' ' + klass : '') + '">' + v + '</div></div>';
  return \`
    <div class="pos-block">
      <div class="pos-top">
        <span class="pos-side \${sideClass}">\${escapeHtml(sideTxt)}</span>
        <span class="pos-symbol">\${escapeHtml(pos.symbol || '')}</span>
      </div>
      <div class="pnl-big \${cls(upnl)}">\${fmtINR(upnl)}\${pct !== null ? '<span class="pct">' + (pct >= 0 ? '+' : '') + Number(pct).toFixed(2) + '%</span>' : ''}</div>
      <div class="pos-kv">
        \${kv('Entry', fmtNum(isFut ? entryPrice : optionEntry))}
        \${kv('Current', fmtNum(isFut ? liveClose : optionCurrent))}
        \${kv('Points', fmtNum(pointsMoved), cls(pointsMoved))}
        \${kv('Qty', pos.qty ?? '—')}
      </div>
      <div class="pos-more">
        \${isFut ? '' : '<span>Spot ' + fmtNum(entryPrice) + ' → ' + fmtNum(liveClose) + '</span>'}
        <span>Entered \${escapeHtml(pos.entryTime || '—')}</span>
      </div>
    </div>\`;
}

// EarlyBird holds MANY cash-equity positions at once, so it cannot use the
// option-shaped single-position block above (no strike, no expiry, no premium,
// and qty is a SHARE COUNT rather than lots). It gets an aggregate header —
// how many are open and the combined unrealised P&L — followed by one compact
// line per stock. A SHORT is a real intraday short sale, so its points moved is
// (entry − live) rather than (live − entry).
function renderPositionsEarlyBird(d, list, strategy) {
  const total = openPnl(d);
  let rows = '';
  for (const p of list) {
    if (!p) continue;
    // CE/PE = the folded-in NIFTY option leg, priced on the premium: a bought
    // PE gains as its own price rises, so it moves LONG-wise on its own ltp.
    const side = ['LONG', 'SHORT', 'CE', 'PE'].includes(p.side) ? p.side : '';
    const entry = typeof p.entryPrice === 'number' && Number.isFinite(p.entryPrice) ? p.entryPrice : null;
    const ltp = typeof p.ltp === 'number' && Number.isFinite(p.ltp) ? p.ltp : null;
    const qty = typeof p.qty === 'number' && Number.isFinite(p.qty) ? p.qty : null;
    const mult = side === 'SHORT' ? -1 : (side ? 1 : 0);
    const pts = typeof p.pointsMoved === 'number' && Number.isFinite(p.pointsMoved)
      ? p.pointsMoved
      : (entry !== null && ltp !== null && mult ? (ltp - entry) * mult : null);
    const upnl = typeof p.livePnl === 'number' && Number.isFinite(p.livePnl)
      ? p.livePnl
      : (pts !== null && qty !== null ? pts * qty : null);
    const isOpt = side === 'CE' || side === 'PE';
    rows += \`<div class="eb-row">
      <span class="pos-side \${isOpt ? side : (side === 'LONG' ? 'CE' : (side === 'SHORT' ? 'PE' : ''))}">\${side || '—'}</span>
      <span class="eb-sym">\${escapeHtml(p.symbol || '—')}</span>
      <span class="eb-qty">\${qty !== null ? qty + (isOpt ? ' qty' : ' sh') : '—'}</span>
      <span class="eb-px">\${fmtNum(entry)} → \${fmtNum(ltp)}</span>
      <span class="eb-pts \${cls(pts)}">\${fmtNum(pts)}</span>
      <span class="eb-pnl \${cls(upnl)}">\${upnl === null ? '—' : fmtINR(upnl)}</span>
      <button type="button" class="eb-exit" title="Square off \${escapeHtml(p.symbol || '')} only"
              data-symbol="\${escapeHtml(p.symbol || '')}"
              onclick="exitPosition('\${strategy || 'EARLYBIRD'}', this, this.dataset.symbol)">EXIT</button>
    </div>\`;
  }
  return \`
    <div class="pos-block">
      <div class="eb-head">
        <span class="pos-symbol">\${list.length} open position\${list.length === 1 ? '' : 's'}\${(() => {
          const opt = list.some(p => p && (p.side === 'CE' || p.side === 'PE'));
          const stk = list.some(p => p && (p.side === 'LONG' || p.side === 'SHORT'));
          return opt && stk ? ' · cash equity + option' : (opt ? ' · NIFTY option' : ' · cash equity');
        })()}</span>
      </div>
      <div class="pnl-big \${cls(total)}">\${fmtINR(total)}</div>
      <div class="eb-list">\${rows}</div>
    </div>\`;
}

// EarlyBird reports positions[]; everything else reports a single position.
// Returned as an array either way so renderColumn has one code path.
// EarlyBird's NIFTY OPTION leg is NOT in positions[] — it sits in its own
// option.position field — so it must be folded in here, or an option-mode day
// paints "FLAT" on the card while the rollup below shows its open P&L. It is
// normalised to the same {symbol, side, entryPrice, ltp, qty, livePnl} shape the
// stock rows use, priced on the PREMIUM (its entry/ltp are option prices).
function openPositionsOf(d) {
  if (!d) return [];
  if (Array.isArray(d.positions)) {
    const list = d.positions.filter(Boolean);
    const op = d.option && d.option.position ? d.option.position : null;
    if (op) {
      list.push({
        symbol: op.symbol,
        side: op.optionSide || op.side,
        entryPrice: op.optionEntryLtp,
        ltp: op.optionLtp,
        qty: op.qty,
        livePnl: op.livePnl,
      });
    }
    return list;
  }
  return d.position ? [d.position] : [];
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
    // An endpoint that dies mid-position must take its Exit button with it: the
    // card no longer knows what is open, and the /exit call would go to the same
    // unreachable engine. It comes back with the next successful poll.
    const offEl = document.getElementById('exit-' + strategy);
    if (offEl) offEl.hidden = true;
    // A dead endpoint stays on screen — hiding it would look like a quiet
    // strategy instead of a broken one.
    showCard(strategy, true);
    return;
  }

  badgeEl.className = 'badge ' + (d.running ? 'run' : 'stop');
  badgeEl.textContent = d.running ? 'RUNNING' : 'STOPPED';

  const openList = openPositionsOf(d);
  if (Array.isArray(d.positions)) {
    // Multi-position strategy (EarlyBird): aggregate block, never a single row.
    bodyEl.innerHTML = openList.length
      ? renderPositionsEarlyBird(d, openList, strategy)
      : \`<div class="flat-block">FLAT — no open positions</div>\`;
  } else if (openList.length) {
    bodyEl.innerHTML = renderPositionStandard(d, openList[0], FUTURES_KEYS.indexOf(strategy) !== -1);
  } else {
    bodyEl.innerHTML = \`<div class="flat-block">FLAT — no open position</div>\`;
  }

  const sessPnl = todayClosed(d);
  statsEl.innerHTML = \`
    <div class="stat"><div class="lbl">Closed today</div><div class="val \${cls(sessPnl)}">\${fmtINR(sessPnl)}</div></div>
    <div class="stat"><div class="lbl">W / L</div><div class="val">\${todayWins(d)} / \${todayLosses(d)}</div></div>
    <div class="stat"><div class="lbl">Trades</div><div class="val">\${todayTrades(d)}</div></div>\`;

  const ltp = d.lastTickPrice ? fmtNum(d.lastTickPrice) : '—';
  const tickTime = d.lastTickTime || '';
  metaEl.innerHTML = \`<span>LTP \${ltp}\${tickTime ? ' · ' + tickTime : ''}</span><span>\${d.feedNote ? escapeHtml(d.feedNote) : (d.tickCount ?? 0) + ' ticks'}</span>\`;

  // Worth a card only while money is actually at risk RIGHT NOW. A strategy that
  // traded and is now flat drops back to the rollup table below — keeping its
  // card up filled the screen with finished business and pushed the live
  // positions off it.
  showCard(strategy, openList.length > 0);

  // The Exit button lives and dies with the position. It is hidden — not
  // disabled — when flat, because a greyed square-off button on a card that
  // holds nothing still reads as "there is something to close".
  const exitEl = document.getElementById('exit-' + strategy);
  if (exitEl) {
    const canExit = openList.length > 0 && !isStale(d);
    exitEl.hidden = !canExit;
    if (canExit) {
      exitEl.disabled = false;
      // EarlyBird can hold several legs at once; say so, since this button
      // closes all of them and the per-row EXIT closes just one.
      exitEl.textContent = openList.length > 1
        ? '🚪 Exit All (' + openList.length + ')'
        : '🚪 Exit Trade';
    }
  }
}

// Cards are hidden, not removed, so the poll can bring one back the moment its
// strategy enters — and the copy/open buttons keep their handlers throughout.
function showCard(strategy, visible) {
  const card = document.getElementById('card-' + strategy);
  if (card) card.hidden = !visible;
}

// A market section shows only while one of its cards does; the empty note and
// the count follow the market filter, so "no open positions" never hides one
// that is open in a market the filter is not showing.
function renderCardsEmpty() {
  const cur = dhMarket();
  let open = 0, openHere = 0;
  for (const m of MARKETS) {
    const sec = document.getElementById('rt-mkt-' + m.key);
    const n = STRATEGY_KEYS.filter(k => MARKET_OF[k] === m.key).filter(k => {
      const card = document.getElementById('card-' + k);
      return card && !card.hidden;
    }).length;
    if (sec) sec.hidden = n === 0;
    open += n;
    if (cur === 'ALL' || cur === m.key) openHere += n;
  }
  const box = document.getElementById('cards-empty');
  if (box) {
    box.hidden = openHere > 0;
    const where = cur === 'ALL' ? '' : ' in ' + ((MARKETS.find(m => m.key === cur) || {}).label || cur);
    box.textContent = 'No open positions' + where + ' right now'
      + (cur !== 'ALL' && open > openHere ? ' — ' + (open - openHere) + ' open in other markets (tap All markets).' : ' — a card appears here while a strategy is holding one.');
  }
  const cnt = document.getElementById('open-count');
  if (cnt) cnt.textContent = openHere ? openHere + ' open' : '';
}

// Rows for the shared summary table (utils/dashboardUI.js dhSummary). A
// strategy earns a line once it has money at risk or a trade today; the rest are
// "quiet" — still counted in their market's subtotal and the TOTAL, just not
// drawn. openPositionsOf (not d.position) decides "at risk": EarlyBird reports
// positions[] plus an option leg and never sets d.position.
function rollupRows(all) {
  return STRATEGY_KEYS.map(key => {
    const d = all[key];
    const base = { key, label: SHORT_LABELS[key] || key, market: MARKET_OF[key], accent: STRATEGY_ACCENTS[key],
                   href: (STATUS_PAGES[mode] || {})[key] };
    if (!d) return Object.assign(base, { offline: true });
    const trades = todayTrades(d);
    return Object.assign(base, {
      running: !!d.running, open: +openPnl(d) || 0, closed: todayClosed(d),
      trades: +trades || 0, w: +todayWins(d) || 0, l: +todayLosses(d) || 0,
      quiet: !openPositionsOf(d).length && !(trades > 0),
    });
  });
}

let lastAll = null;
function renderRollup(all) {
  if (!all) return;
  const box = document.getElementById('rollup-body');
  const out = dhSummary(rollupRows(all), MARKETS, { market: dhMarket() });
  if (box) box.innerHTML = out.html || '<div class="dh-sum-empty">No strategy is enabled for this market.</div>';
}

// Today's P&L hero — open + closed of every enabled strategy, split by market.
// A dead endpoint adds nothing (its numbers are unknown, not zero, so the sub
// line says how many are missing).
function renderHero(all) {
  const byMarket = {};
  let open = 0, trades = 0, offline = 0;
  for (const k of STRATEGY_KEYS) {
    const d = all[k];
    if (!d) { offline++; continue; }
    const m = MARKET_OF[k];
    byMarket[m] = (byMarket[m] || 0) + (+openPnl(d) || 0) + todayClosed(d);
    open += openPositionsOf(d).length;
    trades += +todayTrades(d) || 0;
  }
  const t = new Date().toLocaleTimeString('en-IN', { hourCycle:'h23', timeZone:'Asia/Kolkata' });
  dhHero(byMarket, open + ' open position' + (open === 1 ? '' : 's') + ' · ' + trades + ' trade' + (trades === 1 ? '' : 's') + ' today'
    + (offline ? ' · ' + offline + ' not responding' : '') + ' · updated ' + t);
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
  const box = document.getElementById('wallets');
  if (box) box.style.display = isMarketRunning() ? 'none' : '';
  const head = document.getElementById('wallets-h');
  if (head) head.style.display = isMarketRunning() ? 'none' : '';
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

// Capital alert — the broker pool could not fund an entry, so the entry was
// REFUSED (capitalPool.gate). The strategy log carries the error line; this
// banner is the cross-strategy view of which signals were dropped and why.
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
    const t = new Date(a.ts).toLocaleTimeString('en-IN', { hourCycle:'h23' });
    return '<li><span class="t">' + t + '</span> — ' + a.label + ' ' + (a.side || '')
         + ' refused — needed ' + fmtINR(a.cost) + ', pool had ' + fmtINR(a.available)
         + ' (short ' + fmtINR(a.short) + ')</li>';
  }).join('');

  box.innerHTML =
      '<div class="cap-alert-head">❌ Paper capital pool exhausted — entries are being refused</div>'
    + '<div class="cap-alert-sub">'
    + (poolLine || 'A paper entry cost more than the broker pool had left, so it was not taken.')
    + '<br>Signals will keep being dropped until a position exits or the pool is topped up. Raise the investment amount in Settings → Instrument &amp; Backtest → Capital, or reset the paper history for that strategy.</div>'
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
    STRATEGY_KEYS.map(k => fetchOne(eps[k]).then(d => (d && d.monitor) ? d.monitor : d))
      .concat(fetchOne('/realtime/capital'))
  );
  const capital = results.pop();
  const all = {};
  STRATEGY_KEYS.forEach((k, i) => { all[k] = results[i]; renderColumn(k, results[i]); });
  lastAll = all;
  // The pulse goes amber when nothing answered — a stale screen must look stale.
  const pulse = document.getElementById('pulse');
  if (pulse) pulse.classList.toggle('stale', STRATEGY_KEYS.length > 0 && STRATEGY_KEYS.every(k => !all[k]));
  renderNseStart(all);
  renderCardsEmpty();
  renderHero(all);
  renderRollup(all);
  renderPools(capital);
  renderCapitalAlert(capital);
}

// ── Stop All ────────────────────────────────────────────────────────────────
// Fans out GET /stop across its own paper strategies. Each engine's own /stop is reused verbatim, so
// an open position is squared off by the same code path its Stop button uses.
//
// Two clicks: the first arms, the second fires — a stray click on a phone must
// not be able to flatten the book.
const STOP_SCOPES = {
  nse: { btnId: 'stop-nse', label: '🛑 Stop All',     name: 'Stop All',
         what: 'every paper strategy on <b>every market</b>',
         none: 'no paper strategy is running',
         has: t => PAPER_ONLY.indexOf(t.key) === -1 },
};
let stopArmed = null;   // the scope waiting for its confirming second click
let stopArmTimer = null;
let stopBusy = false;   // a sweep is in flight — btn.disabled alone does not stop a key-repeat

function disarmStop() {
  if (stopArmTimer) { clearTimeout(stopArmTimer); stopArmTimer = null; }
  if (!stopArmed) return;
  const sc = STOP_SCOPES[stopArmed];
  stopArmed = null;
  const btn = document.getElementById(sc.btnId);
  if (btn) { btn.classList.remove('armed'); btn.textContent = sc.label; }
}

function stopNote(html) {
  const box = document.getElementById('stop-all-note');
  if (!box) return;
  box.innerHTML = html;
  box.hidden = !html;
}

async function stopScope(scope) {
  const sc = STOP_SCOPES[scope];
  const btn = document.getElementById(sc.btnId);
  if (!btn) return;
  if (stopBusy) return;   // never start a second sweep over a running one

  if (stopArmed !== scope) {
    disarmStop();         // the other button may be armed — only one at a time
    stopArmed = scope;
    btn.classList.add('armed');
    btn.textContent = '🛑 Click again to confirm';
    stopNote('This stops ' + sc.what + ', and squares off any open position. Click ' + sc.name + ' again within 6s to confirm.');
    stopArmTimer = setTimeout(() => { disarmStop(); stopNote(''); }, 6000);
    return;
  }

  if (stopArmTimer) { clearTimeout(stopArmTimer); stopArmTimer = null; }
  stopArmed = null;
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
  await Promise.all(STOP_URLS.filter(sc.has).map(async t => {
    try {
      const r = await fetch(t.statusUrl, { cache:'no-store' });
      if (!r.ok) { live.push(t); return; }          // can't tell → stop it anyway
      const d = await r.json();
      if (!d) { live.push(t); return; }
      if (d.running) live.push(t);
    } catch (e) { live.push(t); }
  }));

  if (!live.length) {
    stopNote('<b>Nothing to stop</b> — ' + sc.none + '.');
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
      // 400 = "not running" — it raced us to idle, which is the outcome we
      // wanted anyway.
      if (r.ok || r.status === 400) stopped.push(t);
      else failed.push({ ...t, status: r.status });
    } catch (e) {
      failed.push({ ...t, status: 0 });
    }
  }

  const name = t => STRATEGY_LABELS[t.key] + ' ' + t.mode;
  let msg = '<b>' + sc.name + ' finished.</b> ';
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
    btn.textContent = sc.label;
  }
}

document.getElementById('stop-nse')?.addEventListener('click', () => stopScope('nse'));

// ── Start All (Paper) ───────────────────────────────────────────────────────
// Only rendered while no NSE session is up. Offered on weekdays until 15:30 IST,
// and hidden again once any NSE strategy reports running.
let nseBusy = false;
function nseStartWindow() {
  const ist = new Date(Date.now() + 19800000);
  const day = ist.getUTCDay(), mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day !== 0 && day !== 6 && mins < 15 * 60 + 30;
}
function renderNseStart(all) {
  const btn = document.getElementById('nse-start');
  const nseRunning = STRATEGY_KEYS.some(k => PAPER_ONLY.indexOf(k) === -1 && all[k] && all[k].running);
  // Stop All stays up all through market hours (it is the panic button). After the 15:30 close it hides once
  // nothing runs here.
  const stop = document.getElementById('stop-nse');
  if (stop && !stopBusy) stop.hidden = !nseRunning && !nseStartWindow();
  if (!btn || nseBusy) return;
  btn.hidden = nseRunning || !nseStartWindow();
}
async function startAllNse() {
  const btn = document.getElementById('nse-start');
  if (!btn || nseBusy) return;
  nseBusy = true;
  btn.disabled = true; btn.textContent = '⏳ Checking strategies…';
  const ok = [], bad = [];
  try {
    // The same roster the Dashboard's button starts from.
    const r = await fetch('/api/start-all-roster', { cache:'no-store' });
    const modes = r.ok ? ((await r.json()).modes || []) : [];
    if (!modes.length) { await showAlert({ icon:'⚠️', title:'Nothing to start', message:'No strategy is enabled in Settings.' }); return; }
    // Sequential, like the Dashboard: parallel starts race each other for the socket.
    for (const m of modes) {
      if (!m || !m.paper || m.paperOff) continue;   // its Paper toggle is off — /start would refuse
      btn.textContent = '⏳ Starting ' + m.label + '…';
      try {
        const res = await secretFetch(m.paper);
        if (!res) { bad.push(m.label + ' — cancelled'); break; }   // API-secret prompt dismissed
        let body = null; try { body = await res.json(); } catch (_) {}
        if (res.ok && (!body || body.success !== false)) ok.push(m.label);
        else bad.push(m.label + ' — ' + ((body && (body.error || body.message)) || 'HTTP ' + res.status));
      } catch (e) { bad.push(m.label + ' — ' + ((e && e.message) || 'network error')); }
    }
    await showAlert({ icon: bad.length ? '⚠️' : '▶', title: 'Start All (Paper)',
      message: (ok.length ? '✅ Started: ' + ok.join(', ') : '') + (bad.length ? (ok.length ? '\\n\\n' : '') + '❌ ' + bad.join('\\n❌ ') : '') });
  } catch (e) {
    await showAlert({ icon:'⚠️', title:'Start All (Paper)', message:(e && e.message) || 'Request failed' });
  } finally {
    nseBusy = false;
    btn.disabled = false; btn.textContent = '▶ Start All (Paper)';
    // Reload so the NSE cards, toggle state and this button all reflect the
    // new session.
    if (ok.length) location.reload(); else poll();
  }
}
document.getElementById('nse-start')?.addEventListener('click', startAllNse);

async function fetchText(url) {
  try {
    const r = await fetch(url, { cache:'no-store' });
    if (!r.ok) return { ok:false, status:r.status, text:'' };
    return { ok:true, status:200, text: await r.text() };
  } catch (e) {
    return { ok:false, status:0, text:'', err:String(e) };
  }
}

// Manual square-off from the monitor. Confirms first, then hits the strategy's /exit through secretFetch — the exit routes
// are NOT in app.js OPEN_PATHS, so a plain fetch or a link navigation would 403.
//
// symbol is EarlyBird-only: its /exit takes ?symbol= to close one leg and closes
// the whole book when omitted. Every other engine ignores the parameter, so it is
// only ever sent when a per-row button asked for it.
async function exitPosition(strategy, btn, symbol) {
  const label = STRATEGY_LABELS[strategy] || strategy;
  const what = symbol ? symbol : (strategy === 'EARLYBIRD' ? 'ALL open positions' : 'the open position');
  const ok = await showConfirm({
    icon: '🚪',
    title: 'Exit ' + label + '?',
    message: 'Square off ' + what + ' now at market, in ' + mode + ' mode.\\n\\n'
           + 'This closes the paper position and books its P&L.',
    confirmText: 'Exit now',
  });
  if (!ok) return;

  const base = (EXIT_URLS[mode] || {})[strategy];
  if (!base) {
    await showAlert({ icon: '⚠️', title: 'No exit route', message: 'No /exit endpoint is configured for ' + label + ' in ' + mode + ' mode.', btnClass: 'modal-btn-danger' });
    return;
  }
  const url = symbol ? base + '?symbol=' + encodeURIComponent(symbol) : base;

  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Exiting…';
  // The 4s poll is paused across the round trip: a repaint mid-exit rebuilds the
  // position block and destroys the very button being clicked, which would throw
  // on the re-enable below and lose the result message.
  if (timer) { clearInterval(timer); timer = null; }
  let res = null, err = null;
  try {
    res = await secretFetch(url);
  } catch (e) {
    err = (e && e.message) || 'Network error';
  }
  timer = setInterval(pollIfVisible, 4000);

  if (err) {
    btn.disabled = false; btn.textContent = orig;
    await showAlert({ icon: '⚠️', title: 'Exit failed', message: err, btnClass: 'modal-btn-danger' });
    return;
  }
  // null = the user cancelled the API-secret prompt; nothing was sent.
  if (!res) { btn.disabled = false; btn.textContent = orig; return; }
  if (!res.ok) {
    btn.disabled = false; btn.textContent = orig;
    await showAlert({ icon: '⚠️', title: 'Exit failed', message: label + ' /exit returned HTTP ' + res.status + '.', btnClass: 'modal-btn-danger' });
    return;
  }
  // Left disabled and labelled: the next poll (≤4s) either clears the position —
  // taking the button with it — or brings it back enabled if the engine refused.
  btn.textContent = '✓ Exit sent';
  poll();
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
dhMarketInit(MARKETS.map(m => m.key), () => { renderCardsEmpty(); renderRollup(lastAll); });
poll();
// Background tabs skip the ~16-call fan-out; one catch-up poll when the tab is shown again.
function pollIfVisible() { if (!document.hidden) poll(); }
timer = setInterval(pollIfVisible, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && timer) poll(); });

// When rendered at /, flip back to normal dashboard the moment no session is active.
const AUTO_FLIP_BACK = ${autoFlipBack ? "true" : "false"};
if (AUTO_FLIP_BACK) {
  setInterval(async () => {
    if (document.hidden) return;
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
// Derived rows (registry × running pairs) — tests compare them to the registry.
module.exports.STRATEGY_DEFS = STRATEGY_DEFS;
module.exports.enabledStrategies = enabledStrategies;

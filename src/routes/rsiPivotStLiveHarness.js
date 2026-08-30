/**
 * RSI_PIVOT_ST LIVE (HARNESS) — /rsi-pivot-st-live
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs RSI_PIVOT_ST LIVE by wrapping its PAPER route with the live harness:
 *   1. Install harness (registers notify entry/exit hooks → real Zerodha orders)
 *   2. Trigger /rsi-pivot-st-paper/start programmatically (paper runs unchanged)
 *   3. As paper decides the entry/exit, the harness places real Zerodha orders
 *   4. /stop reverses: stop paper + uninstall harness
 *
 * This guarantees LIVE = PAPER by construction — the strategy/exit logic is
 * whatever rsiPivotStPaper says it is (single source of truth).
 *
 * NOTE ON BROKERS: the DATA comes from Fyers (history + quotes, as everywhere in
 * this repo) but the ORDERS go to Zerodha, exactly like EMA_RSI_ST. That is why
 * /start checks BOTH — a Zerodha session for the orders, and the paper route
 * separately verifies Fyers for the candles it decides on.
 *
 * TRIPLE-GATED to dry-run — real orders require ALL of:
 *   RSI_PIVOT_ST_LIVE_ENABLED=true   (per-strategy live enable, default false)
 *   LIVE_HARNESS_DRY_RUN=false       (global kill-switch, default true)
 *   RSI_PIVOT_ST_LIVE_DRY_RUN!=true  (per-strategy dry-run override)
 * plus an authenticated Zerodha session. By default NOTHING places a real order.
 *
 * This strategy has NEVER traded — not live, not on paper. Every threshold in it
 * is the user's stated rule, not a fitted value, and no backtest has been run
 * against it. Collect clean paper sessions and diff them against a recorded
 * /replay before touching any gate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express      = require("express");
const router       = express.Router();

const liveHarness   = require("../services/liveHarness");
const zerodhaBroker = require("../services/zerodhaBroker");
const rsiPaperRoute = require("./rsiPivotStPaper");
const liveDryRun    = require("../utils/liveDryRun");
const rsiPivotStrategy = require("../strategies/rsi_pivot_st");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

// ── Programmatic invoker for the rsiPivotStPaper express router ──────────────
function _invokePaperRoute(method, urlPath) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const finish = (payload) => { if (!resolved) { resolved = true; resolve(payload); } };
    const req = {
      method: method.toUpperCase(),
      url: urlPath, path: urlPath, query: {},
      headers: { host: "localhost" },
      get: () => undefined,
      app: { get: () => undefined, set: () => {} },
    };
    const res = {
      statusCode: 200, _headers: {}, _body: null,
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this._headers[k] = v; return this; },
      setHeader(k, v) { this._headers[k] = v; return this; },
      json(b) { this._body = b; finish({ status: this.statusCode, body: b }); return this; },
      send(b) { this._body = b; finish({ status: this.statusCode, body: b }); return this; },
      redirect(u) { finish({ status: 302, redirect: u }); },
      end(b) { finish({ status: this.statusCode, body: b }); return this; },
    };
    const stack = rsiPaperRoute.stack || [];
    let i = 0;
    function next(err) {
      if (err) return reject(err);
      if (i >= stack.length) return finish({ status: 404, body: "no matching route" });
      const layer = stack[i++];
      try {
        if (layer.route && layer.route.path === urlPath) {
          const handler = layer.route.stack.find(s => s.method === method.toLowerCase());
          if (handler) {
            const ret = handler.handle(req, res, next);
            if (ret && typeof ret.catch === "function") ret.catch(next);
            return;
          }
        }
        next();
      } catch (e) { next(e); }
    }
    next();
  });
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.get("/status/data", async (req, res) => {
  const cfg = liveHarness.getConfig("RSI_PIVOT_ST-LIVE");
  let paperData = {};
  try {
    const resp = await _invokePaperRoute("GET", "/status/data");
    if (resp && resp.body && typeof resp.body === "object") paperData = resp.body;
  } catch (_) {}
  res.json({
    ...paperData,
    installed:    liveHarness.isInstalled("RSI_PIVOT_ST-LIVE"),
    config:       cfg,
    recentEvents: liveHarness.getRecentEvents(50, "RSI_PIVOT_ST-LIVE"),
  });
});

router.get("/start", async (req, res) => {
  if (liveHarness.isInstalled("RSI_PIVOT_ST-LIVE")) {
    return res.status(409).json({ success: false, error: "RSI_PIVOT_ST-LIVE harness is already running. Stop it first." });
  }

  if (String(process.env.RSI_PIVOT_ST_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "RSI Pivot ST mode is disabled. Enable it in Settings first." });
  }

  const dryRun = liveDryRun.isDryRun("RSI_PIVOT_ST");

  if (!liveDryRun.isDryRun() && String(process.env.RSI_PIVOT_ST_LIVE_ENABLED || "false").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "Live trading disabled. Set RSI_PIVOT_ST_LIVE_ENABLED=true to place real orders." });
  }

  // Orders go to ZERODHA, so that is the session that must exist before real
  // orders are allowed. A dry run needs no broker session at all.
  if (!dryRun && !zerodhaBroker.isAuthenticated()) {
    return res.status(401).json({ success: false, error: "Zerodha not authenticated for live orders. Complete Zerodha login first." });
  }

  let installed;
  try {
    installed = liveHarness.installHarness({
      mode:       "RSI_PIVOT_ST-LIVE",
      modeTag:    "RSI_PIVOT_ST-PAPER",   // the paper route's mode field in notify payloads
      broker:     "zerodha",
      dryRun,
      liveLogKey: null, // live trades are not logged to disk
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }

  try {
    const startResp = await _invokePaperRoute("GET", "/start");
    if (startResp.status >= 400 && startResp.status !== 302) {
      liveHarness.uninstallHarness("RSI_PIVOT_ST-LIVE");
      return res.status(startResp.status).json({
        success: false,
        error:   `rsiPivotStPaper /start failed: ${JSON.stringify(startResp.body).slice(0, 300)}`,
      });
    }
    return res.json({
      success: true,
      mode:    installed.dryRun ? "DRY-RUN" : "LIVE (real orders)",
      message: installed.dryRun
        ? "RSI_PIVOT_ST-LIVE harness started in DRY-RUN. Decisions match paper, no real orders placed. Watch /rsi-pivot-st-live."
        : "RSI_PIVOT_ST-LIVE harness started — real Zerodha orders WILL be placed.",
      paperStartResp: startResp,
    });
  } catch (err) {
    liveHarness.uninstallHarness("RSI_PIVOT_ST-LIVE");
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/stop", async (req, res) => {
  if (!liveHarness.isInstalled("RSI_PIVOT_ST-LIVE")) {
    return res.status(400).json({ success: false, error: "Harness not installed." });
  }
  try {
    const stopResp = await _invokePaperRoute("GET", "/stop");
    liveHarness.uninstallHarness("RSI_PIVOT_ST-LIVE");
    return res.json({ success: true, message: "RSI_PIVOT_ST-LIVE harness stopped + paper session ended.", paperStopResp: stopResp });
  } catch (err) {
    try { liveHarness.uninstallHarness("RSI_PIVOT_ST-LIVE"); } catch (_) {}
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/", (req, res) => {
  const cfg = liveHarness.getConfig("RSI_PIVOT_ST-LIVE");
  const installed = liveHarness.isInstalled("RSI_PIVOT_ST-LIVE");
  const dryRunCurrent = liveDryRun.isDryRun("RSI_PIVOT_ST");
  const scfg = rsiPivotStrategy.getConfig();
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RSI Pivot ST LIVE (Harness) — Real orders via Paper engine</title>
${faviconLink()}
<style>
${sidebarCSS()}
${modalCSS()}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin:0; background:#0b1220; color:#e2e8f0; }
.main { margin-left:200px; padding:24px; max-width:900px; }
@media(max-width:768px){ .main{ margin-left:0; padding:14px; } }
h1 { font-size:1.3rem; margin:0 0 4px; color:#f1f5f9; }
.card { background:#111827; border:1px solid #1e293b; border-radius:8px; padding:16px; margin-bottom:16px; }
.warn { background:#7f1d1d; border:1px solid #991b1b; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fee2e2; }
.warn-soft { background:#78350f; border:1px solid #92400e; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fef3c7; }
button { background:#c2410c; color:#fff; border:0; padding:8px 18px; border-radius:6px; cursor:pointer; font-size:0.85rem; margin-right:8px; }
button:hover { background:#ea580c; }
button.stop { background:#475569; }
pre { background:#0a0f1c; padding:12px; border-radius:6px; overflow:auto; font-size:0.7rem; color:#cbd5e1; max-height:300px; }
.row { display:flex; gap:16px; flex-wrap:wrap; }
.label { font-size:0.7rem; color:var(--muted-1,#8ba1c2); text-transform:uppercase; letter-spacing:0.05em; }
.val   { font-size:0.95rem; color:#e2e8f0; }
.section-title { font-size:0.7rem; color:var(--muted-1,#8ba1c2); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px; font-weight:600; }
</style>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
</head>
<body>
${buildSidebar('rsiPivotStLive', false)}
<div class="main">
  <h1>● RSI PIVOT ST LIVE — via Paper Harness</h1>

  <div class="warn-soft"><strong>⚠️ Never traded.</strong> Zero paper sessions and zero live trades. Every threshold — RSI ${scfg.rsiCeMin}/${scfg.rsiPeMax}, the ${scfg.premiumStopPct}% premium floor, SuperTrend(${scfg.stPeriod},${scfg.stMultiplier}) — is a stated rule, not a fitted value, and no backtest has validated any of them. Run clean paper days and diff them against a recorded <code>/replay</code> session before you even consider a live gate.</div>

  ${dryRunCurrent
    ? '<div class="warn-soft"><strong>🧪 DRY-RUN mode</strong> — no real orders will be placed. Verify Live decisions match Paper on a recorded <code>/replay</code> session, then set <code>LIVE_HARNESS_DRY_RUN=false</code>, <code>RSI_PIVOT_ST_LIVE_ENABLED=true</code> (and ensure <code>RSI_PIVOT_ST_LIVE_DRY_RUN</code> is not true) in Settings to enable real Zerodha orders.</div>'
    : '<div class="warn"><strong>🔴 LIVE mode</strong> — real Zerodha orders WILL be placed when the paper engine signals. To switch back to dry-run, set <code>LIVE_HARNESS_DRY_RUN=true</code> in Settings.</div>'
  }

  <div class="card">
    <div class="row">
      <div style="flex:1;min-width:120px;">
        <div class="label">Status</div>
        <div class="val" id="status-text">${installed ? '🟢 RUNNING' : '⚪ STOPPED'}</div>
      </div>
      <div style="flex:1;min-width:120px;">
        <div class="label">Mode</div>
        <div class="val">${cfg && cfg.dryRun ? 'DRY-RUN' : (cfg ? '🔴 LIVE' : '—')}</div>
      </div>
      <div style="flex:1;min-width:120px;">
        <div class="label">Broker</div>
        <div class="val">${cfg ? cfg.broker : 'zerodha'}</div>
      </div>
      <div style="flex:2;min-width:220px;">
        <div class="label">Rules</div>
        <div class="val" style="font-size:0.8rem;">NIFTY ${scfg.resolutionMins}m. Yesterday's H/L/C fixes today's Standard Pivots. A candle that CROSSES and CLOSES above R1 with RSI&gt;${scfg.rsiCeMin} buys a CE; below S1 with RSI&lt;${scfg.rsiPeMax} buys a PE. Strike = ${scfg.strikeMode} at ${scfg.strikePct}% of spot. SuperTrend(${scfg.stPeriod},${scfg.stMultiplier}) stops <b>${scfg.stSides}</b>; the ${scfg.premiumStopPct}% premium floor applies to <b>${scfg.premiumStopSides}</b>. No profit target.${["CE","PE"].filter(x => rsiPivotStrategy.isStoplessSide(x, scfg)).map(x => ` <b style="color:#f85149;">⚠️ ${x} trades currently have NO stop — only the EOD square-off can close them.</b>`).join("")}</div>
      </div>
    </div>
    <div style="margin-top:16px;">
      <button onclick="startSession()" id="start-btn"${installed ? ' disabled' : ''}>▶ Start (${dryRunCurrent ? 'DRY-RUN' : 'LIVE'})</button>
      <button onclick="stopSession()" id="stop-btn" class="stop"${!installed ? ' disabled' : ''}>■ Stop</button>
    </div>
  </div>

  <div class="card">
    <div class="section-title">Today — the levels and the trigger</div>
    <div class="row" id="rsi-live-context"><div class="val">Loading…</div></div>
  </div>

  <div class="card">
    <div class="section-title">NIFTY intraday — pivots, SuperTrend, bracket</div>
    <div id="spot-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
      <div id="spot-chart" style="width:100%;height:100%;"></div>
      <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;">
        <span style="color:#f87171;">── R1 (CE)</span> &nbsp;<span style="color:#64748b;">── PP</span> &nbsp;<span style="color:#4ade80;">── S1 (PE)</span> &nbsp;<span style="color:#a78bfa;">── SuperTrend</span>
      </div>
    </div>
  </div>

  <div class="card">
    <strong>Recent harness events</strong>
    <pre id="events">Loading…</pre>
  </div>
</div>

<script>
${modalJS()}
async function refresh() {
  try {
    const r = await fetch('/rsi-pivot-st-live/status/data');
    const data = await r.json();
    document.getElementById('events').textContent = JSON.stringify(data.recentEvents, null, 2) || 'No events yet.';
    var box = document.getElementById('rsi-live-context');
    if (box) {
      box.innerHTML =
        '<div style="flex:1;min-width:130px;"><div class="label">Spot</div><div class="val">' + (data.lastTickPrice != null ? data.lastTickPrice : '—') + '</div></div>' +
        '<div style="flex:1;min-width:110px;"><div class="label">RSI</div><div class="val">' + (data.rsi != null ? data.rsi : '—') + '</div></div>' +
        '<div style="flex:1;min-width:150px;"><div class="label">R1 / PP / S1</div><div class="val">' + (data.r1 != null ? data.r1 + ' / ' + data.pp + ' / ' + data.s1 : '⚠️ none') + '</div></div>' +
        '<div style="flex:1;min-width:140px;"><div class="label">SuperTrend</div><div class="val">' + (data.superTrend != null ? data.superTrend + (data.superTrendTrend === 1 ? ' ▲' : ' ▼') : '—') + '</div></div>' +
        '<div style="flex:1;min-width:130px;"><div class="label">Trades</div><div class="val">' + (data.tradesTaken != null ? data.tradesTaken + '/' + data.maxDailyTrades : '—') + '</div></div>' +
        '<div style="flex:1;min-width:130px;"><div class="label">Session P&L</div><div class="val">' + (data.sessionPnl != null ? '₹' + data.sessionPnl : '—') + '</div></div>';
    }
  } catch (e) { document.getElementById('events').textContent = 'Fetch error: ' + e.message; }
}
async function startSession() {
  const ok = await showConfirm({
    icon: '${dryRunCurrent ? "🧪" : "🔴"}',
    title: '${dryRunCurrent ? "Start DRY-RUN session" : "Start LIVE session"}',
    message: '${dryRunCurrent ? "Start in DRY-RUN mode (no real orders)?" : "LIVE MODE — real Zerodha orders WILL be placed. This strategy has never traded. Continue?"}',
    confirmText: '${dryRunCurrent ? "Start" : "Start (LIVE)"}', confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  document.getElementById('start-btn').disabled = true;
  try {
    const r = await secretFetch('/rsi-pivot-st-live/start');
    if (!r) { document.getElementById('start-btn').disabled = false; return; }
    const data = await r.json();
    if (data.success) { await showAlert({ icon: '✅', title: 'Started', message: data.message, btnClass: 'modal-btn-success' }); location.reload(); }
    else { await showAlert({ icon: '⚠️', title: 'Start failed', message: data.error || 'unknown', btnClass: 'modal-btn-danger' }); document.getElementById('start-btn').disabled = false; }
  } catch (e) { await showAlert({ icon: '⚠️', title: 'Start error', message: e.message, btnClass: 'modal-btn-danger' }); document.getElementById('start-btn').disabled = false; }
}
async function stopSession() {
  const ok = await showConfirm({ icon: '🛑', title: 'Stop harness', message: 'Stop harness + paper session?', confirmText: 'Stop', confirmClass: 'modal-btn-danger' });
  if (!ok) return;
  document.getElementById('stop-btn').disabled = true;
  try {
    const r = await secretFetch('/rsi-pivot-st-live/stop');
    if (!r) { document.getElementById('stop-btn').disabled = false; return; }
    const data = await r.json();
    if (data.success) { await showAlert({ icon: '✅', title: 'Stopped', message: data.message, btnClass: 'modal-btn-success' }); location.reload(); }
    else { await showAlert({ icon: '⚠️', title: 'Stop failed', message: data.error || 'unknown', btnClass: 'modal-btn-danger' }); document.getElementById('stop-btn').disabled = false; }
  } catch (e) { await showAlert({ icon: '⚠️', title: 'Stop error', message: e.message, btnClass: 'modal-btn-danger' }); document.getElementById('stop-btn').disabled = false; }
}
refresh();
setInterval(refresh, 3000);
</script>
<script>
// LIVE = PAPER, so reuse the paper engine's chart-data feed.
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var container = document.getElementById('spot-chart');
  if (!container) return;
  var chart = LightweightCharts.createChart(container, {
    width: container.clientWidth, height: container.clientHeight,
    layout:{ background:{type:'solid',color:'#0a0f1c'}, textColor:'#8ba1c2', fontSize:11, fontFamily:"'IBM Plex Mono', monospace" },
    grid:{ vertLines:{color:'#111827'}, horzLines:{color:'#111827'} },
    crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale:{ borderColor:'#1a2236' },
    timeScale:{ borderColor:'#1a2236', timeVisible:true, secondsVisible:false,
      tickMarkFormatter:function(t){ var d=new Date(t*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); } },
  });
  var cs = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var stLine = chart.addLineSeries({ color:'#a78bfa', lineWidth:2, priceLineVisible:false, lastValueVisible:false });
  var lines = [], _zoomed = false;
  function addLine(price, color, title, style) {
    if (price == null || !isFinite(price)) return;
    lines.push(cs.createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title }));
  }
  async function fetchChart(){
    try {
      var r = await fetch('/rsi-pivot-st-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        if (!_zoomed) { try {
          chart.timeScale().setVisibleRange({ from:d.candles[0].time, to:d.candles[d.candles.length-1].time }); _zoomed=true;
        } catch(_){} }
      }
      if (d.superTrend && d.superTrend.length) stLine.setData(d.superTrend);
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      lines.forEach(function(l){ try { cs.removePriceLine(l); } catch(_){} });
      lines = [];
      addLine(d.r1, '#f87171', 'R1', LightweightCharts.LineStyle.Dashed);
      addLine(d.pp, '#64748b', 'PP', LightweightCharts.LineStyle.Dotted);
      addLine(d.s1, '#4ade80', 'S1', LightweightCharts.LineStyle.Dashed);
      addLine(d.entryPrice, '#94a3b8', 'Entry', LightweightCharts.LineStyle.Dotted);
      addLine(d.stopLoss,   '#ef4444', 'Stop',  LightweightCharts.LineStyle.Solid);
    } catch (e) {}
  }
  fetchChart();
  if (${installed}) setInterval(fetchChart, 4000);
  window.addEventListener('resize', function(){ chart.applyOptions({ width: container.clientWidth }); });
})();
</script>
</body></html>`;
  res.send(html);
});

module.exports = router;

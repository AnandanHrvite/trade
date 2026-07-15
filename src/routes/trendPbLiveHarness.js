/**
 * TREND PULLBACK LIVE (HARNESS) — /trend-pb-live
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs Trend Pullback LIVE by wrapping Trend Pullback PAPER with the live harness:
 *   1. Install harness (registers notify entry/exit hooks → real Fyers orders)
 *   2. Trigger /trend-pb-paper/start programmatically (paper code runs unchanged)
 *   3. As paper decides entries/exits, harness places real Fyers orders
 *   4. /stop reverses: stop paper + uninstall harness
 *
 * This guarantees LIVE = PAPER by construction — the strategy/exit logic is
 * whatever trendPbPaper says it is (single source of truth).
 *
 * TRIPLE-GATED to dry-run — real orders require ALL of:
 *   TREND_PB_LIVE_ENABLED=true   (per-strategy live enable, default false)
 *   LIVE_HARNESS_DRY_RUN=false   (global kill-switch, default true)
 *   TREND_PB_LIVE_DRY_RUN!=true   (per-strategy dry-run override)
 * plus an authenticated Fyers session. By default NOTHING places a real order.
 * Validate that Live decisions match Paper on a recorded /replay session first.
 *
 * NOTE: like ORB, this ships WITHOUT positionPersist crash-recovery of an open
 * live position — a restart mid-trade won't auto-reconcile the broker position.
 * Add save/load/clearTrendPbPosition to positionPersist.js + app.js reconciliation
 * if restart-survival is needed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express      = require("express");
const router       = express.Router();

const liveHarness  = require("../services/liveHarness");
const fyersBroker  = require("../services/fyersBroker");
const trendPbPaperRoute = require("./trendPbPaper");
const liveDryRun   = require("../utils/liveDryRun");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

// ── Programmatic invoker for the trendPbPaper express router ──────────────────
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
    const stack = trendPbPaperRoute.stack || [];
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
  const cfg = liveHarness.getConfig("TREND_PB-LIVE");
  let paperData = {};
  try {
    const resp = await _invokePaperRoute("GET", "/status/data");
    if (resp && resp.body && typeof resp.body === "object") paperData = resp.body;
  } catch (_) {}
  res.json({
    ...paperData,
    installed:    liveHarness.isInstalled("TREND_PB-LIVE"),
    config:       cfg,
    recentEvents: liveHarness.getRecentEvents(50, "TREND_PB-LIVE"),
  });
});

router.get("/start", async (req, res) => {
  if (liveHarness.isInstalled("TREND_PB-LIVE")) {
    return res.status(409).json({ success: false, error: "TREND_PB-LIVE harness is already running. Stop it first." });
  }

  // Default DRY-RUN unless the user explicitly set LIVE_HARNESS_DRY_RUN=false
  // (and TREND_PB_LIVE_DRY_RUN is not true).
  const dryRun = liveDryRun.isDryRun("TREND_PB");

  // Live-order gate — real orders require TREND_PB_LIVE_ENABLED=true. Enforced
  // ONLY for real orders; dry-run runs are unaffected. Default-off.
  if (!dryRun && (process.env.TREND_PB_LIVE_ENABLED || "false").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "Live trading disabled. Set TREND_PB_LIVE_ENABLED=true to place real orders." });
  }

  // Only require broker auth when real orders will actually be placed.
  if (!dryRun && !fyersBroker.isAuthenticated()) {
    return res.status(401).json({ success: false, error: "Fyers not authenticated for live orders. Complete Fyers login first." });
  }

  let installed;
  try {
    installed = liveHarness.installHarness({
      mode:       "TREND_PB-LIVE",
      modeTag:    "TREND_PB-PAPER",       // trendPbPaper's mode field in notify payloads
      broker:     "fyers",
      dryRun,
      isFutures:  process.env.INSTRUMENT === "NIFTY_FUTURES",
      liveLogKey: "trend_pb-live",
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }

  try {
    const startResp = await _invokePaperRoute("GET", "/start");
    if (startResp.status >= 400 && startResp.status !== 302) {
      liveHarness.uninstallHarness("TREND_PB-LIVE");
      return res.status(startResp.status).json({
        success: false,
        error:   `trendPbPaper /start failed: ${JSON.stringify(startResp.body).slice(0, 300)}`,
      });
    }
    return res.json({
      success: true,
      mode:    installed.dryRun ? "DRY-RUN" : "LIVE (real orders)",
      message: installed.dryRun
        ? "TREND_PB-LIVE harness started in DRY-RUN. Decisions match paper, no real orders placed. Watch /trend-pb-live."
        : "TREND_PB-LIVE harness started — real Fyers orders WILL be placed.",
      paperStartResp: startResp,
    });
  } catch (err) {
    liveHarness.uninstallHarness("TREND_PB-LIVE");
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/stop", async (req, res) => {
  if (!liveHarness.isInstalled("TREND_PB-LIVE")) {
    return res.status(400).json({ success: false, error: "Harness not installed." });
  }
  try {
    const stopResp = await _invokePaperRoute("GET", "/stop");
    liveHarness.uninstallHarness("TREND_PB-LIVE");
    return res.json({ success: true, message: "TREND_PB-LIVE harness stopped + paper session ended.", paperStopResp: stopResp });
  } catch (err) {
    try { liveHarness.uninstallHarness("TREND_PB-LIVE"); } catch (_) {}
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/", (req, res) => {
  const cfg = liveHarness.getConfig("TREND_PB-LIVE");
  const installed = liveHarness.isInstalled("TREND_PB-LIVE");
  const dryRunCurrent = liveDryRun.isDryRun("TREND_PB");
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trend Pullback LIVE (Harness) — Real orders via Paper engine</title>
${faviconLink()}
<style>
${sidebarCSS()}
${modalCSS()}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin:0; background:#0b1220; color:#e2e8f0; }
.main { margin-left:260px; padding:24px; max-width:900px; }
h1 { font-size:1.3rem; margin:0 0 4px; color:#f1f5f9; }
.card { background:#111827; border:1px solid #1e293b; border-radius:8px; padding:16px; margin-bottom:16px; }
.warn { background:#7f1d1d; border:1px solid #991b1b; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fee2e2; }
.warn-soft { background:#78350f; border:1px solid #92400e; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fef3c7; }
button { background:#ec4899; color:#fff; border:0; padding:8px 18px; border-radius:6px; cursor:pointer; font-size:0.85rem; margin-right:8px; }
button:hover { background:#db2777; }
button.stop { background:#475569; }
pre { background:#0a0f1c; padding:12px; border-radius:6px; overflow:auto; font-size:0.7rem; color:#cbd5e1; max-height:300px; }
.row { display:flex; gap:16px; }
.label { font-size:0.7rem; color:#64748b; text-transform:uppercase; letter-spacing:0.05em; }
.val   { font-size:0.95rem; color:#e2e8f0; }
.section-title { font-size:0.7rem; color:#64748b; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px; font-weight:600; }
</style>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
</head>
<body>
${buildSidebar('trendPbLive', false)}
<div class="main">
  <h1>● Trend Pullback LIVE — via Paper Harness</h1>

  ${dryRunCurrent
    ? '<div class="warn-soft"><strong>🧪 DRY-RUN mode</strong> — no real orders will be placed. Verify Live decisions match Paper on a recorded <code>/replay</code> session, then set <code>LIVE_HARNESS_DRY_RUN=false</code>, <code>TREND_PB_LIVE_ENABLED=true</code> (and ensure <code>TREND_PB_LIVE_DRY_RUN</code> is not true) in Settings to enable real Fyers orders.</div>'
    : '<div class="warn"><strong>🔴 LIVE mode</strong> — real Fyers orders WILL be placed when paper signals fire. To switch back to dry-run, set <code>LIVE_HARNESS_DRY_RUN=true</code> in Settings.</div>'
  }

  <div class="card">
    <div class="row">
      <div style="flex:1;">
        <div class="label">Status</div>
        <div class="val" id="status-text">${installed ? '🟢 RUNNING' : '⚪ STOPPED'}</div>
      </div>
      <div style="flex:1;">
        <div class="label">Mode</div>
        <div class="val">${cfg && cfg.dryRun ? 'DRY-RUN' : (cfg ? '🔴 LIVE' : '—')}</div>
      </div>
      <div style="flex:1;">
        <div class="label">Broker</div>
        <div class="val">${cfg ? cfg.broker : 'fyers'}</div>
      </div>
    </div>
    <div style="margin-top:16px;">
      <button onclick="startSession()" id="start-btn"${installed ? ' disabled' : ''}>▶ Start (${dryRunCurrent ? 'DRY-RUN' : 'LIVE'})</button>
      <button onclick="stopSession()" id="stop-btn" class="stop"${!installed ? ' disabled' : ''}>■ Stop</button>
    </div>
  </div>

  <div class="card">
    <div class="section-title">NIFTY 5-Min Chart (VWAP + EMA20 overlay)</div>
    <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
      <div id="nifty-chart" style="width:100%;height:100%;"></div>
      <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
        <span style="color:#3b82f6;">── VWAP</span> &nbsp;<span style="color:#a78bfa;">── EMA20(5m)</span> &nbsp;<span style="color:#3b82f6;">▲ Entry</span> &nbsp;<span style="color:#f59e0b;">── Stop</span>
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
    const r = await fetch('/trend-pb-live/status/data');
    const data = await r.json();
    document.getElementById('events').textContent = JSON.stringify(data.recentEvents, null, 2) || 'No events yet.';
  } catch (e) { document.getElementById('events').textContent = 'Fetch error: ' + e.message; }
}
async function startSession() {
  const ok = await showConfirm({
    icon: '${dryRunCurrent ? "🧪" : "🔴"}',
    title: '${dryRunCurrent ? "Start DRY-RUN session" : "Start LIVE session"}',
    message: '${dryRunCurrent ? "Start in DRY-RUN mode (no real orders)?" : "LIVE MODE — real Fyers orders WILL be placed. Continue?"}',
    confirmText: '${dryRunCurrent ? "Start" : "Start (LIVE)"}', confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  document.getElementById('start-btn').disabled = true;
  try {
    const r = await fetch('/trend-pb-live/start');
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
    const r = await fetch('/trend-pb-live/stop');
    const data = await r.json();
    if (data.success) { await showAlert({ icon: '✅', title: 'Stopped', message: data.message, btnClass: 'modal-btn-success' }); location.reload(); }
    else { await showAlert({ icon: '⚠️', title: 'Stop failed', message: data.error || 'unknown', btnClass: 'modal-btn-danger' }); document.getElementById('stop-btn').disabled = false; }
  } catch (e) { await showAlert({ icon: '⚠️', title: 'Stop error', message: e.message, btnClass: 'modal-btn-danger' }); document.getElementById('stop-btn').disabled = false; }
}
refresh();
setInterval(refresh, 3000);
</script>
<script>
// NIFTY chart — LIVE = PAPER, so reuse the paper engine's chart-data feed
// (candles + VWAP + EMA20(5m) overlay + entry/stop lines + trade markers).
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var container = document.getElementById('nifty-chart');
  if (!container) return;
  var chart = LightweightCharts.createChart(container, {
    width: container.clientWidth, height: container.clientHeight,
    layout:{ background:{type:'solid',color:'#0a0f1c'}, textColor:'#4a6080', fontSize:11, fontFamily:"'IBM Plex Mono', monospace" },
    grid:{ vertLines:{color:'#111827'}, horzLines:{color:'#111827'} },
    crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale:{ borderColor:'#1a2236' },
    timeScale:{ borderColor:'#1a2236', timeVisible:true, secondsVisible:false,
      tickMarkFormatter:function(t){ var d=new Date(t*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); } },
  });
  var cs = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var vwapS = chart.addLineSeries({ color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var ema5S = chart.addLineSeries({ color:'#a78bfa', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  var entryLine = null, slLine = null, _zoomed = false;
  async function fetchChart(){
    try {
      var r = await fetch('/trend-pb-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) { (function(){
        var _lt=d.candles[d.candles.length-1].time, _dk=Math.floor((_lt+19800)/86400), _cut=_lt;
        for (var _i=d.candles.length-1;_i>=0;_i--){ if(Math.floor((d.candles[_i].time+19800)/86400)===_dk) _cut=d.candles[_i].time; else break; }
        var _k=function(a){ return Array.isArray(a)?a.filter(function(x){return x.time>=_cut;}):a; };
        d.candles=_k(d.candles);
        ['vwapLine','ema5Line','markers'].forEach(function(kk){ if(d[kk]) d[kk]=_k(d[kk]); });
      })(); }
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        if (!_zoomed) { try {
          var lastT = d.candles[d.candles.length - 1].time, dayK = Math.floor((lastT + 19800) / 86400), firstT = lastT;
          for (var i = d.candles.length - 1; i >= 0; i--) { if (Math.floor((d.candles[i].time + 19800) / 86400) === dayK) firstT = d.candles[i].time; else break; }
          chart.timeScale().setVisibleRange({ from: firstT, to: lastT }); _zoomed = true;
        } catch(_) {} }
      }
      vwapS.setData(d.vwapLine || []);
      ema5S.setData(d.ema5Line || []);
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      if (entryLine) { cs.removePriceLine(entryLine); entryLine = null; }
      if (slLine)    { cs.removePriceLine(slLine);    slLine = null; }
      if (d.entryPrice) entryLine = cs.createPriceLine({ price:d.entryPrice, color:'#3b82f6', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
      if (d.stopLoss)   slLine    = cs.createPriceLine({ price:d.stopLoss,   color:'#f59e0b', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, axisLabelVisible:true, title:'Stop' });
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

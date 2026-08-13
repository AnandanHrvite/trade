/**
 * OI WALL FADE LIVE (HARNESS) — /oi-wall-fade-live
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs OI_WALL_FADE LIVE by wrapping its PAPER route with the live harness:
 *   1. Install harness (registers notify entry/exit hooks → real Fyers orders)
 *   2. Trigger /oi-wall-fade-paper/start programmatically (paper runs unchanged)
 *   3. As paper decides the entry/exit, the harness places real Fyers orders
 *   4. /stop reverses: stop paper + uninstall harness
 *
 * This guarantees LIVE = PAPER by construction — the strategy/exit logic is
 * whatever oiWallFadePaper says it is (single source of truth).
 *
 * TRIPLE-GATED to dry-run — real orders require ALL of:
 *   OIWF_LIVE_ENABLED=true        (per-strategy live enable, default false)
 *   LIVE_HARNESS_DRY_RUN=false    (global kill-switch, default true)
 *   OIWF_LIVE_DRY_RUN!=true       (per-strategy dry-run override)
 * plus an authenticated Fyers session. By default NOTHING places a real order.
 *
 * This strategy has NEVER traded — not live, not on paper — and unlike every
 * other engine here it can never be backtested, because Fyers exposes no
 * historical per-strike OI. There is no simulated track record to fall back on:
 * clean recorded paper sessions are the ONLY evidence that will ever exist about
 * whether defended walls hold. Collect them first.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express      = require("express");
const router       = express.Router();

const liveHarness  = require("../services/liveHarness");
const fyersBroker  = require("../services/fyersBroker");
const oiPaperRoute = require("./oiWallFadePaper");
const liveDryRun   = require("../utils/liveDryRun");
const oiStrategy   = require("../strategies/oi_wall_fade");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

// ── Programmatic invoker for the oiWallFadePaper express router ──────────────
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
    const stack = oiPaperRoute.stack || [];
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
  const cfg = liveHarness.getConfig("OI-WALL-FADE-LIVE");
  let paperData = {};
  try {
    const resp = await _invokePaperRoute("GET", "/status/data");
    if (resp && resp.body && typeof resp.body === "object") paperData = resp.body;
  } catch (_) {}
  res.json({
    ...paperData,
    installed:    liveHarness.isInstalled("OI-WALL-FADE-LIVE"),
    config:       cfg,
    recentEvents: liveHarness.getRecentEvents(50, "OI-WALL-FADE-LIVE"),
  });
});

router.get("/start", async (req, res) => {
  if (liveHarness.isInstalled("OI-WALL-FADE-LIVE")) {
    return res.status(409).json({ success: false, error: "OI-WALL-FADE-LIVE harness is already running. Stop it first." });
  }

  if (String(process.env.OIWF_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "OI Wall Fade mode is disabled. Enable it in Settings first." });
  }

  const dryRun = liveDryRun.isDryRun("OIWF");

  if (!liveDryRun.isDryRun() && String(process.env.OIWF_LIVE_ENABLED || "false").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "Live trading disabled. Set OIWF_LIVE_ENABLED=true to place real orders." });
  }

  if (!dryRun && !fyersBroker.isAuthenticated()) {
    return res.status(401).json({ success: false, error: "Fyers not authenticated for live orders. Complete Fyers login first." });
  }

  let installed;
  try {
    installed = liveHarness.installHarness({
      mode:       "OI-WALL-FADE-LIVE",
      modeTag:    "OI-WALL-FADE-PAPER",   // the paper route's mode field in notify payloads
      broker:     "fyers",
      dryRun,
      isFutures:  process.env.INSTRUMENT === "NIFTY_FUTURES",
      liveLogKey: "oi_wall_fade-live",
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }

  try {
    const startResp = await _invokePaperRoute("GET", "/start");
    if (startResp.status >= 400 && startResp.status !== 302) {
      liveHarness.uninstallHarness("OI-WALL-FADE-LIVE");
      return res.status(startResp.status).json({
        success: false,
        error:   `oiWallFadePaper /start failed: ${JSON.stringify(startResp.body).slice(0, 300)}`,
      });
    }
    return res.json({
      success: true,
      mode:    installed.dryRun ? "DRY-RUN" : "LIVE (real orders)",
      message: installed.dryRun
        ? "OI-WALL-FADE-LIVE harness started in DRY-RUN. Decisions match paper, no real orders placed. Watch /oi-wall-fade-live."
        : "OI-WALL-FADE-LIVE harness started — real Fyers orders WILL be placed.",
      paperStartResp: startResp,
    });
  } catch (err) {
    liveHarness.uninstallHarness("OI-WALL-FADE-LIVE");
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/stop", async (req, res) => {
  if (!liveHarness.isInstalled("OI-WALL-FADE-LIVE")) {
    return res.status(400).json({ success: false, error: "Harness not installed." });
  }
  try {
    const stopResp = await _invokePaperRoute("GET", "/stop");
    liveHarness.uninstallHarness("OI-WALL-FADE-LIVE");
    return res.json({ success: true, message: "OI-WALL-FADE-LIVE harness stopped + paper session ended.", paperStopResp: stopResp });
  } catch (err) {
    try { liveHarness.uninstallHarness("OI-WALL-FADE-LIVE"); } catch (_) {}
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/", (req, res) => {
  const cfg = liveHarness.getConfig("OI-WALL-FADE-LIVE");
  const installed = liveHarness.isInstalled("OI-WALL-FADE-LIVE");
  const dryRunCurrent = liveDryRun.isDryRun("OIWF");
  const scfg = oiStrategy.getConfig();
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OI Wall Fade LIVE (Harness) — Real orders via Paper engine</title>
${faviconLink()}
<style>
${sidebarCSS()}
${modalCSS()}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin:0; background:#0b1220; color:#e2e8f0; }
.main { margin-left:260px; padding:24px; max-width:900px; }
@media(max-width:768px){ .main{ margin-left:0; padding:14px; } }
h1 { font-size:1.3rem; margin:0 0 4px; color:#f1f5f9; }
.card { background:#111827; border:1px solid #1e293b; border-radius:8px; padding:16px; margin-bottom:16px; }
.warn { background:#7f1d1d; border:1px solid #991b1b; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fee2e2; }
.warn-soft { background:#78350f; border:1px solid #92400e; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fef3c7; }
button { background:#0369a1; color:#fff; border:0; padding:8px 18px; border-radius:6px; cursor:pointer; font-size:0.85rem; margin-right:8px; }
button:hover { background:#0284c7; }
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
${buildSidebar('oiWallFadeLive', false)}
<div class="main">
  <h1>● OI WALL FADE LIVE — via Paper Harness</h1>

  <div class="warn-soft"><strong>⚠️ Never traded, and never backtestable.</strong> Zero paper sessions and zero live trades. Fyers exposes no historical per-strike OI, so there is no simulated track record and there never will be — recorded paper days are the only evidence that will ever exist about whether a defended wall actually holds price. Run them, and diff a <code>/replay</code> session first, knowing that replay reproduces the candles but <strong>not</strong> the OI ladder.</div>

  ${dryRunCurrent
    ? '<div class="warn-soft"><strong>🧪 DRY-RUN mode</strong> — no real orders will be placed. To enable real Fyers orders set <code>LIVE_HARNESS_DRY_RUN=false</code>, <code>OIWF_LIVE_ENABLED=true</code> (and ensure <code>OIWF_LIVE_DRY_RUN</code> is not true) in Settings.</div>'
    : '<div class="warn"><strong>🔴 LIVE mode</strong> — real Fyers orders WILL be placed when the paper engine signals. To switch back to dry-run, set <code>LIVE_HARNESS_DRY_RUN=true</code> in Settings.</div>'
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
        <div class="val">${cfg ? cfg.broker : 'fyers'}</div>
      </div>
      <div style="flex:2;min-width:220px;">
        <div class="label">Rules</div>
        <div class="val" style="font-size:0.8rem;">NIFTY 50 ${scfg.resolutionMins}m. The highest-OI CE and PE strikes are the walls; they must be ≥${scfg.minBandPts}pt apart. A candle reaching within ${scfg.wallNearPts}pt of one whose OI is still rising (ΔOI ≥+${scfg.wallBuildPct}% over ${scfg.oiLookback} move(s)) and closing back away from it is faded towards the mid-band, stopping ${scfg.slBufferPts}pt beyond the wall. A wall shedding ≥${scfg.wallShedPct}% is left alone. Neither level ever moves.</div>
      </div>
    </div>
    <div style="margin-top:16px;">
      <button onclick="startSession()" id="start-btn"${installed ? ' disabled' : ''}>▶ Start (${dryRunCurrent ? 'DRY-RUN' : 'LIVE'})</button>
      <button onclick="stopSession()" id="stop-btn" class="stop"${!installed ? ' disabled' : ''}>■ Stop</button>
    </div>
  </div>

  <div class="card">
    <div class="section-title">Today — the wall watch</div>
    <div class="row" id="oi-live-context"><div class="val">Loading…</div></div>
  </div>

  <div class="card">
    <div class="section-title">NIFTY 50 intraday — walls, mid-band, bracket</div>
    <div id="spot-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
      <div id="spot-chart" style="width:100%;height:100%;"></div>
      <div style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;">
        <span style="color:#f59e0b;">── CE / PE walls</span> &nbsp;<span style="color:#0ea5e9;">── Mid-band</span> &nbsp;<span style="color:#ef4444;">── Stop</span>
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
    const r = await fetch('/oi-wall-fade-live/status/data');
    const data = await r.json();
    document.getElementById('events').textContent = JSON.stringify(data.recentEvents, null, 2) || 'No events yet.';
    var box = document.getElementById('oi-live-context');
    if (box) {
      var b = data.lastBand;
      box.innerHTML =
        '<div style="flex:1;min-width:150px;"><div class="label">Band</div><div class="val">' + (b ? b.lo + ' – ' + b.hi + ' (' + b.bandPts + 'pt)' : '—') + '</div></div>' +
        '<div style="flex:1;min-width:120px;"><div class="label">Mid</div><div class="val">' + (b ? b.mid : '—') + '</div></div>' +
        '<div style="flex:1;min-width:130px;"><div class="label">Spot</div><div class="val">' + (data.lastTickPrice != null ? data.lastTickPrice : '—') + '</div></div>' +
        '<div style="flex:1;min-width:160px;"><div class="label">Pressing</div><div class="val">' + (data.lastWallStrike != null ? data.lastWallSide + ' ' + data.lastWallStrike + (data.lastWallDelta != null ? ' (' + (data.lastWallDelta > 0 ? '+' : '') + data.lastWallDelta + '%)' : '') : 'no wall') + '</div></div>' +
        '<div style="flex:1;min-width:130px;"><div class="label">Trades</div><div class="val">' + (data.tradesTaken != null ? data.tradesTaken + '/' + data.maxDailyTrades : '—') + '</div></div>' +
        '<div style="flex:1;min-width:130px;"><div class="label">Stop-outs</div><div class="val">' + (data.stopOuts != null ? data.stopOuts + '/' + data.maxDailyLosses : '—') + '</div></div>';
    }
  } catch (e) { document.getElementById('events').textContent = 'Fetch error: ' + e.message; }
}
async function startSession() {
  const ok = await showConfirm({
    icon: '${dryRunCurrent ? "🧪" : "🔴"}',
    title: '${dryRunCurrent ? "Start DRY-RUN session" : "Start LIVE session"}',
    message: '${dryRunCurrent ? "Start in DRY-RUN mode (no real orders)?" : "LIVE MODE — real Fyers orders WILL be placed. This strategy has never traded and cannot be backtested. Continue?"}',
    confirmText: '${dryRunCurrent ? "Start" : "Start (LIVE)"}', confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  document.getElementById('start-btn').disabled = true;
  try {
    const r = await secretFetch('/oi-wall-fade-live/start');
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
    const r = await secretFetch('/oi-wall-fade-live/stop');
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
  var lines = [], _zoomed = false;
  function addLine(price, color, title, style) {
    if (price == null || !isFinite(price)) return;
    lines.push(cs.createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title }));
  }
  async function fetchChart(){
    try {
      var r = await fetch('/oi-wall-fade-paper/status/chart-data', { cache:'no-store' });
      var d = await r.json();
      if (d.candles && d.candles.length) {
        cs.setData(d.candles);
        if (!_zoomed) { try {
          chart.timeScale().setVisibleRange({ from:d.candles[0].time, to:d.candles[d.candles.length-1].time }); _zoomed=true;
        } catch(_){} }
      }
      if (d.markers && d.markers.length) cs.setMarkers(d.markers.slice().sort(function(a,b){return a.time-b.time;}));
      lines.forEach(function(l){ try { cs.removePriceLine(l); } catch(_){} });
      lines = [];
      var tag = d.bandFrozen ? ' (frozen)' : '';
      addLine(d.ceWall,  '#f59e0b', 'CE wall' + tag, LightweightCharts.LineStyle.Dashed);
      addLine(d.peWall,  '#f59e0b', 'PE wall' + tag, LightweightCharts.LineStyle.Dashed);
      addLine(d.bandMid, '#0ea5e9', 'Mid-band', LightweightCharts.LineStyle.Dotted);
      addLine(d.entryPrice, '#94a3b8', 'Entry',  LightweightCharts.LineStyle.Dotted);
      addLine(d.stopLoss,   '#ef4444', 'Stop',   LightweightCharts.LineStyle.Solid);
      addLine(d.target,     '#10b981', 'Target', LightweightCharts.LineStyle.Solid);
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

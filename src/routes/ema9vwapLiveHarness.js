/**
 * EMA9+VWAP LIVE (HARNESS) — /ema9vwap-live
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs EMA9+VWAP LIVE by wrapping EMA9+VWAP PAPER with the live harness:
 *   1. Install harness (registers notify entry/exit hooks → real broker orders)
 *   2. Trigger /ema9vwap-paper/start programmatically (paper code runs unchanged)
 *   3. As paper decides entries/exits, harness places real Zerodha orders
 *   4. /stop reverses: stop paper + uninstall harness
 *
 * This guarantees LIVE = PAPER by construction. Strategy/exit logic is whatever
 * ema9vwapPaper says it is — single source of truth.
 *
 * Toggles:
 *   UI_SHOW_EMA9VWAP_LIVE  — show the menu item (Settings)
 *   LIVE_HARNESS_DRY_RUN        — when true (default), no real orders placed
 *   EMA9VWAP_LIVE_DRY_RUN          — hold EMA9+VWAP in dry-run even when global is off
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express         = require("express");
const router          = express.Router();

const liveHarness     = require("../services/liveHarness");
const zerodhaBroker   = require("../services/zerodhaBroker");
const ema9vwapPaperRoute = require("./ema9vwapPaper");
const liveDryRun      = require("../utils/liveDryRun");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

// ── Programmatic invoker for the swingPaper express router ──────────────────
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
    const stack = ema9vwapPaperRoute.stack || [];
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
  const cfg = liveHarness.getConfig("EMA9VWAP-LIVE");
  // LIVE = PAPER: merge the paper engine's live status (P&L, trades, logs, running)
  // so the unified Real-Time monitor's LIVE view shows real numbers for this strategy.
  let paperData = {};
  try {
    const resp = await _invokePaperRoute("GET", "/status/data");
    if (resp && resp.body && typeof resp.body === "object") paperData = resp.body;
  } catch (_) {}
  res.json({
    ...paperData,
    installed:    liveHarness.isInstalled("EMA9VWAP-LIVE"),
    config:       cfg,
    recentEvents: liveHarness.getRecentEvents(50, "EMA9VWAP-LIVE"),
  });
});

router.get("/start", async (req, res) => {
  if (liveHarness.isInstalled("EMA9VWAP-LIVE")) {
    return res.status(409).json({ success: false, error: "EMA9VWAP-LIVE harness is already running. Stop it first." });
  }

  // Default DRY-RUN unless user explicitly set LIVE_HARNESS_DRY_RUN=false.
  const dryRun = liveDryRun.isDryRun("EMA9VWAP");

  // Only require broker auth when real orders will actually be placed.
  if (!dryRun && !zerodhaBroker.isAuthenticated()) {
    return res.status(401).json({ success: false, error: "Zerodha not authenticated for live orders. Complete Zerodha login first." });
  }

  let installed;
  try {
    installed = liveHarness.installHarness({
      mode:       "EMA9VWAP-LIVE",
      modeTag:    "EMA9VWAP-PAPER",       // ema9vwapPaper's mode field in notify payloads
      broker:     "zerodha",
      dryRun,
      isFutures:  process.env.INSTRUMENT === "NIFTY_FUTURES",
      liveLogKey: "ema9vwap-live",
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }

  // Trigger swingPaper /start — paper runs unchanged, harness intercepts its
  // notifyEntry/Exit calls. The confirmation-candle entry gate therefore runs
  // here EXACTLY as in paper (this harness has no entry path of its own) — log
  // its state so the inherited behaviour is explicit, not silent.
  console.log(`🧪 [EMA9VWAP-LIVE-HARNESS] confirmation candle: ${(process.env.EMA9VWAP_CONFIRM_CANDLE_ENABLED || "true").toLowerCase() === "true" ? "ON (2-candle cross & close)" : "OFF (legacy intra-candle)"}`);
  try {
    const startResp = await _invokePaperRoute("GET", "/start");
    if (startResp.status >= 400 && startResp.status !== 302) {
      liveHarness.uninstallHarness("EMA9VWAP-LIVE");
      return res.status(startResp.status).json({
        success: false,
        error:   `swingPaper /start failed: ${JSON.stringify(startResp.body).slice(0, 300)}`,
      });
    }
    return res.json({
      success: true,
      mode:    installed.dryRun ? "DRY-RUN" : "LIVE (real orders)",
      message: installed.dryRun
        ? "EMA9VWAP-LIVE harness started in DRY-RUN. Decisions match paper, no real orders placed. Watch /ema9vwap-live."
        : "EMA9VWAP-LIVE harness started — real Zerodha orders WILL be placed.",
      paperStartResp: startResp,
    });
  } catch (err) {
    liveHarness.uninstallHarness("EMA9VWAP-LIVE");
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/stop", async (req, res) => {
  if (!liveHarness.isInstalled("EMA9VWAP-LIVE")) {
    return res.status(400).json({ success: false, error: "Harness not installed." });
  }
  try {
    const stopResp = await _invokePaperRoute("GET", "/stop");
    liveHarness.uninstallHarness("EMA9VWAP-LIVE");
    return res.json({ success: true, message: "EMA9VWAP-LIVE harness stopped + paper session ended.", paperStopResp: stopResp });
  } catch (err) {
    try { liveHarness.uninstallHarness("EMA9VWAP-LIVE"); } catch (_) {}
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/", (req, res) => {
  const cfg = liveHarness.getConfig("EMA9VWAP-LIVE");
  const installed = liveHarness.isInstalled("EMA9VWAP-LIVE");
  const dryRunCurrent = liveDryRun.isDryRun("EMA9VWAP");
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EMA9+VWAP LIVE (Harness) — Real orders via Paper engine</title>
${faviconLink()}
<style>
${sidebarCSS()}
${modalCSS()}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin:0; background:#0b1220; color:#e2e8f0; }
.main { margin-left:260px; padding:24px; max-width:900px; }
h1 { font-size:1.3rem; margin:0 0 4px; color:#f1f5f9; }
.sub { color:#94a3b8; font-size:0.85rem; margin-bottom:16px; }
.card { background:#111827; border:1px solid #1e293b; border-radius:8px; padding:16px; margin-bottom:16px; }
.warn { background:#7f1d1d; border:1px solid #991b1b; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fee2e2; }
.warn-soft { background:#78350f; border:1px solid #92400e; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fef3c7; }
.ok { background:#064e3b; border:1px solid #047857; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#d1fae5; }
button { background:#3b82f6; color:#fff; border:0; padding:8px 18px; border-radius:6px; cursor:pointer; font-size:0.85rem; margin-right:8px; }
button:hover { background:#2563eb; }
button.danger { background:#dc2626; } button.danger:hover { background:#b91c1c; }
button.stop { background:#475569; }
pre { background:#0a0f1c; padding:12px; border-radius:6px; overflow:auto; font-size:0.7rem; color:#cbd5e1; max-height:300px; }
.row { display:flex; gap:16px; }
.label { font-size:0.7rem; color:#64748b; text-transform:uppercase; letter-spacing:0.05em; }
.val   { font-size:0.95rem; color:#e2e8f0; }
.section-title { font-size:0.7rem; color:#64748b; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px; font-weight:600; }
</style>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
</head>
<body>
${buildSidebar('ema9vwapLive', false)}
<div class="main">
  <h1>● EMA9+VWAP LIVE — via Paper Harness</h1>

  ${dryRunCurrent
    ? '<div class="warn-soft"><strong>🧪 DRY-RUN mode</strong> — no real orders will be placed. Verify decisions match paper for at least one session, then set <code>LIVE_HARNESS_DRY_RUN=false</code> (and ensure <code>EMA9VWAP_LIVE_DRY_RUN</code> is not true) in Settings to enable real orders.</div>'
    : '<div class="warn"><strong>🔴 LIVE mode</strong> — real Zerodha orders WILL be placed when paper signals fire. To switch back to dry-run, set <code>LIVE_HARNESS_DRY_RUN=true</code> in Settings.</div>'
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
        <div class="val">${cfg ? cfg.broker : 'zerodha'}</div>
      </div>
    </div>
    <div style="margin-top:16px;">
      <button onclick="startSession()" id="start-btn"${installed ? ' disabled' : ''}>▶ Start (${dryRunCurrent ? 'DRY-RUN' : 'LIVE'})</button>
      <button onclick="stopSession()" id="stop-btn" class="stop"${!installed ? ' disabled' : ''}>■ Stop</button>
    </div>
  </div>

  <div class="card">
    <div class="section-title">NIFTY 5-Min Chart</div>
    <div id="nifty-chart-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:400px;">
      <div id="nifty-chart" style="width:100%;height:100%;"></div>
      <div id="chart-legend" style="position:absolute;top:10px;left:12px;font-size:0.68rem;color:#4a6080;pointer-events:none;z-index:2;">
        <span style="color:#3b82f6;">▲ Entry</span> &nbsp;
        <span style="color:#10b981;">▼ Win</span> &nbsp;
        <span style="color:#ef4444;">▼ Loss</span> &nbsp;
        <span style="color:#e5e7eb;">── EMA9</span> &nbsp;
        <span style="color:#2962ff;">── VWAP</span> &nbsp;
        <span style="color:#10b981;">── VWAP+σ</span> &nbsp;
        <span style="color:#ef4444;">── VWAP−σ</span> &nbsp;
        <span style="color:#f59e0b;">── SL</span>
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
    const r = await fetch('/ema9vwap-live/status/data');
    const data = await r.json();
    document.getElementById('events').textContent =
      JSON.stringify(data.recentEvents, null, 2) || 'No events yet.';
  } catch (e) {
    document.getElementById('events').textContent = 'Fetch error: ' + e.message;
  }
}
async function startSession() {
  const ok = await showConfirm({
    icon: '${dryRunCurrent ? "🧪" : "🔴"}',
    title: '${dryRunCurrent ? "Start DRY-RUN session" : "Start LIVE session"}',
    message: '${dryRunCurrent ? "Start in DRY-RUN mode (no real orders)?" : "LIVE MODE — real Zerodha orders WILL be placed. Continue?"}',
    confirmText: '${dryRunCurrent ? "Start" : "Start (LIVE)"}',
    confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  document.getElementById('start-btn').disabled = true;
  try {
    const r = await fetch('/ema9vwap-live/start');
    const data = await r.json();
    if (data.success) {
      await showAlert({ icon: '✅', title: 'Started', message: data.message, btnClass: 'modal-btn-success' });
      location.reload();
    } else {
      await showAlert({ icon: '⚠️', title: 'Start failed', message: data.error || 'unknown', btnClass: 'modal-btn-danger' });
      document.getElementById('start-btn').disabled = false;
    }
  } catch (e) {
    await showAlert({ icon: '⚠️', title: 'Start error', message: e.message, btnClass: 'modal-btn-danger' });
    document.getElementById('start-btn').disabled = false;
  }
}
async function stopSession() {
  const ok = await showConfirm({
    icon: '🛑',
    title: 'Stop harness',
    message: 'Stop harness + paper session?',
    confirmText: 'Stop',
    confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  document.getElementById('stop-btn').disabled = true;
  try {
    const r = await fetch('/ema9vwap-live/stop');
    const data = await r.json();
    if (data.success) { await showAlert({ icon: '✅', title: 'Stopped', message: data.message, btnClass: 'modal-btn-success' }); location.reload(); }
    else { await showAlert({ icon: '⚠️', title: 'Stop failed', message: data.error || 'unknown', btnClass: 'modal-btn-danger' }); document.getElementById('stop-btn').disabled = false; }
  } catch (e) {
    await showAlert({ icon: '⚠️', title: 'Stop error', message: e.message, btnClass: 'modal-btn-danger' });
    document.getElementById('stop-btn').disabled = false;
  }
}
refresh();
setInterval(refresh, 3000);
</script>
<script>
// ── NIFTY Chart (Lightweight Charts) ────────────────────────────────────────
// The Live harness drives the EMA9+VWAP PAPER engine underneath, so we reuse its
// /status/chart-data feed and render the SAME TradingView-styled chart the Paper
// and Replay screens show (EMA9 white, VWAP blue, solid green/red σ bands). This
// is a mirror of the paper status-page chart pointed at the paper data endpoint.
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  const container = document.getElementById('nifty-chart');
  if (!container) return;

  const chart = LightweightCharts.createChart(container, {
    width:  container.clientWidth,
    height: container.clientHeight,
    layout: { background: { type: 'solid', color: '#0a0f1c' }, textColor: '#4a6080', fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" },
    grid:   { vertLines: { color: '#111827' }, horzLines: { color: '#111827' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1a2236', scaleMargins: { top: 0.1, bottom: 0.05 } },
    timeScale: { borderColor: '#1a2236', timeVisible: true, secondsVisible: false,
      tickMarkFormatter: function(time) {
        var d = new Date(time * 1000);
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      }
    },
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor:   '#10b981', downColor:   '#ef4444',
    borderUpColor: '#10b981', borderDownColor: '#ef4444',
    wickUpColor:   '#10b981', wickDownColor:   '#ef4444',
  });

  // TradingView-matched palette: EMA9 = white, VWAP = blue, σ bands = solid green/red.
  const ema9Series      = chart.addLineSeries({ color:'#e5e7eb', lineWidth:2, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false, title:'EMA9' });
  const vwapSeries      = chart.addLineSeries({ color:'#2962ff', lineWidth:2, priceLineVisible:false, lastValueVisible:true,  crosshairMarkerVisible:false, title:'VWAP' });
  const vwapUpperSeries = chart.addLineSeries({ color:'#10b981', lineWidth:1, lineStyle:0, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false, title:'VWAP+σ' });
  const vwapLowerSeries = chart.addLineSeries({ color:'#ef4444', lineWidth:1, lineStyle:0, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false, title:'VWAP−σ' });

  let slLine = null, entryLine = null, armedLine = null, _lastCandleCount = 0;

  chart.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: false, lockVisibleTimeRangeOnResize: true });
  let _userRange = null, _internalUpdate = false, _internalTimer = null;
  chart.timeScale().subscribeVisibleLogicalRangeChange(function(r) {
    if (_internalUpdate) return;
    if (r) _userRange = r;
  });

  async function fetchChart() {
    try {
      const res = await fetch('/ema9vwap-paper/status/chart-data', { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();
      if (!d.candles || d.candles.length === 0) return;

      // Trim every series to the latest IST trading day (warmup history is server-side).
      (function(){
        var _lt=d.candles[d.candles.length-1].time, _dk=Math.floor((_lt+19800)/86400), _cut=_lt;
        for (var _i=d.candles.length-1;_i>=0;_i--){ if(Math.floor((d.candles[_i].time+19800)/86400)===_dk) _cut=d.candles[_i].time; else break; }
        var _k=function(a){ return Array.isArray(a)?a.filter(function(x){return x.time>=_cut;}):a; };
        d.candles=_k(d.candles);
        ['ema9','vwap','vwapUpper','vwapLower','markers'].forEach(function(kk){ if(d[kk]) d[kk]=_k(d[kk]); });
      })();

      _internalUpdate = true;

      if (Math.abs(d.candles.length - _lastCandleCount) > 1 || _lastCandleCount === 0) {
        candleSeries.setData(d.candles.map(function(c) {
          return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
        }));
      } else if (d.candles.length > 0) {
        var last = d.candles[d.candles.length - 1];
        candleSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
      }
      _lastCandleCount = d.candles.length;

      if (d.ema9  && d.ema9.length)  ema9Series.setData(d.ema9);   else ema9Series.setData([]);
      if (d.vwap && d.vwap.length) vwapSeries.setData(d.vwap); else vwapSeries.setData([]);
      if (d.vwapUpper && d.vwapUpper.length) vwapUpperSeries.setData(d.vwapUpper); else vwapUpperSeries.setData([]);
      if (d.vwapLower && d.vwapLower.length) vwapLowerSeries.setData(d.vwapLower); else vwapLowerSeries.setData([]);

      if (d.markers && d.markers.length > 0) {
        var sorted = d.markers.slice().sort(function(a, b) { return a.time - b.time; });
        candleSeries.setMarkers(sorted.map(function(m) {
          return { time: m.time, position: m.position, color: m.color, shape: m.shape, text: m.text };
        }));
      } else {
        candleSeries.setMarkers([]);
      }

      if (slLine) { candleSeries.removePriceLine(slLine); slLine = null; }
      if (d.stopLoss) {
        slLine = candleSeries.createPriceLine({ price: d.stopLoss, color: '#f59e0b', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: 'SL' });
      }

      if (entryLine) { candleSeries.removePriceLine(entryLine); entryLine = null; }
      if (d.entryPrice) {
        entryLine = candleSeries.createPriceLine({ price: d.entryPrice, color: '#3b82f6', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: 'Entry' });
      }

      if (armedLine) { candleSeries.removePriceLine(armedLine); armedLine = null; }
      if (d.armedTrigger && !d.stopLoss) {
        armedLine = candleSeries.createPriceLine({ price: d.armedTrigger, color: '#f59e0b', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: 'ARM ' + (d.armedSide || '') });
      }

      if (_userRange) { try { chart.timeScale().setVisibleLogicalRange(_userRange); } catch(_) {} }
      else {
        try {
          var lastT = d.candles[d.candles.length - 1].time;
          var dayK = Math.floor((lastT + 19800) / 86400);
          var firstT = lastT;
          for (var i = d.candles.length - 1; i >= 0; i--) {
            if (Math.floor((d.candles[i].time + 19800) / 86400) === dayK) firstT = d.candles[i].time;
            else break;
          }
          chart.timeScale().setVisibleRange({ from: firstT, to: lastT });
        } catch(_) {}
      }
      if (_internalTimer) clearTimeout(_internalTimer);
      _internalTimer = setTimeout(function() { _internalUpdate = false; }, 60);
    } catch (e) {
      console.warn('[Chart] fetch error:', e.message);
    }
  }

  fetchChart();
  if (${installed}) { setInterval(fetchChart, 4000); }
  window.addEventListener('resize', function() { chart.applyOptions({ width: container.clientWidth }); });
})();
</script>
</body></html>`;
  res.send(html);
});

module.exports = router;

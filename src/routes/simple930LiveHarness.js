/**
 * SIMPLE_9:30 LIVE (HARNESS) — /simple930-live
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs SIMPLE_9:30 LIVE by wrapping SIMPLE_9:30 PAPER with the live harness:
 *   1. Install the harness (registers notify entry/exit hooks → real broker orders)
 *   2. Trigger /simple930-paper/start programmatically (paper code runs unchanged)
 *   3. As paper decides the entry and the exit, the harness places real ZERODHA orders
 *   4. /stop reverses: stop paper + uninstall the harness
 *
 * This guarantees LIVE = PAPER by construction. The 09:25 strike selection, the
 * ₹180 trigger, the 20-point stop, the trail and the 09:45 sideways exit are
 * whatever simple930Paper says they are — single source of truth.
 *
 * ORDERS GO TO ZERODHA. Market data still comes from Fyers (the only broker with
 * a NIFTY option feed in this repo), so a live session needs BOTH logins: Fyers
 * for the premium quotes the decisions read, Zerodha for the orders.
 *
 * TRIPLE-GATED. A real order needs ALL THREE:
 *   SIMPLE930_LIVE_ENABLED=true   — this strategy's own switch (default OFF)
 *   LIVE_HARNESS_DRY_RUN=false    — the global harness switch (default ON = dry)
 *   SIMPLE930_LIVE_DRY_RUN≠true   — a per-strategy hold-back that outranks both
 *
 * Toggles:
 *   UI_SHOW_SIMPLE930_LIVE   — show the menu item (Settings)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express       = require("express");
const router        = express.Router();

const liveHarness   = require("../services/liveHarness");
const zerodhaBroker = require("../services/zerodhaBroker");
const paperRoute    = require("./simple930Paper");
const liveDryRun    = require("../utils/liveDryRun");
const strategy      = require("../strategies/simple930");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

const MODE = "SIMPLE930-LIVE";

// ── Programmatic invoker for the simple930Paper express router ───────────────
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
    const stack = paperRoute.stack || [];
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

router.get("/status/data", (req, res) => {
  const cfg = liveHarness.getConfig(MODE);
  res.json({
    installed:    liveHarness.isInstalled(MODE),
    running:      liveHarness.isInstalled(MODE),
    config:       cfg,
    recentEvents: liveHarness.getRecentEvents(50, MODE),
  });
});

router.get("/start", async (req, res) => {
  if (liveHarness.isInstalled(MODE)) {
    return res.status(409).json({ success: false, error: `${MODE} harness is already running. Stop it first.` });
  }

  if (String(process.env.SIMPLE930_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "SIMPLE_9:30 Mode is disabled in Settings." });
  }

  // Default DRY-RUN unless the operator explicitly set LIVE_HARNESS_DRY_RUN=false.
  const dryRun = liveDryRun.isDryRun("SIMPLE930");

  // Live-order gate (the documented double-gate): real orders require
  // SIMPLE930_LIVE_ENABLED=true. Enforced ONLY for real orders — dry-run runs
  // are unaffected. Default-off.
  if (!dryRun && (process.env.SIMPLE930_LIVE_ENABLED || "false").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "Live trading disabled. Set SIMPLE930_LIVE_ENABLED=true to place real orders." });
  }

  // Only require broker auth when real orders will actually be placed.
  if (!dryRun && !zerodhaBroker.isAuthenticated()) {
    return res.status(401).json({ success: false, error: "Zerodha not authenticated for live orders. Complete the Zerodha login first." });
  }

  let installed;
  try {
    installed = liveHarness.installHarness({
      mode:       MODE,
      modeTag:    "SIMPLE930-PAPER",   // simple930Paper's mode field in notify payloads
      broker:     "zerodha",
      dryRun,
      isFutures:  false,               // this strategy only ever buys options
      liveLogKey: "simple930-live",    // MUST match tradeLogger's key character for character
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }

  const cfg = strategy.getConfig();
  console.log(`🧪 [${MODE}-HARNESS] plan: ${strategy.describePlan(cfg)}`);
  try {
    const startResp = await _invokePaperRoute("GET", "/start");
    if (startResp.status >= 400 && startResp.status !== 302) {
      liveHarness.uninstallHarness(MODE);
      return res.status(startResp.status).json({
        success: false,
        error:   `simple930Paper /start failed: ${JSON.stringify(startResp.body).slice(0, 300)}`,
      });
    }
    return res.json({
      success: true,
      mode:    installed.dryRun ? "DRY-RUN" : "LIVE (real orders)",
      message: installed.dryRun
        ? "SIMPLE_9:30 LIVE harness started in DRY-RUN. Decisions match paper, no real orders placed. Watch /simple930-live."
        : "SIMPLE_9:30 LIVE harness started — real ZERODHA orders WILL be placed.",
      paperStartResp: startResp,
    });
  } catch (err) {
    liveHarness.uninstallHarness(MODE);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/stop", async (req, res) => {
  if (!liveHarness.isInstalled(MODE)) {
    return res.status(400).json({ success: false, error: "Harness not installed." });
  }
  try {
    const stopResp = await _invokePaperRoute("GET", "/stop");
    liveHarness.uninstallHarness(MODE);
    return res.json({ success: true, message: `${MODE} harness stopped + paper session ended.`, paperStopResp: stopResp });
  } catch (err) {
    try { liveHarness.uninstallHarness(MODE); } catch (_) {}
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/", (req, res) => {
  const cfg = liveHarness.getConfig(MODE);
  const installed = liveHarness.isInstalled(MODE);
  const dryRunCurrent = liveDryRun.isDryRun("SIMPLE930");
  const s = strategy.getConfig();
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SIMPLE_9:30 LIVE (Harness) — Real orders via the Paper engine</title>
${faviconLink()}
<style>
${sidebarCSS()}
${modalCSS()}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin:0; background:#0b1220; color:#e2e8f0; }
.main { margin-left:200px; padding:24px; max-width:900px; }
@media(max-width:768px){ .main{ margin-left:0; padding:14px; } button{ min-height:44px; } }
h1 { font-size:1.3rem; margin:0 0 4px; color:#f1f5f9; }
.sub { color:#94a3b8; font-size:0.85rem; margin-bottom:16px; }
.card { background:#111827; border:1px solid #1e293b; border-radius:8px; padding:16px; margin-bottom:16px; }
.warn { background:#7f1d1d; border:1px solid #991b1b; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fee2e2; }
.warn-soft { background:#78350f; border:1px solid #92400e; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fef3c7; }
button { background:#2563eb; color:#fff; border:0; padding:8px 18px; border-radius:6px; cursor:pointer; font-size:0.85rem; margin-right:8px; }
button.stop { background:#475569; }
pre { background:#0a0f1c; padding:12px; border-radius:6px; overflow:auto; font-size:0.7rem; color:#cbd5e1; max-height:300px; }
.row { display:flex; gap:16px; flex-wrap:wrap; }
.label { font-size:0.7rem; color:var(--muted-1,#8ba1c2); text-transform:uppercase; letter-spacing:0.05em; }
.val   { font-size:0.95rem; color:#e2e8f0; }
.plan { font-size:0.78rem; color:#cbd5e1; line-height:1.7; }
.plan b { color:#f1f5f9; }
</style>
</head>
<body>
${buildSidebar('simple930Live', false)}
<div class="main">
  <h1>🎯 SIMPLE_9:30 LIVE — via the Paper Harness</h1>
  <div class="sub">Decisions come from /simple930-paper unchanged. Orders go to <b>Zerodha</b>; premium quotes come from Fyers.</div>

  ${dryRunCurrent
    ? '<div class="warn-soft"><strong>🧪 DRY-RUN mode</strong> — no real orders will be placed. Verify decisions match paper for at least one session (and diff a recorded session in <code>/replay</code>), then set <code>LIVE_HARNESS_DRY_RUN=false</code> and <code>SIMPLE930_LIVE_ENABLED=true</code> in Settings.</div>'
    : '<div class="warn"><strong>🔴 LIVE mode</strong> — real Zerodha orders WILL be placed when paper signals fire. To switch back, set <code>LIVE_HARNESS_DRY_RUN=true</code> in Settings.</div>'
  }

  <div class="card">
    <div class="label" style="margin-bottom:8px;">Today's plan (read live from Settings)</div>
    <div class="plan">
      <b>${strategy._fmtMins(s.selectionMin)}</b> — quote the ITM ladder, keep the strike nearest <b>₹${s.triggerPremium}</b> on each side.<br>
      <b>${strategy._fmtMins(s.entryStartMin)} – ${strategy._fmtMins(s.entryEndMin)}</b> — buy the first of the two above <b>₹${s.triggerPremium}</b>.<br>
      Stop <b>${s.slPts}pt</b> off the fill${s.trailEnabled ? `, trailing <b>${s.trailPts}pt</b> behind the peak` : " (no trail)"}.<br>
      <b>${strategy._fmtMins(s.sidewaysMin)}</b> — close the trade if it never left <b>₹${s.bandDown}–₹${s.bandUp}</b>.<br>
      <b>${strategy._fmtMins(s.forcedExitMin)}</b> — square off whatever is left.
    </div>
  </div>

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
    </div>
    <div style="margin-top:16px;">
      <button onclick="startSession()" id="start-btn"${installed ? ' disabled' : ''}>▶ Start (${dryRunCurrent ? 'DRY-RUN' : 'LIVE'})</button>
      <button onclick="stopSession()" id="stop-btn" class="stop"${!installed ? ' disabled' : ''}>■ Stop</button>
      <a href="/simple930-paper/status" style="color:#38bdf8;font-size:0.8rem;margin-left:8px;">open the paper page →</a>
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
    const r = await fetch('/simple930-live/status/data');
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
    message: '${dryRunCurrent ? "Start SIMPLE_9:30 in DRY-RUN mode (no real orders)?" : "LIVE MODE — real Zerodha orders WILL be placed. Continue?"}',
    confirmText: '${dryRunCurrent ? "Start" : "Start (LIVE)"}',
    confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  document.getElementById('start-btn').disabled = true;
  try {
    const r = await secretFetch('/simple930-live/start');
    if (!r) { document.getElementById('start-btn').disabled = false; return; }
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
    icon: '🛑', title: 'Stop harness',
    message: 'Stop the harness + the paper session?',
    confirmText: 'Stop', confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  document.getElementById('stop-btn').disabled = true;
  try {
    const r = await secretFetch('/simple930-live/stop');
    if (!r) { document.getElementById('stop-btn').disabled = false; return; }
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
</body></html>`;
  res.send(html);
});

module.exports = router;

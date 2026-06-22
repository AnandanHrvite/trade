/**
 * SCALP LIVE (HARNESS) — /scalp-live-harness
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs SCALP LIVE by wrapping SCALP PAPER with the live harness:
 *   1. Install harness (registers notify entry/exit hooks → real broker orders)
 *   2. Trigger /scalp-paper/start programmatically (paper code runs unchanged)
 *   3. As paper decides entries/exits, harness places real Fyers orders
 *   4. /stop reverses: stop paper + uninstall harness
 *
 * This guarantees LIVE = PAPER by construction. Strategy/SL/exit logic is
 * whatever scalpPaper says it is — single source of truth.
 *
 * Existing /scalp-live route is unchanged (legacy fallback).
 *
 * Toggles:
 *   UI_SHOW_SCALP_LIVE_HARNESS  — show the menu item (Settings)
 *   LIVE_HARNESS_DRY_RUN        — when true (default), no real orders placed
 *   SCALP_LIVE_DRY_RUN          — hold SCALP in dry-run even when global is off
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express         = require("express");
const router          = express.Router();

const liveHarness     = require("../services/liveHarness");
const fyersBroker     = require("../services/fyersBroker");
const scalpPaperRoute = require("./scalpPaper");
const liveDryRun      = require("../utils/liveDryRun");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");

// ── Programmatic invoker for the scalpPaper express router ──────────────────
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
    const stack = scalpPaperRoute.stack || [];
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
  const cfg = liveHarness.getConfig("SCALP-LIVE");
  res.json({
    installed:    liveHarness.isInstalled("SCALP-LIVE"),
    config:       cfg,
    recentEvents: liveHarness.getRecentEvents(50, "SCALP-LIVE"),
  });
});

router.get("/start", async (req, res) => {
  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).json({ success: false, error: auth.message });

  if (!fyersBroker.isAuthenticated()) {
    return res.status(401).json({ success: false, error: "Fyers not authenticated for orders." });
  }

  if (liveHarness.isInstalled("SCALP-LIVE")) {
    return res.status(409).json({ success: false, error: "SCALP-LIVE harness is already running. Stop it first." });
  }

  // Default DRY-RUN unless user explicitly set LIVE_HARNESS_DRY_RUN=false.
  const dryRun = liveDryRun.isDryRun("SCALP");

  let installed;
  try {
    installed = liveHarness.installHarness({
      mode:       "SCALP-LIVE",
      modeTag:    "SCALP-PAPER",   // scalpPaper's mode field in notify payloads
      broker:     "fyers",
      dryRun,
      isFutures:  process.env.INSTRUMENT === "NIFTY_FUTURES",
      liveLogKey: "scalp-live",
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }

  // Trigger scalpPaper /start — paper runs unchanged, harness intercepts its
  // notifyEntry/Exit calls. The confirmation-candle entry gate therefore runs
  // here EXACTLY as in paper (this harness has no entry path of its own) — log
  // its state so the inherited behaviour is explicit, not silent.
  console.log(`🧪 [SCALP-LIVE-HARNESS] confirmation candle: ${(process.env.SCALP_CONFIRM_CANDLE_ENABLED || "true").toLowerCase() === "true" ? "ON (2-candle cross & close)" : "OFF (legacy candle-close)"}`);
  try {
    const startResp = await _invokePaperRoute("GET", "/start");
    if (startResp.status >= 400 && startResp.status !== 302) {
      liveHarness.uninstallHarness("SCALP-LIVE");
      return res.status(startResp.status).json({
        success: false,
        error:   `scalpPaper /start failed: ${JSON.stringify(startResp.body).slice(0, 300)}`,
      });
    }
    return res.json({
      success: true,
      mode:    installed.dryRun ? "DRY-RUN" : "LIVE (real orders)",
      message: installed.dryRun
        ? "SCALP-LIVE harness started in DRY-RUN. Decisions match paper, no real orders placed. Watch /scalp-live-harness."
        : "SCALP-LIVE harness started — real Fyers orders WILL be placed.",
      paperStartResp: startResp,
    });
  } catch (err) {
    liveHarness.uninstallHarness("SCALP-LIVE");
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/stop", async (req, res) => {
  if (!liveHarness.isInstalled("SCALP-LIVE")) {
    return res.status(400).json({ success: false, error: "Harness not installed." });
  }
  try {
    const stopResp = await _invokePaperRoute("GET", "/stop");
    liveHarness.uninstallHarness("SCALP-LIVE");
    return res.json({ success: true, message: "SCALP-LIVE harness stopped + paper session ended.", paperStopResp: stopResp });
  } catch (err) {
    try { liveHarness.uninstallHarness("SCALP-LIVE"); } catch (_) {}
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/", (req, res) => {
  const cfg = liveHarness.getConfig("SCALP-LIVE");
  const installed = liveHarness.isInstalled("SCALP-LIVE");
  const dryRunCurrent = liveDryRun.isDryRun("SCALP");
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SCALP LIVE (Harness) — Real orders via Paper engine</title>
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
</style>
</head>
<body>
${buildSidebar('scalpLiveHarness', false)}
<div class="main">
  <h1>⚡ SCALP LIVE — via Paper Harness</h1>

  ${dryRunCurrent
    ? '<div class="warn-soft"><strong>🧪 DRY-RUN mode</strong> — no real orders will be placed. Verify decisions match paper for at least one session, then set <code>LIVE_HARNESS_DRY_RUN=false</code> (and ensure <code>SCALP_LIVE_DRY_RUN</code> is not true) in Settings to enable real orders.</div>'
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
    <strong>Recent harness events</strong>
    <pre id="events">Loading…</pre>
  </div>
</div>

<script>
${modalJS()}
async function refresh() {
  try {
    const r = await fetch('/scalp-live-harness/status/data');
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
    message: '${dryRunCurrent ? "Start in DRY-RUN mode (no real orders)?" : "LIVE MODE — real Fyers orders WILL be placed. Continue?"}',
    confirmText: '${dryRunCurrent ? "Start" : "Start (LIVE)"}',
    confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  document.getElementById('start-btn').disabled = true;
  try {
    const r = await fetch('/scalp-live-harness/start');
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
    const r = await fetch('/scalp-live-harness/stop');
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

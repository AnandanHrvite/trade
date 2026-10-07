/**
 * PREV ORB SCALP LIVE (HARNESS) — /prev-orb-scalp-live
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs PREV_ORB_SCALP LIVE by wrapping its PAPER route with the live harness:
 *   1. Install the harness (registers notify entry/exit hooks → real broker orders)
 *   2. Trigger /prev-orb-scalp-paper/start programmatically (paper code runs unchanged)
 *   3. As paper decides the entry and the exit, the harness places real ZERODHA orders
 *   4. /stop reverses: stop paper + uninstall the harness
 *
 * This guarantees LIVE = PAPER by construction — the 09:15 setup vs yesterday's
 * high/low, the first 3-min break entry, the stop, the target, the post-target
 * trail and the profit lock are whatever prevOrbScalpPaper says they are (single
 * source of truth). No decision, fill or exit rule is re-implemented here.
 *
 * ORDERS GO TO ZERODHA. Market data still comes from Fyers (the only broker with
 * a NIFTY spot + option feed in this repo), so a live session needs BOTH logins:
 * Fyers for the candles and premium quotes the decisions read, Zerodha for the
 * orders themselves.
 *
 * TRIPLE-GATED to dry-run — a real order needs ALL THREE:
 *   PREV_ORB_SCALP_LIVE_ENABLED=true    — this strategy's own switch (default OFF)
 *   LIVE_HARNESS_DRY_RUN=false    — the global harness switch (default ON = dry)
 *   PREV_ORB_SCALP_LIVE_DRY_RUN≠true    — a per-strategy hold-back that outranks both
 * By default NOTHING places a real order.
 *
 * This strategy is NEW and has no track record. Collect clean paper sessions and
 * diff them against a recorded /replay before you even consider a live gate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express          = require("express");
const router           = express.Router();

const liveHarness      = require("../services/liveHarness");
const zerodhaBroker    = require("../services/zerodhaBroker");
const paperRoute       = require("./prevOrbScalpPaper");
const liveDryRun       = require("../utils/liveDryRun");
const strat       = require("../strategies/prev_orb_scalp");
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

const MODE     = "PREV_ORB_SCALP-LIVE";
const MODE_TAG = "PREV-ORB-SCALP-PAPER";   // prevOrbScalpPaper's mode field in notify payloads
const LOG      = "[PREV-ORB-SCALP-LIVE]";

// ── Programmatic invoker for the prevOrbScalpPaper express router ─────────────────
function _invokePaperRoute(method, urlPath, query = {}) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const finish = (payload) => { if (!resolved) { resolved = true; resolve(payload); } };
    const req = {
      method: method.toUpperCase(),
      url: urlPath, path: urlPath, query: { ...query },
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

// ── Plain-language gate report, logged on every /start ───────────────────────
// Says out loud which of the three switches is open, which is shut, and whether
// a real order can actually reach the exchange. No jargon, no guessing.
function _logGateReport(dryRun) {
  const globalOpen  = String(process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() === "false";
  const stratOpen   = String(process.env.PREV_ORB_SCALP_LIVE_ENABLED || "false").toLowerCase() === "true";
  const holdBack    = String(process.env.PREV_ORB_SCALP_LIVE_DRY_RUN || "false").toLowerCase() === "true";
  const mark = (open) => (open ? "OPEN" : "SHUT");
  console.log(`🔍 ${LOG} Gate check — three switches must ALL be open before any real order is possible:`);
  console.log(`   1. LIVE_HARNESS_DRY_RUN=false (global switch) ......... ${mark(globalOpen)}${globalOpen ? "" : "  ← currently forcing dry-run for every strategy"}`);
  console.log(`   2. PREV_ORB_SCALP_LIVE_ENABLED=true (this strategy) ......... ${mark(stratOpen)}${stratOpen ? "" : "  ← Prev ORB Scalp was never armed for real money"}`);
  console.log(`   3. PREV_ORB_SCALP_LIVE_DRY_RUN not true (hold-back) ......... ${mark(!holdBack)}${holdBack ? "  ← held back on purpose, only this strategy is affected" : ""}`);
  if (dryRun) {
    console.log(`🧪 ${LOG} RESULT: DRY-RUN. Decisions will match paper exactly, and every order is only printed to this log. No money moves.`);
  } else {
    console.log(`🔴 ${LOG} RESULT: LIVE. All three switches are open — REAL ZERODHA ORDERS WILL BE PLACED when the paper engine signals.`);
  }
  console.log(`   Orders → Zerodha. Market data (candles + option premiums) → Fyers. A live run needs both logins.`);
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.get("/status/data", async (req, res) => {
  const cfg = liveHarness.getConfig(MODE);
  let paperData = {};
  try {
    const resp = await _invokePaperRoute("GET", "/status/data");
    if (resp && resp.body && typeof resp.body === "object") paperData = resp.body;
  } catch (_) {}
  res.json({
    ...paperData,
    installed:    liveHarness.isInstalled(MODE),
    config:       cfg,
    recentEvents: liveHarness.getRecentEvents(50, MODE),
  });
});

router.get("/start", async (req, res) => {
  if (liveHarness.isInstalled(MODE)) {
    return res.status(409).json({ success: false, error: `${MODE} harness is already running. Stop it first.` });
  }

  if (String(process.env.PREV_ORB_SCALP_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "Prev ORB Scalp mode is disabled. Enable it in Settings first." });
  }

  // Default DRY-RUN unless the operator explicitly opened all three switches.
  const dryRun = liveDryRun.isDryRun("PREV_ORB_SCALP");

  // Live-order gate — enforced ONLY for real orders; dry-run runs are unaffected.
  if (!liveDryRun.isDryRun() && String(process.env.PREV_ORB_SCALP_LIVE_ENABLED || "false").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "Live trading disabled. Set PREV_ORB_SCALP_LIVE_ENABLED=true to place real orders." });
  }

  // Only require broker auth when real orders will actually be placed.
  if (!dryRun && !zerodhaBroker.isAuthenticated()) {
    return res.status(401).json({ success: false, error: "Zerodha not authenticated for live orders. Complete the Zerodha login first." });
  }

  _logGateReport(dryRun);

  let installed;
  try {
    installed = liveHarness.installHarness({
      mode:       MODE,
      modeTag:    MODE_TAG,        // the paper route's mode field in notify payloads
      broker:     "zerodha",       // ORDERS go to Zerodha; DATA still comes from Fyers
      dryRun,
      isFutures:  String(process.env.INSTRUMENT || "").trim().toUpperCase() === "NIFTY_FUTURES",
      liveLogKey: null, // live trades are not logged to disk
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }

  try {
    const startResp = await _invokePaperRoute("GET", "/start", { _viaHarness: "1" }); // the ONE start allowed to keep the harness attached
    if (startResp.status >= 400 && startResp.status !== 302) {
      liveHarness.uninstallHarness(MODE);
      return res.status(startResp.status).json({
        success: false,
        error:   `prevOrbScalpPaper /start failed: ${JSON.stringify(startResp.body).slice(0, 300)}`,
      });
    }
    console.log(`🟢 ${LOG} Session started via the paper engine — every entry and exit below is paper's decision, mirrored to ${installed.dryRun ? "the log only" : "Zerodha"}.`);
    return res.json({
      success: true,
      mode:    installed.dryRun ? "DRY-RUN" : "LIVE (real orders)",
      message: installed.dryRun
        ? "PREV_ORB_SCALP LIVE harness started in DRY-RUN. Decisions match paper, no real orders placed. Watch /prev-orb-scalp-live."
        : "PREV_ORB_SCALP LIVE harness started — real ZERODHA orders WILL be placed.",
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
    console.log(`🔴 ${LOG} Stopped — harness uninstalled and the paper session ended. No further orders can be placed.`);
    return res.json({ success: true, message: `${MODE} harness stopped + paper session ended.`, paperStopResp: stopResp });
  } catch (err) {
    try { liveHarness.uninstallHarness(MODE); } catch (_) {}
    return res.status(500).json({ success: false, error: err.message });
  }
});

// /status is an alias of the page, so the sidebar/monitor links that append
// "/status" (the convention every paper route uses) land somewhere real.
router.get("/status", (req, res) => res.redirect("/prev-orb-scalp-live"));

router.get("/", (req, res) => {
  const cfg = liveHarness.getConfig(MODE);
  const installed = liveHarness.isInstalled(MODE);
  const dryRunCurrent = liveDryRun.isDryRun("PREV_ORB_SCALP");
  const liveActive = sharedSocketState.getPrevOrbScalpMode() === "PREV_ORB_SCALP_LIVE";
  const s = strat.getConfig();
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Prev ORB Scalp — Live</title>
${faviconLink()}
<style>
${sidebarCSS()}
${modalCSS()}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin:0; background:#0b1220; color:#e2e8f0; }
.main { margin-left:200px; padding:24px; max-width:900px; }
@media(max-width:768px){ .main{ margin-left:0; padding:14px; } }
h1 { font-size:1.3rem; margin:0 0 4px; color:#f1f5f9; }
.sub { color:#94a3b8; font-size:0.85rem; margin-bottom:16px; }
.card { background:#111827; border:1px solid #1e293b; border-radius:8px; padding:16px; margin-bottom:16px; }
.warn { background:#7f1d1d; border:1px solid #991b1b; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fee2e2; }
.warn-soft { background:#78350f; border:1px solid #92400e; border-radius:8px; padding:12px 16px; margin-bottom:16px; color:#fef3c7; }
button { background:#0369a1; color:#fff; border:0; padding:8px 18px; border-radius:6px; cursor:pointer; font-size:0.85rem; margin-right:8px; }
button:hover { background:#0284c7; }
button.stop { background:#475569; }
button:disabled { opacity:0.5; cursor:not-allowed; }
pre { background:#0a0f1c; padding:12px; border-radius:6px; overflow:auto; font-size:0.7rem; color:#cbd5e1; max-height:300px; }
.row { display:flex; gap:16px; flex-wrap:wrap; }
.label { font-size:0.7rem; color:var(--muted-1,#8ba1c2); text-transform:uppercase; letter-spacing:0.05em; }
.val   { font-size:0.95rem; color:#e2e8f0; }
.section-title { font-size:0.7rem; color:var(--muted-1,#8ba1c2); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px; font-weight:600; }
.plan { font-size:0.78rem; color:#cbd5e1; line-height:1.7; }
.plan b { color:#f1f5f9; }
.tbl-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
table { width:100%; border-collapse:collapse; font-size:0.78rem; min-width:520px; }
th { text-align:left; font-weight:600; color:var(--muted-1,#8ba1c2); font-size:0.68rem; text-transform:uppercase; letter-spacing:0.04em; padding:6px 8px; border-bottom:1px solid #1e293b; white-space:nowrap; }
td { padding:6px 8px; border-bottom:1px solid #131c2e; color:#cbd5e1; white-space:nowrap; }
.gate { display:flex; align-items:center; gap:8px; font-size:0.8rem; padding:4px 0; }
.pill { font-size:0.65rem; padding:2px 8px; border-radius:999px; font-weight:600; letter-spacing:0.04em; }
.pill.open { background:#064e3b; color:#6ee7b7; }
.pill.shut { background:#334155; color:#cbd5e1; }
@media (max-width:640px) {
  .main { margin-left:0; padding:12px 12px calc(12px + env(safe-area-inset-bottom)); max-width:100%; }
  h1 { font-size:1.05rem; }
  .card { padding:12px; }
  .row { gap:10px; }
  .row > div { min-width:0 !important; flex:1 1 46% !important; }
  button { min-height:44px; padding:10px 16px; margin-right:6px; margin-bottom:6px; }
  a { min-height:44px; display:inline-block; line-height:44px; }
  pre { font-size:0.65rem; max-height:220px; }
  .plan { font-size:0.75rem; }
  .val { font-size:0.9rem; }
  table { min-width:460px; }
}
</style>
</head>
<body>
${buildSidebar('prevOrbScalpLive', liveActive)}
<div class="main">
  <h1>● PREV ORB SCALP LIVE — via the Paper Harness</h1>
  <div class="sub">Decisions come from <a href="/prev-orb-scalp-paper/status" style="color:#38bdf8;">/prev-orb-scalp-paper</a> unchanged. Orders go to <b>Zerodha</b>; candles and premium quotes come from <b>Fyers</b>.</div>

  <div class="warn-soft"><strong>⚠️ New strategy, no track record.</strong> Prev ORB Scalp has not been validated live. Run clean paper days first and diff them against a recorded <code>/replay</code> session before you open any live gate.</div>

  ${dryRunCurrent
    ? '<div class="warn-soft"><strong>🧪 DRY-RUN mode</strong> — no real orders will be placed. Verify Live decisions match Paper on a recorded <code>/replay</code> session, then set <code>LIVE_HARNESS_DRY_RUN=false</code> and <code>PREV_ORB_SCALP_LIVE_ENABLED=true</code> (and make sure <code>PREV_ORB_SCALP_LIVE_DRY_RUN</code> is not true) in Settings to enable real Zerodha orders.</div>'
    : '<div class="warn"><strong>🔴 LIVE mode</strong> — real Zerodha orders WILL be placed when the paper engine signals. To switch back to dry-run, set <code>LIVE_HARNESS_DRY_RUN=true</code> in Settings.</div>'
  }

  <div class="card">
    <div class="section-title">The three switches</div>
    <div class="gate"><span class="pill ${String(process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() === "false" ? "open" : "shut"}">${String(process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() === "false" ? "OPEN" : "SHUT"}</span> <span><code>LIVE_HARNESS_DRY_RUN=false</code> — the global switch, shared by every strategy</span></div>
    <div class="gate"><span class="pill ${String(process.env.PREV_ORB_SCALP_LIVE_ENABLED || "false").toLowerCase() === "true" ? "open" : "shut"}">${String(process.env.PREV_ORB_SCALP_LIVE_ENABLED || "false").toLowerCase() === "true" ? "OPEN" : "SHUT"}</span> <span><code>PREV_ORB_SCALP_LIVE_ENABLED=true</code> — arms this strategy for real money</span></div>
    <div class="gate"><span class="pill ${String(process.env.PREV_ORB_SCALP_LIVE_DRY_RUN || "false").toLowerCase() === "true" ? "shut" : "open"}">${String(process.env.PREV_ORB_SCALP_LIVE_DRY_RUN || "false").toLowerCase() === "true" ? "SHUT" : "OPEN"}</span> <span><code>PREV_ORB_SCALP_LIVE_DRY_RUN</code> not true — a hold-back for this strategy alone</span></div>
    <div style="margin-top:10px;font-size:0.8rem;color:${dryRunCurrent ? "#fbbf24" : "#fca5a5"};">${dryRunCurrent ? "All three must be open. Right now they are not, so nothing reaches the exchange." : "All three are open — real orders can reach the exchange."}</div>
  </div>

  <div class="card">
    <div class="section-title">The rules being mirrored (read live from Settings)</div>
    <div class="plan">
      <b>Setup</b> — the ${strat._fmtMins(s.sessionStartMin)} ${s.orMins}-min candle closes below yesterday's LOW (PE day) or above yesterday's HIGH (CE day).<br>
      <b>Entry</b> — the first ${s.resolutionMins}-min close beyond that candle's low (PE) / high (CE), until ${strat._fmtMins(s.entryEndMin)}. One trade a day, ITM strike.<br>
      <b>Stop</b> — the break candle's high (PE) / low (CE). <b>Target</b> — the break candle's size from the entry.<br>
      <b>After target</b> — ${s.trailAfterTarget ? "stop moves to the target, then trails each closed candle's high (PE) / low (CE)." : "exit at the target."} Global profit lock applies. Square-off ${strat._fmtMins(s.forcedExitMin)}.
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
      <div style="flex:1;min-width:120px;">
        <div class="label">Data feed</div>
        <div class="val">fyers</div>
      </div>
    </div>
    <div style="margin-top:16px;">
      <button onclick="startSession()" id="start-btn"${installed ? ' disabled' : ''}>▶ Start (${dryRunCurrent ? 'DRY-RUN' : 'LIVE'})</button>
      <button onclick="stopSession()" id="stop-btn" class="stop"${!installed ? ' disabled' : ''}>■ Stop</button>
      <a href="/prev-orb-scalp-paper/status" style="color:#38bdf8;font-size:0.8rem;margin-left:8px;">open the paper page →</a>
    </div>
  </div>

  <div class="card">
    <div class="section-title">Today — what paper is seeing</div>
    <div class="row" id="po-live-context"><div class="val">Loading…</div></div>
  </div>

  <div class="card">
    <div class="section-title">Session trades (mirrored from paper)</div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>#</th><th>Side</th><th>Symbol</th><th>Entry spot</th><th>Stop</th><th>Opt in</th><th>Opt out</th><th>PnL</th><th>Reason</th></tr></thead>
        <tbody id="trades-body"><tr><td colspan="9">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <strong>Recent harness events</strong>
    <pre id="events">Loading…</pre>
  </div>
</div>

<script>
${modalJS()}
function _f(v, dash) { return (v === null || v === undefined || v === '') ? (dash || '—') : v; }
async function refresh() {
  try {
    const r = await fetch('/prev-orb-scalp-live/status/data', { cache: 'no-store' });
    const data = await r.json();
    document.getElementById('events').textContent = JSON.stringify(data.recentEvents, null, 2) || 'No events yet.';

    var box = document.getElementById('po-live-context');
    if (box) {
      var pos = data.position;
      box.innerHTML =
        '<div style="flex:1;min-width:140px;"><div class="label">Spot</div><div class="val">' + _f(data.lastTickPrice) + '</div></div>' +
        '<div style="flex:1;min-width:140px;"><div class="label">Day</div><div class="val">' + (data.setupSide ? data.setupSide + ' day' : '—') + '</div></div>' +
        '<div style="flex:1;min-width:140px;"><div class="label">Yday H / L</div><div class="val">' + _f(data.prevHigh) + ' / ' + _f(data.prevLow) + '</div></div>' +
        '<div style="flex:1;min-width:140px;"><div class="label">09:15 H / L</div><div class="val">' + _f(data.orHigh) + ' / ' + _f(data.orLow) + '</div></div>' +
        '<div style="flex:1;min-width:140px;"><div class="label">SL / Target</div><div class="val">' + (pos ? pos.slSpot + ' / ' + pos.targetSpot + (pos.targetReached ? ' ✓' : '') : '—') + '</div></div>' +
        '<div style="flex:1;min-width:140px;"><div class="label">Position</div><div class="val">' + (pos ? pos.side + ' ' + pos.symbol : 'flat') + '</div></div>' +
        '<div style="flex:1;min-width:140px;"><div class="label">Open PnL</div><div class="val">' + (data.livePnl != null ? '₹' + data.livePnl : '—') + '</div></div>' +
        '<div style="flex:1;min-width:140px;"><div class="label">Trades</div><div class="val">' + _f(data.tradesTaken) + '/' + _f(data.maxDailyTrades) + '</div></div>' +
        '<div style="flex:1;min-width:140px;"><div class="label">Session PnL</div><div class="val">' + (data.sessionPnl != null ? '₹' + data.sessionPnl : '—') + '</div></div>' +
        '<div style="flex:1;min-width:200px;"><div class="label">Last skip</div><div class="val" style="font-size:0.78rem;">' + _f(data.lastSkipReason) + '</div></div>';
    }

    var tb = document.getElementById('trades-body');
    if (tb) {
      var trades = data.sessionTrades || [];
      if (!trades.length) {
        tb.innerHTML = '<tr><td colspan="9">No trades yet today.</td></tr>';
      } else {
        tb.innerHTML = trades.map(function (t, i) {
          var pnl = t.pnl == null ? null : Math.round(t.pnl);
          var col = pnl == null ? '#cbd5e1' : (pnl >= 0 ? '#10b981' : '#ef4444');
          return '<tr><td>' + (i + 1) + '</td><td>' + _f(t.side) + '</td><td>' + _f(t.symbol) + '</td><td>' + _f(t.spotAtEntry) + '</td><td>' + _f(t.stopLoss) + '</td><td>' + _f(t.optionEntryLtp) + '</td><td>' + _f(t.optionExitLtp) + '</td>' +
                 '<td style="color:' + col + ';">' + (pnl == null ? '—' : (pnl >= 0 ? '+' : '') + pnl) + '</td><td>' + _f(t.exitReason) + '</td></tr>';
        }).join('');
      }
    }
  } catch (e) {
    document.getElementById('events').textContent = 'Fetch error: ' + e.message;
  }
}
async function startSession() {
  const ok = await showConfirm({
    icon: '${dryRunCurrent ? "🧪" : "🔴"}',
    title: '${dryRunCurrent ? "Start DRY-RUN session" : "Start LIVE session"}',
    message: '${dryRunCurrent ? "Start Prev ORB Scalp in DRY-RUN mode (no real orders)?" : "LIVE MODE — real Zerodha orders WILL be placed. This strategy has no live track record. Continue?"}',
    confirmText: '${dryRunCurrent ? "Start" : "Start (LIVE)"}',
    confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  document.getElementById('start-btn').disabled = true;
  try {
    const r = await secretFetch('/prev-orb-scalp-live/start');
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
    const r = await secretFetch('/prev-orb-scalp-live/stop');
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

// Start-All roster: this router is the PAPER-wrapping harness, not a real-order
// live engine — declared, so utils/startAllRoster.js never has to infer it from the
// mount path (a future strategy could mount a REAL live engine at /{slug}-live).
router.isLiveHarness = true;

module.exports = router;

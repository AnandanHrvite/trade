/**
 * GAP_RUNAWAY LIVE (HARNESS) — /gap_runaway-live
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs GAP_RUNAWAY LIVE by wrapping GAP_RUNAWAY PAPER with the live harness:
 *   1. Install the harness (registers notify entry/exit hooks → real broker orders)
 *   2. Trigger /gap_runaway-paper/start programmatically (paper code runs unchanged)
 *   3. As paper decides entries/exits, the harness places real ZERODHA orders
 *   4. /stop reverses: stop paper + uninstall the harness
 *
 * This guarantees LIVE = PAPER by construction. The once-a-day entry (yesterday's
 * daily RSI(10) on EMA21 below 10 + gap UP → ATM CE, above 90 + gap DOWN → ATM
 * PE), the per-tick gap stop at yesterday's close, the 5-min EMA21 trail and the
 * 15:15 square-off are whatever gapRunawayPaper says they are — single source of
 * truth. No decision, fill or exit rule lives here. No common rules apply.
 *
 * ORDERS GO TO ZERODHA. Market data still comes from Fyers, so a live session
 * needs BOTH logins: Fyers for the candles and premium quotes the decisions
 * read, Zerodha for the orders themselves.
 *
 * TRIPLE-GATED to dry-run — a real order needs ALL THREE:
 *   GAP_RUNAWAY_LIVE_ENABLED=true  — this strategy's own switch (default OFF)
 *   LIVE_HARNESS_DRY_RUN=false      — the global harness switch (default ON = dry)
 *   GAP_RUNAWAY_LIVE_DRY_RUN≠true  — a per-strategy hold-back that outranks both
 * By default NOTHING places a real order.
 *
 * Toggles:
 *   UI_SHOW_GAP_RUNAWAY_LIVE_HARNESS — show the menu item (Settings; read by sharedNav)
 *
 * This strategy is NEW and has no track record. Collect clean paper sessions and
 * check dry-run Live against Paper on the same day before you even consider a live gate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express           = require("express");
const router            = express.Router();

const liveHarness       = require("../services/liveHarness");
const zerodhaBroker     = require("../services/zerodhaBroker");
const gapRunawayPaperRoute = require("./gapRunawayPaper");
const liveDryRun        = require("../utils/liveDryRun");
const engine            = require("../strategies/gap_runaway");
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

const MODE      = "GAP_RUNAWAY-LIVE";
// gapRunawayPaper's `mode` field in its notifyEntry/notifyExit payloads. The
// harness drops every payload whose mode differs, so this MUST equal the paper
// route's tag character for character (and must be unique across strategies).
const MODE_TAG  = "GAP_RUNAWAY-PAPER";
const DRY_KEY   = "GAP_RUNAWAY";            // liveDryRun prefix → *_LIVE_ENABLED / *_LIVE_DRY_RUN
const BASE      = "/gap_runaway-live";
const PAPER     = "/gap_runaway-paper";
const LOG       = "[GAP_RUNAWAY-LIVE]";

function _liveActive() {
  return typeof sharedSocketState.getGapRunawayMode === "function" &&
    sharedSocketState.getGapRunawayMode() === "GAP_RUNAWAY_LIVE";
}

// ── Programmatic invoker for the gapRunawayPaper express router ─────────────
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
    const stack = gapRunawayPaperRoute.stack || [];
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

function _gates() {
  return {
    globalOpen: String(process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() === "false",
    stratOpen:  String(process.env.GAP_RUNAWAY_LIVE_ENABLED || "false").toLowerCase() === "true",
    holdBack:   String(process.env.GAP_RUNAWAY_LIVE_DRY_RUN || "false").toLowerCase() === "true",
  };
}

// ── Plain-language gate report, logged on every /start ───────────────────────
function _logGateReport(dryRun) {
  const g = _gates();
  const mark = (open) => (open ? "OPEN" : "SHUT");
  console.log(`🔍 ${LOG} Gate check — three switches must ALL be open before any real order is possible:`);
  console.log(`   1. LIVE_HARNESS_DRY_RUN=false (global switch) ............ ${mark(g.globalOpen)}${g.globalOpen ? "" : "  ← currently forcing dry-run for every strategy"}`);
  console.log(`   2. GAP_RUNAWAY_LIVE_ENABLED=true (this strategy) ...... ${mark(g.stratOpen)}${g.stratOpen ? "" : "  ← GAP_RUNAWAY was never armed for real money"}`);
  console.log(`   3. GAP_RUNAWAY_LIVE_DRY_RUN not true (hold-back) ...... ${mark(!g.holdBack)}${g.holdBack ? "  ← held back on purpose, only this strategy is affected" : ""}`);
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

  // Default DRY-RUN unless the operator explicitly opened all three switches.
  const dryRun = liveDryRun.isDryRun(DRY_KEY);

  // Live-order gate — enforced ONLY for real orders; dry-run runs are unaffected.
  if (!liveDryRun.isDryRun() && !_gates().stratOpen) {
    return res.status(403).json({ success: false, error: "Live trading disabled. Set GAP_RUNAWAY_LIVE_ENABLED=true to place real orders." });
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
      // NIFTY ATM options only, by the user's rule ("common settings don't apply"):
      // this strategy has no futures form, so the INSTRUMENT toggle is not consulted.
      isFutures:  false,
      // Live trades are not logged to disk — the repo-wide convention since
      // f0372ea (every harness passes null). If live logging is ever turned on
      // for this strategy, the key is "gap_runaway-live" — it MUST match
      // tradeLogger's key character for character (it is registered there),
      // because nothing normalises hyphens/underscores/case and an
      // unregistered key silently drops every live trade.
      liveLogKey: null,
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
        error:   `gapRunawayPaper /start failed: ${JSON.stringify(startResp.body).slice(0, 300)}`,
      });
    }
    console.log(`🟢 ${LOG} Session started via the paper engine — every entry and exit below is paper's decision, mirrored to ${installed.dryRun ? "the log only" : "Zerodha"}.`);
    return res.json({
      success: true,
      mode:    installed.dryRun ? "DRY-RUN" : "LIVE (real orders)",
      message: installed.dryRun
        ? `GAP_RUNAWAY LIVE harness started in DRY-RUN. Decisions match paper, no real orders placed. Watch ${BASE}.`
        : "GAP_RUNAWAY LIVE harness started — real ZERODHA orders WILL be placed.",
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
router.get("/status", (req, res) => res.redirect(BASE));

router.get("/", (req, res) => {
  const cfg = liveHarness.getConfig(MODE);
  const installed = liveHarness.isInstalled(MODE);
  const dryRunCurrent = liveDryRun.isDryRun(DRY_KEY);
  const g = _gates();
  const s = engine.getConfig("GAP_RUNAWAY");
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>GAP_runAway__Kirubakaran — Live</title>
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
button { background:#b45309; color:#fff; border:0; padding:8px 18px; border-radius:6px; cursor:pointer; font-size:0.85rem; margin-right:8px; }
button:hover { background:#d97706; }
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
${buildSidebar('gapRunawayLiveHarness', _liveActive())}
<div class="main">
  <h1>● GAP_RUNAWAY LIVE — via the Paper Harness</h1>
  <div class="sub">Decisions come from <a href="${PAPER}/status" style="color:#fbbf24;">${PAPER}</a> unchanged. Orders go to <b>Zerodha</b>; candles and premium quotes come from <b>Fyers</b>.</div>

  <div class="warn-soft"><strong>⚠️ New strategy, no track record.</strong> GAP_RUNAWAY has never traded on paper or live. Run clean paper days first, then run Live in dry-run next to Paper and check its logged orders match Paper's trades before you open any live gate.</div>

  ${dryRunCurrent
    ? '<div class="warn-soft"><strong>🧪 DRY-RUN mode</strong> — no real orders will be placed. Verify the orders Live logs match the Paper trades for at least one session, then set <code>LIVE_HARNESS_DRY_RUN=false</code> and <code>GAP_RUNAWAY_LIVE_ENABLED=true</code> (and make sure <code>GAP_RUNAWAY_LIVE_DRY_RUN</code> is not true) in Settings to enable real Zerodha orders.</div>'
    : '<div class="warn"><strong>🔴 LIVE mode</strong> — real Zerodha orders WILL be placed when the paper engine signals. To switch back to dry-run, set <code>LIVE_HARNESS_DRY_RUN=true</code> in Settings.</div>'
  }

  <div class="card">
    <div class="section-title">The three switches</div>
    <div class="gate"><span class="pill ${g.globalOpen ? "open" : "shut"}">${g.globalOpen ? "OPEN" : "SHUT"}</span> <span><code>LIVE_HARNESS_DRY_RUN=false</code> — the global switch, shared by every strategy</span></div>
    <div class="gate"><span class="pill ${g.stratOpen ? "open" : "shut"}">${g.stratOpen ? "OPEN" : "SHUT"}</span> <span><code>GAP_RUNAWAY_LIVE_ENABLED=true</code> — arms this strategy for real money</span></div>
    <div class="gate"><span class="pill ${g.holdBack ? "shut" : "open"}">${g.holdBack ? "SHUT" : "OPEN"}</span> <span><code>GAP_RUNAWAY_LIVE_DRY_RUN</code> not true — a hold-back for this strategy alone</span></div>
    <div style="margin-top:10px;font-size:0.8rem;color:${dryRunCurrent ? "#fbbf24" : "#fca5a5"};">${dryRunCurrent ? "All three must be open. Right now they are not, so nothing reaches the exchange." : "All three are open — real orders can reach the exchange."}</div>
  </div>

  <div class="card">
    <div class="section-title">The rules being mirrored (read live from Settings)</div>
    <div class="plan">
      <b>Setup</b> — YESTERDAY's closed NIFTY daily bar: RSI(${s.RSI_LENGTH}) on EMA(${s.EMA_LENGTH}) — below ${s.RSI_LOWER} oversold, above ${s.RSI_UPPER} overbought.<br>
      <b>CE</b> — oversold + today opens <b>above</b> yesterday's close (gap UP). <b>PE</b> — overbought + today opens <b>below</b> yesterday's close (gap DOWN). ATM strike, ${parseInt(process.env.GAP_RUNAWAY_LOTS || "1", 10) || 1} lot. One trade per day.<br>
      <b>Stop</b> — yesterday's close (the gap-fill level), checked on <b>every tick</b> of NIFTY spot.<br>
      <b>Trail</b> — a ${s.EXIT_TF}-min candle closing back through EMA${s.TRAIL_EMA_LENGTH} (CE below, PE above).<br>
      <b>Session</b> — entry window ${_fmtMins(s.ENTRY_START)}–${_fmtMins(s.ENTRY_END)} · square-off ${_fmtMins(s.EOD_EXIT)} · no common rules (no profit lock, breakeven, cooldown, spread check, capital pool, lot multiplier).<br>
      <b>Reference</b> — <a href="${engine.referenceUrl("GAP_RUNAWAY")}" target="_blank" rel="noopener" style="color:#60a5fa;">${engine.referenceUrl("GAP_RUNAWAY")}</a>
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
      <a href="${PAPER}/status" style="color:#fbbf24;font-size:0.8rem;margin-left:8px;">open the paper page →</a>
    </div>
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
function _esc(v) { return String(_f(v)).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
async function refresh() {
  try {
    const r = await fetch('${BASE}/status/data', { cache: 'no-store' });
    const data = await r.json();
    document.getElementById('events').textContent = JSON.stringify(data.recentEvents, null, 2) || 'No events yet.';
    var tb = document.getElementById('trades-body');
    if (tb) {
      var trades = data.sessionTrades || [];
      if (!trades.length) {
        tb.innerHTML = '<tr><td colspan="9">No trades yet today.</td></tr>';
      } else {
        tb.innerHTML = trades.map(function (t, i) {
          var pnl = t.pnl == null ? null : Math.round(t.pnl);
          var col = pnl == null ? '#cbd5e1' : (pnl >= 0 ? '#10b981' : '#ef4444');
          return '<tr><td>' + (i + 1) + '</td><td>' + _esc(t.side) + '</td><td>' + _esc(t.symbol) + '</td><td>' + _esc(t.spotAtEntry) + '</td><td>' + _esc(t.stopLoss) + '</td><td>' + _esc(t.optionEntryLtp) + '</td><td>' + _esc(t.optionExitLtp) + '</td>' +
                 '<td style="color:' + col + ';">' + (pnl == null ? '—' : (pnl >= 0 ? '+' : '') + pnl) + '</td><td>' + _esc(t.exitReason) + '</td></tr>';
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
    message: '${dryRunCurrent ? "Start GAP_RUNAWAY in DRY-RUN mode (no real orders)?" : "LIVE MODE — real Zerodha orders WILL be placed. This strategy has no live track record. Continue?"}',
    confirmText: '${dryRunCurrent ? "Start" : "Start (LIVE)"}',
    confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  document.getElementById('start-btn').disabled = true;
  try {
    const r = await secretFetch('${BASE}/start');
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
    const r = await secretFetch('${BASE}/stop');
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

function _fmtMins(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// Start-All roster: this router is the PAPER-wrapping harness, not a real-order
// live engine — declared, so utils/startAllRoster.js never has to infer it from the
// mount path (a future strategy could mount a REAL live engine at /{slug}-live).
router.isLiveHarness = true;

module.exports = router;
module.exports.MODE = MODE;
module.exports.MODE_TAG = MODE_TAG;

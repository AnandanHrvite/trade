/**
 * REPLAY — /replay
 * ─────────────────────────────────────────────────────────────────────────────
 * Re-runs a previously recorded paper-trade session through the SAME paper
 * `onTick()` handlers. Two modes:
 *
 *   • Snapshot (default)         — applies the session-start settings snapshot,
 *                                  result is identical every time (deterministic).
 *                                  Output → ~/trading-data/_replay_trades/
 *
 *   • Current settings (simulator) — skips the snapshot, uses whatever is in
 *                                  process.env right now (the user's Settings
 *                                  page values). Lets you test settings changes
 *                                  after market hours against real recorded ticks.
 *                                  Output → ~/trading-data/_replay_trades_sim/
 *
 * Routes:
 *   GET  /replay                   → UI page
 *   GET  /replay/list              → JSON list of recorded sessions
 *   GET  /replay/preflight         → JSON: { ok, reason? }; safe-to-replay check
 *   POST /replay/run               → JSON: run a replay; returns trades + pnl
 *
 * Visibility:
 *   Page is hidden from sidebar when UI_SHOW_REPLAY=false (default true).
 *   Backend routes remain reachable so the bar-based backtests can dispatch
 *   to /replay/run programmatically.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();

const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");
const tickReplay = require("../services/tickReplay");

router.get("/list", (req, res) => {
  try {
    const date = req.query.date || undefined;
    res.json({ ok: true, ...tickReplay.listRecordings(date) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/preflight", (req, res) => {
  try {
    res.json(tickReplay.replayPreflight());
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

// Recovery path for the "preflight blocks but no session is actually running"
// bug — clears the in-memory sharedSocketState mutex flags. Does NOT touch
// any persisted data (trade logs, position files, recordings).
router.post("/force-clear", (req, res) => {
  try {
    res.json(tickReplay.forceClearSharedState());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/run", express.json(), async (req, res) => {
  const { date, mode, sessionId, speed, useCurrentSettings } = req.body || {};
  if (!date || !mode) {
    return res.status(400).json({ ok: false, error: "date and mode are required" });
  }
  try {
    const result = await tickReplay.replaySession({
      date,
      mode,
      sessionId,
      speed: typeof speed === "number" ? speed : 0,
      useCurrentSettings: !!useCurrentSettings,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/", (req, res) => {
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Replay — Tick-Replay Backtest</title>
${faviconLink()}
<style>
${sidebarCSS()}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin:0; background:#0b1220; color:#e2e8f0; }
.main { margin-left:260px; padding:24px; }
h1 { font-size:1.3rem; margin:0 0 4px; color:#f1f5f9; }
.sub { color:#94a3b8; font-size:0.85rem; margin-bottom:16px; }
.card { background:#111827; border:1px solid #1e293b; border-radius:8px; padding:16px; margin-bottom:16px; }
table { width:100%; border-collapse:collapse; font-size:0.85rem; }
th, td { padding:8px 10px; text-align:left; border-bottom:1px solid #1e293b; }
th { color:#94a3b8; font-weight:600; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.04em; }
tbody tr:hover { background:#1a2236; }
button { background:#3b82f6; color:#fff; border:0; padding:6px 14px; border-radius:6px; cursor:pointer; font-size:0.8rem; }
button:hover { background:#2563eb; }
button:disabled { background:#374151; cursor:not-allowed; }
.tag { display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.7rem; font-weight:600; }
.tag.swing { background:rgba(59,130,246,0.15); color:#60a5fa; }
.tag.scalp { background:rgba(245,158,11,0.15); color:#fbbf24; }
.tag.pa    { background:rgba(168,85,247,0.15); color:#c084fc; }
.result-pnl { font-size:1.4rem; font-weight:700; margin:8px 0; }
.result-pnl.positive { color:#10b981; }
.result-pnl.negative { color:#ef4444; }
.muted { color:#64748b; font-size:0.75rem; }
.cmp-grid { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:12px; margin-top:12px; }
.cmp-col  { background:#0f172a; border:1px solid #1e293b; border-radius:8px; padding:14px; }
.cmp-col.delta { border-color:#334155; }
.cmp-label { font-size:0.7rem; text-transform:uppercase; letter-spacing:0.05em; color:#94a3b8; font-weight:600; margin-bottom:6px; }
.cmp-pnl   { font-size:1.6rem; font-weight:700; margin:4px 0; }
.cmp-pnl.positive { color:#10b981; }
.cmp-pnl.negative { color:#ef4444; }
.cmp-pnl.neutral  { color:#94a3b8; }
.cmp-meta  { font-size:0.75rem; color:#94a3b8; margin-top:4px; }
.cmp-meta-row { display:flex; justify-content:space-between; padding:2px 0; }
.cmp-meta-row.delta-row { color:#cbd5e1; }
.cmp-delta-up   { color:#10b981; }
.cmp-delta-down { color:#ef4444; }
.cmp-delta-zero { color:#64748b; }
.cmp-err { background:rgba(239,68,68,0.10); border-color:rgba(239,68,68,0.35); color:#fca5a5; font-size:0.8rem; }
@media (max-width: 900px) { .cmp-grid { grid-template-columns: 1fr; } }
.block-alert { position:fixed; top:0; left:0; right:0; z-index:9999; background:rgba(239,68,68,0.97); color:#fff; padding:14px 20px; box-shadow:0 4px 16px rgba(0,0,0,0.4); font-size:0.9rem; display:flex; justify-content:space-between; align-items:center; gap:16px; animation:slideDown 0.2s ease-out; }
.block-alert strong { display:block; font-size:1rem; margin-bottom:2px; }
.block-alert .ba-close { background:rgba(255,255,255,0.18); border:0; color:#fff; padding:6px 14px; border-radius:6px; cursor:pointer; font-size:0.85rem; font-weight:600; }
.block-alert .ba-close:hover { background:rgba(255,255,255,0.3); }
@keyframes slideDown { from { transform:translateY(-100%); } to { transform:translateY(0); } }
.range-row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; margin-top:8px; }
.range-field { display:flex; flex-direction:column; gap:4px; }
.range-field label { font-size:0.7rem; text-transform:uppercase; letter-spacing:0.04em; color:#94a3b8; }
.range-field input, .range-field select { background:#0a0f1c; color:#e2e8f0; border:1px solid #1e293b; border-radius:6px; padding:8px 10px; font-size:0.85rem; min-width:140px; }
.range-progress { margin-top:8px; padding:8px 12px; background:#0a0f1c; border:1px solid #1e293b; border-radius:6px; font-size:0.8rem; color:#cbd5e1; }
.range-table { width:100%; border-collapse:collapse; font-size:0.8rem; margin-top:12px; }
.range-table th, .range-table td { padding:6px 10px; text-align:left; border-bottom:1px solid #1e293b; }
.range-table th { color:#94a3b8; font-weight:600; font-size:0.7rem; text-transform:uppercase; letter-spacing:0.04em; }
.range-table tr.totals { font-weight:700; background:#0f172a; }
.range-table tr.totals td { border-top:2px solid #334155; border-bottom:0; }
.range-table .num { text-align:right; font-variant-numeric: tabular-nums; }
.activity-log { margin-top:10px; background:#020617; border:1px solid #1e293b; border-radius:6px; padding:8px 10px; max-height:240px; overflow-y:auto; font-family: ui-monospace, Menlo, monospace; font-size:0.72rem; line-height:1.5; color:#94a3b8; }
.activity-log .log-line { white-space:pre-wrap; word-break:break-word; }
.activity-log .log-line.err { color:#fca5a5; }
.activity-log .log-line.warn { color:#fbbf24; }
.activity-log .log-line.ok { color:#6ee7b7; }
.activity-log-empty { color:#475569; font-style:italic; }
.copy-btn { background:#0f766e; color:#ccfbf1; border:1px solid #14b8a6; padding:6px 12px; border-radius:6px; font-size:0.78rem; cursor:pointer; margin-top:10px; }
.copy-btn:hover { background:#14b8a6; }
.copy-btn.copied { background:#15803d; border-color:#22c55e; color:#fff; }
pre { background:#0a0f1c; padding:12px; border-radius:6px; overflow:auto; font-size:0.75rem; color:#cbd5e1; }
.empty { padding:32px; text-align:center; color:#64748b; }
.banner { padding:10px 14px; border-radius:6px; font-size:0.85rem; margin-bottom:16px; }
.banner.warn { background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.4); color:#fca5a5; }
.banner.ok   { background:rgba(16,185,129,0.10); border:1px solid rgba(16,185,129,0.35); color:#6ee7b7; }
.mode-toggle { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
.mode-toggle label { display:flex; gap:8px; align-items:flex-start; padding:10px 12px; border:1px solid #1e293b; border-radius:6px; cursor:pointer; flex:1; min-width:260px; background:#0f172a; }
.mode-toggle label:hover { border-color:#334155; }
.mode-toggle input[type="radio"]:checked + .mt-body { color:#f1f5f9; }
.mode-toggle label:has(input:checked) { border-color:#3b82f6; background:#172033; }
.mt-title { font-weight:600; font-size:0.85rem; color:#e2e8f0; }
.mt-desc  { color:#94a3b8; font-size:0.75rem; margin-top:2px; line-height:1.4; }
</style>
</head>
<body>
${buildSidebar('replay', false)}
<div class="main">
  <h1>📼 Tick Replay — Deterministic Backtest &amp; After-Hours Simulator</h1>
  <div class="sub">
    Re-runs a recorded paper-trade session through the same paper code, using either the recorded settings (deterministic) or your current Settings page values (simulator). Tick recording is enabled by default; sessions appear here automatically after each paper run.
  </div>

  <div id="preflight-banner"></div>

  <div class="card">
    <strong>Settings source</strong>
    <div class="muted" style="margin-top:4px;">Pick once; applies to every Replay click below.</div>
    <div class="mode-toggle">
      <label>
        <input type="radio" name="settings-source" value="snapshot" checked>
        <div class="mt-body">
          <div class="mt-title">Snapshot settings (deterministic)</div>
          <div class="mt-desc">Use the exact settings the session recorded. Same result every time — useful for verifying code changes.</div>
        </div>
      </label>
      <label>
        <input type="radio" name="settings-source" value="current">
        <div class="mt-body">
          <div class="mt-title">My current settings (simulator)</div>
          <div class="mt-desc">Use what's in the Settings page right now. Test config tweaks against real ticks after market hours. Keep INSTRUMENT/EXPIRY same as the recorded session.</div>
        </div>
      </label>
    </div>
  </div>

  <div class="card">
    <strong>Date-range <span id="range-mode-label">replay</span></strong>
    <div class="muted" id="range-description" style="margin-top:4px;">Replay every recorded session in the range. Description updates based on your Settings source choice above.</div>
    <div class="range-row">
      <div class="range-field">
        <label>From</label>
        <input type="date" id="range-from">
      </div>
      <div class="range-field">
        <label>To</label>
        <input type="date" id="range-to">
      </div>
      <div class="range-field">
        <label>Strategy</label>
        <select id="range-mode">
          <option value="pa-paper">PA Paper</option>
          <option value="scalp-paper">Scalp Paper</option>
          <option value="swing-paper">Swing Paper</option>
        </select>
      </div>
      <div class="range-field">
        <label>&nbsp;</label>
        <button id="range-run-btn" onclick="runRange(this)">▶ Run range</button>
      </div>
    </div>
    <div id="range-progress" style="display:none;"></div>
    <div id="activity-log" class="activity-log" style="display:none;">
      <div class="activity-log-empty">Activity log will stream here while the replay runs…</div>
    </div>
    <div id="range-result" style="margin-top:12px;"></div>
  </div>

  <div class="card">
    <strong>Recorded sessions</strong>
    <div id="sessions-table" style="margin-top:12px;">Loading…</div>
  </div>

  <div class="card" id="result-card" style="display:none;">
    <strong>Single-session replay result</strong>
    <div id="result-content"></div>
  </div>
</div>

<script>
let _preflightOk = true;
let _myReplayRunning = false; // true while THIS tab is actively running a replay

async function refreshPreflight() {
  const banner = document.getElementById('preflight-banner');

  // If our own tab is running a replay, the backend's _replayInProgress
  // flag will trip the preflight — but that's not a stuck state, it's our
  // own healthy run. Show a neutral indicator instead of the alarming
  // red banner with a "Force clear" button.
  if (_myReplayRunning) {
    _preflightOk = false;
    banner.innerHTML = '<div class="banner ok" style="background:rgba(59,130,246,0.10);border-color:rgba(59,130,246,0.35);color:#93c5fd;">🔄 Replay in progress — running your test…</div>';
    return;
  }

  try {
    const r = await fetch('/replay/preflight');
    const data = await r.json();
    _preflightOk = !!data.ok;
    if (data.ok) {
      banner.innerHTML = '<div class="banner ok">✅ Safe to replay — no live or paper session is active.</div>';
    } else {
      // Distinguish "another tab/process is replaying" from "a strategy is
      // running" — only the second case warrants a Force clear suggestion.
      const isAnotherReplay = /another replay is already running/i.test(data.reason || '');
      banner.innerHTML =
        '<div class="banner warn" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">' +
          '<div>⚠️ ' + (data.reason || 'Replay not allowed right now.') + '</div>' +
          (isAnotherReplay
            ? '<span class="muted" style="color:#fca5a5;font-size:0.78rem;">Wait for it to finish, or open the tab that started it.</span>'
            : '<button onclick="forceClearStuckState(this)" style="background:#7f1d1d;color:#fecaca;border:1px solid #b91c1c;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer;">Force clear (only if no session is actually running)</button>'
          ) +
        '</div>';
    }
    // Reflect on existing buttons
    document.querySelectorAll('button.replay-btn').forEach(b => {
      if (!_preflightOk) { b.disabled = true; b.title = (data.reason || ''); }
      else if (b.textContent === '▶ Replay') { b.disabled = false; b.title = ''; }
    });
  } catch (e) {
    banner.innerHTML = '<div class="banner warn">Preflight check failed: ' + e.message + '</div>';
  }
}

async function forceClearStuckState(btn) {
  if (!confirm('Force-clear the in-memory session state?\\n\\n' +
               'Only do this if you have confirmed on the strategy pages (Swing/Scalp/PA Paper) that NO session is actually running.\\n\\n' +
               'This only clears the in-memory mutex flag — it does NOT touch trade logs, positions, or recordings.')) return;
  btn.disabled = true;
  btn.textContent = 'Clearing…';
  try {
    const r = await fetch('/replay/force-clear', { method: 'POST' });
    const data = await r.json();
    if (data.ok) {
      btn.textContent = 'Cleared ✓';
      // Refresh banner immediately to flip green
      setTimeout(refreshPreflight, 100);
    } else {
      btn.disabled = false;
      btn.textContent = 'Force clear';
      alert('Force-clear failed: ' + (data.error || 'unknown'));
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Force clear';
    alert('Force-clear failed: ' + e.message);
  }
}

async function loadSessions() {
  const div = document.getElementById('sessions-table');
  try {
    const r = await fetch('/replay/list');
    const data = await r.json();
    if (!data.ok) {
      div.innerHTML = '<div class="empty">Error: ' + (data.error || 'unknown') + '</div>';
      return;
    }
    if (!data.sessions || data.sessions.length === 0) {
      div.innerHTML = '<div class="empty">No recordings yet. Run a paper session — it auto-records and will appear here.</div>';
      return;
    }
    const sorted = data.sessions.slice().sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
    let html = '<table><thead><tr><th>Date</th><th>Mode</th><th>Session ID</th><th>Duration</th><th>Warmup</th><th></th></tr></thead><tbody>';
    for (const s of sorted) {
      const tag = s.mode.startsWith('swing') ? 'swing' : s.mode.startsWith('scalp') ? 'scalp' : 'pa';
      const dur = s.durationMs != null ? Math.floor(s.durationMs / 60000) + ' min' : '—';
      const disabledAttr = _preflightOk ? '' : 'disabled';
      html += '<tr>' +
        '<td>' + s.date + '</td>' +
        '<td><span class="tag ' + tag + '">' + s.mode + '</span></td>' +
        '<td><code style="font-size:0.7rem;color:#94a3b8;">' + s.sessionId + '</code></td>' +
        '<td>' + dur + '</td>' +
        '<td>' + s.warmupCandles + ' candles</td>' +
        '<td><button class="replay-btn" ' + disabledAttr + ' onclick="runReplay(\\'' + s.date + '\\',\\'' + s.mode + '\\',\\'' + s.sessionId + '\\',this)">▶ Replay</button></td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    div.innerHTML = html;
  } catch (e) {
    div.innerHTML = '<div class="empty">Fetch failed: ' + e.message + '</div>';
  }
}

function getSelectedSettingsSource() {
  const sel = document.querySelector('input[name="settings-source"]:checked');
  return sel ? sel.value : 'snapshot';
}

// Update the date-range card's labels + button text whenever the user
// switches the settings-source radio. This makes the UI's intent crystal
// clear before the user clicks Run.
function refreshSettingsSourceUi() {
  const isCurrent = getSelectedSettingsSource() === 'current';
  const modeLabel = document.getElementById('range-mode-label');
  const desc      = document.getElementById('range-description');
  const runBtn    = document.getElementById('range-run-btn');
  if (modeLabel) modeLabel.textContent = isCurrent ? 'comparison' : 'replay';
  if (desc) {
    desc.innerHTML = isCurrent
      ? 'Replay every recorded session <strong>twice</strong> (snapshot baseline + your current settings), showing the delta. Useful for testing config changes against real ticks.'
      : 'Replay every recorded session <strong>once</strong> using the exact settings each session was recorded with. Deterministic — same result every time. Useful for verifying paper P&L or code-change impact.';
  }
  if (runBtn && !runBtn.disabled) {
    runBtn.textContent = isCurrent ? '▶ Run range (compare)' : '▶ Run range (snapshot)';
  }
  // Also refresh single-row Replay buttons' tooltip so it's obvious which mode they will run in.
  document.querySelectorAll('button.replay-btn').forEach(b => {
    if (!b.disabled) b.title = isCurrent ? 'Will run twice: snapshot baseline + your current settings, then compare' : 'Will run once using the recorded settings (deterministic)';
  });
}

function fmtRupee(v) {
  const n = Number(v) || 0;
  const sign = n >= 0 ? '+' : '−';
  return sign + '₹' + Math.abs(n).toFixed(2);
}

function deltaClass(d) {
  if (Math.abs(d) < 0.005) return 'cmp-delta-zero';
  return d > 0 ? 'cmp-delta-up' : 'cmp-delta-down';
}

function deltaArrow(d) {
  if (Math.abs(d) < 0.005) return '–';
  return d > 0 ? '▲' : '▼';
}

async function callReplayApi(date, mode, sessionId, useCurrentSettings) {
  const r = await fetch('/replay/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, mode, sessionId, speed: 0, useCurrentSettings }),
  });
  return r.json();
}

// Hard preflight: fetch FRESH state from server, not the 5-second-cached poll.
// Returns { ok: true } or { ok: false, reason, activeModes }.
async function freshPreflight() {
  try {
    const r = await fetch('/replay/preflight', { cache: 'no-store' });
    return await r.json();
  } catch (e) {
    return { ok: false, reason: 'Preflight check failed: ' + e.message };
  }
}

function showBlockAlert(reason) {
  // Remove any existing block alert first
  const existing = document.getElementById('block-alert');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'block-alert';
  div.className = 'block-alert';
  div.innerHTML =
    '<div>' +
      '<strong>⛔ Replay blocked — a session is currently active</strong>' +
      '<div>' + reason + '</div>' +
      '<div style="font-size:0.78rem;opacity:0.85;margin-top:4px;">Stop the active session(s) from the Dashboard, then try again. This protects your live/paper trade logs from being affected.</div>' +
    '</div>' +
    '<button class="ba-close" onclick="document.getElementById(\\'block-alert\\').remove()">Dismiss</button>';
  document.body.appendChild(div);
  // Auto-dismiss after 12s so it doesn't linger forever
  setTimeout(() => { const el = document.getElementById('block-alert'); if (el) el.remove(); }, 12000);
}

function renderSingleResult(content, data, modeLabel) {
  const pnlClass = (data.sessionPnl || 0) >= 0 ? 'positive' : 'negative';
  const pnlSign  = (data.sessionPnl || 0) >= 0 ? '+' : '';
  let html = '<div class="muted">Mode: <strong>' + modeLabel + '</strong></div>';
  html += '<div class="result-pnl ' + pnlClass + '">' + pnlSign + '₹' + (data.sessionPnl || 0).toFixed(2) + '</div>';
  html += '<div class="muted">' + data.tradeCount + ' trades · ' + data.ticksReplayed + ' ticks · ' + (data.durationMs / 1000).toFixed(2) + 's</div>';
  if (data.sessionTrades && data.sessionTrades.length) {
    html += '<details style="margin-top:12px;"><summary class="muted">Trade details</summary><pre>' + JSON.stringify(data.sessionTrades, null, 2) + '</pre></details>';
  }
  content.innerHTML = html;
}

function renderComparison(content, baseline, sim, header) {
  const bPnl = baseline.ok ? (baseline.sessionPnl || 0) : 0;
  const sPnl = sim.ok      ? (sim.sessionPnl      || 0) : 0;
  const bTrd = baseline.ok ? (baseline.tradeCount || 0) : 0;
  const sTrd = sim.ok      ? (sim.tradeCount      || 0) : 0;
  const dPnl = sPnl - bPnl;
  const dTrd = sTrd - bTrd;

  const colSnapshot =
    '<div class="cmp-col ' + (baseline.ok ? '' : 'cmp-err') + '">' +
      '<div class="cmp-label">Snapshot (baseline)</div>' +
      (baseline.ok
        ? '<div class="cmp-pnl ' + (bPnl >= 0 ? 'positive' : 'negative') + '">' + (bPnl >= 0 ? '+' : '') + '₹' + bPnl.toFixed(2) + '</div>' +
          '<div class="cmp-meta">' +
            '<div class="cmp-meta-row"><span>Trades</span><span>' + bTrd + '</span></div>' +
            '<div class="cmp-meta-row"><span>Ticks</span><span>' + (baseline.ticksReplayed || 0) + '</span></div>' +
            '<div class="cmp-meta-row"><span>Took</span><span>' + ((baseline.durationMs || 0) / 1000).toFixed(2) + 's</span></div>' +
          '</div>'
        : '<div style="margin-top:8px;">⚠️ ' + (baseline.error || 'failed') + '</div>') +
    '</div>';

  const colSim =
    '<div class="cmp-col ' + (sim.ok ? '' : 'cmp-err') + '">' +
      '<div class="cmp-label">Your current settings</div>' +
      (sim.ok
        ? '<div class="cmp-pnl ' + (sPnl >= 0 ? 'positive' : 'negative') + '">' + (sPnl >= 0 ? '+' : '') + '₹' + sPnl.toFixed(2) + '</div>' +
          '<div class="cmp-meta">' +
            '<div class="cmp-meta-row"><span>Trades</span><span>' + sTrd + '</span></div>' +
            '<div class="cmp-meta-row"><span>Ticks</span><span>' + (sim.ticksReplayed || 0) + '</span></div>' +
            '<div class="cmp-meta-row"><span>Took</span><span>' + ((sim.durationMs || 0) / 1000).toFixed(2) + 's</span></div>' +
          '</div>'
        : '<div style="margin-top:8px;">⚠️ ' + (sim.error || 'failed') + '</div>') +
    '</div>';

  const verdict =
    (!baseline.ok || !sim.ok) ? '' :
    Math.abs(dPnl) < 0.005 ? 'No change — your settings produce the same result on these ticks.' :
    dPnl > 0 ? 'Your current settings are <strong>better</strong> on this session by ' + fmtRupee(dPnl) + '.' :
                'Your current settings are <strong>worse</strong> on this session by ' + fmtRupee(dPnl) + '.';

  const colDelta = (!baseline.ok || !sim.ok)
    ? '<div class="cmp-col delta"><div class="cmp-label">Delta</div><div class="cmp-meta">Need both runs to compare.</div></div>'
    : '<div class="cmp-col delta">' +
        '<div class="cmp-label">Delta (yours − baseline)</div>' +
        '<div class="cmp-pnl ' + (Math.abs(dPnl) < 0.005 ? 'neutral' : (dPnl > 0 ? 'positive' : 'negative')) + '">' +
          deltaArrow(dPnl) + ' ' + fmtRupee(dPnl) +
        '</div>' +
        '<div class="cmp-meta">' +
          '<div class="cmp-meta-row delta-row"><span>Trades</span>' +
            '<span class="' + deltaClass(dTrd) + '">' + deltaArrow(dTrd) + ' ' + (dTrd > 0 ? '+' : '') + dTrd + '</span></div>' +
          '<div class="cmp-meta-row delta-row"><span>P&L / trade</span>' +
            '<span class="' + deltaClass(dPnl) + '">' + fmtRupee(sTrd > 0 ? (sPnl / sTrd) - (bTrd > 0 ? (bPnl / bTrd) : 0) : 0) + '</span></div>' +
        '</div>' +
      '</div>';

  let html = '<div class="muted">' + header + '</div>';
  html += '<div class="cmp-grid">' + colSnapshot + colSim + colDelta + '</div>';
  if (verdict) html += '<div class="muted" style="margin-top:10px;">' + verdict + '</div>';

  if (baseline.ok && baseline.sessionTrades && baseline.sessionTrades.length) {
    html += '<details style="margin-top:12px;"><summary class="muted">Baseline trade details (' + baseline.sessionTrades.length + ')</summary><pre>' + JSON.stringify(baseline.sessionTrades, null, 2) + '</pre></details>';
  }
  if (sim.ok && sim.sessionTrades && sim.sessionTrades.length) {
    html += '<details style="margin-top:6px;"><summary class="muted">Your-settings trade details (' + sim.sessionTrades.length + ')</summary><pre>' + JSON.stringify(sim.sessionTrades, null, 2) + '</pre></details>';
  }
  content.innerHTML = html;
}

async function runReplay(date, mode, sessionId, btn) {
  // Fresh authoritative check (not the cached 5s poll) right before launching.
  const pre = await freshPreflight();
  if (!pre.ok) {
    _preflightOk = false;
    refreshPreflight(); // refresh the banner too
    showBlockAlert(pre.reason || 'A live or paper session is currently active.');
    return;
  }
  _myReplayRunning = true;
  refreshPreflight(); // flip banner to neutral "in progress" immediately
  const useCurrentSettings = (getSelectedSettingsSource() === 'current');
  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  const card = document.getElementById('result-card');
  const content = document.getElementById('result-content');
  card.style.display = 'block';

  const header = date + ' / ' + mode + ' / <code style="color:#94a3b8;">' + sessionId + '</code>';

  try {
    if (!useCurrentSettings) {
      // Snapshot-only mode: single run, single result.
      content.innerHTML = '<div class="muted">Replaying ' + header + ' — snapshot (deterministic)…</div>';
      const data = await callReplayApi(date, mode, sessionId, false);
      btn.disabled = false;
      btn.textContent = '▶ Replay';
      if (!data.ok) {
        content.innerHTML = '<div style="color:#ef4444;">Error: ' + (data.error || 'unknown') + '</div>';
        return;
      }
      renderSingleResult(content, data, 'snapshot (deterministic)');
      return;
    }

    // Simulator mode: run baseline FIRST, then your-settings, then compare.
    content.innerHTML = '<div class="muted">[1/2] Replaying baseline (snapshot settings) for ' + header + '…</div>';
    const baseline = await callReplayApi(date, mode, sessionId, false);

    content.innerHTML = '<div class="muted">[2/2] Replaying with your current settings…</div>';
    const sim = await callReplayApi(date, mode, sessionId, true);

    btn.disabled = false;
    btn.textContent = '▶ Replay';
    renderComparison(content, baseline, sim, header);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '▶ Replay';
    content.innerHTML = '<div style="color:#ef4444;">Run failed: ' + e.message + '</div>';
  } finally {
    _myReplayRunning = false;
    refreshPreflight(); // flip banner back to green/red authoritative state
  }
}

// ── Live activity log polling ──────────────────────────────────────────────
let _logPollTimer    = null;
let _logPollFromIdx  = null;  // index marker — set on poll start so we only see new entries
let _logBuf          = [];    // collected log entries for the copy button

function classifyLogLine(text) {
  if (!text) return '';
  if (/❌|🚨|error/i.test(text))           return 'err';
  if (/⚠️|warn|skip/i.test(text))          return 'warn';
  if (/✅|🛒|🎯|entry|sold|exit|profit/i.test(text)) return 'ok';
  return '';
}

async function pollLogs() {
  try {
    const r = await fetch('/logs/data?from=' + _logPollFromIdx + '&limit=200', { cache: 'no-store' });
    const data = await r.json();
    if (!data || !Array.isArray(data.logs)) return;
    const pane = document.getElementById('activity-log');
    if (data.logs.length > 0) {
      const wasEmpty = pane.querySelector('.activity-log-empty');
      if (wasEmpty) pane.innerHTML = '';
      for (const entry of data.logs) {
        _logBuf.push(entry);
        const div = document.createElement('div');
        const text = typeof entry === 'string' ? entry : (entry && entry.msg ? entry.msg : JSON.stringify(entry));
        div.className = 'log-line ' + classifyLogLine(text);
        div.textContent = text;
        pane.appendChild(div);
      }
      // Cap at last 500 lines in the DOM to keep it light
      while (pane.childNodes.length > 500) pane.removeChild(pane.firstChild);
      pane.scrollTop = pane.scrollHeight;
    }
    _logPollFromIdx = data.from + data.logs.length;
  } catch (_) { /* ignore poll errors */ }
}

async function startLogPolling() {
  _logBuf = [];
  // Get current total so we only see entries from this run forward
  try {
    const r = await fetch('/logs/data?from=0&limit=1', { cache: 'no-store' });
    const data = await r.json();
    _logPollFromIdx = (data && typeof data.total === 'number') ? data.total : 0;
  } catch (_) {
    _logPollFromIdx = 0;
  }
  const pane = document.getElementById('activity-log');
  pane.style.display = 'block';
  pane.innerHTML = '<div class="activity-log-empty">Waiting for log lines…</div>';
  if (_logPollTimer) clearInterval(_logPollTimer);
  _logPollTimer = setInterval(pollLogs, 1000);
  // Kick one immediately so the user sees something fast
  pollLogs();
}

function stopLogPolling() {
  if (_logPollTimer) { clearInterval(_logPollTimer); _logPollTimer = null; }
  // One final poll so we capture the last few lines
  pollLogs();
}

// Builds a single text blob with everything I'd need to debug a divergence:
// result summary + per-session trade details + recent activity log.
function buildDiagnosticBlob(context, rows) {
  const lines = [];
  lines.push('===== REPLAY DIAGNOSTIC =====');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('Strategy: ' + (context && context.mode));
  lines.push('Range: ' + (context && context.from) + ' → ' + (context && context.to));
  lines.push('Sessions: ' + rows.length);
  lines.push('');

  // Per-session summary + full trade JSON
  rows.forEach((r, i) => {
    lines.push('----- SESSION ' + (i + 1) + ' -----');
    lines.push('Date:       ' + r.session.date);
    lines.push('Mode:       ' + r.session.mode);
    lines.push('SessionID:  ' + r.session.sessionId);
    if (r.baseline && r.baseline.ok) {
      lines.push('Baseline:   PnL=' + r.baseline.sessionPnl + ' | trades=' + r.baseline.tradeCount + ' | ticks=' + r.baseline.ticksReplayed);
      lines.push('Baseline trades (full JSON):');
      lines.push(JSON.stringify(r.baseline.sessionTrades, null, 2));
    } else {
      lines.push('Baseline:   FAILED — ' + (r.baseline && r.baseline.error));
    }
    if (r.sim && r.sim.ok) {
      lines.push('YourCfg:    PnL=' + r.sim.sessionPnl + ' | trades=' + r.sim.tradeCount + ' | ticks=' + r.sim.ticksReplayed);
      lines.push('YourCfg trades (full JSON):');
      lines.push(JSON.stringify(r.sim.sessionTrades, null, 2));
    } else {
      lines.push('YourCfg:    FAILED — ' + (r.sim && r.sim.error));
    }
    lines.push('');
  });

  lines.push('----- ACTIVITY LOG (' + _logBuf.length + ' lines) -----');
  for (const entry of _logBuf) {
    const text = typeof entry === 'string' ? entry : (entry && entry.msg ? entry.msg : JSON.stringify(entry));
    lines.push(text);
  }

  return lines.join('\n');
}

async function copyDiagnostic(btn, context, rows) {
  const blob = buildDiagnosticBlob(context, rows);
  try {
    await navigator.clipboard.writeText(blob);
    btn.textContent = '✓ Copied — paste it back in chat';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '📋 Copy diagnostic data'; btn.classList.remove('copied'); }, 4000);
  } catch (e) {
    // Fallback for non-HTTPS contexts (this app runs on http://13.204…)
    const ta = document.createElement('textarea');
    ta.value = blob;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      btn.textContent = '✓ Copied — paste it back in chat';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋 Copy diagnostic data'; btn.classList.remove('copied'); }, 4000);
    } catch (_) {
      alert('Copy failed. Selecting the textarea for manual copy.');
      ta.style.position = 'static';
      ta.style.left = '';
      ta.style.width = '100%';
      ta.style.height = '300px';
    }
    setTimeout(() => { try { document.body.removeChild(ta); } catch (_) {} }, 200);
  }
}

// ── Date-range orchestration ───────────────────────────────────────────────
let _allSessionsCache = [];

function setRangeDefaults() {
  // Constrain From/To to the actual recorded date range.
  // Falls back to "today only" if no recordings exist yet.
  const fromEl = document.getElementById('range-from');
  const toEl   = document.getElementById('range-to');
  const dates  = _allSessionsCache.map(s => s.date).filter(Boolean);
  if (dates.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    fromEl.min = fromEl.max = toEl.min = toEl.max = today;
    fromEl.value = toEl.value = today;
    return;
  }
  dates.sort();
  const earliest = dates[0];
  const latest   = dates[dates.length - 1];
  fromEl.min = earliest; fromEl.max = latest;
  toEl.min   = earliest; toEl.max   = latest;
  // Only set defaults if user hasn't already picked something valid.
  if (!fromEl.value || fromEl.value < earliest || fromEl.value > latest) fromEl.value = earliest;
  if (!toEl.value   || toEl.value   < earliest || toEl.value   > latest) toEl.value   = latest;
}

function pickSessionsInRange(from, to, mode) {
  // Sessions are deduped by sessionId in listRecordings, sorted newest-first.
  return _allSessionsCache
    .filter(s => s.mode === mode && s.date >= from && s.date <= to && s.durationMs != null)
    .sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
}

function renderRangeResult(rows, context) {
  // rows: [{ session, baseline, sim }]
  // context: { mode, label, from, to } — describes what was run
  const el = document.getElementById('range-result');

  const modeTag = context && context.mode
    ? (context.mode.startsWith('swing') ? 'swing' : context.mode.startsWith('scalp') ? 'scalp' : 'pa')
    : 'pa';
  const headerLine = context
    ? '<div style="margin-bottom:10px;font-size:0.9rem;">' +
        'Strategy: <span class="tag ' + modeTag + '">' + context.mode + '</span> ' +
        '<span class="muted">(' + (context.label || context.mode) + ')</span> · ' +
        '<span class="muted">Range: ' + context.from + ' → ' + context.to + '</span>' +
      '</div>'
    : '';

  if (rows.length === 0) {
    el.innerHTML = headerLine + '<div class="muted">No sessions completed.</div>';
    return;
  }

  let totBPnl = 0, totSPnl = 0, totBTrd = 0, totSTrd = 0, okCount = 0, simBetter = 0, simWorse = 0;
  for (const r of rows) {
    if (!r.baseline || !r.baseline.ok || !r.sim || !r.sim.ok) continue;
    okCount++;
    totBPnl += (r.baseline.sessionPnl || 0);
    totSPnl += (r.sim.sessionPnl      || 0);
    totBTrd += (r.baseline.tradeCount || 0);
    totSTrd += (r.sim.tradeCount      || 0);
    const d = (r.sim.sessionPnl || 0) - (r.baseline.sessionPnl || 0);
    if (d >  0.005) simBetter++;
    else if (d < -0.005) simWorse++;
  }
  const dPnl = totSPnl - totBPnl;
  const dTrd = totSTrd - totBTrd;

  const colSnapshot =
    '<div class="cmp-col">' +
      '<div class="cmp-label">Snapshot (baseline)</div>' +
      '<div class="cmp-pnl ' + (totBPnl >= 0 ? 'positive' : 'negative') + '">' + (totBPnl >= 0 ? '+' : '') + '₹' + totBPnl.toFixed(2) + '</div>' +
      '<div class="cmp-meta">' +
        '<div class="cmp-meta-row"><span>Total trades</span><span>' + totBTrd + '</span></div>' +
        '<div class="cmp-meta-row"><span>Sessions</span><span>' + okCount + '</span></div>' +
      '</div>' +
    '</div>';
  const colSim =
    '<div class="cmp-col">' +
      '<div class="cmp-label">Your current settings</div>' +
      '<div class="cmp-pnl ' + (totSPnl >= 0 ? 'positive' : 'negative') + '">' + (totSPnl >= 0 ? '+' : '') + '₹' + totSPnl.toFixed(2) + '</div>' +
      '<div class="cmp-meta">' +
        '<div class="cmp-meta-row"><span>Total trades</span><span>' + totSTrd + '</span></div>' +
        '<div class="cmp-meta-row"><span>Sessions</span><span>' + okCount + '</span></div>' +
      '</div>' +
    '</div>';
  const colDelta =
    '<div class="cmp-col delta">' +
      '<div class="cmp-label">Aggregate delta</div>' +
      '<div class="cmp-pnl ' + (Math.abs(dPnl) < 0.005 ? 'neutral' : (dPnl > 0 ? 'positive' : 'negative')) + '">' +
        deltaArrow(dPnl) + ' ' + fmtRupee(dPnl) +
      '</div>' +
      '<div class="cmp-meta">' +
        '<div class="cmp-meta-row delta-row"><span>Trades</span>' +
          '<span class="' + deltaClass(dTrd) + '">' + deltaArrow(dTrd) + ' ' + (dTrd > 0 ? '+' : '') + dTrd + '</span></div>' +
        '<div class="cmp-meta-row delta-row"><span>Sessions improved</span><span class="cmp-delta-up">' + simBetter + '</span></div>' +
        '<div class="cmp-meta-row delta-row"><span>Sessions regressed</span><span class="cmp-delta-down">' + simWorse + '</span></div>' +
      '</div>' +
    '</div>';

  const verdict =
    okCount === 0 ? 'All runs failed — see per-session table below.' :
    Math.abs(dPnl) < 0.005 ? 'No net change — your settings produce the same aggregate P&L on these days.' :
    dPnl > 0 ? 'Across these ' + okCount + ' sessions, your current settings are <strong>better</strong> by ' + fmtRupee(dPnl) + ' (improved ' + simBetter + ', regressed ' + simWorse + ').' :
                'Across these ' + okCount + ' sessions, your current settings are <strong>worse</strong> by ' + fmtRupee(dPnl) + ' (improved ' + simBetter + ', regressed ' + simWorse + ').';

  let html = headerLine;
  html += '<div class="cmp-grid">' + colSnapshot + colSim + colDelta + '</div>';
  html += '<div class="muted" style="margin-top:10px;">' + verdict + '</div>';

  // Per-session breakdown
  html += '<table class="range-table"><thead><tr><th>Date</th><th>Strategy</th><th>Session ID</th><th class="num">Baseline P&L</th><th class="num">Trades</th><th class="num">Your P&L</th><th class="num">Trades</th><th class="num">Δ P&L</th><th class="num">Δ Trades</th></tr></thead><tbody>';
  for (const r of rows) {
    const bOk = r.baseline && r.baseline.ok;
    const sOk = r.sim && r.sim.ok;
    const bPnl = bOk ? (r.baseline.sessionPnl || 0) : null;
    const sPnl = sOk ? (r.sim.sessionPnl      || 0) : null;
    const bTrd = bOk ? (r.baseline.tradeCount || 0) : null;
    const sTrd = sOk ? (r.sim.tradeCount      || 0) : null;
    const dP = (bOk && sOk) ? (sPnl - bPnl) : null;
    const dT = (bOk && sOk) ? (sTrd - bTrd) : null;
    const rowTag = r.session.mode.startsWith('swing') ? 'swing' : r.session.mode.startsWith('scalp') ? 'scalp' : 'pa';
    html += '<tr>' +
      '<td>' + r.session.date + '</td>' +
      '<td><span class="tag ' + rowTag + '">' + r.session.mode + '</span></td>' +
      '<td><code style="font-size:0.7rem;color:#94a3b8;">' + r.session.sessionId + '</code></td>' +
      '<td class="num">' + (bOk ? (bPnl >= 0 ? '+' : '') + '₹' + bPnl.toFixed(2) : '<span style="color:#ef4444;">err</span>') + '</td>' +
      '<td class="num">' + (bOk ? bTrd : '–') + '</td>' +
      '<td class="num">' + (sOk ? (sPnl >= 0 ? '+' : '') + '₹' + sPnl.toFixed(2) : '<span style="color:#ef4444;">err</span>') + '</td>' +
      '<td class="num">' + (sOk ? sTrd : '–') + '</td>' +
      '<td class="num ' + (dP == null ? '' : deltaClass(dP)) + '">' + (dP == null ? '–' : fmtRupee(dP)) + '</td>' +
      '<td class="num ' + (dT == null ? '' : deltaClass(dT)) + '">' + (dT == null ? '–' : (dT > 0 ? '+' : '') + dT) + '</td>' +
      '</tr>';
  }
  html += '<tr class="totals">' +
    '<td colspan="3">Totals (' + okCount + ' sessions)</td>' +
    '<td class="num">' + (totBPnl >= 0 ? '+' : '') + '₹' + totBPnl.toFixed(2) + '</td>' +
    '<td class="num">' + totBTrd + '</td>' +
    '<td class="num">' + (totSPnl >= 0 ? '+' : '') + '₹' + totSPnl.toFixed(2) + '</td>' +
    '<td class="num">' + totSTrd + '</td>' +
    '<td class="num ' + deltaClass(dPnl) + '">' + fmtRupee(dPnl) + '</td>' +
    '<td class="num ' + deltaClass(dTrd) + '">' + (dTrd > 0 ? '+' : '') + dTrd + '</td>' +
  '</tr>';
  html += '</tbody></table>';

  el.innerHTML = html;
}

async function runRange(btn) {
  // Fresh authoritative check (not the cached 5s poll) right before launching.
  const pre = await freshPreflight();
  if (!pre.ok) {
    _preflightOk = false;
    refreshPreflight();
    showBlockAlert(pre.reason || 'A live or paper session is currently active.');
    return;
  }
  const from = document.getElementById('range-from').value;
  const to   = document.getElementById('range-to').value;
  const mode = document.getElementById('range-mode').value;
  const modeSelect = document.getElementById('range-mode');
  const modeLabel  = modeSelect.options[modeSelect.selectedIndex].text;
  if (!from || !to) { alert('Pick both From and To dates.'); return; }
  if (from > to)    { alert('From date must be on or before To date.'); return; }

  const useCurrentSettings = (getSelectedSettingsSource() === 'current');
  const context = { mode, label: modeLabel, from, to, useCurrentSettings };
  const sessions = pickSessionsInRange(from, to, mode);
  if (sessions.length === 0) {
    document.getElementById('range-result').innerHTML =
      '<div style="margin-bottom:10px;font-size:0.9rem;">Strategy: <span class="tag ' +
        (mode.startsWith('swing') ? 'swing' : mode.startsWith('scalp') ? 'scalp' : 'pa') +
        '">' + mode + '</span> <span class="muted">(' + modeLabel + ')</span></div>' +
      '<div class="muted">No recorded ' + mode + ' sessions found between ' + from + ' and ' + to + '.</div>';
    document.getElementById('range-progress').style.display = 'none';
    return;
  }

  // Cap to keep total wall-clock sane (each session ≈ 5-15s × 2 runs).
  const HARD_CAP = 30;
  if (sessions.length > HARD_CAP) {
    if (!confirm('That range has ' + sessions.length + ' sessions (~' + Math.round(sessions.length * 10 / 60) + ' min). Continue?')) return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  _myReplayRunning = true;
  refreshPreflight(); // flip banner to neutral "in progress" immediately
  const progress = document.getElementById('range-progress');
  const resultDiv = document.getElementById('range-result');
  progress.style.display = 'block';
  progress.className = 'range-progress';
  resultDiv.innerHTML = '';

  // Start live activity log streaming so the user can see strategy output
  // (and capture it via the Copy button after the run).
  await startLogPolling();

  const rows = [];
  const t0 = Date.now();
  let aborted = false;

  // Helper: detect the backend preflight rejection so we can abort the whole
  // batch (a paper/live session was started mid-run). The backend
  // replayPreflight() reason starts with "Cannot replay while".
  function isPreflightReject(resp) {
    return resp && resp.ok === false && typeof resp.error === 'string' &&
           /cannot replay while|already running/i.test(resp.error);
  }

  // Live-update the elapsed time every second so the user sees progress
  // even while a single API call is in flight (each baseline+sim pass can
  // take 15-60s for a full session that actually trades).
  let _stepLabel = '';
  const tickProgress = () => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    progress.innerHTML = _stepLabel + ' (' + elapsed + 's total elapsed)';
  };
  const progressTimer = setInterval(tickProgress, 1000);

  try {
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const idx = i + 1;
    let baseline = null, sim = null;

    // Snapshot mode: run ONCE per session (no baseline-vs-sim comparison
    // needed — baseline IS what we want). Simulator mode: run twice.
    if (!useCurrentSettings) {
      _stepLabel = '[' + idx + '/' + sessions.length + '] ' + s.date + ' · ' + s.sessionId + ' — replaying (snapshot settings)…';
      tickProgress();
      try {
        baseline = await callReplayApi(s.date, s.mode, s.sessionId, false);
      } catch (e) {
        baseline = { ok: false, error: e.message };
      }
      if (isPreflightReject(baseline)) { aborted = true; showBlockAlert(baseline.error); break; }
      // For snapshot mode, sim slot mirrors baseline so the result table
      // still renders cleanly (delta column will read as zero).
      sim = baseline;
    } else {
      _stepLabel = '[' + idx + '/' + sessions.length + '] ' + s.date + ' · ' + s.sessionId + ' — running baseline (snapshot)…';
      tickProgress();
      try {
        baseline = await callReplayApi(s.date, s.mode, s.sessionId, false);
      } catch (e) {
        baseline = { ok: false, error: e.message };
      }
      if (isPreflightReject(baseline)) { aborted = true; showBlockAlert(baseline.error); break; }

      _stepLabel = '[' + idx + '/' + sessions.length + '] ' + s.date + ' · ' + s.sessionId + ' — running your settings…';
      tickProgress();
      try {
        sim = await callReplayApi(s.date, s.mode, s.sessionId, true);
      } catch (e) {
        sim = { ok: false, error: e.message };
      }
      if (isPreflightReject(sim)) { aborted = true; showBlockAlert(sim.error); break; }
    }

    rows.push({ session: s, baseline, sim });
    // Live partial render after each session so the user sees results stream in.
    renderRangeResult(rows, context);
  }
  } finally {
    clearInterval(progressTimer);
    stopLogPolling();
  }

  // After the run, attach a "Copy diagnostic data" button so the user can
  // share the exact trades + activity log when something looks off.
  if (rows.length > 0) {
    const resultDivAgain = document.getElementById('range-result');
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = '📋 Copy diagnostic data';
    copyBtn.onclick = () => copyDiagnostic(copyBtn, context, rows);
    resultDivAgain.appendChild(copyBtn);
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  if (aborted) {
    progress.innerHTML = '⛔ Aborted at session ' + (rows.length + 1) + '/' + sessions.length + ' — a paper or live session was started during the run. ' + rows.length + ' sessions completed in ' + total + 's.';
  } else {
    progress.innerHTML = '✅ Done — ' + sessions.length + ' sessions in ' + total + 's.';
  }
  btn.disabled = false;
  btn.textContent = useCurrentSettings ? '▶ Run range (compare)' : '▶ Run range (snapshot)';
  _myReplayRunning = false;
  refreshPreflight(); // flip banner back to green/red authoritative state
  refreshSettingsSourceUi();
}

// Patch loadSessions to also cache sessions for the range picker + recompute
// the date-input min/max constraints from whatever's actually recorded.
const _origLoadSessions = loadSessions;
loadSessions = async function () {
  await _origLoadSessions();
  try {
    const r = await fetch('/replay/list');
    const data = await r.json();
    if (data && data.ok && Array.isArray(data.sessions)) {
      _allSessionsCache = data.sessions;
      setRangeDefaults();
    }
  } catch (_) {}
};

// Seed inputs with empty constraints first so the elements are usable
// before the fetch completes; will be re-set once /replay/list returns.
setRangeDefaults();
refreshPreflight();
refreshSettingsSourceUi();
loadSessions();
setInterval(refreshPreflight, 5000);

// React when the user toggles the Settings source radio
document.querySelectorAll('input[name="settings-source"]').forEach(r => {
  r.addEventListener('change', refreshSettingsSourceUi);
});
</script>
</body></html>`;
  res.send(html);
});

module.exports = router;

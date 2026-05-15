/**
 * REPLAY — /replay
 * ─────────────────────────────────────────────────────────────────────────────
 * Re-runs a previously recorded paper-trade session through the SAME paper
 * `onTick()` handlers, deterministically. Result is the canonical "backtest"
 * since BACKTEST = PAPER = LIVE by construction.
 *
 * Routes:
 *   GET  /replay                   → UI page (lists recordings, run button)
 *   GET  /replay/list              → JSON list of recorded sessions
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

router.post("/run", express.json(), async (req, res) => {
  const { date, mode, sessionId, speed } = req.body || {};
  if (!date || !mode) {
    return res.status(400).json({ ok: false, error: "date and mode are required" });
  }
  try {
    const result = await tickReplay.replaySession({
      date,
      mode,
      sessionId,
      speed: typeof speed === "number" ? speed : 0,
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
pre { background:#0a0f1c; padding:12px; border-radius:6px; overflow:auto; font-size:0.75rem; color:#cbd5e1; }
.empty { padding:32px; text-align:center; color:#64748b; }
</style>
</head>
<body>
${buildSidebar('replay', false)}
<div class="main">
  <h1>📼 Tick Replay — Deterministic Backtest</h1>
  <div class="sub">
    Re-runs a recorded paper-trade session through the same paper code. Same logic, same ticks, same result — to the rupee.
    Tick recording is enabled by default; sessions appear here automatically after each paper run.
  </div>

  <div class="card">
    <strong>Recorded sessions</strong>
    <div id="sessions-table" style="margin-top:12px;">Loading…</div>
  </div>

  <div class="card" id="result-card" style="display:none;">
    <strong>Replay result</strong>
    <div id="result-content"></div>
  </div>
</div>

<script>
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
      html += '<tr>' +
        '<td>' + s.date + '</td>' +
        '<td><span class="tag ' + tag + '">' + s.mode + '</span></td>' +
        '<td><code style="font-size:0.7rem;color:#94a3b8;">' + s.sessionId + '</code></td>' +
        '<td>' + dur + '</td>' +
        '<td>' + s.warmupCandles + ' candles</td>' +
        '<td><button onclick="runReplay(\\'' + s.date + '\\',\\'' + s.mode + '\\',\\'' + s.sessionId + '\\',this)">▶ Replay</button></td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    div.innerHTML = html;
  } catch (e) {
    div.innerHTML = '<div class="empty">Fetch failed: ' + e.message + '</div>';
  }
}

async function runReplay(date, mode, sessionId, btn) {
  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  const card = document.getElementById('result-card');
  const content = document.getElementById('result-content');
  card.style.display = 'block';
  content.innerHTML = '<div class="muted">Replaying ' + date + ' / ' + mode + ' / ' + sessionId + '…</div>';
  try {
    const r = await fetch('/replay/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, mode, sessionId, speed: 0 }),
    });
    const data = await r.json();
    btn.disabled = false;
    btn.textContent = '▶ Replay';
    if (!data.ok) {
      content.innerHTML = '<div style="color:#ef4444;">Error: ' + (data.error || 'unknown') + '</div>';
      return;
    }
    const pnlClass = (data.sessionPnl || 0) >= 0 ? 'positive' : 'negative';
    const pnlSign  = (data.sessionPnl || 0) >= 0 ? '+' : '';
    let html = '<div class="result-pnl ' + pnlClass + '">' + pnlSign + '₹' + (data.sessionPnl || 0).toFixed(2) + '</div>';
    html += '<div class="muted">' + data.tradeCount + ' trades · ' + data.ticksReplayed + ' ticks · ' + (data.durationMs / 1000).toFixed(2) + 's</div>';
    if (data.sessionTrades && data.sessionTrades.length) {
      html += '<details style="margin-top:12px;"><summary class="muted">Trade details</summary><pre>' + JSON.stringify(data.sessionTrades, null, 2) + '</pre></details>';
    }
    content.innerHTML = html;
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '▶ Replay';
    content.innerHTML = '<div style="color:#ef4444;">Run failed: ' + e.message + '</div>';
  }
}

loadSessions();
</script>
</body></html>`;
  res.send(html);
});

module.exports = router;

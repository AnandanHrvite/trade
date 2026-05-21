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
const path    = require("path");
const fs      = require("fs");
const { spawn } = require("child_process");

const { buildSidebar, sidebarCSS, faviconLink, modalJS } = require("../utils/sharedNav");
const tickReplay   = require("../services/tickReplay");
const tickRecorder = require("../utils/tickRecorder");

const TICKS_ROOT = tickRecorder._internals.ROOT_DIR;

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

// Stream the entire day's recording folder as a zip download. The day-folder
// contains spot/options/vix/sessions jsonl files shared by every session on
// that date. Uses the system `zip` binary (EC2 AL2 + macOS both ship it) and
// pipes to the response — never buffers the archive in memory.
router.get("/download-day", (req, res) => {
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: "date must be YYYY-MM-DD" });
  }
  const dir = path.join(TICKS_ROOT, date);
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ ok: false, error: `No recording for ${date}` });
  }
  const fname = `ticks-${date}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  // -r recurse, -q quiet, - output to stdout. Run with cwd=parent so paths in
  // the archive are date/spot.jsonl etc. (relative), not absolute.
  const zip = spawn("zip", ["-rq", "-", date], { cwd: TICKS_ROOT });
  zip.stdout.pipe(res);
  zip.stderr.on("data", (d) => console.warn(`[replay/download-day] zip stderr: ${d}`));
  zip.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
    else res.end();
  });
  zip.on("close", (code) => {
    if (code !== 0 && !res.writableEnded) res.end();
  });
});

router.post("/delete-session", express.json(), (req, res) => {
  const { date, sessionId } = req.body || {};
  try {
    const out = tickReplay.deleteSessionMarker({ date, sessionId });
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
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

// Strategy dropdown options — only show modes whose UI_SHOW_*_PAPER toggle
// is on AND that tickReplay's MODE_TO_MODULE actually supports. Order matches
// the sidebar so the dropdown feels familiar.
const STRATEGY_OPTIONS = [
  { mode: "pa-paper",       label: "PA Paper",       envKey: "UI_SHOW_PA_PAPER" },
  { mode: "scalp-paper",    label: "Scalp Paper",    envKey: "UI_SHOW_SCALP_PAPER" },
  { mode: "swing-paper",    label: "Swing Paper",    envKey: "UI_SHOW_SWING_PAPER" },
  { mode: "orb-paper",      label: "ORB Paper",      envKey: "UI_SHOW_ORB_PAPER" },
  { mode: "straddle-paper", label: "Straddle Paper", envKey: "UI_SHOW_STRADDLE_PAPER" },
];

function _renderStrategyOptions() {
  const enabled = STRATEGY_OPTIONS.filter(o =>
    (process.env[o.envKey] || "true").toLowerCase() === "true"
  );
  const list = enabled.length ? enabled : STRATEGY_OPTIONS; // never render empty
  return list.map(o => `<option value="${o.mode}">${o.label}</option>`).join("");
}

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
.tag.swing    { background:rgba(59,130,246,0.15);  color:#60a5fa; }
.tag.scalp    { background:rgba(245,158,11,0.15);  color:#fbbf24; }
.tag.pa       { background:rgba(168,85,247,0.15);  color:#c084fc; }
.tag.orb      { background:rgba(16,185,129,0.15);  color:#34d399; }
.tag.straddle { background:rgba(236,72,153,0.15);  color:#f472b6; }
.tag-incomplete { display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.65rem; font-weight:600; background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.35); margin-left:4px; }
.row-incomplete td { opacity:0.65; }
.row-incomplete td:last-child { opacity:1; } /* keep actions readable */
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
.sess-header { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
.sess-toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.sess-input { background:#0a0f1c; color:#e2e8f0; border:1px solid #1e293b; border-radius:6px; padding:6px 10px; font-size:0.8rem; min-width:120px; }
.sess-input:focus { outline:none; border-color:#3b82f6; }
.sess-pager { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; align-items:center; margin-top:10px; }
.pager-btn { background:#0f172a; color:#cbd5e1; border:1px solid #1e293b; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:0.8rem; min-width:32px; }
.pager-btn:hover:not(:disabled) { background:#1e293b; }
.pager-btn:disabled { opacity:0.4; cursor:not-allowed; }
.pager-btn.active { background:#3b82f6; color:#fff; border-color:#3b82f6; }
.row-actions { display:inline-flex; gap:4px; }
.row-btn { background:#0f172a; color:#cbd5e1; border:1px solid #1e293b; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:0.72rem; line-height:1; }
.row-btn:hover:not(:disabled) { background:#1e293b; color:#fff; }
.row-btn:disabled { opacity:0.4; cursor:not-allowed; }
.row-btn.danger:hover:not(:disabled) { background:#7f1d1d; color:#fff; border-color:#b91c1c; }
.row-btn.primary { background:#3b82f6; color:#fff; border-color:#3b82f6; }
.row-btn.primary:hover:not(:disabled) { background:#2563eb; }
.banner { padding:10px 14px; border-radius:6px; font-size:0.85rem; margin-bottom:16px; }
.banner.warn { background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.4); color:#fca5a5; }
.banner.ok   { background:rgba(16,185,129,0.10); border:1px solid rgba(16,185,129,0.35); color:#6ee7b7; }
.mode-toggle { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
.mode-toggle label { display:flex; gap:8px; align-items:flex-start; padding:10px 12px; border:1px solid #1e293b; border-radius:6px; cursor:pointer; flex:1; min-width:260px; background:#0f172a; transition: border-color 0.2s, background 0.2s; }
.mode-toggle label:hover { border-color:#334155; }
.mode-toggle input[type="radio"]:checked + .mt-body { color:#f1f5f9; }
/* Per-card selected accent — snapshot=blue, current=amber. The has() check
   keys off the actual radio value so the colour matches the option even
   before refreshSettingsSourceUi() runs. */
.mode-toggle label:has(input[value="snapshot"]:checked) { border-color:#3b82f6; background:#172033; box-shadow:0 0 0 1px rgba(59,130,246,0.25); }
.mode-toggle label:has(input[value="current"]:checked)  { border-color:#f59e0b; background:#1f1a0e; box-shadow:0 0 0 1px rgba(245,158,11,0.30); }
.mt-title { font-weight:600; font-size:0.85rem; color:#e2e8f0; }
.mt-desc  { color:#94a3b8; font-size:0.75rem; margin-top:2px; line-height:1.4; }

/* Settings-source-driven theming. The body data-source attribute is set in
   refreshSettingsSourceUi() based on which radio is checked. Snapshot uses
   blue (safe/deterministic); current uses amber (experimental/simulator). */
body[data-source="snapshot"] #range-run-btn { background:#3b82f6; }
body[data-source="snapshot"] #range-run-btn:hover:not(:disabled) { background:#2563eb; }
body[data-source="snapshot"] .source-chip { background:rgba(59,130,246,0.15); color:#93c5fd; border:1px solid rgba(59,130,246,0.40); }

body[data-source="current"] #range-run-btn { background:#f59e0b; color:#1a1208; }
body[data-source="current"] #range-run-btn:hover:not(:disabled) { background:#d97706; color:#fff; }
body[data-source="current"] .source-chip { background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.40); }
/* Subtle amber accent on the range card when in simulator mode, so the
   "this will replay against current settings" intent is visible at a glance
   even before scrolling up to the radio. */
body[data-source="current"] #range-card { border-color:rgba(245,158,11,0.30); box-shadow:0 0 0 1px rgba(245,158,11,0.10); }

.source-chip { display:inline-block; padding:2px 10px; border-radius:999px; font-size:0.7rem; font-weight:600; letter-spacing:0.03em; margin-left:8px; vertical-align:middle; }

/* ── Light-theme overrides (kick in when modalJS sets data-theme="light") ─ */
:root[data-theme="light"] .sub { color:#64748b !important; }
:root[data-theme="light"] .muted { color:#94a3b8 !important; }
:root[data-theme="light"] .card { background:#ffffff !important; border-color:#e2e8f0 !important; }
:root[data-theme="light"] th, :root[data-theme="light"] td { border-bottom-color:#e2e8f0 !important; }
:root[data-theme="light"] th { color:#64748b !important; }
:root[data-theme="light"] tbody tr:hover { background:#f8fafc !important; }
:root[data-theme="light"] pre { background:#f8fafc !important; color:#334155 !important; border:1px solid #e2e8f0; }
:root[data-theme="light"] .cmp-col { background:#f8fafc !important; border-color:#e2e8f0 !important; }
:root[data-theme="light"] .cmp-col.delta { border-color:#cbd5e1 !important; }
:root[data-theme="light"] .cmp-label { color:#64748b !important; }
:root[data-theme="light"] .cmp-meta { color:#64748b !important; }
:root[data-theme="light"] .cmp-meta-row.delta-row { color:#475569 !important; }
:root[data-theme="light"] .cmp-pnl.neutral { color:#94a3b8 !important; }
:root[data-theme="light"] .cmp-delta-zero { color:#94a3b8 !important; }
:root[data-theme="light"] .range-field label { color:#64748b !important; }
:root[data-theme="light"] .range-field input,
:root[data-theme="light"] .range-field select { background:#ffffff !important; color:#1e293b !important; border-color:#cbd5e1 !important; }
:root[data-theme="light"] .range-progress { background:#f8fafc !important; border-color:#e2e8f0 !important; color:#475569 !important; }
:root[data-theme="light"] .range-table th { color:#64748b !important; }
:root[data-theme="light"] .range-table th, :root[data-theme="light"] .range-table td { border-bottom-color:#e2e8f0 !important; }
:root[data-theme="light"] .range-table tr.totals { background:#f1f5f9 !important; color:#1e293b; }
:root[data-theme="light"] .range-table tr.totals td { border-top-color:#cbd5e1 !important; }
:root[data-theme="light"] .activity-log { background:#0f172a !important; border-color:#1e293b !important; color:#cbd5e1 !important; }
:root[data-theme="light"] .activity-log-empty { color:#64748b !important; }
:root[data-theme="light"] .empty { color:#94a3b8 !important; }
:root[data-theme="light"] .copy-btn { background:#ecfdf5 !important; color:#047857 !important; border-color:#10b981 !important; }
:root[data-theme="light"] .copy-btn:hover { background:#a7f3d0 !important; }
:root[data-theme="light"] .copy-btn.copied { background:#bbf7d0 !important; color:#065f46 !important; border-color:#10b981 !important; }
:root[data-theme="light"] .mode-toggle label { background:#f8fafc !important; border-color:#cbd5e1 !important; }
:root[data-theme="light"] .mode-toggle label:hover { border-color:#94a3b8 !important; }
:root[data-theme="light"] .mode-toggle label:has(input[value="snapshot"]:checked) { background:#eff6ff !important; border-color:#3b82f6 !important; }
:root[data-theme="light"] .mode-toggle label:has(input[value="current"]:checked)  { background:#fffbeb !important; border-color:#f59e0b !important; }
:root[data-theme="light"] .mt-title { color:#1e293b !important; }
:root[data-theme="light"] .mt-desc  { color:#64748b !important; }
:root[data-theme="light"] body[data-source="current"] #range-run-btn { color:#1f1300 !important; }
:root[data-theme="light"] .sess-input { background:#ffffff !important; color:#1e293b !important; border-color:#cbd5e1 !important; }
:root[data-theme="light"] .pager-btn { background:#f8fafc !important; color:#334155 !important; border-color:#cbd5e1 !important; }
:root[data-theme="light"] .pager-btn:hover:not(:disabled) { background:#e2e8f0 !important; }
:root[data-theme="light"] .row-btn { background:#f8fafc !important; color:#334155 !important; border-color:#cbd5e1 !important; }
:root[data-theme="light"] .row-btn:hover:not(:disabled) { background:#e2e8f0 !important; color:#0f172a !important; }
:root[data-theme="light"] .row-btn.danger:hover:not(:disabled) { background:#dc2626 !important; color:#fff !important; border-color:#b91c1c !important; }
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

  <div class="card" id="range-card">
    <strong>Date-range <span id="range-mode-label">replay</span></strong><span id="source-chip" class="source-chip">SNAPSHOT</span>
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
          ${_renderStrategyOptions()}
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

  <div class="card" id="sessions-card">
    <div class="sess-header">
      <strong>Recorded sessions</strong>
      <div class="sess-toolbar">
        <select id="sess-filter-mode" class="sess-input" title="Filter by strategy">
          <option value="">All strategies</option>
        </select>
        <input id="sess-filter-search" type="search" class="sess-input" placeholder="Search ID or date…" title="Search session ID or date (YYYY-MM-DD)">
        <select id="sess-per-page" class="sess-input" title="Rows per page">
          <option value="10">10 / page</option>
          <option value="25" selected>25 / page</option>
          <option value="50">50 / page</option>
          <option value="100">100 / page</option>
        </select>
      </div>
    </div>
    <div id="sessions-meta" class="muted" style="margin-top:8px;"></div>
    <div id="sessions-table" style="margin-top:10px;">Loading…</div>
    <div id="sessions-pager" class="sess-pager"></div>
  </div>

  <div class="card" id="result-card" style="display:none;">
    <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
      <strong>Single-session replay result</strong>
      <span id="result-source-chip" class="source-chip"></span>
    </div>
    <div id="result-progress" class="range-progress" style="margin-top:8px; display:none;"></div>
    <div id="result-content" style="margin-top:12px;"></div>
  </div>
</div>

<script>
let _preflightOk = true;
let _myReplayRunning = false; // true while THIS tab is actively running a replay

// Mode → CSS tag-class (drives the coloured pill in lists/tables).
function modeTag(mode) {
  if (!mode) return 'pa';
  if (mode.startsWith('swing'))    return 'swing';
  if (mode.startsWith('scalp'))    return 'scalp';
  if (mode.startsWith('orb'))      return 'orb';
  if (mode.startsWith('straddle')) return 'straddle';
  return 'pa';
}

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

// Filter + pagination state for the Recorded sessions table.
let _sessFilter = { mode: '', search: '', page: 1, perPage: 25 };

function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// JSON-encode a value as a JS literal, then HTML-encode the surrounding
// quotes so it's safe to drop straight into a double-quoted HTML attribute
// like onclick="fn(...)". E.g. "abc" → &quot;abc&quot; → fn("abc").
function _jsAttr(v) { return _escapeHtml(JSON.stringify(v)); }

function _filteredSessions() {
  const q = (_sessFilter.search || '').trim().toLowerCase();
  return (_allSessionsCache || [])
    .filter(s => !_sessFilter.mode || s.mode === _sessFilter.mode)
    .filter(s => !q || (s.sessionId || '').toLowerCase().includes(q) || (s.date || '').includes(q))
    .sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
}

function renderSessions() {
  const tableDiv = document.getElementById('sessions-table');
  const metaDiv  = document.getElementById('sessions-meta');
  const pagerDiv = document.getElementById('sessions-pager');
  if (!tableDiv) return;

  const rows = _filteredSessions();
  const total = rows.length;
  const perPage = _sessFilter.perPage;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  if (_sessFilter.page > pageCount) _sessFilter.page = pageCount;
  const start = (_sessFilter.page - 1) * perPage;
  const pageRows = rows.slice(start, start + perPage);

  if (total === 0) {
    tableDiv.innerHTML = '<div class="empty">' +
      ((_allSessionsCache || []).length === 0
        ? 'No recordings yet. Run a paper session — it auto-records and will appear here.'
        : 'No sessions match the current filter.') +
      '</div>';
    metaDiv.textContent = '';
    pagerDiv.innerHTML = '';
    return;
  }

  metaDiv.textContent = 'Showing ' + (start + 1) + '–' + Math.min(start + perPage, total) +
                        ' of ' + total + (total === (_allSessionsCache || []).length ? '' : ' (filtered)');

  let html = '<table><thead><tr><th>Date</th><th>Mode</th><th>Session ID</th><th>Duration</th><th>Warmup</th><th>Actions</th></tr></thead><tbody>';
  for (const s of pageRows) {
    const tag = modeTag(s.mode);
    const dur = s.durationMs != null ? Math.floor(s.durationMs / 60000) + ' min' : '—';
    const sid = _escapeHtml(s.sessionId);
    const sidJs  = _jsAttr(s.sessionId);
    const dateJs = _jsAttr(s.date);
    const modeJs = _jsAttr(s.mode);
    // Replayable: PA/Scalp/Swing always; ORB/Straddle only after the option-LTP
    // recording fix (session-start meta has recordsOptionLtps:true). Pre-fix
    // sessions get a yellow "incomplete" chip + disabled Replay button.
    const isReplayable = s.replayable !== false;
    const replayDisabled = (!_preflightOk || !isReplayable) ? 'disabled' : '';
    const srcSuffix = (getSelectedSettingsSource() === 'current') ? ' (current)' : ' (snapshot)';
    const replayTitle = !isReplayable
      ? 'This session predates option-LTP recording for ' + s.mode + ' — replay would produce 0 trades. Use the 🗑 button to remove the marker; spot/options/vix files on disk are untouched.'
      : (getSelectedSettingsSource() === 'current'
          ? 'Replay with your current Settings page values (simulator). Toggle the Settings source above to switch.'
          : 'Replay with the exact settings recorded with this session. Toggle the Settings source above to switch.');
    const modeCell = isReplayable
      ? '<span class="tag ' + tag + '">' + _escapeHtml(s.mode) + '</span>'
      : '<span class="tag ' + tag + '">' + _escapeHtml(s.mode) + '</span>' +
        ' <span class="tag-incomplete" title="No option LTPs were recorded for this session — replay cannot reproduce trades">⚠ incomplete</span>';
    html += '<tr' + (isReplayable ? '' : ' class="row-incomplete"') + '>' +
      '<td>' + _escapeHtml(s.date) + '</td>' +
      '<td>' + modeCell + '</td>' +
      '<td><code style="font-size:0.7rem;color:#94a3b8;">' + sid + '</code></td>' +
      '<td>' + dur + '</td>' +
      '<td>' + s.warmupCandles + ' candles</td>' +
      '<td><div class="row-actions">' +
        '<button class="row-btn primary replay-btn" ' + replayDisabled +
          ' onclick="runReplay(' + dateJs + ',' + modeJs + ',' + sidJs + ',this)" title="' + _escapeHtml(replayTitle) + '">▶ Replay' + srcSuffix + '</button>' +
        '<button class="row-btn" onclick="copySessionId(' + sidJs + ',this)" title="Copy session ID">📋</button>' +
        '<button class="row-btn" onclick="downloadDay(' + dateJs + ')" title="Download whole day\\'s tick folder (zip)">⬇</button>' +
        '<button class="row-btn danger" onclick="deleteSession(' + dateJs + ',' + sidJs + ',this)" title="Remove session marker (raw ticks stay on disk)">🗑</button>' +
      '</div></td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  tableDiv.innerHTML = html;

  // Pager — compact: « ‹ 1 2 3 … N › »
  pagerDiv.innerHTML = _renderPager(_sessFilter.page, pageCount);
}

function _renderPager(page, pageCount) {
  if (pageCount <= 1) return '';
  const out = [];
  const btn = (label, target, opts) => {
    const dis = opts && opts.disabled ? 'disabled' : '';
    const cls = 'pager-btn' + (opts && opts.active ? ' active' : '');
    const title = opts && opts.title ? ' title="' + opts.title + '"' : '';
    return '<button class="' + cls + '" ' + dis + title +
           ' onclick="gotoSessionsPage(' + target + ')">' + label + '</button>';
  };
  out.push(btn('«', 1, { disabled: page === 1, title: 'First' }));
  out.push(btn('‹', page - 1, { disabled: page === 1, title: 'Previous' }));

  // Show up to 5 numeric buttons centred on current page
  const window = 2;
  let from = Math.max(1, page - window);
  let to   = Math.min(pageCount, page + window);
  if (page <= window) to   = Math.min(pageCount, 1 + window * 2);
  if (page + window >= pageCount) from = Math.max(1, pageCount - window * 2);
  if (from > 1) {
    out.push(btn('1', 1, { active: false }));
    if (from > 2) out.push('<span class="muted" style="padding:0 4px;">…</span>');
  }
  for (let i = from; i <= to; i++) out.push(btn(String(i), i, { active: i === page }));
  if (to < pageCount) {
    if (to < pageCount - 1) out.push('<span class="muted" style="padding:0 4px;">…</span>');
    out.push(btn(String(pageCount), pageCount, { active: false }));
  }
  out.push(btn('›', page + 1, { disabled: page === pageCount, title: 'Next' }));
  out.push(btn('»', pageCount, { disabled: page === pageCount, title: 'Last' }));
  return out.join('');
}

function gotoSessionsPage(p) {
  _sessFilter.page = Math.max(1, p);
  renderSessions();
}

function _populateModeFilter() {
  const sel = document.getElementById('sess-filter-mode');
  if (!sel) return;
  const modes = Array.from(new Set((_allSessionsCache || []).map(s => s.mode))).sort();
  const prev = sel.value;
  sel.innerHTML = '<option value="">All strategies</option>' +
    modes.map(m => '<option value="' + _escapeHtml(m) + '">' + _escapeHtml(m) + '</option>').join('');
  // Preserve user's prior selection if still applicable
  if (prev && modes.includes(prev)) sel.value = prev;
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
    _allSessionsCache = Array.isArray(data.sessions) ? data.sessions : [];
    setRangeDefaults();
    _populateModeFilter();
    renderSessions();
  } catch (e) {
    div.innerHTML = '<div class="empty">Fetch failed: ' + e.message + '</div>';
  }
}

// ── Row action handlers ───────────────────────────────────────────────────
async function copySessionId(sid, btn) {
  const origLabel = btn.textContent;
  try {
    await navigator.clipboard.writeText(sid);
    btn.textContent = '✓';
  } catch (_) {
    // Fallback for non-HTTPS contexts (this app runs on http://13.204…)
    const ta = document.createElement('textarea');
    ta.value = sid;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); btn.textContent = '✓'; }
    catch (_) { btn.textContent = '✗'; }
    setTimeout(() => { try { document.body.removeChild(ta); } catch (_) {} }, 100);
  }
  setTimeout(() => { btn.textContent = origLabel; }, 1500);
}

function downloadDay(date) {
  // Direct nav so the browser handles the streamed zip as a normal download.
  window.location.href = '/replay/download-day?date=' + encodeURIComponent(date);
}

async function deleteSession(date, sessionId, btn) {
  if (!confirm('Remove this session from the list?\\n\\n' +
               'Date: ' + date + '\\nSession: ' + sessionId + '\\n\\n' +
               'Only the session marker is dropped — raw tick files on disk are NOT touched.')) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await fetch('/replay/delete-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, sessionId }),
    });
    const data = await r.json();
    if (!data.ok) {
      btn.disabled = false; btn.textContent = orig;
      alert('Delete failed: ' + (data.error || 'unknown'));
      return;
    }
    _allSessionsCache = (_allSessionsCache || []).filter(s => s.sessionId !== sessionId);
    _populateModeFilter();
    renderSessions();
  } catch (e) {
    btn.disabled = false; btn.textContent = orig;
    alert('Delete failed: ' + e.message);
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
  const chip      = document.getElementById('source-chip');
  // Body-level attribute drives all the colour theming via CSS — set it
  // first so the rest of the DOM mutations land in the new colour scheme.
  document.body.setAttribute('data-source', isCurrent ? 'current' : 'snapshot');
  if (chip) chip.textContent = isCurrent ? 'SIMULATOR · CURRENT SETTINGS' : 'SNAPSHOT · DETERMINISTIC';
  if (modeLabel) modeLabel.textContent = isCurrent ? 'comparison' : 'replay';
  if (desc) {
    desc.innerHTML = isCurrent
      ? 'Replay every recorded session <strong>twice</strong> (snapshot baseline + your current settings), showing the delta. Useful for testing config changes against real ticks.'
      : 'Replay every recorded session <strong>once</strong> using the exact settings each session was recorded with. Deterministic — same result every time. Useful for verifying paper P&L or code-change impact.';
  }
  if (runBtn && !runBtn.disabled) {
    runBtn.textContent = isCurrent ? '▶ Run range (compare)' : '▶ Run range (snapshot)';
  }
  // Also refresh single-row Replay buttons so their label + tooltip reflect
  // which mode they will run in. The label suffix mirrors the run-btn text.
  const rowSuffix = isCurrent ? ' (current)' : ' (snapshot)';
  const rowTitle  = isCurrent
    ? 'Replay with your current Settings page values (simulator). Toggle the Settings source above to switch.'
    : 'Replay with the exact settings recorded with this session. Toggle the Settings source above to switch.';
  document.querySelectorAll('button.replay-btn').forEach(b => {
    if (b.disabled) return;
    // Don't trample mid-run state — runReplay() sets textContent to '⏳'.
    if (b.textContent === '⏳') return;
    b.textContent = '▶ Replay' + rowSuffix;
    b.title       = rowTitle;
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

function _modeLabel(mode) {
  return mode === 'swing-paper'    ? 'Swing Paper'
       : mode === 'scalp-paper'    ? 'Scalp Paper'
       : mode === 'pa-paper'       ? 'PA Paper'
       : mode === 'orb-paper'      ? 'ORB Paper'
       : mode === 'straddle-paper' ? 'Straddle Paper'
       : mode;
}

// Per-row Replay button. Drives a dedicated result card directly below the
// Recorded sessions table so the user sees the output landing right where
// they clicked, instead of buried under the date-range result panel.
async function runReplay(date, mode, sessionId, btn) {
  const pre = await freshPreflight();
  if (!pre.ok) {
    _preflightOk = false;
    refreshPreflight();
    showBlockAlert(pre.reason || 'A live or paper session is currently active.');
    return;
  }

  const useCurrentSettings = (getSelectedSettingsSource() === 'current');
  const modeLabel = _modeLabel(mode);
  const card      = document.getElementById('result-card');
  const content   = document.getElementById('result-content');
  const progress  = document.getElementById('result-progress');
  const chip      = document.getElementById('result-source-chip');

  // Surface the card + show what settings source this run uses.
  card.style.display = 'block';
  chip.textContent = useCurrentSettings ? 'SIMULATOR · CURRENT SETTINGS' : 'SNAPSHOT · DETERMINISTIC';
  progress.style.display = 'block';
  content.innerHTML = '';

  // Header so the user immediately knows which row they fired.
  const headerHtml =
    '<div style="margin-bottom:10px;font-size:0.9rem;">' +
      'Strategy: <span class="tag ' + modeTag(mode) + '">' + _escapeHtml(mode) + '</span> ' +
      '<span class="muted">(' + _escapeHtml(modeLabel) + ')</span> · ' +
      '<span class="muted">' + _escapeHtml(date) + ' · ' + _escapeHtml(sessionId) + '</span>' +
    '</div>';

  const origBtnLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳';
  _myReplayRunning = true;
  refreshPreflight();
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const t0 = Date.now();
  let _stepLabel = useCurrentSettings ? 'Running baseline (snapshot)…' : 'Replaying (snapshot settings)…';
  const tick = () => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    progress.innerHTML = _stepLabel + ' (' + elapsed + 's)';
  };
  tick();
  const progressTimer = setInterval(tick, 1000);

  let baseline = null, sim = null;
  try {
    try { baseline = await callReplayApi(date, mode, sessionId, false); }
    catch (e) { baseline = { ok: false, error: e.message }; }

    if (useCurrentSettings) {
      _stepLabel = 'Running with your current settings…';
      tick();
      try { sim = await callReplayApi(date, mode, sessionId, true); }
      catch (e) { sim = { ok: false, error: e.message }; }
    } else {
      sim = baseline; // single-pass snapshot mode
    }
  } finally {
    clearInterval(progressTimer);
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  progress.innerHTML = '✅ Done in ' + totalSec + 's.';

  // Render header + body. renderSingleResult / renderComparison both overwrite
  // their target's innerHTML, so we give them a dedicated child div and own
  // the header separately to avoid fighting them over the DOM.
  content.innerHTML = headerHtml;
  const body = document.createElement('div');
  content.appendChild(body);
  if (useCurrentSettings) {
    if (!baseline.ok && !sim.ok) {
      body.innerHTML = '<div class="muted">⚠️ Both runs failed.</div>';
    } else {
      renderComparison(body, baseline, sim, '');
    }
  } else {
    if (!baseline.ok) {
      body.innerHTML = '<div class="muted">⚠️ Replay failed: ' + _escapeHtml(baseline.error || 'unknown') + '</div>';
    } else {
      renderSingleResult(body, baseline, modeLabel);
    }
  }

  // Copy / Download diagnostic buttons (same shape as the date-range path)
  if (baseline && (baseline.ok || (sim && sim.ok))) {
    const session = (_allSessionsCache || []).find(s => s.sessionId === sessionId) || { date, mode, sessionId };
    const rows    = [{ session, baseline, sim }];
    const ctx     = { mode, label: modeLabel, from: date, to: date, useCurrentSettings };
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = '📋 Copy diagnostic data';
    copyBtn.onclick = () => copyDiagnostic(copyBtn, ctx, rows);
    const dlBtn = document.createElement('button');
    dlBtn.className = 'copy-btn';
    dlBtn.textContent = '⬇ Download diagnostic';
    dlBtn.onclick = () => downloadDiagnostic(dlBtn, ctx, rows);
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(dlBtn);
    content.appendChild(btnRow);
  }

  btn.disabled = false;
  btn.textContent = origBtnLabel;
  _myReplayRunning = false;
  refreshPreflight();
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

  return lines.join('\\n');
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

function downloadDiagnostic(btn, context, rows) {
  const blob = buildDiagnosticBlob(context, rows);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = 'replay-diagnostic-' + (context.mode || 'session') + '-' + (context.from || '') + '_' + (context.to || '') + '_' + ts + '.txt';
  const url = URL.createObjectURL(new Blob([blob], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (_) {} }, 200);
  const orig = btn.textContent;
  btn.textContent = '✓ Downloaded';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2500);
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
  // We DON'T require durationMs != null. A session that crash-recovered or
  // was killed mid-flight has no stop record but still has a full spot/option
  // tick stream — replay synthesises an end-of-window stop and processes
  // every recorded tick. Excluding these meant 18-may swing was unreachable
  // even though all its ticks were on disk.
  return _allSessionsCache
    .filter(s => s.mode === mode && s.date >= from && s.date <= to)
    .sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
}

function renderRangeResult(rows, context) {
  // rows: [{ session, baseline, sim }]
  // context: { mode, label, from, to } — describes what was run
  const el = document.getElementById('range-result');

  const modeTag = context && context.mode
    ? modeTag(context.mode)
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
    const rowTag = modeTag(r.session.mode);
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
        modeTag(mode) +
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

  await runSessionsBatch(sessions, context, btn, useCurrentSettings ? '▶ Run range (compare)' : '▶ Run range (snapshot)');
}

// Shared orchestration: runs N sessions through the replay engine, streams
// activity log, renders the result table, and attaches Copy/Download
// diagnostic buttons. Used by both the date-range button AND each per-session
// Replay button in the Recorded sessions table.
async function runSessionsBatch(sessions, context, btn, btnRestoreText) {
  const useCurrentSettings = !!context.useCurrentSettings;
  btn.disabled = true;
  const _origBtnText = btn.textContent;
  btn.textContent = '⏳ Running…';
  _myReplayRunning = true;
  refreshPreflight(); // flip banner to neutral "in progress" immediately
  const progress = document.getElementById('range-progress');
  const resultDiv = document.getElementById('range-result');
  progress.style.display = 'block';
  progress.className = 'range-progress';
  resultDiv.innerHTML = '';
  // Scroll the range card into view so the per-row button user sees the
  // activity log + result rendering, not just a frozen button at the bottom.
  document.getElementById('range-card').scrollIntoView({ behavior: 'smooth', block: 'start' });

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

  // After the run, attach Copy + Download buttons so the user can share
  // the exact trades + activity log when something looks off. Download is
  // useful when the diagnostic is too big to paste (long activity logs,
  // multi-day ranges with option-tick windows).
  if (rows.length > 0) {
    const resultDivAgain = document.getElementById('range-result');
    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.flexWrap = 'wrap';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = '📋 Copy diagnostic data';
    copyBtn.onclick = () => copyDiagnostic(copyBtn, context, rows);
    const dlBtn = document.createElement('button');
    dlBtn.className = 'copy-btn';
    dlBtn.textContent = '⬇ Download diagnostic';
    dlBtn.onclick = () => downloadDiagnostic(dlBtn, context, rows);
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(dlBtn);
    resultDivAgain.appendChild(btnRow);
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  if (aborted) {
    progress.innerHTML = '⛔ Aborted at session ' + (rows.length + 1) + '/' + sessions.length + ' — a paper or live session was started during the run. ' + rows.length + ' sessions completed in ' + total + 's.';
  } else {
    progress.innerHTML = '✅ Done — ' + sessions.length + ' sessions in ' + total + 's.';
  }
  btn.disabled = false;
  btn.textContent = btnRestoreText || _origBtnText;
  _myReplayRunning = false;
  refreshPreflight(); // flip banner back to green/red authoritative state
  refreshSettingsSourceUi();
}

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

// Wire Recorded-sessions toolbar inputs to filter + re-render in place.
(function wireSessionsToolbar() {
  const modeSel  = document.getElementById('sess-filter-mode');
  const search   = document.getElementById('sess-filter-search');
  const perPage  = document.getElementById('sess-per-page');
  if (modeSel) modeSel.addEventListener('change', () => {
    _sessFilter.mode = modeSel.value; _sessFilter.page = 1; renderSessions();
  });
  if (search) {
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        _sessFilter.search = search.value; _sessFilter.page = 1; renderSessions();
      }, 150);
    });
  }
  if (perPage) perPage.addEventListener('change', () => {
    _sessFilter.perPage = parseInt(perPage.value, 10) || 25;
    _sessFilter.page = 1;
    renderSessions();
  });
})();
</script>
<script>${modalJS()}</script>
</body></html>`;
  res.send(html);
});

module.exports = router;

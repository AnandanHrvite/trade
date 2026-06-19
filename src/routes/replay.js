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
 *                                  The option expiry is the exception: it's
 *                                  auto-pinned to the recorded day (the recorded
 *                                  ticks only cover that day's contract), so an
 *                                  old day uses its own expiry, not today's.
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
const {
  attachContractNotes, brokerForMode,
  contractNoteModalHTML, contractNoteClientJS,
} = require("../utils/contractNote");
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

// Cancel the in-flight replay mid-session. The streaming loop checks the flag
// each tick, stops early, and squares off via /stop so nothing is left stuck.
router.post("/cancel", (req, res) => {
  try {
    res.json(tickReplay.requestCancel());
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

// Stream every recorded day's tick folder as one zip. The per-row ⬇ grabs a
// single day; this is the "download all" bulk version for offline analysis.
// Same streaming approach — never buffers the archive in memory.
router.get("/download-all", (req, res) => {
  if (!fs.existsSync(TICKS_ROOT)) {
    return res.status(404).json({ ok: false, error: "No recordings on disk yet" });
  }
  const days = fs.readdirSync(TICKS_ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (days.length === 0) {
    return res.status(404).json({ ok: false, error: "No recorded days to download" });
  }
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="ticks-all.zip"`);
  // Pass each date dir explicitly so paths in the archive stay relative
  // (date/spot.jsonl etc.), not absolute. cwd=TICKS_ROOT.
  const zip = spawn("zip", ["-rq", "-", ...days], { cwd: TICKS_ROOT });
  zip.stdout.pipe(res);
  zip.stderr.on("data", (d) => console.warn(`[replay/download-all] zip stderr: ${d}`));
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
  const { date, mode, sessionId, speed, useCurrentSettings, noCache } = req.body || {};
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
      noCache: !!noCache,  // force fresh recompute + cache overwrite when true
    });
    // Attach a contract-note row (_cn) to each trade so the Replay page's
    // Report modal can build a contract note client-side, identical to the
    // History pages. Broker schedule is derived from the replayed strategy.
    const cnBroker = brokerForMode(mode);
    if (result && Array.isArray(result.sessionTrades)) {
      result.sessionTrades = attachContractNotes(result.sessionTrades, cnBroker);
    }
    if (result && result.canonical && Array.isArray(result.canonical.trades)) {
      result.canonical.trades = attachContractNotes(result.canonical.trades, cnBroker);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Strategy dropdown options — only show modes whose UI_SHOW_*_PAPER toggle
// is on AND that tickReplay's MODE_TO_MODULE actually supports. Order matches
// the sidebar so the dropdown feels familiar.
const STRATEGY_OPTIONS = [
  { mode: "pa-paper",       label: "PA Paper",       envKey: "UI_SHOW_PA_PAPER",       modeKey: "PA_MODE_ENABLED" },
  { mode: "scalp-paper",    label: "Scalp Paper",    envKey: "UI_SHOW_SCALP_PAPER",    modeKey: "SCALP_MODE_ENABLED" },
  { mode: "swing-paper",    label: "Swing Paper",    envKey: "UI_SHOW_SWING_PAPER",    modeKey: "SWING_MODE_ENABLED" },
  { mode: "orb-paper",      label: "ORB Paper",      envKey: "UI_SHOW_ORB_PAPER",      modeKey: "ORB_MODE_ENABLED" },
  { mode: "straddle-paper", label: "Straddle Paper", envKey: "UI_SHOW_STRADDLE_PAPER", modeKey: "STRADDLE_MODE_ENABLED" },
];

function _renderStrategyOptions() {
  const on = (k) => (process.env[k] || "true").toLowerCase() === "true";
  // Gate on the same *_MODE_ENABLED Settings toggle the sidebar uses, AND the
  // replay-specific UI_SHOW_* toggle, so disabled strategies drop out here too.
  const enabled = STRATEGY_OPTIONS.filter(o => on(o.modeKey) && on(o.envKey));
  const list = enabled.length ? enabled : STRATEGY_OPTIONS; // never render empty
  const opts = list.map(o => `<option value="${o.mode}">${o.label}</option>`);
  // "All strategies" runs every enabled paper mode in one batch (only worth
  // offering when there are 2+ to combine). Default-selected so the page opens
  // ready to replay the whole range across strategies in one shot.
  if (list.length > 1) {
    opts.unshift(`<option value="all" selected>⚡ All strategies</option>`);
  }
  return opts.join("");
}

router.get("/", (req, res) => {
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
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
.rp-block { margin-top:10px; background:#020617; border:1px solid #1e293b; border-radius:6px; padding:14px 16px; }
.rp-row { display:flex; align-items:center; gap:10px; font-size:0.9rem; color:#e2e8f0; }
.rp-spinner { width:14px; height:14px; border:2px solid #1e293b; border-top-color:#38bdf8; border-radius:50%; animation: rp-spin 0.8s linear infinite; flex:0 0 auto; }
.rp-current { font-weight:600; }
.rp-counter { margin-left:auto; color:#94a3b8; font-variant-numeric: tabular-nums; font-size:0.82rem; }
.rp-bar { margin-top:10px; height:6px; background:#0f172a; border-radius:3px; overflow:hidden; }
.rp-bar-fill { height:100%; background:linear-gradient(90deg, #38bdf8, #6366f1); transition: width 0.4s ease; }
.rp-elapsed { margin-top:6px; font-size:0.72rem; color:#64748b; }
.rp-done .rp-spinner { animation:none; border-top-color:#22c55e; border-color:#22c55e; }
.rp-cancelled .rp-spinner { animation:none; border-top-color:#ef4444; border-color:#ef4444; }
@keyframes rp-spin { to { transform: rotate(360deg); } }
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
#preflight-banner { flex:1; min-width:220px; }
#preflight-banner .banner { margin-bottom:0; }
.banner.warn { background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.4); color:#fca5a5; }
.banner.ok   { background:rgba(16,185,129,0.10); border:1px solid rgba(16,185,129,0.35); color:#6ee7b7; }
.mode-toggle { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
.mode-toggle label { display:flex; gap:6px; align-items:center; padding:4px 10px; border:1px solid #1e293b; border-radius:6px; cursor:pointer; flex:0 0 auto; background:#0f172a; transition: border-color 0.2s, background 0.2s; }
.mode-toggle label:hover { border-color:#334155; }
.mode-toggle input[type="radio"]:checked + .mt-body { color:#f1f5f9; }
/* Per-card selected accent — snapshot=blue, current=amber. The has() check
   keys off the actual radio value so the colour matches the option even
   before refreshSettingsSourceUi() runs. */
.mode-toggle label:has(input[value="snapshot"]:checked) { border-color:#3b82f6; background:#172033; box-shadow:0 0 0 1px rgba(59,130,246,0.25); }
.mode-toggle label:has(input[value="current"]:checked)  { border-color:#f59e0b; background:#1f1a0e; box-shadow:0 0 0 1px rgba(245,158,11,0.30); }
.mt-title { font-weight:600; font-size:0.78rem; color:#e2e8f0; white-space:nowrap; }
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
:root[data-theme="light"] .rp-block { background:#f8fafc !important; border-color:#e2e8f0 !important; }
:root[data-theme="light"] .rp-row { color:#1e293b !important; }
:root[data-theme="light"] .rp-counter { color:#64748b !important; }
:root[data-theme="light"] .rp-bar { background:#e2e8f0 !important; }
:root[data-theme="light"] .rp-spinner { border-color:#e2e8f0; border-top-color:#0ea5e9; }
:root[data-theme="light"] .rp-elapsed { color:#94a3b8 !important; }
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
/* Collapsible section header (Recorded sessions) */
.collapse-toggle { cursor:pointer; user-select:none; display:inline-flex; align-items:center; gap:6px; }
.collapse-toggle .chev { display:inline-block; transition:transform 0.15s ease; font-size:0.7rem; color:#94a3b8; }
#sessions-card.collapsed .chev { transform:rotate(-90deg); }
#sessions-card.collapsed .sess-toolbar,
#sessions-card.collapsed #sessions-meta,
#sessions-card.collapsed #sessions-table,
#sessions-card.collapsed #sessions-pager { display:none; }
/* Replay-result candlestick chart + clean trades table */
.replay-chart { width:100%; height:360px; margin-top:14px; border:1px solid #1e293b; border-radius:8px; background:#0a0f1c; }
.trades-table { width:100%; border-collapse:collapse; font-size:0.78rem; margin-top:12px; }
.trades-table th, .trades-table td { padding:6px 9px; text-align:left; border-bottom:1px solid #1e293b; white-space:nowrap; }
.trades-table th { color:#94a3b8; font-weight:600; font-size:0.68rem; text-transform:uppercase; letter-spacing:0.04em; }
.trades-table td.num { text-align:right; font-variant-numeric:tabular-nums; }
.trades-table td.reason { white-space:normal; color:#cbd5e1; font-size:0.74rem; max-width:280px; }
.trades-table .pnl-pos { color:#10b981; font-weight:600; }
.trades-table .pnl-neg { color:#ef4444; font-weight:600; }
.trades-table .side-ce { color:#34d399; font-weight:600; }
.trades-table .side-pe { color:#f472b6; font-weight:600; }
.sess-chart { margin-top:10px; border:1px solid #1e293b; border-radius:8px; padding:10px 12px; background:#0f172a; }
.sess-chart > summary { cursor:pointer; font-size:0.8rem; }
:root[data-theme="light"] .sess-chart { background:#f8fafc !important; border-color:#e2e8f0 !important; }
:root[data-theme="light"] .replay-chart { background:#f8fafc !important; border-color:#e2e8f0 !important; }
/* Hover legend: slim panel to the right of the chart showing indicator values
   at the crosshair candle (falls back to the latest bar when not hovering). */
.replay-chart-legend { width:132px; flex:0 0 132px; height:100%; box-sizing:border-box; overflow-y:auto; padding:8px 8px 8px 10px; border-left:1px solid #1e293b; font-size:0.7rem; font-variant-numeric:tabular-nums; color:#cbd5e1; }
.replay-chart-legend .lg-time { font-size:0.68rem; color:#94a3b8; margin-bottom:6px; font-weight:600; letter-spacing:0.03em; }
.replay-chart-legend .lg-row { display:flex; justify-content:space-between; gap:6px; padding:1px 0; line-height:1.55; }
.replay-chart-legend .lg-k { color:#94a3b8; display:flex; align-items:center; gap:5px; white-space:nowrap; }
.replay-chart-legend .lg-k i { width:7px; height:7px; border-radius:2px; display:inline-block; flex:0 0 auto; }
.replay-chart-legend .lg-v { color:#e2e8f0; font-weight:600; white-space:nowrap; }
:root[data-theme="light"] .replay-chart-legend { border-left-color:#e2e8f0 !important; color:#475569 !important; }
:root[data-theme="light"] .replay-chart-legend .lg-time { color:#64748b !important; }
:root[data-theme="light"] .replay-chart-legend .lg-v { color:#1e293b !important; }
:root[data-theme="light"] .trades-table th { color:#64748b !important; }
:root[data-theme="light"] .trades-table th, :root[data-theme="light"] .trades-table td { border-bottom-color:#e2e8f0 !important; }
:root[data-theme="light"] .trades-table td.reason { color:#475569 !important; }
</style>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/themes/dark.css">
<script src="https://cdn.jsdelivr.net/npm/flatpickr@4.6.13"></script>
</head>
<body>
${buildSidebar('replay', false)}
<div class="main">
  <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:16px;">
    <h1 style="margin:0;">📼 Tick Replay</h1>
    <div id="preflight-banner"></div>
  </div>

  <div class="card" id="range-card">
    <strong>Date-range <span id="range-mode-label">replay</span></strong><span id="source-chip" class="source-chip">SNAPSHOT</span>
    <div class="range-row">
      <div class="range-field">
        <label>Quick range</label>
        <select id="range-preset" onchange="applyRangePreset(this.value)">
          <option value="">Custom</option>
          <option value="today" selected>Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="this-week">This week</option>
          <option value="last-week">Last week</option>
          <option value="this-month">This month</option>
          <option value="this-year">This year</option>
        </select>
      </div>
      <div class="range-field">
        <label>From</label>
        <input type="text" id="range-from" readonly placeholder="DD/MM/YYYY" onchange="document.getElementById('range-preset').value=''">
      </div>
      <div class="range-field">
        <label>To</label>
        <input type="text" id="range-to" readonly placeholder="DD/MM/YYYY" onchange="document.getElementById('range-preset').value=''">
      </div>
      <div class="range-field">
        <label>Strategy</label>
        <select id="range-mode">
          ${_renderStrategyOptions()}
        </select>
      </div>
      <div class="range-field">
        <label>Settings source</label>
        <select id="settings-source">
          <option value="current">My current settings</option>
          <option value="snapshot">Snapshot settings</option>
        </select>
      </div>
      <div class="range-field">
        <label>&nbsp;</label>
        <div style="display:flex; gap:8px; align-items:center;">
          <button id="range-run-btn" onclick="runRange(this)">▶ Run range</button>
          <button id="range-cancel-btn" onclick="cancelRange(this)" style="display:none; background:#7f1d1d; color:#fecaca; white-space:nowrap;">✕ Cancel</button>
          <button id="clear-cache-btn" onclick="clearReplayCache(this)" title="Delete all cached replay results — forces a fresh recompute on the next run (safe; does not touch recordings or trade logs)" style="background:#1e293b; color:#e2e8f0; border:1px solid #334155; white-space:nowrap;">🗑 Clear cache</button>
        </div>
      </div>
      <div class="range-field" id="range-diag-btns" style="display:none; flex-direction:row; gap:8px; align-items:flex-end;"></div>
    </div>
    <div id="range-progress" class="rp-block" style="display:none;"></div>
    <div id="range-result" style="margin-top:12px;"></div>
  </div>

  <div class="card collapsed" id="sessions-card">
    <div class="sess-header">
      <strong class="collapse-toggle" onclick="toggleSessionsCollapse()" title="Collapse / expand"><span class="chev">▼</span> Recorded sessions</strong>
      <div class="sess-toolbar">
        <select id="sess-filter-mode" class="sess-input" title="Filter by strategy">
          <option value="">All strategies</option>
        </select>
        <select id="sess-filter-range" class="sess-input" title="Quick date range">
          <option value="">Any date</option>
          <option value="today" selected>Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
          <option value="year">This year</option>
        </select>
        <input id="sess-filter-from" type="date" class="sess-input" title="Show sessions on or after this date">
        <input id="sess-filter-to" type="date" class="sess-input" title="Show sessions on or before this date">
        <input id="sess-filter-search" type="search" class="sess-input" placeholder="Search ID or date…" title="Search session ID or date (YYYY-MM-DD)">
        <select id="sess-per-page" class="sess-input" title="Rows per page">
          <option value="10">10 / page</option>
          <option value="25" selected>25 / page</option>
          <option value="50">50 / page</option>
          <option value="100">100 / page</option>
        </select>
        <button class="row-btn" onclick="downloadAll()" title="Download every recorded day's tick folder as one zip">⬇ Download all</button>
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
let _cancelRequested = false; // set by Cancel; batch loop stops after the current session finishes

// Mode → CSS tag-class (drives the coloured pill in lists/tables).
function modeTag(mode) {
  if (!mode) return 'pa';
  if (mode.startsWith('swing'))    return 'swing';
  if (mode.startsWith('scalp'))    return 'scalp';
  if (mode.startsWith('orb'))      return 'orb';
  if (mode.startsWith('straddle')) return 'straddle';
  return 'pa';
}

// Collapse / expand the Recorded sessions card body (toolbar + table + pager).
function toggleSessionsCollapse() {
  const card = document.getElementById('sessions-card');
  if (card) card.classList.toggle('collapsed');
}

// Draw the replay's candlestick chart + entry/exit markers into the given el,
// using the
// same chart-data contract the paper screen consumes (candles, markers, and
// per-mode line overlays). Best-effort: silently no-ops if the library or data
// is missing so a chart hiccup never blanks the result card.
function drawReplayChart(el, cd) {
  if (!el) return;
  if (!window.LightweightCharts || !cd || !Array.isArray(cd.candles) || !cd.candles.length) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'flex';
  el.innerHTML = '';
  // Split the card into a chart host (grows to fill) + a slim legend panel on
  // the right. The legend shows each indicator's value at the hovered candle,
  // which also keeps the chart itself narrower so the candles aren't stretched.
  const host = document.createElement('div');
  host.style.cssText = 'flex:1 1 auto; min-width:0; height:100%;';
  const legend = document.createElement('div');
  legend.className = 'replay-chart-legend';
  el.appendChild(host);
  el.appendChild(legend);
  // Series collected here (in draw order) so the crosshair handler can read each
  // one's value at the hovered time. The "last" bar is shown when idle.
  const legendItems = [];
  // Trim every series to the latest IST trading day so zooming out shows only
  // the session day — warmup history is loaded only for indicator computation.
  (function(){
    var _c=cd.candles, _lt=_c[_c.length-1].time, _dk=Math.floor((_lt+19800)/86400), _cut=_lt;
    for (var _i=_c.length-1;_i>=0;_i--){ if(Math.floor((_c[_i].time+19800)/86400)===_dk) _cut=_c[_i].time; else break; }
    var _f=function(a){ return a.filter(function(x){return x.time>=_cut;}); };
    var _trim=function(o){ Object.keys(o).forEach(function(kk){ var a=o[kk]; if(Array.isArray(a)){ if(a.length&&a[0]&&typeof a[0].time==='number') o[kk]=_f(a); } else if(a&&typeof a==='object'){ _trim(a); } }); };
    _trim(cd);
  })();
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  // Candle/marker times are epoch seconds; lightweight-charts renders the axis
  // in UTC by default, which puts an IST session 5:30 too far left. Format the
  // axis ticks and crosshair label in IST (browser-local, en-IN) to match the
  // paper screen and the IST trade table below it.
  const _ist2 = (n) => ('0' + n).slice(-2);
  const chart = LightweightCharts.createChart(host, {
    width: host.clientWidth, height: 360,
    layout: { background: { color: 'transparent' }, textColor: isLight ? '#475569' : '#94a3b8' },
    grid: { vertLines: { color: isLight ? '#e2e8f0' : '#1e293b' }, horzLines: { color: isLight ? '#e2e8f0' : '#1e293b' } },
    timeScale: {
      timeVisible: true, secondsVisible: false, borderColor: '#334155',
      tickMarkFormatter: (time) => {
        const d = new Date(time * 1000);
        return _ist2(d.getHours()) + ':' + _ist2(d.getMinutes());
      },
    },
    localization: {
      timeFormatter: (time) => {
        const d = new Date(time * 1000);
        return _ist2(d.getHours()) + ':' + _ist2(d.getMinutes()) + ':' + _ist2(d.getSeconds());
      },
    },
    rightPriceScale: { borderColor: '#334155' },
    crosshair: { mode: 0 },
  });
  const cs = chart.addCandlestickSeries({
    upColor: '#10b981', downColor: '#ef4444', borderVisible: false,
    wickUpColor: '#10b981', wickDownColor: '#ef4444',
  });
  cs.setData(cd.candles);
  legendItems.push({ kind: 'ohlc', color: '#cbd5e1', series: cs, last: cd.candles[cd.candles.length - 1] });
  // Line overlays differ by mode; draw whichever the payload carries.
  const overlays = [
    ['bbUpper', '#a78bfa'], ['bbMiddle', '#64748b'], ['bbLower', '#a78bfa'],
    ['ema9', '#a855f7'], ['ema20', '#fbbf24'], ['ema50', '#3b82f6'], ['ema21', '#fbbf24'],
    ['orhLine', '#34d399'], ['orlLine', '#f87171'],
  ];
  const _ovLabel = { bbUpper: 'BB↑', bbMiddle: 'BB·', bbLower: 'BB↓', ema9: 'EMA9', ema20: 'EMA20', ema50: 'EMA50', ema21: 'EMA21', orhLine: 'ORH', orlLine: 'ORL' };
  const _wideOverlays = { ema9: 1, ema20: 1, ema50: 1, ema21: 1 };
  for (const [key, color] of overlays) {
    const arr = cd[key];
    if (Array.isArray(arr) && arr.length) {
      const ls = chart.addLineSeries({ color, lineWidth: _wideOverlays[key] ? 2 : 1, priceLineVisible: false, lastValueVisible: false });
      ls.setData(arr);
      legendItems.push({ label: _ovLabel[key] || key, color, series: ls, last: arr[arr.length - 1] });
    }
  }
  // SAR as discrete dots (hide connecting line, show only point markers).
  if (Array.isArray(cd.sar) && cd.sar.length) {
    const sarLs = chart.addLineSeries({ color: '#f472b6', lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2, priceLineVisible: false, lastValueVisible: false });
    sarLs.setData(cd.sar);
    legendItems.push({ label: 'SAR', color: '#f472b6', series: sarLs, last: cd.sar[cd.sar.length - 1] });
  }
  // SuperTrend line (solid) — drawn when the session used SuperTrend instead of PSAR.
  // Per-point colour: GREEN when bullish (trend===1), RED when bearish (trend===-1).
  // Older cached sessions without per-point trend fall back to green.
  if (Array.isArray(cd.supertrend) && cd.supertrend.length) {
    const stLs = chart.addLineSeries({ color: '#22c55e', lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    const stData = cd.supertrend.map(p => ({ time: p.time, value: p.value, color: (p.trend === -1 ? '#ef4444' : '#22c55e') }));
    stLs.setData(stData);
    legendItems.push({ label: 'ST', color: '#22c55e', series: stLs, last: stData[stData.length - 1] });
  }
  // RSI on its own bottom scale + dashed level lines at the strategy thresholds.
  if (Array.isArray(cd.rsi) && cd.rsi.length) {
    const rsiLs = chart.addLineSeries({ color: '#22d3ee', lineWidth: 1, priceScaleId: 'rsi', priceLineVisible: false, lastValueVisible: true });
    try { chart.priceScale('rsi').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } }); } catch (_) {}
    rsiLs.setData(cd.rsi);
    legendItems.push({ label: 'RSI', color: '#22d3ee', series: rsiLs, last: cd.rsi[cd.rsi.length - 1] });
    try {
      rsiLs.createPriceLine({ price: cd.rsiCeMin != null ? cd.rsiCeMin : 52, color: '#10b981', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'CE' });
      rsiLs.createPriceLine({ price: cd.rsiPeMax != null ? cd.rsiPeMax : 48, color: '#ef4444', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'PE' });
    } catch (_) {}
  }
  // ADX trend-strength subplot (scalp) — own bottom scale, stacked just above RSI.
  if (Array.isArray(cd.adx) && cd.adx.length) {
    const adxLs = chart.addLineSeries({ color: '#e879f9', lineWidth: 1, priceScaleId: 'adx', priceLineVisible: false, lastValueVisible: true });
    try { chart.priceScale('adx').applyOptions({ scaleMargins: { top: 0.66, bottom: 0.20 } }); } catch (_) {}
    adxLs.setData(cd.adx);
    legendItems.push({ label: 'ADX', color: '#e879f9', series: adxLs, last: cd.adx[cd.adx.length - 1] });
    if (cd.adxMin != null) { try { adxLs.createPriceLine({ price: cd.adxMin, color: '#a855f7', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'ADX min' }); } catch (_) {} }
  }
  // Markers must be sorted ascending by time or the library throws.
  if (Array.isArray(cd.markers) && cd.markers.length) {
    cs.setMarkers(cd.markers.slice().sort((a, b) => a.time - b.time));
  }
  // Zoom to just the latest IST trading day. The payload carries the multi-day
  // warmup history needed for indicator convergence (EMA/SAR/RSI); fitContent()
  // would show all of it as "extra" candles with repeated 09:15 day-boundary
  // labels. Restrict the visible range to the session day instead.
  try {
    const cl = cd.candles;
    const lastT = cl[cl.length - 1].time;
    const dayK = Math.floor((lastT + 19800) / 86400); // IST calendar day of last candle
    let firstT = lastT;
    for (let i = cl.length - 1; i >= 0; i--) {
      if (Math.floor((cl[i].time + 19800) / 86400) === dayK) firstT = cl[i].time;
      else break;
    }
    chart.timeScale().setVisibleRange({ from: firstT, to: lastT });
  } catch (_) { try { chart.timeScale().fitContent(); } catch (__) {} }
  try {
    const ro = new ResizeObserver(() => chart.applyOptions({ width: host.clientWidth }));
    ro.observe(host);
  } catch (_) {}
  // Hover legend: on crosshair move, read each series' value at the hovered
  // candle from param.seriesData; fall back to the latest bar when idle so the
  // panel always shows numbers. A line point is {value}; a candle is OHLC.
  const _num = (v) => (v == null || v !== v) ? '–' : (Math.round(v * 100) / 100).toFixed(2);
  const _lineVal = (p) => (p == null) ? null : (typeof p === 'object' ? (p.value != null ? p.value : p.close) : p);
  const _lgRow = (color, label, val) =>
    '<div class="lg-row"><span class="lg-k"><i style="background:' + color + '"></i>' + label + '</span><span class="lg-v">' + val + '</span></div>';
  function renderLegend(param) {
    const hovering = param && param.time != null && param.seriesData;
    let timeLabel = 'latest';
    if (hovering) { const d = new Date(param.time * 1000); timeLabel = _ist2(d.getHours()) + ':' + _ist2(d.getMinutes()); }
    let rows = '';
    for (const it of legendItems) {
      const pt = hovering ? param.seriesData.get(it.series) : null;
      const data = pt != null ? pt : it.last;
      if (it.kind === 'ohlc') {
        const o = data && (data.open != null ? data.open : data.o);
        const h = data && (data.high != null ? data.high : data.h);
        const l = data && (data.low != null ? data.low : data.l);
        const c = data && (data.close != null ? data.close : data.c);
        rows += _lgRow(it.color, 'O', _num(o)) + _lgRow(it.color, 'H', _num(h)) +
                _lgRow(it.color, 'L', _num(l)) + _lgRow(it.color, 'C', _num(c));
      } else {
        rows += _lgRow(it.color, it.label, _num(_lineVal(data)));
      }
    }
    legend.innerHTML = '<div class="lg-time' + (hovering ? '' : ' muted') + '">' + timeLabel + '</div>' + rows;
  }
  chart.subscribeCrosshairMove(renderLegend);
  renderLegend(null);
}

// Date-range path: per-session charts draw lazily when their <details> opens
// (a chart in a collapsed details has 0 width and renders blank). chartData is
// stashed by container id so the ontoggle handler can fetch it on first expand.
let _rangeChartData = {};
function lazyDrawSessionChart(detailsEl, cid) {
  if (!detailsEl || !detailsEl.open) return;
  const el = document.getElementById(cid);
  if (!el || el.dataset.drawn === '1') return;
  el.dataset.drawn = '1';
  requestAnimationFrame(() => drawReplayChart(el, _rangeChartData[cid]));
}

// Read a trade field across the per-mode naming variants (entry/exit reasons,
// spot prices, side) so one table renders cleanly for every strategy.
function _tradeField(t, keys) {
  for (const k of keys) { if (t[k] != null && t[k] !== '') return t[k]; }
  return null;
}

// Clean trades table (replaces the raw-JSON dump) — surfaces entry/exit reason
// per trade alongside side, prices, and P&L.
function renderTradesTable(trades) {
  if (!trades || !trades.length) return '<div class="muted" style="margin-top:10px;">No trades.</div>';
  let h = '<table class="trades-table"><thead><tr>' +
    '<th>#</th><th>Side</th><th>Entry</th><th class="num">Entry px</th>' +
    '<th>Exit</th><th class="num">Exit px</th><th class="num">P&L</th>' +
    '<th>Entry reason</th><th>Exit reason</th></tr></thead><tbody>';
  trades.forEach((t, i) => {
    const side    = _tradeField(t, ['side', 'optionType']) || '–';
    const sideCls = /ce/i.test(side) ? 'side-ce' : (/pe/i.test(side) ? 'side-pe' : '');
    const entry   = _tradeField(t, ['entry']) || '–';
    const exit    = _tradeField(t, ['exit']) || '–';
    const ePx     = _tradeField(t, ['eSpot', 'spotAtEntry', 'entryPrice', 'entrySpot']);
    const xPx     = _tradeField(t, ['xSpot', 'spotAtExit', 'exitPrice', 'exitSpot']);
    const pnl     = (typeof t.pnl === 'number') ? t.pnl : (typeof t.pairPnl === 'number' ? t.pairPnl : null);
    const eR      = _tradeField(t, ['entryReason']) || '–';
    const xR      = _tradeField(t, ['reason', 'exitReason']) || '–';
    const pnlCls  = pnl == null ? '' : (pnl >= 0 ? 'pnl-pos' : 'pnl-neg');
    const pnlTxt  = pnl == null ? '–' : (pnl >= 0 ? '+' : '−') + '₹' + Math.abs(pnl).toFixed(2);
    h += '<tr>' +
      '<td class="num">' + (i + 1) + '</td>' +
      '<td class="' + sideCls + '">' + _escapeHtml(String(side)) + '</td>' +
      '<td>' + _escapeHtml(String(entry)) + '</td>' +
      '<td class="num">' + (ePx != null ? Number(ePx).toFixed(2) : '–') + '</td>' +
      '<td>' + _escapeHtml(String(exit)) + '</td>' +
      '<td class="num">' + (xPx != null ? Number(xPx).toFixed(2) : '–') + '</td>' +
      '<td class="num ' + pnlCls + '">' + pnlTxt + '</td>' +
      '<td class="reason">' + _escapeHtml(String(eR)) + '</td>' +
      '<td class="reason">' + _escapeHtml(String(xR)) + '</td>' +
      '</tr>';
  });
  h += '</tbody></table>';
  return h;
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
      // Two block causes: (1) a strategy (Swing/Scalp/PA…) is actually running,
      // or (2) a replay flag is set. Case 2 can be a genuine other-tab run OR a
      // stuck flag left by a run that died mid-flight (e.g. a deploy). Either
      // way the user needs a way out, so always offer Force clear — with wording
      // matched to the cause.
      const isAnotherReplay = /another replay is already running/i.test(data.reason || '');
      const hint = isAnotherReplay
        ? 'If another tab is genuinely running a replay, wait for it. If a run was interrupted (e.g. by a deploy) and nothing is actually running, force-clear the stuck flag.'
        : 'Only force-clear if you have confirmed on the strategy pages that NO session is actually running.';
      banner.innerHTML =
        '<div class="banner warn" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">' +
          '<div>⚠️ ' + (data.reason || 'Replay not allowed right now.') +
            '<div class="muted" style="color:#fca5a5;font-size:0.74rem;margin-top:3px;">' + hint + '</div>' +
          '</div>' +
          '<button onclick="forceClearStuckState(this)" style="background:#7f1d1d;color:#fecaca;border:1px solid #b91c1c;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer;white-space:nowrap;">Force clear stuck state</button>' +
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
               'Only do this if you have confirmed on the strategy pages (Swing/Scalp/PA Paper) that NO session is actually running, and no other tab is mid-replay.\\n\\n' +
               'This clears the in-memory strategy mutexes AND the replay-in-progress flag — it does NOT touch trade logs, positions, or recordings.')) return;
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

// Delete every cached replay result (the _replay_cache group). The next Run
// recomputes from the raw tick stream — recordings, trade logs and replay
// outputs are untouched, so this is always safe.
// Brief, non-blocking toast in the bottom-right corner.
function showReplayToast(msg) {
  var t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed; bottom:24px; right:24px; z-index:9999; ' +
    'background:#065f46; color:#ecfdf5; padding:12px 18px; border-radius:8px; ' +
    'border:1px solid #10b981; box-shadow:0 4px 16px rgba(0,0,0,.4); ' +
    'font-size:14px; max-width:360px; opacity:0; transition:opacity .2s;';
  document.body.appendChild(t);
  requestAnimationFrame(function(){ t.style.opacity = '1'; });
  setTimeout(function(){ t.style.opacity = '0'; setTimeout(function(){ t.remove(); }, 250); }, 3000);
}

async function clearReplayCache(btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Clearing…';
  try {
    const r = await secretFetch('/cache-files/delete-all?group=replay_cache', { method: 'POST' });
    if (r === null) { btn.disabled = false; btn.textContent = orig; return; } // secret prompt cancelled
    const data = await r.json();
    if (data.success) {
      var n = data.deleted ? data.deleted.length : 0;
      btn.textContent = 'Cleared ' + n + ' ✓';
      showReplayToast('Cleared ' + n + ' cached replay result' + (n === 1 ? '' : 's') + '. Next run recomputes fresh.');
      setTimeout(function(){ btn.disabled = false; btn.textContent = orig; }, 2500);
    } else {
      btn.disabled = false;
      btn.textContent = orig;
      alert('Clear cache failed: ' + (data.error || (data.failed && data.failed.length ? data.failed.length + ' files' : 'unknown')));
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    alert('Clear cache failed: ' + e.message);
  }
}

// Filter + pagination state for the Recorded sessions table.
let _sessFilter = { mode: '', search: '', dateFrom: '', dateTo: '', page: 1, perPage: 25 };

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
    .filter(s => !_sessFilter.dateFrom || (s.date || '') >= _sessFilter.dateFrom)
    .filter(s => !_sessFilter.dateTo || (s.date || '') <= _sessFilter.dateTo)
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
    applyReplayDeepLink();
  } catch (e) {
    div.innerHTML = '<div class="empty">Fetch failed: ' + e.message + '</div>';
  }
}

// Deep-link entry from the per-session "View chart" links on the history pages:
//   /replay?from=YYYY-MM-DD&to=YYYY-MM-DD&mode=swing-paper&run=1
// Prefills the date-range + mode and (optionally) auto-runs the replay so the
// candlestick chart + trade markers render without manual setup. Runs once.
let _deepLinkApplied = false;
function applyReplayDeepLink() {
  if (_deepLinkApplied) return;
  _deepLinkApplied = true;
  let p;
  try { p = new URLSearchParams(window.location.search); } catch (_) { return; }
  const from = p.get('from'), to = p.get('to'), mode = p.get('mode'), run = p.get('run');
  const settings = p.get('settings');
  if (!from && !to && !mode) return;

  if (settings === 'snapshot' || settings === 'current') {
    const ss = document.getElementById('settings-source');
    if (ss) ss.value = settings;
  }

  if (mode) {
    const ms = document.getElementById('range-mode');
    if (ms) {
      const ok = Array.prototype.some.call(ms.options, o => o.value === mode);
      if (ok) ms.value = mode;
    }
  }
  if (from && _rangeFromFp) _rangeFromFp.setDate(from, true);
  if (to && _rangeToFp)     _rangeToFp.setDate(to, true);
  const presetEl = document.getElementById('range-preset');
  if (presetEl) presetEl.value = '';

  if (run === '1') {
    // Strip run=1 from the URL so a manual page refresh doesn't re-fire the
    // replay. The prefilled date-range + mode stay in the URL for sharing.
    try {
      p.delete('run');
      const qs = p.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
    } catch (_) {}
    const btn = document.getElementById('range-run-btn');
    if (btn) setTimeout(() => runRange(btn), 0);
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

function downloadAll() {
  // Direct nav so the browser handles the streamed zip as a normal download.
  window.location.href = '/replay/download-all';
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
  const sel = document.getElementById('settings-source');
  return sel ? sel.value : 'current';
}

// Update the date-range card's labels + button text whenever the user
// switches the settings-source radio. This makes the UI's intent crystal
// clear before the user clicks Run.
function refreshSettingsSourceUi() {
  const isCurrent = getSelectedSettingsSource() === 'current';
  const modeLabel = document.getElementById('range-mode-label');
  const runBtn    = document.getElementById('range-run-btn');
  const chip      = document.getElementById('source-chip');
  // Body-level attribute drives all the colour theming via CSS — set it
  // first so the rest of the DOM mutations land in the new colour scheme.
  document.body.setAttribute('data-source', isCurrent ? 'current' : 'snapshot');
  if (chip) chip.textContent = isCurrent ? 'SIMULATOR · CURRENT SETTINGS' : 'SNAPSHOT · DETERMINISTIC';
  if (modeLabel) modeLabel.textContent = isCurrent ? 'comparison' : 'replay';
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

// Comparison delta (replay − live), with one guard: a replay P&L of exactly 0
// almost always means the session produced NO replay result (0 trades / no
// setup fired / data hole), not that the settings deliberately avoided a live
// loss. Crediting that as an improvement (e.g. live −₹732 → delta +₹732) is
// misleading, so when replay P&L is 0 we treat the delta as neutral (0) rather
// than the inverse of the live result.
function cmpDelta(bPnl, sPnl) {
  if (Math.abs(sPnl || 0) < 0.005) return 0;
  return (sPnl || 0) - (bPnl || 0);
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
  const dPnl = cmpDelta(bPnl, sPnl);
  const dTrd = sTrd - bTrd;

  const colSnapshot =
    '<div class="cmp-col ' + (baseline.ok ? '' : 'cmp-err') + '">' +
      '<div class="cmp-label">Live paper trade (baseline)</div>' +
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
      '<div class="cmp-label">Replay result</div>' +
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
    dPnl > 0 ? 'Replay is <strong>better</strong> than live paper trade by ' + fmtRupee(dPnl) + '.' :
                'Replay is <strong>worse</strong> than live paper trade by ' + fmtRupee(dPnl) + '.';

  const colDelta = (!baseline.ok || !sim.ok)
    ? '<div class="cmp-col delta"><div class="cmp-label">Delta</div><div class="cmp-meta">Need both runs to compare.</div></div>'
    : '<div class="cmp-col delta">' +
        '<div class="cmp-label">Delta (replay − live)</div>' +
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

  // Candlestick chart of the replay run (price + entry/exit markers), drawn
  // after innerHTML is set since the library needs a live DOM node.
  const hasChart = sim.ok && sim.chartData && Array.isArray(sim.chartData.candles) && sim.chartData.candles.length;
  if (hasChart) {
    html += '<div class="replay-chart" id="replay-result-chart"></div>';
  }

  // Clean trades table (entry/exit reason per trade) replaces the raw JSON.
  if (sim.ok && sim.sessionTrades && sim.sessionTrades.length) {
    _CN_SINGLE_TRADES = sim.sessionTrades; _CN_SINGLE_LABEL = _cnModeLabel(sim.mode);
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;"><span class="muted">Replay trades (' + sim.sessionTrades.length + ')</span>' +
            '<button class="row-btn" onclick="openReplaySingleReport()" title="Contract note for this replay">📄 Report</button></div>';
    html += renderTradesTable(sim.sessionTrades);
  }

  // Raw JSON kept available but collapsed, for debugging the wire shape.
  if (sim.ok && sim.sessionTrades && sim.sessionTrades.length) {
    html += '<details style="margin-top:8px;"><summary class="muted">Raw trade JSON (' + sim.sessionTrades.length + ')</summary><pre>' + JSON.stringify(sim.sessionTrades, null, 2) + '</pre></details>';
  }
  if (baseline.ok && baseline.sessionTrades && baseline.sessionTrades.length) {
    html += '<details style="margin-top:6px;"><summary class="muted">Baseline trade details (' + baseline.sessionTrades.length + ')</summary><pre>' + JSON.stringify(baseline.sessionTrades, null, 2) + '</pre></details>';
  }
  content.innerHTML = html;

  if (hasChart) {
    // Defer to next frame so the container has its measured width.
    requestAnimationFrame(() => drawReplayChart(document.getElementById('replay-result-chart'), sim.chartData));
  }
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
  let _stepLabel = useCurrentSettings
    ? 'Replaying with your current settings…'
    : 'Replaying with snapshot settings…';
  const tick = () => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    progress.innerHTML = _stepLabel + ' (' + elapsed + 's)';
  };
  tick();
  const progressTimer = setInterval(tick, 1000);

  // ONE replay run per session. Baseline (the live paper-trade result) comes
  // from the canonical paper_trades.json on disk, included in the response as
  // sim.canonical. The replay-result column is this run's actual output.
  let sim = null;
  try {
    try { sim = await callReplayApi(date, mode, sessionId, useCurrentSettings); }
    catch (e) { sim = { ok: false, error: e.message }; }
  } finally {
    clearInterval(progressTimer);
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  progress.innerHTML = '✅ Done in ' + totalSec + 's.';

  // Synthesise a "baseline" object from the canonical lookup so the existing
  // renderComparison() can be re-used unchanged. tradeCount + the matched
  // live trades (compact shape, chronological) come through so the diagnostic
  // can do a per-trade baseline-vs-replay diff.
  const baseline = (sim && sim.ok && sim.canonical) ? {
    ok: true,
    mode: sim.mode,
    sessionId: sim.sessionId,
    sessionPnl: sim.canonical.pnl,
    tradeCount: sim.canonical.tradeCount,
    sessionTrades: sim.canonical.trades || [],
    _baselineFromCanonical: true,
  } : { ok: false, error: 'No canonical paper-trade record found for this session' };

  content.innerHTML = headerHtml;
  const body = document.createElement('div');
  content.appendChild(body);
  if (!sim.ok) {
    body.innerHTML = '<div class="muted">⚠️ Replay failed: ' + _escapeHtml(sim.error || 'unknown') + '</div>';
  } else {
    renderComparison(body, baseline, sim, '');
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

// Builds a single text blob with everything I'd need to debug a divergence:
// result summary + per-session trade details.
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

    // SAR trace: per-candle OHLC + the SAR dot value/side the chart drew, so a
    // flip-timing divergence (bot vs TradingView) can be located candle-by-candle
    // without needing the raw session file off the server. Diagnostic-only.
    const cd = r.sim && r.sim.chartData;
    if (cd && Array.isArray(cd.candles) && cd.candles.length) {
      // Trace whichever trend source the session used (PSAR dots or SuperTrend line).
      const useST = Array.isArray(cd.supertrend) && cd.supertrend.length;
      const label = useST ? 'SuperTrend' : 'SAR';
      const byTime = new Map();
      (useST ? cd.supertrend : (cd.sar || [])).forEach(p => byTime.set(p.time, p.value));
      lines.push('');
      lines.push(label + ' trace (time IST | O H L C | ' + label + ' | side):');
      for (const c of cd.candles) {
        const v = byTime.has(c.time) ? byTime.get(c.time) : null;
        const side = v == null ? '-' : (v < c.close ? 'BULL' : 'BEAR');
        const t = new Date(c.time * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
        lines.push('  ' + t + ' | ' + c.open + ' ' + c.high + ' ' + c.low + ' ' + c.close + ' | ' + (v == null ? '-' : v) + ' | ' + side);
      }
    }
    lines.push('');
  });

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

let _enabledDates = [];
let _rangeFromFp = null;
let _rangeToFp   = null;

function setRangeDefaults() {
  // Restrict From/To to dates that actually have a recording on disk.
  // Weekends and market holidays appear greyed out in the calendar.
  const fromEl = document.getElementById('range-from');
  const toEl   = document.getElementById('range-to');
  _enabledDates = Array.from(new Set(_allSessionsCache.map(s => s.date).filter(Boolean))).sort();

  if (_enabledDates.length === 0) {
    if (_rangeFromFp) { _rangeFromFp.destroy(); _rangeFromFp = null; }
    if (_rangeToFp)   { _rangeToFp.destroy();   _rangeToFp   = null; }
    const today = new Date().toISOString().slice(0, 10);
    fromEl.value = toEl.value = today;
    return;
  }

  const earliest = _enabledDates[0];
  const latest   = _enabledDates[_enabledDates.length - 1];
  // Default to today (or the most recent recorded date ≤ today if today
  // has no recording — weekend, holiday, or session not yet started).
  const today = new Date().toISOString().slice(0, 10);
  const onOrBefore = _enabledDates.filter(d => d <= today);
  const todayOrNearest = onOrBefore.length ? onOrBefore[onOrBefore.length - 1] : latest;
  const prevFrom = fromEl.value && _enabledDates.includes(fromEl.value) ? fromEl.value : todayOrNearest;
  const prevTo   = toEl.value   && _enabledDates.includes(toEl.value)   ? toEl.value   : todayOrNearest;
  const common = {
    dateFormat: 'Y-m-d',
    altInput: true,
    altFormat: 'd/m/Y',
    enable: _enabledDates,
    minDate: earliest,
    maxDate: latest,
    disableMobile: true,
    onChange: () => { document.getElementById('range-preset').value = ''; },
  };

  if (_rangeFromFp) _rangeFromFp.destroy();
  if (_rangeToFp)   _rangeToFp.destroy();
  _rangeFromFp = flatpickr(fromEl, Object.assign({}, common, { defaultDate: prevFrom }));
  _rangeToFp   = flatpickr(toEl,   Object.assign({}, common, { defaultDate: prevTo   }));
}

// Quick-range presets. Computes [from,to] in local time, then clamps to the
// recorded-date bounds enforced on the inputs (min/max from setRangeDefaults).
function applyRangePreset(preset) {
  if (!preset) return;
  const fromEl = document.getElementById('range-from');
  const toEl   = document.getElementById('range-to');
  const fmt = d => {
    const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return x.toISOString().slice(0, 10);
  };
  const now = new Date();
  let from = new Date(now), to = new Date(now);
  switch (preset) {
    case 'today':     break;
    case 'yesterday': from.setDate(now.getDate() - 1); to = new Date(from); break;
    case 'this-week': {
      // Monday as week start.
      const dow = (now.getDay() + 6) % 7;
      from.setDate(now.getDate() - dow);
      break;
    }
    case 'last-week': {
      const dow = (now.getDay() + 6) % 7;
      to.setDate(now.getDate() - dow - 1);
      from = new Date(to); from.setDate(to.getDate() - 6);
      break;
    }
    case 'this-month': from = new Date(now.getFullYear(), now.getMonth(), 1); break;
    case 'this-year':  from = new Date(now.getFullYear(), 0, 1); break;
    default: return;
  }
  let f = fmt(from), t = fmt(to);
  // Snap to nearest recorded date so we never request dates with no data
  // (weekends, holidays, gaps in recording).
  if (_enabledDates.length) {
    const firstOnOrAfter = _enabledDates.find(d => d >= f);
    f = firstOnOrAfter || _enabledDates[_enabledDates.length - 1];
    const onOrBefore = _enabledDates.filter(d => d <= t);
    t = onOrBefore.length ? onOrBefore[onOrBefore.length - 1] : _enabledDates[0];
  }
  // setDate(_, false) avoids firing onChange, which would re-clear the preset.
  if (_rangeFromFp) _rangeFromFp.setDate(f, false); else fromEl.value = f;
  if (_rangeToFp)   _rangeToFp.setDate(t, false);   else toEl.value   = t;
}

// Every replay-able paper mode currently offered in the Strategy dropdown
// (i.e. enabled via the *_MODE_ENABLED + UI_SHOW_* toggles), excluding the
// synthetic "all" entry. Used to expand mode==='all' into its members.
function _allReplayModes() {
  const sel = document.getElementById('range-mode');
  if (!sel) return [];
  return Array.prototype.map.call(sel.options, o => o.value).filter(v => v && v !== 'all');
}

function pickSessionsInRange(from, to, mode) {
  // Sessions are deduped by sessionId in listRecordings, sorted newest-first.
  // We DON'T require durationMs != null. A session that crash-recovered or
  // was killed mid-flight has no stop record but still has a full spot/option
  // tick stream — replay synthesises an end-of-window stop and processes
  // every recorded tick. Excluding these meant 18-may swing was unreachable
  // even though all its ticks were on disk.
  // mode==='all' → every enabled paper mode; the batch runner replays each
  // session against its own mode, so a mixed list works as-is.
  const wanted = (mode === 'all') ? _allReplayModes() : [mode];
  return _allSessionsCache
    .filter(s => wanted.includes(s.mode) && s.date >= from && s.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.startTs || 0) - (b.startTs || 0)));
}

function renderRangeResult(rows, context) {
  // rows: [{ session, baseline, sim }]
  // context: { mode, label, from, to } — describes what was run
  const el = document.getElementById('range-result');
  // Stash for the Report (contract note) buttons.
  _CN_RANGE_ROWS = rows; _CN_RANGE_CTX = context;

  // NOTE: do not rename this back to modeTag — that shadows the outer
  // modeTag() helper and the const initializer would call itself before
  // init (TDZ), crashing renderRangeResult on the first session render.
  // That crash killed the per-row live partial render and prevented the
  // loop from advancing to subsequent sessions in a multi-day range.
  const headerTagClass = context && context.mode
    ? modeTag(context.mode)
    : 'pa';
  const headerPill = context && context.mode === 'all' ? 'all strategies' : (context ? context.mode : '');
  const headerLine = context
    ? '<div style="margin-bottom:10px;font-size:0.9rem;">' +
        'Strategy: <span class="tag ' + headerTagClass + '">' + headerPill + '</span> ' +
        '<span class="muted">(' + (context.label || context.mode) + ')</span> · ' +
        '<span class="muted">Range: ' + context.from + ' → ' + context.to + '</span>' +
      '</div>'
    : '';

  if (rows.length === 0) {
    el.innerHTML = headerLine + '<div class="muted">No sessions completed.</div>';
    return;
  }

  // Track baseline and sim independently so a row counts even if one side is
  // missing (e.g. swing-paper has no canonical record for these dates → only
  // sim totals are valid). Delta counters only iterate over rows where both
  // sides are ok, since cmpDelta needs both.
  let totBPnl = 0, totSPnl = 0, totBTrd = 0, totSTrd = 0;
  let bOkCount = 0, sOkCount = 0, bothOkCount = 0;
  let simBetter = 0, simWorse = 0, totDPnl = 0;
  for (const r of rows) {
    const bOk = r.baseline && r.baseline.ok;
    const sOk = r.sim && r.sim.ok;
    if (bOk) {
      bOkCount++;
      totBPnl += (r.baseline.sessionPnl || 0);
      totBTrd += (r.baseline.tradeCount || 0);
    }
    if (sOk) {
      sOkCount++;
      totSPnl += (r.sim.sessionPnl  || 0);
      totSTrd += (r.sim.tradeCount  || 0);
    }
    if (bOk && sOk) {
      bothOkCount++;
      const d = cmpDelta(r.baseline.sessionPnl, r.sim.sessionPnl);
      totDPnl += d;
      if (d >  0.005) simBetter++;
      else if (d < -0.005) simWorse++;
    }
  }
  // Aggregate delta is the sum of per-session deltas (so 0-result replays
  // contribute 0), NOT totSPnl − totBPnl which would re-introduce the
  // avoided-loss credit cmpDelta() suppresses.
  const dPnl = totDPnl;
  const dTrd = (bothOkCount > 0) ? (totSTrd - totBTrd) : 0;
  const hasBaseline = bOkCount > 0;
  const hasDelta    = bothOkCount > 0;

  const colSnapshot =
    '<div class="cmp-col">' +
      '<div class="cmp-label">Live paper trade (baseline)</div>' +
      (hasBaseline
        ? '<div class="cmp-pnl ' + (totBPnl >= 0 ? 'positive' : 'negative') + '">' + (totBPnl >= 0 ? '+' : '') + '₹' + totBPnl.toFixed(2) + '</div>' +
          '<div class="cmp-meta">' +
            '<div class="cmp-meta-row"><span>Total trades</span><span>' + totBTrd + '</span></div>' +
            '<div class="cmp-meta-row"><span>Sessions</span><span>' + bOkCount + '</span></div>' +
          '</div>'
        : '<div class="cmp-pnl neutral">—</div>' +
          '<div class="cmp-meta"><div class="cmp-meta-row"><span>No canonical record on disk for these sessions.</span></div></div>') +
    '</div>';
  const colSim =
    '<div class="cmp-col">' +
      '<div class="cmp-label">Replay result</div>' +
      '<div class="cmp-pnl ' + (totSPnl >= 0 ? 'positive' : 'negative') + '">' + (totSPnl >= 0 ? '+' : '') + '₹' + totSPnl.toFixed(2) + '</div>' +
      '<div class="cmp-meta">' +
        '<div class="cmp-meta-row"><span>Total trades</span><span>' + totSTrd + '</span></div>' +
        '<div class="cmp-meta-row"><span>Sessions</span><span>' + sOkCount + '</span></div>' +
      '</div>' +
    '</div>';
  const colDelta = hasDelta
    ? '<div class="cmp-col delta">' +
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
      '</div>'
    : '<div class="cmp-col delta">' +
        '<div class="cmp-label">Aggregate delta</div>' +
        '<div class="cmp-pnl neutral">—</div>' +
        '<div class="cmp-meta"><div class="cmp-meta-row"><span>Need a baseline to compare.</span></div></div>' +
      '</div>';

  const verdict =
    sOkCount === 0
      ? 'All runs failed — see per-session table below.'
      : !hasBaseline
        ? 'No baseline available for these sessions — showing replay-only totals (' + sOkCount + ' session' + (sOkCount === 1 ? '' : 's') + ', ' + totSTrd + ' trades, ' + fmtRupee(totSPnl) + ').'
        : Math.abs(dPnl) < 0.005
          ? 'No net change — your settings produce the same aggregate P&L on these days.'
          : dPnl > 0
            ? 'Across these ' + bothOkCount + ' sessions, replay is <strong>better</strong> than live by ' + fmtRupee(dPnl) + ' (improved ' + simBetter + ', regressed ' + simWorse + ').'
            : 'Across these ' + bothOkCount + ' sessions, replay is <strong>worse</strong> than live by ' + fmtRupee(dPnl) + ' (improved ' + simBetter + ', regressed ' + simWorse + ').';

  let html = headerLine;
  html += '<div class="cmp-grid">' + colSnapshot + colSim + colDelta + '</div>';
  html += '<div class="muted" style="margin-top:10px;">' + verdict + '</div>';

  // Per-session breakdown
  html += '<table class="range-table"><thead><tr><th>Date</th><th>Strategy</th><th>Session ID</th><th class="num">Live P&L</th><th class="num">Trades</th><th class="num">Replay P&L</th><th class="num">Trades</th><th class="num">Δ P&L</th><th class="num">Δ Trades</th></tr></thead><tbody>';
  for (const r of rows) {
    const bOk = r.baseline && r.baseline.ok;
    const sOk = r.sim && r.sim.ok;
    const bPnl = bOk ? (r.baseline.sessionPnl || 0) : null;
    const sPnl = sOk ? (r.sim.sessionPnl      || 0) : null;
    const bTrd = bOk ? (r.baseline.tradeCount || 0) : null;
    const sTrd = sOk ? (r.sim.tradeCount      || 0) : null;
    const dP = (bOk && sOk) ? cmpDelta(bPnl, sPnl) : null;
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
  const totalsLabel = hasBaseline
    ? 'Totals (' + bothOkCount + ' compared / ' + sOkCount + ' replayed)'
    : 'Totals (' + sOkCount + ' replayed, no baseline)';
  html += '<tr class="totals">' +
    '<td colspan="3">' + totalsLabel + '</td>' +
    '<td class="num">' + (hasBaseline ? (totBPnl >= 0 ? '+' : '') + '₹' + totBPnl.toFixed(2) : '–') + '</td>' +
    '<td class="num">' + (hasBaseline ? totBTrd : '–') + '</td>' +
    '<td class="num">' + (totSPnl >= 0 ? '+' : '') + '₹' + totSPnl.toFixed(2) + '</td>' +
    '<td class="num">' + totSTrd + '</td>' +
    '<td class="num ' + (hasDelta ? deltaClass(dPnl) : '') + '">' + (hasDelta ? fmtRupee(dPnl) : '–') + '</td>' +
    '<td class="num ' + (hasDelta ? deltaClass(dTrd) : '') + '">' + (hasDelta ? ((dTrd > 0 ? '+' : '') + dTrd) : '–') + '</td>' +
  '</tr>';
  html += '</tbody></table>';

  // Per-session candlestick chart + clean trade table (same as the per-row
  // single-session result). Single ok session → expanded + drawn immediately;
  // multiple → collapsed, each chart drawn lazily on first expand.
  _rangeChartData = {};
  const okRows = rows.filter(r => r.sim && r.sim.ok);
  const drawNow = [];
  let chartsHtml = '';
  rows.forEach((r, idx) => {
    if (!r.sim || !r.sim.ok) return;
    const cid = 'rng-chart-' + idx;
    const cd = r.sim.chartData;
    const hasChart = cd && Array.isArray(cd.candles) && cd.candles.length;
    const trades = r.sim.sessionTrades || [];
    if (hasChart) _rangeChartData[cid] = cd;
    const open = okRows.length === 1;
    const inner =
      (hasChart ? '<div class="replay-chart" id="' + cid + '"></div>'
                : '<div class="muted" style="margin-top:10px;">No chart data for this session.</div>') +
      (trades.length ? '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;"><span class="muted">Replay trades (' + trades.length + ')</span>' +
                        '<button class="row-btn" onclick="openReplayReportSession(' + idx + ')" title="Contract note for this session">📄 Report</button></div>' + renderTradesTable(trades)
                     : '<div class="muted" style="margin-top:10px;">No trades.</div>');
    chartsHtml +=
      '<details class="sess-chart"' + (open ? ' open' : '') + ' ontoggle="lazyDrawSessionChart(this,\\'' + cid + '\\')">' +
        '<summary class="muted">' + r.session.date + ' · ' + r.session.mode + ' — chart + trades</summary>' +
        inner +
      '</details>';
    if (open && hasChart) drawNow.push(cid);
  });
  if (chartsHtml) {
    html += '<div style="margin-top:16px;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;color:#94a3b8;">Per-session charts</div>' + chartsHtml;
  }

  el.innerHTML = html;

  // Draw the auto-opened single-session chart now that the DOM exists.
  for (const cid of drawNow) {
    const cel = document.getElementById(cid);
    if (cel) { cel.dataset.drawn = '1'; requestAnimationFrame(() => drawReplayChart(cel, _rangeChartData[cid])); }
  }
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
    const pill = mode === 'all' ? 'all strategies' : mode;
    document.getElementById('range-result').innerHTML =
      '<div style="margin-bottom:10px;font-size:0.9rem;">Strategy: <span class="tag ' +
        modeTag(mode) +
        '">' + pill + '</span> <span class="muted">(' + modeLabel + ')</span></div>' +
      '<div class="muted">No recorded ' + pill + ' sessions found between ' + from + ' and ' + to + '.</div>';
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
  _cancelRequested = false;
  // Reveal the Cancel button (signals the server to stop the in-flight
  // session mid-stream). Hide the prior run's Copy/Download buttons — they
  // belong to stale results until this run produces fresh ones.
  const cancelBtn = document.getElementById('range-cancel-btn');
  if (cancelBtn) {
    cancelBtn.style.display = '';
    cancelBtn.disabled = false;
    cancelBtn.textContent = '✕ Cancel';
  }
  const diagBtnsStart = document.getElementById('range-diag-btns');
  if (diagBtnsStart) { diagBtnsStart.style.display = 'none'; diagBtnsStart.innerHTML = ''; }
  refreshPreflight(); // flip banner to neutral "in progress" immediately
  const progress = document.getElementById('range-progress');
  const resultDiv = document.getElementById('range-result');
  progress.style.display = 'block';
  progress.className = 'rp-block';
  resultDiv.innerHTML = '';
  document.getElementById('range-card').scrollIntoView({ behavior: 'smooth', block: 'start' });

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
  let _curDate = '';
  let _curIdx  = 0;
  const renderProgress = () => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const pct = sessions.length ? Math.min(100, (_curIdx / sessions.length) * 100) : 0;
    progress.innerHTML =
      '<div class="rp-row">' +
        '<span class="rp-spinner"></span>' +
        '<span class="rp-current">Processing ' + (_curDate || '…') + '</span>' +
        '<span class="rp-counter">' + _curIdx + ' / ' + sessions.length + '</span>' +
      '</div>' +
      '<div class="rp-bar"><div class="rp-bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
      '<div class="rp-elapsed">' + elapsed + 's elapsed</div>';
  };
  renderProgress();
  const progressTimer = setInterval(renderProgress, 1000);

  let cancelled = false;
  try {
  for (let i = 0; i < sessions.length; i++) {
    if (_cancelRequested) { cancelled = true; break; }
    const s = sessions[i];
    const idx = i + 1;

    _curDate = s.date;
    _curIdx  = idx;
    renderProgress();
    let sim = null;
    try {
      sim = await callReplayApi(s.date, s.mode, s.sessionId, useCurrentSettings);
    } catch (e) {
      sim = { ok: false, error: e.message };
    }
    if (isPreflightReject(sim)) { aborted = true; showBlockAlert(sim.error); break; }
    // Server stopped this session mid-stream in response to Cancel — don't
    // render a partial row; just mark the batch cancelled and stop.
    if (sim && sim.cancelled) { cancelled = true; break; }

    const baseline = (sim && sim.ok && sim.canonical) ? {
      ok: true,
      mode: sim.mode,
      sessionId: sim.sessionId,
      sessionPnl: sim.canonical.pnl,
      tradeCount: sim.canonical.tradeCount,
      sessionTrades: sim.canonical.trades || [],
      _baselineFromCanonical: true,
    } : { ok: false, error: 'No canonical paper-trade record found for this session' };

    rows.push({ session: s, baseline, sim });
    // Live partial render after each session so the user sees results stream in.
    renderRangeResult(rows, context);
  }
  } finally {
    clearInterval(progressTimer);
  }

  // After the run, attach Copy + Download buttons so the user can share
  // the exact trades + activity log when something looks off. Download is
  // useful when the diagnostic is too big to paste (long activity logs,
  // multi-day ranges with option-tick windows).
  if (rows.length > 0) {
    const btnRow = document.getElementById('range-diag-btns');
    btnRow.innerHTML = '';
    btnRow.style.display = 'flex';
    const reportBtn = document.createElement('button');
    reportBtn.className = 'copy-btn';
    reportBtn.textContent = '📄 Report (all)';
    reportBtn.title = 'Contract note (gross, charges, net P&L) across the whole range';
    reportBtn.onclick = () => openReplayReportAll();
    btnRow.appendChild(reportBtn);
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
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  const finalIcon = aborted ? '⛔' : cancelled ? '🛑' : '✅';
  const finalText = aborted
    ? 'Aborted at session ' + (rows.length + 1) + '/' + sessions.length + ' — a paper or live session was started during the run.'
    : cancelled
    ? 'Cancelled — ' + rows.length + ' of ' + sessions.length + ' sessions completed.'
    : 'Done — ' + sessions.length + ' sessions completed.';
  progress.className = 'rp-block ' + (aborted || cancelled ? 'rp-cancelled' : 'rp-done');
  progress.innerHTML =
    '<div class="rp-row">' +
      '<span style="font-size:1rem;">' + finalIcon + '</span>' +
      '<span class="rp-current">' + finalText + '</span>' +
      '<span class="rp-counter">' + rows.length + ' / ' + sessions.length + '</span>' +
    '</div>' +
    '<div class="rp-bar"><div class="rp-bar-fill" style="width:' + ((rows.length / Math.max(1, sessions.length)) * 100).toFixed(1) + '%"></div></div>' +
    '<div class="rp-elapsed">' + total + 's total</div>';
  const cancelBtnEnd = document.getElementById('range-cancel-btn');
  if (cancelBtnEnd) cancelBtnEnd.style.display = 'none';
  btn.disabled = false;
  btn.textContent = btnRestoreText || _origBtnText;
  _myReplayRunning = false;
  _cancelRequested = false;
  refreshPreflight(); // flip banner back to green/red authoritative state
  refreshSettingsSourceUi();
}

// Cancel a running batch. Signals the server to stop the in-flight session
// mid-stream (it squares off via /stop and returns), and sets the local flag
// so the batch loop won't start the next session.
function cancelRange(btn) {
  _cancelRequested = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '🛑 Cancelling…';
  }
  // Fire-and-forget — the in-flight callReplayApi promise resolves once the
  // server breaks its tick loop and finalises, which unblocks the batch.
  fetch('/replay/cancel', { method: 'POST' }).catch(() => {});
}

// Seed inputs with empty constraints first so the elements are usable
// before the fetch completes; will be re-set once /replay/list returns.
setRangeDefaults();
refreshPreflight();
refreshSettingsSourceUi();
loadSessions();
setInterval(refreshPreflight, 5000);

// React when the user toggles the Settings source radio
const _settingsSourceSel = document.getElementById('settings-source');
if (_settingsSourceSel) _settingsSourceSel.addEventListener('change', refreshSettingsSourceUi);

// Local-date YYYY-MM-DD (not UTC) so "today" is correct in IST near midnight.
function _localDateStr(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Translate a quick-range shortcut into From/To dates, push them into the
// filter + the date inputs, and re-render. Empty value clears the range.
function applySessDateShortcut(val) {
  const fromEl = document.getElementById('sess-filter-from');
  const toEl   = document.getElementById('sess-filter-to');
  const now = new Date();
  let from = null, to = null;
  if (val === 'today')        { from = new Date(now); to = new Date(now); }
  else if (val === 'yesterday') { const y = new Date(now); y.setDate(y.getDate() - 1); from = y; to = new Date(y); }
  else if (val === 'week')    { const s = new Date(now); s.setDate(now.getDate() - ((now.getDay() + 6) % 7)); from = s; to = new Date(now); }
  else if (val === 'month')   { from = new Date(now.getFullYear(), now.getMonth(), 1); to = new Date(now); }
  else if (val === 'year')    { from = new Date(now.getFullYear(), 0, 1); to = new Date(now); }
  const f = from ? _localDateStr(from) : '';
  const t = to ? _localDateStr(to) : '';
  _sessFilter.dateFrom = f; _sessFilter.dateTo = t;
  if (fromEl) fromEl.value = f;
  if (toEl)   toEl.value = t;
  _sessFilter.page = 1;
  renderSessions();
}

// Wire Recorded-sessions toolbar inputs to filter + re-render in place.
(function wireSessionsToolbar() {
  const modeSel  = document.getElementById('sess-filter-mode');
  const search   = document.getElementById('sess-filter-search');
  const perPage  = document.getElementById('sess-per-page');
  const dateFrom = document.getElementById('sess-filter-from');
  const dateTo   = document.getElementById('sess-filter-to');
  const rangeSel = document.getElementById('sess-filter-range');
  if (modeSel) modeSel.addEventListener('change', () => {
    _sessFilter.mode = modeSel.value; _sessFilter.page = 1; renderSessions();
  });
  if (rangeSel) rangeSel.addEventListener('change', () => applySessDateShortcut(rangeSel.value));
  // Manual edits to either date input fall back to a custom range, so reset
  // the shortcut select to "Any date" to avoid a misleading label.
  if (dateFrom) dateFrom.addEventListener('change', () => {
    _sessFilter.dateFrom = dateFrom.value; if (rangeSel) rangeSel.value = ''; _sessFilter.page = 1; renderSessions();
  });
  if (dateTo) dateTo.addEventListener('change', () => {
    _sessFilter.dateTo = dateTo.value; if (rangeSel) rangeSel.value = ''; _sessFilter.page = 1; renderSessions();
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
  // Default the Recorded-sessions list to today's sessions.
  applySessDateShortcut('today');
})();
</script>
<script>${modalJS()}</script>
${contractNoteModalHTML()}
<script>
${contractNoteClientJS()}
// Replay-specific Report wrappers. renderRangeResult / renderComparison stash
// the currently-displayed trades here so a Report click can build the note.
var _CN_RANGE_ROWS = [], _CN_RANGE_CTX = null;
var _CN_SINGLE_TRADES = null, _CN_SINGLE_LABEL = '';
function _cnModeLabel(m){
  return m==='all'?'All Strategies':m==='swing-paper'?'Swing Paper':m==='scalp-paper'?'Scalp Paper':m==='pa-paper'?'PA Paper':m==='orb-paper'?'ORB Paper':m==='straddle-paper'?'Straddle Paper':(m||'Replay');
}
function openReplayReportAll(){
  var trades=[]; for(var i=0;i<_CN_RANGE_ROWS.length;i++){ var r=_CN_RANGE_ROWS[i]; if(r&&r.sim&&r.sim.ok&&r.sim.sessionTrades) trades=trades.concat(r.sim.sessionTrades); }
  var ctx=_CN_RANGE_CTX||{}; var label=_cnModeLabel(ctx.mode);
  var sub='Replay '+(ctx.from||'')+' → '+(ctx.to||'')+' · '+trades.length+' trade'+(trades.length!==1?'s':'');
  openContractNoteFor(label+' — Replay Contract Note', sub, trades, label.replace(/\\s+/g,'-').toLowerCase()+'-replay-'+(ctx.from||'')+'_'+(ctx.to||''));
}
function openReplayReportSession(idx){
  var r=_CN_RANGE_ROWS[idx]; if(!r||!r.sim||!r.sim.sessionTrades) return;
  var trades=r.sim.sessionTrades, label=_cnModeLabel(r.session&&r.session.mode);
  var d=r.session&&r.session.date?String(r.session.date).slice(0,10):'';
  var sub='Replay '+d+' · '+trades.length+' trade'+(trades.length!==1?'s':'');
  openContractNoteFor(label+' — Replay Contract Note', sub, trades, label.replace(/\\s+/g,'-').toLowerCase()+'-replay-'+(d||('session-'+idx)));
}
function openReplaySingleReport(){
  var trades=_CN_SINGLE_TRADES||[];
  var sub='Replay · '+trades.length+' trade'+(trades.length!==1?'s':'');
  openContractNoteFor((_CN_SINGLE_LABEL||'Replay')+' — Replay Contract Note', sub, trades, (_CN_SINGLE_LABEL||'replay').replace(/\\s+/g,'-').toLowerCase()+'-replay');
}
</script>
</body></html>`;
  res.send(html);
});

module.exports = router;

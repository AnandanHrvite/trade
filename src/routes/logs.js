/**
 * logs.js — Live log viewer route
 * ────────────────────────────────────────────────────────────
 * GET  /logs           → Full log viewer UI page
 * GET  /logs/stream    → SSE endpoint (live log feed)
 * GET  /logs/export    → Download all logs as .txt
 * GET  /logs/export-json → Download all logs as .json
 * POST /logs/clear     → Clear in-memory log store
 */

const express  = require("express");
const router   = express.Router();
const { logStore, logEvents } = require("../services/logger");
const sharedSocketState = require("../utils/sharedSocketState");

// ── SSE — live log stream ─────────────────────────────────────────────────────
router.get("/stream", (req, res) => {
  res.setHeader("Content-Type",        "text/event-stream");
  res.setHeader("Cache-Control",       "no-cache");
  res.setHeader("Connection",          "keep-alive");
  res.setHeader("X-Accel-Buffering",   "no"); // prevent nginx buffering
  res.flushHeaders();

  // Send ALL stored entries immediately on connect so page shows full history
  const history = logStore.slice(-2000);
  res.write(`data: ${JSON.stringify({ type: "history", logs: history })}\n\n`);

  // Then stream each new log as it arrives
  const onLog = (entry) => {
    res.write(`data: ${JSON.stringify({ type: "log", log: entry })}\n\n`);
  };

  logEvents.on("log", onLog);

  // Clean up when browser disconnects
  req.on("close", () => logEvents.off("log", onLog));
});

// ── Export as plain text ──────────────────────────────────────────────────────
router.get("/export", (req, res) => {
  const lines = logStore
    .map(e => `[${e.date} ${e.time}] [${e.level.padEnd(5)}] ${e.msg}`)
    .join("\n");
  const filename = `trading-bot-logs-${new Date().toISOString().slice(0, 10)}.txt`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(lines || "No logs yet.");
});

// ── Export as JSON ────────────────────────────────────────────────────────────
router.get("/export-json", (req, res) => {
  const filename = `trading-bot-logs-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/json");
  res.json(logStore);
});

// ── Clear log store ───────────────────────────────────────────────────────────
router.post("/clear", (req, res) => {
  logStore.length = 0;
  console.log("🧹 Log store cleared by user via /logs/clear");
  res.json({ success: true, message: "Log store cleared." });
});

// ── Logs UI page ──────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";
  const liveBanner = liveActive
    ? `<span style="display:flex;align-items:center;gap:5px;font-size:0.68rem;font-weight:700;color:#ef4444;background:#2d0a0a;border:1px solid #7f1d1d;padding:3px 10px;border-radius:5px;white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:#ef4444;display:inline-block;animation:ltpulse 1.2s infinite;"></span>LIVE ACTIVE</span>`
    : "";
  const disabledLink = (label) =>
    `<span title="Disabled — Live trade is running" style="font-size:0.76rem;color:#2a3446;padding:6px 12px;border-radius:6px;border:1px solid transparent;white-space:nowrap;cursor:not-allowed;opacity:0.38;">🔒 ${label}</span>`;
  const btLink  = liveActive ? disabledLink("🔍 Backtest") : `<a href="/backtest" style="font-size:0.76rem;color:#6b7a99;text-decoration:none;padding:6px 12px;border-radius:6px;border:1px solid transparent;white-space:nowrap;">🔍 Backtest</a>`;
  const ptLink  = liveActive ? disabledLink("📋 Paper")    : `<a href="/paperTrade/status" style="font-size:0.76rem;color:#6b7a99;text-decoration:none;padding:6px 12px;border-radius:6px;border:1px solid transparent;white-space:nowrap;">📋 Paper</a>`;
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <title>Logs — Trading BOT</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    html, body { height:100%; }
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; display:flex; flex-direction:column; height:100vh; overflow:hidden; }

    /* ── NAV ── */
    nav { display:flex; align-items:center; justify-content:space-between; padding:10px 24px; border-bottom:1px solid #1a2236; background:#0d1320; flex-shrink:0; flex-wrap:wrap; gap:6px; }
    .brand { font-size:0.92rem; font-weight:700; color:#fff; white-space:nowrap; }
    .brand span { color:#3b82f6; }
    .nav-links { display:flex; gap:4px; flex-wrap:wrap; }
    .nav-links a { font-size:0.76rem; color:#6b7a99; text-decoration:none; padding:6px 12px; border-radius:6px; border:1px solid transparent; white-space:nowrap; }
    .nav-links a:hover { color:#c8d8f0; background:#161b22; border-color:#1a2236; }
    .nav-links a.active { color:#3b82f6; background:#0a1e3d; border-color:#1d3b6e; }

    /* ── TOOLBAR ── */
    .toolbar { display:flex; align-items:center; gap:8px; padding:8px 16px; background:#0d1320; border-bottom:1px solid #1a2236; flex-shrink:0; flex-wrap:wrap; }
    .tb-left  { display:flex; align-items:center; gap:8px; flex:1; flex-wrap:wrap; }
    .tb-right { display:flex; align-items:center; gap:6px; flex-shrink:0; flex-wrap:wrap; }

    /* Live badge */
    .badge-live { display:flex; align-items:center; gap:5px; font-size:0.62rem; font-weight:700; color:#10b981; background:#06180e; border:1px solid #0a3018; padding:3px 8px; border-radius:4px; white-space:nowrap; }
    .dot { width:6px; height:6px; border-radius:50%; background:#10b981; animation:blink 1.2s infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.25} }

    .counter { font-size:0.65rem; color:#3a5070; background:#0a0e18; border:1px solid #1a2236; padding:3px 9px; border-radius:4px; white-space:nowrap; }

    /* Filter pills */
    .filters { display:flex; gap:4px; flex-wrap:wrap; }
    .fp { font-size:0.6rem; font-weight:700; padding:3px 9px; border-radius:4px; border:1px solid; cursor:pointer; letter-spacing:0.5px; transition:opacity 0.15s; user-select:none; }
    .fp[data-level="ALL"]   { background:#1a2236; border-color:#2a3446; color:#c8d8f0; }
    .fp[data-level="LOG"]   { background:#071428; border-color:#0e2850; color:#60a5fa; }
    .fp[data-level="INFO"]  { background:#072014; border-color:#0e4020; color:#34d399; }
    .fp[data-level="WARN"]  { background:#1a1200; border-color:#403000; color:#fbbf24; }
    .fp[data-level="ERROR"] { background:#200708; border-color:#401018; color:#f87171; }
    .fp.off { opacity:0.28; }

    #search { background:#0d1320; border:1px solid #1a2236; color:#c8d8f0; padding:4px 10px; border-radius:5px; font-size:0.72rem; font-family:inherit; outline:none; width:200px; }
    #search:focus { border-color:#3b82f6; }
    #search::placeholder { color:#2a4060; }

    .btn { font-size:0.7rem; font-weight:600; padding:4px 11px; border-radius:5px; border:1px solid; cursor:pointer; font-family:inherit; text-decoration:none; display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
    .btn-scroll  { background:#0d1320; border-color:#1a2236; color:#4a6080; }
    .btn-scroll.on { border-color:#3b82f6; color:#3b82f6; background:#071428; }
    .btn-export  { background:#071428; border-color:#0e2850; color:#60a5fa; }
    .btn-exportj { background:#060a14; border-color:#0e1a28; color:#818cf8; }
    .btn-clear   { background:#180508; border-color:#401018; color:#f87171; }

    /* ── LOG AREA ── */
    .log-wrap { flex:1; overflow-y:auto; font-family:'IBM Plex Mono',monospace; font-size:0.71rem; line-height:1.65; }
    .log-wrap::-webkit-scrollbar { width:5px; }
    .log-wrap::-webkit-scrollbar-track { background:#080c14; }
    .log-wrap::-webkit-scrollbar-thumb { background:#1a2236; border-radius:3px; }

    .log-row { display:flex; align-items:flex-start; padding:2px 14px; border-bottom:1px solid transparent; transition:background 0.08s; }
    .log-row:hover { background:#0d1320; }
    .log-row.hidden { display:none !important; }

    .log-row[data-level="WARN"]  { background:#080700; }
    .log-row[data-level="WARN"]:hover  { background:#0d0e00; }
    .log-row[data-level="ERROR"] { background:#0a0408; }
    .log-row[data-level="ERROR"]:hover { background:#100508; }

    .log-time { color:#1e3050; min-width:78px; flex-shrink:0; padding-top:1px; }
    .log-lvl  { min-width:46px; flex-shrink:0; font-weight:700; padding:0 6px; padding-top:1px; }
    .log-msg  { color:#c8d8f0; white-space:pre-wrap; word-break:break-all; flex:1; }

    .lvl-LOG   { color:#60a5fa; }
    .lvl-INFO  { color:#34d399; }
    .lvl-WARN  { color:#fbbf24; }
    .lvl-ERROR { color:#f87171; }

    .empty-state { text-align:center; padding:80px 24px; color:#1e3050; font-size:0.8rem; }

    /* ── MOBILE — switch from fixed-height flex to normal scroll ── */
    @media (max-width:640px) {
      html, body { height:auto; }
      body { display:block; height:auto; overflow-x:hidden; }
      nav { padding:8px 12px; }
      .brand { font-size:0.8rem; }
      .nav-links a { font-size:0.7rem; padding:5px 8px; }
      .toolbar { padding:6px 10px; }
      #search { width:100%; }
      .tb-right { width:100%; justify-content:flex-start; }
      .log-wrap { overflow-y:auto; height:70vh; min-height:400px; }
      .log-row { padding:2px 8px; }
      .log-time { min-width:58px; font-size:0.62rem; }
      .log-lvl  { min-width:36px; font-size:0.62rem; }
      .log-msg  { font-size:0.65rem; }
    }
    .empty-state .icon { font-size:2rem; margin-bottom:12px; }
  </style>
</head>
<body>

<nav>
  <div class="brand">🪔 Palani Andawar thunai — <span>Trading BOT</span></div>
  <div class="nav-links">
    <a href="/" style="font-size:0.76rem;color:#6b7a99;text-decoration:none;padding:6px 12px;border-radius:6px;border:1px solid transparent;white-space:nowrap;">Dashboard</a>
    ${btLink}
    ${ptLink}
    <a href="/trade/status" style="font-size:0.76rem;color:#6b7a99;text-decoration:none;padding:6px 12px;border-radius:6px;border:1px solid transparent;white-space:nowrap;">🔴 Live</a>
    <a href="/logs" class="active" style="font-size:0.76rem;color:#3b82f6;text-decoration:none;padding:6px 12px;border-radius:6px;border:1px solid #1d3b6e;background:#0a1e3d;white-space:nowrap;">📜 Logs</a>
    ${liveBanner}
    <style>@keyframes ltpulse{0%,100%{opacity:1}50%{opacity:.25}}</style>
  </div>
</nav>

<div class="toolbar">
  <div class="tb-left">
    <span class="badge-live"><span class="dot"></span>LIVE</span>
    <span class="counter" id="count">0 entries</span>
    <div class="filters">
      <span class="fp" data-level="ALL"   onclick="setFilter(this)">ALL</span>
      <span class="fp off" data-level="LOG"   onclick="setFilter(this)">LOG</span>
      <span class="fp off" data-level="INFO"  onclick="setFilter(this)">INFO</span>
      <span class="fp off" data-level="WARN"  onclick="setFilter(this)">WARN</span>
      <span class="fp off" data-level="ERROR" onclick="setFilter(this)">ERROR</span>
    </div>
    <input id="search" type="text" placeholder="Search logs…" oninput="applySearch()"/>
  </div>
  <div class="tb-right">
    <button class="btn btn-scroll on" id="scrollBtn" onclick="toggleScroll()">📌 Auto-scroll</button>
    <a href="/logs/export"       class="btn btn-export">⬇ TXT</a>
    <a href="/logs/export-json"  class="btn btn-exportj">⬇ JSON</a>
    <button class="btn btn-clear" onclick="clearLogs()">🗑 Clear</button>
  </div>
</div>

<div class="log-wrap" id="logWrap">
  <div class="empty-state" id="emptyState">
    <div class="icon">⏳</div>
    Connecting to log stream…
  </div>
</div>

<script>
  var autoScroll   = true;
  var activeFilter = "ALL";
  var searchTerm   = "";
  var totalVisible = 0;
  var totalAll     = 0;

  var wrap      = document.getElementById("logWrap");
  var emptyEl   = document.getElementById("emptyState");
  var countEl   = document.getElementById("count");
  var scrollBtn = document.getElementById("scrollBtn");

  // ── SSE connection with auto-reconnect ──────────────────────────────────────
  function connect() {
    var es = new EventSource("/logs/stream");

    es.onmessage = function(e) {
      var data = JSON.parse(e.data);
      if (data.type === "history") {
        if (emptyEl) { emptyEl.remove(); emptyEl = null; }
        data.logs.forEach(addRow);
      } else if (data.type === "log") {
        if (emptyEl) { emptyEl.remove(); emptyEl = null; }
        addRow(data.log);
      }
    };

    es.onerror = function() {
      es.close();
      setTimeout(connect, 3000); // reconnect in 3s
    };
  }

  // ── Add a single log row ────────────────────────────────────────────────────
  function addRow(entry) {
    totalAll++;

    var row = document.createElement("div");
    row.className         = "log-row";
    row.dataset.level     = entry.level;
    row.dataset.msg       = (entry.msg || "").toLowerCase();

    var visible = matchFilter(entry.level) && matchSearch(row.dataset.msg);
    if (!visible) row.classList.add("hidden");
    else          totalVisible++;

    row.innerHTML =
      '<span class="log-time">' + escHtml(entry.time) + '</span>' +
      '<span class="log-lvl lvl-' + entry.level + '">' + entry.level + '</span>' +
      '<span class="log-msg">'  + escHtml(entry.msg  || "") + '</span>';

    wrap.appendChild(row);
    updateCount();

    if (autoScroll && visible) wrap.scrollTop = wrap.scrollHeight;
  }

  // ── Filter helpers ──────────────────────────────────────────────────────────
  function matchFilter(level) { return activeFilter === "ALL" || activeFilter === level; }
  function matchSearch(msg)   { return !searchTerm || msg.indexOf(searchTerm) !== -1; }

  function setFilter(el) {
    activeFilter = el.dataset.level;
    document.querySelectorAll(".fp").forEach(function(f) {
      f.classList.toggle("off", f !== el);
    });
    reapply();
  }

  function applySearch() {
    searchTerm = document.getElementById("search").value.toLowerCase().trim();
    reapply();
  }

  function reapply() {
    totalVisible = 0;
    document.querySelectorAll(".log-row").forEach(function(row) {
      var show = matchFilter(row.dataset.level) && matchSearch(row.dataset.msg);
      row.classList.toggle("hidden", !show);
      if (show) totalVisible++;
    });
    updateCount();
    if (autoScroll) wrap.scrollTop = wrap.scrollHeight;
  }

  function updateCount() {
    if (activeFilter === "ALL" && !searchTerm) {
      countEl.textContent = totalAll + " entries";
    } else {
      countEl.textContent = totalVisible + " of " + totalAll + " entries";
    }
  }

  // ── Auto-scroll ─────────────────────────────────────────────────────────────
  function toggleScroll() {
    autoScroll = !autoScroll;
    scrollBtn.classList.toggle("on", autoScroll);
    if (autoScroll) wrap.scrollTop = wrap.scrollHeight;
  }

  // Pause auto-scroll if user manually scrolls up
  wrap.addEventListener("scroll", function() {
    var atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 50;
    if (!atBottom && autoScroll) {
      autoScroll = false;
      scrollBtn.classList.remove("on");
    }
  });

  // ── Clear ───────────────────────────────────────────────────────────────────
  function clearLogs() {
    if (!confirm("Clear all logs from memory? (This cannot be undone)")) return;
    fetch("/logs/clear", { method: "POST" }).then(function() {
      wrap.innerHTML = '<div class="empty-state"><div class="icon">🧹</div>Logs cleared — new entries will appear below.</div>';
      emptyEl    = null;
      totalAll   = 0;
      totalVisible = 0;
      updateCount();
    });
  }

  // ── Escape HTML ─────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  connect();
</script>
</body>
</html>`);
});

module.exports = router;
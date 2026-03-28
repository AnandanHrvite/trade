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
const { buildSidebar, sidebarCSS } = require("../utils/sharedNav");

// ── SSE — live log stream (kept for clients that support it) ─────────────────
router.get("/stream", (req, res) => {
  res.setHeader("Content-Type",        "text/event-stream");
  res.setHeader("Cache-Control",       "no-cache");
  res.setHeader("Connection",          "keep-alive");
  res.setHeader("X-Accel-Buffering",   "no");
  res.flushHeaders();

  const history = logStore;
  res.write(`data: ${JSON.stringify({ type: "history", logs: history })}\n\n`);

  const onLog = (entry) => {
    res.write(`data: ${JSON.stringify({ type: "log", log: entry })}\n\n`);
  };

  logEvents.on("log", onLog);
  req.on("close", () => logEvents.off("log", onLog));
});

// ── Polling endpoint — reliable fallback (works with self-signed certs) ───────
// Returns logs since a given index. Client polls every 2s.
// GET /logs/data?from=0 → returns all logs from index 0 onwards
router.get("/data", (req, res) => {
  const total  = logStore.length;
  const limit  = Math.min(parseInt(req.query.limit || "100", 10), 500);

  // "from" can mean two things:
  //   - live poll: from=N → fetch logs[N..N+limit] (new entries since last poll)
  //   - load-older: from=N where N is the start of the oldest chunk already loaded
  const from   = parseInt(req.query.from || "0", 10);
  const slice  = from < total ? logStore.slice(from, from + limit) : [];
  const hasMore = (from + limit) < total;

  res.json({ total, from, limit, logs: slice, hasMore });
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
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; }
    ${sidebarCSS()}

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
<div class="app-shell">
${buildSidebar('logs', liveActive)}
<div class="main-content" style="display:flex;flex-direction:column;height:100vh;overflow:hidden;">

<div class="top-bar">
  <div>
    <div class="top-bar-title">📜 Activity Logs</div>
    <div class="top-bar-meta">Live SSE stream · all console output · ${liveActive ? '<span style="color:#ef4444;">LIVE TRADE ACTIVE</span>' : 'idle'}</div>
  </div>
  <div class="top-bar-right">
    ${liveActive ? '<span class="top-bar-badge live-active"><span style="width:5px;height:5px;border-radius:50%;background:#ef4444;display:inline-block;"></span>LIVE</span>' : '<span class="top-bar-badge">● IDLE</span>'}
  </div>
</div>

<div class="toolbar" style="display:flex;align-items:center;gap:8px;padding:8px 16px;background:#040c18;border-bottom:1px solid #0e1e36;flex-shrink:0;flex-wrap:wrap;">
  <div class="tb-left" style="display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap;">
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
  <div class="tb-right" style="display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap;">
    <button class="btn btn-scroll on" id="scrollBtn" onclick="toggleScroll()">📌 Auto-scroll</button>
    <a href="/logs/export"       class="btn btn-export">⬇ TXT</a>
    <a href="/logs/export-json"  class="btn btn-exportj">⬇ JSON</a>
    <button class="btn btn-clear" onclick="clearLogs()">🗑 Clear</button>
  </div>
</div>

<div id="olderBanner" style="display:none;text-align:center;padding:7px 16px;background:#040c18;border-bottom:1px solid #0e1e36;flex-shrink:0;">
  <button class="btn btn-export" id="olderBtn" onclick="loadOlder()" style="font-size:0.66rem;">⬆ Load older logs</button>
  <span id="olderHint" style="font-size:0.62rem;color:#2a4060;margin-left:8px;"></span>
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

  // Pagination
  var PAGE         = 100;   // rows per page
  var liveFrom     = 0;     // cursor: newest log index received
  var oldestFrom   = 0;     // cursor: oldest chunk start (for load-older)
  var firstPoll    = true;
  var loadingOlder = false;

  var wrap      = document.getElementById("logWrap");
  var emptyEl   = document.getElementById("emptyState");
  var countEl   = document.getElementById("count");
  var scrollBtn = document.getElementById("scrollBtn");

  // ── Initial load: fetch latest PAGE rows, then poll for new ones every 2s ───
  // Server sends only 100 rows at a time. Older rows loaded on demand via
  // "Load older logs" button. This keeps initial DOM render near-instant.
  function init() {
    var total = 0;
    // Step 1: find total count first
    fetch("/logs/data?from=0&limit=1", { cache: "no-store" })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d) { startPoll(0); return; }
        total = d.total || 0;
        // Start from newest PAGE rows
        var startFrom = Math.max(0, total - PAGE);
        oldestFrom = startFrom; // oldest chunk we've loaded
        liveFrom   = total;     // live poll starts from here

        if (total === 0) {
          if (emptyEl) emptyEl.innerHTML = '<div class="icon">📋</div>No logs yet — start Paper Trade or Live Trade.';
          startPoll(0);
          return;
        }
        // Fetch the latest PAGE rows
        return fetch("/logs/data?from=" + startFrom + "&limit=" + PAGE, { cache: "no-store" })
          .then(function(r) { return r.json(); })
          .then(function(d2) {
            if (emptyEl) { emptyEl.remove(); emptyEl = null; }
            d2.logs.forEach(function(e) { addRow(e, false); }); // append to bottom
            liveFrom = d2.total;
            // Show "load older" if there are older logs
            updateOlderBanner(startFrom);
            startPoll(liveFrom);
            if (autoScroll) wrap.scrollTop = wrap.scrollHeight;
          });
      })
      .catch(function() {
        if (emptyEl) emptyEl.innerHTML = '<div class="icon">⚠️</div>Cannot reach server — retrying...';
        setTimeout(init, 4000);
      });
  }

  // ── Live poll: only fetches NEW rows since liveFrom ─────────────────────────
  function startPoll(from) {
    liveFrom = from;
    function poll() {
      fetch("/logs/data?from=" + liveFrom + "&limit=" + PAGE, { cache: "no-store" })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(d) {
          if (d && d.logs && d.logs.length > 0) {
            if (emptyEl) { emptyEl.remove(); emptyEl = null; }
            d.logs.forEach(function(e) { addRow(e, true); }); // true = live (auto-scroll)
            liveFrom = d.total;
          }
          setTimeout(poll, 2000);
        })
        .catch(function() { setTimeout(poll, 5000); });
    }
    poll();
  }

  // ── Load older: prepend previous PAGE rows above current view ───────────────
  function loadOlder() {
    if (loadingOlder || oldestFrom === 0) return;
    loadingOlder = true;
    var btn = document.getElementById("olderBtn");
    if (btn) { btn.textContent = "⏳ Loading..."; btn.disabled = true; }

    var fetchFrom = Math.max(0, oldestFrom - PAGE);
    fetch("/logs/data?from=" + fetchFrom + "&limit=" + (oldestFrom - fetchFrom), { cache: "no-store" })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var scrollH = wrap.scrollHeight;
        var scrollT = wrap.scrollTop;
        // Prepend rows (insert before first existing row)
        var frag = document.createDocumentFragment();
        d.logs.forEach(function(e) {
          var row = makeRow(e);
          frag.appendChild(row);
        });
        var firstRow = wrap.querySelector(".log-row");
        if (firstRow) wrap.insertBefore(frag, firstRow);
        else wrap.appendChild(frag);
        totalAll += d.logs.length;
        updateCount();
        // Keep scroll position stable (don't jump to top)
        wrap.scrollTop = scrollT + (wrap.scrollHeight - scrollH);
        oldestFrom = fetchFrom;
        updateOlderBanner(fetchFrom);
        loadingOlder = false;
      })
      .catch(function() { loadingOlder = false; });
  }

  function updateOlderBanner(fromIdx) {
    var banner = document.getElementById("olderBanner");
    var hint   = document.getElementById("olderHint");
    var btn    = document.getElementById("olderBtn");
    if (!banner) return;
    if (fromIdx > 0) {
      banner.style.display = "block";
      if (hint) hint.textContent = fromIdx + " older entries not shown";
      if (btn) { btn.textContent = "⬆ Load older logs"; btn.disabled = false; }
    } else {
      banner.style.display = "none";
    }
  }

  init();

  // ── Build a row DOM element (shared by addRow and loadOlder prepend) ─────────
  function makeRow(entry) {
    var row = document.createElement("div");
    row.className     = "log-row";
    row.dataset.level = entry.level;
    row.dataset.msg   = (entry.msg || "").toLowerCase();
    var visible = matchFilter(entry.level) && matchSearch(row.dataset.msg);
    if (!visible) row.classList.add("hidden");
    else          totalVisible++;
    row.innerHTML =
      '<span class="log-time">' + escHtml(entry.time) + '</span>' +
      '<span class="log-lvl lvl-' + entry.level + '">' + entry.level + '</span>' +
      '<span class="log-msg">'  + escHtml(entry.msg  || "") + '</span>';
    return row;
  }

  // ── Append a single row (used by live poll) ───────────────────────────────
  function addRow(entry, isLive) {
    totalAll++;
    var row = makeRow(entry);
    wrap.appendChild(row);
    updateCount();
    var visible = !row.classList.contains("hidden");
    if (isLive && autoScroll && visible) wrap.scrollTop = wrap.scrollHeight;
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

</script>
</div></div>
</body>
</html>`);
});

module.exports = router;
/**
 * Consolidation Report — a printable, DAILY consolidated report of every recorded
 * trade (paper + live), rendered as one table with a row per trading day.
 *
 * Mirrors the Telegram "CONSOLIDATED DAY REPORT" layout (per-strategy trades + P&L,
 * then Total / Wins / Losses / Win rate / Net P&L) but for every day at once, in a
 * table you can filter (Book + the shared sharedNav date range) and export to PDF.
 *
 * Reached via the "📑 Consolidation Report" button on the Edge Analytics page — it
 * is NOT a separate sidebar menu item. Read-only: loads the same per-strategy session
 * files that /consolidation (paper) + /live-consolidation (live) use, flattens them,
 * embeds the trade array, and computes everything client-side so filters recompute
 * instantly with no server round-trip.
 *
 * Export: "🖨 Save as PDF" prints the report through a dedicated @media print
 * stylesheet (sidebar / toolbar / buttons hidden, white page, page-break-safe table).
 * No external PDF library — the browser's native print-to-PDF is used.
 *
 * Gated by UI_SHOW_CONSOLIDATION_REPORT (Settings → Menu Visibility). No new data
 * is written.
 */
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { buildSidebar, sidebarCSS, faviconLink, enabledStrategies,
        dateRangeOptionsHTML, dateRangeJS,
        multiSelectCSS, multiSelectHTML, multiSelectJS } = require("../utils/sharedNav");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { VIX_SYMBOL } = require("../services/vixFilter");
const fyers = require("../config/fyers");
const { resolveTheme } = require("../utils/theme");

const _HOME = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");

// Per-day India VIX, fetched from Fyers daily candles (NSE:INDIAVIX-INDEX) — shown
// here regardless of whether any strategy's VIX filter is enabled, so it can't rely
// on vixAtEntry (that is only captured when a filter runs). One close per trading day.
// Cached in-memory keyed by the date span; TTL keeps today's still-forming close fresh.
const VIX_MAP_TTL_MS = 15 * 60 * 1000;
let _vixMapCache = null; // { from, to, ts, map, note }

function istTodayCR() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** @returns {Promise<{map: Object, note: string}>} — note explains an empty map */
async function loadVixByDate(fromDate, toDate) {
  const now = Date.now();
  if (_vixMapCache && _vixMapCache.from === fromDate && _vixMapCache.to === toDate
      && (now - _vixMapCache.ts) < VIX_MAP_TTL_MS) {
    return { map: _vixMapCache.map, note: _vixMapCache.note };
  }
  const map = {};
  let note = "";
  try {
    const candles = await fetchCandlesCachedBT(VIX_SYMBOL, "D", fromDate, toDate, false);
    for (const c of (candles || [])) {
      const d = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const close = Number(c.close);
      if (isFinite(close) && close > 0) map[d] = close;
    }
  } catch (err) {
    note = `VIX history fetch failed: ${err.message}`;
    console.warn(`[ConsolidationReport] ${note}`);
  }

  // Reaching here means the fetch neither threw nor returned rows. fetchChunk now
  // throws on any status that is not ok/no_data (an expired token included), so
  // that case lands in the catch above with a real message; what is left is a
  // genuine ok/no_data-with-nothing-in-it. Probe once to say which of the two.
  if (!Object.keys(map).length && !note) {
    try {
      const raw = await fyers.getHistory({
        symbol: VIX_SYMBOL, resolution: "D", date_format: "1",
        range_from: fromDate, range_to: toDate, cont_flag: "1",
      });
      const s = (raw && raw.s) || "error";
      note = s === "ok"      ? "Fyers returned no daily VIX candles for this range"
           : s === "no_data" ? "Fyers returned no_data for the daily VIX series — usually an expired Fyers token; log in to Fyers again and reload"
           : `Fyers ${s}: ${(raw && (raw.message || (raw.data && JSON.stringify(raw.data)))) || "no detail"}`;
    } catch (err) {
      note = `VIX history probe failed: ${err.message}`;
    }
    console.warn(`[ConsolidationReport] VIX daily fetch empty — ${note}`);
  }

  // Today's daily bar is not always stamped while the session is still running, so
  // fill the current day from the live quote. Uses getQuotes directly (not
  // vixFilter.fetchLiveVix) so a page view never writes a VIX tick into the
  // recorder — replay must see only the poll cadence the live engines produced.
  const today = istTodayCR();
  if (map[today] == null && toDate >= today) {
    try {
      const q = await fyers.getQuotes([VIX_SYMBOL]);
      const lp = q && q.s === "ok" && q.d && q.d[0] && q.d[0].v && q.d[0].v.lp;
      if (typeof lp === "number" && lp > 0) map[today] = lp;
    } catch (err) {
      console.warn(`[ConsolidationReport] live VIX quote failed: ${err.message}`);
    }
  }

  // Never cache an empty map — otherwise a fetch that failed on an expired token
  // keeps the column blank for 15 more minutes after the user logs back in.
  _vixMapCache = Object.keys(map).length ? { from: fromDate, to: toDate, ts: now, map, note } : null;
  return { map, note };
}

// Mirror the source maps used by consolidation.js (paper) + liveConsolidation.js (live).
const PAPER_SOURCES = [
  { mode: "EMA_RSI_ST", file: "ema_rsi_st_paper_trades.json" },
  { mode: "BB_RSI",     file: "bb_rsi_paper_trades.json" },
  { mode: "PA",         file: "pa_paper_trades.json" },
  { mode: "ORB",        file: "orb_paper_trades.json" },
  { mode: "EMA9VWAP",   file: "ema9vwap_paper_trades.json" },
  { mode: "TREND_PB",   file: "trend_pb_paper_trades.json" },
  { mode: "GAPS",       file: "gaps_paper_trades.json" },
  { mode: "TDS",        file: "trend_day_scalp_paper_trades.json" },
  { mode: "GAP3M",      file: "gap_fix_3m_paper_trades.json" },
  { mode: "HA_SCALP",   file: "ha_scalp_paper_trades.json" },
  { mode: "OIWF",       file: "oi_wall_fade_paper_trades.json" },
  { mode: "RSI_PIVOT_ST", file: "rsi_pivot_st_paper_trades.json" },
  { mode: "SIMPLE930", file: "simple930_paper_trades.json" },
];
const LIVE_SOURCES = [
  { mode: "EMA_RSI_ST", file: "ema_rsi_st_live_trades.json" },
  { mode: "BB_RSI",     file: "bb_rsi_live_trades.json" },
  { mode: "PA",         file: "pa_live_trades.json" },
  { mode: "ORB",        file: "orb_live_trades.json" },
  { mode: "EMA9VWAP",   file: "ema9vwap_live_trades.json" },
  { mode: "TREND_PB",   file: "trend_pb_live_trades.json" },
  { mode: "GAPS",       file: "gaps_live_trades.json" },
  { mode: "TDS",        file: "trend_day_scalp_live_trades.json" },
  { mode: "GAP3M",      file: "gap_fix_3m_live_trades.json" },
  { mode: "HA_SCALP",   file: "ha_scalp_live_trades.json" },
  { mode: "OIWF",       file: "oi_wall_fade_live_trades.json" },
  { mode: "RSI_PIVOT_ST", file: "rsi_pivot_st_live_trades.json" },
  { mode: "SIMPLE930", file: "simple930_live_trades.json" },
];

function safeRead(p) {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) { return {}; }
}

function loadBook(sources, book) {
  const out = [];
  for (const src of sources) {
    const data = safeRead(path.join(DATA_DIR, src.file));
    for (const s of (data.sessions || [])) {
      const sessionDate = String(s.date || "").slice(0, 10);
      for (const t of (s.trades || [])) {
        out.push({
          book,
          mode: src.mode,
          date: sessionDate,
          pnl:  Number(t.pnl) || 0,
        });
      }
    }
  }
  return out;
}

// Cache the flattened trade list — same approach as consolidation.js / edgeAnalytics.js.
// Invalidate by a cheap mtime+size signature so a new trade is picked up immediately.
let _cache = null;
let _sig   = null;
function _sourcesSig() {
  let sig = "";
  for (const src of [...PAPER_SOURCES, ...LIVE_SOURCES]) {
    try { const st = fs.statSync(path.join(DATA_DIR, src.file)); sig += `${src.mode}:${st.mtimeMs}:${st.size}|`; }
    catch (_) { sig += `${src.mode}:0|`; }
  }
  return sig;
}
function loadAllTrades() {
  const sig = _sourcesSig();
  if (_cache && sig === _sig) return _cache;
  const trades = loadBook(PAPER_SOURCES, "paper").concat(loadBook(LIVE_SOURCES, "live"));
  trades.sort((a, b) => (a.date || "").localeCompare(b.date || "")); // oldest → newest
  _cache = trades;
  _sig   = sig;
  return trades;
}

router.get("/", async (req, res) => {
  // Only report strategies that are enabled in Settings — a disabled strategy is
  // hidden from the sidebar, so its columns (and its trades in the day totals)
  // must not appear here either. Filtered per-request, never cached: Settings
  // saves mutate process.env while the process is running.
  const enabled     = enabledStrategies();
  const enabledSet  = new Set(enabled.map(s => s.mode));
  const trades      = loadAllTrades().filter(t => enabledSet.has(t.mode));
  const theme = resolveTheme();

  // Daily VIX from Fyers across the full recorded span (oldest trade → today, IST),
  // so any day the client filters to has a value. Embedded and looked up client-side.
  let vixByDate = {}, vixNote = "";
  if (trades.length) {
    const fromDate = trades[0].date; // loadAllTrades() sorts oldest → newest
    const toDate   = istTodayCR();
    ({ map: vixByDate, note: vixNote } = await loadVixByDate(fromDate, toDate));
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>ௐ Palani Andawar Thunai ॐ — Consolidation Report</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script>(function(){ if ('${theme}' === 'light') document.documentElement.setAttribute('data-theme','light'); })();</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    .main-content{flex:1;margin-left:200px;padding:18px 22px 40px;min-width:0;min-height:100vh;}
    @media(max-width:768px){.main-content{margin-left:0;padding:14px;}}
    .page-title{font-size:1.1rem;font-weight:700;color:#e0eaf8;margin-bottom:2px;}
    .page-sub{font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-bottom:14px;}
    .page-sub a{color:#7dd3fc;text-decoration:none;}
    .tbar{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;margin-bottom:14px;flex-wrap:wrap;}
    .tbar label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);font-family:'IBM Plex Mono',monospace;}
    .tbar input,.tbar select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:6px 10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;outline:none;}
    .tbar input:focus,.tbar select:focus{border-color:#38bdf8;}
    .seg{display:inline-flex;border:0.5px solid #0e1e36;border-radius:6px;overflow:hidden;}
    .seg button{background:#04090f;border:none;color:var(--muted-1,#8ba1c2);padding:6px 12px;font-family:'IBM Plex Mono',monospace;font-size:0.7rem;cursor:pointer;}
    .seg button.on{background:#0c4a6e;color:#7dd3fc;}
${multiSelectCSS()}
    .pdf-btn{margin-left:auto;background:#0c4a6e;border:0.5px solid #1e5a80;color:#7dd3fc;padding:7px 14px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}
    .pdf-btn:hover{background:#0e5a84;}
    .rpt-head{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;}
    .rpt-head .rh-title{font-size:1rem;font-weight:700;color:#e0eaf8;}
    .rpt-head .rh-meta{font-family:'IBM Plex Mono',monospace;font-size:0.66rem;color:var(--muted-1,#8ba1c2);margin-top:4px;line-height:1.7;}
    .rpt-head .rh-meta b{color:#7dd3fc;font-weight:600;}
    .rpt-head .rh-brand{text-align:right;font-family:'IBM Plex Mono',monospace;font-size:0.66rem;color:var(--muted-1,#8ba1c2);}
    .stat-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:16px;}
    @media(max-width:1300px){.stat-grid{grid-template-columns:repeat(3,1fr);}}
    @media(max-width:560px){.stat-grid{grid-template-columns:repeat(2,1fr);}}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent,#38bdf8);}
    .sc-label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-2,#6d85a8);margin-bottom:5px;font-family:'IBM Plex Mono',monospace;}
    .sc-val{font-size:1.05rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#e0eaf8;}
    .sc-sub{font-size:0.6rem;color:var(--muted-1,#8ba1c2);margin-top:3px;}
    .panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
    .panel h3{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.4px;color:var(--muted-2,#6d85a8);margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
    .tbl-scroll{overflow-x:auto;}
    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .tbl th{padding:8px 10px;text-align:right;font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;white-space:nowrap;}
    .tbl th:first-child{text-align:left;}
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;text-align:right;white-space:nowrap;vertical-align:top;}
    .tbl td:first-child{text-align:left;}
    .tbl tr:hover td{background:rgba(56,189,248,0.05);}
    .tbl tfoot td{border-top:1px solid #17324f;font-weight:700;color:#e0eaf8;background:#04090f;}
    .cnt{font-size:0.56rem;color:var(--muted-1,#8ba1c2);font-weight:400;}
    .muted{color:var(--muted-2,#6d85a8);}
    .badge-mode{padding:2px 6px;border-radius:4px;font-size:0.52rem;font-weight:700;letter-spacing:0.5px;}
    .badge-EMA_RSI_ST{background:rgba(59,130,246,0.12);color:#3b82f6;}
    .badge-BB_RSI{background:rgba(245,158,11,0.12);color:#f59e0b;}
    .badge-PA{background:rgba(168,85,247,0.12);color:#a855f7;}
    .badge-ORB{background:rgba(16,185,129,0.12);color:#10b981;}
    .badge-EMA9VWAP{background:rgba(6,182,212,0.12);color:#06b6d4;}
    .badge-TREND_PB{background:rgba(236,72,153,0.12);color:#ec4899;}
    .badge-GAPS{background:rgba(14,165,233,0.12);color:#0ea5e9;}
    .badge-TDS{background:rgba(168,85,247,0.12);color:#a855f7;}
    .badge-GAP3M{background:rgba(56,189,248,0.12);color:#38bdf8;}
.badge-HA_SCALP{background:rgba(249,115,22,0.12);color:#f97316;}
    .badge-OIWF{background:rgba(244,114,182,0.12);color:#f472b6;}
    .badge-RSI_PIVOT_ST{background:rgba(250,204,21,0.12);color:#facc15;}
    .badge-SIMPLE930{background:rgba(251,146,60,0.12);color:#fb923c;}
    .empty{text-align:center;padding:50px 20px;color:var(--muted-1,#8ba1c2);font-size:0.85rem;}
    /* Skip column — tick a day to drop it from the cards + TOTAL row. The choice
       is per-browser (localStorage), never written back to any trade file. */
    .tbl th.skip-col,.tbl td.skip-col{text-align:center;width:1%;padding-left:8px;padding-right:8px;}
    .tbl td.skip-col input{width:16px;height:16px;accent-color:#38bdf8;cursor:pointer;margin:0;vertical-align:middle;}
    /* 44px touch target on phones without growing the row visually */
    .tbl td.skip-col label{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:28px;cursor:pointer;}
    .tbl tr.skipped td{opacity:0.38;text-decoration:line-through;}
    .tbl tr.skipped td.skip-col{opacity:1;text-decoration:none;}
    .skip-note{font-size:0.56rem;color:var(--muted-1,#8ba1c2);font-family:'IBM Plex Mono',monospace;margin-top:8px;}
    .skip-note button{background:none;border:0.5px solid #17324f;color:var(--muted-1,#8ba1c2);border-radius:5px;padding:3px 8px;font-family:inherit;font-size:0.56rem;cursor:pointer;margin-left:8px;min-height:26px;}
    .skip-note button:hover{color:#38bdf8;border-color:#38bdf8;}
    /* warning alert — sits at the very top of the report, not buried under the table */
    .alert-warn{display:flex;align-items:flex-start;gap:10px;background:rgba(245,158,11,0.10);border:0.5px solid rgba(245,158,11,0.45);border-left:3px solid #f59e0b;border-radius:10px;padding:11px 14px;margin-bottom:14px;}
    .alert-warn .aw-ico{font-size:0.95rem;line-height:1.3;}
    .alert-warn .aw-title{font-size:0.7rem;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#f59e0b;font-family:'IBM Plex Mono',monospace;}
    .alert-warn .aw-body{font-size:0.7rem;color:#c8d8f0;font-family:'IBM Plex Mono',monospace;margin-top:3px;line-height:1.6;}
    /* light theme */
    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .page-title,:root[data-theme="light"] .rh-title{color:#1e293b!important;}
    :root[data-theme="light"] .page-sub,:root[data-theme="light"] .sc-label,:root[data-theme="light"] .sc-sub,:root[data-theme="light"] .panel h3,:root[data-theme="light"] .tbar label,:root[data-theme="light"] .rh-meta,:root[data-theme="light"] .rh-brand,:root[data-theme="light"] .cnt{color:#4b5769!important;}
    :root[data-theme="light"] .sc,:root[data-theme="light"] .panel,:root[data-theme="light"] .rpt-head{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .sc-val{color:#1e293b!important;}
    :root[data-theme="light"] .tbar{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbar input,:root[data-theme="light"] .tbar select,:root[data-theme="light"] .seg button{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .seg button.on{background:#e0f2fe!important;color:#0369a1!important;}
    /* Same sky-chip pair as Edge Analytics' .cr-link: the resting fill maps but
       the hover (#0e5a84) has no entry, so it went dark on hover. */
    :root[data-theme="light"] .pdf-btn{background:#0369a1!important;border-color:#0369a1!important;color:#ffffff!important;}
    :root[data-theme="light"] .pdf-btn:hover{background:#075985!important;}
    :root[data-theme="light"] .tbl th{background:#f1f5f9!important;color:#4b5769!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbl td{border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .tbl tfoot td{background:#f1f5f9!important;color:#1e293b!important;}
    :root[data-theme="light"] .muted{color:#cbd5e1!important;}
    :root[data-theme="light"] .empty{color:#5c6b7f!important;}
    :root[data-theme="light"] .skip-note{color:#4b5769!important;}
    :root[data-theme="light"] .skip-note button{border-color:#e0e4ea!important;color:#4b5769!important;}
    :root[data-theme="light"] .skip-note button:hover{color:#0369a1!important;border-color:#0369a1!important;}
    :root[data-theme="light"] .alert-warn{background:#fffbeb!important;border-color:#fcd34d!important;border-left-color:#f59e0b!important;}
    :root[data-theme="light"] .alert-warn .aw-title{color:#b45309!important;}
    :root[data-theme="light"] .alert-warn .aw-body{color:#78350f!important;}
    /* ── PRINT / Save-as-PDF ─────────────────────────────────────────── */
    @media print {
      @page { size: A4 landscape; margin: 12mm; }
      body{background:#fff!important;color:#111!important;overflow:visible!important;}
      .sidebar,.hamburger,.sidebar-overlay,.deploy-chip,#socket-broken-banner,#telegram-broken-banner,#backup-nag-banner,.tbar,.pdf-btn,.page-sub a{display:none!important;}
      .app-shell{display:block!important;}
      .main-content{margin-left:0!important;padding:0!important;min-height:auto!important;}
      .rpt-head,.sc,.panel{background:#fff!important;border:1px solid #d0d7e2!important;box-shadow:none!important;break-inside:avoid;}
      .alert-warn{background:#fffbeb!important;border:1px solid #d0d7e2!important;border-left:3px solid #b45309!important;break-inside:avoid;}
      .alert-warn .aw-title{color:#b45309!important;} .alert-warn .aw-body{color:#333!important;}
      .rh-title{color:#111!important;} .rh-meta,.rh-brand,.page-sub{color:#555!important;}
      .sc-val{color:#111!important;} .sc-label,.sc-sub,.panel h3{color:#555!important;}
      .tbl{font-size:0.6rem;} .tbl th{background:#eef2f7!important;color:#333!important;}
      .tbl td{color:#222!important;border-color:#d0d7e2!important;}
      .tbl tfoot td{background:#eef2f7!important;color:#111!important;}
      .tbl-scroll{overflow:visible!important;}
      .tbl tr{break-inside:avoid;}
      /* A printed report shows the numbers it totals: skipped days and the
         tick-boxes that excluded them are both left off the page. */
      .skip-col,.skip-note{display:none!important;}
      .tbl tr.skipped{display:none!important;}
      thead{display:table-header-group;}
    }
  </style>
</head>
<body>
<div class="app-shell">
  ${buildSidebar('consolidationReport', false)}
  <div class="main-content">
    <h1 class="page-title">📑 Consolidation Report</h1>
    <p class="page-sub">Day-by-day consolidated report of every recorded trade — per-strategy P&amp;L, wins/losses and net for each day. <a href="/edge-analytics">← Edge Analytics</a></p>

    <div class="tbar">
      <label>Book</label>
      <div class="seg" id="segBook">
        <button data-book="paper" class="on">Paper</button>
        <button data-book="live">Live</button>
        <button data-book="all">Both</button>
      </div>
      <label>Strategy</label>
      ${multiSelectHTML('fMode', enabled.map(s => ({ value: s.mode, label: s.mode })), 'All strategies')}
      <label>Range</label>
      <select id="fRange">${dateRangeOptionsHTML('tm')}</select>
      <span id="customWrap" style="display:none;">
        <label>From</label><input type="date" id="fFrom"/>
        <label>To</label><input type="date" id="fTo"/>
      </span>
      <button class="pdf-btn" onclick="window.print()">🖨 Save as PDF</button>
    </div>

    <div id="content"></div>
  </div>
</div>

<script>
${dateRangeJS()}
${multiSelectJS()}
const ALL = ${JSON.stringify(trades)};
const VIX_BY_DATE = ${JSON.stringify(vixByDate)};   // { 'YYYY-MM-DD': vixClose } from Fyers
const VIX_NOTE    = ${JSON.stringify(vixNote)};     // why the VIX column is empty, if it is
const MODES = ${JSON.stringify(enabled.map(s => s.mode))};
const MODE_LABEL = ${JSON.stringify(Object.fromEntries(enabled.map(s => [s.mode, s.mode])))};

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function inr2(n){ return (n<0?'-':'')+'₹'+Math.abs(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function inr(n){ const v=Math.round(n); return (v<0?'-':'')+'₹'+Math.abs(v).toLocaleString('en-IN'); }
function pc(n){ return n>=0?'#10b981':'#ef4444'; }
function fmtVix(n){ return (n==null)?'<span class="muted">—</span>':n.toFixed(2); }

// 'YYYY-MM-DD' → "Tue, 14 Jul 2026"  (matches the Telegram day-report header)
function prettyDate(s){ const d=new Date(s+'T12:00:00'); if(isNaN(d)) return s; return d.toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short',year:'numeric'}); }

// ── Skipped days ────────────────────────────────────────────────────
// A day can be excluded from the report without touching any trade file: the
// tick lives only in this browser's localStorage, keyed by date, and every
// aggregate below (cards, TOTAL row, per-strategy totals, avg VIX) is computed
// from the un-skipped days only. Wiped by "Clear skipped".
const SKIP_KEY='consolReport.skipDays';
let SKIP=new Set();
try{ const raw=localStorage.getItem(SKIP_KEY); if(raw) SKIP=new Set(JSON.parse(raw)||[]); }catch(_){}
function saveSkip(){ try{ localStorage.setItem(SKIP_KEY, JSON.stringify([...SKIP])); }catch(_){} }
function toggleSkip(d, on){ if(on) SKIP.add(d); else SKIP.delete(d); saveSkip(); render(); }
function clearSkip(){ SKIP.clear(); saveSkip(); render(); }

// Range bounds come from sharedNav's drRange() — the same resolver the Dashboard
// and Edge Analytics use, so "This month" means one thing across the whole app.
// The printed "Period:" line reads the option's own text rather than a private
// label map, which is what let this page's list drift from the others before.
function rangeLabelFor(range, from, to){
  if(range==='custom') return (from||'…')+' → '+(to||'…');
  const sel = document.getElementById('fRange');
  const txt = (sel.options[sel.selectedIndex] || {}).text || range;
  // The expiry cycle is the one range whose dates a reader can't infer, so spell it out.
  return range==='exp' ? txt+' ('+(from||'…')+' → '+(to||'today')+')' : txt;
}

function currentFilter(){
  const book = document.querySelector('#segBook button.on').dataset.book;
  const modes = msValues('fMode');           // ticked strategies; [] = none ticked
  const range = document.getElementById('fRange').value;
  const r = drRange(range, document.getElementById('fFrom').value, document.getElementById('fTo').value);
  return {book,modes,from:r.from,to:r.to,rangeLabel:rangeLabelFor(range,r.from,r.to)};
}
function applyFilter(f){
  return ALL.filter(t=>{
    if(f.book!=='all' && t.book!==f.book) return false;
    if(f.modes.indexOf(t.mode)===-1) return false;
    if(f.from && t.date < f.from) return false;
    if(f.to   && t.date > f.to)   return false;
    return true;
  });
}

// Build one bucket per day: per-strategy {n,pnl} + totals {n,wins,losses,net}
function byDay(arr){
  const m=new Map();
  for(const t of arr){
    const d=t.date||'—';
    if(!m.has(d)) m.set(d,{ date:d, modes:{}, n:0, wins:0, losses:0, net:0 });
    const g=m.get(d);
    if(!g.modes[t.mode]) g.modes[t.mode]={n:0,pnl:0};
    g.modes[t.mode].n++; g.modes[t.mode].pnl+=t.pnl;
    g.n++; g.net+=t.pnl;
    if(t.pnl>0) g.wins++; else if(t.pnl<0) g.losses++;
  }
  return [...m.values()].sort((a,b)=>b.date.localeCompare(a.date)); // newest day first
}

function render(){
  const f=currentFilter();
  const arr=applyFilter(f);
  const C=document.getElementById('content');

  const bookLabel = f.book==='all'?'Paper + Live':(f.book==='live'?'Live':'Paper');
  const gen = new Date().toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'});
  const days = byDay(arr);

  // Skipped days stay visible in the table (struck through) but count for nothing:
  // every aggregate from here on is built from kept / keptArr, not the full set.
  const kept    = days.filter(g => !SKIP.has(g.date));
  const keptArr = arr.filter(t => !SKIP.has(t.date));
  const nSkipped = days.length - kept.length;

  // VIX readings for the kept days — drives both the TOTAL row and the alert below.
  const vixVals = kept.map(g => VIX_BY_DATE[g.date]).filter(v => v != null);

  // Silence is the worst outcome here — if every VIX cell is a dash, say why, and
  // say it at the top of the page where it can't be scrolled past.
  const vixWarn = (!vixVals.length && VIX_NOTE)
    ? '<div class="alert-warn" role="alert"><div class="aw-ico">⚠️</div><div>'
      + '<div class="aw-title">VIX unavailable</div>'
      + '<div class="aw-body">' + esc(VIX_NOTE) + ' — the VIX column stays empty until this is fixed.</div>'
      + '</div></div>'
    : '';

  // Show a column for EVERY strategy enabled in Settings, even one that took no
  // trade in this range — a missing column reads as "that strategy isn't running"
  // when it actually means "it ran and found nothing". Zero-trade days show a dash.
  // With a subset ticked, only those columns are meaningful — MODES order is kept
  // so the columns don't reshuffle as boxes are ticked.
  const activeModes = MODES.filter(m => f.modes.indexOf(m)>=0);

  // overall totals
  let tN=0,tW=0,tL=0,tNet=0,tWP=0,tLP=0; const totByMode={};
  for(const mo of activeModes) totByMode[mo]={n:0,pnl:0,wins:0,losses:0,winPnl:0,lossPnl:0};
  for(const t of keptArr){
    tN++; tNet+=t.pnl;
    if(t.pnl>0){ tW++; tWP+=t.pnl; } else if(t.pnl<0){ tL++; tLP+=t.pnl; }
    const m=totByMode[t.mode];
    if(m){ m.n++; m.pnl+=t.pnl;
      if(t.pnl>0){ m.wins++; m.winPnl+=t.pnl; } else if(t.pnl<0){ m.losses++; m.lossPnl+=t.pnl; } }
  }
  const tWR = tN?(tW/tN*100):0;

  let head=vixWarn+'<div class="rpt-head"><div>'
    +'<div class="rh-title">Consolidated Day Report</div>'
    +'<div class="rh-meta">Book: <b>'+bookLabel+'</b> &nbsp;·&nbsp; Strategy: <b>'+esc(f.modes.length===MODES.length ? 'All' : (f.modes.length ? f.modes.map(m=>MODE_LABEL[m]||m).join(', ') : 'None'))+'</b> &nbsp;·&nbsp; Period: <b>'+esc(f.rangeLabel)+'</b> &nbsp;·&nbsp; Trading days: <b>'+kept.length+'</b> &nbsp;·&nbsp; Trades: <b>'+tN+'</b>'
    // A total that silently omits days would be misread as the full period.
    +(nSkipped ? ' &nbsp;·&nbsp; <b style="color:#f59e0b">'+nSkipped+' day'+(nSkipped>1?'s':'')+' skipped</b>' : '')+'</div>'
    +'</div><div class="rh-brand">ௐ Palani Andawar Thunai ॐ<br>Generated '+esc(gen)+'</div></div>';

  if(!days.length){ C.innerHTML=head+'<div class="empty">No trades for this filter. Try widening the range or switching Book.</div>'; return; }

  // summary cards (mirror the Telegram totals block)
  const cards=[
    {l:'Total Trades',v:tN,sub:kept.length+' trading day'+(kept.length===1?'':'s')+(nSkipped?' · '+nSkipped+' skipped':''),a:'#38bdf8'},
    {l:'Wins',v:tW,sub:'',a:'#10b981'},
    {l:'Losses',v:tL,sub:'',a:'#ef4444'},
    {l:'Win Rate',v:tWR.toFixed(1)+'%',sub:'',a:tWR>=50?'#10b981':'#f59e0b'},
    {l:'Net P&L',v:inr(tNet),sub:tNet>=0?'🟢 PROFIT':'🔴 LOSS',a:pc(tNet)},
    {l:'Avg / Day',v:inr(kept.length?tNet/kept.length:0),sub:'per trading day',a:pc(tNet)},
  ];
  let h=head+'<div class="stat-grid">';
  for(const c of cards) h+='<div class="sc" style="--accent:'+c.a+'"><div class="sc-label">'+c.l+'</div><div class="sc-val" style="color:'+c.a+'">'+c.v+'</div><div class="sc-sub">'+c.sub+'</div></div>';
  h+='</div>';

  // the daily table
  let thead='<tr><th class="skip-col" title="Tick a day to leave it out of the totals">Skip</th><th>Date</th><th>VIX</th>';
  for(const mo of activeModes) thead+='<th>'+esc(MODE_LABEL[mo])+'</th>';
  thead+='<th>Trades</th><th>Net P&amp;L</th></tr>';

  let body='';
  for(const g of days){
    const dayVix = (VIX_BY_DATE[g.date]!=null) ? VIX_BY_DATE[g.date] : null;
    const off = SKIP.has(g.date);
    let row='<td class="skip-col"><label><input type="checkbox" data-skip="'+esc(g.date)+'"'+(off?' checked':'')
      +' aria-label="Skip '+esc(prettyDate(g.date))+'"/></label></td>'
      +'<td>'+esc(prettyDate(g.date))+'</td><td>'+fmtVix(dayVix)+'</td>';
    for(const mo of activeModes){
      const c=g.modes[mo];
      if(!c || !c.n){ row+='<td class="muted">—</td>'; continue; }
      row+='<td><span style="color:'+pc(c.pnl)+'">'+inr2(c.pnl)+'</span><br><span class="cnt">'+c.n+' trade'+(c.n>1?'s':'')+'</span></td>';
    }
    const wr=g.n?(g.wins/g.n*100):0;
    // Trades column carries the whole W/L/Win% story; the P&L colour alone says
    // profit-or-loss, so the separate Result column is redundant.
    row+='<td>'+g.n+' - <span style="color:#10b981">'+g.wins+'W</span> <span style="color:#ef4444">'+g.losses+'L</span> '+wr.toFixed(0)+'%</td>'
      +'<td style="font-weight:700"><span style="color:'+pc(g.net)+'">'+inr2(g.net)+'</span></td>';
    body+='<tr'+(off?' class="skipped"':'')+'>'+row+'</tr>';
  }

  // totals footer — VIX averaged across the shown days that have a Fyers reading
  const avgVix  = vixVals.length ? vixVals.reduce((s,v)=>s+v,0)/vixVals.length : null;
  let foot='<tr><td class="skip-col"></td><td><b>TOTAL</b></td><td>'+fmtVix(avgVix)+'</td>';
  for(const mo of activeModes){
    const c=totByMode[mo];
    if(!c || !c.n){ foot+='<td class="muted">—</td>'; continue; }
    // Per-strategy totals need the same W/L split the overall TOTAL shows — a bare
    // trade count hides which strategy actually won its trades.
    foot+='<td><span style="color:'+pc(c.pnl)+'">'+inr2(c.pnl)+'</span><br><span class="cnt">'+c.n+' · '
      +'<span style="color:#10b981">'+c.wins+'W</span> / <span style="color:#ef4444">'+c.losses+'L</span></span></td>';
  }
  // The colour lives on an inner span: the light-theme .cnt rule is !important,
  // so a colour set on .cnt itself would be greyed out in light mode.
  foot+='<td><b>'+tN+'</b> - <span style="color:#10b981">'+tW+'W</span> <span style="color:#ef4444">'+tL+'L</span> '+tWR.toFixed(0)+'%'
    +'<br><span class="cnt"><span style="color:#10b981">'+inr(tWP)+'</span> / <span style="color:#ef4444">'+inr(tLP)+'</span></span></td>'
    +'<td style="font-weight:700"><span style="color:'+pc(tNet)+'">'+inr2(tNet)+'</span></td></tr>';

  h+='<div class="panel"><h3>Daily Breakdown</h3><div class="tbl-scroll"><table class="tbl"><thead>'+thead+'</thead><tbody>'+body+'</tbody><tfoot>'+foot+'</tfoot></table></div>'
    +'<div class="skip-note">Tick <b>Skip</b> to leave a day out of the cards and the TOTAL row — the trade files are not touched, and the choice stays in this browser.'
    +(nSkipped?'<button type="button" id="clearSkip">Clear '+nSkipped+' skipped</button>':'')+'</div></div>';
  C.innerHTML=h;

  // Re-bound on every render because render() replaces the whole table.
  C.querySelectorAll('input[data-skip]').forEach(cb=>cb.addEventListener('change',()=>toggleSkip(cb.dataset.skip, cb.checked)));
  const cs=document.getElementById('clearSkip');
  if(cs) cs.addEventListener('click',clearSkip);
}

// wire controls
document.querySelectorAll('#segBook button').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('#segBook button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); render();
}));
msInit('fMode', render);
document.getElementById('fRange').addEventListener('change',()=>{
  const range = document.getElementById('fRange').value;
  document.getElementById('customWrap').style.display = range==='custom'?'inline':'none';
  // Only 'Current week expiry' needs the expiry calendar — fetched on first use
  // and cached, so every later selection resolves without a round-trip.
  if(range==='exp'){ drReady().then(render); return; }
  render();
});
document.getElementById('fFrom').addEventListener('change',render);
document.getElementById('fTo').addEventListener('change',render);
render();
</script>
</body>
</html>`;
  res.send(html);
});

module.exports = router;

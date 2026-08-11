/**
 * Edge Analytics — turns the trade JSONL/JSON you already collect into edge metrics.
 *
 * Read-only. Loads the same per-strategy session files that /consolidation (paper) and
 * /live-consolidation (live) use, flattens them to one trade array, embeds it in the page,
 * and computes everything client-side so the Book / Strategy / Date filters recompute
 * instantly without a server round-trip.
 *
 * Metrics: win rate, expectancy, profit factor, payoff, avg win/loss, max drawdown,
 * win/loss streaks, equity curve, P&L by hour-of-day, P&L by weekday, P&L by exit reason,
 * and a per-strategy breakdown table — plus the risk-adjusted set: Sharpe, Sortino,
 * SQN, recovery factor, Kelly size, edge confidence (t-test), hold time, cost drag,
 * daily P&L, underwater drawdown, P&L distribution, rolling form, weekday×hour heatmap,
 * MFE/MAE trade efficiency, a bootstrap Monte Carlo, and side / hold / VIX / strength cuts —
 * plus the edge-quality set: expectancy in R, break-even win rate + cushion, top-5 profit
 * concentration, net ex top-5, equity-curve R², trades/day, worst red run, a monthly P&L
 * grid, an R-multiple distribution and an Nth-trade-of-the-day cut.
 *
 * Layout is a scanning dashboard, not a chart viewer: short chart boxes, cards stepping
 * 8 → 4 → 2 columns, and tables/heat grids scrolling inside their own panel so the phone
 * layout never scrolls horizontally.
 *
 * Sample gates: ratios that need a sample (Sharpe, Sortino, SQN, Kelly, edge confidence,
 * Monte Carlo) render "—" below MIN_DAYS / MIN_TRADES rather than a number built on noise.
 *
 * Gated by UI_SHOW_EDGE_ANALYTICS (Settings → Menu Visibility). No new data is written.
 */
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { buildSidebar, sidebarCSS, faviconLink, enabledStrategies,
        dateRangeOptionsHTML, dateRangeJS,
        multiSelectCSS, multiSelectHTML, multiSelectJS } = require("../utils/sharedNav");
const { resolveTheme } = require("../utils/theme");

const _HOME = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");

// Mirror the source maps used by consolidation.js (paper) + liveConsolidation.js (live).
// ORB live files are included defensively — safeRead() no-ops if absent.
const PAPER_SOURCES = [
  { mode: "EMA_RSI_ST",    file: "ema_rsi_st_paper_trades.json" },
  { mode: "BB_RSI",    file: "bb_rsi_paper_trades.json" },
  { mode: "PA",       file: "pa_paper_trades.json" },
  { mode: "ORB",      file: "orb_paper_trades.json" },
  { mode: "EMA9VWAP", file: "ema9vwap_paper_trades.json" },
  { mode: "TREND_PB", file: "trend_pb_paper_trades.json" },
  { mode: "GAPS",     file: "gaps_paper_trades.json" },
  { mode: "TDS",      file: "trend_day_scalp_paper_trades.json" },
  { mode: "GAP3M",    file: "gap_fix_3m_paper_trades.json" },
];
const LIVE_SOURCES = [
  { mode: "EMA_RSI_ST",    file: "ema_rsi_st_live_trades.json" },
  { mode: "BB_RSI",    file: "bb_rsi_live_trades.json" },
  { mode: "PA",       file: "pa_live_trades.json" },
  { mode: "ORB",      file: "orb_live_trades.json" },
  { mode: "EMA9VWAP", file: "ema9vwap_live_trades.json" },
  { mode: "TREND_PB", file: "trend_pb_live_trades.json" },
  { mode: "GAPS",     file: "gaps_live_trades.json" },
  { mode: "TDS",      file: "trend_day_scalp_live_trades.json" },
  { mode: "GAP3M",    file: "gap_fix_3m_live_trades.json" },
];

function safeRead(p) {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) { return {}; }
}

// Numeric coercion helpers — trade records are hand-built per engine, so any
// field can be absent/null on some strategies. null (not 0) means "not recorded",
// which the client uses to exclude the trade from that metric instead of
// silently averaging a zero in.
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function round(v, d) { const n = num(v); return n === null ? null : Math.round(n * Math.pow(10, d)) / Math.pow(10, d); }

function loadBook(sources, book) {
  const out = [];
  for (const src of sources) {
    const data = safeRead(path.join(DATA_DIR, src.file));
    for (const s of (data.sessions || [])) {
      const sessionDate = String(s.date || "").slice(0, 10);
      for (const t of (s.trades || [])) {
        const side = t.side || t.optionType || "";
        // Same formula the engines use for pnlPoints — recomputed only when the
        // engine did not record it (ORB), so every strategy can be compared.
        let pts = round(t.pnlPoints, 2);
        if (pts === null && num(t.entryPrice) !== null && num(t.exitPrice) !== null) {
          pts = round((num(t.exitPrice) - num(t.entryPrice)) * (side === "PE" ? -1 : 1), 2);
        }
        const durMs = num(t.durationMs);
        out.push({
          book,
          mode:        src.mode,
          date:        sessionDate,
          side,
          entryTime:   t.entryTime || "",
          exitTime:    t.exitTime || "",
          pnl:         Number(t.pnl) || 0,
          exitReason:  t.exitReason || "—",
          // Extra dimensions for the pro metrics. Rounded to keep the embedded
          // payload small — these feed averages/percentiles, not accounting.
          qty:      num(t.qty),
          durMin:   durMs === null ? null : Math.round(durMs / 60000),
          pts,
          mfePts:   round(t.mfeSpotPts, 2),   // best favourable spot excursion (≥0)
          maePts:   round(t.maeSpotPts, 2),   // worst adverse spot excursion (≤0)
          mfeRs:    round(t.mfePnl, 0),       // peak unrealised ₹ (≥0) — not on every engine
          maeRs:    round(t.maePnl, 0),       // worst unrealised ₹ (≤0) — not on every engine
          vix:      round(t.vixAtEntry, 2),
          strength: t.signalStrength || null,
          charges:  round(t.charges, 2),
        });
      }
    }
  }
  return out;
}

// Cache the flattened+sorted trade list — same approach as consolidation.js.
// Re-reading + JSON.parsing all 8 (growing) trade files on every page hit is
// wasteful; invalidate by a cheap mtime+size signature so a new trade is picked
// up immediately without re-parsing when nothing changed.
let _edgeCache = null;
let _edgeSig   = null;
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
  if (_edgeCache && sig === _edgeSig) return _edgeCache;
  const trades = loadBook(PAPER_SOURCES, "paper").concat(loadBook(LIVE_SOURCES, "live"));
  // oldest → newest so the equity curve reads left-to-right
  trades.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  _edgeCache = trades;
  _edgeSig   = sig;
  return trades;
}

router.get("/", (req, res) => {
  // Only analyse strategies that are enabled in Settings — a disabled strategy is
  // hidden from the sidebar, so it must not appear in the Strategy dropdown, the
  // per-strategy table, or the "All" totals. Filtered per-request, never cached:
  // Settings saves mutate process.env while the process is running.
  const enabled    = enabledStrategies();
  const enabledSet = new Set(enabled.map(s => s.mode));
  const trades     = loadAllTrades().filter(t => enabledSet.has(t.mode));
  const modePicker = multiSelectHTML('fMode', enabled.map(s => ({ value: s.mode, label: s.label })), 'All');

  const theme = resolveTheme();
  const showConsolidationReport = (process.env.UI_SHOW_CONSOLIDATION_REPORT || "true").toLowerCase() === "true";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
  ${faviconLink()}
  <title>ௐ Palani Andawar Thunai ॐ — Edge Analytics</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <script>(function(){ if ('${theme}' === 'light') document.documentElement.setAttribute('data-theme','light'); })();</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;}
    ${sidebarCSS()}
    /* Padding uses env() so the notch/home-indicator never clips a card in
       landscape on an iPhone; max() keeps the desktop value on every other device. */
    .main-content{flex:1;margin-left:200px;padding:16px 20px 40px;min-width:0;min-height:100vh;}
    @media(max-width:900px){.main-content{margin-left:0;
      padding:12px max(12px,env(safe-area-inset-right)) calc(28px + env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));}}
    .page-title{font-size:1.05rem;font-weight:700;color:#e0eaf8;margin-bottom:2px;}
    .page-sub{font-size:0.7rem;color:var(--muted-1,#8ba1c2);margin-bottom:12px;line-height:1.5;}
    /* section rule — groups the three card rows so 24 numbers read as three ideas */
    .sect{display:flex;align-items:center;gap:8px;font-family:'IBM Plex Mono',monospace;font-size:0.55rem;
      text-transform:uppercase;letter-spacing:1.6px;color:var(--muted-2,#6d85a8);margin:0 0 7px;}
    .sect::after{content:'';flex:1;height:1px;background:#0e1e36;}
    .tbar{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;margin-bottom:14px;flex-wrap:wrap;}
    .tbar label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);font-family:'IBM Plex Mono',monospace;}
    .tbar input,.tbar select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:6px 10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;outline:none;}
    .tbar input:focus,.tbar select:focus{border-color:#38bdf8;}
    .seg{display:inline-flex;border:0.5px solid #0e1e36;border-radius:6px;overflow:hidden;}
    .seg button{background:#04090f;border:none;color:var(--muted-1,#8ba1c2);padding:6px 12px;font-family:'IBM Plex Mono',monospace;font-size:0.7rem;cursor:pointer;}
    .seg button.on{background:#0c4a6e;color:#7dd3fc;}
${multiSelectCSS()}
    .cr-link{margin-left:auto;background:#0c4a6e;border:0.5px solid #1e5a80;color:#7dd3fc;padding:7px 14px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}
    .cr-link:hover{background:#0e5a84;}
    /* 8 → 4 → 2 columns: every step divides 8 evenly, so a card row never ends
       ragged. 2 columns is the iPhone layout (390-440pt wide). */
    .stat-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:8px;margin-bottom:12px;}
    @media(max-width:1500px){.stat-grid{grid-template-columns:repeat(4,1fr);}}
    @media(max-width:700px){.stat-grid{grid-template-columns:repeat(2,1fr);gap:7px;}}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:9px;padding:10px 12px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent,#38bdf8);}
    .sc-label{font-size:0.52rem;text-transform:uppercase;letter-spacing:1.1px;color:var(--muted-2,#6d85a8);margin-bottom:4px;font-family:'IBM Plex Mono',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .sc-val{font-size:0.95rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#e0eaf8;font-variant-numeric:tabular-nums;line-height:1.25;}
    .sc-sub{font-size:0.57rem;color:var(--muted-1,#8ba1c2);margin-top:2px;line-height:1.35;}
    .panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;margin-bottom:12px;min-width:0;}
    /* Grid children default to min-width:auto, so a wide table would stretch its
       panel past the viewport and get clipped by body{overflow-x:hidden} instead
       of scrolling inside its own wrapper. min-width:0 is what makes it scroll. */
    .row2 > *,.row3 > *{min-width:0;}
    .panel h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.3px;color:var(--muted-2,#6d85a8);margin-bottom:8px;font-family:'IBM Plex Mono',monospace;}
    .row2{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    @media(max-width:1000px){.row2{grid-template-columns:1fr;}}
    .row3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}
    @media(max-width:1100px){.row3{grid-template-columns:1fr;}}
    /* Chart boxes are deliberately short — this is a scanning dashboard, not a
       chart viewer; the tallest (equity) is still under a third of a laptop screen. */
    .chart-wrap{position:relative;height:200px;}
    .chart-wrap.tall{height:240px;}
    .chart-wrap.short{height:165px;}
    @media(max-width:700px){
      .chart-wrap{height:175px;}
      .chart-wrap.tall{height:200px;}
      .chart-wrap.short{height:150px;}
      .panel{padding:11px 12px;margin-bottom:10px;}
      .sc-val{font-size:0.9rem;}
    }
    .cap{font-family:'IBM Plex Mono',monospace;font-size:0.62rem;color:var(--muted-1,#8ba1c2);margin:-4px 0 10px;line-height:1.6;}
    .mini{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:10px;}
    .mini > div{background:#04090f;border:0.5px solid #0e1e36;border-radius:8px;padding:8px 10px;}
    .mini .k{font-family:'IBM Plex Mono',monospace;font-size:0.54rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);}
    .mini .v{font-family:'IBM Plex Mono',monospace;font-size:0.85rem;font-weight:700;color:#e0eaf8;margin-top:2px;}
    .hm{width:100%;border-collapse:separate;border-spacing:3px;font-family:'IBM Plex Mono',monospace;font-size:0.6rem;font-variant-numeric:tabular-nums;}
    .hm th{color:var(--muted-2,#6d85a8);font-weight:600;font-size:0.54rem;text-transform:uppercase;letter-spacing:1px;padding:2px 0;}
    .hm td{text-align:center;padding:7px 2px;border-radius:5px;background:#04090f;border:0.5px solid #0e1e36;color:#c8d8f0;white-space:nowrap;min-width:38px;}
    .hm td.void{color:#16243c;}
    .hm .rowlab{text-align:right;color:var(--muted-2,#6d85a8);background:none;border:none;padding-right:6px;}
    .sc[title],.mini > div[title],.hm td[title]{cursor:help;}
    :root[data-theme="light"] .cap{color:#4b5769!important;}
    :root[data-theme="light"] .mini > div{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    /* No !important on the heatmap cell background or the mini value colour: an
       author !important beats an inline style, which would flatten the green/red
       the JS writes inline. Higher specificity alone is enough over the base rule. */
    :root[data-theme="light"] .hm td{background:#f8fafc;border-color:#e0e4ea;color:#334155;}
    :root[data-theme="light"] .mini .k,:root[data-theme="light"] .hm th,:root[data-theme="light"] .hm .rowlab{color:#4b5769!important;}
    :root[data-theme="light"] .mini .v{color:#1e293b;}
    :root[data-theme="light"] .hm td.void{color:#cbd5e1!important;}
    :root[data-theme="light"] .hm .rowlab{background:none!important;border:none!important;}
    /* Tables scroll inside their own panel instead of widening the page — the
       phone layout must never scroll horizontally as a whole. */
    .tblwrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
    .tblwrap .tbl{min-width:330px;}
    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.7rem;font-variant-numeric:tabular-nums;}
    .tbl th{padding:8px 10px;text-align:right;font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;}
    .tbl th:first-child{text-align:left;}
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;text-align:right;}
    .tbl td:first-child{text-align:left;}
    .tbl tr:hover td{background:rgba(56,189,248,0.05);}
    .pager{display:flex;align-items:center;gap:6px;margin-top:10px;font-family:'IBM Plex Mono',monospace;font-size:0.64rem;color:var(--muted-1,#8ba1c2);flex-wrap:wrap;}
    .pg-info{margin-right:auto;}
    .pg-btn{background:#04090f;border:0.5px solid #0e1e36;color:#7dd3fc;padding:4px 9px;border-radius:5px;font-family:inherit;font-size:0.72rem;line-height:1;cursor:pointer;min-width:30px;min-height:28px;}
    .pg-btn:hover:not(:disabled){background:#0c4a6e;}
    .pg-btn:disabled{opacity:0.35;cursor:default;color:var(--muted-2,#6d85a8);}
    .pg-num{padding:0 4px;color:#c8d8f0;}
    .badge-mode{padding:2px 7px;border-radius:4px;font-size:0.58rem;font-weight:700;letter-spacing:0.5px;}
    .badge-EMA_RSI_ST{background:rgba(59,130,246,0.12);color:#3b82f6;border:0.5px solid rgba(59,130,246,0.3);}
    .badge-BB_RSI{background:rgba(245,158,11,0.12);color:#f59e0b;border:0.5px solid rgba(245,158,11,0.3);}
    .badge-PA{background:rgba(168,85,247,0.12);color:#a855f7;border:0.5px solid rgba(168,85,247,0.3);}
    .badge-ORB{background:rgba(16,185,129,0.12);color:#10b981;border:0.5px solid rgba(16,185,129,0.3);}
    .empty{text-align:center;padding:50px 20px;color:var(--muted-1,#8ba1c2);font-size:0.85rem;}
    /* phone: full-width controls, 44px touch targets, no cramped two-up rows */
    @media(max-width:700px){
      .tbar{gap:6px;padding:8px 10px;margin-bottom:10px;}
      .tbar select,.tbar input{flex:1 1 120px;min-width:0;padding:8px 10px;}
      .seg button{padding:8px 14px;}
      .cr-link{margin-left:0;width:100%;justify-content:center;padding:9px 14px;}
      #cntPill{margin-left:0!important;}
      .tbl{font-size:0.66rem;}
      .tbl th,.tbl td{padding:6px 7px;}
      .mini{gap:6px;}
      .hm td{font-size:0.55rem;min-width:38px;}
    }
    /* light theme */
    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .page-title{color:#1e293b!important;}
    :root[data-theme="light"] .page-sub,:root[data-theme="light"] .sc-label,:root[data-theme="light"] .sc-sub,:root[data-theme="light"] .panel h3,:root[data-theme="light"] .tbar label{color:#4b5769!important;}
    :root[data-theme="light"] .sc,:root[data-theme="light"] .panel{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .sc-val{color:#1e293b!important;}
    :root[data-theme="light"] .tbar{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbar input,:root[data-theme="light"] .tbar select,:root[data-theme="light"] .seg button{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .seg button.on{background:#e0f2fe!important;color:#0369a1!important;}
    :root[data-theme="light"] .tbl th{background:#f1f5f9!important;color:#4b5769!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbl td{border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .empty{color:#5c6b7f!important;}
    :root[data-theme="light"] .sect{color:#4b5769!important;}
    :root[data-theme="light"] .sect::after{background:#e0e4ea!important;}
    :root[data-theme="light"] .pager{color:#4b5769!important;}
    :root[data-theme="light"] .pg-btn{background:#f8fafc!important;border-color:#e0e4ea!important;color:#0369a1!important;}
    :root[data-theme="light"] .pg-btn:hover:not(:disabled){background:#e0f2fe!important;}
    :root[data-theme="light"] .pg-num{color:#1e293b!important;}
    /* The rewriter has an entry for the resting fill (#0c4a6e) but none for the
       hover (#0e5a84), so hovering turned the button dark under already-lightened
       text. Paint both states here so it reads as a solid button either way. */
    :root[data-theme="light"] .cr-link{background:#0369a1!important;border-color:#0369a1!important;color:#ffffff!important;}
    :root[data-theme="light"] .cr-link:hover{background:#075985!important;}
  </style>
</head>
<body>
<div class="app-shell">
  ${buildSidebar('edgeAnalytics', false)}
  <div class="main-content">
    <h1 class="page-title">📈 Edge Analytics</h1>
    <p class="page-sub">Win rate · expectancy · profit factor · Sharpe · system quality · drawdown · MFE/MAE · Monte Carlo — computed from your recorded trades.</p>

    <div class="tbar">
      <label>Book</label>
      <div class="seg" id="segBook">
        <button data-book="paper" class="on">Paper</button>
        <button data-book="live">Live</button>
      </div>
      <label>Strategy</label>
      ${modePicker}
      <label>Range</label>
      <select id="fRange">${dateRangeOptionsHTML('all')}</select>
      <span id="customWrap" style="display:none;">
        <label>From</label><input type="date" id="fFrom"/>
        <label>To</label><input type="date" id="fTo"/>
      </span>
      ${showConsolidationReport ? `<a href="/consolidation-report" class="cr-link" title="Open the day-by-day consolidated report (with PDF export)">📑 Consolidation Report</a>` : ''}
      <span id="cntPill" style="margin-left:${showConsolidationReport ? '12px' : 'auto'};font-family:'IBM Plex Mono',monospace;font-size:0.7rem;color:var(--muted-1,#8ba1c2);"></span>
    </div>

    <div id="content"></div>
  </div>
</div>

<script>
${dateRangeJS()}
${multiSelectJS()}
const ALL = ${JSON.stringify(trades)};

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function inr(n){ const v=Math.round(n); return (v<0?'-':'')+'₹'+Math.abs(v).toLocaleString('en-IN'); }
function sign(n){ return n>0?'+':''; }
function pc(n){ return n>=0?'#10b981':'#ef4444'; }

// istNow() writes "DD/MM/YYYY, HH:MM:SS" (IST). Older records may be "HH:MM, DD/MM/YYYY".
// Both have exactly one clock field, so the first HH:MM in the string is the entry time —
// the date half never contains a colon. ISO "YYYY-MM-DDTHH:MM..Z" is UTC, so shift +5:30.
function entryMins(t){
  const v=String(t||'');
  if(/^\\d{4}-\\d{2}-\\d{2}T/.test(v)){
    const d=new Date(v);
    if(isNaN(d)) return null;
    const u=new Date(d.getTime()+19800000);
    return u.getUTCHours()*60+u.getUTCMinutes();
  }
  const m=v.match(/(\\d{1,2}):(\\d{2})/);
  if(!m) return null;
  const h=+m[1], mi=+m[2];
  return (h>=0&&h<=23&&mi>=0&&mi<=59)?h*60+mi:null;
}
function entryHour(t){ const m=entryMins(t); return m===null?null:Math.floor(m/60); }
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function weekday(dateStr){ if(!dateStr) return null; const d=new Date(dateStr+'T12:00:00'); return isNaN(d)?null:d.getDay(); }

// Range bounds come from sharedNav's drRange() so this page and the Dashboard
// top bar always resolve a given range to the same two dates.
function currentFilter(){
  const book = document.querySelector('#segBook button.on').dataset.book;
  const modes = msValues('fMode');           // ticked strategies; [] = none ticked
  const range = document.getElementById('fRange').value;
  const r = drRange(range, document.getElementById('fFrom').value, document.getElementById('fTo').value);
  return {book,modes,from:r.from,to:r.to};
}
function applyFilter(f){
  return ALL.filter(t=>{
    if(t.book!==f.book) return false;
    if(f.modes.indexOf(t.mode)===-1) return false;
    if(f.from && t.date < f.from) return false;
    if(f.to   && t.date > f.to)   return false;
    return true;
  });
}

function stats(arr){
  let net=0,gw=0,gl=0,wins=0,losses=0,scratch=0,sumWin=0,sumLoss=0,best=-1e9,worst=1e9;
  let eq=0,peak=0,maxDD=0,curW=0,curL=0,maxW=0,maxL=0; const eqS=[];
  for(const t of arr){
    const p=t.pnl; net+=p; eq+=p; eqS.push(eq);
    if(eq>peak) peak=eq;
    if(eq-peak<maxDD) maxDD=eq-peak;
    if(p>0){wins++;gw+=p;sumWin+=p;curW++;curL=0;if(curW>maxW)maxW=curW;}
    else if(p<0){losses++;gl+=-p;sumLoss+=p;curL++;curW=0;if(curL>maxL)maxL=curL;}
    else{scratch++;curW=0;curL=0;}
    if(p>best)best=p; if(p<worst)worst=p;
  }
  const n=arr.length;
  return {
    n, net, wins, losses, scratch,
    wr: n?wins/n*100:0,
    exp: n?net/n:0,
    pf: gl>0?gw/gl:(gw>0?Infinity:0),
    avgWin: wins?sumWin/wins:0,
    avgLoss: losses?sumLoss/losses:0,
    payoff: (losses&&sumLoss!==0)?Math.abs((sumWin/Math.max(wins,1))/(sumLoss/losses)):0,
    best: n?best:0, worst: n?worst:0,
    maxDD, maxW, maxL, eqS,
  };
}

function groupNet(arr, keyFn){
  const m=new Map();
  for(const t of arr){
    const k=keyFn(t); if(k===null||k===undefined) continue;
    if(!m.has(k)) m.set(k,{key:k,net:0,n:0,wins:0});
    const g=m.get(k); g.net+=t.pnl; g.n++; if(t.pnl>0)g.wins++;
  }
  return m;
}

// ── math helpers (shared by the pro metrics below) ─────────────────────────
function mean(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
function sd(a){ if(a.length<2) return 0; const m=mean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)*(v-m),0)/(a.length-1)); }
function median(a){ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function pctlOf(sorted,p){ if(!sorted.length) return 0; const i=Math.min(sorted.length-1,Math.max(0,Math.round((sorted.length-1)*p))); return sorted[i]; }
// Abramowitz-Stegun 7.1.26 erf → normal CDF. Only used to turn the expectancy
// t-stat into a p-value, so 1e-7 accuracy is far more than enough.
function normCdf(z){
  const s=z<0?-1:1, x=Math.abs(z)/Math.SQRT2;
  const t=1/(1+0.3275911*x);
  const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);
  return 0.5*(1+s*y);
}
function fld(arr,key){ const o=[]; for(const t of arr){ if(t[key]!==null&&t[key]!==undefined) o.push(t[key]); } return o; }

// One row per trading day — the basis for Sharpe/Sortino (per-trade P&L is not
// a return series; per-day is the closest thing this book has to one).
function daily(arr){
  const m=new Map();
  for(const t of arr){
    if(!t.date) continue;
    if(!m.has(t.date)) m.set(t.date,{date:t.date,net:0,n:0,wins:0});
    const g=m.get(t.date); g.net+=t.pnl; g.n++; if(t.pnl>0) g.wins++;
  }
  return [...m.values()].sort((a,b)=>a.date.localeCompare(b.date));
}

// Risk-adjusted / quality metrics. Anything that cannot be computed from the
// filtered set returns null, and the card renders "—" rather than a fake 0.
const MIN_DAYS=10, MIN_TRADES=20;
function quality(arr,s){
  const d=daily(arr), dn=d.map(x=>x.net);
  const dMu=mean(dn), dSd=sd(dn);
  const neg=dn.filter(v=>v<0);
  const dSdDown=neg.length?Math.sqrt(neg.reduce((a,v)=>a+v*v,0)/neg.length):0;
  const p=arr.map(t=>t.pnl), pSd=sd(p), pMu=mean(p);
  const wr=s.wr/100;
  const durs=fld(arr,'durMin');
  const chg=fld(arr,'charges');
  const costs=chg.reduce((a,v)=>a+v,0);
  const gross=s.net+costs;
  // Sample gates: a ratio built on 2 days or 5 trades is noise dressed as a
  // number, so those cards stay blank until the book is big enough to mean it.
  const okDays=d.length>=MIN_DAYS, okN=arr.length>=MIN_TRADES;
  const t=(okN&&pSd>0)?pMu/(pSd/Math.sqrt(arr.length)):null;
  return {
    days:d.length, daily:d, okDays, okN,
    // ×√252 annualises a daily figure — the convention every broker report uses.
    sharpe:  (okDays&&dSd>0)?dMu/dSd*Math.sqrt(252):null,
    sortino: (okDays&&dSdDown>0)?dMu/dSdDown*Math.sqrt(252):null,
    // Van Tharp SQN — sample capped at 100 so a long book cannot inflate it.
    sqn:     (okN&&pSd>0)?Math.sqrt(Math.min(arr.length,100))*pMu/pSd:null,
    recovery: s.maxDD<0?s.net/Math.abs(s.maxDD):null,
    kelly:   (okN&&s.payoff>0)?(wr-(1-wr)/s.payoff)*100:null,
    tstat:   t,
    pval:    t===null?null:2*(1-normCdf(Math.abs(t))),
    avgHold: durs.length?mean(durs):null,
    medHold: durs.length?median(durs):null,
    costs:   chg.length?costs:null,
    costPct: (chg.length&&gross>0)?costs/gross*100:null,
    bestDay: d.length?Math.max(...dn):0,
    worstDay:d.length?Math.min(...dn):0,
    avgDay:  d.length?dMu:0,
    winDays: d.filter(x=>x.net>0).length,
  };
}
// Edge-quality metrics — the "is this book actually worth trading" set.
// R = the average losing trade, the only risk unit every engine here shares
// (stop-loss is spot-based on some strategies and premium-based on others).
function edgeStats(arr,s,days){
  const R=Math.abs(s.avgLoss)||null;
  const beWR=s.payoff>0?100/(1+s.payoff):null;
  const winners=arr.filter(t=>t.pnl>0).map(t=>t.pnl).sort((a,b)=>b-a);
  const grossWin=winners.reduce((a,v)=>a+v,0);
  const top=winners.slice(0,5), topSum=top.reduce((a,v)=>a+v,0);
  // Equity-curve straightness: R² of a least-squares line through the curve.
  // 0.95+ = steady grind, 0.3 = one lucky trade carrying the whole book.
  let r2=null;
  if(s.eqS.length>=3){
    const n=s.eqS.length; let sx=0,sy=0,sxy=0,sxx=0;
    for(let i=0;i<n;i++){ sx+=i; sy+=s.eqS[i]; sxy+=i*s.eqS[i]; sxx+=i*i; }
    const den=n*sxx-sx*sx;
    if(den!==0){
      const b=(n*sxy-sx*sy)/den, a=(sy-b*sx)/n, ym=sy/n;
      let ssr=0,sst=0;
      for(let i=0;i<n;i++){ const f=a+b*i; ssr+=(s.eqS[i]-f)*(s.eqS[i]-f); sst+=(s.eqS[i]-ym)*(s.eqS[i]-ym); }
      if(sst>0) r2=Math.max(0,1-ssr/sst);
    }
  }
  // Longest run of consecutive red days — what a bad week actually looks like.
  let red=0,maxRed=0;
  for(const d of daily(arr)){ if(d.net<0){ red++; if(red>maxRed) maxRed=red; } else red=0; }
  return {
    R,
    expR:   R?s.exp/R:null,
    beWR,
    edgeGap:beWR===null?null:s.wr-beWR,
    topShare: grossWin>0?topSum/grossWin*100:null,
    netExTop: winners.length?s.net-topSum:null,
    topN:   top.length,
    r2,
    perDay: days?arr.length/days:null,
    maxRed,
  };
}

function sqnGrade(v){
  if(v===null) return '';
  if(v<1.6) return 'poor';
  if(v<2.0) return 'below average';
  if(v<2.5) return 'average';
  if(v<3.0) return 'good';
  if(v<5.0) return 'excellent';
  return 'superb';
}

// Bootstrap Monte Carlo: resample the same trades in random order (with
// replacement) to ask "how much of this curve is the order of the trades?".
// Returns percentile outcomes + a handful of sample paths to draw.
function monteCarlo(arr,sims,paths){
  const p=arr.map(t=>t.pnl), n=p.length;
  if(n<10) return null;
  const finals=[],dds=[],sample=[];
  for(let s=0;s<sims;s++){
    let eq=0,peak=0,dd=0; const path=(s<paths)?[0]:null;
    for(let i=0;i<n;i++){
      eq+=p[(Math.random()*n)|0];
      if(eq>peak) peak=eq;
      if(eq-peak<dd) dd=eq-peak;
      if(path) path.push(eq);
    }
    finals.push(eq); dds.push(dd); if(path) sample.push(path);
  }
  finals.sort((a,b)=>a-b); dds.sort((a,b)=>a-b);
  return {
    sims, n, sample,
    winRate: finals.filter(v=>v>0).length/sims*100,
    p5: pctlOf(finals,0.05), p50: pctlOf(finals,0.50), p95: pctlOf(finals,0.95),
    ddMed: pctlOf(dds,0.50), dd5: pctlOf(dds,0.05),  // dd5 = the bad 1-in-20 drawdown
  };
}

let charts={};
function destroyCharts(){ for(const k in charts){ try{charts[k].destroy();}catch(_){} } charts={}; }

// One breakpoint constant for the JS side: fewer axis ticks on a phone, and a
// re-render when the layout actually crosses the line (not on every resize px).
function MOBILE(){ return window.matchMedia('(max-width:700px)').matches; }

function themed(){
  const light = document.documentElement.getAttribute('data-theme')==='light';
  return { grid: light?'rgba(0,0,0,0.06)':'rgba(255,255,255,0.05)', tick: light?'#64748b':'#4a6080' };
}

function render(){
  const f=currentFilter();
  const arr=applyFilter(f);
  document.getElementById('cntPill').textContent = arr.length+' trades';
  destroyCharts();
  const C=document.getElementById('content');
  if(!arr.length){ C.innerHTML='<div class="empty">No '+f.book+' trades for this filter. Try widening the date range or switching book/strategy.</div>'; return; }
  const s=stats(arr);

  const cards=[
    {l:'Trades',v:s.n,sub:s.wins+'W / '+s.losses+'L'+(s.scratch?' / '+s.scratch+'BE':''),a:'#38bdf8'},
    {l:'Win Rate',v:s.wr.toFixed(1)+'%',sub:'',a:s.wr>=50?'#10b981':'#f59e0b'},
    {l:'Net P&L',v:inr(s.net),sub:'',a:pc(s.net)},
    {l:'Expectancy',v:inr(s.exp),sub:'per trade',a:pc(s.exp)},
    {l:'Profit Factor',v:(s.pf===Infinity?'∞':s.pf.toFixed(2)),sub:'gross win ÷ loss',a:s.pf>=1.5?'#10b981':(s.pf>=1?'#f59e0b':'#ef4444')},
    {l:'Avg Win / Loss',v:inr(s.avgWin)+' / '+inr(s.avgLoss),sub:'payoff '+s.payoff.toFixed(2)+'×',a:'#38bdf8'},
    {l:'Max Drawdown',v:inr(s.maxDD),sub:'peak-to-trough',a:'#ef4444'},
    {l:'Streaks',v:s.maxW+'W / '+s.maxL+'L',sub:'best run / worst run',a:'#a855f7'},
  ];
  let h='<div class="sect">Performance</div>'+cardRow(cards);

  // ── row 2: risk-adjusted quality. Every card carries a plain-English title
  // so a number like "SQN 2.4" is readable without looking it up.
  const q=quality(arr,s);
  const nz=(v,f)=>v===null||v===undefined?'—':f(v);
  // grey accent when the metric is blank, so a "—" card never shows a red bar
  const acc=(v,good,ok)=>v===null||v===undefined?'#3a5070':(v>=good?'#10b981':(v>=ok?'#f59e0b':'#ef4444'));
  const needDays='need '+MIN_DAYS+'+ days', needN='need '+MIN_TRADES+'+ trades';
  h+='<div class="sect">Risk-adjusted</div>'+cardRow([
    {l:'Sharpe',v:nz(q.sharpe,v=>v.toFixed(2)),sub:q.okDays?q.days+' trading days':needDays,a:acc(q.sharpe,1,0),
     t:'Return per unit of swing, annualised from your daily P&L. Above 1 is good, above 2 is very good.'},
    {l:'Sortino',v:nz(q.sortino,v=>v.toFixed(2)),sub:q.okDays?'downside only':needDays,a:acc(q.sortino,1.5,0),
     t:'Like Sharpe but only counts losing days as risk. Higher is better.'},
    {l:'System Quality',v:nz(q.sqn,v=>v.toFixed(2)),sub:q.okN?sqnGrade(q.sqn):needN,a:acc(q.sqn,2,1.6),
     t:'Van Tharp SQN = how big the average trade is compared with how much it varies, scaled by sample size (capped at 100 trades). Below 1.6 = poor, 2.0-2.5 = average, above 3 = excellent.'},
    {l:'Recovery Factor',v:nz(q.recovery,v=>v.toFixed(2)),sub:'net ÷ max drawdown',a:acc(q.recovery,3,1),
     t:'How many times the worst drawdown you earned back. 1.0 means you made exactly what you once lost from the peak.'},
    {l:'Kelly Size',v:nz(q.kelly,v=>v.toFixed(1)+'%'),sub:q.okN?'theoretical max risk':needN,a:q.kelly===null?'#3a5070':(q.kelly>0?'#38bdf8':'#ef4444'),
     t:'Bet size the Kelly formula suggests for this win rate + payoff. Negative means the edge is negative. Traders normally risk a quarter of this.'},
    {l:'Edge Confidence',v:nz(q.pval,v=>(100-v*100).toFixed(1)+'%'),
     sub:q.pval===null?needN:(q.pval<0.05?'likely real edge':'could be luck'),
     a:q.pval===null?'#3a5070':(q.pval<0.05?'#10b981':'#f59e0b'),
     t:'Chance that this expectancy is not just luck (t-test on per-trade P&L). Below 95% means the sample is still too small or too noisy to trust.'},
    {l:'Avg Hold',v:nz(q.avgHold,v=>fmtMin(v)),sub:q.medHold===null?'':'median '+fmtMin(q.medHold),a:'#38bdf8',
     t:'Average time a position stayed open, entry to exit.'},
    {l:'Cost Drag',v:nz(q.costs,v=>inr(v)),sub:q.costPct===null?'not recorded':q.costPct.toFixed(1)+'% of gross',a:q.costs===null?'#3a5070':'#f59e0b',
     t:'Brokerage + taxes already deducted from the P&L above. High % means the edge is being eaten by costs.'},
  ]);

  // ── row 3: edge quality — how much cushion the win rate has, how much of the
  // profit is one lucky tail, and how straight the curve really is.
  const e=edgeStats(arr,s,q.days);
  h+='<div class="sect">Edge quality</div>'+cardRow([
    {l:'Expectancy (R)',v:nz(e.expR,v=>(v>0?'+':'')+v.toFixed(2)+'R'),sub:e.R?'R = avg loss '+inr(e.R):'no losses yet',a:e.expR===null?'#3a5070':pc(e.expR),
     t:'Average trade measured in units of your average loss. +0.30R means each trade earns about a third of a typical loss.'},
    {l:'Break-even WR',v:nz(e.beWR,v=>v.toFixed(1)+'%'),sub:'you have '+s.wr.toFixed(1)+'%',a:'#38bdf8',
     t:'Win rate this payoff needs just to break even. Anything above it is edge.'},
    {l:'Win-rate Cushion',v:nz(e.edgeGap,v=>(v>0?'+':'')+v.toFixed(1)+' pts'),sub:e.edgeGap===null?'':(e.edgeGap>0?'above break-even':'below break-even'),a:e.edgeGap===null?'#3a5070':pc(e.edgeGap),
     t:'How far your win rate sits above the break-even line. A thin cushion means small slippage or cost changes can flip the system.'},
    {l:'Top-'+(e.topN||5)+' Concentration',v:nz(e.topShare,v=>v.toFixed(0)+'%'),sub:'of gross profit',a:e.topShare===null?'#3a5070':(e.topShare>=60?'#ef4444':(e.topShare>=40?'#f59e0b':'#10b981')),
     t:'Share of all profit made by the best few trades. Above 60% means the book is a lottery, not a system.'},
    {l:'Net ex Top-'+(e.topN||5),v:nz(e.netExTop,v=>inr(v)),sub:'if the best never happened',a:e.netExTop===null?'#3a5070':pc(e.netExTop),
     t:'What the book earns with its biggest winners removed. Negative here is the classic right-tail lottery.'},
    {l:'Curve Straightness',v:nz(e.r2,v=>v.toFixed(2)),sub:'R² of equity fit',a:acc(e.r2,0.8,0.5),
     t:'How closely the equity curve follows a straight line. 0.90+ is a steady grind, 0.30 means one trade carried everything.'},
    {l:'Trades / Day',v:nz(e.perDay,v=>v.toFixed(1)),sub:q.days+' trading days',a:'#38bdf8',
     t:'Average number of trades taken on a day the system traded.'},
    {l:'Worst Red Run',v:e.maxRed+(e.maxRed===1?' day':' days'),sub:'consecutive losing days',a:e.maxRed>=4?'#ef4444':(e.maxRed>=3?'#f59e0b':'#10b981'),
     t:'Longest streak of losing days — the run your daily-loss cap and your nerves have to survive.'},
  ]);

  h+='<div class="panel"><h3>Equity Curve (cumulative net P&L · trade-by-trade)</h3><div class="chart-wrap tall"><canvas id="eqChart"></canvas></div></div>';

  h+='<div class="row2">';
  h+='<div class="panel"><h3>Daily P&L</h3><div class="cap">'+q.days+' days · '
    +(q.days?(q.winDays/q.days*100).toFixed(0):0)+'% green days · best '+inr(q.bestDay)
    +' · worst '+inr(q.worstDay)+' · avg '+inr(q.avgDay)+'/day</div>'
    +'<div class="chart-wrap"><canvas id="dayChart"></canvas></div></div>';
  h+='<div class="panel"><h3>Drawdown (underwater — how far below the peak)</h3>'
    +'<div class="cap">Max '+inr(s.maxDD)+' · currently '+inr(curDD(s.eqS))+' below peak</div>'
    +'<div class="chart-wrap"><canvas id="ddChart"></canvas></div></div>';
  h+='</div>';

  h+='<div class="row2">';
  h+='<div class="panel"><h3>P&L by Hour of Day (entry)</h3><div class="chart-wrap"><canvas id="hourChart"></canvas></div></div>';
  h+='<div class="panel"><h3>P&L by Weekday</h3><div class="chart-wrap"><canvas id="dowChart"></canvas></div></div>';
  h+='</div>';

  h+='<div class="row2">';
  h+='<div class="panel"><h3>Weekday × Hour Heatmap (net P&L)</h3>'
    +'<div class="cap">Green = the slot makes money. Tap or hover a cell for trades and win rate.</div>'
    +heatmapHTML(arr)+'</div>';
  h+='<div class="panel"><h3>Monthly P&L</h3>'
    +'<div class="cap">One cell per month, plus the year total — the view a desk reviews on the 1st.</div>'
    +monthlyHTML(arr)+'</div>';
  h+='</div>';

  h+='<div class="row2">';
  h+='<div class="panel"><h3>Trade P&L Distribution</h3><div class="cap">Best '+inr(s.best)+' · worst '+inr(s.worst)
    +' · median '+inr(median(arr.map(t=>t.pnl)))+'</div><div class="chart-wrap"><canvas id="histChart"></canvas></div></div>';
  h+='<div class="panel"><h3>Rolling '+rollWindow(arr.length)+'-Trade Form</h3>'
    +'<div class="cap">Is the edge improving or fading? Blue = expectancy per trade, purple = win rate.</div>'
    +'<div class="chart-wrap"><canvas id="rollChart"></canvas></div></div>';
  h+='</div>';

  h+='<div class="row2">';
  h+='<div class="panel"><h3>R-Multiple Distribution</h3>'
    +'<div class="cap">'+(e.R?'1R = your average loss ('+inr(e.R)+'). A healthy book has a fat +2R and beyond tail.':'No losing trades yet — R cannot be set.')+'</div>'
    +'<div class="chart-wrap"><canvas id="rChart"></canvas></div></div>';
  h+='<div class="panel"><h3>Nth Trade of the Day</h3>'
    +'<div class="cap">Does the day get worse after the first entries? This is the cut that justifies a trade cap.</div>'
    +seqTable(arr)+'</div>';
  h+='</div>';

  h+='<div class="row2">';
  h+='<div class="panel"><h3>Trade Efficiency (MFE / MAE)</h3>'+efficiencyHTML(arr)
    +'<div class="chart-wrap short"><canvas id="maeChart"></canvas></div></div>';
  h+='<div class="panel"><h3>Monte Carlo (1,000 reshuffles of these trades)</h3>'+mcHTML(arr)+'</div>';
  h+='</div>';

  // per-strategy table (only when viewing All)
  h+='<div class="row2">';
  h+='<div class="panel"><h3>By Strategy</h3>'+modeTable(arr)+'</div>';
  h+='<div class="panel"><h3>By Exit Reason</h3>'+reasonTable(arr)+'</div>';
  h+='</div>';

  h+='<div class="row3">';
  h+='<div class="panel"><h3>By Side</h3>'+bucketTable('side',arr,t=>t.side||'—',null)+'</div>';
  h+='<div class="panel"><h3>By Hold Time</h3>'+bucketTable('hold',arr,t=>holdBucket(t.durMin),HOLD_ORDER)+'</div>';
  h+='<div class="panel"><h3>By Signal Strength</h3>'+bucketTable('strength',arr,t=>t.strength||'—',null)+'</div>';
  h+='</div>';

  h+='<div class="row2">';
  h+='<div class="panel"><h3>By VIX at Entry</h3>'+bucketTable('vix',arr,t=>vixBucket(t.vix),VIX_ORDER)+'</div>';
  h+='<div class="panel"><h3>Biggest Winners &amp; Losers</h3>'+extremesHTML(arr)+'</div>';
  h+='</div>';

  C.innerHTML=h;

  paintTable('mode');
  paintTable('reason');
  paintTable('seq');
  paintTable('side');
  paintTable('hold');
  paintTable('strength');
  paintTable('vix');
  drawEquity(s.eqS);
  drawDaily(q.daily);
  drawDrawdown(s.eqS);
  drawHour(arr);
  drawDow(arr);
  drawHist(arr);
  drawRolling(arr);
  drawR(arr,e.R);
  drawMae(arr);
  drawMC(arr);
}

function cardRow(cards){
  let h='<div class="stat-grid">';
  for(const c of cards) h+='<div class="sc" style="--accent:'+c.a+'"'+(c.t?' title="'+esc(c.t)+'"':'')
    +'><div class="sc-label">'+c.l+'</div><div class="sc-val" style="color:'+c.a+'">'+c.v+'</div><div class="sc-sub">'+c.sub+'</div></div>';
  return h+'</div>';
}
function fmtMin(m){ if(m===null||m===undefined) return '—'; if(m<60) return Math.round(m)+'m'; const hh=Math.floor(m/60); return hh+'h '+Math.round(m-hh*60)+'m'; }

// ── pagination ─────────────────────────────────────────────────────────────
// Tables can grow unbounded (By Exit Reason has one row per distinct reason
// string), so each is rendered a page at a time. Rows are computed once per
// filter change and held here; paging only re-paints its own wrapper, never
// re-runs stats(). Page resets to 1 whenever render() rebuilds the tables.
const PAGE_SIZE = 10;
const TBL = {};

function registerTable(key, head, rows, rowFn){
  TBL[key] = { head, rows, rowFn, page: 1 };
  return '<div id="tw-'+key+'"></div>';
}

function paintTable(key){
  const t = TBL[key];
  const el = document.getElementById('tw-'+key);
  if(!t || !el) return;
  const total = t.rows.length;
  const pages = Math.max(1, Math.ceil(total/PAGE_SIZE));
  if(t.page > pages) t.page = pages;
  if(t.page < 1)     t.page = 1;
  const start = (t.page-1)*PAGE_SIZE;
  const slice = t.rows.slice(start, start+PAGE_SIZE);

  let h='<div class="tblwrap"><table class="tbl"><thead><tr>'+t.head+'</tr></thead><tbody>';
  for(const r of slice) h+=t.rowFn(r);
  h+='</tbody></table></div>';
  if(total > PAGE_SIZE){
    const first = t.page===1, last = t.page===pages;
    h+='<div class="pager">'
      +'<span class="pg-info">'+(start+1)+'–'+Math.min(start+PAGE_SIZE,total)+' of '+total+'</span>'
      +'<button class="pg-btn" data-pg="'+key+'" data-go="1"'+(first?' disabled':'')+' title="First">«</button>'
      +'<button class="pg-btn" data-pg="'+key+'" data-go="'+(t.page-1)+'"'+(first?' disabled':'')+' title="Previous">‹</button>'
      +'<span class="pg-num">'+t.page+' / '+pages+'</span>'
      +'<button class="pg-btn" data-pg="'+key+'" data-go="'+(t.page+1)+'"'+(last?' disabled':'')+' title="Next">›</button>'
      +'<button class="pg-btn" data-pg="'+key+'" data-go="'+pages+'"'+(last?' disabled':'')+' title="Last">»</button>'
      +'</div>';
  }
  el.innerHTML = h;
}

// Delegated so the buttons survive every innerHTML rebuild of #content.
document.getElementById('content').addEventListener('click', e=>{
  const b = e.target.closest('.pg-btn');
  if(!b || b.disabled) return;
  const t = TBL[b.dataset.pg];
  if(!t) return;
  t.page = +b.dataset.go;
  paintTable(b.dataset.pg);
});

function modeTable(arr){
  const m=new Map();
  for(const t of arr){ if(!m.has(t.mode)) m.set(t.mode,[]); m.get(t.mode).push(t); }
  const rows=[...m.entries()].map(([mode,ts])=>({mode,s:stats(ts)})).sort((a,b)=>b.s.net-a.s.net);
  return registerTable('mode',
    '<th>Strategy</th><th>Trades</th><th>WR</th><th>Net</th><th>Exp</th><th>PF</th>',
    rows,
    r=>'<tr><td><span class="badge-mode badge-'+r.mode+'">'+r.mode+'</span></td>'
      +'<td>'+r.s.n+'</td><td>'+r.s.wr.toFixed(0)+'%</td>'
      +'<td style="color:'+pc(r.s.net)+'">'+sign(r.s.net)+inr(r.s.net)+'</td>'
      +'<td style="color:'+pc(r.s.exp)+'">'+inr(r.s.exp)+'</td>'
      +'<td>'+(r.s.pf===Infinity?'∞':r.s.pf.toFixed(2))+'</td></tr>');
}

function reasonTable(arr){
  const m=groupNet(arr, t=>t.exitReason||'—');
  const rows=[...m.values()].sort((a,b)=>a.net-b.net); // worst first — find the bleed
  return registerTable('reason',
    '<th>Exit Reason</th><th>N</th><th>WR</th><th>Net</th><th>Avg</th>',
    rows,
    r=>'<tr><td title="'+esc(r.key)+'">'+esc(r.key.length>26?r.key.slice(0,26)+'…':r.key)+'</td>'
      +'<td>'+r.n+'</td><td>'+(r.n?(r.wins/r.n*100).toFixed(0):0)+'%</td>'
      +'<td style="color:'+pc(r.net)+'">'+sign(r.net)+inr(r.net)+'</td>'
      +'<td style="color:'+pc(r.net/r.n)+'">'+inr(r.net/r.n)+'</td></tr>');
}

function drawEquity(eqS){
  const th=themed();
  charts.eq=new Chart(document.getElementById('eqChart'),{
    type:'line',
    data:{ labels:eqS.map((_,i)=>i+1), datasets:[{
      data:eqS, borderColor:'#38bdf8', borderWidth:2, pointRadius:0, tension:0.15,
      fill:true, backgroundColor:(ctx)=>{ const g=ctx.chart.ctx.createLinearGradient(0,0,0,300); g.addColorStop(0,'rgba(56,189,248,0.25)'); g.addColorStop(1,'rgba(56,189,248,0)'); return g; },
    }]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{title:i=>'Trade #'+i[0].label, label:c=>'Equity: '+inr(c.parsed.y)}}},
      scales:{ x:{grid:{color:th.grid},ticks:{color:th.tick,maxTicksLimit:MOBILE()?6:12}}, y:{grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}} } }
  });
}

function barColors(vals){ return vals.map(v=>v>=0?'rgba(16,185,129,0.65)':'rgba(239,68,68,0.65)'); }

function drawHour(arr){
  const th=themed();
  const m=groupNet(arr, t=>entryHour(t.entryTime));
  const hours=[...m.keys()].sort((a,b)=>a-b);
  const net=hours.map(h=>m.get(h).net);
  charts.hour=new Chart(document.getElementById('hourChart'),{
    type:'bar',
    data:{ labels:hours.map(h=>String(h).padStart(2,'0')+':00'), datasets:[{data:net,backgroundColor:barColors(net)}]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>{const g=m.get(hours[c.dataIndex]); return [inr(g.net),g.n+' trades · '+(g.wins/g.n*100).toFixed(0)+'% WR'];}}}},
      scales:{ x:{grid:{display:false},ticks:{color:th.tick}}, y:{grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}} } }
  });
}

function drawDow(arr){
  const th=themed();
  const m=groupNet(arr, t=>weekday(t.date));
  const days=[1,2,3,4,5].filter(d=>m.has(d)); // Mon–Fri (drop empty)
  const net=days.map(d=>m.get(d).net);
  charts.dow=new Chart(document.getElementById('dowChart'),{
    type:'bar',
    data:{ labels:days.map(d=>DOW[d]), datasets:[{data:net,backgroundColor:barColors(net)}]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>{const g=m.get(days[c.dataIndex]); return [inr(g.net),g.n+' trades · '+(g.wins/g.n*100).toFixed(0)+'% WR'];}}}},
      scales:{ x:{grid:{display:false},ticks:{color:th.tick}}, y:{grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}} } }
  });
}

// ── new panels ─────────────────────────────────────────────────────────────
function shortInr(n){
  const v=Math.round(n), a=Math.abs(v);
  if(a>=1000) return (v<0?'-':'')+'₹'+(a/1000).toFixed(a>=10000?0:1)+'k';
  return inr(v);
}
function underwater(eqS){
  const out=[]; let peak=0;
  for(const e of eqS){ if(e>peak) peak=e; out.push(e-peak); }
  return out;
}
function curDD(eqS){ const u=underwater(eqS); return u.length?u[u.length-1]:0; }
function rollWindow(n){ return n>=100?20:(n>=40?10:5); }

const HOLD_ORDER=['< 5m','5-15m','15-30m','30-60m','> 60m','—'];
function holdBucket(m){
  if(m===null||m===undefined) return '—';
  if(m<5) return '< 5m';
  if(m<15) return '5-15m';
  if(m<30) return '15-30m';
  if(m<60) return '30-60m';
  return '> 60m';
}
const VIX_ORDER=['< 12','12-15','15-18','18-22','> 22','—'];
function vixBucket(v){
  if(v===null||v===undefined) return '—';
  if(v<12) return '< 12';
  if(v<15) return '12-15';
  if(v<18) return '15-18';
  if(v<22) return '18-22';
  return '> 22';
}

// Generic "slice the book by one dimension" table — side, hold time, VIX,
// signal strength all share the same five columns.
function bucketTable(key,arr,keyFn,order){
  const m=groupNet(arr,keyFn);
  let rows=[...m.values()];
  if(order) rows.sort((a,b)=>order.indexOf(a.key)-order.indexOf(b.key));
  else      rows.sort((a,b)=>b.net-a.net);
  return registerTable(key,
    '<th>Bucket</th><th>N</th><th>WR</th><th>Net</th><th>Avg</th>',
    rows,
    r=>'<tr><td>'+esc(r.key)+'</td><td>'+r.n+'</td>'
      +'<td>'+(r.n?(r.wins/r.n*100).toFixed(0):0)+'%</td>'
      +'<td style="color:'+pc(r.net)+'">'+sign(r.net)+inr(r.net)+'</td>'
      +'<td style="color:'+pc(r.net/r.n)+'">'+inr(r.net/r.n)+'</td></tr>');
}

function extremesHTML(arr){
  const sorted=[...arr].sort((a,b)=>b.pnl-a.pnl);
  // Under 10 trades the top-5 and bottom-5 slices overlap, so list the book once.
  const split=sorted.length>10;
  const top=split?sorted.slice(0,5):sorted, bot=split?sorted.slice(-5).reverse():[];
  const row=t=>'<tr><td>'+esc(t.date)+'</td>'
    +'<td style="text-align:left">'+esc(t.mode)+' '+esc(t.side)+'</td>'
    +'<td style="text-align:left" title="'+esc(t.exitReason)+'">'+esc(t.exitReason.length>22?t.exitReason.slice(0,22)+'…':t.exitReason)+'</td>'
    +'<td style="color:'+pc(t.pnl)+'">'+sign(t.pnl)+inr(t.pnl)+'</td></tr>';
  let h='<div class="tblwrap"><table class="tbl"><thead><tr><th>Date</th><th style="text-align:left">Trade</th><th style="text-align:left">Exit</th><th>P&L</th></tr></thead><tbody>';
  for(const t of top) h+=row(t);
  if(bot.length) h+='<tr><td colspan="4" style="color:var(--muted-2,#6d85a8);text-align:center;font-size:0.6rem;letter-spacing:1px;">WORST</td></tr>';
  for(const t of bot) h+=row(t);
  return h+'</tbody></table></div>';
}

// MFE = best the trade ever was, MAE = worst it ever was (spot points / ₹,
// captured tick-by-tick by every engine). Together they say whether exits are
// too early, stops too tight, or winners handed back.
function efficiencyHTML(arr){
  const mfe=arr.filter(t=>t.mfePts!==null), mae=arr.filter(t=>t.maePts!==null);
  if(!mfe.length&&!mae.length) return '<div class="cap">No MFE/MAE recorded for these trades.</div>';
  const cap=arr.filter(t=>t.mfePts!==null&&t.pts!==null&&t.mfePts>0);
  const capPct=cap.length?cap.reduce((a,t)=>a+t.pts,0)/cap.reduce((a,t)=>a+t.mfePts,0)*100:null;
  const winners=arr.filter(t=>t.pnl>0), losers=arr.filter(t=>t.pnl<0);
  const wLeft=winners.filter(t=>t.mfeRs!==null);
  const left=wLeft.reduce((a,t)=>a+Math.max(0,t.mfeRs-t.pnl),0);
  const wasGreen=losers.filter(t=>t.mfeRs!==null?t.mfeRs>0:(t.mfePts!==null&&t.mfePts>0));
  const winHeat=winners.filter(t=>t.maePts!==null).map(t=>Math.abs(t.maePts));
  const loseMfe=losers.filter(t=>t.mfePts!==null).map(t=>t.mfePts);
  const cell=(k,v,t)=>'<div'+(t?' title="'+esc(t)+'"':'')+'><div class="k">'+k+'</div><div class="v">'+v+'</div></div>';
  return '<div class="mini">'
    +cell('Avg MFE',mfe.length?mean(mfe.map(t=>t.mfePts)).toFixed(1)+' pts':'—','Average best-case move in your favour while the trade was open.')
    +cell('Avg MAE',mae.length?mean(mae.map(t=>Math.abs(t.maePts))).toFixed(1)+' pts':'—','Average heat — how far the trade went against you before closing.')
    +cell('Capture',capPct===null?'—':capPct.toFixed(0)+'%','Share of the favourable move you actually kept. Under ~35% usually means exits are late or trails are loose.')
    +cell('Left on Table',wLeft.length?inr(left):'—','Total ₹ that winners gave back from their peak (only engines that log peak ₹).')
    +cell('Losers Once Green',losers.length?wasGreen.length+' / '+losers.length:'—','Losing trades that were in profit at some point — candidates for a breakeven stop.')
    +cell('Winners\\' Heat',winHeat.length?median(winHeat).toFixed(1)+' pts':'—','Median drawdown a winning trade survived. Your stop must be wider than this.')
    +cell('Loser Peak',loseMfe.length?median(loseMfe).toFixed(1)+' pts':'—','Median best move a losing trade reached before dying.')
    +cell('Scratch Rate',arr.length?(arr.filter(t=>t.pnl===0).length/arr.length*100).toFixed(0)+'%':'—','Share of trades that closed flat.')
    +'</div>';
}

let MC=null;
function mcHTML(arr){
  MC=monteCarlo(arr,1000,30);
  if(!MC) return '<div class="cap">Needs at least 10 trades in the filter.</div>';
  const cell=(k,v,c,t)=>'<div'+(t?' title="'+esc(t)+'"':'')+'><div class="k">'+k+'</div><div class="v"'+(c?' style="color:'+c+'"':'')+'>'+v+'</div></div>';
  return '<div class="cap">Same trades, random order, 1,000 times — shows how much of the curve was luck.</div>'
    +'<div class="mini">'
    +cell('Profitable Runs',MC.winRate.toFixed(0)+'%',MC.winRate>=80?'#10b981':(MC.winRate>=60?'#f59e0b':'#ef4444'),'How often the reshuffled book ended in profit. Under 80% means the edge is fragile.')
    +cell('Median Outcome',inr(MC.p50),pc(MC.p50),'The middle result across all 1,000 runs.')
    +cell('Bad Run (5%)',inr(MC.p5),pc(MC.p5),'1-in-20 worst final P&L — plan capital for this, not the median.')
    +cell('Expected Max DD',inr(MC.ddMed),'#ef4444','Typical worst peak-to-trough dip. Your 1-in-20 case is '+inr(MC.dd5)+'.')
    +'</div><div class="chart-wrap short"><canvas id="mcChart"></canvas></div>';
}

// Entry order within a day. Trades arrive grouped by file, so they are sorted
// by entry clock here — "the 3rd trade of the day" must mean the same thing
// whether it came from BB_RSI or ORB.
const SEQ_ORDER=['1st','2nd','3rd','4th','5th+'];
function seqTable(arr){
  const byDay=new Map();
  for(const t of arr){
    if(!t.date) continue;
    if(!byDay.has(t.date)) byDay.set(t.date,[]);
    byDay.get(t.date).push(t);
  }
  const seq=new Map();
  for(const list of byDay.values()){
    const ordered=[...list].sort((a,b)=>{
      const ma=entryMins(a.entryTime), mb=entryMins(b.entryTime);
      if(ma===null&&mb===null) return 0;
      if(ma===null) return 1;
      if(mb===null) return -1;
      return ma-mb;
    });
    ordered.forEach((t,i)=>seq.set(t,SEQ_ORDER[Math.min(i,4)]));
  }
  return bucketTable('seq',arr,t=>seq.get(t)||'—',SEQ_ORDER.concat('—'));
}

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monthlyHTML(arr){
  const cells=new Map();   // 'YYYY-M' -> {net,n,wins}
  const years=new Set();
  for(const t of arr){
    if(!t.date||t.date.length<7) continue;
    const y=+t.date.slice(0,4), mo=+t.date.slice(5,7)-1;
    if(!(y>0)||!(mo>=0&&mo<=11)) continue;
    years.add(y);
    const k=y+'-'+mo;
    if(!cells.has(k)) cells.set(k,{net:0,n:0,wins:0});
    const g=cells.get(k); g.net+=t.pnl; g.n++; if(t.pnl>0) g.wins++;
  }
  if(!cells.size) return '<div class="cap">No dated trades in this filter.</div>';
  let maxAbs=0;
  for(const g of cells.values()) maxAbs=Math.max(maxAbs,Math.abs(g.net));
  let h='<div style="overflow-x:auto"><table class="hm"><thead><tr><th></th>';
  for(const m of MONTHS) h+='<th>'+m+'</th>';
  h+='<th>Year</th></tr></thead><tbody>';
  for(const y of [...years].sort()){
    h+='<tr><td class="rowlab">'+y+'</td>';
    let yNet=0,yN=0;
    for(let mo=0;mo<12;mo++){
      const g=cells.get(y+'-'+mo);
      if(!g){ h+='<td class="void">·</td>'; continue; }
      yNet+=g.net; yN+=g.n;
      const a=0.12+0.55*(maxAbs?Math.abs(g.net)/maxAbs:0);
      const bg=g.net>=0?'rgba(16,185,129,'+a.toFixed(2)+')':'rgba(239,68,68,'+a.toFixed(2)+')';
      h+='<td style="background:'+bg+'" title="'+MONTHS[mo]+' '+y+' — '+inr(g.net)+' · '+g.n+' trades · '
        +(g.wins/g.n*100).toFixed(0)+'% WR">'+shortInr(g.net)+'</td>';
    }
    h+='<td style="font-weight:700;color:'+pc(yNet)+'" title="'+y+' total — '+inr(yNet)+' · '+yN+' trades">'+shortInr(yNet)+'</td></tr>';
  }
  return h+'</tbody></table></div>';
}

function drawR(arr,R){
  const el=document.getElementById('rChart');
  if(!el||!R) return;
  const th=themed();
  const labels=['≤ -3R','-3..-2R','-2..-1R','-1..0R','0..1R','1..2R','2..3R','≥ 3R'];
  const counts=new Array(8).fill(0);
  for(const t of arr){
    const r=t.pnl/R;
    let i;
    if(r<=-3) i=0; else if(r<-2) i=1; else if(r<-1) i=2; else if(r<0) i=3;
    else if(r<1) i=4; else if(r<2) i=5; else if(r<3) i=6; else i=7;
    counts[i]++;
  }
  charts.r=new Chart(el,{
    type:'bar',
    data:{ labels, datasets:[{data:counts,backgroundColor:labels.map((_,i)=>i<4?'rgba(239,68,68,0.65)':'rgba(16,185,129,0.65)')}]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>c.parsed.y+' trades'}}},
      scales:{ x:{grid:{display:false},ticks:{color:th.tick,maxRotation:60,autoSkip:true,maxTicksLimit:MOBILE()?5:8}},
               y:{grid:{color:th.grid},ticks:{color:th.tick,precision:0}} } }
  });
}

function heatmapHTML(arr){
  const cells=new Map(); let maxAbs=0;
  for(const t of arr){
    const d=weekday(t.date), hr=entryHour(t.entryTime);
    if(d===null||hr===null||d<1||d>5) continue;
    const k=d+'|'+hr;
    if(!cells.has(k)) cells.set(k,{net:0,n:0,wins:0});
    const g=cells.get(k); g.net+=t.pnl; g.n++; if(t.pnl>0) g.wins++;
  }
  if(!cells.size) return '<div class="cap">No entry times recorded for these trades.</div>';
  const hours=[...new Set([...cells.keys()].map(k=>+k.split('|')[1]))].sort((a,b)=>a-b);
  for(const g of cells.values()) maxAbs=Math.max(maxAbs,Math.abs(g.net));
  let h='<div style="overflow-x:auto"><table class="hm"><thead><tr><th></th>';
  for(const hr of hours) h+='<th>'+String(hr).padStart(2,'0')+'</th>';
  h+='</tr></thead><tbody>';
  for(const d of [1,2,3,4,5]){
    if(!hours.some(hr=>cells.has(d+'|'+hr))) continue;
    h+='<tr><td class="rowlab">'+DOW[d]+'</td>';
    for(const hr of hours){
      const g=cells.get(d+'|'+hr);
      if(!g){ h+='<td class="void">·</td>'; continue; }
      const a=0.12+0.55*(maxAbs?Math.abs(g.net)/maxAbs:0);
      const bg=g.net>=0?'rgba(16,185,129,'+a.toFixed(2)+')':'rgba(239,68,68,'+a.toFixed(2)+')';
      h+='<td style="background:'+bg+'" title="'+DOW[d]+' '+String(hr).padStart(2,'0')+':00 — '+inr(g.net)
        +' · '+g.n+' trades · '+(g.wins/g.n*100).toFixed(0)+'% WR">'+shortInr(g.net)+'</td>';
    }
    h+='</tr>';
  }
  return h+'</tbody></table></div>';
}

function drawDaily(d){
  const th=themed();
  const net=d.map(x=>x.net);
  charts.day=new Chart(document.getElementById('dayChart'),{
    type:'bar',
    data:{ labels:d.map(x=>x.date.slice(8,10)+'/'+x.date.slice(5,7)), datasets:[{data:net,backgroundColor:barColors(net)}]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>{const g=d[c.dataIndex]; return [inr(g.net),g.n+' trades · '+(g.wins/g.n*100).toFixed(0)+'% WR'];}}}},
      scales:{ x:{grid:{display:false},ticks:{color:th.tick,maxTicksLimit:MOBILE()?7:14}}, y:{grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}} } }
  });
}

function drawDrawdown(eqS){
  const th=themed(), u=underwater(eqS);
  charts.dd=new Chart(document.getElementById('ddChart'),{
    type:'line',
    data:{ labels:u.map((_,i)=>i+1), datasets:[{data:u,borderColor:'#ef4444',borderWidth:1.5,pointRadius:0,tension:0.1,
      fill:true,backgroundColor:'rgba(239,68,68,0.18)'}]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{title:i=>'Trade #'+i[0].label,label:c=>'Below peak: '+inr(c.parsed.y)}}},
      scales:{ x:{grid:{color:th.grid},ticks:{color:th.tick,maxTicksLimit:MOBILE()?6:12}}, y:{grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}} } }
  });
}

function drawHist(arr){
  const th=themed(), p=arr.map(t=>t.pnl);
  const lo=Math.min(...p), hi=Math.max(...p);
  const bins=Math.min(20,Math.max(6,Math.ceil(Math.sqrt(p.length))));
  const w=(hi-lo)/bins||1;
  const counts=new Array(bins).fill(0), labels=[];
  for(let i=0;i<bins;i++) labels.push(shortInr(lo+i*w)+'…'+shortInr(lo+(i+1)*w));
  for(const v of p){ let i=Math.floor((v-lo)/w); if(i>=bins) i=bins-1; if(i<0) i=0; counts[i]++; }
  const mids=labels.map((_,i)=>lo+(i+0.5)*w);
  charts.hist=new Chart(document.getElementById('histChart'),{
    type:'bar',
    data:{ labels, datasets:[{data:counts,backgroundColor:mids.map(m=>m>=0?'rgba(16,185,129,0.65)':'rgba(239,68,68,0.65)')}]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>c.parsed.y+' trades'}}},
      scales:{ x:{grid:{display:false},ticks:{color:th.tick,maxRotation:60,minRotation:0,autoSkip:true,maxTicksLimit:MOBILE()?5:10}},
               y:{grid:{color:th.grid},ticks:{color:th.tick,precision:0}} } }
  });
}

function drawRolling(arr){
  const th=themed(), w=rollWindow(arr.length);
  if(arr.length<w) return;
  const exp=[],wr=[],lab=[];
  let sum=0,wins=0;
  for(let i=0;i<arr.length;i++){
    sum+=arr[i].pnl; if(arr[i].pnl>0) wins++;
    if(i>=w){ sum-=arr[i-w].pnl; if(arr[i-w].pnl>0) wins--; }
    if(i>=w-1){ exp.push(sum/w); wr.push(wins/w*100); lab.push(i+1); }
  }
  charts.roll=new Chart(document.getElementById('rollChart'),{
    type:'line',
    data:{ labels:lab, datasets:[
      {label:'Expectancy',data:exp,borderColor:'#38bdf8',borderWidth:2,pointRadius:0,tension:0.2,yAxisID:'y'},
      {label:'Win rate',data:wr,borderColor:'#a855f7',borderWidth:1.5,pointRadius:0,tension:0.2,borderDash:[4,3],yAxisID:'y1'}]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{labels:{color:th.tick,boxWidth:10,font:{size:10}}},
      tooltip:{callbacks:{title:i=>'Trade #'+i[0].label,
        label:c=>c.datasetIndex===0?('Expectancy: '+inr(c.parsed.y)):('Win rate: '+c.parsed.y.toFixed(0)+'%')}}},
      scales:{ x:{grid:{color:th.grid},ticks:{color:th.tick,maxTicksLimit:MOBILE()?5:10}},
               y:{position:'left',grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}},
               y1:{position:'right',min:0,max:100,grid:{display:false},ticks:{color:th.tick,callback:v=>v+'%'}} } }
  });
}

function drawMae(arr){
  const th=themed();
  const pts=arr.filter(t=>t.maePts!==null);
  if(!pts.length) return;
  const mk=t=>({x:Math.abs(t.maePts),y:t.pnl});
  charts.mae=new Chart(document.getElementById('maeChart'),{
    type:'scatter',
    data:{ datasets:[
      {label:'Winners',data:pts.filter(t=>t.pnl>0).map(mk),backgroundColor:'rgba(16,185,129,0.6)',pointRadius:3},
      {label:'Losers', data:pts.filter(t=>t.pnl<=0).map(mk),backgroundColor:'rgba(239,68,68,0.6)',pointRadius:3}]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{labels:{color:th.tick,boxWidth:10,font:{size:10}}},
      tooltip:{callbacks:{label:c=>'Heat '+c.parsed.x.toFixed(1)+' pts → '+inr(c.parsed.y)}}},
      scales:{ x:{title:{display:true,text:'Heat taken (adverse points)',color:th.tick,font:{size:9}},grid:{color:th.grid},ticks:{color:th.tick}},
               y:{grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}} } }
  });
}

function drawMC(){
  if(!MC) return;
  const th=themed();
  const ds=MC.sample.map(p=>({data:p,borderColor:'rgba(125,211,252,0.16)',borderWidth:1,pointRadius:0,tension:0.1,fill:false}));
  charts.mc=new Chart(document.getElementById('mcChart'),{
    type:'line',
    data:{ labels:MC.sample.length?MC.sample[0].map((_,i)=>i):[], datasets:ds },
    options:{ responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{legend:{display:false},tooltip:{enabled:false}},
      scales:{ x:{grid:{color:th.grid},ticks:{color:th.tick,maxTicksLimit:8}},
               y:{grid:{color:th.grid},ticks:{color:th.tick,callback:v=>inr(v)}} } }
  });
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
let _wasMobile=MOBILE();
window.addEventListener('resize',()=>{
  const m=MOBILE();
  if(m!==_wasMobile){ _wasMobile=m; render(); }   // tick density differs per layout
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

// Exported so settingsAdvisor.js analyses exactly the trade set this page shows.
// Same reasoning as consolidation.js → consolidatedEodReporter.js: one loader, so
// the page and the advisor can never disagree about what a trade is.
module.exports.loadAllTrades = loadAllTrades;

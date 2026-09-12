/**
 * Losses Analyzer — every losing trade, one expandable row each, with the full
 * signal / entry / exit / indicator picture behind it.
 *
 * Read-only. Loads the same per-strategy session files that /consolidation (paper)
 * and /live-consolidation (live) use — but unlike /edge-analytics, which reduces
 * each trade to the handful of numbers its metrics need, this page keeps the whole
 * record: entry + exit reason, spot/premium legs, stop levels, excursions and every
 * *AtEntry / *AtExit indicator each engine chose to write. Only losses are kept, so
 * the payload stays comparable to the other pages despite the wider rows.
 *
 * The question it answers is *why* a loss happened, not how many there were, so
 * each loss is classified from its own excursion record:
 *
 *   WRONG ENTRY   — barely went favourable at all (MFE below the "worked" floor).
 *                   The signal was wrong; it went against the trade from the start.
 *   GAVE IT BACK  — MFE cleared the floor and was worth real money, then the exit
 *                   still landed in the red. The signal was right, the exit was late.
 *   STOPPED OUT   — went favourable, but never enough to be worth protecting before
 *                   the stop took it.
 *   NO EXCURSION  — the engine did not record MFE/MAE for this trade, so no verdict
 *                   is claimed. Shown as unclassified rather than guessed at.
 *
 * "Barely" is a threshold, not a fact, so it is a control on the page (MFE floor in
 * spot points, and the ₹ a give-back must have been worth) rather than a constant
 * baked into the verdict — a 5-point floor means something different on BANKNIFTY
 * than on NIFTY, and the reader can see and move it.
 *
 * Everything computes client-side from an embedded array, so the Book / Strategy /
 * Range / Side / Reason / Verdict filters recompute with no server round-trip —
 * matching /consolidation-report, whose toolbar this page mirrors.
 *
 * Gated by UI_SHOW_LOSSES_ANALYZER (Settings → Menu Visibility). No new data is written.
 */
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { buildSidebar, sidebarCSS, faviconLink, enabledStrategies,
        dateRangeOptionsHTML, dateRangeJS,
        multiSelectCSS, multiSelectHTML, multiSelectJS } = require("../utils/sharedNav");
const { resolveTheme } = require("../utils/theme");
const { istDayFromAny } = require("../utils/tradeUtils");

const _HOME = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");

// Mirror the source maps used by consolidation.js (paper) + liveConsolidation.js (live).
const PAPER_SOURCES = [
  { mode: "EMA_RSI_ST",       file: "ema_rsi_st_paper_trades.json" },
  { mode: "EMA_RSI_ST_V2",    file: "ema_rsi_st_v2_paper_trades.json" },
  { mode: "BN_EMA_RSI_ST_V2", file: "bn_ema_rsi_st_v2_paper_trades.json" },
  { mode: "BB_RSI",           file: "bb_rsi_paper_trades.json" },
  { mode: "PA",               file: "pa_paper_trades.json" },
  { mode: "ORB",              file: "orb_paper_trades.json" },
  { mode: "EMA9VWAP",         file: "ema9vwap_paper_trades.json" },
  { mode: "TREND_PB",         file: "trend_pb_paper_trades.json" },
  { mode: "TDS",              file: "trend_day_scalp_paper_trades.json" },
  { mode: "HA_SCALP",         file: "ha_scalp_paper_trades.json" },
  { mode: "RSI_PIVOT_ST",     file: "rsi_pivot_st_paper_trades.json" },
  { mode: "BN_PIVOT_RSI_ST",  file: "bn_pivot_rsi_st_paper_trades.json" },
  { mode: "SIMPLE930",        file: "simple930_paper_trades.json" },
  { mode: "EARLYBIRD",        file: "early_bird_paper_trades.json" },
];
const LIVE_SOURCES = PAPER_SOURCES.map(s => ({
  mode: s.mode, file: s.file.replace("_paper_trades.json", "_live_trades.json"),
}));

function safeRead(p) {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) { return {}; }
}

// null (not 0) means "not recorded" — the client renders those as "—" and excludes
// them from averages rather than silently folding a zero in.
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function round(v, d) { const n = num(v); return n === null ? null : Math.round(n * Math.pow(10, d)) / Math.pow(10, d); }

// Indicator fields are per-engine: BB_RSI writes bbUpperAtEntry, PA writes
// patternAtEntry, TREND_PB writes atr5AtEntry. Rather than maintain a union of
// every engine's field list (which silently drops a field the day an engine adds
// one), harvest anything matching *AtEntry / *AtExit off the record itself and let
// the client group it. The keys below are lifted out by name first, so they are
// not duplicated into the generic bucket.
const LIFTED = new Set([
  "vixAtEntry", "vixAtExit", "oiAtEntry", "spotAtEntry", "spotAtExit",
]);
const IND_RE = /^(.*?)At(Entry|Exit)$/;

/** Pull every *AtEntry / *AtExit field an engine recorded → { entry:{}, exit:{} }. */
function harvestIndicators(t) {
  const entry = {}, exit = {};
  for (const k of Object.keys(t)) {
    if (LIFTED.has(k)) continue;
    const m = IND_RE.exec(k);
    if (!m) continue;
    const v = t[k];
    if (v === null || v === undefined || v === "") continue;
    const bucket = m[2] === "Entry" ? entry : exit;
    // Numbers get rounded for payload size; strings (stTrend, pattern, regime) pass through.
    bucket[m[1]] = (typeof v === "number") ? round(v, 2) : String(v);
  }
  return { entry, exit };
}

function loadBook(sources, book) {
  const out = [];
  for (const src of sources) {
    const data = safeRead(path.join(DATA_DIR, src.file));
    for (const s of (data.sessions || [])) {
      const sessionDate = istDayFromAny(s.date);
      for (const t of (s.trades || [])) {
        const pnl = Number(t.pnl) || 0;
        if (!(pnl < 0)) continue;   // losses only — this page has one job

        const side = t.side || t.optionType || "";
        // Same formula the engines use for pnlPoints — recomputed only when the
        // engine did not record it, so every strategy is comparable.
        let pts = round(t.pnlPoints, 2);
        if (pts === null && num(t.entryPrice) !== null && num(t.exitPrice) !== null) {
          pts = round((num(t.exitPrice) - num(t.entryPrice)) * (side === "PE" || side === "SHORT" ? -1 : 1), 2);
        }
        const durMs = num(t.durationMs);
        const ind = harvestIndicators(t);

        out.push({
          book,
          mode:       src.mode,
          date:       sessionDate,
          side,
          symbol:     t.symbol || "",
          qty:        num(t.qty),
          pnl,
          pts,
          charges:    round(t.charges, 2),
          entryTime:  t.entryTime || "",
          exitTime:   t.exitTime  || "",
          durMin:     durMs === null ? null : Math.round(durMs / 60000),
          candlesHeld: num(t.candlesHeld),
          // Reasons — the signal story, both ends.
          entryReason: t.entryReason || t.reason || "",
          exitReason:  t.exitReason  || "—",
          strength:    t.signalStrength || null,
          // Price legs
          entryPrice:  round(t.entryPrice, 2),
          exitPrice:   round(t.exitPrice, 2),
          spotAtEntry: round(t.spotAtEntry, 2),
          spotAtExit:  round(t.spotAtExit, 2),
          optEntry:    round(t.optionEntryLtp, 2),
          optExit:     round(t.optionExitLtp, 2),
          bestOptLtp:  round(t.bestOptionLtp, 2),
          strike:      num(t.optionStrike),
          expiry:      t.optionExpiry || null,
          pnlMode:     t.pnlMode || "",
          // Stops
          slInit:      round(t.initialStopLoss, 2),
          slFinal:     round(t.stopLoss, 2),
          // Excursion — what the verdict is built from.
          mfePts:      round(t.mfeSpotPts, 2),
          maePts:      round(t.maeSpotPts, 2),
          secsToMFE:   num(t.secsToMFE),
          secsToMAE:   num(t.secsToMAE),
          mfeRs:       round(t.mfePnl, 0),
          maeRs:       round(t.maePnl, 0),
          // Regime
          vixAtEntry:  round(t.vixAtEntry, 2),
          vixAtExit:   round(t.vixAtExit, 2),
          oiAtEntry:   num(t.oiAtEntry),
          oiRegime:    t.oiRegime || null,
          // Per-engine indicator snapshots
          indEntry:    ind.entry,
          indExit:     ind.exit,
        });
      }
    }
  }
  return out;
}

// Cache the flattened list — same approach as consolidation.js / edgeAnalytics.js.
// Invalidated by a cheap mtime+size signature so a new trade appears immediately.
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
function loadAllLosses() {
  const sig = _sourcesSig();
  if (_cache && sig === _sig) return _cache;
  const trades = loadBook(PAPER_SOURCES, "paper").concat(loadBook(LIVE_SOURCES, "live"));
  trades.sort((a, b) => (b.date || "").localeCompare(a.date || "")); // newest first
  // A row id has to be unique for the detail drawer to open the right trade. Two
  // losses from one strategy can share date, time and amount, so the id is a
  // position stamped here rather than a composite of fields that can collide.
  trades.forEach((t, i) => { t.id = "t" + i; });
  _cache = trades;
  _sig   = sig;
  return trades;
}

router.get("/", (req, res) => {
  // Only analyse strategies enabled in Settings — a disabled strategy is hidden
  // from the sidebar, so it must not appear in the picker or the totals either.
  // Filtered per-request, never cached: Settings saves mutate process.env live.
  const enabled    = enabledStrategies();
  const enabledSet = new Set(enabled.map(s => s.mode));
  const losses     = loadAllLosses().filter(t => enabledSet.has(t.mode));

  // Exit-reason picker is built from the data, not a hard-coded list: every engine
  // words its exits differently and a fixed list would silently drop a new one.
  // Ordered worst-net-first so the exits that bleed most are the first to tick.
  const _reasonNet = new Map();
  for (const t of losses) {
    const k = t.exitReason || "—";
    _reasonNet.set(k, (_reasonNet.get(k) || 0) + t.pnl);
  }
  const reasonPicker = multiSelectHTML('fReason',
    [..._reasonNet.entries()].sort((a, b) => a[1] - b[1])
      .map(([k]) => ({ value: k, label: k.length > 34 ? k.slice(0, 34) + "…" : k })),
    'All exits');

  // Sides come from the data. CE/PE always offered so the segment never collapses
  // on an empty book; LONG/SHORT only once a cash-equity strategy has traded.
  const _sides = new Set(losses.map(t => t.side).filter(Boolean));
  const sideButtons = ['CE', 'PE'].concat(['LONG', 'SHORT'].filter(x => _sides.has(x)))
    .map(x => `<button data-side="${x}">${x}</button>`).join('\n        ');

  // Embedding JSON inside a <script> block is not the same as embedding it in a
  // string: a "</script>" anywhere in the data closes the block early and the rest
  // of the payload lands in the document as markup. Trade reasons are engine-written
  // and carry indicator expressions, so escape the three characters that can break
  // out. \u003c etc. are valid JSON escapes — JSON.parse and the JS parser both
  // read them back as the original characters.
  const embed = (v) => JSON.stringify(v)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

  const theme = resolveTheme();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
  ${faviconLink()}
  <title>ௐ Palani Andawar Thunai ॐ — Losses Analyzer</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script>(function(){ if ('${theme}' === 'light') document.documentElement.setAttribute('data-theme','light'); })();</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    .main-content{flex:1;margin-left:200px;padding:18px 22px 40px;min-width:0;min-height:100vh;}
    @media(max-width:768px){.main-content{margin-left:0;padding:14px calc(14px + env(safe-area-inset-right)) calc(40px + env(safe-area-inset-bottom)) calc(14px + env(safe-area-inset-left));}}
    .page-title{font-size:1.1rem;font-weight:700;margin-bottom:2px;}
    .page-sub{font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-bottom:14px;line-height:1.6;}
    .page-sub a{color:#7dd3fc;text-decoration:none;}
    .tbar{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;margin-bottom:12px;flex-wrap:wrap;}
    .tbar label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);font-family:'IBM Plex Mono',monospace;}
    .tbar input,.tbar select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:6px 10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;outline:none;min-height:32px;}
    .tbar input:focus,.tbar select:focus{border-color:#38bdf8;}
    .tbar input[type=number]{width:74px;}
    .seg{display:inline-flex;border:0.5px solid #0e1e36;border-radius:6px;overflow:hidden;}
    .seg button{background:#04090f;border:none;color:var(--muted-1,#8ba1c2);padding:6px 12px;font-family:'IBM Plex Mono',monospace;font-size:0.7rem;cursor:pointer;min-height:32px;}
    .seg button.on{background:#0c4a6e;color:#7dd3fc;}
${multiSelectCSS()}
    .lnk-btn{background:#0c4a6e;border:0.5px solid #1e5a80;color:#7dd3fc;padding:7px 14px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;min-height:34px;}
    .lnk-btn:hover{background:#0e5a84;}
    .lnk-btn.ml{margin-left:auto;}
    @media(max-width:560px){.lnk-btn{margin-left:0!important;width:100%;justify-content:center;}}
    .stat-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:14px;}
    @media(max-width:1300px){.stat-grid{grid-template-columns:repeat(3,1fr);}}
    @media(max-width:560px){.stat-grid{grid-template-columns:repeat(2,1fr);}}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent,#38bdf8);}
    .sc-label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-2,#6d85a8);margin-bottom:5px;font-family:'IBM Plex Mono',monospace;}
    .sc-val{font-size:1.05rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
    .sc-sub{font-size:0.6rem;color:var(--muted-1,#8ba1c2);margin-top:3px;}
    .panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
    .panel h3{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.4px;color:var(--muted-2,#6d85a8);margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
    .tbl-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .tbl th{padding:8px 10px;text-align:right;font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;white-space:nowrap;}
    .tbl th:first-child,.tbl th.l{text-align:left;}
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;text-align:right;white-space:nowrap;vertical-align:middle;}
    .tbl td:first-child,.tbl td.l{text-align:left;}
    .tbl tbody tr.row-head{cursor:pointer;}
    .tbl tbody tr.row-head:hover td{background:rgba(56,189,248,0.06);}
    .tbl tbody tr.row-head.open td{background:rgba(56,189,248,0.10);}
    .caret{display:inline-block;width:12px;color:var(--muted-2,#6d85a8);transition:transform .15s;}
    tr.row-head.open .caret{transform:rotate(90deg);color:#38bdf8;}
    .muted{color:var(--muted-2,#6d85a8);}
    .badge-mode{padding:2px 6px;border-radius:4px;font-size:0.52rem;font-weight:700;letter-spacing:0.5px;background:rgba(56,189,248,0.12);color:#38bdf8;}
    .badge-EMA_RSI_ST{background:rgba(59,130,246,0.12);color:#3b82f6;}
    .badge-EMA_RSI_ST_V2{background:rgba(56,189,248,0.12);color:#38bdf8;}
    .badge-BN_EMA_RSI_ST_V2{background:rgba(45,212,191,0.12);color:#2dd4bf;}
    .badge-BB_RSI{background:rgba(245,158,11,0.12);color:#f59e0b;}
    .badge-PA{background:rgba(168,85,247,0.12);color:#a855f7;}
    .badge-ORB{background:rgba(16,185,129,0.12);color:#10b981;}
    .badge-EMA9VWAP{background:rgba(6,182,212,0.12);color:#06b6d4;}
    .badge-TREND_PB{background:rgba(236,72,153,0.12);color:#ec4899;}
    .badge-TDS{background:rgba(168,85,247,0.12);color:#a855f7;}
    .badge-HA_SCALP{background:rgba(249,115,22,0.12);color:#f97316;}
    .badge-RSI_PIVOT_ST{background:rgba(250,204,21,0.12);color:#facc15;}
    .badge-BN_PIVOT_RSI_ST{background:rgba(129,140,248,0.12);color:#818cf8;}
    .badge-SIMPLE930{background:rgba(251,146,60,0.12);color:#fb923c;}
    .badge-EARLYBIRD{background:rgba(20,184,166,0.12);color:#14b8a6;}
    /* verdict chips — one colour per failure mode, reused by the cards + filter */
    .vd{padding:2px 7px;border-radius:4px;font-size:0.55rem;font-weight:700;letter-spacing:0.4px;white-space:nowrap;}
    .vd-WRONG_ENTRY{background:rgba(239,68,68,0.14);color:#ef4444;}
    .vd-GAVE_BACK{background:rgba(245,158,11,0.14);color:#f59e0b;}
    .vd-STOPPED{background:rgba(129,140,248,0.14);color:#818cf8;}
    .vd-UNKNOWN{background:rgba(148,163,184,0.14);color:#94a3b8;}
    /* detail drawer */
    tr.detail>td{padding:0;border-top:0;}
    .dw{padding:14px 14px 16px;background:#04090f;border-top:0.5px solid #0e1e36;}
    .dw-verdict{font-size:0.72rem;line-height:1.65;color:#c8d8f0;font-family:'IBM Plex Mono',monospace;background:rgba(56,189,248,0.05);border-left:3px solid var(--vc,#38bdf8);border-radius:6px;padding:9px 12px;margin-bottom:12px;}
    .dw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;}
    .dw-card{background:#07111f;border:0.5px solid #0e1e36;border-radius:8px;padding:10px 12px;min-width:0;}
    .dw-card h4{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-2,#6d85a8);font-family:'IBM Plex Mono',monospace;margin-bottom:8px;}
    .kv{display:flex;justify-content:space-between;gap:10px;font-family:'IBM Plex Mono',monospace;font-size:0.68rem;padding:3px 0;border-bottom:0.5px dashed rgba(23,50,79,0.6);}
    .kv:last-child{border-bottom:0;}
    .kv .k{color:var(--muted-1,#8ba1c2);flex:0 0 auto;}
    .kv .v{color:#e0eaf8;text-align:right;word-break:break-word;min-width:0;}
    .kv .v.wrap{white-space:normal;}
    .m-pnl{display:none;}
    /* ── Phone (≤620px) ────────────────────────────────────────────────
       A ten-column trade table cannot be read at 440px and side-scrolling
       one row at a time hides the number you came for. Below this width the
       losses table stops being a table: each loss becomes a card, each cell
       prints its own label (data-lbl) in place of the dropped header row, and
       the two things you scan for — which strategy, and how much — sit on the
       card's top line. No horizontal scroll at any point. */
    @media(max-width:620px){
      .tbl-scroll{overflow-x:visible;}
      .loss-tbl thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
      .loss-tbl,.loss-tbl tbody,.loss-tbl tr,.loss-tbl td{display:block;width:100%;}
      .loss-tbl tbody tr.row-head{
        border:0.5px solid #17324f;border-radius:10px;margin-bottom:10px;padding:4px 2px 6px;
        background:#04090f;position:relative;
      }
      .loss-tbl tbody tr.row-head.open{border-color:#38bdf8;}
      .loss-tbl tbody tr.row-head td{
        border-top:0;text-align:right;white-space:normal;
        display:flex;justify-content:space-between;align-items:baseline;gap:12px;
        padding:5px 12px;min-height:30px;
      }
      /* Cells that carry a label print it on the left. */
      .loss-tbl tbody tr.row-head td[data-lbl]::before{
        content:attr(data-lbl);color:var(--muted-2,#6d85a8);font-size:0.56rem;
        text-transform:uppercase;letter-spacing:1px;flex:0 0 auto;text-align:left;
      }
      /* Card header: date on one line, then strategy + the loss together. */
      .loss-tbl tbody tr.row-head td.c-date{
        font-size:0.66rem;color:var(--muted-1,#8ba1c2);padding-top:8px;justify-content:flex-start;
      }
      .loss-tbl tbody tr.row-head td.c-mode{padding-bottom:8px;border-bottom:0.5px dashed rgba(23,50,79,0.8);margin-bottom:4px;}
      .loss-tbl tbody tr.row-head td.c-mode .m-pnl{display:inline;font-weight:700;color:#ef4444;font-size:0.85rem;}
      /* The P&L already shows on the card header, so its own row is redundant. */
      .loss-tbl tbody tr.row-head td.c-pnl{display:none;}
      .loss-tbl tbody tr.row-head td.c-exit{text-align:right;}
      /* 44px tap target for the whole card without inflating each line. */
      .loss-tbl tbody tr.row-head{min-height:44px;}
      .loss-tbl tbody tr.detail{margin:-8px 0 12px;}
      .loss-tbl tbody tr.detail>td{padding:0;}
      .dw{padding:12px 10px 14px;border-radius:0 0 10px 10px;}
      .dw-grid{grid-template-columns:1fr;}
      /* The breakdown table keeps its shape but scrolls inside its own panel. */
      .brk-scroll{overflow-x:auto;}
      .stat-grid{gap:8px;}
      .sc{padding:10px 11px;}
      .sc-val{font-size:0.95rem;}
      .tbar{gap:7px;padding:9px 10px;}
      .tbar label{width:100%;margin-bottom:-3px;}
      .tbar select,.tbar input[type=date]{flex:1 1 100%;min-width:0;}
      .seg{width:100%;}
      .seg button{flex:1;}
      .kv{font-size:0.66rem;}
    }
    @media(max-width:380px){
      .dw-grid{gap:9px;}
      .kv{flex-wrap:wrap;gap:2px;}
      .kv .v{text-align:left;}
    }
    .empty{text-align:center;padding:50px 20px;color:var(--muted-1,#8ba1c2);font-size:0.85rem;}
    .note{font-size:0.6rem;color:var(--muted-1,#8ba1c2);font-family:'IBM Plex Mono',monospace;margin-top:8px;line-height:1.6;}
    /* light theme */
    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .page-title{color:#1e293b!important;}
    :root[data-theme="light"] .page-sub,:root[data-theme="light"] .sc-label,:root[data-theme="light"] .sc-sub,:root[data-theme="light"] .panel h3,:root[data-theme="light"] .tbar label,:root[data-theme="light"] .note,:root[data-theme="light"] .dw-card h4,:root[data-theme="light"] .kv .k{color:#4b5769!important;}
    :root[data-theme="light"] .sc,:root[data-theme="light"] .panel,:root[data-theme="light"] .dw-card{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .tbar{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbar input,:root[data-theme="light"] .tbar select,:root[data-theme="light"] .seg button{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .seg button.on{background:#e0f2fe!important;color:#0369a1!important;}
    :root[data-theme="light"] .lnk-btn{background:#0369a1!important;border-color:#0369a1!important;color:#fff!important;}
    :root[data-theme="light"] .lnk-btn:hover{background:#075985!important;}
    :root[data-theme="light"] .tbl th{background:#f1f5f9!important;color:#4b5769!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbl td{border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .dw{background:#f8fafc!important;border-top-color:#e0e4ea!important;}
    :root[data-theme="light"] .dw-verdict{background:#f1f5f9!important;color:#334155!important;}
    :root[data-theme="light"] .kv{border-bottom-color:#e6eaf0!important;}
    :root[data-theme="light"] .kv .v{color:#1e293b!important;}
    :root[data-theme="light"] .muted{color:#94a3b8!important;}
    :root[data-theme="light"] .empty{color:#5c6b7f!important;}
  </style>
</head>
<body>
<div class="app-shell">
  ${buildSidebar('lossesAnalyzer', false)}
  <div class="main-content">
    <h1 class="page-title">🔍 Losses Analyzer</h1>
    <p class="page-sub">Every losing trade with its full signal, entry, exit and indicator record — and a verdict on <em>why</em> it lost. Tap a row to open it.</p>

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
      <label>Side</label>
      <div class="seg" id="segSide">
        <button data-side="all" class="on">All</button>
        ${sideButtons}
      </div>
      <label>Exit</label>
      ${reasonPicker}
      <label>Why</label>
      ${multiSelectHTML('fVerdict', [
        { value: 'WRONG_ENTRY', label: 'Wrong entry' },
        { value: 'GAVE_BACK',   label: 'Gave it back' },
        { value: 'STOPPED',     label: 'Stopped out' },
        { value: 'UNKNOWN',     label: 'No excursion data' },
      ], 'All reasons')}
      <a href="/consolidation-report" class="lnk-btn ml">📑 Consolidation Report</a>
      <button class="lnk-btn" id="btnCsv" style="margin-left:8px;">⬇ CSV</button>
      <button class="lnk-btn" id="btnAi" style="margin-left:8px;" title="Markdown report written for an AI to read — every loss with its full story and verdict">🤖 AI Report</button>
    </div>

    <div class="tbar" id="tuneBar">
      <label title="A loss whose best favourable move never reached this many spot points is called a wrong entry">MFE floor (pts)</label>
      <input type="number" id="fMfe" value="10" min="0" step="1"/>
      <label title="A give-back must have been worth at least this much unrealised profit before it faded">Give-back ≥ ₹</label>
      <input type="number" id="fGb" value="500" min="0" step="100"/>
      <span class="note" style="margin:0;">These two thresholds decide the verdict — move them to match the instrument you are reading.</span>
    </div>

    <div id="content"></div>
  </div>
</div>

<script>
${dateRangeJS()}
${multiSelectJS()}
const ALL   = ${embed(losses)};
const MODES = ${embed(enabled.map(s => s.mode))};

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function inr2(n){ if(n==null) return '—'; return (n<0?'-':'')+'₹'+Math.abs(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function inr(n){ if(n==null) return '—'; const v=Math.round(n); return (v<0?'-':'')+'₹'+Math.abs(v).toLocaleString('en-IN'); }
function nz(v,suffix){ return (v==null||v==='')?'<span class="muted">—</span>':(esc(v)+(suffix||'')); }
function pc(n){ return n>=0?'#10b981':'#ef4444'; }
function prettyDate(s){ const d=new Date(s+'T12:00:00'); if(isNaN(d)) return s; return d.toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short',year:'numeric'}); }
// Trade stamps are "DD/MM/YYYY, HH:MM:SS" or "HH:MM, DD/MM/YYYY" — both carry exactly
// one clock field, so the first HH:MM is the time regardless of which layout it is.
function clockOf(v){ const m=String(v==null?'':v).match(/(\\d{1,2}:\\d{2})/); return m?m[1]:'—'; }
function mins(sec){ return sec==null?null:Math.round(sec/60); }

// ── Verdict ─────────────────────────────────────────────────────────
// Built from the trade's own excursion record, against the two thresholds on the
// toolbar. A trade with no MFE/MAE recorded gets UNKNOWN, never a guess.
const VD_LABEL = { WRONG_ENTRY:'Wrong entry', GAVE_BACK:'Gave it back', STOPPED:'Stopped out', UNKNOWN:'No data' };
const VD_COLOR = { WRONG_ENTRY:'#ef4444', GAVE_BACK:'#f59e0b', STOPPED:'#818cf8', UNKNOWN:'#94a3b8' };

// → { v, peakRs } — peakRs is the figure the verdict was decided on, so the
// explanation can quote the same number instead of deriving its own.
function judge(t, mfeFloor, gbRs){
  if(t.mfePts==null && t.maePts==null && t.mfeRs==null) return { v:'UNKNOWN', peakRs:null };
  const mfe = t.mfePts==null ? 0 : t.mfePts;
  // Prefer the engine's own peak-₹ when it recorded one; otherwise scale the spot
  // excursion by this trade's own ₹-per-point so the ₹ threshold means the same
  // thing on a 15-lot NIFTY trade and a 1-lot BANKNIFTY one.
  let peakRs = t.mfeRs;
  let derived = false;
  if(peakRs==null && t.pts!=null && t.pts!==0 && mfe>0){
    // ₹-per-point from this trade's own realised leg. Only meaningful when that
    // leg is big enough to divide by: a trade that closed near breakeven has a
    // near-zero points move, and dividing by it collapses the estimate toward
    // zero no matter how far the trade actually ran.
    const rsPerPt = Math.abs((t.pnl+(t.charges||0))/t.pts);
    if(isFinite(rsPerPt) && Math.abs(t.pts)>=2){ peakRs = mfe*rsPerPt; derived = true; }
  }
  if(mfe < mfeFloor) return { v:'WRONG_ENTRY', peakRs, derived };
  if(peakRs!=null && peakRs >= gbRs) return { v:'GAVE_BACK', peakRs, derived };
  // No usable ₹ figure, but the trade still ran a long way in the money before
  // dying: that is a give-back whatever the rupees worked out to. Without this,
  // a big favourable run on an engine that records no peak-₹ is filed as a
  // routine stop-out — the exact trade the user is looking for.
  if(peakRs==null && mfe >= mfeFloor*2) return { v:'GAVE_BACK', peakRs:null, derived:false };
  return { v:'STOPPED', peakRs, derived };
}
function verdictOf(t, mfeFloor, gbRs){ return judge(t, mfeFloor, gbRs).v; }
function verdictText(t, j, mfeFloor, gbRs){
  const v = j.v;
  const mfe = t.mfePts==null?null:t.mfePts, mae = t.maePts==null?null:t.maePts;
  const tMfe = mins(t.secsToMFE), tMae = mins(t.secsToMAE);
  if(v==='UNKNOWN')
    return 'This engine did not record how far the trade ran in your favour, so no verdict is claimed. Everything below is still the full record.';
  if(v==='WRONG_ENTRY')
    return 'Wrong entry — the best it ever got was '+(mfe==null?'—':mfe.toFixed(1))+' pts in your favour'
      +(tMfe!=null&&mfe>0?' (after '+tMfe+' min)':'')+', under the '+mfeFloor+'-pt floor. '
      +'It went '+(mae==null?'—':Math.abs(mae).toFixed(1))+' pts against you'+(tMae!=null?' within '+tMae+' min':'')
      +'. The signal did not work from the start — this is an entry-rule problem, not an exit one.';
  if(v==='GAVE_BACK')
    return 'Gave it back — it ran '+(mfe==null?'—':mfe.toFixed(1))+' pts in your favour'
      +(tMfe!=null?' after '+tMfe+' min':'')
      +(j.peakRs!=null ? ', worth about '+inr(j.peakRs)+(j.derived?' (estimated from the points move)':'')+' at peak' : '')
      +', then closed at '+inr2(t.pnl)+' on "'+esc(t.exitReason)+'". '
      +'The entry was right; the profit was not protected. Look at the trail / target, not the signal.';
  return 'Stopped out — it moved '+(mfe==null?'—':mfe.toFixed(1))+' pts your way, never enough to be worth locking in'
    +', and '+(mae==null?'—':Math.abs(mae).toFixed(1))+' pts against. A normal loss: the stop did its job.';
}

function currentFilter(){
  const book = document.querySelector('#segBook button.on').dataset.book;
  const side = document.querySelector('#segSide button.on').dataset.side;
  const range = document.getElementById('fRange').value;
  const r = drRange(range, document.getElementById('fFrom').value, document.getElementById('fTo').value);
  const mfeFloor = Math.max(0, Number(document.getElementById('fMfe').value)||0);
  const gbRs     = Math.max(0, Number(document.getElementById('fGb').value)||0);
  return { book, side, modes:msValues('fMode'), reasons:msValues('fReason'),
           verdicts:msValues('fVerdict'), from:r.from, to:r.to, mfeFloor, gbRs };
}
function applyFilter(f){
  return ALL.filter(t=>{
    if(f.book!=='all' && t.book!==f.book) return false;
    if(f.side!=='all' && t.side!==f.side) return false;
    if(f.modes.indexOf(t.mode)===-1) return false;
    if(f.reasons.indexOf(t.exitReason||'—')===-1) return false;
    if(f.from && t.date < f.from) return false;
    if(f.to   && t.date > f.to)   return false;
    if(f.verdicts.indexOf(verdictOf(t,f.mfeFloor,f.gbRs))===-1) return false;
    return true;
  });
}

// Open rows survive a re-render (a threshold nudge shouldn't collapse what you were reading).
let OPEN = new Set();

function kv(k,v,wrap){ return '<div class="kv"><span class="k">'+esc(k)+'</span><span class="v'+(wrap?' wrap':'')+'">'+v+'</span></div>'; }

function indCard(title, obj){
  const keys=Object.keys(obj||{});
  if(!keys.length) return '';
  let h='<div class="dw-card"><h4>'+esc(title)+'</h4>';
  for(const k of keys.sort()) h+=kv(k, esc(obj[k]));
  return h+'</div>';
}

function detailHTML(t, f, j){
  const v = j.v;
  const held = t.durMin==null?'—':(t.durMin+' min'+(t.candlesHeld?' · '+t.candlesHeld+' candles':''));
  let h='<div class="dw"><div class="dw-verdict" style="--vc:'+VD_COLOR[v]+'">'+verdictText(t,j,f.mfeFloor,f.gbRs)+'</div><div class="dw-grid">';

  h+='<div class="dw-card"><h4>Signal</h4>'
    +kv('Strategy','<span class="badge-mode badge-'+esc(t.mode)+'">'+esc(t.mode)+'</span>')
    +kv('Side', nz(t.side))
    +kv('Strength', nz(t.strength))
    +kv('Contract', nz(t.symbol))
    +kv('Strike', nz(t.strike))
    +kv('Expiry', nz(t.expiry))
    +kv('Qty', nz(t.qty))
    +kv('Entry reason', nz(t.entryReason), true)
    +'</div>';

  h+='<div class="dw-card"><h4>Entry</h4>'
    +kv('Time', esc(t.entryTime||'—'))
    +kv('Spot', nz(t.spotAtEntry))
    +kv('Price', nz(t.entryPrice))
    +kv('Option LTP', t.optEntry==null?'<span class="muted">—</span>':'₹'+t.optEntry)
    +kv('Initial SL', nz(t.slInit))
    +kv('VIX', nz(t.vixAtEntry))
    +kv('OI', nz(t.oiAtEntry)+(t.oiRegime?' · '+esc(t.oiRegime):''))
    +'</div>';

  h+='<div class="dw-card"><h4>Exit</h4>'
    +kv('Time', esc(t.exitTime||'—'))
    +kv('Spot', nz(t.spotAtExit))
    +kv('Price', nz(t.exitPrice))
    +kv('Option LTP', t.optExit==null?'<span class="muted">—</span>':'₹'+t.optExit)
    +kv('SL at exit', nz(t.slFinal))
    +kv('VIX', nz(t.vixAtExit))
    +kv('Exit reason', nz(t.exitReason), true)
    +'</div>';

  h+='<div class="dw-card"><h4>How it moved</h4>'
    +kv('Best (MFE)', t.mfePts==null?'<span class="muted">—</span>':'<span style="color:#10b981">+'+t.mfePts.toFixed(1)+' pts</span>'+(t.secsToMFE!=null?' <span class="muted">@'+mins(t.secsToMFE)+'m</span>':''))
    +kv('Worst (MAE)', t.maePts==null?'<span class="muted">—</span>':'<span style="color:#ef4444">'+t.maePts.toFixed(1)+' pts</span>'+(t.secsToMAE!=null?' <span class="muted">@'+mins(t.secsToMAE)+'m</span>':''))
    +kv('Peak unrealised', t.mfeRs==null?'<span class="muted">—</span>':'<span style="color:#10b981">'+inr(t.mfeRs)+'</span>')
    +kv('Worst unrealised', t.maeRs==null?'<span class="muted">—</span>':'<span style="color:#ef4444">'+inr(t.maeRs)+'</span>')
    +kv('Peak option LTP', t.bestOptLtp==null?'<span class="muted">—</span>':'₹'+t.bestOptLtp)
    +kv('Held', esc(held))
    +'</div>';

  h+='<div class="dw-card"><h4>Result</h4>'
    +kv('Net P&amp;L','<span style="color:#ef4444;font-weight:700">'+inr2(t.pnl)+'</span>')
    +kv('Points', t.pts==null?'<span class="muted">—</span>':t.pts.toFixed(2))
    +kv('Charges', t.charges==null?'<span class="muted">—</span>':inr2(t.charges))
    +kv('Gross', (t.charges==null)?'<span class="muted">—</span>':inr2(t.pnl+t.charges))
    +kv('P&amp;L basis', nz(t.pnlMode), true)
    +'</div>';

  h+=indCard('Indicators at entry', t.indEntry);
  h+=indCard('Indicators at exit',  t.indExit);
  return h+'</div></div>';
}

function render(){
  const f=currentFilter();
  const arr=applyFilter(f);
  const C=document.getElementById('content');

  if(!arr.length){ C.innerHTML='<div class="empty">No losing trades for this filter. Try widening the range or switching Book.</div>'; return; }

  // Cards: the loss bill, then the split that tells you where to spend your time.
  // Judge once per trade and keep it — the cards, the breakdown and the rows all
  // need the same verdict, and judge() is the only non-trivial work per row.
  const J=new Map();
  let net=0, worst=null, gaveBackRs=0; const byV={WRONG_ENTRY:{n:0,rs:0},GAVE_BACK:{n:0,rs:0},STOPPED:{n:0,rs:0},UNKNOWN:{n:0,rs:0}};
  for(const t of arr){
    net+=t.pnl;
    if(worst===null||t.pnl<worst) worst=t.pnl;
    const j=judge(t,f.mfeFloor,f.gbRs); J.set(t.id,j);
    byV[j.v].n++; byV[j.v].rs+=t.pnl;
    // "was on the table" counts the estimated peak too — otherwise an engine that
    // records no peak-₹ contributes a give-back to the count but nothing to the ₹.
    if(j.v==='GAVE_BACK' && j.peakRs!=null) gaveBackRs+=j.peakRs;
  }
  const avg=net/arr.length;
  const cards=[
    {l:'Losing Trades',v:arr.length,sub:'in this filter',a:'#ef4444'},
    {l:'Total Bled',v:inr(net),sub:'net of charges',a:'#ef4444'},
    {l:'Avg Loss',v:inr(avg),sub:'per losing trade',a:'#f59e0b'},
    {l:'Worst Single',v:inr(worst),sub:'biggest one loss',a:'#ef4444'},
    {l:'Wrong Entries',v:byV.WRONG_ENTRY.n,sub:inr(byV.WRONG_ENTRY.rs)+' · signal problem',a:'#ef4444'},
    {l:'Gave It Back',v:byV.GAVE_BACK.n,sub:(gaveBackRs?inr(gaveBackRs)+' was on the table':'exit problem'),a:'#f59e0b'},
  ];
  let h='<div class="stat-grid">';
  for(const c of cards) h+='<div class="sc" style="--accent:'+c.a+'"><div class="sc-label">'+c.l+'</div><div class="sc-val" style="color:'+c.a+'">'+c.v+'</div><div class="sc-sub">'+esc(c.sub)+'</div></div>';
  h+='</div>';

  // Why-it-lost breakdown — the whole point of the page, so it sits above the list.
  let br='<div class="panel"><h3>Why these losses happened</h3><div class="tbl-scroll brk-scroll"><table class="tbl"><thead>'
    +'<tr><th class="l">Verdict</th><th>Trades</th><th>Share</th><th>Net</th><th>Avg</th><th class="l">What to fix</th></tr></thead><tbody>';
  const FIX={ WRONG_ENTRY:'Entry rules — the signal fired and price went the other way.',
              GAVE_BACK:'Exit rules — trail / target let a winner turn red.',
              STOPPED:'Nothing obvious — normal stop losses. Size and frequency matter here, not rules.',
              UNKNOWN:'Excursion not recorded by this engine, so no verdict.' };
  for(const k of ['WRONG_ENTRY','GAVE_BACK','STOPPED','UNKNOWN']){
    const c=byV[k]; if(!c.n) continue;
    br+='<tr><td class="l"><span class="vd vd-'+k+'">'+VD_LABEL[k]+'</span></td>'
      +'<td>'+c.n+'</td><td>'+(c.n/arr.length*100).toFixed(0)+'%</td>'
      +'<td style="color:#ef4444">'+inr(c.rs)+'</td><td style="color:#ef4444">'+inr(c.rs/c.n)+'</td>'
      +'<td class="l muted">'+esc(FIX[k])+'</td></tr>';
  }
  h+=br+'</tbody></table></div></div>';

  // The list itself — one head row per loss, detail drawer underneath.
  let rows='';
  for(const t of arr){
    const j=J.get(t.id), v=j.v;
    const k=t.id, open=OPEN.has(k);
    // data-lbl is what the phone layout prints in place of the (hidden) header row.
    rows+='<tr class="row-head'+(open?' open':'')+'" data-k="'+esc(k)+'" tabindex="0">'
      +'<td class="l c-date"><span class="caret">▶</span> '+esc(prettyDate(t.date))+'</td>'
      +'<td class="l c-mode"><span class="badge-mode badge-'+esc(t.mode)+'">'+esc(t.mode)+'</span>'
        +'<span class="m-pnl">'+inr2(t.pnl)+'</span></td>'
      +'<td class="l" data-lbl="Side">'+nz(t.side)+'</td>'
      +'<td data-lbl="In → Out">'+clockOf(t.entryTime)+' → '+clockOf(t.exitTime)+'</td>'
      +'<td data-lbl="Held">'+(t.durMin==null?'<span class="muted">—</span>':t.durMin+'m')+'</td>'
      +'<td data-lbl="MFE">'+(t.mfePts==null?'<span class="muted">—</span>':'<span style="color:#10b981">+'+t.mfePts.toFixed(1)+'</span>')+'</td>'
      +'<td data-lbl="MAE">'+(t.maePts==null?'<span class="muted">—</span>':'<span style="color:#ef4444">'+t.maePts.toFixed(1)+'</span>')+'</td>'
      +'<td class="l c-why" data-lbl="Why"><span class="vd vd-'+v+'">'+VD_LABEL[v]+'</span></td>'
      +'<td class="l muted c-exit" data-lbl="Exit" title="'+esc(t.exitReason)+'">'+esc(t.exitReason)+'</td>'
      +'<td class="c-pnl" data-lbl="Net P&amp;L" style="font-weight:700;color:#ef4444">'+inr2(t.pnl)+'</td></tr>'
      +'<tr class="detail" data-for="'+esc(k)+'"'+(open?'':' hidden')+'><td colspan="10">'+(open?detailHTML(t,f,j):'')+'</td></tr>';
  }
  h+='<div class="panel"><h3>Losing trades ('+arr.length+')</h3><div class="tbl-scroll"><table class="tbl loss-tbl"><thead>'
    +'<tr><th class="l">Date</th><th class="l">Strategy</th><th class="l">Side</th><th>In → Out</th><th>Held</th>'
    +'<th title="Best move in your favour, spot points">MFE</th><th title="Worst move against you, spot points">MAE</th>'
    +'<th class="l">Why</th><th class="l">Exit reason</th><th>Net P&amp;L</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
    +'<div class="note">Tap any row for the full signal, entry, exit, excursion and indicator record. MFE / MAE are spot points; a blank means the engine did not record them.</div></div>';

  C.innerHTML=h;

  // Re-bound every render because render() replaces the whole table.
  C.querySelectorAll('tr.row-head').forEach(tr=>{
    const toggle=()=>{
      const k=tr.dataset.k;
      const t=arr.find(x=>x.id===k);
      const det=C.querySelector('tr.detail[data-for="'+CSS.escape(k)+'"]');
      if(!det||!t) return;
      // The drawer <td> is rendered EMPTY for a closed row, so it has no element
      // child to reach through — write into the cell itself.
      const cell=det.cells[0];
      if(OPEN.has(k)){ OPEN.delete(k); tr.classList.remove('open'); det.hidden=true; cell.innerHTML=''; }
      else { OPEN.add(k); tr.classList.add('open'); cell.innerHTML=detailHTML(t,f,judge(t,f.mfeFloor,f.gbRs)); det.hidden=false; }
    };
    tr.addEventListener('click',toggle);
    tr.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); } });
  });
}

// CSV of exactly what is on screen — flat one row per loss, verdict included.
function downloadCsv(){
  const f=currentFilter(), arr=applyFilter(f);
  if(!arr.length){ alert('Nothing to export for this filter.'); return; }
  const cols=['date','book','mode','side','symbol','strike','expiry','qty','entryTime','exitTime','durMin','candlesHeld',
    'entryPrice','exitPrice','spotAtEntry','spotAtExit','optEntry','optExit','slInit','slFinal',
    'mfePts','maePts','secsToMFE','secsToMAE','mfeRs','maeRs','vixAtEntry','vixAtExit','oiAtEntry','oiRegime',
    'strength','pts','charges','pnl','pnlMode','entryReason','exitReason'];
  const q=s=>'"'+String(s==null?'':s).replace(/"/g,'""')+'"';
  let csv=cols.concat(['verdict','indicatorsAtEntry','indicatorsAtExit']).join(',')+'\\n';
  for(const t of arr){
    const flat=o=>Object.keys(o||{}).sort().map(k=>k+'='+o[k]).join('; ');
    csv+=cols.map(c=>q(t[c])).concat([q(VD_LABEL[verdictOf(t,f.mfeFloor,f.gbRs)]),q(flat(t.indEntry)),q(flat(t.indExit))]).join(',')+'\\n';
  }
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  a.download='losses-'+(f.from||'all')+'-to-'+(f.to||'all')+'.csv';
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },0);
}

// AI-friendly export — Markdown, not CSV. An LLM reads prose and labelled
// key: value lines far better than a 40-column grid, so every trade is written
// out as its own block with the same verdict sentence the drawer shows. Self
// describing: the header states what the numbers mean so no schema is needed.
function downloadAiReport(){
  const f=currentFilter(), arr=applyFilter(f);
  if(!arr.length){ alert('Nothing to export for this filter.'); return; }

  const J=new Map(); let net=0, worst=null, gaveBackRs=0;
  const byV={WRONG_ENTRY:{n:0,rs:0},GAVE_BACK:{n:0,rs:0},STOPPED:{n:0,rs:0},UNKNOWN:{n:0,rs:0}};
  for(const t of arr){
    net+=t.pnl; if(worst===null||t.pnl<worst) worst=t.pnl;
    const j=judge(t,f.mfeFloor,f.gbRs); J.set(t.id,j);
    byV[j.v].n++; byV[j.v].rs+=t.pnl;
    if(j.v==='GAVE_BACK'&&j.peakRs!=null) gaveBackRs+=j.peakRs;
  }
  // Plain numbers for the AI — no ₹ glyphs or thousands separators to parse.
  const rs=n=>n==null?'not recorded':Math.round(n);
  const n1=(v,s)=>v==null?'not recorded':(v.toFixed(1)+(s||''));
  const kv=o=>{ const k=Object.keys(o||{}).sort(); return k.length?k.map(x=>x+'='+o[x]).join(', '):'none recorded'; };
  // Strip the HTML the on-screen verdict sentence carries (it goes through esc()).
  const plain=h=>String(h).replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');

  const modes=[...new Set(arr.map(t=>t.mode))].sort().join(', ');
  const dates=arr.map(t=>t.date).filter(Boolean).sort();
  const L=[];
  L.push('# Losing trades — analysis pack');
  L.push('');
  L.push('Generated '+new Date().toString()+' from the Losses Analyzer of a NIFTY options trading bot.');
  L.push('Every trade below is a LOSS. Winners are not in this file, so do not infer a win rate from it.');
  L.push('');
  L.push('## What you are reading');
  L.push('');
  L.push('- Money is Indian rupees, net of charges unless a line says gross. Points are NIFTY spot points.');
  L.push('- MFE = the best the trade ever got in my favour. MAE = the worst it went against me. Both in spot points.');
  L.push('- CE = long call (I profit when spot rises). PE = long put (I profit when spot falls).');
  L.push('- Each trade carries a verdict decided by two thresholds set in the UI:');
  L.push('  - "Wrong entry" = MFE never reached '+f.mfeFloor+' points, so the signal was wrong from the start (entry-rule problem).');
  L.push('  - "Gave it back" = it ran past that floor and was worth at least '+f.gbRs+' rupees at peak, then closed red (exit-rule problem).');
  L.push('  - "Stopped out" = a normal loss, the stop did its job (size/frequency question, not a rule question).');
  L.push('  - "No data" = this engine did not record excursion, so no verdict is claimed.');
  L.push('');
  L.push('## Filter that produced this file');
  L.push('');
  L.push('- Book: '+f.book+'  |  Strategies: '+(modes||'none')+'  |  Side: '+f.side);
  const rangeLabel=(document.getElementById('fRange')||{}).value||'all';
  L.push('- Date range: '+(dates.length?dates[0]+' to '+dates[dates.length-1]:'n/a')+' (picker: '+rangeLabel+')');
  L.push('- Verdict thresholds: MFE floor '+f.mfeFloor+' pts, give-back '+f.gbRs+' rupees');
  L.push('');
  L.push('## Totals');
  L.push('');
  L.push('- Losing trades: '+arr.length);
  L.push('- Total lost: '+rs(net)+' (average '+rs(net/arr.length)+' per losing trade)');
  L.push('- Worst single loss: '+rs(worst));
  if(gaveBackRs) L.push('- Unrealised profit handed back by the "gave it back" trades: about '+rs(gaveBackRs));
  L.push('');
  L.push('## Split by verdict');
  L.push('');
  L.push('| Verdict | Trades | Share | Net | Avg |');
  L.push('|---|---|---|---|---|');
  for(const k of ['WRONG_ENTRY','GAVE_BACK','STOPPED','UNKNOWN']){
    const c=byV[k]; if(!c.n) continue;
    L.push('| '+VD_LABEL[k]+' | '+c.n+' | '+(c.n/arr.length*100).toFixed(0)+'% | '+rs(c.rs)+' | '+rs(c.rs/c.n)+' |');
  }
  L.push('');
  L.push('## Every losing trade');
  L.push('');
  let i=0;
  for(const t of arr){
    const j=J.get(t.id); i++;
    L.push('### '+i+'. '+prettyDate(t.date)+' — '+t.mode+' '+(t.side||'?')+' — lost '+rs(t.pnl));
    L.push('');
    L.push('- Verdict: '+VD_LABEL[j.v]);
    L.push('- Why: '+plain(verdictText(t,j,f.mfeFloor,f.gbRs)));
    L.push('- Book: '+t.book+'  |  Symbol: '+(t.symbol||'not recorded')+'  |  Qty: '+(t.qty==null?'not recorded':t.qty));
    L.push('- Entry signal: '+(t.entryReason||'not recorded'));
    L.push('- Exit reason: '+(t.exitReason||'not recorded')+(t.strength?'  |  Signal strength: '+t.strength:''));
    L.push('- Timing (IST): in '+clockOf(t.entryTime)+', out '+clockOf(t.exitTime)+', held '+(t.durMin==null?'not recorded':t.durMin+' min')
      +(t.candlesHeld==null?'':' ('+t.candlesHeld+' candles)'));
    L.push('- Option price: entry '+(t.entryPrice==null?'not recorded':t.entryPrice)+' -> exit '+(t.exitPrice==null?'not recorded':t.exitPrice)
      +(t.strike?'  |  Strike '+t.strike:'')+(t.expiry?'  |  Expiry '+t.expiry:''));
    L.push('- Spot: entry '+(t.spotAtEntry==null?'not recorded':t.spotAtEntry)+' -> exit '+(t.spotAtExit==null?'not recorded':t.spotAtExit));
    L.push('- Excursion: MFE '+n1(t.mfePts,' pts')+(t.secsToMFE==null?'':' after '+mins(t.secsToMFE)+' min')
      +', MAE '+n1(t.maePts,' pts')+(t.secsToMAE==null?'':' within '+mins(t.secsToMAE)+' min'));
    L.push('- Peak/worst in money: best '+rs(t.mfeRs)+', worst '+rs(t.maeRs));
    L.push('- Stops: initial '+(t.slInit==null?'not recorded':t.slInit)+', final '+(t.slFinal==null?'not recorded':t.slFinal));
    L.push('- Result: '+n1(t.pts,' pts')+', charges '+rs(t.charges)+', net '+rs(t.pnl)+(t.pnlMode?' ('+t.pnlMode+')':''));
    L.push('- Regime: VIX '+(t.vixAtEntry==null?'not recorded':t.vixAtEntry)+' -> '+(t.vixAtExit==null?'not recorded':t.vixAtExit)
      +(t.oiRegime?'  |  OI regime '+t.oiRegime:'')+(t.oiAtEntry==null?'':'  |  OI at entry '+t.oiAtEntry));
    L.push('- Indicators at entry: '+kv(t.indEntry));
    L.push('- Indicators at exit: '+kv(t.indExit));
    L.push('');
  }
  L.push('## Questions worth answering from this data');
  L.push('');
  L.push('1. Which verdict is costing the most money, and is that an entry-rule or exit-rule fix?');
  L.push('2. Do the wrong entries share a setup, time of day, VIX level or indicator state?');
  L.push('3. For the give-backs, how far past the peak did the trade sit before the exit fired?');
  L.push('4. Is any single strategy, side or weekday responsible for a disproportionate share?');
  L.push('5. Are the stopped-out losses sized consistently, or is one outlier skewing the total?');
  L.push('');
  L.push('Note: this file only contains losses, so any suggested change must be judged against the winning trades too before acting on it.');

  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([L.join('\\n')],{type:'text/markdown;charset=utf-8;'}));
  a.download='losses-ai-report-'+(f.from||'all')+'-to-'+(f.to||'all')+'.md';
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },0);
}

// wire controls
function wireSeg(id){
  document.querySelectorAll('#'+id+' button').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('#'+id+' button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); render();
  }));
}
wireSeg('segBook'); wireSeg('segSide');
msInit('fMode', render); msInit('fReason', render); msInit('fVerdict', render);
document.getElementById('fRange').addEventListener('change',()=>{
  const range=document.getElementById('fRange').value;
  document.getElementById('customWrap').style.display = range==='custom'?'inline':'none';
  // Only 'Current week expiry' needs the expiry calendar — fetched once, then cached.
  if(range==='exp'){ drReady().then(render); return; }
  render();
});
document.getElementById('fFrom').addEventListener('change',render);
document.getElementById('fTo').addEventListener('change',render);
document.getElementById('fMfe').addEventListener('input',render);
document.getElementById('fGb').addEventListener('input',render);
document.getElementById('btnCsv').addEventListener('click',downloadCsv);
document.getElementById('btnAi').addEventListener('click',downloadAiReport);
render();
</script>
</body>
</html>`;
  res.send(html);
});

module.exports = router;

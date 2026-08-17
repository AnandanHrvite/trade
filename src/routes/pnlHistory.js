/**
 * PNL HISTORY — /pnl-history
 * ─────────────────────────────────────────────────────────────────────────────
 * Consolidated realised P&L across Kite (Zerodha) + Fyers, plus a manual-trade
 * mistake-analysis panel for the user's own (non-bot) trading on each broker.
 *
 *   past pnl         = one-time user entry per broker (baseline, not FY-split)
 *                      stored in ~/trading-data/historical_pnl.json
 *   live bot pnl     = auto-computed from the bot's own live-trade JSON files
 *                      (EMA_RSI_ST live → Kite; bb_rsi live + PA live → Fyers),
 *                      grouped by Indian financial year (Apr–Mar)
 *   grand total      = past baseline + live bot pnl, per broker and overall
 *   manual trades    = the user's own hand-placed trades (equity + F&O), fed by
 *                      ~/trading-data/manual_trades.json (see utils/manualTrades.js).
 *                      Kite has no historical order/trade API — /orders and
 *                      /trades are today-only ("the order history ... only
 *                      lives for a day in the system", per Kite Connect docs,
 *                      and Kite MCP has the identical limit) — so past manual
 *                      trades come from a one-time Kite Console tradebook CSV
 *                      import; going forward, a daily auto-sync (or the Sync
 *                      Now button) pulls today's fills automatically.
 *                      Fyers manual trades: import-only for now (no sync route
 *                      wired here — the user's manual trading is on Kite).
 *
 * User sets the past baseline once per broker; it never changes unless edited.
 * Everything else updates automatically as live trades close / manual trades sync.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, tableEnhancerCSS, tableEnhancerJS } = require("../utils/sharedNav");
const { resolveTheme } = require("../utils/theme");
const manualTrades = require("../utils/manualTrades");

const _HOME = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const DATA_FILE = path.join(DATA_DIR, "historical_pnl.json");

const LIVE_SOURCES = [
  { file: path.join(DATA_DIR, "ema_rsi_st_live_trades.json"),       broker: "kite",  mode: "EMA_RSI_ST" },
  { file: path.join(DATA_DIR, "bb_rsi_live_trades.json"), broker: "fyers", mode: "BB_RSI" },
  { file: path.join(DATA_DIR, "pa_live_trades.json"),    broker: "fyers", mode: "PA"    },
];

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeRead(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) { return null; }
}

function loadBaselines() {
  const data = safeRead(DATA_FILE) || {};
  const b = data.baselines || {};
  return {
    kite:  b.kite  || { pnl: 0, notes: "", updatedAt: null },
    fyers: b.fyers || { pnl: 0, notes: "", updatedAt: null },
  };
}

function saveBaselines(baselines) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify({ baselines }, null, 2), "utf-8");
}

// JSON.stringify does not escape "</script" — a symbol from an imported CSV
// containing that literal sequence would close the embedding <script> tag
// early and let the rest of its content execute as markup/script. Used for
// every JSON blob embedded into this page's <script> block that carries
// user-entered text (MANUAL_TRIPS) — escapes the slash so the sequence can
// never match a real tag boundary; same value, same JSON.parse result, just
// not renderable as a tag close.
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/<\/(script)/gi, "<\\/$1");
}

// Indian FY: April–March. Returns string like "2023-24".
function toFy(dateLike) {
  if (!dateLike) return null;
  const d = new Date(dateLike);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? y : y - 1; // April = month index 3
  const yy = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${yy}`;
}

function loadLiveTrades() {
  const trades = [];
  for (const src of LIVE_SOURCES) {
    const data = safeRead(src.file);
    if (!data || !Array.isArray(data.sessions)) continue;
    for (const s of data.sessions) {
      const sessionDate = s.date;
      for (const t of (s.trades || [])) {
        const dateForFy = t.exitTime || t.entryTime || sessionDate;
        const fy = toFy(dateForFy);
        if (!fy) continue;
        trades.push({
          broker: src.broker,
          mode:   src.mode,
          fy,
          pnl:    Number(t.pnl) || 0,
        });
      }
    }
  }
  return trades;
}

// ── Mutations ────────────────────────────────────────────────────────────────

router.use(express.urlencoded({ extended: true }));
router.use(express.json());

router.post("/baseline/:broker", (req, res) => {
  const { broker } = req.params;
  if (!["kite", "fyers"].includes(broker)) {
    return res.status(400).json({ success: false, error: "Invalid broker" });
  }
  const { pnl, notes } = req.body || {};
  const pnlNum = Number(pnl);
  if (!Number.isFinite(pnlNum)) {
    return res.status(400).json({ success: false, error: "P&L must be a number" });
  }
  const baselines = loadBaselines();
  baselines[broker] = {
    pnl:       pnlNum,
    notes:     (notes || "").toString().slice(0, 300),
    updatedAt: new Date().toISOString(),
  };
  saveBaselines(baselines);
  res.json({ success: true });
});

router.post("/baseline/:broker/reset", (req, res) => {
  const { broker } = req.params;
  if (!["kite", "fyers"].includes(broker)) {
    return res.status(400).json({ success: false, error: "Invalid broker" });
  }
  const baselines = loadBaselines();
  baselines[broker] = { pnl: 0, notes: "", updatedAt: null };
  saveBaselines(baselines);
  res.json({ success: true });
});

router.get("/data", (req, res) => {
  res.json({
    success:    true,
    baselines:  loadBaselines(),
    liveTrades: loadLiveTrades(),
  });
});

// ── Manual trades (Kite/Fyers hand-placed trading — mistake analysis) ──────

// CSV text is posted as a JSON string body (not multipart) — the client reads
// the file locally via FileReader, no new upload middleware needed.
router.post("/manual/import", (req, res) => {
  const { csv, filename, broker } = req.body || {};
  if (!csv || typeof csv !== "string") {
    return res.status(400).json({ success: false, error: "No CSV content received." });
  }
  if (!["kite", "fyers"].includes(broker)) {
    return res.status(400).json({ success: false, error: "Invalid broker" });
  }
  try {
    const result = manualTrades.importCsv(csv, (filename || "upload.csv").toString().slice(0, 120), broker);
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manual "pull today's fills now" — same code path the daily auto-sync job uses.
router.post("/manual/sync", async (req, res) => {
  try {
    const result = await manualTrades.syncFromKite();
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/manual/data", (req, res) => {
  try {
    const store = manualTrades.loadStore();
    const roundTrips = manualTrades.buildRoundTrips(store.fills);
    res.json({ success: true, meta: store.meta, fillCount: store.fills.length, roundTrips });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Dashboard ────────────────────────────────────────────────────────────────

router.get("/", (req, res) => {
  const baselines = loadBaselines();
  const liveTrades = loadLiveTrades();
  const manualStore = manualTrades.loadStore();
  const manualRoundTrips = manualTrades.buildRoundTrips(manualStore.fills);
  // This page's manual-trading UI only surfaces Kite (the user's own manual
  // trading happens on Zerodha) — Fyers manual entries, if any get imported
  // later, are still stored and included in the JSON blob for the client.
  const zerodhaBroker = require("../services/zerodhaBroker");
  const kiteConnected = zerodhaBroker.isAuthenticated();

  // Group live trades by FY + broker + mode
  const byFy = new Map(); // fy -> { fy, kite_swing, fyers_scalp, fyers_pa, kite_total, fyers_total, total }
  const liveTotals = { kite: 0, fyers: 0, grand: 0 };
  for (const t of liveTrades) {
    if (!byFy.has(t.fy)) {
      byFy.set(t.fy, { fy: t.fy, kite_swing: 0, fyers_scalp: 0, fyers_pa: 0, kite_total: 0, fyers_total: 0, total: 0 });
    }
    const row = byFy.get(t.fy);
    if (t.broker === "kite"  && t.mode === "EMA_RSI_ST") row.kite_swing  += t.pnl;
    if (t.broker === "fyers" && t.mode === "BB_RSI") row.fyers_scalp += t.pnl;
    if (t.broker === "fyers" && t.mode === "PA")    row.fyers_pa    += t.pnl;
    row[`${t.broker}_total`] += t.pnl;
    row.total += t.pnl;
    liveTotals[t.broker] += t.pnl;
    liveTotals.grand     += t.pnl;
  }
  const fyRows = Array.from(byFy.values()).sort((a, b) => b.fy.localeCompare(a.fy));
  const currentFy = toFy(new Date());
  const currentFyRow = byFy.get(currentFy) || null;

  const kiteBaseline  = baselines.kite.pnl  || 0;
  const fyersBaseline = baselines.fyers.pnl || 0;
  const kiteTotal  = kiteBaseline  + liveTotals.kite;
  const fyersTotal = fyersBaseline + liveTotals.fyers;
  const grandTotal = kiteTotal + fyersTotal;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>ௐ Palani Andawar Thunai ॐ — P&amp;L History</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script>(function(){ if ('${resolveTheme()}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    ${modalCSS()}
    ${tableEnhancerCSS()}
    .main-content{flex:1;margin-left:200px;padding:18px 22px 40px;min-height:100vh;}
    @media(max-width:900px){.main-content{margin-left:0;padding:14px;}}
    .page-title{font-size:1.1rem;font-weight:700;color:#e0eaf8;margin-bottom:2px;}
    .page-sub{font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-bottom:14px;}
    /* ── Breadcrumb ── */
    .breadcrumb{display:flex;align-items:center;gap:6px;font-size:0.68rem;font-weight:600;margin-bottom:6px;}
    .bc-link{color:var(--muted-1,#8ba1c2);text-decoration:none;padding:2px 6px;border-radius:4px;transition:color 0.15s,background 0.15s;}
    .bc-link:hover{color:#3b82f6;background:#0f1624;}
    .bc-sep{color:var(--muted-2,#6d85a8);font-size:0.75rem;}
    .bc-current{color:#e0eaf8;padding:2px 6px;}
    :root[data-theme="light"] .bc-link{color:#4b5769;}
    :root[data-theme="light"] .bc-link:hover{color:#2563eb;background:#f1f5f9;}
    :root[data-theme="light"] .bc-sep{color:#5c6b7f;}
    :root[data-theme="light"] .bc-current{color:#1e293b;}

    .stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;}
    @media(max-width:1100px){.stat-grid{grid-template-columns:repeat(2,1fr);}}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent,#3b82f6);}
    .sc-label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-2,#6d85a8);margin-bottom:5px;font-family:'IBM Plex Mono',monospace;}
    .sc-val{font-size:1.25rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#e0eaf8;}
    .sc-sub{font-size:0.6rem;color:var(--muted-1,#8ba1c2);margin-top:4px;}
    .sc-breakdown{font-size:0.62rem;color:#6b8ab0;margin-top:6px;font-family:'IBM Plex Mono',monospace;line-height:1.5;}

    .panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
    .panel h3{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.4px;color:var(--muted-2,#6d85a8);margin-bottom:10px;font-family:'IBM Plex Mono',monospace;display:flex;align-items:center;gap:8px;}
    .panel h3 .tag{font-size:0.5rem;padding:2px 7px;border-radius:3px;background:rgba(59,130,246,0.15);color:#60a5fa;border:0.5px solid rgba(59,130,246,0.3);letter-spacing:1px;}
    .panel h3 .tag.auto{background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);}

    .btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:6px 12px;border-radius:6px;font-size:0.7rem;cursor:pointer;font-family:inherit;transition:all 0.15s;}
    .btn:hover{background:#0a1e3d;border-color:#3b82f6;}
    .btn.primary{background:rgba(59,130,246,0.12);border-color:#3b82f6;color:#3b82f6;}
    .btn.primary:hover{background:rgba(59,130,246,0.2);}
    .btn.warn{border-color:rgba(239,68,68,0.3);color:#ef4444;}
    .btn.warn:hover{background:rgba(239,68,68,0.08);}

    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .tbl th{padding:8px 10px;text-align:left;font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;}
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;vertical-align:middle;}
    .tbl tr:hover td{background:rgba(59,130,246,0.04);}
    .tbl-wrap{overflow-x:auto;border:0.5px solid #0e1e36;border-radius:10px;}
    .tbl td.num,.tbl th.num{text-align:right;font-variant-numeric:tabular-nums;}
    .tbl tfoot td{background:#04090f;font-weight:700;border-top:0.5px solid #0e1e36;}

    .empty{text-align:center;padding:30px 20px;color:var(--muted-1,#8ba1c2);font-size:0.75rem;}
    .note{font-size:0.65rem;color:var(--muted-1,#8ba1c2);margin-top:10px;line-height:1.6;}

    /* ── Broker tabs (manual-trade analytics) ── */
    .broker-tabs{display:flex;gap:6px;margin-bottom:14px;border-bottom:0.5px solid #0e1e36;}
    .broker-tab{background:none;border:none;color:var(--muted-1,#8ba1c2);padding:9px 16px;font-size:0.75rem;font-weight:600;font-family:inherit;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color 0.15s,border-color 0.15s;}
    .broker-tab:hover{color:#c8d8f0;}
    .broker-tab.active{color:#3b82f6;border-bottom-color:#3b82f6;}
    .broker-panel{display:none;}
    .broker-panel.active{display:block;}

    .toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:14px;}
    .toolbar select,.toolbar input[type=file]{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:6px 10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.7rem;}
    .toolbar .spacer{flex:1;}
    .file-btn{position:relative;overflow:hidden;display:inline-block;}
    .file-btn input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;}

    .seg-toggle{display:flex;background:#04090f;border:0.5px solid #0e1e36;border-radius:6px;overflow:hidden;}
    .seg-toggle button{background:none;border:none;color:var(--muted-1,#8ba1c2);padding:6px 12px;font-size:0.68rem;font-weight:600;font-family:inherit;cursor:pointer;}
    .seg-toggle button.active{background:rgba(59,130,246,0.15);color:#3b82f6;}

    .metric-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:14px;}
    @media(max-width:1100px){.metric-grid{grid-template-columns:repeat(3,1fr);}}
    @media(max-width:560px){.metric-grid{grid-template-columns:repeat(2,1fr);}}
    .mc{background:#04090f;border:0.5px solid #0e1e36;border-radius:8px;padding:10px 12px;}
    .mc-label{font-size:0.52rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);margin-bottom:4px;font-family:'IBM Plex Mono',monospace;}
    .mc-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#e0eaf8;}

    .mistake-card{background:#04090f;border:0.5px solid #0e1e36;border-left:3px solid #ef4444;border-radius:8px;padding:12px 14px;margin-bottom:8px;}
    .mistake-card.warn{border-left-color:#f59e0b;}
    .mistake-title{font-size:0.78rem;font-weight:700;color:#e0eaf8;margin-bottom:3px;}
    .mistake-detail{font-size:0.68rem;color:var(--muted-1,#8ba1c2);line-height:1.5;}

    :root[data-theme="light"] .broker-tabs{border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .broker-tab{color:#4b5769!important;}
    :root[data-theme="light"] .broker-tab.active{color:#2563eb!important;border-bottom-color:#2563eb!important;}
    :root[data-theme="light"] .toolbar select,:root[data-theme="light"] .seg-toggle,:root[data-theme="light"] .mc{background:#f8fafc!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .mc-val{color:#1e293b!important;}
    :root[data-theme="light"] .mistake-card{background:#f8fafc!important;border-color:#e0e4ea!important;border-left-color:#ef4444!important;}
    :root[data-theme="light"] .mistake-title{color:#1e293b!important;}

    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .page-title{color:#1e293b!important;}
    :root[data-theme="light"] .page-sub,:root[data-theme="light"] .sc-sub,:root[data-theme="light"] .sc-breakdown,:root[data-theme="light"] .note,:root[data-theme="light"] .empty{color:#4b5769!important;}
    :root[data-theme="light"] .sc,:root[data-theme="light"] .panel{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .sc-label,:root[data-theme="light"] .panel h3{color:#4b5769!important;}
    :root[data-theme="light"] .sc-val{color:#1e293b!important;}
    :root[data-theme="light"] .btn{background:#f8fafc!important;border-color:#e0e4ea!important;color:#2563eb!important;}
    :root[data-theme="light"] .btn:hover{background:#eff6ff!important;border-color:#3b82f6!important;}
    :root[data-theme="light"] .tbl th{background:#f1f5f9!important;color:#4b5769!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbl td{border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .tbl tfoot td{background:#f1f5f9!important;}
    :root[data-theme="light"] .tbl-wrap{border-color:#e0e4ea!important;}
  </style>
</head>
<body>
<div class="app-shell">
  ${buildSidebar('pnlHistory', false)}
  <div class="main-content">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="/" class="bc-link">⌂ Dashboard</a>
      <span class="bc-sep">›</span>
      <a href="/settings" class="bc-link">⚙ Settings</a>
      <span class="bc-sep">›</span>
      <span class="bc-current">💰 P&amp;L History</span>
    </nav>
    <h1 class="page-title">💰 P&amp;L History</h1>
    <div class="page-sub">Past baseline (one-time, per broker) + live bot P&amp;L (auto, updates as trades close). All values in ₹.</div>

    <!-- Summary cards -->
    <div class="stat-grid">
      <div class="sc" style="--accent:${grandTotal >= 0 ? '#10b981' : '#ef4444'};">
        <div class="sc-label">Grand Total</div>
        <div class="sc-val" style="color:${colorOf(grandTotal)};">${fmtINR(grandTotal)}</div>
        <div class="sc-breakdown">
          Past: ${fmtINR(kiteBaseline + fyersBaseline)}<br/>
          Live bot: <span style="color:${colorOf(liveTotals.grand)};">${fmtINR(liveTotals.grand)}</span>
        </div>
      </div>
      <div class="sc" style="--accent:#f59e0b;">
        <div class="sc-label">Kite (Zerodha)</div>
        <div class="sc-val" style="color:${colorOf(kiteTotal)};">${fmtINR(kiteTotal)}</div>
        <div class="sc-breakdown">
          Past: ${fmtINR(kiteBaseline)}<br/>
          Live bot: <span style="color:${colorOf(liveTotals.kite)};">${fmtINR(liveTotals.kite)}</span>
        </div>
      </div>
      <div class="sc" style="--accent:#3b82f6;">
        <div class="sc-label">Fyers</div>
        <div class="sc-val" style="color:${colorOf(fyersTotal)};">${fmtINR(fyersTotal)}</div>
        <div class="sc-breakdown">
          Past: ${fmtINR(fyersBaseline)}<br/>
          Live bot: <span style="color:${colorOf(liveTotals.fyers)};">${fmtINR(liveTotals.fyers)}</span>
        </div>
      </div>
      <div class="sc" style="--accent:${currentFyRow && currentFyRow.total >= 0 ? '#10b981' : '#ef4444'};">
        <div class="sc-label">Current FY ${currentFy} (Live Bot)</div>
        <div class="sc-val" style="color:${colorOf(currentFyRow ? currentFyRow.total : 0)};">${fmtINR(currentFyRow ? currentFyRow.total : 0)}</div>
        <div class="sc-breakdown">
          ${currentFyRow ? `Kite ${fmtINR(currentFyRow.kite_total)} · Fyers ${fmtINR(currentFyRow.fyers_total)}` : 'No live trades yet this FY'}
        </div>
      </div>
    </div>

    <!-- Manual trading analytics — Kite / Fyers tabs -->
    <div class="panel">
      <h3>Manual Trading Analytics <span class="tag">MISTAKE ANALYSIS</span></h3>
      <div class="broker-tabs">
        <button class="broker-tab active" onclick="switchBrokerTab('kite')">Kite (Zerodha)</button>
        <button class="broker-tab" onclick="switchBrokerTab('fyers')">Fyers</button>
      </div>

      <div id="tab-kite" class="broker-panel active">
        <div class="toolbar">
          <span class="seg-toggle" id="segToggle-kite">
            <button class="active" data-seg="all" onclick="setSeg('kite','all')">All</button>
            <button data-seg="equity" onclick="setSeg('kite','equity')">Equity</button>
            <button data-seg="options" onclick="setSeg('kite','options')">Options</button>
            <button data-seg="futures" onclick="setSeg('kite','futures')">Futures</button>
          </span>
          <select id="yearSel-kite" onchange="renderBroker('kite')"><option value="all">All Years</option></select>
          <select id="monthSel-kite" onchange="renderBroker('kite')"><option value="all">All Months</option></select>
          <span class="spacer"></span>
          <span class="btn file-btn">📄 Import Tradebook CSV<input type="file" accept=".csv" multiple onchange="importCsv(this,'kite')"/></span>
          <button class="btn primary" onclick="syncNow()">${kiteConnected ? '⟳ Sync Now' : '⚠ Login to Sync'}</button>
        </div>
        <div class="note" id="syncNote-kite" style="margin-top:-6px;">
          ${manualStore.meta.lastSyncedTradeDate ? 'Last synced: ' + fmtDate(manualStore.meta.lastSyncedTradeDate) : 'Never synced.'}
          Past history has no live API — import your Kite Console → Reports → Tradebook CSV once; going forward, today's fills auto-sync daily after close (or click Sync Now).
        </div>

        <div id="analytics-kite"></div>
      </div>

      <div id="tab-fyers" class="broker-panel">
        <div class="toolbar">
          <span class="seg-toggle" id="segToggle-fyers">
            <button class="active" data-seg="all" onclick="setSeg('fyers','all')">All</button>
            <button data-seg="equity" onclick="setSeg('fyers','equity')">Equity</button>
            <button data-seg="options" onclick="setSeg('fyers','options')">Options</button>
            <button data-seg="futures" onclick="setSeg('fyers','futures')">Futures</button>
          </span>
          <select id="yearSel-fyers" onchange="renderBroker('fyers')"><option value="all">All Years</option></select>
          <select id="monthSel-fyers" onchange="renderBroker('fyers')"><option value="all">All Months</option></select>
          <span class="spacer"></span>
          <span class="btn file-btn">📄 Import Tradebook CSV<input type="file" accept=".csv" multiple onchange="importCsv(this,'fyers')"/></span>
        </div>
        <div class="note" style="margin-top:-6px;">Fyers has no live-sync route wired here (the user's manual trading happens on Kite) — import a tradebook CSV to see analytics. Live sync can be added the same way as Kite's if needed.</div>
        <div id="analytics-fyers"></div>
      </div>
    </div>

  </div>
</div>

<script>
${modalJS()}

// ── Manual trading analytics (Kite / Fyers tabs) ────────────────────────────
const MANUAL_TRIPS = ${jsonForScript(manualRoundTrips)};
const SEG_STATE = { kite: 'all', fyers: 'all' };

function switchBrokerTab(broker){
  document.querySelectorAll('.broker-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.broker-tab[onclick*="' + broker + '"]').classList.add('active');
  document.querySelectorAll('.broker-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + broker).classList.add('active');
}

function setSeg(broker, seg){
  SEG_STATE[broker] = seg;
  document.querySelectorAll('#segToggle-' + broker + ' button').forEach(b => b.classList.toggle('active', b.dataset.seg === seg));
  renderBroker(broker);
}

function populateYearMonth(broker){
  const trips = MANUAL_TRIPS.filter(t => t.broker === broker);
  const years = Array.from(new Set(trips.map(t => (t.exitDate || '').slice(0,4)).filter(Boolean))).sort().reverse();
  const yearSel = document.getElementById('yearSel-' + broker);
  years.forEach(y => { const o = document.createElement('option'); o.value = y; o.textContent = y; yearSel.appendChild(o); });
  const monthSel = document.getElementById('monthSel-' + broker);
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  MONTHS.forEach((m,i) => { const o = document.createElement('option'); o.value = String(i+1).padStart(2,'0'); o.textContent = m; monthSel.appendChild(o); });
}

function fmtR(n){
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return sign + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function colR(n){ return !n ? '#8ba1c2' : (n >= 0 ? '#10b981' : '#ef4444'); }
// Symbols/segments come from user-uploaded CSV content and are rendered via
// innerHTML below — escape before interpolating, same as any other untrusted string.
function escH(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function filteredTrips(broker){
  const seg = SEG_STATE[broker];
  const year = document.getElementById('yearSel-' + broker).value;
  const month = document.getElementById('monthSel-' + broker).value;
  return MANUAL_TRIPS.filter(t => {
    if (t.broker !== broker) return false;
    if (seg !== 'all' && t.segment !== seg) return false;
    const d = t.exitDate || '';
    if (year !== 'all' && d.slice(0,4) !== year) return false;
    if (month !== 'all' && d.slice(5,7) !== month) return false;
    return true;
  });
}

function computeMetrics(trips){
  const n = trips.length;
  if (n === 0) return null;
  const wins = trips.filter(t => t.pnl > 0);
  const losses = trips.filter(t => t.pnl < 0);
  const net = trips.reduce((a,t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a,t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a,t) => a + t.pnl, 0));
  const winRate = (wins.length / n) * 100;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = net / n;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  let maxDD = 0, peak = 0, running = 0;
  trips.forEach(t => { running += t.pnl; if (running > peak) peak = running; maxDD = Math.min(maxDD, running - peak); });
  return { n, winRate, net, avgWin, avgLoss, expectancy, profitFactor, maxDD, wins: wins.length, losses: losses.length };
}

// "Mistakes" — pattern flags a manual trader can actually act on:
//   1. Revenge trading: another trade in the SAME symbol within 15 min of a loss.
//   2. Oversized losers: any single loss > 3x the average loss.
//   3. Overtrading days: a day with 2x+ the average daily trade count.
//   4. Cutting winners short vs riding losers: avg loss bigger than avg win despite winning >50% of trades.
function findMistakes(trips){
  const mistakes = [];
  if (trips.length === 0) return mistakes;
  const sorted = [...trips].sort((a,b) => new Date(a.exitAt) - new Date(b.exitAt));

  let revengeCount = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i-1], cur = sorted[i];
    if (prev.pnl >= 0) continue;
    const gapMin = (new Date(cur.entryAt) - new Date(prev.exitAt)) / 60000;
    if (cur.symbol === prev.symbol && gapMin >= 0 && gapMin <= 15) revengeCount++;
  }
  if (revengeCount > 0) {
    mistakes.push({ title: '⚠ Revenge trading detected', warn: false,
      detail: revengeCount + ' trade(s) re-entered the same symbol within 15 minutes of a loss. Re-entering fast after a loss usually means the entry wasn\\'t re-evaluated — it was emotional.' });
  }

  const losses = trips.filter(t => t.pnl < 0);
  if (losses.length > 0) {
    const avgLoss = Math.abs(losses.reduce((a,t) => a + t.pnl, 0) / losses.length);
    const big = losses.filter(t => Math.abs(t.pnl) > avgLoss * 3);
    if (big.length > 0) {
      mistakes.push({ title: '⚠ Oversized losers', warn: false,
        detail: big.length + ' trade(s) lost more than 3x your average loss (avg ' + fmtR(-avgLoss) + '). Biggest: ' + fmtR(Math.min(...big.map(t => t.pnl))) + ' on ' + escH(big.sort((a,b)=>a.pnl-b.pnl)[0].symbol) + '. No stop-loss discipline, or a stop that was moved.' });
    }
  }

  const byDay = {};
  trips.forEach(t => { const d = t.exitDate; byDay[d] = (byDay[d] || 0) + 1; });
  const dayCounts = Object.values(byDay);
  if (dayCounts.length > 0) {
    const avgPerDay = dayCounts.reduce((a,b) => a+b, 0) / dayCounts.length;
    const overtradeDays = Object.entries(byDay).filter(([,c]) => c >= avgPerDay * 2 && c >= 4);
    if (overtradeDays.length > 0) {
      mistakes.push({ title: '⚠ Overtrading days', warn: true,
        detail: overtradeDays.length + ' day(s) had 2x+ your normal trade count (avg ' + avgPerDay.toFixed(1) + '/day). Worst: ' + overtradeDays.sort((a,b)=>b[1]-a[1])[0][1] + ' trades on ' + escH(overtradeDays.sort((a,b)=>b[1]-a[1])[0][0]) + '.' });
    }
  }

  const m = computeMetrics(trips);
  if (m && m.wins > m.losses && m.avgLoss > m.avgWin) {
    mistakes.push({ title: '⚠ Cutting winners short, letting losers run', warn: true,
      detail: 'You win ' + m.winRate.toFixed(0) + '% of trades, but avg loss (' + fmtR(-m.avgLoss) + ') is bigger than avg win (' + fmtR(m.avgWin) + '). Classic "small profit, big loss" pattern — exits are the leak, not entries.' });
  }

  if (m && m.profitFactor < 1 && m.n >= 5) {
    mistakes.push({ title: '⚠ Net losing over this period', warn: false,
      detail: 'Profit factor ' + m.profitFactor.toFixed(2) + ' (need >1.0 to be profitable). Gross loss exceeds gross win across ' + m.n + ' trades.' });
  }

  return mistakes;
}

function renderBroker(broker){
  const trips = filteredTrips(broker);
  const el = document.getElementById('analytics-' + broker);
  if (trips.length === 0) {
    el.innerHTML = '<div class="empty">No manual trades for this filter yet.' + (broker === 'kite' ? ' Import your Kite Console tradebook CSV or click Sync Now above.' : ' Import a Fyers tradebook CSV above.') + '</div>';
    return;
  }
  const m = computeMetrics(trips);
  const mistakes = findMistakes(trips);

  let html = '<div class="metric-grid">'
    + metricCard('Net P&L', fmtR(m.net), colR(m.net))
    + metricCard('Win Rate', m.winRate.toFixed(1) + '%', '#e0eaf8')
    + metricCard('Trades', String(m.n), '#e0eaf8')
    + metricCard('Avg Win', fmtR(m.avgWin), '#10b981')
    + metricCard('Avg Loss', fmtR(-m.avgLoss), '#ef4444')
    + metricCard('Profit Factor', isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞', colR(m.profitFactor - 1))
    + metricCard('Expectancy/Trade', fmtR(m.expectancy), colR(m.expectancy))
    + metricCard('Max Drawdown', fmtR(m.maxDD), '#ef4444')
    + metricCard('Wins / Losses', m.wins + ' / ' + m.losses, '#e0eaf8')
    + '</div>';

  html += '<h3 style="margin:14px 0 8px;">Mistakes Found</h3>';
  if (mistakes.length === 0) {
    html += '<div class="empty">No obvious mistake patterns in this filter — nice.</div>';
  } else {
    html += mistakes.map(mk => '<div class="mistake-card' + (mk.warn ? ' warn' : '') + '"><div class="mistake-title">' + mk.title + '</div><div class="mistake-detail">' + mk.detail + '</div></div>').join('');
  }

  const worst = [...trips].sort((a,b) => a.pnl - b.pnl).slice(0, 5);
  const best = [...trips].sort((a,b) => b.pnl - a.pnl).slice(0, 5);
  html += '<h3 style="margin:14px 0 8px;">Biggest Losers</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Symbol</th><th>Segment</th><th class="num">Qty</th><th class="num">P&L</th></tr></thead><tbody>'
    + worst.map(t => '<tr><td>' + escH(t.exitDate) + '</td><td>' + escH(t.symbol) + '</td><td>' + escH(t.segment) + '</td><td class="num">' + escH(t.qty) + '</td><td class="num" style="color:' + colR(t.pnl) + ';">' + fmtR(t.pnl) + '</td></tr>').join('')
    + '</tbody></table></div>';
  html += '<h3 style="margin:14px 0 8px;">Biggest Winners</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Symbol</th><th>Segment</th><th class="num">Qty</th><th class="num">P&L</th></tr></thead><tbody>'
    + best.map(t => '<tr><td>' + escH(t.exitDate) + '</td><td>' + escH(t.symbol) + '</td><td>' + escH(t.segment) + '</td><td class="num">' + escH(t.qty) + '</td><td class="num" style="color:' + colR(t.pnl) + ';">' + fmtR(t.pnl) + '</td></tr>').join('')
    + '</tbody></table></div>';

  el.innerHTML = html;
}

function metricCard(label, val, color){
  return '<div class="mc"><div class="mc-label">' + label + '</div><div class="mc-val" style="color:' + color + ';">' + val + '</div></div>';
}

async function importCsv(input, broker){
  const files = input.files ? Array.from(input.files) : [];
  if (files.length === 0) return;
  // Sequential, not Promise.all — the server does read-modify-write on one
  // JSON file per request, so parallel imports would race and drop rows.
  // Each file's outcome is recorded independently, then summarized once at
  // the end — no accumulated flags to get the combinations of wrong.
  const results = []; // { file, imported, updated, error, cancelled }
  for (const file of files) {
    try {
      const text = await file.text(); // can reject (e.g. NotReadableError) if the file becomes unreadable mid-batch
      const r = await secretFetch('/pnl-history/manual/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text, filename: file.name, broker }),
      });
      // secretFetch returns null only when the user cancels the API-secret
      // prompt — stop asking for remaining files, but keep whatever earlier
      // files already reported instead of discarding it.
      if (!r) { results.push({ file: file.name, cancelled: true }); break; }
      const j = await r.json();
      if (!j.success) results.push({ file: file.name, error: j.error || 'Import failed' });
      else results.push({ file: file.name, imported: j.imported, updated: j.updated });
    } catch (err) {
      results.push({ file: file.name, error: err.message });
    }
  }

  const totalImported = results.reduce((a, r) => a + (r.imported || 0), 0);
  const totalUpdated = results.reduce((a, r) => a + (r.updated || 0), 0);
  const errors = results.filter((r) => r.error).map((r) => r.file + ': ' + r.error);
  const wasCancelled = results.some((r) => r.cancelled);
  const didAnything = totalImported > 0 || totalUpdated > 0;

  if (!didAnything && errors.length === 0) {
    // Only reachable when the batch was cancelled before any file's request
    // completed — nothing happened yet, nothing to say.
    input.value = '';
    return;
  }

  let msg = didAnything ? ('Imported ' + totalImported + ' new fill(s), ' + totalUpdated + ' updated.') : 'Import failed.';
  if (errors.length > 0) msg += ' (' + errors.join('; ') + ')';
  if (wasCancelled) msg += ' (stopped — API secret prompt cancelled)';
  toast(msg, (errors.length > 0 || wasCancelled) ? 'error' : undefined);
  setTimeout(() => location.reload(), 800);
  input.value = '';
}

async function syncNow(){
  try {
    const r = await secretFetch('/pnl-history/manual/sync', { method: 'POST' });
    if (!r) return;
    const j = await r.json();
    if (!j.success) { toast(j.error || 'Sync failed', 'error'); return; }
    toast('Synced ' + j.imported + " new fill(s) from today's trades.");
    setTimeout(() => location.reload(), 800);
  } catch (err) { toast('Network error: ' + err.message, 'error'); }
}

populateYearMonth('kite');
populateYearMonth('fyers');
renderBroker('kite');
renderBroker('fyers');

function toast(msg, type){
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#07111f;border:1px solid ' + (type === 'error' ? '#ef4444' : '#10b981') + ';color:' + (type === 'error' ? '#ef4444' : '#10b981') + ';padding:10px 18px;border-radius:8px;z-index:9999;font-size:0.8rem;font-family:Inter,sans-serif;';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

${tableEnhancerJS()}
</script>
</body>
</html>`;

  res.send(html);
});

// ── Template helpers ─────────────────────────────────────────────────────────

function fmtINR(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return sign + "₹" + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function colorOf(n) {
  if (!n) return "#8ba1c2";
  return n >= 0 ? "#10b981" : "#ef4444";
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    const ist = new Date(d.getTime() + 19800000);
    const dd = String(ist.getUTCDate()).padStart(2, "0");
    const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = ist.getUTCFullYear();
    const hh = String(ist.getUTCHours()).padStart(2, "0");
    const mi = String(ist.getUTCMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  } catch (_) { return "—"; }
}

module.exports = router;

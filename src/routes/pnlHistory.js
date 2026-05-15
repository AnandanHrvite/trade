/**
 * PNL HISTORY — /pnl-history
 * ─────────────────────────────────────────────────────────────────────────────
 * Consolidated realised P&L across Kite (Zerodha) + Fyers.
 *
 *   past pnl         = one-time user entry per broker (baseline, not FY-split)
 *                      stored in ~/trading-data/historical_pnl.json
 *   live bot pnl     = auto-computed from the bot's own live-trade JSON files
 *                      (swing live → Kite; scalp live + PA live → Fyers),
 *                      grouped by Indian financial year (Apr–Mar)
 *   grand total      = past baseline + live bot pnl, per broker and overall
 *
 * User sets the past baseline once per broker; it never changes unless edited.
 * Everything else updates automatically as live trades close.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

const _HOME = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const DATA_FILE = path.join(DATA_DIR, "historical_pnl.json");

const LIVE_SOURCES = [
  { file: path.join(DATA_DIR, "live_trades.json"),       broker: "kite",  mode: "Swing" },
  { file: path.join(DATA_DIR, "scalp_live_trades.json"), broker: "fyers", mode: "Scalp" },
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

// ── Dashboard ────────────────────────────────────────────────────────────────

router.get("/", (req, res) => {
  const baselines = loadBaselines();
  const liveTrades = loadLiveTrades();

  // Group live trades by FY + broker + mode
  const byFy = new Map(); // fy -> { fy, kite_swing, fyers_scalp, fyers_pa, kite_total, fyers_total, total }
  const liveTotals = { kite: 0, fyers: 0, grand: 0 };
  for (const t of liveTrades) {
    if (!byFy.has(t.fy)) {
      byFy.set(t.fy, { fy: t.fy, kite_swing: 0, fyers_scalp: 0, fyers_pa: 0, kite_total: 0, fyers_total: 0, total: 0 });
    }
    const row = byFy.get(t.fy);
    if (t.broker === "kite"  && t.mode === "Swing") row.kite_swing  += t.pnl;
    if (t.broker === "fyers" && t.mode === "Scalp") row.fyers_scalp += t.pnl;
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
  <script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    ${modalCSS()}
    .main-content{flex:1;margin-left:200px;padding:18px 22px 40px;min-height:100vh;}
    @media(max-width:900px){.main-content{margin-left:0;padding:14px;}}
    .page-title{font-size:1.1rem;font-weight:700;color:#e0eaf8;margin-bottom:2px;}
    .page-sub{font-size:0.72rem;color:#4a6080;margin-bottom:14px;}
    /* ── Breadcrumb ── */
    .breadcrumb{display:flex;align-items:center;gap:6px;font-size:0.68rem;font-weight:600;margin-bottom:6px;}
    .bc-link{color:#4a6080;text-decoration:none;padding:2px 6px;border-radius:4px;transition:color 0.15s,background 0.15s;}
    .bc-link:hover{color:#3b82f6;background:#0f1624;}
    .bc-sep{color:#3a5070;font-size:0.75rem;}
    .bc-current{color:#e0eaf8;padding:2px 6px;}
    :root[data-theme="light"] .bc-link{color:#64748b;}
    :root[data-theme="light"] .bc-link:hover{color:#2563eb;background:#f1f5f9;}
    :root[data-theme="light"] .bc-sep{color:#94a3b8;}
    :root[data-theme="light"] .bc-current{color:#1e293b;}

    .stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;}
    @media(max-width:1100px){.stat-grid{grid-template-columns:repeat(2,1fr);}}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent,#3b82f6);}
    .sc-label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:5px;font-family:'IBM Plex Mono',monospace;}
    .sc-val{font-size:1.25rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#e0eaf8;}
    .sc-sub{font-size:0.6rem;color:#4a6080;margin-top:4px;}
    .sc-breakdown{font-size:0.62rem;color:#6b8ab0;margin-top:6px;font-family:'IBM Plex Mono',monospace;line-height:1.5;}

    .panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
    .panel h3{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.4px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;display:flex;align-items:center;gap:8px;}
    .panel h3 .tag{font-size:0.5rem;padding:2px 7px;border-radius:3px;background:rgba(59,130,246,0.15);color:#3b82f6;border:0.5px solid rgba(59,130,246,0.3);letter-spacing:1px;}
    .panel h3 .tag.auto{background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);}

    .baseline-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    @media(max-width:780px){.baseline-grid{grid-template-columns:1fr;}}
    .bs-card{background:#04090f;border:0.5px solid #0e1e36;border-radius:8px;padding:14px;}
    .bs-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
    .bs-name{font-size:0.8rem;font-weight:700;color:#e0eaf8;}
    .bs-name .sub{font-size:0.6rem;color:#4a6080;margin-left:6px;font-weight:400;}
    .bs-val{font-size:1.15rem;font-weight:700;font-family:'IBM Plex Mono',monospace;margin-bottom:8px;}
    .bs-notes{font-size:0.65rem;color:#6b8ab0;margin-bottom:8px;min-height:1em;}
    .bs-updated{font-size:0.55rem;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
    .bs-actions{display:flex;gap:8px;}

    .btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:6px 12px;border-radius:6px;font-size:0.7rem;cursor:pointer;font-family:inherit;transition:all 0.15s;}
    .btn:hover{background:#0a1e3d;border-color:#3b82f6;}
    .btn.primary{background:rgba(59,130,246,0.12);border-color:#3b82f6;color:#3b82f6;}
    .btn.primary:hover{background:rgba(59,130,246,0.2);}
    .btn.warn{border-color:rgba(239,68,68,0.3);color:#ef4444;}
    .btn.warn:hover{background:rgba(239,68,68,0.08);}

    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .tbl th{padding:8px 10px;text-align:left;font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:#1e3050;background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;}
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;vertical-align:middle;}
    .tbl tr:hover td{background:rgba(59,130,246,0.04);}
    .tbl-wrap{overflow-x:auto;border:0.5px solid #0e1e36;border-radius:10px;}
    .tbl td.num,.tbl th.num{text-align:right;font-variant-numeric:tabular-nums;}
    .tbl tfoot td{background:#04090f;font-weight:700;border-top:0.5px solid #0e1e36;}

    .empty{text-align:center;padding:30px 20px;color:#4a6080;font-size:0.75rem;}
    .note{font-size:0.65rem;color:#4a6080;margin-top:10px;line-height:1.6;}

    /* Modal (for edit baseline) */
    .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.65);display:none;align-items:center;justify-content:center;z-index:1000;}
    .modal-backdrop.on{display:flex;}
    .modal-box{background:#07111f;border:1px solid #1a2236;border-radius:10px;padding:20px;width:min(460px,92vw);}
    .modal-title{font-size:0.85rem;font-weight:700;margin-bottom:4px;color:#e0eaf8;}
    .modal-sub{font-size:0.65rem;color:#4a6080;margin-bottom:14px;}
    .modal-box label{display:block;font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin:10px 0 4px;font-family:'IBM Plex Mono',monospace;}
    .modal-box input{width:100%;background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:8px 10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.8rem;outline:none;}
    .modal-box input:focus{border-color:#3b82f6;}
    .modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;}

    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .page-title{color:#1e293b!important;}
    :root[data-theme="light"] .page-sub,:root[data-theme="light"] .sc-sub,:root[data-theme="light"] .sc-breakdown,:root[data-theme="light"] .bs-notes,:root[data-theme="light"] .bs-updated,:root[data-theme="light"] .note,:root[data-theme="light"] .empty{color:#64748b!important;}
    :root[data-theme="light"] .sc,:root[data-theme="light"] .panel,:root[data-theme="light"] .modal-box{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .sc-label,:root[data-theme="light"] .panel h3,:root[data-theme="light"] .modal-box label{color:#64748b!important;}
    :root[data-theme="light"] .sc-val,:root[data-theme="light"] .bs-name,:root[data-theme="light"] .modal-title{color:#1e293b!important;}
    :root[data-theme="light"] .bs-card{background:#f8fafc!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .modal-box input{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .btn{background:#f8fafc!important;border-color:#e0e4ea!important;color:#2563eb!important;}
    :root[data-theme="light"] .btn:hover{background:#eff6ff!important;border-color:#3b82f6!important;}
    :root[data-theme="light"] .tbl th{background:#f1f5f9!important;color:#64748b!important;border-bottom-color:#e0e4ea!important;}
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

    <!-- Baselines (one-time entry per broker) -->
    <div class="panel">
      <h3>Past P&amp;L Baseline <span class="tag">ONE-TIME</span></h3>
      <div class="baseline-grid">
        ${baselineCard('kite',  'Kite (Zerodha)',  baselines.kite)}
        ${baselineCard('fyers', 'Fyers',           baselines.fyers)}
      </div>
      <div class="note">Enter the total realised P&amp;L from your broker's Console / Reports (cumulative across all prior years, Equity + F&amp;O combined). Set it once and leave it — live bot trades add on top automatically.</div>
    </div>

    <!-- Live bot P&L by FY (auto) -->
    <div class="panel">
      <h3>Live Bot P&amp;L by Financial Year <span class="tag auto">AUTO</span></h3>
      ${fyRows.length === 0 ? `<div class="empty">No live bot trades recorded yet. Numbers will appear here automatically as live trades close.</div>` : `
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>Financial Year</th>
              <th class="num">Swing (Kite)</th>
              <th class="num">Scalp (Fyers)</th>
              <th class="num">PA (Fyers)</th>
              <th class="num">Kite Sub</th>
              <th class="num">Fyers Sub</th>
              <th class="num">FY Total</th>
            </tr>
          </thead>
          <tbody>
            ${fyRows.map(r => `
              <tr>
                <td style="font-weight:600;">FY ${r.fy}${r.fy === currentFy ? ' <span style="color:#10b981;font-size:0.55rem;">(current)</span>' : ''}</td>
                <td class="num" style="color:${colorOf(r.kite_swing)};">${r.kite_swing ? fmtINR(r.kite_swing) : '—'}</td>
                <td class="num" style="color:${colorOf(r.fyers_scalp)};">${r.fyers_scalp ? fmtINR(r.fyers_scalp) : '—'}</td>
                <td class="num" style="color:${colorOf(r.fyers_pa)};">${r.fyers_pa ? fmtINR(r.fyers_pa) : '—'}</td>
                <td class="num" style="color:${colorOf(r.kite_total)};">${fmtINR(r.kite_total)}</td>
                <td class="num" style="color:${colorOf(r.fyers_total)};">${fmtINR(r.fyers_total)}</td>
                <td class="num" style="color:${colorOf(r.total)};font-weight:700;">${fmtINR(r.total)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td>All FYs</td>
              <td class="num" style="color:${colorOf(sumCol(fyRows, 'kite_swing'))};">${fmtINR(sumCol(fyRows, 'kite_swing'))}</td>
              <td class="num" style="color:${colorOf(sumCol(fyRows, 'fyers_scalp'))};">${fmtINR(sumCol(fyRows, 'fyers_scalp'))}</td>
              <td class="num" style="color:${colorOf(sumCol(fyRows, 'fyers_pa'))};">${fmtINR(sumCol(fyRows, 'fyers_pa'))}</td>
              <td class="num" style="color:${colorOf(liveTotals.kite)};">${fmtINR(liveTotals.kite)}</td>
              <td class="num" style="color:${colorOf(liveTotals.fyers)};">${fmtINR(liveTotals.fyers)}</td>
              <td class="num" style="color:${colorOf(liveTotals.grand)};">${fmtINR(liveTotals.grand)}</td>
            </tr>
          </tfoot>
        </table>
      </div>`}
      <div class="note">Source files: <code>live_trades.json</code> (Swing/Kite), <code>scalp_live_trades.json</code> (Scalp/Fyers), <code>pa_live_trades.json</code> (PA/Fyers). India FY = April–March.</div>
    </div>

  </div>
</div>

<!-- Edit baseline modal -->
<div id="editModal" class="modal-backdrop" onclick="if(event.target===this)closeModal()">
  <div class="modal-box">
    <div class="modal-title">Edit <span id="mBrokerName"></span> Baseline</div>
    <div class="modal-sub">Total realised P&amp;L across all prior years (Equity + F&amp;O). From your broker Console → Reports → P&amp;L.</div>
    <label>Net P&amp;L (₹)</label>
    <input type="number" id="mPnl" step="0.01" placeholder="e.g. 125000 or -80000"/>
    <label>Notes (optional)</label>
    <input type="text" id="mNotes" maxlength="300" placeholder="e.g. Through FY 2024-25, ITR filed"/>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="saveBaseline()">Save</button>
    </div>
  </div>
</div>

<script>
${modalJS()}
const BASELINES = ${JSON.stringify(baselines)};
let currentBroker = null;

function toast(msg, type){
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#07111f;border:1px solid ' + (type === 'error' ? '#ef4444' : '#10b981') + ';color:' + (type === 'error' ? '#ef4444' : '#10b981') + ';padding:10px 18px;border-radius:8px;z-index:9999;font-size:0.8rem;font-family:Inter,sans-serif;';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

function openEdit(broker){
  currentBroker = broker;
  const b = BASELINES[broker] || { pnl: 0, notes: '' };
  document.getElementById('mBrokerName').textContent = broker === 'kite' ? 'Kite (Zerodha)' : 'Fyers';
  document.getElementById('mPnl').value = b.pnl || '';
  document.getElementById('mNotes').value = b.notes || '';
  document.getElementById('editModal').classList.add('on');
  setTimeout(() => document.getElementById('mPnl').focus(), 50);
}
function closeModal(){ document.getElementById('editModal').classList.remove('on'); currentBroker = null; }

async function saveBaseline(){
  if (!currentBroker) return;
  const pnl = document.getElementById('mPnl').value;
  const notes = document.getElementById('mNotes').value;
  if (pnl === '' || !Number.isFinite(Number(pnl))) { toast('Enter a valid number', 'error'); return; }
  try {
    const r = await fetch('/pnl-history/baseline/' + currentBroker, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pnl: Number(pnl), notes }),
    });
    const j = await r.json();
    if (!j.success) { toast(j.error || 'Failed', 'error'); return; }
    toast('Baseline saved');
    setTimeout(() => location.reload(), 500);
  } catch (err) { toast('Network error: ' + err.message, 'error'); }
}

async function resetBaseline(broker){
  const label = broker === 'kite' ? 'Kite' : 'Fyers';
  const ok = await showDoubleConfirm({
    icon: '⚠️',
    title: 'Reset baseline',
    message: 'Reset ' + label + ' baseline to ₹0?\\nThis cannot be undone.',
    confirmText: 'Reset',
    confirmClass: 'modal-btn-danger',
    subject: label + ' baseline',
    secondConfirmText: 'Yes, reset'
  });
  if (!ok) return;
  try {
    const r = await fetch('/pnl-history/baseline/' + broker + '/reset', { method: 'POST' });
    const j = await r.json();
    if (!j.success) { toast(j.error || 'Failed', 'error'); return; }
    toast('Baseline reset');
    setTimeout(() => location.reload(), 500);
  } catch (err) { toast('Network error: ' + err.message, 'error'); }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && document.getElementById('editModal').classList.contains('on')) saveBaseline();
});
</script>
</body>
</html>`;

  res.send(html);
});

// ── Template helpers ─────────────────────────────────────────────────────────

function baselineCard(broker, label, bs) {
  const pnl = Number(bs.pnl) || 0;
  const hasValue = bs.updatedAt != null;
  return `
    <div class="bs-card">
      <div class="bs-head">
        <div class="bs-name">${label} <span class="sub">${broker === 'kite' ? 'Swing live trades here' : 'Scalp + PA live trades here'}</span></div>
      </div>
      <div class="bs-val" style="color:${colorOf(pnl)};">${fmtINR(pnl)}</div>
      <div class="bs-notes">${hasValue ? escapeHtml(bs.notes || '(no notes)') : '<em style="color:#3a5070;">Not set — click Edit to enter your past P&amp;L total</em>'}</div>
      <div class="bs-updated">${hasValue ? 'Updated ' + fmtDate(bs.updatedAt) : ''}</div>
      <div class="bs-actions">
        <button class="btn primary" onclick="openEdit('${broker}')">${hasValue ? '✎ Edit' : '＋ Set Baseline'}</button>
        ${hasValue ? `<button class="btn warn" onclick="resetBaseline('${broker}')">Reset</button>` : ''}
      </div>
    </div>`;
}

function fmtINR(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return sign + "₹" + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function colorOf(n) {
  if (!n) return "#4a6080";
  return n >= 0 ? "#10b981" : "#ef4444";
}

function sumCol(rows, key) {
  return rows.reduce((a, r) => a + (r[key] || 0), 0);
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = router;

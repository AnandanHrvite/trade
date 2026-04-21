/**
 * ALL BACKTEST — /all-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Unified dashboard: run SWING + SCALP + PRICE ACTION backtests from one page
 * with a shared date/resolution form. Renders only the top stat-grid panels
 * (no trade lists). Triggers the existing backtest routes sequentially (job
 * manager is 1-at-a-time), then reads the saved summaries.
 *
 * Routes:
 *   GET /all-backtest              → dashboard page (renders last saved stats)
 *   GET /all-backtest/stats?key=…  → JSON summary for one strategy
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const { loadResult } = require("../utils/resultStore");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");
const { ACTIVE } = require("../strategies");
const scalpStrategy = require("../strategies/scalp_bb_cpr");
const paStrategy    = require("../strategies/price_action");
const sharedSocketState = require("../utils/sharedSocketState");

const SWING_KEY = ACTIVE;
const SCALP_KEY = "SCALP_BACKTEST";
const PA_KEY    = "PA_BACKTEST";

// ── JSON: return just summary/params for a stored strategy result ────────────
router.get("/stats", (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: "missing key" });
  const r = loadResult(key);
  if (!r) return res.json({ exists: false });
  res.json({
    exists:  true,
    summary: r.summary || null,
    params:  r.params  || null,
    savedAt: r.savedAt || null,
  });
});

// ── Formatting helpers (mirror the individual backtest pages) ────────────────
const pts      = (n) => typeof n === "number" ? (n >= 0 ? "+" : "") + n.toFixed(2) + " pts" : "\u2014";
const pnlColor = (n) => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";
const fmtPnl   = (n, s) => {
  if (typeof n !== "number") return "\u2014";
  if (s && s.optionSim) return (n >= 0 ? "+" : "") + "\u20b9" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return pts(n);
};

function renderPanel(label, color, strategyName, key, basePath, result) {
  const s = result && result.summary;
  const savedAt = result && result.savedAt;
  const params  = result && result.params;
  const ago = savedAt ? timeAgo(new Date(savedAt)) : "never";
  const paramsStr = params ? `${params.from} \u2192 ${params.to} \u00b7 ${params.resolution}-min` : "\u2014";

  const empty = !s;
  const statsHtml = empty
    ? `<div class="empty-state">No saved backtest yet. Use <b>Run</b> to start.</div>`
    : `
      <div class="stat-grid">
        <div class="sc blue"><div class="sc-label">Total Trades</div><div class="sc-val">${s.totalTrades}</div><div class="sc-sub">${s.wins}W \u00b7 ${s.losses}L</div></div>
        <div class="sc green"><div class="sc-label">Max Profit</div><div class="sc-val" style="color:#10b981;">${fmtPnl(s.maxProfit, s)}</div><div class="sc-sub">Best single trade</div></div>
        <div class="sc ${(s.totalPnl||0)>=0?"green":"red"}"><div class="sc-label">Total PnL</div><div class="sc-val" style="color:${pnlColor(s.totalPnl)};">${fmtPnl(s.totalPnl, s)}</div><div class="sc-sub">${s.optionSim ? `Option sim: \u03b4=${s.delta} \u03b8=\u20b9${s.thetaPerDay}/day` : "Raw NIFTY index pts"}</div></div>
        <div class="sc red"><div class="sc-label">Max Drawdown</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.maxDrawdown, s)}</div><div class="sc-sub">Worst peak-to-trough</div></div>
        <div class="sc red"><div class="sc-label">Total Drawdown</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.totalDrawdown, s)}</div><div class="sc-sub">Sum of all losses</div></div>
        <div class="sc purple"><div class="sc-label">Risk/Reward</div><div class="sc-val">${s.riskReward||"\u2014"}</div><div class="sc-sub">1 : avg win \u00f7 avg loss</div></div>
        <div class="sc yellow"><div class="sc-label">Win Rate</div><div class="sc-val">${typeof s.winRate === "number" ? s.winRate + "%" : (s.winRate || "\u2014")}</div><div class="sc-sub">${s.wins} wins of ${s.totalTrades}</div></div>
      </div>
      ${typeof s.profitFactor === "number" || typeof s.sharpeRatio === "number" ? `
      <div class="stat-grid-2">
        <div class="sc orange"><div class="sc-label">Profit Factor</div><div class="sc-val" style="color:${s.profitFactor>=1.5?'#10b981':s.profitFactor>=1?'#f59e0b':'#ef4444'};">${s.profitFactor===null?'\u2014':(s.profitFactor===Infinity?'\u221e':s.profitFactor)}</div><div class="sc-sub">Gross P \u20b9${Math.round(s.grossProfit||0).toLocaleString("en-IN")} / L \u20b9${Math.round(s.grossLoss||0).toLocaleString("en-IN")}</div></div>
        <div class="sc cyan"><div class="sc-label">Expectancy</div><div class="sc-val" style="color:${pnlColor(s.expectancy)};">${fmtPnl(s.expectancy, s)}</div><div class="sc-sub">Avg P&L per trade</div></div>
        <div class="sc red"><div class="sc-label">Max Loss</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.maxLoss, s)}</div><div class="sc-sub">Worst single trade</div></div>
        <div class="sc green"><div class="sc-label">Avg Win</div><div class="sc-val" style="color:#10b981;">${fmtPnl(s.avgWin, s)}</div><div class="sc-sub">${s.wins} winning trades</div></div>
        <div class="sc red"><div class="sc-label">Avg Loss</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.avgLoss, s)}</div><div class="sc-sub">${s.losses} losing trades</div></div>
        <div class="sc blue"><div class="sc-label">Recovery Factor</div><div class="sc-val" style="color:${s.recoveryFactor>=2?'#10b981':s.recoveryFactor>=1?'#f59e0b':'#ef4444'};">${s.recoveryFactor==null?'\u2014':s.recoveryFactor}</div><div class="sc-sub">PnL \u00f7 Max DD</div></div>
        <div class="sc purple"><div class="sc-label">Sharpe Ratio</div><div class="sc-val" style="color:${s.sharpeRatio>=1?'#10b981':s.sharpeRatio>=0.5?'#f59e0b':'#ef4444'};">${s.sharpeRatio==null?'\u2014':s.sharpeRatio}</div><div class="sc-sub">Annualized (daily)</div></div>
      </div>` : ""}
    `;

  return `
  <section class="panel" data-key="${key}" data-base="${basePath}">
    <div class="panel-head">
      <div class="panel-title">
        <span class="badge" style="background:${color.bg};color:${color.fg};border:0.5px solid ${color.border};">${label}</span>
        <span class="strategy-name" style="color:${color.fg};">${strategyName}</span>
        <span class="run-status" data-status></span>
      </div>
      <div class="panel-meta">
        <span class="meta-range" data-meta-range>${paramsStr}</span>
        <span class="meta-dot">\u00b7</span>
        <span class="meta-ago" data-meta-ago>${ago}</span>
        <button class="btn-run" data-run>\u25b6 Run</button>
      </div>
    </div>
    <div class="panel-body" data-body>${statsHtml}</div>
  </section>`;
}

function timeAgo(d) {
  if (!d || isNaN(d.getTime())) return "never";
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60)    return diffSec + "s ago";
  if (diffSec < 3600)  return Math.floor(diffSec / 60) + "m ago";
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + "h ago";
  return Math.floor(diffSec / 86400) + "d ago";
}

// ── Dashboard page ───────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";

  const now = new Date();
  const defFrom = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-01';
  const defTo   = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
  const from       = req.query.from       || defFrom;
  const to         = req.query.to         || defTo;
  const swingRes   = req.query.swingRes   || "15";
  const scalpRes   = req.query.scalpRes   || "5";
  const paRes      = req.query.paRes      || "5";

  const swingResult = loadResult(SWING_KEY);
  const scalpResult = loadResult(SCALP_KEY);
  const paResult    = loadResult(PA_KEY);

  const swingPanel = renderPanel(
    "SWING", { bg: "rgba(59,130,246,0.12)", fg: "#60a5fa", border: "rgba(59,130,246,0.25)" },
    SWING_KEY, SWING_KEY, "/swing-backtest", swingResult
  );
  const scalpPanel = renderPanel(
    "SCALP", { bg: "rgba(245,158,11,0.12)", fg: "#fbbf24", border: "rgba(245,158,11,0.25)" },
    scalpStrategy && scalpStrategy.NAME ? scalpStrategy.NAME : "SCALP_BB_RSI_V4",
    SCALP_KEY, "/scalp-backtest", scalpResult
  );
  const paPanel = renderPanel(
    "PRICE ACTION", { bg: "rgba(139,92,246,0.12)", fg: "#a78bfa", border: "rgba(139,92,246,0.25)" },
    paStrategy && paStrategy.NAME ? paStrategy.NAME : "PRICE_ACTION_5M",
    PA_KEY, "/pa-backtest", paResult
  );

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u23fa</text></svg>">
<title>All Backtests — Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;min-height:100vh;}
  .page{padding:16px 20px 40px;}

  .crumb{background:#06090e;border-bottom:0.5px solid #0e1428;padding:6px 20px;display:flex;align-items:center;gap:7px;margin:-16px -20px 14px;position:sticky;top:44px;z-index:90;flex-wrap:wrap;}
  .crumb .pill{font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;text-transform:uppercase;letter-spacing:0.5px;font-family:'IBM Plex Mono',monospace;}
  .crumb .pill-all{background:rgba(99,102,241,0.12);color:#818cf8;border:0.5px solid rgba(99,102,241,0.25);}
  .crumb .pill-range{background:rgba(245,158,11,0.1);color:#fbbf24;border:0.5px solid rgba(245,158,11,0.2);}

  .run-bar{display:flex;align-items:flex-end;gap:10px;background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:11px 14px;margin-bottom:14px;flex-wrap:wrap;}
  .run-bar label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;display:block;margin-bottom:3px;}
  .run-bar input,.run-bar select{background:#fff;border:1px solid #1e3a8a;color:#0f172a;padding:5px 8px;border-radius:5px;font-size:0.75rem;font-family:'IBM Plex Mono',monospace;cursor:pointer;color-scheme:light;}
  .run-btn{background:#1a3a8a;color:#90c0ff;border:1px solid #2a5ac0;padding:6px 14px;border-radius:5px;font-size:0.7rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;white-space:nowrap;}
  .run-btn:hover{background:#2563eb;color:#fff;}
  .run-btn:disabled{opacity:.5;cursor:not-allowed;}
  .preset-btn{font-size:0.65rem;padding:3px 10px;border-radius:4px;background:rgba(59,130,246,0.08);color:#60a5fa;border:0.5px solid rgba(59,130,246,0.2);cursor:pointer;font-family:"IBM Plex Mono",monospace;transition:all 0.15s;}
  .preset-btn:hover{background:rgba(59,130,246,0.18);}

  .panel{background:#08091a;border:0.5px solid #0e1428;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
  .panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
  .panel-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
  .strategy-name{font-size:0.75rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
  .badge{font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;text-transform:uppercase;letter-spacing:0.5px;font-family:'IBM Plex Mono',monospace;}
  .panel-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
  .meta-range{font-size:0.68rem;color:#6b8db5;font-family:'IBM Plex Mono',monospace;}
  .meta-dot{color:#1e3050;font-size:0.7rem;}
  .meta-ago{font-size:0.68rem;color:#4a6080;font-family:'IBM Plex Mono',monospace;}
  .btn-run{background:#0d1320;border:1px solid #1a2540;color:#60a5fa;padding:4px 10px;border-radius:5px;font-size:0.68rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;}
  .btn-run:hover{background:#0a1e3d;border-color:#3b82f6;}
  .btn-run:disabled{opacity:.5;cursor:not-allowed;}

  .run-status{font-size:0.6rem;text-transform:uppercase;letter-spacing:0.8px;padding:2px 7px;border-radius:3px;font-family:'IBM Plex Mono',monospace;}
  .run-status.idle{display:none;}
  .run-status.queued{background:rgba(245,158,11,0.12);color:#f59e0b;border:0.5px solid rgba(245,158,11,0.25);}
  .run-status.running{background:rgba(59,130,246,0.15);color:#60a5fa;border:0.5px solid rgba(59,130,246,0.3);}
  .run-status.done{background:rgba(16,185,129,0.12);color:#34d399;border:0.5px solid rgba(16,185,129,0.25);}
  .run-status.error{background:rgba(239,68,68,0.15);color:#f87171;border:0.5px solid rgba(239,68,68,0.3);}

  .stat-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;margin-bottom:10px;}
  .stat-grid-2{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;margin-bottom:0;}
  @media(max-width:1100px){.stat-grid,.stat-grid-2{grid-template-columns:repeat(4,1fr);}}
  @media(max-width:760px){.stat-grid,.stat-grid-2{grid-template-columns:repeat(2,1fr);}}

  .sc{background:#0a0b1c;border:0.5px solid #0e1428;border-radius:7px;padding:12px 14px;position:relative;overflow:hidden;}
  .sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
  .sc.blue::before{background:#3b82f6;}.sc.green::before{background:#10b981;}.sc.red::before{background:#ef4444;}.sc.yellow::before{background:#f59e0b;}.sc.purple::before{background:#8b5cf6;}.sc.orange::before{background:#f97316;}.sc.cyan::before{background:#06b6d4;}
  .sc-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.2px;color:#1e3050;margin-bottom:5px;font-family:"IBM Plex Mono",monospace;}
  .sc-val{font-size:1.05rem;font-weight:700;color:#a0b8d8;font-family:"IBM Plex Mono",monospace;line-height:1.2;}
  .sc-sub{font-size:0.6rem;color:#4a6080;margin-top:3px;}

  .empty-state{padding:28px 14px;text-align:center;font-size:0.72rem;color:#4a6080;background:#05060f;border:0.5px dashed #1a2540;border-radius:7px;}

  .progress-line{height:3px;background:#0a0e1a;border-radius:2px;overflow:hidden;margin:6px 0 0;display:none;}
  .progress-line .bar{height:100%;background:linear-gradient(90deg,#3b82f6,#10b981);width:0;transition:width 0.6s ease;}
  .panel.running .progress-line{display:block;}

  /* ── Light theme overrides ── */
  :root[data-theme="light"] .crumb{background:#ffffff !important;border-bottom-color:#e0e4ea !important;}
  :root[data-theme="light"] .crumb > span[style*="color:#1e2a40"]{color:#94a3b8 !important;}
  :root[data-theme="light"] .run-btn{background:#2563eb !important;color:#ffffff !important;border-color:#2563eb !important;}
  :root[data-theme="light"] .run-btn:hover{background:#1d4ed8 !important;color:#ffffff !important;}
  :root[data-theme="light"] .btn-run{background:#eff6ff !important;border-color:#bfdbfe !important;color:#2563eb !important;}
  :root[data-theme="light"] .btn-run:hover{background:#dbeafe !important;border-color:#3b82f6 !important;}
  :root[data-theme="light"] .empty-state{background:#f8fafc !important;border-color:#cbd5e1 !important;color:#94a3b8 !important;}
  :root[data-theme="light"] .meta-range{color:#64748b !important;}
  :root[data-theme="light"] .meta-dot{color:#cbd5e1 !important;}
  :root[data-theme="light"] .meta-ago{color:#94a3b8 !important;}
  :root[data-theme="light"] .sc-label{color:#64748b !important;}
  :root[data-theme="light"] .progress-line{background:#e2e8f0 !important;}

  ${sidebarCSS()}
  ${modalCSS()}
</style>
</head>
<body>
<div class="app-shell">
${buildSidebar('allBacktest', liveActive)}
<div class="main-content">
<div class="page">

  <div class="crumb">
    <span class="pill pill-all">ALL BACKTESTS</span>
    <span style="color:#1e2a40;font-size:10px;">\u203a</span>
    <span class="pill pill-range" id="crumbRange">${from} \u2192 ${to}</span>
    <span style="margin-left:auto;font-size:0.6rem;color:#1e2a40;font-family:'IBM Plex Mono',monospace;">Change settings \u00b7 run all 3 strategies \u00b7 compare side-by-side</span>
  </div>

  <!-- Settings form -->
  <div class="run-bar">
    <div><label>From</label><input type="date" id="f" value="${from}"/></div>
    <div><label>To</label><input type="date" id="t" value="${to}"/></div>
    <div><label>Swing Candle</label>
      <select id="swingRes">
        <option value="5"  ${swingRes==="5" ?"selected":""}>5-min</option>
        <option value="15" ${swingRes==="15"?"selected":""}>15-min</option>
        <option value="30" ${swingRes==="30"?"selected":""}>30-min</option>
        <option value="60" ${swingRes==="60"?"selected":""}>60-min</option>
      </select>
    </div>
    <div><label>Scalp Candle</label>
      <select id="scalpRes">
        <option value="3" ${scalpRes==="3"?"selected":""}>3-min</option>
        <option value="5" ${scalpRes==="5"?"selected":""}>5-min</option>
      </select>
    </div>
    <div><label>PA Candle</label>
      <select id="paRes">
        <option value="3" ${paRes==="3"?"selected":""}>3-min</option>
        <option value="5" ${paRes==="5"?"selected":""}>5-min</option>
      </select>
    </div>
    <button class="run-btn" id="runAllBtn">\u25b6\u25b6 Run All</button>
    <button class="run-btn" id="cancelBtn" style="background:#3a1a1a;color:#f87171;border-color:#7f1d1d;display:none;">\u2715 Cancel</button>
    <span id="runAllStatus" style="font-size:0.68rem;color:#4a6080;margin-left:auto;"></span>
  </div>

  <!-- Quick date presets -->
  <div style="display:flex;gap:6px;margin:-8px 0 6px;flex-wrap:wrap;align-items:center;">
    <button class="preset-btn" onclick="setPreset('thisWeek')">This week</button>
    <button class="preset-btn" onclick="setPreset('lastWeek')">Last week</button>
    <button class="preset-btn" onclick="setPreset('thisMonth')">This month</button>
    <button class="preset-btn" onclick="setPreset('lastMonth')">Last month</button>
    <button class="preset-btn" onclick="setPreset('last3')">Last 3 months</button>
    <button class="preset-btn" onclick="setPreset('last6')">Last 6 months</button>
    <button class="preset-btn" onclick="setPreset('thisYear')">This year</button>
    <button class="preset-btn" onclick="setPreset('lastYear')">Last year</button>
  </div>
  <div style="display:flex;gap:6px;margin:0 0 6px;flex-wrap:wrap;align-items:center;">
    <button class="preset-btn" onclick="setPreset('last2y')">Last 2 yr</button>
    <button class="preset-btn" onclick="setPreset('last3y')">Last 3 yr</button>
    <button class="preset-btn" onclick="setPreset('last4y')">Last 4 yr</button>
    <button class="preset-btn" onclick="setPreset('last5y')">Last 5 yr</button>
    <button class="preset-btn" onclick="setPreset('last6y')">Last 6 yr</button>
    <button class="preset-btn" onclick="setPreset('last7y')">Last 7 yr</button>
    <button class="preset-btn" onclick="setPreset('last8y')">Last 8 yr</button>
  </div>
  <div style="display:flex;gap:6px;margin:0 0 6px;flex-wrap:wrap;align-items:center;">
    ${(() => { const cy=new Date().getFullYear(); return Array.from({length:8},(_,i)=>cy-i).map(yr=>`<button class="preset-btn" onclick="setPreset('y${yr}')">${yr}</button>`).join('\n    '); })()}
  </div>
  <div style="display:flex;gap:6px;margin:0 0 14px;flex-wrap:wrap;align-items:center;">
    <span style="font-size:0.6rem;color:#94a3b8;font-family:'IBM Plex Mono',monospace;">${new Date().getFullYear()}</span>
    ${(() => { const mths=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']; const labels=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; const curMonth=new Date().getMonth(); return mths.map((k,i) => i<=curMonth ? `<button class="preset-btn" onclick="setPreset('${k}')">${labels[i]}</button>` : `<button class="preset-btn" disabled style="opacity:0.3;cursor:not-allowed">${labels[i]}</button>`).join('\n    '); })()}
  </div>

  ${swingPanel}
  ${scalpPanel}
  ${paPanel}

</div>
</div>
</div>

<script>
function setPreset(p){
  var d=new Date(),y=d.getFullYear(),m=d.getMonth(),day=d.getDay();
  function fmt(dt){var yy=dt.getFullYear(),mm=String(dt.getMonth()+1).padStart(2,'0'),dd=String(dt.getDate()).padStart(2,'0');return yy+'-'+mm+'-'+dd;}
  var today=fmt(d);
  var monday=new Date(d); monday.setDate(d.getDate()-(day===0?6:day-1));
  var lastWeekMon=new Date(monday); lastWeekMon.setDate(lastWeekMon.getDate()-7);
  var lastWeekFri=new Date(lastWeekMon); lastWeekFri.setDate(lastWeekFri.getDate()+4);
  var fromVal, toVal;
  var monthMap={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  if(monthMap.hasOwnProperty(p)){
    var mi=monthMap[p];
    fromVal=fmt(new Date(y,mi,1));
    toVal=(mi<m)?fmt(new Date(y,mi+1,0)):(mi===m?today:fmt(new Date(y,mi+1,0)));
  } else if(/^y\d{4}$/.test(p)){
    var yr=parseInt(p.slice(1));
    fromVal=yr+'-01-01';
    toVal=(yr===y)?today:(yr+'-12-31');
  } else {
    var presets={
      thisWeek: [fmt(monday), today],
      lastWeek: [fmt(lastWeekMon), fmt(lastWeekFri)],
      thisMonth: [fmt(new Date(y,m,1)), today],
      lastMonth: [fmt(new Date(y,m-1,1)), fmt(new Date(y,m,0))],
      last3: [fmt(new Date(y,m-2,1)), today],
      last6: [fmt(new Date(y,m-5,1)), today],
      thisYear: [fmt(new Date(y,0,1)), today],
      lastYear: [fmt(new Date(y-1,0,1)), fmt(new Date(y-1,11,31))],
      last2y: [fmt(new Date(y-2,0,1)), today],
      last3y: [fmt(new Date(y-3,0,1)), today],
      last4y: [fmt(new Date(y-4,0,1)), today],
      last5y: [fmt(new Date(y-5,0,1)), today],
      last6y: [fmt(new Date(y-6,0,1)), today],
      last7y: [fmt(new Date(y-7,0,1)), today],
      last8y: [fmt(new Date(y-8,0,1)), today]
    };
    if(!presets[p]) return;
    fromVal=presets[p][0]; toVal=presets[p][1];
  }
  document.getElementById('f').value=fromVal;
  document.getElementById('t').value=toVal;
  document.getElementById('crumbRange').textContent = fromVal + ' \u2192 ' + toVal;
}

// ── Formatting (mirrors server-side) ─────────────────────────────────────────
function pts(n){ return typeof n==='number' ? ((n>=0?'+':'')+n.toFixed(2)+' pts') : '\u2014'; }
function pnlColor(n){ return (typeof n==='number' && n>=0) ? '#10b981' : '#ef4444'; }
function fmtPnl(n,s){
  if(typeof n!=='number') return '\u2014';
  if(s && s.optionSim) return (n>=0?'+':'')+'\u20b9'+Math.abs(n).toLocaleString('en-IN',{maximumFractionDigits:0});
  return pts(n);
}
function esc(x){ return String(x==null?'':x).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

function renderStats(s){
  if(!s) return '<div class="empty-state">No saved backtest yet.</div>';
  var pf  = s.profitFactor;
  var rec = s.recoveryFactor;
  var shp = s.sharpeRatio;
  var wrDisp = (typeof s.winRate === 'number') ? (s.winRate + '%') : (s.winRate || '\u2014');
  var hasExtended = (typeof pf === 'number') || (typeof shp === 'number');
  var grid1 = '<div class="stat-grid">'
    +   '<div class="sc blue"><div class="sc-label">Total Trades</div><div class="sc-val">'+s.totalTrades+'</div><div class="sc-sub">'+s.wins+'W \u00b7 '+s.losses+'L</div></div>'
    +   '<div class="sc green"><div class="sc-label">Max Profit</div><div class="sc-val" style="color:#10b981;">'+fmtPnl(s.maxProfit,s)+'</div><div class="sc-sub">Best single trade</div></div>'
    +   '<div class="sc '+((s.totalPnl||0)>=0?'green':'red')+'"><div class="sc-label">Total PnL</div><div class="sc-val" style="color:'+pnlColor(s.totalPnl)+';">'+fmtPnl(s.totalPnl,s)+'</div><div class="sc-sub">'+(s.optionSim?('Option sim: \u03b4='+s.delta+' \u03b8=\u20b9'+s.thetaPerDay+'/day'):'Raw NIFTY index pts')+'</div></div>'
    +   '<div class="sc red"><div class="sc-label">Max Drawdown</div><div class="sc-val" style="color:#ef4444;">'+fmtPnl(s.maxDrawdown,s)+'</div><div class="sc-sub">Worst peak-to-trough</div></div>'
    +   '<div class="sc red"><div class="sc-label">Total Drawdown</div><div class="sc-val" style="color:#ef4444;">'+fmtPnl(s.totalDrawdown,s)+'</div><div class="sc-sub">Sum of all losses</div></div>'
    +   '<div class="sc purple"><div class="sc-label">Risk/Reward</div><div class="sc-val">'+(s.riskReward||'\u2014')+'</div><div class="sc-sub">1 : avg win \u00f7 avg loss</div></div>'
    +   '<div class="sc yellow"><div class="sc-label">Win Rate</div><div class="sc-val">'+wrDisp+'</div><div class="sc-sub">'+s.wins+' wins of '+s.totalTrades+'</div></div>'
    + '</div>';
  if(!hasExtended) return grid1;
  var grid2 = '<div class="stat-grid-2">'
    +   '<div class="sc orange"><div class="sc-label">Profit Factor</div><div class="sc-val" style="color:'+(pf>=1.5?'#10b981':pf>=1?'#f59e0b':'#ef4444')+';">'+(pf==null?'\u2014':(pf===Infinity?'\u221e':pf))+'</div><div class="sc-sub">Gross P \u20b9'+Math.round(s.grossProfit||0).toLocaleString('en-IN')+' / L \u20b9'+Math.round(s.grossLoss||0).toLocaleString('en-IN')+'</div></div>'
    +   '<div class="sc cyan"><div class="sc-label">Expectancy</div><div class="sc-val" style="color:'+pnlColor(s.expectancy)+';">'+fmtPnl(s.expectancy,s)+'</div><div class="sc-sub">Avg P&amp;L per trade</div></div>'
    +   '<div class="sc red"><div class="sc-label">Max Loss</div><div class="sc-val" style="color:#ef4444;">'+fmtPnl(s.maxLoss,s)+'</div><div class="sc-sub">Worst single trade</div></div>'
    +   '<div class="sc green"><div class="sc-label">Avg Win</div><div class="sc-val" style="color:#10b981;">'+fmtPnl(s.avgWin,s)+'</div><div class="sc-sub">'+s.wins+' winning trades</div></div>'
    +   '<div class="sc red"><div class="sc-label">Avg Loss</div><div class="sc-val" style="color:#ef4444;">'+fmtPnl(s.avgLoss,s)+'</div><div class="sc-sub">'+s.losses+' losing trades</div></div>'
    +   '<div class="sc blue"><div class="sc-label">Recovery Factor</div><div class="sc-val" style="color:'+(rec>=2?'#10b981':rec>=1?'#f59e0b':'#ef4444')+';">'+(rec==null?'\u2014':rec)+'</div><div class="sc-sub">PnL \u00f7 Max DD</div></div>'
    +   '<div class="sc purple"><div class="sc-label">Sharpe Ratio</div><div class="sc-val" style="color:'+(shp>=1?'#10b981':shp>=0.5?'#f59e0b':'#ef4444')+';">'+(shp==null?'\u2014':shp)+'</div><div class="sc-sub">Annualized (daily)</div></div>'
    + '</div>';
  return grid1 + grid2;
}

function timeAgo(iso){
  if(!iso) return 'never';
  var d=new Date(iso); if(isNaN(d.getTime())) return 'never';
  var s=Math.floor((Date.now()-d.getTime())/1000);
  if(s<60) return s+'s ago';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

function setStatus(panel, cls, text){
  var el = panel.querySelector('[data-status]');
  el.className = 'run-status ' + cls;
  el.textContent = text || '';
  panel.classList.toggle('running', cls==='running' || cls==='queued');
}

// ── Run a single strategy (returns a Promise that resolves when done) ────────
function runStrategy(panel, opts){
  var basePath = panel.dataset.base;
  var key      = panel.dataset.key;
  var url = basePath + '?from=' + encodeURIComponent(opts.from)
          + '&to='   + encodeURIComponent(opts.to)
          + '&resolution=' + encodeURIComponent(opts.resolution);

  setStatus(panel, 'running', 'running\u2026');

  return new Promise(function(resolve){
    // Fire the trigger. Check response status — the server returns 401 when
    // ACCESS_TOKEN is missing (not logged in with Fyers). Surface it instead
    // of silently polling /idle, which would otherwise load stale results.
    fetch(url, { cache: 'no-store' })
      .then(function(r){
        if(!r.ok){
          var isAuth = (r.status === 401);
          setStatus(panel, 'error', isAuth ? 'not authenticated' : ('HTTP ' + r.status));
          showAlert({
            icon: isAuth ? '🔒' : '⚠️',
            title: isAuth ? 'Not authenticated' : ('Backtest failed (HTTP ' + r.status + ')'),
            message: isAuth
              ? 'You need to login with Fyers first before running a backtest.'
              : 'The server rejected the backtest request. Check the server logs for details.',
            btnClass: 'modal-btn-danger',
            btnText: 'OK'
          });
          resolve({ ok: false, authError: isAuth });
        }
      })
      .catch(function(){
        setStatus(panel, 'error', 'network');
        resolve({ ok: false, networkError: true });
      });

    // Give the server a moment to register the job, then poll /idle
    setTimeout(function tick(){
      // If the trigger fetch resolved with an error, bail out of the polling loop.
      var st = panel.querySelector('[data-status]');
      if(st && st.classList.contains('error')){
        return;
      }
      if(opts.cancelled && opts.cancelled()){
        setStatus(panel, 'idle', '');
        resolve({ cancelled: true });
        return;
      }
      fetch(basePath + '/idle', { cache: 'no-store' })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if(d && d.idle){
            // Done. Fetch fresh stats and render.
            fetch('/all-backtest/stats?key=' + encodeURIComponent(key), { cache: 'no-store' })
              .then(function(r){ return r.json(); })
              .then(function(js){
                if(js && js.exists){
                  panel.querySelector('[data-body]').innerHTML = renderStats(js.summary);
                  if(js.params){
                    panel.querySelector('[data-meta-range]').textContent =
                      js.params.from + ' \u2192 ' + js.params.to + ' \u00b7 ' + js.params.resolution + '-min';
                  }
                  panel.querySelector('[data-meta-ago]').textContent = timeAgo(js.savedAt);
                  setStatus(panel, 'done', 'done');
                } else {
                  setStatus(panel, 'error', 'no result');
                }
                resolve({ ok: true });
              })
              .catch(function(){
                setStatus(panel, 'error', 'load failed');
                resolve({ ok: false });
              });
            return;
          }
          setTimeout(tick, 1500);
        })
        .catch(function(){ setTimeout(tick, 3000); });
    }, 1200);
  });
}

// ── Run All (sequential) ─────────────────────────────────────────────────────
var RUN_STATE = { active: false, cancel: false };

document.getElementById('runAllBtn').addEventListener('click', function(){
  if(RUN_STATE.active) return;
  var from = document.getElementById('f').value;
  var to   = document.getElementById('t').value;
  if(!from || !to){ alert('Pick From and To dates'); return; }
  var swingRes = document.getElementById('swingRes').value;
  var scalpRes = document.getElementById('scalpRes').value;
  var paRes    = document.getElementById('paRes').value;

  RUN_STATE.active = true; RUN_STATE.cancel = false;
  document.getElementById('runAllBtn').disabled = true;
  document.getElementById('cancelBtn').style.display = '';
  document.getElementById('runAllStatus').textContent = 'Running sequentially (server allows 1 at a time)\u2026';
  document.getElementById('crumbRange').textContent = from + ' \u2192 ' + to;

  var panels = document.querySelectorAll('.panel');
  // Mark all as queued
  panels.forEach(function(p){ setStatus(p, 'queued', 'queued'); });

  var jobs = [
    { panel: document.querySelector('.panel[data-key="${SWING_KEY}"]'), resolution: swingRes },
    { panel: document.querySelector('.panel[data-key="${SCALP_KEY}"]'), resolution: scalpRes },
    { panel: document.querySelector('.panel[data-key="${PA_KEY}"]'),    resolution: paRes    }
  ].filter(function(j){ return j.panel; });

  (function next(i, authAborted){
    if(i >= jobs.length || RUN_STATE.cancel || authAborted){
      RUN_STATE.active = false;
      document.getElementById('runAllBtn').disabled = false;
      document.getElementById('cancelBtn').style.display = 'none';
      document.getElementById('runAllStatus').textContent =
        authAborted      ? 'Stopped — not authenticated. Login with Fyers and try again.' :
        RUN_STATE.cancel ? 'Cancelled (backtests may still finish in background).'
                         : 'All done.';
      // Mark any still-queued panels as idle
      panels.forEach(function(p){
        var st = p.querySelector('[data-status]');
        if(st && st.classList.contains('queued')) setStatus(p, 'idle', '');
      });
      return;
    }
    var j = jobs[i];
    runStrategy(j.panel, { from: from, to: to, resolution: j.resolution, cancelled: function(){ return RUN_STATE.cancel; } })
      .then(function(result){ next(i + 1, result && result.authError); });
  })(0);
});

document.getElementById('cancelBtn').addEventListener('click', function(){
  RUN_STATE.cancel = true;
  document.getElementById('runAllStatus').textContent = 'Cancelling\u2026 (current run finishes in background)';
});

// ── Individual panel Run buttons ─────────────────────────────────────────────
document.querySelectorAll('[data-run]').forEach(function(btn){
  btn.addEventListener('click', function(){
    if(RUN_STATE.active) return;
    var panel = btn.closest('.panel');
    var from = document.getElementById('f').value;
    var to   = document.getElementById('t').value;
    if(!from || !to){ alert('Pick From and To dates'); return; }
    var res;
    var key = panel.dataset.key;
    if(key === '${SWING_KEY}')      res = document.getElementById('swingRes').value;
    else if(key === '${SCALP_KEY}') res = document.getElementById('scalpRes').value;
    else                            res = document.getElementById('paRes').value;

    RUN_STATE.active = true;
    document.getElementById('runAllBtn').disabled = true;
    runStrategy(panel, { from: from, to: to, resolution: res, cancelled: function(){ return false; } })
      .then(function(){
        RUN_STATE.active = false;
        document.getElementById('runAllBtn').disabled = false;
      });
  });
});

${modalJS()}
</script>
</body>
</html>`);
});

module.exports = router;

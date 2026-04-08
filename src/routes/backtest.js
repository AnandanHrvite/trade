const express = require("express");
const router  = express.Router();
const { fetchCandles, fetchCandlesCachedBT, runBacktest } = require("../services/backtestEngine");
const { getActiveStrategy, ACTIVE } = require("../strategies");
const { saveResult } = require("../utils/resultStore");
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");
const vixFilter = require("../services/vixFilter");
const { VIX_SYMBOL } = vixFilter;
const { isExpiryDate } = require("../utils/nseHolidays");

const inr      = (n) => typeof n === "number" ? "\u20b9" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "\u2014";
const pts      = (n) => typeof n === "number" ? (n >= 0 ? "+" : "") + n.toFixed(2) + " pts" : "\u2014";
const pnlColor = (n) => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";
// Smart formatter: shows ₹ when option sim is on, pts when off
const fmtPnl   = (n, s) => {
  if (typeof n !== "number") return "\u2014";
  if (s && s.optionSim) return (n >= 0 ? "+" : "") + "\u20b9" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return pts(n);
};

// buildNav kept for backward-compat — now delegates to shared sidebar
function buildNav(active, liveActive) {
  const LIVE_BADGE = liveActive
    // Delegated to sharedNav — this stub preserved for backward compat
    return buildSidebar(active, liveActive);
}


router.get("/", async (req, res) => {
  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";
  const now = new Date();
  const defFrom = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-01';
  const defTo   = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
  const from       = req.query.from       || defFrom;
  const to         = req.query.to         || defTo;
  const resolution = req.query.resolution || process.env.TRADE_RESOLUTION || "15";
  const capital    = parseInt(process.env.BACKTEST_CAPITAL || "100000", 10);
  const symbol     = req.query.symbol     || "NSE:NIFTY50-INDEX";
  const skipCache  = req.query.skipCache === "true";

  // Block backtest while live trade is running — would compete for Fyers API calls
  // and pollute the log viewer with backtest noise during a live session.
  if (liveActive) {
    res.setHeader("Content-Type", "text/html");
    return res.status(503).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Backtest blocked — Live trade active</title>
      <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;min-height:100vh;display:flex;flex-direction:column;}</style>
      </head><body>
<div class="app-shell">
${buildSidebar('backtest', true)}
<div class="main-content">
      <div style="display:flex;align-items:center;justify-content:center;flex:1;padding:40px;">
        <div style="background:#0d1320;border:1px solid #7f1d1d;border-radius:14px;padding:40px 48px;max-width:480px;text-align:center;">
          <div style="font-size:2.5rem;margin-bottom:16px;">🔒</div>
          <h2 style="color:#ef4444;margin-bottom:12px;font-size:1.1rem;">Backtest blocked</h2>
          <p style="font-size:0.85rem;color:#8899aa;margin-bottom:24px;line-height:1.6;">
            Live trading is currently active. Backtest is disabled to prevent Fyers API contention and log pollution during a live session.<br><br>
            Stop the live trade first, then run your backtest.
          </p>
          <a href="/trade/status" style="background:#ef4444;color:#fff;padding:9px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.85rem;">→ Go to Live Trade</a>
        </div>
      </div>
      </div></div></body></html>`);
  }

  if (!process.env.ACCESS_TOKEN) {
    res.setHeader("Content-Type", "text/html");
    return res.status(401).send(errorPage("Not Authenticated",
      "You need to login with Fyers first before running a backtest.", from, to, resolution));
  }

  console.log(`\n Backtest: ${ACTIVE} | ${from} to ${to} | ${resolution}m`);

  try {
    const strategy = getActiveStrategy();
    // Fetch NIFTY candles and VIX daily candles in parallel (with disk cache)
    const [candles, vixCandles] = await Promise.all([
      fetchCandlesCachedBT(symbol, resolution, from, to, skipCache),
      vixFilter.VIX_ENABLED
        ? fetchCandlesCachedBT(VIX_SYMBOL, "D", from, to, skipCache).catch(err => {
            console.warn(`[Backtest] VIX candle fetch failed: ${err.message} — VIX filter will be bypassed`);
            return [];
          })
        : Promise.resolve([]),
    ]);

    if (candles.length < 30) {
      res.setHeader("Content-Type", "text/html");
      return res.status(400).send(errorPage("Not Enough Data",
        "Too few candles for the selected date range. Try a wider range (at least 1 month).",
        from, to, resolution));
    }

    if (vixFilter.VIX_ENABLED) {
      console.log(`   VIX candles loaded: ${vixCandles.length} days`);
    }

    // Pre-compute expiry dates if expiry-only mode is enabled
    let expiryDates = null;
    if ((process.env.TRADE_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
      const uniqueDates = [...new Set(candles.map(c => new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })))];
      const expirySet = new Set();
      for (const d of uniqueDates) {
        if (await isExpiryDate(d)) expirySet.add(d);
      }
      expiryDates = expirySet;
      console.log(`   📅 Expiry-only mode: ${expirySet.size} expiry days out of ${uniqueDates.length} trading days`);
    }

    const result = runBacktest(candles, strategy, capital, vixCandles, expiryDates);
    saveResult(ACTIVE, { ...result, params: { from, to, resolution, symbol, capital } });

    const s = result.summary;
    // Newest first by default (reverse chronological)
    const trades = [...(result.trades || [])].reverse();

    // Build trades array - embedded safely via JSON script tag
    const tradesData = trades.map(t => ({
      side:      t.side || "",
      entry:     t.entryTime  || "",
      exit:      t.exitTime   || "",
      entryTs:   typeof t.entryTs === "number" ? t.entryTs : 0,
      exitTs:    typeof t.exitTs  === "number" ? t.exitTs  : 0,
      ePrice:    typeof t.entryPrice === "number" ? t.entryPrice : 0,
      xPrice:    typeof t.exitPrice  === "number" ? t.exitPrice  : 0,
      sl:        (t.stopLoss && t.stopLoss !== "N/A") ? parseFloat(t.stopLoss) : null,
      initialSL: (t.initialStopLoss && t.initialStopLoss !== "N/A") ? parseFloat(t.initialStopLoss) : ((t.stopLoss && t.stopLoss !== "N/A") ? parseFloat(t.stopLoss) : null),
      pnl:       typeof t.pnl === "number" ? t.pnl : null,
      spotPts:   typeof t.spotPnlPts === "number" ? t.spotPnlPts : null,
      pnlMode:   t.pnlMode || null,
      held:      typeof t.candlesHeld === "number" ? t.candlesHeld : null,
      reason:    String(t.exitReason || ""),
      risk_pts:  (() => {
        const sl = (t.initialStopLoss && t.initialStopLoss !== "N/A") ? parseFloat(t.initialStopLoss)
                 : (t.stopLoss && t.stopLoss !== "N/A") ? parseFloat(t.stopLoss) : null;
        if (!sl) return null;
        return parseFloat(Math.abs(t.entryPrice - sl).toFixed(2));
      })(),
      rr:        (() => {
        if (typeof t.pnl !== "number") return null;
        const sl = (t.initialStopLoss && t.initialStopLoss !== "N/A") ? parseFloat(t.initialStopLoss)
                 : (t.stopLoss && t.stopLoss !== "N/A") ? parseFloat(t.stopLoss) : null;
        if (!sl) return null;
        const risk   = Math.abs(t.entryPrice - sl);
        const reward = Math.abs(t.pnl);
        if (risk === 0) return null;
        const ratio = reward / risk;
        return (t.pnl >= 0 ? "1:" : "-1:") + ratio.toFixed(2);
      })(),
    }));
    // Escape </script> in JSON to prevent early tag termination
    const tradesJSON = JSON.stringify(tradesData).replace(/<\/script>/gi, "<\\/script>");

    res.setHeader("Content-Type", "text/html");
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <link rel="icon" type="image/png" href="data:image/png;base64,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"/>
  <title>Backtest — ௐ Palani Andawar Thunai ॐ</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;min-height:100vh;}
    @keyframes ltpulse{0%,100%{opacity:1}50%{opacity:.25}}
    .page{padding:16px 20px 40px;}

    .stat-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;margin-bottom:16px;}
    @media(max-width:900px){.stat-grid{grid-template-columns:repeat(3,1fr);}}
    @media(max-width:640px){
      .stat-grid{grid-template-columns:1fr 1fr;}
      .sc-val{font-size:0.95rem;}
      .form-section{flex-direction:column;}
      #tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
      .sc{padding:10px 12px;}
      .top-bar{padding:7px 10px 7px 48px;}
      .top-bar-meta{display:none;}
    }
    .sc{background:#08091a;border:0.5px solid #0e1428;border-radius:7px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
    .sc.blue::before{background:#3b82f6;}.sc.green::before{background:#10b981;}.sc.red::before{background:#ef4444;}.sc.yellow::before{background:#f59e0b;}.sc.purple::before{background:#8b5cf6;}
    .sc-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.2px;color:#1e3050;margin-bottom:5px;font-family:"IBM Plex Mono",monospace;}
    .sc-val{font-size:1.05rem;font-weight:700;color:#a0b8d8;font-family:"IBM Plex Mono",monospace;line-height:1.2;}
    .sc-sub{font-size:0.6rem;color:#4a6080;margin-top:3px;}

    .run-bar{display:flex;align-items:flex-end;gap:10px;background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:11px 14px;margin-bottom:14px;flex-wrap:wrap;}
    .run-bar label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;display:block;margin-bottom:3px;}
    .run-bar input,.run-bar select{background:#fff;border:1px solid #1e3a8a;color:#0f172a;padding:5px 8px;border-radius:5px;font-size:0.75rem;font-family:'IBM Plex Mono',monospace;cursor:pointer;color-scheme:light;}
    .preset-btn{font-size:0.65rem;padding:3px 10px;border-radius:4px;background:rgba(59,130,246,0.08);color:#60a5fa;border:0.5px solid rgba(59,130,246,0.2);cursor:pointer;font-family:"IBM Plex Mono",monospace;transition:all 0.15s;}.preset-btn:hover{background:rgba(59,130,246,0.18);}
.run-btn{background:#1a3a8a;color:#90c0ff;border:1px solid #2a5ac0;padding:6px 14px;border-radius:5px;font-size:0.7rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;white-space:nowrap;}
    .run-btn:hover{background:#2563eb;}

    .tbar{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;}
    .tbar input,.tbar select{background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:5px 9px;border-radius:6px;font-size:0.76rem;font-family:inherit;}
    .tbar input:focus,.tbar select:focus{outline:none;border-color:#3b82f6;}
    .tbar-label{color:#4a6080;font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:1px;}
    .tbar-count{color:#4a6080;font-size:0.7rem;}

    .tw{border:0.5px solid #0e1428;border-radius:8px;overflow:hidden;margin-bottom:10px;}
    table{width:100%;border-collapse:collapse;}
    thead th{background:#04060e;padding:7px 10px;text-align:left;font-size:0.58rem;text-transform:uppercase;letter-spacing:0.8px;color:#1e3050;cursor:pointer;user-select:none;white-space:nowrap;font-family:"IBM Plex Mono",monospace;}
    thead th:hover{color:#c8d8f0;}
    thead th.sorted{color:#3b82f6;}
    tbody tr{border-top:0.5px solid #080e1a;}
    tbody tr:hover{background:#060c1a;}
    tbody td{padding:6px 10px;font-size:0.72rem;font-family:'IBM Plex Mono',monospace;color:#4a6080;}

    .pag{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
    .pag button{background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 9px;border-radius:5px;font-size:0.72rem;cursor:pointer;font-family:inherit;}
    .pag button:hover{border-color:#3b82f6;color:#3b82f6;}
    .pag button.active{background:#0a1e3d;border-color:#3b82f6;color:#3b82f6;font-weight:700;}
    .pag button:disabled{opacity:.3;cursor:default;}
    .pag-info{font-size:0.7rem;color:#4a6080;padding:0 4px;}

    #tooltip{position:fixed;z-index:9999;background:#1e293b;color:#e2e8f0;border:1px solid #3b82f6;border-radius:7px;padding:8px 12px;font-size:0.72rem;max-width:340px;word-break:break-word;box-shadow:0 8px 24px rgba(0,0,0,.7);pointer-events:none;display:none;line-height:1.5;font-family:sans-serif;}

    .copy-btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:4px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;transition:all 0.15s;white-space:nowrap;}
    .copy-btn:hover{background:#0a1e3d;border-color:#3b82f6;}
    .copy-btn.copied{background:#064e3b;border-color:#10b981;color:#10b981;}

    /* ── Analytics Panel ── */
    .dw-toggle{background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;transition:all 0.15s;}.dw-toggle:hover{border-color:#3b82f6;background:#0a1e3d;}.dw-toggle.active{background:#0a1e3d;border-color:#3b82f6;}
    .ana-panel{margin-bottom:16px;}
    .ana-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
    @media(max-width:900px){.ana-row{grid-template-columns:1fr;}}
    .ana-card{background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:14px 16px;position:relative;}
    .ana-card h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
    .ana-chart-wrap{position:relative;height:220px;}
    .ana-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;}
    @media(max-width:900px){.ana-row3{grid-template-columns:1fr;}}
    .ana-mini{background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:12px 14px;}
    .ana-mini h3{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:8px;font-family:'IBM Plex Mono',monospace;}
    .ana-tbl{width:100%;border-collapse:collapse;}
    .ana-tbl th{text-align:left;font-size:0.55rem;text-transform:uppercase;letter-spacing:0.8px;color:#1e3050;padding:5px 8px;border-bottom:0.5px solid #0e1428;font-family:'IBM Plex Mono',monospace;}
    .ana-tbl td{padding:5px 8px;font-size:0.72rem;font-family:'IBM Plex Mono',monospace;color:#4a6080;border-bottom:0.5px solid #060a14;}
    .ana-tbl tr:hover{background:#060c1a;}
    .ana-stat{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;}
    .ana-stat-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
    .ana-stat-label{font-size:0.62rem;color:#3a5070;}
    ${sidebarCSS()}
    ${modalCSS()}
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('backtest', liveActive)}
<div class="main-content">

<div class="page">
  <!-- Context breadcrumb bar -->
  <div style="background:#06090e;border-bottom:0.5px solid #0e1428;padding:6px 20px;display:flex;align-items:center;gap:7px;margin:-16px -20px 14px;position:sticky;top:44px;z-index:90;">
    <span style="font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;background:rgba(59,130,246,0.12);color:#60a5fa;border:0.5px solid rgba(59,130,246,0.25);text-transform:uppercase;letter-spacing:0.5px;font-family:'IBM Plex Mono',monospace;">BACKTEST</span>
    <span style="color:#1e2a40;font-size:10px;">›</span>
    <span style="font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;background:rgba(16,185,129,0.1);color:#34d399;border:0.5px solid rgba(16,185,129,0.2);text-transform:uppercase;font-family:'IBM Plex Mono',monospace;">${ACTIVE}</span>
    <span style="color:#1e2a40;font-size:10px;">›</span>
    <span style="font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;background:rgba(245,158,11,0.1);color:#fbbf24;border:0.5px solid rgba(245,158,11,0.2);font-family:'IBM Plex Mono',monospace;">${from} → ${to}</span>
    <span style="margin-left:auto;font-size:0.6rem;color:#1e2a40;font-family:'IBM Plex Mono',monospace;">${resolution}-min · ${candles.length.toLocaleString()} candles · ₹${capital.toLocaleString("en-IN")}</span>
  </div>

  <!-- Run Again -->
  <div class="run-bar">
    <div><label>From</label><input type="date" id="f" value="${from}"/></div>
    <div><label>To</label><input type="date" id="t" value="${to}"/></div>
    <div><label>Candle</label>
      <select id="r">
        <option value="15" selected>15-min</option>
      </select>
    </div>
    <button class="run-btn" onclick="(function(){var f=document.getElementById('f').value,t=document.getElementById('t').value,r=document.getElementById('r').value;if(!f||!t){showAlert({icon:'⚠️',title:'Missing Dates',message:'Set both From and To dates'});return;}window.location='/backtest?from='+f+'&to='+t+'&resolution='+r;})()">🔄 Run Again</button>
    <span style="font-size:0.7rem;color:#4a6080;margin-left:auto;">Strategy: <strong style="color:#3b82f6;">${ACTIVE}</strong></span>
  </div>
  <!-- Quick date presets -->
  <div style="display:flex;gap:6px;margin:-8px 0 6px;flex-wrap:wrap;align-items:center;">
    <button class="preset-btn" onclick="setPreset('thisMonth')">This month</button>
    <button class="preset-btn" onclick="setPreset('lastMonth')">Last month</button>
    <button class="preset-btn" onclick="setPreset('last3')">Last 3 months</button>
    <button class="preset-btn" onclick="setPreset('last6')">Last 6 months</button>
    <button class="preset-btn" onclick="setPreset('thisYear')">This year</button>
    <button class="preset-btn" onclick="setPreset('lastYear')">Last year</button>
    <button class="preset-btn" onclick="setPreset('last3y')">Last 3 yr</button>
    <button class="preset-btn" onclick="setPreset('last4y')">Last 4 yr</button>
    <button class="preset-btn" onclick="setPreset('last5y')">Last 5 yr</button>
    <button class="preset-btn" onclick="setPreset('last6y')">Last 6 yr</button>
  </div>
  <div style="display:flex;gap:6px;margin:0 0 12px;flex-wrap:wrap;align-items:center;">
    <span style="font-size:0.6rem;color:#94a3b8;font-family:'IBM Plex Mono',monospace;">${new Date().getFullYear()}</span>
    ${(() => { const mths=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']; const labels=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; const curMonth=new Date().getMonth(); return mths.map((k,i) => i<=curMonth ? `<button class="preset-btn" onclick="setPreset('${k}')">${labels[i]}</button>` : `<button class="preset-btn" disabled style="opacity:0.3;cursor:not-allowed">${labels[i]}</button>`).join('\n    '); })()}
  </div>
  <script>
  function setPreset(p){
    var d=new Date(),y=d.getFullYear(),m=d.getMonth();
    function fmt(dt){var yy=dt.getFullYear(),mm=String(dt.getMonth()+1).padStart(2,'0'),dd=String(dt.getDate()).padStart(2,'0');return yy+'-'+mm+'-'+dd;}
    var today=fmt(d);
    var monthMap={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    if(monthMap.hasOwnProperty(p)){var mi=monthMap[p];var endD=mi<=m?fmt(new Date(y,mi+1,0)):fmt(new Date(y,mi+1,0));document.getElementById('f').value=fmt(new Date(y,mi,1));document.getElementById('t').value=mi<m?endD:(mi===m?today:endD);return;}
    var presets={
      thisMonth: [fmt(new Date(y,m,1)), today],
      lastMonth: [fmt(new Date(y,m-1,1)), fmt(new Date(y,m,0))],
      last3: [fmt(new Date(y,m-2,1)), today],
      last6: [fmt(new Date(y,m-5,1)), today],
      thisYear: [fmt(new Date(y,0,1)), today],
      lastYear: [fmt(new Date(y-1,0,1)), fmt(new Date(y-1,11,31))],
      last3y: [fmt(new Date(y-3,0,1)), today],
      last4y: [fmt(new Date(y-4,0,1)), today],
      last5y: [fmt(new Date(y-5,0,1)), today],
      last6y: [fmt(new Date(y-6,0,1)), today]
    };
    document.getElementById('f').value=presets[p][0];
    document.getElementById('t').value=presets[p][1];
  }
  </script>

  <!-- Summary -->
  <div class="stat-grid">
    <div class="sc blue"><div class="sc-label">Total Trades</div><div class="sc-val">${s.totalTrades}</div><div class="sc-sub">${s.wins}W \u00b7 ${s.losses}L</div></div>
    <div class="sc green"><div class="sc-label">Max Profit</div><div class="sc-val" style="color:#10b981;">${fmtPnl(s.maxProfit, s)}</div><div class="sc-sub">Best single trade</div></div>
    <div class="sc ${(s.totalPnl||0)>=0?"green":"red"}"><div class="sc-label">Total PnL</div><div class="sc-val" style="color:${pnlColor(s.totalPnl)};">${fmtPnl(s.totalPnl, s)}</div><div class="sc-sub">${s.optionSim ? `Option sim: δ=${s.delta} θ=₹${s.thetaPerDay}/day` : "Raw NIFTY index pts — enable BACKTEST_OPTION_SIM=true"}</div></div>
    <div class="sc red"><div class="sc-label">Max Drawdown</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.maxDrawdown, s)}</div><div class="sc-sub">Worst single trade</div></div>
    <div class="sc red"><div class="sc-label">Total Drawdown</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.totalDrawdown, s)}</div><div class="sc-sub">Sum of all losses</div></div>
    <div class="sc purple"><div class="sc-label">Risk/Reward</div><div class="sc-val">${s.riskReward||"\u2014"}</div><div class="sc-sub">1 : avg win \u00f7 avg loss</div></div>
    <div class="sc yellow"><div class="sc-label">Win Rate</div><div class="sc-val">${s.winRate||"\u2014"}</div><div class="sc-sub">${s.wins} wins of ${s.totalTrades}</div></div>
    ${s.vixEnabled ? `<div class="sc ${s.vixBlocked > 0 ? 'red' : 'green'}"><div class="sc-label">VIX Filter</div><div class="sc-val">${s.vixBlocked}</div><div class="sc-sub">entries blocked (max=${s.vixMaxEntry}, strong-only=${s.vixStrongOnly})</div></div>` : ''}
  </div>

  <!-- Day View (toggleable) -->
  <div id="dayWiseWrap" style="display:none;margin-bottom:16px;">
    <div class="tbar">
      <span class="tbar-label">Day View</span>
      <span class="tbar-count" id="dayCntLabel"></span>
      <button class="copy-btn" onclick="copyDayView(this)" style="margin-left:auto;">📋 Copy Day View</button>
    </div>
    <div class="tw">
      <table>
        <thead><tr>
          <th>Date</th>
          <th>Trades</th>
          <th>Wins</th>
          <th>Losses</th>
          <th>PnL</th>
          <th>Cumulative PnL</th>
        </tr></thead>
        <tbody id="dayBody"></tbody>
      </table>
    </div>
  </div>

  <!-- Analytics Panel -->
  <div id="anaWrap" style="display:none;margin-bottom:16px;" class="ana-panel">
    <div class="ana-row">
      <div class="ana-card"><h3>📈 Equity Curve</h3><div class="ana-chart-wrap"><canvas id="anaEquity"></canvas></div></div>
      <div class="ana-card"><h3>📊 Monthly P&L</h3><div class="ana-chart-wrap"><canvas id="anaMonthly"></canvas></div></div>
    </div>
    <div class="ana-row">
      <div class="ana-card"><h3>📉 Drawdown</h3><div class="ana-chart-wrap"><canvas id="anaDrawdown"></canvas></div></div>
      <div class="ana-card"><h3>⏰ Hourly Performance</h3><div class="ana-chart-wrap"><canvas id="anaHourly"></canvas></div></div>
    </div>
    <div class="ana-row3">
      <div class="ana-mini">
        <h3>🔥 Win/Loss Streaks</h3>
        <div id="anaStreaks"></div>
      </div>
      <div class="ana-mini">
        <h3>🚪 Exit Reason Breakdown</h3>
        <div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Count</th><th>P&L</th><th>Avg</th></tr></thead><tbody id="anaExitBody"></tbody></table></div>
      </div>
      <div class="ana-mini">
        <h3>📅 Day of Week</h3>
        <div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Day</th><th>Trades</th><th>WR%</th><th>P&L</th><th>Avg</th></tr></thead><tbody id="anaDowBody"></tbody></table></div>
      </div>
    </div>

    <!-- ── Loss-Focused Analytics ── -->
    <div style="border-top:0.5px solid #0e1428;margin:16px 0 12px;padding-top:12px;">
      <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:1.5px;color:#ef4444;font-weight:700;margin-bottom:12px;font-family:'IBM Plex Mono',monospace;">🔍 Loss Analysis</div>
    </div>

    <div class="ana-row">
      <div class="ana-card"><h3>📊 Loss Distribution</h3><div class="ana-chart-wrap"><canvas id="anaLossDist"></canvas></div></div>
      <div class="ana-card"><h3>⏱ Loss by Hold Duration</h3><div class="ana-chart-wrap"><canvas id="anaLossDuration"></canvas></div></div>
    </div>
    <div class="ana-row">
      <div class="ana-card"><h3>🔀 CE vs PE Performance</h3><div class="ana-chart-wrap"><canvas id="anaSidePerf"></canvas></div></div>
      <div class="ana-card"><h3>📉 Drawdown Periods</h3><div class="ana-chart-wrap"><canvas id="anaDDPeriods"></canvas></div></div>
    </div>
    <div class="ana-row3">
      <div class="ana-mini">
        <h3>💀 Top 10 Worst Trades</h3>
        <div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Side</th><th>P&L</th><th>Held</th><th>Exit</th></tr></thead><tbody id="anaWorstBody"></tbody></table></div>
      </div>
      <div class="ana-mini">
        <h3>🔥 Consecutive Loss Streaks</h3>
        <div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Start</th><th>Trades</th><th>Total Loss</th><th>Avg Loss</th><th>Recovery</th></tr></thead><tbody id="anaLossStreakBody"></tbody></table></div>
      </div>
      <div class="ana-mini">
        <h3>⏰ Losing Hours</h3>
        <div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Hour</th><th>Losses</th><th>Loss P&L</th><th>Avg Loss</th><th>Loss%</th></tr></thead><tbody id="anaLossHourBody"></tbody></table></div>
      </div>
    </div>
    <div class="ana-row3">
      <div class="ana-mini">
        <h3>📅 Worst Trading Days</h3>
        <div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Trades</th><th>Day P&L</th><th>Losses</th><th>Worst Trade</th></tr></thead><tbody id="anaWorstDayBody"></tbody></table></div>
      </div>
      <div class="ana-mini">
        <h3>🚪 Loss by Exit Reason</h3>
        <div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Loss Count</th><th>Total Loss</th><th>Avg Loss</th><th>% of Losses</th></tr></thead><tbody id="anaLossReasonBody"></tbody></table></div>
      </div>
      <div class="ana-mini">
        <h3>📊 Risk Metrics</h3>
        <div id="anaRiskMetrics"></div>
      </div>
    </div>

    ${s.rejectBreakdown && s.rejectBreakdown.length > 0 ? `
    <div style="border-top:0.5px solid #0e1428;margin:16px 0 12px;padding-top:12px;">
      <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:1.5px;color:#f59e0b;font-weight:700;margin-bottom:12px;font-family:'IBM Plex Mono',monospace;">🔍 Signal Rejection Breakdown (why entries were blocked while flat)</div>
    </div>
    <div class="ana-row3">
      <div class="ana-mini" style="grid-column:1/-1;">
        <div style="overflow-x:auto;max-height:350px;overflow-y:auto;">
          <table class="ana-tbl"><thead><tr><th style="text-align:right;width:70px;">Count</th><th>Rejection Reason</th></tr></thead><tbody>
          ${s.rejectBreakdown.map(r => `<tr><td style="text-align:right;font-weight:600;color:#f59e0b;">${r.count}</td><td style="font-size:0.82rem;opacity:0.85;">${r.reason}</td></tr>`).join('')}
          </tbody></table>
        </div>
      </div>
    </div>` : ''}
  </div>

  <!-- Filter bar -->
  <div class="tbar">
    <span class="tbar-label">Trade Log</span>
    <button id="dwToggle" class="dw-toggle" onclick="toggleDayWise()" title="Day-wise P&L summary">👁 Day P&L</button>
    <button id="anaToggle" class="dw-toggle" onclick="toggleAnalytics()" title="Performance Analytics">📊 Analytics</button>
    <input id="fSearch" placeholder="Search reason…" oninput="doFilter()" style="width:150px;"/>
    <select id="fSide" onchange="doFilter()">
      <option value="">All Sides</option>
      <option value="CE">CE only</option>
      <option value="PE">PE only</option>
    </select>
    <select id="fResult" onchange="doFilter()">
      <option value="">All Results</option>
      <option value="win">Wins only</option>
      <option value="loss">Losses only</option>
    </select>
    <select id="fPP" onchange="doFilter()">
      <option value="5">5/page</option>
      <option value="10" selected>10/page</option>
      <option value="25">25/page</option>
      <option value="9999">All</option>
    </select>
    <span class="tbar-count" id="cntLabel"></span>
    <button class="copy-btn" onclick="copyTradeLog(this)" style="margin-left:auto;">📋 Copy Trade Log</button>
    <button onclick="doReset()" style="background:#0d1320;border:1px solid #1a2236;color:#4a6080;padding:4px 10px;border-radius:6px;font-size:0.7rem;cursor:pointer;font-family:inherit;">Reset</button>
  </div>

  <!-- Table -->
  <div class="tw">
    <table>
      <thead><tr>
        <th onclick="doSort('side')"   id="h-side">Side &#9660;</th>
        <th onclick="doSort('entry')"  id="h-entry" class="sorted">Entry Time &#9660;</th>
        <th onclick="doSort('exit')"   id="h-exit">Exit Time</th>
        <th onclick="doSort('ePrice')" id="h-ePrice">Entry (pts)</th>
        <th onclick="doSort('xPrice')" id="h-xPrice">Exit (pts)</th>
        <th onclick="doSort('sl')"     id="h-sl">SL (pts)</th>
        <th onclick="doSort('pnl')"    id="h-pnl">PnL ${s.optionSim ? "(₹ sim)" : "(pts)"}</th>
        <th onclick="doSort('risk_pts')" id="h-risk">Risk (pts)</th>
        <th onclick="doSort('rr')"     id="h-rr">R:R</th>
        <th>Exit Reason</th>
        <th style="text-align:center;">Details</th>
      </tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <div class="pag" id="pagBar"></div>
  <div id="tooltip"></div>

  <!-- Trade Detail Modal -->
  <div id="btModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
    <div style="background:#0d1320;border:1px solid #1d3b6e;border-radius:16px;padding:24px 28px;max-width:680px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.9);position:relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
        <div>
          <span id="btm-badge" style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:4px 10px;border-radius:6px;"></span>
          <span style="font-size:0.65rem;color:#4a6080;margin-left:10px;">🔍 Backtest — Full Details</span>
        </div>
        <button onclick="document.getElementById('btModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:#4a6080;font-size:1rem;cursor:pointer;padding:4px 10px;border-radius:6px;font-family:inherit;" onmouseover="this.style.color='#ef4444';this.style.borderColor='#ef4444'" onmouseout="this.style.color='#4a6080';this.style.borderColor='#1a2236'">✕ Close</button>
      </div>
      <div id="btm-grid"></div>
      <div id="btm-reason" style="display:none;"></div>
    </div>
  </div>

<script id="trades-data" type="application/json">${tradesJSON}</script>
<script>
${modalJS()}
var TRADES = JSON.parse(document.getElementById('trades-data').textContent);
var filtered = TRADES.slice();
var sortCol = 'entry', sortDir = -1, pg = 1, pp = 10;

function fmt(n){ return n!=null ? Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '\u2014'; }
var OPT_SIM = ${s.optionSim ? "true" : "false"};
function fpts(n, spotPts){
  if(n==null) return '\u2014';
  if(OPT_SIM){
    var r = (n>=0?'+':'')+'₹'+Math.abs(n).toLocaleString('en-IN',{maximumFractionDigits:0});
    if(spotPts!=null) r += '<span style="font-size:0.65rem;color:#4a6080;margin-left:4px;">('+( spotPts>=0?'+':'')+spotPts.toFixed(1)+'pt)</span>';
    return r;
  }
  return (n>=0?'+':'')+n.toFixed(2)+' pts';
}

function doFilter(){
  var s=document.getElementById('fSearch').value.toLowerCase();
  var side=document.getElementById('fSide').value;
  var res=document.getElementById('fResult').value;
  pp=parseInt(document.getElementById('fPP').value);
  pg=1;
  filtered=TRADES.filter(function(t){
    if(side && t.side!==side) return false;
    if(res==='win'  && (t.pnl==null||t.pnl<0)) return false;
    if(res==='loss' && (t.pnl==null||t.pnl>=0)) return false;
    if(s && t.reason.toLowerCase().indexOf(s)<0) return false;
    return true;
  });
  doSort2();
}

function doSort(col){
  if(sortCol===col){ sortDir*=-1; } else { sortCol=col; sortDir=-1; }
  document.querySelectorAll('thead th').forEach(function(th){
    th.classList.remove('sorted');
    // restore original label (strip old arrow)
    th.innerHTML = th.innerHTML.replace(/ [▼▲]$/, '');
  });
  var h=document.getElementById('h-'+col);
  if(h){ h.classList.add('sorted'); h.innerHTML = h.innerHTML.replace(/ [▼▲]$/, '') + (sortDir===-1?' ▼':' ▲'); }
  doSort2();
}

function doSort2(){
  // Use numeric timestamps for date columns to sort correctly
  var sortKey = sortCol === 'entry' ? 'entryTs' : sortCol === 'exit' ? 'exitTs' : sortCol;
  filtered.sort(function(a,b){
    var av=a[sortKey], bv=b[sortKey];
    if(av==null) av=sortDir===-1?-1e18:1e18;
    if(bv==null) bv=sortDir===-1?-1e18:1e18;
    if(typeof av==='string') return av<bv?-sortDir:av>bv?sortDir:0;
    return (av-bv)*sortDir;
  });
  render();
}

function render(){
  var start=(pg-1)*pp, slice=filtered.slice(start,start+pp);
  var tbody=document.getElementById('tbody');
  document.getElementById('cntLabel').textContent=filtered.length+' of '+TRADES.length+' trades';
  if(slice.length===0){
    tbody.innerHTML='<tr><td colspan="11" style="text-align:center;padding:20px;color:#4a6080;">No trades match filters.</td></tr>';
    document.getElementById('pagBar').innerHTML='';
    return;
  }
  // Store current slice globally so eye buttons can access by index
  window._btSlice = slice;
  var rows='';
  for(var i=0;i<slice.length;i++){
    var t=slice[i];
    var sc=t.side==='CE'?'#10b981':'#ef4444';
    var pc=t.pnl==null?'#c8d8f0':t.pnl>=0?'#10b981':'#ef4444';
    var rrc=t.rr==null?'#4a6080':t.pnl>=0?'#10b981':'#ef4444';
    var sr=t.reason.length>30?t.reason.substring(0,30)+'\u2026':t.reason;
    rows+='<tr>'
      +'<td style="color:'+sc+';font-weight:700;">'+t.side+'</td>'
      +'<td>'+t.entry+'</td>'
      +'<td>'+t.exit+'</td>'
      +'<td>'+fmt(t.ePrice)+'</td>'
      +'<td>'+fmt(t.xPrice)+'</td>'
      +'<td style="color:#f59e0b;">'+(t.sl!=null?fmt(t.sl):'\u2014')+'</td>'
      +'<td style="color:'+pc+';font-weight:700;">'+fpts(t.pnl, t.spotPts)+'</td>'
      +'<td style="color:#94a3b8;font-family:monospace;font-size:0.72rem;">'+(t.risk_pts!=null?'\u00b1'+t.risk_pts.toFixed(2)+' pts':'\u2014')+'</td>'
      +'<td style="color:'+rrc+';font-weight:700;font-family:monospace;">'+(t.rr||'\u2014')+'</td>'
      +'<td style="font-size:0.7rem;color:#4a6080;cursor:default;" data-reason="'+t.reason.replace(/"/g,'&quot;')+'">'+sr+'</td>'
      +'<td style="text-align:center;padding:6px 8px;"><button data-idx="'+i+'" class="bt-eye-btn" style="background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;" title="View full details">👁</button></td>'
      +'</tr>';
  }
  tbody.innerHTML=rows;

  // Eye button click handlers
  Array.from(tbody.querySelectorAll('.bt-eye-btn')).forEach(function(btn){
    btn.addEventListener('click',function(){ showBTModal(window._btSlice[parseInt(this.getAttribute('data-idx'))]); });
    btn.addEventListener('mouseover',function(){ this.style.borderColor='#3b82f6';this.style.background='#0a1e3d'; });
    btn.addEventListener('mouseout', function(){ this.style.borderColor='#1a2236';this.style.background='none'; });
  });

  // tooltip via data-reason
  Array.from(tbody.querySelectorAll('td[data-reason]')).forEach(function(td){
    td.addEventListener('mouseenter',function(e){
      var tip=document.getElementById('tooltip');
      tip.textContent=td.getAttribute('data-reason');
      tip.style.display='block';
      moveTip(e);
    });
    td.addEventListener('mouseleave',function(){ document.getElementById('tooltip').style.display='none'; });
    td.addEventListener('mousemove',moveTip);
  });

  renderPag();
}

function moveTip(e){
  var tip=document.getElementById('tooltip');
  var x=e.clientX+14, y=e.clientY+14;
  if(x+360>window.innerWidth) x=e.clientX-360;
  if(y+80>window.innerHeight) y=e.clientY-60;
  tip.style.left=x+'px'; tip.style.top=y+'px';
}

function renderPag(){
  var total=Math.ceil(filtered.length/pp);
  var bar=document.getElementById('pagBar');
  if(total<=1){ bar.innerHTML=''; return; }
  var h='<button onclick="goPg('+(pg-1)+')" '+(pg===1?'disabled':'')+'>\u2190 Prev</button>';
  h+='<span class="pag-info">Page '+pg+' of '+total+'</span>';
  var s=Math.max(1,pg-2), e=Math.min(total,pg+2);
  for(var p=s;p<=e;p++) h+='<button onclick="goPg('+p+')" class="'+(p===pg?'active':'')+'">'+p+'</button>';
  h+='<button onclick="goPg('+(pg+1)+')" '+(pg===total?'disabled':'')+'>Next \u2192</button>';
  bar.innerHTML=h;
}

function goPg(p){
  var total=Math.ceil(filtered.length/pp);
  pg=Math.max(1,Math.min(total,p));
  render();
  window.scrollTo({top:0,behavior:'smooth'});
}

function doReset(){
  document.getElementById('fSearch').value='';
  document.getElementById('fSide').value='';
  document.getElementById('fResult').value='';
  document.getElementById('fPP').value='10';
  document.querySelectorAll('thead th').forEach(function(th){ th.classList.remove('sorted'); });
  var h=document.getElementById('h-entry');
  if(h) h.classList.add('sorted');
  sortCol='entry'; sortDir=-1; pp=10; pg=1;
  filtered=TRADES.slice();
  doSort2();
}

// ── Day View ──
function buildDayView(){
  var dayMap={};
  TRADES.forEach(function(t){
    var d=t.entry?(t.entry.split(' ')[0]||'Unknown'):'Unknown';
    if(!dayMap[d]) dayMap[d]={date:d,trades:0,wins:0,losses:0,pnl:0};
    dayMap[d].trades++;
    if(t.pnl!=null){
      dayMap[d].pnl+=t.pnl;
      if(t.pnl>=0) dayMap[d].wins++; else dayMap[d].losses++;
    }
  });
  var days=Object.values(dayMap).sort(function(a,b){ return a.date<b.date?-1:a.date>b.date?1:0; });
  var cumPnl=0, rows='';
  for(var i=0;i<days.length;i++){
    var dy=days[i];
    cumPnl+=dy.pnl;
    var pc=dy.pnl>=0?'#10b981':'#ef4444';
    var cc=cumPnl>=0?'#10b981':'#ef4444';
    rows+='<tr>'
      +'<td>'+dy.date+'</td>'
      +'<td>'+dy.trades+'</td>'
      +'<td style="color:#10b981;">'+dy.wins+'</td>'
      +'<td style="color:#ef4444;">'+dy.losses+'</td>'
      +'<td style="color:'+pc+';font-weight:700;">'+fpts(dy.pnl)+'</td>'
      +'<td style="color:'+cc+';font-weight:700;">'+fpts(cumPnl)+'</td>'
      +'</tr>';
  }
  document.getElementById('dayBody').innerHTML=rows||'<tr><td colspan="6" style="text-align:center;padding:20px;color:#4a6080;">No data.</td></tr>';
  document.getElementById('dayCntLabel').textContent=days.length+' days';
  window._dayData=days;
}

function copyDayView(btn){
  var days=window._dayData||[];
  var lines=['Date\\tTrades\\tWins\\tLosses\\tPnL\\tCumulative PnL'];
  var cumPnl=0;
  days.forEach(function(dy){
    cumPnl+=dy.pnl;
    lines.push(dy.date+'\\t'+dy.trades+'\\t'+dy.wins+'\\t'+dy.losses+'\\t'+(dy.pnl!=null?dy.pnl.toFixed(2):'—')+'\\t'+cumPnl.toFixed(2));
  });
  doCopy(lines.join('\\n'),btn,'Day View');
}

function copyTradeLog(btn){
  var lines=['Side\\tEntry Time\\tExit Time\\tEntry\\tExit\\tSL\\tPnL\\tRisk\\tR:R\\tExit Reason'];
  TRADES.forEach(function(t){
    lines.push(t.side+'\\t'+t.entry+'\\t'+t.exit+'\\t'+fmt(t.ePrice)+'\\t'+fmt(t.xPrice)+'\\t'+(t.sl!=null?fmt(t.sl):'—')+'\\t'+(t.pnl!=null?t.pnl.toFixed(2):'—')+'\\t'+(t.risk_pts!=null?t.risk_pts.toFixed(2):'—')+'\\t'+(t.rr||'—')+'\\t'+t.reason);
  });
  doCopy(lines.join('\\n'),btn,'Trade Log');
}

function doCopy(text,btn,label){
  var orig='📋 Copy '+label;
  function onOk(){ btn.classList.add('copied');btn.textContent='✅ Copied!'; setTimeout(function(){ btn.classList.remove('copied');btn.textContent=orig; },2000); }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(onOk).catch(function(){
      var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);onOk();
    });
  } else {
    var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);onOk();
  }
}

// Init
buildDayView();
doFilter();

// ── Day View Toggle ──────────────────────────────────────────────────────────
var dwVisible = false;
function toggleDayWise(){
  dwVisible = !dwVisible;
  document.getElementById('dayWiseWrap').style.display = dwVisible ? 'block' : 'none';
  document.getElementById('dwToggle').classList.toggle('active', dwVisible);
}

// ── Analytics Panel ──────────────────────────────────────────────────────────
var anaVisible = false;
var anaCharts = {};
function fmtAna(v){ return OPT_SIM ? '\\u20b9'+Math.round(Math.abs(v)).toLocaleString('en-IN') : (typeof v==='number'?v.toFixed(2):v)+' pts'; }
function fmtAnaShort(v){ return OPT_SIM ? '\\u20b9'+Math.round(v/1000)+'k' : Math.round(v)+' pts'; }
// Helper: get IST Date object from entryTs (unix seconds)
function tsToIST(ts){ return ts ? new Date(ts * 1000) : null; }
function tsFmtDate(ts){ var d=tsToIST(ts); if(!d) return 'Unknown'; return d.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'}); }
function tsFmtMonth(ts){ var d=tsToIST(ts); if(!d) return '2025-01'; var m=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',timeZone:'Asia/Kolkata'}).format(d); return m; }
function tsHour(ts){ var d=tsToIST(ts); if(!d) return 9; return parseInt(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hour12:false,timeZone:'Asia/Kolkata'}).format(d)); }
function tsDow(ts){ var d=tsToIST(ts); if(!d) return 1; var s=new Intl.DateTimeFormat('en-US',{weekday:'short',timeZone:'Asia/Kolkata'}).format(d); var map={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}; return map[s]!=null?map[s]:1; }
function toggleAnalytics(){
  anaVisible = !anaVisible;
  document.getElementById('anaWrap').style.display = anaVisible ? 'block' : 'none';
  document.getElementById('anaToggle').classList.toggle('active', anaVisible);
  if(anaVisible) renderAnalytics();
}

function renderAnalytics(){
  var trades = filtered.slice().sort(function(a,b){ return a.entryTs - b.entryTs; });
  if(!trades.length) return;
  var _gc = '#0e1428';
  var _tc = '#3a5070';

  // ── Equity Curve ──
  var cumPnl = [], labels = [], equity = 0;
  trades.forEach(function(t,i){
    equity += (t.pnl||0);
    cumPnl.push(equity);
    labels.push(i+1);
  });
  if(anaCharts.equity) anaCharts.equity.destroy();
  anaCharts.equity = new Chart(document.getElementById('anaEquity'),{
    type:'line',
    data:{labels:labels,datasets:[{
      label:'Cumulative P&L',
      data:cumPnl,
      borderColor:'#3b82f6',borderWidth:1.5,
      backgroundColor:'rgba(59,130,246,0.08)',fill:true,
      pointRadius:0,tension:0.3
    }]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{
        title:function(ctx){return 'Trade #'+ctx[0].label;},
        label:function(ctx){return 'P&L: '+fmtAna(ctx.raw);}
      }}},
      scales:{
        x:{display:false},
        y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},
          callback:function(v){return fmtAnaShort(v);}}}
      }
    }
  });

  // ── Monthly P&L ──
  var monthMap = {};
  trades.forEach(function(t){
    var key = tsFmtMonth(t.entryTs);
    if(!monthMap[key]) monthMap[key] = 0;
    monthMap[key] += (t.pnl||0);
  });
  var monthKeys = Object.keys(monthMap).sort();
  var monthLabels = monthKeys.map(function(k){ var p=k.split('-'); var mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return mn[parseInt(p[1])]+" '"+p[0].slice(2); });
  var monthVals = monthKeys.map(function(k){ return Math.round(monthMap[k]); });
  var monthColors = monthVals.map(function(v){ return v>=0?'#10b981':'#ef4444'; });
  if(anaCharts.monthly) anaCharts.monthly.destroy();
  anaCharts.monthly = new Chart(document.getElementById('anaMonthly'),{
    type:'bar',
    data:{labels:monthLabels,datasets:[{
      data:monthVals,backgroundColor:monthColors,borderRadius:4,barPercentage:0.7
    }]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{
        label:function(ctx){return fmtAna(ctx.raw);}
      }}},
      scales:{
        x:{grid:{display:false},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'}}},
        y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},
          callback:function(v){return fmtAnaShort(v);}}}
      }
    }
  });

  // ── Drawdown Chart ──
  var eqArr=[], peak=0, ddArr=[];
  var eq2=0;
  trades.forEach(function(t){
    eq2 += (t.pnl||0);
    eqArr.push(eq2);
    if(eq2>peak) peak=eq2;
    ddArr.push(eq2-peak);
  });
  if(anaCharts.dd) anaCharts.dd.destroy();
  anaCharts.dd = new Chart(document.getElementById('anaDrawdown'),{
    type:'line',
    data:{labels:labels,datasets:[{
      label:'Drawdown',
      data:ddArr,
      borderColor:'#ef4444',borderWidth:1.5,
      backgroundColor:'rgba(239,68,68,0.12)',fill:true,
      pointRadius:0,tension:0.3
    }]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{
        label:function(ctx){return 'DD: '+fmtAna(ctx.raw);}
      }}},
      scales:{
        x:{display:false},
        y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},
          callback:function(v){return fmtAnaShort(v);}}}
      }
    }
  });

  // ── Hourly Performance ──
  var hourMap = {};
  trades.forEach(function(t){
    var h = tsHour(t.entryTs);
    if(h==null) return;
    if(!hourMap[h]) hourMap[h] = {pnl:0,cnt:0,wins:0};
    hourMap[h].pnl += (t.pnl||0);
    hourMap[h].cnt++;
    if(t.pnl>0) hourMap[h].wins++;
  });
  var hours = Object.keys(hourMap).map(Number).sort(function(a,b){return a-b;});
  var hourLabels = hours.map(function(h){return h+':00';});
  var hourPnl = hours.map(function(h){return Math.round(hourMap[h].pnl);});
  var hourBarColors = hourPnl.map(function(v){return v>=0?'rgba(16,185,129,0.7)':'rgba(239,68,68,0.7)';});
  if(anaCharts.hourly) anaCharts.hourly.destroy();
  anaCharts.hourly = new Chart(document.getElementById('anaHourly'),{
    type:'bar',
    data:{labels:hourLabels,datasets:[{
      data:hourPnl,backgroundColor:hourBarColors,borderRadius:4,barPercentage:0.7
    }]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{
        title:function(ctx){var h=hours[ctx[0].dataIndex];return h+':00 - '+(h+1)+':00 ('+hourMap[h].cnt+' trades, '+((hourMap[h].wins/hourMap[h].cnt)*100).toFixed(0)+'% WR)';},
        label:function(ctx){return fmtAna(ctx.raw);}
      }}},
      scales:{
        x:{grid:{display:false},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'}}},
        y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},
          callback:function(v){return fmtAnaShort(v);}}}
      }
    }
  });

  // ── Win/Loss Streaks ──
  var maxWS=0,maxLS=0,curWS=0,curLS=0,avgWS=[],avgLS=[],wsCount=0,lsCount=0;
  trades.forEach(function(t){
    if(t.pnl>0){
      curWS++; if(curLS>0){avgLS.push(curLS);lsCount++;} curLS=0;
      if(curWS>maxWS) maxWS=curWS;
    } else if(t.pnl<0){
      curLS++; if(curWS>0){avgWS.push(curWS);wsCount++;} curWS=0;
      if(curLS>maxLS) maxLS=curLS;
    }
  });
  if(curWS>0) avgWS.push(curWS);
  if(curLS>0) avgLS.push(curLS);
  var avgW = avgWS.length>0 ? (avgWS.reduce(function(a,b){return a+b;},0)/avgWS.length).toFixed(1) : '0';
  var avgL = avgLS.length>0 ? (avgLS.reduce(function(a,b){return a+b;},0)/avgLS.length).toFixed(1) : '0';

  // Profitable/losing days
  var dayPnlMap={};
  trades.forEach(function(t){
    var d=tsFmtDate(t.entryTs);
    if(!dayPnlMap[d]) dayPnlMap[d]=0;
    dayPnlMap[d]+=(t.pnl||0);
  });
  var profDays=0,lossDays=0;
  Object.values(dayPnlMap).forEach(function(v){if(v>=0)profDays++;else lossDays++;});
  var totalDays=profDays+lossDays;

  document.getElementById('anaStreaks').innerHTML=
    '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+maxWS+'</span><span class="ana-stat-label">Best win streak</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+maxLS+'</span><span class="ana-stat-label">Worst loss streak</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#60a5fa;">'+avgW+'</span><span class="ana-stat-label">Avg win streak</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#f59e0b;">'+avgL+'</span><span class="ana-stat-label">Avg loss streak</span></div>'
    +'<div style="border-top:0.5px solid #0e1428;margin:8px 0;padding-top:8px;">'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+profDays+'</span><span class="ana-stat-label">Profitable days ('+(totalDays>0?((profDays/totalDays)*100).toFixed(0):'0')+'%)</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+lossDays+'</span><span class="ana-stat-label">Losing days ('+(totalDays>0?((lossDays/totalDays)*100).toFixed(0):'0')+'%)</span></div>'
    +'<div class="ana-stat"><span class="ana-stat-val" style="color:#c8d8f0;">'+fmtAna(totalDays>0?Object.values(dayPnlMap).reduce(function(a,b){return a+b;},0)/totalDays:0)+'</span><span class="ana-stat-label">Avg daily P&L</span></div>'
    +'</div>';

  // ── Exit Reason Breakdown ──
  var reasonMap={};
  trades.forEach(function(t){
    var r = t.reason;
    if(r.indexOf('Trail lock')===0) r='Trail lock (profit)';
    else if(r.indexOf('Prev candle Trail SL')===0) r='Prev candle Trail SL';
    else if(r.indexOf('Prev candle SL')===0) r='Prev candle SL hit';
    else if(r.indexOf('PSAR Trail SL')===0) r='PSAR Trail SL';
    else if(r.indexOf('PSAR SL')===0) r='PSAR SL hit';
    else if(r.indexOf('PSAR flip')===0) r='PSAR flip';
    else if(r.indexOf('EOD')===0) r='EOD square-off';
    if(!reasonMap[r]) reasonMap[r]={cnt:0,pnl:0};
    reasonMap[r].cnt++;
    reasonMap[r].pnl+=(t.pnl||0);
  });
  var reasons=Object.keys(reasonMap).sort(function(a,b){return reasonMap[b].pnl-reasonMap[a].pnl;});
  var exitHtml='';
  reasons.forEach(function(r){
    var d=reasonMap[r];
    var pc=d.pnl>=0?'#10b981':'#ef4444';
    var avgPnl=Math.round(d.pnl/d.cnt);
    exitHtml+='<tr><td style="color:#c8d8f0;">'+r+'</td><td>'+d.cnt+'</td>'
      +'<td style="color:'+pc+';font-weight:700;">'+fmtAna(d.pnl)+'</td>'
      +'<td style="color:'+pc+';">'+fmtAna(avgPnl)+'</td></tr>';
  });
  document.getElementById('anaExitBody').innerHTML=exitHtml;

  // ── Day of Week ──
  var dowMap={0:{n:'Sun',t:0,w:0,p:0},1:{n:'Mon',t:0,w:0,p:0},2:{n:'Tue',t:0,w:0,p:0},3:{n:'Wed',t:0,w:0,p:0},4:{n:'Thu',t:0,w:0,p:0},5:{n:'Fri',t:0,w:0,p:0},6:{n:'Sat',t:0,w:0,p:0}};
  trades.forEach(function(t){
    var dow=tsDow(t.entryTs);
    dowMap[dow].t++;
    if(t.pnl>0) dowMap[dow].w++;
    dowMap[dow].p+=(t.pnl||0);
  });
  var dowHtml='';
  [1,2,3,4,5].forEach(function(d){
    var dd=dowMap[d];
    if(dd.t===0) return;
    var wr=((dd.w/dd.t)*100).toFixed(0);
    var pc=dd.p>=0?'#10b981':'#ef4444';
    var avg=Math.round(dd.p/dd.t);
    dowHtml+='<tr><td style="color:#c8d8f0;font-weight:600;">'+dd.n+'</td><td>'+dd.t+'</td>'
      +'<td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td>'
      +'<td style="color:'+pc+';font-weight:700;">'+fmtAna(dd.p)+'</td>'
      +'<td style="color:'+pc+';">'+fmtAna(avg)+'</td></tr>';
  });
  document.getElementById('anaDowBody').innerHTML=dowHtml;

  // ═══════════════════════════════════════════════════════════════════════════
  // ── LOSS-FOCUSED ANALYTICS ────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  var lossTrades = trades.filter(function(t){ return t.pnl < 0; });
  var winTrades  = trades.filter(function(t){ return t.pnl > 0; });

  // ── Loss Distribution Histogram ──
  (function(){
    if(!lossTrades.length) return;
    var lossVals = lossTrades.map(function(t){ return Math.abs(t.pnl); }).sort(function(a,b){return a-b;});
    var maxVal = lossVals[lossVals.length-1];
    var bucketCount = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(lossVals.length))));
    var step = OPT_SIM ? Math.ceil(maxVal / bucketCount / 100) * 100 : Math.ceil(maxVal / bucketCount * 10) / 10;
    if(step < 0.01) step = 0.01;
    var buckets = [], bucketLabels = [];
    for(var i=0; i<bucketCount; i++){
      buckets.push(0);
      bucketLabels.push(fmtAnaShort(i*step)+'-'+fmtAnaShort((i+1)*step));
    }
    lossVals.forEach(function(v){
      var idx = Math.min(Math.floor(v / step), bucketCount-1);
      buckets[idx]++;
    });
    if(anaCharts.lossDist) anaCharts.lossDist.destroy();
    anaCharts.lossDist = new Chart(document.getElementById('anaLossDist'),{
      type:'bar',
      data:{labels:bucketLabels,datasets:[{
        data:buckets,backgroundColor:'rgba(239,68,68,0.6)',borderRadius:4,barPercentage:0.85
      }]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{callbacks:{
          title:function(ctx){return ctx[0].label;},
          label:function(ctx){return ctx.raw+' trades ('+((ctx.raw/lossTrades.length)*100).toFixed(0)+'%)';}
        }}},
        scales:{
          x:{grid:{display:false},ticks:{color:_tc,font:{size:9,family:'IBM Plex Mono'},maxRotation:45}},
          y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},stepSize:1},title:{display:true,text:'# Trades',color:_tc,font:{size:9,family:'IBM Plex Mono'}}}
        }
      }
    });
  })();

  // ── Loss by Hold Duration ──
  (function(){
    if(!trades.length) return;
    var durationMap = {};
    trades.forEach(function(t){
      var h = t.held || 0;
      var bucket;
      if(h<=2) bucket='1-2';
      else if(h<=5) bucket='3-5';
      else if(h<=10) bucket='6-10';
      else if(h<=20) bucket='11-20';
      else if(h<=40) bucket='21-40';
      else bucket='40+';
      if(!durationMap[bucket]) durationMap[bucket]={wins:0,losses:0,winPnl:0,lossPnl:0,total:0};
      durationMap[bucket].total++;
      if(t.pnl>0){ durationMap[bucket].wins++; durationMap[bucket].winPnl+=t.pnl; }
      else if(t.pnl<0){ durationMap[bucket].losses++; durationMap[bucket].lossPnl+=t.pnl; }
    });
    var bucketOrder=['1-2','3-5','6-10','11-20','21-40','40+'];
    var activeBuckets=bucketOrder.filter(function(b){return durationMap[b];});
    var dLabels=activeBuckets.map(function(b){return b+' candles';});
    var dWinPnl=activeBuckets.map(function(b){return Math.round(durationMap[b].winPnl);});
    var dLossPnl=activeBuckets.map(function(b){return Math.round(durationMap[b].lossPnl);});
    if(anaCharts.lossDur) anaCharts.lossDur.destroy();
    anaCharts.lossDur = new Chart(document.getElementById('anaLossDuration'),{
      type:'bar',
      data:{labels:dLabels,datasets:[
        {label:'Win P&L',data:dWinPnl,backgroundColor:'rgba(16,185,129,0.6)',borderRadius:4,barPercentage:0.7},
        {label:'Loss P&L',data:dLossPnl,backgroundColor:'rgba(239,68,68,0.6)',borderRadius:4,barPercentage:0.7}
      ]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{labels:{color:_tc,font:{size:9,family:'IBM Plex Mono'}}},tooltip:{callbacks:{
          label:function(ctx){return ctx.dataset.label+': '+fmtAna(ctx.raw);}
        }}},
        scales:{
          x:{grid:{display:false},ticks:{color:_tc,font:{size:9,family:'IBM Plex Mono'}}},
          y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}
        }
      }
    });
  })();

  // ── CE vs PE Performance ──
  (function(){
    if(!trades.length) return;
    var sides={CE:{wins:0,losses:0,winPnl:0,lossPnl:0,total:0},PE:{wins:0,losses:0,winPnl:0,lossPnl:0,total:0}};
    trades.forEach(function(t){
      var s=t.side||'CE';
      if(!sides[s]) return;
      sides[s].total++;
      if(t.pnl>0){sides[s].wins++;sides[s].winPnl+=t.pnl;}
      else if(t.pnl<0){sides[s].losses++;sides[s].lossPnl+=t.pnl;}
    });
    var sLabels=['CE','PE'];
    var sWinPnl=sLabels.map(function(s){return Math.round(sides[s].winPnl);});
    var sLossPnl=sLabels.map(function(s){return Math.round(sides[s].lossPnl);});
    var sNet=sLabels.map(function(s){return Math.round(sides[s].winPnl+sides[s].lossPnl);});
    if(anaCharts.sidePerf) anaCharts.sidePerf.destroy();
    anaCharts.sidePerf = new Chart(document.getElementById('anaSidePerf'),{
      type:'bar',
      data:{labels:sLabels.map(function(s){
        return s+' ('+sides[s].total+' trades, '+((sides[s].wins/Math.max(sides[s].total,1))*100).toFixed(0)+'% WR)';
      }),datasets:[
        {label:'Win P&L',data:sWinPnl,backgroundColor:'rgba(16,185,129,0.65)',borderRadius:4,barPercentage:0.6},
        {label:'Loss P&L',data:sLossPnl,backgroundColor:'rgba(239,68,68,0.65)',borderRadius:4,barPercentage:0.6},
        {label:'Net P&L',data:sNet,backgroundColor:sNet.map(function(v){return v>=0?'rgba(59,130,246,0.65)':'rgba(245,158,11,0.65)';}),borderRadius:4,barPercentage:0.6}
      ]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{labels:{color:_tc,font:{size:9,family:'IBM Plex Mono'}}},tooltip:{callbacks:{
          label:function(ctx){return ctx.dataset.label+': '+fmtAna(ctx.raw);}
        }}},
        scales:{
          x:{grid:{display:false},ticks:{color:_tc,font:{size:9,family:'IBM Plex Mono'}}},
          y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}
        }
      }
    });
  })();

  // ── Drawdown Periods Chart (Underwater Equity) ──
  (function(){
    if(!trades.length) return;
    var uwLabels=[],uwData=[];
    var eq4=0,pk4=0;
    trades.forEach(function(t,i){
      eq4+=(t.pnl||0);if(eq4>pk4) pk4=eq4;
      uwLabels.push(i+1);
      uwData.push(eq4-pk4);
    });
    if(anaCharts.ddPeriods) anaCharts.ddPeriods.destroy();
    anaCharts.ddPeriods = new Chart(document.getElementById('anaDDPeriods'),{
      type:'line',
      data:{labels:uwLabels,datasets:[{
        label:'Underwater Equity',
        data:uwData,
        borderColor:'#f97316',borderWidth:1.5,
        backgroundColor:'rgba(249,115,22,0.1)',fill:true,
        pointRadius:0,tension:0.3
      }]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{callbacks:{
          label:function(ctx){return 'Underwater: '+fmtAna(ctx.raw);}
        }}},
        scales:{
          x:{display:false},
          y:{grid:{color:_gc},ticks:{color:_tc,font:{size:10,family:'IBM Plex Mono'},callback:function(v){return fmtAnaShort(v);}}}
        }
      }
    });
  })();

  // ── Top 10 Worst Trades ──
  (function(){
    var worst = lossTrades.slice().sort(function(a,b){return a.pnl-b.pnl;}).slice(0,10);
    var html='';
    worst.forEach(function(t){
      var dateStr=tsFmtDate(t.entryTs);
      html+='<tr><td style="color:#c8d8f0;">'+dateStr+'</td>'
        +'<td style="color:'+(t.side==='CE'?'#10b981':'#ef4444')+';font-weight:700;">'+t.side+'</td>'
        +'<td style="color:#ef4444;font-weight:700;">'+fmtAna(t.pnl)+'</td>'
        +'<td>'+(t.held||0)+'</td>'
        +'<td style="font-size:0.65rem;">'+t.reason+'</td></tr>';
    });
    document.getElementById('anaWorstBody').innerHTML=html;
  })();

  // ── Consecutive Loss Streaks ──
  (function(){
    var streaks=[],cur=[];
    trades.forEach(function(t,i){
      if(t.pnl<0){
        cur.push({trade:t,idx:i});
      } else {
        if(cur.length>=2) streaks.push({items:cur.slice(),startIdx:cur[0].idx});
        cur=[];
      }
    });
    if(cur.length>=2) streaks.push({items:cur.slice(),startIdx:cur[0].idx});
    streaks.sort(function(a,b){
      var aPnl=a.items.reduce(function(s,c){return s+c.trade.pnl;},0);
      var bPnl=b.items.reduce(function(s,c){return s+c.trade.pnl;},0);
      return aPnl-bPnl;
    });
    var html='';
    streaks.slice(0,10).forEach(function(streak){
      var totalLoss=streak.items.reduce(function(s,c){return s+c.trade.pnl;},0);
      var avgLoss=totalLoss/streak.items.length;
      var startDate=tsFmtDate(streak.items[0].trade.entryTs);
      var recovered=0,recTrades=0;
      for(var i=streak.startIdx+streak.items.length;i<trades.length;i++){
        recovered+=trades[i].pnl;
        recTrades++;
        if(recovered>=Math.abs(totalLoss)) break;
      }
      var recText=recovered>=Math.abs(totalLoss)?recTrades+' trades':'Not yet';
      html+='<tr><td style="color:#c8d8f0;">'+startDate+'</td>'
        +'<td>'+streak.items.length+'</td>'
        +'<td style="color:#ef4444;font-weight:700;">'+fmtAna(totalLoss)+'</td>'
        +'<td style="color:#ef4444;">'+fmtAna(avgLoss)+'</td>'
        +'<td style="color:'+(recText==='Not yet'?'#f59e0b':'#10b981')+';">'+recText+'</td></tr>';
    });
    if(!html) html='<tr><td colspan="5" style="text-align:center;color:#3a5070;">No consecutive loss streaks (2+)</td></tr>';
    document.getElementById('anaLossStreakBody').innerHTML=html;
  })();

  // ── Losing Hours Breakdown ──
  (function(){
    var lhMap={};
    trades.forEach(function(t){
      var h=tsHour(t.entryTs);
      if(h==null) return;
      if(!lhMap[h]) lhMap[h]={total:0,losses:0,lossPnl:0};
      lhMap[h].total++;
      if(t.pnl<0){lhMap[h].losses++;lhMap[h].lossPnl+=t.pnl;}
    });
    var hrs=Object.keys(lhMap).map(Number).sort(function(a,b){return a-b;});
    var html='';
    hrs.forEach(function(h){
      var d=lhMap[h];
      if(d.losses===0) return;
      var lossPct=((d.losses/d.total)*100).toFixed(0);
      var avgLoss=Math.round(d.lossPnl/d.losses);
      var dangerColor=parseFloat(lossPct)>=60?'#ef4444':parseFloat(lossPct)>=45?'#f59e0b':'#10b981';
      html+='<tr><td style="color:#c8d8f0;font-weight:600;">'+h+':00</td>'
        +'<td>'+d.losses+' / '+d.total+'</td>'
        +'<td style="color:#ef4444;font-weight:700;">'+fmtAna(d.lossPnl)+'</td>'
        +'<td style="color:#ef4444;">'+fmtAna(avgLoss)+'</td>'
        +'<td style="color:'+dangerColor+';font-weight:700;">'+lossPct+'%</td></tr>';
    });
    document.getElementById('anaLossHourBody').innerHTML=html;
  })();

  // ── Worst Trading Days ──
  (function(){
    var dayTrades={};
    trades.forEach(function(t){
      var d=tsFmtDate(t.entryTs);
      if(!dayTrades[d]) dayTrades[d]={trades:[],pnl:0,losses:0,worstTrade:0};
      dayTrades[d].trades.push(t);
      dayTrades[d].pnl+=(t.pnl||0);
      if(t.pnl<0) dayTrades[d].losses++;
      if(t.pnl<dayTrades[d].worstTrade) dayTrades[d].worstTrade=t.pnl;
    });
    var days=Object.keys(dayTrades).filter(function(d){return dayTrades[d].pnl<0;});
    days.sort(function(a,b){return dayTrades[a].pnl-dayTrades[b].pnl;});
    var html='';
    days.slice(0,10).forEach(function(d){
      var dd=dayTrades[d];
      html+='<tr><td style="color:#c8d8f0;">'+d+'</td>'
        +'<td>'+dd.trades.length+'</td>'
        +'<td style="color:#ef4444;font-weight:700;">'+fmtAna(dd.pnl)+'</td>'
        +'<td>'+dd.losses+'</td>'
        +'<td style="color:#ef4444;">'+fmtAna(dd.worstTrade)+'</td></tr>';
    });
    if(!html) html='<tr><td colspan="5" style="text-align:center;color:#3a5070;">No losing days</td></tr>';
    document.getElementById('anaWorstDayBody').innerHTML=html;
  })();

  // ── Loss by Exit Reason ──
  (function(){
    var lrMap={};
    lossTrades.forEach(function(t){
      var r=t.reason;
      if(r.indexOf('Trail lock')===0) r='Trail lock (profit)';
      else if(r.indexOf('Prev candle Trail SL')===0) r='Prev candle Trail SL';
      else if(r.indexOf('Prev candle SL')===0) r='Prev candle SL hit';
      else if(r.indexOf('PSAR Trail SL')===0) r='PSAR Trail SL';
      else if(r.indexOf('PSAR SL')===0) r='PSAR SL hit';
      else if(r.indexOf('PSAR flip')===0) r='PSAR flip';
      else if(r.indexOf('EOD')===0) r='EOD square-off';
      if(!lrMap[r]) lrMap[r]={cnt:0,pnl:0};
      lrMap[r].cnt++;
      lrMap[r].pnl+=t.pnl;
    });
    var reasons2=Object.keys(lrMap).sort(function(a,b){return lrMap[a].pnl-lrMap[b].pnl;});
    var totalLossCnt=lossTrades.length;
    var html='';
    reasons2.forEach(function(r){
      var d=lrMap[r];
      var pct=((d.cnt/totalLossCnt)*100).toFixed(0);
      html+='<tr><td style="color:#c8d8f0;">'+r+'</td>'
        +'<td>'+d.cnt+'</td>'
        +'<td style="color:#ef4444;font-weight:700;">'+fmtAna(d.pnl)+'</td>'
        +'<td style="color:#ef4444;">'+fmtAna(Math.round(d.pnl/d.cnt))+'</td>'
        +'<td style="font-weight:600;">'+pct+'%</td></tr>';
    });
    document.getElementById('anaLossReasonBody').innerHTML=html;
  })();

  // ── Risk Metrics Summary ──
  (function(){
    var avgHeldWin=winTrades.length>0?(winTrades.reduce(function(s,t){return s+(t.held||0);},0)/winTrades.length).toFixed(1):'0';
    var avgHeldLoss=lossTrades.length>0?(lossTrades.reduce(function(s,t){return s+(t.held||0);},0)/lossTrades.length).toFixed(1):'0';

    var maxConsLoss=0,curCons=0;
    trades.forEach(function(t){if(t.pnl<0){curCons++;if(curCons>maxConsLoss)maxConsLoss=curCons;}else{curCons=0;}});

    // Ulcer index
    var eq5=0,pk5=0,ddSqSum=0;
    trades.forEach(function(t){
      eq5+=(t.pnl||0);if(eq5>pk5)pk5=eq5;
      var ddPct=pk5>0?((pk5-eq5)/pk5)*100:0;
      ddSqSum+=ddPct*ddPct;
    });
    var ulcerIdx=trades.length>0?Math.sqrt(ddSqSum/trades.length).toFixed(2):'0';

    // Tail ratio
    var sortedPnl=trades.map(function(t){return t.pnl;}).sort(function(a,b){return a-b;});
    var p5Idx=Math.floor(sortedPnl.length*0.05);
    var p95Idx=Math.floor(sortedPnl.length*0.95);
    var p5=sortedPnl[p5Idx]||0;
    var p95=sortedPnl[p95Idx]||0;
    var tailRatio=p5!==0?(Math.abs(p95)/Math.abs(p5)).toFixed(2):'\\u2014';

    // Loss after loss probability
    var lossAfterLoss=0,totalAfterLoss=0;
    for(var i=1;i<trades.length;i++){
      if(trades[i-1].pnl<0){
        totalAfterLoss++;
        if(trades[i].pnl<0) lossAfterLoss++;
      }
    }
    var lossAfterLossPct=totalAfterLoss>0?((lossAfterLoss/totalAfterLoss)*100).toFixed(0):'\\u2014';

    document.getElementById('anaRiskMetrics').innerHTML=
      '<div class="ana-stat"><span class="ana-stat-val" style="color:#f59e0b;">'+avgHeldWin+'</span><span class="ana-stat-label">Avg candles held (wins)</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+avgHeldLoss+'</span><span class="ana-stat-label">Avg candles held (losses)</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+maxConsLoss+'</span><span class="ana-stat-label">Max consecutive losses</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#f97316;">'+ulcerIdx+'</span><span class="ana-stat-label">Ulcer Index</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#8b5cf6;">'+tailRatio+'</span><span class="ana-stat-label">Tail ratio (P95 win / P5 loss)</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:'+(parseFloat(lossAfterLossPct)>=50?'#ef4444':'#10b981')+';">'+lossAfterLossPct+'%</span><span class="ana-stat-label">Loss after loss probability</span></div>'
      +'<div style="border-top:0.5px solid #0e1428;margin:8px 0;padding-top:8px;">'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+fmtAna(Math.abs(p5))+'</span><span class="ana-stat-label">5th percentile (worst case)</span></div>'
      +'<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+fmtAna(p95)+'</span><span class="ana-stat-label">95th percentile (best case)</span></div>'
      +'</div>';
  })();
}

// Re-render analytics when filters change
var _origDoSort2Ana = doSort2;
doSort2 = function(){ _origDoSort2Ana(); if(anaVisible) renderAnalytics(); };

function showBTModal(t){
  var pc=t.pnl==null?'#c8d8f0':t.pnl>=0?'#10b981':'#ef4444';
  var sc=t.side==='CE'?'#10b981':'#ef4444';
  var optDiff=(t.eOpt!=null&&t.xOpt!=null)?parseFloat((t.xOpt-t.eOpt).toFixed(2)):null;
  var dc=optDiff==null?'#c8d8f0':optDiff>=0?'#10b981':'#ef4444';
  var pnlPts=(t.ePrice&&t.xPrice&&t.side)?parseFloat(((t.side==='PE'?t.ePrice-t.xPrice:t.xPrice-t.ePrice)).toFixed(2)):null;
  var badge=document.getElementById('btm-badge');
  badge.textContent=(t.side||'—');
  badge.style.background=t.side==='CE'?'rgba(16,185,129,0.15)':'rgba(239,68,68,0.15)';
  badge.style.color=sc;
  badge.style.border='1px solid '+(t.side==='CE'?'rgba(16,185,129,0.3)':'rgba(239,68,68,0.3)');

  function cell(label,val,color,sub){
    return '<div style="background:#060910;border:1px solid #1a2236;border-radius:8px;padding:11px 13px;">'
      +'<div style="font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:5px;">'+label+'</div>'
      +'<div style="font-size:0.9rem;font-weight:700;color:'+(color||'#e0eaf8')+';font-family:monospace;line-height:1.3;">'+(val||'—')+'</div>'
      +(sub?'<div style="font-size:0.62rem;color:#4a6080;margin-top:3px;">'+sub+'</div>':'')
      +'</div>';
  }

  var entryHtml='<div style="background:#060c18;border:1px solid #0d2040;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a4080;margin-bottom:8px;font-weight:700;">🟢 Entry</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">'
    +cell('Entry Time',     t.entry||'—',   '#c8d8f0')
    +cell('NIFTY Spot @ Entry', fmt(t.ePrice), '#fff', 'Spot price at signal')
    +cell('Stop Loss',      t.sl!=null?fmt(t.sl):'—', '#f59e0b', 'NIFTY spot SL level')
    +cell('Risk (pts)',     t.risk_pts!=null?'±'+t.risk_pts.toFixed(2)+' pts':'—', '#94a3b8', 'Entry to SL distance')
    +'</div></div>';

  var exitHtml='<div style="background:#0c0608;border:1px solid #3a0d12;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#801a20;margin-bottom:8px;font-weight:700;">🔴 Exit</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">'
    +cell('Exit Time',      t.exit||'—',    '#c8d8f0')
    +cell('NIFTY Spot @ Exit', fmt(t.xPrice), '#fff', 'Spot price at exit')
    +cell('NIFTY Move (pts)', pnlPts!=null?(pnlPts>=0?'+':'')+pnlPts+' pts':'—', pnlPts!=null?(pnlPts>=0?'#10b981':'#ef4444'):'#c8d8f0', t.side==='PE'?'Entry−Exit (PE profits on fall)':'Exit−Entry (CE profits on rise)')
    +cell('PnL',           t.pnl!=null?(t.pnl>=0?'+':'')+( OPT_SIM ? '₹'+Math.abs(t.pnl).toLocaleString('en-IN',{maximumFractionDigits:0}) : t.pnl.toFixed(2)+' pts' ):'—', pc, OPT_SIM ? 'Option sim: spot×δ−θ−brok (see pnlMode)' : 'Raw NIFTY index pts')
    +cell('Spot PnL (pts)',t.spotPts!=null?(t.spotPts>=0?'+':'')+t.spotPts.toFixed(2)+' pts':'—', t.spotPts!=null?(t.spotPts>=0?'#10b981':'#ef4444'):'#4a6080', 'Raw NIFTY index point move')
    +cell('Held (candles)',t.held!=null?t.held+' candles':'—', '#94a3b8', 'Candles held — affects theta decay')
    +cell('PnL Method',   t.pnlMode||'—', '#4a6080', 'How PnL was calculated')
    +cell('R:R Ratio',     t.rr||'—', t.pnl!=null&&t.pnl>=0?'#10b981':'#ef4444', 'Reward ÷ Risk')
    +'</div></div>';

  var reasonHtml='<div style="background:#060910;border:1px solid #1a2236;border-radius:10px;padding:12px 14px;">'
    +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#3a5070;margin-bottom:6px;font-weight:700;">📌 Exit Reason</div>'
    +'<div style="font-size:0.82rem;color:#a0b8d0;line-height:1.6;font-family:monospace;">'+(t.reason||'—')+'</div>'
    +'</div>';

  document.getElementById('btm-grid').innerHTML=entryHtml+exitHtml+reasonHtml;
  document.getElementById('btm-reason').style.display='none';
  var m=document.getElementById('btModal');
  m.style.display='flex';
}
document.getElementById('btModal').addEventListener('click',function(e){
  if(e.target===this) this.style.display='none';
});
</script>
</div></div>
</body>
</html>`);

  } catch (err) {
    console.error("Backtest error:", err.message, err.stack);
    // Re-render the backtest page with an inline error toast instead of navigating away.
    // User keeps their date/resolution settings and sees the error in the top-right corner.
    const errHtml = buildBacktestPageWithToast(from, to, resolution, err.message, liveActive);
    res.setHeader("Content-Type", "text/html");
    return res.status(200).send(errHtml);
  }
});

function buildBacktestPageWithToast(from, to, resolution, errMsg, liveActive) {
  const nav = buildNav("backtest", liveActive);
  const resOptions = `<option value="15" selected>15-min</option>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Backtest — ௐ Palani Andawar Thunai ॐ</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:system-ui,sans-serif;background:#080c14;color:#c8d0e0;min-height:100vh;}
    ${sidebarCSS()}
    ${modalCSS()}
    .page{padding:28px 24px;}
    .card{background:#08091a;border:0.5px solid #0e1428;border-radius:10px;padding:22px;margin-bottom:18px;}
    label{font-size:0.75rem;color:#4a6080;display:block;margin-bottom:4px;}
    input,select{background:#fff;border:1.5px solid #3b82f6;color:#0f172a;border-radius:7px;padding:7px 10px;font-size:0.83rem;color-scheme:light;cursor:pointer;}
    .run-btn{background:#3b82f6;color:#fff;border:none;border-radius:8px;padding:9px 20px;font-weight:600;font-size:0.83rem;cursor:pointer;display:flex;align-items:center;gap:6px;}
    .run-btn:hover{background:#2563eb;}
    @keyframes slideIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}
    #err-toast{position:fixed;top:20px;right:20px;z-index:9999;background:#0d1320;border:1px solid #7f1d1d;border-left:4px solid #ef4444;border-radius:10px;padding:14px 18px;min-width:320px;max-width:480px;box-shadow:0 8px 32px rgba(0,0,0,0.5);animation:slideIn 0.25s ease;}
  </style></head>
  <body><div class="app-shell">${nav}<div class="main-content">
  <div id="err-toast">
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <span style="font-size:1.2rem;flex-shrink:0">⚠️</span>
      <div>
        <div style="font-weight:700;color:#ef4444;font-size:0.85rem;margin-bottom:4px">Backtest Failed</div>
        <div style="color:#8899aa;font-size:0.78rem;line-height:1.5">${errMsg}</div>
      </div>
      <span onclick="this.closest('#err-toast').remove()" style="margin-left:auto;color:#4a6080;font-size:1.1rem;cursor:pointer;flex-shrink:0;padding-left:8px">✕</span>
    </div>
  </div>
  <div class="page">
    <div style="margin-bottom:20px;">
      <div style="font-size:1.4rem;font-weight:700;color:#fff;margin-bottom:4px;">SAR_EMA9_RSI Backtest</div>
      <div style="font-size:0.78rem;color:#4a6080;">Fix the error above and run again.</div>
    </div>
    <div class="card">
      <div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap;">
        <div><label>FROM</label><input id="f" type="date" value="${from}"></div>
        <div><label>TO</label><input id="t" type="date" value="${to}"></div>
        <div><label>CANDLE</label><select id="r">${resOptions}</select></div>
        <button class="run-btn" onclick="(function(){var f=document.getElementById('f').value,t=document.getElementById('t').value,r=document.getElementById('r').value;if(!f||!t){showAlert({icon:'⚠️',title:'Missing Dates',message:'Set both From and To dates'});return;}window.location='/backtest?from='+f+'&to='+t+'&resolution='+r;})()">🔄 Run Again</button>
      </div>
    </div>
  </div>
  <script>
${modalJS()}
setTimeout(function(){var t=document.getElementById('err-toast');if(t)t.remove();},8000);</script>
  </div></div></body></html>`;
}

function errorPage(title, msg, from, to, resolution) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><link rel="icon" type="image/png" href="data:image/png;base64,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"/><title>${title}</title>
  <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:system-ui,sans-serif;background:#080c14;color:#c8d8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .box{background:#0d1320;border:1px solid #1a2236;border-radius:14px;padding:40px;max-width:520px;text-align:center;}
  h2{color:#ef4444;margin-bottom:12px;font-size:1.1rem;}p{font-size:0.83rem;color:#4a6080;margin-bottom:24px;line-height:1.6;}
  a{background:#3b82f6;color:#fff;padding:9px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.83rem;}
  </style></head><body><div class="box"><div style="font-size:2.5rem;margin-bottom:16px;">⚠️</div>
  <h2>${title}</h2><p>${msg}</p><a href="/">Back to Dashboard</a></div></body></html>`;
}

module.exports = router;
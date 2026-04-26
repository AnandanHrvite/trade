/**
 * PA PATTERN BACKTEST — /pa-pattern-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-pattern dashboard for the Price Action strategy. Runs the same engine
 * as /pa-backtest, but for each panel only ONE PA_PATTERN_* flag is enabled
 * (others forced false for the duration of that run). Lets you compare each
 * pattern's edge in isolation without manually toggling settings 8 times.
 *
 * Routes:
 *   GET /pa-pattern-backtest                         → dashboard (8 panels)
 *   GET /pa-pattern-backtest/run?pattern=…&from=…    → trigger one backtest
 *   GET /pa-pattern-backtest/idle                    → job-manager idle check
 *   GET /pa-pattern-backtest/stats?pattern=…         → JSON summary
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const paBacktestRoute = require("./paBacktest");
const runPABacktest   = paBacktestRoute.runPABacktest;
const vixFilter = require("../services/vixFilter");
const { VIX_SYMBOL } = vixFilter;
const { isExpiryDate } = require("../utils/nseHolidays");
const { saveResult, loadResult } = require("../utils/resultStore");
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");
const backtestJobs = require("../utils/backtestJobManager");

const PATTERNS = [
  { key: 'ENGULFING',     label: 'Engulfing',           color: { bg: 'rgba(59,130,246,0.12)',  fg: '#60a5fa', border: 'rgba(59,130,246,0.25)'  } },
  { key: 'PINBAR',        label: 'Pin Bar',             color: { bg: 'rgba(245,158,11,0.12)',  fg: '#fbbf24', border: 'rgba(245,158,11,0.25)'  } },
  { key: 'BOS',           label: 'Break of Structure',  color: { bg: 'rgba(16,185,129,0.12)',  fg: '#34d399', border: 'rgba(16,185,129,0.25)'  } },
  { key: 'INSIDE_BAR',    label: 'Inside Bar',          color: { bg: 'rgba(139,92,246,0.12)',  fg: '#a78bfa', border: 'rgba(139,92,246,0.25)'  } },
  { key: 'DOUBLE_TOP',    label: 'Double Top',          color: { bg: 'rgba(239,68,68,0.12)',   fg: '#f87171', border: 'rgba(239,68,68,0.25)'   } },
  { key: 'DOUBLE_BOTTOM', label: 'Double Bottom',       color: { bg: 'rgba(6,182,212,0.12)',   fg: '#22d3ee', border: 'rgba(6,182,212,0.25)'   } },
  { key: 'ASC_TRIANGLE',  label: 'Ascending Triangle',  color: { bg: 'rgba(249,115,22,0.12)',  fg: '#fb923c', border: 'rgba(249,115,22,0.25)'  } },
  { key: 'DESC_TRIANGLE', label: 'Descending Triangle', color: { bg: 'rgba(236,72,153,0.12)',  fg: '#f472b6', border: 'rgba(236,72,153,0.25)'  } },
];

const PATTERN_KEYS = PATTERNS.map(p => p.key);
const RESULT_KEY   = (p) => `PA_PAT_${p}`;

// ── Pattern flag override: enable only `pattern`, force others false ─────────
function applyPatternFilter(pattern) {
  const saved = {};
  for (const p of PATTERN_KEYS) {
    const env = `PA_PATTERN_${p}`;
    saved[env] = process.env[env];
    process.env[env] = (p === pattern) ? "true" : "false";
  }
  return function restore() {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

// ── Formatting helpers (mirror allBacktest panel) ────────────────────────────
const pts      = (n) => typeof n === "number" ? (n >= 0 ? "+" : "") + n.toFixed(2) + " pts" : "—";
const pnlColor = (n) => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";
const fmtPnl   = (n, s) => {
  if (typeof n !== "number") return "—";
  if (s && s.optionSim) return (n >= 0 ? "+" : "") + "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return pts(n);
};

function timeAgo(d) {
  if (!d || isNaN(d.getTime())) return "never";
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60)    return diffSec + "s ago";
  if (diffSec < 3600)  return Math.floor(diffSec / 60) + "m ago";
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + "h ago";
  return Math.floor(diffSec / 86400) + "d ago";
}

function renderStatsHtml(s) {
  if (!s) return `<div class="empty-state">No saved backtest yet. Use <b>Run</b> to start.</div>`;
  const pf  = s.profitFactor;
  const rec = s.recoveryFactor;
  const shp = s.sharpeRatio;
  const wrDisp = (typeof s.winRate === "number") ? (s.winRate + "%") : (s.winRate || "—");
  const hasExt = (typeof pf === "number") || (typeof shp === "number");
  const grid1 = `
    <div class="stat-grid">
      <div class="sc blue"><div class="sc-label">Total Trades</div><div class="sc-val">${s.totalTrades}</div><div class="sc-sub">${s.wins}W · ${s.losses}L</div></div>
      <div class="sc green"><div class="sc-label">Max Profit</div><div class="sc-val" style="color:#10b981;">${fmtPnl(s.maxProfit, s)}</div><div class="sc-sub">Best single trade</div></div>
      <div class="sc ${(s.totalPnl||0)>=0?"green":"red"}"><div class="sc-label">Total PnL</div><div class="sc-val" style="color:${pnlColor(s.totalPnl)};">${fmtPnl(s.totalPnl, s)}</div><div class="sc-sub">${s.optionSim ? `Option sim: δ=${s.delta} θ=₹${s.thetaPerDay}/day` : "Raw NIFTY index pts"}</div></div>
      <div class="sc red"><div class="sc-label">Max Drawdown</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.maxDrawdown, s)}</div><div class="sc-sub">Worst peak-to-trough</div></div>
      <div class="sc red"><div class="sc-label">Total Drawdown</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.totalDrawdown, s)}</div><div class="sc-sub">Sum of all losses</div></div>
      <div class="sc purple"><div class="sc-label">Risk/Reward</div><div class="sc-val">${s.riskReward||"—"}</div><div class="sc-sub">1 : avg win ÷ avg loss</div></div>
      <div class="sc yellow"><div class="sc-label">Win Rate</div><div class="sc-val">${wrDisp}</div><div class="sc-sub">${s.wins} wins of ${s.totalTrades}</div></div>
    </div>`;
  if (!hasExt) return grid1;
  const grid2 = `
    <div class="stat-grid-2">
      <div class="sc orange"><div class="sc-label">Profit Factor</div><div class="sc-val" style="color:${pf>=1.5?'#10b981':pf>=1?'#f59e0b':'#ef4444'};">${pf===null?'—':(pf===Infinity?'∞':pf)}</div><div class="sc-sub">Gross P ₹${Math.round(s.grossProfit||0).toLocaleString("en-IN")} / L ₹${Math.round(s.grossLoss||0).toLocaleString("en-IN")}</div></div>
      <div class="sc cyan"><div class="sc-label">Expectancy</div><div class="sc-val" style="color:${pnlColor(s.expectancy)};">${fmtPnl(s.expectancy, s)}</div><div class="sc-sub">Avg P&L per trade</div></div>
      <div class="sc red"><div class="sc-label">Max Loss</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.maxLoss, s)}</div><div class="sc-sub">Worst single trade</div></div>
      <div class="sc green"><div class="sc-label">Avg Win</div><div class="sc-val" style="color:#10b981;">${fmtPnl(s.avgWin, s)}</div><div class="sc-sub">${s.wins} winning trades</div></div>
      <div class="sc red"><div class="sc-label">Avg Loss</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.avgLoss, s)}</div><div class="sc-sub">${s.losses} losing trades</div></div>
      <div class="sc blue"><div class="sc-label">Recovery Factor</div><div class="sc-val" style="color:${rec>=2?'#10b981':rec>=1?'#f59e0b':'#ef4444'};">${rec==null?'—':rec}</div><div class="sc-sub">PnL ÷ Max DD</div></div>
      <div class="sc purple"><div class="sc-label">Sharpe Ratio</div><div class="sc-val" style="color:${shp>=1?'#10b981':shp>=0.5?'#f59e0b':'#ef4444'};">${shp==null?'—':shp}</div><div class="sc-sub">Annualized (daily)</div></div>
    </div>`;
  return grid1 + grid2;
}

function renderPanel(p, result) {
  const s = result && result.summary;
  const savedAt = result && result.savedAt;
  const params  = result && result.params;
  const ago = savedAt ? timeAgo(new Date(savedAt)) : "never";
  const paramsStr = params ? `${params.from} → ${params.to} · ${params.resolution}-min` : "—";

  return `
  <section class="panel" data-pattern="${p.key}">
    <div class="panel-head">
      <div class="panel-title">
        <span class="badge" style="background:${p.color.bg};color:${p.color.fg};border:0.5px solid ${p.color.border};">${p.label}</span>
        <span class="strategy-name" style="color:${p.color.fg};">PA_PATTERN_${p.key}</span>
        <span class="run-status" data-status></span>
      </div>
      <div class="panel-meta">
        <span class="meta-range" data-meta-range>${paramsStr}</span>
        <span class="meta-dot">·</span>
        <span class="meta-ago" data-meta-ago>${ago}</span>
        <button class="btn-copy" data-copy>📋 Copy Trades</button>
        <button class="btn-run" data-run>▶ Run</button>
      </div>
    </div>
    <div class="progress-line"><div class="bar"></div></div>
    <div class="panel-body" data-body>${renderStatsHtml(s)}</div>
  </section>`;
}

// ── JSON: idle / stats ───────────────────────────────────────────────────────
router.get("/idle", (req, res) => {
  res.json({ idle: backtestJobs.isIdle() });
});

router.get("/stats", (req, res) => {
  const pattern = String(req.query.pattern || "");
  if (!PATTERN_KEYS.includes(pattern)) return res.status(400).json({ error: "bad pattern" });
  const r = loadResult(RESULT_KEY(pattern));
  if (!r) return res.json({ exists: false });
  res.json({
    exists:  true,
    summary: r.summary || null,
    params:  r.params  || null,
    savedAt: r.savedAt || null,
  });
});

// ── JSON: trade rows for one pattern (or "ALL" for every enabled pattern) ────
// Returns the same TSV columns the regular /pa-backtest "Copy Trade Log"
// produces, so paste-targets (Sheets / chat) line up.
function buildTradeRows(pattern, trades) {
  const fmt2 = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const datePart = (dt) => {
    if (!dt) return "—";
    const p = String(dt).split(", ");
    const d = (p[0] || "").split("/");
    if (d.length === 3) return d[0].padStart(2,'0') + '/' + d[1].padStart(2,'0') + '/' + d[2];
    return p[0] || "—";
  };
  const timePart = (dt) => {
    if (!dt) return "—";
    const p = String(dt).split(", ");
    return p[1] || "—";
  };
  return trades.map(t => {
    const sl = (t.stopLoss && t.stopLoss !== "N/A") ? parseFloat(t.stopLoss) : null;
    const cols = [
      pattern,
      t.side || "",
      datePart(t.entryTime || ""),
      fmt2(t.entryPrice),
      timePart(t.entryTime || ""),
      fmt2(t.exitPrice),
      timePart(t.exitTime || ""),
      sl != null ? fmt2(sl) : "—",
      typeof t.pnl === "number" ? t.pnl.toFixed(2) : "—",
      String(t.entryReason || "—"),
      String(t.exitReason || "—"),
    ];
    return cols.join("\t");
  });
}

router.get("/trades", (req, res) => {
  const pattern = String(req.query.pattern || "");
  const header = "Pattern\tSide\tDate\tEntry\tEntry Time\tExit\tExit Time\tSL\tPnL\tEntry Reason\tExit Reason";

  if (pattern === "ALL") {
    const enabled = PATTERN_KEYS.filter(k => process.env[`PA_PATTERN_${k}`] === "true");
    const all = [];
    for (const k of enabled) {
      const r = loadResult(RESULT_KEY(k));
      if (r && Array.isArray(r.trades)) all.push(...buildTradeRows(k, r.trades));
    }
    return res.json({ tsv: [header, ...all].join("\n"), count: all.length, patterns: enabled });
  }

  if (!PATTERN_KEYS.includes(pattern)) return res.status(400).json({ error: "bad pattern" });
  const r = loadResult(RESULT_KEY(pattern));
  if (!r || !Array.isArray(r.trades)) return res.json({ tsv: header, count: 0 });
  const rows = buildTradeRows(pattern, r.trades);
  res.json({ tsv: [header, ...rows].join("\n"), count: rows.length });
});

// ── Trigger one pattern's backtest (background) ──────────────────────────────
router.get("/run", async (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE" ||
                     sharedSocketState.getMode() === "PA_LIVE" ||
                     sharedSocketState.getMode() === "SCALP_LIVE";
  if (liveActive) return res.status(503).json({ error: "live trading active" });
  if (!process.env.ACCESS_TOKEN) return res.status(401).json({ error: "not authenticated" });

  const pattern = String(req.query.pattern || "");
  if (!PATTERN_KEYS.includes(pattern)) return res.status(400).json({ error: "bad pattern" });
  if (typeof runPABacktest !== "function") {
    return res.status(500).json({ error: "runPABacktest not exported from paBacktest" });
  }

  const now = new Date();
  const defFrom = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-01';
  const defTo   = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
  const from       = req.query.from       || defFrom;
  const to         = req.query.to         || defTo;
  const resolution = req.query.resolution || process.env.PA_RESOLUTION || "5";
  const symbol     = "NSE:NIFTY50-INDEX";
  const capital    = parseInt(process.env.BACKTEST_CAPITAL || "100000", 10);

  const active = backtestJobs.getActiveJob();
  if (active) return res.json({ queued: true, message: "another backtest is running" });

  const { id } = backtestJobs.createJob('pa_pat_' + pattern.toLowerCase());

  (async () => {
    const restore = applyPatternFilter(pattern);
    try {
      backtestJobs.updateProgress(id, { phase: `[${pattern}] Fetching candles…`, pct: 0 });
      const onFetch = (p) => backtestJobs.updateProgress(id, p);
      const [candles, vixCandles] = await Promise.all([
        fetchCandlesCachedBT(symbol, resolution, from, to, false, onFetch),
        process.env.PA_VIX_ENABLED === "true"
          ? fetchCandlesCachedBT(VIX_SYMBOL, "D", from, to, false).catch(() => [])
          : Promise.resolve([]),
      ]);
      if (candles.length < 15) {
        backtestJobs.failJob(id, 'Too few candles. Try a wider date range.');
        return;
      }

      let expiryDates = null;
      if ((process.env.PA_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
        const uniqueDates = [...new Set(candles.map(c => new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })))];
        const expirySet = new Set();
        for (const d of uniqueDates) { if (await isExpiryDate(d)) expirySet.add(d); }
        expiryDates = expirySet;
      }

      backtestJobs.updateProgress(id, { phase: `[${pattern}] Running backtest…`, pct: 5, current: 0, total: candles.length - 30 });
      const result = await runPABacktest(candles, capital, vixCandles, expiryDates,
        (p) => backtestJobs.updateProgress(id, p));
      result.candleCount = candles.length;
      saveResult(RESULT_KEY(pattern), { ...result, params: { from, to, resolution, symbol, capital, pattern } });
      backtestJobs.completeJob(id, result);
      console.log(`✅ PA pattern backtest [${pattern}] done — ${result.trades.length} trades`);
    } catch (err) {
      console.error('[PA Pattern Backtest Error]', err);
      backtestJobs.failJob(id, err.message || String(err));
    } finally {
      restore();
    }
  })();

  res.json({ jobId: id, started: true });
});

// ── Dashboard page ───────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";

  const now = new Date();
  const defFrom = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-01';
  const defTo   = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
  const from       = req.query.from       || defFrom;
  const to         = req.query.to         || defTo;
  const resolution = req.query.resolution || process.env.PA_RESOLUTION || "5";

  // Only render panels for patterns currently enabled in settings
  // (PA_PATTERN_<KEY>=true). Disabled patterns are hidden so this page
  // mirrors what your live/paper run will actually use.
  const enabledPatterns = PATTERNS.filter(p => process.env[`PA_PATTERN_${p.key}`] === "true");
  const panelsHtml = enabledPatterns.length
    ? enabledPatterns.map(p => renderPanel(p, loadResult(RESULT_KEY(p.key)))).join('\n')
    : `<div class="empty-state" style="padding:40px;">No PA patterns enabled in settings. Toggle <b>PA_PATTERN_*</b> on in <a href="/settings#pa" style="color:#60a5fa;">Settings</a> to see panels here.</div>`;
  const disabledList = PATTERNS.filter(p => process.env[`PA_PATTERN_${p.key}`] !== "true").map(p => p.label).join(', ');

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>△</text></svg>">
<title>PA Pattern Backtest — Per-Pattern Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;min-height:100vh;}
  .page{padding:16px 20px 40px;}

  .crumb{background:#06090e;border-bottom:0.5px solid #0e1428;padding:6px 20px;display:flex;align-items:center;gap:7px;margin:-16px -20px 14px;position:sticky;top:44px;z-index:90;flex-wrap:wrap;}
  .crumb .pill{font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;text-transform:uppercase;letter-spacing:0.5px;font-family:'IBM Plex Mono',monospace;}
  .crumb .pill-pa{background:rgba(139,92,246,0.12);color:#a78bfa;border:0.5px solid rgba(139,92,246,0.25);}
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
  .btn-copy{background:#0d1f17;border:1px solid #1a3a26;color:#34d399;padding:4px 10px;border-radius:5px;font-size:0.68rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;}
  .btn-copy:hover{background:#0a2d1e;border-color:#10b981;}
  .btn-copy.copied,#copyAllBtn.copied{background:#0a3a23 !important;color:#86efac !important;border-color:#10b981 !important;}

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

  /* ── Light theme overrides (mirror allBacktest) ── */
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
${buildSidebar('paPatternBacktest', liveActive)}
<div class="main-content">
<div class="page">

  <div class="crumb">
    <span class="pill pill-pa">PA PATTERN BACKTEST</span>
    <span style="color:#1e2a40;font-size:10px;">›</span>
    <span class="pill pill-range" id="crumbRange">${from} → ${to}</span>
    <span style="margin-left:auto;font-size:0.6rem;color:#1e2a40;font-family:'IBM Plex Mono',monospace;">8 patterns · each runs in isolation · same engine as /pa-backtest</span>
  </div>

  <!-- Settings form -->
  <div class="run-bar">
    <div><label>From</label><input type="date" id="f" value="${from}"/></div>
    <div><label>To</label><input type="date" id="t" value="${to}"/></div>
    <div><label>PA Candle</label>
      <select id="paRes">
        <option value="3" ${resolution==="3"?"selected":""}>3-min</option>
        <option value="5" ${resolution==="5"?"selected":""}>5-min</option>
      </select>
    </div>
    <button class="run-btn" id="runAllBtn">▶▶ Run All Patterns</button>
    <button class="run-btn" id="copyAllBtn" style="background:#0f3a26;color:#34d399;border-color:#1f7a4d;">📋 Copy All Trades</button>
    <button class="run-btn" id="cancelBtn" style="background:#3a1a1a;color:#f87171;border-color:#7f1d1d;display:none;">✕ Cancel</button>
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

  ${panelsHtml}

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
  } else if(/^y\\d{4}$/.test(p)){
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
  document.getElementById('crumbRange').textContent = fromVal + ' → ' + toVal;
}

function pts(n){ return typeof n==='number' ? ((n>=0?'+':'')+n.toFixed(2)+' pts') : '—'; }
function pnlColor(n){ return (typeof n==='number' && n>=0) ? '#10b981' : '#ef4444'; }
function fmtPnl(n,s){
  if(typeof n!=='number') return '—';
  if(s && s.optionSim) return (n>=0?'+':'')+'₹'+Math.abs(n).toLocaleString('en-IN',{maximumFractionDigits:0});
  return pts(n);
}
function renderStats(s){
  if(!s) return '<div class="empty-state">No saved backtest yet.</div>';
  var pf  = s.profitFactor;
  var rec = s.recoveryFactor;
  var shp = s.sharpeRatio;
  var wrDisp = (typeof s.winRate === 'number') ? (s.winRate + '%') : (s.winRate || '—');
  var hasExt = (typeof pf === 'number') || (typeof shp === 'number');
  var grid1 = '<div class="stat-grid">'
    +   '<div class="sc blue"><div class="sc-label">Total Trades</div><div class="sc-val">'+s.totalTrades+'</div><div class="sc-sub">'+s.wins+'W · '+s.losses+'L</div></div>'
    +   '<div class="sc green"><div class="sc-label">Max Profit</div><div class="sc-val" style="color:#10b981;">'+fmtPnl(s.maxProfit,s)+'</div><div class="sc-sub">Best single trade</div></div>'
    +   '<div class="sc '+((s.totalPnl||0)>=0?'green':'red')+'"><div class="sc-label">Total PnL</div><div class="sc-val" style="color:'+pnlColor(s.totalPnl)+';">'+fmtPnl(s.totalPnl,s)+'</div><div class="sc-sub">'+(s.optionSim?('Option sim: δ='+s.delta+' θ=₹'+s.thetaPerDay+'/day'):'Raw NIFTY index pts')+'</div></div>'
    +   '<div class="sc red"><div class="sc-label">Max Drawdown</div><div class="sc-val" style="color:#ef4444;">'+fmtPnl(s.maxDrawdown,s)+'</div><div class="sc-sub">Worst peak-to-trough</div></div>'
    +   '<div class="sc red"><div class="sc-label">Total Drawdown</div><div class="sc-val" style="color:#ef4444;">'+fmtPnl(s.totalDrawdown,s)+'</div><div class="sc-sub">Sum of all losses</div></div>'
    +   '<div class="sc purple"><div class="sc-label">Risk/Reward</div><div class="sc-val">'+(s.riskReward||'—')+'</div><div class="sc-sub">1 : avg win ÷ avg loss</div></div>'
    +   '<div class="sc yellow"><div class="sc-label">Win Rate</div><div class="sc-val">'+wrDisp+'</div><div class="sc-sub">'+s.wins+' wins of '+s.totalTrades+'</div></div>'
    + '</div>';
  if(!hasExt) return grid1;
  var grid2 = '<div class="stat-grid-2">'
    +   '<div class="sc orange"><div class="sc-label">Profit Factor</div><div class="sc-val" style="color:'+(pf>=1.5?'#10b981':pf>=1?'#f59e0b':'#ef4444')+';">'+(pf==null?'—':(pf===Infinity?'∞':pf))+'</div><div class="sc-sub">Gross P ₹'+Math.round(s.grossProfit||0).toLocaleString('en-IN')+' / L ₹'+Math.round(s.grossLoss||0).toLocaleString('en-IN')+'</div></div>'
    +   '<div class="sc cyan"><div class="sc-label">Expectancy</div><div class="sc-val" style="color:'+pnlColor(s.expectancy)+';">'+fmtPnl(s.expectancy,s)+'</div><div class="sc-sub">Avg P&amp;L per trade</div></div>'
    +   '<div class="sc red"><div class="sc-label">Max Loss</div><div class="sc-val" style="color:#ef4444;">'+fmtPnl(s.maxLoss,s)+'</div><div class="sc-sub">Worst single trade</div></div>'
    +   '<div class="sc green"><div class="sc-label">Avg Win</div><div class="sc-val" style="color:#10b981;">'+fmtPnl(s.avgWin,s)+'</div><div class="sc-sub">'+s.wins+' winning trades</div></div>'
    +   '<div class="sc red"><div class="sc-label">Avg Loss</div><div class="sc-val" style="color:#ef4444;">'+fmtPnl(s.avgLoss,s)+'</div><div class="sc-sub">'+s.losses+' losing trades</div></div>'
    +   '<div class="sc blue"><div class="sc-label">Recovery Factor</div><div class="sc-val" style="color:'+(rec>=2?'#10b981':rec>=1?'#f59e0b':'#ef4444')+';">'+(rec==null?'—':rec)+'</div><div class="sc-sub">PnL ÷ Max DD</div></div>'
    +   '<div class="sc purple"><div class="sc-label">Sharpe Ratio</div><div class="sc-val" style="color:'+(shp>=1?'#10b981':shp>=0.5?'#f59e0b':'#ef4444')+';">'+(shp==null?'—':shp)+'</div><div class="sc-sub">Annualized (daily)</div></div>'
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

// ── Run a single pattern (returns Promise) ───────────────────────────────────
function runPattern(panel, opts){
  var pattern = panel.dataset.pattern;
  var url = '/pa-pattern-backtest/run?pattern=' + encodeURIComponent(pattern)
          + '&from=' + encodeURIComponent(opts.from)
          + '&to='   + encodeURIComponent(opts.to)
          + '&resolution=' + encodeURIComponent(opts.resolution);

  setStatus(panel, 'running', 'running…');

  return new Promise(function(resolve){
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
              : 'Server rejected the request. Check the server logs for details.',
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

    setTimeout(function tick(){
      var st = panel.querySelector('[data-status]');
      if(st && st.classList.contains('error')) return;
      if(opts.cancelled && opts.cancelled()){
        setStatus(panel, 'idle', '');
        resolve({ cancelled: true });
        return;
      }
      fetch('/pa-pattern-backtest/idle', { cache: 'no-store' })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if(d && d.idle){
            fetch('/pa-pattern-backtest/stats?pattern=' + encodeURIComponent(pattern), { cache: 'no-store' })
              .then(function(r){ return r.json(); })
              .then(function(js){
                if(js && js.exists){
                  panel.querySelector('[data-body]').innerHTML = renderStats(js.summary);
                  if(js.params){
                    panel.querySelector('[data-meta-range]').textContent =
                      js.params.from + ' → ' + js.params.to + ' · ' + js.params.resolution + '-min';
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
  var resolution = document.getElementById('paRes').value;

  RUN_STATE.active = true; RUN_STATE.cancel = false;
  document.getElementById('runAllBtn').disabled = true;
  document.getElementById('cancelBtn').style.display = '';
  document.getElementById('runAllStatus').textContent = 'Running 8 patterns sequentially…';
  document.getElementById('crumbRange').textContent = from + ' → ' + to;

  var panels = Array.prototype.slice.call(document.querySelectorAll('.panel'));
  panels.forEach(function(p){ setStatus(p, 'queued', 'queued'); });

  (function next(i, authAborted){
    if(i >= panels.length || RUN_STATE.cancel || authAborted){
      RUN_STATE.active = false;
      document.getElementById('runAllBtn').disabled = false;
      document.getElementById('cancelBtn').style.display = 'none';
      document.getElementById('runAllStatus').textContent =
        authAborted      ? 'Stopped — not authenticated. Login with Fyers and try again.' :
        RUN_STATE.cancel ? 'Cancelled (current run finishes in background).'
                         : 'All done.';
      panels.forEach(function(p){
        var st = p.querySelector('[data-status]');
        if(st && st.classList.contains('queued')) setStatus(p, 'idle', '');
      });
      return;
    }
    runPattern(panels[i], { from: from, to: to, resolution: resolution, cancelled: function(){ return RUN_STATE.cancel; } })
      .then(function(result){ next(i + 1, result && result.authError); });
  })(0);
});

document.getElementById('cancelBtn').addEventListener('click', function(){
  RUN_STATE.cancel = true;
  document.getElementById('runAllStatus').textContent = 'Cancelling… (current run finishes in background)';
});

// ── Clipboard copy (per-panel + global) ──────────────────────────────────────
function doCopy(text, btn, origLabel){
  function onOk(){
    btn.classList.add('copied');
    btn.textContent = '✅ Copied!';
    setTimeout(function(){ btn.classList.remove('copied'); btn.textContent = origLabel; }, 2000);
  }
  function fallback(){
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    onOk();
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(onOk).catch(fallback);
  } else { fallback(); }
}

document.querySelectorAll('[data-copy]').forEach(function(btn){
  btn.addEventListener('click', function(){
    var panel = btn.closest('.panel');
    var pattern = panel.dataset.pattern;
    var orig = btn.textContent;
    btn.textContent = '⏳ …';
    fetch('/pa-pattern-backtest/trades?pattern=' + encodeURIComponent(pattern), { cache:'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(!d || d.count === 0){
          btn.textContent = '∅ No trades';
          setTimeout(function(){ btn.textContent = orig; }, 1800);
          return;
        }
        doCopy(d.tsv, btn, '📋 Copy Trades');
      })
      .catch(function(){
        btn.textContent = '⚠ Failed';
        setTimeout(function(){ btn.textContent = orig; }, 1800);
      });
  });
});

document.getElementById('copyAllBtn').addEventListener('click', function(){
  var btn = this;
  var orig = btn.textContent;
  btn.textContent = '⏳ Loading…';
  fetch('/pa-pattern-backtest/trades?pattern=ALL', { cache:'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!d || d.count === 0){
        btn.textContent = '∅ No trades yet';
        setTimeout(function(){ btn.textContent = orig; }, 2000);
        return;
      }
      doCopy(d.tsv, btn, '📋 Copy All Trades');
    })
    .catch(function(){
      btn.textContent = '⚠ Copy failed';
      setTimeout(function(){ btn.textContent = orig; }, 2000);
    });
});

// ── Individual panel Run buttons ─────────────────────────────────────────────
document.querySelectorAll('[data-run]').forEach(function(btn){
  btn.addEventListener('click', function(){
    if(RUN_STATE.active) return;
    var panel = btn.closest('.panel');
    var from = document.getElementById('f').value;
    var to   = document.getElementById('t').value;
    if(!from || !to){ alert('Pick From and To dates'); return; }
    var resolution = document.getElementById('paRes').value;

    RUN_STATE.active = true;
    document.getElementById('runAllBtn').disabled = true;
    runPattern(panel, { from: from, to: to, resolution: resolution, cancelled: function(){ return false; } })
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

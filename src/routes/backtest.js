/**
 * BACKTEST — /backtest — the ONE backtest page
 * ─────────────────────────────────────────────────────────────────────────────
 * Pick a strategy and a market, a date range (presets or custom), the candle
 * size where the strategy lets you, and current or custom settings; run; read
 * the results; re-open any saved run. Every run goes through the strategy's
 * OWN backtest engine (services/backtestPage.js has the dispatch and the hook
 * each backtest module exports). The old per-strategy pages keep working.
 *
 *   GET /backtest                  the form + saved runs
 *   GET /backtest/options.json     markets, candle sizes and settings for a strategy/market
 *   GET /backtest/run?…            start a run → progress page → saved result
 *   GET /backtest/status?jobId=    polled by the progress page
 *   GET /backtest/idle             polled by the queue page
 *   GET /backtest/result/:id       a saved run (re-openable)
 *   GET /backtest/result/:id.json  the same run as JSON
 * Cancel is the shared POST /backtest/cancel in app.js.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();

const page         = require("../services/backtestPage");
const backtestJobs = require("../utils/backtestJobManager");
const resultStore  = require("../utils/resultStore");
const { renderBacktestResults } = require("../utils/backtestUI");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, clearCacheButtonHTML, clearCacheJS } = require("../utils/sharedNav");
const { resolveTheme } = require("../utils/theme");

const TITLE = "Backtest";

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function jsonTag(id, data) {
  return `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}
function istToday() { return new Date(Date.now() + 19800000).toISOString().slice(0, 10); }

/** The query that reruns this exact request (Run Again / New backtest links). */
function runQuery(p, withDates) {
  const q = new URLSearchParams();
  q.set("strategy", p.strategy || p.strategyId);
  q.set("market", p.market);
  if (p.resolution) q.set("resolution", p.resolution);
  q.set("settings", p.settingsSource || "current");
  if ((p.settingsSource || "current") === "custom") {
    const custom = p.custom || {};
    for (const s of p.settings || []) if (s.source === "custom") custom[s.key] = s.value;
    for (const k of Object.keys(custom)) q.set(`s.${k}`, custom[k]);
  }
  if (withDates) { q.set("from", p.from); q.set("to", p.to); }
  return q.toString();
}

// ── Shared page chrome ───────────────────────────────────────────────────────
const PAGE_CSS = `
*{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#060810;--card:#08091a;--line:#0e1428;--line2:#1a2236;--text:#c8d8f0;--body:#a0b8d8;--muted:#8ba1c2;--muted2:#6d85a8;--accent:#3b82f6;--accent2:#60a5fa;--good:#10b981;--bad:#ef4444;--warn:#f59e0b;--input:#0d1320;--head:#04060e;--hover:#060c1a;}
:root[data-theme="light"]{--bg:#f5f6fa;--card:#ffffff;--line:#e0e4ea;--line2:#d5dbe4;--text:#0f172a;--body:#1e293b;--muted:#475569;--muted2:#5c6b7f;--accent:#2563eb;--accent2:#1d4ed8;--good:#059669;--bad:#dc2626;--warn:#b45309;--input:#ffffff;--head:#f1f5f9;--hover:#f8fafc;}
html{-webkit-text-size-adjust:100%;}
body{font-family:'IBM Plex Mono',ui-monospace,monospace;background:var(--bg);color:var(--body);overflow-x:hidden;min-height:100vh;}
${sidebarCSS()}
${modalCSS()}
.main-content{flex:1;margin-left:200px;min-width:0;min-height:100vh;}
.page{padding:0 20px 40px;}
@media(max-width:768px){.main-content{margin-left:0;}.page{padding:0 max(12px,env(safe-area-inset-right)) 40px max(12px,env(safe-area-inset-left));}}
.crumb{position:sticky;top:0;z-index:90;display:flex;align-items:center;gap:7px;flex-wrap:wrap;background:var(--bg);border-bottom:0.5px solid var(--line);padding:8px 20px;margin:0 -20px 14px;}
@media(max-width:768px){.crumb{margin:0 -12px 12px;padding:8px 12px 8px 52px;}}
.tag{font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;}
.tag.b{background:rgba(59,130,246,0.13);color:var(--accent2);border:0.5px solid rgba(59,130,246,0.35);}
.tag.g{background:rgba(16,185,129,0.1);color:#34d399;border:0.5px solid rgba(16,185,129,0.25);}
.tag.y{background:rgba(245,158,11,0.1);color:#fbbf24;border:0.5px solid rgba(245,158,11,0.25);}
:root[data-theme="light"] .tag.g{color:#047857;} :root[data-theme="light"] .tag.y{color:#b45309;}
.sep{color:var(--muted2);font-size:10px;}
.crumb .meta{margin-left:auto;font-size:0.6rem;color:var(--muted2);}
h1{font-size:1rem;color:var(--text);margin-bottom:2px;}
.sub{color:var(--muted);font-size:0.7rem;margin-bottom:14px;line-height:1.5;}
.panel{background:var(--card);border:0.5px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:14px;}
.panel-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;}
.panel-h h2{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted2);}
.run-bar{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end;}
.fld label,.lbl{display:block;font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:4px;}
select,input[type=date],input[type=number],input[type=text],input[type=time],input[type=search]{width:100%;min-height:36px;background:var(--input);color:var(--text);border:1px solid var(--line2);border-radius:6px;padding:6px 9px;font:inherit;font-size:0.76rem;}
:root:not([data-theme="light"]) input[type=date],:root:not([data-theme="light"]) input[type=time]{color-scheme:dark;}
select:focus,input:focus{outline:none;border-color:var(--accent);}
.fixed{min-height:36px;display:flex;align-items:center;font-size:0.72rem;color:var(--muted);border:1px dashed var(--line2);border-radius:6px;padding:0 9px;}
.hint{font-size:0.64rem;color:var(--muted);line-height:1.5;margin-top:4px;}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px;}
.run-btn{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 18px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;font-size:0.74rem;font-weight:700;cursor:pointer;white-space:nowrap;text-decoration:none;}
.run-btn:hover{filter:brightness(1.12);} .run-btn:disabled{opacity:0.5;cursor:not-allowed;}
.ghost{background:var(--input);color:var(--accent2);border:1px solid var(--line2);}
.ghost:hover{border-color:var(--accent);}
.ck{display:inline-flex;align-items:center;gap:6px;font-size:0.68rem;color:var(--muted);cursor:pointer;white-space:nowrap;min-height:36px;}
.ck input{width:16px;height:16px;accent-color:var(--accent);cursor:pointer;}
.presets{margin-top:12px;display:flex;flex-direction:column;gap:6px;}
.preset-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.preset-row .rl{font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted2);min-width:52px;}
.preset-btn{font:inherit;font-size:0.65rem;padding:4px 10px;border-radius:4px;background:rgba(59,130,246,0.08);color:var(--accent2);border:0.5px solid rgba(59,130,246,0.22);cursor:pointer;min-height:28px;}
.preset-btn:hover{background:rgba(59,130,246,0.18);}
.preset-btn.on{background:var(--accent);color:#fff;border-color:var(--accent);}
.preset-btn:disabled{opacity:0.3;cursor:not-allowed;}
.range-info{font-size:0.66rem;color:var(--muted);margin-top:8px;}
.range-info b{color:var(--text);}
.split{display:none;margin-top:12px;border:0.5px dashed var(--line2);border-radius:8px;padding:10px 12px;}
.split.on{display:block;}
.split-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}
.split-list a{font-size:0.66rem;padding:5px 10px;border-radius:5px;border:1px solid var(--line2);color:var(--accent2);text-decoration:none;min-height:30px;display:inline-flex;align-items:center;}
.split-list a:hover{border-color:var(--accent);}
.split-list a.opened{border-color:var(--good);color:var(--good);}
.seg{display:inline-flex;border:1px solid var(--line2);border-radius:6px;overflow:hidden;}
.seg label{display:flex;align-items:center;gap:6px;padding:0 12px;min-height:34px;font-size:0.7rem;cursor:pointer;color:var(--muted);}
.seg label+label{border-left:1px solid var(--line2);}
.seg input{position:absolute;opacity:0;pointer-events:none;}
.seg label.on{background:rgba(59,130,246,0.15);color:var(--accent2);font-weight:700;}
.ftools{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;margin-top:10px;}
.gchips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}
.fgroup{margin-top:12px;}
.fgroup h3{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted2);margin-bottom:4px;}
.frow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,200px);gap:10px;align-items:center;padding:6px 0;border-top:0.5px solid var(--line);}
.frow .fl{font-size:0.72rem;line-height:1.35;color:var(--text);word-break:break-word;}
.frow .fk{display:block;font-size:0.56rem;color:var(--muted2);word-break:break-all;}
.frow .fd{display:block;font-size:0.6rem;color:var(--muted);margin-top:2px;}
.frow.changed .fl{color:var(--warn);}
.frow.changed .fl::after{content:" • changed";font-size:0.58rem;}
.badge{display:inline-block;font-size:0.54rem;padding:1px 6px;border-radius:4px;border:0.5px solid var(--line2);color:var(--muted);margin-left:4px;vertical-align:middle;}
.tog{display:flex;align-items:center;justify-content:flex-end;min-height:36px;}
.tog input{width:20px;height:20px;accent-color:var(--accent);}
.err{background:rgba(239,68,68,0.1);border:1px solid var(--bad);color:var(--bad);border-radius:8px;padding:10px 14px;font-size:0.74rem;margin-bottom:14px;line-height:1.5;word-break:break-word;}
.tbar{display:grid;grid-template-columns:minmax(160px,1.4fr) repeat(5,minmax(110px,1fr));gap:8px;margin-bottom:10px;}
.cnt{font-size:0.64rem;color:var(--muted);margin-left:auto;}
.tw{border:0.5px solid var(--line);border-radius:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;}
table{width:100%;border-collapse:collapse;}
thead th{background:var(--head);padding:7px 10px;text-align:left;font-size:0.56rem;text-transform:uppercase;letter-spacing:0.8px;color:var(--muted2);white-space:nowrap;cursor:pointer;user-select:none;}
thead th.sorted{color:var(--accent2);}
th.r,td.r{text-align:right;}
tbody tr{border-top:0.5px solid var(--line);cursor:pointer;}
tbody tr:hover{background:var(--hover);}
tbody td{padding:7px 10px;font-size:0.7rem;color:var(--muted);white-space:nowrap;}
tbody td.s{color:var(--text);font-weight:700;}
tfoot td{padding:8px 10px;font-size:0.7rem;font-weight:700;border-top:1px solid var(--line2);background:var(--head);color:var(--text);white-space:nowrap;}
td a{color:inherit;text-decoration:none;}
.pos{color:var(--good) !important;} .neg{color:var(--bad) !important;}
.pill{font-size:0.56rem;padding:1px 6px;border-radius:3px;border:0.5px solid var(--line2);}
.pill.c{color:var(--warn);border-color:rgba(245,158,11,0.4);}
.empty{font-size:0.72rem;color:var(--muted);padding:16px;text-align:center;}
@media(max-width:900px){.tbar{grid-template-columns:1fr 1fr 1fr;}.tbar .q{grid-column:1/-1;}}
@media(max-width:640px){
  select,input[type=date],input[type=number],input[type=text],input[type=time],input[type=search],.run-btn,.fixed,.ck,.seg label,.preset-btn,.split-list a{min-height:44px;}
  .run-bar{grid-template-columns:1fr 1fr;}
  .run-bar .wide{grid-column:1/-1;}
  .actions .run-btn{flex:1 1 100%;}
  .frow{grid-template-columns:1fr;} .tog{justify-content:flex-start;}
  .ftools{grid-template-columns:1fr 1fr;} .ftools .q{grid-column:1/-1;}
  .tbar{grid-template-columns:1fr 1fr;}
  .crumb .meta{display:none;}
  .runs-tw{border:0;overflow:visible;}
  .runs-tw thead{display:none;}
  .runs-tw table,.runs-tw tbody,.runs-tw tfoot,.runs-tw tr,.runs-tw td{display:block;width:100%;}
  .runs-tw tbody tr{border:0.5px solid var(--line);border-radius:8px;margin-bottom:10px;padding:6px 12px;background:var(--card);}
  .runs-tw tbody td,.runs-tw tfoot td{display:flex;justify-content:space-between;gap:12px;padding:5px 0;white-space:normal;text-align:right;}
  .runs-tw tbody td::before,.runs-tw tfoot td::before{content:attr(data-label);color:var(--muted2);font-size:0.58rem;text-transform:uppercase;letter-spacing:0.6px;text-align:left;}
  .runs-tw tfoot tr{border-radius:8px;overflow:hidden;}
  .runs-tw tfoot td:empty{display:none;}
}
`;

function shell(activeTitle, body, extraHead = "") {
  const theme = resolveTheme();
  return `<!DOCTYPE html>
<html lang="en"${theme === "light" ? ' data-theme="light"' : ""}>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
${faviconLink()}
<title>${esc(activeTitle)}</title>
<style>${PAGE_CSS}</style>
${extraHead}
</head>
<body>
<div class="app-shell">
${buildSidebar("backtest", false)}
<div class="main-content"><div class="page">
${body}
</div></div></div>
</body></html>`;
}

// ── The form ─────────────────────────────────────────────────────────────────
function renderForm(q, error) {
  const strategies = page.strategies();
  const ready = strategies.filter((s) => s.ready);
  const sel = ready.find((s) => s.id === q.strategy) || ready[0] || null;
  const today = istToday();
  const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
  let from = okDate(q.from) ? q.from : `${today.slice(0, 8)}01`;
  let to = okDate(q.to) ? q.to : today;
  if (to > today) to = today;
  if (from > to) from = to;
  const init = {
    strategy: sel ? sel.id : "",
    market: String(q.market || "NIFTY").toUpperCase(),
    from, to, today,
    resolution: q.resolution || "",
    settings: q.settings === "custom" ? "custom" : "current",
    custom: {},
  };
  for (const k of Object.keys(q || {})) if (k.startsWith("s.")) init.custom[k.slice(2)] = String(q[k]);
  const catalog = {};
  for (const s of strategies) {
    catalog[s.id] = s.ready
      ? { label: s.label, ready: true, markets: page.marketOptions(s.id), resolution: page.resolutionOptions(s.id), oldPage: s.oldPage }
      : { label: s.label, ready: false, markets: [], resolution: null, oldPage: s.oldPage };
  }
  const runs = resultStore.listRuns(Infinity);
  const cy = Number(today.slice(0, 4)), cm = Number(today.slice(5, 7));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pb = (k, l, dis) => `<button type="button" class="preset-btn" data-p="${k}"${dis ? " disabled" : ""}>${l}</button>`;

  const body = `
<div class="crumb">
  <span class="tag b">Backtest</span><span class="sep">›</span>
  <span class="tag g" id="cStrat">${esc(sel ? sel.label : "—")}</span><span class="sep">›</span>
  <span class="tag y" id="cMkt">${esc(init.market)}</span><span class="sep">›</span>
  <span class="tag y" id="cDates">${esc(init.from)} → ${esc(init.to)}</span>
  <span class="meta">${runs.length} saved run(s)</span>
</div>
<h1>🧪 Backtest</h1>
<p class="sub">Pick a strategy, market and dates, then run. Long ranges can be split by year or month — each part opens in its own tab.</p>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<form class="panel" id="btForm" novalidate>
  <div class="run-bar">
    <div class="fld wide"><label for="strategy">Strategy</label>
      <select id="strategy" name="strategy">${strategies.map((s) => `<option value="${esc(s.id)}"${!s.ready ? " disabled" : ""}${sel && s.id === sel.id ? " selected" : ""}>${esc(s.label)}${s.ready ? "" : " — not on this page yet"}</option>`).join("")}</select></div>
    <div class="fld"><label for="market">Market</label><select id="market" name="market"></select></div>
    <div class="fld"><label for="resolution">Candle</label><div id="resWrap"></div></div>
    <div class="fld"><label for="from">From</label><input type="date" id="from" value="${esc(init.from)}" max="${esc(today)}"/></div>
    <div class="fld"><label for="to">To</label><input type="date" id="to" value="${esc(init.to)}" max="${esc(today)}"/></div>
  </div>
  <div class="hint" id="marketHint"></div>
  <div class="presets" role="group" aria-label="Date presets">
    <div class="preset-row"><span class="rl">Quick</span>${[["thisWeek", "This week"], ["lastWeek", "Last week"], ["thisMonth", "This month"], ["lastMonth", "Last month"], ["last3", "Last 3 months"], ["last6", "Last 6 months"], ["thisYear", "This year"], ["lastYear", "Last year"]].map(([k, l]) => pb(k, l)).join("")}</div>
    <div class="preset-row"><span class="rl">Years</span>${[["last2y", "Last 2 yr"], ["last3y", "Last 3 yr"], ["last5y", "Last 5 yr"]].map(([k, l]) => pb(k, l)).join("")}${Array.from({ length: 6 }, (_, i) => cy - i).map((y) => pb(`y${y}`, String(y))).join("")}</div>
    <div class="preset-row"><span class="rl">${cy}</span>${MONTHS.map((l, i) => pb(`m${i}`, l, i + 1 > cm)).join("")}</div>
  </div>
  <div class="range-info" id="rangeInfo"></div>
  <div class="actions">
    <span class="lbl" style="margin:0;">Split</span>
    <label class="ck"><input type="radio" name="split" value="none" checked/> One run</label>
    <label class="ck"><input type="radio" name="split" value="year"/> By years</label>
    <label class="ck"><input type="radio" name="split" value="month"/> By months</label>
  </div>
  <div class="split" id="splitBox">
    <div class="hint" id="splitHint"></div>
    <div class="split-list" id="splitList"></div>
  </div>

  <div class="panel-h" style="margin-top:16px;">
    <h2>Settings</h2>
    <div class="seg" role="radiogroup" aria-label="Settings source">
      <label${init.settings === "current" ? ' class="on"' : ""}><input type="radio" name="settings" value="current"${init.settings === "current" ? " checked" : ""}/> Current</label>
      <label${init.settings === "custom" ? ' class="on"' : ""}><input type="radio" name="settings" value="custom"${init.settings === "custom" ? " checked" : ""}/> Custom</label>
    </div>
  </div>
  <div class="hint" id="srcHint" style="margin-top:0;"></div>
  <div id="customWrap" style="display:none;">
    <div class="ftools">
      <input type="search" class="q" id="fq" placeholder="Search settings…" aria-label="Search settings"/>
      <label class="ck"><input type="checkbox" id="fChanged"/> Changed only</label>
      <button type="button" class="run-btn ghost" id="resetBtn">Reset</button>
    </div>
    <div class="gchips" id="gchips"></div>
    <div class="hint" id="chgCount"></div>
    <div id="fields"></div>
  </div>

  <div class="actions" style="margin-top:16px;">
    <button type="submit" class="run-btn" id="runBtn">▶ Run backtest</button>
    ${clearCacheButtonHTML()}
    <span class="hint" style="margin:0;">One backtest runs at a time; extra tabs wait in a queue and start by themselves.</span>
  </div>
</form>

<div class="panel">
  <div class="panel-h"><h2>Saved runs</h2><span class="cnt" id="runCnt"></span></div>
  ${runs.length ? `
  <div class="tbar">
    <input type="search" class="q" id="rq" placeholder="Search strategy, market, date…" aria-label="Search saved runs"/>
    <select id="rStrat" aria-label="Strategy"><option value="">All strategies</option>${[...new Set(runs.map((r) => r.strategyLabel))].sort().map((l) => `<option>${esc(l)}</option>`).join("")}</select>
    <select id="rMkt" aria-label="Market"><option value="">All markets</option>${[...new Set(runs.map((r) => r.marketLabel || r.market))].sort().map((l) => `<option>${esc(l)}</option>`).join("")}</select>
    <select id="rRes" aria-label="Result"><option value="">All results</option><option value="win">Profit</option><option value="loss">Loss</option><option value="none">No trades</option></select>
    <select id="rSrc" aria-label="Settings"><option value="">All settings</option><option value="current">Current</option><option value="custom">Custom</option></select>
    <select id="rYear" aria-label="Year"><option value="">All years</option>${[...new Set(runs.flatMap((r) => [String(r.from || "").slice(0, 4), String(r.to || "").slice(0, 4)]).filter(Boolean))].sort().reverse().map((y) => `<option>${esc(y)}</option>`).join("")}</select>
  </div>
  <div class="tw runs-tw"><table>
    <thead><tr>
      <th data-k="strategyLabel">Strategy</th><th data-k="market">Market</th><th data-k="from">Period</th><th data-k="resolution">Candle</th><th data-k="settingsSource">Settings</th>
      <th class="r" data-k="totalTrades">Trades</th><th class="r" data-k="winRate">Win %</th><th class="r" data-k="totalPnl">P&amp;L</th><th class="r sorted" data-k="savedAt">Saved ▼</th>
    </tr></thead>
    <tbody id="runBody"></tbody>
    <tfoot id="runFoot"></tfoot>
  </table></div>` : `<p class="empty">No saved runs yet — run one above.</p>`}
</div>
${jsonTag("bt-catalog", catalog)}
${jsonTag("bt-init", init)}
${jsonTag("bt-runs", runs)}
<script>
${modalJS()}
${clearCacheJS()}
var CATALOG = JSON.parse(document.getElementById('bt-catalog').textContent);
var INIT = JSON.parse(document.getElementById('bt-init').textContent);
var RUNS = JSON.parse(document.getElementById('bt-runs').textContent);
var FIELDS = [], CUSTOM = INIT.custom || {}, fieldsKey = '', GROUP = '';
function $(id){ return document.getElementById(id); }
function escH(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function radio(n){ var r=document.querySelector('input[name='+n+']:checked'); return r?r.value:''; }
function inr(n){ n=Number(n)||0; return (n<0?'−':'')+'₹'+Math.round(Math.abs(n)).toLocaleString('en-IN'); }
function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function parse(s){ var p=s.split('-'); return new Date(+p[0], +p[1]-1, +p[2]); }

function onStrategy(keepMarket){
  var s = CATALOG[$('strategy').value]; if(!s) return;
  var want = keepMarket || $('market').value || 'NIFTY', html = '', firstOk = null, has = false;
  s.markets.forEach(function(m){
    if(m.enabled && !firstOk) firstOk = m.key;
    if(m.key === want && m.enabled) has = true;
    html += '<option value="'+escH(m.key)+'"'+(m.enabled?'':' disabled')+'>'+escH(m.label)+(m.enabled?'':' — coming soon')+'</option>';
  });
  $('market').innerHTML = html;
  $('market').value = has ? want : (firstOk || '');
  var soon = s.markets.filter(function(m){ return !m.enabled; }).map(function(m){ return m.label; });
  $('marketHint').textContent = soon.length ? ('Coming soon: ' + soon.join(', ') + '.') : '';
  if(s.resolution){
    var r = INIT.resolution && s.resolution.options.indexOf(INIT.resolution) >= 0 ? INIT.resolution : s.resolution.default;
    $('resWrap').innerHTML = '<select id="resolution">' + s.resolution.options.map(function(o){ return '<option value="'+escH(o)+'"'+(o===r?' selected':'')+'>'+escH(o)+'-min</option>'; }).join('') + '</select>';
  } else {
    $('resWrap').innerHTML = '<div class="fixed" id="resolution">Set by strategy</div>';
  }
  INIT.resolution = '';
  loadFields(); paintCrumb();
}

function paintCrumb(){
  var s = CATALOG[$('strategy').value], mo = $('market').selectedOptions[0];
  $('cStrat').textContent = s ? s.label : '—';
  $('cMkt').textContent = mo ? mo.textContent : '—';
  $('cDates').textContent = $('from').value + ' → ' + $('to').value;
}

function loadFields(){
  var st = $('strategy').value, mk = $('market').value, key = st + '@' + mk;
  if(!st || !mk || key === fieldsKey) { paintSource(); return; }
  fieldsKey = key; FIELDS = []; GROUP = '';
  $('fields').innerHTML = '<p class="hint">Loading settings…</p>';
  paintSource();
  fetch('/backtest/options.json?strategy=' + encodeURIComponent(st) + '&market=' + encodeURIComponent(mk))
    .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(d){ if(fieldsKey !== key) return; FIELDS = d.fields || []; renderFields(); paintSource(); })
    .catch(function(e){ $('fields').innerHTML = '<p class="hint">Could not load settings (' + escH(e.message) + '). Current settings will be used.</p>'; });
}

function inputFor(f, val){
  var attrs = ' id="f_'+escH(f.key)+'" data-key="'+escH(f.key)+'" aria-label="'+escH(f.label)+'"';
  if(f.type === 'toggle') return '<div class="tog"><input type="checkbox"'+attrs+(val==='true'||val==='1'?' checked':'')+'/></div>';
  if(f.type === 'select' && f.options) return '<select'+attrs+'>'+f.options.map(function(o){ return '<option value="'+escH(o.value)+'"'+(o.value===val?' selected':'')+'>'+escH(o.label)+'</option>'; }).join('')+'</select>';
  if(f.type === 'number') return '<input type="number" inputmode="decimal"'+attrs+' value="'+escH(val)+'" step="'+(f.step!=null?escH(f.step):'any')+'"/>';
  if(f.type === 'time') return '<input type="time"'+attrs+' value="'+escH(val)+'"/>';
  return '<input type="text"'+attrs+' value="'+escH(val)+'"/>';
}
function curVal(f){ return Object.prototype.hasOwnProperty.call(CUSTOM, f.key) ? CUSTOM[f.key] : f.value; }

function renderFields(){
  if(!FIELDS.length){ $('fields').innerHTML = '<p class="hint">This strategy has no own settings to change here.</p>'; $('gchips').innerHTML=''; countChanged(); return; }
  var groups = {}, order = ['Entry','Exit','Safety','Timing','Trade days'];
  FIELDS.forEach(function(f){ (groups[f.group] = groups[f.group] || []).push(f); });
  Object.keys(groups).forEach(function(g){ if(order.indexOf(g) < 0) order.push(g); });
  order = order.filter(function(g){ return groups[g]; });
  $('gchips').innerHTML = ['<button type="button" class="preset-btn'+(GROUP?'':' on')+'" data-g="">All ('+FIELDS.length+')</button>'].concat(order.map(function(g){
    return '<button type="button" class="preset-btn'+(GROUP===g?' on':'')+'" data-g="'+escH(g)+'">'+escH(g)+' ('+groups[g].length+')</button>';
  })).join('');
  var q = $('fq').value.trim().toLowerCase(), only = $('fChanged').checked, html = '', shown = 0;
  order.forEach(function(g){
    if(GROUP && GROUP !== g) return;
    var rows = groups[g].filter(function(f){
      var v = curVal(f);
      if(only && v === f.value) return false;
      return !q || (f.label+' '+f.key+' '+(f.desc||'')).toLowerCase().indexOf(q) >= 0;
    });
    if(!rows.length) return;
    html += '<div class="fgroup"><h3>'+escH(g)+'</h3>';
    rows.forEach(function(f){
      var v = curVal(f), src = f.source === 'own' ? 'set' : f.source === 'inherited' ? 'same as NIFTY' : 'default';
      shown++;
      html += '<div class="frow'+(v!==f.value?' changed':'')+'" id="row_'+escH(f.key)+'"><div class="fl">'+escH(f.label)+' <span class="badge">'+src+'</span><span class="fk">'+escH(f.key)+'</span>'+(f.desc?'<span class="fd">'+escH(f.desc)+'</span>':'')+'</div><div>'+inputFor(f, v)+'</div></div>';
    });
    html += '</div>';
  });
  $('fields').innerHTML = shown ? html : '<p class="hint">No setting matches.</p>';
  countChanged();
}

function valOf(el){ return el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : String(el.value).trim(); }
function onField(el){
  var k = el.getAttribute('data-key'), f = FIELDS.filter(function(x){ return x.key===k; })[0]; if(!f) return;
  var v = valOf(el);
  if(v === f.value) delete CUSTOM[k]; else CUSTOM[k] = v;
  var row = $('row_' + k); if(row) row.classList.toggle('changed', v !== f.value);
  countChanged();
}
function changedKeys(){
  var keys = FIELDS.map(function(f){ return f.key; });
  return Object.keys(CUSTOM).filter(function(k){ return keys.indexOf(k) >= 0; });
}
function countChanged(){
  var n = changedKeys().length;
  $('chgCount').textContent = n ? (n + ' setting(s) changed for this run only.') : 'Nothing changed yet — edit a value below.';
}
function paintSource(){
  var custom = radio('settings') === 'custom';
  document.querySelectorAll('.seg label').forEach(function(l){ l.classList.toggle('on', l.querySelector('input').checked); });
  $('customWrap').style.display = custom ? 'block' : 'none';
  var mk = $('market').value, s = CATALOG[$('strategy').value];
  $('srcHint').textContent = custom
    ? 'Only this run uses the values you change — Settings and running paper are not touched.'
    : (mk === 'NIFTY' ? 'Runs with exactly what ' + (s ? s.label : 'the strategy') + ' paper reads today.' : 'Runs with this market\\'s own settings; anything not set there follows NIFTY.');
}

function preset(p){
  var d = new Date(), y = d.getFullYear(), m = d.getMonth(), t = ymd(d), dow = d.getDay();
  var mon = new Date(d); mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  var lmon = new Date(mon); lmon.setDate(mon.getDate() - 7);
  var lfri = new Date(lmon); lfri.setDate(lmon.getDate() + 4);
  var r = null;
  if(/^y\\d{4}$/.test(p)){ var yr = +p.slice(1); r = [yr+'-01-01', yr === y ? t : yr+'-12-31']; }
  else if(/^m\\d+$/.test(p)){ var mi = +p.slice(1); r = [ymd(new Date(y, mi, 1)), mi === m ? t : ymd(new Date(y, mi+1, 0))]; }
  else r = ({
    thisWeek:[ymd(mon), t], lastWeek:[ymd(lmon), ymd(lfri)],
    thisMonth:[ymd(new Date(y, m, 1)), t], lastMonth:[ymd(new Date(y, m-1, 1)), ymd(new Date(y, m, 0))],
    last3:[ymd(new Date(y, m-2, 1)), t], last6:[ymd(new Date(y, m-5, 1)), t],
    thisYear:[ymd(new Date(y, 0, 1)), t], lastYear:[ymd(new Date(y-1, 0, 1)), ymd(new Date(y-1, 11, 31))],
    last2y:[ymd(new Date(y-2, 0, 1)), t], last3y:[ymd(new Date(y-3, 0, 1)), t], last5y:[ymd(new Date(y-5, 0, 1)), t]
  })[p];
  if(!r) return;
  $('from').value = r[0]; $('to').value = r[1];
  document.querySelectorAll('.presets .preset-btn').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-p') === p); });
  onDates(true);
}

function chunks(f, t, mode){
  var out = [];
  if(mode === 'year'){
    for(var y = +f.slice(0,4); y <= +t.slice(0,4); y++){
      out.push({ from: y === +f.slice(0,4) ? f : y+'-01-01', to: y === +t.slice(0,4) ? t : y+'-12-31', label: String(y) });
    }
  } else if(mode === 'month'){
    var fd = parse(f), td = parse(t), a = fd.getFullYear()*12 + fd.getMonth(), b = td.getFullYear()*12 + td.getMonth();
    var MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for(var k = a; k <= b; k++){
      var yr = Math.floor(k/12), mo = k%12;
      out.push({ from: k === a ? f : ymd(new Date(yr, mo, 1)), to: k === b ? t : ymd(new Date(yr, mo+1, 0)), label: MN[mo]+' '+yr });
    }
  } else out.push({ from: f, to: t, label: f+' → '+t });
  return out;
}

function onDates(fromPreset){
  if(!fromPreset) document.querySelectorAll('.presets .preset-btn.on').forEach(function(b){ b.classList.remove('on'); });
  var f = $('from').value, t = $('to').value;
  paintCrumb();
  if(!f || !t || f > t){ $('rangeInfo').textContent = f > t ? 'From must be on or before To.' : ''; paintSplit(); return; }
  var days = Math.round((parse(t) - parse(f)) / 86400000) + 1;
  var yrs = chunks(f, t, 'year').length, mos = chunks(f, t, 'month').length;
  $('rangeInfo').innerHTML = '<b>' + days + '</b> day(s) · ' + mos + ' month(s) · ' + yrs + ' calendar year(s)' + (yrs > 1 && radio('split') === 'none' ? ' — tip: split by years to get one result tab per year.' : '');
  paintSplit();
}

function runQuery(f, t){
  var q = new URLSearchParams();
  q.set('strategy', $('strategy').value); q.set('market', $('market').value);
  var r = $('resolution'); if(r && r.tagName === 'SELECT') q.set('resolution', r.value);
  q.set('from', f); q.set('to', t); q.set('settings', radio('settings'));
  if(radio('settings') === 'custom') changedKeys().forEach(function(k){ q.set('s.' + k, CUSTOM[k]); });
  return '/backtest/run?' + q.toString();
}

function paintSplit(){
  var mode = radio('split'), f = $('from').value, t = $('to').value;
  var on = mode !== 'none' && f && t && f <= t;
  $('splitBox').classList.toggle('on', !!on);
  if(!on){ $('runBtn').textContent = '▶ Run backtest'; return; }
  var list = chunks(f, t, mode);
  $('runBtn').textContent = '▶ Run ' + list.length + ' backtest' + (list.length > 1 ? 's' : '') + ' in new tabs';
  $('splitHint').textContent = list.length + ' part(s). Each opens in a new tab and runs one after another. If the browser blocks pop-ups, allow them for this site or click the parts below.';
  $('splitList').innerHTML = list.map(function(c){ return '<a target="_blank" rel="noopener" href="'+escH(runQuery(c.from, c.to))+'">↗ '+escH(c.label)+'</a>'; }).join('');
}

function validate(){
  var f = $('from').value, t = $('to').value;
  if(!f || !t){ showAlert({ icon:'📅', title:'Dates missing', message:'Pick both a From and a To date.' }); return false; }
  if(f > t){ showAlert({ icon:'📅', title:'Check dates', message:'From must be on or before To.' }); return false; }
  if(t > INIT.today){ $('to').value = INIT.today; onDates(); }
  if(!$('market').value){ showAlert({ icon:'⚠️', title:'No market', message:'This strategy has no market ready yet.' }); return false; }
  return true;
}

function runBacktest(e){
  e.preventDefault();
  if(!validate()) return;
  var mode = radio('split'), list = chunks($('from').value, $('to').value, mode);
  if(mode === 'none' || list.length < 2){
    $('runBtn').disabled = true; $('runBtn').textContent = 'Starting…';
    window.location = runQuery($('from').value, $('to').value);
    return;
  }
  var links = $('splitList').querySelectorAll('a'), blocked = 0;
  Array.prototype.forEach.call(links, function(a){
    var w = window.open(a.href, '_blank');
    if(w) a.classList.add('opened'); else blocked++;
  });
  if(blocked) showAlert({ icon:'🧩', title:'Some tabs were blocked', message: blocked + ' tab(s) did not open. Allow pop-ups for this site, or click the parts in the Split box.' });
}

// ── Saved runs ──
var rSort = 'savedAt', rDir = -1;
function istTime(s){ var d = new Date(s); if(isNaN(d)) return '—'; d = new Date(d.getTime() + 19800000); return d.toISOString().slice(0,16).replace('T',' '); }
function renderRuns(){
  if(!$('runBody')) return;
  var q = $('rq').value.trim().toLowerCase(), st = $('rStrat').value, mk = $('rMkt').value, rs = $('rRes').value, sc = $('rSrc').value, yr = $('rYear').value;
  var list = RUNS.filter(function(r){
    var ml = r.marketLabel || r.market, p = Number(r.totalPnl) || 0;
    if(st && r.strategyLabel !== st) return false;
    if(mk && ml !== mk) return false;
    if(sc && (r.settingsSource || 'current') !== sc) return false;
    if(rs === 'win' && !(p > 0)) return false;
    if(rs === 'loss' && !(p < 0)) return false;
    if(rs === 'none' && r.totalTrades) return false;
    if(yr && !(String(r.from).slice(0,4) <= yr && String(r.to).slice(0,4) >= yr)) return false;
    return !q || [r.strategyLabel, ml, r.market, r.from, r.to, r.id].join(' ').toLowerCase().indexOf(q) >= 0;
  });
  list.sort(function(a, b){
    var x = a[rSort], y = b[rSort];
    if(typeof x === 'number' || typeof y === 'number'){ x = Number(x)||0; y = Number(y)||0; }
    else { x = String(x||''); y = String(y||''); }
    return (x < y ? -1 : x > y ? 1 : 0) * rDir;
  });
  document.querySelectorAll('.runs-tw thead th').forEach(function(th){
    var k = th.getAttribute('data-k'); th.classList.toggle('sorted', k === rSort);
    th.textContent = th.textContent.replace(/ [▲▼]$/, '') + (k === rSort ? (rDir < 0 ? ' ▼' : ' ▲') : '');
  });
  $('runCnt').textContent = list.length + ' of ' + RUNS.length + ' run(s)';
  $('runBody').innerHTML = list.length ? list.map(function(r){
    var p = Number(r.totalPnl) || 0, href = '/backtest/result/' + encodeURIComponent(r.id);
    return '<tr data-href="'+escH(href)+'">'
      + '<td class="s" data-label="Strategy"><a href="'+escH(href)+'">'+escH(r.strategyLabel)+'</a></td>'
      + '<td data-label="Market">'+escH(r.marketLabel || r.market)+'</td>'
      + '<td data-label="Period">'+escH(r.from)+' → '+escH(r.to)+'</td>'
      + '<td data-label="Candle">'+(r.resolution ? escH(r.resolution)+'m' : '—')+'</td>'
      + '<td data-label="Settings">'+(r.settingsSource === 'custom' ? '<span class="pill c">custom</span>' : '<span class="pill">current</span>')+'</td>'
      + '<td class="r" data-label="Trades">'+(r.totalTrades||0)+'</td>'
      + '<td class="r" data-label="Win %">'+escH(r.winRate)+'%</td>'
      + '<td class="r '+(p > 0 ? 'pos' : p < 0 ? 'neg' : '')+'" data-label="P&L">'+inr(p)+'</td>'
      + '<td class="r" data-label="Saved (IST)">'+istTime(r.savedAt)+'</td></tr>';
  }).join('') : '<tr><td colspan="9" class="empty">No saved run matches these filters.</td></tr>';
  if(list.length > 1){
    var tt = 0, tp = 0, wins = 0;
    list.forEach(function(r){ tt += r.totalTrades||0; tp += Number(r.totalPnl)||0; wins += Math.round((r.totalTrades||0) * (Number(r.winRate)||0) / 100); });
    $('runFoot').innerHTML = '<tr><td data-label="Total">'+list.length+' runs shown</td><td></td><td></td><td></td><td></td>'
      + '<td class="r" data-label="Trades">'+tt+'</td><td class="r" data-label="Win %">'+(tt ? (wins*100/tt).toFixed(1) : '0')+'%</td>'
      + '<td class="r '+(tp >= 0 ? 'pos' : 'neg')+'" data-label="P&L">'+inr(tp)+'</td><td></td></tr>';
  } else $('runFoot').innerHTML = '';
}

$('btForm').addEventListener('submit', runBacktest);
$('strategy').addEventListener('change', function(){ CUSTOM = {}; fieldsKey = ''; onStrategy(); });
$('market').addEventListener('change', function(){ CUSTOM = {}; loadFields(); paintCrumb(); paintSplit(); });
$('resWrap').addEventListener('change', paintSplit);
$('from').addEventListener('change', function(){ onDates(); });
$('to').addEventListener('change', function(){ onDates(); });
document.querySelectorAll('.presets .preset-btn').forEach(function(b){ b.addEventListener('click', function(){ preset(b.getAttribute('data-p')); }); });
document.querySelectorAll('input[name=split]').forEach(function(r){ r.addEventListener('change', function(){ onDates(true); }); });
document.querySelectorAll('input[name=settings]').forEach(function(r){ r.addEventListener('change', function(){ paintSource(); paintSplit(); }); });
$('fields').addEventListener('input', function(e){ if(e.target.getAttribute('data-key')){ onField(e.target); paintSplit(); } });
$('fields').addEventListener('change', function(e){ if(e.target.getAttribute('data-key')){ onField(e.target); paintSplit(); } });
$('gchips').addEventListener('click', function(e){ var b = e.target.closest('[data-g]'); if(b){ GROUP = b.getAttribute('data-g'); renderFields(); } });
$('fq').addEventListener('input', renderFields);
$('fChanged').addEventListener('change', renderFields);
$('resetBtn').addEventListener('click', function(){ CUSTOM = {}; renderFields(); paintSplit(); });
if($('runBody')){
  ['rq','rStrat','rMkt','rRes','rSrc','rYear'].forEach(function(id){ $(id).addEventListener(id === 'rq' ? 'input' : 'change', renderRuns); });
  document.querySelectorAll('.runs-tw thead th').forEach(function(th){ th.addEventListener('click', function(){
    var k = th.getAttribute('data-k'); if(rSort === k) rDir = -rDir; else { rSort = k; rDir = (k === 'strategyLabel' || k === 'market') ? 1 : -1; }
    renderRuns();
  }); });
  $('runBody').addEventListener('click', function(e){ if(e.target.closest('a')) return; var tr = e.target.closest('tr[data-href]'); if(tr) window.location = tr.getAttribute('data-href'); });
  renderRuns();
}
onStrategy(INIT.market);
onDates(true);
</script>`;
  return shell(`${TITLE} — strategy × market`, body);
}

function renderError(msg, q) {
  return renderForm(q || {}, msg);
}

// ── Results of a saved run ───────────────────────────────────────────────────
function renderResult(rec) {
  const v = rec.view || {};
  const changed = (rec.settings || []).filter((s) => s.source === "custom");
  const srcLabel = { own: "set", inherited: "same as NIFTY", default: "default", custom: "custom" };
  const settingsRows = (rec.settings || []).map((s) => {
    const unset = s.engineValue === null;
    const shown = unset ? "engine default" : s.engineValue;
    return `<tr><td>${esc(s.label)}<br><span class="k">${esc(s.key)}</span></td>` +
      `<td class="v${s.source === "custom" ? " c" : ""}">${esc(shown === "" ? "—" : shown)}</td>` +
      `<td>${esc(srcLabel[s.source] || s.source)}${unset && s.value ? ` <span class="k">(Settings shows ${esc(s.value)})</span>` : ""}</td></tr>`;
  }).join("");
  const newHref = `/backtest?${runQuery(rec, true)}`;
  const preface = `
<style>
.bt-meta{background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:0.72rem;line-height:1.7;color:#a0b8d8;}
.bt-meta .s{color:#e0e8f0;} .bt-meta .m{color:#fbbf24;} .bt-meta .c{color:#f59e0b;font-weight:700;}
.bt-meta .k{color:#6d85a8;font-size:0.6rem;word-break:break-all;}
.bt-meta a{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border:1px solid #1e3a8a;border-radius:8px;color:#60a5fa;text-decoration:none;}
.bt-meta table{width:100%;border-collapse:collapse;font-size:0.7rem;}
.bt-meta td{padding:5px 8px;border-top:0.5px solid #0e1428;vertical-align:top;}
.bt-meta td.v{text-align:right;white-space:nowrap;}
.bt-meta summary{cursor:pointer;min-height:44px;display:flex;align-items:center;}
:root[data-theme="light"] .bt-meta{background:#ffffff;border-color:#e0e4ea;color:#334155;}
:root[data-theme="light"] .bt-meta .s{color:#0f172a;} :root[data-theme="light"] .bt-meta .m{color:#b45309;}
:root[data-theme="light"] .bt-meta td{border-color:#e0e4ea;} :root[data-theme="light"] .bt-meta a{border-color:#bfdbfe;color:#1d4ed8;}
</style>
<div class="bt-meta">
  <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;">
    <div><b class="s">${esc(rec.strategyLabel)}</b> · <b class="m">${esc(rec.marketLabel || rec.market)}</b> · ${esc(rec.from)} → ${esc(rec.to)}${rec.resolution ? ` · ${esc(rec.resolution)}-min` : ""} · ${rec.settingsSource === "custom" ? `<b class="c">custom settings (${changed.length} changed)</b>` : "current settings"}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <a href="${esc(newHref)}">✎ Change &amp; re-run</a>
      <a href="/backtest">← All backtests</a>
    </div>
  </div>
  <div>Saved ${esc(String(rec.savedAt || "").replace("T", " ").slice(0, 19))} UTC · run id ${esc(rec.id)}</div>
  <details><summary>Settings used (${(rec.settings || []).length})</summary>
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;"><table><tbody>${settingsRows || `<tr><td>No own settings.</td></tr>`}</tbody></table></div>
  </details>
</div>`;
  return renderBacktestResults({
    mode: v.mode || rec.strategyKey,
    accent: v.accent || "#3b82f6",
    strategyName: `${v.strategyName || rec.strategyLabel} · ${rec.marketLabel || rec.market}`,
    endpoint: "/backtest/run",
    endpointQuery: runQuery(rec, false),
    from: rec.from, to: rec.to,
    summary: v.summary || {},
    trades: v.trades || [],
    extraTradeColumns: v.extraTradeColumns || [],
    extraStats: v.extraStats || [],
    notes: v.notes || "",
    activePage: "backtest",
    preface,
    mobileCards: true,
    openPanels: true,
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  try { res.send(renderForm(req.query || {}, null)); }
  catch (e) {
    console.error("[backtest] form failed:", e);
    res.status(500).send(shell(TITLE, `<div class="err">The backtest page could not be built: ${esc(e.message)}</div>`));
  }
});

router.get("/options.json", (req, res) => {
  const id = String(req.query.strategy || "");
  const mk = String(req.query.market || "NIFTY").toUpperCase();
  try {
    if (!page.hookOf(id)) return res.status(404).json({ error: "unknown or unconverted strategy" });
    res.json({
      strategy: id, market: mk,
      markets: page.marketOptions(id),
      resolution: page.resolutionOptions(id),
      fields: page.settingsFields(id, mk),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/status", (req, res) => res.json(page.status(String(req.query.jobId || ""))));

router.get("/idle", (req, res) => {
  if (req.accepts(["json", "html"]) === "json" || req.query.json === "1") return res.json({ idle: backtestJobs.isIdle() });
  res.json({ idle: backtestJobs.isIdle() });
});

router.get("/run", (req, res) => {
  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : "";
  const p = page.parseRequest(req.query);
  const title = `${TITLE} — ${p.strategy} · ${p.market}`;

  if (jobId) {
    const st = page.status(jobId);
    if (st.status === "done" && resultStore.loadRun(jobId)) return res.redirect(`/backtest/result/${encodeURIComponent(jobId)}`);
    if (st.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, "/backtest", title));
    if (st.status === "error") return res.send(renderError(st.error || "The backtest failed.", req.query));
    if (st.status === "cancelled") return res.send(renderError("Backtest cancelled. Nothing was saved.", req.query));
    // Unknown / expired job id → fall through and start afresh.
  }

  if (!process.env.ACCESS_TOKEN) {
    return res.status(401).send(renderError("Log in to Fyers first — every backtest fetches its candles from Fyers.", req.query));
  }
  const r = page.start(p);
  if (r.error) return res.status(400).send(renderError(r.error, req.query));
  if (r.queued) return res.send(backtestJobs.buildQueuePage("/backtest", title));
  if (r.refused) return res.status(403).send(renderError(r.refused, req.query));
  return res.send(backtestJobs.buildProgressPage(r.id, "/backtest", title));
});

router.get("/result/:id.json", (req, res) => {
  const rec = resultStore.loadRun(req.params.id);
  if (!rec) return res.status(404).json({ error: "not_found" });
  res.json(rec);
});

router.get("/result/:id", (req, res) => {
  const rec = resultStore.loadRun(req.params.id);
  if (!rec) return res.status(404).send(renderError(`No saved run "${req.params.id}" — it may have been pruned (the newest 40 are kept).`, {}));
  try { res.send(renderResult(rec)); }
  catch (e) {
    console.error("[backtest] result render failed:", e);
    res.status(500).send(renderError(`Could not render run ${req.params.id}: ${e.message}`, {}));
  }
});

module.exports = router;
module.exports._renderForm = renderForm;
module.exports._renderResult = renderResult;
module.exports._runQuery = runQuery;

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
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");
const { resolveTheme } = require("../utils/theme");

const TITLE = "Backtest";

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function jsonTag(id, data) {
  return `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}
function istToday() { return new Date(Date.now() + 19800000).toISOString().slice(0, 10); }
function shiftDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const inr = (n) => `${n < 0 ? "−" : ""}₹${Math.round(Math.abs(Number(n) || 0)).toLocaleString("en-IN")}`;

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
:root{--bg:#040c18;--card:#08101f;--line:#13203a;--text:#e0eaf8;--muted:#8ba1c2;--muted2:#6d85a8;--accent:#3b82f6;--good:#10b981;--bad:#ef4444;--warn:#f59e0b;--input:#0b1528;}
:root[data-theme="light"]{--bg:#f4f6f9;--card:#ffffff;--line:#e0e4ea;--text:#1e293b;--muted:#475569;--muted2:#5c6b7f;--accent:#2563eb;--good:#059669;--bad:#dc2626;--warn:#b45309;--input:#ffffff;}
html{-webkit-text-size-adjust:100%;}
body{font-family:'IBM Plex Mono',ui-monospace,monospace;background:var(--bg);color:var(--text);overflow-x:hidden;}
${sidebarCSS()}
.main-content{flex:1;margin-left:200px;padding:18px 22px 40px;min-width:0;min-height:100vh;}
@media(max-width:768px){.main-content{margin-left:0;padding:14px max(14px,env(safe-area-inset-right)) 40px max(14px,env(safe-area-inset-left));}}
h1{font-size:1.1rem;margin-bottom:4px;}
.sub{color:var(--muted);font-size:0.75rem;margin-bottom:16px;line-height:1.5;}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px;max-width:980px;}
.card h2{font-size:0.7rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted2);margin-bottom:12px;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;}
label.f{display:block;font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:4px;}
select,input[type=date],input[type=number],input[type=text],input[type=time]{width:100%;min-height:44px;background:var(--input);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;font-size:0.85rem;}
:root:not([data-theme="light"]) input[type=date],:root:not([data-theme="light"]) input[type=time]{color-scheme:dark;}
select:focus,input:focus{outline:2px solid var(--accent);outline-offset:1px;}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
.chip{min-height:44px;padding:0 14px;border-radius:22px;border:1px solid var(--line);background:transparent;color:var(--accent);font:inherit;font-size:0.75rem;cursor:pointer;}
.chip:hover,.chip:focus-visible{border-color:var(--accent);}
.seg{display:flex;gap:8px;flex-wrap:wrap;}
.seg label{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:8px;cursor:pointer;font-size:0.8rem;}
.seg input{accent-color:var(--accent);width:18px;height:18px;}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 22px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;font-size:0.85rem;font-weight:700;cursor:pointer;text-decoration:none;}
.btn.ghost{background:transparent;color:var(--accent);}
.btn:disabled{opacity:0.5;cursor:not-allowed;}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}
.hint{font-size:0.7rem;color:var(--muted);line-height:1.5;margin-top:6px;}
.fixed{min-height:44px;display:flex;align-items:center;font-size:0.8rem;color:var(--muted);border:1px dashed var(--line);border-radius:8px;padding:0 10px;}
.err{background:rgba(239,68,68,0.1);border:1px solid var(--bad);color:var(--bad);border-radius:8px;padding:12px 14px;font-size:0.8rem;margin-bottom:16px;max-width:980px;line-height:1.5;word-break:break-word;}
.fgroup{margin-top:14px;}
.fgroup h3{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted2);margin:0 0 8px;}
.frow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,180px);gap:10px;align-items:center;padding:6px 0;border-top:1px solid var(--line);}
.frow .fl{font-size:0.75rem;line-height:1.35;word-break:break-word;}
.frow .fk{display:block;font-size:0.6rem;color:var(--muted2);word-break:break-all;}
.frow.changed .fl{color:var(--warn);}
.frow.changed .fl::after{content:" • changed";font-size:0.6rem;}
.badge{display:inline-block;font-size:0.58rem;padding:1px 6px;border-radius:4px;border:1px solid var(--line);color:var(--muted);margin-left:4px;vertical-align:middle;}
.tog{display:flex;align-items:center;justify-content:flex-end;min-height:44px;}
.tog input{width:22px;height:22px;accent-color:var(--accent);}
.runs{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;}
.run{display:block;text-decoration:none;color:inherit;border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-height:44px;background:var(--card);}
.run:hover,.run:focus-visible{border-color:var(--accent);}
.run .t{font-size:0.8rem;font-weight:700;margin-bottom:4px;}
.run .m{font-size:0.68rem;color:var(--muted);line-height:1.6;}
.pos{color:var(--good);} .neg{color:var(--bad);}
.empty{font-size:0.75rem;color:var(--muted);}
@media(max-width:520px){.frow{grid-template-columns:1fr;}.tog{justify-content:flex-start;}.actions .btn{flex:1 1 100%;}}
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
<div class="main-content">
${body}
</div></div>
</body></html>`;
}

// ── The form ─────────────────────────────────────────────────────────────────
function renderForm(q, error) {
  const strategies = page.strategies();
  const ready = strategies.filter((s) => s.ready);
  const sel = ready.find((s) => s.id === q.strategy) || ready[0] || null;
  const today = istToday();
  const init = {
    strategy: sel ? sel.id : "",
    market: String(q.market || "NIFTY").toUpperCase(),
    from: /^\d{4}-\d{2}-\d{2}$/.test(q.from || "") ? q.from : shiftDays(today, -90),
    to: /^\d{4}-\d{2}-\d{2}$/.test(q.to || "") ? q.to : today,
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
  const runs = resultStore.listRuns(30);

  const body = `
<h1>🧪 Backtest</h1>
<p class="sub">One page for every strategy. Pick a strategy and a market, a date range and the settings to run with. Results are saved — re-open any run below.</p>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<form class="card" id="btForm" onsubmit="return runBacktest(event)" novalidate>
  <h2>What to test</h2>
  <div class="grid">
    <div><label class="f" for="strategy">Strategy</label>
      <select id="strategy" name="strategy">${strategies.map((s) => `<option value="${esc(s.id)}"${!s.ready ? " disabled" : ""}${sel && s.id === sel.id ? " selected" : ""}>${esc(s.label)}${s.ready ? "" : " — not on this page yet"}</option>`).join("")}</select></div>
    <div><label class="f" for="market">Market</label><select id="market" name="market"></select>
      <div class="hint" id="marketHint"></div></div>
    <div><label class="f" for="resolution">Candle</label><div id="resWrap"></div></div>
  </div>
  <h2 style="margin-top:18px;">Date range</h2>
  <div class="grid">
    <div><label class="f" for="from">From</label><input type="date" id="from" value="${esc(init.from)}" max="${esc(today)}"/></div>
    <div><label class="f" for="to">To</label><input type="date" id="to" value="${esc(init.to)}" max="${esc(today)}"/></div>
  </div>
  <div class="chips" role="group" aria-label="Date presets">
    ${[["thisMonth", "This month"], ["lastMonth", "Last month"], ["last3", "Last 3 months"], ["last6", "Last 6 months"], ["thisYear", "This year"], ["lastYear", "Last year"], ["last2y", "Last 2 years"]]
      .map(([k, l]) => `<button type="button" class="chip" onclick="preset('${k}')">${l}</button>`).join("")}
  </div>
  <h2 style="margin-top:18px;">Settings</h2>
  <div class="seg" role="radiogroup" aria-label="Settings source">
    <label><input type="radio" name="settings" value="current"${init.settings === "current" ? " checked" : ""} onchange="onSource()"/> Current settings of this strategy + market</label>
    <label><input type="radio" name="settings" value="custom"${init.settings === "custom" ? " checked" : ""} onchange="onSource()"/> Custom</label>
  </div>
  <div class="hint" id="srcHint"></div>
  <div id="customWrap" style="display:none;">
    <div class="actions" style="margin-top:10px;"><button type="button" class="btn ghost" onclick="resetCustom()">Reset to current</button><span class="hint" id="chgCount"></span></div>
    <div id="fields"></div>
  </div>
  <div class="actions" style="margin-top:18px;">
    <button type="submit" class="btn" id="runBtn">▶ Run backtest</button>
    <span class="hint">One backtest runs at a time. You can cancel it from the progress page.</span>
  </div>
</form>

<div class="card">
  <h2>Saved runs</h2>
  ${runs.length ? `<div class="runs">${runs.map((r) => `
    <a class="run" href="/backtest/result/${esc(r.id)}">
      <div class="t">${esc(r.strategyLabel)} · ${esc(r.marketLabel || r.market)}</div>
      <div class="m">${esc(r.from)} → ${esc(r.to)}${r.resolution ? ` · ${esc(r.resolution)}m` : ""} · ${r.settingsSource === "custom" ? "custom settings" : "current settings"}<br>
      ${r.totalTrades} trade(s) · <span class="${r.totalPnl >= 0 ? "pos" : "neg"}">${inr(r.totalPnl)}</span> · WR ${esc(r.winRate)}%<br>
      saved ${esc(String(r.savedAt || "").replace("T", " ").slice(0, 16))} UTC</div>
    </a>`).join("")}</div>` : `<p class="empty">No saved runs yet — run one above.</p>`}
</div>
${jsonTag("bt-catalog", catalog)}
${jsonTag("bt-init", init)}
<script>
var CATALOG = JSON.parse(document.getElementById('bt-catalog').textContent);
var INIT = JSON.parse(document.getElementById('bt-init').textContent);
var FIELDS = [];          // current strategy+market fields from /backtest/options.json
var CUSTOM = INIT.custom || {};
var fieldsKey = '';
function $(id){ return document.getElementById(id); }
function escH(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function source(){ var r=document.querySelector('input[name=settings]:checked'); return r?r.value:'current'; }

function onStrategy(keepMarket){
  var s = CATALOG[$('strategy').value]; if(!s) return;
  var want = keepMarket || $('market').value || 'NIFTY';
  var html = '', firstOk = null, has = false;
  s.markets.forEach(function(m){
    if(m.enabled && !firstOk) firstOk = m.key;
    if(m.key === want && m.enabled) has = true;
    html += '<option value="'+escH(m.key)+'"'+(m.enabled?'':' disabled')+'>'+escH(m.label)+(m.enabled?'':' — coming soon')+'</option>';
  });
  $('market').innerHTML = html;
  $('market').value = has ? want : (firstOk || '');
  var soon = s.markets.filter(function(m){ return !m.enabled; }).length;
  $('marketHint').textContent = soon ? (soon + ' more market(s) coming soon for this strategy.') : '';
  if(s.resolution){
    var r = INIT.resolution && s.resolution.options.indexOf(INIT.resolution) >= 0 ? INIT.resolution : s.resolution.default;
    $('resWrap').innerHTML = '<select id="resolution">' + s.resolution.options.map(function(o){ return '<option value="'+escH(o)+'"'+(o===r?' selected':'')+'>'+escH(o)+'-min</option>'; }).join('') + '</select>';
  } else {
    $('resWrap').innerHTML = '<div class="fixed" id="resolution">Set by the strategy</div>';
  }
  INIT.resolution = '';
  onMarket();
}

function onMarket(){ loadFields(); }

function loadFields(){
  var st = $('strategy').value, mk = $('market').value;
  var key = st + '@' + mk;
  if(!st || !mk || key === fieldsKey) { paintSource(); return; }
  fieldsKey = key; FIELDS = [];
  $('fields').innerHTML = '<p class="hint">Loading settings…</p>';
  paintSource();
  fetch('/backtest/options.json?strategy=' + encodeURIComponent(st) + '&market=' + encodeURIComponent(mk))
    .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(d){ if(fieldsKey !== key) return; FIELDS = d.fields || []; renderFields(); paintSource(); })
    .catch(function(e){ $('fields').innerHTML = '<p class="hint">Could not load settings (' + escH(e.message) + '). Current settings will be used.</p>'; });
}

function inputFor(f, val){
  var id = 'f_' + f.key, attrs = ' id="'+id+'" data-key="'+escH(f.key)+'" aria-label="'+escH(f.label)+'" oninput="onField(this)" onchange="onField(this)"';
  if(f.type === 'toggle') return '<div class="tog"><input type="checkbox"'+attrs+(val==='true'||val==='1'?' checked':'')+'/></div>';
  if(f.type === 'select' && f.options) return '<select'+attrs+'>'+f.options.map(function(o){ return '<option value="'+escH(o.value)+'"'+(o.value===val?' selected':'')+'>'+escH(o.label)+'</option>'; }).join('')+'</select>';
  if(f.type === 'number') return '<input type="number" inputmode="decimal"'+attrs+' value="'+escH(val)+'"'+(f.step!=null?' step="'+escH(f.step)+'"':' step="any"')+'/>';
  if(f.type === 'time') return '<input type="time"'+attrs+' value="'+escH(val)+'"/>';
  return '<input type="text"'+attrs+' value="'+escH(val)+'"/>';
}

function renderFields(){
  if(!FIELDS.length){ $('fields').innerHTML = '<p class="hint">This strategy has no own settings to change here.</p>'; return; }
  var groups = {};
  FIELDS.forEach(function(f){ (groups[f.group] = groups[f.group] || []).push(f); });
  var order = ['Entry','Exit','Safety','Timing','Trade days'];
  Object.keys(groups).forEach(function(g){ if(order.indexOf(g) < 0) order.push(g); });
  var html = '';
  order.forEach(function(g){
    if(!groups[g]) return;
    html += '<div class="fgroup"><h3>'+escH(g)+'</h3>';
    groups[g].forEach(function(f){
      var val = Object.prototype.hasOwnProperty.call(CUSTOM, f.key) ? CUSTOM[f.key] : f.value;
      var src = f.source === 'own' ? 'set' : f.source === 'inherited' ? 'same as NIFTY' : 'default';
      html += '<div class="frow'+(val!==f.value?' changed':'')+'" id="row_'+escH(f.key)+'"><div class="fl">'+escH(f.label)+' <span class="badge">'+src+'</span><span class="fk">'+escH(f.key)+'</span></div><div>'+inputFor(f, val)+'</div></div>';
    });
    html += '</div>';
  });
  $('fields').innerHTML = html;
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
function countChanged(){
  var keys = FIELDS.map(function(f){ return f.key; });
  var n = Object.keys(CUSTOM).filter(function(k){ return keys.indexOf(k) >= 0; }).length;
  $('chgCount').textContent = n ? (n + ' setting(s) changed from current') : 'Nothing changed yet — edit a value below.';
}
function resetCustom(){ CUSTOM = {}; renderFields(); }
function onSource(){ paintSource(); }
function paintSource(){
  var custom = source() === 'custom';
  $('customWrap').style.display = custom ? 'block' : 'none';
  var mk = $('market').value, s = CATALOG[$('strategy').value];
  $('srcHint').textContent = custom
    ? 'Only this run uses the values you change — Settings and running paper sessions are not touched.'
    : (mk === 'NIFTY' ? 'Runs with exactly what ' + (s ? s.label : 'the strategy') + ' paper reads today.' : 'Runs with this market\\'s own settings; anything not set there follows NIFTY.');
}

function fmt(d){ return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function preset(p){
  var d = new Date(), y = d.getFullYear(), m = d.getMonth(), t = fmt(d);
  var map = {
    thisMonth: [fmt(new Date(y, m, 1)), t], lastMonth: [fmt(new Date(y, m-1, 1)), fmt(new Date(y, m, 0))],
    last3: [fmt(new Date(y, m-2, 1)), t], last6: [fmt(new Date(y, m-5, 1)), t],
    thisYear: [fmt(new Date(y, 0, 1)), t], lastYear: [fmt(new Date(y-1, 0, 1)), fmt(new Date(y-1, 11, 31))],
    last2y: [fmt(new Date(y-2, 0, 1)), t]
  };
  if(map[p]){ $('from').value = map[p][0]; $('to').value = map[p][1]; }
}

function runBacktest(e){
  if(e) e.preventDefault();
  var f = $('from').value, t = $('to').value;
  if(!f || !t){ alert('Pick both a From and a To date.'); return false; }
  if(f > t){ alert('From must be on or before To.'); return false; }
  if(!$('market').value){ alert('This strategy has no market ready yet.'); return false; }
  var q = new URLSearchParams();
  q.set('strategy', $('strategy').value); q.set('market', $('market').value);
  var r = $('resolution'); if(r && r.tagName === 'SELECT') q.set('resolution', r.value);
  q.set('from', f); q.set('to', t); q.set('settings', source());
  if(source() === 'custom'){
    var keys = FIELDS.map(function(x){ return x.key; });
    Object.keys(CUSTOM).forEach(function(k){ if(keys.indexOf(k) >= 0) q.set('s.' + k, CUSTOM[k]); });
  }
  $('runBtn').disabled = true; $('runBtn').textContent = 'Starting…';
  window.location = '/backtest/run?' + q.toString();
  return false;
}

$('strategy').addEventListener('change', function(){ CUSTOM = {}; fieldsKey = ''; onStrategy(); });
$('market').addEventListener('change', function(){ CUSTOM = {}; onMarket(); });
onStrategy(INIT.market);
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

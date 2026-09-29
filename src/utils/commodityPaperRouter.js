/**
 * commodityPaperRouter.js — the Paper page for a COMMODITY engine
 * (src/services/commodityPaper.js). One builder, used by every
 * /cmx_{crude,gold,silver}_{ema_rsi_st,ema_rsi_st_v2}-paper page.
 *
 *   GET /status           the page
 *   GET /status/fragment  the live parts of the page, JSON {top, bottom} (polled every 4 s)
 *   GET /status/data      JSON snapshot
 *   GET /status/chart-data candles + overlays + markers for the chart
 *   GET /history          every recorded day (?date=YYYY-MM-DD opens one)
 *   GET /start · /stop · /exit · /manual?side=CE|PE · /reset
 */

const express = require("express");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS } = require("./sharedNav");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiStatGrid, bbRsiCapitalStrip } = require("./bbRsiStyleUI");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function rs(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return (n < 0 ? "-₹" : "₹") + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function pnlColor(n) { return n > 0 ? "#10b981" : n < 0 ? "#ef4444" : "#94a3b8"; }
function hhmm(iso) {
  if (!iso) return "—";
  return new Date(new Date(iso).getTime() + 19800000).toISOString().slice(11, 16);
}
function fmtMins(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }

function createCommodityPaperRouter({ engine, base, navKey, title, icon, rulesText }) {
  const router = express.Router();
  const modeKey = () => engine.snapshot().modeKey;
  const modeOn  = () => String(process.env[modeKey()] || "false").toLowerCase() === "true";
  const pill = (side) => `<span class="cx-pill ${side === "CE" ? "cx-ce" : "cx-pe"}">${side}</span>`;
  const tradeRow = (t) => `
<tr><td>${hhmm(t.entryTime)}–${hhmm(t.exitTime)}</td><td>${pill(t.side)} ${t.strike}</td>
<td>${t.spotAtEntry} → ${t.spotAtExit != null ? t.spotAtExit : "—"}</td>
<td>₹${t.optionEntryLtp} → ₹${t.optionExitLtp}</td><td>${t.lots}</td><td style="color:${pnlColor(t.pnl)}"><b>${rs(t.pnl)}</b></td><td class="cx-reason">${esc(t.exitReason)}</td></tr>`;
  const tradeTable = (list) => `<div class="cx-scroll"><table class="cx-t"><thead><tr><th>Time</th><th>Option</th><th>Future</th><th>Premium</th><th>Lots</th><th>P&L</th><th>Why it closed</th></tr></thead><tbody>${list.map(tradeRow).join("")}</tbody></table></div>`;

  // Live top part: capital, stats, open trade / flat card with manual buttons.
  function topFragment(s) {
    const c = s.cfg;
    const wins = s.trades.filter((t) => t.pnl > 0).length;
    const losses = s.trades.filter((t) => t.pnl < 0).length;
    const p = s.position;
    const unreal = p && s.optLtp ? Math.round((s.optLtp - p.optionEntryLtp) * p.multiplier * p.lots * 100) / 100 : null;
    const priceAge = s.lastQuoteAt ? Math.round((Date.now() - s.lastQuoteAt) / 1000) : null;
    const lossHit = c.maxLoss > 0 && s.sessionPnl <= -c.maxLoss;
    const prev = s.prevBar;

    const capital = bbRsiCapitalStrip({
      starting: c.startCap, current: Math.round((c.startCap + s.allTime) * 100) / 100, allTime: s.allTime,
      note: "Capital = starting capital + every closed paper trade on this page. Reset wipes history.",
    });
    const stats = bbRsiStatGrid([
      { label: "Today P&L", value: rs(s.sessionPnl), color: pnlColor(s.sessionPnl) },
      { label: "Trades", value: `${s.trades.length} / ${c.maxTrades}`, sub: `${wins}W · ${losses}L` },
      { label: "Loss streak", value: s.consecLimit ? `${s.consecLosses} / ${s.consecLimit}` : String(s.consecLosses), sub: s.consecLimit && s.consecLosses >= s.consecLimit ? "🛑 Done for today" : "✅ OK" },
      { label: "Daily loss limit", value: c.maxLoss > 0 ? `-₹${c.maxLoss.toLocaleString("en-IN")}` : "Off", sub: lossHit ? "🛑 Hit" : "✅ Active" },
      { label: "Candles loaded", value: String(s.candles), sub: s.running ? (s.candles ? `${c.res}m candles` : "⚠️ Warming up…") : "Loads on Start" },
      { label: `${esc(s.underlying.label)} future`, value: s.futLtp != null ? String(s.futLtp) : "—", sub: priceAge != null ? `${priceAge}s ago` : "Last: —" },
      { label: "Session start", value: s.startedAt ? new Date(new Date(s.startedAt).getTime() + 19800000).toISOString().slice(0, 16).replace("T", " ") : "—" },
      { label: "Prev candle high", value: prev ? String(prev.high) : "—", sub: prev ? `candle ${hhmm(new Date(prev.time * 1000).toISOString())}` : "Last closed candle high" },
      { label: "Prev candle low", value: prev ? String(prev.low) : "—", sub: "Last closed candle low" },
      { label: "Last signal", value: s.lastSignal ? esc(s.lastSignal.signal || "NONE") : "—", sub: s.lastSignal ? `close ${s.lastSignal.close}` : "" },
    ]);

    const posCard = p ? `
<div class="cx-card cx-pos">
  <div class="cx-h">Open trade</div>
  <div class="cx-row">
    <div><span class="k">Bought</span>${pill(p.side)} ${esc(p.symbol)}</div>
    <div><span class="k">Lots</span>${p.lots}</div>
    <div><span class="k">Entry</span>₹${p.optionEntryLtp} at ${hhmm(p.entryTime)}</div>
    <div><span class="k">Now</span>${s.optLtp != null ? "₹" + s.optLtp : "—"}</div>
    <div><span class="k">Open P&L</span><b style="color:${pnlColor(unreal || 0)}">${rs(unreal)}</b></div>
    <div><span class="k">Future at entry</span>${p.spotAtEntry}</div>
    <div><span class="k">Stop (future)</span>${p.stopLoss != null ? p.stopLoss : "—"}</div>
    <div><span class="k">Candles held</span>${p.candlesHeld}</div>
  </div>
  <div style="margin-top:10px;"><a class="cx-btn cx-red" href="${base}/exit" onclick="return confirm('Exit this paper trade now?')">Exit now</a></div>
</div>` : `
<div class="cx-card cx-flat">
  <div class="cx-flat-ico">📭</div>
  <div class="cx-flat-t">${s.running ? "FLAT — Waiting for entry signal" : "IDLE — press Start to begin"}</div>
  ${s.running ? `<div class="cx-flat-btns">
    <a class="cx-btn cx-mce" href="${base}/manual?side=CE" onclick="return confirm('Buy an at-the-money ${esc(s.underlying.label)} CE (paper) now?')">▲ Manual CE</a>
    <a class="cx-btn cx-mpe" href="${base}/manual?side=PE" onclick="return confirm('Buy an at-the-money ${esc(s.underlying.label)} PE (paper) now?')">▼ Manual PE</a>
  </div>` : ""}
</div>`;

    const armed = s.armed ? `<div class="cx-note">🎯 ${s.armed.side} signal armed — enters if the future crosses ${s.armed.triggerLevel} during this candle.</div>` : "";
    const halted = s.halted ? `<div class="cx-note cx-warn">⏸️ ${esc(s.halted)}</div>` : "";
    const err = s.lastError ? `<div class="cx-note cx-warn">⚠️ ${esc(s.lastError)}</div>` : "";
    return `${capital}${stats}${halted}${err}${armed}${posCard}`;
  }

  // Live bottom part: today's trades, recent days, activity log.
  function bottomFragment(s) {
    const histRows = s.history.slice(0, 10).map((d) => `<tr><td><a class="cx-a" href="${base}/history?date=${d.day}">${d.day}</a></td><td>${d.trades}</td><td style="color:${pnlColor(d.pnl)}">${rs(d.pnl)}</td></tr>`).join("");
    return `
<div class="cx-card">
  <div class="cx-h">Today's trades</div>
  ${s.trades.length ? tradeTable(s.trades.slice().reverse()) : `<div class="cx-muted">No trades yet today.</div>`}
</div>
<div class="cx-card">
  <div class="cx-h">Past days <a class="cx-a" style="float:right;text-transform:none;" href="${base}/history">Full history →</a></div>
  ${s.history.length ? `<div class="cx-scroll"><table class="cx-t" style="min-width:0;"><thead><tr><th>Day</th><th>Trades</th><th>P&L</th></tr></thead><tbody>${histRows}</tbody></table></div>`
    : `<div class="cx-muted">No history yet.</div>`}
</div>
<div class="cx-card">
  <div class="cx-h">Activity log</div>
  <pre class="cx-log">${s.logs.length ? s.logs.slice().reverse().map(esc).join("\n") : "Nothing yet — press Start."}</pre>
</div>`;
  }

  const pageCSS = () => `${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.cx-card{background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;margin-bottom:16px;}
.cx-h{font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:8px;}
.cx-row{display:flex;gap:10px 22px;flex-wrap:wrap;font-size:0.8rem;color:#e2e8f0;}
.cx-row .k{color:var(--muted-1,#8ba1c2);margin-right:6px;}
.cx-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.7rem;font-weight:700;}
.cx-ce{background:rgba(16,185,129,0.15);color:#10b981;} .cx-pe{background:rgba(239,68,68,0.15);color:#ef4444;}
.cx-pos{border-color:rgba(59,130,246,0.45);}
.cx-flat{text-align:center;padding:22px 16px;}
.cx-flat-ico{font-size:1.6rem;margin-bottom:6px;}
.cx-flat-t{font-size:0.9rem;color:#cbd5e1;font-weight:600;margin-bottom:12px;}
.cx-flat-btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
.cx-mce{background:rgba(16,185,129,0.12);border:1px solid #10b981;color:#10b981;}
.cx-mpe{background:rgba(239,68,68,0.12);border:1px solid #ef4444;color:#ef4444;}
.cx-note{font-size:0.78rem;color:#cbd5e1;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.25);border-radius:8px;padding:9px 12px;margin-bottom:14px;}
.cx-warn{background:rgba(245,158,11,0.08);border-color:rgba(245,158,11,0.3);color:#fcd34d;}
.cx-muted{font-size:0.78rem;color:var(--muted-1,#8ba1c2);}
.cx-a{color:#60a5fa;text-decoration:none;}
.cx-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.cx-t{width:100%;border-collapse:collapse;font-size:0.76rem;color:#e2e8f0;min-width:620px;}
.cx-t th{text-align:left;color:var(--muted-1,#8ba1c2);font-weight:600;padding:6px 8px;border-bottom:1px solid #1a2236;white-space:nowrap;}
.cx-t td{padding:7px 8px;border-bottom:1px solid #111a2c;white-space:nowrap;}
.cx-t td.cx-reason{white-space:normal;min-width:180px;color:#94a3b8;}
.cx-log{font-size:0.7rem;line-height:1.55;color:#94a3b8;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0;}
.cx-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:8px;font-size:0.78rem;font-weight:700;text-decoration:none;}
.cx-red{background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;}
.cx-chart{height:420px;border:1px solid #1a2236;border-radius:10px;overflow:hidden;background:#0a0f1c;}
.rule-list{margin:8px 0 0;padding-left:18px;color:var(--muted-1,#8ba1c2);font-size:0.75rem;line-height:1.7;}
.rule-list b{color:#cbd5e1;font-weight:600;}
.cx-day{border:1px solid #1a2236;border-radius:8px;margin-bottom:10px;background:#0a1020;}
.cx-day>summary{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;min-height:44px;padding:8px 14px;cursor:pointer;font-size:0.8rem;color:#e2e8f0;list-style:none;}
.cx-day>summary::-webkit-details-marker{display:none;}
.cx-day[open]>summary{border-bottom:1px solid #1a2236;}
.cx-day .cx-scroll{padding:6px 8px 10px;}
.cx-day.cx-hl{border-color:#3b82f6;}
@media (max-width:640px){ .cx-card{padding:12px;} .cx-row{font-size:0.76rem;gap:8px 14px;} .cx-chart{height:320px;} .cx-flat-btns .cx-btn{flex:1;} }`;

  // `monitor` is the same session in the field names the Real-Time monitor reads
  // from every NIFTY strategy — see monitorView().
  router.get("/status/data", (req, res) => {
    const s = engine.snapshot();
    res.json({ ...s, monitor: monitorView(s) });
  });
  router.get("/status/fragment", (req, res) => {
    const s = engine.snapshot();
    res.json({ top: topFragment(s), bottom: bottomFragment(s) });
  });
  router.get("/status/chart-data", (req, res) => res.json(engine.chartData()));

  router.get("/status", (req, res) => {
    const s = engine.snapshot();
    const c = s.cfg;
    const msg = req.query.msg ? `<div class="cx-note cx-warn">${esc(req.query.msg)}</div>` : "";
    const off = modeOn() ? "" : `<div class="cx-note cx-warn">This strategy is switched off. Turn on <b>${modeKey()}</b> in Settings → Menu Visibility to start it.</div>`;
    const contract = s.series
      ? `Signal from <b>${esc(s.series.future)}</b> (expires ${s.series.futureExpiry}) · buys options expiring <b>${s.series.optionExpiry}</b>`
      : `The contract is picked when you press Start: ${esc(s.underlying.label)}, nearest option expiry after today.`;

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>${esc(title)} — Paper</title>${faviconLink()}
<style>${pageCSS()}</style></head><body>
${buildSidebar(navKey, false, s.running)}
<div class="main-content">
${bbRsiTopBar({
  title: `${icon} ${title} — Paper`,
  metaLine: `${esc(s.underlying.label)} (MCX) · ${c.res}m candles · entries ${fmtMins(c.entryStart)}–${fmtMins(c.entryEnd)} · exit ${fmtMins(c.eodExit)} · ${c.lots} lot`,
  running: s.running,
  primaryAction: modeOn() ? { href: `${base}/start`, label: "▶ Start", color: "#0369a1" } : null,
  stopAction: { href: `${base}/stop`, label: "■ Stop" },
  historyHref: `${base}/history`,
  resetJs: s.running ? null : `if(confirm('Wipe all ${esc(title)} paper history?'))location='${base}/reset'`,
})}
${msg}${off}
<div id="cx-top">${topFragment(s)}</div>
<div class="section-title">${esc(s.underlying.label)} future · ${c.res}-min chart</div>
<div id="cx-chart" class="cx-chart"></div>
<div class="cx-muted" style="margin:6px 0 16px;">Blue ▲ entry · green/red ▼ exit · yellow = fast EMA · blue = slow EMA · SuperTrend (green up / red down) · RSI at the bottom · dashed orange = stop.</div>
<div class="cx-card">
  <div class="cx-h">How it trades</div>
  <div class="cx-muted">${contract}</div>
  <ul class="rule-list">${rulesText}
    <li><b>Buys</b> the at-the-money ${esc(s.underlying.label)} option, ${c.lots} lot (1 lot = ${esc(s.underlying.unit)}). P&L = premium change × ${s.underlying.multiplier} per lot − ₹${c.charges} charges.</li>
    <li><b>Day guards:</b> max ${c.maxTrades} trades, stop for the day at −₹${c.maxLoss} — for this page alone. Paper only — no real orders, and separate from all NIFTY strategies.</li>
  </ul>
</div>
<div id="cx-bottom">${bottomFragment(s)}</div>
</div>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
<script>
(function(){
  var top=document.getElementById('cx-top'), bot=document.getElementById('cx-bottom');
  function tick(){
    if(document.hidden) return;
    fetch('${base}/status/fragment',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){ if(d){ top.innerHTML=d.top; bot.innerHTML=d.bottom; } }).catch(function(){});
  }
  setInterval(tick,4000);

  // ── Chart (Lightweight Charts) — today's candles, overlays, entries/exits ──
  var box=document.getElementById('cx-chart');
  if(typeof LightweightCharts==='undefined'||!box){ if(box) box.style.display='none'; return; }
  var chart=LightweightCharts.createChart(box,{
    width:box.clientWidth,height:box.clientHeight,
    layout:{background:{type:'solid',color:'#0a0f1c'},textColor:'#8ba1c2',fontSize:11},
    grid:{vertLines:{color:'#111827'},horzLines:{color:'#111827'}},
    crosshair:{mode:LightweightCharts.CrosshairMode.Normal},
    rightPriceScale:{borderColor:'#1a2236',scaleMargins:{top:0.1,bottom:0.22}},
    timeScale:{borderColor:'#1a2236',timeVisible:true,secondsVisible:false,shiftVisibleRangeOnNewBar:false,
      tickMarkFormatter:function(t){var d=new Date((t+19800)*1000);return ('0'+d.getUTCHours()).slice(-2)+':'+('0'+d.getUTCMinutes()).slice(-2);}},
    localization:{timeFormatter:function(t){var d=new Date((t+19800)*1000);return d.toISOString().slice(0,16).replace('T',' ');}},
  });
  var candles=chart.addCandlestickSeries({upColor:'#10b981',downColor:'#ef4444',borderUpColor:'#10b981',borderDownColor:'#ef4444',wickUpColor:'#10b981',wickDownColor:'#ef4444'});
  var lineOpt=function(color,title){return {color:color,lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,title:title};};
  var emaF=chart.addLineSeries(lineOpt('#fbbf24','EMA')), emaS=chart.addLineSeries(lineOpt('#3b82f6','EMA'));
  var st=chart.addLineSeries({color:'#22c55e',lineWidth:2,priceLineVisible:false,lastValueVisible:true,crosshairMarkerVisible:false,title:'ST'});
  var rsi=chart.addLineSeries({color:'#22d3ee',lineWidth:1,priceScaleId:'rsi',priceLineVisible:false,lastValueVisible:true,crosshairMarkerVisible:false,title:'RSI'});
  chart.priceScale('rsi').applyOptions({scaleMargins:{top:0.82,bottom:0}});
  var rsiLv=false, lines=[], first=true;
  function load(){
    if(document.hidden&&!first) return;
    fetch('${base}/status/chart-data',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){
      if(!d||!d.candles||!d.candles.length) return;
      // Show only the latest trading day; older candles are indicator warm-up.
      var lt=d.candles[d.candles.length-1].time, dk=Math.floor((lt+19800)/86400), cut=lt;
      for(var i=d.candles.length-1;i>=0;i--){ if(Math.floor((d.candles[i].time+19800)/86400)===dk) cut=d.candles[i].time; else break; }
      var k=function(a){return (a||[]).filter(function(x){return x.time>=cut;});};
      candles.setData(k(d.candles));
      emaF.applyOptions({title:'EMA'+d.emaFastLen}); emaS.applyOptions({title:'EMA'+d.emaSlowLen});
      emaF.setData(k(d.emaFast)); emaS.setData(k(d.emaSlow));
      st.setData(k(d.supertrend).map(function(p){return {time:p.time,value:p.value,color:p.trend===-1?'#ef4444':'#22c55e'};}));
      rsi.setData(k(d.rsi));
      if(!rsiLv&&d.rsi&&d.rsi.length){ rsiLv=true;
        rsi.createPriceLine({price:d.rsiCeMin,color:'#10b981',lineWidth:1,lineStyle:LightweightCharts.LineStyle.Dashed,axisLabelVisible:true,title:'CE'});
        rsi.createPriceLine({price:d.rsiPeMax,color:'#ef4444',lineWidth:1,lineStyle:LightweightCharts.LineStyle.Dashed,axisLabelVisible:true,title:'PE'}); }
      candles.setMarkers(k(d.markers).sort(function(a,b){return a.time-b.time;}));
      lines.forEach(function(l){candles.removePriceLine(l);}); lines=[];
      var pl=function(p,c,t){ if(p!=null) lines.push(candles.createPriceLine({price:p,color:c,lineWidth:1,lineStyle:LightweightCharts.LineStyle.Dashed,axisLabelVisible:true,title:t})); };
      pl(d.stopLoss,'#f59e0b','SL'); pl(d.entry,'#3b82f6','Entry'); pl(d.armed,'#a855f7','Trigger');
      if(first){ chart.timeScale().fitContent(); first=false; }
    }).catch(function(){});
  }
  load(); setInterval(load,10000);
  window.addEventListener('resize',function(){ chart.applyOptions({width:box.clientWidth,height:box.clientHeight}); });
})();
</script>
</body></html>`);
  });

  // Every recorded day with its trades. ?date=YYYY-MM-DD opens that day
  // (the Consolidation Report links here).
  router.get("/history", (req, res) => {
    const s = engine.snapshot();
    const c = s.cfg;
    const days = engine.historyDays();
    const pick = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? String(req.query.date) : null;
    const all = days.flatMap((d) => d.trades);
    const wins = all.filter((t) => t.pnl > 0), losses = all.filter((t) => t.pnl < 0);
    const net = Math.round(all.reduce((a, t) => a + (t.pnl || 0), 0) * 100) / 100;
    const sum = (a) => a.reduce((x, t) => x + t.pnl, 0);
    const pf = losses.length ? Math.abs(sum(wins) / sum(losses)) : null;
    const best = days.length ? days.reduce((a, d) => (d.pnl > a.pnl ? d : a)) : null;
    const worst = days.length ? days.reduce((a, d) => (d.pnl < a.pnl ? d : a)) : null;

    const cards = bbRsiStatGrid([
      { label: "Trading days", value: String(days.length) },
      { label: "Total trades", value: String(all.length), sub: `${wins.length}W · ${losses.length}L` },
      { label: "Win rate", value: all.length ? (wins.length / all.length * 100).toFixed(1) + "%" : "—" },
      { label: "Net P&L", value: rs(net), color: pnlColor(net) },
      { label: "Avg win / loss", value: `${wins.length ? rs(sum(wins) / wins.length) : "—"} / ${losses.length ? rs(sum(losses) / losses.length) : "—"}` },
      { label: "Profit factor", value: pf != null ? pf.toFixed(2) : "—" },
      { label: "Best day", value: best ? rs(best.pnl) : "—", color: best ? pnlColor(best.pnl) : null, sub: best ? best.day : "" },
      { label: "Worst day", value: worst ? rs(worst.pnl) : "—", color: worst ? pnlColor(worst.pnl) : null, sub: worst ? worst.day : "" },
    ]);
    const dayBlocks = days.map((d) => {
      const w = d.trades.filter((t) => t.pnl > 0).length, l = d.trades.filter((t) => t.pnl < 0).length;
      const open = pick ? pick === d.day : false;
      return `<details class="cx-day${open ? " cx-hl" : ""}" id="d-${d.day}"${open ? " open" : ""}>
<summary><b>${d.day}</b><span>${d.trades.length} trade${d.trades.length === 1 ? "" : "s"} · <span style="color:#10b981">${w}W</span> <span style="color:#ef4444">${l}L</span></span><b style="margin-left:auto;color:${pnlColor(d.pnl)}">${rs(d.pnl)}</b></summary>
${d.trades.length ? tradeTable(d.trades) : `<div class="cx-muted" style="padding:10px 14px;">No trades.</div>`}
</details>`;
    }).join("");

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>${esc(title)} — History</title>${faviconLink()}
<style>${pageCSS()}</style></head><body>
${buildSidebar(navKey, false, s.running)}
<div class="main-content">
${bbRsiTopBar({
  title: `${icon} ${title} — History`,
  metaLine: `${esc(s.underlying.label)} (MCX) · paper trades on this page only · <a class="cx-a" href="${base}/status">← Back to Paper</a>`,
  running: s.running,
})}
${bbRsiCapitalStrip({ starting: c.startCap, current: Math.round((c.startCap + s.allTime) * 100) / 100, allTime: s.allTime, note: "Every closed paper trade on this page, all days." })}
${cards}
${pick && !days.some((d) => d.day === pick) ? `<div class="cx-note cx-warn">No trades recorded on ${pick}.</div>` : ""}
${days.length ? dayBlocks : `<div class="cx-card"><div class="cx-muted">No history yet — trades show here once the page has traded.</div></div>`}
</div>
${pick ? `<script>(function(){var e=document.getElementById('d-${pick}');if(e)e.scrollIntoView({block:'start'});})();</script>` : ""}
</body></html>`);
  });

  router.get("/start", async (req, res) => {
    if (!modeOn()) return res.redirect(`${base}/status?msg=` + encodeURIComponent(`Switched off — turn on ${modeKey()} in Settings first.`));
    const r = await engine.start();
    res.redirect(`${base}/status` + (r.ok ? "" : "?msg=" + encodeURIComponent("Not started: " + r.reason)));
  });
  router.get("/stop", async (req, res) => { await engine.stop("manual stop"); res.redirect(`${base}/status`); });
  router.get("/exit", async (req, res) => { await engine.manualExit(); res.redirect(`${base}/status`); });
  router.get("/manual", async (req, res) => {
    const r = await engine.manualEntry(String(req.query.side || "").toUpperCase());
    res.redirect(`${base}/status` + (r.ok ? "" : "?msg=" + encodeURIComponent("Manual entry: " + r.reason)));
  });
  router.get("/reset", (req, res) => {
    const r = engine.reset();
    // Settings → Reset Paper calls every engine's /reset in-process and reads a
    // 400 as "skipped because it is running".
    if (req.headers && req.headers["x-paper-reset"]) {
      return r.ok ? res.json({ success: true, message: `${title} history cleared` })
                  : res.status(400).json({ success: false, error: `Stop ${title} paper trading first before resetting.` });
    }
    res.redirect(`${base}/status` + (r.ok ? "" : "?msg=" + encodeURIComponent(r.reason)));
  });
  router.get("/", (req, res) => res.redirect(`${base}/status`));

  return router;
}

const RULES = {
  V1: `
    <li><b>Signal:</b> the EMA_RSI_ST rules — EMA20/50 trend + RSI + SuperTrend on the future, using the same settings as the NIFTY EMA_RSI_ST.</li>
    <li><b>Entry:</b> with the confirmation candle on, the next candle must cross the signal candle's close.</li>
    <li><b>Exits:</b> previous-candle stop trailed on EMA21, EMA21 touch-back, negative-candle stop, option stop %, profit lock / breakeven, opposite signal, and the day's exit time.</li>`,
  V2: `
    <li><b>Signal:</b> the EMA_RSI_ST_V2 rules — EMA20 vs EMA50 + close beyond EMA20 + RSI on the future, using the same settings as the NIFTY EMA_RSI_ST_V2.</li>
    <li><b>Entry:</b> with the confirmation candle on, the next candle must cross the signal candle's close.</li>
    <li><b>Exits:</b> SuperTrend trailing stop (its only stop), profit lock, opposite signal, and the day's exit time.</li>`,
};
const ICONS = { CRUDE: "🛢️", GOLD: "🥇", SILVER: "🥈" };

// Every commodity engine built by commodityPage(), in mount order — read by the
// Dashboard's Start All (Commodity) button and the 4 PM token-clear hold.
const ENGINES = [];
const enabledEngines = () => ENGINES.filter((e) => String(process.env[e.snapshot().modeKey] || "false").toLowerCase() === "true");

// True while any commodity engine is running — switched on or not, since a page
// toggled off mid-session keeps trading until it is stopped.
const anyRunning = () => ENGINES.some((e) => e.state.running);
// What the shared monitors list: switched on, or still running after being
// switched off (it trades until stopped, so it must stay visible and stoppable).
const visibleEngines = () => ENGINES.filter((e) => e.state.running || String(process.env[e.snapshot().modeKey] || "false").toLowerCase() === "true");

/**
 * An engine snapshot in the shape the Real-Time monitor (routes/realtime.js)
 * reads from the NIFTY strategies' /status/data: one open position, today's
 * counters, newest-first log lines. "Spot" on that screen is the MCX future here.
 */
function monitorView(s) {
  const p = s.position;
  const ist = (iso) => new Date(new Date(iso).getTime() + 19800000).toISOString().slice(11, 19);
  return {
    running: s.running,
    sessionPnl: s.sessionPnl,
    tradeCount: s.trades.length,
    wins: s.trades.filter((t) => t.pnl > 0).length,
    losses: s.trades.filter((t) => t.pnl < 0).length,
    unrealisedPnl: p && s.optLtp ? Math.round((s.optLtp - p.optionEntryLtp) * p.multiplier * p.lots * 100) / 100 : 0,
    lastTickPrice: s.futLtp,
    lastTickTime: s.lastQuoteAt ? ist(s.lastQuoteAt) : "",
    feedNote: "MCX quote poll",
    logs: s.logs.slice().reverse(),
    logTotal: s.logs.length,
    position: p ? {
      side: p.side, symbol: p.symbol,
      qty: `${p.lots} lot (${p.lots * p.multiplier} units)`,
      entryPrice: p.spotAtEntry, liveClose: s.futLtp,
      optionEntryLtp: p.optionEntryLtp, optionCurrentLtp: s.optLtp,
      stopLoss: p.stopLoss, entryTime: ist(p.entryTime),
    } : null,
  };
}

/**
 * When a commodity page is switched on, the Fyers token must outlive the 4 PM
 * NSE clear — MCX trades until CMX_SESSION_END. Returns the epoch ms to clear it
 * at instead (session end + 15 min, today), or null when nothing needs it.
 */
function fyersTokenHoldUntil(now = Date.now()) {
  if (!enabledEngines().length) return null;
  const ist = new Date(now + 19800000);
  if (ist.getUTCDay() === 0 || ist.getUTCDay() === 6) return null;
  const [h, m] = String(process.env.CMX_SESSION_END || "23:30").split(":").map(Number);
  const endMin = (Number.isFinite(h) ? h : 23) * 60 + (Number.isFinite(m) ? m : 30) + 15;
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return endMin > nowMin ? now + (endMin - nowMin) * 60000 - ist.getUTCSeconds() * 1000 : null;
}

/**
 * One commodity × strategy Paper page. Everything is derived from the pair:
 *   ("GOLD", "V2") → /cmx_gold_ema_rsi_st_v2-paper, toggle
 *   CMX_GOLD_EMA_RSI_ST_V2_MODE_ENABLED, settings CMX_EMA_RSI_ST_V2_*.
 */
function commodityPage({ commodity, strategy }) {
  const { createEngine } = require("../services/commodityPaper");
  const { COMMODITIES } = require("../services/mcxContracts");
  const strat = strategy === "V2" ? "EMA_RSI_ST_V2" : "EMA_RSI_ST";
  const id = `cmx_${commodity.toLowerCase()}_${strat.toLowerCase()}`;
  const camel = commodity.charAt(0) + commodity.slice(1).toLowerCase();
  const engine = createEngine({
    id, commodity, strategy,
    prefix:  `CMX_${strat}`,
    modeKey: `CMX_${commodity}_${strat}_MODE_ENABLED`,
    label:   `${strat} (${COMMODITIES[commodity].label})`,
  });
  const router = createCommodityPaperRouter({
    engine,
    base:   `/${id}-paper`,
    navKey: `cmx${camel}${strategy === "V2" ? "EmaRsiStV2" : "EmaRsiSt"}Paper`,
    title:  `${strat} · ${COMMODITIES[commodity].label}`,
    icon:   ICONS[commodity],
    rulesText: RULES[strategy],
  });
  router.engine = engine;
  ENGINES.push(engine);
  return router;
}

module.exports = { createCommodityPaperRouter, commodityPage, enabledEngines, visibleEngines, anyRunning, monitorView, fyersTokenHoldUntil };

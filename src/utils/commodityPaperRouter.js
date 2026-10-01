/**
 * commodityPaperRouter.js — the Paper page for a COMMODITY engine
 * (src/services/commodityPaper.js). One builder, used by every
 * /cmx_{crude,gold,silver}_{ema_rsi_st,ema_rsi_st_v2}-paper page.
 *
 *   GET /status           the page
 *   GET /status/fragment  the live parts of the page, JSON {top, info, bar, trades, logs} (polled every 4 s)
 *   GET /status/data      JSON snapshot
 *   GET /status/chart-data candles + overlays + markers for the chart
 *   GET /status/log       the whole in-memory day log, plain text
 *   GET /history          every recorded day (?date=YYYY-MM-DD opens one)
 *   GET /start · /stop · /exit · /manual?side=CE|PE · /reset
 */

const express = require("express");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS } = require("./sharedNav");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiStatGrid, bbRsiCapitalStrip, bbRsiCurrentBar, bbRsiActivityLog } = require("./bbRsiStyleUI");
const { renderHistoryPage, dailyFilesPaginate } = require("./paperHistoryUI");

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
// "30/09/2026, 15:05:12" — the IST stamp the NIFTY history pages store and split.
function istStamp(iso) {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 19800000).toISOString();
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}, ${d.slice(11, 19)}`;
}
// Contract-note row for an MCX option trade: net is the P&L the trade booked,
// after the flat CMX_CHARGES_PER_TRADE — not the NSE charge schedule.
function mcxContractRow(t) {
  const charges = Number(t.charges) || 0;
  return {
    side: t.side, segment: "MCX - Options", exchange: "MCX",
    buy: t.optionEntryLtp, sell: t.optionExitLtp, qty: t.qty,
    gross: typeof t.grossPnl === "number" ? t.grossPnl : Math.round((t.pnl + charges) * 100) / 100,
    net: t.pnl, strike: t.strike, symbol: t.symbol, date: String(t.entryTime || "").split(",")[0] || null,
    charges: { stt: 0, exchangeTxn: 0, sebi: 0, gst: 0, stampDuty: 0, brokerage: charges, total: charges, estimated: true },
  };
}
function fmtMins(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }

function createCommodityPaperRouter({ engine, base, navKey, title, icon, rulesText }) {
  const router = express.Router();
  const modeKey = () => engine.snapshot().modeKey;
  const modeOn  = () => String(process.env[modeKey()] || "false").toLowerCase() === "true";
  const pill = (side) => `<span class="cx-pill ${side === "CE" ? "cx-ce" : "cx-pe"}">${side}</span>`;
  // A trade in the field names the NIFTY paper pages' Session Trades table reads.
  const tradeView = (t) => ({
    side: t.side, symbol: t.symbol || "", strike: t.strike || "", expiry: t.expiry || "",
    lots: t.lots, qty: t.lots * t.multiplier,
    entry: istStamp(t.entryTime), exit: istStamp(t.exitTime),
    eSpot: t.spotAtEntry, eOpt: t.optionEntryLtp, eSl: t.initialStopLoss != null ? t.initialStopLoss : t.stopLoss,
    xSpot: t.spotAtExit, xOpt: t.optionExitLtp, peakOpt: t.bestOptionLtp != null ? t.bestOptionLtp : null,
    pnl: typeof t.pnl === "number" ? t.pnl : null, charges: t.charges,
    entryReason: t.reason || "", reason: t.exitReason || "",
  });
  // JSON safe to drop inside a <script> tag.
  const jsonForScript = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

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

  // Below the log: how this page trades, and the recent days.
  function infoFragment(s) {
    const c = s.cfg;
    const contract = s.series
      ? `Signal from <b>${esc(s.series.future)}</b> (expires ${s.series.futureExpiry}) · buys options expiring <b>${s.series.optionExpiry}</b>`
      : `The contract is picked when you press Start: ${esc(s.underlying.label)}, nearest option expiry after today.`;
    const histRows = s.history.slice(0, 10).map((d) => `<tr><td><a class="cx-a" href="${base}/history?date=${d.day}">${d.day}</a></td><td>${d.trades}</td><td style="color:${pnlColor(d.pnl)}">${rs(d.pnl)}</td></tr>`).join("");
    return `
<div class="cx-card">
  <div class="cx-h">Past days <a class="cx-a" style="float:right;text-transform:none;" href="${base}/history">Full history →</a></div>
  ${s.history.length ? `<div class="cx-scroll"><table class="cx-t" style="min-width:0;"><thead><tr><th>Day</th><th>Trades</th><th>P&L</th></tr></thead><tbody>${histRows}</tbody></table></div>`
    : `<div class="cx-muted">No history yet.</div>`}
</div>
<div class="cx-card">
  <div class="cx-h">How it trades</div>
  <div class="cx-muted">${contract}</div>
  <ul class="rule-list">${rulesText}
    <li><b>Buys</b> the at-the-money ${esc(s.underlying.label)} option, ${c.lots} lot (1 lot = ${esc(s.underlying.unit)}). P&L = premium change × ${s.underlying.multiplier} per lot − ₹${c.charges} charges.</li>
    <li><b>Day guards:</b> max ${c.maxTrades} trades, stop for the day at −₹${c.maxLoss} — for this page alone. Paper only — no real orders, and separate from all NIFTY strategies.</li>
  </ul>
</div>`;
  }

  // Session Trades — the NIFTY paper pages' table: Side/Result/per-page filters,
  // sortable columns, paging, a 👁 detail modal and Copy Trade Log. Rendered in
  // the browser from PT_ALL, which the 4 s poll replaces.
  function sessionTradesHTML(s) {
    const th = (label, sortKey, align) => `<th${sortKey ? ` onclick="ptSort('${sortKey}')"` : ""} class="pt-th"${align ? ` style="text-align:${align};"` : ""}>${label}</th>`;
    const sel = 'style="background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;"';
    const fut = s.underlying.label + " future";
    return `
<div style="margin-bottom:24px;">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
    <div class="section-title" style="margin-bottom:0;">Session Trades</div>
    <select id="ptSide" onchange="ptFilter()" ${sel}><option value="">All Sides</option><option value="CE">CE</option><option value="PE">PE</option></select>
    <select id="ptResult" onchange="ptFilter()" ${sel}><option value="">All</option><option value="win">Wins</option><option value="loss">Losses</option></select>
    <select id="ptPerPage" onchange="ptFilter()" ${sel}><option value="5">5/page</option><option value="10" selected>10/page</option><option value="25">25/page</option><option value="999999">All</option></select>
    <span id="ptCount" style="font-size:0.72rem;color:var(--muted-1,#8ba1c2);"></span>
    <button class="copy-btn" onclick="copyTradeLog(this)" style="margin-left:auto;">📋 Copy Trade Log</button>
  </div>
  <div style="border:1px solid #1a2236;border-radius:12px;overflow:hidden;overflow-x:auto;-webkit-overflow-scrolling:touch;">
    <table style="width:100%;border-collapse:collapse;min-width:900px;">
      <thead><tr style="background:#0a0f1c;">
        ${th("Side ▲▼", "side")}${th("Date ▼", "entry")}${th("Entry")}${th("Entry Time")}${th("Exit")}${th("Exit Time ▲▼", "exit")}${th("SL")}${th("PnL ₹ ▲▼", "pnl")}${th("Entry Reason")}${th("Exit Reason")}${th("Action", null, "center")}
      </tr></thead>
      <tbody id="ptBody" style="font-family:monospace;font-size:0.78rem;"></tbody>
    </table>
  </div>
  <div id="ptPag" style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;"></div>
  <div id="ptModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
    <div style="background:#0d1320;border:1px solid #1d3b6e;border-radius:16px;padding:20px 22px;max-width:720px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.9);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px;">
        <div><span id="ptm-badge" style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:4px 10px;border-radius:6px;"></span>
          <span style="font-size:0.65rem;color:var(--muted-1,#8ba1c2);margin-left:10px;">📋 Paper Trade — Full Details</span></div>
        <button onclick="document.getElementById('ptModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:var(--muted-1,#8ba1c2);font-size:1rem;cursor:pointer;min-height:44px;padding:4px 12px;border-radius:6px;font-family:inherit;">✕ Close</button>
      </div>
      <div id="ptm-grid"></div>
    </div>
  </div>
</div>
<script id="pt-data" type="application/json">${jsonForScript(s.trades.slice().reverse().map(tradeView))}</script>
<script>
var PT_ALL = JSON.parse(document.getElementById('pt-data').textContent);
var PT_FUT = ${jsonForScript(fut)};
var ptFiltered = PT_ALL.slice(), ptSortCol = 'entry', ptSortDir = -1, ptPage = 1, ptPP = 10;
function ptEsc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function ptFmtDate(dt){ if(!dt) return '—'; var p=dt.split(', '); var d=(p[0]||'').split('/'); return d.length===3 ? d[0]+' '+d[1]+' '+d[2] : (p[0]||'—'); }
function ptFmtTime(dt){ if(!dt) return '—'; return dt.split(', ')[1] || '—'; }
// Sort key for a "DD/MM/YYYY, HH:MM:SS" stamp.
function ptKey(dt){ var m=/^(\\d\\d)\\/(\\d\\d)\\/(\\d{4}), (.*)$/.exec(dt||''); return m ? m[3]+m[2]+m[1]+m[4] : ''; }
function ptFmt(n){ return n != null ? '₹' + Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; }
function ptFilter(){
  var side=document.getElementById('ptSide').value, res=document.getElementById('ptResult').value;
  ptPP=parseInt(document.getElementById('ptPerPage').value); ptPage=1;
  ptFiltered=PT_ALL.filter(function(t){
    if(side && t.side!==side) return false;
    if(res==='win'  && (t.pnl==null || t.pnl<0))  return false;
    if(res==='loss' && (t.pnl==null || t.pnl>=0)) return false;
    return true;
  });
  ptApplySort();
}
function ptSort(col){ ptSortDir = ptSortCol===col ? ptSortDir*-1 : -1; ptSortCol=col; ptApplySort(); }
function ptApplySort(){
  ptFiltered.sort(function(a,b){
    var av=a[ptSortCol], bv=b[ptSortCol];
    if(ptSortCol==='entry'||ptSortCol==='exit'){ av=ptKey(av); bv=ptKey(bv); }
    if(av==null) av=ptSortDir===-1?-Infinity:Infinity;
    if(bv==null) bv=ptSortDir===-1?-Infinity:Infinity;
    return typeof av==='string' ? String(av).localeCompare(String(bv))*ptSortDir : (av-bv)*ptSortDir;
  });
  ptRender();
}
function ptCut(v,n){ v=v||''; return v.length>n ? v.slice(0,n)+'…' : v; }
function ptRender(){
  var start=(ptPage-1)*ptPP, slice=ptFiltered.slice(start,start+ptPP);
  document.getElementById('ptCount').textContent = ptFiltered.length+'/'+PT_ALL.length+' trades';
  window._ptSlice=slice;
  var td='padding:8px 12px;';
  document.getElementById('ptBody').innerHTML = slice.length===0
    ? '<tr><td colspan="11" style="text-align:center;padding:20px;color:var(--muted-1,#8ba1c2);">'+(PT_ALL.length?'No trades match filters.':'No trades yet today.')+'</td></tr>'
    : slice.map(function(t,i){
        var sc=t.side==='CE'?'#10b981':'#ef4444', pc=t.pnl==null?'#c8d8f0':t.pnl>=0?'#10b981':'#ef4444';
        return '<tr style="border-top:1px solid #1a2236;vertical-align:top;">'
          +'<td style="'+td+'color:'+sc+';font-weight:800;">'+ptEsc(t.side||'—')+' <span style="color:#8ba1c2;font-weight:600;">'+ptEsc(t.strike)+'</span></td>'
          +'<td style="'+td+'font-size:0.75rem;">'+ptFmtDate(t.entry)+'</td>'
          +'<td style="'+td+'font-weight:700;">'+ptFmt(t.eSpot)+'</td>'
          +'<td style="'+td+'font-size:0.75rem;">'+ptFmtTime(t.entry)+'</td>'
          +'<td style="'+td+'font-weight:700;">'+ptFmt(t.xSpot)+'</td>'
          +'<td style="'+td+'font-size:0.75rem;">'+ptFmtTime(t.exit)+'</td>'
          +'<td style="'+td+'color:#f59e0b;">'+(t.eSl!=null?ptFmt(t.eSl):'—')+'</td>'
          +'<td style="'+td+'"><div style="font-size:1rem;font-weight:800;color:'+pc+';">'+(t.pnl!=null?(t.pnl>=0?'+':'')+ptFmt(t.pnl):'—')+'</div></td>'
          +'<td style="'+td+'font-size:0.7rem;color:var(--muted-1,#8ba1c2);" title="'+ptEsc(t.entryReason)+'">'+(ptEsc(ptCut(t.entryReason,25))||'—')+'</td>'
          +'<td style="'+td+'font-size:0.7rem;color:var(--muted-1,#8ba1c2);" title="'+ptEsc(t.reason)+'">'+(ptEsc(ptCut(t.reason,35))||'—')+'</td>'
          +'<td style="padding:6px 8px;text-align:center;"><button data-idx="'+i+'" class="pt-eye-btn" title="View full details">👁</button></td>'
          +'</tr>';
      }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('.pt-eye-btn'), function(btn){
    btn.addEventListener('click', function(){ showPTModal(window._ptSlice[parseInt(this.getAttribute('data-idx'))]); });
  });
  var total=Math.ceil(ptFiltered.length/ptPP), pag=document.getElementById('ptPag');
  if(total<=1){ pag.innerHTML=''; return; }
  var b=function(p,label,on,dis){ return '<button onclick="ptGo('+p+')" '+(dis?'disabled ':'')+'class="pt-pg'+(on?' on':'')+'">'+label+'</button>'; };
  var h=b(ptPage-1,'← Prev',false,ptPage===1);
  for(var p=Math.max(1,ptPage-2);p<=Math.min(total,ptPage+2);p++) h+=b(p,p,p===ptPage,false);
  pag.innerHTML=h+b(ptPage+1,'Next →',false,ptPage===total);
}
function ptGo(p){ ptPage=Math.max(1,Math.min(Math.ceil(ptFiltered.length/ptPP),p)); ptRender(); }
function showPTModal(t){
  var sc=t.side==='CE'?'#10b981':'#ef4444', pc=t.pnl==null?'#c8d8f0':t.pnl>=0?'#10b981':'#ef4444';
  var optDiff=(t.eOpt!=null&&t.xOpt!=null)?Math.round((t.xOpt-t.eOpt)*100)/100:null;
  var movePts=(t.eSpot!=null&&t.xSpot!=null)?Math.round((t.side==='PE'?t.eSpot-t.xSpot:t.xSpot-t.eSpot)*100)/100:null;
  var badge=document.getElementById('ptm-badge');
  badge.textContent=(t.side||'—')+(t.strike?' · '+t.strike:'');
  badge.style.background=t.side==='CE'?'rgba(16,185,129,0.15)':'rgba(239,68,68,0.15)'; badge.style.color=sc;
  function cell(label,val,color,sub){
    return '<div style="background:#060910;border:1px solid #1a2236;border-radius:8px;padding:11px 13px;">'
      +'<div style="font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-2,#6d85a8);margin-bottom:5px;">'+label+'</div>'
      +'<div style="font-size:0.9rem;font-weight:700;color:'+(color||'#e0eaf8')+';font-family:monospace;line-height:1.3;word-break:break-word;">'+(val==null||val===''?'—':val)+'</div>'
      +(sub?'<div style="font-size:0.62rem;color:var(--muted-1,#8ba1c2);margin-top:3px;">'+sub+'</div>':'')+'</div>';
  }
  function box(title,color,bg,border,cells){
    return '<div style="background:'+bg+';border:1px solid '+border+';border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
      +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:'+color+';margin-bottom:8px;font-weight:700;">'+title+'</div>'
      +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">'+cells+'</div></div>';
  }
  var peakSub = t.peakOpt!=null && t.eOpt!=null ? '+'+(Math.round((t.peakOpt-t.eOpt)*100)/100)+' pts peak'+(t.xOpt!=null?' · gave back '+(Math.round((t.peakOpt-t.xOpt)*100)/100):'') : 'Highest premium in trade';
  document.getElementById('ptm-grid').innerHTML =
    box('📋 Option Contract','#34d399','#06100e','#0d3020',
      cell('Symbol',ptEsc(t.symbol),'#a0f0c0')+cell('Strike',ptEsc(t.strike),'#fff')+cell('Expiry',ptEsc(t.expiry),'#f59e0b')
      +cell('Option Type',ptEsc(t.side),sc)+cell('Qty / Lots',t.qty?t.qty+' qty ('+t.lots+' lot)':'—','#c8d8f0'))
    +box('🟢 Entry','#60a5fa','#060c18','#0d2040',
      cell('Entry Time',ptEsc(t.entry),'#c8d8f0')+cell(ptEsc(PT_FUT)+' @ Entry',ptFmt(t.eSpot),'#fff')
      +cell('Option LTP @ Entry',ptFmt(t.eOpt),'#60a5fa','Option premium paid')+cell('Initial Stop Loss',t.eSl!=null?ptFmt(t.eSl):'—','#f59e0b','Future price SL level')
      +cell('SL Distance',(t.eSl!=null&&t.eSpot!=null)?Math.abs(t.eSpot-t.eSl).toFixed(2)+' pts':'—','#f59e0b')+cell('Entry Signal',ptEsc(t.entryReason),'#a0b8d0'))
    +box('🔴 Exit','#f87171','#0c0608','#3a0d12',
      cell('Exit Time',ptEsc(t.exit),'#c8d8f0')+cell(ptEsc(PT_FUT)+' @ Exit',ptFmt(t.xSpot),'#fff')
      +cell('Option LTP @ Exit',ptFmt(t.xOpt),'#60a5fa')
      +cell('Future Move (pts)',movePts!=null?(movePts>=0?'+':'')+movePts+' pts':'—',movePts==null?'#c8d8f0':movePts>=0?'#10b981':'#ef4444',t.side==='PE'?'Entry−Exit (PE profits on fall)':'Exit−Entry (CE profits on rise)')
      +cell('Option Δ (pts)',optDiff!=null?(optDiff>=0?'▲ +':'▼ ')+optDiff+' pts':'—',optDiff==null?'#c8d8f0':optDiff>=0?'#10b981':'#ef4444')
      +cell('Peak Premium',t.peakOpt!=null?ptFmt(t.peakOpt):'—','#a78bfa',peakSub)
      +cell('Net PnL',t.pnl!=null?(t.pnl>=0?'+':'')+ptFmt(t.pnl):'—',pc,'After ₹'+(t.charges||0)+' charges'))
    +'<div style="background:#060910;border:1px solid #1a2236;border-radius:10px;padding:12px 14px;">'
    +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted-2,#6d85a8);margin-bottom:6px;font-weight:700;">📌 Exit Reason</div>'
    +'<div style="font-size:0.82rem;color:#a0b8d0;line-height:1.6;font-family:monospace;">'+(ptEsc(t.reason)||'—')+'</div></div>';
  document.getElementById('ptModal').style.display='flex';
}
document.getElementById('ptModal').addEventListener('click',function(e){ if(e.target===this) this.style.display='none'; });
function copyTradeLog(btn){
  var lines=['Side\\tDate\\tEntry\\tEntry Time\\tExit\\tExit Time\\tSL\\tPnL\\tEntry Reason\\tExit Reason'];
  PT_ALL.forEach(function(t){
    lines.push([t.side,ptFmtDate(t.entry),t.eSpot,ptFmtTime(t.entry),t.xSpot,ptFmtTime(t.exit),t.eSl==null?'':t.eSl,t.pnl!=null?t.pnl.toFixed(2):'',t.entryReason,t.reason].join('\\t'));
  });
  var text=lines.join('\\n'), orig=btn.textContent;
  function ok(){ btn.classList.add('copied'); btn.textContent='✅ Copied!'; setTimeout(function(){ btn.classList.remove('copied'); btn.textContent=orig; },2000); }
  function fallback(){ var ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); ok(); }
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok).catch(fallback); else fallback();
}
ptFilter();
</script>`;
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
.cx-chart{position:relative;height:400px;border:1px solid #1a2236;border-radius:12px;overflow:hidden;background:#0a0f1c;margin-bottom:24px;}
.cx-legend{position:absolute;top:10px;left:12px;right:70px;font-size:0.68rem;color:var(--muted-1,#8ba1c2);pointer-events:none;z-index:2;}
.pt-th{padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);cursor:pointer;white-space:nowrap;}
.pt-eye-btn{background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;min-width:44px;min-height:36px;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;}
.pt-eye-btn:hover{border-color:#3b82f6;background:#0a1e3d;}
.pt-pg{background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 10px;border-radius:6px;font-size:0.72rem;cursor:pointer;min-height:32px;}
.pt-pg.on{background:#0a1e3d;border-color:#1d3b6e;color:#3b82f6;}
.rule-list{margin:8px 0 0;padding-left:18px;color:var(--muted-1,#8ba1c2);font-size:0.75rem;line-height:1.7;}
.rule-list b{color:#cbd5e1;font-weight:600;}
@media (max-width:640px){ .cx-card{padding:12px;} .cx-row{font-size:0.76rem;gap:8px 14px;} .cx-chart{height:320px;} .cx-legend{right:12px;} .cx-flat-btns .cx-btn{flex:1;} #logSearch{width:100%!important;} }`;

  // `monitor` is the same session in the field names the Real-Time monitor reads
  // from every NIFTY strategy — see monitorView().
  router.get("/status/data", (req, res) => {
    const s = engine.snapshot();
    res.json({ ...s, monitor: monitorView(s) });
  });
  router.get("/status/fragment", (req, res) => {
    const s = engine.snapshot();
    res.json({
      top: topFragment(s), info: infoFragment(s), bar: s.formingBar || null,
      trades: s.trades.slice().reverse().map(tradeView), logs: s.logs.slice().reverse(), logTotal: s.logTotal,
    });
  });
  router.get("/status/chart-data", (req, res) => res.json(engine.chartData()));
  // The whole in-memory day log as plain text, oldest first — for copy/analysis.
  router.get("/status/log", (req, res) => res.type("text/plain; charset=utf-8").send(engine.fullLog()));

  router.get("/status", (req, res) => {
    const s = engine.snapshot();
    const c = s.cfg;
    const msg = req.query.msg ? `<div class="cx-note cx-warn">${esc(req.query.msg)}</div>` : "";
    const off = modeOn() ? "" : `<div class="cx-note cx-warn">This strategy is switched off. Turn on <b>${modeKey()}</b> in Settings → Menu Visibility to start it.</div>`;
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
${bbRsiCurrentBar({ bar: s.formingBar, resMin: c.res })}
<div class="section-title">${esc(s.underlying.label)} future · ${c.res}-Min Chart</div>
<div class="cx-chart"><div id="cx-chart" style="width:100%;height:100%;"></div>
  <div class="cx-legend">
    <span style="color:#3b82f6;">▲ Entry</span> &nbsp; <span style="color:#10b981;">▼ Win</span> &nbsp; <span style="color:#ef4444;">▼ Loss</span> &nbsp;
    <span style="color:#fbbf24;">── <span id="lg-fast">Fast EMA</span></span> &nbsp; <span style="color:#3b82f6;">── <span id="lg-slow">Slow EMA</span></span> &nbsp;
    <span style="color:#22c55e;">──</span><span style="color:#ef4444;">──</span> ST &nbsp; <span style="color:#22d3ee;">── RSI</span> &nbsp; <span style="color:#f59e0b;">╌╌ SL</span>
  </div>
</div>
${sessionTradesHTML(s)}
${bbRsiActivityLog({ logsJSON: jsonForScript(s.logs.slice().reverse()) })}
<div style="margin:-10px 0 18px;"><a class="cx-a" id="cx-fulllog" style="font-size:0.72rem;" href="${base}/status/log" target="_blank">Full day log (${s.logTotal} lines) →</a></div>
<div id="cx-info">${infoFragment(s)}</div>
</div>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
<script>
(function(){
  var top=document.getElementById('cx-top'), info=document.getElementById('cx-info');
  var lastTrades=JSON.stringify(PT_ALL), lastLogs=JSON.stringify(LOG_ALL);
  var inr=function(n){ return typeof n==='number' ? '₹'+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; };
  function tick(){
    if(document.hidden) return;
    fetch('${base}/status/fragment',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){
      if(!d) return;
      top.innerHTML=d.top; info.innerHTML=d.info;
      ['open','high','low','close'].forEach(function(k){ var el=document.getElementById('ajax-bar-'+k); if(el) el.textContent=d.bar?inr(d.bar[k]):'—'; });
      // Swap in the new rows but keep the viewer's filters and page.
      var t=JSON.stringify(d.trades);
      if(t!==lastTrades){ lastTrades=t; PT_ALL=d.trades; var pp=ptPage; ptFilter(); ptGo(pp); }
      var l=JSON.stringify(d.logs);
      if(l!==lastLogs){ lastLogs=l; LOG_ALL=d.logs; var lp=logPg; logFilter(); logGo(lp); }
      var fl=document.getElementById('cx-fulllog'); if(fl) fl.textContent='Full day log ('+d.logTotal+' lines) →';
    }).catch(function(){});
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
      document.getElementById('lg-fast').textContent='EMA'+d.emaFastLen; document.getElementById('lg-slow').textContent='EMA'+d.emaSlowLen;
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

  // Every recorded day as one session card — the same History page every NIFTY
  // paper strategy renders (utils/paperHistoryUI). ?date=YYYY-MM-DD opens that
  // day (the Consolidation Report links here). Replay can't run MCX, so no
  // "View chart"; the contract note carries the flat MCX charge each trade booked.
  router.get("/history", (req, res) => {
    const s = engine.snapshot();
    const sessions = engine.historyDays().slice().reverse().map((d) => ({
      date: d.day, strategy: s.label, pnl: d.pnl,
      trades: d.trades.map((t) => ({
        ...t, entryTime: istStamp(t.entryTime), exitTime: istStamp(t.exitTime),
        entryReason: t.reason, optionStrike: t.strike, optionType: t.side, optionExpiry: t.expiry,
        qty: t.lots * t.multiplier,
      })),
    }));
    res.send(renderHistoryPage({
      routePrefix: base,
      sidebarKey: navKey,
      pageTitle: `${icon} ${esc(title)} Paper Trade History`,
      pageDocTitle: `${title} Paper — History`,
      modalLabel: `${title} Paper`,
      liveActive: false,
      sessions,
      capital: Math.round((s.cfg.startCap + s.allTime) * 100) / 100,
      totalPnl: s.allTime,
      startCap: s.cfg.startCap,
      emptyLabel: `Start ${title} paper trading to record your first session.`,
      replayMode: "",
      contractRow: mcxContractRow,
    }));
  });
  router.delete("/session/:idx", (req, res) => {
    const days = engine.historyDays().slice().reverse();   // the page's oldest-first order
    const d = days[parseInt(req.params.idx, 10)];
    if (!d) return res.status(404).json({ success: false, error: "Session not found — reload the page." });
    const r = engine.deleteDay(d.day);
    return r.ok ? res.json({ success: true }) : res.status(400).json({ success: false, error: r.reason });
  });
  // The History page's Daily Data Files panel. Commodity pages keep no per-day
  // JSONL, so it always lists none.
  router.get("/download/daily-files", (req, res) => res.json(dailyFilesPaginate([], req.query)));

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
    // The History page's Reset is a fetch() and reads JSON back too.
    if (req.headers && (req.headers["x-paper-reset"] || req.get("sec-fetch-dest") === "empty")) {
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
// The page's own icon, for the monitors that list a commodity page — 🛢 only
// fits CRUDE.
const commodityIcon = (commodity) => ICONS[commodity] || "🛢️";

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
    logs: s.logs.slice(-100).reverse(),
    logTotal: s.logTotal,
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

module.exports = { createCommodityPaperRouter, commodityPage, commodityIcon, enabledEngines, visibleEngines, anyRunning, monitorView, fyersTokenHoldUntil };

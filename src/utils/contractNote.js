/**
 * contractNote.js — broker-style contract note (gross, charges breakdown, net).
 * ─────────────────────────────────────────────────────────────────────────────
 * Produces a Zerodha-style contract note for a set of trades: a per-trade row
 * (segment / exchange / buy / sell / qty / gross), totals, and a charges
 * breakdown (brokerage, exchange txn, stamp duty, STT, GST, SEBI). It is shared
 * by the Paper Trade History pages (via paperHistoryUI.js) and the Replay page.
 *
 * Charges are computed with the SAME canonical calcCharges() used by every
 * paper/live/replay engine, so the note's numbers match what the dashboard
 * shows. Net P&L is anchored to the trade's stored `pnl` (the net-of-charges
 * value displayed everywhere) and gross is derived as net + charges, so the
 * note's arithmetic is always self-consistent: gross − charges = net.
 *
 * Server-side (Node):  contractRow(), attachContractNotes(), brokerForMode()
 * Client-side (string): contractNoteModalHTML(), contractNoteClientJS()
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { calcCharges, getCharges } = require("./charges");

function _num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map a route prefix ('/scalp-paper') or strategy mode ('scalp-paper') to the
 * broker whose charge schedule applies. Swing trades on Zerodha (Kite / env
 * default rates → broker undefined); every other strategy trades on Fyers.
 */
function brokerForMode(modeOrPrefix) {
  return /swing/i.test(String(modeOrPrefix || "")) ? undefined : "fyers";
}
const brokerForRoute = brokerForMode;

/**
 * Build one contract-note row for a single trade object.
 * @param {Object} t       trade record (paper/live/replay shape)
 * @param {string} [broker] "fyers" or undefined (Kite/default)
 */
function contractRow(t, broker) {
  const isFutures = !!t.isFutures;
  const optEntry = _num(t.optionEntryLtp);
  const optExit = _num(t.optionExitLtp);

  let buy, sell, segment;
  if (!isFutures && (optEntry !== null || optExit !== null)) {
    buy = optEntry;
    sell = optExit;
    segment = "F&O - Options";
  } else {
    buy = _num(t.spotAtEntry !== undefined ? t.spotAtEntry : t.entryPrice);
    sell = _num(t.spotAtExit !== undefined ? t.spotAtExit : t.exitPrice);
    segment = isFutures ? "F&O - Futures" : "F&O - Options";
  }
  const qty = _num(t.qty);

  let charges;
  if (buy !== null && sell !== null && qty !== null) {
    charges = calcCharges({ broker, isFutures, entryPremium: buy, exitPremium: sell, qty });
  } else {
    // No premium/price data recorded — fall back to the flat estimate that the
    // engines themselves use, surfacing brokerage and lumping the remainder.
    const total = getCharges({ broker, isFutures, entryPremium: buy, exitPremium: sell, qty: qty || 1 });
    charges = { stt: 0, exchangeTxn: 0, sebi: 0, gst: 0, stampDuty: 0, brokerage: 40, total, estimated: true };
  }

  const net = (typeof t.pnl === "number")
    ? t.pnl
    : (buy !== null && sell !== null && qty !== null)
      ? parseFloat(((sell - buy) * qty - charges.total).toFixed(2))
      : 0;
  const gross = parseFloat((net + charges.total).toFixed(2));

  return {
    side: t.side || t.optionType || "",
    segment,
    exchange: "NSE",
    buy, sell, qty, gross, net,
    strike: t.optionStrike != null ? t.optionStrike : null,
    symbol: t.optionSymbol || t.symbol || null,
    date: t.date || (t.entryTime ? String(t.entryTime).split(",")[0].trim() : null),
    charges: {
      stt: charges.stt, exchangeTxn: charges.exchangeTxn, sebi: charges.sebi,
      gst: charges.gst, stampDuty: charges.stampDuty, brokerage: charges.brokerage,
      total: charges.total, estimated: !!charges.estimated,
    },
  };
}

/** Return a copy of `trades` with a `_cn` contract-note row attached to each. */
function attachContractNotes(trades, broker) {
  if (!Array.isArray(trades)) return trades;
  return trades.map(t => (t && typeof t === "object") ? Object.assign({}, t, { _cn: contractRow(t, broker) }) : t);
}

// ── Client-side assets (returned as strings, embedded into the page) ──────────

/** The contract-note modal shell (white "document" styled for screen + print). */
function contractNoteModalHTML() {
  return `
<div id="cnModal" style="display:none;position:fixed;inset:0;z-index:11000;background:rgba(0,0,0,0.78);backdrop-filter:blur(3px);align-items:flex-start;justify-content:center;padding:28px 16px;overflow:auto;">
  <div id="cnDoc" style="background:#ffffff;color:#1f2733;border-radius:14px;max-width:840px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,0.55);font-family:Inter,system-ui,sans-serif;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:15px 22px;border-bottom:1px solid #eef0f3;">
      <div style="font-size:0.72rem;font-weight:700;color:#6b7280;letter-spacing:0.06em;">CONTRACT NOTE</div>
      <div style="display:flex;gap:8px;">
        <button onclick="exportContractNotePDF()" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:7px 14px;font-size:0.8rem;font-weight:600;cursor:pointer;">📄 Export PDF</button>
        <button onclick="closeContractNote()" style="background:#f1f3f5;color:#374151;border:0;border-radius:7px;padding:7px 12px;font-size:0.8rem;font-weight:600;cursor:pointer;">✕ Close</button>
      </div>
    </div>
    <div id="cn-body" style="padding:6px 26px 26px;"></div>
  </div>
</div>`;
}

/**
 * Page-agnostic client JS. Exposes:
 *   openContractNoteFor(title, sub, trades, fileBase) — render + show the modal
 *   closeContractNote()                               — hide the modal
 *   exportContractNotePDF()                           — open print window (Save as PDF)
 * Each trade in `trades` must carry a server-computed `_cn` row.
 */
function contractNoteClientJS() {
  return `
var _CN_DOC = { title:'', sub:'', body:'', file:'contract-note' };

function _cnMoney(v){ if(v===null||v===undefined||!isFinite(v)) return '—'; var s=(Math.abs(v)).toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g,','); return (v<0?'-₹':'₹')+s; }
function _cnPlain(v){ if(v===null||v===undefined||!isFinite(v)) return '—'; return Number(v).toFixed(2); }
function _cnEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function _cnAggregate(trades){
  var rows=[], T={stt:0,exchangeTxn:0,sebi:0,gst:0,stampDuty:0,brokerage:0,total:0}, gross=0, net=0, est=false;
  for(var i=0;i<(trades||[]).length;i++){
    var t=trades[i]; if(!t||!t._cn) continue; var cn=t._cn, c=cn.charges||{};
    rows.push(cn);
    T.stt+=(+c.stt||0); T.exchangeTxn+=(+c.exchangeTxn||0); T.sebi+=(+c.sebi||0);
    T.gst+=(+c.gst||0); T.stampDuty+=(+c.stampDuty||0); T.brokerage+=(+c.brokerage||0); T.total+=(+c.total||0);
    gross+=(+cn.gross||0); net+=(+cn.net||0); if(c.estimated) est=true;
  }
  for(var k in T){ T[k]=Math.round(T[k]*100)/100; }
  return { rows:rows, charges:T, gross:Math.round(gross*100)/100, net:Math.round(net*100)/100, count:rows.length, estimated:est };
}

function _cnRenderDoc(title, sub, agg){
  var h='';
  h+='<div style="text-align:center;padding:16px 0 12px;"><div style="font-size:1.25rem;font-weight:700;color:#111827;">'+_cnEsc(title)+'</div>';
  if(sub) h+='<div style="font-size:0.8rem;color:#6b7280;margin-top:3px;">'+_cnEsc(sub)+'</div>';
  h+='</div>';
  if(!agg.count){ h+='<div style="padding:24px;text-align:center;color:#9ca3af;">No trades to report.</div>'; return h; }
  h+='<table style="width:100%;border-collapse:collapse;font-size:0.82rem;">';
  h+='<thead><tr style="background:#f3f4f6;color:#374151;text-align:left;">'
    +'<th style="padding:8px 10px;">#</th><th style="padding:8px 10px;">Segment</th><th style="padding:8px 10px;">Exchange</th>'
    +'<th style="padding:8px 10px;text-align:right;">Buy Price</th><th style="padding:8px 10px;text-align:right;">Sell Price</th>'
    +'<th style="padding:8px 10px;text-align:right;">Qty</th><th style="padding:8px 10px;text-align:right;">Gross profit</th></tr></thead><tbody>';
  for(var i=0;i<agg.rows.length;i++){
    var r=agg.rows[i], gpos=(+r.gross>=0);
    var sideTag = r.side ? (' <span style="color:#6b7280;">'+_cnEsc(r.side)+(r.strike?(' '+_cnEsc(r.strike)):'')+'</span>') : '';
    h+='<tr style="border-bottom:1px solid #eef0f3;">'
      +'<td style="padding:7px 10px;color:#6b7280;">'+(i+1)+'</td>'
      +'<td style="padding:7px 10px;">'+_cnEsc(r.segment)+sideTag+'</td>'
      +'<td style="padding:7px 10px;">'+_cnEsc(r.exchange)+'</td>'
      +'<td style="padding:7px 10px;text-align:right;">'+_cnPlain(r.buy)+'</td>'
      +'<td style="padding:7px 10px;text-align:right;">'+_cnPlain(r.sell)+'</td>'
      +'<td style="padding:7px 10px;text-align:right;">'+(r.qty==null?'—':r.qty)+'</td>'
      +'<td style="padding:7px 10px;text-align:right;font-weight:600;color:'+(gpos?'#047857':'#b91c1c')+';">'+(+r.gross).toFixed(2)+'</td>'
      +'</tr>';
  }
  h+='</tbody></table>';
  var npos=(agg.net>=0);
  h+='<div style="display:flex;flex-wrap:wrap;gap:18px;justify-content:space-between;padding:16px 6px 8px;border-top:1px solid #eef0f3;margin-top:2px;">';
  h+='<div><div style="font-size:0.66rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;">Total gross profit</div><div style="font-size:1.05rem;font-weight:700;color:#111827;">'+_cnMoney(agg.gross)+'</div></div>';
  h+='<div><div style="font-size:0.66rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;">Total charges</div><div style="font-size:1.05rem;font-weight:700;color:#b91c1c;">'+_cnMoney(agg.charges.total)+'</div></div>';
  h+='<div><div style="font-size:0.66rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;">Net P&amp;L</div><div style="font-size:1.05rem;font-weight:800;color:'+(npos?'#047857':'#b91c1c')+';">'+_cnMoney(agg.net)+'</div></div>';
  h+='</div>';
  h+='<div style="margin-top:18px;"><div style="font-size:0.92rem;font-weight:700;color:#111827;margin-bottom:11px;">Charges breakdown</div>';
  h+='<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px 20px;font-size:0.82rem;">';
  function cnRow(lbl,val){ return '<div style="display:flex;justify-content:space-between;border-bottom:1px dashed #e5e7eb;padding-bottom:4px;"><span style="color:#6b7280;">'+lbl+'</span><span style="color:#111827;font-weight:600;">'+val+'</span></div>'; }
  h+=cnRow('Brokerage', _cnPlain(agg.charges.brokerage));
  h+=cnRow('Exchange txn charge', _cnPlain(agg.charges.exchangeTxn));
  h+=cnRow('Stamp duty', _cnPlain(agg.charges.stampDuty));
  h+=cnRow('STT', _cnPlain(agg.charges.stt));
  h+=cnRow('GST', _cnPlain(agg.charges.gst));
  h+=cnRow('SEBI charges', _cnPlain(agg.charges.sebi));
  h+='</div>';
  if(agg.estimated) h+='<div style="margin-top:11px;font-size:0.72rem;color:#b45309;">⚠ Some trades had no recorded premium — their charges use a flat estimate.</div>';
  h+='<div style="margin-top:12px;font-size:0.72rem;color:#9ca3af;line-height:1.5;">Net P&amp;L is net of all statutory &amp; brokerage charges and matches the dashboard P&amp;L. Slippage / bid-ask spread is not modelled.</div>';
  h+='</div>';
  return h;
}

function openContractNoteFor(title, sub, trades, fileBase){
  var agg=_cnAggregate(trades);
  var body=_cnRenderDoc(title, sub, agg);
  _CN_DOC={ title:title, sub:sub||'', body:body, file:(fileBase||'contract-note') };
  var bodyEl=document.getElementById('cn-body'); if(bodyEl) bodyEl.innerHTML=body;
  var m=document.getElementById('cnModal'); if(m) m.style.display='flex';
}
function closeContractNote(){ var m=document.getElementById('cnModal'); if(m) m.style.display='none'; }

function exportContractNotePDF(){
  var w=window.open('', '_blank');
  if(!w){ alert('Pop-up blocked — allow pop-ups for this site to export the contract note as PDF.'); return; }
  var doc='<!DOCTYPE html><html><head><meta charset="utf-8"><title>'+_cnEsc(_CN_DOC.file)+'</title>'
    +'<style>body{font-family:Inter,Arial,sans-serif;color:#1f2733;margin:22px;}table{width:100%;}@media print{@page{margin:14mm;}}</style></head><body>'
    + _CN_DOC.body + '</body></html>';
  w.document.open(); w.document.write(doc); w.document.close();
  w.focus();
  setTimeout(function(){ try{ w.print(); }catch(e){} }, 350);
}

if(document.getElementById('cnModal')){
  document.getElementById('cnModal').addEventListener('click', function(e){ if(e.target===this) this.style.display='none'; });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ var m=document.getElementById('cnModal'); if(m&&m.style.display!=='none') m.style.display='none'; } });
}
`;
}

module.exports = {
  contractRow,
  attachContractNotes,
  brokerForMode,
  brokerForRoute,
  contractNoteModalHTML,
  contractNoteClientJS,
};

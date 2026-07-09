/**
 * backtestAiExport.js — client-side "AI-friendly" Markdown download for the
 * backtest results pages.
 * ─────────────────────────────────────────────────────────────────────────────
 * The paper-trade pages download AI reports server-side via utils/aiExport (they
 * have JSONL day files on disk to feed it). Backtest results are ephemeral —
 * computed per request / held in a job — so there is no stable file to hand the
 * server-side builder. Instead this module returns a self-contained button + a
 * <script> snippet that build the SAME shape of Markdown report in the browser
 * from the `TRADES` array already embedded in every backtest page, then download
 * it as a .md file the user can paste straight into an AI.
 *
 * Every backtest page (bb_rsi / pa / ema9vwap / ema_rsi_st bespoke renders +
 * the shared utils/backtestUI ORB render) embeds trades with the same client
 * schema: { side, entry, exit, ePrice, xPrice, sl, pnl, entryReason, reason }.
 * Keep the field legend / section order in sync with utils/aiExport.js so the two
 * download paths read the same when pasted into an AI.
 *
 * Usage (server-side, inside the page template):
 *   const { aiExportButton, aiExportScriptTag } = require("../utils/backtestAiExport");
 *   ... ${aiExportButton()} ...                       // in the trade-log toolbar
 *   ... ${aiExportScriptTag({ mode: "BB_RSI", strategyName, from, to,
 *                             optionSim: !!s.optionSim, fullCount: tradesData.length })}
 */

// The toolbar button. Reuses the `.copy-btn` class that every backtest page
// already defines, so it matches the neighbouring "Copy Trade Log" button.
function aiExportButton() {
  return '<button class="copy-btn" onclick="downloadAiTradeLog(this)" '
    + 'title="Download an AI-friendly Markdown report (summary + field legend + trade table) — paste it into an AI to analyse the backtest">'
    + '🤖 Download for AI</button>';
}

/**
 * The <script> snippet that defines window.downloadAiTradeLog(btn).
 * @param {object} cfg
 * @param {string} cfg.mode          strategy label for the header/filename (e.g. "BB_RSI")
 * @param {string} cfg.strategyName  human strategy name for the header
 * @param {string} cfg.from          range start (YYYY-MM-DD)
 * @param {string} cfg.to            range end (YYYY-MM-DD)
 * @param {boolean} cfg.optionSim    true → P&L is ₹ (δ+θ sim); false → NIFTY pts
 * @param {number} [cfg.fullCount]   full trade count if the embedded set is capped
 * @param {{key:string,label:string}[]} [cfg.extraCols]  strategy-specific columns
 */
function aiExportScriptTag(cfg) {
  const safe = {
    mode: String(cfg.mode || "Backtest"),
    strategyName: String(cfg.strategyName || cfg.mode || "Strategy"),
    from: String(cfg.from || ""),
    to: String(cfg.to || ""),
    optionSim: !!cfg.optionSim,
    fullCount: cfg.fullCount != null ? Number(cfg.fullCount) : null,
    extraCols: Array.isArray(cfg.extraCols)
      ? cfg.extraCols.map(c => ({ key: String(c.key), label: String(c.label) }))
      : [],
  };
  return `<script>
(function(){
  var CFG = ${JSON.stringify(safe)};
  function _num(v){ return (typeof v==='number' && isFinite(v)) ? v : null; }
  function _fmtNum(v){ if(v==null||!isFinite(v)) return String(v); return Number.isInteger(v)?String(v):(Math.round(v*100)/100).toString(); }
  function _unit(){ return CFG.optionSim ? '₹' : 'pts'; }
  function _pnl(v){ var n=_num(v); if(n===null) return '—'; return (n>=0?'+':'')+_fmtNum(n); }
  // One-line, pipe-escaped cell for a Markdown table.
  function _cell(v){ if(v==null) return ''; var s=(typeof v==='object')?JSON.stringify(v):String(v); s=s.replace(/\\r?\\n/g,' ').replace(/\\|/g,'\\\\|'); if(s.length>140) s=s.slice(0,139)+'…'; return s; }
  // Trade entry/exit are "DD/MM/YYYY, HH:MM:SS" strings.
  function _date(dt){ return dt ? (String(dt).split(', ')[0]||'') : ''; }
  function _time(dt){ if(!dt) return ''; var p=String(dt).split(', '); return p[1]||''; }
  function _build(trades){
    var out=[];
    out.push('# '+CFG.mode+' Backtest — '+CFG.strategyName+' — AI-friendly export');
    var wins=[], losses=[], net=0, gp=0, gl=0;
    trades.forEach(function(t){ var p=_num(t.pnl); if(p==null) return; net+=p; if(p>0){wins.push(t);gp+=p;} else if(p<0){losses.push(t);gl+=(-p);} });
    var aw=wins.length?gp/wins.length:0, al=losses.length?-(gl/losses.length):0;
    var decided=wins.length+losses.length, wp=decided?Math.round(wins.length/decided*100):0;
    var pf=gl>0?(gp/gl).toFixed(2):(gp>0?'∞':'0');
    var meta=['Source: '+CFG.mode+' Backtest', 'Range: '+CFG.from+' → '+CFG.to, trades.length+' trades'];
    if(CFG.fullCount && CFG.fullCount>trades.length) meta.push('(page shows latest '+trades.length+' of '+CFG.fullCount+')');
    out.push('> '+meta.join(' · '));
    out.push('>');
    out.push('> Backtest P&L is a δ+θ option-premium **simulation** (no live option chain), so treat absolute numbers as directional only. Structured for AI analysis: summary stats, a field legend, then the trades.');
    out.push('');
    out.push('## Summary');
    out.push('| Trades | Wins | Losses | Win % | Net P&L ('+_unit()+') | Avg win | Avg loss | Profit factor |');
    out.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    out.push('| '+trades.length+' | '+wins.length+' | '+losses.length+' | '+wp+'% | '+_pnl(net)+' | '+(wins.length?_pnl(aw):'—')+' | '+(losses.length?_pnl(al):'—')+' | '+pf+' |');
    out.push('');
    out.push('## Field legend');
    var L=[];
    L.push('- \`date\` — Trade date, IST.');
    L.push('- \`entryTime\` / \`exitTime\` — Entry / exit time, IST.');
    L.push('- \`side\` — CE = call (bullish bet) · PE = put (bearish bet).');
    L.push('- \`entrySpot\` / \`exitSpot\` — NIFTY spot index level at entry / exit.');
    L.push('- \`sl\` — Stop-loss spot level set at entry.');
    (CFG.extraCols||[]).forEach(function(c){ L.push('- \`'+c.key+'\` — '+c.label+' (strategy-specific).'); });
    L.push('- \`pnl\` — Simulated profit/loss for the trade ('+_unit()+', negative = loss).');
    L.push('- \`entryReason\` — Signal/condition that triggered entry.');
    L.push('- \`exitReason\` — What closed the trade (target, stop-loss, trail, EOD, etc.).');
    out.push(L.join('\\n'));
    out.push('');
    out.push('## Trades');
    var extra=CFG.extraCols||[];
    var head=['Date','Entry Time','Exit Time','Side','Entry Spot','Exit Spot','SL']
      .concat(extra.map(function(c){return c.label;}))
      .concat(['PnL ('+_unit()+')','Entry Reason','Exit Reason']);
    out.push('| '+head.join(' | ')+' |');
    out.push('| '+head.map(function(){return '---';}).join(' | ')+' |');
    trades.forEach(function(t){
      var row=[_date(t.entry),_time(t.entry),_time(t.exit),(t.side||''),_cell(t.ePrice),_cell(t.xPrice),(t.sl!=null?_cell(t.sl):'')];
      extra.forEach(function(c){ row.push(_cell(t[c.key])); });
      row.push(_pnl(t.pnl)); row.push(_cell(t.entryReason)); row.push(_cell(t.reason));
      out.push('| '+row.join(' | ')+' |');
    });
    out.push('');
    return out.join('\\n')+'\\n';
  }
  window.downloadAiTradeLog=function(btn){
    var trades=(window.TRADES||[]).slice();
    if(!trades.length){ if(btn){ var o0=btn.textContent; btn.textContent='No trades'; setTimeout(function(){btn.textContent=o0;},1500); } return; }
    var md=_build(trades);
    var blob=new Blob([md],{type:'text/markdown;charset=utf-8'});
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');
    a.href=url;
    a.download=(CFG.mode+'-backtest-'+CFG.from+'-to-'+CFG.to+'.md').replace(/[^a-zA-Z0-9._-]/g,'-');
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){URL.revokeObjectURL(url);},1500);
    if(btn){ var o=btn.getAttribute('data-lbl')||btn.textContent; btn.setAttribute('data-lbl',o); btn.classList.add('copied'); btn.textContent='✅ Downloaded'; setTimeout(function(){btn.textContent=o;btn.classList.remove('copied');},1800); }
  };
})();
</script>`;
}

module.exports = { aiExportButton, aiExportScriptTag };

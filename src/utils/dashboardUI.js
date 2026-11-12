/**
 * dashboardUI.js — the pieces the Dashboard (app.js "/") and the Real-Time
 * Monitor (routes/realtime.js) share: today's P&L hero with one chip per market,
 * the market filter, the market-grouped summary table, and the quick links.
 * ─────────────────────────────────────────────────────────────────────────────
 * Server side it renders static HTML from dashboardModel rows; client side
 * (dashClientJS) it fills the numbers in from whatever the page already polls —
 * it never fetches anything itself, so it adds no broker or status calls.
 *
 * Colours are --dh-* tokens on :root with a light-theme override under
 * :root[data-theme="light"] (utils/theme.js stamps that attribute server-side).
 * The filter choice is remembered per device in localStorage, every access
 * wrapped in try/catch — a private window or blocked storage just means "All".
 * ─────────────────────────────────────────────────────────────────────────────
 */

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function dashCSS() {
  return `
  :root {
    --dh-card:#0a1628; --dh-card-2:#0e1c33; --dh-inset:#040c18; --dh-border:#1c2c47; --dh-line:#15243d;
    --dh-text:#e0eaf8; --dh-muted:#8ba1c2; --dh-dim:#7d8aa3;
    --dh-pos:#10b981; --dh-neg:#ef4444; --dh-zero:#94a3b8; --dh-focus:#38bdf8; --dh-blue:#3b82f6;
  }
  :root[data-theme="light"] {
    --dh-card:#ffffff; --dh-card-2:#f1f5f9; --dh-inset:#f8fafc; --dh-border:#e0e4ea; --dh-line:#e8ecf1;
    --dh-text:#1e293b; --dh-muted:#4b5769; --dh-dim:#5c6b7f;
    --dh-pos:#059669; --dh-neg:#dc2626; --dh-zero:#4b5769; --dh-focus:#2563eb; --dh-blue:#2563eb;
  }
  .dh-pos { color:var(--dh-pos) !important; }
  .dh-neg { color:var(--dh-neg) !important; }
  .dh-zero { color:var(--dh-zero) !important; }
  .dh-off { display:none !important; }
  .dh-num { font-variant-numeric:tabular-nums; white-space:nowrap; }

  /* ── Today's P&L hero ── */
  .dh-hero { background:var(--dh-card); border:1px solid var(--dh-border); border-radius:12px; padding:14px 16px; margin-bottom:12px; display:flex; flex-wrap:wrap; align-items:center; gap:12px 20px; }
  .dh-hero-main { display:flex; flex-direction:column; gap:2px; min-width:0; }
  .dh-hero-cap { font-size:0.7rem; font-weight:700; letter-spacing:0.8px; text-transform:uppercase; color:var(--dh-muted); }
  .dh-hero-total { font-size:2.1rem; font-weight:700; line-height:1.1; font-variant-numeric:tabular-nums; color:var(--dh-zero); }
  .dh-hero-sub { font-size:0.74rem; color:var(--dh-dim); }
  .dh-chips { display:flex; flex-wrap:wrap; gap:8px; flex:1 1 280px; justify-content:flex-end; }
  .dh-chip { display:inline-flex; flex-direction:column; align-items:flex-start; justify-content:center; gap:1px; min-height:44px; min-width:92px; padding:5px 12px; border-radius:10px; border:1px solid var(--dh-border); background:var(--dh-inset); color:var(--dh-text); font:inherit; cursor:pointer; text-align:left; }
  .dh-chip:hover { border-color:var(--dh-focus); }
  .dh-chip:focus-visible, .dh-fbtn:focus-visible, .dh-link:focus-visible { outline:2px solid var(--dh-focus); outline-offset:2px; }
  .dh-chip.active { border-color:var(--dh-focus); box-shadow:inset 0 0 0 1px var(--dh-focus); }
  .dh-chip-k { font-size:0.62rem; font-weight:700; letter-spacing:0.6px; color:var(--dh-muted); }
  .dh-chip-v { font-size:0.92rem; font-weight:700; font-variant-numeric:tabular-nums; color:var(--dh-zero); }

  /* ── Market filter — one scrollable row; it never widens the page ── */
  .dh-filter { display:flex; gap:6px; overflow-x:auto; -webkit-overflow-scrolling:touch; scrollbar-width:none; margin:0 0 14px; padding-bottom:2px; }
  .dh-filter::-webkit-scrollbar { display:none; }
  .dh-fbtn { flex:0 0 auto; min-height:44px; padding:0 14px; border-radius:22px; border:1px solid var(--dh-border); background:var(--dh-card); color:var(--dh-muted); font:inherit; font-size:0.8rem; font-weight:600; cursor:pointer; white-space:nowrap; }
  .dh-fbtn:hover { color:var(--dh-text); border-color:var(--dh-focus); }
  .dh-fbtn.active { background:var(--dh-blue); border-color:var(--dh-blue); color:#fff; }

  /* ── Section headings ── */
  .dh-h { display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin:18px 0 8px; }
  .dh-h h2 { margin:0; font-size:0.8rem; font-weight:700; letter-spacing:0.8px; text-transform:uppercase; color:var(--dh-muted); }
  .dh-h .dh-h-note { font-size:0.72rem; color:var(--dh-dim); }
  .dh-mhead { display:flex; align-items:center; gap:8px; margin:12px 0 8px; font-size:0.76rem; font-weight:700; letter-spacing:0.7px; color:var(--dh-text); }
  .dh-mhead::after { content:""; flex:1; height:1px; background:var(--dh-line); }
  .dh-mhead .dh-mtot { order:2; font-variant-numeric:tabular-nums; }

  /* ── Summary table: grouped by market, subtotal on each market row ── */
  .dh-sum { width:100%; border-collapse:collapse; background:var(--dh-card); border:1px solid var(--dh-border); border-radius:10px; overflow:hidden; color:var(--dh-text); }
  .dh-sum th { background:var(--dh-card-2); color:var(--dh-muted); font-size:0.7rem; font-weight:600; letter-spacing:0.4px; padding:7px 12px; text-align:right; border-bottom:1px solid var(--dh-border); }
  .dh-sum th:first-child, .dh-sum td:first-child { text-align:left; }
  .dh-sum td { padding:6px 12px; font-size:0.85rem; text-align:right; border-bottom:1px solid var(--dh-line); font-variant-numeric:tabular-nums; }
  .dh-sum td:first-child { font-weight:600; }
  .dh-sum td:first-child a { color:inherit; text-decoration:none; border-bottom:1px dotted currentColor; display:inline-block; padding:2px 0; }
  .dh-sum td:first-child a:hover { border-bottom-style:solid; }
  .dh-sum .dh-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px; background:var(--acc,#3b82f6); vertical-align:middle; }
  .dh-sum tr.dh-mrow td { background:var(--dh-card-2); font-weight:700; font-size:0.8rem; }
  .dh-sum tr.dh-mrow td:first-child { letter-spacing:0.7px; }
  .dh-sum tr.dh-quiet td { color:var(--dh-dim); font-weight:400; font-size:0.78rem; text-align:left; }
  .dh-sum tr.dh-grand td { background:var(--dh-card-2); font-weight:800; border-top:2px solid var(--dh-border); border-bottom:none; }
  .dh-sum .dh-st { font-size:0.68rem; font-weight:700; letter-spacing:0.4px; color:var(--dh-dim); }
  .dh-sum .dh-st.run { color:var(--dh-pos); }
  .dh-sum .dh-st.err { color:var(--dh-neg); }
  /* Split layout (opts.split): one small table per market, side by side on wide
     screens so a 4-column table does not stretch across the whole page. */
  .dh-sum-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(380px, 100%), 1fr)); gap:10px; align-items:start; }
  .dh-sum-grid .dh-sum-total { grid-column:1 / -1; }
  .dh-sum-empty { background:var(--dh-card); border:1px dashed var(--dh-border); border-radius:10px; padding:18px 16px; text-align:center; color:var(--dh-dim); font-size:0.84rem; }
  /* Phones: every row becomes a card — no horizontal page scroll, numbers
     still right-aligned against their labels. */
  @media (max-width:640px) {
    .dh-sum, .dh-sum tbody, .dh-sum tr, .dh-sum td { display:block; width:100%; }
    .dh-sum { background:transparent; border:none; }
    .dh-sum thead { display:none; }
    .dh-sum tbody { margin-bottom:10px; }
    .dh-sum tr { background:var(--dh-card); border:1px solid var(--dh-border); border-radius:10px; padding:6px 12px; margin-bottom:8px; display:grid; grid-template-columns:1fr 1fr; column-gap:14px; }
    .dh-sum td { border:none; padding:5px 0; display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:0.84rem; }
    .dh-sum td::before { content:attr(data-label); color:var(--dh-dim); font-size:0.7rem; font-weight:500; text-align:left; }
    .dh-sum td:first-child, .dh-sum td.dh-wide { grid-column:1 / -1; font-size:0.92rem; }
    .dh-sum td:first-child::before, .dh-sum tr.dh-quiet td::before { content:none; }
    .dh-sum tr.dh-mrow, .dh-sum tr.dh-grand { background:var(--dh-card-2); }
    .dh-sum tr.dh-mrow td, .dh-sum tr.dh-grand td { background:transparent; }
    .dh-sum tr.dh-grand { border-width:2px; }
    .dh-sum td.dh-daytot { grid-column:1 / -1; font-size:1rem; font-weight:700; border-top:1px solid var(--dh-line); padding-top:7px; margin-top:2px; }
    .dh-sum tr.dh-quiet { display:block; }
    .dh-sum td:first-child a { padding:6px 0; }
  }

  /* ── Quick links ── */
  .dh-links { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0 4px; }
  .dh-link { display:inline-flex; align-items:center; gap:6px; min-height:44px; padding:0 14px; border-radius:10px; border:1px solid var(--dh-border); background:var(--dh-card); color:var(--dh-text); font-size:0.8rem; font-weight:600; text-decoration:none; }
  .dh-link:hover { border-color:var(--dh-focus); }
  @media (max-width:640px) {
    .dh-hero { padding:12px 14px; }
    .dh-hero-total { font-size:1.9rem; }
    .dh-chips { justify-content:flex-start; flex-basis:100%; }
    .dh-chip { flex:1 1 calc(50% - 4px); min-width:0; }
    .dh-links { display:grid; grid-template-columns:1fr 1fr; }
    .dh-link { justify-content:center; }
  }`;
}

/** The hero: big total + one chip per market (button → filters to it). */
function heroHTML(marketGroups, { caption = "Today's P&L (open + closed)", sub = "" } = {}) {
  const chips = marketGroups.map((g) =>
    `<button type="button" class="dh-chip" data-dh-chip="${esc(g.key)}" title="Show only ${esc(g.label)}">`
    + `<span class="dh-chip-k">${esc(g.label)}</span><span class="dh-chip-v" id="dh-chip-${esc(g.key)}">—</span></button>`).join("");
  return `<section class="dh-hero" aria-label="Today's profit and loss">
    <div class="dh-hero-main">
      <span class="dh-hero-cap">${esc(caption)}</span>
      <span class="dh-hero-total" id="dh-hero-total" aria-live="polite">—</span>
      <span class="dh-hero-sub" id="dh-hero-sub">${esc(sub)}</span>
    </div>
    ${marketGroups.length > 1 ? `<div class="dh-chips">${chips}</div>` : ""}
  </section>`;
}

/** All / per-market filter buttons. Hidden when only one market is enabled. */
function filterHTML(marketGroups) {
  if (marketGroups.length < 2) return "";
  return `<nav class="dh-filter" id="dh-filter" aria-label="Filter by market">`
    + `<button type="button" class="dh-fbtn active" data-dh-filter="ALL" aria-pressed="true">All markets</button>`
    + marketGroups.map((g) => `<button type="button" class="dh-fbtn" data-dh-filter="${esc(g.key)}" aria-pressed="false">${esc(g.label)}</button>`).join("")
    + `</nav>`;
}

/**
 * Quick links to the other pages the day needs, each behind the same menu toggle
 * as its sidebar entry. `skip` drops the page you are on.
 */
function quickLinksHTML({ env = process.env, skip = [], demo = false } = {}) {
  const on = (k, d) => String(env[k] || d).toLowerCase() === "true";
  const links = [
    { id: "realtime",      href: "/realtime",      icon: "📡", label: "Real-Time Monitor", show: on("UI_SHOW_REALTIME", "true") },
    { id: "consolidation", href: "/consolidation", icon: "📒", label: "Trade History",     show: on("UI_SHOW_PAPER_HISTORY", "true") },
    { id: "backtest",      href: "/backtest",      icon: "🧪", label: "Backtest",          show: on("UI_SHOW_BACKTEST_PAGE", "true") },
    // A demo session cannot open Settings — a link there only leads to a refusal.
    { id: "settings",      href: "/settings",      icon: "⚙️", label: "Settings",          show: !demo },
  ].filter((l) => l.show && !skip.includes(l.id));
  if (!links.length) return "";
  return `<nav class="dh-links" aria-label="Quick links">`
    + links.map((l) => `<a class="dh-link" href="${l.href}"><span aria-hidden="true">${l.icon}</span>${esc(l.label)}</a>`).join("")
    + `</nav>`;
}

/**
 * Client helpers (plain ES5, so both pages' scripts can carry them).
 *   dhMarketInit(markets, onChange)   wire the filter + chips, restore the saved choice
 *   dhMarket()                        the current filter ("ALL" or a market key)
 *   dhApplyMarket()                   show/hide every [data-dh-market] element
 *   dhHero(byMarket, sub)             paint the hero total and the chips
 *   dhSummary(rows, markets, opts)    → { html, byMarket, total }
 */
function dashClientJS() {
  return `
var DH_STORE = 'dash.market';
var _dhMarkets = [], _dhCur = 'ALL', _dhOnChange = null;
function _dhLoad(){ try { return localStorage.getItem(DH_STORE) || 'ALL'; } catch (_) { return 'ALL'; } }
function _dhSave(v){ try { localStorage.setItem(DH_STORE, v); } catch (_) {} }
function dhMarket(){ return _dhCur; }
function dhFmtINR(n){
  if (n === null || n === undefined || isNaN(n)) return '—';
  var v = Math.round(+n);
  return (v < 0 ? '-' : (v > 0 ? '+' : '')) + '\\u20b9' + Math.abs(v).toLocaleString('en-IN');
}
function dhCls(n){ return (n === null || n === undefined || isNaN(n) || Math.round(+n) === 0) ? 'dh-zero' : (+n > 0 ? 'dh-pos' : 'dh-neg'); }
function _dhEsc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function dhApplyMarket(){
  var cur = _dhCur;
  var els = document.querySelectorAll('[data-dh-market]');
  for (var i = 0; i < els.length; i++) {
    var m = els[i].getAttribute('data-dh-market');
    els[i].classList.toggle('dh-off', cur !== 'ALL' && m !== cur);
  }
  var btns = document.querySelectorAll('[data-dh-filter]');
  for (var j = 0; j < btns.length; j++) {
    var on = btns[j].getAttribute('data-dh-filter') === cur;
    btns[j].classList.toggle('active', on);
    btns[j].setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  var chips = document.querySelectorAll('[data-dh-chip]');
  for (var k = 0; k < chips.length; k++) chips[k].classList.toggle('active', chips[k].getAttribute('data-dh-chip') === cur);
}
function _dhSet(v){
  if (v !== 'ALL' && _dhMarkets.indexOf(v) === -1) v = 'ALL';
  _dhCur = v; _dhSave(v); dhApplyMarket();
  if (_dhOnChange) { try { _dhOnChange(v); } catch (e) { console.error(e); } }
}
function dhMarketInit(markets, onChange){
  _dhMarkets = markets || []; _dhOnChange = onChange || null;
  var saved = _dhLoad();
  // Only one market on the page — a saved filter for another one would hide everything.
  _dhCur = (_dhMarkets.length > 1 && _dhMarkets.indexOf(saved) !== -1) ? saved : 'ALL';
  var btns = document.querySelectorAll('[data-dh-filter]');
  for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', function(){ _dhSet(this.getAttribute('data-dh-filter')); });
  var chips = document.querySelectorAll('[data-dh-chip]');
  // Tapping the active chip again goes back to All.
  for (var j = 0; j < chips.length; j++) chips[j].addEventListener('click', function(){ var m = this.getAttribute('data-dh-chip'); _dhSet(_dhCur === m ? 'ALL' : m); });
  dhApplyMarket();
}
function dhHero(byMarket, sub){
  var total = 0;
  for (var m in byMarket) if (Object.prototype.hasOwnProperty.call(byMarket, m)) total += (+byMarket[m] || 0);
  var el = document.getElementById('dh-hero-total');
  if (el) { el.textContent = dhFmtINR(total); el.className = 'dh-hero-total ' + dhCls(total); }
  for (var i = 0; i < _dhMarkets.length; i++) {
    var c = document.getElementById('dh-chip-' + _dhMarkets[i]);
    var v = +byMarket[_dhMarkets[i]] || 0;
    if (c) { c.textContent = dhFmtINR(v); c.className = 'dh-chip-v ' + dhCls(v); }
  }
  if (sub !== undefined) { var s = document.getElementById('dh-hero-sub'); if (s) s.textContent = sub; }
  return total;
}
/*
 * rows: [{ key, label, market, href, accent, offline, running, open, closed,
 *          trades, w, l, quiet }]  — quiet rows count toward the totals but get no line.
 * markets: [{ key, label }] in display order.
 * opts.market  only this market ("ALL" = every one); opts.closedOnly hides Status/Open
 * (a past day: Net P&L only); opts.quietText words the "no trade" line;
 * opts.split renders one table per market in a grid (narrow tables on wide screens).
 * Market rows carry that market's subtotal; the grand TOTAL is the sum of them.
 */
function dhSummary(rows, markets, opts){
  opts = opts || {};
  var only = opts.market && opts.market !== 'ALL' ? opts.market : null;
  var closedOnly = !!opts.closedOnly;
  var cols = closedOnly ? 5 : 7;
  var quietText = _dhEsc(opts.quietText || 'no trade yet today');
  var z = function(){ return { open:0, closed:0, trades:0, w:0, l:0, running:false, data:false, shown:0, quiet:0 }; };
  var byMarket = {}, total = z(), body = '';
  var cell = function(label, inner, klass){ return '<td data-label="' + label + '"' + (klass ? ' class="' + klass + '"' : '') + '>' + inner + '</td>'; };
  var money = function(label, n, extra){ return cell(label, dhFmtINR(n), dhCls(n) + (extra ? ' ' + extra : '')); };
  var line = function(name, st, s, klass, accent){
    var day = s.open + s.closed;
    return '<tr class="' + klass + '"' + (accent ? ' style="--acc:' + _dhEsc(accent) + '"' : '') + '><td>' + name + '</td>'
      + (closedOnly ? '' : cell('Status', st) + money('Open P&amp;L', s.open))
      + money(closedOnly ? 'Net P&amp;L' : 'Closed P&amp;L', s.closed)
      + cell('Trades', String(s.trades)) + cell('W / L', s.w + ' / ' + s.l)
      + (closedOnly ? '' : money('Today total', day, 'dh-daytot')) + '</tr>';
  };
  var stOf = function(s){ return s.data ? (s.running ? '<span class="dh-st run">RUNNING</span>' : '<span class="dh-st">STOPPED</span>') : '<span class="dh-st">—</span>'; };
  for (var i = 0; i < markets.length; i++) {
    var mk = markets[i];
    if (only && mk.key !== only) continue;
    var mine = rows.filter(function(r){ return r.market === mk.key; });
    if (!mine.length) continue;
    var sub = z(), lines = '';
    mine.forEach(function(r){
      if (r.offline) {
        lines += '<tr class="dh-srow"' + (r.accent ? ' style="--acc:' + _dhEsc(r.accent) + '"' : '') + '><td>' + _dhName(r) + '</td>'
          + (closedOnly ? '' : cell('Status', '<span class="dh-st err">OFFLINE</span>') + cell('Open P&amp;L', '—'))
          + cell(closedOnly ? 'Net P&amp;L' : 'Closed P&amp;L', '—') + cell('Trades', '—') + cell('W / L', '—')
          + (closedOnly ? '' : cell('Today total', '—', 'dh-daytot')) + '</tr>';
        sub.shown++;
        return;
      }
      var s = { open:+r.open || 0, closed:+r.closed || 0, trades:+r.trades || 0, w:+r.w || 0, l:+r.l || 0 };
      sub.open += s.open; sub.closed += s.closed; sub.trades += s.trades; sub.w += s.w; sub.l += s.l;
      sub.data = true; if (r.running) sub.running = true;
      if (r.quiet) { sub.quiet++; return; }
      sub.shown++;
      lines += line(_dhName(r), r.running === undefined ? '<span class="dh-st">—</span>' : (r.running ? '<span class="dh-st run">RUNNING</span>' : '<span class="dh-st">STOPPED</span>'), s, 'dh-srow', r.accent);
    });
    if (!sub.shown && sub.quiet) {
      lines += '<tr class="dh-quiet"><td colspan="' + cols + '">' + sub.quiet + (sub.quiet === 1 ? ' strategy' : ' strategies') + ' on, ' + quietText + '</td></tr>';
    } else if (sub.quiet) {
      lines += '<tr class="dh-quiet"><td colspan="' + cols + '">+ ' + sub.quiet + ' more, ' + quietText + '</td></tr>';
    }
    byMarket[mk.key] = sub;
    ['open','closed','trades','w','l'].forEach(function(f){ total[f] += sub[f]; });
    if (sub.running) total.running = true; if (sub.data) total.data = true;
    body += '<tbody data-market="' + _dhEsc(mk.key) + '">' + line(_dhEsc(mk.label), stOf(sub), sub, 'dh-mrow') + lines + '</tbody>';
  }
  if (!body) return { html:'', byMarket:byMarket, total:total };
  var head = '<thead><tr><th>Strategy</th>' + (closedOnly ? '' : '<th>Status</th><th>Open P&amp;L</th>')
    + '<th>' + (closedOnly ? 'Net P&amp;L' : 'Closed P&amp;L') + '</th><th>Trades</th><th>W / L</th>'
    + (closedOnly ? '' : '<th>Today total</th>') + '</tr></thead>';
  var grandLabel = only ? 'TOTAL · ' + _dhEsc((markets.filter(function(m){ return m.key === only; })[0] || {}).label || only) : 'TOTAL';
  if (opts.split) {
    // One table per market (each with its own header) in a grid, TOTAL full-width below.
    var tables = body.split('</tbody>').filter(function(t){ return t; })
      .map(function(t){ return '<table class="dh-sum">' + head + t + '</tbody></table>'; }).join('');
    return { html:'<div class="dh-sum-grid">' + tables + '<table class="dh-sum dh-sum-total"><tbody class="dh-grand-body">' + line(grandLabel, stOf(total), total, 'dh-grand') + '</tbody></table></div>', byMarket:byMarket, total:total };
  }
  var grand = '<tbody class="dh-grand-body">' + line(grandLabel, stOf(total), total, 'dh-grand') + '</tbody>';
  return { html:'<table class="dh-sum">' + head + body + grand + '</table>', byMarket:byMarket, total:total };
}
function _dhName(r){
  var dot = '<span class="dh-dot" aria-hidden="true"></span>';
  var name = _dhEsc(r.label);
  return r.href ? '<a href="' + _dhEsc(r.href) + '">' + dot + name + '</a>' : dot + name;
}
`;
}

module.exports = { dashCSS, heroHTML, filterHTML, quickLinksHTML, dashClientJS };

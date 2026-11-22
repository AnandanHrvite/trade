/**
 * liveRoute.js — builds a strategy's LIVE or LIVE HARNESS page
 * ─────────────────────────────────────────────────────────────────────────────
 * One builder for every strategy, the way Paper and Backtest each have their own
 * page while the engine stays one. Both kinds attach services/liveHarness.js to
 * the strategy's NIFTY paper engine — that engine makes every decision, so any
 * change to the engine or its Settings reaches Paper, Backtest, Live and the
 * Harness alike.
 *
 *   kind "harness" — the full order path against a SIMULATED broker. Nothing is
 *                    ever sent to Fyers. Needs no switch.
 *   kind "live"    — REAL Fyers orders. Start is refused unless
 *                    LIVE_TRADING_ENABLED=true AND {PREFIX}_LIVE_ENABLED=true and
 *                    Fyers is logged in.
 *
 * Start attaches to the paper session (starting it if it is not running).
 * Stop: Live squares off any real position first, then detaches; the paper
 * session keeps running either way. When paper's session ends (auto-stop,
 * /stop) the page detaches by itself.
 *
 * Usage (src/routes/haScalpLive.js):
 *   module.exports = require("../utils/liveRoute").create({
 *     id: "haScalp", kind: "live", modeTag: "HA-SCALP-PAPER", path: "/ha-scalp-live",
 *     navKey: "haScalpLive", title: "HA Scalp" });
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const express           = require("express");
const registry          = require("../config/strategyRegistry");
const liveHarness       = require("../services/liveHarness");
const fyersBroker       = require("../services/fyersBroker");
const sharedSocketState = require("./sharedSocketState");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("./sharedNav");
const { bbRsiStyleCSS } = require("./bbRsiStyleUI");

// Calls a handler on an express router in-process (no HTTP, no auth hop) and
// resolves with { status, body | redirect }. Used to start the paper session.
function invokeRoute(router, method, urlPath, query = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = { method: method.toUpperCase(), url: urlPath, path: urlPath, query: { ...query },
      headers: { host: "localhost" }, get: () => undefined, app: { get: () => undefined, set: () => {} } };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      set() { return this; }, setHeader() { return this; },
      json(b) { finish({ status: this.statusCode, body: b }); return this; },
      send(b) { finish({ status: this.statusCode, body: b }); return this; },
      end(b) { finish({ status: this.statusCode, body: b }); return this; },
      redirect(u) { finish({ status: 302, redirect: u }); },
    };
    const layer = (router.stack || []).find((l) => l.route && l.route.path === urlPath && l.route.methods[method.toLowerCase()]);
    if (!layer) return finish({ status: 404, body: "no matching route" });
    const h = layer.route.stack.find((s) => s.method === method.toLowerCase());
    try {
      const r = h.handle(req, res, (err) => (err ? reject(err) : finish({ status: 404, body: "not handled" })));
      if (r && typeof r.catch === "function") r.catch(reject);
    } catch (e) { reject(e); }
  });
}

// Short plain reason from paper's error page HTML ("<p>…</p>"), for the alert box.
function _reasonFrom(body) {
  const s = typeof body === "string" ? body : JSON.stringify(body || "");
  const m = s.match(/<p>([\s\S]*?)<\/p>/);
  return (m ? m[1] : s).replace(/<[^>]+>/g, "").slice(0, 200);
}

function create({ id, kind, modeTag, path, navKey, title, isFutures }) {
  const reg = registry.byId(id);
  if (!reg) throw new Error(`liveRoute: unknown strategy id "${id}"`);
  if (kind !== "live" && kind !== "harness") throw new Error(`liveRoute: kind must be "live" or "harness"`);
  const isLive   = kind === "live";
  const PREFIX   = reg.envPrefix;
  const MODE     = `${reg.key}-${isLive ? "LIVE" : "HARNESS"}`;
  const TAG      = `[${reg.key}-${isLive ? "LIVE" : "HARNESS"}]`;
  const PAGE     = `${title} — ${isLive ? "Live" : "Live Harness"}`;
  const PAPER    = reg.paper.path;
  const futuresFn = typeof isFutures === "function" ? isFutures : () => require("./instrumentMode").isFutures();
  const router   = express.Router();

  function paperRouter() { return require("../" + reg.paper.module); }
  function paperRunning() {
    const get = sharedSocketState[reg.socket.get];
    return typeof get === "function" && get() === reg.socket.mode;
  }
  function modeEnabled() {
    return String(process.env[reg.modeEnabled.key] || reg.modeEnabled.default).toLowerCase() === "true";
  }

  // Detach when paper stops without saying so (strategies whose stopSession
  // sends no day report). Runs only while attached.
  let watchdog = null;
  function _stopWatchdog() { if (watchdog) { clearInterval(watchdog); watchdog = null; } }
  function _startWatchdog() {
    _stopWatchdog();
    watchdog = setInterval(() => {
      if (!liveHarness.isInstalled(MODE)) return _stopWatchdog();
      if (!paperRunning()) { liveHarness.uninstall(MODE, "paper session not running"); _stopWatchdog(); }
    }, 5000);
    if (watchdog.unref) watchdog.unref();
  }

  router.get("/start", async (req, res) => {
    try {
      if (liveHarness.isInstalled(MODE)) return res.json({ success: true, message: `${PAGE} is already running.` });
      if (!modeEnabled()) return res.status(403).json({ success: false, error: `${title} is turned off. Turn on ${reg.modeEnabled.key} in Settings.` });
      if (isLive) {
        if (!liveHarness.globalLiveEnabled()) return res.status(403).json({ success: false, error: "Real orders are off. Turn on LIVE_TRADING_ENABLED in Settings → Live Trading." });
        if (!liveHarness.strategyLiveEnabled(PREFIX)) return res.status(403).json({ success: false, error: `Real orders for ${title} are off. Turn on ${PREFIX}_LIVE_ENABLED in Settings → Live Trading.` });
        if (!fyersBroker.isAuthenticated()) return res.status(401).json({ success: false, error: "Fyers is not logged in. Log in with Fyers first." });
      }
      liveHarness.install({ mode: MODE, modeTag, envPrefix: PREFIX, dryRun: !isLive, isFutures: futuresFn, onSessionEnd: _stopWatchdog });
      const wasRunning = paperRunning();
      if (!wasRunning) {
        let r;
        try { r = await invokeRoute(paperRouter(), "GET", "/start"); }
        catch (e) { r = { status: 500, body: e.message }; }
        if (!paperRunning()) {
          liveHarness.uninstall(MODE, "paper failed to start");
          return res.status(r && r.status >= 400 ? r.status : 500).json({ success: false, error: `Paper engine did not start: ${_reasonFrom(r && r.body)}` });
        }
      }
      _startWatchdog();
      console.log(`🟢 ${TAG} started — ${wasRunning ? "attached to the running" : "started the"} paper session; ${isLive ? "REAL Fyers orders" : "simulated orders only"}.`);
      return res.json({ success: true, message: isLive
        ? `${PAGE} started — REAL Fyers orders will follow every paper entry and exit.`
        : `${PAGE} started — orders are simulated, nothing is sent to Fyers.` });
    } catch (e) {
      try { liveHarness.uninstall(MODE, "start error"); } catch (_) {}
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  router.get("/stop", async (req, res) => {
    try {
      // Detach FIRST so no new paper entry can become a real order while the
      // square-off runs; an entry already in flight is awaited by squareOff.
      liveHarness.uninstall(MODE, "stopped by user");
      _stopWatchdog();
      let open = 0;
      if (isLive) open = await liveHarness.squareOff(MODE, "Live stopped");
      return res.json({ success: true, message: open > 0
        ? `Stopped, but ${open} real position(s) could NOT be confirmed closed — check Fyers now.`
        : `${PAGE} stopped. The paper session keeps running — stop it from the Paper page.` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  if (isLive) {
    router.get("/squareoff", async (req, res) => {
      try {
        const open = await liveHarness.squareOff(MODE, "Manual square-off");
        return res.json({ success: open === 0, message: open === 0 ? "No real position left open." : `${open} position(s) still open — check Fyers.` });
      } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    });
  }

  router.get("/clear-block", (req, res) => {
    const had = liveHarness.clearBlock(MODE);
    res.json({ success: true, message: had ? "Block cleared — new entries allowed." : "There was no block." });
  });

  router.get("/status/data", (req, res) => {
    const st = liveHarness.status(MODE);
    res.json({
      kind, mode: MODE, ...st,
      paperRunning: paperRunning(),
      switches: { global: liveHarness.globalLiveEnabled(), strategy: liveHarness.strategyLiveEnabled(PREFIX), fyers: fyersBroker.isAuthenticated() },
      events: liveHarness.recentEvents(MODE, 80),
    });
  });

  router.get("/status", (req, res) => res.redirect(path));

  router.get("/", (req, res) => {
    res.send(_page({ isLive, PAGE, PAPER, PREFIX, path, navKey, running: liveHarness.isInstalled(MODE) }));
  });

  router.isLiveHarness = true;
  router.liveMode = MODE;
  return router;
}

function _page({ isLive, PAGE, PAPER, PREFIX, path, navKey, running }) {
  const banner = isLive
    ? `<div class="banner lv-red">🔴 REAL MONEY. Every paper entry and exit is sent to Fyers as a market order. Needs <code>LIVE_TRADING_ENABLED</code> and <code>${PREFIX}_LIVE_ENABLED</code> ON in Settings.</div>`
    : `<div class="banner lv-amber">🧪 DRY-RUN. Same order steps as Live, but the broker is simulated — nothing is ever sent to Fyers.</div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${PAGE}</title>${faviconLink()}
<style>${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.lv-red{background:#3b0d0d;color:#fecaca;border:1px solid #ef4444;}
.lv-amber{background:#2d1f05;color:#fde68a;border:1px solid #f59e0b;}
.lv-btns{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 16px;}
.lv-btn{min-height:44px;padding:0 18px;border-radius:8px;border:1px solid #1a2236;background:#0d1320;color:#c8d8f0;font:inherit;font-size:0.8rem;font-weight:600;cursor:pointer;}
.lv-btn.go{background:#1d4ed8;border-color:#1d4ed8;color:#fff;}
.lv-btn.danger{background:#b91c1c;border-color:#b91c1c;color:#fff;}
.lv-btn:disabled{opacity:0.45;cursor:not-allowed;}
.lv-ok{color:#34d399;} .lv-bad{color:#f87171;} .lv-warn{color:#fbbf24;}
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:16px;border:1px solid #1a2236;border-radius:8px;}
table.lv{width:100%;border-collapse:collapse;font-size:0.74rem;min-width:640px;}
table.lv th{text-align:left;padding:8px;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);border-bottom:1px solid #1a2236;white-space:nowrap;}
table.lv td{padding:8px;border-bottom:1px solid #131c2e;white-space:nowrap;font-family:'IBM Plex Mono',monospace;}
.main-content{padding-bottom:calc(28px + env(safe-area-inset-bottom));}
</style></head><body>
${buildSidebar(navKey, null, running)}
<div class="main-content">
  <div class="top-bar"><div><div class="top-bar-title">${PAGE}</div>
    <div class="top-bar-meta">Decisions come from the <a href="${PAPER}/status" style="color:#4a9cf5">Paper engine</a> — same rules, same Settings.</div></div>
    <div class="top-bar-right"><span id="lv-badge" class="top-bar-badge">…</span></div></div>
  ${banner}
  <div class="lv-btns">
    <button class="lv-btn go" id="b-start" onclick="act('start')">▶ Start</button>
    <button class="lv-btn" id="b-stop" onclick="act('stop')">■ Stop</button>
    ${isLive ? `<button class="lv-btn danger" id="b-sq" onclick="act('squareoff')">Square off now</button>` : ""}
    <button class="lv-btn" id="b-clear" onclick="act('clear-block')" style="display:none">Clear block</button>
  </div>
  <div class="stat-grid" id="lv-stats"></div>
  <div class="section-title">${isLive ? "Real positions" : "Simulated positions"}</div>
  <div class="tbl-wrap"><table class="lv"><thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg price</th><th>Status</th></tr></thead><tbody id="lv-pos"></tbody></table></div>
  <div class="section-title">Today's orders</div>
  <div class="tbl-wrap"><table class="lv"><thead><tr><th>Time</th><th>Event</th><th>Symbol</th><th>Qty</th><th>Fill</th><th>Paper</th><th>Slip</th><th>Gross P&amp;L</th><th>Note</th></tr></thead><tbody id="lv-ev"></tbody></table></div>
</div>
<script>
${modalJS()}
var BASE = ${JSON.stringify(path)}, IS_LIVE = ${isLive ? "true" : "false"};
function esc(v){ return String(v == null ? '—' : v).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function num(v){ return (v == null || v === '' || isNaN(v)) ? '—' : (Math.round(v * 100) / 100); }
function tm(t){ return new Date(t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }); }
function card(label, val, cls){ return '<div class="sc"><div class="sc-label">' + esc(label) + '</div><div class="sc-val ' + (cls || '') + '">' + esc(val) + '</div></div>'; }
var BAD = /REJECT|UNKNOWN|UNCONFIRMED|UNVERIFIED|BAD_PAYLOAD|STILL_HELD|SWITCH_OFF|BLOCKED/;
function render(d){
  var b = document.getElementById('lv-badge');
  b.textContent = d.installed ? (IS_LIVE ? '● LIVE' : '● HARNESS') : 'IDLE';
  b.className = 'top-bar-badge ' + (d.installed ? 'badge-running' : 'badge-stopped');
  document.getElementById('b-start').disabled = !!d.installed;
  document.getElementById('b-stop').disabled = !d.installed;
  document.getElementById('b-clear').style.display = d.blocked ? '' : 'none';
  var s = card('Status', d.installed ? 'Running' : 'Stopped', d.installed ? 'lv-ok' : '')
        + card('Paper engine', d.paperRunning ? 'Running' : 'Stopped', d.paperRunning ? 'lv-ok' : 'lv-warn');
  if (IS_LIVE) {
    s += card('LIVE_TRADING_ENABLED', d.switches.global ? 'ON' : 'OFF', d.switches.global ? 'lv-ok' : 'lv-bad')
       + card(${JSON.stringify(PREFIX + "_LIVE_ENABLED")}, d.switches.strategy ? 'ON' : 'OFF', d.switches.strategy ? 'lv-ok' : 'lv-bad')
       + card('Fyers login', d.switches.fyers ? 'OK' : 'Not logged in', d.switches.fyers ? 'lv-ok' : 'lv-bad');
  }
  s += card('New entries', d.blocked ? 'BLOCKED — check Fyers' : 'Allowed', d.blocked ? 'lv-bad' : 'lv-ok');
  document.getElementById('lv-stats').innerHTML = s;
  var pos = (d.positions && d.positions.length) ? d.positions : (d.persisted || []);
  document.getElementById('lv-pos').innerHTML = pos.length ? pos.map(function(p){
    return '<tr><td>' + esc(p.symbol) + '</td><td>' + esc(p.direction) + '</td><td>' + esc(p.qty) + '</td><td>' + esc(num(p.avgPrice)) + '</td><td class="' + (p.confirmed === false || p.restored ? 'lv-warn' : '') + '">'
      + esc(p.confirmed === false ? 'UNCONFIRMED' : (p.restored ? 'Restored after restart' : 'Open')) + '</td></tr>';
  }).join('') : '<tr><td colspan="5">Flat — no open position.</td></tr>';
  var ev = (d.events || []).slice().reverse();
  document.getElementById('lv-ev').innerHTML = ev.length ? ev.map(function(e){
    var slip = (e.avgPrice != null && e.paperPrice != null && e.avgPrice && e.paperPrice) ? (e.event === 'EXIT_FILLED' ? e.avgPrice - e.paperPrice : e.paperPrice - e.avgPrice) : null;
    var pnl = e.realGrossPnl;
    var note = e.reason || e.error || (e.raw ? JSON.stringify(e.raw).slice(0, 80) : '') || (e.latencyMs != null ? e.latencyMs + ' ms' : '');
    return '<tr><td>' + esc(tm(e.t)) + '</td><td class="' + (BAD.test(e.event) ? 'lv-bad' : (/FILLED/.test(e.event) ? 'lv-ok' : '')) + '">' + esc(e.event) + '</td><td>' + esc(e.symbol) + '</td><td>' + esc(e.qty)
      + '</td><td>' + esc(num(e.avgPrice)) + '</td><td>' + esc(num(e.paperPrice)) + '</td><td>' + esc(num(slip)) + '</td><td class="' + (pnl > 0 ? 'lv-ok' : pnl < 0 ? 'lv-bad' : '') + '">' + esc(num(pnl)) + '</td><td>' + esc(note) + '</td></tr>';
  }).join('') : '<tr><td colspan="9">No orders yet today.</td></tr>';
}
async function refresh(){
  try { var r = await secretFetch(BASE + '/status/data'); if (r && r.ok) render(await r.json()); } catch (_) {}
}
var ASK = {
  start: IS_LIVE ? 'Start LIVE — REAL Fyers orders will follow every paper entry and exit. Continue?' : 'Start the Live Harness? Orders are simulated; nothing is sent to Fyers.',
  stop: IS_LIVE ? 'Stop Live? Any real position is squared off first. The paper session keeps running.' : 'Stop the Live Harness? The paper session keeps running.',
  squareoff: 'Send a market order now to close every real position of this strategy?',
  'clear-block': 'Only clear this after you have checked the order on Fyers. Clear the block?'
};
async function act(what){
  var ok = await showConfirm({ icon: IS_LIVE ? '🔴' : '🧪', title: '${PAGE.replace(/'/g, "\\'")}', message: ASK[what], confirmText: 'Yes', confirmClass: 'modal-btn-danger' });
  if (!ok) return;
  try {
    var r = await secretFetch(BASE + '/' + what, { timeoutMs: 40000 });
    if (!r) return;
    var d = await r.json();
    await showAlert({ icon: d.success ? '✅' : '⚠️', title: d.success ? 'Done' : 'Not done', message: d.message || d.error || '', btnClass: d.success ? 'modal-btn-success' : 'modal-btn-danger' });
  } catch (e) { await showAlert({ icon: '⚠️', title: 'Error', message: e.message, btnClass: 'modal-btn-danger' }); }
  refresh();
}
refresh(); setInterval(refresh, 4000);
</script></body></html>`;
}

module.exports = { create, invokeRoute };

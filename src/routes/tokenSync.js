/**
 * tokenSync.js — Move the daily broker tokens from the LIVE server to a laptop
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this page exists: the Fyers/Zerodha OAuth redirect URL is registered
 * against the EC2 host, so you cannot complete a broker login from localhost.
 * The *data* APIs have no such restriction — a token issued on EC2 works fine
 * from a laptop. So: copy the token on LIVE, paste it locally, and backtest /
 * analytics work on the local machine.
 *
 *   GET  /token-sync            → page (COPY block + PASTE block)
 *   GET  /token-sync/tokens     → { fyers:{...}, zerodha:{...} } incl. raw token
 *   POST /token-sync/apply      → { broker, token } → write to disk + apply live
 *   POST /token-sync/restart    → graceful exit (PM2 / nodemon bring it back)
 *
 * This page never places an order and never touches trade state. It sits behind
 * the app-wide LOGIN_SECRET gate like every other page, and only the page shell
 * is in app.js OPEN_PATHS: /tokens hands out a live broker credential, so it is
 * gated by API_SECRET like a write, as are /apply and /restart. The raw token is
 * masked until an explicit click.
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const os      = require("os");
const path    = require("path");

const { buildSidebar, sidebarCSS, faviconLink, toastJS, modalCSS, modalJS } = require("../utils/sharedNav");
const sharedSocketState = require("../utils/sharedSocketState");

const HOME            = os.homedir();
const FYERS_TOKEN_F   = path.join(HOME, "trading-data", ".fyers_token");
const ZERODHA_TOKEN_F = path.join(HOME, "trading-data", ".zerodha_token");

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// Read a token file without the loader's expiry side-effects (loadToken deletes
// stale files). This page must be able to *show* a stale token and say so.
function readTokenFile(file, envKey) {
  const out = {
    present: false, token: "", savedAt: null, savedDate: null,
    validated: null, stale: false, source: null,
  };
  try {
    if (fs.existsSync(file)) {
      const d = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (d && d.token) {
        out.present   = true;
        out.token     = String(d.token);
        out.savedAt   = d.savedAt || null;
        out.savedDate = d.savedDate || null;
        out.validated = typeof d.validated === "boolean" ? d.validated : null;
        out.source    = "disk";
      }
    }
  } catch (_) { /* fall through to env */ }

  if (!out.present && process.env[envKey]) {
    out.present = true;
    out.token   = String(process.env[envKey]);
    out.source  = "memory";
  }

  // Both brokers issue day tokens (Zerodha expires 6 AM next day).
  if (out.present) {
    const ageH = out.savedAt ? (Date.now() - out.savedAt) / 3600000 : null;
    out.stale = (out.savedDate && out.savedDate !== todayIST()) || (ageH !== null && ageH > 20);
  }
  return out;
}

function snapshot() {
  return {
    host: os.hostname(),
    todayIST: todayIST(),
    fyers:   readTokenFile(FYERS_TOKEN_F,   "ACCESS_TOKEN"),
    zerodha: readTokenFile(ZERODHA_TOKEN_F, "ZERODHA_ACCESS_TOKEN"),
  };
}

// ── GET /token-sync/tokens ───────────────────────────────────────────────────
router.get("/tokens", (req, res) => res.json(snapshot()));

// ── POST /token-sync/apply — paste a token in, use it immediately ────────────
// Writes the same on-disk shape the brokers' own save paths write (stamped with
// today's IST date so the loaders accept it), and applies it in-process so no
// restart is needed for backtests to start working.
router.post("/apply", (req, res) => {
  const broker = String((req.body && req.body.broker) || "").toLowerCase();
  const token  = String((req.body && req.body.token) || "").trim();

  if (broker !== "fyers" && broker !== "zerodha") {
    return res.status(400).json({ success: false, error: "broker must be 'fyers' or 'zerodha'." });
  }
  if (!token || token.length < 20 || /\s/.test(token)) {
    return res.status(400).json({ success: false, error: "That does not look like a token (paste the full value, no spaces)." });
  }

  try {
    if (broker === "fyers") {
      // fyers.setAccessToken is wrapped in config/fyers.js — sets process.env
      // ACCESS_TOKEN and persists to ~/trading-data/.fyers_token.
      require("../config/fyers").setAccessToken(token);
    } else {
      // zerodhaBroker.setAccessToken sets env, seeds the Kite client and marks
      // the disk token validated (otherwise the loader ignores it on boot).
      require("../services/zerodhaBroker").setAccessToken(token);
    }
    console.log(`🔑 [tokenSync] ${broker.toUpperCase()} token applied from the Token Sync page.`);
    res.json({ success: true, broker, snapshot: snapshot() });
  } catch (err) {
    console.warn(`⚠️  [tokenSync] apply failed for ${broker}: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /token-sync/restart — graceful exit; PM2 / nodemon restart it ───────
// Refused while any engine holds the socket, so a restart can never orphan a
// running paper/live session. A plain `node src/app.js` will simply stop.
router.post("/restart", (req, res) => {
  // isAnyActive() — not getMode(), which only knows about EMA_RSI_ST. Every
  // engine holds its own slot, so a BB_RSI / PA / ORB session must block too.
  if (sharedSocketState.isAnyActive()) {
    const running = [
      sharedSocketState.getMode(), sharedSocketState.getBbRsiMode(), sharedSocketState.getPAMode(),
      sharedSocketState.getOrbMode(), sharedSocketState.getEma9VwapMode(), sharedSocketState.getTrendPbMode(),
      sharedSocketState.getGapsMode(), sharedSocketState.getTrendDayScalpMode(),
      sharedSocketState.getGapFix3mMode(), sharedSocketState.getOiWallFadeMode(),
    ].filter(Boolean).join(", ");
    return res.status(409).json({ success: false, error: `${running} running — stop it before restarting.` });
  }
  console.log("♻️  [tokenSync] restart requested from the Token Sync page.");
  res.json({ success: true, message: "Restarting… reload this page in a few seconds." });
  setTimeout(() => process.exit(0), 300);
});

// ── GET /token-sync — page ───────────────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  ${faviconLink()}
  <title>Token Sync — Trading BOT</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    html, body { height:100%; }
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; }
    ${sidebarCSS()}
    ${modalCSS()}
    .page { padding:22px 28px 80px; max-width:1000px; }
    .sub { font-size:0.72rem; color:var(--muted-1,#8ba1c2); margin-bottom:18px; line-height:1.6; }
    .sub code { background:#0d1320; padding:1px 5px; border-radius:3px; color:#94a3b8; }
    .card { background:#0a1018; border:1px solid #1a2236; border-radius:8px; margin-bottom:20px; overflow:hidden; }
    .card-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:11px 16px; background:#0d1320; border-bottom:1px solid #1a2236; flex-wrap:wrap; }
    .card-title { font-size:0.78rem; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#60a5fa; }
    .card-title.paste { color:#fbbf24; }
    .card-note { font-size:0.66rem; color:var(--muted-1,#8ba1c2); }
    .card-body { padding:14px 16px; }
    .row { padding:12px 0; border-bottom:1px solid #121a2a; }
    .row:last-child { border-bottom:none; }
    .row-head { display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap; }
    .broker { font-size:0.75rem; font-weight:700; letter-spacing:0.4px; }
    .broker.fy { color:#10b981; }
    .broker.zd { color:#f472b6; }
    .pill { font-size:0.6rem; font-weight:700; letter-spacing:0.5px; padding:2px 8px; border-radius:10px; border:1px solid currentColor; text-transform:uppercase; }
    .pill.ok { color:#10b981; }
    .pill.warn { color:#fbbf24; }
    .pill.bad { color:#f87171; }
    .meta { font-size:0.66rem; color:var(--muted-1,#8ba1c2); font-family:'IBM Plex Mono',monospace; }
    .tokbox { display:flex; gap:8px; align-items:stretch; flex-wrap:wrap; }
    .tokval { flex:1 1 320px; min-width:0; font-family:'IBM Plex Mono',monospace; font-size:0.68rem; background:#0d1320; border:1px solid #1a2236; border-radius:6px; padding:9px 11px; color:#94a3b8; word-break:break-all; min-height:40px; }
    textarea { width:100%; font-family:'IBM Plex Mono',monospace; font-size:0.68rem; background:#0d1320; border:1px solid #1a2236; border-radius:6px; padding:9px 11px; color:#c8d8f0; resize:vertical; min-height:74px; outline:none; }
    textarea:focus { border-color:#1e3a5a; }
    .btn { font-size:0.68rem; font-weight:600; padding:9px 14px; border-radius:6px; border:1px solid; cursor:pointer; font-family:inherit; display:inline-flex; align-items:center; justify-content:center; gap:5px; min-height:40px; }
    .btn-copy   { background:#071428; border-color:#0e2850; color:#60a5fa; }
    .btn-reveal { background:#060a14; border-color:#0e1a28; color:#818cf8; }
    .btn-apply  { background:#05170f; border-color:#0e3a28; color:#34d399; }
    .btn-restart{ background:#180508; border-color:#401018; color:#f87171; }
    .btn:hover:not(:disabled) { filter:brightness(1.25); }
    .btn:disabled { opacity:0.4; cursor:not-allowed; }
    .btn-row { display:flex; gap:8px; margin-top:9px; flex-wrap:wrap; }
    .foot { font-size:0.66rem; color:var(--muted-1,#8ba1c2); line-height:1.6; }
    @media (max-width:640px) {
      html, body { height:auto; }
      body { display:block; height:auto; overflow-x:hidden; }
      .page { padding:14px 14px calc(80px + env(safe-area-inset-bottom)); }
      .btn { flex:1 1 100%; }
    }
    /* ── LIGHT THEME OVERRIDES (UI_THEME=light) ───────────────────────── */
    :root[data-theme="light"] body { background:#f4f6f9; color:#334155; }
    :root[data-theme="light"] .sub, :root[data-theme="light"] .card-note,
    :root[data-theme="light"] .meta, :root[data-theme="light"] .foot { color:#4b5769; }
    :root[data-theme="light"] .sub code { background:#f1f5f9; color:#475569; }
    :root[data-theme="light"] .card { background:#fff; border-color:#e0e4ea; }
    :root[data-theme="light"] .card-head { background:#f8fafc; border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .row { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .tokval { background:#f8fafc; border-color:#e0e4ea; color:#475569; }
    :root[data-theme="light"] textarea { background:#fff; border-color:#e0e4ea; color:#334155; }
    :root[data-theme="light"] .btn-copy   { background:#eff6ff; border-color:#bfdbfe; color:#1e40af; }
    :root[data-theme="light"] .btn-reveal { background:#eef2ff; border-color:#c7d2fe; color:#4338ca; }
    :root[data-theme="light"] .btn-apply  { background:#ecfdf5; border-color:#a7f3d0; color:#047857; }
    :root[data-theme="light"] .btn-restart{ background:#fef2f2; border-color:#fecaca; color:#b91c1c; }
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('tokenSync', liveActive)}
<div class="main-content">

<div class="top-bar">
  <div>
    <div class="top-bar-title">🔑 Token Sync</div>
    <div class="top-bar-meta">Copy the day's broker token from LIVE → paste it on your local machine</div>
  </div>
</div>

<div class="page">
  <div class="sub">
    Broker login can only be completed on the LIVE server (the OAuth redirect URL is registered to it).
    The data APIs work from anywhere, so for <b>backtest &amp; analytics on your laptop</b>: open this page
    on LIVE, copy the token, then open this page locally and paste it. Nothing here places an order.
    <br/>This machine: <code id="hostName">…</code> · today (IST) <code id="todayIst">…</code>
  </div>

  <div class="card">
    <div class="card-head">
      <div class="card-title">1 · On LIVE — copy</div>
      <div class="card-note">Tokens currently held by <i>this</i> instance</div>
    </div>
    <div class="card-body" id="copyArea">Loading…</div>
  </div>

  <div class="card">
    <div class="card-head">
      <div class="card-title paste">2 · On LOCAL — paste</div>
      <div class="card-note">Applied immediately — a restart is optional</div>
    </div>
    <div class="card-body">
      <div class="row">
        <div class="row-head"><span class="broker fy">FYERS</span><span class="meta">used by every backtest &amp; the tick feed</span></div>
        <textarea id="fyPaste" placeholder="Paste the Fyers token copied from LIVE…" spellcheck="false"></textarea>
        <div class="btn-row"><button class="btn btn-apply" onclick="applyToken('fyers')">✔ Apply Fyers token</button></div>
      </div>
      <div class="row">
        <div class="row-head"><span class="broker zd">ZERODHA</span><span class="meta">only needed for EMA_RSI_ST live data / orders</span></div>
        <textarea id="zdPaste" placeholder="Paste the Zerodha token copied from LIVE…" spellcheck="false"></textarea>
        <div class="btn-row"><button class="btn btn-apply" onclick="applyToken('zerodha')">✔ Apply Zerodha token</button></div>
      </div>
      <div class="row">
        <div class="foot">
          Applying saves the token to <code>~/trading-data/</code> and uses it right away.
          Restart only if you also changed <code>.env</code> — it is refused while an engine is running,
          and under a plain <code>npm start</code> the app will stop instead of coming back.
        </div>
        <div class="btn-row"><button class="btn btn-restart" onclick="restartApp()">♻ Restart app</button></div>
      </div>
    </div>
  </div>
</div>

</div></div>

<script>
  ${modalJS()}
  ${toastJS()}
  var SNAP = null, REVEALED = {}, _timer = null;

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function mask(t){ return t.length <= 14 ? '•'.repeat(t.length) : t.slice(0,6) + '•'.repeat(18) + t.slice(-4); }
  function ago(ms){
    if (!ms) return 'unknown';
    var m = Math.round((Date.now()-ms)/60000);
    if (m < 60) return m + 'm ago';
    return (m/60).toFixed(1) + 'h ago';
  }

  function rowHTML(key, label, cls, d){
    // A token read from process.env (no disk file) carries no save date, so its
    // age is genuinely unknown — say so instead of claiming it is valid today.
    var unknownAge = d.present && !d.savedAt && !d.savedDate;
    var pill = !d.present  ? '<span class="pill bad">NOT SET</span>'
             : d.stale     ? '<span class="pill warn">STALE — RE-LOGIN ON LIVE</span>'
             : unknownAge  ? '<span class="pill warn">AGE UNKNOWN</span>'
                           : '<span class="pill ok">VALID TODAY</span>';
    var meta = !d.present ? 'No token on this instance.'
             : 'saved ' + esc(d.savedDate || '—') + ' · ' + ago(d.savedAt) + ' · from ' + esc(d.source);
    var body = d.present
      ? '<div class="tokbox">' +
          '<div class="tokval" id="tok_' + key + '">' + esc(REVEALED[key] ? d.token : mask(d.token)) + '</div>' +
        '</div>' +
        '<div class="btn-row">' +
          '<button class="btn btn-copy" onclick="copyToken(\\'' + key + '\\')">⧉ Copy</button>' +
          '<button class="btn btn-reveal" onclick="toggleReveal(\\'' + key + '\\')">' + (REVEALED[key] ? '🙈 Hide' : '👁 Reveal') + '</button>' +
        '</div>'
      : '';
    return '<div class="row">' +
      '<div class="row-head"><span class="broker ' + cls + '">' + label + '</span>' + pill + '<span class="meta">' + meta + '</span></div>' +
      body + '</div>';
  }

  function render(){
    document.getElementById('hostName').textContent = SNAP.host;
    document.getElementById('todayIst').textContent = SNAP.todayIST;
    document.getElementById('copyArea').innerHTML =
      rowHTML('fyers', 'FYERS', 'fy', SNAP.fyers) + rowHTML('zerodha', 'ZERODHA', 'zd', SNAP.zerodha);
  }

  // The token poll needs the API_SECRET too — it returns a live broker
  // credential, so it is gated like a write. secretFetch prompts once per
  // browser session; cancelling stops the auto-refresh instead of re-prompting
  // every minute.
  async function load(){
    try {
      var res = await secretFetch('/token-sync/tokens');
      if (!res) { stopAutoRefresh(); document.getElementById('copyArea').textContent = 'Locked — reload the page to enter the API secret.'; return; }
      var d = await res.json();
      // A 401 (login expired) answers with { success:false } — keep the last
      // good view instead of rendering "undefined" over it.
      if (!d || !d.fyers || !d.zerodha) {
        return showToast(d && d.error ? d.error : 'Could not read tokens', '#f87171');
      }
      SNAP = d; render();
    } catch (e) { document.getElementById('copyArea').textContent = 'Failed to load: ' + e.message; }
  }
  function stopAutoRefresh(){ if (_timer) { clearInterval(_timer); _timer = null; } }

  function toggleReveal(k){ REVEALED[k] = !REVEALED[k]; render(); }

  function copyToken(k){
    var t = SNAP && SNAP[k] && SNAP[k].token;
    if (!t) return showToast('Nothing to copy', '#f87171');
    function done(){ showToast(k.toUpperCase() + ' token copied', '#34d399'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done).catch(function(){ fallback(t, done); });
    } else fallback(t, done);
  }
  function fallback(t, done){
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); }
    catch (e) { showToast('Copy failed — reveal and copy by hand', '#f87171'); }
    document.body.removeChild(ta);
  }

  // Both writes go through secretFetch — /token-sync/apply and /restart are
  // deliberately outside app.js OPEN_PATHS, so they need the API_SECRET header
  // when one is configured (secretFetch prompts once per browser session).
  async function applyToken(broker){
    var el = document.getElementById(broker === 'fyers' ? 'fyPaste' : 'zdPaste');
    var token = (el.value || '').trim();
    if (!token) return showToast('Paste a token first', '#f87171');
    try {
      var res = await secretFetch('/token-sync/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broker: broker, token: token })
      });
      if (!res) return;                       // secret prompt cancelled
      var d = await res.json();
      if (!d.success) return showToast(d.error || 'Apply failed', '#f87171');
      el.value = '';
      SNAP = d.snapshot; render();
      showToast(broker.toUpperCase() + ' token applied', '#34d399');
    } catch (e) { showToast('Apply failed: ' + e.message, '#f87171'); }
  }

  async function restartApp(){
    var ok = await showConfirm({
      icon: '♻',
      title: 'Restart the app?',
      message: 'Only do this if the app runs under PM2 or nodemon.\\nA plain "npm start" will stop instead of coming back.',
      confirmText: 'Restart',
      confirmClass: 'modal-btn-danger'
    });
    if (!ok) return;
    try {
      var res = await secretFetch('/token-sync/restart', { method: 'POST' });
      if (!res) return;                       // secret prompt cancelled
      var d = await res.json();
      showToast(d.success ? d.message : (d.error || 'Restart failed'), d.success ? '#fbbf24' : '#f87171');
    } catch (e) { showToast('Restarting…', '#fbbf24'); }   // socket dies as the process exits
  }

  load();
  _timer = setInterval(load, 60000);
</script>
</body>
</html>`);
});

module.exports = router;

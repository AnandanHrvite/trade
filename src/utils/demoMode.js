/**
 * demoMode.js — read-only "stakeholder demo" login
 * ─────────────────────────────────────────────────────────────────────────────
 * The app has one owner password (LOGIN_SECRET). This adds a SECOND password
 * (DEMO_LOGIN_SECRET) that opens the same UI in a look-but-don't-touch session:
 * a stakeholder can walk every read-only screen, and nothing they click can
 * start a session, place an order, change a setting or delete a file.
 *
 * Three layers, in order of authority:
 *
 *   1. SERVER POLICY (this file, `allows()`)  ← the only one that matters
 *      Deny-by-default. A demo request must be GET/HEAD, must not touch a path
 *      segment that names an action (start/stop/reset/save/delete/…), must not
 *      be under a denied page prefix, and must match the allowlist. Everything
 *      else is refused before it reaches a router.
 *
 *   2. NAVIGATION (sharedNav)
 *      The sidebar drops every item the policy would refuse and hides the
 *      Start / Stop / Exit buttons, so the demo never shows a dead link.
 *
 *   3. PAGE GUARD (`guardJS`, injected into every HTML response)
 *      Neutralises action buttons and forms in the page and blocks non-GET
 *      fetch/XHR in the browser. Cosmetic only — layer 1 is the gate.
 *
 * Why deny-by-default: this repo mounts ~70 routers that each own their own
 * write paths. An allowlist that has to be extended for a new page fails
 * closed (a screen is missing from the demo); a blocklist that someone forgets
 * to extend fails open (a stakeholder can stop a live session). Only the first
 * failure mode is acceptable.
 *
 * Settings: DEMO_LOGIN_ENABLED, DEMO_LOGIN_SECRET, DEMO_SHOW_LIVE.
 */

const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

// Per-request demo flag. sharedNav and the page helpers render deep inside the
// routers and never see `req`, so the flag rides the async context instead of
// being threaded through every buildSidebar() call site in the app.
const _als = new AsyncLocalStorage();

const envOn = (key, dflt = "false") =>
  String(process.env[key] || dflt).toLowerCase() === "true";

/** The demo password, "" when unset. */
function demoSecret() { return String(process.env.DEMO_LOGIN_SECRET || ""); }

/**
 * Demo login is live only when:
 *   • it is switched on in Settings, AND
 *   • a demo password is set, AND
 *   • the owner login is set — the demo cookie is only meaningful behind the
 *     login gate; with LOGIN_SECRET blank every page is already open, and a
 *     "read-only" session next to open access would be a false assurance, AND
 *   • the two passwords differ, else the owner would silently log in read-only.
 */
function isEnabled() {
  const demo = demoSecret();
  return envOn("DEMO_LOGIN_ENABLED")
      && demo.length > 0
      && !!process.env.LOGIN_SECRET
      && demo !== process.env.LOGIN_SECRET;
}

/** Cookie value for a demo session. Domain-separated from the owner token so a
 *  demo password can never collide with the owner's hash. */
function token() {
  return crypto.createHash("sha256").update("demo:" + demoSecret()).digest("hex");
}

/** Are LIVE (real-money) surfaces part of this demo? Default: no. */
function showsLive() { return envOn("DEMO_SHOW_LIVE"); }

// ── Request context ─────────────────────────────────────────────────────────
function runAsDemo(isDemoSession, fn) { return _als.run({ demo: !!isDemoSession }, fn); }
/** True while handling a request that authenticated with the demo password. */
function isDemo() { return _als.getStore() ? _als.getStore().demo === true : false; }

// ── Policy ──────────────────────────────────────────────────────────────────

// A path segment that names an action. Blocked wherever it appears, so a new
// router gets the same protection without being listed anywhere.
//   • state changers: start / stop / exit / reset / run / save / delete / …
//   • credential and bulk-data reads that are writes in everything but method:
//     /settings/env returns the raw .env, /token-sync/tokens hands out a live
//     broker token, and the download/export endpoints stream whole data files.
const ACTION_SEGMENTS = new Set([
  "start", "stop", "exit", "reset", "run", "save", "apply", "restart", "restore",
  "delete", "delete-all", "clear", "clear-candles", "cancel", "refresh", "pull",
  "import", "order", "place", "fetch-and-start", "sync", "webhook",
  "env", "tokens", "secret",
  "download", "download-all", "download-day", "download-everything",
  "export", "export-json",
]);

// Whole areas a demo never sees. Owner-only tooling (config, credentials, host
// health, backups) plus the two pages that can move real money or real files.
const DENIED_PREFIXES = [
  "/settings",       // config — every field is a write waiting to happen
  "/token-sync",     // hands out live broker tokens
  "/login-logs",     // failed-login forensics: IPs, geolocation, typed passwords
  "/cache-files",    // raw file browser (and its delete endpoints)
  "/backup",         // data snapshots — /backup/status is re-allowed below
  "/sync",           // full data-directory download
  "/deploy",         // deploy webhook + status
  "/monitor",        // EC2 host monitor with restart actions
  "/swing-scanner",  // the one page that places a REAL order with no dry-run gate
  "/tracker",        // reads the owner's actual Zerodha positions
  "/logs",           // server log stream — carries internal errors and tokens
];

// Small read-only polls under otherwise denied prefixes that the shared chrome
// needs on every page. Without them the sidebar badge and the header banners
// render permanently broken in the demo.
const ALLOWED_EXACT = new Set([
  "/",
  "/health",
  "/api/session-active",
  "/api/start-all-roster",
  "/api/holidays",
  "/api/expiry-dates",
  "/auth/status",
  "/auth/status/all",
  "/auth/zerodha/status",
  "/auth/socket-health",
  "/auth/telegram-health",
  "/backup/status",
  "/logout",
]);

// Read-only screens a stakeholder should see, plus their data polls.
const ALLOWED_PREFIXES = [
  "/realtime",              // unified real-time monitor
  "/all-backtest",          // unified backtest dashboard (running one is a POST)
  "/replay",                // replay viewer — /replay/run is a POST, refused
  "/consolidation",         // paper trade history + analytics
  "/consolidation-report",
  "/edge-analytics",
  "/advisor",               // read-only settings advisor — suggests, never writes
  "/oi-monitor",
  "/compare",
  "/trade-logs",            // per-day JSONL viewer (downloads refused by segment)
  "/docs",                  // strategy guides
  "/vendor",                // self-hosted chart library
  "/favicon",
];

// LIVE surfaces, gated behind DEMO_SHOW_LIVE. Paper and backtest are the demo's
// default because they carry no real-money history.
const LIVE_PREFIXES = [
  "/live-consolidation",
  "/pnl-history",
];

// Strategy pages, matched by shape rather than by name so a new strategy joins
// the demo the moment it is mounted: /{slug}-paper|live|live-harness|backtest.
// The action segments above still apply, so /orb-paper/start stays refused.
const STRATEGY_RE = /^\/[a-z0-9_]+(?:-[a-z0-9_]+)*-(live-harness|paper|live|backtest)(\/|$)/;

/**
 * May a demo session make this request?
 * @returns {{ok: boolean, reason?: string}}
 */
function allows(method, path) {
  const m = String(method || "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    return { ok: false, reason: "Actions are disabled in the demo login." };
  }
  const p = String(path || "/").split("?")[0];

  const segments = p.split("/").filter(Boolean);
  if (segments.some(s => ACTION_SEGMENTS.has(s.toLowerCase()))) {
    return { ok: false, reason: "Actions and file downloads are disabled in the demo login." };
  }
  if (DENIED_PREFIXES.some(d => p === d || p.startsWith(d + "/")) && !ALLOWED_EXACT.has(p)) {
    return { ok: false, reason: "This page is not part of the demo." };
  }
  if (ALLOWED_EXACT.has(p)) return { ok: true };
  if (ALLOWED_PREFIXES.some(a => p === a || p.startsWith(a + "/"))) return { ok: true };

  const strategyMatch = STRATEGY_RE.exec(p);
  if (strategyMatch) {
    const isLiveSurface = strategyMatch[1] !== "paper" && strategyMatch[1] !== "backtest";
    if (isLiveSurface && !showsLive()) {
      return { ok: false, reason: "Live trading pages are not part of this demo." };
    }
    return { ok: true };
  }
  if (LIVE_PREFIXES.some(a => p === a || p.startsWith(a + "/"))) {
    return showsLive()
      ? { ok: true }
      : { ok: false, reason: "Live trading pages are not part of this demo." };
  }
  return { ok: false, reason: "This page is not part of the demo." };
}

/** Convenience for the sidebar: may a demo session open this link? */
function allowsPage(href) { return allows("GET", href).ok; }

// ── Page chrome ─────────────────────────────────────────────────────────────

/** Ribbon + disabled-control styling. Injected with the guard script. */
function guardCSS() {
  return `
.demo-ribbon{position:fixed;top:0;left:0;right:0;z-index:99999;display:flex;align-items:center;
  justify-content:center;gap:10px;padding:5px 12px;font-family:'IBM Plex Mono',ui-monospace,monospace;
  font-size:0.6rem;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#0b1220;
  background:linear-gradient(90deg,#fbbf24,#f59e0b);box-shadow:0 2px 12px rgba(0,0,0,0.35);}
.demo-ribbon span.demo-sub{font-weight:500;letter-spacing:0.06em;text-transform:none;opacity:0.82;}
body.demo-mode{padding-top:26px;}
body.demo-mode .sidebar{top:26px;}
.demo-blocked{opacity:0.42 !important;cursor:not-allowed !important;filter:grayscale(0.5);}
.demo-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:100000;
  background:#1c1408;border:1px solid #f59e0b;color:#fbbf24;padding:10px 18px;border-radius:10px;
  font-family:'IBM Plex Sans',sans-serif;font-size:0.78rem;font-weight:600;
  box-shadow:0 12px 34px rgba(0,0,0,0.5);opacity:0;transition:opacity 0.18s;}
.demo-toast.show{opacity:1;}
@media(max-width:768px){.demo-ribbon{font-size:0.54rem;letter-spacing:0.08em;}}`;
}

/**
 * In-page guard. Cosmetic — the server refuses these requests anyway — but it
 * is what keeps the demo from looking broken: without it a stakeholder clicks
 * "Start Paper" and gets a raw 403 JSON body instead of an explanation.
 */
function guardJS() {
  return `(function(){
  if (window.__demoGuard) return; window.__demoGuard = true;
  var MSG = 'Demo login is read-only — this action is disabled.';
  document.addEventListener('DOMContentLoaded', function(){ document.body.classList.add('demo-mode'); });
  if (document.body) document.body.classList.add('demo-mode');

  var toastEl = null, toastTimer = null;
  function toast(msg){
    if (!document.body) return;
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'demo-toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg || MSG;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('show'); }, 2600);
  }
  window.__demoToast = toast;

  // Anything whose label or handler names an action. Deliberately broad: a
  // false positive dims a button the server would have refused anyway.
  var ACTION_RE = /start|stop|exit|save|delete|remove|reset|clear|restore|run\\b|apply|import|sync|place|order|refresh|kill|restart|square|cancel|download|export/i;
  function isAction(el){
    if (el.closest && el.closest('.demo-ribbon')) return false;
    var txt = (el.textContent || '') + ' ' + (el.getAttribute('onclick') || '') + ' ' +
              (el.getAttribute('title') || '') + ' ' + (el.value || '');
    return ACTION_RE.test(txt);
  }
  function mark(root){
    var nodes = (root || document).querySelectorAll('button, input[type=submit], input[type=button], .sb-action-btn');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.__demoChecked) continue;
      el.__demoChecked = true;
      if (isAction(el)) el.classList.add('demo-blocked');
    }
  }
  document.addEventListener('DOMContentLoaded', function(){ mark(document); });
  // Pages render their tables and controls from polled JSON, so re-mark on change.
  try {
    new MutationObserver(function(){ mark(document); }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  document.addEventListener('click', function(ev){
    var el = ev.target && ev.target.closest ? ev.target.closest('button, input[type=submit], input[type=button], a') : null;
    if (!el) return;
    if (el.tagName === 'A') {
      var href = el.getAttribute('href') || '';
      if (href === '/logout' || href.charAt(0) === '#' || !href) return;
      if (el.hasAttribute('download')) { ev.preventDefault(); ev.stopPropagation(); toast(MSG); }
      return;
    }
    if (el.classList.contains('demo-blocked') || isAction(el)) {
      ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
      toast(MSG);
    }
  }, true);

  document.addEventListener('submit', function(ev){
    ev.preventDefault(); ev.stopPropagation(); toast(MSG);
  }, true);

  // Backstop: block programmatic writes even when no button was involved.
  var _fetch = window.fetch;
  window.fetch = function(input, init){
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      toast(MSG);
      return Promise.resolve(new Response(JSON.stringify({ success:false, error: MSG }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }));
    }
    return _fetch.apply(this, arguments);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method){
    var m = String(method || 'GET').toUpperCase();
    if (m !== 'GET' && m !== 'HEAD') { toast(MSG); throw new Error(MSG); }
    return _open.apply(this, arguments);
  };
})();`;
}

/** The fixed banner that tells the viewer what session they are in. */
function ribbonHTML() {
  return `<div class="demo-ribbon">👁 Demo — read-only<span class="demo-sub">`
       + `viewing only, no actions</span></div>`;
}

/** Page shown when a demo session reaches a route the policy refuses. */
function blockedPageHTML(reason) {
  const { errorPage } = require("./sharedNav");
  return errorPage(
    "Not available in the demo",
    `${reason} You are signed in with the read-only demo login.`,
    "/", "← Back to Dashboard", "dashboard");
}

module.exports = {
  isEnabled, token, showsLive, demoSecret,
  runAsDemo, isDemo,
  allows, allowsPage,
  guardCSS, guardJS, ribbonHTML, blockedPageHTML,
  // exported for the regression suite
  ACTION_SEGMENTS, DENIED_PREFIXES,
};

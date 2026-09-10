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
  "/login-logs",     // login forensics: IPs, geolocation, typed passwords, demo sign-ins
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

// ── Branding ────────────────────────────────────────────────────────────────
// The demo is shown to people outside the household, so it carries the neutral
// product name and never the owner's personal dedication. Applied as a rewrite
// of the outgoing HTML rather than a per-page conditional: the name is spelled
// out in ~16 files (page <title> tags, the report header, the sidebar brand)
// and a page written next year would otherwise reintroduce it silently.
const DEMO_BRAND = "Trading Bot";
// Matches the dedication with or without its Om marks, and swallows a trailing
// "Trading Bot" so "Palani Andawar Trading Bot" does not become it twice. The
// trailing group is one alternation rather than two optional pieces — split up,
// it would eat the "—" separator in "… \u0950 — Dashboard" and glue the words.
const BRAND_RE = /(?:\u0BD0\s*)?Palani\s+Andawar(?:\s+Thunai)?(?:\s*\u0950)?(?:\s*[\u2014-]\s*Trading\s+BOT\b|\s+Trading\s+Bot\b)?/gi;

/** Replace the owner's dedication with the product name. */
function rebrand(html) {
  return String(html)
    .replace(BRAND_RE, DEMO_BRAND)
    // A few titles shout "Trading BOT"; the demo shows one spelling of the name.
    .replace(/Trading\s+BOT\b/g, DEMO_BRAND);
}

// ── Page chrome ─────────────────────────────────────────────────────────────

/** Ribbon + disabled-control styling. Injected with the guard script. */
function guardCSS() {
  return `
.demo-blocked{display:none !important;}
.demo-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:100000;
  background:#1c1408;border:1px solid #f59e0b;color:#fbbf24;padding:10px 18px;border-radius:10px;
  font-family:'IBM Plex Sans',sans-serif;font-size:0.78rem;font-weight:600;
  box-shadow:0 12px 34px rgba(0,0,0,0.5);opacity:0;transition:opacity 0.18s;}
.demo-toast.show{opacity:1;}
`;
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
  var ACTION_RE = /start|stop|exit|save|delete|remove|reset|clear|restore|\\brun\\b|apply|import|sync|place|order|kill|restart|square|download|export/i;
  function isAction(el){
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
      // Hidden, not dimmed: a control the demo can never use is noise.
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

/**
 * No page banner. The sidebar already says DEMO twice (brand sub-line and the
 * read-only pill), and a fixed ribbon also painted itself a second time inside
 * the Logs page's embedded tabs, which are a whole app shell in an iframe.
 */
function ribbonHTML() { return ""; }

/**
 * Page shown when a demo session reaches a route the policy refuses.
 * `embedded` renders a bare card: the Logs page loads its tabs in iframes, and
 * the full errorPage there paints a second sidebar inside the first.
 */
function blockedPageHTML(reason, embedded = false) {
  if (embedded) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>Not available in the demo</title><style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'IBM Plex Sans',-apple-system,sans-serif;background:#060810;color:#8899aa;
  min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px;}
.card{border:1px solid #7f1d1d;background:#0d1320;border-radius:12px;padding:26px 30px;text-align:center;max-width:380px;}
.t{color:#ef4444;font-size:0.95rem;font-weight:700;margin:10px 0 8px;}
.m{font-size:0.8rem;line-height:1.6;}
</style></head><body><div class="card"><div style="font-size:1.8rem;">🚫</div>
<div class="t">Not available in the demo</div><div class="m">${reason}</div></div></body></html>`;
  }
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
  rebrand, DEMO_BRAND,
  // exported for the regression suite
  ACTION_SEGMENTS, DENIED_PREFIXES,
};

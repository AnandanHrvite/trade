require("dotenv").config();
require("./services/logger");              // ← MUST be first: intercepts all console.* from here on
// Common Trade Rules: override every strategy's entry window / forced exit in
// process.env before any route module reads them.
require("./utils/commonTradeWindow").apply();
// Express 4 does not forward a rejected `async (req, res)` handler to the error
// middleware — the request hangs forever and the rejection lands on the
// process-level unhandledRejection handler below (Telegram alert, no response).
// This patches the router layer so every async route reaches the central error
// handler instead. MUST run before the route modules are required.
require("./utils/asyncRouteErrors").install();

const express     = require("express");
const compression = require("compression");
const https       = require("https");
const fs          = require("fs");
const { ACTIVE } = require("./strategies");
const instrumentConfig = require("./config/instrument");
const zerodha  = require("./services/zerodhaBroker");
const { clearFyersToken } = require("./config/fyers");
// The Dashboard page itself is rendered by routes/dashboard.js.
const { buildSidebar } = require("./utils/sharedNav");
const { resolveTheme } = require("./utils/theme");

// Start-All roster. The dashboard's Start All (Paper) button
// no longer reads a hand-written route table: startAllRoster.js discovers every
// mounted router that exposes a /start route and joins it to the enabled
// strategies from sharedNav's STRATEGY_MODES. Mount a new strategy's routes the
// usual way (/{slug}-paper) and it joins
// Start All with no further wiring — see the module header for the contract.
const { trackMounts, startAllRoster } = require("./utils/startAllRoster");
// Pure page routers (backtests, analysis tools) mount lazily — their module is only
// required on first request, so a disabled strategy's pages cost no heap at boot.
const { lazyRouter } = require("./utils/lazyRouter");
const sharedSocketState = require("./utils/sharedSocketState");

const crypto = require("crypto");
const loginLogStore = require("./utils/loginLogStore");
const demoMode      = require("./utils/demoMode");   // read-only stakeholder login
const { sendTelegram, sendTelegramSync, getTelegramHealth, isConfigured: telegramConfigured } = require("./utils/notify");
const consolidatedEodReporter = require("./utils/consolidatedEodReporter");
const manualTradesSyncJob = require("./utils/manualTradesSyncJob");
const app = express();
trackMounts(app);   // record every app.use(path, router) so Start All can discover the strategy routes
app.use(compression());
// Keep the raw bytes of the deploy webhook only — its X-Hub-Signature-256 HMAC
// is computed over the exact payload, which a re-serialised req.body is not.
const _keepWebhookRaw = (req, _res, buf) => {
  if (req.originalUrl && req.originalUrl.split("?")[0] === "/deploy/webhook") req.rawBody = buf;
};
app.use(express.json({ limit: "25mb", verify: _keepWebhookRaw })); // tradebook CSV imports (pnlHistory.js) can be several MB of JSON-wrapped text

// ── Right-click suppression (UI_DISABLE_RIGHT_CLICK) ────────────────────────
// Wraps res.send so the guard script lands in EVERY HTML page. The routes each
// render their own markup with no shared layout, and neither shared head helper
// (faviconLink / buildSidebar) is used by all of them — a per-page edit would
// have missed the standalone backtest interstitials and the login page.
// process.env is read per request, which is what makes the Settings toggle
// instant: no restart, the next page load already has it.
const { noContextMenuJS } = require("./utils/sharedNav");
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => {
    if (String(process.env.UI_DISABLE_RIGHT_CLICK || "").toLowerCase() !== "true") return send(body);
    if (typeof body !== "string" || !/^\s*<(!doctype html|html)\b/i.test(body)) return send(body);
    const tag = `<script>${noContextMenuJS()}</script>`;
    // Prefer just inside </body>; pages that omit it get the tag appended.
    const i = body.lastIndexOf("</body>");
    return send(i === -1 ? body + tag : body.slice(0, i) + tag + body.slice(i));
  };
  next();
});

// ── Vendored front-end libraries ────────────────────────────────────────────
// Self-host the Lightweight Charts library (used by every strategy's chart)
// instead of pulling it from unpkg.com at page load. A CDN outage / blocked
// network hop used to blank ALL charts app-wide (the render code early-returns
// when `LightweightCharts` is undefined). Mounted BEFORE the login gate so the
// asset always loads, and cached hard since the versioned file is immutable.
app.use("/vendor", express.static(require("path").join(__dirname, "public/vendor"), {
  maxAge: "30d",
  immutable: true,
}));

// ── Login gate — page-level password protection ─────────────────────────────
// Set LOGIN_SECRET in .env. If set, every page requires a login cookie first.
// If empty/unset, all pages are open normally.
const LOGIN_COOKIE = "__trade_login";
// Idle-timeout (seconds) before the login cookie is rejected. Read live from
// env so Settings edits to LOGIN_SESSION_MIN take effect on the next request.
function loginMaxAge() {
  const m = Number(process.env.LOGIN_SESSION_MIN);
  return Number.isFinite(m) && m >= 1 ? m * 60 : 900; // default 15 min
}
// ── OTP unlock (locked-out escape hatch) ────────────────────────────────────
// When an IP is rate-limited, the owner can prove identity by typing the mobile
// number saved in Settings (LOGIN_OTP_MOBILE). A one-time code is then sent to
// the configured Telegram chat; entering it clears the lockout for that IP so
// the password can be retried without waiting out the timer.
const LOGIN_OTP_TTL_MS      = 5 * 60 * 1000; // code validity
const LOGIN_OTP_RESEND_MS   = 60 * 1000;     // cooldown between sends per IP
const LOGIN_OTP_MAX_SENDS   = 5;             // send requests per lockout per IP
const LOGIN_OTP_MAX_TRIES   = 5;             // wrong-code attempts per code
// One record per IP. `hash`/`codeExpiresAt`/`tries` are the live code; `sends`/
// `lastSentAt` are throttle state that must OUTLIVE the code — a verify that
// wipes the record would reset the send cap and reopen unlimited guessing of
// the saved mobile. `expiresAt` (record lifetime, ≥ the lockout) drives eviction.
const _loginOtps = {};  // { ip: { hash, codeExpiresAt, tries, sends, lastSentAt, expiresAt } }

/** Digits-only form of the mobile saved in Settings ("" when not configured). */
function _loginOtpMobile() {
  return String(process.env.LOGIN_OTP_MOBILE || "").replace(/\D/g, "");
}
/** OTP unlock is offered only when both a mobile and Telegram are configured. */
function _loginOtpReady() {
  return _loginOtpMobile().length >= 6 && telegramConfigured();
}
function _clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
      || req.socket?.remoteAddress || "unknown";
}
function _sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }

/**
 * Record one login attempt in the login log.
 *
 * `result` is "failed" for a wrong password and "demo" for a successful
 * read-only demo sign-in — the demo password is shared with stakeholders, so
 * who used it and from where is worth the same forensics as a wrong guess.
 * `passwordShown` is what the log displays: the typed string for a failed try,
 * a placeholder for demo (never write our own secret to disk).
 *
 * Geolocation: browser GPS when the login form sent it, else a best-effort IP
 * lookup. The lookup is fire-and-forget — the entry is written either way and
 * the caller never waits on it.
 */
function _recordLoginAttempt(req, ip, result, passwordShown) {
  const at = new Date();
  const browserLat = parseFloat(req.body?.lat);
  const browserLon = parseFloat(req.body?.lon);
  const hasBrowserGPS = !isNaN(browserLat) && !isNaN(browserLon);
  const entry = {
    time: at.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23" }),
    // IST, to match `time` above. toISOString() is UTC, so an attempt between
    // midnight and 05:30 IST — prime bot-scan hours — was filed under the
    // previous day next to an IST clock time.
    date: at.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    ip,
    result,
    password: passwordShown,
    userAgent: req.headers["user-agent"] || "",
    lat: hasBrowserGPS ? browserLat : null,
    lon: hasBrowserGPS ? browserLon : null,
    city: (hasBrowserGPS && req.body?.geoCity) ? req.body.geoCity : null,
    geoSource: hasBrowserGPS ? "gps" : "ip",
  };
  if (hasBrowserGPS) return loginLogStore.addEntry(entry);

  try {
    const geoUrl = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=lat,lon,city,status`;
    const geoReq = require("http").get(geoUrl, { timeout: 3000 }, (geoRes) => {
      let body = "";
      geoRes.on("data", c => body += c);
      geoRes.on("end", () => {
        try {
          const g = JSON.parse(body);
          if (g.status === "success") { entry.lat = g.lat; entry.lon = g.lon; entry.city = g.city || null; }
        } catch {}
        loginLogStore.addEntry(entry);
      });
    });
    geoReq.on("error", () => loginLogStore.addEntry(entry));
    geoReq.on("timeout", () => { geoReq.destroy(); loginLogStore.addEntry(entry); });
  } catch { loginLogStore.addEntry(entry); }
}

function loginPageHTML(error, opts = {}) {
  const lockedSec = Number(opts.lockedSec) > 0 ? Math.ceil(Number(opts.lockedSec)) : 0;
  const otpOffer  = lockedSec > 0 && _loginOtpReady();
  // Theme is a server-side setting, so stamp it on <html> in the markup instead
  // of via a client script — that removes the dark-flash before paint on light.
  const isLight   = resolveTheme() === "light";
  return `<!DOCTYPE html><html lang="en"${isLight ? ' data-theme="light"' : ''}><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="${isLight ? '#eef2f7' : '#05080f'}">
<meta name="color-scheme" content="${isLight ? 'light' : 'dark'}">
<meta name="robots" content="noindex,nofollow">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Login — Trading Bot</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>ௐ</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#05080f;--bg2:#080d18;
  --card:rgba(13,19,32,.88);--card-b:#1a2236;
  --text:#e6eefc;--muted:#6b86ad;--dim:#6d85a8;
  --field:#070d18;--field-b:#1b2b42;
  --accent:#3b82f6;--accent2:#22d3ee;--accent-d:#1d3fa8;
  --ok:#22c55e;--err:#f87171;--err-bg:#1c0610;--err-b:#500e20;
  --grid:rgba(59,130,246,.055);
  --ring:rgba(59,130,246,.18);
  --shadow:0 24px 70px rgba(0,0,0,.62);
}
:root[data-theme="light"]{
  --bg:#eef2f7;--bg2:#f8fafc;
  --card:rgba(255,255,255,.94);--card-b:#e2e8f0;
  --text:#0f172a;--muted:#4b5769;--dim:#5c6b7f;
  --field:#f8fafc;--field-b:#dfe6ef;
  --accent:#2563eb;--accent2:#0ea5e9;--accent-d:#1d4ed8;
  --ok:#16a34a;--err:#dc2626;--err-bg:#fef2f2;--err-b:#fecaca;
  --grid:rgba(37,99,235,.07);
  --ring:rgba(37,99,235,.16);
  --shadow:0 18px 50px rgba(15,23,42,.13);
}
*{margin:0;padding:0;box-sizing:border-box;}
html{-webkit-text-size-adjust:100%;background:var(--bg);}
body{
  background:var(--bg);color:var(--text);
  font-family:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  min-height:100vh;min-height:100dvh;
  display:flex;align-items:center;justify-content:center;
  padding:calc(24px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right))
          calc(24px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left));
  -webkit-tap-highlight-color:transparent;overflow-x:hidden;
}
/* Ambient glow + terminal grid — decorative, pointer-transparent, fixed so it
   never adds scroll height on short mobile viewports. */
body::before{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background:radial-gradient(900px 520px at 50% -10%,rgba(59,130,246,.16),transparent 70%),
             radial-gradient(700px 460px at 90% 110%,rgba(34,211,238,.10),transparent 70%),
             linear-gradient(180deg,var(--bg) 0%,var(--bg2) 100%);}
body::after{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:linear-gradient(var(--grid) 1px,transparent 1px),
                   linear-gradient(90deg,var(--grid) 1px,transparent 1px);
  background-size:44px 44px;
  -webkit-mask-image:radial-gradient(circle at 50% 42%,#000 0%,transparent 76%);
          mask-image:radial-gradient(circle at 50% 42%,#000 0%,transparent 76%);}
.shell{position:relative;z-index:1;width:100%;max-width:404px;}
.card{background:var(--card);border:1px solid var(--card-b);border-radius:18px;
  padding:28px 26px 24px;box-shadow:var(--shadow);position:relative;overflow:hidden;
  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;
  background:linear-gradient(90deg,transparent,var(--accent),var(--accent2),transparent);
  background-size:200% 100%;animation:sweep 7s linear infinite;}
@keyframes sweep{from{background-position:200% 0}to{background-position:-200% 0}}
.stat{display:flex;align-items:center;justify-content:space-between;gap:10px;
  font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:.6rem;font-weight:500;letter-spacing:.11em;text-transform:uppercase;color:var(--dim);margin-bottom:22px;}
.dot{width:6px;height:6px;border-radius:50%;background:var(--ok);display:inline-block;
  margin-right:7px;vertical-align:middle;animation:pulse 2.4s ease-out infinite;}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.45)}70%{box-shadow:0 0 0 7px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
.brand{display:flex;flex-direction:column;align-items:center;text-align:center;margin-bottom:24px;}
.mark{width:56px;height:56px;border-radius:16px;display:grid;place-items:center;margin-bottom:14px;
  background:linear-gradient(145deg,rgba(59,130,246,.22),rgba(34,211,238,.08));
  border:1px solid rgba(59,130,246,.34);box-shadow:0 8px 22px rgba(0,0,0,.32);}
.mark svg{width:29px;height:29px;display:block;}
.brand h1{font-size:1.2rem;font-weight:700;letter-spacing:.17em;text-transform:uppercase;line-height:1.2;}
.tag{margin-top:7px;font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:.58rem;font-weight:500;
  letter-spacing:.2em;text-transform:uppercase;color:var(--muted);}
.lbl{display:block;font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:.6rem;font-weight:600;
  letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;}
.wrap{position:relative;display:flex;align-items:center;}
.wrap .ico{position:absolute;left:14px;width:15px;height:15px;color:var(--dim);pointer-events:none;}
/* 16px font-size is deliberate: anything smaller makes iOS Safari zoom the page
   on focus, which breaks the centred layout on iPhone. */
.login-input{width:100%;min-height:48px;padding:13px 14px;border-radius:10px;
  border:1px solid var(--field-b);background:var(--field);color:var(--text);
  font-size:16px;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s;}
.wrap .login-input{padding-left:40px;padding-right:52px;}
.login-input::placeholder{color:var(--dim);}
.login-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--ring);}
.login-input:disabled{opacity:.55;cursor:not-allowed;}
/* 44×44 = Apple's minimum touch target; it still fits inside the 48px field. */
.eye{position:absolute;right:3px;width:44px;height:44px;border:none;background:none;color:var(--dim);
  cursor:pointer;display:grid;place-items:center;border-radius:9px;}
.eye:hover,.eye:focus-visible{color:var(--text);outline:none;}
.eye svg{width:17px;height:17px;display:block;}
.login-btn{width:100%;margin-top:16px;min-height:50px;padding:14px;border-radius:10px;border:none;
  background:linear-gradient(135deg,var(--accent-d),var(--accent));color:#fff;
  font-size:.8rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;font-family:inherit;
  cursor:pointer;display:flex;align-items:center;justify-content:center;gap:9px;
  box-shadow:0 8px 22px rgba(37,99,235,.26);transition:filter .15s,transform .08s,box-shadow .15s;}
.login-btn svg{width:15px;height:15px;flex:none;}
.login-btn:hover{filter:brightness(1.13);}
.login-btn:active{transform:translateY(1px);}
.login-btn:disabled{background:var(--field);color:var(--dim);box-shadow:none;filter:none;cursor:not-allowed;}
.btn-alt{background:transparent;border:1px solid var(--field-b);color:var(--text);box-shadow:none;}
.btn-alt:hover{filter:none;border-color:var(--accent);color:var(--accent);}
.login-error{margin-top:14px;padding:10px 12px;border-radius:9px;background:var(--err-bg);
  border:1px solid var(--err-b);color:var(--err);font-size:.74rem;line-height:1.45;text-align:center;
  display:${error ? 'block' : 'none'};}
.foot{margin-top:20px;padding-top:14px;border-top:1px solid var(--card-b);
  display:flex;align-items:center;justify-content:center;gap:7px;
  font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:.58rem;font-weight:500;
  letter-spacing:.09em;text-transform:uppercase;color:var(--dim);}
.foot svg{width:11px;height:11px;flex:none;}
.legal{margin-top:16px;text-align:center;font-size:.62rem;line-height:1.5;color:var(--dim);}
.otp-box{margin-top:20px;padding-top:18px;border-top:1px solid var(--card-b);}
.otp-title{font-size:.74rem;font-weight:600;color:var(--text);text-align:center;margin-bottom:5px;}
.otp-hint{font-size:.66rem;line-height:1.45;color:var(--muted);text-align:center;margin-bottom:12px;}
.otp-msg{margin-top:11px;font-size:.7rem;text-align:center;color:var(--muted);min-height:1em;}
.otp-msg.err{color:var(--err);}
.otp-msg.ok{color:var(--ok);}
/* Narrow phones (iPhone SE / mini) */
@media (max-width:400px){
  .card{padding:24px 19px 20px;border-radius:16px;}
  .brand h1{font-size:1.06rem;letter-spacing:.14em;}
  .stat{font-size:.55rem;letter-spacing:.08em;}
}
/* Short viewports (landscape phones) — top-align so the card can scroll */
@media (max-height:660px){
  body{align-items:flex-start;}
  .brand{margin-bottom:18px;}
  .mark{width:46px;height:46px;border-radius:13px;margin-bottom:11px;}
  .mark svg{width:24px;height:24px;}
  .stat{margin-bottom:16px;}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important;}
}
</style></head><body>
<div class="shell">
<div class="card">
<div class="stat"><span><span class="dot"></span>System online</span><span id="clock">--:--:--&nbsp;IST</span></div>
<div class="brand">
<div class="mark">
<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
<defs><linearGradient id="lg" x1="0" y1="32" x2="32" y2="0"><stop stop-color="#3b82f6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
<path d="M3 25l8-9.5 6 5L29 6" stroke="url(#lg)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M22.5 6H29v6.5" stroke="url(#lg)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
</div>
<h1>Trading Bot</h1>
<div class="tag">Algorithmic Execution Terminal</div>
</div>
<form id="loginForm" method="POST" action="/login" autocomplete="on">
<label class="lbl" for="pwdInput">Access key</label>
<div class="wrap">
<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
<input type="password" name="password" id="pwdInput" class="login-input" placeholder="Enter password" autocomplete="current-password" autofocus required>
<button type="button" class="eye" id="pwdToggle" aria-label="Show password">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
</button>
</div>
<input type="hidden" name="lat" id="lat">
<input type="hidden" name="lon" id="lon">
<input type="hidden" name="geoCity" id="geoCity">
<button type="submit" class="login-btn" id="loginBtn">
<span>Unlock terminal</span>
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
</button>
</form>
<div class="login-error" id="loginError">${error || ''}</div>
${otpOffer ? `<div class="otp-box">
<div class="otp-title">Locked out? Unlock with OTP</div>
<div class="otp-hint">Enter your registered mobile number — the code goes to Telegram.</div>
<input type="tel" id="otpMobile" class="login-input" placeholder="Registered mobile number" inputmode="numeric" autocomplete="tel">
<button type="button" class="login-btn btn-alt" id="otpSendBtn">Send OTP to Telegram</button>
<div id="otpStep2" style="display:none;margin-top:14px;">
<input type="text" id="otpCode" class="login-input" placeholder="6-digit OTP" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
<button type="button" class="login-btn btn-alt" id="otpVerifyBtn">Verify &amp; Unlock</button>
</div>
<div class="otp-msg" id="otpMsg"></div>
</div>` : ''}
<div class="foot">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
<span>Encrypted session · NSE hours 09:15–15:30 IST</span>
</div>
</div>
<div class="legal">Authorized access only. Every attempt is logged.</div>
</div>
<script>
// ── IST clock ──────────────────────────────────────────────────────────────
(function(){
  var el = document.getElementById('clock');
  if (!el) return;
  function tick(){
    try {
      el.innerHTML = new Date().toLocaleTimeString('en-IN', { timeZone:'Asia/Kolkata', hourCycle:'h23' }) + '&nbsp;IST';
    } catch (e) { el.textContent = ''; return; }  // no tz support — stop, don't loop on the same failure
    setTimeout(tick, 1000);
  }
  tick();
})();
// ── Show / hide password ───────────────────────────────────────────────────
(function(){
  var btn = document.getElementById('pwdToggle');
  var pwd = document.getElementById('pwdInput');
  if (!btn || !pwd) return;
  btn.addEventListener('click', function(){
    var show = pwd.type === 'password';
    pwd.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    btn.style.color = show ? 'var(--accent)' : '';
    pwd.focus();
  });
})();
// ── Submit feedback (disabled only AFTER the browser has serialised the form) ─
(function(){
  var form = document.getElementById('loginForm');
  var btn  = document.getElementById('loginBtn');
  if (!form || !btn) return;
  var busy = false;
  form.addEventListener('submit', function(){
    setTimeout(function(){
      if (btn.disabled) return;            // locked out — the countdown owns the button
      busy = true; btn.disabled = true; btn.textContent = 'Authenticating…';
    }, 0);
  });
  // Coming back to this page from the bfcache (browser Back) restores the DOM
  // as-is, which would otherwise leave the button stuck on "Authenticating…".
  window.addEventListener('pageshow', function(e){
    if (e.persisted && busy) location.reload();
  });
})();
// ── Lockout countdown ──────────────────────────────────────────────────────
(function(){
  var left = ${lockedSec};
  if (left <= 0) return;
  var box = document.getElementById('loginError');
  var btn = document.getElementById('loginBtn');
  var pwd = document.getElementById('pwdInput');
  if (btn) btn.disabled = true;
  if (pwd) { pwd.disabled = true; pwd.blur(); }
  box.style.display = 'block';
  function fmt(s){ var m = Math.floor(s/60), r = s%60; return m + ':' + (r<10?'0':'') + r; }
  function tick(){
    if (left <= 0) { location.reload(); return; }
    box.textContent = 'Too many attempts. Try again in ' + fmt(left);
    left--;
    setTimeout(tick, 1000);
  }
  tick();
})();
// ── OTP unlock ─────────────────────────────────────────────────────────────
(function(){
  var sendBtn = document.getElementById('otpSendBtn');
  if (!sendBtn) return;
  var verifyBtn = document.getElementById('otpVerifyBtn');
  var msg = document.getElementById('otpMsg');
  function say(text, cls){ msg.textContent = text; msg.className = 'otp-msg' + (cls ? ' ' + cls : ''); }
  function post(url, payload, btn, label){
    btn.disabled = true;
    return fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
      .then(function(r){ return r.json().catch(function(){ return { success:false, error:'Server error.' }; }); })
      .catch(function(){ return { success:false, error:'Network error. Try again.' }; })
      .then(function(d){ btn.disabled = false; btn.textContent = label; return d; });
  }
  sendBtn.addEventListener('click', function(){
    var mobile = (document.getElementById('otpMobile').value || '').trim();
    if (mobile.replace(/\\D/g, '').length < 6) { say('Enter your mobile number.', 'err'); return; }
    say('Sending…');
    sendBtn.textContent = 'Sending…';
    post('/login/otp/send', { mobile: mobile }, sendBtn, 'Resend OTP').then(function(d){
      say(d.message || d.error || '', d.success ? 'ok' : 'err');
      if (d.success) {
        document.getElementById('otpStep2').style.display = 'block';
        document.getElementById('otpCode').focus();
      }
    });
  });
  verifyBtn.addEventListener('click', function(){
    var code = (document.getElementById('otpCode').value || '').trim();
    if (!/^\\d{6}$/.test(code)) { say('Enter the 6-digit OTP.', 'err'); return; }
    say('Verifying…');
    verifyBtn.textContent = 'Verifying…';
    post('/login/otp/verify', { otp: code }, verifyBtn, 'Verify & Unlock').then(function(d){
      if (d.success) { say('Unlocked — reloading…', 'ok'); location.reload(); }
      else say(d.error || 'Invalid OTP.', 'err');
    });
  });
})();
// Request browser GPS on page load (silent — if denied, fields stay empty)
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(function(pos) {
    document.getElementById('lat').value = pos.coords.latitude.toFixed(6);
    document.getElementById('lon').value = pos.coords.longitude.toFixed(6);
    // Reverse geocode for city name (best-effort)
    fetch('https://nominatim.openstreetmap.org/reverse?lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude + '&format=json&zoom=10')
      .then(function(r){ return r.json(); })
      .then(function(d){
        var city = (d.address && (d.address.city || d.address.town || d.address.village || d.address.state_district)) || '';
        document.getElementById('geoCity').value = city;
      }).catch(function(){});
  }, function(){}, { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 });
}
</script>
</body></html>`;
}

// URL-encoded body parser for login form
app.use(express.urlencoded({ extended: false, verify: _keepWebhookRaw }));

app.get("/login", (req, res) => {
  const secret = process.env.LOGIN_SECRET;
  if (!secret) return res.redirect("/");
  res.setHeader("Content-Type", "text/html");
  // Re-render the countdown after a reload so the lockout stays visible.
  const remainMs = _loginLockRemainingMs(_clientIp(req));
  res.send(remainMs > 0
    ? loginPageHTML(`Too many attempts. Try again in ${Math.ceil(remainMs / 60000)} minutes.`, { lockedSec: remainMs / 1000 })
    : loginPageHTML());
});

// ── Login rate limiting — brute-force protection ─────────────────────────────
// Limits are read live from env so Settings edits take effect on the next attempt.
const _loginAttempts = {};  // { ip: { count, firstAttempt } }
let _lastLoginSweep = 0;
function _loginRateMax()    { const n = Number(process.env.LOGIN_RATE_MAX);        return Number.isFinite(n) && n >= 1 ? n : 5; }
function _loginRateWindow() { const m = Number(process.env.LOGIN_RATE_WINDOW_MIN); return (Number.isFinite(m) && m >= 1 ? m : 15) * 60 * 1000; }
/** Milliseconds left on this IP's lockout (0 when it isn't locked out). */
function _loginLockRemainingMs(ip) {
  const entry = _loginAttempts[ip];
  if (!entry || entry.count < _loginRateMax()) return 0;
  const remain = _loginRateWindow() - (Date.now() - entry.firstAttempt);
  return remain > 0 ? remain : 0;
}

app.post("/login", (req, res) => {
  const secret = process.env.LOGIN_SECRET;
  if (!secret) return res.redirect("/");

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
           || req.socket?.remoteAddress || "unknown";

  // Rate limit check
  const now    = Date.now();
  const winMs  = _loginRateWindow();
  const maxTry = _loginRateMax();
  // Throttled sweep (no standing timer): drop IPs whose window has fully expired —
  // they'd be reset on next attempt anyway, so eviction is lossless and keeps the
  // map from growing unbounded across many/rotating IPs hitting /login.
  if (now - _lastLoginSweep > 60_000) {
    _lastLoginSweep = now;
    for (const k of Object.keys(_loginAttempts)) {
      if (now - _loginAttempts[k].firstAttempt > winMs) delete _loginAttempts[k];
    }
    for (const k of Object.keys(_loginOtps)) {
      if (now > _loginOtps[k].expiresAt) delete _loginOtps[k];
    }
  }
  if (_loginAttempts[ip]) {
    const entry = _loginAttempts[ip];
    if (now - entry.firstAttempt > winMs) {
      // Window expired — reset
      _loginAttempts[ip] = { count: 0, firstAttempt: now };
    } else if (entry.count >= maxTry) {
      const remainMs = winMs - (now - entry.firstAttempt);
      const waitMin  = Math.ceil(remainMs / 60000);
      console.warn(`🚫 [LOGIN] Rate limited IP ${ip} — ${entry.count} failed attempts. Wait ${waitMin}min.`);
      res.setHeader("Content-Type", "text/html");
      return res.status(429).send(loginPageHTML(`Too many attempts. Try again in ${waitMin} minutes.`, { lockedSec: remainMs / 1000 }));
    }
  } else {
    _loginAttempts[ip] = { count: 0, firstAttempt: now };
  }
  if (req.body.password === secret) {
    // Successful login — clear rate limit counter for this IP
    delete _loginAttempts[ip];
    const token = crypto.createHash("sha256").update(secret).digest("hex");
    res.setHeader("Set-Cookie", `${LOGIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${loginMaxAge()}`);
    // '/' auto-swaps to Real-Time when any session is active (UI_SHOW_REALTIME),
    // so a single redirect target now covers both cases.
    return res.redirect("/");
  }

  // ── Demo password — same form, read-only session ───────────────────────────
  // Checked AFTER the owner password so a mis-set DEMO_LOGIN_SECRET can never
  // downgrade the owner's own login (isEnabled() also refuses equal secrets).
  if (demoMode.isEnabled() && req.body.password === demoMode.demoSecret()) {
    delete _loginAttempts[ip];
    res.setHeader("Set-Cookie", `${LOGIN_COOKIE}=${demoMode.token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${loginMaxAge()}`);
    console.log(`👁 [LOGIN] Demo (read-only) session opened from ${ip}`);
    _recordLoginAttempt(req, ip, "demo", "(demo password)");
    return res.redirect("/");
  }

  // ── Failed attempt — increment rate limit counter ──────────────────────────
  if (_loginAttempts[ip]) _loginAttempts[ip].count++;
  else _loginAttempts[ip] = { count: 1, firstAttempt: now };

  // ── Log failed attempt ────────────────────────────────────────────────────
  _recordLoginAttempt(req, ip, "failed", req.body.password || "");

  res.setHeader("Content-Type", "text/html");
  res.send(loginPageHTML("Wrong password. Please try again."));
});

// ── POST /login/otp/send — mail a one-time unlock code to Telegram ──────────
// Only reachable while the caller's IP is actually locked out, so this adds no
// attack surface outside the lockout. The reply is deliberately identical for a
// right and a wrong mobile number (no number enumeration) and every request —
// right or wrong — burns one of the LOGIN_OTP_MAX_SENDS slots.
app.post("/login/otp/send", (req, res) => {
  if (!process.env.LOGIN_SECRET) return res.status(400).json({ success: false, error: "Login is not enabled." });
  if (!_loginOtpReady())        return res.status(400).json({ success: false, error: "OTP unlock is not configured." });

  const ip = _clientIp(req);
  if (_loginLockRemainingMs(ip) <= 0) return res.status(400).json({ success: false, error: "Not locked out — just log in." });

  const now  = Date.now();
  const prev = _loginOtps[ip];
  if (prev) {
    if (prev.sends >= LOGIN_OTP_MAX_SENDS) {
      return res.status(429).json({ success: false, error: "Too many OTP requests. Wait out the lockout." });
    }
    const waitMs = LOGIN_OTP_RESEND_MS - (now - prev.lastSentAt);
    if (waitMs > 0) {
      return res.status(429).json({ success: false, error: `Please wait ${Math.ceil(waitMs / 1000)}s before requesting another OTP.` });
    }
  }

  // The record must survive the whole lockout, else the send cap resets early.
  const record = {
    hash: null, codeExpiresAt: 0, tries: 0,
    sends: (prev?.sends || 0) + 1,
    lastSentAt: now,
    expiresAt: now + Math.max(LOGIN_OTP_TTL_MS, _loginLockRemainingMs(ip)),
  };
  const generic = "If the number is correct, an OTP has been sent to Telegram.";
  const typed   = String(req.body?.mobile || "").replace(/\D/g, "");
  const saved   = _loginOtpMobile();
  // Compare the last 10 digits so a typed "+91…" / "0…" prefix still matches.
  const match   = typed.length >= 6 && typed.slice(-10) === saved.slice(-10);

  if (!match) {
    // Burn a slot anyway, else a wrong number could be guessed without limit.
    _loginOtps[ip] = record;
    console.warn(`🚫 [LOGIN] OTP requested with a non-matching mobile from ${ip}`);
    return res.json({ success: true, message: generic });
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  record.hash = _sha256(code);
  record.codeExpiresAt = now + LOGIN_OTP_TTL_MS;
  _loginOtps[ip] = record;
  console.log(`🔑 [LOGIN] OTP unlock code sent to Telegram for ${ip}`);
  sendTelegram(
    `🔐 Trading Bot login OTP: ${code}\n` +
    `Valid ${Math.round(LOGIN_OTP_TTL_MS / 60000)} min. Requested from IP ${ip}.\n` +
    `It clears the login lockout. Ignore this if it wasn't you.`
  ).catch(() => {});
  return res.json({ success: true, message: generic });
});

// ── POST /login/otp/verify — clear this IP's lockout ────────────────────────
// A correct code only removes the rate-limit block; the password is still
// required to get a session.
app.post("/login/otp/verify", (req, res) => {
  if (!process.env.LOGIN_SECRET) return res.status(400).json({ success: false, error: "Login is not enabled." });

  const ip    = _clientIp(req);
  const entry = _loginOtps[ip];
  const now   = Date.now();
  // Only the code is ever invalidated here — the record (and its send cap)
  // stays, so verify can't be used to reset the throttle.
  if (!entry || !entry.hash || now > entry.codeExpiresAt) {
    if (entry) entry.hash = null;
    return res.status(400).json({ success: false, error: "No valid OTP — request a new one." });
  }
  if (entry.tries >= LOGIN_OTP_MAX_TRIES) {
    entry.hash = null;
    return res.status(429).json({ success: false, error: "Too many wrong OTPs — request a new one." });
  }
  entry.tries++;

  const typed = String(req.body?.otp || "").replace(/\D/g, "");
  const ok = typed.length === 6 && crypto.timingSafeEqual(
    Buffer.from(_sha256(typed), "hex"), Buffer.from(entry.hash, "hex"));
  if (!ok) {
    console.warn(`🚫 [LOGIN] Wrong OTP from ${ip} (${entry.tries}/${LOGIN_OTP_MAX_TRIES})`);
    return res.status(401).json({ success: false, error: `Invalid OTP. ${LOGIN_OTP_MAX_TRIES - entry.tries} attempt(s) left.` });
  }

  delete _loginOtps[ip];
  delete _loginAttempts[ip];
  console.log(`🔓 [LOGIN] Lockout cleared by OTP for ${ip}`);
  return res.json({ success: true });
});

app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${LOGIN_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.redirect("/login");
});

// Login gate middleware — must come before all other routes
app.use((req, res, next) => {
  const secret = process.env.LOGIN_SECRET;
  if (!secret) return next(); // no login secret → open
  if (req.path === "/login" || req.path === "/deploy/webhook") return next();
  // Parse cookie (split on first = only — values may contain =)
  const cookies = (req.headers.cookie || "").split(";").reduce((acc, c) => {
    const idx = c.indexOf("=");
    if (idx > 0) acc[c.substring(0, idx).trim()] = c.substring(idx + 1).trim();
    return acc;
  }, {});
  const expectedToken = crypto.createHash("sha256").update(secret).digest("hex");
  if (cookies[LOGIN_COOKIE] === expectedToken) {
    // Sliding expiry — refresh cookie on every request to reset the 15-min timer
    res.setHeader("Set-Cookie", `${LOGIN_COOKIE}=${expectedToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${loginMaxAge()}`);
    return next();
  }
  // Demo (read-only) session — same cookie, a different token. The request runs
  // inside demoMode's async context so the sidebar and page helpers, which never
  // see `req`, can render the read-only variant.
  if (demoMode.isEnabled() && cookies[LOGIN_COOKIE] === demoMode.token()) {
    res.setHeader("Set-Cookie", `${LOGIN_COOKIE}=${demoMode.token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${loginMaxAge()}`);
    return demoMode.runAsDemo(true, () => next());
  }
  // Not authenticated — redirect HTML pages, block API calls
  if (req.headers.accept && req.headers.accept.includes("text/html")) {
    return res.redirect("/login");
  }
  return res.status(401).json({ success: false, error: "Not authenticated" });
});

// ── Demo gate — the read-only session's only real boundary ──────────────────
// Runs immediately after login so nothing downstream (route, API_SECRET check,
// rate limiter) can be reached by a demo request the policy refuses. Everything
// the demo *is* allowed to see gets the ribbon + in-page guard injected here,
// which is why this wraps res.send rather than living in a page helper: the
// routers render their own HTML with no shared layout.
app.use((req, res, next) => {
  if (!demoMode.isDemo()) return next();

  // Wrap res.send FIRST so the refusal page below carries the ribbon too — it
  // is a page of the demo like any other, and it renders the shared sidebar.
  const send = res.send.bind(res);
  res.send = (body) => {
    if (typeof body !== "string" || !/^\s*<(!doctype html|html)\b/i.test(body)) return send(body);
    const head = `<style>${demoMode.guardCSS()}</style>`;
    const tail = demoMode.ribbonHTML() + `<script>${demoMode.guardJS()}</script>`;
    // The demo carries the neutral product name only — page titles and headers
    // spell the owner's dedication out in ~16 files, so it is rewritten here
    // once rather than conditioned per page.
    let out = demoMode.rebrand(body);
    const h = out.indexOf("</head>");
    out = h === -1 ? head + out : out.slice(0, h) + head + out.slice(h);
    const b = out.lastIndexOf("</body>");
    return send(b === -1 ? out + tail : out.slice(0, b) + tail + out.slice(b));
  };

  const verdict = demoMode.allows(req.method, req.path);
  if (!verdict.ok) {
    console.warn(`👁 [DEMO] refused ${req.method} ${req.path} — ${verdict.reason}`);
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      res.setHeader("Content-Type", "text/html");
      // The Logs page loads its tabs in iframes (?embed=1); a refusal there gets
      // a bare card instead of a second sidebar nested inside the first.
      const embedded = req.query.embed === "1" || req.headers["sec-fetch-dest"] === "iframe";
      return res.status(403).send(demoMode.blockedPageHTML(verdict.reason, embedded));
    }
    return res.status(403).json({ success: false, error: verdict.reason, demo: true });
  }
  next();
});

// ── Local security — simple secret token ────────────────────────────────────
// Set API_SECRET in .env. Pass as ?secret=xxx or header x-api-secret: xxx
// Status pages are open (read-only). All action routes require the secret.
// OPEN_PATHS: routes that bypass the API_SECRET check.
// Status/read-only pages are open. All action routes (start/stop/exit) are PROTECTED.
// Since this app runs on localhost only, protection is mainly against accidental browser hits.
const OPEN_PATHS = [
  "/",
  "/logs",              // log viewer — read-only
  "/logs/stream",       // SSE stream — read-only
  "/logs/data",         // polling endpoint — read-only
  "/logs/dates",        // archived days on disk — read-only
  "/logs/day",          // one archived day, paginated — read-only
  "/logs/export",       // export txt
  "/logs/export-json",  // export json
  "/ema_rsi_st-paper/status",     // read-only status page
  "/ema_rsi_st-paper/status/data",// dashboard AJAX poll — must be open or 403 when API_SECRET is set
  "/ema_rsi_st-paper/history",    // read-only history
  "/ema_rsi_st-paper/debug",      // read-only debug
  "/ema_rsi_st-paper/client.js",  // static asset
  // EMA_RSI_ST_V2 — same reason: the dashboard tile polls status/data unsecured,
  // and a missing entry here is a raw 403 on the page once API_SECRET is set.
  "/ema_rsi_st_v2-paper/status",          // read-only status page
  "/ema_rsi_st_v2-paper/status/data",     // dashboard AJAX poll — must be open or 403 when API_SECRET is set
  "/ema_rsi_st_v2-paper/status/chart-data", // chart poll — read-only
  "/ema_rsi_st_v2-paper/history",         // read-only history
  "/ema_rsi_st_v2-paper/debug",           // read-only debug
  "/ema_rsi_st_v2-paper/client.js",       // static asset
  "/ema_rsi_st_v2-paper/simulate",        // read-only simulate page (its /simulate/start still needs the secret)
  // ST_RSI_PIV_BB — same reason: the dashboard tile polls status/data unsecured,
  // and a missing entry here is a raw 403 on the page once API_SECRET is set.
  "/st_rsi_piv_bb-paper/status",          // read-only status page
  "/st_rsi_piv_bb-paper/status/data",     // dashboard AJAX poll — must be open or 403 when API_SECRET is set
  "/st_rsi_piv_bb-paper/status/chart-data", // chart poll — read-only
  "/st_rsi_piv_bb-paper/history",         // read-only history
  "/st_rsi_piv_bb-paper/debug",           // read-only debug
  "/st_rsi_piv_bb-paper/client.js",       // static asset
  // SAIL_VWAP_ST — same reason: the dashboard tile polls status/data unsecured,
  // and a missing entry here is a raw 403 on the page once API_SECRET is set.
  "/sail_vwap_st-paper/status",          // read-only status page
  "/sail_vwap_st-paper/status/data",     // dashboard AJAX poll — must be open or 403 when API_SECRET is set
  "/sail_vwap_st-paper/status/chart-data", // chart poll — read-only
  "/sail_vwap_st-paper/history",         // read-only history
  "/sail_vwap_st-paper/debug",           // read-only debug
  "/sail_vwap_st-paper/client.js",       // static asset
  // PIVOT_EMA_ST — same reason: the dashboard
  // tile polls status/data unsecured; a missing entry is a raw 403 once API_SECRET is set.
  "/pivot_ema_st-paper/status",               // read-only status page
  "/pivot_ema_st-paper/status/data",          // dashboard AJAX poll
  "/pivot_ema_st-paper/status/chart-data",    // chart poll — read-only
  "/pivot_ema_st-paper/history",              // read-only history
  "/pivot_ema_st-paper/debug",                // read-only debug
  "/pivot_ema_st-paper/client.js",            // static asset
  // GAP_RUNAWAY (NIFTY) + its stock scanner — read-only surfaces; the dashboard
  // tile polls status/data unsecured, so a missing entry is a raw 403 once API_SECRET is set.
  "/gap_runaway-paper/status",
  "/gap_runaway-paper/status/data",
  "/gap_runaway-paper/status/chart-data",
  "/gap_runaway-paper/history",
  "/gap_runaway-paper/debug",
  "/gap_runaway-paper/client.js",
  "/gap_runaway_stk-paper/status",
  "/gap_runaway_stk-paper/status/data",
  "/gap_runaway_stk-paper/history",
  "/gap_runaway_stk-paper/debug",
  "/gap_runaway_stk-paper/logs",            // full activity log for the Copy Log button — read-only
  "/ema9vwap-paper/status",      // read-only status page
  "/ema9vwap-paper/status/data", // dashboard AJAX poll
  "/ema9vwap-paper/history",     // read-only history
  "/ema9vwap-paper/client.js",   // static asset
  "/trend-pb-paper/status",      // read-only status page
  "/trend-pb-paper/status/data", // dashboard AJAX poll
  "/trend-pb-paper/status/chart-data", // chart AJAX poll (read-only)
  "/trend-pb-paper/history",     // read-only history
  // Trend Day Scalp — read-only surfaces. These MUST be open: the dashboard's
  // per-strategy tile polls status/data with a plain fetch (no secret), so a
  // protected path makes the tile silently render empty.
  "/trend-day-scalp-paper/status",
  "/trend-day-scalp-paper/status/data",
  "/trend-day-scalp-paper/status/chart-data",
  "/trend-day-scalp-paper/history",
  // HA Scalp — same reason: the dashboard tile polls status/data unsecured.
  "/ha-scalp-paper/status",
  "/ha-scalp-paper/status/data",
  "/ha-scalp-paper/status/chart-data",
  "/ha-scalp-paper/history",
  // PREV ORB Scalp — same reason: the dashboard tile polls status/data unsecured.
  "/prev-orb-scalp-paper/status",
  "/prev-orb-scalp-paper/status/data",
  "/prev-orb-scalp-paper/status/chart-data",
  "/prev-orb-scalp-paper/history",
  // ITM20 Scalp — same reason: the dashboard tile polls status/data unsecured.
  "/itm20-scalp-paper/status",
  "/itm20-scalp-paper/status/data",
  "/itm20-scalp-paper/status/chart-data",
  "/itm20-scalp-paper/history",
  "/early-bird-paper/status",
  "/early-bird-paper/status/data",
  "/early-bird-paper/status/chart-data",
  "/early-bird-paper/history",
  // SIMPLE_9:30 — same reason: the dashboard tile polls status/data unsecured.
  "/simple930-paper/status",
  "/simple930-paper/status/data",
  "/simple930-paper/status/chart-data",
  "/simple930-paper/history",
  // RSI Pivot ST — same reason: the dashboard tile polls status/data unsecured.
  "/rsi-pivot-st-paper/status",
  "/rsi-pivot-st-paper/status/data",
  "/rsi-pivot-st-paper/status/chart-data",
  "/rsi-pivot-st-paper/history",
  "/tracker/status",          // read-only tracker page
  "/tracker/status/data",     // AJAX poll — must be open
  "/tracker/fetch-and-start", // auto-fetch + start (Zerodha read + SAR compute)
  "/result",                // read-only results
  "/result/all",
  // Broker-auth + session links. These are plain <a> navigations (and, for
  // /auth/manual, a plain <form method=POST>) — a browser navigation cannot send
  // the x-api-secret header, so gating them makes broker re-login and Logout
  // unreachable from the UI. All of them sit behind the LOGIN_SECRET cookie.
  // (/logout needs no entry — it is registered above this middleware, so it never
  // reaches the gate. Same for GET/POST /login.)
  "/auth/login",            // starts the Fyers OAuth redirect
  "/auth/manual",           // paste-a-token recovery page + its form POST
  "/auth/zerodha/login",    // starts the Zerodha OAuth redirect
  "/auth/status",           // read-only auth status
  "/auth/telegram-health",  // dashboard banner poll — Telegram delivery health (read-only)
  "/auth/telegram-ping",    // health-modal active probe — Telegram getMe (sends no message)
  "/auth/zerodha/status",
  "/auth/zerodha/logout",
  "/api/holidays",          // read-only holiday list
  "/api/expiry-dates",      // read-only expiry calendar
  "/api/start-all-roster",  // read-only Start-All roster (dashboard button)
  "/login-logs",            // login attempts viewer (failed + demo)
  "/login-logs/data",       // login logs JSON data
  "/login-logs/clear",      // reset login logs
  "/settings",              // settings page (read-only view)
  "/settings/data",         // AJAX poll for current values
  "/settings/markets",      // read-only next expiry per market (Settings → Markets)
  "/settings/pair-section", // read-only HTML of one market pair's settings pane
  "/settings/audit",        // read-only settings-change audit view
  "/trade-logs",            // per-trade JSONL viewer (read-only)
  "/trade-logs/list",       // JSON: list of daily JSONL files
  "/trade-logs/view",       // JSON: parsed trades for one file
  "/trade-logs/download",   // download raw JSONL
  "/trade-logs/download-all",   // concat-download all daily trade JSONLs per mode
  "/trade-logs/download-everything",       // every mode, one archive (link navigation)
  "/trade-logs/skips/download-everything", // same for skip logs
  "/trade-logs/audit",      // JSON: settings audit (read-only)
  "/trade-logs/skips/list",     // JSON: list of daily skip files
  "/trade-logs/skips/view",     // JSON: parsed skip lines for one file
  "/trade-logs/skips/download", // download raw skip JSONL
  "/trade-logs/skips/download-all", // concat-download all daily skip JSONLs per mode
  // NOTE: POST /trade-logs/delete and POST /trade-logs/skips/delete are intentionally protected (write ops)
  // Token Sync — only the page shell is open, because a browser navigation
  // cannot carry the x-api-secret header. /token-sync/tokens hands out a live
  // broker credential, so it is gated like a write even though it is a GET;
  // /token-sync/apply, /pull, /reset and /restart stay out of this list too.
  // The page fetches all five through secretFetch.
  "/token-sync",            // token pull/copy/paste page shell (renders no token)
  "/token-sync/status",     // "is each broker logged in" booleans only — no token (Settings hides logged-out brokers' Logout buttons)
  "/brokers",               // broker maintenance page shell (secrets never rendered)
  "/brokers/list",          // added brokers — API secret reduced to a hasSecret boolean
  "/cache-files",           // cache / generated-file browser (read-only)
  "/cache-files/groups",    // JSON: per-group file count + size
  "/cache-files/list",      // JSON: paged files for one group
  "/cache-files/view",      // JSON: text content of one file (capped)
  "/cache-files/download",  // download one raw cache file
  "/cache-files/download-all", // download a whole group as .tar.gz
  // NOTE: POST /cache-files/delete, /delete-all and /clear-candles (the backtest
  // pages' Clear Cache button) are intentionally protected (write ops)
  // BB_RSI mode (read-only status/data)
  "/bb_rsi-paper/status",
  "/bb_rsi-paper/status/data",
  "/bb_rsi-backtest",
  // Price Action mode (read-only status/data)
  "/pa-paper/status",
  "/pa-paper/status/data",
  "/pa-backtest",
  "/pa-paper/history",
  "/pa-paper/simulate",
  "/pa-paper/status/chart-data",
  "/pa-pattern-backtest",         // per-pattern attribution dashboard
  "/pa-pattern-backtest/idle",
  "/pa-pattern-backtest/stats",
  "/pa-pattern-backtest/trades",
  // ORB mode (read-only status/history/chart) — /status/data in particular must be
  // open or ORB is invisible to the dashboard's Start-All button poll, which uses a
  // plain fetch (it runs on a 10s timer and must never pop the secret prompt).
  "/orb-paper/status",
  "/orb-paper/status/data",
  "/orb-paper/status/chart-data",
  "/orb-paper/history",
  "/orb-backtest",
  "/orb-backtest/status",
  "/orb-backtest/idle",
  // EMA_RSI_ST / BB_RSI / EMA9+VWAP / Trend_PB — the read-only pages the sidebar
  // links to that were never added alongside their /status entries above.
  "/ema_rsi_st-paper/simulate",
  "/ema_rsi_st-paper/status/chart-data",
  "/ema_rsi_st-backtest",
  "/ema_rsi_st-backtest/status",
  "/ema_rsi_st-backtest/idle",
  "/bb_rsi-paper/history",
  "/bb_rsi-paper/simulate",
  "/bb_rsi-paper/status/chart-data",
  "/ema9vwap-paper/simulate",
  "/ema9vwap-paper/status/chart-data",
  "/ema9vwap-backtest",
  "/ema9vwap-backtest/status",
  "/ema9vwap-backtest/idle",
  "/trend-pb-backtest",
  "/trend-pb-backtest/status",
  "/trend-pb-backtest/idle",
  "/trend-day-scalp-backtest",
  "/trend-day-scalp-backtest/status",
  "/trend-day-scalp-backtest/idle",
  "/ha-scalp-backtest",
  "/ha-scalp-backtest/status",
  "/ha-scalp-backtest/idle",
  "/ha-scalp-backtest/result",
  "/prev-orb-scalp-backtest",
  "/prev-orb-scalp-backtest/status",
  "/prev-orb-scalp-backtest/idle",
  "/prev-orb-scalp-backtest/result",
  "/itm20-scalp-backtest",
  "/itm20-scalp-backtest/status",
  "/itm20-scalp-backtest/idle",
  "/itm20-scalp-backtest/result",
  "/itm20-scalp-backtest/csv",
  "/early-bird-backtest",
  "/early-bird-backtest/status",
  "/early-bird-backtest/idle",
  "/early-bird-backtest/result",
  "/simple930-backtest",
  "/simple930-backtest/status",
  "/simple930-backtest/idle",
  "/simple930-backtest/day-log",
  "/rsi-pivot-st-backtest",
  "/rsi-pivot-st-backtest/status",
  "/rsi-pivot-st-backtest/idle",
  "/ema_rsi_st_v2-backtest",
  "/ema_rsi_st_v2-backtest/status",
  "/ema_rsi_st_v2-backtest/idle",
  "/sail_vwap_st-backtest",
  "/sail_vwap_st-backtest/status",
  "/sail_vwap_st-backtest/idle",
  // Cross-strategy read-only screens reached from the sidebar / top bar.
  "/realtime",            // unified real-time monitor
  "/realtime/capital",    // capital-pool poll — read-only, drives the shortfall alert banner
  "/replay",              // tick-replay page — /replay/run and the delete/cancel POSTs stay protected
  "/replay/list",
  "/replay/preflight",
  "/replay/download-day",
  "/replay/download-all",
  "/all-backtest",
  "/all-backtest/stats",
  "/backtest",                 // the ONE backtest page (strategy × market) — runs on GET like the per-strategy pages
  "/backtest/run",
  "/backtest/status",
  "/backtest/idle",
  "/backtest/options.json",
  "/edge-analytics",
  "/advisor",             // settings advisor — read-only, suggests but never writes
  "/advisor/data",
  "/consolidation-report",
  "/losses-analyzer",
  "/pnl-history",         // manual year-wise P&L — the baseline POSTs stay protected
  "/pnl-history/data",
  "/pnl-history/manual/data", // manual-trade analytics read — import/sync POSTs stay protected
  "/compare/trading",
  "/compare/bb_rsi",
  "/docs",                // guide viewer — file/pdf reads are covered by OPEN_PREFIXES
  "/monitor",             // EC2 health monitor — /monitor/action/* stays protected
  "/monitor/data",
  "/monitor/disk",        // read-only folder sizes — the preview and /monitor/action/disk-delete stay protected
  "/api/session-active",  // liveness probe — dashboard auto-swaps views on it
  "/auth/socket-health",  // sidebar socket badge poll
  "/backup/status",       // sidebar backup-nag poll
  "/backup/data",         // Settings backup list — create/delete/restore stay protected
  "/backup/download",     // snapshot download (link navigation, read-only)
  // NOTE: /settings/env is deliberately NOT here. It returns the raw .env —
  // API_SECRET, LOGIN_SECRET, ZERODHA_API_SECRET, ACCESS_TOKEN,
  // TELEGRAM_BOT_TOKEN — with no masking (/settings/data is the masked view).
  // Its one caller uses secretFetch.
  "/consolidation",       // read-only cross-mode trade history + analytics
  "/consolidation/data",
  "/consolidation/trade-detail", // one trade's journal + post-exit record (read-only); /consolidation/export-day stays protected
  "/oi-monitor",          // read-only per-strike OI ladder — no position, no order
  "/oi-monitor/data",
  // Swing Scanner reads. /swing-scanner/order is deliberately NOT here — it
  // places a real Zerodha order and requires API_SECRET like every other write.
  // /scan and /scan/cancel are GETs that start and stop a read-only scan job;
  // cancel is open because its only effect is to stop work the same open
  // endpoint could have started.
  "/swing-scanner",
  "/swing-scanner/meta",
  "/swing-scanner/scan",
  "/swing-scanner/scan/status",
  "/swing-scanner/scan/cancel",
  "/swing-scanner/quote",
  "/health",              // health check — must be open for uptime monitors / PM2 probes
  "/deploy/webhook",      // GitHub Actions webhook — must be open for GitHub to reach it
  "/deploy/status",       // deploy status poll — read-only
  // NOTE: /settings/save requires API_SECRET (write operation)
  // NOTE: paper /reset and /exit require secret; paper /start and /stop are opened by OPEN_PAPER_CTRL_RE below
  // NOTE: /api/holidays/refresh requires API_SECRET (write operation)
];
// OPEN_PREFIXES: read-only routes that take a path parameter, so an exact match in
// OPEN_PATHS can never hit them (e.g. /docs/file/pa-guide.html, /orb-paper/view/
// trades/2026-07-24). Every route under these prefixes is a GET read — the paper
// routers' write operations (restore-session, delete-session) sit elsewhere.
const OPEN_PREFIXES = [
  "/backtest/result/",           // saved /backtest runs (re-open, JSON)
  "/auth/callback",              // broker OAuth redirect — arrives with the broker's own query string
  "/docs/file/",                 // guide HTML
  "/docs/pdf/",                  // guide PDF export
  "/mcp-data/",                  // read-only JSON for the trade-results MCP (still login-gated)
  "/ema_rsi_st-paper/view/",     // per-day trade / skip viewers
  "/ema_rsi_st-paper/download/",
  "/ema_rsi_st_v2-paper/view/",
  "/ema_rsi_st_v2-paper/download/",
  "/st_rsi_piv_bb-paper/view/",
  "/st_rsi_piv_bb-paper/download/",
  "/sail_vwap_st-paper/view/",
  "/sail_vwap_st-paper/download/",
  "/pivot_ema_st-paper/view/",
  "/pivot_ema_st-paper/download/",
  "/gap_runaway-paper/view/",
  "/gap_runaway-paper/download/",
  "/gap_runaway_stk-paper/view/",
  "/gap_runaway_stk-paper/download/",
  "/bb_rsi-paper/view/",
  "/bb_rsi-paper/download/",
  "/pa-paper/view/",
  "/pa-paper/download/",
  "/orb-paper/view/",
  "/orb-paper/download/",
  "/ema9vwap-paper/view/",
  "/ema9vwap-paper/download/",
  "/trend-pb-paper/view/",
  "/trend-pb-paper/download/",
  "/trend-day-scalp-paper/view/",
  "/trend-day-scalp-paper/download/",
  "/ha-scalp-paper/view/",
  "/ha-scalp-paper/download/",
  "/prev-orb-scalp-paper/view/",
  "/prev-orb-scalp-paper/download/",
  "/itm20-scalp-paper/view/",
  "/itm20-scalp-paper/download/",
  "/early-bird-paper/view/",
  "/early-bird-paper/download/",
  "/simple930-paper/view/",
  "/simple930-paper/download/",
  "/rsi-pivot-st-paper/view/",
  "/rsi-pivot-st-paper/download/",
];
// Read-only status surfaces of ANY strategy route, matched by shape rather than
// by name. The dashboard polls `/status/data` with a plain fetch (no secret) for
// its per-strategy tiles, for the Start-All button state and for the post-start
// verification — every one of those goes silently blank on a strategy whose
// exact path nobody remembered to list above. The named entries stay (they also
// cover /history); this only removes the "new strategy forgot a line" failure.
const OPEN_STATUS_RE = /^\/[a-z0-9_]+(?:-[a-z0-9_]+)*-paper\/status(?:\/data|\/chart-data)?$/;
// Paper start/stop place no real order, so they skip the secret prompt (still
// login-gated). Paper reset/exit stay protected.
// A running pair's read-only pages, same as its NIFTY strategy's (generated).
for (const p of require("./config/pairs").runnable()) {
  for (const sub of ["status", "status/data", "status/chart-data", "history", "debug", "client.js", "simulate"]) OPEN_PATHS.push(`${p.paperPath}/${sub}`);
  OPEN_PREFIXES.push(`${p.paperPath}/view/`, `${p.paperPath}/download/`);
}
const OPEN_PAPER_CTRL_RE = /^\/[a-z0-9_]+(?:-[a-z0-9_]+)*-paper\/(?:start|stop)$/;

app.use((req, res, next) => {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // no secret set → open (dev mode)
  // Prefix matches are restricted to GET/HEAD: a prefix covers a whole subtree, and
  // a write route can share a path with a read one — docs.js serves GET /file/:name
  // and DELETE /file/:name from the same URL, so a method-blind prefix would have
  // opened guide deletion. OPEN_PATHS stays method-agnostic; its entries are exact
  // and a few (deploy/webhook, tracker/fetch-and-start) are deliberately POSTable.
  const isReadMethod = req.method === "GET" || req.method === "HEAD";
  const isOpen = OPEN_PATHS.includes(req.path)
    || (isReadMethod && OPEN_PREFIXES.some(p => req.path.startsWith(p)))
    || (isReadMethod && OPEN_STATUS_RE.test(req.path))
    || OPEN_PAPER_CTRL_RE.test(req.path);
  if (isOpen) return next();
  const token = req.headers["x-api-secret"] || req.query.secret;
  if (token !== secret) return res.status(403).json({ success: false, error: "Forbidden — missing or wrong secret." });
  next();
});

// ── Write rate limit — per-IP token bucket for state-changing requests ───────
// Defends against accidental loops or brute-force on write endpoints (start,
// stop, exit, settings/save, etc.). UI-driven writes are well below this cap;
// the deploy webhook and SSE streams are GETs and unaffected.
// Limits are read live from env (WRITE_RATE_PER_MIN, WRITE_RATE_BURST) so
// Settings edits take effect on the next request. Setting WRITE_RATE_PER_MIN=0
// disables the limiter entirely.
const _writeBuckets = new Map(); // ip -> { tokens, lastRefillMs }
let _lastBucketSweep = 0;
const _BUCKET_IDLE_MS = 10 * 60_000; // a bucket idle this long has fully refilled
function _writeRatePerMin() { const n = Number(process.env.WRITE_RATE_PER_MIN); return Number.isFinite(n) && n >= 0 ? n : 120; }
function _writeRateBurst()  { const n = Number(process.env.WRITE_RATE_BURST);   return Number.isFinite(n) && n >= 1 ? n : 30;  }
function _rateLimitOk(ip) {
  const perMin = _writeRatePerMin();
  if (perMin === 0) return true; // limiter disabled
  const burst  = _writeRateBurst();
  const now = Date.now();
  // Throttled sweep (no standing timer): evict buckets idle long enough to have
  // fully refilled — recreating them yields identical state, so this is lossless
  // and keeps the map from growing unbounded across many/rotating IPs.
  if (now - _lastBucketSweep > 60_000) {
    _lastBucketSweep = now;
    for (const [k, v] of _writeBuckets) {
      if (now - v.lastRefillMs > _BUCKET_IDLE_MS) _writeBuckets.delete(k);
    }
  }
  let b = _writeBuckets.get(ip);
  if (!b) { b = { tokens: burst, lastRefillMs: now }; _writeBuckets.set(ip, b); }
  const elapsedMs = now - b.lastRefillMs;
  const refill = (elapsedMs / 60000) * perMin;
  if (refill > 0) { b.tokens = Math.min(burst, b.tokens + refill); b.lastRefillMs = now; }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
app.use((req, res, next) => {
  const m = req.method;
  if (m !== "POST" && m !== "PUT" && m !== "DELETE" && m !== "PATCH") return next();
  // Login + deploy webhook have their own protections; skip them here.
  if (req.path === "/login" || req.path === "/deploy/webhook") return next();
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
           || req.socket?.remoteAddress || "unknown";
  if (_rateLimitOk(ip)) return next();
  console.warn(`🚫 [RATE] ${m} ${req.path} rate-limited for ${ip}`);
  res.set("Retry-After", "5");
  return res.status(429).json({ success: false, error: "Too many requests — slow down." });
});



// A replay patches the shared socketManager and sharedSocketState for its whole
// run, and its preflight only refuses to START while strategies are active — not
// the reverse. A strategy started mid-replay registers into the replay harness
// (fed the replayed day's prices), and when the run ends the harness drops every
// callback and force-clears every mode: the strategy shows RUNNING with no feed.
// The replay itself calls /start through the router stack, so it never hits this.
app.use((req, res, next) => {
  if (!/-paper\/start\/?$/.test(req.path)) return next();
  let inReplay = false;
  try { inReplay = require("./services/tickReplay").isReplayInProgress(); } catch (_) {}
  if (!inReplay) return next();
  console.warn(`🚫 [REPLAY] ${req.path} refused — a replay is running`);
  return res.status(409).json({ success: false, error: "A replay is running — it patches the shared feed. Start strategies after it finishes (or cancel it on /replay)." });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/auth",       require("./routes/auth"));
app.use("/ema_rsi_st-backtest",   lazyRouter(() => require("./routes/emaRsiStBacktest")));
app.use("/result",     lazyRouter(() => require("./routes/result")));
app.use("/ema_rsi_st-paper", require("./routes/emaRsiStPaper"));
app.use("/tracker",    require("./routes/manualTracker"));
app.use("/logs",       require("./routes/logs"));       // ← live log viewer
app.use("/trade-logs", require("./routes/tradeLogs"));  // ← per-trade JSONL viewer + settings checkpoints
app.use("/mcp-data",   require("./routes/mcpData"));    // ← read-only JSON for the trade-results MCP (all markets)
app.use("/cache-files", require("./routes/cacheFiles")); // ← cache / generated-file browser (caches, ticks, replay outputs)
app.use("/sync",        require("./routes/sync"));       // ← EC2→local data sync (download tar.gz)
app.use("/token-sync",  require("./routes/tokenSync"));  // ← copy broker token from LIVE → paste on a laptop
app.use("/brokers",     require("./routes/brokers"));    // ← broker maintenance: built-in keys + added broker entries
app.use("/backup",      require("./routes/backup"));     // ← daily downloadable data snapshots (Settings card + nag banner)
app.use("/settings",    require("./routes/settings"));   // ← settings UI
app.use("/docs",        require("./routes/docs"));       // ← docs viewer
app.use("/login-logs",  require("./routes/loginLogs"));  // ← login attempts log viewer
app.use("/monitor",     require("./routes/monitor"));    // ← EC2 instance health monitor
// ── BB_RSI mode routes (independent from main trade) ─────────────────────────
app.use("/bb_rsi-paper",    require("./routes/bbRsiPaper"));     // ← bb_rsi paper trade
app.use("/bb_rsi-backtest", lazyRouter(() => require("./routes/bbRsiBacktest")));  // ← bb_rsi backtest
app.use("/compare",        lazyRouter(() => require("./routes/compare")));        // ← paper vs backtest compare
// ── Price Action mode routes (5-min, independent from main & bb_rsi) ─────────

// ── EMA_RSI_ST_V2 routes (EMA20/50 + RSI entry, SuperTrend-only stop, Zerodha) ─
// A separate strategy from EMA_RSI_ST, not another mode of it.
app.use("/ema_rsi_st_v2-paper",        require("./routes/emaRsiStV2Paper"));       // ← canonical engine
// ── (strategy, market) pairs: every offered pair of a create(pair) builder
// (config/pairs.js runnable) is mounted at its own /<modeKey>-paper — cheap
// (an idle router), and a pair that is switched off refuses /start. The NIFTY
// instance above is the builder module's default export.
for (const p of require("./config/pairs").runnable()) {
  const s = require("./config/strategyRegistry").byId(p.strategyId);
  app.use(p.paperPath, require("./" + s.paper.module).forPair(p));
}
app.use("/ema_rsi_st_v2-backtest",     lazyRouter(() => require("./routes/emaRsiStV2Backtest")));    // ← same signal engine, paper's exits


// ── ST_RSI_PIV_BB routes (SuperTrend + RSI + pivot R1/S1 + Bollinger, Zerodha) ─
app.use("/st_rsi_piv_bb-paper",    require("./routes/stRsiPivBbPaper"));       // ← canonical engine

// ── SAIL_VWAP_ST routes (SAIL stock options: VWAP cross + breakout, SuperTrend stop, Zerodha) ─
app.use("/sail_vwap_st-paper",    require("./routes/sailVwapStPaper"));       // ← canonical engine
app.use("/sail_vwap_st-backtest", lazyRouter(() => require("./routes/sailVwapStBacktest")));    // ← same signal engine, paper's exits

// ── PIVOT_EMA_ST (pivot zone + EMA20/50 cross + SuperTrend, Zerodha) ────────
// NIFTY. Paper only — no backtest, not replayable.
app.use("/pivot_ema_st-paper",         require("./routes/pivotEmaStPaper"));           // ← canonical engine (NIFTY)

// ── GAP_RUNAWAY (GAP_runAway__Kirubakaran: daily RSI-on-EMA extreme + gap, Zerodha) ──
// NIFTY ATM options (paper) and its F&O stock scanner (intraday
// shares, paper only). No backtest, not replayable. No common rules on NIFTY;
// the scanner runs most of them (see gapRunawayStkPaper.js).
app.use("/gap_runaway-paper",          require("./routes/gapRunawayPaper"));           // ← canonical engine (NIFTY options)
app.use("/gap_runaway_stk-paper",      require("./routes/gapRunawayStkPaper"));        // ← stock scanner, intraday shares (paper only)

app.use("/pa-paper",       require("./routes/paPaper"));     // ← PA paper trade
app.use("/pa-backtest",    lazyRouter(() => require("./routes/paBacktest")));  // ← PA backtest
app.use("/pa-pattern-backtest", lazyRouter(() => require("./routes/paPatternBacktest"))); // ← PA per-pattern backtest dashboard
// ── ORB routes (parallel strategy — paper, backtest) ────────────────────────
app.use("/orb-paper",         require("./routes/orbPaper"));      // ← ORB paper trade
app.use("/orb-backtest",      lazyRouter(() => require("./routes/orbBacktest")));   // ← ORB date-range backtest
// ── EMA9+VWAP routes (5-min, EMA9 vs VWAP±σ band) ────────────────────────────
app.use("/ema9vwap-paper",    require("./routes/ema9vwapPaper"));       // ← EMA9+VWAP paper trade
app.use("/ema9vwap-backtest", lazyRouter(() => require("./routes/ema9vwapBacktest")));    // ← EMA9+VWAP date-range backtest
// ── Trend Pullback routes (5-min; 15m bias + 5m pullback/resumption) ─────────
app.use("/trend-pb-paper",    require("./routes/trendPbPaper"));        // ← Trend Pullback paper trade (Phase A)
app.use("/trend-pb-backtest", lazyRouter(() => require("./routes/trendPbBacktest")));     // ← Trend Pullback backtest — walk-forward + dumb-baseline (Phase B)

// ── TREND_DAY_SCALP routes (10:15 day gate → VWAP/EMA pullback scalp, Fyers) ─
app.use("/trend-day-scalp-paper",    require("./routes/trendDayScalpPaper"));       // ← canonical engine
app.use("/trend-day-scalp-backtest", lazyRouter(() => require("./routes/trendDayScalpBacktest")));    // ← same signal engine, paper's exits


// ── HA_SCALP routes (15-min Heikin Ashi trend scalp on NIFTY 50 spot, Zerodha) ─
app.use("/ha-scalp-paper",      require("./routes/haScalpPaper"));            // ← canonical engine
app.use("/ha-scalp-backtest",   lazyRouter(() => require("./routes/haScalpBacktest")));         // ← same signal engine, paper's exits

// ── PREV_ORB_SCALP routes (prev-day range + 15m/3m ORB scalp on NIFTY 50 spot, Zerodha) ─
app.use("/prev-orb-scalp-paper",    require("./routes/prevOrbScalpPaper"));        // ← canonical engine
app.use("/prev-orb-scalp-backtest", lazyRouter(() => require("./routes/prevOrbScalpBacktest")));     // ← same signal engine, paper's exits

// ── ITM20_SCALP routes (15m opening-range breakout + retest, 1 ITM, +20/−10 premium; paper + backtest) ─
app.use("/itm20-scalp-paper",    require("./routes/itm20ScalpPaper"));          // ← canonical engine
app.use("/itm20-scalp-backtest", lazyRouter(() => require("./routes/itm20ScalpBacktest")));       // ← same signal engine, paper's exits

// ── EARLYBIRD routes (first 15-min breakout, CASH EQUITY on F&O stocks, Fyers) ─
app.use("/early-bird-paper",    require("./routes/earlyBirdPaper"));          // ← canonical engine
app.use("/early-bird-backtest", lazyRouter(() => require("./routes/earlyBirdBacktest")));       // ← same signal engine, paper's exits

// ── SIMPLE_9:30 routes (09:25 ITM watchlist → first leg above ₹180, Zerodha) ──
app.use("/simple930-paper",    require("./routes/simple930Paper"));      // ← canonical engine
app.use("/simple930-backtest", lazyRouter(() => require("./routes/simple930Backtest")));   // ← same signal engine, paper's exits, REAL option candles
app.use("/rsi-pivot-st-paper",    require("./routes/rsiPivotStPaper"));       // ← canonical engine
app.use("/rsi-pivot-st-backtest", lazyRouter(() => require("./routes/rsiPivotStBacktest")));    // ← same signal engine, paper's exits


app.use("/deploy",         require("./routes/deploy"));         // ← GitHub Actions deploy status
app.use("/consolidation",       require("./routes/consolidation"));     // ← unified cross-mode PAPER trade history + analytics
app.use("/edge-analytics",      require("./routes/edgeAnalytics"));     // ← edge metrics (WR/expectancy/PF/drawdown/by-hour) over recorded trades
app.use("/consolidation-report", lazyRouter(() => require("./routes/consolidationReport"))); // ← printable consolidated report (paper, week/month/range filters, Save-as-PDF)
app.use("/losses-analyzer",     lazyRouter(() => require("./routes/lossesAnalyzer")));    // ← every losing trade with its full signal/entry/exit/indicator record + a why-it-lost verdict
app.use("/advisor",             lazyRouter(() => require("./routes/advisor")));           // ← offline settings advisor over the recorded trade book (read-only)
app.use("/oi-monitor",          lazyRouter(() => require("./routes/oiMonitor")));         // ← live per-strike OI ladder + wall/PCR readout (read-only research page)
app.use("/swing-scanner",       require("./routes/swingScanner"));      // ← stock swing screen over the active strategies + manual Zerodha CNC entry
app.use("/realtime",            require("./routes/realtime"));          // ← unified real-time monitor (paper, all strategies)
app.use("/replay",              lazyRouter(() => require("./routes/replay")));            // ← deterministic tick-replay backtest (PAPER = REPLAY)
app.use("/backtest",       lazyRouter(() => require("./routes/backtest")));       // ← the ONE backtest page: pick strategy + market, runs each strategy's own engine
app.use("/all-backtest",   lazyRouter(() => require("./routes/allBacktest")));    // ← unified backtest dashboard (all 3 strategies, stats only)
app.use("/pnl-history",    lazyRouter(() => require("./routes/pnlHistory")));    // ← manual year-wise P&L (Kite + Fyers)

// Cancel button on the shared backtest progress page. One endpoint for every
// strategy — the page is built by backtestJobManager, so the job id is all the
// server needs; no per-route /cancel. A write op, so it stays out of OPEN_PATHS.
app.post("/backtest/cancel", (req, res) => {
  const id = req.query.jobId;
  if (!id) return res.status(400).json({ success: false, error: "jobId required" });
  const ok = require("./utils/backtestJobManager").cancelJob(String(id));
  if (!ok) return res.status(409).json({ success: false, error: "Job is not running." });
  console.log(`🛑 Backtest job ${id} cancelled by user`);
  res.json({ success: true });
});

// ── Holiday Management API ────────────────────────────────────────────────────
const {
  refreshHolidayCache, getNSEHolidayDetails, getHolidaySource, getExpiryCalendar,
} = require("./utils/nseHolidays");

// Both calendar endpoints answer for the current year AND the next one by
// default, so the UI keeps working across a year boundary: on 30 Dec the list
// rolls into January instead of emptying out. `?year=` asks for one explicit
// year. Nothing is pinned to a hardcoded year anywhere below.
function calendarYears(req) {
  const raw = req.query && req.query.year;
  if (raw === undefined || raw === "") {
    const y = new Date().getFullYear();
    return { years: [y, y + 1], error: null };
  }
  const y = Number.parseInt(raw, 10);
  if (!Number.isFinite(y) || y < 2015 || y > 2100) {
    return { years: [], error: "year must be an integer between 2015 and 2100" };
  }
  return { years: [y], error: null };
}

app.post("/api/holidays/refresh", async (req, res) => {
  try {
    // Refresh the year being viewed (defaults to the current one). The util
    // also warms year+1, which is what makes next year appear the moment NSE
    // publishes it — no restart, no code edit.
    const raw = (req.query && req.query.year) || (req.body && req.body.year);
    const result = await refreshHolidayCache(raw);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/holidays", async (req, res) => {
  try {
    const { years, error } = calendarYears(req);
    if (error) return res.status(400).json({ success: false, error });

    const details = [];
    const sources = {};
    for (const y of years) {
      const list = await getNSEHolidayDetails(y);
      details.push(...list);
      sources[y] = { count: list.length, source: await getHolidaySource(y) };
    }
    // MCX follows the NSE list but only skips the morning (opens 5 PM),
    // except on these national holidays when it stays shut all day.
    for (const h of details) h.mcx = /republic|independence|gandhi|good friday|christmas/i.test(h.name || "") ? "closed" : "evening";
    const holidays = details.map(h => h.date);
    // `holidays` stays a flat array of ISO dates — every existing caller reads
    // that shape. `details` adds the API-supplied names, `sources` says where
    // each year came from (api / disk / fallback / derived).
    res.json({ success: true, holidays, details, count: holidays.length, year: years[0], years, sources });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── NIFTY Option Expiry Dates ─────────────────────────────────────────────────
app.get("/api/expiry-dates", async (req, res) => {
  try {
    const { years, error } = calendarYears(req);
    if (error) return res.status(400).json({ success: false, error });

    const expiries = [];
    for (const y of years) expiries.push(...await getExpiryCalendar(y));

    res.json({ success: true, expiries, year: years[0], years });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Start-All roster ──────────────────────────────────────────────────────────
// The live list of startable strategies, fetched by the dashboard on every
// Start All click. Discovered from the mounted routers and filtered by the
// *_MODE_ENABLED toggles, so a strategy added to the app — or enabled in
// Settings after the page was rendered — is started without a page reload and
// without editing the button.
app.get("/api/start-all-roster", (req, res) => {
  const modes = startAllRoster();
  res.json({
    success: true,
    modes,
    paper:   modes.filter((m) => !m.paperOff).map((m) => m.paper),
  });
});

// ── Candle Cache Info ─────────────────────────────────────────────────────────
// Lightweight liveness probe so the dashboard can auto-swap to/from realtime view.
app.get("/api/session-active", (req, res) => {
  res.json({ active: !!sharedSocketState.isAnyActive() });
});

// ── Home — HTML Dashboard ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  // Redirect to Settings when Dashboard menu is hidden (user can re-enable from Settings → MENU VISIBILITY)
  // Carry the query string across: a broker OAuth callback lands here as
  // "/?login=fyers" and the toast is read from that param on whichever page
  // actually renders. Dropping it would silently swallow the login feedback.
  const showDashboard = (process.env.UI_SHOW_DASHBOARD || 'false').toLowerCase() === 'true';
  if (!showDashboard) {
    const qs = req.originalUrl.indexOf("?");
    // A demo session cannot open Settings — landing it there would greet every
    // stakeholder with a refusal page. Send it to the read-only monitor instead.
    if (demoMode.isDemo()) return res.redirect("/realtime");
    return res.redirect("/settings" + (qs > -1 ? req.originalUrl.slice(qs) : ""));
  }

  // When any paper session is active, show the unified Real-Time monitor in place
  // of the normal dashboard (gated by UI_SHOW_REALTIME, default on).
  const showRealtime = (process.env.UI_SHOW_REALTIME || 'true').toLowerCase() === 'true';
  if (showRealtime && sharedSocketState.isAnyActive()) {
    const { renderRealtimePage } = require("./routes/realtime");
    return res.send(renderRealtimePage({ sidebarKey: "dashboard", autoFlipBack: true }));
  }
  try {
    res.setHeader("Content-Type", "text/html");
    res.send(require("./routes/dashboard").renderDashboard());
  } catch (err) {
    console.error("Dashboard error:", err);
    const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    res.status(500).send(`<pre style="color:red;padding:32px;font-family:monospace;">
Dashboard Error: ${esc(err.message)}

${esc(err.stack)}

Check your .env file — common causes:
• ACTIVE_STRATEGY not matching available strategies (should be STRATEGY_1)
• Missing required env vars
</pre>`);
  }
});

// ── Admin: Token Clear + Hard Restart ────────────────────────────────────────
// POST /admin/reset  (requires API_SECRET)
// Clears both Fyers & Zerodha tokens from disk/memory, then exits.
// PM2 / nodemon auto-restarts the process — fresh SDK singletons, clean slate.
// Use this whenever the Fyers socket enters a broken state mid-session (e.g.
// EOD token clear without a server restart causes fyersDataSocket singleton
// to hold a dead auth context that getInstance() keeps returning).
app.post("/admin/reset", (req, res) => {
  console.log("🔄 [ADMIN] Hard reset requested — clearing tokens & restarting...");
  try { clearFyersToken(); }    catch (_) {}
  try { zerodha.clearZerodhaToken(); } catch (_) {}
  res.json({ success: true, message: "Tokens cleared. Server restarting now..." });
  setTimeout(() => process.exit(0), 300); // brief delay so response flushes
});

// ── Global error handlers ─────────────────────────────────────────────────────
// Centralized Express error handler. Catches any error thrown (sync or async-
// via-next(err)) from route handlers. Always responds — never lets the request
// hang — and never crashes the process. Telegram alerts come from the process-
// level unhandledRejection/uncaughtException handlers below; this handler stays
// quiet on telegram to avoid duplicate noise during a broker outage.
app.use((err, req, res, next) => {
  const code = err && err.code === "CIRCUIT_OPEN" ? 503 : 500;
  console.error(`[ERROR] ${req.method} ${req.path}: ${err && err.message ? err.message : err}`);
  if (err && err.stack) console.error(err.stack);
  if (res.headersSent) {
    // Stream already started — close it; can't send a new status.
    try { res.end(); } catch (_) {}
    return;
  }
  const wantsHtml = (req.headers.accept || "").includes("text/html");
  if (wantsHtml) {
    res.status(code).type("html").send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${code}</title>` +
      `<pre style="font:14px/1.4 ui-monospace,Menlo,monospace;padding:24px;color:#b91c1c">` +
      `${code} ${err && err.message ? String(err.message).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])) : "Error"}` +
      `</pre>`,
    );
    return;
  }
  res.status(code).json({
    success: false,
    error:   err && err.message ? err.message : "Internal error",
    code:    err && err.code ? err.code : undefined,
    stack:   process.env.NODE_ENV === "development" && err ? err.stack : undefined,
  });
});

// ── Crash marker + Telegram alerts ──────────────────────────────────────────
// A crash with no logs is hard to diagnose remotely, so we:
//   1) write a marker file synchronously in the death handler with the reason
//   2) sync-send a Telegram (via curl) before the process is reaped
//   3) on next startup, if the marker exists, send a "recovered from crash"
//      telegram — belt-and-suspenders in case step 2 didn't flush in time
const path = require("path");
const os   = require("os");
const CRASH_MARKER = path.join(os.homedir(), "trading-data", "last_crash.json");

function writeCrashMarker(kind, err) {
  try {
    fs.mkdirSync(path.dirname(CRASH_MARKER), { recursive: true });
    fs.writeFileSync(CRASH_MARKER, JSON.stringify({
      kind,
      message: (err && err.message) ? err.message : String(err || ""),
      stack:   (err && err.stack)   ? err.stack   : null,
      at:      new Date().toISOString(),
      pid:     process.pid,
      uptime:  Math.floor(process.uptime()),
    }, null, 2));
  } catch (_) { /* best-effort */ }
}

function truncate(s, n) { return (s && s.length > n) ? s.slice(0, n) + "…" : (s || ""); }

process.on("unhandledRejection", (reason, promise) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error(`[UnhandledRejection] ${err.message}\n${err.stack || ""}`);
  writeCrashMarker("unhandledRejection", err);
  try { sendTelegramSync(`🚨 UNHANDLED REJECTION\n${truncate(err.message, 300)}\n\nStack:\n${truncate(err.stack || "(no stack)", 600)}`); } catch (_) {}
});

process.on("uncaughtException", (err) => {
  console.error(`[UncaughtException] ${err.message}\n${err.stack || ""}`);
  writeCrashMarker("uncaughtException", err);
  try { sendTelegramSync(`🚨 UNCAUGHT EXCEPTION — restarting\n${truncate(err.message, 300)}\n\nStack:\n${truncate(err.stack || "(no stack)", 600)}`); } catch (_) {}
  // After an uncaught exception the process is in an undefined state — staying
  // alive means trading on possibly-corrupt in-memory state. Exit so PM2
  // restarts into a clean process. We already alerted above, so mark plannedExit to skip
  // the duplicate "PROCESS EXIT" telegram from the exit handler.
  plannedExit = true;
  process.exit(1);
});

// Abnormal exit (non-zero, non-signal). SIGTERM/SIGINT are handled by gracefulShutdown.
// `plannedExit = true` marks intentional process.exit(...) (config errors, etc.)
// so the handler doesn't fire a misleading "crash" telegram. Exit code 10 is
// our sentinel for "config error — do not restart" (see ecosystem.config.js
// `stop_exit_codes: [10]`).
const EXIT_CONFIG_ERROR = 10;
let plannedExit = false;
process.on("exit", (code) => {
  if (code !== 0 && !plannedExit) {
    writeCrashMarker("exit", new Error(`process exit code=${code}`));
    try { sendTelegramSync(`⚠️ PROCESS EXIT\ncode=${code} uptime=${Math.floor(process.uptime())}s`); } catch (_) {}
  }
});

// ── EOD Token Auto-Clear Scheduler ──────────────────────────────────────────
// Clears BOTH Fyers and Zerodha tokens at 4:00 PM IST every day (after market close).
// This ensures:
//   (a) Tokens are wiped even if the app ran all day without a manual stop.
//   (b) Next morning on first startup, loadToken() sees no file → forces fresh login.
// Re-schedules itself for the same time the next day so it runs perpetually.

function scheduleEODTokenClear() {
  // IST = UTC+5:30. Target: 4:00 PM IST = 10:30 AM UTC
  const now     = new Date();
  const utcH    = now.getUTCHours();
  const utcM    = now.getUTCMinutes();
  const utcNow  = utcH * 60 + utcM;
  const target  = 10 * 60 + 30;  // 10:30 UTC = 16:00 IST
  let msUntil   = (target - utcNow) * 60 * 1000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds();
  if (msUntil <= 0) msUntil += 24 * 60 * 60 * 1000; // if already past, schedule for tomorrow

  console.log(`🕒 EOD token clear scheduled in ${Math.round(msUntil / 60000)} min (at 4:00 PM IST)`);

  setTimeout(() => runEODTokenClear(Date.now() + EOD_CLEAR_HOLD_MAX_MS), msUntil);
}

// The expiry auto-roll retries until 16:45 IST, and every one of those attempts
// needs the Fyers token this function destroys — clearing at 16:00 while the
// ladder is still running would guarantee the retries fail. So the clear waits
// while a roll is pending, re-asking each minute, up to a hard deadline: a
// wedged check must never leave a token alive all night.
const EOD_CLEAR_HOLD_MAX_MS = 55 * 60 * 1000;   // 16:00 → 16:55 at the latest
let _eodClearHoldLogged = false;

function runEODTokenClear(deadline) {
  let pending = false;
  try { pending = require("./utils/expiryHealth").isRollPending(); }
  catch (_) { pending = false; }   // health module unavailable → clear as before

  if (pending && Date.now() < deadline) {
    if (!_eodClearHoldLogged) {
      console.log("⏸️  [EOD] Token clear held — the option expiry roll is still retrying (until 16:45 IST)");
      _eodClearHoldLogged = true;
    }
    setTimeout(() => runEODTokenClear(deadline), 60_000);
    return;   // NOT rescheduled for tomorrow yet — this run has not finished
  }

  try {
    console.log("🔴 [EOD] Auto-clearing Fyers & Zerodha tokens...");
    clearFyersToken();
    zerodha.clearZerodhaToken();
    console.log("✅ [EOD] Both tokens cleared. Fresh login required tomorrow morning.");
  } catch (err) {
    console.error(`❌ [EOD] Token clear failed: ${err.message}`);
  } finally {
    _eodClearHoldLogged = false;
    scheduleEODTokenClear(); // always re-schedule for tomorrow's 4:00 PM
  }
}

scheduleEODTokenClear();

// ── Pre-Market Hard-Reset Scheduler ─────────────────────────────────────────
// At 7:00 AM IST every day, clears BOTH tokens AND exits the process so PM2
// brings it back with fresh SDK singletons before market open. Mirrors the
// behavior of POST /admin/reset. Re-schedules itself in case the process is
// running under a supervisor that doesn't restart (e.g., nodemon in dev),
// though in that case the exit will obviously skip the re-schedule path.

function scheduleMorningHardReset() {
  // IST = UTC+5:30. Target: 7:00 AM IST = 01:30 AM UTC
  const now     = new Date();
  const utcH    = now.getUTCHours();
  const utcM    = now.getUTCMinutes();
  const utcNow  = utcH * 60 + utcM;
  const target  = 1 * 60 + 30;   // 01:30 UTC = 07:00 IST
  let msUntil   = (target - utcNow) * 60 * 1000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds();
  if (msUntil <= 0) msUntil += 24 * 60 * 60 * 1000; // if already past, schedule for tomorrow

  console.log(`🕒 Pre-market hard reset scheduled in ${Math.round(msUntil / 60000)} min (at 7:00 AM IST)`);

  setTimeout(() => {
    console.log("🔄 [PRE-MARKET] 7:00 AM IST — clearing tokens & restarting process...");
    try { clearFyersToken(); }            catch (_) {}
    try { zerodha.clearZerodhaToken(); }  catch (_) {}
    // Brief delay so the log line flushes before PM2 reaps the process.
    setTimeout(() => process.exit(0), 300);
  }, msUntil);
}

scheduleMorningHardReset();

// ── HTTPS Server ──────────────────────────────────────────────────────────────
// Generate cert once on EC2 (never commit certs/ to git):
//
//   mkdir -p certs
//   openssl req -x509 -newkey rsa:4096 \
//     -keyout certs/key.pem -out certs/cert.pem \
//     -days 3650 -nodes -subj "/CN=43.205.26.92"
//
// Add to .gitignore:  certs/

const PORT   = process.env.PORT   || 3000;
const HOST   = "0.0.0.0";
const EC2_IP = process.env.EC2_IP || "43.205.26.92"; // override via .env if IP changes

// A masked placeholder is not a credential. The Settings "VIEW .env / COPY"
// view prints SECRET/TOKEN values as ********, and pasting that listing back
// into .env stores the mask itself. The app then hashes "********" as the
// Fyers app secret: the auth_code decodes fine, the secret check fails, and
// Fyers answers {"code":-99,"message":"internal server error"} — which reads
// like an outage rather than a wiped secret. Say so at boot instead.
// A warning, not an exit: paper/backtest and the running session must not be
// held hostage to a broker-login credential.
for (const [key, label] of [
  ["SECRET_KEY", "Fyers"],
  ["APP_ID", "Fyers"],
  ["ZERODHA_API_SECRET", "Zerodha"],
  ["ZERODHA_API_KEY", "Zerodha"],
]) {
  const val = String(process.env[key] || "").trim();
  if (val && /^[*\u2022]+$/.test(val)) {
    console.error(
      `\n❌  ${key} is "${val}" — a masked placeholder, not the real ${label} credential.\n` +
      `    It comes from the Settings "VIEW .env / COPY" listing, which masks secrets.\n` +
      `    ${label} login will fail (Fyers reports it as code -99 "internal server error").\n` +
      `    Fix without SSH: Settings → BULK EDIT → paste ${key}=<real value> and confirm.\n`
    );
  }
}

// Fail fast with a clear message if certs are missing
let sslOptions;
try {
  sslOptions = {
    key:  fs.readFileSync("./certs/key.pem"),
    cert: fs.readFileSync("./certs/cert.pem"),
  };
} catch (e) {
  const cmd = `openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem -out certs/cert.pem -days 3650 -nodes -subj "/CN=${EC2_IP}"`;
  console.error("\n❌  SSL certificates not found. Generate them:\n");
  console.error("    mkdir -p certs");
  console.error(`    ${cmd}\n`);
  try { sendTelegramSync(`🔧 STARTUP ABORTED — SSL certs missing\nReason: ${truncate(e.message, 200)}\n\nFix:\nmkdir -p certs && ${cmd}`); } catch (_) {}
  plannedExit = true;
  process.exit(EXIT_CONFIG_ERROR);
}

const server = https.createServer(sslOptions, app);
server.listen(PORT, HOST, () => {
  console.log(`\n🚀 Trading App running at https://${EC2_IP}:${PORT} (AWS — HTTPS)`);
  console.log(`   Active Strategy  : ${ACTIVE}`);
  console.log(`   Instrument       : ${instrumentConfig.INSTRUMENT}`);
  console.log(`   Lot Size         : ${instrumentConfig.getLotQty()}`);
  console.log(`   Fyers Login      : ${process.env.ACCESS_TOKEN ? "✅ token set" : "❌ not logged in"}`);
  console.log(`   Zerodha Login    : ${zerodha.isAuthenticated() ? "✅ token set" : "❌ not logged in"}`);
  console.log(`   BB_RSI Mode       : ${(process.env.BB_RSI_MODE_ENABLED || "true") === "true" ? "✅ ENABLED" : "🔒 disabled"} | BB_RSI_ENABLED: ${process.env.BB_RSI_ENABLED === "true" ? "✅" : "❌"}`);
  console.log(`   VIX Filter       : ${process.env.VIX_FILTER_ENABLED !== "false" ? `✅ max=${process.env.VIX_MAX_ENTRY || "20"} strong=${process.env.VIX_STRONG_ONLY || "16"}` : "🔒 disabled"}`);
  console.log(`   Telegram         : ${process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? "✅ configured" : "❌ not set"}`);
  console.log(`   Login Gate       : ${process.env.LOGIN_SECRET ? "✅ active" : "🔓 open (no LOGIN_SECRET)"}`);
  console.log(`   Node             : ${process.version} | PID: ${process.pid}`);

  // Tick-recorder disk cleanup — runs once at startup and then every 24h.
  // Default retention 30 days (~300 MB). Tunable via TICK_RECORDER_RETAIN_DAYS.
  try {
    const tickRecorder = require("./utils/tickRecorder");
    // Read the keep-days live so a Settings save applies without a restart.
    const tickRetainDays = () => parseInt(process.env.TICK_RECORDER_RETAIN_DAYS || "30", 10);
    const r = tickRecorder.pruneOldRecordings(tickRetainDays());
    if (r.deleted > 0) console.log(`   Tick recordings  : pruned ${r.deleted} day(s) older than ${r.retainDays}d (kept ${r.kept})`);
    setInterval(() => { try { tickRecorder.pruneOldRecordings(tickRetainDays()); } catch (_) {} }, 24 * 3600_000).unref();
  } catch (err) {
    console.warn(`   Tick recordings  : prune skipped — ${err.message}`);
  }

  // Day-wide option-chain + VIX + futures-OI recorder — strategy-independent, so
  // a SNAPSHOT replay is reproducible for ANY strategy (not just the strike a
  // running strategy traded). Pure observer; rides the existing socket fan-out and
  // writes to the same tick streams. Gated by OPTION_CHAIN_RECORDER_ENABLED.
  try {
    require("./utils/optionChainRecorder").start();
  } catch (err) {
    console.warn(`   Option-chain rec : not started — ${err.message}`);
  }

  // Shared spot-feed supervisor — keeps the Fyers tick feed up for the whole
  // session so the day is recorded as a MARKET archive, independent of which
  // strategies (if any) are running. Without it, a day with no strategy started
  // recorded nothing, and stopping the last strategy ended the recording early.
  // Gated by SPOT_FEED_ALWAYS_ON.
  try {
    require("./utils/spotFeedSupervisor").start();
  } catch (err) {
    console.warn(`   Spot feed keep-up: not started — ${err.message}`);
  }

  // Expiry health — resolves EACH INDEX's option expiry ahead of the open, rolls
  // a blank or expired override (OPTION_EXPIRY_OVERRIDE for NIFTY 50,
  // BANKNIFTY_OPTION_EXPIRY_OVERRIDE for NIFTY BANK) to that index's
  // newly-resolved date (Settings and the Dashboard strips both read
  // process.env, so both update), and raises a per-index Dashboard banner + a
  // Telegram naming the index when nothing can be resolved.
  // Gated by EXPIRY_HEALTHCHECK_ENABLED / EXPIRY_AUTO_ROLL_ENABLED.
  try {
    require("./utils/expiryHealth").start();
  } catch (err) {
    console.warn(`   Expiry health    : not started — ${err.message}`);
  }

  // Warn about DEAD legacy env keys. SWING_* and SCALP_* were renamed to
  // EMA_RSI_ST_* / BB_RSI_* (2026-07-05) and are no longer read by any code, so
  // an .env that still carries them silently ignores that tuning. Flag it once.
  try {
    const deadPrefixes = ["SWING_", "SCALP_"];
    const dead = Object.keys(process.env).filter((k) => deadPrefixes.some((pre) => k.startsWith(pre)));
    if (dead.length) {
      console.warn(`   ⚠️  Dead env keys : ${dead.length} legacy ${deadPrefixes.join("/")}* key(s) in .env are IGNORED (renamed to EMA_RSI_ST_*/BB_RSI_*). Editing them has no effect — remove them. e.g. ${dead.slice(0, 3).join(", ")}${dead.length > 3 ? " …" : ""}`);
    }
  } catch (_) {}

  // Same warning, by EXACT key rather than prefix: the 2026-07-26 ORB rebuild
  // collapsed the strategy to one engine and DELETED the V1/V2/V3 filters (RSI,
  // ADX, EMA20/50, wick %, volume, close-position, sweet-spot, prior-day levels,
  // the old retest gate, the old %-based stop/target/trail). Their keys survive in
  // deployed .env files, and a prefix rule cannot catch them because the LIVE keys
  // share the same ORB_ prefix.
  //
  // These are worse than merely inert: tickRecorder.snapshotSettings() matches
  // /^ORB_/, so every replay recording and every daily-JSONL settings block
  // advertises filters that do not exist — and several read as if they configure a
  // rule that IS live (ORB_TRAIL_ENABLED does not gate the EMA trail;
  // ORB_ATR_PERIOD is a hard-coded constant in orb_breakout.js — note
  // ORB_BUFFER_OR_MULT, ORB_BUFFER_ATR_MULT and ORB_VWAP_FILTER_ENABLED all became
  // LIVE on 2026-08-13 — as did ORB_RSI_ENABLED / ORB_RSI_PERIOD / ORB_RSI_CE_MIN /
  // ORB_RSI_PE_MAX — and are therefore NOT in this list; ORB_TARGET_RANGE_MULT became the exported TARGET_OR_MULT).
  // README's ORB section carries a one-key-per-line bulk-delete block.
  try {
    const RETIRED_ORB_KEYS = [
      "ORB_ADX_MIN", "ORB_ADX_PERIOD", "ORB_ATR_PERIOD", "ORB_BODY_PCT_MIN",
      "ORB_BREAKOUT_BUFFER_MIN", "ORB_BREAKOUT_BUFFER_PCT",
      "ORB_CLOSE_POS_PCT", "ORB_CONFIRM_ENABLED", "ORB_ENTRY_V2_ENABLED", "ORB_ENTRY_V3_ENABLED",
      "ORB_MAX_GAP_PTS", "ORB_MAX_RANGE_PTS", "ORB_MAX_WICK_RATIO", "ORB_MIN_BODY", "ORB_MIN_RANGE_PTS",
      "ORB_OR_ATR_MIN", "ORB_PAPER_CAPITAL", "ORB_PREMIUM_LOCKIN_FLOOR_PCT", "ORB_PREMIUM_LOCKIN_PCT",
      "ORB_PRIORDAY_LEVEL_FILTER", "ORB_RETEST_ENABLED", "ORB_RETEST_MODE", "ORB_RETEST_TOL_MIN",
      "ORB_RETEST_TOL_PCT", "ORB_SL_CANDLES",
      "ORB_STOP_PCT", "ORB_STRONG_BODY", "ORB_SWEET_MAX", "ORB_SWEET_MIN", "ORB_TARGET_PCT",
      "ORB_TARGET_RANGE_MULT", "ORB_TRAIL_ARM_PCT", "ORB_TRAIL_ENABLED", "ORB_TRAIL_LOCK_PCT",
      "ORB_TREND_EMA_FAST", "ORB_TREND_EMA_SLOW", "ORB_VOL_FILTER_ENABLED", "ORB_VOL_LOOKBACK",
      "ORB_VOL_MULT", "ORB_WICK_FILTER_ENABLED", "ORB_WICK_PCT_MAX",
    ];
    const deadOrb = RETIRED_ORB_KEYS.filter((k) => k in process.env);
    if (deadOrb.length) {
      console.warn(`   ⚠️  Dead ORB keys : ${deadOrb.length} pre-rebuild ORB_* key(s) in .env are IGNORED (the V1/V2/V3 filters were deleted 2026-07-26). Editing them has no effect, and they leak into replay/JSONL settings snapshots — remove them (see README → ORB Mode). e.g. ${deadOrb.slice(0, 3).join(", ")}${deadOrb.length > 3 ? " …" : ""}`);
    }
  } catch (_) {}

  console.log(`\n📖 Dashboard → https://${EC2_IP}:${PORT}`);
  console.log(`   📜 Live Logs  → https://${EC2_IP}:${PORT}/logs`);
  console.log(`   ⚠️  Browser warning expected (self-signed cert) — click Advanced → Proceed\n`);

  // ── Crash recovery alert ───────────────────────────────────────────────────
  // If last process wrote a crash marker, the sync send from the death handler
  // may or may not have flushed. Send a recovery telegram now with the reason,
  // then delete the marker so we don't re-alert on clean restarts.
  try {
    if (fs.existsSync(CRASH_MARKER)) {
      const c = JSON.parse(fs.readFileSync(CRASH_MARKER, "utf-8"));
      const ago = c.at ? ` at ${new Date(c.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST` : "";
      sendTelegram(
        `♻️ BOT RESTARTED after crash\n` +
        `Kind    : ${c.kind || "?"}${ago}\n` +
        `Uptime  : ${c.uptime || 0}s before crash\n` +
        `Message : ${truncate(c.message || "(none)", 280)}\n\n` +
        `Stack:\n${truncate(c.stack || "(none)", 600)}`
      );
      fs.unlinkSync(CRASH_MARKER);
    }
  } catch (_) { /* best-effort */ }

  // ── Boot: drop crash snapshots ─────────────────────────────────────────────
  // Paper-only app — no real position can survive a restart, so every
  // .active_*_position.json left over is stale (same as the old paper-only boot).
  try {
    const _persist = require("./utils/positionPersist");
    for (const k of Object.keys(_persist)) {
      if (!k.startsWith("clear") || k === "clearStaleSnapshot") continue;
      const load = _persist["load" + k.slice(5)];
      try { if (typeof load !== "function" || load()) _persist[k](); } catch (_) {}
    }
    // load*() above flags previous-day files as stale instead of returning them.
    for (const s of _persist.getStaleSnapshots()) _persist.clearStaleSnapshot(s.file);
  } catch (e) { console.error(`[STARTUP] snapshot cleanup failed: ${e.message}`); }

  // ── Boot: resume post-exit watches a restart interrupted (observer only) ───
  try { require("./utils/postExitTracker").resume(); }
  catch (e) { console.error(`[STARTUP] post-exit resume failed: ${e.message}`); }

  // ── Daily trade CSV + summary JSON → ~/trading-data/exports (≥16:30 IST) ───
  try { require("./utils/dailyExport").start(); }
  catch (e) { console.error(`[STARTUP] daily export scheduler failed: ${e.message}`); }

  // ── Schedule consolidated end-of-day report at 15:30 IST daily ─────────────
  consolidatedEodReporter.start();

  // ── Per-strategy EOD chart images at 15:34 IST (only strategies that traded) ─
  try { require("./utils/eodChartReporter").start(); }
  catch (err) { console.warn(`[EOD-CHART] scheduler start failed: ${err.message}`); }

  // ── Daily auto-sync of manual Kite trades at 15:35 IST (gated, default off) ─
  manualTradesSyncJob.start();

  // ── Daily downloadable data backup snapshot ────────────────────────────────
  try { require("./utils/backupManager").start(); }
  catch (err) { console.warn(`[backup] scheduler start failed: ${err.message}`); }

  // ── Daily disk clean-up (after 16:30 IST, never in market hours or at boot) ─
  // Applies the Settings → Disk & Retention keep-days. Gated by DISK_AUTO_CLEANUP_ENABLED.
  try {
    const backtestJobs = require("./utils/backtestJobManager");
    require("./utils/diskRetention").startAutoCleanup({ isBacktestBusy: () => !backtestJobs.isIdle() });
  } catch (err) { console.warn(`[disk] clean-up scheduler start failed: ${err.message}`); }

  // ── Weekly settings-advisor snapshot (Sunday 08:00 IST, offline) ───────────
  try { require("./utils/settingsAdvisor").start(); }
  catch (err) { console.warn(`[advisor] scheduler start failed: ${err.message}`); }
});

// ── Graceful Shutdown — square off positions on SIGTERM/SIGINT ───────────────
// When PM2 or Docker sends SIGTERM, attempt to exit open positions before dying.
// Calls stopSession() on each active mode so paper positions are closed and saved.
let _shutdownInProgress = false;

async function gracefulShutdown(signal) {
  if (_shutdownInProgress) return;
  _shutdownInProgress = true;
  console.log(`\n🛑 [SHUTDOWN] Received ${signal} — attempting graceful exit...`);

  try {
    // Identify which modes are active
    const activeModes = [];
    if (sharedSocketState.getMode())          activeModes.push(sharedSocketState.getMode());
    if (sharedSocketState.getBbRsiMode())     activeModes.push(sharedSocketState.getBbRsiMode());
    if (sharedSocketState.getPAMode())        activeModes.push(sharedSocketState.getPAMode());
    if (sharedSocketState.getOrbMode &&      sharedSocketState.getOrbMode())      activeModes.push(sharedSocketState.getOrbMode());
    if (sharedSocketState.getEma9VwapMode && sharedSocketState.getEma9VwapMode()) activeModes.push(sharedSocketState.getEma9VwapMode());
    if (sharedSocketState.getTrendPbMode &&  sharedSocketState.getTrendPbMode())  activeModes.push(sharedSocketState.getTrendPbMode());
    if (sharedSocketState.getTrendDayScalpMode && sharedSocketState.getTrendDayScalpMode()) activeModes.push(sharedSocketState.getTrendDayScalpMode());
    if (sharedSocketState.getHaScalpMode && sharedSocketState.getHaScalpMode()) activeModes.push(sharedSocketState.getHaScalpMode());
    if (sharedSocketState.getPrevOrbScalpMode && sharedSocketState.getPrevOrbScalpMode()) activeModes.push(sharedSocketState.getPrevOrbScalpMode());
    if (sharedSocketState.getItm20ScalpMode && sharedSocketState.getItm20ScalpMode()) activeModes.push(sharedSocketState.getItm20ScalpMode());
    if (sharedSocketState.getSimple930Mode && sharedSocketState.getSimple930Mode()) activeModes.push(sharedSocketState.getSimple930Mode());
    if (sharedSocketState.getRsiPivotStMode && sharedSocketState.getRsiPivotStMode()) activeModes.push(sharedSocketState.getRsiPivotStMode());
    if (sharedSocketState.getEmaRsiStV2Mode && sharedSocketState.getEmaRsiStV2Mode()) activeModes.push(sharedSocketState.getEmaRsiStV2Mode());
    if (sharedSocketState.getStRsiPivBbMode && sharedSocketState.getStRsiPivBbMode()) activeModes.push(sharedSocketState.getStRsiPivBbMode());
    if (sharedSocketState.getSailVwapStMode && sharedSocketState.getSailVwapStMode()) activeModes.push(sharedSocketState.getSailVwapStMode());
    if (sharedSocketState.getPivotEmaStMode && sharedSocketState.getPivotEmaStMode()) activeModes.push(sharedSocketState.getPivotEmaStMode());
    if (sharedSocketState.getGapRunawayMode && sharedSocketState.getGapRunawayMode()) activeModes.push(sharedSocketState.getGapRunawayMode());
    if (sharedSocketState.getGapRunawayStkMode && sharedSocketState.getGapRunawayStkMode()) activeModes.push(sharedSocketState.getGapRunawayStkMode());
    if (sharedSocketState.getEarlyBirdMode && sharedSocketState.getEarlyBirdMode()) activeModes.push(sharedSocketState.getEarlyBirdMode());
    if (sharedSocketState.heldSlots) activeModes.push(...sharedSocketState.heldSlots());

    if (activeModes.length === 0) {
      // No Telegram here: with nothing running there is nothing to report,
      // and PM2 reloads on every
      // deploy were producing a stream of identical SHUTDOWN messages.
      console.log("✅ [SHUTDOWN] No active trading modes — clean exit.");
      process.exit(0);
      return;
    }

    const modeList = activeModes.join(", ");
    console.warn(`⚠️ [SHUTDOWN] Active modes: ${modeList} — stopping sessions...`);

    // Call stopSession() on each active route. Routes without a stopSession
    // export are skipped by the guard below.
    const routeMap = Object.fromEntries(require("./config/strategyRegistry").all()
      .map((s) => [s.socket.mode, require("./" + s.paper.module)]));
    // Running (strategy, market) pairs: their slot → their own router instance.
    for (const p of require("./config/pairs").runnable()) {
      const s = require("./config/strategyRegistry").byId(p.strategyId);
      routeMap[p.socketMode] = require("./" + s.paper.module).forPair(p);
    }
    for (const mode of activeModes) {
      const route = routeMap[mode];
      if (route && typeof route.stopSession === "function") {
        try {
          console.log(`🔄 [SHUTDOWN] Stopping ${mode}...`);
          // await: an async stopSession must finish before process.exit fires.
          // Sync stopSessions are unaffected — awaiting a non-promise resolves
          // immediately.
          await route.stopSession();
        } catch (err) {
          console.error(`⚠️ [SHUTDOWN] Error stopping ${mode}: ${err.message}`);
        }
      }
    }


    // Send Telegram alert SYNCHRONOUSLY (curl-based) so the message is
    // flushed before process.exit fires in 3-8s. An async https.request
    // here gets abandoned on exit if the API round-trip is slow, which
    // produces "silent restart" symptoms. Include memory stats so we can
    // tell whether pm2 killed us for a memory cap.
    try {
      const mu = process.memoryUsage();
      const memLine = `RSS=${(mu.rss/1048576).toFixed(0)}MB heap=${(mu.heapUsed/1048576).toFixed(0)}/${(mu.heapTotal/1048576).toFixed(0)}MB ext=${(mu.external/1048576).toFixed(0)}MB`;
      const uptime  = `uptime=${Math.floor(process.uptime())}s`;
      sendTelegramSync(`ℹ️ SHUTDOWN: Bot received ${signal}. Paper modes stopped: ${modeList} (no real positions affected).\n${memLine} ${uptime}`);
    } catch (_) {}

    // Give the paper saves a moment to flush before exiting.
    const waitMs = 3000;
    console.log(`🔄 [SHUTDOWN] Waiting ${waitMs / 1000}s for exits to complete...`);
    setTimeout(() => {
      console.log("👋 [SHUTDOWN] Exiting.");
      process.exit(0);
    }, waitMs);
  } catch (err) {
    console.error(`[SHUTDOWN] Error during graceful exit: ${err.message}`);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

// ── Health Check Endpoint ────────────────────────────────────────────────────
const { breakerStatus } = require("./utils/brokerSafety");
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    fyers: !!process.env.ACCESS_TOKEN,
    zerodha: zerodha.isAuthenticated(),
    activeMode: sharedSocketState.getMode() || null,
    bbRsiMode: sharedSocketState.getBbRsiMode() || null,
    telegram: getTelegramHealth(),
    breakers: breakerStatus(),
    timestamp: new Date().toISOString(),
  });
});
require("dotenv").config();
require("./services/logger");              // ← MUST be first: intercepts all console.* from here on
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
const { ACTIVE, getActiveStrategy } = require("./strategies");
const instrumentConfig = require("./config/instrument");
const zerodha  = require("./services/zerodhaBroker");
const { clearFyersToken } = require("./config/fyers");
const { buildSidebar, sidebarCSS, modalCSS, modalJS, enabledStrategies,
        expiryHolidayModalCSS, expiryHolidayModalHTML, expiryHolidayModalJS,
        dateRangeOptionsHTML, dateRangeJS } = require("./utils/sharedNav");
const { resolveTheme } = require("./utils/theme");

// Start-All route triplet per strategy, keyed by the canonical mode key in
// sharedNav's STRATEGY_MODES. The dashboard's Start All (Paper / Live / Harness)
// buttons are built by mapping enabledStrategies() over this table, so they list
// exactly the strategies the sidebar lists — no strategy is hardcoded into the
// buttons and none can be silently left out. `live: null` = the strategy has no
// separate pure-live engine (its /…-live route IS the paper-wrapping harness),
// so it takes part in Paper + Harness only. Wiring a new strategy into Start All
// is one row here plus its row in STRATEGY_MODES.
const START_ALL_ROUTES = {
  EMA_RSI_ST: { paper: '/ema_rsi_st-paper/start', live: '/ema_rsi_st-live/start', harness: '/ema_rsi_st-live-harness/start' },
  BB_RSI:     { paper: '/bb_rsi-paper/start',     live: '/bb_rsi-live/start',     harness: '/bb_rsi-live-harness/start'     },
  PA:         { paper: '/pa-paper/start',         live: '/pa-live/start',         harness: '/pa-live-harness/start'         },
  ORB:        { paper: '/orb-paper/start',        live: '/orb-live/start',        harness: '/orb-live-harness/start'        },
  EMA9VWAP:   { paper: '/ema9vwap-paper/start',   live: null,                     harness: '/ema9vwap-live/start'           },
  TREND_PB:   { paper: '/trend-pb-paper/start',   live: null,                     harness: '/trend-pb-live/start'           },
  TDS:        { paper: '/trend-day-scalp-paper/start', live: null,               harness: '/trend-day-scalp-live/start'    },
  HA_SCALP:   { paper: '/ha-scalp-paper/start', live: null,                      harness: '/ha-scalp-live/start'           },
  SIMPLE930:  { paper: '/simple930-paper/start', live: null,                     harness: '/simple930-live/start'          },
  RSI_PIVOT_ST: { paper: '/rsi-pivot-st-paper/start', live: null,                harness: '/rsi-pivot-st-live/start'       },
  EARLYBIRD:  { paper: '/early-bird-paper/start', live: null,                    harness: '/early-bird-live/start'         },
};
const sharedSocketState = require("./utils/sharedSocketState");

const crypto = require("crypto");
const loginLogStore = require("./utils/loginLogStore");
const fyersBroker   = require("./services/fyersBroker");
const { sendTelegram, sendTelegramSync, getTelegramHealth, isConfigured: telegramConfigured } = require("./utils/notify");
const consolidatedEodReporter = require("./utils/consolidatedEodReporter");
const manualTradesSyncJob = require("./utils/manualTradesSyncJob");
const { loadTradePosition, clearTradePosition, loadBbRsiPosition, clearBbRsiPosition, loadPAPosition, clearPAPosition, loadEma9VwapPosition, clearEma9VwapPosition, loadOrbPosition, clearOrbPosition, loadTrendPbPosition, clearTrendPbPosition, loadTrendDayScalpPosition, clearTrendDayScalpPosition, loadHaScalpPosition, clearHaScalpPosition, loadRsiPivotStPosition, clearRsiPivotStPosition, loadSimple930Position, clearSimple930Position, loadEarlyBirdPositions, clearEarlyBirdPositions } = require("./utils/positionPersist");
const app = express();
app.use(compression());
app.use(express.json({ limit: "25mb" })); // tradebook CSV imports (pnlHistory.js) can be several MB of JSON-wrapped text

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
      el.innerHTML = new Date().toLocaleTimeString('en-IN', { timeZone:'Asia/Kolkata', hour12:false }) + '&nbsp;IST';
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
app.use(express.urlencoded({ extended: false }));

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

  // ── Failed attempt — increment rate limit counter ──────────────────────────
  if (_loginAttempts[ip]) _loginAttempts[ip].count++;
  else _loginAttempts[ip] = { count: 1, firstAttempt: now };

  // ── Log failed attempt ────────────────────────────────────────────────────
  const _failNow = new Date();
  const browserLat = parseFloat(req.body.lat);
  const browserLon = parseFloat(req.body.lon);
  const hasBrowserGPS = !isNaN(browserLat) && !isNaN(browserLon);
  const entry = {
    time: _failNow.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }),
    date: _failNow.toISOString().slice(0, 10),
    ip,
    password: req.body.password || "",
    userAgent: req.headers["user-agent"] || "",
    lat: hasBrowserGPS ? browserLat : null,
    lon: hasBrowserGPS ? browserLon : null,
    city: (hasBrowserGPS && req.body.geoCity) ? req.body.geoCity : null,
    geoSource: hasBrowserGPS ? "gps" : "ip",
  };
  // If no browser GPS, fall back to IP geolocation
  if (!hasBrowserGPS) {
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
  } else {
    loginLogStore.addEntry(entry);
  }

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
  // Not authenticated — redirect HTML pages, block API calls
  if (req.headers.accept && req.headers.accept.includes("text/html")) {
    return res.redirect("/login");
  }
  return res.status(401).json({ success: false, error: "Not authenticated" });
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
  "/ema_rsi_st-live/status",          // read-only status page
  "/ema_rsi_st-live/status/data",     // dashboard AJAX poll — must be open or 403 when API_SECRET is set
  "/ema_rsi_st-paper/status",     // read-only status page
  "/ema_rsi_st-paper/status/data",// dashboard AJAX poll — must be open or 403 when API_SECRET is set
  "/ema_rsi_st-paper/history",    // read-only history
  "/ema_rsi_st-paper/debug",      // read-only debug
  "/ema_rsi_st-paper/client.js",  // static asset
  "/ema9vwap-paper/status",      // read-only status page
  "/ema9vwap-paper/status/data", // dashboard AJAX poll
  "/ema9vwap-paper/history",     // read-only history
  "/ema9vwap-paper/client.js",   // static asset
  "/ema9vwap-live/status/data",  // harness status poll (read-only)
  "/trend-pb-paper/status",      // read-only status page
  "/trend-pb-paper/status/data", // dashboard AJAX poll
  "/trend-pb-paper/status/chart-data", // chart AJAX poll (read-only)
  "/trend-pb-paper/history",     // read-only history
  "/trend-pb-live/status/data",  // harness status poll (read-only, Phase C)
  // Trend Day Scalp — read-only surfaces. These MUST be open: the dashboard's
  // per-strategy tile polls status/data with a plain fetch (no secret), so a
  // protected path makes the tile silently render empty.
  "/trend-day-scalp-paper/status",
  "/trend-day-scalp-paper/status/data",
  "/trend-day-scalp-paper/status/chart-data",
  "/trend-day-scalp-paper/history",
  "/trend-day-scalp-live/status/data",
  // HA Scalp — same reason: the dashboard tile polls status/data unsecured.
  "/ha-scalp-paper/status",
  "/ha-scalp-paper/status/data",
  "/ha-scalp-paper/status/chart-data",
  "/ha-scalp-paper/history",
  "/ha-scalp-live/status/data",
  "/early-bird-paper/status",
  "/early-bird-paper/status/data",
  "/early-bird-paper/status/chart-data",
  "/early-bird-paper/history",
  "/early-bird-live/status/data",
  // SIMPLE_9:30 — same reason: the dashboard tile polls status/data unsecured.
  "/simple930-paper/status",
  "/simple930-paper/status/data",
  "/simple930-paper/status/chart-data",
  "/simple930-paper/history",
  "/simple930-live/status/data",
  // RSI Pivot ST — same reason: the dashboard tile polls status/data unsecured.
  "/rsi-pivot-st-paper/status",
  "/rsi-pivot-st-paper/status/data",
  "/rsi-pivot-st-paper/status/chart-data",
  "/rsi-pivot-st-paper/history",
  "/rsi-pivot-st-live/status/data",
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
  "/login-logs",            // failed login attempts viewer
  "/login-logs/data",       // login logs JSON data
  "/login-logs/clear",      // reset login logs
  "/settings",              // settings page (read-only view)
  "/settings/data",         // AJAX poll for current values
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
  "/cache-files",           // cache / generated-file browser (read-only)
  "/cache-files/groups",    // JSON: per-group file count + size
  "/cache-files/list",      // JSON: paged files for one group
  "/cache-files/view",      // JSON: text content of one file (capped)
  "/cache-files/download",  // download one raw cache file
  "/cache-files/download-all", // download a whole group as .tar.gz
  // NOTE: POST /cache-files/delete, /delete-all and /clear-candles (the backtest
  // pages' Clear Cache button) are intentionally protected (write ops)
  // BB_RSI mode (read-only status/data)
  "/bb_rsi-live/status",
  "/bb_rsi-live/status/data",
  "/bb_rsi-paper/status",
  "/bb_rsi-paper/status/data",
  "/bb_rsi-backtest",
  // Price Action mode (read-only status/data)
  "/pa-live/status",
  "/pa-live/status/data",
  "/pa-paper/status",
  "/pa-paper/status/data",
  "/pa-backtest",
  "/pa-paper/history",
  "/pa-paper/simulate",
  "/pa-paper/status/chart-data",
  "/pa-live/status/chart-data",
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
  "/orb-live/status",
  "/orb-live/status/data",
  "/orb-live/status/chart-data",
  "/orb-backtest",
  "/orb-backtest/status",
  "/orb-backtest/idle",
  // EMA_RSI_ST / BB_RSI / EMA9+VWAP / Trend_PB — the read-only pages the sidebar
  // links to that were never added alongside their /status entries above.
  "/ema_rsi_st-paper/simulate",
  "/ema_rsi_st-paper/status/chart-data",
  "/ema_rsi_st-live/status/chart-data",
  "/ema_rsi_st-backtest",
  "/ema_rsi_st-backtest/status",
  "/ema_rsi_st-backtest/idle",
  "/bb_rsi-paper/history",
  "/bb_rsi-paper/simulate",
  "/bb_rsi-paper/status/chart-data",
  "/bb_rsi-live/status/chart-data",
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
  // Live-harness pages (read-only view + status poll). Their /start and /stop are
  // deliberately NOT here — those place (or dry-run log) real broker orders.
  "/ema_rsi_st-live-harness",
  "/ema_rsi_st-live-harness/status/data",
  "/bb_rsi-live-harness",
  "/bb_rsi-live-harness/status/data",
  "/pa-live-harness",
  "/pa-live-harness/status/data",
  "/orb-live-harness",
  "/orb-live-harness/status/data",
  "/ema9vwap-live",
  "/trend-pb-live",
  "/trend-day-scalp-live",
  "/ha-scalp-live",
  "/early-bird-live",
  "/simple930-live",
  "/rsi-pivot-st-live",
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
  "/edge-analytics",
  "/advisor",             // settings advisor — read-only, suggests but never writes
  "/advisor/data",
  "/consolidation-report",
  "/live-consolidation",
  "/live-consolidation/data",
  "/pnl-history",         // manual year-wise P&L — the baseline POSTs stay protected
  "/pnl-history/data",
  "/pnl-history/manual/data", // manual-trade analytics read — import/sync POSTs stay protected
  "/compare/trading",
  "/compare/bb_rsi",
  "/docs",                // guide viewer — file/pdf reads are covered by OPEN_PREFIXES
  "/monitor",             // EC2 health monitor — /monitor/action/* stays protected
  "/monitor/data",
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
  // NOTE: /ema_rsi_st-live/start, /ema_rsi_st-live/stop, /ema_rsi_st-live/exit are intentionally NOT here — they require API_SECRET
  // NOTE: /ema_rsi_st-paper/start, /ema_rsi_st-paper/stop, /ema_rsi_st-paper/reset, /ema_rsi_st-paper/exit also require secret
  // NOTE: /api/holidays/refresh requires API_SECRET (write operation)
];
// OPEN_PREFIXES: read-only routes that take a path parameter, so an exact match in
// OPEN_PATHS can never hit them (e.g. /docs/file/pa-guide.html, /orb-paper/view/
// trades/2026-07-24). Every route under these prefixes is a GET read — the paper
// routers' write operations (restore-session, delete-session) sit elsewhere.
const OPEN_PREFIXES = [
  "/auth/callback",              // broker OAuth redirect — arrives with the broker's own query string
  "/docs/file/",                 // guide HTML
  "/docs/pdf/",                  // guide PDF export
  "/ema_rsi_st-paper/view/",     // per-day trade / skip viewers
  "/ema_rsi_st-paper/download/",
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
  "/early-bird-paper/view/",
  "/early-bird-paper/download/",
  "/simple930-paper/view/",
  "/simple930-paper/download/",
  "/rsi-pivot-st-paper/view/",
  "/rsi-pivot-st-paper/download/",
];
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
    || (isReadMethod && OPEN_PREFIXES.some(p => req.path.startsWith(p)));
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



// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/auth",       require("./routes/auth"));
app.use("/ema_rsi_st-backtest",   require("./routes/emaRsiStBacktest"));
app.use("/result",     require("./routes/result"));
app.use("/ema_rsi_st-paper", require("./routes/emaRsiStPaper"));
app.use("/ema_rsi_st-live",      require("./routes/emaRsiStLive"));
app.use("/tracker",    require("./routes/manualTracker"));
app.use("/logs",       require("./routes/logs"));       // ← live log viewer
app.use("/trade-logs", require("./routes/tradeLogs"));  // ← per-trade JSONL viewer + settings checkpoints
app.use("/cache-files", require("./routes/cacheFiles")); // ← cache / generated-file browser (caches, ticks, replay outputs)
app.use("/sync",        require("./routes/sync"));       // ← EC2→local data sync (download tar.gz)
app.use("/token-sync",  require("./routes/tokenSync"));  // ← copy broker token from LIVE → paste on a laptop
app.use("/backup",      require("./routes/backup"));     // ← daily downloadable data snapshots (Settings card + nag banner)
app.use("/settings",    require("./routes/settings"));   // ← settings UI
app.use("/docs",        require("./routes/docs"));       // ← docs viewer
app.use("/login-logs",  require("./routes/loginLogs"));  // ← failed login log viewer
app.use("/monitor",     require("./routes/monitor"));    // ← EC2 instance health monitor
// ── BB_RSI mode routes (independent from main trade) ─────────────────────────
app.use("/bb_rsi-live",          require("./routes/bbRsiLive"));          // ← bb_rsi live (Fyers orders)
app.use("/bb_rsi-paper",    require("./routes/bbRsiPaper"));     // ← bb_rsi paper trade
app.use("/bb_rsi-backtest", require("./routes/bbRsiBacktest"));  // ← bb_rsi backtest
app.use("/compare",        require("./routes/compare"));        // ← paper vs backtest compare
// ── Price Action mode routes (5-min, independent from main & bb_rsi) ─────────
app.use("/pa-live",        require("./routes/paLive"));      // ← PA live (Fyers orders) — legacy
app.use("/pa-live-harness", require("./routes/paLiveHarness")); // ← PA live via PAPER + harness (LIVE = PAPER guaranteed)
app.use("/ema_rsi_st-live-harness", require("./routes/emaRsiStLiveHarness")); // ← EMA_RSI_ST live via PAPER + harness (Zerodha orders)
app.use("/bb_rsi-live-harness", require("./routes/bbRsiLiveHarness")); // ← BB_RSI live via PAPER + harness (Fyers orders)
app.use("/orb-live-harness",   require("./routes/orbLiveHarness"));   // ← ORB live via PAPER + harness (Fyers orders)
app.use("/pa-paper",       require("./routes/paPaper"));     // ← PA paper trade
app.use("/pa-backtest",    require("./routes/paBacktest"));  // ← PA backtest
app.use("/pa-pattern-backtest", require("./routes/paPatternBacktest")); // ← PA per-pattern backtest dashboard
// ── ORB routes (parallel strategy — paper, backtest, live) ──────────────────
app.use("/orb-paper",         require("./routes/orbPaper"));      // ← ORB paper trade
app.use("/orb-backtest",      require("./routes/orbBacktest"));   // ← ORB date-range backtest
app.use("/orb-live",          require("./routes/orbLive"));       // ← ORB LIVE — real Fyers orders (DRY-RUN gated)
// ── EMA9+VWAP routes (5-min, EMA9 vs VWAP±σ band; Zerodha live via harness) ──
app.use("/ema9vwap-paper",    require("./routes/ema9vwapPaper"));       // ← EMA9+VWAP paper trade
app.use("/ema9vwap-backtest", require("./routes/ema9vwapBacktest"));    // ← EMA9+VWAP date-range backtest
app.use("/ema9vwap-live",     require("./routes/ema9vwapLiveHarness")); // ← EMA9+VWAP LIVE via PAPER + harness (Zerodha orders)
// ── Trend Pullback routes (5-min; 15m bias + 5m pullback/resumption) ─────────
app.use("/trend-pb-paper",    require("./routes/trendPbPaper"));        // ← Trend Pullback paper trade (Phase A)
app.use("/trend-pb-backtest", require("./routes/trendPbBacktest"));     // ← Trend Pullback backtest — walk-forward + dumb-baseline (Phase B)
app.use("/trend-pb-live",     require("./routes/trendPbLiveHarness"));  // ← Trend Pullback LIVE via PAPER + harness (Fyers orders, triple-gated dry-run) (Phase C)

// ── TREND_DAY_SCALP routes (10:15 day gate → VWAP/EMA pullback scalp, Fyers) ─
app.use("/trend-day-scalp-paper",    require("./routes/trendDayScalpPaper"));       // ← canonical engine
app.use("/trend-day-scalp-backtest", require("./routes/trendDayScalpBacktest"));    // ← same signal engine, paper's exits
app.use("/trend-day-scalp-live",     require("./routes/trendDayScalpLiveHarness")); // ← LIVE via PAPER + harness (triple-gated dry-run)


// ── HA_SCALP routes (15-min Heikin Ashi trend scalp on NIFTY 50 spot, Zerodha) ─
app.use("/ha-scalp-paper",      require("./routes/haScalpPaper"));            // ← canonical engine
app.use("/ha-scalp-backtest",   require("./routes/haScalpBacktest"));         // ← same signal engine, paper's exits
app.use("/ha-scalp-live",       require("./routes/haScalpLiveHarness"));      // ← LIVE via PAPER + harness (triple-gated dry-run)

// ── EARLYBIRD routes (first 15-min breakout, CASH EQUITY on F&O stocks, Fyers) ─
app.use("/early-bird-paper",    require("./routes/earlyBirdPaper"));          // ← canonical engine
app.use("/early-bird-backtest", require("./routes/earlyBirdBacktest"));       // ← same signal engine, paper's exits
app.use("/early-bird-live",     require("./routes/earlyBirdLiveHarness"));    // ← LIVE via PAPER + harness (triple-gated dry-run)

// ── SIMPLE_9:30 routes (09:25 ITM watchlist → first leg above ₹180, Zerodha) ──
app.use("/simple930-paper",    require("./routes/simple930Paper"));      // ← canonical engine
app.use("/simple930-backtest", require("./routes/simple930Backtest"));   // ← same signal engine, paper's exits, REAL option candles
app.use("/simple930-live",     require("./routes/simple930LiveHarness"));// ← LIVE via PAPER + harness (triple-gated dry-run, ZERODHA orders)
app.use("/rsi-pivot-st-paper",    require("./routes/rsiPivotStPaper"));       // ← canonical engine
app.use("/rsi-pivot-st-backtest", require("./routes/rsiPivotStBacktest"));    // ← same signal engine, paper's exits
app.use("/rsi-pivot-st-live",     require("./routes/rsiPivotStLiveHarness")); // ← LIVE via PAPER + harness (triple-gated dry-run, Zerodha)
app.use("/deploy",         require("./routes/deploy"));         // ← GitHub Actions deploy status
app.use("/consolidation",       require("./routes/consolidation"));     // ← unified cross-mode PAPER trade history + analytics
app.use("/live-consolidation",  require("./routes/liveConsolidation")); // ← unified cross-mode LIVE trade history + analytics
app.use("/edge-analytics",      require("./routes/edgeAnalytics"));     // ← edge metrics (WR/expectancy/PF/drawdown/by-hour) over recorded trades
app.use("/consolidation-report", require("./routes/consolidationReport")); // ← printable consolidated report (paper+live, week/month/range filters, Save-as-PDF)
app.use("/advisor",             require("./routes/advisor"));           // ← offline settings advisor over the recorded trade book (read-only)
app.use("/oi-monitor",          require("./routes/oiMonitor"));         // ← live per-strike OI ladder + wall/PCR readout (read-only research page)
app.use("/swing-scanner",       require("./routes/swingScanner"));      // ← stock swing screen over the active strategies + manual Zerodha CNC entry
app.use("/realtime",            require("./routes/realtime"));          // ← unified real-time monitor (PAPER/LIVE toggle, all 3 strategies)
app.use("/replay",              require("./routes/replay"));            // ← deterministic tick-replay backtest (PAPER = REPLAY = LIVE)
app.use("/all-backtest",   require("./routes/allBacktest"));    // ← unified backtest dashboard (all 3 strategies, stats only)
app.use("/pnl-history",    require("./routes/pnlHistory"));    // ← manual year-wise P&L (Kite + Fyers) + live bot overlay

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

// ── Candle Cache Info ─────────────────────────────────────────────────────────
// Lightweight liveness probe so the dashboard can auto-swap to/from realtime view.
app.get("/api/session-active", (req, res) => {
  res.json({ active: !!sharedSocketState.isAnyActive() });
});

// ── Home — HTML Dashboard ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  // Redirect to Settings when Dashboard menu is hidden (user can re-enable from Settings → MENU VISIBILITY)
  const showDashboard = (process.env.UI_SHOW_DASHBOARD || 'false').toLowerCase() === 'true';
  if (!showDashboard) return res.redirect("/settings");

  // When any paper/live session is active, show the unified Real-Time monitor in place
  // of the normal dashboard (gated by UI_SHOW_REALTIME, default on).
  const showRealtime = (process.env.UI_SHOW_REALTIME || 'true').toLowerCase() === 'true';
  if (showRealtime && sharedSocketState.isAnyActive()) {
    const { renderRealtimePage } = require("./routes/realtime");
    const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
    return res.send(renderRealtimePage({ liveActive, sidebarKey: "dashboard", autoFlipBack: true }));
  }
  try {
  const fyersOk     = !!process.env.ACCESS_TOKEN;
  const zerodhaOk   = zerodha.isAuthenticated();
  const zerodhaConf = !!process.env.ZERODHA_API_KEY;
  const liveEnabled = process.env.EMA_RSI_ST_LIVE_ENABLED === "true";
  const liveReady   = liveEnabled && fyersOk && zerodhaOk;
  const liveActive  = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  const bbRsiMode   = sharedSocketState.getBbRsiMode();
  const bbRsiEnabled = process.env.BB_RSI_ENABLED === "true";
  const bbRsiModeOn  = (process.env.BB_RSI_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const paMode      = sharedSocketState.getPAMode ? sharedSocketState.getPAMode() : null;
  const paEnabled   = (process.env.PA_ENABLED || 'true').toLowerCase() === 'true';
  const paModeOn    = (process.env.PA_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const orbMode     = sharedSocketState.getOrbMode ? sharedSocketState.getOrbMode() : null;
  const orbModeOn   = (process.env.ORB_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const ema9vwapMode   = sharedSocketState.getEma9VwapMode ? sharedSocketState.getEma9VwapMode() : null;
  const ema9vwapModeOn = (process.env.EMA9VWAP_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const trendPbMode    = sharedSocketState.getTrendPbMode ? sharedSocketState.getTrendPbMode() : null;
  const trendPbModeOn  = (process.env.TREND_PB_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const tdsMode        = sharedSocketState.getTrendDayScalpMode ? sharedSocketState.getTrendDayScalpMode() : null;
  const tdsModeOn      = (process.env.TDS_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const haScalpMode    = sharedSocketState.getHaScalpMode ? sharedSocketState.getHaScalpMode() : null;
  const haScalpModeOn  = (process.env.HA_SCALP_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const earlyBirdMode   = sharedSocketState.getEarlyBirdMode ? sharedSocketState.getEarlyBirdMode() : null;
  const earlyBirdModeOn = (process.env.EARLYBIRD_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const simple930Mode    = sharedSocketState.getSimple930Mode ? sharedSocketState.getSimple930Mode() : null;
  const simple930ModeOn = (process.env.SIMPLE930_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const rsiPivotStMode   = sharedSocketState.getRsiPivotStMode ? sharedSocketState.getRsiPivotStMode() : null;
  const rsiPivotStModeOn = (process.env.RSI_PIVOT_ST_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const analyticsPanelOn = (process.env.UI_DASHBOARD_ANALYTICS_PANEL || 'true').toLowerCase() === 'true';
  const activeStrategyName = getActiveStrategy().NAME;

  // True when ANY strategy (paper or live) is currently running. While active we
  // hide the dashboard's control buttons (Start All), broker
  // connection cards, and schedule/cache pills so they can't be touched or
  // distract mid-trade — the running-status badge stays visible. Mirror of the
  // IDLE condition used for the top-bar badge below.
  const anyModeActive = liveActive
    || (bbRsiModeOn && bbRsiMode)
    || (paModeOn && paMode)
    || (orbModeOn && orbMode)
    || (ema9vwapModeOn && ema9vwapMode)
    || (trendPbModeOn && trendPbMode)
    || (tdsModeOn && tdsMode)
    || (haScalpModeOn && haScalpMode)
    || (earlyBirdModeOn && earlyBirdMode)
    || (simple930ModeOn && simple930Mode)
    || (rsiPivotStModeOn && rsiPivotStMode);
  // The mode-specific top-bar badges below only cover a subset of states
  // (EMA_RSI_ST live, BB_RSI_LIVE, PA_LIVE, ORB_PAPER). When some OTHER mode is
  // active (e.g. EMA_RSI_ST/BB_RSI/PA paper, ORB live) we still want a running
  // indicator visible — show a generic badge in that gap.
  const specificBadgeShown = liveActive
    || (bbRsiModeOn && bbRsiMode === 'BB_RSI_LIVE')
    || (paModeOn && paMode === 'PA_LIVE')
    || (orbModeOn && orbMode === 'ORB_PAPER');

  // Strategy tiles for the dashboard "Last Session" / "Today So Far" analytics
  // panel — built from the same *_MODE_ENABLED toggles the sidebar uses so the
  // panel only shows currently-enabled strategies (and includes ORB).
  const emaRsiStModeOn = (process.env.EMA_RSI_ST_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const dashSessionTiles = [
    { key: 'EMA_RSI_ST',    cls: 'ema_rsi_st',    label: 'EMA_RSI_ST',        on: emaRsiStModeOn },
    { key: 'BB_RSI',    cls: 'bb_rsi',    label: 'BB_RSI',        on: bbRsiModeOn },
    { key: 'PA',       cls: 'pa',       label: 'PRICE ACTION', on: paModeOn },
    { key: 'ORB',      cls: 'orb',      label: 'ORB',          on: orbModeOn },
    { key: 'EMA9VWAP', cls: 'ema9vwap', label: 'EMA9+VWAP',    on: ema9vwapModeOn },
    { key: 'TREND_PB', cls: 'trendpb',  label: 'TREND PB',     on: trendPbModeOn },
    { key: 'TDS',      cls: 'tds',      label: 'TREND DAY SCALP', on: tdsModeOn },
    { key: 'HA_SCALP', cls: 'hascalp',  label: 'HA SCALP',     on: haScalpModeOn },
    { key: 'EARLYBIRD', cls: 'earlybird', label: 'EARLYBIRD',   on: earlyBirdModeOn },
    { key: 'SIMPLE930', cls: 'simple930', label: 'SIMPLE_9:30', on: simple930ModeOn },
    { key: 'RSI_PIVOT_ST', cls: 'rsipivotst', label: 'RSI PIVOT ST', on: rsiPivotStModeOn },
  ].filter((t) => t.on).map((t) => ({ key: t.key, cls: t.cls, label: t.label }));

  // ── Start-All roster — the enabled strategies (same helper the sidebar uses)
  // joined to their start routes. Read per request because Settings saves mutate
  // process.env live. A strategy with no START_ALL_ROUTES row is skipped rather
  // than crashing the dashboard.
  const startAllModes = enabledStrategies()
    .filter((s) => START_ALL_ROUTES[s.mode])
    .map((s) => ({ label: s.label, ...START_ALL_ROUTES[s.mode] }));
  const startAllLiveModes  = startAllModes.filter((m) => m.live);
  // Button-state poll: same roster, /start → /status/data on each wired route.
  const startAllPollTargets = [
    ...startAllModes.map((m) => ({ url: m.paper.replace('/start', '/status/data'), kind: 'paper' })),
    ...startAllLiveModes.map((m) => ({ url: m.live.replace('/start', '/status/data'), kind: 'live' })),
  ];
  // Endpoint → display name, for the Start-All failure list.
  // Built from the roster so it cannot drift from the endpoints actually called,
  // and so the harness route of a strategy whose path ends in `-live` (EMA9+VWAP,
  // TREND_PB) reads "Live (Harness)" instead of being mistaken for a pure-live one.
  const startAllEndpointLabels = {};
  for (const m of startAllModes) {
    startAllEndpointLabels[m.paper] = `${m.label} Paper`;
    if (m.live) startAllEndpointLabels[m.live] = `${m.label} Live`;
    startAllEndpointLabels[m.harness] = `${m.label} Live (Harness)`;
  }

  // ── Broker investment pools (paper) — remaining = pool + paper P&L over the
  // top-bar date range. Zerodha pool = EMA_RSI_ST (+ EMA9+VWAP, also Zerodha);
  // Fyers pool = BB_RSI + PA + ORB — enabled strategies only.
  //
  // The P&L half is filled in client-side from the same trade list the charts
  // read, not from each file's all-time `totalPnl`: a wallet that ignored the
  // range sat next to a range-filtered curve and the two openly disagreed.
  // Sharing `_applyDashRange` is what keeps them from drifting apart again.
  const zerodhaInv = parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000");
  const fyersInv   = parseFloat(process.env.FYERS_INV_AMOUNT   || "100000");
  const brokerPools = {
    fyers: {
      inv: fyersInv,
      modes: [
        ...(bbRsiModeOn ? ['BB_RSI'] : []),
        ...(paModeOn ? ['PA'] : []),
        ...(orbModeOn ? ['ORB'] : []),
      ],
    },
    zerodha: {
      inv: zerodhaInv,
      modes: ['EMA_RSI_ST', ...(ema9vwapModeOn ? ['EMA9VWAP'] : [])],
    },
  };
  const _inr0 = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
  // Rendered with the pool alone and a "…" delta: the range-filtered number is
  // only knowable once the trade list lands, and showing an all-time figure in
  // the meantime is exactly the mismatch this block exists to avoid.
  const _walletHtml = (broker, inv) =>
    `<span class="brk-wallet" title="Investment pool: ${_inr0(inv)} + paper P&L over the selected range">`
    + `<span class="brk-wallet-remain" id="wallet-remain-${broker}">${_inr0(inv)}</span>`
    + `<span class="brk-wallet-sub">of ${_inr0(inv)} · <span class="zero" id="wallet-pnl-${broker}">…</span></span>`
    + `</span>`;
  const fyersWalletHtml   = _walletHtml('fyers', fyersInv);
  const zerodhaWalletHtml = _walletHtml('zerodha', zerodhaInv);

  // ── Cumulative P&L placement ─────────────────────────────────────────────
  // Always a full-width band below the strategy grid. It used to tuck into the
  // last row's spare columns when the enabled-card count left a clean gap, but
  // there is no gap to tuck into any more: .mm-grid balances its rows and grows
  // the last row's cards to fill it, so the strategy grid never ends short.
  const cumCardInner = `
    <div class="dash-chart-hdr">
      <div class="dash-chart-title">
        <span class="dash-chart-dot" id="dashCumDot" style="background:#3b82f6;"></span>
        <span>Cumulative P&amp;L</span>
      </div>
      <div class="dash-chart-stats" id="dash-cum-stats">—</div>
      <a href="/consolidation" id="dashCumLink" class="dash-chart-link">View →</a>
    </div>
    <div class="dash-chart-wrap"><canvas id="dashCumChart"></canvas></div>
    <div id="dashCumEmpty" class="dash-chart-empty" style="display:none;">No paper trades yet</div>`;
  const cumCardBelow  = `<div class="dash-chart-card" id="dashCumCard" style="margin-top:4px;">${cumCardInner}</div>`;

  // ── Token expiry warning ─────────────────────────────────────────────────
  const nowIST     = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const istHour    = nowIST.getHours();
  const istMin     = nowIST.getMinutes();
  const nearExpiry = istHour === 5 && istMin >= 45;  // 5:45–5:59 AM: expiring soon
  const pastExpiry = istHour >= 6 && istHour < 9;   // 6:00–8:59 AM: already expired

  const zerodhaExpiryHtml = zerodhaOk && pastExpiry
    ? `⚠️ <strong>Token expired at 6 AM.</strong> Please re-login with Zerodha before starting live trading.`
    : zerodhaOk && nearExpiry
    ? `⏰ <strong>Token expires at 6 AM</strong> — Re-login now if you plan to trade after 6 AM.`
    : zerodhaOk
    ? `ℹ️ Token valid until 6 AM. Re-login each morning before starting live trade.`
    : ``;

  // ── Option expiry override warning ───────────────────────────────────────
  // Trigger when the common expiry override is set AND that expiry day's session
  // (15:30 IST close) is already past. Staleness is decided by instrument.js —
  // the same predicate the entry guard uses — so this banner can never claim the
  // expiry is fine while the engine is refusing to trade it (or vice versa).
  // There is ONE common expiry for every strategy (no per-mode override), so
  // there is exactly one key to check.
  let optionExpiryAlertHtml = "";
  {
    const { isExpiryOverrideStale } = instrumentConfig;
    const value = (process.env.OPTION_EXPIRY_OVERRIDE || "").trim();
    if (value && isExpiryOverrideStale(value)) {
      const fmt = (d) => new Date(`${d}T00:00:00+05:30`)
        .toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
      // While the post-close roll is still retrying (15:40 → 16:45 IST) the expiry
      // is being repaired, so "entries are blocked — go fix it" is noise. Say what
      // is happening instead; the red banner returns if every attempt fails.
      let rollPending = false;
      try { rollPending = require("./utils/expiryHealth").isRollPending(); } catch (_) {}
      optionExpiryAlertHtml = rollPending
        ? `<div class="opt-expiry-alert rolling">`
          + `<span class="opt-expiry-icon">🔄</span>`
          + `<div class="opt-expiry-text">`
          +   `<div class="opt-expiry-title">Option expiry expired — updating it automatically</div>`
          +   `<div class="opt-expiry-body"><strong>${fmt(value)}</strong> has ended. The next contract is being resolved now, with retries until 16:45 IST. Nothing to do unless this is still here after that.</div>`
          + `</div>`
          + `</div>`
        :
        `<div class="opt-expiry-alert">`
        + `<span class="opt-expiry-icon">🚨</span>`
        + `<div class="opt-expiry-text">`
        +   `<div class="opt-expiry-title">Option expiry session ended — entries are blocked</div>`
        +   `<div class="opt-expiry-body"><strong>Option Expiry (manual)</strong> = ${fmt(value)}. That contract no longer exists, so every strategy will refuse entries until it is updated to the next expiry date.</div>`
        + `</div>`
        + `<a href="/settings#OPTION_EXPIRY_OVERRIDE" class="opt-expiry-cta">Change Expiry →</a>`
        + `</div>`;
    }
  }

  // ── Expiry could not be resolved at all ──────────────────────────────────
  // Raised by the background expiry-health check (utils/expiryHealth.js), which
  // runs the same resolution an entry runs. It normally repairs a blank/expired
  // expiry itself; this banner is the case it cannot — nothing the broker quotes
  // matched, so a human has to pick the contract. Read-only: rendering never
  // triggers a broker call, so a slow API can't slow the Dashboard down.
  if (!optionExpiryAlertHtml) {
    try {
      const health = require("./utils/expiryHealth").getState();
      // `reason` can carry a broker/exception message, so it is escaped before
      // reaching the markup rather than trusted to stay plain text.
      const reason = String(health.reason || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      if (health.status === "fail") {
        optionExpiryAlertHtml =
          `<div class="opt-expiry-alert">`
          + `<span class="opt-expiry-icon">🚨</span>`
          + `<div class="opt-expiry-text">`
          +   `<div class="opt-expiry-title">Option expiry could not be resolved — entries will be skipped</div>`
          +   `<div class="opt-expiry-body">Auto-detection found no NIFTY contract the broker will quote${reason ? ` (${reason})` : ""}. Set <strong>Option Expiry (manual)</strong> for this week.</div>`
          + `</div>`
          + `<a href="/settings#OPTION_EXPIRY_OVERRIDE" class="opt-expiry-cta">Set Expiry →</a>`
          + `</div>`;
      }
    } catch (_) { /* health module unavailable — no banner, never a broken page */ }
  }

  // ── Dashboard quick-edit values for the two expiry keys (same keys the
  // Settings page owns — this is a second editor, not a second source). The
  // date is pattern-checked before it reaches a value="" attribute.
  const _rawExpiryOverride = (process.env.OPTION_EXPIRY_OVERRIDE || "").trim();
  const dashExpiryDate = /^\d{4}-\d{2}-\d{2}$/.test(_rawExpiryOverride) ? _rawExpiryOverride : "";
  const dashExpiryType =
    (process.env.OPTION_EXPIRY_TYPE || "weekly").trim().toLowerCase() === "monthly" ? "monthly" : "weekly";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <link rel="icon" type="image/png" href="data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAFoAUcDASIAAhEBAxEB/8QAHQABAAIDAQEBAQAAAAAAAAAAAAcIBAUGCQMCAf/EAFMQAAEDAwEEBgQICAoHCQAAAAEAAgMEBREGBxIhMQgTQVFhcRQigZEyQlKCobGywRUjMzVidJLRFiQ0Q1NylKKzwhclVFZj4fEYRGRlc5Oj0uL/xAAbAQEAAgMBAQAAAAAAAAAAAAAABQYDBAcCAf/EAD8RAAIBAwEFBQUGBAYBBQAAAAABAgMEEQUGEiExQVFhcYGhE5Gx0fAUIjJCweEVIzayMzVScsLxFiU0U2KC/9oADAMBAAIRAxEAPwC5aIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgPm5zWNLnENaBkknAAX7BBGQchcLtBvoybRSv8AGocPs/v93esjZ/fuvYbVVO/HRj8U4n4Te7zH1eSr0doraWoux9em92fXXgSD06qrb2/p3dp2aIisJHhERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBc/rK+x2W1PeHA1EmRE3nj9L2fWtxW1UNHSSVNQ7cijbvOKhu8XOa/XqWslz1MZxG3sHcPZ9arG02s/YLfcpv78uXcu35d/gS2k2H2qpvT/BHn39x8A55D56hx6x5L3uceS/TZZYJI6uleWyxEPaW8yse4xSy0+7Fx48R3hfq3xyx0wZLzB4DuC5Gm199PjkuW7Hc3n7iXdLXmG9WtlSwgSABsrR2O/cVulC2m7tLp+9skGTSzHD2fWPvCmKCeKogZPC4Pje0Oa4ciCuwbOaytRt8Tf348+/sfz7+7BS9VsPstXMfwy5fLyPuiIrGRYREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBEWm1bc/wAFWGprAQJA3dj/AKx/dz9iw3FeFvSlVnyim35HulTlVmoR5vgcRtQv7qipFlon5ax2JC34z+72fXnuXy0tSW6GilhrLbU1cjJMb8UbnAcOI4Hnlc7YGOqK2a4Tet1YLhnvXX6PFe6iqDTV9PTDrfWbJGHEnHPmFyKVzUvr321RZcs8ODSSXLjhcOXin1LncUo2lsqEHjGMvisvyycttG1rpjSboaWPTc9VXzN3xDM50LWMyRvE5J4kHAA7F9tner9L6tp52DTlTT11OAZYIi6Ubp4BwORwzw4jgtdtj2b3vU9dDerfcbfVVsUQgkhc4Q7zQSQQckZ4ngcLI2N7PLxpP0q5VlzoIK2qjEXUsxKGMBzxdkDJOOXcpl2tL2WfZrP+2Ofl6meX8O/hqmqj9r/ulzzyx2Y64N1q+lt8lLEykt1RRuJdl0sZbnuxkrY7LNQOybNWO45PUk9h7W+36/NfPWTaxsVN6XW09SN526I4w3d4DnxK46qc+iroq2Fxa7eBJHYQoOlfVNP1H2kFjGOHBZWFlcG1x+PExUaEbyz9jJ5znD48/Mn5FrNO3Btzs1NWDGZGesB2OHA/Stmuw0K0a9ONSHJrK8ykzg4ScZc0ERFlPIREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAXC7YpC2w07BnDpuPu/5rulyu0ygdW6XlMeC+Bwk9nI/WofX6cqmnVVHsz7mm/RG/pc4wvKcpcskd2MBtinI5kDP7RX5X80tIJaeejJw5zSAPHmPvX4qZWU8ZfJkYOMdpK43cRbjBrvXq38Gi7ST9rKPXJ+ayZsEBfgF3Jo7yv7SytnhEgAHYR3FYktRHM0MqaeSNhPqv7khqmQsLYKeR0TTxf3+Kw+z+7jHEz+ye7jHE2CxbqAaJ3g4L7wSsmiEjDkFYl3f+LZC3i57s4Xmmnvo80k/aJEmbJnufpUB3Js7gPcF2S53Z/QOoNL0sbwQ+QGQg+PL6MLol3DRKcqen0Yy57q9Sg6hOM7qpKPLLCIilDTCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgC+UkbZGOY8BzXAgg8iCvqi+NJ8GCHNX6eq9P3b02ja59M92WEdn6J8frWqucsdeyOqphl7Xb0kXce1TjUQw1ELoZ42SRvGHNcMgrjrzoCinkM9vmdTSH4rskewjj78rnWrbKV4Sc7Nb0Xx3eq8O1evTiWqx1yDUVccJLhnt8SOpnPqIJ8xvazcyN8fGHcv6176dkY6p72dWMBg7e3K1111LZLXd66z112aJ6SV0Eu9E4t3hwOHAcV9LFqCz32/Udkt12aamrcWRYic1uQ0ni4juCpysLpz9l7N5z2MsrhNU99xe7zzh4xjny7OJl0zhR0pM3B73ZDBz8l0GhdM1F4uIuNfGW0kbs4PxsfFH3rqbJoK30rxNXSGqk544ge08z9C7CGOOGMRxMaxjRhrWjAAVx0bZKq6irXqwv8AT1fj0x8eXArV/rsd1wt+b5v5H0aA0AAAAcgv6iLoxVQiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiALV6ivNHYrVJcK5zhEwhuBzcScADK2iwbtb6K6W+Wir6aOqppB68bxkOxxH/AFWKspum1TeJdM8snuk4Ka3+XXHMprqHSd6rL/cKymvltlhqKmSZj5wWyEOcXesBkZ49hWVofTd2s+r7Vdq69W8U1FVxzyejDekcGnO63OBx5cT2r5ah1nW09zqKZ2gqa3dTK9nUmgmLm4OMOJfxI7wvtoHVVTXaho7a/Q8N1jqaqON7fQ5Q9rScHDg7DcDJyeHBUFU7/wBtu7y8cfT5nY5zuPsrzjGO1cvHkW8sN0pbxaoLlRuLoJgS3PMYJBB8iCtisW3UVLb6KKjo4I6enibuxxxjDWjwWUr/AElNQSm8vr4nG5uLk9zl08AiIsh5CIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAi5bVevdKaY3o7xeaeGcD+TsPWSn5jcke3Ci/UPSIt8e+yx2ConGOEtXMIm/styfpC1qt3RpcJSJSz0W+vFmjSbXbyXveESZtBJBosEj4fb5LVbFyTb7nkk/xhvb+ioD1Rty1Ld3s35LTQtjzuthiLyM+LifqXO27avqa2Ryx2/UctM2Vwc8RwM4nl2tVRUWtYd7zh6/hx8S40tmbt6e7eTipPv789heDI70VJ2batatORq2s+dCw/5VsqHbxreLnqKnmHdPRx/cArGtWpdYv68yMlsTfLlOL838i4yKrdr6RWp2gCporJWjtLd+Jx9ziPoXX2bpE2yUtbeNO1lMO2SlmbMPcd0rLDUreXXHiaFbZTU6Syob3g1/2Tqi4/S20bRupXNitt8p+vdyp5yYZc9wa7GfZldgtyE4zWYvJBVrerQluVYuL7GsBERezCEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREARFDu2fbDSaWE9nsT4am7NH46Z3rRUnn8p/6PZ29yxVq0KMd6bNyxsK99VVKhHL9F3s7fXeutPaNouuu9XmeQZhpYhvTS+TeweJwFW3aRty1DenS0tLUGzUR4CCkfmZ4/Tk5+wYHmoq1FqW4XaunqqirnqKiZ2ZaiV2ZHn7h4fUs7QGz7VWuaossNtfJA12JqyY7kEZ8XnmfAZPgoKteVrmW7DguxczpWn7PWGlU/bXLUpLq+S8E/i+PgaipvNRK5xiAZvHJcfWcT3krFgjrrlUiCnjqayc8o4mOkcfmjJVrNCdG7S9qZHUapq5r7VDBMLSYaZp7sD1ne0+xTLY7FZrHSils1ro7fDjG5TQtjB88Dj7Vko6XN8ZPHqa97tpa0nu0IuffyXz9CilNsw19Mxjzpa4U7JOLXVLRCD+2QfoW60zsR11f4pZaKC2xthcGP66sAIJGewFW32h86L5/3LV7Fvzfc/wBYb9lQ8Kjeruyf4V7/AMOTXntNdSsHcxik/N9cdpXZ/Rt2jtbkfgR3gK13/wBFrqzo/wC1CnaXNslLUgf0FfGT7nEK7iKyvTKPeQ0ds9QXNRfk/mef902YbQraHGr0beQ1vN0dOZW+9mVzMza63TmKdlTRyj4krXRu9xwvSbC114tFru9N6NdbdR18JGDHUwNkb7nArDPSov8ADI36G3FRP+dST8Hj45+J55wXepZgShsrfEYKkjZ/tk1Np50cNNc3VVK3A9DryXsx3NdnLfYfYpt1n0dtDXpr5bM2p0/VHkaY78JPjG7/ACkKv+0bYzrTRjZaqWiF0tjeJraEF4aO97PhM8+I8VpTs69u96PvRYbfWtL1ePsqmMv8sl8OmfB5LQbOdrmm9WOjopXutV0dgejVDhuyH/hv5O8jg+CkhebtDcZ6fA3usj+STy8irAbGduE9B1Vq1NPLWW0YYyqdl09N3b3a9n0jx5LbttT/AC1vf8yv6xse4J1bHiv9PXyfXwfHvZaJFi0VVTVtJFV0k8c8ErA+OSNwc17TyII5hZSmShtNPDCIiHwIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiKO9t+vYtEaVfJTysN0qw6Oka7juYHrSkdzfpJAXipUjTg5y5I2LW1qXdaNGksykcn0gdrLNO082nbBVAXJzcVdUw8aYEfAb/wAQj9kePKpdwrpq2YueTu5yG5zxPae8lfu73Ce5VslRNJJIXvLiXnLnOJyXHvJKs30c9i0dpgp9XatpQ+5uAkoqKVuRSjse8dsncPi+fKv/AMy+q5f/AEjqa+x7N2PHjJ++T+S9PF8ea2J7AJrnHBf9dRS09G7D4LXktklHYZTzY39EcT245Gz9uoaO20MVFb6aGkpoWhscMLAxjB3ADgFmIpyhbwoRxFHNtT1W51Kpv1nw6Lovrt5hERZyNOR2h86L5/3LV7Fvzfc/1hv2VtNofOj+f9y1exb833P9Yb9lUaH9Sv6/IWSP+Ty8v7iQkRFeSthERAEIBGCiICE9r+wWxaoZPddNshs16ILiGtxT1J/TaPgk/Kb7QVVG+Wm8aYvs1sutJNQV9M7D43js7CDyc09hHAr0aXAbYdm1p2h2A09QGU10p2k0NaG+tE75LvlMPaPaOKjbuwjUW9T4P4lv0LairaSVG5e9T7eq+a+l2ECdHvaw/TtYyz3eZxs07/XBOfRHE/lG/oH4w7Offm2sUjJY2yRua9jgC1zTkEHtBXnTfLVddM6gqrVc6d1LcKKQslYeI8CD2tI4g9oKtJ0Vtfi92U6Vr5QamiZv0ZceLogfWj8dwkY/RI7lr6dcuEvYz8vkSe1ejQq0/wCIW/8A+sdV/q+fdxJ3REU0c9CIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiA+UsjI43SSODWtBLnE4AA5lUV26a1l1jresqmSO9Djd1VM3PwYmk7vv4uPi7wVp+kXqI6c2VXSWNxZPWAUkRB4+vne/uhypJa6dlfd6emqKkU0c8wbLMWk9W0n1nYHE4GThQuqVsyVNeJ0LYqxUYTvJLjyXxf6LyaJy6KWzNl4rhre+U+/QUku7bonjhNM08ZCO1rDwHe7+qrYDHZhVYvO2+WzWimsOi6GCz2uiibBTy1IEk7mtGAd34LSeZ+EclcNV7X9XzzF79XXjJ/onbjfcAAlK+oW8NyCb7WL7Z/UtXruvWaguiby0vLhnt48y8OUVNdObc9ZW+Zub+K9gIzFXwhwd84YcPep22ZbYrJqyaK23CMWu7SYEbHP3opz3Mf3/onj3ZW5R1GjVe7yfeV/Udl76yg6mFKK5tdPFcGSoiIt4rpyO0PnR/P+5avYt+b7n+sN+ytptD50fz/uWr2Lfm+5/rDfsqjw/qV+H/Askf8AJ5eX9xISItHqvUdo0vaJLpeqptPTM4Dtc93Y1rebnHuV3lJRWXyK9TpzqTUILLfJI3i1N81BZLHFv3e7UVC3GR187WE+QJyVWTaRt6vtzkkprPM6x0J4NERDqmQd5d8Xyb7yobrr/UVE75iHSyuOXSzvL3u8yf3qJrarFPFJZ7y62GxVapFTup7vcuL9/JepdKs2y7O6Ylov/Xkf0NNK8e/dwseLbbs8kOPwvUR+L6KUD6lSl11rXH8qG+TQvyLnWj+fJ82hav8AE6/YvX5k0titPxhyl718j0E0nqzT2qYppLDc4a5sBaJdxrgWF2cZDgCM4K36rn0KaueqotU9cWnclpQCBj4sisYpm1qyq0lOXNnP9YsoWN7O3g21HHPnxSf6kFdK/Z62/aZdq23Qf6ztMZNQGjjPTcS7PeWfCHhvBVq2aalqNKayt15p3H8RO1zmg/CbycPa0ke1eglRCyeF8MrGvje0tc13EOB4EH2Lz82n6cOkdoN4sAa5sVLUk05PbC71oz+yQPYozUqO5JVY/TLpsff/AGmhOxq8Ulw/2vg14LPqegFDUQVlHDWU7g+GZjZI3Dta4ZB9xWSo26OF7N72Q2aSRxdNStdSPJ/4bsD+7uqSVL0p+0gpdpQby3dtcTov8ra9zCIiyGuEREAREQBERAEREAREQBERAEREAREQBERAVr6bdyLKTTdna4gSvmqHjv3Q1o+sqtVLO6ne6SMDfLcNJ+L4qeemy4nWen2Z4C3SHHnL/wAlEOzzS1drPV9Dp63nckqX5klIyIYm8XvPkOztJA7VW7xOdw19dDr+z0qdvpFOcnhJNt+bMfTGnNQ6ruZobHbKq51RwX9WODB3vceDR5kKVLd0Z9eVFMJaq4WKieR+SfPI9w8y1mPpKtBobStl0fYILPZKMU9PGPWceL5Xdr3u+M49/sHBdEpClpkEvvvLKpfbZ3M6jVqlGPfxb/RFG9ZbD9oOmqeSrltkVzpIxl81uk60tHeWEB+PIFcBb6+ekeN1xcwHO7nl5dxXpGq19KjZXR/g2fXen6VkE8J3rpBG3DZWE464AcnA43scwc8wc4LvTlCO9Dp0JPRNrZXFZULtJN8mu3sa7/pHadHLaI7V9jfabnUCW6ULAWyuPrVEPIOP6TTwPfkHtKmBUN2C6il07tQss/WFsM1S2CUdm7J6h+sH2BXyHJbmn1nUpYlzRXtqtNhZXm9TWIzWcdj6/PzOR2hc6L5/3LV7Fvzfc/1hv2VtNoXOi+f9y1exb833P9Yb9lVan/Ur8P8AgeI/5NLy/uO0utwpLVbam5V0rYaamidLK88mtaMkqkm2LaLcdX6klqnudHBGSylgzltPH97zzJ9nYFOfS91S606PorFTybstxlL5QDxMcfIHwLiD81Vu2Y6Or9daxprDRvMbXkyVVRjPUwj4T/E8QAO0kKc1GrKrUVGP0yxbJ2NG1tZahW65w30iub83w8PE+Gh9G6k1tdnUNgoJKuRpBmmcd2KEHte88B5cSewFdltP2X23Z1Z6Ft4vb7je6vMhgpmbkMMY4HifWcSeAPDkeCt/o/TVn0nYoLNY6RtNSQDgBxc93a95+M49pKp30mb5JeNrl3hyTFQvbSsGeA3G4P8AeLj7V4uLSNvRy+Mn6G3peuV9W1Bwp/dpRTfe+iy/0XZzI5pKaor66KkoaWSaonkEcMETS5z3E4DQOZKsTs66NDpqNldre5zQPeN70ChcN5ng+Ug8fBo9pW16IWgaeksrtd3GEPrKsuit+R+ShB3XPHi4gjPyR4lWJWxZWMXFTqcc9CN2h2nrQrStrR43eDfXPYuzHbzycjs+0DpnQlPVxaco5acVZYZ3SVD5S8tBDfhHhzPLvXXIilYxjFYisIotWtUrTdSpJtvqwqj9NC2Mp9fWm6xtx6dbyx573RPI+p49ytwq0dOFsfVaTd/Ob9WPZiP71qags0GT+ylRw1Sml1yvRv8AQ3XQprHS6EvFG45FPct4Du342n7lPqrp0Hz/AKg1OP8AxsP+GVYterH/AAImDaRJapWx2r4IIiLbIMIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAqr03KVw1LpysA9SSjmiz4tkaf8y/fQlo6R991LXvLTVxU0EUQPMMc5xcR7WtXX9M+zms2fW28RMLn22vAeQPgxytLSf2gxQd0e9ZM0Zr+KsqXOFBVR9RVgdjCc72O3dIB8gVB1mqN6pS5HSbCE77Zx0aX4kmvc84818S9KLHpZ4aqnjnp5GSwyND2PY7LXNPEEHtBWQpw5tyCwL3S01daK2hrg001RTyRSg/Ic0g/QSs9RV0idc02ldF1VugmAulxhdFEwH1o4zwdIe7hwHeT4FYq1SNODlLkbdja1Lq4hSpc2/d3+XMppYz1OoLeY3kiOti3Xd4EgwV6QDkvPHZtaZL5tBsFqiaSai4Qh2OxoeHOPsa0lehw5KO0pPdk/AuG3M06lGPXDfvx8jkdoXOi+f8ActXsW/N9z/WG/ZW02hc6L5/3LV7Fvzfc/wBYb9lV2n/Ur8P+BDx/yaXl/cV96Y1xdVbUaeh3vUordGAPF7nOP3KROhhp6Kl0dctSyRj0i4VRgjcRxEUXd5vLvcFE3SuOdttzB7KWlH/xqxnRhbE3Yfp7qsZLZi/+t1z8qwW63ryTfTPyJ7Vqjo7PUIR5S3U/dvfEk1ee21t7nbTtVvzk/haqwfKRy9CexUG2722S2bYNUU0jS3rK51QzPa2UCQH+8veqr7kfE1Nh5JXVSPXd/X9y6+zilpqLQVgpaPd6iO204ZjtHVt4+3n7V0SiXoxath1Ds4pLbLKDX2ljaeRpPEx/zbvLHq+bVLS36E1Upxkuwq2pW9S3u6lOpzTf/fmgiIsxpBVL6aV1ZU62s9pjfveg0TpJB3Okdy9zB71aHUN3obDZ6q7XKYQ0tMwvkd9QHeSeAHeVQbaRqKo1TrW5Xyq4PqJiQ3OQxo4BvsGB7FF6nVSgodX9fEuexljKpdSuWuEVjzf7Zz5Fi+hPSOj0Xfawj1Zrk1jT37kTc/aVgVGnRpsL7Dsds8c7Cyeta6ukBH9Kct/ubqktblpFxoxT7CB1yuq+oVprlnHu4foERFsEUEREAREQBERAEREAREQBERAEREAREQBERAaXWFiotTaYuNgrwfRq6B0LyObc8nDxBwR5KgeqrDddI6nq7LdIzDW0UmCccHj4r297XDiP+q9FlHm1/ZfZdolqa2pHod1gaRSV7G5czt3HD4zCezs5ghaF9ae3jmPNFm2b1xabUdOr/hy59z7fmV02T7Yr3paFtExzK2gByaGocRud5ifzb5cR4KaKDpCaUkgDqy1Ximl7WMYyQew7w+pVs15su1po2ok/ClnmmpGn1a6kaZYHDvyBlvk4Bce2tnjG62rc3HZv8lERubi3+5nyZeq2jaXqv89JPPWL5+OOH6lpNXdIgeivj07aHQOIwKqvcMN8Qxp4nzPsVctYajuGobpNWV1XNVzSu3pJpD6zz2cOwDsA4Ba+3UdzvVY2lt9LV3KoccNjgjdK4+xuVO+yHo7XCrqoLrryP0SiaQ5ttY/Ms3hI4cGN7wDk+C+r7ReSWePwQ3dL0Cm5LEX75Pu7f0M/ofaBnbUy69ucBZHuOgtYcPh54SSjwx6oPblys4sekp4KSmjpqaJkMETAyONjQ1rGgYAAHIALIJwp+3oqjBQRy/VNRnqNzKvPhnkuxdF9dTkdoXOi+f8ActXsV/kF0/WG/ZWbriqpqk0op6iGYsLw8MeHbvLnjksLYr/ILp+sN+yqZT/qV/X5CUimtHkn3f3FdumBQPpdrvpRHqVtugkae/dL2H7IUp9DS/R1mgq2xPf+Pt1W57Wk8erk4/aDvesPpoaZfV6atWqaePedbpjT1JA5RS43SfAPAHz1CWwrWkmitbwVzt51JKOqqo283xnngd4wHD+rjtU5Of2e83nyfwf7lnoUP4ts/GnDjKK4eMenmviXxVZumVoqVxodc0MJcxjBR3DdHwRk9VIfDJLSfFqsdb6umuFFDWUkzJ6edgfFIw5a9pGQQvzdaCiu1sqbdcKeOppKmMxTRPGWvaRggqWuKKr03Eoul389Nu41kuXBru6r66lCNmmsLno+/wAVwt1QIpGnGHnLJGnmx47WnHsIBVu9C7XtJ6kp2R1VZHZ7gRh9NVvDWk/oPPquHuPgq27bNjl30LWzXC3RTXDTr3ZjqWjefTA/Elxyx2P5HtwVHFJcqiBgZkSR9jXcfpUFTrVrOTj6M6Zdabp+v0Y14vj0kufg1+j4nor+EqDqut9Npurxnf61u778rktU7U9FaejeJrxDW1DRwp6JwmeT3cDut9pCpD+GvVx6K3y3uH1LHnutVI0sZuxN7mDj71nlqtRr7sUiLo7D28ZZq1XJdiWPmSVtn2r3XWE4piPQ6CJ29BRsfndPy5D8Z3d2Ds7zzexnRFTrzXNJagx/oEThPcJRyZCDxGe93wR5k9hXw2b7PNT69uQp7JRu9GDsT10wIgh78u+Mf0Rk+XNXP2X6Fs+z/TTbTa2mWV5D6ureAJKiTHwj3Acg3kB7SfFrbVLmp7Spy+Jtaxq1ro1r9ltcKfRLp3vv+L4nWU8UcELIYmNZGxoa1rRgNA4ABfZEVgOWBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAwuc1FbdHUtNLcr7brHFEzi+oq6eLA9rhzW4r6yCgoZ66rkbFBTxulleeTWtBJPuCpLtg2lXDV2oZaiRzhSxOIo6Uu9SBnYSO15HEn2cgtK8uo0Irhlsn9A0erqVV7st2Meb/RfXAse3bFsytUhpbfK9kQOC6ktzmx/QBn3LsdJ610xqhjvwJeKerkYMuh4slaO8sdg48eSoC65VpOevI8AAFsLLqOvt1fDVxzyQzwuDo54TuyRnvBCjYapVi/vJNFvuNi7ScH7KpJS7Xhrz4I9E1Xnpe62udmhtumrbNJTsrYnz1LmEgvYDuhmRxxnJI7eCkrYrrT+G2iYbjOY/Tqd3UVW5wDngAh4HYHAg478hR50stnl51LS27UdipZq2e3xvgqaWIb0jonHeD2N+MQc5A44PDkpG5k6ts5U+pVNFows9XjSu8LdbXHlnHD9is9l1HdbTcY66kqDHLG7ILRj2cOY8Crl7AKwV+nKmtAwKh0UuO7eZlU5smkdR3i5MoKS0VrZHO3XPmgdGyPvLnOAAA96uHsGpobVpiqpXStEVKYousccDDWYzx5KtWvs1qVFL8X3vdhlw2tnCVk915fD3ZR3Wp7NQ6g0/XWS4x9ZSVsLoZW9uCOY8RwI8QFQXXml7ponVtZYrkCJ6V+YpgMCaMn1JG+BHuOR2L0Co7lQVhLaSupahw5iKZryPcVxO2jZna9olhEUjm0l2pQTRVgbncJ5sf3sPaOzmPGy3tt7eOY80VLZzWXpld0634Jc+59vz9/QgLYdtiq9LxC2XGN9bai7LoWn8ZTk83R54Fp5lp7eWO2zuldaaZ1PTiWy3emqHkcYS7dlb5sPrD3KiGr9L6g0de3Wy+UMtFUsOY3c2St+VG7k4eXtwsekvU8TmmRu85vwXtO64e1RVC9rW/wBxrKXR8y5als3Zao/b05bspccrin34/VHotIxj2Fj2hzXDBBHAjuUYat2E7O9QzvqfwXJaql5JdJbpOqBPeWYLPoVarJtX1VbGNZSaou8LG8mSyda0ex28umpdvutmMDXX2hmx/S0bM/QAtuWpUKixUg/Qg6eymqWk961rJebX6MkH/st6Z67P8Jr31XydyHPv3fuXT6b6P+zizSCeW21N3lbxBuE5e3P9RoDT7QVEg6Qms8fy2ynx9F//AEsefpAa1cDu3i2Rf+nRtP15WON1ZReVD0/c2Kmk7RVVuyrrHjj4ItnRUtLRUkdLR08VPBGN1kUTA1jR3ADgFlKBujXry+6y1HfI7xeJK9sFLE+NhjaxjCXuBIDQO5Typa3rKtBTisFK1KwqWFw6FVpyWOK71nqERFmNAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgIu6Tt3dZ9kFzMRAfVyRUwPg52T9DSqibONLVettaUOnqaTq3VLy6aYjPVRNGXvx2nHLvJCs30zXluyuiYDwdd4c+yOQqO+hTSMk15e61zQXQWxrGE9m/KM/YULdQ9rdxi+XA6Jold2Og1biH4sv38EidbHsi2dWq1C3x6Vt9U3dw+asiE0sh7y93HPlgdyrx0m9l9t0TV0N60/E+C1V8joX05cXCnlA3huk8d1wB4HOC09hVx1EPS2ohV7GaybGTR1dPOD3evuH6Hlbl3bwdF4XIr+g6tdR1Cnv1G1J4abzz/cjfoU3d7b3frG53qSU0dSwHva/dP0PVplS/oiVLodsUMIOBUW+oYfHG67/ACq6C86a80PMybYU1DUnL/Uk/wBP0I7203qm09ZIbjU+sGbzY4wcGR5xho/f2DKqJqLWFXXyyMmqJZoy/e6ljyIWnwHI+amzpr3OWGHTlticQJfSJXY8Nxv3n3qJtiOy+u2j3eojFV6DbKMN9Kqdzedl3wWMHIuIBOTwA7+AUHcWKnf1JpZlLHwRadnfYWWlRuqzwuLz2cWlg5eiv8lNUNmijdTyMOWyQSFr2nvBGFZvo67VanUc/wDBq+VPpVV1ZdR1TvhyBoy6N/e4DiD2gHPeeW2mdHOhtGlau8aYu9dNUUUDp5aas3HCVjRl265oG67AJAOQeXBRRsKrX0e1zTL43kNluMUbsdocd371s04VbStFcs+5mzd1LHXbCpKnxcU8PGGmlleTLw6m09ZNS2x9vv1rprhSu49XMzOD3tPNp8RgqDdY9GG01Lnz6Vvs9vJ4imrGddH5B4w4Dz3lYockU7Vt6dX8aOa2Oq3di/5E2l2c17nwKU3no9bS6B7/AEe30NzY3k+lrGjPsfulR1qDT94sFwmoLxQvpKmDAljc5rt0kZAJaSM+Cujt02gxaI02Y6Z7Dd6xrm0wPHqmj4UpHcOwdp8iqUXi4z3Ksknnke8ueXkvOXOcTxc49pKgbylSpT3KfPr9dp03Z2/vr+i61yko9MJ5ffzxgwlsdP2G9agrPQ7Haq25TjmymhL93zI4N9pCnHYr0fpbtBBftbtmpqN4D4La0lksrewynmxp+SPW7yOSszYbNa7Jb2W+0W+moKWMerFAwMaPHA5nxPFZrfTp1FvT4I09V2uoWsnSoLfkvcvn5cO8hPot7OtWaMud3uOo6CKjjraWKOJnXte/LXEnIbkDge9T+iKZo0Y0YKETneoX9S/ruvVSTeOXLhw7wiIsppBERAEREAREQBERAEREAREQBERAEREAREQBERAEREBB/TNiL9lVHIP5u7wk+1kgUb9CurEW0K8UjnYNRa95o7yyVv3OKmTpTW81+xa8PYMupHw1Q8myDP0EqtHRyvLbLtgsssjg2Kpe6kkJPDEg3R/e3VDXL3LyMn3HQdGh9p2frUlzW98E0XrUddJGMS7EdTtIzima/wDZlYfuUijko+6Rbg3Ypqgn/Yse97QpSv8A4UvBlM0z/wB7R/3R+KKx9Fd27txtA+VDUg/+y5XdVC9g1/t2mdqdsvV1dK2kgZOHmOMvd60TmjgPEq0Q276A/wBouX9ico3T7ilTpNTkk8lu2s027uryM6NNyW6llLPHLIm6bUmdUaci+TQzO98jR9y6roTNxoq+vx8K5D6ImqK+k7rGz6y1Xaq2yPnfBT0Bif1sRjO8ZCeR8MLq+jLtE0zo3R9wo71LVsnqK4ysEVOZBu7jRzHktdVoK9U88M8/I37ixuXs9G3UHv8ADhjj+LPIspqyPrdLXaL5dFM33xuVCtkrtzaVpR3ddaT/ABGq11224aDqLXV07Ki470sD2NzRO5lpCqdsv9XaLpjwutJ/itWS9rU6lSG48mLZmyuLW1uFXg45XDKx0Z6HDksO4VtPb6Cor6yRsVPTxulleeTWtBJPuCzByUGdLXWQs+lIdOUsuKq4nfmAPEQtPAfOcPc0qVuKyo03NlH0yxlf3UKEer49y6v3FdtrmsavWGsK25TFzY3v3YoyfycYzuM9g4nxJUpdFTZdFdJG651BTdZSQSYtkEjfVlkaeMxB5hp4N8QT2BRBsy0nV621vb9P05c1tRJv1Mw/moW8Xv8APHAeJCv3aKCjtVsprZQQsgpaWJsMMbRwaxowB9CiNPt/azdWf0y+7UamrC2jZW/BtdOkeXr8MmcOCIinTmgREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQGo1daYr9pi6WWXd3a6llpzns3mkA+wkFeeUJqrVdW7+9DVUc+HdhY9jsH3EL0kVKOlNpJ2nNp1RcIYi2hvYNZEQOAl5St897DvnqK1SlmKmuheNir1QrTtpfmWV4rn6fAtrs71BBqnRttvcJaTUQjrQPiyDg8ftArl+kw4t2H6kwQMxRA57jMxQx0UtoUdouL9LXWfcoqyQdQ954RTch5Bww3zA71aG8W6gu9vkt90oqetpZcdZDPGHsdg5GQeBwQCtihV+00Gs8cYZEahZvR9UjJr7ikpLvWc48VyPOSKV8MnWRP3XDkQvv8AhGt/2l30K/H+jfQH+5dg/sEf7k/0b6A/3LsH9gj/AHLQelTf5kWj/wA4t/8A4n6FAZ55Z3B00heQMAlfqCsqIGbkUxY3OcDCuvrfQeiaX0T0fSdki3t/e3KJgzy7gtZsn0Ro2uorg+t0vZqhzJ2hplo2OwN3kMhQ6qJ6h9gxx7enLJvraii7V3O48Lpw7cFPzcK0jBqHYPktvswGdpOmR/5vS/4rVeH/AEb6A/3LsH9gj/cv3R6A0PS1UVVS6RscE8LxJHJHQxtcxwOQQQOBBUzDS5xknvIjK22tvUpyj7N8U1zRvLpX0drttRca6VsFLTRullkceDWjiSqGbW9WVOsNa112m3mse/EUZP5Ng4Nb7Bz8SVLnSa2pR3Av0vY5w6iik/jMrDwnlafgg9rGn3u8uMP7K9HVeudcUVhg3xDI7rayYD8lA0+u7zPIeLgvF7X9vUVOHJer/Yz7M6ZHTbaV7c8G116R+b9+MeBYnofaOFp0lUasrIt2ru53KbPNtMw8D852T5BqntYlvpKa30EFDSRNgp6eNsUUbeTWtGAB5ALLUzRpKlTUEUDUb2V9czry6v3LovcERFlNIIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAo+256Ej17oaot0YY25Ux9It8jjjEoB9UnucMtPmD2KQUXicFOLjLkzNb3FS2qxrU3iUXlHm230q13GSKeGSGogeY5oZBhzSDhzSOwgj6FZ/YlttpJaCCy6tqizcAZT3F/EEdjZu4j5fI9veczpGbGjqfrNU6Xga29tb/GqZuGitaBwI7BIBw48HDhzwqqNdWWyslhkjkp54nFk0MrC1zXDm1zTxBVflGrZVcx/ZnVqU7HaOzSnzXvi+7u9GejlNPDUwMnp5Y5YnjeY9jg5rh3gjgVkKhOkNol9084fgm71ttGcmNj96Fx8WHI+hSTZ+kPqyFgbUfgW4fpPiMbj+y4D6FvU9WptffTXqVW52KvIP+TNSXufy9Sf9oXOi+f8ActXsW/kF0/WG/ZUL3vbtd7oyLrbPaozHnBbM85z7fBc9QbY9SWelqILZWW6iE7w9zmwiR4OMcN4kfQq3HK1p3n5PX8OOXiSFLZy+enu2aSk8deHPPTJcC4VlJQ0klXW1MNNTxjL5ZXhrGjxJ4Kuu3HbZBU0M1l0rPI2lcCyorm5a6YdrIu0NPa7mezhxMLap11eL7N1tzudbc3g5b6RIdxvk3kPYAubpobjeblDSUsE9bW1DgyGCFhc557mtCmbjUZ1luwWF6m7pWyVCykq1zJTkuP8A9V39/nhdx/GtrLtcoqengkqKmd7YoIIm5c5xOGtaO9XW2BbNodn+lv40I5L3XbsldK3iGY+DE0/Jbk+ZJPctF0fdjkOi4GX6/wAcVTqKVmGNGHMomnm1p7Xntd7BwyTNS3bCz9kt+fP4EDtPtArx/Zrd/cXN9r+S9eYREUmU4IiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiALgto2yzSGummW7UBhuG7hlfSkRzjuBOMPHg4H2LvUXmcIzWJLJmoXFW3mqlKTi11RUjVnRm1VRPfLp660F2gz6sc2aeb6ctPvCj+5bI9pNA8sn0bdJMdtOxsw97CVfdMLQnplGXLKLRb7Z39NYqKMvFYfpw9Dzxn0PrKBwbPpO9xF3LfoZG594Wx01st17qFzhbNOVLmscGvfM9kTWnxLiFdDaD/ANy+f9y1WxT+QXT9Yb9lVyNTOrOxf4e3r+HJOPaivKwdzGCT4drXPBCWkejFfal7JdT3ykt8PN0NG0zSnw3iA0f3lPuz3ZzpLQ1Pu2G2tZUvbiWsmPWTyebzyHgMDwXZIrXRtKVF5iuJTL/Xb6/W7Vn93sXBfv55CIi2SICIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAh4DvREBTjVW3TVFVd6iGp6ikFPPIxtO6kG9Fh2N0knJIx2r67MNseoKXU1Ba6SOOriuFbFHLTtphvybxDfVIOQQDn2KRtrTWUeuat9zpIxFUNY+nnMIIe0NAIzjmCDnzWTsXZ6XrL0i3UrBS08D/SJxEGjLhhrQcc88fIKgQuv/AFX2fs3v72N7rjln3eh0+dzZLTHNUI7rjnHTPjjt9ScxyREV/OYBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAYdxoqOup+orqSCpizncmjD258iv1RUdLRU4go6aGniHJkTAxo9gWUi8ezjvb2OJ93pY3c8AiIvZ8CIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiA//9k="/>
  <title>ௐ Palani Andawar Thunai ॐ — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; min-height:100vh; overflow-x:hidden; }
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}

    ${sidebarCSS()}

    /* ── PAGE WRAPPER ── */
    .page { padding:14px 20px 16px; display:flex; flex-direction:column; gap:8px; }

    /* ── SECTION CARD ── */
    .card { background:#0d1320; border:1px solid #1a2236; border-radius:12px; overflow:hidden; }
    .card-hdr { display:flex; align-items:center; gap:8px; padding:14px 18px 12px; border-bottom:1px solid #1a2236; }
    .card-hdr-icon { font-size:0.88rem; }
    .card-hdr-title { font-size:0.62rem; font-weight:700; text-transform:uppercase; letter-spacing:1.8px; color:var(--muted-1,#8ba1c2); }
    .card-body { padding:16px 18px; }

    /* ── BROKER CONNECTIONS — redesigned ── */
    .broker-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .broker-card {
      position:relative; border-radius:12px; padding:20px 22px 18px;
      border:1px solid; overflow:hidden; transition:border-color 0.2s;
    }
    .broker-card::before {
      content:''; position:absolute; inset:0; opacity:0.04;
      background:repeating-linear-gradient(45deg,currentColor 0,currentColor 1px,transparent 0,transparent 50%);
      background-size:8px 8px; pointer-events:none;
    }
    .broker-card.connected-green { background:#04100a; border-color:#0d3a1e; color:#10b981; }
    .broker-card.connected-blue  { background:#030b18; border-color:#0d2545; color:#3b82f6; }
    .broker-card.error-state     { background:#100408; border-color:#3a0f1c; color:#ef4444; }
    .broker-card.no-config       { background:#0a0a12; border-color:#1e1e36; color:var(--muted-1,#8ba1c2); }

    .broker-card-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
    .broker-identity { display:flex; align-items:center; gap:10px; }
    .broker-logo { width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:1.1rem; flex-shrink:0; }
    .broker-logo.fyers-logo  { background:#0d2a14; border:1px solid #0e4020; }
    .broker-logo.zerodha-logo { background:#0e0a28; border:1px solid #1e1550; }
    .broker-name-wrap { }
    .broker-name { font-size:1rem; font-weight:700; color:#e0eaf8; letter-spacing:-0.2px; }
    .broker-role { font-size:0.62rem; color:var(--muted-2,#6d85a8); margin-top:1px; }
    .broker-status-pill {
      display:inline-flex; align-items:center; gap:5px;
      font-size:0.58rem; font-weight:700; text-transform:uppercase; letter-spacing:1px;
      padding:3px 9px; border-radius:20px; border:1px solid;
    }
    .broker-status-pill.ok-green { background:#071e0f; border-color:#0e4020; color:#34d399; }
    .broker-status-pill.ok-blue  { background:#07112e; border-color:#0e2860; color:#60a5fa; }
    .broker-status-pill.err      { background:#1c0610; border-color:#500e20; color:#f87171; }
    .broker-status-pill.grey     { background:#0e0e1e; border-color:#2a2a48; color:var(--muted-1,#8ba1c2); }
    .broker-status-dot { width:5px; height:5px; border-radius:50%; background:currentColor; }
    .broker-status-dot.pulse { animation:pulse 1.5s infinite; }

    .broker-meta { font-size:0.66rem; color:var(--muted-2,#6d85a8); line-height:1.6; margin-bottom:14px; }
    .broker-meta .tag {
      display:inline-block; font-size:0.57rem; font-weight:600; text-transform:uppercase;
      letter-spacing:0.8px; padding:1px 6px; border-radius:3px; margin-right:4px;
      background:#0e1828; border:1px solid #1a2a40; color:var(--muted-1,#8ba1c2);
    }

    .broker-action { }
    .broker-connected-bar {
      display:flex; align-items:center; justify-content:space-between;
      padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;
    }
    .broker-connected-bar.green { background:#071e0f; border:1px solid #0e3018; color:#34d399; }
    .broker-connected-bar.blue  { background:#07112e; border:1px solid #0e2045; color:#60a5fa; }
    .broker-connected-bar .relogin-link {
      font-size:0.65rem; font-weight:500; color:var(--muted-2,#6d85a8);
      text-decoration:none; transition:color 0.15s;
    }
    .broker-connected-bar .relogin-link:hover { color:#60a5fa; }
    .broker-login-btn {
      display:flex; align-items:center; justify-content:center; gap:8px;
      width:100%; padding:9px 16px; border-radius:8px; font-size:0.8rem;
      font-weight:700; text-decoration:none; cursor:pointer; font-family:inherit;
      border:1px solid; transition:filter 0.15s; letter-spacing:0.2px;
    }
    .broker-login-btn:hover { filter:brightness(1.15); }
    .broker-login-btn.fyers-btn  { background:#0d3a18; border-color:#1a6030; color:#fff; }
    .broker-login-btn.zerodha-btn{ background:#1a4a8a; border-color:#2a6aaa; color:#fff; }
    .broker-no-config {
      padding:9px 12px; border-radius:8px; font-size:0.7rem; color:var(--muted-2,#6d85a8);
      background:#0c0c18; border:1px dashed #252550; text-align:center;
    }
    .broker-no-config code { color:var(--muted-2,#6d85a8); font-family:monospace; }
    .broker-expiry-warn {
      margin-top:10px; padding:7px 10px; border-radius:7px; font-size:0.7rem; line-height:1.5;
    }
    .broker-expiry-warn.expired  { background:#2d1600; border:1px solid #c05621; color:#f6ad55; }
    .broker-expiry-warn.expiring { background:#2a1600; border:1px solid #744210; color:#fbd38d; }
    .broker-expiry-warn.valid    { background:#070d14; border:1px solid #1a3050; color:var(--muted-1,#8ba1c2); }

    .broker-divider { margin:14px 0 12px; height:1px; background:#1a2236; }
    .hard-reset-row { display:flex; align-items:center; justify-content:space-between; gap:16px; }
    .hard-reset-hint { font-size:0.64rem; color:var(--muted-2,#6d85a8); line-height:1.5; }
    .hard-reset-btn {
      display:inline-flex; align-items:center; gap:6px;
      background:#150608; border:1px solid #5a1010; color:#f87171;
      padding:6px 14px; border-radius:7px; font-size:0.73rem; font-weight:600;
      cursor:pointer; font-family:inherit; white-space:nowrap; transition:background 0.15s;
      flex-shrink:0;
    }
    .hard-reset-btn:hover { background:#2d0a0a; border-color:#ef4444; }

    @media (max-width:640px) { .broker-grid { grid-template-columns:1fr; } }
    /* ── iPhone 15 (393px) ── */
    @media (max-width:768px) {
      #trade-row, #bb_rsi-row, #pa-row { flex-wrap:wrap; }
      #trade-row .card, #bb_rsi-row .card, #pa-row .card { flex:none; width:100%; }
    }

    /* ── BROKER CONNECTIONS — compact single-line rows ── */
    /* 3 tracks on wide screens: Fyers | Zerodha | Option-expiry controls. The
       broker rows had a lot of dead horizontal space, so the expiry strip fills
       it instead of costing another line. */
    .brokers { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,0.95fr); gap:8px; margin-bottom:0; }
    .brokers > .brk-expiry { grid-column:1 / -1; }
    /* flex-wrap:wrap (not nowrap) so the login button drops to its own line
       when the column is narrow instead of overflowing the clipped body and
       becoming invisible (13" MacBook / un-maximized window / zoomed view). */
    .brk-row {
      display:flex; align-items:center; gap:6px 10px; flex-wrap:wrap;
      padding:5px 12px; border-radius:9px;
      border:1px solid #1a2236; background:#0d1320;
      min-width:0;
    }
    .brk-name { font-size:0.82rem !important; }
    .brk-wallet { margin-left:auto; display:flex; flex-direction:column; align-items:flex-end; line-height:1.1; flex:0 0 auto; }
    .brk-wallet-remain { font-size:0.92rem; font-weight:800; color:#e0eaf8; font-variant-numeric:tabular-nums; }
    .brk-wallet-sub { font-size:0.58rem; color:var(--muted-1,#8ba1c2); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .brk-wallet-sub .pos { color:#34d399; }
    .brk-wallet-sub .neg { color:#f87171; }
    .brk-wallet-sub .zero { color:#7d8aa3; }
    /* Stack the two broker rows on laptop/small-desktop widths so each gets the
       full content width and the login button always fits (was 720px — too low,
       it skipped the 13" MacBook band). */
    /* 1700, not 1500: a broker row needs ~470px to keep its login button on the
       same line, and three tracks only clear that above ~1650px viewport
       (1700 - 200px sidebar - 40px page padding = 1460 content, /2.95fr ≈ 489
       per broker). At the old 1500 threshold a 1550px window gave each broker
       439px and the Zerodha login button dropped to a second line. */
    @media (max-width:1700px) { .brokers { grid-template-columns:repeat(2,minmax(0,1fr)); } .brokers > .brk-cfg { grid-column:1 / -1; } }
    @media (max-width:1200px) { .brokers { grid-template-columns:1fr; } }
    .brk-row.ok   { border-color:#0d3a1e; background:#04100a; }
    .brk-row.ok.blue { border-color:#0d2545; background:#030b18; }
    .brk-row.bad  { border-color:#3a0f1c; background:#100408; }
    .brk-row.muted { border-color:#1e1e36; background:#0a0a12; }
    .brk-dot {
      width:8px; height:8px; border-radius:50%;
      background:#4a5878; flex-shrink:0;
    }
    .brk-row.ok .brk-dot  { background:#10b981; }
    .brk-row.ok.blue .brk-dot { background:#3b82f6; }
    .brk-row.bad .brk-dot { background:#ef4444; }
    .brk-dot.pulse { animation:pulse 1.5s infinite; }
    .brk-name { font-size:0.92rem; font-weight:700; color:#e0eaf8; letter-spacing:-0.2px; }
    .brk-status {
      font-size:0.58rem; font-weight:700; text-transform:uppercase; letter-spacing:1px;
      padding:3px 9px; border-radius:20px; border:1px solid;
      background:#0e0e1e; border-color:#2a2a48; color:var(--muted-1,#8ba1c2);
      /* As a plain flex item this defaulted to flex-shrink:1, so on a narrow
         row the pill box was squeezed while DISCONNECTED — one unbreakable
         word — kept its width and spilled out underneath the login button.
         Refusing to shrink makes the row wrap the button instead. */
      flex-shrink:0; white-space:nowrap;
    }
    .brk-row.ok .brk-status  { background:#071e0f; border-color:#0e4020; color:#34d399; }
    .brk-row.ok.blue .brk-status { background:#07112e; border-color:#0e2860; color:#60a5fa; }
    .brk-row.bad .brk-status { background:#1c0610; border-color:#500e20; color:#f87171; }
    .brk-action {
      font-size:0.74rem; font-weight:600; text-decoration:none;
      padding:6px 12px; border-radius:6px; white-space:nowrap;
      transition:filter 0.15s;
    }
    .brk-action.re-login { color:var(--muted-1,#8ba1c2); }
    .brk-action.re-login:hover { color:#60a5fa; }
    .brk-action.login { color:#fff; border:1px solid; }
    .brk-action.login.fyers   { background:#0d3a18; border-color:#1a6030; }
    .brk-action.login.zerodha { background:#1a4a8a; border-color:#2a6aaa; }
    .brk-action.login:hover { filter:brightness(1.15); }
    .brk-action.muted-hint {
      font-size:0.66rem; color:var(--muted-1,#8ba1c2); font-style:italic;
      border:1px dashed #252550; padding:4px 10px; border-radius:6px;
    }
    .brk-expiry {
      font-size:0.7rem; line-height:1.4;
      padding:7px 12px; border-radius:7px; border:1px solid;
    }
    .brk-expiry.expired  { background:#2d1600; border-color:#c05621; color:#f6ad55; }
    .brk-expiry.expiring { background:#2a1600; border-color:#744210; color:#fbd38d; }
    .brk-expiry.valid    { background:#070d14; border-color:#1a3050; color:var(--muted-1,#8ba1c2); }

    /* ── Option expiry quick-edit (mirrors Settings → OPTION_EXPIRY_OVERRIDE /
       OPTION_EXPIRY_TYPE; saves through the same POST /settings/save) ── */
    .brk-cfg {
      display:flex; align-items:center; gap:6px 8px; flex-wrap:wrap;
      padding:5px 12px; border-radius:9px;
      border:1px solid #1a2236; background:#0d1320;
      min-width:0;
    }
    .brk-cfg-label {
      font-size:0.58rem; font-weight:700; text-transform:uppercase; letter-spacing:1px;
      color:var(--muted-1,#8ba1c2); flex:0 0 auto; white-space:nowrap;
    }
    /* max-width keeps the inputs from stretching across the whole strip when it
       spans the full grid width on laptop/tablet. */
    .brk-cfg-field { flex:1 1 116px; min-width:0; max-width:190px; }
    .brk-cfg-input {
      width:100%; min-width:0; color-scheme:dark;
      background:#0a0f18; border:1px solid #243049; color:#c8d8f0;
      border-radius:6px; padding:4px 7px;
      font-size:0.7rem; font-family:inherit;
    }
    .brk-cfg-input:focus { outline:none; border-color:#3b82f6; }
    .brk-cfg-save {
      flex:0 0 auto; margin-left:auto; cursor:pointer; font-family:inherit;
      padding:5px 12px; border-radius:6px; white-space:nowrap;
      background:#0f2540; border:1px solid #1e4a7a; color:#93c5fd;
      font-size:0.7rem; font-weight:700;
      transition:filter 0.15s, transform 0.08s;
    }
    .brk-cfg-save:hover:not(:disabled) { filter:brightness(1.25); }
    .brk-cfg-save:active:not(:disabled) { transform:translateY(1px); }
    .brk-cfg-save:disabled { opacity:0.55; cursor:not-allowed; }
    /* Shown only when a per-mode expiry key shadows the common one — takes the
       whole line so it cannot be mistaken for part of the field row. */
    .brk-cfg-warn {
      flex:1 0 100%; text-decoration:none;
      font-size:0.6rem; font-weight:600; line-height:1.3;
      color:#fbbf24;
    }
    .brk-cfg-warn:hover { text-decoration:underline; }
    /* Touch sizing. At the desktop scale these controls come out 26px tall with
       an 11.2px font, which is both under the 44px tap target and — because iOS
       Safari zooms the whole page when you focus an input whose font-size is
       below 16px — makes tapping the date field yank the layout about. 16px is
       the exact threshold, so it is set literally rather than in rem. */
    @media (max-width:768px) {
      .brk-cfg-input { font-size:16px; padding:9px 10px; min-height:44px; }
      .brk-cfg-save  { font-size:0.85rem; padding:12px 16px; min-height:44px; }
      /* It is a link to Settings, so give it a real tap target too rather than
         a 21px-tall line of text. */
      .brk-cfg-warn  { font-size:0.72rem; line-height:1.5; display:flex; align-items:center; min-height:44px; }
      .brk-cfg-label { font-size:0.62rem; }
      .brk-cfg       { gap:8px; padding:8px 12px; }
      /* Between 641 and 768px the two fields still sit side by side, and the
         190px cap is exactly what let the iOS date control — which will not
         shrink below its intrinsic width — spill out over the select. Cap
         removed, and the basis raised to 260px: that is wider than any
         plausible intrinsic width, so when the strip cannot give both fields
         260px they wrap onto separate full-width lines by themselves instead
         of being squeezed into an overlap. No extra breakpoint needed. */
      .brk-cfg-field { max-width:none; flex:1 1 260px; }
    }
    @media (max-width:640px) {
      .brk-cfg-label { flex:1 0 100%; }
      /* One control per row. Side by side these collided on a real iPhone:
         iOS gives input[type=date] an intrinsic minimum width from its rendered
         text ("Jul 28, 2026") and will not shrink below it however the flex item
         is sized, so the date box grew straight into the type select. Headless
         Chrome renders a narrower date control and never showed it. Stacking
         removes the whole class of problem and gives full-width tap targets. */
      .brk-cfg-field { flex:1 0 100%; max-width:none; min-width:0; }
      .brk-cfg-save  { flex:1 0 100%; }
    }
    :root[data-theme="light"] .brk-cfg-warn { color:#b45309; }
    :root[data-theme="light"] .brk-cfg { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .brk-cfg-label { color:#5c6b7f; }
    :root[data-theme="light"] .brk-cfg-input { color-scheme:light; background:#ffffff; border-color:#e2e8f0; color:#1e293b; }
    :root[data-theme="light"] .brk-cfg-save { background:#dbeafe; border-color:#93c5fd; color:#1d4ed8; }

    /* ── Option expiry override RED alert (full-width, prominent) ── */
    .opt-expiry-alert {
      display:flex; align-items:center; gap:14px;
      padding:12px 16px; border-radius:10px;
      background:linear-gradient(90deg,#2a0508 0%,#1c0610 100%);
      border:1px solid #ef4444; color:#fecaca;
      box-shadow:0 0 0 1px rgba(239,68,68,0.15), 0 4px 14px rgba(239,68,68,0.18);
      animation:pulse-red 2s ease-in-out infinite;
      margin-bottom:0;
    }
    @keyframes pulse-red { 0%,100%{box-shadow:0 0 0 1px rgba(239,68,68,0.15), 0 4px 14px rgba(239,68,68,0.18);} 50%{box-shadow:0 0 0 1px rgba(239,68,68,0.35), 0 6px 22px rgba(239,68,68,0.32);} }
    /* Roll in progress — the same strip in amber, without the alarm: the expiry
       is expired but being repaired, so it reports rather than demands. */
    .opt-expiry-alert.rolling {
      background:linear-gradient(90deg,#2a1a05 0%,#1c1206 100%);
      border-color:#f59e0b; color:#fde68a;
      box-shadow:0 0 0 1px rgba(245,158,11,0.15), 0 4px 14px rgba(245,158,11,0.18);
      animation:none;
    }
    .opt-expiry-alert.rolling .opt-expiry-title { color:#fcd34d; }
    .opt-expiry-alert.rolling .opt-expiry-body  { color:#fde68a; }
    .opt-expiry-icon { font-size:1.4rem; flex-shrink:0; }
    .opt-expiry-text { flex:1; min-width:0; }
    .opt-expiry-title { font-size:0.78rem; font-weight:700; color:#fca5a5; letter-spacing:0.3px; margin-bottom:2px; }
    .opt-expiry-body  { font-size:0.72rem; color:#fecaca; line-height:1.5; }
    .opt-expiry-body strong { color:#fff; }
    .opt-expiry-cta {
      display:inline-flex; align-items:center; gap:4px; flex-shrink:0;
      padding:7px 14px; border-radius:7px;
      background:#dc2626; color:#fff; text-decoration:none;
      font-size:0.75rem; font-weight:700; letter-spacing:0.2px;
      border:1px solid #f87171; transition:filter 0.15s, transform 0.08s;
    }
    .opt-expiry-cta:hover { filter:brightness(1.12); }
    .opt-expiry-cta:active { transform:translateY(1px); }
    @media (max-width:640px) {
      .opt-expiry-alert { flex-direction:column; align-items:flex-start; }
      /* Already full-width here, but it measured 31px tall on a 393px phone —
         under the 44px tap target, and it is the primary action of a blocking
         alert, so it is the one control on this page you least want to fumble. */
      .opt-expiry-cta { width:100%; justify-content:center; min-height:44px; }
    }

    /* Compact utility strip (Start All) */
    .util-strip {
      display:flex; flex-wrap:wrap; align-items:center; gap:6px;
      padding:6px 10px; border-radius:9px;
      border:1px solid #1a2236; background:#0a0f18;
      margin-bottom:0;
    }
    .util-btn {
      display:inline-flex; align-items:center; gap:6px;
      padding:5px 11px; border-radius:6px; cursor:pointer;
      background:#0f1520; border:1px solid #243049; color:#a0b0c8;
      font-size:0.7rem; font-weight:600; font-family:inherit; letter-spacing:0.2px;
      transition:filter 0.15s, transform 0.08s;
    }
    .util-btn:hover:not(:disabled) { filter:brightness(1.2); }
    .util-btn:active:not(:disabled) { transform:translateY(1px); }
    .util-btn:disabled { opacity:0.55; cursor:not-allowed; }
    .util-btn.run-paper { background:#062016; border-color:#166534; color:#4ade80; font-weight:700; }
    .util-btn.run-live  { background:#1f0808; border-color:#7f1d1d; color:#f87171; font-weight:700; }
    /* Active running state — pulsing glow so the user can see the mode is live */
    .util-btn.is-active-paper {
      background:#052e1d !important; border-color:#22c55e !important; color:#86efac !important;
      opacity:1 !important; cursor:default !important;
      animation: pulse-paper 1.8s ease-in-out infinite;
    }
    .util-btn.is-active-live {
      background:#2a0a0a !important; border-color:#ef4444 !important; color:#fca5a5 !important;
      opacity:1 !important; cursor:default !important;
      animation: pulse-live 1.8s ease-in-out infinite;
    }
    .util-btn.is-locked { opacity:0.35 !important; cursor:not-allowed !important; filter:grayscale(0.5); }
    @keyframes pulse-paper {
      0%,100% { box-shadow:0 0 0 0 rgba(34,197,94,0.55); }
      50%     { box-shadow:0 0 0 6px rgba(34,197,94,0); }
    }
    @keyframes pulse-live {
      0%,100% { box-shadow:0 0 0 0 rgba(239,68,68,0.55); }
      50%     { box-shadow:0 0 0 6px rgba(239,68,68,0); }
    }
    :root[data-theme="light"] .util-btn.is-active-paper { background:#dcfce7 !important; border-color:#166534 !important; color:#15803d !important; }
    :root[data-theme="light"] .util-btn.is-active-live  { background:#fee2e2 !important; border-color:#dc2626 !important; color:#b91c1c !important; }
    .util-info { font-size:0.68rem; color:var(--muted-1,#8ba1c2); margin-left:auto; font-family:'IBM Plex Mono',monospace; }

    /* Mobile */
    @media (max-width:640px) {
      .util-strip { flex-direction:column; align-items:stretch; }
      .util-btn { justify-content:center; width:100%; }
      .util-info { margin:4px 0 0; text-align:center; }
      /* Broker rows: status line first, then the login button on its own
         full-width line. Both brokers then look the same (previously Fyers
         squeezed its button onto line 1 and Zerodha pushed a half-width one
         onto line 2), and the button becomes a proper 44px tap target. */
      .brk-row { row-gap:8px; }
      .brk-action.login {
        flex:1 0 100%; display:flex; align-items:center; justify-content:center;
        min-height:44px; font-size:0.8rem;
      }
      .brk-action.re-login { flex:0 0 auto; margin-left:auto; }
    }

    /* Light theme */
    :root[data-theme="light"] .brk-row { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .brk-row.ok   { background:#f0fdf4; border-color:#bbf7d0; }
    :root[data-theme="light"] .brk-row.ok.blue { background:#eff6ff; border-color:#bfdbfe; }
    :root[data-theme="light"] .brk-row.bad  { background:#fef2f2; border-color:#fecaca; }
    :root[data-theme="light"] .brk-row.muted { background:#f8fafc; border-color:#e2e8f0; }
    :root[data-theme="light"] .brk-name { color:#1e293b; }
    :root[data-theme="light"] .brk-wallet-remain { color:#1e293b; }
    :root[data-theme="light"] .brk-wallet-sub { color:#5c6b7f; }
    :root[data-theme="light"] .brk-status { background:#f1f5f9; border-color:#e2e8f0; color:#5c6b7f; }
    :root[data-theme="light"] .brk-row.ok .brk-status { background:#dcfce7; border-color:#86efac; color:#166534; }
    :root[data-theme="light"] .brk-row.ok.blue .brk-status { background:#dbeafe; border-color:#93c5fd; color:#1d4ed8; }
    :root[data-theme="light"] .brk-row.bad .brk-status { background:#fee2e2; border-color:#fca5a5; color:#b91c1c; }
    :root[data-theme="light"] .util-strip { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .util-btn { background:#f8fafc; border-color:#e2e8f0; color:#475569; }
    :root[data-theme="light"] .util-btn.run-paper { background:#dcfce7; border-color:#86efac; color:#166534; }
    :root[data-theme="light"] .util-btn.run-live  { background:#fee2e2; border-color:#fca5a5; color:#b91c1c; }
    :root[data-theme="light"] .util-info { color:#4b5769; }
    /* Light theme — top-bar pills/buttons + broker expiry pill (shared chrome lacks light variants) */
    :root[data-theme="light"] .top-bar-btn { background:#f8fafc; border-color:#e2e8f0; color:#475569; }
    :root[data-theme="light"] .top-bar-btn.run-paper { background:#dcfce7; border-color:#86efac; color:#166534; }
    :root[data-theme="light"] .top-bar-btn.run-live { background:#fee2e2; border-color:#fca5a5; color:#b91c1c; }
    /* Pills that open a popup — the rest of the pills are read-only labels.
       Brightening is invisible on the light theme's near-white pill, so that
       one darkens instead. */
    .top-bar-cache.clickable { cursor:pointer; }
    .top-bar-cache.clickable:hover { filter:brightness(1.25); }
    :root[data-theme="light"] .top-bar-cache.clickable:hover { filter:brightness(0.94); }
    :root[data-theme="light"] .top-bar-cache { background:#f0fdf4; border-color:#bbf7d0; color:#166534; }
    :root[data-theme="light"] .top-bar-cache.empty { background:#f8fafc; border-color:#e2e8f0; color:#4b5769; }
    :root[data-theme="light"] .top-bar-cache.schedule { background:#ecfeff; border-color:#a5f3fc; color:#0e7490; }
    :root[data-theme="light"] .top-bar-cache.schedule.empty { background:#f8fafc; border-color:#e2e8f0; color:#4b5769; }
    :root[data-theme="light"] .top-bar-badge { background:#eff6ff; border-color:#bfdbfe; color:#1d4ed8; }
    :root[data-theme="light"] .top-bar-badge.live-active { background:#fef2f2; border-color:#fca5a5; color:#b91c1c; }
    :root[data-theme="light"] .top-bar-badge.paper-active { background:#f0fdf4; border-color:#bbf7d0; color:#166534; }
    :root[data-theme="light"] .brk-expiry.valid { background:#f8fafc; border-color:#e2e8f0; color:#475569; }
    :root[data-theme="light"] .brk-expiry.expiring { background:#fffbeb; border-color:#fde68a; color:#b45309; }
    :root[data-theme="light"] .brk-expiry.expired { background:#fef2f2; border-color:#fecaca; color:#c2410c; }

    /* ── PER-MODULE START CARDS ── */
    /* ── PER-MODULE P&L CHART CARDS (Paper/Live toggle) ── */
    /* Rows are balanced over the number of VISIBLE cards and the last row is
       never short of full width. Two pieces make that work:
       - --mm-cols is computed in JS (_layoutModuleGrid) as the count spread
         evenly over ceil(count / 4) rows, so 5 cards go 3+2 rather than 4+1 and
         7 go 4+3. Cards are hidden per strategy at runtime, so the count cannot
         be baked in server-side.
       - flex, not grid: grid keeps a short LAST row at the full column width and
         leaves a hole on the right. Flex items grow into whatever the row has
         left, so the trailing 2 or 3 cards widen and the row is flush.
       250px is what a card needs to keep its stats line — "27 trades · 8W/19L ·
       +₹4,910.40" — on one line, so the basis is a max() against that floor:
       once a column would be narrower (phones, narrow splits), the floor wins
       and the cards wrap on their own regardless of --mm-cols. */
    .mm-grid { display:flex; flex-wrap:wrap; gap:10px; --mm-cols:4; }
    /* The 0.5px shaved off the basis is anti-wrap slack: an exact fit
       (cols * basis + gaps == 100%) can round up a fraction of a pixel on a
       fractional container width and bump the last card to its own row. Flex
       grow reclaims the slack immediately, so the cards still fill the row. */
    .mm-grid > .mm-card { flex:1 1 max(250px, calc((100% - (var(--mm-cols) - 1) * 10px) / var(--mm-cols) - 0.5px)); }
    /* Grid and flex items both default to min-width:auto, which can force an
       item wider than its share and overflow the (clipped) page. Let them
       shrink so the grids always reflow to the available width. */
    .mm-grid > *, .da-grid > *, .ts-grid > * { min-width:0; }
    .mm-card { background:#0d1320; border:1px solid #1a2236; border-radius:9px; padding:8px 10px 9px; display:flex; flex-direction:column; }
    .mm-hdr { display:flex; align-items:center; gap:8px; padding-bottom:6px; border-bottom:1px solid #1a2236; margin-bottom:6px; }
    .mm-dot { width:7px; height:7px; border-radius:50%; background:#4a6080; flex-shrink:0; }
    .mm-card.ema_rsi_st    .mm-dot { background:#60a5fa; }
    .mm-card.bb_rsi    .mm-dot { background:#fbbf24; }
    .mm-card.pa       .mm-dot { background:#a78bfa; }
    .mm-card.orb      .mm-dot { background:#10b981; }
    .mm-card.ema9vwap .mm-dot { background:#06b6d4; }
    .mm-card.trendpb  .mm-dot { background:#ec4899; }
    .mm-card.tds      .mm-dot { background:#a855f7; }
    .mm-card.hascalp  .mm-dot { background:#f97316; }
    .mm-card.earlybird .mm-dot { background:#22d3ee; }
    .mm-card.simple930 .mm-dot { background:#fb923c; }
    .mm-card.rsipivotst .mm-dot { background:#c2410c; }
    .mm-title { font-size:0.62rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:#a0b0c8; }
    /* Global Paper/Live source toggle (top-bar) — drives every chart on the dashboard */
    .dash-src-toggle { display:inline-flex; background:#07111f; border:1px solid #1a2236; border-radius:4px; padding:2px; flex-shrink:0; }
    .dst-btn { background:transparent; border:none; color:var(--muted-1,#8ba1c2); font-family:inherit; font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:1px; padding:6px 18px; border-radius:2px; cursor:pointer; transition:all 0.15s; }
    .dst-btn:hover:not(.active) { color:#a0b0c8; }
    .dst-btn.active { background:#2563eb; color:#fff; }
    .dst-btn.active[data-src="live"] { background:#dc2626; color:#fff; }
    :root[data-theme="light"] .dash-src-toggle { background:#f1f5f9; border-color:#e0e4ea; }
    :root[data-theme="light"] .dst-btn { color:#5c6b7f; }
    :root[data-theme="light"] .dst-btn:hover:not(.active) { color:#475569; }
    :root[data-theme="light"] .dst-btn.active { background:#2563eb; color:#fff; }
    :root[data-theme="light"] .dst-btn.active[data-src="live"] { background:#dc2626; color:#fff; }
    /* Global date-range filter (top-bar) — narrows every chart on the dashboard.
       Same option set as Edge Analytics so the two pages agree on what a range
       means; wraps rather than widening the bar when Custom opens its inputs. */
    .dash-range { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; flex-shrink:0; }
    .dash-range label { font-size:0.58rem; text-transform:uppercase; letter-spacing:1px; color:var(--muted-2,#6d85a8); font-family:'IBM Plex Mono',monospace; }
    .dash-range select, .dash-range input { background:#07111f; border:1px solid #1a2236; color:#e0eaf8; padding:5px 8px; border-radius:4px; font-family:'IBM Plex Mono',monospace; font-size:0.7rem; outline:none; max-width:100%; }
    .dash-range select:focus, .dash-range input:focus { border-color:#38bdf8; }
    .dash-range .drg-custom { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; }
    :root[data-theme="light"] .dash-range label { color:#4b5769; }
    :root[data-theme="light"] .dash-range select, :root[data-theme="light"] .dash-range input { background:#f8fafc; border-color:#e0e4ea; color:#334155; }
    .mm-stats { font-size:0.66rem; font-family:'IBM Plex Mono',monospace; color:var(--muted-1,#8ba1c2); margin-bottom:4px; }
    .mm-stats .pnl-pos { color:#10b981; font-weight:700; }
    .mm-stats .pnl-neg { color:#ef4444; font-weight:700; }
    .mm-stats .pnl-flat { color:var(--muted-1,#8ba1c2); font-weight:700; }
    .mm-wrap { position:relative; height:100px; }
    /* The lopsided top padding used to push this line past the empty chart box;
       that box now collapses when there is nothing to draw, so the padding is
       even again. */
    .mm-empty { text-align:center; padding:20px 14px; color:var(--muted-1,#8ba1c2); font-size:0.72rem; }
    :root[data-theme="light"] .mm-card { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .mm-hdr { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .mm-title { color:#475569; }
    :root[data-theme="light"] .mm-stats { color:#5c6b7f; }
    :root[data-theme="light"] .mm-empty { color:#5c6b7f; }

    /* ── TRADE STATUS PANELS ── */
    .ts-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:0; }
    .ts-cell { padding:12px 16px; border-right:1px solid #1a2236; }
    .ts-cell:last-child { border-right:none; }
    .ts-label { font-size:0.52rem; font-weight:600; text-transform:uppercase; letter-spacing:1.4px; color:var(--muted-2,#6d85a8); margin-bottom:5px; }
    .ts-val { font-size:0.95rem; font-weight:700; color:#e0eaf8; }
    .ts-val.pos { color:#4ade80; }
    .ts-val.neg { color:#f87171; }
    .ts-val.flat { color:var(--muted-2,#6d85a8); }
    .ts-sub { font-size:0.62rem; color:var(--muted-2,#6d85a8); margin-top:2px; }
    .ts-pos-bar { margin:10px 18px 0; padding:10px 14px; background:#0a0f14; border:1px solid #1a2a3a; border-radius:8px; display:flex; flex-wrap:wrap; gap:10px 24px; }
    .ts-pos-item { font-size:0.68rem; color:var(--muted-1,#8ba1c2); }
    .ts-pos-item strong { color:#a0c0e0; font-weight:600; }
    .ts-pos-item.pnl-pos strong { color:#4ade80; }
    .ts-pos-item.pnl-neg strong { color:#f87171; }
    .ts-flat-note { font-size:0.72rem; color:var(--muted-2,#6d85a8); font-style:italic; }
    #trade-row, #bb_rsi-row, #pa-row { display:flex; gap:12px; align-items:stretch; width:100%; flex-wrap:nowrap; }
    @media (max-width:900px) { .ts-grid { grid-template-columns:1fr 1fr; } }

    /* cfg-grid removed — config shown as strip in broker card */
    /* cfg-cell/live-note styles removed — config shown as strip in broker card */

    /* ── DASHBOARD LIGHT THEME ── */
    :root[data-theme="light"] body { background:#f4f6f9; color:#334155; }

    /* Cards */
    :root[data-theme="light"] .card { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .card-hdr { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .card-hdr-title { color:#4b5769; }

    /* Broker cards */
    :root[data-theme="light"] .broker-card.connected-green { background:#f0fdf4; border-color:#bbf7d0; color:#166534; }
    :root[data-theme="light"] .broker-card.connected-blue  { background:#eff6ff; border-color:#bfdbfe; color:#1d4ed8; }
    :root[data-theme="light"] .broker-card.error-state     { background:#fef2f2; border-color:#fecaca; color:#b91c1c; }
    :root[data-theme="light"] .broker-card.no-config       { background:#f8fafc; border-color:#e2e8f0; color:#5c6b7f; }
    :root[data-theme="light"] .broker-name { color:#1e293b; }
    :root[data-theme="light"] .broker-role { color:#5c6b7f; }
    :root[data-theme="light"] .broker-meta { color:#4b5769; }
    :root[data-theme="light"] .broker-meta .tag { background:#f1f5f9; border-color:#e0e4ea; color:#4b5769; }
    :root[data-theme="light"] .broker-status-pill.ok-green { background:#dcfce7; border-color:#86efac; color:#166534; }
    :root[data-theme="light"] .broker-status-pill.ok-blue  { background:#dbeafe; border-color:#93c5fd; color:#1d4ed8; }
    :root[data-theme="light"] .broker-status-pill.err      { background:#fee2e2; border-color:#fca5a5; color:#b91c1c; }
    :root[data-theme="light"] .broker-status-pill.grey     { background:#f1f5f9; border-color:#e2e8f0; color:#5c6b7f; }
    :root[data-theme="light"] .broker-logo.fyers-logo  { background:#dcfce7; border-color:#bbf7d0; }
    :root[data-theme="light"] .broker-logo.zerodha-logo { background:#ede9fe; border-color:#c4b5fd; }
    :root[data-theme="light"] .broker-connected-bar.green { background:#dcfce7; border-color:#86efac; color:#166534; }
    :root[data-theme="light"] .broker-connected-bar.blue  { background:#dbeafe; border-color:#93c5fd; color:#1d4ed8; }
    :root[data-theme="light"] .broker-connected-bar .relogin-link { color:#5c6b7f; }
    :root[data-theme="light"] .broker-connected-bar .relogin-link:hover { color:#2563eb; }
    :root[data-theme="light"] .broker-login-btn.fyers-btn  { background:#166534; border-color:#14532d; }
    :root[data-theme="light"] .broker-login-btn.zerodha-btn { background:#2563eb; border-color:#1d4ed8; }
    /* The broker-strip twins of the two buttons above. Their fills are class
       rules, so the light skin's hex rewriter reaches the Fyers green but has
       no entry for the Zerodha navy — it stayed dark while themeJS's
       .brk-action rule pulled the label to #1d4ed8, leaving dark-on-dark.
       Painting both as solid brand buttons matches .broker-login-btn and needs
       !important + this specificity to outrank that .brk-action rule. */
    :root[data-theme="light"] .brk-action.login.fyers   { background:#166534 !important; border-color:#14532d !important; color:#ffffff !important; }
    :root[data-theme="light"] .brk-action.login.zerodha { background:#2563eb !important; border-color:#1d4ed8 !important; color:#ffffff !important; }
    :root[data-theme="light"] .broker-no-config { background:#f8fafc; border-color:#e2e8f0; color:#5c6b7f; }
    :root[data-theme="light"] .broker-no-config code { color:#6366f1; }
    :root[data-theme="light"] .broker-expiry-warn.expired  { background:#fff7ed; border-color:#fdba74; color:#c2410c; }
    :root[data-theme="light"] .broker-expiry-warn.expiring { background:#fffbeb; border-color:#fcd34d; color:#a16207; }
    :root[data-theme="light"] .broker-expiry-warn.valid    { background:#f8fafc; border-color:#e0e4ea; color:#4b5769; }
    :root[data-theme="light"] .broker-divider { background:#e0e4ea; }
    :root[data-theme="light"] .hard-reset-hint { color:#5c6b7f; }
    :root[data-theme="light"] .hard-reset-btn { background:#fef2f2; border-color:#fca5a5; color:#b91c1c; }
    :root[data-theme="light"] .hard-reset-btn:hover { background:#fee2e2; border-color:#dc2626; }

    /* Trade status panels */
    :root[data-theme="light"] .ts-cell { border-right-color:#e0e4ea; }
    :root[data-theme="light"] .ts-label { color:#4b5769; }
    :root[data-theme="light"] .ts-val { color:#1e293b; }
    :root[data-theme="light"] .ts-sub { color:#5c6b7f; }
    :root[data-theme="light"] .ts-pos-bar { background:#f8fafc; border-color:#e0e4ea; }
    :root[data-theme="light"] .ts-pos-item { color:#4b5769; }
    :root[data-theme="light"] .ts-pos-item strong { color:#334155; }
    :root[data-theme="light"] .ts-flat-note { color:#5c6b7f; }

    /* ── CUMULATIVE P&L CHART CARDS (Paper + Live) ── */
    .dash-chart-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .dash-chart-card { background:#0d1320; border:1px solid #1a2236; border-radius:9px; padding:10px 12px 12px; }
    .dash-chart-hdr { display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap; padding-bottom:6px; border-bottom:1px solid #1a2236; }
    .dash-chart-title { display:flex; align-items:center; gap:8px; font-size:0.66rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:#a0b0c8; }
    .dash-chart-dot { width:7px; height:7px; border-radius:50%; display:inline-block; }
    .dash-chart-stats { font-size:0.66rem; font-family:'IBM Plex Mono',monospace; color:var(--muted-1,#8ba1c2); }
    .dash-chart-stats .pnl-pos { color:#10b981; font-weight:700; }
    .dash-chart-stats .pnl-neg { color:#ef4444; font-weight:700; }
    .dash-chart-stats .pnl-flat { color:var(--muted-1,#8ba1c2); font-weight:700; }
    .dash-chart-link { font-size:0.66rem; color:#60a5fa; text-decoration:none; font-weight:600; padding:3px 9px; border-radius:5px; border:1px solid #1a3a6a; background:#080e1a; transition:filter 0.15s; margin-left:auto; }
    .dash-chart-link:hover { filter:brightness(1.25); }
    .dash-chart-wrap { position:relative; height:clamp(140px, 26vh, 360px); }
    .dash-chart-empty { text-align:center; padding:28px 20px; color:var(--muted-1,#8ba1c2); font-size:0.72rem; }
    @media (max-width:900px) { .dash-chart-grid { grid-template-columns:1fr; } }
    :root[data-theme="light"] .dash-chart-card { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .dash-chart-title { color:#475569; }
    :root[data-theme="light"] .dash-chart-stats { color:#5c6b7f; }
    :root[data-theme="light"] .dash-chart-link { background:#eff6ff; border-color:#bfdbfe; color:#1d4ed8; }
    :root[data-theme="light"] .dash-chart-empty { color:#5c6b7f; }

    /* ── Dashboard Analytics Panel (market-hour aware) ── */
    .dash-analytics { background:#0d1320; border:1px solid #1a2236; border-radius:9px; padding:10px 12px 12px; }
    .da-header { display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap; padding-bottom:6px; border-bottom:1px solid #1a2236; }
    .da-title { display:flex; align-items:center; gap:8px; font-size:0.66rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:#a0b0c8; }
    .da-badge { font-size:0.58rem; font-weight:700; padding:2px 8px; border-radius:4px; letter-spacing:0.6px; background:rgba(74,96,128,0.12); color:#a0b0c8; border:1px solid rgba(74,96,128,0.30); }
    .da-badge.live { background:rgba(16,185,129,0.10); color:#10b981; border-color:rgba(16,185,129,0.30); }
    .da-badge.post { background:rgba(59,130,246,0.10); color:#60a5fa; border-color:rgba(59,130,246,0.30); }
    .da-sub { font-size:0.66rem; color:var(--muted-1,#8ba1c2); font-family:'IBM Plex Mono',monospace; margin-left:auto; }
    .da-body { display:flex; flex-direction:column; gap:10px; }
    .da-loading { padding:18px; text-align:center; color:var(--muted-1,#8ba1c2); font-size:0.72rem; }
    .da-grid { display:grid; gap:8px; }
    .da-grid.cols-1 { grid-template-columns:1fr; }
    .da-grid.cols-2 { grid-template-columns:repeat(2, 1fr); }
    .da-grid.cols-3 { grid-template-columns:repeat(3, 1fr); }
    .da-grid.cols-4 { grid-template-columns:repeat(4, 1fr); }
    .da-grid.cols-5 { grid-template-columns:repeat(5, 1fr); }
    .da-grid.cols-6 { grid-template-columns:repeat(6, 1fr); }
    @media (max-width:1100px){ .da-grid.cols-5,.da-grid.cols-6 { grid-template-columns:repeat(3, 1fr); } }
    @media (max-width:900px){ .da-grid.cols-3,.da-grid.cols-4,.da-grid.cols-5,.da-grid.cols-6 { grid-template-columns:1fr 1fr; } }
    @media (max-width:560px){ .da-grid.cols-2,.da-grid.cols-3,.da-grid.cols-4,.da-grid.cols-5,.da-grid.cols-6 { grid-template-columns:1fr; } }
    .da-tile { background:#080e1a; border:1px solid #1a2236; border-radius:7px; padding:9px 11px; min-width:0; }
    .da-tile.ema_rsi_st { border-top:2px solid #3b82f6; }
    .da-tile.bb_rsi { border-top:2px solid #f59e0b; }
    .da-tile.pa    { border-top:2px solid #a78bfa; }
    .da-tile.orb      { border-top:2px solid #10b981; }
    .da-tile.info  { border-top:2px solid #22d3ee; }
    .da-tile-hdr { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:0.6rem; font-weight:700; text-transform:uppercase; letter-spacing:0.6px; color:#7d8aa3; margin-bottom:6px; }
    .da-tile-hdr .da-pill { font-size:0.55rem; padding:1px 7px; border-radius:3px; border:1px solid rgba(74,96,128,0.30); color:#7d8aa3; }
    .da-tile-hdr .da-pill.run { background:rgba(16,185,129,0.10); color:#10b981; border-color:rgba(16,185,129,0.30); }
    .da-tile-hdr .da-pill.stop { background:rgba(148,163,184,0.10); color:#94a3b8; border-color:rgba(148,163,184,0.30); }
    .da-big { font-size:1.2rem; font-weight:700; line-height:1.15; font-variant-numeric:tabular-nums; }
    .da-big.pos { color:#10b981; }
    .da-big.neg { color:#ef4444; }
    .da-big.flat { color:#94a3b8; }
    .da-sub-line { font-size:0.66rem; color:#7d8aa3; margin-top:3px; font-variant-numeric:tabular-nums; font-family:'IBM Plex Mono',monospace; }
    .da-kv { display:flex; align-items:baseline; justify-content:space-between; gap:8px; font-size:0.7rem; padding:3px 0; border-bottom:1px dashed rgba(74,96,128,0.20); }
    .da-kv:last-child { border-bottom:none; }
    .da-kv .k { color:#7d8aa3; }
    .da-kv .v { color:#e0eaf8; font-variant-numeric:tabular-nums; font-family:'IBM Plex Mono',monospace; }
    .da-kv .v.pos { color:#10b981; }
    .da-kv .v.neg { color:#ef4444; }
    .da-empty { padding:14px 12px; text-align:center; color:var(--muted-1,#8ba1c2); font-size:0.72rem; }
    :root[data-theme="light"] .dash-analytics { background:#fff; border-color:#e0e4ea; }
    :root[data-theme="light"] .da-tile { background:#f8fafc; border-color:#e0e4ea; }
    :root[data-theme="light"] .da-title { color:#475569; }
    :root[data-theme="light"] .da-sub { color:#5c6b7f; }
    :root[data-theme="light"] .da-tile-hdr { color:#4b5769; }
    :root[data-theme="light"] .da-kv .v { color:#1e293b; }
    :root[data-theme="light"] .da-kv .k { color:#4b5769; }

    /* ── MOBILE ── */
    @media (max-width:640px) {
      .main-content { margin-left:0; }
      .page { padding:12px 10px 40px; gap:10px; }
      .broker-grid { grid-template-columns:1fr; }
      .ts-grid     { grid-template-columns:1fr 1fr; }
      /* 3-col action row stacks to 1 col on mobile */
      .action-3col { grid-template-columns:1fr !important; }
      /* trade-row + bb_rsi-row + pa-row: stack vertically */
      #trade-row, #bb_rsi-row, #pa-row { flex-wrap:wrap; }
      #trade-row .card, #bb_rsi-row .card, #pa-row .card { width:100%; flex:none; }
      /* top-bar: hide meta on mobile */
      .top-bar-meta { display:none; }
      .top-bar { padding:7px 10px 7px 48px; }
    }
    /* ── LAPTOP / SMALL-DESKTOP BAND (13" MacBook etc.) ──
       The desktop layout (fixed 200px sidebar) leaves a narrow content column
       here, but the phone breakpoints don't start until 768px. Stack the
       side-by-side strategy rows so they shrink cleanly instead of overflowing
       the clipped (overflow-x:hidden) body. */
    @media (max-width:1200px) {
      .broker-grid { grid-template-columns:1fr; }
      #trade-row, #bb_rsi-row, #pa-row { flex-wrap:wrap; }
      #trade-row .card, #bb_rsi-row .card, #pa-row .card { width:100%; flex:none; }
    }
    /* Dashboard top bar — DESKTOP ONLY (below 768px the shared phone rules own
       it, and pinning the bar there once put Start All, the expiry/holiday
       pills and the status badge off screen behind .main-content's
       overflow-x:clip).
       This used to force the whole bar onto one line (flex-wrap:nowrap +
       flex-shrink:0 on the right-hand group) and hand the leftovers to
       overflow-x:auto. The bar's natural width is ~1350px, so anything under a
       ~1600px viewport parked the expiry/holiday pills and the status badge
       inside a scroller — and with no visible scrollbar on a trackpad that
       reads as "the badges are gone", which is what a 13"/14" MacBook saw.
       Wrapping is the honest version: the bar still renders as one line
       whenever one line fits (nothing changes on a 1920px screen), and drops
       the right-hand group onto a second line only when it genuinely cannot,
       instead of hiding it. row-gap keeps the two lines from touching. */
    @media (min-width:769px) {
      .top-bar { flex-wrap:wrap; row-gap:6px; }
      .top-bar > div:first-child { flex-shrink:0; }
      .top-bar-meta { white-space:nowrap; }
    }
    /* Phone: let every top-bar group wrap onto its own line and fill the width.
       min-width:0 is what actually lets the group shrink — a flex item's
       automatic minimum size would otherwise hold it at its content width even
       with wrapping enabled. */
    @media (max-width:768px) {
      .top-bar { flex-wrap:wrap; overflow-x:clip; row-gap:6px; }
      .top-bar > div:first-child { flex:1 1 auto; min-width:0; }
      .top-bar-right {
        flex:1 1 100%; min-width:0; flex-wrap:wrap;
        justify-content:flex-start; gap:6px;
      }
      .top-bar-right .top-bar-btn { flex:1 1 auto; justify-content:center; }
      .dash-src-toggle { flex:0 0 auto; }
      .dash-range { flex:0 0 auto; }
      /* The expiry/holiday pills carry a full sentence and are white-space:nowrap
         in sharedNav, so at 320px (iPhone SE) they alone still ran 11px past the
         edge. Let them wrap rather than widen the bar. */
      .top-bar-right .top-bar-cache { max-width:100%; min-width:0; white-space:normal; }
      /* Same problem, different pill: the trading-status pill ("Weekend —
         markets resume Monday 9:15 AM") is built in JS and its inner box carries
         an INLINE white-space:nowrap, so at 320px it ran 45px past the edge and
         took its dismiss ✕ behind .main-content's overflow-x:clip with it — the
         one control that closes the pill, unreachable. The inline style is why
         this needs !important. */
      #trading-status-alert { max-width:100%; min-width:0; }
      #trading-status-alert > div { max-width:100%; white-space:normal !important; }
    }
    ${modalCSS()}
    ${expiryHolidayModalCSS()}
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('dashboard', liveActive)}
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">⌂ Dashboard</div>
    </div>
    <div class="dash-src-toggle" id="dashSrcToggle" title="Data source for all charts">
      <button type="button" class="dst-btn active" data-src="paper">PAPER</button>
      <button type="button" class="dst-btn" data-src="live">LIVE</button>
    </div>
    <div class="dash-range" id="dashRange" title="Date range for all charts">
      <label for="dashRangeSel">Range</label>
      <select id="dashRangeSel">${dateRangeOptionsHTML('tm')}</select>
      <span class="drg-custom" id="dashRangeCustom" style="display:none;">
        <input type="date" id="dashRangeFrom" title="From date (inclusive)"/>
        <input type="date" id="dashRangeTo" title="To date (inclusive)"/>
      </span>
    </div>
    <div class="top-bar-right">
      ${anyModeActive ? '' : `
      <button id="btn-all-harness" class="top-bar-btn" style="border-color:#b45309;color:#f59e0b;" onclick="startAllHarness(this)" title="Start all Live (Harness) modes in DRY-RUN — runs Paper + logs would-be broker orders (${startAllModes.map((m) => m.label).join(' + ') || 'no strategy enabled'})">🧪 Start All (Harness)</button>
      <button id="btn-all-start" class="top-bar-btn run-paper" onclick="startAll(this)" title="Start all paper modes">▶ Start All (Paper)</button>`}
      <!-- The manual "Reset Token" button was removed: token clearing is now
           automatic (4:00 PM + 7:00 AM IST schedulers, and the login routes
           wipe any DISCONNECTED broker's saved token before starting OAuth).
           POST /admin/reset still exists for the rare stuck-socket case. -->
      <!-- Expiry / holiday pills stay outside the idle-only block: which expiry is
           next matters most while a session is running. Click opens the shared
           NIFTY Expiry & NSE Holidays calendar (same popup as Settings). -->
      <span id="expiry-info-pill" class="top-bar-cache schedule empty clickable" title="Next NIFTY weekly/monthly expiry — click for the full expiry calendar" onclick="showExpiryHolidaysModal()"></span>
      <span id="holiday-info-pill" class="top-bar-cache schedule empty clickable" title="Next NSE trading holiday — click for the full holiday list" onclick="showExpiryHolidaysModal()"></span>
      <div id="trading-status-alert" style="display:none;position:relative;"></div>
      ${liveActive ? '<span class="top-bar-badge live-active"><span style="width:5px;height:5px;border-radius:50%;background:#ef4444;display:inline-block;"></span>LIVE ACTIVE</span>' : ''}
      ${bbRsiModeOn && bbRsiMode === 'BB_RSI_LIVE' ? '<span class="top-bar-badge live-active" style="border-color:#f59e0b;"><span style="width:5px;height:5px;border-radius:50%;background:#f59e0b;display:inline-block;"></span>BB_RSI LIVE</span>' : ''}
      ${paModeOn && paMode === 'PA_LIVE' ? '<span class="top-bar-badge live-active" style="border-color:#a78bfa;"><span style="width:5px;height:5px;border-radius:50%;background:#a78bfa;display:inline-block;"></span>PA LIVE</span>' : ''}
      ${orbModeOn && orbMode === 'ORB_PAPER' ? '<span class="top-bar-badge live-active" style="border-color:#10b981;"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>ORB PAPER</span>' : ''}
      ${anyModeActive && !specificBadgeShown ? '<span class="top-bar-badge live-active" style="border-color:#22c55e;"><span style="width:5px;height:5px;border-radius:50%;background:#22c55e;display:inline-block;"></span>TRADE ACTIVE</span>' : ''}
    </div>
  </div>

<div class="page">

  ${optionExpiryAlertHtml}

  <!-- ① BROKER CONNECTIONS — compact single-line rows (hidden while a trade runs).
       The option-expiry quick-edit shares this grid row so it costs no extra
       height, and hides with the rest of the controls mid-trade: switching the
       expiry would change the contract the engine resolves for its next entry,
       which is exactly what this block is hidden to prevent. Settings remains
       reachable if it genuinely has to be changed during a session. -->
  ${anyModeActive ? '' : `
  <div class="brokers">
    <div class="brk-row ${fyersOk ? 'ok' : 'bad'}">
      <span class="brk-dot ${fyersOk ? 'pulse' : ''}"></span>
      <span class="brk-name">Fyers</span>
      ${fyersWalletHtml}
      <span class="brk-status">${fyersOk ? 'Connected' : 'Disconnected'}</span>
      ${fyersOk
        ? `<a href="/auth/login" class="brk-action re-login">re-login →</a>`
        : `<a href="/auth/login" class="brk-action login fyers">🔐 Login with Fyers</a>`}
    </div>
    <div class="brk-row ${zerodhaOk ? 'ok blue' : zerodhaConf ? 'bad' : 'muted'}">
      <span class="brk-dot ${zerodhaOk ? 'pulse' : ''}"></span>
      <span class="brk-name">Zerodha</span>
      ${zerodhaWalletHtml}
      <span class="brk-status">${zerodhaOk ? 'Connected' : zerodhaConf ? 'Disconnected' : 'Not Configured'}</span>
      ${zerodhaOk
        ? `<a href="/auth/zerodha/login" class="brk-action re-login">re-login →</a>`
        : zerodhaConf
          ? `<a href="/auth/zerodha/login" class="brk-action login zerodha">🔐 Login with Zerodha</a>`
          : `<span class="brk-action muted-hint">Set ZERODHA_API_KEY in .env</span>`}
    </div>
    <div class="brk-cfg">
      <span class="brk-cfg-label" title="OPTION_EXPIRY_OVERRIDE / OPTION_EXPIRY_TYPE — the same keys as Settings. One common expiry for every strategy. Blank = auto-detect.">⏱ Expiry</span>
      <span class="brk-cfg-field">
        <input type="date" id="dashExpiryDate" class="brk-cfg-input" value="${dashExpiryDate}"
               title="Option Expiry (manual). Blank = auto-detect."/>
      </span>
      <span class="brk-cfg-field">
        <select id="dashExpiryType" class="brk-cfg-input" title="Weekly = Tuesday expiry. Monthly = last Tuesday of the month (getLastTuesdayOfMonth), or the preponed date when NSE moves it.">
          <option value="weekly"${dashExpiryType === 'weekly' ? ' selected' : ''}>weekly</option>
          <option value="monthly"${dashExpiryType === 'monthly' ? ' selected' : ''}>monthly</option>
        </select>
      </span>
      <button type="button" class="brk-cfg-save" onclick="saveDashExpiry(this)" title="Save both keys to .env (same as Settings save)">Save</button>
    </div>
    ${zerodhaOk && zerodhaExpiryHtml ? `<div class="brk-expiry ${pastExpiry ? 'expired' : nearExpiry ? 'expiring' : 'valid'}">${zerodhaExpiryHtml}</div>` : ''}
  </div>`}

  <!-- (utility buttons moved to top-bar-right; cache pill + schedule pills also live there) -->

  <!-- ③ PER-MODULE CUMULATIVE P&L CHARTS (top-bar Paper/Live toggle + Range filter) -->
  <!-- Cards are hidden client-side unless the strategy actually traded in the
       selected source/range — see _renderModuleChart. -->
  <div class="mm-grid" id="mmGrid">
    <div class="mm-card ema_rsi_st" data-mode="EMA_RSI_ST">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">EMA_RSI_ST</span>
      </div>
      <div class="mm-stats" id="mm-stats-EMA_RSI_ST">—</div>
      <div class="mm-wrap"><canvas id="mmChart-EMA_RSI_ST"></canvas></div>
      <div class="mm-empty" id="mm-empty-EMA_RSI_ST" style="display:none;">No paper trades yet</div>
    </div>
    ${bbRsiModeOn ? `
    <div class="mm-card bb_rsi" data-mode="BB_RSI">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">BB_RSI</span>
      </div>
      <div class="mm-stats" id="mm-stats-BB_RSI">—</div>
      <div class="mm-wrap"><canvas id="mmChart-BB_RSI"></canvas></div>
      <div class="mm-empty" id="mm-empty-BB_RSI" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
    ${paModeOn ? `
    <div class="mm-card pa" data-mode="PA">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">Price Action</span>
      </div>
      <div class="mm-stats" id="mm-stats-PA">—</div>
      <div class="mm-wrap"><canvas id="mmChart-PA"></canvas></div>
      <div class="mm-empty" id="mm-empty-PA" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
    ${orbModeOn ? `
    <div class="mm-card orb" data-mode="ORB">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">ORB</span>
      </div>
      <div class="mm-stats" id="mm-stats-ORB">—</div>
      <div class="mm-wrap"><canvas id="mmChart-ORB"></canvas></div>
      <div class="mm-empty" id="mm-empty-ORB" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
    ${ema9vwapModeOn ? `
    <div class="mm-card ema9vwap" data-mode="EMA9VWAP">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">EMA9+VWAP</span>
      </div>
      <div class="mm-stats" id="mm-stats-EMA9VWAP">—</div>
      <div class="mm-wrap"><canvas id="mmChart-EMA9VWAP"></canvas></div>
      <div class="mm-empty" id="mm-empty-EMA9VWAP" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
    ${trendPbModeOn ? `
    <div class="mm-card trendpb" data-mode="TREND_PB">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">TREND PB</span>
      </div>
      <div class="mm-stats" id="mm-stats-TREND_PB">—</div>
      <div class="mm-wrap"><canvas id="mmChart-TREND_PB"></canvas></div>
      <div class="mm-empty" id="mm-empty-TREND_PB" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
    ${tdsModeOn ? `
    <div class="mm-card tds" data-mode="TDS">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">TREND DAY SCALP</span>
      </div>
      <div class="mm-stats" id="mm-stats-TDS">—</div>
      <div class="mm-wrap"><canvas id="mmChart-TDS"></canvas></div>
      <div class="mm-empty" id="mm-empty-TDS" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
    ${haScalpModeOn ? `
    <div class="mm-card hascalp" data-mode="HA_SCALP">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">HA SCALP</span>
      </div>
      <div class="mm-stats" id="mm-stats-HA_SCALP">—</div>
      <div class="mm-wrap"><canvas id="mmChart-HA_SCALP"></canvas></div>
      <div class="mm-empty" id="mm-empty-HA_SCALP" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
    ${earlyBirdModeOn ? `
    <div class="mm-card earlybird" data-mode="EARLYBIRD">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">EARLYBIRD</span>
      </div>
      <div class="mm-stats" id="mm-stats-EARLYBIRD">—</div>
      <div class="mm-wrap"><canvas id="mmChart-EARLYBIRD"></canvas></div>
      <div class="mm-empty" id="mm-empty-EARLYBIRD" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
    ${simple930ModeOn ? `
    <div class="mm-card simple930" data-mode="SIMPLE930">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">SIMPLE_9:30</span>
      </div>
      <div class="mm-stats" id="mm-stats-SIMPLE930">—</div>
      <div class="mm-wrap"><canvas id="mmChart-SIMPLE930"></canvas></div>
      <div class="mm-empty" id="mm-empty-SIMPLE930" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
    ${rsiPivotStModeOn ? `
    <div class="mm-card rsipivotst" data-mode="RSI_PIVOT_ST">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">RSI PIVOT ST</span>
      </div>
      <div class="mm-stats" id="mm-stats-RSI_PIVOT_ST">—</div>
      <div class="mm-wrap"><canvas id="mmChart-RSI_PIVOT_ST"></canvas></div>
      <div class="mm-empty" id="mm-empty-RSI_PIVOT_ST" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
  </div>
  <div class="mm-card mm-grid-empty" id="mmGridEmpty" style="display:none;">
    <div class="mm-empty" id="mmGridEmptyTxt">No trades yet</div>
  </div>

  <!-- ⑤ CUMULATIVE P&L CHART (top-bar Paper/Live toggle + Range filter) — full-width band below the strategy grid -->
  ${cumCardBelow}

  ${analyticsPanelOn ? `
  <!-- ⑥ Dashboard analytics panel — market-hour aware -->
  <div id="dashAnalytics" class="dash-analytics" style="margin-top:14px;">
    <div class="da-header">
      <div class="da-title"><span id="da-mode-badge" class="da-badge">—</span><span id="da-title-txt">Analytics</span></div>
      <div class="da-sub" id="da-sub-txt">Loading…</div>
    </div>
    <div id="da-body" class="da-body">
      <div class="da-loading">Loading analytics…</div>
    </div>
  </div>` : ''}

</div>

${expiryHolidayModalHTML()}

<script>
${modalJS()}
${expiryHolidayModalJS()}
${dateRangeJS()}
// ── Dashboard: Paper & Live trade status panels ──────────────────────────────
function fmtPnl(v){ if(v===null||v===undefined) return {txt:'—',cls:'flat'}; var n=parseFloat(v); return {txt:(n>=0?'+':'')+'\u20b9'+n.toFixed(0),cls:n>0?'pos':n<0?'neg':'flat'}; }
function fmtNum(v,prefix,suffix){ if(v===null||v===undefined) return '—'; return (prefix||'')+v+(suffix||''); }

function renderPaperStatus(d){
  var rb=document.getElementById('paper-run-badge'), sb=document.getElementById('paper-stop-badge');
  if(rb&&sb){ rb.style.display=d.running?'inline':'none'; sb.style.display=d.running?'none':'inline'; }
  var pnl=fmtPnl(d.sessionPnl), upnl=fmtPnl(d.unrealisedPnl);
  var posHtml='';
  if(d.position){
    var p=d.position, pp=fmtPnl(p.optPremiumPnl!=null?p.optPremiumPnl:d.unrealisedPnl);
    posHtml='<div class="ts-pos-bar">'
      +'<span class="ts-pos-item"><strong>'+p.side+'</strong> &nbsp;'+p.symbol+'</span>'
      +'<span class="ts-pos-item">Entry Spot <strong>\u20b9'+(p.entryPrice||'—')+'</strong></span>'
      +(p.optionEntryLtp?'<span class="ts-pos-item">Opt Entry <strong>\u20b9'+p.optionEntryLtp+'</strong></span>':'')
      +(p.optionCurrentLtp?'<span class="ts-pos-item">Opt LTP <strong>\u20b9'+p.optionCurrentLtp+'</strong></span>':'')
      +'<span class="ts-pos-item '+(pp.cls==='pos'?'pnl-pos':pp.cls==='neg'?'pnl-neg':'')+'">Unrealised <strong>'+pp.txt+'</strong></span>'
      +(p.stopLoss?'<span class="ts-pos-item">SL <strong>\u20b9'+p.stopLoss+'</strong></span>':'')
      +'</div>';
  } else if(d.running){
    posHtml='<div style="padding:8px 18px 0;"><span class="ts-flat-note">Flat — watching for signal</span></div>';
  }
  var capital=d.capital!=null?'\u20b9'+parseFloat(d.capital).toFixed(0):'—';
  document.getElementById('paper-status-body').innerHTML=
    '<div class="ts-grid">'
    +'<div class="ts-cell"><div class="ts-label">Session PnL</div><div class="ts-val '+pnl.cls+'">'+pnl.txt+'</div><div class="ts-sub">'+d.tradeCount+' trades · '+(d.wins||0)+'W/'+(d.losses||0)+'L</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Unrealised PnL</div><div class="ts-val '+upnl.cls+'">'+upnl.txt+'</div><div class="ts-sub">'+(d.pnlSource||'—')+'</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Capital</div><div class="ts-val">'+capital+'</div><div class="ts-sub">Simulated</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Total PnL (all-time)</div><div class="ts-val '+fmtPnl(d.totalPnl).cls+'">'+fmtPnl(d.totalPnl).txt+'</div><div class="ts-sub">From saved data</div></div>'
    +'</div>'
    +posHtml;
}

function renderLiveStatus(d){
  var rb=document.getElementById('live-run-badge'), sb=document.getElementById('live-stop-badge');
  if(rb&&sb){ rb.style.display=d.running?'inline':'none'; sb.style.display=d.running?'none':'inline'; }
  var pnl=fmtPnl(d.sessionPnl), upnl=fmtPnl(d.unrealisedPnl);
  var posHtml='';
  if(d.position){
    var p=d.position, pp=fmtPnl(p.optPremiumPnl!=null?p.optPremiumPnl:d.unrealisedPnl);
    posHtml='<div class="ts-pos-bar">'
      +'<span class="ts-pos-item"><strong>'+p.side+'</strong> &nbsp;'+p.symbol+'</span>'
      +'<span class="ts-pos-item">Entry Spot <strong>\u20b9'+(p.entryPrice||'—')+'</strong></span>'
      +(p.optionEntryLtp?'<span class="ts-pos-item">Opt Entry <strong>\u20b9'+p.optionEntryLtp+'</strong></span>':'')
      +(p.optionCurrentLtp?'<span class="ts-pos-item">Opt LTP <strong>\u20b9'+p.optionCurrentLtp+'</strong></span>':'')
      +'<span class="ts-pos-item '+(pp.cls==='pos'?'pnl-pos':pp.cls==='neg'?'pnl-neg':'')+'">Opt Premium PnL <strong>'+pp.txt+'</strong></span>'
      +(p.stopLoss?'<span class="ts-pos-item">SL <strong>\u20b9'+p.stopLoss+'</strong></span>':'')
      +(p.orderId?'<span class="ts-pos-item">Order <strong>'+p.orderId+'</strong></span>':'')
      +'</div>';
  } else if(d.running){
    posHtml='<div style="padding:8px 18px 0;"><span class="ts-flat-note">Flat — watching for signal</span></div>';
  }
  var fyers=d.fyersOk?'<span style="color:#4ade80;">●</span> Fyers':'<span style="color:#f87171;">●</span> Fyers';
  var zerodha=d.zerodhaOk?'<span style="color:#4ade80;">●</span> Zerodha':'<span style="color:#f87171;">●</span> Zerodha';
  document.getElementById('live-status-body').innerHTML=
    '<div class="ts-grid">'
    +'<div class="ts-cell"><div class="ts-label">Session PnL</div><div class="ts-val '+pnl.cls+'">'+pnl.txt+'</div><div class="ts-sub">'+d.tradeCount+' trades · '+(d.wins||0)+'W/'+(d.losses||0)+'L</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Opt Premium PnL</div><div class="ts-val '+upnl.cls+'">'+upnl.txt+'</div><div class="ts-sub">Unrealised</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Activity</div><div class="ts-val" style="font-size:0.75rem;">'+fyers+' &nbsp; '+zerodha+'</div><div class="ts-sub">Broker connections</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Ticks / Candles</div><div class="ts-val flat" style="font-size:0.82rem;">'+(d.tickCount||0)+' / '+(d.candleCount||0)+'</div><div class="ts-sub">This session</div></div>'
    +'</div>'
    +posHtml;
}

${paModeOn ? `
function renderPAPaperStatus(d){
  var rb=document.getElementById('pa-paper-run-badge'), sb=document.getElementById('pa-paper-stop-badge');
  if(rb&&sb){ rb.style.display=d.running?'inline':'none'; sb.style.display=d.running?'none':'inline'; }
  var _u=(d.unrealisedPnl!=null)?d.unrealisedPnl:d.unrealised;
  var pnl=fmtPnl(d.sessionPnl), upnl=fmtPnl(_u);
  var posHtml='';
  if(d.position){
    var p=d.position, pp=fmtPnl(p.optPremiumPnl!=null?p.optPremiumPnl:_u);
    posHtml='<div class="ts-pos-bar">'
      +'<span class="ts-pos-item"><strong>'+p.side+'</strong> &nbsp;'+p.symbol+'</span>'
      +'<span class="ts-pos-item">Entry Spot <strong>\\u20b9'+(p.entryPrice||'—')+'</strong></span>'
      +(p.optionEntryLtp?'<span class="ts-pos-item">Opt Entry <strong>\\u20b9'+p.optionEntryLtp+'</strong></span>':'')
      +(p.optionCurrentLtp?'<span class="ts-pos-item">Opt LTP <strong>\\u20b9'+p.optionCurrentLtp+'</strong></span>':'')
      +'<span class="ts-pos-item '+(pp.cls==='pos'?'pnl-pos':pp.cls==='neg'?'pnl-neg':'')+'">Unrealised <strong>'+pp.txt+'</strong></span>'
      +(p.stopLoss?'<span class="ts-pos-item">SL <strong>\\u20b9'+p.stopLoss+'</strong></span>':'')
      +'</div>';
  } else if(d.running){
    posHtml='<div style="padding:8px 18px 0;"><span class="ts-flat-note">Flat — watching for signal</span></div>';
  }
  var capital=d.capital!=null?'\\u20b9'+parseFloat(d.capital).toFixed(0):'—';
  document.getElementById('pa-paper-status-body').innerHTML=
    '<div class="ts-grid">'
    +'<div class="ts-cell"><div class="ts-label">Session PnL</div><div class="ts-val '+pnl.cls+'">'+pnl.txt+'</div><div class="ts-sub">'+d.tradeCount+' trades · '+(d.wins||0)+'W/'+(d.losses||0)+'L</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Unrealised PnL</div><div class="ts-val '+upnl.cls+'">'+upnl.txt+'</div><div class="ts-sub">Price Action</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Capital</div><div class="ts-val">'+capital+'</div><div class="ts-sub">Simulated</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Total PnL (all-time)</div><div class="ts-val '+fmtPnl(d.totalPnl).cls+'">'+fmtPnl(d.totalPnl).txt+'</div><div class="ts-sub">From saved data</div></div>'
    +'</div>'
    +posHtml;
}

function renderPALiveStatus(d){
  var rb=document.getElementById('pa-live-run-badge'), sb=document.getElementById('pa-live-stop-badge');
  if(rb&&sb){ rb.style.display=d.running?'inline':'none'; sb.style.display=d.running?'none':'inline'; }
  var _u=(d.unrealisedPnl!=null)?d.unrealisedPnl:d.unrealised;
  var pnl=fmtPnl(d.sessionPnl), upnl=fmtPnl(_u);
  var posHtml='';
  if(d.position){
    var p=d.position, pp=fmtPnl(p.optPremiumPnl!=null?p.optPremiumPnl:_u);
    posHtml='<div class="ts-pos-bar">'
      +'<span class="ts-pos-item"><strong>'+p.side+'</strong> &nbsp;'+p.symbol+'</span>'
      +'<span class="ts-pos-item">Entry <strong>\\u20b9'+(p.entryPrice||'—')+'</strong></span>'
      +(p.optionEntryLtp?'<span class="ts-pos-item">Opt Entry <strong>\\u20b9'+p.optionEntryLtp+'</strong></span>':'')
      +(p.optionCurrentLtp?'<span class="ts-pos-item">Opt LTP <strong>\\u20b9'+p.optionCurrentLtp+'</strong></span>':'')
      +'<span class="ts-pos-item '+(pp.cls==='pos'?'pnl-pos':pp.cls==='neg'?'pnl-neg':'')+'">P&L <strong>'+pp.txt+'</strong></span>'
      +(p.stopLoss?'<span class="ts-pos-item">SL <strong>\\u20b9'+p.stopLoss+'</strong></span>':'')
      +'</div>';
  } else if(d.running){
    posHtml='<div style="padding:8px 18px 0;"><span class="ts-flat-note">Flat — watching for signal</span></div>';
  }
  document.getElementById('pa-live-status-body').innerHTML=
    '<div class="ts-grid">'
    +'<div class="ts-cell"><div class="ts-label">Session PnL</div><div class="ts-val '+pnl.cls+'">'+pnl.txt+'</div><div class="ts-sub">'+d.tradeCount+' trades · '+(d.wins||0)+'W/'+(d.losses||0)+'L</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Opt Premium PnL</div><div class="ts-val '+upnl.cls+'">'+upnl.txt+'</div><div class="ts-sub">Unrealised</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Activity</div><div class="ts-val flat" style="font-size:0.82rem;">'+(d.tickCount||0)+' / '+(d.candleCount||0)+'</div><div class="ts-sub">Ticks / Candles</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Daily Loss</div><div class="ts-val flat" style="font-size:0.78rem;color:'+(d.dailyLossHit?'#ef4444':'#10b981')+';">'+(d.dailyLossHit?'KILLED':'OK')+'</div><div class="ts-sub">Price Action</div></div>'
    +'</div>'
    +posHtml;
}
` : ''}
${bbRsiModeOn ? `
function renderBbRsiPaperStatus(d){
  var rb=document.getElementById('bb_rsi-paper-run-badge'), sb=document.getElementById('bb_rsi-paper-stop-badge');
  if(rb&&sb){ rb.style.display=d.running?'inline':'none'; sb.style.display=d.running?'none':'inline'; }
  var pnl=fmtPnl(d.sessionPnl), upnl=fmtPnl(d.unrealisedPnl);
  var posHtml='';
  if(d.position){
    var p=d.position, pp=fmtPnl(p.optPremiumPnl!=null?p.optPremiumPnl:d.unrealisedPnl);
    posHtml='<div class="ts-pos-bar">'
      +'<span class="ts-pos-item"><strong>'+p.side+'</strong> &nbsp;'+p.symbol+'</span>'
      +'<span class="ts-pos-item">Entry <strong>\\u20b9'+(p.entryPrice||'—')+'</strong></span>'
      +'<span class="ts-pos-item '+(pp.cls==='pos'?'pnl-pos':pp.cls==='neg'?'pnl-neg':'')+'">P&L <strong>'+pp.txt+'</strong></span>'
      +(p.stopLoss?'<span class="ts-pos-item">SL <strong>\\u20b9'+p.stopLoss+'</strong></span>':'')
      +'</div>';
  } else if(d.running){
    posHtml='<div style="padding:8px 18px 0;"><span class="ts-flat-note">Flat — watching for signal</span></div>';
  }
  var capital=d.capital!=null?'\\u20b9'+parseFloat(d.capital).toFixed(0):'—';
  document.getElementById('bb_rsi-paper-status-body').innerHTML=
    '<div class="ts-grid">'
    +'<div class="ts-cell"><div class="ts-label">Session PnL</div><div class="ts-val '+pnl.cls+'">'+pnl.txt+'</div><div class="ts-sub">'+d.tradeCount+' trades · '+(d.wins||0)+'W/'+(d.losses||0)+'L</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Unrealised PnL</div><div class="ts-val '+upnl.cls+'">'+upnl.txt+'</div><div class="ts-sub">spot proxy</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Capital</div><div class="ts-val">'+capital+'</div><div class="ts-sub">Simulated</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Total PnL (all-time)</div><div class="ts-val '+fmtPnl(d.totalPnl).cls+'">'+fmtPnl(d.totalPnl).txt+'</div><div class="ts-sub">From saved data</div></div>'
    +'</div>'
    +posHtml;
}

function renderBbRsiLiveStatus(d){
  var rb=document.getElementById('bb_rsi-live-run-badge'), sb=document.getElementById('bb_rsi-live-stop-badge');
  if(rb&&sb){ rb.style.display=d.running?'inline':'none'; sb.style.display=d.running?'none':'inline'; }
  var pnl=fmtPnl(d.sessionPnl), upnl=fmtPnl(d.unrealisedPnl);
  var posHtml='';
  if(d.position){
    var p=d.position, pp=fmtPnl(p.optPremiumPnl!=null?p.optPremiumPnl:d.unrealisedPnl);
    posHtml='<div class="ts-pos-bar">'
      +'<span class="ts-pos-item"><strong>'+p.side+'</strong> &nbsp;'+p.symbol+'</span>'
      +'<span class="ts-pos-item">Entry <strong>\\u20b9'+(p.entryPrice||'—')+'</strong></span>'
      +(p.optionEntryLtp?'<span class="ts-pos-item">Opt Entry <strong>\\u20b9'+p.optionEntryLtp+'</strong></span>':'')
      +(p.optionCurrentLtp?'<span class="ts-pos-item">Opt LTP <strong>\\u20b9'+p.optionCurrentLtp+'</strong></span>':'')
      +'<span class="ts-pos-item '+(pp.cls==='pos'?'pnl-pos':pp.cls==='neg'?'pnl-neg':'')+'">P&L <strong>'+pp.txt+'</strong></span>'
      +(p.stopLoss?'<span class="ts-pos-item">SL <strong>\\u20b9'+p.stopLoss+'</strong></span>':'')
      +'</div>';
  } else if(d.running){
    posHtml='<div style="padding:8px 18px 0;"><span class="ts-flat-note">Flat — watching for signal</span></div>';
  }
  document.getElementById('bb_rsi-live-status-body').innerHTML=
    '<div class="ts-grid">'
    +'<div class="ts-cell"><div class="ts-label">Session PnL</div><div class="ts-val '+pnl.cls+'">'+pnl.txt+'</div><div class="ts-sub">'+d.tradeCount+' trades · '+(d.wins||0)+'W/'+(d.losses||0)+'L</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Opt Premium PnL</div><div class="ts-val '+upnl.cls+'">'+upnl.txt+'</div><div class="ts-sub">Unrealised</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Activity</div><div class="ts-val flat" style="font-size:0.82rem;">'+(d.tickCount||0)+' / '+(d.candleCount||0)+'</div><div class="ts-sub">Ticks / Candles</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Daily Loss</div><div class="ts-val flat" style="font-size:0.78rem;color:'+(d.dailyLossHit?'#ef4444':'#10b981')+';">'+(d.dailyLossHit?'KILLED':'OK')+'</div><div class="ts-sub">Limit: \\u20b9${process.env.BB_RSI_MAX_DAILY_LOSS || "2000"}</div></div>'
    +'</div>'
    +posHtml;
}
` : ''}
async function pollDashboardStatus(){
  try {
    var pr = await fetch('/ema_rsi_st-paper/status/data',{cache:'no-store'});
    if(pr.ok){ var pd=await pr.json(); renderPaperStatus(pd); }
    else { renderPaperStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null,pnlSource:'—'}); }
  } catch(e){
    renderPaperStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null,pnlSource:'—'});
  }
  try {
    var lr = await fetch('/ema_rsi_st-live/status/data',{cache:'no-store'});
    if(lr.ok){ var ld=await lr.json(); renderLiveStatus(ld); }
    else { renderLiveStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,fyersOk:false,zerodhaOk:false,tickCount:0,candleCount:0}); }
  } catch(e){
    renderLiveStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,fyersOk:false,zerodhaOk:false,tickCount:0,candleCount:0});
  }
  // BB_RSI Paper status
  ${bbRsiModeOn ? `try {
    var sp = await fetch('/bb_rsi-paper/status/data',{cache:'no-store'});
    if(sp.ok){ var spd=await sp.json(); renderBbRsiPaperStatus(spd); }
    else { renderBbRsiPaperStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null}); }
  } catch(e){ renderBbRsiPaperStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null}); }
  // BB_RSI Live status
  try {
    var sr = await fetch('/bb_rsi-live/status/data',{cache:'no-store'});
    if(sr.ok){ var sd=await sr.json(); renderBbRsiLiveStatus(sd); }
    else { renderBbRsiLiveStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,tickCount:0,candleCount:0}); }
  } catch(e){ renderBbRsiLiveStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,tickCount:0,candleCount:0}); }` : ''}
  // PA Paper status
  ${paModeOn ? `try {
    var pp = await fetch('/pa-paper/status/data',{cache:'no-store'});
    if(pp.ok){ var ppd=await pp.json(); renderPAPaperStatus(ppd); }
    else { renderPAPaperStatus({running:false,sessionPnl:0,unrealised:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null}); }
  } catch(e){ renderPAPaperStatus({running:false,sessionPnl:0,unrealised:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null}); }
  // PA Live status
  try {
    var plr = await fetch('/pa-live/status/data',{cache:'no-store'});
    if(plr.ok){ var pld=await plr.json(); renderPALiveStatus(pld); }
    else { renderPALiveStatus({running:false,sessionPnl:0,unrealised:null,tradeCount:0,wins:0,losses:0,tickCount:0,candleCount:0}); }
  } catch(e){ renderPALiveStatus({running:false,sessionPnl:0,unrealised:null,tradeCount:0,wins:0,losses:0,tickCount:0,candleCount:0}); }` : ''}
  // Toggle quick-action buttons based on running state
  var bPaper=document.getElementById('btn-all-paper'), bLive=document.getElementById('btn-all-live');
  function _isOn(id){ var el=document.getElementById(id); return !!(el && el.style.display!=='none'); }
  if(bPaper){
    var allOn = _isOn('paper-run-badge')
      && (${bbRsiModeOn ? "_isOn('bb_rsi-paper-run-badge')" : "true"})
      && (${paModeOn ? "_isOn('pa-paper-run-badge')" : "true"});
    if(allOn){ bPaper.disabled=true; bPaper.textContent='✓ ALL PAPER RUNNING'; bPaper.style.borderColor='#166534'; bPaper.style.opacity='0.6'; }
    else { bPaper.disabled=false; bPaper.textContent='▶ START ALL PAPER TRADES'; bPaper.style.opacity='1'; }
  }
  if(bLive){
    var allLiveOn = _isOn('live-run-badge')
      && (${bbRsiModeOn ? "_isOn('bb_rsi-live-run-badge')" : "true"})
      && (${paModeOn ? "_isOn('pa-live-run-badge')" : "true"});
    if(allLiveOn){ bLive.disabled=true; bLive.textContent='✓ ALL LIVE RUNNING'; bLive.style.borderColor='#7f1d1d'; bLive.style.opacity='0.6'; }
    else { bLive.disabled=false; bLive.textContent='▶ START ALL LIVE TRADES'; bLive.style.opacity='1'; }
  }
}
/* pollDashboardStatus disabled — dashboard no longer shows realtime data */

// ── Quick Action: Start All Paper / All Live ────────────────────────────────
// All three lists are generated from the server-side startAllModes roster, which
// is filtered by the *_MODE_ENABLED Settings toggles — only enabled strategies
// appear here. Harness routes wrap PAPER (LIVE = PAPER by construction) and
// respect LIVE_HARNESS_DRY_RUN.
var PAPER_ENDPOINTS   = ${JSON.stringify(startAllModes.map((m) => m.paper))};
var LIVE_ENDPOINTS    = ${JSON.stringify(startAllLiveModes.map((m) => m.live))};
var HARNESS_ENDPOINTS = ${JSON.stringify(startAllModes.map((m) => m.harness))};
var ALL_MODE_LABELS   = ${JSON.stringify(startAllModes.map((m) => m.label))};
var LIVE_MODE_LABELS  = ${JSON.stringify(startAllLiveModes.map((m) => m.label))};
var ENDPOINT_LABELS   = ${JSON.stringify(startAllEndpointLabels)};

function _escHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}

// Server-supplied, so there is no second strategy list to keep in step with the
// roster. Falls back to the raw URL for anything not in the map.
function _prettyEndpoint(url){
  return ENDPOINT_LABELS[url] || url;
}

// True from the first /start until the whole roster has been attempted AND the
// result has been shown. Read by pollSessionActiveSwap(), which must not
// navigate away mid-run — see the comment there.
var _startAllBusy = false;

async function _startAll(endpoints){
  var results = { successes: [], failures: [] };
  for (var i = 0; i < endpoints.length; i++){
    var ep = endpoints[i];
    try {
      var r = await secretFetch(ep);
      if (!r){ results.failures.push({ endpoint: ep, error: 'No response from server' }); continue; }
      var body = null;
      try { body = await r.json(); } catch(_) { /* non-JSON body */ }
      if (r.ok && (!body || body.success !== false)){
        results.successes.push({ endpoint: ep });
      } else {
        var msg = (body && (body.error || body.message)) || ('HTTP ' + r.status);
        results.failures.push({ endpoint: ep, status: r.status, error: msg });
      }
    } catch(e){
      results.failures.push({ endpoint: ep, error: (e && e.message) || 'Network error' });
    }
  }
  return results;
}

// ── Post-start verification ────────────────────────────────────────────────
// HTTP 200 from /start only means the route ACCEPTED the request — it is not
// proof the engine actually came up (mutual-exclusion lock held by the other
// mode, expired broker token, socket refused, an engine that starts and then
// stops itself). So once the whole roster has been attempted we poll each
// mode's own /status/data and report its \`running\` flag — the same field the
// Start-All button state polls. Engines that need a tick or a broker
// round-trip before flipping the flag get a few retries; only the
// not-yet-running ones are re-polled, so one slow starter does not hold up the
// confirmation for the rest.
var VERIFY_ATTEMPTS = 4;
var VERIFY_GAP_MS   = 800;

// Every wired start route ends in \`/start\` and exposes \`/status/data\` on the
// same router — the same derivation the server uses to build ALL_BTN_POLL.
function _statusUrlFor(startEndpoint){
  return startEndpoint.replace('/start', '/status/data');
}

function _sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

// The two route families answer with different fields, so "is it up?" is not a
// single flag. Paper and pure-Live routes report \`running\`. Harness routes
// report \`installed\` — and the seven paper-wrapping ones ALSO merge the paper
// engine's \`running\` into the same payload, while the four native ones
// (EMA_RSI_ST / BB_RSI / PA / ORB) report \`installed\` alone. Reading only
// \`running\` would therefore mark every native harness FAILED, and reading only
// \`installed\` would pass a wrapping harness whose paper engine never started.
// So: use whichever fields the payload actually carries, and require both when
// both are there.
function _isUp(d){
  if (!d || typeof d !== 'object') return false;
  var hasInstalled = Object.prototype.hasOwnProperty.call(d, 'installed');
  var hasRunning   = Object.prototype.hasOwnProperty.call(d, 'running');
  if (hasInstalled && hasRunning) return !!(d.installed && d.running);
  if (hasInstalled) return !!d.installed;
  return !!d.running;
}

// Names the specific half that is down, so a wrapping harness that installed
// but whose engine never started does not read as a blanket failure.
function _whyDown(d){
  if (!d || typeof d !== 'object') return 'no status returned';
  if (Object.prototype.hasOwnProperty.call(d, 'installed') && !d.installed) return 'harness not installed';
  if (Object.prototype.hasOwnProperty.call(d, 'installed')) return 'harness installed but engine not running';
  return 'engine not running';
}

async function _pollRunning(endpoint){
  try {
    var r = await fetch(_statusUrlFor(endpoint), { cache:'no-store' });
    if (!r.ok) return { running:false, error:'status check failed (HTTP ' + r.status + ')' };
    var d = await r.json();
    return _isUp(d) ? { running:true } : { running:false, error:_whyDown(d) };
  } catch(e){
    return { running:false, error:'status check unreachable' };
  }
}

async function _verifyAllRunning(endpoints){
  var verdict = {};
  var pending = endpoints.slice();
  for (var attempt = 0; attempt < VERIFY_ATTEMPTS && pending.length; attempt++){
    if (attempt) await _sleep(VERIFY_GAP_MS);
    var checked = await Promise.all(pending.map(_pollRunning));
    var stillPending = [];
    for (var i = 0; i < pending.length; i++){
      verdict[pending[i]] = checked[i];
      if (!checked[i].running) stillPending.push(pending[i]);
    }
    pending = stillPending;
  }
  return verdict;
}

function _startAllRow(name, ok, why){
  var tint   = ok ? 'rgba(22,163,74,0.10)' : 'rgba(239,68,68,0.10)';
  var edge   = ok ? 'rgba(22,163,74,0.35)' : 'rgba(239,68,68,0.35)';
  var colour = ok ? '#16a34a' : '#ef4444';
  return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:5px;'
       + 'border-radius:7px;background:' + tint + ';border:1px solid ' + edge + ';">'
       + '<span style="font-size:0.85rem;">' + (ok ? '✅' : '❌') + '</span>'
       + '<span style="flex:1;min-width:0;text-align:left;">' + _escHtml(name)
       + (ok ? '' : '<br><span style="font-size:0.68rem;opacity:0.85;">' + _escHtml(why) + '</span>')
       + '</span>'
       + '<span style="font-weight:700;color:' + colour + ';letter-spacing:0.04em;">'
       + (ok ? 'OK' : 'FAILED') + '</span>'
       + '</div>';
}

// Always shown after a Start All. Previously an all-success run just reloaded
// the page silently, which left no confirmation that every strategy was really
// up; now every attempted mode is listed by name with its verified state.
async function _handleStartAllResult(btn, origText, label, endpoints, result){
  var failByEndpoint = {};
  result.failures.forEach(function(f){ failByEndpoint[f.endpoint] = f; });

  var verdict = await _verifyAllRunning(endpoints);

  var okCount = 0;
  var rows = endpoints.map(function(ep){
    var v = verdict[ep] || { running:false };
    if (v.running){ okCount++; return _startAllRow(_prettyEndpoint(ep), true, ''); }
    // Prefer the /start error — it says WHY. Fall back to the status probe.
    var why = (failByEndpoint[ep] && failByEndpoint[ep].error)
           || v.error
           || 'started but not running';
    return _startAllRow(_prettyEndpoint(ep), false, why);
  }).join('');

  var total  = endpoints.length;
  var allOk  = okCount === total;
  var header = allOk
    ? ('All ' + total + ' running — verified.')
    : (okCount + ' of ' + total + ' running. See the failures below.');

  await showAlert({
    icon: allOk ? '✅' : (okCount > 0 ? '⚠️' : '❌'),
    title: label + ' — ' + okCount + '/' + total + ' Running',
    message: '<div style="text-align:left;">'
           + '<div style="margin-bottom:10px;">' + header + '</div>'
           + '<div style="max-height:min(46vh,340px);overflow-y:auto;">' + rows + '</div>'
           + '</div>',
    btnText: 'OK',
    btnClass: 'modal-btn-primary',
  });

  btn.disabled = false;
  btn.textContent = origText;
  // Reload so the dashboard badges/buttons pick up whatever did come up. With
  // nothing running there is no state change to show — leave the page put so
  // the user can act on the reasons they just read.
  if (okCount > 0) location.reload();
}

// Guard for an empty roster: every strategy disabled in Settings (or, for Live,
// only harness-only strategies enabled) would otherwise "succeed" with 0 starts
// and silently reload the page.
async function _noModesEnabled(endpoints, what){
  if (endpoints.length) return false;
  await showAlert({
    icon: '⚠️',
    title: 'Nothing to start',
    message: 'No strategy is enabled for ' + what + '. Enable one in Settings → Strategy Modes and try again.',
    btnText: 'OK', btnClass: 'modal-btn-primary',
  });
  return true;
}

// Single entry point for the three Start-All buttons, so the busy flag can
// never be left set (or skipped) by one of them drifting from the others.
async function _runStartAll(btn, origText, label, endpoints){
  _startAllBusy = true;
  try {
    var result = await _startAll(endpoints);
    await _handleStartAllResult(btn, origText, label, endpoints, result);
  } finally {
    _startAllBusy = false;
  }
}

async function startAllPaper(btn){
  if (await _noModesEnabled(PAPER_ENDPOINTS, 'Paper')) return;
  var modeList = ALL_MODE_LABELS.join(' + ');
  var orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Starting paper: ' + modeList + '...';
  await _runStartAll(btn, orig, 'All Paper', PAPER_ENDPOINTS);
}

async function startAllLive(btn){
  if (await _noModesEnabled(LIVE_ENDPOINTS, 'Live')) return;
  var ok = await showConfirm({
    icon: '⚠️', title: 'Start ALL Live Trades',
    message: 'Start ' + LIVE_MODE_LABELS.join(' + ') + ' Live?\\nReal orders will be placed on broker accounts.',
    confirmText: 'Start All', confirmClass: 'modal-btn-danger'
  });
  if(!ok) return;
  var orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Starting all live trades...';
  await _runStartAll(btn, orig, 'All Live', LIVE_ENDPOINTS);
}

async function startAllHarness(btn){
  if (await _noModesEnabled(HARNESS_ENDPOINTS, 'Live (Harness)')) return;
  var modeList = ALL_MODE_LABELS.join(' + ');
  var ok = await showConfirm({
    icon: '🧪', title: 'Start ALL Live (Harness)',
    message: 'Start ' + modeList + ' via Paper Harness?\\n\\nEach runs Paper unchanged and logs the broker order it WOULD place. Orders follow the global DRY-RUN flag — no real orders while LIVE_HARNESS_DRY_RUN is ON.',
    confirmText: 'Start All (Harness)', confirmClass: 'modal-btn-primary'
  });
  if(!ok) return;
  var orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Starting harness: ' + modeList + '...';
  await _runStartAll(btn, orig, 'All Harness', HARNESS_ENDPOINTS);
}

// Single Start-All button follows the top-bar PAPER/LIVE toggle.
function startAll(btn){
  return _dashSrc === 'live' ? startAllLive(btn) : startAllPaper(btn);
}

// ── Quick-Action button live state (mutual lock: Paper ↔ Live) ──────────────
var _dashSrc = 'paper';            // top-bar toggle source; also drives the charts
var _allBtnState = { paperOn:false, liveOn:false };
var _marketsClosed = false;        // set by checkTradingStatus() on weekend / NSE holiday
// Derived from the same enabled-strategy roster as the Start-All endpoint lists.
var ALL_BTN_POLL = ${JSON.stringify(startAllPollTargets)};

function _applyAllBtnState(paperOn, liveOn){
  // Harness is a paper-side concept (Paper + dry-run live log) — only show it
  // when the PAPER source is selected; hide it under LIVE.
  // _marketsClosed wins over both: this poll runs every few seconds and would
  // otherwise re-show the buttons that checkTradingStatus() just hid on a
  // weekend / NSE holiday.
  var hb = document.getElementById('btn-all-harness');
  if(hb) hb.style.display = (_marketsClosed || _dashSrc === 'live') ? 'none' : '';
  var b = document.getElementById('btn-all-start');
  if(!b) return;
  if(_marketsClosed){ b.style.display = 'none'; return; }
  b.style.display = '';
  b.classList.remove('run-paper','run-live','is-active-paper','is-active-live','is-locked');
  if(_dashSrc === 'live'){
    if(liveOn){
      b.disabled = true; b.classList.add('is-active-live');
      b.textContent = '● LIVE ACTIVE'; b.title = 'Live trading is running';
    } else if(paperOn){
      b.disabled = true; b.classList.add('is-locked');
      b.textContent = '🔒 Live locked'; b.title = 'Stop all paper trades before starting live';
    } else {
      b.disabled = false; b.classList.add('run-live');
      b.textContent = '▶ Start All (Live)'; b.title = 'Start all live modes';
    }
  } else {
    if(paperOn){
      b.disabled = true; b.classList.add('is-active-paper');
      b.textContent = '● PAPER ACTIVE'; b.title = 'Paper trading is running';
    } else if(liveOn){
      b.disabled = true; b.classList.add('is-locked');
      b.textContent = '🔒 Paper locked'; b.title = 'Stop all live trades before starting paper';
    } else {
      b.disabled = false; b.classList.add('run-paper');
      b.textContent = '▶ Start All (Paper)'; b.title = 'Start all paper modes';
    }
  }
}

async function pollAllBtnsStatus(){
  if(!document.getElementById('btn-all-start')) return;
  try {
    var results = await Promise.all(ALL_BTN_POLL.map(function(p){
      return fetch(p.url,{cache:'no-store'})
        .then(function(r){ return r.ok ? r.json() : {running:false}; })
        .catch(function(){ return {running:false}; });
    }));
    var paperOn=false, liveOn=false;
    for(var i=0;i<results.length;i++){
      if(!results[i] || !results[i].running) continue;
      if(ALL_BTN_POLL[i].kind==='paper') paperOn=true; else liveOn=true;
    }
    _allBtnState.paperOn = paperOn; _allBtnState.liveOn = liveOn;
    _applyAllBtnState(paperOn, liveOn);
  } catch(_){}
}
pollAllBtnsStatus();
setInterval(pollAllBtnsStatus, 10000);

// ── Dashboard Cumulative P&L Charts (Paper + Live) ───────────────────────────
function _fmtINR(n){
  if (typeof n !== 'number' || isNaN(n)) return '—';
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _buildCumSeries(trades){
  var sorted = trades.slice().sort(function(a, b){
    var da = (a.date || '') + ' ' + (a.entryTime || '');
    var db = (b.date || '') + ' ' + (b.entryTime || '');
    return da.localeCompare(db);
  });
  var cum = 0, labels = [], data = [];
  for (var i = 0; i < sorted.length; i++){
    var t = sorted[i];
    cum += (t.pnl || 0);
    var lbl = (t.date || '') + (t.entryTime ? ' ' + t.entryTime.split(',')[0] : '');
    labels.push(lbl);
    data.push(cum);
  }
  return { labels: labels, data: data, total: cum };
}

var PNL_GREEN = '#10b981', PNL_RED = '#ef4444', PNL_FLAT = '#8ba1c2';
var PNL_GREEN_FILL = 'rgba(16,185,129,0.14)', PNL_RED_FILL = 'rgba(239,68,68,0.14)', PNL_FLAT_FILL = 'rgba(74,96,128,0.10)';
function _pnlColor(total){ return total > 0 ? PNL_GREEN : (total < 0 ? PNL_RED : PNL_FLAT); }
function _pnlFill(total){ return total > 0 ? PNL_GREEN_FILL : (total < 0 ? PNL_RED_FILL : PNL_FLAT_FILL); }

function _renderDashCumChart(canvasId, emptyId, trades){
  var canvas = document.getElementById(canvasId);
  var empty  = document.getElementById(emptyId);
  if (!canvas) return null;
  // The canvas sits in a fixed-height wrapper (.mm-wrap / .dash-chart-wrap), so
  // hiding the canvas alone left the wrapper's height behind as an empty band
  // above the "no trades" line. Collapse the wrapper too.
  var wrap = canvas.parentElement;
  if (!trades || !trades.length){
    if (empty) empty.style.display = 'block';
    canvas.style.display = 'none';
    if (wrap) wrap.style.display = 'none';
    return null;
  }
  if (empty) empty.style.display = 'none';
  if (wrap) wrap.style.display = '';
  canvas.style.display = 'block';
  var s = _buildCumSeries(trades);
  var isLight = document.documentElement.getAttribute('data-theme') === 'light';
  var gridCol = isLight ? '#e0e4ea' : '#1a2236';
  var tickCol = isLight ? '#64748b' : '#3a5070';
  var baseColor = _pnlColor(s.total);
  var baseFill  = _pnlFill(s.total);
  return new Chart(canvas, {
    type: 'line',
    data: { labels: s.labels, datasets: [{
      data: s.data, borderColor: baseColor,
      // Fill is split at the zero line: green above, red below — matches the line colour.
      backgroundColor: function(ctx){
        var chart = ctx.chart, area = chart.chartArea;
        if (!area) return baseFill; // before first layout
        var zeroPx = chart.scales.y.getPixelForValue(0);
        var r = (zeroPx - area.top) / (area.bottom - area.top);
        r = Math.max(0, Math.min(1, r));
        var g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, PNL_GREEN_FILL);
        g.addColorStop(r, PNL_GREEN_FILL);
        g.addColorStop(r, PNL_RED_FILL);
        g.addColorStop(1, PNL_RED_FILL);
        return g;
      },
      borderWidth: 2, fill: true, tension: 0.25, pointRadius: 0,
      segment: {
        borderColor: function(ctx){
          var y0 = ctx.p0.parsed.y, y1 = ctx.p1.parsed.y;
          return ((y0 + y1) / 2) >= 0 ? PNL_GREEN : PNL_RED;
        },
      },
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: function(ctx){ return _fmtINR(ctx.parsed.y); } } } },
      scales: {
        x: { ticks: { display: false }, grid: { display: false } },
        y: { ticks: { color: tickCol, font: { size: 9 }, callback: function(v){ return _fmtINR(v); } }, grid: { color: gridCol } },
      },
    },
  });
}

function _updateChartStats(elId, trades){
  var el = document.getElementById(elId);
  if (!el) return;
  if (!trades || !trades.length){ el.innerHTML = '<span class="pnl-flat">0 trades</span>'; return; }
  var total = 0, wins = 0, losses = 0;
  for (var i = 0; i < trades.length; i++){
    var p = trades[i].pnl || 0;
    total += p;
    if (p > 0) wins++; else if (p < 0) losses++;
  }
  var cls = total > 0 ? 'pnl-pos' : (total < 0 ? 'pnl-neg' : 'pnl-flat');
  el.innerHTML = trades.length + ' trades · ' + wins + 'W/' + losses + 'L · <span class="' + cls + '">' + (total >= 0 ? '+' : '') + _fmtINR(total) + '</span>';
}

// ── Global date-range filter (top-bar) — applied to every chart on the page ──
// The charts already hold the full trade list client-side, so the range is a
// pure filter step: no refetch, and switching ranges cannot desync the total
// chart from the per-module ones because both read the same _dashRange.
// The option list and the date maths come from sharedNav's dateRangeJS() so
// this page and Edge Analytics always mean the same thing by a given range.
// Placeholder only — the wire-up block below calls _readDashRange() to fill this
// in from the select's own value before anything renders, so the page never
// filters by a range that differs from the one shown in the bar.
var _dashRange = { key:'', from:'', to:'' };

function _readDashRange(){
  var sel = document.getElementById('dashRangeSel');
  var key = sel ? sel.value : 'all';
  var f = document.getElementById('dashRangeFrom');
  var t = document.getElementById('dashRangeTo');
  var r = drRange(key, (f && f.value) || '', (t && t.value) || '');
  _dashRange = { key:key, from:r.from, to:r.to };
}

function _applyDashRange(trades){
  var f = _dashRange;
  if (!f.from && !f.to) return trades || [];
  return (trades || []).filter(function(t){
    var d = t.date || '';
    if (f.from && d < f.from) return false;
    if (f.to   && d > f.to)   return false;
    return true;
  });
}
function _dashRangeActive(){ return !!(_dashRange.from || _dashRange.to); }

var _dcData = { paper: null, live: null };
var _dcChart = null;
var _dcToggle = 'paper';

function _renderDashTotal(){
  var src = _dcToggle;
  var trades = _applyDashRange(_dcData[src] || []);
  var total = trades.reduce(function(a,t){ return a + (t.pnl||0); }, 0);
  var dot = document.getElementById('dashCumDot');
  if (dot) dot.style.background = _pnlColor(total);
  var link = document.getElementById('dashCumLink');
  if (link) link.href = src === 'live' ? '/live-consolidation' : '/consolidation';
  var emptyEl = document.getElementById('dashCumEmpty');
  if (emptyEl) emptyEl.textContent = 'No ' + src + ' trades ' + (_dashRangeActive() ? 'in this range' : 'yet');
  if (_dcChart) { _dcChart.destroy(); _dcChart = null; }
  _dcChart = _renderDashCumChart('dashCumChart', 'dashCumEmpty', trades);
  _updateChartStats('dash-cum-stats', trades);
}

// The login cookie has a sliding 15-min expiry, so a tab left open outlives
// its session: the page HTML is already rendered, but every later data fetch
// comes back 401. Swallowing that into an empty array drew *blank charts on a
// logged-out page*, which reads as "no trades today" — the one message it must
// never send. Say the session expired instead, and offer the way back.
var _authBannerShown = false;
function _authLost(){
  if (_authBannerShown) return;
  _authBannerShown = true;
  var bar = document.createElement('div');
  bar.id = 'sessionExpiredBar';
  bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;background:#b91c1c;color:#fff;'
    + 'padding:12px 16px;font:600 0.9rem system-ui,sans-serif;display:flex;gap:12px;'
    + 'align-items:center;justify-content:center;flex-wrap:wrap;'
    + 'padding-top:calc(12px + env(safe-area-inset-top));';
  bar.innerHTML = '<span>Session expired — charts below are not your data.</span>'
    + '<a href="/login" style="background:#fff;color:#b91c1c;padding:6px 14px;border-radius:6px;'
    + 'text-decoration:none;min-height:44px;display:inline-flex;align-items:center;">Log in again</a>';
  document.body.appendChild(bar);
}

async function loadDashCumCharts(){
  try {
    var r = await fetch('/consolidation/data?enabledOnly=1', { cache: 'no-store' });
    if (r.status === 401) _authLost();
    if (r.ok){ var d = await r.json(); _dcData.paper = (d && d.trades) || []; }
  } catch(_){ _dcData.paper = []; }
  try {
    var r2 = await fetch('/live-consolidation/data?enabledOnly=1', { cache: 'no-store' });
    if (r2.status === 401) _authLost();
    if (r2.ok){ var d2 = await r2.json(); _dcData.live = (d2 && d2.trades) || []; }
  } catch(_){ _dcData.live = []; }
  _renderDashTotal();
}

// Global Paper/Live toggle (top-bar) — one source drives every chart AND the Start-All button.
document.addEventListener('click', function(e){
  var btn = e.target.closest && e.target.closest('.dst-btn');
  if (!btn) return;
  var src = btn.getAttribute('data-src');
  if (!src || _dashSrc === src) return;
  _dashSrc = src;
  _dcToggle = src;
  ['EMA_RSI_ST','BB_RSI','PA','ORB','EMA9VWAP','TREND_PB','TDS','HA_SCALP','EARLYBIRD','SIMPLE930','RSI_PIVOT_ST'].forEach(function(m){ _mmToggle[m] = src; });
  document.querySelectorAll('#dashSrcToggle .dst-btn').forEach(function(b){ b.classList.toggle('active', b === btn); });
  _renderDashTotal();
  ['EMA_RSI_ST','BB_RSI','PA','ORB','EMA9VWAP','TREND_PB','TDS','HA_SCALP','EARLYBIRD','SIMPLE930','RSI_PIVOT_ST'].forEach(_renderModuleChart);
  _applyAllBtnState(_allBtnState.paperOn, _allBtnState.liveOn);
});

// Global date-range selector (top-bar) — re-renders the same charts the
// Paper/Live toggle drives, so both filters always compose.
(function(){
  var sel = document.getElementById('dashRangeSel');
  if (!sel) return;
  function refreshRange(){
    _readDashRange();
    _renderDashTotal();
    ['EMA_RSI_ST','BB_RSI','PA','ORB','EMA9VWAP','TREND_PB','TDS','HA_SCALP','EARLYBIRD','SIMPLE930','RSI_PIVOT_ST'].forEach(_renderModuleChart);
    _renderBrokerWallets();
  }
  function syncCustomVisibility(){
    var custom = document.getElementById('dashRangeCustom');
    if (custom) custom.style.display = sel.value === 'custom' ? '' : 'none';
  }
  function onRangeChange(){
    syncCustomVisibility();
    // Only 'Current week expiry' needs the expiry calendar — fetched on first
    // use and cached, so every later selection resolves without a round-trip.
    if (sel.value === 'exp') { drReady().then(refreshRange); return; }
    refreshRange();
  }
  sel.addEventListener('change', onRangeChange);
  ['dashRangeFrom','dashRangeTo'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', onRangeChange);
  });
  // Adopt whatever the select actually shows before the first render: on a
  // back-navigation the browser restores the previous selection, and a default
  // _dashRange of "All" would then disagree with the visible label.
  syncCustomVisibility();
  _readDashRange();
  if (sel.value === 'exp') drReady().then(refreshRange);
})();

loadDashCumCharts();

// ── Per-Module P&L Charts (top-bar Paper/Live toggle + Range filter) ─────────
var _mmData = { paper: null, live: null };
var _mmCharts = {};
var _mmToggle = { EMA_RSI_ST: 'paper', BB_RSI: 'paper', PA: 'paper', ORB: 'paper', EMA9VWAP: 'paper', TREND_PB: 'paper', TDS: 'paper', HA_SCALP: 'paper', EARLYBIRD: 'paper', SIMPLE930: 'paper', RSI_PIVOT_ST: 'paper' };

// A strategy with no trades in the selected source+range has nothing to show,
// so its whole card is hidden rather than kept as a "0 trades" placeholder.
// When that empties the grid, one note stands in for all of them.
// Rows are balanced over the VISIBLE cards, never ragged: 4 per row is the
// widest a row gets, and the count is then spread evenly over the rows that
// needs — 5 cards go 3+2 (not 4+1), 7 go 4+3, 11 go 4+4+3. The last row's cards
// stretch to fill whatever width is left (flex-grow, see .mm-grid), so there is
// no dead space on the right regardless of how many strategies are enabled.
var MM_MAX_COLS = 4;
function _layoutModuleGrid(visible){
  var grid = document.getElementById('mmGrid');
  if (!grid) return;
  var rows = Math.max(1, Math.ceil(visible / MM_MAX_COLS));
  grid.style.setProperty('--mm-cols', String(Math.max(1, Math.ceil(visible / rows))));
}

function _updateModuleGridEmpty(){
  var note = document.getElementById('mmGridEmpty');
  if (!note) return;
  var visible = 0;
  document.querySelectorAll('.mm-card[data-mode]').forEach(function(c){
    if (c.style.display !== 'none') visible++;
  });
  var anyVisible = visible > 0;
  _layoutModuleGrid(visible);
  note.style.display = anyVisible ? 'none' : '';
  if (anyVisible) return;
  // Same wording as the per-card and cumulative empty lines, so the note names
  // the source and range the grid is actually showing.
  var txt = document.getElementById('mmGridEmptyTxt');
  if (txt) txt.textContent = 'No strategy has any ' + _dashSrc + ' trades ' + (_dashRangeActive() ? 'in this range' : 'yet');
}

function _renderModuleChart(mode){
  var card = document.querySelector('.mm-card[data-mode="' + mode + '"]');
  if (!card) return;
  var src = _mmToggle[mode];
  var all = _mmData[src] || [];
  var trades = _applyDashRange(all.filter(function(t){ return (t.mode || '').toUpperCase() === mode; }));
  if (_mmCharts[mode]) { _mmCharts[mode].destroy(); _mmCharts[mode] = null; }
  card.style.display = trades.length ? '' : 'none';
  if (!trades.length) { _updateModuleGridEmpty(); return; }  // never draw into a hidden card
  // The card's own "no trades" line is unreachable from here now that an empty
  // card is hidden outright; _renderDashCumChart still owns it for the shared
  // cumulative card below the grid.
  _mmCharts[mode] = _renderDashCumChart('mmChart-' + mode, 'mm-empty-' + mode, trades);
  _updateChartStats('mm-stats-' + mode, trades);
  _updateModuleGridEmpty();
}

// ── Broker wallets — remaining = investment pool + paper P&L in the SAME range
// the charts are showing. Reads _mmData.paper (every mode, unfiltered by the
// nav toggles) and narrows it with the pool's own mode list, so a broker's
// wallet moves only for the strategies that actually trade through it.
// Deliberately paper-only, and driven by _applyDashRange so the wallet and the
// curve below it can never quote different periods.
var BROKER_POOLS = ${JSON.stringify(brokerPools)};
function _inr0(n){ return '₹' + Math.round(n).toLocaleString('en-IN'); }
function _renderBrokerWallets(){
  var all = _mmData.paper;
  if (!all) return;                    // trades not loaded yet — keep the "…"
  var rows = _applyDashRange(all);
  Object.keys(BROKER_POOLS).forEach(function(broker){
    var pool = BROKER_POOLS[broker];
    var remainEl = document.getElementById('wallet-remain-' + broker);
    var pnlEl    = document.getElementById('wallet-pnl-' + broker);
    if (!remainEl && !pnlEl) return;   // wallets are hidden while a mode runs
    var pnl = 0;
    for (var i = 0; i < rows.length; i++){
      if (pool.modes.indexOf(String(rows[i].mode || '').toUpperCase()) !== -1) pnl += (rows[i].pnl || 0);
    }
    if (remainEl) remainEl.textContent = _inr0(pool.inv + pnl);
    if (pnlEl){
      pnlEl.className   = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'zero';
      pnlEl.textContent = (pnl > 0 ? '▲ ' : pnl < 0 ? '▼ ' : '') + _inr0(Math.abs(pnl));
    }
  });
}

async function loadModuleCharts(){
  try {
    var r1 = await fetch('/consolidation/data', { cache: 'no-store' });
    if (r1.status === 401) _authLost();
    if (r1.ok){ var d1 = await r1.json(); _mmData.paper = (d1 && d1.trades) || []; }
  } catch(_){ _mmData.paper = []; }
  try {
    var r2 = await fetch('/live-consolidation/data', { cache: 'no-store' });
    if (r2.status === 401) _authLost();
    if (r2.ok){ var d2 = await r2.json(); _mmData.live = (d2 && d2.trades) || []; }
  } catch(_){ _mmData.live = []; }
  ['EMA_RSI_ST','BB_RSI','PA','ORB','EMA9VWAP','TREND_PB','TDS','HA_SCALP','EARLYBIRD','SIMPLE930','RSI_PIVOT_ST'].forEach(_renderModuleChart);
  _renderBrokerWallets();
}

loadModuleCharts();

// ── Market schedule pills (top bar) — independent of analytics panel ─────────
// A phone can't spare a whole top-bar row per pill: "📅 Next Expiry Date :
// 28/07/2026 - M - 1 day" is 41 characters and takes the full 393px width on
// its own, pushing the broker rows off the first screen. Each pill therefore
// carries both labels and picks one by viewport — the short form keeps the
// date, the W/M type and the days, which is all the bar has to convey; the
// popup behind the pill has the rest.
var SCHED_PILL_NARROW = 768;
function setSchedulePillLabel(el, full, short){
  el.dataset.full  = full;
  el.dataset.short = short;
  el.textContent = window.innerWidth <= SCHED_PILL_NARROW ? short : full;
}
function applySchedulePillLabels(){
  ['expiry-info-pill','holiday-info-pill'].forEach(function(id){
    var el = document.getElementById(id);
    if (!el || !el.dataset.full) return;
    var want = window.innerWidth <= SCHED_PILL_NARROW ? el.dataset.short : el.dataset.full;
    if (el.textContent !== want) el.textContent = want;
  });
}
(function(){
  var t = null;
  window.addEventListener('resize', function(){
    clearTimeout(t);
    t = setTimeout(applySchedulePillLabels, 150);   // also covers rotate
  });
})();

async function loadMarketSchedulePills(){
  function istDateISO(){ return new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' }); }
  function diffDays(iso){
    var parts = iso.split('-');
    var dt = new Date(Date.UTC(+parts[0], +parts[1]-1, +parts[2]));
    var today = istDateISO().split('-');
    var nowDt = new Date(Date.UTC(+today[0], +today[1]-1, +today[2]));
    return Math.round((dt - nowDt) / 86400000);
  }
  function fmtDMY(iso){ var p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  var expEl = document.getElementById('expiry-info-pill');
  var holEl = document.getElementById('holiday-info-pill');
  if (!expEl || !holEl) return;
  try {
    var [hr, er] = await Promise.all([
      fetch('/api/holidays',     { cache:'no-store' }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
      fetch('/api/expiry-dates', { cache:'no-store' }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
    ]);
    var todayIso = istDateISO();
    // Next expiry
    var expiries = (er && er.expiries) || [];
    var nextExp = null;
    for (var i = 0; i < expiries.length; i++) {
      var e = expiries[i];
      var d = e.actual || e.date;
      if (d >= todayIso) { nextExp = { date:d, monthly:e.monthly, preponed:e.preponed }; break; }
    }
    if (nextExp) {
      var d = diffDays(nextExp.date);
      var typeLbl = (nextExp.monthly ? 'M' : 'W') + (nextExp.preponed ? '*' : '');
      var when = d === 0 ? 'today' : d + (d === 1 ? ' day' : ' days');
      var whenShort = d === 0 ? 'today' : d + 'd';
      var dm = fmtDMY(nextExp.date).slice(0, 5);   // 28/07/2026 -> 28/07
      expEl.classList.remove('empty');
      setSchedulePillLabel(
        expEl,
        '📅 Next Expiry Date : ' + fmtDMY(nextExp.date) + ' - ' + typeLbl + ' - ' + when,
        '📅 ' + dm + ' · ' + typeLbl + ' · ' + whenShort
      );
    } else {
      expEl.classList.add('empty');
      setSchedulePillLabel(expEl, '📅 No upcoming expiry', '📅 No expiry');
    }
    // Next holiday
    var holidays = ((hr && hr.holidays) || []).slice().sort();
    var nextHol = null;
    for (var j = 0; j < holidays.length; j++) {
      if (holidays[j] >= todayIso) { nextHol = holidays[j]; break; }
    }
    if (nextHol) {
      var hd = diffDays(nextHol);
      // Only surface the holiday from the previous day onward (tomorrow / today) —
      // no point showing a countdown to a holiday weeks away.
      if (hd <= 1) {
        var hwhen = hd === 0 ? 'today' : 'tomorrow';
        holEl.style.display = '';
        holEl.classList.remove('empty');
        setSchedulePillLabel(
          holEl,
          '🎉 Holiday ' + fmtDMY(nextHol) + ' · ' + hwhen,
          '🎉 ' + fmtDMY(nextHol).slice(0, 5) + ' · ' + hwhen
        );
      } else {
        holEl.style.display = 'none';
      }
    } else {
      holEl.style.display = 'none';
    }
  } catch(_){}
}
loadMarketSchedulePills();
setInterval(loadMarketSchedulePills, 3600000); // hourly — these change daily at most

// ── Dashboard Analytics Panel ─────────────────────────────────────────────────
// Live view (market hours) vs Post-market view (last session only).
(function initAnalyticsPanel(){
  var root = document.getElementById('dashAnalytics');
  if (!root) return;

  // Enabled-strategy tiles (server-rendered from *_MODE_ENABLED). Drives both
  // the live and post-market views so disabled strategies never appear here.
  var SESSION_TILES = ${JSON.stringify(dashSessionTiles)};
  var LIVE_URLS = {
    EMA_RSI_ST:'/ema_rsi_st-paper/status/data', BB_RSI:'/bb_rsi-paper/status/data',
    PA:'/pa-paper/status/data', ORB:'/orb-paper/status/data', EMA9VWAP:'/ema9vwap-paper/status/data',
    TREND_PB:'/trend-pb-paper/status/data', TDS:'/trend-day-scalp-paper/status/data', HA_SCALP:'/ha-scalp-paper/status/data', EARLYBIRD:'/early-bird-paper/status/data', SIMPLE930:'/simple930-paper/status/data',
    RSI_PIVOT_ST:'/rsi-pivot-st-paper/status/data'
  };

  function fmtINR(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var v = +n; var sign = v < 0 ? '-' : '';
    return sign + '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }
  function cls(n) {
    if (n === null || n === undefined || isNaN(n) || +n === 0) return 'flat';
    return +n > 0 ? 'pos' : 'neg';
  }
  function istNowMinutes(){
    // Minutes since IST midnight using fixed +05:30 offset (no DST in India)
    return Math.floor((Math.floor(Date.now() / 1000) + 19800) / 60) % 1440;
  }
  function istDateISO(){
    var d = new Date();
    // en-CA gives YYYY-MM-DD
    return d.toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' });
  }
  function istDow(){
    var d = new Date(new Date().toLocaleString('en-US', { timeZone:'Asia/Kolkata' }));
    return d.getDay(); // 0=Sun..6=Sat
  }

  // Are we inside an NSE trading session?
  function isMarketOpenNow(holidays){
    var dow = istDow();
    if (dow === 0 || dow === 6) return false;
    var iso = istDateISO();
    if (holidays && holidays.indexOf(iso) !== -1) return false;
    var m = istNowMinutes();
    return m >= 9*60+15 && m < 15*60+30;
  }

  function fetchJSON(url){
    return fetch(url, { cache:'no-store' }).then(function(r){
      // A 401 here means the sliding login cookie lapsed while the tab sat open.
      // Returning null would leave the panel on "Loading analytics…" forever.
      if (r.status === 401) { _authLost(); return null; }
      return r.ok ? r.json() : null;
    }).catch(function(){ return null; });
  }

  // Keep a tile only if the strategy has something to report today: a closed
  // trade, or an open position — a trade taken, just not finished yet. A failed
  // status fetch (d == null) is not proof of an idle strategy, so it keeps its
  // tile and shows OFFLINE rather than disappearing mid-session.
  // hasOpenPosition: strategies report an open position in one of two shapes —
  // a single "position", or EarlyBird's "positions[]" PLUS a separate NIFTY
  // option leg at "option.position". Testing "position" alone made an EarlyBird
  // tile vanish on an option-only day that had not closed a trade yet.
  function hasOpenPosition(d){
    if (!d) return false;
    if (d.position) return true;
    if (Array.isArray(d.positions) && d.positions.length) return true;
    return !!(d.option && d.option.position);
  }
  function shouldShowLiveTile(d){
    if (!d) return true;
    var taken = d.tradeCount != null ? d.tradeCount : (d.tradesTaken || 0);
    return (+taken > 0) || hasOpenPosition(d);
  }

  function renderLive(data) {
    // data: { EMA_RSI_ST, BB_RSI, ... } keyed by tile, each from /{strat}-paper/status/data
    // Only strategies that took a trade today get a card; idle ones are omitted.
    var tiles = SESSION_TILES.filter(function(t){ return shouldShowLiveTile(data[t.key]); });
    if (!tiles.length) {
      return '<div class="da-empty">No strategy has taken a trade yet today.</div>';
    }
    var html = '<div class="da-grid cols-' + Math.min(tiles.length, 6) + '">';
    tiles.forEach(function(t){
      var d = data[t.key];
      if (!d) {
        html += '<div class="da-tile ' + t.cls + '"><div class="da-tile-hdr">' + t.label + '<span class="da-pill">OFFLINE</span></div><div class="da-sub-line">No data</div></div>';
        return;
      }
      // Field names vary by strategy (ORB uses livePnl/tradesTaken, EarlyBird
      // openPnl — already summed across its stock legs AND its option leg) —
      // fall back through all of them, or the tile shows Open ₹0 while a
      // position is live. Same order as realtime.js openPnl().
      // `|| 0` on the result, not per-branch: a strategy that is flat reports
      // null here, and fmtINR(null) would paint "—" where "₹0" belongs.
      var open = (d.unrealisedPnl !== undefined ? d.unrealisedPnl
               : d.unrealised !== undefined ? d.unrealised
               : d.livePnl !== undefined ? d.livePnl
               : d.openPnl !== undefined ? d.openPnl
               : 0) || 0;
      var closed = d.sessionPnl || 0;
      var day = (+open || 0) + (+closed || 0);
      var c = cls(day);
      var pill = d.running ? 'run' : 'stop';
      html += '<div class="da-tile ' + t.cls + '">' +
        '<div class="da-tile-hdr">' + t.label + '<span class="da-pill ' + pill + '">' + (d.running ? 'RUNNING' : 'STOPPED') + '</span></div>' +
        '<div class="da-big ' + c + '">' + fmtINR(day) + '</div>' +
        '<div class="da-sub-line">Open ' + fmtINR(open) + ' &middot; Closed ' + fmtINR(closed) + ' &middot; ' + (d.tradeCount!=null?d.tradeCount:(d.tradesTaken||0)) + 'T (' + (d.wins||0) + 'W/' + (d.losses||0) + 'L)</div>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  function aggregateTrades(trades, fromIso, toIso) {
    // Returns { byStrategy: {EMA_RSI_ST:{net,trades,w,l}, ...}, total: {...}, byDate: { 'YYYY-MM-DD': net } }
    // Buckets by the trade's reliable mode field (EMA_RSI_ST/BB_RSI/PA/ORB),
    // limited to the enabled tiles. Trades are pre-filtered to enabled modes by
    // the /data?enabledOnly=1 fetch, so the total matches the visible cards.
    var bys = {};
    SESSION_TILES.forEach(function(t){ bys[t.key] = {net:0,t:0,w:0,l:0}; });
    var tot = { net:0, t:0, w:0, l:0 };
    var byDate = {};
    var bestDay = null, worstDay = null;
    trades.forEach(function(tr){
      if (!tr || !tr.date) return;
      if (fromIso && tr.date < fromIso) return;
      if (toIso && tr.date > toIso) return;
      var key = String(tr.mode || '').toUpperCase();
      var p = +tr.pnl || 0;
      if (bys[key]) { bys[key].net += p; bys[key].t++; if (p > 0) bys[key].w++; else if (p < 0) bys[key].l++; }
      tot.net += p; tot.t++; if (p > 0) tot.w++; else if (p < 0) tot.l++;
      byDate[tr.date] = (byDate[tr.date] || 0) + p;
    });
    // Best / worst day
    Object.keys(byDate).forEach(function(d){
      var v = byDate[d];
      if (bestDay === null || v > bestDay.v) bestDay = { d:d, v:v };
      if (worstDay === null || v < worstDay.v) worstDay = { d:d, v:v };
    });
    return { byStrategy: bys, total: tot, byDate: byDate, bestDay: bestDay, worstDay: worstDay };
  }

  function lastTradingDate(byDate){
    var dates = Object.keys(byDate).sort();
    return dates.length ? dates[dates.length - 1] : null;
  }

  function pctWR(w, l){
    var tot = w + l;
    return tot === 0 ? 0 : Math.round(100 * w / tot);
  }

  function renderPostMarket(paperTrades, liveTrades) {
    var combined = (paperTrades || []).concat(liveTrades || []);
    if (!combined.length) {
      return '<div class="da-empty">No trade history yet. Run a paper or live session — analytics appears here after-hours.</div>';
    }
    // Last completed trading day across paper+live
    var combinedAgg = aggregateTrades(combined);
    var lastDay = lastTradingDate(combinedAgg.byDate);
    var lastDayAgg = lastDay ? aggregateTrades(combined, lastDay, lastDay) : null;

    // ── Last session card (per strategy) ── only strategies that traded that
    // day, plus a TOTAL card. A strategy that sat out adds nothing to read.
    var tiles = SESSION_TILES.filter(function(t){
      var s = lastDayAgg ? lastDayAgg.byStrategy[t.key] : null;
      return !!(s && s.t > 0);
    });
    var lastHtml = '<div class="da-grid cols-' + Math.min(tiles.length + 1, 6) + '">';
    tiles.forEach(function(t){
      var s = lastDayAgg.byStrategy[t.key];
      var net = s.net;
      var trades = s.t;
      var w = s.w, l = s.l;
      lastHtml += '<div class="da-tile ' + t.cls + '">' +
        '<div class="da-tile-hdr">' + t.label + '<span class="da-pill">' + trades + 'T</span></div>' +
        '<div class="da-big ' + cls(net) + '">' + fmtINR(net) + '</div>' +
        '<div class="da-sub-line">' + w + 'W / ' + l + 'L &middot; WR ' + pctWR(w,l) + '%</div>' +
      '</div>';
    });
    // Total card for last day
    var tNet = lastDayAgg ? lastDayAgg.total.net : 0;
    var tTrades = lastDayAgg ? lastDayAgg.total.t : 0;
    var tW = lastDayAgg ? lastDayAgg.total.w : 0;
    var tL = lastDayAgg ? lastDayAgg.total.l : 0;
    lastHtml += '<div class="da-tile info">' +
      '<div class="da-tile-hdr">TOTAL<span class="da-pill">' + tTrades + 'T</span></div>' +
      '<div class="da-big ' + cls(tNet) + '">' + fmtINR(tNet) + '</div>' +
      '<div class="da-sub-line">' + tW + 'W / ' + tL + 'L &middot; WR ' + pctWR(tW,tL) + '%</div>' +
    '</div>';
    lastHtml += '</div>';

    var html = '';
    html += '<div class="da-tile-hdr" style="margin-top:2px;">Last trading day' + (lastDay ? ' &middot; ' + lastDay : '') + '</div>';
    html += lastHtml;
    return html;
  }

  // Tag the title & badge based on mode
  function setMode(mode, sub){
    var badge = document.getElementById('da-mode-badge');
    var title = document.getElementById('da-title-txt');
    var subEl = document.getElementById('da-sub-txt');
    if (mode === 'live') {
      badge.className = 'da-badge live'; badge.textContent = 'MARKET OPEN';
      title.textContent = 'Today So Far';
    } else {
      badge.className = 'da-badge post'; badge.textContent = 'MARKET CLOSED';
      title.textContent = 'Last Session';
    }
    subEl.textContent = sub || '';
  }

  var _pollTimer = null;
  function clearPoll(){ if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } }

  async function refresh(){
    var body = document.getElementById('da-body');
    // Only need holidays here (for the market-open check). Expiry data is
    // surfaced in the top-bar pills, populated independently.
    var holRes = await fetchJSON('/api/holidays');
    var holidays = (holRes && holRes.holidays) || [];
    var marketOpen = isMarketOpenNow(holidays);

    if (marketOpen) {
      // setMode writes this through textContent, so it takes the character, not
      // the HTML entity — "&middot;" printed itself verbatim.
      setMode('live', 'Polling every 8s · ' + istDateISO());
      var liveResults = await Promise.all(SESSION_TILES.map(function(t){
        return fetchJSON(LIVE_URLS[t.key]);
      }));
      var liveData = {};
      SESSION_TILES.forEach(function(t, i){ liveData[t.key] = liveResults[i]; });
      body.innerHTML = renderLive(liveData);

      clearPoll();
      _pollTimer = setInterval(refresh, 8000);
    } else {
      setMode('post', 'Paper + Live combined · refreshed ' + istDateISO());
      var [paper, live] = await Promise.all([
        fetchJSON('/consolidation/data?enabledOnly=1'),
        fetchJSON('/live-consolidation/data?enabledOnly=1'),
      ]);
      var paperTrades = (paper && paper.trades) || [];
      var liveTrades  = (live  && live.trades)  || [];
      body.innerHTML = renderPostMarket(paperTrades, liveTrades);

      clearPoll();
      _pollTimer = setInterval(refresh, 60000); // every minute after-hours (covers session end)
    }
  }

  refresh();
})();

// ── Check Trading Status — slim dismissible notification pill ────────────────
function dismissStatusAlert(){
  var d=document.getElementById('trading-status-alert');
  if(d){d._dismissed=true;d.style.display='none';}
}
function showStatusPill(alertDiv, icon, msg, color, dismissible){
  if(alertDiv._dismissed) return;
  alertDiv.style.display = 'block';
  alertDiv.innerHTML = '<div style="display:inline-flex;align-items:center;gap:6px;background:#07111f;border:0.5px solid '
    +color+';border-radius:20px;padding:3px 10px 3px 8px;font-size:0.68rem;color:'+color+';white-space:nowrap;">'
    +'<span>'+icon+'</span> <span>'+msg+'</span>'
    + (dismissible === false ? '' :
       ' <span class="status-pill-dismiss" role="button" aria-label="Dismiss" tabindex="0" onclick="dismissStatusAlert()" style="cursor:pointer;opacity:0.5;margin-left:4px;">&#x2715;</span>')
    +'</div>';
}
async function checkTradingStatus(){
  try {
    var alertDiv = document.getElementById('trading-status-alert');
    var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    var day = now.getDay(); var hour = now.getHours();
    var todayStr = now.toISOString().split('T')[0];

    // Holiday check runs first and unconditionally so the Start All button
    // is hidden regardless of weekend/pre/post-market early-returns below.
    var isHoliday = false;
    try {
      var hres = await fetch('/api/holidays', {cache:'no-store'});
      if(hres.ok){
        var hdata = await hres.json();
        if(hdata && hdata.success && hdata.holidays && hdata.holidays.includes(todayStr)){
          isHoliday = true;
        }
      }
    } catch(e){}
    // Markets shut = nothing to start: hide BOTH Start-All buttons (paper and
    // harness), not just the paper one.
    _marketsClosed = isHoliday || day === 0 || day === 6;
    ['btn-all-start','btn-all-harness'].forEach(function(id){
      var b = document.getElementById(id);
      if(b) b.style.display = _marketsClosed ? 'none' : '';
    });

    if(!alertDiv || alertDiv._dismissed) return;
    if(isHoliday){
      showStatusPill(alertDiv, '🎉', 'NSE Holiday — markets closed today', '#fbbf24', false); return;
    }
    if(day === 0 || day === 6){
      // Not dismissible: the weekend state lasts all day, so a ✕ only hides a
      // fact the user cannot change.
      showStatusPill(alertDiv, '🏖️', 'Weekend — markets resume Monday 9:15 AM', '#ef4444', false); return;
    }
    if(hour < 7 || hour >= 16){
      showStatusPill(alertDiv, '🕐', hour < 7 ? 'Pre-market — opens 9:15 AM IST' : 'Post-market — closed for the day', '#60a5fa'); return;
    }
    alertDiv.style.display = 'none';
  } catch(e){}
}
checkTradingStatus();
setInterval(checkTradingStatus, 60000); // Check every minute
/* setInterval(pollDashboardStatus, 4000); — disabled (no realtime data on dashboard) */

// Auto-swap to Real-Time view as soon as a session starts (UI_SHOW_REALTIME).
// Suspended while a Start-All run is in flight: that loop fires one /start per
// strategy SEQUENTIALLY from this page, and the first strategy to come up would
// otherwise trip this poll within 10s and navigate the page away — cancelling
// every /start still queued behind it, with no error shown. That is the
// "I pressed Start All but only the first few strategies started" bug.
async function pollSessionActiveSwap(){
  if (_startAllBusy) return;
  try {
    var r = await fetch('/api/session-active', { cache:'no-store' });
    if (!r.ok) return;
    var j = await r.json();
    if (j && j.active === true) location.replace('/');
  } catch(e){}
}
setInterval(pollSessionActiveSwap, 10000);
// ─────────────────────────────────────────────────────────────────────────────

// ── Option expiry quick-save (dashboard mirror of the Settings fields) ───────
// Writes OPTION_EXPIRY_OVERRIDE + OPTION_EXPIRY_TYPE through POST /settings/save,
// so the audit log + per-mode daily settings snapshot behave exactly as they do
// when the change is made on the Settings page. Both keys are INSTANT effect.
// The route fans the pair out into every per-strategy expiry key server-side, so
// this stays a two-key POST — do NOT list the per-mode keys here, or they would
// count as "explicitly sent" and opt themselves OUT of that fan-out.
async function saveDashExpiry(btn){
  var dateEl = document.getElementById('dashExpiryDate');
  var typeEl = document.getElementById('dashExpiryType');
  if(!dateEl || !typeEl) return;
  var label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    var res = await secretFetch('/settings/save', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        updates: {
          OPTION_EXPIRY_OVERRIDE: (dateEl.value || '').trim(),
          OPTION_EXPIRY_TYPE: typeEl.value
        },
        note: 'dashboard: option expiry quick-edit'
      })
    });
    if(!res){ btn.disabled = false; btn.textContent = label; return; }
    var d = await res.json();
    if(d && d.success){
      // success:true only means process.env was updated — the .env write can
      // still have failed, and the section auto-fill can pull in a key that
      // needs a restart. Settings surfaces both; a green tick here while the
      // change silently dies on the next PM2 restart would be worse than a
      // plain failure, so mirror the same three outcomes.
      if(!d.fileSaved){
        await showAlert({
          icon:'⚠️', title:'Applied, but NOT written to .env',
          message:'The new expiry is live right now, but saving .env failed:\\n'
                + (d.fileError || 'unknown error')
                + '\\n\\nIt will be lost the next time the server restarts. Fix the file and save again.',
          btnClass:'modal-btn-danger'
        });
        btn.textContent = '⚠ Not saved';                    // never a tick — the change is not durable
        setTimeout(function(){ location.reload(); }, 700);
        return;
      }
      if(d.needsRestart && d.needsRestart.length){
        await showAlert({
          icon:'🔄', title:'Saved — restart needed',
          message:'Written to .env. These keys only take effect after a restart:\\n'
                + d.needsRestart.join(', '),
          btnClass:'modal-btn-primary'
        });
      }
      btn.textContent = '✓ Saved';
      setTimeout(function(){ location.reload(); }, 700);   // refresh expiry pill + stale-expiry banner
    } else {
      btn.disabled = false; btn.textContent = label;
      showAlert({icon:'❌',title:'Save Failed',message:(d && d.error) || 'Could not save expiry settings.',btnClass:'modal-btn-danger'});
    }
  } catch(e){
    btn.disabled = false; btn.textContent = label;
    showAlert({icon:'❌',title:'Save Failed',message:e.message,btnClass:'modal-btn-danger'});
  }
}

// refreshHolidays() lives in sharedNav's expiryHolidayModalJS() (injected above)
// syncToLocal() moved to /docs page
</script>
</div></div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
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
  // alive means trading real money on possibly-corrupt in-memory state. Exit so
  // PM2 restarts into a clean process and boot-time reconciliation re-verifies
  // every open position. We already alerted above, so mark plannedExit to skip
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
  console.log(`   Live Trading     : ${process.env.EMA_RSI_ST_LIVE_ENABLED === "true" ? "✅ ENABLED" : "🔒 disabled"}`);
  console.log(`   BB_RSI Mode       : ${(process.env.BB_RSI_MODE_ENABLED || "true") === "true" ? "✅ ENABLED" : "🔒 disabled"} | BB_RSI_ENABLED: ${process.env.BB_RSI_ENABLED === "true" ? "✅" : "❌"}`);
  console.log(`   VIX Filter       : ${process.env.VIX_FILTER_ENABLED !== "false" ? `✅ max=${process.env.VIX_MAX_ENTRY || "20"} strong=${process.env.VIX_STRONG_ONLY || "16"}` : "🔒 disabled"}`);
  console.log(`   Hard SL          : ${process.env.HARD_SL_ENABLED === "true" ? `✅ delta=${process.env.HARD_SL_DELTA || "0.5"}` : "🔒 disabled"}`);
  console.log(`   Telegram         : ${process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? "✅ configured" : "❌ not set"}`);
  console.log(`   Login Gate       : ${process.env.LOGIN_SECRET ? "✅ active" : "🔓 open (no LOGIN_SECRET)"}`);
  console.log(`   Node             : ${process.version} | PID: ${process.pid}`);

  // Tick-recorder disk cleanup — runs once at startup and then every 24h.
  // Default retention 30 days (~300 MB). Tunable via TICK_RECORDER_RETAIN_DAYS.
  try {
    const tickRecorder = require("./utils/tickRecorder");
    const r = tickRecorder.pruneOldRecordings();
    if (r.deleted > 0) console.log(`   Tick recordings  : pruned ${r.deleted} day(s) older than ${r.retainDays}d (kept ${r.kept})`);
    setInterval(() => { try { tickRecorder.pruneOldRecordings(); } catch (_) {} }, 24 * 3600_000).unref();
  } catch (err) {
    console.warn(`   Tick recordings  : prune skipped — ${err.message}`);
  }

  // Day-wide option-chain + VIX + futures-OI recorder — strategy-independent, so
  // a SNAPSHOT replay is reproducible for ANY strategy (not just the strike a
  // live strategy traded). Pure observer; rides the existing socket fan-out and
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

  // Expiry health — resolves the option expiry ahead of the open, rolls a blank
  // or expired OPTION_EXPIRY_OVERRIDE to the newly-resolved date (Settings and
  // the Dashboard strip both read process.env, so both update), and raises the
  // Dashboard banner + a Telegram when nothing can be resolved.
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

  // ── Startup position reconciliation (crash recovery) ───────────────────────
  // Checks both brokers for orphaned positions that survived a crash/restart.
  // Alert-only — does NOT auto-close (too risky without user confirmation).
  reconcileOrphanedPositions();

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

  // ── Weekly settings-advisor snapshot (Sunday 08:00 IST, offline) ───────────
  try { require("./utils/settingsAdvisor").start(); }
  catch (err) { console.warn(`[advisor] scheduler start failed: ${err.message}`); }
});

// ── Position Reconciliation — detect orphaned positions after crash ──────────
async function reconcileOrphanedPositions() {
  try {
    // ── Check persisted position files first (bot was tracking a live position) ──
    const savedTrade = loadTradePosition();
    if (savedTrade && savedTrade.position) {
      const p = savedTrade.position;
      const msg = `🚨 [STARTUP] Persisted TRADE position found (crash recovery)!\n` +
        `  ${p.side} ${p.symbol}: entry=₹${p.entryPrice} SL=₹${p.stopLoss} qty=${p.qty}\n` +
        `  Saved at: ${new Date(savedTrade.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `Bot was tracking this before crash. Check Zerodha dashboard!`;
      console.warn(msg);
      sendTelegram(msg);
      // Don't clear — keep file until user manually starts a new session
    }

    const savedBbRsi = loadBbRsiPosition();
    if (savedBbRsi && savedBbRsi.position) {
      const p = savedBbRsi.position;
      const msg = `🚨 [STARTUP] Persisted BB_RSI position found (crash recovery)!\n` +
        `  ${p.side} ${p.symbol}: entry=₹${p.entryPrice} SL=₹${p.stopLoss} qty=${p.qty}\n` +
        `  Saved at: ${new Date(savedBbRsi.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `Bot was tracking this before crash. Check Fyers dashboard!`;
      console.warn(msg);
      sendTelegram(msg);
    }

    const savedPA = loadPAPosition();
    if (savedPA && savedPA.position) {
      const p = savedPA.position;
      const msg = `🚨 [STARTUP] Persisted PA position found (crash recovery)!\n` +
        `  ${p.side} ${p.symbol}: entry=₹${p.entryPrice} SL=₹${p.stopLoss} qty=${p.qty}\n` +
        `  Saved at: ${new Date(savedPA.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `Bot was tracking this before crash. Check Fyers dashboard!`;
      console.warn(msg);
      sendTelegram(msg);
    }

    const savedEma9Vwap = loadEma9VwapPosition();
    if (savedEma9Vwap && savedEma9Vwap.position) {
      const p = savedEma9Vwap.position;
      const msg = `🚨 [STARTUP] Persisted EMA9+VWAP position found (crash recovery)!\n` +
        `  ${p.side} ${p.symbol}: entry=₹${p.entryPrice} qty=${p.qty}\n` +
        `  Saved at: ${new Date(savedEma9Vwap.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `Bot was tracking this before crash. Check Zerodha dashboard!`;
      console.warn(msg);
      sendTelegram(msg);
    }

    const savedOrb = loadOrbPosition();
    if (savedOrb && savedOrb.position) {
      const p = savedOrb.position;
      const msg = `🚨 [STARTUP] Persisted ORB position found (crash recovery)!\n` +
        `  ${p.side} ${p.symbol}: entry=₹${p.entryPrice} SL=₹${p.stopLoss} qty=${p.qty}\n` +
        `  Saved at: ${new Date(savedOrb.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `Bot was tracking this before crash. Check Fyers dashboard!`;
      console.warn(msg);
      sendTelegram(msg);
    }

    const savedTds = loadTrendDayScalpPosition();
    if (savedTds && savedTds.position) {
      const p = savedTds.position;
      const msg = `🚨 [STARTUP] Persisted TREND_DAY_SCALP position found (crash recovery)!\n` +
        `  ${p.side} ${p.symbol}: entry=₹${p.entryPrice} SL=₹${p.stopLoss} TGT=₹${p.target} qty=${p.qty}${p.beArmed ? " (breakeven ARMED)" : ""}\n` +
        `  Saved at: ${new Date(savedTds.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `Bot was tracking this before crash. Check Fyers dashboard!`;
      console.warn(msg);
      sendTelegram(msg);
    }

    const savedHaScalp = loadHaScalpPosition();
    if (savedHaScalp && savedHaScalp.position) {
      const p = savedHaScalp.position;
      const msg = `🚨 [STARTUP] Persisted HA_SCALP position found (crash recovery)!\n` +
        `  ${p.side} ${p.symbol}: entry=₹${p.entryPrice} SL=₹${p.stopLoss} qty=${p.qty}\n` +
        `  Saved at: ${new Date(savedHaScalp.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `Bot was tracking this before crash. Check your broker dashboard!`;
      console.warn(msg);
      sendTelegram(msg);
    }

    const savedEarlyBird = loadEarlyBirdPositions();
    // The OPTION leg is not in positions[] — it is saved under sessionMeta — so
    // in option-ONLY mode that array is legitimately empty while a real NIFTY
    // option position is open. Testing the array alone meant an option-only
    // crash raised NO alert, even though the retention gate below correctly
    // kept the snapshot. Both legs are checked here, and each is described in
    // its own terms: equity names have share counts, the option has a premium.
    const _ebOptPos = savedEarlyBird && savedEarlyBird.sessionMeta
      ? savedEarlyBird.sessionMeta.optionPosition : null;
    const _ebStockPos = savedEarlyBird && Array.isArray(savedEarlyBird.positions)
      ? savedEarlyBird.positions : [];
    if (savedEarlyBird && (_ebStockPos.length || _ebOptPos)) {
      // EarlyBird is the only multi-position strategy here, and its stock legs are
      // CASH EQUITY in individual stocks — not a NIFTY option — so the message
      // lists every open name rather than a single symbol.
      const lines = _ebStockPos.map(p =>
        `  ${p.side} ${p.qty}×${p.symbol}: entry=₹${p.entryPrice} SL=₹${p.stop} TGT=₹${p.target}`).join("\n");
      const optLine = _ebOptPos
        ? `  OPTION ${_ebOptPos.optionSide || ""} ${_ebOptPos.qty}×${_ebOptPos.symbol}: entry=₹${_ebOptPos.optionEntryLtp} premium` +
          ` (${_ebOptPos.side} signal; SL/TGT are SPOT ${_ebOptPos.stop}/${_ebOptPos.target})`
        : "";
      const pend = Array.isArray(savedEarlyBird.pendingSetups) ? savedEarlyBird.pendingSetups.length : 0;
      const what = [
        _ebStockPos.length ? `${_ebStockPos.length} open EQUITY position(s)` : "",
        _ebOptPos ? `1 open OPTION position` : "",
      ].filter(Boolean).join(" + ");
      const msg = `🚨 [STARTUP] Persisted EARLYBIRD position(s) found (crash recovery)!\n` +
        `  ${what}` + (pend ? `, ${pend} pending setup(s)` : "") + `\n` +
        [lines, optLine].filter(Boolean).join("\n") + `\n` +
        `  Saved at: ${new Date(savedEarlyBird.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `Bot was tracking these before crash. Check Fyers dashboard!`;
      console.warn(msg);
      sendTelegram(msg);
    }

    const savedSimple930 = loadSimple930Position();
    if (savedSimple930 && savedSimple930.position) {
      const p = savedSimple930.position;
      const msg = `🚨 [STARTUP] Persisted SIMPLE_9:30 position found (crash recovery)!\n` +
        `  ${p.side} ${p.symbol}: entry=₹${p.optionEntryLtp} SL=₹${p.stop} peak=₹${p.peak} qty=${p.qty}\n` +
        `  Saved at: ${new Date(savedSimple930.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `Bot was tracking this before crash. Orders go to ZERODHA — check the Zerodha dashboard!`;
      console.warn(msg);
      sendTelegram(msg);
    }

    const savedRsiPivotSt = loadRsiPivotStPosition();
    if (savedRsiPivotSt && savedRsiPivotSt.position) {
      const p = savedRsiPivotSt.position;
      const msg = `🚨 [STARTUP] Persisted RSI_PIVOT_ST position found (crash recovery)!\n` +
        `  ${p.side} ${p.symbol}: entry=₹${p.optionEntryLtp} SL=${p.stopLoss != null ? p.stopLoss : "no SuperTrend stop"} ` +
        `floor=${p.premiumFloor != null ? `₹${p.premiumFloor}` : "NONE (premium stop off for this side)"} qty=${p.qty}\n` +
        (p.stopLoss == null && p.premiumFloor == null ? `  ⚠️ THIS POSITION HAS NO STOP AT ALL — only the EOD square-off can close it.\n` : "") +
        `  Saved at: ${new Date(savedRsiPivotSt.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `Bot was tracking this before crash. Orders go to ZERODHA — check the Zerodha dashboard!`;
      console.warn(msg);
      sendTelegram(msg);
    }

    const savedTrendPb = loadTrendPbPosition();
    if (savedTrendPb && savedTrendPb.position) {
      const p = savedTrendPb.position;
      const msg = `🚨 [STARTUP] Persisted Trend_PB position found (crash recovery)!\n` +
        `  ${p.side} ${p.symbol}: entry=₹${p.entryPrice} SL=₹${p.stopLoss} qty=${p.qty}\n` +
        `  Saved at: ${new Date(savedTrendPb.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `Bot was tracking this before crash. Check Fyers dashboard!`;
      console.warn(msg);
      sendTelegram(msg);
    }

    // Only the retain-on-unreadable-book guard needs to fire when real orders are
    // possible. In paper-only mode (harness dry-run AND no native live enabled) a
    // snapshot never maps to a real broker position, so clearing it on an empty
    // book is always safe — skip the guard to avoid a spurious every-boot warning.
    const _liveActive =
      (process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() !== "true" ||
      ["EMA_RSI_ST", "BB_RSI", "PA", "ORB", "EMA9VWAP", "TREND_PB", "TDS", "HA_SCALP", "SIMPLE930", "RSI_PIVOT_ST", "EARLYBIRD"].some(
        (s) => (process.env[`${s}_LIVE_ENABLED`] || "").toLowerCase() === "true",
      );

    // ── Check broker positions (live API) ──
    if (zerodha.isAuthenticated()) {
      const zPos = await zerodha.getPositions();
      const zOpen = (zPos.net || zPos.day || []).filter(p =>
        p.quantity !== 0 && p.tradingsymbol && p.tradingsymbol.includes("NIFTY")
      );
      if (zOpen.length > 0) {
        const msg = `🚨 [STARTUP] Orphaned Zerodha position detected!\n` +
          zOpen.map(p => `  ${p.tradingsymbol}: qty=${p.quantity} pnl=₹${p.pnl || 0}`).join("\n") +
          `\nBot is NOT tracking this. Check Zerodha dashboard and close manually if needed.`;
        console.warn(msg);
        sendTelegram(msg);
      } else {
        // An EMPTY book is ambiguous — both brokers return [] on a swallowed API
        // error too, so "empty + snapshot present" must NOT clear the snapshot
        // (that would mask a real orphan). Only clear when the book was provably
        // readable (non-empty); otherwise retain + warn and re-check next boot.
        const _zReadable = ((zPos.net || []).length + (zPos.day || []).length) > 0;
        // Count only snapshots that actually carry a position — loadTradePosition()
        // returns the parsed file whenever it exists and is today's, even if the
        // record has no `.position`, which used to trigger a spurious
        // "retaining unverified snapshot" warning on an empty record.
        const _zSnaps = [savedTrade, savedEma9Vwap, savedRsiPivotSt, savedSimple930, savedHaScalp].filter(x => x && x.position).length;
        if (_liveActive && _zSnaps > 0 && !_zReadable) {
          const msg = `⚠️ [STARTUP] Zerodha book came back EMPTY — can't tell flat from an API error. Retaining ${_zSnaps} crash snapshot(s) UNVERIFIED (re-checking next boot). Check Zerodha dashboard.`;
          console.warn(msg); sendTelegram(msg);
        } else {
          console.log("✅ [STARTUP] Zerodha: no orphaned positions.");
          if (savedTrade) clearTradePosition();  // broker confirms no position — safe to clear stale file
          if (savedEma9Vwap) clearEma9VwapPosition(); // EMA9+VWAP trades Zerodha too — safe to clear
          if (savedRsiPivotSt) clearRsiPivotStPosition(); // RSI_PIVOT_ST places its orders on Zerodha as well
          if (savedSimple930) clearSimple930Position();   // SIMPLE_9:30 is a Zerodha strategy too (Fyers data, Zerodha orders)
          if (savedHaScalp) clearHaScalpPosition();       // HA_SCALP likewise — Fyers candles, Zerodha orders
        }
      }
    }

    if (fyersBroker.isAuthenticated()) {
      const fPos = await fyersBroker.getPositions();
      // EarlyBird trades CASH EQUITY in individual stocks, so a NIFTY-only
      // filter would silently miss every one of its orphans. Match a NIFTY leg
      // (every other strategy here) OR any non-zero equity leg (-EQ).
      const fOpen = (fPos.netPositions || []).filter(p =>
        p.netQty !== 0 && p.symbol && (p.symbol.includes("NIFTY") || /-EQ$/.test(p.symbol))
      );
      if (fOpen.length > 0) {
        const msg = `🚨 [STARTUP] Orphaned Fyers position detected!\n` +
          fOpen.map(p => `  ${p.symbol}: qty=${p.netQty} pnl=₹${p.pl || 0}`).join("\n") +
          `\nBot is NOT tracking this. Check Fyers dashboard and close manually if needed.`;
        console.warn(msg);
        sendTelegram(msg);
      } else {
        // Empty Fyers book is ambiguous (genuinely flat OR a swallowed API error
        // that also returns []). Only clear snapshots when the book was provably
        // readable; otherwise retain + warn so a real orphan isn't masked.
        const _fReadable = Array.isArray(fPos.netPositions) && fPos.netPositions.length > 0;
        // EarlyBird's snapshot carries an ARRAY, so it is counted differently.
        // Its OPTION leg (EARLYBIRD_TRADE_MODE=option|both) lives in sessionMeta
        // instead of that array, so in option-ONLY mode `positions` is legitimately
        // empty while a real position is open — counting only the array there would
        // clear the one snapshot proving the orphan.
        const _ebHasPos = !!(savedEarlyBird && (
          (Array.isArray(savedEarlyBird.positions) && savedEarlyBird.positions.length) ||
          (savedEarlyBird.sessionMeta && savedEarlyBird.sessionMeta.optionPosition)
        ));
        const _fSnaps = [savedBbRsi, savedPA, savedOrb, savedTrendPb, savedTds].filter(x => x && x.position).length +
          (_ebHasPos ? 1 : 0);
        if (_liveActive && _fSnaps > 0 && !_fReadable) {
          const msg = `⚠️ [STARTUP] Fyers book came back EMPTY — can't tell flat from an API error. Retaining ${_fSnaps} crash snapshot(s) UNVERIFIED (re-checking next boot). Check Fyers dashboard.`;
          console.warn(msg); sendTelegram(msg);
        } else {
          console.log("✅ [STARTUP] Fyers: no orphaned positions.");
          // BB_RSI + PA + ORB + Trend_PB + TREND_DAY_SCALP all trade on Fyers; broker-flat means any stale snapshot is safe to clear.
          if (savedBbRsi)   clearBbRsiPosition();  // broker confirms no position — safe to clear
          if (savedPA)      clearPAPosition();
          if (savedOrb)     clearOrbPosition();
          if (savedTrendPb) clearTrendPbPosition();
          if (savedTds)     clearTrendDayScalpPosition();
          if (savedEarlyBird) clearEarlyBirdPositions();  // EarlyBird is a Fyers strategy (equity orders + data)
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ [STARTUP] Position reconciliation failed: ${err.message}`);
  }
}

// ── Graceful Shutdown — square off positions on SIGTERM/SIGINT ───────────────
// When PM2 or Docker sends SIGTERM, attempt to exit open positions before dying.
// Calls stopSession() on each active mode to trigger squareOff for live modes.
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
    if (sharedSocketState.getSimple930Mode && sharedSocketState.getSimple930Mode()) activeModes.push(sharedSocketState.getSimple930Mode());
    if (sharedSocketState.getRsiPivotStMode && sharedSocketState.getRsiPivotStMode()) activeModes.push(sharedSocketState.getRsiPivotStMode());

    if (activeModes.length === 0) {
      // No Telegram here: with no live positions in play there is nothing the
      // user needs to verify on a broker dashboard, and PM2 reloads on every
      // deploy were producing a stream of identical SHUTDOWN messages.
      console.log("✅ [SHUTDOWN] No active trading modes — clean exit.");
      process.exit(0);
      return;
    }

    const modeList = activeModes.join(", ");
    // A harness-live session runs under a *_PAPER mode string, so the mode list
    // alone can't tell us real orders are in play — ask the harness directly.
    let _harnessLive = false;
    try { _harnessLive = require("./services/liveHarness").hasLiveHarness(); } catch (_) {}
    const hasLive = _harnessLive || activeModes.some(m =>
      m === "EMA_RSI_ST_LIVE" || m === "BB_RSI_LIVE" || m === "PA_LIVE" ||
      m === "ORB_LIVE" || m === "EMA9VWAP_LIVE" || m === "TREND_PB_LIVE" ||
      m === "TREND_DAY_SCALP_LIVE" || m === "HA_SCALP_LIVE" ||
      m === "EARLY_BIRD_LIVE" ||
      m === "SIMPLE930_LIVE" ||
      m === "RSI_PIVOT_ST_LIVE");
    console.warn(`⚠️ [SHUTDOWN] Active modes: ${modeList}${_harnessLive ? " (harness LIVE)" : ""} — stopping sessions...`);

    // Call stopSession() on each active route — this triggers squareOff for live
    // modes. Routes without a stopSession export are skipped by the guard below.
    const routeMap = {
      "EMA_RSI_ST_LIVE": require("./routes/emaRsiStLive"),
      "EMA_RSI_ST_PAPER":require("./routes/emaRsiStPaper"),
      "BB_RSI_LIVE":     require("./routes/bbRsiLive"),
      "BB_RSI_PAPER":    require("./routes/bbRsiPaper"),
      "PA_LIVE":        require("./routes/paLive"),
      "PA_PAPER":       require("./routes/paPaper"),
      "ORB_PAPER":      require("./routes/orbPaper"),
      "ORB_LIVE":       require("./routes/orbLive"),
      "EMA9VWAP_PAPER": require("./routes/ema9vwapPaper"),
      "TREND_PB_PAPER": require("./routes/trendPbPaper"),
      "TREND_DAY_SCALP_PAPER": require("./routes/trendDayScalpPaper"),
      "HA_SCALP_PAPER":        require("./routes/haScalpPaper"),
      "EARLY_BIRD_PAPER":      require("./routes/earlyBirdPaper"),
      "SIMPLE930_PAPER":       require("./routes/simple930Paper"),
      "RSI_PIVOT_ST_PAPER":    require("./routes/rsiPivotStPaper"),
    };
    for (const mode of activeModes) {
      const route = routeMap[mode];
      if (route && typeof route.stopSession === "function") {
        try {
          console.log(`🔄 [SHUTDOWN] Stopping ${mode}...`);
          // await: a live route's stopSession squares off through the broker and is
          // async. Firing it un-awaited let the shutdown march on (and process.exit
          // fire) while the exit order was still in flight. Sync stopSessions are
          // unaffected — awaiting a non-promise resolves immediately.
          await route.stopSession();
        } catch (err) {
          console.error(`⚠️ [SHUTDOWN] Error stopping ${mode}: ${err.message}`);
        }
      }
    }

    // Belt-and-braces: drop every live harness after the sessions were stopped.
    // Each route's stopSession() already releases its own, but an exception in one
    // of them must not leave order hooks armed while the process winds down.
    try { require("./services/liveHarness").uninstallHarness(); } catch (_) {}

    // Send Telegram alert SYNCHRONOUSLY (curl-based) so the message is
    // flushed before process.exit fires in 3-8s. An async https.request
    // here gets abandoned on exit if the API round-trip is slow, which
    // produces "silent restart" symptoms. Include memory stats so we can
    // tell whether pm2 killed us for a memory cap.
    try {
      const mu = process.memoryUsage();
      const memLine = `RSS=${(mu.rss/1048576).toFixed(0)}MB heap=${(mu.heapUsed/1048576).toFixed(0)}/${(mu.heapTotal/1048576).toFixed(0)}MB ext=${(mu.external/1048576).toFixed(0)}MB`;
      const uptime  = `uptime=${Math.floor(process.uptime())}s`;
      if (hasLive) {
        sendTelegramSync(`🛑 SHUTDOWN: Bot received ${signal}. Live modes stopped: ${modeList} — squareOff triggered. Verify on broker dashboard.\n${memLine} ${uptime}`);
      } else {
        sendTelegramSync(`ℹ️ SHUTDOWN: Bot received ${signal}. Paper modes stopped: ${modeList} (no real positions affected).\n${memLine} ${uptime}`);
      }
    } catch (_) {}

    // Wait for squareOff orders to complete before exiting. The harness exit is
    // sequential — getPositions reconcile (≤3s) + cancel-SL + SELL (≤HARNESS_BROKER_TIMEOUT_MS,
    // default 8s) — so the live drain must exceed that or process.exit() abandons an
    // in-flight square-off. Scale off the configured broker timeout + margin.
    const _harnessTimeout = Math.max(1500, parseInt(process.env.HARNESS_BROKER_TIMEOUT_MS || "8000", 10));
    const waitMs = hasLive ? (3000 + _harnessTimeout + 2000) : 3000;
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
require("dotenv").config();
require("./services/logger");              // ← MUST be first: intercepts all console.* from here on

const express     = require("express");
const compression = require("compression");
const https       = require("https");
const fs          = require("fs");
const { ACTIVE, getActiveStrategy } = require("./strategies");
const instrumentConfig = require("./config/instrument");
const zerodha  = require("./services/zerodhaBroker");
const { clearFyersToken } = require("./config/fyers");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("./utils/sharedNav");
const sharedSocketState = require("./utils/sharedSocketState");

const crypto = require("crypto");
const loginLogStore = require("./utils/loginLogStore");
const fyersBroker   = require("./services/fyersBroker");
const { sendTelegram, sendTelegramSync, getTelegramHealth } = require("./utils/notify");
const consolidatedEodReporter = require("./utils/consolidatedEodReporter");
const { loadTradePosition, clearTradePosition, loadBbRsiPosition, clearBbRsiPosition, loadPAPosition, clearPAPosition, loadEma9VwapPosition, clearEma9VwapPosition, loadOrbPosition, clearOrbPosition, loadTrendPbPosition, clearTrendPbPosition } = require("./utils/positionPersist");
const app = express();
app.use(compression());
app.use(express.json());

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
function loginPageHTML(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — Trading Bot</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>ௐ</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#080c14;font-family:'IBM Plex Sans',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.login-box{background:#0d1320;border:1px solid #1a2236;border-radius:14px;padding:40px 36px;width:360px;max-width:90vw;box-shadow:0 8px 40px rgba(0,0,0,0.5);}
.login-icon{font-size:2rem;text-align:center;margin-bottom:12px;}
.login-title{font-size:1rem;font-weight:700;color:#e0eaf8;text-align:center;margin-bottom:4px;}
.login-sub{font-size:0.7rem;color:#3a5070;text-align:center;margin-bottom:24px;}
.login-input{width:100%;padding:11px 14px;border-radius:8px;border:1px solid #1a2a40;background:#070d18;color:#e0eaf8;font-size:0.85rem;font-family:inherit;outline:none;transition:border-color 0.15s;}
.login-input:focus{border-color:#3b82f6;}
.login-btn{width:100%;margin-top:14px;padding:11px;border-radius:8px;border:none;background:#1e40af;color:#fff;font-size:0.82rem;font-weight:700;font-family:inherit;cursor:pointer;transition:background 0.15s;}
.login-btn:hover{background:#2563eb;}
.login-error{margin-top:12px;padding:8px 12px;border-radius:7px;background:#1c0610;border:1px solid #500e20;color:#f87171;font-size:0.75rem;text-align:center;display:${error ? 'block' : 'none'};}
:root[data-theme="light"] { background-color:#f4f6f9; }
:root[data-theme="light"] body { background:#f4f6f9; }
:root[data-theme="light"] .login-box { background:#ffffff; border-color:#e0e4ea; box-shadow:0 8px 40px rgba(0,0,0,0.1); }
:root[data-theme="light"] .login-title { color:#1e293b; }
:root[data-theme="light"] .login-sub { color:#94a3b8; }
:root[data-theme="light"] .login-input { background:#f8fafc; border-color:#e0e4ea; color:#1e293b; }
:root[data-theme="light"] .login-input:focus { border-color:#3b82f6; }
:root[data-theme="light"] .login-btn { background:#2563eb; }
:root[data-theme="light"] .login-btn:hover { background:#1d4ed8; }
:root[data-theme="light"] .login-error { background:#fef2f2; border-color:#fecaca; color:#dc2626; }
</style></head><body>
<div class="login-box">
<div class="login-icon">🔒</div>
<div class="login-title">Trading Bot</div>
<div class="login-sub">Enter password to continue</div>
<form id="loginForm" method="POST" action="/login">
<input type="password" name="password" id="pwdInput" class="login-input" placeholder="Password" autofocus required>
<input type="hidden" name="lat" id="lat">
<input type="hidden" name="lon" id="lon">
<input type="hidden" name="geoCity" id="geoCity">
<button type="submit" class="login-btn">Login</button>
</form>
<div class="login-error">${error || ''}</div>
</div>
<script>
(function(){
  if ('${process.env.UI_THEME || "dark"}' === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }
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
  res.send(loginPageHTML());
});

// ── Login rate limiting — brute-force protection ─────────────────────────────
// Limits are read live from env so Settings edits take effect on the next attempt.
const _loginAttempts = {};  // { ip: { count, firstAttempt } }
let _lastLoginSweep = 0;
function _loginRateMax()    { const n = Number(process.env.LOGIN_RATE_MAX);        return Number.isFinite(n) && n >= 1 ? n : 5; }
function _loginRateWindow() { const m = Number(process.env.LOGIN_RATE_WINDOW_MIN); return (Number.isFinite(m) && m >= 1 ? m : 15) * 60 * 1000; }

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
  }
  if (_loginAttempts[ip]) {
    const entry = _loginAttempts[ip];
    if (now - entry.firstAttempt > winMs) {
      // Window expired — reset
      _loginAttempts[ip] = { count: 0, firstAttempt: now };
    } else if (entry.count >= maxTry) {
      const waitMin = Math.ceil((winMs - (now - entry.firstAttempt)) / 60000);
      console.warn(`🚫 [LOGIN] Rate limited IP ${ip} — ${entry.count} failed attempts. Wait ${waitMin}min.`);
      res.setHeader("Content-Type", "text/html");
      return res.status(429).send(loginPageHTML(`Too many attempts. Try again in ${waitMin} minutes.`));
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
  "/tracker/status",          // read-only tracker page
  "/tracker/status/data",     // AJAX poll — must be open
  "/tracker/fetch-and-start", // auto-fetch + start (Zerodha read + SAR compute)
  "/result",                // read-only results
  "/result/all",
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
  "/trade-logs",            // per-trade JSONL viewer (read-only)
  "/trade-logs/list",       // JSON: list of daily JSONL files
  "/trade-logs/view",       // JSON: parsed trades for one file
  "/trade-logs/download",   // download raw JSONL
  "/trade-logs/download-all",   // concat-download all daily trade JSONLs per mode
  "/trade-logs/audit",      // JSON: settings audit (read-only)
  "/trade-logs/skips/list",     // JSON: list of daily skip files
  "/trade-logs/skips/view",     // JSON: parsed skip lines for one file
  "/trade-logs/skips/download", // download raw skip JSONL
  "/trade-logs/skips/download-all", // concat-download all daily skip JSONLs per mode
  // NOTE: POST /trade-logs/delete and POST /trade-logs/skips/delete are intentionally protected (write ops)
  "/cache-files",           // cache / generated-file browser (read-only)
  "/cache-files/groups",    // JSON: per-group file count + size
  "/cache-files/list",      // JSON: paged files for one group
  "/cache-files/view",      // JSON: text content of one file (capped)
  "/cache-files/download",  // download one raw cache file
  "/cache-files/download-all", // download a whole group as .tar.gz
  // NOTE: POST /cache-files/delete and POST /cache-files/delete-all are intentionally protected (write ops)
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
  "/consolidation",       // read-only cross-mode trade history + analytics
  "/health",              // health check — must be open for uptime monitors / PM2 probes
  "/deploy/webhook",      // GitHub Actions webhook — must be open for GitHub to reach it
  "/deploy/status",       // deploy status poll — read-only
  // NOTE: /settings/save requires API_SECRET (write operation)
  // NOTE: /ema_rsi_st-live/start, /ema_rsi_st-live/stop, /ema_rsi_st-live/exit are intentionally NOT here — they require API_SECRET
  // NOTE: /ema_rsi_st-paper/start, /ema_rsi_st-paper/stop, /ema_rsi_st-paper/reset, /ema_rsi_st-paper/exit also require secret
  // NOTE: /api/holidays/refresh requires API_SECRET (write operation)
];
app.use((req, res, next) => {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // no secret set → open (dev mode)
  const isOpen = OPEN_PATHS.some(p => req.path === p || req.path.startsWith("/auth/callback"));
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
app.use("/deploy",         require("./routes/deploy"));         // ← GitHub Actions deploy status
app.use("/consolidation",       require("./routes/consolidation"));     // ← unified cross-mode PAPER trade history + analytics
app.use("/live-consolidation",  require("./routes/liveConsolidation")); // ← unified cross-mode LIVE trade history + analytics
app.use("/edge-analytics",      require("./routes/edgeAnalytics"));     // ← edge metrics (WR/expectancy/PF/drawdown/by-hour) over recorded trades
app.use("/consolidation-report", require("./routes/consolidationReport")); // ← printable consolidated report (paper+live, week/month/range filters, Save-as-PDF)
app.use("/realtime",            require("./routes/realtime"));          // ← unified real-time monitor (PAPER/LIVE toggle, all 3 strategies)
app.use("/replay",              require("./routes/replay"));            // ← deterministic tick-replay backtest (PAPER = REPLAY = LIVE)
app.use("/all-backtest",   require("./routes/allBacktest"));    // ← unified backtest dashboard (all 3 strategies, stats only)
app.use("/pnl-history",    require("./routes/pnlHistory"));    // ← manual year-wise P&L (Kite + Fyers) + live bot overlay

// ── Holiday Management API ────────────────────────────────────────────────────
const { refreshHolidayCache, getNSEHolidays, formatDateToYYYYMMDD } = require("./utils/nseHolidays");

app.post("/api/holidays/refresh", async (req, res) => {
  try {
    const result = await refreshHolidayCache();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/holidays", async (req, res) => {
  try {
    const holidays = await getNSEHolidays();
    res.json({ success: true, holidays, count: holidays.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── NIFTY Option Expiry Dates ─────────────────────────────────────────────────
app.get("/api/expiry-dates", async (req, res) => {
  try {
    const holidays = await getNSEHolidays();
    const year = new Date().getFullYear();
    const results = [];

    // Generate all Tuesdays (weekly) and last Tuesdays (monthly) for the year
    for (let m = 0; m < 12; m++) {
      // Last Tuesday of month (monthly expiry)
      const lastDay = new Date(year, m + 1, 0);
      const daysBack = (lastDay.getDay() - 2 + 7) % 7;
      const lastTue = new Date(year, m + 1, -daysBack);

      // All Tuesdays in this month (weekly expiry)
      let d = new Date(year, m, 1);
      const dow = d.getDay();
      const firstTue = dow <= 2 ? 2 - dow : 9 - dow;
      d.setDate(firstTue + 1);

      while (d.getMonth() === m) {
        const iso = formatDateToYYYYMMDD(d);
        const isMonthly = d.getDate() === lastTue.getDate();
        let actual = iso;
        let preponed = false;
        // Check if expiry falls on holiday → prepone to previous trading day
        if (holidays.includes(iso)) {
          let prev = new Date(d);
          for (let i = 0; i < 7; i++) {
            prev.setDate(prev.getDate() - 1);
            const pIso = formatDateToYYYYMMDD(prev);
            if (prev.getDay() !== 0 && prev.getDay() !== 6 && !holidays.includes(pIso)) {
              actual = pIso;
              preponed = true;
              break;
            }
          }
        }
        results.push({ date: iso, actual, preponed, monthly: isMonthly });
        d.setDate(d.getDate() + 7);
      }
    }
    res.json({ success: true, expiries: results, year });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Candle Cache Info ─────────────────────────────────────────────────────────
// Lightweight liveness probe so the dashboard can auto-swap to/from realtime view.
app.get("/api/session-active", (req, res) => {
  res.json({ active: !!sharedSocketState.isAnyActive() });
});

// ── Cached paper-P&L reader (dashboard wallets) ──────────────────────────────
// The dashboard reads totalPnl from up to 5 (growing) paper-trade files per load.
// Guard each read by a cheap mtime+size signature so an unchanged file is served
// from memory instead of being re-read + JSON.parsed. A trade close bumps the
// file's mtime/size, so the next read refreshes immediately (no staleness).
const _pnlReadCache = new Map(); // file -> { sig, pnl }
function _readPnlCached(dir, file) {
  const full = path.join(dir, file);
  let sig;
  try { const st = fs.statSync(full); sig = `${st.mtimeMs}:${st.size}`; }
  catch { _pnlReadCache.delete(file); return 0; }
  const hit = _pnlReadCache.get(file);
  if (hit && hit.sig === sig) return hit.pnl;
  let pnl = 0;
  try { pnl = Number(JSON.parse(fs.readFileSync(full, "utf-8")).totalPnl) || 0; }
  catch { pnl = 0; }
  _pnlReadCache.set(file, { sig, pnl });
  return pnl;
}

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
  const analyticsPanelOn = (process.env.UI_DASHBOARD_ANALYTICS_PANEL || 'true').toLowerCase() === 'true';
  const activeStrategyName = getActiveStrategy().NAME;

  // True when ANY strategy (paper or live) is currently running. While active we
  // hide the dashboard's control buttons (Start All / Reset Token), broker
  // connection cards, and schedule/cache pills so they can't be touched or
  // distract mid-trade — the running-status badge stays visible. Mirror of the
  // IDLE condition used for the top-bar badge below.
  const anyModeActive = liveActive
    || (bbRsiModeOn && bbRsiMode)
    || (paModeOn && paMode)
    || (orbModeOn && orbMode)
    || (ema9vwapModeOn && ema9vwapMode)
    || (trendPbModeOn && trendPbMode);
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
  ].filter((t) => t.on).map((t) => ({ key: t.key, cls: t.cls, label: t.label }));

  // ── Broker investment pools (paper) — remaining = pool + all-time paper P&L ──
  // Zerodha pool = EMA_RSI_ST; Fyers pool = BB_RSI + PA + ORB (enabled only).
  const _tradingDir = path.join(os.homedir(), "trading-data");
  const _readPnl = (file) => _readPnlCached(_tradingDir, file);
  const zerodhaInv = parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000");
  const fyersInv   = parseFloat(process.env.FYERS_INV_AMOUNT   || "100000");
  let zerodhaPnl = _readPnl("ema_rsi_st_paper_trades.json");
  if (ema9vwapModeOn) zerodhaPnl += _readPnl("ema9vwap_paper_trades.json"); // EMA9+VWAP also trades Zerodha
  let fyersPnl = bbRsiModeOn ? _readPnl("bb_rsi_paper_trades.json") : 0;
  if (paModeOn)       fyersPnl += _readPnl("pa_paper_trades.json");
  if (orbModeOn)      fyersPnl += _readPnl("orb_paper_trades.json");
  const _inr0 = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
  const _walletHtml = (inv, pnl) => {
    const cls = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'zero';
    const sign = pnl > 0 ? '▲ ' : pnl < 0 ? '▼ ' : '';
    return `<span class="brk-wallet" title="Investment pool: ${_inr0(inv)} + all-time paper P&L">`
      + `<span class="brk-wallet-remain">${_inr0(inv + pnl)}</span>`
      + `<span class="brk-wallet-sub">of ${_inr0(inv)} · <span class="${cls}">${sign}${_inr0(Math.abs(pnl))}</span></span>`
      + `</span>`;
  };
  const fyersWalletHtml   = _walletHtml(fyersInv, fyersPnl);
  const zerodhaWalletHtml = _walletHtml(zerodhaInv, zerodhaPnl);

  // ── Cumulative P&L placement ─────────────────────────────────────────────
  // The strategy grid is 3 columns (EMA_RSI_ST is always shown). When the enabled
  // cards leave a clean 2-column gap in their last row, the Cumulative P&L card
  // tucks into that gap beside the last card; otherwise it falls back to a
  // full-width band below the grid (the default for any other card count).
  const dashCardCount   = 1 + (bbRsiModeOn ? 1 : 0) + (paModeOn ? 1 : 0) + (orbModeOn ? 1 : 0) + (ema9vwapModeOn ? 1 : 0) + (trendPbModeOn ? 1 : 0);
  const cumInlineInGrid = (dashCardCount % 3) === 1;
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
  const cumCardInline = `<div class="dash-chart-card dash-cum-inline" id="dashCumCard">${cumCardInner}</div>`;
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
  // Trigger when OPTION_EXPIRY_OVERRIDE is set AND that expiry day's session
  // (15:30 IST close) is already past. User must update to next expiry.
  let optionExpiryAlertHtml = "";
  const manualExpiryStr = (process.env.OPTION_EXPIRY_OVERRIDE || "").trim();
  if (manualExpiryStr) {
    const parts = manualExpiryStr.split("-");
    const validShape = parts.length === 3 && !parts.some(p => isNaN(parseInt(p, 10)));
    if (validShape) {
      const expirySessionEndIST = new Date(`${manualExpiryStr}T15:30:00+05:30`);
      const nowReal = new Date();
      if (nowReal.getTime() > expirySessionEndIST.getTime()) {
        const dispDate = new Date(`${manualExpiryStr}T00:00:00+05:30`)
          .toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
        optionExpiryAlertHtml =
          `<div class="opt-expiry-alert">`
          + `<span class="opt-expiry-icon">🚨</span>`
          + `<div class="opt-expiry-text">`
          +   `<div class="opt-expiry-title">Option expiry session ended</div>`
          +   `<div class="opt-expiry-body">Manual expiry <strong>${dispDate}</strong> has passed. Update <strong>Option Expiry (manual)</strong> to the next expiry date before starting trades.</div>`
          + `</div>`
          + `<a href="/settings#OPTION_EXPIRY_OVERRIDE" class="opt-expiry-cta">Change Expiry →</a>`
          + `</div>`;
      }
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <link rel="icon" type="image/png" href="data:image/png;base64,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"/>
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
    .card-hdr-title { font-size:0.62rem; font-weight:700; text-transform:uppercase; letter-spacing:1.8px; color:#4a6080; }
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
    .broker-card.no-config       { background:#0a0a12; border-color:#1e1e36; color:#4a5878; }

    .broker-card-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
    .broker-identity { display:flex; align-items:center; gap:10px; }
    .broker-logo { width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:1.1rem; flex-shrink:0; }
    .broker-logo.fyers-logo  { background:#0d2a14; border:1px solid #0e4020; }
    .broker-logo.zerodha-logo { background:#0e0a28; border:1px solid #1e1550; }
    .broker-name-wrap { }
    .broker-name { font-size:1rem; font-weight:700; color:#e0eaf8; letter-spacing:-0.2px; }
    .broker-role { font-size:0.62rem; color:#3a5070; margin-top:1px; }
    .broker-status-pill {
      display:inline-flex; align-items:center; gap:5px;
      font-size:0.58rem; font-weight:700; text-transform:uppercase; letter-spacing:1px;
      padding:3px 9px; border-radius:20px; border:1px solid;
    }
    .broker-status-pill.ok-green { background:#071e0f; border-color:#0e4020; color:#34d399; }
    .broker-status-pill.ok-blue  { background:#07112e; border-color:#0e2860; color:#60a5fa; }
    .broker-status-pill.err      { background:#1c0610; border-color:#500e20; color:#f87171; }
    .broker-status-pill.grey     { background:#0e0e1e; border-color:#2a2a48; color:#4a5878; }
    .broker-status-dot { width:5px; height:5px; border-radius:50%; background:currentColor; }
    .broker-status-dot.pulse { animation:pulse 1.5s infinite; }

    .broker-meta { font-size:0.66rem; color:#3a5070; line-height:1.6; margin-bottom:14px; }
    .broker-meta .tag {
      display:inline-block; font-size:0.57rem; font-weight:600; text-transform:uppercase;
      letter-spacing:0.8px; padding:1px 6px; border-radius:3px; margin-right:4px;
      background:#0e1828; border:1px solid #1a2a40; color:#3a5878;
    }

    .broker-action { }
    .broker-connected-bar {
      display:flex; align-items:center; justify-content:space-between;
      padding:8px 12px; border-radius:8px; font-size:0.78rem; font-weight:600;
    }
    .broker-connected-bar.green { background:#071e0f; border:1px solid #0e3018; color:#34d399; }
    .broker-connected-bar.blue  { background:#07112e; border:1px solid #0e2045; color:#60a5fa; }
    .broker-connected-bar .relogin-link {
      font-size:0.65rem; font-weight:500; color:#2a4060;
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
      padding:9px 12px; border-radius:8px; font-size:0.7rem; color:#3a4060;
      background:#0c0c18; border:1px dashed #252550; text-align:center;
    }
    .broker-no-config code { color:#6070a0; font-family:monospace; }
    .broker-expiry-warn {
      margin-top:10px; padding:7px 10px; border-radius:7px; font-size:0.7rem; line-height:1.5;
    }
    .broker-expiry-warn.expired  { background:#2d1600; border:1px solid #c05621; color:#f6ad55; }
    .broker-expiry-warn.expiring { background:#2a1600; border:1px solid #744210; color:#fbd38d; }
    .broker-expiry-warn.valid    { background:#070d14; border:1px solid #1a3050; color:#4a7090; }

    .broker-divider { margin:14px 0 12px; height:1px; background:#1a2236; }
    .hard-reset-row { display:flex; align-items:center; justify-content:space-between; gap:16px; }
    .hard-reset-hint { font-size:0.64rem; color:#2a3a52; line-height:1.5; }
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
    .brokers { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-bottom:0; }
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
    .brk-role { font-size:0.62rem !important; flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .brk-wallet { margin-left:auto; display:flex; flex-direction:column; align-items:flex-end; line-height:1.1; flex:0 0 auto; }
    .brk-wallet-remain { font-size:0.92rem; font-weight:800; color:#e0eaf8; font-variant-numeric:tabular-nums; }
    .brk-wallet-sub { font-size:0.58rem; color:#4a6080; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .brk-wallet-sub .pos { color:#34d399; }
    .brk-wallet-sub .neg { color:#f87171; }
    .brk-wallet-sub .zero { color:#7d8aa3; }
    /* Stack the two broker rows on laptop/small-desktop widths so each gets the
       full content width and the login button always fits (was 720px — too low,
       it skipped the 13" MacBook band). */
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
    .brk-role { font-size:0.66rem; color:#4a6080; flex:0 1 auto; }
    .brk-status {
      font-size:0.58rem; font-weight:700; text-transform:uppercase; letter-spacing:1px;
      padding:3px 9px; border-radius:20px; border:1px solid;
      background:#0e0e1e; border-color:#2a2a48; color:#4a5878;
    }
    .brk-row.ok .brk-status  { background:#071e0f; border-color:#0e4020; color:#34d399; }
    .brk-row.ok.blue .brk-status { background:#07112e; border-color:#0e2860; color:#60a5fa; }
    .brk-row.bad .brk-status { background:#1c0610; border-color:#500e20; color:#f87171; }
    .brk-action {
      font-size:0.74rem; font-weight:600; text-decoration:none;
      padding:6px 12px; border-radius:6px; white-space:nowrap;
      transition:filter 0.15s;
    }
    .brk-action.re-login { color:#4a6080; }
    .brk-action.re-login:hover { color:#60a5fa; }
    .brk-action.login { color:#fff; border:1px solid; }
    .brk-action.login.fyers   { background:#0d3a18; border-color:#1a6030; }
    .brk-action.login.zerodha { background:#1a4a8a; border-color:#2a6aaa; }
    .brk-action.login:hover { filter:brightness(1.15); }
    .brk-action.muted-hint {
      font-size:0.66rem; color:#4a5878; font-style:italic;
      border:1px dashed #252550; padding:4px 10px; border-radius:6px;
    }
    .brk-expiry {
      font-size:0.7rem; line-height:1.4;
      padding:7px 12px; border-radius:7px; border:1px solid;
    }
    .brk-expiry.expired  { background:#2d1600; border-color:#c05621; color:#f6ad55; }
    .brk-expiry.expiring { background:#2a1600; border-color:#744210; color:#fbd38d; }
    .brk-expiry.valid    { background:#070d14; border-color:#1a3050; color:#4a7090; }

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
    .opt-expiry-icon { font-size:1.4rem; flex-shrink:0; }
    .opt-expiry-text { flex:1; min-width:0; }
    .opt-expiry-title { font-size:0.78rem; font-weight:700; color:#fca5a5; letter-spacing:0.3px; margin-bottom:2px; }
    .opt-expiry-body  { font-size:0.72rem; color:#fecaca; line-height:1.5; }
    .opt-expiry-body strong { color:#fff; }
    .opt-expiry-cta {
      display:inline-flex; align-items:center; gap:4px; flex-shrink:0;
      padding:7px 14px; border-radius:7px;
      background:#ef4444; color:#fff; text-decoration:none;
      font-size:0.75rem; font-weight:700; letter-spacing:0.2px;
      border:1px solid #f87171; transition:filter 0.15s, transform 0.08s;
    }
    .opt-expiry-cta:hover { filter:brightness(1.12); }
    .opt-expiry-cta:active { transform:translateY(1px); }
    @media (max-width:640px) {
      .opt-expiry-alert { flex-direction:column; align-items:flex-start; }
      .opt-expiry-cta { width:100%; justify-content:center; }
    }

    /* Compact utility strip (Start All / Reset Token) */
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
    :root[data-theme="light"] .util-btn.is-active-paper { background:#dcfce7 !important; border-color:#16a34a !important; color:#15803d !important; }
    :root[data-theme="light"] .util-btn.is-active-live  { background:#fee2e2 !important; border-color:#dc2626 !important; color:#b91c1c !important; }
    .util-info { font-size:0.68rem; color:#4a6080; margin-left:auto; font-family:'IBM Plex Mono',monospace; }

    /* Mobile */
    @media (max-width:640px) {
      .brk-role { display:none; }
      .util-strip { flex-direction:column; align-items:stretch; }
      .util-btn { justify-content:center; width:100%; }
      .util-info { margin:4px 0 0; text-align:center; }
    }

    /* Light theme */
    :root[data-theme="light"] .brk-row { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .brk-row.ok   { background:#f0fdf4; border-color:#bbf7d0; }
    :root[data-theme="light"] .brk-row.ok.blue { background:#eff6ff; border-color:#bfdbfe; }
    :root[data-theme="light"] .brk-row.bad  { background:#fef2f2; border-color:#fecaca; }
    :root[data-theme="light"] .brk-row.muted { background:#f8fafc; border-color:#e2e8f0; }
    :root[data-theme="light"] .brk-name { color:#1e293b; }
    :root[data-theme="light"] .brk-role { color:#94a3b8; }
    :root[data-theme="light"] .brk-wallet-remain { color:#1e293b; }
    :root[data-theme="light"] .brk-wallet-sub { color:#94a3b8; }
    :root[data-theme="light"] .brk-status { background:#f1f5f9; border-color:#e2e8f0; color:#94a3b8; }
    :root[data-theme="light"] .brk-row.ok .brk-status { background:#dcfce7; border-color:#86efac; color:#16a34a; }
    :root[data-theme="light"] .brk-row.ok.blue .brk-status { background:#dbeafe; border-color:#93c5fd; color:#2563eb; }
    :root[data-theme="light"] .brk-row.bad .brk-status { background:#fee2e2; border-color:#fca5a5; color:#dc2626; }
    :root[data-theme="light"] .util-strip { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .util-btn { background:#f8fafc; border-color:#e2e8f0; color:#475569; }
    :root[data-theme="light"] .util-btn.run-paper { background:#dcfce7; border-color:#86efac; color:#16a34a; }
    :root[data-theme="light"] .util-btn.run-live  { background:#fee2e2; border-color:#fca5a5; color:#dc2626; }
    :root[data-theme="light"] .util-info { color:#64748b; }
    /* Light theme — top-bar pills/buttons + broker expiry pill (shared chrome lacks light variants) */
    :root[data-theme="light"] .top-bar-btn { background:#f8fafc; border-color:#e2e8f0; color:#475569; }
    :root[data-theme="light"] .top-bar-btn.run-paper { background:#dcfce7; border-color:#86efac; color:#16a34a; }
    :root[data-theme="light"] .top-bar-btn.run-live { background:#fee2e2; border-color:#fca5a5; color:#dc2626; }
    :root[data-theme="light"] .top-bar-cache { background:#f0fdf4; border-color:#bbf7d0; color:#16a34a; }
    :root[data-theme="light"] .top-bar-cache.empty { background:#f8fafc; border-color:#e2e8f0; color:#64748b; }
    :root[data-theme="light"] .top-bar-cache.schedule { background:#ecfeff; border-color:#a5f3fc; color:#0891b2; }
    :root[data-theme="light"] .top-bar-cache.schedule.empty { background:#f8fafc; border-color:#e2e8f0; color:#64748b; }
    :root[data-theme="light"] .top-bar-badge { background:#eff6ff; border-color:#bfdbfe; color:#2563eb; }
    :root[data-theme="light"] .top-bar-badge.live-active { background:#fef2f2; border-color:#fca5a5; color:#dc2626; }
    :root[data-theme="light"] .top-bar-badge.paper-active { background:#f0fdf4; border-color:#bbf7d0; color:#16a34a; }
    :root[data-theme="light"] .brk-expiry.valid { background:#f8fafc; border-color:#e2e8f0; color:#475569; }
    :root[data-theme="light"] .brk-expiry.expiring { background:#fffbeb; border-color:#fde68a; color:#b45309; }
    :root[data-theme="light"] .brk-expiry.expired { background:#fef2f2; border-color:#fecaca; color:#c2410c; }

    /* ── PER-MODULE START CARDS ── */
    /* ── PER-MODULE P&L CHART CARDS (Paper/Live toggle) ── */
    /* Columns pinned to the actual enabled-strategy count (--mm-cols, set
       inline from dashCardCount) so the cards fill one row with no empty
       trailing column. Collapses to fewer cols on narrow screens. */
    .mm-grid { display:grid; grid-template-columns:repeat(var(--mm-cols,4), minmax(0,1fr)); gap:10px; }
    /* Grid items default to min-width:auto, which can force a track wider than
       its share and overflow the (clipped) page. Let them shrink so the grids
       always reflow to the available width. */
    .mm-grid > *, .da-grid > *, .ts-grid > * { min-width:0; }
    @media (max-width:1100px) { .mm-grid { grid-template-columns:repeat(2, minmax(0,1fr)); } }
    @media (max-width:560px)  { .mm-grid { grid-template-columns:1fr; } }
    .mm-card { background:#0d1320; border:1px solid #1a2236; border-radius:9px; padding:8px 10px 9px; display:flex; flex-direction:column; }
    .mm-hdr { display:flex; align-items:center; gap:8px; padding-bottom:6px; border-bottom:1px solid #1a2236; margin-bottom:6px; }
    .mm-dot { width:7px; height:7px; border-radius:50%; background:#4a6080; flex-shrink:0; }
    .mm-card.ema_rsi_st    .mm-dot { background:#60a5fa; }
    .mm-card.bb_rsi    .mm-dot { background:#fbbf24; }
    .mm-card.pa       .mm-dot { background:#a78bfa; }
    .mm-card.orb      .mm-dot { background:#10b981; }
    .mm-card.ema9vwap .mm-dot { background:#06b6d4; }
    .mm-card.trendpb  .mm-dot { background:#ec4899; }
    .mm-title { font-size:0.62rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:#a0b0c8; }
    /* Global Paper/Live source toggle (top-bar) — drives every chart on the dashboard */
    .dash-src-toggle { display:inline-flex; background:#07111f; border:1px solid #1a2236; border-radius:4px; padding:2px; flex-shrink:0; }
    .dst-btn { background:transparent; border:none; color:#4a6080; font-family:inherit; font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:1px; padding:6px 18px; border-radius:2px; cursor:pointer; transition:all 0.15s; }
    .dst-btn:hover:not(.active) { color:#a0b0c8; }
    .dst-btn.active { background:#3b82f6; color:#fff; }
    .dst-btn.active[data-src="live"] { background:#ef4444; color:#fff; }
    :root[data-theme="light"] .dash-src-toggle { background:#f1f5f9; border-color:#e0e4ea; }
    :root[data-theme="light"] .dst-btn { color:#94a3b8; }
    :root[data-theme="light"] .dst-btn:hover:not(.active) { color:#475569; }
    :root[data-theme="light"] .dst-btn.active { background:#3b82f6; color:#fff; }
    :root[data-theme="light"] .dst-btn.active[data-src="live"] { background:#ef4444; color:#fff; }
    .mm-stats { font-size:0.66rem; font-family:'IBM Plex Mono',monospace; color:#4a6080; margin-bottom:4px; }
    .mm-stats .pnl-pos { color:#10b981; font-weight:700; }
    .mm-stats .pnl-neg { color:#ef4444; font-weight:700; }
    .mm-stats .pnl-flat { color:#4a6080; font-weight:700; }
    .mm-wrap { position:relative; height:100px; }
    .mm-empty { text-align:center; padding:38px 20px 14px; color:#4a6080; font-size:0.72rem; }
    :root[data-theme="light"] .mm-card { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .mm-hdr { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .mm-title { color:#475569; }
    :root[data-theme="light"] .mm-stats { color:#94a3b8; }
    :root[data-theme="light"] .mm-empty { color:#94a3b8; }

    /* ── TRADE STATUS PANELS ── */
    .ts-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:0; }
    .ts-cell { padding:12px 16px; border-right:1px solid #1a2236; }
    .ts-cell:last-child { border-right:none; }
    .ts-label { font-size:0.52rem; font-weight:600; text-transform:uppercase; letter-spacing:1.4px; color:#3a5070; margin-bottom:5px; }
    .ts-val { font-size:0.95rem; font-weight:700; color:#e0eaf8; }
    .ts-val.pos { color:#4ade80; }
    .ts-val.neg { color:#f87171; }
    .ts-val.flat { color:#3a5070; }
    .ts-sub { font-size:0.62rem; color:#3a5070; margin-top:2px; }
    .ts-pos-bar { margin:10px 18px 0; padding:10px 14px; background:#0a0f14; border:1px solid #1a2a3a; border-radius:8px; display:flex; flex-wrap:wrap; gap:10px 24px; }
    .ts-pos-item { font-size:0.68rem; color:#3a5878; }
    .ts-pos-item strong { color:#a0c0e0; font-weight:600; }
    .ts-pos-item.pnl-pos strong { color:#4ade80; }
    .ts-pos-item.pnl-neg strong { color:#f87171; }
    .ts-flat-note { font-size:0.72rem; color:#2a3a50; font-style:italic; }
    #trade-row, #bb_rsi-row, #pa-row { display:flex; gap:12px; align-items:stretch; width:100%; flex-wrap:nowrap; }
    @media (max-width:900px) { .ts-grid { grid-template-columns:1fr 1fr; } }

    /* cfg-grid removed — config shown as strip in broker card */
    /* cfg-cell/live-note styles removed — config shown as strip in broker card */

    /* ── DASHBOARD LIGHT THEME ── */
    :root[data-theme="light"] body { background:#f4f6f9; color:#334155; }

    /* Cards */
    :root[data-theme="light"] .card { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .card-hdr { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .card-hdr-title { color:#64748b; }

    /* Broker cards */
    :root[data-theme="light"] .broker-card.connected-green { background:#f0fdf4; border-color:#bbf7d0; color:#16a34a; }
    :root[data-theme="light"] .broker-card.connected-blue  { background:#eff6ff; border-color:#bfdbfe; color:#2563eb; }
    :root[data-theme="light"] .broker-card.error-state     { background:#fef2f2; border-color:#fecaca; color:#dc2626; }
    :root[data-theme="light"] .broker-card.no-config       { background:#f8fafc; border-color:#e2e8f0; color:#94a3b8; }
    :root[data-theme="light"] .broker-name { color:#1e293b; }
    :root[data-theme="light"] .broker-role { color:#94a3b8; }
    :root[data-theme="light"] .broker-meta { color:#64748b; }
    :root[data-theme="light"] .broker-meta .tag { background:#f1f5f9; border-color:#e0e4ea; color:#64748b; }
    :root[data-theme="light"] .broker-status-pill.ok-green { background:#dcfce7; border-color:#86efac; color:#16a34a; }
    :root[data-theme="light"] .broker-status-pill.ok-blue  { background:#dbeafe; border-color:#93c5fd; color:#2563eb; }
    :root[data-theme="light"] .broker-status-pill.err      { background:#fee2e2; border-color:#fca5a5; color:#dc2626; }
    :root[data-theme="light"] .broker-status-pill.grey     { background:#f1f5f9; border-color:#e2e8f0; color:#94a3b8; }
    :root[data-theme="light"] .broker-logo.fyers-logo  { background:#dcfce7; border-color:#bbf7d0; }
    :root[data-theme="light"] .broker-logo.zerodha-logo { background:#ede9fe; border-color:#c4b5fd; }
    :root[data-theme="light"] .broker-connected-bar.green { background:#dcfce7; border-color:#86efac; color:#16a34a; }
    :root[data-theme="light"] .broker-connected-bar.blue  { background:#dbeafe; border-color:#93c5fd; color:#2563eb; }
    :root[data-theme="light"] .broker-connected-bar .relogin-link { color:#94a3b8; }
    :root[data-theme="light"] .broker-connected-bar .relogin-link:hover { color:#2563eb; }
    :root[data-theme="light"] .broker-login-btn.fyers-btn  { background:#16a34a; border-color:#15803d; }
    :root[data-theme="light"] .broker-login-btn.zerodha-btn { background:#2563eb; border-color:#1d4ed8; }
    :root[data-theme="light"] .broker-no-config { background:#f8fafc; border-color:#e2e8f0; color:#94a3b8; }
    :root[data-theme="light"] .broker-no-config code { color:#6366f1; }
    :root[data-theme="light"] .broker-expiry-warn.expired  { background:#fff7ed; border-color:#fdba74; color:#c2410c; }
    :root[data-theme="light"] .broker-expiry-warn.expiring { background:#fffbeb; border-color:#fcd34d; color:#a16207; }
    :root[data-theme="light"] .broker-expiry-warn.valid    { background:#f8fafc; border-color:#e0e4ea; color:#64748b; }
    :root[data-theme="light"] .broker-divider { background:#e0e4ea; }
    :root[data-theme="light"] .hard-reset-hint { color:#94a3b8; }
    :root[data-theme="light"] .hard-reset-btn { background:#fef2f2; border-color:#fca5a5; color:#dc2626; }
    :root[data-theme="light"] .hard-reset-btn:hover { background:#fee2e2; border-color:#dc2626; }

    /* Trade status panels */
    :root[data-theme="light"] .ts-cell { border-right-color:#e0e4ea; }
    :root[data-theme="light"] .ts-label { color:#64748b; }
    :root[data-theme="light"] .ts-val { color:#1e293b; }
    :root[data-theme="light"] .ts-sub { color:#94a3b8; }
    :root[data-theme="light"] .ts-pos-bar { background:#f8fafc; border-color:#e0e4ea; }
    :root[data-theme="light"] .ts-pos-item { color:#64748b; }
    :root[data-theme="light"] .ts-pos-item strong { color:#334155; }
    :root[data-theme="light"] .ts-flat-note { color:#94a3b8; }

    /* ── CUMULATIVE P&L CHART CARDS (Paper + Live) ── */
    .dash-chart-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .dash-chart-card { background:#0d1320; border:1px solid #1a2236; border-radius:9px; padding:10px 12px 12px; }
    .dash-chart-hdr { display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap; padding-bottom:6px; border-bottom:1px solid #1a2236; }
    .dash-chart-title { display:flex; align-items:center; gap:8px; font-size:0.66rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:#a0b0c8; }
    .dash-chart-dot { width:7px; height:7px; border-radius:50%; display:inline-block; }
    .dash-chart-stats { font-size:0.66rem; font-family:'IBM Plex Mono',monospace; color:#4a6080; }
    .dash-chart-stats .pnl-pos { color:#10b981; font-weight:700; }
    .dash-chart-stats .pnl-neg { color:#ef4444; font-weight:700; }
    .dash-chart-stats .pnl-flat { color:#4a6080; font-weight:700; }
    .dash-chart-link { font-size:0.66rem; color:#60a5fa; text-decoration:none; font-weight:600; padding:3px 9px; border-radius:5px; border:1px solid #1a3a6a; background:#080e1a; transition:filter 0.15s; margin-left:auto; }
    .dash-chart-link:hover { filter:brightness(1.25); }
    .dash-chart-wrap { position:relative; height:clamp(140px, 26vh, 360px); }
    /* Cumulative card tucked into the strategy grid: span the 2-col gap, match card chart height */
    .dash-cum-inline { grid-column:1 / -1; }
    .dash-cum-inline .dash-chart-wrap { height:130px; }
    .dash-chart-empty { text-align:center; padding:46px 20px 14px; color:#4a6080; font-size:0.72rem; }
    @media (max-width:900px) { .dash-chart-grid { grid-template-columns:1fr; } }
    :root[data-theme="light"] .dash-chart-card { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .dash-chart-title { color:#475569; }
    :root[data-theme="light"] .dash-chart-stats { color:#94a3b8; }
    :root[data-theme="light"] .dash-chart-link { background:#eff6ff; border-color:#bfdbfe; color:#2563eb; }
    :root[data-theme="light"] .dash-chart-empty { color:#94a3b8; }

    /* ── Dashboard Analytics Panel (market-hour aware) ── */
    .dash-analytics { background:#0d1320; border:1px solid #1a2236; border-radius:9px; padding:10px 12px 12px; }
    .da-header { display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap; padding-bottom:6px; border-bottom:1px solid #1a2236; }
    .da-title { display:flex; align-items:center; gap:8px; font-size:0.66rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:#a0b0c8; }
    .da-badge { font-size:0.58rem; font-weight:700; padding:2px 8px; border-radius:4px; letter-spacing:0.6px; background:rgba(74,96,128,0.12); color:#a0b0c8; border:1px solid rgba(74,96,128,0.30); }
    .da-badge.live { background:rgba(16,185,129,0.10); color:#10b981; border-color:rgba(16,185,129,0.30); }
    .da-badge.post { background:rgba(59,130,246,0.10); color:#60a5fa; border-color:rgba(59,130,246,0.30); }
    .da-sub { font-size:0.66rem; color:#4a6080; font-family:'IBM Plex Mono',monospace; margin-left:auto; }
    .da-body { display:flex; flex-direction:column; gap:10px; }
    .da-loading { padding:18px; text-align:center; color:#4a6080; font-size:0.72rem; }
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
    .da-empty { padding:14px 12px; text-align:center; color:#4a6080; font-size:0.72rem; }
    :root[data-theme="light"] .dash-analytics { background:#fff; border-color:#e0e4ea; }
    :root[data-theme="light"] .da-tile { background:#f8fafc; border-color:#e0e4ea; }
    :root[data-theme="light"] .da-title { color:#475569; }
    :root[data-theme="light"] .da-sub { color:#94a3b8; }
    :root[data-theme="light"] .da-tile-hdr { color:#64748b; }
    :root[data-theme="light"] .da-kv .v { color:#1e293b; }
    :root[data-theme="light"] .da-kv .k { color:#64748b; }

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
    /* Dashboard top bar — keep title, toggle, and actions on a single line */
    .top-bar { flex-wrap:nowrap !important; overflow-x:auto; }
    .top-bar > div:first-child { flex-shrink:0; }
    .top-bar-meta { white-space:nowrap; }
    .top-bar-right { flex-wrap:nowrap !important; flex-shrink:0; }
    ${modalCSS()}
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
    <div class="top-bar-right">
      ${anyModeActive ? '' : `
      <button id="btn-all-harness" class="top-bar-btn" style="border-color:#b45309;color:#b45309;" onclick="startAllHarness(this)" title="Start all Live (Harness) modes in DRY-RUN — runs Paper + logs would-be broker orders (EMA_RSI_ST + BB_RSI + PA + ORB + EMA9+VWAP + TREND PB)">🧪 Start All (Harness)</button>
      <button id="btn-all-start" class="top-bar-btn run-paper" onclick="startAll(this)" title="Start all paper modes">▶ Start All (Paper)</button>
      <button onclick="hardReset()" class="top-bar-btn" title="Clears Fyers + Zerodha tokens and restarts the server — use when tokens look stuck">🔄 Reset Token</button>
      <span id="expiry-info-pill" class="top-bar-cache schedule empty" title="Next NIFTY weekly/monthly expiry"></span>
      <span id="holiday-info-pill" class="top-bar-cache schedule empty" title="Next NSE trading holiday"></span>`}
      <div id="trading-status-alert" style="display:none;position:relative;"></div>
      ${liveActive ? '<span class="top-bar-badge live-active"><span style="width:5px;height:5px;border-radius:50%;background:#ef4444;display:inline-block;"></span>LIVE ACTIVE</span>' : ''}
      ${bbRsiModeOn && bbRsiMode === 'BB_RSI_LIVE' ? '<span class="top-bar-badge live-active" style="border-color:#f59e0b;"><span style="width:5px;height:5px;border-radius:50%;background:#f59e0b;display:inline-block;"></span>BB_RSI LIVE</span>' : ''}
      ${paModeOn && paMode === 'PA_LIVE' ? '<span class="top-bar-badge live-active" style="border-color:#a78bfa;"><span style="width:5px;height:5px;border-radius:50%;background:#a78bfa;display:inline-block;"></span>PA LIVE</span>' : ''}
      ${orbModeOn && orbMode === 'ORB_PAPER' ? '<span class="top-bar-badge live-active" style="border-color:#10b981;"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>ORB PAPER</span>' : ''}
      ${anyModeActive && !specificBadgeShown ? '<span class="top-bar-badge live-active" style="border-color:#22c55e;"><span style="width:5px;height:5px;border-radius:50%;background:#22c55e;display:inline-block;"></span>TRADE ACTIVE</span>' : ''}
      ${!liveActive && (!bbRsiModeOn || !bbRsiMode) && (!paModeOn || !paMode) && (!orbModeOn || !orbMode) && (!ema9vwapModeOn || !ema9vwapMode) && (!trendPbModeOn || !trendPbMode) ? '<span class="top-bar-badge">● IDLE</span>' : ''}
    </div>
  </div>

<div class="page">

  ${optionExpiryAlertHtml}

  <!-- ① BROKER CONNECTIONS — compact single-line rows (hidden while a trade runs) -->
  ${anyModeActive ? '' : `
  <div class="brokers">
    <div class="brk-row ${fyersOk ? 'ok' : 'bad'}">
      <span class="brk-dot ${fyersOk ? 'pulse' : ''}"></span>
      <span class="brk-name">Fyers</span>
      <span class="brk-role">Market Data · WS · REST</span>
      ${fyersWalletHtml}
      <span class="brk-status">${fyersOk ? 'Connected' : 'Disconnected'}</span>
      ${fyersOk
        ? `<a href="/auth/login" class="brk-action re-login">re-login →</a>`
        : `<a href="/auth/login" class="brk-action login fyers">🔐 Login with Fyers</a>`}
    </div>
    <div class="brk-row ${zerodhaOk ? 'ok blue' : zerodhaConf ? 'bad' : 'muted'}">
      <span class="brk-dot ${zerodhaOk ? 'pulse' : ''}"></span>
      <span class="brk-name">Zerodha</span>
      <span class="brk-role">Orders · Live Trade</span>
      ${zerodhaWalletHtml}
      <span class="brk-status">${zerodhaOk ? 'Connected' : zerodhaConf ? 'Disconnected' : 'Not Configured'}</span>
      ${zerodhaOk
        ? `<a href="/auth/zerodha/login" class="brk-action re-login">re-login →</a>`
        : zerodhaConf
          ? `<a href="/auth/zerodha/login" class="brk-action login zerodha">🔐 Login with Zerodha</a>`
          : `<span class="brk-action muted-hint">Set ZERODHA_API_KEY in .env</span>`}
    </div>
    ${zerodhaOk && zerodhaExpiryHtml ? `<div class="brk-expiry ${pastExpiry ? 'expired' : nearExpiry ? 'expiring' : 'valid'}">${zerodhaExpiryHtml}</div>` : ''}
  </div>`}

  <!-- (utility buttons moved to top-bar-right; cache pill + schedule pills also live there) -->

  <!-- ③ PER-MODULE CUMULATIVE P&L CHARTS (Paper/Live toggle, all-time) -->
  <div class="mm-grid" style="--mm-cols:${dashCardCount};">
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
    ${cumInlineInGrid ? cumCardInline : ''}
  </div>

  <!-- ⑤ CUMULATIVE P&L CHART (Paper/Live toggle, all-time) — full-width fallback when it can't tuck into the grid -->
  ${cumInlineInGrid ? '' : cumCardBelow}

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

<script>
${modalJS()}
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
var PAPER_ENDPOINTS = ['/ema_rsi_st-paper/start'${bbRsiModeOn ? ",'/bb_rsi-paper/start'" : ""}${paModeOn ? ",'/pa-paper/start'" : ""}${orbModeOn ? ",'/orb-paper/start'" : ""}${ema9vwapModeOn ? ",'/ema9vwap-paper/start'" : ""}${trendPbModeOn ? ",'/trend-pb-paper/start'" : ""}];
var LIVE_ENDPOINTS  = ['/ema_rsi_st-live/start'${bbRsiModeOn ? ",'/bb_rsi-live/start'"  : ""}${paModeOn ? ",'/pa-live/start'"  : ""}${orbModeOn ? ",'/orb-live/start'" : ""}];
// Harness routes wrap PAPER (LIVE = PAPER by construction); respect LIVE_HARNESS_DRY_RUN.
// EMA9+VWAP has no separate pure-live engine — its /ema9vwap-live route IS the harness (Zerodha orders when dry-run off).
var HARNESS_ENDPOINTS = ['/ema_rsi_st-live-harness/start'${bbRsiModeOn ? ",'/bb_rsi-live-harness/start'" : ""}${paModeOn ? ",'/pa-live-harness/start'" : ""}${orbModeOn ? ",'/orb-live-harness/start'" : ""}${ema9vwapModeOn ? ",'/ema9vwap-live/start'" : ""}${trendPbModeOn ? ",'/trend-pb-live/start'" : ""}];

function _escHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}

function _prettyEndpoint(url){
  var m = /\\/([\\w-]+)-(live|paper)(-harness)?\\/start/.exec(url);
  if (!m) return url;
  var mode = { ema_rsi_st:'EMA_RSI_ST', bb_rsi:'BB_RSI', pa:'Price Action', orb:'ORB', ema9vwap:'EMA9+VWAP', 'trend-pb':'TREND PB' }[m[1]] || m[1];
  var kind = m[2] === 'paper' ? 'Paper' : (m[3] ? 'Live (Harness)' : 'Live');
  return mode + ' ' + kind;
}

async function _startAll(endpoints){
  var results = { successes: [], failures: [] };
  for (var i = 0; i < endpoints.length; i++){
    var ep = endpoints[i];
    try {
      var r = await secretFetch(ep);
      if (!r){ results.failures.push({ endpoint: ep, error: 'No response from server' }); continue; }
      var body = null;
      try { body = await r.json(); } catch(_) { /* non-JSON body */ }
      // 0DTE expiry-day warning — pop confirm modal, optionally retry with ?force=1
      if (body && body.code === 'EXPIRY_DAY_0DTE'){
        var isLive = /-live\\//.test(ep);
        var confirmCopy = isLive ? 'Start Anyway (Real Money)' : 'Start Anyway';
        var titleCopy   = isLive ? '0DTE Expiry Day — REAL MONEY at Risk' : '0DTE Expiry Day — Not Recommended';
        var extraNote   = isLive ? '\\n\\nThis is LIVE trading with real capital. Cancel stops the ENTIRE Start All — nothing starts — so you can fix the EMA_RSI_ST Option Expiry in Settings first.' : '\\n\\nCancel stops the ENTIRE Start All — nothing starts — so you can fix the EMA_RSI_ST Option Expiry in Settings first. Or Start Anyway to run EMA_RSI_ST on 0DTE.';
        var ok = await showConfirm({
          icon: '⚠️',
          title: titleCopy,
          message: (body.message || '0DTE detected') + extraNote,
          confirmText: confirmCopy,
          confirmClass: 'modal-btn-danger'
        });
        if (ok){
          try {
            var r2 = await secretFetch(ep + '?force=1');
            var body2 = null;
            try { body2 = await r2.json(); } catch(_) {}
            if (r2 && r2.ok && (!body2 || body2.success !== false)){
              results.successes.push({ endpoint: ep });
            } else {
              var msg2 = (body2 && (body2.error || body2.message)) || ('HTTP ' + (r2 ? r2.status : '?'));
              results.failures.push({ endpoint: ep, status: r2 ? r2.status : 0, error: msg2 });
            }
          } catch(e2){
            results.failures.push({ endpoint: ep, error: (e2 && e2.message) || 'Network error on retry' });
          }
        } else {
          // User cancelled the 0DTE warning → abort the WHOLE Start All so nothing
          // starts. EMA_RSI_ST is always first in the endpoint list, so at this point no
          // other strategy has started yet — breaking here starts nothing.
          results.aborted = true;
          break;
        }
        continue;
      }
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

async function _handleStartAllResult(btn, origText, label, result){
  if (result.aborted){
    // 0DTE warning cancelled → nothing was started; just reset the button.
    btn.disabled = false;
    btn.textContent = origText;
    return;
  }
  if (result.failures.length === 0){
    location.reload();
    return;
  }
  var lines = result.failures.map(function(f){
    return '• <strong>' + _escHtml(_prettyEndpoint(f.endpoint)) + '</strong>: ' + _escHtml(f.error);
  }).join('<br>');
  var succeeded = result.successes.length;
  var total = succeeded + result.failures.length;
  var header = succeeded > 0
    ? ('Started ' + succeeded + '/' + total + '. The following could not start:')
    : ('None could start — ' + result.failures.length + '/' + total + ' failed:');
  await showAlert({
    icon: succeeded > 0 ? '⚠️' : '❌',
    title: 'Start ' + label + ' — Issues',
    message: '<div style="text-align:left;">' + header + '<br><br>' + lines + '</div>',
    btnText: 'OK',
    btnClass: 'modal-btn-primary',
  });
  btn.disabled = false;
  btn.textContent = origText;
  if (succeeded > 0) location.reload();
}

async function startAllPaper(btn){
  var modeList = 'EMA_RSI_ST'
    + (${bbRsiModeOn ? "' + BB_RSI'" : "''"})
    + (${paModeOn ? "' + PA'" : "''"})
    + (${orbModeOn ? "' + ORB'" : "''"})
    + (${ema9vwapModeOn ? "' + EMA9+VWAP'" : "''"})
    + (${trendPbModeOn ? "' + TREND PB'" : "''"});
  var orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Starting paper: ' + modeList + '...';
  var result = await _startAll(PAPER_ENDPOINTS);
  await _handleStartAllResult(btn, orig, 'All Paper', result);
}

async function startAllLive(btn){
  var ok = await showConfirm({
    icon: '⚠️', title: 'Start ALL Live Trades',
    message: 'Start EMA_RSI_ST Live'+(${bbRsiModeOn ? "' + BB_RSI Live'" : "''"})+(${paModeOn ? "' + PA Live'" : "''"})+'?\\nReal orders will be placed on broker accounts.',
    confirmText: 'Start All', confirmClass: 'modal-btn-danger'
  });
  if(!ok) return;
  var orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Starting all live trades...';
  var result = await _startAll(LIVE_ENDPOINTS);
  await _handleStartAllResult(btn, orig, 'All Live', result);
}

async function startAllHarness(btn){
  var modeList = 'EMA_RSI_ST'
    + (${bbRsiModeOn ? "' + BB_RSI'" : "''"})
    + (${paModeOn ? "' + PA'" : "''"})
    + (${orbModeOn ? "' + ORB'" : "''"})
    + (${ema9vwapModeOn ? "' + EMA9+VWAP'" : "''"})
    + (${trendPbModeOn ? "' + TREND PB'" : "''"});
  var ok = await showConfirm({
    icon: '🧪', title: 'Start ALL Live (Harness)',
    message: 'Start ' + modeList + ' via Paper Harness?\\n\\nEach runs Paper unchanged and logs the broker order it WOULD place. Orders follow the global DRY-RUN flag — no real orders while LIVE_HARNESS_DRY_RUN is ON.',
    confirmText: 'Start All (Harness)', confirmClass: 'modal-btn-primary'
  });
  if(!ok) return;
  var orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Starting harness: ' + modeList + '...';
  var result = await _startAll(HARNESS_ENDPOINTS);
  await _handleStartAllResult(btn, orig, 'All Harness', result);
}

// Single Start-All button follows the top-bar PAPER/LIVE toggle.
function startAll(btn){
  return _dashSrc === 'live' ? startAllLive(btn) : startAllPaper(btn);
}

// ── Quick-Action button live state (mutual lock: Paper ↔ Live) ──────────────
var _dashSrc = 'paper';            // top-bar toggle source; also drives the charts
var _allBtnState = { paperOn:false, liveOn:false };
var ALL_BTN_POLL = [
  { url:'/ema_rsi_st-paper/status/data', kind:'paper' },
  { url:'/ema_rsi_st-live/status/data',  kind:'live'  }
  ${bbRsiModeOn ? ",{ url:'/bb_rsi-paper/status/data', kind:'paper' },{ url:'/bb_rsi-live/status/data', kind:'live' }" : ""}
  ${paModeOn ? ",{ url:'/pa-paper/status/data', kind:'paper' },{ url:'/pa-live/status/data', kind:'live' }" : ""}
  ${orbModeOn ? ",{ url:'/orb-paper/status/data', kind:'paper' },{ url:'/orb-live/status/data', kind:'live' }" : ""}
  ${trendPbModeOn ? ",{ url:'/trend-pb-paper/status/data', kind:'paper' }" : ""}
];

function _applyAllBtnState(paperOn, liveOn){
  // Harness is a paper-side concept (Paper + dry-run live log) — only show it
  // when the PAPER source is selected; hide it under LIVE.
  var hb = document.getElementById('btn-all-harness');
  if(hb) hb.style.display = (_dashSrc === 'live') ? 'none' : '';
  var b = document.getElementById('btn-all-start');
  if(!b) return;
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

var PNL_GREEN = '#10b981', PNL_RED = '#ef4444', PNL_FLAT = '#4a6080';
var PNL_GREEN_FILL = 'rgba(16,185,129,0.14)', PNL_RED_FILL = 'rgba(239,68,68,0.14)', PNL_FLAT_FILL = 'rgba(74,96,128,0.10)';
function _pnlColor(total){ return total > 0 ? PNL_GREEN : (total < 0 ? PNL_RED : PNL_FLAT); }
function _pnlFill(total){ return total > 0 ? PNL_GREEN_FILL : (total < 0 ? PNL_RED_FILL : PNL_FLAT_FILL); }

function _renderDashCumChart(canvasId, emptyId, trades){
  var canvas = document.getElementById(canvasId);
  var empty  = document.getElementById(emptyId);
  if (!canvas) return null;
  if (!trades || !trades.length){
    if (empty) empty.style.display = 'block';
    canvas.style.display = 'none';
    return null;
  }
  if (empty) empty.style.display = 'none';
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

var _dcData = { paper: null, live: null };
var _dcChart = null;
var _dcToggle = 'paper';

function _renderDashTotal(){
  var src = _dcToggle;
  var trades = _dcData[src] || [];
  var total = trades.reduce(function(a,t){ return a + (t.pnl||0); }, 0);
  var dot = document.getElementById('dashCumDot');
  if (dot) dot.style.background = _pnlColor(total);
  var link = document.getElementById('dashCumLink');
  if (link) link.href = src === 'live' ? '/live-consolidation' : '/consolidation';
  var emptyEl = document.getElementById('dashCumEmpty');
  if (emptyEl) emptyEl.textContent = 'No ' + src + ' trades yet';
  if (_dcChart) { _dcChart.destroy(); _dcChart = null; }
  _dcChart = _renderDashCumChart('dashCumChart', 'dashCumEmpty', trades);
  _updateChartStats('dash-cum-stats', trades);
}

async function loadDashCumCharts(){
  try {
    var r = await fetch('/consolidation/data?enabledOnly=1', { cache: 'no-store' });
    if (r.ok){ var d = await r.json(); _dcData.paper = (d && d.trades) || []; }
  } catch(_){ _dcData.paper = []; }
  try {
    var r2 = await fetch('/live-consolidation/data?enabledOnly=1', { cache: 'no-store' });
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
  ['EMA_RSI_ST','BB_RSI','PA','ORB','EMA9VWAP','TREND_PB'].forEach(function(m){ _mmToggle[m] = src; });
  document.querySelectorAll('#dashSrcToggle .dst-btn').forEach(function(b){ b.classList.toggle('active', b === btn); });
  _renderDashTotal();
  ['EMA_RSI_ST','BB_RSI','PA','ORB','EMA9VWAP','TREND_PB'].forEach(_renderModuleChart);
  _applyAllBtnState(_allBtnState.paperOn, _allBtnState.liveOn);
});

loadDashCumCharts();

// ── Per-Module P&L Charts (Paper/Live toggle, all-time) ──────────────────────
var _mmData = { paper: null, live: null };
var _mmCharts = {};
var _mmToggle = { EMA_RSI_ST: 'paper', BB_RSI: 'paper', PA: 'paper', ORB: 'paper', EMA9VWAP: 'paper', TREND_PB: 'paper' };

function _renderModuleChart(mode){
  var card = document.querySelector('.mm-card[data-mode="' + mode + '"]');
  if (!card) return;
  var src = _mmToggle[mode];
  var all = _mmData[src] || [];
  var trades = all.filter(function(t){ return (t.mode || '').toUpperCase() === mode; });
  if (_mmCharts[mode]) { _mmCharts[mode].destroy(); _mmCharts[mode] = null; }
  var emptyEl = document.getElementById('mm-empty-' + mode);
  if (emptyEl) emptyEl.textContent = 'No ' + src + ' trades yet';
  _mmCharts[mode] = _renderDashCumChart('mmChart-' + mode, 'mm-empty-' + mode, trades);
  _updateChartStats('mm-stats-' + mode, trades);
}

async function loadModuleCharts(){
  try {
    var r1 = await fetch('/consolidation/data', { cache: 'no-store' });
    if (r1.ok){ var d1 = await r1.json(); _mmData.paper = (d1 && d1.trades) || []; }
  } catch(_){ _mmData.paper = []; }
  try {
    var r2 = await fetch('/live-consolidation/data', { cache: 'no-store' });
    if (r2.ok){ var d2 = await r2.json(); _mmData.live = (d2 && d2.trades) || []; }
  } catch(_){ _mmData.live = []; }
  ['EMA_RSI_ST','BB_RSI','PA','ORB','EMA9VWAP','TREND_PB'].forEach(_renderModuleChart);
}

loadModuleCharts();

// ── Market schedule pills (top bar) — independent of analytics panel ─────────
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
      expEl.classList.remove('empty');
      expEl.textContent = '📅 Next Expiry Date : ' + fmtDMY(nextExp.date) + ' - ' + typeLbl + ' - ' + when;
    } else {
      expEl.classList.add('empty');
      expEl.textContent = '📅 No upcoming expiry';
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
        holEl.textContent = '🎉 Holiday ' + fmtDMY(nextHol) + ' · ' + hwhen;
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
    PA:'/pa-paper/status/data', ORB:'/orb-paper/status/data', TREND_PB:'/trend-pb-paper/status/data'
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
    return fetch(url, { cache:'no-store' }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
  }

  function renderLive(data) {
    // data: { EMA_RSI_ST, BB_RSI, ... } keyed by tile, each from /{strat}-paper/status/data
    var html = '<div class="da-grid cols-' + Math.min(SESSION_TILES.length, 6) + '">';
    SESSION_TILES.forEach(function(t){
      var d = data[t.key];
      if (!d) {
        html += '<div class="da-tile ' + t.cls + '"><div class="da-tile-hdr">' + t.label + '<span class="da-pill">OFFLINE</span></div><div class="da-sub-line">No data</div></div>';
        return;
      }
      // Field names vary by strategy (ORB uses livePnl/tradesTaken) — fall back.
      var open = d.unrealisedPnl !== undefined ? d.unrealisedPnl : (d.unrealised !== undefined ? d.unrealised : (d.livePnl || 0));
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

    // ── Last session card (per strategy) ── enabled tiles + a TOTAL card
    var lastHtml = '<div class="da-grid cols-' + Math.min(SESSION_TILES.length + 1, 6) + '">';
    SESSION_TILES.forEach(function(t){
      var s = lastDayAgg ? lastDayAgg.byStrategy[t.key] : null;
      var net = s ? s.net : 0;
      var trades = s ? s.t : 0;
      var w = s ? s.w : 0, l = s ? s.l : 0;
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
      setMode('live', 'Polling every 8s &middot; ' + istDateISO());
      var liveResults = await Promise.all(SESSION_TILES.map(function(t){
        return fetchJSON(LIVE_URLS[t.key]);
      }));
      var liveData = {};
      SESSION_TILES.forEach(function(t, i){ liveData[t.key] = liveResults[i]; });
      body.innerHTML = renderLive(liveData);

      clearPoll();
      _pollTimer = setInterval(refresh, 8000);
    } else {
      setMode('post', 'Paper + Live combined &middot; refreshed ' + istDateISO());
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
function showStatusPill(alertDiv, icon, msg, color){
  if(alertDiv._dismissed) return;
  alertDiv.style.display = 'block';
  alertDiv.innerHTML = '<div style="display:inline-flex;align-items:center;gap:6px;background:#07111f;border:0.5px solid '
    +color+';border-radius:20px;padding:3px 10px 3px 8px;font-size:0.68rem;color:'+color+';white-space:nowrap;">'
    +'<span>'+icon+'</span> <span>'+msg+'</span>'
    +' <span onclick="dismissStatusAlert()" style="cursor:pointer;opacity:0.5;margin-left:4px;">&#x2715;</span>'
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
    var btnAllHol = document.getElementById('btn-all-start');
    if(btnAllHol) btnAllHol.style.display = isHoliday ? 'none' : '';

    if(!alertDiv || alertDiv._dismissed) return;
    if(isHoliday){
      showStatusPill(alertDiv, '🎉', 'NSE Holiday — markets closed today', '#fbbf24'); return;
    }
    if(day === 0 || day === 6){
      showStatusPill(alertDiv, '🏖️', 'Weekend — markets resume Monday 9:15 AM', '#ef4444'); return;
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
async function pollSessionActiveSwap(){
  try {
    var r = await fetch('/api/session-active', { cache:'no-store' });
    if (!r.ok) return;
    var j = await r.json();
    if (j && j.active === true) location.replace('/');
  } catch(e){}
}
setInterval(pollSessionActiveSwap, 10000);
// ─────────────────────────────────────────────────────────────────────────────

async function hardReset(){
  var ok = await showDoubleConfirm({
    icon: '⚠️', title: 'Reset Token',
    message: 'Clear Fyers + Zerodha tokens and restart the server?\\nYou will need to re-login both brokers after.',
    confirmText: 'Reset', confirmClass: 'modal-btn-danger',
    subject: 'All broker tokens + server restart',
    secondConfirmText: 'Yes, reset tokens'
  });
  if(!ok) return;
  try {
    var res = await secretFetch('/admin/reset', {method:'POST'});
    if(!res) return;
    var d = await res.json();
    if(d.success){
      await showAlert({icon:'✅',title:'Reset Complete',message:d.message+'\\nPage will reload in 6 seconds.',btnClass:'modal-btn-success'});
      setTimeout(function(){ location.reload(); }, 6000);
    } else {
      showAlert({icon:'❌',title:'Reset Failed',message:d.error||JSON.stringify(d),btnClass:'modal-btn-danger'});
    }
  } catch(e){
    showAlert({icon:'🔄',title:'Server Restarting',message:'Reset sent — server restarting. Reload in 6 seconds.',btnClass:'modal-btn-primary'});
    setTimeout(function(){ location.reload(); }, 6000);
  }
}

// refreshHolidays() moved to Settings → Expiry & Holidays modal
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
      `<!doctype html><meta charset="utf-8"><title>${code}</title>` +
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

  setTimeout(() => {
    try {
      console.log("🔴 [EOD] 4:00 PM IST — auto-clearing Fyers & Zerodha tokens...");
      clearFyersToken();
      zerodha.clearZerodhaToken();
      console.log("✅ [EOD] Both tokens cleared. Fresh login required tomorrow morning.");
    } catch (err) {
      console.error(`❌ [EOD] Token clear failed: ${err.message}`);
    } finally {
      scheduleEODTokenClear(); // always re-schedule for tomorrow's 4:00 PM
    }
  }, msUntil);
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

  // ── Daily downloadable data backup snapshot ────────────────────────────────
  try { require("./utils/backupManager").start(); }
  catch (err) { console.warn(`[backup] scheduler start failed: ${err.message}`); }
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
        console.log("✅ [STARTUP] Zerodha: no orphaned positions.");
        if (savedTrade) clearTradePosition();  // broker confirms no position — safe to clear stale file
        if (savedEma9Vwap) clearEma9VwapPosition(); // EMA9+VWAP trades Zerodha too — safe to clear
      }
    }

    if (fyersBroker.isAuthenticated()) {
      const fPos = await fyersBroker.getPositions();
      const fOpen = (fPos.netPositions || []).filter(p =>
        p.netQty !== 0 && p.symbol && p.symbol.includes("NIFTY")
      );
      if (fOpen.length > 0) {
        const msg = `🚨 [STARTUP] Orphaned Fyers position detected!\n` +
          fOpen.map(p => `  ${p.symbol}: qty=${p.netQty} pnl=₹${p.pl || 0}`).join("\n") +
          `\nBot is NOT tracking this. Check Fyers dashboard and close manually if needed.`;
        console.warn(msg);
        sendTelegram(msg);
      } else {
        console.log("✅ [STARTUP] Fyers: no orphaned positions.");
        // BB_RSI + PA + ORB + Trend_PB all trade on Fyers; broker-flat means any stale snapshot is safe to clear.
        if (savedBbRsi)   clearBbRsiPosition();  // broker confirms no position — safe to clear
        if (savedPA)      clearPAPosition();
        if (savedOrb)     clearOrbPosition();
        if (savedTrendPb) clearTrendPbPosition();
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
      m === "ORB_LIVE" || m === "EMA9VWAP_LIVE" || m === "TREND_PB_LIVE");
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
    };
    for (const mode of activeModes) {
      const route = routeMap[mode];
      if (route && typeof route.stopSession === "function") {
        try {
          console.log(`🔄 [SHUTDOWN] Stopping ${mode}...`);
          route.stopSession();
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
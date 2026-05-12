require("dotenv").config();
require("./services/logger");              // ← MUST be first: intercepts all console.* from here on

const express  = require("express");
const https    = require("https");
const fs       = require("fs");
const { ACTIVE, getActiveStrategy } = require("./strategies");
const instrumentConfig = require("./config/instrument");
const zerodha  = require("./services/zerodhaBroker");
const { clearFyersToken } = require("./config/fyers");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("./utils/sharedNav");
const sharedSocketState = require("./utils/sharedSocketState");

const crypto = require("crypto");
const loginLogStore = require("./utils/loginLogStore");
const fyersBroker   = require("./services/fyersBroker");
const { sendTelegram, sendTelegramSync } = require("./utils/notify");
const consolidatedEodReporter = require("./utils/consolidatedEodReporter");
const { loadTradePosition, clearTradePosition, loadScalpPosition, clearScalpPosition, loadPAPosition, clearPAPosition } = require("./utils/positionPersist");
const app = express();
app.use(express.json());

// ── Login gate — page-level password protection ─────────────────────────────
// Set LOGIN_SECRET in .env. If set, every page requires a login cookie first.
// If empty/unset, all pages are open normally.
const LOGIN_COOKIE = "__trade_login";
const LOGIN_MAX_AGE = 900; // 15 minutes idle timeout (seconds)
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
const _loginAttempts = {};  // { ip: { count, firstAttempt } }
const LOGIN_RATE_MAX     = 5;       // max failed attempts per window
const LOGIN_RATE_WINDOW  = 15 * 60 * 1000;  // 15 minutes

app.post("/login", (req, res) => {
  const secret = process.env.LOGIN_SECRET;
  if (!secret) return res.redirect("/");

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
           || req.socket?.remoteAddress || "unknown";

  // Rate limit check
  const now = Date.now();
  if (_loginAttempts[ip]) {
    const entry = _loginAttempts[ip];
    if (now - entry.firstAttempt > LOGIN_RATE_WINDOW) {
      // Window expired — reset
      _loginAttempts[ip] = { count: 0, firstAttempt: now };
    } else if (entry.count >= LOGIN_RATE_MAX) {
      const waitMin = Math.ceil((LOGIN_RATE_WINDOW - (now - entry.firstAttempt)) / 60000);
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
    res.setHeader("Set-Cookie", `${LOGIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_MAX_AGE}`);
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
    res.setHeader("Set-Cookie", `${LOGIN_COOKIE}=${expectedToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_MAX_AGE}`);
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
  "/swing-live/status",          // read-only status page
  "/swing-live/status/data",     // dashboard AJAX poll — must be open or 403 when API_SECRET is set
  "/swing-paper/status",     // read-only status page
  "/swing-paper/status/data",// dashboard AJAX poll — must be open or 403 when API_SECRET is set
  "/swing-paper/history",    // read-only history
  "/swing-paper/debug",      // read-only debug
  "/swing-paper/client.js",  // static asset
  "/tracker/status",          // read-only tracker page
  "/tracker/status/data",     // AJAX poll — must be open
  "/tracker/fetch-and-start", // auto-fetch + start (Zerodha read + SAR compute)
  "/result",                // read-only results
  "/result/all",
  "/auth/status",           // read-only auth status
  "/auth/zerodha/status",
  "/auth/zerodha/logout",
  "/api/holidays",          // read-only holiday list
  "/api/expiry-dates",      // read-only expiry calendar
  "/api/cache-info",        // read-only candle cache stats
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
  // Scalp mode (read-only status/data)
  "/scalp-live/status",
  "/scalp-live/status/data",
  "/scalp-paper/status",
  "/scalp-paper/status/data",
  "/scalp-backtest",
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
  // NOTE: /swing-live/start, /swing-live/stop, /swing-live/exit are intentionally NOT here — they require API_SECRET
  // NOTE: /swing-paper/start, /swing-paper/stop, /swing-paper/reset, /swing-paper/exit also require secret
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



// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/auth",       require("./routes/auth"));
app.use("/swing-backtest",   require("./routes/swingBacktest"));
app.use("/result",     require("./routes/result"));
app.use("/swing-paper", require("./routes/swingPaper"));
app.use("/swing-live",      require("./routes/swingLive"));
app.use("/tracker",    require("./routes/manualTracker"));
app.use("/logs",       require("./routes/logs"));       // ← live log viewer
app.use("/trade-logs", require("./routes/tradeLogs"));  // ← per-trade JSONL viewer + settings checkpoints
app.use("/sync",        require("./routes/sync"));       // ← EC2→local data sync (download tar.gz)
app.use("/settings",    require("./routes/settings"));   // ← settings UI
app.use("/docs",        require("./routes/docs"));       // ← docs viewer
app.use("/login-logs",  require("./routes/loginLogs"));  // ← failed login log viewer
app.use("/monitor",     require("./routes/monitor"));    // ← EC2 instance health monitor
// ── Scalp mode routes (independent from main trade) ─────────────────────────
app.use("/scalp-live",          require("./routes/scalpLive"));          // ← scalp live (Fyers orders)
app.use("/scalp-paper",    require("./routes/scalpPaper"));     // ← scalp paper trade
app.use("/scalp-backtest", require("./routes/scalpBacktest"));  // ← scalp backtest
app.use("/compare",        require("./routes/compare"));        // ← paper vs backtest compare
// ── Price Action mode routes (5-min, independent from main & scalp) ─────────
app.use("/pa-live",        require("./routes/paLive"));      // ← PA live (Fyers orders)
app.use("/pa-paper",       require("./routes/paPaper"));     // ← PA paper trade
app.use("/pa-backtest",    require("./routes/paBacktest"));  // ← PA backtest
app.use("/pa-pattern-backtest", require("./routes/paPatternBacktest")); // ← PA per-pattern backtest dashboard
app.use("/deploy",         require("./routes/deploy"));         // ← GitHub Actions deploy status
app.use("/consolidation",       require("./routes/consolidation"));     // ← unified cross-mode PAPER trade history + analytics
app.use("/live-consolidation",  require("./routes/liveConsolidation")); // ← unified cross-mode LIVE trade history + analytics
app.use("/realtime",            require("./routes/realtime"));          // ← unified real-time monitor (PAPER/LIVE toggle, all 3 strategies)
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
app.get("/api/cache-info", (req, res) => {
  try {
    const { getCacheInfo } = require("./utils/candleCache");
    const info = getCacheInfo("NSE:NIFTY50-INDEX", "15");
    res.json({ success: true, cache: info });
  } catch (e) {
    res.json({ success: false, cache: null });
  }
});

// ── Home — HTML Dashboard ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  // Redirect to Settings when Dashboard menu is hidden (user can re-enable from Settings → MENU VISIBILITY)
  const showDashboard = (process.env.UI_SHOW_DASHBOARD || 'false').toLowerCase() === 'true';
  if (!showDashboard) return res.redirect("/settings");
  try {
  const fyersOk     = !!process.env.ACCESS_TOKEN;
  const zerodhaOk   = zerodha.isAuthenticated();
  const zerodhaConf = !!process.env.ZERODHA_API_KEY;
  const liveEnabled = process.env.SWING_LIVE_ENABLED === "true";
  const liveReady   = liveEnabled && fyersOk && zerodhaOk;
  const liveActive  = sharedSocketState.getMode() === "SWING_LIVE";
  const scalpMode   = sharedSocketState.getScalpMode();
  const scalpEnabled = process.env.SCALP_ENABLED === "true";
  const scalpModeOn  = (process.env.SCALP_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const paMode      = sharedSocketState.getPAMode ? sharedSocketState.getPAMode() : null;
  const paEnabled   = (process.env.PA_ENABLED || 'true').toLowerCase() === 'true';
  const paModeOn    = (process.env.PA_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const activeStrategyName = getActiveStrategy().NAME;

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
      #trade-row, #scalp-row, #pa-row { flex-wrap:wrap; }
      #trade-row .card, #scalp-row .card, #pa-row .card { flex:none; width:100%; }
    }

    /* ── BROKER CONNECTIONS — compact single-line rows ── */
    .brokers { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:0; }
    .brokers > .brk-expiry { grid-column:1 / -1; }
    .brk-row {
      display:flex; align-items:center; gap:10px; flex-wrap:wrap;
      padding:6px 12px; border-radius:9px;
      border:1px solid #1a2236; background:#0d1320;
      min-width:0;
    }
    .brk-name { font-size:0.82rem !important; }
    .brk-role { font-size:0.62rem !important; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    @media (max-width:720px) { .brokers { grid-template-columns:1fr; } }
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
    .brk-role { font-size:0.66rem; color:#4a6080; flex:1 0 auto; }
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

    /* Compact utility strip (Start All / Hard Reset / NSE Holidays / Cache info) */
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
    :root[data-theme="light"] .brk-status { background:#f1f5f9; border-color:#e2e8f0; color:#94a3b8; }
    :root[data-theme="light"] .brk-row.ok .brk-status { background:#dcfce7; border-color:#86efac; color:#16a34a; }
    :root[data-theme="light"] .brk-row.ok.blue .brk-status { background:#dbeafe; border-color:#93c5fd; color:#2563eb; }
    :root[data-theme="light"] .brk-row.bad .brk-status { background:#fee2e2; border-color:#fca5a5; color:#dc2626; }
    :root[data-theme="light"] .util-strip { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .util-btn { background:#f8fafc; border-color:#e2e8f0; color:#475569; }
    :root[data-theme="light"] .util-btn.run-paper { background:#dcfce7; border-color:#86efac; color:#16a34a; }
    :root[data-theme="light"] .util-btn.run-live  { background:#fee2e2; border-color:#fca5a5; color:#dc2626; }
    :root[data-theme="light"] .util-info { color:#64748b; }

    /* ── PER-MODULE START CARDS ── */
    /* ── PER-MODULE P&L CHART CARDS (Paper/Live toggle) ── */
    .mm-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
    .mm-card { background:#0d1320; border:1px solid #1a2236; border-radius:9px; padding:10px 12px 12px; display:flex; flex-direction:column; }
    .mm-hdr { display:flex; align-items:center; gap:8px; padding-bottom:6px; border-bottom:1px solid #1a2236; margin-bottom:6px; }
    .mm-dot { width:7px; height:7px; border-radius:50%; background:#4a6080; flex-shrink:0; }
    .mm-card.swing .mm-dot { background:#60a5fa; }
    .mm-card.scalp .mm-dot { background:#fbbf24; }
    .mm-card.pa    .mm-dot { background:#a78bfa; }
    .mm-title { font-size:0.62rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:#a0b0c8; }
    .mm-toggle { margin-left:auto; display:inline-flex; background:#07111f; border:1px solid #1a2236; border-radius:6px; padding:2px; }
    .mm-tog-btn { background:transparent; border:none; color:#4a6080; font-family:inherit; font-size:0.6rem; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; padding:3px 8px; border-radius:4px; cursor:pointer; transition:all 0.15s; }
    .mm-tog-btn:hover:not(.active) { color:#a0b0c8; }
    .mm-tog-btn.active { background:#0d1320; color:#e0eaf8; box-shadow:0 0 0 1px #1a3a6a inset; }
    .mm-tog-btn.active[data-src="live"] { box-shadow:0 0 0 1px #7f1d1d inset; color:#fca5a5; }
    .mm-stats { font-size:0.66rem; font-family:'IBM Plex Mono',monospace; color:#4a6080; margin-bottom:4px; }
    .mm-stats .pnl-pos { color:#10b981; font-weight:700; }
    .mm-stats .pnl-neg { color:#ef4444; font-weight:700; }
    .mm-stats .pnl-flat { color:#4a6080; font-weight:700; }
    .mm-wrap { position:relative; height:130px; }
    .mm-empty { text-align:center; padding:38px 20px 14px; color:#4a6080; font-size:0.72rem; }
    @media (max-width:900px) { .mm-grid { grid-template-columns:1fr 1fr; } }
    @media (max-width:640px) { .mm-grid { grid-template-columns:1fr; } }
    :root[data-theme="light"] .mm-card { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .mm-hdr { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .mm-title { color:#475569; }
    :root[data-theme="light"] .mm-toggle { background:#f1f5f9; border-color:#e0e4ea; }
    :root[data-theme="light"] .mm-tog-btn { color:#94a3b8; }
    :root[data-theme="light"] .mm-tog-btn:hover:not(.active) { color:#475569; }
    :root[data-theme="light"] .mm-tog-btn.active { background:#ffffff; color:#1e293b; box-shadow:0 0 0 1px #bfdbfe inset; }
    :root[data-theme="light"] .mm-tog-btn.active[data-src="live"] { box-shadow:0 0 0 1px #fca5a5 inset; color:#dc2626; }
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
    #trade-row, #scalp-row, #pa-row { display:flex; gap:12px; align-items:stretch; width:100%; flex-wrap:nowrap; }
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
    .dash-chart-wrap { position:relative; height:160px; }
    .dash-chart-empty { text-align:center; padding:46px 20px 14px; color:#4a6080; font-size:0.72rem; }
    @media (max-width:900px) { .dash-chart-grid { grid-template-columns:1fr; } }
    :root[data-theme="light"] .dash-chart-card { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .dash-chart-title { color:#475569; }
    :root[data-theme="light"] .dash-chart-stats { color:#94a3b8; }
    :root[data-theme="light"] .dash-chart-link { background:#eff6ff; border-color:#bfdbfe; color:#2563eb; }
    :root[data-theme="light"] .dash-chart-empty { color:#94a3b8; }

    /* ── MOBILE ── */
    @media (max-width:640px) {
      .main-content { margin-left:0; }
      .page { padding:12px 10px 40px; gap:10px; }
      .broker-grid { grid-template-columns:1fr; }
      .ts-grid     { grid-template-columns:1fr 1fr; }
      /* 3-col action row stacks to 1 col on mobile */
      .action-3col { grid-template-columns:1fr !important; }
      /* trade-row + scalp-row + pa-row: stack vertically */
      #trade-row, #scalp-row, #pa-row { flex-wrap:wrap; }
      #trade-row .card, #scalp-row .card, #pa-row .card { width:100%; flex:none; }
      /* top-bar: hide meta on mobile */
      .top-bar-meta { display:none; }
      .top-bar { padding:7px 10px 7px 48px; }
    }
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
      <div class="top-bar-meta">System overview · Broker connections · Session status</div>
    </div>
    <div class="top-bar-right">
      <div id="trading-status-alert" style="display:none;position:relative;"></div>
      ${liveActive ? '<span class="top-bar-badge live-active"><span style="width:5px;height:5px;border-radius:50%;background:#ef4444;display:inline-block;"></span>LIVE ACTIVE</span>' : ''}
      ${scalpModeOn && scalpMode === 'SCALP_LIVE' ? '<span class="top-bar-badge live-active" style="border-color:#f59e0b;"><span style="width:5px;height:5px;border-radius:50%;background:#f59e0b;display:inline-block;"></span>SCALP LIVE</span>' : ''}
      ${paModeOn && paMode === 'PA_LIVE' ? '<span class="top-bar-badge live-active" style="border-color:#a78bfa;"><span style="width:5px;height:5px;border-radius:50%;background:#a78bfa;display:inline-block;"></span>PA LIVE</span>' : ''}
      ${!liveActive && (!scalpModeOn || !scalpMode) && (!paModeOn || !paMode) ? '<span class="top-bar-badge">● IDLE</span>' : ''}
    </div>
  </div>

<div class="page">

  ${optionExpiryAlertHtml}

  <!-- ① BROKER CONNECTIONS — compact single-line rows -->
  <div class="brokers">
    <div class="brk-row ${fyersOk ? 'ok' : 'bad'}">
      <span class="brk-dot ${fyersOk ? 'pulse' : ''}"></span>
      <span class="brk-name">Fyers</span>
      <span class="brk-role">Market Data · WS · REST</span>
      <span class="brk-status">${fyersOk ? 'Connected' : 'Disconnected'}</span>
      ${fyersOk
        ? `<a href="/auth/login" class="brk-action re-login">re-login →</a>`
        : `<a href="/auth/login" class="brk-action login fyers">🔐 Login with Fyers</a>`}
    </div>
    <div class="brk-row ${zerodhaOk ? 'ok blue' : zerodhaConf ? 'bad' : 'muted'}">
      <span class="brk-dot ${zerodhaOk ? 'pulse' : ''}"></span>
      <span class="brk-name">Zerodha</span>
      <span class="brk-role">Orders · Live Trade</span>
      <span class="brk-status">${zerodhaOk ? 'Connected' : zerodhaConf ? 'Disconnected' : 'Not Configured'}</span>
      ${zerodhaOk
        ? `<a href="/auth/zerodha/login" class="brk-action re-login">re-login →</a>`
        : zerodhaConf
          ? `<a href="/auth/zerodha/login" class="brk-action login zerodha">🔐 Login with Zerodha</a>`
          : `<span class="brk-action muted-hint">Set ZERODHA_API_KEY in .env</span>`}
    </div>
    ${zerodhaOk && zerodhaExpiryHtml ? `<div class="brk-expiry ${pastExpiry ? 'expired' : nearExpiry ? 'expiring' : 'valid'}">${zerodhaExpiryHtml}</div>` : ''}
  </div>

  <!-- ① b — Compact utility strip -->
  <div class="util-strip">
    <button id="btn-all-paper" class="util-btn run-paper" onclick="startAllPaper(this)" title="Start all paper modes">▶ All Paper</button>
    <button id="btn-all-live"  class="util-btn run-live"  onclick="startAllLive(this)"  title="Start all live modes">▶ All Live</button>
    <button onclick="hardReset()" class="util-btn" title="Clears all tokens and restarts — use when tokens look stuck">🔄 Hard Reset</button>
    <button onclick="refreshHolidays()" id="holiday-refresh-btn" class="util-btn" title="Force-refresh NSE holidays cache">📅 Refresh Holidays</button>
    <button onclick="syncToLocal()" id="sync-local-btn" class="util-btn" title="Download ~/trading-data/ from server as tar.gz">📦 Sync to Local</button>
    <span class="util-info" id="cache-info-txt">📦 Candle cache: checking…</span>
  </div>

  <!-- ③ PER-MODULE CUMULATIVE P&L CHARTS (Paper/Live toggle, all-time) -->
  <div class="mm-grid">
    <div class="mm-card swing" data-mode="SWING">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">Swing</span>
        <div class="mm-toggle">
          <button type="button" class="mm-tog-btn active" data-src="paper">Paper</button>
          <button type="button" class="mm-tog-btn" data-src="live">Live</button>
        </div>
      </div>
      <div class="mm-stats" id="mm-stats-SWING">—</div>
      <div class="mm-wrap"><canvas id="mmChart-SWING"></canvas></div>
      <div class="mm-empty" id="mm-empty-SWING" style="display:none;">No paper trades yet</div>
    </div>
    ${scalpModeOn ? `
    <div class="mm-card scalp" data-mode="SCALP">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">Scalp</span>
        <div class="mm-toggle">
          <button type="button" class="mm-tog-btn active" data-src="paper">Paper</button>
          <button type="button" class="mm-tog-btn" data-src="live">Live</button>
        </div>
      </div>
      <div class="mm-stats" id="mm-stats-SCALP">—</div>
      <div class="mm-wrap"><canvas id="mmChart-SCALP"></canvas></div>
      <div class="mm-empty" id="mm-empty-SCALP" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
    ${paModeOn ? `
    <div class="mm-card pa" data-mode="PA">
      <div class="mm-hdr">
        <span class="mm-dot"></span>
        <span class="mm-title">Price Action</span>
        <div class="mm-toggle">
          <button type="button" class="mm-tog-btn active" data-src="paper">Paper</button>
          <button type="button" class="mm-tog-btn" data-src="live">Live</button>
        </div>
      </div>
      <div class="mm-stats" id="mm-stats-PA">—</div>
      <div class="mm-wrap"><canvas id="mmChart-PA"></canvas></div>
      <div class="mm-empty" id="mm-empty-PA" style="display:none;">No paper trades yet</div>
    </div>
    ` : ''}
  </div>

  <!-- ⑤ CUMULATIVE P&L CHART (Paper/Live toggle, all-time) -->
  <div class="dash-chart-card" id="dashCumCard" style="margin-top:4px;">
    <div class="dash-chart-hdr">
      <div class="dash-chart-title">
        <span class="dash-chart-dot" id="dashCumDot" style="background:#3b82f6;"></span>
        <span>Cumulative P&amp;L</span>
      </div>
      <div class="mm-toggle dc-toggle">
        <button type="button" class="mm-tog-btn dc-tog-btn active" data-src="paper">Paper</button>
        <button type="button" class="mm-tog-btn dc-tog-btn" data-src="live">Live</button>
      </div>
      <div class="dash-chart-stats" id="dash-cum-stats">—</div>
      <a href="/consolidation" id="dashCumLink" class="dash-chart-link">View →</a>
    </div>
    <div class="dash-chart-wrap"><canvas id="dashCumChart"></canvas></div>
    <div id="dashCumEmpty" class="dash-chart-empty" style="display:none;">No paper trades yet</div>
  </div>

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
${scalpModeOn ? `
function renderScalpPaperStatus(d){
  var rb=document.getElementById('scalp-paper-run-badge'), sb=document.getElementById('scalp-paper-stop-badge');
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
  document.getElementById('scalp-paper-status-body').innerHTML=
    '<div class="ts-grid">'
    +'<div class="ts-cell"><div class="ts-label">Session PnL</div><div class="ts-val '+pnl.cls+'">'+pnl.txt+'</div><div class="ts-sub">'+d.tradeCount+' trades · '+(d.wins||0)+'W/'+(d.losses||0)+'L</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Unrealised PnL</div><div class="ts-val '+upnl.cls+'">'+upnl.txt+'</div><div class="ts-sub">spot proxy</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Capital</div><div class="ts-val">'+capital+'</div><div class="ts-sub">Simulated</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Total PnL (all-time)</div><div class="ts-val '+fmtPnl(d.totalPnl).cls+'">'+fmtPnl(d.totalPnl).txt+'</div><div class="ts-sub">From saved data</div></div>'
    +'</div>'
    +posHtml;
}

function renderScalpLiveStatus(d){
  var rb=document.getElementById('scalp-live-run-badge'), sb=document.getElementById('scalp-live-stop-badge');
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
  document.getElementById('scalp-live-status-body').innerHTML=
    '<div class="ts-grid">'
    +'<div class="ts-cell"><div class="ts-label">Session PnL</div><div class="ts-val '+pnl.cls+'">'+pnl.txt+'</div><div class="ts-sub">'+d.tradeCount+' trades · '+(d.wins||0)+'W/'+(d.losses||0)+'L</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Opt Premium PnL</div><div class="ts-val '+upnl.cls+'">'+upnl.txt+'</div><div class="ts-sub">Unrealised</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Activity</div><div class="ts-val flat" style="font-size:0.82rem;">'+(d.tickCount||0)+' / '+(d.candleCount||0)+'</div><div class="ts-sub">Ticks / Candles</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Daily Loss</div><div class="ts-val flat" style="font-size:0.78rem;color:'+(d.dailyLossHit?'#ef4444':'#10b981')+';">'+(d.dailyLossHit?'KILLED':'OK')+'</div><div class="ts-sub">Limit: \\u20b9${process.env.SCALP_MAX_DAILY_LOSS || "2000"}</div></div>'
    +'</div>'
    +posHtml;
}
` : ''}
async function pollDashboardStatus(){
  try {
    var pr = await fetch('/swing-paper/status/data',{cache:'no-store'});
    if(pr.ok){ var pd=await pr.json(); renderPaperStatus(pd); }
    else { renderPaperStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null,pnlSource:'—'}); }
  } catch(e){
    renderPaperStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null,pnlSource:'—'});
  }
  try {
    var lr = await fetch('/swing-live/status/data',{cache:'no-store'});
    if(lr.ok){ var ld=await lr.json(); renderLiveStatus(ld); }
    else { renderLiveStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,fyersOk:false,zerodhaOk:false,tickCount:0,candleCount:0}); }
  } catch(e){
    renderLiveStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,fyersOk:false,zerodhaOk:false,tickCount:0,candleCount:0});
  }
  // Scalp Paper status
  ${scalpModeOn ? `try {
    var sp = await fetch('/scalp-paper/status/data',{cache:'no-store'});
    if(sp.ok){ var spd=await sp.json(); renderScalpPaperStatus(spd); }
    else { renderScalpPaperStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null}); }
  } catch(e){ renderScalpPaperStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null}); }
  // Scalp Live status
  try {
    var sr = await fetch('/scalp-live/status/data',{cache:'no-store'});
    if(sr.ok){ var sd=await sr.json(); renderScalpLiveStatus(sd); }
    else { renderScalpLiveStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,tickCount:0,candleCount:0}); }
  } catch(e){ renderScalpLiveStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,tickCount:0,candleCount:0}); }` : ''}
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
      && (${scalpModeOn ? "_isOn('scalp-paper-run-badge')" : "true"})
      && (${paModeOn ? "_isOn('pa-paper-run-badge')" : "true"});
    if(allOn){ bPaper.disabled=true; bPaper.textContent='✓ ALL PAPER RUNNING'; bPaper.style.borderColor='#166534'; bPaper.style.opacity='0.6'; }
    else { bPaper.disabled=false; bPaper.textContent='▶ START ALL PAPER TRADES'; bPaper.style.opacity='1'; }
  }
  if(bLive){
    var allLiveOn = _isOn('live-run-badge')
      && (${scalpModeOn ? "_isOn('scalp-live-run-badge')" : "true"})
      && (${paModeOn ? "_isOn('pa-live-run-badge')" : "true"});
    if(allLiveOn){ bLive.disabled=true; bLive.textContent='✓ ALL LIVE RUNNING'; bLive.style.borderColor='#7f1d1d'; bLive.style.opacity='0.6'; }
    else { bLive.disabled=false; bLive.textContent='▶ START ALL LIVE TRADES'; bLive.style.opacity='1'; }
  }
}
/* pollDashboardStatus disabled — dashboard no longer shows realtime data */

// ── Quick Action: Start All Paper / All Live ────────────────────────────────
var PAPER_ENDPOINTS = ['/swing-paper/start'${scalpModeOn ? ",'/scalp-paper/start'" : ""}${paModeOn ? ",'/pa-paper/start'" : ""}];
var LIVE_ENDPOINTS  = ['/swing-live/start'${scalpModeOn ? ",'/scalp-live/start'"  : ""}${paModeOn ? ",'/pa-live/start'"  : ""}];

function _escHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}

function _prettyEndpoint(url){
  var m = /\\/(\\w+)-(\\w+)\\/start/.exec(url);
  if (!m) return url;
  var mode = { swing:'Swing', scalp:'Scalp', pa:'Price Action' }[m[1]] || m[1];
  return mode + ' ' + (m[2] === 'paper' ? 'Paper' : 'Live');
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
        var extraNote   = isLive ? '\\n\\nThis is LIVE trading with real capital. Strongly recommend: cancel and update Swing Option Expiry in Settings instead.' : '\\n\\nDo you want to start anyway? (Strongly recommend: cancel and update Swing Option Expiry in Settings instead.)';
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
          results.failures.push({ endpoint: ep, status: 409, error: 'Skipped — 0DTE expiry-day. Update Swing Option Expiry in Settings.' });
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
  var orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Starting all paper trades...';
  var result = await _startAll(PAPER_ENDPOINTS);
  await _handleStartAllResult(btn, orig, 'All Paper', result);
}

async function startAllLive(btn){
  var ok = await showConfirm({
    icon: '⚠️', title: 'Start ALL Live Trades',
    message: 'Start Swing Live'+(${scalpModeOn ? "' + Scalp Live'" : "''"})+(${paModeOn ? "' + PA Live'" : "''"})+'?\\nReal orders will be placed on broker accounts.',
    confirmText: 'Start All', confirmClass: 'modal-btn-danger'
  });
  if(!ok) return;
  var orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Starting all live trades...';
  var result = await _startAll(LIVE_ENDPOINTS);
  await _handleStartAllResult(btn, orig, 'All Live', result);
}

// ── Quick-Action button live state (mutual lock: Paper ↔ Live) ──────────────
var ALL_BTN_POLL = [
  { url:'/swing-paper/status/data', kind:'paper' },
  { url:'/swing-live/status/data',  kind:'live'  }
  ${scalpModeOn ? ",{ url:'/scalp-paper/status/data', kind:'paper' },{ url:'/scalp-live/status/data', kind:'live' }" : ""}
  ${paModeOn ? ",{ url:'/pa-paper/status/data', kind:'paper' },{ url:'/pa-live/status/data', kind:'live' }" : ""}
];

function _applyAllBtnState(paperOn, liveOn){
  var bPaper = document.getElementById('btn-all-paper');
  var bLive  = document.getElementById('btn-all-live');
  if(!bPaper || !bLive) return;
  bPaper.classList.remove('is-active-paper','is-locked');
  bLive.classList.remove('is-active-live','is-locked');
  if(paperOn){
    bPaper.disabled = true;
    bPaper.classList.add('is-active-paper');
    bPaper.textContent = '● PAPER ACTIVE';
    bPaper.title = 'Paper trading is running';
    bLive.disabled = true;
    bLive.classList.add('is-locked');
    bLive.textContent = '🔒 Live locked';
    bLive.title = 'Stop all paper trades before starting live';
  } else if(liveOn){
    bLive.disabled = true;
    bLive.classList.add('is-active-live');
    bLive.textContent = '● LIVE ACTIVE';
    bLive.title = 'Live trading is running';
    bPaper.disabled = true;
    bPaper.classList.add('is-locked');
    bPaper.textContent = '🔒 Paper locked';
    bPaper.title = 'Stop all live trades before starting paper';
  } else {
    bPaper.disabled = false;
    bPaper.textContent = '▶ All Paper';
    bPaper.title = 'Start all paper modes';
    bLive.disabled = false;
    bLive.textContent = '▶ All Live';
    bLive.title = 'Start all live modes';
  }
}

async function pollAllBtnsStatus(){
  if(!document.getElementById('btn-all-paper')) return;
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
    _applyAllBtnState(paperOn, liveOn);
  } catch(_){}
}
pollAllBtnsStatus();
setInterval(pollAllBtnsStatus, 5000);

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
      data: s.data, borderColor: baseColor, backgroundColor: baseFill,
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
    var r = await fetch('/consolidation/data', { cache: 'no-store' });
    if (r.ok){ var d = await r.json(); _dcData.paper = (d && d.trades) || []; }
  } catch(_){ _dcData.paper = []; }
  try {
    var r2 = await fetch('/live-consolidation/data', { cache: 'no-store' });
    if (r2.ok){ var d2 = await r2.json(); _dcData.live = (d2 && d2.trades) || []; }
  } catch(_){ _dcData.live = []; }
  _renderDashTotal();
}

document.addEventListener('click', function(e){
  var btn = e.target.closest && e.target.closest('.dc-tog-btn');
  if (!btn) return;
  var src = btn.getAttribute('data-src');
  if (!src || _dcToggle === src) return;
  _dcToggle = src;
  var card = btn.closest('.dash-chart-card');
  if (card) card.querySelectorAll('.dc-tog-btn').forEach(function(b){ b.classList.toggle('active', b === btn); });
  _renderDashTotal();
});

loadDashCumCharts();

// ── Per-Module P&L Charts (Paper/Live toggle, all-time) ──────────────────────
var _mmData = { paper: null, live: null };
var _mmCharts = {};
var _mmToggle = { SWING: 'paper', SCALP: 'paper', PA: 'paper' };

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
  ['SWING','SCALP','PA'].forEach(_renderModuleChart);
}

document.addEventListener('click', function(e){
  var btn = e.target.closest && e.target.closest('.mm-tog-btn');
  if (!btn) return;
  var card = btn.closest('.mm-card');
  if (!card) return;
  var mode = card.getAttribute('data-mode');
  var src  = btn.getAttribute('data-src');
  if (!mode || !src || _mmToggle[mode] === src) return;
  _mmToggle[mode] = src;
  card.querySelectorAll('.mm-tog-btn').forEach(function(b){ b.classList.toggle('active', b === btn); });
  _renderModuleChart(mode);
});

loadModuleCharts();

// ── Candle cache info ─────────────────────────────────────────────────────────
async function loadCacheInfo(){
  try {
    var r = await fetch('/api/cache-info', {cache:'no-store'});
    if (!r.ok) return;
    var d = await r.json();
    var el = document.getElementById('cache-info-txt');
    if (!el) return;
    if (d.cache) {
      el.style.color = '#10b981';
      el.textContent = '📦 ' + d.cache.candles + ' candles · ' + d.cache.from + ' → ' + d.cache.to + ' · ' + d.cache.sizeKB + ' KB';
    } else {
      el.style.color = '#4a6080';
      el.textContent = '📦 No cache yet — built on first session start';
    }
  } catch(_){}
}
loadCacheInfo();

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
    if(!alertDiv || alertDiv._dismissed) return;
    var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    var day = now.getDay(); var hour = now.getHours();
    if(day === 0 || day === 6){
      showStatusPill(alertDiv, '🏖️', 'Weekend — markets resume Monday 9:15 AM', '#ef4444'); return;
    }
    if(hour < 7 || hour >= 16){
      showStatusPill(alertDiv, '🕐', hour < 7 ? 'Pre-market — opens 9:15 AM IST' : 'Post-market — closed for the day', '#60a5fa'); return;
    }
    var res = await fetch('/api/holidays', {cache:'no-store'});
    if(res.ok){
      var data = await res.json();
      if(data.success && data.holidays){
        var todayStr = now.toISOString().split('T')[0];
        if(data.holidays.includes(todayStr)){
          showStatusPill(alertDiv, '🎉', 'NSE Holiday — markets closed today', '#fbbf24'); return;
        }
      }
    }
    alertDiv.style.display = 'none';
  } catch(e){}
}
checkTradingStatus();
setInterval(checkTradingStatus, 60000); // Check every minute
/* setInterval(pollDashboardStatus, 4000); — disabled (no realtime data on dashboard) */
// ─────────────────────────────────────────────────────────────────────────────

async function hardReset(){
  var ok = await showConfirm({
    icon: '⚠️', title: 'Hard Reset',
    message: 'Clear all tokens and restart the server?\\nYou will need to re-login both Fyers and Zerodha after.',
    confirmText: 'Reset', confirmClass: 'modal-btn-danger'
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

async function refreshHolidays(){
  var btn = document.getElementById('holiday-refresh-btn');
  if(!btn) return;

  btn.disabled = true;
  btn.textContent = '⏳ Refreshing...';
  btn.style.opacity = '0.6';

  try {
    var res = await secretFetch('/api/holidays/refresh', {method:'POST'});
    btn.disabled = false;
    btn.textContent = '📅 Refresh Holidays';
    btn.style.opacity = '1';
    if(!res) return;
    if(!res.ok) throw new Error('HTTP ' + res.status + ': ' + res.statusText);
    var d = await res.json();
    if(d.success){
      await showAlert({icon:'✅',title:'Holidays Refreshed',message:'Fetched ' + d.count + ' holidays from NSE API.\\nCache updated. Trading status check will use the updated list.',btnClass:'modal-btn-success'});
      checkTradingStatus();
    } else {
      await showAlert({icon:'⚠️',title:'NSE API Unavailable',message:'NSE API is currently blocking requests or unavailable.\\n\\nUsing fallback holiday list (' + (d.count||17) + ' holidays for 2026).\\nYour trading bot will continue working normally.',btnClass:'modal-btn-primary'});
      checkTradingStatus();
    }
  } catch(err){
    btn.disabled = false;
    btn.textContent = '📅 Refresh Holidays';
    btn.style.opacity = '1';
    showAlert({icon:'❌',title:'Network Error',message:err.message+'\\n\\nPlease check your internet connection and try again.',btnClass:'modal-btn-danger'});
  }
}

// ── Sync to Local — one-shot tar.gz download of ~/trading-data/ from server ──
function fmtBytes(n){
  if(!n) return '0 B';
  var u=['B','KB','MB','GB']; var i=0;
  while(n>=1024 && i<u.length-1){ n/=1024; i++; }
  return n.toFixed(n<10?2:1)+' '+u[i];
}
async function syncToLocal(){
  var btn = document.getElementById('sync-local-btn');
  if(!btn) return;
  btn.disabled = true;
  var orig = btn.textContent;
  btn.textContent = '⏳ Checking…';
  btn.style.opacity = '0.6';

  // 1) Fetch size preview
  var info;
  try {
    var r = await secretFetch('/sync/info');
    if(!r) { btn.disabled=false; btn.textContent=orig; btn.style.opacity='1'; return; }
    if(!r.ok) throw new Error('HTTP ' + r.status);
    info = await r.json();
  } catch(err){
    btn.disabled=false; btn.textContent=orig; btn.style.opacity='1';
    showAlert({icon:'❌',title:'Could not read server data',message:err.message,btnClass:'modal-btn-danger'});
    return;
  }

  btn.disabled=false; btn.textContent=orig; btn.style.opacity='1';

  if(!info.exists){
    showAlert({icon:'📭',title:'Nothing to sync',message:'~/trading-data/ does not exist on the server yet.\\nRun a paper or live session first.',btnClass:'modal-btn-primary'});
    return;
  }

  // 2) Confirm with user
  var ageMin = info.newestMtimeMs ? Math.round((Date.now()-info.newestMtimeMs)/60000) : null;
  var ageStr = ageMin === null ? '' : (ageMin < 60 ? ageMin+' min ago' : ageMin < 1440 ? Math.round(ageMin/60)+' h ago' : Math.round(ageMin/1440)+' d ago');
  var msg = 'Download a snapshot of the server\\'s ~/trading-data/ folder.\\n\\n' +
            '• Files: ' + info.fileCount + '\\n' +
            '• Size:  ' + fmtBytes(info.totalBytes) + ' (uncompressed)\\n' +
            (ageStr ? '• Newest: ' + ageStr + '\\n' : '') +
            '\\nFormat: .tar.gz — unpack with: tar -xzf <file>';
  var ok = await showConfirm({
    icon:'📦', title:'Sync to Local',
    message: msg,
    confirmText:'Download', confirmClass:'modal-btn-primary'
  });
  if(!ok) return;

  // 3) Trigger download via hidden link. Pass API secret as query param if set
  // (browser navigation can't carry the x-api-secret header).
  var url = '/sync/download-all';
  try {
    var s = sessionStorage.getItem('__api_secret');
    if(s) url += '?secret=' + encodeURIComponent(s);
  } catch(_){}
  var a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ document.body.removeChild(a); }, 1000);
}
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
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  res.status(500).json({ success: false, error: err.message, stack: process.env.NODE_ENV === "development" ? err.stack : undefined });
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
  try { sendTelegramSync(`🚨 UNCAUGHT EXCEPTION\n${truncate(err.message, 300)}\n\nStack:\n${truncate(err.stack || "(no stack)", 600)}`); } catch (_) {}
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
// Clears BOTH Fyers and Zerodha tokens at 3:31 PM IST every day.
// This ensures:
//   (a) Tokens are wiped even if the app ran all day without a manual stop.
//   (b) Next morning on first startup, loadToken() sees no file → forces fresh login.
// Re-schedules itself for the same time the next day so it runs perpetually.

function scheduleEODTokenClear() {
  // IST = UTC+5:30. Target: 3:31 PM IST = 10:01 AM UTC
  const now     = new Date();
  const utcH    = now.getUTCHours();
  const utcM    = now.getUTCMinutes();
  const utcNow  = utcH * 60 + utcM;
  const target  = 10 * 60 + 1;  // 10:01 UTC = 15:31 IST
  let msUntil   = (target - utcNow) * 60 * 1000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds();
  if (msUntil <= 0) msUntil += 24 * 60 * 60 * 1000; // if already past, schedule for tomorrow

  console.log(`🕒 EOD token clear scheduled in ${Math.round(msUntil / 60000)} min (at 3:31 PM IST)`);

  setTimeout(() => {
    try {
      console.log("🔴 [EOD] 3:31 PM IST — auto-clearing Fyers & Zerodha tokens...");
      clearFyersToken();
      zerodha.clearZerodhaToken();
      console.log("✅ [EOD] Both tokens cleared. Fresh login required tomorrow morning.");
    } catch (err) {
      console.error(`❌ [EOD] Token clear failed: ${err.message}`);
    } finally {
      scheduleEODTokenClear(); // always re-schedule for tomorrow's 3:31 PM
    }
  }, msUntil);
}

scheduleEODTokenClear();

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
  console.log(`   Live Trading     : ${process.env.SWING_LIVE_ENABLED === "true" ? "✅ ENABLED" : "🔒 disabled"}`);
  console.log(`   Scalp Mode       : ${(process.env.SCALP_MODE_ENABLED || "true") === "true" ? "✅ ENABLED" : "🔒 disabled"} | SCALP_ENABLED: ${process.env.SCALP_ENABLED === "true" ? "✅" : "❌"}`);
  console.log(`   VIX Filter       : ${process.env.VIX_FILTER_ENABLED !== "false" ? `✅ max=${process.env.VIX_MAX_ENTRY || "20"} strong=${process.env.VIX_STRONG_ONLY || "16"}` : "🔒 disabled"}`);
  console.log(`   Hard SL          : ${process.env.HARD_SL_ENABLED === "true" ? `✅ delta=${process.env.HARD_SL_DELTA || "0.5"}` : "🔒 disabled"}`);
  console.log(`   Telegram         : ${process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? "✅ configured" : "❌ not set"}`);
  console.log(`   Login Gate       : ${process.env.LOGIN_SECRET ? "✅ active" : "🔓 open (no LOGIN_SECRET)"}`);
  console.log(`   Node             : ${process.version} | PID: ${process.pid}`);
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

    const savedScalp = loadScalpPosition();
    if (savedScalp && savedScalp.position) {
      const p = savedScalp.position;
      const msg = `🚨 [STARTUP] Persisted SCALP position found (crash recovery)!\n` +
        `  ${p.side} ${p.symbol}: entry=₹${p.entryPrice} SL=₹${p.stopLoss} qty=${p.qty}\n` +
        `  Saved at: ${new Date(savedScalp.savedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
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
        if (savedScalp) clearScalpPosition();  // broker confirms no position — safe to clear
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
    if (sharedSocketState.getMode())      activeModes.push(sharedSocketState.getMode());
    if (sharedSocketState.getScalpMode()) activeModes.push(sharedSocketState.getScalpMode());
    if (sharedSocketState.getPAMode())    activeModes.push(sharedSocketState.getPAMode());

    if (activeModes.length === 0) {
      console.log("✅ [SHUTDOWN] No active trading modes — clean exit.");
      try {
        const mu = process.memoryUsage();
        sendTelegramSync(`ℹ️ SHUTDOWN: Bot received ${signal} (no active modes). RSS=${(mu.rss/1048576).toFixed(0)}MB heap=${(mu.heapUsed/1048576).toFixed(0)}MB uptime=${Math.floor(process.uptime())}s`);
      } catch (_) {}
      process.exit(0);
      return;
    }

    const modeList = activeModes.join(", ");
    const hasLive = activeModes.some(m => m === "SWING_LIVE" || m === "SCALP_LIVE" || m === "PA_LIVE");
    console.warn(`⚠️ [SHUTDOWN] Active modes: ${modeList} — stopping sessions...`);

    // Call stopSession() on each active route — this triggers squareOff for live modes
    const routeMap = {
      "SCALP_LIVE":  require("./routes/scalpLive"),
      "SCALP_PAPER": require("./routes/scalpPaper"),
      "PA_LIVE":     require("./routes/paLive"),
      "PA_PAPER":    require("./routes/paPaper"),
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

    // Wait for squareOff orders to complete before exiting
    const waitMs = hasLive ? 8000 : 3000;
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
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    fyers: !!process.env.ACCESS_TOKEN,
    zerodha: zerodha.isAuthenticated(),
    activeMode: sharedSocketState.getMode() || null,
    scalpMode: sharedSocketState.getScalpMode() || null,
    timestamp: new Date().toISOString(),
  });
});
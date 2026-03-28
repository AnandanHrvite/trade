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
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🪔</text></svg>">
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
</style></head><body>
<div class="login-box">
<div class="login-icon">🔒</div>
<div class="login-title">Trading Bot</div>
<div class="login-sub">Enter password to continue</div>
<form method="POST" action="/login">
<input type="password" name="password" class="login-input" placeholder="Password" autofocus required>
<button type="submit" class="login-btn">Login</button>
</form>
<div class="login-error">${error || ''}</div>
</div></body></html>`;
}

// URL-encoded body parser for login form
app.use(express.urlencoded({ extended: false }));

app.get("/login", (req, res) => {
  const secret = process.env.LOGIN_SECRET;
  if (!secret) return res.redirect("/");
  res.setHeader("Content-Type", "text/html");
  res.send(loginPageHTML());
});

app.post("/login", (req, res) => {
  const secret = process.env.LOGIN_SECRET;
  if (!secret) return res.redirect("/");
  if (req.body.password === secret) {
    const token = crypto.createHash("sha256").update(secret).digest("hex");
    res.setHeader("Set-Cookie", `${LOGIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${LOGIN_MAX_AGE}`);
    return res.redirect("/");
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
  if (req.path === "/login") return next();
  // Parse cookie (split on first = only — values may contain =)
  const cookies = (req.headers.cookie || "").split(";").reduce((acc, c) => {
    const idx = c.indexOf("=");
    if (idx > 0) acc[c.substring(0, idx).trim()] = c.substring(idx + 1).trim();
    return acc;
  }, {});
  const expectedToken = crypto.createHash("sha256").update(secret).digest("hex");
  if (cookies[LOGIN_COOKIE] === expectedToken) {
    // Sliding expiry — refresh cookie on every request to reset the 15-min timer
    res.setHeader("Set-Cookie", `${LOGIN_COOKIE}=${expectedToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${LOGIN_MAX_AGE}`);
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
  "/trade/status",          // read-only status page
  "/trade/status/data",     // dashboard AJAX poll — must be open or 403 when API_SECRET is set
  "/paperTrade/status",     // read-only status page
  "/paperTrade/status/data",// dashboard AJAX poll — must be open or 403 when API_SECRET is set
  "/paperTrade/history",    // read-only history
  "/paperTrade/debug",      // read-only debug
  "/paperTrade/client.js",  // static asset
  "/tracker/status",          // read-only tracker page
  "/tracker/status/data",     // AJAX poll — must be open
  "/tracker/fetch-and-start", // auto-fetch + start (Zerodha read + SAR compute)
  "/result",                // read-only results
  "/result/all",
  "/auth/status",           // read-only auth status
  "/auth/zerodha/status",
  "/auth/zerodha/logout",
  "/api/holidays",          // read-only holiday list
  "/api/cache-info",        // read-only candle cache stats
  "/settings",              // settings page (read-only view)
  "/settings/data",         // AJAX poll for current values
  // NOTE: /settings/save requires API_SECRET (write operation)
  // NOTE: /trade/start, /trade/stop, /trade/exit are intentionally NOT here — they require API_SECRET
  // NOTE: /paperTrade/start, /paperTrade/stop, /paperTrade/reset, /paperTrade/exit also require secret
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
app.use("/backtest",   require("./routes/backtest"));
app.use("/result",     require("./routes/result"));
app.use("/paperTrade", require("./routes/paperTrade"));
app.use("/trade",      require("./routes/trade"));
app.use("/tracker",    require("./routes/manualTracker"));
app.use("/logs",       require("./routes/logs"));       // ← live log viewer
app.use("/settings",   require("./routes/settings"));   // ← settings UI

// ── Holiday Management API ────────────────────────────────────────────────────
const { refreshHolidayCache, getNSEHolidays } = require("./utils/nseHolidays");

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
  try {
  const fyersOk     = !!process.env.ACCESS_TOKEN;
  const zerodhaOk   = zerodha.isAuthenticated();
  const zerodhaConf = !!process.env.ZERODHA_API_KEY;
  const liveEnabled = process.env.LIVE_TRADE_ENABLED === "true";
  const liveReady   = liveEnabled && fyersOk && zerodhaOk;
  const liveActive  = sharedSocketState.getMode() === "LIVE_TRADE";
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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="icon" type="image/png" href="data:image/png;base64,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"/>
  <title>ௐ Palani Andawar Thunai ॐ — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; min-height:100vh; overflow-x:hidden; }
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}

    ${sidebarCSS()}

    /* ── PAGE WRAPPER ── */
    .page { padding:28px 24px 48px; display:flex; flex-direction:column; gap:12px; }

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
      #trade-row { flex-wrap:wrap; }
      #trade-row .card { flex:none; width:100%; }
    }

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
    #trade-row { display:flex; gap:12px; align-items:stretch; width:100%; flex-wrap:nowrap; }
    @media (max-width:900px) { .ts-grid { grid-template-columns:1fr 1fr; } }

    /* cfg-grid removed — config shown as strip in broker card */
    /* cfg-cell/live-note styles removed — config shown as strip in broker card */

    /* ── MOBILE ── */
    @media (max-width:640px) {
      .main-content { margin-left:0; }
      .page { padding:12px 10px 40px; gap:10px; }
      .broker-grid { grid-template-columns:1fr; }
      .ts-grid     { grid-template-columns:1fr 1fr; }
      /* 3-col action row stacks to 1 col on mobile */
      .action-3col { grid-template-columns:1fr !important; }
      /* trade-row: stack Paper+Live vertically */
      #trade-row { flex-wrap:wrap; }
      #trade-row .card { width:100%; flex:none; }
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
      ${liveActive ? '<span class="top-bar-badge live-active"><span style="width:5px;height:5px;border-radius:50%;background:#ef4444;display:inline-block;"></span>LIVE ACTIVE</span>' : '<span class="top-bar-badge">● IDLE</span>'}
    </div>
  </div>

<div class="page">

  <!-- ① BROKER CONNECTIONS — redesigned -->
  <div class="card">
    <div class="card-hdr">
      <span class="card-hdr-icon">🔌</span>
      <span class="card-hdr-title">Broker Connections</span>
    </div>
    <div class="card-body">
      <div class="broker-grid">

        <!-- Fyers Card -->
        <div class="broker-card ${fyersOk ? 'connected-green' : 'error-state'}">
          <div class="broker-card-top">
            <div class="broker-identity">
              <div class="broker-logo fyers-logo">📊</div>
              <div class="broker-name-wrap">
                <div class="broker-name">Fyers</div>
                <div class="broker-role">Market Data · Websocket · REST</div>
              </div>
            </div>
            <div class="broker-status-pill ${fyersOk ? 'ok-green' : 'err'}">
              <span class="broker-status-dot ${fyersOk ? 'pulse' : ''}"></span>
              ${fyersOk ? 'Connected' : 'Disconnected'}
            </div>
          </div>
          <div class="broker-meta">
            <span class="tag">WebSocket</span><span class="tag">REST Quotes</span><span class="tag">Historical</span>
            <br/>Used by: Backtest · Paper Trade · Live Trade
          </div>
          <div class="broker-action">
            ${fyersOk
              ? `<div class="broker-connected-bar green">
                  <span>✅ Token active</span>
                  <a href="/auth/login" class="relogin-link">re-login →</a>
                 </div>`
              : `<a href="/auth/login" class="broker-login-btn fyers-btn">🔐 Login with Fyers</a>`
            }
          </div>
        </div>

        <!-- Zerodha Card -->
        <div class="broker-card ${zerodhaOk ? 'connected-blue' : zerodhaConf ? 'error-state' : 'no-config'}">
          <div class="broker-card-top">
            <div class="broker-identity">
              <div class="broker-logo zerodha-logo">
                <span style="width:16px;height:16px;background:#7c3aed;border-radius:50%;display:inline-block;"></span>
              </div>
              <div class="broker-name-wrap">
                <div class="broker-name">Zerodha</div>
                <div class="broker-role">Order Execution · Live Trade</div>
              </div>
            </div>
            <div class="broker-status-pill ${zerodhaOk ? 'ok-blue' : zerodhaConf ? 'err' : 'grey'}">
              <span class="broker-status-dot ${zerodhaOk ? 'pulse' : ''}"></span>
              ${zerodhaOk ? 'Connected' : zerodhaConf ? 'Disconnected' : 'Not Configured'}
            </div>
          </div>
          <div class="broker-meta">
            <span class="tag">Orders API</span><span class="tag">Free Personal</span>
            <br/>Used by: Live Trade only
          </div>
          <div class="broker-action">
            ${zerodhaOk
              ? `<div class="broker-connected-bar blue">
                  <span>✅ Token active</span>
                  <a href="/auth/zerodha/login" class="relogin-link">re-login →</a>
                 </div>
                 ${zerodhaExpiryHtml ? `<div class="broker-expiry-warn ${pastExpiry ? 'expired' : nearExpiry ? 'expiring' : 'valid'}">${zerodhaExpiryHtml}</div>` : ''}`
              : zerodhaConf
                ? `<a href="/auth/zerodha/login" class="broker-login-btn zerodha-btn">🔐 Login with Zerodha</a>`
                : `<div class="broker-no-config">Add <code>ZERODHA_API_KEY</code> &amp; <code>ZERODHA_API_SECRET</code> to .env</div>`
            }
          </div>
        </div>

      </div>

      <div class="broker-divider"></div>
      <div class="action-3col" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;">

        <div style="padding:12px 16px;border-right:1px solid #1a2236;">
          <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:6px;">⚠️ Socket / Tokens</div>
          <div style="font-size:0.7rem;color:#4a6080;margin-bottom:8px;line-height:1.4;">Stuck or bad state? Clears all tokens &amp; restarts process (PM2 revives).</div>
          <button onclick="hardReset()" class="hard-reset-btn" style="width:100%;justify-content:center;">🔄 Hard Reset</button>
        </div>

        <div style="padding:12px 16px;border-right:1px solid #1a2236;">
          <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:6px;">📅 NSE Holidays</div>
          <div style="font-size:0.7rem;color:#4a6080;margin-bottom:8px;line-height:1.4;">Auto-fetched daily. Click to force-refresh from NSE API immediately.</div>
          <button onclick="refreshHolidays()" class="hard-reset-btn" style="background:#0a0f14;border-color:#1a4a8a;color:#60a5fa;width:100%;justify-content:center;" id="holiday-refresh-btn">📅 Refresh Holidays</button>
        </div>

        <div style="padding:12px 16px;">
          <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:6px;">📦 Candle Cache</div>
          <div style="font-size:0.7rem;color:#4a6080;line-height:1.4;" id="cache-info-txt">checking...</div>
        </div>

      </div>
      <div class="broker-divider"></div>
      <div style="padding:10px 0 4px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <span style="font-size:0.58rem;text-transform:uppercase;letter-spacing:1.4px;color:#3a5070;margin-right:4px;">Config</span>
        <span style="font-size:0.72rem;background:#050d1a;border:0.5px solid #0e1e36;border-radius:5px;padding:3px 10px;color:#60a5fa;">${ACTIVE} · ${activeStrategyName}</span>
        <span style="font-size:0.72rem;background:#050d1a;border:0.5px solid #0e1e36;border-radius:5px;padding:3px 10px;color:#a78bfa;">NIFTY OPTIONS · 65 qty/lot</span>
        <span style="font-size:0.72rem;background:#050d1a;border:0.5px solid #0e1e36;border-radius:5px;padding:3px 10px;color:#f59e0b;">${process.env.TRADE_RESOLUTION || "15"}-min candles</span>
        <span style="font-size:0.72rem;background:#050d1a;border:0.5px solid ${liveReady ? '#10b981' : liveEnabled ? '#f59e0b' : '#374151'};border-radius:5px;padding:3px 10px;color:${liveReady ? '#10b981' : liveEnabled ? '#f59e0b' : '#6b7280'};">${liveReady ? '⚡ Live Ready' : liveEnabled ? '⚠ Needs Login' : '🔒 Live Disabled'}</span>
      </div>
    </div>
  </div>

  <!-- ③ PAPER + LIVE TRADE side by side -->
  <div id="trade-row">

  <div class="card" id="paper-status-card" style="flex:1;min-width:0;">
    <div class="card-hdr" style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="card-hdr-icon">📋</span>
        <span class="card-hdr-title">Paper Trade</span>
        <span id="paper-run-badge" style="display:none;font-size:0.6rem;font-weight:700;letter-spacing:1.2px;padding:2px 8px;border-radius:4px;background:#0d3018;color:#4ade80;border:1px solid #166534;">RUNNING</span>
        <span id="paper-stop-badge" style="display:none;font-size:0.6rem;font-weight:700;letter-spacing:1.2px;padding:2px 8px;border-radius:4px;background:#1a1a2e;color:#3a5070;border:1px solid #252550;">IDLE</span>
      </div>
      <a href="/paperTrade/status" style="font-size:0.72rem;color:#c89828;text-decoration:none;padding:5px 12px;border-radius:6px;border:1px solid #3a2a00;background:#120e00;white-space:nowrap;">Open Paper →</a>
    </div>
    <div id="paper-status-body" style="padding:14px 18px 16px;">
      <div style="color:#3a5070;font-size:0.75rem;">Loading…</div>
    </div>
  </div>

  <div class="card" id="live-status-card" style="flex:1;min-width:0;">
    <div class="card-hdr" style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="card-hdr-icon">🔴</span>
        <span class="card-hdr-title">Live Trade</span>
        <span id="live-run-badge" style="display:none;font-size:0.6rem;font-weight:700;letter-spacing:1.2px;padding:2px 8px;border-radius:4px;background:#2d0a0a;color:#ef4444;border:1px solid #7f1d1d;animation:ltpulse 1.2s infinite;">LIVE</span>
        <span id="live-stop-badge" style="display:none;font-size:0.6rem;font-weight:700;letter-spacing:1.2px;padding:2px 8px;border-radius:4px;background:#1a1a2e;color:#3a5070;border:1px solid #252550;">IDLE</span>
      </div>
      <a href="/trade/status" style="font-size:0.72rem;color:#c84040;text-decoration:none;padding:5px 12px;border-radius:6px;border:1px solid #3a1010;background:#120608;white-space:nowrap;">Open Live →</a>
    </div>
    <div id="live-status-body" style="padding:14px 18px 16px;">
      <div style="color:#3a5070;font-size:0.75rem;">Loading…</div>
    </div>
  </div>

  </div><!-- end trade-row -->



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

async function pollDashboardStatus(){
  try {
    var pr = await fetch('/paperTrade/status/data',{cache:'no-store'});
    if(pr.ok){ var pd=await pr.json(); renderPaperStatus(pd); }
    else { renderPaperStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null,pnlSource:'—'}); }
  } catch(e){
    renderPaperStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,capital:null,totalPnl:null,pnlSource:'—'});
  }
  try {
    var lr = await fetch('/trade/status/data',{cache:'no-store'});
    if(lr.ok){ var ld=await lr.json(); renderLiveStatus(ld); }
    else { renderLiveStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,fyersOk:false,zerodhaOk:false,tickCount:0,candleCount:0}); }
  } catch(e){
    renderLiveStatus({running:false,sessionPnl:0,unrealisedPnl:null,tradeCount:0,wins:0,losses:0,fyersOk:false,zerodhaOk:false,tickCount:0,candleCount:0});
  }
}
pollDashboardStatus();

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
      el.innerHTML = d.cache.candles + ' candles<br><span style="color:#3a5070;">' + d.cache.from + ' → ' + d.cache.to + ' · ' + d.cache.sizeKB + ' KB</span>';
    } else {
      el.style.color = '#4a6080';
      el.textContent = 'No cache yet — will be built on first Paper/Live/Tracker start';
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
setInterval(pollDashboardStatus, 4000);
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
</script>
</div></div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send(`<pre style="color:red;padding:32px;font-family:monospace;">
Dashboard Error: ${err.message}

${err.stack}

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

process.on("unhandledRejection", (reason, promise) => {
  console.error("[UnhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[UncaughtException]", err.message, err.stack);
});

// ── EOD Token Auto-Clear Scheduler ──────────────────────────────────────────
// Clears BOTH Fyers and Zerodha tokens at 3:31 PM IST every day.
// This ensures:
//   (a) Tokens are wiped even if the app ran all day without a manual stop.
//   (b) Next morning on first startup, loadToken() sees no file → forces fresh login.
// Re-schedules itself for the same time the next day so it runs perpetually.

function scheduleEODTokenClear() {
  const now    = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const clearAt = new Date(now);
  clearAt.setHours(15, 31, 0, 0); // 3:31 PM IST

  let msUntil = clearAt - now;
  if (msUntil <= 0) msUntil += 24 * 60 * 60 * 1000; // if already past, schedule for tomorrow

  console.log(`🕒 EOD token clear scheduled in ${Math.round(msUntil / 60000)} min (at 3:31 PM IST)`);

  setTimeout(() => {
    console.log("🔴 [EOD] 3:31 PM IST — auto-clearing Fyers & Zerodha tokens...");
    clearFyersToken();
    zerodha.clearZerodhaToken();
    console.log("✅ [EOD] Both tokens cleared. Fresh login required tomorrow morning.");
    scheduleEODTokenClear(); // re-schedule for tomorrow's 3:31 PM
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
  console.error("\n❌  SSL certificates not found. Generate them on EC2:\n");
  console.error("    mkdir -p certs");
  console.error(`    openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem -out certs/cert.pem -days 3650 -nodes -subj "/CN=${EC2_IP}"\n`);
  process.exit(1);
}

https.createServer(sslOptions, app).listen(PORT, HOST, () => {
  console.log(`\n🚀 Trading App running at https://${EC2_IP}:${PORT} (AWS — HTTPS)`);
  console.log(`   Active Strategy  : ${ACTIVE}`);
  console.log(`   Instrument       : ${instrumentConfig.INSTRUMENT}`);
  console.log(`   Fyers Login      : ${process.env.ACCESS_TOKEN ? "✅ token set" : "❌ not logged in"}`);
  console.log(`   Zerodha Login    : ${zerodha.isAuthenticated() ? "✅ token set" : "❌ not logged in"}`);
  console.log(`   Live Trading     : ${process.env.LIVE_TRADE_ENABLED === "true" ? "✅ ENABLED" : "🔒 disabled"}`);
  console.log(`\n📖 Dashboard → https://${EC2_IP}:${PORT}`);
  console.log(`   📜 Live Logs  → https://${EC2_IP}:${PORT}/logs`);
  console.log(`   ⚠️  Browser warning expected (self-signed cert) — click Advanced → Proceed\n`);
});
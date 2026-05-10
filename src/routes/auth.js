/**
 * auth.js — Authentication routes for Fyers AND Zerodha
 * ─────────────────────────────────────────────────────────────────────────────
 * FYERS:
 *   GET /auth/login        → Redirect to Fyers OAuth
 *   GET /auth/callback     → Fyers callback (handles both auth_code & request_token)
 *   GET /auth/status       → Check Fyers auth status
 *
 * ZERODHA:
 *   GET /auth/zerodha/login    → Redirect to Zerodha Kite OAuth
 *   GET /auth/zerodha/callback → Zerodha callback
 *   GET /auth/zerodha/status   → Check Zerodha auth status
 *
 * COMBINED:
 *   GET /auth/status/all   → Both broker statuses in one call
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const { faviconLink } = require("../utils/sharedNav");
const fyers   = require("../config/fyers");
const zerodha = require("../services/zerodhaBroker");
const socketManager = require("../utils/socketManager");

// ─────────────────────────────────────────────────────────────────────────────
// FYERS AUTH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /auth/login
 *
 * Shows a landing page with two options instead of redirecting straight to
 * Fyers. The mobile redirect path is fragile — Fyers' OAuth URL deep-links
 * into the Fyers mobile app on Android/iOS, and the app sometimes consumes
 * the callback redirect so the bot never receives the auth_code. Giving the
 * user a "manual paste" option is the only universal fallback.
 *
 * For backwards compat (deep links, scripts, the old "Re-login" button), pass
 * ?direct=1 to skip the landing page and redirect straight to Fyers.
 */
router.get("/login", (req, res) => {
  const url = fyers.generateAuthCode();
  if (req.query.direct === "1") {
    console.log("🔐 [Fyers] Redirecting to login:", url);
    return res.redirect(url);
  }
  console.log("🔐 [Fyers] Login landing page shown.");
  res.send(buildLoginLandingPage(url));
});

/**
 * GET /auth/manual
 *
 * Manual paste fallback for mobile users where Fyers' OAuth redirect ends up
 * trapped in the Fyers app (or any other browser-context split where the
 * callback URL never reaches /auth/callback). The user logs in wherever they
 * can, captures the auth_code (or the full callback URL), and pastes it here.
 */
router.get("/manual", (req, res) => {
  const url = fyers.generateAuthCode();
  res.send(buildManualLoginPage(url, null));
});

/**
 * POST /auth/manual
 *
 * Body: { code: "<auth_code or full callback URL>" }
 * Accepts either the bare auth_code value or a pasted URL like
 * https://.../callback?auth_code=XYZ&state=... — we extract auth_code or
 * request_token from the query string in the URL case.
 */
router.post("/manual", async (req, res) => {
  const raw = String((req.body && req.body.code) || "").trim();
  if (!raw) {
    return res.status(400).send(buildManualLoginPage(fyers.generateAuthCode(), "Paste an auth code or callback URL first."));
  }

  let tokenValue = raw;
  // If the user pasted a full URL, pull auth_code (or request_token) out of it.
  // Some users paste only the value; others paste the whole redirected URL.
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      tokenValue = u.searchParams.get("auth_code")
                || u.searchParams.get("request_token")
                || "";
    } catch (_) {
      tokenValue = "";
    }
    if (!tokenValue) {
      return res.status(400).send(buildManualLoginPage(
        fyers.generateAuthCode(),
        "Couldn't find auth_code or request_token in that URL. Paste just the code value, or the full callback URL with ?auth_code=... in it.",
      ));
    }
  }

  try {
    const response = await fyers.generate_access_token({
      client_id:  process.env.APP_ID,
      secret_key: process.env.SECRET_KEY,
      auth_code:  tokenValue,
    });
    if (response.s === "ok") {
      fyers.setAccessToken(response.access_token);
      console.log("✅ [Fyers] Manual login successful. Token saved to disk.");
      return res.send(buildSuccessPage(
        "Fyers Login Successful ✅",
        "Token stored. You can close this page and start a session.",
      ));
    }
    console.error("❌ [Fyers] Manual token exchange failed:", response);
    return res.status(400).send(buildManualLoginPage(
      fyers.generateAuthCode(),
      `Fyers rejected the code: ${response.message || JSON.stringify(response)}. Try again with a fresh code.`,
    ));
  } catch (err) {
    console.error("❌ [Fyers] Manual auth error:", err);
    return res.status(500).send(buildManualLoginPage(
      fyers.generateAuthCode(),
      `Auth error: ${err.message}. Try again.`,
    ));
  }
});

/**
 * GET /auth/callback
 *
 * Fyers sends different param names depending on API version:
 *   Newer → ?request_token=xxx&action=login&type=login&status=success
 *   Older → ?auth_code=xxx&state=xxx
 *
 * We accept BOTH. The value is passed to generate_access_token() as auth_code
 * because that's what the fyers-api-v3 Node SDK expects internally.
 */
router.get("/callback", async (req, res) => {
  // Accept both param names
  const tokenValue = req.query.auth_code || req.query.request_token;
  const status     = req.query.status;

  console.log("🔁 [Fyers] Callback params:", req.query);

  if (status && status !== "success") {
    return res.status(400).send(buildErrorPage(
      "Fyers Login Failed",
      `Fyers returned status="${status}". Please try again.`
    ));
  }

  if (!tokenValue) {
    return res.status(400).send(buildErrorPage(
      "Fyers Login Failed",
      `No token in callback URL. Got: <code>${JSON.stringify(req.query)}</code>`
    ));
  }

  try {
    const response = await fyers.generate_access_token({
      client_id:  process.env.APP_ID,
      secret_key: process.env.SECRET_KEY,
      auth_code:  tokenValue,   // SDK always expects "auth_code" regardless of URL param name
    });

    if (response.s === "ok") {
      fyers.setAccessToken(response.access_token); // also saves to disk now
      console.log("✅ [Fyers] Login successful. Token saved to disk.");
      return res.send(buildSuccessPage(
        "Fyers Login Successful ✅",
        "Fyers access token stored and saved to disk — survives server restarts."
      ));
    } else {
      console.error("❌ [Fyers] Token generation failed:", response);
      return res.status(400).send(buildErrorPage("Fyers Login Failed", JSON.stringify(response)));
    }
  } catch (err) {
    console.error("❌ [Fyers] Auth error:", err);
    return res.status(500).send(buildErrorPage("Fyers Auth Error", err.message));
  }
});

router.get("/status", (req, res) => {
  const hasToken = !!process.env.ACCESS_TOKEN;
  res.json({
    broker:   "fyers",
    loggedIn: hasToken,
    message:  hasToken ? "Fyers access token is set." : "Not logged in. Visit /auth/login",
  });
});

// Socket health snapshot — polled every few seconds by the dashboard banner so
// users get an in-page red alert the moment the Fyers WebSocket auth dies (or
// the feed has been silent for >60s during market hours). Cheap, no auth needed.
router.get("/socket-health", (req, res) => {
  res.json(socketManager.getHealth());
});

// ─────────────────────────────────────────────────────────────────────────────
// ZERODHA AUTH
// ─────────────────────────────────────────────────────────────────────────────

router.get("/zerodha/login", (req, res) => {
  if (!process.env.ZERODHA_API_KEY) {
    return res.status(400).send(buildErrorPage(
      "Zerodha Not Configured",
      "ZERODHA_API_KEY missing in .env. Add it and restart."
    ));
  }
  try {
    const url = zerodha.getLoginUrl();
    console.log("🔐 [Zerodha] Redirecting to login:", url);
    res.redirect(url);
  } catch (err) {
    res.status(500).send(buildErrorPage(
      "Zerodha Error",
      err.message + "<br><br>Make sure kiteconnect is installed: <code>npm install kiteconnect</code>"
    ));
  }
});

router.get("/zerodha/callback", async (req, res) => {
  const { request_token, status } = req.query;
  console.log("🔁 [Zerodha] Callback params:", req.query);

  if (status !== "success" || !request_token) {
    return res.status(400).send(buildErrorPage(
      "Zerodha Login Failed",
      `Status="${status}" | request_token: ${request_token || "missing"}`
    ));
  }

  try {
    await zerodha.generateAccessToken(request_token); // also saves to disk now
    console.log("✅ [Zerodha] Login successful. Token saved to disk.");
    return res.send(buildSuccessPage(
      "Zerodha Login Successful ✅",
      "Zerodha access token stored and saved to disk — survives server restarts."
    ));
  } catch (err) {
    console.error("❌ [Zerodha] Token exchange failed:", err.message);
    return res.status(500).send(buildErrorPage("Zerodha Auth Error", err.message));
  }
});


router.get("/zerodha/logout", (req, res) => {
  zerodha.logout();
  console.log("🔴 [Zerodha] Token cleared via logout route.");
  return res.send(buildSuccessPage(
    "Zerodha Logged Out ✅",
    "Zerodha token has been cleared. You will need to login again before starting Live Trade."
  ));
});

router.get("/zerodha/status", (req, res) => {
  const hasToken = zerodha.isAuthenticated();
  res.json({
    broker:   "zerodha",
    loggedIn: hasToken,
    message:  hasToken ? "Zerodha token set." : "Not logged in. Visit /auth/zerodha/login",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COMBINED STATUS
// ─────────────────────────────────────────────────────────────────────────────

router.get("/status/all", (req, res) => {
  const fyersOk   = !!process.env.ACCESS_TOKEN;
  const zerodhaOk = zerodha.isAuthenticated();
  res.json({
    fyers:     { loggedIn: fyersOk,   message: fyersOk   ? "Logged in" : "Not logged in" },
    zerodha:   { loggedIn: zerodhaOk, configured: !!process.env.ZERODHA_API_KEY, message: zerodhaOk ? "Logged in" : "Not logged in" },
    liveReady: fyersOk && zerodhaOk && process.env.SWING_LIVE_ENABLED === "true",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildSuccessPage(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${title}</title>
  ${faviconLink()}
  <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:-apple-system,sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .card{background:#1a1f2e;border:1px solid #065f46;border-radius:16px;padding:40px 48px;text-align:center;max-width:480px;}
  .icon{font-size:3rem;margin-bottom:16px;}h1{font-size:1.3rem;font-weight:700;color:#10b981;margin-bottom:12px;}
  p{font-size:0.9rem;color:#a0aec0;line-height:1.6;margin-bottom:24px;}
  a{display:inline-block;background:#4299e1;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-weight:600;}</style></head>
  <body><div class="card"><div class="icon">✅</div><h1>${title}</h1><p>${message}</p><a href="/">← Back to Dashboard</a></div></body></html>`;
}

function buildLoginLandingPage(authUrl) {
  const safeUrl = String(authUrl).replace(/"/g, "&quot;");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Fyers Login</title>${faviconLink()}
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px;}
  .card{background:#1a1f2e;border:1px solid #1e3a5f;border-radius:16px;padding:32px;max-width:520px;width:100%;}
  .icon{font-size:2.4rem;text-align:center;margin-bottom:12px;}
  h1{font-size:1.2rem;font-weight:700;color:#60a5fa;margin-bottom:8px;text-align:center;}
  .sub{font-size:0.82rem;color:#a0aec0;line-height:1.55;text-align:center;margin-bottom:22px;}
  .btn{display:block;width:100%;background:#2563eb;color:#fff;text-decoration:none;text-align:center;padding:13px 20px;border-radius:10px;font-weight:600;font-size:0.95rem;border:none;cursor:pointer;}
  .btn:hover{background:#1d4ed8;}
  .alt{display:block;width:100%;background:transparent;color:#93c5fd;text-decoration:none;text-align:center;padding:12px;border:1px solid #1e3a5f;border-radius:10px;font-weight:500;font-size:0.85rem;margin-top:12px;}
  .alt:hover{border-color:#3b82f6;color:#bfdbfe;}
  .hint{margin-top:18px;padding:14px;background:#0a1429;border:1px solid #1e3a5f;border-radius:10px;font-size:0.78rem;color:#94a3b8;line-height:1.6;}
  .hint b{color:#fbbf24;}
  a.back{display:inline-block;margin-top:18px;color:#64748b;font-size:0.78rem;text-decoration:none;}
</style></head><body>
<div class="card">
  <div class="icon">🔐</div>
  <h1>Fyers Login</h1>
  <p class="sub">Authenticate with Fyers to enable trading and the live data feed.</p>
  <a href="${safeUrl}" class="btn">Continue to Fyers →</a>
  <a href="/auth/manual" class="alt">📋 Manual Login (paste code)</a>
  <div class="hint">
    <b>On mobile?</b> Fyers' login link often opens the Fyers app instead of staying in your browser, and the redirect back to this bot can fail silently. If "Continue to Fyers" doesn't bring you back logged in, use <b>Manual Login</b> — log in wherever, copy the auth code from the redirect URL, and paste it here.
  </div>
  <div style="text-align:center;"><a href="/" class="back">← Back to Dashboard</a></div>
</div>
</body></html>`;
}

function buildManualLoginPage(authUrl, errorMsg) {
  const safeUrl = String(authUrl).replace(/"/g, "&quot;");
  const escapedUrl = String(authUrl)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const errBlock = errorMsg
    ? `<div style="background:#3b0a0a;border:1px solid #9b2c2c;border-radius:10px;padding:12px 14px;margin-bottom:18px;font-size:0.82rem;color:#fca5a5;line-height:1.5;">⚠️ ${String(errorMsg).replace(/</g, "&lt;")}</div>`
    : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Fyers — Manual Login</title>${faviconLink()}
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:flex-start;justify-content:center;min-height:100vh;padding:24px 16px;}
  .card{background:#1a1f2e;border:1px solid #1e3a5f;border-radius:16px;padding:28px;max-width:600px;width:100%;}
  h1{font-size:1.15rem;font-weight:700;color:#60a5fa;margin-bottom:6px;}
  .sub{font-size:0.8rem;color:#a0aec0;line-height:1.55;margin-bottom:20px;}
  .step{margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid #243044;}
  .step:last-of-type{border-bottom:none;}
  .step-label{font-size:0.72rem;font-weight:700;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;}
  .url-box{background:#0a1429;border:1px solid #1e3a5f;border-radius:8px;padding:10px 12px;font-family:monospace;font-size:0.74rem;color:#93c5fd;word-break:break-all;line-height:1.5;margin-bottom:8px;}
  .row{display:flex;gap:8px;flex-wrap:wrap;}
  .btn{flex:1;min-width:140px;background:#2563eb;color:#fff;text-decoration:none;text-align:center;padding:10px 14px;border-radius:8px;font-weight:600;font-size:0.82rem;border:none;cursor:pointer;}
  .btn.secondary{background:#1e3a5f;}
  .btn:hover{filter:brightness(1.15);}
  textarea{width:100%;min-height:90px;background:#0a1429;border:1px solid #1e3a5f;border-radius:8px;padding:10px 12px;color:#e2e8f0;font-family:monospace;font-size:0.78rem;resize:vertical;line-height:1.5;}
  textarea:focus{outline:none;border-color:#3b82f6;}
  .submit{display:block;width:100%;background:#10b981;color:#fff;border:none;padding:13px;border-radius:10px;font-weight:700;font-size:0.92rem;cursor:pointer;margin-top:12px;}
  .submit:hover{background:#059669;}
  .hint{font-size:0.74rem;color:#64748b;line-height:1.6;margin-top:8px;}
  a.back{display:inline-block;margin-top:18px;color:#64748b;font-size:0.78rem;text-decoration:none;}
</style></head><body>
<div class="card">
  <h1>📋 Manual Fyers Login</h1>
  <p class="sub">Use this when the normal redirect doesn't work — typically on mobile, where Fyers opens its app instead of returning to the bot.</p>

  ${errBlock}

  <div class="step">
    <div class="step-label">Step 1 — Open the Fyers login URL</div>
    <div class="url-box" id="auth-url">${escapedUrl}</div>
    <div class="row">
      <a href="${safeUrl}" target="_blank" rel="noopener" class="btn">Open in new tab</a>
      <button type="button" class="btn secondary" onclick="copyUrl()">Copy URL</button>
    </div>
    <div class="hint">Tip: on mobile, long-press the URL above and choose "Open in Chrome" / "Open in browser" to avoid the Fyers app deep-link.</div>
  </div>

  <div class="step">
    <div class="step-label">Step 2 — Log in on Fyers</div>
    <div class="hint">Complete the Fyers login flow. After it succeeds, Fyers redirects to a URL like<br>
      <code style="color:#93c5fd;">https://&lt;your-bot&gt;/auth/callback?auth_code=XYZ123&amp;state=...</code><br>
      If that page never opens but you can see the URL in the address bar (or in the Fyers app), you can still grab the <code style="color:#fbbf24;">auth_code</code> value from it.
    </div>
  </div>

  <form method="POST" action="/auth/manual">
    <div class="step-label">Step 3 — Paste the code or full URL</div>
    <textarea name="code" placeholder="Paste auth_code or full callback URL here..." required></textarea>
    <button type="submit" class="submit">Submit Auth Code →</button>
    <div class="hint">You can paste either just the <code>auth_code</code> value, or the entire callback URL — we'll extract it.</div>
  </form>

  <a href="/" class="back">← Back to Dashboard</a>
</div>
<script>
function copyUrl(){
  var url = document.getElementById('auth-url').textContent;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(function(){ flash('Copied!'); }).catch(fallback);
  } else { fallback(); }
  function fallback(){
    var ta = document.createElement('textarea');
    ta.value = url; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); flash('Copied!'); }catch(e){ flash('Copy failed — select manually'); }
    document.body.removeChild(ta);
  }
  function flash(msg){
    var btn = document.querySelector('.btn.secondary');
    if(!btn) return;
    var orig = btn.textContent; btn.textContent = msg;
    setTimeout(function(){ btn.textContent = orig; }, 1400);
  }
}
</script>
</body></html>`;
}

function buildErrorPage(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${title}</title>
  ${faviconLink()}
  <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:-apple-system,sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .card{background:#1a1f2e;border:1px solid #9b2c2c;border-radius:16px;padding:40px 48px;text-align:center;max-width:520px;}
  .icon{font-size:3rem;margin-bottom:16px;}h1{font-size:1.3rem;font-weight:700;color:#fc8181;margin-bottom:12px;}
  p{font-size:0.82rem;color:#a0aec0;line-height:1.6;background:#0a0a0a;padding:12px 16px;border-radius:8px;text-align:left;margin-bottom:24px;font-family:monospace;word-break:break-all;}
  a{display:inline-block;background:#4299e1;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-weight:600;}</style></head>
  <body><div class="card"><div class="icon">❌</div><h1>${title}</h1><p>${message}</p><a href="/">← Back to Dashboard</a></div></body></html>`;
}

module.exports = router;

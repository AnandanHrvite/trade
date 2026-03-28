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

// ─────────────────────────────────────────────────────────────────────────────
// FYERS AUTH
// ─────────────────────────────────────────────────────────────────────────────

router.get("/login", (req, res) => {
  const url = fyers.generateAuthCode();
  console.log("🔐 [Fyers] Redirecting to login:", url);
  res.redirect(url);
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
    liveReady: fyersOk && zerodhaOk && process.env.LIVE_TRADE_ENABLED === "true",
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

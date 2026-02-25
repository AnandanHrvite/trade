const express = require("express");
const router = express.Router();
const fyers = require("../config/fyers");

/**
 * GET /auth/login
 * Redirects user to Fyers OAuth login page
 */
router.get("/login", (req, res) => {
  const url = fyers.generateAuthCode();
  console.log("🔐 Redirecting to Fyers login:", url);
  res.redirect(url);
});

/**
 * GET /auth/callback?auth_code=xxx&state=xxx
 * Fyers redirects here after user logs in.
 * Exchanges auth_code for access_token and stores it.
 */
router.get("/callback", async (req, res) => {
  const { auth_code, state } = req.query;

  if (!auth_code) {
    return res.status(400).json({ success: false, error: "auth_code missing in callback" });
  }

  try {
    const response = await fyers.generate_access_token({
      client_id: process.env.APP_ID,
      secret_key: process.env.SECRET_KEY,
      auth_code: auth_code,
    });

    if (response.s === "ok") {
      // Store access token on fyers instance for all subsequent API calls
      fyers.setAccessToken(response.access_token);

      // Also save to process.env for socket services to use
      process.env.ACCESS_TOKEN = response.access_token;

      console.log("✅ Login successful. Access token set.");

      return res.json({
        success: true,
        message: "Login successful! You can now use /backtest, /result, and /trade",
        access_token: response.access_token, // store this client-side if needed
      });
    } else {
      console.error("❌ Token generation failed:", response);
      return res.status(400).json({ success: false, error: response });
    }
  } catch (err) {
    console.error("❌ Auth callback error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /auth/status
 * Check if user is logged in
 */
router.get("/status", (req, res) => {
  const hasToken = !!process.env.ACCESS_TOKEN;
  res.json({
    loggedIn: hasToken,
    message: hasToken ? "Access token is set" : "Not logged in. Visit /auth/login",
  });
});

module.exports = router;

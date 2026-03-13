require("dotenv").config();
const fs  = require("fs");
const path = require("path");
const { fyersModel } = require("fyers-api-v3");

// Fyers SDK writes its own debug logs to ./logs/ — auto-create the directory
// so the SDK never throws "Failed to write to log file: ENOENT" on every tick.
const FYERS_LOG_DIR = path.resolve("./logs");
if (!fs.existsSync(FYERS_LOG_DIR)) {
  try { fs.mkdirSync(FYERS_LOG_DIR, { recursive: true }); } catch (_) {}
}

const fyers = new fyersModel({
  path: "./logs",
  enableLogging: false,   // Fyers SDK file-logging disabled — we have our own logging
});

fyers.setAppId(process.env.APP_ID);
fyers.setRedirectUrl(process.env.REDIRECT_URL);

// ── Token persistence ─────────────────────────────────────────────────────────
const TOKEN_FILE = path.join(__dirname, "../../data/.fyers_token");

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function saveToken(token) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, savedAt: Date.now(), savedDate: todayIST() }), "utf-8");
  } catch (err) {
    console.warn("⚠️  Could not save Fyers token to disk:", err.message);
  }
}

function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const { token, savedAt, savedDate } = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));

    // ── Guard 1: date-based check (primary) ──────────────────────────────────
    // Fyers tokens are issued per-day. If the saved date is not today (IST), the
    // token is stale regardless of its age in hours — delete and force fresh login.
    const today = todayIST();
    if (savedDate && savedDate !== today) {
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
      console.log("🕐 Fyers token from previous day — please login again.");
      return null;
    }

    // ── Guard 2: age fallback (secondary) — catches tokens saved before savedDate field ─
    const ageHours = (Date.now() - (savedAt || 0)) / (1000 * 60 * 60);
    if (ageHours > 20) {
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
      console.log("🕐 Fyers token expired (>20h old) — please login again.");
      return null;
    }

    return token;
  } catch (err) {
    return null;
  }
}

/** Clear Fyers token from disk and env — called by EOD scheduler & logout */
function clearFyersToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (_) {}
  delete process.env.ACCESS_TOKEN;
  console.log("🔴 [Fyers] Token cleared.");
}

const savedToken = loadToken();
if (savedToken) {
  fyers.setAccessToken(savedToken);
  process.env.ACCESS_TOKEN = savedToken;
  console.log("✅ [Fyers] Token restored from disk — no need to login again.");
}

const _originalSetToken = fyers.setAccessToken.bind(fyers);
fyers.setAccessToken = function(token) {
  _originalSetToken(token);
  process.env.ACCESS_TOKEN = token;
  saveToken(token);
};

fyers.clearToken = clearFyersToken; // expose on instance for convenience

module.exports = fyers;
module.exports.clearFyersToken = clearFyersToken;

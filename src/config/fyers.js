require("dotenv").config();
const fs  = require("fs");
const path = require("path");

// ── HTTP deadline for every Fyers REST call ─────────────────────────────────
// The Fyers SDK builds its axios instance as axios.create({ httpsAgent }) with
// no `timeout`, and axios defaults to 0 = wait forever. A hung socket therefore
// wedges getQuotes / place_order indefinitely — which stalls the pre-entry
// spread guard (holding _entryPending, blocking ALL further entries) and the
// exit path's premium fetch. Setting the global default BEFORE the SDK is
// required makes its instance inherit the deadline; instances copy defaults at
// create() time, so this require order matters.
const FYERS_HTTP_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.FYERS_HTTP_TIMEOUT_MS || "6000", 10) || 6000
);
try {
  require("axios").defaults.timeout = FYERS_HTTP_TIMEOUT_MS;
} catch (_) { /* axios always ships with the SDK; never block startup on this */ }

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
// Stored at ~/trading-data/ — outside project dir, survives git pull / redeploys.
const _HOME_FY = require("os").homedir();
const TOKEN_FILE = path.join(_HOME_FY, "trading-data", ".fyers_token");

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function saveToken(token) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 0600: this token places live orders. Default perms leave it readable by
    // every account on the box — same treatment as the Drive credential store.
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, savedAt: Date.now(), savedDate: todayIST() }), { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}   // tighten a pre-existing file
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
    console.warn(`⚠️ [Fyers] Token load failed: ${err.message}`);
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

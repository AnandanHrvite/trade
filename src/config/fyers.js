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

// ── Request pacing (Fyers Standard plan: 5/sec, 50/min, 5,000/day) ─────────
// Going over the limit gets the whole app blocked by Fyers' Cloudflare (Error
// 1015) — REST and the websocket reconnect alike, which is how the 2026-10-16
// feed went silent for 2 minutes. Every data read waits its turn here so the
// bot never crosses the line. Orders are not delayed.
function _paceInt(key, dflt, min, max) {
  const v = parseInt(process.env[key] || "", 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}
const _pace = { stamps: [], chain: Promise.resolve(), day: null, count: 0, warned: 0 };
function _paceSlot(name) {
  const queuedAt = Date.now();
  const turn = _pace.chain.then(async () => {
    for (;;) {
      const now = Date.now();
      const deadline = queuedAt + _paceInt("FYERS_QUEUE_MAX_WAIT_MS", 15000, 1000, 120000);
      while (_pace.stamps.length && now - _pace.stamps[0] >= 60000) _pace.stamps.shift();
      const perSec = _paceInt("FYERS_MAX_REQ_PER_SEC", 4, 1, 50);
      const perMin = _paceInt("FYERS_MAX_REQ_PER_MIN", 45, 1, 1000);
      const n = _pace.stamps.length;
      let waitMs = 0;
      if (n >= perMin) waitMs = 60000 - (now - _pace.stamps[n - perMin]);
      else if (n >= perSec && now - _pace.stamps[n - perSec] < 1000) waitMs = 1000 - (now - _pace.stamps[n - perSec]);
      if (waitMs <= 0) {
        _pace.stamps.push(now);
        const day = todayIST();
        if (_pace.day !== day) { _pace.day = day; _pace.count = 0; _pace.warned = 0; }
        _pace.count++;
        if ((_pace.count === 4000 || _pace.count === 4800) && _pace.warned < _pace.count) {
          _pace.warned = _pace.count;
          console.warn(`⚠️ [Fyers] ${_pace.count} data requests used today — the Standard plan stops at 5,000`);
        }
        return;
      }
      // A request that would wait this long would answer with an old price —
      // fail it now so the caller retries on its own next cycle.
      if (now + waitMs > deadline) {
        throw new Error(`${name} skipped — Fyers request limit reached, no free slot within ${Math.round((deadline - queuedAt) / 1000)}s`);
      }
      await new Promise((r) => setTimeout(r, waitMs + 5));
    }
  });
  _pace.chain = turn.catch(() => {});
  return turn;
}
for (const name of ["getQuotes", "getHistory", "getMarketDepth", "getOptionChain"]) {
  const orig = fyers[name] && fyers[name].bind(fyers);
  if (!orig) continue;
  fyers[name] = async (...args) => { await _paceSlot(name); return orig(...args); };
}
fyers.getRequestStats = () => ({ day: _pace.day, today: _pace.count, lastMinute: _pace.stamps.filter((t) => Date.now() - t < 60000).length });

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

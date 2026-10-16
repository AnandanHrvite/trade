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
// bot never crosses the line. Orders are not delayed (or counted).
function _paceInt(raw, dflt, min, max) {
  const v = parseInt(raw || "", 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}
const _pace = { stamps: [], chain: Promise.resolve(), day: null, count: 0, heldLogAt: 0 };

// The day's count survives a restart (deploys land mid-session), so the daily
// pace below is measured against what Fyers has really seen today.
const _PACE_FILE = path.join(require("os").homedir(), "trading-data", ".fyers_req_count.json");
try {
  const saved = JSON.parse(fs.readFileSync(_PACE_FILE, "utf-8"));
  if (saved && saved.day === todayIST()) { _pace.day = saved.day; _pace.count = saved.count || 0; }
} catch (_) { /* no file yet */ }
function _paceSave() {
  fs.writeFile(_PACE_FILE, JSON.stringify({ day: _pace.day, count: _pace.count }), () => {});
}

// Daily pace: requests are spread across 09:00–23:30 IST (NSE + MCX) so a
// busy afternoon cannot spend the evening's share. By any moment the day may
// have used a tenth of the budget up front plus its share of the time elapsed.
const _DAY_OPEN_MIN = 540, _DAY_CLOSE_MIN = 1410;
function _istMinNow() { return Math.floor((Date.now() / 1000 + 19800) / 60) % 1440; }
function _dailyWaitMs(perDay) {
  if (_pace.count >= perDay) return Infinity;
  const burst = Math.floor(perDay / 10);
  const span = _DAY_CLOSE_MIN - _DAY_OPEN_MIN;
  const elapsed = Math.min(Math.max(_istMinNow() - _DAY_OPEN_MIN, 0), span);
  if (_pace.count < burst + ((perDay - burst) * elapsed) / span) return 0;
  const needMin = _DAY_OPEN_MIN + ((_pace.count + 1 - burst) / (perDay - burst)) * span;
  return Math.max(1000, (needMin - _istMinNow()) * 60000);
}
function _paceSlot(name) {
  const queuedAt = Date.now();
  const turn = _pace.chain.then(async () => {
    for (;;) {
      const now = Date.now();
      const deadline = queuedAt + _paceInt(process.env.FYERS_QUEUE_MAX_WAIT_MS, 15000, 1000, 120000);
      while (_pace.stamps.length && now - _pace.stamps[0] >= 60000) _pace.stamps.shift();
      const perSec = _paceInt(process.env.FYERS_MAX_REQ_PER_SEC, 4, 1, 50);
      const perMin = _paceInt(process.env.FYERS_MAX_REQ_PER_MIN, 45, 1, 1000);
      const perDay = _paceInt(process.env.FYERS_MAX_REQ_PER_DAY, 4800, 100, 1000000);
      const day = todayIST();
      if (_pace.day !== day) { _pace.day = day; _pace.count = 0; }
      const n = _pace.stamps.length;
      let waitMs = _dailyWaitMs(perDay);
      if (n >= perMin) waitMs = Math.max(waitMs, 60000 - (now - _pace.stamps[n - perMin]));
      else if (n >= perSec && now - _pace.stamps[n - perSec] < 1000) waitMs = Math.max(waitMs, 1000 - (now - _pace.stamps[n - perSec]));
      if (waitMs <= 0) {
        _pace.stamps.push(now);
        _pace.count++;
        if (_pace.count % 25 === 0) _paceSave();
        if (_pace.count === 4000) {
          console.warn(`⚠️ [Fyers] ${_pace.count} data requests used today — the Standard plan stops at 5,000`);
        }
        return;
      }
      if (waitMs >= 60000 && now - _pace.heldLogAt > 600000) {
        _pace.heldLogAt = now;
        console.warn(`⚠️ [Fyers] ${_pace.count}/${perDay} data requests used today — slowing requests down to keep some for the rest of the day`);
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

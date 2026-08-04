/**
 * googleDrive.js — optional off-site push of the daily backup snapshot
 * ─────────────────────────────────────────────────────────────────────────────
 * The daily .tar.gz that backupManager cuts only helps if it survives the box it
 * was cut on. This uploads it to the user's own Google Drive right after the
 * snapshot is built. Entirely opt-in: nothing happens until the user connects an
 * account from Settings → Backup & Restore, and disconnecting stops it again.
 *
 * Why the DEVICE flow (and not the usual redirect flow):
 *   The app is served from https://<ec2-ip>:3000 with a self-signed cert. Google
 *   refuses OAuth redirect URIs that are raw IPs or untrusted certs, so there is
 *   no redirect_uri we could register. The device flow needs none — we show a
 *   short code, the user approves it on google.com/device from any browser, and
 *   we poll for the refresh token. Same flow smart TVs use.
 *
 * Scope: drive.file ONLY — per-file access to files this app created. We can
 * never read or delete anything else in the user's Drive, and it is a
 * non-sensitive scope so the OAuth client needs no Google verification review.
 *
 * Credentials + tokens live in ~/trading-data/.google_drive.json (mode 0600),
 * outside the repo — same convention as .fyers_token / .zerodha_token, so a
 * git pull or redeploy never wipes the connection. They are deliberately NOT in
 * .env: the file is excluded from the backup archive, so a snapshot can never
 * carry the user's Drive refresh token off the box.
 *
 * Env (all optional):
 *   GDRIVE_FOLDER_NAME   (default "Trading Bot Backups")  Drive folder to create
 *   GDRIVE_RETAIN        (default 30)  keep the N newest uploads, delete older
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs    = require("fs");
const path  = require("path");
const os    = require("os");
const https = require("https");

const STORE_FILE = path.join(os.homedir(), "trading-data", ".google_drive.json");

const SCOPE           = "https://www.googleapis.com/auth/drive.file email";
const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL       = "https://oauth2.googleapis.com/token";
const REVOKE_URL      = "https://oauth2.googleapis.com/revoke";
const FILES_URL       = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL      = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME     = "application/vnd.google-apps.folder";

const API_TIMEOUT_MS    = 30_000;
const UPLOAD_TIMEOUT_MS = 15 * 60_000;   // a month of ticks can be a few hundred MB
const TOKEN_SKEW_MS     = 120_000;       // refresh this long before actual expiry

function folderName() {
  return (process.env.GDRIVE_FOLDER_NAME || "Trading Bot Backups").trim() || "Trading Bot Backups";
}
function retainCount() {
  const n = parseInt(process.env.GDRIVE_RETAIN || "30", 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

// ── Store ────────────────────────────────────────────────────────────────────
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) || {}; }
  catch (_) { return {}; }
}

/** Merge-write. Written 0600 — it holds the client secret + refresh token. */
function writeStore(patch) {
  const next = { ...readStore(), ...patch };
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    try { fs.chmodSync(STORE_FILE, 0o600); } catch (_) {}   // pre-existing file
  } catch (err) {
    console.warn(`[gdrive] could not persist ${STORE_FILE}: ${err.message}`);
  }
  return next;
}

function isConfigured() {
  const s = readStore();
  return !!(s.clientId && s.clientSecret);
}
function isConnected() {
  const s = readStore();
  return !!(s.clientId && s.clientSecret && s.refreshToken);
}

function recordError(message) {
  writeStore({ lastError: { at: new Date().toISOString(), message: String(message).slice(0, 400) } });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
/** Small JSON/form request. Resolves { status, headers, text, json } — never rejects on HTTP status. */
function httpRequest(url, { method = "GET", headers = {}, body = null, timeoutMs = API_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function form(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function postForm(url, fields, timeoutMs) {
  const body = form(fields);
  return httpRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    body,
    timeoutMs,
  });
}

/** Best-effort Google error text — their payloads nest it two different ways. */
function googleError(res, fallback) {
  const j = res && res.json;
  if (j) {
    if (j.error && typeof j.error === "object" && j.error.message) return j.error.message;
    if (typeof j.error === "string") return j.error_description ? `${j.error}: ${j.error_description}` : j.error;
  }
  if (res && res.text) return String(res.text).slice(0, 200);
  return fallback || "unknown error";
}

/** Read the email out of an id_token without verifying — it came from Google over TLS. */
function emailFromIdToken(idToken) {
  try {
    const payload = String(idToken).split(".")[1];
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return json.email || null;
  } catch (_) { return null; }
}

// ── Credentials ──────────────────────────────────────────────────────────────
/** In-flight device authorisation, if any: { deviceCode, intervalMs, expiresAt, nextPollAt } */
let _pending = null;

/**
 * Save the OAuth client the user created in Google Cloud Console. Changing
 * either half invalidates any existing connection (the refresh token belongs to
 * the old client), so we drop it rather than leave a token that will 401 later.
 */
function saveCredentials(clientId, clientSecret) {
  const id     = String(clientId || "").trim();
  const secret = String(clientSecret || "").trim();
  if (!id || !secret) return { ok: false, error: "Client ID and Client Secret are both required" };
  if (!/\.apps\.googleusercontent\.com$/.test(id)) {
    return { ok: false, error: "That doesn't look like a Google Client ID (must end in .apps.googleusercontent.com)" };
  }
  const prev = readStore();
  const changed = prev.clientId !== id || prev.clientSecret !== secret;
  writeStore({
    clientId: id,
    clientSecret: secret,
    ...(changed ? { refreshToken: null, accessToken: null, accessExpiresAt: 0, account: null, folderId: null, lastError: null } : {}),
  });
  _pending = null;
  return { ok: true, reconnectNeeded: changed };
}

// ── Device flow ──────────────────────────────────────────────────────────────
/** Step 1 — ask Google for a user code. Resolves { ok, userCode, verificationUrl, expiresIn }. */
async function startDeviceAuth() {
  const s = readStore();
  if (!s.clientId || !s.clientSecret) return { ok: false, error: "Add your Google Client ID and Secret first" };

  let res;
  try {
    res = await postForm(DEVICE_CODE_URL, { client_id: s.clientId, scope: SCOPE });
  } catch (err) {
    return { ok: false, error: `Could not reach Google: ${err.message}` };
  }
  if (res.status !== 200 || !res.json || !res.json.device_code) {
    const msg = googleError(res, `HTTP ${res.status}`);
    // The most common setup mistake, worth naming outright.
    const hint = /invalid_client|unauthorized/i.test(msg)
      ? " — check the Client ID/Secret, and that the OAuth client type is \"TVs and Limited Input devices\""
      : "";
    return { ok: false, error: `Google rejected the request: ${msg}${hint}` };
  }

  const d = res.json;
  const intervalMs = Math.max(5, parseInt(d.interval, 10) || 5) * 1000;
  _pending = {
    deviceCode: d.device_code,
    intervalMs,
    expiresAt: Date.now() + (parseInt(d.expires_in, 10) || 900) * 1000,
    nextPollAt: Date.now() + intervalMs,
  };
  return {
    ok: true,
    userCode: d.user_code,
    verificationUrl: d.verification_url || d.verification_uri || "https://www.google.com/device",
    expiresIn: parseInt(d.expires_in, 10) || 900,
    intervalSec: Math.round(intervalMs / 1000),
  };
}

/**
 * Step 2 — poll until the user approves. Resolves
 * { state: "pending" | "connected" | "expired" | "denied" | "error" }.
 */
async function pollDeviceAuth() {
  if (!_pending) return { state: "error", error: "No connection in progress — click Connect again" };
  if (Date.now() > _pending.expiresAt) { _pending = null; return { state: "expired" }; }
  if (Date.now() < _pending.nextPollAt) return { state: "pending" };

  const s = readStore();
  _pending.nextPollAt = Date.now() + _pending.intervalMs;

  let res;
  try {
    res = await postForm(TOKEN_URL, {
      client_id: s.clientId,
      client_secret: s.clientSecret,
      device_code: _pending.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  } catch (err) {
    return { state: "pending", note: err.message };   // transient network blip — keep polling
  }

  const err = res.json && (typeof res.json.error === "string" ? res.json.error : null);
  if (err === "authorization_pending") return { state: "pending" };
  if (err === "slow_down") {
    _pending.intervalMs += 5000;
    _pending.nextPollAt = Date.now() + _pending.intervalMs;
    return { state: "pending" };
  }
  if (err === "access_denied")  { _pending = null; return { state: "denied" }; }
  if (err === "expired_token")  { _pending = null; return { state: "expired" }; }

  if (res.status !== 200 || !res.json || !res.json.refresh_token) {
    _pending = null;
    // No refresh_token on an otherwise-OK response means the account already
    // granted this client and Google withheld it — a re-consent is required.
    const msg = res.json && res.json.access_token
      ? "Google returned no refresh token. Remove this app at myaccount.google.com/permissions, then connect again."
      : googleError(res, `HTTP ${res.status}`);
    return { state: "error", error: msg };
  }

  const t = res.json;
  writeStore({
    refreshToken: t.refresh_token,
    accessToken: t.access_token || null,
    accessExpiresAt: Date.now() + (parseInt(t.expires_in, 10) || 3600) * 1000,
    account: emailFromIdToken(t.id_token) || null,
    connectedAt: new Date().toISOString(),
    lastError: null,
  });
  _pending = null;
  const acct = readStore().account;
  console.log(`[gdrive] connected${acct ? ` as ${acct}` : ""} — daily backups will be pushed to Drive`);
  return { state: "connected", account: acct };
}

function cancelDeviceAuth() { _pending = null; }

/** Drop the connection. Revoking at Google is best-effort — local state is cleared either way. */
async function disconnect() {
  const s = readStore();
  if (s.refreshToken) {
    try { await postForm(REVOKE_URL, { token: s.refreshToken }, 10_000); } catch (_) {}
  }
  _pending = null;
  writeStore({ refreshToken: null, accessToken: null, accessExpiresAt: 0, account: null, folderId: null, lastError: null, lastUpload: null });
  console.log("[gdrive] disconnected");
  return { ok: true };
}

// ── Access token ─────────────────────────────────────────────────────────────
let _refreshing = null;   // collapse concurrent refreshes into one request

async function getAccessToken(force = false) {
  const s = readStore();
  if (!s.refreshToken) throw new Error("Google Drive is not connected");
  if (!force && s.accessToken && s.accessExpiresAt > Date.now() + TOKEN_SKEW_MS) return s.accessToken;

  if (!_refreshing) {
    _refreshing = (async () => {
      const res = await postForm(TOKEN_URL, {
        client_id: s.clientId,
        client_secret: s.clientSecret,
        refresh_token: s.refreshToken,
        grant_type: "refresh_token",
      });
      if (res.status !== 200 || !res.json || !res.json.access_token) {
        const msg = googleError(res, `HTTP ${res.status}`);
        // invalid_grant = refresh token dead (revoked, or the OAuth consent
        // screen is still in "Testing", where tokens expire after 7 days).
        if (/invalid_grant/i.test(msg)) {
          writeStore({ refreshToken: null, accessToken: null, accessExpiresAt: 0 });
          throw new Error("Google revoked the connection — reconnect Drive. (If the OAuth consent screen is in Testing mode, publish it to Production so tokens stop expiring after 7 days.)");
        }
        throw new Error(`Token refresh failed: ${msg}`);
      }
      writeStore({
        accessToken: res.json.access_token,
        accessExpiresAt: Date.now() + (parseInt(res.json.expires_in, 10) || 3600) * 1000,
      });
      return res.json.access_token;
    })().finally(() => { _refreshing = null; });
  }
  return _refreshing;
}

// ── Drive helpers ────────────────────────────────────────────────────────────
async function driveJson(url, { method = "GET", token, body = null, headers = {} } = {}) {
  const h = { Authorization: `Bearer ${token}`, ...headers };
  let payload = null;
  if (body) {
    payload = JSON.stringify(body);
    h["Content-Type"] = "application/json; charset=UTF-8";
    h["Content-Length"] = Buffer.byteLength(payload);
  }
  return httpRequest(url, { method, headers: h, body: payload });
}

/**
 * Resolve the destination folder, creating it if needed. Under drive.file we can
 * only see folders this app created, so a remembered id that has been trashed or
 * deleted by hand is simply recreated.
 */
async function ensureFolder(token) {
  const s = readStore();
  if (s.folderId) {
    const res = await driveJson(`${FILES_URL}/${encodeURIComponent(s.folderId)}?fields=id,trashed`, { token });
    if (res.status === 200 && res.json && !res.json.trashed) return s.folderId;
  }
  const res = await driveJson(`${FILES_URL}?fields=id`, {
    method: "POST", token,
    body: { name: folderName(), mimeType: FOLDER_MIME },
  });
  if (res.status !== 200 || !res.json || !res.json.id) {
    throw new Error(`Could not create the Drive folder: ${googleError(res, `HTTP ${res.status}`)}`);
  }
  writeStore({ folderId: res.json.id });
  return res.json.id;
}

/** PUT the file body into an open resumable session. Resolves the Drive file JSON. */
function putStream(sessionUrl, filePath, size) {
  return new Promise((resolve, reject) => {
    const req = https.request(sessionUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/gzip", "Content-Length": size },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) {}
        if (res.statusCode === 200 || res.statusCode === 201) return resolve(json || {});
        reject(new Error(googleError({ status: res.statusCode, json, text }, `upload HTTP ${res.statusCode}`)));
      });
    });
    const rs = fs.createReadStream(filePath);
    req.setTimeout(UPLOAD_TIMEOUT_MS, () => req.destroy(new Error("upload timed out")));
    // pipe() does not tear the source down when the destination dies, so close
    // the file handle explicitly on any request failure.
    req.on("error", (err) => { rs.destroy(); reject(err); });
    rs.on("error", (err) => { req.destroy(err); reject(err); });
    rs.pipe(req);
  });
}

/**
 * Delete every OTHER file in the folder sharing this name (previous same-day
 * pushes). keepId is mandatory: without it every match looks deletable and we'd
 * delete the upload we just made, so the caller skips this entirely if Drive
 * didn't hand back an id.
 */
async function deleteSameName(token, folderId, name, keepId) {
  if (!keepId) return 0;
  const q = `'${folderId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  const res = await driveJson(`${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=100`, { token });
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.files)) return 0;
  let n = 0;
  for (const f of res.json.files) {
    if (f.id === keepId) continue;
    const d = await driveJson(`${FILES_URL}/${encodeURIComponent(f.id)}`, { method: "DELETE", token });
    if (d.status === 204 || d.status === 200) n++;
  }
  return n;
}

/** Keep the N newest uploads in the folder, delete the rest. */
async function pruneRemote(token, folderId, keep) {
  const q = `'${folderId}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`;
  const res = await driveJson(
    `${FILES_URL}?q=${encodeURIComponent(q)}&orderBy=${encodeURIComponent("createdTime desc")}&fields=files(id,name)&pageSize=200`,
    { token }
  );
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.files)) return 0;
  let n = 0;
  for (const f of res.json.files.slice(keep)) {
    const d = await driveJson(`${FILES_URL}/${encodeURIComponent(f.id)}`, { method: "DELETE", token });
    if (d.status === 204 || d.status === 200) n++;
  }
  return n;
}

// ── Upload ───────────────────────────────────────────────────────────────────
let _uploading = false;

/**
 * Push one local archive to Drive. Resolves { ok, id, name, sizeBytes, error }.
 * Never throws — the caller is either the scheduler (must not crash) or a route.
 * Any failure is also persisted as lastError so the Settings page can show it.
 */
async function uploadFile(filePath, opts = {}) {
  if (!isConnected()) return { ok: false, error: "Google Drive is not connected" };
  if (_uploading)     return { ok: false, error: "An upload is already running" };
  if (!fs.existsSync(filePath)) return { ok: false, error: `File not found: ${path.basename(filePath)}` };

  _uploading = true;
  const name = path.basename(filePath);
  const started = Date.now();
  try {
    const size = fs.statSync(filePath).size;
    let token  = await getAccessToken();
    let folderId = await ensureFolder(token);

    // Open a resumable session. A 401 here means the access token died between
    // the refresh and the call — force a new one and try the session once more.
    const openSession = async () => driveJson(`${UPLOAD_URL}?uploadType=resumable&fields=id,name,size`, {
      method: "POST", token,
      body: { name, parents: [folderId] },
      headers: { "X-Upload-Content-Type": "application/gzip", "X-Upload-Content-Length": String(size) },
    });

    let res = await openSession();
    if (res.status === 401) {
      token = await getAccessToken(true);
      folderId = await ensureFolder(token);
      res = await openSession();
    }
    if (res.status !== 200 || !res.headers.location) {
      throw new Error(`Drive refused the upload: ${googleError(res, `HTTP ${res.status}`)}`);
    }

    const file = await putStream(res.headers.location, filePath, size);
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    // Housekeeping is best-effort: the archive is safely on Drive by now, so a
    // failure to tidy up must not turn a successful upload into a reported one.
    try { await deleteSameName(token, folderId, name, file.id); } catch (_) {}
    try {
      const pruned = await pruneRemote(token, folderId, retainCount());
      if (pruned > 0) console.log(`[gdrive] pruned ${pruned} old upload(s), keeping ${retainCount()}`);
    } catch (_) {}

    writeStore({
      lastUpload: {
        at: new Date().toISOString(), name, sizeBytes: size,
        fileId: file.id || null, seconds: Number(secs), trigger: opts.trigger || "manual",
      },
      lastError: null,
    });
    console.log(`[gdrive] uploaded ${name} (${(size / 1048576).toFixed(2)} MB) in ${secs}s → ${folderName()}`);
    return { ok: true, id: file.id || null, name, sizeBytes: size, seconds: Number(secs) };
  } catch (err) {
    recordError(err.message);
    console.warn(`[gdrive] upload FAILED for ${name}: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    _uploading = false;
  }
}

// ── Status (Settings UI) ─────────────────────────────────────────────────────
function status() {
  const s = readStore();
  return {
    configured: isConfigured(),
    connected: isConnected(),
    account: s.account || null,
    folderName: folderName(),
    retain: retainCount(),
    uploading: _uploading,
    // Never send the secret back to the browser; the leading project number is
    // enough to confirm which client is saved.
    clientIdHint: s.clientId ? String(s.clientId).slice(0, 12) + "…" : null,
    lastUpload: s.lastUpload || null,
    lastError: s.lastError || null,
  };
}

module.exports = {
  isConnected,
  saveCredentials,
  startDeviceAuth,
  pollDeviceAuth,
  cancelDeviceAuth,
  disconnect,
  uploadFile,
  status,
};

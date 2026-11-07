/**
 * brokers.js — Broker maintenance page (System → Brokers)
 * ─────────────────────────────────────────────────────────────────────────────
 * One place to see and edit every broker the app knows about.
 *
 *   Built-in (Fyers, Zerodha) — wired into the code. Their keys live in .env
 *   and are saved through POST /settings/save, so the secret masking, audit
 *   trail and in-process apply all stay in one path. Login status comes from
 *   /token-sync/status; Logout goes through /token-sync/reset.
 *
 *   Added (any other broker) — a saved entry only: name + keys + redirect URL,
 *   kept in ~/trading-data/brokers.json (mode 0600). No code reads these yet, so
 *   an added broker cannot log in or trade until an adapter is written for it.
 *   The page says so on every added row.
 *
 *   GET  /brokers         → page shell (OPEN_PATHS)
 *   GET  /brokers/list    → added brokers, secrets reduced to a boolean (OPEN_PATHS)
 *   POST /brokers/save    → add or update one added broker (API_SECRET)
 *   POST /brokers/delete  → remove one added broker (API_SECRET)
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const os      = require("os");
const path    = require("path");
const crypto  = require("crypto");

const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

const DATA_DIR     = path.join(os.homedir(), "trading-data");
const BROKERS_FILE = path.join(DATA_DIR, "brokers.json");
const MAX_BROKERS  = 20;
const NAME_MAX     = 40;
const FIELD_MAX    = 300;

// Names that would be confused with the wired brokers.
const RESERVED_NAMES = new Set(["fyers", "zerodha", "kite"]);

function readAll() {
  try {
    if (!fs.existsSync(BROKERS_FILE)) return [];
    const d = JSON.parse(fs.readFileSync(BROKERS_FILE, "utf-8"));
    return Array.isArray(d && d.brokers) ? d.brokers : [];
  } catch (err) {
    // A corrupt file must not be overwritten by the next save — that would
    // silently drop every entry in it. Surface it and refuse writes instead.
    const e = new Error(`brokers.json is unreadable (${err.message}) — fix or remove it on the host.`);
    e.corrupt = true;
    throw e;
  }
}

function writeAll(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = BROKERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ brokers: list }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, BROKERS_FILE);
  try { fs.chmodSync(BROKERS_FILE, 0o600); } catch (_) { /* best effort */ }
}

// What the browser sees: never the secret, only whether one is stored.
function publicView(b) {
  return {
    id: b.id, name: b.name, clientId: b.clientId || "", apiKey: b.apiKey || "",
    redirectUrl: b.redirectUrl || "", notes: b.notes || "",
    hasSecret: !!b.apiSecret, createdAt: b.createdAt || null, updatedAt: b.updatedAt || null,
  };
}

function clean(v, max) {
  const s = String(v == null ? "" : v).trim();
  if (/[\r\n]/.test(s)) throw new Error("Line breaks are not allowed.");
  if (s.length > max) throw new Error(`A value is longer than ${max} characters.`);
  return s;
}

function isMasked(v) { return /^[*•]+$/.test(String(v || "").trim()); }

router.get("/list", (req, res) => {
  try {
    res.json({ success: true, brokers: readAll().map(publicView) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/save", (req, res) => {
  const body = req.body || {};
  let list;
  try { list = readAll(); }
  catch (err) { return res.status(500).json({ success: false, error: err.message }); }

  let name, clientId, apiKey, apiSecret, redirectUrl, notes;
  try {
    name        = clean(body.name, NAME_MAX);
    clientId    = clean(body.clientId, FIELD_MAX);
    apiKey      = clean(body.apiKey, FIELD_MAX);
    apiSecret   = clean(body.apiSecret, FIELD_MAX);
    redirectUrl = clean(body.redirectUrl, FIELD_MAX);
    notes       = clean(body.notes, FIELD_MAX);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  if (!name) return res.status(400).json({ success: false, error: "Broker name is required." });
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return res.status(400).json({ success: false, error: `${name} is already built in — edit it in the Built-in section.` });
  }
  if (redirectUrl && !/^https?:\/\//i.test(redirectUrl)) {
    return res.status(400).json({ success: false, error: "Redirect URL must start with http:// or https://" });
  }
  if (isMasked(apiSecret)) {
    return res.status(400).json({ success: false, error: "That ******** is a mask, not the real secret. Leave it blank to keep the saved one." });
  }

  const id = body.id ? String(body.id) : null;
  const dup = list.find(b => b.name.toLowerCase() === name.toLowerCase() && b.id !== id);
  if (dup) return res.status(400).json({ success: false, error: `A broker named ${dup.name} already exists.` });

  const now = Date.now();
  if (id) {
    const b = list.find(x => x.id === id);
    if (!b) return res.status(404).json({ success: false, error: "That broker no longer exists — reload the page." });
    Object.assign(b, { name, clientId, apiKey, redirectUrl, notes, updatedAt: now });
    if (apiSecret) b.apiSecret = apiSecret;          // blank = keep the saved secret
  } else {
    if (list.length >= MAX_BROKERS) {
      return res.status(400).json({ success: false, error: `At most ${MAX_BROKERS} brokers can be added.` });
    }
    list.push({ id: crypto.randomBytes(6).toString("hex"), name, clientId, apiKey, apiSecret,
                redirectUrl, notes, createdAt: now, updatedAt: now });
  }

  try { writeAll(list); }
  catch (err) { return res.status(500).json({ success: false, error: `Could not save: ${err.message}` }); }
  console.log(`🏦 [brokers] ${id ? "updated" : "added"} broker "${name}".`);
  res.json({ success: true, brokers: list.map(publicView) });
});

router.post("/delete", (req, res) => {
  const id = String((req.body && req.body.id) || "");
  let list;
  try { list = readAll(); }
  catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  const b = list.find(x => x.id === id);
  if (!b) return res.status(404).json({ success: false, error: "That broker no longer exists — reload the page." });
  try { writeAll(list.filter(x => x.id !== id)); }
  catch (err) { return res.status(500).json({ success: false, error: `Could not delete: ${err.message}` }); }
  console.log(`🏦 [brokers] removed broker "${b.name}".`);
  res.json({ success: true, brokers: list.filter(x => x.id !== id).map(publicView) });
});

// Built-in brokers: the .env keys each one uses. `secret` keys are write-only —
// the page never shows them, and a blank box means "keep the current value".
const BUILTIN = [
  { id: "fyers", name: "Fyers", cls: "fy", login: "/auth/login",
    use: "NIFTY data feed + BB_RSI / PA / ORB and other Fyers live engines",
    fields: [
      { key: "APP_ID",       label: "App ID" },
      { key: "SECRET_KEY",   label: "Secret Key", secret: true },
      { key: "REDIRECT_URL", label: "Redirect URL" },
    ] },
  { id: "zerodha", name: "Zerodha", cls: "zd", login: "/auth/zerodha/login",
    use: "EMA_RSI_ST and other Zerodha live engines",
    fields: [
      { key: "ZERODHA_API_KEY",    label: "API Key" },
      { key: "ZERODHA_API_SECRET", label: "API Secret", secret: true },
    ] },
];

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

router.get("/", (req, res) => {

  const builtinHtml = BUILTIN.map(b => `
    <div class="row" data-broker="${b.id}">
      <div class="row-head">
        <span class="broker ${b.cls}">${esc(b.name)}</span>
        <span class="pill" id="st-${b.id}">checking…</span>
        <span class="meta">${esc(b.use)}</span>
      </div>
      <div class="grid">
        ${b.fields.map(f => `
          <label class="fld">
            <span>${esc(f.label)} <code>${f.key}</code></span>
            <input type="${f.secret ? "password" : "text"}" data-key="${f.key}" ${f.secret ? 'data-secret="1"' : ""}
                   autocomplete="off" spellcheck="false"
                   value="${f.secret ? "" : esc(process.env[f.key] || "")}"
                   placeholder="${f.secret ? (process.env[f.key] ? "saved — leave blank to keep" : "not set") : ""}">
          </label>`).join("")}
      </div>
      <div class="btn-row">
        <button class="btn btn-save" onclick="saveBuiltin('${b.id}', this)">💾 Save</button>
        <a class="btn btn-login" href="${b.login}">🔐 Login</a>
        <button class="btn btn-reset" id="lo-${b.id}" hidden onclick="logoutBroker('${b.id}', this)">🔑 Logout</button>
      </div>
    </div>`).join("");

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  ${faviconLink()}
  <title>Brokers — Trading BOT</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    html, body { height:100%; }
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; }
    ${sidebarCSS()}
    ${modalCSS()}
    .page { padding:22px 28px 80px; max-width:1000px; }
    .sub { font-size:0.72rem; color:var(--muted-1,#8ba1c2); margin-bottom:18px; line-height:1.6; }
    .card { background:#0a1018; border:1px solid #1a2236; border-radius:8px; margin-bottom:20px; overflow:hidden; }
    .card-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:11px 16px; background:#0d1320; border-bottom:1px solid #1a2236; flex-wrap:wrap; }
    .card-title { font-size:0.78rem; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#60a5fa; }
    .card-title.added { color:#a5b4fc; }
    .card-note { font-size:0.66rem; color:var(--muted-1,#8ba1c2); }
    .card-body { padding:6px 16px 14px; }
    .row { padding:14px 0; border-bottom:1px solid #121a2a; }
    .row:last-child { border-bottom:none; }
    .row-head { display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
    .broker { font-size:0.8rem; font-weight:700; letter-spacing:0.4px; }
    .broker.fy { color:#10b981; } .broker.zd { color:#f472b6; } .broker.cu { color:#a5b4fc; }
    .pill { font-size:0.6rem; font-weight:700; letter-spacing:0.5px; padding:2px 8px; border-radius:10px; border:1px solid currentColor; text-transform:uppercase; color:#8ba1c2; }
    .pill.ok { color:#10b981; } .pill.warn { color:#fbbf24; } .pill.bad { color:#f87171; }
    .meta { font-size:0.66rem; color:var(--muted-1,#8ba1c2); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px; }
    .fld { display:flex; flex-direction:column; gap:4px; font-size:0.66rem; color:var(--muted-1,#8ba1c2); min-width:0; }
    .fld code { font-family:'IBM Plex Mono',monospace; font-size:0.6rem; color:#64748b; }
    .fld input, .fld textarea { width:100%; font-family:'IBM Plex Mono',monospace; font-size:0.72rem; background:#0d1320; border:1px solid #1a2236; border-radius:6px; padding:9px 11px; color:#c8d8f0; outline:none; min-height:40px; }
    .fld input:focus { border-color:#1e3a5a; }
    .fld.wide { grid-column:1 / -1; }
    .btn { font-size:0.68rem; font-weight:600; padding:9px 14px; border-radius:6px; border:1px solid; cursor:pointer; font-family:inherit; display:inline-flex; align-items:center; justify-content:center; gap:5px; min-height:44px; text-decoration:none; }
    .btn-save  { background:#05170f; border-color:#0e3a28; color:#34d399; }
    .btn-login { background:#071428; border-color:#0e2850; color:#60a5fa; }
    .btn-add   { background:#0a1226; border-color:#26386e; color:#a5b4fc; font-weight:700; }
    .btn-edit  { background:#060a14; border-color:#0e1a28; color:#818cf8; }
    .btn-reset { background:#140a05; border-color:#3a2410; color:#fbbf24; }
    .btn-del   { background:#180508; border-color:#401018; color:#f87171; }
    .btn:hover:not(:disabled) { filter:brightness(1.25); }
    .btn:disabled { opacity:0.4; cursor:not-allowed; }
    .btn-row { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
    .kv { font-family:'IBM Plex Mono',monospace; font-size:0.68rem; color:#94a3b8; word-break:break-all; }
    .kv b { color:#64748b; font-weight:500; }
    .empty { font-size:0.7rem; color:var(--muted-1,#8ba1c2); padding:14px 0; }
    #addForm[hidden] { display:none; }
    @media (max-width:640px) {
      html, body { height:auto; }
      body { display:block; height:auto; overflow-x:hidden; }
      .page { padding:14px max(14px, env(safe-area-inset-right)) calc(80px + env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); }
      .grid { grid-template-columns:1fr; }
      .btn { flex:1 1 100%; }
    }
    :root[data-theme="light"] body { background:#f4f6f9; color:#334155; }
    :root[data-theme="light"] .sub, :root[data-theme="light"] .card-note,
    :root[data-theme="light"] .meta, :root[data-theme="light"] .fld, :root[data-theme="light"] .empty { color:#4b5769; }
    :root[data-theme="light"] .card { background:#fff; border-color:#e0e4ea; }
    :root[data-theme="light"] .card-head { background:#f8fafc; border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .row { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .fld input { background:#fff; border-color:#e0e4ea; color:#334155; }
    :root[data-theme="light"] .kv { color:#475569; }
    :root[data-theme="light"] .btn-save  { background:#ecfdf5; border-color:#a7f3d0; color:#047857; }
    :root[data-theme="light"] .btn-login { background:#eff6ff; border-color:#bfdbfe; color:#1e40af; }
    :root[data-theme="light"] .btn-add   { background:#eef2ff; border-color:#c7d2fe; color:#3730a3; }
    :root[data-theme="light"] .btn-edit  { background:#eef2ff; border-color:#c7d2fe; color:#4338ca; }
    :root[data-theme="light"] .btn-reset { background:#fffbeb; border-color:#fde68a; color:#92400e; }
    :root[data-theme="light"] .btn-del   { background:#fef2f2; border-color:#fecaca; color:#b91c1c; }
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('brokers', false)}
<div class="main-content">

<div class="top-bar">
  <div>
    <div class="top-bar-title">🏦 Brokers</div>
    <div class="top-bar-meta">Broker keys, login status and logout — and a place to add more brokers</div>
  </div>
</div>

<div class="page">
  <div class="sub">
    Fyers and Zerodha are wired into the app. Their keys are saved to <code>.env</code>; key changes need a server restart and a fresh login.
    Brokers you add here are saved as entries only — they cannot log in or trade until code is written for them.
  </div>

  <div class="card">
    <div class="card-head">
      <div class="card-title">Built-in brokers</div>
      <div class="card-note">Secrets are never shown — leave the box blank to keep the saved one</div>
    </div>
    <div class="card-body">${builtinHtml}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <div class="card-title added">Added brokers</div>
      <button class="btn btn-add" onclick="openForm(null)">＋ Add broker</button>
    </div>
    <div class="card-body">
      <div id="addForm" hidden class="row">
        <div class="row-head"><span class="broker cu" id="formTitle">New broker</span></div>
        <div class="grid">
          <label class="fld"><span>Broker name *</span><input id="f-name" maxlength="${NAME_MAX}" placeholder="e.g. Dhan, Upstox, Angel One"></label>
          <label class="fld"><span>Client / User ID</span><input id="f-clientId" autocomplete="off"></label>
          <label class="fld"><span>API Key / App ID</span><input id="f-apiKey" autocomplete="off" spellcheck="false"></label>
          <label class="fld"><span>API Secret</span><input id="f-apiSecret" type="password" autocomplete="new-password" spellcheck="false"></label>
          <label class="fld wide"><span>Redirect URL</span><input id="f-redirectUrl" autocomplete="off" spellcheck="false" placeholder="https://…"></label>
          <label class="fld wide"><span>Notes</span><input id="f-notes" maxlength="${FIELD_MAX}"></label>
        </div>
        <div class="btn-row">
          <button class="btn btn-save" id="formSave" onclick="saveAdded(this)">💾 Save broker</button>
          <button class="btn btn-edit" onclick="closeForm()">Cancel</button>
        </div>
      </div>
      <div id="addedList"><div class="empty">Loading…</div></div>
    </div>
  </div>
</div>

</div>
</div>
<script>
${modalJS()}
function escH(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
// showAlert/showConfirm render their text as HTML — escape anything that can
// carry a broker name typed by the user.
function toast(msg, type) { showAlert({ icon: type === 'error' ? '⚠️' : '✅', title: type === 'error' ? 'Error' : 'Done', message: escH(msg) }); }

// ── Built-in: login status + Logout ─────────────────────────────────────────
async function refreshStatus() {
  var d = null;
  try { var r = await fetch('/token-sync/status'); if (r.ok) d = await r.json(); } catch (e) {}
  ['fyers', 'zerodha'].forEach(function (b) {
    var pill = document.getElementById('st-' + b), lo = document.getElementById('lo-' + b);
    if (!d) { pill.className = 'pill warn'; pill.textContent = 'unknown'; lo.hidden = true; return; }
    var on = !!(d[b] && d[b].present);
    pill.className = 'pill ' + (on ? 'ok' : 'bad');
    pill.textContent = on ? 'logged in' : 'logged out';
    lo.hidden = !on;
  });
}

async function logoutBroker(broker, btn) {
  var ok = await showConfirm({ icon: '🔑', title: 'Logout ' + broker.toUpperCase(),
    message: 'Clear the saved token for ' + broker.toUpperCase() + '? You will have to log in again before live data or orders work.',
    cancelText: 'Cancel', confirmText: 'Logout', confirmClass: 'modal-btn-danger' });
  if (!ok) return;
  btn.disabled = true;
  try {
    var r = await secretFetch('/token-sync/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ broker: broker }) });
    if (!r) return;
    var d = await r.json();
    if (!d.success) return toast(d.error || 'Could not log out', 'error');
    toast(broker.toUpperCase() + ' logged out.');
  } catch (e) { toast('Could not log out: ' + e.message, 'error'); }
  finally { btn.disabled = false; refreshStatus(); }
}

// ── Built-in: save keys through the Settings save path ──────────────────────
async function saveBuiltin(broker, btn) {
  var row = document.querySelector('[data-broker="' + broker + '"]');
  var updates = {}, n = 0, blank = [];
  row.querySelectorAll('input[data-key]').forEach(function (inp) {
    var v = inp.value.trim();
    if (inp.dataset.secret && !v) return;         // blank secret = keep current
    if (!inp.dataset.secret && v === inp.defaultValue.trim()) return; // unchanged
    if (!v) { blank.push(inp.dataset.key); return; } // emptying a key breaks the login
    updates[inp.dataset.key] = v; n++;
  });
  if (blank.length) return toast('These cannot be left empty: ' + blank.join(', '), 'error');
  if (!n) return toast('Nothing changed.', 'error');
  btn.disabled = true;
  try {
    var r = await secretFetch('/settings/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: updates, note: 'Brokers page: ' + broker + ' keys' }) });
    if (!r) return;
    var d = await r.json();
    if (!d.success) return toast(d.error || 'Could not save', 'error');
    row.querySelectorAll('input[data-key]').forEach(function (inp) {
      if (inp.dataset.secret) { if (inp.value.trim()) inp.placeholder = 'saved — leave blank to keep'; inp.value = ''; }
      else inp.defaultValue = inp.value;
    });
    toast('Saved. Restart the server and log in again for new keys to take effect.');
  } catch (e) { toast('Could not save: ' + e.message, 'error'); }
  finally { btn.disabled = false; }
}

// ── Added brokers ───────────────────────────────────────────────────────────
var added = [], editingId = null;
var FIELDS = ['name', 'clientId', 'apiKey', 'apiSecret', 'redirectUrl', 'notes'];

function renderAdded() {
  var el = document.getElementById('addedList');
  if (!added.length) { el.innerHTML = '<div class="empty">No brokers added yet.</div>'; return; }
  el.innerHTML = added.map(function (b) {
    var kv = function (k, v) { return v ? '<div class="kv"><b>' + k + ':</b> ' + escH(v) + '</div>' : ''; };
    return '<div class="row">'
      + '<div class="row-head"><span class="broker cu">' + escH(b.name) + '</span>'
      + '<span class="pill warn">not wired yet</span>'
      + '<span class="meta">needs code before it can log in or trade</span></div>'
      + kv('Client ID', b.clientId) + kv('API Key', b.apiKey)
      + '<div class="kv"><b>API Secret:</b> ' + (b.hasSecret ? 'saved' : 'not set') + '</div>'
      + kv('Redirect URL', b.redirectUrl) + kv('Notes', b.notes)
      + '<div class="btn-row">'
      + '<button class="btn btn-edit" onclick="openForm(\\'' + b.id + '\\')">✏️ Edit</button>'
      + '<button class="btn btn-del" onclick="deleteAdded(\\'' + b.id + '\\', this)">🗑 Delete</button>'
      + '</div></div>';
  }).join('');
}

async function loadAdded() {
  try {
    var r = await fetch('/brokers/list');
    var d = await r.json();
    if (!d.success) throw new Error(d.error || ('HTTP ' + r.status));
    added = d.brokers; renderAdded();
  } catch (e) {
    document.getElementById('addedList').innerHTML = '<div class="empty">Could not load brokers: ' + escH(e.message) + '</div>';
  }
}

function openForm(id) {
  editingId = id;
  var b = id ? added.find(function (x) { return x.id === id; }) : null;
  document.getElementById('formTitle').textContent = b ? 'Edit ' + b.name : 'New broker';
  FIELDS.forEach(function (f) { document.getElementById('f-' + f).value = b && f !== 'apiSecret' ? (b[f] || '') : ''; });
  document.getElementById('f-apiSecret').placeholder = b && b.hasSecret ? 'saved — leave blank to keep' : '';
  var form = document.getElementById('addForm');
  form.hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('f-name').focus();
}
function closeForm() { editingId = null; document.getElementById('addForm').hidden = true; }

async function saveAdded(btn) {
  var body = { id: editingId };
  FIELDS.forEach(function (f) { body[f] = document.getElementById('f-' + f).value.trim(); });
  if (!body.name) return toast('Broker name is required.', 'error');
  btn.disabled = true;
  try {
    var r = await secretFetch('/brokers/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r) return;
    var d = await r.json();
    if (!d.success) return toast(d.error || 'Could not save', 'error');
    added = d.brokers; renderAdded(); closeForm();
    toast('Broker saved.');
  } catch (e) { toast('Could not save: ' + e.message, 'error'); }
  finally { btn.disabled = false; }
}

async function deleteAdded(id, btn) {
  var b = added.find(function (x) { return x.id === id; });
  if (!b) return;
  var ok = await showConfirm({ icon: '🗑', title: 'Delete ' + escH(b.name), message: 'Delete the saved entry for ' + escH(b.name) + '? Its keys are removed too.',
    cancelText: 'Cancel', confirmText: 'Delete', confirmClass: 'modal-btn-danger' });
  if (!ok) return;
  btn.disabled = true;
  try {
    var r = await secretFetch('/brokers/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
    if (!r) return;
    var d = await r.json();
    if (!d.success) return toast(d.error || 'Could not delete', 'error');
    added = d.brokers; renderAdded();
    if (editingId === id) closeForm();
  } catch (e) { toast('Could not delete: ' + e.message, 'error'); }
  finally { btn.disabled = false; }
}

refreshStatus();
loadAdded();
</script>
</body>
</html>`);
});

module.exports = router;

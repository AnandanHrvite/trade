/**
 * SETTINGS — /settings
 * ─────────────────────────────────────────────────────────────────────────────
 * Web UI to configure .env values without SSH into EC2.
 * Changes are applied to process.env IN-MEMORY and written to .env on disk.
 * No server restart required for most settings (values read at runtime).
 *
 * Routes:
 *   GET  /settings         → Settings page UI
 *   GET  /settings/data    → JSON of current .env values (AJAX poll)
 *   POST /settings/save    → Save updated values (protected by API_SECRET)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS } = require("../utils/sharedNav");

const ENV_PATH = path.resolve(__dirname, "../../.env");

// ── Keys that are SENSITIVE and should never be shown/editable in the UI ─────
const HIDDEN_KEYS = [
  "SECRET_KEY", "ZERODHA_API_SECRET", "API_SECRET",
  "ACCESS_TOKEN", "ZERODHA_ACCESS_TOKEN",
  "TELEGRAM_BOT_TOKEN",
];

// ── Settings schema: defines the UI layout ──────────────────────────────────
const SETTINGS_SCHEMA = [
  {
    section: "Trading Controls",
    icon: "⚡",
    fields: [
      { key: "LIVE_TRADE_ENABLED", label: "Live Trade", type: "toggle", desc: "Enable/disable live order placement via Zerodha" },
      { key: "VIX_FILTER_ENABLED", label: "VIX Filter", type: "toggle", desc: "Block entries when India VIX is too high" },
    ],
  },
  {
    section: "Instrument",
    icon: "📈",
    fields: [
      { key: "INSTRUMENT", label: "Trade Type", type: "select", options: ["NIFTY_OPTIONS", "NIFTY_FUTURES"], desc: "Options (CE/PE) or Futures (Long/Short)" },
      { key: "LOT_MULTIPLIER", label: "Lot Multiplier", type: "number", min: 1, max: 50, step: 1, desc: "Number of lots per trade (1 lot = 75 qty)" },
      { key: "STRIKE_OFFSET", label: "Strike Offset", type: "number", min: -200, max: 200, step: 50, desc: "0=ATM, 50=1 OTM, -50=1 ITM" },
    ],
  },
  {
    section: "Risk Controls",
    icon: "🛡️",
    fields: [
      { key: "MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 50000, step: 500, desc: "Kill-switch: stop trading after this much loss" },
      { key: "MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 1, max: 50, step: 1, desc: "Maximum entries per day" },
      { key: "OPT_STOP_PCT", label: "Option Stop %", type: "number", min: 0.05, max: 0.50, step: 0.05, desc: "Fallback stop-loss as % of option premium" },
    ],
  },
  {
    section: "VIX Filter",
    icon: "🌡️",
    fields: [
      { key: "VIX_MAX_ENTRY", label: "VIX Max Entry", type: "number", min: 10, max: 40, step: 1, desc: "Block ALL entries above this VIX level" },
      { key: "VIX_STRONG_ONLY", label: "VIX Strong Only", type: "number", min: 8, max: 30, step: 1, desc: "Only STRONG signals allowed above this VIX" },
    ],
  },
  {
    section: "Trailing Stop Loss",
    icon: "📐",
    fields: [
      { key: "TRAIL_ACTIVATE_PTS", label: "Activate (pts)", type: "number", min: 5, max: 50, step: 5, desc: "Min points before trail starts" },
      { key: "TRAIL_TIER1_UPTO", label: "Tier 1 Upto (pts)", type: "number", min: 10, max: 100, step: 5 },
      { key: "TRAIL_TIER1_GAP", label: "Tier 1 Gap (pts)", type: "number", min: 5, max: 100, step: 5 },
      { key: "TRAIL_TIER2_UPTO", label: "Tier 2 Upto (pts)", type: "number", min: 20, max: 200, step: 5 },
      { key: "TRAIL_TIER2_GAP", label: "Tier 2 Gap (pts)", type: "number", min: 5, max: 100, step: 5 },
      { key: "TRAIL_TIER3_GAP", label: "Tier 3 Gap (pts)", type: "number", min: 5, max: 100, step: 5 },
    ],
  },
  {
    section: "Timeframe",
    icon: "⏱️",
    fields: [
      { key: "TRADE_RESOLUTION", label: "Candle Resolution", type: "select", options: ["1", "5", "15", "60"], desc: "Minutes per candle" },
      { key: "TRADE_START_TIME", label: "Start Time", type: "text", desc: "HH:MM IST (e.g. 09:15)" },
      { key: "TRADE_STOP_TIME", label: "Stop Time", type: "text", desc: "HH:MM IST (e.g. 15:30)" },
    ],
  },
  {
    section: "Backtest",
    icon: "🔍",
    fields: [
      { key: "BACKTEST_FROM", label: "From Date", type: "date" },
      { key: "BACKTEST_TO", label: "To Date", type: "date" },
      { key: "BACKTEST_CAPITAL", label: "Capital (₹)", type: "number", min: 10000, max: 10000000, step: 10000 },
      { key: "BACKTEST_OPTION_SIM", label: "Option Simulation", type: "toggle", desc: "Simulate option P&L with delta/theta" },
      { key: "BACKTEST_DELTA", label: "Delta", type: "number", min: 0.1, max: 1.0, step: 0.05 },
      { key: "BACKTEST_THETA_DAY", label: "Theta ₹/day", type: "number", min: 0, max: 50, step: 1 },
    ],
  },
  {
    section: "Paper Trade",
    icon: "📋",
    fields: [
      { key: "PAPER_TRADE_CAPITAL", label: "Capital (₹)", type: "number", min: 10000, max: 10000000, step: 10000 },
    ],
  },
  {
    section: "Server & API",
    icon: "🖥️",
    fields: [
      { key: "PORT", label: "Port", type: "number", min: 1000, max: 65535, step: 1, desc: "Requires restart" },
      { key: "EC2_IP", label: "EC2 IP", type: "text", desc: "Requires restart" },
      { key: "APP_ID", label: "Fyers App ID", type: "text" },
      { key: "REDIRECT_URL", label: "Fyers Redirect URL", type: "text" },
      { key: "ZERODHA_API_KEY", label: "Zerodha API Key", type: "text" },
      { key: "ZERODHA_REDIRECT_URL", label: "Zerodha Redirect URL", type: "text" },
    ],
  },
  {
    section: "Telegram",
    icon: "📱",
    fields: [
      { key: "TELEGRAM_CHAT_ID", label: "Chat ID", type: "text", desc: "Leave blank to disable notifications" },
    ],
  },
];

// ── Parse .env file into object ─────────────────────────────────────────────
function parseEnvFile() {
  try {
    const content = fs.readFileSync(ENV_PATH, "utf-8");
    const result = {};
    content.split("\n").forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) return;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      result[key] = val;
    });
    return result;
  } catch (err) {
    console.warn("[settings] Failed to read .env:", err.message);
    return {};
  }
}

// ── Write values back to .env file (preserves comments and structure) ───────
function updateEnvFile(updates) {
  try {
    let content = fs.readFileSync(ENV_PATH, "utf-8");
    const lines = content.split("\n");
    const updatedKeys = new Set();

    // Update existing keys in-place
    const newLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) return line;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key in updates) {
        updatedKeys.add(key);
        return `${key}=${updates[key]}`;
      }
      return line;
    });

    // Append any NEW keys that didn't exist in the file
    const newKeys = Object.keys(updates).filter(k => !updatedKeys.has(k));
    if (newKeys.length > 0) {
      newLines.push("");
      newLines.push("# ─────────────────────────────────────────────────────────────");
      newLines.push("# Custom settings (added via Settings UI)");
      newLines.push("# ─────────────────────────────────────────────────────────────");
      newKeys.forEach(k => newLines.push(`${k}=${updates[k]}`));
    }

    fs.writeFileSync(ENV_PATH, newLines.join("\n"), "utf-8");

    // Update process.env in-memory (immediate effect, no restart)
    Object.entries(updates).forEach(([k, v]) => {
      process.env[k] = v;
    });

    return { success: true, updatedCount: Object.keys(updates).length };
  } catch (err) {
    console.error("[settings] Failed to write .env:", err.message);
    return { success: false, error: err.message };
  }
}

// ── GET /settings/data — JSON of current values ─────────────────────────────
router.get("/data", (req, res) => {
  const envData = parseEnvFile();
  // Mask sensitive keys
  HIDDEN_KEYS.forEach(k => {
    if (envData[k]) envData[k] = "••••••••";
  });
  res.json({ success: true, data: envData });
});

// ── POST /settings/save — Save updated values ──────────────────────────────
router.post("/save", express.json(), (req, res) => {
  const { updates } = req.body;
  if (!updates || typeof updates !== "object") {
    return res.status(400).json({ success: false, error: "Missing updates object" });
  }

  // Block writes to sensitive keys via UI
  for (const k of HIDDEN_KEYS) {
    if (k in updates) {
      delete updates[k];
    }
  }

  // Validate — no empty keys
  const cleaned = {};
  Object.entries(updates).forEach(([k, v]) => {
    const key = k.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
    if (key) cleaned[key] = String(v).trim();
  });

  if (Object.keys(cleaned).length === 0) {
    return res.status(400).json({ success: false, error: "No valid updates" });
  }

  const result = updateEnvFile(cleaned);
  if (result.success) {
    console.log(`[settings] Updated ${result.updatedCount} values:`, Object.keys(cleaned).join(", "));
  }
  res.json(result);
});


// ── GET /settings — Settings page UI ────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";
  const envData    = parseEnvFile();

  // Build field HTML for each section
  function renderField(f) {
    const val = envData[f.key] ?? process.env[f.key] ?? "";
    const descHtml = f.desc ? `<div class="field-desc">${f.desc}</div>` : "";

    if (f.type === "toggle") {
      const checked = val === "true" || val === "1" ? "checked" : "";
      return `
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">${f.label}</div>
            ${descHtml}
          </div>
          <label class="toggle-switch">
            <input type="checkbox" data-key="${f.key}" ${checked} onchange="markDirty(this)"/>
            <span class="toggle-slider"></span>
          </label>
        </div>`;
    }

    if (f.type === "select") {
      const opts = f.options.map(o =>
        `<option value="${o}" ${o === val ? "selected" : ""}>${o}</option>`
      ).join("");
      return `
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">${f.label}</div>
            ${descHtml}
          </div>
          <select data-key="${f.key}" onchange="markDirty(this)">${opts}</select>
        </div>`;
    }

    if (f.type === "number") {
      return `
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">${f.label}</div>
            ${descHtml}
          </div>
          <input type="number" data-key="${f.key}" value="${val}"
            ${f.min != null ? `min="${f.min}"` : ""} ${f.max != null ? `max="${f.max}"` : ""}
            ${f.step != null ? `step="${f.step}"` : ""}
            onchange="markDirty(this)" oninput="markDirty(this)"/>
        </div>`;
    }

    if (f.type === "date") {
      return `
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">${f.label}</div>
            ${descHtml}
          </div>
          <input type="date" data-key="${f.key}" value="${val}" onchange="markDirty(this)"/>
        </div>`;
    }

    // text
    return `
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-label">${f.label}</div>
          ${descHtml}
        </div>
        <input type="text" data-key="${f.key}" value="${val}" onchange="markDirty(this)"/>
      </div>`;
  }

  const sectionsHtml = SETTINGS_SCHEMA.map(s => `
    <div class="settings-section">
      <div class="section-title">${s.icon} ${s.section}</div>
      <div class="section-card">
        ${s.fields.map(renderField).join("")}
      </div>
    </div>
  `).join("");

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Settings — Palani Andawar Trading Bot</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --bg:       #080c14;
      --surface:  #0d1320;
      --surface2: #111827;
      --border:   #1a2236;
      --border2:  #243048;
      --text:     #c8d8f0;
      --text2:    #e0eaf8;
      --muted:    #4a6080;
      --dim:      #3a5070;
      --accent:   #3b82f6;
      --green:    #10b981;
      --red:      #ef4444;
      --yellow:   #f59e0b;
      --purple:   #8b5cf6;
    }
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'IBM Plex Sans',system-ui,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; overflow-x:hidden; }

    ${sidebarCSS()}

    /* ── Top bar ─────────────────────────────────────────── */
    .top-bar {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 20px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .top-bar-title { font-size: 1.15rem; font-weight: 700; color: var(--text2); letter-spacing: -0.3px; }
    .top-bar-meta  { font-size: 0.7rem; color: var(--muted); margin-top: 4px; }

    /* ── Page ─────────────────────────────────────────────── */
    .page { padding: 28px 28px 60px; max-width: 880px; }

    /* ── Sticky save bar ─────────────────────────────────── */
    .save-bar {
      position: sticky; top: 0; z-index: 90;
      background: rgba(13,19,32,0.95); backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      padding: 12px 28px;
      display: none; align-items: center; justify-content: space-between; gap: 16px;
    }
    .save-bar.visible { display: flex; }
    .save-bar .change-count { font-size: 0.78rem; color: var(--yellow); font-weight: 700; }
    .save-bar .change-count::before { content:''; display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--yellow); margin-right:8px; vertical-align:middle; }
    .save-bar .btn-group { display: flex; gap: 10px; }

    /* ── Section ─────────────────────────────────────────── */
    .settings-section { margin-bottom: 24px; }
    .section-title {
      font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1.5px; color: var(--muted);
      margin-bottom: 10px;
      display: flex; align-items: center; gap: 10px;
    }
    .section-title::after { content:''; flex:1; height:1px; background:var(--border); }
    .section-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }

    /* ── Setting row ─────────────────────────────────────── */
    .setting-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      gap: 20px;
      transition: background 0.1s;
    }
    .setting-row:last-child { border-bottom: none; }
    .setting-row:hover { background: rgba(59,130,246,0.04); }
    .setting-info { flex: 1; min-width: 0; }
    .setting-label { font-size: 0.84rem; font-weight: 600; color: var(--text2); }
    .field-desc { font-size: 0.68rem; color: var(--muted); margin-top: 4px; line-height: 1.4; }

    /* ── Inputs ──────────────────────────────────────────── */
    input[type="text"], input[type="number"], input[type="date"], select {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 9px 14px;
      border-radius: 8px;
      font-size: 0.82rem;
      font-family: 'JetBrains Mono', monospace;
      min-width: 150px;
      max-width: 230px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(59,130,246,0.15); }
    input.dirty, select.dirty { border-color: var(--yellow); box-shadow: 0 0 0 2px rgba(245,158,11,0.15); }
    select { cursor: pointer; -webkit-appearance: none; appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%234a6080'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px;
    }
    input::placeholder { color: var(--dim); }

    /* ── Toggle switch ───────────────────────────────────── */
    .toggle-switch { position: relative; display: inline-block; width: 50px; height: 28px; flex-shrink: 0; }
    .toggle-switch input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
      background: #1e2940; border: 1px solid var(--border); border-radius: 28px; transition: 0.3s;
    }
    .toggle-slider::before {
      content: ""; position: absolute; height: 20px; width: 20px; left: 3px; bottom: 3px;
      background: #4a6080; border-radius: 50%; transition: 0.3s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .toggle-switch input:checked + .toggle-slider { background: #064e3b; border-color: #065f46; }
    .toggle-switch input:checked + .toggle-slider::before { transform: translateX(22px); background: var(--green); box-shadow: 0 0 8px rgba(16,185,129,0.4); }

    /* ── Buttons ─────────────────────────────────────────── */
    .btn-save {
      background: var(--accent); color: #fff; border: none;
      padding: 9px 28px; border-radius: 8px; font-weight: 700; font-size: 0.82rem;
      cursor: pointer; font-family: inherit; transition: all 0.15s; letter-spacing: 0.2px;
    }
    .btn-save:hover { filter: brightness(1.1); }
    .btn-save:disabled { opacity: 0.35; cursor: not-allowed; filter: none; }
    .btn-discard {
      background: transparent; color: var(--muted); border: 1px solid var(--border);
      padding: 9px 20px; border-radius: 8px; font-weight: 600; font-size: 0.82rem;
      cursor: pointer; font-family: inherit; transition: all 0.15s;
    }
    .btn-discard:hover { border-color: var(--red); color: var(--red); }

    /* ── Custom key-value ────────────────────────────────── */
    .custom-kv { padding: 20px; }
    .custom-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
    .custom-row + .custom-row { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
    .custom-row .field-group { display: flex; flex-direction: column; gap: 5px; }
    .custom-row label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); font-weight: 700; }
    .custom-row input[type="text"] { min-width: 200px; }
    .btn-add {
      background: rgba(16,185,129,0.08); color: var(--green); border: 1px solid #065f46;
      padding: 9px 18px; border-radius: 8px; font-weight: 700; font-size: 0.78rem;
      cursor: pointer; font-family: inherit; white-space: nowrap; transition: all 0.15s;
    }
    .btn-add:hover { background: rgba(16,185,129,0.15); border-color: var(--green); }

    /* ── Toast ───────────────────────────────────────────── */
    .toast {
      position: fixed; bottom: 28px; right: 28px;
      padding: 14px 22px; border-radius: 10px; font-size: 0.82rem; font-weight: 600;
      z-index: 999; opacity: 0; transform: translateY(12px);
      transition: all 0.3s; pointer-events: none;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .toast.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
    .toast.success { background: #052e16; color: var(--green); border: 1px solid #065f46; }
    .toast.error   { background: #2d0a0a; color: #f87171; border: 1px solid #7f1d1d; }
    .toast.info    { background: #0a1e3d; color: #60a5fa; border: 1px solid #1d3b6e; }

    /* ── Info banner ─────────────────────────────────────── */
    .info-banner {
      display: flex; align-items: center; gap: 12px;
      font-size: 0.72rem; color: #fcd34d; line-height: 1.6;
      background: rgba(245,158,11,0.06); border: 1px solid rgba(245,158,11,0.15);
      border-radius: 10px; padding: 14px 18px; margin-bottom: 24px;
    }
    .info-banner .banner-icon { font-size: 1.2rem; flex-shrink: 0; }
    .info-banner strong { color: #fbbf24; }

    /* ── Mobile ──────────────────────────────────────────── */
    @media (max-width:640px) {
      .page { padding: 16px 14px 40px; }
      .top-bar { padding: 14px 14px 14px 50px; }
      .setting-row { padding: 12px 14px; flex-wrap: wrap; }
      input[type="text"], input[type="number"], input[type="date"], select { min-width: 120px; max-width: 100%; width: 100%; }
      .custom-row { flex-direction: column; align-items: stretch; }
      .custom-row input[type="text"] { min-width: 100%; }
      .save-bar { padding: 10px 14px; }
    }
  </style>
</head>
<body>
<div class="app-shell">
  ${buildSidebar('settings', liveActive)}

  <div class="main-content">
    <div class="top-bar">
      <div>
        <div class="top-bar-title">Settings</div>
        <div class="top-bar-meta">Configure trading parameters — changes apply without server restart</div>
      </div>
    </div>

    <!-- Sticky save bar (appears when you change something) -->
    <div class="save-bar" id="saveBar">
      <span class="change-count" id="changeCount">0 unsaved changes</span>
      <div class="btn-group">
        <button class="btn-discard" onclick="discardChanges()">Discard</button>
        <button class="btn-save" id="saveBtn" onclick="saveSettings()">Save Changes</button>
      </div>
    </div>

    <div class="page">
      <div class="info-banner">
        <span class="banner-icon">💡</span>
        <div>Most settings take effect <strong>immediately</strong> after saving. Settings marked <strong>"Requires restart"</strong> need a server restart to apply.</div>
      </div>

      ${sectionsHtml}

      <!-- Custom Key-Value -->
      <div class="settings-section">
        <div class="section-title">➕ Add Custom .env Variable</div>
        <div class="section-card">
          <div class="custom-kv">
            <div class="custom-row" id="customRow1">
              <div class="field-group">
                <label>Key</label>
                <input type="text" id="customKey1" placeholder="MY_SETTING" style="text-transform:uppercase;"/>
              </div>
              <div class="field-group">
                <label>Value</label>
                <input type="text" id="customVal1" placeholder="100"/>
              </div>
              <button class="btn-add" onclick="addCustomVar(1)">+ Add to .env</button>
            </div>
            <div class="custom-row" id="customRow2">
              <div class="field-group">
                <label>Key</label>
                <input type="text" id="customKey2" placeholder="ANOTHER_KEY" style="text-transform:uppercase;"/>
              </div>
              <div class="field-group">
                <label>Value</label>
                <input type="text" id="customVal2" placeholder="hello"/>
              </div>
              <button class="btn-add" onclick="addCustomVar(2)">+ Add to .env</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
(function() {
  // Track original values for dirty detection
  var originals = {};
  document.querySelectorAll('[data-key]').forEach(function(el) {
    var key = el.getAttribute('data-key');
    if (el.type === 'checkbox') {
      originals[key] = el.checked;
    } else {
      originals[key] = el.value;
    }
  });
  window._originals = originals;
  window._dirtyKeys = new Set();
})();

function markDirty(el) {
  var key = el.getAttribute('data-key');
  if (!key) return;
  var currentVal = el.type === 'checkbox' ? el.checked : el.value;
  var origVal = window._originals[key];
  if (currentVal !== origVal && String(currentVal) !== String(origVal)) {
    window._dirtyKeys.add(key);
    if (el.type !== 'checkbox') el.classList.add('dirty');
  } else {
    window._dirtyKeys.delete(key);
    if (el.type !== 'checkbox') el.classList.remove('dirty');
  }
  updateSaveBar();
}

function updateSaveBar() {
  var bar = document.getElementById('saveBar');
  var count = document.getElementById('changeCount');
  var n = window._dirtyKeys.size;
  if (n > 0) {
    bar.classList.add('visible');
    count.textContent = n + ' change' + (n > 1 ? 's' : '');
  } else {
    bar.classList.remove('visible');
  }
}

function discardChanges() {
  document.querySelectorAll('[data-key]').forEach(function(el) {
    var key = el.getAttribute('data-key');
    if (el.type === 'checkbox') {
      el.checked = window._originals[key];
    } else {
      el.value = window._originals[key];
      el.classList.remove('dirty');
    }
  });
  window._dirtyKeys.clear();
  updateSaveBar();
  showToast('Changes discarded', 'info');
}

function saveSettings() {
  var btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  var updates = {};
  window._dirtyKeys.forEach(function(key) {
    var el = document.querySelector('[data-key="' + key + '"]');
    if (!el) return;
    if (el.type === 'checkbox') {
      updates[key] = el.checked ? 'true' : 'false';
    } else {
      updates[key] = el.value;
    }
  });

  if (Object.keys(updates).length === 0) {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
    return;
  }

  fetch('/settings/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: updates }),
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
    if (data.success) {
      // Update originals
      Object.keys(updates).forEach(function(key) {
        var el = document.querySelector('[data-key="' + key + '"]');
        if (el) {
          if (el.type === 'checkbox') {
            window._originals[key] = el.checked;
          } else {
            window._originals[key] = el.value;
            el.classList.remove('dirty');
          }
        }
      });
      window._dirtyKeys.clear();
      updateSaveBar();
      showToast('Settings saved (' + data.updatedCount + ' values updated)', 'success');
    } else {
      showToast('Save failed: ' + (data.error || 'unknown error'), 'error');
    }
  })
  .catch(function(err) {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
    showToast('Save failed: ' + err.message, 'error');
  });
}

function addCustomVar(n) {
  var keyEl = document.getElementById('customKey' + n);
  var valEl = document.getElementById('customVal' + n);
  var key = keyEl.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
  var val = valEl.value.trim();

  if (!key) { showToast('Enter a valid key name', 'error'); keyEl.focus(); return; }
  if (!val) { showToast('Enter a value', 'error'); valEl.focus(); return; }

  fetch('/settings/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: { [key]: val } }),
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) {
      showToast(key + '=' + val + ' added to .env', 'success');
      keyEl.value = '';
      valEl.value = '';
    } else {
      showToast('Failed: ' + (data.error || 'unknown'), 'error');
    }
  })
  .catch(function(err) {
    showToast('Failed: ' + err.message, 'error');
  });
}

function showToast(msg, type) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type + ' show';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(function() {
    el.classList.remove('show');
  }, 3000);
}
</script>
</body>
</html>`);
});

module.exports = router;

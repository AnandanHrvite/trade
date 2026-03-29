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
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

// Use process.cwd() for the .env path — this is where Node was started,
// which is always the project root (where .env lives).
// __dirname resolves to the compiled/deployed path which may differ on EC2.
const ENV_PATH = path.join(process.cwd(), ".env");

// ── Keys that are SENSITIVE and should never be shown/editable in the UI ─────
const HIDDEN_KEYS = [
  "SECRET_KEY", "ZERODHA_API_SECRET",
  "ACCESS_TOKEN", "ZERODHA_ACCESS_TOKEN",
  "TELEGRAM_BOT_TOKEN",
];

// ── Settings schema: defines the UI layout ──────────────────────────────────
// ── Effect types for the info tooltip ────────────────────────────────────────
const EFFECT = {
  INSTANT: { label: "Instant", color: "#10b981", icon: "⚡", tip: "Takes effect immediately after saving" },
  SESSION: { label: "Session restart", color: "#f59e0b", icon: "🔄", tip: "Stop & start your Paper/Live session to apply" },
  SERVER:  { label: "Server restart", color: "#ef4444", icon: "🖥️", tip: "Requires full server restart (node/nodemon)" },
  BACKTEST:{ label: "Next backtest", color: "#3b82f6", icon: "🔍", tip: "Applied on next backtest run" },
};

const SETTINGS_SCHEMA = [
  {
    section: "Trading Controls",
    icon: "⚡",
    fields: [
      { key: "LIVE_TRADE_ENABLED", label: "Live Trade", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable/disable live order placement via Zerodha" },
      { key: "VIX_FILTER_ENABLED", label: "VIX Filter", type: "toggle", effect: EFFECT.INSTANT, desc: "Block entries when India VIX is too high" },
      { key: "SCALP_MODE_ENABLED", label: "Scalp Mode", type: "toggle", effect: EFFECT.INSTANT, desc: "Show/hide all scalp menus (BT, Paper, Live)", default: "true" },
    ],
  },
  {
    section: "Instrument",
    icon: "📈",
    fields: [
      { key: "INSTRUMENT", label: "Trade Type", type: "select", options: ["NIFTY_OPTIONS", "NIFTY_FUTURES"], effect: EFFECT.INSTANT, desc: "Options (CE/PE) or Futures (Long/Short)" },
      { key: "NIFTY_LOT_SIZE", label: "Lot Size (Qty)", type: "number", min: 1, max: 200, step: 1, effect: EFFECT.INSTANT, desc: "Qty per lot — changes with SEBI circular (currently 65)" },
      { key: "LOT_MULTIPLIER", label: "Lot Multiplier", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "Number of lots per trade" },
      { key: "STRIKE_OFFSET_CE", label: "CE Strike Offset", type: "number", min: -200, max: 200, step: 50, effect: EFFECT.INSTANT, desc: "CE: -50=1 ITM, 0=ATM, +50=1 OTM", default: "0" },
      { key: "STRIKE_OFFSET_PE", label: "PE Strike Offset", type: "number", min: -200, max: 200, step: 50, effect: EFFECT.INSTANT, desc: "PE: +50=1 ITM, 0=ATM, -50=1 OTM", default: "0" },
    ],
  },
  {
    section: "Risk Controls",
    icon: "🛡️",
    fields: [
      { key: "MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 50000, step: 500, effect: EFFECT.SESSION, desc: "Kill-switch: stop trading after this much loss" },
      { key: "MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Maximum entries per day" },
      { key: "OPT_STOP_PCT", label: "Option Stop %", type: "number", min: 0.05, max: 0.50, step: 0.05, effect: EFFECT.SESSION, desc: "Fallback stop-loss as % of option premium" },
    ],
  },
  {
    section: "VIX Filter",
    icon: "🌡️",
    fields: [
      { key: "VIX_MAX_ENTRY", label: "VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Block ALL entries above this VIX level" },
      { key: "VIX_STRONG_ONLY", label: "VIX Strong Only", type: "number", min: 8, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "Only STRONG signals allowed above this VIX" },
    ],
  },
  {
    section: "Trailing Stop Loss",
    icon: "📐",
    fields: [
      { key: "TRAIL_ACTIVATE_PTS", label: "Activate (pts)", type: "number", min: 5, max: 50, step: 5, effect: EFFECT.SESSION, desc: "Min points before trail starts" },
      { key: "TRAIL_TIER1_UPTO", label: "Tier 1 Upto (pts)", type: "number", min: 10, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Gain range 0 to this value" },
      { key: "TRAIL_TIER1_GAP", label: "Tier 1 Gap (pts)", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Trail gap during Tier 1" },
      { key: "TRAIL_TIER2_UPTO", label: "Tier 2 Upto (pts)", type: "number", min: 20, max: 200, step: 5, effect: EFFECT.SESSION, desc: "Gain range Tier1 to this value" },
      { key: "TRAIL_TIER2_GAP", label: "Tier 2 Gap (pts)", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Trail gap during Tier 2" },
      { key: "TRAIL_TIER3_GAP", label: "Tier 3 Gap (pts)", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Trail gap above Tier 2" },
    ],
  },
  {
    section: "Timeframe",
    icon: "⏱️",
    fields: [
      { key: "TRADE_RESOLUTION", label: "Candle Resolution", type: "select", options: ["1", "5", "15", "60"], effect: EFFECT.SESSION, desc: "Minutes per candle" },
      { key: "TRADE_START_TIME", label: "Start Time", type: "text", effect: EFFECT.SESSION, desc: "HH:MM IST (e.g. 09:15)" },
      { key: "TRADE_STOP_TIME", label: "Stop Time", type: "text", effect: EFFECT.SESSION, desc: "HH:MM IST (e.g. 15:30)" },
    ],
  },
  {
    section: "Backtest",
    icon: "🔍",
    fields: [
      { key: "BACKTEST_FROM", label: "From Date", type: "date", effect: EFFECT.BACKTEST },
      { key: "BACKTEST_TO", label: "To Date", type: "date", effect: EFFECT.BACKTEST },
      { key: "BACKTEST_CAPITAL", label: "Capital (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.BACKTEST },
      { key: "BACKTEST_OPTION_SIM", label: "Option Simulation", type: "toggle", effect: EFFECT.BACKTEST, desc: "Simulate option P&L with delta/theta" },
      { key: "BACKTEST_DELTA", label: "Delta", type: "number", min: 0.1, max: 1.0, step: 0.05, effect: EFFECT.BACKTEST, desc: "Option delta for premium simulation" },
      { key: "BACKTEST_THETA_DAY", label: "Theta ₹/day", type: "number", min: 0, max: 50, step: 1, effect: EFFECT.BACKTEST, desc: "Daily theta decay in rupees" },
    ],
  },
  {
    section: "Paper Trade",
    icon: "📋",
    fields: [
      { key: "PAPER_TRADE_CAPITAL", label: "Capital (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.INSTANT, desc: "Starting capital for paper trades" },
    ],
  },
  {
    section: "Server & API",
    icon: "🖥️",
    fields: [
      { key: "PORT", label: "Port", type: "number", min: 1000, max: 65535, step: 1, effect: EFFECT.SERVER, desc: "Server listening port" },
      { key: "EC2_IP", label: "EC2 IP", type: "text", effect: EFFECT.SERVER, desc: "Server IP for SSL certificates" },
      { key: "APP_ID", label: "Fyers App ID", type: "text", effect: EFFECT.SERVER },
      { key: "REDIRECT_URL", label: "Fyers Redirect URL", type: "text", effect: EFFECT.SERVER },
      { key: "ZERODHA_API_KEY", label: "Zerodha API Key", type: "text", effect: EFFECT.SERVER },
      { key: "ZERODHA_REDIRECT_URL", label: "Zerodha Redirect URL", type: "text", effect: EFFECT.SERVER },
    ],
  },
  {
    section: "Scalp Mode",
    icon: "⚡",
    fields: [
      { key: "SCALP_ENABLED", label: "Scalp Live", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable/disable scalp live order placement via Fyers", default: "false" },
      { key: "SCALP_RESOLUTION", label: "Candle (min)", type: "select", options: ["1", "2", "3", "5"], effect: EFFECT.SESSION, desc: "Scalp candle resolution in minutes", default: "3" },
      { key: "SCALP_SL_PTS", label: "Stop Loss (pts)", type: "number", min: 3, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Fixed SL distance from entry", default: "15" },
      { key: "SCALP_TARGET_PTS", label: "Target (pts)", type: "number", min: 5, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Fixed target distance from entry", default: "22" },
      { key: "SCALP_TRAIL_GAP", label: "Trail Gap (pts)", type: "number", min: 3, max: 30, step: 1, effect: EFFECT.SESSION, desc: "Trailing SL gap behind best price", default: "10" },
      { key: "SCALP_TRAIL_AFTER", label: "Trail After (pts)", type: "number", min: 3, max: 30, step: 1, effect: EFFECT.SESSION, desc: "Activate trail after this many pts profit", default: "12" },
      { key: "SCALP_TIME_STOP_CANDLES", label: "Time Stop (candles)", type: "number", min: 2, max: 20, step: 1, effect: EFFECT.SESSION, desc: "Exit if no target hit within N candles", default: "5" },
      { key: "SCALP_MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Maximum scalp entries per day", default: "20" },
      { key: "SCALP_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 20000, step: 500, effect: EFFECT.SESSION, desc: "Scalp kill-switch — stops all entries", default: "2000" },
      { key: "SCALP_SL_PAUSE_CANDLES", label: "SL Pause (candles)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Pause entries after SL hit", default: "2" },
      { key: "SCALP_RSI_CE_MIN", label: "RSI CE Min", type: "number", min: 50, max: 70, step: 1, effect: EFFECT.SESSION, desc: "Minimum RSI for CE entry", default: "55" },
      { key: "SCALP_RSI_PE_MAX", label: "RSI PE Max", type: "number", min: 30, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Maximum RSI for PE entry", default: "45" },
      { key: "SCALP_MIN_BODY", label: "Min Body (pts)", type: "number", min: 2, max: 20, step: 1, effect: EFFECT.SESSION, desc: "Minimum candle body size", default: "7" },
      { key: "SCALP_ADX_ENABLED", label: "ADX Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Enable ADX trend filter for scalp", default: "true" },
      { key: "SCALP_ADX_MIN", label: "ADX Minimum", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.SESSION, desc: "ADX threshold (if enabled)", default: "20" },
      { key: "SCALP_MIN_SLOPE", label: "EMA Slope Min", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Min EMA9 slope for entry (filters flat crosses)", default: "2" },
      { key: "SCALP_USE_ATR_SL", label: "ATR-based SL", type: "toggle", effect: EFFECT.SESSION, desc: "Use ATR for dynamic SL/Target", default: "true" },
      { key: "SCALP_ATR_SL_MULT", label: "ATR SL Multiplier", type: "number", min: 1.0, max: 3.0, step: 0.1, effect: EFFECT.SESSION, desc: "SL = ATR x this", default: "1.5" },
      { key: "SCALP_ATR_TGT_MULT", label: "ATR Target Mult", type: "number", min: 1.5, max: 4.0, step: 0.1, effect: EFFECT.SESSION, desc: "Target = ATR x this", default: "2.5" },
      { key: "SCALP_ATR_MIN_SL", label: "ATR Min SL", type: "number", min: 5, max: 15, step: 1, effect: EFFECT.SESSION, desc: "Minimum SL floor", default: "8" },
      { key: "SCALP_ATR_MAX_SL", label: "ATR Max SL", type: "number", min: 15, max: 40, step: 1, effect: EFFECT.SESSION, desc: "Maximum SL cap", default: "18" },
      { key: "SCALP_RSI_CE_MIN_V2", label: "RSI CE Min (V2)", type: "number", min: 40, max: 70, step: 1, effect: EFFECT.SESSION, desc: "V2 RSI threshold for CE (overrides V1 if set)", default: "50" },
      { key: "SCALP_RSI_PE_MAX_V2", label: "RSI PE Max (V2)", type: "number", min: 30, max: 60, step: 1, effect: EFFECT.SESSION, desc: "V2 RSI threshold for PE (overrides V1 if set)", default: "50" },
    ],
  },
  {
    section: "Telegram",
    icon: "📱",
    fields: [
      { key: "TELEGRAM_CHAT_ID", label: "Chat ID", type: "text", effect: EFFECT.INSTANT, desc: "Leave blank to disable notifications" },
    ],
  },
  {
    section: "Security",
    icon: "🔒",
    fields: [
      { key: "API_SECRET", label: "API Secret", type: "password", effect: EFFECT.INSTANT, desc: "Protects action routes (start/stop/exit). Leave blank to disable" },
      { key: "LOGIN_SECRET", label: "Login Password", type: "password", effect: EFFECT.INSTANT, desc: "Page-level password gate. Leave blank for open access" },
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

// ── Classify which settings take effect immediately vs need restart ──────────
// These are read from process.env at runtime (not cached at module load)
const IMMEDIATE_KEYS = new Set([
  "LIVE_TRADE_ENABLED", "VIX_FILTER_ENABLED", "VIX_MAX_ENTRY", "VIX_STRONG_ONLY",
  "INSTRUMENT", "STRIKE_OFFSET_CE", "STRIKE_OFFSET_PE", "LOT_MULTIPLIER",
  "BACKTEST_FROM", "BACKTEST_TO", "BACKTEST_CAPITAL", "BACKTEST_OPTION_SIM",
  "BACKTEST_DELTA", "BACKTEST_THETA_DAY", "PAPER_TRADE_CAPITAL",
  "TELEGRAM_CHAT_ID", "TELEGRAM_BOT_TOKEN",
  "ACTIVE_STRATEGY", "NIFTY_SPOT_FALLBACK",
  "SCALP_ENABLED", "SCALP_MODE_ENABLED",
]);

// These are cached as const at module load — need session stop+start
const SESSION_RESTART_KEYS = new Set([
  "MAX_DAILY_LOSS", "MAX_DAILY_TRADES", "OPT_STOP_PCT",
  "TRAIL_ACTIVATE_PTS", "TRAIL_TIER1_UPTO", "TRAIL_TIER1_GAP",
  "TRAIL_TIER2_UPTO", "TRAIL_TIER2_GAP", "TRAIL_TIER3_GAP",
  "TRADE_RESOLUTION", "TRADE_START_TIME", "TRADE_STOP_TIME",
  // Scalp settings — need session restart
  "SCALP_RESOLUTION", "SCALP_SL_PTS", "SCALP_TARGET_PTS",
  "SCALP_TRAIL_GAP", "SCALP_TRAIL_AFTER", "SCALP_TIME_STOP_CANDLES",
  "SCALP_MAX_DAILY_TRADES", "SCALP_MAX_DAILY_LOSS", "SCALP_SL_PAUSE_CANDLES",
  "SCALP_RSI_CE_MIN", "SCALP_RSI_PE_MAX", "SCALP_MIN_BODY",
  "SCALP_ADX_ENABLED", "SCALP_ADX_MIN",
  "SCALP_USE_ATR_SL", "SCALP_ATR_SL_MULT", "SCALP_ATR_TGT_MULT",
  "SCALP_ATR_MIN_SL", "SCALP_ATR_MAX_SL",
  "SCALP_RSI_CE_MIN_V2", "SCALP_RSI_PE_MAX_V2",
]);

// ── Write values back to .env file (preserves comments and structure) ───────
function updateEnvFile(updates) {
  // Step 1: Always update process.env in-memory first (this never fails)
  Object.entries(updates).forEach(([k, v]) => {
    process.env[k] = v;
  });

  // Step 2: Try to persist to .env file on disk
  let fileSaved = false;
  let fileError = null;
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
    fileSaved = true;
  } catch (err) {
    fileError = err.message;
    console.error("[settings] .env file write failed:", err.message);
    console.log("[settings] Values ARE applied in-memory for this session (process.env updated).");
  }

  // Classify what needs restart
  const needsRestart = Object.keys(updates).filter(k => SESSION_RESTART_KEYS.has(k));

  return {
    success: true,
    updatedCount: Object.keys(updates).length,
    fileSaved,
    fileError,
    needsRestart: needsRestart.length > 0 ? needsRestart : null,
  };
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
router.post("/save", (req, res) => {
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

  // ── Auto-fill missing defaults: when saving any key from a section,
  // also write all missing keys from that section with their defaults.
  // This ensures .env gets the full config on first save even if user
  // only changed one field (the rest show defaults but aren't in .env yet).
  const envOnDisk = parseEnvFile();
  for (const section of SETTINGS_SCHEMA) {
    const sectionKeys = section.fields.map(f => f.key);
    const anySaved = sectionKeys.some(k => k in cleaned);
    if (anySaved) {
      for (const f of section.fields) {
        if (!(f.key in cleaned) && !(f.key in envOnDisk) && f.default !== undefined) {
          cleaned[f.key] = f.default;
        }
      }
    }
  }

  const result = updateEnvFile(cleaned);
  if (result.success) {
    console.log(`[settings] Updated ${result.updatedCount} values:`, Object.keys(cleaned).join(", "),
      result.fileSaved ? `(persisted to ${ENV_PATH})` : `(IN-MEMORY ONLY — .env write failed: ${result.fileError}, path: ${ENV_PATH})`);
  }
  res.json({ ...result, envPath: ENV_PATH });
});

// ── POST /settings/restart — Restart the server process ─────────────────────
router.post("/restart", (req, res) => {
  console.log("[settings] 🔄 Server restart requested from Settings UI");
  res.json({ success: true, message: "Restarting server..." });

  // Give time for response to be sent, then exit.
  // If running under nodemon, it auto-restarts. If running under systemd/pm2, they restart too.
  // If running bare `node`, process just exits (user will need to start manually).
  setTimeout(() => {
    console.log("[settings] 🔄 Exiting process for restart...");
    process.exit(0);
  }, 500);
});


// ── GET /settings — Settings page UI ────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";
  const envData    = parseEnvFile();

  // Build field HTML for each section
  function renderField(f) {
    const val = envData[f.key] ?? process.env[f.key] ?? f.default ?? "";
    const eff = f.effect || EFFECT.INSTANT;
    const effBadge = `<span class="effect-badge" style="--ec:${eff.color}" title="${eff.tip}"><span class="effect-icon">${eff.icon}</span>${eff.label}<span class="info-i">i</span></span>`;
    const descText = f.desc || "";
    const descHtml = descText ? `<div class="field-desc">${descText}</div>` : "";

    if (f.type === "toggle") {
      const checked = val === "true" || val === "1" ? "checked" : "";
      return `
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
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
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <select data-key="${f.key}" onchange="markDirty(this)">${opts}</select>
        </div>`;
    }

    if (f.type === "number") {
      return `
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
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
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <input type="date" data-key="${f.key}" value="${val}" onchange="markDirty(this)"/>
        </div>`;
    }

    if (f.type === "password") {
      return `
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <input type="password" data-key="${f.key}" value="${val}" onchange="markDirty(this)" oninput="markDirty(this)" style="flex:1;" placeholder="(empty = disabled)"/>
            <button type="button" onclick="togglePwdVis(this)" style="background:none;border:1px solid var(--border);border-radius:6px;padding:5px 8px;cursor:pointer;color:var(--muted);font-size:0.7rem;" title="Show/hide">👁</button>
          </div>
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

  const sectionsHtml = SETTINGS_SCHEMA.map(s => {
    const sectionId = s.section.replace(/\s+/g, "-").toLowerCase();
    return `
    <div class="settings-section" data-section="${sectionId}">
      <div class="section-title">${s.icon} ${s.section}</div>
      <div class="section-card">
        ${s.fields.map(renderField).join("")}
      </div>
    </div>`;
  }).join("");

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
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
    ${modalCSS()}

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

    /* ── Effect badge with (i) tooltip ───────────────────── */
    .effect-badge {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 0.58rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--ec, #4a6080);
      background: color-mix(in srgb, var(--ec, #4a6080) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--ec, #4a6080) 25%, transparent);
      padding: 2px 8px; border-radius: 4px; margin-left: 10px;
      vertical-align: middle; cursor: help; position: relative;
      white-space: nowrap;
    }
    .effect-icon { font-size: 0.65rem; }
    .info-i {
      display: inline-flex; align-items: center; justify-content: center;
      width: 14px; height: 14px; border-radius: 50%;
      background: color-mix(in srgb, var(--ec, #4a6080) 15%, transparent);
      font-size: 0.5rem; font-weight: 800; font-style: italic;
      margin-left: 2px;
    }
    .effect-badge:hover::after {
      content: attr(title); position: absolute; bottom: calc(100% + 6px); left: 50%;
      transform: translateX(-50%); white-space: nowrap;
      background: #1a2236; color: var(--text); border: 1px solid var(--border2);
      padding: 6px 12px; border-radius: 6px; font-size: 0.7rem; font-weight: 500;
      letter-spacing: 0; text-transform: none; z-index: 100;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4); pointer-events: none;
    }
    .effect-badge:hover::before {
      content: ''; position: absolute; bottom: calc(100% + 2px); left: 50%;
      transform: translateX(-50%);
      border: 5px solid transparent; border-top-color: #1a2236; z-index: 101;
    }

    /* ── Restart button ──────────────────────────────────── */
    .restart-section {
      margin-top: 8px; padding: 20px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; display: flex; align-items: center;
      justify-content: space-between; gap: 20px;
    }
    .restart-info { flex: 1; }
    .restart-title { font-size: 0.84rem; font-weight: 700; color: var(--text2); margin-bottom: 4px; }
    .restart-desc { font-size: 0.68rem; color: var(--muted); line-height: 1.5; }
    .btn-restart {
      background: rgba(239,68,68,0.08); color: var(--red); border: 1px solid #7f1d1d;
      padding: 10px 22px; border-radius: 8px; font-weight: 700; font-size: 0.82rem;
      cursor: pointer; font-family: inherit; white-space: nowrap; transition: all 0.15s;
      display: flex; align-items: center; gap: 6px;
    }
    .btn-restart:hover { background: rgba(239,68,68,0.15); border-color: var(--red); }
    .btn-restart:disabled { opacity: 0.4; cursor: not-allowed; }

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
        <div>
          Each setting shows when it takes effect — hover the badge for details.<br/>
          <span style="color:#10b981;">⚡ Instant</span> — active immediately &nbsp;
          <span style="color:#f59e0b;">🔄 Session restart</span> — stop & start session &nbsp;
          <span style="color:#3b82f6;">🔍 Next backtest</span> — on next run &nbsp;
          <span style="color:#ef4444;">🖥️ Server restart</span> — use button below
        </div>
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

      <!-- Restart Server -->
      <div class="settings-section">
        <div class="section-title">🔄 Server Control</div>
        <div class="restart-section">
          <div class="restart-info">
            <div class="restart-title">Restart Server</div>
            <div class="restart-desc">
              Restarts the Node.js process to apply all pending changes (Port, API keys, cached values).
              Active trading sessions will be stopped. The page will reload automatically.
            </div>
          </div>
          <button class="btn-restart" id="restartBtn" onclick="restartServer()">
            <span>🔄</span> Restart Server
          </button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
${modalJS()}
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

  // Toggle VIX Filter section visibility based on VIX toggle
  function updateVixSectionVisibility() {
    var vixToggle = document.querySelector('[data-key="VIX_FILTER_ENABLED"]');
    var vixSection = document.querySelector('[data-section="vix-filter"]');
    if (vixToggle && vixSection) {
      vixSection.style.display = vixToggle.checked ? '' : 'none';
    }
  }
  var vixToggleEl = document.querySelector('[data-key="VIX_FILTER_ENABLED"]');
  if (vixToggleEl) {
    vixToggleEl.addEventListener('change', updateVixSectionVisibility);
  }
  updateVixSectionVisibility();
})();

function togglePwdVis(btn) {
  var inp = btn.parentElement.querySelector('input');
  if (!inp) return;
  if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '🔒'; }
  else { inp.type = 'password'; btn.textContent = '👁'; }
}

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

  secretFetch('/settings/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: updates }),
  })
  .then(function(res) {
    if (!res) return null;
    return res.json();
  })
  .then(function(data) {
    if (!data) return;
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

      // Clear cached API secret if security settings changed
      if (updates.API_SECRET !== undefined) sessionStorage.removeItem('__api_secret');

      // Build message based on what was saved
      var msg = data.updatedCount + ' setting' + (data.updatedCount > 1 ? 's' : '') + ' applied';
      if (!data.fileSaved) {
        msg += ' ⚠️ NOT SAVED TO DISK — .env write failed: ' + (data.fileError || 'unknown') + '. Changes will be lost on restart!';
        showToast(msg, 'error');
      } else if (data.needsRestart && data.needsRestart.length > 0) {
        msg += '. Stop & restart session for: ' + data.needsRestart.join(', ');
        showToast(msg, 'info');
      } else {
        msg += ' — active now';
        showToast(msg, 'success');
      }
    } else {
      showToast('Save failed: ' + (data.error || 'unknown error'), 'error');
    }
  })
  .catch(function(err) {
    var msg = err.name === 'AbortError' ? 'Request timed out — check server' : err.message;
    showToast('Save failed: ' + msg, 'error');
  })
  .finally(function() {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  });
}

function addCustomVar(n) {
  var keyEl = document.getElementById('customKey' + n);
  var valEl = document.getElementById('customVal' + n);
  var key = keyEl.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
  var val = valEl.value.trim();

  if (!key) { showToast('Enter a valid key name', 'error'); keyEl.focus(); return; }
  if (!val) { showToast('Enter a value', 'error'); valEl.focus(); return; }

  secretFetch('/settings/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: { [key]: val } }),
  })
  .then(function(res) {
    if (!res) return null;
    return res.json();
  })
  .then(function(data) {
    if (!data) return;
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

async function restartServer() {
  var btn = document.getElementById('restartBtn');
  var ok = await showConfirm({
    icon: '🔄', title: 'Restart Server',
    message: 'This will restart the server and stop any active trading sessions.\\n\\nAre you sure?',
    confirmText: 'Restart', confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Restarting...';
  showToast('Restarting server — page will reload in 5 seconds...', 'info');

  secretFetch('/settings/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).catch(function() {}); // will fail when server dies — that's expected

  // Poll until server is back, then reload
  var attempts = 0;
  var poller = setInterval(function() {
    attempts++;
    if (attempts > 30) { // 30 seconds max
      clearInterval(poller);
      btn.disabled = false;
      btn.innerHTML = '<span>🔄</span> Restart Server';
      showToast('Server did not come back — check manually', 'error');
      return;
    }
    fetch('/settings/data', { method: 'GET' })
      .then(function(r) {
        if (r.ok) {
          clearInterval(poller);
          showToast('Server restarted successfully!', 'success');
          setTimeout(function() { window.location.reload(); }, 500);
        }
      })
      .catch(function() {}); // still down, keep polling
  }, 1000);
}

function showToast(msg, type) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type + ' show';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(function() {
    el.classList.remove('show');
  }, 4000);
}
</script>
</body>
</html>`);
});

module.exports = router;

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
    section: "TRADING STRATEGY (15-min) — Zerodha",
    icon: "📊",
    fields: [
      { key: "LIVE_TRADE_ENABLED", label: "Live Trade", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Zerodha" },
      { key: "TRADE_EXPIRY_DAY_ONLY", label: "Trade Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only allow entries on NIFTY weekly expiry day (Tuesday, or Monday if Tuesday is holiday)", default: "false" },
      { key: "TRADE_ENTRY_START", label: "Entry Start Time", type: "time", effect: EFFECT.SESSION, desc: "Earliest time for new trade entries (HH:MM IST)", default: "09:30" },
      { key: "TRADE_ENTRY_END", label: "Entry End Time", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (HH:MM IST)", default: "14:00" },
      { key: "OPTION_EXPIRY_OVERRIDE", label: "Option Expiry (manual)", type: "date", effect: EFFECT.INSTANT, desc: "Override auto-detected expiry. Leave blank for auto." },
      { key: "OPTION_EXPIRY_TYPE", label: "Expiry Type", type: "select", options: ["weekly", "monthly"], effect: EFFECT.INSTANT, desc: "Weekly = normal Tuesday expiry. Monthly = last Thursday/preponed monthly expiry", default: "weekly" },
      { key: "VIX_FILTER_ENABLED", label: "VIX Filter (Trading)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block Strategy 1 entries when VIX is high (independent from scalp)" },
      { key: "VIX_MAX_ENTRY", label: "VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Block ALL entries above this VIX" },
      { key: "VIX_STRONG_ONLY", label: "VIX Strong Only", type: "number", min: 8, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "Only STRONG signals above this VIX" },
      { key: "MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 50000, step: 500, effect: EFFECT.SESSION, desc: "Kill-switch: stop trading after this much loss" },
      { key: "MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Maximum entries per day" },
      { key: "MAX_SAR_DISTANCE", label: "Max SL Distance (pts)", type: "number", min: 40, max: 200, step: 5, effect: EFFECT.SESSION, desc: "Reject entries with SL > this (caps risk per trade)", default: "80" },
      { key: "BREAKEVEN_PTS", label: "Breakeven Stop (pts)", type: "number", min: 10, max: 50, step: 5, effect: EFFECT.SESSION, desc: "SL moves to entry after +N pts move", default: "25" },
      { key: "RSI_CE_MIN", label: "RSI CE Min (>)", type: "number", min: 45, max: 65, step: 1, effect: EFFECT.INSTANT, desc: "Bullish momentum: RSI must be above this for CE entry", default: "52" },
      { key: "RSI_PE_MAX", label: "RSI PE Max (<)", type: "number", min: 35, max: 55, step: 1, effect: EFFECT.INSTANT, desc: "Bearish momentum: RSI must be below this for PE entry", default: "48" },
      { key: "ADX_MIN_TREND", label: "ADX Min Trend", type: "number", min: 15, max: 35, step: 1, effect: EFFECT.INSTANT, desc: "Minimum ADX to confirm trend (below = ranging, block entry)", default: "25" },
      { key: "EMA_SLOPE_MIN", label: "EMA9 Slope Min (pts)", type: "number", min: 2, max: 15, step: 1, effect: EFFECT.INSTANT, desc: "Min EMA9 slope for entry (pts vs prev candle)", default: "6" },
      { key: "STRONG_SLOPE", label: "STRONG Slope (pts)", type: "number", min: 6, max: 20, step: 1, effect: EFFECT.INSTANT, desc: "EMA9 slope >= this for STRONG signal (intra-candle entry)", default: "9" },
      { key: "STRONG_RSI_CE", label: "STRONG RSI CE (>)", type: "number", min: 50, max: 70, step: 1, effect: EFFECT.INSTANT, desc: "RSI must be above this for STRONG CE signal", default: "58" },
      { key: "STRONG_RSI_PE", label: "STRONG RSI PE (<)", type: "number", min: 30, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "RSI must be below this for STRONG PE signal", default: "40" },
      { key: "MIN_SAR_DISTANCE", label: "Min SL Distance (pts)", type: "number", min: 10, max: 80, step: 5, effect: EFFECT.INSTANT, desc: "Reject entries with SL closer than this (too tight = noise)", default: "45" },
      { key: "MIN_CANDLE_BODY", label: "Min Candle Body (pts)", type: "number", min: 3, max: 25, step: 1, effect: EFFECT.INSTANT, desc: "Min candle body size for valid entry (filters dojis)", default: "10" },
      { key: "LOGIC3_RSI_MAX", label: "Logic3 RSI Max (<)", type: "number", min: 35, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "PE override when SAR still bull: RSI must be below this", default: "42" },
      { key: "LOGIC3_SAR_GAP", label: "Logic3 SAR Gap (pts)", type: "number", min: 20, max: 150, step: 5, effect: EFFECT.INSTANT, desc: "PE override: SAR must be this many pts below price (lagging)", default: "50" },
      { key: "TRAIL_ACTIVATE_PTS", label: "Trail Activate (pts)", type: "number", min: 5, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Min profit before trail starts", default: "12" },
      { key: "TRAIL_TIER1_UPTO", label: "T1 Upto (pts)", type: "number", min: 10, max: 100, step: 5, effect: EFFECT.SESSION, desc: "0 to N pts profit → T1 gap", default: "30" },
      { key: "TRAIL_TIER1_GAP", label: "T1 Gap (pts)", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Trail gap during T1 (widest)", default: "40" },
      { key: "TRAIL_TIER2_UPTO", label: "T2 Upto (pts)", type: "number", min: 20, max: 200, step: 5, effect: EFFECT.SESSION, desc: "T1 to N pts profit → T2 gap", default: "55" },
      { key: "TRAIL_TIER2_GAP", label: "T2 Gap (pts)", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Trail gap during T2 (tightening)", default: "25" },
      { key: "TRAIL_TIER3_GAP", label: "T3 Gap (pts)", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Trail gap above T2 (tightest)", default: "15" },
      { key: "OPT_STOP_PCT", label: "Option Stop %", type: "number", min: 0.05, max: 0.50, step: 0.05, effect: EFFECT.SESSION, desc: "Fallback stop-loss as % of option premium" },
    ],
  },
  {
    section: "SCALPING STRATEGY (BB+CPR) — Fyers",
    icon: "⚡",
    fields: [
      { key: "SCALP_MODE_ENABLED", label: "Scalp Mode", type: "toggle", effect: EFFECT.INSTANT, desc: "Show/hide scalp menus", default: "true" },
      { key: "SCALP_ENABLED", label: "Scalp Live Orders", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live scalp orders via Fyers", default: "false" },
      { key: "SCALP_EXPIRY_DAY_ONLY", label: "Scalp Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only allow scalp entries on NIFTY weekly expiry day (Tuesday, or Monday if Tuesday is holiday)", default: "false" },
      { key: "SCALP_VIX_ENABLED", label: "VIX Filter (Scalp)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block scalp entries when VIX is high (independent from trading)", default: "false" },
      { key: "SCALP_ENTRY_START", label: "Entry Start Time", type: "time", effect: EFFECT.SESSION, desc: "Earliest time for new scalp entries (HH:MM IST)", default: "09:21" },
      { key: "SCALP_ENTRY_END", label: "Entry End Time", type: "time", effect: EFFECT.SESSION, desc: "No new scalp entries after this time (HH:MM IST)", default: "14:30" },
      { key: "SCALP_RESOLUTION", label: "Candle (min)", type: "select", options: ["3", "5"], effect: EFFECT.SESSION, desc: "Scalp candle resolution (3 or 5 min only)", default: "3" },
      // ── Bollinger Bands ──
      { key: "SCALP_BB_PERIOD", label: "BB Period", type: "number", min: 10, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Bollinger Band SMA period", default: "20" },
      { key: "SCALP_BB_STDDEV", label: "BB Std Dev", type: "number", min: 0.5, max: 3.0, step: 0.1, effect: EFFECT.SESSION, desc: "Bollinger Band standard deviation", default: "1" },
      // ── RSI ──
      { key: "SCALP_RSI_PERIOD", label: "RSI Period", type: "number", min: 7, max: 21, step: 1, effect: EFFECT.SESSION, desc: "RSI calculation period", default: "14" },
      { key: "SCALP_RSI_CE_THRESHOLD", label: "RSI CE (>)", type: "number", min: 50, max: 80, step: 1, effect: EFFECT.SESSION, desc: "RSI above this for CE entry", default: "55" },
      { key: "SCALP_RSI_PE_THRESHOLD", label: "RSI PE (<)", type: "number", min: 20, max: 50, step: 1, effect: EFFECT.SESSION, desc: "RSI below this for PE entry", default: "45" },
      // ── Parabolic SAR (initial SL + trailing) ──
      { key: "SCALP_PSAR_STEP", label: "PSAR Step", type: "number", min: 0.01, max: 0.05, step: 0.005, effect: EFFECT.SESSION, desc: "PSAR acceleration step", default: "0.02" },
      { key: "SCALP_PSAR_MAX", label: "PSAR Max", type: "number", min: 0.1, max: 0.3, step: 0.01, effect: EFFECT.SESSION, desc: "PSAR max acceleration", default: "0.2" },
      // ── Trail profit (₹ PNL levels) ──
      { key: "SCALP_TRAIL_START", label: "Trail Start (₹)", type: "number", min: 100, max: 2000, step: 50, effect: EFFECT.SESSION, desc: "Lock profit at this level (300,500,700...)", default: "300" },
      { key: "SCALP_TRAIL_STEP", label: "Trail Step (₹)", type: "number", min: 100, max: 500, step: 50, effect: EFFECT.SESSION, desc: "Step between trail levels", default: "200" },
      // ── Risk management ──
      { key: "SCALP_MAX_SL_PTS", label: "Max SL (pts)", type: "number", min: 10, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Reject scalp entries with SL > this many pts", default: "50" },
      { key: "SCALP_CPR_NARROW_PCT", label: "CPR Narrow %", type: "number", min: 10, max: 80, step: 5, effect: EFFECT.SESSION, desc: "CPR range % threshold for narrow CPR filter", default: "33" },
      { key: "SCALP_MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Max scalp entries per day", default: "30" },
      { key: "SCALP_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 20000, step: 500, effect: EFFECT.SESSION, desc: "Scalp kill-switch", default: "2000" },
      { key: "SCALP_SL_PAUSE_CANDLES", label: "SL Pause (candles)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Pause after SL hit", default: "2" },
    ],
  },
  {
    section: "COMMON — Instrument & Backtest",
    icon: "📈",
    fields: [
      { key: "TRADE_RESOLUTION", label: "Candle Resolution (min)", type: "select", options: ["5", "15"], effect: EFFECT.SESSION, desc: "Trading candle timeframe (5-min or 15-min)", default: "15" },
      { key: "TRADE_START_TIME", label: "Market Start Time", type: "time", effect: EFFECT.SESSION, desc: "Market open time — execution gate start (HH:MM IST)", default: "09:15" },
      { key: "TRADE_STOP_TIME", label: "Market Stop Time", type: "time", effect: EFFECT.SESSION, desc: "Auto-stop time — EOD square off + engine shutdown (HH:MM IST)", default: "15:30" },
      { key: "INSTRUMENT", label: "Trade Type", type: "select", options: ["NIFTY_OPTIONS", "NIFTY_FUTURES"], effect: EFFECT.INSTANT, desc: "Options (CE/PE) or Futures" },
      { key: "NIFTY_LOT_SIZE", label: "Lot Size (Qty)", type: "number", min: 1, max: 200, step: 1, effect: EFFECT.INSTANT, desc: "Qty per lot (currently 65)" },
      { key: "LOT_MULTIPLIER", label: "Lot Multiplier", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "Number of lots per trade" },
      { key: "STRIKE_OFFSET_CE", label: "CE Strike Offset", type: "number", min: -200, max: 200, step: 50, effect: EFFECT.INSTANT, desc: "-50=ITM, 0=ATM, +50=OTM", default: "0" },
      { key: "STRIKE_OFFSET_PE", label: "PE Strike Offset", type: "number", min: -200, max: 200, step: 50, effect: EFFECT.INSTANT, desc: "+50=ITM, 0=ATM, -50=OTM", default: "0" },
      { key: "BACKTEST_OPTION_SIM", label: "Option Simulation", type: "toggle", effect: EFFECT.BACKTEST, desc: "Simulate option P&L with delta/theta" },
      { key: "BACKTEST_DELTA", label: "Delta", type: "number", min: 0.1, max: 1.0, step: 0.05, effect: EFFECT.BACKTEST, desc: "Option delta for premium simulation" },
      { key: "BACKTEST_THETA_DAY", label: "Theta ₹/day", type: "number", min: 0, max: 50, step: 1, effect: EFFECT.BACKTEST, desc: "Daily theta decay in rupees" },
      { key: "NIFTY_SPOT_FALLBACK", label: "NIFTY Spot Fallback", type: "number", min: 15000, max: 35000, step: 50, effect: EFFECT.INSTANT, desc: "Fallback NIFTY spot price when live quote unavailable", default: "24000" },
      { key: "PAPER_TRADE_CAPITAL", label: "Paper Capital (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.INSTANT },
      { key: "SCALP_PAPER_CAPITAL", label: "Scalp Paper Capital (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.INSTANT, desc: "Starting capital for scalp paper trading", default: "100000" },
      { key: "BACKTEST_CAPITAL", label: "Backtest Capital (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.BACKTEST },
    ],
  },
  {
    section: "COMMON — Server & Broker",
    icon: "🖥️",
    fields: [
      { key: "PORT", label: "Port", type: "number", min: 1000, max: 65535, step: 1, effect: EFFECT.SERVER },
      { key: "EC2_IP", label: "EC2 IP", type: "text", effect: EFFECT.SERVER },
      { key: "CACHE_MAX_DAYS", label: "Candle Cache (days)", type: "number", min: 15, max: 180, step: 15, effect: EFFECT.INSTANT, desc: "Trim cached candles older than this many days", default: "60" },
      { key: "APP_ID", label: "Fyers App ID", type: "text", effect: EFFECT.SERVER },
      { key: "REDIRECT_URL", label: "Fyers Redirect URL", type: "text", effect: EFFECT.SERVER },
      { key: "ZERODHA_API_KEY", label: "Zerodha API Key", type: "text", effect: EFFECT.SERVER },
      { key: "ZERODHA_REDIRECT_URL", label: "Zerodha Redirect URL", type: "text", effect: EFFECT.SERVER },
    ],
  },
  {
    section: "COMMON — Telegram",
    icon: "📱",
    fields: [
      { key: "TELEGRAM_CHAT_ID", label: "Chat ID", type: "text", effect: EFFECT.INSTANT, desc: "Leave blank to disable notifications" },
      { key: "TG_TRADE_ENTRY", label: "Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Send notification when a 15-min strategy trade is entered", default: "true" },
      { key: "TG_TRADE_EXIT", label: "Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Send notification when a 15-min strategy trade is exited", default: "true" },
      { key: "TG_TRADE_SIGNALS", label: "Trade Signals (Skip)", type: "toggle", effect: EFFECT.INSTANT, desc: "Send candle-close signal updates when flat (why trade was/wasn't taken)", default: "true" },
      { key: "TG_SCALP_ENTRY", label: "Scalp Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Send notification when a scalp trade is entered", default: "true" },
      { key: "TG_SCALP_EXIT", label: "Scalp Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Send notification when a scalp trade is exited", default: "true" },
    ],
  },
  {
    section: "CHARGES & STT — Trading Costs",
    icon: "💰",
    fields: [
      { key: "STT_OPT_SELL_PCT",       label: "Options STT (%)",      type: "number", min: 0, max: 1,  step: 0.01,  effect: EFFECT.INSTANT, desc: "STT on option sell side (% of premium turnover). Apr 2026: 0.15%", default: "0.15" },
      { key: "STT_FUT_SELL_PCT",       label: "Futures STT (%)",      type: "number", min: 0, max: 1,  step: 0.01,  effect: EFFECT.INSTANT, desc: "STT on futures sell side (% of turnover). Apr 2026: 0.05%", default: "0.05" },
      { key: "EXCHANGE_TXN_OPT_PCT",   label: "Exchange Txn Opt (%)",  type: "number", min: 0, max: 0.5,  step: 0.005, effect: EFFECT.INSTANT, desc: "NSE exchange txn charges for options (% of turnover)", default: "0.05" },
      { key: "EXCHANGE_TXN_FUT_PCT",   label: "Exchange Txn Fut (%)",  type: "number", min: 0, max: 0.1,  step: 0.001, effect: EFFECT.INSTANT, desc: "NSE exchange txn charges for futures (% of turnover)", default: "0.002" },
      { key: "SEBI_CHARGES_PER_CRORE", label: "SEBI Charges (₹/Cr)",  type: "number", min: 0, max: 100, step: 1,     effect: EFFECT.INSTANT, desc: "SEBI turnover fee in ₹ per crore", default: "10" },
      { key: "GST_PCT",               label: "GST (%)",               type: "number", min: 0, max: 30,  step: 1,     effect: EFFECT.INSTANT, desc: "GST on brokerage + exchange charges", default: "18" },
      { key: "STAMP_DUTY_PCT",        label: "Stamp Duty (%)",        type: "number", min: 0, max: 0.1, step: 0.001, effect: EFFECT.INSTANT, desc: "Stamp duty on buy-side turnover", default: "0.003" },
      { key: "BROKER_FLAT_PER_ORDER",  label: "Broker Fee (₹/order)", type: "number", min: 0, max: 100, step: 5,     effect: EFFECT.INSTANT, desc: "Flat brokerage per executed order (×2 for buy+sell)", default: "20" },
    ],
  },
  {
    section: "Security",
    icon: "🔒",
    fields: [
      { key: "API_SECRET", label: "App Secret", type: "password", effect: EFFECT.INSTANT, desc: "Protects action routes (start/stop/exit) & settings page. Leave blank to disable" },
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
  "LIVE_TRADE_ENABLED", "TRADE_EXPIRY_DAY_ONLY", "VIX_FILTER_ENABLED", "VIX_MAX_ENTRY", "VIX_STRONG_ONLY",
  "INSTRUMENT", "NIFTY_LOT_SIZE", "STRIKE_OFFSET_CE", "STRIKE_OFFSET_PE", "LOT_MULTIPLIER",
  "OPTION_EXPIRY_OVERRIDE", "OPTION_EXPIRY_TYPE",
  "BACKTEST_FROM", "BACKTEST_TO", "BACKTEST_CAPITAL", "BACKTEST_OPTION_SIM",
  "BACKTEST_DELTA", "BACKTEST_THETA_DAY", "PAPER_TRADE_CAPITAL",
  "TELEGRAM_CHAT_ID", "TELEGRAM_BOT_TOKEN",
  "TG_TRADE_ENTRY", "TG_TRADE_EXIT", "TG_TRADE_SIGNALS",
  "TG_SCALP_ENTRY", "TG_SCALP_EXIT",
  "NIFTY_SPOT_FALLBACK", "SCALP_PAPER_CAPITAL", "CACHE_MAX_DAYS",
  "SCALP_ENABLED", "SCALP_MODE_ENABLED", "SCALP_VIX_ENABLED", "SCALP_EXPIRY_DAY_ONLY",
  "API_SECRET", "LOGIN_SECRET",
  // Strategy thresholds — read from process.env inside getSignal() on every candle
  "RSI_CE_MIN", "RSI_PE_MAX", "ADX_MIN_TREND", "EMA_SLOPE_MIN",
  "STRONG_SLOPE", "STRONG_RSI_CE", "STRONG_RSI_PE",
  "MIN_SAR_DISTANCE", "MIN_CANDLE_BODY",
  "LOGIC3_RSI_MAX", "LOGIC3_SAR_GAP",
]);

// These are cached as const at module load — need session stop+start
const SESSION_RESTART_KEYS = new Set([
  "MAX_DAILY_LOSS", "MAX_DAILY_TRADES", "OPT_STOP_PCT", "MAX_SAR_DISTANCE", "BREAKEVEN_PTS",
  "TRAIL_ACTIVATE_PTS", "TRAIL_TIER1_UPTO", "TRAIL_TIER1_GAP",
  "TRAIL_TIER2_UPTO", "TRAIL_TIER2_GAP", "TRAIL_TIER3_GAP",
  "TRADE_RESOLUTION", "TRADE_START_TIME", "TRADE_STOP_TIME",
  "TRADE_ENTRY_START", "TRADE_ENTRY_END",
  "SCALP_ENTRY_START", "SCALP_ENTRY_END",
  // Scalp settings — need session restart
  "SCALP_RESOLUTION",
  "SCALP_BB_PERIOD", "SCALP_BB_STDDEV",
  "SCALP_RSI_PERIOD", "SCALP_RSI_CE_THRESHOLD", "SCALP_RSI_PE_THRESHOLD",
  "SCALP_PSAR_STEP", "SCALP_PSAR_MAX",
  "SCALP_TRAIL_START", "SCALP_TRAIL_STEP",
  "SCALP_MAX_DAILY_TRADES", "SCALP_MAX_DAILY_LOSS", "SCALP_SL_PAUSE_CANDLES",
  "SCALP_MAX_SL_PTS", "SCALP_CPR_NARROW_PCT",
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
  // App Secret gate — if API_SECRET is set, require it to access settings
  const appSecret = process.env.API_SECRET;
  if (appSecret && req.query.secret !== appSecret) {
    const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";
    return res.send(`<!DOCTYPE html><html><head><title>Settings - Auth</title>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'IBM Plex Mono',monospace;background:#040c18;color:#c8d8f0;display:flex;min-height:100vh;}
      ${sidebarCSS()}
      .auth-box{margin:auto;padding:40px;background:#07111f;border:1px solid #0e1e36;border-radius:12px;text-align:center;max-width:400px;width:90%;}
      .auth-box h2{font-size:1rem;color:#60a5fa;margin-bottom:8px;}
      .auth-box p{font-size:0.72rem;color:#4a6080;margin-bottom:20px;}
      .auth-box input{width:100%;padding:10px 14px;background:#0a1528;border:1px solid #1e3a5a;border-radius:8px;color:#c8d8f0;font-family:inherit;font-size:0.85rem;text-align:center;margin-bottom:12px;}
      .auth-box input:focus{outline:none;border-color:#3b82f6;}
      .auth-box button{padding:10px 30px;background:#1e40af;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-family:inherit;font-size:0.82rem;}
      .auth-box button:hover{background:#2563eb;}
      .auth-err{color:#ef4444;font-size:0.72rem;margin-top:8px;display:none;}
      </style></head><body>
      <div class="app-shell">
      ${buildSidebar('settings', liveActive)}
      <div class="main-content" style="display:flex;align-items:center;justify-content:center;">
      <div class="auth-box">
        <h2>\uD83D\uDD12 App Secret Required</h2>
        <p>Enter your app secret to access settings</p>
        <form onsubmit="go(event)">
          <input type="password" id="secretInput" placeholder="Enter app secret..." autofocus/>
          <button type="submit">Unlock Settings</button>
        </form>
        <div class="auth-err" id="authErr">Invalid secret. Try again.</div>
      </div>
      </div></div>
      <script>
      function go(e){e.preventDefault();var s=document.getElementById('secretInput').value;if(!s)return;window.location='/settings?secret='+encodeURIComponent(s);}
      ${req.query.secret ? "document.getElementById('authErr').style.display='block';" : ""}
      </script></body></html>`);
  }

  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";
  const envData    = parseEnvFile();

  // ── Determine which fields should be frozen (disabled but values kept) ──
  const vixEnabled  = (envData["VIX_FILTER_ENABLED"] ?? process.env.VIX_FILTER_ENABLED ?? "true") === "true";
  const scalpModeOn = (envData["SCALP_MODE_ENABLED"] ?? process.env.SCALP_MODE_ENABLED ?? "true").toLowerCase() === "true";

  function isFieldFrozen(key) {
    // VIX params frozen when VIX filter is off
    if ((key === "VIX_MAX_ENTRY" || key === "VIX_STRONG_ONLY") && !vixEnabled) return true;
    // Scalp section frozen when scalp mode is off (but not the master toggle itself)
    if (key.startsWith("SCALP_") && key !== "SCALP_MODE_ENABLED" && !scalpModeOn) return true;
    return false;
  }

  // Build field HTML for each section
  function renderField(f) {
    const val = envData[f.key] ?? process.env[f.key] ?? f.default ?? "";
    const eff = f.effect || EFFECT.INSTANT;
    const effBadge = `<span class="effect-badge" style="--ec:${eff.color}" title="${eff.tip}"><span class="effect-icon">${eff.icon}</span>${eff.label}<span class="info-i">i</span></span>`;
    const descText = f.desc || "";
    const descHtml = descText ? `<div class="field-desc">${descText}</div>` : "";
    const frozen = isFieldFrozen(f.key);
    const dis = frozen ? "disabled" : "";
    const frozenGroup = f.key.startsWith("SCALP_") ? "scalp" : (f.key.startsWith("VIX_") ? "vix" : "");
    const frozenAttr = frozenGroup ? `data-freeze-group="${frozenGroup}"` : "";
    const rowClass = frozen ? "setting-row frozen" : "setting-row";

    if (f.type === "toggle") {
      const checked = val === "true" || val === "1" ? "checked" : "";
      return `
        <div class="${rowClass}" ${frozenAttr}>
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <label class="toggle-switch">
            <input type="checkbox" data-key="${f.key}" ${checked} ${dis} onchange="markDirty(this)"/>
            <span class="toggle-slider"></span>
          </label>
        </div>`;
    }

    if (f.type === "select") {
      const opts = f.options.map(o =>
        `<option value="${o}" ${o === val ? "selected" : ""}>${o}</option>`
      ).join("");
      const expiryEyeBtn = f.key === "OPTION_EXPIRY_TYPE"
        ? `<button type="button" onclick="showExpiryModal()" class="holiday-eye-btn" title="View NIFTY Expiry Calendar">👁</button>`
        : "";
      return `
        <div class="${rowClass}" ${frozenAttr}>
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <select data-key="${f.key}" ${dis} onchange="markDirty(this)" style="flex:1;">${opts}</select>
            ${expiryEyeBtn}
          </div>
        </div>`;
    }

    if (f.type === "number") {
      return `
        <div class="${rowClass}" ${frozenAttr}>
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <input type="number" data-key="${f.key}" value="${val}"
            ${f.min != null ? `min="${f.min}"` : ""} ${f.max != null ? `max="${f.max}"` : ""}
            ${f.step != null ? `step="${f.step}"` : ""}
            ${dis} onchange="markDirty(this)" oninput="markDirty(this)"/>
        </div>`;
    }

    if (f.type === "date") {
      const eyeBtn = f.key === "OPTION_EXPIRY_OVERRIDE"
        ? `<button type="button" onclick="showHolidayModal()" class="holiday-eye-btn" title="View NSE Holiday List">👁</button>`
        : "";
      return `
        <div class="${rowClass}" ${frozenAttr}>
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <input type="date" data-key="${f.key}" value="${val}" ${dis} onchange="markDirty(this)" style="flex:1;"/>
            ${eyeBtn}
          </div>
        </div>`;
    }

    if (f.type === "time") {
      return `
        <div class="${rowClass}" ${frozenAttr}>
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <input type="time" data-key="${f.key}" value="${val}" ${dis} onchange="markDirty(this)" style="width:120px;"/>
        </div>`;
    }

    if (f.type === "password") {
      return `
        <div class="${rowClass}" ${frozenAttr}>
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <input type="password" data-key="${f.key}" value="${val}" ${dis} onchange="markDirty(this)" oninput="markDirty(this)" style="flex:1;" placeholder="(empty = disabled)"/>
            <button type="button" onclick="togglePwdVis(this)" style="background:none;border:1px solid var(--border);border-radius:6px;padding:5px 8px;cursor:pointer;color:var(--muted);font-size:0.7rem;" title="Show/hide">👁</button>
          </div>
        </div>`;
    }

    // text
    return `
      <div class="${rowClass}" ${frozenAttr}>
        <div class="setting-info">
          <div class="setting-label">${f.label}</div>
          ${descHtml}
        </div>
        <input type="text" data-key="${f.key}" value="${val}" ${dis} onchange="markDirty(this)"/>
      </div>`;
  }

  // Build section summary data for the eye icon modals
  const sectionSummaries = {};
  SETTINGS_SCHEMA.forEach((s, idx) => {
    const rows = s.fields.map(f => {
      const val = envData[f.key] ?? process.env[f.key] ?? f.default ?? "";
      return { key: f.key, label: f.label, value: val, type: f.type };
    });
    sectionSummaries[idx] = rows;
  });

  const sectionsHtml = SETTINGS_SCHEMA.map((s, idx) => {
    const sectionId = s.section.replace(/\s+/g, "-").toLowerCase();
    // Add eye icon for Trading Strategy and Scalping Strategy sections
    const showEye = idx === 0 || idx === 1;
    const eyeBtn = showEye
      ? `<button type="button" class="section-eye-btn" onclick="showSectionSummary(${idx})" title="View all configured values">👁</button>`
      : "";
    return `
    <div class="settings-section" data-section="${sectionId}">
      <div class="section-title">${s.icon} ${s.section}${eyeBtn}</div>
      <div class="section-card">
        ${s.fields.map(renderField).join("")}
      </div>
    </div>`;
  }).join("");

  const sectionSummaryJSON = JSON.stringify(sectionSummaries);

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
    input[type="text"], input[type="number"], input[type="date"], input[type="time"], select {
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

    /* ── Frozen (disabled) rows ──────────────────────────── */
    .setting-row.frozen { opacity: 0.4; pointer-events: none; }
    .setting-row.frozen input,
    .setting-row.frozen select { cursor: not-allowed; }
    .setting-row.frozen .toggle-slider { cursor: not-allowed; }

    /* ── Holiday eye button ────────────────────────────────── */
    /* ── Section eye button ──────────────────────────────── */
    .section-eye-btn {
      background: none; border: 1px solid var(--border); border-radius: 6px;
      padding: 3px 8px; cursor: pointer; color: var(--muted); font-size: 0.7rem;
      transition: all 0.15s; flex-shrink: 0; margin-left: 8px;
    }
    .section-eye-btn:hover { border-color: var(--accent); color: var(--accent); }

    /* ── Section summary modal ──────────────────────────── */
    .summary-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; font-family: 'JetBrains Mono', monospace; }
    .summary-table th {
      text-align: left; padding: 8px 12px; font-size: 0.65rem; text-transform: uppercase;
      letter-spacing: 1px; color: var(--muted); border-bottom: 1px solid var(--border);
    }
    .summary-table td { padding: 6px 12px; border-bottom: 1px solid var(--border); }
    .summary-table tr:last-child td { border-bottom: none; }
    .summary-table tr:hover td { background: rgba(59,130,246,0.06); }
    .summary-table .val-true { color: #10b981; font-weight: 600; }
    .summary-table .val-false { color: #ef4444; font-weight: 600; }
    .summary-table .val-num { color: #60a5fa; }
    .summary-table .val-text { color: #a3b8d0; }
    .summary-label { color: #8aa1bd; font-size: 0.75rem; }
    .summary-key { color: #4a6080; font-size: 0.65rem; }

    .holiday-eye-btn {
      background: none; border: 1px solid var(--border); border-radius: 6px;
      padding: 5px 8px; cursor: pointer; color: var(--muted); font-size: 0.75rem;
      transition: all 0.15s; flex-shrink: 0;
    }
    .holiday-eye-btn:hover { border-color: var(--accent); color: var(--accent); }

    /* ── Holiday modal table ─────────────────────────────── */
    .holiday-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    .holiday-table th {
      text-align: left; padding: 8px 10px; font-size: 0.65rem; text-transform: uppercase;
      letter-spacing: 1px; color: var(--muted); border-bottom: 1px solid var(--border);
    }
    .holiday-table td {
      padding: 7px 10px; border-bottom: 1px solid var(--border); color: var(--text);
    }
    .holiday-table tr:last-child td { border-bottom: none; }
    .holiday-table tr:hover td { background: rgba(59,130,246,0.06); }
    .holiday-table .past-holiday { opacity: 0.4; }
    .holiday-table .today-holiday { color: var(--green); font-weight: 600; }
    .holiday-table .preponed { color: #f59e0b; }
    .holiday-table .monthly-row td { background: rgba(59,130,246,0.08); }
    .expiry-legend { display:flex; gap:16px; padding:10px 0 4px; font-size:0.68rem; color:var(--muted); flex-wrap:wrap; }
    .expiry-legend span { display:flex; align-items:center; gap:4px; }
    .expiry-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
    .holiday-modal-body {
      max-height: 420px; overflow-y: auto; margin-top: 10px;
      scrollbar-width: thin; scrollbar-color: var(--border2) transparent;
    }

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
      input[type="text"], input[type="number"], input[type="date"], input[type="time"], select { min-width: 120px; max-width: 100%; width: 100%; }
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
      <button onclick="showEnvModal()" style="margin-left:auto;padding:6px 14px;background:rgba(59,130,246,0.12);color:#60a5fa;border:1px solid rgba(59,130,246,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;">VIEW .env</button>
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

function toggleFreezeGroup(group, freeze) {
  document.querySelectorAll('[data-freeze-group="' + group + '"]').forEach(function(row) {
    if (freeze) {
      row.classList.add('frozen');
    } else {
      row.classList.remove('frozen');
    }
    row.querySelectorAll('input, select').forEach(function(inp) {
      inp.disabled = freeze;
    });
  });
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
  // Freeze/unfreeze dependent fields when parent toggle changes
  if (key === 'VIX_FILTER_ENABLED') toggleFreezeGroup('vix', !el.checked);
  if (key === 'SCALP_MODE_ENABLED') toggleFreezeGroup('scalp', !el.checked);
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
  // Restore freeze state from original toggle values
  var vixOrig = window._originals['VIX_FILTER_ENABLED'];
  var scalpOrig = window._originals['SCALP_MODE_ENABLED'];
  toggleFreezeGroup('vix', vixOrig !== true && vixOrig !== 'true');
  toggleFreezeGroup('scalp', scalpOrig !== true && scalpOrig !== 'true');
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

// ── .env viewer ─────────────────────────────────────────────────────────
var _envData={};
function showEnvModal(){
  document.getElementById('envModal').style.display='block';
  fetch('/settings/env').then(function(r){return r.json()}).then(function(data){
    _envData=data;
    var keys=Object.keys(data).sort();
    var html='<table style="width:100%;border-collapse:collapse;font-size:0.78rem;font-family:IBM Plex Mono,monospace;">';
    html+='<tr style="border-bottom:1px solid #1a2640;"><th style="text-align:left;padding:8px 10px;color:#60a5fa;font-weight:700;">Key</th><th style="text-align:left;padding:8px 10px;color:#60a5fa;font-weight:700;">Value</th></tr>';
    for(var i=0;i<keys.length;i++){
      var k=keys[i];var v=data[k];
      var isSecret=k.indexOf('SECRET')>=0||k.indexOf('TOKEN')>=0||k.indexOf('ACCESS')>=0;
      var display=isSecret?'********':v;
      var bg=i%2===0?'transparent':'rgba(255,255,255,0.02)';
      var valColor=v==='true'?'#10b981':v==='false'?'#ef4444':'#a3b8d0';
      html+='<tr style="border-bottom:1px solid #0e1428;background:'+bg+'"><td style="padding:6px 10px;color:#8aa1bd;white-space:nowrap;">'+k+'</td><td style="padding:6px 10px;color:'+valColor+';word-break:break-all;">'+display+'</td></tr>';
    }
    html+='</table>';
    html+='<div style="margin-top:12px;color:#4a6080;font-size:0.7rem;">'+keys.length+' keys | Sensitive values hidden</div>';
    document.getElementById('envTableWrap').innerHTML=html;
  });
}
function copyEnvTable(){
  var keys=Object.keys(_envData).sort();
  var txt='';
  for(var i=0;i<keys.length;i++){
    var k=keys[i];var v=_envData[k];
    var isSecret=k.indexOf('SECRET')>=0||k.indexOf('TOKEN')>=0||k.indexOf('ACCESS')>=0;
    txt+=k+'='+( isSecret?'********':v)+'\\n';
  }
  navigator.clipboard.writeText(txt).then(function(){
    var btn=document.getElementById('envCopyBtn');
    btn.textContent='COPIED!';btn.style.color='#fff';btn.style.background='#10b981';
    setTimeout(function(){btn.textContent='COPY';btn.style.color='#10b981';btn.style.background='rgba(16,185,129,0.12)';},1500);
  });
}

// ── NSE Holiday List Modal ──────────────────────────────────────────────────
var _holidayNames = {
  '01-15': 'Municipal Corp. Election – Maharashtra', '01-26': 'Republic Day',
  '03-03': 'Holi', '03-26': 'Shri Ram Navami', '03-31': 'Shri Mahavir Jayanti',
  '04-03': 'Good Friday', '04-14': 'Dr. Ambedkar Jayanti',
  '05-01': 'Maharashtra Day', '05-28': 'Bakri Id', '06-26': 'Muharram',
  '09-14': 'Ganesh Chaturthi', '10-02': 'Mahatma Gandhi Jayanti',
  '10-20': 'Dussehra', '11-10': 'Diwali – Balipratipada',
  '11-24': 'Prakash Gurpurb Sri Guru Nanak Dev', '12-25': 'Christmas'
};

async function showHolidayModal() {
  var modal = document.getElementById('holidayModal');
  var body = document.getElementById('holidayTableBody');
  if (!modal || !body) return;
  body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px;">Loading holidays...</td></tr>';
  modal.style.display = 'block';
  try {
    var res = await fetch('/api/holidays', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!data.success || !data.holidays || !data.holidays.length) {
      body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px;">No holidays found</td></tr>';
      return;
    }
    var todayStr = new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"})).toISOString().split('T')[0];
    var rows = '';
    data.holidays.sort().forEach(function(d, i) {
      var mmdd = d.slice(5);
      var name = _holidayNames[mmdd] || '—';
      var dt = new Date(d + 'T00:00:00');
      var dayName = dt.toLocaleDateString('en-US', {weekday:'short'});
      var display = dt.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
      var cls = d < todayStr ? 'past-holiday' : (d === todayStr ? 'today-holiday' : '');
      rows += '<tr class="' + cls + '"><td>' + (i+1) + '</td><td>' + display + '</td><td>' + dayName + '</td><td>' + name + '</td></tr>';
    });
    body.innerHTML = rows;
  } catch(e) {
    body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#ef4444;padding:20px;">Failed to load holidays</td></tr>';
  }
}

// ── NIFTY Expiry Calendar Modal ─────────────────────────────────────────────
async function showExpiryModal() {
  var modal = document.getElementById('expiryModal');
  var body = document.getElementById('expiryTableBody');
  if (!modal || !body) return;
  body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px;">Loading expiry dates...</td></tr>';
  modal.style.display = 'block';
  try {
    var res = await fetch('/api/expiry-dates', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!data.success || !data.expiries || !data.expiries.length) {
      body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px;">No expiry dates found</td></tr>';
      return;
    }
    document.getElementById('expiryYearTitle').textContent = 'NIFTY Options Expiry Calendar ' + data.year;
    var todayStr = new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"})).toISOString().split('T')[0];
    var rows = '';
    data.expiries.forEach(function(e, i) {
      var dt = new Date(e.date + 'T00:00:00');
      var display = dt.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
      var dayName = dt.toLocaleDateString('en-US', {weekday:'short'});
      var type = e.monthly ? '<span style="color:#3b82f6;font-weight:600;">Monthly</span>' : 'Weekly';
      var actual = display;
      if (e.preponed) {
        var aDt = new Date(e.actual + 'T00:00:00');
        actual = aDt.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
      }
      var cls = e.date < todayStr ? 'past-holiday' : (e.date === todayStr ? 'today-holiday' : '');
      if (e.monthly) cls += ' monthly-row';
      var preponedNote = e.preponed ? '<span class="preponed" title="Preponed due to holiday"> ⚠ ' + actual + '</span>' : '';
      rows += '<tr class="' + cls + '"><td>' + (i+1) + '</td><td>' + display + '</td><td>' + dayName + '</td><td>' + type + '</td><td>' + (e.preponed ? preponedNote : '—') + '</td></tr>';
    });
    body.innerHTML = rows;
  } catch(e) {
    body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:20px;">Failed to load expiry dates</td></tr>';
  }
}

// ── Section Summary (Eye icon) ─────────────────────────────────────────────
var _sectionSummaries = ${sectionSummaryJSON};
var _sectionNames = { 0: 'Trading Strategy (15-min)', 1: 'Scalping Strategy (BB+CPR)' };

function showSectionSummary(idx) {
  var modal = document.getElementById('sectionSummaryModal');
  var titleEl = document.getElementById('sectionSummaryTitle');
  var bodyEl = document.getElementById('sectionSummaryBody');
  if (!modal || !bodyEl) return;

  titleEl.textContent = _sectionNames[idx] || 'Settings Summary';

  // Read current values from the form (not the static data) so it reflects unsaved changes
  var fields = _sectionSummaries[idx];
  var html = '<table class="summary-table">';
  html += '<tr><th>Setting</th><th>Value</th></tr>';
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var el = document.querySelector('[data-key="' + f.key + '"]');
    var val = f.value;
    if (el) {
      val = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value;
    }
    var valClass = 'val-text';
    if (val === 'true') valClass = 'val-true';
    else if (val === 'false') valClass = 'val-false';
    else if (f.type === 'number' || !isNaN(parseFloat(val))) valClass = 'val-num';

    var displayVal = val === 'true' ? 'ON' : val === 'false' ? 'OFF' : (val || '—');
    html += '<tr><td><div class="summary-label">' + f.label + '</div><div class="summary-key">' + f.key + '</div></td><td class="' + valClass + '">' + displayVal + '</td></tr>';
  }
  html += '</table>';
  bodyEl.innerHTML = html;
  modal.style.display = 'block';
}
</script>
<!-- Section summary modal -->
<div id="sectionSummaryModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:560px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span id="sectionSummaryTitle" style="font-weight:700;font-size:0.95rem;color:#60a5fa;">Settings Summary</span>
      <button onclick="document.getElementById('sectionSummaryModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
    </div>
    <div id="sectionSummaryBody" style="padding:12px 16px;max-height:70vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#243048 transparent;">
    </div>
  </div>
</div>
<!-- Holiday list modal -->
<div id="holidayModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:520px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span style="font-weight:700;font-size:0.95rem;color:#60a5fa;">📅 NSE Trading Holidays ${new Date().getFullYear()}</span>
      <button onclick="document.getElementById('holidayModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
    </div>
    <div class="holiday-modal-body" style="padding:0 16px 16px;">
      <table class="holiday-table">
        <thead><tr><th>#</th><th>Date</th><th>Day</th><th>Holiday</th></tr></thead>
        <tbody id="holidayTableBody"></tbody>
      </table>
    </div>
  </div>
</div>
<!-- Expiry calendar modal -->
<div id="expiryModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:600px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span id="expiryYearTitle" style="font-weight:700;font-size:0.95rem;color:#60a5fa;">📊 NIFTY Options Expiry Calendar</span>
      <button onclick="document.getElementById('expiryModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
    </div>
    <div style="padding:8px 16px 0;">
      <div class="expiry-legend">
        <span><span class="expiry-dot" style="background:#3b82f6;"></span> Monthly expiry</span>
        <span><span class="expiry-dot" style="background:#f59e0b;"></span> Preponed (holiday)</span>
        <span style="opacity:0.4;"><span class="expiry-dot" style="background:#4a6080;"></span> Past</span>
      </div>
    </div>
    <div class="holiday-modal-body" style="padding:0 16px 16px;">
      <table class="holiday-table">
        <thead><tr><th>#</th><th>Expiry Date</th><th>Day</th><th>Type</th><th>Preponed To</th></tr></thead>
        <tbody id="expiryTableBody"></tbody>
      </table>
    </div>
  </div>
</div>
<!-- .env viewer modal -->
<div id="envModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:700px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span style="font-weight:700;font-size:0.95rem;color:#60a5fa;">.env Configuration</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="envCopyBtn" onclick="copyEnvTable()" style="padding:4px 10px;background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.25);border-radius:5px;font-size:0.7rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">COPY</button>
        <button onclick="document.getElementById('envModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
      </div>
    </div>
    <div id="envTableWrap" style="padding:16px 20px;max-height:70vh;overflow-y:auto;">
      <div style="color:#4a6080;font-size:0.8rem;">Loading...</div>
    </div>
  </div>
</div>
</body>
</html>`);
});

// ── GET /settings/env — return all .env values as JSON ─────────────────────
router.get("/env", (req, res) => {
  const envData = {};
  try {
    const envContent = fs.readFileSync(ENV_PATH, "utf-8");
    envContent.split("\n").forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) return;
      const key = trimmed.substring(0, eqIdx).trim();
      const val = trimmed.substring(eqIdx + 1).trim();
      envData[key] = val;
    });
  } catch (e) {
    return res.json({ error: "Could not read .env" });
  }
  res.json(envData);
});

module.exports = router;

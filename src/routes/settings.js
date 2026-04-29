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
    section: "SWING STRATEGY (15-min) — Zerodha",
    icon: "📊",
    fields: [
      { key: "SWING_LIVE_ENABLED", label: "Swing Live Orders", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Zerodha" },
      { key: "TRADE_EXPIRY_DAY_ONLY", label: "Trade Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only allow entries on NIFTY weekly expiry day (Tuesday, or Monday if Tuesday is holiday)", default: "false" },
      { key: "TRADE_ENTRY_START", label: "Entry Start Time", type: "time", effect: EFFECT.SESSION, desc: "Earliest time for new trade entries (HH:MM IST)", default: "09:30" },
      { key: "TRADE_ENTRY_END", label: "Entry End Time", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (HH:MM IST)", default: "14:00" },
      { key: "VIX_FILTER_ENABLED", label: "VIX Filter (Swing)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block Swing entries when VIX is high (scope: Swing only)" },
      { key: "VIX_MAX_ENTRY", label: "Swing VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Swing only: block entries above this VIX", default: "20" },
      { key: "VIX_STRONG_ONLY", label: "Swing VIX Strong Only", type: "number", min: 8, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "Swing only: above this VIX only STRONG signals allowed", default: "16" },
      { key: "MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 50000, step: 500, effect: EFFECT.SESSION, desc: "Kill-switch: stop trading after this much loss (also latched on 3 consecutive losses)", default: "5000" },
      { key: "MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Hard cap on entries per session — prevents chop-day overtrading", default: "6" },
      { key: "MAX_SAR_DISTANCE", label: "Max SL Distance (pts)", type: "number", min: 40, max: 200, step: 5, effect: EFFECT.SESSION, desc: "Reject entries with SL > this (caps risk per trade)", default: "80" },
      { key: "BREAKEVEN_PTS", label: "Breakeven Stop (pts)", type: "number", min: 10, max: 50, step: 5, effect: EFFECT.SESSION, desc: "SL moves to entry after +N pts move", default: "25" },
      { key: "SWING_USE_PREV_CANDLE_SL", label: "Use Prev Candle as SL", type: "toggle", effect: EFFECT.SESSION, desc: "Initial SL = prev candle low/high (structural). Combined with SAR + max/min caps below", default: "true" },
      { key: "SWING_MAX_INITIAL_SL_PTS", label: "Initial SL Hard Cap (pts)", type: "number", min: 20, max: 150, step: 5, effect: EFFECT.SESSION, desc: "Initial SL never wider than this many pts from entry (caps loss on wide SAR)", default: "50" },
      { key: "SWING_MIN_INITIAL_SL_PTS", label: "Initial SL Floor (pts)", type: "number", min: 5, max: 30, step: 1, effect: EFFECT.SESSION, desc: "Initial SL never tighter than this many pts (avoids suicide-tight SL on doji bars)", default: "15" },
      { key: "RSI_CE_MIN", label: "RSI CE Min (>)", type: "number", min: 45, max: 65, step: 1, effect: EFFECT.INSTANT, desc: "Bullish momentum: RSI must be above this for CE entry", default: "52" },
      { key: "RSI_PE_MAX", label: "RSI PE Max (<)", type: "number", min: 35, max: 55, step: 1, effect: EFFECT.INSTANT, desc: "Bearish momentum: RSI must be below this for PE entry", default: "48" },
      { key: "EMA30_FILTER", label: "EMA30 Trend Filter", type: "toggle", effect: EFFECT.INSTANT, desc: "Block counter-trend entries (CE below EMA30, PE above EMA30). Disable for more trades in range-bound markets", default: "true" },
      { key: "ADX_MIN_TREND", label: "ADX Min Trend", type: "number", min: 15, max: 35, step: 1, effect: EFFECT.INSTANT, desc: "Minimum ADX to confirm trend (below = ranging, block entry)", default: "25" },
      { key: "EMA_TOUCH_MAX", label: "EMA Touch Max (pts)", type: "number", min: 5, max: 50, step: 5, effect: EFFECT.INSTANT, desc: "Max distance from EMA9 to count as touch (low for CE, high for PE)", default: "20" },
      { key: "EMA_SLOPE_MIN", label: "EMA9 Slope Min (pts)", type: "number", min: 2, max: 15, step: 1, effect: EFFECT.INSTANT, desc: "Min EMA9 slope for entry (pts vs prev candle)", default: "6" },
      { key: "STRONG_SLOPE", label: "STRONG Slope (pts)", type: "number", min: 6, max: 20, step: 1, effect: EFFECT.INSTANT, desc: "EMA9 slope >= this for STRONG signal (intra-candle entry)", default: "9" },
      { key: "STRONG_RSI_CE", label: "STRONG RSI CE (>)", type: "number", min: 50, max: 70, step: 1, effect: EFFECT.INSTANT, desc: "RSI must be above this for STRONG CE signal", default: "58" },
      { key: "STRONG_RSI_PE", label: "STRONG RSI PE (<)", type: "number", min: 30, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "RSI must be below this for STRONG PE signal", default: "40" },
      { key: "MIN_SAR_DISTANCE", label: "Min SL Distance (pts)", type: "number", min: 10, max: 80, step: 5, effect: EFFECT.INSTANT, desc: "Reject entries with SL closer than this (too tight = noise)", default: "45" },
      { key: "MIN_CANDLE_BODY", label: "Min Candle Body (pts)", type: "number", min: 3, max: 25, step: 1, effect: EFFECT.INSTANT, desc: "Min candle body size for valid entry (filters dojis)", default: "10" },
      { key: "LOGIC3_RSI_MAX", label: "Logic3 PE RSI Max (<)", type: "number", min: 35, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "PE override when SAR still bull: RSI must be below this", default: "46" },
      { key: "LOGIC3_RSI_MIN_CE", label: "Logic3 CE RSI Min (>)", type: "number", min: 50, max: 65, step: 1, effect: EFFECT.INSTANT, desc: "CE override when SAR still bear: RSI must be above this", default: "53" },
      { key: "LOGIC3_SAR_GAP", label: "Logic3 SAR Gap (pts)", type: "number", min: 10, max: 150, step: 5, effect: EFFECT.INSTANT, desc: "SAR override: SAR must be this many pts from price (lagging)", default: "30" },
      { key: "TRAIL_ACTIVATE_PTS", label: "Trail Activate (pts)", type: "number", min: 5, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Min profit before trail starts", default: "12" },
      { key: "TRAIL_TIER1_UPTO", label: "T1 Upto (pts)", type: "number", min: 10, max: 100, step: 5, effect: EFFECT.SESSION, desc: "0 to N pts profit → T1 gap", default: "30" },
      { key: "TRAIL_TIER1_GAP", label: "T1 Gap (pts)", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Trail gap during T1 (widest)", default: "40" },
      { key: "TRAIL_TIER2_UPTO", label: "T2 Upto (pts)", type: "number", min: 20, max: 200, step: 5, effect: EFFECT.SESSION, desc: "T1 to N pts profit → T2 gap", default: "55" },
      { key: "TRAIL_TIER2_GAP", label: "T2 Gap (pts)", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Trail gap during T2 (tightening)", default: "25" },
      { key: "TRAIL_TIER3_GAP", label: "T3 Gap (pts)", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Trail gap above T2 (tightest)", default: "15" },
      { key: "OPT_STOP_PCT", label: "Option Stop %", type: "number", min: 0.05, max: 0.50, step: 0.05, effect: EFFECT.SESSION, desc: "Fallback stop-loss as % of option premium (fires before underlying SL on far-SAR setups)", default: "0.25" },
    ],
  },
  {
    section: "SCALP STRATEGY (BB+RSI+PSAR) — Fyers",
    icon: "⚡",
    fields: [
      { key: "SCALP_MODE_ENABLED", label: "Scalp Mode", type: "toggle", effect: EFFECT.INSTANT, desc: "Show/hide scalp menus", default: "true" },
      { key: "SCALP_ENABLED", label: "Scalp Live Orders", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live scalp orders via Fyers", default: "false" },
      { key: "SCALP_EXPIRY_DAY_ONLY", label: "Scalp Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only allow scalp entries on NIFTY weekly expiry day (Tuesday, or Monday if Tuesday is holiday)", default: "false" },
      { key: "SCALP_VIX_ENABLED", label: "VIX Filter (Scalp)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block scalp entries when VIX is high (scope: Scalp only)", default: "false" },
      { key: "SCALP_VIX_MAX_ENTRY", label: "Scalp VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Scalp only: block entries above this VIX", default: "20" },
      { key: "SCALP_VIX_STRONG_ONLY", label: "Scalp VIX Strong Only", type: "number", min: 8, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "Scalp only: above this VIX allow only STRONG signals (RSI beyond threshold by +5)", default: "16" },
      { key: "SCALP_ENTRY_START", label: "Entry Start Time", type: "time", effect: EFFECT.SESSION, desc: "Earliest time for new scalp entries (HH:MM IST)", default: "09:21" },
      { key: "SCALP_ENTRY_END", label: "Entry End Time", type: "time", effect: EFFECT.SESSION, desc: "No new scalp entries after this time (HH:MM IST)", default: "14:30" },
      { key: "SCALP_RESOLUTION", label: "Candle (min)", type: "select", options: ["5"], effect: EFFECT.SESSION, desc: "Scalp candle resolution (5 min)", default: "5" },
      // ── Bollinger Bands ──
      { key: "SCALP_BB_PERIOD", label: "BB Period", type: "number", min: 10, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Bollinger Band SMA period", default: "20" },
      { key: "SCALP_BB_STDDEV", label: "BB Std Dev", type: "number", min: 0.5, max: 3.0, step: 0.1, effect: EFFECT.SESSION, desc: "Bollinger Band standard deviation", default: "1" },
      // ── RSI ──
      { key: "SCALP_RSI_PERIOD", label: "RSI Period", type: "number", min: 7, max: 21, step: 1, effect: EFFECT.SESSION, desc: "RSI calculation period", default: "14" },
      { key: "SCALP_RSI_CE_THRESHOLD", label: "RSI CE Min (>)", type: "number", min: 50, max: 80, step: 1, effect: EFFECT.SESSION, desc: "RSI above this for CE entry (momentum confirmation)", default: "55" },
      { key: "SCALP_RSI_CE_MAX", label: "RSI CE Max (<)", type: "number", min: 65, max: 90, step: 1, effect: EFFECT.SESSION, desc: "Block CE when RSI above this — overbought / chasing exhausted move", default: "78" },
      { key: "SCALP_RSI_PE_THRESHOLD", label: "RSI PE Max (<)", type: "number", min: 20, max: 50, step: 1, effect: EFFECT.SESSION, desc: "RSI below this for PE entry (momentum confirmation)", default: "45" },
      { key: "SCALP_RSI_PE_MIN", label: "RSI PE Min (>)", type: "number", min: 10, max: 35, step: 1, effect: EFFECT.SESSION, desc: "Block PE when RSI below this — oversold / shorting exhausted move", default: "22" },
      { key: "SCALP_RSI_TURNING", label: "RSI Turning Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Require RSI momentum to confirm direction (CE: RSI not falling; PE: RSI not rising). Skips fading-momentum entries.", default: "false" },
      // ── Parabolic SAR (initial SL + trailing) ──
      { key: "SCALP_PSAR_STEP", label: "PSAR Step", type: "number", min: 0.01, max: 0.05, step: 0.005, effect: EFFECT.SESSION, desc: "PSAR acceleration step", default: "0.02" },
      { key: "SCALP_PSAR_MAX", label: "PSAR Max", type: "number", min: 0.1, max: 0.3, step: 0.01, effect: EFFECT.SESSION, desc: "PSAR max acceleration", default: "0.2" },
      // ── Trail profit (tiered % of peak) ──
      { key: "SCALP_TRAIL_START", label: "Trail Activate (₹)", type: "number", min: 200, max: 3000, step: 50, effect: EFFECT.SESSION, desc: "Activate trailing after this much peak profit. Higher = lets winners breathe, smaller wins reach BE-stop instead.", default: "600" },
      { key: "SCALP_TRAIL_PCT", label: "Base Trail (%)", type: "number", min: 30, max: 90, step: 5, effect: EFFECT.SESSION, desc: "Base trail floor (used between TRAIL_START and the first tier). Higher = lock more, exit sooner.", default: "70" },
      { key: "SCALP_TRAIL_TIERS", label: "Trail Tiers", type: "text", effect: EFFECT.SESSION, desc: "peak:pct pairs — keep more as profit grows. Format: '600:70,1200:78,2500:85,5000:90,10000:93'", default: "600:70,1200:78,2500:85,5000:90,10000:93" },
      { key: "SCALP_TRAIL_GRACE_SECS", label: "Trail Grace (secs)", type: "number", min: 0, max: 300, step: 10, effect: EFFECT.SESSION, desc: "Suppress trail-exit in first N seconds after entry (prevents first-tick spike + tiny pullback from killing trades). SL still active. Set 0 to disable.", default: "0" },
      // ── Break-even SL (move SL to entry once peak ≥ trigger × initial risk) ──
      { key: "SCALP_BREAKEVEN_TRIGGER_R", label: "Break-Even Trigger (R)", type: "number", min: 0, max: 2, step: 0.1, effect: EFFECT.SESSION, desc: "Move SL to entry+offset once peak P&L ≥ N × initial risk. Stops winners reversing into losers. 0 = disabled.", default: "0.7" },
      { key: "SCALP_BREAKEVEN_OFFSET_PTS", label: "Break-Even Offset (pts)", type: "number", min: 0, max: 5, step: 0.5, effect: EFFECT.SESSION, desc: "Spot points above/below entry for the BE stop (small buffer for slippage)", default: "1" },
      // ── Risk management (Prev Candle SL) ──
      { key: "SCALP_MAX_SL_PTS", label: "Max SL (pts)", type: "number", min: 6, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Hard cap on prev candle SL distance. Tighter = smaller max loss but more SL hits.", default: "12" },
      { key: "SCALP_MIN_SL_PTS", label: "Min SL (pts)", type: "number", min: 3, max: 20, step: 1, effect: EFFECT.SESSION, desc: "Floor on prev candle SL (prevents too-tight SL on tiny candles)", default: "8" },
      { key: "SCALP_SLIPPAGE_PTS", label: "Slippage (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.SESSION, desc: "Simulated slippage on entry & SL exit (pts added against you)", default: "0" },
      { key: "SCALP_MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Max scalp entries per day", default: "30" },
      { key: "SCALP_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 20000, step: 500, effect: EFFECT.SESSION, desc: "Scalp kill-switch", default: "4000" },
      { key: "SCALP_SL_PAUSE_CANDLES", label: "SL Pause (candles)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Pause after SL hit (5-min candles)", default: "3" },
      { key: "SCALP_CONSEC_SL_EXTRA_PAUSE", label: "Consec SL Extra Pause", type: "number", min: 1, max: 8, step: 1, effect: EFFECT.SESSION, desc: "Extra candles pause per consecutive SL after the 2nd (e.g. 2 = +2 candles on 2nd SL, +4 on 3rd)", default: "2" },
      { key: "SCALP_PER_SIDE_PAUSE", label: "Per-Side SL Pause", type: "toggle", effect: EFFECT.SESSION, desc: "When ON, an SL on CE only pauses CE entries (PE still allowed) and vice versa. OFF = legacy global pause.", default: "true" },
      // ── Time-stop (per-mode override of TIME_STOP_* defaults) ──
      { key: "SCALP_TIME_STOP_CANDLES", label: "Scalp Time-Stop (candles)", type: "number", min: 2, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Exit flat scalp trades after this many 5-min candles (theta bleed guard). Overrides TIME_STOP_CANDLES.", default: "3" },
      { key: "SCALP_TIME_STOP_FLAT_PTS", label: "Scalp Time-Stop Flat (option pts)", type: "number", min: 2, max: 25, step: 1, effect: EFFECT.SESSION, desc: "Time-stop fires only when |option-premium move| < this. Overrides TIME_STOP_FLAT_PTS.", default: "6" },
      // ── BB Squeeze filter ──
      { key: "SCALP_BB_SQUEEZE_FILTER", label: "BB Squeeze Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Skip entries when BB bands are narrow (consolidation = false breakouts)", default: "true" },
      { key: "SCALP_BB_MIN_WIDTH_PCT", label: "BB Min Width (%)", type: "number", min: 0.05, max: 0.5, step: 0.01, effect: EFFECT.SESSION, desc: "Min BB width as % of price (0.15 = skip if BB width < 36pts on NIFTY 24000)", default: "0.15" },
      // ── V4 Quality filters ──
      { key: "SCALP_REQUIRE_APPROACH", label: "Require Approach", type: "toggle", effect: EFFECT.SESSION, desc: "Block entry if prev candle was on opposite half of BB (CE: prev close < BB middle = first-touch breakout, likely fades)", default: "false" },
      { key: "SCALP_MIN_BODY_RATIO", label: "Min Body Ratio", type: "number", min: 0, max: 0.9, step: 0.05, effect: EFFECT.SESSION, desc: "Min entry candle body as % of range (0.5 = skip doji/wick breakouts where body < 50% of high-low). Set 0 to disable.", default: "0" },
      // ── Trend filter (regime guard) ──
      { key: "SCALP_TREND_FILTER", label: "Trend Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Require larger trend to agree with trade direction. PE only when price falling AND BB middle sloping down; CE inverse. Blocks chop-zone entries.", default: "true" },
      { key: "SCALP_TREND_MOMENTUM_LOOKBACK", label: "Trend Momentum Lookback (candles)", type: "number", min: 3, max: 15, step: 1, effect: EFFECT.SESSION, desc: "How many candles back to measure price momentum (5 = compare close vs close 25 min ago)", default: "5" },
      { key: "SCALP_TREND_MOMENTUM_PCT", label: "Trend Momentum Min %", type: "number", min: 0.05, max: 1.0, step: 0.05, effect: EFFECT.SESSION, desc: "Min % change required over lookback to call it a trend (0.15 = ~36pts on NIFTY 24000). Lower = more entries, more chop.", default: "0.15" },
      { key: "SCALP_TREND_MID_SLOPE_LOOKBACK", label: "BB Mid Slope Lookback (candles)", type: "number", min: 2, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Candles back to check BB middle band slope direction (3 = is mid line rising/falling over last 15 min)", default: "3" },
      // ── Activity filter ──
      { key: "SCALP_ACTIVITY_FILTER", label: "Activity Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Skip entries when candle range is below average (low activity = false BB breakouts)", default: "false" },
      { key: "SCALP_ACTIVITY_FILTER_RATIO", label: "Activity Ratio", type: "number", min: 0.2, max: 1.0, step: 0.1, effect: EFFECT.SESSION, desc: "Min candle range vs 20-bar avg (0.5 = skip if range < 50% of avg)", default: "0.5" },
    ],
  },
  {
    section: "PRICE ACTION STRATEGY (5-min) — Fyers",
    icon: "📐",
    fields: [
      { key: "PA_MODE_ENABLED", label: "Price Action Mode", type: "toggle", effect: EFFECT.INSTANT, desc: "Show/hide price action menus", default: "true" },
      { key: "PA_ENABLED", label: "PA Live Orders", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable PA live order placement (Fyers). Required to start a PA Live session.", default: "false" },
      { key: "PA_EXPIRY_DAY_ONLY", label: "PA Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only allow PA entries on NIFTY weekly expiry day", default: "false" },
      { key: "PA_VIX_ENABLED", label: "VIX Filter (PA)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block PA entries when VIX is high (scope: PA only)", default: "false" },
      { key: "PA_VIX_MAX_ENTRY", label: "PA VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "PA only: block entries above this VIX", default: "20" },
      { key: "PA_VIX_STRONG_ONLY", label: "PA VIX Strong Only", type: "number", min: 8, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "PA only: above this VIX allow only STRONG pattern signals (engulfing/BOS) — block MARGINAL (pin bars, etc.)", default: "16" },
      { key: "PA_ENTRY_START", label: "Entry Start Time", type: "time", effect: EFFECT.SESSION, desc: "Earliest time for new PA entries (HH:MM IST)", default: "09:20" },
      { key: "PA_ENTRY_END", label: "Entry End Time", type: "time", effect: EFFECT.SESSION, desc: "No new PA entries after this time (HH:MM IST)", default: "14:30" },
      { key: "PA_RESOLUTION", label: "Candle (min)", type: "select", options: ["5", "3"], effect: EFFECT.SESSION, desc: "Price action candle resolution", default: "5" },
      // ── RSI (confluence filter) ──
      { key: "PA_RSI_PERIOD", label: "RSI Period", type: "number", min: 7, max: 21, step: 1, effect: EFFECT.SESSION, desc: "RSI calculation period", default: "14" },
      { key: "PA_RSI_CE_MIN", label: "RSI CE Min (>)", type: "number", min: 30, max: 60, step: 1, effect: EFFECT.SESSION, desc: "RSI above this for CE entry (confluence)", default: "45" },
      { key: "PA_RSI_CAPS_ENABLED", label: "RSI Caps", type: "toggle", effect: EFFECT.SESSION, desc: "Block CE when RSI overbought / PE when RSI oversold", default: "true" },
      { key: "PA_RSI_CE_MAX", label: "RSI CE Max (<)", type: "number", min: 55, max: 90, step: 1, effect: EFFECT.SESSION, desc: "Block CE entry when RSI above this (overbought — buying exhausted move)", default: "65" },
      { key: "PA_RSI_PE_MAX", label: "RSI PE Max (<)", type: "number", min: 40, max: 70, step: 1, effect: EFFECT.SESSION, desc: "RSI below this for PE entry (confluence)", default: "55" },
      { key: "PA_RSI_PE_MIN", label: "RSI PE Min (>)", type: "number", min: 15, max: 40, step: 1, effect: EFFECT.SESSION, desc: "Block PE entry when RSI below this (oversold — shorting exhausted move)", default: "25" },
      // ── ADX chop filter ──
      { key: "PA_ADX_ENABLED", label: "ADX Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Block entries when ADX < threshold (market ranging/choppy)", default: "true" },
      { key: "PA_ADX_MIN", label: "ADX Min Trend", type: "number", min: 15, max: 35, step: 1, effect: EFFECT.SESSION, desc: "Minimum ADX to allow entries (below = ranging market)", default: "20" },
      { key: "PA_ADX_RISING_REQUIRED", label: "ADX Rising (all patterns)", type: "toggle", effect: EFFECT.SESSION, desc: "Require ADX[now] >= ADX[2 bars ago] for EVERY entry (engulfing, pinbar, BOS, IB, double top/bottom, triangles). Blocks counter-trend reversals when the trend is fading.", default: "true" },
      { key: "PA_ADX_DIRECTIONAL", label: "ADX Directional (+DI/-DI)", type: "toggle", effect: EFFECT.SESSION, desc: "Require +DI > -DI for CE entries and -DI > +DI for PE entries. Blocks counter-trend bullish/bearish patterns inside a strong opposite-direction trend (key fix for losing on bearish-trend days).", default: "true" },
      // ── Pattern toggles (per-signal) ──
      { key: "PA_PATTERN_ENGULFING",     label: "Engulfing (CE/PE)",        type: "toggle", effect: EFFECT.SESSION, desc: "Bullish/Bearish Engulfing at S/R — STRONG", default: "true" },
      { key: "PA_PATTERN_PINBAR",        label: "Pin Bar (Hammer/Star)",    type: "toggle", effect: EFFECT.SESSION, desc: "Hammer at support / Shooting Star at resistance — MARGINAL", default: "true" },
      { key: "PA_PATTERN_BOS",           label: "Break of Structure",       type: "toggle", effect: EFFECT.SESSION, desc: "Close above swing high (CE) / below swing low (PE) — STRONG", default: "true" },
      { key: "PA_PATTERN_INSIDE_BAR",    label: "Inside Bar Breakout",      type: "toggle", effect: EFFECT.SESSION, desc: "Mother bar breakout (3-candle wait) — STRONG", default: "true" },
      { key: "PA_PATTERN_DOUBLE_TOP",    label: "Double Top (M)",           type: "toggle", effect: EFFECT.SESSION, desc: "Bearish reversal — neckline breakdown — STRONG", default: "false" },
      { key: "PA_PATTERN_DOUBLE_BOTTOM", label: "Double Bottom (W)",        type: "toggle", effect: EFFECT.SESSION, desc: "Bullish reversal — neckline breakout — STRONG", default: "false" },
      { key: "PA_PATTERN_ASC_TRIANGLE",  label: "Ascending Triangle",       type: "toggle", effect: EFFECT.SESSION, desc: "Flat resistance + rising lows breakout (CE) — STRONG", default: "false" },
      { key: "PA_PATTERN_DESC_TRIANGLE", label: "Descending Triangle",      type: "toggle", effect: EFFECT.SESSION, desc: "Flat support + falling highs breakdown (PE) — STRONG", default: "false" },
      // ── Pattern parameters ──
      { key: "PA_MIN_BODY", label: "Min Candle Body (pts)", type: "number", min: 2, max: 15, step: 1, effect: EFFECT.SESSION, desc: "Minimum candle body size for engulfing/BOS patterns", default: "5" },
      { key: "PA_PIN_WICK_RATIO", label: "Pin Bar Wick Ratio", type: "number", min: 1.5, max: 4, step: 0.5, effect: EFFECT.SESSION, desc: "Min wick-to-body ratio for hammer/shooting star", default: "2" },
      // ── Support/Resistance ──
      { key: "PA_SR_LOOKBACK", label: "S/R Lookback (candles)", type: "number", min: 15, max: 60, step: 5, effect: EFFECT.SESSION, desc: "Number of candles to find swing highs/lows", default: "30" },
      { key: "PA_SR_ZONE_PTS", label: "S/R Zone (pts)", type: "number", min: 5, max: 30, step: 1, effect: EFFECT.SESSION, desc: "Price must be within this many pts of S/R level", default: "15" },
      // ── Trail profit ──
      { key: "PA_CANDLE_TRAIL_ENABLED", label: "Candle Trail", type: "toggle", effect: EFFECT.SESSION, desc: "Primary structure-based exit: exit on N-bar low (CE) / N-bar high (PE). Runs alongside profit-lock safety net.", default: "true" },
      { key: "PA_CANDLE_TRAIL_BARS", label: "Candle Trail Bars", type: "number", min: 1, max: 5, step: 1, effect: EFFECT.SESSION, desc: "Bars to look back for trail level (3 = lowest low / highest high of last 3 bars)", default: "3" },
      { key: "PA_TRAIL_START", label: "Trail Activate (₹)", type: "number", min: 50, max: 3000, step: 50, effect: EFFECT.SESSION, desc: "Activate trailing after this much peak profit. Set high enough to let winners breathe through noise.", default: "600" },
      { key: "PA_TRAIL_PCT", label: "Base Trail (%)", type: "number", min: 20, max: 90, step: 5, effect: EFFECT.SESSION, desc: "Exit when profit drops below X% of peak (loose base pct — lets trade breathe until tiers bind)", default: "40" },
      { key: "PA_TRAIL_TIERS", label: "Trail Tiers", type: "text", effect: EFFECT.SESSION, desc: "peak:pct pairs — tighter locking as peak grows. Format: 1000:50,1500:60,2500:70,4000:80", default: "1000:50,1500:60,2500:70,4000:80" },
      // ── Risk management ──
      { key: "PA_MAX_SL_PTS", label: "Max SL (pts)", type: "number", min: 8, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Hard cap on SL distance after clamping. 12 pts × ~130 qty ≈ ₹1560 max loss per trade.", default: "12" },
      { key: "PA_MAX_STRUCT_SL_PTS", label: "Max Structural SL (pts, BOS/IB)", type: "number", min: 8, max: 40, step: 1, effect: EFFECT.SESSION, desc: "Skip BOS/IB setups when raw structural SL (swing or mother bar) exceeds this — thin structure = false breakout risk", default: "15" },
      { key: "PA_MIN_SL_PTS", label: "Min SL (pts)", type: "number", min: 3, max: 20, step: 1, effect: EFFECT.SESSION, desc: "Floor on SL distance", default: "8" },
      { key: "PA_TIME_STOP_CANDLES", label: "Time-Stop Candles", type: "number", min: 2, max: 8, step: 1, effect: EFFECT.SESSION, desc: "Exit flat trades after this many candles (theta bleed guard)", default: "3" },
      { key: "PA_TIME_STOP_FLAT_PTS", label: "Time-Stop Flat (pts)", type: "number", min: 5, max: 30, step: 1, effect: EFFECT.SESSION, desc: "Time-stop fires only when |PnL| < this many points (trade has gone nowhere)", default: "10" },
      { key: "PA_SLIPPAGE_PTS", label: "Slippage (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.SESSION, desc: "Simulated slippage for backtest", default: "0" },
      { key: "PA_OPT_STOP_PCT", label: "PA Option Stop %", type: "number", min: 0.05, max: 0.5, step: 0.05, effect: EFFECT.SESSION, desc: "Fallback stop-loss as % of option premium for PA live (used when premium-based SL is tighter than spot SL)", default: "0.15" },
      { key: "PA_MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Max PA entries per day", default: "30" },
      { key: "PA_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 20000, step: 500, effect: EFFECT.SESSION, desc: "PA daily loss kill-switch", default: "2000" },
      { key: "PA_SL_PAUSE_CANDLES", label: "SL Pause (candles)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Pause after SL hit", default: "2" },
      { key: "PA_CONSEC_SL_EXTRA_PAUSE", label: "Consec SL Extra Pause", type: "number", min: 1, max: 5, step: 1, effect: EFFECT.SESSION, desc: "Extra candles pause per consecutive SL", default: "2" },
      { key: "PA_PAPER_CAPITAL", label: "Price Action Paper Capital (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.INSTANT, desc: "Starting capital for PA paper trading", default: "100000" },
    ],
  },
  {
    section: "COMMON — Instrument & Backtest",
    icon: "📈",
    fields: [
      { key: "CHART_ENABLED", label: "Live NIFTY Chart", type: "toggle", effect: EFFECT.INSTANT, desc: "Show candlestick chart with entry/exit markers on status pages", default: "true" },
      { key: "VIX_FAIL_MODE", label: "VIX Unavailable (all modules)", type: "select", options: ["closed", "open"], effect: EFFECT.INSTANT, desc: "Shared fallback for all VIX filters when VIX data is missing: closed = block entries (safe), open = allow entries", default: "closed" },
      { key: "TRADE_RESOLUTION", label: "Candle Resolution (min)", type: "select", options: ["5", "15"], effect: EFFECT.SESSION, desc: "Trading candle timeframe (5-min or 15-min)", default: "15" },
      { key: "TRADE_START_TIME", label: "Market Start Time", type: "time", effect: EFFECT.SESSION, desc: "Market open time — execution gate start (HH:MM IST)", default: "09:15" },
      { key: "TRADE_STOP_TIME", label: "Market Stop Time", type: "time", effect: EFFECT.SESSION, desc: "Auto-stop time — EOD square off + engine shutdown (HH:MM IST)", default: "15:30" },
      { key: "INSTRUMENT", label: "Trade Type", type: "select", options: ["NIFTY_OPTIONS", "NIFTY_FUTURES"], effect: EFFECT.INSTANT, desc: "Options (CE/PE) or Futures" },
      { key: "NIFTY_LOT_SIZE", label: "Lot Size (Qty)", type: "number", min: 1, max: 200, step: 1, effect: EFFECT.INSTANT, desc: "Qty per lot (currently 65)" },
      { key: "LOT_MULTIPLIER", label: "Lot Multiplier", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "Number of lots per trade" },
      { key: "STRIKE_OFFSET_CE", label: "CE Strike Offset", type: "number", min: -200, max: 200, step: 50, effect: EFFECT.INSTANT, desc: "-50=ITM, 0=ATM, +50=OTM", default: "0" },
      { key: "STRIKE_OFFSET_PE", label: "PE Strike Offset", type: "number", min: -200, max: 200, step: 50, effect: EFFECT.INSTANT, desc: "+50=ITM, 0=ATM, -50=OTM", default: "0" },
      { key: "OPTION_EXPIRY_OVERRIDE", label: "Option Expiry (manual)", type: "date", effect: EFFECT.INSTANT, desc: "Override auto-detected expiry. Leave blank for auto. Applies to all modes (swing/scalp/PA)." },
      { key: "OPTION_EXPIRY_TYPE", label: "Expiry Type", type: "select", options: ["weekly", "monthly"], effect: EFFECT.INSTANT, desc: "Weekly = normal Tuesday expiry. Monthly = last Thursday/preponed monthly expiry. Applies to all modes.", default: "weekly" },
      { key: "BACKTEST_OPTION_SIM", label: "Option Simulation", type: "toggle", effect: EFFECT.BACKTEST, desc: "Simulate option P&L with delta/theta" },
      { key: "BACKTEST_DELTA", label: "Delta", type: "number", min: 0.1, max: 1.0, step: 0.05, effect: EFFECT.BACKTEST, desc: "Option delta for premium simulation" },
      { key: "BACKTEST_THETA_DAY", label: "Theta ₹/day", type: "number", min: 0, max: 50, step: 1, effect: EFFECT.BACKTEST, desc: "Daily theta decay in rupees" },
      { key: "BACKTEST_SLIPPAGE_PTS", label: "Slippage (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.BACKTEST, desc: "Simulated slippage per side (entry+exit). 0=off, 2=realistic for NIFTY options", default: "0" },
      { key: "LTP_STALE_THRESHOLD_SEC", label: "LTP Stale Alert (sec)", type: "number", min: 5, max: 60, step: 5, effect: EFFECT.INSTANT, desc: "Warn in logs if option LTP has no update for this many seconds", default: "15" },
      { key: "LTP_STALE_FALLBACK_SEC", label: "LTP Stale Fallback (sec)", type: "number", min: 1, max: 30, step: 1, effect: EFFECT.SESSION, desc: "Live engines fall back to candle close when option LTP is older than this", default: "5" },
      { key: "GAP_THRESHOLD_PTS", label: "Gap Threshold (pts)", type: "number", min: 10, max: 200, step: 5, effect: EFFECT.SESSION, desc: "Skip first candle if previous close vs open gap exceeds this (overnight-gap guard for live engines)", default: "50" },
      { key: "MAX_BID_ASK_SPREAD_PTS", label: "Max Bid-Ask Spread (pts)", type: "number", min: 0, max: 20, step: 0.5, effect: EFFECT.SESSION, desc: "Reject live entries when option bid-ask spread is wider than this", default: "2" },
      { key: "TIME_STOP_CANDLES", label: "Time-Stop Candles (default)", type: "number", min: 2, max: 12, step: 1, effect: EFFECT.SESSION, desc: "Default time-stop window used by trade guards (per-mode overrides take precedence)", default: "4" },
      { key: "TIME_STOP_FLAT_PTS", label: "Time-Stop Flat (pts, default)", type: "number", min: 5, max: 40, step: 1, effect: EFFECT.SESSION, desc: "Default flat-PnL band for the time-stop guard (|pnl| < this fires the stop)", default: "20" },
      { key: "HARD_SL_ENABLED", label: "Hard SL (Exchange)", type: "toggle", effect: EFFECT.SESSION, desc: "Place SL-M order at exchange on every entry. Protects against bot crash/disconnect. Options only.", default: "false" },
      { key: "HARD_SL_DELTA", label: "Hard SL Delta", type: "number", min: 0.2, max: 0.8, step: 0.05, effect: EFFECT.INSTANT, desc: "Delta for converting spot SL to option premium trigger price", default: "0.5" },
      { key: "NIFTY_SPOT_FALLBACK", label: "NIFTY Spot Fallback", type: "number", min: 15000, max: 35000, step: 50, effect: EFFECT.INSTANT, desc: "Fallback NIFTY spot price when live quote unavailable", default: "24000" },
      { key: "SWING_PAPER_CAPITAL", label: "Swing Paper Capital (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.INSTANT, desc: "Starting capital for swing paper trading", default: "100000" },
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
    ],
  },
  {
    section: "COMMON — Telegram",
    icon: "📱",
    fields: [
      { key: "TELEGRAM_CHAT_ID", label: "Chat ID", type: "text", effect: EFFECT.INSTANT, desc: "Leave blank to disable notifications" },
      { key: "TG_ENABLED", label: "Telegram Alerts (Master)", type: "toggle", effect: EFFECT.INSTANT, desc: "Master switch — when OFF, no Telegram alerts are sent regardless of the toggles below", default: "true" },

      { key: "TG_SWING_STARTED", label: "Swing — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a Swing (15-min) paper/live session is started", default: "true" },
      { key: "TG_SCALP_STARTED", label: "Scalp — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a Scalp paper/live session is started", default: "true" },
      { key: "TG_PA_STARTED",    label: "Price Action — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a Price Action paper/live session is started", default: "true" },

      { key: "TG_SWING_ENTRY", label: "Swing — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Swing (15-min) trade entry (paper + live)", default: "true" },
      { key: "TG_SCALP_ENTRY", label: "Scalp — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Scalp trade entry (paper + live)", default: "true" },
      { key: "TG_PA_ENTRY",    label: "Price Action — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Price Action trade entry (paper + live)", default: "true" },

      { key: "TG_SWING_EXIT", label: "Swing — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Swing (15-min) trade exit (paper + live)", default: "true" },
      { key: "TG_SCALP_EXIT", label: "Scalp — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Scalp trade exit (paper + live)", default: "true" },
      { key: "TG_PA_EXIT",    label: "Price Action — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Price Action trade exit (paper + live)", default: "true" },

      { key: "TG_SWING_SIGNALS", label: "Swing — Signal/Skip Alerts", type: "toggle", effect: EFFECT.INSTANT, desc: "Candle-close alerts when flat (why a Swing trade was/wasn't taken)", default: "true" },
      { key: "TG_SCALP_SIGNALS", label: "Scalp — Signal/Skip Alerts", type: "toggle", effect: EFFECT.INSTANT, desc: "Candle-close alerts when flat (why a Scalp trade was/wasn't taken)", default: "false" },
      { key: "TG_PA_SIGNALS",    label: "Price Action — Signal/Skip Alerts", type: "toggle", effect: EFFECT.INSTANT, desc: "Candle-close alerts when flat (why a PA trade was/wasn't taken)", default: "false" },

      { key: "TG_SWING_DAYREPORT", label: "Swing — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send Swing day summary (trades, win rate, P&L) when the session is stopped", default: "true" },
      { key: "TG_SCALP_DAYREPORT", label: "Scalp — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send Scalp day summary (trades, win rate, P&L) when the session is stopped", default: "true" },
      { key: "TG_PA_DAYREPORT",    label: "Price Action — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send PA day summary (trades, win rate, P&L) when the session is stopped", default: "true" },

      { key: "TG_DAYREPORT_CONSOLIDATED", label: "Consolidated Day Report (Market Close)", type: "toggle", effect: EFFECT.INSTANT, desc: "Send one combined end-of-day summary across all modes at 15:30 IST", default: "true" },
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
    section: "UI PREFERENCES",
    icon: "🎨",
    fields: [
      { key: "UI_THEME", label: "Application Theme", type: "select", options: ["dark", "light"], effect: EFFECT.INSTANT, desc: "Switch between Dark Mode (Night view) and Light Mode (Day view)", default: "dark" },
    ],
  },
  {
    section: "MENU VISIBILITY — Show / hide sidebar items",
    icon: "👁",
    fields: [
      { key: "UI_SHOW_SIMULATE", label: "Show Simulate Menu", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Simulate' inside Swing / Scalp / Price Action groups in the sidebar", default: "false" },
      { key: "UI_SHOW_COMPARE",  label: "Show Compare Menu",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Compare' inside Swing / Scalp / Price Action groups in the sidebar", default: "false" },
      { key: "UI_SHOW_TRACKER",  label: "Show Tracker Menu (Swing only)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Tracker' inside the Swing group in the sidebar", default: "false" },
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
  "SWING_LIVE_ENABLED", "TRADE_EXPIRY_DAY_ONLY",
  "VIX_FILTER_ENABLED", "VIX_MAX_ENTRY", "VIX_STRONG_ONLY", "VIX_FAIL_MODE",
  "SCALP_VIX_MAX_ENTRY", "SCALP_VIX_STRONG_ONLY", "PA_VIX_ENABLED", "PA_VIX_MAX_ENTRY", "PA_VIX_STRONG_ONLY",
  "INSTRUMENT", "NIFTY_LOT_SIZE", "STRIKE_OFFSET_CE", "STRIKE_OFFSET_PE", "LOT_MULTIPLIER",
  "OPTION_EXPIRY_OVERRIDE", "OPTION_EXPIRY_TYPE",
  "BACKTEST_CAPITAL", "BACKTEST_OPTION_SIM",
  "BACKTEST_DELTA", "BACKTEST_THETA_DAY", "SWING_PAPER_CAPITAL",
  "PA_ENABLED",
  "TELEGRAM_CHAT_ID", "TELEGRAM_BOT_TOKEN",
  "TG_ENABLED",
  "TG_SWING_STARTED", "TG_SCALP_STARTED", "TG_PA_STARTED",
  "TG_SWING_ENTRY",   "TG_SCALP_ENTRY",   "TG_PA_ENTRY",
  "TG_SWING_EXIT",    "TG_SCALP_EXIT",    "TG_PA_EXIT",
  "TG_SWING_SIGNALS", "TG_SCALP_SIGNALS", "TG_PA_SIGNALS",
  "TG_SWING_DAYREPORT", "TG_SCALP_DAYREPORT", "TG_PA_DAYREPORT",
  "TG_DAYREPORT_CONSOLIDATED",
  "NIFTY_SPOT_FALLBACK", "SCALP_PAPER_CAPITAL", "CACHE_MAX_DAYS",
  "SCALP_ENABLED", "SCALP_MODE_ENABLED", "SCALP_VIX_ENABLED", "SCALP_EXPIRY_DAY_ONLY",
  "API_SECRET", "LOGIN_SECRET", "UI_THEME",
  "UI_SHOW_SIMULATE", "UI_SHOW_COMPARE", "UI_SHOW_TRACKER",
  // Strategy thresholds — read from process.env inside getSignal() on every candle
  "EMA30_FILTER",
  "RSI_CE_MIN", "RSI_PE_MAX", "ADX_MIN_TREND", "EMA_TOUCH_MAX", "EMA_SLOPE_MIN",
  "STRONG_SLOPE", "STRONG_RSI_CE", "STRONG_RSI_PE",
  "MIN_SAR_DISTANCE", "MIN_CANDLE_BODY",
  "LOGIC3_RSI_MAX", "LOGIC3_RSI_MIN_CE", "LOGIC3_SAR_GAP",
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
  "SCALP_RSI_PERIOD", "SCALP_RSI_CE_THRESHOLD", "SCALP_RSI_CE_MAX",
  "SCALP_RSI_PE_THRESHOLD", "SCALP_RSI_PE_MIN", "SCALP_RSI_TURNING",
  "SCALP_PSAR_STEP", "SCALP_PSAR_MAX",
  "SCALP_TRAIL_START", "SCALP_TRAIL_PCT", "SCALP_TRAIL_TIERS", "SCALP_TRAIL_GRACE_SECS",
  "SCALP_BREAKEVEN_TRIGGER_R", "SCALP_BREAKEVEN_OFFSET_PTS",
  "SCALP_MAX_DAILY_TRADES", "SCALP_MAX_DAILY_LOSS",
  "SCALP_SL_PAUSE_CANDLES", "SCALP_CONSEC_SL_EXTRA_PAUSE", "SCALP_PER_SIDE_PAUSE",
  "SCALP_TIME_STOP_CANDLES", "SCALP_TIME_STOP_FLAT_PTS",
  "SCALP_MAX_SL_PTS", "SCALP_MIN_SL_PTS", "SCALP_SLIPPAGE_PTS",
  "SCALP_BB_SQUEEZE_FILTER", "SCALP_BB_MIN_WIDTH_PCT",
  "SCALP_ACTIVITY_FILTER", "SCALP_ACTIVITY_FILTER_RATIO",
  "SCALP_REQUIRE_APPROACH", "SCALP_MIN_BODY_RATIO",
  "SCALP_TREND_FILTER", "SCALP_TREND_MOMENTUM_LOOKBACK", "SCALP_TREND_MOMENTUM_PCT", "SCALP_TREND_MID_SLOPE_LOOKBACK",
  // Live-engine guards — read inside live loops, but constants in tradeGuards are cached at require()
  "GAP_THRESHOLD_PTS", "LTP_STALE_FALLBACK_SEC", "MAX_BID_ASK_SPREAD_PTS",
  "TIME_STOP_CANDLES", "TIME_STOP_FLAT_PTS",
  "PA_OPT_STOP_PCT",
]);

// ── Write values back to .env file (preserves comments and structure) ───────
function updateEnvFile(updates, deletes) {
  const deleteSet = new Set(deletes || []);

  // Step 1: Always update process.env in-memory first (this never fails)
  Object.entries(updates).forEach(([k, v]) => {
    process.env[k] = v;
  });
  deleteSet.forEach(k => { delete process.env[k]; });

  // Step 2: Try to persist to .env file on disk
  let fileSaved = false;
  let fileError = null;
  let deletedCount = 0;
  try {
    let content = fs.readFileSync(ENV_PATH, "utf-8");
    const lines = content.split("\n");
    const updatedKeys = new Set();

    // Update existing keys in-place; drop lines matching deletes
    const newLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) { newLines.push(line); continue; }
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) { newLines.push(line); continue; }
      const key = trimmed.slice(0, eqIdx).trim();
      if (deleteSet.has(key)) { deletedCount++; continue; }
      if (key in updates) {
        updatedKeys.add(key);
        newLines.push(`${key}=${updates[key]}`);
        continue;
      }
      newLines.push(line);
    }

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
    deletedCount,
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
  const { updates, deletes } = req.body;
  if ((!updates || typeof updates !== "object") && !Array.isArray(deletes)) {
    return res.status(400).json({ success: false, error: "Missing updates or deletes" });
  }

  const safeUpdates = updates && typeof updates === "object" ? { ...updates } : {};

  // Block writes to sensitive keys via UI
  for (const k of HIDDEN_KEYS) {
    if (k in safeUpdates) delete safeUpdates[k];
  }

  // Normalize + validate deletes (uppercase, strip invalid chars, block sensitive)
  const hiddenSet = new Set(HIDDEN_KEYS);
  const deleteKeys = [];
  if (Array.isArray(deletes)) {
    for (const raw of deletes) {
      const key = String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
      if (!key || hiddenSet.has(key)) continue;
      deleteKeys.push(key);
    }
  }
  const deleteSet = new Set(deleteKeys);

  // Validate updates — no empty keys; delete wins if same key in both
  const cleaned = {};
  Object.entries(safeUpdates).forEach(([k, v]) => {
    const key = k.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
    if (key && !deleteSet.has(key)) cleaned[key] = String(v).trim();
  });

  if (Object.keys(cleaned).length === 0 && deleteKeys.length === 0) {
    return res.status(400).json({ success: false, error: "No valid updates or deletes" });
  }

  // ── Auto-fill missing defaults: when saving any key from a section,
  // also write all missing keys from that section with their defaults.
  // This ensures .env gets the full config on first save even if user
  // only changed one field (the rest show defaults but aren't in .env yet).
  // Skip keys that are being explicitly deleted in the same request.
  const envOnDisk = parseEnvFile();
  for (const section of SETTINGS_SCHEMA) {
    const sectionKeys = section.fields.map(f => f.key);
    const anySaved = sectionKeys.some(k => k in cleaned);
    if (anySaved) {
      for (const f of section.fields) {
        if (!(f.key in cleaned) && !(f.key in envOnDisk) && !deleteSet.has(f.key) && f.default !== undefined) {
          cleaned[f.key] = f.default;
        }
      }
    }
  }

  const result = updateEnvFile(cleaned, deleteKeys);
  if (result.success) {
    const summary = [];
    if (Object.keys(cleaned).length) summary.push(`updated ${Object.keys(cleaned).length}: ${Object.keys(cleaned).join(", ")}`);
    if (deleteKeys.length) summary.push(`deleted ${deleteKeys.length}: ${deleteKeys.join(", ")}`);
    console.log(`[settings] ${summary.join(" | ")}`,
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
    const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
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
      (function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();
      function go(e){e.preventDefault();var s=document.getElementById('secretInput').value;if(!s)return;window.location='/settings?secret='+encodeURIComponent(s);}
      ${req.query.secret ? "document.getElementById('authErr').style.display='block';" : ""}
      </script></body></html>`);
  }

  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const envData    = parseEnvFile();

  // ── Determine which fields should be frozen (disabled but values kept) ──
  const vixEnabled      = (envData["VIX_FILTER_ENABLED"] ?? process.env.VIX_FILTER_ENABLED ?? "true") === "true";
  const scalpVixEnabled = (envData["SCALP_VIX_ENABLED"]  ?? process.env.SCALP_VIX_ENABLED  ?? "false") === "true";
  const paVixEnabled    = (envData["PA_VIX_ENABLED"]     ?? process.env.PA_VIX_ENABLED     ?? "false") === "true";
  const scalpModeOn     = (envData["SCALP_MODE_ENABLED"] ?? process.env.SCALP_MODE_ENABLED ?? "true").toLowerCase() === "true";

  function isFieldFrozen(key) {
    // Per-module VIX thresholds frozen when that module's VIX toggle is off
    if ((key === "VIX_MAX_ENTRY" || key === "VIX_STRONG_ONLY") && !vixEnabled) return true;
    if ((key === "SCALP_VIX_MAX_ENTRY" || key === "SCALP_VIX_STRONG_ONLY") && !scalpVixEnabled) return true;
    if ((key === "PA_VIX_MAX_ENTRY"    || key === "PA_VIX_STRONG_ONLY")    && !paVixEnabled)    return true;
    // Scalp section frozen when scalp mode is off (but not the master toggle itself)
    if (key.startsWith("SCALP_") && key !== "SCALP_MODE_ENABLED" && !scalpModeOn) return true;
    return false;
  }

  // Build field HTML for each section
  function renderField(f) {
    const val = envData[f.key] ?? process.env[f.key] ?? f.default ?? "";
    const eff = f.effect || EFFECT.INSTANT;
    const effBadge = `<span class="effect-badge" style="--ec:${eff.color}" title="${eff.tip}"><span class="effect-icon">${eff.icon}</span>${eff.label}<span class="info-i">i</span></span><span class="env-key-tag">${f.key}</span>`;
    const descText = f.desc || "";
    const descHtml = descText ? `<div class="field-desc">${descText}</div>` : "";
    const frozen = isFieldFrozen(f.key);
    const dis = frozen ? "disabled" : "";
    let frozenGroup = "";
    if (f.key === "SCALP_VIX_MAX_ENTRY" || f.key === "SCALP_VIX_STRONG_ONLY") frozenGroup = "scalp-vix";
    else if (f.key === "PA_VIX_MAX_ENTRY" || f.key === "PA_VIX_STRONG_ONLY") frozenGroup = "pa-vix";
    else if (f.key.startsWith("SCALP_"))   frozenGroup = "scalp";
    else if (f.key.startsWith("VIX_"))     frozenGroup = "vix";
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

  // Group consecutive PA_PATTERN_* fields into a 2-column grid wrapper
  function renderSectionFields(fields) {
    const out = [];
    let group = [];
    const flushGroup = () => {
      if (group.length) {
        out.push(`<div class="pattern-grid">${group.join("")}</div>`);
        group = [];
      }
    };
    for (const f of fields) {
      if (f.key.startsWith("PA_PATTERN_")) {
        group.push(renderField(f));
      } else {
        flushGroup();
        out.push(renderField(f));
      }
    }
    flushGroup();
    return out.join("");
  }

  // Build a flat key→default map so the client can populate the form with
  // schema defaults on demand (used by the "Load Defaults" button per section).
  const SCHEMA_DEFAULTS = {};
  SETTINGS_SCHEMA.forEach(s => s.fields.forEach(f => {
    if (f.default !== undefined) SCHEMA_DEFAULTS[f.key] = String(f.default);
  }));

  const sectionsHtml = SETTINGS_SCHEMA.map((s, idx) => {
    const sectionId = s.section.replace(/\s+/g, "-").toLowerCase();
    const eyeBtn = `<button type="button" class="section-eye-btn" onclick="event.stopPropagation();showSectionSummary(${idx})" title="View all configured values">👁</button>`;
    const defaultsBtn = `<button type="button" class="section-defaults-btn" onclick="event.stopPropagation();loadSectionDefaults('${sectionId}')" title="Fill all fields in this section with the recommended schema defaults — does NOT save until you click Save Changes">↺ Load Defaults</button>`;
    const openClass = idx === 0 ? ' open' : '';
    const fieldCount = s.fields.length;
    return `
    <div class="settings-section${openClass}" data-section="${sectionId}">
      <div class="section-title" onclick="toggleSection(this)">
        <span class="section-chevron">▶</span>
        ${s.icon} ${s.section}
        <span style="font-size:0.6rem;color:var(--dim);font-weight:500;letter-spacing:0;text-transform:none;">${fieldCount} settings</span>
        ${defaultsBtn}
        ${eyeBtn}
      </div>
      <div class="section-card">
        ${renderSectionFields(s.fields)}
      </div>
    </div>`;
  }).join("");

  const sectionSummaryJSON = JSON.stringify(sectionSummaries);
  const schemaDefaultsJSON = JSON.stringify(SCHEMA_DEFAULTS);

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
    :root[data-theme="light"] {
      --bg:       #f4f6f9;
      --surface:  #ffffff;
      --surface2: #f8fafc;
      --border:   #e0e4ea;
      --border2:  #cbd5e1;
      --text:     #334155;
      --text2:    #1e293b;
      --muted:    #64748b;
      --dim:      #94a3b8;
      --accent:   #2563eb;
      --green:    #059669;
      --red:      #dc2626;
      --yellow:   #d97706;
      --purple:   #7c3aed;
    }
    :root[data-theme="light"] .save-bar { background:rgba(255,255,255,0.95); }
    :root[data-theme="light"] .toggle-slider { background:#e2e8f0; border-color:#cbd5e1; }
    :root[data-theme="light"] .toggle-slider::before { background:#ffffff; box-shadow:0 1px 3px rgba(0,0,0,0.15); }
    :root[data-theme="light"] .toggle-switch input:checked + .toggle-slider { background:#059669; border-color:#047857; }
    :root[data-theme="light"] .toggle-switch input:checked + .toggle-slider::before { background:#ffffff; box-shadow:0 0 6px rgba(5,150,105,0.3); }
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

    /* ── Breadcrumb ── */
    .breadcrumb {
      display: flex; align-items: center; gap: 6px;
      font-size: 0.68rem; font-weight: 600;
      margin-bottom: 6px;
    }
    .bc-link {
      color: var(--muted); text-decoration: none;
      padding: 2px 6px; border-radius: 4px;
      transition: color 0.15s, background 0.15s;
    }
    .bc-link:hover { color: var(--accent); background: var(--surface2); }
    .bc-sep { color: var(--dim); font-size: 0.75rem; }
    .bc-current { color: var(--text2); padding: 2px 6px; }

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
    .settings-section { margin-bottom: 16px; }
    .section-title {
      font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1.5px; color: var(--muted);
      margin-bottom: 0;
      display: flex; align-items: center; gap: 10px;
      cursor: pointer; user-select: none;
      padding: 12px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      transition: all 0.2s;
    }
    .section-title:hover { background: var(--surface2); border-color: var(--border2); }
    .settings-section.open > .section-title { border-radius: 12px 12px 0 0; border-bottom-color: transparent; }
    .section-title::after { content:''; flex:1; height:1px; background:var(--border); }
    .section-chevron {
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; font-size: 0.65rem; color: var(--muted);
      transition: transform 0.25s ease; flex-shrink: 0;
    }
    .settings-section.open .section-chevron { transform: rotate(90deg); }
    .section-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-top: none;
      border-radius: 0 0 12px 12px;
      overflow: hidden;
      max-height: 0;
      opacity: 0;
      transition: max-height 0.35s ease, opacity 0.25s ease;
    }
    .settings-section.open > .section-card {
      max-height: 5000px;
      opacity: 1;
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

    /* ── Pattern toggle grid (2-col, fills whitespace on PA section) ── */
    .pattern-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid var(--border);
    }
    .pattern-grid .setting-row {
      border-bottom: 1px solid var(--border);
      border-right: 1px solid var(--border);
    }
    .pattern-grid .setting-row:nth-child(2n) { border-right: none; }
    /* Strip bottom border on the final row(s) — grid wrapper provides it */
    .pattern-grid .setting-row:last-child { border-bottom: none; }
    .pattern-grid .setting-row:nth-last-child(2):nth-child(odd) { border-bottom: none; }

    /* ── Frozen (disabled) rows ──────────────────────────── */
    .setting-row.frozen { opacity: 0.4; pointer-events: none; }
    .setting-row.frozen input,
    .setting-row.frozen select { cursor: not-allowed; }
    .setting-row.frozen .toggle-slider { cursor: not-allowed; }

    /* ── Holiday eye button ────────────────────────────────── */
    /* ── Env key tag after effect badge ──────────────────── */
    .env-key-tag {
      font-size: 0.55rem; font-family: 'JetBrains Mono', monospace;
      color: #4a6080; background: rgba(74,96,128,0.1);
      border: 1px solid rgba(74,96,128,0.2); border-radius: 3px;
      padding: 1px 6px; margin-left: 6px; vertical-align: middle;
      letter-spacing: 0.3px; user-select: all;
    }

    /* ── Section eye button ──────────────────────────────── */
    .section-eye-btn {
      background: none; border: 1px solid var(--border); border-radius: 6px;
      padding: 3px 8px; cursor: pointer; color: var(--muted); font-size: 0.7rem;
      transition: all 0.15s; flex-shrink: 0; margin-left: 8px;
    }
    .section-eye-btn:hover { border-color: var(--accent); color: var(--accent); }
    /* ── Section "Load Defaults" button ─────────────────── */
    .section-defaults-btn {
      background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.3);
      border-radius: 6px; padding: 3px 10px; cursor: pointer;
      color: var(--yellow); font-size: 0.65rem; font-weight: 700;
      letter-spacing: 0.5px; transition: all 0.15s; flex-shrink: 0; margin-left: 8px;
      font-family: 'IBM Plex Mono', monospace;
    }
    .section-defaults-btn:hover { background: rgba(251,191,36,0.18); border-color: var(--yellow); }

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

    /* ── Quick-links bar (always visible, not collapsible) ── */
    .quick-links-bar {
      display:flex; flex-wrap:wrap; align-items:center; gap:10px;
      padding:12px 16px; margin-bottom:16px;
      background: var(--surface); border:1px solid var(--border); border-radius:10px;
    }
    .quick-links-label {
      font-size:0.68rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px;
      color: var(--muted); margin-right:4px;
    }

    /* ── Quick-link pill (replaces the removed sidebar items) ── */
    .quick-link-pill {
      display:inline-flex; align-items:center; gap:6px;
      padding:8px 14px; border-radius:8px;
      font-size:0.78rem; font-weight:600; text-decoration:none;
      color: var(--text2);
      background: var(--surface2);
      border: 1px solid var(--border);
      transition: border-color 0.15s, background 0.15s;
    }
    .quick-link-pill:hover { border-color: var(--accent); background: var(--surface); }

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

    /* ── Bulk paste section ──────────────────────────────── */
    .bulk-section { padding: 18px 20px 20px; }
    .bulk-section textarea {
      width: 100%; min-height: 220px; resize: vertical;
      background: var(--input-bg, #0a1528); color: var(--text);
      border: 1px solid var(--border); border-radius: 8px;
      padding: 12px 14px; font-family: 'IBM Plex Mono', monospace;
      font-size: 0.78rem; line-height: 1.55; letter-spacing: 0.2px;
    }
    .bulk-section textarea:focus { outline: none; border-color: var(--accent); }
    .bulk-section .bulk-hint {
      font-size: 0.68rem; color: var(--muted); margin: 4px 0 10px; line-height: 1.5;
    }
    .bulk-section .bulk-actions {
      display: flex; gap: 10px; justify-content: flex-end; margin-top: 12px; flex-wrap: wrap;
    }
    .btn-bulk-update {
      background: rgba(245,158,11,0.10); color: #f59e0b; border: 1px solid #92400e;
      padding: 10px 22px; border-radius: 8px; font-weight: 700; font-size: 0.82rem;
      cursor: pointer; font-family: inherit; transition: all 0.15s;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .btn-bulk-update:hover { background: rgba(245,158,11,0.18); border-color: #f59e0b; }
    .btn-bulk-update:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-bulk-clear {
      background: transparent; color: var(--muted); border: 1px solid var(--border);
      padding: 10px 18px; border-radius: 8px; font-weight: 600; font-size: 0.82rem;
      cursor: pointer; font-family: inherit;
    }
    .btn-bulk-clear:hover { color: var(--red); border-color: var(--red); }
    .bulk-preview {
      margin-top: 10px; padding: 10px 14px; background: rgba(59,130,246,0.06);
      border: 1px solid rgba(59,130,246,0.15); border-radius: 8px;
      font-size: 0.72rem; color: #93c5fd; display: none;
    }
    .bulk-preview.visible { display: block; }

    /* ── Mobile ──────────────────────────────────────────── */
    @media (max-width:640px) {
      .page { padding: 16px 14px 40px; }
      .top-bar { padding: 14px 14px 14px 50px; }
      .setting-row { padding: 12px 14px; flex-wrap: wrap; }
      .pattern-grid { grid-template-columns: 1fr; }
      .pattern-grid .setting-row { border-right: none; }
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
        <nav class="breadcrumb" aria-label="Breadcrumb">
          <a href="/" class="bc-link">⌂ Dashboard</a>
          <span class="bc-sep">›</span>
          <span class="bc-current">⚙ Settings</span>
        </nav>
        <div class="top-bar-title">Settings</div>
        <div class="top-bar-meta">Configure trading parameters — changes apply without server restart</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;">
        <a href="/monitor" style="padding:6px 14px;background:rgba(168,139,250,0.12);color:#a78bfa;border:1px solid rgba(168,139,250,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;text-decoration:none;">📈 MONITOR</a>
        <a href="/docs" style="padding:6px 14px;background:rgba(245,158,11,0.12);color:#f59e0b;border:1px solid rgba(245,158,11,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;text-decoration:none;">📄 DOCS</a>
        <a href="/pnl-history" style="padding:6px 14px;background:rgba(251,191,36,0.12);color:#fbbf24;border:1px solid rgba(251,191,36,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;text-decoration:none;">💰 P&amp;L HISTORY</a>
        <a href="/login-logs" style="padding:6px 14px;background:rgba(239,68,68,0.12);color:#f87171;border:1px solid rgba(239,68,68,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;text-decoration:none;">🔐 LOGIN LOGS</a>
        <button onclick="showHealthModal()" style="padding:6px 14px;background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;">HEALTH CHECK</button>
        <button onclick="showEnvModal()" style="padding:6px 14px;background:rgba(59,130,246,0.12);color:#60a5fa;border:1px solid rgba(59,130,246,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;">VIEW .env</button>
        <button onclick="showBulkModal()" title="Paste KEY=VALUE pairs to bulk update .env, then restart" style="padding:6px 14px;background:rgba(245,158,11,0.12);color:#f59e0b;border:1px solid rgba(245,158,11,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;">📋 BULK EDIT</button>
        <button onclick="resetAndSaveAll()" title="Write every field on this page to .env (not just dirty ones). Useful after code updates that add new settings with defaults — flushes those defaults into .env. Does NOT change values shown on screen." style="padding:6px 14px;background:rgba(251,191,36,0.12);color:#fbbf24;border:1px solid rgba(251,191,36,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;">💾 SAVE ALL → .env</button>
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
function toggleSection(titleEl) {
  var section = titleEl.parentElement;
  var willOpen = !section.classList.contains('open');
  // Accordion: close every other settings-section first
  if (willOpen) {
    document.querySelectorAll('.settings-section.open').forEach(function(s){
      if (s !== section) s.classList.remove('open');
    });
  }
  section.classList.toggle('open');
}

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
  if (key === 'SCALP_VIX_ENABLED')  toggleFreezeGroup('scalp-vix', !el.checked);
  if (key === 'PA_VIX_ENABLED')     toggleFreezeGroup('pa-vix', !el.checked);
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
  var vixOrig      = window._originals['VIX_FILTER_ENABLED'];
  var scalpOrig    = window._originals['SCALP_MODE_ENABLED'];
  var scalpVixOrig = window._originals['SCALP_VIX_ENABLED'];
  var paVixOrig    = window._originals['PA_VIX_ENABLED'];
  toggleFreezeGroup('vix',       vixOrig      !== true && vixOrig      !== 'true');
  toggleFreezeGroup('scalp',     scalpOrig    !== true && scalpOrig    !== 'true');
  toggleFreezeGroup('scalp-vix', scalpVixOrig !== true && scalpVixOrig !== 'true');
  toggleFreezeGroup('pa-vix',    paVixOrig    !== true && paVixOrig    !== 'true');
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

async function resetAndSaveAll() {
  var ok = await showConfirm({
    icon: '💾', title: 'Save All Fields to .env',
    message: 'This writes EVERY field on this page to .env (not just the ones you changed).\\n\\nUI values will not change. Use this after code updates so new defaults get persisted into .env.\\n\\nContinue?',
    confirmText: 'Save All', confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;

  // Collect every field value regardless of dirty state
  var updates = {};
  document.querySelectorAll('[data-key]').forEach(function(el) {
    var key = el.getAttribute('data-key');
    if (!key) return;
    if (el.type === 'checkbox') {
      updates[key] = el.checked ? 'true' : 'false';
    } else {
      updates[key] = el.value;
    }
  });

  if (Object.keys(updates).length === 0) {
    showToast('No settings fields found', 'error');
    return;
  }

  showToast('Writing ' + Object.keys(updates).length + ' fields to .env...', 'info');

  secretFetch('/settings/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: updates }),
  })
  .then(function(res) { return res ? res.json() : null; })
  .then(function(data) {
    if (!data) return;
    if (data.success) {
      // Refresh originals so dirty tracking resets
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

      var msg = 'Save All complete — ' + (data.updatedCount || Object.keys(updates).length) + ' fields written to .env';
      if (!data.fileSaved) {
        showToast(msg + ' ⚠️ NOT PERSISTED: ' + (data.fileError || 'unknown'), 'error');
      } else if (data.needsRestart && data.needsRestart.length > 0) {
        showToast(msg + '. Restart session to pick up: ' + data.needsRestart.join(', '), 'info');
      } else {
        showToast(msg + ' — .env now mirrors UI', 'success');
      }
    } else {
      showToast('Save All failed: ' + (data.error || 'unknown'), 'error');
    }
  })
  .catch(function(err) {
    var msg = err.name === 'AbortError' ? 'Request timed out' : err.message;
    showToast('Save All failed: ' + msg, 'error');
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

// ── Bulk paste: parse KEY=VALUE pairs from textarea ──────────────────────
// Lines starting with "-" (e.g. "-PA_MIN_RR") mark that key for deletion.
function parseBulkPaste(text) {
  var out = {};
  var deletes = [];
  var skipped = [];
  if (!text) return { updates: out, deletes: deletes, skipped: skipped };
  var lines = text.split(/\\r?\\n/);
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var line = raw.trim();
    if (!line || line.charAt(0) === '#') continue;
    // Strip "export " prefix if present
    if (line.toLowerCase().indexOf('export ') === 0) line = line.slice(7).trim();
    // Deletion syntax: "-KEY" or "- KEY"  (no '=' sign needed)
    if (line.charAt(0) === '-' && line.indexOf('=') === -1 && line.indexOf(':') === -1) {
      var dkey = line.slice(1).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
      if (!dkey) { skipped.push(raw); continue; }
      if (dkey.indexOf('SECRET') >= 0 || dkey.indexOf('TOKEN') >= 0 || dkey.indexOf('ACCESS') >= 0) {
        skipped.push(dkey + ' (sensitive — cannot delete)');
        continue;
      }
      if (deletes.indexOf(dkey) === -1) deletes.push(dkey);
      // If the same key appears as an update above, remove it — delete wins
      if (dkey in out) delete out[dkey];
      continue;
    }
    // Support KEY=VALUE or KEY: VALUE
    var eq = line.indexOf('=');
    var colon = line.indexOf(':');
    var sep = -1;
    if (eq !== -1 && (colon === -1 || eq < colon)) sep = eq;
    else if (colon !== -1) sep = colon;
    if (sep === -1) { skipped.push(raw); continue; }
    var key = line.slice(0, sep).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    var val = line.slice(sep + 1).trim();
    // Strip trailing inline comment (only when not inside quotes)
    if (val.charAt(0) !== '"' && val.charAt(0) !== "'") {
      var hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    // Strip surrounding quotes
    if ((val.charAt(0) === '"' && val.charAt(val.length-1) === '"') ||
        (val.charAt(0) === "'" && val.charAt(val.length-1) === "'")) {
      val = val.slice(1, -1);
    }
    if (!key) { skipped.push(raw); continue; }
    // Skip sensitive keys (server also strips them, but warn user)
    if (key.indexOf('SECRET') >= 0 || key.indexOf('TOKEN') >= 0 || key.indexOf('ACCESS') >= 0) {
      skipped.push(key + ' (sensitive — ignored)');
      continue;
    }
    // If this key was queued for deletion earlier, the later update wins
    var didx = deletes.indexOf(key);
    if (didx !== -1) deletes.splice(didx, 1);
    out[key] = val;
  }
  return { updates: out, deletes: deletes, skipped: skipped };
}

function previewBulkPaste() {
  var box = document.getElementById('bulkPasteBox');
  var pv  = document.getElementById('bulkPreview');
  if (!box || !pv) return;
  var parsed = parseBulkPaste(box.value);
  var updCount = Object.keys(parsed.updates).length;
  var delCount = parsed.deletes.length;
  if (updCount === 0 && delCount === 0 && parsed.skipped.length === 0) {
    pv.classList.remove('visible');
    pv.textContent = '';
    return;
  }
  var parts = [];
  if (updCount) parts.push(updCount + ' update' + (updCount === 1 ? '' : 's'));
  if (delCount) parts.push(delCount + ' delete' + (delCount === 1 ? '' : 's'));
  if (parsed.skipped.length) parts.push(parsed.skipped.length + ' skipped');
  pv.textContent = parts.join(' · ');
  pv.classList.add('visible');
}

function clearBulkPaste() {
  var box = document.getElementById('bulkPasteBox');
  if (box) box.value = '';
  previewBulkPaste();
}

async function bulkUpdateAndRestart() {
  var box = document.getElementById('bulkPasteBox');
  var btn = document.getElementById('bulkUpdateBtn');
  if (!box) return;
  var parsed = parseBulkPaste(box.value);
  var updates = parsed.updates;
  var deletes = parsed.deletes || [];
  var keys = Object.keys(updates);
  if (keys.length === 0 && deletes.length === 0) {
    showToast('No valid KEY=VALUE pairs or -KEY deletes found', 'error');
    return;
  }

  var previewParts = [];
  keys.slice(0, 6).forEach(function(k){ previewParts.push(k + '=' + updates[k]); });
  if (keys.length > 6) previewParts.push('...and ' + (keys.length - 6) + ' more update(s)');
  deletes.slice(0, 6).forEach(function(k){ previewParts.push('− ' + k + '  (delete)'); });
  if (deletes.length > 6) previewParts.push('...and ' + (deletes.length - 6) + ' more delete(s)');
  var previewList = previewParts.join('\\n');

  var msgHead = 'Apply ' + keys.length + ' update' + (keys.length === 1 ? '' : 's');
  if (deletes.length) msgHead += ' and remove ' + deletes.length + ' key' + (deletes.length === 1 ? '' : 's');
  msgHead += ' and restart the server?';

  var ok = await showConfirm({
    icon: '🚀',
    title: 'Bulk Update & Restart',
    message: msgHead + '\\n\\n' + previewList + '\\n\\nActive trading sessions will stop. Page will reload.',
    confirmText: 'Update & Restart',
    confirmClass: 'modal-btn-danger'
  });
  if (!ok) return;

  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Saving...';

  try {
    var res = await secretFetch('/settings/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: updates, deletes: deletes }),
    });
    if (!res) { btn.disabled = false; btn.innerHTML = '<span>🚀</span> Update & Restart'; return; }
    var data = await res.json();
    if (!data.success) {
      showToast('Save failed: ' + (data.error || 'unknown'), 'error');
      btn.disabled = false;
      btn.innerHTML = '<span>🚀</span> Update & Restart';
      return;
    }
    if (!data.fileSaved) {
      showToast('⚠️ .env write failed: ' + (data.fileError || 'unknown') + ' — not restarting', 'error');
      btn.disabled = false;
      btn.innerHTML = '<span>🚀</span> Update & Restart';
      return;
    }

    var savedParts = [];
    if (data.updatedCount) savedParts.push(data.updatedCount + ' updated');
    if (data.deletedCount) savedParts.push(data.deletedCount + ' deleted');
    showToast((savedParts.join(', ') || 'no changes') + ' — restarting server...', 'info');
    btn.innerHTML = '<span>⏳</span> Restarting...';

    secretFetch('/settings/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).catch(function(){}); // server dies mid-request

    // Poll until server back
    var attempts = 0;
    var poller = setInterval(function() {
      attempts++;
      if (attempts > 30) {
        clearInterval(poller);
        btn.disabled = false;
        btn.innerHTML = '<span>🚀</span> Update & Restart';
        showToast('Server did not come back — check manually', 'error');
        return;
      }
      fetch('/settings/data', { method: 'GET' })
        .then(function(r) {
          if (r.ok) {
            clearInterval(poller);
            showToast('Server restarted — reloading...', 'success');
            setTimeout(function(){ window.location.reload(); }, 500);
          }
        })
        .catch(function(){});
    }, 1000);
  } catch (err) {
    showToast('Update failed: ' + (err.message || err), 'error');
    btn.disabled = false;
    btn.innerHTML = '<span>🚀</span> Update & Restart';
  }
}

// ── .env viewer ─────────────────────────────────────────────────────────
var _envData={};
function showBulkModal(){
  document.getElementById('bulkModal').style.display='block';
  setTimeout(function(){ var t=document.getElementById('bulkPasteBox'); if(t) t.focus(); }, 50);
}

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

// ── Health Check Modal ──────────────────────────────────────────────────────
async function showHealthModal() {
  var modal = document.getElementById('healthModal');
  var body  = document.getElementById('healthBody');
  if (!modal || !body) return;
  body.innerHTML = '<div style="text-align:center;color:#4a6080;padding:20px;">Checking system health...</div>';
  modal.style.display = 'block';
  try {
    var res = await fetch('/health', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var d = await res.json();
    var allOk = d.status === 'ok';
    var uptimeStr = d.uptime >= 3600
      ? Math.floor(d.uptime/3600) + 'h ' + Math.floor((d.uptime%3600)/60) + 'm'
      : Math.floor(d.uptime/60) + 'm ' + (d.uptime%60) + 's';
    var rows = [
      { label: 'Status',        value: d.status === 'ok' ? 'ALL OK' : d.status, ok: d.status === 'ok' },
      { label: 'Uptime',        value: uptimeStr, ok: true },
      { label: 'Memory',        value: d.memoryMB + ' MB', ok: d.memoryMB < 500 },
      { label: 'Fyers Auth',    value: d.fyers ? 'Connected' : 'Not logged in', ok: d.fyers },
      { label: 'Zerodha Auth',  value: d.zerodha ? 'Connected' : 'Not logged in', ok: d.zerodha },
      { label: 'Trading Mode',  value: d.activeMode || 'Idle', ok: true },
      { label: 'Scalp Mode',    value: d.scalpMode || 'Idle', ok: true },
    ];
    var html = '<div style="text-align:center;margin-bottom:16px;">';
    html += allOk
      ? '<div style="font-size:2.5rem;margin-bottom:4px;">✅</div><div style="font-size:1.1rem;font-weight:800;color:#10b981;">ALL SYSTEMS OK</div>'
      : '<div style="font-size:2.5rem;margin-bottom:4px;">⚠️</div><div style="font-size:1.1rem;font-weight:800;color:#f59e0b;">DEGRADED</div>';
    html += '</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:0.82rem;font-family:IBM Plex Mono,monospace;">';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var bg = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)';
      var dot = r.ok ? '<span style="color:#10b981;margin-right:6px;">●</span>' : '<span style="color:#ef4444;margin-right:6px;">●</span>';
      html += '<tr style="border-bottom:1px solid #0e1428;background:' + bg + '">';
      html += '<td style="padding:8px 12px;color:#8aa1bd;">' + r.label + '</td>';
      html += '<td style="padding:8px 12px;color:#e0eaf8;text-align:right;">' + dot + r.value + '</td>';
      html += '</tr>';
    }
    html += '</table>';
    html += '<div style="margin-top:12px;color:#4a6080;font-size:0.68rem;text-align:center;">Last checked: ' + new Date(d.timestamp).toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata', hour12:false}) + ' IST</div>';
    body.innerHTML = html;
  } catch(e) {
    body.innerHTML = '<div style="text-align:center;padding:20px;"><div style="font-size:2.5rem;margin-bottom:8px;">❌</div><div style="color:#ef4444;font-weight:700;">Health check failed</div><div style="color:#4a6080;font-size:0.75rem;margin-top:6px;">' + e.message + '</div></div>';
  }
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
var _schemaDefaults   = ${schemaDefaultsJSON};
var _sectionNames = { 0: 'Trading Strategy (15-min)', 1: 'Scalping Strategy (BB+CPR)' };

// ── Load Defaults (per section) ────────────────────────────────────────────
// Populates every input in the section with its schema default, marks dirty,
// but does NOT save — user reviews then clicks "Save Changes".
function loadSectionDefaults(sectionId) {
  var section = document.querySelector('[data-section="' + sectionId + '"]');
  if (!section) return;
  var changed = 0, skipped = 0;
  section.querySelectorAll('[data-key]').forEach(function(el) {
    if (el.disabled) { skipped++; return; }
    var key = el.getAttribute('data-key');
    if (!key) return;
    var def = _schemaDefaults[key];
    if (def === undefined) return;
    if (el.type === 'checkbox') {
      var want = (def === 'true' || def === '1');
      if (el.checked !== want) { el.checked = want; markDirty(el); changed++; }
    } else if (el.tagName === 'SELECT') {
      if (el.value !== def) { el.value = def; markDirty(el); changed++; }
    } else {
      if (String(el.value) !== String(def)) { el.value = def; markDirty(el); changed++; }
    }
  });
  if (changed > 0) {
    showToast('Loaded ' + changed + ' default value' + (changed > 1 ? 's' : '') + ' — review and click Save Changes', 'info');
  } else {
    showToast('All values already match recommended defaults', 'info');
  }
}

var _summaryClipboard = '';

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
  var clipLines = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var el = document.querySelector('[data-key="' + f.key + '"]');
    var val = f.value;
    if (el) {
      val = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value;
    }
    clipLines.push(f.key + '=' + val);
    var valClass = 'val-text';
    if (val === 'true') valClass = 'val-true';
    else if (val === 'false') valClass = 'val-false';
    else if (f.type === 'number' || !isNaN(parseFloat(val))) valClass = 'val-num';

    var displayVal = val === 'true' ? 'ON' : val === 'false' ? 'OFF' : (val || '—');
    html += '<tr><td><div class="summary-label">' + f.label + '</div><div class="summary-key">' + f.key + '</div></td><td class="' + valClass + '">' + displayVal + '</td></tr>';
  }
  html += '</table>';
  _summaryClipboard = clipLines.join('\\n');
  bodyEl.innerHTML = html;
  modal.style.display = 'block';
  // Reset copy button state
  var btn = document.getElementById('summaryCopyBtn');
  if (btn) { btn.textContent = 'COPY'; btn.style.color = '#10b981'; btn.style.background = 'rgba(16,185,129,0.12)'; }
}

function copySectionSummary() {
  navigator.clipboard.writeText(_summaryClipboard).then(function() {
    var btn = document.getElementById('summaryCopyBtn');
    btn.textContent = 'COPIED!'; btn.style.color = '#fff'; btn.style.background = '#10b981';
    setTimeout(function() { btn.textContent = 'COPY'; btn.style.color = '#10b981'; btn.style.background = 'rgba(16,185,129,0.12)'; }, 1500);
  });
}
</script>
<!-- Section summary modal -->
<div id="sectionSummaryModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:560px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span id="sectionSummaryTitle" style="font-weight:700;font-size:0.95rem;color:#60a5fa;">Settings Summary</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="summaryCopyBtn" onclick="copySectionSummary()" style="padding:4px 10px;background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.25);border-radius:5px;font-size:0.7rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">COPY</button>
        <button onclick="document.getElementById('sectionSummaryModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
      </div>
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
<!-- Bulk Edit modal -->
<div id="bulkModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:760px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span style="font-weight:700;font-size:0.95rem;color:#f59e0b;">📋 Bulk Edit .env <span style="font-size:0.65rem;color:var(--dim);font-weight:500;letter-spacing:0;margin-left:6px;">paste → save → restart</span></span>
      <button onclick="document.getElementById('bulkModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
    </div>
    <div class="bulk-section" style="padding:18px 20px 20px;">
      <div class="bulk-hint">
        Paste <strong>KEY=VALUE</strong> pairs (one per line) to add/update. Prefix a line with <strong>-</strong> (e.g. <code>-OLD_KEY</code>) to <strong>remove</strong> that key from .env.<br/>
        Supports <code>KEY=VALUE</code>, <code>KEY: VALUE</code>, quoted values, and <code>#</code> comment lines.
        Sensitive keys (SECRET/TOKEN/ACCESS) are ignored for both updates and deletes. Applies everything and restarts the server.
      </div>
      <textarea id="bulkPasteBox" spellcheck="false" oninput="previewBulkPaste()" placeholder="# Paste your config here&#10;SCALP_RSI_CE_THRESHOLD=55&#10;VIX_MAX_ENTRY=25&#10;&#10;# Delete dead keys with a leading dash:&#10;-SCALP_ADX_ENABLED&#10;-SCALP_RSI_CE_MIN"></textarea>
      <div class="bulk-preview" id="bulkPreview"></div>
      <div class="bulk-actions">
        <button class="btn-bulk-clear" onclick="clearBulkPaste()">Clear</button>
        <button class="btn-bulk-update" id="bulkUpdateBtn" onclick="bulkUpdateAndRestart()">
          <span>🚀</span> Update &amp; Restart
        </button>
      </div>
    </div>
  </div>
</div>
<!-- Health Check modal -->
<div id="healthModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:480px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span style="font-weight:700;font-size:0.95rem;color:#10b981;">System Health</span>
      <button onclick="document.getElementById('healthModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
    </div>
    <div id="healthBody" style="padding:20px;">
      <div style="color:#4a6080;font-size:0.8rem;text-align:center;">Checking...</div>
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

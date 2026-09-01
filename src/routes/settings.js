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
const { resolveTheme } = require("../utils/theme");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS,
        expiryHolidayModalCSS, expiryHolidayModalHTML, expiryHolidayModalJS } = require("../utils/sharedNav");
const settingsAudit = require("../utils/settingsAudit");
const tradeLogger   = require("../utils/tradeLogger");
const skipLogger    = require("../utils/skipLogger");
const tickRecorder  = require("../utils/tickRecorder");
const { logStore }  = require("../services/logger");

// Use process.cwd() for the .env path — this is where Node was started,
// which is always the project root (where .env lives).
// __dirname resolves to the compiled/deployed path which may differ on EC2.
const ENV_PATH = path.join(process.cwd(), ".env");

// ~/trading-data — used by the /settings/reset-data cache wipe.
const TRADING_DATA_DIR = path.join(require("os").homedir(), "trading-data");

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
    section: "EMA_RSI_ST STRATEGY (EMA 20/50 + RSI + SuperTrend) — Zerodha",
    icon: "📊",
    nav: "EMA_RSI_ST",
    group: "Strategies",
    fields: [
      { key: "EMA_RSI_ST_LIVE_ENABLED", label: "EMA_RSI_ST Live Orders", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Zerodha.", subheader: "Mode & Session" },
      { key: "EMA_RSI_ST_LIVE_DRY_RUN", label: "EMA_RSI_ST Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep this strategy simulated even when live is on.", default: "false" },
      // Candle timeframe is GLOBAL — see TRADE_RESOLUTION in "Instrument & Backtest".
      { key: "TRADE_EXPIRY_DAY_ONLY", label: "Trade Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only trade on weekly expiry day.", default: "false" },
      { key: "TRADE_ENTRY_START", label: "Entry Start Time", type: "time", effect: EFFECT.SESSION, desc: "Earliest entry time (IST).", default: "10:30" },
      { key: "TRADE_ENTRY_END", label: "Entry End Time", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (IST).", default: "14:00" },
      { key: "EMA_RSI_ST_EOD_EXIT_TIME", label: "Exit Before Day Close", type: "time", effect: EFFECT.SESSION, desc: "Close any open position at this time (IST).", default: "14:30" },
      { key: "VIX_FILTER_ENABLED", label: "VIX Filter (EMA_RSI_ST)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block entries when VIX is high.", subheader: "Filters & Limits" },
      { key: "VIX_MAX_ENTRY", label: "EMA_RSI_ST VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Block entries above this VIX.", default: "20" },
      { key: "MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 50000, step: 500, effect: EFFECT.SESSION, desc: "Stop trading after this much loss.", default: "3000" },
      { key: "MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Max entries per day.", default: "5" },
      // ── Entry rule (all 3 must be true): EMA alignment + RSI gate + SuperTrend side ──
      { key: "EMA_RSI_ST_EMA_FAST", label: "EMA Fast/Mid Period", type: "number", min: 5, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "Fast EMA period.", default: "20", subheader: "Entry Signal" },
      { key: "EMA_RSI_ST_EMA_SLOW", label: "EMA Slow Period", type: "number", min: 20, max: 200, step: 1, effect: EFFECT.INSTANT, desc: "Slow EMA period.", default: "50" },
      { key: "EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED", label: "Triple-Stack EMA (9>20>50)", type: "toggle", effect: EFFECT.INSTANT, desc: "Require a 9>20>50 EMA stack (stricter).", default: "false" },
      { key: "EMA_RSI_ST_EMA_FASTEST", label: "EMA Fastest Period", type: "number", min: 5, max: 20, step: 1, effect: EFFECT.INSTANT, desc: "Fastest EMA period (triple-stack only).", default: "9" },
      { key: "EMA_RSI_ST_CLOSE_BEYOND_EMA_ENABLED", label: "Close Beyond Base EMA", type: "toggle", effect: EFFECT.INSTANT, desc: "Candle must close on the trade side of the EMA.", default: "true" },
      { key: "RSI_CE_MIN", label: "RSI CE Min (>)", type: "number", min: 45, max: 65, step: 1, effect: EFFECT.INSTANT, desc: "CE needs RSI above this.", default: "52" },
      { key: "RSI_CE_MAX", label: "RSI CE Max (< overbought)", type: "number", min: 60, max: 90, step: 1, effect: EFFECT.INSTANT, desc: "Block CE when RSI is this high (overbought).", default: "70" },
      { key: "RSI_PE_MAX", label: "RSI PE Max (<)", type: "number", min: 35, max: 55, step: 1, effect: EFFECT.INSTANT, desc: "PE needs RSI below this.", default: "48" },
      { key: "RSI_PE_MIN", label: "RSI PE Min (> oversold)", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Block PE when RSI is this low (oversold).", default: "30" },
      // ── Trend confirmation: SuperTrend (the only directional source) ──
      { key: "EMA_RSI_ST_CONFIRM_CANDLE_ENABLED", label: "Confirmation Candle (cross & close)", type: "toggle", effect: EFFECT.INSTANT, desc: "Wait for a second candle to confirm entry.", default: "true" },
      { key: "EMA_RSI_ST_SUPERTREND_PERIOD", label: "SuperTrend ATR Period", type: "number", min: 5, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "SuperTrend ATR period.", default: "10" },
      { key: "EMA_RSI_ST_SUPERTREND_MULT", label: "SuperTrend Multiplier", type: "number", min: 1, max: 6, step: 0.5, effect: EFFECT.INSTANT, desc: "SuperTrend band width multiplier.", default: "3" },
      // ── Stops & exits ──
      { key: "OPT_STOP_PCT", label: "Option Stop %", type: "number", min: 0.05, max: 0.50, step: 0.05, effect: EFFECT.SESSION, desc: "Exit if option premium drops this fraction.", default: "0.25", subheader: "Exits & Cooldowns" },
      { key: "EMA_RSI_ST_STOP_LOSS_PTS", label: "Stop Loss (pts)", type: "number", min: 0, max: 200, step: 5, effect: EFFECT.INSTANT, desc: "Max loss per trade in points (0 = off).", default: "25" },
      { key: "EMA_RSI_ST_MAX_CONSEC_LOSSES", label: "Chop Guard (consec losses)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Stop for the day after this many losses in a row (0 = off).", default: "0" },
      { key: "EMA_RSI_ST_NEG_CANDLE_LIMIT", label: "Negative-Candle Stop (candles)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Exit if still losing after this many candles (0 = off).", default: "2" },
      { key: "EMA_RSI_ST_INITIAL_SL_MODE", label: "Initial Stop — Prev Candle or EMA21", type: "select", options: [{ value: "prev_candle", label: "Previous candle low/high (default)" }, { value: "ema21", label: "EMA21 (same line the trail rides)" }], effect: EFFECT.INSTANT, desc: "Where the stop sits the moment you enter. Previous candle = today's rule: the stop is the last completed candle's low (CE) / high (PE) — structural, but often only a few points from the fill, so ordinary noise stops the trade out within seconds. EMA21 = seed the stop on the SAME EMA21 line the trail already rides, so entry protection and trail protection are one line. EMA21 usually sits further from price, which means fewer instant stop-outs but a bigger loss when it is hit. Applied only when EMA21 is on the protective side of the fill (below entry for CE, above for PE); otherwise the previous-candle stop is kept.", default: "prev_candle" },
      { key: "EMA_RSI_ST_EMA_EXIT_MODE", label: "EMA21 Exit — Touch or Cross &amp; Close", type: "select", options: [{ value: "touch", label: "Touch (legacy — a wick reaching EMA21 exits)" }, { value: "close", label: "Cross &amp; close (only a close beyond EMA21 exits)" }], effect: EFFECT.INSTANT, desc: "How the EMA21 line ends a trade. Touch = today's rule: the candle only has to REACH EMA21, and EMA21 is also the tick-by-tick stop, so a single wick closes the trade. Cross &amp; close = wicks through the line are held and the trade exits only when a candle CLOSES beyond EMA21 (CE on a close below it, PE on a close above). In cross &amp; close mode EMA21 stops being the tick stop — otherwise the first wick would stop you out anyway — so keep the Candle Trail on (or a points Stop Loss) to hold the hard stop.", default: "touch" },
      { key: "EMA_RSI_ST_CANDLE_TRAIL_ENABLED", label: "Candle Trail", type: "toggle", effect: EFFECT.INSTANT, desc: "Add a candle-based trailing stop.", default: "true" },
      { key: "EMA_RSI_ST_CANDLE_TRAIL_BARS", label: "Candle Trail (candles)", type: "number", min: 1, max: 5, step: 1, effect: EFFECT.INSTANT, desc: "Candles looked back for the trailing stop.", default: "3" },
      { key: "EMA_RSI_ST_SL_PAUSE_CANDLES", label: "Same-Side SL Cooldown (candles)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Pause the same side this many candles after a stop (0 = off).", default: "2" },
      { key: "EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED", label: "Opposite-Side Cooldown", type: "toggle", effect: EFFECT.SESSION, desc: "Pause the opposite side briefly after an exit.", default: "true" },
      { key: "EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES", label: "Opposite-Side Cooldown (candles)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Opposite-side cooldown length in candles.", default: "2" },
    ],
  },
  {
    section: "BB_RSI STRATEGY (BB+SuperTrend+RSI) — Fyers",
    icon: "⚡",
    nav: "BB_RSI",
    group: "Strategies",
    fields: [
      { key: "BB_RSI_ENABLED", label: "BB_RSI Live Orders", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Fyers.", default: "false", subheader: "Mode, Session & VIX" },
      { key: "BB_RSI_EXPIRY_DAY_ONLY", label: "BB_RSI Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only trade on weekly expiry day.", default: "false" },
      { key: "BB_RSI_VIX_ENABLED", label: "VIX Filter (BB_RSI)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block entries when VIX is high.", default: "false" },
      { key: "BB_RSI_VIX_MAX_ENTRY", label: "BB_RSI VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Block entries above this VIX.", default: "20" },
      { key: "BB_RSI_VIX_STRONG_ONLY", label: "BB_RSI VIX Strong Only", type: "number", min: 8, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "Above this VIX, allow only strong signals.", default: "16" },
      { key: "BB_RSI_RESOLUTION", label: "Candle Resolution (BB_RSI only)", type: "select", options: [{ value: "global", label: "Global (follow Instrument & Backtest)" }, { value: "3", label: "3 min" }, { value: "5", label: "5 min" }], effect: EFFECT.SESSION, desc: "Candle timeframe for BB_RSI alone, so you can test 3-min here without moving every other strategy. Also shortens every candle-counted rule below (SL pause, opposite-candle stop/trail, confirmation candle) in proportion.", default: "global" },
      { key: "BB_RSI_ENTRY_START", label: "Entry Start Time", type: "time", effect: EFFECT.SESSION, desc: "Earliest entry time (IST).", default: "09:21" },
      { key: "BB_RSI_ENTRY_END", label: "Entry End Time", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (IST).", default: "14:30" },
      // ── Direction, then the Bollinger inputs the triggers are built from ──
      { key: "BB_RSI_DIRECTION", label: "Trade Direction", type: "select", options: [{ value: "fade", label: "Fade the band (mean reversion)" }, { value: "breakout", label: "Trade the break (momentum)" }], effect: EFFECT.SESSION, desc: "Which way the SAME signal bars are traded. Fade = buy CE below the lower band (V8, the default). Breakout = buy CE ABOVE the upper band instead. Every filter, stop and trail below is shared, so this is a clean A/B. Breakout skips the BB-middle target — the mean is behind the entry, so it would exit on the entry bar — and leaves the stop, trail and EOD as the only exits. Leave the divergence filter OFF in breakout mode: it is an exhaustion tell.", default: "fade", subheader: "Entry Signal" },
      { key: "BB_RSI_BB_PERIOD", label: "BB Period", type: "number", min: 10, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Bollinger Band period.", default: "30" },
      { key: "BB_RSI_BB_STDDEV", label: "BB Std Dev", type: "number", min: 0.5, max: 3.0, step: 0.1, effect: EFFECT.SESSION, desc: "Bollinger Band standard deviation.", default: "2" },
      // ── RSI — the two thresholds name the EXTREME, not the option side, because
      //    which side each one buys now depends on BB_RSI_DIRECTION (fade: oversold
      //    → CE; breakout: oversold → PE). Ranges span 5–95 for both because the
      //    thresholds swapped ends of the scale when V8 inverted the entry side.
      { key: "BB_RSI_RSI_PERIOD", label: "RSI Period", type: "number", min: 7, max: 21, step: 1, effect: EFFECT.SESSION, desc: "RSI period.", default: "14" },
      { key: "BB_RSI_RSI_CE_THRESHOLD", label: "RSI Oversold (≤)", type: "number", min: 5, max: 95, step: 1, effect: EFFECT.SESSION, desc: "The lower-band trigger needs RSI at or below this. Fade buys CE on it; breakout buys PE.", default: "25" },
      { key: "BB_RSI_RSI_PE_THRESHOLD", label: "RSI Overbought (≥)", type: "number", min: 5, max: 95, step: 1, effect: EFFECT.SESSION, desc: "The upper-band trigger needs RSI at or above this. Fade buys PE on it; breakout buys CE.", default: "75" },
      { key: "BB_RSI_RSI_TURNING", label: "RSI Turning Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Also require RSI to have already turned back (CE: rising, PE: falling).", default: "false" },
      { key: "BB_RSI_CONFIRM_CANDLE_ENABLED", label: "Confirmation Candle (cross & close)", type: "toggle", effect: EFFECT.INSTANT, desc: "Wait for a second candle to confirm entry.", default: "true" },
      { key: "BB_RSI_CONFIRM_ON_CLOSE", label: "Confirm on candle close", type: "toggle", effect: EFFECT.INSTANT, desc: "Confirmation candle must CLOSE past the signal close (off = enter intra-bar on first cross).", default: "true" },
      { key: "BB_RSI_MAX_ENTRY_SL_PTS", label: "Max Entry SL (pts)", type: "number", min: 0, max: 200, step: 5, effect: EFFECT.SESSION, desc: "Skip entries whose signal candle is wider than this from close (0 = off).", default: "50" },
      // ── Chop guards — the sideways tape where every band touch is noise ──
      { key: "BB_RSI_BAND_WIDTH_ENABLED", label: "Band-Width Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Skip entries when the Bollinger band is too narrow to be a real stretch.", default: "true", subheader: "Chop Guards" },
      { key: "BB_RSI_MIN_BAND_WIDTH_PTS", label: "Min Band Width (pts)", type: "number", min: 0, max: 300, step: 5, effect: EFFECT.SESSION, desc: "Upper minus lower band must be at least this many points.", default: "50" },
      { key: "BB_RSI_RSI_RANGE_ENABLED", label: "RSI-Range Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Skip entries when RSI has been pinned mid-range (dead tape).", default: "true" },
      { key: "BB_RSI_RSI_RANGE_LOOKBACK", label: "RSI Range Lookback (candles)", type: "number", min: 5, max: 60, step: 1, effect: EFFECT.SESSION, desc: "How many candles before the signal bar to measure RSI travel over.", default: "20" },
      { key: "BB_RSI_RSI_RANGE_MIN", label: "Min RSI Range", type: "number", min: 0, max: 80, step: 1, effect: EFFECT.SESSION, desc: "Max minus min RSI over the lookback must be at least this.", default: "30" },
      { key: "BB_RSI_ADX_ENABLED", label: "ADX Ceiling Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Skip entries when the trend is too strong to fade. Stays a CEILING in breakout mode too, where it is the wrong sense — leave it off there.", default: "false" },
      { key: "BB_RSI_ADX_MAX", label: "ADX Max (trend ceiling)", type: "number", min: 0, max: 60, step: 1, effect: EFFECT.SESSION, desc: "Block entries once ADX(14) reaches this (higher = more permissive).", default: "30" },
      // ── Divergence (optional confirmation that the extreme is exhausted) ──
      { key: "BB_RSI_DIVERGENCE_ENABLED", label: "Divergence Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Require price/RSI divergence: CE = lower low with a higher RSI low, PE = higher high with a lower RSI high.", default: "false", subheader: "Divergence" },
      { key: "BB_RSI_DIV_LOOKBACK", label: "Divergence Lookback (candles)", type: "number", min: 5, max: 60, step: 1, effect: EFFECT.SESSION, desc: "How far back to hunt for the prior swing to compare against.", default: "20" },
      { key: "BB_RSI_DIV_PIVOT_BARS", label: "Divergence Pivot Bars", type: "number", min: 1, max: 6, step: 1, effect: EFFECT.SESSION, desc: "Bars either side needed to confirm a swing pivot (higher = stricter, slower).", default: "2" },
      // ── Exits ──
      { key: "BB_RSI_TARGET_MIDDLE_BAND", label: "Target the BB Middle Band", type: "toggle", effect: EFFECT.SESSION, desc: "Take profit when price reverts to the mean (the middle band). Ignored in breakout mode — the mean is behind the entry there.", default: "true", subheader: "Exits" },
      { key: "BB_RSI_OPP_CANDLE_SL_ENABLED", label: "Opposite-Candle Stop", type: "toggle", effect: EFFECT.SESSION, desc: "Exit after N consecutive candles closing against the trade.", default: "true" },
      { key: "BB_RSI_OPP_CANDLE_SL_COUNT", label: "Opposite Candles → Stop", type: "number", min: 1, max: 6, step: 1, effect: EFFECT.SESSION, desc: "How many consecutive opposite candles trigger the stop.", default: "2" },
      { key: "BB_RSI_OPP_CANDLE_TRAIL_ENABLED", label: "Opposite-Candle Trail", type: "toggle", effect: EFFECT.SESSION, desc: "Once in profit, take over from the stop with its own opposite-candle count.", default: "true" },
      { key: "BB_RSI_OPP_CANDLE_TRAIL_COUNT", label: "Opposite Candles → Trail", type: "number", min: 1, max: 6, step: 1, effect: EFFECT.SESSION, desc: "How many consecutive opposite candles trigger the trail exit.", default: "2" },
      { key: "BB_RSI_TRAIL_ARM_PTS", label: "Trail Arm (pts)", type: "number", min: 0, max: 200, step: 5, effect: EFFECT.SESSION, desc: "Favourable spot points before the trail takes over from the stop (0 = immediately).", default: "10" },
      { key: "BB_RSI_PROFIT_LOCK_TRIGGER_PTS", label: "Profit Lock Trigger (pts)", type: "number", min: 0, max: 300, step: 5, effect: EFFECT.SESSION, desc: "Optional extra upside cap — arm after this many points gained (0 = off).", default: "0" },
      { key: "BB_RSI_PROFIT_LOCK_PCT", label: "Profit Lock % of Peak", type: "number", min: 10, max: 95, step: 5, effect: EFFECT.SESSION, desc: "Once armed, exit if profit falls below this % of its peak.", default: "50" },
      { key: "BB_RSI_STOP_LOSS_PTS", label: "Hard Stop (pts)", type: "number", min: 0, max: 200, step: 5, effect: EFFECT.SESSION, desc: "Per-tick catastrophic cap under the candle stop, which only fires on a close (0 = off).", default: "30" },
      // ── Risk management ──
      // The live stop is the two-opposite-candle rule above; the SL line recorded at
      // entry is the signal candle's own extreme, kept for sizing and display only.
      { key: "BB_RSI_SLIPPAGE_PTS", label: "Slippage (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.SESSION, desc: "Simulated slippage per side, in points.", default: "1.5", subheader: "Risk & Pauses" },
      { key: "BB_RSI_MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Max entries per day.", default: "30" },
      { key: "BB_RSI_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 20000, step: 500, effect: EFFECT.SESSION, desc: "Stop trading after this much loss.", default: "4000" },
      { key: "BB_RSI_SL_PAUSE_CANDLES", label: "SL Pause (candles)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Pause this many candles after a stop.", default: "3" },
      { key: "BB_RSI_CONSEC_SL_EXTRA_PAUSE", label: "Consec SL Extra Pause", type: "number", min: 1, max: 8, step: 1, effect: EFFECT.SESSION, desc: "Extra pause candles per repeated stop.", default: "2" },
      { key: "BB_RSI_PER_SIDE_PAUSE", label: "Per-Side SL Pause", type: "toggle", effect: EFFECT.SESSION, desc: "A stop pauses only that side (CE or PE).", default: "true" },
    ],
  },
  {
    section: "PRICE ACTION STRATEGY (5-min) — Fyers",
    icon: "📐",
    nav: "Price Action",
    group: "Strategies",
    fields: [
      { key: "PA_ENABLED", label: "PA Live Orders", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Fyers.", default: "false", subheader: "Mode & Session" },
      { key: "PA_EXPIRY_DAY_ONLY", label: "PA Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only trade on weekly expiry day.", default: "false" },
      { key: "PA_VIX_ENABLED", label: "VIX Filter (PA)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block entries when VIX is high.", default: "false" },
      { key: "PA_VIX_MAX_ENTRY", label: "PA VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Block entries above this VIX.", default: "20" },
      { key: "PA_ENTRY_START", label: "Entry Start Time", type: "time", effect: EFFECT.SESSION, desc: "Earliest entry time (IST).", default: "09:20" },
      { key: "PA_ENTRY_END", label: "Entry End Time", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (IST).", default: "14:30" },
      // ── Pattern toggles (the only four entry logics) ──
      { key: "PA_PATTERN_DOUBLE_BOTTOM", label: "Double Bottom (W) → CE", type: "toggle", effect: EFFECT.SESSION, desc: "Trade double-bottom (W) breakouts as CE.", default: "true", subheader: "Patterns & Trend" },
      { key: "PA_PATTERN_DOUBLE_TOP",    label: "Double Top (M) → PE",    type: "toggle", effect: EFFECT.SESSION, desc: "Trade double-top (M) breakdowns as PE.", default: "true" },
      { key: "PA_PATTERN_ASC_TRIANGLE",  label: "Ascending Triangle → CE", type: "toggle", effect: EFFECT.SESSION, desc: "Trade ascending-triangle breakouts as CE.", default: "true" },
      { key: "PA_PATTERN_DESC_TRIANGLE", label: "Descending Triangle → PE", type: "toggle", effect: EFFECT.SESSION, desc: "Trade descending-triangle breakdowns as PE.", default: "true" },
      // ── Trend filter (course rule #1: trade breakouts WITH the trend) ──
      { key: "PA_TREND_FILTER_ENABLED", label: "Trend Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Only trade patterns aligned with the trend.", default: "false" },
      { key: "PA_TREND_EMA_PERIOD", label: "Trend EMA Period", type: "number", min: 5, max: 100, step: 1, effect: EFFECT.SESSION, desc: "EMA period for the trend read.", default: "20" },
      { key: "PA_TREND_FLAT_BAND", label: "Trend Flat Band (pts)", type: "number", min: 0, max: 30, step: 1, effect: EFFECT.SESSION, desc: "Neutral zone around the EMA, in points.", default: "0" },
      // Pattern-shape internals (Min Body / Pattern Tolerance / S/R Lookback) and the
      // structural SL placement (buffer beyond the pattern level) are computed internally
      // by the engine — no knobs. The SL sits at the pattern's invalidation level itself.
      // ── Exit: breakeven then swing trail ──
      { key: "PA_BREAKEVEN_TRIGGER", label: "Breakeven Trigger (₹)", type: "number", min: 0, max: 2000, step: 50, effect: EFFECT.SESSION, desc: "Move stop to breakeven after this much profit (₹, 0 = off).", default: "300", subheader: "Exits & Risk" },
      { key: "PA_BREAKEVEN_BUFFER", label: "Breakeven Buffer (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.SESSION, desc: "Cushion above/below entry for the breakeven stop, in points.", default: "1" },
      { key: "PA_SLIPPAGE_PTS", label: "Slippage (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.SESSION, desc: "Simulated slippage for backtest, in points.", default: "0" },
      { key: "PA_MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Max entries per day.", default: "30" },
      { key: "PA_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 20000, step: 500, effect: EFFECT.SESSION, desc: "Stop trading after this much loss.", default: "2000" },
      { key: "PA_SL_PAUSE_CANDLES", label: "SL Pause (candles)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Pause this many candles after a stop.", default: "2" },
      { key: "PA_CONSEC_SL_EXTRA_PAUSE", label: "Consec SL Extra Pause", type: "number", min: 1, max: 5, step: 1, effect: EFFECT.SESSION, desc: "Extra pause candles per repeated stop.", default: "2" },
    ],
  },
  {
    section: "ORB STRATEGY (Opening Range Breakout) — Fyers",
    icon: "📋",
    nav: "ORB",
    group: "Strategies",
    fields: [
      { key: "ORB_LIVE_ENABLED", label: "ORB Live Orders (gates /orb-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live ORB orders via Fyers.", default: "false", subheader: "Mode & Entry" },
      { key: "ORB_LIVE_DRY_RUN", label: "ORB Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep ORB simulated even when live is on.", default: "false" },

      // ── Entry: session window + day sanity + breakout quality ──────────
      { key: "ORB_RANGE_START", label: "OR Window Start", type: "time", effect: EFFECT.SESSION, desc: "Opening-range start time (IST).", default: "09:15" },
      { key: "ORB_RANGE_END", label: "OR Window End", type: "time", effect: EFFECT.SESSION, desc: "Opening-range end time (IST).", default: "09:30" },
      { key: "ORB_ENTRY_START", label: "Earliest Entry Time", type: "time", effect: EFFECT.SESSION, desc: "No breakout candle is even looked at before this (blank/09:30 = start hunting the moment the range freezes). Skips the 09:35-type entries — but MEASURE IT FIRST: on the Jul–Aug 2026 export the early trades lost less than the late ones (−₹2,372 over 9 before 09:50 vs −₹4,213 over 8 after) and a delay deletes the sample's two best trades.", default: "09:30" },
      { key: "ORB_ENTRY_END", label: "Latest Entry Time", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (IST).", default: "11:30" },
      { key: "ORB_OR_ATR_MAX", label: "Day Filter — Max OR ÷ ATR(15m) (0 = off)", type: "number", min: 0, max: 5, step: 0.1, effect: EFFECT.INSTANT, desc: "Skip the day if the opening range is too wide.", default: "0" },
      { key: "ORB_OR_MAX_PTS", label: "Day Filter — Max OR Width (pts, 0 = off)", type: "number", min: 0, max: 300, step: 5, effect: EFFECT.INSTANT, desc: "Skip the day when the opening range is wider than this many points. Measure with scripts/orbSweep.js before enabling.", default: "0" },
      { key: "ORB_GAP_OR_MULT", label: "Day Filter — Max Gap ÷ OR (0 = off)", type: "number", min: 0, max: 6, step: 0.5, effect: EFFECT.INSTANT, desc: "Skip the day on an oversized overnight gap.", default: "0" },
      { key: "ORB_BODY_ATR_MULT", label: "Breakout — Min Body ÷ ATR(5m) (0 = off)", type: "number", min: 0, max: 1.5, step: 0.1, effect: EFFECT.INSTANT, desc: "Breakout candle must be at least this decisive.", default: "0" },
      { key: "ORB_BODY_OR_CAP", label: "Breakout — Cap Min Body at × OR (0 = off)", type: "number", min: 0, max: 1, step: 0.05, effect: EFFECT.INSTANT, desc: "Ceiling on the body filter as a share of today's opening range. ATR(5m) comes from previous days, so after a violent day it can demand a body bigger than today's whole range (2026-08-06: 22.2pt needed vs a 38.95pt range). 0.25 = never ask for more than a quarter of the range. Can only let MORE breakouts through.", default: "0" },
      { key: "ORB_BUFFER_OR_MULT", label: "Breakout — Buffer Beyond Edge (× OR, 0 = off)", type: "number", min: 0, max: 0.5, step: 0.01, effect: EFFECT.INSTANT, desc: "How far past the range edge a close must be. Lowering it takes more trades but measurably worse ones (PF 0.93 → 0.64 at 0.10 on the Mar–Apr 2026 sample) — leave it alone.", default: "0" },
      { key: "ORB_BUFFER_ATR_MULT", label: "Breakout — Buffer Beyond Edge (× ATR 5m)", type: "number", min: 0, max: 1, step: 0.05, effect: EFFECT.INSTANT, desc: "Second half of the buffer; the larger of this and the ×OR value wins.", default: "0" },
      { key: "ORB_BUFFER_MIN_PTS", label: "Breakout — Buffer Floor (pts)", type: "number", min: 0, max: 20, step: 1, effect: EFFECT.INSTANT, desc: "Absolute floor on the breakout buffer. Set all three buffer fields to 0 for a plain close past the line.", default: "0" },
      { key: "ORB_VWAP_FILTER_ENABLED", label: "Breakout — Require Correct Side of VWAP", type: "toggle", effect: EFFECT.INSTANT, desc: "Measured worthless here: it removed 0 of 36 breakouts on the Mar–Apr 2026 sample. Off costs nothing and skips the VWAP maths.", default: "false" },
      { key: "ORB_CONFIRM_MODE", label: "Confirmation — Rule", type: "select", options: ["extend", "close"], effect: EFFECT.INSTANT, desc: "extend = next candle needs a higher high AND higher close beyond the edge. close = it only has to close beyond the breakout candle's close.", default: "close" },
      { key: "ORB_SL_SOURCE", label: "Stop — Anchor Candle", type: "select", options: ["entry", "breakout", "lookback"], effect: EFFECT.INSTANT, desc: "Which candle's low/high the initial stop sits under: the entry candle, the first candle that closed past the range edge, or lookback = the extreme of the last N candles ending at the entry candle (N below).", default: "breakout" },
      { key: "ORB_SL_LOOKBACK_CANDLES", label: "Stop — Lookback Candles (anchor = lookback)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Only read when the anchor is 'lookback'. 2 = the entry candle and the one before it — the stop clears the recent swing instead of a single bar. Ignored by the other two anchors.", default: "2" },
      { key: "ORB_RSI_ENABLED", label: "Entry — RSI Momentum Gate", type: "toggle", effect: EFFECT.INSTANT, desc: "CE needs RSI at or above the CE floor, PE at or below the PE ceiling, read on the candle being bought. Off = no RSI check.", default: "true" },
      { key: "ORB_RSI_PERIOD", label: "Entry — RSI Period", type: "number", min: 2, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "RSI lookback on 5-min closes.", default: "14" },
      { key: "ORB_RSI_CE_MIN", label: "Entry — RSI Floor for CE", type: "number", min: 0, max: 100, step: 1, effect: EFFECT.INSTANT, desc: "CE entries need RSI at or above this.", default: "51" },
      { key: "ORB_RSI_PE_MAX", label: "Entry — RSI Ceiling for PE", type: "number", min: 0, max: 100, step: 1, effect: EFFECT.INSTANT, desc: "PE entries need RSI at or below this.", default: "49" },
      { key: "ORB_ST_ENABLED", label: "Entry — SuperTrend Direction Gate", type: "toggle", effect: EFFECT.INSTANT, desc: "CE only when SuperTrend is bullish, PE only when bearish, read on the candle being bought. Off = no SuperTrend check.", default: "true" },
      { key: "ORB_ST_PERIOD", label: "Entry — SuperTrend Period", type: "number", min: 2, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "SuperTrend ATR period.", default: "10" },
      { key: "ORB_ST_MULT", label: "Entry — SuperTrend Multiplier", type: "number", min: 0.5, max: 10, step: 0.5, effect: EFFECT.INSTANT, desc: "SuperTrend ATR multiplier.", default: "3" },
      { key: "ORB_BREAKOUT_RESCAN", label: "Breakout — Skip Weak Poke, Keep Hunting", type: "toggle", effect: EFFECT.INSTANT, desc: "OFF = the first close beyond the range is final, even if it fails the body filter (old behaviour).", default: "true" },
      { key: "ORB_RETEST_MAX_WAIT", label: "Retest / Resume Window (candles)", type: "number", min: 0, max: 12, step: 1, effect: EFFECT.INSTANT, desc: "Candles to wait for a retest or resume (0 = off).", default: "6" },

      // ── Exits (all owned by src/strategies/orbExits.js — one engine for
      //    paper, live, backtest and scripts/orbValidate.js) ──────────────
      { key: "ORB_SL_ATR_MULT", label: "Initial Stop — \u00d7 ATR(5m) (0 = off)", type: "number", min: 0, max: 3, step: 0.1, effect: EFFECT.INSTANT, desc: "Initial stop width as a multiple of ATR.", default: "0", subheader: "Exits" },
      { key: "ORB_BREAKEVEN_PTS", label: "Exit — Breakeven After (pts)", type: "number", min: 0, max: 60, step: 5, effect: EFFECT.INSTANT, desc: "Move stop to entry after this many points profit (0 = off).", default: "0" },
      { key: "ORB_BREAKEVEN_OR_MULT", label: "Exit — Breakeven × OR Width", type: "number", min: 0, max: 1.5, step: 0.1, effect: EFFECT.INSTANT, desc: "Scale the breakeven trigger by range width (0 = off).", default: "0" },
      { key: "ORB_TRAIL_EMA", label: "Exit — EMA Trail Period", type: "number", min: 2, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "Trail exit: leave when price closes back across this EMA.", default: "20" },
      { key: "ORB_TRAIL_ARM_PTS", label: "Exit — Arm EMA Trail Only After (pts, 0 = at once)", type: "number", min: 0, max: 100, step: 5, effect: EFFECT.INSTANT, desc: "The trail cannot exit until the trade is this many points in profit; only the hard stop and the ₹ cap apply before that. Entry is the confirmation candle's close, so price is often already extended and the next candle pulls back through the EMA. UNPROVEN — measure with scripts/orbSweep.js before moving it off 0.", default: "0" },
      { key: "ORB_TRAIL_CONFIRM_CLOSES", label: "Exit — Closes Needed to Break the Trail", type: "number", min: 1, max: 3, step: 1, effect: EFFECT.INSTANT, desc: "How many closes in a row on the wrong side of the EMA before exiting. 1 = today's rule. 2 rides out one noise candle but gives back a bar when the move is really over.", default: "1" },
      { key: "ORB_CANDLE_TRAIL_ENABLED", label: "Exit — Candle Trail (ratchet SL behind candles)", type: "toggle", effect: EFFECT.INSTANT, desc: "Once a candle closes in profit, move the hard stop to the extreme of the last N candles, and keep moving it up candle by candle. Tighten-only — a pullback never widens it. Runs alongside the EMA trail; whichever ends the trade first wins. UNPROVEN — measure with scripts/orbSweep.js.", default: "false" },
      { key: "ORB_CANDLE_TRAIL_CANDLES", label: "Exit — Candle Trail Lookback (candles)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "How many candles the trailing stop must clear. 1 = the just-closed candle's low/high (tightest). 2 = that candle and the one before it, matching the 'lookback' initial stop.", default: "2" },
      { key: "ORB_OPP_CANDLE_EXIT", label: "Exit — Strong Opposite Candle", type: "toggle", effect: EFFECT.INSTANT, desc: "Exit on a strong reversal candle.", default: "false" },
      { key: "ORB_OPP_CANDLE_BODY_MULT", label: "Opposite-Candle Body × Range", type: "number", min: 0.1, max: 1, step: 0.05, effect: EFFECT.INSTANT, desc: "Reversal candle body vs range width to trigger the exit.", default: "0.3" },
      { key: "ORB_MAX_TRADE_LOSS", label: "Exit — Max Loss per Trade (₹, 0 = off)", type: "number", min: 0, max: 10000, step: 250, effect: EFFECT.INSTANT, desc: "Ships OFF so the structural stop is the real stop. When set it clamps the placed SL, which is tighter than the strategy's own level on most trades — use Max Daily Loss for risk control instead.", default: "0" },
      { key: "ORB_PREMIUM_STOP_PCT", label: "Exit — Premium Disaster Stop (%)", type: "number", min: 0, max: 80, step: 5, effect: EFFECT.INSTANT, desc: "Exit if the option premium drops this % (0 = off).", default: "35" },
      { key: "ORB_FORCED_EXIT", label: "Forced Square-Off", type: "time", effect: EFFECT.SESSION, desc: "Hard end-of-day exit time (IST).", default: "15:15" },

      // ── Option selection + tradability gates (paper/live only — the
      //    backtest has no option chain) ───────────────────────────────────
      { key: "ORB_ITM_STEPS", label: "Slightly-ITM Strike Steps", type: "number", min: 0, max: 3, step: 1, effect: EFFECT.SESSION, desc: "Strikes in-the-money to trade (0 = ATM).", default: "1", subheader: "Option Selection" },
      { key: "ORB_PREMIUM_GATE_ENABLED", label: "Premium-Range Gate", type: "toggle", effect: EFFECT.INSTANT, desc: "Skip entries when the option price is out of range.", default: "false" },
      { key: "ORB_PREMIUM_MIN", label: "Min Option Premium (₹)", type: "number", min: 20, max: 500, step: 5, effect: EFFECT.INSTANT, desc: "Skip entry if the option price is below this (₹).", default: "120" },
      { key: "ORB_PREMIUM_MAX", label: "Max Option Premium (₹)", type: "number", min: 100, max: 1000, step: 10, effect: EFFECT.INSTANT, desc: "Skip entry if the option price is above this (₹).", default: "400" },
      { key: "ORB_MAX_SPREAD_PTS", label: "Max Option Bid-Ask Spread (pts)", type: "number", min: 0.5, max: 10, step: 0.5, effect: EFFECT.INSTANT, desc: "Skip entry if the bid-ask spread is wider than this.", default: "2" },

      // ── Risk / regime ────────────────────────────────────────────────
      { key: "ORB_MAX_DAILY_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 3, step: 1, effect: EFFECT.SESSION, desc: "Max entries per day.", default: "1", subheader: "Risk & Regime" },
      { key: "ORB_REENTRY_AFTER_SL", label: "Re-entries After a Stop-Out (0 = off)", type: "number", min: 0, max: 2, step: 1, effect: EFFECT.INSTANT, desc: "Extra attempts allowed after the breakout is STOPPED OUT, on top of Max Trades/Day. The hunt re-arms past the stop candle, so only a genuinely fresh close beyond the same range edge can re-enter (2026-08-03 would re-enter 10:45, 2026-07-29 at 10:05). An EMA-trail or EOD exit never re-arms — that means the move ended, not that the breakout was wrong. UNPROVEN: measure with scripts/orbSweep.js before leaving it on.", default: "0" },
      { key: "ORB_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 0, max: 20000, step: 500, effect: EFFECT.SESSION, desc: "Stop taking NEW entries once the day is down this much. It cannot close a trade that is already open, and with Max Trades/Day = 1 the budget is spent anyway — raise Max Trades/Day for it to bite.", default: "3000" },
      { key: "ORB_RISK_THROTTLE_ENABLED", label: "Risk Breaker (weekly loss / losing streak)", type: "toggle", effect: EFFECT.INSTANT, desc: "Pause after a bad week or a losing streak.", default: "true" },
      { key: "ORB_MAX_WEEKLY_LOSS", label: "Max Weekly Loss (₹)", type: "number", min: 0, max: 60000, step: 500, effect: EFFECT.INSTANT, desc: "Stop for the week after this much loss (0 = off).", default: "9000" },
      { key: "ORB_LOSS_STREAK_SKIP", label: "Skip After N Losing Days", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Skip a day after this many losing days (0 = off).", default: "4" },
      { key: "ORB_EXPIRY_DAY_ONLY", label: "ORB Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only trade on weekly expiry day.", default: "false" },
      { key: "ORB_VIX_ENABLED", label: "VIX Filter (ORB)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block entries when VIX is high.", default: "false" },
      { key: "ORB_VIX_MAX_ENTRY", label: "ORB VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Block entries above this VIX.", default: "22" },
      { key: "ORB_VIX_STRONG_ONLY", label: "ORB VIX Strong Only", type: "number", min: 8, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "Above this VIX, allow only strong signals.", default: "18" },

      // ── Backtest-only sim knobs (mirrors TREND_PB_BT_*) ──────────────
      { key: "ORB_BT_SLIPPAGE_PTS", label: "Backtest Spread/Slippage Haircut (pts each way)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.INSTANT, desc: "Backtest cost per side, in points.", default: "1.5", subheader: "Backtest & Debug" },
      { key: "ORB_BT_SEED_PREMIUM", label: "Backtest Seed Premium (₹)", type: "number", min: 50, max: 800, step: 10, effect: EFFECT.INSTANT, desc: "Assumed entry premium for the backtest (₹).", default: "240" },

      // ── Debug ────────────────────────────────────────────────────────
      { key: "ORB_DEBUG_TRACE", label: "Debug — Per-Candle Gate Trace", type: "toggle", effect: EFFECT.INSTANT, desc: "Log why entries did or didn't fire (verbose).", default: "false" },
    ],
  },
  {
    section: "EMA9 + VWAP STRATEGY — Zerodha",
    icon: "📈",
    nav: "EMA9 + VWAP",
    group: "Strategies",
    fields: [
      { key: "EMA9VWAP_LIVE_ENABLED", label: "EMA9+VWAP Live Orders (gates /ema9vwap-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Zerodha.", default: "false", subheader: "Mode & Session" },
      { key: "EMA9VWAP_LIVE_DRY_RUN", label: "EMA9+VWAP Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep this strategy simulated even when live is on.", default: "false" },
      { key: "EMA9VWAP_VWAP_SESSION_START", label: "VWAP Session Anchor", type: "time", effect: EFFECT.SESSION, desc: "Time VWAP resets each day (IST).", default: "09:15" },
      { key: "EMA9VWAP_ENTRY_START", label: "Entry Window Start", type: "time", effect: EFFECT.SESSION, desc: "No entries before this time (IST).", default: "10:30" },
      { key: "EMA9VWAP_ENTRY_END", label: "Entry Window End", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (IST).", default: "14:30" },
      { key: "EMA9VWAP_EOD_EXIT_TIME", label: "EOD Square-Off", type: "time", effect: EFFECT.SESSION, desc: "Hard square-off time (IST).", default: "15:15" },
      { key: "EMA9VWAP_STOP_TIME", label: "Engine Auto-Stop", type: "time", effect: EFFECT.SESSION, desc: "Time the engine stops for the day (IST).", default: "15:30" },
      // ── Entry signal ──
      { key: "EMA9VWAP_BAND_MULT", label: "VWAP Band σ Multiplier", type: "number", min: 0, max: 4, step: 0.5, effect: EFFECT.INSTANT, desc: "VWAP band width (σ multiplier).", default: "1", subheader: "Entry Signal" },
      { key: "EMA9VWAP_EMA_PERIOD", label: "EMA Period", type: "number", min: 2, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "EMA period.", default: "9" },
      { key: "EMA9VWAP_CONFIRM_CANDLE_ENABLED", label: "Confirmation Candle", type: "toggle", effect: EFFECT.INSTANT, desc: "Wait for a second candle to confirm entry.", default: "false" },
      { key: "EMA9VWAP_INTRACANDLE_ENTRY", label: "Intra-Candle Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Allow entries mid-candle instead of on close.", default: "false" },
      { key: "EMA9VWAP_STRENGTH_FILTER", label: "Drop WEAK Band Breaks", type: "toggle", effect: EFFECT.INSTANT, desc: "Only trade breaks that clear the band edge.", default: "false" },
      { key: "EMA9VWAP_STRONG_MIN_SIGMA", label: "STRONG Break Threshold (σ)", type: "number", min: 0, max: 2, step: 0.05, effect: EFFECT.INSTANT, desc: "How far past the band edge counts as strong (σ).", default: "0.25" },
      // ── Exits ──
      { key: "EMA9VWAP_OPT_STOP_PCT", label: "Safety Option-Premium Stop (fraction)", type: "number", min: 0, max: 0.5, step: 0.05, effect: EFFECT.INSTANT, desc: "Exit if option premium drops this fraction (0 = off).", default: "0", subheader: "Exits" },
      { key: "EMA9VWAP_STOP_LOSS_PTS", label: "Safety Spot-Points Stop", type: "number", min: 0, max: 200, step: 5, effect: EFFECT.INSTANT, desc: "Max loss per trade in points (0 = off).", default: "0" },
      { key: "EMA9VWAP_REVERSAL_EXIT_ENABLED", label: "2-Candle Reversal Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Exit on a strong reversal candle.", default: "true" },
      { key: "EMA9VWAP_NEG_CANDLE_LIMIT", label: "Negative-Candle Stop (candles)", type: "number", min: 0, max: 20, step: 1, effect: EFFECT.INSTANT, desc: "Exit if still losing after this many candles (0 = off).", default: "0" },
      { key: "EMA9VWAP_CANDLE_TRAIL_ENABLED", label: "N-Bar Candle Trail", type: "toggle", effect: EFFECT.INSTANT, desc: "Add a candle-based trailing stop.", default: "false" },
      { key: "EMA9VWAP_CANDLE_TRAIL_BARS", label: "Candle Trail Bars", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Candles used for the trailing stop.", default: "3" },
      { key: "EMA9VWAP_SL_MODE", label: "SL Mode", type: "select", options: ["ema", "candle"], effect: EFFECT.INSTANT, desc: "Exit style: signal-only or candle time-stop.", default: "ema" },
      // ── Risk & filters ──
      // M5: keys that were live in code but invisible here (and therefore absent
      // from the per-day settings snapshot). All defaults are BLANK/current so a
      // Settings save writes nothing that changes behaviour.
      { key: "EMA9VWAP_MAX_DAILY_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 40, step: 1, effect: EFFECT.SESSION, desc: "Max entries per day.", default: "20", subheader: "Risk & Filters" },
      { key: "EMA9VWAP_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 50000, step: 500, effect: EFFECT.SESSION, desc: "Stop trading after this much loss.", default: "5000" },
      { key: "EMA9VWAP_VIX_ENABLED", label: "VIX Filter (EMA9+VWAP)", type: "select", options: ["", "true", "false"], effect: EFFECT.INSTANT, desc: "VIX filter (blank = use the global setting).", default: "" },
      { key: "EMA9VWAP_VIX_MAX_ENTRY", label: "VIX Max Entry (EMA9+VWAP)", type: "text", effect: EFFECT.INSTANT, desc: "Block entries above this VIX (blank = use global).", default: "" },
      { key: "EMA9VWAP_SL_PAUSE_CANDLES", label: "Same-Side SL Cooldown (candles)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Pause the same side this many candles after a stop.", default: "3" },
      { key: "EMA9VWAP_OPPOSITE_SIDE_COOLDOWN_ENABLED", label: "Opposite-Side Cooldown", type: "toggle", effect: EFFECT.SESSION, desc: "Pause the opposite side briefly after an exit.", default: "true" },
      { key: "EMA9VWAP_OPPOSITE_SIDE_COOLDOWN_CANDLES", label: "Opposite-Side Cooldown (candles)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Opposite-side cooldown length in candles.", default: "3" },
      { key: "EMA9VWAP_MAX_CONSEC_LOSSES", label: "Chop Guard (consecutive losses)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Stop for the day after this many losses in a row (0 = off).", default: "0" },
    ],
  },
  {
    section: "TREND PULLBACK STRATEGY — Fyers",
    icon: "📈",
    nav: "Trend Pullback",
    group: "Strategies",
    fields: [
      { key: "TREND_PB_LIVE_ENABLED", label: "Trend Pullback Live Orders (gates /trend-pb-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Fyers.", default: "false", subheader: "Mode & Entry" },
      { key: "TREND_PB_LIVE_DRY_RUN", label: "Trend Pullback Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep this strategy simulated even when live is on.", default: "false" },
      // ── Entry (15m bias + 5m pullback/resumption) ──
      { key: "TREND_PB_SWING_LOOKBACK", label: "Swing Pivot Lookback (15m bars)", type: "number", min: 1, max: 5, step: 1, effect: EFFECT.INSTANT, desc: "Bars each side that define a swing point.", default: "2" },
      { key: "TREND_PB_BODY_ATR_MULT", label: "Resumption Body ≥ ×ATR5", type: "number", min: 0, max: 2, step: 0.1, effect: EFFECT.INSTANT, desc: "Resumption candle body vs ATR (conviction).", default: "0.5" },
      { key: "TREND_PB_PULLBACK_MAX_ATR", label: "Max Pullback Depth (×ATR5 below EMA20)", type: "number", min: 0.5, max: 4, step: 0.25, effect: EFFECT.INSTANT, desc: "Reject pullbacks deeper than this.", default: "1.5" },
      { key: "TREND_PB_PULLBACK_WINDOW", label: "Pullback Lookback Window (5m bars)", type: "number", min: 3, max: 12, step: 1, effect: EFFECT.INSTANT, desc: "Bars counted as the pullback.", default: "6" },
      { key: "TREND_PB_MIN_PULLBACK_BARS", label: "Min Against-Trend Candles", type: "number", min: 1, max: 5, step: 1, effect: EFFECT.INSTANT, desc: "Minimum against-trend candles for a real pause.", default: "2" },
      { key: "TREND_PB_ENTRY_START", label: "Entry Window Start", type: "time", effect: EFFECT.SESSION, desc: "No entries before this time (IST).", default: "09:45" },
      { key: "TREND_PB_ENTRY_END", label: "Entry Window End", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (IST).", default: "14:30" },
      { key: "TREND_PB_ATR_FLOOR_PTS", label: "ATR5 Floor (skip if below, pts)", type: "number", min: 0, max: 100, step: 5, effect: EFFECT.INSTANT, desc: "Skip when volatility is below this (0 = off).", default: "0" },
      // ── Exit (highest priority — right-tail via spot trailing) ──
      { key: "TREND_PB_STOP_CLAMP_MIN", label: "Initial Stop Clamp — Min (pts)", type: "number", min: 3, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "Smallest allowed stop distance, in points.", default: "8", subheader: "Exits" },
      { key: "TREND_PB_STOP_CLAMP_MAX", label: "Initial Stop Clamp — Max (pts)", type: "number", min: 10, max: 80, step: 1, effect: EFFECT.INSTANT, desc: "Largest allowed stop distance, in points.", default: "30" },
      { key: "TREND_PB_BREAKEVEN_R", label: "Breakeven Trigger (× initial risk)", type: "number", min: 0, max: 3, step: 0.25, effect: EFFECT.INSTANT, desc: "Move stop to entry after this much gain (× risk, 0 = off).", default: "1.0" },
      { key: "TREND_PB_TRAIL_ATR_MULT", label: "ATR Chandelier Trail (× ATR5)", type: "number", min: 1, max: 6, step: 0.5, effect: EFFECT.INSTANT, desc: "Trailing stop distance as a multiple of ATR.", default: "2.5" },
      { key: "TREND_PB_EMA_EXIT_ENABLED", label: "Trend-Failure EMA Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Exit when a 5m candle closes back across the EMA. Off = only stop/trail/time-stop close the trade.", default: "true" },
      { key: "TREND_PB_TRAIL_EMA", label: "Trend-Failure EMA (5m period)", type: "number", min: 5, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "Exit when price closes back across this EMA.", default: "20" },
      { key: "TREND_PB_ATR_PERIOD", label: "ATR Period (5m)", type: "number", min: 5, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "ATR period.", default: "14" },
      { key: "TREND_PB_TIME_STOP_CANDLES", label: "Time Stop (flat candles)", type: "number", min: 0, max: 20, step: 1, effect: EFFECT.INSTANT, desc: "Exit if flat after this many candles (0 = off).", default: "6" },
      { key: "TREND_PB_PREMIUM_STOP_PCT", label: "Premium Disaster Stop (%)", type: "number", min: 0, max: 80, step: 5, effect: EFFECT.INSTANT, desc: "Exit if the option premium drops this % (0 = off).", default: "35" },
      { key: "TREND_PB_FORCED_EXIT", label: "EOD Square-Off", type: "time", effect: EFFECT.SESSION, desc: "Hard square-off time (IST).", default: "15:15" },
      // ── Option selection + risk ──
      { key: "TREND_PB_ITM_STEPS", label: "ITM Steps (strikes in-the-money)", type: "number", min: 0, max: 3, step: 1, effect: EFFECT.INSTANT, desc: "Strikes in-the-money to buy (0 = ATM).", default: "1", subheader: "Option & Risk" },
      { key: "TREND_PB_PREMIUM_MIN", label: "Min Option Premium (₹)", type: "number", min: 0, max: 1000, step: 10, effect: EFFECT.INSTANT, desc: "Skip entry if the option price is below this (₹).", default: "120" },
      { key: "TREND_PB_PREMIUM_MAX", label: "Max Option Premium (₹)", type: "number", min: 0, max: 2000, step: 10, effect: EFFECT.INSTANT, desc: "Skip entry if the option price is above this (₹).", default: "400" },
      { key: "TREND_PB_MAX_SPREAD_PTS", label: "Max Bid-Ask Spread (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.INSTANT, desc: "Skip entry if the bid-ask spread is wider than this.", default: "2" },
      { key: "TREND_PB_MAX_DAILY_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Max entries per day.", default: "3" },
      { key: "TREND_PB_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 50000, step: 500, effect: EFFECT.SESSION, desc: "Stop trading after this much loss.", default: "5000" },
      { key: "TREND_PB_LOSS_STREAK_SKIP", label: "Consecutive-Loss Cool-Off", type: "number", min: 0, max: 6, step: 1, effect: EFFECT.SESSION, desc: "Pause for the day after this many losses in a row (0 = off).", default: "3" },
      { key: "TREND_PB_VIX_ENABLED", label: "VIX Filter", type: "toggle", effect: EFFECT.INSTANT, desc: "Block entries when VIX is out of range.", default: "false" },
      { key: "TREND_PB_VIX_MAX_ENTRY", label: "VIX Max Entry", type: "number", min: 8, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Block entries above this VIX.", default: "22" },
      { key: "TREND_PB_OI_ENABLED", label: "OI Buildup Gate", type: "toggle", effect: EFFECT.INSTANT, desc: "Block entries fighting an OI buildup.", default: "false" },
      { key: "TREND_PB_BT_SLIPPAGE_PTS", label: "Backtest Spread/Slippage Haircut (pts each way)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.INSTANT, desc: "Backtest cost per side, in points.", default: "1.5", subheader: "Backtest" },
      { key: "TREND_PB_BT_SEED_PREMIUM", label: "Backtest Seed Premium (₹)", type: "number", min: 50, max: 800, step: 10, effect: EFFECT.INSTANT, desc: "Assumed entry premium for the backtest (₹).", default: "240" },
    ],
  },
  {
    section: "TREND DAY SCALP STRATEGY — Fyers",
    icon: "⚡",
    nav: "TREND DAY SCALP",
    group: "Strategies",
    fields: [
      // ── Enable / live gating ──
      { key: "TDS_PAPER_ENABLED", label: "Trend Day Scalp Paper Trading", type: "toggle", effect: EFFECT.INSTANT, desc: "Allow new Trend Day Scalp paper sessions.", default: "true", subheader: "Mode & Live" },
      { key: "TDS_LIVE_ENABLED", label: "Trend Day Scalp Live Orders (gates /trend-day-scalp-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Fyers. NEVER traded — paper-validate first.", default: "false" },
      { key: "TDS_LIVE_DRY_RUN", label: "Trend Day Scalp Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep it simulated even when live is on.", default: "false" },

      // ── The day gate (decided once, then frozen) ──
      { key: "TDS_GATE_TIME", label: "Day Gate Time", type: "time", effect: EFFECT.SESSION, desc: "The one moment the day is judged trendable (IST). Decided once, then frozen.", default: "10:15", subheader: "Day Gate (decided once, then frozen)" },
      { key: "TDS_SESSION_START", label: "Session / VWAP Anchor", type: "time", effect: EFFECT.SESSION, desc: "Where the first-hour range and the VWAP both start (IST).", default: "09:15" },
      { key: "TDS_MIN_RANGE_PCT", label: "Min First-Hour Range (% of spot)", type: "number", min: 0, max: 5, step: 0.05, effect: EFFECT.SESSION, desc: "The day must have actually moved. A dead range has no juice for an option buyer.", default: "0.5" },
      { key: "TDS_VWAP_STREAK_BARS", label: "Closes One Side of VWAP", type: "number", min: 1, max: 30, step: 1, effect: EFFECT.SESSION, desc: "How many of the last closes must all sit on the same side of VWAP.", default: "6" },
      { key: "TDS_EXTENSION_MULT", label: "Extension from VWAP (× range)", type: "number", min: 0, max: 3, step: 0.05, effect: EFFECT.SESSION, desc: "Spot must sit this many × the first-hour range away from VWAP. MEASURED over 39 sessions: median 0.18, p90 0.39 — so 0.35 passed only 13% of days and starved the strategy. 0.20 is just above the median.", default: "0.20" },

      // ── Entry ──
      { key: "TDS_EMA_PERIOD", label: "Zone EMA Period", type: "number", min: 2, max: 200, step: 1, effect: EFFECT.SESSION, desc: "The pullback zone is whichever of VWAP / this EMA sits nearer to price.", default: "20", subheader: "Entry (pullback + reclaim)" },
      { key: "TDS_ATR_PERIOD", label: "ATR Period", type: "number", min: 2, max: 100, step: 1, effect: EFFECT.SESSION, desc: "ATR that scales the conviction body.", default: "14" },
      { key: "TDS_BODY_ATR_MULT", label: "Reclaim Body (× ATR)", type: "number", min: 0, max: 3, step: 0.05, effect: EFFECT.SESSION, desc: "The reclaim candle's body must be at least this × ATR — the conviction gate.", default: "0.4" },
      { key: "TDS_PULLBACK_WINDOW", label: "Pullback Lookback (bars)", type: "number", min: 1, max: 20, step: 1, effect: EFFECT.SESSION, desc: "How many recent bars can supply the pullback touch. A wick counts.", default: "3" },
      { key: "TDS_ENTRY_END", label: "Entry Window End", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (IST).", default: "14:00" },
      { key: "TDS_FORCED_EXIT", label: "Forced Exit (EOD square-off)", type: "time", effect: EFFECT.SESSION, desc: "Hard square-off time (IST).", default: "15:10" },
      { key: "TDS_RESOLUTION", label: "Candle Timeframe (min)", type: "select", options: ["1", "3", "5", "10", "15", "30", "60"], effect: EFFECT.SESSION, desc: "Signal + exit candle timeframe.", default: "5" },

      // ── Risk (the part that makes the result steady) ──
      { key: "TDS_MIN_SL_PTS", label: "Min Stop Distance (pts)", type: "number", min: 1, max: 100, step: 1, effect: EFFECT.SESSION, desc: "A tighter structural stop is widened to this — never tightened inside the structure.", default: "12", subheader: "Risk (fixed stop, fixed target)" },
      { key: "TDS_MAX_SL_PTS", label: "Max Stop Distance (pts)", type: "number", min: 1, max: 200, step: 1, effect: EFFECT.SESSION, desc: "A wider structural stop SKIPS the trade entirely. MEASURED: real pullback stops are median 35pt, so the old 18 skipped 48 of 53 setups and kept only the shallowest. 40pt covers ~p60. Note ~35pt ≈ ₹1,400 premium risk on 1 lot.", default: "40" },
      { key: "TDS_TARGET_R", label: "Target (× risk)", type: "number", min: 0.5, max: 10, step: 0.1, effect: EFFECT.SESSION, desc: "Fixed target as a multiple of the stop distance. Taken, never trailed past.", default: "2.5" },
      { key: "TDS_BREAKEVEN_R", label: "Breakeven Arms At (× risk)", type: "number", min: 0, max: 5, step: 0.1, effect: EFFECT.SESSION, desc: "Favourable move at which the stop makes its ONE jump.", default: "1" },
      { key: "TDS_BREAKEVEN_BUFFER_PTS", label: "Breakeven Buffer (pts)", type: "number", min: 0, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Where the stop lands on that jump: entry ± this. It never moves again.", default: "3" },
      { key: "TDS_TIME_STOP_MINS", label: "Time Stop (min)", type: "number", min: 0, max: 375, step: 5, effect: EFFECT.SESSION, desc: "Flat if breakeven has not armed within this long (0 = off). A stalled option only pays theta.", default: "25" },
      { key: "TDS_PREMIUM_STOP_PCT", label: "Premium Stop (%)", type: "number", min: 0, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Exit if the option itself drops this % (0 = off). Catches an IV crush the spot stop cannot see.", default: "25" },

      // ── Sizing & day-level breakers ──
      { key: "TDS_LOT_MULTIPLIER", label: "Lot Multiplier (Trend Day Scalp only)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Lots per trade (0 = use global).", default: "0", subheader: "Sizing & Day Breakers" },
      { key: "TDS_ITM_STEPS", label: "ITM Steps (strikes in-the-money)", type: "number", min: 0, max: 3, step: 1, effect: EFFECT.INSTANT, desc: "Strikes in-the-money to buy (0 = ATM). 1 step ≈ delta 0.6.", default: "1" },
      { key: "TDS_MAX_DAILY_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Max entries per day. Friction is per-trade, so fewer is usually better.", default: "2" },
      { key: "TDS_MAX_DAILY_LOSSES", label: "Stop-outs That End the Day", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Day ends after this many REAL stop-outs (0 = off). Breakeven and time-stop exits do not count.", default: "2" },
      { key: "TDS_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 0, max: 50000, step: 250, effect: EFFECT.SESSION, desc: "Stop trading after this much loss (0 = off). Raised with the stop cap — at 1500 a single 40pt stop-out ends the day, making the trade budget a dead letter.", default: "3000" },
      { key: "TDS_DAILY_PROFIT_LOCK", label: "Daily Profit Lock (₹)", type: "number", min: 0, max: 50000, step: 250, effect: EFFECT.SESSION, desc: "Stop for the day once this much is banked (0 = off). Giving profit back is what wrecks a steady curve.", default: "3000" },
      { key: "TDS_MAX_WEEKLY_LOSS", label: "Max Weekly Loss (₹)", type: "number", min: 0, max: 200000, step: 1000, effect: EFFECT.SESSION, desc: "Stop for the week after this much loss (0 = off).", default: "0" },

      // ── Backtest ──
      { key: "TDS_BT_SLIPPAGE_PTS", label: "Backtest Spread/Slippage Haircut (pts each way)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.BACKTEST, desc: "Backtest cost per side, in points. Without this, option-buying backtests always flatter.", default: "1.5", subheader: "Backtest" },
      { key: "TDS_BT_SEED_PREMIUM", label: "Backtest Seed Premium (₹)", type: "number", min: 50, max: 800, step: 10, effect: EFFECT.BACKTEST, desc: "Assumed entry premium for the backtest (₹).", default: "240" },
    ],
  },
  {
    section: "HA SCALP STRATEGY (Heikin Ashi 15m) — Zerodha",
    icon: "\u{1F56F}",
    nav: "HA SCALP",
    group: "Strategies",
    fields: [
      // ── Enable / live gating ──
      { key: "HA_SCALP_PAPER_ENABLED", label: "HA Scalp Paper Trading", type: "toggle", effect: EFFECT.INSTANT, desc: "Allow new HA Scalp paper sessions.", default: "true", subheader: "Mode & Live" },
      { key: "HA_SCALP_LIVE_ENABLED", label: "HA Scalp Live Orders (gates /ha-scalp-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Zerodha. NEVER traded — paper-validate first.", default: "false" },
      { key: "HA_SCALP_LIVE_DRY_RUN", label: "HA Scalp Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep it simulated even when live is on.", default: "false" },

      // ── The chart ──
      { key: "HA_SCALP_RESOLUTION", label: "Candle Timeframe (min)", type: "select", options: ["3", "5", "10", "15", "30", "60"], effect: EFFECT.SESSION, desc: "The chart the rules were read off. 15 minutes is the strategy as specified — the repo-wide 5-min default does not apply here.", default: "15", subheader: "The chart (Heikin Ashi, NIFTY 50 spot)" },
      { key: "HA_SCALP_HA_CONTINUOUS", label: "Continuous Heikin Ashi Chain Across Days", type: "toggle", effect: EFFECT.SESSION, desc: "ON = the HA candle carries over the overnight gap, which is what TradingView draws. OFF reseeds each day and the charts would then disagree with the platform the rules came from.", default: "true" },
      { key: "HA_SCALP_HA_WARMUP_BARS", label: "Heikin Ashi Warm-up (bars)", type: "number", min: 1, max: 500, step: 1, effect: EFFECT.SESSION, desc: "No decision until this many bars are behind us. haOpen is a running average, so the first few candle colours are seed artefacts rather than signal.", default: "20" },
      { key: "HA_SCALP_WARMUP_DAYS", label: "History Preload (calendar days)", type: "number", min: 3, max: 120, step: 1, effect: EFFECT.SESSION, desc: "How far back to fetch on start so the MA and the HA chain are established. At 25 bars a session, 15 calendar days is comfortably more than the ~51 bars needed, even across holidays.", default: "15" },

      // ── The trend gate ──
      { key: "HA_SCALP_MA_PERIOD", label: "Trend MA Period", type: "number", min: 2, max: 400, step: 1, effect: EFFECT.SESSION, desc: "The moving average that decides the side. Above it, CE only; below it, PE only. Computed on RAW closes, like the platform default.", default: "50", subheader: "The trend gate (hard directional filter)" },
      { key: "HA_SCALP_MA_TYPE", label: "Trend MA Type", type: "select", options: ["sma", "ema"], effect: EFFECT.SESSION, desc: "Simple or exponential. The rules were read off a plain 50 MA.", default: "sma" },

      // ── The entry candle ──
      { key: "HA_SCALP_MAX_WICK_PCT", label: "\"No Wick\" Tolerance (% of candle range)", type: "number", min: 0, max: 100, step: 1, effect: EFFECT.SESSION, desc: "How much wick still counts as none, as a share of the candle's own range. 0 = exactly wick-free, which is the rule as specified and is deliberately strict — expect few trades. Raising it to 5–10 loosens the entry.", default: "0", subheader: "The entry candle" },
      { key: "HA_SCALP_MIN_BODY_PTS", label: "Minimum Candle Body (pts)", type: "number", min: 0, max: 200, step: 1, effect: EFFECT.SESSION, desc: "A body smaller than this is not a strength candle. Without it, a flat candle satisfies \"no wick\" trivially.", default: "5" },

      // ── Exits ──
      { key: "HA_SCALP_EXIT_ON_DOJI", label: "Exit on a Doji Candle", type: "toggle", effect: EFFECT.SESSION, desc: "A doji warns of a trend reversal — close the trade. Colour is irrelevant: a doji ends the trend question either way.", default: "true", subheader: "Exits (there is NO target and NO trail)" },
      { key: "HA_SCALP_DOJI_BODY_PCT", label: "Doji Body (% of range or less)", type: "number", min: 0, max: 100, step: 1, effect: EFFECT.SESSION, desc: "A candle whose body is this small a share of its range counts as a doji.", default: "20" },
      { key: "HA_SCALP_EXIT_ON_WEAK", label: "Exit on a Weak or Opposite Candle", type: "toggle", effect: EFFECT.SESSION, desc: "The trend is fading — close the trade. Covers both an opposite-coloured candle and a same-coloured one whose body has shrunk.", default: "true" },
      { key: "HA_SCALP_WEAK_BODY_PCT", label: "Weak Body (% of range)", type: "number", min: 0, max: 100, step: 1, effect: EFFECT.SESSION, desc: "A same-direction candle with a body below this share of its range is weak. Must sit above the doji threshold to mean anything separate.", default: "40" },

      // ── Window ──
      { key: "HA_SCALP_SESSION_START", label: "Session Start", type: "time", effect: EFFECT.SESSION, desc: "Where the session's bars start being counted (IST).", default: "09:15", subheader: "Session window" },
      { key: "HA_SCALP_ENTRY_START", label: "Entry Window Start", type: "time", effect: EFFECT.SESSION, desc: "No entries before this (IST).", default: "09:30" },
      { key: "HA_SCALP_ENTRY_END", label: "Entry Window End", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (IST).", default: "15:00" },
      { key: "HA_SCALP_FORCED_EXIT", label: "Forced Exit (EOD square-off)", type: "time", effect: EFFECT.SESSION, desc: "Hard square-off time (IST). A trade no candle rule has closed is closed here.", default: "15:15" },

      // ── Risk ──
      { key: "HA_SCALP_SL_BUFFER_PTS", label: "Stop Buffer Beyond the Candle Extreme (pts)", type: "number", min: 0, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Stop sits this far past the signal candle's raw high/low, so a one-tick poke does not take it out. 0 = exactly on the candle's extreme, as the rule states.", default: "0", subheader: "Risk" },
      { key: "HA_SCALP_MAX_SL_PTS", label: "Max Stop Distance (pts, 0 = off)", type: "number", min: 0, max: 500, step: 5, effect: EFFECT.SESSION, desc: "Skip the setup when the signal candle's extreme is further away than this. OFF by default: the rule says that candle IS the stop, however wide.", default: "0" },

      // ── Sizing & day-level breakers ──
      { key: "HA_SCALP_LOT_MULTIPLIER", label: "Lot Multiplier (HA Scalp only)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Lots per trade. 0 = use the global LOT_MULTIPLIER, which is the default (1 lot).", default: "0", subheader: "Sizing & Day Breakers" },
      { key: "HA_SCALP_ITM_STEPS", label: "ITM Steps (strikes in-the-money)", type: "number", min: 0, max: 3, step: 1, effect: EFFECT.INSTANT, desc: "Strikes in-the-money to buy (0 = ATM). 1 step ≈ delta 0.6.", default: "1" },
      { key: "HA_SCALP_MAX_DAILY_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 20, step: 1, effect: EFFECT.SESSION, desc: "Max entries per day.", default: "3" },
      { key: "HA_SCALP_MAX_DAILY_LOSSES", label: "Stop-outs That End the Day", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Day ends after this many stop-outs (0 = off).", default: "2" },
      { key: "HA_SCALP_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 0, max: 50000, step: 250, effect: EFFECT.SESSION, desc: "Stop trading after this much loss (0 = off).", default: "3000" },
      { key: "HA_SCALP_DAILY_PROFIT_LOCK", label: "Daily Profit Lock (₹)", type: "number", min: 0, max: 50000, step: 250, effect: EFFECT.SESSION, desc: "Stop for the day once this much is banked (0 = off, the default).", default: "0" },
      { key: "HA_SCALP_MAX_WEEKLY_LOSS", label: "Max Weekly Loss (₹)", type: "number", min: 0, max: 200000, step: 1000, effect: EFFECT.SESSION, desc: "Stop for the week after this much loss (0 = off).", default: "0" },

      // ── Data plumbing ──
      { key: "HA_SCALP_POLL_MS", label: "Option Premium Poll (ms)", type: "number", min: 500, max: 30000, step: 500, effect: EFFECT.SESSION, desc: "How often the option premium is refreshed while a trade is open. Spot comes from the shared tick socket, so nothing else is polled.", default: "2000", subheader: "Data plumbing" },
      { key: "HA_SCALP_HISTORY_LAG_MS", label: "Bar-Close History Lag (ms)", type: "number", min: 0, max: 60000, step: 500, effect: EFFECT.SESSION, desc: "How long after a bar closes before the Fyers history endpoint is asked for it. Too short and the bar is not published yet, which delays every decision by a whole candle.", default: "5000" },

      // ── Backtest ──
      { key: "HA_SCALP_BT_SLIPPAGE_PTS", label: "Backtest Spread/Slippage Haircut (pts each way)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.BACKTEST, desc: "Backtest cost per side, in points. Without this, option-buying backtests always flatter.", default: "1.5", subheader: "Backtest" },
      { key: "HA_SCALP_BT_SEED_PREMIUM", label: "Backtest Seed Premium (₹)", type: "number", min: 50, max: 800, step: 10, effect: EFFECT.BACKTEST, desc: "Assumed entry premium for the backtest (₹).", default: "240" },
    ],
  },
  {
    section: "EARLYBIRD STRATEGY (first 15-min breakout, CASH EQUITY) — Fyers",
    icon: "\u{1F426}",
    nav: "EARLYBIRD",
    group: "Strategies",
    fields: [
      // ── Enable / live gating ──
      { key: "EARLYBIRD_PAPER_ENABLED", label: "EarlyBird Paper Trading", type: "toggle", effect: EFFECT.INSTANT, desc: "Allow new EarlyBird paper sessions.", default: "true", subheader: "Mode & Live" },
      { key: "EARLYBIRD_LIVE_ENABLED", label: "EarlyBird Live Orders (gates /early-bird-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live CASH EQUITY orders via Fyers. NEVER traded — paper-validate first, then diff a recorded session in /replay.", default: "false" },
      { key: "EARLYBIRD_LIVE_DRY_RUN", label: "EarlyBird Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep it simulated even when live is on.", default: "false" },

      // ── The signal candle ──
      // ── What to trade ──
      { key: "EARLYBIRD_TRADE_MODE", label: "What To Trade", type: "select", options: ["stock", "option", "both"], effect: EFFECT.SESSION, desc: "stock = buy/short the CASH EQUITY of the F&O stocks that confirm NIFTY's signal (the original rules). option = buy ONE NIFTY CE/PE off NIFTY's own opening candle and DO NOT check any stock. both = run the two legs at once, independently. Note the stock leg needs stock confirmation; the option leg never does.", default: "stock", subheader: "What to trade" },
      { leg: "option", key: "EARLYBIRD_OPTION_LOTS", label: "NIFTY Option Lots (option mode)", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Lots per NIFTY option trade. Only used when the mode trades options; the stock leg uses EARLYBIRD_QTY shares instead.", default: "1" },
      { leg: "option", key: "EARLYBIRD_ITM_STEPS", label: "Option ITM Steps (0 = ATM)", type: "number", min: 0, max: 3, step: 1, effect: EFFECT.SESSION, desc: "Strikes in-the-money to buy (0 = ATM). 1 step ≈ delta 0.6 — a higher delta tracks the spot move better and decays slower in percentage terms.", default: "1" },

      { key: "EARLYBIRD_RESOLUTION", label: "Candle Timeframe (min)", type: "select", options: ["5", "15", "30"], effect: EFFECT.SESSION, desc: "The chart the rules were read off. 15 minutes is the strategy as specified — the day's FIRST candle is the signal candle.", default: "15", subheader: "The signal candle (the day's first bar)" },
      { key: "EARLYBIRD_MAX_OPPOSING_WICK_PCT", label: "Max Opposing Wick (% of candle range)", type: "number", min: 0, max: 100, step: 5, effect: EFFECT.SESSION, desc: "The wick that argues AGAINST the move — the upper wick on a green candle, the lower wick on a red one. This one number covers all three drawings: a full-body candle, a long favourable wick, and a small opposing wick. Lower = stricter.", default: "30" },
      { key: "EARLYBIRD_MIN_BODY_PCT", label: "Minimum Body (% of candle range)", type: "number", min: 0, max: 100, step: 5, effect: EFFECT.SESSION, desc: "The body must be a real body, as a share of the candle's own range. Stops a tiny-bodied candle with two long wicks counting as a strength candle.", default: "40" },
      { key: "EARLYBIRD_MIN_RANGE_PTS", label: "Minimum Candle Range (0 = off)", type: "number", min: 0, max: 500, step: 1, effect: EFFECT.SESSION, desc: "Ignore an opening candle whose whole range is smaller than this. OFF by default — the rules do not ask for it.", default: "0" },

      // ── Confirmation ──
      { leg: "stock", key: "EARLYBIRD_UNIVERSE", label: "Stock Universe", type: "select", options: ["FNO", "NIFTY50", "NIFTY100"], effect: EFFECT.SESSION, desc: "Which list of stocks is scanned at 09:30. FNO (~220 names) is the list from the strategy's own stock-selection slides.", default: "FNO", subheader: "Confirmation (NIFTY must agree with the stock)" },
      { leg: "stock", key: "EARLYBIRD_MIN_CONFIRMING_STOCKS", label: "Stocks That Must Confirm", type: "number", min: 1, max: 500, step: 1, effect: EFFECT.SESSION, desc: "How many stocks must print the same-direction opening candle as NIFTY before the day is tradeable. 1 = the rule as specified. Raising it turns this into a market-breadth gate.", default: "1" },
      { leg: "stock", key: "EARLYBIRD_MAX_GAP_PCT", label: "Max Opening Gap (%)", type: "number", min: 0, max: 100, step: 0.5, effect: EFFECT.SESSION, desc: "Skip a stock that opened more than this far from the previous day's close, in either direction. This is the \"don't trade a stock which opened about 2% than the previous day\" rule.", default: "2" },

      // ── Entry / stop / target ──
      { key: "EARLYBIRD_ENTRY_BUFFER_PTS", label: "Entry / Stop Buffer (₹)", type: "number", min: 0, max: 100, step: 0.5, effect: EFFECT.SESSION, desc: "How far past the signal candle the pending order and the stop sit — \"a little above the breakout candle\". Applied to BOTH ends: entry beyond the extreme, stop beyond the other extreme.", default: "5", subheader: "Entry, stop and target" },
      { key: "EARLYBIRD_TARGET_RR", label: "Target Reward:Risk", type: "number", min: 0.1, max: 20, step: 0.5, effect: EFFECT.SESSION, desc: "Book profit at this multiple of the actual risk. 2 = the 1:2 in the rules; set 1 for the 1:1 the rules also allow.", default: "2" },
      { key: "EARLYBIRD_MAX_SL_PTS", label: "Big-Candle Threshold (₹, 0 = off)", type: "number", min: 0, max: 1000, step: 5, effect: EFFECT.SESSION, desc: "When the wick-to-wick risk is wider than this, the stop moves off the wick and onto the candle's BODY edge (open/close) instead — the \"if the breakout candle is too big, ignore the wick\" rule. It can only ever tighten the stop.", default: "60" },

      // ── Session window ──
      { key: "EARLYBIRD_SESSION_START", label: "Session Start", type: "time", effect: EFFECT.SESSION, desc: "Where the day's first candle begins (IST). This is the signal candle.", default: "09:15", subheader: "Session window" },
      { key: "EARLYBIRD_ENTRY_START", label: "Entry Window Start", type: "time", effect: EFFECT.SESSION, desc: "No entries before this (IST) — the signal candle has just closed.", default: "09:30" },
      { key: "EARLYBIRD_ENTRY_END", label: "Entry Window End", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (IST). The rule is 10:45; a pending order not triggered by then is cancelled.", default: "10:45" },
      { key: "EARLYBIRD_FORCED_EXIT", label: "Forced Exit (square-off)", type: "time", effect: EFFECT.SESSION, desc: "Hard square-off (IST). The rule is \"exit at 1 pm\" — anything still open closes at market here.", default: "13:00" },

      // ── Sizing & day breakers ──
      { leg: "stock", key: "EARLYBIRD_QTY", label: "Quantity per Stock (shares)", type: "number", min: 1, max: 100000, step: 1, effect: EFFECT.INSTANT, desc: "Shares per position. This is CASH EQUITY, not options — there are no lots.", default: "100", subheader: "Sizing & Day Breakers" },
      { leg: "stock", key: "EARLYBIRD_MAX_CONCURRENT", label: "Max Positions At Once", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.SESSION, desc: "How many stocks may be held simultaneously. When more confirm than this, the tightest-stop names are taken first.", default: "5" },
      { key: "EARLYBIRD_MAX_DAILY_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 100, step: 1, effect: EFFECT.SESSION, desc: "Max entries per day across all stocks.", default: "5" },
      { key: "EARLYBIRD_MAX_DAILY_LOSSES", label: "Stop-outs That End the Day", type: "number", min: 0, max: 20, step: 1, effect: EFFECT.SESSION, desc: "Day ends after this many stop-outs (0 = off).", default: "3" },
      { key: "EARLYBIRD_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 0, max: 200000, step: 500, effect: EFFECT.SESSION, desc: "Stop trading after this much loss (0 = off). Note 100 shares of a ₹3,000 stock is a ₹300,000 position — size this deliberately.", default: "5000" },
      { key: "EARLYBIRD_DAILY_PROFIT_LOCK", label: "Daily Profit Lock (₹)", type: "number", min: 0, max: 200000, step: 500, effect: EFFECT.SESSION, desc: "Stop for the day once this much is banked (0 = off, the default).", default: "0" },
      { key: "EARLYBIRD_MAX_WEEKLY_LOSS", label: "Max Weekly Loss (₹)", type: "number", min: 0, max: 500000, step: 1000, effect: EFFECT.SESSION, desc: "Stop for the week after this much loss (0 = off).", default: "0" },

      // ── Data plumbing ──
      { key: "EARLYBIRD_POLL_MS", label: "Stock Quote Poll (ms)", type: "number", min: 500, max: 30000, step: 500, effect: EFFECT.SESSION, desc: "How often the shortlisted stocks' prices are refreshed while setups are pending or positions are open.", default: "2000", subheader: "Data plumbing" },
      { key: "EARLYBIRD_HISTORY_LAG_MS", label: "Bar-Close History Lag (ms)", type: "number", min: 0, max: 60000, step: 500, effect: EFFECT.SESSION, desc: "How long after 09:30 before the history endpoint is asked for the opening candle. Too short and the bar is not published yet, which would lose the whole day.", default: "5000" },
      { key: "EARLYBIRD_WARMUP_DAYS", label: "History Preload (calendar days)", type: "number", min: 2, max: 120, step: 1, effect: EFFECT.SESSION, desc: "How far back to fetch. Only the previous daily close is strictly needed (for the gap rule), so this is small by design.", default: "7" },
      { leg: "stock", key: "EARLYBIRD_SCAN_CONCURRENCY", label: "Scan Concurrency (symbols at once)", type: "number", min: 1, max: 12, step: 1, effect: EFFECT.SESSION, desc: "How many symbols are fetched in parallel during the 09:30 scan. Each one issues two calls (intraday + daily), so the real number in flight is double this.", default: "4" },
      { leg: "stock", key: "EARLYBIRD_SCAN_RPS", label: "Scan Rate Limit (per second)", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Fyers meters history calls per second. Exceeding it makes Fyers answer 'no data' — indistinguishable from a delisted stock — so an over-fast scan silently reports most of the universe as having no candle. A full ~220-name scan takes about 2 minutes at this rate, well inside the entry window.", default: "8" },
      { leg: "stock", key: "EARLYBIRD_SCAN_RPM", label: "Scan Rate Limit (per minute)", type: "number", min: 1, max: 2000, step: 10, effect: EFFECT.SESSION, desc: "The second Fyers history window. Both this and the per-second cap are honoured.", default: "180" },
      { leg: "stock", key: "EARLYBIRD_QUOTE_CHUNK", label: "Quote Poll Batch Size (symbols)", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.SESSION, desc: "How many shortlisted symbols are requested per quote call. EarlyBird polls REST quotes for its shortlist rather than pushing equity symbols through the shared NIFTY socket.", default: "20" },
      { leg: "option", key: "EARLYBIRD_OPTION_LTP_RETRY_MS", label: "Option Premium Retry (ms)", type: "number", min: 1000, max: 60000, step: 500, effect: EFFECT.SESSION, desc: "After a failed option-premium fetch, how long before the entry is retried. Stops a dead or unquoted contract from hammering the quote API on every tick while the entry window is open.", default: "5000" },
      { key: "EARLYBIRD_QUOTE_STALE_SEC", label: "Quote Staleness Limit (sec)", type: "number", min: 5, max: 600, step: 5, effect: EFFECT.SESSION, desc: "A price older than this stops being used for exit decisions, and the failure is surfaced on the status page. Stops a position being managed off a frozen quote.", default: "30" },

      // ── Paper P&L cost model (equity intraday) ──
      { leg: "stock", key: "EARLYBIRD_BROKERAGE_PER_ORDER", label: "Brokerage Cap (₹ per order)", type: "number", min: 0, max: 500, step: 1, effect: EFFECT.SESSION, desc: "Per-leg brokerage cap used when costing a paper trade. The discount-broker standard is ₹20 or 0.03%, whichever is lower.", default: "20", subheader: "Paper cost model (equity intraday)" },
      { leg: "stock", key: "EARLYBIRD_STT_PCT", label: "STT — Sell Side (%)", type: "number", min: 0, max: 1, step: 0.001, effect: EFFECT.SESSION, desc: "Securities Transaction Tax on the SELL leg. Equity intraday is 0.025%, far below the options rate.", default: "0.025" },
      { leg: "stock", key: "EARLYBIRD_TXN_PCT", label: "Exchange Txn Charge (%)", type: "number", min: 0, max: 1, step: 0.00001, effect: EFFECT.SESSION, desc: "NSE equity transaction charge on total turnover.", default: "0.00297" },
      { leg: "stock", key: "EARLYBIRD_SEBI_PCT", label: "SEBI Turnover Fee (%)", type: "number", min: 0, max: 1, step: 0.0001, effect: EFFECT.SESSION, desc: "SEBI fee as a percentage of turnover (₹10 per crore).", default: "0.0001" },
      { leg: "stock", key: "EARLYBIRD_STAMP_PCT", label: "Stamp Duty — Buy Side (%)", type: "number", min: 0, max: 1, step: 0.001, effect: EFFECT.SESSION, desc: "Stamp duty on the BUY leg only.", default: "0.003" },

      // ── Backtest ──
      { key: "EARLYBIRD_BT_SLIPPAGE_PTS", label: "Backtest Slippage Haircut (₹ each way)", type: "number", min: 0, max: 20, step: 0.05, effect: EFFECT.BACKTEST, desc: "Backtest cost per side, in rupees of stock price. Applied to both entry and exit. Without it a breakout backtest always flatters.", default: "0.05", subheader: "Backtest" },
      { key: "EARLYBIRD_BT_CONCURRENCY", label: "Backtest Fetch Concurrency", type: "number", min: 1, max: 16, step: 1, effect: EFFECT.BACKTEST, desc: "How many symbols' history are fetched in parallel during a backtest. Higher is faster but risks Fyers rate limits.", default: "4" },
      { key: "EARLYBIRD_BT_RPS", label: "Backtest Fetch Rate (per second)", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.BACKTEST, desc: "Fyers meters history requests per second. Lower this if a wide-range run starts failing.", default: "8" },
      { key: "EARLYBIRD_BT_RPM", label: "Backtest Fetch Rate (per minute)", type: "number", min: 1, max: 2000, step: 10, effect: EFFECT.BACKTEST, desc: "The second Fyers history window. Both this and the per-second cap are honoured.", default: "180" },
      { key: "EARLYBIRD_BT_MAX_SYMBOL_DAYS", label: "Backtest Memory Ceiling (symbol-days)", type: "number", min: 100, max: 2000000, step: 1000, effect: EFFECT.BACKTEST, desc: "Largest run allowed, measured as symbols × trading days. The backtest holds every symbol's candles in memory at once, and this process runs with a 900 MB heap shared with live sessions — an oversized run would make PM2 restart the whole bot. 60000 ≈ one year of the full FNO universe (~186 MB of candles) or ~4 years of NIFTY50. Raise it only on a larger machine.", default: "60000" },
      { key: "EARLYBIRD_BT_CACHE_DAYS", label: "Backtest Cache Retention (days)", type: "number", min: 1, max: 365, step: 1, effect: EFFECT.BACKTEST, desc: "How long a cached history file survives before it is re-fetched.", default: "30" },
      { key: "EARLYBIRD_BT_DAILY_LOOKBACK_DAYS", label: "Backtest prevClose Lookback (days)", type: "number", min: 1, max: 60, step: 1, effect: EFFECT.BACKTEST, desc: "How far back the daily series is pulled so every simulated day has a previous close for the gap rule, even after a long holiday.", default: "10" },

      // ── Equity-intraday cost model ──
      // charges.js has only an options and a futures path, so these rates are
      // applied locally by the backtest. See that file's header for why.
      { leg: "stock", key: "EARLYBIRD_CHG_STT_PCT", label: "STT — Sell Side (% of turnover)", type: "number", min: 0, max: 1, step: 0.001, effect: EFFECT.BACKTEST, desc: "Securities Transaction Tax on the SELL leg of an equity-intraday trade. NSE rate is 0.025%.", default: "0.025", subheader: "Backtest cost model (equity intraday)" },
      { leg: "stock", key: "EARLYBIRD_CHG_EXCHANGE_PCT", label: "Exchange Txn Charge (% of turnover)", type: "number", min: 0, max: 1, step: 0.00001, effect: EFFECT.BACKTEST, desc: "NSE equity transaction charge on total turnover. Much smaller than the options rate — this is why option charges cannot be reused here.", default: "0.00297" },
      { leg: "stock", key: "EARLYBIRD_CHG_BROKERAGE_PCT", label: "Brokerage (% per leg)", type: "number", min: 0, max: 5, step: 0.01, effect: EFFECT.BACKTEST, desc: "Percentage brokerage per leg, before the cap below.", default: "0.03" },
      { leg: "stock", key: "EARLYBIRD_CHG_BROKERAGE_CAP", label: "Brokerage Cap (₹ per leg)", type: "number", min: 0, max: 500, step: 1, effect: EFFECT.BACKTEST, desc: "Maximum brokerage per leg. The discount-broker standard is ₹20.", default: "20" },
      { leg: "stock", key: "EARLYBIRD_CHG_GST_PCT", label: "GST (%)", type: "number", min: 0, max: 50, step: 1, effect: EFFECT.BACKTEST, desc: "GST charged on brokerage + exchange + SEBI fees.", default: "18" },
      { leg: "stock", key: "EARLYBIRD_CHG_STAMP_PCT", label: "Stamp Duty — Buy Side (%)", type: "number", min: 0, max: 1, step: 0.001, effect: EFFECT.BACKTEST, desc: "Stamp duty on the BUY leg of an equity-intraday trade.", default: "0.003" },
      { leg: "stock", key: "EARLYBIRD_CHG_SEBI_PER_CRORE", label: "SEBI Fee (₹ per crore)", type: "number", min: 0, max: 1000, step: 1, effect: EFFECT.BACKTEST, desc: "SEBI turnover fee, in rupees per crore of turnover.", default: "10" },
    ],
  },
  {
    section: "SIMPLE_9:30 STRATEGY (option-premium breakout) — Zerodha",
    icon: "\u{1F3AF}",
    nav: "SIMPLE 9:30",
    group: "Strategies",
    fields: [
      // ── Enable / live gating ──
      { key: "SIMPLE930_PAPER_ENABLED", label: "SIMPLE_9:30 Paper Trading", type: "toggle", effect: EFFECT.INSTANT, desc: "Allow new SIMPLE_9:30 paper sessions.", default: "true", subheader: "Mode & Live" },
      { key: "SIMPLE930_LIVE_ENABLED", label: "SIMPLE_9:30 Live Orders (gates /simple930-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Zerodha. NEVER traded, paper or live — paper-validate first, then diff a recorded session in /replay.", default: "false" },
      { key: "SIMPLE930_LIVE_DRY_RUN", label: "SIMPLE_9:30 Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep it simulated even when live is on.", default: "false" },

      // ── The 09:25 pick ──
      { key: "SIMPLE930_SELECTION_TIME", label: "Selection Time (the chain is quoted once)", type: "time", effect: EFFECT.SESSION, desc: "The single instant (IST) the ITM ladder is quoted and the day's two candidates — one CE, one PE — are frozen. It never re-picks: a watchlist that drifts with spot could not be re-derived by Replay.", default: "09:25", subheader: "The 09:25 pick" },
      { key: "SIMPLE930_TRIGGER_PREMIUM", label: "Trigger Premium (₹) — the strike search AND the breakout level", type: "number", min: 1, max: 5000, step: 5, effect: EFFECT.SESSION, desc: "This ONE number does both jobs, because in the rule they are the same ₹180: the 09:25 search keeps the strike trading nearest it, and the same level is what a premium must trade above to be bought. The sideways box is stored as offsets around it, so moving this moves the whole geometry together instead of leaving a band around a level nothing trades near.", default: "180" },
      { key: "SIMPLE930_SCAN_ITM_STRIKES", label: "ITM Strikes Quoted per Side", type: "number", min: 1, max: 20, step: 1, effect: EFFECT.SESSION, desc: "How deep in-the-money the 09:25 ladder reaches on each side. 8 × 50 = 400 points, which covers a ₹180 premium from a fresh weekly (barely ITM) to expiry day (almost all intrinsic).", default: "8" },
      { key: "SIMPLE930_SCAN_OTM_STRIKES", label: "OTM Strikes Quoted per Side", type: "number", min: 0, max: 20, step: 1, effect: EFFECT.SESSION, desc: "0 = the rule as written (ATM + ITM only). Raise it when the whole ITM ladder sits ABOVE the trigger, which happens on a fresh weekly where even the ATM contract is dearer than ₹180 — without an OTM rung there is nothing near the level to pick.", default: "0" },

      // ── Entry window ──
      { key: "SIMPLE930_ENTRY_START", label: "Entry Window Start", type: "time", effect: EFFECT.SESSION, desc: "Entries are allowed from this moment (IST). It opens with the watchlist rather than at 09:30 because the rule is take it as soon as it is above the trigger, not wait for a round number.", default: "09:25", subheader: "Entry window" },
      { key: "SIMPLE930_ENTRY_END", label: "Entry Window End", type: "time", effect: EFFECT.SESSION, desc: "If neither watchlist leg has cleared the trigger by this time (IST) there is no trade today — nothing re-arms later in the session.", default: "09:35" },
      { key: "SIMPLE930_SUSTAIN_POLLS", label: "Quotes Above the Trigger Before Entering", type: "number", min: 1, max: 60, step: 1, effect: EFFECT.SESSION, desc: "1 = enter on the first quote above the trigger, which is the rule as written. Higher demands that many CONSECUTIVE quotes above it before buying — fewer one-print fakeouts, but every extra quote costs a poll interval of the move.", default: "1" },

      // ── Risk ──
      { key: "SIMPLE930_SL_PTS", label: "Stop Distance off the Fill (pts)", type: "number", min: 0.5, max: 500, step: 0.5, effect: EFFECT.SESSION, desc: "A DISTANCE below the ACTUAL fill, not a fixed level: filled at 181 gives a stop at 161, filled at 186 gives 166. Anchoring it to the trigger instead would hand a slipped fill a wider stop than the rule allows.", default: "20" },
      { key: "SIMPLE930_TRAIL_ENABLED", label: "Trail the Stop", type: "toggle", effect: EFFECT.SESSION, desc: "Ratchet the stop up behind the highest premium seen since entry. Off leaves the initial stop where it was placed for the life of the trade.", default: "true" },
      { key: "SIMPLE930_TRAIL_PTS", label: "Trail Distance Behind the Peak (pts)", type: "number", min: 0.5, max: 500, step: 0.5, effect: EFFECT.SESSION, desc: "How far under the highest premium seen since entry the trail sits: peak 200 gives a stop at 180. It only ever ratchets UP and never drops below the initial stop.", default: "20" },
      { key: "SIMPLE930_TRAIL_ARM_AT_BAND_UP", label: "Arm the Trail Only at the Box Top", type: "toggle", effect: EFFECT.SESSION, desc: "Keep the trail parked until the premium actually touches the top of the sideways box (Trigger + Band Up Offset). Until then the flat stop is the only risk. Off makes the trail live from the fill, which turns a 20pt stop into a much tighter one on the first rupee of noise.", default: "true" },
      { key: "SIMPLE930_SIDEWAYS_CHECK", label: "Sideways Check Time", type: "time", effect: EFFECT.SESSION, desc: "At this time (IST) a trade still boxed inside the band below is closed at market, whatever the P&L — it spent the whole move going nowhere. A trade that already left the box is left alone and the trail owns it from there.", default: "09:45" },
      { key: "SIMPLE930_BAND_UP_OFFSET", label: "Sideways Band — Upper Offset (pts above trigger)", type: "number", min: 0, max: 2000, step: 5, effect: EFFECT.SESSION, desc: "Upper edge of the box, resolved as trigger + this — 220 at the defaults. Touching it counts as leaving the box, so the 09:45 exit stops applying. Setting it to 0 puts the box top ON the trigger, and since every fill is above the trigger the trade counts as expanded immediately — that DISABLES the 09:45 sideways exit entirely. Use 0 only if that is what you want.", default: "40" },
      { key: "SIMPLE930_BAND_DOWN_OFFSET", label: "Sideways Band — Lower Offset (pts below trigger)", type: "number", min: 0, max: 2000, step: 5, effect: EFFECT.SESSION, desc: "Lower edge of the box, resolved as trigger − this — 160 at the defaults. Honest caveat: with a 20pt stop the trade is already out at fill−20 long before the premium can fall this far, so this edge is unreachable in practice. It becomes live only once the stop is widened past the offset.", default: "20" },
      { key: "SIMPLE930_FORCED_EXIT", label: "Forced Exit (EOD square-off)", type: "time", effect: EFFECT.SESSION, desc: "Hard square-off time (IST) for a trade that expanded out of the box and that the trail never took out.", default: "15:15" },

      // ── Optional guards. Both default to 0 = OFF so the engine ships doing exactly what the rule says. ──
      { key: "SIMPLE930_MAX_PREMIUM_DIST", label: "Max Premium Distance from the Trigger (₹, 0 = off)", type: "number", min: 0, max: 5000, step: 5, effect: EFFECT.SESSION, desc: "0 = off, the default. When set, a side whose nearest strike is further than this from the trigger is not watched at all that day — no contract on that side is close enough for a break of the level to mean anything.", default: "0", subheader: "Optional guards (all OFF by default)" },
      { key: "SIMPLE930_MIN_PREMIUM", label: "Minimum Candidate Premium (₹, 0 = off)", type: "number", min: 0, max: 5000, step: 5, effect: EFFECT.SESSION, desc: "0 = off, the default. Rungs quoting cheaper than this are thrown out of the 09:25 ladder before the pick is made, so a near-worthless contract cannot win the search on a thin quote.", default: "0" },

      // ── Sizing & day-level breakers ──
      { key: "SIMPLE930_LOT_MULTIPLIER", label: "Lot Multiplier (SIMPLE_9:30 only)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Lots per trade. 0 = use the global LOT_MULTIPLIER, which is the default.", default: "0", subheader: "Sizing & Day Breakers" },
      { key: "SIMPLE930_MAX_DAILY_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 20, step: 1, effect: EFFECT.SESSION, desc: "The rule is one trade a day — the entry window shuts at 09:35 and nothing re-arms after it, so raising this only bites if the window is widened too.", default: "1" },
      { key: "SIMPLE930_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 0, max: 50000, step: 250, effect: EFFECT.SESSION, desc: "Stop trading after this much loss (0 = off).", default: "0" },

      // ── Data plumbing ──
      { key: "SIMPLE930_POLL_MS", label: "Option Premium Poll (ms)", type: "number", min: 250, max: 15000, step: 250, effect: EFFECT.SESSION, desc: "How often the two watchlist premiums are fetched. This is the granularity the trigger AND every exit are checked at — the shared tick socket carries the INDEX, and every decision this strategy makes is read off an option premium.", default: "1000", subheader: "Data plumbing" },
      { key: "SIMPLE930_LTP_STALE_MS", label: "Max Quote Age for an Entry (ms)", type: "number", min: 1000, max: 120000, step: 1000, effect: EFFECT.SESSION, desc: "Refuse an entry when the last premium is older than this. A stalled quote feed would otherwise buy a break that happened minutes ago, at a price that no longer exists.", default: "15000" },

      // ── Backtest ──
      { key: "SIMPLE930_BT_SLIPPAGE_PTS", label: "Backtest Spread/Slippage Haircut (pts each way)", type: "number", min: 0, max: 50, step: 0.5, effect: EFFECT.BACKTEST, desc: "Backtest cost per side, in points. Without this, option-buying backtests always flatter.", default: "1.5", subheader: "Backtest" },
    ],
  },
  {
    section: "RSI_PIVOT_ST STRATEGY (RSI + Standard Pivot R1/S1 + SuperTrend) — Zerodha",
    icon: "\u{1F4D0}",
    nav: "RSI PIVOT ST",
    group: "Strategies",
    fields: [
      // ── Enable / live gating ──
      { key: "RSI_PIVOT_ST_PAPER_ENABLED", label: "RSI Pivot ST Paper Trading", type: "toggle", effect: EFFECT.INSTANT, desc: "Allow new RSI Pivot ST paper sessions.", default: "true", subheader: "Mode & Live" },
      { key: "RSI_PIVOT_ST_LIVE_ENABLED", label: "RSI Pivot ST Live Orders (gates /rsi-pivot-st-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Zerodha. NEVER traded — paper-validate first.", default: "false" },
      { key: "RSI_PIVOT_ST_LIVE_DRY_RUN", label: "RSI Pivot ST Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep it simulated even when live is on — the broker call is logged but no real order is sent.", default: "false" },

      // ── The entry rule ──
      { key: "RSI_PIVOT_ST_RESOLUTION", label: "Candle Timeframe (min)", type: "select", options: ["1", "3", "5", "15"], effect: EFFECT.SESSION, desc: "Which candle decides. Entries are taken only on a CLOSED candle of this size — 5-min is the rule as written.", default: "5", subheader: "Signal (RSI + Pivot cross)" },
      { key: "RSI_PIVOT_ST_RSI_PERIOD", label: "RSI Period", type: "number", min: 2, max: 100, step: 1, effect: EFFECT.SESSION, desc: "How many candles the RSI is measured over. 14 is the standard setting and what the rule assumes.", default: "14" },
      { key: "RSI_PIVOT_ST_RSI_CE_MIN", label: "CE needs RSI above", type: "number", min: 0, max: 100, step: 1, effect: EFFECT.SESSION, desc: "A CE (call) is only bought when RSI on the signal candle is above this — momentum must already be strong. Raise it for fewer, stronger buys.", default: "70" },
      { key: "RSI_PIVOT_ST_RSI_PE_MAX", label: "PE needs RSI below", type: "number", min: 0, max: 100, step: 1, effect: EFFECT.SESSION, desc: "A PE (put) is only bought when RSI on the signal candle is below this — selling must already be strong. Lower it for fewer, stronger sells.", default: "40" },
      { key: "RSI_PIVOT_ST_PIVOT_BUFFER_PTS", label: "Pivot Buffer (pts)", type: "number", min: 0, max: 200, step: 1, effect: EFFECT.SESSION, desc: "How far past R1 (or S1) the candle must close before it counts as a break. 0 = a close just beyond the level is enough. Raise it to ignore candles that only tickle the line.", default: "0" },

      // ── Window ──
      { key: "RSI_PIVOT_ST_SESSION_START", label: "Session Start", type: "time", effect: EFFECT.SESSION, desc: "When the strategy starts watching candles for the day (IST).", default: "09:15", subheader: "Session window" },
      { key: "RSI_PIVOT_ST_ENTRY_START", label: "Entry Window Start", type: "time", effect: EFFECT.SESSION, desc: "No entries before this (IST). The first candles of the day are noisy and often break a pivot for no reason.", default: "09:30" },
      { key: "RSI_PIVOT_ST_ENTRY_END", label: "Entry Window End", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (IST) — too late in the day for a fresh trade to work out.", default: "15:00" },
      { key: "RSI_PIVOT_ST_EXIT_TIME", label: "Forced Exit (EOD square-off)", type: "time", effect: EFFECT.SESSION, desc: "Everything still open is closed at this time (IST). Nothing is carried overnight.", default: "15:15" },

      // ── Strike ──
      { key: "RSI_PIVOT_ST_STRIKE_MODE", label: "Which Strike to Buy", type: "select", options: ["ATM", "ITM", "OTM"], effect: EFFECT.SESSION, desc: "Which strike to buy. ATM = nearest to spot. OTM = 1% of spot away from the money (cheaper, needs a bigger move). ITM = 1% into the money (costlier, moves more with spot).", default: "OTM", subheader: "Strike" },
      { key: "RSI_PIVOT_ST_STRIKE_PCT", label: "Strike Distance (% of spot)", type: "number", min: 0, max: 20, step: 0.25, effect: EFFECT.SESSION, desc: "How far from spot the ITM/OTM strike sits, as a percentage. 1% of a 24000 NIFTY is 240 points, rounded to the nearest 50-point strike. Ignored when the mode is ATM.", default: "1" },

      // ── Stops. Deliberately asymmetric — see the CE toggle's note. ──
      { key: "RSI_PIVOT_ST_ST_PERIOD", label: "SuperTrend Period", type: "number", min: 2, max: 100, step: 1, effect: EFFECT.SESSION, desc: "ATR length behind the SuperTrend line used as the CE stop. Longer = a slower, looser trail.", default: "10", subheader: "Stops" },
      { key: "RSI_PIVOT_ST_ST_MULT", label: "SuperTrend Multiplier", type: "number", min: 0.1, max: 10, step: 0.1, effect: EFFECT.SESSION, desc: "How many ATRs below price the SuperTrend line sits. Smaller = a tighter stop that gets hit more often; larger = more room and bigger losses.", default: "2" },
      { key: "RSI_PIVOT_ST_ST_SIDES", label: "SuperTrend Stop Applies To", type: "select", options: [{ value: "CE", label: "CE only (original rule)" }, { value: "BOTH", label: "Both CE and PE" }, { value: "PE", label: "PE only" }, { value: "NONE", label: "Neither (no SuperTrend stop)" }], effect: EFFECT.SESSION, desc: "Which side uses the SuperTrend line as its stop and trail, on top of the premium stop. CE is the original rule. On PE the line is mirrored: it sits ABOVE price and a flip to bullish is the exit. A side that uses it also gains the \"SuperTrend must be on the right side of price\" entry check, so it takes FEWER trades; a side without it relies on the premium stop alone.", default: "CE" },
      { key: "RSI_PIVOT_ST_PREMIUM_SL_PCT", label: "Premium Stop (% of option price)", type: "number", min: 1, max: 90, step: 1, effect: EFFECT.SESSION, desc: "Exit when the option price falls this far below its best price so far. 25 means: bought at 100, exit at 75; if it runs to 140, the exit rises to 105. Which sides use it is set by the toggle below.", default: "25" },
      { key: "RSI_PIVOT_ST_PREMIUM_SL_SIDES", label: "Premium Stop Applies To", type: "select", options: [{ value: "BOTH", label: "Both CE and PE" }, { value: "CE", label: "CE only" }, { value: "PE", label: "PE only" }, { value: "NONE", label: "Neither (no premium stop)" }], effect: EFFECT.SESSION, desc: "Which side carries the premium stop. WARNING: PE has no other stop — it never uses the SuperTrend — so choosing \"CE only\" or \"Neither\" leaves every PE trade with NO stop at all, and the 15:15 square-off becomes its only exit. The same is true for CE if you also switch the SuperTrend stop off above. The engine still takes those trades but warns loudly in the log.", default: "BOTH" },

      // ── Sizing & day-level breakers ──
      { key: "RSI_PIVOT_ST_LOT_MULTIPLIER", label: "Lot Multiplier (RSI Pivot ST only)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Lots per trade. 0 = use the global LOT_MULTIPLIER, which is the default.", default: "0", subheader: "Sizing & Day Breakers" },
      { key: "RSI_PIVOT_ST_MAX_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Max entries per day. The pivot levels are fixed all day, so a handful of crosses is all this rule can honestly produce.", default: "5" },
      { key: "RSI_PIVOT_ST_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 0, max: 50000, step: 250, effect: EFFECT.SESSION, desc: "Stop trading for the day after this much loss (0 = off).", default: "5000" },
      { key: "RSI_PIVOT_ST_MAX_WEEKLY_LOSS", label: "Max Weekly Loss (₹)", type: "number", min: 0, max: 200000, step: 500, effect: EFFECT.SESSION, desc: "Stop trading for the rest of the week after this much loss across Mon–today (0 = off). Read from the day files, so it survives a restart.", default: "0" },

      // ── Backtest ──
      { key: "RSI_PIVOT_ST_BT_SLIPPAGE_PTS", label: "Backtest Spread/Slippage Haircut (pts each way)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.BACKTEST, desc: "Backtest cost per side, in points. Without this, option-buying backtests always flatter.", default: "2", subheader: "Backtest" },
      { key: "RSI_PIVOT_ST_BT_SEED_PREMIUM", label: "Backtest Seed Premium (₹)", type: "number", min: 20, max: 1000, step: 10, effect: EFFECT.BACKTEST, desc: "Starting option price the backtest assumes, since there is no historical option chain. The 25% stop is measured against this simulated premium, so it is the weakest number in any backtest result.", default: "180" },
    ],
  },
  {
    section: "BN_PIVOT_RSI_ST STRATEGY (NIFTY BANK — RSI + Standard Pivot R1/S1 + SuperTrend) — Zerodha",
    icon: "\u{1F3E6}",
    nav: "BN PIVOT RSI ST",
    group: "Strategies",
    fields: [
      // An exact replica of RSI_PIVOT_ST — same rules, same thresholds, same
      // stops, same defaults — trading NIFTY BANK instead of NIFTY 50. Keep
      // the two sections in step: a change to one is almost always a change
      // to both. The index-level constants (strike grid, lot size, expiry)
      // are NOT here — they live in the NIFTY BANK block of
      // Instrument & Backtest, shared by every NIFTY BANK strategy.
      // ── Enable / live gating ──
      { key: "BN_PIVOT_RSI_ST_PAPER_ENABLED", label: "BN Pivot RSI ST Paper Trading", type: "toggle", effect: EFFECT.INSTANT, desc: "Allow new BN Pivot RSI ST paper sessions.", default: "true", subheader: "Mode & Live" },
      { key: "BN_PIVOT_RSI_ST_LIVE_ENABLED", label: "BN Pivot RSI ST Live Orders (gates /bn-pivot-rsi-st-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Zerodha. NEVER traded — paper-validate first.", default: "false" },
      { key: "BN_PIVOT_RSI_ST_LIVE_DRY_RUN", label: "BN Pivot RSI ST Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep it simulated even when live is on — the broker call is logged but no real order is sent.", default: "false" },

      // ── The entry rule ──
      { key: "BN_PIVOT_RSI_ST_RESOLUTION", label: "Candle Timeframe (min)", type: "select", options: ["1", "3", "5", "15"], effect: EFFECT.SESSION, desc: "Which candle decides. Entries are taken only on a CLOSED candle of this size — 5-min is the rule as written.", default: "5", subheader: "Signal (RSI + Pivot cross)" },
      { key: "BN_PIVOT_RSI_ST_RSI_PERIOD", label: "RSI Period", type: "number", min: 2, max: 100, step: 1, effect: EFFECT.SESSION, desc: "How many candles the RSI is measured over. 14 is the standard setting and what the rule assumes.", default: "14" },
      { key: "BN_PIVOT_RSI_ST_RSI_CE_MIN", label: "CE needs RSI above", type: "number", min: 0, max: 100, step: 1, effect: EFFECT.SESSION, desc: "A CE (call) is only bought when RSI on the signal candle is above this — momentum must already be strong. Raise it for fewer, stronger buys.", default: "70" },
      { key: "BN_PIVOT_RSI_ST_RSI_PE_MAX", label: "PE needs RSI below", type: "number", min: 0, max: 100, step: 1, effect: EFFECT.SESSION, desc: "A PE (put) is only bought when RSI on the signal candle is below this — selling must already be strong. Lower it for fewer, stronger sells.", default: "40" },
      { key: "BN_PIVOT_RSI_ST_PIVOT_BUFFER_PTS", label: "Pivot Buffer (pts)", type: "number", min: 0, max: 200, step: 1, effect: EFFECT.SESSION, desc: "How far past R1 (or S1) the candle must close before it counts as a break. 0 = a close just beyond the level is enough. Raise it to ignore candles that only tickle the line.", default: "0" },

      // ── Window ──
      { key: "BN_PIVOT_RSI_ST_SESSION_START", label: "Session Start", type: "time", effect: EFFECT.SESSION, desc: "When the strategy starts watching candles for the day (IST).", default: "09:15", subheader: "Session window" },
      { key: "BN_PIVOT_RSI_ST_ENTRY_START", label: "Entry Window Start", type: "time", effect: EFFECT.SESSION, desc: "No entries before this (IST). The first candles of the day are noisy and often break a pivot for no reason.", default: "09:30" },
      { key: "BN_PIVOT_RSI_ST_ENTRY_END", label: "Entry Window End", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (IST) — too late in the day for a fresh trade to work out.", default: "15:00" },
      { key: "BN_PIVOT_RSI_ST_EXIT_TIME", label: "Forced Exit (EOD square-off)", type: "time", effect: EFFECT.SESSION, desc: "Everything still open is closed at this time (IST). Nothing is carried overnight.", default: "15:15" },

      // ── Strike ──
      { key: "BN_PIVOT_RSI_ST_STRIKE_MODE", label: "Which Strike to Buy", type: "select", options: ["ATM", "ITM", "OTM"], effect: EFFECT.SESSION, desc: "Which strike to buy. ATM = nearest to spot. OTM = 1% of spot away from the money (cheaper, needs a bigger move). ITM = 1% into the money (costlier, moves more with spot).", default: "OTM", subheader: "Strike" },
      { key: "BN_PIVOT_RSI_ST_STRIKE_PCT", label: "Strike Distance (% of spot)", type: "number", min: 0, max: 20, step: 0.25, effect: EFFECT.SESSION, desc: "How far from spot the ITM/OTM strike sits, as a percentage. 1% of a 54000 NIFTY BANK is 540 points, rounded to the nearest 100-point strike. Ignored when the mode is ATM.", default: "1" },

      // ── Stops. Deliberately asymmetric — see the CE toggle's note. ──
      { key: "BN_PIVOT_RSI_ST_ST_PERIOD", label: "SuperTrend Period", type: "number", min: 2, max: 100, step: 1, effect: EFFECT.SESSION, desc: "ATR length behind the SuperTrend line used as the CE stop. Longer = a slower, looser trail.", default: "10", subheader: "Stops" },
      { key: "BN_PIVOT_RSI_ST_ST_MULT", label: "SuperTrend Multiplier", type: "number", min: 0.1, max: 10, step: 0.1, effect: EFFECT.SESSION, desc: "How many ATRs below price the SuperTrend line sits. Smaller = a tighter stop that gets hit more often; larger = more room and bigger losses.", default: "2" },
      { key: "BN_PIVOT_RSI_ST_ST_SIDES", label: "SuperTrend Stop Applies To", type: "select", options: [{ value: "CE", label: "CE only (original rule)" }, { value: "BOTH", label: "Both CE and PE" }, { value: "PE", label: "PE only" }, { value: "NONE", label: "Neither (no SuperTrend stop)" }], effect: EFFECT.SESSION, desc: "Which side uses the SuperTrend line as its stop and trail, on top of the premium stop. CE is the original rule. On PE the line is mirrored: it sits ABOVE price and a flip to bullish is the exit. A side that uses it also gains the \"SuperTrend must be on the right side of price\" entry check, so it takes FEWER trades; a side without it relies on the premium stop alone.", default: "CE" },
      { key: "BN_PIVOT_RSI_ST_PREMIUM_SL_PCT", label: "Premium Stop (% of option price)", type: "number", min: 1, max: 90, step: 1, effect: EFFECT.SESSION, desc: "Exit when the option price falls this far below its best price so far. 25 means: bought at 100, exit at 75; if it runs to 140, the exit rises to 105. Which sides use it is set by the toggle below.", default: "25" },
      { key: "BN_PIVOT_RSI_ST_PREMIUM_SL_SIDES", label: "Premium Stop Applies To", type: "select", options: [{ value: "BOTH", label: "Both CE and PE" }, { value: "CE", label: "CE only" }, { value: "PE", label: "PE only" }, { value: "NONE", label: "Neither (no premium stop)" }], effect: EFFECT.SESSION, desc: "Which side carries the premium stop. WARNING: PE has no other stop — it never uses the SuperTrend — so choosing \"CE only\" or \"Neither\" leaves every PE trade with NO stop at all, and the 15:15 square-off becomes its only exit. The same is true for CE if you also switch the SuperTrend stop off above. The engine still takes those trades but warns loudly in the log.", default: "BOTH" },

      // ── Sizing & day-level breakers ──
      { key: "BN_PIVOT_RSI_ST_LOT_MULTIPLIER", label: "Lot Multiplier (BN Pivot RSI ST only)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Lots per trade. 0 = use the global LOT_MULTIPLIER, which is the default.", default: "0", subheader: "Sizing & Day Breakers" },
      { key: "BN_PIVOT_RSI_ST_MAX_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Max entries per day. The pivot levels are fixed all day, so a handful of crosses is all this rule can honestly produce.", default: "5" },
      { key: "BN_PIVOT_RSI_ST_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 0, max: 50000, step: 250, effect: EFFECT.SESSION, desc: "Stop trading for the day after this much loss (0 = off).", default: "5000" },
      { key: "BN_PIVOT_RSI_ST_MAX_WEEKLY_LOSS", label: "Max Weekly Loss (₹)", type: "number", min: 0, max: 200000, step: 500, effect: EFFECT.SESSION, desc: "Stop trading for the rest of the week after this much loss across Mon–today (0 = off). Read from the day files, so it survives a restart.", default: "0" },

      // ── Backtest ──
      { key: "BN_PIVOT_RSI_ST_BT_SLIPPAGE_PTS", label: "Backtest Spread/Slippage Haircut (pts each way)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.BACKTEST, desc: "Backtest cost per side, in points. Without this, option-buying backtests always flatter.", default: "2", subheader: "Backtest" },
      { key: "BN_PIVOT_RSI_ST_BT_SEED_PREMIUM", label: "Backtest Seed Premium (₹)", type: "number", min: 20, max: 1000, step: 10, effect: EFFECT.BACKTEST, desc: "Starting option price the backtest assumes, since there is no historical option chain. The 25% stop is measured against this simulated premium, so it is the weakest number in any backtest result.", default: "180" },
    ],
  },
  {
    section: "OPEN-INTEREST FILTER (OI + Price Buildup)",
    icon: "📊",
    nav: "OI Filter",
    group: "Trading",
    fields: [
      { key: "OI_FILTER_ENABLED", label: "OI Filter MASTER (all strategies)", type: "toggle", effect: EFFECT.INSTANT, desc: "Master switch for the open-interest filter.", default: "false" },
      { key: "EMA_RSI_ST_OI_ENABLED", label: "OI Filter (EMA_RSI_ST)", type: "toggle", effect: EFFECT.INSTANT, desc: "Apply the OI filter to this strategy.", default: "false" },
      { key: "BB_RSI_OI_ENABLED", label: "OI Filter (BB_RSI)", type: "toggle", effect: EFFECT.INSTANT, desc: "Apply the OI filter to this strategy.", default: "false" },
      { key: "PA_OI_ENABLED", label: "OI Filter (PA)", type: "toggle", effect: EFFECT.INSTANT, desc: "Apply the OI filter to this strategy.", default: "false" },
      { key: "ORB_OI_ENABLED", label: "OI Filter (ORB)", type: "toggle", effect: EFFECT.INSTANT, desc: "Apply the OI filter to this strategy.", default: "false" },
      { key: "EMA9VWAP_OI_ENABLED", label: "OI Filter (EMA9+VWAP)", type: "toggle", effect: EFFECT.INSTANT, desc: "Apply the OI filter to this strategy.", default: "false" },
      { key: "OI_LOOKBACK_CANDLES", label: "OI Lookback (candles)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Candles to measure the OI change over.", default: "3" },
      { key: "OI_MIN_DELTA_PCT", label: "OI Min Change % (noise floor)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.INSTANT, desc: "Ignore OI changes smaller than this %.", default: "1" },
      { key: "OI_FAIL_MODE", label: "OI Unavailable (fail mode)", type: "select", options: ["open", "closed"], effect: EFFECT.INSTANT, desc: "What to do when OI data is missing.", default: "open" },
    ],
  },
  {
    section: "Instrument & Backtest",
    icon: "📈",
    nav: "Instrument & Backtest",
    group: "Trading",
    fields: [
      { key: "CHART_ENABLED", label: "Live NIFTY Chart", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the candlestick chart on status pages.", default: "true", subheader: "Instrument & Session" },
      { key: "VIX_FAIL_MODE", label: "VIX Unavailable (all modules)", type: "select", options: ["closed", "open"], effect: EFFECT.INSTANT, desc: "What to do when VIX data is missing.", default: "closed" },
      { key: "TRADE_RESOLUTION", label: "Candle Resolution (min) — ALL strategies", type: "select", options: ["3", "5", "15"], effect: EFFECT.SESSION, desc: "Candle timeframe in minutes. One global setting — every strategy uses it.", default: "5" },
      { key: "TRADE_START_TIME", label: "Market Start Time", type: "time", effect: EFFECT.SESSION, desc: "Market open time (IST).", default: "09:15" },
      { key: "TRADE_STOP_TIME", label: "Market Stop Time", type: "time", effect: EFFECT.SESSION, desc: "Auto-stop and square-off time (IST).", default: "15:30" },
      { key: "INSTRUMENT", label: "Trade Type", type: "select", options: ["NIFTY_OPTIONS", "NIFTY_FUTURES"], effect: EFFECT.INSTANT, desc: "Options (CE/PE) or Futures." },
      { key: "LOT_MULTIPLIER", label: "Lot Multiplier", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "Number of lots per trade." },
      { key: "EXPIRY_HEALTHCHECK_ENABLED", label: "Expiry Health Check", type: "toggle", effect: EFFECT.SERVER, desc: "Check before the open that the expiry names a contract the broker quotes.", default: "true" },
      { key: "EXPIRY_HEALTHCHECK_MINS", label: "Expiry Check Interval (min)", type: "number", min: 5, max: 240, step: 5, effect: EFFECT.SERVER, desc: "How often to re-check the expiry (08:00–15:30 IST). After the close it always runs at 15:40, retrying at 16:15 / 16:30 / 16:45, so a just-expired date rolls the same day.", default: "30" },
      { key: "EXPIRY_AUTO_ROLL_ENABLED", label: "Auto-Roll Expired Expiry", type: "toggle", effect: EFFECT.INSTANT, desc: "When the expiry above is blank or expired, replace it with the next one automatically.", default: "true" },

      // ── PER-INDEX CONFIGURATION ────────────────────────────────────────────
      // One block per underlying, and the blocks are deliberately IDENTICAL in
      // shape: same nine fields, same order — only the env key names and the
      // numbers change. Adding a third index means copying one block, renaming
      // its keys and adding the matching row to UNDERLYING_DEFS in
      // src/config/instrument.js, which is where the engines read them from.
      //
      // They are written out by hand rather than generated from
      // instrumentConfig.listUnderlyings() because scripts/genEnvDocs.js parses
      // THIS FILE line by line looking for `key: "..."` literals — a generated
      // block would document nothing, and docs/ENV.md is a build artifact.
      //
      // NIFTY keeps its ORIGINAL, unprefixed key names (STRIKE_OFFSET_CE,
      // OPTION_EXPIRY_OVERRIDE, ...). Renaming them would silently reset every
      // existing .env to defaults on the next deploy.
      { key: "NIFTY_STRIKE_STEP", label: "NIFTY 50 — Strike Step (pts)", type: "number", min: 5, max: 1000, step: 5, effect: EFFECT.INSTANT, desc: "The strike grid this index is listed on. NIFTY 50 strikes exist every 50 points, so the ATM strike is spot rounded to the nearest 50. Change it only if NSE changes the grid.", default: "50", subheader: "NIFTY 50" },
      { key: "NIFTY_LOT_SIZE", label: "Lot Size (Qty)", type: "number", min: 1, max: 200, step: 1, effect: EFFECT.INSTANT, desc: "Quantity per lot." },
      { key: "STRIKE_OFFSET_CE", label: "CE Strike Offset", type: "number", min: -200, max: 200, step: 50, effect: EFFECT.INSTANT, desc: "CE strike vs ATM (-50=ITM, 0=ATM, +50=OTM).", default: "0" },
      { key: "STRIKE_OFFSET_PE", label: "PE Strike Offset", type: "number", min: -200, max: 200, step: 50, effect: EFFECT.INSTANT, desc: "PE strike vs ATM (+50=ITM, 0=ATM, -50=OTM).", default: "0" },
      { key: "NIFTY_WEEKLY_EXPIRY_ENABLED", label: "NIFTY 50 — Weekly Expiries Exist", type: "toggle", effect: EFFECT.INSTANT, desc: "NIFTY 50 lists a weekly (Tuesday) contract as well as the monthly one, so this stays ON. Turning it off makes every NIFTY 50 expiry resolve to the month contract instead.", default: "true" },
      { key: "OPTION_EXPIRY_TYPE", label: "Expiry Type", type: "select", options: ["weekly", "monthly"], effect: EFFECT.INSTANT, desc: "Weekly or monthly expiry.", default: "weekly" },
      { key: "OPTION_EXPIRY_OVERRIDE", label: "Option Expiry (manual)", type: "date", effect: EFFECT.INSTANT, desc: "Option expiry for all strategies. Filled in automatically once the stored one expires; a future date you set is left alone." },
      { key: "NIFTY_SPOT_FALLBACK", label: "NIFTY Spot Fallback", type: "number", min: 15000, max: 35000, step: 50, effect: EFFECT.INSTANT, desc: "Fallback NIFTY price when no live quote.", default: "24000" },
      { key: "NIFTY_FUTURES_MARGIN_PCT", label: "Futures Margin %", type: "number", min: 1, max: 100, step: 0.5, effect: EFFECT.INSTANT, desc: "SPAN+exposure margin as % of notional, used to size the capital pool when Trade Type is NIFTY_FUTURES. Advisory only — never blocks a trade.", default: "11" },

      // NIFTY BANK — same nine fields, BANKNIFTY_-prefixed keys. Every value
      // here is read live per entry, so a save applies without a restart.
      { key: "BANKNIFTY_STRIKE_STEP", label: "NIFTY BANK — Strike Step (pts)", type: "number", min: 5, max: 1000, step: 5, effect: EFFECT.INSTANT, desc: "The strike grid this index is listed on. NIFTY BANK strikes exist every 100 points, so the ATM strike is spot rounded to the nearest 100. Change it only if NSE changes the grid.", default: "100", subheader: "NIFTY BANK" },
      { key: "BANKNIFTY_LOT_SIZE", label: "NIFTY BANK — Lot Size (Qty)", type: "number", min: 1, max: 200, step: 1, effect: EFFECT.INSTANT, desc: "Quantity per NIFTY BANK lot — 30 since NSE's Nov-2024 revision.", default: "30" },
      { key: "BANKNIFTY_STRIKE_OFFSET_CE", label: "NIFTY BANK — CE Strike Offset", type: "number", min: -400, max: 400, step: 100, effect: EFFECT.INSTANT, desc: "CE strike vs ATM, in points on the 100-point grid (-100=ITM, 0=ATM, +100=OTM).", default: "0" },
      { key: "BANKNIFTY_STRIKE_OFFSET_PE", label: "NIFTY BANK — PE Strike Offset", type: "number", min: -400, max: 400, step: 100, effect: EFFECT.INSTANT, desc: "PE strike vs ATM, in points on the 100-point grid (+100=ITM, 0=ATM, -100=OTM).", default: "0" },
      { key: "BANKNIFTY_WEEKLY_EXPIRY_ENABLED", label: "NIFTY BANK — Weekly Expiries Exist", type: "toggle", effect: EFFECT.INSTANT, desc: "OFF, and it must stay off: NSE WITHDREW BANKNIFTY weekly options in November 2024, so every NIFTY BANK contract is the MONTHLY one. This toggle exists only for the day NSE changes its mind — switching it on lets the engine build weekly (YYMDD) symbols again, and until that day those symbols simply do not exist, so every entry would be refused.", default: "false" },
      { key: "BANKNIFTY_OPTION_EXPIRY_TYPE", label: "NIFTY BANK — Expiry Type", type: "select", options: ["monthly", "weekly"], effect: EFFECT.INSTANT, desc: "Monthly is the only real answer today — NSE WITHDREW BANKNIFTY weekly options in November 2024, so there is no weekly NIFTY BANK contract to name. Weekly is honoured only if the Weekly Expiries Exist toggle above is switched on, which is there purely for the day NSE reverses that decision.", default: "monthly" },
      { key: "BANKNIFTY_OPTION_EXPIRY_OVERRIDE", label: "NIFTY BANK — Option Expiry (manual)", type: "date", effect: EFFECT.INSTANT, desc: "Manual NIFTY BANK expiry (YYYY-MM-DD) for every NIFTY BANK strategy. Blank = auto-detect, which is normally what you want. A date that has already passed BLOCKS NIFTY BANK entries rather than quietly trading a different expiry." },
      { key: "BANKNIFTY_SPOT_FALLBACK", label: "NIFTY BANK — Spot Fallback", type: "number", min: 30000, max: 80000, step: 100, effect: EFFECT.INSTANT, desc: "Fallback NIFTY BANK price when no live quote is available.", default: "54000" },
      { key: "BANKNIFTY_FUTURES_MARGIN_PCT", label: "NIFTY BANK — Futures Margin %", type: "number", min: 1, max: 100, step: 0.5, effect: EFFECT.INSTANT, desc: "SPAN+exposure margin as % of notional, used to size the capital pool when the Trade Type is futures. Advisory only — never blocks a trade.", default: "11" },

      { key: "TICK_RECORDER_ENABLED", label: "Tick Recorder (for Replay)", type: "toggle", effect: EFFECT.SESSION, desc: "Record ticks so sessions can be replayed.", default: "true", subheader: "Recording & Replay" },
      { key: "TICK_RECORDER_RETAIN_DAYS", label: "Tick Recordings Retention (days)", type: "number", min: 7, max: 180, step: 1, effect: EFFECT.SERVER, desc: "Delete tick recordings older than this.", default: "30" },
      { key: "OPTION_CHAIN_RECORDER_ENABLED", label: "Day-Wide Option-Chain Recorder", type: "toggle", effect: EFFECT.INSTANT, desc: "Record the option chain for replay.", default: "true" },
      { key: "OPTION_CHAIN_RECORD_INTERVAL_SEC", label: "Option-Chain Record Interval (sec)", type: "number", min: 2, max: 60, step: 1, effect: EFFECT.INSTANT, desc: "How often to record the option chain (sec).", default: "5" },
      { key: "OPTION_CHAIN_RECORD_STRIKES", label: "Option-Chain Strikes (ATM±N)", type: "number", min: 1, max: 15, step: 1, effect: EFFECT.INSTANT, desc: "Strikes each side of ATM to record.", default: "5" },
      { key: "OPTION_CHAIN_RECORD_OI", label: "Record Per-Strike Open Interest", type: "toggle", effect: EFFECT.INSTANT, desc: "Also capture each strike's Open Interest from the same quotes (no extra API calls). Feeds the OI Monitor and chain_oi.jsonl. Fyers has no historical-OI API, so turning this off means that day's OI is gone for good.", default: "true" },
      { key: "SPOT_FEED_ALWAYS_ON", label: "Always-On Spot Feed (day recording)", type: "toggle", effect: EFFECT.INSTANT, desc: "Record the spot feed all day, even with no strategy running.", default: "true" },
      { key: "OPTION_SOCKET_FEED_ENABLED", label: "Stream Option Prices on the Socket", type: "toggle", effect: EFFECT.INSTANT, desc: "Get held option prices from the live feed instead of repeated REST polls. Off = every strategy polls on its own timer.", default: "true", subheader: "Option Price Feed" },
      { key: "OPTION_SOCKET_FRESH_MS", label: "Streamed Price Max Age (ms)", type: "number", min: 500, max: 60000, step: 500, effect: EFFECT.INSTANT, desc: "Older than this and the strategy falls back to a REST poll.", default: "4000" },
      { key: "OPTION_SOCKET_LEASE_MS", label: "Option Subscription Lease (ms)", type: "number", min: 5000, max: 120000, step: 1000, effect: EFFECT.INSTANT, desc: "A contract is unsubscribed this long after the last strategy stops asking for it.", default: "15000" },
      { key: "OPTION_SOCKET_RECORD_MS", label: "Streamed Price Record Interval (ms)", type: "number", min: 100, max: 10000, step: 100, effect: EFFECT.INSTANT, desc: "How often streamed option prices are written to the replay recording.", default: "1000" },
      { key: "LIVE_HARNESS_DRY_RUN", label: "Live Harness DRY-RUN (GLOBAL)", type: "toggle", effect: EFFECT.SESSION, desc: "Global switch: log live orders but place none.", default: "true", subheader: "Live Safety" },
      { key: "LIVE_EXIT_WAIT_MS", label: "Live Exit Wait Ceiling (ms)", type: "number", min: 0, max: 120000, step: 1000, effect: EFFECT.INSTANT, desc: "How long to wait on a live exit before alerting (ms).", default: "20000" },
      { key: "PA_LIVE_ENABLED", label: "PA — allow real orders", type: "toggle", effect: EFFECT.SESSION, desc: "Second gate for PA Live. Off = PA stays simulated even with the global switch off.", default: "false" },
      { key: "BB_RSI_LIVE_ENABLED", label: "BB_RSI — allow real orders", type: "toggle", effect: EFFECT.SESSION, desc: "Second gate for BB_RSI Live. Off = BB_RSI stays simulated even with the global switch off.", default: "false" },
      { key: "PA_LIVE_DRY_RUN", label: "PA Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep PA simulated even when live is on.", default: "false" },
      { key: "BB_RSI_LIVE_DRY_RUN", label: "BB_RSI Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep BB_RSI simulated even when live is on.", default: "false" },
      { key: "HARNESS_EXCHANGE_SL_ENABLED", label: "Harness Exchange SL", type: "toggle", effect: EFFECT.SESSION, desc: "Leave a stop-loss order at the exchange for harness-run strategies (Trend PB, EMA9+VWAP, TDS). Off = the stop only lives in this process and dies with it.", default: "false" },
      { key: "HARNESS_SL_PCT", label: "Harness Exchange SL (% of premium)", type: "number", min: 0.05, max: 0.95, step: 0.05, effect: EFFECT.SESSION, desc: "How far below the entry premium that stop sits. 0.5 = trigger at half the premium paid.", default: "0.5" },
      { key: "BACKTEST_OPTION_SIM", label: "Option Simulation (legacy bar-based BT only)", type: "toggle", effect: EFFECT.BACKTEST, desc: "Simulate option P&L in the legacy backtest.", subheader: "Backtest Simulation" },
      { key: "BACKTEST_DELTA", label: "Delta", type: "number", min: 0.1, max: 1.0, step: 0.05, effect: EFFECT.BACKTEST, desc: "Option delta for premium simulation." },
      { key: "BACKTEST_THETA_DAY", label: "Theta ₹/day", type: "number", min: 0, max: 50, step: 1, effect: EFFECT.BACKTEST, desc: "Daily theta decay in rupees." },
      { key: "BACKTEST_SLIPPAGE_PTS", label: "Slippage (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.BACKTEST, desc: "Simulated slippage per side, in points.", default: "0" },
      { key: "LTP_STALE_THRESHOLD_SEC", label: "LTP Stale Alert (sec)", type: "number", min: 5, max: 60, step: 5, effect: EFFECT.INSTANT, desc: "Warn if the option price hasn't updated for this long (sec).", default: "15", subheader: "Execution Guards" },
      { key: "LTP_STALE_FALLBACK_SEC", label: "LTP Stale Fallback (sec)", type: "number", min: 1, max: 30, step: 1, effect: EFFECT.SESSION, desc: "Use candle close if the option price is older than this (sec).", default: "5" },
      { key: "GAP_THRESHOLD_PTS", label: "Gap Threshold (pts)", type: "number", min: 10, max: 200, step: 5, effect: EFFECT.SESSION, desc: "Skip the first candle on a big overnight gap.", default: "50" },
      { key: "MAX_BID_ASK_SPREAD_PTS", label: "Max Bid-Ask Spread (pts)", type: "number", min: 0, max: 20, step: 0.5, effect: EFFECT.SESSION, desc: "Reject entries when the spread is wider than this.", default: "2" },
      { key: "TIME_STOP_CANDLES", label: "Time-Stop Candles (default)", type: "number", min: 2, max: 12, step: 1, effect: EFFECT.SESSION, desc: "Default time-stop window, in candles.", default: "4" },
      { key: "TIME_STOP_FLAT_PTS", label: "Time-Stop Flat (pts, default)", type: "number", min: 5, max: 40, step: 1, effect: EFFECT.SESSION, desc: "Flat-P&L band that triggers the time-stop.", default: "20" },
      { key: "HARD_SL_ENABLED", label: "Hard SL (Exchange)", type: "toggle", effect: EFFECT.SESSION, desc: "Place a stop-loss order at the exchange on entry.", default: "false" },
      { key: "HARD_SL_DELTA", label: "Hard SL Delta", type: "number", min: 0.2, max: 0.8, step: 0.05, effect: EFFECT.INSTANT, desc: "Delta used to convert the spot stop to a premium trigger.", default: "0.5" },
      { key: "ZERODHA_INV_AMOUNT", label: "Zerodha Investment Amount (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.INSTANT, desc: "Paper money pool for Zerodha strategies (₹).", default: "100000", subheader: "Capital" },
      { key: "FYERS_INV_AMOUNT", label: "Fyers Investment Amount (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.INSTANT, desc: "Paper money pool for Fyers strategies (₹).", default: "100000" },
      { key: "BACKTEST_CAPITAL", label: "Backtest Capital (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.BACKTEST },
      { key: "PAPER_CAPITAL_GATE_ENABLED", label: "Track Paper Capital", type: "toggle", effect: EFFECT.INSTANT, desc: "Treat the investment amounts as real money: block qty × premium on entry, release it with the P&L on exit, so profits grow the pool and losses shrink it. Running out never stops a trade — the Real-Time dashboard raises an alert instead. Off = display only.", default: "true" },
      { key: "PAPER_CAPITAL_EST_PREMIUM", label: "Assumed Premium for Capital Check (₹)", type: "number", min: 20, max: 1000, step: 10, effect: EFFECT.INSTANT, desc: "EMA_RSI_ST / EMA9+VWAP / BB_RSI / PA decide before their option quote arrives — this premium is assumed for the check, then corrected to the real one a second later.", default: "200" },
    ],
  },
  {
    section: "Server & Broker",
    icon: "🖥️",
    nav: "Server & Broker",
    group: "System",
    fields: [
      { key: "PORT", label: "Port", type: "number", min: 1000, max: 65535, step: 1, effect: EFFECT.SERVER },
      { key: "EC2_IP", label: "EC2 IP", type: "text", effect: EFFECT.SERVER },
      { key: "CACHE_MAX_DAYS", label: "Candle Cache (days)", type: "number", min: 15, max: 180, step: 15, effect: EFFECT.INSTANT, desc: "Delete cached candles older than this.", default: "60" },
      { key: "APP_ID", label: "Fyers App ID", type: "text", effect: EFFECT.SERVER },
      { key: "REDIRECT_URL", label: "Fyers Redirect URL", type: "text", effect: EFFECT.SERVER },
      { key: "ZERODHA_API_KEY", label: "Zerodha API Key", type: "text", effect: EFFECT.SERVER },

      // ── Token Sync — the /token-sync "Pull from LIVE" button ────────────────
      // Only used on a laptop: it calls the LIVE server's own /token-sync/tokens
      // and applies what comes back. Blank secrets mean "use this machine's own",
      // which is right whenever both boxes share the same .env.
      { key: "TOKEN_SYNC_LIVE_URL",          label: "Token Sync: LIVE Server URL",       type: "text",     effect: EFFECT.INSTANT, desc: "Address of the LIVE server the Token Sync page pulls tokens from, e.g. https://43.205.26.92:3000 (blank = pull button off).", default: "", subheader: "Token Sync (pull from LIVE)" },
      { key: "TOKEN_SYNC_LIVE_LOGIN_SECRET", label: "Token Sync: LIVE Login Password",   type: "password", effect: EFFECT.INSTANT, desc: "Login password of the LIVE server (blank = use this machine's Login Password)." },
      { key: "TOKEN_SYNC_LIVE_API_SECRET",   label: "Token Sync: LIVE App Secret",       type: "password", effect: EFFECT.INSTANT, desc: "App secret of the LIVE server (blank = use this machine's App Secret)." },
      { key: "TOKEN_SYNC_ALLOW_SELF_SIGNED", label: "Token Sync: Allow Self-Signed Cert", type: "toggle",  effect: EFFECT.INSTANT, desc: "LIVE serves its own certificate, so keep this on unless a real certificate is installed there.", default: "true" },

      { key: "MANUAL_TRADES_AUTO_SYNC_ENABLED", label: "Manual Trades Auto-Sync (Kite)", type: "toggle", effect: EFFECT.SESSION, desc: "Daily 15:35 IST auto-pull of today's manual Kite fills into P&L History → Manual Trading Analytics. Kite has no historical-trade API, so this only ever captures today going forward — past trades still need a one-time Console CSV import.", default: "true", subheader: "Manual Trades" },
    ],
  },
  {
    section: "Backup & Restore",
    icon: "📦",
    nav: "Backup & Restore",
    group: "System",
    fields: [
      { key: "BACKUP_ENABLED", label: "Daily Data Backup", type: "toggle", effect: EFFECT.INSTANT, desc: "Cut a daily downloadable backup of your data.", default: "true" },
      { key: "BACKUP_HOUR_IST", label: "Snapshot Hour (IST)", type: "number", min: 0, max: 23, step: 1, effect: EFFECT.SERVER, desc: "Hour of day the backup is taken (IST).", default: "16" },
      { key: "BACKUP_RETAIN_DAYS", label: "Keep Pre-Restore Snapshots (days)", type: "number", min: 1, max: 90, step: 1, effect: EFFECT.INSTANT, desc: "Keep pre-restore safety snapshots this many days.", default: "14" },
      { key: "BACKUP_TG_ENABLED", label: "Telegram Backup Heartbeat", type: "toggle", effect: EFFECT.INSTANT, desc: "Telegram a message when each backup is ready.", default: "false" },
    ],
  },
  {
    section: "Telegram",
    icon: "📱",
    nav: "Telegram",
    group: "System",
    fields: [
      { key: "TELEGRAM_CHAT_ID", label: "Chat ID", type: "text", effect: EFFECT.INSTANT, desc: "Leave blank to disable notifications.", subheader: "Connection" },
      { key: "TG_ENABLED", label: "Telegram Alerts (Master)", type: "toggle", effect: EFFECT.INSTANT, desc: "Master switch for all Telegram alerts.", default: "true" },

      { key: "TG_EMA_RSI_ST_STARTED", label: "EMA_RSI_ST — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when an EMA_RSI_ST session starts.", default: "true", subheader: "Session Start" },
      { key: "TG_BB_RSI_STARTED", label: "BB_RSI — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a BB_RSI session starts.", default: "true" },
      { key: "TG_PA_STARTED",    label: "Price Action — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a Price Action session starts.", default: "true" },
      { key: "TG_ORB_STARTED",      label: "ORB — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when an ORB session starts.", default: "true" },
      { key: "TG_EMA9VWAP_STARTED", label: "EMA9+VWAP — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when an EMA9+VWAP session starts.", default: "true" },
      { key: "TG_TREND_PB_STARTED", label: "Trend Pullback — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a Trend Pullback session starts.", default: "true" },
      { key: "TG_TDS_STARTED", label: "Trend Day Scalp — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a Trend Day Scalp session starts.", default: "true" },
      { key: "TG_HA_SCALP_STARTED", label: "HA Scalp — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when an HA Scalp session starts.", default: "true" },
      { key: "TG_EARLYBIRD_STARTED", label: "EarlyBird — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when an EarlyBird session starts.", default: "true" },
      { key: "TG_SIMPLE930_STARTED", label: "SIMPLE_9:30 — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a SIMPLE_9:30 session starts.", default: "true" },
      { key: "TG_RSI_PIVOT_ST_STARTED", label: "RSI Pivot ST — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when an RSI Pivot ST session starts.", default: "true" },
      { key: "TG_BN_PIVOT_RSI_ST_STARTED", label: "BN Pivot RSI ST — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a BN Pivot RSI ST session starts.", default: "true" },

      { key: "TG_EMA_RSI_ST_ENTRY", label: "EMA_RSI_ST — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every EMA_RSI_ST entry.", default: "true", subheader: "Trade Entry" },
      { key: "TG_BB_RSI_ENTRY", label: "BB_RSI — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every BB_RSI entry.", default: "true" },
      { key: "TG_PA_ENTRY",    label: "Price Action — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Price Action entry.", default: "true" },
      { key: "TG_ORB_ENTRY",      label: "ORB — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every ORB entry.", default: "true" },
      { key: "TG_EMA9VWAP_ENTRY", label: "EMA9+VWAP — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every EMA9+VWAP entry.", default: "true" },
      { key: "TG_TREND_PB_ENTRY", label: "Trend Pullback — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Trend Pullback entry.", default: "true" },
      { key: "TG_TDS_ENTRY", label: "Trend Day Scalp — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Trend Day Scalp entry.", default: "true" },
      { key: "TG_HA_SCALP_ENTRY", label: "HA Scalp — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on HA Scalp entries.", default: "true" },
      { key: "TG_EARLYBIRD_ENTRY", label: "EarlyBird — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on EarlyBird entries.", default: "true" },
      { key: "TG_SIMPLE930_ENTRY", label: "SIMPLE_9:30 — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every SIMPLE_9:30 entry.", default: "true" },
      { key: "TG_RSI_PIVOT_ST_ENTRY", label: "RSI Pivot ST — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every RSI Pivot ST entry.", default: "true" },
      { key: "TG_BN_PIVOT_RSI_ST_ENTRY", label: "BN Pivot RSI ST — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every BN Pivot RSI ST entry.", default: "true" },

      { key: "TG_EMA_RSI_ST_EXIT", label: "EMA_RSI_ST — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every EMA_RSI_ST exit.", default: "true", subheader: "Trade Exit" },
      { key: "TG_BB_RSI_EXIT", label: "BB_RSI — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every BB_RSI exit.", default: "true" },
      { key: "TG_PA_EXIT",    label: "Price Action — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Price Action exit.", default: "true" },
      { key: "TG_ORB_EXIT",      label: "ORB — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every ORB exit.", default: "true" },
      { key: "TG_EMA9VWAP_EXIT", label: "EMA9+VWAP — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every EMA9+VWAP exit.", default: "true" },
      { key: "TG_TREND_PB_EXIT", label: "Trend Pullback — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Trend Pullback exit.", default: "true" },
      { key: "TG_TDS_EXIT", label: "Trend Day Scalp — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Trend Day Scalp exit.", default: "true" },
      { key: "TG_HA_SCALP_EXIT", label: "HA Scalp — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on HA Scalp exits.", default: "true" },
      { key: "TG_EARLYBIRD_EXIT", label: "EarlyBird — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on EarlyBird exits.", default: "true" },
      { key: "TG_SIMPLE930_EXIT", label: "SIMPLE_9:30 — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every SIMPLE_9:30 exit.", default: "true" },
      { key: "TG_RSI_PIVOT_ST_EXIT", label: "RSI Pivot ST — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every RSI Pivot ST exit.", default: "true" },
      { key: "TG_BN_PIVOT_RSI_ST_EXIT", label: "BN Pivot RSI ST — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every BN Pivot RSI ST exit.", default: "true" },

      { key: "TG_EMA_RSI_ST_SIGNALS", label: "EMA_RSI_ST — Signal/Skip Alerts", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert why a trade was or wasn't taken.", default: "true", subheader: "Signal / Skip" },
      { key: "TG_BB_RSI_SIGNALS", label: "BB_RSI — Signal/Skip Alerts", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert why a trade was or wasn't taken.", default: "false" },
      { key: "TG_PA_SIGNALS",    label: "Price Action — Signal/Skip Alerts", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert why a trade was or wasn't taken.", default: "false" },
      { key: "TG_EMA9VWAP_SIGNALS", label: "EMA9+VWAP — Signal/Skip Alerts", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert why a trade was or wasn't taken.", default: "false" },

      { key: "TG_EMA_RSI_ST_DAYREPORT", label: "EMA_RSI_ST — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send an EMA_RSI_ST day summary on stop.", default: "true", subheader: "Day Reports" },
      { key: "TG_BB_RSI_DAYREPORT", label: "BB_RSI — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send a BB_RSI day summary on stop.", default: "true" },
      { key: "TG_PA_DAYREPORT",    label: "Price Action — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send a Price Action day summary on stop.", default: "true" },
      { key: "TG_ORB_DAYREPORT",      label: "ORB — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send an ORB day summary on stop.", default: "true" },
      { key: "TG_EMA9VWAP_DAYREPORT", label: "EMA9+VWAP — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send an EMA9+VWAP day summary on stop.", default: "true" },
      { key: "TG_TREND_PB_DAYREPORT", label: "Trend Pullback — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send a Trend Pullback day summary on stop.", default: "true" },
      { key: "TG_TDS_DAYREPORT", label: "Trend Day Scalp — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send a Trend Day Scalp day summary on stop.", default: "true" },
      { key: "TG_HA_SCALP_DAYREPORT", label: "HA Scalp — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send the HA Scalp day report when the session stops.", default: "true" },
      { key: "TG_EARLYBIRD_DAYREPORT", label: "EarlyBird — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send the EarlyBird day report when the session stops.", default: "true" },
      { key: "TG_SIMPLE930_DAYREPORT", label: "SIMPLE_9:30 — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send a SIMPLE_9:30 day summary on stop.", default: "true" },
      { key: "TG_RSI_PIVOT_ST_DAYREPORT", label: "RSI Pivot ST — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send an RSI Pivot ST day summary on stop.", default: "true" },
      { key: "TG_BN_PIVOT_RSI_ST_DAYREPORT", label: "BN Pivot RSI ST — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send a BN Pivot RSI ST day summary on stop.", default: "true" },

      { key: "TG_DAYREPORT_CONSOLIDATED", label: "Consolidated Day Report (Market Close)", type: "toggle", effect: EFFECT.INSTANT, desc: "Send one combined end-of-day summary at 15:30 IST.", default: "true" },
      { key: "TG_EOD_CHARTS", label: "EOD Chart Images (Market Close)", type: "toggle", effect: EFFECT.INSTANT, desc: "At 15:34 IST send one chart image per strategy that took an entry today, with its entry/exit markers. Strategies that did not trade send nothing.", default: "true" },
    ],
  },
  {
    section: "CHARGES & STT — Trading Costs",
    icon: "💰",
    nav: "Charges & STT",
    group: "Trading",
    fields: [
      { key: "STT_OPT_SELL_PCT",       label: "Options STT (%)",      type: "number", min: 0, max: 1,  step: 0.01,  effect: EFFECT.INSTANT, desc: "STT on option sells (% of premium).", default: "0.15" },
      { key: "STT_FUT_SELL_PCT",       label: "Futures STT (%)",      type: "number", min: 0, max: 1,  step: 0.01,  effect: EFFECT.INSTANT, desc: "STT on futures sells (% of turnover).", default: "0.05" },
      { key: "EXCHANGE_TXN_OPT_PCT",   label: "Exchange Txn Opt (%)",  type: "number", min: 0, max: 0.5,  step: 0.00001, effect: EFFECT.INSTANT, desc: "Exchange fee on options (% of premium).", default: "0.03553" },
      { key: "EXCHANGE_TXN_FUT_PCT",   label: "Exchange Txn Fut (%)",  type: "number", min: 0, max: 0.1,  step: 0.00001, effect: EFFECT.INSTANT, desc: "Exchange fee on futures (% of turnover).", default: "0.00183" },
      { key: "SEBI_CHARGES_PER_CRORE", label: "SEBI Charges (₹/Cr)",  type: "number", min: 0, max: 100, step: 1,     effect: EFFECT.INSTANT, desc: "SEBI fee in ₹ per crore traded.", default: "10" },
      { key: "GST_PCT",               label: "GST (%)",               type: "number", min: 0, max: 30,  step: 1,     effect: EFFECT.INSTANT, desc: "GST on brokerage and fees (%).", default: "18" },
      { key: "STAMP_DUTY_PCT",        label: "Stamp Duty (%)",        type: "number", min: 0, max: 0.1, step: 0.001, effect: EFFECT.INSTANT, desc: "Stamp duty on buys (%).", default: "0.003" },
      { key: "BROKER_FLAT_PER_ORDER",  label: "Broker Fee (₹/order)", type: "number", min: 0, max: 100, step: 5,     effect: EFFECT.INSTANT, desc: "Flat brokerage per order (₹).", default: "20" },
    ],
  },
  {
    section: "SETTINGS ADVISOR — Weekly trade-record review",
    icon: "🧭",
    nav: "Settings Advisor",
    group: "System",
    fields: [
      { key: "ADVISOR_LOOKBACK_DAYS", label: "Lookback (days)",  type: "number", min: 7, max: 3650, step: 1, effect: EFFECT.INSTANT, desc: "How far back the weekly review reads trades.", default: "90" },
      { key: "ADVISOR_MIN_TRADES",    label: "Min trades to advise", type: "number", min: 5, max: 500, step: 1, effect: EFFECT.INSTANT, desc: "A strategy below this many trades gets no suggestions (too small to trust).", default: "20" },
      { key: "ADVISOR_TELEGRAM",      label: "Weekly Telegram summary", type: "toggle", effect: EFFECT.INSTANT, desc: "Telegram the top findings every Sunday 08:00 IST (needs Telegram master ON).", default: "false" },
    ],
  },
  {
    section: "SWING SCANNER — stock screen + manual positional orders",
    icon: "📈",
    nav: "Swing Scanner",
    group: "System",
    fields: [
      { key: "SWING_SCANNER_MAX_ORDER_VALUE", label: "Max order value (₹)", type: "number", min: 1000, max: 100000000, step: 1000, effect: EFFECT.INSTANT,
        desc: "Fat-finger ceiling. An order worth more than this is refused before it reaches Zerodha. It is a typo guard, not a permission gate — raise it when you mean to trade bigger.", default: "1000000", subheader: "Order safety" },
      { key: "SWING_SCANNER_SCALE_THRESHOLDS", label: "Rescale point thresholds to each stock", type: "toggle", effect: EFFECT.INSTANT,
        desc: "Strategy settings measured in POINTS (BB min band width, PA stop/tolerance distances) are calibrated for NIFTY at ~24000. With this ON they are re-expressed as the same PERCENTAGE of each stock's own price, so a 150-rupee share and a 40000-rupee share are judged alike. Turn it OFF to feed the raw point values through unchanged.", default: "true", subheader: "Signal translation" },
      { key: "SWING_SCANNER_NIFTY_REF", label: "NIFTY reference level", type: "number", min: 1000, max: 200000, step: 100, effect: EFFECT.INSTANT,
        desc: "The NIFTY level your point-based settings were tuned at. Used only as the denominator when rescaling them onto a stock's price.", default: "24000" },
      { key: "SWING_SCANNER_CONCURRENCY", label: "Parallel history requests", type: "number", min: 1, max: 16, step: 1, effect: EFFECT.INSTANT,
        desc: "How many Fyers history calls run at once during a scan. The two caps below hold the overall rate whatever this is set to, so raising it shortens a small scan without endangering a large one.", default: "4", subheader: "Scan performance" },
      { key: "SWING_SCANNER_RPS", label: "History calls per second (cap)", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.INSTANT,
        desc: "Ceiling on how fast the scan may call the Fyers history API, whatever the concurrency above. Fyers allows about 10 a second and answers the rest with a request-limit error; a throttled symbol is retried a few times and then dropped from the scan, so 8 leaves headroom for the live engines sharing the same quota.", default: "8" },
      { key: "SWING_SCANNER_RPM", label: "History calls per minute (cap)", type: "number", min: 1, max: 2000, step: 10, effect: EFFECT.INSTANT,
        desc: "The second Fyers ceiling, and the one a 200-plus stock universe actually hits. Scanning the whole F&O list is one call per symbol, so this is what paces a wide scan; 180 sits under the broker's 200 a minute.", default: "180" },
      { key: "SWING_SCANNER_CACHE_DAYS", label: "Candle cache retention (days)", type: "number", min: 1, max: 60, step: 1, effect: EFFECT.INSTANT,
        desc: "Cached scan candles older than this are deleted at the start of each scan. The cache is what makes a repeat scan near-instant.", default: "7" },
      { key: "SWING_SCANNER_BROKERAGE_PCT", label: "Brokerage %", type: "number", min: 0, max: 5, step: 0.001, effect: EFFECT.INSTANT,
        desc: "Delivery brokerage as a percent of turnover. Zerodha charges zero on CNC equity, hence the default.", default: "0", subheader: "Charges shown in the order popup" },
      { key: "SWING_SCANNER_STT_PCT", label: "STT % (buy)", type: "number", min: 0, max: 5, step: 0.001, effect: EFFECT.INSTANT,
        desc: "Securities Transaction Tax on a delivery buy, as a percent of turnover.", default: "0.1" },
      { key: "SWING_SCANNER_TXN_PCT", label: "Exchange txn %", type: "number", min: 0, max: 5, step: 0.00001, effect: EFFECT.INSTANT,
        desc: "NSE transaction charge as a percent of turnover.", default: "0.00297" },
      { key: "SWING_SCANNER_SEBI_PCT", label: "SEBI turnover %", type: "number", min: 0, max: 5, step: 0.00001, effect: EFFECT.INSTANT,
        desc: "SEBI turnover fee as a percent of turnover (10 rupees per crore).", default: "0.0001" },
      { key: "SWING_SCANNER_STAMP_PCT", label: "Stamp duty % (buy)", type: "number", min: 0, max: 5, step: 0.001, effect: EFFECT.INSTANT,
        desc: "Stamp duty on a delivery buy, as a percent of turnover.", default: "0.015" },
    ],
  },
  {
    section: "UI PREFERENCES",
    icon: "🎨",
    nav: "UI Preferences",
    group: "System",
    fields: [
      { key: "UI_THEME", label: "Application Theme", type: "select", options: ["dark", "light", "auto"], effect: EFFECT.INSTANT, desc: "Switch between dark and light mode. auto = light during the day (06:00–18:00 IST) and dark at night; each page picks its theme when it loads.", default: "dark" },
      { key: "UI_DISABLE_RIGHT_CLICK", label: "Disable right-click menu", type: "toggle", effect: EFFECT.INSTANT, desc: "Block the browser right-click menu on every page. Text boxes keep their menu so copy and paste still work.", default: "false" },
    ],
  },
  {
    section: "MENU VISIBILITY — Show / hide sidebar items",
    icon: "👁",
    nav: "Menu Visibility",
    group: "System",
    fields: [
      { key: "UI_SHOW_DASHBOARD",      label: "Show Dashboard",            type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Dashboard menu.", default: "false", subheader: "Top-level menu items" },
      { key: "UI_SHOW_ALL_BACKTEST",   label: "Show All Backtest",         type: "toggle", effect: EFFECT.INSTANT, desc: "Show the all-strategy Backtest menu.", default: "true" },
      { key: "UI_SHOW_REALTIME",       label: "Real-Time on Dashboard",    type: "toggle", effect: EFFECT.INSTANT, desc: "Auto-show the Real-Time monitor while a session runs.", default: "true" },
      { key: "UI_DASHBOARD_ANALYTICS_PANEL", label: "Dashboard analytics panel", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the analytics panel on the Dashboard.", default: "true" },
      { key: "UI_SHOW_REPLAY",         label: "Show Replay",               type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Replay menu.", default: "true" },
      { key: "UI_SHOW_PAPER_HISTORY",  label: "Show Paper Traded History", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Paper Traded History menu.", default: "true" },
      { key: "UI_SHOW_LIVE_HISTORY",   label: "Show Live Traded History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Live Traded History menu.", default: "true" },
      { key: "UI_SHOW_EDGE_ANALYTICS", label: "Show Consolidation Report", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Consolidation Report menu.", default: "true" },
      { key: "UI_SHOW_ADVISOR",        label: "Show Settings Advisor",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Settings Advisor menu.", default: "true" },
      { key: "UI_SHOW_OI_MONITOR",     label: "Show OI Monitor",           type: "toggle", effect: EFFECT.INSTANT, desc: "Show the OI Monitor menu — read-only per-strike Open Interest ladder, walls and PCR. Research page: places no orders.", default: "false" },
      { key: "UI_SHOW_SWING_SCANNER",  label: "Show Swing Scanner",        type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Swing Scanner menu — screens stocks with your active strategies and can place REAL Zerodha delivery orders. Off by default because it is the one page with no dry-run gate.", default: "false" },
      { key: "UI_SHOW_BANKNIFTY",      label: "Show BANK NIFTY group",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show the BANK NIFTY parent group in the sidebar. The NIFTY BANK strategies nest under it, the way the NIFTY strategies nest under NIFTY.", default: "true" },
      { key: "UI_SHOW_EDGE_ANALYTICS_BUTTON", label: "Show Edge Analytics button", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Edge Analytics button on the Consolidation Report page.", default: "true" },
      { key: "EMA_RSI_ST_MODE_ENABLED",     label: "EMA_RSI_ST Mode",                type: "toggle", effect: EFFECT.INSTANT, desc: "Show the EMA_RSI_ST menu and settings.", default: "true", subheader: "Strategy master toggles" },
      { key: "BB_RSI_MODE_ENABLED",     label: "BB_RSI Mode",                type: "toggle", effect: EFFECT.INSTANT, desc: "Show the BB_RSI menu and settings.", default: "true" },
      { key: "PA_MODE_ENABLED",        label: "Price Action Mode",         type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Price Action menu and settings.", default: "true" },
      { key: "ORB_MODE_ENABLED",       label: "ORB Mode (Opening Range Breakout)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the ORB menu and settings.", default: "true" },
      { key: "EMA9VWAP_MODE_ENABLED",  label: "EMA9+VWAP Mode",            type: "toggle", effect: EFFECT.INSTANT, desc: "Show the EMA9+VWAP menu and settings.", default: "true" },
      { key: "TREND_PB_MODE_ENABLED",  label: "Trend Pullback Mode",       type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Trend Pullback menu and settings.", default: "true" },
      { key: "TDS_MODE_ENABLED",       label: "Trend Day Scalp Mode",      type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Trend Day Scalp menu and settings.", default: "true" },
      { key: "HA_SCALP_MODE_ENABLED",  label: "HA Scalp Mode",             type: "toggle", effect: EFFECT.INSTANT, desc: "Show the HA Scalp menu and settings.", default: "true" },
      { key: "EARLYBIRD_MODE_ENABLED", label: "EarlyBird Mode",            type: "toggle", effect: EFFECT.INSTANT, desc: "Show the EarlyBird menu and settings.", default: "true" },
      { key: "SIMPLE930_MODE_ENABLED", label: "SIMPLE_9:30 Mode",         type: "toggle", effect: EFFECT.INSTANT, desc: "Show the SIMPLE_9:30 menu and settings.", default: "true" },
      { key: "RSI_PIVOT_ST_MODE_ENABLED", label: "RSI Pivot ST Mode",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show the RSI Pivot ST menu and settings.", default: "true" },
      { key: "BN_PIVOT_RSI_ST_MODE_ENABLED", label: "BN Pivot RSI ST Mode (NIFTY BANK)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the BN Pivot RSI ST menu and settings. This is the NIFTY BANK replica of RSI Pivot ST.", default: "true" },
      { key: "UI_SHOW_SIMULATE",       label: "Show Simulate Menu",        type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Simulate sub-menu.", default: "false", subheader: "Shared sub-menus (all strategies)" },
      { key: "UI_SHOW_COMPARE",        label: "Show Compare Menu",         type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Compare sub-menu.", default: "false" },
      { key: "UI_SHOW_TRACKER",        label: "Show Tracker Menu (EMA_RSI_ST only)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Tracker sub-menu (EMA_RSI_ST).", default: "false" },

      // ── EMA_RSI_ST submenu ──
      { key: "UI_SHOW_EMA_RSI_ST_BACKTEST", label: "EMA_RSI_ST → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under EMA_RSI_ST.", default: "true", subheader: "EMA_RSI_ST sub-menus" },
      { key: "UI_SHOW_EMA_RSI_ST_PAPER",    label: "EMA_RSI_ST → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under EMA_RSI_ST.",    default: "true" },
      { key: "UI_SHOW_EMA_RSI_ST_LIVE",     label: "EMA_RSI_ST → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live under EMA_RSI_ST.",     default: "true" },
      { key: "UI_SHOW_EMA_RSI_ST_LIVE_HARNESS", label: "EMA_RSI_ST → Live (Harness)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live (Harness) under EMA_RSI_ST.", default: "false" },

      // ── BB_RSI submenu ──
      { key: "UI_SHOW_BB_RSI_BACKTEST", label: "BB_RSI → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under BB_RSI.", default: "true", subheader: "BB_RSI sub-menus" },
      { key: "UI_SHOW_BB_RSI_PAPER",    label: "BB_RSI → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under BB_RSI.",    default: "true" },
      { key: "UI_SHOW_BB_RSI_LIVE",     label: "BB_RSI → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live under BB_RSI.",     default: "true" },
      { key: "UI_SHOW_BB_RSI_LIVE_HARNESS", label: "BB_RSI → Live (Harness)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live (Harness) under BB_RSI.", default: "false" },

      // ── Price Action submenu ──
      { key: "UI_SHOW_PA_BACKTEST",         label: "PA → Backtest",        type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under Price Action.",     default: "true", subheader: "Price Action sub-menus" },
      { key: "UI_SHOW_PA_PATTERN_BACKTEST", label: "PA → Pattern Test",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Pattern Test under Price Action.", default: "true" },
      { key: "UI_SHOW_PA_PAPER",            label: "PA → Paper",           type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under Price Action.",        default: "true" },
      { key: "UI_SHOW_PA_LIVE",             label: "PA → Live (legacy)",   type: "toggle", effect: EFFECT.INSTANT, desc: "Show the legacy Live under Price Action.", default: "true" },
      { key: "UI_SHOW_PA_LIVE_HARNESS",     label: "PA → Live (Harness)",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live (Harness) under Price Action.", default: "false" },

      // ── ORB submenu ──
      { key: "UI_SHOW_ORB_BACKTEST", label: "ORB → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under ORB.", default: "true", subheader: "ORB sub-menus" },
      { key: "UI_SHOW_ORB_PAPER",    label: "ORB → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under ORB.", default: "true" },
      { key: "UI_SHOW_ORB_LIVE",     label: "ORB → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live under ORB.", default: "true" },
      { key: "UI_SHOW_ORB_LIVE_HARNESS", label: "ORB → Live (Harness)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live (Harness) under ORB.", default: "false" },
      { key: "UI_SHOW_ORB_HISTORY",  label: "ORB → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show History under ORB.", default: "true" },

      // ── EMA9+VWAP submenu ──
      { key: "UI_SHOW_EMA9VWAP_BACKTEST", label: "EMA9+VWAP → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under EMA9+VWAP.", default: "true", subheader: "EMA9+VWAP sub-menus" },
      { key: "UI_SHOW_EMA9VWAP_PAPER",    label: "EMA9+VWAP → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under EMA9+VWAP.", default: "true" },
      { key: "UI_SHOW_EMA9VWAP_LIVE",     label: "EMA9+VWAP → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live under EMA9+VWAP.", default: "true" },
      { key: "UI_SHOW_EMA9VWAP_HISTORY",  label: "EMA9+VWAP → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show History under EMA9+VWAP.", default: "true" },

      // ── Trend Pullback submenu (Paper + History ship in Phase A; Backtest/Live default off until built) ──
      { key: "UI_SHOW_TREND_PB_BACKTEST", label: "Trend Pullback → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under Trend Pullback.", default: "true", subheader: "Trend Pullback sub-menus" },
      { key: "UI_SHOW_TREND_PB_PAPER",    label: "Trend Pullback → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under Trend Pullback.", default: "true" },
      { key: "UI_SHOW_TREND_PB_LIVE",     label: "Trend Pullback → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live under Trend Pullback.", default: "true" },
      { key: "UI_SHOW_TREND_PB_HISTORY",  label: "Trend Pullback → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show History under Trend Pullback.", default: "true" },

      // ── Trend Day Scalp submenu ──
      { key: "UI_SHOW_TDS_BACKTEST", label: "Trend Day Scalp → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under Trend Day Scalp.", default: "true", subheader: "Trend Day Scalp sub-menus" },
      { key: "UI_SHOW_TDS_PAPER",    label: "Trend Day Scalp → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under Trend Day Scalp.", default: "true" },
      { key: "UI_SHOW_TDS_LIVE",     label: "Trend Day Scalp → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live under Trend Day Scalp.", default: "true" },
      { key: "UI_SHOW_TDS_HISTORY",  label: "Trend Day Scalp → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show History under Trend Day Scalp.", default: "true" },

      // ── HA Scalp submenu ──
      { key: "UI_SHOW_HA_SCALP_BACKTEST", label: "HA Scalp → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under HA Scalp.", default: "true", subheader: "HA Scalp sub-menus" },
      { key: "UI_SHOW_HA_SCALP_PAPER",    label: "HA Scalp → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under HA Scalp.", default: "true" },
      { key: "UI_SHOW_HA_SCALP_LIVE",     label: "HA Scalp → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live under HA Scalp.", default: "true" },
      { key: "UI_SHOW_HA_SCALP_HISTORY",  label: "HA Scalp → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show History under HA Scalp.", default: "true" },
      { key: "UI_SHOW_EARLYBIRD_BACKTEST", label: "EarlyBird → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under EarlyBird.", default: "true", subheader: "EarlyBird sub-menus" },
      { key: "UI_SHOW_EARLYBIRD_PAPER",    label: "EarlyBird → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under EarlyBird.", default: "true" },
      { key: "UI_SHOW_EARLYBIRD_LIVE",     label: "EarlyBird → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live under EarlyBird.", default: "true" },
      { key: "UI_SHOW_EARLYBIRD_HISTORY",  label: "EarlyBird → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show History under EarlyBird.", default: "true" },

      // ── SIMPLE_9:30 submenu ──
      { key: "UI_SHOW_SIMPLE930_BACKTEST", label: "SIMPLE_9:30 → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under SIMPLE_9:30.", default: "true", subheader: "SIMPLE_9:30 sub-menus" },
      { key: "UI_SHOW_SIMPLE930_PAPER",    label: "SIMPLE_9:30 → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under SIMPLE_9:30.", default: "true" },
      { key: "UI_SHOW_SIMPLE930_LIVE",     label: "SIMPLE_9:30 → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live under SIMPLE_9:30.", default: "true" },
      { key: "UI_SHOW_SIMPLE930_HISTORY",  label: "SIMPLE_9:30 → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show History under SIMPLE_9:30.", default: "true" },


      // ── RSI Pivot ST submenu ──
      { key: "UI_SHOW_RSI_PIVOT_ST_BACKTEST", label: "RSI Pivot ST → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under RSI Pivot ST.", default: "true", subheader: "RSI Pivot ST sub-menus" },
      { key: "UI_SHOW_RSI_PIVOT_ST_PAPER",    label: "RSI Pivot ST → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under RSI Pivot ST.", default: "true" },
      { key: "UI_SHOW_RSI_PIVOT_ST_LIVE",     label: "RSI Pivot ST → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live under RSI Pivot ST.", default: "true" },
      { key: "UI_SHOW_RSI_PIVOT_ST_HISTORY",  label: "RSI Pivot ST → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show History under RSI Pivot ST.", default: "true" },

      // ── BN Pivot RSI ST submenu (NIFTY BANK) ──
      { key: "UI_SHOW_BN_PIVOT_RSI_ST_BACKTEST", label: "BN Pivot RSI ST → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Backtest under BN Pivot RSI ST.", default: "true", subheader: "BN Pivot RSI ST sub-menus" },
      { key: "UI_SHOW_BN_PIVOT_RSI_ST_PAPER",    label: "BN Pivot RSI ST → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show Paper under BN Pivot RSI ST.", default: "true" },
      { key: "UI_SHOW_BN_PIVOT_RSI_ST_LIVE",     label: "BN Pivot RSI ST → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show Live under BN Pivot RSI ST.", default: "true" },
      { key: "UI_SHOW_BN_PIVOT_RSI_ST_HISTORY",  label: "BN Pivot RSI ST → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show History under BN Pivot RSI ST.", default: "true" },

      // ── System submenu (Settings is always shown) ──
      { key: "UI_SHOW_LOGS",       label: "Logs → Server Logs tab", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Server Logs tab.", default: "true", subheader: "System sub-menus" },
      { key: "UI_SHOW_TRADE_LOGS", label: "System → Logs", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Logs under the System group.", default: "true" },
      { key: "UI_SHOW_CACHE_FILES", label: "Logs → Cache Files tab", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the Cache Files tab.", default: "true" },
      { key: "UI_SHOW_TOKEN_SYNC", label: "System → Token Sync", type: "toggle", effect: EFFECT.INSTANT, desc: "Show Token Sync under the System group — copy the day's broker token from LIVE and paste it on a local machine so backtests/analytics can run there.", default: "true" },
    ],
  },
  {
    section: "SECURITY & SAFETY — Auth, Rate Limits, Broker Resilience",
    icon: "🔒",
    nav: "Security & Safety",
    group: "System",
    fields: [
      // ── Credentials ─────────────────────────────────────────────────────────
      { key: "API_SECRET",   label: "App Secret",     type: "password", effect: EFFECT.INSTANT, desc: "Password for action routes and settings (blank = off).", subheader: "Credentials" },
      { key: "LOGIN_SECRET", label: "Login Password", type: "password", effect: EFFECT.INSTANT, desc: "Page login password (blank = open access)." },

      // ── Login / session ─────────────────────────────────────────────────────
      { key: "LOGIN_SESSION_MIN",     label: "Login Idle Timeout (min)",      type: "number", min: 5,  max: 240, step: 5,  effect: EFFECT.INSTANT, desc: "Idle minutes before login expires.",                       default: "15", subheader: "Login & Session" },
      { key: "LOGIN_RATE_MAX",        label: "Login: Max Failed Attempts",    type: "number", min: 1,  max: 50,  step: 1,  effect: EFFECT.INSTANT, desc: "Wrong-password attempts allowed before lockout.", default: "5" },
      { key: "LOGIN_RATE_WINDOW_MIN", label: "Login: Lockout Window (min)",   type: "number", min: 1,  max: 1440, step: 1, effect: EFFECT.INSTANT, desc: "Lockout window length, in minutes.",                                          default: "15" },
      { key: "LOGIN_OTP_MOBILE",      label: "Login: OTP Mobile Number",      type: "text",   effect: EFFECT.INSTANT, desc: "Typing this number on a locked-out login page sends an OTP to Telegram that clears the lockout (blank = off).", default: "" },

      // ── Write rate limit (POST/PUT/DELETE/PATCH per IP) ─────────────────────
      { key: "WRITE_RATE_PER_MIN", label: "Write Rate (req/min/IP)", type: "number", min: 0,   max: 6000, step: 10, effect: EFFECT.INSTANT, desc: "Max state-changing requests per minute per IP (0 = off).", default: "120", subheader: "Rate Limits" },
      { key: "WRITE_RATE_BURST",   label: "Write Rate Burst",        type: "number", min: 1,   max: 500,  step: 1,  effect: EFFECT.INSTANT, desc: "Short-burst request allowance.",  default: "30"  },

      // ── Broker resilience (circuit breaker + retry) ─────────────────────────
      { key: "BROKER_CB_FAIL_THRESHOLD",     label: "Broker Circuit: Fail Threshold",      type: "number", min: 2, max: 30,  step: 1,  effect: EFFECT.INSTANT, desc: "Failures before the broker circuit opens.",                                       default: "5", subheader: "Broker Resilience" },
      { key: "BROKER_CB_OPEN_SEC",           label: "Broker Circuit: Open Duration (sec)", type: "number", min: 5, max: 600, step: 5,  effect: EFFECT.INSTANT, desc: "Seconds the broker circuit stays open.",                    default: "30" },
      { key: "BROKER_RETRY_WRITE_ATTEMPTS",  label: "Order Retry Attempts (writes)",       type: "number", min: 1, max: 4,   step: 1,  effect: EFFECT.INSTANT, desc: "Attempts for order writes (1 = no retry).", default: "2" },
      { key: "BROKER_RETRY_READ_ATTEMPTS",   label: "Query Retry Attempts (reads)",        type: "number", min: 1, max: 6,   step: 1,  effect: EFFECT.INSTANT, desc: "Attempts for data reads.",                                  default: "3"  },
      { key: "BROKER_RETRY_BASE_MS",         label: "Retry Base Delay (ms)",               type: "number", min: 50, max: 2000, step: 50, effect: EFFECT.INSTANT, desc: "Base delay between retries (ms).",                                                 default: "150" },
    ],
  },
];

// URL-safe id for a section — it is the `#hash` of the Settings page, so it has
// to survive a round-trip through location.hash and a CSS attribute selector.
// Built from the short `nav` label when there is one; section titles carry
// brackets, slashes and em-dashes that would come back percent-encoded.
function sectionSlug(s) {
  return String(s.nav || s.section)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Per-mode settings snapshot for the daily trade-log JSONL ────────────────
// Each mode's daily JSONL file is seeded with a settings snapshot before the
// first trade of the day, and a fresh snapshot is appended whenever a save
// changes any key that affects that mode. Modes only see sections that drive
// trade behaviour (strategy + instrument/backtest + charges) — credentials,
// telegram, UI prefs are skipped.
const MODE_SECTION_TITLES = {
  ema_rsi_st:    "EMA_RSI_ST STRATEGY (EMA 20/50 + RSI + SuperTrend) — Zerodha",
  bb_rsi:    "BB_RSI STRATEGY (BB+SuperTrend+RSI) — Fyers",
  pa:       "PRICE ACTION STRATEGY (5-min) — Fyers",
  orb:      "ORB STRATEGY (Opening Range Breakout) — Fyers",
  ema9vwap: "EMA9 + VWAP STRATEGY — Zerodha",
  trend_pb: "TREND PULLBACK STRATEGY — Fyers",
  trend_day_scalp: "TREND DAY SCALP STRATEGY — Fyers",
  ha_scalp: "HA SCALP STRATEGY (Heikin Ashi 15m) — Zerodha",
  simple930: "SIMPLE_9:30 STRATEGY (option-premium breakout) — Zerodha",
  rsi_pivot_st: "RSI_PIVOT_ST STRATEGY (RSI + Standard Pivot R1/S1 + SuperTrend) — Zerodha",
  bn_pivot_rsi_st: "BN_PIVOT_RSI_ST STRATEGY (NIFTY BANK — RSI + Standard Pivot R1/S1 + SuperTrend) — Zerodha",
  early_bird: "EARLYBIRD STRATEGY (first 15-min breakout, CASH EQUITY) — Fyers",
};
const SNAPSHOT_COMMON_SECTION_TITLES = new Set([
  "Instrument & Backtest",
  "CHARGES & STT — Trading Costs",
  "OPEN-INTEREST FILTER (OI + Price Buildup)",
]);

const _MODE_KEYS = { ema_rsi_st: new Set(), bb_rsi: new Set(), pa: new Set(), orb: new Set(), ema9vwap: new Set(), trend_pb: new Set(), trend_day_scalp: new Set(), ha_scalp: new Set(), simple930: new Set(), rsi_pivot_st: new Set(), bn_pivot_rsi_st: new Set(), early_bird: new Set() };
const _KEY_TO_MODES = new Map();
(function buildModeKeyIndex() {
  const commonKeys = [];
  for (const section of SETTINGS_SCHEMA) {
    if (SNAPSHOT_COMMON_SECTION_TITLES.has(section.section)) {
      for (const f of section.fields) commonKeys.push(f.key);
    }
  }
  for (const [mode, title] of Object.entries(MODE_SECTION_TITLES)) {
    const section = SETTINGS_SCHEMA.find(s => s.section === title);
    if (section) for (const f of section.fields) _MODE_KEYS[mode].add(f.key);
    for (const k of commonKeys) _MODE_KEYS[mode].add(k);
  }
  for (const mode of Object.keys(_MODE_KEYS)) {
    for (const k of _MODE_KEYS[mode]) {
      if (!_KEY_TO_MODES.has(k)) _KEY_TO_MODES.set(k, new Set());
      _KEY_TO_MODES.get(k).add(mode);
    }
  }
})();

function buildModeSnapshot(mode) {
  const keys = _MODE_KEYS[mode];
  if (!keys) return null;
  const settings = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== "") settings[k] = v;
  }
  return { settings };
}

tradeLogger.setSettingsProvider(buildModeSnapshot);

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
  "EMA_RSI_ST_LIVE_ENABLED", "TRADE_EXPIRY_DAY_ONLY",
  "VIX_FILTER_ENABLED", "VIX_MAX_ENTRY", "VIX_STRONG_ONLY", "VIX_FAIL_MODE",
  "BB_RSI_VIX_MAX_ENTRY", "BB_RSI_VIX_STRONG_ONLY", "PA_VIX_ENABLED", "PA_VIX_MAX_ENTRY",
  "OI_FILTER_ENABLED", "EMA_RSI_ST_OI_ENABLED", "BB_RSI_OI_ENABLED", "PA_OI_ENABLED", "ORB_OI_ENABLED",
  "EMA9VWAP_OI_ENABLED", "EMA9VWAP_VIX_ENABLED", "EMA9VWAP_VIX_MAX_ENTRY",
  "EMA9VWAP_MAX_CONSEC_LOSSES", "EMA9VWAP_NEG_CANDLE_LIMIT", "EMA9VWAP_CANDLE_TRAIL_ENABLED",
  "EMA9VWAP_CANDLE_TRAIL_BARS", "EMA9VWAP_SL_MODE", "EMA9VWAP_STRENGTH_FILTER",
  "EMA9VWAP_STRONG_MIN_SIGMA", "EMA9VWAP_BAND_MULT", "EMA9VWAP_EMA_PERIOD",
  "EMA9VWAP_REVERSAL_EXIT_ENABLED", "EMA9VWAP_OPT_STOP_PCT", "EMA9VWAP_STOP_LOSS_PTS",
  "OI_LOOKBACK_CANDLES", "OI_MIN_DELTA_PCT", "OI_FAIL_MODE",
  "INSTRUMENT", "NIFTY_LOT_SIZE", "NIFTY_FUTURES_MARGIN_PCT", "STRIKE_OFFSET_CE", "STRIKE_OFFSET_PE", "LOT_MULTIPLIER",
  "OPTION_EXPIRY_OVERRIDE", "OPTION_EXPIRY_TYPE",
  "NIFTY_STRIKE_STEP", "NIFTY_WEEKLY_EXPIRY_ENABLED",
  "BANKNIFTY_STRIKE_STEP", "BANKNIFTY_LOT_SIZE", "BANKNIFTY_FUTURES_MARGIN_PCT",
  "BANKNIFTY_STRIKE_OFFSET_CE", "BANKNIFTY_STRIKE_OFFSET_PE", "BANKNIFTY_SPOT_FALLBACK",
  "BANKNIFTY_WEEKLY_EXPIRY_ENABLED", "BANKNIFTY_OPTION_EXPIRY_OVERRIDE", "BANKNIFTY_OPTION_EXPIRY_TYPE",
  "BACKTEST_CAPITAL", "BACKTEST_OPTION_SIM",
  "BACKTEST_DELTA", "BACKTEST_THETA_DAY", "ZERODHA_INV_AMOUNT", "FYERS_INV_AMOUNT",
  "PAPER_CAPITAL_GATE_ENABLED", "PAPER_CAPITAL_EST_PREMIUM",
  "PA_ENABLED",
  "TELEGRAM_CHAT_ID", "TELEGRAM_BOT_TOKEN",
  "TG_ENABLED",
  "TG_EMA_RSI_ST_STARTED", "TG_BB_RSI_STARTED", "TG_PA_STARTED",
  "TG_EMA_RSI_ST_ENTRY",   "TG_BB_RSI_ENTRY",   "TG_PA_ENTRY",
  "TG_EMA_RSI_ST_EXIT",    "TG_BB_RSI_EXIT",    "TG_PA_EXIT",
  "TG_EMA_RSI_ST_SIGNALS", "TG_BB_RSI_SIGNALS", "TG_PA_SIGNALS",
  "TG_EMA_RSI_ST_DAYREPORT", "TG_BB_RSI_DAYREPORT", "TG_PA_DAYREPORT",
  "TG_DAYREPORT_CONSOLIDATED", "TG_EOD_CHARTS",
  "NIFTY_SPOT_FALLBACK", "CACHE_MAX_DAYS",
  "BB_RSI_ENABLED", "BB_RSI_MODE_ENABLED", "BB_RSI_VIX_ENABLED", "BB_RSI_EXPIRY_DAY_ONLY",
  "API_SECRET", "LOGIN_SECRET", "LOGIN_OTP_MOBILE", "UI_THEME",
  "UI_SHOW_SIMULATE", "UI_SHOW_COMPARE", "UI_SHOW_TRACKER",
  // EMA_RSI_ST thresholds — read from process.env inside getSignal() / per-tick on every candle
  "RSI_CE_MIN", "RSI_CE_MAX", "RSI_PE_MAX", "RSI_PE_MIN",
  "EMA_RSI_ST_EMA_FAST", "EMA_RSI_ST_EMA_SLOW", "EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED", "EMA_RSI_ST_EMA_FASTEST",
  "EMA_RSI_ST_CLOSE_BEYOND_EMA_ENABLED",
  "EMA_RSI_ST_CANDLE_TRAIL_ENABLED", "EMA_RSI_ST_CANDLE_TRAIL_BARS", "EMA_RSI_ST_EMA_EXIT_MODE",
  "EMA_RSI_ST_INITIAL_SL_MODE",
  "EMA_RSI_ST_SUPERTREND_PERIOD", "EMA_RSI_ST_SUPERTREND_MULT",
  "EMA_RSI_ST_STOP_LOSS_PTS", "EMA_RSI_ST_MAX_CONSEC_LOSSES", "EMA_RSI_ST_NEG_CANDLE_LIMIT",
  // Confirmation-candle gates — read live from process.env on every candle/tick
  "EMA_RSI_ST_CONFIRM_CANDLE_ENABLED", "BB_RSI_CONFIRM_CANDLE_ENABLED", "BB_RSI_CONFIRM_ON_CLOSE",
]);

// These are cached as const at module load — need session stop+start
const SESSION_RESTART_KEYS = new Set([
  "MAX_DAILY_LOSS", "MAX_DAILY_TRADES", "OPT_STOP_PCT",
  "EMA_RSI_ST_SL_PAUSE_CANDLES", "EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED", "EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES",
  "EMA_RSI_ST_EOD_EXIT_TIME", "EMA_RSI_ST_LIVE_DRY_RUN",
  "TRADE_RESOLUTION", "TRADE_START_TIME", "TRADE_STOP_TIME",
  "TRADE_ENTRY_START", "TRADE_ENTRY_END",
  "BB_RSI_ENTRY_START", "BB_RSI_ENTRY_END", "BB_RSI_RESOLUTION",
  // BB_RSI settings — need session restart
  "BB_RSI_DIRECTION",
  "BB_RSI_BB_PERIOD", "BB_RSI_BB_STDDEV",
  "BB_RSI_RSI_PERIOD", "BB_RSI_RSI_CE_THRESHOLD",
  "BB_RSI_RSI_PE_THRESHOLD", "BB_RSI_RSI_TURNING",
  "BB_RSI_MAX_ENTRY_SL_PTS",
  "BB_RSI_BAND_WIDTH_ENABLED", "BB_RSI_MIN_BAND_WIDTH_PTS",
  "BB_RSI_RSI_RANGE_ENABLED", "BB_RSI_RSI_RANGE_LOOKBACK", "BB_RSI_RSI_RANGE_MIN",
  "BB_RSI_ADX_ENABLED", "BB_RSI_ADX_MAX",
  "BB_RSI_DIVERGENCE_ENABLED", "BB_RSI_DIV_LOOKBACK", "BB_RSI_DIV_PIVOT_BARS",
  "BB_RSI_TARGET_MIDDLE_BAND",
  "BB_RSI_OPP_CANDLE_SL_ENABLED", "BB_RSI_OPP_CANDLE_SL_COUNT",
  "BB_RSI_OPP_CANDLE_TRAIL_ENABLED", "BB_RSI_OPP_CANDLE_TRAIL_COUNT", "BB_RSI_TRAIL_ARM_PTS",
  "BB_RSI_PROFIT_LOCK_TRIGGER_PTS", "BB_RSI_PROFIT_LOCK_PCT", "BB_RSI_STOP_LOSS_PTS",
  "BB_RSI_MAX_DAILY_TRADES", "BB_RSI_MAX_DAILY_LOSS",
  "BB_RSI_SL_PAUSE_CANDLES", "BB_RSI_CONSEC_SL_EXTRA_PAUSE", "BB_RSI_PER_SIDE_PAUSE",
  "BB_RSI_SLIPPAGE_PTS",
  // Live-engine guards — read inside live loops, but constants in tradeGuards are cached at require()
  "GAP_THRESHOLD_PTS", "LTP_STALE_FALLBACK_SEC", "MAX_BID_ASK_SPREAD_PTS",
  "TIME_STOP_CANDLES", "TIME_STOP_FLAT_PTS",
]);

// Schema-derived restart set: every field marked EFFECT.SESSION or EFFECT.SERVER
// in SETTINGS_SCHEMA. The schema drives the badge shown in the UI, so deriving
// from it keeps the post-save restart prompt in sync with what users see —
// previously this drifted (a SESSION-RESTART field could be missing from the
// hardcoded list, so the prompt never fired).
const SCHEMA_RESTART_KEYS = new Set();
for (const section of SETTINGS_SCHEMA) {
  for (const f of section.fields || []) {
    if (f.effect === EFFECT.SESSION || f.effect === EFFECT.SERVER) {
      SCHEMA_RESTART_KEYS.add(f.key);
    }
  }
}

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

  // Classify what needs restart — union of schema-derived (UI badges) and the
  // legacy hardcoded set (covers keys not in the schema, like custom additions).
  const needsRestart = Object.keys(updates).filter(
    k => SCHEMA_RESTART_KEYS.has(k) || SESSION_RESTART_KEYS.has(k)
  );

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
  const { updates, deletes, note } = req.body;
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

  // Keys the CALLER actually sent, captured before the section auto-fill below
  // adds defaults. The expiry fan-out keys off this (not off `cleaned`), so
  // saving an unrelated key that merely auto-fills OPTION_EXPIRY_TYPE cannot
  // re-stamp every strategy's expiry.
  const explicitKeys = new Set(Object.keys(cleaned));

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

  const result = persistChanges(cleaned, deleteKeys, note, req);
  res.json({ ...result, envPath: ENV_PATH });
});

// Apply a validated set of updates/deletes: mutate process.env + .env, write the
// settings-audit log, and append per-mode daily settings snapshots. Shared by
// POST /save and POST /audit-restore so both write identical audit trails.
// Returns the updateEnvFile result (incl. needsRestart).
function persistChanges(cleaned, deleteKeys, note, req) {
  // Snapshot prior values for audit BEFORE updateEnvFile mutates process.env.
  // Prefer .env on disk; fall back to process.env (covers schema defaults
  // not yet persisted to .env).
  const envOnDisk = parseEnvFile();
  const auditPrevEnv = {};
  const auditKeys = new Set([...Object.keys(cleaned), ...deleteKeys]);
  for (const k of auditKeys) {
    if (k in envOnDisk)         auditPrevEnv[k] = envOnDisk[k];
    else if (k in process.env)  auditPrevEnv[k] = process.env[k];
  }

  const result = updateEnvFile(cleaned, deleteKeys);
  if (result.success) {
    const summary = [];
    if (Object.keys(cleaned).length) summary.push(`updated ${Object.keys(cleaned).length}: ${Object.keys(cleaned).join(", ")}`);
    if (deleteKeys.length) summary.push(`deleted ${deleteKeys.length}: ${deleteKeys.join(", ")}`);
    console.log(`[settings] ${summary.join(" | ")}`,
      result.fileSaved ? `(persisted to ${ENV_PATH})` : `(IN-MEMORY ONLY — .env write failed: ${result.fileError}, path: ${ENV_PATH})`);

    try {
      const written = settingsAudit.logSave({
        prevEnv: auditPrevEnv,
        updates: cleaned,
        deleteKeys,
        req,
        note,
      });
      if (written) console.log(`[settings] audit: logged ${written} change(s) → ${settingsAudit.AUDIT_FILE}`);
    } catch (err) {
      console.warn("[settings] audit log failed:", err.message);
    }

    try {
      const affected = new Set();
      const changedKeys = [...Object.keys(cleaned), ...deleteKeys];
      for (const k of changedKeys) {
        const modes = _KEY_TO_MODES.get(k);
        if (modes) modes.forEach(m => affected.add(m));
      }
      if (affected.size > 0) {
        const cleanNote = typeof note === "string" ? note.trim().slice(0, 500) : "";
        for (const mode of affected) {
          const modeChanged = changedKeys.filter(k => _MODE_KEYS[mode].has(k));
          tradeLogger.appendSettingsSnapshot(mode, buildModeSnapshot(mode), {
            reason: "settings_save",
            changedKeys: modeChanged,
            ...(cleanNote ? { note: cleanNote } : {}),
          });
        }
      }
    } catch (err) {
      console.warn("[settings] daily snapshot append failed:", err.message);
    }
  }
  return result;
}

// ── POST /settings/audit-restore — revert key(s) to a prior audited value ────
// Body: { ts, key, note, allSameNote }
//   • single key      → revert that key to the matched audit entry's `from`
//   • allSameNote=true → revert EVERY key ever changed under the same note to
//                        its earliest `from` (the value before that note's
//                        first change). Used by the Trade Logs "Restore" button.
// Reverting a key whose audit action was "add" deletes the key (its prior
// value was null). API_SECRET-protected (not in app.js open whitelist).
router.post("/audit-restore", (req, res) => {
  const { ts, key, note, allSameNote } = req.body || {};

  let all;
  try { all = settingsAudit.readAuditLog({ limit: 100000 }); } // newest-first
  catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  // Walk oldest-first so the FIRST `from` seen per key is the earliest one.
  const chrono = all.slice().reverse();

  // Build the {key → restore-to value} target map.
  const targets = new Map();
  if (allSameNote && typeof note === "string" && note.trim()) {
    const want = note.trim();
    for (const e of chrono) {
      if (typeof e.note === "string" && e.note.trim() === want && !targets.has(e.key)) {
        targets.set(e.key, e.from);
      }
    }
  } else {
    const e = chrono.find(x => x.ts === ts && x.key === key);
    if (!e) return res.status(404).json({ success: false, error: "audit entry not found" });
    targets.set(e.key, e.from);
  }

  // Translate targets into updates/deletes, skipping sensitive keys.
  const hiddenSet = new Set(HIDDEN_KEYS);
  const cleaned = {};
  const deleteKeys = [];
  for (const [k, from] of targets) {
    if (hiddenSet.has(k)) continue;
    if (from === null || from === undefined) deleteKeys.push(k); // was an "add" → remove
    else cleaned[k] = String(from);
  }

  if (Object.keys(cleaned).length === 0 && deleteKeys.length === 0) {
    return res.status(400).json({ success: false, error: "nothing to restore" });
  }

  const restoreNote = (allSameNote && typeof note === "string" && note.trim())
    ? `↩ restore (same note): ${note.trim()}`.slice(0, 500)
    : `↩ restore ${[...targets.keys()].join(", ")}`.slice(0, 500);

  const result = persistChanges(cleaned, deleteKeys, restoreNote, req);
  res.json({
    ...result,
    restoredCount: Object.keys(cleaned).length + deleteKeys.length,
    restoredKeys: [...Object.keys(cleaned), ...deleteKeys],
    envPath: ENV_PATH,
  });
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

// ── POST /settings/reset-data — selective data reset (categories + date range) ─
// Body: { paper, skip, cache, logs, ticks, from?, to? } — booleans + optional
// "YYYY-MM-DD" IST dates. Deletes only the checked categories. The date range
// applies to dated-file categories only (paper daily JSONL, skip JSONL, ticks);
// cache & logs always clear fully. The aggregate paper JSON + capital restore is
// handled client-side via the per-strategy /reset endpoints (full paper wipe only).
// Auto-gated by the app.js x-api-secret middleware (not in OPEN_PATHS).
const RESET_PAPER_MODES = ["ema_rsi_st", "bb_rsi", "pa", "orb", "ema9vwap", "trend_pb", "trend_day_scalp", "ha_scalp", "simple930", "rsi_pivot_st", "bn_pivot_rsi_st", "early_bird"];
const _RESET_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.post("/reset-data", (req, res) => {
  const b = req.body || {};
  const from = b.from ? String(b.from) : "";
  const to   = b.to   ? String(b.to)   : "";
  if (from && !_RESET_DATE_RE.test(from)) return res.status(400).json({ success: false, error: "bad 'from' date (want YYYY-MM-DD)" });
  if (to   && !_RESET_DATE_RE.test(to))   return res.status(400).json({ success: false, error: "bad 'to' date (want YYYY-MM-DD)" });
  if (from && to && from > to)            return res.status(400).json({ success: false, error: "'from' is after 'to'" });

  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const results = { paperFiles: 0, skipFiles: 0, ticksDays: 0, cacheDirs: 0, logsCleared: false };
  const errors = [];

  // Paper daily JSONL — ~/trading-data/trades/{mode}_paper_trades_YYYY-MM-DD.jsonl
  if (b.paper) {
    for (const mode of RESET_PAPER_MODES) {
      let dates;
      try { dates = tradeLogger.listDailyDates(mode); }
      catch (e) { errors.push(`paper ${mode}: ${e.message}`); continue; }
      for (const { date } of dates) {
        if (!inRange(date)) continue;
        try { fs.unlinkSync(tradeLogger.dailyFilePathFor(mode, date)); results.paperFiles += 1; }
        catch (e) { if (e.code !== "ENOENT") errors.push(`paper ${mode} ${date}: ${e.message}`); }
      }
    }
  }

  // Skip daily JSONL — ~/trading-data/skips/{mode}_paper_skips_YYYY-MM-DD.jsonl
  if (b.skip) {
    for (const mode of RESET_PAPER_MODES) {
      let dates;
      try { dates = skipLogger.listDates(mode); }
      catch (e) { errors.push(`skip ${mode}: ${e.message}`); continue; }
      for (const { date } of dates) {
        if (!inRange(date)) continue;
        try { fs.unlinkSync(skipLogger.filePathFor(mode, date)); results.skipFiles += 1; }
        catch (e) { if (e.code !== "ENOENT") errors.push(`skip ${mode} ${date}: ${e.message}`); }
      }
    }
  }

  // Ticks — day-folders in range (source of truth for Replay; deleting a day
  // removes that day's replay input).
  if (b.ticks) {
    try { results.ticksDays = tickRecorder.deleteRecordingsInRange({ from, to }).deleted; }
    catch (e) { errors.push(`ticks: ${e.message}`); }
  }

  // Cache — always full (range ignored; backtest/candle caches self-heal on demand).
  if (b.cache) {
    for (const name of ["backtest_cache", "candle_cache"]) {
      const dir = path.join(TRADING_DATA_DIR, name);
      try {
        if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); results.cacheDirs += 1; }
      } catch (e) { errors.push(`cache ${name}: ${e.message}`); }
    }
  }

  // Logs — always full (in-memory store; same as POST /logs/clear).
  if (b.logs) {
    logStore.length = 0;
    results.logsCleared = true;
  }

  const rangeStr = (from || to) ? ` [${from || "…"} → ${to || "…"}]` : "";
  console.log(`[settings] 🧹 reset-data${rangeStr} → paper:${results.paperFiles} skip:${results.skipFiles} ticks:${results.ticksDays} cache:${results.cacheDirs} logs:${results.logsCleared}${errors.length ? ` · ${errors.length} error(s)` : ""}`);
  res.json({ success: errors.length === 0, results, errors });
});


// ── GET /settings — Settings page UI ────────────────────────────────────────
router.get("/", (req, res) => {
  // App Secret gate — if API_SECRET is set, require it to access settings
  const appSecret = process.env.API_SECRET;
  if (appSecret && req.query.secret !== appSecret) {
    const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
    // The viewport meta is what keeps this page on the phone's own width. Without
    // it Chrome/Safari lay the document out at their 980px desktop fallback and
    // then zoom the whole thing out to ~40%, which is how the App Secret gate
    // rendered before — legible only by pinch-zooming.
    return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Settings - Auth</title>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'IBM Plex Mono',monospace;background:#040c18;color:#c8d8f0;display:flex;min-height:100vh;}
      ${sidebarCSS()}
      .auth-box{margin:auto;padding:40px;background:#07111f;border:1px solid #0e1e36;border-radius:12px;text-align:center;max-width:400px;width:90%;}
      .auth-box h2{font-size:1rem;color:#60a5fa;margin-bottom:8px;}
      .auth-box p{font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-bottom:20px;}
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
      (function(){ if ('${resolveTheme()}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();
      function go(e){e.preventDefault();var s=document.getElementById('secretInput').value;if(!s)return;window.location='/settings?secret='+encodeURIComponent(s);}
      ${req.query.secret ? "document.getElementById('authErr').style.display='block';" : ""}
      </script></body></html>`);
  }

  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  const envData    = parseEnvFile();

  // ── Determine which fields should be frozen (disabled but values kept) ──
  const vixEnabled      = (envData["VIX_FILTER_ENABLED"] ?? process.env.VIX_FILTER_ENABLED ?? "true") === "true";
  const bbRsiVixEnabled = (envData["BB_RSI_VIX_ENABLED"]  ?? process.env.BB_RSI_VIX_ENABLED  ?? "false") === "true";
  const paVixEnabled    = (envData["PA_VIX_ENABLED"]     ?? process.env.PA_VIX_ENABLED     ?? "false") === "true";
  const bbRsiModeOn     = (envData["BB_RSI_MODE_ENABLED"] ?? process.env.BB_RSI_MODE_ENABLED ?? "true").toLowerCase() === "true";

  function isFieldFrozen(key) {
    // Per-module VIX thresholds frozen when that module's VIX toggle is off
    if ((key === "VIX_MAX_ENTRY" || key === "VIX_STRONG_ONLY") && !vixEnabled) return true;
    if ((key === "BB_RSI_VIX_MAX_ENTRY" || key === "BB_RSI_VIX_STRONG_ONLY") && !bbRsiVixEnabled) return true;
    if (key === "PA_VIX_MAX_ENTRY" && !paVixEnabled) return true;
    // BB_RSI section frozen when bb_rsi mode is off (but not the master toggle itself,
    // and not BB_RSI_OI_ENABLED which lives in the independent OI Filter section).
    if (key.startsWith("BB_RSI_") && key !== "BB_RSI_MODE_ENABLED" && key !== "BB_RSI_OI_ENABLED" && !bbRsiModeOn) return true;
    return false;
  }

  // Build field HTML for each section
  function renderField(f) {
    const val = envData[f.key] ?? process.env[f.key] ?? f.default ?? "";
    const eff = f.effect || EFFECT.INSTANT;
    const effBadge = `<span class="effect-badge" style="--ec:${eff.color}" data-tip="${esc(eff.tip)}"><span class="effect-icon">${eff.icon}</span>${eff.label}<span class="info-i">i</span></span><span class="env-key-tag">${f.key}</span>`;
    const descText = f.desc || "";
    const descHtml = descText ? `<div class="field-desc">${descText}</div>` : "";
    const frozen = isFieldFrozen(f.key);
    const dis = frozen ? "disabled" : "";
    let frozenGroup = "";
    if (f.key === "BB_RSI_VIX_MAX_ENTRY" || f.key === "BB_RSI_VIX_STRONG_ONLY") frozenGroup = "bb_rsi-vix";
    else if (f.key === "PA_VIX_MAX_ENTRY") frozenGroup = "pa-vix";
    else if (f.key === "BB_RSI_OI_ENABLED") frozenGroup = ""; // OI section is independent of BB_RSI mode
    else if (f.key.startsWith("BB_RSI_"))   frozenGroup = "bb_rsi";
    else if (f.key.startsWith("VIX_"))     frozenGroup = "vix";
    const frozenAttr = frozenGroup ? `data-freeze-group="${frozenGroup}"` : "";
    // A field marked `leg` only applies to one EarlyBird trade mode. The row is
    // hidden client-side when EARLYBIRD_TRADE_MODE does not include that leg —
    // e.g. the stock universe is meaningless in "option" mode, where no stock is
    // scanned at all. Hidden, not disabled: a disabled row still reads as "a
    // setting I must think about", which is the confusion being removed.
    const legAttr = f.leg ? `data-eb-leg="${f.leg}"` : "";
    const rowClass = frozen ? "setting-row frozen" : "setting-row";

    if (f.type === "toggle") {
      const checked = val === "true" || val === "1" ? "checked" : "";
      return `
        <div class="${rowClass}" ${frozenAttr} ${legAttr}>
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
      const opts = f.options.map(o => {
        const ov = (o && typeof o === "object") ? o.value : o;
        const ol = (o && typeof o === "object") ? o.label : o;
        return `<option value="${ov}" ${ov === val ? "selected" : ""}>${ol}</option>`;
      }).join("");
      return `
        <div class="${rowClass}" ${frozenAttr} ${legAttr}>
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <select data-key="${f.key}" ${dis} onchange="markDirty(this)">${opts}</select>
        </div>`;
    }

    if (f.type === "number") {
      return `
        <div class="${rowClass}" ${frozenAttr} ${legAttr}>
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
      return `
        <div class="${rowClass}" ${frozenAttr} ${legAttr}>
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <input type="date" data-key="${f.key}" value="${val}" ${dis} onchange="markDirty(this)"/>
        </div>`;
    }

    if (f.type === "time") {
      return `
        <div class="${rowClass}" ${frozenAttr} ${legAttr}>
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <input type="time" data-key="${f.key}" value="${val}" ${dis} onchange="markDirty(this)" style="width:120px;"/>
        </div>`;
    }

    if (f.type === "password") {
      return `
        <div class="${rowClass}" ${frozenAttr} ${legAttr}>
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
      <div class="${rowClass}" ${frozenAttr} ${legAttr}>
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
  function renderTabFields(fields) {
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

  // ── Sub-tabs inside a section ──────────────────────────────────────────────
  // A field carrying `subheader` opens a new tab; fields before the first one
  // fall into an implicit "General" tab. One tab → no tab bar is rendered.
  function splitIntoTabs(fields) {
    const tabs = [];
    let cur = null;
    for (const f of fields) {
      if (f.subheader || !cur) {
        cur = { title: f.subheader || "General", fields: [] };
        tabs.push(cur);
      }
      cur.fields.push(f);
    }
    return tabs;
  }

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Build a flat key→default map so the client can populate the form with
  // schema defaults on demand (used by the "Load Defaults" button per section).
  const SCHEMA_DEFAULTS = {};
  SETTINGS_SCHEMA.forEach(s => s.fields.forEach(f => {
    if (f.default !== undefined) SCHEMA_DEFAULTS[f.key] = String(f.default);
  }));

  // ── Hide strategy sections when their master toggle is off ──
  const emaRsiStModeOn    = (envData["EMA_RSI_ST_MODE_ENABLED"]    ?? process.env.EMA_RSI_ST_MODE_ENABLED    ?? "true").toLowerCase() === "true";
  const paModeOn       = (envData["PA_MODE_ENABLED"]       ?? process.env.PA_MODE_ENABLED       ?? "true").toLowerCase() === "true";
  const orbModeOn      = (envData["ORB_MODE_ENABLED"]      ?? process.env.ORB_MODE_ENABLED      ?? "true").toLowerCase() === "true";
  const ema9vwapModeOn = (envData["EMA9VWAP_MODE_ENABLED"] ?? process.env.EMA9VWAP_MODE_ENABLED ?? "true").toLowerCase() === "true";
  const trendPbModeOn  = (envData["TREND_PB_MODE_ENABLED"] ?? process.env.TREND_PB_MODE_ENABLED ?? "true").toLowerCase() === "true";
  const tdsModeOn      = (envData["TDS_MODE_ENABLED"]      ?? process.env.TDS_MODE_ENABLED      ?? "true").toLowerCase() === "true";
  const haScalpModeOn  = (envData["HA_SCALP_MODE_ENABLED"] ?? process.env.HA_SCALP_MODE_ENABLED ?? "true").toLowerCase() === "true";
  const earlyBirdModeOn = (envData["EARLYBIRD_MODE_ENABLED"] ?? process.env.EARLYBIRD_MODE_ENABLED ?? "true").toLowerCase() === "true";
  const simple930ModeOn = (envData["SIMPLE930_MODE_ENABLED"] ?? process.env.SIMPLE930_MODE_ENABLED ?? "true").toLowerCase() === "true";
  const rsiPivotStModeOn = (envData["RSI_PIVOT_ST_MODE_ENABLED"] ?? process.env.RSI_PIVOT_ST_MODE_ENABLED ?? "true").toLowerCase() === "true";
  const bnPivotRsiStModeOn = (envData["BN_PIVOT_RSI_ST_MODE_ENABLED"] ?? process.env.BN_PIVOT_RSI_ST_MODE_ENABLED ?? "true").toLowerCase() === "true";
  // Server Logs (📜 LOGS) and Cache Files buttons moved into the Logs (/trade-logs) page as tabs —
  // UI_SHOW_LOGS / UI_SHOW_CACHE_FILES now gate those tabs there, not top-bar buttons here.
  // (bbRsiModeOn already computed above for isFieldFrozen)
  const SECTION_TO_MASTER = {
    "EMA_RSI_ST STRATEGY (EMA 20/50 + RSI + SuperTrend) — Zerodha":     emaRsiStModeOn,
    "BB_RSI STRATEGY (BB+SuperTrend+RSI) — Fyers":                   bbRsiModeOn,
    "PRICE ACTION STRATEGY (5-min) — Fyers":                        paModeOn,
    "ORB STRATEGY (Opening Range Breakout) — Fyers":                orbModeOn,
    "EMA9 + VWAP STRATEGY — Zerodha":                               ema9vwapModeOn,
    "TREND PULLBACK STRATEGY — Fyers":                              trendPbModeOn,
    "TREND DAY SCALP STRATEGY — Fyers":                             tdsModeOn,
    "HA SCALP STRATEGY (Heikin Ashi 15m) — Zerodha":                haScalpModeOn,
    "SIMPLE_9:30 STRATEGY (option-premium breakout) — Zerodha":     simple930ModeOn,
    "RSI_PIVOT_ST STRATEGY (RSI + Standard Pivot R1/S1 + SuperTrend) — Zerodha": rsiPivotStModeOn,
    "BN_PIVOT_RSI_ST STRATEGY (NIFTY BANK — RSI + Standard Pivot R1/S1 + SuperTrend) — Zerodha": bnPivotRsiStModeOn,
    "EARLYBIRD STRATEGY (first 15-min breakout, CASH EQUITY) — Fyers": earlyBirdModeOn,
  };

  // Rail entries are collected while the sections render so the index and the
  // panes can never drift apart.
  const railItems = [];
  const sectionsHtml = SETTINGS_SCHEMA.map((s, idx) => {
    if (SECTION_TO_MASTER[s.section] === false) return "";
    const sectionId = sectionSlug(s);
    const eyeBtn = `<button type="button" class="section-eye-btn" onclick="showSectionSummary(${idx})" title="View all configured values">👁</button>`;
    const defaultsBtn = `<button type="button" class="section-defaults-btn" onclick="loadSectionDefaults('${sectionId}')" title="Fill all fields in this section with the recommended schema defaults — does NOT save until you click Save Changes">↺ Load Defaults</button>`;
    const fieldCount = s.fields.length;
    const tabs = splitIntoTabs(s.fields);
    railItems.push({ group: s.group || "System", id: sectionId, icon: s.icon, nav: s.nav || s.section, count: fieldCount });

    const tabBar = tabs.length > 1
      ? `<div class="tab-bar">${tabs.map((t, i) =>
          `<button type="button" class="tab-btn${i === 0 ? " active" : ""}" data-tab="${i}" onclick="showTab(this)">${esc(t.title)}<span class="tab-n">${t.fields.length}</span></button>`
        ).join("")}</div>`
      : "";
    const panels = tabs.map((t, i) =>
      `<div class="tab-panel${i === 0 ? " active" : ""}" data-tab="${i}">${renderTabFields(t.fields)}</div>`
    ).join("");

    return `
    <div class="settings-section" data-section="${sectionId}">
      <div class="section-head">
        <div class="section-head-title">${s.icon} ${s.section}<span class="sh-count">${fieldCount} settings</span></div>
        <div class="section-head-actions">${defaultsBtn}${eyeBtn}</div>
      </div>
      ${tabBar}
      <div class="section-card">${panels}</div>
    </div>`;
  }).join("");

  // Server Control has no schema fields but still needs an index entry.
  railItems.push({ group: "System", id: "server-control", icon: "🔄", nav: "Server Control", count: 0 });

  const RAIL_GROUP_ORDER = ["Strategies", "Trading", "System"];
  const railHtml = RAIL_GROUP_ORDER.map(g => {
    const items = railItems.filter(r => r.group === g);
    if (!items.length) return "";
    return `<div class="rail-group">${g}</div>` + items.map(r => `
      <button type="button" class="rail-item" data-target="${r.id}" onclick="showSection('${r.id}')">
        <span class="rail-icon">${r.icon}</span>
        <span class="rail-label">${esc(r.nav)}</span>
        ${r.count ? `<span class="rail-count" data-count="${r.count}">${r.count}</span>` : ""}
        <span class="rail-dot" title="unsaved changes in this section"></span>
      </button>`).join("");
  }).join("");

  const sectionSummaryJSON = JSON.stringify(sectionSummaries);
  const schemaDefaultsJSON = JSON.stringify(SCHEMA_DEFAULTS);
  const sectionNamesJSON = JSON.stringify(
    SETTINGS_SCHEMA.reduce((m, s, i) => { m[i] = s.section; return m; }, {})
  );
  // key → section id, so the index can flag which sections hold unsaved edits
  const keySectionJSON = JSON.stringify(
    SETTINGS_SCHEMA.reduce((m, s) => {
      const id = sectionSlug(s);
      for (const f of s.fields) m[f.key] = id;
      return m;
    }, {})
  );

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
      --muted:    #8ba1c2;
      --dim:      #6d85a8;
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
      --muted:    #4b5769;
      --dim:      #5c6b7f;
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
    /* Keep top-bar action buttons on a single line — scroll horizontally if they overflow, with no visible scrollbar */
    .top-bar-btns > * { flex-shrink: 0; }
    .top-bar-btns { scrollbar-width: none; -ms-overflow-style: none; }
    .top-bar-btns::-webkit-scrollbar { display: none; }

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
    .page { padding: 24px 28px 60px; max-width: 1220px; }

    /* ── Two-pane shell: section index on the left, one section on the right ── */
    .settings-split {
      display: grid;
      grid-template-columns: 238px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    /* Height is deliberate: the index must clear the fold or it alone gives the
       page a scrollbar the content never needed. Rows are ~32px, not ~41px, and
       the cap subtracts what sits above the index — 177px of top bar + search
       bar on a wide window, ~211px once the top-bar buttons wrap to two rows —
       so on a short screen the list scrolls inside itself instead of running
       off the bottom. */
    .sec-rail {
      position: sticky; top: 12px;
      max-height: calc(100vh - 230px); overflow-y: auto;
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
      padding: 6px; scrollbar-width: thin;
    }
    .rail-group {
      font-size: 0.55rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1.4px;
      color: var(--dim); padding: 9px 10px 3px;
    }
    .rail-group:first-child { padding-top: 3px; }
    .rail-item {
      display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 5px 9px; margin-bottom: 1px;
      background: transparent; border: 1px solid transparent; border-radius: 8px;
      color: var(--text); font-family: inherit; font-size: 0.76rem; font-weight: 600;
      line-height: 1.3; text-align: left; cursor: pointer;
      transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .rail-item:hover { background: var(--surface2); border-color: var(--border); }
    .rail-item.active { background: rgba(59,130,246,0.12); border-color: rgba(59,130,246,0.35); color: var(--text2); }
    .rail-icon { font-size: 0.8rem; line-height: 1; flex-shrink: 0; }
    .rail-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rail-count {
      font-size: 0.6rem; font-family: 'JetBrains Mono', monospace; color: var(--dim);
      background: var(--surface2); border-radius: 4px; padding: 1px 5px; flex-shrink: 0;
    }
    .rail-item.active .rail-count { color: var(--accent); }
    .rail-count.hit { color: var(--accent); background: rgba(59,130,246,0.14); }
    .rail-dot {
      width: 7px; height: 7px; border-radius: 50%; background: var(--yellow);
      flex-shrink: 0; visibility: hidden;
    }
    .rail-item.dirty .rail-dot { visibility: visible; }
    .rail-item.search-hidden { display: none; }

    /* ── Sticky save bar ─────────────────────────────────── */
    .save-bar {
      position: sticky; top: 0; z-index: 90;
      background: rgba(13,19,32,0.95); backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      padding: 12px 28px;
      display: none; align-items: center; justify-content: space-between; gap: 16px;
    }
    .save-bar.visible { display: flex; flex-wrap: wrap; }
    .save-bar .change-count { font-size: 0.78rem; color: var(--yellow); font-weight: 700; }
    .save-bar .change-count::before { content:''; display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--yellow); margin-right:8px; vertical-align:middle; }
    .save-bar .btn-group { display: flex; gap: 10px; }

    /* ── Section: only the selected one is mounted on screen ── */
    .settings-section { display: none; }
    .settings-section.active { display: block; }
    .section-head {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 12px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px 12px 0 0;
      border-bottom: none; /* the tab bar or the card continues the box */
    }
    .section-head-title {
      flex: 1; min-width: 0;
      font-size: 0.78rem; font-weight: 700; color: var(--text2);
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    .sh-count { font-size: 0.6rem; color: var(--dim); font-weight: 500; }
    .section-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

    /* ── Sub-tabs inside a section ─────────────────────────── */
    .tab-bar {
      display: flex; flex-wrap: wrap; gap: 6px;
      padding: 0 12px 10px;
      background: var(--surface);
      border-left: 1px solid var(--border); border-right: 1px solid var(--border);
    }
    .tab-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 12px; border-radius: 7px;
      background: var(--surface2); border: 1px solid var(--border);
      color: var(--muted); font-family: inherit; font-size: 0.7rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.6px; cursor: pointer;
      transition: color 0.12s, border-color 0.12s, background 0.12s;
    }
    .tab-btn:hover { color: var(--text2); border-color: var(--border2); }
    .tab-btn.active { background: rgba(59,130,246,0.12); border-color: rgba(59,130,246,0.4); color: var(--accent); }
    .tab-n { font-size: 0.6rem; font-weight: 600; opacity: 0.7; letter-spacing: 0; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    /* While searching, tabs are irrelevant — every matching row is shown at once */
    .sec-pane.searching .tab-bar { display: none; }
    .sec-pane.searching .tab-panel { display: block; }

    .section-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-top: none;
      border-radius: 0 0 12px 12px;
      overflow: hidden;
    }

    /* ── Search bar ─────────────────────────────────────── */
    .settings-search-bar {
      position: sticky; top: 0; z-index: 30;
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; margin-bottom: 16px;
      background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.18);
    }
    .ssb-icon { font-size: 0.95rem; opacity: 0.7; flex-shrink: 0; }
    #settingsSearchInput {
      flex: 1; background: transparent; border: none; outline: none;
      color: var(--text2); font-family: inherit; font-size: 0.88rem; padding: 4px 2px;
    }
    #settingsSearchInput::placeholder { color: var(--dim); }
    .ssb-count { font-size: 0.7rem; color: var(--muted); font-family: 'JetBrains Mono', monospace; min-width: 0; flex-shrink: 0; }
    .ssb-clear {
      background: transparent; border: 1px solid var(--border2); color: var(--muted);
      padding: 2px 8px; border-radius: 5px; font-size: 0.75rem; cursor: pointer;
      display: none; font-family: inherit;
    }
    .ssb-clear:hover { color: var(--text2); border-color: var(--accent); }
    .settings-search-bar.active .ssb-clear { display: inline-flex; }
    .settings-search-bar.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(59,130,246,0.15), 0 4px 14px rgba(0,0,0,0.18); }
    .setting-row.search-hit { box-shadow: inset 3px 0 0 var(--accent); }
    .setting-row.search-miss { display: none !important; }
    .ssb-empty { color: var(--yellow); font-style: italic; }
    .sec-none {
      display: none; padding: 22px 20px; text-align: center;
      font-size: 0.8rem; color: var(--muted);
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    }
    .sec-pane.no-hits .settings-section { display: none !important; }
    .sec-pane.no-hits .sec-none { display: block; }

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
    input[type="text"], input[type="number"], input[type="date"], input[type="time"], input[type="password"], select {
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
      color: var(--muted-1,#8ba1c2); background: rgba(74,96,128,0.1);
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
    .summary-key { color: var(--muted-1,#8ba1c2); font-size: 0.65rem; }

    ${expiryHolidayModalCSS()}

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
      color: var(--ec, #8ba1c2);
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
      content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 50%;
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

    /* ── Laptop / small-desktop band (13" MacBook etc.) ──
       The fixed 200px sidebar leaves a narrow content column here and the phone
       rules below don't start until 640px. Collapse the 2-up pattern grid, let
       rows wrap, and give inputs more room so values aren't clipped/squeezed. */
    @media (max-width:1200px) {
      .settings-split { grid-template-columns: 200px minmax(0, 1fr); gap: 14px; }
      .pattern-grid { grid-template-columns: 1fr; }
      .pattern-grid .setting-row { border-right: none; }
      .setting-row { flex-wrap: wrap; }
      input[type="text"], input[type="number"], input[type="date"], input[type="time"], input[type="password"], select { max-width: 360px; }
    }

    /* ── Tablet / phone: the index turns into a horizontal chip strip ──
       Below this width a 200px column would leave nothing for the fields, so
       the rail unsticks, scrolls sideways above the pane, and drops its group
       headings. It stays sticky under the save bar so switching section never
       needs a scroll back to the top. */
    @media (max-width:900px) {
      .settings-split { grid-template-columns: minmax(0, 1fr); gap: 12px; }
      /* Static, not sticky: the save bar already owns top:0 and would cover it. */
      .sec-rail {
        position: static;
        display: flex; gap: 6px; padding: 8px;
        max-height: none; overflow-x: auto; overflow-y: hidden;
        -webkit-overflow-scrolling: touch; scrollbar-width: none;
        overscroll-behavior-x: contain;
      }
      .sec-rail::-webkit-scrollbar { display: none; }
      .rail-group { display: none; }
      .rail-item {
        width: auto; flex-shrink: 0; margin-bottom: 0;
        min-height: 44px; padding: 8px 12px;
        background: var(--surface2); border-color: var(--border);
      }
      .rail-label { max-width: 46vw; }
    }

    /* ── Phone (incl. iPhone 17 Pro Max, 440pt wide) ──
       One column everywhere: the label block and its control stack instead of
       fighting for the same row, controls go full-width with 44px touch
       targets, and nothing is allowed to push the page sideways. */
    @media (max-width:640px) {
      .page { padding: 12px 12px 48px; max-width: 100%; }
      .settings-split { gap: 10px; }
      .section-head { padding: 10px 12px; gap: 8px; }
      .section-head-title { font-size: 0.74rem; }
      .section-head-actions { width: 100%; }
      .section-defaults-btn, .section-eye-btn { margin-left: 0; min-height: 34px; }
      .section-defaults-btn { flex: 1; text-align: center; }
      .tab-bar { padding: 0 10px 8px; gap: 5px; }
      .tab-btn { min-height: 38px; padding: 6px 10px; font-size: 0.66rem; }
      .setting-row {
        display: block; padding: 12px 14px;
      }
      .setting-info { margin-bottom: 8px; }
      .setting-label { font-size: 0.82rem; line-height: 1.35; }
      .effect-badge { margin-left: 6px; }
      .env-key-tag { display: inline-block; margin: 4px 0 0 0; }
      .setting-row > input,
      .setting-row > select,
      .setting-row > div:last-child:not(.setting-info) { width: 100%; }
      input[type="text"], input[type="number"], input[type="date"], input[type="time"], input[type="password"], select {
        min-width: 0; max-width: 100%; width: 100%;
        font-size: 16px; /* iOS zooms the page on focus below 16px */
        padding: 11px 14px;
      }
      input[type="time"] { width: 100% !important; }
      .toggle-switch { margin-left: auto; }
      .setting-row .toggle-switch { display: block; }
      /* A toggle is small enough to stay beside its label — only text inputs
         and selects need the full-width stack above. */
      .setting-row:has(> .toggle-switch) { display: flex; align-items: center; gap: 12px; }
      .setting-row:has(> .toggle-switch) .setting-info { margin-bottom: 0; }
      .custom-row { flex-direction: column; align-items: stretch; }
      .custom-row input[type="text"] { min-width: 100%; }
      .save-bar { padding: 10px 12px; }
      .save-bar .btn-group { flex: 1; }
      .save-bar .btn-group button { flex: 1; min-height: 44px; }
      .top-bar { padding: 12px 12px 12px 48px; }
      .summary-table { font-size: 0.7rem; }
    }

    /* The top-bar actions are a deliberate single-line scroller with the
       scrollbar hidden. On a phone that hides the fact it scrolls at all, and
       SAVE ALL → .env — the whole point of this page — sat 710px off the right
       edge with nothing on screen to suggest it was there. Below the shared
       breakpoint they wrap instead. The row is styled inline, so these have to
       be !important to win. */
    @media (max-width:768px) {
      .top-bar-btns {
        flex-wrap: wrap !important; overflow-x: visible !important;
        white-space: normal !important; margin-left: 0 !important; width: 100%;
      }
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
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div class="top-bar-title">Settings</div>
          <span id="expiry-info-pill" class="top-bar-cache schedule empty" title="Next NIFTY weekly/monthly expiry"></span>
          <span id="holiday-info-pill" class="top-bar-cache schedule empty" title="Next NSE trading holiday"></span>
        </div>
      </div>
      <div class="top-bar-btns" style="margin-left:auto;display:flex;gap:8px;flex-wrap:nowrap;overflow-x:auto;white-space:nowrap;">
        <a href="/docs" style="padding:6px 14px;background:rgba(245,158,11,0.12);color:#f59e0b;border:1px solid rgba(245,158,11,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;text-decoration:none;">📄 DOCS</a>
        <button onclick="showBackupModal()" title="Download daily data snapshots so an EC2 loss never loses data" style="padding:6px 14px;background:rgba(52,211,153,0.12);color:#34d399;border:1px solid rgba(52,211,153,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;">📦 BACKUP</button>
        <a href="/pnl-history" style="padding:6px 14px;background:rgba(251,191,36,0.12);color:#fbbf24;border:1px solid rgba(251,191,36,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;text-decoration:none;">💰 P&amp;L HISTORY</a>
        <button onclick="showExpiryHolidaysModal()" title="View NIFTY weekly/monthly expiry calendar and NSE trading holidays" style="padding:6px 14px;background:rgba(34,211,238,0.12);color:#22d3ee;border:1px solid rgba(34,211,238,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;">📅 EXPIRY &amp; HOLIDAYS</button>
        <button onclick="showHealthModal()" title="Quick app health + link to the full EC2 instance Monitor" style="padding:6px 14px;background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.25);border-radius:6px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.5px;">📈 HEALTH</button>
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
      <div class="settings-search-bar" id="settingsSearchBar">
        <span class="ssb-icon">🔎</span>
        <input id="settingsSearchInput" type="search" autocomplete="off" spellcheck="false"
               placeholder="Search settings by label, env key (e.g. UI_SHOW_LOGS), or description…"
               oninput="filterSettings(this.value)" onkeydown="if(event.key==='Escape'){this.value='';filterSettings('');this.blur();}">
        <span class="ssb-count" id="settingsSearchCount"></span>
        <button type="button" class="ssb-clear" id="settingsSearchClear" onclick="document.getElementById('settingsSearchInput').value='';filterSettings('');" title="Clear (Esc)">✕</button>
      </div>
      <div class="settings-split">
        <aside class="sec-rail" id="secRail" aria-label="Settings sections">
          ${railHtml}
        </aside>

        <div class="sec-pane" id="secPane">
          ${sectionsHtml}

          <!-- Restart Server -->
          <div class="settings-section" data-section="server-control">
            <div class="section-head">
              <div class="section-head-title">🔄 Server Control</div>
            </div>
            <div class="restart-section" style="margin-top:0;border-radius:0 0 12px 12px;">
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

          <div class="sec-none" id="secNone">No setting matches your search.</div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
${modalJS()}
// ── Section index: exactly one section is on screen at a time ───────────────
var _keySection     = ${keySectionJSON};
var _activeSection  = null;
var _ssbPrevSection = null; // section open before a search began (restored on clear)

function showSection(id, opts) {
  opts = opts || {};
  var pane = document.getElementById('secPane');
  var target = pane.querySelector('.settings-section[data-section="' + id + '"]');
  if (!target) return;
  pane.querySelectorAll('.settings-section.active').forEach(function(s){ s.classList.remove('active'); });
  target.classList.add('active');
  document.querySelectorAll('.rail-item').forEach(function(b){
    b.classList.toggle('active', b.getAttribute('data-target') === id);
  });
  _activeSection = id;
  // Picking a section by hand during a search is a real choice — don't snap
  // back to wherever the search started once the box is cleared.
  if (!opts.auto) _ssbPrevSection = null;
  if (opts.hash !== false) { try { history.replaceState(null, '', '#' + id); } catch (e) {} }
  // Keep the selected entry in view. On phones the index is a horizontal strip,
  // so scrollIntoView is right; on desktop the rail scrolls inside itself and
  // scrollIntoView would drag the whole window with it, so nudge it by hand.
  var rail = document.getElementById('secRail');
  var chip = rail ? rail.querySelector('.rail-item[data-target="' + id + '"]') : null;
  if (chip && rail) {
    if (window.innerWidth <= 900) {
      chip.scrollIntoView({ block: 'nearest', inline: 'center' });
    } else {
      var cr = chip.getBoundingClientRect(), rr = rail.getBoundingClientRect();
      if (cr.top < rr.top) rail.scrollTop -= (rr.top - cr.top);
      else if (cr.bottom > rr.bottom) rail.scrollTop += (cr.bottom - rr.bottom);
    }
  }
  // Bring the section header back on screen only when it has scrolled away.
  // On desktop go to the top of the page rather than scrolling the header to
  // the viewport edge — the top bar is sticky and would sit on top of it.
  if (opts.top !== false) {
    var head = target.querySelector('.section-head');
    if (head) {
      var hr = head.getBoundingClientRect();
      if (hr.top < 100 || hr.top > window.innerHeight - 60) {
        if (window.innerWidth <= 900) head.scrollIntoView({ block: 'nearest' });
        else window.scrollTo({ top: 0 });
      }
    }
  }
}

function showTab(btn) {
  var section = btn.closest('.settings-section');
  if (!section) return;
  var idx = btn.getAttribute('data-tab');
  section.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.toggle('active', b === btn); });
  section.querySelectorAll('.tab-panel').forEach(function(p){
    p.classList.toggle('active', p.getAttribute('data-tab') === idx);
  });
}

// Flag index entries whose section holds unsaved edits
function updateRailDirty() {
  var counts = {};
  window._dirtyKeys.forEach(function(k){
    var sid = _keySection[k];
    if (sid) counts[sid] = (counts[sid] || 0) + 1;
  });
  document.querySelectorAll('.rail-item').forEach(function(b){
    b.classList.toggle('dirty', !!counts[b.getAttribute('data-target')]);
  });
}

// Open the section named in the URL hash, else the first one in the index.
// The hash is matched against the index by value rather than fed into a
// selector: a hand-edited '#a"]' would make querySelector throw and take the
// rest of this script — dirty tracking included — down with it.
(function initSections(){
  var wanted = '';
  try { wanted = decodeURIComponent((location.hash || '').replace(/^#/, '')); } catch (e) {}
  var items = document.querySelectorAll('.rail-item');
  if (!items.length) return;
  var target = null;
  items.forEach(function(b){
    if (!target && b.getAttribute('data-target') === wanted) target = wanted;
  });
  showSection(target || items[0].getAttribute('data-target'), { hash: false, top: false });
})();

// ── Settings search: filter rows by label / env key / description ──
// While a query is active the index shows only sections with matches (and how
// many), and the open section shows every matching row across all its tabs.
function filterSettings(rawQuery) {
  var q = String(rawQuery || '').trim().toLowerCase();
  var bar = document.getElementById('settingsSearchBar');
  var countEl = document.getElementById('settingsSearchCount');
  var pane = document.getElementById('secPane');

  // Empty query → restore pre-search state
  if (!q) {
    bar.classList.remove('active');
    countEl.textContent = '';
    countEl.classList.remove('ssb-empty');
    pane.classList.remove('searching', 'no-hits');
    document.querySelectorAll('.setting-row.search-hit, .setting-row.search-miss').forEach(function(r){
      r.classList.remove('search-hit', 'search-miss');
    });
    document.querySelectorAll('.rail-item').forEach(function(b){
      b.classList.remove('search-hidden');
      var c = b.querySelector('.rail-count');
      if (c) { c.textContent = c.getAttribute('data-count'); c.classList.remove('hit'); }
    });
    if (_ssbPrevSection) { showSection(_ssbPrevSection, { top: false, auto: true }); _ssbPrevSection = null; }
    return;
  }

  // First keystroke of a new search → remember where the user was
  if (_ssbPrevSection === null) _ssbPrevSection = _activeSection;

  bar.classList.add('active');
  pane.classList.add('searching');

  var totalHits = 0, firstHitId = null, activeHits = 0;
  document.querySelectorAll('.settings-section[data-section]').forEach(function(section){
    var id = section.getAttribute('data-section');
    var sectionHits = 0;
    section.querySelectorAll('.setting-row').forEach(function(row){
      var label  = (row.querySelector('.setting-label') || {}).textContent || '';
      var keyTag = (row.querySelector('.env-key-tag') || {}).textContent || '';
      var desc   = (row.querySelector('.field-desc') || {}).textContent || '';
      var hay = (label + ' ' + keyTag + ' ' + desc).toLowerCase();
      if (hay.indexOf(q) !== -1) {
        row.classList.add('search-hit');
        row.classList.remove('search-miss');
        sectionHits++;
      } else {
        row.classList.remove('search-hit');
        row.classList.add('search-miss');
      }
    });
    var rail = document.querySelector('.rail-item[data-target="' + id + '"]');
    if (rail) {
      rail.classList.toggle('search-hidden', sectionHits === 0);
      var c = rail.querySelector('.rail-count');
      if (c) { c.textContent = sectionHits; c.classList.toggle('hit', sectionHits > 0); }
    }
    if (sectionHits > 0 && !firstHitId) firstHitId = id;
    if (id === _activeSection) activeHits = sectionHits;
    totalHits += sectionHits;
  });

  // Nothing to see in the open section → jump to the first one that has matches
  if (totalHits > 0 && activeHits === 0 && firstHitId) showSection(firstHitId, { top: false, auto: true });
  pane.classList.toggle('no-hits', totalHits === 0);

  countEl.classList.toggle('ssb-empty', totalHits === 0);
  countEl.textContent = totalHits === 0 ? 'no matches' : (totalHits + ' match' + (totalHits === 1 ? '' : 'es'));
}

// '/' to focus the search box (unless already typing in another input)
document.addEventListener('keydown', function(e){
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  var t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  var input = document.getElementById('settingsSearchInput');
  if (input) { e.preventDefault(); input.focus(); input.select(); }
});

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

  // ── EarlyBird: hide the settings the chosen trade mode does not use ────────
  // "option" mode scans no stock at all, so the universe, the confirmation
  // count, the gap rule, share sizing and the equity cost model are dead
  // controls there; "stock" mode never touches an option, so lots and ITM
  // steps are dead. Showing them is what made this page confusing. The values
  // are left untouched in the env — only the ROW is hidden, so switching the
  // mode back restores exactly what was configured before.
  function updateEarlyBirdLegVisibility() {
    var sel = document.querySelector('[data-key="EARLYBIRD_TRADE_MODE"]');
    if (!sel) return;
    var mode = sel.value || 'stock';
    document.querySelectorAll('[data-eb-leg]').forEach(function(row) {
      var leg = row.getAttribute('data-eb-leg');
      var used = (mode === 'both') || (mode === leg);
      row.style.display = used ? '' : 'none';
    });
  }
  var ebModeEl = document.querySelector('[data-key="EARLYBIRD_TRADE_MODE"]');
  if (ebModeEl) {
    ebModeEl.addEventListener('change', updateEarlyBirdLegVisibility);
  }
  updateEarlyBirdLegVisibility();

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
  if (key === 'BB_RSI_MODE_ENABLED') toggleFreezeGroup('bb_rsi', !el.checked);
  if (key === 'BB_RSI_VIX_ENABLED')  toggleFreezeGroup('bb_rsi-vix', !el.checked);
  if (key === 'PA_VIX_ENABLED')     toggleFreezeGroup('pa-vix', !el.checked);
  updateSaveBar();
}

function updateSaveBar() {
  var bar = document.getElementById('saveBar');
  var count = document.getElementById('changeCount');
  var n = window._dirtyKeys.size;
  updateRailDirty();
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
  var bbRsiOrig    = window._originals['BB_RSI_MODE_ENABLED'];
  var bbRsiVixOrig = window._originals['BB_RSI_VIX_ENABLED'];
  var paVixOrig    = window._originals['PA_VIX_ENABLED'];
  toggleFreezeGroup('vix',       vixOrig      !== true && vixOrig      !== 'true');
  toggleFreezeGroup('bb_rsi',     bbRsiOrig    !== true && bbRsiOrig    !== 'true');
  toggleFreezeGroup('bb_rsi-vix', bbRsiVixOrig !== true && bbRsiVixOrig !== 'true');
  toggleFreezeGroup('pa-vix',    paVixOrig    !== true && paVixOrig    !== 'true');
  showToast('Changes discarded', 'info');
}

async function saveSettings() {
  var btn = document.getElementById('saveBtn');

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

  if (Object.keys(updates).length === 0) return;

  // Ask for an optional checkpoint note before saving. Returns null on Cancel,
  // empty string when user just presses Enter / Submit without typing.
  var keys = Object.keys(updates);
  var preview = keys.slice(0, 4).join(', ') + (keys.length > 4 ? ', +' + (keys.length - 4) + ' more' : '');
  var note = await showPrompt({
    icon: '🔖',
    title: 'Checkpoint Note',
    message: 'Saving ' + keys.length + ' change' + (keys.length === 1 ? '' : 's') + ': ' + preview + '.\\n\\nDescribe WHY you are making this change (optional). It will be saved with the old→new diff in the audit log so future trade-log analysis can correlate outcomes with this change.\\n\\nLeave empty and press Submit to save without a note.',
    placeholder: 'e.g. loosening trend gate, ADX 22 rejecting too many entries',
    inputType: 'text',
  });
  if (note === null) return; // user clicked Cancel
  note = (note || '').trim();

  btn.disabled = true;
  btn.textContent = 'Saving...';

  secretFetch('/settings/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: updates, note: note }),
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
        showToast(msg + ' — restart needed for: ' + data.needsRestart.join(', '), 'info');
        maybePromptRestart(data.needsRestart, msg);
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
        showToast(msg + ' — restart needed for: ' + data.needsRestart.join(', '), 'info');
        maybePromptRestart(data.needsRestart, msg);
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
  var ok = await showDoubleConfirm({
    icon: '🔄', title: 'Restart Server',
    message: 'This will restart the server and stop any active trading sessions.\\n\\nAre you sure?',
    confirmText: 'Restart', confirmClass: 'modal-btn-danger',
    subject: 'Server restart (will kill active sessions)',
    secondConfirmText: 'Yes, restart'
  });
  if (!ok) return;
  triggerServerRestart(btn);
}

// ── Backup & Restore card ────────────────────────────────────────────────────
function backupFmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
var _backupLatestDate = null;
async function loadBackups() {
  var statusLine = document.getElementById('backup-status-line');
  var body = document.getElementById('backupListBody');
  if (!body) return;
  try {
    var r = await fetch('/backup/data', { cache: 'no-store' });
    var d = await r.json();
    if (!d.enabled) {
      statusLine.innerHTML = '⚠️ Backup is disabled — enable <b>Daily Data Backup</b> below.';
      body.innerHTML = '<tr><td colspan="4" style="padding:10px 8px;color:var(--muted-2,#6d85a8);">Disabled.</td></tr>';
      return;
    }
    statusLine.textContent = 'Daily at ' + String(d.hour).padStart(2, '0') + ':00 IST · keeps latest only (new replaces old) · ' + d.backups.length + ' on server';
    if (!d.backups.length) {
      _backupLatestDate = null;
      body.innerHTML = '<tr><td colspan="4" style="padding:10px 8px;color:var(--muted-2,#6d85a8);">No snapshots yet — click "Snapshot now".</td></tr>';
      return;
    }
    _backupLatestDate = d.backups[0].date;
    body.innerHTML = d.backups.map(function(b) {
      var status = b.downloaded
        ? '<span style="color:#10b981;">✓ downloaded</span>'
        : (b.driveUploaded
            ? '<span style="color:#10b981;" title="Off-site copy on Google Drive — no local download needed">☁ safe in Drive</span>'
            : '<span style="color:#fbbf24;">⏳ not downloaded</span>');
      return '<tr style="border-top:1px solid rgba(59,130,246,0.12);">' +
        '<td style="padding:6px 8px;color:#cfe0f8;font-weight:600;">' + b.date + '</td>' +
        '<td style="padding:6px 8px;color:#9db4d6;">' + backupFmtBytes(b.sizeBytes) + '</td>' +
        '<td style="padding:6px 8px;">' + status + '</td>' +
        '<td style="padding:6px 8px;text-align:right;white-space:nowrap;">' +
          '<a href="/backup/download?date=' + encodeURIComponent(b.date) + '" title="Download" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-right:14px;">⬇</a>' +
          '<a href="#" class="bk-del-btn" data-date="' + b.date + '" title="Delete this snapshot" style="color:#f87171;text-decoration:none;font-weight:700;">🗑</a>' +
        '</td>' +
        '</tr>';
    }).join('');
  } catch (e) {
    statusLine.textContent = 'Failed to load backups: ' + e.message;
  }
}
function backupDownloadLatest() {
  if (!_backupLatestDate) { showToast('No snapshot yet — click "Snapshot now" first.', 'info'); return false; }
  window.location = '/backup/download?date=' + encodeURIComponent(_backupLatestDate);
  setTimeout(loadBackups, 2000);
  return false;
}
// Secrets download goes through secretFetch + a blob: /backup/secrets requires
// the API secret (it returns plaintext keys), and a plain link navigation cannot
// carry the x-api-secret header the way /backup/download's open route can.
async function backupDownloadSecrets() {
  var ok = await showConfirm({
    icon: '🔑', title: 'Download secrets',
    message: 'This downloads your .env (broker keys, tokens, login secret) and certs/ (TLS private key) in plain text.\\n\\nStore the file somewhere private — a password manager or encrypted drive. Do not put it in Google Drive or any shared folder.\\n\\nContinue?',
    confirmText: 'Download', confirmClass: 'modal-btn-primary'
  });
  if (!ok) return;
  var btn = document.getElementById('backupSecretsBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Building…'; }
  var url = null;
  try {
    var r = await secretFetch('/backup/secrets');
    if (!r) return;                                   // user cancelled the API-secret prompt
    if (!r.ok) {
      var msg = 'HTTP ' + r.status;
      try { var d = await r.json(); if (d && d.error) msg = d.error; } catch (_) {}
      showToast('Secrets download failed: ' + msg, 'error');
      return;
    }
    var blob = await r.blob();
    // Filename comes from the server's Content-Disposition (secrets-<date>.tar.gz).
    var name = 'secrets.tar.gz';
    var cd = r.headers.get('Content-Disposition') || '';
    var m = cd.match(/filename="([^"]+)"/);
    if (m) name = m[1];
    url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Secrets downloaded (' + backupFmtBytes(blob.size) + ') — keep it private.', 'success');
  } catch (e) {
    showToast('Secrets download failed: ' + e.message, 'error');
  } finally {
    // Revoke after the browser has had a tick to start the download.
    if (url) setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
    if (btn) { btn.disabled = false; btn.textContent = '🔑 Download .env + certs'; }
  }
}
async function backupCreateNow() {
  var btn = document.getElementById('backupCreateBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating…'; }
  try {
    var r = await secretFetch('/backup/create', { method: 'POST' });
    if (!r) { if (btn) { btn.disabled = false; btn.textContent = '↻ Snapshot now'; } return; }
    var d = await r.json();
    if (d.ok) showToast('Snapshot created (' + backupFmtBytes(d.sizeBytes) + ')', 'success');
    else showToast('Snapshot failed: ' + (d.error || 'unknown'), 'error');
  } catch (e) {
    showToast('Snapshot failed: ' + e.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = '↻ Snapshot now'; }
  loadBackups();
}
// Delegated so it survives the table's innerHTML rebuilds (no inline onclick).
document.addEventListener('click', function(e) {
  var t = e.target && e.target.closest ? e.target.closest('.bk-del-btn') : null;
  if (!t) return;
  e.preventDefault();
  backupDelete(t.getAttribute('data-date'));
});
async function backupDelete(date) {
  var ok = await showDoubleConfirm({
    icon: '🗑', title: 'Delete backup',
    message: 'Delete the snapshot for ' + date + '?\\n\\nThis cannot be undone — make sure you have it downloaded if you still need it.',
    confirmText: 'Delete', confirmClass: 'modal-btn-danger',
    subject: 'Delete backup ' + date, secondConfirmText: 'Yes, delete'
  });
  if (!ok) return false;
  try {
    var r = await secretFetch('/backup/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: date }) });
    if (!r) return false;
    var d = await r.json();
    if (d.ok) { showToast('Deleted backup ' + date, 'success'); loadBackups(); }
    else showToast('Delete failed: ' + (d.error || 'unknown'), 'error');
  } catch (e) {
    showToast('Delete failed: ' + e.message, 'error');
  }
  return false;
}
async function backupRestore() {
  var input = document.getElementById('backupRestoreFile');
  var file = input && input.files && input.files[0];
  if (!file) { showToast('Choose a backup .tar.gz file first.', 'info'); return; }
  var ok = await showDoubleConfirm({
    icon: '⟲', title: 'Restore data from backup',
    message: 'This OVERWRITES ~/trading-data and data/ticks on the server with the contents of:\\n\\n' + file.name + '\\n\\nA safety snapshot of current data is taken first. Restore is blocked if a session is running. Continue?',
    confirmText: 'Restore', confirmClass: 'modal-btn-danger',
    subject: 'Overwrite server data with uploaded backup',
    secondConfirmText: 'Yes, restore'
  });
  if (!ok) return;
  var btn = document.getElementById('backupRestoreBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Restoring…'; }
  try {
    var r = await secretFetch('/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: file });
    if (!r) { if (btn) { btn.disabled = false; btn.textContent = '⟲ Restore'; } return; }
    var d = await r.json();
    if (d.ok) {
      showToast('Restored: ' + d.restored.join(', ') + '. Restart the server to load it.', 'success');
      loadBackups();
      var doRestart = await showDoubleConfirm({
        icon: '🔄', title: 'Restart now?',
        message: 'Restore complete. The server should restart to load the restored data.\\n\\nRestart now?',
        confirmText: 'Restart', confirmClass: 'modal-btn-danger',
        subject: 'Server restart', secondConfirmText: 'Yes, restart'
      });
      if (doRestart) triggerServerRestart(null);
    } else {
      showToast('Restore failed: ' + (d.error || 'unknown'), 'error');
    }
  } catch (e) {
    showToast('Restore failed: ' + e.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = '⟲ Restore'; }
}
// ── Google Drive off-site copy ───────────────────────────────────────────────
var _gdriveConnecting  = false;   // device flow in progress — freeze the status re-render
var _gdrivePollTimer   = null;
var _gdriveLastErrorAt = null;
var _gdriveDismissedAt = null;    // the error stamp the user dismissed; a newer one re-shows

function gdriveEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function gdriveFmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return iso; }
}
function gdriveDismissError() {
  var box = document.getElementById('gdrive-error');
  if (box) box.style.display = 'none';
  _gdriveDismissedAt = _gdriveLastErrorAt;
}
// Persistent in-page error strip. Also how a FAILED automatic daily push gets
// reported — the server keeps the last error, so it's here on the next open.
function gdriveRenderError(err) {
  var box = document.getElementById('gdrive-error');
  var txt = document.getElementById('gdrive-error-text');
  if (!box || !txt) return;
  if (!err || !err.message) { box.style.display = 'none'; _gdriveLastErrorAt = null; return; }
  _gdriveLastErrorAt = err.at || null;
  if (_gdriveDismissedAt && _gdriveDismissedAt === _gdriveLastErrorAt) { box.style.display = 'none'; return; }
  txt.innerHTML = '<b>⚠️ Drive upload failed</b>' + (err.at ? ' <span style="color:#9db4d6;">(' + gdriveEsc(gdriveFmtTime(err.at)) + ')</span>' : '') +
                  '<br/>' + gdriveEsc(err.message);
  box.style.display = 'block';
}

function gdriveBtn(label, fn, color, id) {
  return '<button id="' + id + '" onclick="' + fn + '" style="padding:8px 16px;background:rgba(' + color + ',0.15);color:rgb(' + color + ');border:1px solid rgba(' + color + ',0.35);border-radius:7px;font-size:0.74rem;font-weight:700;cursor:pointer;font-family:\\'IBM Plex Mono\\',monospace;">' + label + '</button>';
}

function gdriveRender(d) {
  var pill    = document.getElementById('gdrive-pill');
  var main    = document.getElementById('gdrive-main');
  var actions = document.getElementById('gdrive-actions');
  var setup   = document.getElementById('gdrive-setup');
  if (!pill || !main || !actions) return;

  gdriveRenderError(d.lastError);

  if (d.connected) {
    pill.textContent = 'CONNECTED';
    pill.style.background = 'rgba(16,185,129,0.15)'; pill.style.color = '#34d399';
    var lines = ['✓ ' + gdriveEsc(d.account || 'Google account') + ' · folder <b style="color:#cfe0f8;">' + gdriveEsc(d.folderName) + '</b> · keeps last ' + d.retain];
    if (d.lastUpload) {
      lines.push('Last upload: <b style="color:#cfe0f8;">' + gdriveEsc(d.lastUpload.name) + '</b> · ' +
                 backupFmtBytes(d.lastUpload.sizeBytes) + ' · ' + gdriveEsc(gdriveFmtTime(d.lastUpload.at)) +
                 ' (' + gdriveEsc(d.lastUpload.trigger || 'manual') + ')');
    } else {
      lines.push('No upload yet — the next daily snapshot will be pushed automatically.');
    }
    main.innerHTML = lines.join('<br/>');
    actions.innerHTML = gdriveBtn(d.uploading ? '⏳ Uploading…' : '☁ Backup to Drive now', 'gdriveUploadNow()', '96,165,250', 'gdriveUploadBtn') +
                        gdriveBtn('Disconnect', 'gdriveDisconnect()', '148,163,184', 'gdriveDisconnectBtn');
    if (d.uploading) { var ub = document.getElementById('gdriveUploadBtn'); if (ub) ub.disabled = true; }
    if (setup) setup.open = false;
  } else if (d.configured) {
    pill.textContent = 'NOT CONNECTED';
    pill.style.background = 'rgba(245,158,11,0.15)'; pill.style.color = '#fbbf24';
    main.innerHTML = 'OAuth client saved (' + gdriveEsc(d.clientIdHint || '') + '). Click Connect and approve the code on Google.';
    actions.innerHTML = gdriveBtn('🔗 Connect Google Drive', 'gdriveConnect()', '96,165,250', 'gdriveConnectBtn');
  } else {
    pill.textContent = 'NOT SET UP';
    pill.style.background = 'rgba(90,108,138,0.18)'; pill.style.color = '#7e93b5';
    main.innerHTML = 'Not connected — backups stay on this server only. Do the one-time Google setup below, then Connect.';
    actions.innerHTML = '';
    if (setup) setup.open = true;
  }
}

async function loadGdrive() {
  if (_gdriveConnecting) return;   // don't stomp the device-code panel mid-connect
  try {
    var r = await fetch('/backup/gdrive/status', { cache: 'no-store' });
    gdriveRender(await r.json());
  } catch (e) {
    var main = document.getElementById('gdrive-main');
    if (main) main.textContent = 'Failed to load Drive status: ' + e.message;
  }
}

async function gdriveSaveCreds() {
  var id  = (document.getElementById('gdriveClientId') || {}).value || '';
  var sec = (document.getElementById('gdriveClientSecret') || {}).value || '';
  var btn = document.getElementById('gdriveSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    var r = await secretFetch('/backup/gdrive/credentials', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: id.trim(), clientSecret: sec.trim() })
    });
    if (r) {
      var d = await r.json();
      if (d.ok) {
        showToast('Google client saved — now click Connect.', 'success');
        var se = document.getElementById('gdriveClientSecret'); if (se) se.value = '';
        gdriveRender(d.status);
      } else {
        showToast('Save failed: ' + (d.error || 'unknown'), 'error');
      }
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
}

async function gdriveConnect() {
  var btn = document.getElementById('gdriveConnectBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Contacting Google…'; }
  try {
    var r = await secretFetch('/backup/gdrive/connect', { method: 'POST' });
    if (!r) { if (btn) { btn.disabled = false; btn.textContent = '🔗 Connect Google Drive'; } return; }
    var d = await r.json();
    if (!d.ok) {
      showToast('Connect failed: ' + (d.error || 'unknown'), 'error');
      gdriveRenderError({ at: new Date().toISOString(), message: d.error || 'unknown' });
      if (btn) { btn.disabled = false; btn.textContent = '🔗 Connect Google Drive'; }
      return;
    }
    _gdriveConnecting = true;
    var panel = document.getElementById('gdrive-device');
    var code  = document.getElementById('gdrive-user-code');
    var url   = document.getElementById('gdrive-verify-url');
    var note  = document.getElementById('gdrive-device-note');
    if (code) code.textContent = d.userCode;
    if (url)  { url.href = d.verificationUrl; url.textContent = String(d.verificationUrl).replace(/^https?:\\/\\//, ''); }
    if (note) note.textContent = 'Waiting for you to approve…';
    if (panel) panel.style.display = 'block';
    var acts = document.getElementById('gdrive-actions');
    if (acts) acts.innerHTML = '';
    gdrivePollOnce(Date.now() + (d.expiresIn || 900) * 1000, (d.intervalSec || 5) * 1000);
  } catch (e) {
    showToast('Connect failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🔗 Connect Google Drive'; }
  }
}

function gdriveEndConnect(msg, kind) {
  _gdriveConnecting = false;
  if (_gdrivePollTimer) { clearTimeout(_gdrivePollTimer); _gdrivePollTimer = null; }
  var panel = document.getElementById('gdrive-device');
  if (panel) panel.style.display = 'none';
  if (msg) showToast(msg, kind || 'info');
  loadGdrive();
}

async function gdrivePollOnce(deadline, intervalMs) {
  if (!_gdriveConnecting) return;
  if (Date.now() > deadline) { gdriveEndConnect('The code expired — click Connect again.', 'error'); return; }
  var d = null;
  try {
    var r = await fetch('/backup/gdrive/poll', { cache: 'no-store' });
    d = await r.json();
  } catch (e) { /* transient — keep polling */ }
  // Cancel may have landed while this poll was in flight; the server has already
  // forgotten the device code, so its "no connection in progress" reply is not
  // something to report as a failure.
  if (!_gdriveConnecting) return;

  if (d && d.state === 'connected') {
    gdriveEndConnect('Google Drive connected' + (d.account ? ' as ' + d.account : '') + '. Daily backups will be pushed automatically.', 'success');
    return;
  }
  if (d && (d.state === 'denied' || d.state === 'expired' || d.state === 'error')) {
    var msg = d.state === 'denied' ? 'You denied access on Google.'
            : d.state === 'expired' ? 'The code expired — click Connect again.'
            : (d.error || 'Connect failed.');
    gdriveRenderError({ at: new Date().toISOString(), message: msg });
    gdriveEndConnect(msg, 'error');
    return;
  }
  _gdrivePollTimer = setTimeout(function() { gdrivePollOnce(deadline, intervalMs); }, intervalMs);
}

async function gdriveCancelConnect() {
  try { await secretFetch('/backup/gdrive/cancel', { method: 'POST' }); } catch (e) {}
  gdriveEndConnect('Connect cancelled.', 'info');
}

async function gdriveDisconnect() {
  var ok = await showDoubleConfirm({
    icon: '☁', title: 'Disconnect Google Drive',
    message: 'Daily backups will stop being pushed off-site. Files already on Drive are left untouched.\\n\\nDisconnect?',
    confirmText: 'Disconnect', confirmClass: 'modal-btn-danger',
    subject: 'Disconnect Google Drive', secondConfirmText: 'Yes, disconnect'
  });
  if (!ok) return;
  try {
    var r = await secretFetch('/backup/gdrive/disconnect', { method: 'POST' });
    if (!r) return;
    var d = await r.json();
    showToast('Google Drive disconnected.', 'success');
    gdriveRender(d.status);
  } catch (e) {
    showToast('Disconnect failed: ' + e.message, 'error');
  }
}

async function gdriveUploadNow() {
  var btn = document.getElementById('gdriveUploadBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Uploading…'; }
  try {
    var r = await secretFetch('/backup/gdrive/upload', { method: 'POST' });
    if (!r) { if (btn) { btn.disabled = false; btn.textContent = '☁ Backup to Drive now'; } return; }
    var d = await r.json();
    if (d.ok) {
      showToast('Uploaded to Drive (' + backupFmtBytes(d.sizeBytes) + ' in ' + d.seconds + 's)', 'success');
      gdriveDismissError();
    } else {
      showToast('Drive upload failed: ' + (d.error || 'unknown'), 'error');
      _gdriveDismissedAt = null;
      gdriveRenderError({ at: new Date().toISOString(), message: d.error || 'unknown' });
    }
  } catch (e) {
    showToast('Drive upload failed: ' + e.message, 'error');
    _gdriveDismissedAt = null;
    gdriveRenderError({ at: new Date().toISOString(), message: e.message });
  }
  if (btn) { btn.disabled = false; btn.textContent = '☁ Backup to Drive now'; }
  loadBackups();
  loadGdrive();
}

function showBackupModal() {
  var m = document.getElementById('backupModal');
  if (!m) return;
  m.style.display = 'block';
  loadBackups();
  loadGdrive();
}
// Refresh the list only while the modal is open.
setInterval(function() {
  var m = document.getElementById('backupModal');
  if (m && m.style.display === 'block') { loadBackups(); loadGdrive(); }
}, 60000);

// Kicks the server restart endpoint and polls /settings/data until it's back,
// then reloads the page. Shared by the explicit Restart button and the
// post-save auto-restart prompt.
function triggerServerRestart(btn) {
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> Restarting...';
  }
  showToast('Restarting server — page will reload when it comes back...', 'info');

  secretFetch('/settings/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).catch(function() {}); // will fail when server dies — that's expected

  var attempts = 0;
  var poller = setInterval(function() {
    attempts++;
    if (attempts > 30) { // 30 seconds max
      clearInterval(poller);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span>🔄</span> Restart Server';
      }
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

// Shown after a save returns keys that need a restart. Asks the user whether
// to auto-restart the server now or apply the change later via the explicit
// Restart button / session stop+start. savedMsg is the success summary so
// the modal carries both the save confirmation and the restart prompt.
async function maybePromptRestart(needsRestart, savedMsg) {
  if (!needsRestart || !needsRestart.length) return;
  var keys = needsRestart.slice();
  var preview = keys.slice(0, 8).join(', ') + (keys.length > 8 ? ', +' + (keys.length - 8) + ' more' : '');
  var ok = await showConfirm({
    icon: '🔄',
    title: 'Restart Required',
    message: savedMsg + '.\\n\\nThese keys are cached at startup and only take effect after a restart:\\n' + preview + '\\n\\nRestart the server now? Active trading sessions will stop and the page will reload.',
    cancelText: 'Later',
    confirmText: 'Restart Now',
    confirmClass: 'modal-btn-danger',
  });
  if (!ok) {
    showToast(savedMsg + ' — restart later to apply: ' + needsRestart.join(', '), 'info');
    return;
  }
  triggerServerRestart();
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

  var ok = await showDoubleConfirm({
    icon: '🚀',
    title: 'Bulk Update & Restart',
    message: msgHead + '\\n\\n' + previewList + '\\n\\nActive trading sessions will stop. Page will reload.',
    confirmText: 'Update & Restart',
    confirmClass: 'modal-btn-danger',
    subject: keys.length + ' update(s)' + (deletes.length ? ' + ' + deletes.length + ' delete(s)' : '') + ' + server restart',
    secondConfirmText: 'Yes, update & restart'
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
  // secretFetch, not fetch: /settings/env returns unmasked .env values, so it
  // stays behind API_SECRET. Masking below is display-only.
  secretFetch('/settings/env').then(function(r){return r ? r.json() : null}).then(function(data){
    if (!data) { document.getElementById('envModal').style.display='none'; return; }
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
    html+='<div style="margin-top:12px;color:var(--muted-1,#8ba1c2);font-size:0.7rem;">'+keys.length+' keys | Sensitive values hidden</div>';
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
  body.innerHTML = '<div style="text-align:center;color:var(--muted-1,#8ba1c2);padding:20px;">Checking system health...</div>';
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
      { label: 'BB_RSI Mode',    value: d.bbRsiMode || 'Idle', ok: true },
    ];
    // Telegram delivery — optional channel, so "not configured" is a healthy
    // (green) state, not an error. When configured, the row is seeded from the
    // passive last-send state, then replaced in place by a live getMe probe
    // (see below) so opening this modal genuinely tests Telegram right now.
    var tg = d.telegram || {};
    if (!tg.configured) {
      rows.push({ label: 'Telegram', value: 'Not configured', ok: true });
    } else {
      rows.push({ label: 'Telegram', value: 'Checking…', ok: !tg.lastError, id: 'health-tg' });
    }
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
      var valId = r.id ? (' id="' + r.id + '-val"') : '';
      html += '<tr style="border-bottom:1px solid #0e1428;background:' + bg + '">';
      html += '<td style="padding:8px 12px;color:#8aa1bd;">' + r.label + '</td>';
      html += '<td' + valId + ' style="padding:8px 12px;color:#e0eaf8;text-align:right;">' + dot + r.value + '</td>';
      html += '</tr>';
    }
    html += '</table>';
    html += '<div style="margin-top:12px;color:var(--muted-1,#8ba1c2);font-size:0.68rem;text-align:center;">Last checked: ' + new Date(d.timestamp).toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata', hour12:false}) + ' IST</div>';
    body.innerHTML = html;

    // Live Telegram reachability probe (getMe — sends no chat message). Updates
    // the seeded "Checking…" cell in place; runs fire-and-forget so the modal
    // stays responsive even if Telegram is blocked and the probe waits to time out.
    if (document.getElementById('health-tg-val')) {
      fetch('/auth/telegram-ping', { cache: 'no-store' })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(p){
          var cell = document.getElementById('health-tg-val');
          if (!cell) return;
          var pOk, txt;
          if (!p) { pOk = false; txt = 'Probe failed'; }
          else if (p.configured === false) { pOk = true; txt = 'Not configured'; }
          else if (p.ok) { pOk = true; txt = 'OK (reachable)'; }
          else { pOk = false; txt = 'UNREACHABLE' + (p.code != null ? (' [' + p.code + ']') : ''); }
          var pDot = pOk ? '<span style="color:#10b981;margin-right:6px;">●</span>' : '<span style="color:#ef4444;margin-right:6px;">●</span>';
          cell.innerHTML = pDot + txt;
        })
        .catch(function(){
          var cell = document.getElementById('health-tg-val');
          if (cell) cell.innerHTML = '<span style="color:#ef4444;margin-right:6px;">●</span>Probe failed';
        });
    }
  } catch(e) {
    body.innerHTML = '<div style="text-align:center;padding:20px;"><div style="font-size:2.5rem;margin-bottom:8px;">❌</div><div style="color:#ef4444;font-weight:700;">Health check failed</div><div style="color:var(--muted-1,#8ba1c2);font-size:0.75rem;margin-top:6px;">' + e.message + '</div></div>';
  }
}

${expiryHolidayModalJS()}

// ── Section Summary (Eye icon) ─────────────────────────────────────────────
var _sectionSummaries = ${sectionSummaryJSON};
var _schemaDefaults   = ${schemaDefaultsJSON};
var _sectionNames = ${sectionNamesJSON};

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

// ── Expiry / Holiday schedule pills (mirror of the Dashboard top-bar) ─────────
async function loadSettingsSchedulePills(){
  function istDateISO(){ return new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' }); }
  function diffDays(iso){
    var p = iso.split('-');
    var dt = new Date(Date.UTC(+p[0], +p[1]-1, +p[2]));
    var t = istDateISO().split('-');
    var now = new Date(Date.UTC(+t[0], +t[1]-1, +t[2]));
    return Math.round((dt - now) / 86400000);
  }
  function fmtDMY(iso){ var p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  var expEl = document.getElementById('expiry-info-pill');
  var holEl = document.getElementById('holiday-info-pill');
  if (!expEl || !holEl) return;
  try {
    var [hr, er] = await Promise.all([
      fetch('/api/holidays',     { cache:'no-store' }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
      fetch('/api/expiry-dates', { cache:'no-store' }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
    ]);
    var todayIso = istDateISO();
    var expiries = (er && er.expiries) || [];
    var nextExp = null;
    for (var i = 0; i < expiries.length; i++) {
      var d0 = expiries[i].actual || expiries[i].date;
      if (d0 >= todayIso) { nextExp = { date:d0, monthly:expiries[i].monthly, preponed:expiries[i].preponed }; break; }
    }
    if (nextExp) {
      var d = diffDays(nextExp.date);
      var typeLbl = (nextExp.monthly ? 'M' : 'W') + (nextExp.preponed ? '*' : '');
      var when = d === 0 ? 'today' : d + (d === 1 ? ' day' : ' days');
      expEl.classList.remove('empty');
      expEl.textContent = '📅 Next Expiry Date : ' + fmtDMY(nextExp.date) + ' - ' + typeLbl + ' - ' + when;
    } else {
      expEl.classList.add('empty');
      expEl.textContent = '📅 No upcoming expiry';
    }
    var holidays = ((hr && hr.holidays) || []).slice().sort();
    var nextHol = null;
    for (var j = 0; j < holidays.length; j++) {
      if (holidays[j] >= todayIso) { nextHol = holidays[j]; break; }
    }
    if (nextHol) {
      var hd = diffDays(nextHol);
      if (hd <= 1) {
        holEl.classList.remove('empty');
        holEl.textContent = '🎉 Holiday ' + fmtDMY(nextHol) + ' · ' + (hd === 0 ? 'today' : 'tomorrow');
      } else {
        holEl.textContent = ''; // :empty CSS rule hides it
      }
    } else {
      holEl.textContent = '';
    }
  } catch(_){}
}
loadSettingsSchedulePills();
</script>
<!-- Section summary modal -->
<div id="sectionSummaryModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:560px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span id="sectionSummaryTitle" style="font-weight:700;font-size:0.95rem;color:#60a5fa;">Settings Summary</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="summaryCopyBtn" onclick="copySectionSummary()" style="padding:4px 10px;background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.25);border-radius:5px;font-size:0.7rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">COPY</button>
        <button onclick="document.getElementById('sectionSummaryModal').style.display='none'" style="background:none;border:none;color:var(--muted-1,#8ba1c2);font-size:1.2rem;cursor:pointer;">&times;</button>
      </div>
    </div>
    <div id="sectionSummaryBody" style="padding:12px 16px;max-height:70vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#243048 transparent;">
    </div>
  </div>
</div>
<!-- Combined Expiry Calendar + NSE Holidays modal (shared with the Dashboard pill) -->
${expiryHolidayModalHTML()}
<!-- .env viewer modal -->
<div id="envModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:700px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span style="font-weight:700;font-size:0.95rem;color:#60a5fa;">.env Configuration</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="envCopyBtn" onclick="copyEnvTable()" style="padding:4px 10px;background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.25);border-radius:5px;font-size:0.7rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">COPY</button>
        <button onclick="document.getElementById('envModal').style.display='none'" style="background:none;border:none;color:var(--muted-1,#8ba1c2);font-size:1.2rem;cursor:pointer;">&times;</button>
      </div>
    </div>
    <div id="envTableWrap" style="padding:16px 20px;max-height:70vh;overflow-y:auto;">
      <div style="color:var(--muted-1,#8ba1c2);font-size:0.8rem;">Loading...</div>
    </div>
  </div>
</div>
<!-- Backup & Restore modal -->
<div id="backupModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:720px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span style="font-weight:700;font-size:0.95rem;color:#34d399;">📦 Backup &amp; Restore</span>
      <button onclick="document.getElementById('backupModal').style.display='none'" style="background:none;border:none;color:var(--muted-1,#8ba1c2);font-size:1.2rem;cursor:pointer;">&times;</button>
    </div>
    <div style="padding:18px 20px 20px;max-height:74vh;overflow-y:auto;">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:12px;">
        <div style="flex:1;min-width:240px;">
          <div id="backup-status-line" style="font-size:0.7rem;color:#7e93b5;">Loading…</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button onclick="backupCreateNow()" id="backupCreateBtn" style="padding:8px 16px;background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3);border-radius:7px;font-size:0.74rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">↻ Snapshot now</button>
          <a id="backupDownloadLatest" href="#" onclick="return backupDownloadLatest();" style="padding:8px 16px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:7px;font-size:0.74rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;text-decoration:none;">⬇ Download latest</a>
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.72rem;">
          <thead><tr style="text-align:left;color:#5a80a8;">
            <th style="padding:6px 8px;">Date</th><th style="padding:6px 8px;">Size</th>
            <th style="padding:6px 8px;">Status</th><th style="padding:6px 8px;text-align:right;">Download</th>
          </tr></thead>
          <tbody id="backupListBody"><tr><td colspan="4" style="padding:10px 8px;color:var(--muted-2,#6d85a8);">Loading…</td></tr></tbody>
        </table>
      </div>
      <details style="margin-top:12px;">
        <summary style="cursor:pointer;font-size:0.72rem;color:#7e93b5;font-weight:700;">How to restore on a fresh EC2 box</summary>
        <pre style="margin-top:8px;background:#0a1426;border:1px solid #14233c;border-radius:8px;padding:12px;font-size:0.68rem;color:#aac4ea;overflow-x:auto;white-space:pre-wrap;"># copy the downloaded archive to the new instance, then extract each part to its home:
tar xzf backup-YYYY-MM-DD.tar.gz -C ~        trading-data   # → ~/trading-data
tar xzf backup-YYYY-MM-DD.tar.gz -C &lt;repo&gt;    data/ticks     # → &lt;repo&gt;/data/ticks
# restart the app:
pm2 startOrRestart ecosystem.config.js --update-env</pre>
      </details>
      <!-- Secrets bundle — deliberately outside the snapshot / Drive push -->
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid #1a2640;">
        <div style="font-size:0.78rem;font-weight:700;color:#c084fc;margin-bottom:6px;">🔑 Secrets (.env + certs)</div>
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;">
          <div style="flex:1;min-width:240px;font-size:0.68rem;color:#7e93b5;line-height:1.5;">
            Never in the snapshot, never sent to Drive. A new server won't start without them —
            keep this file somewhere private.
          </div>
          <button onclick="backupDownloadSecrets()" id="backupSecretsBtn" style="padding:8px 16px;background:rgba(192,132,252,0.15);color:#c084fc;border:1px solid rgba(192,132,252,0.3);border-radius:7px;font-size:0.74rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">🔑 Download .env + certs</button>
        </div>
        <details style="margin-top:10px;">
          <summary style="cursor:pointer;font-size:0.72rem;color:#7e93b5;font-weight:700;">How to restore secrets on a fresh EC2 box</summary>
          <pre style="margin-top:8px;background:#0a1426;border:1px solid #14233c;border-radius:8px;padding:12px;font-size:0.68rem;color:#aac4ea;overflow-x:auto;white-space:pre-wrap;"># unpack inside the cloned repo (restores .env and certs/ with their file modes):
tar xzf secrets-YYYY-MM-DD.tar.gz -C &lt;repo&gt;
# then the data snapshot, then start:
pm2 startOrRestart ecosystem.config.js --update-env</pre>
        </details>
      </div>

      <!-- Google Drive off-site copy -->
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid #1a2640;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
          <span style="font-size:0.78rem;font-weight:700;color:#60a5fa;">☁ Google Drive (off-site copy)</span>
          <span id="gdrive-pill" style="font-size:0.62rem;font-weight:700;padding:2px 8px;border-radius:999px;background:rgba(90,108,138,0.18);color:#7e93b5;">…</span>
        </div>
        <!-- error strip: survives page refresh, shows failures from the automatic daily push too -->
        <div id="gdrive-error" style="display:none;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);border-radius:8px;padding:9px 12px;margin-bottom:10px;font-size:0.68rem;color:#fca5a5;line-height:1.5;position:relative;">
          <span id="gdrive-error-text"></span>
          <button onclick="gdriveDismissError()" title="Dismiss" style="position:absolute;top:6px;right:8px;background:none;border:none;color:#fca5a5;font-size:0.9rem;line-height:1;cursor:pointer;">&times;</button>
        </div>

        <div id="gdrive-main" style="font-size:0.7rem;color:#9db4d6;line-height:1.6;margin-bottom:10px;">Loading…</div>

        <!-- device-code panel, shown only while a connect is in progress -->
        <div id="gdrive-device" style="display:none;background:#0a1426;border:1px solid #14233c;border-radius:8px;padding:12px;margin-bottom:10px;">
          <div style="font-size:0.7rem;color:#9db4d6;line-height:1.6;">
            1. Open <a id="gdrive-verify-url" href="https://www.google.com/device" target="_blank" rel="noopener" style="color:#60a5fa;font-weight:700;">google.com/device</a>
            on any device &nbsp;·&nbsp; 2. enter this code &nbsp;·&nbsp; 3. approve access.
          </div>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px;">
            <code id="gdrive-user-code" style="font-size:1.15rem;font-weight:700;letter-spacing:3px;color:#34d399;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.3);border-radius:7px;padding:6px 14px;">----</code>
            <span id="gdrive-device-note" style="font-size:0.68rem;color:#fbbf24;">Waiting for you to approve…</span>
            <button onclick="gdriveCancelConnect()" style="padding:6px 12px;background:rgba(148,163,184,0.12);color:#94a3b8;border:1px solid rgba(148,163,184,0.3);border-radius:7px;font-size:0.7rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">Cancel</button>
          </div>
        </div>

        <div id="gdrive-actions" style="display:flex;gap:8px;flex-wrap:wrap;"></div>

        <details id="gdrive-setup" style="margin-top:12px;">
          <summary style="cursor:pointer;font-size:0.7rem;color:#7e93b5;font-weight:700;">One-time Google setup (needed once, ~3 min)</summary>
          <div style="font-size:0.68rem;color:#9db4d6;line-height:1.7;margin-top:8px;">
            1. Open <a href="https://console.cloud.google.com/" target="_blank" rel="noopener" style="color:#60a5fa;">console.cloud.google.com</a> → create a project.<br/>
            2. <b>APIs &amp; Services → Library</b> → enable <b>Google Drive API</b>.<br/>
            3. <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener" style="color:#60a5fa;">Google Auth Platform</a> → <b>Get started</b> → fill in app name + your email → audience <b>External</b> → create.<br/>
            4. <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener" style="color:#60a5fa;">Google Auth Platform → <b>Audience</b></a> → under <i>Publishing status</i> click <b style="color:#fbbf24;">PUBLISH APP</b> → Confirm (leaving it in <i>Testing</i> makes the connection expire every 7 days).<br/>
            5. <a href="https://console.cloud.google.com/auth/scopes" target="_blank" rel="noopener" style="color:#60a5fa;">Google Auth Platform → <b>Data Access</b></a> → <b>Add or remove scopes</b> → tick <b style="color:#fbbf24;">.../auth/drive.file</b> → Update → <b>Save</b>. <span style="color:var(--muted-2,#6d85a8);">Skipping this is what causes “insufficient authentication scopes” later — Google only grants scopes listed here.</span><br/>
            6. <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener" style="color:#60a5fa;">Google Auth Platform → <b>Clients</b></a> → <b>Create client</b> → application type <b style="color:#fbbf24;">TVs and Limited Input devices</b>.<br/>
            7. Paste the Client ID + Secret below and save.<br/>
            <span style="color:var(--muted-2,#6d85a8);">Note: the old <i>APIs &amp; Services → OAuth consent screen</i> page is now <b>Google Auth Platform</b> in the left menu — same thing, new name.</span>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px;">
            <input type="text" id="gdriveClientId" placeholder="xxxx.apps.googleusercontent.com" autocomplete="off" style="flex:1;min-width:220px;padding:7px 10px;background:#0a1426;border:1px solid #1a2640;border-radius:7px;color:#cfe0f8;font-size:0.7rem;font-family:'IBM Plex Mono',monospace;"/>
            <input type="password" id="gdriveClientSecret" placeholder="Client secret" autocomplete="new-password" style="flex:1;min-width:160px;padding:7px 10px;background:#0a1426;border:1px solid #1a2640;border-radius:7px;color:#cfe0f8;font-size:0.7rem;font-family:'IBM Plex Mono',monospace;"/>
            <button onclick="gdriveSaveCreds()" id="gdriveSaveBtn" style="padding:7px 14px;background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3);border-radius:7px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">Save</button>
          </div>
          <div style="font-size:0.64rem;color:var(--muted-2,#6d85a8);margin-top:6px;">Stored server-side in ~/trading-data/.google_drive.json (never in .env, never inside a backup archive).</div>
        </details>
      </div>

      <div style="margin-top:16px;padding-top:14px;border-top:1px solid #1a2640;">
        <div style="font-size:0.78rem;font-weight:700;color:#f59e0b;margin-bottom:6px;">⟲ Restore from a backup file</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <input type="file" id="backupRestoreFile" accept=".gz,.tgz,application/gzip" style="font-size:0.7rem;color:#9db4d6;flex:1;min-width:200px;"/>
          <button onclick="backupRestore()" id="backupRestoreBtn" style="padding:8px 16px;background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3);border-radius:7px;font-size:0.74rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;">⟲ Restore</button>
        </div>
      </div>
    </div>
  </div>
</div>
<!-- Bulk Edit modal -->
<div id="bulkModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:760px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span style="font-weight:700;font-size:0.95rem;color:#f59e0b;">📋 Bulk Edit .env <span style="font-size:0.65rem;color:var(--dim);font-weight:500;letter-spacing:0;margin-left:6px;">paste → save → restart</span></span>
      <button onclick="document.getElementById('bulkModal').style.display='none'" style="background:none;border:none;color:var(--muted-1,#8ba1c2);font-size:1.2rem;cursor:pointer;">&times;</button>
    </div>
    <div class="bulk-section" style="padding:18px 20px 20px;">
      <div class="bulk-hint">
        Paste <strong>KEY=VALUE</strong> pairs (one per line) to add/update. Prefix a line with <strong>-</strong> (e.g. <code>-OLD_KEY</code>) to <strong>remove</strong> that key from .env.<br/>
        Supports <code>KEY=VALUE</code>, <code>KEY: VALUE</code>, quoted values, and <code>#</code> comment lines.
        Sensitive keys (SECRET/TOKEN/ACCESS) are ignored for both updates and deletes. Applies everything and restarts the server.
      </div>
      <textarea id="bulkPasteBox" spellcheck="false" oninput="previewBulkPaste()" placeholder="# Paste your config here&#10;BB_RSI_RSI_CE_THRESHOLD=55&#10;VIX_MAX_ENTRY=25&#10;&#10;# Delete dead keys with a leading dash:&#10;-BB_RSI_ADX_ENABLED&#10;-BB_RSI_RSI_CE_MIN"></textarea>
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
      <div style="display:flex;gap:10px;align-items:center;">
        <a href="/monitor" style="padding:4px 10px;background:rgba(168,139,250,0.12);color:#a78bfa;border:1px solid rgba(168,139,250,0.25);border-radius:5px;font-size:0.7rem;font-weight:700;text-decoration:none;font-family:'IBM Plex Mono',monospace;">📈 Open full Monitor →</a>
        <button onclick="document.getElementById('healthModal').style.display='none'" style="background:none;border:none;color:var(--muted-1,#8ba1c2);font-size:1.2rem;cursor:pointer;">&times;</button>
      </div>
    </div>
    <div id="healthBody" style="padding:20px;">
      <div style="color:var(--muted-1,#8ba1c2);font-size:0.8rem;text-align:center;">Checking...</div>
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

// ── GET /settings/audit/data — JSON stream of audit entries (newest first) ──
router.get("/audit/data", (req, res) => {
  const opts = {
    limit:  Math.min(parseInt(req.query.limit, 10) || 500, 5000),
    since:  req.query.since || null,
    key:    req.query.key   || null,
    action: req.query.action || null,
  };
  let entries = settingsAudit.readAuditLog(opts);
  if (req.query.source) entries = entries.filter(e => (e.source || "").includes(req.query.source));
  res.json({ count: entries.length, entries });
});

// ── GET /settings/audit — HTML view of the audit log ────────────────────────
router.get("/audit", (req, res) => {
  const appSecret = process.env.API_SECRET;
  if (appSecret && req.query.secret !== appSecret) {
    return res.status(401).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/></head>
      <body style="font-family:monospace;background:#040c18;color:#c8d8f0;padding:40px;">
      <h2>Audit log — auth required</h2>
      <form onsubmit="event.preventDefault();window.location='/settings/audit?secret='+encodeURIComponent(this.s.value);">
        <input name="s" type="password" placeholder="App Secret" autofocus style="padding:10px;background:#0a1528;border:1px solid #1e3a5a;border-radius:6px;color:#c8d8f0;font-family:inherit;"/>
        <button style="padding:10px 20px;background:#1e40af;color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:inherit;">Unlock</button>
      </form></body></html>`);
  }

  const filterKey    = (req.query.key    || "").trim();
  const filterAction = (req.query.action || "").trim();
  const filterSource = (req.query.source || "").trim();
  const limit        = Math.min(parseInt(req.query.limit, 10) || 500, 5000);

  let entries = settingsAudit.readAuditLog({
    limit,
    key:    filterKey    || null,
    action: filterAction || null,
  });
  if (filterSource) entries = entries.filter(e => (e.source || "").includes(filterSource));

  // Group by timestamp+source for display
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  const escapeHtml = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const fmtTs = ts => {
    try {
      const d = new Date(ts);
      return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }).replace(",", "");
    } catch (_) { return ts; }
  };

  const actionColor = a => ({ add: "#10b981", update: "#f59e0b", delete: "#ef4444" }[a] || "#94a3b8");
  const sourceLabel = s => {
    if (!s) return "—";
    if (s.startsWith("git:")) return `<span style="color:#60a5fa;" title="reconstructed from commit">git ${escapeHtml(s.slice(4))}</span>`;
    if (s === "ui") return `<span style="color:#10b981;">ui</span>`;
    return escapeHtml(s);
  };

  const fmtVal = v => {
    if (v === null || v === undefined) return `<span style="color:var(--muted-1,#8ba1c2);">∅</span>`;
    const s = String(v);
    if (s.length > 80) return `<span title="${escapeHtml(s)}">${escapeHtml(s.slice(0, 80))}…</span>`;
    return escapeHtml(s);
  };

  const rows = entries.map(e => `
    <tr>
      <td style="white-space:nowrap;color:#94a3b8;font-size:0.72rem;">${escapeHtml(fmtTs(e.ts))}</td>
      <td><span style="color:${actionColor(e.action)};font-weight:600;text-transform:uppercase;font-size:0.7rem;">${escapeHtml(e.action || "")}</span></td>
      <td style="font-weight:600;color:#e2e8f0;"><a href="/settings/audit?secret=${encodeURIComponent(req.query.secret || "")}&key=${encodeURIComponent(e.key)}" style="color:inherit;text-decoration:none;border-bottom:1px dotted #4a6080;">${escapeHtml(e.key)}</a></td>
      <td style="color:#fca5a5;font-family:'IBM Plex Mono',monospace;">${fmtVal(e.from)}</td>
      <td style="color:#86efac;font-family:'IBM Plex Mono',monospace;">${fmtVal(e.to)}</td>
      <td>${sourceLabel(e.source)}</td>
      <td style="color:var(--muted-1,#8ba1c2);font-size:0.7rem;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(e.commit_subject || e.ua || "")}">${escapeHtml(e.commit_subject || e.ua || "")}</td>
    </tr>
  `).join("");

  // Action counts for the badge bar (over the filtered set)
  const counts = entries.reduce((m, e) => { m[e.action] = (m[e.action] || 0) + 1; return m; }, {});
  const totalLine = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}` +
    (counts.update ? ` · <span style="color:#f59e0b;">${counts.update} updated</span>` : "") +
    (counts.add ? ` · <span style="color:#10b981;">${counts.add} added</span>` : "") +
    (counts.delete ? ` · <span style="color:#ef4444;">${counts.delete} deleted</span>` : "");

  const secret = req.query.secret || "";

  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Settings Audit Log</title>
${faviconLink()}
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'IBM Plex Mono',monospace;background:#040c18;color:#c8d8f0;display:flex;min-height:100vh;}
${sidebarCSS()}
.audit-main{flex:1;padding:24px 32px;overflow-x:auto;}
.audit-header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:18px;flex-wrap:wrap;gap:12px;}
.audit-header h1{font-size:1.05rem;color:#60a5fa;font-weight:600;}
.audit-header .sub{font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-top:4px;}
.filter-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.filter-bar input,.filter-bar select{padding:6px 10px;background:#0a1528;border:1px solid #1e3a5a;border-radius:6px;color:#c8d8f0;font-family:inherit;font-size:0.74rem;}
.filter-bar input:focus,.filter-bar select:focus{outline:none;border-color:#3b82f6;}
.filter-bar button{padding:6px 14px;background:#1e40af;color:#fff;border:none;border-radius:6px;font-family:inherit;font-size:0.74rem;cursor:pointer;font-weight:600;}
.filter-bar button:hover{background:#2563eb;}
.filter-bar a.clear{color:#94a3b8;font-size:0.7rem;text-decoration:none;border-bottom:1px dotted #4a6080;}
.summary{font-size:0.74rem;color:#94a3b8;margin-bottom:12px;}
table{width:100%;border-collapse:collapse;background:#07111f;border:1px solid #0e1e36;border-radius:8px;overflow:hidden;}
th{padding:10px 12px;text-align:left;font-size:0.7rem;color:#60a5fa;font-weight:600;background:#0a1528;border-bottom:1px solid #1e3a5a;text-transform:uppercase;letter-spacing:0.5px;}
td{padding:8px 12px;font-size:0.78rem;border-bottom:1px solid #0e1e36;vertical-align:top;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:#0a1528;}
.empty{text-align:center;padding:40px;color:var(--muted-1,#8ba1c2);font-size:0.8rem;}
</style></head><body>
<div class="app-shell">${buildSidebar('settings', liveActive, false)}
<div class="audit-main">
  <div class="audit-header">
    <div>
      <h1>⚙️ Settings Audit Log</h1>
      <div class="sub">Every change to .env values — UI saves and historical commits.</div>
    </div>
    <form class="filter-bar" method="get" action="/settings/audit">
      <input type="hidden" name="secret" value="${escapeHtml(secret)}"/>
      <input type="text" name="key" placeholder="key contains…" value="${escapeHtml(filterKey)}" style="width:180px;"/>
      <select name="action">
        <option value="">all actions</option>
        <option value="add"    ${filterAction==='add'?'selected':''}>add</option>
        <option value="update" ${filterAction==='update'?'selected':''}>update</option>
        <option value="delete" ${filterAction==='delete'?'selected':''}>delete</option>
      </select>
      <select name="source">
        <option value="">all sources</option>
        <option value="ui"  ${filterSource==='ui'?'selected':''}>ui only</option>
        <option value="git" ${filterSource==='git'?'selected':''}>git only</option>
      </select>
      <input type="number" name="limit" value="${limit}" min="10" max="5000" style="width:80px;" title="row limit"/>
      <button type="submit">filter</button>
      ${(filterKey||filterAction||filterSource) ? `<a class="clear" href="/settings/audit?secret=${encodeURIComponent(secret)}">clear</a>` : ''}
      <a class="clear" href="/settings?secret=${encodeURIComponent(secret)}" style="margin-left:12px;">← back to settings</a>
    </form>
  </div>
  <div class="summary">${totalLine}</div>
  ${entries.length === 0 ? `<div class="empty">No audit entries match these filters.</div>` : `
  <table>
    <thead><tr>
      <th>Timestamp (IST)</th><th>Action</th><th>Key</th><th>From</th><th>To</th><th>Source</th><th>Note</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</div></div>
</body></html>`);
});

/**
 * Apply a settings change from server-side code rather than the Settings page.
 *
 * Deliberately goes through the SAME persistChanges() path an operator's save
 * uses, so an automatic change is exactly as traceable as a hand-typed one: it
 * updates process.env (Settings and the Dashboard expiry strip both read from
 * there, so both reflect it immediately), rewrites .env so it survives a PM2
 * restart, writes the settings-audit row, and appends the per-mode JSONL
 * settings snapshot with `note`.
 *
 * Currently used only by the expiry-health roll. Hidden keys are refused, and
 * there is no delete path — automation may set values, never remove them.
 *
 * @param {Record<string,string>} updates
 * @param {string} note  audit/checkpoint note explaining WHY it changed
 */
function applyUpdates(updates, note) {
  const hiddenSet = new Set(HIDDEN_KEYS);
  const cleaned = {};
  Object.entries(updates || {}).forEach(([k, v]) => {
    const key = String(k).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
    if (key && !hiddenSet.has(key)) cleaned[key] = String(v).trim();
  });
  if (Object.keys(cleaned).length === 0) return { success: false, error: "No valid updates" };
  return persistChanges(cleaned, [], note, null);
}

router.applyUpdates = applyUpdates;

module.exports = router;

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
    fields: [
      { key: "EMA_RSI_ST_LIVE_ENABLED", label: "EMA_RSI_ST Live Orders", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live orders via Zerodha" },
      { key: "EMA_RSI_ST_LIVE_DRY_RUN", label: "EMA_RSI_ST Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep EMA_RSI_ST in DRY-RUN (log only, no real order) even when the global Live Harness DRY-RUN is OFF. Lets other strategies trade real money while EMA_RSI_ST stays simulated. Default off.", default: "false" },
      { key: "TRADE_RESOLUTION", label: "Candle Resolution (min)", type: "select", options: ["3", "5", "15"], effect: EFFECT.SESSION, desc: "EMA_RSI_ST candle timeframe (3 / 5 / 15-min). BB_RSI & PA have their own resolution settings.", default: "5" },
      { key: "EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE", label: "EMA_RSI_ST Option Expiry (override)", type: "date", effect: EFFECT.INSTANT, desc: "EMA_RSI_ST-only override. When set, overrides the common Option Expiry. Use to keep EMA_RSI_ST on next-week expiry while bb_rsi/PA trade current expiry. Leave blank to fall back to common.", default: "" },
      { key: "EMA_RSI_ST_OPTION_EXPIRY_TYPE", label: "EMA_RSI_ST Expiry Type", type: "select", options: ["", "weekly", "monthly"], effect: EFFECT.INSTANT, desc: "EMA_RSI_ST-only expiry type for the override above. Weekly = Tuesday expiry, Monthly = last Thursday/preponed monthly. Leave blank to fall back to the common Expiry Type.", default: "" },
      { key: "TRADE_EXPIRY_DAY_ONLY", label: "Trade Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only allow entries on NIFTY weekly expiry day (Tuesday, or Monday if Tuesday is holiday)", default: "false" },
      { key: "TRADE_ENTRY_START", label: "Entry Start Time", type: "time", effect: EFFECT.SESSION, desc: "Earliest time for new trade entries (HH:MM IST)", default: "10:30" },
      { key: "TRADE_ENTRY_END", label: "Entry End Time", type: "time", effect: EFFECT.SESSION, desc: "No new entries after this time (HH:MM IST)", default: "14:00" },
      { key: "EMA_RSI_ST_EOD_EXIT_TIME", label: "Exit Before Day Close", type: "time", effect: EFFECT.SESSION, desc: "Square off any open EMA_RSI_ST position at/after this IST time — ahead of the market-close auto-stop (TRADE_STOP_TIME). Default 14:30.", default: "14:30" },
      { key: "VIX_FILTER_ENABLED", label: "VIX Filter (EMA_RSI_ST)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block EMA_RSI_ST entries when VIX is high (scope: EMA_RSI_ST only)" },
      { key: "VIX_MAX_ENTRY", label: "EMA_RSI_ST VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "EMA_RSI_ST only: block entries above this VIX", default: "20" },
      { key: "MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 50000, step: 500, effect: EFFECT.SESSION, desc: "Kill-switch: stop trading after this much loss (also latched on 3 consecutive losses)", default: "3000" },
      { key: "MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Hard cap on entries per session — prevents chop-day overtrading", default: "5" },
      // ── Entry rule (all 3 must be true): EMA alignment + RSI gate + SuperTrend side ──
      { key: "EMA_RSI_ST_EMA_FAST", label: "EMA Fast/Mid Period", type: "number", min: 5, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "Fast EMA (on close). 2-EMA mode: CE needs EMA-fast ABOVE EMA-slow; PE below. Triple-stack: this is the MID EMA. Classic = 20.", default: "20" },
      { key: "EMA_RSI_ST_EMA_SLOW", label: "EMA Slow Period", type: "number", min: 20, max: 200, step: 1, effect: EFFECT.INSTANT, desc: "Slow EMA (on close). The EMA-fast vs EMA-slow alignment is the directional gate. Classic = 50.", default: "50" },
      { key: "EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED", label: "Triple-Stack EMA (9>20>50)", type: "toggle", effect: EFFECT.INSTANT, desc: "Stricter EMA gate. OFF = 2-EMA cross (EMA-fast vs EMA-slow). ON = require EMA-fastest > EMA-mid > EMA-slow (CE) / reverse (PE) — the fast EMA must confirm too. Cuts marginal cross-over chop entries (skip logs show it blocks flat-EMA bars that the 2-EMA gate would take).", default: "false" },
      { key: "EMA_RSI_ST_EMA_FASTEST", label: "EMA Fastest Period", type: "number", min: 5, max: 20, step: 1, effect: EFFECT.INSTANT, desc: "Fastest EMA in the 9>20>50 stack (on close). Only used when Triple-Stack EMA is ON. Classic = 9.", default: "9" },
      { key: "EMA_RSI_ST_CLOSE_BEYOND_EMA_ENABLED", label: "Close Beyond Base EMA", type: "toggle", effect: EFFECT.INSTANT, desc: "Signal candle must CLOSE on the trade side of the base EMA — base = EMA-fastest (9) when Triple-Stack is ON, else EMA-fast (20). CE: close ABOVE it; PE: close BELOW it. The EMA-stack/cross gate only checks EMA ordering — this stops buying CE into dips that close BELOW the fast EMA while the lines stay stacked from an earlier move (the false-breakout chop that bleeds prev-candle stops). Uses the configured EMA periods. Default ON.", default: "true" },
      { key: "RSI_CE_MIN", label: "RSI CE Min (>)", type: "number", min: 45, max: 65, step: 1, effect: EFFECT.INSTANT, desc: "CE entry: RSI(14) must be ABOVE this (bullish momentum floor)", default: "52" },
      { key: "RSI_CE_MAX", label: "RSI CE Max (< overbought)", type: "number", min: 60, max: 90, step: 1, effect: EFFECT.INSTANT, desc: "CE entry blocked when RSI is at/above this (overbought — don't chase exhausted up-moves)", default: "70" },
      { key: "RSI_PE_MAX", label: "RSI PE Max (<)", type: "number", min: 35, max: 55, step: 1, effect: EFFECT.INSTANT, desc: "PE entry: RSI(14) must be BELOW this (bearish momentum cap)", default: "48" },
      { key: "RSI_PE_MIN", label: "RSI PE Min (> oversold)", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "PE entry blocked when RSI is at/below this (oversold — don't chase exhausted down-moves)", default: "30" },
      // ── Trend confirmation: SuperTrend (the only directional source) ──
      { key: "EMA_RSI_ST_CONFIRM_CANDLE_ENABLED", label: "Confirmation Candle (cross & close)", type: "toggle", effect: EFFECT.INSTANT, desc: "Wait for a 2nd candle to confirm before entering. ON (default): a fully-closed candle must meet all entry rules (the signal candle), THEN the very next candle must cross that signal candle's close (CE above / PE below) — entry fires intra-bar on the cross. OFF: enter as soon as the live bar meets the rules (legacy intra-candle). Filters one-candle false breakouts.", default: "true" },
      { key: "EMA_RSI_ST_SUPERTREND_PERIOD", label: "SuperTrend ATR Period", type: "number", min: 5, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "ATR lookback for SuperTrend — the entry directional gate (classic = 10).", default: "10" },
      { key: "EMA_RSI_ST_SUPERTREND_MULT", label: "SuperTrend Multiplier", type: "number", min: 1, max: 6, step: 0.5, effect: EFFECT.INSTANT, desc: "ATR multiplier for SuperTrend band width (classic = 3).", default: "3" },
      // ── Stops & exits ──
      { key: "OPT_STOP_PCT", label: "Option Stop %", type: "number", min: 0.05, max: 0.50, step: 0.05, effect: EFFECT.SESSION, desc: "Exit if the option premium drops this fraction below entry premium (e.g. 0.25 = 25%)", default: "0.25" },
      { key: "EMA_RSI_ST_STOP_LOSS_PTS", label: "Stop Loss (pts)", type: "number", min: 0, max: 200, step: 5, effect: EFFECT.INSTANT, desc: "Per-trade catastrophic loss cap — exit if spot moves this many points against entry. Checked before the structural/trail SL, so it caps deep adverse excursions when the prevHigh/prevLow stop sits wider than the cap. Points-based (mirrors BB_RSI's). 0 = disabled.", default: "25" },
      { key: "EMA_RSI_ST_MAX_CONSEC_LOSSES", label: "Chop Guard (consec losses)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Choppy-day guard — after this many consecutive losing trades in a session, halt new EMA_RSI_ST entries for the rest of the day (any winning trade resets the streak). Sits out range days that bleed small stops instead of repeatedly re-entering. 0 = disabled (default).", default: "0" },
      { key: "EMA_RSI_ST_NEG_CANDLE_LIMIT", label: "Negative-Candle Stop (candles)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Asymmetric loss-cut — if a trade is still in the RED (option premium below entry) at the close of this many candles, square it off. Winners keep riding the EMA trail; losers don't bleed across the chop. 0 = disabled. Default 2.", default: "2" },
      { key: "EMA_RSI_ST_CANDLE_TRAIL_ENABLED", label: "Candle Trail", type: "toggle", effect: EFFECT.INSTANT, desc: "Add an N-bar candle trail on top of the EMA21 SL. Each candle close the stop is set to whichever is TIGHTER (closer to price) — the EMA21 line OR the N-bar low (CE) / high (PE). Banks more of a winner; never loosens the stop. Default ON.", default: "true" },
      { key: "EMA_RSI_ST_CANDLE_TRAIL_BARS", label: "Candle Trail (candles)", type: "number", min: 1, max: 5, step: 1, effect: EFFECT.INSTANT, desc: "How many candles to look back for the candle-trail level: lowest low (CE) / highest high (PE) of the last N candles. 1 = tightest (just the prior candle); higher = looser (gives winners room, fewer chop stop-outs). Only used when Candle Trail is ON.", default: "3" },
      { key: "EMA_RSI_ST_SL_PAUSE_CANDLES", label: "Same-Side SL Cooldown (candles)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.SESSION, desc: "After an SL / option-stop hit on a side, block new entries on THAT side for this many candles (0 = off)", default: "2" },
      { key: "EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED", label: "Opposite-Side Cooldown", type: "toggle", effect: EFFECT.SESSION, desc: "When ON, after any non-flip exit (SL hit, trail SL, option-stop, EMA touch-back) block entries on the OPPOSITE side for N candles. Prevents whipsaw flips on chop. Opposite-signal / EOD / manual exits do not trigger the cooldown.", default: "true" },
      { key: "EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES", label: "Opposite-Side Cooldown (candles)", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Cooldown duration in candles (multiplied by TRADE_RESOLUTION to get minutes — e.g. 3 candles × 5-min = 15 min). Only used when Opposite-Side Cooldown is ON.", default: "2" },
    ],
  },
  {
    section: "BB_RSI STRATEGY (BB+SuperTrend+RSI) — Fyers",
    icon: "⚡",
    fields: [
      { key: "BB_RSI_ENABLED", label: "BB_RSI Live Orders", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable live bb_rsi orders via Fyers", default: "false" },
      { key: "BB_RSI_EXPIRY_DAY_ONLY", label: "BB_RSI Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only allow bb_rsi entries on NIFTY weekly expiry day (Tuesday, or Monday if Tuesday is holiday)", default: "false" },
      { key: "BB_RSI_VIX_ENABLED", label: "VIX Filter (BB_RSI)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block bb_rsi entries when VIX is high (scope: BB_RSI only)", default: "false" },
      { key: "BB_RSI_VIX_MAX_ENTRY", label: "BB_RSI VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "BB_RSI only: block entries above this VIX", default: "20" },
      { key: "BB_RSI_VIX_STRONG_ONLY", label: "BB_RSI VIX Strong Only", type: "number", min: 8, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "BB_RSI only: above this VIX allow only STRONG signals (RSI beyond threshold by +5)", default: "16" },
      { key: "BB_RSI_ENTRY_START", label: "Entry Start Time", type: "time", effect: EFFECT.SESSION, desc: "Earliest time for new bb_rsi entries (HH:MM IST)", default: "09:21" },
      { key: "BB_RSI_ENTRY_END", label: "Entry End Time", type: "time", effect: EFFECT.SESSION, desc: "No new bb_rsi entries after this time (HH:MM IST)", default: "14:30" },
      { key: "BB_RSI_RESOLUTION", label: "Candle (min)", type: "select", options: ["3", "5"], effect: EFFECT.SESSION, desc: "BB_RSI candle resolution (3 or 5 min)", default: "5" },
      // ── Bollinger Bands ──
      { key: "BB_RSI_BB_PERIOD", label: "BB Period", type: "number", min: 10, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Bollinger Band SMA period", default: "20" },
      { key: "BB_RSI_BB_STDDEV", label: "BB Std Dev", type: "number", min: 0.5, max: 3.0, step: 0.1, effect: EFFECT.SESSION, desc: "Bollinger Band standard deviation", default: "1" },
      // ── RSI ──
      { key: "BB_RSI_RSI_PERIOD", label: "RSI Period", type: "number", min: 7, max: 21, step: 1, effect: EFFECT.SESSION, desc: "RSI calculation period", default: "14" },
      { key: "BB_RSI_RSI_CE_THRESHOLD", label: "RSI CE Entry (>)", type: "number", min: 50, max: 90, step: 1, effect: EFFECT.SESSION, desc: "Take CE entry only when RSI is above this (momentum confirmation)", default: "70" },
      { key: "BB_RSI_RSI_PE_THRESHOLD", label: "RSI PE Entry (<)", type: "number", min: 10, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Take PE entry only when RSI is below this (momentum confirmation)", default: "40" },
      { key: "BB_RSI_RSI_TURNING", label: "RSI Turning Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Require RSI momentum to confirm direction (CE: RSI not falling; PE: RSI not rising). Skips fading-momentum entries.", default: "false" },
      { key: "BB_RSI_CONFIRM_CANDLE_ENABLED", label: "Confirmation Candle (cross & close)", type: "toggle", effect: EFFECT.INSTANT, desc: "Wait for a 2nd candle to confirm before entering. ON (default): a fully-closed candle must meet all entry rules (the signal candle), THEN the very next candle must cross that signal candle's close (CE above / PE below) — entry fires intra-bar on the cross. OFF: enter at the signal candle's close (legacy). Filters one-candle false breakouts.", default: "true" },
      { key: "BB_RSI_CONFIRM_OUTSIDE_BAND", label: "Confirmation must close outside band", type: "toggle", effect: EFFECT.INSTANT, desc: "Stricter confirmation (needs Confirmation Candle ON). ON (default): the confirmation candle must CLOSE beyond the signal candle's close AND close outside the Bollinger band — entry fires at that close — so the entry candle is genuinely outside the band. Blocks intra-bar pokes that close back inside the band (failed breakouts that otherwise sit visibly inside the band). OFF: enter intra-bar on the first cross of the signal candle's close (legacy).", default: "true" },
      // ── SuperTrend (directional confirmation + initial SL value + flip exit) ──
      { key: "BB_RSI_MAX_ENTRY_SL_PTS", label: "Max Entry SL (pts)", type: "number", min: 0, max: 200, step: 5, effect: EFFECT.SESSION, desc: "Skip entries where the SuperTrend line sits farther than this from close (a freshly-flipped line can be 100s of pts away → huge risk). 0 = no filter.", default: "50" },
      { key: "BB_RSI_SUPERTREND_PERIOD", label: "SuperTrend ATR Period", type: "number", min: 5, max: 30, step: 1, effect: EFFECT.SESSION, desc: "ATR lookback for SuperTrend — the directional entry gate, entry SL line and flip exit (classic = 10).", default: "10" },
      { key: "BB_RSI_SUPERTREND_MULT", label: "SuperTrend Multiplier", type: "number", min: 1, max: 6, step: 0.5, effect: EFFECT.SESSION, desc: "ATR multiplier for SuperTrend band width (classic = 3).", default: "3" },
      // ── ADX trend filter (sit out choppy/ranging sessions) ──
      { key: "BB_RSI_ADX_ENABLED", label: "ADX Trend Filter", type: "toggle", effect: EFFECT.SESSION, desc: "Only trade when the market is trending — block ALL entries when ADX(14) is below the threshold. The strategy wins in trends and bleeds in chop; this sits out ranging days.", default: "false" },
      { key: "BB_RSI_ADX_MIN", label: "ADX Min (trend floor)", type: "number", min: 0, max: 50, step: 1, effect: EFFECT.SESSION, desc: "Minimum ADX(14) to allow entries when the trend filter is on. Higher = stricter (only strong trends). Typical 20–25. Ignored when the filter is off.", default: "20" },
      // ── Profit lock (bank small bb_rsi profits) + hard stop (catastrophic loss cap) ──
      { key: "BB_RSI_PROFIT_LOCK_TRIGGER_PTS", label: "Profit Lock Trigger (pts)", type: "number", min: 0, max: 300, step: 5, effect: EFFECT.SESSION, desc: "Arm the profit lock once the favourable spot move (points) reaches this. Points-based — works even when option P&L is unavailable. 0 = disabled.", default: "25" },
      { key: "BB_RSI_PROFIT_LOCK_PCT", label: "Profit Lock % of Peak", type: "number", min: 10, max: 95, step: 5, effect: EFFECT.SESSION, desc: "Once armed, exit when the favourable move falls below this % of its peak (ratchets up). e.g. 50 → peak 100pts locks 50pts, peak 200pts locks 100pts.", default: "50" },
      { key: "BB_RSI_STOP_LOSS_PTS", label: "Stop Loss (pts)", type: "number", min: 0, max: 200, step: 5, effect: EFFECT.SESSION, desc: "Catastrophic loss cap — exit if the trade moves this many spot points against entry. Set WIDE (default 30) so it only clips deep adverse excursions on failed fades, not the normal small scalps. Points-based. 0 = disabled.", default: "30" },
      { key: "BB_RSI_BB_REENTRY_EXIT", label: "BB Re-Entry Exit", type: "toggle", effect: EFFECT.SESSION, desc: "Exit the instant spot crosses back through the Bollinger Band (failed breakout) — runs per-tick (not candle close) so a one-candle V-reversal exits at the band line instead of giving back to the bar close. Cuts loss bleed before the slower SuperTrend flip.", default: "true" },
      { key: "BB_RSI_BB_REENTRY_ARM_PTS", label: "BB Re-Entry Arm (pts)", type: "number", min: 0, max: 100, step: 1, effect: EFFECT.SESSION, desc: "Only arm the BB Re-Entry Exit once the breakout has extended this many points PAST the band. Stops a fresh entry that's sitting right at the band from being knocked out by an immediate noise wick back to it. 0 = arm immediately (no guard).", default: "10" },
      // ── Risk management ──
      // SL & exits are SuperTrend-driven: initial SL = SuperTrend value at entry (no clamp); exit on
      // candle-close SuperTrend flip; the profit lock (above) is the only hard intra-tick exit.
      { key: "BB_RSI_SLIPPAGE_PTS", label: "Slippage (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.SESSION, desc: "Simulated slippage on entry & SL exit (pts added against you)", default: "1.5" },
      { key: "BB_RSI_MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Max bb_rsi entries per day", default: "30" },
      { key: "BB_RSI_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 20000, step: 500, effect: EFFECT.SESSION, desc: "BB_RSI kill-switch", default: "4000" },
      { key: "BB_RSI_SL_PAUSE_CANDLES", label: "SL Pause (candles)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Pause after SL hit (5-min candles)", default: "3" },
      { key: "BB_RSI_CONSEC_SL_EXTRA_PAUSE", label: "Consec SL Extra Pause", type: "number", min: 1, max: 8, step: 1, effect: EFFECT.SESSION, desc: "Extra candles pause per consecutive SL after the 2nd (e.g. 2 = +2 candles on 2nd SL, +4 on 3rd)", default: "2" },
      { key: "BB_RSI_PER_SIDE_PAUSE", label: "Per-Side SL Pause", type: "toggle", effect: EFFECT.SESSION, desc: "When ON, an SL on CE only pauses CE entries (PE still allowed) and vice versa. OFF = legacy global pause.", default: "true" },
    ],
  },
  {
    section: "PRICE ACTION STRATEGY (5-min) — Fyers",
    icon: "📐",
    fields: [
      { key: "PA_ENABLED", label: "PA Live Orders", type: "toggle", effect: EFFECT.INSTANT, desc: "Enable PA live order placement (Fyers). Required to start a PA Live session.", default: "false" },
      { key: "PA_EXPIRY_DAY_ONLY", label: "PA Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only allow PA entries on NIFTY weekly expiry day", default: "false" },
      { key: "PA_VIX_ENABLED", label: "VIX Filter (PA)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block PA entries when VIX is high (scope: PA only)", default: "false" },
      { key: "PA_VIX_MAX_ENTRY", label: "PA VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "PA only: block entries above this VIX", default: "20" },
      { key: "PA_ENTRY_START", label: "Entry Start Time", type: "time", effect: EFFECT.SESSION, desc: "Earliest time for new PA entries (HH:MM IST)", default: "09:20" },
      { key: "PA_ENTRY_END", label: "Entry End Time", type: "time", effect: EFFECT.SESSION, desc: "No new PA entries after this time (HH:MM IST)", default: "14:30" },
      { key: "PA_RESOLUTION", label: "Candle (min)", type: "select", options: ["5", "3"], effect: EFFECT.SESSION, desc: "Price action candle resolution", default: "5" },
      // ── Pattern toggles (the only four entry logics) ──
      { key: "PA_PATTERN_DOUBLE_BOTTOM", label: "Double Bottom (W) → CE", type: "toggle", effect: EFFECT.SESSION, desc: "Bullish reversal — twin equal lows + neckline breakout → CE", default: "true" },
      { key: "PA_PATTERN_DOUBLE_TOP",    label: "Double Top (M) → PE",    type: "toggle", effect: EFFECT.SESSION, desc: "Bearish reversal — twin equal highs + neckline breakdown → PE", default: "true" },
      { key: "PA_PATTERN_ASC_TRIANGLE",  label: "Ascending Triangle → CE", type: "toggle", effect: EFFECT.SESSION, desc: "Flat resistance + rising lows, breakout → CE", default: "true" },
      { key: "PA_PATTERN_DESC_TRIANGLE", label: "Descending Triangle → PE", type: "toggle", effect: EFFECT.SESSION, desc: "Flat support + falling highs, breakdown → PE", default: "true" },
      // Pattern-shape internals (Min Body / Pattern Tolerance / S/R Lookback) and the
      // structural SL placement (buffer beyond the pattern level) are computed internally
      // by the engine — no knobs. The SL sits at the pattern's invalidation level itself.
      // ── Exit: breakeven then swing trail ──
      { key: "PA_BREAKEVEN_TRIGGER", label: "Breakeven Trigger (₹)", type: "number", min: 0, max: 2000, step: 50, effect: EFFECT.SESSION, desc: "Once peak PnL ≥ this many rupees, lift SL to entry+buffer so a winning trade can never close red. 0 = disabled.", default: "300" },
      { key: "PA_BREAKEVEN_BUFFER", label: "Breakeven Buffer (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.SESSION, desc: "Spot points above (CE) / below (PE) entry for the breakeven SL — small slippage cushion", default: "1" },
      { key: "PA_SLIPPAGE_PTS", label: "Slippage (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.SESSION, desc: "Simulated slippage for backtest", default: "0" },
      { key: "PA_MAX_DAILY_TRADES", label: "Max Daily Trades", type: "number", min: 5, max: 100, step: 5, effect: EFFECT.SESSION, desc: "Max PA entries per day", default: "30" },
      { key: "PA_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 20000, step: 500, effect: EFFECT.SESSION, desc: "PA daily loss kill-switch", default: "2000" },
      { key: "PA_SL_PAUSE_CANDLES", label: "SL Pause (candles)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Pause after SL hit", default: "2" },
      { key: "PA_CONSEC_SL_EXTRA_PAUSE", label: "Consec SL Extra Pause", type: "number", min: 1, max: 5, step: 1, effect: EFFECT.SESSION, desc: "Extra candles pause per consecutive SL", default: "2" },
    ],
  },
  {
    section: "ORB STRATEGY (Opening Range Breakout) — Fyers",
    icon: "📋",
    fields: [
      { key: "ORB_LIVE_ENABLED", label: "ORB Live Orders (gates /orb-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Master switch for ORB Live trading. Must be true AND LIVE_HARNESS_DRY_RUN=false for real Fyers orders to fire.", default: "false" },
      { key: "ORB_LIVE_DRY_RUN", label: "ORB Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep ORB in DRY-RUN (log only, no real order) even when the global Live Harness DRY-RUN is OFF. Lets you take EMA_RSI_ST/etc. live while ORB stays simulated. Default off.", default: "false" },
      { key: "ORB_EXPIRY_DAY_ONLY", label: "ORB Only on Expiry Day", type: "toggle", effect: EFFECT.INSTANT, desc: "Only allow ORB entries on weekly expiry day (Tuesday)", default: "false" },
      { key: "ORB_VIX_ENABLED", label: "VIX Filter (ORB)", type: "toggle", effect: EFFECT.INSTANT, desc: "Block ORB entries when VIX is high (scope: ORB only)", default: "false" },
      { key: "ORB_VIX_MAX_ENTRY", label: "ORB VIX Max Entry", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "ORB only: block entries above this VIX", default: "22" },
      { key: "ORB_VIX_STRONG_ONLY", label: "ORB VIX Strong Only", type: "number", min: 8, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "ORB only: above this VIX allow only STRONG signals", default: "18" },
      { key: "ORB_RANGE_START", label: "OR Window Start", type: "time", effect: EFFECT.SESSION, desc: "Opening range start (HH:MM IST)", default: "09:15" },
      { key: "ORB_RANGE_END", label: "OR Window End", type: "time", effect: EFFECT.SESSION, desc: "Opening range end (HH:MM IST). 15-min ORB = 09:15→09:30", default: "09:30" },
      { key: "ORB_ENTRY_END", label: "Latest Entry Time", type: "time", effect: EFFECT.SESSION, desc: "No new ORB entries after this time (stale-breakout cutoff). V3 default 11:30 — breakouts after this are lower quality.", default: "11:30" },
      { key: "ORB_FORCED_EXIT", label: "Forced Square-Off", type: "time", effect: EFFECT.SESSION, desc: "Hard EOD exit time for any open ORB position — the only non-stop exit", default: "15:15" },
      { key: "ORB_TRAIL_EMA", label: "Exit — EMA Trail Period", type: "number", min: 2, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "Trend-trail: while in a trade, exit only when a candle CLOSES back across this EMA (of 5-min closes). Lets a winner ride the whole move instead of dying on the first pullback. Seeded from prior-day candles so it is live even for a 09:35 entry.", default: "20" },
      { key: "ORB_BREAKEVEN_PTS", label: "Exit — Breakeven After (pts)", type: "number", min: 0, max: 60, step: 5, effect: EFFECT.INSTANT, desc: "Once the trade is this many NIFTY points in profit, lift the hard SL to the entry price. Used as the FLOOR when adaptive breakeven (below) is on. 0 = never move to breakeven.", default: "20" },
      { key: "ORB_BREAKEVEN_OR_MULT", label: "Exit — Breakeven × OR Width", type: "number", min: 0, max: 1.5, step: 0.1, effect: EFFECT.INSTANT, desc: "Adaptive breakeven: trigger at max(fixed pts above, this × OR width) so a wide-range day gets more room before the stop tightens to entry. 0 = use the fixed pts only.", default: "0.5" },
      { key: "ORB_MAX_TRADE_LOSS", label: "Exit — Max Loss per Trade (₹)", type: "number", min: 0, max: 10000, step: 250, effect: EFFECT.INSTANT, desc: "Disaster backstop: exit immediately if this single trade's unrealised loss reaches −₹this. NOTE: the daily-loss kill only fires when flat, so THIS is what caps one open trade. 0 = disabled.", default: "1500" },
      { key: "ORB_PREMIUM_STOP_PCT", label: "Exit — Premium Disaster Stop (%)", type: "number", min: 0, max: 80, step: 5, effect: EFFECT.INSTANT, desc: "Exit if the option premium collapses by this % from entry — catches IV-crush / vega losses the spot-based stop can miss. Whichever of this / the ₹ cap / the spot SL fires first. 0 = disabled.", default: "35" },
      { key: "ORB_OPP_CANDLE_EXIT", label: "Exit — Strong Opposite Candle", type: "toggle", effect: EFFECT.INSTANT, desc: "Exit immediately when a candle closes against the trade with a big body (see multiplier below) back inside the opening range — a sharp reversal.", default: "true" },
      { key: "ORB_OPP_CANDLE_BODY_MULT", label: "Opposite-Candle Body × Range", type: "number", min: 0.1, max: 1, step: 0.05, effect: EFFECT.INSTANT, desc: "Opposite candle triggers the exit above only if its body ≥ this × OR width. 0.3 = body at least 30% of the opening range.", default: "0.3" },
      { key: "ORB_ENTRY_V3_ENABLED", label: "Entry Engine V3 (Trend-Day) ★", type: "toggle", effect: EFFECT.INSTANT, desc: "ON (default) = 2026-07-10 redesign. Captures trend days, kills false breakouts. Adaptive ATR-relative gates (OR vs ATR15, body vs ATR5, gap vs OR), must break into fresh ground (prior-day H/L), ONE confirmation candle + VWAP side, OPTIONAL non-blocking retest. Drops the V2 EMA20/50 + ADX + RSI stack. Takes PRECEDENCE over V2/V1 below. Turn OFF to fall back to V2.", default: "true" },
      { key: "ORB_ITM_STEPS", label: "V3 — Slightly-ITM Strike Steps", type: "number", min: 0, max: 3, step: 1, effect: EFFECT.SESSION, desc: "Trade this many strikes (×50) IN-the-money (CE lower / PE higher) for ~delta 0.6 — tracks the trend move better and decays slower in % than ATM. Costs more per lot, so size down. 0 = ATM. ORB only.", default: "1" },
      { key: "ORB_ATR_PERIOD", label: "V3 — ATR Period", type: "number", min: 5, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "V3 volatility yardstick: ATR lookback on both 5-min and 15-min candles, used by all the adaptive gates.", default: "14" },
      { key: "ORB_OR_ATR_MIN", label: "V3 — Min OR ÷ ATR(15m)", type: "number", min: 0.2, max: 2, step: 0.1, effect: EFFECT.INSTANT, desc: "V3 day filter: skip the day if OR width < this × ATR(15m) — too tight (chop). Adaptive replacement for fixed Min OR Width.", default: "0.7" },
      { key: "ORB_OR_ATR_MAX", label: "V3 — Max OR ÷ ATR(15m)", type: "number", min: 1, max: 5, step: 0.1, effect: EFFECT.INSTANT, desc: "V3 day filter: skip the day if OR width > this × ATR(15m) — open already ran / exhausted. Adaptive replacement for fixed Max OR Width.", default: "2.5" },
      { key: "ORB_GAP_OR_MULT", label: "V3 — Max Gap × OR Width", type: "number", min: 0, max: 6, step: 0.5, effect: EFFECT.INSTANT, desc: "V3 day filter: skip the day if |overnight gap| > this × OR width — exhaustion / news gap. 0 = disable.", default: "3" },
      { key: "ORB_PRIORDAY_LEVEL_FILTER", label: "V3 — Break Into Fresh Ground", type: "toggle", effect: EFFECT.INSTANT, desc: "V3 day filter: only take a breakout that also clears the PRIOR day's High (CE) / Low (PE) — trapped traders provide fuel and there's a real stop below. This is the MOST restrictive gate; turn OFF if it blocks too many days.", default: "true" },
      { key: "ORB_BODY_ATR_MULT", label: "V3 — Min Body ÷ ATR(5m)", type: "number", min: 0.2, max: 1.5, step: 0.1, effect: EFFECT.INSTANT, desc: "V3: breakout candle body must be ≥ this × ATR(5m) — a decisive bar. Adaptive replacement for the fixed Min Break Candle Body.", default: "0.6" },
      { key: "ORB_BUFFER_OR_MULT", label: "V3 — Breakout Buffer × OR", type: "number", min: 0, max: 0.5, step: 0.05, effect: EFFECT.INSTANT, desc: "V3 breakout buffer: fraction of OR width the close must clear the edge by. Buffer = max(this × OR, ATR-mult × ATR5, 1pt).", default: "0.15" },
      { key: "ORB_BUFFER_ATR_MULT", label: "V3 — Breakout Buffer × ATR(5m)", type: "number", min: 0, max: 1, step: 0.05, effect: EFFECT.INSTANT, desc: "V3 breakout buffer: the other half — × ATR(5m). Buffer = max(OR-mult × OR, this × ATR5, 1pt).", default: "0.3" },
      { key: "ORB_RETEST_MODE", label: "V3 — Retest Fallback", type: "select", options: ["optional", "off"], effect: EFFECT.INSTANT, desc: "V3 retest handling. 'optional' (default) = if the confirmation candle hesitates, allow a pullback-and-hold retest OR a trend-resume within the window — NEVER blocks a trend-day entry. 'off' = confirmed-breakout entry only (no retest). NOTE: a MANDATORY retest measurably hurt expectancy (backtest 2026-07-09), so there is deliberately no 'required' option.", default: "optional" },
      { key: "ORB_ENTRY_V2_ENABLED", label: "Entry Engine V2 (Confirmed Breakout) [legacy]", type: "toggle", effect: EFFECT.INSTANT, desc: "LEGACY — only used when V3 (above) is OFF. 2026-07-09 engine: strong breakout candle + NEXT-candle confirmation (HH/HC) + EMA20/50 & ADX trend regime + RSI + gap gate. OFF = V1 legacy immediate-entry. Kept for A/B / rollback.", default: "true" },
      { key: "ORB_MIN_RANGE_PTS", label: "Min OR Width (pts) [V2]", type: "number", min: 10, max: 80, step: 5, effect: EFFECT.INSTANT, desc: "V2 only — V3 uses the adaptive 'Min OR ÷ ATR(15m)' instead. Skip the day when the opening range is too tight.", default: "30" },
      { key: "ORB_MAX_RANGE_PTS", label: "Max OR Width (pts) [V2]", type: "number", min: 50, max: 300, step: 10, effect: EFFECT.INSTANT, desc: "V2 only — V3 uses the adaptive 'Max OR ÷ ATR(15m)' instead. Skip the day when the opening range is too wide.", default: "80" },
      { key: "ORB_MIN_BODY", label: "Min Break Candle Body (pts) [V2]", type: "number", min: 3, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "V2 only — V3 uses the adaptive 'Min Body ÷ ATR(5m)' instead. Breakout candle body must be at least this many points.", default: "15" },
      { key: "ORB_BREAKOUT_BUFFER_MIN", label: "Breakout Buffer — Min (pts)", type: "number", min: 0, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Entry needs the close to CLEAR the OR edge (not just touch it) by max(this, pct×range). Filters bare-touch false breakouts that reverse straight back (STEP 3).", default: "10" },
      { key: "ORB_BREAKOUT_BUFFER_PCT", label: "Breakout Buffer — % of Range", type: "number", min: 0, max: 0.5, step: 0.05, effect: EFFECT.INSTANT, desc: "The other half of the breakout buffer: fraction of OR width. 0.20 = clear the edge by 20% of the range. Buffer used = max(min-pts, this × range) (STEP 3).", default: "0.20" },
      { key: "ORB_CONFIRM_ENABLED", label: "Next-Candle Confirmation (V2)", type: "toggle", effect: EFFECT.INSTANT, desc: "V2 STEP 5: after a valid breakout candle, require the NEXT candle to extend the move (stay beyond the OR edge + higher-high/higher-close for CE, lower-low/lower-close for PE) before entering. This is the core false-breakout killer.", default: "true" },
      { key: "ORB_BODY_PCT_MIN", label: "Break Candle — Min Body % of Candle (V2)", type: "number", min: 0.3, max: 0.9, step: 0.05, effect: EFFECT.INSTANT, desc: "V2 STEP 4: breakout candle body must be ≥ this fraction of the full candle range (high−low). 0.60 = a decisive bar, not a doji.", default: "0.60" },
      { key: "ORB_WICK_PCT_MAX", label: "Break Candle — Max Wick % of Candle (V2)", type: "number", min: 0.1, max: 0.5, step: 0.05, effect: EFFECT.INSTANT, desc: "V2 STEP 4: the wick in the breakout direction (upper for CE, lower for PE) must be ≤ this fraction of the candle range. 0.25 = little rejection at the break. (Supersedes the legacy wick/body ratio used by V1.)", default: "0.25" },
      { key: "ORB_CLOSE_POS_PCT", label: "Break Candle — Close in Extreme % (V2)", type: "number", min: 0.1, max: 0.5, step: 0.05, effect: EFFECT.INSTANT, desc: "V2 STEP 4: breakout candle must close within this fraction of its high (CE) / low (PE). 0.20 = close in the top/bottom 20% of the candle.", default: "0.20" },
      { key: "ORB_RSI_PERIOD", label: "RSI Period (V2)", type: "number", min: 5, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "V2 STEP 4: RSI lookback on 5-min closes.", default: "14" },
      { key: "ORB_RSI_CE_MIN", label: "RSI Min for CE (V2)", type: "number", min: 40, max: 80, step: 1, effect: EFFECT.INSTANT, desc: "V2 STEP 4: bullish breakout candle needs RSI above this.", default: "55" },
      { key: "ORB_RSI_PE_MAX", label: "RSI Max for PE (V2)", type: "number", min: 20, max: 60, step: 1, effect: EFFECT.INSTANT, desc: "V2 STEP 4: bearish breakout candle needs RSI below this.", default: "45" },
      { key: "ORB_TREND_EMA_FAST", label: "Trend Fast EMA (V2)", type: "number", min: 5, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "V2 STEP 6 trend regime: fast EMA of 5-min closes (CE needs fast>slow, PE needs fast<slow). Also drives the STEP-4 EMA-slope check on the breakout candle.", default: "20" },
      { key: "ORB_TREND_EMA_SLOW", label: "Trend Slow EMA (V2)", type: "number", min: 20, max: 100, step: 1, effect: EFFECT.INSTANT, desc: "V2 STEP 6 trend regime: slow EMA of 5-min closes.", default: "50" },
      { key: "ORB_ADX_PERIOD", label: "ADX Period (V2)", type: "number", min: 5, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "V2 STEP 6 trend regime: ADX lookback.", default: "14" },
      { key: "ORB_ADX_MIN", label: "ADX Min (V2)", type: "number", min: 10, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "V2 STEP 6: require ADX above this — trade only when the market has directional strength, not chop.", default: "20" },
      { key: "ORB_MAX_GAP_PTS", label: "Max Overnight Gap (pts, V2)", type: "number", min: 0, max: 300, step: 10, effect: EFFECT.INSTANT, desc: "V2 STEP 7: skip the day when |today open − prior close| exceeds this — gap/news-shock days behave differently. 0 = disable.", default: "80" },
      { key: "ORB_MAX_SPREAD_PTS", label: "Max Option Bid-Ask Spread (pts)", type: "number", min: 0.5, max: 10, step: 0.5, effect: EFFECT.INSTANT, desc: "STEP 8: skip entry if the ATM option's ask−bid exceeds this. Fails OPEN (allows) when the broker snapshot has no bid/ask. Falls back to the global MAX_BID_ASK_SPREAD_PTS.", default: "2" },
      { key: "ORB_RETEST_ENABLED", label: "Retest-Entry Gate (V2 backtest only)", type: "toggle", effect: EFFECT.INSTANT, desc: "LEGACY / V2 backtest only — IGNORED when V3 is on (V3 has its own OPTIONAL non-blocking retest, controlled by 'V3 — Retest Fallback' above). Old V2 backtest prototype: wait for a pullback-and-hold of the OR edge before entering. Any day that never pulls back takes NO trade.", default: "false" },
      { key: "ORB_RETEST_TOL_MIN", label: "Retest — Tolerance Min (pts)", type: "number", min: 0, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "How close price must return to the OR edge to count as a retest: within max(this, pct×range) points. Used by V3's optional retest and the V2 backtest gate.", default: "5" },
      { key: "ORB_RETEST_TOL_PCT", label: "Retest — Tolerance % of Range", type: "number", min: 0, max: 0.5, step: 0.05, effect: EFFECT.INSTANT, desc: "Other half of the retest tolerance: fraction of OR width. Zone used = max(min-pts, this × range).", default: "0.1" },
      { key: "ORB_RETEST_MAX_WAIT", label: "Retest — Max Wait (candles)", type: "number", min: 1, max: 20, step: 1, effect: EFFECT.INSTANT, desc: "V3 optional-retest window: how many candles after a hesitating confirmation to wait for a retest / trend-resume before giving up. Also the V2 backtest gate's wait.", default: "4" },
      { key: "ORB_WICK_FILTER_ENABLED", label: "Wick-Rejection Filter (V1 only)", type: "toggle", effect: EFFECT.INSTANT, desc: "LEGACY engine only (ORB_ENTRY_V2_ENABLED=false). Reject breakout candles with large opposing wick. V2 uses 'Max Wick % of Candle' instead.", default: "true" },
      { key: "ORB_MAX_WICK_RATIO", label: "Max Wick Ratio (V1 only)", type: "number", min: 0.2, max: 1.5, step: 0.1, effect: EFFECT.INSTANT, desc: "LEGACY engine only. Upper wick (CE) or lower wick (PE) must be <= this fraction of BODY. 0.6 = wick can be 60% of body. V2 uses wick-as-%-of-candle instead.", default: "0.6" },
      { key: "ORB_VWAP_FILTER_ENABLED", label: "VWAP / TWAP Alignment Filter", type: "toggle", effect: EFFECT.INSTANT, desc: "CE only if breakout close > session VWAP; PE only if close < VWAP. On NIFTY spot (no volume) this is effectively a TWAP (equal-weighted) check, not a true volume-weighted VWAP.", default: "true" },
      { key: "ORB_VOL_FILTER_ENABLED", label: "Volume Confirmation Filter", type: "toggle", effect: EFFECT.INSTANT, desc: "Require breakout candle volume >= multiplier × prior N-candle avg. DEFAULT OFF: NIFTY spot has no real volume — paper/live see only a tick count, backtest sees zero, so this gate can't agree across modes.", default: "false" },
      { key: "ORB_VOL_MULT", label: "Volume Multiplier", type: "number", min: 1, max: 3, step: 0.1, effect: EFFECT.INSTANT, desc: "Breakout volume must be >= this × prior-N avg (1.2 = 20% above avg)", default: "1.2" },
      { key: "ORB_VOL_LOOKBACK", label: "Volume Lookback (candles)", type: "number", min: 3, max: 20, step: 1, effect: EFFECT.INSTANT, desc: "Number of prior candles in the volume SMA window", default: "5" },
      { key: "ORB_PREMIUM_GATE_ENABLED", label: "Premium-Range Gate", type: "toggle", effect: EFFECT.INSTANT, desc: "Skip entries when ATM option LTP is outside the configured band (filters out deep-OTM lottery tickets and ITM-acting-like-futures)", default: "true" },
      { key: "ORB_PREMIUM_MIN", label: "Min Option Premium (₹)", type: "number", min: 20, max: 500, step: 5, effect: EFFECT.INSTANT, desc: "STEP 8: skip entry if option LTP below this. Widened for slightly-ITM (V3) premiums.", default: "120" },
      { key: "ORB_PREMIUM_MAX", label: "Max Option Premium (₹)", type: "number", min: 100, max: 1000, step: 10, effect: EFFECT.INSTANT, desc: "STEP 8: skip entry if option LTP above this. Widened for slightly-ITM (V3) premiums.", default: "400" },
      { key: "ORB_SWEET_MIN", label: "Sweet-Spot Min (pts)", type: "number", min: 20, max: 80, step: 5, effect: EFFECT.INSTANT, desc: "Range below this = MARGINAL (still allowed)", default: "30" },
      { key: "ORB_SWEET_MAX", label: "Sweet-Spot Max (pts)", type: "number", min: 40, max: 150, step: 5, effect: EFFECT.INSTANT, desc: "Range above this = MARGINAL (still allowed)", default: "80" },
      { key: "ORB_STRONG_BODY", label: "STRONG Body Min (pts)", type: "number", min: 8, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "Breakout body >= this AND range in sweet spot → STRONG", default: "15" },
      { key: "ORB_MAX_DAILY_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 3, step: 1, effect: EFFECT.SESSION, desc: "ORB is textbook 1 trade/day — cap higher only if you accept the chop", default: "1" },
      { key: "ORB_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 20000, step: 500, effect: EFFECT.SESSION, desc: "ORB daily loss kill-switch", default: "3000" },
      { key: "ORB_RISK_THROTTLE_ENABLED", label: "Risk Breaker (weekly loss / losing streak)", type: "toggle", effect: EFFECT.INSTANT, desc: "Portfolio breaker: sit out new entries after a weekly-loss stop or a run of losing days (ORB is low-win-rate, so losing streaks are normal — this stops a hostile regime from bleeding the account). Paper and live track separately. Block-only; position size is unchanged.", default: "true" },
      { key: "ORB_MAX_WEEKLY_LOSS", label: "Max Weekly Loss (₹)", type: "number", min: 0, max: 60000, step: 500, effect: EFFECT.INSTANT, desc: "Stop taking ORB entries for the rest of the ISO-week (Mon→Fri) once the week's realised P&L reaches −₹this. 0 = disabled.", default: "9000" },
      { key: "ORB_LOSS_STREAK_SKIP", label: "Skip After N Losing Days", type: "number", min: 0, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "Sit out the next trading day after this many consecutive losing days. One-day cool-off (a flat/skip day resets the streak). 0 = disabled.", default: "4" },
    ],
  },
  {
    section: "EMA9 + VWAP STRATEGY — Zerodha",
    icon: "📈",
    fields: [
      { key: "EMA9VWAP_LIVE_ENABLED", label: "EMA9+VWAP Live Orders (gates /ema9vwap-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Master switch for EMA9+VWAP Live trading. Must be true AND LIVE_HARNESS_DRY_RUN=false for real Zerodha orders to fire.", default: "false" },
      { key: "EMA9VWAP_LIVE_DRY_RUN", label: "EMA9+VWAP Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep EMA9+VWAP in DRY-RUN (log only, no real order) even when the global Live Harness DRY-RUN is OFF. Default off.", default: "false" },
      { key: "EMA9VWAP_BAND_MULT", label: "VWAP Band σ Multiplier", type: "number", min: 0, max: 4, step: 0.5, effect: EFFECT.INSTANT, desc: "Standard-deviation multiplier for the VWAP top/bottom lines (TradingView 'Bands Multiplier #1'). 1 = ±1σ (default). 0 collapses the band to the plain VWAP line.", default: "1" },
      { key: "EMA9VWAP_EMA_PERIOD", label: "EMA Period", type: "number", min: 2, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "EMA length crossed against the VWAP band (default 9).", default: "9" },
      { key: "EMA9VWAP_VWAP_SESSION_START", label: "VWAP Session Anchor", type: "time", effect: EFFECT.SESSION, desc: "Session-anchor time for VWAP (HH:MM IST). VWAP resets each day from here. Default 09:15 = market open (TradingView 'Session').", default: "09:15" },
      { key: "EMA9VWAP_ENTRY_START", label: "Entry Window Start", type: "time", effect: EFFECT.SESSION, desc: "No entries before this IST time (default 10:30).", default: "10:30" },
      { key: "EMA9VWAP_ENTRY_END", label: "Entry Window End", type: "time", effect: EFFECT.SESSION, desc: "No NEW entries at/after this IST time (default 14:30). A trailing position keeps running past this.", default: "14:30" },
      { key: "EMA9VWAP_EOD_EXIT_TIME", label: "EOD Square-Off", type: "time", effect: EFFECT.SESSION, desc: "Hard square-off time for any open position (default 15:15 IST).", default: "15:15" },
      { key: "EMA9VWAP_STOP_TIME", label: "Engine Auto-Stop", type: "time", effect: EFFECT.SESSION, desc: "Time the engine auto-stops for the day (default 15:30 IST).", default: "15:30" },
      { key: "EMA9VWAP_MAX_DAILY_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 40, step: 1, effect: EFFECT.SESSION, desc: "Daily trade cap.", default: "20" },
      { key: "EMA9VWAP_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 50000, step: 500, effect: EFFECT.SESSION, desc: "Daily loss kill-switch.", default: "5000" },
      { key: "EMA9VWAP_CONFIRM_CANDLE_ENABLED", label: "Confirmation Candle", type: "toggle", effect: EFFECT.INSTANT, desc: "OFF by default — the EMA9-vs-band cross is itself a candle-close event so entry fires on that candle. Turn on for an extra next-candle confirmation.", default: "false" },
      { key: "EMA9VWAP_INTRACANDLE_ENTRY", label: "Intra-Candle Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "OFF by default — entries evaluated only on 5-min candle CLOSE (matches 'wait for timeframe close'). Turn on to allow mid-candle entries.", default: "false" },
      { key: "EMA9VWAP_OPT_STOP_PCT", label: "Safety Option-Premium Stop (fraction)", type: "number", min: 0, max: 0.5, step: 0.05, effect: EFFECT.INSTANT, desc: "Optional catastrophe stop on option premium (0.15 = exit if premium drops 15%). 0 = OFF (pure signal exit, the default).", default: "0" },
      { key: "EMA9VWAP_STOP_LOSS_PTS", label: "Safety Spot-Points Stop", type: "number", min: 0, max: 200, step: 5, effect: EFFECT.INSTANT, desc: "Optional catastrophe stop in NIFTY spot points against entry. 0 = OFF (pure signal exit, the default).", default: "0" },
      { key: "EMA9VWAP_REVERSAL_EXIT_ENABLED", label: "2-Candle Reversal Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "ON by default — after entry, square off the instant a candle CLOSES hard against the position: a CE bails on a bearish candle (close below open) closing below BOTH previous 2 candles' lows; a PE on a bullish candle closing above both previous 2 highs. Evaluated on candle close, rolling reference. Turn off to hold purely to the signal/EOD exit.", default: "true" },
      { key: "EMA9VWAP_OPTION_EXPIRY_OVERRIDE", label: "Option Expiry Override (YYYY-MM-DD)", type: "text", effect: EFFECT.SESSION, desc: "Force a specific weekly expiry for EMA9+VWAP option entries. Blank = nearest weekly (intraday strategy, current week is fine).", default: "" },
    ],
  },
  {
    section: "TREND PULLBACK STRATEGY — Fyers",
    icon: "📈",
    fields: [
      { key: "TREND_PB_LIVE_ENABLED", label: "Trend Pullback Live Orders (gates /trend-pb-live/start)", type: "toggle", effect: EFFECT.INSTANT, desc: "Master switch for Trend Pullback Live trading (Phase C). Must be true AND LIVE_HARNESS_DRY_RUN=false AND TREND_PB_LIVE_DRY_RUN=false for real orders to fire.", default: "false" },
      { key: "TREND_PB_LIVE_DRY_RUN", label: "Trend Pullback Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep Trend Pullback in DRY-RUN (log only, no real order) even when the global Live Harness DRY-RUN is OFF. Default off.", default: "false" },
      // ── Entry (15m bias + 5m pullback/resumption) ──
      { key: "TREND_PB_SWING_LOOKBACK", label: "Swing Pivot Lookback (15m bars)", type: "number", min: 1, max: 5, step: 1, effect: EFFECT.INSTANT, desc: "Bars on each side that define a confirmed 15-min swing high/low for the HH-HL / LH-LL trend structure. Default 2.", default: "2" },
      { key: "TREND_PB_BODY_ATR_MULT", label: "Resumption Body ≥ ×ATR5", type: "number", min: 0, max: 2, step: 0.1, effect: EFFECT.INSTANT, desc: "The resumption candle's body must be ≥ this × ATR(5m) — the conviction proxy that replaces volume (NIFTY index has no real volume). Default 0.5.", default: "0.5" },
      { key: "TREND_PB_PULLBACK_MAX_ATR", label: "Max Pullback Depth (×ATR5 below EMA20)", type: "number", min: 0.5, max: 4, step: 0.25, effect: EFFECT.INSTANT, desc: "Rejects deep/broken pullbacks — the pullback extreme may not fall more than this × ATR(5m) beyond EMA20(5m). Default 1.5.", default: "1.5" },
      { key: "TREND_PB_PULLBACK_WINDOW", label: "Pullback Lookback Window (5m bars)", type: "number", min: 3, max: 12, step: 1, effect: EFFECT.INSTANT, desc: "How many 5-min bars before the resumption candle count as the pullback. Default 6.", default: "6" },
      { key: "TREND_PB_MIN_PULLBACK_BARS", label: "Min Against-Trend Candles", type: "number", min: 1, max: 5, step: 1, effect: EFFECT.INSTANT, desc: "Minimum against-trend candles in the window for a real pause (not a 1-bar wick). Default 2.", default: "2" },
      { key: "TREND_PB_ENTRY_START", label: "Entry Window Start", type: "time", effect: EFFECT.SESSION, desc: "No entries before this IST time (skips the opening noise). Default 09:45.", default: "09:45" },
      { key: "TREND_PB_ENTRY_END", label: "Entry Window End", type: "time", effect: EFFECT.SESSION, desc: "No NEW entries at/after this IST time (a trailing position keeps running). Default 14:30.", default: "14:30" },
      { key: "TREND_PB_ATR_FLOOR_PTS", label: "ATR5 Floor (skip if below, pts)", type: "number", min: 0, max: 100, step: 5, effect: EFFECT.INSTANT, desc: "No-trade filter: skip when ATR(5m) is below this (compressed range = no juice for buyers). 0 = OFF (default).", default: "0" },
      // ── Exit (highest priority — right-tail via spot trailing) ──
      { key: "TREND_PB_STOP_CLAMP_MIN", label: "Initial Stop Clamp — Min (pts)", type: "number", min: 3, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "Structural stop (pullback extreme) is clamped so risk is never below this many spot points. Default 8.", default: "8" },
      { key: "TREND_PB_STOP_CLAMP_MAX", label: "Initial Stop Clamp — Max (pts)", type: "number", min: 10, max: 80, step: 1, effect: EFFECT.INSTANT, desc: "…and never above this many spot points (caps risk on a wide structure). Default 30.", default: "30" },
      { key: "TREND_PB_BREAKEVEN_R", label: "Breakeven Trigger (× initial risk)", type: "number", min: 0, max: 3, step: 0.25, effect: EFFECT.INSTANT, desc: "Lift the stop to entry once favourable by this × the initial risk. 0 = OFF. Default 1.0 (1R).", default: "1.0" },
      { key: "TREND_PB_TRAIL_ATR_MULT", label: "ATR Chandelier Trail (× ATR5)", type: "number", min: 1, max: 6, step: 0.5, effect: EFFECT.INSTANT, desc: "The right-tail engine — trail the spot stop at best-spot − this × ATR(5m), ratcheting one way. Higher = more room to run. Default 2.5.", default: "2.5" },
      { key: "TREND_PB_TRAIL_EMA", label: "Trend-Failure EMA (5m period)", type: "number", min: 5, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "Exit on a 5-min CLOSE back across this EMA after the move arms (momentum loss). Default 20.", default: "20" },
      { key: "TREND_PB_ATR_PERIOD", label: "ATR Period (5m)", type: "number", min: 5, max: 30, step: 1, effect: EFFECT.INSTANT, desc: "ATR length used for the body filter, pullback depth and the chandelier trail. Default 14.", default: "14" },
      { key: "TREND_PB_TIME_STOP_CANDLES", label: "Time Stop (flat candles)", type: "number", min: 0, max: 20, step: 1, effect: EFFECT.INSTANT, desc: "Exit if held this many 5-min candles while still roughly flat (theta bleed). 0 = OFF. Default 6.", default: "6" },
      { key: "TREND_PB_PREMIUM_STOP_PCT", label: "Premium Disaster Stop (%)", type: "number", min: 0, max: 80, step: 5, effect: EFFECT.INSTANT, desc: "Hard exit if the option premium collapses this % from entry (catches gaps/IV-crush the spot stop misses). 0 = OFF. Default 35.", default: "35" },
      { key: "TREND_PB_FORCED_EXIT", label: "EOD Square-Off", type: "time", effect: EFFECT.SESSION, desc: "Hard square-off time for any open position. Default 15:15 IST.", default: "15:15" },
      // ── Option selection + risk ──
      { key: "TREND_PB_ITM_STEPS", label: "ITM Steps (strikes in-the-money)", type: "number", min: 0, max: 3, step: 1, effect: EFFECT.INSTANT, desc: "How many 50-pt strikes in-the-money to buy (1 ≈ delta 0.6, less theta bleed than ATM). Default 1.", default: "1" },
      { key: "TREND_PB_PREMIUM_MIN", label: "Min Option Premium (₹)", type: "number", min: 0, max: 1000, step: 10, effect: EFFECT.INSTANT, desc: "Reject entries priced below this (illiquid/too-far). Default 120.", default: "120" },
      { key: "TREND_PB_PREMIUM_MAX", label: "Max Option Premium (₹)", type: "number", min: 0, max: 2000, step: 10, effect: EFFECT.INSTANT, desc: "Reject entries priced above this (too expensive). Default 400.", default: "400" },
      { key: "TREND_PB_MAX_SPREAD_PTS", label: "Max Bid-Ask Spread (pts)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.INSTANT, desc: "Reject entries when the option bid-ask spread exceeds this (fails open when depth is missing). Default 2.", default: "2" },
      { key: "TREND_PB_MAX_DAILY_TRADES", label: "Max Trades/Day", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.SESSION, desc: "Daily trade cap — trend pullback is selective. Default 3.", default: "3" },
      { key: "TREND_PB_MAX_DAILY_LOSS", label: "Max Daily Loss (₹)", type: "number", min: 500, max: 50000, step: 500, effect: EFFECT.SESSION, desc: "Daily loss kill-switch. Default 5000.", default: "5000" },
      { key: "TREND_PB_LOSS_STREAK_SKIP", label: "Consecutive-Loss Cool-Off", type: "number", min: 0, max: 6, step: 1, effect: EFFECT.SESSION, desc: "Pause entries for the rest of the session after this many consecutive losing trades. 0 = OFF. Default 3.", default: "3" },
      { key: "TREND_PB_VIX_ENABLED", label: "VIX Filter", type: "toggle", effect: EFFECT.INSTANT, desc: "Gate entries by India VIX band (too low = theta trap, too high = whipsaw). Uses TREND_PB_VIX_MAX_ENTRY (fallback global VIX_MAX_ENTRY). Default off.", default: "false" },
      { key: "TREND_PB_VIX_MAX_ENTRY", label: "VIX Max Entry", type: "number", min: 8, max: 40, step: 1, effect: EFFECT.INSTANT, desc: "Block new entries when India VIX is above this. Default 22.", default: "22" },
      { key: "TREND_PB_OI_ENABLED", label: "OI Buildup Gate", type: "toggle", effect: EFFECT.INSTANT, desc: "Block entries fighting a confirmed NIFTY-futures OI buildup (needs master OI_FILTER_ENABLED on). Default off.", default: "false" },
      { key: "TREND_PB_BT_SLIPPAGE_PTS", label: "Backtest Spread/Slippage Haircut (pts each way)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.INSTANT, desc: "Premium points shaved off EACH side (buy higher / sell lower) in the backtest to model the option bid-ask spread + slippage the δ+θ sim can't see. The single most important honesty knob for an option-buying backtest. Default 1.5.", default: "1.5" },
      { key: "TREND_PB_BT_SEED_PREMIUM", label: "Backtest Seed Premium (₹)", type: "number", min: 50, max: 800, step: 10, effect: EFFECT.INSTANT, desc: "Assumed slightly-ITM option entry premium for the backtest δ+θ P&L sim (no historical option chain). Default 240.", default: "240" },
    ],
  },
  {
    section: "OPEN-INTEREST FILTER (OI + Price Buildup)",
    icon: "📊",
    fields: [
      { key: "OI_FILTER_ENABLED", label: "OI Filter MASTER (all strategies)", type: "toggle", effect: EFFECT.INSTANT, desc: "Master switch for the OI + price-buildup entry filter. OFF = disabled everywhere, regardless of the per-strategy toggles below. When ON, blocks entries that fight a confirmed buildup (CE in a short-buildup, PE in a long-buildup); weak/neutral/warmup regimes always allow. Reads NIFTY futures OI vs spot — LIVE/PAPER only, never evaluated in backtest/replay (OI is not recorded). Default OFF.", default: "false" },
      { key: "EMA_RSI_ST_OI_ENABLED", label: "OI Filter (EMA_RSI_ST)", type: "toggle", effect: EFFECT.INSTANT, desc: "Apply the OI buildup filter to EMA_RSI_ST entries. Requires the MASTER switch ON. Default OFF.", default: "false" },
      { key: "BB_RSI_OI_ENABLED", label: "OI Filter (BB_RSI)", type: "toggle", effect: EFFECT.INSTANT, desc: "Apply the OI buildup filter to BB_RSI entries. Requires the MASTER switch ON. Default OFF.", default: "false" },
      { key: "PA_OI_ENABLED", label: "OI Filter (PA)", type: "toggle", effect: EFFECT.INSTANT, desc: "Apply the OI buildup filter to Price-Action entries. Requires the MASTER switch ON. Default OFF.", default: "false" },
      { key: "ORB_OI_ENABLED", label: "OI Filter (ORB)", type: "toggle", effect: EFFECT.INSTANT, desc: "Apply the OI buildup filter to ORB entries. Requires the MASTER switch ON. Default OFF.", default: "false" },
      { key: "OI_LOOKBACK_CANDLES", label: "OI Lookback (candles)", type: "number", min: 1, max: 10, step: 1, effect: EFFECT.INSTANT, desc: "How many candles back to measure the OI + spot change over. Default 3 (≈15 min at 5-min candles).", default: "3" },
      { key: "OI_MIN_DELTA_PCT", label: "OI Min Change % (noise floor)", type: "number", min: 0, max: 10, step: 0.5, effect: EFFECT.INSTANT, desc: "Ignore OI changes smaller than this % over the lookback (treated as NEUTRAL → entry allowed). Stops tiny OI wiggles from creating a false regime. Default 1%.", default: "1" },
      { key: "OI_FAIL_MODE", label: "OI Unavailable (fail mode)", type: "select", options: ["open", "closed"], effect: EFFECT.INSTANT, desc: "Behaviour when futures OI can't be fetched: open = allow entries (default — safe for a non-recorded data source), closed = block. Warmup / weak / neutral regimes always allow regardless.", default: "open" },
    ],
  },
  {
    section: "Instrument & Backtest",
    icon: "📈",
    fields: [
      { key: "CHART_ENABLED", label: "Live NIFTY Chart", type: "toggle", effect: EFFECT.INSTANT, desc: "Show candlestick chart with entry/exit markers on status pages", default: "true" },
      { key: "VIX_FAIL_MODE", label: "VIX Unavailable (all modules)", type: "select", options: ["closed", "open"], effect: EFFECT.INSTANT, desc: "Shared fallback for all VIX filters when VIX data is missing: closed = block entries (safe), open = allow entries", default: "closed" },
      { key: "TRADE_START_TIME", label: "Market Start Time", type: "time", effect: EFFECT.SESSION, desc: "Market open time — execution gate start (HH:MM IST)", default: "09:15" },
      { key: "TRADE_STOP_TIME", label: "Market Stop Time", type: "time", effect: EFFECT.SESSION, desc: "Auto-stop time — EOD square off + engine shutdown (HH:MM IST)", default: "15:30" },
      { key: "INSTRUMENT", label: "Trade Type", type: "select", options: ["NIFTY_OPTIONS", "NIFTY_FUTURES"], effect: EFFECT.INSTANT, desc: "Options (CE/PE) or Futures" },
      { key: "NIFTY_LOT_SIZE", label: "Lot Size (Qty)", type: "number", min: 1, max: 200, step: 1, effect: EFFECT.INSTANT, desc: "Qty per lot (currently 65)" },
      { key: "LOT_MULTIPLIER", label: "Lot Multiplier", type: "number", min: 1, max: 50, step: 1, effect: EFFECT.INSTANT, desc: "Number of lots per trade" },
      { key: "STRIKE_OFFSET_CE", label: "CE Strike Offset", type: "number", min: -200, max: 200, step: 50, effect: EFFECT.INSTANT, desc: "-50=ITM, 0=ATM, +50=OTM", default: "0" },
      { key: "STRIKE_OFFSET_PE", label: "PE Strike Offset", type: "number", min: -200, max: 200, step: 50, effect: EFFECT.INSTANT, desc: "+50=ITM, 0=ATM, -50=OTM", default: "0" },
      { key: "OPTION_EXPIRY_OVERRIDE", label: "Option Expiry (manual)", type: "date", effect: EFFECT.INSTANT, desc: "Override auto-detected expiry. Leave blank for auto. Applies to all modes (EMA_RSI_ST/bb_rsi/PA)." },
      { key: "OPTION_EXPIRY_TYPE", label: "Expiry Type", type: "select", options: ["weekly", "monthly"], effect: EFFECT.INSTANT, desc: "Weekly = normal Tuesday expiry. Monthly = last Thursday/preponed monthly expiry. Applies to all modes.", default: "weekly" },
      { key: "TICK_RECORDER_ENABLED", label: "Tick Recorder (for Replay)", type: "toggle", effect: EFFECT.SESSION, desc: "Record every spot/option/VIX tick to data/ticks/YYYY-MM-DD/*.jsonl during paper/live sessions. Required for Replay backtest. Pure observer — no impact on trading.", default: "true" },
      { key: "TICK_RECORDER_RETAIN_DAYS", label: "Tick Recordings Retention (days)", type: "number", min: 7, max: 180, step: 1, effect: EFFECT.SERVER, desc: "Auto-delete tick recordings older than this many days. ~10 MB/day across all streams — 30 days ≈ 300 MB. Lower if EBS is tight.", default: "30" },
      { key: "LIVE_HARNESS_DRY_RUN", label: "Live Harness DRY-RUN (GLOBAL)", type: "toggle", effect: EFFECT.SESSION, desc: "GLOBAL kill-switch. When ON (default), ALL live routes (EMA_RSI_ST/ORB/PA) log the broker call but place no real order. When OFF, each strategy goes real UNLESS its own {STRATEGY}_LIVE_DRY_RUN override is ON. Switch OFF only after validating decisions match paper.", default: "true" },
      { key: "PA_LIVE_DRY_RUN", label: "PA Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep the PA Live harness in DRY-RUN (log only, no real order) even when the global Live Harness DRY-RUN is OFF. Default off.", default: "false" },
      { key: "BB_RSI_LIVE_DRY_RUN", label: "BB_RSI Live DRY-RUN override", type: "toggle", effect: EFFECT.SESSION, desc: "Keep BB_RSI in DRY-RUN (log only, no real order) even when the global Live Harness DRY-RUN is OFF. Default off. (BB_RSI Live has no separate master-enable gate, so this is its primary safety switch.)", default: "false" },
      { key: "BACKTEST_OPTION_SIM", label: "Option Simulation (legacy bar-based BT only)", type: "toggle", effect: EFFECT.BACKTEST, desc: "Simulate option P&L with delta/theta. Used only by the legacy bar-based backtest; the new Replay backtest uses recorded option ticks instead." },
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
      { key: "ZERODHA_INV_AMOUNT", label: "Zerodha Investment Amount (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.INSTANT, desc: "Paper investment pool for Zerodha-brokered strategies (EMA_RSI_ST). Paper trade P&L is added to / subtracted from this amount.", default: "100000" },
      { key: "FYERS_INV_AMOUNT", label: "Fyers Investment Amount (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.INSTANT, desc: "Paper investment pool for Fyers-brokered strategies (BB_RSI + PA + ORB). Paper trade P&L is added to / subtracted from this amount.", default: "100000" },
      { key: "BACKTEST_CAPITAL", label: "Backtest Capital (₹)", type: "number", min: 10000, max: 10000000, step: 10000, effect: EFFECT.BACKTEST },
    ],
  },
  {
    section: "Server & Broker",
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
    section: "Backup & Restore",
    icon: "📦",
    fields: [
      { key: "BACKUP_ENABLED", label: "Daily Data Backup", type: "toggle", effect: EFFECT.INSTANT, desc: "Cut a daily downloadable .tar.gz snapshot of ~/trading-data + recorded ticks (caches & tokens excluded). Download it from the Backup & Restore card above so an EC2 loss never loses data.", default: "true" },
      { key: "BACKUP_HOUR_IST", label: "Snapshot Hour (IST)", type: "number", min: 0, max: 23, step: 1, effect: EFFECT.SERVER, desc: "Hour of day (IST) the daily snapshot is cut — after market close. Timer is armed at boot; restart to re-arm a changed hour.", default: "16" },
      { key: "BACKUP_RETAIN_DAYS", label: "Keep Pre-Restore Snapshots (days)", type: "number", min: 1, max: 90, step: 1, effect: EFFECT.INSTANT, desc: "Daily snapshots keep only the latest (a new one deletes the old). This governs the hidden pre-restore safety snapshots taken before a restore — pruned beyond this many days.", default: "14" },
      { key: "BACKUP_TG_ENABLED", label: "Telegram Backup Heartbeat", type: "toggle", effect: EFFECT.INSTANT, desc: "Send a Telegram message when each day's snapshot is ready (or if it fails).", default: "false" },
    ],
  },
  {
    section: "Telegram",
    icon: "📱",
    fields: [
      { key: "TELEGRAM_CHAT_ID", label: "Chat ID", type: "text", effect: EFFECT.INSTANT, desc: "Leave blank to disable notifications" },
      { key: "TG_ENABLED", label: "Telegram Alerts (Master)", type: "toggle", effect: EFFECT.INSTANT, desc: "Master switch — when OFF, no Telegram alerts are sent regardless of the toggles below", default: "true" },

      { key: "TG_EMA_RSI_ST_STARTED", label: "EMA_RSI_ST — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a EMA_RSI_ST (5-min) paper/live session is started", default: "true" },
      { key: "TG_BB_RSI_STARTED", label: "BB_RSI — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a BB_RSI paper/live session is started", default: "true" },
      { key: "TG_PA_STARTED",    label: "Price Action — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a Price Action paper/live session is started", default: "true" },
      { key: "TG_ORB_STARTED",      label: "ORB — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when an ORB paper/live session is started", default: "true" },
      { key: "TG_EMA9VWAP_STARTED", label: "EMA9+VWAP — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when an EMA9+VWAP paper/live session is started", default: "true" },
      { key: "TG_TREND_PB_STARTED", label: "Trend Pullback — Session Started", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert when a Trend Pullback paper/live session is started", default: "true" },

      { key: "TG_EMA_RSI_ST_ENTRY", label: "EMA_RSI_ST — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every EMA_RSI_ST (5-min) trade entry (paper + live)", default: "true" },
      { key: "TG_BB_RSI_ENTRY", label: "BB_RSI — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every BB_RSI trade entry (paper + live)", default: "true" },
      { key: "TG_PA_ENTRY",    label: "Price Action — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Price Action trade entry (paper + live)", default: "true" },
      { key: "TG_ORB_ENTRY",      label: "ORB — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every ORB trade entry (paper + live)", default: "true" },
      { key: "TG_EMA9VWAP_ENTRY", label: "EMA9+VWAP — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every EMA9+VWAP trade entry (paper + live)", default: "true" },
      { key: "TG_TREND_PB_ENTRY", label: "Trend Pullback — Trade Entry", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Trend Pullback trade entry (paper + live)", default: "true" },

      { key: "TG_EMA_RSI_ST_EXIT", label: "EMA_RSI_ST — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every EMA_RSI_ST (5-min) trade exit (paper + live)", default: "true" },
      { key: "TG_BB_RSI_EXIT", label: "BB_RSI — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every BB_RSI trade exit (paper + live)", default: "true" },
      { key: "TG_PA_EXIT",    label: "Price Action — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Price Action trade exit (paper + live)", default: "true" },
      { key: "TG_ORB_EXIT",      label: "ORB — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every ORB trade exit (paper + live)", default: "true" },
      { key: "TG_EMA9VWAP_EXIT", label: "EMA9+VWAP — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every EMA9+VWAP trade exit (paper + live)", default: "true" },
      { key: "TG_TREND_PB_EXIT", label: "Trend Pullback — Trade Exit", type: "toggle", effect: EFFECT.INSTANT, desc: "Alert on every Trend Pullback trade exit (paper + live)", default: "true" },

      { key: "TG_EMA_RSI_ST_SIGNALS", label: "EMA_RSI_ST — Signal/Skip Alerts", type: "toggle", effect: EFFECT.INSTANT, desc: "Candle-close alerts when flat (why a EMA_RSI_ST trade was/wasn't taken)", default: "true" },
      { key: "TG_BB_RSI_SIGNALS", label: "BB_RSI — Signal/Skip Alerts", type: "toggle", effect: EFFECT.INSTANT, desc: "Candle-close alerts when flat (why a BB_RSI trade was/wasn't taken)", default: "false" },
      { key: "TG_PA_SIGNALS",    label: "Price Action — Signal/Skip Alerts", type: "toggle", effect: EFFECT.INSTANT, desc: "Candle-close alerts when flat (why a PA trade was/wasn't taken)", default: "false" },
      { key: "TG_EMA9VWAP_SIGNALS", label: "EMA9+VWAP — Signal/Skip Alerts", type: "toggle", effect: EFFECT.INSTANT, desc: "Candle-close alerts when flat (why an EMA9+VWAP trade was/wasn't taken)", default: "false" },

      { key: "TG_EMA_RSI_ST_DAYREPORT", label: "EMA_RSI_ST — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send EMA_RSI_ST day summary (trades, win rate, P&L) when the session is stopped", default: "true" },
      { key: "TG_BB_RSI_DAYREPORT", label: "BB_RSI — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send BB_RSI day summary (trades, win rate, P&L) when the session is stopped", default: "true" },
      { key: "TG_PA_DAYREPORT",    label: "Price Action — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send PA day summary (trades, win rate, P&L) when the session is stopped", default: "true" },
      { key: "TG_ORB_DAYREPORT",      label: "ORB — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send ORB day summary (trades, win rate, P&L) when the session is stopped", default: "true" },
      { key: "TG_EMA9VWAP_DAYREPORT", label: "EMA9+VWAP — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send EMA9+VWAP day summary (trades, win rate, P&L) when the session is stopped", default: "true" },
      { key: "TG_TREND_PB_DAYREPORT", label: "Trend Pullback — Day Report on Stop", type: "toggle", effect: EFFECT.INSTANT, desc: "Send Trend Pullback day summary (trades, win rate, P&L) when the session is stopped", default: "true" },

      { key: "TG_DAYREPORT_CONSOLIDATED", label: "Consolidated Day Report (Market Close)", type: "toggle", effect: EFFECT.INSTANT, desc: "Send one combined end-of-day summary across all modes at 15:30 IST", default: "true" },
    ],
  },
  {
    section: "CHARGES & STT — Trading Costs",
    icon: "💰",
    fields: [
      { key: "STT_OPT_SELL_PCT",       label: "Options STT (%)",      type: "number", min: 0, max: 1,  step: 0.01,  effect: EFFECT.INSTANT, desc: "STT on option sell side (% of premium turnover). Apr 2026: 0.15%", default: "0.15" },
      { key: "STT_FUT_SELL_PCT",       label: "Futures STT (%)",      type: "number", min: 0, max: 1,  step: 0.01,  effect: EFFECT.INSTANT, desc: "STT on futures sell side (% of turnover). Apr 2026: 0.05%", default: "0.05" },
      { key: "EXCHANGE_TXN_OPT_PCT",   label: "Exchange Txn Opt (%)",  type: "number", min: 0, max: 0.5,  step: 0.00001, effect: EFFECT.INSTANT, desc: "NSE options exchange txn (% of premium turnover). Current NSE: 0.03553%", default: "0.03553" },
      { key: "EXCHANGE_TXN_FUT_PCT",   label: "Exchange Txn Fut (%)",  type: "number", min: 0, max: 0.1,  step: 0.00001, effect: EFFECT.INSTANT, desc: "NSE futures exchange txn (% of turnover). Current NSE: 0.00183%", default: "0.00183" },
      { key: "SEBI_CHARGES_PER_CRORE", label: "SEBI Charges (₹/Cr)",  type: "number", min: 0, max: 100, step: 1,     effect: EFFECT.INSTANT, desc: "SEBI turnover fee in ₹ per crore", default: "10" },
      { key: "GST_PCT",               label: "GST (%)",               type: "number", min: 0, max: 30,  step: 1,     effect: EFFECT.INSTANT, desc: "GST on (brokerage + exchange txn + SEBI charges)", default: "18" },
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
      { key: "UI_SHOW_DASHBOARD",      label: "Show Dashboard",            type: "toggle", effect: EFFECT.INSTANT, desc: "Show the top-level 'Dashboard' menu in the sidebar. When off, '/' redirects to Settings.", default: "false", subheader: "Top-level menu items" },
      { key: "UI_SHOW_ALL_BACKTEST",   label: "Show All Backtest",         type: "toggle", effect: EFFECT.INSTANT, desc: "Show the top-level 'Backtest' (all-strategy) menu in the sidebar", default: "true" },
      { key: "UI_SHOW_REALTIME",       label: "Real-Time on Dashboard",    type: "toggle", effect: EFFECT.INSTANT, desc: "When ON, the Dashboard ('/') auto-swaps to the Real-Time monitor whenever any paper/live session is running, and back to the normal dashboard when nothing is running.", default: "true" },
      { key: "UI_DASHBOARD_ANALYTICS_PANEL", label: "Dashboard analytics panel", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the bottom analytics panel on the Dashboard. Market hours: live session P&L per strategy + next expiry. After-hours: last-session breakdown, 7-day rolling stats, next holiday/expiry.", default: "true" },
      { key: "UI_SHOW_REPLAY",         label: "Show Replay",               type: "toggle", effect: EFFECT.INSTANT, desc: "Show the top-level 'Replay' menu in the sidebar (deterministic tick-replay backtest of recorded paper sessions)", default: "true" },
      { key: "UI_SHOW_PAPER_HISTORY",  label: "Show Paper Traded History", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the top-level 'Paper Traded History' menu in the sidebar", default: "true" },
      { key: "UI_SHOW_LIVE_HISTORY",   label: "Show Live Traded History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show the top-level 'Live Traded History' menu in the sidebar", default: "true" },
      { key: "UI_SHOW_EDGE_ANALYTICS", label: "Show Edge Analytics",       type: "toggle", effect: EFFECT.INSTANT, desc: "Show the top-level 'Edge Analytics' menu in the sidebar — win rate / expectancy / profit factor / drawdown / equity curve / best-hour & weekday breakdown over your recorded paper + live trades (read-only).", default: "true" },
      { key: "UI_SHOW_CONSOLIDATION_REPORT", label: "Show Consolidation Report button", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the '📑 Consolidation Report' button on the Edge Analytics page. Opens a day-by-day consolidated report of every recorded paper + live trade (per-strategy P&L + wins/losses + net for each day, à la the Telegram day report), filterable by book / week / month / date range and exportable to PDF. Read-only.", default: "true" },
      { key: "EMA_RSI_ST_MODE_ENABLED",     label: "EMA_RSI_ST Mode",                type: "toggle", effect: EFFECT.INSTANT, desc: "Show the EMA_RSI_ST sidebar group AND the EMA_RSI_ST strategy section in Settings. When off, both are hidden.", default: "true", subheader: "Strategy master toggles" },
      { key: "BB_RSI_MODE_ENABLED",     label: "BB_RSI Mode",                type: "toggle", effect: EFFECT.INSTANT, desc: "Show the BB_RSI sidebar group AND the BB_RSI strategy section in Settings. When off, both are hidden.", default: "true" },
      { key: "PA_MODE_ENABLED",        label: "Price Action Mode",         type: "toggle", effect: EFFECT.INSTANT, desc: "Show the PRICE ACTION sidebar group AND the PA strategy section in Settings. When off, both are hidden.", default: "true" },
      { key: "ORB_MODE_ENABLED",       label: "ORB Mode (Opening Range Breakout)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the ORB sidebar group AND the ORB strategy section in Settings. When off, both are hidden.", default: "true" },
      { key: "EMA9VWAP_MODE_ENABLED",  label: "EMA9+VWAP Mode",            type: "toggle", effect: EFFECT.INSTANT, desc: "Show the EMA9+VWAP sidebar group AND the EMA9+VWAP strategy section in Settings. When off, both are hidden.", default: "true" },
      { key: "TREND_PB_MODE_ENABLED",  label: "Trend Pullback Mode",       type: "toggle", effect: EFFECT.INSTANT, desc: "Show the TREND PULLBACK sidebar group AND the Trend Pullback strategy section in Settings. When off, both are hidden.", default: "true" },
      { key: "UI_SHOW_SIMULATE",       label: "Show Simulate Menu",        type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Simulate' inside EMA_RSI_ST / BB_RSI / Price Action groups in the sidebar", default: "false", subheader: "Shared sub-menus (all strategies)" },
      { key: "UI_SHOW_COMPARE",        label: "Show Compare Menu",         type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Compare' inside EMA_RSI_ST / BB_RSI / Price Action groups in the sidebar", default: "false" },
      { key: "UI_SHOW_TRACKER",        label: "Show Tracker Menu (EMA_RSI_ST only)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Tracker' inside the EMA_RSI_ST group in the sidebar", default: "false" },

      // ── EMA_RSI_ST submenu ──
      { key: "UI_SHOW_EMA_RSI_ST_BACKTEST", label: "EMA_RSI_ST → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Backtest' inside the EMA_RSI_ST group", default: "true", subheader: "EMA_RSI_ST sub-menus" },
      { key: "UI_SHOW_EMA_RSI_ST_PAPER",    label: "EMA_RSI_ST → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Paper' inside the EMA_RSI_ST group",    default: "true" },
      { key: "UI_SHOW_EMA_RSI_ST_LIVE",     label: "EMA_RSI_ST → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Live' inside the EMA_RSI_ST group",     default: "true" },
      { key: "UI_SHOW_EMA_RSI_ST_LIVE_HARNESS", label: "EMA_RSI_ST → Live (Harness)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Live (Harness)' inside the EMA_RSI_ST group — runs LIVE by wrapping PAPER (Zerodha orders), guaranteeing LIVE = PAPER decisions", default: "false" },

      // ── BB_RSI submenu ──
      { key: "UI_SHOW_BB_RSI_BACKTEST", label: "BB_RSI → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Backtest' inside the BB_RSI group", default: "true", subheader: "BB_RSI sub-menus" },
      { key: "UI_SHOW_BB_RSI_PAPER",    label: "BB_RSI → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Paper' inside the BB_RSI group",    default: "true" },
      { key: "UI_SHOW_BB_RSI_LIVE",     label: "BB_RSI → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Live' inside the BB_RSI group",     default: "true" },
      { key: "UI_SHOW_BB_RSI_LIVE_HARNESS", label: "BB_RSI → Live (Harness)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Live (Harness)' inside the BB_RSI group — runs LIVE by wrapping PAPER (Fyers orders), guaranteeing LIVE = PAPER decisions", default: "false" },

      // ── Price Action submenu ──
      { key: "UI_SHOW_PA_BACKTEST",         label: "PA → Backtest",        type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Backtest' inside the Price Action group",     default: "true", subheader: "Price Action sub-menus" },
      { key: "UI_SHOW_PA_PATTERN_BACKTEST", label: "PA → Pattern Test",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Pattern Test' inside the Price Action group", default: "true" },
      { key: "UI_SHOW_PA_PAPER",            label: "PA → Paper",           type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Paper' inside the Price Action group",        default: "true" },
      { key: "UI_SHOW_PA_LIVE",             label: "PA → Live (legacy)",   type: "toggle", effect: EFFECT.INSTANT, desc: "Show legacy 'Live' inside the Price Action group (separate code from paper)", default: "true" },
      { key: "UI_SHOW_PA_LIVE_HARNESS",     label: "PA → Live (Harness)",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Live (Harness)' inside the Price Action group — runs LIVE by wrapping PAPER, guaranteeing LIVE = PAPER decisions", default: "false" },

      // ── ORB submenu ──
      { key: "UI_SHOW_ORB_BACKTEST", label: "ORB → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Backtest' inside the ORB group", default: "true", subheader: "ORB sub-menus" },
      { key: "UI_SHOW_ORB_PAPER",    label: "ORB → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Paper' inside the ORB group", default: "true" },
      { key: "UI_SHOW_ORB_LIVE",     label: "ORB → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Live' inside the ORB group (needs ORB_LIVE_ENABLED to actually start)", default: "true" },
      { key: "UI_SHOW_ORB_LIVE_HARNESS", label: "ORB → Live (Harness)", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Live (Harness)' inside the ORB group — runs LIVE by wrapping PAPER (Fyers orders), guaranteeing LIVE = PAPER decisions", default: "false" },
      { key: "UI_SHOW_ORB_HISTORY",  label: "ORB → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'History' inside the ORB group", default: "true" },

      // ── EMA9+VWAP submenu ──
      { key: "UI_SHOW_EMA9VWAP_BACKTEST", label: "EMA9+VWAP → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Backtest' inside the EMA9+VWAP group", default: "true", subheader: "EMA9+VWAP sub-menus" },
      { key: "UI_SHOW_EMA9VWAP_PAPER",    label: "EMA9+VWAP → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Paper' inside the EMA9+VWAP group", default: "true" },
      { key: "UI_SHOW_EMA9VWAP_LIVE",     label: "EMA9+VWAP → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Live' inside the EMA9+VWAP group — runs LIVE by wrapping PAPER (Zerodha orders), guaranteeing LIVE = PAPER decisions (needs EMA9VWAP_LIVE_ENABLED to actually fire)", default: "true" },
      { key: "UI_SHOW_EMA9VWAP_HISTORY",  label: "EMA9+VWAP → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'History' inside the EMA9+VWAP group", default: "true" },

      // ── Trend Pullback submenu (Paper + History ship in Phase A; Backtest/Live default off until built) ──
      { key: "UI_SHOW_TREND_PB_BACKTEST", label: "Trend Pullback → Backtest", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Backtest' inside the Trend Pullback group — walk-forward OOS folds + dumb-baseline comparison", default: "true", subheader: "Trend Pullback sub-menus" },
      { key: "UI_SHOW_TREND_PB_PAPER",    label: "Trend Pullback → Paper",    type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Paper' inside the Trend Pullback group", default: "true" },
      { key: "UI_SHOW_TREND_PB_LIVE",     label: "Trend Pullback → Live",     type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Live' inside the Trend Pullback group — runs LIVE by wrapping PAPER (Fyers orders), guaranteeing LIVE = PAPER decisions. Real orders need TREND_PB_LIVE_ENABLED=true AND LIVE_HARNESS_DRY_RUN=false; otherwise it's dry-run.", default: "true" },
      { key: "UI_SHOW_TREND_PB_HISTORY",  label: "Trend Pullback → History",  type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'History' inside the Trend Pullback group", default: "true" },

      // ── System submenu (Settings is always shown) ──
      { key: "UI_SHOW_LOGS",       label: "Logs → Server Logs tab", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the '📜 Server Logs' tab in the Logs page (live server-log viewer)", default: "true", subheader: "System sub-menus" },
      { key: "UI_SHOW_TRADE_LOGS", label: "System → Logs", type: "toggle", effect: EFFECT.INSTANT, desc: "Show 'Logs' inside the System group", default: "true" },
      { key: "UI_SHOW_CACHE_FILES", label: "Logs → Cache Files tab", type: "toggle", effect: EFFECT.INSTANT, desc: "Show the '🧰 Cache Files' tab in the Logs page (browse/clear backtest & candle caches, recorded ticks, replay outputs, root state files)", default: "true" },
    ],
  },
  {
    section: "SECURITY & SAFETY — Auth, Rate Limits, Broker Resilience",
    icon: "🔒",
    fields: [
      // ── Credentials ─────────────────────────────────────────────────────────
      { key: "API_SECRET",   label: "App Secret",     type: "password", effect: EFFECT.INSTANT, desc: "Protects action routes (start/stop/exit) & settings page. Leave blank to disable" },
      { key: "LOGIN_SECRET", label: "Login Password", type: "password", effect: EFFECT.INSTANT, desc: "Page-level password gate. Leave blank for open access" },

      // ── Login / session ─────────────────────────────────────────────────────
      { key: "LOGIN_SESSION_MIN",     label: "Login Idle Timeout (min)",      type: "number", min: 5,  max: 240, step: 5,  effect: EFFECT.INSTANT, desc: "Idle minutes before the login cookie expires. Each request slides the timer. Default 15.",                       default: "15" },
      { key: "LOGIN_RATE_MAX",        label: "Login: Max Failed Attempts",    type: "number", min: 1,  max: 50,  step: 1,  effect: EFFECT.INSTANT, desc: "Number of wrong-password attempts allowed per IP before login is rate-limited for the window below. Default 5.", default: "5" },
      { key: "LOGIN_RATE_WINDOW_MIN", label: "Login: Lockout Window (min)",   type: "number", min: 1,  max: 1440, step: 1, effect: EFFECT.INSTANT, desc: "Length of the failed-attempt window for the cap above. Default 15.",                                          default: "15" },

      // ── Write rate limit (POST/PUT/DELETE/PATCH per IP) ─────────────────────
      { key: "WRITE_RATE_PER_MIN", label: "Write Rate (req/min/IP)", type: "number", min: 0,   max: 6000, step: 10, effect: EFFECT.INSTANT, desc: "Per-IP cap on state-changing requests (POST/PUT/DELETE/PATCH). 0 = disabled. Login + deploy webhook have their own gates. Default 120.", default: "120" },
      { key: "WRITE_RATE_BURST",   label: "Write Rate Burst",        type: "number", min: 1,   max: 500,  step: 1,  effect: EFFECT.INSTANT, desc: "Burst bucket size for write rate limit — short spikes up to this many requests are allowed before throttling kicks in. Default 30.",  default: "30"  },

      // ── Broker resilience (circuit breaker + retry) ─────────────────────────
      { key: "BROKER_CB_FAIL_THRESHOLD",     label: "Broker Circuit: Fail Threshold",      type: "number", min: 2, max: 30,  step: 1,  effect: EFFECT.INSTANT, desc: "Consecutive thrown failures (per broker) before the circuit OPENs and calls fail fast. Default 5.",                                       default: "5"  },
      { key: "BROKER_CB_OPEN_SEC",           label: "Broker Circuit: Open Duration (sec)", type: "number", min: 5, max: 600, step: 5,  effect: EFFECT.INSTANT, desc: "Seconds the circuit stays OPEN before allowing a single HALF-OPEN probe. If the probe succeeds it CLOSEs. Default 30.",                    default: "30" },
      { key: "BROKER_RETRY_WRITE_ATTEMPTS",  label: "Order Retry Attempts (writes)",       type: "number", min: 1, max: 4,   step: 1,  effect: EFFECT.INSTANT, desc: "Total attempts for non-idempotent writes (place/modify/cancel/exit). Only retries pre-flight network errors — never double-places an order. Set 1 to disable retry. Default 2.", default: "2" },
      { key: "BROKER_RETRY_READ_ATTEMPTS",   label: "Query Retry Attempts (reads)",        type: "number", min: 1, max: 6,   step: 1,  effect: EFFECT.INSTANT, desc: "Total attempts for idempotent reads (getOrders/getPositions/getFunds) on transient errors. Default 3.",                                  default: "3"  },
      { key: "BROKER_RETRY_BASE_MS",         label: "Retry Base Delay (ms)",               type: "number", min: 50, max: 2000, step: 50, effect: EFFECT.INSTANT, desc: "Base backoff between retries; reads use exp backoff, writes use linear. Default 150.",                                                 default: "150" },
    ],
  },
];

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
};
const SNAPSHOT_COMMON_SECTION_TITLES = new Set([
  "Instrument & Backtest",
  "CHARGES & STT — Trading Costs",
  "OPEN-INTEREST FILTER (OI + Price Buildup)",
]);

const _MODE_KEYS = { ema_rsi_st: new Set(), bb_rsi: new Set(), pa: new Set(), orb: new Set(), ema9vwap: new Set(), trend_pb: new Set() };
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
  "OI_LOOKBACK_CANDLES", "OI_MIN_DELTA_PCT", "OI_FAIL_MODE",
  "INSTRUMENT", "NIFTY_LOT_SIZE", "STRIKE_OFFSET_CE", "STRIKE_OFFSET_PE", "LOT_MULTIPLIER",
  "OPTION_EXPIRY_OVERRIDE", "OPTION_EXPIRY_TYPE",
  "EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE", "EMA_RSI_ST_OPTION_EXPIRY_TYPE",
  "BACKTEST_CAPITAL", "BACKTEST_OPTION_SIM",
  "BACKTEST_DELTA", "BACKTEST_THETA_DAY", "ZERODHA_INV_AMOUNT", "FYERS_INV_AMOUNT",
  "PA_ENABLED",
  "TELEGRAM_CHAT_ID", "TELEGRAM_BOT_TOKEN",
  "TG_ENABLED",
  "TG_EMA_RSI_ST_STARTED", "TG_BB_RSI_STARTED", "TG_PA_STARTED",
  "TG_EMA_RSI_ST_ENTRY",   "TG_BB_RSI_ENTRY",   "TG_PA_ENTRY",
  "TG_EMA_RSI_ST_EXIT",    "TG_BB_RSI_EXIT",    "TG_PA_EXIT",
  "TG_EMA_RSI_ST_SIGNALS", "TG_BB_RSI_SIGNALS", "TG_PA_SIGNALS",
  "TG_EMA_RSI_ST_DAYREPORT", "TG_BB_RSI_DAYREPORT", "TG_PA_DAYREPORT",
  "TG_DAYREPORT_CONSOLIDATED",
  "NIFTY_SPOT_FALLBACK", "CACHE_MAX_DAYS",
  "BB_RSI_ENABLED", "BB_RSI_MODE_ENABLED", "BB_RSI_VIX_ENABLED", "BB_RSI_EXPIRY_DAY_ONLY",
  "API_SECRET", "LOGIN_SECRET", "UI_THEME",
  "UI_SHOW_SIMULATE", "UI_SHOW_COMPARE", "UI_SHOW_TRACKER",
  // EMA_RSI_ST thresholds — read from process.env inside getSignal() / per-tick on every candle
  "RSI_CE_MIN", "RSI_CE_MAX", "RSI_PE_MAX", "RSI_PE_MIN",
  "EMA_RSI_ST_EMA_FAST", "EMA_RSI_ST_EMA_SLOW", "EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED", "EMA_RSI_ST_EMA_FASTEST",
  "EMA_RSI_ST_CLOSE_BEYOND_EMA_ENABLED",
  "EMA_RSI_ST_CANDLE_TRAIL_ENABLED", "EMA_RSI_ST_CANDLE_TRAIL_BARS",
  "EMA_RSI_ST_SUPERTREND_PERIOD", "EMA_RSI_ST_SUPERTREND_MULT",
  "EMA_RSI_ST_STOP_LOSS_PTS", "EMA_RSI_ST_MAX_CONSEC_LOSSES", "EMA_RSI_ST_NEG_CANDLE_LIMIT",
  // Confirmation-candle gates — read live from process.env on every candle/tick
  "EMA_RSI_ST_CONFIRM_CANDLE_ENABLED", "BB_RSI_CONFIRM_CANDLE_ENABLED", "BB_RSI_CONFIRM_OUTSIDE_BAND",
]);

// These are cached as const at module load — need session stop+start
const SESSION_RESTART_KEYS = new Set([
  "MAX_DAILY_LOSS", "MAX_DAILY_TRADES", "OPT_STOP_PCT",
  "EMA_RSI_ST_SL_PAUSE_CANDLES", "EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED", "EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES",
  "EMA_RSI_ST_EOD_EXIT_TIME", "EMA_RSI_ST_LIVE_DRY_RUN",
  "TRADE_RESOLUTION", "TRADE_START_TIME", "TRADE_STOP_TIME",
  "TRADE_ENTRY_START", "TRADE_ENTRY_END",
  "BB_RSI_ENTRY_START", "BB_RSI_ENTRY_END",
  // BB_RSI settings — need session restart
  "BB_RSI_RESOLUTION",
  "BB_RSI_BB_PERIOD", "BB_RSI_BB_STDDEV",
  "BB_RSI_RSI_PERIOD", "BB_RSI_RSI_CE_THRESHOLD",
  "BB_RSI_RSI_PE_THRESHOLD", "BB_RSI_RSI_TURNING",
  "BB_RSI_MAX_ENTRY_SL_PTS",
  "BB_RSI_SUPERTREND_PERIOD", "BB_RSI_SUPERTREND_MULT",
  "BB_RSI_ADX_ENABLED", "BB_RSI_ADX_MIN",
  "BB_RSI_PROFIT_LOCK_TRIGGER_PTS", "BB_RSI_PROFIT_LOCK_PCT", "BB_RSI_STOP_LOSS_PTS", "BB_RSI_BB_REENTRY_EXIT", "BB_RSI_BB_REENTRY_ARM_PTS",
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
const RESET_PAPER_MODES = ["ema_rsi_st", "bb_rsi", "pa", "orb", "ema9vwap", "trend_pb"];
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
    const effBadge = `<span class="effect-badge" style="--ec:${eff.color}" title="${eff.tip}"><span class="effect-icon">${eff.icon}</span>${eff.label}<span class="info-i">i</span></span><span class="env-key-tag">${f.key}</span>`;
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
      return `
        <div class="${rowClass}" ${frozenAttr}>
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <select data-key="${f.key}" ${dis} onchange="markDirty(this)">${opts}</select>
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
      return `
        <div class="${rowClass}" ${frozenAttr}>
          <div class="setting-info">
            <div class="setting-label">${f.label}${effBadge}</div>
            ${descHtml}
          </div>
          <input type="date" data-key="${f.key}" value="${val}" ${dis} onchange="markDirty(this)"/>
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
        if (f.subheader) {
          out.push(`<div class="subgroup-header">${f.subheader}</div>`);
        }
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

  // ── Hide strategy sections when their master toggle is off ──
  const emaRsiStModeOn    = (envData["EMA_RSI_ST_MODE_ENABLED"]    ?? process.env.EMA_RSI_ST_MODE_ENABLED    ?? "true").toLowerCase() === "true";
  const paModeOn       = (envData["PA_MODE_ENABLED"]       ?? process.env.PA_MODE_ENABLED       ?? "true").toLowerCase() === "true";
  const orbModeOn      = (envData["ORB_MODE_ENABLED"]      ?? process.env.ORB_MODE_ENABLED      ?? "true").toLowerCase() === "true";
  const ema9vwapModeOn = (envData["EMA9VWAP_MODE_ENABLED"] ?? process.env.EMA9VWAP_MODE_ENABLED ?? "true").toLowerCase() === "true";
  const trendPbModeOn  = (envData["TREND_PB_MODE_ENABLED"] ?? process.env.TREND_PB_MODE_ENABLED ?? "true").toLowerCase() === "true";
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
  };

  const sectionsHtml = SETTINGS_SCHEMA.map((s, idx) => {
    if (SECTION_TO_MASTER[s.section] === false) return "";
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
    .page { padding: 28px 28px 60px; max-width: 880px; }

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

    /* ── Sub-group header inside a section ─────────────────── */
    .subgroup-header {
      font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1.2px; color: var(--text2);
      padding: 14px 20px 8px;
      background: var(--surface2);
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 10px;
    }
    .subgroup-header::before {
      content:''; display:inline-block;
      width: 3px; height: 12px; border-radius: 2px;
      background: var(--accent);
    }
    .subgroup-header::after {
      content:''; flex: 1; height: 1px; background: var(--border);
    }
    .setting-row + .subgroup-header { margin-top: 4px; }

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
    .subgroup-header.search-miss { display: none !important; }
    .settings-section.search-hidden { display: none !important; }
    .ssb-empty { color: var(--yellow); font-style: italic; }

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

    /* ── Combined Expiry/Holidays modal tabs ───────────────── */
    .eh-tab-btn {
      background: transparent; border: 1px solid transparent; border-bottom: none;
      border-top-left-radius: 7px; border-top-right-radius: 7px;
      padding: 7px 14px; cursor: pointer; color: var(--muted);
      font-size: 0.72rem; font-weight: 700; font-family: 'IBM Plex Mono', monospace;
      letter-spacing: 0.4px; transition: all 0.15s; margin-bottom: -1px;
    }
    .eh-tab-btn:hover { color: var(--text); }
    .eh-tab-btn.eh-tab-active {
      color: #22d3ee; border-color: #1a2640; border-bottom-color: #0d1117;
      background: #0d1117;
    }

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

    /* ── Laptop / small-desktop band (13" MacBook etc.) ──
       The fixed 200px sidebar leaves a narrow content column here and the phone
       rules below don't start until 640px. Collapse the 2-up pattern grid, let
       rows wrap, and give inputs more room so values aren't clipped/squeezed. */
    @media (max-width:1200px) {
      .pattern-grid { grid-template-columns: 1fr; }
      .pattern-grid .setting-row { border-right: none; }
      .setting-row { flex-wrap: wrap; }
      input[type="text"], input[type="number"], input[type="date"], input[type="time"], select { max-width: 360px; }
    }

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

// ── Settings search: filter rows by label / env key / description ──
var _ssbPrevOpenIds = null; // snapshot of which sections were open before search began
function filterSettings(rawQuery) {
  var q = String(rawQuery || '').trim().toLowerCase();
  var bar = document.getElementById('settingsSearchBar');
  var countEl = document.getElementById('settingsSearchCount');

  // Empty query → restore pre-search state
  if (!q) {
    bar.classList.remove('active');
    countEl.textContent = '';
    countEl.classList.remove('ssb-empty');
    document.querySelectorAll('.setting-row.search-hit, .setting-row.search-miss').forEach(function(r){
      r.classList.remove('search-hit', 'search-miss');
    });
    document.querySelectorAll('.settings-section.search-hidden').forEach(function(s){
      s.classList.remove('search-hidden');
    });
    document.querySelectorAll('.subgroup-header.search-miss').forEach(function(h){
      h.classList.remove('search-miss');
    });
    if (_ssbPrevOpenIds) {
      // Restore which sections were open before the search began
      document.querySelectorAll('.settings-section').forEach(function(s){
        var id = s.getAttribute('data-section');
        if (_ssbPrevOpenIds.indexOf(id) !== -1) s.classList.add('open');
        else s.classList.remove('open');
      });
      _ssbPrevOpenIds = null;
    }
    return;
  }

  // First keystroke of a new search → snapshot the currently-open sections
  if (_ssbPrevOpenIds === null) {
    _ssbPrevOpenIds = Array.prototype.map.call(
      document.querySelectorAll('.settings-section.open'),
      function(s){ return s.getAttribute('data-section'); }
    );
  }

  bar.classList.add('active');
  var totalHits = 0;
  var sections = document.querySelectorAll('.settings-section');
  sections.forEach(function(section){
    if (!section.hasAttribute('data-section')) return; // skip Server-Control section
    var rows = section.querySelectorAll('.setting-row');
    var sectionHits = 0;
    rows.forEach(function(row){
      var label = (row.querySelector('.setting-label') || {}).textContent || '';
      var keyTag = (row.querySelector('.env-key-tag') || {}).textContent || '';
      var desc  = (row.querySelector('.field-desc') || {}).textContent || '';
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
    if (sectionHits > 0) {
      section.classList.remove('search-hidden');
      section.classList.add('open'); // auto-expand sections with matches
    } else {
      section.classList.add('search-hidden');
    }
    // Hide subgroup headers whose rows are all misses
    var headers = section.querySelectorAll('.subgroup-header');
    headers.forEach(function(h){
      var anyHit = false;
      var n = h.nextElementSibling;
      while (n && !n.classList.contains('subgroup-header')) {
        if (n.classList.contains('setting-row') && !n.classList.contains('search-miss')) { anyHit = true; break; }
        // also check nested rows (e.g. inside .pattern-grid)
        if (n.querySelector && n.querySelector('.setting-row:not(.search-miss)')) { anyHit = true; break; }
        n = n.nextElementSibling;
      }
      if (anyHit) h.classList.remove('search-miss');
      else h.classList.add('search-miss');
    });
    totalHits += sectionHits;
  });

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
      body.innerHTML = '<tr><td colspan="4" style="padding:10px 8px;color:#5a6c8a;">Disabled.</td></tr>';
      return;
    }
    statusLine.textContent = 'Daily at ' + String(d.hour).padStart(2, '0') + ':00 IST · keeps latest only (new replaces old) · ' + d.backups.length + ' on server';
    if (!d.backups.length) {
      _backupLatestDate = null;
      body.innerHTML = '<tr><td colspan="4" style="padding:10px 8px;color:#5a6c8a;">No snapshots yet — click "Snapshot now".</td></tr>';
      return;
    }
    _backupLatestDate = d.backups[0].date;
    body.innerHTML = d.backups.map(function(b) {
      var status = b.downloaded
        ? '<span style="color:#10b981;">✓ downloaded</span>'
        : '<span style="color:#fbbf24;">⏳ not downloaded</span>';
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
async function backupCreateNow() {
  var btn = document.getElementById('backupCreateBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating…'; }
  try {
    var r = await fetch('/backup/create', { method: 'POST' });
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
    var r = await fetch('/backup/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: date }) });
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
    var r = await fetch('/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: file });
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
function showBackupModal() {
  var m = document.getElementById('backupModal');
  if (!m) return;
  m.style.display = 'block';
  loadBackups();
}
// Refresh the list only while the modal is open.
setInterval(function() {
  var m = document.getElementById('backupModal');
  if (m && m.style.display === 'block') loadBackups();
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
    html += '<div style="margin-top:12px;color:#4a6080;font-size:0.68rem;text-align:center;">Last checked: ' + new Date(d.timestamp).toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata', hour12:false}) + ' IST</div>';
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

async function loadHolidaysTable() {
  var body = document.getElementById('holidayTableBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px;">Loading holidays...</td></tr>';
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
    var n = 0;
    data.holidays.sort().forEach(function(d) {
      if (d < todayStr) return; // hide past holidays
      var mmdd = d.slice(5);
      var name = _holidayNames[mmdd] || '—';
      var dt = new Date(d + 'T00:00:00');
      var dayName = dt.toLocaleDateString('en-US', {weekday:'short'});
      var display = dt.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
      var cls = d === todayStr ? 'today-holiday' : '';
      n++;
      rows += '<tr class="' + cls + '"><td>' + n + '</td><td>' + display + '</td><td>' + dayName + '</td><td>' + name + '</td></tr>';
    });
    if (!n) rows = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px;">No upcoming holidays</td></tr>';
    body.innerHTML = rows;
  } catch(e) {
    body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#ef4444;padding:20px;">Failed to load holidays</td></tr>';
  }
}

// ── NIFTY Expiry Calendar populator ─────────────────────────────────────────
async function loadExpiriesTable() {
  var body = document.getElementById('expiryTableBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px;">Loading expiry dates...</td></tr>';
  try {
    var res = await fetch('/api/expiry-dates', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!data.success || !data.expiries || !data.expiries.length) {
      body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px;">No expiry dates found</td></tr>';
      return;
    }
    var yearEl = document.getElementById('expiryYearTitle');
    if (yearEl) yearEl.textContent = 'NIFTY Options Expiry Calendar ' + data.year;
    var todayStr = new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"})).toISOString().split('T')[0];
    var rows = '';
    var n = 0;
    data.expiries.forEach(function(e) {
      if (e.date < todayStr) return; // hide past expiries
      var dt = new Date(e.date + 'T00:00:00');
      var display = dt.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
      var dayName = dt.toLocaleDateString('en-US', {weekday:'short'});
      var type = e.monthly ? '<span style="color:#3b82f6;font-weight:600;">Monthly</span>' : 'Weekly';
      var actual = display;
      if (e.preponed) {
        var aDt = new Date(e.actual + 'T00:00:00');
        actual = aDt.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
      }
      var cls = e.date === todayStr ? 'today-holiday' : '';
      if (e.monthly) cls += ' monthly-row';
      var preponedNote = e.preponed ? '<span class="preponed" title="Preponed due to holiday"> ⚠ ' + actual + '</span>' : '';
      n++;
      rows += '<tr class="' + cls + '"><td>' + n + '</td><td>' + display + '</td><td>' + dayName + '</td><td>' + type + '</td><td>' + (e.preponed ? preponedNote : '—') + '</td></tr>';
    });
    if (!n) rows = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px;">No upcoming expiry dates</td></tr>';
    body.innerHTML = rows;
  } catch(e) {
    body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:20px;">Failed to load expiry dates</td></tr>';
  }
}

// ── Combined Expiry & Holidays modal (top-bar button) ───────────────────────
function showExpiryHolidaysModal() {
  var modal = document.getElementById('expiryHolidaysModal');
  if (!modal) return;
  modal.style.display = 'block';
  showExpHolTab('expiry');
  loadExpiriesTable();
  loadHolidaysTable();
}
async function refreshHolidays() {
  var btn = document.getElementById('holiday-refresh-btn');
  if (!btn) return;
  var orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ REFRESHING…';
  btn.style.opacity = '0.6';
  try {
    var res = await secretFetch('/api/holidays/refresh', { method: 'POST' });
    btn.disabled = false;
    btn.textContent = orig;
    btn.style.opacity = '1';
    if (!res) return;
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + res.statusText);
    var d = await res.json();
    if (d.success) {
      await showAlert({ icon:'✅', title:'Holidays Refreshed', message:'Fetched ' + d.count + ' holidays from NSE API.\\nCache updated.', btnClass:'modal-btn-success' });
    } else {
      await showAlert({ icon:'⚠️', title:'NSE API Unavailable', message:'NSE API is currently blocking requests or unavailable.\\nUsing fallback holiday list (' + (d.count||17) + ' holidays for 2026).', btnClass:'modal-btn-primary' });
    }
    // reload the table data so the modal reflects the refreshed cache
    loadHolidaysTable();
    loadExpiriesTable();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = orig;
    btn.style.opacity = '1';
    showAlert({ icon:'❌', title:'Network Error', message: err.message + '\\nPlease check your connection and try again.', btnClass:'modal-btn-danger' });
  }
}
function showExpHolTab(tab) {
  var ex = document.getElementById('ehTab-expiry');
  var ho = document.getElementById('ehTab-holiday');
  var bex = document.getElementById('ehBtn-expiry');
  var bho = document.getElementById('ehBtn-holiday');
  if (!ex || !ho || !bex || !bho) return;
  var isExpiry = (tab === 'expiry');
  ex.style.display = isExpiry ? 'block' : 'none';
  ho.style.display = isExpiry ? 'none'  : 'block';
  bex.classList.toggle('eh-tab-active', isExpiry);
  bho.classList.toggle('eh-tab-active', !isExpiry);
}

// ── Section Summary (Eye icon) ─────────────────────────────────────────────
var _sectionSummaries = ${sectionSummaryJSON};
var _schemaDefaults   = ${schemaDefaultsJSON};
var _sectionNames = { 0: 'Trading Strategy (5-min)', 1: 'BB_RSI Strategy (BB+SuperTrend+RSI)' };

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
        <button onclick="document.getElementById('sectionSummaryModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
      </div>
    </div>
    <div id="sectionSummaryBody" style="padding:12px 16px;max-height:70vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#243048 transparent;">
    </div>
  </div>
</div>
<!-- Combined Expiry Calendar + NSE Holidays modal (top-bar button) -->
<div id="expiryHolidaysModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:640px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span style="font-weight:700;font-size:0.95rem;color:#22d3ee;">📅 NIFTY Expiry &amp; NSE Holidays</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="holiday-refresh-btn" type="button" onclick="refreshHolidays()" title="Force-refresh NSE holidays from upstream API" style="padding:5px 12px;background:rgba(34,211,238,0.12);color:#22d3ee;border:1px solid rgba(34,211,238,0.25);border-radius:5px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.3px;">📅 REFRESH</button>
        <button onclick="document.getElementById('expiryHolidaysModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
      </div>
    </div>
    <div style="display:flex;gap:6px;padding:10px 16px 0;border-bottom:1px solid #1a2640;">
      <button id="ehBtn-expiry" type="button" onclick="showExpHolTab('expiry')" class="eh-tab-btn eh-tab-active">Expiry Calendar</button>
      <button id="ehBtn-holiday" type="button" onclick="showExpHolTab('holiday')" class="eh-tab-btn">NSE Holidays</button>
    </div>
    <!-- Expiry tab -->
    <div id="ehTab-expiry">
      <div style="padding:10px 16px 0;">
        <div class="expiry-legend">
          <span><span class="expiry-dot" style="background:#3b82f6;"></span> Monthly expiry</span>
          <span><span class="expiry-dot" style="background:#f59e0b;"></span> Preponed (holiday)</span>
        </div>
      </div>
      <div class="holiday-modal-body" style="padding:0 16px 16px;">
        <table class="holiday-table">
          <thead><tr><th>#</th><th>Expiry Date</th><th>Day</th><th>Type</th><th>Preponed To</th></tr></thead>
          <tbody id="expiryTableBody"></tbody>
        </table>
      </div>
    </div>
    <!-- Holiday tab -->
    <div id="ehTab-holiday" style="display:none;">
      <div class="holiday-modal-body" style="padding:12px 16px 16px;">
        <table class="holiday-table">
          <thead><tr><th>#</th><th>Date</th><th>Day</th><th>Holiday</th></tr></thead>
          <tbody id="holidayTableBody"></tbody>
        </table>
      </div>
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
<!-- Backup & Restore modal -->
<div id="backupModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;padding:40px 20px;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:720px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span style="font-weight:700;font-size:0.95rem;color:#34d399;">📦 Backup &amp; Restore</span>
      <button onclick="document.getElementById('backupModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
    </div>
    <div style="padding:18px 20px 20px;max-height:74vh;overflow-y:auto;">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:12px;">
        <div style="flex:1;min-width:240px;">
          <div style="font-size:0.7rem;color:#7e93b5;line-height:1.5;">
            Self-contained <code style="color:#9dc1f0;">.tar.gz</code> of <code style="color:#9dc1f0;">~/trading-data</code> + recorded ticks
            (caches &amp; OAuth tokens excluded). Download today's copy locally so an EC2 loss never loses data.
            A banner nags on every page until you've downloaded the day's file.
          </div>
          <div id="backup-status-line" style="font-size:0.7rem;color:#7e93b5;margin-top:8px;">Loading…</div>
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
          <tbody id="backupListBody"><tr><td colspan="4" style="padding:10px 8px;color:#5a6c8a;">Loading…</td></tr></tbody>
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
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid #1a2640;">
        <div style="font-size:0.78rem;font-weight:700;color:#f59e0b;margin-bottom:6px;">⟲ Restore from a backup file</div>
        <div style="font-size:0.68rem;color:#7e93b5;line-height:1.5;margin-bottom:10px;">
          Upload a <code style="color:#9dc1f0;">backup-*.tar.gz</code> to restore it here — no SSH needed.
          This <b style="color:#f59e0b;">overwrites</b> <code style="color:#9dc1f0;">~/trading-data</code> and <code style="color:#9dc1f0;">data/ticks</code> on the server.
          A safety snapshot of current data is taken first, and restore is blocked while any session is running.
          A server restart is recommended afterwards.
        </div>
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
      <button onclick="document.getElementById('bulkModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
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
        <button onclick="document.getElementById('healthModal').style.display='none'" style="background:none;border:none;color:#4a6080;font-size:1.2rem;cursor:pointer;">&times;</button>
      </div>
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
    return res.status(401).send(`<!DOCTYPE html><html><body style="font-family:monospace;background:#040c18;color:#c8d8f0;padding:40px;">
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
    if (v === null || v === undefined) return `<span style="color:#4a6080;">∅</span>`;
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
      <td style="color:#64748b;font-size:0.7rem;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(e.commit_subject || e.ua || "")}">${escapeHtml(e.commit_subject || e.ua || "")}</td>
    </tr>
  `).join("");

  // Action counts for the badge bar (over the filtered set)
  const counts = entries.reduce((m, e) => { m[e.action] = (m[e.action] || 0) + 1; return m; }, {});
  const totalLine = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}` +
    (counts.update ? ` · <span style="color:#f59e0b;">${counts.update} updated</span>` : "") +
    (counts.add ? ` · <span style="color:#10b981;">${counts.add} added</span>` : "") +
    (counts.delete ? ` · <span style="color:#ef4444;">${counts.delete} deleted</span>` : "");

  const secret = req.query.secret || "";

  res.send(`<!DOCTYPE html><html><head>
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
.audit-header .sub{font-size:0.72rem;color:#4a6080;margin-top:4px;}
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
.empty{text-align:center;padding:40px;color:#4a6080;font-size:0.8rem;}
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

module.exports = router;

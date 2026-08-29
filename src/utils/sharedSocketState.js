/**
 * sharedSocketState.js
 * ─────────────────────────────────────────────────────────────
 * Tracks which modes are currently using the socket.
 *
 * RULES:
 * - EMA_RSI_ST_PAPER and EMA_RSI_ST_LIVE are mutually exclusive (same 15-min strategy)
 * - BB_RSI_LIVE and BB_RSI_PAPER are mutually exclusive (same 3-min strategy)
 * - EMA_RSI_ST_LIVE + BB_RSI_LIVE can run in parallel (different brokers, different timeframes)
 * - EMA_RSI_ST_PAPER + BB_RSI_PAPER can run in parallel
 *
 * The primary mode (EMA_RSI_ST_PAPER | EMA_RSI_ST_LIVE) owns the socket start/stop.
 * BB_RSI modes piggyback on the socket via addCallback/removeCallback.
 * If no primary mode is running, bb_rsi can start the socket itself.
 * ─────────────────────────────────────────────────────────────
 */

// Primary mode: "EMA_RSI_ST_PAPER" | "EMA_RSI_ST_LIVE" | null
let primaryMode = null;

// BB_RSI mode: "BB_RSI_LIVE" | "BB_RSI_PAPER" | null
let bbRsiMode = null;

// Price Action mode: "PA_LIVE" | "PA_PAPER" | null
let paMode = null;

// ORB (Opening Range Breakout) mode: "ORB_PAPER" | null
let orbMode = null;

// EMA9+VWAP mode: "EMA9VWAP_PAPER" | "EMA9VWAP_LIVE" | null
let ema9vwapMode = null;

// Trend Pullback mode: "TREND_PB_PAPER" | "TREND_PB_LIVE" | null
let trendPbMode = null;

// GAPS mode: "GAPS_PAPER" | "GAPS_LIVE" | null
let gapsMode = null;

// Trend Day Scalp mode: "TREND_DAY_SCALP_PAPER" | "TREND_DAY_SCALP_LIVE" | null
let trendDayScalpMode = null;

// 3M Gap Fix Scalp mode: "GAP_FIX_3M_PAPER" | "GAP_FIX_3M_LIVE" | null
let gapFix3mMode = null;

// HA Scalp mode: "HA_SCALP_PAPER" | "HA_SCALP_LIVE" | null
let haScalpMode = null;


// RSI Pivot SuperTrend mode: "RSI_PIVOT_ST_PAPER" | "RSI_PIVOT_ST_LIVE" | null
let rsiPivotStMode = null;

// SIMPLE_9:30 mode: "SIMPLE930_PAPER" | "SIMPLE930_LIVE" | null
let simple930Mode = null;

// ── Primary mode (15-min) ─────────────────────────────────────────────────

function setActive(mode) {
  primaryMode = mode;
}

function clear() {
  primaryMode = null;
}

function isActive() {
  return primaryMode !== null;
}

function getMode() {
  return primaryMode;
}

// ── BB_RSI mode (3-min) ────────────────────────────────────────────────────

function setBbRsiActive(mode) {
  bbRsiMode = mode;
}

function clearBbRsi() {
  bbRsiMode = null;
}

function isBbRsiActive() {
  return bbRsiMode !== null;
}

function getBbRsiMode() {
  return bbRsiMode;
}

// ── Price Action mode (5-min) ─────────────────────────────────────────────

function setPAActive(mode) {
  paMode = mode;
}

function clearPA() {
  paMode = null;
}

function isPAActive() {
  return paMode !== null;
}

function getPAMode() {
  return paMode;
}

// ── ORB mode (paper only for v1) ──────────────────────────────────────────

function setOrbActive(mode) {
  orbMode = mode;
}

function clearOrb() {
  orbMode = null;
}

function isOrbActive() {
  return orbMode !== null;
}

function getOrbMode() {
  return orbMode;
}

// ── EMA9+VWAP mode (5-min, secondary socket callback) ─────────────────────

function setEma9VwapActive(mode) {
  ema9vwapMode = mode;
}

function clearEma9Vwap() {
  ema9vwapMode = null;
}

function isEma9VwapActive() {
  return ema9vwapMode !== null;
}

function getEma9VwapMode() {
  return ema9vwapMode;
}

// ── Trend Pullback mode (5-min, secondary socket callback) ────────────────

function setTrendPbActive(mode) {
  trendPbMode = mode;
}

function clearTrendPb() {
  trendPbMode = null;
}

function isTrendPbActive() {
  return trendPbMode !== null;
}

function getTrendPbMode() {
  return trendPbMode;
}

// ── GAPS mode (daily signal, intraday exits — secondary socket callback) ──

function setGapsActive(mode) {
  gapsMode = mode;
}

function clearGaps() {
  gapsMode = null;
}

function isGapsActive() {
  return gapsMode !== null;
}

function getGapsMode() {
  return gapsMode;
}

// ── Trend Day Scalp mode (5-min, day-gated) ─────────────────────────────────

function setTrendDayScalpActive(mode) {
  trendDayScalpMode = mode;
}

function clearTrendDayScalp() {
  trendDayScalpMode = null;
}

function isTrendDayScalpActive() {
  return trendDayScalpMode !== null;
}

function getTrendDayScalpMode() {
  return trendDayScalpMode;
}

// ── 3M Gap Fix Scalp mode (3-min futures gap fade) ──────────────────────────

function setGapFix3mActive(mode) {
  gapFix3mMode = mode;
}

function clearGapFix3m() {
  gapFix3mMode = null;
}

function isGapFix3mActive() {
  return gapFix3mMode !== null;
}

function getGapFix3mMode() {
  return gapFix3mMode;
}

// ── HA Scalp mode (15-min Heikin Ashi trend scalp) ──────────────────────────

function setHaScalpActive(mode) {
  haScalpMode = mode;
}

function clearHaScalp() {
  haScalpMode = null;
}

function isHaScalpActive() {
  return haScalpMode !== null;
}

function getHaScalpMode() {
  return haScalpMode;
}


// ── RSI Pivot SuperTrend mode ───────────────────────────────────────────────

function setRsiPivotStActive(mode) {
  rsiPivotStMode = mode;
}

function clearRsiPivotSt() {
  rsiPivotStMode = null;
}

function isRsiPivotStActive() {
  return rsiPivotStMode !== null;
}

function getRsiPivotStMode() {
  return rsiPivotStMode;
}

// ── SIMPLE_9:30 mode (9:30 option-premium trigger) ──────────────────────────

function setSimple930Active(mode) {
  simple930Mode = mode;
}

function clearSimple930() {
  simple930Mode = null;
}

function isSimple930Active() {
  return simple930Mode !== null;
}

function getSimple930Mode() {
  return simple930Mode;
}

// ── Combined queries ──────────────────────────────────────────────────────

/** Any mode using the socket? */
function isAnyActive() {
  return primaryMode !== null || bbRsiMode !== null || paMode !== null ||
         orbMode !== null || ema9vwapMode !== null || trendPbMode !== null ||
         gapsMode !== null || trendDayScalpMode !== null || gapFix3mMode !== null ||
         haScalpMode !== null ||
         rsiPivotStMode !== null || simple930Mode !== null;
}

/** Can the given mode start? Returns { allowed, reason } */
function canStart(mode) {
  switch (mode) {
    case "EMA_RSI_ST_LIVE":
      if (primaryMode === "EMA_RSI_ST_PAPER") return { allowed: false, reason: "Paper Trade is running — stop it first" };
      if (primaryMode === "EMA_RSI_ST_LIVE")  return { allowed: false, reason: "Live Trade is already running" };
      return { allowed: true };
    case "EMA_RSI_ST_PAPER":
      if (primaryMode === "EMA_RSI_ST_LIVE")  return { allowed: false, reason: "Live Trade is running — stop it first" };
      if (primaryMode === "EMA_RSI_ST_PAPER") return { allowed: false, reason: "Paper Trade is already running" };
      return { allowed: true };
    case "BB_RSI_LIVE":
      if (bbRsiMode === "BB_RSI_PAPER") return { allowed: false, reason: "BB_RSI Paper is running — stop it first" };
      if (bbRsiMode === "BB_RSI_LIVE")  return { allowed: false, reason: "BB_RSI Live is already running" };
      return { allowed: true };
    case "BB_RSI_PAPER":
      if (bbRsiMode === "BB_RSI_LIVE")  return { allowed: false, reason: "BB_RSI Live is running — stop it first" };
      if (bbRsiMode === "BB_RSI_PAPER") return { allowed: false, reason: "BB_RSI Paper is already running" };
      return { allowed: true };
    case "PA_LIVE":
      if (paMode === "PA_PAPER") return { allowed: false, reason: "Price Action Paper is running — stop it first" };
      if (paMode === "PA_LIVE")  return { allowed: false, reason: "Price Action Live is already running" };
      return { allowed: true };
    case "PA_PAPER":
      if (paMode === "PA_LIVE")  return { allowed: false, reason: "Price Action Live is running — stop it first" };
      if (paMode === "PA_PAPER") return { allowed: false, reason: "Price Action Paper is already running" };
      return { allowed: true };
    case "ORB_PAPER":
      if (orbMode === "ORB_PAPER") return { allowed: false, reason: "ORB Paper is already running" };
      if (orbMode === "ORB_LIVE")  return { allowed: false, reason: "ORB Live is running — stop it first" };
      return { allowed: true };
    case "ORB_LIVE":
      if (orbMode === "ORB_PAPER") return { allowed: false, reason: "ORB Paper is running — stop it first" };
      if (orbMode === "ORB_LIVE")  return { allowed: false, reason: "ORB Live is already running" };
      return { allowed: true };
    case "EMA9VWAP_PAPER":
      if (ema9vwapMode === "EMA9VWAP_LIVE")  return { allowed: false, reason: "EMA9+VWAP Live is running — stop it first" };
      if (ema9vwapMode === "EMA9VWAP_PAPER") return { allowed: false, reason: "EMA9+VWAP Paper is already running" };
      return { allowed: true };
    case "EMA9VWAP_LIVE":
      if (ema9vwapMode === "EMA9VWAP_PAPER") return { allowed: false, reason: "EMA9+VWAP Paper is running — stop it first" };
      if (ema9vwapMode === "EMA9VWAP_LIVE")  return { allowed: false, reason: "EMA9+VWAP Live is already running" };
      return { allowed: true };
    case "TREND_PB_PAPER":
      if (trendPbMode === "TREND_PB_LIVE")  return { allowed: false, reason: "Trend Pullback Live is running — stop it first" };
      if (trendPbMode === "TREND_PB_PAPER") return { allowed: false, reason: "Trend Pullback Paper is already running" };
      return { allowed: true };
    case "TREND_PB_LIVE":
      if (trendPbMode === "TREND_PB_PAPER") return { allowed: false, reason: "Trend Pullback Paper is running — stop it first" };
      if (trendPbMode === "TREND_PB_LIVE")  return { allowed: false, reason: "Trend Pullback Live is already running" };
      return { allowed: true };
    case "GAPS_PAPER":
      if (gapsMode === "GAPS_LIVE")  return { allowed: false, reason: "GAPS Live is running — stop it first" };
      if (gapsMode === "GAPS_PAPER") return { allowed: false, reason: "GAPS Paper is already running" };
      return { allowed: true };
    case "GAPS_LIVE":
      if (gapsMode === "GAPS_PAPER") return { allowed: false, reason: "GAPS Paper is running — stop it first" };
      if (gapsMode === "GAPS_LIVE")  return { allowed: false, reason: "GAPS Live is already running" };
      return { allowed: true };
    case "TREND_DAY_SCALP_PAPER":
      if (trendDayScalpMode === "TREND_DAY_SCALP_LIVE")  return { allowed: false, reason: "Trend Day Scalp Live is running — stop it first" };
      if (trendDayScalpMode === "TREND_DAY_SCALP_PAPER") return { allowed: false, reason: "Trend Day Scalp Paper is already running" };
      return { allowed: true };
    case "TREND_DAY_SCALP_LIVE":
      if (trendDayScalpMode === "TREND_DAY_SCALP_PAPER") return { allowed: false, reason: "Trend Day Scalp Paper is running — stop it first" };
      if (trendDayScalpMode === "TREND_DAY_SCALP_LIVE")  return { allowed: false, reason: "Trend Day Scalp Live is already running" };
      return { allowed: true };
    case "GAP_FIX_3M_PAPER":
      if (gapFix3mMode === "GAP_FIX_3M_LIVE")  return { allowed: false, reason: "3M Gap Fix Scalp Live is running — stop it first" };
      if (gapFix3mMode === "GAP_FIX_3M_PAPER") return { allowed: false, reason: "3M Gap Fix Scalp Paper is already running" };
      return { allowed: true };
    case "GAP_FIX_3M_LIVE":
      if (gapFix3mMode === "GAP_FIX_3M_PAPER") return { allowed: false, reason: "3M Gap Fix Scalp Paper is running — stop it first" };
      if (gapFix3mMode === "GAP_FIX_3M_LIVE")  return { allowed: false, reason: "3M Gap Fix Scalp Live is already running" };
      return { allowed: true };
    case "HA_SCALP_PAPER":
      if (haScalpMode === "HA_SCALP_LIVE")  return { allowed: false, reason: "HA Scalp Live is running — stop it first" };
      if (haScalpMode === "HA_SCALP_PAPER") return { allowed: false, reason: "HA Scalp Paper is already running" };
      return { allowed: true };
    case "HA_SCALP_LIVE":
      if (haScalpMode === "HA_SCALP_PAPER") return { allowed: false, reason: "HA Scalp Paper is running — stop it first" };
      if (haScalpMode === "HA_SCALP_LIVE")  return { allowed: false, reason: "HA Scalp Live is already running" };
      return { allowed: true };
    case "RSI_PIVOT_ST_PAPER":
      if (rsiPivotStMode === "RSI_PIVOT_ST_LIVE")  return { allowed: false, reason: "RSI Pivot ST Live is running — stop it first" };
      if (rsiPivotStMode === "RSI_PIVOT_ST_PAPER") return { allowed: false, reason: "RSI Pivot ST Paper is already running" };
      return { allowed: true };
    case "RSI_PIVOT_ST_LIVE":
      if (rsiPivotStMode === "RSI_PIVOT_ST_PAPER") return { allowed: false, reason: "RSI Pivot ST Paper is running — stop it first" };
      if (rsiPivotStMode === "RSI_PIVOT_ST_LIVE")  return { allowed: false, reason: "RSI Pivot ST Live is already running" };
      return { allowed: true };
    case "SIMPLE930_PAPER":
      if (simple930Mode === "SIMPLE930_LIVE")  return { allowed: false, reason: "SIMPLE_9:30 Live is running — stop it first" };
      if (simple930Mode === "SIMPLE930_PAPER") return { allowed: false, reason: "SIMPLE_9:30 Paper is already running" };
      return { allowed: true };
    case "SIMPLE930_LIVE":
      if (simple930Mode === "SIMPLE930_PAPER") return { allowed: false, reason: "SIMPLE_9:30 Paper is running — stop it first" };
      if (simple930Mode === "SIMPLE930_LIVE")  return { allowed: false, reason: "SIMPLE_9:30 Live is already running" };
      return { allowed: true };
    default:
      return { allowed: false, reason: "Unknown mode: " + mode };
  }
}

module.exports = {
  // Primary (backward compatible)
  setActive, clear, isActive, getMode,
  // BB_RSI
  setBbRsiActive, clearBbRsi, isBbRsiActive, getBbRsiMode,
  // Price Action
  setPAActive, clearPA, isPAActive, getPAMode,
  // ORB
  setOrbActive, clearOrb, isOrbActive, getOrbMode,
  // EMA9+VWAP
  setEma9VwapActive, clearEma9Vwap, isEma9VwapActive, getEma9VwapMode,
  // Trend Pullback
  setTrendPbActive, clearTrendPb, isTrendPbActive, getTrendPbMode,
  // GAPS
  setGapsActive, clearGaps, isGapsActive, getGapsMode,
  // Trend Day Scalp
  setTrendDayScalpActive, clearTrendDayScalp, isTrendDayScalpActive, getTrendDayScalpMode,
  // 3M Gap Fix Scalp
  setGapFix3mActive, clearGapFix3m, isGapFix3mActive, getGapFix3mMode,
  // HA Scalp
  setHaScalpActive, clearHaScalp, isHaScalpActive, getHaScalpMode,
  // RSI Pivot SuperTrend
  setRsiPivotStActive, clearRsiPivotSt, isRsiPivotStActive, getRsiPivotStMode,
  // SIMPLE_9:30
  setSimple930Active, clearSimple930, isSimple930Active, getSimple930Mode,
  // Combined
  isAnyActive, canStart,
};

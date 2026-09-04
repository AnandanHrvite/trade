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


// Trend Day Scalp mode: "TREND_DAY_SCALP_PAPER" | "TREND_DAY_SCALP_LIVE" | null
let trendDayScalpMode = null;


// HA Scalp mode: "HA_SCALP_PAPER" | "HA_SCALP_LIVE" | null
let haScalpMode = null;


// RSI Pivot SuperTrend mode: "RSI_PIVOT_ST_PAPER" | "RSI_PIVOT_ST_LIVE" | null
let rsiPivotStMode = null;

// BN Pivot RSI SuperTrend mode (NIFTY BANK):
//   "BN_PIVOT_RSI_ST_PAPER" | "BN_PIVOT_RSI_ST_LIVE" | null
// Deliberately its OWN slot, independent of rsiPivotStMode: BN_PIVOT_RSI_ST is
// the same rules on a DIFFERENT underlying (NIFTY BANK vs NIFTY 50), so the two
// may run side by side. Only paper-vs-live within BN is mutually exclusive.
let bnPivotRsiStMode = null;

// EMA_RSI_ST_V2 mode: "EMA_RSI_ST_V2_PAPER" | "EMA_RSI_ST_V2_LIVE" | null
// Its OWN slot, deliberately independent of `primaryMode` (which carries V1's
// EMA_RSI_ST_PAPER/LIVE). V2 is a separate strategy with its own rules, its own
// settings and its own position file — the two are free to run side by side.
// Only paper-vs-live WITHIN V2 is mutually exclusive.
let emaRsiStV2Mode = null;

// BN_EMA_RSI_ST_V2 mode (NIFTY BANK):
//   "BN_EMA_RSI_ST_V2_PAPER" | "BN_EMA_RSI_ST_V2_LIVE" | null
// Its OWN slot, deliberately independent of emaRsiStV2Mode: this is the SAME
// engine on a DIFFERENT underlying (NIFTY BANK vs NIFTY 50), so the two may run
// side by side. Only paper-vs-live WITHIN the BN strategy is mutually exclusive.
let bnEmaRsiStV2Mode = null;

// EarlyBird mode: "EARLY_BIRD_PAPER" | "EARLY_BIRD_LIVE" | null
let earlyBirdMode = null;

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


// ── EarlyBird mode (first-15-min cash-equity breakout) ──────────────────────

function setEarlyBirdActive(mode) {
  earlyBirdMode = mode;
}

function clearEarlyBird() {
  earlyBirdMode = null;
}

function isEarlyBirdActive() {
  return earlyBirdMode !== null;
}

function getEarlyBirdMode() {
  return earlyBirdMode;
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

// ── BN Pivot RSI SuperTrend mode (NIFTY BANK) ───────────────────────────────

function setBnPivotRsiStMode(mode) {
  bnPivotRsiStMode = mode;
}

function clearBnPivotRsiStMode() {
  bnPivotRsiStMode = null;
}

function isBnPivotRsiStActive() {
  return bnPivotRsiStMode !== null;
}

function getBnPivotRsiStMode() {
  return bnPivotRsiStMode;
}

// ── EMA_RSI_ST_V2 mode ──────────────────────────────────────────────────────

function setEmaRsiStV2Mode(mode) {
  emaRsiStV2Mode = mode;
}

function clearEmaRsiStV2Mode() {
  emaRsiStV2Mode = null;
}

function isEmaRsiStV2Active() {
  return emaRsiStV2Mode !== null;
}

function getEmaRsiStV2Mode() {
  return emaRsiStV2Mode;
}

// ── BN_EMA_RSI_ST_V2 mode (NIFTY BANK) ──────────────────────────────────────

function setBnEmaRsiStV2Mode(mode) {
  bnEmaRsiStV2Mode = mode;
}

function clearBnEmaRsiStV2Mode() {
  bnEmaRsiStV2Mode = null;
}

function isBnEmaRsiStV2Active() {
  return bnEmaRsiStV2Mode !== null;
}

function getBnEmaRsiStV2Mode() {
  return bnEmaRsiStV2Mode;
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
         trendDayScalpMode !== null ||
         haScalpMode !== null ||
         earlyBirdMode !== null ||
         rsiPivotStMode !== null || bnPivotRsiStMode !== null ||
         emaRsiStV2Mode !== null ||
         bnEmaRsiStV2Mode !== null ||
         simple930Mode !== null;
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
    case "TREND_DAY_SCALP_PAPER":
      if (trendDayScalpMode === "TREND_DAY_SCALP_LIVE")  return { allowed: false, reason: "Trend Day Scalp Live is running — stop it first" };
      if (trendDayScalpMode === "TREND_DAY_SCALP_PAPER") return { allowed: false, reason: "Trend Day Scalp Paper is already running" };
      return { allowed: true };
    case "TREND_DAY_SCALP_LIVE":
      if (trendDayScalpMode === "TREND_DAY_SCALP_PAPER") return { allowed: false, reason: "Trend Day Scalp Paper is running — stop it first" };
      if (trendDayScalpMode === "TREND_DAY_SCALP_LIVE")  return { allowed: false, reason: "Trend Day Scalp Live is already running" };
      return { allowed: true };
    case "HA_SCALP_PAPER":
      if (haScalpMode === "HA_SCALP_LIVE")  return { allowed: false, reason: "HA Scalp Live is running — stop it first" };
      if (haScalpMode === "HA_SCALP_PAPER") return { allowed: false, reason: "HA Scalp Paper is already running" };
      return { allowed: true };
    case "HA_SCALP_LIVE":
      if (haScalpMode === "HA_SCALP_PAPER") return { allowed: false, reason: "HA Scalp Paper is running — stop it first" };
      if (haScalpMode === "HA_SCALP_LIVE")  return { allowed: false, reason: "HA Scalp Live is already running" };
      return { allowed: true };
    case "EARLY_BIRD_PAPER":
      if (earlyBirdMode === "EARLY_BIRD_LIVE")  return { allowed: false, reason: "EarlyBird Live is running — stop it first" };
      if (earlyBirdMode === "EARLY_BIRD_PAPER") return { allowed: false, reason: "EarlyBird Paper is already running" };
      return { allowed: true };
    case "EARLY_BIRD_LIVE":
      if (earlyBirdMode === "EARLY_BIRD_PAPER") return { allowed: false, reason: "EarlyBird Paper is running — stop it first" };
      if (earlyBirdMode === "EARLY_BIRD_LIVE")  return { allowed: false, reason: "EarlyBird Live is already running" };
      return { allowed: true };
    case "RSI_PIVOT_ST_PAPER":
      if (rsiPivotStMode === "RSI_PIVOT_ST_LIVE")  return { allowed: false, reason: "RSI Pivot ST Live is running — stop it first" };
      if (rsiPivotStMode === "RSI_PIVOT_ST_PAPER") return { allowed: false, reason: "RSI Pivot ST Paper is already running" };
      return { allowed: true };
    case "RSI_PIVOT_ST_LIVE":
      if (rsiPivotStMode === "RSI_PIVOT_ST_PAPER") return { allowed: false, reason: "RSI Pivot ST Paper is running — stop it first" };
      if (rsiPivotStMode === "RSI_PIVOT_ST_LIVE")  return { allowed: false, reason: "RSI Pivot ST Live is already running" };
      return { allowed: true };
    // BN_PIVOT_RSI_ST is NIFTY BANK — a different underlying from RSI_PIVOT_ST,
    // so it is checked ONLY against its own sibling. The two strategies are free
    // to run at the same time.
    case "BN_PIVOT_RSI_ST_PAPER":
      if (bnPivotRsiStMode === "BN_PIVOT_RSI_ST_LIVE")  return { allowed: false, reason: "BN Pivot RSI ST Live is running — stop it first" };
      if (bnPivotRsiStMode === "BN_PIVOT_RSI_ST_PAPER") return { allowed: false, reason: "BN Pivot RSI ST Paper is already running" };
      return { allowed: true };
    case "BN_PIVOT_RSI_ST_LIVE":
      if (bnPivotRsiStMode === "BN_PIVOT_RSI_ST_PAPER") return { allowed: false, reason: "BN Pivot RSI ST Paper is running — stop it first" };
      if (bnPivotRsiStMode === "BN_PIVOT_RSI_ST_LIVE")  return { allowed: false, reason: "BN Pivot RSI ST Live is already running" };
      return { allowed: true };
    // EMA_RSI_ST_V2 is checked ONLY against its own sibling — it is a separate
    // strategy from EMA_RSI_ST (V1), not another mode of it, so V1 and V2 may
    // run at the same time.
    case "EMA_RSI_ST_V2_PAPER":
      if (emaRsiStV2Mode === "EMA_RSI_ST_V2_LIVE")  return { allowed: false, reason: "EMA_RSI_ST_V2 Live is running — stop it first" };
      if (emaRsiStV2Mode === "EMA_RSI_ST_V2_PAPER") return { allowed: false, reason: "EMA_RSI_ST_V2 Paper is already running" };
      return { allowed: true };
    case "EMA_RSI_ST_V2_LIVE":
      if (emaRsiStV2Mode === "EMA_RSI_ST_V2_PAPER") return { allowed: false, reason: "EMA_RSI_ST_V2 Paper is running — stop it first" };
      if (emaRsiStV2Mode === "EMA_RSI_ST_V2_LIVE")  return { allowed: false, reason: "EMA_RSI_ST_V2 Live is already running" };
      return { allowed: true };
    // BN_EMA_RSI_ST_V2 is NIFTY BANK — the same engine as EMA_RSI_ST_V2 on a
    // DIFFERENT underlying, so it is checked ONLY against its own sibling. The
    // NIFTY and NIFTY BANK versions are free to run at the same time.
    case "BN_EMA_RSI_ST_V2_PAPER":
      if (bnEmaRsiStV2Mode === "BN_EMA_RSI_ST_V2_LIVE")  return { allowed: false, reason: "BN_EMA_RSI_ST_V2 Live is running — stop it first" };
      if (bnEmaRsiStV2Mode === "BN_EMA_RSI_ST_V2_PAPER") return { allowed: false, reason: "BN_EMA_RSI_ST_V2 Paper is already running" };
      return { allowed: true };
    case "BN_EMA_RSI_ST_V2_LIVE":
      if (bnEmaRsiStV2Mode === "BN_EMA_RSI_ST_V2_PAPER") return { allowed: false, reason: "BN_EMA_RSI_ST_V2 Paper is running — stop it first" };
      if (bnEmaRsiStV2Mode === "BN_EMA_RSI_ST_V2_LIVE")  return { allowed: false, reason: "BN_EMA_RSI_ST_V2 Live is already running" };
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
  // Trend Day Scalp
  setTrendDayScalpActive, clearTrendDayScalp, isTrendDayScalpActive, getTrendDayScalpMode,
  // HA Scalp
  setHaScalpActive, clearHaScalp, isHaScalpActive, getHaScalpMode,
  // RSI Pivot SuperTrend
  setEarlyBirdActive, clearEarlyBird, isEarlyBirdActive, getEarlyBirdMode,

  setRsiPivotStActive, clearRsiPivotSt, isRsiPivotStActive, getRsiPivotStMode,
  // BN Pivot RSI SuperTrend (NIFTY BANK)
  setBnPivotRsiStMode, clearBnPivotRsiStMode, isBnPivotRsiStActive, getBnPivotRsiStMode,
  // EMA_RSI_ST_V2
  setEmaRsiStV2Mode, clearEmaRsiStV2Mode, isEmaRsiStV2Active, getEmaRsiStV2Mode,
  // BN_EMA_RSI_ST_V2 (NIFTY BANK)
  setBnEmaRsiStV2Mode, clearBnEmaRsiStV2Mode, isBnEmaRsiStV2Active, getBnEmaRsiStV2Mode,
  // SIMPLE_9:30
  setSimple930Active, clearSimple930, isSimple930Active, getSimple930Mode,
  // Combined
  isAnyActive, canStart,
};

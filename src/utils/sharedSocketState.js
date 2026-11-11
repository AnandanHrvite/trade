/**
 * sharedSocketState.js
 * ─────────────────────────────────────────────────────────────
 * Tracks which modes are currently using the socket.
 *
 * RULES:
 * - Each strategy has its own slot; a second start of the same slot is refused
 * - EMA_RSI_ST_PAPER + BB_RSI_PAPER can run in parallel
 *
 * The primary mode (EMA_RSI_ST_PAPER) owns the socket start/stop.
 * BB_RSI modes piggyback on the socket via addCallback/removeCallback.
 * If no primary mode is running, bb_rsi can start the socket itself.
 * ─────────────────────────────────────────────────────────────
 */

// Primary mode: "EMA_RSI_ST_PAPER" | null
let primaryMode = null;

// BB_RSI mode: "BB_RSI_PAPER" | null
let bbRsiMode = null;

// Price Action mode: "PA_PAPER" | null
let paMode = null;

// ORB (Opening Range Breakout) mode: "ORB_PAPER" | null
let orbMode = null;

// EMA9+VWAP mode: "EMA9VWAP_PAPER" | null
let ema9vwapMode = null;

// Trend Pullback mode: "TREND_PB_PAPER" | null
let trendPbMode = null;


// Trend Day Scalp mode: "TREND_DAY_SCALP_PAPER" | null
let trendDayScalpMode = null;


// HA Scalp mode: "HA_SCALP_PAPER" | null
let haScalpMode = null;

// Prev ORB Scalp mode: "PREV_ORB_SCALP_PAPER" | null
let prevOrbScalpMode = null;

// ITM20 Scalp mode: "ITM20_SCALP_PAPER" | null
let itm20ScalpMode = null;


// RSI Pivot SuperTrend mode: "RSI_PIVOT_ST_PAPER" | null
let rsiPivotStMode = null;

// EMA_RSI_ST_V2 mode: "EMA_RSI_ST_V2_PAPER" | null
// Its OWN slot, deliberately independent of `primaryMode` (which carries V1's
// EMA_RSI_ST_PAPER). V2 is a separate strategy with its own rules, its own
// settings and its own position file — the two are free to run side by side.
let emaRsiStV2Mode = null;

// ST_RSI_PIV_BB mode: "ST_RSI_PIV_BB_PAPER" | null
// Its OWN slot — a separate strategy with its own settings and position file,
// so it may run side by side with every other strategy.
let stRsiPivBbMode = null;

// SAIL_VWAP_ST mode: "SAIL_VWAP_ST_PAPER" | null
// Its OWN slot — SAIL stock options, its own settings and position file, so it
// may run side by side with every other strategy.
let sailVwapStMode = null;

// PIVOT_EMA_ST mode: "PIVOT_EMA_ST_PAPER" | null. Its OWN slot (own settings +
// position file), so it runs side by side with every other strategy.
let pivotEmaStMode = null;
// GAP_RUNAWAY (GAP_runAway__Kirubakaran, NIFTY options) and GAP_RUNAWAY_STK (its
// stock scanner, paper only): "<P>_PAPER" | null. Each its OWN slot,
// parallel with every other strategy.
let gapRunawayMode = null;
let gapRunawayStkMode = null;

// EarlyBird mode: "EARLY_BIRD_PAPER" | null
let earlyBirdMode = null;

// SIMPLE_9:30 mode: "SIMPLE930_PAPER" | null
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

// ── Prev ORB Scalp mode (prev-day H/L + 09:15 15m ORB, 3-min scalp) ──────────

function setPrevOrbScalpActive(mode) {
  prevOrbScalpMode = mode;
}

function clearPrevOrbScalp() {
  prevOrbScalpMode = null;
}

function isPrevOrbScalpActive() {
  return prevOrbScalpMode !== null;
}

function getPrevOrbScalpMode() {
  return prevOrbScalpMode;
}

// ── ITM20 Scalp mode (15m opening-range breakout + retest, +20/−10 premium) ──

function setItm20ScalpActive(mode) {
  itm20ScalpMode = mode;
}

function clearItm20Scalp() {
  itm20ScalpMode = null;
}

function isItm20ScalpActive() {
  return itm20ScalpMode !== null;
}

function getItm20ScalpMode() {
  return itm20ScalpMode;
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

// ── ST_RSI_PIV_BB mode ──────────────────────────────────────────────────────

function setStRsiPivBbMode(mode) {
  stRsiPivBbMode = mode;
}

function clearStRsiPivBbMode() {
  stRsiPivBbMode = null;
}

function isStRsiPivBbActive() {
  return stRsiPivBbMode !== null;
}

function getStRsiPivBbMode() {
  return stRsiPivBbMode;
}

// ── SAIL_VWAP_ST mode ───────────────────────────────────────────────────────

function setSailVwapStMode(mode) {
  sailVwapStMode = mode;
}

function clearSailVwapStMode() {
  sailVwapStMode = null;
}

function isSailVwapStActive() {
  return sailVwapStMode !== null;
}

function getSailVwapStMode() {
  return sailVwapStMode;
}

// ── PIVOT_EMA_ST family modes (NIFTY / SAIL) ────────────────────────────────

function setPivotEmaStMode(mode) { pivotEmaStMode = mode; }
function clearPivotEmaStMode() { pivotEmaStMode = null; }
function isPivotEmaStActive() { return pivotEmaStMode !== null; }
function getPivotEmaStMode() { return pivotEmaStMode; }


// ── GAP_RUNAWAY modes (NIFTY options + the stock scanner) ──────────────────

function setGapRunawayMode(mode) { gapRunawayMode = mode; }
function clearGapRunawayMode() { gapRunawayMode = null; }
function isGapRunawayActive() { return gapRunawayMode !== null; }
function getGapRunawayMode() { return gapRunawayMode; }

function setGapRunawayStkMode(mode) { gapRunawayStkMode = mode; }
function clearGapRunawayStkMode() { gapRunawayStkMode = null; }
function isGapRunawayStkActive() { return gapRunawayStkMode !== null; }
function getGapRunawayStkMode() { return gapRunawayStkMode; }

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
         prevOrbScalpMode !== null ||
         itm20ScalpMode !== null ||
         earlyBirdMode !== null ||
         rsiPivotStMode !== null ||
         emaRsiStV2Mode !== null ||
         stRsiPivBbMode !== null ||
         sailVwapStMode !== null ||
         pivotEmaStMode !== null ||
         gapRunawayMode !== null || gapRunawayStkMode !== null ||
         simple930Mode !== null;
}

/** Raw mutex check (no reservation). Returns { allowed, reason } */
function _canStartRaw(mode) {
  switch (mode) {
    case "EMA_RSI_ST_PAPER":
      if (primaryMode === "EMA_RSI_ST_PAPER") return { allowed: false, reason: "Paper Trade is already running" };
      return { allowed: true };
    case "BB_RSI_PAPER":
      if (bbRsiMode === "BB_RSI_PAPER") return { allowed: false, reason: "BB_RSI Paper is already running" };
      return { allowed: true };
    case "PA_PAPER":
      if (paMode === "PA_PAPER") return { allowed: false, reason: "Price Action Paper is already running" };
      return { allowed: true };
    case "ORB_PAPER":
      if (orbMode === "ORB_PAPER") return { allowed: false, reason: "ORB Paper is already running" };
      return { allowed: true };
    case "EMA9VWAP_PAPER":
      if (ema9vwapMode === "EMA9VWAP_PAPER") return { allowed: false, reason: "EMA9+VWAP Paper is already running" };
      return { allowed: true };
    case "TREND_PB_PAPER":
      if (trendPbMode === "TREND_PB_PAPER") return { allowed: false, reason: "Trend Pullback Paper is already running" };
      return { allowed: true };
    case "TREND_DAY_SCALP_PAPER":
      if (trendDayScalpMode === "TREND_DAY_SCALP_PAPER") return { allowed: false, reason: "Trend Day Scalp Paper is already running" };
      return { allowed: true };
    case "HA_SCALP_PAPER":
      if (haScalpMode === "HA_SCALP_PAPER") return { allowed: false, reason: "HA Scalp Paper is already running" };
      return { allowed: true };
    case "PREV_ORB_SCALP_PAPER":
      if (prevOrbScalpMode === "PREV_ORB_SCALP_PAPER") return { allowed: false, reason: "Prev ORB Scalp Paper is already running" };
      return { allowed: true };
    case "ITM20_SCALP_PAPER":
      if (itm20ScalpMode === "ITM20_SCALP_PAPER") return { allowed: false, reason: "ITM20 Scalp Paper is already running" };
      return { allowed: true };
    case "EARLY_BIRD_PAPER":
      if (earlyBirdMode === "EARLY_BIRD_PAPER") return { allowed: false, reason: "EarlyBird Paper is already running" };
      return { allowed: true };
    case "RSI_PIVOT_ST_PAPER":
      if (rsiPivotStMode === "RSI_PIVOT_ST_PAPER") return { allowed: false, reason: "RSI Pivot ST Paper is already running" };
      return { allowed: true };
    // EMA_RSI_ST_V2 is checked ONLY against its own sibling — it is a separate
    // strategy from EMA_RSI_ST (V1), not another mode of it, so V1 and V2 may
    // run at the same time.
    case "EMA_RSI_ST_V2_PAPER":
      if (emaRsiStV2Mode === "EMA_RSI_ST_V2_PAPER") return { allowed: false, reason: "EMA_RSI_ST_V2 Paper is already running" };
      return { allowed: true };
    // ST_RSI_PIV_BB is a separate strategy, checked ONLY against its own sibling.
    case "ST_RSI_PIV_BB_PAPER":
      if (stRsiPivBbMode === "ST_RSI_PIV_BB_PAPER") return { allowed: false, reason: "ST_RSI_PIV_BB Paper is already running" };
      return { allowed: true };
    // SAIL_VWAP_ST is a separate strategy, checked ONLY against its own sibling.
    case "SAIL_VWAP_ST_PAPER":
      if (sailVwapStMode === "SAIL_VWAP_ST_PAPER") return { allowed: false, reason: "SAIL_VWAP_ST Paper is already running" };
      return { allowed: true };
    // PIVOT_EMA_ST — checked ONLY against its own sibling.
    case "PIVOT_EMA_ST_PAPER":
      if (pivotEmaStMode === "PIVOT_EMA_ST_PAPER") return { allowed: false, reason: "PIVOT_EMA_ST Paper is already running" };
      return { allowed: true };
    // GAP_RUNAWAY — checked ONLY against its own sibling; the stock scanner is paper-only.
    case "GAP_RUNAWAY_PAPER":
      if (gapRunawayMode === "GAP_RUNAWAY_PAPER") return { allowed: false, reason: "GAP_RUNAWAY Paper is already running" };
      return { allowed: true };
    case "GAP_RUNAWAY_STK_PAPER":
      if (gapRunawayStkMode === "GAP_RUNAWAY_STK_PAPER") return { allowed: false, reason: "GAP_RUNAWAY_STK Paper is already running" };
      return { allowed: true };
    case "SIMPLE930_PAPER":
      if (simple930Mode === "SIMPLE930_PAPER") return { allowed: false, reason: "SIMPLE_9:30 Paper is already running" };
      return { allowed: true };
    default:
      return { allowed: false, reason: "Unknown mode: " + mode };
  }
}

// ── Start reservation (check-then-act race) ───────────────────────────────
// Every /start handler does canStart() → several awaits (token verify, holiday
// check, symbol resolve) → set*Active(). Two near-simultaneous /start requests
// (double-click, two tabs) both passed canStart() before either set the slot, so
// two sessions of the same strategy ran on one mutex. canStart() now RESERVES
// the strategy's slot for START_RESERVATION_MS when it allows; the reservation
// is released by that strategy's set*/clear* call or expires on its own (a
// /start that bails out early simply lets it lapse).
const START_RESERVATION_MS = 30000;
const _reservations = new Map();   // slot ("BB_RSI", "EMA_RSI_ST_V2", …) -> expiresAt
function _slotOf(mode) { return String(mode || "").replace(/_PAPER$/, ""); }

/**
 * Can the given mode start? Returns { allowed, reason }.
 * Called from /start paths: an allowed answer reserves the slot (see above).
 * Pass { reserve: false } for a read-only probe (status/display, replay).
 */
function canStart(mode, opts) {
  const raw = _canStartRaw(mode);
  if (!raw.allowed) return raw;
  const slot = _slotOf(mode);
  const now = Date.now();
  const until = _reservations.get(slot);
  if (until && until > now) {
    return { allowed: false, reason: `${slot}: start already in progress — retry in ${Math.ceil((until - now) / 1000)}s` };
  }
  if (!opts || opts.reserve !== false) _reservations.set(slot, now + START_RESERVATION_MS);
  else _reservations.delete(slot);
  return raw;
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
  // Prev ORB Scalp
  setPrevOrbScalpActive, clearPrevOrbScalp, isPrevOrbScalpActive, getPrevOrbScalpMode,
  // ITM20 Scalp
  setItm20ScalpActive, clearItm20Scalp, isItm20ScalpActive, getItm20ScalpMode,
  // RSI Pivot SuperTrend
  setEarlyBirdActive, clearEarlyBird, isEarlyBirdActive, getEarlyBirdMode,

  setRsiPivotStActive, clearRsiPivotSt, isRsiPivotStActive, getRsiPivotStMode,
  // EMA_RSI_ST_V2
  setEmaRsiStV2Mode, clearEmaRsiStV2Mode, isEmaRsiStV2Active, getEmaRsiStV2Mode,
  // ST_RSI_PIV_BB
  setStRsiPivBbMode, clearStRsiPivBbMode, isStRsiPivBbActive, getStRsiPivBbMode,
  // SAIL_VWAP_ST
  setSailVwapStMode, clearSailVwapStMode, isSailVwapStActive, getSailVwapStMode,
  // PIVOT_EMA_ST family
  setPivotEmaStMode, clearPivotEmaStMode, isPivotEmaStActive, getPivotEmaStMode,
  // GAP_RUNAWAY (NIFTY) + GAP_RUNAWAY_STK (stock scanner)
  setGapRunawayMode, clearGapRunawayMode, isGapRunawayActive, getGapRunawayMode,
  setGapRunawayStkMode, clearGapRunawayStkMode, isGapRunawayStkActive, getGapRunawayStkMode,
  // SIMPLE_9:30
  setSimple930Active, clearSimple930, isSimple930Active, getSimple930Mode,
  // Combined
  isAnyActive, canStart,
};

// set*/clear* release the strategy's start reservation. Wrapped here (rather
// than edited into 30 bodies) so a newly added slot cannot forget it.
const _CLEAR_SLOT = {
  clear: "EMA_RSI_ST", clearBbRsi: "BB_RSI", clearPA: "PA", clearOrb: "ORB",
  clearEma9Vwap: "EMA9VWAP", clearTrendPb: "TREND_PB", clearTrendDayScalp: "TREND_DAY_SCALP",
  clearHaScalp: "HA_SCALP", clearPrevOrbScalp: "PREV_ORB_SCALP", clearEarlyBird: "EARLY_BIRD",
  clearRsiPivotSt: "RSI_PIVOT_ST",
  clearEmaRsiStV2Mode: "EMA_RSI_ST_V2",
  clearStRsiPivBbMode: "ST_RSI_PIV_BB",
  clearSailVwapStMode: "SAIL_VWAP_ST",
  clearPivotEmaStMode: "PIVOT_EMA_ST",
  clearGapRunawayMode: "GAP_RUNAWAY", clearGapRunawayStkMode: "GAP_RUNAWAY_STK",
  clearSimple930: "SIMPLE930",
  clearItm20Scalp: "ITM20_SCALP",
};
for (const name of Object.keys(module.exports)) {
  const fn = module.exports[name];
  if (typeof fn !== "function" || !/^(set|clear)/.test(name)) continue;
  module.exports[name] = function (...args) {
    const r = fn.apply(this, args);
    const slot = name.startsWith("set") ? _slotOf(args[0]) : _CLEAR_SLOT[name];
    if (slot) _reservations.delete(slot);
    return r;
  };
}

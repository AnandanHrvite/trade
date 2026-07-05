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

// ── Combined queries ──────────────────────────────────────────────────────

/** Any mode using the socket? */
function isAnyActive() {
  return primaryMode !== null || bbRsiMode !== null || paMode !== null ||
         orbMode !== null || ema9vwapMode !== null;
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
  // Combined
  isAnyActive, canStart,
};

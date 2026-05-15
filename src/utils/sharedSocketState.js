/**
 * sharedSocketState.js
 * ─────────────────────────────────────────────────────────────
 * Tracks which modes are currently using the socket.
 *
 * RULES:
 * - SWING_PAPER and SWING_LIVE are mutually exclusive (same 15-min strategy)
 * - SCALP_LIVE and SCALP_PAPER are mutually exclusive (same 3-min strategy)
 * - SWING_LIVE + SCALP_LIVE can run in parallel (different brokers, different timeframes)
 * - SWING_PAPER + SCALP_PAPER can run in parallel
 *
 * The primary mode (SWING_PAPER | SWING_LIVE) owns the socket start/stop.
 * Scalp modes piggyback on the socket via addCallback/removeCallback.
 * If no primary mode is running, scalp can start the socket itself.
 * ─────────────────────────────────────────────────────────────
 */

// Primary mode: "SWING_PAPER" | "SWING_LIVE" | null
let primaryMode = null;

// Scalp mode: "SCALP_LIVE" | "SCALP_PAPER" | null
let scalpMode = null;

// Price Action mode: "PA_LIVE" | "PA_PAPER" | null
let paMode = null;

// ORB (Opening Range Breakout) mode: "ORB_PAPER" | null
let orbMode = null;

// Straddle (Long Straddle) mode: "STRADDLE_PAPER" | null
let straddleMode = null;

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

// ── Scalp mode (3-min) ────────────────────────────────────────────────────

function setScalpActive(mode) {
  scalpMode = mode;
}

function clearScalp() {
  scalpMode = null;
}

function isScalpActive() {
  return scalpMode !== null;
}

function getScalpMode() {
  return scalpMode;
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

// ── Straddle mode (paper only for v1) ─────────────────────────────────────

function setStraddleActive(mode) {
  straddleMode = mode;
}

function clearStraddle() {
  straddleMode = null;
}

function isStraddleActive() {
  return straddleMode !== null;
}

function getStraddleMode() {
  return straddleMode;
}

// ── Combined queries ──────────────────────────────────────────────────────

/** Any mode using the socket? */
function isAnyActive() {
  return primaryMode !== null || scalpMode !== null || paMode !== null ||
         orbMode !== null || straddleMode !== null;
}

/** Can the given mode start? Returns { allowed, reason } */
function canStart(mode) {
  switch (mode) {
    case "SWING_LIVE":
      if (primaryMode === "SWING_PAPER") return { allowed: false, reason: "Paper Trade is running — stop it first" };
      if (primaryMode === "SWING_LIVE")  return { allowed: false, reason: "Live Trade is already running" };
      return { allowed: true };
    case "SWING_PAPER":
      if (primaryMode === "SWING_LIVE")  return { allowed: false, reason: "Live Trade is running — stop it first" };
      if (primaryMode === "SWING_PAPER") return { allowed: false, reason: "Paper Trade is already running" };
      return { allowed: true };
    case "SCALP_LIVE":
      if (scalpMode === "SCALP_PAPER") return { allowed: false, reason: "Scalp Paper is running — stop it first" };
      if (scalpMode === "SCALP_LIVE")  return { allowed: false, reason: "Scalp Live is already running" };
      return { allowed: true };
    case "SCALP_PAPER":
      if (scalpMode === "SCALP_LIVE")  return { allowed: false, reason: "Scalp Live is running — stop it first" };
      if (scalpMode === "SCALP_PAPER") return { allowed: false, reason: "Scalp Paper is already running" };
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
    case "STRADDLE_PAPER":
      if (straddleMode === "STRADDLE_PAPER") return { allowed: false, reason: "Straddle Paper is already running" };
      if (straddleMode === "STRADDLE_LIVE")  return { allowed: false, reason: "Straddle Live is running — stop it first" };
      return { allowed: true };
    case "STRADDLE_LIVE":
      if (straddleMode === "STRADDLE_PAPER") return { allowed: false, reason: "Straddle Paper is running — stop it first" };
      if (straddleMode === "STRADDLE_LIVE")  return { allowed: false, reason: "Straddle Live is already running" };
      return { allowed: true };
    default:
      return { allowed: false, reason: "Unknown mode: " + mode };
  }
}

module.exports = {
  // Primary (backward compatible)
  setActive, clear, isActive, getMode,
  // Scalp
  setScalpActive, clearScalp, isScalpActive, getScalpMode,
  // Price Action
  setPAActive, clearPA, isPAActive, getPAMode,
  // ORB
  setOrbActive, clearOrb, isOrbActive, getOrbMode,
  // Straddle
  setStraddleActive, clearStraddle, isStraddleActive, getStraddleMode,
  // Combined
  isAnyActive, canStart,
};

/**
 * sharedSocketState.js
 * ─────────────────────────────────────────────────────────────
 * Tracks which modes are currently using the socket.
 *
 * RULES:
 * - PAPER_TRADE and LIVE_TRADE are mutually exclusive (same 15-min strategy)
 * - SCALP_LIVE and SCALP_PAPER are mutually exclusive (same 3-min strategy)
 * - LIVE_TRADE + SCALP_LIVE can run in parallel (different brokers, different timeframes)
 * - PAPER_TRADE + SCALP_PAPER can run in parallel
 *
 * The primary mode (PAPER_TRADE | LIVE_TRADE) owns the socket start/stop.
 * Scalp modes piggyback on the socket via addCallback/removeCallback.
 * If no primary mode is running, scalp can start the socket itself.
 * ─────────────────────────────────────────────────────────────
 */

// Primary mode: "PAPER_TRADE" | "LIVE_TRADE" | null
let primaryMode = null;

// Scalp mode: "SCALP_LIVE" | "SCALP_PAPER" | null
let scalpMode = null;

// Price Action mode: "PA_LIVE" | "PA_PAPER" | null
let paMode = null;

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

// ── Combined queries ──────────────────────────────────────────────────────

/** Any mode using the socket? */
function isAnyActive() {
  return primaryMode !== null || scalpMode !== null || paMode !== null;
}

/** Can the given mode start? Returns { allowed, reason } */
function canStart(mode) {
  switch (mode) {
    case "LIVE_TRADE":
      if (primaryMode === "PAPER_TRADE") return { allowed: false, reason: "Paper Trade is running — stop it first" };
      if (primaryMode === "LIVE_TRADE")  return { allowed: false, reason: "Live Trade is already running" };
      return { allowed: true };
    case "PAPER_TRADE":
      if (primaryMode === "LIVE_TRADE")  return { allowed: false, reason: "Live Trade is running — stop it first" };
      if (primaryMode === "PAPER_TRADE") return { allowed: false, reason: "Paper Trade is already running" };
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
  // Combined
  isAnyActive, canStart,
};

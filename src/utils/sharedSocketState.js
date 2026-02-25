/**
 * sharedSocketState.js
 * ─────────────────────────────────────────────────────────────
 * fyersDataSocket is a SINGLETON per access token.
 * Running paperTrade AND liveTrade simultaneously would mix up
 * their tick handlers and corrupt candle data.
 *
 * This module tracks which mode is currently using the socket
 * so we can block the other from starting.
 * ─────────────────────────────────────────────────────────────
 */

let activeMode = null; // "PAPER_TRADE" | "LIVE_TRADE" | null

function setActive(mode) {
  activeMode = mode;
}

function clear() {
  activeMode = null;
}

function isActive() {
  return activeMode !== null;
}

function getMode() {
  return activeMode;
}

module.exports = { setActive, clear, isActive, getMode };

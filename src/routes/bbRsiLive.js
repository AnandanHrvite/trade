/**
 * BB_RSI — LIVE (real Fyers orders) — /bb_rsi-live
 * Mirrors the BB_RSI PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "bbRsi", kind: "live", modeTag: "BB_RSI-PAPER",
  path: "/bb_rsi-live", navKey: "bbRsiLive", title: "BB_RSI",
});

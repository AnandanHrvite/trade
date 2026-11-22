/**
 * BB_RSI — LIVE HARNESS (simulated orders) — /bb_rsi-live-harness
 * Mirrors the BB_RSI PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "bbRsi", kind: "harness", modeTag: "BB_RSI-PAPER",
  path: "/bb_rsi-live-harness", navKey: "bbRsiLiveHarness", title: "BB_RSI",
});

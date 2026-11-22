/**
 * EMA9+VWAP — LIVE HARNESS (simulated orders) — /ema9vwap-live-harness
 * Mirrors the EMA9+VWAP PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "ema9vwap", kind: "harness", modeTag: "EMA9VWAP-PAPER",
  path: "/ema9vwap-live-harness", navKey: "ema9vwapLiveHarness", title: "EMA9+VWAP",
});

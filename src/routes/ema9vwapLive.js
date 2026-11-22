/**
 * EMA9+VWAP — LIVE (real Fyers orders) — /ema9vwap-live
 * Mirrors the EMA9+VWAP PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "ema9vwap", kind: "live", modeTag: "EMA9VWAP-PAPER",
  path: "/ema9vwap-live", navKey: "ema9vwapLive", title: "EMA9+VWAP",
});

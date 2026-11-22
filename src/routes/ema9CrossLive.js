/**
 * EMA9_CROSS — LIVE (real Fyers orders) — /ema9_cross-live
 * Mirrors the EMA9_CROSS PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "ema9Cross", kind: "live", modeTag: "EMA9_CROSS-PAPER",
  path: "/ema9_cross-live", navKey: "ema9CrossLive", title: "EMA9_CROSS",
});

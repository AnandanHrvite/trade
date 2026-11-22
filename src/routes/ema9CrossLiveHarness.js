/**
 * EMA9_CROSS — LIVE HARNESS (simulated orders) — /ema9_cross-live-harness
 * Mirrors the EMA9_CROSS PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "ema9Cross", kind: "harness", modeTag: "EMA9_CROSS-PAPER",
  path: "/ema9_cross-live-harness", navKey: "ema9CrossLiveHarness", title: "EMA9_CROSS",
});

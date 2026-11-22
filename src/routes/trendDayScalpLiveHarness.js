/**
 * Trend Day Scalp — LIVE HARNESS (simulated orders) — /trend-day-scalp-live-harness
 * Mirrors the Trend Day Scalp PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "trendDayScalp", kind: "harness", modeTag: "TREND-DAY-SCALP-PAPER",
  path: "/trend-day-scalp-live-harness", navKey: "trendDayScalpLiveHarness", title: "Trend Day Scalp",
});

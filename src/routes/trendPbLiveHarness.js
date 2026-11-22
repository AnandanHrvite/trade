/**
 * Trend Pullback — LIVE HARNESS (simulated orders) — /trend-pb-live-harness
 * Mirrors the Trend Pullback PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "trendPb", kind: "harness", modeTag: "TREND_PB-PAPER",
  path: "/trend-pb-live-harness", navKey: "trendPbLiveHarness", title: "Trend Pullback",
});

/**
 * Trend Pullback — LIVE (real Fyers orders) — /trend-pb-live
 * Mirrors the Trend Pullback PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "trendPb", kind: "live", modeTag: "TREND_PB-PAPER",
  path: "/trend-pb-live", navKey: "trendPbLive", title: "Trend Pullback",
});

/**
 * Trend Day Scalp — LIVE (real Fyers orders) — /trend-day-scalp-live
 * Mirrors the Trend Day Scalp PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "trendDayScalp", kind: "live", modeTag: "TREND-DAY-SCALP-PAPER",
  path: "/trend-day-scalp-live", navKey: "trendDayScalpLive", title: "Trend Day Scalp",
});

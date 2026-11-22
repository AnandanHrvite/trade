/**
 * Price Action — LIVE (real Fyers orders) — /pa-live
 * Mirrors the Price Action PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "pa", kind: "live", modeTag: "PA-PAPER",
  path: "/pa-live", navKey: "paLive", title: "Price Action",
});

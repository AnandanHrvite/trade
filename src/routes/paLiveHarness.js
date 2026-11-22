/**
 * Price Action — LIVE HARNESS (simulated orders) — /pa-live-harness
 * Mirrors the Price Action PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "pa", kind: "harness", modeTag: "PA-PAPER",
  path: "/pa-live-harness", navKey: "paLiveHarness", title: "Price Action",
});

/**
 * HA Scalp — LIVE HARNESS (simulated orders) — /ha-scalp-live-harness
 * Mirrors the HA Scalp PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "haScalp", kind: "harness", modeTag: "HA-SCALP-PAPER",
  path: "/ha-scalp-live-harness", navKey: "haScalpLiveHarness", title: "HA Scalp",
});

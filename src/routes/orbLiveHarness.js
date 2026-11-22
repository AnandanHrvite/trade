/**
 * ORB — LIVE HARNESS (simulated orders) — /orb-live-harness
 * Mirrors the ORB PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "orb", kind: "harness", modeTag: "ORB-PAPER",
  path: "/orb-live-harness", navKey: "orbLiveHarness", title: "ORB",
});

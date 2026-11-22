/**
 * Prev ORB Scalp — LIVE HARNESS (simulated orders) — /prev-orb-scalp-live-harness
 * Mirrors the Prev ORB Scalp PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "prevOrbScalp", kind: "harness", modeTag: "PREV-ORB-SCALP-PAPER",
  path: "/prev-orb-scalp-live-harness", navKey: "prevOrbScalpLiveHarness", title: "Prev ORB Scalp",
});

/**
 * Prev ORB Scalp — LIVE (real Fyers orders) — /prev-orb-scalp-live
 * Mirrors the Prev ORB Scalp PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "prevOrbScalp", kind: "live", modeTag: "PREV-ORB-SCALP-PAPER",
  path: "/prev-orb-scalp-live", navKey: "prevOrbScalpLive", title: "Prev ORB Scalp",
});

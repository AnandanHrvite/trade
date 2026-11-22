/**
 * ORB — LIVE (real Fyers orders) — /orb-live
 * Mirrors the ORB PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "orb", kind: "live", modeTag: "ORB-PAPER",
  path: "/orb-live", navKey: "orbLive", title: "ORB",
});

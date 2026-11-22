/**
 * HA Scalp — LIVE (real Fyers orders) — /ha-scalp-live
 * Mirrors the HA Scalp PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "haScalp", kind: "live", modeTag: "HA-SCALP-PAPER",
  path: "/ha-scalp-live", navKey: "haScalpLive", title: "HA Scalp",
});

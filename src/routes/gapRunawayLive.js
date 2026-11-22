/**
 * GAP_RUNAWAY — LIVE (real Fyers orders) — /gap_runaway-live
 * Mirrors the GAP_RUNAWAY PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "gapRunaway", kind: "live", modeTag: "GAP_RUNAWAY-PAPER",
  path: "/gap_runaway-live", navKey: "gapRunawayLive", title: "GAP_RUNAWAY",
});

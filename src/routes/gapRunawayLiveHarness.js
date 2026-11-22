/**
 * GAP_RUNAWAY — LIVE HARNESS (simulated orders) — /gap_runaway-live-harness
 * Mirrors the GAP_RUNAWAY PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "gapRunaway", kind: "harness", modeTag: "GAP_RUNAWAY-PAPER",
  path: "/gap_runaway-live-harness", navKey: "gapRunawayLiveHarness", title: "GAP_RUNAWAY",
});

/**
 * PIVOT_EMA_ST — LIVE HARNESS (simulated orders) — /pivot_ema_st-live-harness
 * Mirrors the PIVOT_EMA_ST PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "pivotEmaSt", kind: "harness", modeTag: "PIVOT_EMA_ST-PAPER",
  path: "/pivot_ema_st-live-harness", navKey: "pivotEmaStLiveHarness", title: "PIVOT_EMA_ST",
});

/**
 * RSI Pivot ST — LIVE HARNESS (simulated orders) — /rsi-pivot-st-live-harness
 * Mirrors the RSI Pivot ST PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "rsiPivotSt", kind: "harness", modeTag: "RSI_PIVOT_ST-PAPER",
  path: "/rsi-pivot-st-live-harness", navKey: "rsiPivotStLiveHarness", title: "RSI Pivot ST",
});

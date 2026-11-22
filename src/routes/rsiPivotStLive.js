/**
 * RSI Pivot ST — LIVE (real Fyers orders) — /rsi-pivot-st-live
 * Mirrors the RSI Pivot ST PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "rsiPivotSt", kind: "live", modeTag: "RSI_PIVOT_ST-PAPER",
  path: "/rsi-pivot-st-live", navKey: "rsiPivotStLive", title: "RSI Pivot ST",
});

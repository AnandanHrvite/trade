/**
 * PIVOT_EMA_ST — LIVE (real Fyers orders) — /pivot_ema_st-live
 * Mirrors the PIVOT_EMA_ST PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "pivotEmaSt", kind: "live", modeTag: "PIVOT_EMA_ST-PAPER",
  path: "/pivot_ema_st-live", navKey: "pivotEmaStLive", title: "PIVOT_EMA_ST",
});

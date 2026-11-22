/**
 * ST_RSI_PIV_BB — LIVE (real Fyers orders) — /st_rsi_piv_bb-live
 * Mirrors the ST_RSI_PIV_BB PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "stRsiPivBb", kind: "live", modeTag: "ST_RSI_PIV_BB-PAPER",
  path: "/st_rsi_piv_bb-live", navKey: "stRsiPivBbLive", title: "ST_RSI_PIV_BB",
});

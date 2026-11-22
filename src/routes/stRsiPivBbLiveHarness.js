/**
 * ST_RSI_PIV_BB — LIVE HARNESS (simulated orders) — /st_rsi_piv_bb-live-harness
 * Mirrors the ST_RSI_PIV_BB PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "stRsiPivBb", kind: "harness", modeTag: "ST_RSI_PIV_BB-PAPER",
  path: "/st_rsi_piv_bb-live-harness", navKey: "stRsiPivBbLiveHarness", title: "ST_RSI_PIV_BB",
});

/**
 * EMA_RSI_ST — LIVE HARNESS (simulated orders) — /ema_rsi_st-live-harness
 * Mirrors the EMA_RSI_ST PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "emaRsiSt", kind: "harness", modeTag: "PAPER",
  path: "/ema_rsi_st-live-harness", navKey: "emaRsiStLiveHarness", title: "EMA_RSI_ST",
});

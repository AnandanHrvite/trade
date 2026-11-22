/**
 * EMA_RSI_ST — LIVE (real Fyers orders) — /ema_rsi_st-live
 * Mirrors the EMA_RSI_ST PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "emaRsiSt", kind: "live", modeTag: "PAPER",
  path: "/ema_rsi_st-live", navKey: "emaRsiStLive", title: "EMA_RSI_ST",
});

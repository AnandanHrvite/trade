/**
 * EMA_RSI_ST_V2 — LIVE (real Fyers orders) — /ema_rsi_st_v2-live
 * Mirrors the EMA_RSI_ST_V2 PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "emaRsiStV2", kind: "live", modeTag: "EMA_RSI_ST_V2-PAPER",
  path: "/ema_rsi_st_v2-live", navKey: "emaRsiStV2Live", title: "EMA_RSI_ST_V2",
});

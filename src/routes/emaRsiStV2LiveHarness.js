/**
 * EMA_RSI_ST_V2 — LIVE HARNESS (simulated orders) — /ema_rsi_st_v2-live-harness
 * Mirrors the EMA_RSI_ST_V2 PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "emaRsiStV2", kind: "harness", modeTag: "EMA_RSI_ST_V2-PAPER",
  path: "/ema_rsi_st_v2-live-harness", navKey: "emaRsiStV2LiveHarness", title: "EMA_RSI_ST_V2",
});

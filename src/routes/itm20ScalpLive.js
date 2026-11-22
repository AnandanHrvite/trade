/**
 * ITM20 Scalp — LIVE (real Fyers orders) — /itm20-scalp-live
 * Mirrors the ITM20 Scalp PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "itm20Scalp", kind: "live", modeTag: "ITM20-SCALP-PAPER",
  path: "/itm20-scalp-live", navKey: "itm20ScalpLive", title: "ITM20 Scalp",
});

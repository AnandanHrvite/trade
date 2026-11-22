/**
 * ITM20 Scalp — LIVE HARNESS (simulated orders) — /itm20-scalp-live-harness
 * Mirrors the ITM20 Scalp PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "itm20Scalp", kind: "harness", modeTag: "ITM20-SCALP-PAPER",
  path: "/itm20-scalp-live-harness", navKey: "itm20ScalpLiveHarness", title: "ITM20 Scalp",
});

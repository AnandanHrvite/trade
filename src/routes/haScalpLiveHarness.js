/**
 * HA SCALP — LIVE HARNESS (dry-run) — /ha-scalp-live-harness
 * Runs the exact Live order path against a simulated broker: nothing is sent
 * to Fyers. Decisions come from the HA Scalp PAPER engine unchanged.
 */
module.exports = require("../utils/liveRoute").create({
  id: "haScalp", kind: "harness", modeTag: "HA-SCALP-PAPER",
  path: "/ha-scalp-live-harness", navKey: "haScalpLiveHarness", title: "HA Scalp",
});

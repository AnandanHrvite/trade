/**
 * SIMPLE_9:30 — LIVE (real Fyers orders) — /simple930-live
 * Mirrors the SIMPLE_9:30 PAPER engine's entries and exits as real orders.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "simple930", kind: "live", modeTag: "SIMPLE930-PAPER",
  path: "/simple930-live", navKey: "simple930Live", title: "SIMPLE_9:30",
});

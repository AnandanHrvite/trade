/**
 * SIMPLE_9:30 — LIVE HARNESS (simulated orders) — /simple930-live-harness
 * Mirrors the SIMPLE_9:30 PAPER engine's entries and exits against a simulated broker.
 * All rules live in the paper engine; see src/utils/liveRoute.js and
 * src/services/liveHarness.js for the order path.
 */
module.exports = require("../utils/liveRoute").create({
  id: "simple930", kind: "harness", modeTag: "SIMPLE930-PAPER",
  path: "/simple930-live-harness", navKey: "simple930LiveHarness", title: "SIMPLE_9:30",
});

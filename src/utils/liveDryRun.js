"use strict";

/**
 * Effective dry-run gate for live trading engines.
 *
 * Two layers, where the override can only ADD safety (force MORE dry-run),
 * never remove it:
 *
 *   1. Global  `LIVE_HARNESS_DRY_RUN`  (default "true" → dry-run ON).
 *      When ON, EVERY live strategy is dry-run regardless of overrides.
 *   2. Per-strategy `{KEY}_LIVE_DRY_RUN` (default "false").
 *      When the global flag is OFF (real orders), a strategy whose override
 *      is "true" STAYS in dry-run. This lets you graduate one strategy to
 *      real money (e.g. Swing) while keeping another simulated (e.g. ORB)
 *      without a separate global switch.
 *
 * Truth table (global OFF means LIVE_HARNESS_DRY_RUN=false):
 *   global ON                      → dry-run (always)
 *   global OFF, override unset/false → REAL orders
 *   global OFF, override true        → dry-run (strategy held back)
 *
 * @param {string} [strategyKey] e.g. "SWING", "ORB", "PA", "STRADDLE", "SCALP".
 *        Omit to evaluate the global flag only.
 * @returns {boolean} true ⇒ no real broker order should be placed.
 */
function isDryRun(strategyKey) {
  const globalDry = (process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() !== "false";
  if (globalDry) return true;
  if (!strategyKey) return false;
  return (process.env[`${strategyKey}_LIVE_DRY_RUN`] || "false").toLowerCase() === "true";
}

module.exports = { isDryRun };

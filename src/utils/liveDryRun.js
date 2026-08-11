"use strict";

/**
 * Effective dry-run gate for live trading engines.
 *
 * THREE layers, where every layer can only ADD safety (force MORE dry-run),
 * never remove it. A real order requires ALL THREE to agree:
 *
 *   1. Global  `LIVE_HARNESS_DRY_RUN`  (default "true" → dry-run ON).
 *      When ON, EVERY live strategy is dry-run regardless of the others.
 *   2. Per-strategy `{KEY}_LIVE_ENABLED` (default "false" → dry-run ON).
 *      This is the documented per-strategy live toggle (see CLAUDE.md, "Live
 *      order placement is double-gated"). A strategy that was never explicitly
 *      enabled stays simulated even if the global switch is flipped off — so
 *      turning the global switch off can never silently arm every engine at once.
 *   3. Per-strategy `{KEY}_LIVE_DRY_RUN` (default "false").
 *      A hold-back override: with the first two satisfied, setting this to
 *      "true" keeps that ONE strategy simulated. This lets you graduate one
 *      strategy to real money (e.g. EMA_RSI_ST) while keeping another
 *      simulated (e.g. ORB) without a separate global switch.
 *
 * Truth table (global OFF means LIVE_HARNESS_DRY_RUN=false):
 *   global ON                                        → dry-run (always)
 *   global OFF, ENABLED unset/false                  → dry-run (never armed)
 *   global OFF, ENABLED true, override unset/false   → REAL orders
 *   global OFF, ENABLED true, override true          → dry-run (held back)
 *
 * @param {string} [strategyKey] e.g. "EMA_RSI_ST", "ORB", "PA", "BB_RSI".
 *        Omit to evaluate the global flag only (no per-strategy layers).
 * @returns {boolean} true ⇒ no real broker order should be placed.
 */
function isDryRun(strategyKey) {
  const globalDry = (process.env.LIVE_HARNESS_DRY_RUN || "true").toLowerCase() !== "false";
  if (globalDry) return true;
  if (!strategyKey) return false;
  if ((process.env[`${strategyKey}_LIVE_ENABLED`] || "false").toLowerCase() !== "true") return true;
  return (process.env[`${strategyKey}_LIVE_DRY_RUN`] || "false").toLowerCase() === "true";
}

module.exports = { isDryRun };

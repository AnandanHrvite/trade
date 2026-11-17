// Per-strategy Common Rules (NIFTY strategies only).
//
// Every NIFTY strategy can switch on "Own Common Rules" (`<PREFIX>_OWN_COMMON_RULES`).
// While it is ON, each Common Rules key below is read from the strategy's own
// copy (`<PREFIX>_<KEY>`, e.g. BB_RSI_PROFIT_LOCK_ARM_PCT). While it is OFF —
// or the strategy's own copy is blank — the common key is used, exactly as before.
// Read live on every call, so a Settings save applies at once (paper AND backtest).
//
// Example: PROFIT_LOCK_ARM_PCT=10, BB_RSI_OWN_COMMON_RULES=true,
// BB_RSI_PROFIT_LOCK_ARM_PCT=15 → BB_RSI arms at +15%, every other strategy at +10%.
//
// Only NIFTY (home) runs use it. Other markets (BANKNIFTY …) and the stock
// strategies (SAIL_VWAP_ST, GAP_RUNAWAY scanner) always read the common keys.

const registry = require("../config/strategyRegistry");

// The Common Rules keys a strategy can override. Not here on purpose:
// ZERODHA_INV_AMOUNT / FYERS_INV_AMOUNT (one shared broker pool) and STOCK_SL_*
// (stock legs, not options).
const KEYS = Object.freeze([
  "PROFIT_LOCK_ENABLED",
  "PREMIUM_SL_ENABLED",
  "EXIT_REENTRY_COOLDOWN_ENABLED",
  "MAX_BID_ASK_SPREAD_ENABLED",
  "COMMON_TRADE_WINDOW_ENABLED",
  "PAPER_CAPITAL_GATE_ENABLED",
  "LOT_MULTIPLIER",
  "PAPER_CAPITAL_EST_PREMIUM",
  "PROFIT_LOCK_ARM_PCT",
  "PROFIT_LOCK_FLOOR_PCT",
  "PROFIT_LOCK_TRAIL_PCT",
  "PROFIT_LOCK_TRAIL_TIERS",
  "PREMIUM_SL_PCT",
  "PREMIUM_SL_TRAIL_PCT",
  "EXIT_REENTRY_COOLDOWN_CANDLES",
  "MAX_TRADES_PER_DAY",
  "MAX_BID_ASK_SPREAD_PTS",
]);
const _KEYSET = new Set(KEYS);

// NIFTY strategies: every registry strategy except the stock one (SAIL_VWAP_ST).
const STRATEGIES = Object.freeze(
  registry.strategies().filter((s) => s.id !== "sailVwapSt").map((s) => s.envPrefix)
);
const _PREFIXES = new Set(STRATEGIES);

function toggleKey(prefix) { return `${prefix}_OWN_COMMON_RULES`; }
function ownKey(prefix, key) { return `${prefix}_${key}`; }

/** True when this NIFTY strategy reads its own Common Rules values. */
function isOwn(prefix) {
  return !!prefix && _PREFIXES.has(prefix)
    && String(process.env[toggleKey(prefix)] ?? "false").trim().toLowerCase() === "true";
}

/**
 * The raw env value a strategy should use for a Common Rules key.
 * prefix null/unknown → the common key (process.env[key]).
 */
function get(prefix, key) {
  if (_KEYSET.has(key) && isOwn(prefix)) {
    const v = process.env[ownKey(prefix, key)];
    if (v !== undefined && String(v).trim() !== "") return v;
  }
  return process.env[key];
}

/** Prefix for a NIFTY mode key ("bb_rsi" → "BB_RSI"); null for any other mode. */
function prefixForMode(modeKey) {
  const s = modeKey ? registry.byModeKey(modeKey) : null;
  return s && _PREFIXES.has(s.envPrefix) ? s.envPrefix : null;
}

/** Every per-strategy key (toggle + own copies) — Settings / snapshots / docs. */
function allOwnKeys() {
  const out = [];
  for (const p of STRATEGIES) {
    out.push(toggleKey(p));
    for (const k of KEYS) out.push(ownKey(p, k));
  }
  return out;
}

module.exports = { KEYS, STRATEGIES, toggleKey, ownKey, isOwn, get, prefixForMode, allOwnKeys };

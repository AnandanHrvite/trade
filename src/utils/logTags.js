/**
 * logTags.js — the market + strategy labels stamped on every trade, skip and
 * post-exit record, derived from the logger mode key so no route has to pass
 * them.
 *
 * Pure functions, no I/O, no state. A record that already carries its own
 * `market` / `strategy` keeps it; these are only the defaults.
 *
 * The two maps below are the only per-strategy knowledge here and cover today's
 * modes. Once src/config/markets.js and src/config/strategyRegistry.js exist,
 * a mode that names its market there should be read from there instead.
 */

"use strict";

const DEFAULT_MARKET = "NIFTY";

// Modes that do NOT trade NIFTY. Every other mode is a NIFTY strategy.
const MARKET_BY_MODE = {
  sail_vwap_st:    "SAIL",
  gap_runaway_stk: "STOCKS",
};

// Strategy id = the {ID}_MODE_ENABLED prefix Settings and Consolidation use.
// Nearly always the mode key upper-cased; these two are spelled differently.
const STRATEGY_ID_BY_MODE = {
  trend_day_scalp: "TDS",
  early_bird:      "EARLYBIRD",
};

const _str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Strategy id for a logger mode key, e.g. "bb_rsi" → "BB_RSI". */
function strategyIdFor(mode) {
  const m = String(mode || "");
  return STRATEGY_ID_BY_MODE[m] || m.toUpperCase() || null;
}

/**
 * Market a record belongs to. Order: the record's own `market`, the mode's
 * fixed market, a cash-equity leg (instrument NSE_EQUITY*) → "STOCKS", else NIFTY.
 */
function marketFor(mode, rec) {
  const own = rec && _str(rec.market);
  if (own) return own.toUpperCase();
  const fixed = MARKET_BY_MODE[String(mode || "")];
  if (fixed) return fixed;
  const instr = rec && _str(rec.instrument);
  if (instr && instr.toUpperCase().startsWith("NSE_EQUITY")) return "STOCKS";
  return DEFAULT_MARKET;
}

/** { market, strategy } for a record, its own values first. */
function tagsFor(mode, rec) {
  return {
    market:   marketFor(mode, rec),
    strategy: (rec && _str(rec.strategy)) || strategyIdFor(mode),
  };
}

module.exports = { tagsFor, marketFor, strategyIdFor, DEFAULT_MARKET, MARKET_BY_MODE, STRATEGY_ID_BY_MODE };

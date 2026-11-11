/**
 * backtestMarket.js — the per-market facts a backtest engine needs
 * ─────────────────────────────────────────────────────────────────────────────
 * One place that turns a market key (config/markets.js) into what a backtest
 * prices with, so a strategy's backtest module never types a symbol, a lot or
 * an exchange itself:
 *
 *   context(key)           { key, label, shortLabel, exchange, kind, isFutures,
 *                            spotSymbol, lotQty, strikeStep, underlying }
 *   contractAt(ctx, spot, side, unixSec)
 *                          { symbol, expiry } the contract paper would have held
 *                          at that moment — the market's RULE expiry (weekly /
 *                          monthly / futures roll, holiday-preponed). A manual
 *                          *_EXPIRY_OVERRIDE is a live-session setting and is NOT
 *                          applied to history.
 *
 * Futures: the signal source is the underlying's INDEX candles (as the NIFTY
 * futures twin always did — continuous futures history is not served), priced
 * 1:1 in index points with the futures lot and futures charges.
 * MCX markets have no spot index and no rule expiry; they are not backtestable
 * here yet (context() still answers, with spotSymbol null).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const markets     = require("../config/markets");
const instrument  = require("../config/instrument");
const nseHolidays = require("../utils/nseHolidays");

const SHORT = { NIFTY: "NIFTY", NIFTY_FUT: "NIFTY FUT", BANKNIFTY: "BANKNIFTY", SENSEX: "SENSEX" };

function context(marketKey) {
  const M = markets.get(marketKey);
  const isFutures = M.kind === "futures";
  const ctx = {
    key: M.key,
    label: M.label,
    shortLabel: SHORT[M.key] || M.key,
    exchange: M.exchange,
    kind: M.kind,
    isFutures,
    spotSymbol: M.spot,
    lotQty: null,
    strikeStep: M.strikeStep,
    underlying: M.underlying,
  };
  if (M.underlying) {
    // The NIFTY options lot is read exactly as the NIFTY engines read it
    // (getLotQty() with no arguments); every other market names its row.
    ctx.lotQty = M.key === "NIFTY"
      ? instrument.getLotQty()
      : instrument.getLotQty(M.underlying, isFutures ? "NIFTY_FUTURES" : "NIFTY_OPTIONS");
  }
  return ctx;
}

/** unix seconds → a Date whose LOCAL fields read as the IST wall clock. */
function _ist(unixSec) {
  const t = new Date((unixSec + 19800) * 1000);
  return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), 0, 0);
}

function contractAt(ctx, spot, side, unixSec) {
  if (!ctx || !ctx.underlying || !Number.isFinite(Number(unixSec))) return null;
  const U = instrument.underlyingOf(ctx.underlying);
  const ist = _ist(Number(unixSec));
  if (ctx.isFutures) {
    const c = instrument.futuresContractAt(ist, U);
    return { symbol: `${U.exchange}:${U.futPrefix}${c.code}FUT`, expiry: nseHolidays.formatDateToYYYYMMDD(nseHolidays.preponedExpirySync(c.date)) };
  }
  const eff = nseHolidays.preponedExpirySync(instrument.weeklyExpiryAt(ist, U));
  const expiry = nseHolidays.formatDateToYYYYMMDD(eff);
  const symbol = markets.optionSymbol(ctx.key, Number(spot), side, { expiry });
  return { symbol, expiry };
}

module.exports = { context, contractAt };

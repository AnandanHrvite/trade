/**
 * instrumentMode.js — ONE place that answers "are we trading options or futures?"
 * ─────────────────────────────────────────────────────────────────────────────
 * The Settings toggle `INSTRUMENT` (NIFTY_OPTIONS | NIFTY_FUTURES) used to be
 * honoured by only a handful of strategies; each of those hand-rolled its own
 * `INSTRUMENT === "NIFTY_FUTURES"` branch, and every strategy added later
 * silently kept buying options no matter what the toggle said.
 *
 * This module is the shared implementation. A strategy that routes its entry
 * through `resolveEntryInstrument()` and its P&L through `computePnl()` honours
 * the toggle automatically — including strategies that don't exist yet.
 *
 * The futures contract:
 *   - symbol  = NSE:NIFTY{expiry}FUT  (no strike, no CE/PE)
 *   - CE side = LONG (+1), PE side = SHORT (-1)
 *   - price   = the index level itself, so entry/exit price IS the spot price
 *   - P&L     = (exit - entry) × direction × qty, with futures charge rates
 *   - premium-domain gates (premium band, bid-ask spread on the option, option
 *     LTP polling) do not apply and are reported as skipped, not failed.
 *
 * Read `process.env` on every call — the Settings toggle is INSTANT (no restart).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const instrumentConfig = require("../config/instrument");
const { getCharges }   = require("./charges");

/** True when the Settings toggle currently selects NIFTY futures. */
function isFutures() {
  return String(process.env.INSTRUMENT || "NIFTY_OPTIONS").trim().toUpperCase() === "NIFTY_FUTURES";
}

/** "futures" | "options" — for logs and trade records. */
function instrumentLabel() {
  return isFutures() ? "futures" : "options";
}

/**
 * Direction multiplier for a strategy side.
 * Options are always BOUGHT, so premium rises for both CE and PE and the
 * multiplier is +1. Futures express a PE signal as a SHORT, hence -1.
 */
function directionFor(side) {
  if (!isFutures()) return 1;
  return String(side).toUpperCase() === "PE" ? -1 : 1;
}

/**
 * Resolve the tradeable instrument for an entry, for EITHER mode.
 *
 * Options → delegates to the existing validated-symbol path so strike offsets,
 * expiry fallbacks and the `invalid` flag behave exactly as before.
 * Futures  → the month contract; there is no strike, expiry validation or
 * premium, so `entryPremium` is the spot price and the option-only gate inputs
 * come back null.
 *
 * @param {number} spot         current index level
 * @param {"CE"|"PE"} side
 * @param {string} modeTag      strategy tag, passed through for logging
 * @param {function} [fetchQuote] async (symbol) => { ltp, bid, ask } — option mode only
 * @returns {Promise<{symbol,strike,expiry,invalid,isFutures,entryPremium,bid,ask,direction,label}>}
 */
async function resolveEntryInstrument(spot, side, modeTag, fetchQuote) {
  if (isFutures()) {
    const symbol = await instrumentConfig.getSymbol(side);
    return {
      symbol,
      strike:       null,
      expiry:       null,
      invalid:      false,
      isFutures:    true,
      entryPremium: spot,      // futures trade AT the index level
      bid:          null,
      ask:          null,
      direction:    directionFor(side),
      label:        "futures",
    };
  }

  const info = await instrumentConfig.validateAndGetOptionSymbol(spot, side, modeTag);
  let entryPremium = null, bid = null, ask = null;
  if (info && !info.invalid && typeof fetchQuote === "function") {
    const q = await fetchQuote(info.symbol);
    if (q) {
      entryPremium = q.ltp != null ? q.ltp : null;
      bid = q.bid != null ? q.bid : null;
      ask = q.ask != null ? q.ask : null;
    }
  }
  return {
    symbol:    info && info.symbol,
    strike:    info && info.strike,
    expiry:    info && info.expiry,
    invalid:   !info || !!info.invalid,
    isFutures: false,
    entryPremium,
    bid,
    ask,
    direction: 1,
    label:     "options",
  };
}

/**
 * Should premium-domain gates (premium band, option bid-ask spread, option LTP
 * polling, premium disaster stop) run at all? False in futures mode — there is
 * no premium to gate on. Callers skip the gate rather than failing it.
 */
function premiumGatesApply() {
  return !isFutures();
}

/**
 * Net P&L for one completed trade, in whichever mode is active.
 *
 * Options: premium difference × qty (a bought option gains when premium rises,
 *          for both CE and PE).
 * Futures: index difference × direction × qty, with futures charge rates.
 *
 * @param {object} o
 * @param {"CE"|"PE"} o.side
 * @param {number} o.entrySpot     index level at entry
 * @param {number} o.exitSpot      index level at exit
 * @param {number} [o.entryPremium] option premium at entry (options mode)
 * @param {number} [o.exitPremium]  option premium at exit  (options mode)
 * @param {number} o.qty
 * @param {string} [o.broker]
 * @returns {{ pnl, gross, charges, pnlMode, isFutures }}
 */
function computePnl({ side, entrySpot, exitSpot, entryPremium, exitPremium, qty, broker }) {
  const fut = isFutures();
  const _qty = qty || 0;

  if (fut) {
    const dir   = directionFor(side);
    const gross = (exitSpot - entrySpot) * dir * _qty;
    const charges = getCharges({ broker, isFutures: true, entryPremium: entrySpot, exitPremium: exitSpot, qty: _qty });
    return {
      gross:   parseFloat(gross.toFixed(2)),
      charges,
      pnl:     parseFloat((gross - charges).toFixed(2)),
      pnlMode: `futures: entry ₹${entrySpot} → exit ₹${exitSpot} (${dir > 0 ? "LONG" : "SHORT"})`,
      isFutures: true,
    };
  }

  const gross   = (exitPremium - entryPremium) * _qty;
  const charges = getCharges({ broker, isFutures: false, entryPremium, exitPremium, qty: _qty });
  return {
    gross:   parseFloat(gross.toFixed(2)),
    charges,
    pnl:     parseFloat((gross - charges).toFixed(2)),
    pnlMode: `option premium: entry ₹${entryPremium} → exit ₹${exitPremium}`,
    isFutures: false,
  };
}

/**
 * Capital one position ties up, for the (advisory) capital pool.
 *
 * Options: the premium outlay, `qty × premium` — what the trade actually spends.
 * Futures: SPAN+exposure margin, NOT the notional. `qty × 24000` would read as
 * ₹15.6 lakh on a lot that really blocks ~₹1.6 lakh, so every futures entry
 * would log a false "pool overdrawn" warning. Approximated as a percentage of
 * notional via NIFTY_FUTURES_MARGIN_PCT (default 11%, ≈ the current NSE
 * SPAN+exposure requirement); the pool is observational and fails open, so an
 * approximation here can never block a trade.
 *
 * @param {number} qty
 * @param {number} price   premium (options) or index level (futures)
 */
function capitalRequired(qty, price) {
  const _qty = qty || 0;
  const _px  = price || 0;
  if (!isFutures()) return _qty * _px;
  let pct = parseFloat(process.env.NIFTY_FUTURES_MARGIN_PCT || "11");
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) pct = 11;
  return parseFloat((_qty * _px * (pct / 100)).toFixed(2));
}

/**
 * Live unrealised P&L while a position is open — same split as computePnl but
 * without charges, for status/dashboard display.
 */
function unrealisedPnl({ side, entrySpot, currentSpot, entryPremium, currentPremium, qty }) {
  const _qty = qty || 0;
  if (isFutures()) {
    return parseFloat((((currentSpot - entrySpot) * directionFor(side)) * _qty).toFixed(2));
  }
  if (entryPremium == null || currentPremium == null) return 0;
  return parseFloat(((currentPremium - entryPremium) * _qty).toFixed(2));
}

module.exports = {
  isFutures,
  capitalRequired,
  instrumentLabel,
  directionFor,
  resolveEntryInstrument,
  premiumGatesApply,
  computePnl,
  unrealisedPnl,
};

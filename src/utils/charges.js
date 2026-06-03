/**
 * CHARGES — Trading charges calculator (STT, brokerage, exchange, GST, etc.)
 * ─────────────────────────────────────────────────────────────────────────────
 * Calculates realistic per-trade charges for NIFTY Options & Futures.
 * All rates are configurable via .env so they can be updated when NSE/SEBI
 * changes them (e.g. STT hike effective April 2026).
 *
 * Usage:
 *   const { calcCharges } = require("../utils/charges");
 *   const charges = calcCharges({ isFutures, exitPremium, qty });
 *   const netPnl = rawPnl - charges.total;
 *
 * Env keys (all optional — sensible defaults baked in):
 *   STT_OPT_SELL_PCT          Options STT on sell side (default 0.15 → 0.15% of premium)
 *   STT_FUT_SELL_PCT          Futures STT on sell side (default 0.05 → 0.05% of turnover)
 *   EXCHANGE_TXN_OPT_PCT      NSE options exchange txn (default 0.03553 → 0.03553% of premium turnover)
 *   EXCHANGE_TXN_FUT_PCT      NSE futures exchange txn (default 0.00183 → 0.00183% of turnover)
 *   SEBI_CHARGES_PER_CRORE    SEBI turnover fee ₹ per crore (default 10)
 *   GST_PCT                   GST on (brokerage + exchange txn + SEBI) (default 18 → 18%)
 *   STAMP_DUTY_PCT            Stamp duty on buy side (default 0.003 → 0.003%)
 *   BROKER_FLAT_PER_ORDER     Flat brokerage per executed order (default 20)
 * ─────────────────────────────────────────────────────────────────────────────
 */

function env(key, fallback) {
  const v = process.env[key];
  return v !== undefined && v !== "" ? parseFloat(v) : fallback;
}

/**
 * Calculate total charges for one completed trade (entry + exit).
 *
 * @param {Object}  opts
 * @param {boolean} opts.isFutures      — true for futures, false for options
 * @param {number}  opts.exitPremium    — option premium at exit (sell side) or futures exit price
 * @param {number}  opts.entryPremium   — option premium at entry (buy side) or futures entry price
 * @param {number}  opts.qty            — quantity (lot size × multiplier)
 * @param {string}  [opts.broker]       — "fyers" for Fyers rates, default uses Kite/env rates
 * @returns {{ stt, exchangeTxn, sebi, gst, stampDuty, brokerage, total }}
 */
function calcCharges({ isFutures, exitPremium, entryPremium, qty, broker }) {
  // ── Rates from env (or defaults — current NSE / statutory schedule) ──────
  // STT is a central-govt tax and exchange transaction charges are levied by
  // the exchange (NSE) — BOTH are identical for every broker (Zerodha, Fyers,
  // …). There is deliberately no broker-specific override here; the `broker`
  // arg is kept only for call-site compatibility.
  const sttOptPct       = env("STT_OPT_SELL_PCT",     0.15);     // % of sell-side premium  (govt STT — Apr 2026)
  const sttFutPct       = env("STT_FUT_SELL_PCT",     0.05);     // % of sell-side turnover (govt STT)
  const exchOptPct      = env("EXCHANGE_TXN_OPT_PCT", 0.03553);  // % — NSE options txn on premium turnover
  const exchFutPct      = env("EXCHANGE_TXN_FUT_PCT", 0.00183);  // % — NSE futures txn on turnover
  const sebiPerCrore    = env("SEBI_CHARGES_PER_CRORE", 10);     // ₹ per crore (turnover)
  const gstPct          = env("GST_PCT",                18);     // % on (brokerage + exchange txn + SEBI)
  const stampDutyPct    = env("STAMP_DUTY_PCT",         0.003);  // % on buy-side turnover
  const brokerFlat      = env("BROKER_FLAT_PER_ORDER",  20);     // ₹ per executed order (flat)

  const _qty = qty || 1;

  // Sell-side turnover (for STT)
  const sellTurnover = (exitPremium || 0) * _qty;
  // Buy-side turnover (for stamp duty)
  const buyTurnover  = (entryPremium || 0) * _qty;
  // Total turnover (both legs — for exchange txn charges & SEBI)
  const totalTurnover = sellTurnover + buyTurnover;

  // ── STT ──────────────────────────────────────────────────────────────────
  const sttRate = isFutures ? sttFutPct : sttOptPct;
  const stt     = parseFloat(((sttRate / 100) * sellTurnover).toFixed(2));

  // ── Exchange transaction charges (NSE) ──────────────────────────────────
  // Options and futures have very different exchange txn rates
  const exchRate    = isFutures ? exchFutPct : exchOptPct;
  const exchangeTxn = parseFloat(((exchRate / 100) * totalTurnover).toFixed(2));

  // ── SEBI charges ────────────────────────────────────────────────────────
  const sebi = parseFloat(((sebiPerCrore / 10000000) * totalTurnover).toFixed(2));

  // ── Brokerage (flat per order × 2 legs) ─────────────────────────────────
  const brokerage = brokerFlat * 2;

  // ── GST (18% on brokerage + exchange txn + SEBI charges) ────────────────
  const gst = parseFloat(((gstPct / 100) * (brokerage + exchangeTxn + sebi)).toFixed(2));

  // ── Stamp duty (buy side only) ──────────────────────────────────────────
  const stampDuty = parseFloat(((stampDutyPct / 100) * buyTurnover).toFixed(2));

  // ── Total ───────────────────────────────────────────────────────────────
  const total = parseFloat((stt + exchangeTxn + sebi + gst + stampDuty + brokerage).toFixed(2));

  return { stt, exchangeTxn, sebi, gst, stampDuty, brokerage, total };
}

/**
 * Quick helper: returns just the total charges number.
 * Falls back to a flat estimate when premium data is unavailable.
 */
function getCharges({ isFutures, exitPremium, entryPremium, qty, broker }) {
  // If we have no premium data, use a conservative flat estimate
  if (!exitPremium && !entryPremium) {
    return isFutures ? 60 : 100;
  }
  return calcCharges({ isFutures, exitPremium, entryPremium, qty, broker }).total;
}

module.exports = { calcCharges, getCharges };

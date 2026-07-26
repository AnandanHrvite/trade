/**
 * ORB STOP ↔ RISK-BUDGET RECONCILIATION
 * ─────────────────────────────────────────────────────────────────────────────
 * ORB carried TWO independent stops that disagreed with each other:
 *
 *   1. `sig.slSpot` — a spot level: the wider of the entry candle's extreme and
 *      ORB_SL_ATR_MULT × ATR(5m). On typical NIFTY volatility that is 50–83 pts.
 *   2. ORB_MAX_TRADE_LOSS — a rupee cap checked per tick on the option premium.
 *      At ₹1,500 / 65-lot / ~0.6 delta it trips after only ~38 pts of adverse
 *      SPOT move.
 *
 * The rupee cap is tighter, so it ended essentially every losing trade while the
 * dashboard, the Telegram alert and the trade record all advertised the wider
 * spot level. The operator was shown a stop that was never the real one, and the
 * 39-session study measured a ₹3,000 difference between the two behaviours
 * (₹9,736 with only the spot stop vs ₹6,737 once the cap was modelled).
 *
 * This module makes the two consistent: the initial stop is the tighter of the
 * structural/ATR level and the level implied by the rupee budget. What is shown
 * is what executes.
 *
 * WHY CLAMP RATHER THAN WIDEN THE BUDGET — the alternative is to raise
 * ORB_MAX_TRADE_LOSS to ~₹2,300 so a 1.5×ATR stop fits inside it. That is a
 * capital decision, not an engineering one, so the default is the conservative
 * direction. When the ATR stop is being clamped the routes log it explicitly, so
 * the budget being the binding constraint is visible rather than silent.
 *
 * DELTA ASSUMPTION — converting a rupee budget into spot points needs the
 * option's delta, which we do not know exactly at entry. A slightly-ITM NIFTY
 * weekly (ORB_ITM_STEPS=1) runs ~0.60. Erring HIGH is the safe direction: a
 * higher assumed delta yields a SMALLER point budget, i.e. a tighter stop, so a
 * wrong assumption exits early rather than late. The real per-tick rupee cap in
 * the routes still runs underneath as the authoritative backstop.
 */

// Slightly-ITM NIFTY weekly. Deliberately not an env key — see the note above:
// it is a conservative modelling constant, not a tuning dial.
const ASSUMED_DELTA = 0.60;

function _r2(x) { return Math.round(x * 100) / 100; }

/**
 * Reconcile a strategy stop against the per-trade rupee budget.
 *
 * @param {object}  p
 * @param {"CE"|"PE"} p.side
 * @param {number}  p.entrySpot      spot at entry
 * @param {number}  p.strategyStop   sig.slSpot (may be null/undefined)
 * @param {number}  p.qty            lot quantity actually traded
 * @param {number}  [p.fallbackStop] used when strategyStop is unusable
 * @returns {{slSpot:number, spotStopPts:number, capSpotPts:number|null,
 *            clamped:boolean, note:string}}
 */
function resolveInitialStop({ side, entrySpot, strategyStop, qty, fallbackStop }) {
  const raw = Number.isFinite(strategyStop) ? strategyStop
            : (Number.isFinite(fallbackStop) ? fallbackStop : entrySpot);

  const maxTradeLoss = parseFloat(process.env.ORB_MAX_TRADE_LOSS || "1500");
  const rawPts = Math.abs(entrySpot - raw);

  // No budget configured (0 = off) → the strategy stop stands as-is.
  if (!(maxTradeLoss > 0) || !(qty > 0)) {
    return { slSpot: _r2(raw), spotStopPts: _r2(rawPts), capSpotPts: null, clamped: false,
             note: `spot SL ${_r2(raw)} (${rawPts.toFixed(1)}pt); no rupee cap configured` };
  }

  const capSpotPts = (maxTradeLoss / qty) / ASSUMED_DELTA;
  if (rawPts <= capSpotPts) {
    return { slSpot: _r2(raw), spotStopPts: _r2(rawPts), capSpotPts: _r2(capSpotPts), clamped: false,
             note: `spot SL ${_r2(raw)} (${rawPts.toFixed(1)}pt) is inside the ₹${maxTradeLoss} budget (~${capSpotPts.toFixed(1)}pt) — spot SL binds` };
  }

  const clampedStop = side === "CE" ? entrySpot - capSpotPts : entrySpot + capSpotPts;
  return {
    slSpot: _r2(clampedStop),
    spotStopPts: _r2(capSpotPts),
    capSpotPts: _r2(capSpotPts),
    clamped: true,
    note: `spot SL tightened ${_r2(raw)} → ${_r2(clampedStop)}: the strategy wanted ${rawPts.toFixed(1)}pt but the ₹${maxTradeLoss} per-trade budget only allows ~${capSpotPts.toFixed(1)}pt (qty ${qty}, assumed delta ${ASSUMED_DELTA}). RAISE ORB_MAX_TRADE_LOSS if you want the full ATR stop.`,
  };
}

module.exports = { resolveInitialStop, ASSUMED_DELTA };

// Shared live/paper-trade guards: bid-ask spread filter at entry, time-stop at exit.
// Keeps paper and live engines aligned on real-market frictions the backtest ignores.

const DEFAULT_MAX_SPREAD_PTS = parseFloat(process.env.MAX_BID_ASK_SPREAD_PTS || "2");
const DEFAULT_TIME_STOP_CANDLES = parseInt(process.env.TIME_STOP_CANDLES || "4", 10);
const DEFAULT_TIME_STOP_FLAT_PTS = parseFloat(process.env.TIME_STOP_FLAT_PTS || "20");

async function fetchOptionQuote(fyers, symbol) {
  try {
    const response = await fyers.getQuotes([symbol]);
    if (response && response.s === "ok" && response.d && response.d.length > 0) {
      const v = response.d[0].v || response.d[0];
      const ltp = Number(
        v.lp || v.ltp || v.last_price || v.last_traded_price ||
        v.ask_price || v.bid_price || v.close_price || v.prev_close_price || 0
      );
      const bid = Number(v.bid || v.bid_price || 0);
      const ask = Number(v.ask || v.ask_price || 0);
      if (ltp > 0) return { ltp, bid, ask };
    }
  } catch (_) { /* swallow — caller fail-opens */ }
  return null;
}

// Returns { ok, spread, reason }. Fails OPEN (ok=true) if bid/ask unavailable —
// we don't want to starve live trading when the broker snapshot lacks depth fields.
function checkSpread(bid, ask, maxSpreadPts = DEFAULT_MAX_SPREAD_PTS) {
  if (!bid || !ask || ask <= 0 || bid <= 0 || ask < bid) {
    return { ok: true, spread: null, reason: "no-quote" };
  }
  const spread = parseFloat((ask - bid).toFixed(2));
  return { ok: spread <= maxSpreadPts, spread, reason: `bid=${bid} ask=${ask} spread=${spread}pt` };
}

// Returns an exit-reason string if the time-stop should fire, else null.
// Fires only when the trade has been held >= maxCandles AND option-premium PnL
// is still within ±flatPts (i.e., no meaningful move — pure theta bleed risk).
function checkTimeStop(candlesHeld, pnlPts, {
  maxCandles = DEFAULT_TIME_STOP_CANDLES,
  flatPts    = DEFAULT_TIME_STOP_FLAT_PTS,
} = {}) {
  if (!Number.isFinite(candlesHeld) || candlesHeld < maxCandles) return null;
  if (!Number.isFinite(pnlPts))                                 return null;
  if (Math.abs(pnlPts) >= flatPts)                              return null;
  const sign = pnlPts >= 0 ? "+" : "";
  return `Time-stop — flat after ${candlesHeld} candles (${sign}${pnlPts.toFixed(1)}pt)`;
}

module.exports = {
  fetchOptionQuote,
  checkSpread,
  checkTimeStop,
  DEFAULT_MAX_SPREAD_PTS,
  DEFAULT_TIME_STOP_CANDLES,
  DEFAULT_TIME_STOP_FLAT_PTS,
};

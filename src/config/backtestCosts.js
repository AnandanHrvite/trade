// Common backtest cost settings — ONE place for every NIFTY / BANK NIFTY option
// backtest (Settings → Instrument & Backtest). No strategy has its own copy.
// Read live on each call so a Settings save applies to the next run.

function _num(raw, def, minExclusive) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return def;
  return minExclusive ? (n > 0 ? n : def) : (n >= 0 ? n : def);
}

/** Spread + slippage haircut charged EACH way, in points. */
function slippagePts() { return _num(process.env.BACKTEST_SLIPPAGE_PTS, 1.5, false); }

/** Assumed option premium at entry (₹) for the δ+θ premium simulation. */
function seedPremium() { return _num(process.env.BACKTEST_SEED_PREMIUM, 240, true); }

module.exports = { slippagePts, seedPremium };

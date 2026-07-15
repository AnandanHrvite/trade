/**
 * walkForward.js — rolling out-of-sample fold analysis for a backtest's trades.
 * ─────────────────────────────────────────────────────────────────────────────
 * Splits a chronological trade list into consecutive test folds (default 20
 * trading days each) and reports per-fold metrics + an aggregate stability read.
 *
 * WHY this is honest even with fixed parameters: the Trend Pullback backtest runs
 * on FIXED default env params (no in-sample optimisation yet), so every fold's
 * stats are out-of-sample BY CONSTRUCTION — the parameters were never fit to any
 * fold. This surfaces "does the edge hold across time, or is it one lucky month?"
 * When a parameter search is later bolted on, the same fold boundaries become the
 * train→test split: choose params on the trades BEFORE a fold, score on the fold.
 *
 * Thin folds (< minTrades) are flagged: a "win" inside a tiny sample is noise, not
 * proven edge — the caller should treat flagged folds as non-evidence.
 */

function _foldStats(trades) {
  const n = trades.length;
  const wins = trades.filter(t => (t.pnl || 0) > 0);
  const losses = trades.filter(t => (t.pnl || 0) < 0);
  const net = trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return {
    trades: n,
    winRate: n ? parseFloat(((wins.length / n) * 100).toFixed(1)) : 0,
    netPnl: parseFloat(net.toFixed(2)),
    profitFactor: gl > 0 ? parseFloat((gp / gl).toFixed(2)) : (gp > 0 ? Infinity : 0),
    expectancy: n ? parseFloat((net / n).toFixed(2)) : 0,
  };
}

/**
 * @param {Array} trades  backtest trades, chronological, each with `pnl` and
 *                        `entry` = "DD/MM/YYYY, HH:MM:SS" (the day is parsed from it).
 * @param {object} opts   { testDays=20, minTrades=20 }
 * @returns {{ folds, foldCount, oosNetPnl, oosExpectancy, oosProfitFactor,
 *            positiveFolds, thinFolds, verdict }}
 */
function walkForward(trades, opts = {}) {
  const testDays  = Math.max(1, parseInt(opts.testDays  || process.env.TREND_PB_WF_TEST_DAYS || "20", 10));
  const minTrades = Math.max(1, parseInt(opts.minTrades || process.env.TREND_PB_WF_MIN_TRADES || "20", 10));

  // Group trades by IST date (insertion order = chronological, since trades are
  // produced day-by-day in ascending time).
  const byDate = new Map();
  for (const t of (trades || [])) {
    const d = String(t.entry || "").split(",")[0].trim();
    if (!d) continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(t);
  }
  const dates = [...byDate.keys()];

  const folds = [];
  for (let i = 0; i < dates.length; i += testDays) {
    const chunkDates = dates.slice(i, i + testDays);
    const chunkTrades = chunkDates.flatMap(d => byDate.get(d));
    if (!chunkTrades.length) continue;
    folds.push(Object.assign(
      { from: chunkDates[0], to: chunkDates[chunkDates.length - 1], days: chunkDates.length, thin: chunkTrades.length < minTrades },
      _foldStats(chunkTrades),
    ));
  }

  const net = folds.reduce((a, f) => a + f.netPnl, 0);
  const nTrades = folds.reduce((a, f) => a + f.trades, 0);
  const positiveFolds = folds.filter(f => f.netPnl > 0).length;
  const thinFolds = folds.filter(f => f.thin).length;
  // Aggregate PF across ALL trades (not an average of per-fold ratios).
  const gp = (trades || []).filter(t => (t.pnl || 0) > 0).reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs((trades || []).filter(t => (t.pnl || 0) < 0).reduce((a, t) => a + t.pnl, 0));

  const solidFolds = folds.filter(f => !f.thin);
  const solidPositive = solidFolds.filter(f => f.netPnl > 0).length;
  let verdict;
  if (folds.length === 0) verdict = "no trades — nothing to evaluate";
  else if (solidFolds.length === 0) verdict = `all ${folds.length} fold(s) are statistically thin (< ${minTrades} trades) — NOT PROVEN, collect more data`;
  else if (solidPositive === solidFolds.length && net > 0) verdict = `edge is consistent — every non-thin fold (${solidPositive}/${solidFolds.length}) is net-positive`;
  else if (solidPositive >= Math.ceil(solidFolds.length * 0.6) && net > 0) verdict = `edge is mixed but net-positive — ${solidPositive}/${solidFolds.length} non-thin folds positive`;
  else verdict = `edge NOT established — only ${solidPositive}/${solidFolds.length} non-thin folds positive (net ₹${net.toFixed(0)}) — likely noise`;

  return {
    folds,
    foldCount: folds.length,
    testDays, minTrades,
    oosNetPnl: parseFloat(net.toFixed(2)),
    oosTrades: nTrades,
    oosExpectancy: nTrades ? parseFloat((net / nTrades).toFixed(2)) : 0,
    oosProfitFactor: gl > 0 ? parseFloat((gp / gl).toFixed(2)) : (gp > 0 ? Infinity : 0),
    positiveFolds, thinFolds, verdict,
  };
}

module.exports = { walkForward };

/**
 * Chart backfill for restart-recovered paper sessions.
 *
 * After a server restart the paper engines rehydrate their Session Trades from
 * the JSONL day log (see each paper route's rehydrateSessionFromJsonl), but the
 * in-memory candle series (`state.candles`) starts empty — it only fills from the
 * live tick feed once a session is running. So the chart comes back blank even
 * though the trades (and their entry/exit bar-times) are restored.
 *
 * This helper fetches the spot candles for the day the restored trades belong to
 * so the chart can draw them with the existing time-anchored markers. It is:
 *   - cache-first (uses candleCache.fetchCandlesCached) — a day already cached
 *     from its live session is served with NO broker call, which is what makes
 *     this work after market hours when the broker token may be stale;
 *   - best-effort — any failure returns [] so the chart simply stays empty while
 *     the Session Trades table still shows;
 *   - memoised per symbol+resolution+day so the 4-second chart poll doesn't refetch.
 *
 * All four strategies chart the same Fyers NIFTY50 spot feed (NSE:NIFTY50-INDEX),
 * so one helper serves them all.
 */

const { fetchCandlesCached } = require("./candleCache");
const { fetchCandles } = require("../services/backtestEngine");

const DAY_SEC = 86400;
const _cache = new Map(); // `${symbol}|${res}|${day}` -> candles[]

// IST date string (YYYY-MM-DD) for a unix-seconds timestamp.
function _istDate(unixSec) {
  return new Date(unixSec * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// The most recent bar time across the restored trades — the day to chart.
function _latestBarSec(trades) {
  let max = 0;
  for (const t of (trades || [])) {
    const b = Number(t.exitBarTime || t.entryBarTime) || 0;
    if (b > max) max = b;
  }
  return max;
}

/**
 * Candles for the restored trades' day (+ ~6 calendar days of warmup so EMA /
 * SuperTrend / BB overlays are populated on that day). Returns [] on any failure.
 *
 * @param {string} symbol      spot symbol (NSE:NIFTY50-INDEX)
 * @param {string|number} res  candle resolution in minutes (5 / 15)
 * @param {Array} trades       restored session trades (need entryBarTime/exitBarTime)
 */
async function candlesForRestoredTrades(symbol, res, trades) {
  try {
    const maxSec = _latestBarSec(trades);
    if (!maxSec) return [];
    const day  = _istDate(maxSec);
    const from = _istDate(maxSec - 6 * DAY_SEC);
    const key  = `${symbol}|${res}|${day}`;
    if (_cache.has(key)) return _cache.get(key);
    const candles = await fetchCandlesCached(symbol, String(res), from, day, fetchCandles);
    const out = Array.isArray(candles) ? candles : [];
    // Only memoise a real result — caching [] would pin the chart empty until a
    // process restart even if a later poll (token refreshed) could succeed.
    if (out.length) _cache.set(key, out);
    return out;
  } catch (_) {
    return [];
  }
}

module.exports = { candlesForRestoredTrades };

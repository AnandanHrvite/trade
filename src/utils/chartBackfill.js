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

    // Prefer a DIRECT broker fetch of the full range. The candle cache for that
    // day often holds only the morning preload from its live session (a partial
    // day), and a partial day would clamp every afternoon marker to the chart's
    // right edge — worse than no chart. A direct fetch returns the complete day
    // whenever the broker token is valid (historical data works any time of day).
    // Fall back to the cache-first path only if the direct fetch is unavailable.
    let candles = [];
    try { candles = await fetchCandles(symbol, String(res), from, day); }
    catch (_) { candles = []; }
    if (!Array.isArray(candles) || !candles.length) {
      try { candles = await fetchCandlesCached(symbol, String(res), from, day, fetchCandles); }
      catch (_) { candles = []; }
    }
    const out = Array.isArray(candles) ? candles : [];

    // Reach-check: only use the candles if they actually extend to the latest
    // trade. If we only got a partial day (last candle hours before the last
    // trade), the markers would clamp to the edge — show nothing instead (the
    // Session Trades table still lists them; full history is in Replay / History).
    // One-bucket tolerance: the broker may omit the still-forming last bucket.
    const resSec = (Number(res) || 5) * 60;
    if (!out.length || out[out.length - 1].time < maxSec - resSec) return [];

    _cache.set(key, out); // only memoise a real, complete result
    return out;
  } catch (_) {
    return [];
  }
}

module.exports = { candlesForRestoredTrades };

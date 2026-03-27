/**
 * candleCache.js — Persistent 15-min candle cache
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores candles at ~/trading-data/candle_cache/<symbol>_<resolution>.json
 * Survives server restarts and code deploys (outside project directory).
 *
 * Strategy:
 *   - On fetch: load cache → find the last cached timestamp
 *   - Only call Fyers API for candles AFTER the last cached one
 *   - Append new candles → save → return full merged set
 *   - Today's candles are always re-fetched (live day, incomplete bars)
 *   - Cache older than 60 days is trimmed to keep file size small
 *
 * Usage (drop-in replacement for fetchCandles):
 *   const { fetchCandlesCached } = require("../utils/candleCache");
 *   const candles = await fetchCandlesCached(symbol, resolution, from, to, rawFetcher);
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const CACHE_DIR    = path.join(os.homedir(), "trading-data", "candle_cache");
const MAX_CACHE_DAYS = 60; // trim candles older than this
const CANDLES_15MIN_PER_DAY = 26; // 9:15–15:30 = 26 fifteen-min bars

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(symbol, resolution) {
  // e.g. "NSE:NIFTY50-INDEX_15" → "NSE_NIFTY50-INDEX_15"
  return symbol.replace(/[:/]/g, "_") + "_" + resolution;
}

function cachePath(symbol, resolution) {
  return path.join(CACHE_DIR, cacheKey(symbol, resolution) + ".json");
}

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function dateToUnixStart(dateStr) {
  // "YYYY-MM-DD" → unix seconds at 09:00 IST (before market open)
  const d = new Date(dateStr + "T03:30:00.000Z"); // 09:00 IST = 03:30 UTC
  return Math.floor(d.getTime() / 1000);
}

/** Load cache from disk. Returns [] if missing or corrupt. */
function loadCache(symbol, resolution) {
  try {
    const p = cachePath(symbol, resolution);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data;
  } catch (_) {
    return [];
  }
}

/** Save cache to disk atomically (tmp → rename). */
function saveCache(symbol, resolution, candles) {
  try {
    ensureCacheDir();
    const p   = cachePath(symbol, resolution);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(candles));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn("[candleCache] Save failed:", e.message);
  }
}

/** Trim candles older than MAX_CACHE_DAYS to keep file small. */
function trimOldCandles(candles) {
  const cutoff = Math.floor(Date.now() / 1000) - MAX_CACHE_DAYS * 24 * 60 * 60;
  return candles.filter(c => c.time >= cutoff);
}

/**
 * Merge two sorted candle arrays, deduplicate by timestamp.
 */
function mergeCandles(existing, fresh) {
  const map = new Map();
  for (const c of existing) map.set(c.time, c);
  for (const c of fresh)    map.set(c.time, c); // fresh overwrites (more accurate)
  return [...map.values()].sort((a, b) => a.time - b.time);
}

/**
 * fetchCandlesCached — drop-in wrapper around raw fetchCandles
 *
 * @param {string}   symbol      - e.g. "NSE:NIFTY50-INDEX"
 * @param {string}   resolution  - e.g. "15"
 * @param {string}   from        - "YYYY-MM-DD" start date requested
 * @param {string}   to          - "YYYY-MM-DD" end date requested
 * @param {Function} rawFetcher  - original fetchCandles(symbol, res, from, to)
 * @returns {Promise<Array>}     - full candle array from `from` to `to`
 */
async function fetchCandlesCached(symbol, resolution, from, to, rawFetcher) {
  // Only cache 15-min candles — backtest uses arbitrary ranges, cache for warm-up only
  const shouldCache = String(resolution) === "15";

  if (!shouldCache) {
    // Bypass cache for non-15min (backtest) — fetch directly
    return rawFetcher(symbol, resolution, from, to);
  }

  ensureCacheDir();
  const today = todayIST();

  // Load existing cache
  let cached = loadCache(symbol, resolution);
  cached = trimOldCandles(cached);

  // Find what we already have
  const cachedFrom = cached.length > 0
    ? new Date(cached[0].time  * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
    : null;
  const cachedTo = cached.length > 0
    ? new Date(cached[cached.length - 1].time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
    : null;

  // Determine what we need to fetch from API
  // Rule: always re-fetch TODAY (live day, candles still forming)
  // For past dates: only fetch what we don't have
  let fetchFrom = from;
  let fetchTo   = to;
  let skipFetch = false;

  if (cached.length > 0 && cachedFrom && cachedTo) {
    // We have cache. Determine the missing range.
    const needFrom = from < cachedFrom ? from : null; // data before our cache
    const needTo   = to;                               // always need up to `to`

    // If we have all historical data and only today's date is missing/partial
    const onlyTodayMissing = !needFrom && cachedTo >= yesterdayIST();

    if (onlyTodayMissing) {
      // Just fetch today's candles to update live bars
      fetchFrom = today;
      fetchTo   = today;
      console.log(`[candleCache] ✅ Cache hit for ${symbol} ${resolution}min — fetching only today (${today})`);
    } else if (!needFrom && cachedTo >= to && cachedTo !== today) {
      // Have everything and today isn't requested — skip fetch entirely
      skipFetch = true;
      console.log(`[candleCache] ✅ Full cache hit for ${symbol} ${resolution}min — no API call needed`);
    } else {
      // Fetch from where cache ends (or from requested start if we need earlier data)
      fetchFrom = needFrom || cachedTo; // start from end of cache
      fetchTo   = to;
      console.log(`[candleCache] 🔄 Partial cache — fetching ${fetchFrom} to ${fetchTo}`);
    }
  } else {
    console.log(`[candleCache] 📥 No cache for ${symbol} ${resolution}min — fetching ${from} to ${to}`);
  }

  // Fetch from API if needed
  let fresh = [];
  if (!skipFetch) {
    try {
      fresh = await rawFetcher(symbol, resolution, fetchFrom, fetchTo);
      console.log(`[candleCache] 📦 Fetched ${fresh.length} candles from API`);
    } catch (err) {
      console.warn(`[candleCache] ⚠️ API fetch failed: ${err.message} — using cached data only`);
      fresh = [];
    }
  }

  // Merge + save
  const merged = mergeCandles(cached, fresh);
  if (fresh.length > 0) {
    saveCache(symbol, resolution, trimOldCandles(merged));
    console.log(`[candleCache] 💾 Cache updated: ${merged.length} total candles stored`);
  }

  // Return only what was requested (filter by date range)
  const fromTs = dateToUnixStart(from);
  const toTs   = dateToUnixStart(to) + 24 * 60 * 60; // end of `to` day
  const result = merged.filter(c => c.time >= fromTs && c.time <= toTs);

  console.log(`[candleCache] ✅ Returning ${result.length} candles for ${from} → ${to}`);
  return result;
}

function yesterdayIST() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Returns cache stats for display (e.g. on dashboard) */
function getCacheInfo(symbol, resolution) {
  try {
    const p = cachePath(symbol, resolution);
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = new Date(data[0].time * 1000).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
    const last  = new Date(data[data.length-1].time * 1000).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
    return {
      candles:   data.length,
      from:      first,
      to:        last,
      sizeKB:    Math.round(stat.size / 1024),
      path:      p,
    };
  } catch (_) { return null; }
}

/** Force-clear cache for a symbol (e.g. if data looks wrong) */
function clearCache(symbol, resolution) {
  try {
    const p = cachePath(symbol, resolution);
    if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
  } catch (_) {}
  return false;
}

module.exports = { fetchCandlesCached, getCacheInfo, clearCache, CACHE_DIR };

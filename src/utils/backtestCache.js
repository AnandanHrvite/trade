/**
 * backtestCache.js — Persistent disk cache for backtest candle data
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores fetched candles at ~/trading-data/backtest_cache/<key>.json
 * so repeated backtest runs with the same parameters skip Fyers API entirely.
 *
 * Key design decisions (thinking like a trader):
 *   - Historical candles NEVER change → cache them indefinitely
 *   - Ranges that include TODAY are never cached (candles still forming)
 *   - Cache key = symbol + resolution + from + to  (exact match)
 *   - Atomic writes (tmp → rename) to prevent corruption
 *   - Optional skipCache flag for forced fresh fetch
 *   - Cache auto-prunes files older than 90 days to prevent unbounded growth
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const CACHE_DIR = path.join(os.homedir(), "trading-data", "backtest_cache");
const MAX_AGE_DAYS = 90; // auto-prune cache files older than this

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/**
 * Build a safe filename from backtest parameters.
 * e.g. "NSE_NIFTY50-INDEX_15_2024-01-01_2024-01-31.json"
 */
function cacheFileName(symbol, resolution, from, to) {
  const safe = symbol.replace(/[:/]/g, "_");
  return `${safe}_${resolution}_${from}_${to}.json`;
}

function cacheFilePath(symbol, resolution, from, to) {
  return path.join(CACHE_DIR, cacheFileName(symbol, resolution, from, to));
}

/** Load cached candles. Returns null if cache miss. */
async function loadFromCache(symbol, resolution, from, to) {
  try {
    const p = cacheFilePath(symbol, resolution, from, to);
    if (!fs.existsSync(p)) return null;
    const raw = await fs.promises.readFile(p, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data) || data.length === 0) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/** Save candles to cache atomically. */
function saveToCache(symbol, resolution, from, to, candles) {
  try {
    ensureDir();
    const p   = cacheFilePath(symbol, resolution, from, to);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(candles));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn("[backtestCache] Save failed:", e.message);
  }
}

/**
 * fetchCandlesWithCache — wraps raw fetchCandles with disk caching
 *
 * @param {string}   symbol      - e.g. "NSE:NIFTY50-INDEX"
 * @param {string}   resolution  - e.g. "15", "3", "D"
 * @param {string}   from        - "YYYY-MM-DD"
 * @param {string}   to          - "YYYY-MM-DD"
 * @param {Function} rawFetcher  - original fetchCandles(symbol, res, from, to)
 * @param {boolean}  [skipCache] - force fresh fetch (default false)
 * @returns {Promise<Array>}
 */
async function fetchCandlesWithCache(symbol, resolution, from, to, rawFetcher, skipCache = false) {
  const today = todayIST();

  // NEVER cache ranges that include today — candles are still forming
  const rangeTouchesToday = to >= today;

  if (!skipCache && !rangeTouchesToday) {
    const cached = await loadFromCache(symbol, resolution, from, to);
    if (cached) {
      console.log(`[backtestCache] ✅ Cache hit: ${symbol} ${resolution} ${from}→${to} (${cached.length} candles)`);
      return cached;
    }
  }

  // Cache miss or skip — fetch from API
  const candles = await rawFetcher(symbol, resolution, from, to);

  // Only cache if we got data and range is fully historical
  if (candles.length > 0 && !rangeTouchesToday) {
    saveToCache(symbol, resolution, from, to, candles);
    console.log(`[backtestCache] 💾 Cached: ${symbol} ${resolution} ${from}→${to} (${candles.length} candles)`);
  }

  return candles;
}

/**
 * Prune cache files older than MAX_AGE_DAYS.
 * Call this occasionally (e.g. on server start) to prevent unbounded growth.
 */
function pruneOldCacheFiles() {
  try {
    ensureDir();
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".json"));
    let pruned = 0;
    for (const f of files) {
      const fp = path.join(CACHE_DIR, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        pruned++;
      }
    }
    if (pruned > 0) console.log(`[backtestCache] 🧹 Pruned ${pruned} old cache files`);
  } catch (e) {
    console.warn("[backtestCache] Prune failed:", e.message);
  }
}

/** Get cache stats for diagnostics */
function getCacheStats() {
  try {
    ensureDir();
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".json"));
    let totalSize = 0;
    for (const f of files) {
      totalSize += fs.statSync(path.join(CACHE_DIR, f)).size;
    }
    return {
      files: files.length,
      sizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      dir: CACHE_DIR,
    };
  } catch (_) {
    return { files: 0, sizeMB: "0", dir: CACHE_DIR };
  }
}

/** Clear all backtest cache files */
function clearAllCache() {
  try {
    ensureDir();
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".json"));
    for (const f of files) fs.unlinkSync(path.join(CACHE_DIR, f));
    return files.length;
  } catch (_) {
    return 0;
  }
}

// Prune on first load
pruneOldCacheFiles();

/**
 * Split a date range into full calendar months for granular caching.
 * Each month gets its own cache file → reusable across ANY backtest that
 * overlaps that month. First run caches each month; subsequent runs are instant.
 *
 * e.g. "2023-03-15" → "2025-12-31" produces:
 *   2023-03: 2023-03-01 → 2023-03-31
 *   2023-04: 2023-04-01 → 2023-04-30
 *   ...
 *   2025-12: 2025-12-01 → 2025-12-31
 */
function splitIntoMonths(from, to) {
  const segments = [];
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);

  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last day of current
    const mFrom = `${y}-${String(m).padStart(2, '0')}-01`;
    const mTo   = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    segments.push({ from: mFrom, to: mTo });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return segments;
}

/**
 * fetchCandlesSmartCache — monthly-granular caching for intraday data.
 *
 * For daily/weekly/monthly resolution, falls back to single-call cache
 * (one API call covers years). For intraday, splits into calendar months
 * so each month is cached independently and reusable across backtests.
 *
 * @param {string}   symbol
 * @param {string}   resolution
 * @param {string}   from         - "YYYY-MM-DD"
 * @param {string}   to           - "YYYY-MM-DD"
 * @param {Function} rawFetcher   - fetchCandles(symbol, res, from, to)
 * @param {boolean}  [skipCache]
 * @param {Function} [onProgress] - called with { phase, pct } during fetch
 */
async function fetchCandlesSmartCache(symbol, resolution, from, to, rawFetcher, skipCache = false, onProgress) {
  // Daily/weekly/monthly: single-call cache (one API call covers years)
  if (["D", "W", "M"].includes(String(resolution))) {
    return fetchCandlesWithCache(symbol, resolution, from, to, rawFetcher, skipCache);
  }

  const today = todayIST();
  const months = splitIntoMonths(from, to);
  const allCandles = [];
  const seen = new Set(); // deduplicate as we go — avoids full-array pass at end
  let cachedCount = 0, fetchedCount = 0;

  for (let i = 0; i < months.length; i++) {
    const { from: mFrom, to: mTo } = months[i];
    const touchesToday = mTo >= today;

    let monthCandles = null;

    // Try cache for fully historical months
    if (!skipCache && !touchesToday) {
      monthCandles = await loadFromCache(symbol, resolution, mFrom, mTo);
      if (monthCandles) {
        cachedCount++;
        if (onProgress) onProgress({ phase: `Cached ${cachedCount} months, fetching ${fetchedCount}… (${i + 1}/${months.length})`, pct: Math.round(((i + 1) / months.length) * 4) });
      }
    }

    if (!monthCandles) {
      // Cache miss — fetch from API
      // Rate-limit: sleep 350ms between API calls to avoid Fyers "request limit reached"
      if (fetchedCount > 0) await new Promise(r => setTimeout(r, 350));
      if (onProgress) onProgress({ phase: `Fetching ${mFrom} → ${mTo}… (${i + 1}/${months.length} months)`, pct: Math.round(((i + 1) / months.length) * 4) });

      // Retry up to 2 times on rate-limit errors
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          monthCandles = await rawFetcher(symbol, resolution, mFrom, mTo);
          break;
        } catch (err) {
          if (attempt < 2 && (err.message || "").toLowerCase().includes("limit")) {
            console.warn(`[backtestCache] Rate limited on ${mFrom}, waiting 2s before retry…`);
            await new Promise(r => setTimeout(r, 2000));
          } else {
            throw err;
          }
        }
      }
      fetchedCount++;

      // Cache historical months
      if (monthCandles && monthCandles.length > 0 && !touchesToday) {
        saveToCache(symbol, resolution, mFrom, mTo, monthCandles);
      }
      monthCandles = monthCandles || [];
    }

    // Deduplicate per-month (cheaper than full-array pass at end)
    for (const c of monthCandles) {
      if (!seen.has(c.time)) { seen.add(c.time); allCandles.push(c); }
    }
  }

  console.log(`[backtestCache] Smart cache: ${cachedCount} months cached, ${fetchedCount} months fetched, ${allCandles.length} total candles`);

  // Months are fetched in order, so sort is only needed if there's overlap
  allCandles.sort((a, b) => a.time - b.time);
  return allCandles;
}

module.exports = { fetchCandlesWithCache, fetchCandlesSmartCache, getCacheStats, clearAllCache, CACHE_DIR };

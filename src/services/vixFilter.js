/**
 * VIX FILTER — Market Regime Detection
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses India VIX to classify market conditions:
 *   VIX <= VIX_MAX_ENTRY (default 20) → trending market → allow entries
 *   VIX >  VIX_MAX_ENTRY              → choppy/panic   → block entries
 *   VIX >  VIX_STRONG_ONLY (default 16) → only STRONG signals allowed
 *
 * Live/Paper: Polls Fyers REST API for NSE:INDIAVIX-INDEX LTP (cached 60s).
 * Backtest:   Looks up VIX from pre-fetched historical VIX candles by timestamp.
 *
 * Why VIX matters for this strategy:
 *   SAR/EMA9/RSI is a trend-following strategy. In high-VIX regimes:
 *   - Price whipsaws through EMA9 repeatedly → false entries
 *   - SAR flips every 1-2 candles → trailing SL hit before profit develops
 *   - 50% rule fires constantly → string of small losses
 *   VIX filter sits out these days entirely.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fyers = require("../config/fyers");

// ── Config (read dynamically so settings toggle takes effect immediately) ────
function getVixEnabled()    { return process.env.VIX_FILTER_ENABLED !== "false"; }
function getVixMaxEntry()   { return parseFloat(process.env.VIX_MAX_ENTRY    || "20"); }
function getVixStrongOnly() { return parseFloat(process.env.VIX_STRONG_ONLY || "16"); }

const VIX_SYMBOL = "NSE:INDIAVIX-INDEX";

// ── Live VIX cache (60-second TTL) ──────────────────────────────────────────
let _cachedVix   = null;
let _cachedVixTs = 0;
const VIX_CACHE_TTL = 60_000; // 60 seconds

/**
 * Fetch live VIX value from Fyers REST API.
 * Cached for 60 seconds — VIX doesn't change tick-to-tick.
 * Returns null if fetch fails (filter becomes permissive on failure).
 */
async function fetchLiveVix() {
  if (!getVixEnabled()) return null;

  const now = Date.now();
  if (_cachedVix !== null && (now - _cachedVixTs) < VIX_CACHE_TTL) {
    return _cachedVix;
  }

  try {
    const response = await fyers.getQuotes([VIX_SYMBOL]);
    if (response.s === "ok" && response.d && response.d.length > 0) {
      const ltp = response.d[0].v && response.d[0].v.lp;
      if (typeof ltp === "number" && ltp > 0) {
        _cachedVix   = ltp;
        _cachedVixTs = now;
        return ltp;
      }
    }
    // Non-ok but don't block trading
    console.warn(`[VIX] getQuotes returned unexpected: s=${response.s}`);
    return _cachedVix; // return stale value if available
  } catch (err) {
    console.warn(`[VIX] Fetch failed: ${err.message} — using cached or bypassing`);
    return _cachedVix; // return stale value, or null (permissive)
  }
}

/**
 * Check if entry is allowed based on current live VIX.
 * @param {string} signalStrength - "STRONG" or "MARGINAL"
 * @returns {{ allowed: boolean, vix: number|null, reason: string }}
 */
async function checkLiveVix(signalStrength) {
  if (!getVixEnabled()) return { allowed: true, vix: null, reason: "VIX filter disabled" };

  const vix = await fetchLiveVix();

  if (vix === null) {
    // Can't fetch VIX — don't block trading (fail-open)
    return { allowed: true, vix: null, reason: "VIX unavailable — allowing entry (fail-open)" };
  }

  const maxEntry   = getVixMaxEntry();
  const strongOnly = getVixStrongOnly();

  if (vix > maxEntry) {
    return {
      allowed: false,
      vix,
      reason: `VIX ${vix.toFixed(1)} > ${maxEntry} — high volatility regime, all entries blocked`,
    };
  }

  if (vix > strongOnly && signalStrength !== "STRONG") {
    return {
      allowed: false,
      vix,
      reason: `VIX ${vix.toFixed(1)} > ${strongOnly} — elevated volatility, only STRONG signals allowed (got ${signalStrength})`,
    };
  }

  return {
    allowed: true,
    vix,
    reason: `VIX ${vix.toFixed(1)} — normal regime`,
  };
}

// ── Backtest VIX lookup ─────────────────────────────────────────────────────

/**
 * Build a VIX lookup map from historical VIX candles.
 * Maps each VIX candle's timestamp → close price.
 * For backtest: called once with VIX candle array, returns a lookup function.
 *
 * @param {Array} vixCandles - Array of { time, open, high, low, close, volume }
 * @returns {function(unixSec): number|null} - Returns VIX close for nearest prior candle
 */
function buildVixLookup(vixCandles) {
  if (!vixCandles || vixCandles.length === 0) {
    return () => null;
  }

  // Sort by time ascending (should already be, but ensure)
  const sorted = [...vixCandles].sort((a, b) => a.time - b.time);
  const times  = sorted.map(c => c.time);
  const closes = sorted.map(c => c.close);

  /**
   * Binary search for the nearest VIX candle at or before the given timestamp.
   * VIX candles are daily — so for 15-min NIFTY candles, we find the same-day VIX.
   */
  return function lookupVix(unixSec) {
    if (unixSec < times[0]) return closes[0]; // before first VIX candle — use first available

    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (times[mid] <= unixSec) lo = mid;
      else hi = mid - 1;
    }
    return closes[lo];
  };
}

/**
 * Check if entry is allowed based on backtest VIX value.
 * @param {number|null} vix - VIX value at this candle's timestamp
 * @param {string} signalStrength - "STRONG" or "MARGINAL"
 * @returns {{ allowed: boolean, vix: number|null, reason: string }}
 */
function checkBacktestVix(vix, signalStrength) {
  if (!getVixEnabled()) return { allowed: true, vix: null, reason: "VIX filter disabled" };

  if (vix === null || vix === undefined) {
    return { allowed: true, vix: null, reason: "VIX data unavailable for this date — allowing entry (fail-open)" };
  }

  const maxEntry   = getVixMaxEntry();
  const strongOnly = getVixStrongOnly();

  if (vix > maxEntry) {
    return {
      allowed: false,
      vix,
      reason: `VIX ${vix.toFixed(1)} > ${maxEntry} — high volatility regime, entry blocked`,
    };
  }

  if (vix > strongOnly && signalStrength !== "STRONG") {
    return {
      allowed: false,
      vix,
      reason: `VIX ${vix.toFixed(1)} > ${strongOnly} — elevated volatility, only STRONG signals (got ${signalStrength})`,
    };
  }

  return {
    allowed: true,
    vix,
    reason: `VIX ${vix.toFixed(1)} — normal regime`,
  };
}

/** Reset cached VIX (called on session stop) */
function resetCache() {
  _cachedVix   = null;
  _cachedVixTs = 0;
}

/** Get current cached VIX value (for display, no fetch) */
function getCachedVix() {
  return _cachedVix;
}

module.exports = {
  get VIX_ENABLED()    { return getVixEnabled(); },
  get VIX_MAX_ENTRY()  { return getVixMaxEntry(); },
  get VIX_STRONG_ONLY(){ return getVixStrongOnly(); },
  VIX_SYMBOL,
  fetchLiveVix,
  checkLiveVix,
  buildVixLookup,
  checkBacktestVix,
  resetCache,
  getCachedVix,
};

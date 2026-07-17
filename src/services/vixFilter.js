/**
 * VIX FILTER — Market Regime Detection (per-module thresholds)
 * ─────────────────────────────────────────────────────────────────────────────
 * Each trading module (EMA_RSI_ST / bb_rsi / pa) has its own VIX cutoff so you can
 * tune them independently (e.g. bb_rsi may tolerate higher VIX than EMA_RSI_ST).
 *
 * Per-module env vars:
 *   EMA_RSI_ST : VIX_FILTER_ENABLED, VIX_MAX_ENTRY,        VIX_STRONG_ONLY
 *   BB_RSI : BB_RSI_VIX_ENABLED,  BB_RSI_VIX_MAX_ENTRY   (STRONG_ONLY not used)
 *   PA    : PA_VIX_ENABLED,     PA_VIX_MAX_ENTRY      (STRONG_ONLY not used)
 *
 * Shared:
 *   VIX_FAIL_MODE = closed|open — behaviour when VIX data is unavailable.
 *
 * New bb_rsi/PA keys fall back to VIX_MAX_ENTRY when unset, so existing configs
 * keep working without changes.
 *
 * Live/Paper: Polls Fyers REST API for NSE:INDIAVIX-INDEX LTP (cached 60s).
 * Backtest:   Looks up VIX from pre-fetched historical VIX candles by timestamp.
 *
 * Why VIX matters for this strategy:
 *   Trend-following gets whipsawed in high-VIX regimes — filter sits those days out.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fyers        = require("../config/fyers");
const tickRecorder = require("../utils/tickRecorder");

const VIX_SYMBOL = "NSE:INDIAVIX-INDEX";

// ── Per-mode config readers (live — never cached, so toggles apply instantly) ─
function getVixEnabled(mode = "ema_rsi_st") {
  if (mode === "bb_rsi")    return process.env.BB_RSI_VIX_ENABLED    === "true";
  if (mode === "pa")       return process.env.PA_VIX_ENABLED       === "true";
  if (mode === "orb")      return process.env.ORB_VIX_ENABLED      === "true";
  if (mode === "trend_pb") return process.env.TREND_PB_VIX_ENABLED === "true";
  // EMA_RSI_ST default: on unless explicitly disabled
  return process.env.VIX_FILTER_ENABLED !== "false";
}

function getVixMaxEntry(mode = "ema_rsi_st") {
  if (mode === "bb_rsi")    return parseFloat(process.env.BB_RSI_VIX_MAX_ENTRY    || process.env.VIX_MAX_ENTRY || "20");
  if (mode === "pa")       return parseFloat(process.env.PA_VIX_MAX_ENTRY       || process.env.VIX_MAX_ENTRY || "20");
  if (mode === "orb")      return parseFloat(process.env.ORB_VIX_MAX_ENTRY      || process.env.VIX_MAX_ENTRY || "22");
  if (mode === "trend_pb") return parseFloat(process.env.TREND_PB_VIX_MAX_ENTRY || process.env.VIX_MAX_ENTRY || "22");
  return parseFloat(process.env.VIX_MAX_ENTRY || "20");
}

function getVixStrongOnly(mode = "ema_rsi_st") {
  if (mode === "bb_rsi")    return parseFloat(process.env.BB_RSI_VIX_STRONG_ONLY    || process.env.VIX_STRONG_ONLY || "16");
  if (mode === "pa")       return parseFloat(process.env.PA_VIX_STRONG_ONLY       || process.env.VIX_STRONG_ONLY || "16");
  if (mode === "orb")      return parseFloat(process.env.ORB_VIX_STRONG_ONLY      || process.env.VIX_STRONG_ONLY || "18");
  if (mode === "trend_pb") return parseFloat(process.env.TREND_PB_VIX_STRONG_ONLY || process.env.VIX_STRONG_ONLY || "18");
  return parseFloat(process.env.VIX_STRONG_ONLY || "16");
}

function anyVixEnabled() {
  return getVixEnabled("ema_rsi_st") || getVixEnabled("bb_rsi") || getVixEnabled("pa") ||
         getVixEnabled("orb") || getVixEnabled("trend_pb");
}

// ── Live VIX cache (60-second TTL, shared across all modes) ─────────────────
let _cachedVix   = null;
let _cachedVixTs = 0;
let _lastRegime  = null; // "NORMAL" | "ELEVATED" | "HIGH" — uses EMA_RSI_ST thresholds for logging
const VIX_CACHE_TTL = 60_000;
// Hard staleness bound: on a persistent fetch outage we must NOT keep admitting
// entries on an ancient cached VIX (it could be 14 while the market has spiked to
// 25). Past this age the cache is treated as "no data" so checkLiveVix falls
// through to VIX_FAIL_MODE (fail-closed by default). Tunable via env.
function vixMaxStaleMs() {
  return Math.max(VIX_CACHE_TTL, parseFloat(process.env.VIX_MAX_STALE_SEC || "300") * 1000);
}
// Return the cached VIX only if it is within the staleness bound, else null.
function freshCachedVix() {
  if (_cachedVix === null) return null;
  if ((Date.now() - _cachedVixTs) > vixMaxStaleMs()) {
    console.warn(`[VIX] cached value ${_cachedVix} is stale (>${Math.round(vixMaxStaleMs()/1000)}s) — treating as unavailable`);
    return null;
  }
  return _cachedVix;
}

/**
 * Fetch live VIX value from Fyers REST API. Cached 60s — shared across modes.
 * Returns null if fetch fails (filter becomes permissive or closed per VIX_FAIL_MODE).
 */
async function fetchLiveVix({ force = false } = {}) {
  if (!force && !anyVixEnabled()) return null;

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
        // Record only on cache fill (not cache hits) so replay sees the same
        // poll cadence the live system saw.
        try { tickRecorder.recordVix(ltp); } catch (_) {}
        const maxEntry   = getVixMaxEntry("ema_rsi_st");
        const strongOnly = getVixStrongOnly("ema_rsi_st");
        const newRegime = ltp > maxEntry ? "HIGH" : ltp > strongOnly ? "ELEVATED" : "NORMAL";
        if (_lastRegime && newRegime !== _lastRegime) {
          console.log(`🌡️ [VIX] Regime change: ${_lastRegime} → ${newRegime} (VIX ${ltp.toFixed(1)})`);
        }
        _lastRegime = newRegime;
        return ltp;
      }
    }
    console.warn(`[VIX] getQuotes returned unexpected: s=${response.s}`);
    return freshCachedVix();
  } catch (err) {
    console.warn(`[VIX] Fetch failed: ${err.message} — using cached (if fresh) or failing per VIX_FAIL_MODE`);
    return freshCachedVix();
  }
}

/**
 * Check if entry is allowed based on current live VIX (for the given module).
 * @param {string} signalStrength - "STRONG" or "MARGINAL" (EMA_RSI_ST only; bb_rsi/PA pass "STRONG")
 * @param {object} [opts]
 * @param {"ema_rsi_st"|"bb_rsi"|"pa"|"orb"} [opts.mode="ema_rsi_st"]
 * @returns {{ allowed: boolean, vix: number|null, reason: string }}
 */
async function checkLiveVix(signalStrength, { mode = "ema_rsi_st" } = {}) {
  if (!getVixEnabled(mode)) return { allowed: true, vix: null, reason: "VIX filter disabled" };

  const vix = await fetchLiveVix();

  if (vix === null) {
    const failMode = (process.env.VIX_FAIL_MODE || "closed").toLowerCase();
    if (failMode === "open") {
      return { allowed: true, vix: null, reason: "VIX unavailable — allowing entry (fail-open)" };
    }
    return { allowed: false, vix: null, reason: "VIX unavailable — blocking entry (fail-closed)" };
  }

  const maxEntry   = getVixMaxEntry(mode);
  const strongOnly = getVixStrongOnly(mode);

  if (vix > maxEntry) {
    return {
      allowed: false,
      vix,
      reason: `VIX ${vix.toFixed(1)} > ${maxEntry} (${mode}) — high volatility, entry blocked`,
    };
  }

  if (vix > strongOnly && signalStrength !== "STRONG") {
    return {
      allowed: false,
      vix,
      reason: `VIX ${vix.toFixed(1)} > ${strongOnly} (${mode}) — elevated volatility, only STRONG signals allowed (got ${signalStrength})`,
    };
  }

  return {
    allowed: true,
    vix,
    reason: `VIX ${vix.toFixed(1)} — normal regime`,
  };
}

// ── Backtest VIX lookup ─────────────────────────────────────────────────────

function buildVixLookup(vixCandles) {
  if (!vixCandles || vixCandles.length === 0) return () => null;

  const sorted = [...vixCandles].sort((a, b) => a.time - b.time);
  const times  = sorted.map(c => c.time);
  const closes = sorted.map(c => c.close);

  return function lookupVix(unixSec) {
    if (unixSec < times[0]) return closes[0];
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
 * Check if entry is allowed based on backtest VIX value (for the given module).
 * @param {number|null} vix
 * @param {string} signalStrength
 * @param {object} [opts]
 * @param {"ema_rsi_st"|"bb_rsi"|"pa"|"orb"} [opts.mode="ema_rsi_st"]
 * @param {boolean} [opts.force=false] — skip enabled check (used by bb_rsi/PA backtests which gate outside)
 */
function checkBacktestVix(vix, signalStrength, { mode = "ema_rsi_st", force = false } = {}) {
  if (!force && !getVixEnabled(mode)) return { allowed: true, vix: null, reason: "VIX filter disabled" };

  if (vix === null || vix === undefined) {
    const failMode = (process.env.VIX_FAIL_MODE || "closed").toLowerCase();
    if (failMode === "open") {
      return { allowed: true, vix: null, reason: "VIX data unavailable — allowing entry (fail-open)" };
    }
    return { allowed: false, vix: null, reason: "VIX data unavailable — blocking entry (fail-closed)" };
  }

  const maxEntry   = getVixMaxEntry(mode);
  const strongOnly = getVixStrongOnly(mode);

  if (vix > maxEntry) {
    return {
      allowed: false,
      vix,
      reason: `VIX ${vix.toFixed(1)} > ${maxEntry} (${mode}) — high volatility, entry blocked`,
    };
  }

  if (vix > strongOnly && signalStrength !== "STRONG") {
    return {
      allowed: false,
      vix,
      reason: `VIX ${vix.toFixed(1)} > ${strongOnly} (${mode}) — elevated volatility, only STRONG signals (got ${signalStrength})`,
    };
  }

  return { allowed: true, vix, reason: `VIX ${vix.toFixed(1)} — normal regime` };
}

/** Reset cached VIX (called on session stop) */
function resetCache() {
  _cachedVix   = null;
  _cachedVixTs = 0;
  _lastRegime  = null;
}

/** Get current cached VIX value (for display, no fetch) */
function getCachedVix() {
  return _cachedVix;
}

module.exports = {
  // Backwards-compatible getters (default to EMA_RSI_ST thresholds — used by existing status pages and backtest metadata)
  get VIX_ENABLED()     { return getVixEnabled("ema_rsi_st"); },
  get VIX_MAX_ENTRY()   { return getVixMaxEntry("ema_rsi_st"); },
  get VIX_STRONG_ONLY() { return getVixStrongOnly("ema_rsi_st"); },
  // Per-mode helpers
  getVixEnabled,
  getVixMaxEntry,
  getVixStrongOnly,
  anyVixEnabled,
  VIX_SYMBOL,
  fetchLiveVix,
  checkLiveVix,
  buildVixLookup,
  checkBacktestVix,
  resetCache,
  getCachedVix,
};

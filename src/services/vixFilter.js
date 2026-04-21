/**
 * VIX FILTER — Market Regime Detection (per-module thresholds)
 * ─────────────────────────────────────────────────────────────────────────────
 * Each trading module (swing / scalp / pa) has its own VIX cutoff so you can
 * tune them independently (e.g. scalp may tolerate higher VIX than swing).
 *
 * Per-module env vars:
 *   Swing : VIX_FILTER_ENABLED, VIX_MAX_ENTRY,        VIX_STRONG_ONLY
 *   Scalp : SCALP_VIX_ENABLED,  SCALP_VIX_MAX_ENTRY   (STRONG_ONLY not used)
 *   PA    : PA_VIX_ENABLED,     PA_VIX_MAX_ENTRY      (STRONG_ONLY not used)
 *
 * Shared:
 *   VIX_FAIL_MODE = closed|open — behaviour when VIX data is unavailable.
 *
 * New scalp/PA keys fall back to VIX_MAX_ENTRY when unset, so existing configs
 * keep working without changes.
 *
 * Live/Paper: Polls Fyers REST API for NSE:INDIAVIX-INDEX LTP (cached 60s).
 * Backtest:   Looks up VIX from pre-fetched historical VIX candles by timestamp.
 *
 * Why VIX matters for this strategy:
 *   Trend-following gets whipsawed in high-VIX regimes — filter sits those days out.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fyers = require("../config/fyers");

const VIX_SYMBOL = "NSE:INDIAVIX-INDEX";

// ── Per-mode config readers (live — never cached, so toggles apply instantly) ─
function getVixEnabled(mode = "swing") {
  if (mode === "scalp") return process.env.SCALP_VIX_ENABLED === "true";
  if (mode === "pa")    return process.env.PA_VIX_ENABLED    === "true";
  // swing default: on unless explicitly disabled
  return process.env.VIX_FILTER_ENABLED !== "false";
}

function getVixMaxEntry(mode = "swing") {
  if (mode === "scalp") return parseFloat(process.env.SCALP_VIX_MAX_ENTRY || process.env.VIX_MAX_ENTRY || "20");
  if (mode === "pa")    return parseFloat(process.env.PA_VIX_MAX_ENTRY    || process.env.VIX_MAX_ENTRY || "20");
  return parseFloat(process.env.VIX_MAX_ENTRY || "20");
}

function getVixStrongOnly(mode = "swing") {
  if (mode === "scalp") return parseFloat(process.env.SCALP_VIX_STRONG_ONLY || process.env.VIX_STRONG_ONLY || "16");
  if (mode === "pa")    return parseFloat(process.env.PA_VIX_STRONG_ONLY    || process.env.VIX_STRONG_ONLY || "16");
  return parseFloat(process.env.VIX_STRONG_ONLY || "16");
}

function anyVixEnabled() {
  return getVixEnabled("swing") || getVixEnabled("scalp") || getVixEnabled("pa");
}

// ── Live VIX cache (60-second TTL, shared across all modes) ─────────────────
let _cachedVix   = null;
let _cachedVixTs = 0;
let _lastRegime  = null; // "NORMAL" | "ELEVATED" | "HIGH" — uses swing thresholds for logging
const VIX_CACHE_TTL = 60_000;

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
        const maxEntry   = getVixMaxEntry("swing");
        const strongOnly = getVixStrongOnly("swing");
        const newRegime = ltp > maxEntry ? "HIGH" : ltp > strongOnly ? "ELEVATED" : "NORMAL";
        if (_lastRegime && newRegime !== _lastRegime) {
          console.log(`🌡️ [VIX] Regime change: ${_lastRegime} → ${newRegime} (VIX ${ltp.toFixed(1)})`);
        }
        _lastRegime = newRegime;
        return ltp;
      }
    }
    console.warn(`[VIX] getQuotes returned unexpected: s=${response.s}`);
    return _cachedVix;
  } catch (err) {
    console.warn(`[VIX] Fetch failed: ${err.message} — using cached or bypassing`);
    return _cachedVix;
  }
}

/**
 * Check if entry is allowed based on current live VIX (for the given module).
 * @param {string} signalStrength - "STRONG" or "MARGINAL" (swing only; scalp/PA pass "STRONG")
 * @param {object} [opts]
 * @param {"swing"|"scalp"|"pa"} [opts.mode="swing"]
 * @returns {{ allowed: boolean, vix: number|null, reason: string }}
 */
async function checkLiveVix(signalStrength, { mode = "swing" } = {}) {
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
 * @param {"swing"|"scalp"|"pa"} [opts.mode="swing"]
 * @param {boolean} [opts.force=false] — skip enabled check (used by scalp/PA backtests which gate outside)
 */
function checkBacktestVix(vix, signalStrength, { mode = "swing", force = false } = {}) {
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
  // Backwards-compatible getters (default to swing thresholds — used by existing status pages and backtest metadata)
  get VIX_ENABLED()     { return getVixEnabled("swing"); },
  get VIX_MAX_ENTRY()   { return getVixMaxEntry("swing"); },
  get VIX_STRONG_ONLY() { return getVixStrongOnly("swing"); },
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

/**
 * tradeUtils.js — Shared pure utility functions for all trade route files
 * ─────────────────────────────────────────────────────────────────────────────
 * Contains stateless helpers that are identical across scalpPaper, scalpLive,
 * paPaper, and paLive. Single source of truth — avoids duplicated code.
 *
 * IMPORTANT: This module must remain STATELESS — no module-level mutable state.
 * All functions are pure (output depends only on inputs).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── IST time helpers ────────────────────────────────────────────────────────

/**
 * Fast IST time string from unix ms — avoids toLocaleTimeString/ICU overhead.
 * Returns "HH:MM:SS" in IST.
 */
function fastISTTime(unixMs) {
  const ist = new Date(unixMs + 19800000);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes(), s = ist.getUTCSeconds();
  return `${h < 10 ? "0" : ""}${h}:${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
}

/**
 * Fast IST timestamp — "DD/MM HH:MM:SS" format.
 * Used for log entries. Avoids expensive toLocaleString/ICU on every call.
 * @param {number} unixMs — Unix timestamp in milliseconds
 */
function formatISTTimestamp(unixMs) {
  const ist = new Date(unixMs + 19800000);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes(), s = ist.getUTCSeconds();
  const dd = ist.getUTCDate(), mm = ist.getUTCMonth() + 1, yyyy = ist.getUTCFullYear();
  return `${dd < 10 ? "0" : ""}${dd}/${mm < 10 ? "0" : ""}${mm}/${yyyy}, ${h < 10 ? "0" : ""}${h}:${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
}

/**
 * Current IST minutes since midnight (0–1439). Uses real wall-clock time.
 * For sim-mode override, paper files wrap this with their own function.
 */
function getISTMinutes() {
  const istSec = Math.floor(Date.now() / 1000) + 19800;
  return Math.floor(istSec / 60) % 1440;
}

// ── Candle bucket helper ────────────────────────────────────────────────────

/**
 * Pure integer math — avoids Date object allocation on every tick.
 * @param {number} unixMs — tick timestamp
 * @param {number} resMinutes — candle resolution in minutes (e.g. 3, 5)
 */
function getBucketStart(unixMs, resMinutes) {
  const resMs = resMinutes * 60_000;
  return Math.floor(unixMs / resMs) * resMs;
}

// ── Array helpers ───────────────────────────────────────────────────────────

/**
 * Return last N items in reverse order — avoids spread+reverse on full array.
 */
function reverseSlice(arr, n) {
  const len = arr.length;
  const count = Math.min(n, len);
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = arr[len - 1 - i];
  return out;
}

/**
 * Map trades in reverse without intermediate arrays.
 * Used by /status/data endpoints for efficient JSON serialisation.
 */
function mapTradesReversed(trades) {
  const len = trades.length;
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    const t = trades[len - 1 - i];
    out[i] = {
      side: t.side || "", symbol: t.symbol || "", strike: t.optionStrike || "",
      expiry: t.optionExpiry || "", entry: t.entryTime || "", exit: t.exitTime || "",
      eSpot: t.spotAtEntry || t.entryPrice || 0, eOpt: t.optionEntryLtp || null,
      eSl: t.stopLoss || t.initialStopLoss || null, xSpot: t.spotAtExit || t.exitPrice || 0,
      xOpt: t.optionExitLtp || null, pnl: typeof t.pnl === "number" ? t.pnl : null,
      pnlMode: t.pnlMode || "", order: t.orderId || "", reason: t.exitReason || "",
    };
  }
  return out;
}

// ── Option symbol parser ────────────────────────────────────────────────────

const MONTH_NAMES = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MONTH_CODE_MAP = { "1":0,"2":1,"3":2,"4":3,"5":4,"6":5,"7":6,"8":7,"9":8,"O":9,"N":10,"D":11 };

/**
 * Parse option details (expiry, strike, type) from a Fyers NIFTY option symbol.
 * Returns { expiry, strike, optionType } or null if parsing fails.
 */
function parseOptionDetails(symbol) {
  try {
    // Weekly format: NSE:NIFTY25411724500CE (YY + month-code + DD + strike + CE/PE)
    const mA = symbol.match(/NSE:NIFTY(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$/);
    if (mA) {
      const monthIdx = MONTH_CODE_MAP[mA[2]];
      return { expiry: `${mA[3]} ${MONTH_NAMES[monthIdx]} 20${mA[1]}`, strike: parseInt(mA[4], 10), optionType: mA[5] };
    }
    // Monthly format: NSE:NIFTY25APR24500CE (YY + MMM + strike + CE/PE)
    const mC = symbol.match(/NSE:NIFTY(\d{2})([A-Z]{3})(\d+)(CE|PE)$/);
    if (mC && parseInt(mC[3], 10) >= 10000) {
      return { expiry: `${mC[2]} 20${mC[1]}`, strike: parseInt(mC[3], 10), optionType: mC[4] };
    }
    // Full date format: NSE:NIFTY25APR1724500CE
    const mB = symbol.match(/NSE:NIFTY(\d{2}[A-Z]{3}\d{2})(\d+)(CE|PE)$/);
    if (mB) {
      const raw = mB[1]; return { expiry: `${raw.slice(5,7)} ${raw.slice(2,5)} 20${raw.slice(0,2)}`, strike: parseInt(mB[2], 10), optionType: mB[3] };
    }
  } catch (_) {}
  return null;
}

// ── Config parser ───────────────────────────────────────────────────────────

/**
 * Parse "HH:MM" time string to minutes since midnight.
 * @param {string} timeStr — e.g. "15:30" or "09:21"
 * @param {string} fallback — default if env var is empty
 */
function parseTimeToMinutes(timeStr, fallback) {
  const raw = timeStr || fallback;
  const [h, m] = raw.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
}

/**
 * Parse tiered trail config string into sorted array.
 * Format: "peak1:pct1,peak2:pct2,..." e.g. "500:55,1000:60,3000:70"
 */
function parseTrailTiers(tierStr) {
  return tierStr
    .split(",")
    .map(t => { const [p, pct] = t.split(":"); return { peak: parseFloat(p), pct: parseFloat(pct) }; })
    .sort((a, b) => b.peak - a.peak);
}

// ── Sleep helper for retry logic ────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  fastISTTime,
  formatISTTimestamp,
  getISTMinutes,
  getBucketStart,
  reverseSlice,
  mapTradesReversed,
  parseOptionDetails,
  parseTimeToMinutes,
  parseTrailTiers,
  sleep,
};

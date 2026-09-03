/**
 * tradeUtils.js — Shared pure utility functions for all trade route files
 * ─────────────────────────────────────────────────────────────────────────────
 * Contains stateless helpers that are identical across bbRsiPaper, bbRsiLive,
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
 * Format an ISO timestamp string (or any Date-parseable input) as
 * "DD/MM/YYYY HH:MM" in IST. Returns "—" for null/empty/invalid inputs.
 * If input is already in "DD/MM/YYYY[, ]HH:MM(:SS)" form, normalizes to "DD/MM/YYYY HH:MM".
 */
function fmtISTDateTime(s) {
  if (s == null || s === "") return "—";
  const v = String(s);
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    if (isNaN(d)) return v;
    return formatISTTimestamp(d.getTime()).replace(/, /, " ").slice(0, 16);
  }
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})/);
  if (m) {
    return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]} ${m[4].padStart(2, "0")}:${m[5]}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`;
  }
  return v;
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

// NSE regular session open (09:15 IST). Pre-open auction (09:00–09:08) prints a
// wild wide-range bar and pre-market ticks are stale/flat — both corrupt the
// path-dependent indicators (SuperTrend, SAR) and make trend flips diverge from
// Kite/TradingView. Candle builders skip buckets before this so the bot sees the
// same candles a charting platform does.
const _MKT_OPEN_MIN = 9 * 60 + 15;

/**
 * True if a candle-bucket timestamp falls before NSE regular-session open (09:15 IST).
 * @param {number} bucketMs — candle bucket start (ms). Uses the bucket's own IST
 *   time so it is correct in live AND replay/sim (both drive the bucket clock).
 */
function isPreMarketBucket(bucketMs) {
  const istMin = Math.floor((Math.floor(bucketMs / 1000) + 19800) / 60) % 1440;
  return istMin < _MKT_OPEN_MIN;
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

/**
 * IST calendar day ("YYYY-MM-DD") for a session/trade date field, whatever shape
 * it was written in. Returns "" when the value can't be read as a date.
 *
 * Session `date` is not one format. Normally it is the ISO instant taken at
 * Start, but a restart mid-session rehydrates sessionStart from a trade's
 * `entryTime`, which is an en-IN locale string — and on Node's ICU that is
 * "4/9/2026, 09:20:15", unpadded. A plain slice(0,10) of that yields
 * "4/9/2026, ", which no date range can match: it sorts after every ISO date,
 * so a closed range (Today, Yesterday, Last month) drops the whole session
 * while an open one (This month, All) keeps it. The day looked half-missing.
 *
 * Reading the day through here instead means every surface groups and filters
 * a recovered session on the same IST day as a clean one.
 */
function istDayFromAny(value) {
  if (value == null || value === "") return "";
  const v = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;            // already a bare IST day
  // ISO instant → the IST day it falls in, matching how the UI's ranges are
  // built. Identical to a UTC slice for any session inside market hours; it
  // only differs for one written between 00:00 and 05:30 IST.
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = Date.parse(v);
    return isNaN(t) ? v.slice(0, 10) : new Date(t + 19800000).toISOString().slice(0, 10);
  }
  // en-IN locale: D/M/YYYY (day first), with or without a time after it.
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

/**
 * ISO instant for a session-start value, whatever shape it arrives in.
 * Returns null when the value can't be read as a time.
 *
 * The companion to istDayFromAny on the WRITING side: a session's date should
 * always be stored as an instant, so string-sorting sessions (which is how
 * "the most recent saved session" is picked) orders them by time. A day-first
 * locale stamp sorts by its leading day-of-month instead, which put "4/9/2026"
 * ahead of every ISO date forever.
 */
function istIsoFromAny(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return isNaN(value) ? null : new Date(value).toISOString();
  const v = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) { const t = Date.parse(v); return isNaN(t) ? null : new Date(t).toISOString(); }
  // "D/M/YYYY, HH:MM:SS" (en-IN, day first) — the wall clock is IST, so build
  // the instant by subtracting the offset rather than letting Date guess.
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const utcMs = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) - 19800000;
    return new Date(utcMs).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(Date.parse(v + "T00:00:00Z") - 19800000).toISOString();
  return null;
}

// ── Sleep helper for retry logic ────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  fastISTTime,
  formatISTTimestamp,
  fmtISTDateTime,
  istDayFromAny,
  istIsoFromAny,
  getISTMinutes,
  getBucketStart,
  isPreMarketBucket,
  reverseSlice,
  mapTradesReversed,
  parseOptionDetails,
  parseTimeToMinutes,
  parseTrailTiers,
  sleep,
};

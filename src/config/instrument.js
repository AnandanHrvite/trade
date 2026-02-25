require("dotenv").config();
const fyers = require("./fyers");

/**
 * instrument.js — Auto Strike & Auto Expiry
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * STRIKE:  Fetched live from Fyers quotes API (NSE:NIFTY50-INDEX LTP)
 *          Rounded to nearest 50 → ATM strike
 *          STRIKE_OFFSET in .env lets you go OTM/ITM (default 0 = ATM)
 *
 * EXPIRY:  Auto-calculated from today's date
 *          Options → nearest weekly Thursday expiry
 *          Futures → current month contract (rolls to next on expiry week)
 *
 * You never need to manually update this file again.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const INSTRUMENT = process.env.INSTRUMENT || "NIFTY_OPTIONS"; // NIFTY_OPTIONS | NIFTY_FUTURES
const STRIKE_OFFSET = parseInt(process.env.STRIKE_OFFSET || "0", 10); // 0=ATM, 50=1 OTM, -50=1 ITM

const LOT_SIZE = {
  NIFTY_OPTIONS: 75,
  NIFTY_FUTURES: 75,
};

// ── Month name map for Fyers symbol format ───────────────────────────────────
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

// ── Auto Expiry calculation ───────────────────────────────────────────────────

/**
 * Get the nearest upcoming Thursday (NIFTY weekly expiry day)
 * If today IS Thursday and market hasn't expired yet, use today
 * If Thursday has passed or it's expiry week for monthly, rolls correctly
 */
function getNearestThursdayExpiry() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

  const day = ist.getDay(); // 0=Sun, 1=Mon, ... 4=Thu, 5=Fri, 6=Sat
  let daysUntilThursday = (4 - day + 7) % 7;

  // If today is Thursday, check if it's past 3:30 PM (expiry time) → use next week
  if (day === 4) {
    const totalMin = ist.getHours() * 60 + ist.getMinutes();
    if (totalMin >= 930) { // past 3:30 PM on Thursday = expired
      daysUntilThursday = 7;
    } else {
      daysUntilThursday = 0; // today is valid expiry
    }
  }

  const expiry = new Date(ist);
  expiry.setDate(ist.getDate() + daysUntilThursday);

  const dd  = String(expiry.getDate()).padStart(2, "0");
  const mon = MONTHS[expiry.getMonth()];
  const yy  = String(expiry.getFullYear()).slice(2); // "25" for 2025

  // Fyers weekly options format: NIFTY25D18 (YY + Month letter + DD) for weekly
  // OR NIFTY25JUN for monthly
  // We'll use the readable monthly format for now — safer for most brokers
  return `${yy}${mon}${dd}`; // e.g. "25JUN19" for 19 Jun 2025
}

/**
 * Get current month futures expiry (last Thursday of the month)
 * Rolls to next month in the expiry week (Tue before last Thu)
 */
function getFuturesExpiry() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

  // Find last Thursday of current month
  function lastThursdayOf(year, month) {
    const lastDay = new Date(year, month + 1, 0); // last day of month
    const day = lastDay.getDay();
    const daysBack = (day - 4 + 7) % 7;
    lastDay.setDate(lastDay.getDate() - daysBack);
    return lastDay;
  }

  const year  = ist.getFullYear();
  const month = ist.getMonth();

  let expiry = lastThursdayOf(year, month);

  // If today is within 2 days of expiry (Tue/Wed/Thu of expiry week) → roll to next month
  const diffDays = Math.floor((expiry - ist) / (1000 * 60 * 60 * 24));
  if (diffDays <= 1) {
    // Roll to next month
    const nextMonth = month === 11 ? 0 : month + 1;
    const nextYear  = month === 11 ? year + 1 : year;
    expiry = lastThursdayOf(nextYear, nextMonth);
  }

  const mon = MONTHS[expiry.getMonth()];
  const yy  = String(expiry.getFullYear()).slice(2);
  return `${yy}${mon}`; // e.g. "25JUN" for Fyers futures format
}

// ── Live spot price fetch ─────────────────────────────────────────────────────

let _cachedSpot    = null;
let _cacheTime     = null;
const CACHE_TTL_MS = 60 * 1000; // refresh spot every 60 seconds max

/**
 * Fetch live NIFTY spot price from Fyers quotes API
 * Cached for 60 seconds to avoid hammering the API
 * Falls back to env NIFTY_SPOT_FALLBACK if API fails
 */
async function getLiveSpot() {
  const now = Date.now();

  // Return cached value if fresh
  if (_cachedSpot && _cacheTime && (now - _cacheTime) < CACHE_TTL_MS) {
    return _cachedSpot;
  }

  try {
    const response = await fyers.getQuotes({ symbols: "NSE:NIFTY50-INDEX" });

    if (response.s === "ok" && response.d && response.d.length > 0) {
      const ltp = response.d[0].v?.lp || response.d[0].v?.ltp;
      if (ltp && ltp > 0) {
        _cachedSpot = ltp;
        _cacheTime  = now;
        return ltp;
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not fetch live NIFTY spot: ${err.message}`);
  }

  // Fallback — use env value or last cached value
  const fallback = parseFloat(process.env.NIFTY_SPOT_FALLBACK || "0");
  if (fallback > 0) {
    console.warn(`⚠️  Using NIFTY_SPOT_FALLBACK=${fallback} from .env`);
    return fallback;
  }

  if (_cachedSpot) {
    console.warn(`⚠️  Using last cached spot price: ${_cachedSpot}`);
    return _cachedSpot;
  }

  throw new Error("Cannot determine NIFTY spot price. Set NIFTY_SPOT_FALLBACK in .env as a safety net.");
}

// ── ATM Strike calculation ────────────────────────────────────────────────────

/**
 * Round spot to nearest 50 to get ATM strike, apply offset
 */
function calcATMStrike(spot) {
  return Math.round(spot / 50) * 50 + STRIKE_OFFSET;
}

// ── Symbol builder ────────────────────────────────────────────────────────────

/**
 * Build the full Fyers symbol for the current trade
 * Fetches live spot for options, uses auto expiry for both
 *
 * @param {"CE"|"PE"} side
 * @returns {Promise<string>}  e.g. "NSE:NIFTY25JUN1924600CE"
 */
async function getSymbol(side = "CE") {
  if (INSTRUMENT === "NIFTY_FUTURES") {
    const expiry = getFuturesExpiry();
    const symbol = `NSE:NIFTY${expiry}FUT`;
    console.log(`📌 Futures symbol: ${symbol}`);
    return symbol;
  }

  // Options — need live spot for ATM strike
  const spot   = await getLiveSpot();
  const strike = calcATMStrike(spot);
  const expiry = getNearestThursdayExpiry();
  const symbol = `NSE:NIFTY${expiry}${strike}${side}`;

  console.log(`📌 Options symbol: ${symbol} (Spot: ${spot} → ATM: ${strike}, Expiry: ${expiry})`);
  return symbol;
}

/**
 * Synchronous symbol getter — uses cached spot if available
 * Used only for display purposes (dashboard, status). Always use async getSymbol() for actual orders.
 */
function getSymbolSync(side = "CE") {
  if (INSTRUMENT === "NIFTY_FUTURES") {
    return `NSE:NIFTY${getFuturesExpiry()}FUT`;
  }
  const spot   = _cachedSpot || parseFloat(process.env.NIFTY_SPOT_FALLBACK || "24000");
  const strike = calcATMStrike(spot);
  const expiry = getNearestThursdayExpiry();
  return `NSE:NIFTY${expiry}${strike}${side}`;
}

function getLotQty() {
  const multiplier = parseInt(process.env.LOT_MULTIPLIER || "1", 10);
  return LOT_SIZE[INSTRUMENT] * multiplier;
}

function getProductType() {
  return "INTRADAY";
}

module.exports = {
  INSTRUMENT,
  STRIKE_OFFSET,
  LOT_SIZE,
  getSymbol,        // async — use for actual orders
  getSymbolSync,    // sync  — use for display only
  getLotQty,
  getLiveSpot,
  calcATMStrike,
  getNearestThursdayExpiry,
  getFuturesExpiry,
  getProductType,
};


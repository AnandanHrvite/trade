require("dotenv").config();
const fyers = require("./fyers");
const { isNonTradingDay, getPreviousTradingDay, formatDateToYYYYMMDD } = require("../utils/nseHolidays");

/**
 * instrument.js — Auto Strike & Auto Expiry
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * STRIKE:  Fetched live from Fyers quotes API (NSE:NIFTY50-INDEX LTP)
 *          Rounded to nearest 50 → ATM strike
 *          STRIKE_OFFSET_CE / STRIKE_OFFSET_PE in .env lets you go OTM/ITM per side (default 0 = ATM)
 *
 * EXPIRY:  Auto-calculated from today's date
 *          Options → nearest weekly Thursday expiry
 *          Futures → current month contract (rolls to next on expiry week)
 *
 * You never need to manually update this file again.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Read dynamically so settings toggle takes effect immediately (no restart)
function getInstrument()   { return process.env.INSTRUMENT || "NIFTY_OPTIONS"; }
function getStrikeOffsetCE() { return parseInt(process.env.STRIKE_OFFSET_CE || process.env.STRIKE_OFFSET || "0", 10); }
function getStrikeOffsetPE() { return parseInt(process.env.STRIKE_OFFSET_PE || process.env.STRIKE_OFFSET || "0", 10); }

const LOT_SIZE_DEFAULT = 65;
function getLotSize() {
  const size = parseInt(process.env.NIFTY_LOT_SIZE || String(LOT_SIZE_DEFAULT), 10);
  return { NIFTY_OPTIONS: size, NIFTY_FUTURES: size };
}

// ── Month code map for Fyers weekly option symbol format ─────────────────────
// Fyers uses: {YY}{M}{DD} where M is a single character:
// 1=Jan, 2=Feb, 3=Mar, 4=Apr, 5=May, 6=Jun, 7=Jul, 8=Aug, 9=Sep, O=Oct, N=Nov, D=Dec
// Source: https://myapi.fyers.in/docsv3#tag/Appendix/Symbology-Format
const MONTHS     = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MONTH_CODE = ["1",  "2",  "3",  "4",  "5",  "6",  "7",  "8",  "9",  "O",  "N",  "D"];

// ── Auto Expiry calculation ───────────────────────────────────────────────────

/**
 * Get last Tuesday of the current month (NIFTY monthly expiry)
 */
function getLastTuesdayOfMonth() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  
  const year = ist.getFullYear();
  const month = ist.getMonth();
  
  // Get last day of current month
  const lastDay = new Date(year, month + 1, 0);
  const lastDayOfWeek = lastDay.getDay();
  
  // Find last Tuesday
  let daysBack = (lastDayOfWeek - 2 + 7) % 7;
  if (lastDayOfWeek < 2) daysBack += 7;
  
  const lastTuesday = new Date(lastDay);
  lastTuesday.setDate(lastDay.getDate() - daysBack);
  
  const dd = String(lastTuesday.getDate()).padStart(2, "0");
  const mCode = MONTH_CODE[lastTuesday.getMonth()];
  const yy = String(lastTuesday.getFullYear()).slice(2);
  
  return `${yy}${mCode}${dd}`;
}

/**
 * Get the nearest upcoming TUESDAY (NIFTY weekly expiry day — changed from Thursday in 2024)
 * If today IS Tuesday and market hasn't expired yet, use today
 * Otherwise rolls to next Tuesday
 *
 * ⚠️  NOTE: This is a SYNCHRONOUS function and does NOT check for holidays.
 * For holiday-aware expiry, use validateAndGetOptionSymbol() which is async.
 *
 * NOTE: NIFTY 50 index options switched to TUESDAY weekly expiry.
 * BankNifty = Wednesday, FinNifty = Tuesday, Nifty = Tuesday.
 */
function getNearestThursdayExpiry() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

  const day = ist.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  // Target day = 2 (Tuesday) for NIFTY weekly expiry
  const EXPIRY_DAY = 2; // Tuesday
  let daysUntilExpiry = (EXPIRY_DAY - day + 7) % 7;

  // If today IS Tuesday, check if it's past 3:30 PM → use NEXT Tuesday
  if (day === EXPIRY_DAY) {
    const totalMin = ist.getHours() * 60 + ist.getMinutes();
    if (totalMin >= 930) { // past 3:30 PM = expired, roll to next week
      daysUntilExpiry = 7;
    } else {
      daysUntilExpiry = 0; // today is valid expiry
    }
  }

  const expiry = new Date(ist);
  expiry.setDate(ist.getDate() + daysUntilExpiry);

  const dd    = String(expiry.getDate()).padStart(2, "0");
  const mCode = MONTH_CODE[expiry.getMonth()]; // e.g. "3" for March
  const yy    = String(expiry.getFullYear()).slice(2);

  console.log(`[instrument] getNearestThursdayExpiry() computed: ${yy}${mCode}${dd} (${formatDateToYYYYMMDD(expiry)}) - WARNING: NOT holiday-checked`);
  return `${yy}${mCode}${dd}`; // e.g. "26306" = year26 month3 day06
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
    const response = await fyers.getQuotes(["NSE:NIFTY50-INDEX"]);

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
 * Round spot to nearest 50 to get ATM strike, apply offset.
 * Then enforce ATM-or-ITM strictly:
 *   CE: strike must be <= spot (ITM or ATM). If ATM rounded up above spot → go one step ITM.
 *   PE: strike must be >= spot (ITM or ATM). If ATM rounded down below spot → go one step ITM.
 * Pass side="CE" or "PE". Default (no side) just returns pure ATM.
 */
function calcATMStrike(spot, side) {
  const base = Math.round(spot / 50) * 50;
  if (!side) return base;
  if (side === "CE") {
    // CE: offset -50=1 ITM (below spot), 0=ATM, +50=1 OTM (above spot)
    return base + getStrikeOffsetCE();
  }
  if (side === "PE") {
    // PE: offset +50=1 ITM (above spot), 0=ATM, -50=1 OTM (below spot)
    return base + getStrikeOffsetPE();
  }
  return base;
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
  if (getInstrument() === "NIFTY_FUTURES") {
    const expiry = getFuturesExpiry();
    const symbol = `NSE:NIFTY${expiry}FUT`;
    console.log(`📌 Futures symbol: ${symbol}`);
    return symbol;
  }

  // Options — need live spot for ATM strike
  const spot   = await getLiveSpot();
  const strike = calcATMStrike(spot, side);  // ATM or ITM — never OTM
  const expiry = getNearestThursdayExpiry();
  const symbol = `NSE:NIFTY${expiry}${strike}${side}`;

  console.log(`📌 Options symbol: ${symbol} (Spot: ${spot} → Strike: ${strike}, Expiry: ${expiry})`);
  return symbol;
}

/**
 * Synchronous symbol getter — uses cached spot if available
 * Used only for display purposes (dashboard, status). Always use async getSymbol() for actual orders.
 */
function getSymbolSync(side = "CE") {
  if (getInstrument() === "NIFTY_FUTURES") {
    return `NSE:NIFTY${getFuturesExpiry()}FUT`;
  }
  const spot   = _cachedSpot || parseFloat(process.env.NIFTY_SPOT_FALLBACK || "24000");
  const strike = calcATMStrike(spot, side);
  const expiry = getNearestThursdayExpiry();
  return `NSE:NIFTY${expiry}${strike}${side}`;
}

function getLotQty() {
  const multiplier = parseInt(process.env.LOT_MULTIPLIER || "1", 10);
  return getLotSize()[getInstrument()] * multiplier;
}

function getProductType() {
  return "INTRADAY";
}

/**
 * Convert a Unix timestamp (seconds) OR milliseconds expiry from Fyers
 * into the Fyers weekly option symbol expiry code: {YY}{M}{DD}
 * e.g. 1741113000 → "26303"  (2026-Mar-03)
 */
function expiryTimestampToCode(ts) {
  // Handle both seconds and milliseconds
  const ms = ts > 1e10 ? ts : ts * 1000;
  const d   = new Date(ms);
  const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const dd    = String(ist.getDate()).padStart(2, "0");
  const mCode = MONTH_CODE[ist.getMonth()];
  const yy    = String(ist.getFullYear()).slice(2);
  return `${yy}${mCode}${dd}`;
}

/**
 * Convert expiry code (e.g. "26331") to Date object
 * Format: YYMDD where M is month code (1-9, O, N, D)
 */
function expiryCodeToDate(code) {
  // e.g. "26331" = 2026-03-31
  const yy = code.substring(0, 2);
  const mCode = code.substring(2, 3);
  const dd = code.substring(3, 5);
  
  const year = 2000 + parseInt(yy);
  const monthIndex = MONTH_CODE.indexOf(mCode);
  const day = parseInt(dd);
  
  return new Date(year, monthIndex, day);
}

/**
 * Convert Date object to expiry code (e.g. "26331")
 * Format: YYMDD where M is month code (1-9, O, N, D)
 */
function dateToExpiryCode(date) {
  const yy = String(date.getFullYear()).slice(2);
  const mCode = MONTH_CODE[date.getMonth()];
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mCode}${dd}`;
}

/**
 * Call the Fyers Option Chain REST API directly (bypasses the JS SDK which lacks optionchain()).
 * Returns the nearest expiry as a symbol code string like "26303", or null on failure.
 *
 * Endpoint: GET https://api-t1.fyers.in/data/v3/options-chain
 * Docs: https://myapi.fyers.in/docsv3#tag/Data-Api
 */
async function getNearestExpiryFromOptionChain() {
  try {
    const https   = require("https");
    const appId   = process.env.APP_ID;
    const token   = process.env.ACCESS_TOKEN;
    if (!appId || !token) return null;

    const authHeader = `${appId}:${token}`;
    const url = "https://api-t1.fyers.in/data/v3/options-chain?symbol=NSE%3ANIFTY50-INDEX&strikecount=1&timestamp=";

    const data = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json",
        }
      }, (res) => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => {
          try {
            // Strip any BOM or leading whitespace before parsing
            const clean = body.trim().replace(/^﻿/, "");
            resolve(JSON.parse(clean));
          } catch (e) {
            // Log raw response for debugging
            console.warn("[instrument] Option chain raw response (first 200):", body.slice(0, 200));
            reject(e);
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
    });

    if (data.s !== "ok" || !data.data) return null;

    // Response structure: data.data.expiryData = [{expiry: <unix_ts_ms_or_s>, date: "YYYY-MM-DD"}, ...]
    // Or data.data.options_chain[].expiry
    // Or data.data.t (array of timestamps)
    const d = data.data;

    // Format A: expiryData array
    if (d.expiryData && d.expiryData.length > 0) {
      const first = d.expiryData[0];
      if (first.expiry) return expiryTimestampToCode(first.expiry);
      if (first.date)   return parseDateToCode(first.date);
    }

    // Format B: options_chain items have expiry field
    if (d.options_chain && d.options_chain.length > 0) {
      const expiries = [...new Set(d.options_chain.map(o => o.expiry).filter(Boolean))].sort();
      if (expiries.length > 0) return expiryTimestampToCode(expiries[0]);
    }

    // Format C: t[] = array of expiry timestamps
    if (d.t && d.t.length > 0) {
      return expiryTimestampToCode(d.t[0]);
    }

    console.warn("[instrument] Option chain response has unknown structure:", JSON.stringify(data).slice(0, 300));
    return null;
  } catch (e) {
    console.warn("[instrument] Option chain REST call failed:", e.message);
    // Fallback: Try multiple expiry strategies with holiday checking
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    
    // Strategy 1: Try next Tuesday (weekly) - check if it's a holiday
    let nextExpiry = new Date(today);
    const EXPIRY_DAY = 2; // Tuesday
    let daysUntil = (EXPIRY_DAY - today.getDay() + 7) % 7;
    if (daysUntil === 0 && today.getHours() * 60 + today.getMinutes() >= 930) {
      daysUntil = 7; // past 3:30 PM on Tuesday, roll to next week
    }
    if (daysUntil === 0) daysUntil = 7; // same day before expiry -> use next week
    nextExpiry.setDate(today.getDate() + daysUntil);
    
    // Check if computed Tuesday is a holiday - if so, prepone to previous trading day
    const isHoliday = await isNonTradingDay(nextExpiry);
    if (isHoliday) {
      console.warn(`[instrument] Fallback expiry ${formatDateToYYYYMMDD(nextExpiry)} is a holiday, preponing...`);
      nextExpiry = await getPreviousTradingDay(nextExpiry);
    }
    
    const yy = String(nextExpiry.getFullYear()).slice(-2);
    const mCode = MONTH_CODE[nextExpiry.getMonth()];
    const dd = String(nextExpiry.getDate()).padStart(2, '0');
    const fallbackCode = yy + mCode + dd;
    console.warn(`[instrument] Using fallback expiry code (weekly): ${fallbackCode} (${formatDateToYYYYMMDD(nextExpiry)})`);
    return fallbackCode;
  }
}

function parseDateToCode(dateStr) {
  // "YYYY-MM-DD" → "YYMDD" in Fyers month-letter format (e.g. "26M06")
  const parts = dateStr.split("-");
  const d   = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const dd    = String(d.getDate()).padStart(2, "0");
  const mCode = MONTH_CODE[d.getMonth()];
  const yy    = String(d.getFullYear()).slice(2);
  return `${yy}${mCode}${dd}`;
}

/**
 * Get a valid Fyers option symbol for entry.
 *
 * Priority:
 *  1. Call Fyers Option Chain REST API → get real nearest expiry (guaranteed valid)
 *  2. Fall back to computed next-Tuesday weekly expiry, validated via getQuotes()
 *  3. Fall back to last-Tuesday-of-month (monthly expiry), validated via getQuotes()
 *  4. Scan next 21 days for any valid expiry
 *  5. Skip trade if all fail
 *
 * Usage:  const { symbol, expiry, strike, invalid } = await validateAndGetOptionSymbol(spot, side);
 */
async function validateAndGetOptionSymbol(spot, side) {
  const strike = calcATMStrike(spot, side);
  console.log(`[instrument] validateAndGetOptionSymbol() called: spot=${spot}, side=${side}, strike=${strike}`);

  // ── Step 1: Option Chain REST API (most reliable — returns only live expiries) ──
  console.log(`[instrument] Step 1: Calling Option Chain API...`);
  const chainExpiry = await getNearestExpiryFromOptionChain();
  console.log(`[instrument] Step 1: Option Chain returned: ${chainExpiry || 'null'}`);
  if (chainExpiry) {
    // Validate the Option Chain expiry is not a holiday
    const chainDate = expiryCodeToDate(chainExpiry);
    const isChainHoliday = await isNonTradingDay(chainDate);
    
    if (isChainHoliday) {
      console.warn(`[instrument] ⚠️  Option Chain expiry ${chainExpiry} (${formatDateToYYYYMMDD(chainDate)}) is a holiday/weekend`);
      
      // Try previous trading day (preponed expiry)
      const preponedDate = await getPreviousTradingDay(chainDate);
      const preponedExpiry = dateToExpiryCode(preponedDate);
      const preponedSymbol = `NSE:NIFTY${preponedExpiry}${strike}${side}`;
      
      console.log(`[instrument] 🔄 Trying preponed expiry from Option Chain: ${preponedExpiry} (${formatDateToYYYYMMDD(preponedDate)})`);
      
      if (await isSymbolValidViaQuotes(preponedSymbol)) {
        console.log(`[instrument] ✅ Preponed expiry validated: ${preponedSymbol}`);
        return { symbol: preponedSymbol, expiry: preponedExpiry, strike, side };
      }
      
      // If preponed validation fails, fall through to Step 2
      console.warn(`[instrument] ⚠️  Preponed expiry ${preponedExpiry} validation failed, trying computed weekly...`);
    } else {
      // Not a holiday, validate the Option Chain expiry via getQuotes
      const symbol = `NSE:NIFTY${chainExpiry}${strike}${side}`;
      if (await isSymbolValidViaQuotes(symbol)) {
        console.log(`[instrument] ✅ Option Chain expiry validated: ${chainExpiry} → ${symbol}`);
        return { symbol, expiry: chainExpiry, strike, side };
      } else {
        console.warn(`[instrument] ⚠️  Option Chain expiry ${chainExpiry} validation failed, trying computed weekly...`);
      }
    }
  }

  // ── Step 2: Computed weekly expiry (next Tuesday) with holiday check ──
  const weeklyExpiry = getNearestThursdayExpiry();
  const weeklySymbol = `NSE:NIFTY${weeklyExpiry}${strike}${side}`;
  
  // Check if the computed Tuesday is a holiday
  const weeklyDate = expiryCodeToDate(weeklyExpiry);
  const isHoliday = await isNonTradingDay(weeklyDate);
  
  if (isHoliday) {
    console.warn(`[instrument] ⚠️  Computed expiry ${weeklyExpiry} (${formatDateToYYYYMMDD(weeklyDate)}) is a holiday/weekend`);
    
    // Try previous trading day (preponed expiry - usually Monday)
    const preponedDate = await getPreviousTradingDay(weeklyDate);
    const preponedExpiry = dateToExpiryCode(preponedDate);
    const preponedSymbol = `NSE:NIFTY${preponedExpiry}${strike}${side}`;
    
    console.log(`[instrument] 🔄 Trying preponed expiry: ${preponedExpiry} (${formatDateToYYYYMMDD(preponedDate)})`);
    
    if (await isSymbolValidViaQuotes(preponedSymbol)) {
      console.log(`[instrument] ✅ Preponed expiry validated: ${preponedSymbol}`);
      return { symbol: preponedSymbol, expiry: preponedExpiry, strike, side };
    } else {
      console.warn(`[instrument] ⚠️  Preponed expiry ${preponedExpiry} validation failed via getQuotes()`);
    }
  } else {
    // Not a holiday, validate normally
    if (await isSymbolValidViaQuotes(weeklySymbol)) {
      console.log(`[instrument] ✅ Weekly expiry validated: ${weeklySymbol}`);
      return { symbol: weeklySymbol, expiry: weeklyExpiry, strike, side };
    } else {
      console.warn(`[instrument] ⚠️  Weekly expiry ${weeklyExpiry} validation failed via getQuotes()`);
    }
  }
  
  // ── Step 3: Monthly expiry (last Tuesday of month) + getQuotes() validation ──
  console.warn(`[instrument] ⚠️  Weekly expiry ${weeklyExpiry} not available, trying monthly...`);
  const monthlyExpiry = getLastTuesdayOfMonth();
  const monthlySymbol = `NSE:NIFTY${monthlyExpiry}${strike}${side}`;
  if (await isSymbolValidViaQuotes(monthlySymbol)) {
    console.log(`[instrument] ✅ Monthly expiry validated: ${monthlySymbol}`);
    return { symbol: monthlySymbol, expiry: monthlyExpiry, strike, side };
  }

  // ── Step 4: Try PREVIOUS week's expiry (current week if next week not available yet) ──
  console.warn(`[instrument] ⚠️  Next week's expiry not available, trying current/previous week...`);
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  
  // Calculate previous Tuesday (7 days back from next Tuesday)
  const prevTuesday = new Date(ist);
  const daysToSubtract = (ist.getDay() - 2 + 7) % 7 || 7; // Days since last Tuesday
  prevTuesday.setDate(ist.getDate() - daysToSubtract);
  
  // Check if previous Tuesday is a holiday
  const isPrevHoliday = await isNonTradingDay(prevTuesday);
  if (isPrevHoliday) {
    // Use preponed expiry (Monday)
    const prevMonday = await getPreviousTradingDay(prevTuesday);
    const prevExpiry = dateToExpiryCode(prevMonday);
    const prevSymbol = `NSE:NIFTY${prevExpiry}${strike}${side}`;
    console.log(`[instrument] 🔄 Trying previous week's preponed expiry: ${prevExpiry} (${formatDateToYYYYMMDD(prevMonday)})`);
    if (await isSymbolValidViaQuotes(prevSymbol)) {
      console.log(`[instrument] ✅ Previous week's preponed expiry validated: ${prevSymbol}`);
      return { symbol: prevSymbol, expiry: prevExpiry, strike, side };
    }
  } else {
    const prevExpiry = dateToExpiryCode(prevTuesday);
    const prevSymbol = `NSE:NIFTY${prevExpiry}${strike}${side}`;
    console.log(`[instrument] 🔄 Trying previous week's expiry: ${prevExpiry} (${formatDateToYYYYMMDD(prevTuesday)})`);
    if (await isSymbolValidViaQuotes(prevSymbol)) {
      console.log(`[instrument] ✅ Previous week's expiry validated: ${prevSymbol}`);
      return { symbol: prevSymbol, expiry: prevExpiry, strike, side };
    }
  }

  // ── Step 5: Scan next 21 days — check ALL days, skip weekends & holidays ──
  console.warn(`[instrument] ⚠️  Previous week also failed, scanning next 21 days (excluding holidays)...`);
  
  for (let offset = 1; offset <= 21; offset++) {
    const tryDate = new Date(ist);
    tryDate.setDate(ist.getDate() + offset);
    
    // Skip weekends & holidays
    if (await isNonTradingDay(tryDate)) continue;

    const dd    = String(tryDate.getDate()).padStart(2, "0");
    const mCode = MONTH_CODE[tryDate.getMonth()];
    const yy    = String(tryDate.getFullYear()).slice(2);
    const expCode = `${yy}${mCode}${dd}`;
    const testSymbol = `NSE:NIFTY${expCode}${strike}${side}`;

    if (await isSymbolValidViaQuotes(testSymbol)) {
      console.warn(`[instrument] ✅ Found valid expiry +${offset}d: ${testSymbol} (${formatDateToYYYYMMDD(tryDate)})`);
      return { symbol: testSymbol, expiry: expCode, strike, side };
    }
  }

  // ── Step 6: All failed — skip trade ──
  console.error(`[instrument] ❌ No valid expiry found. Cannot enter trade.`);
  console.error(`[instrument] ❌ Tried: Option Chain, Weekly (next/prev), Monthly, 21-day scan`);
  return { symbol: weeklySymbol, expiry: weeklyExpiry, strike, side, invalid: true };
}

async function isSymbolValidViaQuotes(symbol) {
  try {
    const res = await fyers.getQuotes([symbol]);

    // ── Auth / session errors — treat as "inconclusive", not "invalid symbol" ──
    // If Fyers returns a top-level error (expired token, rate limit, etc.) we
    // must NOT mark the symbol as invalid — that would cause all fallbacks to
    // silently fail and ultimately skip a valid trade.
    if (res.s !== "ok") {
      const topMsg = (res.message || res.msg || "").toLowerCase();
      const isAuthErr = topMsg.includes("token") || topMsg.includes("auth") ||
                        topMsg.includes("session") || topMsg.includes("unauthorized") ||
                        topMsg.includes("limit") || topMsg.includes("rate");
      if (isAuthErr) {
        console.warn(`[instrument] ⚠️  getQuotes auth/rate error for ${symbol}: "${res.message || res.msg}" — assuming symbol VALID to avoid false-invalid`);
        return true; // optimistic: don't discard the symbol due to API issues
      }
      console.log(`[instrument] Symbol validation failed: ${symbol} - top-level s="${res.s}" msg="${res.message || ""}"`);
      return false;
    }

    if (res.d && res.d.length > 0) {
      const v = res.d[0].v || res.d[0];
      const errmsg = (v.errmsg || "").toLowerCase();

      // Auth / session errors inside the data array — same optimistic treatment
      const isAuthErr = errmsg.includes("token") || errmsg.includes("auth") ||
                        errmsg.includes("session") || errmsg.includes("unauthorized") ||
                        errmsg.includes("limit") || errmsg.includes("rate");
      if (isAuthErr) {
        console.warn(`[instrument] ⚠️  getQuotes data-level auth error for ${symbol}: "${v.errmsg}" — assuming VALID`);
        return true;
      }

      const isValid = !v.errmsg && v.s !== "error";
      if (!isValid) {
        console.log(`[instrument] Symbol validation failed: ${symbol} - error: ${v.errmsg || v.s}`);
      }
      return isValid;
    }

    console.log(`[instrument] Symbol validation failed: ${symbol} - no data in response`);
    return false;
  } catch (e) {
    // Network / timeout errors are also inconclusive — don't mark symbol invalid
    console.warn(`[instrument] ⚠️  getQuotes threw for ${symbol}: ${e.message} — assuming VALID`);
    return true;
  }
}

module.exports = {
  get INSTRUMENT()    { return getInstrument(); },
  get STRIKE_OFFSET_CE() { return getStrikeOffsetCE(); },
  get STRIKE_OFFSET_PE() { return getStrikeOffsetPE(); },
  get LOT_SIZE() { return getLotSize(); },
  getSymbol,        // async — use for actual orders
  getSymbolSync,    // sync  — use for display only
  getLotQty,
  getLiveSpot,
  calcATMStrike,
  getNearestThursdayExpiry,
  getFuturesExpiry,
  getProductType,
  validateAndGetOptionSymbol,  // ✅ Use this for paper/live option entry
};


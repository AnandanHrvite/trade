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

const WEEKLY_EXPIRY_DOW = 2;   // Tuesday — NIFTY weekly expiry weekday
const SESSION_END_MIN   = 930; // 15:30 IST in minutes-from-midnight

/** "Now" as a Date whose local fields read as IST, wherever the process runs. */
function nowIST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

/**
 * The month's last weekly-expiry weekday (last Tuesday) — the scheduled MONTHLY
 * expiry date, before any holiday prepone.
 */
function lastExpiryWeekdayOf(year, month) {
  const d = new Date(year, month + 1, 0);                        // day 0 of next month = last day of this one
  d.setDate(d.getDate() - ((d.getDay() - WEEKLY_EXPIRY_DOW + 7) % 7));
  return d;
}

/**
 * Is this expiry date the LAST one of its month (i.e. the monthly contract)?
 *
 * True for the scheduled last Tuesday and for a holiday-preponed date inside that
 * same expiry week — anything falling after the second-to-last Tuesday. The last
 * Tuesday of a month is always on the 22nd or later, so that cutoff never spills
 * into the previous month and a plain day-of-month compare is safe.
 */
function isMonthlyExpiryDate(date) {
  const lastTue = lastExpiryWeekdayOf(date.getFullYear(), date.getMonth());
  return date.getDate() > lastTue.getDate() - 7;
}

/**
 * Fyers symbol code for a concrete expiry DATE.
 *
 * ⚠️  The last weekly expiry of every month is the MONTHLY contract and Fyers
 * names it `YY+MMM` (e.g. "26AUG"), NOT the weekly `YY+M+DD` form. Verified
 * against Fyers' own symbol master (public.fyers.in/sym_details/NSE_FO.csv):
 * August-2026 NIFTY options list 26811, 26818 and 26AUG — there is no "26825",
 * because 25-Aug (the last Tuesday) *is* the monthly contract. Formatting that
 * week as a weekly code builds a symbol that does not exist, which is why every
 * auto-detection step below asks this helper instead of formatting the date
 * itself.
 */
function expiryCodeFor(date) {
  if (isMonthlyExpiryDate(date)) return `${String(date.getFullYear()).slice(2)}${MONTHS[date.getMonth()]}`;
  return dateToExpiryCode(date);
}

/**
 * Get last Tuesday of the current month (NIFTY monthly expiry), as a symbol code.
 */
function getLastTuesdayOfMonth() {
  const ist = nowIST();
  return expiryCodeFor(lastExpiryWeekdayOf(ist.getFullYear(), ist.getMonth()));
}

/**
 * The nearest upcoming weekly-expiry DATE (Tuesday). Today counts while its
 * session is still open; past 15:30 IST it rolls to next Tuesday.
 *
 * ⚠️  NOT holiday-adjusted — callers that can `await` prepone it themselves.
 * This is the single definition of "which week are we trading", so the computed
 * fallback and the recorded market context can never disagree about it.
 */
function getNearestWeeklyExpiryDate() {
  const ist = nowIST();
  let days = (WEEKLY_EXPIRY_DOW - ist.getDay() + 7) % 7;
  if (days === 0 && ist.getHours() * 60 + ist.getMinutes() >= SESSION_END_MIN) days = 7;
  const expiry = new Date(ist);
  expiry.setDate(ist.getDate() + days);
  expiry.setHours(12, 0, 0, 0);   // midday — immune to DST/offset arithmetic
  return expiry;
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
  const expiry = getNearestWeeklyExpiryDate();
  const code   = expiryCodeFor(expiry);
  console.log(`[instrument] getNearestThursdayExpiry() computed: ${code} (${formatDateToYYYYMMDD(expiry)}) - WARNING: NOT holiday-checked`);
  return code; // e.g. "26306" = year26 month3 day06, or "26AUG" on monthly-expiry week
}

/**
 * Get current month futures expiry (last TUESDAY of the month)
 * Rolls to the next month once expiry is TWO days away or nearer, so the
 * expiring contract's last two illiquid sessions are never traded. (`ist` carries
 * a time-of-day, so the `diffDays <= 1` test below is already true two calendar
 * days out — the two-day roll is the real behaviour, and the backtest mirrors it.)
 *
 * NSE moved NIFTY derivative expiry off Thursday; this function used to compute
 * the last Thursday and so named a contract that does not exist for the last two
 * days of every month — Fyers answers "Invalid symbol provided" for it. Verified
 * against Fyers' own symbol master (public.fyers.in/sym_details/NSE_FO.csv):
 * NIFTY26AUGFUT expires 25-Aug-2026 (Tue), 26SEP 29-Sep-2026 (Tue), 26OCT
 * 27-Oct-2026 (Tue) — every one a Tuesday, none a Thursday.
 */
function getFuturesExpiry() {
  const ist = nowIST();

  const year  = ist.getFullYear();
  const month = ist.getMonth();

  let expiry = lastExpiryWeekdayOf(year, month);

  // Expiry two days away or nearer → roll to next month
  const diffDays = Math.floor((expiry - ist) / (1000 * 60 * 60 * 24));
  if (diffDays <= 1) {
    // Roll to next month
    const nextMonth = month === 11 ? 0 : month + 1;
    const nextYear  = month === 11 ? year + 1 : year;
    expiry = lastExpiryWeekdayOf(nextYear, nextMonth);
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
  if (side !== "CE" && side !== "PE") throw new Error(`[instrument] calcATMStrike: invalid side "${side}" — must be "CE" or "PE"`);
  if (side === "CE") {
    const offset = getStrikeOffsetCE();
    if (offset !== 0) console.log(`[instrument] CE strike offset: ${offset} (base ${base} → ${base + offset})`);
    return base + offset;
  }
  if (side === "PE") {
    const offset = getStrikeOffsetPE();
    if (offset !== 0) console.log(`[instrument] PE strike offset: ${offset} (base ${base} → ${base + offset})`);
    return base + offset;
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
  // Clamp the lot multiplier to a sane ceiling so a fat-finger LOT_MULTIPLIER
  // (e.g. 50) can't silently size every order 50× on the live path. Ceiling is
  // configurable via MAX_LOT_MULTIPLIER (default 10); invalid/≤0 falls back to 1.
  let multiplier = parseInt(process.env.LOT_MULTIPLIER || "1", 10);
  if (!Number.isFinite(multiplier) || multiplier <= 0) multiplier = 1;
  let maxMult = parseInt(process.env.MAX_LOT_MULTIPLIER || "10", 10);
  if (!Number.isFinite(maxMult) || maxMult < 1) maxMult = 10;   // garbage env must not disable the clamp
  if (multiplier > maxMult) {
    console.warn(`[instrument] LOT_MULTIPLIER=${multiplier} exceeds MAX_LOT_MULTIPLIER=${maxMult} — clamping to ${maxMult}`);
    multiplier = maxMult;
  }
  return getLotSize()[getInstrument()] * multiplier;
}

function getProductType() {
  return "INTRADAY";
}

/**
 * Convert a Unix timestamp (seconds) OR milliseconds expiry from Fyers into the
 * expiry Date, read in IST. `ts` arrives as a JSON string from the REST API, so
 * it is coerced explicitly rather than relied on to compare/multiply correctly.
 * e.g. "1772532000" → 2026-Mar-03
 */
function expiryTimestampToDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e10 ? n : n * 1000;   // seconds vs milliseconds
  const d  = new Date(ms);
  if (isNaN(d.getTime())) return null;
  // Re-check after the IST round-trip too: this Date is handed straight to
  // expiryCodeFor, and an Invalid Date there would build a "NaN" symbol rather
  // than fail — null instead falls through to the computed-expiry path.
  const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return isNaN(ist.getTime()) ? null : ist;
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
 * Returns the nearest expiry as a Date (read in IST), or null on any failure
 * (missing token, HTTP/parse error, timeout, error status, unknown shape) —
 * a null tells the caller to fall through to the computed-expiry path, which
 * prepones off holidays and validates via getQuotes on its own.
 *
 * Endpoint: GET https://api-t1.fyers.in/data/options-chain-v3
 *   (`/data/v3/options-chain` is NOT a route — it answers 404 "page not found",
 *    which used to make this call fail silently on every single invocation.)
 * Docs: https://myapi.fyers.in/docsv3#tag/Data-Api
 */
async function getNearestExpiryDateFromOptionChain() {
  try {
    const https   = require("https");
    const appId   = process.env.APP_ID;
    const token   = process.env.ACCESS_TOKEN;
    if (!appId || !token) return null;

    const authHeader = `${appId}:${token}`;
    const url = "https://api-t1.fyers.in/data/options-chain-v3?symbol=NSE%3ANIFTY50-INDEX&strikecount=1&timestamp=";

    const data = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json",
        }
      }, (res) => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("error", reject);  // a response-stream error mid-download would otherwise be unhandled
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

    if (data.s !== "ok" || !data.data) {
      console.warn(`[instrument] Option chain returned s="${data.s}" msg="${data.message || ""}"`);
      return null;
    }

    // Response structure: data.data.expiryData = [{expiry: "<unix_ts_s>", date: "DD-MM-YYYY"}, ...]
    // Or data.data.optionsChain[].expiry
    // Or data.data.t (array of timestamps)
    const d = data.data;

    // Format A: expiryData array (nearest first)
    if (Array.isArray(d.expiryData) && d.expiryData.length > 0) {
      const first = d.expiryData[0];
      const byTs = first && first.expiry != null ? expiryTimestampToDate(first.expiry) : null;
      if (byTs) return byTs;
      const byDate = first && first.date ? parseExpiryDateString(first.date) : null;
      if (byDate) return byDate;
    }

    // Format B: chain items carry an expiry field (both spellings seen in the wild)
    const chain = d.optionsChain || d.options_chain;
    if (Array.isArray(chain) && chain.length > 0) {
      const expiries = [...new Set(chain.map(o => o && o.expiry).filter(Boolean))]
        .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      if (expiries.length > 0) {
        const dt = expiryTimestampToDate(expiries[0]);
        if (dt) return dt;
      }
    }

    // Format C: t[] = array of expiry timestamps
    if (Array.isArray(d.t) && d.t.length > 0) {
      const dt = expiryTimestampToDate(d.t[0]);
      if (dt) return dt;
    }

    console.warn("[instrument] Option chain response has unknown structure:", JSON.stringify(data).slice(0, 300));
    return null;
  } catch (e) {
    // Deliberately NO computed fallback here. This used to return a
    // hand-rolled next-Tuesday code, which (a) duplicated — and disagreed with —
    // getNearestWeeklyExpiryDate(), skipping the current week's expiry on every
    // Tuesday, and (b) short-circuited the caller's own holiday-prepone +
    // getQuotes validation because a non-null answer looks like success.
    console.warn("[instrument] Option chain REST call failed:", e.message);
    return null;
  }
}

/** Parse the chain's `date` field — Fyers sends "DD-MM-YYYY"; accept ISO too. */
function parseExpiryDateString(dateStr) {
  const parts = String(dateStr || "").trim().split(/[-/]/);
  if (parts.length !== 3 || parts.some(p => isNaN(parseInt(p, 10)))) return null;
  const [a, b, c] = parts.map(p => parseInt(p, 10));
  const [year, month, day] = String(parts[0]).length === 4 ? [a, b, c] : [c, b, a];
  // Insist on a 4-digit year: `new Date(26, …)` silently means 1926, and that
  // date would still format into a plausible-looking — but wrong — expiry code.
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day, 12, 0, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Has a manual expiry-override date already stopped being tradeable?
 *
 * An option contract is tradeable up to and including its expiry day's session
 * close (15:30 IST), so "stale" means that moment has passed. The offset is
 * written into the timestamp rather than relying on process.TZ so the answer is
 * identical on a laptop and on EC2.
 *
 * This is the SINGLE definition of staleness — the dashboard banner in app.js
 * and the hard guard in validateAndGetOptionSymbol() both call it, so the
 * warning the operator sees and the behaviour of the engine can never disagree.
 *
 * @param {string} dateStr "YYYY-MM-DD"
 * @returns {boolean} true ⇒ the override is in the past and must not be traded.
 *                    Malformed or blank input returns false (not our job here —
 *                    the caller already reports a format error).
 */
function isExpiryOverrideStale(dateStr) {
  const raw = String(dateStr || "").trim();
  if (!raw) return false;
  const parts = raw.split("-");
  if (parts.length !== 3 || parts.some((p) => isNaN(parseInt(p, 10)))) return false;
  const sessionEnd = new Date(`${raw}T15:30:00+05:30`);
  if (isNaN(sessionEnd.getTime())) return false;
  return Date.now() > sessionEnd.getTime();
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
 * Usage:  const { symbol, expiry, expiryDate, strike, invalid } = await validateAndGetOptionSymbol(spot, side);
 *
 * `opts.ignoreOverride` resolves what auto-detection WOULD pick, ignoring any
 * manual override. Only the expiry-health roll uses it — it needs the true
 * nearest contract in order to replace an override that has expired.
 */
async function validateAndGetOptionSymbol(spot, side, mode, opts = {}) {
  let strike = calcATMStrike(spot, side);
  // ── ORB, TREND_PB, GAPS, TDS (Trend Day Scalp) and GAP3M (3M Gap Fix Scalp) trade slightly ITM (~delta 0.6): higher delta tracks
  //    the move better and decays slower in % than ATM. Shift the strike ITM by
  //    {MODE}_ITM_STEPS × 50 (CE → lower strike, PE → higher strike). Default 1 step.
  //    Set {MODE}_ITM_STEPS=0 to fall back to ATM. ─────────────────────────────
  const _itmMode = String(mode || "").toUpperCase();
  if (_itmMode === "ORB" || _itmMode === "TREND_PB" || _itmMode === "GAPS" || _itmMode === "TDS" || _itmMode === "GAP3M") {
    const itmSteps = parseInt(process.env[`${_itmMode}_ITM_STEPS`] || "1", 10);
    if (itmSteps > 0 && (side === "CE" || side === "PE")) {
      const shifted = side === "CE" ? strike - itmSteps * 50 : strike + itmSteps * 50;
      console.log(`[instrument] ${_itmMode} ITM: ${side} strike ${strike} → ${shifted} (${itmSteps} step${itmSteps > 1 ? "s" : ""} ITM, ~delta 0.6)`);
      strike = shifted;
    }
  }
  console.log(`[instrument] validateAndGetOptionSymbol() called: spot=${spot}, side=${side}, strike=${strike}${mode ? `, mode=${mode}` : ""}`);

  // ── Manual expiry override — skip all auto-detection ──────────────────────
  // ONE common expiry for every strategy — all engines are intraday on the same
  // weekly expiry. Blank = auto-detect. There is no per-strategy expiry override.
  const manualExpiry = opts.ignoreOverride ? "" : (process.env.OPTION_EXPIRY_OVERRIDE || "").trim();
  const expiryType   = (process.env.OPTION_EXPIRY_TYPE     || "weekly").trim().toLowerCase();
  if (manualExpiry && manualExpiry.length >= 8) {
    const parts = manualExpiry.split("-");
    const overrideKeyName = "OPTION_EXPIRY_OVERRIDE";
    if (parts.length !== 3 || parts.some(p => isNaN(parseInt(p)))) {
      console.error(`[instrument] ❌ ${overrideKeyName} format invalid: "${manualExpiry}" — expected YYYY-MM-DD`);
      // Fall through to auto-detection
    } else if (isExpiryOverrideStale(manualExpiry)) {
      // ── STALE OVERRIDE — refuse, do not substitute ──────────────────────────
      // Every OTHER branch below validates its symbol via getQuotes before
      // returning it; this branch returned unvalidated, so a forgotten override
      // handed the engines a symbol whose contract no longer exists. ORB and
      // TREND_PB block on `invalid`, but EMA_RSI_ST and BB_RSI entered anyway
      // and fell back to "spot proxy" P&L — with the percentage option stop
      // (OPT_STOP_PCT) inert, because it needs an entry premium that never
      // arrived. A configured stop that silently does not exist is the worst
      // outcome available here, so refuse the trade instead.
      //
      // We deliberately do NOT fall through to auto-detection: quietly trading a
      // DIFFERENT expiry than the one configured changes the premium, theta and
      // therefore the risk of every position, which is the operator's decision to
      // make, not ours. `invalid: true` is the shape callers already handle.
      console.error(
        `[instrument] ❌ ${overrideKeyName}="${manualExpiry}" has already expired — refusing to build an option symbol. ` +
        `Update it in Settings to the next expiry (no entries will be taken until then).`
      );
      return { symbol: null, expiry: null, strike, side, invalid: true, staleExpiry: manualExpiry, overrideKey: overrideKeyName };
    } else {
    const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    let code;
    if (expiryType === "monthly") {
      // Monthly format: YY + 3-letter month → e.g. "26MAR"
      code = `${String(d.getFullYear()).slice(2)}${MONTHS[d.getMonth()]}`;
    } else {
      // Weekly format: YY + month_code + DD → e.g. "26330". expiryCodeFor still
      // upgrades a month's LAST expiry to the monthly code, because that is what
      // the contract is actually called — picking "weekly" in Settings for e.g.
      // 25-Aug-2026 must not build the non-existent NIFTY26825 symbol.
      code = expiryCodeFor(d);
    }
    const symbol = `NSE:NIFTY${code}${strike}${side}`;
    console.log(`[instrument] ✅ MANUAL EXPIRY (${expiryType}): ${manualExpiry} → ${code} → ${symbol}`);
    return { symbol, expiry: code, expiryDate: manualExpiry, strike, side };
    }
  }

  // Every auto step resolves the same way: take a candidate expiry DATE, prepone
  // it off a holiday, name it with the code Fyers actually uses for that date
  // (weekly YYMDD, or monthly YYMMM in the last expiry week of a month), and only
  // accept it once getQuotes confirms the contract exists. Returns null to fall
  // through to the next step.
  const tryExpiryDate = async (date, label) => {
    if (!date) return null;
    let eff = date;
    if (await isNonTradingDay(eff)) {
      const preponed = await getPreviousTradingDay(eff);
      console.warn(`[instrument] ⚠️  ${label} ${formatDateToYYYYMMDD(eff)} is a holiday/weekend — preponing to ${formatDateToYYYYMMDD(preponed)}`);
      eff = preponed;
    }
    const code   = expiryCodeFor(eff);
    const symbol = `NSE:NIFTY${code}${strike}${side}`;
    if (await isSymbolValidViaQuotes(symbol)) {
      console.log(`[instrument] ✅ ${label} validated: ${code} (${formatDateToYYYYMMDD(eff)}) → ${symbol}`);
      return { symbol, expiry: code, expiryDate: formatDateToYYYYMMDD(eff), strike, side };
    }
    console.warn(`[instrument] ⚠️  ${label} ${code} (${formatDateToYYYYMMDD(eff)}) failed getQuotes validation`);
    return null;
  };

  const ist = nowIST();

  // ── Step 1: Option Chain REST API (most reliable — returns only live expiries) ──
  console.log(`[instrument] Step 1: Calling Option Chain API...`);
  const chainDate = await getNearestExpiryDateFromOptionChain();
  console.log(`[instrument] Step 1: Option Chain returned: ${chainDate ? formatDateToYYYYMMDD(chainDate) : "null"}`);
  const fromChain = await tryExpiryDate(chainDate, "Option Chain expiry");
  if (fromChain) return fromChain;

  // ── Step 2: Computed weekly expiry (this/next Tuesday) with holiday check ──
  const weeklyDate   = getNearestWeeklyExpiryDate();
  const weeklyExpiry = expiryCodeFor(weeklyDate);              // reported if every step fails
  const weeklySymbol = `NSE:NIFTY${weeklyExpiry}${strike}${side}`;
  const fromWeekly   = await tryExpiryDate(weeklyDate, "Computed weekly expiry");
  if (fromWeekly) return fromWeekly;

  // ── Step 3: Monthly expiry (last Tuesday of month) + getQuotes() validation ──
  // Rolls to next month once this month's has passed, so late-month retries do
  // not re-test a contract that has already expired. "Passed" is measured against
  // the nearest still-tradeable weekly date rather than today, so 15:30 on expiry
  // day rolls here exactly when it rolls there; ISO strings compare by calendar
  // day, which the Date objects themselves would not (they carry different times).
  console.warn(`[instrument] ⚠️  Weekly expiry ${weeklyExpiry} not available, trying monthly...`);
  let monthlyDate = lastExpiryWeekdayOf(ist.getFullYear(), ist.getMonth());
  if (formatDateToYYYYMMDD(monthlyDate) < formatDateToYYYYMMDD(weeklyDate)) {
    monthlyDate = lastExpiryWeekdayOf(
      ist.getMonth() === 11 ? ist.getFullYear() + 1 : ist.getFullYear(),
      ist.getMonth() === 11 ? 0 : ist.getMonth() + 1
    );
  }
  const fromMonthly = await tryExpiryDate(monthlyDate, "Monthly expiry");
  if (fromMonthly) return fromMonthly;

  // ── Step 4: Try PREVIOUS week's expiry (current week if next week not available yet) ──
  console.warn(`[instrument] ⚠️  Next week's expiry not available, trying current/previous week...`);
  const prevTuesday = new Date(weeklyDate);
  prevTuesday.setDate(weeklyDate.getDate() - 7);
  const fromPrev = await tryExpiryDate(prevTuesday, "Previous week's expiry");
  if (fromPrev) return fromPrev;

  // ── Step 5: Scan next 21 days — check ALL days, skip weekends & holidays ──
  console.warn(`[instrument] ⚠️  Previous week also failed, scanning next 21 days (excluding holidays)...`);

  for (let offset = 1; offset <= 21; offset++) {
    const tryDate = new Date(ist);
    tryDate.setDate(ist.getDate() + offset);

    // Skip weekends & holidays
    if (await isNonTradingDay(tryDate)) continue;

    const expCode    = expiryCodeFor(tryDate);
    const testSymbol = `NSE:NIFTY${expCode}${strike}${side}`;

    if (await isSymbolValidViaQuotes(testSymbol)) {
      console.warn(`[instrument] ✅ Found valid expiry +${offset}d: ${testSymbol} (${formatDateToYYYYMMDD(tryDate)})`);
      return { symbol: testSymbol, expiry: expCode, expiryDate: formatDateToYYYYMMDD(tryDate), strike, side };
    }
  }

  // ── Step 6: All failed — skip trade ──
  console.error(`[instrument] ❌ No valid expiry found. Cannot enter trade.`);
  console.error(`[instrument] ❌ Tried: Option Chain, Weekly (next/prev), Monthly, 21-day scan`);
  return { symbol: weeklySymbol, expiry: weeklyExpiry, expiryDate: formatDateToYYYYMMDD(weeklyDate), strike, side, invalid: true };
}

async function isSymbolValidViaQuotes(symbol, _retried = false) {
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
        if (!_retried) {
          console.warn(`[instrument] ⚠️  getQuotes auth/rate error for ${symbol}: "${res.message || res.msg}" — retrying in 1s...`);
          await new Promise(r => setTimeout(r, 1000));
          return isSymbolValidViaQuotes(symbol, true);
        }
        console.warn(`[instrument] ⚠️  getQuotes auth/rate error for ${symbol} (after retry): "${res.message || res.msg}" — assuming VALID`);
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
        if (!_retried) {
          console.warn(`[instrument] ⚠️  getQuotes data-level auth error for ${symbol}: "${v.errmsg}" — retrying in 1s...`);
          await new Promise(r => setTimeout(r, 1000));
          return isSymbolValidViaQuotes(symbol, true);
        }
        console.warn(`[instrument] ⚠️  getQuotes data-level auth error for ${symbol} (after retry): "${v.errmsg}" — assuming VALID`);
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
    // Network / timeout errors are also inconclusive — retry once before assuming valid
    if (!_retried) {
      console.warn(`[instrument] ⚠️  getQuotes threw for ${symbol}: ${e.message} — retrying in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
      return isSymbolValidViaQuotes(symbol, true);
    }
    console.warn(`[instrument] ⚠️  getQuotes threw for ${symbol} (after retry): ${e.message} — assuming VALID`);
    return true;
  }
}

/**
 * Resolve a complete, immutable Market Context Snapshot for the CURRENT trading
 * day. Captured live (once per day) and frozen to disk so replay can reconstruct
 * the market exactly as it existed — never re-deriving expiry from "today".
 *
 * At record time `new Date()` and the live Option-Chain REST are CORRECT (we're
 * running on the trading day), which is the whole point: we freeze the truth now
 * so an old-day replay six months later resolves its own contract, not today's.
 *
 * The weekly expiry prefers the live Option-Chain API (holiday-adjusted, the real
 * nearest tradeable expiry), falling back to the computed next-Tuesday. Both
 * expiries are stored as YYYY-MM-DD dates — the format instrument.js's manual
 * override consumes — plus their Fyers symbol codes for reference.
 *
 * @returns {Promise<object>} market-context snapshot (no secrets/tokens).
 */
async function getMarketContext() {
  // Prefer the live Option Chain (holiday-adjusted, the real nearest tradeable
  // expiry, and what strategies auto-detect via Step 1). When it is unavailable
  // it returns null; we then compute the nearest weekly and prepone off a holiday
  // through the SAME helper validateAndGetOptionSymbol Step 2 uses, so the
  // recorded expiry can't drift from what the strategy trades in a holiday week.
  let weekly = null;
  try { weekly = await getNearestExpiryDateFromOptionChain(); } catch (_) { /* fall back below */ }
  if (!weekly) weekly = getNearestWeeklyExpiryDate();
  try { if (await isNonTradingDay(weekly)) weekly = await getPreviousTradingDay(weekly); }
  catch (_) { /* keep computed */ }
  const weeklyCode = expiryCodeFor(weekly);
  const weeklyDate = formatDateToYYYYMMDD(weekly);

  const ist = nowIST();
  let monthly = lastExpiryWeekdayOf(ist.getFullYear(), ist.getMonth());
  try { if (await isNonTradingDay(monthly)) monthly = await getPreviousTradingDay(monthly); }
  catch (_) { /* keep computed */ }
  const monthlyCode = expiryCodeFor(monthly);
  const monthlyDate = formatDateToYYYYMMDD(monthly);

  return {
    index:            "NSE:NIFTY50-INDEX",
    underlying:       "NIFTY",
    exchange:         "NSE",
    instrument:       getInstrument(),
    strikeInterval:   50,
    lotSize:          getLotSize().NIFTY_OPTIONS,
    weeklyExpiry:     weeklyDate,     // YYYY-MM-DD — the historical market fact (replay pins this)
    weeklyExpiryCode: weeklyCode,     // Fyers symbol code, informational
    monthlyExpiry:    monthlyDate,    // YYYY-MM-DD
    monthlyExpiryCode: monthlyCode,
    futuresExpiry:    getFuturesExpiry(),
    dataBroker:       "fyers",
  };
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
  expiryCodeFor,               // date → the Fyers code Fyers really uses (weekly YYMDD / monthly YYMMM)
  getNearestWeeklyExpiryDate,  // the single definition of "which week are we trading"
  getFuturesExpiry,
  getProductType,
  getMarketContext,            // async — resolve the day's immutable Market Context Snapshot
  validateAndGetOptionSymbol,  // ✅ Use this for paper/live option entry
  isExpiryOverrideStale,       // shared by the dashboard banner and the entry guard
};


/**
 * nseHolidays.js — NSE Holiday & Expiry Management
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Fetches NSE trading holidays from the official NSE API, caches them **per
 * calendar year**, and derives the NIFTY weekly/monthly expiry calendar from
 * them. Nothing here is pinned to one year: 2027, 2028 … work the same way as
 * 2026, and every lookup asks for the year of the date being checked.
 *
 * Resolution order for a year's holiday list (first hit wins):
 *   1. in-memory cache (TTL: 24 h for API data, 6 h for degraded data)
 *   2. NSE API — one call fills EVERY year present in the response
 *   3. ~/trading-data/nse_holidays.json — last good API result, so a year that
 *      was fetched once survives restarts and NSE blocking us afterwards
 *   4. hardcoded 2026 list (legacy safety net)
 *   5. fixed-date holidays that repeat every year (Republic Day, Christmas …)
 *
 * Only step 2 is ever written to disk — derived/fallback data is never
 * persisted, so it can't masquerade as the real calendar later.
 *
 * NSE API: https://www.nseindia.com/api/holiday-master?type=trading
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR   = path.join(require('os').homedir(), 'trading-data');
const STORE_FILE = path.join(DATA_DIR, 'nse_holidays.json');

// Per-year cache: year → { list:[{date,name}], dates:[], set:Set, source, fetchedAt }
// `dates`/`set` are derived from `list` once so the hot path (isNSEHoliday) is O(1).
const _years = new Map();

// TTLs. API data is stable for a day; anything degraded (disk snapshot, fallback,
// or a year NSE has not published yet) is re-checked sooner so the moment NSE
// publishes next year's calendar we pick it up without a restart.
const TTL_API      = 24 * 60 * 60 * 1000;
const TTL_DEGRADED =  6 * 60 * 60 * 1000;

// In-flight singletons: one upstream call and one disk read, however many
// concurrent callers ask (Promise.all at session start hits this).
let _fetchInflight = null;
let _diskInflight  = null;
let _diskLoaded    = false;

const MIN_YEAR = 2015;
const MAX_YEAR = 2100;

// Hardcoded fallback for 2026 — kept as a legacy safety net for the one year
// this bot was originally written for. Future years come from the API + the
// on-disk snapshot; see FIXED_HOLIDAYS below for the year-agnostic last resort.
const FALLBACK_HOLIDAYS_2026 = [
  { date: '2026-01-15', name: 'Municipal Corp. Election – Maharashtra' },
  { date: '2026-01-26', name: 'Republic Day' },
  { date: '2026-03-03', name: 'Holi' },
  { date: '2026-03-26', name: 'Shri Ram Navami' },
  { date: '2026-03-31', name: 'Shri Mahavir Jayanti' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-14', name: 'Dr. Baba Saheb Ambedkar Jayanti' },
  { date: '2026-05-01', name: 'Maharashtra Day' },
  { date: '2026-05-28', name: 'Bakri Id' },
  { date: '2026-06-26', name: 'Muharram' },
  { date: '2026-09-14', name: 'Ganesh Chaturthi' },
  { date: '2026-10-02', name: 'Mahatma Gandhi Jayanti' },
  { date: '2026-10-20', name: 'Dussehra' },
  { date: '2026-11-10', name: 'Diwali – Balipratipada' },
  { date: '2026-11-24', name: 'Prakash Gurpurb Sri Guru Nanak Dev' },
  { date: '2026-12-25', name: 'Christmas' },
  // Note: Nov 08 is Diwali Laxmi Pujan — Muhurat Trading session conducted (not a full holiday)
];

// Holidays that fall on the same Gregorian date every year. The lunar ones
// (Holi, Diwali, Id …) move and cannot be derived — but these five are certain,
// so even a brand-new year with NSE unreachable still blocks trading on
// Republic Day / Christmas instead of treating them as normal sessions.
const FIXED_HOLIDAYS = [
  { md: '01-26', name: 'Republic Day' },
  { md: '05-01', name: 'Maharashtra Day' },
  { md: '08-15', name: 'Independence Day' },
  { md: '10-02', name: 'Mahatma Gandhi Jayanti' },
  { md: '12-25', name: 'Christmas' },
];

/** Fixed-date holidays for any year, weekends dropped (NSE lists trading days only). */
function derivedFixedHolidays(year) {
  return FIXED_HOLIDAYS
    .map(h => ({ date: `${year}-${h.md}`, name: h.name }))
    .filter(h => {
      const d = new Date(h.date + 'T12:00:00');
      return d.getDay() !== 0 && d.getDay() !== 6;
    });
}

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Decode a response body according to its Content-Encoding.
 * Falls back to a plain UTF-8 read for identity/unknown encodings.
 */
function decodeBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'gzip')    return zlib.gunzipSync(buf).toString('utf-8');
  if (enc === 'deflate') return zlib.inflateSync(buf).toString('utf-8');
  if (enc === 'br')      return zlib.brotliDecompressSync(buf).toString('utf-8');
  return buf.toString('utf-8');
}

/**
 * Fetch NSE holidays from official API
 * @returns {Promise<Array<{date:string,name:string}>>} every holiday the API
 *          returned, for every year it covers (NSE publishes next year's
 *          calendar around Nov–Dec, and then both years arrive in one call).
 */
async function fetchNSEHolidays() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.nseindia.com',
      path: '/api/holiday-master?type=trading',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      let bytes = 0;

      res.on('data', (chunk) => {
        bytes += chunk.length;
        // The holiday master is a few KB. Anything far larger is an error page
        // or a redirect loop — cap it rather than buffering it all.
        if (bytes > MAX_RESPONSE_BYTES) {
          res.destroy();
          reject(new Error('NSE API response too large'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error('NSE API HTTP ' + res.statusCode));
            return;
          }

          // We advertise gzip/deflate/br, so the body usually arrives compressed —
          // reading it as text yields binary garbage and every fetch "fails".
          const data = decodeBody(Buffer.concat(chunks), res.headers['content-encoding']);

          // Check if response looks like HTML (NSE sometimes returns HTML error pages)
          if (data.trim().startsWith('<') || data.trim().startsWith('<!DOCTYPE')) {
            console.warn('[nseHolidays] ⚠️  NSE API returned HTML instead of JSON (likely blocked or rate limited)');
            reject(new Error('NSE API returned HTML instead of JSON - API may be blocking requests'));
            return;
          }

          const json = JSON.parse(data);
          const holidays = [];
          const seen = new Set();

          // NSE API returns: { CM: [{tradingDate: "DD-MMM-YYYY", description, ...}], FO: [...] }
          // We need FO (Futures & Options) holidays. `description` is the holiday
          // name — taking it from here is what keeps the UI correct in any year.
          if (json.FO && Array.isArray(json.FO)) {
            json.FO.forEach(item => {
              if (item.tradingDate) {
                // Convert "31-Mar-2026" to "2026-03-31"
                const date = parseNSEDate(item.tradingDate);
                if (date && !seen.has(date)) {
                  seen.add(date);
                  const name = String(item.description || '').trim();
                  holidays.push({ date, name: name || '—' });
                }
              }
            });
          }

          if (holidays.length === 0) {
            console.warn('[nseHolidays] ⚠️  NSE API returned valid JSON but no holidays found');
            reject(new Error('No holidays found in NSE API response'));
            return;
          }
          
          console.log(`[nseHolidays] ✅ Fetched ${holidays.length} NSE holidays from API`);
          resolve(holidays);
        } catch (e) {
          console.warn('[nseHolidays] ⚠️  Failed to parse NSE API response:', e.message);
          reject(e);
        }
      });
    });

    req.on('error', (e) => {
      console.warn('[nseHolidays] ⚠️  NSE API request failed:', e.message);
      reject(e);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('NSE API timeout'));
    });

    req.end();
  });
}

/**
 * Convert NSE date format "31-Mar-2026" to "2026-03-31"
 */
function parseNSEDate(dateStr) {
  try {
    const months = {
      'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
      'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
      'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
    };
    
    const parts = dateStr.split('-');
    if (parts.length !== 3) return null;
    
    const day = parts[0].padStart(2, '0');
    const month = months[parts[1]];
    const year = parts[2];
    
    if (!month) return null;
    return `${year}-${month}-${day}`;
  } catch (e) {
    return null;
  }
}

/** Coerce anything the caller passes into a sane calendar year. */
function normaliseYear(year) {
  const y = Number.parseInt(year, 10);
  if (!Number.isFinite(y) || y < MIN_YEAR || y > MAX_YEAR) return new Date().getFullYear();
  return y;
}

/** Build a cache entry from a [{date,name}] list (sorted, de-duplicated). */
function makeEntry(list, source) {
  const byDate = new Map();
  list.forEach(h => { if (h && h.date) byDate.set(h.date, h.name || '—'); });
  const dates = [...byDate.keys()].sort();
  return {
    list: dates.map(d => ({ date: d, name: byDate.get(d) })),
    dates,
    set: new Set(dates),
    source,
    fetchedAt: Date.now(),
  };
}

function entryFresh(entry) {
  if (!entry) return false;
  const ttl = entry.source === 'api' ? TTL_API : TTL_DEGRADED;
  return (Date.now() - entry.fetchedAt) < ttl;
}

// ── On-disk snapshot ────────────────────────────────────────────────────────
// One JSON file holding every year we have ever successfully fetched. This is
// what makes future years survive an NSE outage: fetch 2027 once in December
// 2026 and it stays available all through 2027 even if NSE blocks the EC2 box.

async function loadDiskStore() {
  if (_diskLoaded) return;
  if (_diskInflight) return _diskInflight;
  _diskInflight = (async () => {
    try {
      const raw = await fs.promises.readFile(STORE_FILE, 'utf-8');
      const json = JSON.parse(raw);
      const years = (json && json.years) || {};
      let loaded = 0;
      Object.keys(years).forEach(y => {
        const list = Array.isArray(years[y]) ? years[y] : [];
        if (!list.length) return;
        if (_years.has(Number(y))) return;
        const entry = makeEntry(list, 'disk');
        // Deliberately stale: the snapshot is a safety net, not a reason to skip
        // the API. ensureYear() still tries NSE first and only falls back here.
        entry.fetchedAt = 0;
        _years.set(Number(y), entry);
        loaded++;
      });
      if (loaded) console.log(`[nseHolidays] Loaded ${loaded} year(s) from disk snapshot`);
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[nseHolidays] Disk snapshot unreadable:', e.message);
    } finally {
      _diskLoaded = true;
      _diskInflight = null;
    }
  })();
  return _diskInflight;
}

/**
 * Merge freshly fetched years into the on-disk snapshot. Merge, never replace —
 * a year NSE has stopped returning (last year's calendar) must not be dropped.
 */
async function saveDiskStore(freshByYear) {
  try {
    let existing = {};
    try {
      const raw = await fs.promises.readFile(STORE_FILE, 'utf-8');
      existing = (JSON.parse(raw) || {}).years || {};
    } catch (e) {
      // Missing or corrupt file → start fresh and overwrite it. Anything else
      // (permissions, I/O) is rethrown: better to skip this save than to drop
      // years we already had from a file that is merely unreadable right now.
      if (e.code === 'ENOENT' || e instanceof SyntaxError) {
        if (e.code !== 'ENOENT') console.warn('[nseHolidays] Corrupt holiday snapshot — rewriting it');
      } else {
        throw e;
      }
    }

    Object.keys(freshByYear).forEach(y => { existing[y] = freshByYear[y]; });

    const payload = JSON.stringify({ updatedAt: new Date().toISOString(), years: existing }, null, 2);
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = STORE_FILE + '.tmp';
    await fs.promises.writeFile(tmp, payload, 'utf-8');
    await fs.promises.rename(tmp, STORE_FILE);   // atomic — never a half-written calendar
  } catch (e) {
    console.warn('[nseHolidays] Could not persist holiday snapshot:', e.message);
  }
}

/**
 * One upstream call, shared by every concurrent caller, that populates the cache
 * for EVERY year the response covers. Returns true when the API answered.
 */
async function refreshFromUpstream() {
  if (_fetchInflight) return _fetchInflight;
  _fetchInflight = (async () => {
    try {
      const holidays = await fetchNSEHolidays();
      const byYear = {};
      holidays.forEach(h => {
        const y = h.date.slice(0, 4);
        (byYear[y] = byYear[y] || []).push(h);
      });
      const years = Object.keys(byYear);
      if (!years.length) return false;
      years.forEach(y => _years.set(Number(y), makeEntry(byYear[y], 'api')));
      console.log(`[nseHolidays] Cached holidays for ${years.join(', ')} (${holidays.length} days)`);
      await saveDiskStore(byYear);
      return true;
    } catch (e) {
      console.warn('[nseHolidays] API fetch failed:', e.message);
      return false;
    } finally {
      _fetchInflight = null;
    }
  })();
  return _fetchInflight;
}

/**
 * Ensure a year's holiday list is cached, and return its entry.
 * Never throws — the worst case is an entry with an empty/derived list.
 * @param {number} year
 * @returns {Promise<{list:Array,dates:string[],set:Set,source:string,fetchedAt:number}>}
 */
async function ensureYear(year) {
  const y = normaliseYear(year);
  let entry = _years.get(y);
  if (entryFresh(entry)) return entry;

  await loadDiskStore();
  entry = _years.get(y);
  if (entryFresh(entry)) return entry;

  await refreshFromUpstream();
  const fresh = _years.get(y);
  if (fresh) {
    // The call may have succeeded without covering this year (NSE publishes next
    // year's calendar only around Nov–Dec). Either way the year has now been
    // checked: keep the degraded data and re-check on its shorter TTL rather
    // than firing an upstream request on every single lookup.
    if (fresh.source !== 'api') fresh.fetchedAt = Date.now();
    return fresh;
  }

  // Nothing upstream, nothing on disk → legacy list for 2026, else the
  // fixed-date holidays that hold in every year.
  const fallback = y === 2026
    ? makeEntry(FALLBACK_HOLIDAYS_2026, 'fallback')
    : makeEntry(derivedFixedHolidays(y), 'derived');
  console.warn(`[nseHolidays] No NSE data for ${y} — using ${fallback.source} list (${fallback.dates.length} days)`);
  _years.set(y, fallback);
  return fallback;
}

/**
 * Get NSE holidays for a calendar year (with caching).
 * @param {number} [year] - defaults to the current year
 * @returns {Promise<string[]>} Array of holiday dates in YYYY-MM-DD format
 */
async function getNSEHolidays(year) {
  return (await ensureYear(year)).dates;
}

/**
 * Same as getNSEHolidays but with the holiday names the NSE API supplied.
 * @param {number} [year]
 * @returns {Promise<Array<{date:string,name:string}>>}
 */
async function getNSEHolidayDetails(year) {
  return (await ensureYear(year)).list;
}

/**
 * Where a year's holiday list came from — 'api' | 'disk' | 'fallback' | 'derived'.
 * Surfaced in the UI so a degraded calendar is visible rather than silent.
 */
async function getHolidaySource(year) {
  return (await ensureYear(year)).source;
}

/**
 * Check if a given date is an NSE holiday.
 * Year-aware: a 2027 date is checked against the 2027 calendar, so backtests
 * and replays that cross a year boundary stay correct.
 * @param {Date} date - Date to check
 * @returns {Promise<boolean>}
 */
async function isNSEHoliday(date) {
  const dateStr = formatDateToYYYYMMDD(date);
  const entry = await ensureYear(date.getFullYear());
  return entry.set.has(dateStr);
}

/**
 * Check if a given date is a weekend (Saturday or Sunday)
 * @param {Date} date
 * @returns {boolean}
 */
function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday or Saturday
}

/**
 * Check if a given date is a non-trading day (weekend or holiday)
 * @param {Date} date
 * @returns {Promise<boolean>}
 */
async function isNonTradingDay(date) {
  if (isWeekend(date)) return true;
  return await isNSEHoliday(date);
}

/**
 * Get the next valid trading day from a given date
 * @param {Date} startDate - Starting date
 * @returns {Promise<Date>} Next valid trading day
 */
async function getNextTradingDay(startDate) {
  let date = new Date(startDate);

  // Move to next day
  date.setDate(date.getDate() + 1);

  // Keep moving forward until we find a trading day
  let attempts = 0;
  while (attempts < 30) { // Max 30 days ahead
    if (!isWeekend(date)) {
      // Per-date year lookup: a 30-day walk can cross into the next year.
      const hSet = (await ensureYear(date.getFullYear())).set;
      const dateStr = formatDateToYYYYMMDD(date);
      if (!hSet.has(dateStr)) {
        return date;
      }
    }
    date.setDate(date.getDate() + 1);
    attempts++;
  }
  
  // If we couldn't find a trading day in 30 days, return the date anyway
  console.warn('[nseHolidays] ⚠️  Could not find trading day in next 30 days');
  return date;
}

/**
 * Get the previous valid trading day from a given date
 * @param {Date} startDate - Starting date
 * @returns {Promise<Date>} Previous valid trading day
 */
async function getPreviousTradingDay(startDate) {
  let date = new Date(startDate);

  // Move to previous day
  date.setDate(date.getDate() - 1);

  // Keep moving backward until we find a trading day
  let attempts = 0;
  while (attempts < 30) { // Max 30 days back
    if (!isWeekend(date)) {
      // Per-date year lookup: a 30-day walk can cross into the previous year.
      const hSet = (await ensureYear(date.getFullYear())).set;
      const dateStr = formatDateToYYYYMMDD(date);
      if (!hSet.has(dateStr)) {
        return date;
      }
    }
    date.setDate(date.getDate() - 1);
    attempts++;
  }
  
  // If we couldn't find a trading day in 30 days, return the date anyway
  console.warn('[nseHolidays] ⚠️  Could not find trading day in previous 30 days');
  return date;
}

/**
 * Format date to YYYY-MM-DD string
 */
function formatDateToYYYYMMDD(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Clear the in-memory holiday cache (useful for testing / forced refresh).
 * The on-disk snapshot is deliberately kept — it is the fallback that makes a
 * refresh safe to attempt even when NSE is unreachable.
 */
function clearCache() {
  _years.clear();
  _diskLoaded = false;
  console.log('[nseHolidays] Cache cleared');
}

/**
 * Check if current time is within trading hours (7 AM - 4 PM IST)
 * @returns {boolean}
 */
function isWithinTradingHours() {
  // Fast IST: UTC+5:30 = +19800 seconds (avoids expensive toLocaleString/ICU)
  const istSec = Math.floor(Date.now() / 1000) + 19800;
  const hour   = Math.floor(istSec / 3600) % 24;
  return hour >= 7 && hour < 16; // 7 AM to 3:59 PM
}

/**
 * Check if trading is allowed (valid trading day + within trading hours)
 * @returns {Promise<{allowed: boolean, reason: string}>}
 */
async function isTradingAllowed() {
  // Fast IST: UTC+5:30 = +19800 seconds (avoids expensive toLocaleString/ICU)
  const nowMs  = Date.now();
  const istSec = Math.floor(nowMs / 1000) + 19800;
  const istDay = Math.floor(istSec / 86400);
  // JS epoch day 0 = Thursday. (istDay + 4) % 7: 0=Sun, 6=Sat
  const dayOfWeek = (istDay + 4) % 7;

  // Check if it's a weekend (0=Sun, 6=Sat)
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return {
      allowed: false,
      reason: 'Trading not allowed on weekends (Saturday/Sunday)'
    };
  }

  // For holiday check, build an IST Date object (only needed here, not hot path)
  const now = new Date(nowMs + 19800000);
  // Check if it's a holiday
  const isHoliday = await isNSEHoliday(now);
  if (isHoliday) {
    return {
      allowed: false,
      reason: 'Trading not allowed on NSE holidays'
    };
  }

  // Check trading hours
  if (!isWithinTradingHours()) {
    const hour = Math.floor(istSec / 3600) % 24;
    const min  = Math.floor(istSec / 60) % 60;
    return {
      allowed: false,
      reason: `Trading allowed only between 7 AM - 4 PM IST (current time: ${hour}:${String(min).padStart(2, '0')})`
    };
  }

  return {
    allowed: true,
    reason: 'Trading allowed'
  };
}

/**
 * Force refresh the holiday cache from the NSE API.
 *
 * Refreshes the requested year *and* the following one, because that is what
 * the calendar UI shows — click REFRESH in December 2026 and you get 2027 as
 * soon as NSE publishes it, with no restart and no code change.
 *
 * @param {number} [year] - defaults to the current year
 * @returns {Promise<{success:boolean,count:number,year:number,source:string,years:number[],sources:Object,holidays:string[],details:Array,error?:string}>}
 */
async function refreshHolidayCache(year) {
  const target = normaliseYear(year);
  const years = [target, target + 1];
  try {
    console.log(`[nseHolidays] Manual refresh requested for ${years.join(' + ')}...`);
    clearCache();

    const sources = {};
    for (const y of years) {
      const e = await ensureYear(y);
      sources[y] = { count: e.dates.length, source: e.source };
    }

    const entry = await ensureYear(target);
    return {
      success: entry.source === 'api',
      count: entry.dates.length,
      year: target,
      source: entry.source,
      years,
      sources,
      holidays: entry.dates,
      details: entry.list,
    };
  } catch (error) {
    console.error('[nseHolidays] Manual refresh failed:', error.message);
    return { success: false, count: 0, year: target, source: 'error', years, sources: {}, holidays: [], details: [], error: error.message };
  }
}

/**
 * Check if today is NIFTY weekly expiry day (Tuesday, or Monday if Tuesday is holiday)
 */
async function isExpiryDay() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day = now.getDay(); // 0=Sun, 2=Tue

  // Tuesday = normal expiry
  if (day === 2) return true;

  // Monday = check if Tuesday is a holiday (preponed expiry)
  if (day === 1) {
    const tue = new Date(now);
    tue.setDate(tue.getDate() + 1);
    return await isNSEHoliday(tue);
  }

  return false;
}

/**
 * Check if a given date string (YYYY-MM-DD) is an expiry day.
 * Used by backtest to filter candles to expiry-only days.
 *
 * NIFTY weekly expiry day changed in April 2025:
 *   • Before 2025-04-04: Thursday was expiry (preponed to Wednesday if Thu = holiday)
 *   • 2025-04-04 onwards: Tuesday is expiry (preponed to Monday if Tue = holiday)
 *
 * The cutover can be overridden via EXPIRY_DAY_CUTOVER env var (YYYY-MM-DD).
 */
async function isExpiryDate(dateStr) {
  const d = new Date(dateStr + "T12:00:00+05:30"); // parse in IST
  const day = d.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu
  const expiryDow = expiryWeekdayFor(dateStr);

  // Normal expiry weekday
  if (day === expiryDow) return true;

  // Day before → expiry preponed here if the expiry weekday is a holiday
  if (day === expiryDow - 1) {
    const nxt = new Date(d);
    nxt.setDate(nxt.getDate() + 1);
    return await isNSEHoliday(nxt);
  }
  return false;
}

/**
 * Which weekday carries the NIFTY weekly expiry on a given date.
 * Thursday (4) before the April-2025 cutover, Tuesday (2) after it.
 * ISO strings compare lexicographically, so no Date parsing is needed.
 */
function expiryWeekdayFor(isoDate) {
  const cutover = process.env.EXPIRY_DAY_CUTOVER || "2025-04-04";
  return isoDate < cutover ? 4 : 2;
}

/**
 * Build the full NIFTY expiry calendar for a calendar year.
 *
 * Year-agnostic by construction: the expiry weekday comes from the cutover rule,
 * the monthly expiry is simply the last weekly expiry of each month, and any
 * expiry landing on a holiday is preponed to the previous trading day (which may
 * be in the previous calendar year, hence the two holiday sets).
 *
 * @param {number} [year]
 * @returns {Promise<Array<{date:string,actual:string,preponed:boolean,monthly:boolean}>>}
 */
async function getExpiryCalendar(year) {
  const y = normaliseYear(year);

  const sets = new Map();
  for (const yy of [y - 1, y]) sets.set(yy, (await ensureYear(yy)).set);
  const isHoliday = (dt) => {
    const s = sets.get(dt.getFullYear());
    return s ? s.has(formatDateToYYYYMMDD(dt)) : false;
  };

  const results = [];
  const lastOfMonth = new Map();          // month index → position in results
  const d = new Date(y, 0, 1);

  while (d.getFullYear() === y) {
    const iso = formatDateToYYYYMMDD(d);
    if (d.getDay() === expiryWeekdayFor(iso)) {
      let actual = iso;
      let preponed = false;
      if (isHoliday(d)) {
        const prev = new Date(d);
        for (let i = 0; i < 7; i++) {
          prev.setDate(prev.getDate() - 1);
          if (prev.getDay() !== 0 && prev.getDay() !== 6 && !isHoliday(prev)) {
            actual = formatDateToYYYYMMDD(prev);
            preponed = true;
            break;
          }
        }
      }
      results.push({ date: iso, actual, preponed, monthly: false });
      lastOfMonth.set(d.getMonth(), results.length - 1);
    }
    d.setDate(d.getDate() + 1);
  }

  // Monthly expiry = the last weekly expiry of the month.
  lastOfMonth.forEach(idx => { results[idx].monthly = true; });
  return results;
}

module.exports = {
  getNSEHolidays,
  getNSEHolidayDetails,
  getHolidaySource,
  getExpiryCalendar,
  isNSEHoliday,
  isWeekend,
  isNonTradingDay,
  getNextTradingDay,
  getPreviousTradingDay,
  clearCache,
  formatDateToYYYYMMDD,
  isWithinTradingHours,
  isTradingAllowed,
  isExpiryDay,
  isExpiryDate,
  refreshHolidayCache
};

// Made with Bob

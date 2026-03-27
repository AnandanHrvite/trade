/**
 * nseHolidays.js — NSE Holiday & Expiry Management
 * ─────────────────────────────────────────────────────────────────────────────
 * 
 * Fetches NSE trading holidays from official NSE API
 * Caches holidays for performance
 * Provides holiday checking and next valid trading day calculation
 * 
 * NSE API: https://www.nseindia.com/api/holiday-master?type=trading
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require('https');

// Cache for NSE holidays (refreshed daily)
let holidayCache = {
  year: null,
  holidays: [],
  lastFetch: null
};

// Hardcoded fallback holidays for 2026 (in case API fails)
// Source: NSE Holiday Calendar 2026
const FALLBACK_HOLIDAYS_2026 = [
  '2026-01-26', // Republic Day
  '2026-03-14', // Holi
  '2026-03-25', // Holi (Second day)
  '2026-03-31', // Eid-ul-Fitr (Tuesday - expiry preponed to Monday 30th)
  '2026-04-02', // Mahavir Jayanti
  '2026-04-10', // Good Friday
  '2026-04-21', // Ram Navami
  '2026-05-01', // Maharashtra Day
  '2026-05-26', // Buddha Purnima
  '2026-08-15', // Independence Day
  '2026-08-27', // Ganesh Chaturthi
  '2026-10-02', // Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-04', // Diwali - Laxmi Pujan
  '2026-11-05', // Diwali - Balipratipada
  '2026-11-19', // Gurunanak Jayanti
  '2026-12-25', // Christmas
];

/**
 * Fetch NSE holidays from official API
 * @returns {Promise<string[]>} Array of holiday dates in YYYY-MM-DD format
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
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          // Check if response looks like HTML (NSE sometimes returns HTML error pages)
          if (data.trim().startsWith('<') || data.trim().startsWith('<!DOCTYPE')) {
            console.warn('[nseHolidays] ⚠️  NSE API returned HTML instead of JSON (likely blocked or rate limited)');
            reject(new Error('NSE API returned HTML instead of JSON - API may be blocking requests'));
            return;
          }
          
          const json = JSON.parse(data);
          const holidays = [];
          
          // NSE API returns: { CM: [{tradingDate: "DD-MMM-YYYY", ...}], FO: [...] }
          // We need FO (Futures & Options) holidays
          if (json.FO && Array.isArray(json.FO)) {
            json.FO.forEach(item => {
              if (item.tradingDate) {
                // Convert "31-Mar-2026" to "2026-03-31"
                const date = parseNSEDate(item.tradingDate);
                if (date) holidays.push(date);
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

/**
 * Get NSE holidays for the current year (with caching)
 * @returns {Promise<string[]>} Array of holiday dates in YYYY-MM-DD format
 */
async function getNSEHolidays() {
  const now = new Date();
  const currentYear = now.getFullYear();
  
  // Check cache validity (refresh if different year or older than 24 hours)
  const cacheAge = holidayCache.lastFetch ? (Date.now() - holidayCache.lastFetch) : Infinity;
  const cacheValid = holidayCache.year === currentYear && cacheAge < 24 * 60 * 60 * 1000;
  
  if (cacheValid && holidayCache.holidays.length > 0) {
    console.log(`[nseHolidays] Using cached holidays (${holidayCache.holidays.length} days)`);
    return holidayCache.holidays;
  }
  
  // Try to fetch from NSE API
  try {
    const holidays = await fetchNSEHolidays();
    
    // Filter for current year only
    const yearHolidays = holidays.filter(h => h.startsWith(String(currentYear)));
    
    if (yearHolidays.length > 0) {
      holidayCache = {
        year: currentYear,
        holidays: yearHolidays,
        lastFetch: Date.now()
      };
      return yearHolidays;
    }
  } catch (e) {
    console.warn('[nseHolidays] ⚠️  API fetch failed, using fallback');
  }
  
  // Fallback to hardcoded holidays
  const fallback = currentYear === 2026 ? FALLBACK_HOLIDAYS_2026 : [];
  console.log(`[nseHolidays] Using fallback holidays for ${currentYear} (${fallback.length} days)`);
  
  holidayCache = {
    year: currentYear,
    holidays: fallback,
    lastFetch: Date.now()
  };
  
  return fallback;
}

/**
 * Check if a given date is an NSE holiday
 * @param {Date} date - Date to check
 * @returns {Promise<boolean>}
 */
async function isNSEHoliday(date) {
  const holidays = await getNSEHolidays();
  const dateStr = formatDateToYYYYMMDD(date);
  return holidays.includes(dateStr);
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
  const holidays = await getNSEHolidays();
  let date = new Date(startDate);
  
  // Move to next day
  date.setDate(date.getDate() + 1);
  
  // Keep moving forward until we find a trading day
  let attempts = 0;
  while (attempts < 30) { // Max 30 days ahead
    if (!isWeekend(date)) {
      const dateStr = formatDateToYYYYMMDD(date);
      if (!holidays.includes(dateStr)) {
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
  const holidays = await getNSEHolidays();
  let date = new Date(startDate);
  
  // Move to previous day
  date.setDate(date.getDate() - 1);
  
  // Keep moving backward until we find a trading day
  let attempts = 0;
  while (attempts < 30) { // Max 30 days back
    if (!isWeekend(date)) {
      const dateStr = formatDateToYYYYMMDD(date);
      if (!holidays.includes(dateStr)) {
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
 * Clear the holiday cache (useful for testing)
 */
function clearCache() {
  holidayCache = {
    year: null,
    holidays: [],
    lastFetch: null
  };
  console.log('[nseHolidays] Cache cleared');
}

/**
 * Check if current time is within trading hours (7 AM - 4 PM IST)
 * @returns {boolean}
 */
function isWithinTradingHours() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const hour = now.getHours();
  return hour >= 7 && hour < 16; // 7 AM to 3:59 PM
}

/**
 * Check if trading is allowed (valid trading day + within trading hours)
 * @returns {Promise<{allowed: boolean, reason: string}>}
 */
async function isTradingAllowed() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  
  // Check if it's a weekend
  if (isWeekend(now)) {
    return {
      allowed: false,
      reason: 'Trading not allowed on weekends (Saturday/Sunday)'
    };
  }
  
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
    const hour = now.getHours();
    return {
      allowed: false,
      reason: `Trading allowed only between 7 AM - 4 PM IST (current time: ${hour}:${String(now.getMinutes()).padStart(2, '0')})`
    };
  }
  
  return {
    allowed: true,
    reason: 'Trading allowed'
  };
}

/**
 * Force refresh holiday cache from NSE API
 * @returns {Promise<{success: boolean, count: number, error?: string}>}
 */
async function refreshHolidayCache() {
  try {
    console.log('[nseHolidays] Manual refresh requested...');
    clearCache();
    const holidays = await getNSEHolidays();
    return {
      success: true,
      count: holidays.length,
      holidays: holidays
    };
  } catch (error) {
    console.error('[nseHolidays] Manual refresh failed:', error.message);
    return {
      success: false,
      count: 0,
      error: error.message
    };
  }
}

module.exports = {
  getNSEHolidays,
  isNSEHoliday,
  isWeekend,
  isNonTradingDay,
  getNextTradingDay,
  getPreviousTradingDay,
  clearCache,
  formatDateToYYYYMMDD,
  isWithinTradingHours,
  isTradingAllowed,
  refreshHolidayCache
};

// Made with Bob

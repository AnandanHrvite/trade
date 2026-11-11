/**
 * markets.js — the MARKET LIST: every market a strategy can be pointed at, and
 * its expiry calendar.
 * ─────────────────────────────────────────────────────────────────────────────
 * A thin layer over config/instrument.js (UNDERLYING_DEFS / underlyingOf) and
 * services/mcxContracts.js. It adds nothing a NIFTY engine reads: no strategy
 * is wired to a non-NIFTY market through this file yet, and the NIFTY row is
 * the same resolved instrument row the engines already use, unprefixed keys
 * and all.
 *
 *   markets.list()                          every market, in display order
 *   markets.get(key)                        one market (unknown key → NIFTY)
 *   markets.nextExpiry(key, date?)          "YYYY-MM-DD" of the contract live at `date`
 *   markets.expiryInfo(key, date?)          …with its source, scheduled date and Fyers code
 *   markets.optionSymbol(key, spot, side, opts?)  the Fyers symbol for that expiry
 *   markets.isTradingDay(key, date?)        exchange open that day (weekend / holiday aware)
 *   markets.session(key)                    exchange hours, IST
 *
 * `date` is an instant (Date / epoch ms — read in IST) or an IST wall-clock
 * string "YYYY-MM-DD" (start of day) / "YYYY-MM-DDTHH:MM". Omitted = now.
 *
 * EXPIRY. NSE and BSE contracts follow a rule — weekly on the market's expiry
 * weekday, monthly on the month's last one, preponed to the previous trading
 * day when that day is a holiday — computed by instrument.js's weeklyExpiryAt /
 * monthlyExpiryAt / futuresContractAt, the same functions the engines'
 * getNearest*ExpiryDate() run. A contract stays "next" until its expiry-day
 * session closes. MCX expiries follow no rule (crude options expire days before
 * their future), so they are read from Fyers' MCX symbol master exactly as
 * mcxContracts.js does — synchronously only from today's already-downloaded
 * copy (nextExpiryAsync() downloads it). A manual override wins whenever it is
 * set, well-formed and its session has not closed yet.
 *
 * HOLIDAYS. NSE and BSE publish the same equity-derivatives holiday list, so BSE
 * reuses nseHolidays.js (the cache-only sync lookups — warmed by the running
 * process, else the offline fallback list). MCX has no calendar in this repo
 * (see utils/mcxHolidays.js — it runs its evening session on many NSE
 * holidays), so an MCX weekday counts as a trading day here; a shut session is
 * detected live by mcxHolidays.mcxSessionClosed().
 * ─────────────────────────────────────────────────────────────────────────────
 */

const instrument  = require("./instrument");
const nseHolidays = require("../utils/nseHolidays");
const mcx         = require("../services/mcxContracts");

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Exchange hours, IST. NSE and BSE derivatives share 09:15–15:30; MCX 09:00–23:30.
const SESSIONS = {
  NSE: { start: "09:15", end: "15:30" },
  BSE: { start: "09:15", end: "15:30" },
  MCX: { start: "09:00", end: "23:30" },
};

// Holiday calendars. BSE = NSE's list (same equity-derivatives holidays).
const CALENDARS = {
  NSE: { label: "NSE",                     isNonTradingDay: (d) => nseHolidays.isNonTradingDaySync(d) },
  BSE: { label: "BSE (NSE holiday list)",  isNonTradingDay: (d) => nseHolidays.isNonTradingDaySync(d) },
  MCX: { label: "MCX (weekends; holidays detected live)", isNonTradingDay: (d) => nseHolidays.isWeekend(d) },
};

/**
 * The market list. Option/futures markets name a row of instrument.js's
 * UNDERLYING_DEFS (`underlying`) and take everything — symbols, strike grid,
 * lot size, expiry weekday, env keys — from it. MCX markets name a commodity of
 * mcxContracts.COMMODITIES. Stocks are appended from instrument.STOCK_DEFS, so
 * adding a stock there is the whole job.
 *
 * Env keys: NIFTY keeps its ORIGINAL unprefixed keys (OPTION_EXPIRY_OVERRIDE,
 * NIFTY_LOT_SIZE …), BANKNIFTY_* / SAIL_* are the existing instrument keys, and
 * the new markets carry their own prefix (SENSEX_ / FUT_ / CRUDE_ / GOLD_ /
 * SILVER_).
 */
const MARKET_DEFS = {
  NIFTY:     { group: "index",     kind: "options", underlying: "NIFTY" },
  NIFTY_FUT: {
    group: "futures", kind: "futures", underlying: "NIFTY", label: "NIFTY 50 Futures",
    // The futures lot IS the options lot (NSE sets one contract size per
    // underlying), so the lot and margin keys are NIFTY's own; only the expiry
    // override is new.
    env: { lotSize: "NIFTY_LOT_SIZE", marginPct: "NIFTY_FUTURES_MARGIN_PCT", expiryOverride: "FUT_EXPIRY_OVERRIDE" },
  },
  BANKNIFTY: { group: "index",     kind: "options", underlying: "BANKNIFTY" },
  SENSEX:    { group: "index",     kind: "options", underlying: "SENSEX" },
  CRUDE:     { group: "commodity", kind: "mcx", commodity: "CRUDE",  env: { expiryOverride: "CRUDE_OPTION_EXPIRY_OVERRIDE" } },
  GOLD:      { group: "commodity", kind: "mcx", commodity: "GOLD",   env: { expiryOverride: "GOLD_OPTION_EXPIRY_OVERRIDE" } },
  SILVER:    { group: "commodity", kind: "mcx", commodity: "SILVER", env: { expiryOverride: "SILVER_OPTION_EXPIRY_OVERRIDE" } },
};
for (const k of Object.keys(instrument.STOCK_DEFS)) {
  MARKET_DEFS[k] = { group: "stock", kind: "options", underlying: k };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const _toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const _ymd   = (d) => nseHolidays.formatDateToYYYYMMDD(d);
const _isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T00:00:00Z`).getTime());

/** Anything a caller passes as `date` → a Date whose LOCAL fields read as IST. */
function _istOf(date) {
  if (typeof date === "string") {
    const m = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
    if (!m) throw new Error(`[markets] bad date "${date}" — expected YYYY-MM-DD or YYYY-MM-DDTHH:MM (IST)`);
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), 0, 0);
  }
  const ms = date == null ? Date.now() : date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(ms)) throw new Error("[markets] invalid date");
  const t = new Date(ms + 19800000);   // UTC+5:30, read back through getUTC*
  return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), 0);
}

function _ymdToDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function _session(exchange) {
  const s = SESSIONS[exchange] || SESSIONS.NSE;
  return { exchange, start: s.start, end: s.end, startMin: _toMin(s.start), endMin: _toMin(s.end), tz: "Asia/Kolkata" };
}

function _normKey(key) {
  const up = String(key == null ? "" : key).trim().toUpperCase().replace(/[\s-]/g, "_");
  if (MARKET_DEFS[up]) return up;
  if (up === "BN" || up === "NIFTYBANK" || up === "NIFTY_BANK") return "BANKNIFTY";
  if (up === "NIFTY_FUTURES" || up === "NIFTYFUT") return "NIFTY_FUT";
  if (up === "CRUDEOIL") return "CRUDE";
  return "NIFTY";   // unknown → NIFTY, as everywhere else in the app
}

// ── the API ──────────────────────────────────────────────────────────────────

/**
 * One market, resolved LIVE from process.env (a Settings save applies on the
 * next call). Unknown keys resolve to NIFTY.
 */
function get(key) {
  const k   = _normKey(key);
  const def = MARKET_DEFS[k];

  if (def.kind === "mcx") {
    const C        = mcx.COMMODITIES[def.commodity];
    const contract = mcx.contractFor(def.commodity);
    const info     = mcx.UNDERLYINGS[contract];
    const env      = { contract: C.envKey, expiryOverride: def.env.expiryOverride };
    return {
      key: k, label: C.label, group: def.group, kind: def.kind, exchange: "MCX",
      holidays: "MCX", session: _session("MCX"),
      contract,                                 // e.g. "CRUDEOIL" / "GOLDM" (CMX_*_CONTRACT)
      spot:        null,                        // the signal source is the future, read from the master
      optionStem:  `MCX:${contract}{YY}{MMM}{strike}{CE|PE}`,
      futuresStem: `MCX:${contract}{YY}{MMM}FUT`,
      strikeStep:  info.strikeStep,
      lotSize:     info.multiplier,             // units per lot, e.g. 100 barrels
      lotUnit:     info.unit,
      expiry: { rule: "Fyers MCX symbol master (no fixed weekday)", weekday: null, weekly: false },
      env,
      expiryOverride: String(process.env[env.expiryOverride] || "").trim(),
      underlying: null,
      traded: false,
    };
  }

  const U   = instrument.underlyingOf(def.underlying);
  const day = DAY_NAMES[U.expiryDow];
  const isFut = def.kind === "futures";
  const env = isFut ? def.env : U.env;
  const holidays = U.exchange === "BSE" ? "BSE" : "NSE";
  return {
    key: k,
    label: def.label || U.label,
    group: def.group,
    kind: def.kind,
    exchange: U.exchange,
    holidays,
    session: _session(U.exchange),
    spot:        U.spot,
    optionStem:  isFut ? null : `${U.exchange}:${U.optPrefix}{expiry}{strike}{CE|PE}`,
    futuresStem: `${U.exchange}:${U.futPrefix}{YY}{MMM}FUT`,
    strikeStep:  isFut ? null : U.strikeStep,
    lotSize:     U.lotSize,
    expiry: isFut
      ? { rule: `monthly — last ${day}, rolled 2 days early; preponed on a ${holidays} holiday`, weekday: U.expiryDow, weekly: false }
      : U.weekly
        ? { rule: `weekly ${day} (monthly = last ${day}); preponed on a ${holidays} holiday`, weekday: U.expiryDow, weekly: true }
        : { rule: `monthly — last ${day}; preponed on a ${holidays} holiday`, weekday: U.expiryDow, weekly: false },
    env,
    expiryOverride: String(process.env[env.expiryOverride] || "").trim(),
    underlying: U.key,
    // Is something actually trading it? (marketOnly rows are listed, not traded.)
    traded: !U.marketOnly,
  };
}

/** Every market, in display order (indices, futures, commodities, stocks). */
function list() { return Object.keys(MARKET_DEFS).map(get); }

/** Exchange session hours for a market, IST. */
function session(key) { return get(key).session; }

/** Is the market's exchange open on `date`'s IST calendar day? */
function isTradingDay(key, date) {
  const M = get(key);
  return !CALENDARS[M.holidays].isNonTradingDay(_istOf(date));
}

/**
 * The contract live at `date`, with where the answer came from:
 *   { key, date: "YYYY-MM-DD" | null, scheduled, code, source, overrideStale }
 *   source  "override" — the manual key, set and its session still open
 *           "rule"     — computed from the expiry rule + holidays (NSE / BSE)
 *           "master"   — Fyers' MCX symbol master (today's downloaded copy)
 *           "unavailable" — MCX with no master copy on hand (see nextExpiryAsync)
 *   date      the day it actually settles (holiday-preponed)
 *   scheduled the rule's date before any prepone (rule only)
 *   code      the Fyers expiry code ("26N17", "26NOV") — options/futures only
 *   overrideStale  an override is set but its session has closed (it is ignored
 *                  here; the order path refuses entries on it)
 */
function expiryInfo(key, date) {
  const M   = get(key);
  const ist = _istOf(date);
  return _expiryInfo(M, ist, M.kind === "mcx" ? _mcxPeek(M, ist) : null);
}

function _mcxPeek(M, ist) {
  // `ist` carries IST wall-clock fields in local time; rebuild the true instant.
  const ms = Date.UTC(ist.getFullYear(), ist.getMonth(), ist.getDate(), ist.getHours(), ist.getMinutes()) - 19800000;
  return mcx.peekSeries(M.contract, { nowMs: ms });
}

function _expiryInfo(M, ist, series) {
  const today  = _ymd(ist);
  const nowMin = ist.getHours() * 60 + ist.getMinutes();
  const ov     = M.expiryOverride;
  let overrideStale = false;
  if (ov && _isYmd(ov)) {
    if (ov > today || (ov === today && nowMin < M.session.endMin)) {
      return { key: M.key, date: ov, scheduled: ov, code: _codeFor(M, _ymdToDate(ov), true), source: "override", overrideStale: false };
    }
    overrideStale = true;
  }

  if (M.kind === "mcx") {
    if (!series) return { key: M.key, date: null, scheduled: null, code: null, source: "unavailable", overrideStale };
    return { key: M.key, date: series.optionExpiry, scheduled: series.optionExpiry, code: null, source: "master",
             future: series.future, futureExpiry: series.futureExpiry, overrideStale };
  }

  const U = instrument.underlyingOf(M.underlying);
  let sched, code;
  if (M.kind === "futures") {
    const c = instrument.futuresContractAt(ist, U);
    sched = c.date; code = c.code;
  } else {
    sched = instrument.weeklyExpiryAt(ist, U);   // monthly-only rows get their monthly date
  }
  const eff = nseHolidays.preponedExpirySync(sched);
  if (!code) code = instrument.expiryCodeFor(eff, U);
  return { key: M.key, date: _ymd(eff), scheduled: _ymd(sched), code, source: "rule", overrideStale };
}

/** The Fyers code for an expiry date — monthly YYMMM when the override is typed monthly, as the engines do. */
function _codeFor(M, d, fromOverride) {
  if (M.kind === "mcx") return null;
  const U = instrument.underlyingOf(M.underlying);
  const yymmm = `${String(d.getFullYear()).slice(2)}${["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()]}`;
  if (M.kind === "futures") return yymmm;
  // validateAndGetOptionSymbol's override branch: a monthly expiry type (or a
  // monthly-only underlying) names the month contract whatever the day.
  if (fromOverride && (U.weekly ? (U.expiryType || "weekly") : "monthly") === "monthly") return yymmm;
  return instrument.expiryCodeFor(d, U);
}

/** "YYYY-MM-DD" of the market's next (still trading) expiry at `date`, or null. */
function nextExpiry(key, date) { return expiryInfo(key, date).date; }

/**
 * expiryInfo(), downloading the MCX symbol master first when needed (at most
 * once per IST day — mcxContracts caches it). Same answer as expiryInfo() for
 * NSE / BSE markets.
 */
async function expiryInfoAsync(key, date) {
  const M = get(key);
  const ist = _istOf(date);
  if (M.kind !== "mcx") return _expiryInfo(M, ist, null);
  let series = _mcxPeek(M, ist);
  if (!series) {
    try { await mcx.resolveSeries(M.contract); series = _mcxPeek(M, ist); }
    catch (e) { console.warn(`[markets] ${M.key}: MCX symbol master unavailable — ${e.message}`); }
  }
  return _expiryInfo(M, ist, series);
}
async function nextExpiryAsync(key, date) { return (await expiryInfoAsync(key, date)).date; }

/**
 * The Fyers symbol for `side` at `spot`, on the market's next expiry.
 *
 *   options  `{EXCH}:{stem}{code}{strike}{CE|PE}` — strike = the ATM strike on
 *            the market's grid with its configured CE/PE offset applied, exactly
 *            as instrument.calcATMStrike() gives the engines.
 *   futures  `{EXCH}:{stem}{YYMMM}FUT` (side ignored)
 *   MCX      the listed option nearest `spot` in the master's nearest series
 *            (opts.series, else today's cached master); null when none is on
 *            hand, or when a live override names a different expiry — a
 *            different contract is never substituted silently.
 *
 * opts: { date, expiry: "YYYY-MM-DD" (explicit), strike (explicit), atm: true
 *         (ignore the configured offsets), series (MCX resolveSeries result) }
 * Returns null when no expiry can be resolved.
 */
function optionSymbol(key, spot, side, opts = {}) {
  const M = get(key);
  const S = String(side || "").toUpperCase();
  if (M.kind !== "futures" && S !== "CE" && S !== "PE") {
    throw new Error(`[markets] optionSymbol: invalid side "${side}" — must be "CE" or "PE"`);
  }

  if (M.kind === "mcx") {
    const ist = _istOf(opts.date);
    const series = opts.series || _mcxPeek(M, ist);
    if (!series) return null;
    const info = _expiryInfo(M, ist, series);
    if (info.source === "override" && info.date !== series.optionExpiry) return null;
    const atm = mcx.atmOption(series, S, Number(spot));
    return atm ? atm.symbol : null;
  }

  const U = instrument.underlyingOf(M.underlying);
  let code;
  if (opts.expiry) {
    if (!_isYmd(String(opts.expiry))) throw new Error(`[markets] optionSymbol: bad expiry "${opts.expiry}" — expected YYYY-MM-DD`);
    code = _codeFor(M, _ymdToDate(String(opts.expiry)), false);
  } else {
    const info = expiryInfo(M.key, opts.date);
    if (!info.date) return null;
    code = info.code;
  }

  if (M.kind === "futures") return `${U.exchange}:${U.futPrefix}${code}FUT`;

  const fixed  = typeof opts.strike === "number" && Number.isFinite(opts.strike) && opts.strike > 0;
  const strike = fixed ? opts.strike : instrument.calcATMStrike(Number(spot), opts.atm ? null : S, U);
  return `${U.exchange}:${U.optPrefix}${code}${strike}${S}`;
}

module.exports = {
  list,
  get,
  nextExpiry,
  nextExpiryAsync,
  expiryInfo,
  expiryInfoAsync,
  optionSymbol,
  isTradingDay,
  session,
  MARKET_DEFS,
  SESSIONS,
};

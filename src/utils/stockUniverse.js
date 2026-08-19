/**
 * stockUniverse.js — the stock lists the Swing Scanner scans
 * ─────────────────────────────────────────────────────────────────────────────
 * Three presets, each a plain array of NSE trading symbols:
 *
 *   NIFTY50   ~50 large caps          — fastest scan
 *   NIFTY100  ~100 large + mid caps
 *   FNO       ~220 F&O-eligible names — the natural universe for positional
 *             swing entries (liquid, no circuit-limit surprises)
 *
 * SYMBOL FORMS. One symbol, two spellings, and they are NOT interchangeable:
 *   Fyers (history/quotes) → "NSE:RELIANCE-EQ"
 *   Zerodha (orders)       → exchange "NSE", tradingsymbol "RELIANCE"
 * Everything downstream goes through fyersSymbol()/zerodhaSymbol() so neither
 * form is ever hand-built at a call site. zerodhaBroker.convertSymbol() must
 * NOT be used for equities — it would hand Kite "RELIANCE-EQ", which is not a
 * tradable symbol on NSE and is rejected at order time.
 *
 * WHY THIS FILE IS OVERRIDABLE
 * ────────────────────────────
 * Index constituents change (reshuffles, mergers, renames — ZOMATO→ETERNAL is
 * the recent one) and the F&O list is revised by NSE every month. A hardcoded
 * list therefore rots, and a rotten entry is silent: Fyers answers "no_data"
 * and the stock simply never appears in a scan. So:
 *
 *   • the built-ins below are a STARTING POINT, not a claim of correctness;
 *   • ~/trading-data/swing_scanner_universe.json overrides any/all of them;
 *   • the scanner reports every symbol that returned no data, by name, so a
 *     stale entry shows up as a visible skip instead of a silent omission.
 *
 * Override file shape (any subset of keys; a key you omit keeps its built-in):
 *   { "NIFTY50": ["RELIANCE", "TCS", ...], "FNO": [...], "MYLIST": [...] }
 * A key that is not one of the three built-ins is added as an extra preset, so
 * a personal watchlist is just another entry in the dropdown.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const OVERRIDE_FILE = path.join(os.homedir(), "trading-data", "swing_scanner_universe.json");

// ── NIFTY 50 ────────────────────────────────────────────────────────────────
const NIFTY50 = [
  "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK",
  "BAJAJ-AUTO", "BAJAJFINSV", "BAJFINANCE", "BEL", "BHARTIARTL",
  "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "ETERNAL",
  "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE", "HEROMOTOCO",
  "HINDALCO", "HINDUNILVR", "ICICIBANK", "INDUSINDBK", "INFY",
  "ITC", "JIOFIN", "JSWSTEEL", "KOTAKBANK", "LT",
  "M&M", "MARUTI", "NESTLEIND", "NTPC", "ONGC",
  "POWERGRID", "RELIANCE", "SBILIFE", "SBIN", "SHRIRAMFIN",
  "SUNPHARMA", "TATACONSUM", "TATAMOTORS", "TATASTEEL", "TCS",
  "TECHM", "TITAN", "TRENT", "ULTRACEMCO", "WIPRO",
];

// ── NIFTY 100 = NIFTY 50 + the next 50 ──────────────────────────────────────
const NIFTY_NEXT_50 = [
  "ABB", "ADANIENSOL", "ADANIGREEN", "ADANIPOWER", "AMBUJACEM",
  "BAJAJHLDNG", "BANKBARODA", "BOSCHLTD", "BPCL", "BRITANNIA",
  "CANBK", "CGPOWER", "CHOLAFIN", "DABUR", "DIVISLAB",
  "DLF", "DMART", "GAIL", "GODREJCP", "HAVELLS",
  "HAL", "HYUNDAI", "ICICIGI", "ICICIPRULI", "INDHOTEL",
  "INDIGO", "IOC", "IRFC", "JINDALSTEL", "JSWENERGY",
  "LICI", "LODHA", "LTIM", "MOTHERSON", "NAUKRI",
  "PFC", "PIDILITIND", "PNB", "RECLTD", "SIEMENS",
  "SWIGGY", "TATAPOWER", "TORNTPHARM", "TVSMOTOR", "UNITDSPR",
  "VBL", "VEDL", "ZYDUSLIFE", "IRCTC", "MAXHEALTH",
];

const NIFTY100 = [...NIFTY50, ...NIFTY_NEXT_50];

// ── F&O universe ────────────────────────────────────────────────────────────
// NIFTY 100 plus the rest of the derivatives list. NSE revises this monthly —
// treat it as a good default, not gospel, and edit the override file when a
// name is added or dropped.
const FNO_EXTRA = [
  "AARTIIND", "ABCAPITAL", "ABFRL", "ACC", "ALKEM",
  "ANGELONE", "APLAPOLLO", "ASHOKLEY", "ASTRAL", "ATGL",
  "AUBANK", "AUROPHARMA", "BALKRISIND", "BANDHANBNK", "BANKINDIA",
  "BATAINDIA", "BERGEPAINT", "BHARATFORG", "BHEL", "BIOCON",
  "BLUESTARCO", "BSE", "BSOFT", "CAMS", "CANFINHOME",
  "CDSL", "CESC", "CHAMBLFERT", "COFORGE", "COLPAL",
  "CONCOR", "CROMPTON", "CUMMINSIND", "CYIENT", "DALBHARAT",
  "DEEPAKNTR", "DELHIVERY", "DIXON", "ESCORTS", "EXIDEIND",
  "FEDERALBNK", "FORTIS", "GLENMARK", "GMRAIRPORT", "GNFC",
  "GODREJPROP", "GRANULES", "GUJGASLTD", "HFCL", "HINDCOPPER",
  "HINDPETRO", "HUDCO", "IDEA", "IDFCFIRSTB", "IEX",
  "IGL", "INDIAMART", "INDIANB", "INDUSTOWER", "IPCALAB",
  "IRB", "JKCEMENT", "JSL", "JUBLFOOD", "KALYANKJIL",
  "KEI", "KPITTECH", "LAURUSLABS", "LICHSGFIN", "LTF",
  "LTTS", "LUPIN", "MANAPPURAM", "MARICO", "MCX",
  "MFSL", "MGL", "MPHASIS", "MRF", "MUTHOOTFIN",
  "NATIONALUM", "NBCC", "NCC", "NHPC", "NMDC",
  "NYKAA", "OBEROIRLTY", "OFSS", "OIL", "PAGEIND",
  "PATANJALI", "PAYTM", "PEL", "PERSISTENT", "PETRONET",
  "PHOENIXLTD", "PIIND", "POLICYBZR", "POLYCAB", "POONAWALLA",
  "PRESTIGE", "RBLBANK", "RVNL", "SAIL", "SBICARD",
  "SHREECEM", "SJVN", "SOLARINDS", "SONACOMS", "SRF",
  "SUNTV", "SUPREMEIND", "SYNGENE", "TATACHEM", "TATACOMM",
  "TATAELXSI", "TATATECH", "TIINDIA", "TITAGARH", "TORNTPOWER",
  "TRIVENI", "UBL", "UNIONBANK", "UNOMINDA", "UPL",
  "VOLTAS", "YESBANK", "ZYDUSWELL",
];

const FNO = [...NIFTY100, ...FNO_EXTRA];

const BUILTIN = {
  NIFTY50:  { label: "NIFTY 50",       symbols: NIFTY50  },
  NIFTY100: { label: "NIFTY 100",      symbols: NIFTY100 },
  FNO:      { label: "F&O universe",   symbols: FNO      },
};

// Order the dropdown smallest-first: scan time is roughly linear in symbol count
// and the fast one should be the easy default.
const BUILTIN_ORDER = ["NIFTY50", "NIFTY100", "FNO"];

/** Normalise: upper-case, trim, drop blanks and duplicates, keep input order. */
function cleanList(arr) {
  if (!Array.isArray(arr)) return null;
  const seen = new Set();
  const out  = [];
  for (const raw of arr) {
    if (typeof raw !== "string") continue;
    const s = raw.trim().toUpperCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length ? out : null;
}

/**
 * Read the override file. Never throws — a malformed override must degrade to
 * the built-ins with a warning, not take the page down. Returns
 * { lists, error } where `error` is a human-readable reason or null.
 */
function readOverride() {
  try {
    if (!fs.existsSync(OVERRIDE_FILE)) return { lists: {}, error: null };
    const parsed = JSON.parse(fs.readFileSync(OVERRIDE_FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { lists: {}, error: "override file is not a JSON object of { KEY: [symbols] }" };
    }
    const lists = {};
    for (const [key, val] of Object.entries(parsed)) {
      const list = cleanList(val);
      if (list) lists[String(key).trim().toUpperCase()] = list;
    }
    return { lists, error: null };
  } catch (err) {
    return { lists: {}, error: err.message };
  }
}

/**
 * Every preset available right now, built-ins merged with the override file.
 * Read on each call — the override is meant to be editable without a restart.
 *
 * @returns {{ universes: Array<{key,label,count,source}>, error: string|null }}
 */
function listUniverses() {
  const { lists, error } = readOverride();
  const out = [];
  for (const key of BUILTIN_ORDER) {
    const overridden = lists[key];
    out.push({
      key,
      label:  BUILTIN[key].label,
      count:  overridden ? overridden.length : BUILTIN[key].symbols.length,
      source: overridden ? "custom" : "builtin",
    });
  }
  // Extra presets the user invented in the override file.
  for (const key of Object.keys(lists)) {
    if (BUILTIN[key]) continue;
    out.push({ key, label: key, count: lists[key].length, source: "custom" });
  }
  return { universes: out, error };
}

/** Symbols for one preset key. Returns [] for an unknown key (never throws). */
function getUniverse(key) {
  const k = String(key || "").trim().toUpperCase();
  const { lists } = readOverride();
  if (lists[k]) return lists[k].slice();
  if (BUILTIN[k]) return BUILTIN[k].symbols.slice();
  return [];
}

/** "RELIANCE" → "NSE:RELIANCE-EQ" (Fyers history + quote form). */
function fyersSymbol(sym) {
  return `NSE:${String(sym).trim().toUpperCase()}-EQ`;
}

/** "RELIANCE" → { exchange:"NSE", tradingsymbol:"RELIANCE" } (Kite order form). */
function zerodhaSymbol(sym) {
  return { exchange: "NSE", tradingsymbol: String(sym).trim().toUpperCase() };
}

/** "NSE:RELIANCE-EQ" → "RELIANCE". Inverse of fyersSymbol, for display/lookup. */
function plainSymbol(fyersSym) {
  return String(fyersSym || "").replace(/^NSE:/, "").replace(/-EQ$/, "").toUpperCase();
}

module.exports = {
  listUniverses, getUniverse,
  fyersSymbol, zerodhaSymbol, plainSymbol,
  OVERRIDE_FILE,
  // exported for the regression suite
  BUILTIN, BUILTIN_ORDER, cleanList,
};

/**
 * mcxContracts.js — which MCX contracts to watch and trade (COMMODITY pages only)
 * ─────────────────────────────────────────────────────────────────────────────
 * The NSE instrument.js computes expiries from rules (last Tuesday etc.). MCX
 * does not follow those rules — crude options expire a few days BEFORE the
 * future they sit on (Oct-26 options: 15 Oct, Oct-26 future: 19 Oct) — so this
 * file does not compute anything. It reads Fyers' own symbol master
 * (public.fyers.in/sym_details/MCX_COM.csv) and picks from what is listed:
 *
 *   option series  = the nearest option expiry AFTER today (never trade expiry day)
 *   signal source  = the future that series is written on (column 17 of the master)
 *   ATM strike     = the listed strike of that series nearest the future's price
 *
 * Kept deliberately separate from instrument.js: nothing here can change how a
 * NIFTY / BANKNIFTY symbol is built.
 *
 * Master CSV columns used (0-based): 1 description · 3 min lot · 8 expiry (unix
 * sec) · 9 symbol · 12 scrip code · 13 underlying · 14 underlying scrip code ·
 * 15 strike · 16 CE/PE/XX.
 */

const fs    = require("fs");
const path  = require("path");
const os    = require("os");
const https = require("https");

const MASTER_URL = "https://public.fyers.in/sym_details/MCX_COM.csv";
const CACHE_DIR  = path.join(os.homedir(), "trading-data", "cmx");
const CACHE_FILE = path.join(CACHE_DIR, "MCX_COM.csv");

// Units per 1 lot, in the unit the price is quoted in. The master's "lot"
// column is 1 (MCX quotes in lots), so P&L per lot = premium move × multiplier.
//   crude: price per barrel · gold: price per 10 g · silver: price per kg
const UNDERLYINGS = {
  CRUDEOIL:  { label: "Crude Oil",      multiplier: 100, unit: "100 barrels" },
  CRUDEOILM: { label: "Crude Oil Mini", multiplier: 10,  unit: "10 barrels"  },
  GOLD:      { label: "Gold",           multiplier: 100, unit: "1 kg"        },
  GOLDM:     { label: "Gold Mini",      multiplier: 10,  unit: "100 g"       },
  SILVER:    { label: "Silver",         multiplier: 30,  unit: "30 kg"       },
  SILVERM:   { label: "Silver Mini",    multiplier: 5,   unit: "5 kg"        },
};

// Each commodity menu trades one contract size, picked in Settings.
const COMMODITIES = {
  CRUDE:  { label: "Crude Oil", envKey: "CMX_CRUDE_CONTRACT",  choices: ["CRUDEOIL", "CRUDEOILM"], def: "CRUDEOIL" },
  GOLD:   { label: "Gold",      envKey: "CMX_GOLD_CONTRACT",   choices: ["GOLDM", "GOLD"],         def: "GOLDM"    },
  SILVER: { label: "Silver",    envKey: "CMX_SILVER_CONTRACT", choices: ["SILVERM", "SILVER"],     def: "SILVERM"  },
};

/** The contract (e.g. "GOLDM") a commodity menu trades right now. */
function contractFor(commodity) {
  const C = COMMODITIES[commodity];
  const k = String(process.env[C.envKey] || C.def).trim().toUpperCase();
  return C.choices.includes(k) ? k : C.def;
}
function underlyingInfo(key) { return { key, ...UNDERLYINGS[key] }; }

function _istDateStr(ms) {
  return new Date(ms + 19800000).toISOString().slice(0, 10);
}

function _download() {
  return new Promise((resolve, reject) => {
    const req = https.get(MASTER_URL, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`symbol master HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("timeout", () => req.destroy(new Error("symbol master download timed out")));
    req.on("error", reject);
  });
}

let _rowsCache = null;   // { day, rows }

/** Parsed crude rows from the master — downloaded at most once per IST day. */
async function _rows() {
  const today = _istDateStr(Date.now());
  if (_rowsCache && _rowsCache.day === today) return _rowsCache.rows;

  let text = null;
  try {
    const st = fs.statSync(CACHE_FILE);
    if (_istDateStr(st.mtimeMs) === today) text = fs.readFileSync(CACHE_FILE, "utf-8");
  } catch (_) {}
  if (!text) {
    try {
      text = await _download();
      try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, text); } catch (_) {}
    } catch (err) {
      // Yesterday's copy still lists this month's contracts — better than nothing.
      try { text = fs.readFileSync(CACHE_FILE, "utf-8"); } catch (_) { throw err; }
    }
  }

  const rows = [];
  for (const line of text.split("\n")) {
    const c = line.split(",");
    if (c.length < 18) continue;
    const und = c[13];
    if (!UNDERLYINGS[und]) continue;
    rows.push({
      symbol:   c[9],
      und,
      expiry:   parseInt(c[8], 10),            // unix sec
      strike:   parseFloat(c[15]),
      type:     c[16],                        // CE | PE | XX (future)
      scrip:    c[12],                        // exchange scrip code
      undScrip: c[14],                        // option → its future's scrip code
    });
  }
  _rowsCache = { day: today, rows };
  return rows;
}

/**
 * The contract set for today for underlying `U` (e.g. "CRUDEOIL"): the nearest
 * option series expiring AFTER today and the future it is written on. Returns
 * { underlying, future, futureExpiry, optionExpiry, series } or throws with a
 * plain reason.
 */
async function resolveSeries(U) {
  if (!UNDERLYINGS[U]) throw new Error(`unknown MCX contract ${U}`);
  const rows = (await _rows()).filter((r) => r.und === U);
  const today = _istDateStr(Date.now());

  const opts = rows.filter((r) => (r.type === "CE" || r.type === "PE") && _istDateStr(r.expiry * 1000) > today);
  if (!opts.length) throw new Error(`no ${U} options listed after today in the Fyers symbol master`);
  const expiry = Math.min(...opts.map((r) => r.expiry));
  const series = opts.filter((r) => r.expiry === expiry);

  // The future this series is written on — matched by token, not by guessing a name.
  const fut = rows.find((r) => r.type === "XX" && r.scrip === series[0].undScrip)
           || rows.filter((r) => r.type === "XX" && r.expiry >= expiry).sort((a, b) => a.expiry - b.expiry)[0];
  if (!fut) throw new Error(`could not find the ${U} future behind the ${_istDateStr(expiry * 1000)} options`);

  return {
    underlying:        U,
    future:            fut.symbol,
    futureExpiry:      _istDateStr(fut.expiry * 1000),
    optionExpiry:      _istDateStr(expiry * 1000),
    series,
  };
}

/** The listed option of `side` whose strike is nearest `price` in this series. */
function atmOption(seriesInfo, side, price) {
  const list = seriesInfo.series.filter((r) => r.type === side);
  if (!list.length || !Number.isFinite(price)) return null;
  let best = list[0];
  for (const r of list) if (Math.abs(r.strike - price) < Math.abs(best.strike - price)) best = r;
  return { symbol: best.symbol, strike: best.strike, expiry: seriesInfo.optionExpiry };
}

module.exports = { COMMODITIES, UNDERLYINGS, contractFor, underlyingInfo, resolveSeries, atmOption };

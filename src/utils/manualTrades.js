/**
 * manualTrades.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Storage + ingestion for the user's own manual Kite and Fyers trading (equity +
 * F&O), as opposed to the bot's own strategy trades. Two ingestion paths feed the
 * same store, because Kite Connect has no historical order/trade endpoint —
 * /orders and /trades are transient, today-only (confirmed against the official
 * docs: "the order history or the order book ... only lives for a day in the
 * system"), and Fyers' tradebook is the same.
 *
 *   1. CSV import  — one-time backfill from a broker tradebook export (Kite
 *                     Console → Reports → Tradebook, or Fyers). Covers all past
 *                     years, Equity + F&O, in one file per segment or combined.
 *   2. Broker sync — going forward only. Pulls today's executed fills via each
 *                     broker's getTrades(), adds new ones and updates any already
 *                     stored in place (matched by dedupKey).
 *
 * Both paths write raw FILLS (one row per execution), not round-trip trades —
 * Kite's tradebook is fill-level, so a position built from 3 partial exits is
 * 3 rows. Round-trips (entry+exit pairs) are derived at read time by FIFO
 * matching per symbol, since that's the only way to get win/loss per trade
 * out of raw fills without guessing which broker "order" they belonged to.
 *
 * Store: ~/trading-data/manual_trades.json — { fills: [...], meta: { lastSyncedTradeDate, lastFyersSyncedAt, importedFiles: [...] } }
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(require("os").homedir(), "trading-data");
const STORE_FILE = path.join(DATA_DIR, "manual_trades.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore() {
  const empty = () => ({ fills: [], meta: { lastSyncedTradeDate: null, importedFiles: [] } });
  if (!fs.existsSync(STORE_FILE)) return empty();
  // A failed read (permissions etc.) throws: the file may be fine, and returning
  // an empty store here would let the next save erase the whole history.
  const text = fs.readFileSync(STORE_FILE, "utf-8");
  try {
    const data = JSON.parse(text);
    return {
      fills: Array.isArray(data.fills) ? data.fills : [],
      meta: data.meta || empty().meta,
    };
  } catch (err) {
    // Damaged file: move it aside so the next save can't overwrite it.
    const backup = `${STORE_FILE}.corrupt-${Date.now()}`;
    fs.renameSync(STORE_FILE, backup);
    console.error(`[ManualTrades] store damaged (${err.message}) — moved to ${backup}`);
    return empty();
  }
}

function saveStore(store) {
  ensureDir();
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  fs.renameSync(tmp, STORE_FILE);
}

// ── Segment classification ──────────────────────────────────────────────────
// Kite tradebook `segment` column ("EQ" vs "FO") is checked FIRST and is
// authoritative when present — symbol-suffix matching alone is unsafe (equity
// names like RELIANCE end in the letters "CE" and would misclassify as a Call
// Option). Suffix matching is only a fallback for raw Kite API rows that carry
// no clean segment string, and even then it's gated on the segment NOT already
// having marked the row as equity.
function classifySegment(row) {
  const seg = String(row.segment || "").toUpperCase();
  const exch = String(row.exchange || "").toUpperCase();
  const sym = String(row.symbol || row.tradingsymbol || "").toUpperCase();

  if (seg === "EQ" || (!seg && (exch === "NSE" || exch === "BSE"))) return "equity";
  if (seg.includes("FO") || seg.includes("NFO") || exch === "NFO") {
    if (sym.endsWith("FUT")) return "futures";
    if (sym.endsWith("CE") || sym.endsWith("PE")) return "options";
    return "options"; // F&O segment but suffix unclear — default bucket
  }
  // No segment/exchange to go on at all — fall back to suffix matching.
  if (sym.endsWith("FUT")) return "futures";
  if (sym.endsWith("CE") || sym.endsWith("PE")) return "options";
  return "equity";
}

// ── CSV import (Kite Console / Fyers tradebook export) ──────────────────────
// Kite Console columns: symbol, isin, trade_date, exchange, segment,
// series, trade_type, auction, quantity, price, trade_id, order_id, order_execution_time
//
// Fyers "Tradebook report" export is a different shape: 6 metadata rows
// ("Report Title", "Date Range", ...) then a blank line, THEN the real
// header: Name, Date & time, Side, Product type, Qty, Traded price, Total
// value, Segment, Exchange order ID, OMS order ID. We find that header row
// by looking for one containing "Name" + "Side" (rather than assuming a
// fixed row count, since Fyers has changed the metadata block before) and
// map its columns onto the same internal row shape Kite rows produce.
// NOTE: deliberately NOT mapping "OMS order ID" -> trade_id. Unlike Kite's
// trade_id (unique per fill), Fyers's OMS order ID is shared across multiple
// fill legs of the same order (e.g. a large order split into two legs by
// exchange freeze-quantity rules) — using it as the dedup key would collapse
// distinct fills into one and silently drop real trades. Leaving trade_id
// unset makes dedupKey() fall back to its composite key instead, which
// includes qty/price/executedAt and so keys each leg separately.
const FYERS_HEADER_MAP = {
  name: "symbol",
  symbol_name: "symbol", // newer exports call the "Name" column "Symbol name"
  "date_&_time": "trade_date",
  side: "trade_type",
  qty: "quantity",
  traded_price: "price",
  "exchange_order_id": "order_id",
};

function findHeaderRowIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    // Spaces count as underscores: Kite's CSV says trade_type, its Excel "Trade Type".
    const cells = splitCsvLine(lines[i]).map((c) => c.trim().toLowerCase().replace(/\s+/g, "_"));
    if (cells.includes("symbol") && cells.includes("trade_type")) return i;
    if ((cells.includes("name") || cells.includes("symbol_name")) && cells.includes("side")) return i;
  }
  return 0;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headerIdx = findHeaderRowIndex(lines);
  const rawHeaders = splitCsvLine(lines[headerIdx]).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const isFyers = (rawHeaders.includes("name") || rawHeaders.includes("symbol_name")) && rawHeaders.includes("side");
  const headers = isFyers ? rawHeaders.map((h) => FYERS_HEADER_MAP[h] || h) : rawHeaders;
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = (cells[idx] || "").trim(); });
    if (isFyers) normalizeFyersRow(row);
    if (headers.includes("symbol") && !row.symbol) continue; // empty or footer row
    rows.push(row);
  }
  return rows;
}

// Fyers-specific field cleanup so the row matches Kite's conventions before
// it hits normalizeCsvRow(): "20 Mar 2026, 02:06:41 PM" trade_date, a
// "16,165.50"-style thousands separator on price/qty, and order IDs wrapped
// in an Excel-safe ="..." formula string.
function normalizeFyersRow(row) {
  if (row.quantity) row.quantity = row.quantity.replace(/,/g, "");
  if (row.price) row.price = row.price.replace(/,/g, "");
  if (row.order_id) row.order_id = row.order_id.replace(/^="?|"?$/g, "");
  // "20 Mar 2026, 02:06:41 PM" -> ISO "2026-03-20T14:06:41" so downstream
  // FIFO sort (new Date(...)) and .slice(0, 10) date-prefix reads (which
  // assume Kite's ISO-ish trade_date) both work the same as for Kite rows.
  if (row.trade_date) {
    const m = row.trade_date.match(/^(\d{1,2}) (\w{3}) (\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
    if (m) {
      const [, d, mon, y, hh, mm, ss, ap] = m;
      const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
      const month = months[mon.toLowerCase()];
      let h = Number(hh) % 12;
      if (ap.toUpperCase() === "PM") h += 12;
      // Built as text, not through a Date, so the server timezone can't shift it.
      const p = (n) => String(n).padStart(2, "0");
      if (month) row.trade_date = `${y}-${p(month)}-${p(d)}T${p(h)}:${mm}:${ss}`;
    }
  }
  // Fyers tradebook has no exchange column; "Segment" is "Derivatives" or
  // "Capital Market" — map onto the exchange/segment pair classifySegment()
  // already understands from Kite (NFO+FO vs NSE+EQ).
  const fyersSeg = String(row.segment || "").toUpperCase();
  if (fyersSeg.includes("DERIVATIVE")) { row.exchange = "NFO"; row.segment = "FO"; }
  else { row.exchange = "NSE"; row.segment = "EQ"; }
}

// Minimal CSV line splitter handling quoted fields with embedded commas.
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ",") { out.push(cur); cur = ""; }
    else { cur += c; }
  }
  out.push(cur);
  return out;
}

function normalizeCsvRow(row, sourceFile, broker) {
  const qty = Number(String(row.quantity).replace(/,/g, "")) || 0;
  const price = Number(String(row.price).replace(/,/g, "")) || 0;
  const type = String(row.trade_type || "").toLowerCase(); // "buy" | "sell"
  return {
    id: row.trade_id ? `csv_${row.trade_id}` : `csv_${sourceFile}_${row.order_execution_time || row.trade_date}_${row.symbol}_${row.order_id || ""}_${Math.random().toString(36).slice(2, 8)}`,
    source: "csv",
    broker,
    symbol: row.symbol || "",
    exchange: row.exchange || "",
    segment: classifySegment(row),
    side: type === "sell" ? "sell" : "buy",
    qty,
    price,
    tradeDate: row.trade_date || null,
    executedAt: row.order_execution_time || row.trade_date || null,
    orderId: row.order_id || null,
    tradeId: row.trade_id || null,
    importedAt: new Date().toISOString(),
    importedFrom: sourceFile,
  };
}

/** Import a Kite Console (or Fyers) tradebook CSV. Matches by tradeId (or a
 *  stable composite key when trade_id is absent) so re-importing the same
 *  file, or an overlapping date range across two exports, REPLACES the
 *  existing row in place instead of piling up a duplicate — the latest
 *  import always wins for a given fill. `broker` scopes matching/analytics
 *  per broker tab. */
function importCsv(csvText, sourceFile = "upload.csv", broker = "kite") {
  const rows = parseCsv(csvText);
  const whereToGet = broker === "fyers" ? "Fyers → Reports → Trade Book" : "Kite Console → Reports → Tradebook";
  if (rows.length === 0) return { imported: 0, updated: 0, total: 0, error: `No trades found in this file. Download it from ${whereToGet}.` };

  const required = ["symbol", "trade_date", "trade_type", "quantity", "price"];
  const headers = Object.keys(rows[0]);
  const missing = required.filter((r) => !headers.includes(r));
  if (missing.length > 0) {
    return { imported: 0, updated: 0, total: 0, error: `This is not a tradebook file (missing ${missing.join(", ")}). Download it from ${whereToGet}.` };
  }

  const store = loadStore();
  const { imported, updated } = upsertFills(store, rows.map((row) => normalizeCsvRow(row, sourceFile, broker)));

  if (!store.meta.importedFiles.includes(sourceFile)) store.meta.importedFiles.push(sourceFile);
  saveStore(store);
  return { imported, updated, total: store.fills.length };
}

// `seq` disambiguates rows that are otherwise byte-identical (same symbol/
// side/qty/price/timestamp/orderId) — e.g. Fyers splits one order into two
// same-priced legs when exchange freeze-quantity rules apply, and the
// tradebook export carries no per-fill ID to tell them apart. Passing the
// occurrence-count-so-far (not a random suffix) keeps the key stable across
// re-imports of the identical file, so re-import still updates in place
// instead of appending a fresh duplicate each time.
function dedupKey(fill, seq = 0) {
  const b = fill.broker || "kite";
  // Symbol and date go with the trade ID so a reused ID can't overwrite another
  // trade: upsertFills replaces a matching row rather than skipping it.
  if (fill.tradeId) return `${b}_tid_${fill.tradeId}_${fill.symbol}_${String(fill.tradeDate || "").slice(0, 10)}`;
  const base = `${b}_k_${fill.symbol}_${fill.side}_${fill.qty}_${fill.price}_${fill.executedAt}_${fill.orderId || ""}`;
  return seq > 0 ? `${base}_${seq}` : base;
}

// Adds new fills to store.fills and replaces already-stored ones in place — a
// re-import or re-sync of a fill always updates it, never piles up a duplicate.
function upsertFills(store, fills) {
  // Build the existing-fill lookup with the SAME seq-per-base-key counting
  // the loop below uses, walking store.fills in array (= original import)
  // order — otherwise a fill that was stored under `${base}_1` (a same-priced
  // split-leg duplicate) has no way to be found again, and would append as a
  // fresh duplicate instead of updating.
  const indexByKey = new Map();
  const existingSeqByBaseKey = new Map();
  store.fills.forEach((f, i) => {
    const baseKey = dedupKey(f);
    const seq = existingSeqByBaseKey.get(baseKey) || 0;
    existingSeqByBaseKey.set(baseKey, seq + 1);
    indexByKey.set(dedupKey(f, seq), i);
  });

  let imported = 0, updated = 0;
  const seqByBaseKey = new Map(); // occurrence count within THIS batch, per base key
  for (const fill of fills) {
    const baseKey = dedupKey(fill);
    const seq = seqByBaseKey.get(baseKey) || 0;
    seqByBaseKey.set(baseKey, seq + 1);
    const key = dedupKey(fill, seq);
    const existingIdx = indexByKey.get(key);
    if (existingIdx !== undefined) {
      store.fills[existingIdx] = fill;
      updated++;
    } else {
      indexByKey.set(key, store.fills.length);
      store.fills.push(fill);
      imported++;
    }
  }
  return { imported, updated };
}

// ── Broker live sync (today's fills, going forward only) ───────────────────

// The Kite SDK turns timestamps into Date objects by parsing Kite's IST string
// in the server's own timezone, so the LOCAL getters give back exactly the time
// Kite sent, whatever timezone the server runs in. Output matches the wall-clock
// format of CSV-imported fills.
function kiteTimeToIso(v) {
  if (!v) return null;
  if (!(v instanceof Date)) return String(v).slice(0, 19).replace(" ", "T");
  if (isNaN(v)) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}T${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
}

function normalizeKiteFill(t) {
  const executedAt = kiteTimeToIso(t.fill_timestamp || t.exchange_timestamp);
  return {
    id: `kite_${t.trade_id || t.order_id}_${kiteTimeToIso(t.exchange_timestamp || t.fill_timestamp) || ""}`,
    source: "kite_sync",
    broker: "kite",
    symbol: t.tradingsymbol || "",
    exchange: t.exchange || "",
    segment: classifySegment(t),
    side: String(t.transaction_type || "").toLowerCase() === "sell" ? "sell" : "buy",
    qty: Number(t.quantity) || 0,
    price: Number(t.average_price || t.price) || 0,
    tradeDate: executedAt ? executedAt.slice(0, 10) : null,
    executedAt,
    orderId: t.order_id || null,
    tradeId: t.trade_id || null,
    importedAt: new Date().toISOString(),
    importedFrom: "kite_sync",
  };
}

/** Pull today's fills from Kite, adding new ones and updating stored ones. Safe
 *  to call repeatedly (idempotent via upsertFills) — used by both the manual
 *  "Sync Now" button and the daily auto-sync job. */
async function syncFromKite() {
  const zerodhaBroker = require("../services/zerodhaBroker");
  if (!zerodhaBroker.isAuthenticated()) {
    return { imported: 0, updated: 0, total: 0, error: "Not logged in to Zerodha — visit Token Sync to authenticate." };
  }
  let trades;
  try {
    trades = await zerodhaBroker.getTrades();
  } catch (err) {
    return { imported: 0, updated: 0, total: 0, error: `Kite tradebook failed: ${(err && err.message) || "unknown error"}` };
  }
  if (!Array.isArray(trades)) return { imported: 0, updated: 0, total: 0, error: "Kite returned no data." };

  // Same rule as syncFromFyers: a fill with no date would replace a good row and
  // then vanish from buildRoundTrips, so save nothing.
  const fills = trades.map((t) => normalizeKiteFill(t));
  const undated = fills.find((f) => !f.tradeDate);
  if (undated) return { imported: 0, updated: 0, total: 0, error: `Kite sent trade ${undated.tradeId || undated.orderId} with no time. Nothing was saved.` };

  const store = loadStore();
  const { imported, updated } = upsertFills(store, fills);

  store.meta.lastSyncedTradeDate = new Date().toISOString();
  saveStore(store);
  return { imported, updated, total: store.fills.length };
}

// Fyers sends trade times as an IST string. Its docs say "DD-MM-YYYY hh:mm:ss"
// but their own sample is "07-Aug-2020 13:51:12", so both are accepted. Returns
// null for anything else. No Date involved, so the server timezone can't shift it.
const FYERS_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function fyersTimeToIso(v) {
  const m = String(v == null ? "" : v).trim().match(/^(\d{1,2})-(\d{1,2}|[A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mon, y, hh, mm, ss] = m;
  const month = /^\d/.test(mon) ? Number(mon) : FYERS_MONTHS.indexOf(mon.toLowerCase()) + 1;
  if (month < 1 || month > 12 || Number(d) < 1 || Number(d) > 31 || Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(month)}-${p(d)}T${p(hh)}:${mm}:${ss}`;
}

const FYERS_EXCHANGES = { 10: "NSE", 11: "MCX", 12: "BSE" };

// tradeId stays null on purpose, and orderId is the exchange order number: that
// makes dedupKey() build the same composite key as a CSV-imported Fyers row, so a
// fill that arrives both ways stays one fill (see the NOTE above FYERS_HEADER_MAP).
function normalizeFyersFill(t, executedAt) {
  const symbol = String(t.symbol || "").replace(/^[A-Z]+:/, "");
  const exchange = FYERS_EXCHANGES[Number(t.exchange)] || "";
  return {
    id: `fyers_${t.tradeNumber || t.orderNumber}_${executedAt}`,
    source: "fyers_sync",
    broker: "fyers",
    symbol,
    exchange,
    segment: classifySegment({ symbol, exchange, segment: Number(t.segment) === 10 ? "EQ" : "FO" }),
    side: Number(t.side) === -1 ? "sell" : "buy",
    qty: Number(t.tradedQty) || 0,
    price: Number(t.tradePrice) || 0,
    tradeDate: executedAt.slice(0, 10),
    executedAt,
    orderId: t.exchangeOrderNo || null,
    tradeId: null,
    importedAt: new Date().toISOString(),
    importedFrom: "fyers_sync",
  };
}

/** Pull today's fills from Fyers, adding new ones and updating stored ones. Same
 *  contract as syncFromKite. Saves nothing if any trade time can't be read — a
 *  fill with no date would silently vanish from buildRoundTrips. */
async function syncFromFyers() {
  const fail = (error) => ({ imported: 0, updated: 0, total: 0, error });
  const fyersBroker = require("../services/fyersBroker");
  if (!fyersBroker.isAuthenticated()) return fail("Not logged in to Fyers — log in to Fyers first.");

  let trades;
  try {
    trades = await fyersBroker.getTrades();
  } catch (err) {
    return fail(`Fyers tradebook failed: ${(err && err.message) || "unknown error"}`);
  }

  const fills = [];
  for (const t of trades) {
    const executedAt = fyersTimeToIso(t.orderDateTime);
    if (!executedAt) return fail(`Fyers sent a trade time we can't read: "${t.orderDateTime}". Nothing was saved.`);
    fills.push(normalizeFyersFill(t, executedAt));
  }

  const store = loadStore();
  const { imported, updated } = upsertFills(store, fills);

  store.meta.lastFyersSyncedAt = new Date().toISOString();
  saveStore(store);
  return { imported, updated, total: store.fills.length };
}

// ── Round-trip derivation (FIFO matching per symbol) ────────────────────────
// Kite gives fills, not trades. To get win/loss/mistake analytics we FIFO-match
// buy/sell fills per symbol into round-trips. This mirrors how any broker P&L
// report derives realised trades from an execution log.
function buildRoundTrips(fills) {
  // Grouped by [broker, symbol] pairs, not a joined string key — a CSV-imported
  // symbol containing the literal join separator would otherwise split back
  // into the wrong pieces and silently corrupt the displayed symbol name.
  const byBroker = new Map();
  for (const f of fills) {
    if (!f.tradeDate || !f.symbol) continue;
    const broker = f.broker || "kite";
    if (!byBroker.has(broker)) byBroker.set(broker, new Map());
    const bySymbol = byBroker.get(broker);
    if (!bySymbol.has(f.symbol)) bySymbol.set(f.symbol, []);
    bySymbol.get(f.symbol).push(f);
  }

  const trips = [];
  for (const [broker, bySymbol] of byBroker.entries()) {
    for (const [symbol, list] of bySymbol.entries()) {
      list.sort((a, b) => new Date(a.executedAt || a.tradeDate) - new Date(b.executedAt || b.tradeDate));
      const longQueue = [];  // open buy lots (for long trips, closed by sells)
      const shortQueue = []; // open sell lots (for short trips, closed by buys)
      let positionNo = 0;    // +1 each time this symbol goes from flat to open

      for (const f of list) {
        let remaining = f.qty;
        if (f.side === "buy") {
          // First close any open shorts (FIFO), then whatever's left opens a long lot.
          while (remaining > 0 && shortQueue.length > 0) {
            const lot = shortQueue[0];
            const matched = Math.min(remaining, lot.qty);
            trips.push(makeTrip(symbol, broker, f.segment, lot, f, matched, "short"));
            lot.qty -= matched;
            remaining -= matched;
            if (lot.qty <= 0) shortQueue.shift();
          }
          if (remaining > 0) {
            if (longQueue.length === 0) positionNo++;
            longQueue.push({ ...f, qty: remaining, positionNo });
          }
        } else {
          while (remaining > 0 && longQueue.length > 0) {
            const lot = longQueue[0];
            const matched = Math.min(remaining, lot.qty);
            trips.push(makeTrip(symbol, broker, f.segment, lot, f, matched, "long"));
            lot.qty -= matched;
            remaining -= matched;
            if (lot.qty <= 0) longQueue.shift();
          }
          if (remaining > 0) {
            if (shortQueue.length === 0) positionNo++;
            shortQueue.push({ ...f, qty: remaining, positionNo });
          }
        }
      }
    }
  }

  return trips.sort((a, b) => new Date(a.exitAt) - new Date(b.exitAt));
}

function makeTrip(symbol, broker, segment, openFill, closeFill, qty, direction) {
  // Entry is always the opening fill: a short opens with its sell, so it profits
  // when the closing buy is cheaper.
  const entryPrice = openFill.price;
  const exitPrice = closeFill.price;
  const pnl = direction === "long" ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
  return {
    symbol,
    broker,
    segment,
    direction,
    positionNo: openFill.positionNo,
    qty,
    entryPrice,
    exitPrice,
    pnl: Math.round(pnl * 100) / 100,
    entryAt: openFill.executedAt || openFill.tradeDate,
    exitAt: closeFill.executedAt || closeFill.tradeDate,
    entryDate: (openFill.executedAt || openFill.tradeDate || "").slice(0, 10),
    exitDate: (closeFill.executedAt || closeFill.tradeDate || "").slice(0, 10),
  };
}

module.exports = {
  loadStore, saveStore, importCsv, syncFromKite, syncFromFyers, buildRoundTrips, classifySegment,
  STORE_FILE,
};

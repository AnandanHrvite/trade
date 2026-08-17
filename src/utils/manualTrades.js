/**
 * manualTrades.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Storage + ingestion for the user's own manual Zerodha trading (equity + F&O),
 * as opposed to the bot's own strategy trades. Two ingestion paths feed the same
 * store, because Kite Connect has no historical order/trade endpoint — /orders
 * and /trades are transient, today-only (confirmed against the official docs:
 * "the order history or the order book ... only lives for a day in the system").
 *
 *   1. CSV import  — one-time backfill from Kite Console → Reports → Tradebook.
 *                     Covers all past years, Equity + F&O, in one file per segment
 *                     or combined.
 *   2. Kite sync   — going forward only. Pulls today's executed fills via
 *                     zerodhaBroker.getTrades() and appends any not already
 *                     stored (dedup by Kite's own trade_id).
 *
 * Both paths write raw FILLS (one row per execution), not round-trip trades —
 * Kite's tradebook is fill-level, so a position built from 3 partial exits is
 * 3 rows. Round-trips (entry+exit pairs) are derived at read time by FIFO
 * matching per symbol, since that's the only way to get win/loss per trade
 * out of raw fills without guessing which broker "order" they belonged to.
 *
 * Store: ~/trading-data/manual_trades.json — { fills: [...], meta: { lastSyncedTradeDate, importedFiles: [...] } }
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
  try {
    if (!fs.existsSync(STORE_FILE)) return { fills: [], meta: { lastSyncedTradeDate: null, importedFiles: [] } };
    const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
    return {
      fills: Array.isArray(data.fills) ? data.fills : [],
      meta: data.meta || { lastSyncedTradeDate: null, importedFiles: [] },
    };
  } catch (_) {
    return { fills: [], meta: { lastSyncedTradeDate: null, importedFiles: [] } };
  }
}

function saveStore(store) {
  ensureDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf-8");
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
const FYERS_HEADER_MAP = {
  name: "symbol",
  "date_&_time": "trade_date",
  side: "trade_type",
  qty: "quantity",
  traded_price: "price",
  "exchange_order_id": "order_id",
  "oms_order_id": "trade_id",
};

function findHeaderRowIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]).map((c) => c.trim().toLowerCase());
    if (cells.includes("symbol") && cells.includes("trade_type")) return i;
    if (cells.includes("name") && cells.includes("side")) return i;
  }
  return 0;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headerIdx = findHeaderRowIndex(lines);
  const rawHeaders = splitCsvLine(lines[headerIdx]).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const isFyers = rawHeaders.includes("name") && rawHeaders.includes("side");
  const headers = isFyers ? rawHeaders.map((h) => FYERS_HEADER_MAP[h] || h) : rawHeaders;
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = (cells[idx] || "").trim(); });
    if (isFyers) normalizeFyersRow(row);
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
  if (row.trade_id) row.trade_id = row.trade_id.replace(/^="?|"?$/g, "");
  // "20 Mar 2026, 02:06:41 PM" -> ISO "2026-03-20T14:06:41" so downstream
  // FIFO sort (new Date(...)) and .slice(0, 10) date-prefix reads (which
  // assume Kite's ISO-ish trade_date) both work the same as for Kite rows.
  if (row.trade_date) {
    const m = row.trade_date.match(/^(\d{1,2}) (\w{3}) (\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
    if (m) {
      const [, d, mon, y, hh, mm, ss, ap] = m;
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      let h = Number(hh) % 12;
      if (ap.toUpperCase() === "PM") h += 12;
      const dt = new Date(Number(y), months[mon.toLowerCase()], Number(d), h, Number(mm), Number(ss));
      if (!isNaN(dt)) row.trade_date = dt.toISOString().slice(0, 19);
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
  const qty = Number(row.quantity) || 0;
  const price = Number(row.price) || 0;
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
  if (rows.length === 0) return { imported: 0, updated: 0, total: 0, error: "No data rows found in CSV." };

  const required = ["symbol", "trade_date", "trade_type", "quantity", "price"];
  const headers = Object.keys(rows[0]);
  const missing = required.filter((r) => !headers.includes(r));
  if (missing.length > 0) {
    return { imported: 0, updated: 0, total: 0, error: `CSV missing expected column(s): ${missing.join(", ")}. Export from Kite Console → Reports → Tradebook.` };
  }

  const store = loadStore();
  const indexByKey = new Map(store.fills.map((f, i) => [dedupKey(f), i]));

  let imported = 0, updated = 0;
  for (const row of rows) {
    const fill = normalizeCsvRow(row, sourceFile, broker);
    const key = dedupKey(fill);
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

  if (!store.meta.importedFiles.includes(sourceFile)) store.meta.importedFiles.push(sourceFile);
  saveStore(store);
  return { imported, updated, total: store.fills.length };
}

function dedupKey(fill) {
  const b = fill.broker || "kite";
  if (fill.tradeId) return `${b}_tid_${fill.tradeId}`;
  return `${b}_k_${fill.symbol}_${fill.side}_${fill.qty}_${fill.price}_${fill.executedAt}`;
}

// ── Kite live sync (today's fills, going forward only) ─────────────────────

function normalizeKiteFill(t) {
  return {
    id: `kite_${t.trade_id || t.order_id}_${t.exchange_timestamp || t.fill_timestamp || ""}`,
    source: "kite_sync",
    broker: "kite",
    symbol: t.tradingsymbol || "",
    exchange: t.exchange || "",
    segment: classifySegment(t),
    side: String(t.transaction_type || "").toLowerCase() === "sell" ? "sell" : "buy",
    qty: Number(t.quantity) || 0,
    price: Number(t.average_price || t.price) || 0,
    tradeDate: (t.fill_timestamp || t.exchange_timestamp || "").slice(0, 10) || null,
    executedAt: t.fill_timestamp || t.exchange_timestamp || null,
    orderId: t.order_id || null,
    tradeId: t.trade_id || null,
    importedAt: new Date().toISOString(),
    importedFrom: "kite_sync",
  };
}

/** Pull today's fills from Kite and append any new ones. Safe to call
 *  repeatedly (idempotent via dedup) — used by both the manual "Sync Now"
 *  button and the daily auto-sync job. */
async function syncFromKite() {
  const zerodhaBroker = require("../services/zerodhaBroker");
  if (!zerodhaBroker.isAuthenticated()) {
    return { imported: 0, skipped: 0, total: 0, error: "Not logged in to Zerodha — visit Token Sync to authenticate." };
  }
  const trades = await zerodhaBroker.getTrades();
  if (!Array.isArray(trades)) return { imported: 0, skipped: 0, total: 0, error: "Kite returned no data." };

  const store = loadStore();
  const existingKeys = new Set(store.fills.map((f) => dedupKey(f)));

  let imported = 0, skipped = 0;
  for (const t of trades) {
    const fill = normalizeKiteFill(t);
    const key = dedupKey(fill);
    if (existingKeys.has(key)) { skipped++; continue; }
    existingKeys.add(key);
    store.fills.push(fill);
    imported++;
  }

  store.meta.lastSyncedTradeDate = new Date().toISOString();
  saveStore(store);
  return { imported, skipped, total: store.fills.length };
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
          if (remaining > 0) longQueue.push({ ...f, qty: remaining });
        } else {
          while (remaining > 0 && longQueue.length > 0) {
            const lot = longQueue[0];
            const matched = Math.min(remaining, lot.qty);
            trips.push(makeTrip(symbol, broker, f.segment, lot, f, matched, "long"));
            lot.qty -= matched;
            remaining -= matched;
            if (lot.qty <= 0) longQueue.shift();
          }
          if (remaining > 0) shortQueue.push({ ...f, qty: remaining });
        }
      }
    }
  }

  return trips.sort((a, b) => new Date(a.exitAt) - new Date(b.exitAt));
}

function makeTrip(symbol, broker, segment, openFill, closeFill, qty, direction) {
  const entryPrice = direction === "long" ? openFill.price : closeFill.price;
  const exitPrice = direction === "long" ? closeFill.price : openFill.price;
  const pnl = direction === "long" ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
  return {
    symbol,
    broker,
    segment,
    direction,
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
  loadStore, saveStore, importCsv, syncFromKite, buildRoundTrips, classifySegment,
  STORE_FILE,
};

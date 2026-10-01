/**
 * tradeSources.js — one read-only view over every strategy's trade records,
 * whatever market it trades and however it stores them. Used by the
 * /mcp-data route and by scripts/mcpTradeResults.js (local mode).
 *
 * Modes are DISCOVERED, never listed by hand, so a new strategy shows up here
 * with no edit to this file:
 *   • NIFTY / BANKNIFTY — every key in tradeLogger.DAILY_PREFIX_BY_MODE (a new
 *     strategy must register there to log trades at all). A `bn_` key is
 *     BANKNIFTY, anything else NIFTY.
 *   • COMMODITY — every ~/trading-data/cmx/<id>_paper_trades.json book the
 *     commodity engine (services/commodityPaper.js) writes. A book's id is
 *     cmx_<commodity>_<base strategy>, e.g. cmx_gold_ema_rsi_st_v2.
 *
 * Read-only: nothing here writes a file or touches a broker.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const tradeLogger = require("./tradeLogger");

const CMX_DIR = path.join(os.homedir(), "trading-data", "cmx");
const CMX_SUFFIX = "_paper_trades.json";

function marketOf(mode) {
  if (mode.startsWith("cmx_")) return "COMMODITY";
  if (mode.startsWith("bn_")) return "BANKNIFTY";
  return "NIFTY";
}

function cmxModes() {
  let names;
  try { names = fs.readdirSync(CMX_DIR); } catch (_) { return []; }
  return names
    .filter((n) => n.startsWith("cmx_") && n.endsWith(CMX_SUFFIX))
    .map((n) => n.slice(0, -CMX_SUFFIX.length));
}

/** Every known mode: [{ mode, market }], NIFTY/BANKNIFTY first, then commodity. */
function listModes() {
  return [...Object.keys(tradeLogger.DAILY_PREFIX_BY_MODE), ...cmxModes()]
    .map((mode) => ({ mode, market: marketOf(mode) }));
}

function isKnownMode(mode) {
  return listModes().some((m) => m.mode === mode);
}

function cmxBook(mode) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(CMX_DIR, mode + CMX_SUFFIX), "utf-8"));
    return (b && b.days) || {};
  } catch (_) { return {}; }
}

/** Dates that have records for a mode, newest first. */
function listDates(mode) {
  if (marketOf(mode) === "COMMODITY") {
    return Object.keys(cmxBook(mode)).sort((a, b) => b.localeCompare(a));
  }
  return tradeLogger.listDailyDates(mode).map((d) => d.date);
}

/**
 * Raw records for one mode+date. NIFTY/BANKNIFTY return the day's JSONL as-is
 * (trades + settings_snapshot lines). Commodity books carry trades only — no
 * settings snapshots are recorded for them.
 */
function readRecords(mode, date) {
  if (marketOf(mode) === "COMMODITY") {
    const day = cmxBook(mode)[date];
    return day && Array.isArray(day.trades) ? day.trades.map((t) => ({ mode, ...t })) : [];
  }
  return tradeLogger.readDailyTrades(mode, date);
}

module.exports = { listModes, isKnownMode, marketOf, listDates, readRecords };

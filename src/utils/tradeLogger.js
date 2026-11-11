/**
 * Crash-safe per-trade JSONL logger.
 *
 * Why: session summaries in *_paper_trades.json are only flushed at EOD / stop,
 * so a mid-session server crash loses every trade taken today. This logger
 * appends one JSON line per completed trade the moment it exits, to a
 * separate file. Append-only writes cannot corrupt earlier lines — at worst
 * the in-flight line is truncated, and any reader can skip a bad line.
 *
 * Files land in ~/trading-data/ alongside the existing JSON summaries.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { isNonTradingDay } = require("./nseHolidays");
const logTags = require("./logTags");
const tradeJournal = require("./tradeJournal");
const _HOME = require("os").homedir();
const DATA_DIR   = path.join(_HOME, "trading-data");
const TRADES_DIR = path.join(DATA_DIR, "trades");

// Mode key → file names, one row per registry entry (strategyRegistry ORDERS.logs
// keeps the historic key order — Object.keys(DAILY_PREFIX_BY_MODE) is the mode
// list tradeSources / the trade-results MCP report). File names are on disk:
// `${modeKey}_paper_trades_log.jsonl` (cumulative) and
// `${modeKey}_paper_trades_YYYY-MM-DD.jsonl` (per day, under trades/).
const _LOG_MODES = require("../config/strategyRegistry").inOrder("logs").map(s => s.modeKey);
const FILE_BY_MODE = Object.fromEntries(_LOG_MODES.map(m => [m, `${m}_paper_trades_log.jsonl`]));
const DAILY_PREFIX_BY_MODE = Object.fromEntries(_LOG_MODES.map(m => [m, `${m}_paper_trades_`]));

// One-time dir ensure at module load — keeps the hot-path append sync-free.
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
try { fs.mkdirSync(TRADES_DIR, { recursive: true }); } catch (_) {}

// A RUNNING (strategy, market) pair (config/pairs.js runnable — bn_ema_rsi_st_v2,
// sensex_ema_rsi_st_v2 …) logs under its own mode key with the same file names.
// Resolved lazily: the registry maps above stay exactly the registry's modes,
// and pairs.js (markets → instrument) is only loaded for a key they lack.
function _pairMode(mode) {
  try {
    const p = require("../config/pairs").byModeKey(mode);
    return p && p.runs && !p.home ? p.modeKey : null;
  } catch (_) { return null; }
}
/** Every logging mode: the registry's, then each running pair's. */
function modes() {
  let extra = [];
  try { extra = require("../config/pairs").runnable().map((p) => p.modeKey); } catch (_) {}
  return [...Object.keys(DAILY_PREFIX_BY_MODE), ...extra];
}

function filePathFor(mode) {
  const name = FILE_BY_MODE[mode] || (_pairMode(mode) ? `${mode}_paper_trades_log.jsonl` : null);
  if (!name) throw new Error(`tradeLogger: unknown mode "${mode}"`);
  return path.join(DATA_DIR, name);
}
function _dailyPrefix(mode) {
  return DAILY_PREFIX_BY_MODE[mode] || (_pairMode(mode) ? `${mode}_paper_trades_` : null);
}

// IST date string "YYYY-MM-DD" from unix ms (or now).
function istDateString(unixMs) {
  const t = typeof unixMs === "number" ? unixMs : Date.now();
  const ist = new Date(t + 19800000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() + 1;
  const d = ist.getUTCDate();
  return `${y}-${m < 10 ? "0" : ""}${m}-${d < 10 ? "0" : ""}${d}`;
}

function dailyFilePathFor(mode, dateStr) {
  const p = _dailyPrefix(mode);
  if (!p) throw new Error(`tradeLogger: unknown mode "${mode}"`);
  const ds = dateStr || istDateString();
  return path.join(TRADES_DIR, `${p}${ds}.jsonl`);
}

/**
 * List available daily trade-log dates for a mode, newest first.
 * Returns [{ date, size, mtimeMs }, ...]
 */
function listDailyDates(mode) {
  const pref = _dailyPrefix(mode);
  if (!pref) throw new Error(`tradeLogger: unknown mode "${mode}"`);
  let names;
  try { names = fs.readdirSync(TRADES_DIR); }
  catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.startsWith(pref) || !n.endsWith(".jsonl")) continue;
    const date = n.slice(pref.length, -".jsonl".length);
    try {
      const st = fs.statSync(path.join(TRADES_DIR, n));
      out.push({ date, size: st.size, mtimeMs: st.mtimeMs });
    } catch (_) {}
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

// Provider injected by routes/settings.js so tradeLogger can capture the
// current settings without owning the schema. fn(mode) -> { settings: {KEY:val,...} }.
let _snapshotProvider = null;
function setSettingsProvider(fn) {
  _snapshotProvider = typeof fn === "function" ? fn : null;
}

/** Current settings for a mode via the registered provider; null if none. */
function getSettingsSnapshot(mode) {
  return _snapshotProvider ? _snapshotProvider(mode) : null;
}

function _writeSnapshotLineSync(mode, dateStr, obj) {
  try {
    fs.appendFileSync(dailyFilePathFor(mode, dateStr), JSON.stringify(obj) + "\n");
  } catch (err) {
    console.warn(`[tradeLogger] snapshot append failed (mode=${mode}): ${err.message}`);
  }
}

// Called from appendTradeLog to seed the day's file with a settings snapshot
// the first time a trade is logged for that mode/date.
function _ensureDailyHeader(mode, ts) {
  if (!_snapshotProvider) return;
  const dateStr = istDateString(ts);
  const fp = dailyFilePathFor(mode, dateStr);
  try {
    const st = fs.statSync(fp);
    if (st.size > 0) return;
  } catch (err) {
    if (err.code !== "ENOENT") return;
  }
  let snap;
  try { snap = _snapshotProvider(mode); }
  catch (err) {
    console.warn(`[tradeLogger] snapshot provider failed (mode=${mode}): ${err.message}`);
    return;
  }
  if (!snap) return;
  _writeSnapshotLineSync(mode, dateStr, {
    type: "settings_snapshot",
    mode,
    capturedAt: new Date(ts).toISOString(),
    reason: "day_start",
    settings: snap.settings || snap,
  });
}

// Used by routes/settings.js after a successful save to append the new
// values to today's daily file, so settings changes during the session
// land in the same document as the trades they affected.
async function appendSettingsSnapshot(mode, snapshot, meta = {}) {
  const ts = Date.now();
  const dateStr = istDateString(ts);
  // Don't seed a daily trade-log file on non-trading days (weekend/holiday):
  // no trades are taken, so a settings save would otherwise create a phantom
  // dated JSONL with nothing but snapshot lines. The EC2 host runs in UTC, so a
  // bare `new Date()` named the PREVIOUS day between 00:00–05:30 IST; judge the
  // IST date instead (a local-midday Date carrying the IST Y-M-D).
  try {
    if (await isNonTradingDay(new Date(`${dateStr}T12:00:00`))) return;
  } catch (err) {
    console.warn(`[tradeLogger] non-trading-day check failed (mode=${mode}): ${err.message}`);
  }
  const settings = snapshot && typeof snapshot === "object"
    ? (snapshot.settings || snapshot)
    : {};
  _writeSnapshotLineSync(mode, dateStr, {
    type: "settings_snapshot",
    mode,
    capturedAt: new Date(ts).toISOString(),
    reason: meta.reason || "settings_save",
    ...(meta.changedKeys ? { changedKeys: meta.changedKeys } : {}),
    ...(meta.note ? { note: meta.note } : {}),
    settings,
  });
}

// The persisted line = the trade plus the labels every reader needs: market,
// strategy id, and the entry / exit signal reasons as explicit keys (null when
// a route did not supply one, so "no reason" is visible rather than a missing
// key). Built as a NEW object — the route's in-memory trade is never touched.
// `journal` (utils/tradeJournal, spread in by a hooked route) is written as its
// persisted record, and `tradeId` — the journal's id unless the trade names its
// own, null when neither exists — is the key post-exit records carry, so the
// consolidated page can join a trade to what the market did after it.
function _tradeRecord(mode, ts, trade) {
  const t = trade && typeof trade === "object" ? trade : {};
  const rec = { mode, loggedAt: new Date(ts).toISOString(), ...logTags.tagsFor(mode, t), ...t };
  rec.entryReason = t.entryReason != null ? t.entryReason : null;
  rec.exitReason  = t.exitReason  != null ? t.exitReason  : null;
  if (t.journal != null) {
    const j = tradeJournal.normalize(t.journal);
    if (j) rec.journal = j; else delete rec.journal;
  }
  rec.tradeId = t.tradeId != null ? t.tradeId : ((rec.journal && rec.journal.id) || null);
  return rec;
}

function appendTradeLog(mode, trade) {
  try {
    const ts = Date.now();
    _ensureDailyHeader(mode, ts);
    const rec = _tradeRecord(mode, ts, trade);
    const line = JSON.stringify(rec) + "\n";
    // Fire-and-forget async append. POSIX O_APPEND makes each short write
    // atomic, so concurrent exits cannot interleave lines.
    // Write to both the cumulative file (legacy, unchanged) and the daily file.
    fsp.appendFile(filePathFor(mode), line).catch(err => {
      console.warn(`[tradeLogger] append failed (mode=${mode}): ${err.message}`);
    });
    fsp.appendFile(dailyFilePathFor(mode, istDateString(ts)), line).catch(err => {
      console.warn(`[tradeLogger] daily append failed (mode=${mode}): ${err.message}`);
    });
    // Watch the market after this exit until that market's close (observer only).
    try { require("./postExitTracker").track(mode, trade, { market: rec.market, strategy: rec.strategy, tradeId: rec.tradeId }); } catch (_) {}
  } catch (err) {
    // Logging must never break the trade flow.
    console.warn(`[tradeLogger] append failed (mode=${mode}): ${err.message}`);
  }
}

/**
 * Read all trades from the daily JSONL for a given mode and IST date.
 * Returns an array of parsed trade objects (skipping any malformed lines).
 * Returns [] if the file does not exist or cannot be read.
 */
function readDailyTrades(mode, dateStr) {
  const fp = dailyFilePathFor(mode, dateStr);
  let text;
  try { text = fs.readFileSync(fp, "utf-8"); }
  catch (_) { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* skip bad line */ }
  }
  return out;
}

module.exports = {
  modes,
  appendTradeLog,
  appendSettingsSnapshot,
  setSettingsProvider,
  getSettingsSnapshot,
  filePathFor,
  dailyFilePathFor,
  listDailyDates,
  readDailyTrades,
  istDateString,
  _tradeRecord,
  FILE_BY_MODE,
  DAILY_PREFIX_BY_MODE,
  TRADES_DIR,
};

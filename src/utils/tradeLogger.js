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
const _HOME = require("os").homedir();
const DATA_DIR   = path.join(_HOME, "trading-data");
const TRADES_DIR = path.join(DATA_DIR, "trades");

const FILE_BY_MODE = {
  swing: "paper_trades_log.jsonl",
  scalp: "scalp_paper_trades_log.jsonl",
  pa:    "pa_paper_trades_log.jsonl",
};

const DAILY_PREFIX_BY_MODE = {
  swing: "swing_paper_trades_",
  scalp: "scalp_paper_trades_",
  pa:    "pa_paper_trades_",
};

// One-time dir ensure at module load — keeps the hot-path append sync-free.
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
try { fs.mkdirSync(TRADES_DIR, { recursive: true }); } catch (_) {}

function filePathFor(mode) {
  const name = FILE_BY_MODE[mode];
  if (!name) throw new Error(`tradeLogger: unknown mode "${mode}"`);
  return path.join(DATA_DIR, name);
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
  const p = DAILY_PREFIX_BY_MODE[mode];
  if (!p) throw new Error(`tradeLogger: unknown mode "${mode}"`);
  const ds = dateStr || istDateString();
  return path.join(TRADES_DIR, `${p}${ds}.jsonl`);
}

/**
 * List available daily trade-log dates for a mode, newest first.
 * Returns [{ date, size, mtimeMs }, ...]
 */
function listDailyDates(mode) {
  const pref = DAILY_PREFIX_BY_MODE[mode];
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

function appendTradeLog(mode, trade) {
  try {
    const ts = Date.now();
    const line = JSON.stringify({ mode, loggedAt: new Date(ts).toISOString(), ...trade }) + "\n";
    // Fire-and-forget async append. POSIX O_APPEND makes each short write
    // atomic, so concurrent exits cannot interleave lines.
    // Write to both the cumulative file (legacy, unchanged) and the daily file.
    fsp.appendFile(filePathFor(mode), line).catch(err => {
      console.warn(`[tradeLogger] append failed (mode=${mode}): ${err.message}`);
    });
    fsp.appendFile(dailyFilePathFor(mode, istDateString(ts)), line).catch(err => {
      console.warn(`[tradeLogger] daily append failed (mode=${mode}): ${err.message}`);
    });
  } catch (err) {
    // Logging must never break the trade flow.
    console.warn(`[tradeLogger] append failed (mode=${mode}): ${err.message}`);
  }
}

module.exports = {
  appendTradeLog,
  filePathFor,
  dailyFilePathFor,
  listDailyDates,
  istDateString,
  FILE_BY_MODE,
  DAILY_PREFIX_BY_MODE,
  TRADES_DIR,
};

/**
 * Daily-rotating skip-reason logger (additive-only).
 *
 * Writes one JSON line per SKIP decision to a daily file per mode, so the
 * 6-week paper-trade collection window can be analysed offline to answer
 * "which filter is the biggest entry drag". Does NOT affect trade decisions.
 *
 * Layout:  ~/trading-data/skips/{mode}_paper_skips_{YYYY-MM-DD}.jsonl
 * Rotation: new file per IST date — market is IST so grouping matches sessions.
 *
 * Only strategy / vix / spread gates are logged. Operational gates (cooldown,
 * daily-loss, max-trades, warmup, market-hours) are omitted as noise.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const _HOME = require("os").homedir();

const DATA_DIR  = path.join(_HOME, "trading-data");
const SKIPS_DIR = path.join(DATA_DIR, "skips");

const FILE_PREFIX_BY_MODE = {
  swing: "swing_paper_skips_",
  scalp: "scalp_paper_skips_",
  pa:    "pa_paper_skips_",
};

try { fs.mkdirSync(SKIPS_DIR, { recursive: true }); } catch (_) {}

// IST date string "YYYY-MM-DD" from unix ms (or now).
function istDateString(unixMs) {
  const t = typeof unixMs === "number" ? unixMs : Date.now();
  const ist = new Date(t + 19800000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() + 1;
  const d = ist.getUTCDate();
  return `${y}-${m < 10 ? "0" : ""}${m}-${d < 10 ? "0" : ""}${d}`;
}

function _prefix(mode) {
  const p = FILE_PREFIX_BY_MODE[mode];
  if (!p) throw new Error(`skipLogger: unknown mode "${mode}"`);
  return p;
}

function filePathFor(mode, dateStr) {
  const ds = dateStr || istDateString();
  return path.join(SKIPS_DIR, `${_prefix(mode)}${ds}.jsonl`);
}

/**
 * List available skip-log dates for a mode, newest first.
 * Returns [{ date: "YYYY-MM-DD", size, mtimeMs }, ...]
 */
function listDates(mode) {
  const pref = _prefix(mode);
  let names;
  try { names = fs.readdirSync(SKIPS_DIR); }
  catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.startsWith(pref) || !n.endsWith(".jsonl")) continue;
    const date = n.slice(pref.length, -".jsonl".length);
    try {
      const st = fs.statSync(path.join(SKIPS_DIR, n));
      out.push({ date, size: st.size, mtimeMs: st.mtimeMs });
    } catch (_) {}
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

/**
 * Append a skip entry for the given mode. Fire-and-forget async write.
 * Caller supplies: { gate, reason, spot?, rsi?, adx?, audit?, ...any extras }.
 */
function appendSkipLog(mode, entry) {
  try {
    const ts = Date.now();
    const line = JSON.stringify({
      ts: new Date(ts).toISOString(),
      istDate: istDateString(ts),
      mode,
      ...entry,
    }) + "\n";
    fsp.appendFile(filePathFor(mode, istDateString(ts)), line).catch(err => {
      console.warn(`[skipLogger] append failed (mode=${mode}): ${err.message}`);
    });
  } catch (err) {
    console.warn(`[skipLogger] append failed (mode=${mode}): ${err.message}`);
  }
}

/**
 * Read all skip entries from the daily JSONL for a given mode and IST date.
 * Returns an array of parsed objects (skipping malformed lines).
 */
function readDailySkips(mode, dateStr) {
  const fp = filePathFor(mode, dateStr);
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
  appendSkipLog,
  filePathFor,
  listDates,
  readDailySkips,
  istDateString,
  SKIPS_DIR,
  FILE_PREFIX_BY_MODE,
};

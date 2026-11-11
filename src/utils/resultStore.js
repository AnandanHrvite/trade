const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "../../data");
const RESULTS_FILE = path.join(DATA_DIR, "backtest_results.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// The results file holds every strategy's last backtest (full trade arrays) — it
// can grow to several MB. allBacktest.js calls loadResult() 4–5× per page view,
// so cache the parsed object behind an mtime+size signature to avoid re-parsing
// the same unchanged file on each call. (Same pattern as consolidation.js.)
let _cache = null;
let _cacheSig = null;
let _corruptUnbacked = false;   // corrupt file we could NOT move aside → never overwrite it

function saveResult(strategyKey, result) {
  ensureDir();
  let all = loadAll();
  if (_corruptUnbacked) throw new Error("backtest_results.json is corrupt and could not be backed up — not overwriting it");
  all[strategyKey] = {
    ...result,
    savedAt: new Date().toISOString(),
  };
  // Atomic: tmp + rename, so a crash mid-write can never leave a torn file
  // (a torn file used to parse-fail → {} → the next save wiped every strategy).
  const tmp = `${RESULTS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, RESULTS_FILE);
  _cache = null; _cacheSig = null; // invalidate — next loadAll re-reads the fresh file
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(RESULTS_FILE)) return {};
  try {
    const st = fs.statSync(RESULTS_FILE);
    const sig = `${st.mtimeMs}:${st.size}`;
    if (_cache && _cacheSig === sig) return _cache;
    _corruptUnbacked = false;
    _cache = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf-8"));
    _cacheSig = sig;
    return _cache;
  } catch (err) {
    // Unparseable file: move it aside (never overwrite the only copy) so the next
    // save starts a fresh file instead of silently replacing the damaged one.
    if (err instanceof SyntaxError) {
      const backup = `${RESULTS_FILE}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(RESULTS_FILE, backup);
        console.error(`[resultStore] backtest_results.json is corrupt (${err.message}) — moved to ${path.basename(backup)}`);
      } catch (e2) {
        console.error(`[resultStore] backtest_results.json is corrupt and could not be backed up (${e2.message}) — saves are refused until it is fixed`);
        _corruptUnbacked = true;
      }
    }
    _cache = null; _cacheSig = null;
    return {};
  }
}

function loadResult(strategyKey) {
  const all = loadAll();
  return all[strategyKey] || null;
}

// ── Saved runs of the /backtest page ────────────────────────────────────────
// One file per run under data/backtest_runs/ (not inside backtest_results.json,
// which allBacktest.js re-reads on every view): each run keeps its full trade
// list plus the strategy, market and the exact settings it ran with, so it can
// be re-opened later without re-running. Only the newest MAX_RUNS are kept.
let RUNS_DIR = path.join(DATA_DIR, "backtest_runs");
/** Tests point the run store at a temp dir. */
function _setRunsDir(dir) { RUNS_DIR = dir; }
const MAX_RUNS = 40;
const _RUN_ID  = /^[a-z0-9_-]{6,64}$/i;

// JSON has no Infinity (profit factor with no losing trade) — tag it on save.
function _encode(v) {
  if (v === Infinity) return { $num: "Infinity" };
  if (v === -Infinity) return { $num: "-Infinity" };
  if (Array.isArray(v)) return v.map(_encode);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = _encode(v[k]);
    return o;
  }
  return v;
}
function _decode(v) {
  if (Array.isArray(v)) return v.map(_decode);
  if (v && typeof v === "object") {
    if (Object.keys(v).length === 1 && typeof v.$num === "string") return v.$num === "-Infinity" ? -Infinity : Infinity;
    const o = {};
    for (const k of Object.keys(v)) o[k] = _decode(v[k]);
    return o;
  }
  return v;
}

function _runHead(r) {
  const s = (r.view && r.view.summary) || {};
  return {
    id: r.id, strategyId: r.strategyId, strategyLabel: r.strategyLabel, market: r.market,
    marketLabel: r.marketLabel, from: r.from, to: r.to, resolution: r.resolution,
    settingsSource: r.settingsSource, savedAt: r.savedAt,
    totalTrades: s.totalTrades || 0, totalPnl: s.totalPnl || 0, winRate: s.winRate || 0,
  };
}

function _writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Save one run (record.id required): <id>.json holds the whole record, and a
 * small <id>.head.json the list row, so listing never parses trade arrays.
 * Prunes the oldest beyond MAX_RUNS.
 */
function saveRun(record) {
  if (!record || !_RUN_ID.test(String(record.id || ""))) throw new Error("saveRun: record.id missing or malformed");
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
  const rec = { ...record, savedAt: record.savedAt || new Date().toISOString() };
  _writeAtomic(path.join(RUNS_DIR, `${rec.id}.json`), JSON.stringify(_encode(rec)));
  _writeAtomic(path.join(RUNS_DIR, `${rec.id}.head.json`), JSON.stringify(_runHead(rec)));
  const heads = listRuns(Infinity);
  for (const h of heads.slice(MAX_RUNS)) {
    for (const f of [`${h.id}.json`, `${h.id}.head.json`]) { try { fs.unlinkSync(path.join(RUNS_DIR, f)); } catch (_) {} }
  }
  return rec;
}

/** One saved run, or null. */
function loadRun(id) {
  if (!_RUN_ID.test(String(id || ""))) return null;
  try { return _decode(JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${id}.json`), "utf-8"))); }
  catch (_) { return null; }
}

/** Saved runs, newest first — list rows only (no trade list). */
function listRuns(limit = MAX_RUNS) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(RUNS_DIR).filter((x) => x.endsWith(".head.json"))) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf-8"))); } catch (_) {}
  }
  out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return out.slice(0, limit);
}

module.exports = { saveResult, loadAll, loadResult, saveRun, loadRun, listRuns, _setRunsDir };

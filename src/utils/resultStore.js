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

module.exports = { saveResult, loadAll, loadResult };

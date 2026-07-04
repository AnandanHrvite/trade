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

function saveResult(strategyKey, result) {
  ensureDir();
  let all = loadAll();
  all[strategyKey] = {
    ...result,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(all, null, 2));
  _cache = null; _cacheSig = null; // invalidate — next loadAll re-reads the fresh file
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(RESULTS_FILE)) return {};
  try {
    const st = fs.statSync(RESULTS_FILE);
    const sig = `${st.mtimeMs}:${st.size}`;
    if (_cache && _cacheSig === sig) return _cache;
    _cache = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf-8"));
    _cacheSig = sig;
    return _cache;
  } catch {
    return {};
  }
}

function loadResult(strategyKey) {
  const all = loadAll();
  return all[strategyKey] || null;
}

module.exports = { saveResult, loadAll, loadResult };

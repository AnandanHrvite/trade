const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "../../data");
const RESULTS_FILE = path.join(DATA_DIR, "backtest_results.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveResult(strategyKey, result) {
  ensureDir();
  let all = loadAll();
  all[strategyKey] = {
    ...result,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(all, null, 2));
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(RESULTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function loadResult(strategyKey) {
  const all = loadAll();
  return all[strategyKey] || null;
}

module.exports = { saveResult, loadAll, loadResult };

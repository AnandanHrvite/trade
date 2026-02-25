require("dotenv").config();
const fs   = require("fs");
const path = require("path");

/**
 * Auto-discovers all strategy files in this folder.
 * Naming convention:  strategy<N>_<name>.js
 * Maps to key:        STRATEGY_<N>
 *
 * To add a new strategy:
 *   1. Create src/strategies/strategy5_myname.js
 *   2. Export { NAME, DESCRIPTION, getSignal }
 *   3. Set ACTIVE_STRATEGY=STRATEGY_5 in .env
 *   4. Restart — done. No other file needs to change.
 */

const strategies = {};

fs.readdirSync(__dirname)
  .filter(f => f.match(/^strategy\d+_.+\.js$/))
  .sort()
  .forEach(file => {
    // strategy4_custom.js → STRATEGY_4
    const num = file.match(/^strategy(\d+)_/)[1];
    const key = `STRATEGY_${num}`;
    strategies[key] = require(path.join(__dirname, file));
  });

const ACTIVE = process.env.ACTIVE_STRATEGY || "STRATEGY_1";

function getActiveStrategy() {
  const strategy = strategies[ACTIVE];
  if (!strategy) {
    throw new Error(
      `Unknown strategy "${ACTIVE}". Available: ${Object.keys(strategies).join(", ")}`
    );
  }
  return strategy;
}

function getAllStrategies() {
  return Object.entries(strategies).map(([key, s]) => ({
    key,
    name:        s.NAME,
    description: s.DESCRIPTION,
    active:      key === ACTIVE,
  }));
}

module.exports = { getActiveStrategy, getAllStrategies, ACTIVE };


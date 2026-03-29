require("dotenv").config();
const strategy1 = require("./strategy1_sar_ema_rsi");

// Only Strategy 1 (SAR + EMA9 + RSI) is active.


function getActiveStrategy() {
  return strategy1;
}

const ACTIVE = "STRATEGY_1";

module.exports = { getActiveStrategy, ACTIVE };

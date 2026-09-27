/**
 * PAPER TRADE — /cmx_gold_ema_rsi_st-paper   (COMMODITY · EMA_RSI_ST on MCX Gold)
 *
 * The EMA_RSI_ST rules on the Gold future, buying Gold options. Paper only and
 * separate from every NIFTY strategy — see src/services/commodityPaper.js.
 */
const { commodityPage } = require("../utils/commodityPaperRouter");

module.exports = commodityPage({ commodity: "GOLD", strategy: "V1" });

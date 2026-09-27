/**
 * PAPER TRADE — /cmx_silver_ema_rsi_st-paper   (COMMODITY · EMA_RSI_ST on MCX Silver)
 *
 * The EMA_RSI_ST rules on the Silver future, buying Silver options. Paper only and
 * separate from every NIFTY strategy — see src/services/commodityPaper.js.
 */
const { commodityPage } = require("../utils/commodityPaperRouter");

module.exports = commodityPage({ commodity: "SILVER", strategy: "V1" });

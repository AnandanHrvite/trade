/**
 * PAPER TRADE — /cmx_silver_ema_rsi_st_v2-paper   (COMMODITY · EMA_RSI_ST_V2 on MCX Silver)
 *
 * The EMA_RSI_ST_V2 rules on the Silver future, buying Silver options. Paper only and
 * separate from every NIFTY strategy — see src/services/commodityPaper.js.
 */
const { commodityPage } = require("../utils/commodityPaperRouter");

module.exports = commodityPage({ commodity: "SILVER", strategy: "V2" });

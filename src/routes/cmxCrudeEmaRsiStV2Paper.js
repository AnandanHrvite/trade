/**
 * PAPER TRADE — /cmx_crude_ema_rsi_st_v2-paper   (COMMODITY · EMA_RSI_ST_V2 on MCX Crude)
 *
 * The EMA_RSI_ST_V2 rules on the Crude future, buying Crude options. Paper only and
 * separate from every NIFTY strategy — see src/services/commodityPaper.js.
 */
const { commodityPage } = require("../utils/commodityPaperRouter");

module.exports = commodityPage({ commodity: "CRUDE", strategy: "V2" });

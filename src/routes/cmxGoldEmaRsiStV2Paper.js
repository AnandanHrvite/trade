/**
 * PAPER TRADE — /cmx_gold_ema_rsi_st_v2-paper   (COMMODITY · EMA_RSI_ST_V2 on MCX Gold)
 *
 * The EMA_RSI_ST_V2 rules on the Gold future, buying Gold options. Paper only and
 * separate from every NIFTY strategy — see src/services/commodityPaper.js.
 */
const { commodityPage } = require("../utils/commodityPaperRouter");

module.exports = commodityPage({ commodity: "GOLD", strategy: "V2" });

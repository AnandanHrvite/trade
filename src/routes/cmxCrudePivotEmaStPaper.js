/**
 * PAPER TRADE — /cmx_crude_pivot_ema_st-paper   (COMMODITY · PIVOT_EMA_ST on MCX Crude)
 *
 * The PIVOT_EMA_ST rules on the Crude future, buying Crude options. Paper only and
 * separate from every NIFTY strategy — see src/services/commodityPaper.js.
 */
const { commodityPage } = require("../utils/commodityPaperRouter");

module.exports = commodityPage({ commodity: "CRUDE", strategy: "PIVOT" });

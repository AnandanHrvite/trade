/**
 * PAPER TRADE — /cmx_silver_pivot_ema_st-paper   (COMMODITY · PIVOT_EMA_ST on MCX Silver)
 *
 * The PIVOT_EMA_ST rules on the Silver future, buying Silver options. Paper only and
 * separate from every NIFTY strategy — see src/services/commodityPaper.js.
 */
const { commodityPage } = require("../utils/commodityPaperRouter");

module.exports = commodityPage({ commodity: "SILVER", strategy: "PIVOT" });

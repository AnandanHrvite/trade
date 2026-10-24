/**
 * PAPER TRADE — /cmx_gold_pivot_ema_st-paper   (COMMODITY · PIVOT_EMA_ST on MCX Gold)
 *
 * The PIVOT_EMA_ST rules on the Gold future, buying Gold options. Paper only and
 * separate from every NIFTY strategy — see src/services/commodityPaper.js.
 */
const { commodityPage } = require("../utils/commodityPaperRouter");

module.exports = commodityPage({ commodity: "GOLD", strategy: "PIVOT" });

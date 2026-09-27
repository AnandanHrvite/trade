/**
 * PAPER TRADE — /cmx_ema_rsi_st_v2-paper   (COMMODITY · EMA_RSI_ST_V2 on MCX crude)
 *
 * The EMA_RSI_ST_V2 rules (same EMA_RSI_ST_V2_* settings as the NIFTY strategy)
 * run on the crude future and buy crude options. Paper only, and fully separate
 * from the NIFTY engine — see src/services/commodityPaper.js.
 */
const { createEngine } = require("../services/commodityPaper");
const { createCommodityPaperRouter } = require("../utils/commodityPaperRouter");

const engine = createEngine({ id: "cmx_ema_rsi_st_v2", prefix: "CMX_EMA_RSI_ST_V2", label: "EMA_RSI_ST_V2 (Commodity)", strategy: "V2" });

module.exports = createCommodityPaperRouter({
  engine,
  base: "/cmx_ema_rsi_st_v2-paper",
  navKey: "cmxEmaRsiStV2Paper",
  title: "EMA_RSI_ST_V2 · Crude",
  rulesText: `
    <li><b>Signal:</b> the EMA_RSI_ST_V2 rules — EMA20 vs EMA50 + close beyond EMA20 + RSI on the crude future, using the same settings as the NIFTY EMA_RSI_ST_V2.</li>
    <li><b>Entry:</b> with the confirmation candle on, the next candle must cross the signal candle's close.</li>
    <li><b>Exits:</b> SuperTrend trailing stop (its only stop), profit lock, opposite signal, and the day's exit time.</li>`,
});
module.exports.engine = engine;

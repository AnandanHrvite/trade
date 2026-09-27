/**
 * PAPER TRADE — /cmx_ema_rsi_st-paper   (COMMODITY · EMA_RSI_ST on MCX crude)
 *
 * The EMA_RSI_ST rules (same EMA_RSI_ST_* settings as the NIFTY strategy) run
 * on the crude future and buy crude options. Paper only, and fully separate from
 * the NIFTY engine — see src/services/commodityPaper.js for what is shared
 * (the rules, read-only) and what is not (everything else).
 */
const { createEngine } = require("../services/commodityPaper");
const { createCommodityPaperRouter } = require("../utils/commodityPaperRouter");

const engine = createEngine({ id: "cmx_ema_rsi_st", prefix: "CMX_EMA_RSI_ST", label: "EMA_RSI_ST (Commodity)", strategy: "V1" });

module.exports = createCommodityPaperRouter({
  engine,
  base: "/cmx_ema_rsi_st-paper",
  navKey: "cmxEmaRsiStPaper",
  title: "EMA_RSI_ST · Crude",
  rulesText: `
    <li><b>Signal:</b> the EMA_RSI_ST rules — EMA20/50 trend + RSI + SuperTrend on the crude future, using the same settings as the NIFTY EMA_RSI_ST.</li>
    <li><b>Entry:</b> with the confirmation candle on, the next candle must cross the signal candle's close.</li>
    <li><b>Exits:</b> previous-candle stop trailed on EMA21, EMA21 touch-back, negative-candle stop, option stop %, profit lock / breakeven, opposite signal, and the day's exit time.</li>`,
});
module.exports.engine = engine;

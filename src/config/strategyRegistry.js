/**
 * strategyRegistry.js — ONE list of every paper strategy and its wiring facts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared code (sidebar roster, loggers, report pages, replay, shutdown, …) reads
 * this instead of keeping its own hand-typed strategy list. Every value here is
 * copied from the code that already used it — nothing is a new setting:
 *
 *   id            camelCase id (also the route-file stem: routes/<id>Paper.js)
 *   kind          "strategy", or "tool" for the GAP_RUNAWAY stock scanner — a
 *                 paper route with its own trades/skips but not a strategy of
 *                 its own (it is GAP_RUNAWAY's stock leg)
 *   key           upper-case group key: sharedNav STRATEGY_MODES `mode`, notify
 *                 group, consolidation `mode`, realtime `key` (TDS, EARLYBIRD …)
 *   label         sidebar group header (sharedNav buildSidebar `header`)
 *   modeKey       tradeLogger / skipLogger / capitalPool / portfolioRisk key
 *   envPrefix     prefix of the strategy's own env keys (`${envPrefix}_*`)
 *   legacyEnvPrefix  EMA_RSI_ST only: it still reads the original common
 *                 TRADE_* keys (TRADE_ENTRY_START/END, TRADE_RESOLUTION, …)
 *   modeEnabled   { key, default } — the *_MODE_ENABLED toggle (Settings default)
 *   paperEnabled  { key, default } — the route's own *_PAPER_ENABLED /start gate,
 *                 null when the route has none
 *   paper         { path, module } — app.js mount + module path relative to src/
 *   backtest      { path, module } or null
 *   extraRoutes   other mounts that belong to the strategy (PA pattern backtest)
 *   engine        signal module relative to src/ (the one the paper route requires)
 *   broker        capitalPool pool: "zerodha" | "fyers"
 *   socket        sharedSocketState slot: the mode string it holds and the names
 *                 of its set/clear/isActive/get functions
 *   needsIndexOpen  rules read the 09:15 NIFTY open / opening range
 *   telegram      TG_* toggle keys (Settings → Telegram)
 *   nav           { order, groupId, rosterLabel } — order = position of the
 *                 group in buildSidebar; rosterLabel = STRATEGY_MODES `label`
 *   commonWindow  { start, end } — the strategy's keys that the Common Trade
 *                 Rules entry window overrides (commonTradeWindow.js); null = none
 *   tradesFile    ~/trading-data/<file> the paper route saves sessions to
 *   replay        true when tickReplay can replay the paper route
 *
 * ENTRIES order is the sharedNav STRATEGY_MODES order (the Start-All roster).
 * Some shared lists have always used a different order; ORDERS keeps those
 * historic orders by id so the derived lists stay byte-identical. A new
 * strategy is added to ENTRIES and to each ORDERS list
 * (tests/strategyRegistry.regression.js fails until it is).
 *
 * Pure data (requires only `path`), so any module — sharedSocketState included —
 * can load it without a cycle.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require("path");

const ENTRIES = [
  {
    id: "emaRsiSt", kind: "strategy", key: "EMA_RSI_ST", label: "EMA_RSI_ST",
    modeKey: "ema_rsi_st", envPrefix: "EMA_RSI_ST", legacyEnvPrefix: "TRADE",
    modeEnabled: { key: "EMA_RSI_ST_MODE_ENABLED", default: "true" },
    paperEnabled: null,
    paper:    { path: "/ema_rsi_st-paper",    module: "routes/emaRsiStPaper" },
    backtest: { path: "/ema_rsi_st-backtest", module: "routes/emaRsiStBacktest" },
    engine: "strategies/strategy1_sar_ema_rsi",
    broker: "zerodha",
    socket: { mode: "EMA_RSI_ST_PAPER", set: "setActive", clear: "clear", isActive: "isActive", get: "getMode" },
    needsIndexOpen: false,
    telegram: { started: "TG_EMA_RSI_ST_STARTED", entry: "TG_EMA_RSI_ST_ENTRY", exit: "TG_EMA_RSI_ST_EXIT", dayReport: "TG_EMA_RSI_ST_DAYREPORT", signals: "TG_EMA_RSI_ST_SIGNALS" },
    nav: { order: 0, groupId: "nav-ema_rsi_st", rosterLabel: "EMA_RSI_ST" },
    commonWindow: { start: "TRADE_ENTRY_START", end: "TRADE_ENTRY_END" },
    tradesFile: "ema_rsi_st_paper_trades.json",
    replay: true,
  },
  {
    id: "bbRsi", kind: "strategy", key: "BB_RSI", label: "BB_RSI",
    modeKey: "bb_rsi", envPrefix: "BB_RSI",
    modeEnabled: { key: "BB_RSI_MODE_ENABLED", default: "true" },
    paperEnabled: null,
    paper:    { path: "/bb_rsi-paper",    module: "routes/bbRsiPaper" },
    backtest: { path: "/bb_rsi-backtest", module: "routes/bbRsiBacktest" },
    engine: "strategies/bb_rsi",
    broker: "fyers",
    socket: { mode: "BB_RSI_PAPER", set: "setBbRsiActive", clear: "clearBbRsi", isActive: "isBbRsiActive", get: "getBbRsiMode" },
    needsIndexOpen: false,
    telegram: { started: "TG_BB_RSI_STARTED", entry: "TG_BB_RSI_ENTRY", exit: "TG_BB_RSI_EXIT", dayReport: "TG_BB_RSI_DAYREPORT", signals: "TG_BB_RSI_SIGNALS" },
    nav: { order: 1, groupId: "nav-bb_rsi", rosterLabel: "BB_RSI" },
    commonWindow: { start: "BB_RSI_ENTRY_START", end: "BB_RSI_ENTRY_END" },
    tradesFile: "bb_rsi_paper_trades.json",
    replay: true,
  },
  {
    id: "pa", kind: "strategy", key: "PA", label: "PRICE ACTION",
    modeKey: "pa", envPrefix: "PA",
    modeEnabled: { key: "PA_MODE_ENABLED", default: "true" },
    paperEnabled: null,
    paper:    { path: "/pa-paper",    module: "routes/paPaper" },
    backtest: { path: "/pa-backtest", module: "routes/paBacktest" },
    extraRoutes: [{ path: "/pa-pattern-backtest", module: "routes/paPatternBacktest" }],
    engine: "strategies/price_action",
    broker: "fyers",
    socket: { mode: "PA_PAPER", set: "setPAActive", clear: "clearPA", isActive: "isPAActive", get: "getPAMode" },
    needsIndexOpen: false,
    telegram: { started: "TG_PA_STARTED", entry: "TG_PA_ENTRY", exit: "TG_PA_EXIT", dayReport: "TG_PA_DAYREPORT", signals: "TG_PA_SIGNALS" },
    nav: { order: 2, groupId: "nav-pa", rosterLabel: "Price Action" },
    commonWindow: { start: "PA_ENTRY_START", end: "PA_ENTRY_END" },
    tradesFile: "pa_paper_trades.json",
    replay: true,
  },
  {
    id: "orb", kind: "strategy", key: "ORB", label: "ORB",
    modeKey: "orb", envPrefix: "ORB",
    modeEnabled: { key: "ORB_MODE_ENABLED", default: "true" },
    paperEnabled: null,
    paper:    { path: "/orb-paper",    module: "routes/orbPaper" },
    backtest: { path: "/orb-backtest", module: "routes/orbBacktest" },
    engine: "strategies/orb_breakout",
    broker: "fyers",
    socket: { mode: "ORB_PAPER", set: "setOrbActive", clear: "clearOrb", isActive: "isOrbActive", get: "getOrbMode" },
    needsIndexOpen: true,
    telegram: { started: "TG_ORB_STARTED", entry: "TG_ORB_ENTRY", exit: "TG_ORB_EXIT", dayReport: "TG_ORB_DAYREPORT" },
    nav: { order: 3, groupId: "nav-orb", rosterLabel: "ORB" },
    // ORB_ENTRY_END is deliberately not overridden — ORB keeps its own cut-off.
    commonWindow: { start: "ORB_ENTRY_START", end: null },
    tradesFile: "orb_paper_trades.json",
    replay: true,
  },
  {
    id: "ema9vwap", kind: "strategy", key: "EMA9VWAP", label: "EMA9+VWAP",
    modeKey: "ema9vwap", envPrefix: "EMA9VWAP",
    modeEnabled: { key: "EMA9VWAP_MODE_ENABLED", default: "true" },
    paperEnabled: null,
    paper:    { path: "/ema9vwap-paper",    module: "routes/ema9vwapPaper" },
    backtest: { path: "/ema9vwap-backtest", module: "routes/ema9vwapBacktest" },
    engine: "strategies/ema9_vwap",
    broker: "zerodha",
    socket: { mode: "EMA9VWAP_PAPER", set: "setEma9VwapActive", clear: "clearEma9Vwap", isActive: "isEma9VwapActive", get: "getEma9VwapMode" },
    needsIndexOpen: false,
    telegram: { started: "TG_EMA9VWAP_STARTED", entry: "TG_EMA9VWAP_ENTRY", exit: "TG_EMA9VWAP_EXIT", dayReport: "TG_EMA9VWAP_DAYREPORT", signals: "TG_EMA9VWAP_SIGNALS" },
    nav: { order: 4, groupId: "nav-ema9vwap", rosterLabel: "EMA9+VWAP" },
    commonWindow: { start: "EMA9VWAP_ENTRY_START", end: "EMA9VWAP_ENTRY_END" },
    tradesFile: "ema9vwap_paper_trades.json",
    replay: true,
  },
  {
    id: "trendPb", kind: "strategy", key: "TREND_PB", label: "TREND PULLBACK",
    modeKey: "trend_pb", envPrefix: "TREND_PB",
    modeEnabled: { key: "TREND_PB_MODE_ENABLED", default: "true" },
    paperEnabled: null,
    paper:    { path: "/trend-pb-paper",    module: "routes/trendPbPaper" },
    backtest: { path: "/trend-pb-backtest", module: "routes/trendPbBacktest" },
    engine: "strategies/trend_pb",
    broker: "fyers",
    socket: { mode: "TREND_PB_PAPER", set: "setTrendPbActive", clear: "clearTrendPb", isActive: "isTrendPbActive", get: "getTrendPbMode" },
    needsIndexOpen: false,
    telegram: { started: "TG_TREND_PB_STARTED", entry: "TG_TREND_PB_ENTRY", exit: "TG_TREND_PB_EXIT", dayReport: "TG_TREND_PB_DAYREPORT" },
    nav: { order: 5, groupId: "nav-trend-pb", rosterLabel: "Trend_PB" },
    commonWindow: { start: "TREND_PB_ENTRY_START", end: "TREND_PB_ENTRY_END" },
    tradesFile: "trend_pb_paper_trades.json",
    replay: true,
  },
  {
    // Group key and env prefix are TDS; the mode key and socket mode keep the
    // long TREND_DAY_SCALP spelling.
    id: "trendDayScalp", kind: "strategy", key: "TDS", label: "TREND DAY SCALP",
    modeKey: "trend_day_scalp", envPrefix: "TDS",
    modeEnabled: { key: "TDS_MODE_ENABLED", default: "true" },
    paperEnabled: { key: "TDS_PAPER_ENABLED", default: "true" },
    paper:    { path: "/trend-day-scalp-paper",    module: "routes/trendDayScalpPaper" },
    backtest: { path: "/trend-day-scalp-backtest", module: "routes/trendDayScalpBacktest" },
    engine: "strategies/trend_day_scalp",
    broker: "fyers",
    socket: { mode: "TREND_DAY_SCALP_PAPER", set: "setTrendDayScalpActive", clear: "clearTrendDayScalp", isActive: "isTrendDayScalpActive", get: "getTrendDayScalpMode" },
    needsIndexOpen: false,
    telegram: { started: "TG_TDS_STARTED", entry: "TG_TDS_ENTRY", exit: "TG_TDS_EXIT", dayReport: "TG_TDS_DAYREPORT" },
    nav: { order: 6, groupId: "nav-trend-day-scalp", rosterLabel: "Trend Day Scalp" },
    commonWindow: { start: null, end: "TDS_ENTRY_END" },
    tradesFile: "trend_day_scalp_paper_trades.json",
    replay: true,
  },
  {
    id: "haScalp", kind: "strategy", key: "HA_SCALP", label: "HA SCALP",
    modeKey: "ha_scalp", envPrefix: "HA_SCALP",
    modeEnabled: { key: "HA_SCALP_MODE_ENABLED", default: "true" },
    paperEnabled: { key: "HA_SCALP_PAPER_ENABLED", default: "true" },
    paper:    { path: "/ha-scalp-paper",    module: "routes/haScalpPaper" },
    backtest: { path: "/ha-scalp-backtest", module: "routes/haScalpBacktest" },
    engine: "strategies/ha_scalp",
    broker: "zerodha",
    socket: { mode: "HA_SCALP_PAPER", set: "setHaScalpActive", clear: "clearHaScalp", isActive: "isHaScalpActive", get: "getHaScalpMode" },
    needsIndexOpen: false,
    telegram: { started: "TG_HA_SCALP_STARTED", entry: "TG_HA_SCALP_ENTRY", exit: "TG_HA_SCALP_EXIT", dayReport: "TG_HA_SCALP_DAYREPORT" },
    nav: { order: 7, groupId: "nav-ha-scalp", rosterLabel: "HA Scalp" },
    commonWindow: { start: "HA_SCALP_ENTRY_START", end: "HA_SCALP_ENTRY_END" },
    tradesFile: "ha_scalp_paper_trades.json",
    replay: true,
  },
  {
    id: "prevOrbScalp", kind: "strategy", key: "PREV_ORB_SCALP", label: "PREV ORB SCALP",
    modeKey: "prev_orb_scalp", envPrefix: "PREV_ORB_SCALP",
    modeEnabled: { key: "PREV_ORB_SCALP_MODE_ENABLED", default: "true" },
    paperEnabled: { key: "PREV_ORB_SCALP_PAPER_ENABLED", default: "true" },
    paper:    { path: "/prev-orb-scalp-paper",    module: "routes/prevOrbScalpPaper" },
    backtest: { path: "/prev-orb-scalp-backtest", module: "routes/prevOrbScalpBacktest" },
    engine: "strategies/prev_orb_scalp",
    broker: "zerodha",
    socket: { mode: "PREV_ORB_SCALP_PAPER", set: "setPrevOrbScalpActive", clear: "clearPrevOrbScalp", isActive: "isPrevOrbScalpActive", get: "getPrevOrbScalpMode" },
    needsIndexOpen: true,
    telegram: { started: "TG_PREV_ORB_SCALP_STARTED", entry: "TG_PREV_ORB_SCALP_ENTRY", exit: "TG_PREV_ORB_SCALP_EXIT", dayReport: "TG_PREV_ORB_SCALP_DAYREPORT" },
    nav: { order: 8, groupId: "nav-prev-orb-scalp", rosterLabel: "Prev ORB Scalp" },
    commonWindow: { start: null, end: "PREV_ORB_SCALP_ENTRY_END" },
    tradesFile: "prev_orb_scalp_paper_trades.json",
    replay: true,
  },
  {
    id: "itm20Scalp", kind: "strategy", key: "ITM20_SCALP", label: "ITM20 SCALP",
    modeKey: "itm20_scalp", envPrefix: "ITM20_SCALP",
    modeEnabled: { key: "ITM20_SCALP_MODE_ENABLED", default: "true" },
    paperEnabled: { key: "ITM20_SCALP_PAPER_ENABLED", default: "true" },
    paper:    { path: "/itm20-scalp-paper",    module: "routes/itm20ScalpPaper" },
    backtest: { path: "/itm20-scalp-backtest", module: "routes/itm20ScalpBacktest" },
    engine: "strategies/itm20_scalp",
    broker: "zerodha",
    socket: { mode: "ITM20_SCALP_PAPER", set: "setItm20ScalpActive", clear: "clearItm20Scalp", isActive: "isItm20ScalpActive", get: "getItm20ScalpMode" },
    // Its levels are the 09:15–09:30 opening range (strategies/itm20_scalp.js).
    needsIndexOpen: true,
    telegram: { started: "TG_ITM20_SCALP_STARTED", entry: "TG_ITM20_SCALP_ENTRY", exit: "TG_ITM20_SCALP_EXIT", dayReport: "TG_ITM20_SCALP_DAYREPORT" },
    nav: { order: 9, groupId: "nav-itm20-scalp", rosterLabel: "ITM20 Scalp" },
    commonWindow: { start: null, end: null },
    tradesFile: "itm20_scalp_paper_trades.json",
    replay: true,
  },
  {
    id: "rsiPivotSt", kind: "strategy", key: "RSI_PIVOT_ST", label: "RSI PIVOT ST",
    modeKey: "rsi_pivot_st", envPrefix: "RSI_PIVOT_ST",
    modeEnabled: { key: "RSI_PIVOT_ST_MODE_ENABLED", default: "true" },
    paperEnabled: { key: "RSI_PIVOT_ST_PAPER_ENABLED", default: "true" },
    paper:    { path: "/rsi-pivot-st-paper",    module: "routes/rsiPivotStPaper" },
    backtest: { path: "/rsi-pivot-st-backtest", module: "routes/rsiPivotStBacktest" },
    engine: "strategies/rsi_pivot_st",
    broker: "zerodha",
    socket: { mode: "RSI_PIVOT_ST_PAPER", set: "setRsiPivotStActive", clear: "clearRsiPivotSt", isActive: "isRsiPivotStActive", get: "getRsiPivotStMode" },
    needsIndexOpen: false,
    telegram: { started: "TG_RSI_PIVOT_ST_STARTED", entry: "TG_RSI_PIVOT_ST_ENTRY", exit: "TG_RSI_PIVOT_ST_EXIT", dayReport: "TG_RSI_PIVOT_ST_DAYREPORT" },
    nav: { order: 10, groupId: "nav-rsi-pivot-st", rosterLabel: "RSI Pivot ST" },
    commonWindow: { start: "RSI_PIVOT_ST_ENTRY_START", end: "RSI_PIVOT_ST_ENTRY_END" },
    tradesFile: "rsi_pivot_st_paper_trades.json",
    replay: true,
  },
  {
    id: "emaRsiStV2", kind: "strategy", key: "EMA_RSI_ST_V2", label: "EMA_RSI_ST_V2",
    modeKey: "ema_rsi_st_v2", envPrefix: "EMA_RSI_ST_V2",
    modeEnabled: { key: "EMA_RSI_ST_V2_MODE_ENABLED", default: "false" },
    paperEnabled: { key: "EMA_RSI_ST_V2_PAPER_ENABLED", default: "false" },
    paper:    { path: "/ema_rsi_st_v2-paper",    module: "routes/emaRsiStV2Paper" },
    backtest: { path: "/ema_rsi_st_v2-backtest", module: "routes/emaRsiStV2Backtest" },
    engine: "strategies/ema_rsi_st_v2",
    broker: "zerodha",
    socket: { mode: "EMA_RSI_ST_V2_PAPER", set: "setEmaRsiStV2Mode", clear: "clearEmaRsiStV2Mode", isActive: "isEmaRsiStV2Active", get: "getEmaRsiStV2Mode" },
    needsIndexOpen: false,
    telegram: { started: "TG_EMA_RSI_ST_V2_STARTED", entry: "TG_EMA_RSI_ST_V2_ENTRY", exit: "TG_EMA_RSI_ST_V2_EXIT", dayReport: "TG_EMA_RSI_ST_V2_DAYREPORT" },
    nav: { order: 13, groupId: "nav-ema_rsi_st_v2", rosterLabel: "EMA_RSI_ST_V2" },
    commonWindow: { start: "EMA_RSI_ST_V2_ENTRY_START", end: "EMA_RSI_ST_V2_ENTRY_END" },
    tradesFile: "ema_rsi_st_v2_paper_trades.json",
    replay: true,
  },
  {
    id: "stRsiPivBb", kind: "strategy", key: "ST_RSI_PIV_BB", label: "ST+RSI+PIV+BB",
    modeKey: "st_rsi_piv_bb", envPrefix: "ST_RSI_PIV_BB",
    modeEnabled: { key: "ST_RSI_PIV_BB_MODE_ENABLED", default: "false" },
    paperEnabled: { key: "ST_RSI_PIV_BB_PAPER_ENABLED", default: "false" },
    paper:    { path: "/st_rsi_piv_bb-paper", module: "routes/stRsiPivBbPaper" },
    backtest: null,
    engine: "strategies/st_rsi_piv_bb",
    broker: "zerodha",
    socket: { mode: "ST_RSI_PIV_BB_PAPER", set: "setStRsiPivBbMode", clear: "clearStRsiPivBbMode", isActive: "isStRsiPivBbActive", get: "getStRsiPivBbMode" },
    needsIndexOpen: false,
    telegram: { started: "TG_ST_RSI_PIV_BB_STARTED", entry: "TG_ST_RSI_PIV_BB_ENTRY", exit: "TG_ST_RSI_PIV_BB_EXIT", dayReport: "TG_ST_RSI_PIV_BB_DAYREPORT" },
    nav: { order: 14, groupId: "nav-st_rsi_piv_bb", rosterLabel: "ST_RSI_PIV_BB" },
    commonWindow: { start: "ST_RSI_PIV_BB_ENTRY_START", end: "ST_RSI_PIV_BB_ENTRY_END" },
    tradesFile: "st_rsi_piv_bb_paper_trades.json",
    replay: false,
  },
  {
    id: "sailVwapSt", kind: "strategy", key: "SAIL_VWAP_ST", label: "VWAP_ST",
    modeKey: "sail_vwap_st", envPrefix: "SAIL_VWAP_ST",
    modeEnabled: { key: "SAIL_VWAP_ST_MODE_ENABLED", default: "false" },
    paperEnabled: { key: "SAIL_VWAP_ST_PAPER_ENABLED", default: "false" },
    paper:    { path: "/sail_vwap_st-paper",    module: "routes/sailVwapStPaper" },
    backtest: { path: "/sail_vwap_st-backtest", module: "routes/sailVwapStBacktest" },
    engine: "strategies/sail_vwap_st",
    broker: "zerodha",
    socket: { mode: "SAIL_VWAP_ST_PAPER", set: "setSailVwapStMode", clear: "clearSailVwapStMode", isActive: "isSailVwapStActive", get: "getSailVwapStMode" },
    needsIndexOpen: false,
    telegram: { started: "TG_SAIL_VWAP_ST_STARTED", entry: "TG_SAIL_VWAP_ST_ENTRY", exit: "TG_SAIL_VWAP_ST_EXIT", dayReport: "TG_SAIL_VWAP_ST_DAYREPORT" },
    nav: { order: 15, groupId: "nav-sail_vwap_st", rosterLabel: "VWAP_ST" },
    commonWindow: { start: "SAIL_VWAP_ST_ENTRY_START", end: "SAIL_VWAP_ST_ENTRY_END" },
    tradesFile: "sail_vwap_st_paper_trades.json",
    replay: true,
  },
  {
    id: "pivotEmaSt", kind: "strategy", key: "PIVOT_EMA_ST", label: "PIVOT_EMA_ST",
    modeKey: "pivot_ema_st", envPrefix: "PIVOT_EMA_ST",
    modeEnabled: { key: "PIVOT_EMA_ST_MODE_ENABLED", default: "true" },
    paperEnabled: null,
    paper:    { path: "/pivot_ema_st-paper", module: "routes/pivotEmaStPaper" },
    backtest: null,
    engine: "strategies/pivot_ema_st",
    broker: "zerodha",
    socket: { mode: "PIVOT_EMA_ST_PAPER", set: "setPivotEmaStMode", clear: "clearPivotEmaStMode", isActive: "isPivotEmaStActive", get: "getPivotEmaStMode" },
    needsIndexOpen: false,
    telegram: { started: "TG_PIVOT_EMA_ST_STARTED", entry: "TG_PIVOT_EMA_ST_ENTRY", exit: "TG_PIVOT_EMA_ST_EXIT", dayReport: "TG_PIVOT_EMA_ST_DAYREPORT" },
    nav: { order: 16, groupId: "nav-pivot_ema_st", rosterLabel: "PIVOT_EMA_ST" },
    commonWindow: { start: "PIVOT_EMA_ST_ENTRY_START", end: "PIVOT_EMA_ST_ENTRY_END" },
    tradesFile: "pivot_ema_st_paper_trades.json",
    replay: false,
  },
  {
    id: "gapRunaway", kind: "strategy", key: "GAP_RUNAWAY", label: "GAP_RUNAWAY",
    modeKey: "gap_runaway", envPrefix: "GAP_RUNAWAY",
    modeEnabled: { key: "GAP_RUNAWAY_MODE_ENABLED", default: "true" },
    paperEnabled: null,
    paper:    { path: "/gap_runaway-paper", module: "routes/gapRunawayPaper" },
    backtest: null,
    engine: "strategies/gap_runaway",
    broker: "zerodha",
    socket: { mode: "GAP_RUNAWAY_PAPER", set: "setGapRunawayMode", clear: "clearGapRunawayMode", isActive: "isGapRunawayActive", get: "getGapRunawayMode" },
    needsIndexOpen: true,
    telegram: { started: "TG_GAP_RUNAWAY_STARTED", entry: "TG_GAP_RUNAWAY_ENTRY", exit: "TG_GAP_RUNAWAY_EXIT", dayReport: "TG_GAP_RUNAWAY_DAYREPORT" },
    nav: { order: 17, groupId: "nav-gap_runaway", rosterLabel: "GAP_runAway__Kirubakaran" },
    commonWindow: { start: null, end: null },
    tradesFile: "gap_runaway_paper_trades.json",
    replay: false,
  },
  {
    // GAP_RUNAWAY's stock scanner (intraday F&O shares, paper only). Not a
    // strategy of its own, but it has its own route, slot, trades and skips,
    // so every roster that lists it reads it from here.
    id: "gapRunawayStk", kind: "tool", key: "GAP_RUNAWAY_STK", label: "GAP_RUNAWAY SCANNER",
    modeKey: "gap_runaway_stk", envPrefix: "GAP_RUNAWAY_STK",
    modeEnabled: { key: "GAP_RUNAWAY_STK_MODE_ENABLED", default: "true" },
    paperEnabled: null,
    paper:    { path: "/gap_runaway_stk-paper", module: "routes/gapRunawayStkPaper" },
    backtest: null,
    engine: "strategies/gap_runaway",
    broker: "zerodha",
    socket: { mode: "GAP_RUNAWAY_STK_PAPER", set: "setGapRunawayStkMode", clear: "clearGapRunawayStkMode", isActive: "isGapRunawayStkActive", get: "getGapRunawayStkMode" },
    // Reads each STOCK's own open, not the index open.
    needsIndexOpen: false,
    telegram: { started: "TG_GAP_RUNAWAY_STK_STARTED", entry: "TG_GAP_RUNAWAY_STK_ENTRY", exit: "TG_GAP_RUNAWAY_STK_EXIT", dayReport: "TG_GAP_RUNAWAY_STK_DAYREPORT" },
    nav: { order: 18, groupId: "nav-gap_runaway_stk", rosterLabel: "GAP_runAway Stocks" },
    commonWindow: { start: null, end: null },
    tradesFile: "gap_runaway_stk_paper_trades.json",
    replay: false,
  },
  {
    id: "simple930", kind: "strategy", key: "SIMPLE930", label: "SIMPLE 9:30",
    modeKey: "simple930", envPrefix: "SIMPLE930",
    modeEnabled: { key: "SIMPLE930_MODE_ENABLED", default: "true" },
    paperEnabled: { key: "SIMPLE930_PAPER_ENABLED", default: "true" },
    paper:    { path: "/simple930-paper",    module: "routes/simple930Paper" },
    backtest: { path: "/simple930-backtest", module: "routes/simple930Backtest" },
    engine: "strategies/simple930",
    broker: "zerodha",
    socket: { mode: "SIMPLE930_PAPER", set: "setSimple930Active", clear: "clearSimple930", isActive: "isSimple930Active", get: "getSimple930Mode" },
    needsIndexOpen: true,
    telegram: { started: "TG_SIMPLE930_STARTED", entry: "TG_SIMPLE930_ENTRY", exit: "TG_SIMPLE930_EXIT", dayReport: "TG_SIMPLE930_DAYREPORT" },
    nav: { order: 11, groupId: "nav-simple930", rosterLabel: "SIMPLE_9:30" },
    commonWindow: { start: null, end: null },
    tradesFile: "simple930_paper_trades.json",
    replay: true,
  },
  {
    // Group key / env prefix EARLYBIRD; mode key and socket mode EARLY_BIRD.
    id: "earlyBird", kind: "strategy", key: "EARLYBIRD", label: "EARLYBIRD",
    modeKey: "early_bird", envPrefix: "EARLYBIRD",
    modeEnabled: { key: "EARLYBIRD_MODE_ENABLED", default: "true" },
    paperEnabled: { key: "EARLYBIRD_PAPER_ENABLED", default: "true" },
    paper:    { path: "/early-bird-paper",    module: "routes/earlyBirdPaper" },
    backtest: { path: "/early-bird-backtest", module: "routes/earlyBirdBacktest" },
    engine: "strategies/early_bird",
    broker: "fyers",
    socket: { mode: "EARLY_BIRD_PAPER", set: "setEarlyBirdActive", clear: "clearEarlyBird", isActive: "isEarlyBirdActive", get: "getEarlyBirdMode" },
    needsIndexOpen: true,
    telegram: { started: "TG_EARLYBIRD_STARTED", entry: "TG_EARLYBIRD_ENTRY", exit: "TG_EARLYBIRD_EXIT", dayReport: "TG_EARLYBIRD_DAYREPORT" },
    nav: { order: 12, groupId: "nav-early-bird", rosterLabel: "EarlyBird" },
    commonWindow: { start: null, end: null },
    tradesFile: "early_bird_paper_trades.json",
    replay: true,
  },
];

// Historic orders of lists that were derived from ENTRIES but never used the
// roster order. Kept by id so each derived list is identical to its old literal.
const ORDERS = {
  // tradeLogger FILE_BY_MODE / DAILY_PREFIX_BY_MODE, skipLogger FILE_PREFIX_BY_MODE.
  logs: [
    "emaRsiSt", "bbRsi", "pa", "orb", "ema9vwap", "trendPb", "trendDayScalp", "haScalp",
    "prevOrbScalp", "itm20Scalp", "earlyBird", "rsiPivotSt", "emaRsiStV2", "stRsiPivBb",
    "sailVwapSt", "pivotEmaSt", "gapRunaway", "gapRunawayStk", "simple930",
  ],
  // PAPER_SOURCES of edgeAnalytics / lossesAnalyzer / consolidationReport.
  reports: [
    "emaRsiSt", "emaRsiStV2", "stRsiPivBb", "sailVwapSt", "pivotEmaSt", "gapRunaway",
    "gapRunawayStk", "bbRsi", "pa", "orb", "ema9vwap", "trendPb", "trendDayScalp", "haScalp",
    "prevOrbScalp", "itm20Scalp", "rsiPivotSt", "simple930", "earlyBird",
  ],
  // tickReplay MODE_TO_MODULE / _MODE_TO_CANONICAL_FILE (replayable routes only).
  replay: [
    "pa", "bbRsi", "emaRsiSt", "emaRsiStV2", "orb", "ema9vwap", "trendPb", "trendDayScalp",
    "haScalp", "prevOrbScalp", "itm20Scalp", "earlyBird", "rsiPivotSt", "sailVwapSt", "simple930",
  ],
};

function _deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) _deepFreeze(v);
  }
  return o;
}
_deepFreeze(ENTRIES);
_deepFreeze(ORDERS);

const _byId = new Map(ENTRIES.map((e) => [e.id, e]));

/** Every entry (strategies + the scanner tool), roster order. */
function all() { return ENTRIES; }
/** kind === "strategy" only. */
function strategies() { return ENTRIES.filter((e) => e.kind === "strategy"); }
function byId(id) { return _byId.get(id) || null; }
function byKey(key) { return ENTRIES.find((e) => e.key === key) || null; }
function byModeKey(modeKey) { return ENTRIES.find((e) => e.modeKey === modeKey) || null; }
function bySocketMode(mode) { return ENTRIES.find((e) => e.socket.mode === mode) || null; }
/** Entries in a named historic order (see ORDERS). */
function inOrder(name) {
  const ids = ORDERS[name];
  if (!ids) throw new Error(`strategyRegistry: unknown order "${name}"`);
  return ids.map((id) => {
    const e = _byId.get(id);
    if (!e) throw new Error(`strategyRegistry: order "${name}" names unknown id "${id}"`);
    return e;
  });
}
/** Absolute path of a module path stored relative to src/ (paper.module, engine, …). */
function srcPath(rel) { return path.join(__dirname, "..", rel); }

module.exports = { ENTRIES, ORDERS, all, strategies, byId, byKey, byModeKey, bySocketMode, inOrder, srcPath };

/**
 * swingStrategyAdapters.js — run the live strategies' OWN signal cores over
 * stock candles, for the Swing Scanner.
 * ─────────────────────────────────────────────────────────────────────────────
 * The rule this file exists to keep: the scanner must not own a second copy of
 * any entry rule. Every adapter below calls the strategy module's exported
 * getSignal() — the same function paper/live/backtest call — and does nothing
 * but (a) hand it the right candles, (b) neutralise the assumptions that are
 * specific to intraday NIFTY options, and (c) translate its answer.
 * If an entry rule changes in src/strategies/, this page changes with it.
 *
 * WHICH STRATEGIES ARE HERE, AND WHY THE OTHERS ARE NOT
 * ────────────────────────────────────────────────────
 * A swing scan asks "is there a setup on this stock's 1-hour chart?". A
 * strategy can only answer that if its rule is a function of the candle series
 * alone. These four are:
 *
 *   EMA_RSI_ST    EMA20/50 + RSI(14) + SuperTrend(10,3)  — pure indicators
 *   BB_RSI        Bollinger(30,2) + RSI(14)              — pure indicators
 *   PA            swing structure + chart patterns       — pure price structure
 *   RSI_PIVOT_ST  RSI + prev-day pivot cross + SuperTrend — pure, given pivots
 *   BN_PIVOT_RSI_ST  the same, tuned separately for NIFTY BANK — pure, given pivots
 *   EMA_RSI_ST_V2    a separate strategy from EMA_RSI_ST — its own rules and keys
 *   BN_EMA_RSI_ST_V2 the same engine, tuned separately for NIFTY BANK — pure indicators
 *
 * The rest are excluded because their rule is not expressible on an arbitrary
 * stock timeframe, and forcing them would produce signals their author never
 * defined:
 *
 *   ORB       needs a session opening range — undefined on a weekly bar
 *   EMA9_VWAP needs session-anchored VWAP — undefined outside one trading day
 *   TDS       same (session VWAP + day gate)
 *   TREND_PB  session VWAP + a hardcoded 5m→15m derivation, no window bypass
 *
 * TWO ASSUMPTIONS THAT HAD TO BE NEUTRALISED
 * ──────────────────────────────────────────
 * 1. THE ENTRY WINDOW. Every engine refuses to signal outside 09:30–14:00 IST
 *    (or its own variant), because an intraday option trade needs time to work
 *    before EOD. A positional swing entry has no such deadline, and the bar we
 *    are judging is usually not even from today. So each adapter bypasses the
 *    window — via the strategy's own skipTimeCheck flag where it has one, or by
 *    handing it a cfg whose window spans the whole day. Nothing else is relaxed:
 *    every indicator gate still has to pass exactly as it does in paper.
 *
 * 2. POINT-BASED THRESHOLDS. This is the one that silently produces nonsense if
 *    left alone. Values like BB_RSI_MIN_BAND_WIDTH_PTS=50 or PA_MIN_SL_PTS=8 are
 *    calibrated for NIFTY at ~24,000. Applied unchanged to a ₹150 stock, a
 *    50-point minimum band width is a third of the share price and NOTHING ever
 *    signals; applied to a ₹40,000 share, an 8-point stop is 0.02% and every
 *    stop is absurdly tight. Both failures are silent — you just get an empty or
 *    a junk list.
 *
 *    So each point threshold is re-expressed as the FRACTION OF PRICE it
 *    represents on NIFTY, and that fraction is applied to the stock:
 *
 *        scaled = configured × (stockPrice / SWING_SCANNER_NIFTY_REF)
 *
 *    50pt on NIFTY@24000 = 0.208% → ₹0.31 on a ₹150 stock, ₹83 on a ₹40,000
 *    one. Your Settings value stays the source of truth; only its unit changes
 *    from "NIFTY points" to "the same percentage, on this stock". Set
 *    SWING_SCANNER_SCALE_THRESHOLDS=false to feed the raw values through
 *    instead — the scanner then reports thresholds as unscaled so a surprising
 *    result is attributable.
 *
 * CONCURRENCY: withScaledEnv() mutates process.env around the call. Every
 * getSignal() here is SYNCHRONOUS, so on Node's single thread nothing else can
 * observe the mutated env — but that is exactly why evaluation must never be
 * made async. Candle FETCHING is where the concurrency lives (swingScanner.js);
 * evaluation is a straight-line sync loop, deliberately.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const emaRsiSt   = require("../strategies/strategy1_sar_ema_rsi");
const emaRsiStV2 = require("../strategies/ema_rsi_st_v2");
const bbRsi      = require("../strategies/bb_rsi");
const priceAction= require("../strategies/price_action");
const rsiPivotSt = require("../strategies/rsi_pivot_st");
const bnPivotRsiSt = require("../strategies/bn_pivot_rsi_st");

// Every timeframe the scanner offers, in the order the dropdown shows them.
// `mins` is the bar length; 'W' is a calendar week and has no minute length.
const TIMEFRAME_KEYS = ["5", "15", "30", "60", "240", "W"];

/** NIFTY level the point-based Settings values were calibrated at. */
function niftyRef() {
  const v = parseFloat(process.env.SWING_SCANNER_NIFTY_REF || "24000");
  return Number.isFinite(v) && v > 0 ? v : 24000;
}

function scalingOn() {
  return String(process.env.SWING_SCANNER_SCALE_THRESHOLDS || "true").toLowerCase() === "true";
}

/**
 * Run `fn` with the given point-valued env keys rescaled from NIFTY points to
 * this stock's price. Restores every key afterwards, including keys that were
 * previously unset (restored to unset, not to "undefined").
 *
 * @param {Array<{key:string, def:string}>} specs point keys + their documented default
 * @param {number} price the stock's signal-bar close
 * @param {Function} fn  SYNCHRONOUS function to run
 * @returns {{ value:*, scaled: Object<string,{from:number,to:number}> }}
 */
function withScaledEnv(specs, price, fn) {
  const scaled = {};
  if (!specs.length || !scalingOn() || !(price > 0)) {
    return { value: fn(), scaled };
  }
  const factor = price / niftyRef();
  const saved  = [];
  try {
    for (const { key, def } of specs) {
      const raw = process.env[key] !== undefined ? process.env[key] : def;
      const configured = strictNum(raw);
      if (configured === null) continue;               // leave a malformed value alone
      saved.push([key, process.env[key]]);
      // 4 decimals: a ₹40 stock scaling a 3-point buffer lands at 0.005 — round
      // to 2 and it becomes 0.01, a 100% error on the threshold.
      const next = Math.round(configured * factor * 10000) / 10000;
      process.env[key] = String(next);
      scaled[key] = { from: configured, to: next };
    }
    return { value: fn(), scaled };
  } finally {
    for (const [key, prev] of saved) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

/**
 * Parse a config number STRICTLY. Bare parseFloat("8o") returns 8, so a typo in
 * a threshold silently becomes a different, plausible-looking threshold — the
 * same failure bb_rsi.js's num() already guards against. Here it would be worse:
 * the value is then multiplied by a price ratio and used to judge every stock in
 * the universe. Anything that is not a complete number is refused, and the
 * caller leaves the operator's text exactly as written.
 */
function strictNum(raw) {
  const t = String(raw).trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

/** BUY_CE → LONG, BUY_PE → SHORT, anything else → null. */
function sideFromSignal(sig) {
  if (sig === "BUY_CE") return "LONG";
  if (sig === "BUY_PE") return "SHORT";
  return null;
}

function num(v) { return Number.isFinite(v) ? v : null; }
function r2(v)  { return Number.isFinite(v) ? Math.round(v * 100) / 100 : null; }

// ─────────────────────────────────────────────────────────────────────────────
// Adapters
// ─────────────────────────────────────────────────────────────────────────────

const ADAPTERS = [
  {
    key:        "EMA_RSI_ST",
    label:      "EMA_RSI_ST",
    envKey:     "EMA_RSI_ST_MODE_ENABLED",
    blurb:      "EMA20/50 alignment + RSI band + SuperTrend(10,3) side. Trend-following.",
    timeframes: TIMEFRAME_KEYS,                 // no absolute-point gate anywhere
    needsDaily: false,
    stateful:   false,
    scaleKeys:  [],
    minBars() {
      const slow = parseInt(process.env.EMA_RSI_ST_EMA_SLOW || "50", 10) || 50;
      return Math.max(slow, 30) + 5;            // mirrors the module's own WARMUP
    },
    evaluate(candles) {
      const s = emaRsiSt.getSignal(candles, { silent: true, skipTimeCheck: true });
      return {
        side:   sideFromSignal(s.signal),
        reason: s.reason || "",
        stop:   num(s.stopLoss),
        target: null,
        indicators: {
          RSI:        r2(s.rsi),
          EMA20:      r2(s.ema20),
          EMA50:      r2(s.ema50),
          SuperTrend: r2(s.supertrend),
          STtrend:    s.stTrend === 1 ? "up" : s.stTrend === -1 ? "down" : null,
        },
      };
    },
  },

  {
    key:        "EMA_RSI_ST_V2",
    label:      "EMA_RSI_ST_V2",
    // Defaults OFF, unlike every other adapter. The caller gates on this key, so a
    // V2 that is not switched on in Settings simply does not appear here.
    envKey:     "EMA_RSI_ST_V2_MODE_ENABLED",
    envDefault: "false",
    // A SEPARATE strategy from EMA_RSI_ST, not a mode of it: three conditions per
    // side (EMA20/50 alignment, close beyond EMA20, one RSI threshold with no cap)
    // and the SuperTrend value itself as the stop. It reads the EMA_RSI_ST_V2_* keys
    // only, so V1 and V2 tune independently.
    blurb:      "EMA20/50 alignment + close beyond EMA20 + single RSI threshold. SuperTrend is the stop.",
    timeframes: TIMEFRAME_KEYS,                 // no absolute-point gate anywhere
    needsDaily: false,                          // 5-minute intraday bars only
    stateful:   false,
    scaleKeys:  [],
    minBars() {
      return emaRsiStV2.warmupBars(emaRsiStV2.getConfig()) + 5;
    },
    evaluate(candles) {
      // skipTimeCheck widens the entry window to the whole day, exactly as the
      // EMA_RSI_ST adapter above does; every other rule stays as Settings has it.
      const s = emaRsiStV2.getSignal(candles, { silent: true, skipTimeCheck: true });
      return {
        side:   sideFromSignal(s.signal),
        reason: s.reason || s.skipReason || "",
        stop:   num(s.slSpot),
        target: null,                           // V2 has no profit target
        indicators: {
          RSI:        r2(s.rsi),
          EMA20:      r2(s.ema20),
          EMA50:      r2(s.ema50),
          SuperTrend: r2(s.supertrend),
          STtrend:    s.stTrendInt === 1 ? "up" : s.stTrendInt === -1 ? "down" : null,
        },
      };
    },
  },

  {
    key:        "BB_RSI",
    label:      "BB_RSI",
    envKey:     "BB_RSI_MODE_ENABLED",
    blurb:      "Bollinger(30,2) band touch + RSI extreme. Mean-reversion (or breakout, per Settings).",
    timeframes: TIMEFRAME_KEYS,
    needsDaily: false,
    stateful:   true,                           // memoised indicator cache — cleared per symbol
    scaleKeys:  [
      { key: "BB_RSI_MIN_BAND_WIDTH_PTS", def: "50" },
      { key: "BB_RSI_MAX_ENTRY_SL_PTS",   def: "50" },
    ],
    reset() { bbRsi.reset(); },
    minBars() {
      const bb  = parseInt(process.env.BB_RSI_BB_PERIOD  || "30", 10) || 30;
      const rsi = parseInt(process.env.BB_RSI_RSI_PERIOD || "14", 10) || 14;
      return Math.max(bb + 5, rsi + 5, 30);
    },
    evaluate(candles) {
      const s = bbRsi.getSignal(candles, { silent: true, skipTimeCheck: true });
      return {
        side:   sideFromSignal(s.signal),
        reason: s.reason || "",
        stop:   num(s.stopLoss),
        target: num(s.target),
        indicators: {
          RSI:      r2(s.rsi),
          BBupper:  r2(s.bbUpper),
          BBmiddle: r2(s.bbMiddle),
          BBlower:  r2(s.bbLower),
          ADX:      r2(s.adx),
        },
      };
    },
  },

  {
    key:        "PA",
    label:      "Price Action",
    envKey:     "PA_MODE_ENABLED",
    blurb:      "Double top/bottom + ascending/descending triangle breaks, with optional retest.",
    timeframes: TIMEFRAME_KEYS,
    needsDaily: false,
    // A breakout is REMEMBERED across bars while it waits for its retest, in
    // module-level state. One call on the last bar would therefore miss every
    // retest entry and — worse — inherit whichever symbol was scanned before.
    // So: reset, then replay the tail bar-by-bar so the pending state is built
    // from THIS symbol's own history, exactly as it is live.
    stateful:   true,
    replayBars: 40,
    scaleKeys:  [
      { key: "PA_MIN_BODY",          def: "5"  },
      { key: "PA_SL_BUFFER_PTS",     def: "3"  },
      { key: "PA_MIN_SL_PTS",        def: "8"  },
      { key: "PA_MAX_SL_PTS",        def: "25" },
      { key: "PA_CHART_PATTERN_TOL", def: "12" },
      { key: "PA_RETEST_TOL_PTS",    def: "10" },
      { key: "PA_TREND_FLAT_BAND",   def: "0"  },
    ],
    reset() { priceAction.reset(); },
    minBars() {
      const sr = parseInt(process.env.PA_SR_LOOKBACK || "30", 10) || 30;
      return Math.max(sr + 5, 30);
    },
    evaluate(candles, ctx) {
      // Replay the tail so _pendingBreakout is this symbol's own.
      const n     = candles.length;
      const start = Math.max(this.minBars(), n - (ctx.replayBars || this.replayBars));
      let s = null;
      for (let i = start; i <= n; i++) {
        s = priceAction.getSignal(candles.slice(0, i), { silent: true, skipTimeCheck: true });
      }
      return {
        side:   sideFromSignal(s.signal),
        reason: s.reason || "",
        stop:   num(s.stopLoss),
        target: num(s.target),
        indicators: {
          Pattern:      s.pattern || null,
          PatternLevel: r2(s.patternLevel),
          SRlevel:      r2(s.srLevel),
        },
      };
    },
  },

  {
    key:        "RSI_PIVOT_ST",
    label:      "RSI Pivot ST",
    envKey:     "RSI_PIVOT_ST_MODE_ENABLED",
    blurb:      "Close crosses the previous day's R1 (or S1) with RSI confirming, stopped by SuperTrend.",
    // Weekly is excluded on purpose: the levels are PREVIOUS-DAY pivots, and the
    // module itself refuses a series that carries one bar per day. A weekly bar
    // crossing yesterday's R1 is not a statement anyone defined.
    timeframes: ["5", "15", "30", "60", "240"],
    timeframeNote: "Uses previous-day pivots, so it needs intraday bars — weekly is not defined for it.",
    needsDaily: true,
    stateful:   false,
    scaleKeys:  [{ key: "RSI_PIVOT_ST_PIVOT_BUFFER_PTS", def: "0" }],
    minBars() {
      const cfg = rsiPivotSt.getConfig();
      return Math.max(cfg.rsiPeriod + 2, cfg.stPeriod + 2, 20);
    },
    evaluate(candles, ctx) {
      const base = rsiPivotSt.getConfig();
      // Widen the entry window to the whole day. Everything else — RSI bands,
      // SuperTrend period/multiplier, pivot buffer — stays exactly as Settings
      // has it. resolutionMins must match the bars we are handing over, since
      // the module derives each bar's CLOSE time from it.
      const cfg = Object.assign({}, base, {
        resolutionMins:  ctx.tfMinutes || base.resolutionMins,
        sessionStartMin: 0,
        entryStartMin:   0,
        entryEndMin:     24 * 60,
        pivotBufferPts:  parseFloat(process.env.RSI_PIVOT_ST_PIVOT_BUFFER_PTS || "0") || 0,
      });
      const s = rsiPivotSt.getSignal(candles, {
        cfg,
        silent:       true,
        dailyCandles: ctx.dailyCandles || [],
      });
      return {
        side:   sideFromSignal(s.signal),
        reason: s.reason || s.skipReason || "",
        stop:   num(s.slSpot),
        target: null,
        indicators: {
          RSI:        r2(s.rsi),
          Pivot:      r2(s.pp),
          R1:         r2(s.r1),
          S1:         r2(s.s1),
          SuperTrend: r2(s.superTrend),
        },
      };
    },
  },

  {
    key:        "BN_PIVOT_RSI_ST",
    label:      "BN Pivot RSI ST",
    envKey:     "BN_PIVOT_RSI_ST_MODE_ENABLED",
    // Same rules as RSI_PIVOT_ST, but reading the BN_PIVOT_RSI_ST_* Settings keys,
    // so the NIFTY BANK engine can be tuned without touching the NIFTY one.
    blurb:      "Close crosses the previous day's R1 (or S1) with RSI confirming, stopped by SuperTrend.",
    // Weekly is excluded on purpose: the levels are PREVIOUS-DAY pivots, and the
    // module itself refuses a series that carries one bar per day. A weekly bar
    // crossing yesterday's R1 is not a statement anyone defined.
    timeframes: ["5", "15", "30", "60", "240"],
    timeframeNote: "Uses previous-day pivots, so it needs intraday bars — weekly is not defined for it.",
    needsDaily: true,
    stateful:   false,
    scaleKeys:  [{ key: "BN_PIVOT_RSI_ST_PIVOT_BUFFER_PTS", def: "0" }],
    minBars() {
      const cfg = bnPivotRsiSt.getConfig();
      return Math.max(cfg.rsiPeriod + 2, cfg.stPeriod + 2, 20);
    },
    evaluate(candles, ctx) {
      const base = bnPivotRsiSt.getConfig();
      // Widen the entry window to the whole day. Everything else — RSI bands,
      // SuperTrend period/multiplier, pivot buffer — stays exactly as Settings
      // has it. resolutionMins must match the bars we are handing over, since
      // the module derives each bar's CLOSE time from it.
      const cfg = Object.assign({}, base, {
        resolutionMins:  ctx.tfMinutes || base.resolutionMins,
        sessionStartMin: 0,
        entryStartMin:   0,
        entryEndMin:     24 * 60,
        pivotBufferPts:  parseFloat(process.env.BN_PIVOT_RSI_ST_PIVOT_BUFFER_PTS || "0") || 0,
      });
      const s = bnPivotRsiSt.getSignal(candles, {
        cfg,
        silent:       true,
        dailyCandles: ctx.dailyCandles || [],
      });
      return {
        side:   sideFromSignal(s.signal),
        reason: s.reason || s.skipReason || "",
        stop:   num(s.slSpot),
        target: null,
        indicators: {
          RSI:        r2(s.rsi),
          Pivot:      r2(s.pp),
          R1:         r2(s.r1),
          S1:         r2(s.s1),
          SuperTrend: r2(s.superTrend),
        },
      };
    },
  },

  {
    key:        "BN_EMA_RSI_ST_V2",
    label:      "BN EMA_RSI_ST_V2",
    // Defaults OFF for the same reason as its NIFTY sibling: unproven, so it
    // stays out of the scanner until it is switched on in Settings.
    envKey:     "BN_EMA_RSI_ST_V2_MODE_ENABLED",
    envDefault: "false",
    // The SAME engine as EMA_RSI_ST_V2, read through the BN_EMA_RSI_ST_V2_* env
    // prefix, so the NIFTY and NIFTY BANK versions tune independently. On the
    // scanner it evaluates the same rules against whatever stock series it is
    // handed — the underlying only decides live/paper option selection.
    blurb:      "EMA20/50 alignment + close beyond EMA20 + single RSI threshold. SuperTrend is the stop. (NIFTY BANK tuning.)",
    timeframes: TIMEFRAME_KEYS,                 // no absolute-point gate anywhere
    needsDaily: false,                          // 5-minute intraday bars only
    stateful:   false,
    scaleKeys:  [],
    minBars() {
      return emaRsiStV2.warmupBars(emaRsiStV2.getConfig("BN_EMA_RSI_ST_V2")) + 5;
    },
    evaluate(candles) {
      // skipTimeCheck widens the entry window to the whole day, exactly as the
      // sibling adapters do; every other rule stays as Settings has it.
      const s = emaRsiStV2.getSignal(candles, { silent: true, skipTimeCheck: true, prefix: "BN_EMA_RSI_ST_V2" });
      return {
        side:   sideFromSignal(s.signal),
        reason: s.reason || s.skipReason || "",
        stop:   num(s.slSpot),
        target: null,                           // no profit target
        indicators: {
          RSI:        r2(s.rsi),
          EMA20:      r2(s.ema20),
          EMA50:      r2(s.ema50),
          SuperTrend: r2(s.supertrend),
          STtrend:    s.stTrendInt === 1 ? "up" : s.stTrendInt === -1 ? "down" : null,
        },
      };
    },
  },
];

const BY_KEY = new Map(ADAPTERS.map(a => [a.key, a]));

/**
 * The adapters whose strategy is switched ON in Settings, in sidebar order.
 * Read live from process.env — a Settings save mutates env in place, so the
 * dropdown must never be cached across requests.
 */
function activeAdapters() {
  // `envDefault` lets an adapter ship OFF. Every legacy strategy defaults ON, so
  // the fallback stays "true"; EMA_RSI_ST_V2 and BN_EMA_RSI_ST_V2 set "false" and stay out
  // of the scanner until it is switched on in Settings. Without this the adapter's
  // own "Defaults OFF" comment was untrue and V2 appeared here while Settings,
  // the sidebar and the monitors all showed it disabled.
  return ADAPTERS.filter(
    (a) => String(process.env[a.envKey] || a.envDefault || "true").toLowerCase() === "true");
}

function getAdapter(key) {
  return BY_KEY.get(String(key || "").trim().toUpperCase()) || null;
}

/** True when this strategy can be evaluated on this timeframe. */
function supportsTimeframe(adapter, tf) {
  return !!adapter && adapter.timeframes.includes(String(tf));
}

/**
 * Evaluate one symbol. Wraps the adapter with the two neutralisations — state
 * reset and price-scaled thresholds — so no caller can forget either.
 *
 * @returns {{ side, reason, stop, target, indicators, scaled }}
 */
function evaluateSymbol(adapter, candles, ctx) {
  if (typeof adapter.reset === "function") adapter.reset();
  const price = candles.length ? candles[candles.length - 1].close : 0;
  const { value, scaled } = withScaledEnv(adapter.scaleKeys, price, () => adapter.evaluate(candles, ctx));
  return Object.assign({ scaled }, value);
}

module.exports = {
  ADAPTERS, TIMEFRAME_KEYS,
  activeAdapters, getAdapter, supportsTimeframe, evaluateSymbol,
  // exported for the regression suite
  withScaledEnv, sideFromSignal, niftyRef, scalingOn, strictNum,
};

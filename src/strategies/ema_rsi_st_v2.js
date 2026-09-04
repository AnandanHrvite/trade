/**
 * STRATEGY: EMA_RSI_ST_V2  (created 2026-09-04)
 *
 * A deliberate SIMPLIFICATION of EMA_RSI_ST (src/strategies/strategy1_sar_ema_rsi.js).
 * V1 is untouched; the two tune independently under their own env prefixes
 * (EMA_RSI_ST_* vs EMA_RSI_ST_V2_*).
 *
 * Indicators: EMA20 (close) · EMA50 (close) · RSI(14) · SuperTrend(10,2).
 *
 * ENTRY — BUY_CE, ALL true on a FINISHED 5-min candle:
 *   1. EMA20 > EMA50
 *   2. the candle CLOSES above EMA20
 *   3. RSI(14) > EMA_RSI_ST_V2_RSI_CE_MIN  (default 52)
 *
 * ENTRY — BUY_PE, the exact mirror:
 *   1. EMA20 < EMA50
 *   2. the candle CLOSES below EMA20
 *   3. RSI(14) < EMA_RSI_ST_V2_RSI_PE_MAX  (default 48)
 *
 * DELIBERATE DIFFERENCES FROM V1 — do NOT "helpfully" add these back:
 *   • NO SuperTrend gate on ENTRY. V1 requires ST bullish for CE / bearish for PE.
 *     V2 does not: SuperTrend is used ONLY as the stop (see below). A V2 CE entry
 *     can legitimately fire while SuperTrend is red.
 *   • NO RSI upper/lower cap. V1 blocks CE at RSI >= 80 (overbought) and PE at
 *     RSI <= 20 (oversold). V2 has a SINGLE threshold per side and no cap at all,
 *     so RSI 95 is a valid CE entry.
 *   • NO EMA9 triple-stack option, and NO EMA21 anywhere — not in the entry, not in
 *     the exit, not in the trail. V1 computes EMA21(OHLC4) and trails on it; V2's
 *     only trail is SuperTrend.
 *
 * WHICH BAR IS READ: every indicator reads the LAST FULLY CLOSED candle. The last
 * element of `candles` is the signal candle. Nothing reads the live/forming bar and
 * nothing reads live spot, so Paper and Replay reproduce bit-for-bit.
 *
 * CONFIRMATION CANDLE (kept from V1, default ON —
 * EMA_RSI_ST_V2_CONFIRM_CANDLE_ENABLED): the signal candle does NOT enter. Its
 * CLOSE becomes the trigger; during the IMMEDIATELY-next candle price must cross
 * that close (CE strictly above / PE strictly below) and the fill happens intra-bar
 * at the crossing price. Paper/Live fill at the first tick past the trigger;
 * Backtest fills at the same market moment via confirmCandle.barCrossFill.
 *
 * STOP LOSS — SuperTrend(10, 2), and nothing else:
 *   Initial SL  = the SuperTrend value at entry (below price for CE, above for PE).
 *   Trailing SL = the SuperTrend value re-read at every candle close, TIGHTEN-ONLY
 *                 (CE may only move up, PE only down), enforced INTRA-CANDLE by the
 *                 execution layer on each tick.
 *   There is NO negative-candle stop, NO option-premium stop, NO fixed-point stop
 *   and NO profit target. The only other exit is the hard 14:00 close.
 *
 * Timeframe: 5-min (TRADE_RESOLUTION) · entry window 10:30–13:00 IST
 *            (EMA_RSI_ST_V2_ENTRY_START / _ENTRY_END) · hard square-off 14:00
 *            (EMA_RSI_ST_V2_EOD_EXIT_TIME).
 *
 * WARM-UP: EMA_SLOW + 5 candles are refused outright (warmup:true). At the default
 * 50/5-min that is 55 bars ≈ 4.6 hours, i.e. MORE than one session — so the paper
 * route must preload previous DAYS, not just today.
 */

const { EMA, RSI } = require("technicalindicators");
const { computeSuperTrend } = require("../utils/supertrend");

// ── Prefix parameterisation ────────────────────────────────────────────────
// This ONE engine serves both index variants. Every function takes an optional
// env prefix so the NIFTY and NIFTY BANK strategies share a single implementation
// of the rules and can still be tuned independently:
//   EMA_RSI_ST_V2_*     → NIFTY 50        (routes /ema_rsi_st_v2-*)
//   BN_EMA_RSI_ST_V2_*  → NIFTY BANK      (routes /bn_ema_rsi_st_v2-*)
// Sharing the engine is deliberate: BN_PIVOT_RSI_ST duplicated its engine file to
// clone a strategy onto NIFTY BANK, and its own regression test exists purely to
// catch the two copies drifting apart. A shared engine cannot drift.
const DEFAULT_PREFIX = "EMA_RSI_ST_V2";
const PREFIXES = { EMA_RSI_ST_V2: "NIFTY", BN_EMA_RSI_ST_V2: "BANKNIFTY" };
/** The underlying an env prefix trades. Unknown prefixes fall back to NIFTY. */
function underlyingFor(prefix) { return PREFIXES[prefix || DEFAULT_PREFIX] || "NIFTY"; }

const NAME        = "EMA_RSI_ST_V2";
const DESCRIPTION = "EMA_RSI_ST_V2 | EMA20/EMA50(close) + RSI(14) + SuperTrend(10,2) | EMA alignment + close-beyond-EMA20 + single RSI threshold (no ST entry gate, no RSI cap) | SuperTrend-only trailing SL | 10:30–13:00 entries, hard close 14:00";

// ── Trading window ────────────────────────────────────────────────────────
// V2 owns its OWN window keys — it must not inherit V1's TRADE_ENTRY_START/END,
// which are shared globals V1 reads.
function _parseMins(envKey, fallback) {
  var v = process.env[envKey] || fallback;
  var parts = String(v).split(":");
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  if (!Number.isFinite(h)) return _parseMins(null, fallback);
  return h * 60 + (Number.isFinite(m) ? m : 0);
}
function _fmtTime(mins) {
  var h = Math.floor(mins / 60), m = mins % 60;
  var suffix = h >= 12 ? "PM" : "AM";
  var h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return h12 + ":" + (m < 10 ? "0" : "") + m + " " + suffix;
}

function isInTradingWindow(unixSec, prefix) {
  var P = prefix || DEFAULT_PREFIX;
  // Fast IST conversion: UTC+5:30 = +19800 seconds (avoids expensive toLocaleString/ICU)
  var istSec   = unixSec + 19800;
  var totalMin = Math.floor(istSec / 60) % 1440;
  var startMin = _parseMins(P + "_ENTRY_START", "10:30");
  var endMin   = _parseMins(P + "_ENTRY_END",   "13:00");
  if (totalMin < startMin) return { ok: false, reason: "Before " + _fmtTime(startMin) + " — outside the V2 entry window" };
  if (totalMin >= endMin)  return { ok: false, reason: "After " + _fmtTime(endMin) + " — no new entries (EOD risk)" };
  return { ok: true, reason: null };
}

/**
 * getConfig() — live read of process.env. NEVER cached, so a Settings save
 * applies to a running session without a restart.
 */
function getConfig(prefix) {
  var P = prefix || DEFAULT_PREFIX;
  var e = process.env;
  var emaFast = parseInt(e[P + "_EMA_FAST"] || "20", 10);
  var emaSlow = parseInt(e[P + "_EMA_SLOW"] || "50", 10);
  var rsiPeriod = parseInt(e[P + "_RSI_PERIOD"] || "14", 10);
  var stPeriod  = parseInt(e[P + "_SUPERTREND_PERIOD"] || "10", 10);
  var stMult    = parseFloat(e[P + "_SUPERTREND_MULT"] || "2");
  var rsiCeMin  = parseFloat(e[P + "_RSI_CE_MIN"] || "52");
  var rsiPeMax  = parseFloat(e[P + "_RSI_PE_MAX"] || "48");
  return {
    PREFIX: P,
    EMA_FAST:   Number.isFinite(emaFast) && emaFast   > 0 ? emaFast   : 20,
    EMA_SLOW:   Number.isFinite(emaSlow) && emaSlow   > 0 ? emaSlow   : 50,
    RSI_PERIOD: Number.isFinite(rsiPeriod) && rsiPeriod > 0 ? rsiPeriod : 14,
    ST_PERIOD:  Number.isFinite(stPeriod) && stPeriod > 0 ? stPeriod  : 10,
    ST_MULT:    Number.isFinite(stMult)   && stMult   > 0 ? stMult    : 2,
    RSI_CE_MIN: Number.isFinite(rsiCeMin) ? rsiCeMin : 52,
    RSI_PE_MAX: Number.isFinite(rsiPeMax) ? rsiPeMax : 48,
  };
}

// Number of candles the engine refuses below. Exported so the paper route can size
// its preload in DAYS and the backtest can fetch a runway before the requested start.
function warmupBars(cfg) {
  // Accepts either a resolved config object or a prefix string.
  if (typeof cfg === "string") cfg = getConfig(cfg);
  cfg = cfg || getConfig();
  return Math.max(cfg.EMA_SLOW, cfg.ST_PERIOD + 1, cfg.RSI_PERIOD + 1, 30) + 5;
}

function _num(x) { return typeof x === "number" && Number.isFinite(x); }

/**
 * computeSeries(candles, cfg) — time-aligned indicator series.
 *
 * Every returned array is 1:1 with `candles` (null on warm-up bars), so a chart
 * plots the EXACT numbers the signal read. Alignment for the
 * `technicalindicators` package: EMA(p) over N values yields N−p+1 outputs where
 * out[i] ↔ values[i+p-1]; RSI(L) over M values yields M−L outputs where
 * out[j] ↔ values[j+L].
 */
function computeSeries(candles, cfg) {
  if (typeof cfg === "string") cfg = getConfig(cfg);
  cfg = cfg || getConfig();
  var n = candles.length;
  var closes = candles.map(function (c) { return c.close; });

  var emaFast = new Array(n).fill(null);
  var emaSlow = new Array(n).fill(null);
  var rsi     = new Array(n).fill(null);

  var fastArr = EMA.calculate({ period: cfg.EMA_FAST, values: closes });
  for (var i = 0; i < fastArr.length; i++) emaFast[i + cfg.EMA_FAST - 1] = fastArr[i];

  var slowArr = EMA.calculate({ period: cfg.EMA_SLOW, values: closes });
  for (var j = 0; j < slowArr.length; j++) emaSlow[j + cfg.EMA_SLOW - 1] = slowArr[j];

  var rsiArr = RSI.calculate({ period: cfg.RSI_PERIOD, values: closes });
  for (var k = 0; k < rsiArr.length; k++) rsi[k + cfg.RSI_PERIOD] = rsiArr[k];

  var st = computeSuperTrend(candles, cfg.ST_PERIOD, cfg.ST_MULT);

  return { emaFast: emaFast, emaSlow: emaSlow, rsi: rsi, supertrend: st };
}

/**
 * getSignal(candles, opts)
 *
 * candles: ascending [{ time, open, high, low, close }]. The LAST element is the
 * SIGNAL candle and must be a FULLY CLOSED bar — V2 has no intra-candle entry path.
 *
 * Returns { signal: "BUY_CE"|"BUY_PE"|"NONE", reason, warmup, stopLoss, slSpot,
 *           entrySpot, triggerLevel, rsi, ema20, ema50, supertrend, stTrend,
 *           stTrendInt, prevCandleHigh, prevCandleLow, signalStrength }.
 *
 * `stopLoss` is the SuperTrend value — the initial stop AND the seed of the trail.
 * signalStrength is always "STRONG" (kept for the VIX gate's call shape, which only
 * hard-blocks above VIX_MAX_ENTRY).
 */
function getSignal(candles, opts) {
  var silent = (opts && opts.silent === true);
  var prefix = (opts && opts.prefix) || DEFAULT_PREFIX;
  var cfg    = getConfig(prefix);
  var WARMUP = warmupBars(cfg);

  if (!Array.isArray(candles) || candles.length < WARMUP) {
    return {
      signal: "NONE",
      warmup: true,
      reason: "Warming up (" + (Array.isArray(candles) ? candles.length : 0) + "/" + WARMUP + " candles)",
      stopLoss: null, slSpot: null, entrySpot: null, triggerLevel: null,
      prevCandleHigh: null, prevCandleLow: null,
    };
  }

  var signalCandle = candles[candles.length - 1];
  var prevCandle   = candles[candles.length - 2];

  // The signal candle's own OHLC must be real numbers BEFORE any indicator maths.
  // Number(null) === 0 and Number("") === 0, so a missing close otherwise flows into
  // the EMA/RSI series as a 0 and "0 < EMA20" reads as a perfectly good PE entry.
  if (!signalCandle || !prevCandle ||
      !_num(signalCandle.close) || !_num(signalCandle.high) || !_num(signalCandle.low) ||
      !_num(prevCandle.high) || !_num(prevCandle.low)) {
    return {
      signal: "NONE",
      warmup: true,
      reason: "Bad candle data (non-finite OHLC on the signal or previous candle)",
      stopLoss: null, slSpot: null, entrySpot: null, triggerLevel: null,
      prevCandleHigh: null, prevCandleLow: null,
    };
  }

  // skipTimeCheck: bypass the entry window. Used ONLY by at-exit indicator snapshots
  // (so an EOD exit still logs indicator values) — never by the entry path.
  var skipTimeCheck = (opts && opts.skipTimeCheck === true);
  var windowCheck = skipTimeCheck ? { ok: true, reason: null } : isInTradingWindow(signalCandle.time, prefix);
  if (!windowCheck.ok) {
    return {
      signal: "NONE",
      warmup: false,
      reason: windowCheck.reason,
      stopLoss: null, slSpot: null, entrySpot: null, triggerLevel: null,
      prevCandleHigh: signalCandle.high,
      prevCandleLow:  signalCandle.low,
    };
  }

  // ── Indicators — all read the LAST CLOSED candle ────────────────────────────
  var series = computeSeries(candles, cfg);
  var last   = candles.length - 1;
  var emaFast = series.emaFast[last];
  var emaSlow = series.emaSlow[last];
  var rsi     = series.rsi[last];
  var currST  = series.supertrend[last];

  // Number.isFinite guards throughout: Number(null)===0 and Number("")===0, so a
  // coerced check would silently invent a price and open a trade on a missing bar.
  if (!_num(emaFast) || !_num(emaSlow) || !_num(rsi) ||
      !currST || !_num(currST.value) || (currST.trend !== 1 && currST.trend !== -1)) {
    return {
      signal: "NONE",
      warmup: true,
      reason: "Indicators not ready",
      stopLoss: null, slSpot: null, entrySpot: null, triggerLevel: null,
      prevCandleHigh: signalCandle.high,
      prevCandleLow:  signalCandle.low,
    };
  }

  var stVal = currST.value;

  var base = {
    ema20:      Math.round(emaFast * 100) / 100,
    ema50:      Math.round(emaSlow * 100) / 100,
    // EMA9 / EMA21 do not exist in V2. Kept as explicit nulls so every shared screen
    // and trade-record consumer that reads them renders "—" instead of undefined.
    ema9:       null,
    ema21:      null,
    rsi:        Math.round(rsi * 10) / 10,
    supertrend: stVal,
    stTrend:    currST.trend === 1 ? "BULLISH" : "BEARISH",
    stTrendInt: currST.trend,
    trendSource: "SUPERTREND",
    prevCandleHigh: prevCandle.high,
    prevCandleLow:  prevCandle.low,
    // The signal candle's CLOSE — the confirmation-candle trigger level.
    triggerLevel: signalCandle.close,
    entrySpot:    signalCandle.close,
    stopLoss:     null,
    slSpot:       null,
    warmup:       false,
    signalStrength: "STRONG",
  };

  // ── The three conditions per side ───────────────────────────────────────────
  var emaUp   = emaFast > emaSlow;                       // 1. EMA20 above EMA50
  var emaDown = emaFast < emaSlow;                       // 1. EMA20 below EMA50
  var closeOkCE = signalCandle.close > emaFast;          // 2. close beyond EMA20
  var closeOkPE = signalCandle.close < emaFast;
  var rsiCE = rsi > cfg.RSI_CE_MIN;                      // 3. single threshold, NO cap
  var rsiPE = rsi < cfg.RSI_PE_MAX;

  var _istTime = new Date(signalCandle.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  if (!silent) console.log(
    "[" + (prefix === DEFAULT_PREFIX ? "V2" : "BN-V2") + " " + _istTime + "] EMA20=" + emaFast.toFixed(1) + " EMA50=" + emaSlow.toFixed(1) +
    "(" + (emaUp ? "20>50" : emaDown ? "20<50" : "=") + ")" +
    " | RSI=" + rsi.toFixed(1) +
    " | ST=" + stVal + "(" + (currST.trend === 1 ? "BULL" : "BEAR") + ", stop only)" +
    " | C=" + signalCandle.close
  );

  // SuperTrend is the ONLY stop this strategy has. Because there is no SuperTrend
  // ENTRY gate (deliberate — see the header), the entry conditions can be met while
  // the SuperTrend line sits on the WRONG side of price: above the close for a CE,
  // below it for a PE. Such a trade would open with its stop already breached.
  //
  // The user specified SuperTrend and nothing else as the stop, so there is no
  // fallback level to fall back TO — inventing one (the previous candle's extreme)
  // was measured on 2024-25 NIFTY data to place 67 stops on the wrong side of entry
  // anyway, because a candle that closes past EMA20 often closes past its own
  // previous extreme too. The correct behaviour is therefore to SKIP the trade and
  // say why, not to open an unprotectable position.
  var stProtectsCE = stVal < signalCandle.close;
  var stProtectsPE = stVal > signalCandle.close;

  // ── BUY CE ──────────────────────────────────────────────────────────────────
  if (emaUp && closeOkCE && rsiCE) {
    if (!stProtectsCE) {
      if (!silent) console.log("  ⛔ CE setup met but SuperTrend " + stVal + " is ABOVE close " + signalCandle.close + " — no protective stop, skipping");
      return Object.assign({}, base, {
        signal: "NONE",
        skipReason: "st_above_price",
        reason: "CE setup met but SuperTrend " + stVal + " >= close " + signalCandle.close +
                " — the ST stop would sit above entry, so no trade",
      });
    }
    var slCE = parseFloat(stVal.toFixed(2));
    if (!silent) console.log("  🟢 BUY_CE — EMA20>50 | C " + signalCandle.close + ">EMA20 " + emaFast.toFixed(1) + " | RSI " + rsi.toFixed(1) + ">" + cfg.RSI_CE_MIN + " | SL(ST)=" + slCE);
    return Object.assign({}, base, {
      signal:   "BUY_CE",
      stopLoss: slCE,
      slSpot:   slCE,
      reason:   "CE: EMA20>50 | C " + signalCandle.close + ">EMA20 " + emaFast.toFixed(1) +
                " | RSI=" + rsi.toFixed(1) + ">" + cfg.RSI_CE_MIN + " | SL=ST " + slCE,
    });
  }

  // ── BUY PE ──────────────────────────────────────────────────────────────────
  if (emaDown && closeOkPE && rsiPE) {
    if (!stProtectsPE) {
      if (!silent) console.log("  ⛔ PE setup met but SuperTrend " + stVal + " is BELOW close " + signalCandle.close + " — no protective stop, skipping");
      return Object.assign({}, base, {
        signal: "NONE",
        skipReason: "st_below_price",
        reason: "PE setup met but SuperTrend " + stVal + " <= close " + signalCandle.close +
                " — the ST stop would sit below entry, so no trade",
      });
    }
    var slPE = parseFloat(stVal.toFixed(2));
    if (!silent) console.log("  🔴 BUY_PE — EMA20<50 | C " + signalCandle.close + "<EMA20 " + emaFast.toFixed(1) + " | RSI " + rsi.toFixed(1) + "<" + cfg.RSI_PE_MAX + " | SL(ST)=" + slPE);
    return Object.assign({}, base, {
      signal:   "BUY_PE",
      stopLoss: slPE,
      slSpot:   slPE,
      reason:   "PE: EMA20<50 | C " + signalCandle.close + "<EMA20 " + emaFast.toFixed(1) +
                " | RSI=" + rsi.toFixed(1) + "<" + cfg.RSI_PE_MAX + " | SL=ST " + slPE,
    });
  }

  // ── No signal — explain which condition(s) failed ───────────────────────────
  var why = [];
  if (emaUp) {
    if (!closeOkCE) why.push("C " + signalCandle.close + " <=EMA20 " + emaFast.toFixed(1) + " (need close above)");
    if (!rsiCE)     why.push("RSI=" + rsi.toFixed(1) + " <=" + cfg.RSI_CE_MIN + " (need >)");
  } else if (emaDown) {
    if (!closeOkPE) why.push("C " + signalCandle.close + " >=EMA20 " + emaFast.toFixed(1) + " (need close below)");
    if (!rsiPE)     why.push("RSI=" + rsi.toFixed(1) + " >=" + cfg.RSI_PE_MAX + " (need <)");
  } else {
    why.push("EMA20=" + emaFast.toFixed(1) + " = EMA50 " + emaSlow.toFixed(1) + " (no alignment)");
  }
  if (why.length === 0) why.push("EMA " + (emaUp ? "20>50" : "20<50") + " but other conditions unmet");

  return Object.assign({}, base, {
    signal: "NONE",
    reason: why.join(" | ") + " | EMA " + (emaUp ? "20>50" : emaDown ? "20<50" : "flat"),
  });
}

/**
 * trailStop(candles, side, currentStop, cfg)
 *
 * The ONE place the SuperTrend trail is computed — the paper route, the backtest
 * and (through the harness) live all call this, so a tighten-only bug cannot exist
 * on one surface and not another.
 *
 * Returns { stop, changed, tag } — `stop` is the tightened stop (never looser than
 * `currentStop`), `changed` says whether it moved. A non-finite SuperTrend or a
 * SuperTrend on the wrong side of price leaves the stop exactly where it was.
 */
function trailStop(candles, side, currentStop, cfg) {
  if (typeof cfg === "string") cfg = getConfig(cfg);
  cfg = cfg || getConfig();
  var unchanged = { stop: currentStop, changed: false, tag: null };
  if (!Array.isArray(candles) || candles.length < cfg.ST_PERIOD + 2) return unchanged;

  var st = computeSuperTrend(candles, cfg.ST_PERIOD, cfg.ST_MULT);
  var cur = st[st.length - 1];
  if (!cur || !_num(cur.value)) return unchanged;

  var lvl = cur.value;
  // Tighten-only: CE stops may only rise, PE stops may only fall.
  if (side === "CE") {
    if (!_num(currentStop) || lvl > currentStop) {
      return { stop: parseFloat(lvl.toFixed(2)), changed: true, tag: "SuperTrend" };
    }
  } else if (side === "PE") {
    if (!_num(currentStop) || lvl < currentStop) {
      return { stop: parseFloat(lvl.toFixed(2)), changed: true, tag: "SuperTrend" };
    }
  }
  return unchanged;
}

module.exports = {
  NAME: NAME,
  DEFAULT_PREFIX: DEFAULT_PREFIX,
  PREFIXES: PREFIXES,
  underlyingFor: underlyingFor,
  DESCRIPTION: DESCRIPTION,
  getConfig: getConfig,
  warmupBars: warmupBars,
  computeSeries: computeSeries,
  getSignal: getSignal,
  trailStop: trailStop,
  isInTradingWindow: isInTradingWindow,
};

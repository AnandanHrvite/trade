/**
 * RSI_PIVOT_ST — RSI extreme + Standard Pivot R1/S1 breakout, SuperTrend-stopped
 * ═════════════════════════════════════════════════════════════════════════════
 * Single-leg NIFTY option buying, intraday, 5-minute bars, Zerodha. Two levels
 * decide the whole day, and they are fixed before the open:
 *
 *   yesterday's H/L/C ──► PP = (H+L+C)/3 ──► R1 = 2·PP − L   (the CE trigger)
 *                                       └──► S1 = 2·PP − H   (the PE trigger)
 *
 * Those levels do NOT move intraday. Only the candles move through them.
 *
 * ── ENTRY (evaluated on a CLOSED 5-minute candle, both halves required) ──────
 *   CE:  RSI(14) > RSI_PIVOT_ST_RSI_CE_MIN (70)  AND  the candle CROSSES AND
 *        CLOSES above R1 — meaning the previous candle closed at or below R1 and
 *        this one closes above it. A candle already sitting above R1 is NOT a
 *        cross; entering there is chasing a move that already happened.
 *   PE:  RSI(14) < RSI_PIVOT_ST_RSI_PE_MAX (40)  AND  the candle CROSSES AND
 *        CLOSES below S1 (previous close at or above S1, this close below).
 *
 * ── THE CONFIRMATION CANDLE (RSI_PIVOT_ST_CONFIRM_ENABLED, default ON) ──
 * With confirmation ON the crossing candle does NOT enter — it only ARMS the
 * setup. Entry needs the NEXT candle to close beyond the breakout candle's own
 * extreme: above its HIGH for CE, below its LOW for PE.
 *
 *        breakout candle:  crosses R1, closes 57656, high 57680  → armed
 *        next candle:      closes 57695  → ENTER (57695 > 57680)
 *                          closes 57660  → NO ENTRY (never cleared the high)
 *
 * This is what stops the strategy taking a candle that pokes a handful of
 * points past the pivot and stalls: clearing the breakout high requires the
 * move to actually extend. Only the IMMEDIATELY-next candle counts — an armed
 * setup that is not confirmed on that bar is dead, and a new entry needs a
 * fresh cross of the level. Turning the toggle OFF restores the old one-candle
 * rule exactly.
 *
 * RSI is read on the candle that makes the DECISION — the confirming candle
 * when confirmation is on, the crossing candle when it is off.
 *
 * ── STRIKE — 1% of spot, direction chosen in Settings ───────────────────────
 * RSI_PIVOT_ST_STRIKE_MODE = ATM | ITM | OTM (default OTM).
 *   ATM  — nearest strike to spot, the 1% distance is ignored.
 *   OTM  — 1% of spot AWAY from the money:  CE strike = spot + 1%,  PE = spot − 1%
 *   ITM  — 1% of spot INTO the money:       CE strike = spot − 1%,  PE = spot + 1%
 * The percentage is RSI_PIVOT_ST_STRIKE_PCT (default 1). The raw distance is
 * rounded to the nearest 50-point NIFTY strike, and a 1% move that rounds to 0
 * steps falls back to ATM rather than inventing a strike.
 *
 * ── STOPS — deliberately ASYMMETRIC, because the user's rules are ───────────
 *   CE:  TWO stops, both live, whichever triggers first wins:
 *          (a) SuperTrend(10, 2) on the 5-min SPOT chart — initial SL and trail.
 *              The line only ever moves in the trade's favour (a SuperTrend that
 *              ticks down mid-trade is ignored); a trail that can loosen is not
 *              a trail.
 *          (b) 25% of the ENTRY PREMIUM — a premium floor at 0.75 × entry LTP,
 *              trailed up as the premium makes new highs (high-water × 0.75).
 *   PE:  ONE stop — the 25% premium rule only. No SuperTrend on the PE side.
 *        This is the user's rule, not an oversight: do not "balance" it.
 *
 * Both stops are levels, and both are recomputed from values the route already
 * persists, so a crash-recovered position resumes on the same numbers.
 *
 * ── DELIBERATELY NOT HERE (do not "helpfully" add these) ────────────────────
 * No VIX gate, no OI filter, no ADX, no volume test, no EMA, no VWAP, no ATR
 * sizing, no multi-timeframe bias, no re-entry
 * after a stop, no breakeven jump, no partial booking, no fixed target, no
 * expiry-day rule, no quality score. There is no profit target at all — the
 * trade runs until a stop trails into it or the session forces it out.
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────
 * Every value the decision reads comes from CLOSED 5-minute candle OHLC and from
 * the PREVIOUS day's completed daily bar. Never a live tick, never a live spot.
 * The premium stop is the one exception by necessity — it reads the option LTP,
 * which is a tick — but it reads it only for the EXIT, never the entry, and the
 * route records those ticks so Replay reproduces them.
 *
 * ── NOT MARKET-VALIDATED ───────────────────────────────────────────────────
 * Zero trades, paper or live. Every threshold here is the user's stated rule or
 * a repo convention, not a fitted value. No backtest has been run against it.
 * Collect clean paper days and diff them against /replay before touching any
 * live gate.
 *
 * Contract:
 *   getConfig()                        -> live env read (never cached)
 *   computePivots(dailyCandles, opts)  -> { pp, r1, s1, r2, s2, from } for TODAY
 *   computeRsi(candles, period)        -> { values, offset } time-aligned
 *   computeSuperTrendSeries(candles,c) -> per-candle { value, trend }
 *   getSignal(candles, opts)           -> { signal, side, entrySpot, slSpot, ... }
 *   strikeForSide(spot, side, cfg)     -> the strike this strategy wants
 *   premiumStop(entryLtp, highLtp,cfg) -> the 25% premium floor, trailed
 *   superTrendStop(side, series, prev) -> the SuperTrend stop, ratcheted
 *   stopHit(side, price, stop)         -> the ONLY spot-stop test
 */

const { RSI } = require("technicalindicators");
const { computeSuperTrend } = require("../utils/supertrend");

const NAME = "RSI_PIVOT_ST";
const DESCRIPTION =
  "RSI_PIVOT_ST — RSI(14) extreme plus a 5-min candle crossing and closing beyond the previous day's " +
  "Standard Pivot R1 (CE) or S1 (PE); CE is stopped by SuperTrend and a 25% premium floor, PE by the premium floor alone";

// ── primitives ───────────────────────────────────────────────────────────────
function _r2(x) { return Math.round(x * 100) / 100; }

/** IST calendar-day index. India has no DST, so a fixed +5:30 shift is exact. */
function _istDayOf(unixSec) { return Math.floor((unixSec + 19800) / 86400); }

/** IST minutes-of-day from a unix-SECONDS candle time. */
function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }

function _istDateStr(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Parse "HH:MM" → minutes-of-day, falling back to `def` on anything malformed.
 * A typo in RSI_PIVOT_ST_ENTRY_END must not silently collapse the entry window
 * to midnight and leave the strategy mute all day without saying why.
 */
function _parseHHMM(raw, def) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(raw == null ? "" : raw));
  if (!m) return def;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return def;
  return h * 60 + mm;
}

function _fmtMins(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Finite-number guard. Number(null)===0 and Number("")===0 both invent a price. */
function _num(x) { return typeof x === "number" && Number.isFinite(x); }

function _numEnv(key, def, min, max) {
  const v = parseFloat(process.env[key]);
  if (!Number.isFinite(v)) return def;
  if (min != null && v < min) return def;
  if (max != null && v > max) return def;
  return v;
}

function _intEnv(key, def, min, max) {
  const v = parseInt(process.env[key], 10);
  if (!Number.isFinite(v)) return def;
  if (min != null && v < min) return def;
  if (max != null && v > max) return def;
  return v;
}

/** A candle usable for a decision: all four prices finite. Volume is never read. */
function _okBar(c) {
  return !!c && _num(c.open) && _num(c.high) && _num(c.low) && _num(c.close);
}

const STRIKE_MODES = ["ATM", "ITM", "OTM"];

// Which sides the premium stop applies to. "NONE" is a real, supported choice:
// it removes the floor entirely, which on PE leaves the trade with no stop at
// all (PE never carries the SuperTrend). Callers must warn, not substitute.
const PREMIUM_STOP_SIDES = ["BOTH", "CE", "PE", "NONE"];

// Which sides carry the SuperTrend stop. CE is the historical default — the
// strategy was written with the SuperTrend on the CE side alone. "PE"/"BOTH"
// mirror it: the line sits ABOVE price and a flip to BULLISH is the PE's exit.
const ST_SIDES = ["BOTH", "CE", "PE", "NONE"];

/** NIFTY strikes are struck every 50 points. Not configurable anywhere in this repo. */
const STRIKE_STEP = 50;

/**
 * Live config read. Settings saves mutate process.env in place, so this must
 * never be cached — every caller re-reads on each evaluation.
 */
function getConfig() {
  const rawStrike = String(process.env.RSI_PIVOT_ST_STRIKE_MODE || "OTM").trim().toUpperCase();
  const rawPremSides = String(process.env.RSI_PIVOT_ST_PREMIUM_SL_SIDES || "BOTH").trim().toUpperCase();
  // SuperTrend sides. The new selector wins; when it is absent we fall back to
  // the legacy CE on/off flag so an old .env is not silently re-enabled.
  const rawStSides = String(process.env.RSI_PIVOT_ST_ST_SIDES || "").trim().toUpperCase();
  const legacyCeOff = String(process.env.RSI_PIVOT_ST_ST_CE_ENABLED || "true").toLowerCase() !== "true";
  const stSides = ST_SIDES.includes(rawStSides) ? rawStSides : (legacyCeOff ? "NONE" : "CE");
  return {
    resolutionMins:  _intEnv("RSI_PIVOT_ST_RESOLUTION", 5, 1, 60),
    sessionStartMin: _parseHHMM(process.env.RSI_PIVOT_ST_SESSION_START, 9 * 60 + 15),
    entryStartMin:   _parseHHMM(process.env.RSI_PIVOT_ST_ENTRY_START,   9 * 60 + 30),
    entryEndMin:     _parseHHMM(process.env.RSI_PIVOT_ST_ENTRY_END,    15 * 60),

    // The RSI half of the entry rule.
    rsiPeriod:       _intEnv("RSI_PIVOT_ST_RSI_PERIOD", 14, 2, 100),
    rsiCeMin:        _numEnv("RSI_PIVOT_ST_RSI_CE_MIN", 70, 0, 100),
    rsiPeMax:        _numEnv("RSI_PIVOT_ST_RSI_PE_MAX", 40, 0, 100),

    // The pivot half. Buffer defaults to 0 = the close must simply be beyond R1/S1.
    pivotBufferPts:  _numEnv("RSI_PIVOT_ST_PIVOT_BUFFER_PTS", 0, 0),

    // Confirmation candle. ON (default) = the breakout candle only ARMS the
    // setup; entry waits for the NEXT candle to close beyond that breakout
    // candle's high (CE) or low (PE). OFF restores the old behaviour, where
    // the candle that crosses the pivot is itself the entry.
    confirmEnabled:  String(process.env.RSI_PIVOT_ST_CONFIRM_ENABLED || "true").toLowerCase() === "true",

    // Strike selection — 1% of spot, direction from STRIKE_MODE.
    strikeMode:      STRIKE_MODES.includes(rawStrike) ? rawStrike : "OTM",
    strikePct:       _numEnv("RSI_PIVOT_ST_STRIKE_PCT", 1, 0, 20),

    // SuperTrend — CE stop only. 10/2 is the user's stated setting.
    stPeriod:        _intEnv("RSI_PIVOT_ST_ST_PERIOD", 10, 2, 100),
    stMultiplier:    _numEnv("RSI_PIVOT_ST_ST_MULT", 2, 0.1, 10),
    // Which sides carry the SuperTrend stop: BOTH / CE (default, the original
    // rule) / PE / NONE. Legacy RSI_PIVOT_ST_ST_CE_ENABLED=false still means
    // "no SuperTrend on CE" when the newer key is not set, so an existing .env
    // keeps behaving as it did.
    stSides:         stSides,
    // Derived, kept so older readers (and every existing `cfg.stCeEnabled`
    // call site) keep working without knowing about the selector.
    stCeEnabled:     stSides === "BOTH" || stSides === "CE",
    stPeEnabled:     stSides === "BOTH" || stSides === "PE",

    // The 25% premium stop — initial AND trailing. Which SIDES carry it is a
    // toggle: BOTH (default) / CE / PE / NONE. A side left out simply has no
    // premium floor; on PE, where the SuperTrend never applies, that means the
    // trade has NO stop at all and runs to the EOD square-off. That is allowed
    // on purpose, and the routes warn loudly about it rather than silently
    // inventing a substitute stop.
    premiumStopPct:  _numEnv("RSI_PIVOT_ST_PREMIUM_SL_PCT", 25, 1, 90),
    premiumStopSides: PREMIUM_STOP_SIDES.includes(rawPremSides) ? rawPremSides : "BOTH",

    // Session risk. Route-level, but read here so one config describes the mode.
    maxDailyTrades:  _intEnv("RSI_PIVOT_ST_MAX_TRADES", 5, 1, 50),
    maxDailyLoss:    _numEnv("RSI_PIVOT_ST_MAX_DAILY_LOSS", 5000, 0),
    exitTime:        _parseHHMM(process.env.RSI_PIVOT_ST_EXIT_TIME, 15 * 60 + 15),
  };
}

// ── Standard (Floor) Pivots ──────────────────────────────────────────────────
/**
 * Standard pivot levels for TODAY, computed from the PREVIOUS completed daily
 * candle. The classic floor-trader formula:
 *
 *   PP = (H + L + C) / 3     R1 = 2·PP − L     S1 = 2·PP − H
 *                            R2 = PP + (H − L) S2 = PP − (H − L)
 *
 * Only R1 and S1 are traded; R2/S2 are returned for the chart and for context.
 *
 * @param {Array}  dailyCandles ascending DAILY bars. The last bar must be
 *        YESTERDAY, not today — a forming daily bar would make R1/S1 drift all
 *        session and Replay could never reproduce the entry.
 * @param {object} opts { forDayKey } — the IST day index the levels are FOR.
 *        When given, any daily bar on or after that day is ignored, which is
 *        what makes a backtest walking through history read the correct
 *        yesterday for each day instead of peeking at the day it is trading.
 * @returns {{ pp, r1, s1, r2, s2, from, fromDayKey, range } | null}
 *          null when there is no usable prior daily bar — the caller must treat
 *          that as "cannot trade", never as zero.
 */
function computePivots(dailyCandles, opts) {
  const o = opts || {};
  if (!Array.isArray(dailyCandles) || dailyCandles.length === 0) return null;

  // Walk backwards to the newest usable bar strictly BEFORE forDayKey.
  let prev = null;
  for (let i = dailyCandles.length - 1; i >= 0; i--) {
    const c = dailyCandles[i];
    if (!_okBar(c)) continue;
    if (Number.isFinite(o.forDayKey) && _istDayOf(c.time) >= o.forDayKey) continue;
    prev = c;
    break;
  }
  if (!prev) return null;

  const h = prev.high, l = prev.low, c = prev.close;
  if (!(h >= l)) return null;                  // a daily bar with high < low is corrupt

  const pp = (h + l + c) / 3;
  const range = h - l;
  return {
    pp: _r2(pp),
    r1: _r2(2 * pp - l),
    s1: _r2(2 * pp - h),
    r2: _r2(pp + range),
    s2: _r2(pp - range),
    range: _r2(range),
    from: _istDateStr(prev.time),
    fromDayKey: _istDayOf(prev.time),
  };
}

// ── indicators ───────────────────────────────────────────────────────────────
/**
 * RSI over candle CLOSES, returned with the offset that maps candle index → RSI
 * index. `RSI(period)` over M closes yields M − period values, and values[j]
 * belongs to candle j + period. The offset is returned rather than assumed so
 * callers cannot silently read a stale bar's RSI as if it were current.
 */
function computeRsi(candles, period) {
  const out = { values: [], offset: 0 };
  if (!Array.isArray(candles) || candles.length === 0) return out;
  const closes = candles.map((c) => (_okBar(c) ? c.close : NaN));
  if (closes.some((v) => !Number.isFinite(v))) {
    // One bad bar poisons every RSI value after it. Refuse rather than quote it.
    return out;
  }
  const values = RSI.calculate({ period: period, values: closes });
  return { values: values, offset: candles.length - values.length };
}

/** SuperTrend aligned 1:1 with `candles`; warm-up bars are { value:null, trend:null }. */
function computeSuperTrendSeries(candles, cfg) {
  cfg = cfg || getConfig();
  if (!Array.isArray(candles) || candles.length === 0) return [];
  return computeSuperTrend(candles, cfg.stPeriod, cfg.stMultiplier);
}

// ── strike selection ─────────────────────────────────────────────────────────
/**
 * The strike this strategy wants, as an absolute strike price.
 *
 * OTM/ITM shift by `strikePct` of SPOT, rounded to the nearest 50-point strike.
 * A percentage that rounds to zero strikes falls back to ATM — better to trade
 * the money than to pretend a 0-step shift was the rule.
 *
 * @returns {{ strike, steps, mode, atm, distancePts } | null}
 */
function strikeForSide(spot, side, cfg) {
  cfg = cfg || getConfig();
  if (!_num(spot) || spot <= 0) return null;
  if (side !== "CE" && side !== "PE") return null;

  const atm = Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
  if (cfg.strikeMode === "ATM" || !(cfg.strikePct > 0)) {
    return { strike: atm, steps: 0, mode: "ATM", atm, distancePts: 0 };
  }

  const rawPts = spot * (cfg.strikePct / 100);
  const steps = Math.round(rawPts / STRIKE_STEP);
  if (steps <= 0) {
    return { strike: atm, steps: 0, mode: "ATM", atm, distancePts: 0 };
  }

  // OTM: CE strikes sit ABOVE spot, PE strikes BELOW. ITM is the mirror.
  const outward = cfg.strikeMode === "OTM";
  const dir = side === "CE" ? (outward ? 1 : -1) : (outward ? -1 : 1);
  const strike = atm + dir * steps * STRIKE_STEP;
  return {
    strike,
    steps,
    mode: cfg.strikeMode,
    atm,
    distancePts: _r2(Math.abs(strike - spot)),
  };
}

// ── stops ────────────────────────────────────────────────────────────────────
/**
 * The 25% premium stop, as an option-LTP level.
 *
 * Which sides carry it is configurable (`RSI_PIVOT_ST_PREMIUM_SL_SIDES`):
 * BOTH (default) / CE / PE / NONE. When `side` is given and it is not covered,
 * this returns null — the same value it returns for an unusable entry LTP — so
 * every existing `Number.isFinite` guard at the call sites disables the floor
 * without any of them needing to know about the toggle.
 *
 * `side` is OPTIONAL for backwards compatibility: called without it (the old
 * two/three-arg form) the level is computed unconditionally, because a caller
 * that does not say which side it is asking about cannot be filtered.
 *
 * Initial  = entryLtp × (1 − pct/100)
 * Trailing = the SAME percentage below the highest premium the trade has seen,
 *            so the floor ratchets up with the position and never comes back
 *            down. `highLtp` is the caller's high-water mark, which the route
 *            persists, so crash recovery resumes on the same floor.
 *
 * @returns {number|null} the LTP at or below which the trade must exit, or null
 *          when this side does not carry a premium stop.
 */
function premiumStop(entryLtp, highLtp, cfg, side) {
  cfg = cfg || getConfig();
  if (side != null && !premiumStopApplies(side, cfg)) return null;
  if (!_num(entryLtp) || entryLtp <= 0) return null;
  const anchor = _num(highLtp) && highLtp > entryLtp ? highLtp : entryLtp;
  return _r2(anchor * (1 - cfg.premiumStopPct / 100));
}

/**
 * Does the premium stop apply to `side`? The single place the BOTH/CE/PE/NONE
 * toggle is interpreted — routes ask this rather than comparing the string.
 */
function premiumStopApplies(side, cfg) {
  cfg = cfg || getConfig();
  const sides = cfg.premiumStopSides;
  if (sides === "NONE") return false;
  if (sides === "BOTH") return true;
  return sides === side;
}

/**
 * Does `side` end up with NO stop of any kind — neither the premium floor nor
 * the SuperTrend? Such a trade can only be closed by the EOD square-off, so
 * every route warns about it rather than substituting a stop of its own.
 */
function isStoplessSide(side, cfg) {
  cfg = cfg || getConfig();
  if (premiumStopApplies(side, cfg)) return false;
  return !stApplies(side, cfg);
}

/**
 * Does the SuperTrend stop apply to `side`? The single place the
 * BOTH/CE/PE/NONE selector is interpreted.
 */
function stApplies(side, cfg) {
  cfg = cfg || getConfig();
  const sides = cfg.stSides;
  if (sides === "NONE") return false;
  if (sides === "BOTH") return true;
  return sides === side;
}

/**
 * The SuperTrend stop as a SPOT level, ratcheted. Mirrored per side:
 *
 *   CE (a long on spot) — the line must sit BELOW price (trend = 1, acting as
 *     support). A flip to bearish is not a stop level, it IS the exit, and the
 *     level only ever ratchets UP.
 *   PE (a short on spot) — the exact mirror: the line must sit ABOVE price
 *     (trend = −1, acting as resistance), a flip to BULLISH is the exit, and
 *     the level only ever ratchets DOWN.
 *
 * `prevStop` is the stop already in force; the returned level never loosens,
 * because a trail that can loosen is not a trail.
 *
 * @returns {{ stop, trend, flipped } | null}
 */
function superTrendStop(side, stSeries, prevStop, cfg) {
  cfg = cfg || getConfig();
  if (side !== "CE" && side !== "PE") return null;
  if (!stApplies(side, cfg)) return null;
  if (!Array.isArray(stSeries) || stSeries.length === 0) return null;

  const last = stSeries[stSeries.length - 1];
  if (!last || !_num(last.value) || last.trend == null) return null;

  // The trend that KEEPS this trade alive: bullish for a CE, bearish for a PE.
  const wantTrend = side === "CE" ? 1 : -1;

  if (last.trend !== wantTrend) {
    // The line has crossed to the wrong side of price — the trade's premise is gone.
    return { stop: _num(prevStop) ? prevStop : null, trend: last.trend, flipped: true };
  }
  const raw = last.value;
  // CE ratchets up (Math.max), PE ratchets down (Math.min). Same rule, mirrored.
  const stop = _num(prevStop)
    ? (side === "CE" ? Math.max(prevStop, raw) : Math.min(prevStop, raw))
    : raw;
  return { stop: _r2(stop), trend: wantTrend, flipped: false };
}

/**
 * Spot-stop test. CE is stopped when spot falls to the level, PE when it rises
 * to it. The level must be finite first: `price <= null` is `price <= 0`, which
 * would book a stop on the very first tick.
 *
 * Both numbers must also be POSITIVE. A feed hiccup that reports 0 (or a
 * negative) is not a price NIFTY ever traded at, but it compares as "below the
 * stop" and would book a phantom CE stop-out on garbage data. Callers already
 * guard this, but the rule belongs here so no future caller has to remember it.
 */
function stopHit(side, price, stop) {
  if (!_num(price) || !_num(stop)) return false;
  if (price <= 0 || stop <= 0) return false;
  return side === "CE" ? price <= stop : price >= stop;
}

/**
 * Premium-stop test. Identical for both sides — the option only ever falls.
 * Same positivity guard as stopHit: a 0 LTP is a missing quote, not a worthless
 * option, and must never be read as the floor being breached.
 */
function premiumStopHit(ltp, stop) {
  if (!_num(ltp) || !_num(stop)) return false;
  if (ltp <= 0 || stop <= 0) return false;
  return ltp <= stop;
}

// ── the entry signal ─────────────────────────────────────────────────────────
function _baseSignal(cfg) {
  return {
    signal: "NONE", side: null, reason: "", skipReason: "", warmup: false,
    entrySpot: null, slSpot: null, slPts: null, signalStrength: null,
    rsi: null, rsiPrev: null,
    pivots: null, pp: null, r1: null, s1: null,
    crossedLevel: null, prevClose: null,
    breakoutBarTime: null, breakoutHigh: null, breakoutLow: null,
    superTrend: null, superTrendTrend: null,
    strike: null, strikeMode: null, strikeSteps: null,
    signalBarTime: null,
    cfg,
  };
}

/**
 * How many CLOSED bars getSignal needs before it will decide anything. RSI needs
 * period+1 closes, SuperTrend needs stPeriod+1, and the cross test needs a
 * previous bar; the largest wins, with a small margin.
 *
 * Exported because the paper page shows the warm-up countdown: a screen that
 * re-derives this formula drifts the moment the periods become configurable,
 * and a "waiting" badge that disagrees with the engine is worse than none.
 */
function minBarsFor(cfg) {
  const c = cfg || getConfig();
  return Math.max(c.rsiPeriod + 3, c.stPeriod + 3, 20);
}

/**
 * getSignal(candles, opts)
 *
 * @param {Array} candles ascending 5-min IST NIFTY SPOT bars. The LAST element
 *        is the just-CLOSED signal candle — never a forming bar (the caller
 *        decides that).
 * @param {object} opts { cfg, dailyCandles, pivots, silent, alreadyTraded }
 *        Either `pivots` (pre-computed, preferred — the route freezes them at
 *        session start) or `dailyCandles` must be supplied. Without one of the
 *        two there are no levels and the engine refuses to decide.
 */
function getSignal(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const base = _baseSignal(cfg);

  const minBars = minBarsFor(cfg);
  if (!Array.isArray(candles) || candles.length < minBars) {
    base.warmup = true;
    base.skipReason = base.reason =
      `Warming up (${candles ? candles.length : 0}/${minBars} five-minute candles — RSI(${cfg.rsiPeriod}) and SuperTrend(${cfg.stPeriod}) both need history)`;
    return base;
  }

  const n = candles.length;
  const bar = candles[n - 1];
  const prevBar = candles[n - 2];
  if (!_okBar(bar) || !_okBar(prevBar)) {
    base.skipReason = base.reason = "Signal candle or the one before it has no usable OHLC — refusing to decide";
    return base;
  }
  base.signalBarTime = bar.time;
  base.prevClose = _r2(prevBar.close);

  // A series that carries two bars for one IST day means someone handed daily
  // candles to an intraday engine (or vice versa). Refuse rather than compute
  // a "5-minute" RSI over daily bars.
  if (_istDayOf(bar.time) !== _istDayOf(prevBar.time) && n >= 3 && _okBar(candles[n - 3])
      && _istDayOf(prevBar.time) !== _istDayOf(candles[n - 3].time)) {
    base.skipReason = base.reason = "Candle series has one bar per day — these are not intraday candles, refusing to decide";
    return base;
  }

  // ── Window. The bar's CLOSE time gates it, not its start: the 14:55 bar
  //    closes at 15:00 and a start-time check would drop the last legal bar. ──
  const closeMins = _utcSecToIstMins(bar.time) + cfg.resolutionMins;
  if (closeMins <= cfg.entryStartMin) {
    base.skipReason = base.reason =
      `Bar closes ${_fmtMins(closeMins)} — before the ${_fmtMins(cfg.entryStartMin)} entry window opens`;
    return base;
  }
  if (closeMins > cfg.entryEndMin) {
    base.skipReason = base.reason = `Past ${_fmtMins(cfg.entryEndMin)} — no new entries`;
    return base;
  }
  if (o.alreadyTraded) {
    base.skipReason = base.reason = "Daily trade budget spent — no new entries";
    return base;
  }

  // ── The levels. Frozen, from yesterday. ──────────────────────────────────
  const pivots = o.pivots || computePivots(o.dailyCandles, { forDayKey: _istDayOf(bar.time) });
  if (!pivots || !_num(pivots.r1) || !_num(pivots.s1)) {
    base.skipReason = base.reason =
      "Previous day's high/low/close unavailable — no R1/S1 levels, refusing to trade";
    return base;
  }
  base.pivots = pivots;
  base.pp = pivots.pp;
  base.r1 = pivots.r1;
  base.s1 = pivots.s1;

  // ── RSI on the signal bar. ───────────────────────────────────────────────
  const rsiOut = computeRsi(candles, cfg.rsiPeriod);
  if (!rsiOut.values.length) {
    base.skipReason = base.reason = "RSI could not be computed over these candles — refusing to decide";
    return base;
  }
  const rsi = rsiOut.values[rsiOut.values.length - 1];
  const rsiPrev = rsiOut.values.length >= 2 ? rsiOut.values[rsiOut.values.length - 2] : null;
  if (!_num(rsi)) {
    base.skipReason = base.reason = "RSI resolved to a non-number — refusing to decide";
    return base;
  }
  base.rsi = _r2(rsi);
  base.rsiPrev = _num(rsiPrev) ? _r2(rsiPrev) : null;

  // ── The cross. Previous close on one side, this close on the other. ──────
  const buf = cfg.pivotBufferPts;
  const ceLevel = _r2(pivots.r1 + buf);
  const peLevel = _r2(pivots.s1 - buf);
  //
  // Two shapes, chosen by CONFIRM_ENABLED:
  //
  //   OFF — the legacy rule. The bar that crosses the level IS the entry:
  //         previous close on one side, this close on the other.
  //
  //   ON (default) — the crossing bar only ARMS the setup. The bar BEFORE this
  //         one must have crossed and closed beyond the level, and THIS bar
  //         must close beyond that breakout bar's HIGH (CE) / LOW (PE). A
  //         breakout that pokes 27 points past R1 and stalls never gets an
  //         entry, because the next candle cannot close above its high without
  //         actually extending the move. Only the immediately-next candle
  //         counts: a setup not confirmed on the very next bar is dead, and
  //         re-entry needs a fresh cross.
  let crossedUpR1, crossedDownS1, brkBar = null;
  if (cfg.confirmEnabled) {
    // brkBar = the breakout candle, priorBar = the one before it (proves the
    // cross was fresh rather than a bar already sitting beyond the level).
    brkBar = prevBar;
    const priorBar = candles[n - 3];
    if (!_okBar(priorBar)) {
      base.skipReason = base.reason =
        "Confirmation needs three candles and the third has no usable OHLC — refusing to decide";
      return base;
    }
    const brokeUp   = priorBar.close <= ceLevel && brkBar.close > ceLevel;
    const brokeDown = priorBar.close >= peLevel && brkBar.close < peLevel;
    crossedUpR1   = brokeUp   && bar.close > brkBar.high;
    crossedDownS1 = brokeDown && bar.close < brkBar.low;

    if (brokeUp || brokeDown) {
      base.breakoutBarTime = brkBar.time;
      base.breakoutHigh    = _r2(brkBar.high);
      base.breakoutLow     = _r2(brkBar.low);
    }
    // Armed but not confirmed — say so explicitly, because "no fresh cross" would
    // be a lie: the cross happened, the follow-through did not.
    if (brokeUp && !crossedUpR1) {
      base.skipReason = base.reason =
        `Breakout candle closed above R1 ${ceLevel} (high ${_r2(brkBar.high)}) but this candle closed ${_r2(bar.close)} — ` +
        `not above the breakout high, no confirmation`;
      return base;
    }
    if (brokeDown && !crossedDownS1) {
      base.skipReason = base.reason =
        `Breakout candle closed below S1 ${peLevel} (low ${_r2(brkBar.low)}) but this candle closed ${_r2(bar.close)} — ` +
        `not below the breakout low, no confirmation`;
      return base;
    }
  } else {
    crossedUpR1   = prevBar.close <= ceLevel && bar.close > ceLevel;
    crossedDownS1 = prevBar.close >= peLevel && bar.close < peLevel;
  }

  let side = null;
  if (crossedUpR1 && rsi > cfg.rsiCeMin) side = "CE";
  else if (crossedDownS1 && rsi < cfg.rsiPeMax) side = "PE";

  if (!side) {
    // Say which half failed — a skip log that only says "no signal" teaches nothing.
    // With confirmation ON the crossing bar is the PREVIOUS one, so the message
    // quotes the breakout high/low that this bar cleared, not a prev→now close pair.
    if (crossedUpR1) {
      base.skipReason = base.reason = cfg.confirmEnabled
        ? `Confirmed above R1 ${ceLevel} (closed ${_r2(bar.close)} past the breakout high ${_r2(brkBar.high)}) ` +
          `but RSI ${base.rsi} is not above ${cfg.rsiCeMin}`
        : `Closed above R1 ${ceLevel} (${_r2(prevBar.close)} → ${_r2(bar.close)}) but RSI ${base.rsi} is not above ${cfg.rsiCeMin}`;
    } else if (crossedDownS1) {
      base.skipReason = base.reason = cfg.confirmEnabled
        ? `Confirmed below S1 ${peLevel} (closed ${_r2(bar.close)} past the breakout low ${_r2(brkBar.low)}) ` +
          `but RSI ${base.rsi} is not below ${cfg.rsiPeMax}`
        : `Closed below S1 ${peLevel} (${_r2(prevBar.close)} → ${_r2(bar.close)}) but RSI ${base.rsi} is not below ${cfg.rsiPeMax}`;
    } else if (rsi > cfg.rsiCeMin) {
      base.skipReason = base.reason =
        `RSI ${base.rsi} > ${cfg.rsiCeMin} but no fresh cross of R1 ${ceLevel} (prev close ${_r2(prevBar.close)}, close ${_r2(bar.close)})`;
    } else if (rsi < cfg.rsiPeMax) {
      base.skipReason = base.reason =
        `RSI ${base.rsi} < ${cfg.rsiPeMax} but no fresh cross of S1 ${peLevel} (prev close ${_r2(prevBar.close)}, close ${_r2(bar.close)})`;
    } else {
      base.skipReason = base.reason =
        `No setup: close ${_r2(bar.close)} vs R1 ${ceLevel} / S1 ${peLevel}, RSI ${base.rsi} (need >${cfg.rsiCeMin} or <${cfg.rsiPeMax})`;
    }
    return base;
  }

  base.side = side;
  base.crossedLevel = side === "CE" ? ceLevel : peLevel;
  const entry = _r2(bar.close);
  base.entrySpot = entry;

  // ── Strike. 1% of spot, direction per Settings. ──────────────────────────
  const strikeInfo = strikeForSide(entry, side, cfg);
  if (!strikeInfo) {
    base.skipReason = base.reason = "Strike not computable from the signal close — refusing to enter";
    return base;
  }
  base.strike = strikeInfo.strike;
  base.strikeMode = strikeInfo.mode;
  base.strikeSteps = strikeInfo.steps;

  // ── The SPOT stop: SuperTrend, on whichever sides ST_SIDES covers. ───────
  // Mirrored for PE — the line must sit ABOVE the entry rather than below it,
  // and "not bearish" is the refusal instead of "not bullish". A setup whose
  // SuperTrend is on the wrong side of price, or already through the entry, is
  // REFUSED rather than entered with no stop (unchanged rule, now per side).
  if (stApplies(side, cfg)) {
    const isCE = side === "CE";
    const stSeries = computeSuperTrendSeries(candles, cfg);
    const st = superTrendStop(side, stSeries, null, cfg);
    base.superTrend = st && _num(st.stop) ? _r2(st.stop) : null;
    base.superTrendTrend = st ? st.trend : null;

    const wantWord  = isCE ? "bullish" : "bearish";
    const wrongSide = isCE ? "line sits above price" : "line sits below price";
    const level     = isCE ? ceLevel : peLevel;

    if (!st || st.flipped || !_num(st.stop)) {
      base.skipReason = base.reason =
        `${side} setup at ${isCE ? "R1" : "S1"} ${level} with RSI ${base.rsi}, but SuperTrend(${cfg.stPeriod},${cfg.stMultiplier}) is not ${wantWord} ` +
        `(${st && st.trend != null ? wrongSide : "still warming up"}) — no initial stop, refusing to enter`;
      return base;
    }
    // CE is stopped BELOW the entry, PE ABOVE it. Either way, a stop already on
    // the wrong side of the fill would be hit on the trade's first tick.
    const throughEntry = isCE ? st.stop >= entry : st.stop <= entry;
    if (throughEntry) {
      base.skipReason = base.reason =
        `${side} setup valid but SuperTrend ${_r2(st.stop)} is at or ${isCE ? "above" : "below"} the entry ${entry} — the trade would be stopped on its first tick`;
      return base;
    }
    base.slSpot = _r2(st.stop);
    base.slPts = _r2(Math.abs(entry - st.stop));
  }

  base.signal = side === "CE" ? "BUY_CE" : "BUY_PE";
  base.signalStrength = "STRONG";

  // Stop description — reflects the premium-stop side toggle, so the trade
  // record never claims a floor the trade does not actually carry.
  const hasPrem = premiumStopApplies(side, cfg);
  const stopParts = [];
  if (_num(base.slSpot)) stopParts.push(`SuperTrend ${base.slSpot} (${base.slPts}pt)`);
  if (hasPrem) stopParts.push(`${cfg.premiumStopPct}% premium floor`);
  const stopText = stopParts.length
    ? `SL = ${stopParts.join(" + ")}`
    : `SL = NONE — no SuperTrend on ${side} and the premium stop is OFF for this side; EOD square-off is the only exit`;
  // How the entry came about — with confirmation ON that is a two-candle
  // story (breakout, then close beyond its extreme), and the record says so.
  const crossText = cfg.confirmEnabled
    ? `the breakout candle closed ${side === "CE" ? "above R1" : "below S1"} ${base.crossedLevel} and this candle confirmed by closing ` +
      `${entry}, past its ${side === "CE" ? `high ${base.breakoutHigh}` : `low ${base.breakoutLow}`} (pivots from ${pivots.from})`
    : `the candle crossed and closed ${side === "CE" ? "above R1" : "below S1"} ${base.crossedLevel} ` +
      `(${_r2(prevBar.close)} → ${entry}, pivots from ${pivots.from})`;
  base.reason =
    `RSI_PIVOT_ST ${side}: RSI ${base.rsi} ${side === "CE" ? `> ${cfg.rsiCeMin}` : `< ${cfg.rsiPeMax}`} and ${crossText} | ` +
    `strike ${base.strike} (${strikeInfo.mode}${strikeInfo.steps ? `, ${strikeInfo.steps} step${strikeInfo.steps > 1 ? "s" : ""} = ${strikeInfo.distancePts}pt`: ""}) | ${stopText}`;

  if (!o.silent) {
    const ist = new Date(bar.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    console.log(`[RSI_PIVOT_ST ${ist}] ENTER ${side} @ ${entry} | ${side === "CE" ? `ST ${base.slSpot}` : "premium-stop only"} | strike ${base.strike} | RSI ${base.rsi}`);
  }
  return base;
}

module.exports = {
  NAME,
  DESCRIPTION,
  STRIKE_MODES,
  PREMIUM_STOP_SIDES,
  ST_SIDES,
  STRIKE_STEP,
  getConfig,
  computePivots,
  computeRsi,
  computeSuperTrendSeries,
  strikeForSide,
  premiumStop,
  premiumStopHit,
  premiumStopApplies,
  stApplies,
  isStoplessSide,
  superTrendStop,
  stopHit,
  getSignal,
  minBarsFor,
  // shared time helpers (routes must not re-derive IST arithmetic)
  _istDayOf,
  _istDateStr,
  _utcSecToIstMins,
  _parseHHMM,
  _fmtMins,
};

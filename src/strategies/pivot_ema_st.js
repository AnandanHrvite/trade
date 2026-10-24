/**
 * STRATEGY: PIVOT_EMA_ST  (created 2026-10-24)
 * ═════════════════════════════════════════════════════════════════════════════
 * EMA 20/50 crossover INSIDE the Pivot→R1 (or Pivot→S1) zone, SuperTrend-stopped.
 * Option BUYING · intraday · Fyers data, Zerodha orders · 1 lot.
 * One rule set, four instruments — each with its own env prefix:
 *   PIVOT_EMA_ST       NIFTY 50          (NSE:NIFTY50-INDEX)
 *   BN_PIVOT_EMA_ST    NIFTY BANK        (NSE:NIFTYBANK-INDEX)
 *   SAIL_PIVOT_EMA_ST  SAIL stock options (NSE:SAIL-EQ)
 *   Commodity (MCX crude / gold / silver) reads the PIVOT_EMA_ST rule keys
 *   through src/services/commodityPaper.js, the way V1/V2 read EMA_RSI_ST.
 *
 * Indicators (all on the SPOT / underlying chart, all read on a CLOSED candle):
 *   EMA(20) and EMA(50) on close · SuperTrend(10, 3) ·
 *   Traditional (floor) pivots from the PREVIOUS day's daily H/L/C:
 *     PP = (H+L+C)/3   R1 = 2·PP − L   S1 = 2·PP − H
 *   The pivots are fixed before the open and never move intraday. The EMAs run
 *   continuously across days (like TradingView), so the route preloads
 *   {PREFIX}_WARMUP_DAYS of history — EMA50 on 3-min bars needs ~56 bars, and
 *   a session is only ~125.
 *
 * ── ENTRY — BUY_CE, all three on the SAME closed candle (user, 2026-10-24) ──
 *   1. ZONE:  PP < close < R1   — the candle's CLOSE; wicks may poke outside.
 *   2. CROSS: EMA20 crosses ABOVE EMA50 on THIS candle, INSIDE PP–R1 —
 *             previous bar EMA20 ≤ EMA50 and this bar EMA20 > EMA50, and the
 *             cross level ((EMA20+EMA50)/2 on this candle) is between PP and R1.
 *             A cross on an earlier candle does not count (the user's choice:
 *             "on the entry candle", not "within the last N candles").
 *   3. ST:    SuperTrend is GREEN on this candle (line below the close).
 *             That SuperTrend value is the initial stop.
 * ── ENTRY — BUY_PE, the exact mirror ─────────────────────────────────────────
 *   1. S1 < close < PP   2. EMA20 crosses BELOW EMA50 on this candle, the
 *      cross level inside S1–PP
 *   3. SuperTrend RED (line above the close) — initial stop.
 *   A close above R1 or below S1 never enters (outside the zones). A close
 *   exactly on PP / R1 / S1 is not inside the zone.
 *   Example (CE): PP 22,860, R1 23,071; the 10:33 3-min candle closes 22,900;
 *   EMA20 22,881 > EMA50 22,879 after 22,876 ≤ 22,878 on the bar before
 *   (cross level 22,880 — inside PP–R1);
 *   SuperTrend green at 22,840 → BUY the ATM CE, stop = 22,840.
 *   Paper/Live fill at the first tick after the signal candle closes.
 *
 * ── EXIT — SuperTrend trailing stop, on CANDLE CLOSE only (user, 2026-10-24) ─
 *   Initial stop = SuperTrend on the signal candle. At every later close:
 *     CE exits when SuperTrend flips RED, or the close is below the trailed
 *        stop.  PE: flips GREEN, or the close is above the stop.
 *     Otherwise the stop trails to that candle's SuperTrend, tighten-only.
 *   A wick through the line that closes back inside does NOT exit.
 *   Plus the repo's common rules, owned by the routes, not here: profit lock,
 *   breakeven, wait-after-exit, bid-ask spread, the common trade window
 *   (entries 10:00–14:00, square-off 15:00), max trades/day, daily loss cap.
 *
 * ── TIMEFRAME — {PREFIX}_TF = 3 | 5 | 15 (default 3, matches the user's chart)
 *
 * ── DELIBERATELY NOT HERE (do not "helpfully" add these) ────────────────────
 *   No RSI, no VIX gate, no OI filter, no ADX, no volume, no VWAP, no ATR
 *   sizing, no confirmation candle, no fixed target, no premium stop of its
 *   own, no tick-level stop, no R2/S2 logic, no "cross within N candles".
 *   No Backtest and no Replay page (the user's choice, 2026-10-24).
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 *   Every decision reads closed-candle OHLC and the previous day's daily bar.
 *   Never a live tick, never live spot — so Paper and Live decide identically.
 *
 * ── NOT MARKET-VALIDATED ────────────────────────────────────────────────────
 *   Zero trades, paper or live. Every number is the user's stated rule.
 *
 * Contract (every function takes the env prefix through cfg / opts.prefix):
 *   getConfig(prefix)                    -> live env read (never cached)
 *   warmupBars(cfg) / warmupDays(prefix) -> bars / days refused below
 *   computePivots(daily, { forDayKey })  -> { pp, r1, s1, r2, s2, forDayKey, ... }
 *   computeSeries(candles, cfg)          -> { emaFast, emaSlow, supertrend } 1:1
 *   checkBar(idx, candles, series, pivots, cfg) -> the 3-box checklist, CE and PE
 *   getSignal(candles, opts)             -> { signal, reason, stopLoss, checks, ... }
 *   exitCheck(side, bar, stBar, stop)    -> { exit, reason } — the ONLY exit test
 *   trailStop(candles, side, stop, cfg, pre) -> { stop, changed, tag } tighten-only
 */

const { EMA } = require("technicalindicators");
const { computeSuperTrend } = require("../utils/supertrend");

const NAME   = "PIVOT_EMA_ST";
const DEFAULT_PREFIX = "PIVOT_EMA_ST";
const PREFIXES = ["PIVOT_EMA_ST", "BN_PIVOT_EMA_ST", "SAIL_PIVOT_EMA_ST"];
const DESCRIPTION =
  "PIVOT_EMA_ST — EMA 20/50 crossover inside the Pivot→R1 (CE) or Pivot→S1 (PE) zone with SuperTrend(10,3) " +
  "agreeing, on one closed candle · SuperTrend trailing stop on candle close · Zerodha";

const TFS = [3, 5, 15];

// ── primitives ───────────────────────────────────────────────────────────────
function _r2(x) { return Math.round(x * 100) / 100; }
/** Finite-number guard. Number(null)===0 and Number("")===0 both invent a price. */
function _num(x) { return typeof x === "number" && Number.isFinite(x); }
/** IST calendar-day index. India has no DST, so a fixed +5:30 shift is exact. */
function _istDayOf(unixSec) { return Math.floor((unixSec + 19800) / 86400); }
/** IST minutes-of-day from a unix-SECONDS time. */
function _istMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _istDateStr(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function _okBar(c) {
  return !!c && _num(c.time) && _num(c.open) && _num(c.high) && _num(c.low) && _num(c.close);
}

/** "HH:MM" → minutes-of-day; anything malformed falls back to `def`. */
function _parseHHMM(raw, def) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(raw == null ? "" : raw));
  if (!m) return def;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return def;
  return h * 60 + mm;
}
function _fmtMins(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}
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
function _prefixOf(p) {
  const s = String(p || "").trim().toUpperCase();
  return s || DEFAULT_PREFIX;
}

/**
 * Live config read. Settings saves mutate process.env in place, so this must
 * never be cached — every caller re-reads on each evaluation.
 */
function getConfig(prefix) {
  const P = _prefixOf(prefix);
  const tf = _intEnv(P + "_TF", 3);
  const emaFast = _intEnv(P + "_EMA_FAST", 20, 2, 400);
  let emaSlow = _intEnv(P + "_EMA_SLOW", 50, 2, 400);
  // A "slow" EMA that is not slower than the fast one has no crossover meaning.
  if (!(emaSlow > emaFast)) emaSlow = Math.max(50, emaFast + 1);
  return {
    PREFIX:       P,
    TF:           TFS.includes(tf) ? tf : 3,
    EMA_FAST:     emaFast,
    EMA_SLOW:     emaSlow,
    ST_PERIOD:    _intEnv(P + "_ST_PERIOD", 10, 2, 100),
    ST_MULT:      _numEnv(P + "_ST_MULT", 3, 0.1, 10),

    ENTRY_START:  _parseHHMM(process.env[P + "_ENTRY_START"], 10 * 60),
    ENTRY_END:    _parseHHMM(process.env[P + "_ENTRY_END"], 14 * 60),
    EOD_EXIT:     _parseHHMM(process.env[P + "_EOD_EXIT_TIME"], 15 * 60),

    // Session guards. Route-level, but read here so one config describes the mode.
    MAX_DAILY_TRADES: _intEnv(P + "_MAX_DAILY_TRADES", 3, 1, 50),
    MAX_DAILY_LOSS:   _numEnv(P + "_MAX_DAILY_LOSS", 5000, 0),
  };
}

/**
 * Bars the engine refuses below. 56 at the defaults (EMA50 + the bar before
 * the cross + a margin) — 168 min of 3-min bars, so any start before ~12:05
 * needs the previous session preloaded. Routes preload DAYS, not just today.
 */
function warmupBars(cfg) {
  cfg = cfg || getConfig();
  return Math.max(cfg.EMA_SLOW + 1, cfg.ST_PERIOD + 1) + 5;
}
/**
 * Sessions of history to preload: {PREFIX}_WARMUP_DAYS (default 3), raised to
 * what the timeframe needs so EMA50 has ~250 bars behind it and matches the
 * user's chart (TradingView runs the EMA over all history): 3-min → 3 days,
 * 5-min → 5, 15-min → 11. Fewer would quote an EMA50 that is still settling.
 */
function warmupDays(prefix) {
  const P = _prefixOf(prefix);
  const need = Math.min(15, Math.ceil(250 * getConfig(P).TF / 375) + 1);
  return Math.max(_intEnv(P + "_WARMUP_DAYS", 3, 1, 15), need);
}

/** Entry window on the signal candle's CLOSE time (= the moment the entry fills). */
function isInTradingWindow(barTimeSec, cfg) {
  cfg = cfg || getConfig();
  const closeMin = _istMins(barTimeSec + cfg.TF * 60);
  if (closeMin < cfg.ENTRY_START) return { ok: false, reason: `Before ${_fmtMins(cfg.ENTRY_START)} — outside the entry window` };
  if (closeMin > cfg.ENTRY_END)   return { ok: false, reason: `After ${_fmtMins(cfg.ENTRY_END)} — no new entries` };
  return { ok: true, reason: null };
}

/** True when the given IST minute is at/after the forced square-off. */
function isEodExit(unixSec, cfg) {
  cfg = cfg || getConfig();
  return _istMins(unixSec) >= cfg.EOD_EXIT;
}

// ── Traditional (floor) pivots ───────────────────────────────────────────────
/**
 * Levels for the IST day `opts.forDayKey`, from the newest daily bar strictly
 * BEFORE that day — so a forming daily bar can never make R1/S1 drift intraday.
 * Two daily bars on one IST day means intraday candles were passed → refuse.
 * @returns {{ pp, r1, s1, r2, s2, range, from, fromDayKey, forDayKey } | null}
 */
function computePivots(dailyCandles, opts) {
  const o = opts || {};
  if (!Array.isArray(dailyCandles) || dailyCandles.length === 0) return null;
  const seen = new Set();
  for (const c of dailyCandles) {
    if (!_okBar(c)) continue;
    const k = _istDayOf(c.time);
    if (seen.has(k)) return null;
    seen.add(k);
  }
  let prev = null;
  for (let i = dailyCandles.length - 1; i >= 0; i--) {
    const c = dailyCandles[i];
    if (!_okBar(c)) continue;
    if (_num(o.forDayKey) && _istDayOf(c.time) >= o.forDayKey) continue;
    prev = c;
    break;
  }
  if (!prev) return null;
  const h = prev.high, l = prev.low, cl = prev.close;
  if (!(h >= l)) return null;
  const pp = (h + l + cl) / 3;
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
    forDayKey: _num(o.forDayKey) ? o.forDayKey : null,
  };
}

// ── indicator series ─────────────────────────────────────────────────────────
/**
 * Time-aligned series, 1:1 with `candles` (null on warm-up bars), so a chart
 * plots the EXACT numbers the signal read. `technicalindicators` alignment:
 *   EMA(p) over N closes → N−p+1 outputs, out[i] ↔ candles[i+p−1]
 */
function computeSeries(candles, cfg) {
  cfg = cfg || getConfig();
  const n = Array.isArray(candles) ? candles.length : 0;
  const emaFast = new Array(n).fill(null);
  const emaSlow = new Array(n).fill(null);
  if (n === 0) return { emaFast, emaSlow, supertrend: [] };
  const closes = candles.map((c) => c.close);
  const f = EMA.calculate({ period: cfg.EMA_FAST, values: closes });
  for (let i = 0; i < f.length; i++) emaFast[i + cfg.EMA_FAST - 1] = f[i];
  const s = EMA.calculate({ period: cfg.EMA_SLOW, values: closes });
  for (let i = 0; i < s.length; i++) emaSlow[i + cfg.EMA_SLOW - 1] = s[i];
  const supertrend = computeSuperTrend(candles, cfg.ST_PERIOD, cfg.ST_MULT);
  return { emaFast, emaSlow, supertrend };
}

/**
 * The 3-box checklist for the closed bar at `idx` — the whole entry rule, both
 * sides. `ready:false` when any input is missing; the caller must refuse.
 */
function checkBar(idx, candles, series, pivots, cfg) {
  cfg = cfg || getConfig();
  const bar = candles[idx];
  const f = series.emaFast[idx], s = series.emaSlow[idx];
  const pf = idx > 0 ? series.emaFast[idx - 1] : null;
  const ps = idx > 0 ? series.emaSlow[idx - 1] : null;
  const st = series.supertrend[idx];
  const out = {
    ready: false, time: bar ? bar.time : null, close: bar ? bar.close : null,
    emaFast: _num(f) ? _r2(f) : null, emaSlow: _num(s) ? _r2(s) : null,
    prevEmaFast: _num(pf) ? _r2(pf) : null, prevEmaSlow: _num(ps) ? _r2(ps) : null,
    supertrend: st && _num(st.value) ? _r2(st.value) : null,
    stTrend: st && (st.trend === 1 || st.trend === -1) ? st.trend : null,
    zone: null, crossLevel: null, crossedUp: false, crossedDown: false,
    CE: { zone: false, cross: false, st: false, count: 0 },
    PE: { zone: false, cross: false, st: false, count: 0 },
  };
  if (!_okBar(bar) || !_num(f) || !_num(s) || !_num(pf) || !_num(ps) ||
      out.supertrend == null || out.stTrend == null ||
      !pivots || !_num(pivots.pp) || !_num(pivots.r1) || !_num(pivots.s1)) return out;
  const c = bar.close;
  out.ready = true;
  out.zone = c > pivots.r1 ? "ABOVE_R1" : c < pivots.s1 ? "BELOW_S1"
    : (c > pivots.pp && c < pivots.r1) ? "PP_R1"
    : (c < pivots.pp && c > pivots.s1) ? "S1_PP" : "ON_LEVEL";
  // Raw (unrounded) EMA values decide the cross — rounding could invent or hide one.
  // Rule 2 is "the crossover happens IN the zone": the cross level (the midpoint
  // of the two EMAs on the crossing candle) must sit inside the same zone as
  // the close. A cross that happens below PP and then a close above PP is not it.
  const lvl = (f + s) / 2;
  out.crossLevel = _r2(lvl);
  const upX = pf <= ps && f > s, dnX = pf >= ps && f < s;
  out.crossedUp = upX; out.crossedDown = dnX;
  out.CE = { zone: out.zone === "PP_R1", cross: upX && lvl > pivots.pp && lvl < pivots.r1, st: out.stTrend === 1 };
  out.PE = { zone: out.zone === "S1_PP", cross: dnX && lvl < pivots.pp && lvl > pivots.s1, st: out.stTrend === -1 };
  for (const side of ["CE", "PE"]) {
    const k = out[side];
    k.count = (k.zone ? 1 : 0) + (k.cross ? 1 : 0) + (k.st ? 1 : 0);
  }
  return out;
}

function _zoneText(chk, pivots) {
  switch (chk.zone) {
    case "ABOVE_R1": return `C ${chk.close} above R1 ${pivots.r1} — no-trade zone`;
    case "BELOW_S1": return `C ${chk.close} below S1 ${pivots.s1} — no-trade zone`;
    case "PP_R1":    return `C ${chk.close} in PP–R1 (${pivots.pp}–${pivots.r1})`;
    case "S1_PP":    return `C ${chk.close} in S1–PP (${pivots.s1}–${pivots.pp})`;
    default:         return `C ${chk.close} on a pivot level`;
  }
}

function _missing(side, chk, cfg) {
  const k = chk[side];
  const m = [];
  const ema = `EMA${cfg.EMA_FAST}${side === "CE" ? "↑" : "↓"}${cfg.EMA_SLOW}`;
  const crossed = side === "CE" ? chk.crossedUp : chk.crossedDown;
  if (!k.zone)  m.push(side === "CE" ? `not in PP–R1 (C ${chk.close})` : `not in S1–PP (C ${chk.close})`);
  if (!k.cross) m.push(crossed ? `${ema} crossed at ${chk.crossLevel}, outside the ${side === "CE" ? "PP–R1" : "S1–PP"} zone` : `no ${ema} cross on this candle`);
  if (!k.st)    m.push(side === "CE" ? "ST not green" : "ST not red");
  return m.join(", ");
}

const _NO = { stopLoss: null, slSpot: null, entrySpot: null, prevCandleHigh: null, prevCandleLow: null };

/**
 * getSignal(candles, opts)
 *   candles — ascending CLOSED bars on the strategy timeframe; the LAST one is
 *             the signal candle.
 *   opts.prefix        — env prefix (PIVOT_EMA_ST / BN_PIVOT_EMA_ST / SAIL_PIVOT_EMA_ST).
 *   opts.cfg           — an already-read getConfig() (callers that need one
 *                        consistent read across a decision).
 *   opts.pivots        — computePivots(daily, { forDayKey: signal day }). REQUIRED.
 *   opts.precomputed   — TESTS / OFFLINE ONLY: { series, endIdx } over the whole
 *                        array; every indicator is causal, so it equals recomputing
 *                        on candles.slice(0, endIdx+1).
 *   opts.skipTimeCheck — the caller applies its own entry window (commodity), or
 *                        an exit-time indicator snapshot. Never the NSE entry path.
 * Returns { signal: "BUY_CE"|"BUY_PE"|"NONE", reason, warmup, stopLoss, slSpot,
 *           entrySpot, checks, emaFast, emaSlow, supertrend, stTrend, pp, r1, s1, ... }.
 */
function getSignal(candles, opts) {
  const o = opts || {};
  const pre = o.precomputed || null;
  const cfg = o.cfg || getConfig(o.prefix);
  const WARMUP = warmupBars(cfg);
  const nBars = !Array.isArray(candles) ? 0 : pre ? pre.endIdx + 1 : candles.length;
  if (nBars < WARMUP) {
    return Object.assign({ signal: "NONE", warmup: true, reason: `Warming up (${nBars}/${WARMUP} ${cfg.TF}-min candles)` }, _NO);
  }
  const last = nBars - 1;
  const bar = candles[last];
  const prev = candles[last - 1];
  if (!_okBar(bar) || !_okBar(prev)) {
    return Object.assign({ signal: "NONE", warmup: true, reason: "Bad candle data (non-finite OHLC on the signal or previous candle)" }, _NO);
  }

  const pivots = o.pivots || null;
  const dayKey = _istDayOf(bar.time);
  if (!pivots || !_num(pivots.pp) || !_num(pivots.r1) || !_num(pivots.s1)) {
    return Object.assign({ signal: "NONE", warmup: true, reason: "Previous day's high/low/close unavailable — no pivots, refusing to trade" }, _NO);
  }
  if (_num(pivots.forDayKey) && pivots.forDayKey !== dayKey) {
    return Object.assign({ signal: "NONE", warmup: true, reason: `Pivots are for another day (${pivots.forDayKey} vs ${dayKey}) — refusing stale levels` }, _NO);
  }
  // The pivots must not be OLDER than the last session the candles show: a daily
  // feed missing yesterday's bar would otherwise hand over two-day-old levels.
  // NEWER is fine — a special session (Muhurat trading) has a daily bar but its
  // intraday candles fall outside 09:15–15:30 and are not in the buffer.
  // skipReason "stale_pivots" tells the route to drop them and re-fetch.
  if (_num(pivots.fromDayKey)) {
    let lastPrevDay = null;
    for (let i = last - 1; i >= 0; i--) {
      const c = candles[i];
      if (!c || !_num(c.time)) continue;
      const d = _istDayOf(c.time);
      if (d < dayKey) { lastPrevDay = d; break; }
    }
    if (lastPrevDay != null && pivots.fromDayKey < lastPrevDay) {
      return Object.assign({ signal: "NONE", warmup: true, skipReason: "stale_pivots", reason: `Pivots come from ${pivots.from || pivots.fromDayKey}, older than the last session ${_istDateStr(lastPrevDay * 86400)} — refusing stale levels` }, _NO);
    }
  }

  const series = pre ? pre.series : computeSeries(candles, cfg);
  const chk = checkBar(last, candles, series, pivots, cfg);
  const base = {
    warmup: false,
    emaFast: chk.emaFast, emaSlow: chk.emaSlow,
    supertrend: chk.supertrend,
    stTrend: chk.stTrend === 1 ? "BULLISH" : chk.stTrend === -1 ? "BEARISH" : null,
    stTrendInt: chk.stTrend,
    pp: pivots.pp, r1: pivots.r1, s1: pivots.s1, r2: pivots.r2, s2: pivots.s2,
    pivotsFrom: pivots.from || null,
    zone: chk.zone, crossLevel: chk.crossLevel,
    checks: chk, tf: cfg.TF,
    prevCandleHigh: prev.high, prevCandleLow: prev.low,
    entrySpot: bar.close, stopLoss: null, slSpot: null,
    signalStrength: "STRONG",
  };
  if (!chk.ready) {
    return Object.assign({}, base, { signal: "NONE", warmup: true, reason: "Indicators not ready" });
  }

  if (!o.skipTimeCheck) {
    const w = isInTradingWindow(bar.time, cfg);
    if (!w.ok) return Object.assign({}, base, { signal: "NONE", reason: w.reason });
  }

  const tag = cfg.TF + "m";
  if (chk.zone === "ABOVE_R1" || chk.zone === "BELOW_S1" || chk.zone === "ON_LEVEL") {
    return Object.assign({}, base, { signal: "NONE", skipReason: chk.zone === "ON_LEVEL" ? null : "outside_zone", reason: `${tag} ${_zoneText(chk, pivots)}` });
  }
  const side = chk.zone === "PP_R1" ? "CE" : "PE";
  if (chk[side].count !== 3) {
    return Object.assign({}, base, {
      signal: "NONE",
      reason: `${tag} ${side} ${chk[side].count}/3 — missing: ${_missing(side, chk, cfg)}`,
    });
  }

  // A green SuperTrend sits below the close by construction; refuse anyway if it
  // does not, rather than open a trade whose stop is already through the entry.
  const stv = chk.supertrend;
  if ((side === "CE" && !(stv < bar.close)) || (side === "PE" && !(stv > bar.close))) {
    return Object.assign({}, base, { signal: "NONE", skipReason: "st_wrong_side", reason: `${side} 3/3 but SuperTrend ${stv} is not beyond the close ${bar.close} — no stop, no trade` });
  }
  const sl = stv;
  const reason = side === "CE"
    ? `CE ${tag} 3/3: C ${bar.close} in PP ${pivots.pp}–R1 ${pivots.r1} | EMA${cfg.EMA_FAST} ${chk.emaFast} crossed above EMA${cfg.EMA_SLOW} ${chk.emaSlow} at ${chk.crossLevel} (in zone) | ST green | SL=ST ${sl}`
    : `PE ${tag} 3/3: C ${bar.close} in S1 ${pivots.s1}–PP ${pivots.pp} | EMA${cfg.EMA_FAST} ${chk.emaFast} crossed below EMA${cfg.EMA_SLOW} ${chk.emaSlow} at ${chk.crossLevel} (in zone) | ST red | SL=ST ${sl}`;
  if (!o.silent) console.log(`[${cfg.PREFIX}] 🟢 ${side === "CE" ? "BUY_CE" : "BUY_PE"} — ${reason}`);
  return Object.assign({}, base, { signal: side === "CE" ? "BUY_CE" : "BUY_PE", stopLoss: sl, slSpot: sl, reason });
}

/**
 * The ONLY exit test, run on each CLOSED candle while a position is open.
 * `stBar` is that candle's SuperTrend { value, trend }, `stop` the trail in
 * force BEFORE this candle.
 */
function exitCheck(side, bar, stBar, stop) {
  if (!_okBar(bar)) return { exit: false, reason: null };
  const c = bar.close;
  const trend = stBar && (stBar.trend === 1 || stBar.trend === -1) ? stBar.trend : null;
  if (side === "CE") {
    if (trend === -1) return { exit: true, reason: `SuperTrend flipped red — close ${c}` };
    if (_num(stop) && c < stop) return { exit: true, reason: `Close ${c} below SuperTrend stop ${stop}` };
  } else if (side === "PE") {
    if (trend === 1) return { exit: true, reason: `SuperTrend flipped green — close ${c}` };
    if (_num(stop) && c > stop) return { exit: true, reason: `Close ${c} above SuperTrend stop ${stop}` };
  }
  return { exit: false, reason: null };
}

/**
 * Trail the stop to the last closed candle's SuperTrend, tighten-only. A
 * SuperTrend on the wrong side of the close, or in the opposite trend, leaves
 * the stop where it was (exitCheck handles the flip).
 * `precomputed` — TESTS / OFFLINE ONLY: { supertrend, endIdx } over the whole array.
 */
function trailStop(candles, side, currentStop, cfg, precomputed) {
  cfg = cfg || getConfig();
  const unchanged = { stop: currentStop, changed: false, tag: null };
  const pre = precomputed || null;
  const nBars = !Array.isArray(candles) ? 0 : pre ? pre.endIdx + 1 : candles.length;
  if (nBars < cfg.ST_PERIOD + 2) return unchanged;
  const bar = candles[nBars - 1];
  const st = pre ? pre.supertrend : computeSuperTrend(candles, cfg.ST_PERIOD, cfg.ST_MULT);
  const cur = st[nBars - 1];
  if (!_okBar(bar) || !cur || !_num(cur.value)) return unchanged;
  const lvl = _r2(cur.value);
  if (side === "CE" && cur.trend === 1 && lvl < bar.close && (!_num(currentStop) || lvl > currentStop)) {
    return { stop: lvl, changed: true, tag: "SuperTrend" };
  }
  if (side === "PE" && cur.trend === -1 && lvl > bar.close && (!_num(currentStop) || lvl < currentStop)) {
    return { stop: lvl, changed: true, tag: "SuperTrend" };
  }
  return unchanged;
}

module.exports = {
  NAME,
  PREFIX: DEFAULT_PREFIX,
  DEFAULT_PREFIX,
  PREFIXES,
  DESCRIPTION,
  TFS,
  getConfig,
  warmupBars,
  warmupDays,
  isInTradingWindow,
  isEodExit,
  computePivots,
  computeSeries,
  checkBar,
  getSignal,
  exitCheck,
  trailStop,
  _istDayOf,
  _istMins,
};

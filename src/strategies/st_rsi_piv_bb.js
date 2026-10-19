/**
 * STRATEGY: ST_RSI_PIV_BB  (created 2026-10-19)
 * ═════════════════════════════════════════════════════════════════════════════
 * "All four agree" — SuperTrend + RSI + Pivots + Bollinger Band, together.
 * NIFTY 50 only · option BUYING · intraday · Fyers data, Zerodha orders.
 *
 * Indicators (all on the SPOT chart, all read on a CLOSED candle):
 *   SuperTrend(10, 2) · RSI(14) · Bollinger Bands(20, 2) on close ·
 *   Traditional (floor) pivots from the PREVIOUS day's daily H/L/C:
 *     PP = (H+L+C)/3   R1 = 2·PP − L   S1 = 2·PP − H
 *   The pivots are fixed before the open and never move intraday.
 *
 * ── ENTRY — BUY_CE, all FOUR true on the same closed candle ──────────────────
 *   1. SuperTrend is GREEN (trend = +1, line below price)
 *   2. RSI(14) > ST_RSI_PIV_BB_RSI_CE_MIN (70)
 *   3. close > R1   — ANY close above R1 counts, not only a fresh cross (the
 *                     user's choice: "close above R1", 2026-10-19)
 *   4. close > the upper Bollinger Band
 * ── ENTRY — BUY_PE, the exact mirror ─────────────────────────────────────────
 *   1. SuperTrend RED · 2. RSI < ST_RSI_PIV_BB_RSI_PE_MAX (30) ·
 *   3. close < S1 · 4. close < the lower Bollinger Band
 *   3 of 4 is not a trade. Entry is on THAT candle — there is NO confirmation
 *   candle. Paper/Live fill at the first tick after the candle closes; Backtest
 *   fills at the next bar's OPEN. Those are the same market moment.
 *
 * ── TIMEFRAME — ST_RSI_PIV_BB_ENTRY_TF = 3 | 5 | BOTH (default BOTH) ─────────
 *   3     the four conditions are read on the 3-min chart; the trade lives there.
 *   5     the same, on the 5-min chart.
 *   BOTH  the trade lives on the 3-min chart, AND the latest CLOSED 5-min candle
 *         (the one whose close time is within the last 5 minutes of the 3-min
 *         candle's close) must ALSO show 4/4 for the SAME side. Both charts are
 *         built from the same spot feed. A 3-min close at 09:48 reads the 5-min
 *         candle that closed at 09:45; 09:51 reads 09:50.
 *   The exit always runs on the trade timeframe (3 for 3/BOTH, 5 for 5).
 *
 * ── EXIT — SuperTrend trailing stop, on CANDLE CLOSE only ───────────────────
 *   Initial stop = the SuperTrend value on the entry candle.
 *   At every later closed candle of the trade timeframe:
 *     CE exits when the SuperTrend flips RED on that candle, or the close is
 *        below the trailed stop.   PE: flips GREEN, or close above the stop.
 *     Otherwise the stop trails to that candle's SuperTrend value, tighten-only.
 *   The stop is NOT checked tick-by-tick (the user's choice, 2026-10-19): a
 *   candle that wicks through the line but closes back above it does not exit.
 *   Forced square-off at ST_RSI_PIV_BB_EOD_EXIT_TIME (15:15).
 *
 * ── DELIBERATELY NOT HERE (do not "helpfully" add these) ────────────────────
 *   No confirmation candle, no VIX gate, no OI filter, no ADX, no volume, no
 *   EMA, no VWAP, no ATR sizing, no fixed target, no profit booking, no
 *   breakeven jump, no premium stop, no tick-level stop, no cooldowns, no
 *   consecutive-loss breaker, no fresh-cross requirement on R1/S1. The only
 *   session guards are the entry window, max trades/day and the daily loss cap.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 *   Every decision reads closed-candle OHLC and the previous day's daily bar.
 *   Never a live tick, never live spot — so Paper ≡ Replay ≡ Backtest.
 *
 * ── NOT MARKET-VALIDATED ────────────────────────────────────────────────────
 *   Zero trades, paper or live. Every threshold is the user's stated rule (from
 *   a course slide), not a fitted value.
 *
 * Contract:
 *   getConfig()                          -> live env read (never cached)
 *   warmupBars(cfg)                      -> bars refused below, per timeframe
 *   computePivots(daily, { forDayKey })  -> { pp, r1, s1, r2, s2, forDayKey, ... }
 *   computeSeries(candles, cfg)          -> { rsi, bbUpper, bbMiddle, bbLower, supertrend } 1:1
 *   checkBar(bar, idx, series, pivots, cfg) -> the 4-box checklist for CE and PE
 *   getSignal(candles, opts)             -> { signal, reason, stopLoss, checks, ... }
 *   exitCheck(side, bar, stBar, stop)    -> { exit, reason } — the ONLY exit test
 *   trailStop(candles, side, stop, cfg, pre) -> { stop, changed, tag } tighten-only
 */

const { RSI, BollingerBands } = require("technicalindicators");
const { computeSuperTrend } = require("../utils/supertrend");

const NAME   = "ST_RSI_PIV_BB";
const PREFIX = "ST_RSI_PIV_BB";
const DESCRIPTION =
  "ST_RSI_PIV_BB — SuperTrend(10,2) + RSI(14) + previous-day pivot R1/S1 + Bollinger(20,2) breakout, " +
  "all four on one closed candle (3-min, 5-min or both) · SuperTrend trailing stop on candle close · NIFTY, Zerodha";

const ENTRY_TFS = ["3", "5", "BOTH"];

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

/**
 * Live config read. Settings saves mutate process.env in place, so this must
 * never be cached — every caller re-reads on each evaluation.
 */
function getConfig() {
  const rawTf = String(process.env[PREFIX + "_ENTRY_TF"] || "BOTH").trim().toUpperCase();
  const entryTf = ENTRY_TFS.includes(rawTf) ? rawTf : "BOTH";
  return {
    PREFIX,
    ENTRY_TF:     entryTf,
    // The trade timeframe: entries are evaluated and the trail/exit runs here.
    TRADE_RES:    entryTf === "5" ? 5 : 3,
    // BOTH only: the second chart that must agree. null = no second chart.
    CONFIRM_RES:  entryTf === "BOTH" ? 5 : null,

    RSI_PERIOD:   _intEnv(PREFIX + "_RSI_PERIOD", 14, 2, 100),
    RSI_CE_MIN:   _numEnv(PREFIX + "_RSI_CE_MIN", 70, 0, 100),
    RSI_PE_MAX:   _numEnv(PREFIX + "_RSI_PE_MAX", 30, 0, 100),
    ST_PERIOD:    _intEnv(PREFIX + "_ST_PERIOD", 10, 2, 100),
    ST_MULT:      _numEnv(PREFIX + "_ST_MULT", 2, 0.1, 10),
    BB_PERIOD:    _intEnv(PREFIX + "_BB_PERIOD", 20, 2, 200),
    BB_STDDEV:    _numEnv(PREFIX + "_BB_STDDEV", 2, 0.1, 10),

    ENTRY_START:  _parseHHMM(process.env[PREFIX + "_ENTRY_START"], 9 * 60 + 30),
    ENTRY_END:    _parseHHMM(process.env[PREFIX + "_ENTRY_END"], 15 * 60),
    EOD_EXIT:     _parseHHMM(process.env[PREFIX + "_EOD_EXIT_TIME"], 15 * 60 + 15),

    // Session guards. Route-level, but read here so one config describes the mode.
    MAX_DAILY_TRADES: _intEnv(PREFIX + "_MAX_DAILY_TRADES", 3, 1, 50),
    MAX_DAILY_LOSS: _numEnv(PREFIX + "_MAX_DAILY_LOSS", 5000, 0),
  };
}

/**
 * Bars the engine refuses below, on EACH timeframe it reads. 25 at the
 * defaults: 75 min of 3-min bars, 125 min of 5-min bars — so a start before
 * ~11:20 needs the previous session preloaded. Routes must preload DAYS
 * (ST_RSI_PIV_BB_WARMUP_DAYS), not just today.
 */
function warmupBars(cfg) {
  cfg = cfg || getConfig();
  return Math.max(cfg.BB_PERIOD, cfg.ST_PERIOD + 1, cfg.RSI_PERIOD + 1) + 5;
}
function warmupDays() { return _intEnv(PREFIX + "_WARMUP_DAYS", 3, 1, 15); }

/** Entry window on the signal candle's CLOSE time (= the moment the entry fills). */
function isInTradingWindow(barTimeSec, cfg) {
  cfg = cfg || getConfig();
  const closeMin = _istMins(barTimeSec + cfg.TRADE_RES * 60);
  if (closeMin < cfg.ENTRY_START) return { ok: false, reason: `Before ${_fmtMins(cfg.ENTRY_START)} — outside the entry window` };
  if (closeMin > cfg.ENTRY_END)   return { ok: false, reason: `After ${_fmtMins(cfg.ENTRY_END)} — no new entries` };
  return { ok: true, reason: null };
}

// ── Traditional (floor) pivots ───────────────────────────────────────────────
/**
 * Levels for the IST day `opts.forDayKey`, from the newest daily bar strictly
 * BEFORE that day — so a backtest walking history never peeks at the day it is
 * trading, and a forming daily bar can never make R1/S1 drift intraday.
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
 *   RSI(L) over M closes → M−L outputs, out[j] ↔ candles[j+L]
 *   BollingerBands(p) over N closes → N−p+1 outputs, out[i] ↔ candles[i+p−1]
 */
function computeSeries(candles, cfg) {
  cfg = cfg || getConfig();
  const n = Array.isArray(candles) ? candles.length : 0;
  const rsi = new Array(n).fill(null);
  const bbUpper = new Array(n).fill(null);
  const bbMiddle = new Array(n).fill(null);
  const bbLower = new Array(n).fill(null);
  if (n === 0) return { rsi, bbUpper, bbMiddle, bbLower, supertrend: [] };
  const closes = candles.map((c) => c.close);

  const rsiArr = RSI.calculate({ period: cfg.RSI_PERIOD, values: closes });
  for (let j = 0; j < rsiArr.length; j++) rsi[j + cfg.RSI_PERIOD] = rsiArr[j];

  const bbArr = BollingerBands.calculate({ period: cfg.BB_PERIOD, values: closes, stdDev: cfg.BB_STDDEV });
  for (let i = 0; i < bbArr.length; i++) {
    const k = i + cfg.BB_PERIOD - 1;
    bbUpper[k] = bbArr[i].upper;
    bbMiddle[k] = bbArr[i].middle;
    bbLower[k] = bbArr[i].lower;
  }
  const supertrend = computeSuperTrend(candles, cfg.ST_PERIOD, cfg.ST_MULT);
  return { rsi, bbUpper, bbMiddle, bbLower, supertrend };
}

/**
 * The 4-box checklist for one closed bar — the whole entry rule, both sides.
 * `ready:false` when any input is missing; the caller must refuse, not guess.
 */
function checkBar(bar, idx, series, pivots, cfg) {
  cfg = cfg || getConfig();
  const st = series.supertrend[idx];
  const rsi = series.rsi[idx], up = series.bbUpper[idx], lo = series.bbLower[idx], mid = series.bbMiddle[idx];
  const out = {
    ready: false, time: bar ? bar.time : null, close: bar ? bar.close : null,
    rsi: _num(rsi) ? _r2(rsi) : null,
    bbUpper: _num(up) ? _r2(up) : null, bbMiddle: _num(mid) ? _r2(mid) : null, bbLower: _num(lo) ? _r2(lo) : null,
    supertrend: st && _num(st.value) ? st.value : null,
    stTrend: st && (st.trend === 1 || st.trend === -1) ? st.trend : null,
    CE: { st: false, rsi: false, piv: false, bb: false, count: 0 },
    PE: { st: false, rsi: false, piv: false, bb: false, count: 0 },
  };
  if (!_okBar(bar) || out.rsi == null || out.bbUpper == null || out.bbLower == null ||
      out.supertrend == null || out.stTrend == null ||
      !pivots || !_num(pivots.r1) || !_num(pivots.s1)) return out;
  const c = bar.close;
  out.ready = true;
  out.CE = { st: out.stTrend === 1, rsi: rsi > cfg.RSI_CE_MIN, piv: c > pivots.r1, bb: c > up };
  out.PE = { st: out.stTrend === -1, rsi: rsi < cfg.RSI_PE_MAX, piv: c < pivots.s1, bb: c < lo };
  for (const s of ["CE", "PE"]) {
    const k = out[s];
    k.count = (k.st ? 1 : 0) + (k.rsi ? 1 : 0) + (k.piv ? 1 : 0) + (k.bb ? 1 : 0);
  }
  return out;
}

function _missing(side, k, pivots, chk, cfg) {
  const m = [];
  if (side === "CE") {
    if (!k.st)  m.push("ST not green");
    if (!k.rsi) m.push(`RSI ${chk.rsi} ≤ ${cfg.RSI_CE_MIN}`);
    if (!k.piv) m.push(`C ${chk.close} ≤ R1 ${pivots.r1}`);
    if (!k.bb)  m.push(`C ${chk.close} ≤ BB up ${chk.bbUpper}`);
  } else {
    if (!k.st)  m.push("ST not red");
    if (!k.rsi) m.push(`RSI ${chk.rsi} ≥ ${cfg.RSI_PE_MAX}`);
    if (!k.piv) m.push(`C ${chk.close} ≥ S1 ${pivots.s1}`);
    if (!k.bb)  m.push(`C ${chk.close} ≥ BB low ${chk.bbLower}`);
  }
  return m.join(", ");
}

/**
 * Locate, in the 5-min series, the candle that closed in (T−5min, T] where T is
 * the trade candle's close. -1 when it is missing — the caller refuses.
 * Paper must append the 5-min candle BEFORE evaluating the 3-min candle that
 * closes on the same tick (09:45, 09:50 …), or this returns -1 and refuses.
 */
function _confirmIndex(confirmCandles, tradeCloseSec, confirmRes) {
  const span = confirmRes * 60;
  for (let i = confirmCandles.length - 1; i >= 0; i--) {
    const c = confirmCandles[i];
    if (!c || !_num(c.time)) continue;
    const cClose = c.time + span;
    if (cClose > tradeCloseSec) continue;          // still forming at T — never read it
    return cClose > tradeCloseSec - span ? i : -1;  // older than one bar = stale
  }
  return -1;
}

const _NO = { stopLoss: null, slSpot: null, entrySpot: null, prevCandleHigh: null, prevCandleLow: null };

/**
 * getSignal(candles, opts)
 *   candles — ascending CLOSED bars on the trade timeframe; the LAST one is the
 *             signal candle.
 *   opts.pivots          — computePivots(daily, { forDayKey: signal day }). REQUIRED.
 *   opts.confirmCandles  — BOTH only: closed 5-min bars from the same feed.
 *   opts.precomputed     — BACKTEST ONLY: { series, endIdx, cfg } over the whole
 *                          array; every indicator is causal, so it is identical to
 *                          recomputing on candles.slice(0, endIdx+1).
 *   opts.confirmSeries   — BACKTEST ONLY: computeSeries(confirmCandles) over the whole array.
 *   opts.skipTimeCheck   — exit-time indicator snapshots only, never the entry path.
 * Returns { signal: "BUY_CE"|"BUY_PE"|"NONE", reason, warmup, stopLoss, slSpot,
 *           entrySpot, checks, confirmChecks, rsi, bbUpper, bbMiddle, bbLower,
 *           supertrend, stTrend, r1, s1, pp, ... }.
 */
function getSignal(candles, opts) {
  const o = opts || {};
  const pre = o.precomputed || null;
  const cfg = (pre && pre.cfg) || getConfig();
  const WARMUP = warmupBars(cfg);
  const nBars = !Array.isArray(candles) ? 0 : pre ? pre.endIdx + 1 : candles.length;
  if (nBars < WARMUP) {
    return Object.assign({ signal: "NONE", warmup: true, reason: `Warming up (${nBars}/${WARMUP} ${cfg.TRADE_RES}-min candles)` }, _NO);
  }
  const last = nBars - 1;
  const bar = candles[last];
  const prev = candles[last - 1];
  if (!_okBar(bar) || !_okBar(prev)) {
    return Object.assign({ signal: "NONE", warmup: true, reason: "Bad candle data (non-finite OHLC on the signal or previous candle)" }, _NO);
  }

  const pivots = o.pivots || null;
  const dayKey = _istDayOf(bar.time);
  if (!pivots || !_num(pivots.r1) || !_num(pivots.s1)) {
    return Object.assign({ signal: "NONE", warmup: true, reason: "Previous day's high/low/close unavailable — no R1/S1, refusing to trade" }, _NO);
  }
  if (_num(pivots.forDayKey) && pivots.forDayKey !== dayKey) {
    return Object.assign({ signal: "NONE", warmup: true, reason: `Pivots are for another day (${pivots.forDayKey} vs ${dayKey}) — refusing stale R1/S1` }, _NO);
  }

  const series = pre ? pre.series : computeSeries(candles, cfg);
  const chk = checkBar(bar, last, series, pivots, cfg);
  const base = {
    warmup: false,
    rsi: chk.rsi, bbUpper: chk.bbUpper, bbMiddle: chk.bbMiddle, bbLower: chk.bbLower,
    supertrend: chk.supertrend,
    stTrend: chk.stTrend === 1 ? "BULLISH" : chk.stTrend === -1 ? "BEARISH" : null,
    stTrendInt: chk.stTrend,
    pp: pivots.pp, r1: pivots.r1, s1: pivots.s1, r2: pivots.r2, s2: pivots.s2,
    pivotsFrom: pivots.from || null,
    checks: chk, confirmChecks: null, confirmTime: null,
    entryTf: cfg.ENTRY_TF, tradeRes: cfg.TRADE_RES,
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

  const ceAll = chk.CE.count === 4, peAll = chk.PE.count === 4;
  const tag = cfg.TRADE_RES + "m";
  if (!ceAll && !peAll) {
    const side = chk.CE.count >= chk.PE.count ? "CE" : "PE";
    return Object.assign({}, base, {
      signal: "NONE",
      reason: `${tag} CE ${chk.CE.count}/4 · PE ${chk.PE.count}/4 — ${side} missing: ${_missing(side, chk[side], pivots, chk, cfg)}`,
    });
  }
  const side = ceAll ? "CE" : "PE";

  // ── BOTH: the latest closed 5-min candle must also be 4/4, same side ────────
  if (cfg.CONFIRM_RES) {
    const cc = o.confirmCandles;
    const tradeClose = bar.time + cfg.TRADE_RES * 60;
    const ci = Array.isArray(cc) ? _confirmIndex(cc, tradeClose, cfg.CONFIRM_RES) : -1;
    if (ci < 0) {
      return Object.assign({}, base, { signal: "NONE", warmup: true, reason: `${tag} ${side} 4/4 but no closed ${cfg.CONFIRM_RES}-min candle for this moment — refusing` });
    }
    if (ci + 1 < WARMUP) {
      return Object.assign({}, base, { signal: "NONE", warmup: true, reason: `${tag} ${side} 4/4 but ${cfg.CONFIRM_RES}-min chart warming up (${ci + 1}/${WARMUP})` });
    }
    const cSeries = o.confirmSeries || computeSeries(cc.slice(0, ci + 1), cfg);
    const cChk = checkBar(cc[ci], ci, cSeries, pivots, cfg);
    base.confirmChecks = cChk;
    base.confirmTime = cc[ci].time;
    if (!cChk.ready) {
      return Object.assign({}, base, { signal: "NONE", warmup: true, reason: `${tag} ${side} 4/4 but ${cfg.CONFIRM_RES}-min indicators not ready` });
    }
    if (cChk[side].count !== 4) {
      return Object.assign({}, base, {
        signal: "NONE",
        reason: `${tag} ${side} 4/4 but ${cfg.CONFIRM_RES}m only ${cChk[side].count}/4 — missing: ${_missing(side, cChk[side], pivots, cChk, cfg)}`,
      });
    }
  }

  // A green SuperTrend sits below the close by construction; refuse anyway if it
  // does not, rather than open a trade whose stop is already through the entry.
  const stv = chk.supertrend;
  if ((side === "CE" && !(stv < bar.close)) || (side === "PE" && !(stv > bar.close))) {
    return Object.assign({}, base, { signal: "NONE", skipReason: "st_wrong_side", reason: `${side} 4/4 but SuperTrend ${stv} is not beyond the close ${bar.close} — no stop, no trade` });
  }
  const sl = _r2(stv);
  const conf = cfg.CONFIRM_RES ? ` + ${cfg.CONFIRM_RES}m 4/4` : "";
  const reason = side === "CE"
    ? `CE ${tag} 4/4${conf}: ST green | RSI ${chk.rsi}>${cfg.RSI_CE_MIN} | C ${bar.close}>R1 ${pivots.r1} | C>BB up ${chk.bbUpper} | SL=ST ${sl}`
    : `PE ${tag} 4/4${conf}: ST red | RSI ${chk.rsi}<${cfg.RSI_PE_MAX} | C ${bar.close}<S1 ${pivots.s1} | C<BB low ${chk.bbLower} | SL=ST ${sl}`;
  if (!o.silent) console.log(`[${NAME}] 🟢 ${side === "CE" ? "BUY_CE" : "BUY_PE"} — ${reason}`);
  return Object.assign({}, base, { signal: side === "CE" ? "BUY_CE" : "BUY_PE", stopLoss: sl, slSpot: sl, reason });
}

/**
 * The ONLY exit test, run on each CLOSED trade-timeframe candle while a
 * position is open. `stBar` is that candle's SuperTrend { value, trend }, `stop`
 * the trail in force BEFORE this candle.
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
 * `precomputed` — BACKTEST ONLY: { supertrend, endIdx } over the whole array.
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

/** True when the given IST minute is at/after the forced square-off. */
function isEodExit(unixSec, cfg) {
  cfg = cfg || getConfig();
  return _istMins(unixSec) >= cfg.EOD_EXIT;
}

module.exports = {
  NAME,
  PREFIX,
  DEFAULT_PREFIX: PREFIX,
  DESCRIPTION,
  ENTRY_TFS,
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
  _confirmIndex,
};

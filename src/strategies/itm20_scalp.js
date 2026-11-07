/**
 * ITM20_SCALP — NIFTY 15-min opening-range breakout + retest, 1 strike ITM,
 *               +20 / −10 premium points
 * ═════════════════════════════════════════════════════════════════════════════
 * Single-leg NIFTY option BUYING (CE or PE), intraday, current weekly expiry.
 * Paper + Backtest only. Fyers data. Rules confirmed by the user 2026-11-08 —
 * do not change them without the user's permission.
 *
 * ── LEVELS ──────────────────────────────────────────────────────────────────
 *  • Opening range = high / low of the three 5-min candles 09:15, 09:20, 09:25
 *    (09:15–09:30 IST). Nothing trades before 09:30.
 *  • VWAP = session-anchored (09:15), EQUAL-WEIGHTED running mean of HLC3. The
 *    NIFTY 50 index has no volume, so this is the same VWAP the EMA9_VWAP
 *    engine uses. Read at each candle's CLOSE (includes that candle).
 *  • EMA9 = technicalindicators EMA(9) on 5-min CLOSES, run continuously from
 *    the previous session (TradingView style). The engine always computes it
 *    over exactly [previous session's first bar … newest bar], so Paper,
 *    Backtest and Replay feed it the same window and get the same number.
 *    "Rising" = EMA of this candle > EMA of the previous completed candle.
 *
 * ── CE SETUP (PE is the mirror at the range LOW) ───────────────────────────
 *  1. BREAKOUT  — a 5-min candle (starting 09:30 or later) CLOSES above the
 *     range high, with close > VWAP, EMA9 > VWAP and EMA9 rising.
 *  2. RETEST    — within the next RETEST_CANDLES (3) candles, a candle's LOW
 *     comes within RETEST_TOL_PTS (5) of the range high (low ≤ high + 5).
 *  3. NEVER BACK INSIDE — any of those candles CLOSING at or below the range
 *     high kills the setup.
 *  4. CONFIRM   — the retest candle itself or a later one (still inside the
 *     3-candle window) is green (close > open) and closes above the previous
 *     candle's HIGH, with close > VWAP, EMA9 > VWAP and EMA9 rising re-checked
 *     on that candle. The signal fires when it CLOSES.
 *  5. Confirm candle must close by ENTRY_END (11:30).
 *
 *  A setup that dies (back inside) re-arms at once — price is already inside.
 *  A setup that expires (3 candles, no confirm), fires, or traded must see a
 *  candle CLOSE back inside the range before a new breakout counts. A trade's
 *  bars are skipped: scanning resumes with the first bar that closes after
 *  the trade's exit (opts.resumeAfterSec).
 *
 * ── STRIKE / EXITS / DAY LIMITS ─────────────────────────────────────────────
 *  • Strike: exactly 1 listed strike ITM — CE = the highest strike BELOW spot,
 *    PE = the lowest strike ABOVE spot (itmStrike). Grid step comes from the
 *    instrument config, never hard-coded here.
 *  • Exits on OPTION PREMIUM: target entry + 20, stop entry − 10, whole
 *    position. Same candle touches both → stop first (backtest). Square-off
 *    15:15. The daily loss cap (−20 points) tightens the stop of a second
 *    trade if the first loss was worse than −10 (never widens it).
 *  • Day: max 2 trades; stop after a win; stop after 2 losses; stop at −20
 *    points. Expiry day skipped unless TRADE_EXPIRY_DAY=true.
 *
 * ── FILL, ONE MOMENT FOR ALL MODES ──────────────────────────────────────────
 * Paper fills on the first option quote after the confirm candle closes;
 * Backtest fills at the NEXT bar's OPEN. Same market moment.
 *
 * ── DELIBERATELY NOT HERE (do not "helpfully" add these) ────────────────────
 * No volume rule (index has none), no VIX, OI, ADX, RSI, ATR, SuperTrend,
 * trailing stop, partial exit, averaging, martingale, re-entry beyond the day
 * limits, or quality score. The common Trade Window (10:00–14:00) is NOT
 * applied — this strategy's own 09:30–11:30 window is part of its rules.
 *
 * ── NOT MARKET-VALIDATED ────────────────────────────────────────────────────
 * Zero paper and zero live trades as of 2026-11-08. A July-2026 ORB experiment
 * found requiring a retest made ORB worse — watch for the same here.
 *
 * Contract:
 *   getConfig()                              -> live env read (never cached)
 *   computeSeries(candles, cfg)              -> window + aligned ema[] / vwap[]
 *   getSignal(candles, opts)                 -> { signal, side, phase, ... }
 *   itmStrike(spot, side, step)              -> strike
 *   dayRiskGate(closedTrades, cfg)           -> { allowed, reason, dayPts, ... }
 *   stopLevel(entryPrem, dayPts, cfg)        -> { level, kind }
 *   targetLevel(entryPrem, cfg)              -> premium
 */

const { EMA } = require("technicalindicators");

const NAME = "ITM20_SCALP";
const DESCRIPTION =
  "ITM20 Scalp — 15-min opening-range breakout above/below VWAP with a rising/falling EMA9, a retest within " +
  "3 candles and a confirmation close; 1 strike ITM, +20 / −10 premium points, max 2 trades a day";

const RESOLUTION_MIN = 5;   // fixed by the rules
const OR_MINS        = 15;  // fixed by the rules: 09:15–09:30
const MARKET_CLOSE_MIN = 15 * 60 + 30;
// Previous session must reach this close for EMA continuity to be trusted.
const PREV_DAY_MIN_CLOSE = 15 * 60;

// ── primitives ───────────────────────────────────────────────────────────────
function _r2(x) { return Math.round(x * 100) / 100; }
function _num(x) { return typeof x === "number" && Number.isFinite(x); }
function _istDayOf(unixSec) { return Math.floor((unixSec + 19800) / 86400); }
function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _istDateStr(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function _parseHHMM(raw, def) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(raw == null ? "" : raw));
  if (!m) return def;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return def;
  return h * 60 + mm;
}
function _fmtMins(mins) {
  if (!_num(mins)) return "--:--";
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function _intEnv(key, def, min, max) {
  const v = parseInt(process.env[key], 10);
  if (!Number.isFinite(v) || v < min || v > max) return def;
  return v;
}
function _numEnv(key, def, min, max, exclusiveMin) {
  const v = parseFloat(process.env[key]);
  if (!Number.isFinite(v)) return def;
  if (exclusiveMin ? !(v > min) : v < min) return def;
  if (v > max) return def;
  return v;
}
function _okBar(c) {
  return !!c && _num(c.time) && _num(c.open) && _num(c.high) && _num(c.low) && _num(c.close);
}

/** Live config read. Settings saves mutate process.env — never cache. */
function getConfig() {
  const sessionStartMin = _parseHHMM(process.env.ITM20_SCALP_SESSION_START, 9 * 60 + 15);
  const orEndMin = sessionStartMin + OR_MINS;
  return {
    resolutionMins: RESOLUTION_MIN,
    orMins: OR_MINS,
    sessionStartMin,
    orEndMin,
    // No breakout candle may start before the range is complete.
    entryStartMin: Math.max(orEndMin, _parseHHMM(process.env.ITM20_SCALP_ENTRY_START, 9 * 60 + 30)),
    entryEndMin:   _parseHHMM(process.env.ITM20_SCALP_ENTRY_END, 11 * 60 + 30),
    squareOffMin:  _parseHHMM(process.env.ITM20_SCALP_SQUARE_OFF, 15 * 60 + 15),
    emaPeriod:     _intEnv("ITM20_SCALP_EMA_PERIOD", 9, 2, 50),
    retestTolPts:  _numEnv("ITM20_SCALP_RETEST_TOL_PTS", 5, 0, 100, false),
    retestCandles: _intEnv("ITM20_SCALP_RETEST_CANDLES", 3, 1, 10),
    targetPts:     _numEnv("ITM20_SCALP_TARGET_PTS", 20, 0, 500, true),
    slPts:         _numEnv("ITM20_SCALP_SL_PTS", 10, 0, 500, true),
    maxTrades:     _intEnv("ITM20_SCALP_MAX_TRADES", 2, 1, 5),
    dailyLossPts:  _numEnv("ITM20_SCALP_DAILY_LOSS_PTS", 20, 0, 1000, true),
    tradeExpiryDay: String(process.env.ITM20_SCALP_TRADE_EXPIRY_DAY || "false").toLowerCase() === "true",
  };
}

// ── series ───────────────────────────────────────────────────────────────────
/**
 * The decision window — [previous session's first bar … newest bar], in-session
 * bars only — plus EMA and VWAP aligned 1:1 with it.
 *
 * @returns {{ bars, ema: (number|null)[], vwap: (number|null)[], today, prevDay,
 *             prevComplete, prevBars }}
 */
function computeSeries(candles, cfg) {
  const c = cfg || getConfig();
  const out = { bars: [], ema: [], vwap: [], today: null, prevDay: null, prevComplete: false, prevBars: 0 };
  if (!Array.isArray(candles) || !candles.length) return out;
  const last = candles[candles.length - 1];
  if (!_okBar(last)) return out;
  const today = _istDayOf(last.time);
  out.today = today;

  let prevDay = null;
  for (let i = candles.length - 1; i >= 0; i--) {
    const b = candles[i];
    if (!b || !_num(b.time)) continue;
    const d = _istDayOf(b.time);
    if (d < today) { prevDay = d; break; }
  }
  out.prevDay = prevDay;
  const fromDay = prevDay == null ? today : prevDay;

  const bars = [];
  for (const b of candles) {
    if (!_okBar(b)) continue;
    const d = _istDayOf(b.time);
    if (d < fromDay || d > today) continue;
    const m = _utcSecToIstMins(b.time);
    if (m < c.sessionStartMin || m >= MARKET_CLOSE_MIN) continue;
    bars.push(b);
  }
  bars.sort((a, b) => a.time - b.time);
  out.bars = bars;

  let prevLastClose = null;
  for (const b of bars) {
    if (_istDayOf(b.time) !== prevDay) continue;
    out.prevBars++;
    const closeMin = _utcSecToIstMins(b.time) + RESOLUTION_MIN;
    if (prevLastClose == null || closeMin > prevLastClose) prevLastClose = closeMin;
  }
  out.prevComplete = prevDay != null && prevLastClose != null && prevLastClose >= PREV_DAY_MIN_CLOSE;

  // EMA: out[i] ↔ values[i + p - 1]
  const p = c.emaPeriod;
  const ema = new Array(bars.length).fill(null);
  if (bars.length >= p) {
    const e = EMA.calculate({ period: p, values: bars.map(b => b.close) });
    for (let j = 0; j < e.length; j++) ema[j + p - 1] = e[j];
  }
  out.ema = ema;

  // VWAP: equal-weighted HLC3 running mean, reset each IST day at session start.
  const vwap = new Array(bars.length).fill(null);
  let day = null, sum = 0, n = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = _istDayOf(b.time);
    if (d !== day) { day = d; sum = 0; n = 0; }
    sum += (b.high + b.low + b.close) / 3;
    n++;
    vwap[i] = sum / n;
  }
  out.vwap = vwap;
  return out;
}

/** Opening range for `today` from the window bars. */
function _openingRange(bars, today, cfg) {
  const orBars = bars.filter(b => _istDayOf(b.time) === today &&
    _utcSecToIstMins(b.time) >= cfg.sessionStartMin && _utcSecToIstMins(b.time) < cfg.orEndMin);
  const expected = Math.ceil(cfg.orMins / RESOLUTION_MIN);
  if (!orBars.length) return { high: null, low: null, bars: 0, expected, complete: false };
  const complete = orBars.length === expected && _utcSecToIstMins(orBars[0].time) === cfg.sessionStartMin;
  return {
    high: _r2(Math.max(...orBars.map(b => b.high))),
    low:  _r2(Math.min(...orBars.map(b => b.low))),
    bars: orBars.length, expected, complete,
  };
}

// ── the signal ───────────────────────────────────────────────────────────────
function _base(cfg) {
  return {
    signal: "NONE", side: null, reason: "", skipReason: "", warmup: false, dayDead: false,
    phase: "waiting",          // waiting | armed | up | down | need_inside | closed
    orHigh: null, orLow: null,
    vwap: null, ema: null, emaPrev: null, trend: null,
    breakoutTime: null, breakoutSide: null, breakoutClose: null,
    retestTime: null, candlesLeft: null,
    entrySpot: null, signalBarTime: null,
    rawOpen: null, rawHigh: null, rawLow: null, rawClose: null,
    missedSignalTime: null,    // a signal fired on an EARLIER bar of this scan (not the newest)
    signalStrength: null,
    cfg,
  };
}

function _trendOf(close, ema, emaPrev, vwap) {
  if (!_num(close) || !_num(ema) || !_num(emaPrev) || !_num(vwap)) return null;
  if (close > vwap && ema > vwap && ema > emaPrev) return "BULLISH";
  if (close < vwap && ema < vwap && ema < emaPrev) return "BEARISH";
  return "SIDEWAYS";
}

/**
 * getSignal(candles, opts)
 *
 * @param {Array}  candles ascending CLOSED 5-min NIFTY spot bars covering the
 *                 previous session and today so far; the LAST one is the bar
 *                 that just closed.
 * @param {object} opts { cfg, resumeAfterSec, silent }
 *                 resumeAfterSec — unix secs of the previous trade's exit
 *                 today; bars that closed at or before it are skipped and the
 *                 scan restarts needing a close back inside the range.
 */
function getSignal(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const base = _base(cfg);

  if (!Array.isArray(candles) || !candles.length) {
    base.warmup = true; base.skipReason = base.reason = "No candles yet"; return base;
  }
  const sig = candles[candles.length - 1];
  if (!_okBar(sig)) {
    base.skipReason = base.reason = "Latest candle has no usable OHLC — refusing to decide"; return base;
  }
  base.signalBarTime = sig.time;
  base.rawOpen = _r2(sig.open); base.rawHigh = _r2(sig.high); base.rawLow = _r2(sig.low); base.rawClose = _r2(sig.close);

  const S = computeSeries(candles, cfg);
  const bars = S.bars;
  const gLast = bars.length - 1;
  if (gLast < 0 || bars[gLast].time !== sig.time) {
    base.skipReason = base.reason = "Latest candle is outside the 09:15–15:30 session"; return base;
  }
  if (S.prevDay == null) {
    base.warmup = true;
    base.skipReason = base.reason = "No previous session in the history — EMA9 cannot be warmed"; return base;
  }
  if (!S.prevComplete || S.prevBars < 3 * cfg.emaPeriod) {
    base.warmup = true;
    base.skipReason = base.reason = `Previous session is incomplete (${S.prevBars} bars) — EMA${cfg.emaPeriod} not trusted`;
    return base;
  }
  if (sig.time % 300 !== 0) {
    base.skipReason = base.reason = "Candles are not 5-minute bars — refusing to decide"; return base;
  }

  base.vwap = _num(S.vwap[gLast]) ? _r2(S.vwap[gLast]) : null;
  base.ema = _num(S.ema[gLast]) ? _r2(S.ema[gLast]) : null;
  base.emaPrev = gLast > 0 && _num(S.ema[gLast - 1]) ? _r2(S.ema[gLast - 1]) : null;
  base.trend = _trendOf(sig.close, S.ema[gLast], gLast > 0 ? S.ema[gLast - 1] : null, S.vwap[gLast]);

  const startMin = _utcSecToIstMins(sig.time);
  if (startMin < cfg.orEndMin) {
    base.skipReason = base.reason = `Opening range ${_fmtMins(cfg.sessionStartMin)}–${_fmtMins(cfg.orEndMin)} still forming`;
    return base;
  }
  const orr = _openingRange(bars, S.today, cfg);
  if (!orr.complete) {
    base.dayDead = true;
    base.skipReason = base.reason = `Opening range is incomplete (${orr.bars}/${orr.expected} bars) — no trade today`;
    return base;
  }
  const ORH = orr.high, ORL = orr.low;
  base.orHigh = ORH; base.orLow = ORL;

  // ── scan today's bars as a small state machine ─────────────────────────────
  const resume = _num(o.resumeAfterSec) ? o.resumeAfterSec : null;
  let phase = resume != null ? "need_inside" : "armed";
  let brk = null;       // { side, gi, time, close }
  let retest = null;    // { gi, time }
  let note = "";
  let fired = null;     // { side, gi } — signal on some bar of the scan

  for (let gi = 0; gi <= gLast; gi++) {
    const b = bars[gi];
    if (_istDayOf(b.time) !== S.today) continue;
    const m = _utcSecToIstMins(b.time);
    if (m < cfg.entryStartMin) continue;
    if (resume != null && b.time + RESOLUTION_MIN * 60 <= resume) continue;
    const ema = S.ema[gi], emaPrev = gi > 0 ? S.ema[gi - 1] : null, vw = S.vwap[gi];
    if (!_num(ema) || !_num(emaPrev) || !_num(vw)) continue;
    const bull = b.close > vw && ema > vw && ema > emaPrev;
    const bear = b.close < vw && ema < vw && ema < emaPrev;
    const inside = b.close <= ORH && b.close >= ORL;
    const closeMin = m + RESOLUTION_MIN;

    if (phase === "need_inside") {
      if (inside) { phase = "armed"; note = `${_fmtMins(m)} closed back inside the range — re-armed`; }
      continue;
    }

    if (phase === "up" || phase === "down") {
      const isUp = phase === "up";
      const n = Math.round((b.time - brk.time) / (RESOLUTION_MIN * 60));
      const failed = isUp ? b.close <= ORH : b.close >= ORL;
      if (failed) {
        note = `${brk.side} setup from ${_fmtMins(_utcSecToIstMins(brk.time))} died — ${_fmtMins(m)} closed back ${isUp ? "at/below the range high" : "at/above the range low"}`;
        phase = "armed"; brk = null; retest = null;
        // fall through: this same bar is judged as an armed bar (a close
        // straight through the other side can be a fresh breakout).
      } else {
        if (!retest && (isUp ? b.low <= ORH + cfg.retestTolPts : b.high >= ORL - cfg.retestTolPts)) {
          retest = { gi, time: b.time };
        }
        const prev = bars[gi - 1];
        const confirm = retest && _okBar(prev) && (isUp
          ? (b.close > b.open && b.close > prev.high && bull)
          : (b.close < b.open && b.close < prev.low && bear));
        if (confirm && closeMin <= cfg.entryEndMin) {
          fired = { side: brk.side, gi, brk: { ...brk }, retest: { ...retest } };
          phase = "need_inside"; brk = null; retest = null;
          note = `${fired.side} signal on the ${_fmtMins(m)} candle — setup used`;
          continue;
        }
        if (n >= cfg.retestCandles) {
          note = `${brk.side} setup from ${_fmtMins(_utcSecToIstMins(brk.time))} expired — ` +
            (retest ? `retested but no confirmation in ${cfg.retestCandles} candles` : `no retest in ${cfg.retestCandles} candles`);
          phase = "need_inside"; brk = null; retest = null;
        }
        continue;
      }
    }

    // phase === "armed"
    if (b.close > ORH && bull) {
      phase = "up"; brk = { side: "CE", gi, time: b.time, close: b.close }; retest = null;
      note = `${_fmtMins(m)} closed ${_r2(b.close)} above the range high ${ORH} (above VWAP, EMA9 rising) — waiting for a retest`;
    } else if (b.close < ORL && bear) {
      phase = "down"; brk = { side: "PE", gi, time: b.time, close: b.close }; retest = null;
      note = `${_fmtMins(m)} closed ${_r2(b.close)} below the range low ${ORL} (below VWAP, EMA9 falling) — waiting for a retest`;
    }
  }

  base.phase = phase;
  if (brk) {
    base.breakoutTime = brk.time; base.breakoutSide = brk.side; base.breakoutClose = _r2(brk.close);
    base.candlesLeft = Math.max(0, cfg.retestCandles - Math.round((sig.time - brk.time) / (RESOLUTION_MIN * 60)));
  }
  if (retest) base.retestTime = retest.time;

  if (fired && fired.gi === gLast) {
    const side = fired.side;
    base.signal = side === "CE" ? "BUY_CE" : "BUY_PE";
    base.side = side;
    base.signalStrength = "STRONG";
    base.entrySpot = _r2(sig.close);
    base.breakoutTime = fired.brk.time; base.breakoutSide = side; base.breakoutClose = _r2(fired.brk.close);
    base.retestTime = fired.retest.time;
    base.reason =
      `ITM20 ${side}: ${_fmtMins(_utcSecToIstMins(fired.brk.time))} closed ${_r2(fired.brk.close)} ${side === "CE" ? "above the range high" : "below the range low"} ` +
      `${side === "CE" ? ORH : ORL} · retest ${_fmtMins(_utcSecToIstMins(fired.retest.time))} · ` +
      `${_fmtMins(startMin)} confirm closed ${_r2(sig.close)} ${side === "CE" ? "above" : "below"} the previous candle's ${side === "CE" ? "high" : "low"} ` +
      `(VWAP ${base.vwap}, EMA${cfg.emaPeriod} ${base.ema})`;
    if (!o.silent) {
      const ist = new Date(sig.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23" });
      console.log(`[ITM20_SCALP ${ist}] SIGNAL ${side} @ ${base.entrySpot}`);
    }
    return base;
  }
  if (fired) base.missedSignalTime = bars[fired.gi].time;

  if (startMin + RESOLUTION_MIN > cfg.entryEndMin) {
    base.phase = "closed";
    base.skipReason = base.reason = `Past the ${_fmtMins(cfg.entryEndMin)} entry cut-off — no new entries today${note ? " · " + note : ""}`;
    return base;
  }
  base.skipReason = base.reason = note ||
    (phase === "need_inside" ? "Waiting for a close back inside the opening range" : `Waiting for a 5-min close beyond ${ORL}–${ORH}`);
  return base;
}

// ── strike / exits / day limits ──────────────────────────────────────────────
/**
 * Exactly one listed strike in the money: CE → highest strike strictly below
 * spot, PE → lowest strike strictly above spot. `step` is the instrument's
 * strike grid (instrumentConfig), never a constant here.
 */
function itmStrike(spot, side, step) {
  if (!_num(spot) || !(spot > 0) || !_num(step) || !(step > 0)) return null;
  const eps = 1e-9;
  if (side === "CE") {
    let s = Math.floor(spot / step + eps) * step;
    if (s >= spot - eps) s -= step;
    return _r2(s);
  }
  if (side === "PE") {
    let s = Math.ceil(spot / step - eps) * step;
    if (s <= spot + eps) s += step;
    return _r2(s);
  }
  return null;
}

function targetLevel(entryPrem, cfg) {
  const c = cfg || getConfig();
  return _num(entryPrem) ? _r2(entryPrem + c.targetPts) : null;
}

/**
 * The premium stop for a trade: entry − SL_PTS, raised (never lowered) so the
 * day cannot lose more than DAILY_LOSS_PTS. `dayPts` = points already realised
 * today (negative after a loss).
 */
function stopLevel(entryPrem, dayPts, cfg) {
  const c = cfg || getConfig();
  if (!_num(entryPrem)) return { level: null, kind: null };
  const sl = entryPrem - c.slPts;
  const realised = _num(dayPts) ? dayPts : 0;
  const cap = entryPrem - (c.dailyLossPts + realised);
  if (cap > sl) return { level: _r2(cap), kind: "DAILY_LOSS" };
  return { level: _r2(sl), kind: "SL" };
}

/**
 * May another trade open today? `closedTrades` = today's closed trades, each
 * with `points` (exit premium − entry premium).
 */
function dayRiskGate(closedTrades, cfg) {
  const c = cfg || getConfig();
  const list = Array.isArray(closedTrades) ? closedTrades : [];
  let dayPts = 0, wins = 0, losses = 0;
  for (const t of list) {
    const p = t && _num(t.points) ? t.points : 0;
    dayPts += p;
    if (p > 0) wins++; else if (p < 0) losses++;
  }
  dayPts = _r2(dayPts);
  const out = { allowed: true, reason: "", dayPts, wins, losses, trades: list.length, status: "OK" };
  const block = (reason, status) => { out.allowed = false; out.reason = reason; out.status = status; return out; };
  if (wins > 0) return block(`Winning trade booked (${dayPts >= 0 ? "+" : ""}${dayPts} pts) — done for the day`, "TARGET_DONE");
  if (dayPts <= -c.dailyLossPts) return block(`Daily loss cap hit (${dayPts} pts ≤ −${c.dailyLossPts}) — done for the day`, "LOSS_CAP");
  if (losses >= 2) return block(`Two losing trades (${dayPts} pts) — done for the day`, "TWO_LOSSES");
  if (list.length >= c.maxTrades) return block(`Daily trade limit reached (${list.length}/${c.maxTrades})`, "MAX_TRADES");
  if (losses === 1) out.status = "ONE_LOSS";
  return out;
}

module.exports = {
  NAME,
  DESCRIPTION,
  RESOLUTION_MIN,
  getConfig,
  computeSeries,
  getSignal,
  itmStrike,
  targetLevel,
  stopLevel,
  dayRiskGate,
  // shared time helpers (routes must not re-derive IST arithmetic)
  _istDayOf,
  _istDateStr,
  _utcSecToIstMins,
  _parseHHMM,
  _fmtMins,
};

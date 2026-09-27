/**
 * PREV_ORB_SCALP — previous-day range break, confirmed on the 3-minute chart
 * ═════════════════════════════════════════════════════════════════════════════
 * Single-leg NIFTY option buying (ITM), intraday, Zerodha orders, Fyers data.
 * One trade per day at most.
 *
 * ── THE DAY, IN FIVE RULES (the user's own, confirmed 2026-09-27) ───────────
 *
 *  1. LEVELS — yesterday's HIGH and LOW (the previous trading session's
 *     highest high / lowest low of NIFTY 50 spot). Drawn on the chart.
 *
 *  2. SETUP (15-min "analysis" candle) — the FIRST 15-minute candle of today,
 *     09:15–09:30 (PREV_ORB_SCALP_OR_MINS, default 15), must CLOSE:
 *         below yesterday's LOW   → PE day
 *         above yesterday's HIGH  → CE day
 *     Anything else (closed inside yesterday's range) → no trade today.
 *     Only the 09:15 candle counts — a later 15-min candle never makes a setup.
 *
 *  3. ENTRY (3-min "confirmation" candle, PREV_ORB_SCALP_RESOLUTION = 3) —
 *     from 09:30 on, the FIRST 3-minute candle that CLOSES beyond the 09:15
 *     candle's extreme:
 *         PE day → first 3-min close BELOW the 09:15 candle's LOW
 *         CE day → first 3-min close ABOVE the 09:15 candle's HIGH
 *     Entry = that candle's CLOSE (the user chose close, not the moment of the
 *     break). Only the FIRST such close counts: if it was missed (session
 *     started late) or refused, the setup is spent — a later close beyond the
 *     level is not a second chance. That keeps Paper, Backtest and Replay
 *     agreeing on the one bar that can trade.
 *
 *  4. STOP + TARGET — both read off that 3-min break candle:
 *         stop   = its HIGH (PE) / LOW (CE)                      — a LEVEL
 *         size   = its high − low
 *         target = entry − size (PE) / entry + size (CE)
 *     "Entry" for the target is the break candle's close — the price the user
 *     enters at — so the target is a level fixed at the signal, not re-anchored
 *     to a fill that slipped a tick.
 *
 *  5. AFTER THE TARGET (PREV_ORB_SCALP_TRAIL_AFTER_TARGET, default ON) — the
 *     trade is NOT closed at the target. The stop jumps to the target level
 *     (profit locked), then on every closed 3-min candle it trails to that
 *     candle's HIGH (PE) / LOW (CE). It only ever tightens. With the toggle OFF
 *     the trade simply exits at the target.
 *
 *  Plus: no new entries after 14:30 (PREV_ORB_SCALP_ENTRY_END, judged on the
 *  break candle's CLOSE time), forced square-off 15:15 (route), max 1 trade a
 *  day, and the GLOBAL premium profit lock from utils/tradeGuards.js
 *  (checkProfitLock) in the per-tick exit path, as the user asked.
 *
 * ── TIMEFRAMES ──────────────────────────────────────────────────────────────
 * The engine is fed ONE series: closed 3-minute NIFTY spot bars. The 15-minute
 * analysis candle is AGGREGATED from them (open of the first, max high, min
 * low, close of the last) — exactly the candle a 15-min chart draws, and it
 * means there is no second series that could disagree with the first.
 * Yesterday's high/low come from the same series (previous IST day's bars).
 *
 * ── FILL, ONE MOMENT FOR ALL MODES ──────────────────────────────────────────
 * The signal fires when the break candle closes. Paper/Live fill on the first
 * tick after that close; Backtest fills at the NEXT bar's OPEN. Those are the
 * same market moment.
 *
 * ── DELIBERATELY NOT HERE (do not "helpfully" add these) ────────────────────
 * No VIX, OI, ADX, RSI, volume, ATR, VWAP, EMA/MA, SuperTrend, gap filter,
 * retest, second confirmation candle, minimum/maximum candle size, stop
 * buffer, breakeven jump before target, re-entry, or second trade. The user
 * specified none of them.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Every value a decision reads comes from CLOSED 3-minute OHLC off the history
 * endpoint. The live spot is used only to test already-frozen levels (stop,
 * target) per tick.
 *
 * ── NOT MARKET-VALIDATED ────────────────────────────────────────────────────
 * Zero paper and zero live trades as of 2026-09-27.
 *
 * Contract:
 *   getConfig()                         -> live env read (never cached)
 *   dayLevels(candles, opts)            -> { prevDay, or } for the last bar's day
 *   getSignal(candles, opts)            -> { signal, side, entrySpot, slSpot, targetSpot, ... }
 *   stopHit / targetHit / trailStop     -> the ONLY exit tests (plus route EOD + profit lock)
 */

const NAME = "PREV_ORB_SCALP";
const DESCRIPTION =
  "Prev ORB Scalp — the 09:15 15-min candle closes beyond yesterday's high/low, the first 3-min close beyond " +
  "that candle is entered, stop at the 3-min candle's other end, target = its size, then trailed";

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

/** "HH:MM" → minutes-of-day, `def` on anything malformed (never a silent 00:00). */
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

function _intEnv(key, def, min, max) {
  const v = parseInt(process.env[key], 10);
  if (!Number.isFinite(v)) return def;
  if (min != null && v < min) return def;
  if (max != null && v > max) return def;
  return v;
}

function _boolEnv(key, def) {
  const raw = process.env[key];
  if (raw == null || raw === "") return def;
  const s = String(raw).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return def;
}

function _okBar(c) {
  return !!c && _num(c.time) && _num(c.open) && _num(c.high) && _num(c.low) && _num(c.close);
}

// The previous session counts as COMPLETE only if its last bar closes at or
// after this time. A half-fetched yesterday would hand the engine a wrong
// high/low, and refusing is better than trading off a partial range.
const PREV_DAY_MIN_CLOSE = 15 * 60;
// Bars at or after the NSE close are not part of the session's range.
const MARKET_CLOSE_MIN = 15 * 60 + 30;

/**
 * Live config read. Settings saves mutate process.env in place, so this must
 * never be cached — every caller re-reads on each evaluation.
 */
function getConfig() {
  const sessionStartMin = _parseHHMM(process.env.PREV_ORB_SCALP_SESSION_START, 9 * 60 + 15);
  const orMins = _intEnv("PREV_ORB_SCALP_OR_MINS", 15, 3, 120);
  return {
    // The ENTRY chart. The 15-min analysis candle is aggregated from it.
    resolutionMins:   _intEnv("PREV_ORB_SCALP_RESOLUTION", 3, 1, 15),
    orMins,
    sessionStartMin,
    // Entries can only start once the analysis candle has closed.
    entryStartMin:    sessionStartMin + orMins,
    entryEndMin:      _parseHHMM(process.env.PREV_ORB_SCALP_ENTRY_END, 14 * 60 + 30),
    forcedExitMin:    _parseHHMM(process.env.PREV_ORB_SCALP_FORCED_EXIT, 15 * 60 + 15),
    trailAfterTarget: _boolEnv("PREV_ORB_SCALP_TRAIL_AFTER_TARGET", true),
  };
}

// ── levels ───────────────────────────────────────────────────────────────────
/**
 * Yesterday's range and today's analysis (opening-range) candle, both taken
 * from the same bar series, for the IST day of the LAST bar — or for
 * `opts.day` when given. The paper UI passes the real calendar day so that,
 * before today's first bar exists, it shows yesterday as "yesterday" rather
 * than treating yesterday as today.
 *
 * @param {Array}  candles ascending closed bars at cfg.resolutionMins
 * @param {object} opts    { cfg, day }
 * @returns {{ day, prevDay: {day,date,high,low,bars,lastCloseMin,complete}|null,
 *             or: {time,open,high,low,close,bars,complete}|null }}
 */
function dayLevels(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const out = { day: null, prevDay: null, or: null };
  if (!Array.isArray(candles) || !candles.length) return out;
  const last = candles[candles.length - 1];
  let today;
  if (_num(o.day)) today = o.day;
  else if (_okBar(last)) today = _istDayOf(last.time);
  else return out;
  out.day = today;

  // ── previous session: the latest IST day before today that has bars ────────
  let prevDayIdx = null;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (!_okBar(c)) continue;
    const d = _istDayOf(c.time);
    if (d < today) { prevDayIdx = d; break; }
  }
  if (prevDayIdx != null) {
    let hi = -Infinity, lo = Infinity, n = 0, lastCloseMin = null, bad = false;
    for (const c of candles) {
      if (!c || !_num(c.time) || _istDayOf(c.time) !== prevDayIdx) continue;
      const m = _utcSecToIstMins(c.time);
      if (m < cfg.sessionStartMin || m >= MARKET_CLOSE_MIN) continue;
      if (!_okBar(c)) { bad = true; continue; }
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
      n++;
      const closeMin = m + cfg.resolutionMins;
      if (lastCloseMin == null || closeMin > lastCloseMin) lastCloseMin = closeMin;
    }
    if (n > 0) {
      out.prevDay = {
        day: prevDayIdx,
        date: _istDateStr(prevDayIdx * 86400 - 19800 + 43200),
        high: _r2(hi), low: _r2(lo), bars: n, lastCloseMin,
        complete: !bad && lastCloseMin >= PREV_DAY_MIN_CLOSE,
      };
    }
  }

  // ── today's analysis candle: the bars inside [start, start + orMins) ───────
  const orEnd = cfg.sessionStartMin + cfg.orMins;
  const orBars = [];
  for (const c of candles) {
    if (!c || !_num(c.time) || _istDayOf(c.time) !== today) continue;
    const m = _utcSecToIstMins(c.time);
    if (m >= cfg.sessionStartMin && m < orEnd) orBars.push(c);
  }
  if (orBars.length) {
    orBars.sort((a, b) => a.time - b.time);
    const allOk = orBars.every(_okBar);
    const first = orBars[0], lastOr = orBars[orBars.length - 1];
    const expected = Math.ceil(cfg.orMins / cfg.resolutionMins);
    // Complete = starts at the bell, every expected bar is present, and the
    // last one has closed by the end of the window.
    const complete = allOk &&
      _utcSecToIstMins(first.time) === cfg.sessionStartMin &&
      orBars.length === expected &&
      _utcSecToIstMins(lastOr.time) + cfg.resolutionMins >= orEnd;
    out.or = {
      time: first.time,
      open:  allOk ? _r2(first.open) : null,
      high:  allOk ? _r2(Math.max(...orBars.map(b => b.high))) : null,
      low:   allOk ? _r2(Math.min(...orBars.map(b => b.low))) : null,
      close: allOk ? _r2(lastOr.close) : null,
      bars: orBars.length, expected, complete,
    };
  }
  return out;
}

/**
 * Which side today is, from the analysis candle vs yesterday's range. Pure —
 * the chart and the status card call it too, so they cannot disagree with the
 * signal.
 * @returns {"PE"|"CE"|null}
 */
function setupSide(levels) {
  if (!levels || !levels.prevDay || !levels.or || !levels.or.complete) return null;
  const c = levels.or.close;
  if (!_num(c)) return null;
  if (c < levels.prevDay.low) return "PE";
  if (c > levels.prevDay.high) return "CE";
  return null;
}

// ── the entry signal ─────────────────────────────────────────────────────────
function _baseSignal(cfg) {
  return {
    signal: "NONE", side: null, reason: "", skipReason: "", warmup: false,
    setupSide: null, spent: false, dayDead: false,
    entrySpot: null, slSpot: null, slPts: null, targetSpot: null, candleSize: null,
    prevHigh: null, prevLow: null, prevDate: null,
    orOpen: null, orHigh: null, orLow: null, orClose: null,
    breakLevel: null, signalBarTime: null, firstBreakTime: null,
    rawOpen: null, rawHigh: null, rawLow: null, rawClose: null,
    signalStrength: null,
    cfg,
  };
}

/**
 * getSignal(candles, opts)
 *
 * @param {Array}  candles ascending CLOSED bars at cfg.resolutionMins (3-min),
 *                 covering at least the previous session and today so far. The
 *                 LAST element is the just-closed candidate break candle.
 * @param {object} opts { cfg, silent, alreadyTraded }
 */
function getSignal(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const base = _baseSignal(cfg);

  if (!Array.isArray(candles) || !candles.length) {
    base.warmup = true;
    base.skipReason = base.reason = "No candles yet";
    return base;
  }
  const sig = candles[candles.length - 1];
  if (!_okBar(sig)) {
    base.skipReason = base.reason = "Latest candle has no usable OHLC — refusing to decide";
    return base;
  }
  base.signalBarTime = sig.time;
  base.rawOpen = _r2(sig.open); base.rawHigh = _r2(sig.high);
  base.rawLow = _r2(sig.low);   base.rawClose = _r2(sig.close);

  const startMin = _utcSecToIstMins(sig.time);
  const closeMin = startMin + cfg.resolutionMins;
  const lv = dayLevels(candles, { cfg });

  // ── Levels must exist before anything else is judged. ─────────────────────
  if (!lv.prevDay) {
    base.warmup = true;
    base.skipReason = base.reason = "No previous session in the history — yesterday's high/low unknown";
    return base;
  }
  base.prevHigh = lv.prevDay.high;
  base.prevLow = lv.prevDay.low;
  base.prevDate = lv.prevDay.date;
  if (!lv.prevDay.complete) {
    base.warmup = true;
    base.skipReason = base.reason =
      `Previous session (${lv.prevDay.date}) is incomplete — last bar closes ${_fmtMins(lv.prevDay.lastCloseMin)}, ` +
      `refusing to trade off a partial high/low`;
    return base;
  }

  if (startMin < cfg.entryStartMin) {
    base.skipReason = base.reason =
      `The ${_fmtMins(cfg.sessionStartMin)} ${cfg.orMins}-min candle is still forming — setup decided at ${_fmtMins(cfg.entryStartMin)}`;
    return base;
  }
  if (!lv.or || !lv.or.complete) {
    base.dayDead = true;
    base.skipReason = base.reason =
      `Today's ${_fmtMins(cfg.sessionStartMin)} ${cfg.orMins}-min candle is incomplete ` +
      `(${lv.or ? lv.or.bars : 0}/${lv.or ? lv.or.expected : Math.ceil(cfg.orMins / cfg.resolutionMins)} bars) — no trade today`;
    return base;
  }
  base.orOpen = lv.or.open; base.orHigh = lv.or.high;
  base.orLow = lv.or.low;   base.orClose = lv.or.close;

  // ── 2. SETUP ─────────────────────────────────────────────────────────────
  const side = setupSide(lv);
  base.setupSide = side;
  if (!side) {
    base.dayDead = true;
    base.skipReason = base.reason =
      `${_fmtMins(cfg.sessionStartMin)} candle closed ${lv.or.close}, inside yesterday's range ` +
      `${lv.prevDay.low}–${lv.prevDay.high} — no trade today`;
    return base;
  }
  const isPE = side === "PE";
  const level = isPE ? lv.or.low : lv.or.high;
  base.breakLevel = level;

  // ── 3. ENTRY — the FIRST close beyond the analysis candle's extreme. ──────
  const today = lv.day;
  let first = null;
  for (const c of candles) {
    if (!_okBar(c) || _istDayOf(c.time) !== today) continue;
    if (_utcSecToIstMins(c.time) < cfg.entryStartMin) continue;
    if (isPE ? c.close < level : c.close > level) { first = c; break; }
  }
  const setupTxt =
    `${_fmtMins(cfg.sessionStartMin)} candle closed ${lv.or.close} ${isPE ? "below yesterday's LOW" : "above yesterday's HIGH"} ` +
    `${isPE ? lv.prevDay.low : lv.prevDay.high} → ${side} day`;

  if (!first) {
    base.skipReason = base.reason =
      `${setupTxt} · waiting for a ${cfg.resolutionMins}-min close ${isPE ? "below" : "above"} ${level}`;
    return base;
  }
  base.firstBreakTime = first.time;
  if (first.time !== sig.time) {
    base.spent = true;
    base.skipReason = base.reason =
      `${setupTxt} · the first ${cfg.resolutionMins}-min close beyond ${level} was the ${_fmtMins(_utcSecToIstMins(first.time))} ` +
      `candle — setup already used, no second chance today`;
    return base;
  }

  if (closeMin > cfg.entryEndMin) {
    base.spent = true;
    base.skipReason = base.reason =
      `${setupTxt} · break candle closed ${_fmtMins(closeMin)}, past the ${_fmtMins(cfg.entryEndMin)} entry cut-off`;
    return base;
  }
  if (o.alreadyTraded) {
    base.skipReason = base.reason = "Daily trade budget spent — no new entries";
    return base;
  }

  // ── 4. LEVELS off the break candle ────────────────────────────────────────
  const entry = _r2(sig.close);
  const slSpot = _r2(isPE ? sig.high : sig.low);
  const size = _r2(sig.high - sig.low);
  const target = _r2(isPE ? entry - size : entry + size);
  base.candleSize = size;

  if (!(size > 0)) {
    base.spent = true;
    base.skipReason = base.reason = `Break candle has zero range (${size}pt) — no stop or target, refusing`;
    return base;
  }
  const slPts = _r2(Math.abs(entry - slSpot));
  if (!(slPts > 0)) {
    base.spent = true;
    base.skipReason = base.reason =
      `Break candle closed at its own ${isPE ? "high" : "low"} (${entry}) — zero-risk stop, refusing`;
    return base;
  }

  base.signal = isPE ? "BUY_PE" : "BUY_CE";
  base.side = side;
  base.signalStrength = "STRONG";
  base.entrySpot = entry;
  base.slSpot = slSpot;
  base.slPts = slPts;
  base.targetSpot = target;
  base.reason =
    `PREV ORB ${side}: ${setupTxt} · ${_fmtMins(startMin)} ${cfg.resolutionMins}-min candle closed ${entry} ` +
    `${isPE ? "below" : "above"} ${level} | SL ${slSpot} (candle ${isPE ? "high" : "low"}, ${slPts}pt) | ` +
    `target ${target} (candle size ${size}pt)${cfg.trailAfterTarget ? ", then trail" : ""}`;

  if (!o.silent) {
    const ist = new Date(sig.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    console.log(`[PREV_ORB_SCALP ${ist}] ENTER ${side} @ ${entry} | SL ${slSpot} | target ${target}`);
  }
  return base;
}

// ── Exit rules (ONE place, so paper / backtest / live / replay cannot drift) ──
/** Stop taken out? `price >= null` is `price >= 0`, so both are checked finite. */
function stopHit(side, price, stop) {
  if (!_num(price) || !_num(stop)) return false;
  return side === "CE" ? price <= stop : price >= stop;
}

/** Target reached? Same finite-guard contract as stopHit. */
function targetHit(side, price, target) {
  if (!_num(price) || !_num(target)) return false;
  return side === "CE" ? price >= target : price <= target;
}

/**
 * What happens when the target is reached.
 *   trail ON  → { action: "LOCK", stop: target } — stop jumps to the target.
 *   trail OFF → { action: "EXIT" }
 * The returned stop is only ever TIGHTER than the current one (the target is
 * beyond the entry, the initial stop behind it), so this can never loosen it.
 */
function onTarget(pos, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  if (!pos || !_num(pos.targetSpot)) return null;
  if (!cfg.trailAfterTarget) return { action: "EXIT" };
  const dir = pos.side === "CE" ? 1 : -1;
  if (_num(pos.slSpot) && (pos.targetSpot - pos.slSpot) * dir <= 0) return { action: "LOCK", stop: pos.slSpot };
  return { action: "LOCK", stop: _r2(pos.targetSpot) };
}

/**
 * Candle-close trail, active only after the target was reached: the stop
 * follows each CLOSED bar's LOW (CE) / HIGH (PE). Ratchet only.
 *
 * @param {object} pos { side, slSpot, targetReached }
 * @param {object} bar a closed candle
 * @returns {{ stop:number } | null}
 */
function trailStop(pos, bar) {
  if (!pos || !pos.targetReached) return null;
  if (pos.side !== "CE" && pos.side !== "PE") return null;
  if (!_okBar(bar) || !_num(pos.slSpot)) return null;
  const dir = pos.side === "CE" ? 1 : -1;
  const cand = pos.side === "CE" ? bar.low : bar.high;
  if ((cand - pos.slSpot) * dir <= 0) return null;
  return { stop: _r2(cand) };
}

module.exports = {
  NAME,
  DESCRIPTION,
  getConfig,
  dayLevels,
  setupSide,
  getSignal,
  stopHit,
  targetHit,
  onTarget,
  trailStop,
  // shared time helpers (routes must not re-derive IST arithmetic)
  _istDayOf,
  _istDateStr,
  _utcSecToIstMins,
  _parseHHMM,
  _fmtMins,
};

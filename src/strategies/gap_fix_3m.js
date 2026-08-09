/**
 * 3M_GAP_FIX_SCALP — fade a 3-minute gap back into itself, unless it breaks the day
 * ═════════════════════════════════════════════════════════════════════════════
 * Single-leg NIFTY option buying, intraday. The whole strategy is three facts
 * about three consecutive 3-minute candles plus the day's high and low:
 *
 *   candle A ─┐
 *             ├─ a GAP between them (a price void nothing traded through)
 *   candle B ─┘
 *   candle C ─── the ONE candle that decides: break, or return?
 *
 *   • break  — C trades beyond the day's extreme on good volume → LEAVE IT.
 *              The move is real; fading a real breakout is how accounts die.
 *   • return — C turns back instead → ENTER the fade, and hold until the GAP
 *              IS FILLED. The day's extreme is the stop.
 *
 * ── WHY THE FUTURES CHART, NOT THE INDEX (measured, not assumed) ────────────
 * This engine reads NIFTY **FUTURES** candles. That is not a preference, it is
 * the only way the strategy exists at all. Measured on this repo's own cached
 * NIFTY 50 INDEX candles, 39 sessions: only 12 intraday gaps occurred, the
 * LARGEST was 2.1 points and the median was 0.45 points. The index is a
 * continuously recomputed weighted average of 50 stocks — it has no order book,
 * so it does not leave voids. NIFTY futures is a single traded contract with a
 * real book, and that book is what gaps when it thins out.
 *
 * The NIFTY INDEX is still read, for exactly two things: choosing the option
 * strike (strikes are struck on the index, not on the future) and drawing the
 * second chart on the paper page. No decision reads it.
 *
 * ── THE PIPELINE ────────────────────────────────────────────────────────────
 *  1. DAY HIGH / DAY LOW, running, over today's in-session futures bars. At the
 *     moment a gap is found they are FROZEN into the setup — the stop must not
 *     drift away from the trade while the trade is open, and a frozen level is
 *     also the only kind Replay can reproduce.
 *  2. GAP between two consecutive closed bars A and B:
 *       gap UP   — B.low  > A.high  → void = [A.high, B.low]
 *       gap DOWN — B.high < A.low   → void = [B.high, A.low]
 *     Gaps smaller than GAP3M_MIN_GAP_PTS are ignored — see the friction note.
 *  3. CONFIRM on candle C (the next bar; GAP3M_CONFIRM_BARS allows more):
 *       crossed  — gap UP: C.high > dayHigh · gap DOWN: C.low < dayLow
 *       strong   — C's futures volume >= GAP3M_VOL_MULT × the average of the
 *                  previous GAP3M_VOL_AVG_BARS bars
 *       returned — GAP3M_RETURN_MODE:
 *                    reverse_close (default) C closes against the gap direction
 *                                            AND gives back ground vs B's close
 *                    into_gap                C closes back inside the void
 *     Decision table:
 *       crossed AND strong          → SKIP. Real breakout.
 *       crossed AND volume UNKNOWN  → SKIP. Fail-safe: an unprovable breakout is
 *                                     treated as real. Never fade blind.
 *       returned                    → ENTER the fade.
 *       otherwise                   → wait (and the setup expires with the bar).
 *  4. DIRECTION. Gap UP is faded DOWN → BUY_PE. Gap DOWN is faded UP → BUY_CE.
 *  5. TARGET = the far edge of the void — the gap-fill level. gap UP fills at
 *     A.high, gap DOWN fills at A.low. This is a LEVEL, not a distance, and it
 *     never moves.
 *  6. STOP = the frozen day extreme the trade is fading (± GAP3M_SL_BUFFER_PTS).
 *     Also a level, also frozen.
 *
 * ── WHY MIN_GAP_PTS DEFAULTS TO 20 ──────────────────────────────────────────
 * The gap size IS the target. Measured with this repo's own charges.js on 1 lot:
 * ~90 INR of statutory charges plus ~1.5 premium points of slippage per side
 * (~225 INR) = ~315 INR gone before the trade is right about anything. At an ITM
 * delta of ~0.6 that is ~17 index points of move needed merely to break even. A
 * 5-point gap therefore cannot pay for itself even when it fills perfectly.
 * 20 is the first round number clear of that floor. Lowering it below ~17 makes
 * the strategy negative-expectancy by arithmetic, whatever the win rate says.
 *
 * ── GUARDS THAT DEFAULT TO OFF (deliberate) ─────────────────────────────────
 * GAP3M_MIN_RR, GAP3M_MAX_SL_PTS and GAP3M_MAX_EXTREME_DIST_PTS all default to
 * 0 = OFF, so out of the box the engine does exactly and only what the rules
 * say. They exist because the rules as stated allow a 20-point target against a
 * 200-point stop when the gap forms far from the day's extreme, and that trade
 * loses money by construction. They are levers in Settings, not opinions baked
 * into the default.
 *
 * ── DELIBERATELY NOT HERE (do not "helpfully" add these) ────────────────────
 * No VIX gate, no OI filter, no ADX, no RSI, no EMA, no VWAP, no ATR, no
 * SuperTrend, no multi-timeframe bias, no extra confirmation candle, no trailing
 * stop, no breakeven jump, no partial booking, no time stop, no premium stop, no
 * re-entry after the gap fills, no expiry-day rule. The stop never moves. The
 * target never moves. Volume is read for ONE purpose — deciding whether a break
 * of the day's extreme was real — and for nothing else.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Every value the decision reads comes from CLOSED 3-minute futures candle OHLCV
 * as returned by the Fyers history API — never a live tick, never a live spot.
 * Paper, Backtest, Live and Replay all read the same endpoint for the same
 * session and therefore compute identical numbers.
 *
 * ── NOT MARKET-VALIDATED ────────────────────────────────────────────────────
 * Zero trades, paper or live. The gap-frequency measurement above was made on
 * INDEX candles (the only ones cached offline); the futures gap distribution
 * that actually drives this engine has NOT been measured, because the Fyers
 * token was expired at build time. GAP3M_MIN_GAP_PTS is therefore a friction
 * floor, not a fitted value, and the trade frequency is genuinely unknown.
 * Collect clean paper days and diff them against /replay before touching any
 * live gate.
 *
 * Contract:
 *   getConfig()                       -> live env read (never cached)
 *   computeDayExtremes(candles, cfg)  -> running day high/low over today's bars
 *   findGap(prev, cur, cfg)           -> the void between two bars, or null
 *   averageVolume(candles, endIdx, n) -> mean volume of the n bars before endIdx
 *   getSignal(candles, opts)          -> { signal, side, entrySpot, slSpot, slPts,
 *                                          targetSpot, gap, dayHigh, dayLow, ... }
 *   targetHit / stopHit               -> the ONLY two exit tests (plus route EOD)
 */

const NAME = "3M_GAP_FIX_SCALP";
const DESCRIPTION =
  "3M Gap Fix Scalp — a gap between two 3-min NIFTY FUTURES candles is faded back to its own fill level " +
  "when the next candle returns instead of breaking the day's high/low on volume; the day extreme is the stop";

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
 * Deliberately NOT a silent collapse to midnight: a typo in GAP3M_ENTRY_END
 * would otherwise close the entry window at 00:00 and the strategy would stand
 * mute all day without a word about why.
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

/** A candle usable for a decision: all four prices finite. Volume may be absent. */
function _okBar(c) {
  return !!c && _num(c.open) && _num(c.high) && _num(c.low) && _num(c.close);
}

const RETURN_MODES = ["reverse_close", "into_gap"];

/**
 * Live config read. Settings saves mutate process.env in place, so this must
 * never be cached — every caller re-reads on each evaluation.
 */
function getConfig() {
  const rawMode = String(process.env.GAP3M_RETURN_MODE || "reverse_close").trim().toLowerCase();
  return {
    // Timeframe — STRATEGY-LEVEL, deliberately not the repo-wide 5-min default.
    // 3 minutes is the whole premise: a gap is a void, and a void that survives
    // aggregation into a 5-minute bar is a much rarer animal.
    resolutionMins:  _intEnv("GAP3M_RESOLUTION", 3, 1, 60),
    sessionStartMin: _parseHHMM(process.env.GAP3M_SESSION_START, 9 * 60 + 15),
    entryStartMin:   _parseHHMM(process.env.GAP3M_ENTRY_START,   9 * 60 + 30),
    entryEndMin:     _parseHHMM(process.env.GAP3M_ENTRY_END,    15 * 60),

    // The gap
    minGapPts:       _numEnv("GAP3M_MIN_GAP_PTS", 20, 0),
    confirmBars:     _intEnv("GAP3M_CONFIRM_BARS", 1, 1, 10),
    returnMode:      RETURN_MODES.includes(rawMode) ? rawMode : "reverse_close",

    // The break test
    volAvgBars:      _intEnv("GAP3M_VOL_AVG_BARS", 20, 1, 200),
    volMult:         _numEnv("GAP3M_VOL_MULT", 1.5, 0),

    // Risk. All three default to 0 = OFF — see the header.
    slBufferPts:     _numEnv("GAP3M_SL_BUFFER_PTS", 0, 0),
    maxSlPts:        _numEnv("GAP3M_MAX_SL_PTS", 0, 0),
    minRR:           _numEnv("GAP3M_MIN_RR", 0, 0),
    maxExtremeDist:  _numEnv("GAP3M_MAX_EXTREME_DIST_PTS", 0, 0),
  };
}

// ── day extremes ─────────────────────────────────────────────────────────────
/**
 * Running day high / low over today's IN-SESSION bars, up to and including
 * `endIdx` (default: the whole array). "Today" is the IST day of the LAST bar
 * considered, so a multi-day warm-up series cannot leak yesterday's extreme in.
 *
 * @param {Array}  candles ascending futures bars, may span several days
 * @param {object} opts    { cfg, endIdx }
 * @returns {{ high, low, highTime, lowTime, bars, dayKey }} — nulls when the
 *          session has no usable bar yet (never 0, which would read as a price).
 */
function computeDayExtremes(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const out = { high: null, low: null, highTime: null, lowTime: null, bars: 0, dayKey: null };
  if (!Array.isArray(candles) || candles.length === 0) return out;

  const end = Number.isInteger(o.endIdx) ? Math.min(o.endIdx, candles.length - 1) : candles.length - 1;
  if (end < 0) return out;
  const anchor = candles[end];
  if (!_okBar(anchor)) return out;

  const day = _istDayOf(anchor.time);
  out.dayKey = day;
  for (let i = 0; i <= end; i++) {
    const c = candles[i];
    if (!_okBar(c)) continue;
    if (_istDayOf(c.time) !== day) continue;
    if (_utcSecToIstMins(c.time) < cfg.sessionStartMin) continue;
    out.bars++;
    if (out.high == null || c.high > out.high) { out.high = _r2(c.high); out.highTime = c.time; }
    if (out.low  == null || c.low  < out.low)  { out.low  = _r2(c.low);  out.lowTime  = c.time; }
  }
  return out;
}

// ── the gap ──────────────────────────────────────────────────────────────────
/**
 * The void between two CONSECUTIVE closed bars, or null when there is none.
 *
 * A gap is a range of prices nothing traded through, so it needs strict
 * inequality: B.low === A.high is a touch, not a void, and would hand the trade
 * a zero-point target.
 *
 * @returns {{ dir, top, bottom, size, fillLevel, aTime, bTime } | null}
 *          fillLevel is the FAR edge — where price must reach for the gap to be
 *          considered filled, i.e. the target of the fade.
 */
function findGap(prev, cur, cfg) {
  cfg = cfg || getConfig();
  if (!_okBar(prev) || !_okBar(cur)) return null;
  if (_istDayOf(prev.time) !== _istDayOf(cur.time)) return null;   // overnight is not this strategy

  if (cur.low > prev.high) {
    const size = _r2(cur.low - prev.high);
    if (size < cfg.minGapPts) return null;
    return { dir: "up", bottom: _r2(prev.high), top: _r2(cur.low), size, fillLevel: _r2(prev.high), aTime: prev.time, bTime: cur.time };
  }
  if (cur.high < prev.low) {
    const size = _r2(prev.low - cur.high);
    if (size < cfg.minGapPts) return null;
    return { dir: "down", bottom: _r2(cur.high), top: _r2(prev.low), size, fillLevel: _r2(prev.low), aTime: prev.time, bTime: cur.time };
  }
  return null;
}

/**
 * Mean traded volume of the `n` bars ENDING JUST BEFORE `endIdx`, same IST day
 * only. Returns null when fewer than one usable bar is available, or when the
 * bars carry no volume at all — null means UNKNOWN, and the caller must treat
 * unknown as "cannot disprove a breakout", never as zero.
 */
function averageVolume(candles, endIdx, n) {
  if (!Array.isArray(candles) || !Number.isInteger(endIdx) || endIdx <= 0) return null;
  const day = candles[endIdx] ? _istDayOf(candles[endIdx].time) : null;
  let sum = 0, count = 0;
  for (let i = endIdx - 1; i >= 0 && count < n; i--) {
    const c = candles[i];
    if (!c || _istDayOf(c.time) !== day) break;
    if (!_num(c.volume) || c.volume <= 0) continue;
    sum += c.volume;
    count++;
  }
  if (count === 0) return null;
  return _r2(sum / count);
}

// ── the entry signal ─────────────────────────────────────────────────────────
function _baseSignal(cfg) {
  return {
    signal: "NONE", side: null, reason: "", skipReason: "", warmup: false,
    entrySpot: null, slSpot: null, slPts: null, targetSpot: null, targetPts: null,
    rr: null, signalStrength: null,
    gap: null, gapSize: null, gapDir: null, gapTop: null, gapBottom: null, gapFillLevel: null,
    dayHigh: null, dayLow: null,
    crossed: null, returned: null, volume: null, volumeAvg: null, volumeKnown: false,
    strongVolume: null,
    confirmBarTime: null,
    cfg,
  };
}

/**
 * getSignal(candles, opts)
 *
 * @param {Array} candles ascending 3-min IST **NIFTY FUTURES** bars with volume.
 *        The LAST element is the just-CLOSED confirm candle C — never a forming
 *        bar (the caller decides that).
 * @param {object} opts { cfg, silent, alreadyTraded }
 */
function getSignal(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const base = _baseSignal(cfg);

  // A, B and C — three bars is the irreducible minimum this strategy can read.
  const minBars = cfg.confirmBars + 2;
  if (!Array.isArray(candles) || candles.length < minBars) {
    base.warmup = true;
    base.skipReason = base.reason =
      `Warming up (${candles ? candles.length : 0}/${minBars} futures candles — need A, B and the confirm bar)`;
    return base;
  }

  const n = candles.length;
  const confirm = candles[n - 1];
  if (!_okBar(confirm)) {
    base.skipReason = base.reason = "Confirm candle has no usable OHLC — refusing to decide";
    return base;
  }
  base.confirmBarTime = confirm.time;

  // ── Window. The bar's CLOSE time is what gates it, not its start: the 14:57
  //    bar CLOSES at 15:00, and a start-time check would silently drop the last
  //    legal bar that the backtest still accepts. ─────────────────────────────
  const closeMins = _utcSecToIstMins(confirm.time) + cfg.resolutionMins;
  if (closeMins <= cfg.entryStartMin) {
    base.skipReason = base.reason =
      `Bar closes ${_fmtMins(closeMins)} — before the ${_fmtMins(cfg.entryStartMin)} entry window opens (the day needs a high and a low first)`;
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

  // ── The gap: the most recent void whose B bar sits within confirmBars of C. ─
  let gap = null, bIdx = -1;
  for (let k = 1; k <= cfg.confirmBars; k++) {
    const bi = n - 1 - k;
    if (bi < 1) break;
    const g = findGap(candles[bi - 1], candles[bi], cfg);
    if (g) { gap = g; bIdx = bi; break; }
  }
  if (!gap) {
    base.skipReason = base.reason =
      `No gap of ${cfg.minGapPts}pt or more in the ${cfg.confirmBars} bar(s) before ${_fmtMins(closeMins)}`;
    return base;
  }
  // The gap must belong to the SAME session as the confirm bar — a gap found on
  // the previous day's last bars must never arm a trade this morning.
  if (_istDayOf(candles[bIdx].time) !== _istDayOf(confirm.time)) {
    base.skipReason = base.reason = "Gap belongs to a previous session — ignoring";
    return base;
  }

  base.gap = gap;
  base.gapDir = gap.dir;
  base.gapSize = gap.size;
  base.gapTop = gap.top;
  base.gapBottom = gap.bottom;
  base.gapFillLevel = gap.fillLevel;

  // ── Day extremes, FROZEN as of the gap bar B. ─────────────────────────────
  const ext = computeDayExtremes(candles, { cfg, endIdx: bIdx });
  base.dayHigh = ext.high;
  base.dayLow  = ext.low;
  const isUp = gap.dir === "up";
  const extreme = isUp ? ext.high : ext.low;
  if (!_num(extreme)) {
    base.skipReason = base.reason =
      `Day ${isUp ? "high" : "low"} not established yet (${ext.bars} in-session bar(s)) — no stop level, refusing to trade`;
    return base;
  }

  // ── Did C break the day's extreme, and was the break backed by volume? ────
  const crossed = isUp ? confirm.high > extreme : confirm.low < extreme;
  base.crossed = crossed;

  const vol = _num(confirm.volume) && confirm.volume > 0 ? confirm.volume : null;
  const avg = averageVolume(candles, n - 1, cfg.volAvgBars);
  base.volume = vol;
  base.volumeAvg = avg;
  base.volumeKnown = vol != null && avg != null && avg > 0;
  base.strongVolume = base.volumeKnown ? vol >= cfg.volMult * avg : null;

  if (crossed) {
    if (!base.volumeKnown) {
      // Fail-SAFE, not fail-open. Without volume we cannot show the break was
      // weak, and fading a genuine breakout is the expensive mistake here.
      base.skipReason = base.reason =
        `${isUp ? "Gap up" : "Gap down"} ${gap.size}pt, but the confirm bar broke the day ${isUp ? "high" : "low"} ${extreme} ` +
        `and its futures volume is unknown — treating the break as real and standing aside`;
      return base;
    }
    if (base.strongVolume) {
      base.skipReason = base.reason =
        `${isUp ? "Gap up" : "Gap down"} ${gap.size}pt, but the confirm bar broke the day ${isUp ? "high" : "low"} ${extreme} ` +
        `on ${vol} vs ${cfg.volMult}× avg ${avg} — real breakout, LEAVE IT`;
      return base;
    }
  }

  // ── Is C returning? ───────────────────────────────────────────────────────
  const bBar = candles[bIdx];
  let returned;
  if (cfg.returnMode === "into_gap") {
    returned = isUp ? confirm.close < gap.top : confirm.close > gap.bottom;
  } else {
    // reverse_close — the candle turned against the gap AND gave back ground
    // relative to the gap bar's close. Both halves matter: a red candle that
    // still closes above B's close has not returned anywhere.
    returned = isUp
      ? confirm.close < confirm.open && confirm.close < bBar.close
      : confirm.close > confirm.open && confirm.close > bBar.close;
  }
  base.returned = returned;

  if (!returned) {
    base.skipReason = base.reason =
      `${isUp ? "Gap up" : "Gap down"} ${gap.size}pt found (void ${gap.bottom}–${gap.top}), but the confirm bar is not returning ` +
      `(${cfg.returnMode}: open ${_r2(confirm.open)} → close ${_r2(confirm.close)}, gap bar closed ${_r2(bBar.close)})`;
    return base;
  }

  // ── Levels. Both are LEVELS, both frozen; neither ever moves again. ───────
  const entry  = _r2(confirm.close);
  const target = gap.fillLevel;
  const slSpot = _r2(isUp ? extreme + cfg.slBufferPts : extreme - cfg.slBufferPts);

  // Geometry sanity. `spot >= null` is `spot >= 0`, so every level is checked
  // finite first, and then checked to be on the side the trade needs it on.
  if (!_num(target) || !_num(slSpot)) {
    base.skipReason = base.reason = "Target or stop level not computable — refusing to enter without both";
    return base;
  }
  if (isUp ? entry <= target : entry >= target) {
    base.skipReason = base.reason =
      `Gap already filled by the confirm bar (close ${entry} is ${isUp ? "at or below" : "at or above"} the fill level ${target}) — nothing left to trade`;
    return base;
  }
  if (isUp ? entry >= slSpot : entry <= slSpot) {
    base.skipReason = base.reason =
      `Confirm bar closed ${entry}, already ${isUp ? "at or above" : "at or below"} the stop ${slSpot} — the trade would be stopped on its first tick`;
    return base;
  }

  const slPts     = _r2(Math.abs(slSpot - entry));
  const targetPts = _r2(Math.abs(entry - target));
  const rr        = slPts > 0 ? _r2(targetPts / slPts) : null;
  base.slPts = slPts;
  base.targetPts = targetPts;
  base.rr = rr;

  if (!(slPts > 0)) {
    base.skipReason = base.reason = `Stop distance resolved to ${slPts}pt — refusing a zero-risk trade`;
    return base;
  }

  // ── Optional guards (all default OFF — see the header). ──────────────────
  if (cfg.maxSlPts > 0 && slPts > cfg.maxSlPts) {
    base.skipReason = base.reason =
      `Setup valid but the day ${isUp ? "high" : "low"} is ${slPts}pt away > ${cfg.maxSlPts}pt cap — SKIPPED (the stop is never moved closer than the rule says)`;
    return base;
  }
  if (cfg.minRR > 0 && (rr == null || rr < cfg.minRR)) {
    base.skipReason = base.reason =
      `Setup valid but reward:risk is ${rr} (${targetPts}pt target vs ${slPts}pt stop) < ${cfg.minRR} — SKIPPED`;
    return base;
  }
  if (cfg.maxExtremeDist > 0) {
    const dist = _r2(isUp ? Math.abs(extreme - gap.top) : Math.abs(gap.bottom - extreme));
    if (dist > cfg.maxExtremeDist) {
      base.skipReason = base.reason =
        `Gap sits ${dist}pt from the day ${isUp ? "high" : "low"} > ${cfg.maxExtremeDist}pt — too far from the extreme to fade against it, SKIPPED`;
      return base;
    }
  }

  base.signal = isUp ? "BUY_PE" : "BUY_CE";
  base.side   = isUp ? "PE" : "CE";
  base.signalStrength = "STRONG";
  base.entrySpot  = entry;
  base.slSpot     = slSpot;
  base.targetSpot = target;
  base.reason =
    `3M GAP FIX ${base.side}: ${gap.size}pt gap ${gap.dir} (void ${gap.bottom}–${gap.top}) at ${_fmtMins(_utcSecToIstMins(gap.bTime) + cfg.resolutionMins)}, ` +
    `confirm bar ${crossed ? `poked the day ${isUp ? "high" : "low"} ${extreme} on WEAK volume (${vol} < ${cfg.volMult}× avg ${avg}) and ` : ""}` +
    `returned (close ${entry}) | target = gap fill ${target} (${targetPts}pt) | SL = day ${isUp ? "high" : "low"} ${slSpot} (${slPts}pt) | R:R ${rr}`;

  if (!o.silent) {
    const ist = new Date(confirm.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    console.log(`[3M_GAP_FIX_SCALP ${ist}] ENTER ${base.side} @ ${entry} | TGT ${target} (${targetPts}pt) | SL ${slSpot} (${slPts}pt) | R:R ${rr}`);
  }
  return base;
}

// ── Exit rules (ONE place, so paper / backtest / live / replay cannot drift) ──
/**
 * Gap filled? The target is a fixed LEVEL. A PE (faded gap UP) wants price DOWN
 * to the fill level; a CE wants price UP to it.
 *
 * `target` must be a finite level — `price <= null` is `price <= 0`, which would
 * book a target on the very first tick.
 */
function targetHit(side, price, target) {
  if (!_num(price) || !_num(target)) return false;
  return side === "CE" ? price >= target : price <= target;
}

/**
 * Day extreme taken out? The stop is a fixed LEVEL and never moves. A PE (faded
 * gap UP) is stopped when price rises back through the day high; a CE when price
 * falls through the day low.
 */
function stopHit(side, price, stop) {
  if (!_num(price) || !_num(stop)) return false;
  return side === "CE" ? price <= stop : price >= stop;
}

module.exports = {
  NAME,
  DESCRIPTION,
  RETURN_MODES,
  getConfig,
  computeDayExtremes,
  findGap,
  averageVolume,
  getSignal,
  targetHit,
  stopHit,
  // shared time helpers (routes must not re-derive IST arithmetic)
  _istDayOf,
  _istDateStr,
  _utcSecToIstMins,
  _parseHHMM,
  _fmtMins,
};

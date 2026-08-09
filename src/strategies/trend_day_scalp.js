/**
 * TREND_DAY_SCALP — trade only on days that have already PROVEN they trend
 * ═════════════════════════════════════════════════════════════════════════════
 * Single-leg slightly-ITM NIFTY option buying, intraday. The design goal is a
 * LOW BUT STEADY result, not a big one: most days this takes no trade at all,
 * and it never needs a monster winner to finish green.
 *
 * WHY THIS SHAPE (the problem it was built to fix)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every other engine in this repo is a naked directional bet on a 5-minute
 * momentum close, and each one is right-tail dependent — ORB's own header records
 * 9 trades where the single best is 211% of net (remove it and the strategy is
 * -3,786 INR); EMA9_VWAP's +16k was one trade. This engine deliberately inverts
 * that: a FIXED target (no "let it run"), a stop taken from structure rather
 * than from hope, and a day filter whose main job is to produce a ZERO rather
 * than a loss.
 *
 * NOTE: the first version of this file claimed "a stop that is always the same
 * size" and capped it at 18 points to enforce that. Measured against real
 * candles the claim was false and the cap was fatal — see TDS_MAX_SL_PTS in
 * getConfig(). Stops now run roughly 12-40 points.
 *
 * The binding constraint is friction, not signal. Measured with this repo's own
 * charges.js on 1 lot: ~90 INR of statutory charges plus ~1.5 premium points of
 * slippage per side (~225 INR) = ~315 INR gone before the trade is right about
 * anything. At delta ~0.6 that is ~17 spot points of edge needed just to break
 * even, which is why the target floor here is 2.5R and not a scalper's 10 points.
 *
 * ── THE PIPELINE ────────────────────────────────────────────────────────────
 *  1. DAY GATE, evaluated ONCE on the 5-min bar that closes at TDS_GATE_TIME
 *     (default 10:15 IST) and then FROZEN for the day. All three must hold:
 *       a. first-hour (TDS_SESSION_START→TDS_GATE_TIME) range >= TDS_MIN_RANGE_PCT
 *          % of spot  — the day actually moved; a dead range has no juice for a buyer
 *       b. the last TDS_VWAP_STREAK_BARS closes are ALL on the same side of the
 *          running VWAP — one-directional, not a chop that keeps crossing
 *       c. |spot - VWAP| >= TDS_EXTENSION_MULT x the first-hour range — the day has
 *          committed to a side, not drifting on the line. See getConfig() for why
 *          the default is 0.20 — it is MEASURED from the real distribution,
 *          not reasoned from an idealised ramp as 0.35 and 0.6 were.
 *     Fail any one → NO TRADE TODAY. That zero is the whole point.
 *  2. DIRECTION IS LOCKED BY THE GATE. Spot above VWAP → CE only. Below → PE only.
 *     Never counter-trend, and it never flips later in the day.
 *  3. ENTRY = a pullback into the zone that is immediately reclaimed. On a closed
 *     5-min bar, with zone = the NEARER of VWAP and EMA(TDS_EMA_PERIOD) to price
 *     (max of the two for CE, min for PE):
 *       • touch    — the lowest low of the last TDS_PULLBACK_WINDOW bars reached
 *                    the zone (a WICK is enough — see "why a wick" below)
 *       • reclaim  — this bar CLOSES back beyond the zone
 *       • freshness— either the previous bar closed on the wrong side of its own
 *                    zone (a multi-bar dip) or THIS bar's low dipped in (a pin
 *                    bar). Blocks firing on every bar of a rally already underway.
 *       • conviction — right colour, and body >= TDS_BODY_ATR_MULT x ATR(5m)
 *  4. STOP = the pullback extreme. Floor-clamped to TDS_MIN_SL_PTS; if the
 *     structure needs MORE than TDS_MAX_SL_PTS the trade is SKIPPED, never
 *     widened and never tightened inside the structure.
 *     The cap is 40, MEASURED (see getConfig). It was 18, which skipped 48 of
 *     53 real setups and left only the shallowest — that single number is why
 *     the first backtest produced 5 trades in a year. Losses are NOT all the
 *     same size any more: they range roughly 12-40pt, about 500-1,600 rupees
 *     of premium on 1 lot.
 *  5. TARGET = a FIXED entry ± TDS_TARGET_R x the stop distance. Taken when reached.
 *  6. Route-owned exits, in this priority: stop → target → breakeven jump at
 *     +TDS_BREAKEVEN_R (stop moves ONCE to entry ± TDS_BREAKEVEN_BUFFER_PTS and
 *     then never moves again) → time stop → premium stop → forced EOD.
 *
 * ── WHY A WICK TOUCH COUNTS AS A PULLBACK (decided here, on purpose) ────────
 * Requiring a CLOSE beyond VWAP/EMA20 would mean waiting for the trend to
 * actually break before buying its continuation — on a genuine trend day price
 * usually just grazes the zone and bounces. trend_pb.js already treats a pullback
 * this way (it tests pullbackLow against an EMA zone plus a tolerance, not a
 * close). Same reading here, so the two engines cannot disagree about what the
 * word "pullback" means.
 *
 * ── DELIBERATELY NOT HERE (do not "helpfully" add these) ────────────────────
 * No VIX gate, no OI filter, no ADX, no volume, no RSI, no SuperTrend, no
 * multi-timeframe bias, no confirmation candle, no rolling/ATR trail, no partial
 * booking, no re-entry after target, no expiry-day rule. The stop moves exactly
 * ONCE (to breakeven) and never again — a rolling trail is what turns this
 * repo's other engines' winners into scratches. Position sizing is 1 lot; there
 * is no averaging and no pyramiding.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Every value the decision reads comes from CLOSED 5-min candle OHLC — never the
 * live spot — so Paper, Backtest, Live and Replay compute identical numbers. The
 * VWAP is EQUAL-WEIGHTED HLC3 (a TWAP), matching ema9_vwap.js: the Fyers live
 * tick feed carries no per-bar index volume while Fyers HISTORY does, so a
 * volume-weighted VWAP makes Paper and Backtest disagree about the same session.
 * That parity requirement is not negotiable — see the header of ema9_vwap.js.
 *
 * ── NOT MARKET-VALIDATED ────────────────────────────────────────────────────
 * Zero trades, paper or live.
 *
 * TDS_MAX_SL_PTS and TDS_EXTENSION_MULT are now set from a MEASURED distribution
 * (39 sessions, Mar-Apr 2026) because their first values were derived from
 * idealised arithmetic and produced 5 trades in a year. Measured-from is not the
 * same as validated: 39 sessions and 17 trades cannot tell 0.15 from 0.20, and
 * the P&L across that sweep ran -2,676 to +758 — noise. Neither value was picked
 * for its P&L, deliberately.
 *
 * Every OTHER constant is still an unmeasured prior from the friction arithmetic
 * above. Collect clean paper days and diff them against /replay before touching
 * any live gate.
 *
 * Contract:
 *   getConfig()                              -> live env read (never cached)
 *   computeVwapSeries(candles, anchorMins)   -> per-bar equal-weight HLC3 VWAP
 *   computeEmaSeries(candles, period)        -> time-aligned EMA
 *   computeAtrSeries(candles, period)        -> time-aligned ATR
 *   evaluateDayGate(candles, opts)           -> the once-a-day tradeable/side verdict
 *   getSignal(candles, opts)                 -> { signal, side, entrySpot, slSpot,
 *                                                 slPts, targetSpot, beArmSpot, ... }
 */

const { EMA, ATR } = require("technicalindicators");

const NAME = "TREND_DAY_SCALP";
const DESCRIPTION =
  "Trend Day Scalp — 10:15 day gate (range + VWAP streak + extension) locks the side, " +
  "then a pullback-and-reclaim of the VWAP/EMA20 zone; structural stop floored at 12pt and capped at 40pt, fixed 2.5R target, one breakeven jump";

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
 * Deliberately NOT a silent collapse to midnight: a typo in TDS_GATE_TIME would
 * otherwise move the day gate to 00:00 and arm the strategy on the first bar of
 * the session without a word.
 */
function _parseHHMM(raw, def) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(raw == null ? "" : raw));
  if (!m) return def;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return def;
  return h * 60 + mm;
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

/**
 * Live config read. Settings saves mutate process.env in place, so this must
 * never be cached — every caller re-reads on each evaluation.
 */
function getConfig() {
  return {
    // Day gate
    sessionStartMin: _parseHHMM(process.env.TDS_SESSION_START, 9 * 60 + 15),
    gateMin:         _parseHHMM(process.env.TDS_GATE_TIME,    10 * 60 + 15),
    minRangePct:     _numEnv("TDS_MIN_RANGE_PCT",    0.5, 0),
    vwapStreakBars:  _intEnv("TDS_VWAP_STREAK_BARS",   6, 1, 100),
    // 0.20, MEASURED — the earlier 0.35 (and the 0.6 before it) came from
    // arithmetic on an idealised path and was simply wrong. The "linear ramp
    // scores 0.5" reasoning assumes price walks from L to H with VWAP anchored
    // at the open; real first hours are not that, VWAP tracks price closely, and
    // the measured spot-to-VWAP distance over 39 sessions is median 0.18 x range,
    // p90 0.39. So 0.35 sat near the 85th percentile and passed 13% of days —
    // "extreme only", not "committed". 0.20 sits just above the median, i.e.
    // roughly the more-committed half of days.
    //
    // Deliberately NOT the best-scoring value: on that sample 0.15 nets +758 and
    // 0.20 nets -683, but the whole sweep runs -2676..+758 on 17 trades, which
    // is noise. Picking the peak would be fitting to 39 sessions. This leg is set
    // from the distribution, and the P&L is left to a real out-of-sample run.
    extensionMult:   _numEnv("TDS_EXTENSION_MULT",  0.20, 0),
    // Entry
    emaPeriod:       _intEnv("TDS_EMA_PERIOD",        20, 2, 400),
    atrPeriod:       _intEnv("TDS_ATR_PERIOD",        14, 2, 400),
    bodyAtrMult:     _numEnv("TDS_BODY_ATR_MULT",    0.4, 0),
    pullbackWindow:  _intEnv("TDS_PULLBACK_WINDOW",    3, 1, 50),
    entryEndMin:     _parseHHMM(process.env.TDS_ENTRY_END, 14 * 60),
    // Risk
    minSlPts:        _numEnv("TDS_MIN_SL_PTS",        12, 0),
    // 40, MEASURED — and this was the defect that made the strategy produce 5
    // trades in a year. With the cap removed, 39 sessions yield 53 valid
    // pullback-and-reclaim setups whose structural stop (reclaim close back to
    // the pullback extreme) is median 35pt, p25 26pt, p75 47pt. An 18pt cap
    // therefore SKIPPED 48 of 53 — and the 5 survivors were the shallowest
    // touches, i.e. adversely selected, which is why every one of them lost.
    //
    // The entry rule and the risk rule were mutually exclusive by geometry: a
    // pullback deep enough to reach VWAP/EMA20 on 5-min NIFTY is 25-35 index
    // points, and no cap near 18 can pay for it. 40 covers ~p60 of the real
    // distribution while still refusing the 47pt+ tail.
    //
    // The cost is honest and must not be glossed: ~35pt of index risk is roughly
    // 1,400 rupees of premium on 1 lot at delta 0.6, NOT the small fixed risk
    // this strategy was first pitched with. TDS_MAX_DAILY_LOSS moved 1500 -> 3000
    // for the same reason — at 1500 a single stop-out ends the day, which makes
    // the 2-trade budget and the stop-out breaker dead letters.
    maxSlPts:        _numEnv("TDS_MAX_SL_PTS",        40, 0),
    targetR:         _numEnv("TDS_TARGET_R",         2.5, 0),
    breakevenR:      _numEnv("TDS_BREAKEVEN_R",      1.0, 0),
    breakevenBuffer: _numEnv("TDS_BREAKEVEN_BUFFER_PTS", 3, 0),
    timeStopMins:    _intEnv("TDS_TIME_STOP_MINS",    25, 0, 400),
    premiumStopPct:  _numEnv("TDS_PREMIUM_STOP_PCT",  25, 0, 100),
    resolutionMins:  _intEnv("TDS_RESOLUTION", 5, 1, 60),
  };
}

// ── indicator series (time-aligned, so charts plot the exact decision numbers) ─
/**
 * Session-anchored VWAP, EQUAL-WEIGHTED over HLC3 (a TWAP). Volume is
 * deliberately never read — see the determinism note in the file header.
 * Returns one entry per candle of the LAST IST day present; earlier days and
 * pre-anchor bars map to null so indices stay aligned with `candles`.
 */
function computeVwapSeries(candles, anchorMins) {
  const out = new Array(Array.isArray(candles) ? candles.length : 0).fill(null);
  if (!Array.isArray(candles) || candles.length === 0) return out;
  if (anchorMins == null) anchorMins = getConfig().sessionStartMin;

  const day = _istDayOf(candles[candles.length - 1].time);
  let sumP = 0, count = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || !_num(c.high) || !_num(c.low) || !_num(c.close)) continue;
    if (_istDayOf(c.time) !== day) continue;
    if (_utcSecToIstMins(c.time) < anchorMins) continue;
    sumP += (c.high + c.low + c.close) / 3;
    count++;
    out[i] = { time: c.time, value: _r2(sumP / count) };
  }
  return out;
}

/** EMA(p) over N closes → N-p+1 outputs, out[i] ↔ candles[i+p-1]. */
function computeEmaSeries(candles, period) {
  const out = new Array(Array.isArray(candles) ? candles.length : 0).fill(null);
  if (!Array.isArray(candles) || candles.length < period) return out;
  const arr = EMA.calculate({ period, values: candles.map(c => c.close) });
  for (let i = 0; i < arr.length; i++) {
    const c = candles[i + period - 1];
    if (c) out[i + period - 1] = { time: c.time, value: _r2(arr[i]) };
  }
  return out;
}

/**
 * ATR(p) over N bars → N-p outputs, out[j] ↔ candles[j+p] (verified against the
 * technicalindicators package, and asserted in the test harness rather than trusted).
 */
function computeAtrSeries(candles, period) {
  const out = new Array(Array.isArray(candles) ? candles.length : 0).fill(null);
  if (!Array.isArray(candles) || candles.length <= period) return out;
  const arr = ATR.calculate({
    period,
    high:  candles.map(c => c.high),
    low:   candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
  const offset = candles.length - arr.length;   // = period, but derived, not assumed
  for (let j = 0; j < arr.length; j++) {
    const c = candles[j + offset];
    if (c) out[j + offset] = { time: c.time, value: _r2(arr[j]) };
  }
  return out;
}

/** The pullback zone: whichever of VWAP / EMA sits NEARER to price. */
function pullbackZone(side, vwap, ema) {
  if (!_num(vwap) && !_num(ema)) return null;
  if (!_num(vwap)) return _r2(ema);
  if (!_num(ema))  return _r2(vwap);
  return _r2(side === "CE" ? Math.max(vwap, ema) : Math.min(vwap, ema));
}

// ── the once-a-day gate ──────────────────────────────────────────────────────
/**
 * evaluateDayGate(candles, opts)
 *
 * Evaluated on the 5-min bar that CLOSES at cfg.gateMin — i.e. the bar whose
 * START time is gateMin - resolution. Reading the close (never the live spot) is
 * what lets Paper, Backtest and Replay agree on the verdict for a given session.
 *
 * The caller is expected to FREEZE the result for the rest of the day; this
 * function is pure and will happily recompute, but the strategy's meaning is
 * "decided once at 10:15".
 *
 * @param {Array}  candles 5-min IST spot bars, ascending, may span several days.
 * @param {object} opts    { cfg, silent }
 * @returns {{ decided, tradeable, side, reason, gateTime, gateDateStr, spot,
 *             vwap, rangePts, rangePct, extensionPts, extensionNeeded,
 *             streakBars, streakOk, rangeOk, extensionOk, checks }}
 */
function evaluateDayGate(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const base = {
    decided: false, tradeable: false, side: null, reason: "",
    gateTime: null, gateDateStr: null, spot: null, vwap: null,
    rangePts: null, rangePct: null, extensionPts: null, extensionNeeded: null,
    streakBars: 0, streakOk: false, rangeOk: false, extensionOk: false,
    checks: [],
  };

  if (!Array.isArray(candles) || candles.length === 0) {
    return Object.assign(base, { reason: "No candles — day gate cannot be evaluated" });
  }

  const day = _istDayOf(candles[candles.length - 1].time);
  const res = cfg.resolutionMins;
  // The gate bar is the one that CLOSES at gateMin, so its start is gateMin-res.
  const gateStartMin = cfg.gateMin - res;

  // Today's in-session bars, in order. Everything below reads only these.
  const todays = candles.filter(c =>
    c && _num(c.open) && _num(c.high) && _num(c.low) && _num(c.close) &&
    _istDayOf(c.time) === day &&
    _utcSecToIstMins(c.time) >= cfg.sessionStartMin
  );
  if (todays.length === 0) {
    return Object.assign(base, { reason: "No in-session candles for today yet — waiting for the open" });
  }

  const gateIdx = todays.findIndex(c => _utcSecToIstMins(c.time) === gateStartMin);
  if (gateIdx < 0) {
    const lastMin = _utcSecToIstMins(todays[todays.length - 1].time);
    return Object.assign(base, {
      reason: lastMin < gateStartMin
        ? `Waiting for the ${_fmtMins(cfg.gateMin)} day gate (last bar ${_fmtMins(lastMin + res)})`
        : `Gate bar (${_fmtMins(gateStartMin)}) missing from the session — cannot decide the day`,
    });
  }

  // The window is 09:15 → 10:15 inclusive of the gate bar.
  const window = todays.slice(0, gateIdx + 1);
  const gateBar = todays[gateIdx];
  base.decided     = true;
  base.gateTime    = gateBar.time;
  base.gateDateStr = _istDateStr(gateBar.time);
  base.spot        = _r2(gateBar.close);

  const hi = Math.max(...window.map(c => c.high));
  const lo = Math.min(...window.map(c => c.low));
  const rangePts = _r2(hi - lo);
  base.rangePts = rangePts;
  base.rangePct = gateBar.close ? _r2((rangePts / gateBar.close) * 100) : null;

  // Running VWAP across the window — the line a trader actually sees at each bar.
  const vwapSeries = computeVwapSeries(window, cfg.sessionStartMin);
  const vwapAt = vwapSeries.map(v => (v ? v.value : null));
  const vwap = vwapAt[vwapAt.length - 1];
  if (!_num(vwap)) {
    return Object.assign(base, { reason: "VWAP not computable for the gate window" });
  }
  base.vwap = vwap;

  // (a) the day actually moved
  base.rangeOk = rangePts > 0 && base.rangePct != null && base.rangePct >= cfg.minRangePct;

  // (b) the last N closes are all on the SAME side of the running VWAP
  const need = cfg.vwapStreakBars;
  let streakSide = null, streakOk = false, streakBars = 0;
  if (window.length >= need) {
    const tail = window.slice(-need);
    const tailV = vwapAt.slice(-need);
    const allAbove = tail.every((c, i) => _num(tailV[i]) && c.close > tailV[i]);
    const allBelow = tail.every((c, i) => _num(tailV[i]) && c.close < tailV[i]);
    streakOk = allAbove || allBelow;
    streakSide = allAbove ? "CE" : allBelow ? "PE" : null;
    streakBars = need;
  }
  base.streakOk = streakOk;
  base.streakBars = streakBars;

  // (c) the day has committed — spot is extended from VWAP by >= mult x range
  const extensionPts = _r2(Math.abs(gateBar.close - vwap));
  const extensionNeeded = _r2(cfg.extensionMult * rangePts);
  base.extensionPts = extensionPts;
  base.extensionNeeded = extensionNeeded;
  base.extensionOk = extensionPts >= extensionNeeded;

  // The side the extension implies must agree with the streak side; if the two
  // disagree the day is not one-directional, whatever the numbers say.
  const extSide = gateBar.close > vwap ? "CE" : gateBar.close < vwap ? "PE" : null;

  base.checks = [
    { name: "first-hour range", ok: base.rangeOk,
      detail: `${rangePts}pt = ${base.rangePct}% of ${base.spot} (need >= ${cfg.minRangePct}%)` },
    { name: `${need} closes one side of VWAP`, ok: streakOk,
      detail: streakOk ? `all ${need} ${streakSide === "CE" ? "above" : "below"} VWAP ${vwap}` : `crosses VWAP ${vwap} within the last ${need} bars` },
    { name: "extension from VWAP", ok: base.extensionOk,
      detail: `${extensionPts}pt vs need ${extensionNeeded}pt (${cfg.extensionMult} x range)` },
  ];

  if (!base.rangeOk || !streakOk || !base.extensionOk || !extSide || extSide !== streakSide) {
    const failed = base.checks.filter(c => !c.ok).map(c => `${c.name} (${c.detail})`);
    if (extSide && streakSide && extSide !== streakSide) failed.push("streak side and VWAP side disagree");
    if (!extSide) failed.push("spot sits exactly on VWAP — no side");
    return Object.assign(base, {
      tradeable: false,
      reason: `NO TRADE TODAY — ${failed.join("; ")}`,
    });
  }

  base.tradeable = true;
  base.side = extSide;
  base.reason =
    `TRADEABLE ${extSide}-only day — first-hour range ${rangePts}pt (${base.rangePct}%), ` +
    `last ${need} closes ${extSide === "CE" ? "above" : "below"} VWAP ${vwap}, ` +
    `spot ${base.spot} extended ${extensionPts}pt (>= ${extensionNeeded}pt)`;

  if (!o.silent) {
    console.log(`[TREND_DAY_SCALP ${base.gateDateStr} ${_fmtMins(cfg.gateMin)}] DAY GATE: ${base.reason}`);
  }
  return base;
}

function _fmtMins(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ── the entry signal ─────────────────────────────────────────────────────────
function _baseSignal(cfg) {
  return {
    signal: "NONE", side: null, reason: "", skipReason: "", warmup: false,
    entrySpot: null, slSpot: null, slPts: null, targetSpot: null,
    beArmSpot: null, beStopSpot: null, signalStrength: null,
    vwap: null, ema: null, zone: null, atr: null,
    bodyPts: null, bodyNeeded: null, pullbackLow: null, pullbackHigh: null,
    slRaw: null, slClamped: false,
    cfg,
  };
}

/**
 * getSignal(candles, opts)
 *
 * @param {Array} candles ascending 5-min IST spot bars. The LAST element is the
 *        just-CLOSED signal bar — never a forming bar (the caller decides that).
 * @param {object} opts {
 *          dayGate  — the FROZEN evaluateDayGate() result for today. Required:
 *                     without it there is no side and no trade. Passing it in
 *                     (rather than recomputing) is what makes "decided once at
 *                     10:15" true on the live path.
 *          cfg, silent, alreadyTraded
 *        }
 */
function getSignal(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const base = _baseSignal(cfg);

  if (!Array.isArray(candles) || candles.length < 2) {
    base.warmup = true;
    base.skipReason = base.reason = `Warming up (${candles ? candles.length : 0} candles)`;
    return base;
  }

  const last = candles[candles.length - 1];
  if (!last || !_num(last.open) || !_num(last.high) || !_num(last.low) || !_num(last.close)) {
    base.skipReason = base.reason = "Last candle has no usable OHLC — refusing to decide";
    return base;
  }

  // ── The day gate owns the side. No gate → no trade, ever. ─────────────────
  const gate = o.dayGate;
  if (!gate || !gate.decided) {
    base.skipReason = base.reason = gate && gate.reason
      ? gate.reason
      : `Day gate not decided yet — nothing trades before ${_fmtMins(cfg.gateMin)}`;
    return base;
  }
  if (!gate.tradeable || (gate.side !== "CE" && gate.side !== "PE")) {
    base.skipReason = base.reason = gate.reason || "Day gate said NO TRADE TODAY";
    return base;
  }
  const side = gate.side;
  base.side = side;

  // ── Window: nothing new after TDS_ENTRY_END. ─────────────────────────────
  const closeMins = _utcSecToIstMins(last.time) + cfg.resolutionMins;
  if (closeMins <= cfg.gateMin) {
    base.skipReason = base.reason = `Bar closes ${_fmtMins(closeMins)} — at or before the ${_fmtMins(cfg.gateMin)} gate, no entries yet`;
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

  // ── Indicators, all from CLOSED bars. ────────────────────────────────────
  const vwapSeries = computeVwapSeries(candles, cfg.sessionStartMin);
  const emaSeries  = computeEmaSeries(candles, cfg.emaPeriod);
  const atrSeries  = computeAtrSeries(candles, cfg.atrPeriod);

  const n = candles.length;
  const vwapNow = vwapSeries[n - 1] ? vwapSeries[n - 1].value : null;
  const emaNow  = emaSeries[n - 1]  ? emaSeries[n - 1].value  : null;
  const atrNow  = atrSeries[n - 1]  ? atrSeries[n - 1].value  : null;

  base.vwap = vwapNow; base.ema = emaNow; base.atr = atrNow;

  if (!_num(vwapNow) || !_num(emaNow) || !_num(atrNow)) {
    base.warmup = true;
    const missing = [];
    if (!_num(vwapNow)) missing.push("VWAP");
    if (!_num(emaNow))  missing.push(`EMA${cfg.emaPeriod}`);
    if (!_num(atrNow))  missing.push(`ATR${cfg.atrPeriod}`);
    base.skipReason = base.reason = `Indicators not seeded (${missing.join(", ")}) — warming up`;
    return base;
  }
  if (!(atrNow > 0)) {
    base.skipReason = base.reason = `ATR ${atrNow} is not positive — cannot size the conviction body, skipping`;
    return base;
  }

  const zone = pullbackZone(side, vwapNow, emaNow);
  base.zone = zone;
  if (!_num(zone)) {
    base.skipReason = base.reason = "Pullback zone not computable";
    return base;
  }

  // ── The pullback window (today's bars only — a prior day must never leak). ─
  const day = _istDayOf(last.time);
  const win = [];
  for (let i = n - 1; i >= 0 && win.length < cfg.pullbackWindow; i--) {
    if (_istDayOf(candles[i].time) !== day) break;
    win.unshift(candles[i]);
  }
  const pullbackLow  = _r2(Math.min(...win.map(c => c.low)));
  const pullbackHigh = _r2(Math.max(...win.map(c => c.high)));
  base.pullbackLow = pullbackLow;
  base.pullbackHigh = pullbackHigh;

  // Previous bar's zone — only used for the freshness test, and only when the
  // previous bar belongs to the same session.
  const prev = candles[n - 2];
  const prevSameDay = prev && _istDayOf(prev.time) === day;
  const prevZone = prevSameDay
    ? pullbackZone(side,
        vwapSeries[n - 2] ? vwapSeries[n - 2].value : null,
        emaSeries[n - 2]  ? emaSeries[n - 2].value  : null)
    : null;

  const body = _r2(Math.abs(last.close - last.open));
  const bodyNeeded = _r2(cfg.bodyAtrMult * atrNow);
  base.bodyPts = body;
  base.bodyNeeded = bodyNeeded;

  // ── The four entry conditions. ───────────────────────────────────────────
  const isCE = side === "CE";
  const touched   = isCE ? pullbackLow <= zone : pullbackHigh >= zone;
  const reclaimed = isCE ? last.close > zone   : last.close < zone;
  const dippedNow = isCE ? last.low <= zone    : last.high >= zone;
  const prevBeyond = _num(prevZone)
    ? (isCE ? prev.close <= prevZone : prev.close >= prevZone)
    : false;
  const fresh     = dippedNow || prevBeyond;
  const rightColour = isCE ? last.close > last.open : last.close < last.open;
  const convicted = rightColour && body >= bodyNeeded;

  if (!touched) {
    base.skipReason = base.reason =
      `${side} day, but no pullback — ${isCE ? "lowest low" : "highest high"} of the last ${win.length} bars ` +
      `${isCE ? pullbackLow : pullbackHigh} never reached the zone ${zone} (${_zoneLabel(cfg, vwapNow, emaNow, zone)})`;
    return base;
  }
  if (!reclaimed) {
    base.skipReason = base.reason =
      `${side} pullback touched the zone ${zone}, waiting for the reclaim — close ${_r2(last.close)} is still ` +
      `${isCE ? "below" : "above"} it`;
    return base;
  }
  if (!fresh) {
    base.skipReason = base.reason =
      `${side} reclaim ignored — price is already running (this bar's ${isCE ? "low" : "high"} ` +
      `${isCE ? _r2(last.low) : _r2(last.high)} never dipped into the zone ${zone} and the previous bar closed beyond it too)`;
    return base;
  }
  if (!rightColour) {
    base.skipReason = base.reason = `${side} reclaim candle is the wrong colour (open ${_r2(last.open)} → close ${_r2(last.close)}) — no conviction`;
    return base;
  }
  if (!convicted) {
    base.skipReason = base.reason =
      `${side} reclaim body ${body}pt < ${bodyNeeded}pt (${cfg.bodyAtrMult} x ATR ${atrNow}) — no conviction`;
    return base;
  }

  // ── Risk: floor-clamp the stop, SKIP when the structure is too wide. ─────
  const entry = _r2(last.close);
  const structPts = _r2(isCE ? entry - pullbackLow : pullbackHigh - entry);
  base.slRaw = structPts;

  if (structPts > cfg.maxSlPts) {
    base.skipReason = base.reason =
      `${side} setup valid but the structural stop is ${structPts}pt > ${cfg.maxSlPts}pt cap — SKIPPED ` +
      `(never widened, never tightened inside the structure)`;
    return base;
  }
  const slPts = _r2(Math.max(structPts, cfg.minSlPts));
  base.slClamped = slPts !== structPts;

  if (!(slPts > 0)) {
    base.skipReason = base.reason = `${side} stop distance resolved to ${slPts}pt — refusing a zero-risk trade`;
    return base;
  }

  const slSpot     = _r2(isCE ? entry - slPts : entry + slPts);
  const targetSpot = _r2(isCE ? entry + cfg.targetR * slPts : entry - cfg.targetR * slPts);
  const beArmSpot  = _r2(isCE ? entry + cfg.breakevenR * slPts : entry - cfg.breakevenR * slPts);
  const beStopSpot = _r2(isCE ? entry + cfg.breakevenBuffer : entry - cfg.breakevenBuffer);

  base.signal = isCE ? "BUY_CE" : "BUY_PE";
  base.signalStrength = "STRONG";
  base.entrySpot  = entry;
  base.slSpot     = slSpot;
  base.slPts      = slPts;
  base.targetSpot = targetSpot;
  base.beArmSpot  = beArmSpot;
  base.beStopSpot = beStopSpot;
  base.reason =
    `TREND DAY SCALP ${side}: ${gate.side} day (range ${gate.rangePts}pt, ext ${gate.extensionPts}pt) → ` +
    `pullback to zone ${zone} (${_zoneLabel(cfg, vwapNow, emaNow, zone)}) → reclaim close ${entry}, ` +
    `body ${body}pt >= ${bodyNeeded}pt | SL ${slSpot} (${slPts}pt${base.slClamped ? `, floored from ${structPts}pt` : ""}) ` +
    `| target ${targetSpot} (${cfg.targetR}R) | breakeven arms at ${beArmSpot} → stop ${beStopSpot}`;

  if (!o.silent) {
    const ist = new Date(last.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    console.log(`[TREND_DAY_SCALP ${ist}] ENTER ${side} @ ${entry} | SL ${slSpot} (${slPts}pt) | TGT ${targetSpot} (${cfg.targetR}R) | BE arm ${beArmSpot}`);
  }
  return base;
}

function _zoneLabel(cfg, vwap, ema, zone) {
  if (_num(vwap) && zone === _r2(vwap)) return `VWAP ${vwap}`;
  if (_num(ema)  && zone === _r2(ema))  return `EMA${cfg.emaPeriod} ${ema}`;
  return `VWAP ${vwap} / EMA${cfg.emaPeriod} ${ema}`;
}

// ── Exit rules (ONE place, so paper / backtest / live / replay cannot drift) ──
/**
 * The breakeven jump. The stop moves EXACTLY ONCE — when the favourable spot
 * move first reaches breakevenR x the original stop distance — to
 * entry ± breakevenBuffer, and then never moves again. Deliberately not a trail.
 *
 * @returns {{ armed: boolean, stop: number|null }}
 */
function breakevenJump(side, entrySpot, spot, slPts, cfg) {
  cfg = cfg || getConfig();
  if (!_num(entrySpot) || !_num(spot) || !_num(slPts) || !(slPts > 0)) return { armed: false, stop: null };
  const fav = side === "CE" ? spot - entrySpot : entrySpot - spot;
  if (fav < cfg.breakevenR * slPts) return { armed: false, stop: null };
  return {
    armed: true,
    stop: _r2(side === "CE" ? entrySpot + cfg.breakevenBuffer : entrySpot - cfg.breakevenBuffer),
  };
}

/** Hard stop hit? `stop` must be a finite level — `spot <= null` is `spot <= 0`. */
function stopHit(side, spot, stop) {
  if (!_num(spot) || !_num(stop)) return false;
  return side === "CE" ? spot <= stop : spot >= stop;
}

/** Fixed target reached? */
function targetHit(side, spot, target) {
  if (!_num(spot) || !_num(target)) return false;
  return side === "CE" ? spot >= target : spot <= target;
}

/**
 * Time stop — flat if the trade has not reached +breakevenR within
 * timeStopMins of entry. A stalled option only loses to theta.
 */
function timeStopHit(entryUnixSec, nowUnixSec, beArmed, cfg) {
  cfg = cfg || getConfig();
  if (cfg.timeStopMins <= 0 || beArmed) return false;
  if (!_num(entryUnixSec) || !_num(nowUnixSec)) return false;
  return (nowUnixSec - entryUnixSec) >= cfg.timeStopMins * 60;
}

/**
 * Premium stop — the option itself has lost premiumStopPct% of its entry price.
 * Catches an IV crush the spot stop cannot see (spot flat, premium bleeding).
 */
function premiumStopHit(entryPremium, nowPremium, cfg) {
  cfg = cfg || getConfig();
  if (cfg.premiumStopPct <= 0) return false;
  if (!_num(entryPremium) || !_num(nowPremium) || !(entryPremium > 0)) return false;
  return nowPremium <= entryPremium * (1 - cfg.premiumStopPct / 100);
}

module.exports = {
  NAME,
  DESCRIPTION,
  getConfig,
  computeVwapSeries,
  computeEmaSeries,
  computeAtrSeries,
  pullbackZone,
  evaluateDayGate,
  getSignal,
  breakevenJump,
  stopHit,
  targetHit,
  timeStopHit,
  premiumStopHit,
  // shared time helpers (routes must not re-derive IST arithmetic)
  _istDayOf,
  _istDateStr,
  _utcSecToIstMins,
  _parseHHMM,
  _fmtMins,
};

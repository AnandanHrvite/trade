/**
 * ORB — Opening Range Breakout (NIFTY index options, slightly-ITM single leg)
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE engine. No V1/V2/V3 branching, no RSI/ADX/EMA-stack, no prior-day filter,
 * no wick/volume/close-position gates. Rules were selected by ablation on 39 real
 * NIFTY sessions (Mar–Apr 2026, 5-min spot) and what failed was deleted outright
 * rather than left behind a toggle.
 *
 * READ "HOW MUCH TO TRUST THE NUMBERS" BELOW BEFORE CHANGING ANYTHING. 39 sessions
 * is far too small to establish an edge; these constants are priors, not optima,
 * and the ablation numbers are directional evidence, not statistical proof.
 *
 * ── THE PIPELINE ────────────────────────────────────────────────────────────
 *   1. Build the opening range 09:15–09:30 and FREEZE it (never recalculated).
 *   2. Day sanity: OR ≤ ORB_OR_ATR_MAX × ATR(15m), and |gap| ≤ ORB_GAP_OR_MULT × OR.
 *   3. Hunt the first 5-min CLOSE that clears the OR edge by a volatility-scaled
 *      buffer. That is the ONE committed breakout of the day.
 *   4. The breakout candle must be decisive: correct colour, body ≥
 *      ORB_BODY_ATR_MULT × ATR(5m), and closing on the right side of session VWAP.
 *   5. NEVER buy the breakout candle. The NEXT candle must extend the move
 *      (higher-high AND higher-close beyond the edge, still the right side of VWAP).
 *   6. If that candle hesitates, stay armed for up to ORB_RETEST_MAX_WAIT candles
 *      and take either a trend-resume or a retest-and-hold of the edge. A close
 *      back through the box cancels the day.
 *   7. Entry is always a candle CLOSE — never intrabar.
 *
 * ── WHY THE INITIAL STOP IS ATR-BASED (2026-07-26), AND ITS REAL LIMIT ─────
 * The breakout candle is BY CONSTRUCTION a large-body momentum bar. Placing the
 * stop at its opposite extreme puts it ~one body away -- exactly where the normal
 * post-momentum retracement lives. Measured: that stop had a median width of 23pt
 * and was hit on 4 of 6 trades, including the day that then ran 213pt our way.
 * The stop is now the WIDER of the structural extreme and ORB_SL_ATR_MULT x ATR(5m).
 *
 * BUT KNOW THIS (2026-07-26 adversarial re-review): the route's ORB_MAX_TRADE_LOSS
 * rupee cap is a TIGHTER stop than this one. At the shipped 1500 INR / 65-lot /
 * ~0.6 delta it trips after only ~38 spot pts, while ORB_SL_ATR_MULT=1.5 sits at
 * 50-83pt. So the rupee cap ends essentially every losing trade and the spot SL
 * never binds. Consequences, all verified on the 39-session sample:
 *   - every ATR multiplier from 1.0x to 2.5x gives an IDENTICAL result;
 *   - so does using the plain OR opposite edge. The multiplier is not tuned, it
 *     is INERT. Do not "optimise" it -- change ORB_MAX_TRADE_LOSS instead.
 *   - the only thing that mattered was that the OLD stop was TIGHTER than the cap
 *     and so fired first. Direction of the fix: supported. Magnitude: untested.
 * RECONCILED 2026-07-26: src/utils/orbStopRisk.js now clamps this stop to the level
 * the rupee budget actually allows, so what the dashboard shows IS what executes.
 * It logs when it clamps. Raise ORB_MAX_TRADE_LOSS if you want the full ATR stop.
 *
 * ── HOW MUCH TO TRUST THE NUMBERS BELOW ────────────────────────────────────
 * Authoritative figures come from `node scripts/orbValidate.js`, which drives THIS
 * engine plus the full production exit stack (adaptive breakeven, EMA trail, the
 * rupee cap) and prices trades in rupees with costs. On the only sample available
 * (39 sessions, Mar-Apr 2026) it reports:
 *
 *     9 trades, 33% win rate, net ~3,112 INR, profit factor 1.39
 *     bootstrap 95% CI on mean/trade = [-1,334, +2,503] INR
 *     P(true edge <= 0) = ~39%
 *     the single best trade is 231% of net -- REMOVE IT AND THE RESULT IS -4,089 INR
 *
 * Read that again: strip one trade out of nine and the strategy loses money. This
 * is not a validated edge, it is a right-tail lottery ticket measured over two
 * months. ~147 trades (~637 sessions, ~2.5 years) are needed for 95% confidence /
 * 80% power. Every constant below is a PRIOR to be revised, not a fitted optimum,
 * and the ablation numbers are directional evidence, not statistical proof --
 * e.g. the prior-day filter's removal is Fisher-exact p=0.152.
 *
 * Earlier, lower-fidelity passes quoted "+346 spot points, no losers" and later
 * "~6,737 INR". Both were optimistic: the first ignored costs entirely, the second
 * used a flat 20pt breakeven instead of the real max(20, 0.5xOR) rule. Trust
 * scripts/orbValidate.js over any number quoted from memory.
 *
 * STRONGEST UNTESTED HYPOTHESIS -- on this sample, a NARROW opening range was the
 * whole edge: OR < 1.5xATR15 gave 4 trades / 75% win / +10,700 INR, while
 * OR >= 1.5xATR15 gave 5 trades / 0% win / -7,587 INR. Mechanically sensible (a
 * quiet open stores energy the breakout releases). It is also n=9, so
 * ORB_OR_ATR_MAX stays at 2.5 rather than being tuned to it. Test this FIRST on
 * the long sample; it is the most likely real improvement in the whole design.
 *
 * ── MEASURED ABLATION (39 sessions, spot points, identical exits) ───────────
 *   prior-day "fresh ground"  DELETED -- kept 7 trades at 0% win / -7.2pt avg while
 *                             cutting 6 worth +290.8pt incl. BOTH winners. NOT
 *                             statistically significant (p=0.152); deleted because
 *                             a filter that removes the entire right tail of a
 *                             right-tail strategy is structurally wrong, AND
 *                             because with it on the strategy took 1 trade per 39
 *                             sessions, which can never be validated.
 *   close-in-extreme %        DELETED -- removing it took net 132.9 -> 346pt.
 *   body >= 0.6xATR(5m)       KEPT    -- but see the caveat: tightening this gate
 *                             monotonically "improves" every metric (PF 1.42 at
 *                             0.0 rising to 14.6 at 1.0) purely because it drops
 *                             scratch-cost trades while the 2-3 known winners
 *                             survive at every threshold. That is selection bias,
 *                             not evidence. 0.6 is a prior, not an optimum.
 *   OR <= 2.5xATR(15m)        KEPT    -- same caveat as above.
 *   gap <= 3xOR               KEPT    -- never fired in-sample; a news-shock risk
 *                             control, not alpha.
 *   VWAP side                 KEPT    -- never fired in-sample; standard guard.
 *   OR >= 0.7xATR(15m)        DELETED -- never fired, and the two winners came from
 *                             the two NARROWEST opening ranges, so a floor is
 *                             pointed the wrong way.
 *   RSI / ADX / EMA20-50      DELETED -- the engine carrying them took 0 trades in
 *                             39 sessions.
 *   wick % / volume / sweet-spot / fixed point ranges -- DELETED (V1 legacy, dead).
 *
 * Exit components, same sample: breakeven at +20pt is the single most valuable one
 * (removing it cost 106pt and introduced a -77pt worst case) and is FLAT over
 * 10-25pt, so it is not a fitted edge. The EMA trail is NOT flat: 9 is clearly too
 * tight, but 34 beat the shipped 20 in-sample. 20 was kept as the incumbent, not
 * because it was validated -- anything in 13-55 is within noise.
 *
 * Entry cut-off: 11:30 is a STRUCTURAL choice (an "opening range" breakout decays
 * through the day), not a measured one. Extending to 14:30 looked better in rupees
 * on this sample (+15.6k vs +9.7k) but also produced the worst single trade. Undetermined.
 *
 * Returns { signal, side, reason, orh, orl, rangePts, entrySpot, slSpot, targetSpot,
 *           signalStrength, vwap, atr5, atr15, gapPts, bodyPct, confirmed, gates }
 *   signal: "BUY_CE" | "BUY_PE" | "NONE"
 *   slSpot: the strategy's proposed initial stop. Routes must use this rather than
 *           recomputing one of their own — a single owner keeps paper/live/backtest
 *           in parity — and pass it through orbStopRisk.resolveInitialStop() to
 *           reconcile it with the per-trade rupee budget before placing it.
 */

const { ATR } = require("technicalindicators");

const NAME        = "ORB_15MIN";
const DESCRIPTION = "Opening Range Breakout — 15-min OR, next-candle confirmation, slightly-ITM CE/PE buying";

// ── Non-configurable design constants ───────────────────────────────────────
// Deliberately NOT env keys: these are structural choices, not tuning dials, and
// exposing them only invited drift between engines. Change them here, with a
// measurement, or not at all.
const ATR_PERIOD      = 14;    // ATR lookback for both the 5-min and 15-min yardsticks
const BUFFER_OR_MULT  = 0.15;  // breakout buffer, as a fraction of the opening range
const BUFFER_ATR_MULT = 0.30;  // ...or of ATR(5m), whichever is larger
const RETEST_TOL_PCT  = 0.10;  // retest tolerance, as a fraction of the OR
const RETEST_TOL_MIN  = 5;     // ...with this floor in points
const TARGET_OR_MULT  = 1.5;   // informational target only — there is no target exit

// ── Time / date helpers (IST, fixed +05:30 — NSE never observes DST) ────────
function _parseMins(envKey, fallback) {
  const v = (process.env[envKey] || fallback).trim();
  const [h, m] = v.split(":");
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}
function _istMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _istDay(unixSec)  { return Math.floor((unixSec + 19800) / 86400); }
function _r2(x) { return Math.round(x * 100) / 100; }

let _loggedNoVolumeOnce = false;
function _warnNoVolumeOnce(silent) {
  if (silent || _loggedNoVolumeOnce) return;
  _loggedNoVolumeOnce = true;
  console.log(`[ORB] note: candles carry no volume — VWAP falls back to TWAP (indices have no spot volume)`);
}

/**
 * Cumulative session VWAP from ORB_RANGE_START to the last candle, day-scoped to
 * the latest candle's IST day so a multi-day preload never leaks in. Typical price
 * ((H+L+C)/3) weighted by volume; falls back to TWAP when no candle carries volume
 * (the above/below-VWAP test stays meaningful either way).
 */
function computeVwap(candles) {
  if (!candles || candles.length === 0) return null;
  const startMin = _parseMins("ORB_RANGE_START", "09:15");
  const day = _istDay(candles[candles.length - 1].time);
  let sumPV = 0, sumV = 0, sumP = 0, count = 0, anyVol = false;
  for (const c of candles) {
    if (_istDay(c.time) !== day || _istMins(c.time) < startMin) continue;
    const tp = (c.high + c.low + c.close) / 3;
    sumP += tp; count++;
    if (typeof c.volume === "number" && c.volume > 0) { sumPV += tp * c.volume; sumV += c.volume; anyVol = true; }
  }
  if (count === 0) return null;
  return _r2(anyVol && sumV > 0 ? sumPV / sumV : sumP / count);
}

/**
 * The frozen opening range. Day-scoped, so calling it again at any point after
 * 09:30 always returns the same ORH/ORL. Returns null while still inside the
 * window or when the day has no candles yet.
 */
function computeOpeningRange(candles) {
  if (!candles || candles.length === 0) return null;
  const startMin = _parseMins("ORB_RANGE_START", "09:15");
  const endMin   = _parseMins("ORB_RANGE_END",   "09:30");
  const day = _istDay(candles[candles.length - 1].time);
  let high = -Infinity, low = Infinity, count = 0;
  for (const c of candles) {
    if (_istDay(c.time) !== day) continue;
    const m = _istMins(c.time);
    if (m < startMin || m >= endMin) continue;
    if (c.high > high) high = c.high;
    if (c.low  < low)  low  = c.low;
    count++;
  }
  if (count === 0 || high === -Infinity) return null;
  return { high: _r2(high), low: _r2(low), candleCount: count };
}

// ── Volatility yardsticks ───────────────────────────────────────────────────
function _atrAtLast(bars, period) {
  if (!bars || bars.length < period + 1) return null;
  const a = ATR.calculate({ period, high: bars.map(c => c.high), low: bars.map(c => c.low), close: bars.map(c => c.close) });
  return a && a.length ? a[a.length - 1] : null;
}

// Aggregate 5-min bars into :00/:15/:30/:45-aligned 15-min buckets, time-ordered.
function _to15m(candles) {
  const map = new Map(), order = [];
  for (const c of candles) {
    const key = _istDay(c.time) * 1000 + Math.floor(_istMins(c.time) / 15);
    const b = map.get(key);
    if (!b) { map.set(key, { high: c.high, low: c.low, close: c.close }); order.push(key); }
    else { if (c.high > b.high) b.high = c.high; if (c.low < b.low) b.low = c.low; b.close = c.close; }
  }
  return order.map(k => map.get(k));
}

/**
 * Today's open minus the previous trading day's close, from the multi-day preload
 * window. null when the prior day is not in the window — the caller fails OPEN,
 * because an unknown gap is not evidence of a bad gap.
 */
function _computeGap(candles, day) {
  let todayOpen = null, todayOpenTime = Infinity;
  let prevClose = null, prevCloseTime = -Infinity;
  for (const c of candles) {
    const d = _istDay(c.time);
    if (d === day) { if (c.time < todayOpenTime) { todayOpenTime = c.time; todayOpen = c.open; } }
    else if (d < day && c.time > prevCloseTime) { prevCloseTime = c.time; prevClose = c.close; }
  }
  return (todayOpen == null || prevClose == null) ? null : _r2(todayOpen - prevClose);
}

function _vwapSideOk(c, side, vwap) {
  if (vwap == null) return true;
  return side === "CE" ? c.close > vwap : c.close < vwap;
}

// Does `c` extend the breakout beyond the edge? (higher-high AND higher-close)
function _extends(c, brk, side, orh, orl) {
  return side === "CE"
    ? (c.close > orh && c.high > brk.high && c.close > brk.close)
    : (c.close < orl && c.low  < brk.low  && c.close < brk.close);
}

/**
 * Per-candle decision tracer (STEP 12 instrumentation).
 *
 * The trace ALWAYS rides back on the signal as `sig.gates`, so the skip log can
 * persist the whole funnel instead of only the first blocking reason. Cost is a
 * handful of small object pushes once per 5-min candle close — nil beside the ATR
 * maths already running.
 *
 * `ORB_DEBUG_TRACE=true` additionally prints the human-readable table to the
 * console (and therefore to /logs). Default OFF; turn it on for a session when
 * you need to see why entries are not firing, then turn it back off.
 */
function _tracer(candle, ctx) {
  const rows = [];
  return {
    rows,
    check(gate, pass, detail) { rows.push({ gate, status: pass ? "PASS" : "FAIL", detail: detail || "" }); return pass; },
    skip(gate, detail) { rows.push({ gate, status: "SKIP", detail: detail || "" }); },
    info(gate, detail) { rows.push({ gate, status: "INFO", detail: detail || "" }); },
    emit(decision) {
      if ((process.env.ORB_DEBUG_TRACE || "false").toLowerCase() !== "true") return;
      const t = candle ? new Date(candle.time * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "--:--:--";
      const head = [
        `close=${candle ? candle.close : "n/a"}`,
        ctx.orh != null ? `ORH=${ctx.orh} ORL=${ctx.orl} (${ctx.rangePts}pt)` : "OR=pending",
        ctx.vwap != null ? `VWAP=${ctx.vwap}` : null,
        ctx.atr5 != null ? `ATR5=${ctx.atr5}` : null,
        ctx.atr15 != null ? `ATR15=${ctx.atr15}` : null,
      ].filter(Boolean).join("  ");
      const body = rows.map(r => `    ${r.status.padEnd(4)} ${r.gate.padEnd(18)} ${r.detail}`).join("\n");
      console.log(`[ORB-TRACE ${t}] ${head}\n${body}\n    ==> ${decision}`);
    },
  };
}

function _blank() {
  return {
    signal: "NONE", side: null, reason: "",
    orh: null, orl: null, rangePts: null,
    entrySpot: null, slSpot: null, targetSpot: null, signalStrength: null,
    vwap: null, atr5: null, atr15: null, gapPts: null, bodyPct: null,
    confirmed: null, gates: null,
    // Retained as nulls purely so historical trade records keep a stable shape.
    vwapAligned: null, volRatio: null, volPass: null, wickRatio: null, wickPass: null,
  };
}

/**
 * getSignal(candles, opts)
 *
 * @param {Array<{time,open,high,low,close,volume?}>} candles  IST-aware 5-min candles.
 *        MUST include prior-day history (the routes preload ~7 days) so ATR(5m) and
 *        ATR(15m) are seeded before the open. The opening range and VWAP are
 *        day-scoped internally, so prior days never leak into today's range.
 * @param {{silent?:boolean, alreadyTraded?:boolean}} [opts]
 */
function getSignal(candles, opts) {
  const silent = !!(opts && opts.silent);
  const alreadyTraded = !!(opts && opts.alreadyTraded);
  const sig = _blank();

  // The tracer is created BEFORE the warm-up guard so that `sig.gates` is present
  // on EVERY return path. Callers (skipLogger, the /logs trace) treat gates as the
  // record of why a candle produced no trade; a path that returned without one
  // silently dropped that record.
  const tr = _tracer(candles && candles.length ? candles[candles.length - 1] : null, sig);
  const done = (s) => { s.gates = tr.rows; tr.emit(s.signal !== "NONE" ? `ENTER ${s.signal}` : `NO TRADE — ${s.reason}`); return s; };

  if (!candles || candles.length < 2) {
    tr.check("history", false, `${candles ? candles.length : 0} candles — need at least 2`);
    return done(Object.assign(sig, { reason: `Warming up (${candles ? candles.length : 0} candles)` }));
  }

  const cfg = {
    entryEnd:     _parseMins("ORB_ENTRY_END", "11:30"),
    orStart:      _parseMins("ORB_RANGE_START", "09:15"),
    orEnd:        _parseMins("ORB_RANGE_END", "09:30"),
    orAtrMax:     parseFloat(process.env.ORB_OR_ATR_MAX      || "2.5"),
    gapOrMult:    parseFloat(process.env.ORB_GAP_OR_MULT     || "3.0"),
    bodyAtrMult:  parseFloat(process.env.ORB_BODY_ATR_MULT   || "0.6"),
    slAtrMult:    parseFloat(process.env.ORB_SL_ATR_MULT     || "1.5"),
    retestWindow: parseInt  (process.env.ORB_RETEST_MAX_WAIT || "6", 10),
  };

  const last    = candles[candles.length - 1];
  const lastIdx = candles.length - 1;
  const lastIst = _istMins(last.time);
  const day     = _istDay(last.time);


  // ── 1. Session window ─────────────────────────────────────────────────────
  if (!tr.check("time window", lastIst >= cfg.orEnd && lastIst < cfg.entryEnd,
                `${process.env.ORB_RANGE_END || "09:30"}–${process.env.ORB_ENTRY_END || "11:30"} IST`)) {
    return done(Object.assign(sig, {
      reason: lastIst < cfg.orEnd
        ? `Building opening range (waiting for ${process.env.ORB_RANGE_END || "09:30"} IST)`
        : `Past ${process.env.ORB_ENTRY_END || "11:30"} IST — no new ORB entries (breakout is stale)`,
    }));
  }
  if (!tr.check("trade budget", !alreadyTraded, "ORB takes one trade per day")) {
    return done(Object.assign(sig, { reason: "Already traded this session — ORB takes only 1 trade/day" }));
  }

  // ── 2. Frozen opening range ───────────────────────────────────────────────
  const or = computeOpeningRange(candles);
  if (!tr.check("OR ready", !!or, or ? `ORH ${or.high} / ORL ${or.low}` : "no 09:15–09:30 candles yet")) {
    return done(Object.assign(sig, { reason: "Opening range not yet formed" }));
  }
  const rangePts = _r2(or.high - or.low);
  Object.assign(sig, { orh: or.high, orl: or.low, rangePts });

  // ── 3. Volatility yardstick, ANCHORED at the 09:30 OR freeze ──────────────
  // The opening range is frozen, so the volatility context that judges it is frozen
  // too: one stable ATR for the whole day means the committed breakout candle can
  // never be re-judged by later data, and the buffer/body thresholds never drift.
  let orEndIdx = -1;
  for (let i = 0; i <= lastIdx; i++) {
    if (_istDay(candles[i].time) === day && _istMins(candles[i].time) < cfg.orEnd) orEndIdx = i;
  }
  const yard  = orEndIdx >= 0 ? candles.slice(0, orEndIdx + 1) : candles;
  const atr5  = _atrAtLast(yard, ATR_PERIOD);
  const atr15 = _atrAtLast(_to15m(yard), ATR_PERIOD);
  sig.atr5  = atr5  != null ? _r2(atr5)  : null;
  sig.atr15 = atr15 != null ? _r2(atr15) : null;

  // ── 4. Day sanity: an opening range far wider than normal means the move has
  //       already happened. Fails OPEN when ATR(15m) is not yet seeded. ───────
  if (atr15 != null && atr15 > 0) {
    const ratio = rangePts / atr15;
    if (!tr.check("OR vs ATR15", ratio <= cfg.orAtrMax, `${rangePts}pt = ${ratio.toFixed(2)}×ATR15, max ${cfg.orAtrMax}`)) {
      return done(Object.assign(sig, { reason: `OR ${rangePts}pt = ${ratio.toFixed(2)}×ATR15 > ${cfg.orAtrMax} — open already ran, skip day` }));
    }
  } else { tr.skip("OR vs ATR15", "ATR15 not seeded — fail-open"); }

  // ── 5. Day sanity: an overnight shock far larger than the day's own range is
  //       news, not structure. Fails OPEN when the prior close is unknown. ────
  const gapPts = _computeGap(candles, day);
  sig.gapPts = gapPts;
  if (cfg.gapOrMult > 0 && gapPts != null) {
    if (!tr.check("gap sanity", Math.abs(gapPts) <= cfg.gapOrMult * rangePts, `gap ${gapPts}pt, max ${_r2(cfg.gapOrMult * rangePts)}pt`)) {
      return done(Object.assign(sig, { reason: `Gap ${gapPts}pt > ${cfg.gapOrMult}×OR (${_r2(cfg.gapOrMult * rangePts)}pt) — news/exhaustion gap, skip day` }));
    }
  } else { tr.skip("gap sanity", gapPts == null ? "prior close unknown — fail-open" : "disabled"); }

  // ── 6. The committed breakout: first in-window CLOSE beyond the edge ───────
  const buffer = _r2(Math.max(BUFFER_OR_MULT * rangePts, atr5 != null ? BUFFER_ATR_MULT * atr5 : 0, 1));
  let b = -1, side = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (_istDay(c.time) !== day) continue;
    const m = _istMins(c.time);
    if (m < cfg.orEnd || m >= cfg.entryEnd) continue;
    if (c.close > or.high + buffer) { b = i; side = "CE"; break; }
    if (c.close < or.low  - buffer) { b = i; side = "PE"; break; }
  }
  if (!tr.check("breakout", b >= 0, b >= 0
        ? `${side} — close ${candles[b].close} cleared the edge by ≥${buffer}pt`
        : `close ${last.close} still inside [${_r2(or.low - buffer)}, ${_r2(or.high + buffer)}] (buffer ${buffer}pt)`)) {
    return done(Object.assign(sig, { reason: `No breakout yet — close ${last.close} within [${_r2(or.low - buffer)}, ${_r2(or.high + buffer)}]` }));
  }
  sig.side = side;
  const brk = candles[b];

  if (lastIdx === b) {
    tr.info("confirmation", "this IS the breakout candle — never bought; waiting for the next close");
    return done(Object.assign(sig, { reason: `Breakout ${side} candle formed (close ${brk.close}) — waiting for the next candle to confirm` }));
  }

  // ── 7. Breakout-candle quality: decisive bar, right side of VWAP ───────────
  const vwapAtBrk = computeVwap(candles.slice(0, b + 1));
  if (vwapAtBrk == null) _warnNoVolumeOnce(silent);
  sig.vwap = vwapAtBrk;

  const brkRange = brk.high - brk.low;
  const brkBody  = Math.abs(brk.close - brk.open);
  sig.bodyPct = brkRange > 0 ? _r2(brkBody / brkRange) : null;

  if (!tr.check("candle colour", side === "CE" ? brk.close > brk.open : brk.close < brk.open,
                `${side} needs a ${side === "CE" ? "green" : "red"} breakout bar`)) {
    return done(Object.assign(sig, { reason: `Breakout candle is not ${side === "CE" ? "green" : "red"} — no trade today` }));
  }
  if (atr5 != null) {
    const minBody = cfg.bodyAtrMult * atr5;
    if (!tr.check("decisive body", brkBody >= minBody, `body ${brkBody.toFixed(1)}pt vs ${minBody.toFixed(1)}pt (${cfg.bodyAtrMult}×ATR5)`)) {
      return done(Object.assign(sig, { reason: `Breakout candle body ${brkBody.toFixed(1)}pt < ${minBody.toFixed(1)}pt (${cfg.bodyAtrMult}×ATR5) — not decisive, no trade today` }));
    }
  } else { tr.skip("decisive body", "ATR5 not seeded — fail-open"); }
  if (!tr.check("VWAP side", _vwapSideOk(brk, side, vwapAtBrk), `close ${brk.close} vs VWAP ${vwapAtBrk}`)) {
    return done(Object.assign(sig, { reason: `Breakout close ${brk.close} on the wrong side of VWAP ${vwapAtBrk} — no trade today` }));
  }
  sig.vwapAligned = true;
  sig.wickPass = true;

  // ── 8. Entry construction. The strategy OWNS the stop — routes execute it. ──
  const _fire = (why, tag) => {
    const entrySpot = last.close;
    // Wider of the structural extreme and the ATR floor. See the header note.
    const structural = side === "CE" ? last.low : last.high;
    const atrStop = atr5 != null
      ? (side === "CE" ? entrySpot - cfg.slAtrMult * atr5 : entrySpot + cfg.slAtrMult * atr5)
      : structural;
    const slSpot = side === "CE" ? Math.min(structural, atrStop) : Math.max(structural, atrStop);
    const targetSpot = side === "CE" ? or.high + rangePts * TARGET_OR_MULT : or.low - rangePts * TARGET_OR_MULT;

    if (!silent) {
      const t = new Date(last.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
      console.log(`[ORB ${t}] ENTER ${side}${tag} | ORH=${or.high} ORL=${or.low} range=${rangePts}pt${atr15 ? ` (${(rangePts / atr15).toFixed(2)}×ATR15)` : ""} buf=${buffer} | brk body=${_r2(brkBody)}pt | entry ${_r2(entrySpot)} SL ${_r2(slSpot)} (risk ${_r2(Math.abs(entrySpot - slSpot))}pt) | ${why}`);
    }
    return done(Object.assign(sig, {
      signal: side === "CE" ? "BUY_CE" : "BUY_PE",
      side,
      entrySpot:  _r2(entrySpot),
      slSpot:     _r2(slSpot),
      targetSpot: _r2(targetSpot),
      signalStrength: "STRONG",
      confirmed: true,
      reason: `ORB ${side}${tag}: breakout close ${brk.close} beyond ${side === "CE" ? `ORH ${or.high}` : `ORL ${or.low}`} + buffer ${buffer}pt (body ${_r2(brkBody)}pt), ${why}; SL ${_r2(slSpot)} = wider of candle extreme / ${cfg.slAtrMult}×ATR5${gapPts != null ? `, gap ${gapPts}pt` : ""}`,
    }));
  };

  // ── 9. Primary path: the candle AFTER the breakout must extend the move ────
  const conf = candles[b + 1];
  const confPass = _extends(conf, brk, side, or.high, or.low) && _vwapSideOk(conf, side, computeVwap(candles.slice(0, b + 2)));
  tr.check("confirmation", confPass, side === "CE"
    ? `need close>${or.high}, HH>${brk.high}, HC>${brk.close} — got close ${conf.close} / high ${conf.high}`
    : `need close<${or.low}, LL<${brk.low}, LC<${brk.close} — got close ${conf.close} / low ${conf.low}`);

  if (confPass) {
    if (lastIdx === b + 1) return _fire("confirmation candle extended the move", "");
    return done(Object.assign(sig, { reason: `Breakout already confirmed at candle #${b + 1} — one trade per day, no second attempt` }));
  }

  // ── 10. Fallback: stay armed for a trend-resume or a retest-and-hold ───────
  if (cfg.retestWindow <= 0) {
    return done(Object.assign(sig, { reason: "Confirmation candle did not extend and the retest window is disabled — no trade today" }));
  }
  if (lastIdx === b + 1) {
    tr.info("retest window", `armed for up to ${cfg.retestWindow} candles`);
    return done(Object.assign(sig, { reason: `Confirmation candle did not extend — armed for retest/resume (≤${cfg.retestWindow} candles)` }));
  }
  if (!tr.check("still valid", side === "CE" ? last.close >= or.low : last.close <= or.high,
                `close ${last.close} vs box [${or.low}, ${or.high}]`)) {
    return done(Object.assign(sig, { reason: `Breakout invalidated — close ${last.close} back through the opening range, no trade today` }));
  }
  if (lastIdx > b + 1 + cfg.retestWindow) {
    return done(Object.assign(sig, { reason: "Retest window expired — no trade today" }));
  }

  const vwapNow = computeVwap(candles);
  if (_extends(last, brk, side, or.high, or.low) && _vwapSideOk(last, side, vwapNow)) {
    tr.check("retest window", true, "trend resumed with a fresh extension beyond the edge");
    return _fire("trend resumed with a fresh extension beyond the edge", " [resume]");
  }
  const tol = Math.max(RETEST_TOL_MIN, RETEST_TOL_PCT * rangePts);
  const held = side === "CE"
    ? (last.low  <= or.high + tol && last.close > or.high && _vwapSideOk(last, side, vwapNow))
    : (last.high >= or.low  - tol && last.close < or.low  && _vwapSideOk(last, side, vwapNow));
  if (held) {
    tr.check("retest window", true, `retested ${side === "CE" ? "ORH" : "ORL"} within ${_r2(tol)}pt and held`);
    return _fire(`retested ${side === "CE" ? "ORH" : "ORL"} within ${_r2(tol)}pt and held`, " [retest]");
  }
  tr.info("retest window", `waiting (candle ${lastIdx - b} of ${cfg.retestWindow + 1})`);
  return done(Object.assign(sig, { reason: `Waiting for a retest or resume of ${side === "CE" ? "ORH" : "ORL"} (candle ${lastIdx - b}/${cfg.retestWindow + 1})` }));
}

module.exports = { NAME, DESCRIPTION, getSignal, computeOpeningRange, computeVwap };

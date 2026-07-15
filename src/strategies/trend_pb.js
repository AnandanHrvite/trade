/**
 * TREND PULLBACK — trade WITH an established trend, enter on a healthy pullback
 * that resumes. Single-leg slightly-ITM NIFTY option buying, intraday only.
 * ─────────────────────────────────────────────────────────────────────────────
 * Philosophy (see src/../plans design doc): the first question is "should we
 * trade at all?" — most candles return NONE. We do NOT chase breakouts and do
 * NOT predict reversals. Price STRUCTURE is the primary input; EMA/VWAP/ATR are
 * supporting health filters. Deliberately few free parameters (~7 real knobs).
 *
 * Timeframes (all derived from the 5-min spot candle series the route feeds in):
 *   • 15-min  → trend BIAS (higher-highs/higher-lows structure + EMA20>EMA50 +
 *               EMA20 slope + spot on the right side of session VWAP).
 *   • 5-min   → the pullback + the resumption trigger (the entry candle).
 *
 * Entry (CE / long; PE mirrors inverted), ALL must hold:
 *   A. 15m bias = UP  (structure HH+HL, EMA20>EMA50, EMA20 rising, spot > VWAP)
 *   B. a healthy 5m pullback happened just before now — price dipped back into
 *      the EMA20(5m) zone over ≥ MIN_PULLBACK_BARS candles, WITHOUT falling more
 *      than PULLBACK_MAX_ATR × ATR5 below it (rejects deep / broken pullbacks).
 *   C. resumption candle (the just-closed 5m bar) CLOSES back above EMA20(5m)
 *      AND above the prior candle's high, with body ≥ BODY_ATR_MULT × ATR5.
 *      Body-vs-ATR is the conviction proxy (NIFTY spot has no real volume) — a
 *      decisive close on close, never a wick.
 *
 * Exit is owned by the route (trendPbPaper.js), NOT here — structural stop at the
 * pullback low → breakeven → ATR-chandelier trail on SPOT (the right-tail engine)
 * → EMA20(5m)-close trend-failure → time-stop → EOD → premium disaster backstop.
 * No fixed target, no partial booking.
 *
 * Returns:
 *   { signal: "BUY_CE"|"BUY_PE"|"NONE", side, reason, entrySpot, slSpot,
 *     targetSpot:null, signalStrength, trendBias, vwap, ema5, ema20_15, ema50_15,
 *     atr5, pullbackLow, bodyPts, ... }   slSpot = structural stop (pullback low).
 */

const { EMA, ATR } = require("technicalindicators");

const NAME        = "TREND_PULLBACK";
const DESCRIPTION = "Trend Pullback — 15m bias + 5m pullback/resumption, slightly-ITM CE/PE buying, ATR-trail exits";

// ── time / day helpers (repo convention, mirrors orb_breakout.js) ────────────
function _parseMins(envKey, fallback) {
  const v = (process.env[envKey] || fallback).trim();
  const parts = v.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}
function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _istDayOf(unixSec) { return Math.floor((unixSec + 19800) / 86400); }
function _r2(x) { return Math.round(x * 100) / 100; }

function _hasVolume(c) { return c && typeof c.volume === "number" && c.volume > 0; }

/**
 * Day-anchored session VWAP (09:15 → last candle) on the given candles. Falls
 * back to TWAP when candles carry no volume (indices have no spot volume). The
 * alignment test (close above/below) stays meaningful either way.
 */
function computeVwap(candles) {
  const rangeStartMin = _parseMins("TREND_PB_SESSION_START", "09:15");
  if (!candles || candles.length === 0) return null;
  const day = _istDayOf(candles[candles.length - 1].time);
  let sumPV = 0, sumV = 0, sumP = 0, count = 0, anyVol = false;
  for (const c of candles) {
    if (_istDayOf(c.time) !== day) continue;
    if (_utcSecToIstMins(c.time) < rangeStartMin) continue;
    const tp = (c.high + c.low + c.close) / 3;
    sumP += tp; count++;
    if (_hasVolume(c)) { sumPV += tp * c.volume; sumV += c.volume; anyVol = true; }
  }
  if (count === 0) return null;
  if (anyVol && sumV > 0) return _r2(sumPV / sumV);
  return _r2(sumP / count);
}

// ── indicator value-at-last helpers (technicalindicators) ────────────────────
function _emaAtLast(closes, period) {
  if (!closes || closes.length < period) return null;
  const arr = EMA.calculate({ period, values: closes });
  return arr && arr.length ? arr[arr.length - 1] : null;
}
function _emaSlopeAtLast(closes, period) {
  if (!closes || closes.length < period + 1) return null;
  const arr = EMA.calculate({ period, values: closes });
  if (!arr || arr.length < 2) return null;
  return arr[arr.length - 1] - arr[arr.length - 2];
}
function _atrAtLast(highs, lows, closes, period) {
  if (!closes || closes.length < period + 1) return null;
  const arr = ATR.calculate({ period, high: highs, low: lows, close: closes });
  return arr && arr.length ? arr[arr.length - 1] : null;
}

/**
 * Aggregate 5-min candles into 15-min OHLC buckets (:00/:15/:30/:45 aligned),
 * time-ordered, day-scoped in the key so days never merge. Returns full OHLC+time
 * (open = first 5m bar's open, close = last bar's close) so swing structure and
 * EMA can both be computed on the 15m series.
 */
function to15m(candles) {
  const map = new Map(); const order = [];
  for (const c of candles) {
    const key = _istDayOf(c.time) * 1000 + Math.floor(_utcSecToIstMins(c.time) / 15);
    let b = map.get(key);
    if (!b) { b = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; map.set(key, b); order.push(key); }
    else { if (c.high > b.high) b.high = c.high; if (c.low < b.low) b.low = c.low; b.close = c.close; }
  }
  return order.map(k => map.get(k));
}

/**
 * Confirmed swing pivots on an OHLC series. A pivot HIGH at i needs `L` bars on
 * BOTH sides with strictly lower highs (mirror for lows). The last `L` bars can
 * never be pivots (not enough right-side bars) so this never uses a forming bar.
 * Returns pivot highs/lows as value arrays in chronological order.
 */
function _swings(cands, L) {
  const highs = [], lows = [];
  for (let i = L; i < cands.length - L; i++) {
    let isH = true, isL = true;
    for (let j = i - L; j <= i + L; j++) {
      if (j === i) continue;
      if (cands[j].high >= cands[i].high) isH = false;
      if (cands[j].low  <= cands[i].low)  isL = false;
    }
    if (isH) highs.push(_r2(cands[i].high));
    if (isL) lows.push(_r2(cands[i].low));
  }
  return { highs, lows };
}

function _baseSignal() {
  return {
    signal: "NONE", side: null, reason: "",
    entrySpot: null, slSpot: null, targetSpot: null, signalStrength: null,
    trendBias: null, vwap: null, ema5: null, ema20_15: null, ema50_15: null,
    atr5: null, pullbackLow: null, pullbackHigh: null, bodyPts: null,
    // ORB-compatible fields the shared route/record readers may look for:
    orh: null, orl: null, rangePts: null, vwapAligned: null, volRatio: null,
    volPass: null, wickRatio: null, wickPass: null,
  };
}

/**
 * getSignal(candles, opts) — 5-min IST spot candles WITH multi-day history (so
 * EMA20(15m)/EMA50(15m)/EMA20(5m)/ATR(5m) are seeded before the open). VWAP +
 * today's session are day-scoped internally so prior days never leak.
 * opts: { silent, alreadyTraded }.
 */
function getSignal(candles, opts) {
  const silent = !!(opts && opts.silent);
  const alreadyTraded = !!(opts && opts.alreadyTraded);
  const base = _baseSignal();
  if (!candles || candles.length < 2) {
    return Object.assign(base, { reason: `Warming up (${candles ? candles.length : 0} candles)` });
  }

  const cfg = {
    swingL:       parseInt  (process.env.TREND_PB_SWING_LOOKBACK   || "2", 10),
    emaFast:      parseInt  (process.env.TREND_PB_EMA_FAST         || "20", 10),
    emaSlow:      parseInt  (process.env.TREND_PB_EMA_SLOW         || "50", 10),
    ema5Period:   parseInt  (process.env.TREND_PB_EMA5_PERIOD      || "20", 10),
    atrPeriod:    parseInt  (process.env.TREND_PB_ATR_PERIOD       || "14", 10),
    bodyAtrMult:  parseFloat(process.env.TREND_PB_BODY_ATR_MULT    || "0.5"),
    pbMaxAtr:     parseFloat(process.env.TREND_PB_PULLBACK_MAX_ATR || "1.5"),
    pbWindow:     parseInt  (process.env.TREND_PB_PULLBACK_WINDOW  || "6", 10),
    pbMinBars:    parseInt  (process.env.TREND_PB_MIN_PULLBACK_BARS|| "2", 10),
    pbTouchAtr:   parseFloat(process.env.TREND_PB_PULLBACK_TOUCH_ATR || "0.25"),
    atrFloorPts:  parseFloat(process.env.TREND_PB_ATR_FLOOR_PTS    || "0"),
    vwapOn:       (process.env.TREND_PB_VWAP_FILTER_ENABLED || "true").toLowerCase() === "true",
  };

  const entryStartMin = _parseMins("TREND_PB_ENTRY_START", "09:45");
  const entryEndMin   = _parseMins("TREND_PB_ENTRY_END",   "14:30");
  const last    = candles[candles.length - 1];
  const lastIst = _utcSecToIstMins(last.time);
  const day     = _istDayOf(last.time);

  if (lastIst < entryStartMin) return Object.assign(base, { reason: `Before entry window (${process.env.TREND_PB_ENTRY_START || "09:45"} IST)` });
  if (lastIst >= entryEndMin)  return Object.assign(base, { reason: `Past entry window (${process.env.TREND_PB_ENTRY_END || "14:30"} IST) — no new entries` });
  if (alreadyTraded)           return Object.assign(base, { reason: "Daily trade budget spent — no new entries" });

  // ── Indicators ───────────────────────────────────────────────────────────
  const closes5 = candles.map(c => c.close);
  const highs5  = candles.map(c => c.high);
  const lows5   = candles.map(c => c.low);
  const ema5 = _emaAtLast(closes5, cfg.ema5Period);
  const atr5 = _atrAtLast(highs5, lows5, closes5, cfg.atrPeriod);
  const vwap = computeVwap(candles);
  base.ema5 = ema5 != null ? _r2(ema5) : null;
  base.atr5 = atr5 != null ? _r2(atr5) : null;
  base.vwap = vwap;

  if (ema5 == null || atr5 == null) {
    return Object.assign(base, { reason: `Indicators not seeded (need EMA${cfg.ema5Period}(5m)+ATR${cfg.atrPeriod}) — warming up` });
  }
  if (cfg.atrFloorPts > 0 && atr5 < cfg.atrFloorPts) {
    return Object.assign(base, { reason: `ATR5 ${_r2(atr5)}pt < floor ${cfg.atrFloorPts}pt — range compressed, no juice for buyers (skip)` });
  }

  const c15 = to15m(candles);
  const closes15 = c15.map(c => c.close);
  const ema20_15 = _emaAtLast(closes15, cfg.emaFast);
  const ema50_15 = _emaAtLast(closes15, cfg.emaSlow);
  const slope15  = _emaSlopeAtLast(closes15, cfg.emaFast);
  base.ema20_15 = ema20_15 != null ? _r2(ema20_15) : null;
  base.ema50_15 = ema50_15 != null ? _r2(ema50_15) : null;
  if (ema20_15 == null || ema50_15 == null || slope15 == null) {
    return Object.assign(base, { reason: `15m trend filter not seeded (EMA${cfg.emaFast}/EMA${cfg.emaSlow} need history) — warming up` });
  }

  // ── 15m structure (primary): last two swing highs + lows ─────────────────
  const sw = _swings(c15, cfg.swingL);
  const nH = sw.highs.length, nL = sw.lows.length;
  if (nH < 2 || nL < 2) {
    return Object.assign(base, { reason: `No clean 15m swing structure yet (${nH} highs / ${nL} lows) — trend not established, NO TRADE` });
  }
  const hh = sw.highs[nH - 1] > sw.highs[nH - 2];   // higher high
  const hl = sw.lows[nL - 1]  > sw.lows[nL - 2];     // higher low
  const lh = sw.highs[nH - 1] < sw.highs[nH - 2];    // lower high
  const ll = sw.lows[nL - 1]  < sw.lows[nL - 2];     // lower low

  const vwapUpOk = !cfg.vwapOn || vwap == null || last.close > vwap;
  const vwapDnOk = !cfg.vwapOn || vwap == null || last.close < vwap;

  let bias = null;
  if (hh && hl && ema20_15 > ema50_15 && slope15 > 0 && vwapUpOk) bias = "UP";
  else if (lh && ll && ema20_15 < ema50_15 && slope15 < 0 && vwapDnOk) bias = "DOWN";
  base.trendBias = bias;

  if (!bias) {
    const why = [];
    if (!(hh && hl) && !(lh && ll)) why.push("structure mixed (no HH+HL / LH+LL)");
    if (!(ema20_15 > ema50_15) && !(ema20_15 < ema50_15)) why.push("EMA20≈EMA50 (tangled)");
    if (cfg.vwapOn && vwap != null) why.push(`spot ${_r2(last.close)} vs VWAP ${vwap}`);
    return Object.assign(base, { reason: `No established 15m trend — ${why.join(", ") || "bias unclear"} — NO TRADE` });
  }
  const side = bias === "UP" ? "CE" : "PE";
  base.side = side;
  base.vwapAligned = cfg.vwapOn ? true : null;

  // ── 5m pullback + resumption ─────────────────────────────────────────────
  const n = candles.length;
  const prev = candles[n - 2];
  const body = Math.abs(last.close - last.open);
  base.bodyPts = _r2(body);
  const minBody = cfg.bodyAtrMult * atr5;

  // Resumption trigger on the just-closed candle.
  let resumeOk = false, resumeWhy = "";
  if (side === "CE") {
    if (!(last.close > last.open)) resumeWhy = "resumption candle not green";
    else if (!(body >= minBody)) resumeWhy = `body ${_r2(body)}pt < ${_r2(minBody)}pt (${cfg.bodyAtrMult}×ATR5) — no conviction`;
    else if (!(last.close > ema5)) resumeWhy = `close ${_r2(last.close)} ≤ EMA${cfg.ema5Period}(5m) ${_r2(ema5)} — trend not reclaimed`;
    else if (!(last.close > prev.high)) resumeWhy = `close ${_r2(last.close)} ≤ prior candle high ${_r2(prev.high)} — pullback not broken up`;
    else resumeOk = true;
  } else {
    if (!(last.close < last.open)) resumeWhy = "resumption candle not red";
    else if (!(body >= minBody)) resumeWhy = `body ${_r2(body)}pt < ${_r2(minBody)}pt (${cfg.bodyAtrMult}×ATR5) — no conviction`;
    else if (!(last.close < ema5)) resumeWhy = `close ${_r2(last.close)} ≥ EMA${cfg.ema5Period}(5m) ${_r2(ema5)} — trend not reclaimed`;
    else if (!(last.close < prev.low)) resumeWhy = `close ${_r2(last.close)} ≥ prior candle low ${_r2(prev.low)} — pullback not broken down`;
    else resumeOk = true;
  }

  // Pullback window = the candles just before the resumption candle (today only).
  const from = Math.max(0, n - 1 - cfg.pbWindow);
  const pbBars = [];
  for (let i = from; i < n - 1; i++) {
    if (_istDayOf(candles[i].time) !== day) continue;
    pbBars.push(candles[i]);
  }
  let pullbackOk = false, pbWhy = "", pbLow = null, pbHigh = null;
  if (pbBars.length >= cfg.pbMinBars) {
    pbLow  = _r2(Math.min(...pbBars.map(c => c.low)));
    pbHigh = _r2(Math.max(...pbBars.map(c => c.high)));
    base.pullbackLow = pbLow; base.pullbackHigh = pbHigh;
    // "against-trend" candles = a real pause, not a 1-bar wick.
    const against = pbBars.filter(c => side === "CE" ? c.close < c.open : c.close > c.open).length;
    const touchTol = cfg.pbTouchAtr * atr5;
    if (side === "CE") {
      const touched = pbLow <= ema5 + touchTol;                  // dipped back into the EMA zone
      const notTooDeep = pbLow >= ema5 - cfg.pbMaxAtr * atr5;    // but held (not broken)
      if (against < cfg.pbMinBars) pbWhy = `only ${against} against-trend candle(s) < ${cfg.pbMinBars} — no real pullback`;
      else if (!touched) pbWhy = `pullback low ${pbLow} never reached EMA${cfg.ema5Period}(5m) zone ${_r2(ema5)} (+${_r2(touchTol)}) — no dip to buy`;
      else if (!notTooDeep) pbWhy = `pullback low ${pbLow} > ${cfg.pbMaxAtr}×ATR5 below EMA (${_r2(ema5 - cfg.pbMaxAtr * atr5)}) — too deep/broken`;
      else pullbackOk = true;
    } else {
      const touched = pbHigh >= ema5 - touchTol;
      const notTooDeep = pbHigh <= ema5 + cfg.pbMaxAtr * atr5;
      if (against < cfg.pbMinBars) pbWhy = `only ${against} against-trend candle(s) < ${cfg.pbMinBars} — no real pullback`;
      else if (!touched) pbWhy = `pullback high ${pbHigh} never reached EMA${cfg.ema5Period}(5m) zone ${_r2(ema5)} (−${_r2(touchTol)}) — no rally to sell`;
      else if (!notTooDeep) pbWhy = `pullback high ${pbHigh} > ${cfg.pbMaxAtr}×ATR5 above EMA (${_r2(ema5 + cfg.pbMaxAtr * atr5)}) — too deep/broken`;
      else pullbackOk = true;
    }
  } else {
    pbWhy = `not enough candles before resumption (${pbBars.length} < ${cfg.pbMinBars})`;
  }

  if (!pullbackOk) return Object.assign(base, { reason: `${side} bias ok but no healthy pullback: ${pbWhy}` });
  if (!resumeOk)   return Object.assign(base, { reason: `${side} pullback ok, waiting for resumption: ${resumeWhy}` });

  // ── ALL PASSED → enter on this candle's close ────────────────────────────
  // Structural stop = pullback extreme (route clamps it to a sane band).
  const slSpot = side === "CE" ? pbLow : pbHigh;
  base.signal = side === "CE" ? "BUY_CE" : "BUY_PE";
  base.entrySpot = _r2(last.close);
  base.slSpot = slSpot;
  base.targetSpot = null;                 // no fixed target — right-tail via trailing
  base.signalStrength = "STRONG";
  base.reason = `TREND PB ${side}: 15m ${bias} (HH/HL${side === "CE" ? "" : "→LH/LL"}, EMA20${side === "CE" ? ">" : "<"}EMA50, slope ${side === "CE" ? "up" : "dn"}${vwap != null ? `, spot ${side === "CE" ? ">" : "<"} VWAP ${vwap}` : ""}) → healthy 5m pullback to EMA${cfg.ema5Period} (low ${pbLow}) → resumption close ${_r2(last.close)} beyond prev ${side === "CE" ? "high" : "low"}, body ${_r2(body)}pt ≥ ${_r2(minBody)}pt [STRONG]`;

  if (!silent) {
    const istStr = new Date(last.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    console.log(`[TREND_PB ${istStr}] ENTER ${side} | bias=${bias} EMA20_15=${base.ema20_15}/EMA50_15=${base.ema50_15} | ATR5=${base.atr5} pbLow=${pbLow} | resume close=${_r2(last.close)} body=${_r2(body)}pt SL=${slSpot} [STRONG]`);
  }

  return base;
}

module.exports = { NAME, DESCRIPTION, getSignal, computeVwap, to15m };

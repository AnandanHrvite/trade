/**
 * ORB — Opening Range Breakout (15-minute opening range, single-leg option buy)
 * ─────────────────────────────────────────────────────────────────────────────
 * Two entry engines live here, switched by ORB_ENTRY_V2_ENABLED (default TRUE):
 *
 *   V2 — CONFIRMED-BREAKOUT engine (2026-07-09 redesign) ← DEFAULT
 *     Purpose: kill false breakouts and raise expectancy, NOT raise trade count.
 *     A 5-min close must CLEAR the frozen 09:15–09:30 range by a buffer AND the
 *     breakout candle must be a strong, one-directional bar AND the *next* candle
 *     must extend the move (higher-high / higher-close). Only then do we buy —
 *     one committed breakout attempt per day, no chasing a second break.
 *     Full step-by-step in _getSignalV2 below.
 *
 *   V1 — legacy immediate-entry engine (kept for A/B against the 717-trade
 *     baseline). Buys the breakout candle's own close once it clears the buffer;
 *     wick / VWAP / volume filters only. See _getSignalV1.
 *
 * Exit (handled by route, not signal file) — trend-following model:
 *   • Initial hard SL = the entry candle's own low (CE) / high (PE).
 *   • Breakeven: once favourable by ORB_BREAKEVEN_PTS (20), lift SL to entry.
 *   • EMA trend-trail (ORB_TRAIL_EMA=20): exit only when a candle CLOSES back
 *     across the EMA — lets a winner ride the whole trend.
 *   • Strong opposite reversal candle → exit now.
 *   • Per-trade loss cap ORB_MAX_TRADE_LOSS (₹). Time stop: square-off 15:15 IST.
 *   Exits were NOT changed by the 2026-07-09 entry redesign.
 *
 * Returns (both engines):
 *   { signal, side, reason, orh, orl, rangePts, entrySpot, slSpot, targetSpot,
 *     signalStrength, vwap, vwapAligned, volRatio, volPass, wickRatio, wickPass,
 *     // V2 diagnostics: rsi, adx, emaFast, emaSlow, gapPts, bodyPct, confirmed }
 *   signal:  "BUY_CE" | "BUY_PE" | "NONE"
 */

const { EMA, RSI, ADX, ATR } = require("technicalindicators");

const NAME        = "ORB_15MIN";
const DESCRIPTION = "Opening Range Breakout — 15-min OR, next-candle confirmation, ATM CE/PE buying";

function _parseMins(envKey, fallback) {
  const v = (process.env[envKey] || fallback).trim();
  const parts = v.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function _utcSecToIstMins(unixSec) {
  return Math.floor((unixSec + 19800) / 60) % 1440;
}

// IST calendar-day index (days since epoch, IST). Used to day-scope the opening
// range + VWAP so callers can preload MULTI-DAY history (to seed EMA/RSI/ADX)
// without the prior days' 09:15–09:30 bars leaking into today's OR.
function _istDayOf(unixSec) {
  return Math.floor((unixSec + 19800) / 86400);
}

function _r2(x) { return Math.round(x * 100) / 100; }

function _hasVolume(c) {
  return c && typeof c.volume === "number" && c.volume > 0;
}

let _loggedNoVolumeOnce = false;
function _warnNoVolumeOnce(silent) {
  if (silent || _loggedNoVolumeOnce) return;
  _loggedNoVolumeOnce = true;
  console.log(`[ORB] note: candles carry no volume — VWAP falls back to TWAP, volume filter is skipped (indices have no spot volume; option-side volume not wired in live)`);
}

/**
 * Cumulative session VWAP from 09:15 to last candle. Returns null if no
 * candles in session window. Uses typical-price ((H+L+C)/3) × volume / Σvol.
 * When no candles carry volume, returns the TWAP (equal-weighted typical price)
 * as a fallback — the alignment check (close above/below) is still meaningful.
 */
function computeVwap(candles) {
  const rangeStartMin = _parseMins("ORB_RANGE_START", "09:15");
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
  if (anyVol && sumV > 0) return Math.round((sumPV / sumV) * 100) / 100;
  return Math.round((sumP / count) * 100) / 100;
}

/**
 * Volume ratio: (last candle volume) / (avg of previous N candles' volume).
 * Returns null if any of the candles in the window lack volume.
 */
function computeVolumeRatio(candles, lookback) {
  if (!candles || candles.length < lookback + 1) return null;
  const last = candles[candles.length - 1];
  if (!_hasVolume(last)) return null;
  let sum = 0;
  for (let i = candles.length - 1 - lookback; i < candles.length - 1; i++) {
    if (!_hasVolume(candles[i])) return null;
    sum += candles[i].volume;
  }
  const avg = sum / lookback;
  if (!avg) return null;
  return last.volume / avg;
}

/**
 * Compute the opening range from the first 9:15–9:30 candles in `candles`.
 * Day-scoped to the latest candle's IST day, so multi-day input never leaks a
 * prior day's OR into today. Deterministic from the frozen window — calling it
 * again after 09:30 always returns the same ORH/ORL (STEP 1: never recalculate).
 * Returns null if the range cannot yet be determined (still in OR window).
 */
function computeOpeningRange(candles) {
  const rangeStartMin = _parseMins("ORB_RANGE_START", "09:15");
  const rangeEndMin   = _parseMins("ORB_RANGE_END",   "09:30");
  if (!candles || candles.length === 0) return null;
  const day = _istDayOf(candles[candles.length - 1].time);

  let high = -Infinity;
  let low  =  Infinity;
  let count = 0;
  for (const c of candles) {
    if (_istDayOf(c.time) !== day) continue;
    const m = _utcSecToIstMins(c.time);
    if (m < rangeStartMin || m >= rangeEndMin) continue;
    if (c.high > high) high = c.high;
    if (c.low  < low)  low  = c.low;
    count++;
  }
  if (count === 0 || high === -Infinity) return null;
  return { high: Math.round(high * 100) / 100, low: Math.round(low * 100) / 100, candleCount: count };
}

// ── Indicator helpers (technicalindicators — repo convention) ────────────────
// Each takes a CONTINUOUS (multi-day) close series and returns the value AT the
// last element, or null when there is not enough history to seed it.
function _emaAtLast(closes, period) {
  if (!closes || closes.length < period) return null;
  const arr = EMA.calculate({ period, values: closes });
  return arr && arr.length ? arr[arr.length - 1] : null;
}
function _emaSlopeAtLast(closes, period) {
  // slope over the last completed candle: EMA[n] − EMA[n-1]
  if (!closes || closes.length < period + 1) return null;
  const arr = EMA.calculate({ period, values: closes });
  if (!arr || arr.length < 2) return null;
  return arr[arr.length - 1] - arr[arr.length - 2];
}
function _rsiAtLast(closes, period) {
  if (!closes || closes.length < period + 1) return null;
  const arr = RSI.calculate({ period, values: closes });
  return arr && arr.length ? arr[arr.length - 1] : null;
}
function _adxAtLast(highs, lows, closes, period) {
  if (!closes || closes.length < period * 2) return null;
  const arr = ADX.calculate({ period, high: highs, low: lows, close: closes });
  if (!arr || !arr.length) return null;
  const last = arr[arr.length - 1];
  return (last && typeof last.adx === "number") ? last.adx : null;
}

/**
 * Gap = today's first candle open − previous trading day's last close, using the
 * multi-day preload window. Returns null when the prior day isn't in the window
 * (first day of a backtest range) — caller fail-opens the gap check in that case.
 */
function _computeGap(candles, day) {
  let todayOpen = null, todayOpenTime = Infinity;
  let prevClose = null, prevCloseTime = -Infinity;
  for (const c of candles) {
    const d = _istDayOf(c.time);
    if (d === day) { if (c.time < todayOpenTime) { todayOpenTime = c.time; todayOpen = c.open; } }
    else if (d < day) { if (c.time > prevCloseTime) { prevCloseTime = c.time; prevClose = c.close; } }
  }
  if (todayOpen == null || prevClose == null) return null;
  return _r2(todayOpen - prevClose);
}

function _baseSignal() {
  return {
    signal: "NONE", side: null, orh: null, orl: null, rangePts: null,
    entrySpot: null, slSpot: null, targetSpot: null, signalStrength: null,
    vwap: null, vwapAligned: null, volRatio: null, volPass: null,
    wickRatio: null, wickPass: null,
    rsi: null, adx: null, emaFast: null, emaSlow: null, gapPts: null,
    bodyPct: null, confirmed: null, reason: "",
  };
}

/**
 * STEP 4 — is `c` a strong, one-directional breakout candle for `side`?
 * All ratios are relative to the FULL candle range (high−low), not the body.
 * `vwapAt` / `emaSlope` / `rsi` are the values AS OF this candle (backward-only).
 */
function _breakoutCandleQuality(c, side, vwapAt, emaSlope, rsi, cfg) {
  const range = c.high - c.low;
  if (range <= 0) return { ok: false, why: "flat candle (high=low)" };
  const body      = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const bodyPct   = body / range;
  const relWick   = side === "CE" ? upperWick : lowerWick;
  const wickPct   = relWick / range;
  // distance of close from the favourable extreme, as a fraction of range
  const closePos  = side === "CE" ? (c.high - c.close) / range : (c.close - c.low) / range;

  if (side === "CE" && !(c.close > c.open)) return { ok: false, why: "not a green candle" };
  if (side === "PE" && !(c.close < c.open)) return { ok: false, why: "not a red candle" };
  if (body < cfg.minBody)         return { ok: false, why: `body ${body.toFixed(1)}pt < ${cfg.minBody}pt` };
  if (bodyPct < cfg.bodyPctMin)   return { ok: false, why: `body ${(bodyPct * 100).toFixed(0)}% < ${(cfg.bodyPctMin * 100).toFixed(0)}% of candle` };
  if (wickPct > cfg.wickPctMax)   return { ok: false, why: `${side === "CE" ? "upper" : "lower"} wick ${(wickPct * 100).toFixed(0)}% > ${(cfg.wickPctMax * 100).toFixed(0)}% of candle` };
  if (closePos > cfg.closePosPct) return { ok: false, why: `close not in ${side === "CE" ? "top" : "bottom"} ${(cfg.closePosPct * 100).toFixed(0)}% of candle` };
  if (cfg.vwapOn && vwapAt != null) {
    if (side === "CE" && !(c.close > vwapAt)) return { ok: false, why: `close ${c.close} ≤ VWAP ${vwapAt}` };
    if (side === "PE" && !(c.close < vwapAt)) return { ok: false, why: `close ${c.close} ≥ VWAP ${vwapAt}` };
  }
  if (emaSlope == null) return { ok: false, why: `EMA${cfg.emaFast} slope not seeded (need history)` };
  if (side === "CE" && !(emaSlope > 0)) return { ok: false, why: `EMA${cfg.emaFast} slope ${emaSlope.toFixed(2)} not positive` };
  if (side === "PE" && !(emaSlope < 0)) return { ok: false, why: `EMA${cfg.emaFast} slope ${emaSlope.toFixed(2)} not negative` };
  if (rsi == null) return { ok: false, why: "RSI not seeded (need history)" };
  if (side === "CE" && !(rsi > cfg.rsiCeMin)) return { ok: false, why: `RSI ${rsi.toFixed(1)} ≤ ${cfg.rsiCeMin}` };
  if (side === "PE" && !(rsi < cfg.rsiPeMax)) return { ok: false, why: `RSI ${rsi.toFixed(1)} ≥ ${cfg.rsiPeMax}` };
  return { ok: true, body: _r2(body), bodyPct: _r2(bodyPct), wickPct: _r2(wickPct), closePos: _r2(closePos) };
}

/**
 * STEP 5 — does the candle AFTER the breakout candle extend the move?
 * Bull: stays above ORH (closed back above), makes a higher high AND a higher
 * close than the breakout candle. Bear: mirror below ORL.
 */
function _confirms(conf, brk, side, orh, orl) {
  if (side === "CE") return conf.close > orh && conf.high > brk.high && conf.close > brk.close;
  return conf.close < orl && conf.low < brk.low && conf.close < brk.close;
}

// ═════════════════════════════════════════════════════════════════════════════
// V2 — CONFIRMED-BREAKOUT ENGINE (default)
// ═════════════════════════════════════════════════════════════════════════════
function _getSignalV2(candles, opts) {
  const silent = !!(opts && opts.silent);
  const alreadyTraded = !!(opts && opts.alreadyTraded);
  const base = _baseSignal();

  if (!candles || candles.length < 2) {
    return Object.assign(base, { reason: `Warming up (${candles ? candles.length : 0} candles)` });
  }

  const cfg = {
    minR:        parseFloat(process.env.ORB_MIN_RANGE_PTS      || "30"),
    maxR:        parseFloat(process.env.ORB_MAX_RANGE_PTS      || "80"),
    bufMin:      parseFloat(process.env.ORB_BREAKOUT_BUFFER_MIN || "10"),
    bufPct:      parseFloat(process.env.ORB_BREAKOUT_BUFFER_PCT || "0.20"),
    minBody:     parseFloat(process.env.ORB_MIN_BODY           || "15"),
    bodyPctMin:  parseFloat(process.env.ORB_BODY_PCT_MIN       || "0.60"),
    wickPctMax:  parseFloat(process.env.ORB_WICK_PCT_MAX       || "0.25"),
    closePosPct: parseFloat(process.env.ORB_CLOSE_POS_PCT      || "0.20"),
    emaFast:     parseInt  (process.env.ORB_TREND_EMA_FAST     || "20", 10),
    emaSlow:     parseInt  (process.env.ORB_TREND_EMA_SLOW     || "50", 10),
    adxPeriod:   parseInt  (process.env.ORB_ADX_PERIOD         || "14", 10),
    adxMin:      parseFloat(process.env.ORB_ADX_MIN            || "20"),
    rsiPeriod:   parseInt  (process.env.ORB_RSI_PERIOD         || "14", 10),
    rsiCeMin:    parseFloat(process.env.ORB_RSI_CE_MIN         || "55"),
    rsiPeMax:    parseFloat(process.env.ORB_RSI_PE_MAX         || "45"),
    maxGap:      parseFloat(process.env.ORB_MAX_GAP_PTS        || "80"),
    vwapOn:      (process.env.ORB_VWAP_FILTER_ENABLED || "true").toLowerCase() === "true",
    confirmOn:   (process.env.ORB_CONFIRM_ENABLED     || "true").toLowerCase() === "true",
  };

  // ── Trading window ──────────────────────────────────────────────────────
  const entryStartMin = _parseMins("ORB_RANGE_END", "09:30");   // OR ends → hunting starts
  const entryEndMin   = _parseMins("ORB_ENTRY_END", "12:00");
  const last    = candles[candles.length - 1];
  const lastIst = _utcSecToIstMins(last.time);
  const day     = _istDayOf(last.time);

  if (lastIst < entryStartMin) return Object.assign(base, { reason: `Building opening range (waiting for ${process.env.ORB_RANGE_END || "09:30"} IST)` });
  if (lastIst >= entryEndMin)  return Object.assign(base, { reason: `Past ${process.env.ORB_ENTRY_END || "12:00"} IST — no new ORB entries (stale-breakout window)` });
  if (alreadyTraded)           return Object.assign(base, { reason: "Already traded this session — ORB takes only 1 trade/day" });

  // ── STEP 1: frozen opening range ────────────────────────────────────────
  const or = computeOpeningRange(candles);
  if (!or) return Object.assign(base, { reason: "Opening range not yet formed" });
  const rangePts = _r2(or.high - or.low);
  const orBase = Object.assign(base, { orh: or.high, orl: or.low, rangePts });

  // ── STEP 2 / STEP 7: range must be in the tradable band ─────────────────
  if (rangePts < cfg.minR) return Object.assign(orBase, { reason: `Range too tight (${rangePts}pt < ${cfg.minR}pt) — skip day` });
  if (rangePts > cfg.maxR) return Object.assign(orBase, { reason: `Range too wide (${rangePts}pt > ${cfg.maxR}pt) — open already ran / exhausted, skip day` });

  // ── STEP 7: gap filter (fail-open when prior close unavailable) ──────────
  const gapPts = _computeGap(candles, day);
  orBase.gapPts = gapPts;
  if (cfg.maxGap > 0 && gapPts != null && Math.abs(gapPts) > cfg.maxGap) {
    return Object.assign(orBase, { reason: `Gap ${gapPts}pt > ±${cfg.maxGap}pt — skip day (news/overnight shock)` });
  }

  // ── STEP 3: find the FIRST candle whose CLOSE clears the OR edge by the
  //    buffer. That candle is the ONE committed breakout of the day. We do not
  //    hunt for a second breakout later (STEP 9). ─────────────────────────────
  const buffer = _r2(Math.max(cfg.bufMin, cfg.bufPct * rangePts));
  let b = -1, side = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (_istDayOf(c.time) !== day) continue;
    const m = _utcSecToIstMins(c.time);
    if (m < entryStartMin || m >= entryEndMin) continue;
    if (c.close > or.high + buffer) { b = i; side = "CE"; break; }
    if (c.close < or.low  - buffer) { b = i; side = "PE"; break; }
  }
  if (b < 0) {
    return Object.assign(orBase, { reason: `No breakout yet — close ${last.close} within ORH+${buffer} / ORL−${buffer} band [${_r2(or.low - buffer)}, ${_r2(or.high + buffer)}]` });
  }

  const lastIdx = candles.length - 1;
  if (lastIdx === b) {
    return Object.assign(orBase, { side, reason: `Breakout ${side} candle formed (close ${candles[b].close}) — DO NOT buy the breakout candle; waiting for next candle to confirm` });
  }
  if (lastIdx > b + 1) {
    return Object.assign(orBase, { side, reason: `Breakout resolved earlier (candle #${b}) — 1-trade rule: no second breakout attempt today` });
  }
  // lastIdx === b + 1 → THIS is the confirmation candle. Decide once, now.

  const brk  = candles[b];
  const conf = candles[lastIdx];
  orBase.side = side;

  // ── STEP 4: breakout-candle quality (evaluated on `brk`) ────────────────
  const closesToB = candles.slice(0, b + 1).map(c => c.close);
  const vwapAtBrk = computeVwap(candles.slice(0, b + 1));
  if (vwapAtBrk == null) _warnNoVolumeOnce(silent);
  const slopeAtBrk = _emaSlopeAtLast(closesToB, cfg.emaFast);
  const rsiAtBrk   = _rsiAtLast(closesToB, cfg.rsiPeriod);
  orBase.vwap = vwapAtBrk;
  orBase.rsi  = rsiAtBrk != null ? _r2(rsiAtBrk) : null;

  const q = _breakoutCandleQuality(brk, side, vwapAtBrk, slopeAtBrk, rsiAtBrk, cfg);
  if (!q.ok) {
    return Object.assign(orBase, { reason: `Breakout candle failed quality (${side}): ${q.why} — no trade today` });
  }
  orBase.wickRatio = q.wickPct;   // NOTE: V2 wick metric = relevant wick / candle range
  orBase.wickPass  = true;
  orBase.bodyPct   = q.bodyPct;
  orBase.vwapAligned = cfg.vwapOn ? true : null;

  // ── STEP 5: next-candle confirmation ────────────────────────────────────
  if (cfg.confirmOn && !_confirms(conf, brk, side, or.high, or.low)) {
    const detail = side === "CE"
      ? `need close>${or.high} & HH>${brk.high} & HC>${brk.close}, got close=${conf.close} high=${conf.high}`
      : `need close<${or.low} & LL<${brk.low} & LC<${brk.close}, got close=${conf.close} low=${conf.low}`;
    return Object.assign(orBase, { reason: `Confirmation failed (${side}): ${detail} — no re-entry (1-trade rule)` });
  }

  // ── STEP 6: trend-regime filter (evaluated at the entry candle) ─────────
  const closesAll = candles.map(c => c.close);
  const highsAll  = candles.map(c => c.high);
  const lowsAll   = candles.map(c => c.low);
  const emaF = _emaAtLast(closesAll, cfg.emaFast);
  const emaS = _emaAtLast(closesAll, cfg.emaSlow);
  const adx  = _adxAtLast(highsAll, lowsAll, closesAll, cfg.adxPeriod);
  orBase.emaFast = emaF != null ? _r2(emaF) : null;
  orBase.emaSlow = emaS != null ? _r2(emaS) : null;
  orBase.adx     = adx  != null ? _r2(adx)  : null;

  if (emaF == null || emaS == null || adx == null) {
    return Object.assign(orBase, { reason: `Trend filter not seeded (EMA${cfg.emaFast}/EMA${cfg.emaSlow}/ADX${cfg.adxPeriod} need history) — skip` });
  }
  if (side === "CE" && !(emaF > emaS)) return Object.assign(orBase, { reason: `Trend filter: EMA${cfg.emaFast} ${_r2(emaF)} ≤ EMA${cfg.emaSlow} ${_r2(emaS)} — not an uptrend regime, skip CE` });
  if (side === "PE" && !(emaF < emaS)) return Object.assign(orBase, { reason: `Trend filter: EMA${cfg.emaFast} ${_r2(emaF)} ≥ EMA${cfg.emaSlow} ${_r2(emaS)} — not a downtrend regime, skip PE` });
  if (!(adx > cfg.adxMin))             return Object.assign(orBase, { reason: `Trend filter: ADX ${_r2(adx)} ≤ ${cfg.adxMin} — no directional strength, skip` });

  // ── ALL STEPS PASSED → enter on the confirmation candle's close ─────────
  const entrySpot  = conf.close;
  const slSpot     = side === "CE" ? or.low : or.high;   // reference; route sets real init SL from entry-candle low/high
  const tgtMult    = parseFloat(process.env.ORB_TARGET_RANGE_MULT || "1.5");
  const targetSpot = side === "CE" ? or.high + rangePts * tgtMult : or.low - rangePts * tgtMult;

  if (!silent) {
    const istStr = new Date(conf.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    console.log(`[ORB ${istStr}] CONFIRMED ${side} | ORH=${or.high} ORL=${or.low} range=${rangePts}pt buf=${buffer} | brk close=${brk.close} body=${q.body}pt (${(q.bodyPct * 100).toFixed(0)}%) rsi=${orBase.rsi} | conf close=${conf.close} | EMA${cfg.emaFast}=${orBase.emaFast}>EMA${cfg.emaSlow}=${orBase.emaSlow} adx=${orBase.adx} [STRONG]`);
  }

  return Object.assign(orBase, {
    signal:         side === "CE" ? "BUY_CE" : "BUY_PE",
    side,
    entrySpot:      _r2(entrySpot),
    slSpot:         _r2(slSpot),
    targetSpot:     _r2(targetSpot),
    signalStrength: "STRONG",
    confirmed:      true,
    reason: `ORB CONFIRMED ${side}: brk close ${brk.close} ${side === "CE" ? ">" : "<"} ${side === "CE" ? "ORH" : "ORL"} ${side === "CE" ? or.high : or.low}+buf ${buffer} (body ${q.body}pt/${(q.bodyPct * 100).toFixed(0)}%, wick ${(q.wickPct * 100).toFixed(0)}%, rsi ${orBase.rsi}), next candle ${side === "CE" ? "HH+HC" : "LL+LC"} confirmed, EMA${cfg.emaFast}${side === "CE" ? ">" : "<"}EMA${cfg.emaSlow} adx ${orBase.adx}${gapPts != null ? `, gap ${gapPts}pt` : ""} [STRONG]`,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// V1 — LEGACY IMMEDIATE-ENTRY ENGINE (kept for A/B; ORB_ENTRY_V2_ENABLED=false)
// ═════════════════════════════════════════════════════════════════════════════
function _getSignalV1(candles, opts) {
  const silent = !!(opts && opts.silent);
  const alreadyTraded = !!(opts && opts.alreadyTraded);
  const base = _baseSignal();

  if (!candles || candles.length < 4) {
    return Object.assign({}, base, { reason: `Warming up (${candles ? candles.length : 0}/4 candles)` });
  }

  const entryStartMin = _parseMins("ORB_RANGE_END",   "09:30");
  const entryEndMin   = _parseMins("ORB_ENTRY_END",   "12:00");
  const last = candles[candles.length - 1];
  const lastIst = _utcSecToIstMins(last.time);
  if (lastIst < entryStartMin) {
    return Object.assign({}, base, { reason: `Building opening range (waiting for ${process.env.ORB_RANGE_END || "09:30"} IST)` });
  }
  if (lastIst >= entryEndMin)  {
    return Object.assign({}, base, { reason: `Past ${process.env.ORB_ENTRY_END || "12:00"} IST — no new ORB entries (stale breakout window)` });
  }

  if (alreadyTraded) {
    return Object.assign({}, base, { reason: "Already traded this session — ORB takes only 1 trade/day" });
  }

  const or = computeOpeningRange(candles);
  if (!or) {
    return Object.assign({}, base, { reason: "Opening range not yet formed" });
  }
  const rangePts = Math.round((or.high - or.low) * 100) / 100;
  const minR = parseFloat(process.env.ORB_MIN_RANGE_PTS || "25");
  const maxR = parseFloat(process.env.ORB_MAX_RANGE_PTS || "100");

  const vwap = computeVwap(candles);
  const vwapAligned = (vwap == null) ? null
                    : (last.close > or.high ? last.close > vwap
                    :  last.close < or.low  ? last.close < vwap
                    :  null);
  const volLookback = parseInt(process.env.ORB_VOL_LOOKBACK || "5", 10);
  const volRatio = computeVolumeRatio(candles, volLookback);
  if (volRatio == null) _warnNoVolumeOnce(silent);

  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const minBody = parseFloat(process.env.ORB_MIN_BODY || "8");

  const orBase = Object.assign({}, base, {
    orh: or.high, orl: or.low, rangePts,
    vwap, vwapAligned, volRatio,
  });

  if (rangePts < minR) {
    return Object.assign({}, orBase, { reason: `Range too tight (${rangePts}pt < ${minR}pt) — likely noise, skip` });
  }
  if (rangePts > maxR) {
    return Object.assign({}, orBase, { reason: `Range too wide (${rangePts}pt > ${maxR}pt) — open already moved, skip` });
  }

  const bufMin = parseFloat(process.env.ORB_BREAKOUT_BUFFER_MIN || "8");
  const bufPct = parseFloat(process.env.ORB_BREAKOUT_BUFFER_PCT || "0.15");
  const buffer = Math.round(Math.max(bufMin, bufPct * rangePts) * 100) / 100;
  const bullishBreak = last.close > or.high + buffer && last.close > last.open && body >= minBody;
  const bearishBreak = last.close < or.low  - buffer && last.close < last.open && body >= minBody;

  if (!bullishBreak && !bearishBreak) {
    const aboveH = last.close > or.high;
    const belowL = last.close < or.low;
    let why;
    if (aboveH || belowL) {
      const beyond = aboveH ? (last.close - or.high) : (or.low - last.close);
      why = `Break ${aboveH ? "above ORH" : "below ORL"} by only ${beyond.toFixed(1)}pt < buffer ${buffer}pt (or body ${body.toFixed(1)}pt < ${minBody}pt / against)`;
    } else {
      why = `Close ${last.close} inside range [${or.low}, ${or.high}]`;
    }
    return Object.assign({}, orBase, { reason: why });
  }

  const side = bullishBreak ? "CE" : "PE";

  const wickFilterOn = (process.env.ORB_WICK_FILTER_ENABLED || "true").toLowerCase() === "true";
  const maxWickRatio = parseFloat(process.env.ORB_MAX_WICK_RATIO || "0.6");
  const relevantWick = side === "CE" ? upperWick : lowerWick;
  const wickRatio = body > 0 ? relevantWick / body : 999;
  const wickPass = wickRatio <= maxWickRatio;
  if (wickFilterOn && !wickPass) {
    return Object.assign({}, orBase, {
      wickRatio: Math.round(wickRatio * 100) / 100,
      wickPass:  false,
      reason: `Wick rejection — ${side === "CE" ? "upper" : "lower"} wick ${relevantWick.toFixed(1)}pt vs body ${body.toFixed(1)}pt (ratio ${wickRatio.toFixed(2)} > ${maxWickRatio})`,
    });
  }

  const vwapFilterOn = (process.env.ORB_VWAP_FILTER_ENABLED || "true").toLowerCase() === "true";
  if (vwapFilterOn && vwap != null) {
    const ok = side === "CE" ? last.close > vwap : last.close < vwap;
    if (!ok) {
      return Object.assign({}, orBase, {
        wickRatio: Math.round(wickRatio * 100) / 100,
        wickPass:  true,
        reason: `VWAP misaligned — ${side} break but close ${last.close} ${side === "CE" ? "<=" : ">="} VWAP ${vwap}`,
      });
    }
  }

  const volFilterOn = (process.env.ORB_VOL_FILTER_ENABLED || "false").toLowerCase() === "true";
  const volMult = parseFloat(process.env.ORB_VOL_MULT || "1.2");
  let volPass = null;
  if (volRatio != null) {
    volPass = volRatio >= volMult;
    if (volFilterOn && !volPass) {
      return Object.assign({}, orBase, {
        wickRatio: Math.round(wickRatio * 100) / 100,
        wickPass:  true,
        volPass:   false,
        reason: `Low volume — breakout volume ${volRatio.toFixed(2)}× avg(${volLookback}) < ${volMult}×`,
      });
    }
  }

  const entrySpot  = last.close;
  const slSpot     = side === "CE" ? or.low  : or.high;
  const tgtMult    = parseFloat(process.env.ORB_TARGET_RANGE_MULT || "1.5");
  const targetSpot = side === "CE" ? or.high + rangePts * tgtMult
                                   : or.low  - rangePts * tgtMult;

  const sweetMin   = parseFloat(process.env.ORB_SWEET_MIN || "30");
  const sweetMax   = parseFloat(process.env.ORB_SWEET_MAX || "80");
  const strongBody = parseFloat(process.env.ORB_STRONG_BODY || "15");
  const rangeSweet = rangePts >= sweetMin && rangePts <= sweetMax;
  const bodyStrong = body >= strongBody;
  const volStrong  = volPass !== false && (volRatio == null || volRatio >= volMult * 1.25);
  const wickClean  = wickRatio <= maxWickRatio * 0.6;
  const strength   = (rangeSweet && bodyStrong && volStrong && wickClean) ? "STRONG" : "MARGINAL";

  if (!silent) {
    const istStr = new Date(last.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    const volStr = volRatio != null ? `vol=${volRatio.toFixed(2)}×` : "vol=n/a";
    const vwapStr = vwap != null ? `vwap=${vwap}` : "vwap=n/a";
    console.log(`[ORB ${istStr}] BREAK ${side} | ORH=${or.high} ORL=${or.low} range=${rangePts}pt | close=${last.close} body=${body.toFixed(1)}pt wick=${wickRatio.toFixed(2)} ${vwapStr} ${volStr} [${strength}]`);
  }

  return Object.assign({}, orBase, {
    signal:        side === "CE" ? "BUY_CE" : "BUY_PE",
    side,
    entrySpot:     Math.round(entrySpot * 100) / 100,
    slSpot:        Math.round(slSpot * 100) / 100,
    targetSpot:    Math.round(targetSpot * 100) / 100,
    signalStrength: strength,
    wickRatio:     Math.round(wickRatio * 100) / 100,
    wickPass:      true,
    volPass:       volPass,
    reason: `ORB ${side} break (close ${last.close} ${side === "CE" ? ">" : "<"} ${side === "CE" ? "ORH" : "ORL"} ${side === "CE" ? or.high : or.low} + buffer ${buffer}pt, range=${rangePts}pt, body=${body.toFixed(1)}pt, wick=${wickRatio.toFixed(2)}${vwap != null ? `, vwap=${vwap}` : ""}${volRatio != null ? `, vol=${volRatio.toFixed(2)}×` : ""}) [${strength}]`,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// V3 — TREND-DAY ENGINE (2026-07-10 redesign) ← DEFAULT
//   Goal: capture trend days, kill false breakouts, keep the right tail — NOT
//   trade more. Built for slightly-ITM (~delta 0.6) weekly options.
//   • Adaptive thresholds (ATR-relative) so the gates hold across VIX regimes:
//     OR-size vs ATR(15m), body vs ATR(5m), gap vs OR size — no fixed points.
//   • Day filter: OR-size band + gap sanity + must break into fresh ground
//     (clear prior-day High/Low).
//   • Breakout: first strong 5-min close beyond OR ± an ATR/OR-scaled buffer.
//   • Confirmation: ONE candle (higher-high/higher-close beyond the edge + on the
//     right side of VWAP). The old EMA20/50 + ADX + RSI + EMA-slope stack is GONE
//     (correlated filters that clipped the right tail — see the 2026-07-10 audit).
//   • Retest: OPTIONAL and NON-BLOCKING. It is only a fallback for when the
//     confirmation candle hesitates; a trend that never retests still enters. A
//     mandatory retest measurably HURT expectancy (backtest 2026-07-09), so it can
//     never veto a trend-day entry.
// ═════════════════════════════════════════════════════════════════════════════

// True-range ATR at the last element (technicalindicators). null until seeded.
function _atrAtLast(highs, lows, closes, period) {
  if (!closes || closes.length < period + 1) return null;
  const arr = ATR.calculate({ period, high: highs, low: lows, close: closes });
  return arr && arr.length ? arr[arr.length - 1] : null;
}

// Aggregate 5-min candles into 15-min OHLC buckets (day + :00/:15/:30/:45 aligned),
// time-ordered. Used only to seed ATR(15m) as the opening-range size yardstick.
function _to15m(candles) {
  const map = new Map(); const order = [];
  for (const c of candles) {
    const key = _istDayOf(c.time) * 1000 + Math.floor(_utcSecToIstMins(c.time) / 15);
    let b = map.get(key);
    if (!b) { b = { high: c.high, low: c.low, close: c.close }; map.set(key, b); order.push(key); }
    else { if (c.high > b.high) b.high = c.high; if (c.low < b.low) b.low = c.low; b.close = c.close; }
  }
  return order.map(k => map.get(k));
}

// Prior trading day's High/Low from the multi-day window (day-scoped). null on day 1.
function _priorDayHL(candles, day) {
  let pd = -Infinity;
  for (const c of candles) { const d = _istDayOf(c.time); if (d < day && d > pd) pd = d; }
  if (pd === -Infinity) return null;
  let ph = -Infinity, pl = Infinity;
  for (const c of candles) { if (_istDayOf(c.time) === pd) { if (c.high > ph) ph = c.high; if (c.low < pl) pl = c.low; } }
  return { pdh: _r2(ph), pdl: _r2(pl) };
}

function _vwapSideOk(c, side, vwap) {
  if (vwap == null) return true;
  return side === "CE" ? c.close > vwap : c.close < vwap;
}

// V3 breakout-candle quality — the ONLY entry filters: decisive body (ATR-scaled),
// close in the extreme, VWAP side, and prior-day level cleared (fresh ground).
function _breakoutQualityV3(c, side, atr5, vwapAt, pdhl, cfg) {
  const range = c.high - c.low;
  if (range <= 0) return { ok: false, why: "flat candle (high=low)" };
  const body = Math.abs(c.close - c.open);
  const closePos = side === "CE" ? (c.high - c.close) / range : (c.close - c.low) / range;
  if (side === "CE" && !(c.close > c.open)) return { ok: false, why: "not a green candle" };
  if (side === "PE" && !(c.close < c.open)) return { ok: false, why: "not a red candle" };
  if (atr5 != null) {
    const minBody = cfg.bodyAtrMult * atr5;
    if (body < minBody) return { ok: false, why: `body ${body.toFixed(1)}pt < ${minBody.toFixed(1)}pt (${cfg.bodyAtrMult}×ATR5)` };
  }
  if (closePos > cfg.closePosPct) return { ok: false, why: `close not in ${side === "CE" ? "top" : "bottom"} ${(cfg.closePosPct * 100).toFixed(0)}% of candle` };
  if (cfg.vwapOn && !_vwapSideOk(c, side, vwapAt)) return { ok: false, why: `close ${c.close} on wrong side of VWAP ${vwapAt}` };
  if (cfg.priorDayOn && pdhl) {
    if (side === "CE" && !(c.close > pdhl.pdh)) return { ok: false, why: `close ${c.close} ≤ prior-day high ${pdhl.pdh} (not fresh ground)` };
    if (side === "PE" && !(c.close < pdhl.pdl)) return { ok: false, why: `close ${c.close} ≥ prior-day low ${pdhl.pdl} (not fresh ground)` };
  }
  return { ok: true, body: _r2(body), bodyPct: _r2(body / range), closePos: _r2(closePos) };
}

function _getSignalV3(candles, opts) {
  const silent = !!(opts && opts.silent);
  const alreadyTraded = !!(opts && opts.alreadyTraded);
  const base = _baseSignal();
  if (!candles || candles.length < 2) return Object.assign(base, { reason: `Warming up (${candles ? candles.length : 0} candles)` });

  const cfg = {
    atrPeriod:    parseInt  (process.env.ORB_ATR_PERIOD       || "14", 10),
    orAtrMin:     parseFloat(process.env.ORB_OR_ATR_MIN       || "0.7"),
    orAtrMax:     parseFloat(process.env.ORB_OR_ATR_MAX       || "2.5"),
    gapOrMult:    parseFloat(process.env.ORB_GAP_OR_MULT      || "3.0"),
    bufOrMult:    parseFloat(process.env.ORB_BUFFER_OR_MULT   || "0.15"),
    bufAtrMult:   parseFloat(process.env.ORB_BUFFER_ATR_MULT  || "0.3"),
    bodyAtrMult:  parseFloat(process.env.ORB_BODY_ATR_MULT    || "0.6"),
    closePosPct:  parseFloat(process.env.ORB_CLOSE_POS_PCT    || "0.25"),
    vwapOn:       (process.env.ORB_VWAP_FILTER_ENABLED || "true").toLowerCase() === "true",
    priorDayOn:   (process.env.ORB_PRIORDAY_LEVEL_FILTER || "true").toLowerCase() === "true",
    confirmOn:    (process.env.ORB_CONFIRM_ENABLED     || "true").toLowerCase() === "true",
    retestMode:   (process.env.ORB_RETEST_MODE || "optional").toLowerCase(),   // optional | off
    retestWindow: parseInt  (process.env.ORB_RETEST_MAX_WAIT  || "4", 10),
    retestTolMin: parseFloat(process.env.ORB_RETEST_TOL_MIN   || "5"),
    retestTolPct: parseFloat(process.env.ORB_RETEST_TOL_PCT   || "0.1"),
    tgtMult:      parseFloat(process.env.ORB_TARGET_RANGE_MULT || "1.5"),
  };

  const entryStartMin = _parseMins("ORB_RANGE_END", "09:30");
  const entryEndMin   = _parseMins("ORB_ENTRY_END", "11:30");
  const last    = candles[candles.length - 1];
  const lastIdx = candles.length - 1;
  const lastIst = _utcSecToIstMins(last.time);
  const day     = _istDayOf(last.time);

  if (lastIst < entryStartMin) return Object.assign(base, { reason: `Building opening range (waiting for ${process.env.ORB_RANGE_END || "09:30"} IST)` });
  if (lastIst >= entryEndMin)  return Object.assign(base, { reason: `Past ${process.env.ORB_ENTRY_END || "11:30"} IST — no new ORB entries (stale-breakout window)` });
  if (alreadyTraded)           return Object.assign(base, { reason: "Already traded this session — ORB takes only 1 trade/day" });

  const or = computeOpeningRange(candles);
  if (!or) return Object.assign(base, { reason: "Opening range not yet formed" });
  const rangePts = _r2(or.high - or.low);
  const orBase = Object.assign(base, { orh: or.high, orl: or.low, rangePts });

  const upto = candles.slice(0, lastIdx + 1);   // current-session slice (VWAP uses this)

  // ── Adaptive volatility yardstick, ANCHORED at the OR freeze (09:30) ──────────
  // Compute ATR(5m)/ATR(15m) from data up to the last opening-range candle, NOT the
  // current candle. The OR itself is frozen at 09:30, so its volatility context is
  // frozen too: the OR-size gate, the breakout buffer, and the body-quality check
  // all use ONE stable value for the whole day — no intraday drift, and the fixed
  // breakout candle can never be re-judged by later data.
  let orEndIdx = -1;
  for (let i = 0; i <= lastIdx; i++) {
    if (_istDayOf(candles[i].time) !== day) continue;
    if (_utcSecToIstMins(candles[i].time) < entryStartMin) orEndIdx = i;
  }
  const yard  = orEndIdx >= 0 ? candles.slice(0, orEndIdx + 1) : upto;
  const atr5  = _atrAtLast(yard.map(c => c.high), yard.map(c => c.low), yard.map(c => c.close), cfg.atrPeriod);
  const c15   = _to15m(yard);
  const atr15 = _atrAtLast(c15.map(c => c.high), c15.map(c => c.low), c15.map(c => c.close), cfg.atrPeriod);
  orBase.atr5  = atr5  != null ? _r2(atr5)  : null;
  orBase.atr15 = atr15 != null ? _r2(atr15) : null;

  // ── DAY FILTER 1 — OR size vs ATR(15m). Fail-open if ATR15 not yet seeded. ──
  if (atr15 != null && atr15 > 0) {
    const ratio = rangePts / atr15;
    if (ratio < cfg.orAtrMin) return Object.assign(orBase, { reason: `OR ${rangePts}pt = ${ratio.toFixed(2)}×ATR15 < ${cfg.orAtrMin} — too tight (chop), skip day` });
    if (ratio > cfg.orAtrMax) return Object.assign(orBase, { reason: `OR ${rangePts}pt = ${ratio.toFixed(2)}×ATR15 > ${cfg.orAtrMax} — open already ran / exhausted, skip day` });
  }

  // ── DAY FILTER 2 — gap sanity vs OR size. Fail-open when prior close unknown. ──
  const gapPts = _computeGap(candles, day);
  orBase.gapPts = gapPts;
  if (cfg.gapOrMult > 0 && gapPts != null && Math.abs(gapPts) > cfg.gapOrMult * rangePts) {
    return Object.assign(orBase, { reason: `Gap ${gapPts}pt > ${cfg.gapOrMult}×OR (${_r2(cfg.gapOrMult * rangePts)}pt) — exhaustion/news gap, skip day` });
  }

  const pdhl = _priorDayHL(candles, day);

  // ── BREAKOUT — first day candle whose CLOSE clears OR ± buffer (one/day). ──
  const buffer = _r2(Math.max(cfg.bufOrMult * rangePts, atr5 != null ? cfg.bufAtrMult * atr5 : 0, 1));
  let b = -1, side = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (_istDayOf(c.time) !== day) continue;
    const m = _utcSecToIstMins(c.time);
    if (m < entryStartMin || m >= entryEndMin) continue;
    if (c.close > or.high + buffer) { b = i; side = "CE"; break; }
    if (c.close < or.low  - buffer) { b = i; side = "PE"; break; }
  }
  if (b < 0) return Object.assign(orBase, { reason: `No breakout yet — close ${last.close} within [${_r2(or.low - buffer)}, ${_r2(or.high + buffer)}]` });
  orBase.side = side;

  if (lastIdx === b) return Object.assign(orBase, { reason: `Breakout ${side} candle formed (close ${candles[b].close}) — DO NOT buy it; waiting for confirmation` });

  // ── Breakout-candle quality (evaluated on the breakout candle `brk`) ──
  const brk = candles[b];
  const vwapAtBrk = computeVwap(candles.slice(0, b + 1));
  if (vwapAtBrk == null) _warnNoVolumeOnce(silent);
  orBase.vwap = vwapAtBrk;
  const q = _breakoutQualityV3(brk, side, atr5, vwapAtBrk, pdhl, cfg);
  if (!q.ok) return Object.assign(orBase, { reason: `Breakout candle failed quality (${side}): ${q.why} — no trade today` });
  orBase.bodyPct = q.bodyPct;
  orBase.wickPass = true;
  orBase.vwapAligned = cfg.vwapOn ? true : null;

  // ── Confirmation candle (b+1): HH/HC beyond edge + on the right side of VWAP ──
  const confCandle = candles[b + 1];
  const vwapAtConf = computeVwap(candles.slice(0, b + 2));
  const confPass = !cfg.confirmOn || (_confirms(confCandle, brk, side, or.high, or.low) && _vwapSideOk(confCandle, side, vwapAtConf));

  const tol = Math.max(cfg.retestTolMin, cfg.retestTolPct * rangePts);
  const _entry = (extra, tag) => {
    const entrySpot  = last.close;
    const slSpot     = side === "CE" ? or.low : or.high;   // reference; route sets real init SL from entry-candle low/high
    const targetSpot = side === "CE" ? or.high + rangePts * cfg.tgtMult : or.low - rangePts * cfg.tgtMult;
    if (!silent) {
      const istStr = new Date(last.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
      console.log(`[ORB ${istStr}] V3 ENTER ${side}${tag} | ORH=${or.high} ORL=${or.low} range=${rangePts}pt${atr15 ? ` (${(rangePts / atr15).toFixed(2)}×ATR15)` : ""} buf=${buffer} | brk body=${q.body}pt | ${extra} [STRONG]`);
    }
    return Object.assign(orBase, {
      signal:         side === "CE" ? "BUY_CE" : "BUY_PE",
      side,
      entrySpot:      _r2(entrySpot),
      slSpot:         _r2(slSpot),
      targetSpot:     _r2(targetSpot),
      signalStrength: "STRONG",
      confirmed:      true,
      reason: `ORB V3 ${side}${tag}: brk ${brk.close} beyond ${side === "CE" ? "ORH" : "ORL"} ${side === "CE" ? or.high : or.low}+buf ${buffer} (body ${q.body}pt), ${extra}${gapPts != null ? `, gap ${gapPts}pt` : ""}${pdhl ? `, PDH/PDL ${pdhl.pdh}/${pdhl.pdl}` : ""} [STRONG]`,
    });
  };

  // ── PRIMARY entry: confirmation candle. Early — this is what keeps trend days. ──
  if (confPass) {
    if (lastIdx === b + 1) return _entry("confirmation candle extended (HH/HC beyond edge)", "");
    return Object.assign(orBase, { reason: `Breakout confirmed earlier (candle #${b + 1}) — 1-trade rule, no second attempt today` });
  }

  // ── Confirmation hesitated → OPTIONAL, NON-BLOCKING retest fallback ──
  if (cfg.retestMode === "off") return Object.assign(orBase, { reason: `Confirmation candle didn't extend and retest is OFF — no trade today` });
  if (lastIdx === b + 1)        return Object.assign(orBase, { reason: `Confirmation candle didn't extend — armed for retest (≤${cfg.retestWindow} candles)` });

  const invalidated = side === "CE" ? last.close < or.low : last.close > or.high;
  if (invalidated) return Object.assign(orBase, { reason: `Breakout invalidated (close ${last.close} back through the box) — no trade today` });

  if (lastIdx <= b + 1 + cfg.retestWindow) {
    // Trend resumed with a fresh higher-high beyond the edge → enter promptly.
    if (_confirms(last, brk, side, or.high, or.low) && _vwapSideOk(last, side, computeVwap(upto))) {
      return _entry("trend resumed (fresh HH/HC beyond edge)", " [trend]");
    }
    // Pullback that RETESTED the edge and held → enter.
    const retestHold = side === "CE"
      ? (last.low  <= or.high + tol && last.close > or.high && _vwapSideOk(last, side, computeVwap(upto)))
      : (last.high >= or.low  - tol && last.close < or.low  && _vwapSideOk(last, side, computeVwap(upto)));
    if (retestHold) return _entry(`retest-and-hold of ${side === "CE" ? "ORH" : "ORL"} (tol ${_r2(tol)}pt)`, " [retest]");
    // Window end: never retested but still trending → still enter (don't miss the trend).
    if (lastIdx === b + 1 + cfg.retestWindow) {
      const stillTrending = side === "CE"
        ? (last.close > or.high + buffer && _vwapSideOk(last, side, computeVwap(upto)))
        : (last.close < or.low  - buffer && _vwapSideOk(last, side, computeVwap(upto)));
      if (stillTrending) return _entry("no retest but still trending at window end", " [trend]");
      return Object.assign(orBase, { reason: `Retest window expired and not trending — no trade today` });
    }
    return Object.assign(orBase, { reason: `Waiting for retest/resume of ${side === "CE" ? "ORH" : "ORL"} (candle ${lastIdx - b}/${cfg.retestWindow + 1})` });
  }
  return Object.assign(orBase, { reason: `Retest window expired — no trade today` });
}

/**
 * getSignal(candles, opts) — returns an ORB breakout signal. Dispatches to the
 * V3 trend-day engine (default), the V2 confirmed-breakout engine, or the V1
 * legacy immediate-entry engine, based on ORB_ENTRY_V3_ENABLED / ORB_ENTRY_V2_ENABLED.
 *
 * @param {Array<{time, open, high, low, close, volume?}>} candles — IST-aware 5-min
 *        candles. MUST include prior-day history (multi-day preload) so the engine
 *        can seed ATR(5m)/ATR(15m) + prior-day High/Low; OR + VWAP are day-scoped
 *        internally so the prior days never leak into today's opening range.
 * @param {object} [opts] silent — suppress console.log; alreadyTraded — 1 trade/day guard.
 */
function getSignal(candles, opts) {
  const v3 = (process.env.ORB_ENTRY_V3_ENABLED || "true").toLowerCase() === "true";
  if (v3) return _getSignalV3(candles, opts);
  const v2 = (process.env.ORB_ENTRY_V2_ENABLED || "true").toLowerCase() === "true";
  return v2 ? _getSignalV2(candles, opts) : _getSignalV1(candles, opts);
}

module.exports = { NAME, DESCRIPTION, getSignal, computeOpeningRange, computeVwap, computeVolumeRatio };

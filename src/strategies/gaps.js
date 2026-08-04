/**
 * GAPS — extreme-RSI gap fade on the DAILY chart
 * ─────────────────────────────────────────────────────────────────────────────
 * The whole strategy is two facts about YESTERDAY plus one fact about TODAY'S
 * OPEN. Nothing else. There is deliberately no trend filter, no volume, no ADX,
 * no VWAP, no confirmation candle and no multi-timeframe logic.
 *
 * Indicators — both on the NIFTY **daily** series:
 *   • EMA(GAPS_EMA_LENGTH, default 21) of daily close.
 *   • RSI(GAPS_RSI_LENGTH, default 14) whose INPUT SOURCE is configurable and
 *     defaults to `ema` — i.e. RSI is computed over the EMA21 series, not over
 *     close. This is TradingView's "EMA: EMA" source option: the RSI is plotted
 *     on the EMA line, which double-smooths it so it actually reaches 90 / 10.
 *     Set GAPS_RSI_SOURCE=close for a plain RSI.
 *
 * Entry (evaluated ONCE, at today's open):
 *   PE (short): yesterday's RSI  >  GAPS_RSI_UPPER (default 90)  AND
 *               today's open     <  yesterday's close             (gap DOWN)
 *   CE (long):  yesterday's RSI  <  GAPS_RSI_LOWER (default 10)  AND
 *               today's open     >  yesterday's close             (gap UP)
 *
 * Stop loss  = yesterday's close exactly — the gap-fill level.
 * Target     = the daily EMA21 of the last CLOSED daily candle, taken as a FIXED
 *              price level for the whole session. The route exits when an
 *              intraday candle CLOSES beyond it (see gapsPaper.js). The engine
 *              only publishes the level; it owns no exit logic.
 *
 * "Yesterday" always means the last daily candle that CLOSED strictly before the
 * session day being evaluated — today's forming daily bar is dropped by IST day
 * number, so paper, live, backtest and replay all read the same bar.
 *
 * Returns:
 *   { signal:"BUY_CE"|"BUY_PE"|"NONE", side, reason, skipReason,
 *     entrySpot, slSpot, targetSpot, signalStrength,
 *     prevClose, prevRsi, prevEma, prevDate, todayOpen,
 *     gapPts, gapPct, gapDir, rsiUpper, rsiLower, rsiSource, warmup }
 */

const { EMA, RSI } = require("technicalindicators");

const NAME        = "GAPS";
const DESCRIPTION = "Gaps — daily RSI(EMA21) beyond 90/10 then a next-day gap the other way; stop at the gap fill, target the daily EMA21";

const RSI_SOURCES = ["ema", "close", "open", "high", "low", "hl2", "hlc3", "ohlc4"];

function _r2(x) { return Math.round(x * 100) / 100; }
function _istDayOf(unixSec) { return Math.floor((unixSec + 19800) / 86400); }
function _istDateStr(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Live config read — Settings saves mutate process.env, so never cache this. */
function getConfig() {
  const rawSrc = String(process.env.GAPS_RSI_SOURCE || "ema").trim().toLowerCase();
  return {
    emaLength: Math.max(2, parseInt(process.env.GAPS_EMA_LENGTH || "21", 10) || 21),
    rsiLength: Math.max(2, parseInt(process.env.GAPS_RSI_LENGTH || "14", 10) || 14),
    rsiSource: RSI_SOURCES.includes(rawSrc) ? rawSrc : "ema",
    rsiUpper:  parseFloat(process.env.GAPS_RSI_UPPER || "90"),
    rsiLower:  parseFloat(process.env.GAPS_RSI_LOWER || "10"),
  };
}

/**
 * The RSI input series. `ema` (default) feeds RSI the EMA line itself, which is
 * what TradingView's "EMA: EMA" source does. `offset` is how many leading daily
 * candles the series drops, so callers can map a value back to its candle.
 */
function _sourceSeries(candles, cfg) {
  if (cfg.rsiSource === "ema") {
    const values = EMA.calculate({ period: cfg.emaLength, values: candles.map(c => c.close) });
    return { values, offset: cfg.emaLength - 1, label: `EMA${cfg.emaLength}` };
  }
  const pick = {
    close: c => c.close,
    open:  c => c.open,
    high:  c => c.high,
    low:   c => c.low,
    hl2:   c => (c.high + c.low) / 2,
    hlc3:  c => (c.high + c.low + c.close) / 3,
    ohlc4: c => (c.open + c.high + c.low + c.close) / 4,
  }[cfg.rsiSource];
  return { values: candles.map(pick), offset: 0, label: cfg.rsiSource };
}

/**
 * Daily EMA + RSI as time-aligned series, so the charts on Paper / Backtest /
 * Replay plot exactly the numbers the signal used (no second implementation).
 *
 * Alignment (verified against the technicalindicators package):
 *   EMA(p) over N values → N-p+1 outputs, out[i] ↔ values[i+p-1]
 *   RSI(L) over M values → M-L   outputs, out[j] ↔ values[j+L]
 */
function computeDaily(dailyCandles, cfg) {
  cfg = cfg || getConfig();
  const out = { emaSeries: [], rsiSeries: [], lastEma: null, lastRsi: null, cfg };
  if (!Array.isArray(dailyCandles) || !dailyCandles.length) return out;

  const candles = dailyCandles.slice().sort((a, b) => a.time - b.time);

  const emaArr = EMA.calculate({ period: cfg.emaLength, values: candles.map(c => c.close) });
  for (let i = 0; i < emaArr.length; i++) {
    const c = candles[i + cfg.emaLength - 1];
    if (c) out.emaSeries.push({ time: c.time, value: _r2(emaArr[i]) });
  }

  const src = _sourceSeries(candles, cfg);
  const rsiArr = RSI.calculate({ period: cfg.rsiLength, values: src.values });
  for (let j = 0; j < rsiArr.length; j++) {
    const c = candles[j + cfg.rsiLength + src.offset];
    if (c) out.rsiSeries.push({ time: c.time, value: _r2(rsiArr[j]) });
  }

  out.lastEma = out.emaSeries.length ? out.emaSeries[out.emaSeries.length - 1].value : null;
  out.lastRsi = out.rsiSeries.length ? out.rsiSeries[out.rsiSeries.length - 1].value : null;
  out.sourceLabel = src.label;
  out.minCandles  = cfg.rsiLength + src.offset + 1;
  return out;
}

/**
 * The previous CLOSED daily bar plus its indicator values.
 *
 * @param {Array}  dailyCandles  daily OHLC, any order, may include today.
 * @param {number} sessionDayUnixSec  any unix-sec timestamp inside the session
 *        being evaluated. Every daily candle on that IST day or later is dropped,
 *        so a forming daily bar can never leak into "yesterday".
 */
function getPrevDaySnapshot(dailyCandles, sessionDayUnixSec, cfg) {
  cfg = cfg || getConfig();
  const empty = { ok: false, reason: "", prevClose: null, prevRsi: null, prevEma: null, prevDate: null, closedCount: 0, cfg };
  if (!Array.isArray(dailyCandles) || !dailyCandles.length) {
    return Object.assign(empty, { reason: "No daily candles available" });
  }

  const cutDay = _istDayOf(Number(sessionDayUnixSec) || Math.floor(Date.now() / 1000));
  const closed = dailyCandles
    .filter(c => c && typeof c.close === "number" && _istDayOf(c.time) < cutDay)
    .sort((a, b) => a.time - b.time);

  // Sanity: this MUST be a daily series (at most one bar per IST day). Being
  // handed an intraday series instead is silent poison — EMA21/RSI14 would be
  // computed over 5-min bars and one of them called "yesterday's close", giving
  // decisions that look plausible and are meaningless. Cheap to check, so check
  // it rather than trusting every caller (paper, backtest and the replay
  // harness's candle stubs all feed this).
  for (let i = 1; i < closed.length; i++) {
    if (_istDayOf(closed[i].time) === _istDayOf(closed[i - 1].time)) {
      return Object.assign(empty, {
        closedCount: closed.length,
        reason: `Candle series is NOT daily — ${_istDateStr(closed[i].time)} has more than one bar. Refusing to compute a daily RSI/EMA over intraday candles.`,
      });
    }
  }

  const d = computeDaily(closed, cfg);
  const need = d.minCandles || (cfg.rsiLength + 1);
  if (closed.length < need) {
    return Object.assign(empty, {
      closedCount: closed.length,
      reason: `Warming up — ${closed.length}/${need} closed daily candles needed for RSI(${cfg.rsiLength}) on ${d.sourceLabel || cfg.rsiSource}`,
    });
  }

  const prev = closed[closed.length - 1];
  const lastEmaPt = d.emaSeries.length ? d.emaSeries[d.emaSeries.length - 1] : null;
  const lastRsiPt = d.rsiSeries.length ? d.rsiSeries[d.rsiSeries.length - 1] : null;

  // Both indicator values must belong to the previous bar itself. If the series
  // ends earlier than `prev` the history has a hole — refuse rather than quote a
  // stale RSI as if it were yesterday's.
  if (!lastEmaPt || !lastRsiPt || lastEmaPt.time !== prev.time || lastRsiPt.time !== prev.time) {
    return Object.assign(empty, {
      closedCount: closed.length,
      reason: "Daily indicator series does not end on the previous session — history gap, refusing to quote a stale RSI",
    });
  }

  return {
    ok: true,
    reason: "",
    prevClose: _r2(prev.close),
    prevOpen:  _r2(prev.open),
    prevHigh:  _r2(prev.high),
    prevLow:   _r2(prev.low),
    prevRsi:   lastRsiPt.value,
    prevEma:   lastEmaPt.value,
    prevDate:  _istDateStr(prev.time),
    prevTime:  prev.time,
    closedCount: closed.length,
    sourceLabel: d.sourceLabel,
    emaSeries: d.emaSeries,
    rsiSeries: d.rsiSeries,
    cfg,
  };
}

function _base(cfg) {
  return {
    signal: "NONE", side: null, reason: "", skipReason: "",
    entrySpot: null, slSpot: null, targetSpot: null, signalStrength: null,
    prevClose: null, prevRsi: null, prevEma: null, prevDate: null,
    todayOpen: null, gapPts: null, gapPct: null, gapDir: null,
    rsiUpper: cfg.rsiUpper, rsiLower: cfg.rsiLower,
    rsiSource: cfg.rsiSource, emaLength: cfg.emaLength, rsiLength: cfg.rsiLength,
    warmup: false,
  };
}

/**
 * getSignal(dailyCandles, todayOpen, opts)
 *
 * @param {Array}  dailyCandles  daily OHLC history (today's forming bar allowed).
 * @param {number} todayOpen     today's official 09:15 open.
 * @param {object} opts { sessionDayUnixSec, silent, alreadyTraded, snapshot }
 *        snapshot — a pre-computed getPrevDaySnapshot() result, so a route that
 *        already fetched the daily history does not recompute it on every tick.
 */
function getSignal(dailyCandles, todayOpen, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const base = _base(cfg);

  const snap = o.snapshot || getPrevDaySnapshot(dailyCandles, o.sessionDayUnixSec, cfg);
  if (!snap.ok) {
    base.warmup = true;
    base.skipReason = snap.reason;
    base.reason = snap.reason;
    return base;
  }

  base.prevClose = snap.prevClose;
  base.prevRsi   = snap.prevRsi;
  base.prevEma   = snap.prevEma;
  base.prevDate  = snap.prevDate;

  if (typeof todayOpen !== "number" || !(todayOpen > 0)) {
    base.skipReason = "Today's open not known yet — waiting for the 09:15 open";
    base.reason = base.skipReason;
    return base;
  }

  base.todayOpen = _r2(todayOpen);
  const gapPts = _r2(todayOpen - snap.prevClose);
  base.gapPts  = gapPts;
  base.gapPct  = snap.prevClose ? _r2((gapPts / snap.prevClose) * 100) : null;
  base.gapDir  = gapPts > 0 ? "UP" : gapPts < 0 ? "DOWN" : "FLAT";

  if (o.alreadyTraded) {
    base.skipReason = "Daily trade budget spent — GAPS takes its decision once, at the open";
    base.reason = base.skipReason;
    return base;
  }

  const rsiTxt = `RSI(${cfg.rsiLength} on ${snap.sourceLabel}) ${snap.prevRsi}`;
  const gapTxt = `open ${base.todayOpen} vs prev close ${snap.prevClose} = ${gapPts > 0 ? "+" : ""}${gapPts}pt (${base.gapPct > 0 ? "+" : ""}${base.gapPct}%) ${base.gapDir}`;

  // ── The two setups. Mirror images, nothing else gates them. ────────────────
  const overbought = snap.prevRsi > cfg.rsiUpper;
  const oversold   = snap.prevRsi < cfg.rsiLower;

  if (!overbought && !oversold) {
    base.skipReason = `${snap.prevDate}: ${rsiTxt} is inside the band [${cfg.rsiLower}, ${cfg.rsiUpper}] — not an extreme, no setup`;
    base.reason = base.skipReason;
    return base;
  }

  if (overbought && base.gapDir !== "DOWN") {
    base.skipReason = `${snap.prevDate}: ${rsiTxt} > ${cfg.rsiUpper} (overbought) but ${gapTxt} — needs a gap DOWN for the PE setup`;
    base.reason = base.skipReason;
    return base;
  }
  if (oversold && base.gapDir !== "UP") {
    base.skipReason = `${snap.prevDate}: ${rsiTxt} < ${cfg.rsiLower} (oversold) but ${gapTxt} — needs a gap UP for the CE setup`;
    base.reason = base.skipReason;
    return base;
  }

  const side = overbought ? "PE" : "CE";
  base.side       = side;
  base.signal     = side === "CE" ? "BUY_CE" : "BUY_PE";
  base.entrySpot  = base.todayOpen;
  base.slSpot     = snap.prevClose;   // gap fill, exactly
  base.targetSpot = snap.prevEma;     // daily EMA21 of the last closed bar
  base.signalStrength = "STRONG";
  base.reason =
    `GAPS ${side}: ${snap.prevDate} ${rsiTxt} ${side === "PE" ? `> ${cfg.rsiUpper} (overbought)` : `< ${cfg.rsiLower} (oversold)`} ` +
    `→ ${gapTxt} → BUY ${side} @ ${base.todayOpen} | SL ${base.slSpot} (gap fill) | Target EMA${cfg.emaLength} ${base.targetSpot}`;

  if (!o.silent) {
    console.log(`[GAPS] ENTER ${side} | prev ${snap.prevDate} close=${snap.prevClose} ${rsiTxt} EMA${cfg.emaLength}=${snap.prevEma} | open=${base.todayOpen} gap=${gapPts}pt ${base.gapDir} | SL=${base.slSpot} target=${base.targetSpot}`);
  }
  return base;
}

module.exports = {
  NAME,
  DESCRIPTION,
  RSI_SOURCES,
  getConfig,
  computeDaily,
  getPrevDaySnapshot,
  getSignal,
  _istDayOf,
  _istDateStr,
};

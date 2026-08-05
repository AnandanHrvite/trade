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
 * Entry (evaluated ONCE, at today's open). Note the two halves read DIFFERENT
 * days: the RSI is TODAY's, the gap is measured against YESTERDAY's close.
 *   PE (short): TODAY's RSI   >  GAPS_RSI_UPPER (default 90)  AND
 *               today's open  <  yesterday's close             (gap DOWN)
 *   CE (long):  TODAY's RSI   <  GAPS_RSI_LOWER (default 10)  AND
 *               today's open  >  yesterday's close             (gap UP)
 *
 * Which RSI decides is a toggle: GAPS_RSI_ENTRY_PREV_DAY. Default false uses
 * TODAY's RSI (below); true uses YESTERDAY's closed RSI instead. The gap half is
 * unchanged either way. Meant for A/B'ing the two in paper.
 *
 * "TODAY's RSI" is the daily RSI including today's bar. At 09:15 that bar has
 * only one price — today's open — so it is built from the open. Using the open
 * rather than the live spot is what lets Paper, Live, Backtest and Replay all
 * compute the same number; a live-spot RSI would drift second by second.
 *
 * Stop loss  = the GAP SIZE in points, applied from the actual fill: a PE is
 *              stopped `gap` points ABOVE the fill, a CE `gap` points BELOW.
 *              Filling at the open lands it exactly on yesterday's close (the
 *              gap-fill level); filling later keeps the risk pinned at the gap
 *              instead of letting it drift with the fill.
 * Trail      = EMA(GAPS_TRAIL_EMA_LENGTH, default 21) on the INTRADAY series
 *              (GAPS_EXIT_TF, default 5-min). It is a TRAILING STOP, not a
 *              target: the trade rides as long as price stays on the winning
 *              side of that EMA, and exits when an intraday candle CLOSES back
 *              THROUGH it — a PE exits on a close ABOVE the EMA, a CE on a close
 *              BELOW. Because the EMA is recomputed every candle, the exit level
 *              moves with price. Checked on candle close only, never on a wick.
 *
 * Note the two EMAs are deliberately separate settings. GAPS_EMA_LENGTH is the
 * DAILY EMA that feeds the RSI ("EMA: EMA" source); GAPS_TRAIL_EMA_LENGTH is the
 * INTRADAY EMA the stop trails. Both default to 21, but tuning the RSI smoothing
 * must not silently move the trailing stop.
 *
 * "Yesterday" always means the last daily candle that CLOSED strictly before the
 * session day being evaluated — today's forming daily bar is dropped by IST day
 * number, so paper, live, backtest and replay all read the same bar. Today's RSI
 * is then computed by appending a synthetic bar at today's open to that history.
 *
 * Returns:
 *   { signal:"BUY_CE"|"BUY_PE"|"NONE", side, reason, skipReason,
 *     entrySpot, slSpot, slPts, signalStrength,
 *     prevClose, prevRsi, prevEma, prevDate, todayOpen, todayRsi, todayEma,
 *     gapPts, gapPct, gapDir, rsiUpper, rsiLower, rsiSource, warmup }
 * `todayRsi` is what the entry is judged on; `prevRsi` is kept for reference.
 */

const { EMA, RSI } = require("technicalindicators");

const NAME        = "GAPS";
const DESCRIPTION = "Gaps — TODAY's daily RSI(EMA21) beyond 90/10 with a gap the other way vs yesterday's close; stop = the gap size in points, trail the intraday EMA21";

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
    // Which daily RSI decides the entry. Default false → TODAY's RSI (the series
    // extended with today's open). true → the PREVIOUS day's closed RSI. A toggle
    // so the two can be A/B'd in paper before either is trusted.
    rsiEntryPrevDay: String(process.env.GAPS_RSI_ENTRY_PREV_DAY || "false").toLowerCase() === "true",
    // Intraday trailing stop — a separate EMA from the daily one above.
    trailLength:  Math.max(2, parseInt(process.env.GAPS_TRAIL_EMA_LENGTH || "21", 10) || 21),
    trailEnabled: String(process.env.GAPS_TRAIL_ENABLED || "true").toLowerCase() === "true",
  };
}

/**
 * The intraday trailing-stop EMA, as a time-aligned series so the chart plots
 * exactly the line the exit used.
 *
 * `candles` must be the intraday series (GAPS_EXIT_TF bars) ending with the bar
 * just CLOSED. Returns `last: null` while fewer than `length` bars exist — the
 * caller must treat that as "no trail yet", never as a level of 0.
 */
function computeTrailEma(candles, length) {
  const len = Math.max(2, parseInt(length, 10) || 21);
  const out = { series: [], last: null, length: len, warmup: true };
  if (!Array.isArray(candles) || candles.length < len) return out;

  const bars = candles
    .filter(c => c && typeof c.close === "number" && typeof c.time === "number")
    .sort((a, b) => a.time - b.time);
  if (bars.length < len) return out;

  const arr = EMA.calculate({ period: len, values: bars.map(c => c.close) });
  for (let i = 0; i < arr.length; i++) {
    const c = bars[i + len - 1];
    if (c) out.series.push({ time: c.time, value: _r2(arr[i]) });
  }
  if (out.series.length) { out.last = out.series[out.series.length - 1].value; out.warmup = false; }
  return out;
}

/**
 * The base stop, applied to whatever price we ACTUALLY filled at.
 *
 * The stop is the gap SIZE (`slPts`), so a PE — taken after a gap down — is
 * stopped that many points ABOVE the fill, and a CE that many points BELOW.
 * Filling at the open makes this land exactly on yesterday's close, which is
 * the gap-fill level; filling later keeps the risk pinned at the gap rather
 * than letting it grow with the fill.
 */
function stopFromFill(side, fillSpot, slPts) {
  // Deliberately NOT Number(): Number(null) is 0 and Number("") is 0, so a
  // missing fill price would silently become a stop of `slPts` — a level the
  // market is already miles past, i.e. an instant stop-out on the first tick.
  if (typeof fillSpot !== "number" || !Number.isFinite(fillSpot)) return null;
  if (typeof slPts    !== "number" || !Number.isFinite(slPts))    return null;
  const pts = Math.abs(slPts);
  return _r2(side === "PE" ? fillSpot + pts : fillSpot - pts);
}

/**
 * The trailing-stop rule itself — the ONE place it is written down, so paper,
 * live, backtest and replay cannot drift apart.
 *
 * A PE is a bet on a fall, so it is stopped out when price closes back ABOVE the
 * trail; a CE is stopped when price closes BELOW it. Returns false whenever the
 * trail has not warmed up, which leaves the gap-size stop as the only exit.
 */
function trailExitHit(side, barClose, trailValue) {
  if (typeof barClose !== "number" || typeof trailValue !== "number") return false;
  if (side === "PE") return barClose > trailValue;
  if (side === "CE") return barClose < trailValue;
  return false;
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
    closedCandles: closed,
    cfg,
  };
}

/**
 * TODAY's daily RSI — the value the entry is judged on.
 *
 * The rule reads the CURRENT day's RSI, not yesterday's. At 09:15 today's daily
 * candle has only just opened, so the one price it has is today's open: this
 * appends a synthetic daily bar at `todayOpen` and recomputes EMA + RSI over the
 * closed history plus that bar.
 *
 * Using the OPEN rather than the live spot is deliberate. It is the price the
 * whole decision is already based on, it is fixed the moment the market opens,
 * and it makes Paper, Live, Backtest and Replay compute the identical number —
 * a live-spot RSI would drift second by second and could never be reproduced.
 *
 * Returns { ok, rsi, ema, reason }.
 */
function computeTodayRsi(closedCandles, todayOpen, sessionDayUnixSec, cfg) {
  cfg = cfg || getConfig();
  if (!Array.isArray(closedCandles) || !closedCandles.length) {
    return { ok: false, rsi: null, ema: null, reason: "No closed daily candles to extend" };
  }
  if (typeof todayOpen !== "number" || !(todayOpen > 0)) {
    return { ok: false, rsi: null, ema: null, reason: "Today's open not known yet" };
  }

  const prev = closedCandles[closedCandles.length - 1];
  // Put the synthetic bar on today's IST day so it can never collide with the
  // last closed one (which would make the series non-daily).
  const todayTime = Number.isFinite(Number(sessionDayUnixSec))
    ? Number(sessionDayUnixSec)
    : prev.time + 86400;
  if (_istDayOf(todayTime) <= _istDayOf(prev.time)) {
    return { ok: false, rsi: null, ema: null, reason: "Session day is not after the last closed daily candle" };
  }

  const withToday = closedCandles.concat([{
    time: todayTime, open: todayOpen, high: todayOpen, low: todayOpen, close: todayOpen,
  }]);

  const d = computeDaily(withToday, cfg);
  const lastRsi = d.rsiSeries.length ? d.rsiSeries[d.rsiSeries.length - 1] : null;
  const lastEma = d.emaSeries.length ? d.emaSeries[d.emaSeries.length - 1] : null;
  if (!lastRsi || !lastEma || lastRsi.time !== todayTime || lastEma.time !== todayTime) {
    return { ok: false, rsi: null, ema: null, reason: "Daily indicator series does not reach today's bar" };
  }
  return { ok: true, rsi: lastRsi.value, ema: lastEma.value, reason: "", sourceLabel: d.sourceLabel };
}

function _base(cfg) {
  return {
    signal: "NONE", side: null, reason: "", skipReason: "",
    entrySpot: null, slSpot: null, slPts: null, signalStrength: null,
    prevClose: null, prevRsi: null, prevEma: null, prevDate: null,
    todayOpen: null, todayRsi: null, todayEma: null,
    gapPts: null, gapPct: null, gapDir: null,
    rsiUpper: cfg.rsiUpper, rsiLower: cfg.rsiLower,
    rsiSource: cfg.rsiSource, emaLength: cfg.emaLength, rsiLength: cfg.rsiLength,
    rsiEntryPrevDay: cfg.rsiEntryPrevDay, decideRsi: null,
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

  // TODAY's RSI — the current day's value, extended with today's open. Still
  // computed for display even in prev-day mode. The GAP always measures against
  // YESTERDAY's close, which is the other half of the rule (from the snapshot).
  const usePrev = cfg.rsiEntryPrevDay === true;
  const today = computeTodayRsi(snap.closedCandles, todayOpen, o.sessionDayUnixSec, cfg);
  if (today.ok) {
    base.todayRsi = today.rsi;
    base.todayEma = today.ema;
  } else if (!usePrev) {
    // Only fatal when today's RSI is the deciding value — in prev-day mode the
    // snapshot already gave us a validated prevRsi, so a failed today-extend
    // must not block the trade.
    base.warmup = true;
    base.skipReason = `Cannot compute today's daily RSI — ${today.reason}`;
    base.reason = base.skipReason;
    return base;
  }

  // Which RSI drives the decision. base.prevRsi is guaranteed by snap.ok above.
  const decideRsi = usePrev ? base.prevRsi : base.todayRsi;
  base.decideRsi  = decideRsi;
  const rsiWhich  = usePrev ? "prev-day" : "today's";

  if (o.alreadyTraded) {
    base.skipReason = "Daily trade budget spent — GAPS takes its decision once, at the open";
    base.reason = base.skipReason;
    return base;
  }

  const rsiTxt = `${rsiWhich} RSI(${cfg.rsiLength} on ${snap.sourceLabel}) ${decideRsi}`;
  const gapTxt = `open ${base.todayOpen} vs prev close ${snap.prevClose} = ${gapPts > 0 ? "+" : ""}${gapPts}pt (${base.gapPct > 0 ? "+" : ""}${base.gapPct}%) ${base.gapDir}`;

  // ── The two setups. Mirror images, nothing else gates them. ────────────────
  const overbought = decideRsi > cfg.rsiUpper;
  const oversold   = decideRsi < cfg.rsiLower;

  if (!overbought && !oversold) {
    base.skipReason = `${rsiTxt} is inside the band [${cfg.rsiLower}, ${cfg.rsiUpper}] — not an extreme, no setup`;
    base.reason = base.skipReason;
    return base;
  }

  if (overbought && base.gapDir !== "DOWN") {
    base.skipReason = `${rsiTxt} > ${cfg.rsiUpper} (overbought) but ${gapTxt} — needs a gap DOWN for the PE setup`;
    base.reason = base.skipReason;
    return base;
  }
  if (oversold && base.gapDir !== "UP") {
    base.skipReason = `${rsiTxt} < ${cfg.rsiLower} (oversold) but ${gapTxt} — needs a gap UP for the CE setup`;
    base.reason = base.skipReason;
    return base;
  }

  const side = overbought ? "PE" : "CE";
  base.side       = side;
  base.signal     = side === "CE" ? "BUY_CE" : "BUY_PE";
  base.entrySpot  = base.todayOpen;
  // The GAP SIZE is the base stop — a DISTANCE, not a fixed level. Filling at
  // the open puts it exactly on yesterday's close (open ± gap == prev close);
  // filling a little later keeps the risk pinned at the gap instead of letting
  // it drift with the fill. Each surface applies it via stopFromFill().
  base.slPts      = Math.abs(gapPts);
  base.slSpot     = stopFromFill(side, base.todayOpen, base.slPts);
  base.signalStrength = "STRONG";
  const trailTxt = cfg.trailEnabled ? `trail EMA${cfg.trailLength} (intraday close-through)` : "trail DISABLED";
  base.reason =
    `GAPS ${side}: ${rsiTxt} ${side === "PE" ? `> ${cfg.rsiUpper} (overbought)` : `< ${cfg.rsiLower} (oversold)`} ` +
    `→ ${gapTxt} → BUY ${side} @ ${base.todayOpen} | SL ${base.slPts}pt (the gap) → ${base.slSpot} | ${trailTxt}`;

  if (!o.silent) {
    console.log(`[GAPS] ENTER ${side} | prev ${snap.prevDate} close=${snap.prevClose} ${rsiTxt} EMA${cfg.emaLength}=${snap.prevEma} | open=${base.todayOpen} gap=${gapPts}pt ${base.gapDir} | SL=${base.slPts}pt → ${base.slSpot} | ${trailTxt}`);
  }
  return base;
}

module.exports = {
  NAME,
  DESCRIPTION,
  RSI_SOURCES,
  getConfig,
  computeDaily,
  computeTrailEma,
  computeTodayRsi,
  trailExitHit,
  stopFromFill,
  getPrevDaySnapshot,
  getSignal,
  _istDayOf,
  _istDateStr,
};

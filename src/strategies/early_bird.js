/**
 * EARLYBIRD — first-15-minute signal candle, NIFTY-confirmed, traded in CASH EQUITY
 * ═════════════════════════════════════════════════════════════════════════════
 * This is the ONLY place EarlyBird's rules exist. Paper, Backtest, Live and
 * Replay all call into this file; no route re-implements any of it.
 *
 * ── WHAT MAKES THIS STRATEGY DIFFERENT FROM EVERY OTHER ONE IN THIS REPO ────
 * Every other engine here buys a single NIFTY OPTION. EarlyBird does not.
 * It trades the CASH EQUITY of F&O stocks, 100 qty per position, INTRADAY
 * product type, and it can hold several positions at once. Consequences that
 * are load-bearing and must not be "tidied away" by someone copying a template:
 *
 *   • There is no strike, no expiry, no option LTP, no ITM_STEPS. A helpful
 *     edit that reintroduces `fetchOptionLtp` here is a bug, not an upgrade.
 *   • P&L is (exit − entry) × qty for a LONG, and (entry − exit) × qty for a
 *     SHORT. A short here is a real intraday short sale in the cash segment.
 *   • NIFTY itself is NEVER traded. The index is a FILTER — it decides whether
 *     the day is a buy day or a sell day, and nothing more.
 *
 * ── THE DAY, IN SIX RULES ───────────────────────────────────────────────────
 *
 *  1. THE SIGNAL CANDLE IS THE DAY'S FIRST 15-MINUTE CANDLE — 09:15→09:30.
 *     Both for NIFTY and for every stock. This engine reads ONE bar per symbol
 *     per day and never re-evaluates it. That is what "EarlyBird" means: the
 *     decision is made at 09:30 and the rest of the day only executes it.
 *
 *  2. NIFTY MUST PRINT A SIGNAL CANDLE (the user's image 2 / image 15).
 *     Three shapes count, and they are the same three for both directions:
 *
 *       BULLISH (→ we look to BUY stocks)
 *         1. Full-body green candle — no wick either side.
 *         2. Green candle with a long LOWER wick and no upper wick
 *            (buyers rejected lower prices).
 *         3. Green candle with a small upper wick and a long lower wick.
 *
 *       BEARISH (→ we look to SHORT stocks)
 *         1. Full-body red candle — no wick either side.
 *         2. Red candle with a long UPPER wick and no lower wick.
 *         3. Red candle with a small lower wick and a long upper wick.
 *
 *     Mechanically, all three collapse to ONE test, which is what this engine
 *     implements — a candle qualifies when the wick AGAINST the move is small
 *     and the body is real:
 *
 *       GREEN: close > open
 *              upper wick (high − close) ≤ EARLYBIRD_MAX_OPPOSING_WICK_PCT of range
 *              body (close − open)       ≥ EARLYBIRD_MIN_BODY_PCT of range
 *       RED:   close < open
 *              lower wick (open − low)   ≤ EARLYBIRD_MAX_OPPOSING_WICK_PCT of range
 *              body (open − close)       ≥ EARLYBIRD_MIN_BODY_PCT of range
 *
 *     Wicks are measured as a PERCENTAGE OF THE CANDLE'S RANGE so the same
 *     tolerance means the same thing on a 30-point NIFTY bar and a 900-rupee
 *     stock bar. Defaults are 30% opposing wick and 40% body — i.e. "mostly
 *     one-directional", which is what all three drawings share. Exact-zero
 *     wick was NOT used as the default: on real 15-minute data a literally
 *     wickless index candle is close to nonexistent, and a rule that fires
 *     twice a year cannot be evaluated.
 *
 *  3. AT LEAST N STOCKS MUST AGREE. Every symbol in the universe is scanned;
 *     a stock confirms when its OWN first 15-minute candle passes the exact
 *     same shape test in the SAME direction as NIFTY. Default N = 1
 *     (EARLYBIRD_MIN_CONFIRMING_STOCKS) — the user's rule is "the stock has to
 *     make a similar pattern like nifty", so one is enough to justify trading
 *     that stock. Raising N turns it into a market-breadth gate.
 *
 *  4. THE 2% GAP RULE. A stock whose 09:15 OPEN is more than
 *     EARLYBIRD_MAX_GAP_PCT (default 2) away from the PREVIOUS DAY'S CLOSE is
 *     dropped, in either direction. This needs the previous daily close, so the
 *     scan is handed a `prevClose` per symbol; a stock with no prevClose is
 *     dropped rather than guessed at, because "unknown gap" is not "no gap".
 *
 *  5. ENTRY / STOP / TARGET — all read off the stock's OWN signal candle, and
 *     all are LEVELS frozen at the moment the setup is built. They never move.
 *
 *       LONG   entry = signal candle HIGH + buffer
 *              stop  = signal candle LOW  − buffer
 *       SHORT  entry = signal candle LOW  − buffer
 *              stop  = signal candle HIGH + buffer
 *
 *     buffer = EARLYBIRD_ENTRY_BUFFER_PTS (default 5), in RUPEES, applied to
 *     both ends — the user's "a little above the breakout candle" for entry and
 *     "same, a little above" for the stop.
 *
 *     TARGET = a 1:2 reward-to-risk multiple of the ACTUAL risk:
 *              risk = |entry − stop|
 *              LONG  target = entry + risk × EARLYBIRD_TARGET_RR
 *              SHORT target = entry − risk × EARLYBIRD_TARGET_RR
 *     EARLYBIRD_TARGET_RR defaults to 2. The user said 1:1 is also acceptable
 *     in some cases, so this is a single number they can lower to 1 without a
 *     code change. It is deliberately NOT two separate partial-exit legs —
 *     they did not ask for partials, and inventing them would change the
 *     strategy's whole risk profile.
 *
 *  6. THE BIG-CANDLE STOP RULE (the user's NOTE). If the wick-to-wick risk
 *     exceeds EARLYBIRD_MAX_SL_PTS (default 60, expressed in RUPEES of stock
 *     price), the stop moves OFF the wick and onto the candle's BODY edge:
 *
 *       LONG   stop = min(open, close) − buffer     ← body bottom, not the low
 *       SHORT  stop = max(open, close) + buffer     ← body top, not the high
 *
 *     This can only ever TIGHTEN the stop, never widen it, because the body is
 *     always inside the wick. It is applied BEFORE the target is computed, so a
 *     body-edge stop produces a correspondingly nearer 1:2 target — the R
 *     multiple is honoured against the risk actually taken.
 *
 *     `bigCandle: true` is reported on the setup so the UI and the logs can say
 *     out loud which rule produced the stop.
 *
 * ── ENTRY FILL, DECIDED ONCE FOR ALL FOUR MODES ─────────────────────────────
 * The signal is known at 09:30. The entry is a PENDING STOP ORDER at the level
 * above: it triggers the first time price trades through it, any time inside
 * the entry window. So —
 *
 *   Paper + Live : the first tick at or beyond the entry level fills, AT THE
 *                  LEVEL (plus slippage). Not at the tick price — a 40-rupee
 *                  tick gap would otherwise hand the backtest a fill the live
 *                  market never offered.
 *   Backtest     : a 15-minute bar whose high ≥ entry (LONG) fills at the
 *                  entry level. Same market moment, same price.
 *
 * These are the same event described in two data resolutions, which is what
 * keeps Paper ≡ Backtest ≡ Replay.
 *
 * ── ORDERING INSIDE ONE BAR (backtest realism) ──────────────────────────────
 * When a single bar could have hit both the stop and the target, the STOP is
 * taken. A 15-minute bar cannot tell us which came first, and assuming the good
 * one is how backtests flatter themselves. Same reason a bar that OPENS beyond
 * the stop fills at the open, never at the better stop level.
 *
 * ── TIME RULES ──────────────────────────────────────────────────────────────
 *   09:30  earliest possible entry (the signal candle has just closed)
 *   10:45  EARLYBIRD_ENTRY_END — no new entries after this (user's rule)
 *   13:00  EARLYBIRD_FORCED_EXIT — everything still open is squared off
 * A position that has not hit stop or target by 13:00 exits at the market.
 *
 * ── DELIBERATELY NOT IMPLEMENTED (the user did not ask; do not "add") ───────
 *   • No VIX gate, no OI gate, no ADX, no RSI, no moving average, no volume
 *     filter, no confirmation candle, no multi-timeframe check.
 *   • No trailing stop and no breakeven shift — the stop is frozen for the
 *     life of the trade.
 *   • No partial exits / scaling out.
 *   • No re-entry. One attempt per stock per day; if it stops out, that stock
 *     is done for the day.
 *   • No position sizing by risk — a flat EARLYBIRD_QTY (default 100) per
 *     stock, exactly as specified.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── small shared helpers (same semantics as every other engine here) ────────
function _r2(x) { return Math.round(x * 100) / 100; }
function _num(x) { return typeof x === "number" && Number.isFinite(x); }

/** IST calendar-day index. India has no DST, so a fixed +5:30 shift is exact. */
function _istDayOf(unixSec) { return Math.floor((unixSec + 19800) / 86400); }

/** IST minutes-of-day from a unix-SECONDS candle time. */
function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }

function _istDateStr(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function _fmtMins(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function _parseHHMM(raw, def) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(raw == null ? "" : raw));
  if (!m) return def;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return def;
  return h * 60 + mm;
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

function _boolEnv(key, def) {
  const raw = process.env[key];
  if (raw == null || raw === "") return def;
  const s = String(raw).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return def;
}

function _okBar(c) {
  return !!c && _num(c.open) && _num(c.high) && _num(c.low) && _num(c.close);
}

// ─────────────────────────────────────────────────────────────────────────────
// Config — read live from process.env on EVERY call. Never cache: the Settings
// page writes process.env at runtime and a cached config would serve stale
// numbers to the strategy while the UI showed the new ones.
// ─────────────────────────────────────────────────────────────────────────────
function getConfig() {
  return {
    // Timeframe. The rules were read off a 15-minute chart; the repo-wide
    // 5-minute default does not apply to this strategy.
    resolutionMins:   _intEnv("EARLYBIRD_RESOLUTION", 15, 1, 60),
    sessionStartMin:  _parseHHMM(process.env.EARLYBIRD_SESSION_START, 9 * 60 + 15),

    // Windows
    entryStartMin:    _parseHHMM(process.env.EARLYBIRD_ENTRY_START,   9 * 60 + 30),
    entryEndMin:      _parseHHMM(process.env.EARLYBIRD_ENTRY_END,    10 * 60 + 45),
    forcedExitMin:    _parseHHMM(process.env.EARLYBIRD_FORCED_EXIT,  13 * 60),

    // Signal-candle shape (applies identically to NIFTY and to each stock)
    maxOpposingWickPct: _numEnv("EARLYBIRD_MAX_OPPOSING_WICK_PCT", 30, 0, 100),
    minBodyPct:         _numEnv("EARLYBIRD_MIN_BODY_PCT", 40, 0, 100),
    minRangePts:        _numEnv("EARLYBIRD_MIN_RANGE_PTS", 0, 0),

    // Confirmation
    minConfirmingStocks: _intEnv("EARLYBIRD_MIN_CONFIRMING_STOCKS", 1, 1, 500),

    // The 2% gap rule
    maxGapPct:        _numEnv("EARLYBIRD_MAX_GAP_PCT", 2, 0, 100),

    // Entry / stop / target
    entryBufferPts:   _numEnv("EARLYBIRD_ENTRY_BUFFER_PTS", 5, 0),
    targetRR:         _numEnv("EARLYBIRD_TARGET_RR", 2, 0.1, 20),
    maxSlPts:         _numEnv("EARLYBIRD_MAX_SL_PTS", 60, 0),

    // Sizing + exposure
    qty:              _intEnv("EARLYBIRD_QTY", 100, 1, 100000),
    maxConcurrent:    _intEnv("EARLYBIRD_MAX_CONCURRENT", 5, 1, 50),

    // Universe
    universe:         String(process.env.EARLYBIRD_UNIVERSE || "FNO").trim().toUpperCase(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// classifyCandle — the ONE shape test, used for NIFTY and for every stock.
//
// Returns a full explanation object every time, never a bare boolean, because
// the whole funnel is logged: the user wants to see WHY each of ~220 symbols
// was accepted or rejected, and a boolean cannot say that.
// ─────────────────────────────────────────────────────────────────────────────
function classifyCandle(candle, opts) {
  const cfg = (opts && opts.cfg) || getConfig();
  const out = {
    ok: false, direction: null, reason: "",
    open: null, high: null, low: null, close: null,
    range: null, bodyPct: null, opposingWickPct: null, favourableWickPct: null,
    shape: null,
  };

  if (!_okBar(candle)) {
    out.reason = "candle has no usable OHLC";
    return out;
  }

  const o = candle.open, h = candle.high, l = candle.low, c = candle.close;
  out.open = _r2(o); out.high = _r2(h); out.low = _r2(l); out.close = _r2(c);

  const range = h - l;
  out.range = _r2(range);
  if (!(range > 0)) {
    out.reason = "flat candle (high === low) — no shape to read";
    return out;
  }
  if (range < cfg.minRangePts) {
    out.reason = `range ${_r2(range)} < required ${cfg.minRangePts}`;
    return out;
  }

  const green = c > o;
  const red   = c < o;
  if (!green && !red) {
    out.reason = `doji (open === close at ${_r2(o)}) — no direction`;
    return out;
  }

  const body = Math.abs(c - o);
  const bodyPct = (body / range) * 100;
  out.bodyPct = _r2(bodyPct);

  // The wick that ARGUES AGAINST the candle's direction is the one that
  // matters. On a green candle that is the upper wick (sellers pushed back);
  // on a red candle it is the lower wick (buyers pushed back). The wick in the
  // direction of the move is allowed to be long — that is drawings #2 and #3.
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;
  const opposingWick   = green ? upperWick : lowerWick;
  const favourableWick = green ? lowerWick : upperWick;
  const opposingWickPct   = (opposingWick / range) * 100;
  const favourableWickPct = (favourableWick / range) * 100;
  out.opposingWickPct   = _r2(opposingWickPct);
  out.favourableWickPct = _r2(favourableWickPct);

  if (bodyPct < cfg.minBodyPct) {
    out.reason = `body ${_r2(bodyPct)}% of range < required ${cfg.minBodyPct}%`;
    return out;
  }
  if (opposingWickPct > cfg.maxOpposingWickPct) {
    out.reason =
      `${green ? "upper" : "lower"} wick ${_r2(opposingWickPct)}% of range > allowed ` +
      `${cfg.maxOpposingWickPct}% — ${green ? "sellers" : "buyers"} pushed back too hard`;
    return out;
  }

  // Name the drawing it matches, purely for the log/UI.
  const bothWicksTiny = opposingWickPct <= 5 && favourableWickPct <= 5;
  out.shape = bothWicksTiny
    ? "full body (drawing 1)"
    : favourableWickPct >= 25
      ? `long ${green ? "lower" : "upper"} wick (drawing 2)`
      : `small opposing wick (drawing 3)`;

  out.ok = true;
  out.direction = green ? "BULLISH" : "BEARISH";
  out.reason =
    `${out.direction} ${out.shape} — body ${_r2(bodyPct)}%, ` +
    `opposing wick ${_r2(opposingWickPct)}%`;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// firstCandleOfDay — pick the session's opening bar out of a candle array.
//
// Refuses rather than guesses. Handed intraday candles for several days it
// takes the requested day only; handed a series that has no bar starting at the
// session open it returns null, because "the first bar we happen to have" is
// not the same thing as "the 09:15 bar" and silently substituting one for the
// other would invent a signal candle out of, say, the 11:00 bar.
// ─────────────────────────────────────────────────────────────────────────────
function firstCandleOfDay(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  if (!Array.isArray(candles) || !candles.length) return null;

  const wantDay = _num(o.istDay)
    ? o.istDay
    : _istDayOf(candles[candles.length - 1].time);

  for (const c of candles) {
    if (!_okBar(c) || !_num(c.time)) continue;
    if (_istDayOf(c.time) !== wantDay) continue;
    if (_utcSecToIstMins(c.time) === cfg.sessionStartMin) return c;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// getNiftySignal — rule 2. Does the index give us a direction today?
//
// Returns { signal, side, direction, reason, skipReason, candle, detail }.
//   side: "LONG"  when NIFTY is bullish  → we BUY stocks
//         "SHORT" when NIFTY is bearish  → we SHORT stocks
// ─────────────────────────────────────────────────────────────────────────────
function getNiftySignal(niftyCandles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const base = {
    signal: false, side: null, direction: null,
    reason: "", skipReason: "", warmup: false,
    candle: null, detail: null, signalBarTime: null, date: null,
  };

  if (!Array.isArray(niftyCandles) || !niftyCandles.length) {
    base.warmup = true;
    base.skipReason = base.reason = "No NIFTY candles yet — cannot read the opening candle";
    return base;
  }

  const first = firstCandleOfDay(niftyCandles, { cfg, istDay: o.istDay });
  if (!first) {
    base.warmup = true;
    base.skipReason = base.reason =
      `No ${_fmtMins(cfg.sessionStartMin)} NIFTY candle in the series yet — ` +
      `the signal candle closes at ${_fmtMins(cfg.sessionStartMin + cfg.resolutionMins)}`;
    return base;
  }

  base.signalBarTime = first.time;
  base.date = _istDateStr(first.time);

  const cls = classifyCandle(first, { cfg });
  base.candle = { open: cls.open, high: cls.high, low: cls.low, close: cls.close, time: first.time };
  base.detail = cls;

  if (!cls.ok) {
    base.skipReason = base.reason = `NIFTY opening candle is not a signal candle — ${cls.reason}`;
    return base;
  }

  base.signal = true;
  base.direction = cls.direction;
  base.side = cls.direction === "BULLISH" ? "LONG" : "SHORT";
  base.reason =
    `NIFTY ${_fmtMins(cfg.sessionStartMin)} candle is ${cls.reason} → ` +
    `${base.side} day (${base.side === "LONG" ? "buy" : "short"} stocks only)`;
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateStock — rules 3, 4, 5 and 6 for ONE stock, given the day's direction.
//
// `input` = { symbol, candles | candle, prevClose }
// Returns a rich object for EVERY stock, accepted or not, so the route can log
// the entire funnel and show the user exactly why each name was dropped.
// ─────────────────────────────────────────────────────────────────────────────
function evaluateStock(input, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const side = o.side;

  const out = {
    symbol: (input && input.symbol) || null,
    ok: false, side: side || null, reason: "", skipReason: "",
    candle: null, detail: null,
    prevClose: null, gapPct: null,
    entry: null, stop: null, target: null,
    riskPts: null, rewardPts: null, bigCandle: false, slBasis: null,
    qty: cfg.qty, signalBarTime: null,
  };

  if (side !== "LONG" && side !== "SHORT") {
    out.skipReason = out.reason = "no NIFTY direction for the day — nothing to confirm against";
    return out;
  }
  if (!input || !input.symbol) {
    out.skipReason = out.reason = "missing symbol";
    return out;
  }

  const first = input.candle && _okBar(input.candle)
    ? input.candle
    : firstCandleOfDay(input.candles, { cfg, istDay: o.istDay });

  if (!first) {
    out.skipReason = out.reason = `no ${_fmtMins(cfg.sessionStartMin)} candle (no data)`;
    return out;
  }
  out.signalBarTime = first.time;

  // ── Rule 4 — the 2% gap rule. Checked BEFORE the shape, because a gapped
  //    stock is excluded no matter how pretty its candle is. Unknown prevClose
  //    is a REFUSAL, not a pass: "we don't know the gap" ≠ "there is no gap".
  const prevClose = input.prevClose;
  if (!_num(prevClose) || prevClose <= 0) {
    out.skipReason = out.reason =
      "previous day's close unknown — cannot apply the gap rule, standing aside";
    return out;
  }
  out.prevClose = _r2(prevClose);
  const gapPct = ((first.open - prevClose) / prevClose) * 100;
  out.gapPct = _r2(gapPct);
  if (Math.abs(gapPct) > cfg.maxGapPct) {
    out.skipReason = out.reason =
      `gapped ${_r2(gapPct)}% vs previous close ${_r2(prevClose)} — over the ` +
      `${cfg.maxGapPct}% limit`;
    return out;
  }

  // ── Rule 3 — same shape, same direction as NIFTY.
  const cls = classifyCandle(first, { cfg });
  out.candle = { open: cls.open, high: cls.high, low: cls.low, close: cls.close, time: first.time };
  out.detail = cls;

  if (!cls.ok) {
    out.skipReason = out.reason = cls.reason;
    return out;
  }
  const wantDirection = side === "LONG" ? "BULLISH" : "BEARISH";
  if (cls.direction !== wantDirection) {
    out.skipReason = out.reason =
      `${cls.direction} candle but NIFTY says ${wantDirection} — not aligned`;
    return out;
  }

  // ── Rules 5 + 6 — levels. All frozen here, never recomputed later.
  const buf = cfg.entryBufferPts;
  const bodyTop    = Math.max(first.open, first.close);
  const bodyBottom = Math.min(first.open, first.close);

  let entry, stop;
  if (side === "LONG") {
    entry = first.high + buf;
    stop  = first.low  - buf;
  } else {
    entry = first.low  - buf;
    stop  = first.high + buf;
  }

  // Rule 6 — big candle: move the stop off the wick and onto the body edge.
  // This only ever tightens, because the body is always inside the wick.
  let riskPts = Math.abs(entry - stop);
  out.slBasis = "wick";
  if (cfg.maxSlPts > 0 && riskPts > cfg.maxSlPts) {
    const bodyStop = side === "LONG" ? bodyBottom - buf : bodyTop + buf;
    const bodyRisk = Math.abs(entry - bodyStop);
    // Guard: a body edge that is not actually tighter (possible only on a
    // degenerate candle) is ignored rather than used to widen the stop.
    if (bodyRisk > 0 && bodyRisk < riskPts) {
      stop = bodyStop;
      riskPts = bodyRisk;
      out.bigCandle = true;
      out.slBasis = "body edge (big candle)";
    }
  }

  if (!(riskPts > 0)) {
    out.skipReason = out.reason = "computed risk is zero — refusing to build a setup";
    return out;
  }

  const rewardPts = riskPts * cfg.targetRR;
  const target = side === "LONG" ? entry + rewardPts : entry - rewardPts;

  out.entry     = _r2(entry);
  out.stop      = _r2(stop);
  out.target    = _r2(target);
  out.riskPts   = _r2(riskPts);
  out.rewardPts = _r2(rewardPts);
  out.ok        = true;
  out.reason =
    `${side} ${out.symbol} — ${cls.shape}, entry ${out.entry}, SL ${out.stop} ` +
    `(${out.slBasis}), target ${out.target} @ 1:${cfg.targetRR} | risk ${out.riskPts} ` +
    `reward ${out.rewardPts} | gap ${out.gapPct}%`;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDayPlan — the whole 09:30 decision in one call.
//
// This is what Paper, Backtest and Replay all call. It returns the plan AND the
// complete funnel, so a caller can log every symbol it looked at.
//
//   stocks: [{ symbol, candles|candle, prevClose }, ...]
// ─────────────────────────────────────────────────────────────────────────────
function buildDayPlan(niftyCandles, stocks, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();

  const plan = {
    tradeable: false, side: null, reason: "", skipReason: "",
    nifty: null, candidates: [], rejected: [], confirmingCount: 0,
    scanned: Array.isArray(stocks) ? stocks.length : 0,
    cfg: {
      qty: cfg.qty, targetRR: cfg.targetRR, maxConcurrent: cfg.maxConcurrent,
      entryBufferPts: cfg.entryBufferPts, maxSlPts: cfg.maxSlPts,
      maxGapPct: cfg.maxGapPct, minConfirmingStocks: cfg.minConfirmingStocks,
    },
  };

  const nifty = getNiftySignal(niftyCandles, { cfg, istDay: o.istDay });
  plan.nifty = nifty;
  if (!nifty.signal) {
    plan.skipReason = plan.reason = nifty.reason;
    return plan;
  }
  plan.side = nifty.side;

  const list = Array.isArray(stocks) ? stocks : [];
  for (const s of list) {
    const ev = evaluateStock(s, { cfg, side: nifty.side, istDay: o.istDay });
    if (ev.ok) plan.candidates.push(ev);
    else plan.rejected.push({ symbol: ev.symbol, reason: ev.skipReason || ev.reason });
  }

  plan.confirmingCount = plan.candidates.length;

  if (plan.confirmingCount < cfg.minConfirmingStocks) {
    plan.skipReason = plan.reason =
      `NIFTY is ${nifty.direction} but only ${plan.confirmingCount} stock(s) made a ` +
      `matching opening candle — need ${cfg.minConfirmingStocks}`;
    return plan;
  }

  // Rank by tightest risk first: with a fixed 100 qty, the smallest stop is the
  // smallest rupee loss, and the cap has to choose somehow. This affects only
  // WHICH names get taken when more than maxConcurrent confirm.
  plan.candidates.sort((a, b) => a.riskPts - b.riskPts);

  plan.tradeable = true;
  plan.reason =
    `${nifty.reason} | ${plan.confirmingCount} of ${plan.scanned} stocks confirmed` +
    (plan.confirmingCount > cfg.maxConcurrent
      ? ` — taking the ${cfg.maxConcurrent} tightest-stop names`
      : "");
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit evaluation — one place, so Paper/Backtest/Live cannot drift.
//
// checkExitOnTick  — Paper + Live, per tick against a live price.
// checkExitOnBar   — Backtest, per 15-minute bar, conservative ordering.
// ─────────────────────────────────────────────────────────────────────────────
function checkExitOnTick(position, price, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  if (!position || !_num(price)) return null;

  const side = position.side;
  const stop = position.stop, target = position.target;

  // Every level is checked for finiteness first. `price >= null` is
  // `price >= 0`, which would exit on the very first tick.
  if (_num(stop)) {
    if (side === "LONG" && price <= stop) {
      return { exit: true, reason: "Stop-loss hit", exitType: "SL", price: stop };
    }
    if (side === "SHORT" && price >= stop) {
      return { exit: true, reason: "Stop-loss hit", exitType: "SL", price: stop };
    }
  }
  if (_num(target)) {
    if (side === "LONG" && price >= target) {
      return { exit: true, reason: `Target hit (1:${cfg.targetRR})`, exitType: "TARGET", price: target };
    }
    if (side === "SHORT" && price <= target) {
      return { exit: true, reason: `Target hit (1:${cfg.targetRR})`, exitType: "TARGET", price: target };
    }
  }

  if (_num(o.nowMins) && o.nowMins >= cfg.forcedExitMin) {
    return {
      exit: true,
      reason: `Forced exit at ${_fmtMins(cfg.forcedExitMin)}`,
      exitType: "EOD", price,
    };
  }
  return null;
}

function checkExitOnBar(position, bar, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  if (!position || !_okBar(bar)) return null;

  const side = position.side;
  const stop = position.stop, target = position.target;

  // A bar that OPENED beyond the stop fills at the open — the market gapped
  // through the level and the better price was never available.
  if (_num(stop)) {
    if (side === "LONG" && bar.open <= stop) {
      return { exit: true, reason: "Stop-loss — bar opened beyond the stop", exitType: "SL", price: bar.open };
    }
    if (side === "SHORT" && bar.open >= stop) {
      return { exit: true, reason: "Stop-loss — bar opened beyond the stop", exitType: "SL", price: bar.open };
    }
  }

  // The adverse level is tested BEFORE the favourable one. A 15-minute bar
  // cannot say which came first, and assuming the target is how a backtest
  // lies to itself.
  if (_num(stop)) {
    if (side === "LONG" && bar.low <= stop) {
      return { exit: true, reason: "Stop-loss hit", exitType: "SL", price: stop };
    }
    if (side === "SHORT" && bar.high >= stop) {
      return { exit: true, reason: "Stop-loss hit", exitType: "SL", price: stop };
    }
  }
  if (_num(target)) {
    if (side === "LONG" && bar.high >= target) {
      return { exit: true, reason: `Target hit (1:${cfg.targetRR})`, exitType: "TARGET", price: target };
    }
    if (side === "SHORT" && bar.low <= target) {
      return { exit: true, reason: `Target hit (1:${cfg.targetRR})`, exitType: "TARGET", price: target };
    }
  }

  const closeMins = _utcSecToIstMins(bar.time) + cfg.resolutionMins;
  if (closeMins >= cfg.forcedExitMin) {
    return {
      exit: true,
      reason: `Forced exit at ${_fmtMins(cfg.forcedExitMin)}`,
      exitType: "EOD", price: bar.close,
    };
  }
  return null;
}

/** Has the pending stop-order level been touched? Same test in every mode. */
function isEntryTriggered(setup, price) {
  if (!setup || !_num(price) || !_num(setup.entry)) return false;
  return setup.side === "LONG" ? price >= setup.entry : price <= setup.entry;
}

function isEntryTriggeredOnBar(setup, bar) {
  if (!setup || !_okBar(bar) || !_num(setup.entry)) return false;
  return setup.side === "LONG" ? bar.high >= setup.entry : bar.low <= setup.entry;
}

/** Cash-equity P&L. LONG profits when price rises; SHORT when it falls. */
function computePnl(side, entry, exit, qty) {
  if (!_num(entry) || !_num(exit) || !_num(qty)) return 0;
  const per = side === "SHORT" ? entry - exit : exit - entry;
  return _r2(per * qty);
}

module.exports = {
  NAME: "EARLYBIRD",
  getConfig,
  classifyCandle,
  firstCandleOfDay,
  getNiftySignal,
  evaluateStock,
  buildDayPlan,
  checkExitOnTick,
  checkExitOnBar,
  isEntryTriggered,
  isEntryTriggeredOnBar,
  computePnl,
  // exported for the offline test harness
  _istDayOf, _utcSecToIstMins, _istDateStr, _fmtMins, _parseHHMM,
};

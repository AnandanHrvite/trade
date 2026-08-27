/**
 * HA_SCALP — Heikin Ashi trend-continuation scalp on the 15-minute NIFTY chart
 * ═════════════════════════════════════════════════════════════════════════════
 * Single-leg NIFTY option buying, intraday, Zerodha. Everything this engine
 * decides is read off HEIKIN ASHI candles built from 15-minute NIFTY spot bars.
 * There is no other input. No VIX, no OI, no RSI, no volume — see the omissions
 * block at the bottom of this header.
 *
 * ── WHY HEIKIN ASHI, AND WHAT CHANGES ───────────────────────────────────────
 * A Heikin Ashi candle is an average, not a trade. It is built from the raw
 * OHLC like this, and this is the ONLY definition used anywhere in this repo:
 *
 *     haClose = (open + high + low + close) / 4                 ← this bar's raw OHLC
 *     haOpen  = (previous haOpen + previous haClose) / 2        ← recursive
 *     haHigh  = max(high, haOpen, haClose)
 *     haLow   = min(low,  haOpen, haClose)
 *
 * The first bar of the series has no previous HA candle, so it is seeded with
 * haOpen = (open + close) / 2. That seed decays: because haOpen is a running
 * average, a wrong seed is halved every bar and is worth less than a hundredth
 * of a point after ~10 bars. The engine therefore REFUSES to decide until it
 * has HA_SCALP_HA_WARMUP_BARS (default 20) bars behind it — with fewer, the
 * candle colours near the start of the series are seed artefacts, not signal.
 *
 * The consequence that matters for trading: **a Heikin Ashi candle is not a
 * tradeable price.** haClose is an average of four prices; nothing ever traded
 * there. So every DECISION is read off the HA candle, and every PRICE — entry
 * fill reference and stop level — is read off the RAW candle. Mixing the two is
 * the classic Heikin Ashi mistake and it silently invents fills that could not
 * have happened.
 *
 * ── THE DAY, IN FOUR RULES ──────────────────────────────────────────────────
 *
 *  1. TREND — the 50-period MA of RAW 15-minute closes (HA_SCALP_MA_PERIOD,
 *     HA_SCALP_MA_TYPE = sma | ema, default sma).
 *
 *         raw close ABOVE the 50 MA  →  CE side only.
 *         raw close BELOW the 50 MA  →  PE side only.
 *
 *     This is a HARD directional gate. A perfect bullish HA candle sitting
 *     below the 50 MA is not a trade — that is the "don't enter against the
 *     trend" rule (image 4: bullish-looking candles under a falling MA), and
 *     the engine states that as the skip reason so the log shows the setup was
 *     seen and rejected on purpose, not missed.
 *
 *  2. ENTRY CANDLE — a "no wick" Heikin Ashi candle in the trend's direction,
 *     read on the just-CLOSED 15-minute bar:
 *
 *         CE  bullish HA candle (haClose > haOpen) with NO BOTTOM WICK
 *             i.e. haLow === haOpen — nothing sold below the open, all buyers.
 *         PE  bearish HA candle (haClose < haOpen) with NO TOP WICK
 *             i.e. haHigh === haOpen — nothing bought above the open, all sellers.
 *
 *     "No wick" is exact by default (HA_SCALP_MAX_WICK_PCT = 0). The wick is
 *     measured as a PERCENTAGE OF THE CANDLE'S RANGE, so the tolerance means
 *     the same thing on a 20-point bar and a 200-point bar; raising the key to
 *     10 allows a wick up to 10% of the range. Because of the HA construction
 *     above, haLow is exactly haOpen (or haHigh exactly haOpen) reasonably
 *     often, so the exact-zero default is not a rule that never fires — but it
 *     IS strict, and low trade frequency is expected and intended.
 *
 *     The body must also be a real body: at least HA_SCALP_MIN_BODY_PTS points
 *     (default 5). A zero-range HA candle has "no wick" trivially and would
 *     otherwise be a signal.
 *
 *  3. ENTRY PRICE + STOP — both read off RAW candles, never HA.
 *
 *         entry = the NEXT candle's OPEN. The signal fires at a 15-minute
 *                 close and is filled at the open of the bar that follows, which
 *                 is exactly the next tick the market prints. Paper and Live
 *                 both enter on the first tick after the signal bar closes;
 *                 Backtest uses the next raw bar's open. Same event.
 *         stop  = the SIGNAL candle's RAW extreme (a LEVEL, frozen at entry and
 *                 never moved again):
 *                     CE → the signal candle's raw LOW  − HA_SCALP_SL_BUFFER_PTS
 *                     PE → the signal candle's raw HIGH + HA_SCALP_SL_BUFFER_PTS
 *
 *     The user's rule says "SL is previous candle high/low". At the moment of
 *     entry the signal candle IS the previous candle, so those are the same
 *     level; it is stored frozen so it cannot drift while the trade is open.
 *
 *     HA_SCALP_MAX_SL_PTS (default 0 = OFF) rejects setups whose stop is
 *     further than N spot points away. It exists because a wide HA candle can
 *     hand the trade a 120-point stop, and 0 means the rules run exactly as
 *     written unless the user turns it on.
 *
 *  4. EXITS — three, all read on 15-minute HA closes, plus the route's EOD:
 *
 *     a. STOP — the frozen raw level above. Tested per tick on spot.
 *     b. DOJI — an HA candle whose body is <= HA_SCALP_DOJI_BODY_PCT (default
 *        20) of its range. In the user's words: "high chances for trend
 *        reversal". It exits regardless of colour, because a doji closes the
 *        trend question either way.
 *     c. WEAK — an HA candle in the trend's own direction whose body is
 *        smaller than HA_SCALP_WEAK_BODY_PCT (default 40) of its range, or an
 *        HA candle of the OPPOSITE colour. "Trend is getting weak, ready for
 *        exit better."
 *
 *     There is NO fixed target and NO trailing stop. The trade runs until the
 *     stop, a doji, a weak candle, or the square-off time. That is the rule as
 *     given; a target was explicitly not asked for.
 *
 * ── THE FIRST HA CANDLE OF THE DAY ──────────────────────────────────────────
 * haOpen is recursive across the overnight boundary. This engine builds the HA
 * series CONTINUOUSLY across days (HA_SCALP_HA_CONTINUOUS = true, default),
 * which is what TradingView does and therefore what the user's screenshots
 * show. Setting it false reseeds each IST day — the charts would then disagree
 * with TradingView, so it defaults to matching the platform the rules came from.
 *
 * ── DELIBERATELY NOT HERE (do not "helpfully" add these) ────────────────────
 * No auto-drawn trend line (the user chose the 50 MA as the sole trend test —
 * a drawn line depends on which swing points you pick and is not reproducible),
 * no VIX gate, no OI filter, no ADX, no RSI, no ATR, no VWAP, no SuperTrend, no
 * volume test, no multi-timeframe bias, no extra confirmation candle, no fixed
 * target, no trailing stop, no breakeven jump, no partial booking, no premium
 * stop, no re-entry rule beyond the shared cooldown, no expiry-day special case.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Every value a decision reads comes from CLOSED 15-minute candle OHLC as
 * returned by the history API. No live tick and no live spot enters any signal
 * computation, so Paper, Backtest, Live and Replay compute identical numbers
 * from the same session. The live spot is used for ONE thing only: testing the
 * already-frozen stop level per tick.
 *
 * ── NOT MARKET-VALIDATED ────────────────────────────────────────────────────
 * Zero trades, paper or live. The wick rule is EXACT-ZERO by the user's choice,
 * so the trade frequency is genuinely unknown and may be very low. Collect
 * clean paper sessions and diff them against /replay before touching any live
 * gate.
 *
 * Contract:
 *   getConfig()                      -> live env read (never cached)
 *   toHeikinAshi(candles, opts)      -> HA series, index-aligned to `candles`
 *   computeMA(candles, cfg)          -> MA series, index-aligned to `candles`
 *   classifyCandle(ha, cfg)          -> { bullish, bearish, doji, weak, ... }
 *   getSignal(candles, opts)         -> { signal, side, entrySpot, slSpot, ... }
 *   stopHit / exitSignal             -> the ONLY exit tests (plus route EOD)
 */

const { SMA, EMA } = require("technicalindicators");

const NAME = "HA_SCALP";
const DESCRIPTION =
  "Heikin Ashi Scalp — a no-wick 15-minute Heikin Ashi candle in the direction of the 50 MA is entered at the " +
  "next candle's open, stopped at the signal candle's raw high/low, and exited on a doji or a weak candle";

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
 * Deliberately NOT a silent collapse to midnight: a typo in HA_SCALP_ENTRY_END
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

function _boolEnv(key, def) {
  const raw = process.env[key];
  if (raw == null || raw === "") return def;
  const s = String(raw).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return def;
}

/** A candle usable for a decision: all four prices finite. Volume is never read. */
function _okBar(c) {
  return !!c && _num(c.open) && _num(c.high) && _num(c.low) && _num(c.close);
}

const MA_TYPES = ["sma", "ema"];

/**
 * Live config read. Settings saves mutate process.env in place, so this must
 * never be cached — every caller re-reads on each evaluation.
 */
function getConfig() {
  const rawMaType = String(process.env.HA_SCALP_MA_TYPE || "sma").trim().toLowerCase();
  return {
    // Timeframe — STRATEGY-LEVEL. 15 minutes is the chart the rules were read
    // off; the repo-wide 5-minute default does not apply here.
    resolutionMins:  _intEnv("HA_SCALP_RESOLUTION", 15, 1, 60),
    sessionStartMin: _parseHHMM(process.env.HA_SCALP_SESSION_START, 9 * 60 + 15),
    entryStartMin:   _parseHHMM(process.env.HA_SCALP_ENTRY_START,   9 * 60 + 30),
    entryEndMin:     _parseHHMM(process.env.HA_SCALP_ENTRY_END,    15 * 60),

    // Heikin Ashi construction
    haContinuous:    _boolEnv("HA_SCALP_HA_CONTINUOUS", true),
    haWarmupBars:    _intEnv("HA_SCALP_HA_WARMUP_BARS", 20, 1, 500),

    // Trend gate
    maPeriod:        _intEnv("HA_SCALP_MA_PERIOD", 50, 2, 400),
    maType:          MA_TYPES.includes(rawMaType) ? rawMaType : "sma",

    // The entry candle
    maxWickPct:      _numEnv("HA_SCALP_MAX_WICK_PCT", 0, 0, 100),
    minBodyPts:      _numEnv("HA_SCALP_MIN_BODY_PTS", 5, 0),

    // Exits
    dojiBodyPct:     _numEnv("HA_SCALP_DOJI_BODY_PCT", 20, 0, 100),
    weakBodyPct:     _numEnv("HA_SCALP_WEAK_BODY_PCT", 40, 0, 100),
    exitOnDoji:      _boolEnv("HA_SCALP_EXIT_ON_DOJI", true),
    exitOnWeak:      _boolEnv("HA_SCALP_EXIT_ON_WEAK", true),

    // Risk
    slBufferPts:     _numEnv("HA_SCALP_SL_BUFFER_PTS", 0, 0),
    maxSlPts:        _numEnv("HA_SCALP_MAX_SL_PTS", 0, 0),
  };
}

// ── Heikin Ashi ──────────────────────────────────────────────────────────────
/**
 * Build the Heikin Ashi series from raw candles. Output is INDEX-ALIGNED to the
 * input: ha[i] is the HA candle of candles[i], so a chart can plot both without
 * an offset and the signal can never quote a shifted bar.
 *
 * haOpen is recursive, so an unusable raw bar breaks the chain rather than
 * silently averaging around it — that bar's HA entry is null and the NEXT bar
 * reseeds. A null HA candle is never a signal.
 *
 * @param {Array}  candles ascending raw bars
 * @param {object} opts    { cfg }
 * @returns {Array} same length as candles; each entry { time, open, high, low,
 *                  close, bullish, bearish, body, range, upperWick, lowerWick,
 *                  seeded } or null
 */
function toHeikinAshi(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const out = [];
  if (!Array.isArray(candles)) return out;

  let prevOpen = null, prevClose = null, prevDay = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!_okBar(c)) { out.push(null); prevOpen = null; prevClose = null; continue; }

    const day = _istDayOf(c.time);
    // Reseed when the chain is broken, or at a day boundary if the user has
    // turned continuity off.
    const reseed =
      prevOpen == null || prevClose == null ||
      (!cfg.haContinuous && prevDay != null && day !== prevDay);

    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = reseed ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow  = Math.min(c.low,  haOpen, haClose);

    const body = Math.abs(haClose - haOpen);
    const range = haHigh - haLow;
    out.push({
      time: c.time,
      open:  _r2(haOpen),
      high:  _r2(haHigh),
      low:   _r2(haLow),
      close: _r2(haClose),
      bullish: haClose > haOpen,
      bearish: haClose < haOpen,
      body:  _r2(body),
      range: _r2(range),
      // Wicks measured against the HA body edges, which is what "no wick"
      // means on a Heikin Ashi chart.
      upperWick: _r2(haHigh - Math.max(haOpen, haClose)),
      lowerWick: _r2(Math.min(haOpen, haClose) - haLow),
      seeded: reseed,
      rawOpen:  _r2(c.open),
      rawHigh:  _r2(c.high),
      rawLow:   _r2(c.low),
      rawClose: _r2(c.close),
    });
    prevOpen = haOpen;
    prevClose = haClose;
    prevDay = day;
  }
  return out;
}

// ── the trend MA ─────────────────────────────────────────────────────────────
/**
 * MA of RAW closes, INDEX-ALIGNED to `candles` (leading entries are null).
 *
 * The `technicalindicators` package returns N-p+1 values for period p over N
 * inputs, with out[j] ↔ values[j+p-1]. That offset is applied here once, so no
 * caller ever has to remember it.
 *
 * The MA reads RAW closes, not HA closes: the 50 MA in the user's screenshots
 * is the platform default, which is computed on the real chart price.
 */
function computeMA(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const out = new Array(Array.isArray(candles) ? candles.length : 0).fill(null);
  if (!Array.isArray(candles) || candles.length < cfg.maPeriod) return out;

  const closes = candles.map((c) => (_okBar(c) ? c.close : null));
  if (closes.some((v) => v == null)) {
    // A hole in the series would shift every MA value after it. Refuse rather
    // than quote a silently misaligned average.
    return out;
  }
  const fn = cfg.maType === "ema" ? EMA : SMA;
  const vals = fn.calculate({ period: cfg.maPeriod, values: closes });
  for (let j = 0; j < vals.length; j++) {
    const idx = j + cfg.maPeriod - 1;
    if (idx < out.length && _num(vals[j])) out[idx] = _r2(vals[j]);
  }
  return out;
}

// ── candle classification ────────────────────────────────────────────────────
/**
 * Classify one HA candle against the config's body/wick thresholds.
 *
 * All three tests are PERCENTAGES OF THE CANDLE'S OWN RANGE, so they mean the
 * same thing on a quiet 20-point bar and a 200-point bar. A zero-range candle
 * is reported as doji and never as a valid entry.
 *
 * @returns {{ bullish, bearish, doji, weak, bodyPct, upperWickPct, lowerWickPct,
 *             noTopWick, noBottomWick, range, body }}
 */
function classifyCandle(ha, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const out = {
    ok: false, bullish: false, bearish: false, doji: false, weak: false,
    bodyPct: null, upperWickPct: null, lowerWickPct: null,
    noTopWick: false, noBottomWick: false, range: null, body: null,
  };
  if (!ha || !_num(ha.open) || !_num(ha.close) || !_num(ha.high) || !_num(ha.low)) return out;

  out.ok = true;
  out.range = ha.range;
  out.body = ha.body;
  out.bullish = ha.bullish;
  out.bearish = ha.bearish;

  if (!(ha.range > 0)) {
    // A flat candle has no direction and no wick. It is a doji, never an entry.
    out.doji = true;
    out.weak = true;
    out.bodyPct = 0;
    out.upperWickPct = 0;
    out.lowerWickPct = 0;
    return out;
  }

  out.bodyPct = _r2((ha.body / ha.range) * 100);
  out.upperWickPct = _r2((ha.upperWick / ha.range) * 100);
  out.lowerWickPct = _r2((ha.lowerWick / ha.range) * 100);

  out.doji = out.bodyPct <= cfg.dojiBodyPct;
  out.weak = out.bodyPct < cfg.weakBodyPct;
  out.noTopWick = out.upperWickPct <= cfg.maxWickPct;
  out.noBottomWick = out.lowerWickPct <= cfg.maxWickPct;
  return out;
}

// ── the entry signal ─────────────────────────────────────────────────────────
function _baseSignal(cfg) {
  return {
    signal: "NONE", side: null, reason: "", skipReason: "", warmup: false,
    entrySpot: null, slSpot: null, slPts: null, signalStrength: null,
    ma: null, maType: null, trend: null,
    haOpen: null, haHigh: null, haLow: null, haClose: null,
    bodyPct: null, upperWickPct: null, lowerWickPct: null,
    rawHigh: null, rawLow: null, rawClose: null,
    signalBarTime: null,
    cfg,
  };
}

/**
 * getSignal(candles, opts)
 *
 * @param {Array} candles ascending 15-min IST **raw NIFTY spot** bars. The LAST
 *        element is the just-CLOSED signal candle — never a forming bar (the
 *        caller decides that).
 * @param {object} opts { cfg, silent, alreadyTraded, ha, ma }
 *        `ha` and `ma` may be passed in when the caller has already computed
 *        them for a chart, purely to avoid recomputation — they must be the
 *        index-aligned outputs of this file's own helpers.
 */
function getSignal(candles, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const base = _baseSignal(cfg);
  base.maType = cfg.maType;

  // The MA needs `maPeriod` bars; the HA chain needs its own warm-up on top of
  // whatever the MA needs, because early HA colours are seed artefacts.
  const minBars = Math.max(cfg.maPeriod, cfg.haWarmupBars) + 1;
  if (!Array.isArray(candles) || candles.length < minBars) {
    base.warmup = true;
    base.skipReason = base.reason =
      `Warming up (${candles ? candles.length : 0}/${minBars} 15-min candles — ` +
      `the ${cfg.maPeriod} MA and the Heikin Ashi chain both need history)`;
    return base;
  }

  const n = candles.length;
  const sig = candles[n - 1];
  if (!_okBar(sig)) {
    base.skipReason = base.reason = "Signal candle has no usable OHLC — refusing to decide";
    return base;
  }
  base.signalBarTime = sig.time;
  base.rawHigh = _r2(sig.high);
  base.rawLow = _r2(sig.low);
  base.rawClose = _r2(sig.close);

  // ── Window. The bar's CLOSE time gates it, not its start: the 14:45 bar
  //    CLOSES at 15:00, and a start-time check would silently drop the last
  //    legal bar that the backtest still accepts. ─────────────────────────────
  const closeMins = _utcSecToIstMins(sig.time) + cfg.resolutionMins;
  if (closeMins <= cfg.entryStartMin) {
    base.skipReason = base.reason =
      `Bar closes ${_fmtMins(closeMins)} — before the ${_fmtMins(cfg.entryStartMin)} entry window opens`;
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

  // ── Heikin Ashi + MA, both index-aligned to `candles`. ────────────────────
  const ha = Array.isArray(o.ha) && o.ha.length === n ? o.ha : toHeikinAshi(candles, { cfg });
  const maSeries = Array.isArray(o.ma) && o.ma.length === n ? o.ma : computeMA(candles, { cfg });

  const haBar = ha[n - 1];
  const ma = maSeries[n - 1];
  if (!haBar) {
    base.skipReason = base.reason = "Heikin Ashi candle not computable for the signal bar — refusing to decide";
    return base;
  }
  if (!_num(ma)) {
    base.warmup = true;
    base.skipReason = base.reason =
      `${cfg.maPeriod} ${cfg.maType.toUpperCase()} not available yet — no trend to trade with`;
    return base;
  }
  base.ma = ma;
  base.haOpen = haBar.open;
  base.haHigh = haBar.high;
  base.haLow = haBar.low;
  base.haClose = haBar.close;

  // ── 1. TREND. RAW close vs the MA — the hard directional gate. ────────────
  //    Read on the raw close, because that is what the MA is computed on and
  //    what the user's chart shows: "if candles are above 50 MA, only CE".
  const above = sig.close > ma;
  const below = sig.close < ma;
  base.trend = above ? "UP" : below ? "DOWN" : "FLAT";
  if (!above && !below) {
    base.skipReason = base.reason =
      `Raw close ${base.rawClose} is exactly on the ${cfg.maPeriod} ${cfg.maType.toUpperCase()} (${ma}) — no side, standing aside`;
    return base;
  }

  const cls = classifyCandle(haBar, { cfg });
  base.bodyPct = cls.bodyPct;
  base.upperWickPct = cls.upperWickPct;
  base.lowerWickPct = cls.lowerWickPct;

  // ── 2. ENTRY CANDLE. Only the trend's own side is ever considered — this is
  //    where "don't enter against the trend" is enforced. ────────────────────
  const wantCE = above;
  const side = wantCE ? "CE" : "PE";
  const wickLabel = wantCE ? "bottom" : "top";
  const wickPct = wantCE ? cls.lowerWickPct : cls.upperWickPct;
  const noWick = wantCE ? cls.noBottomWick : cls.noTopWick;
  const rightColour = wantCE ? cls.bullish : cls.bearish;

  // A doji is a reversal warning, not an entry — it can never open a trade even
  // if it happens to satisfy the wick test.
  if (cls.doji) {
    base.skipReason = base.reason =
      `Trend ${base.trend} (raw close ${base.rawClose} vs ${cfg.maPeriod} ${cfg.maType.toUpperCase()} ${ma}) but the ` +
      `Heikin Ashi candle is a DOJI (body ${cls.bodyPct}% of range <= ${cfg.dojiBodyPct}%) — reversal risk, no entry`;
    return base;
  }

  if (!rightColour) {
    base.skipReason = base.reason =
      `Trend ${base.trend} wants a ${wantCE ? "bullish" : "bearish"} Heikin Ashi candle, but this one is ` +
      `${cls.bullish ? "bullish" : "bearish"} (HA open ${haBar.open} → close ${haBar.close}) — no entry against the trend`;
    return base;
  }

  if (!(cls.body >= cfg.minBodyPts)) {
    base.skipReason = base.reason =
      `${wantCE ? "Bullish" : "Bearish"} Heikin Ashi candle but its body is only ${cls.body}pt < ${cfg.minBodyPts}pt ` +
      `minimum — too small to call a strength candle`;
    return base;
  }

  if (!noWick) {
    base.skipReason = base.reason =
      `${wantCE ? "Bullish" : "Bearish"} Heikin Ashi candle (body ${cls.body}pt) but it has a ${wickLabel} wick of ` +
      `${wickPct}% of range > ${cfg.maxWickPct}% allowed — ${wantCE ? "sellers pushed below the open" : "buyers pushed above the open"}, no entry`;
    return base;
  }

  // ── 3. LEVELS. Both read off the RAW candle — an HA price never traded. ───
  //    entry is the reference the routes fill against: Paper/Live take the
  //    first tick after this bar closes, Backtest takes the next raw bar's
  //    open. The signal bar's raw close is stored as the reference price.
  const entry = _r2(sig.close);
  const slSpot = _r2(wantCE ? sig.low - cfg.slBufferPts : sig.high + cfg.slBufferPts);

  // Geometry sanity. `spot >= null` is `spot >= 0`, so every level is checked
  // finite first, and then checked to be on the side the trade needs it on.
  if (!_num(slSpot)) {
    base.skipReason = base.reason = "Stop level not computable — refusing to enter without one";
    return base;
  }
  if (wantCE ? entry <= slSpot : entry >= slSpot) {
    base.skipReason = base.reason =
      `Signal candle closed ${entry}, already ${wantCE ? "at or below" : "at or above"} its own ${wantCE ? "low" : "high"} ` +
      `stop ${slSpot} — the trade would be stopped on its first tick`;
    return base;
  }

  const slPts = _r2(Math.abs(entry - slSpot));
  base.slPts = slPts;
  if (!(slPts > 0)) {
    base.skipReason = base.reason = `Stop distance resolved to ${slPts}pt — refusing a zero-risk trade`;
    return base;
  }

  // ── Optional guard (defaults to OFF — see the header). ────────────────────
  if (cfg.maxSlPts > 0 && slPts > cfg.maxSlPts) {
    base.skipReason = base.reason =
      `Setup valid but the signal candle's ${wantCE ? "low" : "high"} is ${slPts}pt away > ${cfg.maxSlPts}pt cap — ` +
      `SKIPPED (the stop is never moved closer than the rule says)`;
    return base;
  }

  base.signal = wantCE ? "BUY_CE" : "BUY_PE";
  base.side = side;
  base.signalStrength = "STRONG";
  base.entrySpot = entry;
  base.slSpot = slSpot;
  base.reason =
    `HA SCALP ${side}: trend ${base.trend} (raw close ${entry} ${wantCE ? "above" : "below"} the ${cfg.maPeriod} ` +
    `${cfg.maType.toUpperCase()} ${ma}) | ${wantCE ? "bullish" : "bearish"} Heikin Ashi candle with NO ${wickLabel.toUpperCase()} WICK ` +
    `(${wickPct}% of range, body ${cls.body}pt = ${cls.bodyPct}%) closed ${_fmtMins(closeMins)} | ` +
    `entry at the next candle's open | SL = signal candle raw ${wantCE ? "low" : "high"} ${slSpot} (${slPts}pt)`;

  if (!o.silent) {
    const ist = new Date(sig.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    console.log(
      `[HA_SCALP ${ist}] ENTER ${side} | trend ${base.trend} vs MA ${ma} | ` +
      `HA body ${cls.body}pt (${cls.bodyPct}%), ${wickLabel} wick ${wickPct}% | SL ${slSpot} (${slPts}pt)`
    );
  }
  return base;
}

// ── Exit rules (ONE place, so paper / backtest / live / replay cannot drift) ──
/**
 * Stop taken out? The stop is a fixed spot LEVEL, frozen at entry, and never
 * moves. A CE is stopped when spot falls to the signal candle's low; a PE when
 * spot rises to the signal candle's high.
 *
 * `stop` must be a finite level — `price <= null` is `price <= 0`, which would
 * book a stop on the very first tick.
 */
function stopHit(side, price, stop) {
  if (!_num(price) || !_num(stop)) return false;
  return side === "CE" ? price <= stop : price >= stop;
}

/**
 * Candle-close exit test, run on each CLOSED 15-minute HA candle while a
 * position is open. Returns null when the trade should be left alone.
 *
 * Two reasons, in the user's own terms:
 *   DOJI — body <= dojiBodyPct of range. "High chances for trend reversal."
 *          Colour is irrelevant: a doji ends the trend question either way.
 *   WEAK — the candle turned the OPPOSITE colour, or its body is below
 *          weakBodyPct of range. "Trend is getting weak, ready for exit."
 *
 * A doji is reported as DOJI even though it is also weak, because the reason
 * string is what the user reads in the log and the doji is the stronger signal.
 *
 * @returns {{ reason, label, detail } | null}
 */
function exitSignal(side, ha, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  if (!ha || (side !== "CE" && side !== "PE")) return null;

  const cls = classifyCandle(ha, { cfg });
  if (!cls.ok) return null;

  if (cfg.exitOnDoji && cls.doji) {
    return {
      reason: "HA_DOJI",
      label: "Doji candle",
      detail:
        `Heikin Ashi doji (body ${cls.body}pt = ${cls.bodyPct}% of a ${cls.range}pt range <= ${cfg.dojiBodyPct}%) — ` +
        `trend reversal risk, exiting the ${side}`,
    };
  }

  if (cfg.exitOnWeak) {
    const withTrend = side === "CE" ? cls.bullish : cls.bearish;
    if (!withTrend) {
      return {
        reason: "HA_OPPOSITE",
        label: "Opposite colour candle",
        detail:
          `Heikin Ashi candle turned ${cls.bullish ? "bullish" : "bearish"} against the ${side} ` +
          `(HA open ${ha.open} → close ${ha.close}) — trend broken, exiting`,
      };
    }
    if (cls.weak) {
      return {
        reason: "HA_WEAK",
        label: "Weak strength candle",
        detail:
          `Heikin Ashi candle still ${side === "CE" ? "bullish" : "bearish"} but weak ` +
          `(body ${cls.body}pt = ${cls.bodyPct}% of range < ${cfg.weakBodyPct}%) — momentum fading, exiting`,
      };
    }
  }
  return null;
}

module.exports = {
  NAME,
  DESCRIPTION,
  MA_TYPES,
  getConfig,
  toHeikinAshi,
  computeMA,
  classifyCandle,
  getSignal,
  stopHit,
  exitSignal,
  // shared time helpers (routes must not re-derive IST arithmetic)
  _istDayOf,
  _istDateStr,
  _utcSecToIstMins,
  _parseHHMM,
  _fmtMins,
};

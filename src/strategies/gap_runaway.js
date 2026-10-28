/**
 * GAP_RUNAWAY — "GAP_runAway__Kirubakaran": extreme daily RSI + a breakaway gap
 * ─────────────────────────────────────────────────────────────────────────────
 * Reference: https://www.youtube.com/watch?v=uLTaXTyDxiI (also kept in Settings
 * as GAP_RUNAWAY_REFERENCE_URL). One engine, two instruments:
 *   GAP_RUNAWAY      — NIFTY 50 ATM options, Zerodha, 1 lot (src/routes/gapRunawayPaper.js)
 *   GAP_RUNAWAY_STK  — F&O stocks, intraday shares (MIS), paper (src/routes/gapRunawayStkPaper.js)
 * Every rule lives HERE. The routes compute no indicator and make no threshold
 * comparison of their own; each call passes its env prefix.
 *
 * ── INDICATORS (DAILY chart) ────────────────────────────────────────────────
 *   EMA({P}_EMA_LENGTH, default 21) of the daily CLOSE.
 *   RSI({P}_RSI_LENGTH, default 10) whose SOURCE is that EMA21 line — TradingView's
 *   "Source: EMA: EMA" option. Smoothing twice is what lets the line actually
 *   reach the 90 / 10 bands. Not configurable: the user's rule is RSI-on-EMA.
 *   Overbought {P}_RSI_UPPER (90), oversold {P}_RSI_LOWER (10).
 *
 * ── WHICH BAR EACH NUMBER READS ─────────────────────────────────────────────
 *   RSI    — YESTERDAY's CLOSED daily bar (the newest daily bar strictly before
 *            the session day). Today's forming daily bar is dropped by IST day
 *            number, so it can never move the decision intraday.
 *   Gap    — TODAY's OPEN minus that same bar's CLOSE ("previous day close vs
 *            current day open"). The route supplies today's official open (the
 *            exchange's open_price quote), never a live spot.
 *
 * ── ENTRY (once a day, at the open) ─────────────────────────────────────────
 *   CE / LONG : yesterday's RSI <  RSI_LOWER (oversold)   AND today opens ABOVE
 *               yesterday's close (gap UP)
 *   PE / SHORT: yesterday's RSI >  RSI_UPPER (overbought) AND today opens BELOW
 *               yesterday's close (gap DOWN)
 *   Any gap counts: |gap| must be > 0 and ≥ {P}_MIN_GAP_PTS (default 0).
 *   The fill is the first price after the open inside {P}_ENTRY_START..END
 *   (09:15–09:30); after END no entry is taken that day. ATM strike (NIFTY).
 *   One trade per day — no re-entry after any exit.
 *
 * ── EXITS ───────────────────────────────────────────────────────────────────
 *   Stop  — a PRICE LEVEL = yesterday's close (the gap-fill level), checked on
 *           EVERY tick: CE exits when spot ≤ it, PE when spot ≥ it. It is not a
 *           distance from the fill. If price has already filled the gap before
 *           the fill, the entry is refused (entryStillValid) — otherwise the very
 *           first tick would stop it out.
 *   Trail — EMA({P}_TRAIL_EMA_LENGTH, default 21) on {P}_EXIT_TF-min candles
 *           (default 5). A TRAILING STOP, not a target: exit when a candle CLOSES
 *           back through it (CE: close < EMA, PE: close > EMA). Close only, never
 *           a wick.
 *   EOD   — anything still open is squared off at {P}_EOD_EXIT_TIME (15:15).
 *           Nothing is held overnight (the video holds for days; the user chose
 *           intraday).
 *
 * ── DELIBERATELY NOT HERE (the user said so — do not add) ───────────────────
 *   (NIFTY page. The stock scanner route adds the common exits — see its header.)
 *   No common rules: no profit lock, no breakeven, no wait-after-exit, no bid-ask
 *   spread check, no common 10:00–14:00 window, no lot multiplier, no paper
 *   capital gate, no portfolio cap. No VIX / OI / ADX / volume / VWAP / trend
 *   filter, no confirmation candle, no fixed target. No backtest, no replay.
 *
 * ── NOT MARKET-VALIDATED ────────────────────────────────────────────────────
 *   RSI(10) on EMA21 sits beyond 90 / 10 on ~47% of days (it stays pinned for
 *   weeks), so NIFTY fires ~35–55 trades a year. On 8.5 years of cached 5-min
 *   data (spot points, before costs) the rules lost in every year: 375 trades,
 *   28% winners, −10.4 pts a trade — see documents/GAP_RUNAWAY_Strategy_Guide.html.
 *
 * Contract:
 *   getConfig(prefix)                     -> live env read (never cached)
 *   minDailyBars(cfg)                     -> daily bars refused below
 *   computeDaily(daily, cfg)              -> { ema, rsi } 1:1 with daily (null = warm-up)
 *   dailySetup(daily, forDayKey, cfg)     -> yesterday's RSI zone + close, or a refusal
 *   getSignal({ setup, todayOpen, cfg })  -> { signal, side, entrySpot, slSpot, slPts, gapPts, ... }
 *   entryStillValid(side, price, slSpot)  -> false once the gap has filled
 *   stopHit(side, price, slSpot)          -> the per-tick stop test
 *   computeTrailEma(candles, cfg)         -> intraday EMA 1:1 with candles
 *   trailExit(side, bar, emaValue, cfg)   -> { exit, reason } on a CLOSED exit-TF bar
 *   isInEntryWindow / isEodExit(unixSec, cfg)
 */

const { EMA, RSI } = require("technicalindicators");

const NAME  = "GAP_RUNAWAY";
const LABEL = "GAP_runAway__Kirubakaran";
const DEFAULT_PREFIX = "GAP_RUNAWAY";
const PREFIXES = ["GAP_RUNAWAY", "GAP_RUNAWAY_STK"];
const REFERENCE_URL = "https://www.youtube.com/watch?v=uLTaXTyDxiI";
const DESCRIPTION =
  "GAP_runAway__Kirubakaran — daily RSI(10) on EMA21 below 10 + gap UP → CE, above 90 + gap DOWN → PE · " +
  "stop = yesterday's close (gap fill), trail = 5-min close through EMA21, square-off 15:15";

const TFS = [3, 5, 15];

function _r2(x) { return Math.round(x * 100) / 100; }
/** Finite-number guard. Number(null)===0 and Number("")===0 both invent a price. */
function _num(x) { return typeof x === "number" && Number.isFinite(x); }
/** IST calendar-day index. India has no DST, so a fixed +5:30 shift is exact. */
function _istDayOf(unixSec) { return Math.floor((unixSec + 19800) / 86400); }
/** IST minutes-of-day from a unix-SECONDS time. */
function _istMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _istDateStr(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function _okBar(c) {
  return !!c && _num(c.time) && _num(c.open) && _num(c.high) && _num(c.low) && _num(c.close);
}
/** "HH:MM" → minutes-of-day; anything malformed falls back to `def`. */
function _parseHHMM(raw, def) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(raw == null ? "" : raw));
  if (!m) return def;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return def;
  return h * 60 + mm;
}
function _fmtMins(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
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
function _prefixOf(p) {
  const s = String(p || "").trim().toUpperCase();
  return PREFIXES.includes(s) ? s : DEFAULT_PREFIX;
}

/**
 * Live config read. Settings saves mutate process.env in place, so this must
 * never be cached — every caller re-reads on each evaluation.
 */
function getConfig(prefix) {
  const P = _prefixOf(prefix);
  const tf = _intEnv(P + "_EXIT_TF", 5);
  let rsiLower = _numEnv(P + "_RSI_LOWER", 10, 0, 100);
  let rsiUpper = _numEnv(P + "_RSI_UPPER", 90, 0, 100);
  if (!(rsiUpper > rsiLower)) { rsiLower = 10; rsiUpper = 90; }
  let entryStart = _parseHHMM(process.env[P + "_ENTRY_START"], 9 * 60 + 15);
  let entryEnd   = _parseHHMM(process.env[P + "_ENTRY_END"], 9 * 60 + 30);
  if (!(entryEnd >= entryStart)) { entryStart = 9 * 60 + 15; entryEnd = 9 * 60 + 30; }
  return {
    PREFIX:           P,
    EMA_LENGTH:       _intEnv(P + "_EMA_LENGTH", 21, 2, 200),
    RSI_LENGTH:       _intEnv(P + "_RSI_LENGTH", 10, 2, 100),
    RSI_UPPER:        rsiUpper,
    RSI_LOWER:        rsiLower,
    MIN_GAP_PTS:      _numEnv(P + "_MIN_GAP_PTS", 0, 0),
    TRAIL_EMA_LENGTH: _intEnv(P + "_TRAIL_EMA_LENGTH", 21, 2, 200),
    EXIT_TF:          TFS.includes(tf) ? tf : 5,
    ENTRY_START:      entryStart,
    ENTRY_END:        entryEnd,
    EOD_EXIT:         _parseHHMM(process.env[P + "_EOD_EXIT_TIME"], 15 * 60 + 15),
  };
}

/**
 * Daily bars refused below. The EMA and the Wilder RSI are both seeded from
 * their first values, so they only match TradingView once the seed has decayed:
 * 100 bars at the defaults (the seed weight is then ~0.1%). Routes fetch
 * DAILY_LOOKBACK_DAYS (400 calendar days ≈ 270 sessions) so this never binds in
 * practice — it exists to refuse a broken / truncated feed.
 */
function minDailyBars(cfg) {
  cfg = cfg || getConfig();
  return Math.max(100, 3 * (cfg.EMA_LENGTH + cfg.RSI_LENGTH));
}
const DAILY_LOOKBACK_DAYS = 400;

/** Intraday bars before the trail EMA is defined. */
function trailWarmupBars(cfg) {
  cfg = cfg || getConfig();
  return cfg.TRAIL_EMA_LENGTH;
}

/**
 * Time-aligned daily series, 1:1 with `daily` (null on warm-up bars), so a chart
 * plots the exact numbers the decision read. `technicalindicators` alignment:
 *   EMA(p) over N closes → N−p+1 outputs, out[i] ↔ daily[i+p−1]
 *   RSI(L) over those M EMA values → M−L outputs, out[j] ↔ ema[j+L] ↔ daily[j+L+p−1]
 */
function computeDaily(daily, cfg) {
  cfg = cfg || getConfig();
  const n = Array.isArray(daily) ? daily.length : 0;
  const ema = new Array(n).fill(null);
  const rsi = new Array(n).fill(null);
  if (n < cfg.EMA_LENGTH) return { ema, rsi };
  const closes = daily.map((c) => c.close);
  const e = EMA.calculate({ period: cfg.EMA_LENGTH, values: closes });
  const p = cfg.EMA_LENGTH;
  for (let i = 0; i < e.length; i++) ema[i + p - 1] = e[i];
  if (e.length > cfg.RSI_LENGTH) {
    const r = RSI.calculate({ period: cfg.RSI_LENGTH, values: e });
    const L = cfg.RSI_LENGTH;
    for (let j = 0; j < r.length; j++) rsi[j + L + p - 1] = r[j];
  }
  return { ema, rsi };
}

/**
 * Yesterday's state for the session day `forDayKey` (an _istDayOf value):
 * the newest daily bar strictly BEFORE that day, its close, and the RSI / EMA
 * computed through it. Refuses (ready:false) rather than guessing:
 *   • two daily bars on one IST day → intraday candles were passed in;
 *   • fewer than minDailyBars() closed bars → warm-up;
 *   • the newest closed bar is more than 7 calendar days old → stale feed.
 */
function dailySetup(daily, forDayKey, cfg) {
  cfg = cfg || getConfig();
  const out = {
    ready: false, warmup: true, reason: null,
    forDayKey: _num(forDayKey) ? forDayKey : null,
    prevDate: null, prevDayKey: null, prevClose: null, prevRsi: null, prevEma: null,
    zone: null, rsiUpper: cfg.RSI_UPPER, rsiLower: cfg.RSI_LOWER,
    emaLength: cfg.EMA_LENGTH, rsiLength: cfg.RSI_LENGTH, bars: 0,
  };
  if (!_num(forDayKey)) { out.reason = "No session day given"; return out; }
  if (!Array.isArray(daily) || daily.length === 0) { out.reason = "No daily candles"; return out; }
  const seen = new Set();
  const hist = [];
  for (const c of daily) {
    if (!_okBar(c)) continue;
    const k = _istDayOf(c.time);
    if (seen.has(k)) { out.reason = "Two daily bars on one IST day — intraday candles were passed, refusing"; return out; }
    seen.add(k);
    if (k < forDayKey) hist.push(c);
  }
  hist.sort((a, b) => a.time - b.time);
  out.bars = hist.length;
  const need = minDailyBars(cfg);
  if (hist.length < need) { out.reason = `Warming up (${hist.length}/${need} closed daily candles)`; return out; }
  const last = hist[hist.length - 1];
  const lastKey = _istDayOf(last.time);
  if (forDayKey - lastKey > 7) {
    out.reason = `Stale daily data — newest closed bar is ${_istDateStr(last.time)}, ${forDayKey - lastKey} days before the session`;
    return out;
  }
  const s = computeDaily(hist, cfg);
  const rsi = s.rsi[hist.length - 1];
  const ema = s.ema[hist.length - 1];
  if (!_num(rsi) || !_num(ema)) { out.reason = "RSI / EMA not defined on yesterday's bar"; return out; }
  out.ready = true;
  out.warmup = false;
  out.prevDate = _istDateStr(last.time);
  out.prevDayKey = lastKey;
  out.prevClose = _r2(last.close);
  out.prevRsi = _r2(rsi);
  out.prevEma = _r2(ema);
  out.zone = rsi < cfg.RSI_LOWER ? "OVERSOLD" : rsi > cfg.RSI_UPPER ? "OVERBOUGHT" : "NEUTRAL";
  out.reason = out.zone === "OVERSOLD"
    ? `RSI ${out.prevRsi} < ${cfg.RSI_LOWER} — oversold, a gap UP buys CE`
    : out.zone === "OVERBOUGHT"
      ? `RSI ${out.prevRsi} > ${cfg.RSI_UPPER} — overbought, a gap DOWN buys PE`
      : `RSI ${out.prevRsi} between ${cfg.RSI_LOWER} and ${cfg.RSI_UPPER} — no setup today`;
  return out;
}

const _NO = { side: null, entrySpot: null, slSpot: null, slPts: null, gapPts: null, gapPct: null, gapDir: null };

/**
 * The day's decision. `setup` = dailySetup(...) for today; `todayOpen` = today's
 * official open. Returns { signal: "BUY_CE"|"BUY_PE"|"NONE", side, reason,
 * skipReason, entrySpot, slSpot, slPts, gapPts (signed), gapPct, gapDir,
 * prevClose, prevRsi, prevEma, prevDate, zone, warmup }.
 *   skipReason: "warmup" | "no_open" | "neutral" | "no_gap" | "gap_wrong_way" | "gap_too_small"
 */
function getSignal(opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig(o.prefix);
  const st = o.setup || null;
  const base = {
    prevClose: st ? st.prevClose : null, prevRsi: st ? st.prevRsi : null, prevEma: st ? st.prevEma : null,
    prevDate: st ? st.prevDate : null, zone: st ? st.zone : null, todayOpen: _num(o.todayOpen) ? _r2(o.todayOpen) : null,
  };
  if (!st || !st.ready) {
    return Object.assign({ signal: "NONE", warmup: true, skipReason: "warmup", reason: (st && st.reason) || "Daily setup not ready" }, _NO, base);
  }
  if (!_num(o.todayOpen) || !(o.todayOpen > 0)) {
    return Object.assign({ signal: "NONE", warmup: false, skipReason: "no_open", reason: "Today's open is not known yet" }, _NO, base);
  }
  const open = o.todayOpen;
  const gap = open - st.prevClose;
  const gapDir = gap > 0 ? "UP" : gap < 0 ? "DOWN" : "NONE";
  const g = {
    gapPts: _r2(gap), gapPct: st.prevClose > 0 ? _r2((gap / st.prevClose) * 100) : null, gapDir,
  };
  const gapTxt = `open ${_r2(open)} vs prev close ${st.prevClose} (${gap >= 0 ? "+" : ""}${_r2(gap)})`;
  const none = (skipReason, reason) => Object.assign({ signal: "NONE", warmup: false, skipReason, reason }, _NO, g, base);

  if (st.zone === "NEUTRAL") return none("neutral", `${st.reason} · ${gapTxt}`);
  if (gapDir === "NONE") return none("no_gap", `RSI ${st.prevRsi} ${st.zone.toLowerCase()} but no gap · ${gapTxt}`);
  const want = st.zone === "OVERSOLD" ? "UP" : "DOWN";
  if (gapDir !== want) {
    return none("gap_wrong_way", `RSI ${st.prevRsi} ${st.zone.toLowerCase()} needs a gap ${want}, got gap ${gapDir} · ${gapTxt}`);
  }
  if (Math.abs(gap) < cfg.MIN_GAP_PTS) {
    return none("gap_too_small", `Gap ${_r2(Math.abs(gap))} pts below the ${cfg.MIN_GAP_PTS}-pt minimum · ${gapTxt}`);
  }
  const side = want === "UP" ? "CE" : "PE";
  return Object.assign({
    signal: side === "CE" ? "BUY_CE" : "BUY_PE",
    warmup: false,
    skipReason: null,
    side,
    entrySpot: _r2(open),
    slSpot: st.prevClose,
    slPts: _r2(Math.abs(gap)),
    reason: side === "CE"
      ? `Oversold RSI ${st.prevRsi} < ${cfg.RSI_LOWER} + gap UP ${_r2(gap)} pts · SL = prev close ${st.prevClose}`
      : `Overbought RSI ${st.prevRsi} > ${cfg.RSI_UPPER} + gap DOWN ${_r2(Math.abs(gap))} pts · SL = prev close ${st.prevClose}`,
  }, g, base);
}

/** Per-tick stop test against the gap-fill LEVEL. Non-finite input never fires. */
function stopHit(side, price, slSpot) {
  if (!_num(price) || !_num(slSpot) || !(price > 0)) return false;
  if (side === "CE") return price <= slSpot;
  if (side === "PE") return price >= slSpot;
  return false;
}

/** An entry is valid only while the gap is still open at the fill price. */
function entryStillValid(side, price, slSpot) {
  if (!_num(price) || !_num(slSpot) || !(price > 0)) return false;
  return !stopHit(side, price, slSpot);
}

/** Intraday trail EMA, 1:1 with `candles` (null on warm-up bars). */
function computeTrailEma(candles, cfg) {
  cfg = cfg || getConfig();
  const n = Array.isArray(candles) ? candles.length : 0;
  const out = new Array(n).fill(null);
  const p = cfg.TRAIL_EMA_LENGTH;
  if (n < p) return out;
  const e = EMA.calculate({ period: p, values: candles.map((c) => c.close) });
  for (let i = 0; i < e.length; i++) out[i + p - 1] = e[i];
  return out;
}

/**
 * The trailing-EMA exit on ONE closed exit-TF bar. `emaValue` must be the EMA
 * computed THROUGH that bar (computeTrailEma(...)[idx]). Warm-up (no EMA) never
 * exits — the stop and the EOD square-off still protect the position.
 */
function trailExit(side, bar, emaValue, cfg) {
  cfg = cfg || getConfig();
  if (!_okBar(bar) || !_num(emaValue)) return { exit: false, reason: null };
  const e = _r2(emaValue);
  if (side === "CE" && bar.close < emaValue) {
    return { exit: true, reason: `${cfg.EXIT_TF}-min close ${_r2(bar.close)} below EMA${cfg.TRAIL_EMA_LENGTH} ${e}` };
  }
  if (side === "PE" && bar.close > emaValue) {
    return { exit: true, reason: `${cfg.EXIT_TF}-min close ${_r2(bar.close)} above EMA${cfg.TRAIL_EMA_LENGTH} ${e}` };
  }
  return { exit: false, reason: null };
}

/** True while `unixSec` is inside the entry window [ENTRY_START, ENTRY_END] (minutes, inclusive). */
function isInEntryWindow(unixSec, cfg) {
  cfg = cfg || getConfig();
  const m = _istMins(unixSec);
  return m >= cfg.ENTRY_START && m <= cfg.ENTRY_END;
}

/** True when the given time is at/after the forced square-off. */
function isEodExit(unixSec, cfg) {
  cfg = cfg || getConfig();
  return _istMins(unixSec) >= cfg.EOD_EXIT;
}

/** The YouTube reference link (Settings key {P}_REFERENCE_URL, default the video). */
function referenceUrl(prefix) {
  const P = _prefixOf(prefix);
  const v = String(process.env[P + "_REFERENCE_URL"] || "").trim();
  return /^https?:\/\//i.test(v) ? v : REFERENCE_URL;
}

module.exports = {
  NAME, LABEL, DESCRIPTION, PREFIXES, DEFAULT_PREFIX, REFERENCE_URL, DAILY_LOOKBACK_DAYS,
  getConfig, minDailyBars, trailWarmupBars, computeDaily, dailySetup, getSignal,
  stopHit, entryStillValid, computeTrailEma, trailExit, isInEntryWindow, isEodExit, referenceUrl,
  _istDayOf, _istMins, _istDateStr, _fmtMins, _num,
};

/**
 * STRATEGY: SAIL_VWAP_ST  (created 2026-10-20)
 * ═════════════════════════════════════════════════════════════════════════════
 * VWAP cross + breakout confirmation, SuperTrend-confirmed — on SAIL STOCK OPTIONS.
 * Option BUYING · intraday · Fyers data (NSE:SAIL-EQ), Zerodha orders.
 *
 * Chart: SAIL 5-min candles (SAIL_VWAP_ST_TF = 3 | 5 | 15, default 5), the
 * session VWAP on hlc3 (matches the user's Kite "VWAP hlc3 Session") and
 * SuperTrend(10, 2). Every value is read on a CLOSED candle.
 *
 *   VWAP[i] = Σ(hlc3 × volume) / Σ volume over THAT IST day's candles 0..i.
 *   It restarts every day. No volume yet today → no VWAP → the engine refuses.
 *
 * ── ENTRY — BUY_CE (upside), all on closed candles ───────────────────────────
 *   1. CROSS: a candle (the "cross candle") closes ABOVE VWAP while the candle
 *      before it, the same day, closed at or below VWAP.
 *   2. BREAKOUT CONFIRMATION: within the next SAIL_VWAP_ST_BREAKOUT_BARS (3)
 *      candles, one CLOSES ABOVE the cross candle's HIGH. That candle is the
 *      signal candle. Only the FIRST such close counts — if it is refused (say,
 *      outside the entry window) the setup is used up, never re-armed.
 *   3. Every close from the cross candle to the signal candle stays above VWAP.
 *      One close back at/below VWAP cancels the setup.
 *   4. SuperTrend is GREEN on the signal candle (user's choice 2026-10-20: a CE
 *      while SuperTrend is red is SKIPPED).
 * ── ENTRY — BUY_PE (downside), the exact mirror ──────────────────────────────
 *   Cross candle closes BELOW VWAP (previous at/above); a later candle within 3
 *   closes BELOW the cross candle's LOW; no close back at/above VWAP; SuperTrend
 *   RED. Example (CE): VWAP 169.68, the 10:05 candle closes 169.80 (cross, high
 *   169.90), the 10:10 candle closes 170.05 > 169.90 → BUY the ATM SAIL CE.
 *   Paper/Live fill at the first tick after the signal candle closes; Backtest
 *   at the next bar's open — the same market moment.
 *
 * ── EXIT — none here. Paper exits ONLY through the repo-wide profit lock
 *   (tradeGuards.checkProfitLock, per tick on the option premium), plus manual
 *   exit and the global session teardown; the backtest applies the same lock
 *   to its simulated premium and closes anything still open at day end.
 *
 * ── SESSION ─────────────────────────────────────────────────────────────────
 *   Entries 09:30–14:30 on the signal candle's close, strike ATM (₹2.5 grid),
 *   monthly expiry, SAIL_VWAP_ST_LOTS lots of SAIL_LOT_SIZE (4700).
 *
 * ── DELIBERATELY NOT HERE (do not "helpfully" add these) ────────────────────
 *   No RSI, EMA, ADX, VIX, OI, volume filter, ATR filter, multi-timeframe.
 *   No futures mode — SAIL options only, whatever the NIFTY INSTRUMENT toggle says.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 *   Decisions read closed-candle OHLC + volume only — never live spot — so
 *   Paper, Live, Replay and Backtest decide identically on the same candles.
 *   Live candles take their volume from the tick's cumulative day volume
 *   (vol_traded_today) differences, which the tick recorder stores raw.
 *
 * ── NOT MARKET-VALIDATED ────────────────────────────────────────────────────
 *   Zero trades, paper or live. Every number is the user's rule, not a fit.
 *
 * Contract:
 *   getConfig()                            -> live env read (never cached)
 *   warmupBars(cfg) / warmupDays()         -> bars refused below / days to preload
 *   computeSeries(candles, cfg)            -> { vwap, supertrend } 1:1 with candles
 *   getSignal(candles, opts)               -> { signal, reason, setup, ... }
 *   lotQty(cfg)                            -> SAIL_VWAP_ST_LOTS × SAIL lot size
 *   forPrefix(prefix, opts)                -> this same API reading `${prefix}_*` keys
 *
 * ── ENV PREFIX / OTHER MARKETS ──────────────────────────────────────────────
 *   The strategy's own keys are read under SAIL_VWAP_ST_ (its home, SAIL).
 *   Another market's pair (NIFTY_SAIL_VWAP_ST, BN_SAIL_VWAP_ST, FUT_… , CRUDE_…)
 *   runs these exact rules via forPrefix("<PAIR PREFIX>"), reading its own key
 *   when set, else SAIL's SAIL_VWAP_ST_* value (config/pairs.js envGet).
 *   forPrefix(p, { equalWeightVwap: true }) — a market whose candles carry no
 *   volume (an INDEX: NIFTY / NIFTY BANK / SENSEX ticks have no traded volume,
 *   and the NIFTY futures pair builds its candles on the index) computes the
 *   session VWAP EQUAL-WEIGHTED (each candle's hlc3 counts once), the way
 *   EMA9_VWAP does on NIFTY, so paper (no tick volume) and backtest (Fyers index
 *   history) compute the same line. SAIL (and MCX futures) stay volume-weighted.
 *   Omitting the prefix keeps every existing caller on SAIL_VWAP_ST_ exactly.
 */

const { computeSuperTrend } = require("../utils/supertrend");

const NAME   = "SAIL_VWAP_ST";
const PREFIX = "SAIL_VWAP_ST";
const UNDERLYING = "SAIL";
const DESCRIPTION =
  "VWAP_ST — SAIL 5-min VWAP cross, entered only after a candle closes beyond the cross candle's high/low, " +
  "SuperTrend(10,2) must agree · profit-lock exit · SAIL options, Zerodha";

const TFS = [3, 5, 15];

// ── primitives ───────────────────────────────────────────────────────────────
function _r2(x) { return Math.round(x * 100) / 100; }
/** Finite-number guard. Number(null)===0 and Number("")===0 both invent a price. */
function _num(x) { return typeof x === "number" && Number.isFinite(x); }
/** IST calendar-day index. India has no DST, so a fixed +5:30 shift is exact. */
function _istDayOf(unixSec) { return Math.floor((unixSec + 19800) / 86400); }
/** IST minutes-of-day from a unix-SECONDS time. */
function _istMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _okBar(c) {
  return !!c && _num(c.time) && _num(c.open) && _num(c.high) && _num(c.low) && _num(c.close);
}
function _hhmm(unixSec) { return _fmtMins(_istMins(unixSec)); }

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
// Env read for one key. The SAIL prefix (SAIL_VWAP_ST) reads process.env
// exactly as it always did; another market's pair reads with pair inheritance:
// its own key when set, else SAIL's (config/pairs.js envGet).
let _pairsMod = null;
function _rawEnv(key, pairRead) {
  if (!pairRead) return process.env[key];
  if (!_pairsMod) _pairsMod = require("../config/pairs");
  return _pairsMod.envGet(key);
}
function _numEnv(key, def, min, max, pairRead) {
  const v = parseFloat(_rawEnv(key, pairRead));
  if (!Number.isFinite(v)) return def;
  if (min != null && v < min) return def;
  if (max != null && v > max) return def;
  return v;
}
function _intEnv(key, def, min, max, pairRead) {
  const v = parseInt(_rawEnv(key, pairRead), 10);
  if (!Number.isFinite(v)) return def;
  if (min != null && v < min) return def;
  if (max != null && v > max) return def;
  return v;
}

function _prefixOf(prefix) {
  const p = String(prefix == null ? "" : prefix).trim().replace(/_+$/, "");
  return p || PREFIX;
}

/**
 * Live config read. Settings saves mutate process.env in place, so this must
 * never be cached — every caller re-reads on each evaluation.
 * `prefix` (optional) — read `${prefix}_*` instead of SAIL_VWAP_ST_*.
 */
function getConfig(prefix) {
  const P  = _prefixOf(prefix);
  const pr = P !== PREFIX;     // a market pair: read through pairs.envGet
  const tf = _intEnv(P + "_TF", 5, undefined, undefined, pr);
  return {
    PREFIX: P,
    UNDERLYING,
    TRADE_RES:      TFS.includes(tf) ? tf : 5,
    ST_PERIOD:      _intEnv(P + "_ST_PERIOD", 10, 2, 100, pr),
    ST_MULT:        _numEnv(P + "_ST_MULT", 2, 0.1, 10, pr),
    BREAKOUT_BARS:  _intEnv(P + "_BREAKOUT_BARS", 3, 1, 10, pr),

    ENTRY_START:    _parseHHMM(_rawEnv(P + "_ENTRY_START", pr), 9 * 60 + 30),
    ENTRY_END:      _parseHHMM(_rawEnv(P + "_ENTRY_END", pr), 14 * 60 + 30),

    // Sizing. Route-level, read here so one config describes the mode.
    LOTS:             _intEnv(P + "_LOTS", 1, 1, 50, pr),
  };
}

/**
 * Bars the engine refuses below. SuperTrend(10) needs 11 bars before its first
 * value and is path-dependent, so the routes preload whole DAYS
 * (SAIL_VWAP_ST_WARMUP_DAYS) — a 09:15 start then trades from the first close.
 */
function warmupBars(cfg) {
  cfg = cfg || getConfig();
  return cfg.ST_PERIOD + 7;
}
function warmupDays(prefix) {
  const P = _prefixOf(prefix);
  return _intEnv(P + "_WARMUP_DAYS", 2, 1, 15, P !== PREFIX);
}

/** Entry window on the signal candle's CLOSE time (= the moment the entry fills). */
function isInTradingWindow(barTimeSec, cfg) {
  cfg = cfg || getConfig();
  const closeMin = _istMins(barTimeSec + cfg.TRADE_RES * 60);
  if (closeMin < cfg.ENTRY_START) return { ok: false, reason: `Before ${_fmtMins(cfg.ENTRY_START)} — outside the entry window` };
  if (closeMin > cfg.ENTRY_END)   return { ok: false, reason: `After ${_fmtMins(cfg.ENTRY_END)} — no new entries` };
  return { ok: true, reason: null };
}

// ── indicator series ─────────────────────────────────────────────────────────
/**
 * Session VWAP on hlc3, restarting each IST day. 1:1 with `candles`; null where
 * the day has no volume yet (a missing/negative volume counts as 0).
 * `equalWeight` — every valid candle weighs 1 (a market with no volume; see
 * forPrefix). Omitted: volume-weighted, exactly as SAIL always computed it.
 */
function computeVwap(candles, equalWeight) {
  const n = Array.isArray(candles) ? candles.length : 0;
  const out = new Array(n).fill(null);
  let day = null, pv = 0, vol = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (!_okBar(c)) { out[i] = null; continue; }
    const k = _istDayOf(c.time);
    if (k !== day) { day = k; pv = 0; vol = 0; }
    const v = equalWeight ? 1 : (_num(c.volume) && c.volume > 0 ? c.volume : 0);
    pv  += ((c.high + c.low + c.close) / 3) * v;
    vol += v;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

/** Time-aligned series so a chart plots the EXACT numbers the signal read. */
function computeSeries(candles, cfg) {
  cfg = cfg || getConfig();
  const n = Array.isArray(candles) ? candles.length : 0;
  if (n === 0) return { vwap: [], supertrend: [] };
  return {
    vwap: cfg.VWAP_WEIGHT === "equal" ? computeVwap(candles, true) : computeVwap(candles),
    supertrend: computeSuperTrend(candles, cfg.ST_PERIOD, cfg.ST_MULT),
  };
}

/** Did candle k cross VWAP on its close? +1 up, -1 down, 0 no (same day only). */
function _crossAt(candles, vwap, k) {
  if (k < 1) return 0;
  const c = candles[k], p = candles[k - 1];
  if (!_okBar(c) || !_okBar(p)) return 0;
  if (_istDayOf(c.time) !== _istDayOf(p.time)) return 0;   // VWAP restarts daily
  if (!_num(vwap[k]) || !_num(vwap[k - 1])) return 0;
  if (c.close > vwap[k] && p.close <= vwap[k - 1]) return 1;
  if (c.close < vwap[k] && p.close >= vwap[k - 1]) return -1;
  return 0;
}

/**
 * The live setup as of candle `last`: the most recent VWAP cross within the
 * last BREAKOUT_BARS candles, and whether `last` is its breakout confirmation.
 * A cross ON `last` is a fresh setup (waiting, 0 candles used) — the cross
 * candle itself can never be the entry. Pure function of closed candles.
 * @returns {null | { side, crossIdx, crossTime, level, vwapAtCross, barsSince,
 *                    status: "confirmed"|"waiting"|"cancelled"|"used"|"expired", why }}
 */
function findSetup(candles, vwap, last, cfg) {
  const N = cfg.BREAKOUT_BARS;
  const day = _istDayOf(candles[last].time);
  for (let k = last; k >= Math.max(1, last - N); k--) {
    if (_istDayOf(candles[k].time) !== day) break;
    const dir = _crossAt(candles, vwap, k);
    if (!dir) continue;
    const side = dir === 1 ? "CE" : "PE";
    const ck = candles[k];
    const level = dir === 1 ? ck.high : ck.low;
    const out = {
      side, crossIdx: k, crossTime: ck.time, level: _r2(level),
      vwapAtCross: _r2(vwap[k]), barsSince: last - k, status: "waiting", why: null,
    };
    // Every close after the cross, up to and including `last`, must stay on the
    // cross side of VWAP; an earlier close beyond the level already used it up.
    for (let j = k + 1; j <= last; j++) {
      const cj = candles[j];
      if (!_num(vwap[j])) { out.status = "cancelled"; out.why = "no VWAP"; return out; }
      const sideOk = dir === 1 ? cj.close > vwap[j] : cj.close < vwap[j];
      if (!sideOk) {
        out.status = "cancelled";
        out.why = `${_hhmm(cj.time + cfg.TRADE_RES * 60)} closed ${cj.close} back ${dir === 1 ? "at/below" : "at/above"} VWAP ${_r2(vwap[j])}`;
        return out;
      }
      const broke = dir === 1 ? cj.close > level : cj.close < level;
      if (broke) {
        if (j < last) {
          out.status = "used";
          out.why = `breakout already confirmed on the ${_hhmm(cj.time + cfg.TRADE_RES * 60)} close`;
          return out;
        }
        out.status = "confirmed";
        return out;
      }
    }
    if (k < last && last - k >= N) { out.status = "expired"; out.why = `no close beyond ${out.level} within ${N} candles`; }
    return out;
  }
  return null;
}

const _NO = { entrySpot: null };

/**
 * getSignal(candles, opts)
 *   candles — ascending CLOSED bars on the trade timeframe (with volume); the
 *             LAST one is the candidate signal candle.
 *   opts.precomputed   — OFFLINE / BACKTEST: { series, endIdx, cfg } over the whole
 *                        array. Both indicators are causal, so it equals
 *                        recomputing on candles.slice(0, endIdx + 1).
 *   opts.silent        — no console line on a signal.
 *   opts.cfg           — the config to decide on (forPrefix() passes its own);
 *                        default getConfig() — SAIL's keys.
 * Returns { signal: "BUY_CE"|"BUY_PE"|"NONE", reason, warmup,
 *           entrySpot, vwap, supertrend, stTrend, setup, crossLevel, ... }.
 */
function getSignal(candles, opts) {
  const o = opts || {};
  const pre = o.precomputed || null;
  const cfg = (pre && pre.cfg) || o.cfg || getConfig();
  const WARMUP = warmupBars(cfg);
  const nBars = !Array.isArray(candles) ? 0 : pre ? pre.endIdx + 1 : candles.length;
  if (nBars < WARMUP) {
    return Object.assign({ signal: "NONE", warmup: true, setup: null, reason: `Warming up (${nBars}/${WARMUP} ${cfg.TRADE_RES}-min candles)` }, _NO);
  }
  const last = nBars - 1;
  const bar = candles[last];
  if (!_okBar(bar) || !_okBar(candles[last - 1])) {
    return Object.assign({ signal: "NONE", warmup: true, setup: null, reason: "Bad candle data (non-finite OHLC on the signal or previous candle)" }, _NO);
  }

  const series = pre ? pre.series : computeSeries(candles, cfg);
  const vw = series.vwap[last];
  const st = series.supertrend[last];
  const base = {
    warmup: false,
    vwap: _num(vw) ? _r2(vw) : null,
    supertrend: st && _num(st.value) ? _r2(st.value) : null,
    stTrend: st && st.trend === 1 ? "BULLISH" : st && st.trend === -1 ? "BEARISH" : null,
    stTrendInt: st && (st.trend === 1 || st.trend === -1) ? st.trend : null,
    tradeRes: cfg.TRADE_RES,
    entrySpot: bar.close,
    setup: null, crossLevel: null, crossTime: null,
    signalStrength: "STRONG",
  };
  if (base.vwap == null) {
    return Object.assign({}, base, { signal: "NONE", warmup: true, reason: `No VWAP — no ${cfg.UNDERLYING} volume today yet, refusing to trade` });
  }
  if (base.supertrend == null || base.stTrendInt == null) {
    return Object.assign({}, base, { signal: "NONE", warmup: true, reason: "SuperTrend not ready" });
  }

  const setup = findSetup(candles, series.vwap, last, cfg);
  base.setup = setup;
  const tag = cfg.TRADE_RES + "m";
  if (!setup) {
    return Object.assign({}, base, {
      signal: "NONE",
      reason: `${tag} no VWAP cross in the last ${cfg.BREAKOUT_BARS} candles (close ${bar.close} ${bar.close > base.vwap ? ">" : "<="} VWAP ${base.vwap})`,
    });
  }
  base.crossLevel = setup.level;
  base.crossTime = setup.crossTime;
  const crossAt = _hhmm(setup.crossTime + cfg.TRADE_RES * 60);
  if (setup.status !== "confirmed") {
    const what = setup.status === "waiting"
      ? `waiting — needs a close ${setup.side === "CE" ? "above" : "below"} ${setup.level} (${setup.barsSince}/${cfg.BREAKOUT_BARS} candles used)`
      : `${setup.status} — ${setup.why}`;
    return Object.assign({}, base, { signal: "NONE", reason: `${setup.side} setup (VWAP cross ${crossAt}) ${what}` });
  }

  const side = setup.side;
  if (!o.skipTimeCheck) {
    const w = isInTradingWindow(bar.time, cfg);
    if (!w.ok) return Object.assign({}, base, { signal: "NONE", skipReason: "window", reason: `${side} breakout confirmed but ${w.reason}` });
  }
  // SuperTrend must agree: green (line below the close) for CE, red for PE.
  const stv = base.supertrend;
  if (side === "CE" && !(base.stTrendInt === 1 && stv < bar.close)) {
    return Object.assign({}, base, { signal: "NONE", skipReason: "st_disagrees", reason: `CE breakout confirmed but SuperTrend is RED (${stv}) — skipped` });
  }
  if (side === "PE" && !(base.stTrendInt === -1 && stv > bar.close)) {
    return Object.assign({}, base, { signal: "NONE", skipReason: "st_disagrees", reason: `PE breakout confirmed but SuperTrend is GREEN (${stv}) — skipped` });
  }
  const reason = side === "CE"
    ? `CE ${tag}: VWAP cross ${crossAt} (C>${setup.vwapAtCross}) → close ${bar.close} > cross high ${setup.level} | VWAP ${base.vwap} | ST green ${stv}`
    : `PE ${tag}: VWAP cross ${crossAt} (C<${setup.vwapAtCross}) → close ${bar.close} < cross low ${setup.level} | VWAP ${base.vwap} | ST red ${stv}`;
  if (!o.silent) console.log(`[${cfg.PREFIX}] 🟢 ${side === "CE" ? "BUY_CE" : "BUY_PE"} — ${reason}`);
  return Object.assign({}, base, { signal: side === "CE" ? "BUY_CE" : "BUY_PE", reason });
}

/** Contracts per trade: SAIL_VWAP_ST_LOTS × the SAIL lot size (SAIL_LOT_SIZE). */
function lotQty(cfg) {
  cfg = cfg || getConfig();
  const lot = require("../config/instrument").underlyingOf(UNDERLYING).lotSize;
  return lot * cfg.LOTS;
}

/**
 * The same API bound to a pair's env prefix (BN_SAIL_VWAP_ST, NIFTY_SAIL_VWAP_ST …).
 *   opts.equalWeightVwap — the session VWAP weighs every candle equally (an
 *                          index market with no volume — see the file header).
 *   opts.label           — the instrument named in "no <label> volume" reasons.
 * forPrefix("SAIL_VWAP_ST") with no opts decides exactly like the module itself.
 */
const _bound = new Map();
function forPrefix(prefix, opts) {
  const P  = _prefixOf(prefix);
  const eq = !!(opts && opts.equalWeightVwap);
  const label = (opts && opts.label) || UNDERLYING;
  const key = `${P}|${eq ? 1 : 0}|${label}`;
  if (_bound.has(key)) return _bound.get(key);
  const gc = () => {
    const c = getConfig(P);
    c.UNDERLYING = label;
    if (eq) c.VWAP_WEIGHT = "equal";
    return c;
  };
  const api = Object.assign({}, module.exports, {
    NAME: P,
    PREFIX: P,
    getConfig: gc,
    warmupBars: (cfg) => warmupBars(cfg || gc()),
    warmupDays: () => warmupDays(P),
    isInTradingWindow: (t, cfg) => isInTradingWindow(t, cfg || gc()),
    computeSeries: (candles, cfg) => computeSeries(candles, cfg || gc()),
    getSignal: (candles, o) => getSignal(candles, Object.assign({}, o, { cfg: (o && o.cfg) || gc() })),
    lotQty: (cfg) => lotQty(cfg || gc()),
  });
  _bound.set(key, api);
  return api;
}

module.exports = {
  NAME,
  PREFIX,
  UNDERLYING,
  DEFAULT_PREFIX: PREFIX,
  DESCRIPTION,
  TFS,
  getConfig,
  warmupBars,
  warmupDays,
  isInTradingWindow,
  computeVwap,
  computeSeries,
  findSetup,
  getSignal,
  lotQty,
  forPrefix,
  _istDayOf,
  _istMins,
};

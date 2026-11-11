/**
 * syntheticMarket.js — a seeded, fully deterministic fake NIFTY market
 * ─────────────────────────────────────────────────────────────────────────────
 * Used by scripts/strategyBaseline.js to build golden paper-trade baselines.
 * Nothing here reads the clock, the network or the disk: every number is a pure
 * function of the constants below, so two runs (or two machines) produce the
 * same bytes.
 *
 * One continuous market is generated from ANCHOR_DATE forward, one trading day
 * at a time (weekdays minus the NSE holiday list). Ordinary days are a random
 * walk around a scheduled drift (DRIFT); the SESSION days the baseline actually
 * replays follow a scripted intraday path (trend up/down, chop, gap up/down,
 * V reversal, range breakout, a hand-built smart-money order-block day) so the
 * strategies have something to trade. Because the chain is continuous, the
 * warm-up history, daily indicators and prior-day levels a strategy fetches at
 * /start are consistent with the session it then trades.
 *
 * Exports:
 *   SESSIONS                     the replayed days (date, regime, weekly expiry, …)
 *   dayTicks(date)               2-second spot ticks for a session day
 *   intradayBars(date, res)      full-day bars at `res` minutes
 *   intradayBarsAsOf(d, res, t)  bars as a broker would serve them at instant t
 *   dailyBar(date)               the day's OHLC (stamped 00:00 IST, like Fyers)
 *   vixAt(date, tMs, spot)       India VIX at a moment
 *   optionPremium(...)           Black-Scholes premium on the 0.05 tick grid
 *   tradingDaysBetween(a, b)     inclusive list of "YYYY-MM-DD" trading days
 */

"use strict";

const IST_OFFSET_MS = 19800000;            // +05:30
const TICK_MS       = 2000;                // one spot tick every 2 s
const OPEN_MIN      = 9 * 60 + 15;         // 09:15 IST
const CLOSE_MIN     = 15 * 60 + 30;        // 15:30 IST
const SESSION_MIN   = CLOSE_MIN - OPEN_MIN;                              // 375
const TICKS_PER_DAY = (SESSION_MIN * 60 * 1000) / TICK_MS;               // 11,250

const ANCHOR_DATE  = "2025-06-02";   // history before this does not exist (served as no bars)
const ANCHOR_PRICE = 25700;

// Mirrors the fallback list in src/utils/nseHolidays.js — the replay's holiday
// lookups fall back to that list because the network is blocked.
const HOLIDAYS = new Set([
  "2025-10-02", "2025-10-21", "2025-10-22", "2025-11-05", "2025-12-25",
  "2026-01-15", "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31",
  "2026-04-03", "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26",
  "2026-09-14", "2026-10-02", "2026-10-20", "2026-11-10", "2026-11-24",
  "2026-12-25",
]);

// ── Session scripts ──────────────────────────────────────────────────────────
// path: [minute-from-09:15, % from open] waypoints joined linearly, or a
//       function of u ∈ [0,1] returning % from open.
// pts:  the same, in index points (the hand-built SMC day).
// noise: { bridge: per-tick σ as a fraction of price for a Brownian bridge
//          pinned at both ends, ou: stationary σ in points of a ~3-minute
//          mean-reverting jitter }.
const _TREND_UP = [[0, 0], [15, 0.22], [45, 0.15], [90, 0.50], [120, 0.42], [180, 0.82], [210, 0.72], [270, 1.10], [300, 1.00], [375, 1.35]];
// Gap day: a strong 09:15 candle, a pause INSIDE it until 10:00, then the move
// resumes — so opening-range and previous-day-range breaks land after the
// common 10:00 entry start instead of before it.
const _GAP_UP   = [[0, 0], [10, 0.32], [15, 0.27], [25, 0.22], [45, 0.20], [52, 0.36], [90, 0.48], [120, 0.40], [180, 0.62], [240, 0.55], [300, 0.75], [375, 0.72]];
const _scale = (pts, k) => pts.map(([m, p]) => [m, p * k]);
// Smart-money order-block long, in points (see src/strategies/price_action.js):
// swing high (m22), minor low (m33), block candle sweeping it (m40 bar, low -26),
// a gap above the block (m50 bar), close break (m50), inducement pullbacks
// (m65, m80) swept at m90, return into the block (m105-110), up close (m115).
const _SMC_LONG = [[0, 0], [10, -5], [20, 15], [22, 25], [30, -15], [33, -17], [35, -8], [38, -10], [40, -12], [41, -20],
  [42, -26], [45, -21], [50, 15], [55, 35], [60, 45], [65, 32], [70, 50], [75, 55], [80, 40], [85, 52], [90, 35],
  [100, 5], [107, -16], [110, -20], [115, -12], [125, 15], [145, 40], [150, 30]];
// Opening-range breakout + retest (src/strategies/itm20_scalp.js), in points: a
// tight 09:15–09:30 range (≈ -10…+12), a 09:35 close well above it, a 09:40
// candle that dips back to the range high but closes above it, a 09:45 green
// close above the prior high — then a whipsaw session for the band/RSI engines.
const _OR_RETEST_WHIPSAW = [[0, 0], [4, 12], [8, -10], [12, 10], [14.9, 5], [20, 8], [21, 10], [24.5, 50], [25, 48],
  [27, 14], [29.9, 30], [30, 30], [34.9, 60], [45, 110], [60, 120], [90, 40], [120, -60], [150, 20], [180, 90],
  [210, -10], [240, -70], [270, 10], [300, 40], [375, 20]];
function _smcDay() {
  const out = _SMC_LONG.slice();
  const m0 = 155, base = 30;   // afternoon: the same structure mirrored (a short)
  for (const [m, p] of _SMC_LONG) out.push([m0 + m, base - p]);
  out.push([375, base - 30 - 12]);
  return out;
}

/**
 * The replayed sessions — weekdays, no holidays. 10-06 and 10-13 are NIFTY
 * weekly-expiry Tuesdays traded on the day; 09-28 trades the SEPTEMBER MONTHLY
 * contract (29-Sep is that month's last Tuesday, so its code is "26SEP").
 */
const SESSIONS = [
  { date: "2026-09-07", regime: "gap_down",        expiry: "2026-09-08", gap: -0.0095, path: _scale(_GAP_UP, -1.0),  vix: 14.8, noise: { bridge: 0.00008, ou: 4 } },
  { date: "2026-09-28", regime: "gap_up",          expiry: "2026-09-29", gap:  0.0090, path: _GAP_UP,                vix: 15.2, noise: { bridge: 0.00008, ou: 4 } },
  { date: "2026-09-30", regime: "smc_order_block", expiry: "2026-10-06", gap:  0,      pts: _smcDay(),               vix: 14.0, noise: { bridge: 0, ou: 2.5 } },
  { date: "2026-10-05", regime: "trend_up",        expiry: "2026-10-06", gap:  0.0010, path: _TREND_UP,              vix: 12.6, noise: { bridge: 0.00018, ou: 5 } },
  { date: "2026-10-06", regime: "v_reversal",      expiry: "2026-10-06", gap: -0.0015,
    path: [[0, 0], [30, -0.25], [60, -0.18], [110, -0.80], [150, -1.05], [165, -0.95], [190, -0.70], [240, -0.30], [300, 0.0], [375, 0.38]],
    vix: 14.4, noise: { bridge: 0.00015, ou: 5 } },
  { date: "2026-10-07", regime: "trend_down",      expiry: "2026-10-13", gap: -0.0010, path: _scale(_TREND_UP, -1.05), vix: 15.6, noise: { bridge: 0.00018, ou: 5 } },
  { date: "2026-10-08", regime: "chop",            expiry: "2026-10-13", gap:  0.0005,
    path: (u) => 0.32 * Math.sin(u * Math.PI * 9) + 0.12 * (Math.sin(u * Math.PI * 23 + 1.3) - Math.sin(1.3)),
    vix: 13.1, noise: { bridge: 0.00012, ou: 4 } },
  { date: "2026-10-09", regime: "gap_up",          expiry: "2026-10-13", gap:  0.0090, path: _GAP_UP,                vix: 12.9, noise: { bridge: 0.00008, ou: 4 } },
  { date: "2026-10-12", regime: "gap_down",        expiry: "2026-10-13", gap: -0.0100, path: _scale(_GAP_UP, -1.1),  vix: 15.9, noise: { bridge: 0.00008, ou: 4 } },
  { date: "2026-10-13", regime: "range_breakout",  expiry: "2026-10-13", gap:  0.0008,
    path: (u) => (u < 0.6 ? 0.18 * Math.sin(u * Math.PI * 11) : 0.18 * Math.sin(0.6 * Math.PI * 11) + 0.95 * _smooth((u - 0.6) / 0.4)),
    vix: 13.6, noise: { bridge: 0.0001, ou: 4 } },
  // 20-Oct is a holiday, so that week's NIFTY weekly expiry is PREPONED to Monday 19-Oct.
  { date: "2026-10-14", regime: "or_retest_whipsaw", expiry: "2026-10-19", gap: -0.0010, pts: _OR_RETEST_WHIPSAW, vix: 14.2, noise: { bridge: 0, ou: 1.5 } },
  // Noisy tape with three sharp stretches inside the 10:00–14:00 window (11:05
  // flush, 12:25 squeeze, 13:20 flush) that snap back — band/RSI extremes.
  { date: "2026-10-15", regime: "volatile_spikes",   expiry: "2026-10-19", gap:  0.0015,
    path: [[0, 0], [100, -0.05], [110, -0.42], [114, -0.40], [130, -0.12], [180, 0.02], [190, 0.36], [194, 0.34], [210, 0.08],
           [235, 0.05], [245, -0.32], [249, -0.30], [265, -0.08], [375, -0.30]],
    vix: 16.4, noise: { bridge: 0.0003, ou: 6 } },
  { date: "2026-10-16", regime: "smc_order_block", expiry: "2026-10-19", gap:  0.0005, pts: _scale(_smcDay(), 1.15), vix: 15.0, noise: { bridge: 0, ou: 2.5 } },
];
const SESSION_BY_DATE = new Map(SESSIONS.map(s => [s.date, s]));
function _smooth(x) { return x * x * (3 - 2 * x); }

/**
 * Daily drift for the ORDINARY (non-session) days: mean and σ of the day's move,
 * σ of its opening gap (fractions). A three-week rally into 09-04 and a
 * three-week slide into 09-25 pin the daily RSI(10)-on-EMA21 GAP_RUNAWAY reads:
 * overbought on 09-04 (→ 09-07 gap down = PE), oversold on 09-25 (→ 09-28 gap
 * up = CE) and still oversold on 10-01 (→ 10-05 gap up = CE).
 */
function _driftFor(date) {
  if (date >= "2026-08-17" && date <= "2026-09-04") return { mu:  0.0025, sd: 0.0015, gapSd: 0.0010 };
  if (date >= "2026-09-08" && date <= "2026-09-25") return { mu: -0.0050, sd: 0.0015, gapSd: 0.0010 };
  if (date === "2026-09-29" || date === "2026-10-01") return { mu: -0.0030, sd: 0.0010, gapSd: 0.0008 };
  return { mu: 0.0002, sd: 0.0065, gapSd: 0.0025 };
}

// ── Seeded RNG (mulberry32) + Gaussian (Box-Muller) ─────────────────────────
function _hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function rng(seedStr) {
  let a = _hash(seedStr);
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  next.gauss = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u === 0) u = next();
    v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return next;
}

const r2  = (x) => Math.round(x * 100) / 100;
const round05 = (x) => parseFloat((Math.round(x * 20) / 20).toFixed(2));

// ── Calendar ─────────────────────────────────────────────────────────────────
function _addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isTradingDay(dateStr) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(dateStr);
}
function tradingDaysBetween(from, to) {
  const out = [];
  if (from > to) return out;
  for (let d = from; d <= to; d = _addDays(d, 1)) if (isTradingDay(d)) out.push(d);
  return out;
}
/** 09:15 IST of `dateStr` as epoch ms. */
function openMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00Z`) - IST_OFFSET_MS + OPEN_MIN * 60000;
}
/** Last Tuesday of the month of `dateStr` ("YYYY-MM-DD") — NIFTY's monthly expiry. */
function monthlyExpiryOf(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));                     // last day of the month
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - 2 + 7) % 7));
  return d.toISOString().slice(0, 10);
}

/** Piecewise-linear lookup in [[x, y], …] (x ascending). */
function _interp(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return x1 === x0 ? y1 : y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

// ── Day chain ────────────────────────────────────────────────────────────────
const _chain = new Map();
let _chainLast = null;   // last date generated

function _genDay(date, prevClose) {
  const sess = SESSION_BY_DATE.get(date);
  const R = rng(`nifty:${date}`);
  const n = TICKS_PER_DAY;
  let open, levelAt, bridgeFrac, ouStd, regime;
  if (sess) {
    regime = sess.regime;
    open = prevClose * (1 + sess.gap);
    if (sess.pts)                             levelAt = (m) => _interp(sess.pts, m);
    else if (typeof sess.path === "function") levelAt = (m) => open * sess.path(m / SESSION_MIN) / 100;
    else                                      levelAt = (m) => open * _interp(sess.path, m) / 100;
    bridgeFrac = sess.noise.bridge;
    ouStd = sess.noise.ou;
  } else {
    regime = "random";
    const dr = _driftFor(date);
    open = prevClose * (1 + R.gauss() * dr.gapSd);
    const move = open * (dr.mu + R.gauss() * dr.sd);
    levelAt = (m) => move * (m / SESSION_MIN);
    bridgeFrac = 0.00026;
    ouStd = 3;
  }
  const sigma = (open * bridgeFrac) / Math.sqrt(30);
  const walk = new Float64Array(n);
  let w = 0;
  for (let i = 0; i < n; i++) { w += R.gauss() * sigma; walk[i] = w; }
  const endW = walk[n - 1];
  const theta = 1 / 90;                                      // ~3-minute decorrelation at 2 s ticks
  const ouSig = ouStd * Math.sqrt(2 * theta - theta * theta);
  let ou = 0;
  const t0 = openMs(date);
  const ticks = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const m = (i * TICK_MS) / 60000;
    ou = ou * (1 - theta) + R.gauss() * ouSig;
    const px = open + levelAt(m) + (walk[i] - endW * u) + (i === 0 ? 0 : ou);
    ticks[i] = { t: t0 + i * TICK_MS, ltp: round05(px) };
  }
  ticks[0].ltp = round05(open);
  return { open: ticks[0].ltp, close: ticks[n - 1].ltp, ticks, regime };
}

function _ensureChain(upTo) {
  if (_chainLast && _chainLast >= upTo) return;
  let d = _chainLast ? _addDays(_chainLast, 1) : ANCHOR_DATE;
  let prevClose = _chainLast ? _chain.get(_lastTradingKey).close : ANCHOR_PRICE;
  for (; d <= upTo; d = _addDays(d, 1)) {
    if (!isTradingDay(d)) continue;
    const day = _genDay(d, prevClose);
    // Ticks are kept for session days only; every day keeps its 1-min bars.
    _chain.set(d, { open: day.open, close: day.close, regime: day.regime, bars1: _aggregate(day.ticks, 1),
                    ticks: SESSION_BY_DATE.has(d) ? day.ticks : null });
    prevClose = day.close;
    _lastTradingKey = d;
  }
  _chainLast = upTo;
}
let _lastTradingKey = null;

/** Epoch-aligned bucket start (ms), same math as tradeUtils.getBucketStart. */
function _bucket(tMs, resMin) {
  const ms = resMin * 60000;
  return Math.floor(tMs / ms) * ms;
}
function _aggregate(ticks, resMin) {
  const out = [];
  let cur = null;
  for (const tk of ticks) {
    const b = Math.floor(_bucket(tk.t, resMin) / 1000);
    if (!cur || cur.time !== b) {
      cur = { time: b, open: tk.ltp, high: tk.ltp, low: tk.ltp, close: tk.ltp, volume: 0 };
      out.push(cur);
    } else {
      if (tk.ltp > cur.high) cur.high = tk.ltp;
      if (tk.ltp < cur.low) cur.low = tk.ltp;
      cur.close = tk.ltp;
    }
  }
  return out;
}
function _rollUp(bars1, resMin) {
  if (resMin === 1) return bars1.map(b => ({ ...b }));
  const out = [];
  let cur = null;
  for (const b of bars1) {
    const t = Math.floor(_bucket(b.time * 1000, resMin) / 1000);
    if (!cur || cur.time !== t) {
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: 0 };
      out.push(cur);
    } else {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
    }
  }
  return out;
}

function getDay(date) {
  _ensureChain(date);
  return _chain.get(date) || null;
}
function dayTicks(date) {
  const d = getDay(date);
  if (!d || !d.ticks) throw new Error(`syntheticMarket: ${date} is not a session day`);
  return d.ticks;
}
/** Full-day bars at `resMin` (minutes). */
function intradayBars(date, resMin) {
  const d = getDay(date);
  return d ? _rollUp(d.bars1, resMin) : [];
}
/**
 * Bars for a session day as a broker would return them at `nowMs`: every
 * closed bar plus the still-forming one built from the ticks seen so far.
 */
function intradayBarsAsOf(date, resMin, nowMs) {
  const d = getDay(date);
  if (!d) return [];
  if (!d.ticks) return _rollUp(d.bars1, resMin);
  const seen = [];
  for (const tk of d.ticks) { if (tk.t > nowMs) break; seen.push(tk); }
  return _aggregate(seen, resMin);
}
function dailyBar(date) {
  const d = getDay(date);
  if (!d) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of d.bars1) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
  // Fyers stamps a daily bar at 00:00 IST.
  return { time: Math.floor((Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS) / 1000),
           open: d.open, high: hi, low: lo, close: d.close, volume: 0 };
}

// ── VIX ──────────────────────────────────────────────────────────────────────
function vixLevelOf(date) {
  const s = SESSION_BY_DATE.get(date);
  if (s) return s.vix;
  const R = rng(`vix:${date}`);
  return r2(13.4 + R.gauss() * 0.9);
}
/** Intraday VIX: the day's level, nudged inversely to the move so far. */
function vixAt(date, tMs, spot) {
  const base = vixLevelOf(date);
  const d = getDay(date);
  const rel = d && spot ? (spot - d.open) / d.open : 0;
  return r2(Math.max(9.5, base * (1 - rel * 6)));
}
function vixDailyBar(date) {
  const v = vixLevelOf(date);
  return { time: Math.floor((Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS) / 1000),
           open: v, high: r2(v * 1.04), low: r2(v * 0.96), close: v, volume: 0 };
}

// ── Option premium (Black-Scholes, r = 0) ────────────────────────────────────
function _ncdf(x) {
  // Abramowitz-Stegun 7.1.26 (JS has no Math.erf).
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
/** Expiry instant: 15:30 IST on the expiry date. */
function expiryMs(expiryDate) {
  return Date.parse(`${expiryDate}T00:00:00Z`) - IST_OFFSET_MS + CLOSE_MIN * 60000;
}
function optionPremium(spot, strike, side, tMs, expiryDate, vix) {
  const T = Math.max(60000, expiryMs(expiryDate) - tMs) / (365 * 86400000);
  const iv = (vix / 100) * 1.05;
  const sd = iv * Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  const call = spot * _ncdf(d1) - strike * _ncdf(d2);
  const put  = call - spot + strike;
  const px = side === "CE" ? call : put;
  const intrinsic = side === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  return round05(Math.max(0.05, px, intrinsic));
}

module.exports = {
  SESSIONS, TICK_MS, OPEN_MIN, CLOSE_MIN, IST_OFFSET_MS, HOLIDAYS, ANCHOR_DATE,
  rng, isTradingDay, tradingDaysBetween, openMs, monthlyExpiryOf,
  getDay, dayTicks, intradayBars, intradayBarsAsOf, dailyBar,
  vixLevelOf, vixAt, vixDailyBar, optionPremium, expiryMs, round05,
};

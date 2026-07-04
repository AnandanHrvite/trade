require("dotenv").config();
const fyers = require("../config/fyers");
const { toDateString } = require("../utils/time");

const vixFilter = require("./vixFilter");
const { buildVixLookup, checkBacktestVix, VIX_SYMBOL } = vixFilter;

const instrumentConfig = require("../config/instrument");
const { getLotQty } = instrumentConfig;
const { getCharges } = require("../utils/charges");
const { fetchCandlesWithCache, fetchCandlesSmartCache } = require("../utils/backtestCache");
const confirmCandle = require("../utils/confirmCandle");


function maxDaysForResolution(resolution) {
  if (["D", "W", "M"].includes(resolution)) return 365 * 10;
  if (["1", "2", "3"].includes(String(resolution))) return 30;
  return 100;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
/** Round to N decimals without string allocation (avoids parseFloat(x.toFixed(2))) */
function quantize(val, decimals) { const f = 10 ** decimals; return Math.round(val * f) / f; }

async function fetchChunk(symbol, resolution, from, to) {
  const params = { symbol, resolution: String(resolution), date_format: "1", range_from: from, range_to: to, cont_flag: "1" };
  console.log(`   📦 Fetching chunk: ${from} → ${to}`);
  const response = await fyers.getHistory(params);
  if (response.s === "no_data" || (!response.candles || response.candles.length === 0)) return [];
  if (response.s !== "ok") throw new Error(`Fyers API error: ${JSON.stringify(response)}`);
  return response.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
}

async function fetchCandles(symbol, resolution, from, to) {
  const maxDays = maxDaysForResolution(resolution);
  // Stream dedupe as we fetch — avoids a second O(n) pass + a duplicate array copy
  const seen = new Set();
  const unique = [];
  let cursor = new Date(from);
  const endDate = new Date(to);
  while (cursor <= endDate) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());
    const candles = await fetchChunk(symbol, resolution, cursor.toISOString().split("T")[0], chunkEnd.toISOString().split("T")[0]);
    for (const c of candles) {
      if (!seen.has(c.time)) { seen.add(c.time); unique.push(c); }
    }
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
    if (cursor <= endDate) await sleep(300);
  }
  unique.sort((a, b) => a.time - b.time);
  // Keep only NSE regular-session candles (09:15 ≤ IST < 15:30). Pre-open auction
  // (09:00–09:08) prints a wild wide-range bar and any post-close prints are junk;
  // both corrupt path-dependent indicators (SuperTrend, SAR) and make them diverge
  // from Kite/TradingView. Filtering here keeps every historical source — warmup
  // preload + backtest — consistent with the chart. No-op when the feed is already
  // 09:15+ (the usual case), so it is a safe defensive guard.
  const _MKT_OPEN = 9 * 60 + 15, _MKT_CLOSE = 15 * 60 + 30;
  const sessionOnly = unique.filter(c => { const m = getISTHHMM(c.time); return m >= _MKT_OPEN && m < _MKT_CLOSE; });
  const _dropped = unique.length - sessionOnly.length;
  console.log(`   ✅ Total candles fetched: ${sessionOnly.length}${_dropped ? ` (dropped ${_dropped} pre-open/post-close)` : ""}`);
  if (global.gc) global.gc();
  return sessionOnly;
}

function toIST(unixSec) {
  const ist = new Date(unixSec * 1000 + 19800000);
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = ist.getUTCFullYear();
  const h = String(ist.getUTCHours()).padStart(2, '0');
  const m = String(ist.getUTCMinutes()).padStart(2, '0');
  const s = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy}, ${h}:${m}:${s}`;
}

/** Get IST date string "YYYY-MM-DD" from unix seconds — memoized by timestamp */
const _istDateCache = new Map();
function getISTDateStr(unixSec) {
  let v = _istDateCache.get(unixSec);
  if (v === undefined) {
    v = new Date(unixSec * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    // Cap cache at 2000 entries (one backtest run ≈ 400–4000 candles)
    if (_istDateCache.size > 2000) _istDateCache.clear();
    _istDateCache.set(unixSec, v);
  }
  return v;
}

/** Get IST hour*60+min from unix seconds — memoized by timestamp */
const _istHHMMCache = new Map();
function getISTHHMM(unixSec) {
  let v = _istHHMMCache.get(unixSec);
  if (v === undefined) {
    // Fast IST: UTC+5:30 = +19800 seconds (avoids expensive toLocaleString/ICU)
    const istSec = unixSec + 19800;
    v = Math.floor(istSec / 60) % 1440;
    if (_istHHMMCache.size > 2000) _istHHMMCache.clear();
    _istHHMMCache.set(unixSec, v);
  }
  return v;
}

/**
 * BACKTEST ENGINE — mirrors paper-trade logic.
 *
 * For SWING (redefined 2026-05-27) the entry/exit model is:
 *   ENTRY  : strategy.getSignal(window) returns BUY_CE/BUY_PE (EMA alignment + RSI + SuperTrend rules).
 *            Entry price = candle.close (candle-granularity proxy for live intra-candle entry).
 *   STOP   : initial SL = previous completed candle low (CE) / high (PE), from getSignal.
 *            Trails EMA21, tighten-only. When SWING_CANDLE_TRAIL_ENABLED, an N-bar low/high
 *            candle trail is layered on and the tighter of the two wins.
 *   EXIT   : trail SL hit · EMA21 touch-back · option-premium stop (OPT_STOP_PCT,
 *            approximated via an adverse spot move in backtest) · opposite signal · EOD.
 *   RISK   : same-side SL cooldown (SWING_SL_PAUSE_CANDLES), VIX gate, MAX_DAILY_LOSS,
 *            3-consecutive-loss pause.
 *
 * Other strategies that reuse this engine keep their getSignal-driven behaviour; the
 * 50%-rule pause scaffolding is retained for them but SWING no longer triggers it.
 */
async function runBacktest(candles, strategy, capital, vixCandles, expiryDates, onProgress, activeFromTs = 0) {
  const trades    = [];
  let position    = null;
  const LOT_SIZE  = getLotQty();

  // ── VIX filter for backtest ─────────────────────────────────────────────────
  const lookupVix = buildVixLookup(vixCandles || []);
  let _vixBlockCount = 0;

  // ── Signal rejection counters (diagnose why trade count is low) ────────────
  const _rejectCounts = {};

  // ── Option premium simulation ────────────────────────────────────────────────
  // Backtest doesn't have real option prices. We simulate them with two factors:
  //
  // 1. DELTA: How much the option premium moves per 1-pt NIFTY move.
  //    ATM options (strike ≈ spot): delta ≈ 0.50
  //    ITM options (strike 50pt inside spot): delta ≈ 0.65
  //    This bot enters ITM (calcATMStrike returns strike 50pts ITM).
  //    We use delta=0.55 as a conservative ITM approximation.
  //    Real delta varies — 0.55 is a reasonable mid-point for 1-week ITM options.
  //
  // 2. THETA DECAY: Options lose value every minute they're held.
  //    Approximation: ATM weekly option ≈ ₹8–12 theta/day on 15-min bars.
  //    We deduct theta proportional to candles held (candlesHeld / candles-per-day, where
  //    candles-per-day = 390 / bar-resolution — e.g. 26 on 15-min bars, 78 on 5-min bars).
  //    THETA_PER_DAY: configurable via env, defaults to ₹10/day (conservative).
  //    This makes long holds cost more — matching real trading where theta kills
  //    a position that "wins" on spot direction but loses on time decay.
  //
  // pnlRupees = (spotPnlPts × DELTA × LOT_SIZE) - (theta × candlesHeld / candlesPerDay) - charges
  //
  // This is the #1 reason backtest looks better than live — without this, a 100pt
  // NIFTY move shows 100pt profit, but your real option only gained ~55pt × ₹65 = ₹3575,
  // not ₹6500 (100pt × ₹65). After theta on a 4-candle hold: ~₹3575 − ₹6 − ₹80 = ₹3489.
  //
  // To disable simulation and revert to raw index points (old behaviour):
  //   set BACKTEST_OPTION_SIM=false in .env
  const isFutures    = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  // Futures: no delta/theta — 1:1 point-to-rupee. Force OPTION_SIM off for futures.
  const OPTION_SIM   = isFutures ? false : (process.env.BACKTEST_OPTION_SIM !== "false"); // true by default for options
  const DELTA        = isFutures ? 1.0 : parseFloat(process.env.BACKTEST_DELTA        || "0.55");
  const THETA_PER_DAY = isFutures ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY   || "10");   // ₹ per day
  // Candles in a 6.5-hour (390-min) trading day, derived from the ACTUAL bar spacing —
  // NOT hardcoded to 26, which only holds for 15-min bars. A 5-min run has ~78 candles/day,
  // so a fixed 26 over-charges theta ~3×. 390/res → 15-min=26, 5-min=78, 1-min=390.
  const _btResMins      = candles.length >= 2 ? Math.max(1, Math.round((candles[1].time - candles[0].time) / 60)) : 15;
  const CANDLES_PER_DAY = Math.max(1, Math.round(390 / _btResMins));

  // ── Slippage simulation ────────────────────────────────────────────────────
  // Real market orders on NIFTY options see 1-3 pts slippage. Without this,
  // backtest overstates P&L vs live trading. Applied to BOTH entry and exit.
  const SLIPPAGE_PTS = parseFloat(process.env.BACKTEST_SLIPPAGE_PTS || "0");

  // ── SWING (redefined): exit/stop model ───────────────────────────────────
  //   Initial SL  : previous completed candle's low (CE) / high (PE) — from getSignal.
  //   Trail       : EMA21, tighten-only; optional N-bar candle-trail overlay
  //                 (SWING_CANDLE_TRAIL_*) — tighter wins.
  //   Option stop : exit if the (simulated) option premium drops OPT_STOP_PCT from entry.
  //   Same-side cooldown: after an SL hit on a side, block that side for N candles.
  const SWING_SL_PAUSE_CANDLES = parseInt(process.env.SWING_SL_PAUSE_CANDLES || "3", 10);
  const OPT_STOP_PCT           = parseFloat(process.env.OPT_STOP_PCT || "0.15");
  // Per-trade catastrophic spot-points cap (mirrors SCALP_STOP_LOSS_PTS). 0 = off.
  const _SWING_STOP_LOSS_PTS   = parseFloat(process.env.SWING_STOP_LOSS_PTS || "0");
  // Negative-candle stop: square off a trade still in the RED after N candles (cut losers
  // fast, let winners ride the EMA trail). 0 = off. Default 2 (added 2026-06-19).
  const _SWING_NEG_CANDLE_LIMIT = parseInt(process.env.SWING_NEG_CANDLE_LIMIT || "2", 10);
  // Chop guard: halt new entries for the rest of the day after N consecutive losing
  // trades (any win resets the streak). Mirrors paper/live. 0 = off.
  const _SWING_MAX_CONSEC_LOSSES = parseInt(process.env.SWING_MAX_CONSEC_LOSSES || "0", 10);
  // Opposite-side (flip) cooldown — block opposite-side entry for N candles after non-flip exit.
  const OPP_COOLDOWN_ENABLED   = (process.env.SWING_OPPOSITE_SIDE_COOLDOWN_ENABLED || "true").toLowerCase() === "true";
  const OPP_COOLDOWN_CANDLES   = parseInt(process.env.SWING_OPPOSITE_SIDE_COOLDOWN_CANDLES || "3", 10);
  // Backtest has no live option LTP — approximate the premium stop as an adverse
  // SPOT move: optStopSpotPts = (OPT_STOP_PCT × estEntryPremium) / DELTA. estEntryPremium
  // is the same 200 constant the PnL sim uses, so the two stay internally consistent.
  const _OPT_STOP_SPOT_PTS = (!isFutures && OPT_STOP_PCT > 0 && DELTA > 0) ? (OPT_STOP_PCT * 200) / DELTA : 0;

  // Clear IST memoization caches so back-to-back backtests don't cross-pollute
  _istDateCache.clear();
  _istHHMMCache.clear();

  // Reset strategy module-level state if it has a reset hook
  if (typeof strategy.reset === "function") strategy.reset();

  // ── Performance: suppress per-candle/per-trade logging for large backtests ──
  // console.log I/O is the #1 bottleneck for 100K+ candle runs.
  // Keep summary logs, suppress per-trade noise unless BACKTEST_DEBUG=true.
  const _verbose = candles.length < 5000 || process.env.BACKTEST_DEBUG === "true";

  console.log("\n══════════════════════════════════════════════");
  console.log(`🔍 BACKTEST — ${strategy.NAME}`);
  console.log(`   Entry : signal from strategy at candle close`);
  console.log(`   Exit  : trail SL + EMA21 touch-back + opposite signal + EOD/day`);
  console.log(`   Charges : dynamic (STT + exchange + GST + stamp + ₹40 brok) — see Settings`);
  console.log(`   PnL mode : ${OPTION_SIM ? `OPTION SIM (delta=${DELTA}, theta=₹${THETA_PER_DAY}/day, lot=${LOT_SIZE})` : "RAW INDEX POINTS (set BACKTEST_OPTION_SIM=true to enable)"}`);
  console.log(`   VIX filter : ${vixFilter.VIX_ENABLED ? `ON (max=${vixFilter.VIX_MAX_ENTRY}, strong-only=${vixFilter.VIX_STRONG_ONLY}) | ${vixCandles ? vixCandles.length + " VIX candles loaded" : "NO VIX DATA — filter bypassed"}` : "OFF"}`);
  console.log("══════════════════════════════════════════════");

  // ── Optimisation: cache the SL from the previous candle's getSignal ──────────
  // Instead of calling getSignal(prevWindow) on every iteration (O(n²) total),
  // ── Optimisation: push/pop window trick (mirrors paper/live onTick) ──────────
  // candles.slice(0, i+1) allocates a new array every iteration — O(n) alloc × n iters = O(n²) mem.
  // Instead: maintain a 'window' array and push/pop the current candle in and out.
  // This avoids all array copies while giving strategy the same view.
  const window = candles.slice(0, 30); // seed with first 30 (matches strategy warm-up — ADX needs 29+ candles)

  // Debug counters: log first 5 signal reasons (any) and first 5 blocked reasons
  // Helps diagnose 0-trade runs without needing terminal access during backtest.
  let _dbgSignalCount = 0;
  let _dbgBlockCount  = 0;

  // Derive candle resolution in minutes from first two candle timestamps.
  // Used for 50%-rule pause duration. Fallback 15 if fewer than 2 candles.
  const candleResolutionMins = candles.length >= 2
    ? Math.round((candles[1].time - candles[0].time) / 60)
    : 15;
  console.log(`   Resolution: ${candleResolutionMins}-min candles | Total candles: ${candles.length} | Seed window: 30`);
  console.log(`   SWING(redefined): EMA+RSI+SuperTrend | EMA21 trail${(process.env.SWING_CANDLE_TRAIL_ENABLED || "false").toLowerCase() === "true" ? ` + ${Math.max(1, parseInt(process.env.SWING_CANDLE_TRAIL_BARS || "3", 10))}-bar candle trail (tighter wins)` : ""} | optStop ${(OPT_STOP_PCT*100).toFixed(0)}% | same-side cooldown ${SWING_SL_PAUSE_CANDLES} candles`);

  // 50%-rule exit pause: retained for non-SWING strategies that use this engine.
  // Stored as unix seconds (candle.time units). Reset per day in the loop.
  let _fiftyPctPauseUntilTs = 0;

  // ── Risk controls (mirrors paper trade exactly) ─────────────────────────────
  const MAX_DAILY_LOSS      = parseFloat(process.env.MAX_DAILY_LOSS || "5000");
  const MAX_DAILY_TRADES    = parseInt(process.env.MAX_DAILY_TRADES || "20", 10);
  let _dailyPnl             = 0;       // running PnL for current day (reset each day)
  let _dailyTradeCount      = 0;       // trades taken today (reset each day)
  let _dailyLossHit         = false;   // latched true when daily loss >= MAX_DAILY_LOSS
  let _consecutiveLosses    = 0;       // back-to-back losses (reset on win or new day)
  let _consecPauseUntilTs   = 0;       // unix seconds — block entries until this time
  let _chopConsecLosses     = 0;       // chop-guard streak (SWING_MAX_CONSEC_LOSSES), reset on win or new day
  const _slPauseUntilBySide = { CE: 0, PE: 0 }; // same-side SL cooldown (unix secs), reset per day
  let _oppositeCooldownUntilTs   = 0;     // opposite-side cooldown (unix secs), reset per day
  let _oppositeCooldownLastSide  = null;  // last exited side
  // Confirmation candle (cross & close, SWING only — SWING_CONFIRM_CANDLE_ENABLED).
  // { side, armedBarTime, triggerLevel, signalSL, reason, strength } | null.
  let _armedSwing = null;
  // EMA21 trail base from the PRIOR candle's close. Paper arms the EMA21 trail at a
  // candle's close and enforces it on the NEXT candle's ticks; using this candle's own
  // EMA21 to update the SL and then testing this candle's low/high against it is
  // look-ahead. We carry last candle's EMA21 forward and trail on it instead.
  let _prevEma21 = null;
  console.log(`   Risk controls: MAX_DAILY_LOSS=₹${MAX_DAILY_LOSS} | MAX_DAILY_TRADES=${MAX_DAILY_TRADES} | 3-consec-loss=kill(15min)/pause(5min)`);
  if (SLIPPAGE_PTS > 0) console.log(`   Slippage sim : ${SLIPPAGE_PTS} pts per side (entry + exit)`);

  // EOD times — mirror swingPaper EXACTLY so backtest squares off / blocks entries at
  // the same IST minutes as paper (not a hardcoded 3:20). Paper has TWO distinct times:
  // entry cutoff = TRADE_STOP_TIME − 10 (paper's _ENTRY_STOP_MINS, ~15:20) and exit
  // square-off = SWING_EOD_EXIT_TIME (~15:15). Collapsing both into one 3:20 made the
  // backtest hold ~5 min past paper's square-off.
  const _stopMins     = (() => { const v = (process.env.TRADE_STOP_TIME || "15:30").split(":"); return parseInt(v[0], 10) * 60 + (parseInt(v[1], 10) || 0); })();
  const _entryStopMin = _stopMins - 10;
  const _eodExitMin   = (() => { const v = (process.env.SWING_EOD_EXIT_TIME || "15:15").split(":"); const h = parseInt(v[0], 10); return isNaN(h) ? _stopMins : (h * 60 + (parseInt(v[1], 10) || 0)); })();
  const _eodLabel     = String(Math.floor(_eodExitMin / 60)).padStart(2, "0") + ":" + String(_eodExitMin % 60).padStart(2, "0");

  for (let i = 30; i < candles.length; i++) {
    // Yield event loop every 100 candles — keeps server responsive during long backtests
    if ((i - 30) % 100 === 0) {
      await new Promise(resolve => setImmediate(resolve));
      if (onProgress) {
        const done = i - 30, total = candles.length - 30;
        onProgress({ phase: 'Running backtest…', current: done, total, pct: Math.min(99, 5 + Math.round((done / total) * 94)) });
      }
    }
    // Low-RAM mode: trigger GC every ~2000 candles so short-lived indicator
    // objects get reclaimed before they pile up. Requires node --expose-gc.
    if (global.gc && (i - 30) % 2000 === 0 && i > 30) global.gc();

    const candle     = candles[i];
    const prevCandle = candles[i - 1];

    // Extend window by one candle (current candle being evaluated)
    window.push(candle);
    if (window.length > 200) window.shift(); // cap same as paper/live — prevents O(n²) indicator recalc

    // ── Per-day EOD detection ─────────────────────────────────────────────────
    // A candle is the last of its trading day if the NEXT candle is a different
    // IST date OR there is no next candle (final candle of entire run).
    const candleDate = getISTDateStr(candle.time);
    // Reset 50%-rule pause at start of each new trading day
    if (i > 30) {
      const prevCandleDate = getISTDateStr(candles[i - 1].time);
      if (candleDate !== prevCandleDate) {
        _fiftyPctPauseUntilTs = 0;
        // Reset daily risk controls for new day
        _dailyPnl           = 0;
        _dailyTradeCount    = 0;
        _dailyLossHit       = false;
        _consecutiveLosses  = 0;
        _consecPauseUntilTs = 0;
        _chopConsecLosses   = 0;
        _slPauseUntilBySide.CE = 0;
        _slPauseUntilBySide.PE = 0;
        _oppositeCooldownUntilTs  = 0;
        _oppositeCooldownLastSide = null;
        _armedSwing               = null; // drop any arm across the day boundary
        if (_verbose) {
          // Count trades for previous day for the daily log
          // Use _dailyTradeCount (already tracked) instead of expensive trades.filter()
          if (_dailyTradeCount > 0) {
            console.log(`\n  📅 DAY CLOSE [${prevCandleDate}]: ${_dailyTradeCount} trades | PnL=${_dailyPnl.toFixed(1)}pts`);
          }
          console.log(`\n  ──── NEW DAY: ${candleDate} ────`);
        }
      }
    }
    const nextCandle = candles[i + 1] || null;
    const nextDate   = nextCandle ? getISTDateStr(nextCandle.time) : null;
    const isLastCandleOfDay = !nextCandle || nextDate !== candleDate;

    // Also check time — force EOD at 3:20 PM regardless
    const candleMin     = getISTHHMM(candle.time);
    // Two distinct times, mirroring swingPaper: exit square-off at SWING_EOD_EXIT_TIME
    // (~15:15) vs entry cutoff at TRADE_STOP_TIME − 10 (~15:20). Last candle of the
    // day forces both. (Previously a single 3:20 served both, holding 5 min too long.)
    const isEodExit      = isLastCandleOfDay || candleMin >= _eodExitMin;
    const isEntryBlocked = isLastCandleOfDay || candleMin >= _entryStopMin;

    // ── Get signal from current window (entry candle included) ────────────────
    // window already contains candles[0..i] — no slice needed.
    // silent=true: backtest runs 1000+ candles — suppress per-candle strategy console.log spam
    // Only destructure fields we actually use — skip `...indicators` rest-spread
    // which allocates a new object every candle (hot path: 500K+ calls).
    const _sig = strategy.getSignal(window, { silent: true });
    const signal = _sig.signal;
    const reason = _sig.reason;
    const signalSL = _sig.stopLoss;
    const signalStrength = _sig.signalStrength;

    // Debug: log first few signal evaluations so 0-trade runs are diagnosable
    if (_dbgSignalCount < 5) {
      console.log(`  🔍 [DBG candle ${i}] signal=${signal} | ${reason.slice(0, 120)}`);
      _dbgSignalCount++;
    } else if (_dbgSignalCount === 5) {
      console.log(`  🔍 [DBG] (suppressing further debug logs — first 5 shown above)`);
      _dbgSignalCount++;
    }

    // Track rejection reasons when flat (no position) — diagnose low trade count
    if (!position && signal === "NONE" && reason) {
      // Bucket the reason into a short key
      const rKey = reason.length > 60 ? reason.slice(0, 60) : reason;
      _rejectCounts[rKey] = (_rejectCounts[rKey] || 0) + 1;
    }

    // ── TRAILING STOP (EMA21 base + optional candle-trail overlay) ──────────────
    // Base SL source (tighten-only) at each candle close is EMA21 — a candle touching
    // back EMA21 is an explicit exit. When SWING_CANDLE_TRAIL_ENABLED, an N-bar low (CE)
    // / high (PE) trail is layered on and the TIGHTER of the two wins. The window ends at
    // the prior bar (i-1) to mirror paper's "SL from prior bars enforced on this bar" timing.
    // The touch-back exit is wired below in the EXIT CHECK block.
    if (position) {
      let trailRef = null;
      // Use the PRIOR candle's EMA21 (armed at the last close), not this candle's —
      // mirrors paper's "SL from prior bars enforced on this bar" timing (no look-ahead).
      if (_prevEma21 != null) trailRef = _prevEma21;
      // Candle-trail overlay: N-bar low (CE) / high (PE), keep the tighter of EMA21 vs candle.
      const _ctOn   = (process.env.SWING_CANDLE_TRAIL_ENABLED || "false").toLowerCase() === "true";
      const _ctBars = Math.max(1, parseInt(process.env.SWING_CANDLE_TRAIL_BARS || "3", 10));
      if (_ctOn && i >= _ctBars) {
        const _bars = candles.slice(i - _ctBars, i);
        const _candleLvl = position.side === "CE"
          ? Math.min(..._bars.map(c => c.low))
          : Math.max(..._bars.map(c => c.high));
        if (trailRef == null) trailRef = _candleLvl;
        else if (position.side === "CE" && _candleLvl > trailRef) trailRef = _candleLvl;
        else if (position.side === "PE" && _candleLvl < trailRef) trailRef = _candleLvl;
      }
      if (trailRef != null) {
        if (position.side === "CE") {
          if (position.stopLoss == null || trailRef > position.stopLoss) {
            if (_verbose && trailRef !== position.stopLoss) console.log(`  📐 TRAIL CE (EMA21) → ${trailRef} (was ${position.stopLoss})`);
            position.stopLoss = quantize(trailRef, 2);
          }
        } else {
          if (position.stopLoss == null || trailRef < position.stopLoss) {
            if (_verbose && trailRef !== position.stopLoss) console.log(`  📐 TRAIL PE (EMA21) → ${trailRef} (was ${position.stopLoss})`);
            position.stopLoss = quantize(trailRef, 2);
          }
        }
      }
      // Track favourable extreme (best price seen, for analysis)
      if (position.side === "CE") {
        if (!position.bestPrice || candle.high > position.bestPrice) position.bestPrice = candle.high;
      } else {
        if (!position.bestPrice || candle.low < position.bestPrice) position.bestPrice = candle.low;
      }
    }

    // Advance the EMA21 trail base for the NEXT candle: THIS candle's close-computed
    // EMA21 becomes the SL reference enforced on the next candle (matches paper timing).
    // Runs every candle (flat or in a position) and before any exit/entry `continue`.
    _prevEma21 = _sig.ema21;

    // Count candles held (used for theta decay in PnL calculation)
    // Placed after trail updates but before exit check — entry candle starts at 0
    if (position) position.candlesHeld = (position.candlesHeld || 0) + 1;

    // ── EXIT CHECK ────────────────────────────────────────────────────────────
    if (position) {
      let exitReason = null;
      let exitPrice  = candle.close;

      // Rule 1: SL or trail SL (uses candle low/high as intra-candle proxy)
      if (position.stopLoss !== null && position.stopLoss !== undefined) {
        // Determine SL type for clear labeling
        const _isTrailSL = position.initialStopLoss != null &&
                           Math.abs(position.stopLoss - position.initialStopLoss) > 1;
        const _slLabel = _isTrailSL ? "Trail SL" : "Initial SL";

        if (position.side === "CE" && candle.low <= position.stopLoss) {
          exitReason = `${_slLabel} hit — low ${candle.low} <= SL ${position.stopLoss}`;
          exitPrice  = position.stopLoss;
        } else if (position.side === "PE" && candle.high >= position.stopLoss) {
          exitReason = `${_slLabel} hit — high ${candle.high} >= SL ${position.stopLoss}`;
          exitPrice  = position.stopLoss;
        }
      }

      // Rule 1a: per-trade points stop (SWING_STOP_LOSS_PTS) — catastrophic spot cap.
      // Mirrors SCALP_STOP_LOSS_PTS. Use the tighter of (structural SL, cap level):
      // whichever sits closer to entry is hit first intra-candle. 0 = disabled.
      if (_SWING_STOP_LOSS_PTS > 0) {
        const adverse = position.side === "CE"
          ? (position.entryPrice - candle.low)
          : (candle.high - position.entryPrice);
        if (adverse >= _SWING_STOP_LOSS_PTS) {
          const _capLvl = position.side === "CE"
            ? quantize(position.entryPrice - _SWING_STOP_LOSS_PTS, 2)
            : quantize(position.entryPrice + _SWING_STOP_LOSS_PTS, 2);
          // Override only if no structural SL fired, or the cap is tighter (closer to entry).
          const _capTighter = !exitReason || (position.side === "CE" ? _capLvl > exitPrice : _capLvl < exitPrice);
          if (_capTighter) {
            exitReason = `SL (${_SWING_STOP_LOSS_PTS}pts)`;
            exitPrice  = _capLvl;
          }
        }
      }

      // Rule 1b: Option premium stop — exit if premium drops OPT_STOP_PCT from entry.
      // Backtest has no live LTP, so approximate via an adverse SPOT move
      // (_OPT_STOP_SPOT_PTS = OPT_STOP_PCT × est-premium / delta). Usually wider than
      // the prev-candle SL, so it only binds on a sharp adverse gap.
      if (!exitReason && _OPT_STOP_SPOT_PTS > 0) {
        const adverse = position.side === "CE"
          ? (position.entryPrice - candle.low)
          : (candle.high - position.entryPrice);
        if (adverse >= _OPT_STOP_SPOT_PTS) {
          exitReason = `Option stop ${(OPT_STOP_PCT * 100).toFixed(0)}% (≈${_OPT_STOP_SPOT_PTS.toFixed(0)}pt adverse spot)`;
          exitPrice  = position.side === "CE"
            ? quantize(position.entryPrice - _OPT_STOP_SPOT_PTS, 2)
            : quantize(position.entryPrice + _OPT_STOP_SPOT_PTS, 2);
        }
      }

      // Rule 1c: EMA21 touch-back exit
      if (!exitReason && _sig.ema21 != null) {
        if (candle.low <= _sig.ema21 && candle.high >= _sig.ema21) {
          exitReason = "EMA touch-back exit";
          exitPrice  = candle.close;
        }
      }

      // Rule 1d: Negative-candle stop — if the trade is still in the RED at this
      // candle close after N candles held, square off (asymmetric loss-cut; winners
      // keep riding the EMA trail above). "Negative" ≈ spot close against entry.
      if (!exitReason && _SWING_NEG_CANDLE_LIMIT > 0 && (position.candlesHeld || 0) >= _SWING_NEG_CANDLE_LIMIT) {
        const _closePnlPts = (candle.close - position.entryPrice) * (position.side === "CE" ? 1 : -1);
        if (_closePnlPts < 0) {
          exitReason = `Negative ${_SWING_NEG_CANDLE_LIMIT}-candle stop`;
          exitPrice  = candle.close;
        }
      }

      // Rule 2: Opposite signal
      if (!exitReason && signal === (position.side === "CE" ? "BUY_PE" : "BUY_CE")) {
        exitReason = "Opposite signal exit";
        exitPrice  = candle.close;
      }

      // Rule 3: EOD square-off — PER DAY at SWING_EOD_EXIT_TIME (mirrors swingPaper)
      if (!exitReason && isEodExit) {
        exitReason = `EOD square-off ${candleMin >= _eodExitMin ? _eodLabel : "(last candle of day)"}`;
        exitPrice  = candle.close;
      }

      if (exitReason) {
        // Apply slippage: exit is worse (lower for CE sell, higher for PE sell)
        if (SLIPPAGE_PTS > 0) {
          exitPrice = position.side === "CE"
            ? quantize(exitPrice - SLIPPAGE_PTS, 2)
            : quantize(exitPrice + SLIPPAGE_PTS, 2);
        }
        // ── PnL Calculation — realistic option simulation ─────────────────────
        // spotPnlPts: NIFTY index point move in our favour
        const spotPnlPts = quantize((exitPrice - position.entryPrice) * (position.side === "CE" ? 1 : -1), 2);

        let pnlRupees;
        let pnlMode;
        if (isFutures) {
          // Futures: direct point × lot size − charges (no delta/theta)
          const _chg = getCharges({ isFutures: true, exitPremium: exitPrice, entryPremium: position.entryPrice, qty: LOT_SIZE });
          pnlRupees = quantize((spotPnlPts * LOT_SIZE) - _chg, 2);
          pnlMode   = `futures (${spotPnlPts}pt × ${LOT_SIZE}qty − ₹${_chg.toFixed(0)} charges)`;
        } else if (OPTION_SIM) {
          // Option premium change ≈ spotPnlPts × delta
          const premiumMovePts = spotPnlPts * DELTA;
          // Theta decay: proportional to candles held
          const candlesHeld    = position.candlesHeld || 1;
          const thetaDecay     = quantize((THETA_PER_DAY / CANDLES_PER_DAY) * candlesHeld, 2);
          // Net option PnL per unit
          const netPremiumPts  = premiumMovePts - thetaDecay;
          // Estimate option premium for charges calc (rough: entry ~200, exit = entry + move)
          const estEntryPrem = 200;
          const estExitPrem  = Math.max(1, estEntryPrem + netPremiumPts);
          const _chg = getCharges({ isFutures: false, exitPremium: estExitPrem, entryPremium: estEntryPrem, qty: LOT_SIZE });
          // Total rupees = net premium pts × lot size − charges
          pnlRupees = quantize((netPremiumPts * LOT_SIZE) - _chg, 2);
          pnlMode   = `opt_sim (spot=${spotPnlPts}pt × δ${DELTA}=${premiumMovePts.toFixed(1)}pt − θ${thetaDecay}pt) × ${LOT_SIZE}lots − ₹${_chg.toFixed(0)} charges`;
        } else {
          // Legacy mode: raw index points (no delta/theta/lot/charges)
          pnlRupees = spotPnlPts;
          pnlMode   = "raw_pts";
        }

        trades.push({
          side:           position.side,
          entryTime:      toDateString(position.entryTime),
          exitTime:       toDateString(candle.time),
          entryTs:        position.entryTime,
          exitTs:         candle.time,
          entryPrice:     position.entryPrice,
          exitPrice,
          stopLoss:        position.stopLoss || "N/A",
          initialStopLoss: position.initialStopLoss || position.stopLoss || "N/A",
          bestPrice:       position.bestPrice || null,
          candlesHeld:     position.candlesHeld || 1,
          spotPnlPts,           // raw NIFTY point move (for display in UI)
          pnl:             pnlRupees,  // realistic ₹ PnL (or raw pts if sim disabled)
          pnlMode,
          exitReason,
          entryReason:     position.entryReason,
          signalStrength:  position.signalStrength || "STRONG",
          // indicators field omitted — not read by any route, frees ~50B/trade × 1000s of trades
        });
        if (_verbose) {
          const exitIcon = pnlRupees > 0 ? "✅" : "❌";
          const pnlLabel = OPTION_SIM ? `₹${pnlRupees}` : `${spotPnlPts}pts`;
          console.log(`  🚪 EXIT ${position.side} @ ${exitPrice}  PnL=${pnlRupees >= 0 ? "+" : ""}${pnlLabel} ${exitIcon}  reason=${exitReason}`);
          if (OPTION_SIM) console.log(`     [${pnlMode}]`);
          console.log(`     Held: ${toIST(position.entryTime)} → ${toIST(candle.time)} | ${position.candlesHeld || 1} candles | Entry=${position.entryPrice}`);
        }

        // ── 50%-rule exit → set pause for 2 candles ────────────────────────
        // 50% rule firing = price reversed immediately = choppy market.
        // Block re-entry for 2 candles (TRADE_RES * 2 * 60 seconds).
        if (exitReason.toLowerCase().includes('50% rule')) {
          const pauseSecs = 2 * candleResolutionMins * 60;
          _fiftyPctPauseUntilTs = candle.time + pauseSecs;
          if (_verbose) console.log(`  ⏸ 50%-rule pause set: no entry until ${toIST(_fiftyPctPauseUntilTs)}`);
        }

        // ── Risk controls ─────────────────────────────────────────────────────
        _dailyPnl += pnlRupees;
        _dailyTradeCount++;

        // Daily-loss kill switch — LATCH once the day's loss reaches the cap so a
        // later win can't unblock it (mirrors paper's session latch). Enforced at
        // the entry gate via _dailyLossHit (below).
        if (_dailyPnl <= -MAX_DAILY_LOSS) _dailyLossHit = true;

        // 3-consecutive-loss breaker — mirror paper EXACTLY (was an escalating pause):
        //   15-min: 3 losses = done for the day (latch _dailyLossHit).
        //   5-min:  pause 4 candles then resume, and reset the counter.
        if (pnlRupees < 0) {
          _consecutiveLosses++;
          if (_consecutiveLosses >= 3) {
            if (candleResolutionMins >= 15) {
              _dailyLossHit = true; // keep _consecutiveLosses at 3 (KILLED state)
            } else {
              _consecPauseUntilTs = candle.time + (4 * candleResolutionMins * 60);
              _consecutiveLosses  = 0;
            }
          }
        } else {
          _consecutiveLosses = 0;
        }
        // Chop-guard streak (SWING_MAX_CONSEC_LOSSES) — independent of the escalating
        // pause above so it survives until a win or a new day (mirrors paper/live).
        if (pnlRupees > 0)      { _chopConsecLosses = 0; }
        else if (pnlRupees < 0) { _chopConsecLosses++; }

        // Same-side SL cooldown: after an SL hit, block new entries on THAT side
        // for SWING_SL_PAUSE_CANDLES candles (mirrors SCALP per-side pause).
        const isSLExit = exitReason.toLowerCase().includes("sl hit");
        if (isSLExit) {
          _slPauseUntilBySide[position.side] = candle.time + (SWING_SL_PAUSE_CANDLES * candleResolutionMins * 60);
          if (_verbose) console.log(`  ⏸️ ${position.side} SL pause — no ${position.side} entries for ${SWING_SL_PAUSE_CANDLES} candles`);
        }

        // Opposite-side (flip) cooldown: after non-flip exit, block opposite-side entries.
        // Skip on opposite-signal exits (legit strategy flip) and EOD square-offs.
        if (OPP_COOLDOWN_ENABLED && OPP_COOLDOWN_CANDLES > 0
            && !/opposite signal|eod/i.test(exitReason)) {
          _oppositeCooldownUntilTs  = candle.time + (OPP_COOLDOWN_CANDLES * candleResolutionMins * 60);
          _oppositeCooldownLastSide = position.side;
          if (_verbose) console.log(`  🔁 Opposite-side cooldown — no ${position.side === "CE" ? "PE" : "CE"} entries for ${OPP_COOLDOWN_CANDLES} candles`);
        }

        // ── Notify strategy: optional exit callbacks
        const exitedSide = position.side;
        position = null;
        if (typeof strategy.onTradeClosed === "function") strategy.onTradeClosed();
        if (isSLExit && typeof strategy.onStopLossHit === "function") strategy.onStopLossHit(exitedSide);
      }
    }

    // ── ENTRY ─────────────────────────────────────────────────────────────────
    // Gate checks: same-side SL cooldown, consecutive-loss pause, daily loss limit
    const _sigSide = signal === "BUY_CE" ? "CE" : signal === "BUY_PE" ? "PE" : null;
    const isSideCoolingDown = _sigSide && _slPauseUntilBySide[_sigSide] > 0 && candle.time < _slPauseUntilBySide[_sigSide];
    const isOppositeCoolingDown = OPP_COOLDOWN_ENABLED
                                  && _sigSide && _oppositeCooldownLastSide
                                  && _sigSide !== _oppositeCooldownLastSide
                                  && candle.time < _oppositeCooldownUntilTs;
    const isConsecPaused = _consecPauseUntilTs > 0 && candle.time < _consecPauseUntilTs;
    const isChopHalted   = _SWING_MAX_CONSEC_LOSSES > 0 && _chopConsecLosses >= _SWING_MAX_CONSEC_LOSSES;
    const isDailyLossHit = _dailyLossHit; // latched: daily-loss cap OR 3-consec-loss (15-min)
    const isMaxTradesHit = _dailyTradeCount >= MAX_DAILY_TRADES;

    // Warm-up gate: candles before activeFromTs only build indicators (EMA/RSI/SAR),
    // they never open a trade. This lets a single-day (or any) range be evaluated
    // from its very first candle with fully-warmed indicators seeded by prior days,
    // instead of silently consuming the range's own opening candles as warm-up.
    const _isWarmupOnly = candle.time < activeFromTs;

    if (!position && !_isWarmupOnly && !isEntryBlocked && !isConsecPaused && !isChopHalted && !isDailyLossHit && !isMaxTradesHit) {
      const _confirmSwing = confirmCandle.enabled("SWING");

      // ── Confirmation candle (cross & close): fill an armed signal when THIS
      //    (immediately-next) candle crosses the signal candle's close. Candle-
      //    granularity proxy for the live intra-bar cross. Valid for one candle. ──
      if (_confirmSwing && _armedSwing) {
        const _a = _armedSwing;
        _armedSwing = null; // armed signal is good for exactly one candle — consume it
        if (confirmCandle.isNextBar(candle.time, _a.armedBarTime, candleResolutionMins)) {
          const _fill = confirmCandle.barCrossFill(_a.side, candle, _a.triggerLevel);
          if (_fill != null) {
            let entryPrice = _fill;
            if (SLIPPAGE_PTS > 0) {
              entryPrice = _a.side === "CE"
                ? quantize(entryPrice + SLIPPAGE_PTS, 2)
                : quantize(entryPrice - SLIPPAGE_PTS, 2);
            }
            const initSL = _a.signalSL != null ? quantize(_a.signalSL, 2) : null;
            position = {
              side:            _a.side,
              entryPrice,
              entryTime:       candle.time,
              entryReason:     `${_a.reason} | CONFIRM ${_a.side} x-over @${_a.triggerLevel}`,
              stopLoss:        initSL,
              initialStopLoss: initSL,
              bestPrice:       null,
              signalStrength:  _a.strength,
              candlesHeld:     0,
            };
            if (_verbose) console.log(`  ✅ CONFIRM ENTER ${_a.side} @ ${entryPrice} [${toIST(candle.time)}] x-over ${_a.triggerLevel} SL=${initSL}`);
            continue;
          }
        }
        // not the next candle, or never crossed → armed signal expired (consumed above)
      }

      if (_sigSide) {
        // Expiry-day-only filter: skip entry on non-expiry days
        if (expiryDates && !expiryDates.has(candleDate)) continue;
        // Same-side SL cooldown: skip this side until the pause expires
        if (isSideCoolingDown) continue;
        // Opposite-side cooldown: skip opposite side within cooldown window
        if (isOppositeCoolingDown) continue;

        const side     = _sigSide;
        const strength = signalStrength || "STRONG";

        // ── VIX filter: block entry in high-volatility regimes ──────────────────
        const _btVix = lookupVix(candle.time);
        const _btVixCheck = checkBacktestVix(_btVix, strength);
        if (!_btVixCheck.allowed) {
          _vixBlockCount++;
          if (_verbose && _vixBlockCount <= 5) {
            console.log(`  🌡️ VIX BLOCK: ${_btVixCheck.reason} | Signal: ${signal} at ${toIST(candle.time)}`);
          } else if (_verbose && _vixBlockCount === 6) {
            console.log(`  🌡️ VIX BLOCK: (suppressing further VIX block logs — ${_vixBlockCount} blocked so far)`);
          }
          continue;
        }

        // ── Confirmation candle ON: arm the signal — entry fires on the NEXT
        //    candle's cross (handled above), never on the signal candle itself. ──
        if (_confirmSwing) {
          _armedSwing = { side, armedBarTime: candle.time, triggerLevel: candle.close, signalSL, reason, strength };
          if (_verbose) console.log(`  🎯 ARM ${side} @ close ${candle.close} [${toIST(candle.time)}] — await next-candle cross`);
          continue;
        }

        // Entry at candle close — backtest's candle-granularity proxy for the
        // live intra-candle entry. Slippage worsens it (CE buy higher, PE buy lower).
        let entryPrice = candle.close;
        if (SLIPPAGE_PTS > 0) {
          entryPrice = side === "CE"
            ? quantize(entryPrice + SLIPPAGE_PTS, 2)
            : quantize(entryPrice - SLIPPAGE_PTS, 2);
        }

        // Initial SL = previous completed candle's low (CE) / high (PE), from getSignal.
        const initSL = signalSL != null ? quantize(signalSL, 2) : null;

        position = {
          side,
          entryPrice,
          entryTime:       candle.time,
          entryReason:     reason,
          stopLoss:        initSL,
          initialStopLoss: initSL,
          bestPrice:       null,
          signalStrength:  strength,
          candlesHeld:     0,
        };
        if (_verbose) {
          console.log(`  ✅ ENTER ${side} @ ${entryPrice} [${toIST(candle.time)}]  SL(prev-candle)=${initSL}`);
          console.log(`     Reason: ${reason}`);
        }
      }
    }
  }

  // Square off any still-open position at end of run
  if (position) {
    const lastCandle = candles[candles.length - 1];
    // Apply slippage to final exit
    let _finalExit = lastCandle.close;
    if (SLIPPAGE_PTS > 0) {
      _finalExit = position.side === "CE"
        ? quantize(_finalExit - SLIPPAGE_PTS, 2)
        : quantize(_finalExit + SLIPPAGE_PTS, 2);
    }
    const spotPnlPts = quantize((_finalExit - position.entryPrice) * (position.side === "CE" ? 1 : -1), 2);
    let pnlRupees, pnlMode;
    if (isFutures) {
      const _chgEod = getCharges({ isFutures: true, exitPremium: lastCandle.close, entryPremium: position.entryPrice, qty: LOT_SIZE });
      pnlRupees = quantize((spotPnlPts * LOT_SIZE) - _chgEod, 2);
      pnlMode   = `futures`;
    } else if (OPTION_SIM) {
      const premiumMovePts = spotPnlPts * DELTA;
      const candlesHeld    = position.candlesHeld || 1;
      const thetaDecay     = quantize((THETA_PER_DAY / CANDLES_PER_DAY) * candlesHeld, 2);
      const netPremPts     = premiumMovePts - thetaDecay;
      const estEntry       = 200;
      const estExit        = Math.max(1, estEntry + netPremPts);
      const _chgEod = getCharges({ isFutures: false, exitPremium: estExit, entryPremium: estEntry, qty: LOT_SIZE });
      pnlRupees = quantize((netPremPts * LOT_SIZE) - _chgEod, 2);
      pnlMode   = `opt_sim`;
    } else {
      pnlRupees = spotPnlPts;
      pnlMode   = "raw_pts";
    }
    trades.push({
      side:        position.side,
      entryTime:   toDateString(position.entryTime),
      exitTime:    toDateString(lastCandle.time),
      entryTs:     position.entryTime,
      exitTs:      lastCandle.time,
      entryPrice:  position.entryPrice,
      exitPrice:   _finalExit,
      stopLoss:         position.stopLoss || "N/A",
      initialStopLoss:  position.initialStopLoss || position.stopLoss || "N/A",
      bestPrice:        position.bestPrice || null,
      candlesHeld:      position.candlesHeld || 1,
      spotPnlPts,
      pnl:         pnlRupees,
      pnlMode,
      exitReason:  "EOD square-off (run end)",
      entryReason: position.entryReason,
    });
    if (typeof strategy.onTradeClosed === "function") strategy.onTradeClosed();
  }

  console.log("\n══════════════════════════════════════════════\n");

  const totalPnl      = trades.reduce((sum, t) => sum + t.pnl, 0);
  const wins          = trades.filter((t) => t.pnl > 0);
  const losses        = trades.filter((t) => t.pnl < 0);
  const maxDrawdown   = trades.reduce((dd, t) => Math.min(dd, t.pnl), 0);
  const totalDrawdown = losses.reduce((sum, t) => sum + t.pnl, 0);
  const maxProfit     = trades.reduce((mp, t) => Math.max(mp, t.pnl), 0);
  const avgWin        = wins.length   ? wins.reduce((s, t)   => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss       = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const riskReward    = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;

  // Total spot PnL in raw pts (always available regardless of sim mode)
  const totalSpotPts  = trades.reduce((s, t) => s + (t.spotPnlPts || t.pnl), 0);

  const pnlUnit  = OPTION_SIM ? "₹" : "pts";
  const fmtPnl   = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(OPTION_SIM ? 0 : 2)}${OPTION_SIM ? "" : " pts"}`;

  const strongTrades   = trades.filter((t) => t.signalStrength === "STRONG");
  const marginalTrades = trades.filter((t) => t.signalStrength !== "STRONG");
  const strongWins     = strongTrades.filter((t) => t.pnl > 0);
  const marginalWins   = marginalTrades.filter((t) => t.pnl > 0);
  const strongPnl      = strongTrades.reduce((s, t) => s + t.pnl, 0);
  const marginalPnl    = marginalTrades.reduce((s, t) => s + t.pnl, 0);

  const totalPnlFinal = parseFloat(totalPnl.toFixed(2));
  const wrFinal = trades.length ? ((wins.length / trades.length) * 100).toFixed(1) : "N/A";
  console.log("\n══════════════════════════════════════════════");
  console.log(`📊 BACKTEST COMPLETE — ${strategy.NAME}`);
  console.log(`   Period   : ${trades.length > 0 ? trades[0].entryTime + " → " + trades[trades.length-1].exitTime : "no trades"}`);
  console.log(`   Candles  : ${candles.length} (${candleResolutionMins}-min)`);
  console.log(`   PnL unit : ${OPTION_SIM ? `₹ (option sim: δ=${DELTA} θ=₹${THETA_PER_DAY}/day lot=${LOT_SIZE})` : "index pts (raw)"}`);
  console.log("──────────────────────────────────────────────");
  console.log(`   Trades   : ${trades.length} (${wins.length}W / ${losses.length}L)`);
  console.log(`   Win Rate : ${wrFinal}%`);
  console.log(`   R:R      : 1:${riskReward ? riskReward.toFixed(2) : "N/A"}`);
  console.log(`   Avg Win  : ${fmtPnl(avgWin)}`);
  console.log(`   Avg Loss : ${fmtPnl(avgLoss)}`);
  console.log(`   Total PnL: ${fmtPnl(totalPnlFinal)}${OPTION_SIM ? ` (spot total: ${totalSpotPts >= 0 ? "+" : ""}${totalSpotPts.toFixed(1)} NIFTY pts)` : ""}`);
  console.log(`   Max Win  : ${fmtPnl(maxProfit)}`);
  console.log(`   Max Loss : ${fmtPnl(maxDrawdown)}`);
  console.log(`   Total DD : ${fmtPnl(totalDrawdown)} (sum of all losses)`);
  if (OPTION_SIM) {
    console.log(`   Final Cap: ₹${(capital + totalPnlFinal).toLocaleString("en-IN", { maximumFractionDigits: 0 })} (started ₹${capital.toLocaleString("en-IN")})`);
  }
  console.log("──────────────────────────────────────────────");
  if (vixFilter.VIX_ENABLED && vixCandles && vixCandles.length > 0) {
    console.log(`  VIX blocked: ${_vixBlockCount} entries (signals matched but VIX too high)`);
  }
  console.log("── Signal Strength Breakdown ──────────────────────");
  console.log(`  STRONG  : ${strongTrades.length} trades | ${strongWins.length}W/${strongTrades.length - strongWins.length}L | WR=${strongTrades.length ? ((strongWins.length/strongTrades.length)*100).toFixed(1) : "N/A"}% | PnL=${fmtPnl(strongPnl)}`);
  console.log(`  MARGINAL: ${marginalTrades.length} trades | ${marginalWins.length}W/${marginalTrades.length - marginalWins.length}L | WR=${marginalTrades.length ? ((marginalWins.length/marginalTrades.length)*100).toFixed(1) : "N/A"}% | PnL=${fmtPnl(marginalPnl)}`);

  const exitGroups = {};
  trades.forEach(t => {
    const label = t.exitReason.includes('50% rule') ? '50% rule' : t.exitReason.includes('SL hit') ? 'SL hit' : t.exitReason.includes('Opposite') ? 'Opposite signal' : t.exitReason.includes('EOD') ? 'EOD square-off' : 'Other';
    if (!exitGroups[label]) exitGroups[label] = { count:0, wins:0, pnl:0 };
    exitGroups[label].count++;
    if (t.pnl > 0) exitGroups[label].wins++;
    exitGroups[label].pnl += t.pnl;
  });
  console.log("── Exit Reason Breakdown ──────────────────────────");
  Object.entries(exitGroups).sort((a,b) => b[1].count - a[1].count).forEach(([label, g]) => {
    console.log(`  ${label.padEnd(18)}: ${g.count} trades | ${g.wins}W/${g.count-g.wins}L | WR=${((g.wins/g.count)*100).toFixed(0)}% | PnL=${fmtPnl(g.pnl)}`);
  });
  // ── Signal Rejection Breakdown (why trades were blocked) ─────────────────
  const sortedRejects = Object.entries(_rejectCounts).sort((a, b) => b[1] - a[1]);
  if (sortedRejects.length > 0) {
    console.log("── Signal Rejection Breakdown (while flat) ────────");
    sortedRejects.slice(0, 15).forEach(([reason, count]) => {
      console.log(`  ${String(count).padStart(5)}× | ${reason}`);
    });
  }
  console.log("══════════════════════════════════════════════\n");

  return {
    summary: {
      strategy:        strategy.NAME,
      description:     strategy.DESCRIPTION,
      optionSim:       OPTION_SIM,
      pnlUnit:         OPTION_SIM ? "₹" : "pts",
      delta:           OPTION_SIM ? DELTA : null,
      thetaPerDay:     OPTION_SIM ? THETA_PER_DAY : null,
      lotSize:         LOT_SIZE,
      totalTrades:     trades.length,
      wins:            wins.length,
      losses:          losses.length,
      winRate:         trades.length ? `${((wins.length / trades.length) * 100).toFixed(1)}%` : "N/A",
      totalPnl:        parseFloat(totalPnl.toFixed(2)),
      totalSpotPts:    parseFloat(totalSpotPts.toFixed(2)),
      maxProfit:       parseFloat(maxProfit.toFixed(2)),
      maxDrawdown:     parseFloat(maxDrawdown.toFixed(2)),
      totalDrawdown:   parseFloat(totalDrawdown.toFixed(2)),
      avgWin:          parseFloat(avgWin.toFixed(2)),
      avgLoss:         parseFloat(avgLoss.toFixed(2)),
      riskReward:      riskReward ? `1:${riskReward.toFixed(2)}` : "N/A",
      // finalCapital: only meaningful in option sim mode (₹ + ₹ is valid)
      // In raw pts mode it was wrong (pts + ₹ = nonsense) — now shows null
      finalCapital:    OPTION_SIM ? parseFloat((capital + totalPnl).toFixed(2)) : null,
      strongTrades:    strongTrades.length,
      strongWinRate:   strongTrades.length ? `${((strongWins.length/strongTrades.length)*100).toFixed(1)}%` : "N/A",
      strongPnl:       parseFloat(strongPnl.toFixed(2)),
      marginalTrades:  marginalTrades.length,
      marginalWinRate: marginalTrades.length ? `${((marginalWins.length/marginalTrades.length)*100).toFixed(1)}%` : "N/A",
      marginalPnl:     parseFloat(marginalPnl.toFixed(2)),
      vixEnabled:      vixFilter.VIX_ENABLED,
      vixBlocked:      _vixBlockCount,
      vixMaxEntry:     vixFilter.VIX_MAX_ENTRY,
      vixStrongOnly:   vixFilter.VIX_STRONG_ONLY,
      rejectBreakdown: sortedRejects.slice(0, 10).map(([reason, count]) => ({ reason, count })),
    },
    trades,
  };
}

/**
 * Cached wrapper — uses disk cache for historical ranges, skips cache for today.
 * Drop-in replacement for fetchCandles in backtest routes.
 */
async function fetchCandlesCachedBT(symbol, resolution, from, to, skipCache = false, onProgress) {
  return fetchCandlesSmartCache(symbol, resolution, from, to, fetchCandles, skipCache, onProgress);
}

module.exports = { fetchCandles, fetchCandlesCachedBT, runBacktest };

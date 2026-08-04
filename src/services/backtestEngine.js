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
const tradeGuards   = require("../utils/tradeGuards");


function maxDaysForResolution(resolution) {
  // Fyers rejects a day/week/month request wider than 366 days with
  // {code:-50, message:"Invalid input", data:{range_to:"Date range cannot exceed
  // 366 days for 1D, 1W and 1M resolutions."}} — so daily must be chunked too.
  // fetchCandles() walks contiguous chunks and dedupes by timestamp, so this only
  // changes the number of API calls, never the returned series.
  if (["D", "W", "M"].includes(resolution)) return 366;
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
 * For EMA_RSI_ST (redefined 2026-05-27) the entry/exit model is:
 *   ENTRY  : strategy.getSignal(window) returns BUY_CE/BUY_PE (EMA alignment + RSI + SuperTrend rules).
 *            Entry price = candle.close (candle-granularity proxy for live intra-candle entry).
 *   STOP   : initial SL = previous completed candle low (CE) / high (PE), from getSignal.
 *            Trails EMA21, tighten-only. When EMA_RSI_ST_CANDLE_TRAIL_ENABLED, an N-bar low/high
 *            candle trail is layered on and the tighter of the two wins.
 *   EXIT   : trail SL hit · EMA21 touch-back · option-premium stop (OPT_STOP_PCT,
 *            approximated via an adverse spot move in backtest) · opposite signal · EOD.
 *   RISK   : same-side SL cooldown (EMA_RSI_ST_SL_PAUSE_CANDLES), VIX gate, MAX_DAILY_LOSS,
 *            3-consecutive-loss pause.
 *
 * Other strategies that reuse this engine keep their getSignal-driven behaviour; the
 * 50%-rule pause scaffolding is retained for them but EMA_RSI_ST no longer triggers it.
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
  // Realistic default: real NIFTY-option round trips cross a bid-ask spread +
  // slippage. Defaulting to 0 made every backtest fill at the ideal price and
  // overstated edge. 1.5pt each way (entry + exit) is a conservative floor; set
  // BACKTEST_SLIPPAGE_PTS=0 to restore the old frictionless behaviour.
  const SLIPPAGE_PTS = parseFloat(process.env.BACKTEST_SLIPPAGE_PTS || "1.5");

  // ── EMA_RSI_ST (redefined): exit/stop model ───────────────────────────────────
  //   Initial SL  : previous completed candle's low (CE) / high (PE) — from getSignal.
  //   Trail       : EMA21, tighten-only; optional N-bar candle-trail overlay
  //                 (EMA_RSI_ST_CANDLE_TRAIL_*) — tighter wins.
  //   Option stop : exit if the (simulated) option premium drops OPT_STOP_PCT from entry.
  //   Same-side cooldown: after an SL hit on a side, block that side for N candles.
  const EMA_RSI_ST_SL_PAUSE_CANDLES = parseInt(process.env.EMA_RSI_ST_SL_PAUSE_CANDLES || "3", 10);
  const OPT_STOP_PCT           = parseFloat(process.env.OPT_STOP_PCT || "0.15");
  // Per-trade catastrophic spot-points cap (mirrors BB_RSI_STOP_LOSS_PTS). 0 = off.
  const _EMA_RSI_ST_STOP_LOSS_PTS   = parseFloat(process.env.EMA_RSI_ST_STOP_LOSS_PTS || "0");
  // Negative-candle stop: square off a trade still in the RED after N candles (cut losers
  // fast, let winners ride the EMA trail). 0 = off. Default 2 (added 2026-06-19).
  const _EMA_RSI_ST_NEG_CANDLE_LIMIT = parseInt(process.env.EMA_RSI_ST_NEG_CANDLE_LIMIT || "2", 10);
  // Chop guard: halt new entries for the rest of the day after N consecutive losing
  // trades (any win resets the streak). Mirrors paper/live. 0 = off.
  const _EMA_RSI_ST_MAX_CONSEC_LOSSES = parseInt(process.env.EMA_RSI_ST_MAX_CONSEC_LOSSES || "0", 10);
  // Opposite-side (flip) cooldown — block opposite-side entry for N candles after non-flip exit.
  const OPP_COOLDOWN_ENABLED   = (process.env.EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED || "true").toLowerCase() === "true";
  const OPP_COOLDOWN_CANDLES   = parseInt(process.env.EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES || "3", 10);
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
  console.log(`   EMA_RSI_ST(redefined): EMA+RSI+SuperTrend | EMA21 trail${(process.env.EMA_RSI_ST_CANDLE_TRAIL_ENABLED || "false").toLowerCase() === "true" ? ` + ${Math.max(1, parseInt(process.env.EMA_RSI_ST_CANDLE_TRAIL_BARS || "3", 10))}-bar candle trail (tighter wins)` : ""} | optStop ${(OPT_STOP_PCT*100).toFixed(0)}% | same-side cooldown ${EMA_RSI_ST_SL_PAUSE_CANDLES} candles`);

  // 50%-rule exit pause: retained for non-EMA_RSI_ST strategies that use this engine.
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
  let _chopConsecLosses     = 0;       // chop-guard streak (EMA_RSI_ST_MAX_CONSEC_LOSSES), reset on win or new day
  const _slPauseUntilBySide = { CE: 0, PE: 0 }; // same-side SL cooldown (unix secs), reset per day
  let _oppositeCooldownUntilTs   = 0;     // opposite-side cooldown (unix secs), reset per day
  let _oppositeCooldownLastSide  = null;  // last exited side
  // Confirmation candle (cross & close, EMA_RSI_ST only — EMA_RSI_ST_CONFIRM_CANDLE_ENABLED).
  // { side, armedBarTime, triggerLevel, signalSL, reason, strength } | null.
  let _armedSwing = null;
  // Arm decided at THIS candle's close, published at the top of the next candle —
  // see the CONFIRMATION ARM block below for why it is staged rather than set live.
  let _pendingArm = null;
  // EMA21 trail base from the PRIOR candle's close. Paper arms the EMA21 trail at a
  // candle's close and enforces it on the NEXT candle's ticks; using this candle's own
  // EMA21 to update the SL and then testing this candle's low/high against it is
  // look-ahead. We carry last candle's EMA21 forward and trail on it instead.
  let _prevEma21 = null;
  console.log(`   Risk controls: MAX_DAILY_LOSS=₹${MAX_DAILY_LOSS} | MAX_DAILY_TRADES=${MAX_DAILY_TRADES} | 3-consec-loss=kill(15min)/pause(5min)`);
  if (SLIPPAGE_PTS > 0) console.log(`   Slippage sim : ${SLIPPAGE_PTS} pts per side (entry + exit)`);

  // EOD times — mirror emaRsiStPaper EXACTLY so backtest squares off / blocks entries at
  // the same IST minutes as paper (not a hardcoded 3:20). Paper has TWO distinct times:
  // entry cutoff = TRADE_STOP_TIME − 10 (paper's _ENTRY_STOP_MINS, ~15:20) and exit
  // square-off = EMA_RSI_ST_EOD_EXIT_TIME (~15:15). Collapsing both into one 3:20 made the
  // backtest hold ~5 min past paper's square-off.
  const _stopMins     = (() => { const v = (process.env.TRADE_STOP_TIME || "15:30").split(":"); return parseInt(v[0], 10) * 60 + (parseInt(v[1], 10) || 0); })();
  const _entryStopMin = _stopMins - 10;
  const _eodExitMin   = (() => { const v = (process.env.EMA_RSI_ST_EOD_EXIT_TIME || "15:15").split(":"); const h = parseInt(v[0], 10); return isNaN(h) ? _stopMins : (h * 60 + (parseInt(v[1], 10) || 0)); })();
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
    // Rolling indicator history — depth shared with paper + live (see
    // tradeGuards.INDICATOR_HISTORY_CANDLES). Seeded at 30 above, so this window
    // grows to exactly the shared depth and stays there.
    if (window.length > tradeGuards.INDICATOR_HISTORY_CANDLES) window.shift();

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
        _pendingArm               = null; // ...including one staged at yesterday's close
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
    // Publish the arm staged at the previous candle's close, and drop anything older
    // in the same stroke — that unconditional overwrite IS emaRsiStPaper's "expire any
    // arm whose confirmation candle has passed" rule (onCandleClose), which this engine
    // otherwise only approximated via isNextBar() at fill time.
    _armedSwing = _pendingArm;
    _pendingArm = null;

    const nextCandle = candles[i + 1] || null;
    const nextDate   = nextCandle ? getISTDateStr(nextCandle.time) : null;
    const isLastCandleOfDay = !nextCandle || nextDate !== candleDate;

    // Also check time — force EOD at 3:20 PM regardless
    const candleMin     = getISTHHMM(candle.time);
    // Two distinct times, mirroring emaRsiStPaper: exit square-off at EMA_RSI_ST_EOD_EXIT_TIME
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
    // back EMA21 is an explicit exit. When EMA_RSI_ST_CANDLE_TRAIL_ENABLED, an N-bar low (CE)
    // / high (PE) trail is layered on and the TIGHTER of the two wins. The window ends at
    // the prior bar (i-1) to mirror paper's "SL from prior bars enforced on this bar" timing.
    // The touch-back exit is wired below in the EXIT CHECK block.
    if (position) {
      let trailRef = null;
      // Use the PRIOR candle's EMA21 (armed at the last close), not this candle's —
      // mirrors paper's "SL from prior bars enforced on this bar" timing (no look-ahead).
      if (_prevEma21 != null) trailRef = _prevEma21;
      // Candle-trail overlay: N-bar low (CE) / high (PE), keep the tighter of EMA21 vs candle.
      const _ctOn   = (process.env.EMA_RSI_ST_CANDLE_TRAIL_ENABLED || "false").toLowerCase() === "true";
      const _ctBars = Math.max(1, parseInt(process.env.EMA_RSI_ST_CANDLE_TRAIL_BARS || "3", 10));
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
      // Breakeven floor (default OFF) — mirrors emaRsiStPaper. Once >= BE pts in
      // profit at candle close, raise the stop to entry (tighten-only).
      if ((process.env.EMA_RSI_ST_BREAKEVEN_ENABLED || "false").toLowerCase() === "true") {
        const _bePts = parseFloat(process.env.EMA_RSI_ST_BREAKEVEN_PTS || "25");
        const _profit = position.side === "CE" ? (candle.close - position.entryPrice) : (position.entryPrice - candle.close);
        if (_profit >= _bePts) {
          const _be = quantize(position.entryPrice, 2);
          if (position.side === "CE" && (position.stopLoss == null || position.stopLoss < _be)) position.stopLoss = _be;
          else if (position.side === "PE" && (position.stopLoss == null || position.stopLoss > _be)) position.stopLoss = _be;
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

    // candlesHeld is NOT incremented here. It is incremented inside runExitChecks
    // at the exact point emaRsiStPaper increments it — see the note there.

    // ── EXIT CHECK ────────────────────────────────────────────────────────────
    // H1 — SAME-BAR EXIT PARITY.
    // Paper and live enforce the tick-level stops from the moment of entry, so a
    // position opened at 11:05 inside the 11:05 bar can stop out inside that same
    // bar. This engine used to create the position at the BOTTOM of the iteration,
    // so its first exit check was the NEXT candle — it could never reproduce a
    // same-bar stop-out, which was 20 of the user's 65 recorded paper trades.
    //
    // Fix: the whole exit evaluation lives in this per-candle closure so it can be
    // invoked twice — once for a position carried in from an earlier candle
    // (entryBar=false, unchanged), and once immediately after an INTRA-BAR confirm
    // fill on THIS candle (entryBar=true). It only ever reads `candle`; no future
    // candle is touched, so no look-ahead is introduced. The candle-CLOSE entry
    // path deliberately does NOT call it — see the note at that entry site.
    //
    // On the entry bar the rule set matches paper's ordering exactly:
    //   run  — structural/trail SL, points cap, option-premium stop (paper's
    //          per-tick stops, which fire before the bar closes), then opposite
    //          signal and EOD (paper's candle-close rules, which do run on the
    //          entry bar).
    //   skip — EMA21 touch-back: paper explicitly skips it on the entry bar.
    //   run  — negative-candle stop: ungated on purpose. candlesHeld becomes 1 at
    //          the bar-close point below, exactly as paper's onCandleClose does on
    //          the entry bar, so with the default LIMIT=2 it cannot fire — and if
    //          LIMIT were 1, paper would fire it there too. Parity, not luck.
    // Gap-through fill is also skipped on the entry bar: the bar's OPEN happened
    // before we entered, so filling there would be fiction.
    // ── Per-candle parity flags (mirror emaRsiStPaper's onCandleClose control flow) ──
    // _openAtCandleClose: a position was STILL OPEN when this bar closed — i.e. it
    //   survived the intra-bar tick stops. Paper's confirmation-arm block sits ABOVE
    //   all of its candle-close exit rules and is gated on `!ptState.position`, so a
    //   trade that exits AT this close (negative-candle / touch-back / opposite /
    //   EOD) still blocks arming on its own exit candle. This engine evaluates entry
    //   after the exit, so without this flag it would arm on that candle and enter a
    //   full bar earlier than paper. A trade that exited on a TICK stop leaves the
    //   flag false — paper's arm block does run in that case.
    // _blockEntryAfterExit: paper `return`s out of onCandleClose after a
    //   negative-candle stop and after an EOD square-off, so no entry can follow on
    //   that same candle. It falls THROUGH after a touch-back or opposite-signal
    //   exit, so those still allow one. Only reachable with the confirmation candle
    //   OFF (the candle-close entry path); harmless otherwise.
    let _openAtCandleClose   = false;
    let _blockEntryAfterExit = false;

    const runExitChecks = (opts) => {
      const entryBar = !!(opts && opts.entryBar);
      if (!position) return;
      let exitReason = null;
      let exitPrice  = candle.close;

      // Rule 1: SL or trail SL (uses candle low/high as intra-candle proxy)
      if (position.stopLoss !== null && position.stopLoss !== undefined) {
        // Determine SL type for clear labeling
        const _isTrailSL = position.initialStopLoss != null &&
                           Math.abs(position.stopLoss - position.initialStopLoss) > 1;
        const _slLabel = _isTrailSL ? "Trail SL" : "Initial SL";

        // Gap-through fill: if the candle OPENED beyond the stop, the stop could
        // only have filled at the (worse) open, not at the stop level. Modelling
        // the fill at the exact stop understates losses on gap/spike candles —
        // exactly the trades that hurt live. Use the worse of (stop, open).
        // Not applicable on the entry bar (its open precedes our fill).
        if (position.side === "CE" && candle.low <= position.stopLoss) {
          exitPrice  = (!entryBar && candle.open < position.stopLoss) ? candle.open : position.stopLoss;
          exitReason = `${_slLabel} hit — low ${candle.low} <= SL ${position.stopLoss}${exitPrice < position.stopLoss ? ` (gap fill @ ${exitPrice})` : ""}`;
        } else if (position.side === "PE" && candle.high >= position.stopLoss) {
          exitPrice  = (!entryBar && candle.open > position.stopLoss) ? candle.open : position.stopLoss;
          exitReason = `${_slLabel} hit — high ${candle.high} >= SL ${position.stopLoss}${exitPrice > position.stopLoss ? ` (gap fill @ ${exitPrice})` : ""}`;
        }
      }

      // Rule 1a: per-trade points stop (EMA_RSI_ST_STOP_LOSS_PTS) — catastrophic spot cap.
      // Mirrors BB_RSI_STOP_LOSS_PTS. Use the tighter of (structural SL, cap level):
      // whichever sits closer to entry is hit first intra-candle. 0 = disabled.
      if (_EMA_RSI_ST_STOP_LOSS_PTS > 0) {
        const adverse = position.side === "CE"
          ? (position.entryPrice - candle.low)
          : (candle.high - position.entryPrice);
        if (adverse >= _EMA_RSI_ST_STOP_LOSS_PTS) {
          const _capLvl = position.side === "CE"
            ? quantize(position.entryPrice - _EMA_RSI_ST_STOP_LOSS_PTS, 2)
            : quantize(position.entryPrice + _EMA_RSI_ST_STOP_LOSS_PTS, 2);
          // Override only if no structural SL fired, or the cap is tighter (closer to entry).
          const _capTighter = !exitReason || (position.side === "CE" ? _capLvl > exitPrice : _capLvl < exitPrice);
          if (_capTighter) {
            exitReason = `SL (${_EMA_RSI_ST_STOP_LOSS_PTS}pts)`;
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

      // ── BAR CLOSE ───────────────────────────────────────────────────────────
      // Everything above (rules 1 / 1a / 1b) is a per-TICK stop: paper enforces
      // those continuously while the bar is still forming. Everything below is a
      // candle-CLOSE rule that paper evaluates inside onCandleClose.
      //
      // emaRsiStPaper increments candlesHeld at the TOP of onCandleClose — after
      // the bar's ticks, before every candle-close rule. That placement matters:
      // paper tests the negative-candle stop IMMEDIATELY after incrementing, on
      // the same bar. This engine used to increment at the top of the candle loop
      // instead, so at any given bar its counter was one lower than paper's at the
      // moment the rule was tested, and the 2-candle negative stop fired a full
      // candle LATE (paper: close of entry+1, backtest: close of entry+2).
      //
      // Skipped when a tick stop already fired: paper's position is closed before
      // onCandleClose runs, so paper never increments on that bar either.
      if (!exitReason) {
        position.candlesHeld = (position.candlesHeld || 0) + 1;
        // The bar closed with us still holding — this is the exact moment paper's
        // arm block sees a live position and therefore refuses to arm.
        _openAtCandleClose = true;
      }

      // Rule 1c: EMA21 touch-back exit — paper skips this on the entry bar
      // (the entry condition trivially satisfies a touch), so we do too.
      if (!exitReason && !entryBar && _sig.ema21 != null) {
        if (candle.low <= _sig.ema21 && candle.high >= _sig.ema21) {
          exitReason = "EMA touch-back exit";
          exitPrice  = candle.close;
        }
      }

      // Rule 1d: Negative-candle stop — if the trade is still in the RED at this
      // candle close after N candles held, square off (asymmetric loss-cut; winners
      // keep riding the EMA trail above). "Negative" ≈ spot close against entry.
      if (!exitReason && _EMA_RSI_ST_NEG_CANDLE_LIMIT > 0 && (position.candlesHeld || 0) >= _EMA_RSI_ST_NEG_CANDLE_LIMIT) {
        const _closePnlPts = (candle.close - position.entryPrice) * (position.side === "CE" ? 1 : -1);
        if (_closePnlPts < 0) {
          exitReason = `Negative ${_EMA_RSI_ST_NEG_CANDLE_LIMIT}-candle stop`;
          exitPrice  = candle.close;
        }
      }

      // Rule 2: Opposite signal
      if (!exitReason && signal === (position.side === "CE" ? "BUY_PE" : "BUY_CE")) {
        exitReason = "Opposite signal exit";
        exitPrice  = candle.close;
      }

      // Rule 3: EOD square-off — PER DAY at EMA_RSI_ST_EOD_EXIT_TIME (mirrors emaRsiStPaper)
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
          // `?? 1` not `|| 1`: a same-bar (entry-bar) exit legitimately has 0
          // candles held and must not be charged a candle of theta. Every other
          // path has >= 1, so this is behaviour-identical for them.
          const candlesHeld    = position.candlesHeld ?? 1;
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
          candlesHeld:     position.candlesHeld ?? 1,   // 0 on a same-bar exit — see theta note
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

        // Consecutive-loss breaker — mirror paper EXACTLY:
        //   15-min: limit reached = done for the day (latch _dailyLossHit).
        //   5-min:  pause 4 candles then resume, and reset the counter.
        // The limit is EMA_RSI_ST_MAX_CONSEC_LOSSES (0 = OFF), the SAME key the
        // chop guard below uses. It was hardcoded to 3 here and in paper/live, so a
        // configured 0 ("OFF") still paused entries — the backtest inherited that
        // and would now over-report pauses paper no longer takes.
        const _streakMax = parseInt(process.env.EMA_RSI_ST_MAX_CONSEC_LOSSES || "0", 10) > 0
          ? parseInt(process.env.EMA_RSI_ST_MAX_CONSEC_LOSSES, 10)
          : 0;
        if (pnlRupees < 0) {
          _consecutiveLosses++;
          if (_streakMax > 0 && _consecutiveLosses >= _streakMax) {
            if (candleResolutionMins >= 15) {
              _dailyLossHit = true; // keep the counter at the limit (KILLED state)
            } else {
              _consecPauseUntilTs = candle.time + (4 * candleResolutionMins * 60);
              _consecutiveLosses  = 0;
            }
          }
        } else {
          _consecutiveLosses = 0;
        }
        // Chop-guard streak (EMA_RSI_ST_MAX_CONSEC_LOSSES) — independent of the escalating
        // pause above so it survives until a win or a new day (mirrors paper/live).
        if (pnlRupees > 0)      { _chopConsecLosses = 0; }
        else if (pnlRupees < 0) { _chopConsecLosses++; }

        // Same-side SL cooldown: after an SL hit, block new entries on THAT side
        // for EMA_RSI_ST_SL_PAUSE_CANDLES candles (mirrors BB_RSI per-side pause).
        const isSLExit = exitReason.toLowerCase().includes("sl hit");
        if (isSLExit) {
          _slPauseUntilBySide[position.side] = candle.time + (EMA_RSI_ST_SL_PAUSE_CANDLES * candleResolutionMins * 60);
          if (_verbose) console.log(`  ⏸️ ${position.side} SL pause — no ${position.side} entries for ${EMA_RSI_ST_SL_PAUSE_CANDLES} candles`);
        }

        // Opposite-side (flip) cooldown: after non-flip exit, block opposite-side entries.
        // Skip on opposite-signal exits (legit strategy flip) and EOD square-offs.
        if (OPP_COOLDOWN_ENABLED && OPP_COOLDOWN_CANDLES > 0
            && !/opposite signal|eod/i.test(exitReason)) {
          _oppositeCooldownUntilTs  = candle.time + (OPP_COOLDOWN_CANDLES * candleResolutionMins * 60);
          _oppositeCooldownLastSide = position.side;
          if (_verbose) console.log(`  🔁 Opposite-side cooldown — no ${position.side === "CE" ? "PE" : "CE"} entries for ${OPP_COOLDOWN_CANDLES} candles`);
        }

        // Paper `return`s out of onCandleClose after these two, so no entry can
        // follow on the same candle; it falls through after touch-back / opposite.
        if (/negative \d+-candle stop|eod/i.test(exitReason)) _blockEntryAfterExit = true;

        // ── Notify strategy: optional exit callbacks
        const exitedSide = position.side;
        position = null;
        if (typeof strategy.onTradeClosed === "function") strategy.onTradeClosed();
        if (isSLExit && typeof strategy.onStopLossHit === "function") strategy.onStopLossHit(exitedSide);
      }
    };

    // Carried-in position: unchanged timing, unchanged rules.
    runExitChecks({ entryBar: false });

    // ── ENTRY ─────────────────────────────────────────────────────────────────
    // Gate checks: same-side SL cooldown, consecutive-loss pause, daily loss limit
    const _sigSide = signal === "BUY_CE" ? "CE" : signal === "BUY_PE" ? "PE" : null;
    // Per-SIDE, not per-signal: the confirmation fill enters the ARMED side, which is
    // the previous candle's signal and need not equal this candle's _sigSide. Paper
    // applies both cooldowns inside simulateBuy() against the side actually being
    // bought, so every entry path gets them; this engine's fill path used to skip
    // them entirely (masked before, because arming was itself blocked while paused).
    const _sidePaused = (s) => !!s && _slPauseUntilBySide[s] > 0 && candle.time < _slPauseUntilBySide[s];
    const _oppPaused  = (s) => !!(OPP_COOLDOWN_ENABLED && s && _oppositeCooldownLastSide
                                  && s !== _oppositeCooldownLastSide
                                  && candle.time < _oppositeCooldownUntilTs);
    const isSideCoolingDown     = _sidePaused(_sigSide);
    const isOppositeCoolingDown = _oppPaused(_sigSide);
    const isConsecPaused = _consecPauseUntilTs > 0 && candle.time < _consecPauseUntilTs;
    const isChopHalted   = _EMA_RSI_ST_MAX_CONSEC_LOSSES > 0 && _chopConsecLosses >= _EMA_RSI_ST_MAX_CONSEC_LOSSES;
    const isDailyLossHit = _dailyLossHit; // latched: daily-loss cap OR 3-consec-loss (15-min)
    const isMaxTradesHit = _dailyTradeCount >= MAX_DAILY_TRADES;

    // Warm-up gate: candles before activeFromTs only build indicators (EMA/RSI/SAR),
    // they never open a trade. This lets a single-day (or any) range be evaluated
    // from its very first candle with fully-warmed indicators seeded by prior days,
    // instead of silently consuming the range's own opening candles as warm-up.
    const _isWarmupOnly = candle.time < activeFromTs;

    // ── CONFIRMATION ARM (paper parity) ───────────────────────────────────────
    // emaRsiStPaper arms at candle close gated ONLY on "flat + valid signal". Every
    // risk guard — same-side SL pause, opposite-side cooldown, consecutive-loss
    // pause, chop halt, daily-loss latch, max-trades, VIX, OI — is evaluated LATER,
    // at fill time in onTick. This engine used to arm INSIDE its guard-gated entry
    // block, so a signal printing on the LAST candle of a pause never armed at all,
    // and the entry paper takes on the very next candle (pause now expired) was
    // silently absent from every backtest.
    //
    // Staged into _pendingArm rather than assigned live: this candle's fill attempt
    // below still has to consume the arm made at the PREVIOUS close, and writing
    // _armedSwing here would destroy it.
    //
    // Still gated on: flat at this close (paper's `!ptState.position`, which for a
    // trade exiting AT this close means no arm — see _openAtCandleClose), warm-up
    // (paper has no candle-close handler for pre-loaded history), and the
    // backtest-only expiry-day filter, which is retained exactly where it was.
    if (confirmCandle.enabled("EMA_RSI_ST") && !position && !_openAtCandleClose
        && !_isWarmupOnly && _sigSide
        && !(expiryDates && !expiryDates.has(candleDate))) {
      _pendingArm = {
        side: _sigSide, armedBarTime: candle.time, triggerLevel: candle.close,
        signalSL, reason, strength: signalStrength || "STRONG",
      };
      if (_verbose) console.log(`  🎯 ARM ${_sigSide} @ close ${candle.close} [${toIST(candle.time)}] — await next-candle cross`);
    }

    if (!position && !_blockEntryAfterExit && !_isWarmupOnly && !isEntryBlocked && !isConsecPaused && !isChopHalted && !isDailyLossHit && !isMaxTradesHit) {
      const _confirmSwing = confirmCandle.enabled("EMA_RSI_ST");

      // ── Confirmation candle (cross & close): fill an armed signal when THIS
      //    (immediately-next) candle crosses the signal candle's close. Candle-
      //    granularity proxy for the live intra-bar cross. Valid for one candle. ──
      if (_confirmSwing && _armedSwing) {
        const _a = _armedSwing;
        _armedSwing = null; // armed signal is good for exactly one candle — consume it
        // ── Per-side cooldowns on the ARMED side ──────────────────────────────
        // emaRsiStPaper rejects inside simulateBuy(), i.e. on EVERY entry path,
        // against the side actually being bought. The arm is already consumed
        // above, so a rejection burns it exactly as paper burns _armedSignal
        // before its async order call. Keyed on _a.side, not _sigSide — the armed
        // side is the PREVIOUS candle's signal and the two can differ.
        if (_sidePaused(_a.side) || _oppPaused(_a.side)) {
          if (_verbose) console.log(`  ⏸️ CONFIRM ${_a.side} rejected — ${_sidePaused(_a.side) ? "same-side SL" : "opposite-side"} cooldown active [${toIST(candle.time)}]`);
          continue;
        }
        // VIX gate — same reason as the cooldowns above. emaRsiStPaper runs
        // checkLiveVix() in onTick right before the confirmation entry, so the fill
        // is gated on the VIX at FILL time with the ARMED signal's strength. This
        // path used to skip it entirely (the check below sits under `if (_sigSide)`,
        // which the fill never reaches), so with VIX filtering ON the backtest took
        // confirmation entries paper would have blocked.
        const _fillVixCheck = checkBacktestVix(lookupVix(candle.time), _a.strength);
        if (!_fillVixCheck.allowed) {
          _vixBlockCount++;
          if (_verbose && _vixBlockCount <= 5) console.log(`  🌡️ VIX BLOCK (confirm fill): ${_fillVixCheck.reason} | ${_a.side} at ${toIST(candle.time)}`);
          continue;
        }
        // ── Entry-window enforcement on the CONFIRMATION candle ────────────────
        // Mirrors emaRsiStPaper / emaRsiStLive. getSignal() blocks bars outside
        // TRADE_ENTRY_START/END, but this fill path never calls getSignal — so a
        // signal candle closing at TRADE_ENTRY_END could otherwise fill on the
        // candle after it. Engines that don't expose the window are unaffected.
        const _confirmInWindow = typeof strategy.isInTradingWindow !== "function"
                                 || strategy.isInTradingWindow(candle.time).ok;
        // M4 — say what actually happened. An arm dies for one of two distinct
        // reasons and the log used to blame the window for both.
        const _isConfirmCandle = confirmCandle.isNextBar(candle.time, _a.armedBarTime, candleResolutionMins);
        if (_verbose && !_isConfirmCandle) {
          console.log(`  ⌛ ARM ${_a.side} expired — this is not its confirmation candle [${toIST(candle.time)}]`);
        } else if (_verbose && !_confirmInWindow) {
          console.log(`  ⏰ ARM ${_a.side} dropped — its confirmation candle is outside the entry window [${toIST(candle.time)}]`);
        }
        if (_confirmInWindow && _isConfirmCandle) {
          const _fill = confirmCandle.barCrossFill(_a.side, candle, _a.triggerLevel);
          if (_fill != null) {
            let entryPrice = _fill;
            if (SLIPPAGE_PTS > 0) {
              entryPrice = _a.side === "CE"
                ? quantize(entryPrice + SLIPPAGE_PTS, 2)
                : quantize(entryPrice - SLIPPAGE_PTS, 2);
            }
            // Protective-stop correction — same shared helper as paper/live.
            // `window` already holds THIS confirmation candle, so drop the last
            // element: the resolver must see exactly what the live engines see,
            // i.e. newest element = the SIGNAL candle. Dropping it also keeps the
            // backtest free of look-ahead into the still-forming entry bar. The
            // remainder IS the strategy's own 200-candle window — the search
            // bound is that history, not a separate constant.
            const _slFixConfirm = tradeGuards.resolveProtectiveStop({
              side:       _a.side,
              entryPrice,
              stopLoss:   _a.signalSL != null ? quantize(_a.signalSL, 2) : null,
              candles:    window,
              // `beforeTime` (not a manual slice) excludes THIS confirmation
              // candle, so the resolver sees the signal candle and older — the
              // identical view paper/live get, and no look-ahead into the bar
              // we are filling on.
              beforeTime: candle.time,
            });
            if (_a.signalSL != null && _slFixConfirm.stopLoss == null) {
              // M1 — no protective structure anywhere; do not open the position.
              if (_verbose) console.log(`  🚫 ENTRY ABORTED — ${_slFixConfirm.reason}`);
              continue;
            }
            const initSL = _slFixConfirm.stopLoss;
            if (_verbose && _slFixConfirm.repaired) console.log(`  🛡️ Initial SL corrected — ${_slFixConfirm.reason}`);
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
            // H1: paper/live can stop out inside the entry bar — so must we.
            runExitChecks({ entryBar: true });
            // Paper's arm block sits at this close and is gated on `!ptState.position`.
            // Still holding → it would not arm, so drop the arm staged above. But if the
            // entry bar's own TICK stop already closed us out, paper is flat by then and
            // does arm — so in that case the staged arm stands.
            if (position || _openAtCandleClose) _pendingArm = null;
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
        // Confirmation candle ON: entry only ever happens via the next-candle cross
        // in the fill block above. The arm itself was decided before this guarded
        // block (see CONFIRMATION ARM) because paper does not guard it.
        if (_confirmSwing) continue;

        // Entry at candle close — backtest's candle-granularity proxy for the
        // live intra-candle entry. Slippage worsens it (CE buy higher, PE buy lower).
        let entryPrice = candle.close;
        if (SLIPPAGE_PTS > 0) {
          entryPrice = side === "CE"
            ? quantize(entryPrice + SLIPPAGE_PTS, 2)
            : quantize(entryPrice - SLIPPAGE_PTS, 2);
        }

        // Initial SL = previous completed candle's low (CE) / high (PE), from getSignal.
        // Protective-stop correction — same shared helper as paper/live. Here the
        // signal candle IS this candle and `window` already ends with it, matching
        // emaRsiStPaper's candle-close entry path exactly.
        const _slFixClose = tradeGuards.resolveProtectiveStop({
          side,
          entryPrice,
          stopLoss: signalSL != null ? quantize(signalSL, 2) : null,
          candles:  window,
          // Entry is at THIS candle's close, so it is fully closed structure and
          // must be visible; the next bar is the one still forming.
          beforeTime: candle.time + candleResolutionMins * 60,
        });
        if (signalSL != null && _slFixClose.stopLoss == null) {
          // M1 — no protective structure anywhere; do not open the position.
          if (_verbose) console.log(`  🚫 ENTRY ABORTED — ${_slFixClose.reason}`);
          continue;
        }
        const initSL = _slFixClose.stopLoss;
        if (_verbose && _slFixClose.repaired) console.log(`  🛡️ Initial SL corrected — ${_slFixClose.reason}`);

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
        // NO entry-bar exit check on this path — and that is deliberate.
        // This is the candle-CLOSE entry, reached only when the confirmation
        // candle is OFF. emaRsiStPaper's matching path (the `!confirmCandle
        // .enabled(...)` branch at the bottom of onCandleClose) runs AFTER every
        // exit rule for that bar, and paper's next tick already belongs to the
        // next bar — so paper cannot exit on its own candle-close entry bar.
        // Calling runExitChecks here would also test the stop against a low/high
        // that was printed BEFORE the close we filled at. The intra-bar confirm
        // fill above is different: it enters mid-bar, so paper really can stop
        // out inside that bar, which is why only that path checks.
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

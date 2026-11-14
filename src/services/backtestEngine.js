require("dotenv").config();
const fyers = require("../config/fyers");
const { toDateString, today: todayIST } = require("../utils/time");
const { fyersErrText } = require("../utils/fyersErr");

const vixFilter = require("./vixFilter");
const { buildVixLookup, checkBacktestVix, VIX_SYMBOL } = vixFilter;

const instrumentConfig = require("../config/instrument");
const { getLotQty } = instrumentConfig;
const { getCharges } = require("../utils/charges");
const { fetchCandlesWithCache, fetchCandlesSmartCache } = require("../utils/backtestCache");
const confirmCandle = require("../utils/confirmCandle");
const tradeGuards   = require("../utils/tradeGuards");


const _isIntradayRes = (resolution) => /^\d+$/.test(String(resolution));

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

async function fetchChunk(symbol, resolution, from, to, opts = {}) {
  const params = { symbol, resolution: String(resolution), date_format: "1", range_from: from, range_to: to, cont_flag: "1" };
  console.log(`   📦 Fetching chunk: ${from} → ${to}`);
  let response;
  try {
    // The shared Fyers pacer (config/fyers.js) fails a request that cannot get a
    // slot within ~15s — right for live quotes, wrong for a backtest, whose candles
    // do not go stale. A backtest opts in (opts.waitForSlot) to wait outside the
    // queue (so live calls still go first) and retry. Paper warm-up does not opt in.
    for (let attempt = 1; ; attempt++) {
      try { response = await fyers.getHistory(params); break; } catch (e) {
        if (!opts.waitForSlot || attempt >= 8 || !/request limit reached, no free slot/.test((e && e.message) || "")) throw e;
        console.warn(`   ⏳ Fyers request limit busy — retrying chunk ${from} → ${to} in 15s (${attempt}/7)`);
        await sleep(15000);
      }
    }
  } catch (err) {
    // The SDK rejects with Fyers' raw body, a plain object whose `.message` is the
    // useless bare word "Invalid input" — the parameter it actually objected to is
    // in `.data`. Left unconverted, that object reaches failJob(err.message) and the
    // user sees two words with no way to act on them. Say what was asked for too:
    // the range here is derived (month-widened, then chunked), so it is not visible
    // from the page the request came from.
    throw new Error(`Fyers history ${symbol} ${resolution} ${from}→${to}: ${fyersErrText(err)}`);
  }
  // Order matters. A real failure — an expired token comes back as
  // {s:"error", code:-16, message:"Could not authenticate the user"} — carries no
  // `candles` key, so the emptiness test below used to swallow it and hand the
  // caller a bare [] that is indistinguishable from a genuine quiet window. Every
  // engine then reported "no data" and retried forever against a dead token. Let
  // anything that is not an explicit no_data / ok surface as the error it is.
  if (response.s !== "ok" && response.s !== "no_data") {
    throw new Error(`Fyers history ${symbol} ${resolution} ${from}→${to}: ${fyersErrText(response)}`);
  }
  if (response.s === "no_data" || (!response.candles || response.candles.length === 0)) return [];
  return response.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
}

async function fetchCandles(symbol, resolution, from, to, opts = {}) {
  const maxDays = maxDaysForResolution(resolution);
  // Stream dedupe as we fetch — avoids a second O(n) pass + a duplicate array copy
  const seen = new Set();
  const unique = [];
  let cursor = new Date(from);
  // Never ask for a range that has not happened yet. Callers routinely pass a `to`
  // in the future without meaning to: fetchCandlesSmartCache widens the request to
  // WHOLE calendar months for its cache keys, so a "1 → 14 Aug" backtest goes out
  // as 1 → 31 Aug. A single chunk starting in the past survives that — Fyers just
  // truncates at today — but the chunking below splits the tail into a request that
  // lies ENTIRELY in the future, and Fyers rejects the whole run over it. That only
  // bites at sub-5-min resolutions, where maxDays is 30 and a 31-day month therefore
  // needs a second chunk, which is why it surfaced the moment BB_RSI moved to 3-min.
  // Clamping costs nothing: candles after today do not exist, and the month cache
  // already refuses to store any month that touches today, so no partial month is
  // ever persisted as if it were complete.
  const endDate = new Date(Math.min(new Date(to).getTime(), new Date(todayIST()).getTime()));
  while (cursor <= endDate) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());
    let candles;
    try {
      candles = await fetchChunk(symbol, resolution, cursor.toISOString().split("T")[0], chunkEnd.toISOString().split("T")[0], opts);
    } catch (err) {
      // Fyers plans cap how far back history goes (Standard: 1 year intraday,
      // 5 years daily) and refuse a WHOLE chunk whose start is older. Jump the
      // cursor to the oldest allowed day (parsed from the message) and carry on,
      // so the run covers what the plan allows instead of failing outright.
      const msg = (err && err.message) || "";
      if (!/historical data limit/i.test(msg)) throw err;
      const m = msg.match(_isIntradayRes(resolution) ? /(\d+)\s*years?\s*for\s*intraday/i : /(\d+)\s*years?\s*for\s*daily/i);
      const oldest = new Date(todayIST());
      if (m) oldest.setFullYear(oldest.getFullYear() - Number(m[1]));
      oldest.setDate(oldest.getDate() + 1);
      const next = new Date(chunkEnd); next.setDate(next.getDate() + 1);
      const jumpTo = m && oldest > cursor ? oldest : next;
      console.warn(`   ⚠️ Fyers plan history limit — skipping ${cursor.toISOString().split("T")[0]} → ${new Date(jumpTo.getTime() - 86400000).toISOString().split("T")[0]} (older than the plan allows)`);
      unique.planTrimmedFrom = jumpTo.toISOString().split("T")[0];
      cursor = jumpTo;
      continue;
    }
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
  //
  // INTRADAY ONLY. Fyers stamps a 1D/1W/1M bar at 00:00 IST, which is outside the
  // session window, so applying this to a daily series silently deleted EVERY bar
  // and every caller got an empty array (daily context, prev-day OHLC in
  // BB_RSI/PA paper, the VIX daily lookup in backtests). A daily bar has no
  // pre-open/post-close print to strip in the first place.
  const _isIntraday = /^\d+$/.test(String(resolution));
  const _MKT_OPEN = 9 * 60 + 15, _MKT_CLOSE = 15 * 60 + 30;
  const sessionOnly = _isIntraday
    ? unique.filter(c => { const m = getISTHHMM(c.time); return m >= _MKT_OPEN && m < _MKT_CLOSE; })
    : unique;
  if (unique.planTrimmedFrom) sessionOnly.planTrimmedFrom = unique.planTrimmedFrom;
  const _dropped = unique.length - sessionOnly.length;
  console.log(`   ✅ Total candles fetched: ${sessionOnly.length}${_dropped ? ` (dropped ${_dropped} pre-open/post-close)` : ""}`);
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
 *   EXIT   : the global profit lock (tradeGuards) is the ONLY automatic exit — no SL, trail,
 *            target, breakeven, time-stop or signal exit. A position still open at the end of
 *            a day's session (last bar of the day / TRADE_STOP_TIME) is squared off there,
 *            mirroring paper's session teardown.
 *   GUARDS : VIX gate, entry window, one-trade-per-move,
 *            wait-after-exit cooldown (entry filters only — no loss-based day limits).
 */
// btOpts (optional, trailing) — for the NIFTY FUTURES twin (FUT_EMA_RSI_ST):
//   isFutures: true  → force the futures branch (DELTA 1, no theta, futures
//                      charges, futures lot) without reading the global INSTRUMENT
//   prefix:   "FUT_EMA_RSI_ST" → read the strategy-own engine keys
//                      (ONE_TRADE_PER_MOVE_ENABLED, CONFIRM_CANDLE_ENABLED) under it
//   lotQty:   the market's lot (backtestMarket.context().lotQty) instead of NIFTY's
//   exchange: "BSE" → BSE exchange-txn charges (SENSEX); passed to getCharges
// Omitted → exactly the original behaviour (EMA_RSI_ST_* keys, global instrument).
async function runBacktest(candles, strategy, capital, vixCandles, expiryDates, onProgress, activeFromTs = 0, btOpts) {
  const _btForceFut = !!(btOpts && btOpts.isFutures === true);
  const _btPrefix   = (btOpts && btOpts.prefix) || "EMA_RSI_ST";
  const _btDefPfx   = _btPrefix === "EMA_RSI_ST";
  const trades    = [];
  let position    = null;
  const _btLot     = btOpts && Number.isFinite(btOpts.lotQty) && btOpts.lotQty > 0 ? btOpts.lotQty : null;
  const LOT_SIZE  = _btLot || (_btForceFut ? getLotQty(undefined, "NIFTY_FUTURES") : getLotQty());
  // Another market's exchange (BSE for SENSEX) for the charges; NIFTY passes none.
  const _btExch   = btOpts && btOpts.exchange ? { exchange: btOpts.exchange } : {};

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
  const isFutures    = _btForceFut || instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
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

  // One trade per move — after an exit, that side waits for a SuperTrend flip (mirrors paper).
  const MOVE_LOCK_ENABLED      = _btDefPfx
    ? (process.env.EMA_RSI_ST_ONE_TRADE_PER_MOVE_ENABLED || "true").toLowerCase() === "true"
    : (process.env[_btPrefix + "_ONE_TRADE_PER_MOVE_ENABLED"] || "true").toLowerCase() === "true";

  // ── Global profit lock, in spot-point terms — the ONLY automatic exit ─────
  // The lock is defined on option premium, and this engine has no live LTP — it
  // models premium as 200 (the estimated entry premium the P&L sim uses) +
  // spot × DELTA − theta. So convert both thresholds against that same 200 seed
  // via DELTA, and the backtest stays internally consistent with its own P&L model.
  //
  // This is an APPROXIMATION of what paper does per tick: paper arms on the real
  // premium, which also moves with IV and theta, not with spot alone. It is far
  // closer to paper than having no lock at all (which would leave every backtest
  // reporting exits paper would never take).
  const _PL_ENABLED   = !isFutures && tradeGuards.PROFIT_LOCK_ENABLED;
  const _PL_ARM_PCT   = tradeGuards.PROFIT_LOCK_ARM_PCT;
  const _PL_FLOOR_PCT = tradeGuards.PROFIT_LOCK_FLOOR_PCT;
  const _PL_TRAIL_PCT = tradeGuards.PROFIT_LOCK_TRAIL_PCT;
  const _PL_TIERS     = tradeGuards.PROFIT_LOCK_TRAIL_TIERS;
  const _PL_VALID     = _PL_ENABLED && DELTA > 0
                     && Number.isFinite(_PL_ARM_PCT) && Number.isFinite(_PL_FLOOR_PCT)
                     && _PL_ARM_PCT > 0 && _PL_FLOOR_PCT >= 0 && _PL_FLOOR_PCT < _PL_ARM_PCT;
  const _PL_ARM_SPOT_PTS   = _PL_VALID ? (_PL_ARM_PCT   / 100 * 200) / DELTA : 0;
  const _PL_FLOOR_SPOT_PTS = _PL_VALID ? (_PL_FLOOR_PCT / 100 * 200) / DELTA : 0;

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
  console.log(`   Exit  : global profit lock (${_PL_VALID ? `arm +${_PL_ARM_PCT}% / floor +${_PL_FLOOR_PCT}%` : "OFF"}) + trailing stop (${tradeGuards.PREMIUM_SL_ENABLED ? `${tradeGuards.PREMIUM_SL_PCT}% below best` : "OFF"}) + session-end square-off each day`);
  console.log(`   Charges : dynamic (STT + exchange + GST + stamp + ₹40 brok) — see Settings`);
  console.log(`   PnL mode : ${OPTION_SIM ? `OPTION SIM (delta=${DELTA}, theta=₹${THETA_PER_DAY}/day, lot=${LOT_SIZE})` : "RAW INDEX POINTS (set BACKTEST_OPTION_SIM=true to enable)"}`);
  console.log(`   VIX filter : ${vixFilter.VIX_ENABLED ? `ON (max=${vixFilter.VIX_MAX_ENTRY}, strong-only=${vixFilter.VIX_STRONG_ONLY}) | ${vixCandles ? vixCandles.length + " VIX candles loaded" : "NO VIX DATA — filter bypassed"}` : "OFF"}`);
  console.log("══════════════════════════════════════════════");

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
  // Used for cooldown durations. Fallback 15 if fewer than 2 candles.
  const candleResolutionMins = candles.length >= 2
    ? Math.round((candles[1].time - candles[0].time) / 60)
    : 15;
  console.log(`   Resolution: ${candleResolutionMins}-min candles | Total candles: ${candles.length} | Seed window: 30`);
  console.log(`   EMA_RSI_ST(redefined): EMA+RSI+SuperTrend entries | exit = profit lock only`);

  // Per-day tallies — for the verbose DAY CLOSE log only, never an entry gate.
  let _dailyPnl        = 0;
  let _dailyTradeCount = 0;
  // ── Entry guards (non-loss filters only) ────────────────────────────────────
  let _moveLockSide              = null;  // one trade per move: side waiting for a SuperTrend flip
  let _lastStTrendInt            = null;  // SuperTrend side at the PREVIOUS candle's close
  // Global wait-after-any-exit cooldown (EXIT_REENTRY_COOLDOWN_CANDLES), unix secs.
  // Paper measures it from the exit's clock time: a tick stop exits INSIDE the
  // bar (≈ bar open here), a candle-close rule exits at the bar's CLOSE.
  const _REENTRY_COOLDOWN_SECS = tradeGuards.reentryCooldownMs(candleResolutionMins) / 1000;
  let _reentryBlockUntilTs       = 0;
  // Confirmation candle (cross & close, EMA_RSI_ST only — EMA_RSI_ST_CONFIRM_CANDLE_ENABLED).
  // { side, armedBarTime, triggerLevel, reason, strength } | null.
  let _armedSwing = null;
  // Arm decided at THIS candle's close, published at the top of the next candle —
  // see the CONFIRMATION ARM block below for why it is staged rather than set live.
  let _pendingArm = null;
  if (SLIPPAGE_PTS > 0) console.log(`   Slippage sim : ${SLIPPAGE_PTS} pts per side (entry + exit)`);

  // Session times — mirror emaRsiStPaper: entry cutoff = TRADE_STOP_TIME − 10
  // (paper's _ENTRY_STOP_MINS) and the session auto-stop at TRADE_STOP_TIME, where
  // paper's teardown squares off any open position. The backtest closes at the
  // close of the bar that ends at/after TRADE_STOP_TIME, or the day's last bar.
  const _stopMins     = (() => { const v = (process.env.TRADE_STOP_TIME || "15:30").split(":"); return parseInt(v[0], 10) * 60 + (parseInt(v[1], 10) || 0); })();
  const _entryStopMin = _stopMins - 10;
  const _stopLabel    = String(Math.floor(_stopMins / 60)).padStart(2, "0") + ":" + String(_stopMins % 60).padStart(2, "0");

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
    // Reset per-day state at the start of each new trading day
    if (i > 30) {
      const prevCandleDate = getISTDateStr(candles[i - 1].time);
      if (candleDate !== prevCandleDate) {
        if (_verbose && _dailyTradeCount > 0) {
          console.log(`\n  📅 DAY CLOSE [${prevCandleDate}]: ${_dailyTradeCount} trades | PnL=${_dailyPnl.toFixed(1)}`);
        }
        _dailyPnl           = 0;
        _dailyTradeCount    = 0;
        _moveLockSide             = null;
        _reentryBlockUntilTs      = 0;
        _armedSwing               = null; // drop any arm across the day boundary
        _pendingArm               = null; // ...including one staged at yesterday's close
        if (_verbose) console.log(`\n  ──── NEW DAY: ${candleDate} ────`);
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

    // Session end: square off at the close of the bar that ends at/after
    // TRADE_STOP_TIME (paper's auto-stop teardown), or the day's last bar. Entry
    // cutoff at TRADE_STOP_TIME − 10, mirroring paper's _ENTRY_STOP_MINS.
    const candleMin      = getISTHHMM(candle.time);
    const isSessionEnd   = isLastCandleOfDay || candleMin + candleResolutionMins >= _stopMins;
    // A bar that squares off at session end can never open a trade either.
    const isEntryBlocked = isSessionEnd || candleMin >= _entryStopMin;

    // ── Get signal from current window (entry candle included) ────────────────
    // window already contains candles[0..i] — no slice needed.
    // silent=true: backtest runs 1000+ candles — suppress per-candle strategy console.log spam
    // Only destructure fields we actually use — skip `...indicators` rest-spread
    // which allocates a new object every candle (hot path: 500K+ calls).
    // One trade per move — paper clears the lock at a candle CLOSE, before the
    // next bar's fill, so clear on the previous candle's SuperTrend, not this one's.
    if (_moveLockSide && ((_moveLockSide === "CE" && _lastStTrendInt === -1) || (_moveLockSide === "PE" && _lastStTrendInt === 1))) {
      _moveLockSide = null;
    }
    const _sig = strategy.getSignal(window, { silent: true });
    if (_sig.stTrendInt != null) _lastStTrendInt = _sig.stTrendInt;
    const signal = _sig.signal;
    const reason = _sig.reason;
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

    // ── Peak tracking for the profit lock ───────────────────────────────────────
    if (position) {
      // Snapshot the peak as of the PREVIOUS completed bar before folding this
      // bar into it. The profit lock arms off this snapshot so it can never arm
      // and fire within one candle — inside a bar we know the high and the low
      // but not their order, and assuming up-then-down would manufacture exits
      // paper could not take.
      position.bestPricePrevBar = position.bestPrice;
      // Track favourable extreme (best price seen) — the lock's peak.
      if (position.side === "CE") {
        if (!position.bestPrice || candle.high > position.bestPrice) position.bestPrice = candle.high;
      } else {
        if (!position.bestPrice || candle.low < position.bestPrice) position.bestPrice = candle.low;
      }
    }

    // candlesHeld is NOT incremented here. It is incremented inside runExitChecks
    // at the bar-close point, where emaRsiStPaper increments it.

    // ── EXIT CHECK ────────────────────────────────────────────────────────────
    // Two exits only: the global profit lock (paper's per-tick exit) and the
    // session-end square-off (paper's TRADE_STOP_TIME teardown).
    //
    // SAME-BAR EXIT PARITY: the whole exit evaluation lives in this per-candle
    // closure so it can be invoked twice — once for a position carried in from an
    // earlier candle (entryBar=false), and once immediately after an INTRA-BAR
    // confirm fill on THIS candle (entryBar=true). It only ever reads `candle`; no
    // future candle is touched, so no look-ahead is introduced. On an entry bar the
    // lock is a no-op (bestPricePrevBar is null), and the gap-through fill is skipped
    // (the bar's OPEN happened before we entered).
    //
    // _openAtCandleClose: a position was STILL OPEN when this bar closed — i.e. it
    //   survived the intra-bar profit lock. Paper's confirmation-arm block is gated on
    //   `!ptState.position`, so a trade that exits AT this close (session end) still
    //   blocks arming on its own exit candle. A trade that exited on the tick lock
    //   leaves the flag false — paper's arm block does run in that case.
    let _openAtCandleClose = false;

    const runExitChecks = (opts) => {
      const entryBar = !!(opts && opts.entryBar);
      if (!position) return;
      let exitReason = null;
      let exitPrice  = candle.close;

      // Global profit lock — the same ratchet paper applies per tick
      // (see tradeGuards.checkProfitLock), expressed in spot points because this
      // engine has no live premium. Once the favourable excursion has reached the
      // arm distance, the trade may not be given back past the floor distance.
      // Arm ONLY on a peak set by a COMPLETED EARLIER bar (bestPricePrevBar,
      // snapshotted in the main loop before this bar is folded in). Within a
      // single bar we know the high and the low but not their order, so arming on
      // this bar's own high and then exiting on this bar's low would assume the
      // sequence went up-then-down — a look-ahead that manufactures profitable
      // exits paper could not take. It is null on an entry bar.
      const _dir = position.side === "CE" ? 1 : -1;
      let _lvlPts = null, _lvlWhy = null;   // favourable spot pts of the exit level
      if (_PL_VALID && position.bestPricePrevBar != null) {
        const bestFav = (position.bestPricePrevBar - position.entryPrice) * _dir;
        const armed = bestFav >= _PL_ARM_SPOT_PTS;
        if (armed) {
          // The trail raises the floor to the tiered keep % of the best gain
          // (premium gain ≈ delta × spot gain on the 200 seed, so the same share
          // applies to spot points).
          const _bestPremPct = bestFav * DELTA / 200 * 100;
          const _trailPts = bestFav * tradeGuards.profitLockTrailKeepPct(_bestPremPct, _PL_TRAIL_PCT, _PL_TIERS) / 100;
          _lvlPts = Math.max(_PL_FLOOR_SPOT_PTS, _trailPts);
          _lvlWhy = _lvlPts > _PL_FLOOR_SPOT_PTS
            ? `Profit lock trail ${Math.round(_lvlPts / bestFav * 100)}% (≈${_lvlPts.toFixed(0)}pt spot kept of ${bestFav.toFixed(0)}pt best)`
            : `Profit lock +${_PL_FLOOR_PCT}% (≈${_PL_FLOOR_SPOT_PTS.toFixed(0)}pt spot, armed at +${_PL_ARM_PCT}%)`;
        }
      }
      // Common premium stop-loss (tradeGuards.premiumStopLtp) in spot points.
      // Not on an entry bar: its low/high may have printed before the fill.
      // Futures too: DELTA is 1.0 there, so this is tradeGuards.futuresStopLevel.
      if (!entryBar) {
        const _bestFavPrev = position.bestPricePrevBar != null ? (position.bestPricePrevBar - position.entryPrice) * _dir : 0;
        const _stopPts = tradeGuards.premiumStopSpotPts(_bestFavPrev, DELTA);
        if (_stopPts != null && (_lvlPts == null || _stopPts > _lvlPts)) {
          _lvlPts = _stopPts;
          _lvlWhy = tradeGuards.premiumStopSpotReason(_stopPts, _bestFavPrev);
        }
      }
      if (_lvlPts != null) {
        const floorLvl = position.entryPrice + _lvlPts * _dir;
        const touched = position.side === "CE" ? candle.low <= floorLvl : candle.high >= floorLvl;
        if (touched) {
          exitReason = _lvlWhy;
          // A bar that OPENS past the level fills at the open — the trailed
          // floor sits close to price, so gaps are common. Not on the entry bar.
          const gapped = !entryBar && (position.side === "CE" ? candle.open < floorLvl : candle.open > floorLvl);
          exitPrice  = quantize(gapped ? candle.open : floorLvl, 2);
        }
      }

      // ── BAR CLOSE ───────────────────────────────────────────────────────────
      // The lock above is a per-TICK exit. emaRsiStPaper increments candlesHeld at
      // the TOP of onCandleClose — after the bar's ticks. Skipped when the lock
      // already fired: paper's position is closed before onCandleClose runs.
      const _exitedOnTick = !!exitReason;
      if (!exitReason) {
        position.candlesHeld = (position.candlesHeld || 0) + 1;
        // The bar closed with us still holding — this is the exact moment paper's
        // arm block sees a live position and therefore refuses to arm.
        _openAtCandleClose = true;
      }

      // Session-end square-off — paper's TRADE_STOP_TIME teardown (or the day's
      // last bar), so every trade's P&L is defined within its own day.
      if (!exitReason && isSessionEnd) {
        exitReason = `EOD square-off ${isLastCandleOfDay ? "(last candle of day)" : `(session end ${_stopLabel})`}`;
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
          const _chg = getCharges({ isFutures: true, exitPremium: exitPrice, entryPremium: position.entryPrice, qty: LOT_SIZE, ..._btExch });
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
          const _chg = getCharges({ isFutures: false, exitPremium: estExitPrem, entryPremium: estEntryPrem, qty: LOT_SIZE, ..._btExch });
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

        _dailyPnl += pnlRupees;
        _dailyTradeCount++;

        // One trade per move — this side waits for a SuperTrend flip.
        _moveLockSide = position.side;

        // Wait-after-any-exit cooldown — every exit reason, both sides.
        if (_REENTRY_COOLDOWN_SECS > 0) {
          _reentryBlockUntilTs = candle.time + (_exitedOnTick ? 0 : candleResolutionMins * 60) + _REENTRY_COOLDOWN_SECS;
        }

        // ── Notify strategy: optional exit callback
        position = null;
        if (typeof strategy.onTradeClosed === "function") strategy.onTradeClosed();
      }
    };

    // Carried-in position: unchanged timing, unchanged rules.
    runExitChecks({ entryBar: false });

    // ── ENTRY ─────────────────────────────────────────────────────────────────
    // Gate checks: entry filters only (cooldowns, one-trade-per-move, VIX, window)
    const _sigSide = signal === "BUY_CE" ? "CE" : signal === "BUY_PE" ? "PE" : null;
    // Per-SIDE, not per-signal: the confirmation fill enters the ARMED side, which is
    // the previous candle's signal and need not equal this candle's _sigSide. Paper
    // applies the cooldowns inside simulateBuy() against the side actually being
    // bought, so every entry path gets them.
    const _reentryBlocked = _reentryBlockUntilTs > 0 && candle.time < _reentryBlockUntilTs;
    const _moveLocked = (s) => !!(MOVE_LOCK_ENABLED && s && s === _moveLockSide);

    // Warm-up gate: candles before activeFromTs only build indicators (EMA/RSI/SAR),
    // they never open a trade. This lets a single-day (or any) range be evaluated
    // from its very first candle with fully-warmed indicators seeded by prior days,
    // instead of silently consuming the range's own opening candles as warm-up.
    const _isWarmupOnly = candle.time < activeFromTs;

    // ── CONFIRMATION ARM (paper parity) ───────────────────────────────────────
    // emaRsiStPaper arms at candle close gated ONLY on "flat + valid signal". Every
    // entry guard — wait-after-exit, VIX, OI — is evaluated
    // LATER, at fill time in onTick, so a signal printing on the LAST candle of a
    // cooldown still arms and can fill on the next candle.
    //
    // Staged into _pendingArm rather than assigned live: this candle's fill attempt
    // below still has to consume the arm made at the PREVIOUS close, and writing
    // _armedSwing here would destroy it.
    //
    // Still gated on: flat at this close (paper's `!ptState.position`, which for a
    // trade exiting AT this close means no arm — see _openAtCandleClose), warm-up
    // (paper has no candle-close handler for pre-loaded history), and the
    // backtest-only expiry-day filter, which is retained exactly where it was.
    if (confirmCandle.enabled(_btPrefix) && !position && !_openAtCandleClose
        && !_isWarmupOnly && _sigSide
        && !(expiryDates && !expiryDates.has(candleDate))) {
      _pendingArm = {
        side: _sigSide, armedBarTime: candle.time, triggerLevel: candle.close,
        reason, strength: signalStrength || "STRONG",
      };
      if (_verbose) console.log(`  🎯 ARM ${_sigSide} @ close ${candle.close} [${toIST(candle.time)}] — await next-candle cross`);
    }

    if (!position && !_isWarmupOnly && !isEntryBlocked) {
      const _confirmSwing = confirmCandle.enabled(_btPrefix);

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
        if (_reentryBlocked || _moveLocked(_a.side)) {
          if (_verbose) console.log(`  ⏸️ CONFIRM ${_a.side} rejected — ${_reentryBlocked ? "wait-after-exit" : "one-trade-per-move"} cooldown active [${toIST(candle.time)}]`);
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
            position = {
              side:            _a.side,
              entryPrice,
              entryTime:       candle.time,
              entryReason:     `${_a.reason} | CONFIRM ${_a.side} x-over @${_a.triggerLevel}`,
              bestPrice:       null,
              signalStrength:  _a.strength,
              candlesHeld:     0,
            };
            if (_verbose) console.log(`  ✅ CONFIRM ENTER ${_a.side} @ ${entryPrice} [${toIST(candle.time)}] x-over ${_a.triggerLevel}`);
            // Same-bar exit parity: run this bar's close-time rules (session end).
            runExitChecks({ entryBar: true });
            // Paper's arm block sits at this close and is gated on `!ptState.position`.
            // Still holding → it would not arm, so drop the arm staged above. But if the
            // entry bar's own tick exit already closed us out, paper is flat by then and
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
        // Wait-after-any-exit cooldown: skip both sides
        if (_reentryBlocked) continue;
        // One trade per move: this side waits for a SuperTrend flip
        if (_moveLocked(_sigSide)) continue;

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

        position = {
          side,
          entryPrice,
          entryTime:       candle.time,
          entryReason:     reason,
          bestPrice:       null,
          signalStrength:  strength,
          candlesHeld:     0,
        };
        if (_verbose) {
          console.log(`  ✅ ENTER ${side} @ ${entryPrice} [${toIST(candle.time)}]`);
          console.log(`     Reason: ${reason}`);
        }
        // NO entry-bar exit check on this path — and that is deliberate.
        // This is the candle-CLOSE entry, reached only when the confirmation
        // candle is OFF. emaRsiStPaper's matching path (the `!confirmCandle
        // .enabled(...)` branch at the bottom of onCandleClose) runs AFTER every
        // exit rule for that bar, and paper's next tick already belongs to the
        // next bar — so paper cannot exit on its own candle-close entry bar.
        // (Entry is already blocked on a session-end bar via isEntryBlocked.)
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
      const _chgEod = getCharges({ isFutures: true, exitPremium: lastCandle.close, entryPremium: position.entryPrice, qty: LOT_SIZE, ..._btExch });
      pnlRupees = quantize((spotPnlPts * LOT_SIZE) - _chgEod, 2);
      pnlMode   = `futures`;
    } else if (OPTION_SIM) {
      const premiumMovePts = spotPnlPts * DELTA;
      const candlesHeld    = position.candlesHeld || 1;
      const thetaDecay     = quantize((THETA_PER_DAY / CANDLES_PER_DAY) * candlesHeld, 2);
      const netPremPts     = premiumMovePts - thetaDecay;
      const estEntry       = 200;
      const estExit        = Math.max(1, estEntry + netPremPts);
      const _chgEod = getCharges({ isFutures: false, exitPremium: estExit, entryPremium: estEntry, qty: LOT_SIZE, ..._btExch });
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
    const label = t.exitReason.includes('Profit lock') ? 'Profit lock' : t.exitReason.includes('EOD') ? 'EOD square-off' : 'Other';
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
  // waitForSlot: a backtest's candles do not go stale, so queue behind live
  // calls for a free Fyers slot instead of failing after 15s.
  const raw = (s, r, f, t) => fetchCandles(s, r, f, t, { waitForSlot: true });
  return fetchCandlesSmartCache(symbol, resolution, from, to, raw, skipCache, onProgress);
}

module.exports = { fetchCandles, fetchCandlesCachedBT, runBacktest };

require("dotenv").config();
const fyers = require("../config/fyers");
const { toDateString } = require("../utils/time");

const vixFilter = require("./vixFilter");
const { buildVixLookup, checkBacktestVix, VIX_SYMBOL } = vixFilter;

const instrumentConfig = require("../config/instrument");
const { getLotQty } = instrumentConfig;
const { getCharges } = require("../utils/charges");


function maxDaysForResolution(resolution) {
  if (["D", "W", "M"].includes(resolution)) return 365 * 10;
  if (["1", "2", "3"].includes(String(resolution))) return 30;
  return 100;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchChunk(symbol, resolution, from, to) {
  const params = { symbol, resolution: String(resolution), date_format: "1", range_from: from, range_to: to, cont_flag: "1" };
  console.log(`   📦 Fetching chunk: ${from} → ${to}`);
  const response = await fyers.getHistory(params);
  if (response.s !== "ok") throw new Error(`Fyers API error: ${JSON.stringify(response)}`);
  if (!response.candles || response.candles.length === 0) return [];
  return response.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
}

async function fetchCandles(symbol, resolution, from, to) {
  const maxDays = maxDaysForResolution(resolution);
  const allCandles = [];
  let cursor = new Date(from);
  const endDate = new Date(to);
  while (cursor <= endDate) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());
    const candles = await fetchChunk(symbol, resolution, cursor.toISOString().split("T")[0], chunkEnd.toISOString().split("T")[0]);
    allCandles.push(...candles);
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
    if (cursor <= endDate) await sleep(300);
  }
  const seen = new Set();
  const unique = allCandles.filter((c) => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
  unique.sort((a, b) => a.time - b.time);
  console.log(`   ✅ Total candles fetched: ${unique.length}`);
  return unique;
}

function toIST(unixSec) {
  return new Date(unixSec * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
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
 * BACKTEST ENGINE — mirrors paper trade logic exactly
 *
 * ENTRY (same as paper trade):
 *   Signal comes from strategy.getSignal(window)
 *   Entry price = candle.close
 *   Stop loss   = from strategy.getSignal(prevWindow) — closed candles only, NOT entry candle
 *                 (mirrors paper/live fix: SL always from last fully closed candle's SAR)
 *
 * EXIT (same priority as paper trade):
 *   Rule 1 — 50% candle rule (skipped on entry candle itself, same as paper trade)
 *   Rule 2+3 — Intra-candle trail SL simulation (from first favourable move, 40pt gap)
 *              + SAR trailing SL (tighten only on each candle)
 *   Rule 4 — Opposite signal
 *   Rule 5 — EOD square-off at 3:20 PM IST (PER DAY)
 *
 * FIX v20:
 *   - EOD exit now fires per-day at 3:20 PM, not just at the very last candle
 *   - strategy.onTradeClosed() and onStopLossHit() called after every exit
 * FIX v30 (sync with paper/live):
 *   - Trail SL: removed 15pt trigger threshold — trails from first favourable move
 * FIX v53 (sync with paper):
 *   - Backtest trail now applies 50% floor (Math.max/min entryPrevMid) matching paper exactly
 *   - TRAIL_ACTIVATE_PTS=15: trail fires after 15pt move in favour (lowered from 25/50 — locks profit earlier)
 *   - SL at entry: taken from prev window (closed candles only), not entry candle
 *   - 50% rule: skipped on the entry candle itself (applied from next candle onwards)
 * FIX v38 (sync with paper/live):
 *   - TRAIL_GAP_PTS: 10 → 25 → 40 → 60 (15-min optimised)
 *   - Strategy filters (RSI 51/49, dead zone 12-12:30, min SAR dist 20pt) apply
 *     automatically via getSignal() — no backtest changes needed for those
 * FIX v-final (full sync with paper/live — all 3 modes now identical):
 *   - Trail gap: flat 60pt → tiered dynamic (T1/T2/T3, mirrors paper/live exactly)
 *   - Trail activation: dynamic per-trade = 25% of initial SAR gap, min TRAIL_ACTIVATE_PTS
 *   - getDynamicTrailGap() added — same tier logic as paper/live
 *   - initialStopLoss + trailActivatePts stored on position (matches paper/live)
 */
function runBacktest(candles, strategy, capital, vixCandles, expiryDates) {
  const trades    = [];
  let position    = null;
  const LOT_SIZE  = getLotQty();

  // ── VIX filter for backtest ─────────────────────────────────────────────────
  const lookupVix = buildVixLookup(vixCandles || []);
  let _vixBlockCount = 0;

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
  //    We deduct theta proportional to candles held (1 candle = 15 min = 1/26 of trading day).
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
  const CANDLES_PER_DAY = 26; // 15-min candles in a 6.5-hour trading day (9:15–15:30)

  // Trail gap — tiered dynamic (aligned with Settings page defaults):
  //   T1: 0–TIER1_UPTO pts gain  → TIER1_GAP  (default 40pt — wide early, room to breathe)
  //   T2: TIER1_UPTO–TIER2_UPTO  → TIER2_GAP  (default 25pt — tightening)
  //   T3: above TIER2_UPTO        → TIER3_GAP  (default 15pt — locking in large profit)
  // Activation: 25% of initial SAR gap at entry, floored at TRAIL_ACTIVATE_PTS (default 12pt), capped at 40pt.
  const TRAIL_T1_UPTO      = parseFloat(process.env.TRAIL_TIER1_UPTO || "30");
  const TRAIL_T2_UPTO      = parseFloat(process.env.TRAIL_TIER2_UPTO || "55");
  const TRAIL_T1_GAP       = parseFloat(process.env.TRAIL_TIER1_GAP  || "40");
  const TRAIL_T2_GAP       = parseFloat(process.env.TRAIL_TIER2_GAP  || "25");
  const TRAIL_T3_GAP       = parseFloat(process.env.TRAIL_TIER3_GAP  || "15");
  const TRAIL_ACTIVATE_PTS = parseFloat(process.env.TRAIL_ACTIVATE_PTS || "12");

  function getDynamicTrailGap(moveInFavour) {
    if (moveInFavour < TRAIL_T1_UPTO) return TRAIL_T1_GAP;
    if (moveInFavour < TRAIL_T2_UPTO) return TRAIL_T2_GAP;
    return TRAIL_T3_GAP;
  }

  // Clear IST memoization caches so back-to-back backtests don't cross-pollute
  _istDateCache.clear();
  _istHHMMCache.clear();

  // Reset strategy module-level state if it has a reset hook
  if (typeof strategy.reset === "function") strategy.reset();

  console.log("\n══════════════════════════════════════════════");
  console.log(`🔍 BACKTEST — ${strategy.NAME}`);
  console.log(`   Entry : signal from strategy at candle close`);
  console.log(`   Exit  : 50% rule + trail SL + SAR SL + opposite signal + EOD/day`);
  console.log(`   Charges : dynamic (STT + exchange + GST + stamp + ₹40 brok) — see Settings`);
  console.log(`   PnL mode : ${OPTION_SIM ? `OPTION SIM (delta=${DELTA}, theta=₹${THETA_PER_DAY}/day, lot=${LOT_SIZE})` : "RAW INDEX POINTS (set BACKTEST_OPTION_SIM=true to enable)"}`);
  console.log(`   VIX filter : ${vixFilter.VIX_ENABLED ? `ON (max=${vixFilter.VIX_MAX_ENTRY}, strong-only=${vixFilter.VIX_STRONG_ONLY}) | ${vixCandles ? vixCandles.length + " VIX candles loaded" : "NO VIX DATA — filter bypassed"}` : "OFF"}`);
  console.log("══════════════════════════════════════════════");

  // ── Optimisation: cache the SL from the previous candle's getSignal ──────────
  // Instead of calling getSignal(prevWindow) on every iteration (O(n²) total),
  // we save the current SL and reuse it as the 'prev SL' on the next iteration.
  // This halves getSignal calls and eliminates the redundant prevWindow slice.
  let _cachedPrevSL = null;  // updated at end of each loop iteration

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
  console.log(`   50%-rule pause: ${2 * candleResolutionMins} min (2 candles) after each 50%-rule exit`);
  console.log(`   TRAIL tiers: T1 0-${TRAIL_T1_UPTO}pt=gap${TRAIL_T1_GAP}pt | T2 ${TRAIL_T1_UPTO}-${TRAIL_T2_UPTO}pt=gap${TRAIL_T2_GAP}pt | T3 ${TRAIL_T2_UPTO}pt+=gap${TRAIL_T3_GAP}pt | activate=25%SARgap(min${TRAIL_ACTIVATE_PTS}pt) | ADX_MIN: 25 | RSI CE>55 PE<45`);

  // 50%-rule exit pause: after a 50%-rule exit, block re-entry for 2 candles.
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
  let _slHitCandleTime      = null;    // block re-entry on same candle where SL was hit
  console.log(`   Risk controls: MAX_DAILY_LOSS=₹${MAX_DAILY_LOSS} | MAX_DAILY_TRADES=${MAX_DAILY_TRADES} | 3-consec-loss=kill(15min)/pause(5min)`);

  for (let i = 30; i < candles.length; i++) {
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
        _slHitCandleTime    = null;
        // Count trades for previous day for the daily log
        const dayTrades = trades.filter(t => getISTDateStr(t.exitTs) === prevCandleDate);
        if (dayTrades.length > 0) {
          const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
          const dayW   = dayTrades.filter(t => t.pnl > 0).length;
          console.log(`
  📅 DAY CLOSE [${prevCandleDate}]: ${dayTrades.length} trades | ${dayW}W/${dayTrades.length - dayW}L | PnL=${dayPnl.toFixed(1)}pts`);
        }
        console.log(`
  ──── NEW DAY: ${candleDate} ────`);
      }
    }
    const nextCandle = candles[i + 1] || null;
    const nextDate   = nextCandle ? getISTDateStr(nextCandle.time) : null;
    const isLastCandleOfDay = !nextCandle || nextDate !== candleDate;

    // Also check time — force EOD at 3:20 PM regardless
    const candleMin     = getISTHHMM(candle.time);
    const isEODcandle   = isLastCandleOfDay || candleMin >= 920;

    // ── Get signal from current window (entry candle included) ────────────────
    // window already contains candles[0..i] — no slice needed.
    // silent=true: backtest runs 1000+ candles — suppress per-candle strategy console.log spam
    const { signal, reason, stopLoss: signalSL, signalStrength, ...indicators } = strategy.getSignal(window, { silent: true });

    // Debug: log first few signal evaluations so 0-trade runs are diagnosable
    if (_dbgSignalCount < 5) {
      console.log(`  🔍 [DBG candle ${i}] signal=${signal} | ${reason.slice(0, 120)}`);
      _dbgSignalCount++;
    } else if (_dbgSignalCount === 5) {
      console.log(`  🔍 [DBG] (suppressing further debug logs — first 5 shown above)`);
      _dbgSignalCount++;
    }

    // ── SL FIX: use cached SL from previous iteration (closed candles only) ───
    // Mirrors paper/live: SL always taken from last fully closed candle's SAR.
    // _cachedPrevSL was set at the end of the previous iteration = getSignal(candles[0..i-1]).
    const prevSignalSL = _cachedPrevSL;

    // ── UPDATE TRAILING SAR SL (tighten only) ────────────────────────────────
    if (position && signalSL !== null && signalSL !== undefined) {
      const oldSL   = position.stopLoss;
      const tighten = position.side === "CE"
        ? (oldSL === null || signalSL > oldSL)
        : (oldSL === null || signalSL < oldSL);
      if (tighten) {
        console.log(`  📐 SAR-SL tightened: ${oldSL} → ${signalSL} (${position.side})`);
        position.stopLoss = signalSL;
      }
    }

    // ── SIMULATE INTRA-CANDLE TRAIL ───────────────────────────────────────────
    // Tiered dynamic gap (mirrors paper/live exactly): gap tightens as profit grows.
    // 50% floor/ceiling applied: trail cannot cross entryPrevMid until price clears it.
    // Uses candle high/low as best price proxy (tick-level not available in backtest).
    // trailActivatePts: dynamic per-trade — 25% of initial SAR gap, min TRAIL_ACTIVATE_PTS.
    if (position) {
      if (position.side === "CE") {
        const bestThisCandle = candle.high;
        if (!position.bestPrice || bestThisCandle > position.bestPrice) position.bestPrice = bestThisCandle;
        const moveInFavour = position.bestPrice - position.entryPrice;
        const activatePts  = position.trailActivatePts || TRAIL_ACTIVATE_PTS;
        if (moveInFavour >= activatePts) {
          const dynamicGap       = getDynamicTrailGap(moveInFavour);
          const trailSL          = parseFloat((position.bestPrice - dynamicGap).toFixed(2));
          if (trailSL > position.stopLoss) {
            console.log(`  📈 TRAIL CE: bestHigh=${position.bestPrice} move=+${moveInFavour.toFixed(1)}pt gap=${dynamicGap}pt → trailSL=${trailSL}`);
            position.stopLoss = trailSL;
          }
        }
      } else {
        const bestThisCandle = candle.low;
        if (!position.bestPrice || bestThisCandle < position.bestPrice) position.bestPrice = bestThisCandle;
        const moveInFavour = position.entryPrice - position.bestPrice;
        const activatePts  = position.trailActivatePts || TRAIL_ACTIVATE_PTS;
        if (moveInFavour >= activatePts) {
          const dynamicGap       = getDynamicTrailGap(moveInFavour);
          const trailSL          = parseFloat((position.bestPrice + dynamicGap).toFixed(2));
          if (trailSL < position.stopLoss) {
            console.log(`  📉 TRAIL PE: bestLow=${position.bestPrice} move=+${moveInFavour.toFixed(1)}pt gap=${dynamicGap}pt → trailSL=${trailSL}`);
            position.stopLoss = trailSL;
          }
        }
      }
    }

    // Count candles held (used for theta decay in PnL calculation)
    // Placed after trail updates but before exit check — entry candle starts at 0
    if (position) position.candlesHeld = (position.candlesHeld || 0) + 1;

    // ── EXIT CHECK ────────────────────────────────────────────────────────────
    if (position) {
      let exitReason = null;
      let exitPrice  = candle.close;

      // ── BREAKEVEN STOP (replaces 50% rule) ─────────────────────────────────
      // Once trade moves 25pt in favor, SL moves to entry price (zero risk).
      // This is MUCH better than the 50% rule because:
      // - 50% rule killed trades on normal noise (exits at fixed reference)
      // - Breakeven stop only fires after the trade proves itself (+25pt move)
      // - Trades that go +25pt then reverse = breakeven (not a loss)
      // - Trades that never reach +25pt = hit initial SL (max 80pt loss)
      const BREAKEVEN_THRESHOLD = parseFloat(process.env.BREAKEVEN_PTS || "25");
      if (position.side === "CE") {
        const ceMove = (position.bestPrice || candle.close) - position.entryPrice;
        if (ceMove >= BREAKEVEN_THRESHOLD && position.stopLoss < position.entryPrice) {
          console.log(`  ✅ BREAKEVEN CE: move +${ceMove.toFixed(0)}pt >= ${BREAKEVEN_THRESHOLD}pt → SL moved to entry ₹${position.entryPrice}`);
          position.stopLoss = position.entryPrice;
        }
      } else {
        const peMove = position.entryPrice - (position.bestPrice || candle.close);
        if (peMove >= BREAKEVEN_THRESHOLD && position.stopLoss > position.entryPrice) {
          console.log(`  ✅ BREAKEVEN PE: move +${peMove.toFixed(0)}pt >= ${BREAKEVEN_THRESHOLD}pt → SL moved to entry ₹${position.entryPrice}`);
          position.stopLoss = position.entryPrice;
        }
      }

      // Rule 1: SL or trail SL (uses candle low/high as intra-candle proxy)
      if (position.stopLoss !== null && position.stopLoss !== undefined) {
        // Determine SL type for clear labeling
        const _isBreakevenSL = Math.abs(position.stopLoss - position.entryPrice) < 1;
        const _isTrailSL     = !_isBreakevenSL && position.initialStopLoss != null &&
                               Math.abs(position.stopLoss - position.initialStopLoss) > 1;
        const _slLabel = _isBreakevenSL ? "Breakeven SL" : _isTrailSL ? "Trail SL" : "Initial SL";

        if (position.side === "CE" && candle.low <= position.stopLoss) {
          exitReason = `${_slLabel} hit — low ${candle.low} <= SL ${position.stopLoss}`;
          exitPrice  = position.stopLoss;
        } else if (position.side === "PE" && candle.high >= position.stopLoss) {
          exitReason = `${_slLabel} hit — high ${candle.high} >= SL ${position.stopLoss}`;
          exitPrice  = position.stopLoss;
        }
      }

      // Rule 2: Opposite signal
      if (!exitReason && signal === (position.side === "CE" ? "BUY_PE" : "BUY_CE")) {
        exitReason = "Opposite signal exit";
        exitPrice  = candle.close;
      }

      // Rule 3: EOD square-off — PER DAY at 3:20 PM
      if (!exitReason && isEODcandle) {
        exitReason = `EOD square-off ${candleMin >= 920 ? "3:20 PM" : "(last candle of day)"}`;
        exitPrice  = candle.close;
      }

      if (exitReason) {
        // ── PnL Calculation — realistic option simulation ─────────────────────
        // spotPnlPts: NIFTY index point move in our favour
        const spotPnlPts = parseFloat(((exitPrice - position.entryPrice) * (position.side === "CE" ? 1 : -1)).toFixed(2));

        let pnlRupees;
        let pnlMode;
        if (isFutures) {
          // Futures: direct point × lot size − charges (no delta/theta)
          const _chg = getCharges({ isFutures: true, exitPremium: exitPrice, entryPremium: position.entryPrice, qty: LOT_SIZE });
          pnlRupees = parseFloat(((spotPnlPts * LOT_SIZE) - _chg).toFixed(2));
          pnlMode   = `futures (${spotPnlPts}pt × ${LOT_SIZE}qty − ₹${_chg.toFixed(0)} charges)`;
        } else if (OPTION_SIM) {
          // Option premium change ≈ spotPnlPts × delta
          const premiumMovePts = spotPnlPts * DELTA;
          // Theta decay: proportional to candles held
          const candlesHeld    = position.candlesHeld || 1;
          const thetaDecay     = parseFloat(((THETA_PER_DAY / CANDLES_PER_DAY) * candlesHeld).toFixed(2));
          // Net option PnL per unit
          const netPremiumPts  = premiumMovePts - thetaDecay;
          // Estimate option premium for charges calc (rough: entry ~200, exit = entry + move)
          const estEntryPrem = 200;
          const estExitPrem  = Math.max(1, estEntryPrem + netPremiumPts);
          const _chg = getCharges({ isFutures: false, exitPremium: estExitPrem, entryPremium: estEntryPrem, qty: LOT_SIZE });
          // Total rupees = net premium pts × lot size − charges
          pnlRupees = parseFloat(((netPremiumPts * LOT_SIZE) - _chg).toFixed(2));
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
          signalStrength:  position.signalStrength || "MARGINAL",
          indicators:      position.indicators,
        });
        const exitIcon = pnlRupees > 0 ? "✅" : "❌";
        const pnlLabel = OPTION_SIM ? `₹${pnlRupees}` : `${spotPnlPts}pts`;
        console.log(`  🚪 EXIT ${position.side} @ ${exitPrice}  PnL=${pnlRupees >= 0 ? "+" : ""}${pnlLabel} ${exitIcon}  reason=${exitReason}`);
        if (OPTION_SIM) console.log(`     [${pnlMode}]`);
        console.log(`     Held: ${toIST(position.entryTime)} → ${toIST(candle.time)} | ${position.candlesHeld || 1} candles | Entry=${position.entryPrice} | entryPrevMid=${position.entryPrevMid}`);

        // ── 50%-rule exit → set pause for 2 candles ────────────────────────
        // 50% rule firing = price reversed immediately = choppy market.
        // Block re-entry for 2 candles (TRADE_RES * 2 * 60 seconds).
        if (exitReason.toLowerCase().includes('50% rule')) {
          const pauseSecs = 2 * candleResolutionMins * 60;
          _fiftyPctPauseUntilTs = candle.time + pauseSecs;
          console.log(`  ⏸ 50%-rule pause set: no entry until ${toIST(_fiftyPctPauseUntilTs)}`);
        }

        // ── Risk controls ─────────────────────────────────────────────────────
        _dailyPnl += pnlRupees;
        _dailyTradeCount++;

        // Track consecutive losses (for stats only — no kill in backtest to preserve data)
        if (pnlRupees < 0) {
          _consecutiveLosses++;
        } else {
          _consecutiveLosses = 0;
        }

        // SL re-entry block: only when initial SL hit (not trailing SL exit)
        const isSLExit = exitReason.toLowerCase().includes("sl hit");
        if (isSLExit) {
          // Only block if trail had NOT activated (pure losing trade)
          const wasTrailing = position.bestPrice && (
            position.side === "CE"
              ? (position.bestPrice - position.entryPrice) >= (position.trailActivatePts || TRAIL_ACTIVATE_PTS)
              : (position.entryPrice - position.bestPrice) >= (position.trailActivatePts || TRAIL_ACTIVATE_PTS)
          );
          if (!wasTrailing) {
            _slHitCandleTime = candle.time;
          }
        }

        // ── Notify strategy: optional exit callbacks
        const exitedSide = position.side;
        position = null;
        if (typeof strategy.onTradeClosed === "function") strategy.onTradeClosed();
        if (isSLExit && typeof strategy.onStopLossHit === "function") strategy.onStopLossHit(exitedSide);
      }
    }

    // ── ENTRY ─────────────────────────────────────────────────────────────────
    // Gate checks: SL re-entry block only. 50% rule and its pause removed (replaced by breakeven stop).
    const isSLBlocked = _slHitCandleTime !== null && _slHitCandleTime === candle.time;

    if (!position && !isEODcandle && (signal === "BUY_CE" || signal === "BUY_PE")) {
      // ── Expiry-day-only filter: skip entry on non-expiry days ──────────────
      if (expiryDates && !expiryDates.has(candleDate)) {
        _cachedPrevSL = signalSL ?? null;
        continue;
      }
      if (isSLBlocked) {
        _cachedPrevSL = signalSL ?? null;
        continue;
      }

      const side = signal === "BUY_CE" ? "CE" : "PE";
      // entryPrevMid: computed from prevCandle with relaxed ratio for more breathing room.
      // CE: use 35% from low (was 50%) → exit level is lower, more room before exit fires
      // PE: use 65% from low (was 50%) → exit level is higher, more room before exit fires
      // This gives ~40% more room vs the old fixed 50% mid.
      const _prevRange = prevCandle.high - prevCandle.low;
      const _prevRatio = side === "CE" ? 0.35 : 0.65;
      const entryPrevMid = parseFloat((prevCandle.low + _prevRange * _prevRatio).toFixed(2));
      const strength = signalStrength || "MARGINAL";

      // ── VIX filter: block entry in high-volatility regimes ──────────────────
      const _btVix = lookupVix(candle.time);
      const _btVixCheck = checkBacktestVix(_btVix, strength);
      if (!_btVixCheck.allowed) {
        _vixBlockCount++;
        if (_vixBlockCount <= 5) {
          console.log(`  🌡️ VIX BLOCK: ${_btVixCheck.reason} | Signal: ${signal} [${strength}] at ${toIST(candle.time)}`);
        } else if (_vixBlockCount === 6) {
          console.log(`  🌡️ VIX BLOCK: (suppressing further VIX block logs — ${_vixBlockCount} blocked so far)`);
        }
        _cachedPrevSL = signalSL ?? null;
        continue;
      }

      // ── Entry price: STRONG vs MARGINAL ──────────────────────────────────────
      let entryPrice = candle.close;
      if (strength === "STRONG" && indicators.ema9 != null) {
        if (side === "CE") {
          entryPrice = parseFloat(Math.min(candle.close, indicators.ema9).toFixed(2));
        } else {
          entryPrice = parseFloat(Math.max(candle.close, indicators.ema9).toFixed(2));
        }
      }

      // ── 50% entry gate (mirrors paper trade) ─────────────────────────────────
      // If entry price is already on the wrong side of prev candle mid,
      // 50% entry gate REMOVED — breakeven stop handles protection

      // Trail activation from env directly — dynamic: 25% of SAR gap, floored at env, capped at 40pts
      const _initialSARgapBT = prevSignalSL ? Math.abs(entryPrice - prevSignalSL) : 0;
      const _dynTrailActivateBT = Math.min(40, Math.max(TRAIL_ACTIVATE_PTS, Math.round(_initialSARgapBT * 0.25)));

      position = {
        side,
        entryPrice,
        entryTime:       candle.time,
        entryReason:     reason,
        stopLoss:        prevSignalSL || null,
        initialStopLoss: prevSignalSL || null,
        trailActivatePts: _dynTrailActivateBT,
        bestPrice:       null,
        entryPrevMid,
        signalStrength:  strength,
        indicators,
        candlesHeld:     0,
      };
      const priceNote = strength === "STRONG"
        ? `(EMA9=${indicators.ema9} < close=${candle.close} → entered at EMA9 touch)`
        : `(MARGINAL → close confirmation)`;
      console.log(`  ✅ ENTER ${side} @ ${entryPrice} [${toIST(candle.time)}]  SL=${prevSignalSL}  entryPrevMid=${entryPrevMid}  [${strength}]`);
      console.log(`     ${priceNote}`);
      console.log(`     Reason: ${reason}`);
    }

    // Cache current SL for next iteration's prevSignalSL (avoids redundant getSignal call)
    _cachedPrevSL = signalSL ?? null;
  }

  // Square off any still-open position at end of run
  if (position) {
    const lastCandle = candles[candles.length - 1];
    const spotPnlPts = parseFloat(((lastCandle.close - position.entryPrice) * (position.side === "CE" ? 1 : -1)).toFixed(2));
    let pnlRupees, pnlMode;
    if (isFutures) {
      const _chgEod = getCharges({ isFutures: true, exitPremium: lastCandle.close, entryPremium: position.entryPrice, qty: LOT_SIZE });
      pnlRupees = parseFloat(((spotPnlPts * LOT_SIZE) - _chgEod).toFixed(2));
      pnlMode   = `futures`;
    } else if (OPTION_SIM) {
      const premiumMovePts = spotPnlPts * DELTA;
      const candlesHeld    = position.candlesHeld || 1;
      const thetaDecay     = parseFloat(((THETA_PER_DAY / CANDLES_PER_DAY) * candlesHeld).toFixed(2));
      const netPremPts     = premiumMovePts - thetaDecay;
      const estEntry       = 200;
      const estExit        = Math.max(1, estEntry + netPremPts);
      const _chgEod = getCharges({ isFutures: false, exitPremium: estExit, entryPremium: estEntry, qty: LOT_SIZE });
      pnlRupees = parseFloat(((netPremPts * LOT_SIZE) - _chgEod).toFixed(2));
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
      exitPrice:   lastCandle.close,
      stopLoss:         position.stopLoss || "N/A",
      initialStopLoss:  position.initialStopLoss || position.stopLoss || "N/A",
      bestPrice:        position.bestPrice || null,
      candlesHeld:      position.candlesHeld || 1,
      spotPnlPts,
      pnl:         pnlRupees,
      pnlMode,
      exitReason:  "EOD square-off (run end)",
      entryReason: position.entryReason,
      indicators:  position.indicators,
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
    },
    trades,
  };
}

module.exports = { fetchCandles, runBacktest };

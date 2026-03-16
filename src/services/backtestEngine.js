require("dotenv").config();
const fyers = require("../config/fyers");
const { toDateString } = require("../utils/time");
const { getLotQty } = require("../config/instrument");

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

/** Get IST date string "YYYY-MM-DD" from unix seconds */
function getISTDateStr(unixSec) {
  return new Date(unixSec * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Get IST hour*60+min from unix seconds */
function getISTHHMM(unixSec) {
  const d = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return d.getHours() * 60 + d.getMinutes();
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
 */
function runBacktest(candles, strategy, capital) {
  const trades    = [];
  let position    = null;
  const BROKERAGE = 80;
  const LOT_SIZE  = getLotQty();

  // Trail gap = 60 pts default (env: TRAIL_GAP_PTS).
  // Nifty 15-min intraday pullbacks regularly hit 40-70pt — 40pt was too tight.
  // 60pt gives enough breathing room.
  // Activation threshold = 15pt (env: TRAIL_ACTIVATE_PTS) — trail locks profit
  // once the trade is +15pt in favour. Lowered from 50pt so partial gains are protected.
  const TRAIL_GAP_PTS      = parseFloat(process.env.TRAIL_GAP_PTS      || "60");
  const TRAIL_ACTIVATE_PTS = parseFloat(process.env.TRAIL_ACTIVATE_PTS || "15");

  // Reset strategy module-level state if it has a reset hook
  if (typeof strategy.reset === "function") strategy.reset();

  console.log("\n══════════════════════════════════════════════");
  console.log(`🔍 BACKTEST — ${strategy.NAME}`);
  console.log(`   Entry : signal from strategy at candle close`);
  console.log(`   Exit  : 50% rule + trail SL + SAR SL + opposite signal + EOD/day`);
  console.log(`   Brok  : ₹${BROKERAGE} per trade`);
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
  console.log(`   TRAIL_GAP: ${TRAIL_GAP_PTS}pts | TRAIL_ACTIVATE: ${TRAIL_ACTIVATE_PTS}pts | ADX_MIN: 25 | RSI CE>55 PE<45`);

  // 50%-rule exit pause: after a 50%-rule exit, block re-entry for 2 candles.
  // Stored as unix seconds (candle.time units). Reset per day in the loop.
  let _fiftyPctPauseUntilTs = 0;

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
    // Trail from the very first favourable move (no minimum trigger distance).
    // 50% floor applied: trail cannot cross entryPrevMid until price clears it.
    // Uses candle high/low as best price proxy (tick-level not available in backtest).
    // Mirrors paper/live: SL = bestPrice ± TRAIL_GAP_PTS, tighten only.
    if (position) {
      // 50% floor + activation threshold: mirrors paper trade exactly.
      // Trail only activates after TRAIL_ACTIVATE_PTS move in our favour (same as paper).
      // Trail SL cannot cross entryPrevMid until price has moved past it.
      // TRAIL_ACTIVATE_PTS is declared at function top — read from env (default 50).
      if (position.side === "CE") {
        const bestThisCandle = candle.high;
        if (!position.bestPrice || bestThisCandle > position.bestPrice) position.bestPrice = bestThisCandle;
        const moveInFavour = position.bestPrice - position.entryPrice;
        if (moveInFavour >= TRAIL_ACTIVATE_PTS) {
          const trailSL = parseFloat((position.bestPrice - TRAIL_GAP_PTS).toFixed(2));
          const effectiveTrailSL = position.entryPrevMid !== null ? Math.min(trailSL, position.entryPrevMid) : trailSL;
          if (effectiveTrailSL > position.stopLoss) {
            console.log(`  📈 TRAIL CE: bestHigh=${position.bestPrice} move=+${moveInFavour.toFixed(1)}pt → trailSL=${trailSL} (floor=${position.entryPrevMid}) → effective=${effectiveTrailSL}`);
            position.stopLoss = effectiveTrailSL;
          }
        }
      } else {
        const bestThisCandle = candle.low;
        if (!position.bestPrice || bestThisCandle < position.bestPrice) position.bestPrice = bestThisCandle;
        const moveInFavour = position.entryPrice - position.bestPrice;
        if (moveInFavour >= TRAIL_ACTIVATE_PTS) {
          const trailSL = parseFloat((position.bestPrice + TRAIL_GAP_PTS).toFixed(2));
          const effectiveTrailSL = position.entryPrevMid !== null ? Math.max(trailSL, position.entryPrevMid) : trailSL;
          if (effectiveTrailSL < position.stopLoss) {
            console.log(`  📉 TRAIL PE: bestLow=${position.bestPrice} move=+${moveInFavour.toFixed(1)}pt → trailSL=${trailSL} (floor=${position.entryPrevMid}) → effective=${effectiveTrailSL}`);
            position.stopLoss = effectiveTrailSL;
          }
        }
      }
    }

    // ── EXIT CHECK ────────────────────────────────────────────────────────────
    if (position) {
      let exitReason = null;
      let exitPrice  = candle.close;

      // Rule 1: 50% candle rule
      // Skip on the entry candle itself — mirrors paper/live which skips the entry bar.
      // prevMid = mid of the candle closed just BEFORE entry (fixed at entry time).
      const isEntryCandle = candle.time === position.entryTime;
      if (!isEntryCandle) {
        const prevMid = position.entryPrevMid;
        if (position.side === "CE" && candle.low < prevMid) {
          exitReason = `50% rule — low ${candle.low} < prev mid ${prevMid}`;
          exitPrice  = prevMid;
        } else if (position.side === "PE" && candle.high > prevMid) {
          exitReason = `50% rule — high ${candle.high} > prev mid ${prevMid}`;
          exitPrice  = prevMid;
        }
      }

      // Rule 2+3: SL or trail SL
      if (!exitReason && position.stopLoss !== null && position.stopLoss !== undefined) {
        if (position.side === "CE" && candle.close < position.stopLoss) {
          exitReason = `SL hit — close ${candle.close} < SL ${position.stopLoss}`;
          exitPrice  = position.stopLoss;
        } else if (position.side === "PE" && candle.close > position.stopLoss) {
          exitReason = `SL hit — close ${candle.close} > SL ${position.stopLoss}`;
          exitPrice  = position.stopLoss;
        }
      }

      // Rule 4: Opposite signal
      if (!exitReason && signal === (position.side === "CE" ? "BUY_PE" : "BUY_CE")) {
        exitReason = "Opposite signal exit";
        exitPrice  = candle.close;
      }

      // Rule 5: EOD square-off — PER DAY at 3:20 PM (FIXED)
      if (!exitReason && isEODcandle) {
        exitReason = `EOD square-off ${candleMin >= 920 ? "3:20 PM" : "(last candle of day)"}`;
        exitPrice  = candle.close;
      }

      if (exitReason) {
        const pnlPoints = parseFloat(((exitPrice - position.entryPrice) * (position.side === "CE" ? 1 : -1)).toFixed(2));
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
          pnl:             pnlPoints,
          exitReason,
          entryReason:     position.entryReason,
          signalStrength:  position.signalStrength || "MARGINAL",
          indicators:      position.indicators,
        });
        const exitIcon = pnlPoints > 0 ? "✅" : "❌";
        console.log(`  🚪 EXIT ${position.side} @ ${exitPrice}  PnL=${pnlPoints > 0 ? "+" : ""}${pnlPoints}pts ${exitIcon}  reason=${exitReason}`);
        console.log(`     Held: ${toIST(position.entryTime)} → ${toIST(candle.time)} | Entry=${position.entryPrice} | entryPrevMid=${position.entryPrevMid}`);

        // ── 50%-rule exit → set pause for 2 candles ────────────────────────
        // 50% rule firing = price reversed immediately = choppy market.
        // Block re-entry for 2 candles (TRADE_RES * 2 * 60 seconds).
        if (exitReason.toLowerCase().includes('50% rule')) {
          const pauseSecs = 2 * candleResolutionMins * 60;
          _fiftyPctPauseUntilTs = candle.time + pauseSecs;
          console.log(`  ⏸ 50%-rule pause set: no entry until ${toIST(_fiftyPctPauseUntilTs)}`);
        }

        // ── Notify strategy: optional exit callbacks
        const exitedSide = position.side;
        position = null;
        if (typeof strategy.onTradeClosed === "function") strategy.onTradeClosed();
        const isSL = exitReason.toLowerCase().includes("sl hit");
        if (isSL && typeof strategy.onStopLossHit === "function") strategy.onStopLossHit(exitedSide);
      }
    }

    // ── ENTRY ─────────────────────────────────────────────────────────────────
    // Don't enter on EOD candle — position would be immediately squared off.
    // SL from prevWindow (closed candles only) — matches paper/live fix.
    // entryPrevMid = mid of candle[i-1] (closed just before entry) — fixed for 50% rule.
    // Check 50%-rule pause before entry
    const is50PctPaused = candle.time < _fiftyPctPauseUntilTs;
    if (is50PctPaused && (signal === "BUY_CE" || signal === "BUY_PE")) {
      console.log(`  ⏸ [50%-rule pause] skipping ${signal} at ${toIST(candle.time)} — pause until ${toIST(_fiftyPctPauseUntilTs)}`);
    }

    if (!position && !isEODcandle && !is50PctPaused && (signal === "BUY_CE" || signal === "BUY_PE")) {
      const side = signal === "BUY_CE" ? "CE" : "PE";
      const entryPrevMid = parseFloat(((prevCandle.high + prevCandle.low) / 2).toFixed(2));
      const strength = signalStrength || "MARGINAL";

      // ── Entry price: STRONG vs MARGINAL ──────────────────────────────────────
      // STRONG  → strategy confirmed intra-candle EMA9 touch: simulate entry AT EMA9.
      //           CE: EMA9 is the first touch point going up → entry below close = better fill.
      //           PE: EMA9 is the first touch point going down → entry above close = better fill.
      //           Uses Math.min/max as safety net (EMA9 should already be better, but guards edge cases).
      // MARGINAL → candle-close confirmed entry. Price needed to fully close in the right
      //           direction first, so candle.close is the correct and intended entry price.
      let entryPrice = candle.close;
      if (strength === "STRONG" && indicators.ema9 != null) {
        if (side === "CE") {
          entryPrice = parseFloat(Math.min(candle.close, indicators.ema9).toFixed(2));
        } else {
          entryPrice = parseFloat(Math.max(candle.close, indicators.ema9).toFixed(2));
        }
      }

      position = {
        side,
        entryPrice,
        entryTime:      candle.time,
        entryReason:    reason,
        stopLoss:       prevSignalSL || null,   // SL from closed candles only (will trail)
        initialStopLoss: prevSignalSL || null, // original SL at entry — never changes
        bestPrice:      null,
        entryPrevMid,                            // fixed mid for 50% rule — never changes
        signalStrength: strength,
        indicators,
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
    const pnlPoints  = parseFloat(((lastCandle.close - position.entryPrice) * (position.side === "CE" ? 1 : -1)).toFixed(2));
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
      pnl:         pnlPoints,
      exitReason:  "EOD square-off (run end)",
      entryReason: position.entryReason,
      indicators:  position.indicators,
    });
    if (typeof strategy.onTradeClosed === "function") strategy.onTradeClosed();
  }

  console.log("\n══════════════════════════════════════════════\n");

  const totalPnl      = trades.reduce((sum, t) => sum + t.pnl, 0);
  const wins          = trades.filter((t) => t.pnl > 0);
  const losses        = trades.filter((t) => t.pnl <= 0);
  const maxDrawdown   = trades.reduce((dd, t) => Math.min(dd, t.pnl), 0);  // worst single loss
  const totalDrawdown = losses.reduce((sum, t) => sum + t.pnl, 0);         // sum of all losses
  const maxProfit     = trades.reduce((mp, t) => Math.max(mp, t.pnl), 0);  // best single win
  const avgWin        = wins.length   ? wins.reduce((s, t)   => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss       = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const riskReward    = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;

  // ── STRONG vs MARGINAL breakdown — helps calibrate thresholds ────────────────
  // Shows whether STRONG signals have higher win rate than MARGINAL.
  // If STRONG win rate >> MARGINAL win rate → thresholds are well-calibrated.
  // If similar → thresholds need tuning (slope/RSI gates not discriminating enough).
  const strongTrades   = trades.filter((t) => t.signalStrength === "STRONG");
  const marginalTrades = trades.filter((t) => t.signalStrength !== "STRONG");
  const strongWins     = strongTrades.filter((t) => t.pnl > 0);
  const marginalWins   = marginalTrades.filter((t) => t.pnl > 0);
  const strongPnl      = strongTrades.reduce((s, t) => s + t.pnl, 0);
  const marginalPnl    = marginalTrades.reduce((s, t) => s + t.pnl, 0);

  // ── Full terminal summary ──────────────────────────────────────────────────
  const totalPnlFinal = parseFloat(totalPnl.toFixed(2));
  const wrFinal = trades.length ? ((wins.length / trades.length) * 100).toFixed(1) : "N/A";
  console.log("\n══════════════════════════════════════════════");
  console.log(`📊 BACKTEST COMPLETE — ${strategy.NAME}`);
  console.log(`   Period   : ${trades.length > 0 ? trades[trades.length-1].exitTime + " to end" : "no trades"}`);
  console.log(`   Candles  : ${candles.length} (${candleResolutionMins}-min)`);
  console.log("──────────────────────────────────────────────");
  console.log(`   Trades   : ${trades.length} (${wins.length}W / ${losses.length}L)`);
  console.log(`   Win Rate : ${wrFinal}%`);
  console.log(`   R:R      : 1:${riskReward ? riskReward.toFixed(2) : "N/A"}`);
  console.log(`   Avg Win  : +${avgWin.toFixed(1)} pts`);
  console.log(`   Avg Loss : ${avgLoss.toFixed(1)} pts`);
  console.log(`   Total PnL: ${totalPnlFinal >= 0 ? "+" : ""}${totalPnlFinal} pts`);
  console.log(`   Max Win  : +${maxProfit.toFixed(1)} pts`);
  console.log(`   Max Loss : ${maxDrawdown.toFixed(1)} pts`);
  console.log(`   Total DD : ${totalDrawdown.toFixed(1)} pts (sum of all losses)`);
  console.log("──────────────────────────────────────────────");
  console.log("── Signal Strength Breakdown ──────────────────────");
  console.log(`  STRONG  : ${strongTrades.length} trades | ${strongWins.length}W/${strongTrades.length - strongWins.length}L | WR=${strongTrades.length ? ((strongWins.length/strongTrades.length)*100).toFixed(1) : "N/A"}% | PnL=${strongPnl.toFixed(1)}pts`);
  console.log(`  MARGINAL: ${marginalTrades.length} trades | ${marginalWins.length}W/${marginalTrades.length - marginalWins.length}L | WR=${marginalTrades.length ? ((marginalWins.length/marginalTrades.length)*100).toFixed(1) : "N/A"}% | PnL=${marginalPnl.toFixed(1)}pts`);

  // ── Exit reason breakdown ────────────────────────────────────────────────────
  const exitGroups = {};
  trades.forEach(t => {
    const key = t.exitReason.split(' ')[0] + (t.exitReason.includes('50% rule') ? ' rule' : t.exitReason.includes('SL hit') ? ' hit' : '');
    const label = t.exitReason.includes('50% rule') ? '50% rule' : t.exitReason.includes('SL hit') ? 'SL hit' : t.exitReason.includes('Opposite') ? 'Opposite signal' : t.exitReason.includes('EOD') ? 'EOD square-off' : 'Other';
    if (!exitGroups[label]) exitGroups[label] = { count:0, wins:0, pnl:0 };
    exitGroups[label].count++;
    if (t.pnl > 0) exitGroups[label].wins++;
    exitGroups[label].pnl += t.pnl;
  });
  console.log("── Exit Reason Breakdown ──────────────────────────");
  Object.entries(exitGroups).sort((a,b) => b[1].count - a[1].count).forEach(([label, g]) => {
    console.log(`  ${label.padEnd(18)}: ${g.count} trades | ${g.wins}W/${g.count-g.wins}L | WR=${((g.wins/g.count)*100).toFixed(0)}% | PnL=${g.pnl.toFixed(1)}pts`);
  });
  console.log("══════════════════════════════════════════════\n");

  return {
    summary: {
      strategy:        strategy.NAME,
      description:     strategy.DESCRIPTION,
      totalTrades:     trades.length,
      wins:            wins.length,
      losses:          losses.length,
      winRate:         trades.length ? `${((wins.length / trades.length) * 100).toFixed(1)}%` : "N/A",
      totalPnl:        parseFloat(totalPnl.toFixed(2)),
      maxProfit:       parseFloat(maxProfit.toFixed(2)),
      maxDrawdown:     parseFloat(maxDrawdown.toFixed(2)),
      totalDrawdown:   parseFloat(totalDrawdown.toFixed(2)),
      avgWin:          parseFloat(avgWin.toFixed(2)),
      avgLoss:         parseFloat(avgLoss.toFixed(2)),
      riskReward:      riskReward ? `1:${riskReward.toFixed(2)}` : "N/A",
      finalCapital:    parseFloat((capital + totalPnl).toFixed(2)),
      // Signal strength breakdown (v54)
      strongTrades:    strongTrades.length,
      strongWinRate:   strongTrades.length ? `${((strongWins.length/strongTrades.length)*100).toFixed(1)}%` : "N/A",
      strongPnl:       parseFloat(strongPnl.toFixed(2)),
      marginalTrades:  marginalTrades.length,
      marginalWinRate: marginalTrades.length ? `${((marginalWins.length/marginalTrades.length)*100).toFixed(1)}%` : "N/A",
      marginalPnl:     parseFloat(marginalPnl.toFixed(2)),
    },
    trades,
  };
}

module.exports = { fetchCandles, runBacktest };

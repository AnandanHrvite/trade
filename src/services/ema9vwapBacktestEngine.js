/**
 * ema9vwapBacktestEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Candle-loop backtest for the EMA9+VWAP strategy. It is a FAITHFUL mirror of the
 * paper engine's decision loop (paper is canonical), NOT the generic swing
 * backtestEngine (whose EMA21-trail / structural-SL exits don't apply here):
 *
 *   • entry  : on a CLOSED 5-min candle, when getSignal() returns BUY_CE/BUY_PE
 *              (EMA9 crossed the VWAP top/bottom band) within the entry window.
 *   • exit   : PURE signal exit — getSignal().exitCE / exitPE (EMA9 re-crossed
 *              back inside the band), or the EOD square-off time. No SL/target/trail.
 *   • window : the last 200 candles are passed to getSignal() each step, matching
 *              the paper engine's 200-candle in-memory cap and its session-anchored
 *              VWAP (which resets per trading day inside the strategy module).
 *
 * P&L uses the same option-simulation model as the shared backtestEngine
 * (spotPnlPts × delta − theta − charges) so its numbers are comparable, and it
 * returns the same { summary, trades } shape the backtest HTML renders.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const instrumentConfig = require("../config/instrument");
const { getLotQty } = instrumentConfig;
const { getCharges } = require("../utils/charges");
const strategy = require("../strategies/ema9_vwap");
const vixFilter = require("./vixFilter");

function _istMins(s) { return Math.floor((s + 19800) / 60) % 1440; }
function _istDay(s)  { return Math.floor((s + 19800) / 86400); }
function _parseMins(key, def) {
  const raw = process.env[key] || def;
  const [h, m] = raw.split(":").map(Number);
  return (h || 0) * 60 + (isNaN(m) ? 0 : m);
}
function _q(n, d) { const f = Math.pow(10, d); return Math.round(n * f) / f; }
function _toIST(s) {
  return new Date(s * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

/**
 * @param {Array} candles  ascending OHLC(+volume) spot candles (with warmup history)
 * @param {number} capital starting capital (for finalCapital display)
 * @param {Function} onProgress  (p)=>void progress callback
 * @param {number} activeFromTs  only record trades whose entry candle.time >= this (warmup gate)
 * @returns {{summary:Object, trades:Array}}
 */
async function runEma9VwapBacktest(candles, capital, onProgress, activeFromTs = 0, vixCandles = []) {
  const trades   = [];
  let position   = null;
  const LOT_SIZE = getLotQty();

  const isFutures      = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const OPTION_SIM     = isFutures ? false : (process.env.BACKTEST_OPTION_SIM !== "false");
  const DELTA          = isFutures ? 1.0 : parseFloat(process.env.BACKTEST_DELTA      || "0.55");
  const THETA_PER_DAY  = isFutures ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY  || "10");
  // Candles per 6.5-hour (390-min) day, derived from actual bar spacing — not a fixed 26
  // (that only holds for 15-min bars; a 5-min run has ~78, so 26 over-charges theta ~3×).
  const _btResMins      = candles.length >= 2 ? Math.max(1, Math.round((candles[1].time - candles[0].time) / 60)) : 5;
  const CANDLES_PER_DAY = Math.max(1, Math.round(390 / _btResMins));
  // Default 1.5pt/side to match every other backtest engine — a 0 default made
  // EMA9_VWAP the only frictionless backtest, flattering its results vs siblings.
  const SLIPPAGE_PTS   = parseFloat(process.env.BACKTEST_SLIPPAGE_PTS || "1.5");

  const entryStart     = _parseMins("EMA9VWAP_ENTRY_START", "10:30");
  const entryEnd       = _parseMins("EMA9VWAP_ENTRY_END", "14:30");
  const eodExit        = _parseMins("EMA9VWAP_EOD_EXIT_TIME", "15:15");
  // Same fallback chain as paper (_refreshConfig): per-strategy → global → default,
  // so the backtest's daily caps mirror the canonical paper engine exactly.
  const maxDailyTrades = parseInt(process.env.EMA9VWAP_MAX_DAILY_TRADES || process.env.MAX_DAILY_TRADES || "20", 10);
  const maxDailyLoss   = parseFloat(process.env.EMA9VWAP_MAX_DAILY_LOSS || process.env.MAX_DAILY_LOSS || "5000");
  const reversalExit   = (process.env.EMA9VWAP_REVERSAL_EXIT_ENABLED || "true").toLowerCase() === "true";

  // ── Guards mirrored from paper (previously absent from this engine) ──────────
  // Opposite-side (flip) cooldown — same keys/defaults as ema9vwapPaper._refreshConfig.
  const oppCooldownEnabled = (process.env.EMA9VWAP_OPPOSITE_SIDE_COOLDOWN_ENABLED || "true").toLowerCase() === "true";
  const oppCooldownCandles = parseInt(process.env.EMA9VWAP_OPPOSITE_SIDE_COOLDOWN_CANDLES || "3", 10);
  // Reason patterns that do NOT arm the opposite cooldown (mirror paper _setOppositeCooldown).
  const OPP_EXEMPT_RE = /opposite signal|eod|day close|market closed|auto-stop|manual|session restart|simulation ended/i;
  // Candle resolution in minutes (from spacing) — drives the "4 candles" pause + cooldown windows.
  const resMins = candles.length >= 2 ? Math.max(1, Math.round((candles[1].time - candles[0].time) / 60)) : 5;
  // VIX gate: paper calls checkLiveVix("STRONG") with the default (EMA_RSI_ST) thresholds;
  // checkBacktestVix self-gates on VIX_FILTER_ENABLED and fails per VIX_FAIL_MODE.
  const vixLookup = vixFilter.buildVixLookup(vixCandles || []);
  let vixBlocked = 0;

  let curDay = null, dailyTrades = 0, dailyPnl = 0;
  // Per-day circuit-breaker state (reset each trading day, like paper's per-session state).
  let dailyLossHit = false;        // latched once daily loss ≥ cap (a later win does NOT clear it)
  let consecLosses = 0;            // back-to-back losses
  let pauseUntilTs = 0;            // block entries until this candle.time (seconds) — 3-loss pause
  let oppCooldownUntilTs = 0;      // block opposite-side entries until this candle.time (seconds)
  let oppCooldownLastSide = null;  // side that was last exited
  const total = candles.length;
  const reportEvery = Math.max(1, Math.floor(total / 50));

  // Rolling 200-candle window reused via push/shift (mirrors paper's in-memory cap
  // and the shared backtestEngine's window trick). Replaces a fresh candles.slice()
  // per iteration — that was O(n²) allocation and, combined with the missing
  // event-loop yield below, blocked the SAME process that hosts the live Fyers feed
  // for 10–60s on multi-year runs. getSignal() sees an identical view either way.
  const window = total > 0 ? [candles[0]] : [];

  function _closeTrade(candle, exitReason) {
    let exitPrice = candle.close;
    if (SLIPPAGE_PTS > 0) exitPrice = position.side === "CE" ? exitPrice - SLIPPAGE_PTS : exitPrice + SLIPPAGE_PTS;
    const spotPnlPts = _q((exitPrice - position.entryPrice) * (position.side === "CE" ? 1 : -1), 2);

    let pnlRupees, pnlMode;
    if (isFutures) {
      const _chg = getCharges({ isFutures: true, exitPremium: exitPrice, entryPremium: position.entryPrice, qty: LOT_SIZE });
      pnlRupees = _q((spotPnlPts * LOT_SIZE) - _chg, 2);
      pnlMode   = `futures (${spotPnlPts}pt × ${LOT_SIZE}qty − ₹${_chg.toFixed(0)})`;
    } else if (OPTION_SIM) {
      const premiumMovePts = spotPnlPts * DELTA;
      const thetaDecay     = _q((THETA_PER_DAY / CANDLES_PER_DAY) * (position.candlesHeld || 1), 2);
      const netPremiumPts  = premiumMovePts - thetaDecay;
      const estEntryPrem   = 200;
      const estExitPrem    = Math.max(1, estEntryPrem + netPremiumPts);
      const _chg = getCharges({ isFutures: false, exitPremium: estExitPrem, entryPremium: estEntryPrem, qty: LOT_SIZE });
      pnlRupees = _q((netPremiumPts * LOT_SIZE) - _chg, 2);
      pnlMode   = `opt_sim (spot=${spotPnlPts}pt × δ${DELTA} − θ${thetaDecay}pt) × ${LOT_SIZE} − ₹${_chg.toFixed(0)}`;
    } else {
      pnlRupees = spotPnlPts;
      pnlMode   = "raw_pts";
    }

    trades.push({
      side:            position.side,
      entryTime:       _toIST(position.entryTime),
      exitTime:        _toIST(candle.time),
      entryTs:         position.entryTime,
      exitTs:          candle.time,
      entryPrice:      position.entryPrice,
      exitPrice:       _q(exitPrice, 2),
      stopLoss:        "N/A",
      initialStopLoss: "N/A",
      bestPrice:       null,
      candlesHeld:     position.candlesHeld || 1,
      spotPnlPts,
      pnl:             pnlRupees,
      pnlMode,
      exitReason,
      entryReason:     position.entryReason,
      signalStrength:  position.signalStrength || "STRONG",
    });
    dailyTrades++;
    dailyPnl += pnlRupees;

    // ── Circuit-breaker updates (mirror ema9vwapPaper's simulateSell tail) ──────
    const _exitedSide = position.side;
    // Daily-loss latch: once the day's loss reaches the cap, no more entries today
    // (a later win does NOT clear it — matches paper).
    if (!dailyLossHit && dailyPnl <= -Math.abs(maxDailyLoss)) dailyLossHit = true;
    // 3-consecutive-loss rule: 15-min → kill the day; 5-min → pause 4 candles + reset.
    if (pnlRupees < 0) {
      consecLosses += 1;
      if (consecLosses >= 3) {
        if (resMins >= 15) { dailyLossHit = true; }
        else { pauseUntilTs = candle.time + 4 * resMins * 60; consecLosses = 0; }
      }
    } else {
      consecLosses = 0;
      pauseUntilTs = 0; // a profitable/flat trade clears any remaining pause (matches paper)
    }
    // Opposite-side (flip) cooldown: arm unless the exit reason is exempt.
    if (oppCooldownEnabled && oppCooldownCandles > 0 && !OPP_EXEMPT_RE.test(exitReason)) {
      oppCooldownUntilTs  = candle.time + oppCooldownCandles * resMins * 60;
      oppCooldownLastSide = _exitedSide;
    }

    position = null;
  }

  for (let i = 1; i < total; i++) {
    // Yield the event loop every 100 candles so a long backtest doesn't starve
    // the live tick feed / HTTP handlers running in this same process.
    if (i % 100 === 0) await new Promise((r) => setImmediate(r));

    const candle = candles[i];
    const day = _istDay(candle.time);
    if (day !== curDay) {
      curDay = day; dailyTrades = 0; dailyPnl = 0;
      // Reset per-day circuit-breaker state (paper starts each session fresh).
      dailyLossHit = false; consecLosses = 0; pauseUntilTs = 0;
      oppCooldownUntilTs = 0; oppCooldownLastSide = null;
    }
    const mins = _istMins(candle.time);
    let exitedThisCandle = false;

    // Extend the rolling window by the current candle; cap at 200 (paper's in-memory
    // cap). window now equals candles[max(0,i-199) .. i] — same view getSignal saw
    // from the old per-iteration slice, without the per-step allocation.
    window.push(candle);
    if (window.length > 200) window.shift();
    const sig = strategy.getSignal(window, { silent: true });

    // ── EXIT (checked first, like paper's onCandleClose) ──
    if (position) {
      position.candlesHeld = (position.candlesHeld || 0) + 1;
      let doExit = false, exitReason = "";
      // Exit 2.5: 2-candle reversal engulf — mirrors paper onCandleClose. CE bails on a
      // bearish candle closing below both prior 2 lows; PE on a bullish candle closing
      // above both prior 2 highs. Positions never carry overnight (EOD square-off), so
      // candles[i-1]/[i-2] are always same-day while a position is open.
      if (reversalExit && i >= 2) {
        const prev1 = candles[i - 1], prev2 = candles[i - 2];
        const revCE = position.side === "CE" && candle.close < candle.open && candle.close < Math.min(prev1.low, prev2.low);
        const revPE = position.side === "PE" && candle.close > candle.open && candle.close > Math.max(prev1.high, prev2.high);
        if (revCE || revPE) { doExit = true; exitReason = "2-candle reversal exit"; }
      }
      if (!doExit && ((position.side === "CE" && sig.exitCE) || (position.side === "PE" && sig.exitPE))) {
        doExit = true;
        exitReason = `EMA9 re-entered VWAP ${position.side === "CE" ? "top" : "bottom"} band`;
      } else if (!doExit && mins >= eodExit) {
        doExit = true;
        exitReason = "EOD square-off";
      }
      if (doExit) { _closeTrade(candle, exitReason); exitedThisCandle = true; }
    }

    // ── ENTRY (candle close, inside the entry window, daily guards) ──
    // exitedThisCandle mirrors paper's `return` after a candle-close exit — no new
    // entry on a candle that just closed a position.
    if (!position && !exitedThisCandle && candle.time >= activeFromTs
        && (sig.signal === "BUY_CE" || sig.signal === "BUY_PE")
        && mins >= entryStart && mins < entryEnd) {
      const side = sig.signal === "BUY_CE" ? "CE" : "PE";
      // Circuit breakers (mirror paper's entry gate + simulateBuy cooldowns):
      //   • max trades/day  • latched daily-loss  • 3-loss pause  • opposite-side cooldown
      const _oppBlocked = oppCooldownEnabled && oppCooldownLastSide
        && oppCooldownLastSide !== side && candle.time < oppCooldownUntilTs;
      if (dailyTrades < maxDailyTrades && !dailyLossHit && candle.time >= pauseUntilTs && !_oppBlocked) {
        // VIX gate — evaluated only when we would otherwise enter, like paper.
        const _vc = vixFilter.checkBacktestVix(vixLookup(candle.time), "STRONG", { mode: "ema_rsi_st" });
        if (_vc.allowed) {
          let entryPrice = candle.close;
          if (SLIPPAGE_PTS > 0) entryPrice = side === "CE" ? entryPrice + SLIPPAGE_PTS : entryPrice - SLIPPAGE_PTS;
          position = {
            side, entryPrice: _q(entryPrice, 2), entryTime: candle.time,
            candlesHeld: 0, signalStrength: "STRONG", entryReason: sig.reason,
          };
        } else {
          vixBlocked += 1;
        }
      }
    }

    if (onProgress && i % reportEvery === 0) {
      onProgress({ phase: "Running EMA9+VWAP backtest…", pct: Math.round((i / total) * 100), current: i, total });
    }
  }

  // Close any position still open at the end of data.
  if (position) _closeTrade(candles[total - 1], "End of data");

  // ── Summary (same shape the backtest HTML renders) ──
  const totalPnl      = trades.reduce((s, t) => s + t.pnl, 0);
  const wins          = trades.filter((t) => t.pnl > 0);
  const losses        = trades.filter((t) => t.pnl < 0);
  const maxDrawdown   = trades.reduce((dd, t) => Math.min(dd, t.pnl), 0);
  const maxProfit     = trades.reduce((mp, t) => Math.max(mp, t.pnl), 0);
  const totalDrawdown = losses.reduce((s, t) => s + t.pnl, 0);
  const totalSpotPts  = trades.reduce((s, t) => s + (t.spotPnlPts || 0), 0);
  const avgWin        = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss       = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const riskReward    = avgLoss ? Math.abs(avgWin / avgLoss) : null;
  const wr            = trades.length ? `${((wins.length / trades.length) * 100).toFixed(1)}%` : "N/A";

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
      winRate:         wr,
      totalPnl:        _q(totalPnl, 2),
      totalSpotPts:    _q(totalSpotPts, 2),
      maxProfit:       _q(maxProfit, 2),
      maxDrawdown:     _q(maxDrawdown, 2),
      totalDrawdown:   _q(totalDrawdown, 2),
      avgWin:          _q(avgWin, 2),
      avgLoss:         _q(avgLoss, 2),
      riskReward:      riskReward ? `1:${riskReward.toFixed(2)}` : "N/A",
      finalCapital:    OPTION_SIM ? _q(capital + totalPnl, 2) : null,
      strongTrades:    trades.length,
      strongWinRate:   wr,
      strongPnl:       _q(totalPnl, 2),
      marginalTrades:  0,
      marginalWinRate: "N/A",
      marginalPnl:     0,
      vixEnabled:      vixFilter.VIX_ENABLED,
      vixBlocked:      vixBlocked,
      vixMaxEntry:     vixFilter.VIX_ENABLED ? vixFilter.VIX_MAX_ENTRY : null,
      vixStrongOnly:   false,
      rejectBreakdown: [],
    },
    trades,
  };
}

module.exports = { runEma9VwapBacktest };

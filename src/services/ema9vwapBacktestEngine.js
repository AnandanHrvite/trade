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
async function runEma9VwapBacktest(candles, capital, onProgress, activeFromTs = 0) {
  const trades   = [];
  let position   = null;
  const LOT_SIZE = getLotQty();

  const isFutures      = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const OPTION_SIM     = isFutures ? false : (process.env.BACKTEST_OPTION_SIM !== "false");
  const DELTA          = isFutures ? 1.0 : parseFloat(process.env.BACKTEST_DELTA      || "0.55");
  const THETA_PER_DAY  = isFutures ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY  || "10");
  const CANDLES_PER_DAY = 26;
  const SLIPPAGE_PTS   = parseFloat(process.env.BACKTEST_SLIPPAGE_PTS || "0");

  const entryStart     = _parseMins("EMA9VWAP_ENTRY_START", "10:30");
  const entryEnd       = _parseMins("EMA9VWAP_ENTRY_END", "14:30");
  const eodExit        = _parseMins("EMA9VWAP_EOD_EXIT_TIME", "15:15");
  const maxDailyTrades = parseInt(process.env.EMA9VWAP_MAX_DAILY_TRADES || "20", 10);
  const maxDailyLoss   = parseFloat(process.env.EMA9VWAP_MAX_DAILY_LOSS || "5000");
  const reversalExit   = (process.env.EMA9VWAP_REVERSAL_EXIT_ENABLED || "true").toLowerCase() === "true";

  let curDay = null, dailyTrades = 0, dailyPnl = 0;
  const total = candles.length;
  const reportEvery = Math.max(1, Math.floor(total / 50));

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
    position = null;
  }

  for (let i = 1; i < total; i++) {
    const candle = candles[i];
    const day = _istDay(candle.time);
    if (day !== curDay) { curDay = day; dailyTrades = 0; dailyPnl = 0; }
    const mins = _istMins(candle.time);

    // Mirror paper's 200-candle in-memory cap (also bounds getSignal cost).
    const window = candles.slice(Math.max(0, i - 199), i + 1);
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
      if (doExit) _closeTrade(candle, exitReason);
    }

    // ── ENTRY (candle close, inside the entry window, daily guards) ──
    if (!position && candle.time >= activeFromTs
        && (sig.signal === "BUY_CE" || sig.signal === "BUY_PE")
        && mins >= entryStart && mins < entryEnd
        && dailyTrades < maxDailyTrades && dailyPnl > -maxDailyLoss) {
      const side = sig.signal === "BUY_CE" ? "CE" : "PE";
      let entryPrice = candle.close;
      if (SLIPPAGE_PTS > 0) entryPrice = side === "CE" ? entryPrice + SLIPPAGE_PTS : entryPrice - SLIPPAGE_PTS;
      position = {
        side, entryPrice: _q(entryPrice, 2), entryTime: candle.time,
        candlesHeld: 0, signalStrength: "STRONG", entryReason: sig.reason,
      };
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
      vixEnabled:      false,
      vixBlocked:      0,
      vixMaxEntry:     null,
      vixStrongOnly:   false,
      rejectBreakdown: [],
    },
    trades,
  };
}

module.exports = { runEma9VwapBacktest };

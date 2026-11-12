/**
 * ema9vwapBacktestEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Candle-loop backtest for the EMA9+VWAP strategy. It is a FAITHFUL mirror of the
 * paper engine's decision loop (paper is canonical), NOT the generic swing
 * backtestEngine (whose EMA21-trail / structural-SL exits don't apply here):
 *
 *   • entry  : on a CLOSED 5-min candle, when getSignal() returns BUY_CE/BUY_PE
 *              (EMA9 crossed the VWAP top/bottom band) within the entry window.
 *   • exit   : the global profit lock (tradeGuards.checkProfitLock) is the ONLY
 *              automatic exit, applied intrabar to the simulated premium; anything
 *              still open is closed on the last bar of each day (paper's session
 *              teardown). No SL / target / trail / signal exit / day loss limits.
 *   • window : the last 200 candles are passed to getSignal() each step, matching
 *              the paper engine's 200-candle in-memory cap and its session-anchored
 *              VWAP (which resets per trading day inside the strategy module).
 *
 * P&L uses the same option-simulation model as the shared backtestEngine
 * (spotPnlPts × delta − theta − charges) so its numbers are comparable, and it
 * returns the same { summary, trades } shape the backtest HTML renders.
 *
 * ── M6: what this P&L model CANNOT do, and why ───────────────────────────────
 * There is no historical NIFTY option chain available to this system — Fyers
 * history serves the SPOT index only. Every option number below is therefore a
 * model, not a measurement, and is deliberately left coarse rather than dressed
 * up as precision:
 *
 *   • Entry premium is assumed flat at ₹200. Paper buys one strike ITM and the
 *     real premiums observed in live paper ranged ₹51–₹208 — a 4× spread. So a
 *     backtest ₹ figure is NOT comparable to a paper ₹ figure; only the sign,
 *     the trade count and the spot-points column are.
 *   • Delta is a constant 0.55 (BACKTEST_DELTA). Real one-strike-ITM delta is
 *     nearer 0.6 and moves with spot, time and IV. No gamma is modelled.
 *   • Theta is linear (BACKTEST_THETA_DAY / candles-per-day). Real theta
 *     accelerates into expiry and is not linear intraday.
 *   • IV is not modelled at all: no IV crush, no vol expansion on a break.
 *   • The profit lock is a % of the entry premium, so it runs on the simulated
 *     ₹200-seed premium above — an approximation whose error grows as the true
 *     premium departs from ₹200.
 *
 * Fixing any of these requires a historical option-chain data source. Until one
 * exists, treat backtest ₹ P&L as an ordinal signal (better/worse), never as a
 * forecast of live rupees.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const instrumentConfig = require("../config/instrument");
const { getLotQty } = instrumentConfig;
const { getCharges: _getCharges } = require("../utils/charges");
const strategy = require("../strategies/ema9_vwap");
const vixFilter = require("./vixFilter");

function _istDay(s)  { return Math.floor((s + 19800) / 86400); }
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
 * @param {Array}  vixCandles    historical VIX candles for the VIX gate
 * @param {object} [opts]        { isFutures, prefix } — the FUT_EMA9_VWAP twin passes
 *                               { isFutures: true, prefix: "FUT_EMA9VWAP" } to force the
 *                               futures arm and read its own FUT_EMA9VWAP_* keys (VIX mode =
 *                               the prefix lower-cased). Omitted → the original behaviour.
 *                               Another market's run (the /backtest page) adds
 *                               { lotQty, exchange } — its lot and its exchange's charges —
 *                               and { expiryOnly, isExpiryDay(dateStr) } — the pair's trade-days
 *                               switch and that market's expiry calendar, in place of the
 *                               shared TRADE_EXPIRY_DAY_ONLY + NIFTY expiry.
 * @returns {{summary:Object, trades:Array}}
 */
async function runEma9VwapBacktest(candles, capital, onProgress, activeFromTs = 0, vixCandles = [], opts = {}) {
  opts = opts || {};
  const trades   = [];
  let position   = null;
  // Strategy rules + VIX mode for the env prefix (default: EMA9VWAP_ keys, mode "ema9vwap").
  const _strat   = opts.prefix ? strategy.forPrefix(opts.prefix) : strategy;
  const _vixMode = opts.prefix ? String(opts.prefix).toLowerCase() : "ema9vwap";
  const LOT_SIZE = opts.lotQty > 0 ? opts.lotQty
    : (opts.isFutures === true ? getLotQty("NIFTY", "NIFTY_FUTURES") : getLotQty());
  // Another market's exchange (BSE for SENSEX) on every charges call; NIFTY passes none.
  const getCharges = (o) => _getCharges(opts.exchange ? Object.assign({}, o, { exchange: opts.exchange }) : o);

  const isFutures      = typeof opts.isFutures === "boolean" ? opts.isFutures : instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
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

  // NOTE: the entry window is NOT parsed here on purpose. strategy.isEntryWindowOpen()
  // is the single authoritative rule shared with paper/live — duplicating it locally
  // is exactly how the candle-start vs candle-close off-by-one crept in.
  const _tradeGuards   = require("../utils/tradeGuards");

  // ── Guards mirrored from paper ───────────────────────────────────────────────
  // Candle resolution in minutes (from spacing) — drives the cooldown windows.
  const resMins = candles.length >= 2 ? Math.max(1, Math.round((candles[1].time - candles[0].time) / 60)) : 5;
  // VIX gate: paper calls checkLiveVix("STRONG") with the default (EMA_RSI_ST) thresholds;
  // checkBacktestVix self-gates on the EMA9_VWAP VIX config (EMA9VWAP_VIX_ENABLED,
  // blank = inherit the global VIX_FILTER_ENABLED) and fails per VIX_FAIL_MODE —
  // the same resolver paper and live use, so all three surfaces agree.
  const vixLookup = vixFilter.buildVixLookup(vixCandles || []);
  let vixBlocked = 0;

  // ── H4-f: expiry-day-only filter (TRADE_EXPIRY_DAY_ONLY), matching paper's
  //    _expiryDayBlocked. Resolved ONCE per distinct IST date in the range rather
  //    than per candle. Off by default → empty set → no effect.
  // Another market's run hands in its own switch + calendar (opts.isExpiryDay).
  const _pairExpiry = typeof opts.isExpiryDay === "function";
  const expiryOnly = _pairExpiry ? opts.expiryOnly === true
    : (process.env.TRADE_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true";
  const expiryDates = new Set();
  let expiryLookupFailed = false;
  // `total` is declared HERE, above its first use. It used to be declared ~25 lines
  // below while this block already read it, so `TRADE_EXPIRY_DAY_ONLY=true` threw
  // "Cannot access 'total' before initialization" (a const temporal-dead-zone error)
  // and killed the whole run. It never surfaced because the `&&` short-circuits on
  // the default (filter off) and `total` is only reached when the filter is ON.
  const total = candles.length;
  if (expiryOnly && total > 0) {
    const { isExpiryDate } = require("../utils/nseHolidays");
    const _seen = new Set();
    for (const c of candles) {
      const d = new Date((c.time + 19800) * 1000).toISOString().slice(0, 10);
      _seen.add(d);
    }
    for (const d of _seen) {
      try { if (_pairExpiry ? opts.isExpiryDay(d) : await isExpiryDate(d)) expiryDates.add(d); }
      catch (_) { expiryLookupFailed = true; }
    }
    if (expiryLookupFailed) {
      console.warn("[EMA9VWAP-BT] expiry-date lookup partially failed — expiry-only filter may under-report entries.");
    }
  }
  const _istDateStr = (sec) => new Date((sec + 19800) * 1000).toISOString().slice(0, 10);

  let curDay = null;
  // Global wait-after-any-exit cooldown (EXIT_REENTRY_COOLDOWN_CANDLES), unix secs.
  // Paper measures it from the exit's clock time: a tick exit (the profit lock)
  // fires INSIDE the bar (≈ bar open here), a candle-close exit at the bar's CLOSE.
  const _REENTRY_COOLDOWN_SECS = _tradeGuards.reentryCooldownMs(resMins) / 1000;
  let reentryBlockUntilTs = 0;
  const reportEvery = Math.max(1, Math.floor(total / 50));

  // ── Profit-lock price model ─────────────────────────────────────────────────
  // The global profit lock (tradeGuards.checkProfitLock) is the ONLY automatic exit,
  // exactly as in paper. It is applied to the price this engine computes P&L on:
  // the simulated option premium under OPTION_SIM (₹200 seed + spot move × δ − θ),
  // otherwise the traded instrument itself (long-equivalent, so a PE/short gains as
  // spot falls). `_priceAt` and `_spotFor` are inverses of each other.
  const SEED_PREMIUM = 200;
  function _priceBase() { return OPTION_SIM ? SEED_PREMIUM : position.entryPrice; }
  function _priceSlope() { return OPTION_SIM ? DELTA : 1; }
  function _thetaNow() {
    return OPTION_SIM ? (THETA_PER_DAY / CANDLES_PER_DAY) * (position.candlesHeld || 1) : 0;
  }
  function _priceAt(spot) {
    const dir = position.side === "CE" ? 1 : -1;
    const p = _priceBase() + dir * (spot - position.entryPrice) * _priceSlope() - _thetaNow();
    return Math.max(0.05, _q(p, 2));   // checkProfitLock ignores a non-positive price
  }
  function _spotFor(price) {
    const dir = position.side === "CE" ? 1 : -1;
    return position.entryPrice + dir * (price - _priceBase() + _thetaNow()) / _priceSlope();
  }

  // Rolling 200-candle window reused via push/shift (mirrors paper's in-memory cap
  // and the shared backtestEngine's window trick). Replaces a fresh candles.slice()
  // per iteration — that was O(n²) allocation and, combined with the missing
  // event-loop yield below, blocked the SAME process that hosts the live Fyers feed
  // for 10–60s on multi-year runs. getSignal() sees an identical view either way.
  const window = total > 0 ? [candles[0]] : [];

  /**
   * @param {object} candle          the bar the exit fired on
   * @param {string} exitReason
   * @param {number} [exitLevel]     spot price the exit actually happens AT. The
   *   profit lock fires the moment price touches its floor, so it passes that level
   *   (paper sells on the tick that breached it). The session close happens on the
   *   bar's close, so it passes nothing.
   */
  function _closeTrade(candle, exitReason, exitLevel) {
    let exitPrice = Number.isFinite(exitLevel) ? exitLevel : candle.close;
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
      const estEntryPrem   = SEED_PREMIUM;
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
      bestPrice:       position.bestPrice != null ? _q(position.bestPrice, 2) : null,
      peakPrice:       position.peak != null ? _q(position.peak, 2) : null,
      candlesHeld:     position.candlesHeld || 1,
      spotPnlPts,
      pnl:             pnlRupees,
      pnlMode,
      exitReason,
      entryReason:     position.entryReason,
      signalStrength:  position.signalStrength || "STRONG",
    });

    position = null;
  }

  for (let i = 1; i < total; i++) {
    // Yield the event loop every 100 candles so a long backtest doesn't starve
    // the live tick feed / HTTP handlers running in this same process.
    if (i % 100 === 0) await new Promise((r) => setImmediate(r));

    const candle = candles[i];
    const day = _istDay(candle.time);
    if (day !== curDay) {
      curDay = day;
      // Per-session state resets each trading day (paper starts each session fresh).
      reentryBlockUntilTs = 0;
    }
    // Last bar of this day's session in the data → paper's session teardown.
    const isSessionEnd = i === total - 1 || _istDay(candles[i + 1].time) !== day;
    // Paper's profit lock fires inside onTick, which returns from the TICK handler
    // only — the bar still closes and onCandleClose's entry section runs, so a new
    // entry is possible on the same bar. Only the session close blocks the bar.
    let blockEntryThisCandle = false;

    // Extend the rolling window by the current candle; cap at 200 (paper's in-memory
    // cap). window now equals candles[max(0,i-199) .. i] — same view getSignal saw
    // from the old per-iteration slice, without the per-step allocation.
    window.push(candle);
    if (window.length > 200) window.shift();
    const sig = _strat.getSignal(window, { silent: true });

    // ── EXIT: global profit lock (intrabar) ──
    // Path model inside one bar: open → adverse extreme → favourable extreme. The
    // peak only rises at the open and at the favourable extreme, so the lock can
    // arm on an earlier bar and fire on a later give-back, never arm and fire on the
    // same unknown-order high/low pair.
    if (position) {
      position.candlesHeld = (position.candlesHeld || 0) + 1;
      const isCE = position.side === "CE";
      let exitReason = null, exitLevel;

      const pOpen = _priceAt(candle.open);
      if (pOpen > position.peak) position.peak = pOpen;
      // Futures: the common stop in index points (tradeGuards.futuresStopLevel), as
      // paper. The price here IS the futures price, so peak − entry = best move.
      const _fsBest = isFutures ? position.peak - position.entryPrice : 0;
      const _fsLvl  = isFutures ? _tradeGuards.futuresStopLevel(position.side, position.entryPrice, _fsBest) : null;
      const _fsWhy  = () => _tradeGuards.premiumStopSpotReason((_fsLvl - position.entryPrice) * (isCE ? 1 : -1), _fsBest);
      const lockOpen = _tradeGuards.checkProfitLock(_priceBase(), pOpen, position.peak);
      if (lockOpen) {
        exitReason = `${lockOpen} (bar opened through it — filled at the open)`;
        exitLevel  = candle.open;
      } else if (_fsLvl != null && (isCE ? candle.open <= _fsLvl : candle.open >= _fsLvl)) {
        exitReason = `${_fsWhy()} (bar opened through it — filled at the open)`;
        exitLevel  = candle.open;
      } else {
        const pAdv = _priceAt(isCE ? candle.low : candle.high);
        const lockAdv = _tradeGuards.checkProfitLock(_priceBase(), pAdv, position.peak);
        const fsHit = _fsLvl != null && (isCE ? candle.low <= _fsLvl : candle.high >= _fsLvl);
        if (lockAdv) {
          const g = _tradeGuards;
          const floor = g.exitLevelLtp(_priceBase(), position.peak);
          const raw = _spotFor(floor);
          // Never better than the open (the open did not trigger, so the level lies past it).
          exitLevel  = isCE ? Math.min(candle.open, raw) : Math.max(candle.open, raw);
          exitReason = lockAdv;
          // The futures stop, if it sits nearer the open, is touched first.
          if (fsHit && (isCE ? _fsLvl > exitLevel : _fsLvl < exitLevel)) { exitLevel = _fsLvl; exitReason = _fsWhy(); }
        } else if (fsHit) {
          exitLevel  = _fsLvl;
          exitReason = _fsWhy();
        } else {
          const pFav = _priceAt(isCE ? candle.high : candle.low);
          if (pFav > position.peak) position.peak = pFav;
        }
      }
      // Favourable spot extreme — observer-only, carried into the trade record.
      if (isCE) { if (position.bestPrice == null || candle.high > position.bestPrice) position.bestPrice = candle.high; }
      else      { if (position.bestPrice == null || candle.low  < position.bestPrice) position.bestPrice = candle.low; }

      if (exitReason) {
        _closeTrade(candle, exitReason, exitLevel);
        // Wait-after-any-exit cooldown — every exit reason, both sides. A tick
        // exit is measured from inside the bar (≈ its open).
        if (_REENTRY_COOLDOWN_SECS > 0) reentryBlockUntilTs = candle.time + _REENTRY_COOLDOWN_SECS;
      } else if (isSessionEnd) {
        // Session teardown: paper closes anything still open when the engine stops.
        _closeTrade(candle, "EOD session close");
        blockEntryThisCandle = true;
        if (_REENTRY_COOLDOWN_SECS > 0) reentryBlockUntilTs = candle.time + resMins * 60 + _REENTRY_COOLDOWN_SECS;
      }
    }

    // ── ENTRY (candle close, inside the entry window, entry guards) ──
    if (!position && !blockEntryThisCandle && !isSessionEnd && candle.time >= activeFromTs
        && (sig.signal === "BUY_CE" || sig.signal === "BUY_PE")
        && _strat.isEntryWindowOpen(candle.time, resMins)
        && (!expiryOnly || expiryDates.has(_istDateStr(candle.time)))) {
      const side = sig.signal === "BUY_CE" ? "CE" : "PE";
      // Wait-after-any-exit cooldown (mirrored from paper).
      const _reentryBlocked = candle.time < reentryBlockUntilTs;
      if (!_reentryBlocked) {
        // VIX gate — evaluated only when we would otherwise enter, like paper.
        const _vc = vixFilter.checkBacktestVix(vixLookup(candle.time), "STRONG", { mode: _vixMode });
        if (_vc.allowed) {
          let entryPrice = candle.close;
          if (SLIPPAGE_PTS > 0) entryPrice = side === "CE" ? entryPrice + SLIPPAGE_PTS : entryPrice - SLIPPAGE_PTS;
          position = {
            side, entryPrice: _q(entryPrice, 2), entryTime: candle.time,
            candlesHeld: 0, signalStrength: "STRONG", entryReason: sig.reason,
            // Favourable spot extreme (observer-only).
            bestPrice: _q(entryPrice, 2),
          };
          // Peak of the profit-lock price, carried across bars. Starts at entry.
          position.peak = _priceBase();
        } else {
          vixBlocked += 1;
        }
      }
    }

    if (onProgress && i % reportEvery === 0) {
      onProgress({ phase: "Running EMA9+VWAP backtest…", pct: Math.round((i / total) * 100), current: i, total });
    }
  }

  // Defensive: the session-end close above leaves nothing open, but never leave P&L undefined.
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
      strategy:        _strat.NAME,
      description:     _strat.DESCRIPTION,
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
      // Another market's futures run (NIFTY_FUT) books ₹ (index pts × lot − charges).
      ...(opts.lotQty > 0 && isFutures ? { isFutures: true, pnlUnit: "₹" } : {}),
    },
    trades,
  };
}

module.exports = { runEma9VwapBacktest };
